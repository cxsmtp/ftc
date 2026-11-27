// @ts-check
//
// Split from functional-core.api.spec.js in v7.21.37 — it was 115s in one file, and a spec
// file never spans workers, so it bounded the whole suite's wall clock.
//
// Contains: Unauthenticated · Staff (non-admin) · Superadmin-only · Participant timeslot selection · Competition-join event deferral · Admin analytics — /api/admin/analytics/challenges · Detached email fan-out is countable (v7.15.15) · Docs hygiene · Competition-state cache invalidation (v6.3.3) · Scanner protection middleware (v6.3.6) · Group leaderboard visibility gating (v7.11.7) · Event tags (v6.6.0) · bcrypt cross-compat · Mandatory profile fields (v6.18.x) · Nickname auto-generation + ASCII transliteration (v7.4.0) · Participant groups (v6.20) · Self-enrollment link (v6.21.0) · audit v7.7.36 (batch 11) — perf + concurrency LOWs · audit v7.7.37 (batch 12) — correctness LOWs · audit v7.7.27 batch 2 — grace participants count on the board + auto-end · audit v7.7.31 batch 6 — picker cap + register required
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, TEST_DATA_DIR, gradingHashFor, codeLogin } = require("./helpers");

// v7.21.37 — `S` / ensureState / aliceInLive moved to ./seeded-state as a
// FACTORY. Each spec file gets its OWN cache: per-file isolation re-seeds the
// database before every file, so one shared `S` would hand this file ids from
// the previous file's database.
const { makeState } = require("./seeded-state");
const { S, ensureState, aliceInLive } = makeState();

// ═══════════════════════════════════════════════════════════════════════════════
// PARTICIPANT FLOWS
// ═══════════════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════════════════
// UNAUTHENTICATED
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Unauthenticated", () => {
  test("protected endpoints return 401", async () => {
    const { api } = await freshCtx();
    expect((await api.get("/api/me")).status()).toBe(401);
    expect((await api.get("/api/tasks")).status()).toBe(401);
    expect((await api.get("/api/leaderboard")).status()).toBe(401);
    await api.dispose();
  });

  test("admin endpoints return 401 when there is no session at all", async () => {
    // v6.16.24 — requireAdmin distinguishes "session is gone" (401) from
    // "session valid but lacks admin role" (403). Pre-fix returned 403
    // indiscriminately; the SPA's session-expired interceptor (which
    // gates on 401 + "Not authenticated") couldn't recognise expiry on
    // admin-route polls, so admin-pane polls 403'd forever after a
    // session timeout. The participant-trying-admin case is locked
    // separately at functional-security.api.spec.js > v6.16.22.
    const { api } = await freshCtx();
    const r = await api.get("/api/admin/tasks");
    expect(r.status()).toBe(401);
    expect((await r.json()).error).toBe("Not authenticated");
    await api.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// STAFF (NON-ADMIN) BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Staff (non-admin)", () => {
  let _staffTagAdded = false;

  // v7.21.35 — was `test("setup: tag carol as staff")`. A setup step expressed
  // as a TEST only runs when the whole file runs in order, so every test below
  // silently depended on file position: run any one of them alone and carol has
  // no staff tag, so `isStaff` is false and the leaderboard exclusion does not
  // apply. Five tests here failed in isolation for that reason. As a beforeAll
  // it runs for any subset — one test, a `-g` filter, or a future file split.
  test.beforeAll(async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    await api.post(`/api/admin/participants/${S.carol.id}/tags`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { tag: "staff" },
    });
    _staffTagAdded = true;
    await api.dispose();
  });

  // v7.15.32 — RENAMED. This was titled "staff can join any competition without
  // assignment", which it does not test: it never tags carol `staff`, and the
  // seed enrols her in Test Live, so `assigned` is truthy and the staff-bypass
  // branch in routes/participant.js is never reached. The bypass IS covered,
  // once, by timeslots-lifecycle.api.spec.js > "staff user can join any
  // competition without assignment" (which tags her AND uses a competition she
  // is not assigned to AND asserts she is not written to competition_users).
  // Kept as the plain enrolled-participant happy path it actually is; a test
  // whose name overstates its coverage is worse than no test.
  test("an enrolled participant can select their live competition", async () => {
    const { api, csrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    const r = await api.post("/api/select-competition", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { competitionId: S.liveComp.id },
    });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.ok).toBeTruthy();
    await api.dispose();
  });

  // v7.15.32 — RENAMED for the same reason as the test above: carol is enrolled
  // in Test Live here, so this is the enrolled-participant task-list path.
  test("an enrolled participant can view the challenges of their competition", async () => {
    const { api, csrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { competitionId: S.liveComp.id },
    });
    const tasks = await (await api.get("/api/tasks")).json();
    expect(tasks.length).toBeGreaterThan(0);
    await api.dispose();
  });

  test("staff can submit answers", async () => {
    const { api, csrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { competitionId: S.liveComp.id },
    });
    const r = await api.post(`/api/tasks/${S.easy1.id}/submit`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { answer: "answer-easy1" , gradingHash: await gradingHashFor(api, S.easy1.id)},
    });
    expect(r.ok()).toBeTruthy();
    await api.dispose();
  });

  test("staff excluded from participant leaderboard", async () => {
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { competitionId: S.liveComp.id },
    });
    const lb = await (await api.get("/api/leaderboard")).json();
    const carolInBoard = lb.board.find(u => u.nickname === "carol_l");
    expect(carolInBoard).toBeFalsy();
    await api.dispose();
  });

  test("staff not persisted in competition_users for new competitions", async () => {
    await ensureState();
    // Carol (staff) joins upcoming comp — she was NOT assigned to it via admin
    const { api: carolApi, csrf: carolCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    await carolApi.post("/api/select-competition", {
      headers: { "x-csrf-token": carolCsrf, "content-type": "application/json" },
      data: { competitionId: S.upcomingComp.id },
    });
    await carolApi.dispose();
    // Verify she's not in competition_users for that competition
    const { api } = await apiLogin("superadmin");
    const d = await (await api.get(`/api/admin/participants?competitionId=${S.upcomingComp.id}&limit=200`)).json();
    const carol = (d.participants || []).find(p => p.id === S.carol.id);
    expect(carol).toBeFalsy();
    await api.dispose();
  });

  test("staff cannot access admin endpoints without admin role", async () => {
    // v8.1.0 — OWNS ITS PARTICIPANT. This authenticated as the seeded `carol`,
    // whose ROLE is promoted to admin and demoted again FOUR times in this same
    // file (:203, :223, :4902 and their partners). The assertion is "a staff tag
    // is not an admin role", so any window in which she holds one turns it into a
    // 200 — which is exactly how it failed, intermittently, with a security-shaped
    // message. The v7.15.32 rule: never authenticate as a shared seeded fixture in
    // a test that depends on its lifecycle.
    const stamp = `staffonly${Date.now().toString(36)}`;
    const email = `${stamp}@company.example`;
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const reg = await registerPost(sa, "/api/register", {
      headers: saH,
      data: {
        firstName: "Staff", lastName: "Only", nickname: stamp, email,
        company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
        password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
      },
    });
    expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
    const list = await (await sa.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
    const u = (list.participants || []).find(p => p.email === email);
    expect(u, "the participant is findable").toBeTruthy();
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: saH });
    const tag = await sa.post(`/api/admin/participants/${u.id}/tags`, { headers: saH, data: { tag: "staff" } });
    expect(tag.ok(), `staff tag: ${tag.status()} ${await tag.text()}`).toBeTruthy();
    await sa.dispose();

    const { api, body } = await apiLogin(email, PARTICIPANT_PASS);
    // Assert the PRECONDITION, so a fixture that stopped producing a staff user
    // fails as a fixture rather than as a silently-passing 403.
    expect(body.isStaff, "the fixture really is staff").toBeTruthy();
    expect((await api.get("/api/admin/tasks")).status()).toBe(403);
    expect((await api.get("/api/admin/participants")).status()).toBe(403);
    await api.dispose();
  });

  test("staff login returns isStaff flag", async () => {
    const { body } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    expect(body.isStaff).toBeTruthy();
  });

  // afterAll, not a `cleanup:` test — the tag must come off even when a test in
  // this block fails, or the failure cascades into every later block that reads
  // carol (a staff tag removes her from leaderboards). A cleanup TEST also does
  // not run at all under a `-g` filter that excludes it, which is how a stray
  // staff tag leaks into the rest of the file.
  test.afterAll(async () => {
    if (!_staffTagAdded) return;
    const { api, csrf } = await apiLogin("superadmin");
    await api.delete(`/api/admin/participants/${S.carol.id}/tags/staff`, {
      headers: { "x-csrf-token": csrf },
    });
    await api.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// SUPERADMIN-ONLY OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Superadmin-only", () => {
  test("superadmin can edit ended competition", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.put(`/api/admin/competitions/${S.endedComp.id}`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { duration_minutes: 61 },
    });
    expect(r.ok()).toBeTruthy();
    // Restore
    await api.put(`/api/admin/competitions/${S.endedComp.id}`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { duration_minutes: 60 },
    });
    await api.dispose();
  });

  test("superadmin can change user roles", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    // v8.8.19 — the demotion is in a `finally`. Promotion auto-adds the `staff`
    // tag, and a staff carol is SILENTLY SKIPPED by the assign endpoint, so a
    // failure of either assertion below used to leak an admin, staff-tagged
    // carol into every later test in this file.
    try {
      let r = await api.post(`/api/admin/participants/${S.carol.id}/role`, {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { role: "admin" },
      });
      expect(r.ok()).toBeTruthy();
      expect((await r.json()).tags).toContain("staff");
    } finally {
      await api.post(`/api/admin/participants/${S.carol.id}/role`, {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { role: "participant" },
      }).catch(() => {});
      await api.dispose();
    }
  });

  test("superadmin can block and unblock superadmin accounts", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    // v8.8.19 — THE WORST OF THE SIX. Four assertions between a promotion to
    // SUPERADMIN and the demotion, with a block in the middle: a failure of any
    // of them left carol a blocked superadmin for the rest of the file.
    //
    // The unblock reads the row first, because `POST .../block` is a TOGGLE that
    // ignores its body (v8.3.28) — an unconditional "unblock" in a `finally`
    // re-BLOCKS an already-unblocked carol, which is how that lesson was learnt.
    try {
      await api.post(`/api/admin/participants/${S.carol.id}/role`, {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { role: "superadmin" },
      });
      let r = await api.post(`/api/admin/participants/${S.carol.id}/block`, {
        headers: { "x-csrf-token": csrf },
      });
      expect(r.ok()).toBeTruthy();
      expect((await r.json()).blocked).toBe(1);
      r = await api.post(`/api/admin/participants/${S.carol.id}/block`, {
        headers: { "x-csrf-token": csrf },
      });
      expect(r.ok()).toBeTruthy();
      expect((await r.json()).blocked).toBe(0);
    } finally {
      try {
        const list = await (await api.get(`/api/admin/participants?limit=5000`)).json();
        const row = (list.participants || []).find(p => p.id === S.carol.id);
        if (row && row.blocked) {
          await api.post(`/api/admin/participants/${S.carol.id}/block`, { headers: { "x-csrf-token": csrf } });
        }
      } catch (_) {}
      await api.post(`/api/admin/participants/${S.carol.id}/role`, {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { role: "participant" },
      }).catch(() => {});
      await api.dispose();
    }
  });

  test("superadmin can access settings", async () => {
    const { api } = await apiLogin("superadmin");
    const r = await api.get("/api/admin/settings");
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d).toHaveProperty("platform_name");
    await api.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// PARTICIPANT — TIMESLOT SELECTION
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Participant timeslot selection", () => {
  let _compId, _ts1Id, _ts2Id;

  // v7.21.35 — setup-as-a-TEST. Worse here than in the tag blocks: the three
  // tests below read `_compId` / `_ts1Id` / `_ts2Id`, which are undefined unless
  // this ran first, so in isolation they POSTed `timeslotId: undefined`.
  test.beforeAll(async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const now = Date.now();
    let r = await api.post("/api/admin/competitions", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: `TS Select ${now}`, start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 240 },
    });
    _compId = (await r.json()).competition.id;
    r = await api.post(`/api/admin/competitions/${_compId}/timeslots`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: "Slot A", start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 120 },
    });
    _ts1Id = (await r.json()).timeslot.id;
    r = await api.post(`/api/admin/competitions/${_compId}/timeslots`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: "Slot B", start_time: new Date(now + 7200_000).toISOString(), duration_minutes: 120 },
    });
    _ts2Id = (await r.json()).timeslot.id;
    // Assign alice
    await api.post("/api/admin/competitions/assign", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { userIds: [S.alice.id], competitionIds: [_compId] },
    });
    await api.dispose();
  });

  test("selecting competition with timeslots returns needsTimeslotChoice", async () => {
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const r = await api.post("/api/select-competition", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { competitionId: _compId },
    });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.needsTimeslotChoice).toBeTruthy();
    expect(d.timeslots.length).toBe(2);
    await api.dispose();
  });

  test("participant can select an upcoming timeslot", async () => {
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { competitionId: _compId },
    });
    const r = await api.post("/api/select-timeslot", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { timeslotId: _ts1Id },
    });
    expect(r.ok()).toBeTruthy();
    await api.dispose();
  });

  test("participant can switch timeslots while upcoming", async () => {
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { competitionId: _compId },
    });
    const r = await api.post("/api/select-timeslot", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { timeslotId: _ts2Id },
    });
    expect(r.ok()).toBeTruthy();
    await api.dispose();
  });

  test.afterAll(async () => {
    if (!_compId) return;
    const { api, csrf } = await apiLogin("superadmin");
    await api.delete(`/api/admin/competitions/${_compId}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });
});


// v6.10.33: /api/select-competition defers the 3 audit inserts (user +
// competition + timeslot) plus the log-mirror call to setImmediate so
// the synchronous response path holds only the UPDATE + cache
// invalidation. This regression lock confirms the deferred inserts are
// still reaching the DB (just asynchronously) — if the setImmediate
// scheduling breaks or a future edit accidentally drops the recorder
// calls, the polling loop times out at the 2 s cap and this fails.
test.describe("Competition-join event deferral", () => {
  function readUserEvents(userId) {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      return db.prepare(
        "SELECT event_type, details, changed_at FROM user_events WHERE user_id=? ORDER BY changed_at"
      ).all(userId);
    } finally { db.close(); }
  }

  async function awaitUserEvents(userId, expectedTypes, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    let rows;
    while (Date.now() < deadline) {
      rows = readUserEvents(userId);
      const types = new Set(rows.map(r => r.event_type));
      if (expectedTypes.every(t => types.has(t))) return rows;
      await new Promise(r => setTimeout(r, 40));
    }
    return rows;
  }

  test("v6.10.33: select-competition first_joined event is deferred but durable", async () => {
    // Alice is seeded into Test Live and has login_time set via the
    // aliceInLive() helper. The first time any test in this worker calls
    // select-competition, the setImmediate-deferred first_joined INSERT
    // fires. We poll user_events directly; if the deferral ever drops
    // the recorder call (setImmediate never scheduled, or the recorder
    // is conditionally skipped), this times out at 2 s.
    const { api } = await aliceInLive();
    await api.dispose();
    const rows = await awaitUserEvents(S.alice.id, ["first_joined"]);
    const firstJoined = rows.find(r => r.event_type === "first_joined");
    expect(firstJoined, "first_joined event missing — v6.10.33 setImmediate-deferred INSERT didn't complete").toBeTruthy();
    const details = JSON.parse(firstJoined.details);
    expect(details.competition_id).toBe(S.liveComp.id);
    expect(details.competition_name).toBe("Test Live");
  });
});


test.describe("Admin analytics — /api/admin/analytics/challenges", () => {
  // Seeded state at this point includes Alice's seed-time correct + wrong
  // submissions on easy1 / med1 (from helpers.seedTestData) and Bob's
  // events on hard1 / med1 / easy1 from the earlier "Challenge events
  // analytics" describe block above. Tests below assert *relative*
  // properties (totals > 0, filtering excludes things, etc.) rather than
  // exact counts so they survive shifts in the seed.

  async function adminGet(path) {
    const { api } = await apiLogin("superadmin");
    const r = await api.get(path);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    await api.dispose();
    return body;
  }

  test("global scope returns summary + per_challenge with the canonical shape", async () => {
    const body = await adminGet("/api/admin/analytics/challenges");
    expect(body).toHaveProperty("scope");
    expect(body.scope.type).toBe("global");
    expect(body).toHaveProperty("summary");
    for (const k of ["solved","incorrect","hint_revealed","navigated_away","unique_participants","unique_challenges"]) {
      expect(typeof body.summary[k]).toBe("number");
    }
    expect(Array.isArray(body.per_challenge)).toBe(true);
    if (body.per_challenge.length) {
      const r = body.per_challenge[0];
      for (const k of ["task_id","title","difficulty","tags","solved","incorrect","hint_revealed","navigated_away","unique_attempters"]) {
        expect(r).toHaveProperty(k);
      }
    }
  });

  test("competition scope only counts events from that competition", async () => {
    await ensureState();
    const live = await adminGet(`/api/admin/analytics/challenges?scope=competition&competitionId=${S.liveComp.id}`);
    expect(live.scope.type).toBe("competition");
    expect(live.scope.competition_id).toBe(S.liveComp.id);
    // Compare against the global summary — competition-scoped totals must
    // be <= global totals (subset).
    const global = await adminGet("/api/admin/analytics/challenges");
    for (const k of ["solved","incorrect","hint_revealed","navigated_away"]) {
      expect(live.summary[k]).toBeLessThanOrEqual(global.summary[k]);
    }
  });

  test("difficulty filter excludes other difficulties", async () => {
    await ensureState();
    const easyOnly = await adminGet("/api/admin/analytics/challenges?difficulties=easy");
    for (const row of easyOnly.per_challenge) expect(row.difficulty).toBe("easy");
  });

  test("staff exclusion is the default; includeStaff=true admits more events", async () => {
    await ensureState();
    // Tag Alice as staff for this test (then untag at the end).
    const { api: sa, csrf } = await apiLogin("superadmin");
    await sa.post(`/api/admin/participants/${S.alice.id}/tags`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { tag: "staff" },
    });
    try {
      // Default request — Alice's events excluded.
      const noStaff = await adminGet("/api/admin/analytics/challenges");
      const withStaff = await adminGet("/api/admin/analytics/challenges?includeStaff=true");
      // With staff, totals must be >= without staff.
      for (const k of ["solved","incorrect","hint_revealed","navigated_away"]) {
        expect(withStaff.summary[k]).toBeGreaterThanOrEqual(noStaff.summary[k]);
      }
    } finally {
      // v8.3.29 — in a `finally`, AND through a FRESH superadmin login.
      //
      // This cleanup never worked: `adminGet` signs the superadmin in again, and
      // the platform enforces one session per user, so by the time the untag ran
      // `sa`'s cookie was dead and the request came back 401 "Not authenticated"
      // — silently, because nothing checked it. Alice stayed tagged `staff` for
      // the rest of the file, which removes her from every leaderboard and makes
      // the assign endpoint skip her. The v8.3.28 guard is what surfaced it.
      await sa.dispose().catch(() => {});
      const { api: fresh, csrf: freshCsrf } = await apiLogin("superadmin");
      const untag = await fresh.delete(`/api/admin/participants/${S.alice.id}/tags/staff`,
        { headers: { "x-csrf-token": freshCsrf } });
      expect(untag.ok(), `untag alice: ${untag.status()} ${await untag.text()}`).toBeTruthy();
      await fresh.dispose().catch(() => {});
    }
  });

  test("scope=timeslot without timeslotId returns 400", async () => {
    // v7.21.35 — every sibling in this block calls ensureState(); this one did
    // not, so it read S.liveComp only because a sibling had already populated
    // it. Alone it threw "Cannot read properties of undefined (reading 'id')" —
    // a fixture bug wearing a 400-assertion's clothes.
    await ensureState();
    const { api } = await apiLogin("superadmin");
    const r = await api.get(`/api/admin/analytics/challenges?scope=timeslot&competitionId=${S.liveComp.id}`);
    expect(r.status()).toBe(400);
    await api.dispose();
  });

  test("requires admin: anonymous gets 401, regular participant gets 403", async () => {
    // v6.16.24 — requireAdmin distinguishes "session is gone" (401)
    // from "session valid but lacks admin role" (403). Anonymous
    // callers (no session at all) get 401 so the SPA's session-
    // expired interceptor can recognise expiry; an authenticated
    // participant trying an admin route gets 403 (correct
    // authorisation behaviour — not session-expiry).
    const { api: anon } = await freshCtx();
    const r1 = await anon.get("/api/admin/analytics/challenges");
    expect(r1.status()).toBe(401);
    await anon.dispose();
    const { api: alice } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const r2 = await alice.get("/api/admin/analytics/challenges");
    expect(r2.status()).toBe(403);
    await alice.dispose();
  });

  test("invalid scope value returns 400", async () => {
    const { api } = await apiLogin("superadmin");
    const r = await api.get("/api/admin/analytics/challenges?scope=bogus");
    expect(r.status()).toBe(400);
    await api.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// DOCS HYGIENE — platform name parameterisation
// ═══════════════════════════════════════════════════════════════════════════════
// The help-drawer renders role-scoped markdown guides from docs/. The
// platform name is set at runtime via Settings and substituted into the
// markdown via the {{platformName}} template marker. This invariant scan
// guards against any doc silently hardcoding "Hack Arena" (or any other
// pre-rebrand default) — a new guide slipping through without the marker
// would render a stale name in every deployment that uses a different
// platform_name setting.
// ═══════════════════════════════════════════════════════════════════════════════
// ext-audit v7.15.15 — detached bulk email must be drainable at shutdown
// ═══════════════════════════════════════════════════════════════════════════════
// v7.15.14 capped how long bulk assign / approve / invite hold their response
// open and let the remainder run detached. That fixed the client-timeout
// problem and created a new one: a rolling deployment could exit mid-fan-out
// and silently drop mail the API had already reported as sending. The gauge
// below is what the graceful-shutdown drain waits on — the same mechanism the
// audit and CxOne queues already had.
test.describe("Detached email fan-out is countable (v7.15.15)", () => {
  test("the pending gauge rises during a detached fan-out and returns to zero", async () => {
    const { _runBoundedWithDeadline, detachedFanoutPending } = require("../lib/util");
    expect(detachedFanoutPending(), "starts idle").toBe(0);
    const slow = Array.from({ length: 4 }, () => () => new Promise(r => setTimeout(r, 400)));
    const outcome = await _runBoundedWithDeadline(slow, 4, 50);   // deadline fires first
    expect(outcome.deferred, "the deadline detached the remainder").toBeTruthy();
    expect(detachedFanoutPending(),
      "detached work must be COUNTED — otherwise the shutdown drain cannot know to wait for it"
    ).toBeGreaterThan(0);
    await new Promise(r => setTimeout(r, 700));
    expect(detachedFanoutPending(), "and the count returns to zero once it finishes").toBe(0);
  });

  test("the shutdown drain consults the gauge", () => {
    // A source pin of the wiring. The drain IS reachable from a test, but only
    // on a server the spec spawned itself (this file runs on the shared worker
    // server, which must not stop): `POST /api/test/shutdown` runs it on a
    // NODE_ENV=test server, a real SIGTERM on one started without NODE_ENV=test.
    // Two gauges are held by behaviour that way: the detached mail
    // (tests/smtp-pool-drain.spec.js, a SIGTERM while a sign-in mail is held at
    // the relay) and a certificate pass held after its render, before its send
    // (tests/certificate-email-ledger.spec.js). tests/team-report-delivery.spec.js
    // stops a team-report pass while its send is held at the relay, where the
    // detached-mail gauge keeps the drain waiting whatever `teamReportsBusy()`
    // answers; so for that gauge, and for the audit, CxOne, reconciliation and
    // withdrawal waits, this pin is the only lock.
    const fs = require("fs"), pathMod = require("path");
    const src = fs.readFileSync(pathMod.join(__dirname, "..", "server.js"), "utf8");
    const drain = src.slice(src.indexOf("const drainAndClose"), src.indexOf("drainAndClose();", src.indexOf("const drainAndClose")));
    expect(drain, "the shutdown drain must wait on detached email like it waits on audit + cxone")
      .toMatch(/detachedFanoutPending\(\)\s*===\s*0/);
    expect(drain, "and the wait must gate the db.close()").toMatch(/mailDrained/);
    // ext-audit v7.20.9 (F8) — the DETACHED RECONCILIATION passes join the drain.
    // A group bind larger than RECONCILE_MAX_PER_CALL finishes one bounded pass
    // in the request and schedules the rest via setImmediate; nothing here knew
    // about those, so a rolling deployment could close the database mid-drain
    // and leave a competition permanently mis-enrolled.
    expect(drain, "the shutdown drain must wait on detached membership reconciliation too")
      .toMatch(/reconcileDrainPending\(\)\s*===\s*0/);
    expect(drain, "and that wait must gate the db.close() alongside the other three")
      .toMatch(/reconcileDrained/);
    // Sweep #352 — and the two mail WORKERS: a certificate-dispatch pass (a mint,
    // a PDF render, the send) and a team-report pass or Send now. Closed under
    // either, a send is left `sending`, which the next boot marks `unknown` and
    // never retries, so a congratulations mail or a team report is lost.
    const workersGauge = (drain.match(/const\s+certificatesDrained\s*=([^;]*);/) || [])[1] || "";
    expect(workersGauge, "the shutdown drain must wait on a certificate-dispatch pass in flight")
      .toMatch(/!\s*certificateDispatchBusy\(\)/);
    expect(workersGauge, "…and on a team-report pass or Send now")
      .toMatch(/!\s*(?:require\("\.\/lib\/team-reports"\)\.)?teamReportsBusy\(\)/);
    // Every gauge is read into its OWN literal `const xDrained = …` line and
    // ANDed in one condition. Keep them literal: collapsing them into a
    // `[a,b,c,d].every(...)` helper (or a gauge registry) is exactly how a new
    // detached-work source gets added to the registry and silently never waited
    // on — the shape here is what makes an omission visible in review.
    const FLAGS = ["auditDrained", "cxoneDrained", "mailDrained", "reconcileDrained", "withdrawalDrained", "certificatesDrained"];
    for (const flag of FLAGS) {
      expect(drain, `${flag} must stay a literal const in the drain — do not collapse the gauges into a helper`)
        .toMatch(new RegExp("const\\s+" + flag + "\\s*="));
    }
    expect(drain, "and every one must gate the db.close() together")
      .toMatch(new RegExp(FLAGS.join("\\s*&&\\s*")));
    // …and neither worker may START a pass once the drain begins: each is stopped
    // before the HTTP server closes, so the busy flags above can only fall.
    const shutdown = src.slice(src.indexOf("function gracefulShutdown"), src.indexOf("const drainAndClose"));
    expect(shutdown, "the certificate worker is stopped before the drain").toMatch(/\bstopCertificateDispatcher\(\)/);
    expect(shutdown, "the team-report worker is stopped before the drain").toMatch(/\.stopTeamReports\(\)/);
  });

  test("/metrics exposes the gauge", async () => {
    const { api } = await apiLogin("superadmin");
    const body = await (await api.get("/metrics")).text();
    await api.dispose();
    expect(body, "operators need to see sustained detached-mail backlog").toContain("hack_arena_detached_email_pending");
    // ext-audit v7.20.9 (F8) — the reconciliation gauge sits beside it. Assert the
    // full exposition line, not just the substring: a HELP/TYPE comment mentioning
    // the name while the sample line is missing would satisfy a `toContain`.
    expect(body, "operators need to see a large group bind still draining after its request returned")
      .toMatch(/^hack_arena_reconcile_drain_pending \d+$/m);
  });

  test("/metrics reads the two counters an unloggable error leaves behind", async () => {
    // swallowed() counts an error it could not write to the log, and lib/log.js
    // counts a write it could not make; a counter nothing reads is no witness.
    const { api } = await apiLogin("superadmin");
    const body = await (await api.get("/metrics")).text();
    await api.dispose();
    expect(body, "anti-vacuity: the body is the exposition").toContain("# TYPE hack_arena_detached_email_pending gauge");
    expect(body).toMatch(/^# TYPE hack_arena_swallow_unrecorded_total counter$/m);
    expect(body, "the sample line carries an integer").toMatch(/^hack_arena_swallow_unrecorded_total \d+$/m);
    expect(body).toMatch(/^# TYPE hack_arena_log_write_failures_total counter$/m);
    expect(body, "the sample line carries an integer").toMatch(/^hack_arena_log_write_failures_total \d+$/m);
  });

  // ...and the counter sees the writes that fail AFTER the call returns: a log
  // stream writes asynchronously, so a failed line fails on the stream, not in
  // the try around the call. A line takes one of two paths, and each is failed
  // its own way: (1) while its file is still opening, the file a link to
  // /dev/full (it opens, and every write fails with ENOSPC); (2) once the file
  // is open, its descriptor closed behind the stream's back (EBADF), as a
  // failing disk leaves an open file. Each beside a writable file's CONTROL.
  test("lib/log.js counts every line its log file could not take, opening or open (CONTROL: a writable file counts none)", () => {
    const fs = require("fs"), os = require("os"), path = require("path");
    const { spawnSync } = require("child_process");
    test.skip(!fs.existsSync("/dev/full") || !fs.existsSync("/proc/self/fd"), "no /dev/full or /proc on this machine to fail the writes");
    const ROOT = path.join(__dirname, "..");
    const LOG = JSON.stringify(path.join(ROOT, "lib", "log"));
    const report = `process.stdout.write("\\n" + JSON.stringify({ failures: logWriteFailureCount() }) + "\\n"); process.exit(0);`;
    // (1) three lines while the file opens, three more after it failed.
    const opening = `const { log, logWriteFailureCount } = require(${LOG});
      for (let i = 0; i < 3; i++) log.warn("logfail-probe", "opening " + i);
      setTimeout(() => {
        for (let i = 0; i < 3; i++) log.warn("logfail-probe", "after " + i);
        setTimeout(() => { ${report} }, 400);
      }, 400);`;
    // (2) one line opens the file; once open, its descriptor is closed (when
    // asked) and one more line is written on the open stream.
    const open = (close) => `const fs = require("fs"); const { log, logWriteFailureCount } = require(${LOG});
      log.warn("logfail-probe", "first");
      setTimeout(() => {
        if (${close}) for (const fd of fs.readdirSync("/proc/self/fd")) {
          try { if (/[\\/]app-[0-9-]+\\.jsonl$/.test(fs.readlinkSync("/proc/self/fd/" + fd))) fs.closeSync(Number(fd)); } catch (_) {}
        }
        log.warn("logfail-probe", "second");
        setTimeout(() => { ${report} }, 400);
      }, 400);`;
    const run = (script, full) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logfail-"));
      try {
        const logDir = path.join(dir, "logs");
        fs.mkdirSync(logDir);
        // Today's and tomorrow's file (UTC), so a run across midnight still fails.
        if (full) for (const ms of [0, 86_400_000]) fs.symlinkSync("/dev/full", path.join(logDir, `app-${new Date(Date.now() + ms).toISOString().slice(0, 10)}.jsonl`));
        const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "", BASE_URL: "http://localhost",
            DATA_DIR: dir, UPLOADS_DIR: path.join(dir, "uploads"), LOG_DIR: logDir } });
        const last = String(r.stdout || "").trim().split("\n").pop();
        expect(last, `the probe reported: ${r.stderr}`).toMatch(/^\{"failures":\d+\}$/);
        return JSON.parse(last).failures;
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    };
    expect(run(opening, false), "CONTROL: a writable log file counts no failure").toBe(0);
    expect(run(opening, true), "each of the six lines the full disk refused is counted").toBeGreaterThanOrEqual(6);
    expect(run(open(false), false), "CONTROL: an open file kept open counts no failure").toBe(0);
    expect(run(open(true), false), "a line the open file could not take is counted").toBeGreaterThanOrEqual(1);
  });
});


// Shared normaliser for the mechanical source scanners below (v7.20.9). Blanks
// string / template / comment CONTENT while keeping newlines, so line numbers in
// a failure message still point at the real line.
//
// It is a state machine rather than a pair of regexes ON PURPOSE, and that is
// not a style preference: a `/\/\*[\s\S]*?\*\//g` block-strip mispairs against
// the `/*` and `*/` sequences that appear inside server.js's own CSS-minifier
// regex literals and silently blanks whole regions of the file. A scanner
// written that way passed against a deliberately re-broken submit path while
// verifying this release — the assertion was vacuous and the mutation caught it.
// Every scanner using this must still carry a POSITIVE control naming a string
// it expects to survive, or a future stripping bug reads as "clean".

test.describe("Docs hygiene", () => {
  // v7.21.37 — moved INSIDE this describe (its only user) so it travels with
  // the block when the file is split, rather than being left between blocks.
  const _stripJsForScan = (src) => {
    let out = "", i = 0; const n = src.length; let st = "code";
    while (i < n) {
      const c = src[i], c2 = src[i + 1];
      if (st === "code") {
        if (c === "/" && c2 === "/") { st = "line"; i += 2; }
        else if (c === "/" && c2 === "*") { st = "block"; i += 2; }
        else if (c === "'") { st = "sq"; out += " "; i++; }
        else if (c === '"') { st = "dq"; out += " "; i++; }
        else if (c === "`") { st = "tpl"; out += " "; i++; }
        else { out += c; i++; }
      } else if (st === "line") { if (c === "\n") { st = "code"; out += "\n"; } i++; }
      else if (st === "block") { if (c === "*" && c2 === "/") { st = "code"; i += 2; } else { if (c === "\n") out += "\n"; i++; } }
      else if (st === "sq") { if (c === "\\") i += 2; else if (c === "'") { st = "code"; i++; } else i++; }
      else if (st === "dq") { if (c === "\\") i += 2; else if (c === '"') { st = "code"; i++; } else i++; }
      else if (st === "tpl") { if (c === "\\") i += 2; else if (c === "`") { st = "code"; i++; } else { if (c === "\n") out += "\n"; i++; } }
    }
    return out;
  };

  // NO EMPTY CATCH BLOCK OR EMPTY `.catch` HANDLER in server code. A deliberately
  // ignored error goes through lib/best-effort.js `swallowed(where, err)`, which
  // logs it and never throws, so the control flow an empty catch gave is kept
  // while the error stops vanishing. The promise form is the same rule: a
  // fire-and-forget reconcile or mail ending `.catch(() => {})` lost every throw
  // inside it with no trace. lib/log.js counts its own failures instead
  // (recursion), and lib/best-effort.js is the one file whose inner guard is not
  // `swallowed`.
  test("no empty catch block or empty .catch handler in server.js, db.js, lib/ or routes/", () => {
    const fs = require("fs");
    const path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const ROOT = path.join(__dirname, "..");
    const EMPTY = /catch\s*(\([^)]*\))?\s*\{\s*\}/g;
    // The promise form: an arrow (bare or parenthesised parameter, async or not)
    // or a function expression whose body is empty.
    const EMPTY_HANDLER = /\.catch\(\s*(?:async\s*)?(?:\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>|function\s*[\w$]*\s*\([^)]*\))\s*\{\s*\}\s*\)/g;
    const findEmpty = (src) => {
      const s = stripJsComments(src);
      // Keyed by where the `catch` word sits: `.catch(function () {})` matches
      // both patterns and is one site.
      const at = new Set();
      for (const re of [EMPTY, EMPTY_HANDLER]) {
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(s))) at.add(m.index + (s[m.index] === "." ? 1 : 0));
      }
      return [...at].sort((a, b) => a - b).map(i => s.slice(0, i).split("\n").length);
    };
    // Anti-vacuity: the detector must see a planted empty catch, a bare one and a
    // comment-only one, and must not flag a catch that does something.
    expect(findEmpty("try { a(); } catch (_) {}\n").length).toBe(1);
    expect(findEmpty("try{}catch{}").length).toBe(1);
    expect(findEmpty("try { a(); } catch (e) { /* ignored */ }").length).toBe(1);
    expect(findEmpty("try { a(); } catch (e) { swallowed(\"x\", e); }").length).toBe(0);
    // …and every shape of an empty promise handler, but not one that hands the
    // error on.
    expect(findEmpty("p.catch(() => {});").length).toBe(1);
    expect(findEmpty("p.catch(()=>{})").length).toBe(1);
    expect(findEmpty("p.catch(_e => {  });").length).toBe(1);
    expect(findEmpty("p.catch(async (e) => { /* ignored */ });").length).toBe(1);
    expect(findEmpty("p.catch(function () {});").length).toBe(1);
    expect(findEmpty("p.catch((e) => swallowed(\"x\", e));").length).toBe(0);
    expect(findEmpty("p.catch((e) => { swallowed(\"x\", e); });").length).toBe(0);
    const files = ["server.js", "db.js"];
    for (const dir of ["lib", "routes"]) {
      for (const f of fs.readdirSync(path.join(ROOT, dir))) if (f.endsWith(".js")) files.push(dir + "/" + f);
    }
    expect(files.length).toBeGreaterThan(40);
    let catches = 0;
    const offenders = [];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      catches += (stripJsComments(src).match(/\bcatch\b/g) || []).length;
      for (const line of findEmpty(src)) offenders.push(rel + ":" + line);
    }
    // Floor: the tree has hundreds of catch blocks; a scan reading nothing is not a pass.
    expect(catches).toBeGreaterThan(200);
    expect(offenders, "empty catch blocks or .catch handlers (use swallowed(where, err) from lib/best-effort.js)").toEqual([]);
  });

  // AN ID LIST IS ONE BOUND JSON PARAMETER, never one placeholder per item.
  // db.js memoises `db.prepare` by SQL text (cap 2000), so `IN (?,?,…)` built
  // from a list compiles a new statement for every list length and floods the
  // memo; `IN (SELECT value FROM json_each(?))` bound to `JSON.stringify(list)`
  // keeps the text constant (EXPLAIN QUERY PLAN: the same index search either
  // way). A list fixed at module load gives constant text too and is listed
  // below with its reason; any other placeholder list fails.
  test("no SQL placeholder list built from a list in server.js, db.js, lib/ or routes/", () => {
    const fs = require("fs");
    const path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const ROOT = path.join(__dirname, "..");
    const Q = "[\"'`]";
    // Each idiom that spells a "?" per item; `name` is the list expression it
    // was built from, where the idiom has one.
    const IDIOMS = [
      { idiom: "arrow", re: new RegExp(`(?:([\\w$.\\]\\[]+)\\s*\\.\\s*(?:map|flatMap)\\s*\\(\\s*)?(?:\\([^()]*\\)|[\\w$]+)\\s*=>\\s*(${Q})\\?\\2`, "g") },
      { idiom: "fill", re: new RegExp(`\\.fill\\(\\s*(${Q})\\?\\1\\s*\\)`, "g") },
      { idiom: "push", re: new RegExp(`\\.push\\(\\s*(${Q})\\?\\1\\s*\\)`, "g") },
      { idiom: "return", re: new RegExp(`\\breturn\\s+(${Q})\\?\\1`, "g") },
      { idiom: "repeat", re: new RegExp(`(${Q})[\\s,]*\\?[\\s,]*\\1\\s*\\.repeat\\(`, "g") },
      { idiom: "piece", re: new RegExp(`(${Q})(?:\\s*,\\s*\\?|\\?\\s*,)\\s*\\1`, "g") },
    ];
    const findLists = (src) => {
      const s = stripJsComments(src);
      const hits = [];
      for (const { idiom, re } of IDIOMS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(s))) {
          const name = idiom === "arrow" && m[1] ? m[1] : null;
          // The stripper drops comment lines, so the line is read back from the
          // source: the same occurrence of the matched text, counted from the top.
          const nth = s.slice(0, m.index).split(m[0]).length - 1;
          let at = -1;
          for (let k = 0; k <= nth; k++) { at = src.indexOf(m[0], at + 1); if (at < 0) break; }
          hits.push({ idiom, expr: name || m[0], line: at < 0 ? "?" : src.slice(0, at).split("\n").length });
        }
      }
      return hits;
    };
    // Anti-vacuity: every idiom is seen in a planted line, and the constant
    // form, a ternary and an ordinary VALUES list are not.
    const planted = {
      arrow: 'const ph = ids.map(() => "?").join(",");',
      arrowNamed: "const ph = Array.from(ids, (_x) => '?').join(',');",
      fill: 'const ph = new Array(ids.length).fill("?").join(",");',
      push: 'for (const id of ids) marks.push("?");',
      return: 'function mark() { return "?"; }',
      repeat: 'const ph = "?,".repeat(ids.length - 1) + "?";',
      piece: "let ph = ''; for (const id of ids) ph += '?,';",
      pieceTemplate: "let ph = ''; for (const id of ids) ph += `?,`;",
    };
    for (const [k, line] of Object.entries(planted)) expect(findLists(line).length, `planted ${k}: ${line}`).toBeGreaterThan(0);
    expect(findLists(planted.arrow)[0].expr).toBe("ids");
    expect(findLists([
      'db.prepare(`SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids));',
      'const v = x === "," ? a : "?";',
      'db.prepare("INSERT INTO t (a, b) VALUES (?, ?)").run(a, b);',
      "const label = name || '?';",
    ].join("\n"))).toEqual([]);
    // Lists fixed at module load: the SQL text is the same on every call.
    const EXEMPT = {
      "routes/audit.js::LOG_EVENT_RAW_ONLY_TYPES":
        "a frozen module-level list of event types, so the statement text never changes between calls",
      "lib/event-admin.js::_USER_EVENT_ID_KEYS":
        "a frozen module-level list of detail keys, so the statement text never changes between calls",
    };
    for (const [k, why] of Object.entries(EXEMPT)) expect(why.length, `reason for ${k}`).toBeGreaterThanOrEqual(40);
    const files = ["server.js", "db.js"];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir + "/" + e.name;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith(".js")) files.push(rel);
      }
    };
    walk("lib");
    walk("routes");
    expect(files.length).toBeGreaterThan(60);
    const seen = new Set();
    const offenders = [];
    let constantForm = 0;
    for (const rel of files) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      constantForm += (stripJsComments(src).match(/json_each\(\?\)/g) || []).length;
      for (const h of findLists(src)) {
        const key = `${rel}::${h.expr}`;
        if (EXEMPT[key]) { seen.add(key); continue; }
        offenders.push(`${rel}:${h.line} (${h.idiom}) ${h.expr}`);
      }
    }
    // Both ways: an exemption the source no longer holds is stale.
    const stale = Object.keys(EXEMPT).filter(k => !seen.has(k));
    expect(stale, "exempt placeholder lists no longer in the source").toEqual([]);
    // Floor: the converted form is everywhere; a scan reading nothing is not a pass.
    expect(constantForm).toBeGreaterThan(80);
    expect(offenders, "placeholder lists built from a list: bind JSON.stringify(list) to IN (SELECT value FROM json_each(?))").toEqual([]);
  });

  // AN ADDRESS OR NICKNAME LOOKUP IS AN INDEX SEARCH. `LOWER(col) = ?` / `IN (…)`
  // can use no index (the NOCASE indexes hold the column, not LOWER of it), and
  // OR-ed `col = ? COLLATE NOCASE` arms read as a scan of the whole table: the
  // planner will not union them. The forms that search are `col = ? COLLATE
  // NOCASE`, `col COLLATE NOCASE IN (SELECT value FROM json_each(?))` (the
  // collation on the column) and a UNION of indexed arms. LIKE is the search
  // idiom and is never flagged, nor is a projection, ORDER BY or GROUP BY; `<>`
  // and `!=` are left out (no index serves them, and they only ever sit beside an
  // indexed term). Its limits are in CLAUDE.md *Stated gaps*.
  test("no email or nickname lookup compares LOWER(column) or ORs NOCASE address arms in server.js, lib/ or routes/", () => {
    const fs = require("fs");
    const path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const ROOT = path.join(__dirname, "..");
    const COL = String.raw`(?:[A-Za-z_]\w*\.)?(?:email|secondary_email|pending_email|nickname)`;
    const LOWER_COL = String.raw`\bLOWER\s*\(\s*(?:(?:TRIM|COALESCE)\s*\(\s*)?${COL}\b[^()]*(?:\)\s*)?\)`;
    const RULES = [
      ["lower-compared", new RegExp(String.raw`${LOWER_COL}\s*(?:==?|\bIN\b)`, "gi")],
      ["compared-to-lower", new RegExp(String.raw`(?:[^<>!=]=|\bIN\s*\()\s*${LOWER_COL}`, "gi")],
      ["nocase-or", new RegExp(String.raw`\b${COL}\s*=\s*\?\s*COLLATE\s+NOCASE(?:\s*\)\s*|\s+)OR\b`, "gi")],
      ["or-nocase", new RegExp(String.raw`\bOR(?:\s+|\s*\(\s*)${COL}\s*=\s*\?\s*COLLATE\s+NOCASE`, "gi")],
      // A column held in a template (`LOWER(${def.actor}) = ?`) needs the same decision.
      ["lower-interpolated", new RegExp(String.raw`\bLOWER\s*\(\s*\$\{[^}]+\}\s*\)\s*(?:==?|\bIN\b)`, "gi")],
    ];
    // The line of the nth uncommented occurrence of `text` in the source: an
    // occurrence is in a comment when a marker put in front of it does not
    // survive stripping (an earlier comment can quote the forbidden form).
    const MARK = "\u0001ADDRSCAN\u0001";
    const lineOf = (src, text, nth) => {
      let seen = -1;
      for (let at = src.indexOf(text); at >= 0; at = src.indexOf(text, at + 1)) {
        if (!stripJsComments(src.slice(0, at) + MARK + src.slice(at)).includes(MARK)) continue;
        if (++seen === nth) return src.slice(0, at).split("\n").length;
      }
      return "?";
    };
    const find = (src) => {
      const s = stripJsComments(src);
      const hits = [];
      for (const [rule, re] of RULES) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(s))) {
          hits.push({ rule, text: m[0].replace(/\s+/g, " "), line: lineOf(src, m[0], s.slice(0, m.index).split(m[0]).length - 1) });
        }
      }
      return hits;
    };
    // Anti-vacuity: each forbidden shape is seen in a planted line ...
    const positives = [
      "SELECT id FROM users WHERE LOWER(email)=LOWER(?)",
      "WHERE LOWER(u.secondary_email) IN (SELECT value FROM json_each(?))",
      "where lower( pending_email ) = ?",
      "WHERE ? = LOWER(email)",
      "SELECT n FROM users WHERE LOWER(nickname) IN (SELECT value FROM json_each(?))",
      "WHERE LOWER(TRIM(email)) = ?",
      "WHERE email=? COLLATE NOCASE OR secondary_email=? COLLATE NOCASE",
      "WHERE user_id=? OR email = ? COLLATE NOCASE",
      "WHERE ? IN (LOWER(email), LOWER(secondary_email))",
      "WHERE (email=? COLLATE NOCASE) OR (secondary_email=? COLLATE NOCASE)",
      "where += ` AND LOWER(${def.actor}) = ?`;",
    ];
    for (const line of positives) expect(find(line).length, `planted: ${line}`).toBeGreaterThan(0);
    expect(find("x\n// LOWER(email)=?\nconst q = \"WHERE LOWER(email)=?\";")[0].line, "the line is the code's, not an earlier comment's").toBe(3);
    // ... and none of the searching or legitimate forms is.
    const negatives = [
      "WHERE LOWER(u.email) LIKE ? ESCAPE '\\\\'",
      "OR LOWER(COALESCE(secondary_email,'')) LIKE ? ESCAPE '\\\\'",
      "SELECT LOWER(email) AS e FROM users WHERE email COLLATE NOCASE IN (SELECT value FROM json_each(?))",
      "SELECT id FROM users WHERE email=? COLLATE NOCASE LIMIT 1",
      "WHERE pending_email=? COLLATE NOCASE AND pending_email_code_at > ?",
      "ORDER BY LOWER(email)",
      "GROUP BY LOWER(email) HAVING n>1",
      "WHERE LOWER(TRIM(last_name)) = ?",
      "// WHERE LOWER(email)=LOWER(?) OR LOWER(secondary_email)=LOWER(?)",
      "/* email=? COLLATE NOCASE OR secondary_email=? COLLATE NOCASE */",
      "if (a.email.toLowerCase() === email) return a;",
      "SELECT id FROM users WHERE email = ? COLLATE NOCASE UNION SELECT id FROM users WHERE secondary_email = ? COLLATE NOCASE UNION SELECT id FROM users WHERE pending_email = ? COLLATE NOCASE",
      "const arms = cols.map(x => `LOWER(COALESCE(${x}, '')) LIKE ? ESCAPE`);",
    ];
    for (const line of negatives) expect(find(line), `planted negative: ${line}`).toEqual([]);
    const files = ["server.js"];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir + "/" + e.name;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith(".js")) files.push(rel);
      }
    };
    walk("lib");
    walk("routes");
    expect(files.length).toBeGreaterThan(60);
    const INDEXED = new RegExp(String.raw`\b${COL}\s*(?:=\s*\?|COLLATE\s+NOCASE\s+IN\b)`, "gi");
    const LIKE = new RegExp(String.raw`\bLOWER\s*\(\s*(?:COALESCE\s*\(\s*)?(?:${COL}\b|\$\{[^}]+\})[^()]*(?:\)\s*)?\)\s*LIKE\b`, "gi");
    let indexed = 0, likes = 0;
    const offenders = [];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      const s = stripJsComments(src);
      indexed += (s.match(INDEXED) || []).length;
      likes += (s.match(LIKE) || []).length;
      for (const h of find(src)) offenders.push(`${rel}:${h.line} (${h.rule}) ${h.text}`);
    }
    // Floors: the searching form and the LIKE idiom are read; a scan reading nothing is not a pass.
    expect(indexed, "indexed address and nickname lookups read").toBeGreaterThanOrEqual(40);
    expect(likes, "LIKE searches read and left alone").toBeGreaterThanOrEqual(10);
    expect(offenders, "address or nickname lookups no index serves: `col = ? COLLATE NOCASE`, `col COLLATE NOCASE IN (SELECT value FROM json_each(?))`, or a UNION of indexed arms").toEqual([]);
  });

  // ONE ZONE FORMATTER PER ZONE (lib/time.js `zoneFormatter`). Building an
  // Intl.DateTimeFormat costs about 55 µs; the participant import validates a
  // zone once per row and bulk mail formats a date once per recipient, so both
  // share one memoised formatter per zone. The witness counts what Intl really
  // built, through a counting subclass installed in this process, never a
  // counter the module keeps itself (a misplaced one would still pass). The
  // import loop is inline in server.js, so the seam is the shared helper; the
  // route's behaviour stays held by functional-security-b (invalid_timezones_dropped).
  test.describe("one zone formatter per zone (lib/time zoneFormatter)", () => {
    const path = require("path");
    const TIME = path.join(__dirname, "..", "lib", "time.js");
    const UTIL = path.join(__dirname, "..", "lib", "util.js");
    const BE = path.join(__dirname, "..", "lib", "best-effort.js");
    const purge = () => { delete require.cache[TIME]; delete require.cache[UTIL]; };
    // Fresh copies of both modules, so each arm starts with an empty memo; with
    // `onSwallow`, the copies take a recording `swallowed` (they bind it at load).
    const fresh = (onSwallow) => {
      purge();
      const be = require(BE), orig = be.swallowed;
      if (onSwallow) be.swallowed = (where, e) => { onSwallow(where, e); return orig(where, e); };
      try { const util = require(UTIL); return { util, time: require(TIME) }; } finally { be.swallowed = orig; }
    };
    // Installs a counting subclass for the length of `fn`, whose `throwFirst`
    // (optional) is thrown by the first construction only. Every answer is
    // collected inside the window and asserted after the global is restored.
    const counted = (fn, throwFirst) => {
      const Orig = Intl.DateTimeFormat;
      const box = { n: 0 };
      Intl.DateTimeFormat = class extends Orig {
        constructor(...a) { box.n++; if (throwFirst && box.n === 1) throw throwFirst; super(...a); }
      };
      try { return fn(box); } finally { Intl.DateTimeFormat = Orig; }
    };
    const D = new Date("2026-04-01T08:00:00Z");
    const ZONES = ["Europe/London", "Asia/Tokyo", "UTC"];

    test("5000 validations over 3 zones and one refused zone construct 4 formatters, and formatEmailDate reuses them", () => {
      try {
        const { util, time } = fresh();
        const got = counted((box) => {
          const answers = new Map();
          for (let i = 0; i < 5000; i++) {
            const z = i % 100 === 3 ? "Not/AZone" : ZONES[i % 3];
            const a = util.isValidTimezone(z);
            if (answers.has(z) && answers.get(z) !== a) answers.set(z, "UNSTABLE"); else answers.set(z, a);
          }
          const afterValidate = box.n;
          let mail = new Set();
          for (let i = 0; i < 300; i++) mail.add(time.formatEmailDate(D, "Europe/London"));
          const afterMail = box.n;
          // Anti-vacuity: the wrapper is live — a direct construction counts.
          new Intl.DateTimeFormat("en", { timeZone: "Asia/Tokyo" });
          return { answers: Object.fromEntries(answers), afterValidate, afterMail, probe: box.n - afterMail, mail: [...mail] };
        });
        expect(got.probe, "the counting wrapper sees a construction").toBe(1);
        expect(got.afterValidate, "one formatter per distinct zone, the refused one included").toBe(4);
        expect(got.afterMail, "formatEmailDate reuses the formatter validation built").toBe(4);
        expect(got.answers).toEqual({ "Europe/London": true, "Asia/Tokyo": true, UTC: true, "Not/AZone": false });
        expect(got.mail).toEqual(["01 Apr 2026 09:00:00 (Europe/London)"]);
      } finally { purge(); }
    });

    test("the memoised answer equals Intl's own, asked twice, for every zone and the hard cases", () => {
      try {
        const { util } = fresh();
        const ref = (v) => {
          if (typeof v !== "string" || !v.trim()) return false;
          try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch (_) { return false; }
        };
        // Order arm first: the exact string is the key, so a padded form stays
        // refused after the bare zone is remembered (Intl refuses the padding).
        expect(util.isValidTimezone("Europe/London")).toBe(true);
        expect(util.isValidTimezone(" Europe/London"), "a padded zone is refused").toBe(false);
        expect(util.isValidTimezone("Europe/London "), "a padded zone is refused").toBe(false);
        const corpus = [...Intl.supportedValuesOf("timeZone"), "UTC", "Etc/UTC", "US/Eastern", "Asia/Calcutta",
          "+01:00", "GMT+1", "Not/AZone", "", "   ", 5, null, {}, "x".repeat(10000)];
        expect(corpus.length, "anti-vacuity: the corpus").toBeGreaterThan(400);
        const refs = corpus.map(ref);
        expect(refs.includes(true) && refs.includes(false), "anti-vacuity: both answers occur").toBe(true);
        const differ = [];
        corpus.forEach((v, i) => {
          const a = util.isValidTimezone(v), b = util.isValidTimezone(v);
          if (a !== refs[i] || b !== refs[i]) differ.push(`${String(v).slice(0, 40)}: ${a}/${b} vs ${refs[i]}`);
        });
        expect(differ).toEqual([]);
        expect(util.isValidTimezone("UTC"), "UTC (which supportedValuesOf omits) is valid").toBe(true);
        // The memo's own guard: a non-string never reaches Intl, even one whose
        // text would name a zone.
        const { time } = fresh();
        expect([time.zoneFormatter({ toString: () => "UTC" }), time.zoneFormatter(5), time.zoneFormatter("")]).toEqual([null, null, null]);
        expect(time.zoneFormatter("UTC"), "CONTROL — the same zone as a string").not.toBeNull();
      } finally { purge(); }
    });

    test("bounded at ZONE_MEMO_MAX, never stores a long key, never remembers a failure that is not about the zone", () => {
      try {
        // (a) A flood of refused zones: the memo stays at the cap, evicting the OLDEST.
        let { util, time } = fresh();
        const MAX = time.ZONE_MEMO_MAX;
        expect(MAX).toBe(1024);
        for (let i = 0; i < MAX + 500; i++) util.isValidTimezone("No/Zone" + i);
        const floodSize = time._zoneMemoSize();
        const fifo = counted((box) => {
          util.isValidTimezone("No/Zone" + (MAX + 499));
          const newest = box.n;
          util.isValidTimezone("No/Zone0");
          return { newest, oldest: box.n - newest };
        });
        expect(floodSize).toBe(MAX);
        expect(fifo, "the newest key is kept, the oldest was evicted").toEqual({ newest: 0, oldest: 1 });
        // …and a fill with VALID zones (offset forms are unbounded in number) too.
        ({ util, time } = fresh());
        const offsets = [];
        for (let i = 0; i < MAX + 10; i++) offsets.push(`+${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`);
        const valid = offsets.map((z) => util.isValidTimezone(z));
        expect(valid.every(Boolean), "PRECONDITION: every +HH:MM offset is a zone Intl accepts").toBe(true);
        expect(time._zoneMemoSize()).toBe(MAX);
        // (b) A long key is answered but never kept.
        ({ util, time } = fresh());
        expect(util.isValidTimezone("Z/".repeat(40))).toBe(false);
        expect(util.isValidTimezone("x".repeat(10000))).toBe(false);
        expect(time._zoneMemoSize()).toBe(0);
        // (c) A failure that is not about the zone is retried; one that is, is remembered.
        ({ util, time } = fresh());
        const c = counted((box) => {
          const first = util.isValidTimezone("Europe/Paris");
          const second = util.isValidTimezone("Europe/Paris");
          const before = box.n;
          const bad1 = util.isValidTimezone("Not/AZone"), bad2 = util.isValidTimezone("Not/AZone");
          return { first, second, bad1, bad2, refusedBuilds: box.n - before };
        }, new TypeError("boom"));
        expect(c).toEqual({ first: false, second: true, bad1: false, bad2: false, refusedBuilds: 1 });
        // (d) The trace of a refused zone (bulk-seed stores zones unvalidated) is
        // written when the refusal is built: once per remembered zone, and per call
        // for a key too long to keep; a non-zone failure is traced under its own name.
        const seen = [];
        ({ util, time } = fresh((where) => seen.push(where)));
        for (let i = 0; i < 3; i++) util.isValidTimezone("Not/AZone");
        for (let i = 0; i < 2; i++) util.isValidTimezone("Z/".repeat(40));
        util.isValidTimezone("Europe/Rome");
        counted(() => util.isValidTimezone("Europe/Oslo"), new TypeError("boom"));
        time.formatEmailDate(new Date(NaN), "Europe/Rome");
        expect(seen).toEqual(["time:zone-refused", "time:zone-refused", "time:zone-refused", "time:zone-formatter", "time:email-date-tz"]);
      } finally { purge(); }
    });

    test("formatEmailDate output is unchanged", () => {
      try {
        const { time } = fresh();
        const cases = [
          [D, "Europe/London", "01 Apr 2026 09:00:00 (Europe/London)"],
          [D, "Asia/Tokyo", "01 Apr 2026 17:00:00 (Asia/Tokyo)"],
          [D, "US/Eastern", "01 Apr 2026 04:00:00 (US/Eastern)"], // the stored name, not the resolved one
          [D, "Not/AZone", "01 Apr 2026 08:00:00 UTC"],
          [D, null, "01 Apr 2026 08:00:00 UTC"],
          [new Date(NaN), "Europe/London", "NaN undefined NaN NaN:NaN:NaN UTC"],
        ];
        // Twice each: the second answer comes from the memo.
        for (let k = 0; k < 2; k++) for (const [d, tz, want] of cases) expect(time.formatEmailDate(d, tz), `${tz} pass ${k}`).toBe(want);
      } finally { purge(); }
    });

    test("server code builds a date formatter only in lib/time.js", () => {
      const fs = require("fs");
      const { stripJsComments } = require("./doc-registry");
      const ROOT = path.join(__dirname, "..");
      const RE = new RegExp("\\bIntl\\s*\\.\\s*Date" + "TimeFormat\\b|\\.toLocale(?:Date|Time)?" + "String\\s*\\(", "g");
      const hits = (src) => (stripJsComments(src).match(RE) || []).length;
      // Planted controls: each construction is seen, and not inside a comment.
      expect(hits('const f = new Intl.DateTimeFormat("en",{timeZone:z});')).toBe(1);
      expect(hits('const s = d.toLocaleString("en",{timeZone:z});')).toBe(1);
      expect(hits('// const f = new Intl.DateTimeFormat("en",{timeZone:z});\n// d.toLocaleString()')).toBe(0);
      const files = ["server.js", "db.js"];
      const walk = (dir) => {
        for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
          const rel = dir + "/" + e.name;
          if (e.isDirectory()) walk(rel); else if (e.name.endsWith(".js")) files.push(rel);
        }
      };
      walk("lib"); walk("routes");
      expect(files.length).toBeGreaterThan(40);
      const found = {};
      for (const rel of files) { const n = hits(fs.readFileSync(path.join(ROOT, rel), "utf8")); if (n) found[rel] = n; }
      // Floor and verdict at once: lib/time.js holds exactly the one construction.
      // A number's toLocaleString is refused too, on purpose: it builds a formatter
      // per call as a date's does (keep one Intl.NumberFormat instead).
      expect(found, "build a date's formatter through lib/time.js zoneFormatter; every .toLocale…String( call (a number's included) builds a formatter per call").toEqual({ "lib/time.js": 1 });
    });
  });

  // 9.1.3 — EVERY PRESS IN THE CROSS SPECS GOES THROUGH THE RENDER-STALL HELPER.
  // On the CI runner WebKit can stop painting for 20 s or more, and an action
  // Playwright holds for "stable" (a requestAnimationFrame chain) then waits out
  // its whole budget. tests/helpers.js `pressThroughRenderStall` gets through,
  // and never sends again an input the browser took and never confirmed; the
  // two specs the WebKit projects run send every press through it. Direct clicks
  // left there flaked CI (the help drawer: PR and main runs, 14 Nov 2026). Raw
  // `page.mouse`/`page.touchscreen` input has no actionability wait and is not
  // a press; any other direct action is listed below with why it need not.
  test("every press in the cross specs goes through the render-stall helper", () => {
    const fs = require("fs");
    const path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const ROOT = path.join(__dirname, "..");
    // Built from parts: the bare name here would read as an unimported helper (the v7.16.2 scan below).
    const HELPER = ["press", "Through", "RenderStall"].join("");
    const ACTION = /(?<!\b(?:mouse|touchscreen))\.(click|dblclick|tap|check|uncheck|setChecked|hover|dragTo)\s*\(/g;
    const ALLOWED = {
      "tests/cross-device.spec.js": {
        // Reached only on the Chromium touch profiles (the test skips every WebKit
        // project just before it), and it taps a cell's corner so that nothing is
        // activated, which the helper, pressing a control's centre, cannot aim at.
        "cell.tap({ position: { x: 3, y: 3 } })": 1,
      },
    };
    const directActions = (src) => {
      const hits = [];
      let m;
      ACTION.lastIndex = 0;
      while ((m = ACTION.exec(src))) {
        const from = src.lastIndexOf("\n", m.index) + 1;
        const to = src.indexOf("\n", m.index);
        hits.push(src.slice(from, to < 0 ? undefined : to).trim());
      }
      return hits;
    };
    // Anti-vacuity: planted direct presses are found; the helper and raw mouse input are not.
    expect(directActions('await page.locator("#x").click();\nawait box.check();\nawait cell.hover();\nawait page.click("#y");').length).toBe(4);
    expect(directActions(`await ${HELPER}(page.locator("#x"), "x", "click", 20000);\nawait page.mouse.click(1, 1);\nawait page.touchscreen.tap(1, 1);`).length).toBe(0);
    let helperCalls = 0;
    const offenders = [];
    for (const rel of ["tests/cross-browser.spec.js", "tests/cross-device.spec.js"]) {
      const src = stripJsComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
      helperCalls += (src.match(new RegExp(`\\b${HELPER}\\(`, "g")) || []).length;
      const allowed = { ...(ALLOWED[rel] || {}) };
      for (const hit of directActions(src)) {
        const key = Object.keys(allowed).find((k) => hit.includes(k));
        if (key && allowed[key] > 0) { allowed[key]--; continue; }
        offenders.push(`${rel}: ${hit}`);
      }
      // Both ways: a listed exception the spec no longer holds is stale.
      for (const [k, n] of Object.entries(allowed)) if (n !== 0) offenders.push(`${rel}: listed exception not found: ${k}`);
    }
    // Floor: the two specs name the helper 28 times (cross-device through its one `press`).
    expect(helperCalls).toBeGreaterThan(20);
    expect(offenders, `a direct Playwright press in a cross spec (send it through tests/helpers.js ${HELPER})`).toEqual([]);
  });

  // v7.23.0 — the UI-polish tooling is an INSTRUMENT, and it had rotted
  // silently in exactly the way this block exists to prevent.
  //
  // `.claude/screens.json` named `public/app.js` as the behaviour file for 34
  // of its 38 screens. That file has not existed since the v7.0.0 ESM split.
  // Every `ui-polisher` dispatch was handed a dead path. Worse, every admin
  // route_script clicked `.tab:has-text(X)` — the admin nav became a SIDEBAR in
  // v6.20.x (`button.admin-nav-item`), so `.tab` matched nothing, the click
  // threw, `_ui-polish.spec.js`'s try/catch swallowed it, and the screenshot
  // captured whatever tab happened to be open. Two more selectors
  // (`#new-task-btn`, `[data-action=open-bulk-assign]`) never existed at all.
  //
  // None of that fails anything at runtime — the pipeline is opt-in tooling, so
  // a dead path just produces a subtly wrong screenshot or a no-op edit. Prose
  // did not hold it (v7.15.15); a scanner does.
  //
  // The check is deliberately STRUCTURAL rather than a name list: every path
  // must exist on disk, and every `#id` / `data-action` the manifest routes
  // through must appear somewhere in the app source. Nothing has to be
  // remembered when a screen is added.
  test("v7.23.0: the polish manifest names only paths and selectors that exist", () => {
    const fs = require("fs");
    const path = require("path");
    const ROOT = path.join(__dirname, "..");
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude", "screens.json"), "utf8"));
    const screens = man.screens || [];
    expect(screens.length).toBeGreaterThan(40);

    const bad = [];

    // 1. Every file the polisher is pointed at must exist.
    for (const s of screens) {
      for (const [slot, v] of Object.entries(s.files || {})) {
        if (!v) continue;
        for (const p of [v.path, ...(v.also || [])]) {
          if (p && !fs.existsSync(path.join(ROOT, p))) {
            bad.push(`${s.screen}: files.${slot} -> missing file ${p}`);
          }
        }
      }
    }

    // 2. Every id / data-action the route_script or visual_anchor uses must
    //    appear in the app source. `public/app.js` is deliberately absent from
    //    this haystack — a manifest that still references it will fail (1).
    let hay = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) walk(fp);
        else if (e.name.endsWith(".js")) hay += fs.readFileSync(fp, "utf8");
      }
    };
    walk(path.join(ROOT, "public", "js"));
    for (const extra of ["help.js", "help-renderer.js"]) {
      const fp = path.join(ROOT, "public", extra);
      if (fs.existsSync(fp)) hay += fs.readFileSync(fp, "utf8");
    }

    // 6. (below) THE POLISHER MAY EDIT EVERY public/ FILE THE MANIFEST HANDS IT.
    //    The ui-polisher's scope grant (.claude/agents/ui-polisher.md) names
    //    index.html, styles.css, the public/js/** modules of its entry and a list
    //    of standalone files; a manifest slot naming any other public/ file is a
    //    screen the polisher is told to polish and forbidden to touch
    //    (help-page-standalone named help.js and help-renderer.js, which the
    //    list left out). A slot outside public/ is read-only context by the
    //    grant's own rule (server-rendered markup), so it is not judged here.
    const polisherMd = fs.readFileSync(path.join(ROOT, ".claude", "agents", "ui-polisher.md"), "utf8");
    const grantList = /standalone files in `public\/` for the non-SPA pages \(([^)]*)\)/.exec(polisherMd);
    const standaloneGrant = grantList ? [...grantList[1].matchAll(/`([^`]+)`/g)].map(m => `public/${m[1]}`) : [];
    expect(standaloneGrant.length, "anti-vacuity: ui-polisher.md's list of standalone files was found").toBeGreaterThanOrEqual(3);
    const granted = (p) => p === "public/index.html" || p === "public/styles.css" || p.startsWith("public/js/") || standaloneGrant.includes(p);
    let publicSlots = 0;

    for (const s of screens) {
      for (const [slot, v] of Object.entries(s.files || {})) {
        if (!v) continue;
        for (const p of [v.path, ...(v.also || [])]) {
          if (!p || !p.startsWith("public/")) continue;
          publicSlots++;
          if (!granted(p)) bad.push(`${s.screen}: files.${slot} names ${p}, outside the ui-polisher's scope grant (.claude/agents/ui-polisher.md)`);
        }
      }
      const blob = `${s.visual_anchor || ""} ${s.route_script || ""}`;
      for (const id of blob.match(/#[a-z][a-z0-9-]{2,}/g) || []) {
        // v7.23.4 — the match must END at an identifier boundary. A bare
        // `hay.includes(...)` is a SUBSTRING test, and it let `#new-task-btn`
        // through for releases because the source contains `new-task-btn-row`.
        // The route then clicked a control that does not exist, the capture spec
        // swallowed the failure, and the screenshot was of the wrong screen —
        // exactly what this lock exists to prevent, defeated by its own regex.
        const bare = id.slice(1);
        const bounded = new RegExp(`${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-zA-Z0-9_-])`);
        if (!bounded.test(hay)) bad.push(`${s.screen}: id ${id} not found in app source`);
      }
      for (const m of blob.matchAll(/data-action=([a-z][a-z0-9-]+)/g)) {
        // Either quote: markup spells `data-action="x"`, while JS-built menus and
        // registerAction() spell `'x'`. Both are the exact token, never a substring.
        if (!hay.includes(`"${m[1]}"`) && !hay.includes(`'${m[1]}'`)) bad.push(`${s.screen}: data-action=${m[1]} not found`);
      }
      // 3. The admin nav is a sidebar, not tabs. `.tab:has-text(...)` matches
      //    nothing and fails SILENTLY inside the capture spec's try/catch.
      if (/\.tab:has-text\(/.test(s.route_script || "")) {
        bad.push(`${s.screen}: route_script uses .tab:has-text(...) — the admin nav is button.admin-nav-item`);
      }

      // 4. v8.11.3 — AN ADMIN TAB IS ADDRESSED BY `data-tab-id`, NEVER BY ITS
      //    LABEL. This is the defect the whole batch came from: v8.7.5 renamed
      //    the Competitions tab to **Events** and left `data-tab-id` alone, and
      //    `screens.json` was the last file in the repo still spelling the old
      //    label. ELEVEN route_scripts clicked a button that no longer exists,
      //    so 21% of the polish pipeline could not reach its screen — and this
      //    lock could not see it, because rule 2 checks ids and data-actions and
      //    the label is neither.
      //
      //    The repo already has this rule for its own specs (`TAB_SLUG` +
      //    `_tabSel()` in tests/ui-admin-helpers.js, mirrored in four spec
      //    files): resolve a tab by `data-tab-id`, because the label is COPY and
      //    copy moves. The manifest is held to the same rule here.
      if (/\.admin-nav-item:has-text\(/.test(s.route_script || "")) {
        bad.push(`${s.screen}: route_script selects an admin tab by LABEL TEXT — use ` +
          `button.admin-nav-item[data-tab-id="admin-<slug>-tab"]; the label is copy and moves (v8.7.5)`);
      }

      // 5. v8.11.3 — EVERY SCOPE ANCHOR MUST MATCH IN THE FILE IT NAMES.
      //    `.claude/agents/ui-polisher.md:46` tells the subagent to "use the
      //    grep patterns to locate the region" — so a pattern matching nothing
      //    is a dead SCOPE: the polisher is pointed at a file and told to narrow
      //    to a region that does not exist, and it either edits nothing or edits
      //    the whole file. Twelve were dead when this arm was written, three
      //    matching nowhere in public/ at all. Rule 1 checks that the PATH
      //    exists and never opened it.
      for (const [slot, v] of Object.entries(s.files || {})) {
        if (!v || !v.grep || !v.path) continue;
        const fp = path.join(ROOT, v.path);
        if (!fs.existsSync(fp)) continue;              // rule 1 already reported it
        let rx;
        try { rx = new RegExp(v.grep); }
        catch (e) { bad.push(`${s.screen}: files.${slot}.grep is not a valid regex — ${e.message}`); continue; }
        if (!rx.test(fs.readFileSync(fp, "utf8"))) {
          bad.push(`${s.screen}: files.${slot}.grep /${v.grep}/ matches nothing in ${v.path} — dead edit scope`);
        }
      }
    }

    // ANTI-VACUITY. Both new arms are absence checks, so a manifest that lost
    // its route_scripts or its files blocks would satisfy them trivially.
    const withScript = screens.filter(s => s.route_script).length;
    const withGrep = screens.filter(s => Object.values(s.files || {}).some(v => v && v.grep)).length;
    expect(withScript, "anti-vacuity: route_scripts must still be present").toBeGreaterThanOrEqual(40);
    expect(withGrep, "anti-vacuity: scope anchors must still be present").toBeGreaterThanOrEqual(40);
    expect(publicSlots, "anti-vacuity: rule 6 judged the manifest's public/ files").toBeGreaterThanOrEqual(100);

    expect(bad, `\n  ${bad.join("\n  ")}\n`).toEqual([]);
  });

  // EVERY DIALOG THE SPA MOUNTS HAS A POLISH MANIFEST ENTRY. The manifest's
  // `_doc` says it lists every polishable surface, and prose did not hold that:
  // the three Add Tag dialogs, Add to Group, the group's Members and Events,
  // Users & roles' Change role and Events, the rich editor's Insert Link and the
  // address prompt were all shipped with no entry, so no polish run could reach
  // them. Every dialog mounts through ONE door, `overlayDismiss(` (CLAUDE.md,
  // Modal dismissal contract), so the mount sites are enumerable:
  //   • each call site lies in the SCOPE of an entry: the entry names the file
  //     (behaviour or markup, `also` included) and its grep matches the code of
  //     the enclosing function (or registerAction) up to the call; a null grep
  //     is the whole file, so a whole-file scope must be a deliberate one;
  //   • a dialog FACTORY (a function taking the overlay's `id` first, such as
  //     users-admin.js `_dialog`) mounts several dialogs at one site, so each
  //     literal id passed to it must be named (`#id`) by an entry's anchor or
  //     route.
  // Comments are blanked first (a comment naming overlayDismiss( is no mount,
  // and cannot fake a grep match). Not held: pages, panes and popovers, which
  // mount through no one door; the `_doc` claim for those is still prose.
  function uncoveredDialogs(sources, screens) {
    const { stripComments } = require("./html-sink-scan");
    const out = [];
    const sites = [], factoryIds = [];
    const factories = new Set();
    for (const { rel, raw } of sources) {
      const code = stripComments(raw);
      const decls = [...code.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([\w$]+)\s*\(([^)]*)\)|^const\s+([\w$]+)\s*=\s*(?:async\s*)?\(|registerAction\(\s*["']([\w-]+)["']/gm)];
      for (const m of code.matchAll(/\boverlayDismiss\s*\(/g)) {
        if (/function\s+$/.test(code.slice(Math.max(0, m.index - 16), m.index))) continue;   // the definition
        const d = decls.filter((x) => x.index < m.index).pop();
        const start = d ? d.index : 0;
        const name = d ? (d[1] || d[3] || d[4]) : "(module)";
        if (d && d[1] && /^\s*id\b/.test(d[2] || "")) factories.add(`${rel}:${d[1]}`);
        sites.push({ rel, name, region: code.slice(start, m.index), line: code.slice(0, m.index).split("\n").length });
      }
    }
    for (const { rel, raw } of sources) {
      const code = stripComments(raw);
      for (const f of factories) {
        const [frel, fname] = f.split(":");
        if (frel !== rel) continue;
        for (const m of code.matchAll(new RegExp(`\\b${fname.replace(/\$/g, "\\$")}\\(\\s*(["'\`])([\\w-]+)\\1`, "g"))) factoryIds.push({ rel, fname, id: m[2] });
      }
    }
    const scopes = (rel) => screens.flatMap((e) => Object.values(e.files || {})
      .filter((v) => v && v.path && [v.path, ...(v.also || [])].includes(rel)).map((v) => ({ screen: e.screen, grep: v.grep })));
    for (const s of sites) {
      const by = scopes(s.rel).filter((sc) => !sc.grep || new RegExp(sc.grep).test(s.region));
      if (!by.length) out.push(`${s.rel}:${s.line} ${s.name}() mounts a dialog no manifest entry's scope reaches`);
    }
    const named = (id) => screens.some((e) => new RegExp(`#${id}(?![\\w-])`).test(`${e.visual_anchor || ""} ${e.route_script || ""}`));
    for (const f of factoryIds) if (!named(f.id)) out.push(`${f.rel}: ${f.fname}("${f.id}") mounts a dialog no manifest entry names (#${f.id})`);
    return { out, sites: sites.length, factoryIds: factoryIds.length };
  }

  test("every dialog the SPA mounts lies in a polish manifest entry's scope", () => {
    const fs = require("fs");
    const path = require("path");
    const ROOT = path.join(__dirname, "..");
    // Planted controls: a dialog with no entry, a factory id nobody names, and a
    // comment that only quotes the call are told apart from covered ones.
    const plantSrc = [{ rel: "public/js/features/planted.js", raw: [
      "export function openWidget(){ const ov=document.createElement('div'); overlayDismiss(ov,()=>ov.remove()); }",
      "function _mk(id, title){ const ov=document.createElement('div'); ov.id=id; overlayDismiss(ov,()=>ov.remove()); }",
      "export function openA(){ _mk('pl-a', 'A'); }  export function openB(){ _mk('pl-b', 'B'); }",
      "// overlayDismiss(nothing) in a comment is no mount",
    ].join("\n") }];
    const bare = uncoveredDialogs(plantSrc, []);
    expect(bare.out.length, `the widget, the factory and its two ids are each caught: ${JSON.stringify(bare.out)}`).toBe(4);
    expect(bare.sites, "a comment quoting the call is no mount").toBe(2);
    const plantMan = [{ screen: "pl", visual_anchor: "#pl-a", route_script: "click #pl-b", files: { behaviour: { path: "public/js/features/planted.js", grep: "openWidget|function _mk" } } }];
    expect(uncoveredDialogs(plantSrc, plantMan).out, "an entry whose grep reaches each site and names each id covers them").toEqual([]);
    const wrongGrep = [{ ...plantMan[0], files: { behaviour: { path: "public/js/features/planted.js", grep: "openSomethingElse" } } }];
    expect(uncoveredDialogs(plantSrc, wrongGrep).out.length, "naming the file is not enough: the grep must reach the site").toBe(2);

    const sources = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".js")) sources.push({ rel: path.relative(ROOT, p).split(path.sep).join("/"), raw: fs.readFileSync(p, "utf8") });
      }
    })(path.join(ROOT, "public", "js"));
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude", "screens.json"), "utf8"));
    const r = uncoveredDialogs(sources, man.screens || []);
    expect(r.sites, "anti-vacuity: the SPA's dialog mount sites were found").toBeGreaterThanOrEqual(40);
    expect(r.factoryIds, "anti-vacuity: the dialog factories' literal ids were found").toBeGreaterThanOrEqual(4);
    expect(r.out, `add a .claude/screens.json entry (or widen the grep of the one that owns it):\n  ${r.out.join("\n  ")}\n`).toEqual([]);
  });

  // v7.23.1 (audit Wave 3) — no JS may dim a text-bearing element with opacity.
  //
  // The standing rule ("never dim a text-bearing surface with opacity") has now
  // been broken four times: v7.22.0 (.comp-card.internal at .75), v7.23.0 (the
  // benchmark rankings row at .7) and TWO sites that survived both sweeps
  // because they live in JavaScript, where a stylesheet scan cannot reach:
  //   • ui/nav.js  style.opacity='0.5' on #nav-competitions — applied for the
  //     whole event, measured 2.03:1 light / 2.21:1 dark, and the largest single
  //     contrast group in the v7.23.0 audit (66 axe instances). Invisible to CI
  //     because #main-nav sits in <header>, outside every participant scope.
  //   • core/main.js  style="opacity:.75" on the dry-run analytics picker card —
  //     the EXACT value v7.22.0 had removed from CSS, surviving in a template.
  //
  // So this scans the JS, which is the half no CSS lock covers. Opacity that
  // ANIMATES (0 -> 1 reveals) and opacity CLEARED (set to '' or 1) are fine; a
  // value below 1 is not, WHATEVER EXPRESSION WRITES IT. A fifth site slipped past
  // the first form of this scan, which looked only for a literal straight after
  // the operator: `btn.style.opacity=changed?'1':'0.5'` faded the Assign to Events
  // dialog's disabled Save button (DESIGN_SYSTEM §7: "Disabled controls never
  // fade"; `.btn:disabled` draws that state at full strength). The value of every
  // write is now read through tests/js-opacity-scan.js — a conditional's branches,
  // a setter's argument, an object key, a CSS string, an interpolation, a
  // concatenation, a markup attribute — on comment-stripped source, and a value
  // it cannot read fails until it is a literal or has a decision below.
  //
  // The allowlist is per site and both ways, and each entry states why its target
  // is not text. An inactive control is not such a reason: a disabled control
  // never fades.
  test("v7.23.1: no JS dims a text-bearing element with opacity, through any expression", () => {
    const fs = require("fs");
    const path = require("path");
    const ROOT = path.join(__dirname, "..");
    const { stripJsComments } = require("./doc-registry");
    const { opacityWrites, OK, DIM, UNKNOWN } = require("./js-opacity-scan");

    // { file, site: a substring of the flagged write, why } — none today.
    const ALLOW = [];

    // The SPA's modules and the classic scripts beside them (theme-boot, help).
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp);
        else if (e.name.endsWith(".js")) files.push(fp);
      }
    };
    walk(path.join(ROOT, "public", "js"));
    for (const f of fs.readdirSync(path.join(ROOT, "public"))) if (f.endsWith(".js")) files.push(path.join(ROOT, "public", f));
    expect(files.length, "anti-vacuity: the SPA's scripts are found").toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith(path.join("public", "theme-boot.js"))), "…the classic scripts too").toBe(true);

    // PLANTED CONTROLS, through the SAME pipeline as the tree (comment stripping
    // included): the reported shape, a fade in each other form, a value nothing can
    // read, the show/hide/clear forms that are fine, and mentions that write nothing
    // (comment markers built from parts: source keeps them out of its strings).
    const SL = "/";
    const PLANTED = [
      ["btn.style.opacity=changed?'1':'0.5';", [DIM]],
      ["x.style.setProperty('opacity', dim ? .4 : 1); Object.assign(s, {opacity: 0.6}); o = {'opacity': .2};", [DIM, DIM, DIM]],
      ["h = `<p style=\"color:red;opacity:${muted ? '.55' : '1'}\">`; t.setAttribute('style', 'opacity:' + (off ? '0.5' : '1'));", [DIM, DIM]],
      ["e.style['opacity'] = '50%'; s = `<text opacity=\"0.4\">`; e.animate([{opacity: 1}, {opacity: .7}]); e.style.opacity = Math.max(.3, v);", [DIM, DIM, OK, DIM, DIM]],
      ["e.style.opacity = level; s = `opacity:${o}`; c.cssText = 'opacity:var(--fade)'; e.style.opacity = saved || '1';", [UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN]],
      ["e.style.opacity = shown ? '1' : '0'; e.style.opacity = ''; e.style.opacity = null; e.style.opacity = p > 0.5 ? 1 : 0; " +
        "e.style.opacity = (on ? ('1') : ('0')); e.style.opacity = String(on ? 1 : 0); ta.style.cssText = 'left:-9999px;opacity:0!important';", [OK, OK, OK, OK, OK, OK, OK]],
      ["e.style.transition = 'opacity var(--duration-fast)'; if (e.style.opacity === '0.5') f(); const rowOpacity = 'x'; let opacity='0.5'; " +
        "s = '<path fill-opacity=\"0.4\"/>'; const { opacity: o } = cs; const { 'opacity': q } = cs; " + SL + SL + " e.style.opacity = '0.5'\n" + SL + "* opacity:.3 *" + SL, []],
    ];
    for (const [src, want] of PLANTED) {
      expect(opacityWrites(stripJsComments(src)).map((w) => w.verdict), `planted: ${src}`).toEqual(want);
    }

    const sites = [];
    for (const fp of files) {
      const rel = path.relative(ROOT, fp).split(path.sep).join("/");
      const raw = fs.readFileSync(fp, "utf8");
      for (const w of opacityWrites(stripJsComments(raw))) {
        const i = raw.indexOf(w.text);
        sites.push({ ...w, where: i >= 0 ? `${rel}:${raw.slice(0, i).split("\n").length}` : rel, rel });
      }
    }
    expect(sites.length, "anti-vacuity: the tree's opacity writes are read").toBeGreaterThan(0);

    const bad = [], seen = new Set();
    for (const s of sites) {
      if (s.verdict === OK) continue;
      const a = ALLOW.find((x) => x.file === s.rel && s.text.includes(x.site));
      if (a) { seen.add(a); continue; }
      bad.push(`${s.where}  ${s.text}  — ${s.verdict === DIM ? "fades: a value lies between 0 and 1" : "cannot read the value: write it as a literal 0, 1 or ''"}`);
    }
    for (const a of ALLOW) if (!seen.has(a)) bad.push(`stale ALLOW entry ${a.file} ${a.site} (${a.why}): no such write is flagged any more — delete it`);
    expect(
      bad,
      "these JS sites dim an element with opacity, which composites its TEXT and silently drops " +
      "contrast below AA. Express de-emphasis with a colour token, a border or a badge instead — " +
      "see .nav-btn-muted and .picker-card[data-dry-run] for the shape — and leave a disabled " +
      "control to its :disabled rule. If a site's target is genuinely not text, add it to ALLOW " +
      "with the reason:\n  " + bad.join("\n  "),
    ).toEqual([]);
  });

  // v7.23.0 — every viewport-height declaration has a `dvh` sibling.
  //
  // On iOS Safari and Android Chrome `100vh` resolves to the LARGE viewport
  // (browser chrome hidden), so a `100vh` container's bottom sits under the URL
  // bar and a `max-height:85vh` overlay is taller than the space it actually
  // has — its action row goes off-screen with no way to scroll to it.
  //
  // The stylesheet already knew this: styles.css carries a comment explaining
  // the dvh upgrade, and 8 sites did it correctly. TEN did not, including all
  // three standalone sheets (the password-reset and verify pages, opened from
  // an email, on a phone, at the most fragile moment in the product). A comment
  // has not held this across four separate fixes, so it is a scanner now.
  //
  // SCOPE: only the three height properties, and only where a NUMERIC vh value
  // is used. Comments are stripped first, preserving line count — several
  // comments legitimately discuss `100vh` while explaining the fix, and a
  // scanner that flags its own explanation gets silenced (v7.21.24).
  // v7.23.7 — shared by the two locks below. Every other walker in this file is
  // scoped inside its own test; these two need the same list, so it is hoisted
  // rather than written twice.
  function walkJs(dir) {
    const fs = require("fs");
    const path = require("path");
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walkJs(full));
      else if (e.name.endsWith(".js")) out.push(full);
    }
    return out;
  }

  test("v7.23.11: anything that un-verifies a user also kills their verify_code", () => {
    // THE INVARIANT ONE-CLICK VERIFICATION DEPENDS ON. v7.23.10 stopped nulling
    // verify_code on success — the retained code is a 48h idempotency receipt, and
    // it is what lets a human clicking AFTER a mail scanner be told the truth
    // instead of "Verification Failed".
    //
    // The cost is that a code stays live for its window, which only matters if
    // `verified` can return to 0 while it does. Three statements can do that, and
    // all three handle it: the admin email change RE-MINTS a code in the same
    // statement, the email-swap path NULLs it, and the participant-import
    // overwrite clears it when — and only when — verified is being set to 0.
    // That third one was a real hole, created by v7.23.10 and closed in the same
    // patch. A FOURTH such statement would silently re-open it: an operator
    // forcing re-verification could be undone by a late scanner re-crawl.
    //
    // Scoped to statements that WRITE the verified column. Reads, and the many
    // UPDATEs that never mention it, are none of this test's business.
    const fs = require("fs");
    const path = require("path");
    const ROOT = path.resolve(__dirname, "..");
    const files = ["server.js", "db.js",
      ...fs.readdirSync(path.join(ROOT, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`),
      ...fs.readdirSync(path.join(ROOT, "lib")).filter(f => f.endsWith(".js")).map(f => `lib/${f}`)];
    const offenders = [];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      // Each UPDATE statement, whole — these are written across several lines.
      for (const m of src.matchAll(/UPDATE\s+users\s+SET([\s\S]*?)(?:WHERE[\s\S]*?)?["'`]/g)) {
        const stmt = m[1];
        if (!/\bverified\s*=/.test(stmt)) continue;          // does not write the column
        if (/verified\s*=\s*1\b/.test(stmt) && !/verified\s*=\s*\?/.test(stmt)) continue; // only ever sets 1
        if (/verify_code\s*=/.test(stmt)) continue;           // replaces or clears it — fine
        offenders.push(`${rel}: UPDATE users SET …${stmt.replace(/\s+/g, " ").trim().slice(0, 90)}…`);
      }
    }
    expect(offenders, "a statement that can set verified=0 must also replace or clear "
      + "verify_code, or a retained receipt silently re-verifies the account:\n  "
      + offenders.join("\n  ")).toEqual([]);
  });

  // ── v7.23.9 — the standalone page shells share an a11y FLOOR ──────────────
  test("v7.23.9: every standalone page stylesheet meets the shell floor", () => {
    // THREE near-identical shells for the pages reached from an email:
    // reset-password.css, verify-pages.css (every result page, all now rendered
    // by _emailResultPage) and unsubscribe.css. There were four until v7.23.11,
    // when the forked verify-page.css was merged away — but the remaining three
    // are still forks, and they had drifted ONE-SIDEDLY: verify-page.css reached
    // v7.23.8 with no DESIGNED focus ring, falling back to the UA default while
    // its siblings drew the branded 2px --accent2 one. That is why this floor
    // exists even though one fork is gone.
    //
    // Note precisely what this checks and what it does not. A missing
    // :focus-visible rule is NOT a missing focus indicator: nothing in these
    // sheets sets outline:none and styles.css is not loaded on these pages, so
    // the browser's own ring survives. (The first version of this lock called
    // that a WCAG 2.4.7 violation, which was wrong — reasoned from the absence
    // of a rule instead of measured from the rendered result.) The floor is that
    // each shell makes a DELIBERATE choice, so the surfaces one recipient
    // reaches from the same email do not disagree under the keyboard.
    //
    // THIS IS DELIBERATELY A FLOOR, NOT A DIFF. The sheets legitimately differ in
    // design values — verify-page.css rounded its button 8px where verify-pages.css
    // used a token, and their hover treatments are different — so a
    // property-by-property equality check would be wrong about working code, and
    // merging them is a visible redesign of a shipping surface rather than a
    // defect fix. What every shell owes regardless of design is the a11y floor
    // below: a keyboard focus indicator, a forced-colors fallback, and a
    // colour-scheme declaration so form controls and scrollbars follow the theme.
    const fs = require("fs");
    const path = require("path");
    const DIR = path.resolve(__dirname, "..", "public");
    // Derived, not listed: a new shell must not be able to escape by being new
    // (the v7.23.6 lesson, where a hand-maintained list of four let the fifth
    // sheet through). fonts.css declares only @font-face; styles.css is the SPA.
    const shells = fs.readdirSync(DIR)
      .filter(f => f.endsWith(".css") && !["fonts.css", "styles.css"].includes(f));
    expect(shells.length, "no standalone shells found — the scan would be vacuous")
      .toBeGreaterThan(1);
    const gaps = [];
    for (const f of shells) {
      const css = fs.readFileSync(path.join(DIR, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      // An ORDINARY rule, not one buried in @media(forced-colors) — that block
      // paints for nobody in normal mode, and counting it is exactly how the
      // verify-page.css gap survived a grep.
      // Brace-match the block rather than pattern-match its end. verify-pages.css
      // writes the whole thing on ONE line, so a regex ending in `\n}` reported a
      // sheet that has had the block for releases as missing it — the scanner
      // being wrong about working code, which is how a scanner gets silenced.
      const at = css.search(/@media[^;{]*forced-colors[^{]*\{/);
      let forced = null;
      if (at >= 0) {
        let i = css.indexOf("{", at), depth = 0, end = i;
        for (; end < css.length; end++) {
          if (css[end] === "{") depth++;
          else if (css[end] === "}" && --depth === 0) break;
        }
        forced = css.slice(at, end + 1);
      }
      const ordinary = forced ? css.replace(forced, "") : css;
      if (!/:focus-visible/.test(ordinary)) gaps.push(`${f}: no keyboard focus indicator outside forced-colors`);
      if (!forced) gaps.push(`${f}: no @media(forced-colors:active) fallback`);
      // An UNGATED :hover fires on every tap on a touch device and leaves the
      // control stuck in its hovered state. reset-password.css has gated it
      // since v6.9.13 with that reason written down; both verify sheets never
      // did, on pages whose common case is a phone opening an email.
      if (/(^|[^)])\s*\.btn:hover\s*\{/.test(ordinary.replace(/@media\s*\(hover:hover\)[^{]*\{[^}]*\}[^}]*\}?/g, "")))
        gaps.push(`${f}: .btn:hover is not gated by @media(hover:hover)`);
      // NOT checked here: color-scheme. It is declared by the page's
      // `<meta name="color-scheme">` (and asserted for every standalone HTML by
      // the v6.2.6 lock further down this file), so demanding it in the
      // STYLESHEET flags three working sheets. A floor that fails on correct
      // code is worse than no floor.
    }
    expect(gaps, `standalone shells missing the a11y floor:\n  ${gaps.join("\n  ")}`).toEqual([]);
  });

  // ── v7.23.7 — required-ness must be PROGRAMMATIC, not just a red star ──────
  test("v7.23.7: every starred field also carries aria-required", () => {
    // Before this release, "required" was communicated by `<span class="req">*</span>`
    // in the label and NOTHING else: 47 stars across 7 files, and aria-required
    // appeared nowhere at all. A screen-reader user was never told a field was
    // mandatory. WCAG 3.3.2.
    //
    // SCOPE, stated rather than implied: `.form-group` wrappers only, and only
    // those containing a control. Two starred constructs are deliberately out of
    // scope and must NOT be "fixed" by a future sweep —
    //   * the Duration boxes (competitions-admin, sessions-admin) are a
    //     role="group" of days/hours/minutes where NO single input is required,
    //     so aria-required on each would falsely claim all three must be filled;
    //   * the Choices container is populated at runtime and has no control of
    //     its own to carry the attribute (its wrapper IS a .form-group, so the
    //     error path marks it via the shared helper instead).
    // A scanner that is wrong about working code gets silenced by whoever hits
    // it next, so it checks what it can defend and says what it cannot.
    const fs = require("fs");
    const path = require("path");
    const ROOT = path.resolve(__dirname, "..");
    const files = ["public/index.html", ...walkJs(path.join(ROOT, "public/js"))];
    const missing = [];
    const orphan = [];
    for (const rel of files) {
      const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
      const src = fs.readFileSync(abs, "utf8");
      const name = path.relative(ROOT, abs);
      for (const m of src.matchAll(/<div class="form-group"[^>]*>([\s\S]*?)<\/div>/g)) {
        const g = m[1];
        const hasCtl = /<(input|select|textarea)\b/.test(g);
        if (!hasCtl) continue;
        const starred = g.includes('class="req"');
        const marked = g.includes("aria-required");
        if (starred && !marked) missing.push(`${name}: ${g.slice(0, 90).replace(/\s+/g, " ")}`);
        // The reverse direction matters too: aria-required with no visible star
        // tells assistive tech something sighted users are never shown.
        if (!starred && marked) orphan.push(`${name}: ${g.slice(0, 90).replace(/\s+/g, " ")}`);
      }
    }
    expect(missing, `starred fields with no aria-required:\n  ${missing.join("\n  ")}`).toEqual([]);
    expect(orphan, `aria-required with no visible required marker:\n  ${orphan.join("\n  ")}`).toEqual([]);
  });

  test("v7.23.7: field-error is only ever toggled through the shared helper", () => {
    // `.field-error` paints a red border and a red label — colour alone. The
    // class goes on the .form-group WRAPPER while aria-invalid must go on the
    // CONTROL, two different elements, which is precisely how they drift when
    // every call site does it by hand. There were 12 such sites across three
    // files. markFieldError()/clearFieldErrors() (ui/profile-form.js) move both
    // together; this fails if a new site goes back to touching the class alone.
    const fs = require("fs");
    const path = require("path");
    const ROOT = path.resolve(__dirname, "..");
    const offenders = [];
    for (const abs of walkJs(path.join(ROOT, "public/js"))) {
      const name = path.relative(ROOT, abs);
      if (name.endsWith("ui/profile-form.js")) continue;   // the helper itself
      const src = fs.readFileSync(abs, "utf8");
      src.split("\n").forEach((ln, i) => {
        if (/classList\.(add|remove|toggle)\(\s*['"]field-error['"]/.test(ln)) {
          offenders.push(`${name}:${i + 1}: ${ln.trim().slice(0, 100)}`);
        }
      });
    }
    expect(offenders, "toggle .field-error via markFieldError()/clearFieldErrors() so "
      + `aria-invalid moves with it:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  // Every PROPERTY, not only the three heights: the rule is "every vh
  // declaration", and a padding or margin in vh (the sign-in and sign-up
  // cards' spacing) passed a height-only scan. The planted lines below keep
  // the widened matcher honest.
  test("v7.23.0: every vh declaration has a dvh sibling", () => {
    const fs = require("fs");
    const path = require("path");
    const stripCss = (css) => {
      let out = "", i = 0; const n = css.length; let inBlock = false;
      while (i < n) {
        const c = css[i], c2 = css[i + 1];
        if (!inBlock) {
          if (c === "/" && c2 === "*") { inBlock = true; i += 2; continue; }
          out += c; i++;
        } else {
          if (c === "*" && c2 === "/") { inBlock = false; i += 2; continue; }
          out += c === "\n" ? "\n" : " "; i++;
        }
      }
      return out;
    };
    // A declaration (any property) holding a numeric vh, and its dvh sibling.
    const scan = (lines, label, out) => lines.forEach((line, idx) => {
      for (const m of line.matchAll(/(?<![\w-])((?:--)?[a-z][a-z-]*)\s*:\s*[^;{}]*?\b\d*\.?\d+vh\b/g)) {
        const prop = m[1];
        if (new RegExp(`(?<![\\w-])${prop}\\s*:\\s*[^;{}]*?\\d+dvh`).test(line)) continue;
        out.push(`${label}:${idx + 1}  ${prop} uses vh with no dvh sibling — ${m[0].slice(0, 60)}`);
      }
    });
    // Anti-vacuity: the matcher sees a padding, a margin and a width as well as
    // a height, and a dvh sibling clears each.
    const planted = [];
    scan([".a{padding:clamp(12px,3vh,40px) 16px}", ".b{margin-bottom:clamp(8px,1.4vh,14px)}", ".c{width:min(70vh,80vw)}", ".d{max-height:85vh}"], "planted", planted);
    expect(planted, "the scanner flags every property that uses vh").toHaveLength(4);
    const cleared = [];
    scan([".a{padding:3vh 16px;padding:3dvh 16px}", ".d{max-height:85vh;max-height:85dvh}", ".e{height:100dvh}"], "ok", cleared);
    expect(cleared, "a dvh sibling clears a declaration").toEqual([]);
    const bad = [];
    const dir = path.join(__dirname, "..", "public");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".css"))) {
      scan(stripCss(fs.readFileSync(path.join(dir, f), "utf8")).split("\n"), `public/${f}`, bad);
    }
    // And INLINE style strings: the SPA's modules and pages write dialog
    // shells with `style="max-height:85vh"`, which the stylesheet scan cannot
    // see. Comments first (the shared stripper; its line numbers shift, so a
    // finding names the file and the declaration).
    const { stripJsComments } = require("./doc-registry");
    const inline = (raw, rel, out) => {
      const found = [];
      scan((rel.endsWith(".html") ? raw.replace(/<!--[\s\S]*?-->/g, "") : stripJsComments(raw)).split("\n"), rel, found);
      for (const f of found) out.push(f.replace(/:\d+ {2}/, "  "));
    };
    const plantedJs = [];
    inline('setSafeHtml(o, `<div class="card" style="width:100%;max-height:90vh;overflow:auto">`);', "planted.js", plantedJs);
    inline("o.style.cssText='position:fixed;max-height:calc(100vh - 48px)';", "planted.js", plantedJs);
    inline('<div style="max-height:80vh"></div>', "planted.html", plantedJs);
    expect(plantedJs, "the inline scan flags a vh in a JS template, a cssText string and an HTML attribute").toHaveLength(3);
    const clearedJs = [];
    inline('// a comment quoting style="max-height:90vh" is not code\nx = `<div style="max-height:calc(100vh - 48px);max-height:calc(100dvh - 48px)">`;', "ok.js", clearedJs);
    inline('<!-- style="max-height:80vh" -->', "ok.html", clearedJs);
    expect(clearedJs, "a dvh sibling clears an inline declaration, and a comment is not scanned").toEqual([]);
    const sources = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) sources.push(p); } };
    walk(path.join(dir, "js"));
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js") || x.endsWith(".html"))) sources.push(path.join(dir, f));
    expect(sources.length, "anti-vacuity: the SPA's modules and pages are read").toBeGreaterThan(50);
    for (const f of sources) inline(fs.readFileSync(f, "utf8"), path.relative(path.join(__dirname, ".."), f), bad);
    expect(
      bad,
      "these declarations use vh with no dvh fallback, so on iOS Safari / Android Chrome they " +
      "resolve against the LARGE viewport and their bottom content sits under the browser chrome. Add " +
      "the same value in dvh immediately after (e.g. `max-height:85vh;max-height:85dvh`) — identical on " +
      "desktop, correct on mobile:\n  " + bad.join("\n  "),
    ).toEqual([]);
  });

  // v7.23.0 — iOS Safari zooms the page when a focused form control is under
  // 16px, and does NOT zoom back out on blur. The only guard today is
  // `@media(max-width:600px){input,select,textarea{font-size:16px}}` at
  // styles.css:153, which is WIDTH-scoped — so it does not fire on a phone in
  // LANDSCAPE (iPhone 14 landscape is 750px wide, Galaxy S24 landscape 780px)
  // or on ANY iPad (768-1194px). The base rule sets font-family but no
  // font-size, so those controls fall back to the UA default.
  //
  // Pinned as a SOURCE check on purpose: Playwright's Linux `webkit` is
  // WebKitGTK, whose UA form-control default is already 16px, so the emulated
  // matrix cannot reproduce the zoom and a behavioural test would pass
  // vacuously. See README section "Cross-browser testing".
  //
  // v7.23.3 — the deferral is OVER: Wave 4 #19 landed the declaration, so the
  // test.fail() annotation was forced off exactly as designed. It was added in
  // v7.23.0 precisely so the deferral could not quietly become permanent; the
  // moment the fix arrived, CI went red until the annotation was removed.
  test("v7.23.3: form controls declare a >=16px font-size at every width", () => {
    const fs = require("fs");
    const path = require("path");
    const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
    const base = css.match(/input,select,textarea\{[^}]*\}/);
    expect(base, "the base input,select,textarea rule must still exist").toBeTruthy();
    // v7.23.3 — min-height joins font-size: it is the other half of Wave 4 #19,
    // and it is what normalised the measured 38/40/42/43/44px spread that had
    // three different control heights sitting in ONE flex row of the New
    // Competition dialog.
    const mh = base[0].match(/min-height\s*:\s*(\d+(?:\.\d+)?)px/);
    expect(!!(mh && Number(mh[1]) >= 44),
      "the base input,select,textarea rule must declare min-height >= 44px (house touch-target standard)").toBe(true);
    // v8.16 type scale: the size is the --fs-input token, which the type-token
    // block resolves through its 1rem step (the root stays the browser's 16 px).
    let size = base[0].match(/font-size\s*:\s*(\d+(?:\.\d+)?)px/);
    const tok = base[0].match(/font-size\s*:\s*var\((--fs-[a-z0-9-]+)\)/);
    if (!size && tok) {
      const resolve = (name, depth = 0) => {
        const d = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css);
        if (!d || depth > 4) return null;
        const v = d[1].trim(), inner = /^var\((--[a-z0-9-]+)\)$/.exec(v);
        if (inner) return resolve(inner[1], depth + 1);
        const rem = /^(\d*\.?\d+)rem$/.exec(v), px = /^(\d+(?:\.\d+)?)px$/.exec(v);
        return rem ? [null, String(Number(rem[1]) * 16)] : px ? [null, px[1]] : null;
      };
      size = resolve(tok[1]);
    }
    expect(
      !!(size && Number(size[1]) >= 16),
      "the base input,select,textarea rule must declare font-size >= 16px. Below 16px iOS Safari " +
      "zooms the page when a control is focused and does NOT zoom back out on blur — and the old " +
      "`@media(max-width:600px)` guard was width-scoped, so it never fired on a landscape phone " +
      "(750-780px) or on any iPad (768-1194px).",
    ).toBe(true);
  });

  // v7.23.0 — the polish command's VERIFY phase is documented as the one step
  // that may not be bypassed, and it named two spec files that were split away
  // in v7.21.35 / v7.21.37. Playwright exits non-zero with "no tests found", so
  // the mandatory a11y gate had simply stopped running. Any spec path the
  // command names literally (globs excluded — those degrade to matching fewer
  // files, not to an error) must exist.
  test("v7.23.0: the polish pipeline only names spec files that exist", () => {
    const fs = require("fs");
    const path = require("path");
    const ROOT = path.join(__dirname, "..");
    for (const rel of ["commands/polish.md", "agents/ui-polisher.md", "agents/ui-visual-verifier.md"]) {
      const fp = path.join(ROOT, ".claude", rel);
      if (!fs.existsSync(fp)) continue;
      const src = fs.readFileSync(fp, "utf8");
      // SCOPE: only paths inside a fenced COMMAND block. The failure mode is a
      // command that names a missing spec (Playwright then exits "no tests
      // found" and the gate silently stops running) — not prose, which
      // legitimately names the pre-split files when explaining WHY the globs
      // are there. A scanner that is wrong about working prose gets silenced by
      // whoever hits it next, so it must not read the explanation.
      const fenced = [...src.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
      for (const m of fenced.matchAll(/tests\/[A-Za-z0-9_.*-]+\.spec\.js/g)) {
        if (m[0].includes("*")) continue;
        expect(fs.existsSync(path.join(ROOT, m[0])), `${rel} names ${m[0]} in a command, and it does not exist`).toBe(true);
      }
    }
  });

  // v7.23.0 — swagger.yaml had silently dropped documented content TWICE, in
  // exactly the way v7.21.32's duplicate `info.version` did: a YAML mapping
  // keeps the LAST duplicate key, so an operation carrying `description:` twice
  // publishes only the second one and the first vanishes with no error
  // anywhere. Found while adding the competition-activity export — the file did
  // not parse at all in strict mode, so a new operation could not be validated.
  //
  // SCOPE, stated honestly: this checks the DIRECT children of an operation
  // (the `get:` / `post:` / ... under a path), which is the level with no
  // list/mapping ambiguity to get wrong. That is where ONE of the two real
  // defects lived — the `/api/admin/competitions/assign` double `description`.
  // The other (a stray `total:` inside the `/api/admin/unsubscribed` response
  // schema) was nested, and this lock does NOT catch it. Closing that needs a
  // real YAML parser, i.e. a lockfile change that forces a CI-image rebuild;
  // and a hand-rolled nested scanner is worse than none — the first attempt
  // reported ~140 "duplicates" that were almost all mis-scoped list items. A
  // scanner that is wrong about working code gets silenced by whoever hits it
  // next, so this one stays where it is sure.
  // v8.8.19 — THE WHOLE FILE, AT EVERY DEPTH, WITH NO YAML PARSER.
  //
  // The v7.23.0 scanner read an operation's DIRECT children only — the level
  // with no list/mapping ambiguity — and CLAUDE.md recorded closing that as
  // needing "a real YAML parser, i.e. a lockfile change forcing a CI-image
  // rebuild". Measured: it does not. A line-based scanner that tracks
  // INDENTATION is sufficient, and this one is clean at HEAD.
  //
  // ITS FIRST DRAFT FAILED — ~140 false duplicates, almost all list items it had
  // mis-scoped — and the three rules that fix it are the whole of the
  // subtlety. Each is here because removing it reproduces that failure:
  //
  //   * A LIST ITEM OPENS A FRESH NAMESPACE. `- name: a` / `- name: b` is two
  //     items, not a duplicate `name`. A `- ` at column N pops to N and marks
  //     the next container fresh, so the first key of each item RESETS the
  //     namespace it lands in.
  //   * A SCALAR SWALLOWS EVERYTHING DEEPER. After a key with any inline value,
  //     every more-indented line is text, not structure — one rule covering
  //     block scalars (`>`, `|`, with chomping/indent indicators) AND plain
  //     multi-line scalars. The cutoff must be the KEY COLUMN, not the line
  //     indent: on `- name: Auth` the key sits at column 4 while the line
  //     indents 2, and using the indent swallows the item's siblings.
  //   * THE KEY REGEX EXCLUDES `{` AND `[`. Without it `- { name: t, in: path }`
  //     parses as a key called `{ name`, which is where a large share of the
  //     first draft's noise came from.
  test("v8.8.19: no swagger mapping declares the same key twice, at any depth", () => {
    const fs = require("fs");
    const path = require("path");
    const lines = fs.readFileSync(path.resolve(__dirname, "..", "swagger.yaml"), "utf8").split("\n");

    const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#{[][^:]*?)\s*:(?:\s+(.*)|\s*)$/;
    const dups = [];
    const stack = [];            // { col, seen:Map<key,line>, fresh:boolean }
    let textIndent = null;       // inside a scalar: skip everything deeper
    let inspected = 0;

    const popTo = (col) => { while (stack.length && stack[stack.length - 1].col > col) stack.pop(); };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim()) continue;
      const indent = raw.match(/^\s*/)[0].length;

      if (textIndent !== null) { if (indent > textIndent) continue; textIndent = null; }
      if (/^\s*#/.test(raw)) continue;

      let col = indent;
      let rest = raw.slice(indent);
      let freshItem = false;
      // A `- ` (or a bare `-`) opens a new item at this column; its content
      // begins after the dash and the spaces that follow it.
      const dash = /^-(\s+|$)/.exec(rest);
      if (dash) {
        popTo(col);
        freshItem = true;
        col = indent + 1 + (dash[1] === "" ? 0 : dash[1].length);
        rest = rest.slice(dash[0].length);
        if (!rest.trim()) continue;              // `-` alone: the item's keys follow
      }

      const m = KEY.exec(rest);
      if (!m) continue;
      const key = m[1].trim();
      const value = (m[2] || "").trim();

      popTo(col);
      let top = stack[stack.length - 1];
      if (!top || top.col !== col) { top = { col, seen: new Map() }; stack.push(top); }
      else if (freshItem) top.seen = new Map();  // sibling list item: fresh namespace

      inspected++;
      if (top.seen.has(key)) {
        dups.push(`line ${i + 1}: duplicate "${key}" at indent ${col}, first at line ${top.seen.get(key)}`);
      } else top.seen.set(key, i + 1);

      // A flow collection is entirely on this line; anything else with a value
      // opens a scalar that owns every deeper line.
      if (value && !/^[{[]/.test(value)) textIndent = col;
      else if (!value) textIndent = null;
    }

    // Anti-vacuity: a shape drift that stopped the walk finding keys would pass
    // silently, which is the failure this whole class is about.
    expect(inspected, "the scanner inspected almost no keys — its shape assumption has drifted")
      .toBeGreaterThan(3000);
    expect(dups, `swagger.yaml publishes only the LAST of a duplicated key:\n${dups.join("\n")}`).toEqual([]);
  });

  test("docs must use {{platformName}} placeholder, not a hardcoded name", () => {
    const fs = require("fs");
    const path = require("path");
    const DOCS_DIR = path.resolve(__dirname, "..", "docs");

    function walk(dir, out = []) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith(".md")) out.push(full);
      }
      return out;
    }

    const files = walk(DOCS_DIR);
    expect(files.length).toBeGreaterThan(0);

    for (const f of files) {
      const body = fs.readFileSync(f, "utf8");
      // Must not hardcode the pre-rebrand default "Hack Arena" — anywhere.
      expect(body, `${f} hardcodes "Hack Arena" instead of {{platformName}}`)
        .not.toMatch(/\bHack\s+Arena\b/i);
      // Also catch the common misspelling {{platform_name}} (underscore
      // instead of camelCase). The helpdrawer only substitutes {{platformName}}.
      expect(body, `${f} uses {{platform_name}} — the marker is {{platformName}}`)
        .not.toMatch(/\{\{\s*platform_name\s*\}\}/);
    }
  });

  test("auto_ended history copy matches the reason the server actually records (all_participants_solved, not the dead all_solved)", () => {
    // Producer/consumer string contract for the revival-warning bug. The backend
    // records reason:'all_participants_solved' (server.js submit-path auto-end);
    // the history renderer used to check the never-emitted 'all_solved' literal,
    // so the "all participants solved all challenges" detail line never rendered.
    const fs = require("fs");
    const path = require("path");
    const hist = fs.readFileSync(path.resolve(__dirname, "..", "public/js/features/history.js"), "utf8");
    const srv = fs.readFileSync(path.resolve(__dirname, "..", "server.js"), "utf8");
    // The server emits this exact literal.
    expect(srv, "server.js no longer emits reason:'all_participants_solved'").toMatch(/reason:\s*["']all_participants_solved["']/);
    // The history renderer must consume the same literal …
    expect(hist, "history.js does not reference the real reason literal").toMatch(/all_participants_solved/);
    // … and must NOT key off the never-emitted 'all_solved'.
    expect(hist, "history.js still checks the dead 'all_solved' literal").not.toMatch(/reason\s*===\s*['"]all_solved['"]/);
  });

  test("competition edit-confirm copy distinguishes time-expired from all-solved ends (no hardcoded 'all solved' / 'stay ended')", () => {
    // Regression lock for the revival-warning bug: the edit-confirm copy must not
    // claim a non-manually-ended comp was "all solved" and "will stay ended" —
    // that was false for a time-expired comp (ended_at NULL), which actually
    // revives to live. The corrected copy branches on ended_at (single-slot +
    // timeslot) to tell time-expired ("becomes live again") from all-solved apart.
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "public/js/features/competitions-admin.js"), "utf8");
    // The old false copy must be gone.
    expect(src, "stale 'was auto-ended (all solved) … stay ended' copy still present")
      .not.toMatch(/was auto-ended \(all solved\)\. Duration will update but it will stay ended/);
    // The corrected three-way branches on ended_at for both single-slot + timeslot.
    expect(src, "single-slot edit-confirm no longer branches on comp.ended_at").toMatch(/else if\(comp\.ended_at\)/);
    expect(src, "multi-slot edit-confirm no longer branches on ts.ended_at").toMatch(/else if\(ts\.ended_at\)/);
    // The time-expired branch promises it becomes live again.
    expect(src, "time-expired branch copy missing").toMatch(/scheduled time elapsed\. Saving a later end time will make it/);
  });

  test("ext-audit F4: every emit-then-write txn in routes/ buffers its audit mirror", () => {
    // The auditor flagged 5 sites; the same emit-then-write pattern (a record*Event
    // followed by further DB writes in the same txn) appears at a handful more.
    // ALL must run through runTxnWithMirrorBuffer or a rollback past the emit leaks
    // a ghost app.jsonl line. Lock each wrap + forbid the bare invocation.
    const fs = require("fs");
    const path = require("path");
    const read = (f) => fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");
    const comp = read("routes/competitions.js");
    const sess = read("routes/sessions.js");
    const part = read("routes/participants.js");
    const grp = read("routes/groups.js");
    const chal = read("routes/challenges.js");

    // competitions.js — editTxn (PUT) + endTxn (end-now cascade)
    expect(comp).toMatch(/runTxnWithMirrorBuffer\(\(\)\s*=>\s*editTxn\(\)\)/);
    expect(comp, "bare editTxn();").not.toMatch(/\beditTxn\(\);/);
    expect(comp).toMatch(/runTxnWithMirrorBuffer\(\(\)\s*=>\s*endTxn\(\)\)/);
    expect(comp, "bare endTxn();").not.toMatch(/\bendTxn\(\);/);

    // sessions.js — tsEditTxn (PUT) + endNowTxn (timeslot end-now cascade)
    expect(sess).toMatch(/runTxnWithMirrorBuffer\(\(\)\s*=>\s*tsEditTxn\(\)\)/);
    expect(sess, "bare tsEditTxn();").not.toMatch(/\btsEditTxn\(\);/);
    expect(sess).toMatch(/runTxnWithMirrorBuffer\(\(\)\s*=>\s*endNowTxn\(\)\)/);
    expect(sess, "bare endNowTxn();").not.toMatch(/\bendNowTxn\(\);/);

    // participants.js — removeUserTxn + the 3 inline assign-revive txns
    expect(part).toMatch(/runTxnWithMirrorBuffer\(\(\)\s*=>\s*removeUserTxn\(\)\)/);
    expect(part, "bare removeUserTxn();").not.toMatch(/\bremoveUserTxn\(\);/);
    // The 3 inline assign-revive txns (timeslot, single-slot comp, cascade) each
    // use the runTxnWithMirrorBuffer(db.transaction(...)) form.
    const inlineWraps = (part.match(/runTxnWithMirrorBuffer\(db\.transaction\(/g) || []).length;
    expect(inlineWraps, "all 3 inline assign-revive txns must be wrapped").toBeGreaterThanOrEqual(3);

    // groups.js — group-create member-loop txn (import had to be added)
    expect(grp).toMatch(/require\("\.\.\/lib\/audit"\)[\s\S]*runTxnWithMirrorBuffer/);
    expect(grp).toMatch(/runTxnWithMirrorBuffer\(db\.transaction\(/);

    // challenges.js — addTasks (POST) + applyDiffs (PUT) competition-assignment txns
    expect(chal).toMatch(/require\("\.\.\/lib\/audit"\)[\s\S]*runTxnWithMirrorBuffer/);
    expect(chal).toMatch(/runTxnWithMirrorBuffer\(\(\)\s*=>\s*addTasks\(\)\)/);
    expect(chal, "bare addTasks();").not.toMatch(/\baddTasks\(\);/);
    expect(chal).toMatch(/runTxnWithMirrorBuffer\(\(\)\s*=>\s*applyDiffs\(\)\)/);
    expect(chal, "bare applyDiffs();").not.toMatch(/\bapplyDiffs\(\);/);
  });

  // ── ROOT-CAUSE LOCK (v7.15.15) ────────────────────────────────────────────
  // Across external-audit rounds 4–7 the SAME defect classes kept returning,
  // because each fix was applied to the site that was reported rather than to
  // every site sharing the invariant:
  //
  //   • v7.15.12 made the SERVER's fetch deadline cover the body. Round 7 found
  //     the client helper written later with the identical defect — and two MORE
  //     sites (register, invite) that no round had reported at all.
  //   • v7.15.11 made the staging quota reserve atomically. Round 7 found the
  //     preflight added later checking without reserving — the same class.
  //
  // Prose in CLAUDE.md did not prevent either, because nothing mechanically
  // enumerates the siblings. This scanner does: it finds EVERY place that arms
  // an abort deadline and fails if the timer is cleared before the body is
  // read. Clear a future failure by fixing the site, not by weakening the test.
  test("v7.15.20: runTxnWithMirrorBuffer is never handed a transaction directly", () => {
    // It RUNS its argument and returns that result — it does not return a
    // callable. `runTxnWithMirrorBuffer(db.transaction(...))` therefore commits
    // the transaction and returns undefined, and the near-universal next line,
    // `theResult()`, throws "not a function" AFTER the commit. Everything after
    // that point — cache invalidation, audit emits, follow-up writes — is
    // skipped, while the rows still land, so the only symptom is a log line.
    //
    // That is exactly how it shipped in v7.15.14 and survived until CI ran the
    // suite for the first time. The correct shape, used at every other call
    // site, is `runTxnWithMirrorBuffer(() => txn())`.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const files = [pathMod.join(root, "server.js"), pathMod.join(root, "db.js")];
    for (const d of ["routes", "lib"]) {
      for (const f of fs.readdirSync(pathMod.join(root, d))) {
        if (f.endsWith(".js")) files.push(pathMod.join(root, d, f));
      }
    }
    // NOTE the precise shape. Calling it as a bare statement —
    // `runTxnWithMirrorBuffer(db.transaction(() => {...}));` — is FINE and is
    // used in five places (routes/groups.js, routes/participants.js): the
    // transaction runs inside the wrapper and nothing touches the return value.
    // The defect is capturing that return value and INVOKING it. A first draft
    // of this scanner flagged the bare-statement form too and failed on clean
    // code, which is how that distinction got established.
    const offenders = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*runTxnWithMirrorBuffer\s*\(/g)) {
        const name = m[1];
        // Is that binding ever called?
        if (new RegExp(`\\b${name}\\s*\\(`).test(src.slice(m.index + m[0].length))) {
          offenders.push(`${pathMod.relative(root, f)}:${src.slice(0, m.index).split("\n").length} (\`${name}\`)`);
        }
      }
    }
    expect(offenders,
      "runTxnWithMirrorBuffer(txn) runs the transaction and returns its RESULT, not a callable — " +
      "so capturing the result and calling it throws AFTER the commit, silently skipping every " +
      "statement that follows. Write `runTxnWithMirrorBuffer(() => txn())` instead. " +
      "Offending sites:\n  " + offenders.join("\n  ")
    ).toEqual([]);
  });

  test("v7.15.28: the CI image's Node major is in lockstep with production's", () => {
    // CI previously ran whatever Node the Playwright base image happened to ship
    // (24 for v1.62.1-noble then, and still 24 on v1.64.0-noble as of v8.13.4 —
    // upstream's ARG NODE_VERSION) while production runs node:26-alpine — so the only
    // environment validating that Node version was one nobody deploys, and the
    // baked native addons (better-sqlite3, bcrypt) were compiled for an ABI
    // production never uses. That is the inversion of what CI is for.
    //
    // The two are now pinned together. This test is the lockstep: bump the app
    // Dockerfile and CI fails until the image is rebuilt on the same major.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const app = fs.readFileSync(pathMod.join(root, "Dockerfile"), "utf8");
    const ci = fs.readFileSync(pathMod.join(root, "ci", "Dockerfile.cross-browser"), "utf8");

    const appMajors = [...app.matchAll(/^FROM\s+node:(\d+)-/gm)].map(m => m[1]);
    expect(appMajors.length, "the app Dockerfile pins a node:<major> base").toBeGreaterThan(0);
    expect(new Set(appMajors).size,
      `the app Dockerfile's build and runtime stages must agree on a Node major (found ${appMajors.join(", ")})`
    ).toBe(1);
    // v8.13.4 — and on the IMAGE, not just the major. The build stage prunes
    // node_modules down to the binaries that load THERE
    // (scripts/prune-runtime-deps.cjs), so its libc and arch are now the
    // runtime's: a runtime moved to node:<n>-slim (glibc) beside an alpine build
    // stage would boot holding only musl binaries, and a
    // `FROM --platform=$BUILDPLATFORM` build stage would keep the BUILD host's.
    // Comment lines dropped first — the paragraph explaining this names both.
    const fromLines = app.split("\n").filter(l => !/^\s*#/.test(l)).filter(l => /^FROM\s/i.test(l.trim()));
    const imageOf = (l) => l.trim().replace(/^FROM\s+/i, "").replace(/\s+AS\s+\S+\s*$/i, "");
    expect(fromLines.length, "anti-vacuity: the app Dockerfile's two FROM lines").toBe(2);
    expect(fromLines.filter(l => /--platform/i.test(l)),
      "no stage of the app Dockerfile pins --platform: the prune keeps what loads where the build stage RUNS").toEqual([]);
    expect(imageOf(fromLines[0]),
      "the build stage must be the runtime stage's own image — the prune keeps the binaries that load in the build stage")
      .toBe(imageOf(fromLines[1]));

    const ciMajor = (ci.match(/^ARG\s+NODE_MAJOR=(\d+)/m) || [])[1];
    expect(ciMajor, "ci/Dockerfile.cross-browser declares ARG NODE_MAJOR").toBeTruthy();
    expect(ciMajor,
      `CI builds on Node ${ciMajor} but production runs Node ${appMajors[0]}. Bump ARG NODE_MAJOR in ` +
      `ci/Dockerfile.cross-browser, rebuild + push the image, and re-pin its digest in the workflow ` +
      `(ci/README.md). Testing on a Node version production never runs is what this guard exists to stop.`
    ).toBe(appMajors[0]);
  });

  test("v8.13.2: the runtime image carries no npm and takes Alpine's fixes, and every compose build pulls its base", () => {
    // External audit, two container findings.
    //
    // (1) A scanner reported twelve advisories (four high) in npm's OWN bundled
    // dependencies, which the node base ships in /usr/local/lib/node_modules/npm.
    // Nothing at runtime needs npm — the app starts with `node server.js`, the
    // healthcheck is `node -e`, and every dependency is installed in the BUILD
    // stage and copied over — so the final stage deletes it. The deletion must be
    // in the FINAL stage (the build stage needs npm to run `npm ci`) and BEFORE
    // `USER node` (the files are root's).
    //
    // (2) An ordinary `docker compose up --build` on a host with a cached
    // node:<major>-alpine reuses it, shipping an old Node and old Alpine packages
    // (measured: 26.7.0 / 3.24.1 against a current 26.10.0 / 3.24.2). `build.pull:
    // true` makes every compose build fetch the base's current digest. The
    // documented production deploy prunes every unused image first and so was
    // already fresh (verified with a local registry), which is exactly why this
    // must not depend on that one line of somebody's deploy script.
    //
    // (3) A fresh pull still gets only what the official image was last REBUILT
    // with: on release day the current base shipped zlib 1.3.2-r0 while Alpine's
    // security database listed 1.3.2-r1 as the fix. The runtime stage runs
    // `apk upgrade`, before `USER node` for the same reason as the deletion.
    //
    // Comments are stripped first, for both files: the paragraph explaining the
    // deletion names every path it deletes, and the compose comment says "pull".
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const dockerfile = fs.readFileSync(pathMod.join(root, "Dockerfile"), "utf8")
      .split("\n").filter(l => !/^\s*#/.test(l)).join("\n")
      .replace(/\\\n/g, " ");                     // join line continuations
    const lines = dockerfile.split("\n").map(l => l.trim()).filter(Boolean);
    const froms = lines.map((l, i) => /^FROM\s/i.test(l) ? i : -1).filter(i => i >= 0);
    expect(froms.length, "the app Dockerfile is a two-stage build (build + runtime)").toBe(2);
    const finalStage = lines.slice(froms[froms.length - 1]);
    const userAt = finalStage.findIndex(l => /^USER\s+node\b/i.test(l));
    expect(userAt, "the runtime stage drops to the `node` user").toBeGreaterThan(0);
    // The RUN must BE the deletion (`RUN rm -rf …`), and each path a whole
    // token. A substring test passed `RUN true || rm -rf …/npmX` — a mutation that
    // deletes nothing (measured, while writing this lock).
    const tok = (l, p) => new RegExp(`(^|\\s)${p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(\\s|$)`).test(l);
    const rmAt = finalStage.findIndex(l => /^RUN\s+rm\s+-rf\s/i.test(l) && !/[;&|]/.test(l)
      && ["/usr/local/lib/node_modules/npm", "/usr/local/bin/npm", "/usr/local/bin/npx"].every(p => tok(l, p)));
    expect(rmAt,
      "the RUNTIME stage must delete npm and npx (/usr/local/lib/node_modules/npm, /usr/local/bin/npm, " +
      "/usr/local/bin/npx) — nothing at runtime uses them, and a scanner reports npm's bundled " +
      "dependencies against the image").toBeGreaterThan(0);
    expect(rmAt, "the deletion must run BEFORE `USER node`, while the stage is still root").toBeLessThan(userAt);
    // v8.13.4 — the same line deletes the base's compile inputs: Node's, V8's and
    // libuv's C headers plus common.gypi (/usr/local/include/node, 6.6 MiB),
    // which only an addon compile reads. The image's own self-check refuses the
    // directory too (tests/prune-runtime-deps.spec.js holds that RUN).
    expect(tok(finalStage[rmAt], "/usr/local/include/node"),
      "the runtime stage's deletion line also removes /usr/local/include/node — the base image's C headers " +
      "and gyp include files are a build input, and nothing at runtime compiles").toBe(true);
    // v8.13.3 — EXACTLY `RUN apk upgrade --no-cache`. The v8.13.2 form accepted
    // any `RUN apk upgrade…` line, so `--simulate` (reports, changes nothing), a
    // package argument (upgrades that one package) or `--self-upgrade-only`
    // (upgrades apk itself) all passed while Alpine's fixes never arrived —
    // measured, each mutation green against that form.
    const upAt = finalStage.findIndex(l => /^RUN\s+apk\s+upgrade\s+--no-cache\s*$/i.test(l));
    expect(upAt,
      "the RUNTIME stage must apply Alpine's published fixes (`RUN apk upgrade --no-cache`) — a fresh base " +
      "carries only what the official image was last rebuilt with").toBeGreaterThan(0);
    expect(upAt, "`apk upgrade` must run BEFORE `USER node`, while the stage is still root").toBeLessThan(userAt);
    const buildStage = lines.slice(froms[0], froms[1]);
    expect(buildStage.some(l => /\bnpm\s+ci\b/.test(l)),
      "anti-vacuity: the BUILD stage still installs with npm ci (it is what needs npm)").toBe(true);

    const compose = fs.readFileSync(pathMod.join(root, "docker-compose.yml"), "utf8")
      .split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
    const build = compose.match(/^ {4}build:[ \t]*\n((?: {6}.*\n?)+)/m);
    expect(build, "the hackarena service's `build:` must be a mapping (context + pull), not the shorthand `build: .`").toBeTruthy();
    expect(build[1], "compose builds must pull the base image's current digest (`build.pull: true`)")
      .toMatch(/^ {6}pull:\s*true\s*$/m);
    expect(build[1]).toMatch(/^ {6}context:\s*\.\s*$/m);
    expect(compose, "and the image tag the version scripts rewrite is still there")
      .toMatch(/^ {4}image:\s*hackarena:\S+\s*$/m);
  });

  // ── v8.13.3 — the container, its build context and the docs about both ─────
  //
  // Helpers shared by the arms below. A Dockerfile's comment lines are dropped
  // and `\`-continuations joined, exactly as the v8.13.2 arm above does, so a
  // paragraph explaining a rule can never be what satisfies it.
  function _dockerInstructions(text) {
    return text.split("\n").filter(l => !/^\s*#/.test(l)).join("\n")
      .replace(/\\\n/g, " ")
      .split("\n").map(l => l.trim()).filter(Boolean);
  }
  // `COPY [--flag[=value]]… <src>… <dest>` (ADD too) → {flags, sources, dest}.
  // The JSON form `COPY ["a", "b"]` is parsed as JSON; a form neither shape
  // reads returns sources:null, which every caller treats as a FAILURE rather
  // than skipping it — a COPY a lock cannot read is a COPY it cannot vouch for.
  function _parseCopy(line) {
    const m = /^(?:COPY|ADD)\s+(.*)$/i.exec(line);
    if (!m) return null;
    let rest = m[1].trim();
    const flags = {};
    let f;
    while ((f = /^--([a-z-]+)(?:=(\S+))?\s+/i.exec(rest))) {
      flags[f[1].toLowerCase()] = f[2] === undefined ? true : f[2];
      rest = rest.slice(f[0].length);
    }
    let parts;
    if (rest.startsWith("[")) {
      try { parts = JSON.parse(rest); } catch (_) { return { flags, sources: null, dest: null, raw: line }; }
    } else {
      parts = rest.split(/\s+/);
    }
    if (!Array.isArray(parts) || parts.length < 2) return { flags, sources: null, dest: null, raw: line };
    return { flags, sources: parts.slice(0, -1), dest: parts[parts.length - 1], raw: line };
  }

  test("v8.13.3: the runtime image's code tree is root's and readable; `node` owns only DATA_DIR and UPLOADS_DIR", () => {
    // HARDENING (external review). Every runtime-stage COPY carried
    // --chown=node:node and `USER node` came before WORKDIR, so /app, server.js,
    // lib/, routes/, public/ and node_modules/ all belonged to the user the app
    // runs as: a compromised `node` process could rewrite a route or a served
    // script and have the change survive a restart. The app writes only under
    // DATA_DIR and UPLOADS_DIR, so those two directories, and nothing else, go
    // to `node`.
    //
    // THE OBVIOUS FIX CRASH-LOOPS, which is why this lock REQUIRES a mode
    // normalisation instead of forbidding every chmod. A COPY without --chown
    // keeps the BUILD HOST's modes: a checkout made under umask 027 (0640 files)
    // lands as root:root files `node` cannot read, and the container dies on
    // EACCES opening server.js — measured by building that exact variant from a
    // 0640/0750 context. So the code must reach the final stage either from the
    // build stage, after a `RUN chmod -R <safe> <dir>` over the very directory
    // the build stage copied the context into (frontend-independent — the legacy
    // builder rejects --chmod), or through a context COPY carrying a --chmod that
    // grants read to all and write to nobody but the owner. A `chmod -R` in the
    // FINAL stage is refused: it copies every file into a second layer.
    //
    // STATED LIMIT: this reads text. That the built image boots, serves, and
    // refuses writes to /app while DATA_DIR and UPLOADS_DIR stay writable was
    // verified by building and running it (bind-mounted volumes, an unmounted
    // run, and a 0640 build context), which no CI job here does.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const lines = _dockerInstructions(fs.readFileSync(pathMod.join(root, "Dockerfile"), "utf8"));
    const froms = lines.map((l, i) => /^FROM\s/i.test(l) ? i : -1).filter(i => i >= 0);
    expect(froms.length, "the app Dockerfile is a two-stage build (build + runtime)").toBe(2);
    const buildStage = lines.slice(froms[0], froms[1]);
    const finalStage = lines.slice(froms[1]);
    const problems = [];

    // A mode that lets group or other WRITE. An unparseable symbolic clause
    // counts as granting — fail closed on a spelling this cannot read.
    const grantsGroupOtherWrite = (mode) => {
      if (/^[0-7]{3,4}$/.test(mode)) {
        const d = mode.slice(-3);
        return Boolean((Number(d[1]) & 2) || (Number(d[2]) & 2));
      }
      return mode.split(",").some((c) => {
        const m = /^([ugoa]*)([-+=])([rwxXst]*)$/.exec(c);
        if (!m) return true;
        return m[2] !== "-" && /w/.test(m[3]) && (m[1] === "" || /[goa]/.test(m[1]));
      });
    };
    // The spellings accepted as "everyone reads, only the owner writes".
    const SAFE_MODE = /^(?:0?[0-7][45][45]|a\+rX,go-w|u=rwX,go=rX|go=rX|a=rX)$/;

    // (1) No COPY anywhere hands ownership to anybody.
    for (const l of lines) {
      const c = _parseCopy(l);
      if (c && c.flags.chown) problems.push(`a COPY carries --chown, so its files belong to that user: ${l}`);
    }
    // (2) Nothing anywhere grants group/other write.
    for (const l of lines) {
      const c = _parseCopy(l);
      if (c && typeof c.flags.chmod === "string" && grantsGroupOtherWrite(c.flags.chmod)) {
        problems.push(`a COPY --chmod grants group/other write: ${l}`);
      }
      for (const m of l.matchAll(/\bchmod\s+(?:-\w+\s+)*([^\s;&|]+)/g)) {
        if (grantsGroupOtherWrite(m[1])) problems.push(`a chmod grants group/other write: ${l}`);
      }
    }
    // (3) No chmod at all in the FINAL stage (a second copy of every file).
    for (const l of finalStage) {
      if (/\bchmod\b/.test(l) && !/^COPY\s/i.test(l)) problems.push(`a final-stage chmod copies every file it touches into a new layer: ${l}`);
    }
    // (4) A final-stage COPY from the build CONTEXT must normalise its modes.
    const finalCopies = finalStage.map(_parseCopy).filter(Boolean);
    let contextCopies = 0;
    for (const c of finalCopies) {
      if (!c.sources) { problems.push(`a COPY this lock cannot read: ${c.raw}`); continue; }
      if (c.flags.from) continue;
      contextCopies++;
      if (!(typeof c.flags.chmod === "string" && SAFE_MODE.test(c.flags.chmod))) {
        problems.push("a final-stage COPY from the build context keeps the build host's file modes, so a " +
          `0640 checkout crash-loops on EACCES — normalise them (--chmod, or in the build stage): ${c.raw}`);
      }
    }
    // (5) A context MIRROR copied from the build stage must have been normalised
    // there, by a `RUN chmod -R <safe> <dir>` over that same directory, after the
    // COPY that filled it.
    const norm = (p) => String(p).replace(/\/+$/, "");
    const mirrors = buildStage
      .map((l, i) => ({ c: _parseCopy(l), i }))
      .filter(({ c }) => c && c.sources && c.sources.length === 1 && /^\.\/?$/.test(c.sources[0]));
    let mirrorCopies = 0;
    for (const c of finalCopies) {
      if (!c.flags.from || !c.sources) continue;
      const mirror = mirrors.find(({ c: mc }) => norm(c.sources[0]) === norm(mc.dest));
      if (!mirror) continue;          // e.g. node_modules: installed in the container, not copied from the host
      mirrorCopies++;
      const normalised = buildStage.some((l, i) => {
        const m = /^RUN\s+chmod\s+-R\s+(\S+)\s+(\S+)\s*$/.exec(l);
        return m && i > mirror.i && norm(m[2]) === norm(mirror.c.dest) && SAFE_MODE.test(m[1]);
      });
      if (!normalised) {
        problems.push(`the build stage copies the context into ${mirror.c.dest} and never normalises its modes ` +
          `(RUN chmod -R u=rwX,go=rX ${mirror.c.dest}), so the runtime inherits the build host's umask: ${c.raw}`);
      }
    }
    expect(contextCopies + mirrorCopies,
      "anti-vacuity: the app code reaches the runtime stage through one of the two sanctioned routes").toBeGreaterThan(0);

    // (6) WORKDIR /app, and every COPY, before the single `USER node`.
    const users = finalStage.filter(l => /^USER\s/i.test(l));
    expect(users, "the runtime stage switches user exactly once, to `node`").toEqual(["USER node"]);
    const userAt = finalStage.indexOf("USER node");
    const workAt = finalStage.findIndex(l => /^WORKDIR\s+\/app\/?$/i.test(l));
    expect(workAt, "WORKDIR /app runs BEFORE `USER node`, or BuildKit creates /app owned by node").toBeGreaterThan(0);
    expect(workAt).toBeLessThan(userAt);
    finalStage.forEach((l, i) => {
      if (/^(?:COPY|ADD)\s/i.test(l) && i > userAt) problems.push(`a COPY after USER node: ${l}`);
    });

    // (7) The only chown hands exactly DATA_DIR and UPLOADS_DIR to node — no
    // flags (`-R` over /app would undo the whole point), no third target.
    const env = {};
    for (const l of finalStage) {
      const m = /^ENV\s+(\w+)[=\s]+(\S+)\s*$/.exec(l);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    const want = [env.DATA_DIR, env.UPLOADS_DIR];
    expect(want.every(v => typeof v === "string" && /^\/app\/[^/]+\/?$/.test(v)),
      `the runtime stage declares ENV DATA_DIR and UPLOADS_DIR under /app (found ${JSON.stringify(want)})`).toBe(true);
    const wantSet = want.map(v => pathMod.posix.normalize(v).replace(/\/+$/, "")).sort();
    const resolveTarget = (t) => {
      t = t.replace(/^["']|["']$/g, "").replace(/^\$\{?(\w+)\}?$/, (all, n) => (env[n] !== undefined ? env[n] : all));
      return (t.startsWith("/") ? pathMod.posix.normalize(t) : pathMod.posix.join("/app", t)).replace(/\/+$/, "");
    };
    const chowns = [];
    for (const l of finalStage) {
      if (!/^RUN\s/i.test(l)) continue;
      for (const seg of l.replace(/^RUN\s+/i, "").split(/&&|\|\||;/)) {
        const m = /^\s*chown\s+(.*)$/.exec(seg);
        if (m) chowns.push({ l, args: m[1].trim().split(/\s+/) });
      }
    }
    expect(chowns.length, "anti-vacuity: the runtime stage hands its volumes to node with a chown").toBeGreaterThan(0);
    for (const { l, args } of chowns) {
      if (args.some(a => a.startsWith("-"))) problems.push(`a flagged chown (-R …) can hand node more than its two volumes: ${l}`);
      const [owner, ...targets] = args.filter(a => !a.startsWith("-"));
      if (!/^node(?::node)?$/.test(owner || "")) problems.push(`a chown to someone other than node: ${l}`);
      const got = targets.map(resolveTarget).sort();
      if (JSON.stringify(got) !== JSON.stringify(wantSet)) {
        problems.push(`chown targets ${JSON.stringify(got)}, expected exactly DATA_DIR and UPLOADS_DIR ${JSON.stringify(wantSet)}: ${l}`);
      }
    }
    // (8) Before USER node, one RUN creates AND chowns both volumes — or a
    // container run with no volume mounted (and a fresh named volume) has
    // nowhere it can write.
    const prepared = finalStage.slice(0, userAt).some(l =>
      /^RUN\s/i.test(l) && /\bmkdir\s+-p\b/.test(l) && /\bchown\s+node\b/.test(l));
    expect(prepared, "a RUN before `USER node` creates DATA_DIR and UPLOADS_DIR and chowns them to node").toBe(true);

    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("v8.13.3: .dockerignore is an allow-list of exactly what the image runs, so no local backup or test artefact can enter the build context", () => {
    // It was a DENY-list, and a deny-list fails OPEN on whatever nobody listed.
    // Measured with a `FROM scratch; COPY . /ctx` export, it shipped
    // scripts/backup.sh's DEFAULT output — <repo>/backups/<ts>/, inside the
    // checkout the documented deploy builds from, holding the live database and
    // both HMAC secrets — plus smoke-data-*/ (a database and a
    // .superadmin-password), data-harness-*/, uploads-test-worker-*/, .coverage/,
    // a backup tarball, and three engineering docs and ci/ added after the list
    // was written. An allow-list fails CLOSED.
    //
    // THE CLAIM: after `*`, the re-admitted roots EQUAL a set derived from code,
    // in both directions. Derived from: the runtime's own files (server.js,
    // db.js, lib/, routes/); every relative require they make; every
    // path.join(__dirname, "<literals>") they read through; and every
    // build-context COPY source in BOTH Dockerfiles that build from this context
    // (the CI image is built from the repo root too — ci/README.md). A missing
    // root is an image that cannot boot or build; an extra one is a decision
    // nobody took. And no root a .gitignore entry or backup.sh's default output
    // names may be re-admitted.
    //
    // STATED LIMITS: it reads literal paths only, so a runtime read through a
    // computed path is invisible to it (building and booting the image is the
    // backstop, and was done by hand for this release); and a stray file
    // dropped INSIDE public/ or docs/ still ships, both being re-admitted whole.
    //
    // v8.13.4 — ONE sub-path entry is a decision this lock CAN check: a single
    // FILE the app Dockerfile COPYs by that exact path, under a root nothing
    // else needs (scripts/prune-runtime-deps.cjs, a build-stage tool). Deriving
    // the ROOT from that COPY, as before, would demand `!scripts/` — which would
    // ship backup.sh, purge.sh, smoke.cjs and the rest. So such a COPY derives
    // the file itself, and the allow-list may carry exactly that path; a glob,
    // a directory under a root or a file no COPY names is still refused. (The
    // build stage deletes it from /src before the runtime copies the tree;
    // tests/prune-runtime-deps.spec.js holds that.)
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const isFileAt = (rel) => { try { return fs.statSync(pathMod.join(root, rel)).isFile(); } catch (_) { return false; } };
    const appCopyFiles = new Set();
    for (const l of _dockerInstructions(fs.readFileSync(pathMod.join(root, "Dockerfile"), "utf8"))) {
      const c = _parseCopy(l);
      if (!c || c.flags.from || !c.sources) continue;
      for (const s of c.sources) {
        const clean = s.replace(/^\.\//, "");
        if (clean.includes("/") && !/[*?[]/.test(clean) && isFileAt(clean)) appCopyFiles.add(clean);
      }
    }
    const pats = fs.readFileSync(pathMod.join(root, ".dockerignore"), "utf8")
      .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    expect(pats[0], "the first pattern excludes everything (`*`) — an allow-list fails CLOSED on what nobody listed").toBe("*");
    const later = pats.slice(1);
    expect(later.filter(p => !p.startsWith("!")),
      "after `*`, every pattern re-admits a root (`!name`) — a deny line here is a deny-list again").toEqual([]);
    const allowed = later.map(p => p.slice(1).replace(/^\/+|\/+$/g, ""));
    expect(allowed.filter(a => a === "." || a === ".."
      || (!/^[\w.-]+$/.test(a) && !(appCopyFiles.has(a) && /^[\w.-]+(?:\/[\w.-]+)+$/.test(a)))),
      "re-admit whole top-level roots only — a glob, or a sub-path that is not exactly a file the app Dockerfile " +
      "COPYs, is a decision this lock cannot check").toEqual([]);
    const allowSet = new Set(allowed);

    const derived = new Set();
    const unresolved = [];
    const topOf = (abs) => {
      const rel = pathMod.relative(root, abs);
      if (!rel || rel.startsWith("..") || pathMod.isAbsolute(rel)) { unresolved.push(`resolves outside the repo: ${abs}`); return null; }
      return rel.split(pathMod.sep)[0];
    };
    const add = (t) => { if (t) derived.add(t); };
    // `.js` fallback, or `./db` resolves to nothing (measured on the prototype).
    const resolveReq = (abs) => [abs, abs + ".js", abs + ".json", pathMod.join(abs, "index.js")].find(p => fs.existsSync(p));
    const codeFiles = ["server.js", "db.js",
      ...fs.readdirSync(pathMod.join(root, "lib")).filter(f => f.endsWith(".js")).map(f => `lib/${f}`),
      ...fs.readdirSync(pathMod.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`)];
    let requires = 0, dirnameReads = 0;
    for (const rel of codeFiles) {
      const abs = pathMod.join(root, rel);
      add(topOf(abs));
      const src = _stripJsComments(fs.readFileSync(abs, "utf8"));
      // Not preceded by a quote or a backslash: lib/data-dir.js QUOTES a
      // `require('./db')` inside the help text it prints, which is not a require.
      for (const m of src.matchAll(/(?<![\w$."'`\\])require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
        requires++;
        const hit = resolveReq(pathMod.resolve(pathMod.dirname(abs), m[1]));
        if (!hit) unresolved.push(`${rel}: require("${m[1]}") resolves to no file`);
        else add(topOf(hit));
      }
      for (const m of src.matchAll(/path\.(?:join|resolve)\(\s*__dirname\s*((?:,\s*["'][^"']*["']\s*)+)\)/g)) {
        dirnameReads++;
        const segs = [...m[1].matchAll(/["']([^"']*)["']/g)].map(x => x[1]);
        add(topOf(pathMod.resolve(pathMod.dirname(abs), ...segs)));
      }
    }
    expect(requires, "anti-vacuity: the relative-require scan found the runtime's requires").toBeGreaterThan(100);
    expect(dirnameReads, "anti-vacuity: the __dirname scan found public/ and docs/ reads").toBeGreaterThanOrEqual(3);

    const rootEntries = fs.readdirSync(root);
    const globRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$");
    const derivedFromCode = new Set(derived);
    let contextSources = 0, fileSources = 0;
    for (const df of ["Dockerfile", "ci/Dockerfile.cross-browser"]) {
      for (const l of _dockerInstructions(fs.readFileSync(pathMod.join(root, df), "utf8"))) {
        const c = _parseCopy(l);
        if (!c || c.flags.from) continue;
        if (!c.sources) { unresolved.push(`${df}: a COPY this lock cannot read: ${l}`); continue; }
        for (const s of c.sources) {
          const clean = s.replace(/^\.\//, "").replace(/\/+$/, "");
          if (clean === "." || clean === "") continue;   // the whole context — exactly what this file narrows
          contextSources++;
          // v8.13.4 — a single file under a root the runtime does not need: the
          // FILE is what the context must carry, never its whole root.
          if (clean.includes("/") && !/[*?[]/.test(clean) && !derivedFromCode.has(clean.split("/")[0])) {
            if (isFileAt(clean)) { derived.add(clean); fileSources++; }
            else unresolved.push(`${df}: COPY source ${s} is not a regular file in the repo`);
            continue;
          }
          const hits = rootEntries.filter(e => globRe(clean.split("/")[0]).test(e));
          if (!hits.length) unresolved.push(`${df}: COPY source ${s} matches nothing at the repo root`);
          hits.forEach(add);
        }
      }
    }
    expect(contextSources, "anti-vacuity: both Dockerfiles' context COPY sources were read").toBeGreaterThanOrEqual(2);
    expect(unresolved, unresolved.join("\n")).toEqual([]);
    expect(derived.size, "anti-vacuity: the derived runtime set is not trivially small").toBeGreaterThanOrEqual(8);
    for (const must of ["server.js", "db.js", "lib", "routes", "public", "docs", "version.json", "package-lock.json"]) {
      expect(derived.has(must), `anti-vacuity: the derivation finds ${must}`).toBe(true);
    }

    const missing = [...derived].filter(d => !allowSet.has(d)).sort();
    const extra = [...allowSet].filter(a => !derived.has(a)).sort();
    expect(missing, `.dockerignore leaves out roots the image needs (it would fail to build or boot): ${missing.join(", ")}`).toEqual([]);
    expect(extra, `.dockerignore re-admits roots nothing in the image reads: ${extra.join(", ")}`).toEqual([]);

    // THE ARTEFACT GUARANTEE, stated in its own terms. Every root-level
    // .gitignore entry names a local artefact (a database, a test directory, a
    // credential file …), backup.sh's default output directory is another, and
    // so are the concrete names below — none may be re-admitted; and no
    // git-ignored SUB-path may live under a re-admitted root.
    const gi = fs.readFileSync(pathMod.join(root, ".gitignore"), "utf8")
      .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#") && !l.startsWith("!"))
      .map(p => p.replace(/^\/+|\/+$/g, ""));
    const backupDefault = (/\$ROOT_DIR\/([\w-]+)\/\$TIMESTAMP/.exec(
      fs.readFileSync(pathMod.join(root, "scripts", "backup.sh"), "utf8")) || [])[1];
    expect(backupDefault, "anti-vacuity: backup.sh's default output directory was found").toBeTruthy();
    const ARTEFACTS = [
      ...gi.filter(p => !p.includes("/")), backupDefault,
      "smoke-data-prod", "data-test-0", "data-harness-170", "uploads-test-worker-4567", ".coverage",
      ".env", "data", "uploads", "node_modules", ".git", "tests", "perf", "ci",
      "hackathon.db", ".grading-secret", ".unsubscribe-secret", ".superadmin-password",
      "hackarena-backup-20261009T000000Z.tgz",
    ];
    // A sub-path entry is judged by its root too: re-admitting `backups/x.db`
    // admits part of an artefact directory just as `!backups/` would.
    const admitted = ARTEFACTS.filter(a => [...allowSet].some(r => globRe(a).test(r) || globRe(a).test(r.split("/")[0])));
    expect(admitted, `a local artefact would enter the build context: ${admitted.join(", ")}`).toEqual([]);
    const nested = gi.filter(p => p.includes("/") && [...allowSet].some(r => (r.includes("/")
      ? (p === r || p.startsWith(r + "/") || r.startsWith(p + "/"))
      : p.split("/")[0] === r)));
    expect(nested, `a git-ignored path lives under a re-admitted root: ${nested.join(", ")}`).toEqual([]);
    // Anti-vacuity for the single-file admission: the app Dockerfile's one such
    // COPY (the prune script) was derived as a FILE and is admitted as one.
    expect(fileSources, "anti-vacuity: the app Dockerfile copies one build-stage tool by its own path").toBeGreaterThanOrEqual(1);
    expect(allowed.filter(a => a.includes("/")).sort(), "the only sub-path entries are files the app Dockerfile copies")
      .toEqual([...appCopyFiles].filter(f => !derivedFromCode.has(f.split("/")[0])).sort());
  });

  test("v8.13.3: the documented redeploy clears the build cache, and no doc promises that a cache-warm rebuild takes Alpine's fixes", () => {
    // The runtime stage's `RUN apk upgrade --no-cache` is an ordinary BuildKit
    // layer. Its cache key is the base image's digest plus the instruction, and
    // nothing above it changes when the app does, so on an unchanged
    // node:<major>-alpine digest every rebuild reused the FIRST build's upgrade
    // (measured: `docker history` showed one image reusing another's upgrade
    // layer, stamped 1 h 33 min earlier). The documented deploy could not clear
    // it — `docker image prune -a` removes images, not build cache, and
    // `build.pull` only re-checks the base — while README promised that "a scan
    // of an image built TODAY reports neither" and the Dockerfile that its step
    // made "a fresh build scans clean" on any given day.
    //
    // OPERATOR DECISION: fix it in the documented deploy steps, not in compose.
    // So the redeploy recipe must clear the build cache before it builds, and
    // the two overclaims stay retired.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const readme = fs.readFileSync(pathMod.join(root, "README.md"), "utf8");
    const blocks = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map(m => m[1]);
    const redeploys = blocks.filter(b => /docker\s+image\s+prune\s+-f\s+-a/.test(b) && /docker\s+compose\s+up\s+-d/.test(b));
    expect(redeploys.length, "anti-vacuity: README still documents the prune-then-up redeploy").toBeGreaterThan(0);
    for (const b of redeploys) {
      const ls = b.split("\n").map(l => l.replace(/#.*$/, "").trim()).filter(Boolean);
      const upAt = ls.findIndex(l => /docker\s+compose\s+up\s+-d/.test(l));
      const downAt = ls.findIndex(l => /docker\s+compose\s+down\b/.test(l));
      const imagePruneAt = ls.findIndex(l => /docker\s+image\s+prune\s+-f\s+-a/.test(l));
      // An EFFECTIVE clear, not merely a present one (the pre-release review): a
      // plain `docker builder prune` skips any cached layer an existing image still
      // uses (measured: `Shared: true`, 0 B reclaimed, the next build CACHED), so it
      // reaches the `apk upgrade` layer only AFTER `compose down` and `image prune -a`
      // have removed every image built from it. Accepted: a `compose build
      // --no-cache`; a `builder prune` carrying `-a` / `--all`; or a plain `builder
      // prune` that comes after both. Each must still come before `up -d` builds.
      const clearAt = ls.findIndex((l, i) =>
        /docker\s+compose\s+build\b[^\n]*--no-cache\b/.test(l)
        || (/docker\s+builder\s+prune\b/.test(l) && /(?:^|\s)(?:-a\b|--all\b|-[a-z]*a[a-z]*\b)/.test(l.replace(/^.*?prune/, "")))
        || (/docker\s+builder\s+prune\b/.test(l) && downAt >= 0 && i > downAt && imagePruneAt >= 0 && i > imagePruneAt));
      expect(clearAt, "the redeploy recipe clears the build cache EFFECTIVELY — a `docker compose build --no-cache`, " +
        "a `docker builder prune -a`, or a plain `docker builder prune -f` placed AFTER `docker compose down` and " +
        "`docker image prune -f -a` (before them it skips the layer the old image still uses) — or `apk upgrade` is " +
        "served from cache for as long as the base digest stays put:\n" + b).toBeGreaterThanOrEqual(0);
      expect(clearAt, "…and it does so BEFORE `docker compose up -d` builds:\n" + b).toBeLessThan(upAt);
    }
    // The Upgrading section's rebuild runs while the old image still exists, so a
    // plain `builder prune` there clears nothing; it must name an effective form.
    const upgrading = (readme.split(/\n#{2,4} Upgrading\b/)[1] || "").split(/\n#{2,4} /)[0];
    expect(upgrading.length, "anti-vacuity: README's Upgrading section exists").toBeGreaterThan(200);
    expect(upgrading, "Upgrading names a no-cache build for picking up Alpine's fixes").toMatch(/compose build --no-cache/);
    expect(upgrading, "…and does not tell the operator a plain `builder prune -f` before the rebuild does it")
      .not.toMatch(/clear the cache first \(`sudo docker builder prune -f`\)/);
    expect(readme, "README must not promise that an image built today scans clean").not.toMatch(/built TODAY reports neither/i);
    expect(readme, "nor tell an operator that a plain rebuild fixes an OS finding").not.toMatch(/the image is older than that fix/i);
    const scan = (readme.split("**Scanning the container image.**")[1] || "").split("\n\n")[0];
    expect(scan.length, "anti-vacuity: README's 'Scanning the container image' paragraph exists").toBeGreaterThan(200);
    expect(scan, "that paragraph says the Alpine fixes ride a cached build layer").toMatch(/build cache/i);

    // The Dockerfile WITH its comments, continuation lines joined — this arm is
    // about what a comment claims, unlike every other Dockerfile arm here.
    const dockerRaw = fs.readFileSync(pathMod.join(root, "Dockerfile"), "utf8");
    expect(dockerRaw.replace(/\n[ \t]*#[ \t]?/g, " "),
      "the Dockerfile comment must not claim its apk step makes any fresh build scan clean").not.toMatch(/scans clean[\s\S]{0,40}any given day/i);
    // WITNESS: the step this is all about is still there, exactly.
    expect(_dockerInstructions(dockerRaw).some(l => /^RUN\s+apk\s+upgrade\s+--no-cache\s*$/i.test(l)),
      "the runtime stage still runs `RUN apk upgrade --no-cache`").toBe(true);
  });

  test("v9.2.9 (sweep #128): the documented redeploy builds before anything stops the old container, says how to re-pin the toolchain, and the pin stays", () => {
    // `node:<major>-alpine` floats and every build pulls it, while the build
    // stage pins its toolchain to one Alpine branch (KICS). A branch move fails
    // that line; with `compose down` first, the redeploy was an outage until
    // someone re-pinned. Now the recipe builds first and swaps after.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const readme = fs.readFileSync(pathMod.join(root, "README.md"), "utf8");
    const docker = (readme.split(/\n### Docker\n/)[1] || "").split(/\n### /)[0];
    expect(docker.length, "anti-vacuity: README's Docker section exists").toBeGreaterThan(2000);
    const order = (block) => {
      const ls = block.split("\n").map(l => l.replace(/#.*$/, "").trim()).filter(Boolean);
      const at = (re) => ls.findIndex(l => re.test(l));
      return {
        build: at(/docker\s+compose\s+build\b.*--no-cache\b/),
        up: at(/docker\s+compose\s+up\s+-d\b/),
        stop: at(/docker\s+compose\s+(?:down|stop|rm|kill)\b|docker\s+(?:stop|rm|kill|container\s+rm)\b/),
        prune: at(/docker\s+image\s+prune\b/),
        upLine: ls[at(/docker\s+compose\s+up\s+-d\b/)] || "",
      };
    };
    const ok = (o) => o.build >= 0 && o.build < o.up && (o.stop === -1 || o.stop > o.build)
      && /--no-build\b/.test(o.upLine) && o.prune > o.up;
    // CONTROL: the checker refuses the retired down-first recipe.
    expect(ok(order("sudo docker compose down\ngit pull\nsudo docker image prune -f -a\nsudo docker compose up -d\n")),
      "CONTROL: the old down-first recipe is refused").toBe(false);
    const blocks = [...docker.matchAll(/```bash\n([\s\S]*?)```/g)].map(m => m[1])
      .filter(b => /docker\s+compose\s+up\s+-d\b/.test(b) && /docker\s+image\s+prune\b/.test(b));
    expect(blocks.length, "anti-vacuity: the redeploy recipe is found").toBeGreaterThanOrEqual(1);
    for (const b of blocks) {
      const o = order(b);
      expect(o.build, `a no-cache build, before the swap:\n${b}`).toBeGreaterThanOrEqual(0);
      expect(o.build, `…before \`up\`:\n${b}`).toBeLessThan(o.up);
      expect(o.stop === -1 || o.stop > o.build, `nothing stops the old container before the build:\n${b}`).toBe(true);
      expect(o.upLine, "`up` starts the image just built").toMatch(/--no-build\b/);
      expect(o.prune, `the image prune comes after \`up\` (before it, it deletes the new image):\n${b}`).toBeGreaterThan(o.up);
    }
    expect(docker, "the re-pin remedy is documented").toMatch(/apk update[^\n`]*apk policy python3 make g\+\+/);
    expect(docker, "…with the error it answers").toMatch(/unable to select packages/);
    // The KICS pin stays: one `apk add`, exactly python3, make and g++, each `~=`.
    const apkAdd = _dockerInstructions(fs.readFileSync(pathMod.join(root, "Dockerfile"), "utf8")).filter(l => /^RUN\s+apk\s+add\b/i.test(l));
    expect(apkAdd.length, "one `apk add` in the Dockerfile").toBe(1);
    const pkgs = apkAdd[0].replace(/^RUN\s+apk\s+add\s+/i, "").split(/\s+/).filter(t => t && !t.startsWith("-"));
    expect(pkgs.map(t => t.replace(/~=.*$/, "")).sort(), "the toolchain").toEqual(["g++", "make", "python3"]);
    for (const t of pkgs) expect(t, "each pinned with `~=`").toMatch(/^[a-z0-9+._-]+~=\d+(\.\d+)+$/);
  });

  test("v8.13.3: infra comments and docs no longer state the claims this release retired", () => {
    // Each row is a sentence that was TRUE once and false at v8.13.2, found by an
    // audit of the container and CI files (a count in prose; a fallback deleted
    // two releases earlier; a rationale whose mechanism no longer runs). Each
    // carries the fact that retired it as a WITNESS, so the row fails loudly if
    // the code moves back — rather than forbidding a sentence that has become
    // true again.
    //
    // Narrow by design: every pattern is the retired SHAPE, checked against the
    // surviving historical prose (e.g. the workflow's past-tense "failed all 8
    // [firefox] smoke tests" and "14 of ~1,450 tests" must NOT match). Comment
    // continuations are joined first, because three of these phrases wrap a
    // line and are invisible to a single-line grep (measured).
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const read = (rel) => fs.readFileSync(pathMod.join(root, rel), "utf8");
    const joined = (t) => t.replace(/\n[ \t]*(?:#|\/\/|\*(?!\/))[ \t]?/g, " ");
    const flat = (t) => t.replace(/\s+/g, " ");
    const raw = (t) => t;
    // Workflow COMMENT text only: a non-comment line is a paragraph break, so a
    // phrase never straddles a step.
    const ymlComments = (t) => t.split("\n").map(l => (/^\s*#/.test(l) ? l.replace(/^\s*#\s?/, "") : "\n")).join(" ");
    const WF = ".github/workflows/checkmarx.yml";
    const ROWS = [
      ["lib/csv.js", joined, /still\s+opts\s+OUT/i, "the participants export neutralises every column but Phone (v8.3.17 F2)"],
      ["public/js/ui/csv.js", joined, /must not neutralise passes\s+`?\{\s*neutralise\s*:\s*false\s*\}`?/i, "nothing passes a whole-table opt-out; Phone is exempted per column"],
      ["public/js/ui/csv.js", joined, /\b(?:two|three|four)\s+(?:downloads|CSVs)\b/i, "a count of the admin panel's CSVs (there are five) — do not reinstate one"],
      ["Dockerfile", joined, /keeps its own default in lib\/config/i, "UPLOADS_DIR is REQUIRED since v8.8.27"],
      ["Dockerfile", joined, /prebuilt binaries for glibc only/i, "both native deps ship musl prebuilds"],
      ["Dockerfile", joined, /compile against the toolchain above/i, "neither native dep compiles on alpine x64/arm64"],
      ["Dockerfile", joined, /build-base = make/i, "the RUN installs python3 make g++, not build-base"],
      ["lib/config.js", joined, /data-dir fallback|default repo-root\/uploads/i, "DATA_DIR and UPLOADS_DIR have no fallback (v8.8.26/27)"],
      // v8.13.4 — RE-POINTED, not deleted. It used to forbid "exactly like
      // server.js", false while this script fell back to <repo>/data; since the
      // script now REFUSES too, that phrase is no longer a false claim, so the
      // row forbids the retired fallback sentences instead (witness below).
      ["scripts/backup.sh", joined, /otherwise <repo>\/data|else <repo>\/data|names the right\s+volume there|a fallback the server itself\s+does not have/i, "backup.sh and purge.sh REFUSE without DATA_DIR (v8.13.4) — no <repo>/data fallback is left to describe"],
      ["scripts/backup.sh", joined, /writes to \.\/backups\//i, "the default output is $ROOT_DIR/backups, not the cwd"],
      // rsync exit 24 (a file deleted mid-copy) no longer aborts the backup: the
      // attachment reconcile decides completeness (witness below).
      ["scripts/backup.sh", joined, /rsync exits? 24[^.]*(?:abort|never reaches)/i, "backup.sh tolerates rsync exit 24 and reconciles the snapshot's attachment rows instead"],
      ["ci/Dockerfile.cross-browser", joined, /CI image for the cross-browser smoke/i, "the image serves three jobs"],
      ["ci/Dockerfile.cross-browser", joined, /compile for the right Node ABI/i, "both native deps load prebuilds"],
      ["ci/Dockerfile.cross-browser", joined, /package-lock\.json OR the Playwright\s+version changes/i, "omits the third rebuild trigger, production's Node major"],
      ["ci/README.md", raw, /^That job runs on a hardened/m, "three jobs run on that runner"],
      ["ci/README.md", raw, /^# CI: pre-baked cross-browser image/m, "the image serves three jobs"],
      [WF, ymlComments, /\b\d+\s+(?:browser\s+)?projects\b/i, "a count of browser projects"],
      [WF, ymlComments, /\bother\s+\d+\s+projects\b/i, "a count of browser projects"],
      [WF, ymlComments, /~\d+\s+non-default/i, "a count of browser projects"],
      [WF, ymlComments, /\b\d+\s+tests\s+per\s+project\b/i, "a count of cross-browser tests"],
      [WF, ymlComments, /\(\d+\s+captures\)/i, "a count of guide captures"],
      [WF, ymlComments, /\b\d+\s+heavy\s+UI\s+tests\b/i, "a count of guide captures"],
      [WF, ymlComments, /\b\d+-of-\d+\s+PNG churn/i, "a count of screenshots"],
      [WF, ymlComments, /two mobile profiles/i, "the CROSS_BROWSER matrix is far wider"],
      [WF, ymlComments, /both jobs must succeed/i, "the workflow runs four jobs"],
      [WF, ymlComments, /crash probe writes a\s+proof-of-life marker/i, "the probe has not been loaded since v7.15.30"],
      [WF, ymlComments, /package-lock\.json or the Playwright\s+version changes/i, "omits the third rebuild trigger, production's Node major"],
      ["README.md", flat, /Deploying it directly with `TRUST_PROXY=true` lets any client spoof their IP/, "implies `true` is safe behind a proxy; behind an appending one it is not"],
      ["README.md", flat, /`true` \(trust all proxies\)/, "`true` makes req.ip the client-written leftmost X-Forwarded-For entry"],
      ["README.md", flat, /The server logs a warning \(capped at one line a minute\) when `X-Forwarded-For` carries more hops than `TRUST_PROXY` trusts/, "the hop warning needs a numeric TRUST_PROXY"],
      ["README.md", flat, /atomically via `npm run bump`/, "bump-version.js writes its four files one after another"],
      ["README.md", flat, /rsync exits 24 when a file vanishes/i, "backup.sh tolerates rsync exit 24 and reconciles the snapshot's attachment rows instead"],
      // v9.2.9 (sweep #128) — the redeploy builds before it swaps (witness: the
      // v9.2.9 redeploy-order test below).
      ["CLAUDE.md", flat, /documented redeploy takes the old container down first/i, "v9.2.9: the redeploy builds before it swaps"],
      ["scripts/prune-runtime-deps.cjs", joined, /documented redeploy runs `down` first/i, "v9.2.9: the redeploy builds before it swaps"],
      ["docker-compose.yml", joined, /documented redeploy runs `docker builder prune -f` first/i, "v9.2.9: the redeploy builds before it swaps"],
      ["Dockerfile", joined, /redeploy recipe prunes the images first/i, "v9.2.9: the redeploy builds before it swaps"],
      ["README.md", flat, /Because `down` runs first/i, "v9.2.9: the redeploy builds before it swaps"],
    ];
    const hits = [];
    for (const [rel, view, re, why] of ROWS) {
      if (re.test(view(read(rel)))) hits.push(`${rel}: ${re} — retired: ${why}`);
    }
    expect(hits, "retired claims are back:\n" + hits.join("\n")).toEqual([]);

    // WITNESSES — the facts that retired each row still hold.
    const strip = (rel) => _stripJsComments(read(rel));
    expect(strip("public/js/features/export-import.js"),
      "the participants export still exempts Phone by header label").toMatch(/exemptColumns:\s*\[\s*['"]Phone['"]\s*\]/);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(pathMod.join(d, e.name)) : (e.name.endsWith(".js") ? [pathMod.join(d, e.name)] : []));
    const wholeTable = walk(pathMod.join(root, "public", "js"))
      .filter(f => !f.endsWith(pathMod.join("ui", "csv.js")))
      .filter(f => /neutralise\s*:\s*false/.test(_stripJsComments(fs.readFileSync(f, "utf8"))))
      .map(f => pathMod.relative(root, f));
    expect(wholeTable, "a download opts a whole table out of formula neutralisation again — the csv.js docstring must say so").toEqual([]);
    const dataDir = read("lib/data-dir.js");
    for (const fn of ["requireDataDir", "requireUploadsDir"]) {
      const body = (new RegExp(`function ${fn}\\(\\)\\s*\\{([\\s\\S]*?)\\n\\}`).exec(dataDir) || [])[1] || "";
      expect(body, `lib/data-dir.js ${fn}() still refuses (process.exit(1)) — the fact that retired the fallback comments`).toMatch(/process\.exit\(1\)/);
    }
    // v8.13.4 — the backup.sh row's fact, for BOTH operator scripts, read from
    // CODE (whole-line shell comments dropped, since the headers narrate the
    // retired fallback): no parameter-expansion default for DATA_DIR, and an
    // unset/empty refusal whose branch exits non-zero — or a `${DATA_DIR:?}`.
    for (const rel of ["scripts/backup.sh", "scripts/purge.sh"]) {
      const code = read(rel).split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
      expect(code, `${rel} gives DATA_DIR no default — the fact that retired the fallback sentence`).not.toMatch(/\$\{DATA_DIR:?[-=][^}]/);
      const z = code.search(/-z\s+"\$\{DATA_DIR:-\}"/);
      const branch = z < 0 ? "" : code.slice(z, code.indexOf("\nfi", z));
      expect(/\n\s*exit [1-9]/.test(branch) || /\$\{DATA_DIR:\?/.test(code),
        `${rel} refuses an unset or empty DATA_DIR and exits non-zero`).toBe(true);
    }
    // The exit-24 rows' fact: the copy helper returns 0 for exactly that status.
    const copyTree = (/^_copy_tree\(\) \{([\s\S]*?)^\}/m.exec(require("./doc-registry").stripShellComments(read("scripts/backup.sh"))) || [])[1] || "";
    expect(copyTree, "backup.sh's _copy_tree still tolerates rsync exit 24 — the fact that retired the 'exit 24 aborts' sentences")
      .toMatch(/if \[\[ "\$rc" -eq 24 \]\]; then[\s\S]*?return 0\n\s*fi\n\s*return "\$rc"/);
    expect(fs.existsSync(pathMod.join(root, "node_modules", "better-sqlite3", "prebuilds", "linuxmusl-x64.node")),
      "better-sqlite3 still ships a musl prebuild — if this fails, the 'compiles on alpine' sentence may be true again").toBe(true);
    const wf = read(WF);
    expect((wf.match(/^\s*image:\s*mpogr\/hackarena-ci@sha256:/gm) || []).length,
      "the CI image still serves several jobs (the comment is wrong only while it does)").toBeGreaterThanOrEqual(3);
    const wfCode = wf.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
    expect(wfCode, "no job loads the crash probe — the always() rationale must not say it does").not.toMatch(/NODE_OPTIONS|_worker-crash-probe/);
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["test:cross"], "test:cross runs both cross specs — the fact the deleted counts misdescribed")
      .toMatch(/cross-browser\.spec\.js[\s\S]*cross-device\.spec\.js/);
    const readmeFlat = flat(read("README.md"));
    expect(readmeFlat, "README states what `TRUST_PROXY=true` really does").toMatch(/leftmost `X-Forwarded-For`/);
    expect(readmeFlat).toMatch(/proxy that \*overwrites\* the header/);
  });

  test("v8.13.3: infra comments cite spec files, scripts and test titles that exist", () => {
    // ci/Dockerfile.cross-browser cited a test titled "CI Node major matches
    // production" in functional-core.api.spec.js — a file the v7.21.35 split
    // deleted, under a title no spec declares. A citation nobody can open is a
    // claim, not a pointer (the CLAUDE.md rule, one directory over).
    //
    // Scope: the container and CI files (docker-compose.yml included — its
    // `scripts/bump-version.sh` citation was the stale one, now
    // scripts/bump-version.js) and scripts/*.sh. The title check is scoped to ci/*, where the `A test ("…")` idiom is used:
    // the workflow QUOTES an old job name in prose, which is not a citation.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const FILES = ["Dockerfile", ".dockerignore", "docker-compose.yml",
      ...fs.readdirSync(pathMod.join(root, "ci")).map(f => `ci/${f}`),
      ...fs.readdirSync(pathMod.join(root, ".github", "workflows")).filter(f => /\.ya?ml$/.test(f)).map(f => `.github/workflows/${f}`),
      ...fs.readdirSync(pathMod.join(root, "scripts")).filter(f => f.endsWith(".sh")).map(f => `scripts/${f}`)];
    const testsDir = pathMod.join(root, "tests");
    const bad = [];
    let specCites = 0, scriptCites = 0, titleCites = 0;
    for (const rel of FILES) {
      const t = fs.readFileSync(pathMod.join(root, rel), "utf8");
      for (const m of t.matchAll(/\b([\w-]+(?:\.api)?\.spec\.js)\b/g)) {
        specCites++;
        if (!fs.existsSync(pathMod.join(testsDir, m[1]))) bad.push(`${rel}: cites ${m[1]}, which is not in tests/`);
      }
      for (const m of t.matchAll(/\b(scripts|tests)\/([\w.-]+\.(?:sh|js|cjs))\b/g)) {
        scriptCites++;
        if (!fs.existsSync(pathMod.join(root, m[1], m[2]))) bad.push(`${rel}: cites ${m[1]}/${m[2]}, which does not exist`);
      }
    }
    // Titles: every test( / test.describe( title in tests/*.spec.js, whitespace normalised.
    const declared = new Set();
    for (const f of fs.readdirSync(testsDir).filter(x => x.endsWith(".spec.js"))) {
      const src = fs.readFileSync(pathMod.join(testsDir, f), "utf8");
      for (const m of src.matchAll(/\btest(?:\.describe)?(?:\.\w+)?\(\s*(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g)) {
        declared.add(m[2].replace(/\\(.)/g, "$1").replace(/\s+/g, " ").trim());
      }
    }
    expect(declared.size, "anti-vacuity: test titles were extracted").toBeGreaterThan(1000);
    for (const rel of FILES.filter(f => f.startsWith("ci/"))) {
      const t = fs.readFileSync(pathMod.join(root, rel), "utf8").replace(/\n[ \t]*#[ \t]?/g, " ").replace(/\s+/g, " ");
      for (const m of t.matchAll(/\bA test\b[^"]{0,12}"([^"]{12,})"/g)) {
        titleCites++;
        if (!declared.has(m[1].trim())) bad.push(`${rel}: cites a test titled "${m[1]}", which no spec declares`);
      }
    }
    expect(specCites, "anti-vacuity: spec-file citations were found").toBeGreaterThanOrEqual(5);
    expect(scriptCites, "anti-vacuity: scripts/ and tests/ citations were found").toBeGreaterThanOrEqual(3);
    expect(titleCites, "anti-vacuity: the ci/ test-title citations were found").toBeGreaterThanOrEqual(2);
    expect(bad, bad.join("\n")).toEqual([]);
  });

  test("v8.13.3: scripts/watch-metrics.sh refuses to guess the server or its credential file", () => {
    // It defaulted BASE_URL to http://localhost:3000 and read
    // data/.superadmin-password relative to the cwd — the "guessed path reads
    // the live credential" class v8.8.27 removed from perf/config.js. From a
    // developer's checkout both guesses named the operator's own dev instance.
    // Driven for real (the refusals run before any request), in a throw-away
    // cwd that DOES hold data/.superadmin-password, so the second arm proves the
    // cwd-relative read is gone rather than merely unreached.
    //
    // `curl` is a STUB on PATH that records its arguments and fails, and that is
    // not tidiness: the first draft of this lock let the real curl run, so the
    // mutation restoring the old script sent a superadmin login with the decoy
    // password to whatever listened on localhost:3000 — a developer's dev
    // instance (measured: it did). A lock must never be able to reach the
    // server its subject was guessing. The stub also lets the refusals be
    // asserted as "before any request", which is the script's own claim.
    const fs = require("fs"), os = require("os"), pathMod = require("path");
    const { spawnSync } = require("child_process");
    const script = pathMod.join(__dirname, "..", "scripts", "watch-metrics.sh");
    const cwd = fs.mkdtempSync(pathMod.join(os.tmpdir(), "watch-metrics-"));
    try {
      fs.mkdirSync(pathMod.join(cwd, "data"));
      fs.writeFileSync(pathMod.join(cwd, "data", ".superadmin-password"), "decoy-password\n");
      const bin = pathMod.join(cwd, "bin");
      fs.mkdirSync(bin);
      const calls = pathMod.join(cwd, "curl-calls.log");
      fs.writeFileSync(pathMod.join(bin, "curl"), `#!/bin/sh\necho "$*" >> '${calls}'\nexit 7\n`, { mode: 0o755 });
      const curlCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean) : []);
      const base = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME || cwd };
      const run = (env) => {
        if (fs.existsSync(calls)) fs.rmSync(calls);
        return spawnSync("bash", [script], { cwd, env: { ...base, ...env }, encoding: "utf8", timeout: 20000 });
      };

      const noUrl = run({});
      expect(noUrl.status, "no BASE_URL → refused").toBe(1);
      expect(noUrl.stderr).toMatch(/BASE_URL is required/);
      expect(curlCalls(), "…before any request is sent").toEqual([]);

      const noPass = run({ BASE_URL: "http://127.0.0.1:1" });
      expect(noPass.status, "no SUPERADMIN_PASSWORD and no DATA_DIR → refused, though ./data holds a password file").toBe(1);
      expect(noPass.stderr).toMatch(/superadmin password not provided/);
      expect(noPass.stderr).toMatch(/DATA_DIR/);
      expect(curlCalls(), "…before any request is sent").toEqual([]);

      // CONTROL: a DATA_DIR the caller named IS read — so the refusal above is
      // the guess being gone, not the script refusing everything. It then makes
      // its first request, to the named server only, which the stub fails.
      const named = run({ BASE_URL: "http://127.0.0.1:1", DATA_DIR: pathMod.join(cwd, "data") });
      expect(named.stderr, named.stderr).not.toMatch(/superadmin password not provided|BASE_URL is required/);
      expect(named.stderr).toMatch(/initial login failed|couldn't fetch CSRF token/);
      expect(named.status).toBe(1);
      const made = curlCalls();
      expect(made.length, "the control reached the login step").toBeGreaterThan(0);
      expect(made.every(c => c.includes("http://127.0.0.1:1/")), `…and asked only the named server: ${made.join(" | ")}`).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("v7.15.27: the test server env is hermetic — no new var may leak from the shell", () => {
    // 25 of the 40 env vars this app reads used to be inherited from whatever
    // shell ran the suite. That is how local and CI diverge silently, and it is
    // the same defect class as the BASE_URL worker crash: the failure shows up
    // as an unexplained CI result, never as anything you can see locally.
    //
    // This fails when a NEW process.env read is added to the app without either
    // pinning it in playwright.config.js or listing it below as deliberately
    // inheritable. Clear a failure by making that choice explicitly.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const files = [pathMod.join(root, "server.js"), pathMod.join(root, "db.js")];
    for (const d of ["lib", "routes"]) {
      for (const f of fs.readdirSync(pathMod.join(root, d))) {
        if (f.endsWith(".js")) files.push(pathMod.join(root, d, f));
      }
    }
    const read = new Set();
    for (const f of files) {
      for (const m of fs.readFileSync(f, "utf8").matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) read.add(m[1]);
    }
    // v7.20.0 — the pinned env moved out of playwright.config.js into
    // tests/server-env.js when per-file isolation needed to spawn the same
    // server from the test process. Read BOTH, so the invariant holds wherever
    // a future pin is written rather than silently going dark if it moves again.
    const cfg = fs.readFileSync(pathMod.join(root, "playwright.config.js"), "utf8")
      + fs.readFileSync(pathMod.join(root, "tests", "server-env.js"), "utf8");

    // Deliberately inheritable, each for a stated reason.
    const INHERITABLE = new Set([
      "MINIFY_JS",              // documented prod-parity run: MINIFY_JS=1 npm test
      "NODE_ENV",               // set by the config itself
      "PORT", "DATA_DIR", "UPLOADS_DIR", "BASE_URL", "SMTP_HOST", "RATE_LIMIT_DISABLED", // set on the webServer command line
      "SUPERADMIN_PASSWORD_QUIET", // quieting the boot banner cannot change behaviour
      "LOG_DIR", "LOG_CONSOLE_MIRROR", "LOG_DISABLE_ACCESS", // log plumbing; several tests drive these directly
      "CI", "TZ",               // provided by the environment on purpose
    ]);
    const leaking = [...read].filter(v => !INHERITABLE.has(v) && !cfg.includes(v)).sort();
    expect(leaking,
      "these env vars are read by the app but neither pinned in tests/server-env.js nor listed as " +
      "deliberately inheritable, so a developer's shell can change what the suite tests:\n  " +
      leaking.join("\n  ")
    ).toEqual([]);
  });

  test("v7.15.26: the test worker does not depend on a developer's shell env", () => {
    // Specs that `require()` an app module (lib/attachments, lib/http,
    // lib/cxone, lib/event-retention …) pull in lib/config.js, which runs its
    // boot check AT MODULE LOAD and process.exit(1)s when BASE_URL is unset.
    // In a Playwright worker that is fatal and invisible — the run reports only
    // "worker process exited unexpectedly (code=1, signal=null)" and every
    // other test on that worker fails as collateral, with no stack anywhere.
    //
    // The suite passed locally purely because the developer's shell exported
    // BASE_URL, so CI failed while local was green and the cause took several
    // round trips to find. playwright.config.js now defaults it. This asserts
    // the config does that, so nobody removes the line as redundant — it looks
    // redundant on precisely the machines where it is not needed.
    const fs = require("fs"), pathMod = require("path");
    const cfg = fs.readFileSync(pathMod.join(__dirname, "..", "playwright.config.js"), "utf8");
    expect(cfg,
      "playwright.config.js must default process.env.BASE_URL so an in-worker require() of an " +
      "app module cannot exit the worker on a machine that does not export it"
    ).toMatch(/process\.env\.BASE_URL\s*=\s*process\.env\.BASE_URL\s*\|\|/);
    // And the variable really is present by the time a spec runs.
    expect(process.env.BASE_URL, "BASE_URL is set for the worker itself").toBeTruthy();
  });

  test("v8.12.6: the test worker's DATA_DIR and UPLOADS_DIR are pinned, never inherited from the shell", () => {
    // v8.8.24 pinned the worker's DATA_DIR with `process.env.DATA_DIR || <dir>`,
    // and the operator's shell EXPORTS DATA_DIR for the dev instance — so the
    // pin deferred to exactly the value it existed to keep out, and test output
    // (and in-test requires of db-reaching lib/ modules, which open the database
    // and run migrations at require time) reached the live dev data directory.
    // The assignment must be unconditional. Comments are stripped first: the
    // note explaining the fix quotes the `||` shape it forbids.
    const fs = require("fs"), pathMod = require("path");
    const raw = fs.readFileSync(pathMod.join(__dirname, "..", "playwright.config.js"), "utf8");
    const cfg = raw.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    for (const v of ["DATA_DIR", "UPLOADS_DIR"]) {
      const assigns = cfg.match(new RegExp("process\\.env\\." + v + "\\s*=\\s*[^;]+;", "g")) || [];
      expect(assigns.length, `playwright.config.js must assign process.env.${v} exactly once`).toBe(1);
      expect(assigns[0], `the worker's ${v} must not defer to an exported ${v} (it points at the dev instance on the operator's machine)`)
        .not.toMatch(new RegExp("process\\.env\\." + v + "\\s*(\\|\\||\\?\\?)"));
    }
    // And behaviourally: whatever this worker holds now lives inside the repo
    // (a spec may re-point it at its own per-file server's directory, which is
    // still under the repo), never at an operator's exported path.
    //
    // v8.12.6 (review fix) — "inside the repo" is NOT "not the dev instance":
    // `npm start` / `npm run dev` default to `./data` and `./uploads`, which ARE
    // inside the repo, so a pin re-pointed at `path.join(__dirname, "data")` —
    // one unconditional assignment, no fallback — passed both halves above while
    // every in-process require of a db-reaching lib/ module opened the dev
    // database and ran its migrations. So the directory must also be one only the
    // harness makes (`data-test-worker-*`, or `data-test-*` when a spec
    // re-points it at its per-file server's directory — trusted-networks,
    // completion-credential), and must not RESOLVE to the dev defaults through a
    // symlink either (`path.resolve` does not follow one; `realpath` does).
    const root = pathMod.resolve(__dirname, "..");
    const real = (x) => { try { return fs.realpathSync(x); } catch { return pathMod.resolve(x); } };
    for (const [v, prefix, devDefault] of [["DATA_DIR", "data-test-", "data"], ["UPLOADS_DIR", "uploads-test-", "uploads"]]) {
      const value = pathMod.resolve(process.env[v] || "");
      expect(value, `the worker's ${v} is inside the repo`).toMatch(new RegExp("^" + root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/"));
      expect(pathMod.basename(value), `the worker's ${v} (${value}) is a harness scratch directory, not the dev instance's`)
        .toMatch(new RegExp("^" + prefix));
      const dev = pathMod.join(root, devDefault);
      expect(value, `the worker's ${v} is not the npm start/dev default ./${devDefault}`).not.toBe(dev);
      if (fs.existsSync(dev)) {
        expect(real(value), `the worker's ${v} does not resolve (through a symlink) to ./${devDefault}`).not.toBe(real(dev));
      }
    }
  });

  test("v7.15.18: every CI job uses the org runner and is gateable", () => {
    // A job added with `runs-on: ubuntu-latest` broke CI outright — the org only
    // permits its own private runners. `cx-private-ubuntu-latest-hardened` was
    // then tried and is worse than wrong: it is a VALID label that no runner
    // answers, so jobs sit queued for ever rather than failing fast.
    // `cx-private-ubuntu-x64` is the label with runners actually attached, and
    // the only one proven in this repo.
    //
    // And a job whose `name` differs from its job id cannot be selected as a
    // required status check, so it can never gate a merge — which for a test
    // job defeats the point of having it.
    //
    // Both are one-line mistakes that pass YAML validation and every test, so
    // they get a mechanical check rather than a comment.
    const fs = require("fs"), pathMod = require("path");
    const dir = pathMod.join(__dirname, "..", ".github", "workflows");
    const RUNNER = "cx-private-ubuntu-x64";
    const bad = [];
    for (const f of fs.readdirSync(dir).filter(x => /\.ya?ml$/.test(x))) {
      const src = fs.readFileSync(pathMod.join(dir, f), "utf8");
      for (const m of src.matchAll(/^\s*runs-on:\s*(\S+)/gm)) {
        if (m[1] !== RUNNER) bad.push(`${f}: runs-on: ${m[1]}`);
      }
      // job id -> name, for top-level jobs (2-space indent under `jobs:`)
      const jobs = [...src.matchAll(/^ {2}([a-z0-9][a-z0-9-]*):\s*$/gm)]
        .filter(m => src.slice(0, m.index).includes("\njobs:"));
      for (const j of jobs) {
        const body = src.slice(j.index, j.index + 600);
        const nm = body.match(/^\s{4}name:\s*(.+)$/m);
        if (nm && nm[1].trim() !== j[1]) bad.push(`${f}: job "${j[1]}" has name "${nm[1].trim()}" — a required-status-check context keyed on the job id will never match it`);
      }
    }
    expect(bad,
      `every CI job must use \`runs-on: ${RUNNER}\` — it is the only label in this org ` +
      `with runners attached; others either fail immediately or queue for ever — and set ` +
      `\`name\` equal to its job id (so branch protection can require it):\n  ` + bad.join("\n  ")
    ).toEqual([]);
  });

  test("v7.16.3: each guide illustrates the alert with ITS OWN audience's view", () => {
    // The IP-ban modal differs by one control: "dismiss for everyone" is
    // superadmin-only. v7.16.2 shipped the SUPERADMIN capture in admin.md, so
    // the guide read by regular admins showed them a button they do not have.
    // Nothing catches that but looking — hence this.
    const fs = require("fs"), pathMod = require("path");
    const g = (f) => fs.readFileSync(pathMod.join(__dirname, "..", "docs", "user-guide", f), "utf8");
    const admin = g("admin.md"), superadmin = g("superadmin.md");
    expect(admin, "admin.md must use the REGULAR-admin capture (single Dismiss button)")
      .toContain("38-ip-ban-alert-admin.png");
    expect(admin, "admin.md must NOT use the superadmin capture — it shows a control regular admins never see")
      .not.toContain("/37-ip-ban-alert.png");
    expect(superadmin, "superadmin.md must use the capture that shows the dismiss-for-everyone button")
      .toContain("37-ip-ban-alert.png");
    for (const shot of ["37-ip-ban-alert", "38-ip-ban-alert-admin"]) {
      for (const variant of [`${shot}.png`, `${shot}.dark.png`]) {
        expect(fs.existsSync(pathMod.join(__dirname, "..", "docs", "screenshots", "admin", variant)),
          `${variant} is referenced by a guide but missing from docs/screenshots/admin`).toBe(true);
      }
    }
  });

  test("v7.16.2: every cross-document anchor in the guides resolves to a real heading", () => {
    // A superadmin-guide link to `admin.md#alerts` silently delivered the reader
    // to the TOP of a 900-line guide. Two independent reasons, both invisible
    // without following the link: marked v15 emits no heading `id`s (removed
    // upstream in v5), so there was no target; and the renderer resolved the
    // href with `new URL(...).pathname`, which DROPS the fragment before the
    // link is even built. A dead anchor produces no error anywhere — it just
    // quietly shows the wrong thing, which is why it needs a mechanical check.
    const fs = require("fs"), pathMod = require("path");
    const dir = pathMod.join(__dirname, "..", "docs", "user-guide");
    // Mirrors slugify() in public/help-renderer.js. If that changes, this must.
    const slug = (t) => String(t).toLowerCase().trim()
      .replace(/<[^>]*>/g, "").replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

    const headings = {};   // file -> Set(slug)
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".md"))) {
      const seen = Object.create(null); const set = new Set();
      for (const m of fs.readFileSync(pathMod.join(dir, f), "utf8").matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
        let sl = slug(m[1]) || "section";
        if (seen[sl]) { seen[sl]++; sl = `${sl}-${seen[sl]}`; } else { seen[sl] = 1; }
        set.add(sl);
      }
      headings[f] = set;
    }

    const bad = [];
    for (const f of Object.keys(headings)) {
      const src = fs.readFileSync(pathMod.join(dir, f), "utf8");
      for (const m of src.matchAll(/\]\(([^)\s]*?\.md)?#([A-Za-z0-9_-]+)\)/g)) {
        const target = m[1] || f;                    // no path → same document
        const line = src.slice(0, m.index).split("\n").length;
        if (!headings[target]) { bad.push(`${f}:${line} → ${target} (no such guide)`); continue; }
        if (!headings[target].has(m[2])) bad.push(`${f}:${line} → ${target}#${m[2]} (no heading with that slug)`);
      }
    }
    expect(bad,
      "these anchors point at nothing, so the reader silently lands at the top of the target guide " +
      "instead of the section that was linked:\n  " + bad.join("\n  ")
    ).toEqual([]);
  });

  test("v7.16.2: a seeded-fixture row lookup filters the table first", () => {
    // Both admin tables paginate at 30 rows and every spec on a worker shares
    // one DB, so a seeded fixture drifts off page 1 as earlier files add rows.
    // Which files land on which worker decides whether a given lookup breaks,
    // which is why this reproduces in CI and not locally — v7.15.29 fixed it
    // across ui-admin.spec.js and v7.16.0's CI run found the SAME class still
    // live in ui-participant.spec.js. Fixing a class means grepping for its
    // other instances; this does the grepping from now on.
    //
    // The rule: a lookup for one of the SEEDED competition names must have a
    // search-box fill shortly before it. Scoped to those names on purpose —
    // rows a test created itself are usually fine, and a broad rule would be
    // noise.
    const fs = require("fs"), pathMod = require("path");
    const SEEDED = ["Test Live", "Test Upcoming", "Test Ended"];
    const bad = [];
    for (const f of fs.readdirSync(__dirname).filter(x => /^ui-.*\.spec\.js$/.test(x))) {
      const raw = fs.readFileSync(pathMod.join(__dirname, f), "utf8");
      const lines = raw.split("\n");
      lines.forEach((ln, i) => {
        if (/^\s*(\/\/|\*)/.test(ln)) return;                       // a comment, not code
        if (!/(?:locator|waitFor|\$\$?)\s*\(\s*[`"'][^`"']*tr:has-text/.test(ln)) return;
        if (!SEEDED.some(n => ln.includes(n))) return;
        // Satisfied by a direct fill of either admin search box, OR by one of
        // the helpers that fills it for you. Naming the helpers matters: the
        // first version looked only for the raw selector, so every call site
        // that had been correctly migrated to filterComps() still reported as
        // unfiltered — a scanner that cannot see the fix will be silenced by
        // whoever hits it next.
        const before = lines.slice(Math.max(0, i - 12), i).join("\n");
        if (/#(?:comp|task)-search|filterComps\s*\(|viewComp\s*\(|findSeededTaskRow\s*\(/.test(before)) return;
        bad.push(`${f}:${i + 1}  ${ln.trim().slice(0, 90)}`);
      });
    }
    expect(bad,
      "these look up a SEEDED competition row without filtering the table first. The table paginates at " +
      "30 rows and the worker DB accumulates, so the row can be genuinely ABSENT rather than slow — the " +
      "tell is a lookup that burns its whole timeout. Fill #comp-search / #task-search first:\n  " +
      bad.join("\n  ")
    ).toEqual([]);
  });

  test("v7.17.1: every ui/ helper a feature module uses is imported by that module", () => {
    // Migrating the six pagination bars onto ui/list-controls.js, two of the
    // three import lines silently did not land. `paginationHtml` was then a
    // free variable — a ReferenceError at render time — and NOTHING caught it
    // before the browser: `node --check` parses it happily, and esbuild's
    // bundler only errors on an unresolved IMPORT, not on an undefined
    // identifier. It surfaced as eight unrelated UI tests timing out on a
    // selector, naming nothing about the cause.
    //
    // Same shape as the helpers.js scanner above, aimed at public/js.
    const fs = require("fs"), pathMod = require("path");
    const uiDir = pathMod.join(__dirname, "..", "public", "js", "ui");
    const exportsByModule = {};
    for (const f of fs.readdirSync(uiDir).filter(x => x.endsWith(".js"))) {
      const src = fs.readFileSync(pathMod.join(uiDir, f), "utf8");
      exportsByModule[f] = [...src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map(m => m[1])
        .concat([...src.matchAll(/^export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map(m => m[1]));
    }
    const featDir = pathMod.join(__dirname, "..", "public", "js", "features");
    const bad = [];
    for (const f of fs.readdirSync(featDir).filter(x => x.endsWith(".js"))) {
      const raw = fs.readFileSync(pathMod.join(featDir, f), "utf8");
      const src = _stripJsComments(raw);
      const imported = new Set();
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*["']/g)) {
        for (const part of m[1].split(",")) { const n = part.split(" as ").pop().trim(); if (n) imported.add(n); }
      }
      for (const [mod, syms] of Object.entries(exportsByModule)) {
        for (const sym of syms) {
          if (imported.has(sym)) continue;
          // Declared locally under the same name? Then it is not the helper.
          if (new RegExp(`(?:function|const|let|var)\\s+${sym}\\b`).test(src)) continue;
          if (new RegExp(`\\b${sym}\\s*\\(`).test(src)) bad.push(`${f} calls ${sym}() from ui/${mod} without importing it`);
        }
      }
    }
    expect(bad,
      "a feature module calls a ui/ helper it never imported. That is a ReferenceError at render time " +
      "which neither `node --check` nor the esbuild bundle detects — it surfaces as unrelated UI tests " +
      "timing out on a selector:\n  " + bad.join("\n  ")
    ).toEqual([]);
  });

  // v7.21.24 — strip BOTH comment forms in ONE left-to-right pass.
  //
  // The two-step form (`block` then `line`) is wrong in one direction and it
  // bit: a `/*` sitting inside a `//` comment — e.g. the literal
  // `accept="image/*"` quoted in a header — opens a block comment that the
  // stripper then closes at the next `*/`, dozens of lines later, deleting the
  // real code in between. Here that ate a spec's import line and the scanner
  // reported it as three missing imports on the line that imports them.
  //
  // An alternation gets both cases right because the engine scans left to
  // right: whichever comment opens FIRST wins, which is exactly the rule a
  // tokeniser applies. (Still not a tokeniser — a `//` inside a string literal
  // is over-stripped, which is the safe direction for every caller here.)
  function _stripJsComments(raw) {
    return raw.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g,
      (m, str, pre) => (str !== undefined ? str : pre === undefined ? "" : pre));
  }

  test("v8.3.39: every column an ALTER adds is DECIDED about by the schema manifest", () => {
    // v8.3.39 (external audit) — `db.js` swallows almost every migration error,
    // so a required column or index can silently be absent while the platform
    // serves traffic. `lib/schema-required.js` is what readiness checks against;
    // this is what stops that manifest rotting the moment somebody adds a
    // migration, which is the only way it CAN rot — the failure mode is always
    // the site added later.
    //
    // A DECISION PER ITEM, never blanket coverage (the `BACKUP_COVERS` shape,
    // v7.21.34): a new column must be listed as required or exempted WITH A
    // REASON. And in BOTH directions — a manifest entry naming a column db.js no
    // longer adds would drain a healthy instance for ever, which is the stale-
    // exemption failure the v8.3.11 L9 guard exists for, with the sides swapped.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    // Comments FIRST. db.js narrates its own migrations ("the ALTER TABLE dance
    // below"), and the manifest's header quotes the very pattern this matches.
    const src = _stripJsComments(fs.readFileSync(pathMod.join(root, "db.js"), "utf8"));
    const { REQUIRED_COLUMNS, REQUIRED_INDEXES, EXEMPT_COLUMNS, EXEMPT_INDEXES } =
      require(pathMod.join(root, "lib/schema-required.js"));

    // --- what db.js actually does -------------------------------------------
    const added = new Set();     // "table.column"
    const dropped = new Set();
    for (const m of src.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi)) added.add(`${m[1]}.${m[2]}`);
    for (const m of src.matchAll(/ALTER\s+TABLE\s+(\w+)\s+DROP\s+COLUMN\s+(\w+)/gi)) dropped.add(`${m[1]}.${m[2]}`);
    // The event-kind block adds its columns through a local `add(col, ddl)`
    // helper, so the table name lives in the closure and the column name is an
    // ARGUMENT — invisible to the literal pattern above. Missing it silently
    // dropped eight `competitions` columns from this scan on the first draft.
    const addHelper = /const\s+add\s*=\s*\(col,\s*ddl\)\s*=>\s*\{[^}]*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN/i.exec(src);
    if (addHelper) {
      for (const m of src.matchAll(/\n\s*add\("(\w+)"\s*,/g)) added.add(`${addHelper[1]}.${m[1]}`);
    }
    const uniqueIdx = new Set();
    for (const m of src.matchAll(/CREATE\s+UNIQUE\s+INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)/gi)) uniqueIdx.add(m[1]);

    // ANTI-VACUITY. A rename or a refactor that made these patterns match
    // nothing would leave every assertion below trivially green — which is
    // precisely the drift this exists to catch.
    expect(added.size, "db.js adds columns by ALTER").toBeGreaterThanOrEqual(50);
    expect(uniqueIdx.size, "db.js creates unique indexes").toBeGreaterThanOrEqual(8);
    expect(addHelper, "the templated competitions ALTER helper is still recognised").toBeTruthy();

    const required = new Set();
    for (const [t, cols] of Object.entries(REQUIRED_COLUMNS)) for (const c of cols) required.add(`${t}.${c}`);

    // --- db.js -> manifest ---------------------------------------------------
    const undecided = [...added].filter(k => !required.has(k) && !EXEMPT_COLUMNS[k] && !dropped.has(k)).sort();
    expect(undecided,
      "a column added by an ALTER in db.js must be listed in REQUIRED_COLUMNS, or in EXEMPT_COLUMNS with a reason " +
      "(lib/schema-required.js). Readiness checks the manifest, so anything absent from it can go missing in silence."
    ).toEqual([]);

    const undecidedIdx = [...uniqueIdx].filter(n => !REQUIRED_INDEXES.includes(n) && !EXEMPT_INDEXES[n]).sort();
    expect(undecidedIdx,
      "a UNIQUE index db.js creates must be listed in REQUIRED_INDEXES, or in EXEMPT_INDEXES with a reason. " +
      "A unique index enforces an invariant the application relies on; a plain index is a performance property " +
      "and is deliberately out of scope."
    ).toEqual([]);

    // --- manifest -> db.js ---------------------------------------------------
    const stale = [...required].filter(k => !added.has(k)).sort();
    expect(stale,
      "REQUIRED_COLUMNS names a column no ALTER in db.js adds. Either the migration was removed — in which case " +
      "this entry would fail readiness on every healthy instance for ever — or the extraction above stopped seeing it."
    ).toEqual([]);
    const staleIdx = REQUIRED_INDEXES.filter(n => !uniqueIdx.has(n)).sort();
    expect(staleIdx, "REQUIRED_INDEXES names a unique index db.js does not create").toEqual([]);

    // Every exemption is a DECISION, so it must carry a reason and still name a
    // real site. A stale exemption reads as coverage and is not.
    for (const [k, why] of Object.entries(EXEMPT_COLUMNS)) {
      expect(String(why).length, `EXEMPT_COLUMNS["${k}"] must state a reason`).toBeGreaterThan(40);
      // A column db.js DROPS is excluded structurally above, so an exemption may
      // only ever name one it ADDS. Anything else is stale by construction.
      expect(added.has(k), `EXEMPT_COLUMNS["${k}"] names no column db.js adds — stale`).toBe(true);
    }
    for (const [k, why] of Object.entries(EXEMPT_INDEXES)) {
      expect(String(why).length, `EXEMPT_INDEXES["${k}"] must state a reason`).toBeGreaterThan(40);
      expect(uniqueIdx.has(k), `EXEMPT_INDEXES["${k}"] names no index db.js creates — stale`).toBe(true);
    }
  });

  test("v7.21.32: every user-driven event emit carries the requester's IP", () => {
    // The operator's standing rule: every event-log entry caused by a user must
    // be attributed to that user AND carry their source IP. Prose does not
    // enumerate (v7.15.15), so this walks every record*Event call in the server
    // code and fails on one that has a `req` in scope and no reqContext.
    //
    // The rule's ONE exemption is background work — schedulers, reapers,
    // reconcilers, boot — which has no request and is attributed to "system".
    // That is expressed structurally rather than by a name list: if there is no
    // enclosing function binding `req`, there was no request to describe.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const files = ["server.js", "db.js",
      ...fs.readdirSync(pathMod.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`),
      ...fs.readdirSync(pathMod.join(root, "lib")).filter(f => f.endsWith(".js")).map(f => `lib/${f}`)];
    const CALL = /record(?:User|Competition|Timeslot|Settings|Orphaned(?:Audit)?)Event\(/g;

    const bad = [];
    const hidden = [];
    for (const rel of files) {
      const raw = fs.readFileSync(pathMod.join(root, rel), "utf8");
      const src = _stripJsComments(raw);
      // v8.13.3 — ANTI-VACUITY: the stripper does not know about strings, so a
      // slash-star pair inside a string literal ("multipart" + the subtype
      // wildcard, measured in lib/middleware.js) opens a "comment" that runs to
      // the next star-slash and silently removes every emit in between from this
      // scan. Every call on a line that is not itself a comment must survive the
      // strip, or the file names itself here instead of passing in silence.
      const onCodeLines = (raw.split("\n").filter(l => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join("\n").match(CALL) || []).length;
      const survived = (src.match(CALL) || []).length;
      if (survived < onCodeLines) hidden.push(`${rel}: ${onCodeLines - survived} emit(s) on code lines vanished in the comment strip`);
      CALL.lastIndex = 0;
      let m;
      while ((m = CALL.exec(src))) {
        // The whole call, by brace/paren balance — an emit can span many lines.
        let i = m.index + m[0].length, depth = 1;
        while (i < src.length && depth) {
          const c = src[i];
          if (c === "(") depth++; else if (c === ")") depth--;
          i++;
        }
        const call = src.slice(m.index, i);
        if (/reqContext/.test(call)) continue;
        // A handler often computes the context ONCE and spreads the constant —
        // either because it loops (bulk invite, bulk group add, where reqContext
        // would otherwise be re-read up to BULK_ADMIN_MAX times) or just for
        // readability. Accept ANY spread whose identifier is genuinely bound to
        // reqContext(req) in the same file, rather than blessing particular
        // names: a scanner that is wrong about working code gets silenced by
        // whoever hits it next.
        const spreads = [...call.matchAll(/\.\.\.([A-Za-z_$][\w$]*)\b/g)].map(x => x[1]);
        if (spreads.some(v => new RegExp(`\\b${v}\\s*=\\s*reqContext\\(req\\)`).test(src))) continue;
        // A details object passed by name may carry it at its construction site;
        // only flag calls whose details argument is an inline object literal.
        if (!/,\s*\{/.test(call.slice(call.indexOf("(") + 1))) continue;

        // Is there a `req` to describe? Walk outwards to the enclosing function.
        let j = m.index, depth2 = 0, hasReq = false;
        while (j > 0) {
          const c = src[j];
          if (c === "}") depth2++;
          else if (c === "{") {
            if (depth2 === 0) {
              // The HEADER of this block only: cut at the last statement
              // boundary (`;` or `}` ending a line) before it. v8.12.2 — the
              // raw 400-character window reached into the PREVIOUS function
              // whenever a short helper taking `req` sat just above an emit
              // that binds none (lib/audit.js `sealRevealHistoryDetails` above
              // `recordSealedReveal`), which is the scanner being wrong about
              // working code. Enclosing blocks are still walked outward one by
              // one, so an emit inside an `if` still finds its handler's `req`.
              let head = src.slice(Math.max(0, j - 400), j);
              const cut = [...head.matchAll(/[;}][ \t]*\n/g)].pop();
              if (cut) head = head.slice(cut.index + cut[0].length);
              if (/\(\s*req\b|\breq\s*,\s*res\b|\(\s*req\s*\)\s*=>/.test(head)) { hasReq = true; break; }
            } else depth2--;
          }
          j--;
        }
        if (hasReq) bad.push(`${rel}:${src.slice(0, m.index).split("\n").length} ${call.slice(0, 90).replace(/\s+/g, " ")}`);
      }
    }
    expect(hidden, "a string literal holding a slash-star pair blanked part of a file from this scan — respell the literal").toEqual([]);
    expect(bad,
      "an event emitted inside a request handler must carry ...reqContext(req) — the operator's standing " +
      "rule is that every user-driven entry names the user AND their source IP. Background emits (no `req` " +
      "in scope, actor \"system\") are exempt and are not flagged:\n  " + bad.join("\n  ")
    ).toEqual([]);
  });

  test("v8.8.9: a DEFERRED event emit carries the requester's IP too", () => {
    // The v7.21.32 scanner above matches a DIRECT `record*Event(` call, so an
    // emit reached through a function REFERENCE is invisible to it — and the two
    // hottest paths on the platform do exactly that. `POST /api/tasks/:id/submit`
    // and `POST /api/select-timeslot` both collect their emits into
    // `queueEvent(recordUserEvent, …)` and drain them post-commit on a
    // setImmediate, to keep the write-lock hold short during a submit storm.
    //
    // So EVERY SUBMISSION — the highest-volume user-caused event there is —
    // carried no source IP, and the record was inconsistent about it: the DIRECT
    // twin of `active_competition_changed` in the same file spreads reqContext,
    // and the queued one did not. Same event type, both ways, along the
    // queued/direct axis alone. That is oversight, not a decision, and the reason
    // nothing caught it is that a scanner keyed on the call SHAPE cannot see a
    // call made by reference.
    //
    // Deliberately NOT fixed by widening the v7.21.32 regex to a word boundary:
    // measured, that goes from 284 matches to 370 — 73 false positives against
    // 13 true hits — and a scanner that is wrong about working code is one the
    // next person deletes.
    //
    // `recordChallengeEvent` is EXCLUDED by name: it writes analytics signal, not
    // an attributed state change, and is outside the standing rule (see the
    // v7.21.32 comment above).
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const files = ["server.js",
      ...fs.readdirSync(pathMod.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`)];
    const CALL = /queueEvent\(\s*record(?:User|Competition|Timeslot)Event\s*,/g;
    const CTX = /\.\.\.[A-Za-z_$][\w$]*[Cc]tx\b|\.\.\.reqContext\(/;

    const bad = [];
    let total = 0;
    for (const rel of files) {
      const src = _stripJsComments(fs.readFileSync(pathMod.join(root, rel), "utf8"));
      let m;
      CALL.lastIndex = 0;
      while ((m = CALL.exec(src))) {
        total++;
        // The call's own argument list, to the end of that statement.
        const tail = src.slice(m.index, src.indexOf("\n", m.index + 1) === -1 ? undefined : src.indexOf(");", m.index) + 2);
        if (CTX.test(tail)) continue;
        // ONE level of indirection, the idiom the v8.7.0 route scanner already
        // resolves: the details argument may be a file-local object built a few
        // lines above (`evDetails`, `compEvDetails`). Find its declaration and
        // look for the spread there. Without this the two by-name sites are
        // simply unpinned, which reads as coverage and is not.
        const byName = tail.match(/,\s*([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*\)\s*;?\s*$/);
        if (byName) {
          const decl = new RegExp(`const\\s+${byName[1]}\\s*=\\s*\\{`).exec(src);
          if (decl) {
            const block = src.slice(decl.index, src.indexOf("\n    };", decl.index) + 7);
            if (CTX.test(block)) continue;
          }
        }
        const line = src.slice(0, m.index).split("\n").length;
        bad.push(`${rel}:${line}`);
      }
    }
    // ANTI-VACUITY: a rename of queueEvent would empty the match set and pass in
    // silence, which is precisely the failure this exists to catch.
    expect(total, "the deferred-emit sites are still recognisable").toBeGreaterThanOrEqual(12);
    expect(bad, "a deferred event emit must carry reqContext, captured at QUEUE time "
      + "while `req` is still in hand (`req.ip` is a lazy getter onto the socket, and "
      + "the drain runs after the response):\n  " + bad.join("\n  ")).toEqual([]);
  });

  test("v7.16.2: every helpers.js symbol a spec uses is imported by that spec", () => {
    // v7.16.0's CI run reported `ReferenceError: PORT_BASE is not defined` for
    // three tests. The reference sat in ui-admin.spec.js's alice-RECOVERY catch
    // — a branch that never executes locally — so the suite was green here and
    // red there, and worse, the crash MASKED whatever had made alice fail.
    //
    // A missing import inside a rarely-taken branch is invisible to any runtime
    // check that does not happen to take that branch. It is trivially visible
    // to a static one, which is the point: this costs milliseconds and covers
    // every branch, including the ones only CI reaches.
    const fs = require("fs"), pathMod = require("path");
    const helpersSrc = fs.readFileSync(pathMod.join(__dirname, "helpers.js"), "utf8");
    const exportBlock = helpersSrc.slice(helpersSrc.lastIndexOf("module.exports"));
    const exported = [...exportBlock.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,:]/gm)].map(m => m[1]);
    expect(exported.length, "could not parse helpers.js exports").toBeGreaterThan(3);

    const bad = [];
    for (const f of fs.readdirSync(__dirname).filter(x => /\.spec\.js$/.test(x))) {
      const raw = fs.readFileSync(pathMod.join(__dirname, f), "utf8");
      // Strip comments so a symbol merely NAMED in prose is not counted as used.
      const src = _stripJsComments(raw);
      // Everything this file pulls out of ./helpers, from any require form.
      const imported = new Set();
      for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(["']\.\/helpers["']\)/g)) {
        for (const part of m[1].split(",")) {
          const name = part.split(":").pop().trim();
          if (name) imported.add(name);
        }
      }
      // The inline form `require("./helpers").SYMBOL` is equally valid and is
      // used in a couple of places to avoid widening a file's import list for
      // one reference. Counting only the destructured shape flagged both as
      // missing imports — a scanner's first job is to be right about the code
      // that already works, or nobody trusts the one real hit it finds.
      for (const m of src.matchAll(/require\(["']\.\/helpers["']\)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
        imported.add(m[1]);
      }
      for (const sym of exported) {
        if (imported.has(sym)) continue;
        // Locally defined under the same name? Then it is not the helper.
        if (new RegExp(`(?:function|const|let|var)\\s+${sym}\\b`).test(src)) continue;
        if (new RegExp(`\\b${sym}\\b`).test(src)) {
          const at = raw.search(new RegExp(`\\b${sym}\\b`));
          const line = at < 0 ? 0 : raw.slice(0, at).split("\n").length;
          bad.push(`${f}:${line} uses ${sym} without importing it from ./helpers`);
        }
      }
    }
    expect(bad,
      "a spec references a helpers.js symbol it never imported. If the reference sits in a rarely-taken " +
      "branch it will throw ReferenceError only when that branch runs — typically in CI, where it then " +
      "masks the real failure:\n  " + bad.join("\n  ")
    ).toEqual([]);
  });

  test("v7.15.34: the perf env template does not disable rate limiting", () => {
    // `env_file` applies for the container's WHOLE life, so a
    // RATE_LIMIT_DISABLED=1 line here does not just speed up the seed — it
    // silently removes rate limiting from the MEASUREMENT too. That is how
    // CTF-0026 (the per-(IP,email) login buckets that decide whether a venue
    // NAT full of participants can sign in) came to be excluded from every
    // perf run ever done, invisibly, for years.
    //
    // The line was justified by the 10/min /api/register cap, a code path
    // deleted in v6.10.80. Measured after removing it: the seed takes 3s with
    // limits on versus 2s with them off, clean DB and dirty re-seed alike.
    //
    // Re-adding it must therefore be a deliberate, reviewed act. If a future
    // seeder change genuinely needs it, set it for the SEED phase only and
    // restart the target without it before measuring.
    const fs = require("fs"), pathMod = require("path");
    const f = pathMod.join(__dirname, "..", "perf", "env.perf.example");
    const src = fs.readFileSync(f, "utf8");
    const offending = src.split("\n")
      .filter(l => !l.trim().startsWith("#"))
      .filter(l => /^\s*RATE_LIMIT_DISABLED\s*=\s*(1|true)\s*$/i.test(l));
    expect(offending,
      "perf/env.perf.example must not disable rate limiting — it applies for the container's " +
      "entire life, so it silently voids the measurement as well as the seed"
    ).toEqual([]);
  });

  test("v8.9.1: every k6 submit carries the grading hash from a detail read, and a refusal is counted apart from a wrong answer", () => {
    // v7.20.9 made `gradingHash` REQUIRED on POST /api/tasks/:id/submit: a
    // submission without one is treated as stale and refused 409 task_changed
    // (no row, no penalty). The perf harness never sent it, so from v7.20.9 to
    // v8.9.0 every "correct" submit in competition-live and submission-burst
    // was a refusal — counted as a WRONG answer by the fallback branch, which
    // is why both scenarios kept reporting a plausible correct/wrong split over
    // a submit path that graded nothing, for eleven releases. Two things are
    // pinned: the hash rides every submit, read from the detail payload's
    // grading_hash exactly as the SPA does; and a 409 task_changed lands in its
    // OWN counter behind a hard threshold, so the next regression of this shape
    // fails the run instead of colouring it. Comments are stripped first: the
    // explanations at each site quote the very identifiers matched below.
    const fs = require("fs"), pathMod = require("path");
    const read = (rel) => _stripJsComments(fs.readFileSync(pathMod.join(__dirname, "..", rel), "utf8"));
    const lib = read("perf/k6/lib/participant.js");
    expect(lib, "participant.js reads grading_hash off the detail payload").toMatch(/task\.gradingHash\s*=\s*detail\.grading_hash/);
    expect((lib.match(/gradingHash:\s*task\.gradingHash/g) || []).length,
      "both submit helpers (correct AND wrong) send the hash").toBe(2);
    expect((lib.match(/staleSubmissions\.add\(1\)/g) || []).length,
      "both submit helpers count a 409 task_changed as STALE, never as wrong").toBe(2);
    const burst = read("perf/k6/scenarios/submission-burst.js");
    expect(burst, "submission-burst reads the detail before it submits").toMatch(/get\(`\$\{BASE_URL\}\/api\/tasks\/\$\{task\.id\}`/);
    expect(burst, "submission-burst sends the hash").toMatch(/\{\s*answer,\s*gradingHash\s*\}/);
    expect(burst, "submission-burst counts a stale submit apart").toMatch(/staleSubmissions\.add\(1\)/);
    expect(burst, "submission-burst gates on stale_submissions").toMatch(/"stale_submissions":\s*\["count<1"\]/);
    const live = read("perf/k6/scenarios/competition-live.js");
    expect(live, "competition-live gates on stale_submissions").toMatch(/"stale_submissions":\s*\["count<1"\]/);
    const metrics = read("perf/k6/lib/metrics.js");
    expect(metrics, "the counter is declared once, in the shared metrics module")
      .toMatch(/export const staleSubmissions\s*=\s*new Counter\("stale_submissions"\)/);
  });

  test("v7.22.0: the static rankings <thead> in index.html matches _RK_COLS", () => {
    // There are FIVE places a rankings column lives: the four rankingsThead()
    // call sites — which the helper keeps honest for free — and this
    // hand-written fallback in index.html, which nothing does. It exists so the
    // pre-render frame has the same shape as the table loadAdminLeaderboard()
    // replaces it with; a fallback whose columns have drifted from the real ones
    // is a frame of wrong markup on every entry into the tab, and after v7.22.0
    // it is a NINE-column header, so the odds of the next column being added to
    // one and not the other are exactly what this closes.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const rk = _stripJsComments(fs.readFileSync(pathMod.join(root, "public/js/features/rankings-admin.js"), "utf8"));

    // The individual-board column set, in order, straight out of the source.
    const block = rk.match(/const _RK_COLS\s*=\s*\[([\s\S]*?)\];/);
    expect(block, "could not find _RK_COLS in rankings-admin.js — did it move or get renamed?").toBeTruthy();
    const cols = [...block[1].matchAll(/col:\s*'([a-z]+)'/g)].map(m => m[1]);
    expect(cols.length, "_RK_COLS must parse to a non-empty column list").toBeGreaterThan(4);

    // The fallback header's columns, in order.
    const html = fs.readFileSync(pathMod.join(root, "public/index.html"), "utf8");
    const thead = html.match(/<tbody id="admin-rankings-body">/)
      ? html.slice(0, html.indexOf('<tbody id="admin-rankings-body">'))
      : "";
    const fallback = [...thead.matchAll(/data-key="main"\s+data-col="([a-z]+)"/g)].map(m => m[1]);

    expect(fallback,
      "public/index.html's fallback rankings <thead> has drifted from _RK_COLS " +
      "(rankings-admin.js). Add the column to BOTH — the helper covers its four " +
      "call sites, this one is hand-maintained."
    ).toEqual(cols);

    // …and the icon span each header carries must be namespaced for that column,
    // or _rkPaintSortIcons has nothing to write the arrow into and the header
    // silently stops reporting its own sort state.
    for (const c of cols) {
      expect(thead.includes(`id="rksort-main-${c}-icon"`),
        `the fallback header for "${c}" is missing its rksort-main-${c}-icon span`).toBe(true);
    }
  });

  test("v7.21.35: the test data directory follows TEST_PORT_BASE, and nothing re-derives it", () => {
    // THE FOOTGUN THIS CLOSES. The port came from TEST_PORT_BASE and the data
    // directory came from TEST_PARALLEL_INDEX alone, so a second run started
    // with a different port base still claimed `data-test-0` — and global-setup
    // rm -rf's it. Two runs destroyed each other's database while talking
    // happily to different ports, and the symptom pointed nowhere near the
    // cause: `Login failed for superadmin: 401`, because .superadmin-password
    // was recreated underneath the run already using it.
    //
    // Both knobs were born in the SAME commit (v5.4.0) on adjacent lines, both
    // keyed on the worker index — so within one run they always agreed, and the
    // gap was invisible until someone ran two. That is exactly why a comment
    // would not hold it: the code reads as though they move together.
    const path = require("path");
    const fs = require("fs");
    const fresh = (portBase) => {
      const key = require.resolve("./server-env");
      delete require.cache[key];
      const prev = process.env.TEST_PORT_BASE;
      if (portBase === null) delete process.env.TEST_PORT_BASE;
      else process.env.TEST_PORT_BASE = String(portBase);
      const mod = require("./server-env");
      const out = { port: mod.portFor(0), dir: path.basename(mod.dataDirFor(0)) };
      if (prev === undefined) delete process.env.TEST_PORT_BASE;
      else process.env.TEST_PORT_BASE = prev;
      delete require.cache[key];
      return out;
    };

    const def = fresh(null);
    const moved = fresh(4700);
    expect(def.port, "the default base must not move").toBe(4567);
    expect(def.dir, "an ordinary `npm test` must keep the bare data-test-<i> name").toBe("data-test-0");
    expect(moved.port).toBe(4700);
    expect(
      moved.dir,
      "TEST_PORT_BASE moved the port but NOT the data directory — two concurrent runs will " +
      "now share (and rm -rf) one database. The directory must be namespaced by the port base.",
    ).not.toBe(def.dir);

    // A second hand-written copy of the rule is how this breaks again: helpers
    // would resolve one directory while the server was launched against
    // another, which presents as an inexplicable auth failure, not a path bug.
    const helpers = fs.readFileSync(path.join(__dirname, "helpers.js"), "utf8");
    expect(
      /require\(["']\.\/server-env["']\)/.test(helpers),
      "tests/helpers.js must import the port/data-dir rule from server-env.js, not re-derive it",
    ).toBe(true);
    expect(
      /function defaultDataDir\(\)\s*\{\s*return dataDirFor\(/.test(helpers),
      "tests/helpers.js re-derives the data directory instead of delegating to dataDirFor()",
    ).toBe(true);
  });

  test("v7.20.2: no spec binds app code that opens the DB at module top-level", () => {
    // db.js opens the SQLite file AT REQUIRE TIME, and a spec's top-level
    // requires run before ANY hook — so a handle taken there predates the
    // per-file recycle that deletes and recreates that file. The reads then
    // succeed against an unlinked inode and return the PREVIOUS file's data.
    //
    // It only misbehaves when the spec is not the first file on its worker,
    // which is precisely the ordering nondeterminism the harness removes — and
    // it is how CI failed on the very commit that introduced per-file
    // isolation (two trusted-network window tests returned null).
    //
    // Requiring lazily INSIDE a test is fine: isolated-test.js purges the
    // app-module require cache after each recycle, so a later require binds to
    // the fresh database.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    // Only modules that actually REACH db.js matter — lib/util and lib/sanitise
    // are pure and hold no handle. And only a MODULE-SCOPE require is a problem:
    // one indented inside a test runs after the recycle and is the recommended
    // form, so the pattern is anchored at column 0.
    const dbBacked = new Set(["db"]);
    for (const f of fs.readdirSync(pathMod.join(root, "lib")).filter(x => x.endsWith(".js"))) {
      const src = fs.readFileSync(pathMod.join(root, "lib", f), "utf8");
      if (/require\(["']\.\.\/db["']\)/.test(src)) dbBacked.add(`lib/${f.replace(/\.js$/, "")}`);
    }
    const bad = [];
    for (const f of fs.readdirSync(__dirname).filter(x => /\.spec\.js$/.test(x))) {
      const src = fs.readFileSync(pathMod.join(__dirname, f), "utf8");
      for (const m of src.matchAll(/^(?:const|let|var)\s+[^=\n]*=\s*require\(["']\.\.\/(db|lib\/[\w-]+)["']\)/gm)) {
        if (!dbBacked.has(m[1])) continue;
        const line = src.slice(0, m.index).split("\n").length;
        bad.push(`${f}:${line}  requires ../${m[1]} at module scope (it reaches db.js)`);
      }
    }
    expect(bad,
      "these specs bind app code at module top-level. db.js opens the database at REQUIRE time, " +
      "which happens BEFORE the per-file recycle wipes it — so the handle reads the previous " +
      "file's data from an unlinked inode, but only when the spec is not first on its worker. " +
      "Require it lazily inside the test instead (the harness purges the module cache on each " +
      "recycle):\n  " + bad.join("\n  ")
    ).toEqual([]);
  });

  test("v7.20.0: every spec file uses the per-file-isolated harness", () => {
    // Per-file isolation is opt-in per file: a spec that requires
    // @playwright/test directly gets NO beforeAll recycle, so it runs against
    // whatever the previous file left behind — the exact coupling this design
    // removes, reintroduced silently by one import line.
    //
    // It fails in the worst possible way, too: that spec still PASSES most of
    // the time, and takes down some unrelated later file instead.
    const fs = require("fs"), pathMod = require("path");
    const offenders = [];
    for (const f of fs.readdirSync(__dirname).filter(x => /\.spec\.js$/.test(x))) {
      const src = fs.readFileSync(pathMod.join(__dirname, f), "utf8");
      // Match a real IMPORT BINDING, not any mention. The first version used a
      // bare /require\(...\)/ and flagged THIS file, because the scanner's own
      // regex literal contains the string it is looking for.
      if (/^\s*(?:const|let|var)\s+[^=\n]*=\s*require\(["']@playwright\/test["']\)/m.test(src)) offenders.push(f);
    }
    expect(offenders,
      'these specs require("@playwright/test") directly and so opt out of per-file server/DB ' +
      'isolation — they inherit the previous file\'s database and in-process caches. ' +
      'Use require("./isolated-test") instead (same exports):\n  ' + offenders.join("\n  ")
    ).toEqual([]);

    // And the harness itself must still register the recycle — an import line
    // that resolves to a module doing nothing would pass the scan above.
    const iso = fs.readFileSync(pathMod.join(__dirname, "isolated-test.js"), "utf8");
    expect(/test\.beforeAll\(/.test(iso),
      "isolated-test.js must register a beforeAll that recycles the server").toBeTruthy();
    expect(/rmSync\(dataDir/.test(iso),
      "the recycle must WIPE the data directory — reusing it keeps the previous file's rows").toBeTruthy();
  });

  test("v7.19.1: every correct_answer renderer goes through formatCorrectAnswer", () => {
    // For a multiple-choice challenge `correct_answer` stores a JSON array of
    // choice IDs — right to store (the options are shuffled, so grading keys on
    // identity), wrong to show. A renderer that prints it verbatim puts
    // `["6bc9f335"]` in front of a human under the heading "Correct Answer".
    //
    // There are THREE renderers — the admin's participant preview, the
    // participant's own post-competition solution box, and the challenge editor
    // — and v7.19.0 fixed only the first. The participant one shipped broken and
    // was reported from production. Prose in CLAUDE.md did not prevent it (the
    // v7.18.0 note literally says "both renderers need it", and there were
    // three), so this is the enumerable version.
    const fs = require("fs"), pathMod = require("path");
    const FEATURES = pathMod.join(__dirname, "..", "public", "js", "features");
    const bad = [];
    for (const f of fs.readdirSync(FEATURES).filter(x => x.endsWith(".js"))) {
      const src = fs.readFileSync(pathMod.join(FEATURES, f), "utf8");
      // A DISPLAY of the value: interpolated into markup, usually via esc().
      // `${esc(t.correct_answer)}` and `${x.correct_answer}` both count; reads
      // that feed parsing/derivation (JSON.parse, comparisons) do not.
      for (const m of src.matchAll(/\$\{[^}]*\bcorrect_answer\b[^}]*\}/g)) {
        const frag = m[0];
        if (frag.includes("formatCorrectAnswer")) continue;
        const line = src.slice(0, m.index).split("\n").length;
        bad.push(`${f}:${line}  ${frag.trim().slice(0, 80)}`);
      }
    }
    expect(bad,
      "these render `correct_answer` directly. For answer_type='choice' that prints a JSON " +
      "array of choice IDs to a human. Use formatCorrectAnswer(task) from ui/format.js, which " +
      "maps the IDs back to the option text (and handles BOTH payload shapes — the admin " +
      "surfaces carry the raw JSON string, the participant payload an already-parsed array):\n  "
      + bad.join("\n  ")
    ).toEqual([]);

    // The helper must exist and handle both shapes — the scanner above passes
    // vacuously if nothing renders the field at all.
    const fmt = fs.readFileSync(pathMod.join(__dirname, "..", "public", "js", "ui", "format.js"), "utf8");
    expect(/export function formatCorrectAnswer/.test(fmt),
      "ui/format.js must export formatCorrectAnswer").toBeTruthy();
    expect(/Array\.isArray\(v\)/.test(fmt),
      "formatCorrectAnswer must accept the ARRAY shape too — the participant payload has " +
      "already parsed `choices`, and handling only the JSON string fails silently on exactly " +
      "the surface this was written to fix").toBeTruthy();
  });

  test("v7.19.0: every sans font stack names an EMOJI font", () => {
    // REPORTED: "❌ doesn't render correctly anywhere", while "✅ does render
    // correctly (right size and colour)".
    //
    // That asymmetry is the whole diagnosis. Inter is self-hosted with a
    // latin + latin-ext `unicode-range`, so no emoji is ever served by it and
    // every one of them falls through to the OS. The browser resolves that
    // fallback PER GLYPH, so two emoji in one string can land in different
    // fonts: U+2705 ✅ found a colour emoji font and looked right, while
    // U+274C ❌ was picked up by a monochrome symbol font first and came out
    // the wrong size and colour. Naming the emoji fonts explicitly is what
    // removes the ambiguity.
    //
    // SCOPE, honestly: this asserts the CONTRACT, not a rendering. A width
    // measurement would be VACUOUS in CI — verified by measuring ❌/✅/⚠️ with
    // and without the fix in the Playwright container and getting identical
    // 40px both times, because that image's sans-serif chain already resolves
    // all three to one colour font. The reporter's machine does not, and CI
    // cannot reproduce it, so pinning the stack is the check that actually
    // discriminates.
    //
    // This is for USER-AUTHORED content (challenge text, multiple-choice
    // options, nicknames, avatars). The UI's own icons are inline SVG by
    // convention — see the icon-convention test — and must stay that way.
    const fs = require("fs"), pathMod = require("path");
    const PUBLIC = pathMod.join(__dirname, "..", "public");
    const EMOJI_FONTS = ["Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"];
    const offenders = [];
    for (const f of fs.readdirSync(PUBLIC).filter(x => x.endsWith(".css"))) {
      const src = fs.readFileSync(pathMod.join(PUBLIC, f), "utf8");
      // Every declaration that ends a stack in `sans-serif` is a candidate: it
      // is a real text stack, so an emoji landing in it must be resolvable.
      for (const m of src.matchAll(/(?:font-family|--font-sans)\s*:\s*([^;}]*sans-serif)/g)) {
        const stack = m[1];
        if (/var\(--font-sans\)/.test(stack)) continue;          // inherits the checked one
        if (!EMOJI_FONTS.some(fam => stack.includes(fam))) {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(`${f}:${line}  ${stack.trim()}`);
        }
      }
    }
    expect(offenders,
      "these sans stacks name no emoji font, so an emoji in user-authored content falls back " +
      "per-glyph to whatever the OS resolves — which is how ✅ rendered correctly and ❌ did not. " +
      "Append 'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji' (or use var(--font-sans)):\n  "
      + offenders.join("\n  ")
    ).toEqual([]);

    // The variable itself must exist and carry them — the rule above passes
    // vacuously for a file that simply has no sans stack at all.
    const styles = fs.readFileSync(pathMod.join(PUBLIC, "styles.css"), "utf8");
    const decl = /--font-sans\s*:\s*([^;}]+)[;}]/.exec(styles);
    expect(decl, "public/styles.css must define --font-sans").toBeTruthy();
    // ONE FAMILY (v8.16): --font-sans is the legacy name of --font-text, and the
    // type-token block defines the text and display stacks once for every look.
    expect(decl[1].trim(), "--font-sans aliases --font-text").toBe("var(--font-text)");
    const stacks = [...styles.matchAll(/--font-(?:text|display)\s*:\s*([^;}]+)[;}]/g)].map(m => m[1]);
    expect(stacks.length, "anti-vacuity: the text and display stacks must be found").toBe(2);
    for (const st of stacks) {
      for (const fam of EMOJI_FONTS) {
        expect(st, `--font-sans (via --font-body) must name ${fam}: ${st}`).toContain(fam);
      }
    }
  });

  test("v7.18.0: the client and server rich-text TABLE allowlists agree", () => {
    // Three allowlists decide whether a table works, and none of them errors
    // when they disagree:
    //   • lib/sanitise.js `_RICH_TEXT_OPTS`  — the server, the security boundary
    //   • renderRich()                       — what a participant actually sees
    //   • normalisePastedHtml()              — what survives a paste
    // A tag the server stores but the renderer drops renders as flattened text.
    // A tag the paste keeps but the server strips vanishes on save. Both look
    // to the author like "tables are broken" and neither logs anything, which
    // is precisely the class this repo keeps relearning (the client/server
    // email-validation mirror, `_PARTICIPANT_ROW_COLUMNS`).
    //
    // Both sides name the list `RICH_TABLE_TAGS`, so compare them directly
    // rather than re-listing the tags here — a hand-written third copy would be
    // one more thing to drift.
    const fs = require("fs"), pathMod = require("path");
    const serverTags = require("../lib/sanitise").RICH_TABLE_TAGS;
    expect(Array.isArray(serverTags) && serverTags.length,
      "lib/sanitise.js must export RICH_TABLE_TAGS for this lock to mean anything").toBeTruthy();

    const rt = fs.readFileSync(pathMod.join(__dirname, "..", "public", "js", "ui", "richtext.js"), "utf8");
    const m = /export const RICH_TABLE_TAGS\s*=\s*\[([^\]]*)\]/.exec(rt);
    expect(m, "public/js/ui/richtext.js must export RICH_TABLE_TAGS").toBeTruthy();
    const clientTags = m[1].split(",").map(x => x.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);

    expect([...clientTags].sort(),
      "the client render/paste table allowlist has drifted from the server's. A tag on one " +
      "side only is silent: server-only renders as flattened text, client-only vanishes on save."
    ).toEqual([...serverTags].sort());

    // And the tags must actually be wired into the server config, not merely
    // exported — an exported constant nothing spreads would pass the diff above
    // while tables stayed stripped.
    const san = fs.readFileSync(pathMod.join(__dirname, "..", "lib", "sanitise.js"), "utf8");
    expect(/allowedTags:[\s\S]{0,400}?\.\.\.RICH_TABLE_TAGS/.test(san),
      "RICH_TABLE_TAGS is exported but not spread into _RICH_TEXT_OPTS.allowedTags").toBeTruthy();
    // Same for the client renderer.
    expect(/const ALLOWED=new Set\(\[[^\]]*RICH_TABLE_TAGS/.test(rt),
      "renderRich() does not include RICH_TABLE_TAGS in its ALLOWED set").toBeTruthy();

    // Cell spans must be clamped. sanitize-html validates attribute NAMES and
    // never their VALUES, so without a transform `colspan="100000"` ships.
    expect(/td:\s*_transformCell/.test(san) && /th:\s*_transformCell/.test(san),
      "td/th must go through _transformCell, which clamps colspan/rowspan").toBeTruthy();
  });

  test("v9.2.13: the rich-text colour names agree on the client, the server and every look's palette", () => {
    // A colour pick stores a NAME as the custom property that draws it
    // (`color:var(--rt-red)`), never a hex, and three places must agree on the
    // names, none of which errors when they do not: ui/richtext.js RICH_COLOURS (the
    // menus and the paste normaliser), lib/sanitise.js RICH_COLOURS (the server,
    // which admits no other var()) and every look x mode's rtInk / rtHighlight (the
    // measured shades the generated token block declares). A name the server drops
    // vanishes on save; one with no shade is stored and drawn in no colour at all.
    const fs = require("fs"), pathMod = require("path");
    const { stripJsComments } = require("./doc-registry");
    const { RICH_COLOURS: server, sanitiseRichText } = require("../lib/sanitise");
    expect(Array.isArray(server) && server.length,
      "lib/sanitise.js must export RICH_COLOURS for this lock to mean anything").toBeTruthy();
    const rt = stripJsComments(fs.readFileSync(pathMod.join(__dirname, "..", "public", "js", "ui", "richtext.js"), "utf8"));
    const m = /export const RICH_COLOURS\s*=\s*\[([^\]]*)\]/.exec(rt);
    expect(m, "public/js/ui/richtext.js must export RICH_COLOURS").toBeTruthy();
    const client = m[1].split(",").map(x => x.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
    const names = [...server].sort();
    expect([...client].sort(), "the client's colour names have drifted from the server's: a name on the client only "
      + "vanishes on save, one on the server only is never offered").toEqual(names);

    // The palette: every look x mode gives every name an ink and a tint, and no
    // more; and the generated block declares each one for every look x mode.
    const { looks } = require("../scripts/theme/looks");
    let modes = 0;
    for (const [id, look] of Object.entries(looks)) for (const mode of ["light", "dark"]) {
      modes++;
      expect(Object.keys(look[mode].rtInk || {}).sort(), `${id}/${mode} rtInk`).toEqual(names);
      expect(Object.keys(look[mode].rtHighlight || {}).sort(), `${id}/${mode} rtHighlight`).toEqual(names);
    }
    expect(modes, "anti-vacuity: every look's day and night were read").toBeGreaterThanOrEqual(4);
    const css = fs.readFileSync(pathMod.join(__dirname, "..", "public", "styles.css"), "utf8");
    for (const n of names) {
      expect((css.match(new RegExp(`--rt-${n}:#[0-9a-f]{6}[;}]`, "g")) || []).length, `--rt-${n} is declared for every look x mode`).toBe(modes);
      expect((css.match(new RegExp(`--rt-hl-${n}:#[0-9a-f]{6}[;}]`, "g")) || []).length, `--rt-hl-${n} is declared for every look x mode`).toBe(modes);
    }

    // Wired, not merely listed: the server admits each client name's own var() for
    // its property, in a span and a table cell, and drops an unlisted one.
    for (const n of client) {
      const html = `<span style="color:var(--rt-${n})">a</span><span style="background-color:var(--rt-hl-${n})">b</span>`
        + `<table><tbody><tr><td style="color:var(--rt-${n});background-color:var(--rt-hl-${n})">c</td></tr></tbody></table>`;
      expect(sanitiseRichText(html), `the server keeps the name ${n}`).toBe(html);
    }
    expect(sanitiseRichText('<span style="color:var(--rt-nope)">x</span>'), "CONTROL: an unlisted name is dropped").toBe("<span>x</span>");
    // ...and the client's menus and paste normaliser read the same list.
    expect(/\[null,\.\.\.RICH_COLOURS\]\.forEach/.test(rt), "the colour menus offer RICH_COLOURS").toBe(true);
    expect(/for\(const name of RICH_COLOURS\)/.test(rt), "the paste normaliser maps a copied ink back through RICH_COLOURS").toBe(true);
  });

  test("v7.29.0: the lockout threshold and its columns are not re-invented", () => {
    // THE CLASS. The threshold was declared inline inside POST /api/login and the
    // three columns it governs were written by seven statements across three
    // files, three of which spelled the same clear with the columns in a
    // different order. Nothing outside that handler could read the number — and
    // the emailed sign-in code reuses this same failure budget rather than
    // growing a second one, so the entropy argument for a short code rests on
    // there being exactly one of them.
    //
    // Two rules. (a) Nobody outside lib/lockout.js may DECLARE the constants —
    // mechanical, no exceptions. (b) Every raw write to the three columns outside
    // that module must be a COMPOSITE statement on a documented allow-list. The
    // allow-list demands a DECISION per statement rather than per file: the one
    // survivor, the unblock, is a single atomic statement that also clears
    // `blocked`, so splitting it would put two writes where there is one. A
    // scanner that flagged it would be wrong about working code, and gets
    // silenced by whoever hits it next. Each entry must still match a statement,
    // so an entry whose statement is gone fails rather than exempting its file.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const read = f => fs.readFileSync(pathMod.join(root, f), "utf8");
    // Strip comments FIRST, preserving line count (v7.15.15 — this very patch
    // added comments at both allow-listed sites that quote the SQL being scanned
    // for), single-pass so a `/*` inside a `//` cannot open a block (v7.21.24).
    const strip = src => src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, m => m.replace(/[^\n]/g, " "));

    const own = read("lib/lockout.js");
    expect(own).toMatch(/const LOCKOUT_MAX = 10;/);
    expect(own).toMatch(/const LOCKOUT_WINDOW_MS = 5 \* 60 \* 1000;/);
    expect(own).toMatch(/const LOCKOUT_DURATION_MS = 60 \* 60 \* 1000;/);

    const walk = (dir) => fs.readdirSync(pathMod.join(root, dir))
      .filter(f => f.endsWith(".js")).map(f => `${dir}/${f}`);
    const files = ["server.js", "db.js", ...walk("routes"), ...walk("lib")]
      .filter(f => f !== "lib/lockout.js");

    // Statements that legitimately keep their own SQL, each with the reason and
    // the pattern that picks out that one statement in its file.
    const COMPOSITE_ALLOWED = new Map([
      ["routes/participants.js", { why: "the unblock UPDATE also clears `blocked` in the same statement", stmt: /\bblocked\s*=\s*0\b/ }],
    ]);

    const redeclared = [], rawWrites = [];
    const seen = new Set();
    for (const f of files) {
      const src = strip(read(f));
      if (/\bLOCKOUT_(MAX|WINDOW_MS|DURATION_MS)\s*=/.test(src)) redeclared.push(f);
      // A write is any UPDATE that zeroes the counter or nulls the lock.
      const writes = src.match(/UPDATE users SET[^"`']*?(failed_login_count\s*=|locked_until\s*=)[^"`']*/g) || [];
      for (const w of writes) {
        const allow = COMPOSITE_ALLOWED.get(f);
        if (allow && allow.stmt.test(w)) { seen.add(f); continue; }
        rawWrites.push(`${f}: ${w.replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
    expect(redeclared, "the lockout constants are declared in lib/lockout.js and nowhere else").toEqual([]);
    expect(rawWrites, "use clearLockout/recordFailedLogin/armLockout, or add the statement to COMPOSITE_ALLOWED with its reason").toEqual([]);
    expect([...seen].sort(), "every allow-listed statement still exists (a stale entry is removed, not kept)")
      .toEqual([...COMPOSITE_ALLOWED.keys()].sort());
  });

  test("v7.21.6: the scoring ladder is mirrored, not re-invented", () => {
    // THE CLASS. lib/scoring.js owns the ladder, but the number a participant
    // READS before acting is rendered from a client copy (`DIFF_PTS`,
    // public/js/ui/icons.js) that node can never import — a browser-only ESM
    // module. Nothing at runtime compares them, so a change to one side is
    // silent: the card says "+50 pts" and the submit awards 100; the hint
    // preview says "-15 pts" and the reveal deducts 30. The second is a price
    // quoted before a purchase.
    //
    // v7.21.6 removed the two SERVER copies outright (routes/challenges.js
    // hand-wrote the ladder AND the penalty for RECALCULATE — the one write path
    // that rewrites stored scores) and hoisted HINT_DEDUCTION_RATE into
    // lib/scoring. What remains is the irreducible client mirror, plus a scanner
    // forbidding any server file from open-coding the rate again.
    //
    // Same shape as the RICH_TABLE_TAGS and _EMAIL_RE locks: EXTRACT the server
    // value rather than hard-coding 50/100/150 here — a third hand-written copy
    // would be one more thing to drift.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const read = f => fs.readFileSync(pathMod.join(root, f), "utf8");
    // Strip comments FIRST, preserving line count — v7.15.15: the comment that
    // explained a fix once defeated the check for it, and routes/challenges.js
    // literally carries "ROUND(POINTS[difficulty] * 0.3)" in a comment.
    const strip = src => src
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
      .split("\n").map(l => l.replace(/\/\/.*$/, "")).join("\n");
    // Deliberately NOT eval: quoting the keys and using JSON.parse accepts
    // exactly {a:1,b:2} and THROWS on a spread, a computed key or a non-numeric
    // value — so a literal whose shape this lock cannot reason about fails
    // loudly instead of being silently mis-read.
    const parseLadder = (src, re, what) => {
      const m = re.exec(src);
      expect(m, `${what}: the ladder literal is gone — it moved or changed shape`).toBeTruthy();
      const json = `{${m[1]}}`.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
      try { return JSON.parse(json); }
      catch (_) { throw new Error(`${what}: ladder literal is not a flat numeric object -> ${json}`); }
    };

    const scoringSrc = strip(read("lib/scoring.js"));
    const POINTS = parseLadder(scoringSrc, /const POINTS\s*=\s*\{([^}]*)\}/, "lib/scoring.js POINTS");
    // Anti-vacuity: prove the regex read the value the server actually uses.
    // lib/scoring reaches only lib/config (never db.js), so this require is safe
    // and is deliberately indented — the v7.20.2 lock forbids a MODULE-SCOPE
    // require of app code, not this.
    const scoring = require("../lib/scoring");
    expect(POINTS, "the parsed POINTS must equal the exported value").toEqual(scoring.POINTS);
    expect(Object.keys(POINTS).sort()).toEqual(["easy", "hard", "medium"]);

    // The client mirror — irreducible, because public/js cannot require server code.
    expect(parseLadder(strip(read("public/js/ui/icons.js")), /export const DIFF_PTS\s*=\s*\{([^}]*)\}/, "public/js/ui/icons.js DIFF_PTS"),
      "DIFF_PTS has drifted from lib/scoring.js POINTS. It renders the participant-visible " +
      "'+N pts' on every challenge card, the task-detail header, the admin View-as-Participant " +
      "preview and the hint-cost preview — and nothing at runtime compares the two."
    ).toEqual(POINTS);

    // No SERVER file may re-declare the ladder or the penalty.
    for (const f of ["routes/challenges.js", "routes/participant.js", "server.js"]) {
      expect(/const\s+POINTS_FOR\s*=/.test(strip(read(f))),
        `${f} re-declares the point ladder — import POINTS from lib/scoring instead. ` +
        `recalculate did this, and it is the one route that rewrites stored scores.`).toBe(false);
    }

    // The hint rate: ONE server constant, and no server file open-codes it.
    const rateM = /const HINT_DEDUCTION_RATE\s*=\s*([\d.]+)/.exec(scoringSrc);
    expect(rateM, "lib/scoring.js must define HINT_DEDUCTION_RATE").toBeTruthy();
    const RATE = Number(rateM[1]);
    expect(RATE, "the parsed rate must equal the exported value").toBe(scoring.HINT_DEDUCTION_RATE);
    for (const f of ["routes/participant.js", "routes/challenges.js", "server.js"]) {
      const src = strip(read(f));
      expect(/Math\.round\([^)]*\*\s*0\.\d+\s*\)/.test(src),
        `${f} open-codes a hint multiplier — import HINT_DEDUCTION_RATE from lib/scoring. ` +
        `A fifth site added later would otherwise charge a different rate silently.`).toBe(false);
      expect(src, `${f} must reference HINT_DEDUCTION_RATE`).toContain("HINT_DEDUCTION_RATE");
    }
    // The client preview — the price quoted before the participant spends it.
    const clientM = /Math\.round\(DIFF_PTS\[t\.difficulty\]\s*\*\s*([\d.]+)\)/.exec(
      strip(read("public/js/features/participant-tasks.js")));
    expect(clientM, "the client hint-cost preview must exist").toBeTruthy();
    expect(Number(clientM[1]),
      "the client hint-cost PREVIEW quotes a rate the server does not charge"
    ).toBe(RATE);
    // …and the COPY must state the rate it actually charges. "30% deduction"
    // beside a 25% charge is a wrong answer, not a stale string.
    const pctM = /(\d+)%\s*deduction/.exec(strip(read("public/js/features/participant-tasks.js")));
    expect(pctM, "the hint affordance must state the deduction rate").toBeTruthy();
    expect(Number(pctM[1]), "the hint copy quotes a percentage it does not charge")
      .toBe(Math.round(RATE * 100));
  });

  test("v7.24.0: the task-number comparator is mirrored, not re-invented", () => {
    // THE SAME CLASS AS DIFF_PTS ABOVE. `task_number` is TEXT of the form
    // "<level>.<NN>", and TWO runtimes now order by it: the server, sorting the
    // competition-activity CSV (routes/export-import.js), and the browser,
    // sorting the analytics per-challenge table. `public/js` is a browser-only
    // ESM graph and cannot import lib/, so the client copy is irreducible.
    //
    // Drift here is silent and produces two DIFFERENT orderings of the same
    // competition on two screens an admin reads side by side — and the two
    // cases that break are exactly the ones nobody writes a test for by
    // accident: a bucket past 99, where the two-digit zero-padding runs out and
    // "1.100" sorts before "1.99" as text; and a BLANK number, which a naive
    // comparator floats to the TOP of a list sorted by number.
    //
    // So the two BODIES are required to be byte-identical, which is a stronger
    // and cheaper claim than "both look right". Numeric behaviour itself is
    // pinned behaviourally on the client side by
    // tests/analytics-sort-export.spec.js (the 1.10 / 1.99 / 1.100 fixture) —
    // this lock is what carries that proof across to the server twin.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const read = f => fs.readFileSync(pathMod.join(root, f), "utf8");
    const SITES = ["lib/competitions.js", "public/js/ui/format.js"];
    const bodies = SITES.map(f => {
      const src = read(f);
      const i = src.indexOf("function compareTaskNumbers(a, b) {");
      expect(i, `${f}: compareTaskNumbers is gone — it moved or changed signature`).toBeGreaterThan(-1);
      const j = src.indexOf("\n}", i);
      expect(j, `${f}: compareTaskNumbers has no closing brace at column 0`).toBeGreaterThan(i);
      return src.slice(i, j + 2);
    });
    expect(bodies[1],
      `compareTaskNumbers has DRIFTED between ${SITES[0]} and ${SITES[1]}. ` +
      "They order the same values on two screens an admin reads together, so they must be identical.")
      .toBe(bodies[0]);

    // Anti-vacuity: the shared body must actually be the numeric, blanks-last
    // implementation rather than any two matching stubs. Both properties are
    // load-bearing and both were regressions waiting to happen.
    expect(/Number\.isFinite/.test(bodies[0]),
      "the comparator must compare segments NUMERICALLY — a string sort puts 1.100 before 1.99").toBeTruthy();
    expect(/if \(!sa \|\| !sb\) return sa \? -1 : sb \? 1 : 0;/.test(bodies[0]),
      "the comparator must sort BLANK numbers last").toBeTruthy();
  });

  test("v7.24.0: the CSV formula-neutralisation rule is mirrored, not re-invented", () => {
    // THE SHARPEST OF THE THREE MIRRORS, because drift here is a SECURITY
    // regression rather than a cosmetic one. `lib/csv.js` (server) and
    // `public/js/ui/csv.js` (browser) both decide whether a cell is a
    // spreadsheet formula, and they cannot share code — `public/js` is a
    // browser-only ESM graph. Quoting does NOT neutralise (the quotes are the
    // delimiter and are stripped before type inference), so this leading
    // apostrophe is the whole defence, and both files write participant- and
    // admin-authored text into files admins open.
    //
    // The failure mode is silent and one-sided: a report arrives that some
    // spreadsheet also evaluates a leading `|`, the SERVER set gains it, the
    // client copy is not touched because nothing points at it, and the suite
    // stays green while one of the two downloads is unguarded against the
    // character the other now blocks.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const read = f => fs.readFileSync(pathMod.join(root, f), "utf8");
    const SITES = ["lib/csv.js", "public/js/ui/csv.js"];

    // The trigger SET, compared as source text — both files spell it with
    // double quotes so the literal is directly comparable (the DIFF_PTS
    // precedent: extract, never re-type the value here, or this lock becomes a
    // third copy to keep in step).
    const triggers = SITES.map(f => {
      const m = /const FORMULA_TRIGGERS = \[[^\]]*\];/.exec(read(f));
      expect(m, `${f}: the FORMULA_TRIGGERS literal is gone — it moved or changed shape`).toBeTruthy();
      return m[0];
    });
    expect(triggers[1],
      `FORMULA_TRIGGERS has DRIFTED between ${SITES[0]} and ${SITES[1]}. Both decide whether a ` +
      "cell is a formula, in files an admin opens in Excel.").toBe(triggers[0]);

    // …and the DECISION, byte for byte. A matching trigger set is worth nothing
    // if one side stopped consulting it, or tests a different character
    // position (leading whitespace is stripped by the spreadsheet before it
    // decides, which is the reason TAB and CR are in the set at all).
    const bodies = SITES.map(f => {
      const src = read(f);
      const i = src.indexOf("function neutraliseFormula(s) {");
      expect(i, `${f}: neutraliseFormula is gone — it moved or changed signature`).toBeGreaterThan(-1);
      const j = src.indexOf("\n}", i);
      return src.slice(i, j + 2);
    });
    expect(bodies[1],
      `neutraliseFormula has DRIFTED between ${SITES[0]} and ${SITES[1]}.`).toBe(bodies[0]);

    // Anti-vacuity: two matching stubs must not pass. The shared body has to
    // actually skip leading whitespace and prefix an apostrophe.
    expect(/\^\[\\s\\u00a0\]\+/.test(bodies[0]),
      "neutraliseFormula must skip LEADING WHITESPACE before testing the first character — " +
      "a spreadsheet strips it before deciding, so ' =1+1' is a formula").toBeTruthy();
    expect(/"'" \+ s/.test(bodies[0]),
      "neutraliseFormula must prefix an apostrophe — quoting alone does not neutralise").toBeTruthy();

    // The client default must be the SAFE one. A new export added later gets
    // neutralisation for free; a column that must stay raw is named by header
    // label at its own call site (`exemptColumns`, below) — no caller turns
    // neutralisation off for a whole table any more.
    const clientSrc = read("public/js/ui/csv.js");
    expect(/csvCell\(v,\s*\{\s*neutralise\s*=\s*true\s*\}\s*=\s*\{\}\)/.test(clientSrc),
      "ui/csv.js csvCell must DEFAULT to neutralising — a fail-open default in a shared writer " +
      "means the next download ships unguarded by omission").toBeTruthy();
    // v8.12.4 — the participants CSV exempts ONE column (Phone, v8.3.17 F2), at
    // its call site. The old assertion looked for `neutralise:false`, which since
    // then appears only in the comment explaining why it was REMOVED — so it
    // passed on the comment. Comments are stripped before both checks now.
    const expSrc = read("public/js/features/export-import.js")
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(/exemptColumns:\s*\[\s*['"]Phone['"]\s*\]/.test(expSrc),
      "the participants CSV exempts exactly the Phone column, at its call site").toBeTruthy();
    expect(/neutralise:\s*false/.test(expSrc),
      "and no call site switches neutralisation off wholesale").toBe(false);
  });

  test("v8.3.20: the IP-ban alert's recipient list carries each superadmin's TIMEZONE", () => {
    // The wiring that makes the per-recipient rendering possible, and the one
    // half of it a behavioural test cannot reach: `deliverAlert` takes its
    // collaborators through `deps` precisely so the unit tests can drive it
    // without a session table or an SMTP hop, so every one of them injects a
    // FAKE recipient list — reverting the real SELECT to bare emails leaves
    // tests/ip-ban-alerts.api.spec.js entirely green (measured). Nor can it be
    // driven end to end: the shared test server's relay is dead and
    // `user_events.email_sent` records no body (v7.26.0), so nothing observable
    // distinguishes a UTC body from a Melbourne one.
    const fs = require("fs");
    const pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
    const server = strip(fs.readFileSync(pathMod.join(root, "server.js"), "utf8"));
    const alerts = strip(fs.readFileSync(pathMod.join(root, "lib", "admin-alerts.js"), "utf8"));

    // The row must CARRY the zone…
    expect(server, "the superadmin recipient query must select `timezone` — without it every alert renders in UTC")
      .toMatch(/SELECT\s+email,\s*timezone\s+FROM users WHERE role='superadmin'/);
    // …and must not be flattened back to strings on the way out.
    expect(server, "…and the rows must reach deliverAlert intact, not mapped down to addresses")
      .not.toMatch(/role='superadmin'[\s\S]{0,400}?\.map\(\s*r\s*=>\s*r\.email\s*\)/);
    // The copy must ASK for it, through the shared formatter every other mail
    // uses rather than a second hand-rolled one.
    expect(alerts, "alertCopy must take a timezone").toMatch(/function alertCopy\(alert, baseUrl, tz\)/);
    expect(alerts, "…and render the deadline through lib/time's formatEmailDate")
      .toMatch(/formatEmailDate\(new Date\(alert\.blocked_until\), tz\)/);
    expect(alerts, "no hand-rolled date format may come back — this was the one mail that had one")
      .not.toMatch(/toLocaleString/);
    // And the body must be built PER RECIPIENT, or the zone has nowhere to go.
    expect(alerts, "the fan-out must render alertCopy inside the per-recipient loop")
      .toMatch(/alertCopy\(alert, baseUrl, tz\)/);
  });

  test("v8.3.20: no request handler awaits cxOneProvisionUser — every trigger goes through the queue", () => {
    // Both invitation-registration paths ran `for (const cid of compIds) await
    // cxOneProvisionUser(...)` AFTER the account had committed, each directly
    // under a comment claiming the work was "best-effort and async … so a slow
    // upstream can't block". `cxOneProvisionUser` makes 2-6 sequential upstream
    // hops, each with its own 10 s EXTERNAL_FETCH_TIMEOUT_MS deadline that covers
    // the BODY since v7.15.12, and the competition list carries no cap — so one
    // merely-slow competition outlasts the SPA's own 30 s abort and the invitee
    // is told to try again on an account that already exists. On the LinkedIn
    // door the session is established BELOW the loop, so it cost them the sign-in
    // too, on a top-level navigation with no client-side abort.
    //
    // A BEHAVIOURAL TEST CANNOT REACH THIS. `CXONE_HOSTNAME_ALLOWED` restricts
    // the issuer to checkmarx.net/.com, so no localhost IDP can be stood up —
    // the same reason functional-security-c gives for CxOne having no
    // integration test. The shared test server has no CxOne key either, so
    // `getCxOneConfig` returns null and today's loop costs microseconds: NOTHING
    // in the suite would go red. Hence a source lock.
    const fs = require("fs");
    const pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const files = [
      pathMod.join(root, "server.js"),
      ...fs.readdirSync(pathMod.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => pathMod.join(root, "routes", f)),
      ...fs.readdirSync(pathMod.join(root, "lib")).filter(f => f.endsWith(".js")).map(f => pathMod.join(root, "lib", f)),
    ];
    // Strip comments first: the fix's own comment NAMES `cxOneProvisionUser`
    // while explaining why nothing awaits it any more.
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

    const offenders = [];
    let enqueueSites = 0;
    for (const f of files) {
      const rel = pathMod.relative(root, f);
      const src = strip(fs.readFileSync(f, "utf8"));
      enqueueSites += (src.match(/enqueueCxOneProvision\s*\(/g) || []).length;
      // lib/cxone.js is the ONE legitimate awaiter — it is the queue worker.
      if (rel === "lib/cxone.js") continue;
      src.split("\n").forEach((line, i) => {
        if (/await\s+cxOneProvisionUser\s*\(/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    // ANTI-VACUITY FLOOR. Rename the queue entry point and both halves of this
    // scanner match nothing and pass in silence — the exact failure it exists to
    // catch. Measured: 6 call sites + the definition + the export.
    expect(enqueueSites, "no enqueueCxOneProvision call sites found — the symbol has been renamed and this scanner has gone blind").toBeGreaterThanOrEqual(4);
    expect(
      offenders,
      "a request handler awaits CxOne provisioning. That is 2-6 sequential upstream hops at up to " +
      "10 s each, held open AFTER the account has committed, so a degraded IDP turns a succeeded " +
      "registration into a reported failure. Use enqueueCxOneProvision (lib/cxone.js) — the bounded " +
      "queue every other trigger uses, which is also what makes the work countable at shutdown",
    ).toEqual([]);
  });

  test("v8.3.20: every asset a server-rendered page links resolves to something the server serves", () => {
    // THE DEFECT THIS CATCHES, and it shipped for four releases: the
    // /confirm-email confirmation form linked `/verify-page.css` (singular),
    // which v7.23.11 DELETED when the two forked sheets converged. The page a
    // participant meets on every successful email change rendered completely
    // unstyled — both logos painted at once, the icon vanished, the card had no
    // background — while the SAME handler's REFUSAL branches, built by
    // `_emailResultPage`, linked the correct plural name and looked fine. The
    // endpoint was styled when it turned you away and broken when it worked.
    //
    // Three observers looked straight at it and missed it. The browser test
    // written FOR this page asserts exactly the right things — one
    // `link[rel=stylesheet]` and a non-transparent `.card` — but drives
    // `?code=not-a-real-code`, i.e. the OTHER branch. The standalone-stylesheet
    // floor lock globs `public/` from the DISK side, so it answers "does every
    // file that exists meet the bar?" and structurally cannot answer "does every
    // reference point at a file that exists?". And no screenshot surface covers
    // the page at all. So the guard has to be mechanical and has to run in the
    // inverse direction: from the REFERENCE to the file.
    const fs = require("fs");
    const pathMod = require("path");
    const root = pathMod.join(__dirname, "..");

    const files = [
      pathMod.join(root, "server.js"),
      ...fs.readdirSync(pathMod.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => pathMod.join(root, "routes", f)),
      ...fs.readdirSync(pathMod.join(root, "lib")).filter(f => f.endsWith(".js")).map(f => pathMod.join(root, "lib", f)),
    ];
    // STRIP COMMENTS FIRST. `verify-page.css` appears in prose in
    // public/verify-pages.css and in this very file; a comment naming the
    // forbidden spelling has defeated three scanners in this repo already.
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
    const EXT = /\.(css|js|svg|png|webp|woff2|ico|jpe?g|gif)$/i;
    const refs = new Map();   // url -> first file that emits it
    for (const f of files) {
      const src = strip(fs.readFileSync(f, "utf8"));
      for (const m of src.matchAll(/(?:href|src)\s*=\s*\\?["\u0027](\/[^"\u0027`${}\s]+)\\?["\u0027]/g)) {
        if (EXT.test(m[1]) && !refs.has(m[1])) refs.set(m[1], pathMod.relative(root, f));
      }
    }

    // ANTI-VACUITY FLOOR. The emitting idiom is a template literal; rename it,
    // or reshape how these pages are built, and the regex matches nothing and
    // passes in silence — which is precisely the failure it exists to catch.
    // Measured: 7 distinct references today (8 before the /verify-page.css fix).
    expect(refs.size, "no server-rendered asset references found — the extractor has rotted").toBeGreaterThanOrEqual(6);

    // BOTH ARMS ARE REQUIRED, and the second is the scanner-wrongness rule paid
    // in advance rather than after: `/asset-versions.js` is generated by a real
    // route and has no file on disk, so a disk-only scanner would be red against
    // working code the first time a server-rendered page linked it.
    const routeSrc = files.map(f => strip(fs.readFileSync(f, "utf8"))).join("\n");
    const unresolved = [];
    for (const [url, from] of refs) {
      const rel = url.replace(/^\//, "").split("?")[0];
      const onDisk = fs.existsSync(pathMod.join(root, "public", rel));
      const routed = new RegExp(`app\\.get\\(\\s*["\u0027]${url.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")}["\u0027]`).test(routeSrc);
      if (!onDisk && !routed) unresolved.push(`${url}  (emitted by ${from})`);
    }
    expect(
      unresolved,
      "these URLs are linked by a server-rendered page but resolve to neither a file in public/ nor a registered route — " +
      "the page will serve a 404 for them and render unstyled or unbranded",
    ).toEqual([]);
  });

  test("v8.3.20: a backup directory is written once and marks its own completion", () => {
    // Two defects, both about a destination that already holds a backup. The
    // output goes straight into its final location with no completion marker, so
    // an interrupted run — a failed copy or a full disk under `set -e` — left a
    // FRESH database beside the PREVIOUS run’s logs and metadata,
    // indistinguishable from a good backup. And because nothing deletes, a second
    // run into the same destination RESURRECTS files the retention purge removed.
    //
    // Locked at SOURCE rather than by running the script: it requires the
    // sqlite3 CLI, which the shipped image deliberately does not carry (the app
    // reaches SQLite through the better-sqlite3 addon), so backup.sh runs on the
    // HOST and a spec cannot assume it is installed.
    const fs = require("fs");
    const pathMod = require("path");
    const script = fs.readFileSync(pathMod.join(__dirname, "..", "scripts", "backup.sh"), "utf8");
    const code = require("./doc-registry").stripShellComments(script);

    // It refuses a destination that already holds a backup, with an escape hatch.
    expect(code, "backup.sh must refuse a destination that already holds a backup").toMatch(/already holds a backup/);
    expect(code, "…detected by an artefact only a completed backup leaves").toMatch(/OUT_DIR\/BACKUP_METADATA\.txt/);
    expect(code, "…with a documented override, so a deliberate overwrite stays possible").toMatch(/--reuse/);

    // The marker is CLEARED before any writing and WRITTEN last. Both halves
    // matter: without the clear, a --reuse run over a completed backup would
    // carry the old marker through an abort.
    const clearAt = code.indexOf('rm -f "$OUT_DIR/BACKUP_COMPLETE"');
    const writeAt = code.indexOf('> "$OUT_DIR/BACKUP_COMPLETE"');
    expect(clearAt, "backup.sh must CLEAR any completion marker before it writes anything").toBeGreaterThan(-1);
    expect(writeAt, "backup.sh must WRITE a completion marker").toBeGreaterThan(-1);
    expect(writeAt, "the marker must be written AFTER it is cleared, i.e. last").toBeGreaterThan(clearAt);
    // And every copy step must sit between the two, or an abort could still
    // leave a marked-complete directory.
    // `> "$OUT_DIR/BACKUP_METADATA.txt"` — the WRITE, not the bare name. The bare
    // name also appears in the refusal guard near the top of the script, which
    // by construction precedes every write, so this iteration asserted a
    // tautology: it passed even with the metadata block moved BELOW the
    // completion marker, i.e. against exactly the marked-complete-but-incomplete
    // shape this lock exists for.
    // The copies run through `_copy_tree` and the snapshot through
    // `_snapshot_db`, so each step is the CALL, matched as a whole command line:
    // a bare indexOf('.backup') lands in the function body, which stays put
    // when the call is deleted. The helper idiom and the snapshot's body are
    // pinned separately below.
    const lines = code.split("\n");
    const callAt = (re) => { const i = lines.findIndex(l => re.test(l)); return i < 0 ? -1 : lines.slice(0, i).join("\n").length; };
    for (const [step, re] of [
      ["_copy_tree attachments", /^\s*_copy_tree attachments\s/],
      ["_copy_tree attachments-staging", /^\s*_copy_tree attachments-staging\s/],
      ["_snapshot_db", /^\s*_snapshot_db\s*$/],
      ["_reconcile_attachments", /^\s*_reconcile_attachments\s*$/],
      ["_copy_tree logs", /^\s*_copy_tree logs\s/],
    ]) {
      const at = callAt(re);
      expect(at, `backup.sh must still perform: ${step}`).toBeGreaterThan(-1);
      expect(at, `${step} must run BEFORE the completion marker is written`).toBeLessThan(writeAt);
    }
    const metaAt = code.indexOf('> "$OUT_DIR/BACKUP_METADATA.txt"');
    expect(metaAt, 'backup.sh must still perform: > "$OUT_DIR/BACKUP_METADATA.txt"').toBeGreaterThan(-1);
    expect(metaAt, "the metadata must be written BEFORE the completion marker").toBeLessThan(writeAt);
    expect(code, "the copy helper really copies the tree it is named for")
      .toMatch(/^_copy_tree\(\) \{[\s\S]*?rsync -a "\$DATA_DIR\/\$name\/" "\$OUT_DIR\/\$name\/"[\s\S]*?^\}/m);
    expect((/^_snapshot_db\(\) \{([\s\S]*?)^\}/m.exec(code) || [])[1] || "", "the snapshot function holds the online backup")
      .toMatch(/^\s*sqlite3 [^\n]*"\$SRC" "\.backup '\$DST'"/m);
    // The restorer is told what the marker means — a marker nobody is told to
    // check is bookkeeping, not a guard.
    expect(script, "RESTORE.txt must tell the operator to check BACKUP_COMPLETE").toMatch(/BACKUP_COMPLETE/);
  });

  test("v7.21.34: every DATA_DIR-resident path is covered or exempted by scripts/backup.sh", () => {
    // THE DRIFT THIS CATCHES, which already happened once: `attachments-staging`
    // was added under DATA_DIR by the attachment-staging work and never reached
    // scripts/backup.sh, so a restore produced task_attachments_staging rows
    // pointing at files that no longer existed. Nothing errors when a new
    // DATA_DIR child is added — the backup simply stops being complete, silently
    // — so the guard has to be mechanical.
    //
    // The script carries a COVERAGE MANIFEST of `BACKUP_COVERS:` /
    // `BACKUP_EXEMPT:` lines. Requiring a decision (rather than requiring a
    // copy) is deliberate: .superadmin-password and .maintenance MUST NOT be
    // backed up, and a scanner that demanded coverage of everything would be
    // wrong about working code — which is how scanners get silenced.
    const fs = require("fs");
    const path = require("path");
    const root = path.resolve(__dirname, "..");
    const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

    const sources = [
      "server.js", "db.js",
      ...fs.readdirSync(path.join(root, "lib")).filter((f) => f.endsWith(".js")).map((f) => `lib/${f}`),
      ...fs.readdirSync(path.join(root, "routes")).filter((f) => f.endsWith(".js")).map((f) => `routes/${f}`),
    ];

    // Only LITERAL children are enumerable. A path built from a variable
    // (routes/challenges.js resolves storage_path at runtime) lives under
    // attachments/ or attachments-staging/, both already in the manifest.
    const declared = new Set();
    for (const rel of sources) {
      for (const m of read(rel).matchAll(/DATA_DIR,\s*"([^"]+)"/g)) declared.add(m[1]);
    }
    expect(declared.size, "no DATA_DIR children found — the extractor regex has rotted").toBeGreaterThan(4);

    const script = read("scripts/backup.sh");
    const covers = new Set([...script.matchAll(/BACKUP_COVERS:\s*(\S+)/g)].map((m) => m[1]));
    const exempt = new Set([...script.matchAll(/BACKUP_EXEMPT:\s*(\S+)/g)].map((m) => m[1]));

    const undecided = [...declared].filter((n) => !covers.has(n) && !exempt.has(n)).sort();
    expect(
      undecided,
      `these paths live under DATA_DIR but scripts/backup.sh neither copies nor exempts them — ` +
      `add a "# BACKUP_COVERS: <name>" line plus a copy step, or "# BACKUP_EXEMPT: <name> — <why>"`,
    ).toEqual([]);

    // A manifest entry that no source declares is stale bookkeeping — it would
    // let a genuinely-missing path hide behind a name nothing uses any more.
    const orphaned = [...covers, ...exempt].filter((n) => !declared.has(n)).sort();
    expect(orphaned, "scripts/backup.sh lists paths no source declares under DATA_DIR").toEqual([]);

    // COVERS is a promise the script actually copies it — a marker alone is a
    // lie the manifest would otherwise tell. Every covered name must appear in
    // a real command, not only in a comment.
    //
    // v8.3.20 — the membership test is WORD-BOUNDED, and that is not tidiness.
    // A bare `includes("$DATA_DIR/attachments")` is satisfied by the string
    // `$DATA_DIR/attachments-staging`, so DELETING THE ENTIRE attachments copy
    // block left this scanner green on all six covered names — measured. Both
    // arms were satisfied by the substring, so the `in <name>` fallback did not
    // save it either. A prefix must not vouch for its own longer sibling.
    //
    // The directory copies go through one helper, `_copy_tree <name> …`, so a
    // covered name may also be satisfied by a word-bounded CALL of it, but only
    // while the helper really rsyncs `$DATA_DIR/$name/`. The `for … in <list>`
    // form is matched as a for-list, not as the word "in": the bare
    // `in\s+<name>\b` this used to accept was satisfied by prose such as
    // "in attachments-staging" (`\b` stops at the `-`) and by the helper's own
    // `case "$name" in attachments|…`, so a deleted attachments copy passed
    // (measured).
    const withoutComments = require("./doc-registry").stripShellComments(script);
    const _esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const _copyHelper = /^_copy_tree\(\) \{[\s\S]*?rsync -a "\$DATA_DIR\/\$name\/" "\$OUT_DIR\/\$name\/"[\s\S]*?^\}/m.test(withoutComments);
    expect(_copyHelper, "anti-vacuity: backup.sh's _copy_tree helper still rsyncs $DATA_DIR/$name/").toBe(true);
    for (const name of covers) {
      expect(
        new RegExp(`\\$DATA_DIR/${_esc(name)}(?![\\w.-])`).test(withoutComments)
          || (_copyHelper && new RegExp(`^\\s*_copy_tree\\s+${_esc(name)}(?![\\w.-])`, "m").test(withoutComments))
          || new RegExp(`\\bfor\\s+\\w+\\s+in\\s+[^;\\n]*\\b${_esc(name)}(?![\\w.-])`).test(withoutComments),
        `scripts/backup.sh declares BACKUP_COVERS: ${name} but never reads $DATA_DIR/${name}`,
      ).toBe(true);
    }

    // The restore guidance must keep telling operators to clear the stale WAL.
    // Measured with the real sqlite3 CLI: skipping it restored a 1-row snapshot
    // as 201 rows, with PRAGMA integrity_check still reporting `ok` — a silent
    // non-restore, and only after an UNCLEAN stop, which is when you restore.
    //
    // Assert the RECIPE, not the word. A first draft matched /hackathon\.db-wal/
    // anywhere in each file and passed against both mutations, because the prose
    // explaining the hazard contains the string too — the vacuous-lock shape.
    expect(script, "backup.sh must ship RESTORE.txt with the backup").toMatch(/RESTORE\.txt/);
    const heredoc = /<<RESTORE\n([\s\S]*?)\nRESTORE\n/.exec(script);
    expect(heredoc, "the RESTORE.txt heredoc must exist").toBeTruthy();
    expect(
      heredoc[1],
      "RESTORE.txt must carry an actual `rm -f` naming BOTH hackathon.db-wal and hackathon.db-shm",
    ).toMatch(/rm -f[^\n]*hackathon\.db-wal[^\n]*hackathon\.db-shm/);

    // Every README recipe that copies a snapshot ONTO hackathon.db must clear
    // the WAL in the same block. Scoped to `cp`-shaped restores on purpose: the
    // rsync recipe is safe by construction (--delete removes the stale files),
    // so demanding an explicit rm there would be a scanner wrong about working
    // code. Consolidating the recipes later keeps passing; dropping the rm does not.
    const readme = read("README.md");
    // Accept ANY language tag. A first draft allowed only ```bash/```sh, which
    // meant the ```env and ```cron blocks did not match as openers — so fence
    // pairing went out of phase and the scanner found zero recipes, i.e. it
    // would have passed no matter what the restore steps said.
    const blocks = [...readme.matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
    const restoreBlocks = blocks.filter((b) => /^\s*cp\s+\S+\s+\S*\/hackathon\.db\s*$/m.test(b));
    expect(restoreBlocks.length, "no cp-based restore recipe found in README — did it move?").toBeGreaterThan(0);
    for (const b of restoreBlocks) {
      expect(
        /rm -f[^\n]*hackathon\.db-wal/.test(b),
        "a README recipe copies a snapshot onto hackathon.db without first removing the stale " +
        "hackathon.db-wal/-shm — measured, that silently restores the PRE-backup state and " +
        `integrity_check still says ok. Offending block:\n${b}`,
      ).toBe(true);
    }
  });

  test("v7.21.13: the deduped helpers are not re-invented", () => {
    // THE CLASS this patch is about. Every item below existed as an identical
    // (or near-identical) literal in two-to-five files. None of them errors when
    // a copy drifts — the code still runs, it just answers differently in one
    // place — so the only durable guard is a scanner that fails when a second
    // definition reappears. Same shape as the v7.21.6 scoring-ladder lock.
    //
    // Two of these HAD already drifted, which is the argument for the rest:
    //   • LOG_SKIP_IPS re-implemented parseIpAllowlist and never learnt
    //     v7.20.9's canonicalisation, so an IPv6 entry written the other way
    //     round silently failed to skip.
    //   • POST /api/login re-implemented the participant competition list and
    //     never learnt v6.9.17's batched slot load, so it paid 2N indexed
    //     SELECTs on the one path a whole cohort hits at once.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const read = f => fs.readFileSync(pathMod.join(root, f), "utf8");
    // Strip comments FIRST, preserving line count (v7.15.15 — the comment
    // explaining a fix once defeated the check for it, and several of the
    // comments added by THIS patch quote the very SQL being forbidden).
    const strip = src => src
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
      .split("\n").map(l => l.replace(/\/\/.*$/, "")).join("\n");

    const SERVER_FILES = ["server.js", "lib/competitions.js", "lib/leaderboard.js", "lib/util.js", "lib/config.js"]
      .concat(fs.readdirSync(pathMod.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`));
    const sources = new Map(SERVER_FILES.map(f => [f, strip(read(f))]));
    // Anti-vacuity: a scanner over a file list that has gone stale reports
    // "clean" forever. Prove the list is real and non-trivial.
    expect(SERVER_FILES.length).toBeGreaterThan(10);
    for (const f of SERVER_FILES) expect(sources.get(f).length, `${f} is empty — bad path?`).toBeGreaterThan(100);

    // Count files (not occurrences) containing a pattern, minus its owner.
    const owners = (re, owner) => SERVER_FILES.filter(f => f !== owner && re.test(sources.get(f)));

    // ── 1. Config constants ────────────────────────────────────────────────
    // All three were identical in every copy, which is exactly why a future
    // divergence would pass review: the reader has no reason to check.
    const config = require("../lib/config");
    for (const [name, re, val] of [
      ["BULK_ADMIN_MAX",     /const\s+BULK_ADMIN_MAX\s*=/,     config.BULK_ADMIN_MAX],
      ["CODE_EXPIRY_MS",     /const\s+CODE_EXPIRY_MS\s*=/,     config.CODE_EXPIRY_MS],
      ["PERF_SPAN_SLOW_MS",  /const\s+PERF_SPAN_SLOW_MS\s*=/,  config.PERF_SPAN_SLOW_MS],
    ]) {
      expect(val, `lib/config must export ${name}`).toBeTruthy();
      expect(owners(re, "lib/config.js"),
        `${name} is re-declared outside lib/config.js — import it from there instead.`).toEqual([]);
    }

    // ── 2. The IPv4/CIDR matcher ───────────────────────────────────────────
    // lib/util.js used to describe itself as "mirrors the LOG_SKIP_IPS parsing
    // in server.js". A mirror is not a shared implementation.
    expect(owners(/function\s+_ipv4ToInt\s*\(/, "lib/util.js"),
      "a second IPv4 parser exists — use parseIpAllowlist / ipAllowlistMatch from lib/util. " +
      "The LOG_SKIP_IPS copy is how v7.20.9's IP canonicalisation came to apply to only one " +
      "of the two allowlists.").toEqual([]);
    expect(strip(read("server.js")),
      "the access-log skip must go through the shared matcher"
    ).toMatch(/parseIpAllowlist\(process\.env\.LOG_SKIP_IPS/);

    // ── 3. The participant competition list ────────────────────────────────
    // The SELECT is the fingerprint: three files built it by hand, and the
    // status/effective_end computation that follows is where they diverged.
    const compListRe = /FROM competitions c\s+JOIN competition_users cu ON cu\.competition_id=c\.id/;
    expect(owners(compListRe, "lib/competitions.js"),
      "a second participant competition-list query exists — call " +
      "listParticipantCompetitions(). The login copy is the one that lost v6.9.17's " +
      "batched timeslot load, and it is the burst path.").toEqual([]);
    // …and the shared builder must still batch, or the extraction bought nothing.
    const compsSrc = sources.get("lib/competitions.js");
    expect(/FROM competition_timeslots WHERE competition_id IN \(\$\{ph\}\)/.test(compsSrc),
      "listParticipantCompetitions must batch-load timeslots in ONE query (v6.9.17)").toBe(true);
    expect(/competitionStatus\(c, slots\)/.test(compsSrc),
      "the batched slots must actually be PASSED to competitionStatus, or each call " +
      "re-issues getCompetitionTimeslots and the batch is dead weight").toBe(true);

    // ── 4. The all-solved gate ─────────────────────────────────────────────
    // v7.21.1 (A1) was five writers with four ideas of one rule. The numerator
    // (who counts) and the denominator (what counts) must move together.
    const taskCountRe = /COUNT\(\*\) as c FROM competition_tasks ct JOIN tasks t/;
    expect(owners(taskCountRe, "lib/competitions.js").filter(f => f !== "lib/leaderboard.js"),
      "the published-task count is written out longhand again — call publishedTaskCount(). " +
      "It is the DENOMINATOR of the all-solved decision.").toEqual([]);
    // The fingerprint is the PREDICATE, not the JOIN: routes/participants.js
    // joins competition_users to users for the admin picker, which deliberately
    // lists every member regardless of lifecycle. What must not be re-derived is
    // "who counts as an active, scoring participant" — ACTIVE_PARTICIPANT_SQL
    // interpolated into a competition_users query. lib/leaderboard.js is exempt
    // because it is the other legitimate consumer of that predicate: it needs
    // the full rows and FLAGS staff/benchmark rather than dropping them.
    const activePartRe = /competition_users cu[\s\S]{0,200}\$\{ACTIVE_PARTICIPANT_SQL\}/;
    expect(owners(activePartRe, "lib/competitions.js").filter(f => f !== "lib/leaderboard.js"),
      "the active-participant query is written out longhand again — call " +
      "scoringParticipantIds(). It is the NUMERATOR side of the same decision, and it " +
      "carries the v7.7.27 instant-join-grace rule plus the staff/benchmark exclusion.").toEqual([]);
    // Anti-vacuity for both: the owner must genuinely contain them, or the two
    // assertions above are satisfied by the patterns having been renamed away.
    expect(taskCountRe.test(compsSrc), "publishedTaskCount must contain the count query").toBe(true);
    expect(activePartRe.test(compsSrc), "scoringParticipantIds must contain the participant query").toBe(true);

    // ── 5. sameSlotEmails at every registration write path ─────────────────
    // Not a duplication — an OMISSION found by auditing the duplicates. The
    // helper's own comment claims every write site; this asserts it.
    for (const [f, what] of [
      ["routes/auth.js",         "POST /api/register"],
      ["routes/participant.js",  "PUT /api/me"],
      ["routes/participants.js", "the admin profile edit"],
      ["server.js",              "LinkedIn self-signup + the participant import"],
    ]) {
      expect(/sameSlotEmails\(/.test(sources.get(f)),
        `${what} (${f}) must reject primary == secondary. Neither NOCASE index catches ` +
        `it — they are per-COLUMN — so the row is created and the account bricks its own ` +
        `next profile save.`).toBe(true);
    }
  });

  test("v7.21.14: the docs describe the email change that actually happens", () => {
    // swagger's PUT /api/me description narrated the PRE-v7.5.0 mechanism in
    // detail — "flips `verified` back to 0 … destroys the current session …"
    // plus a whole paragraph about a 503 SMTP rollback — while the response
    // schema three lines below already said `emailChanged: false in the
    // pending-email model (v7.5.0)`. So the document contradicted itself, and
    // the half a reader reaches first was the retired half: an operator would
    // conclude that changing an email signs the user out.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    // Read swagger as TEXT, like every other lock in this file: a slice of the
    // PUT /api/me description is all this needs. (The one strict YAML parser in
    // the dependency tree is the `yaml` playwright-core bundles; the swagger
    // conformance spec parses the whole file with it.)
    const sw = fs.readFileSync(pathMod.join(root, "swagger.yaml"), "utf8");
    const meBlock = sw.slice(sw.indexOf("\n  /api/me:"));
    const putAt = meBlock.indexOf("\n    put:");
    expect(putAt, "PUT /api/me must be documented").toBeGreaterThan(-1);
    const desc = meBlock.slice(putAt, meBlock.indexOf("\n      requestBody:", putAt));
    expect(desc.length, "the PUT /api/me description slice must be non-trivial").toBeGreaterThan(200);

    // The retired mechanism, in the words it was described with.
    for (const gone of [
      "destroys the current session",
      "flips `verified` back to 0",
      "Email-change rollback on SMTP failure",
    ]) {
      expect(desc.includes(gone),
        `PUT /api/me still documents the pre-v7.5.0 email swap ("${gone}"). The change is ` +
        `STAGED in pending_email now and committed at /confirm-email — nothing is applied here, ` +
        `so there is no session teardown and nothing to roll back.`).toBe(false);
    }
    // …and the mechanism that IS in force.
    for (const present of ["pending_email", "confirm-email", "emailChangePending"]) {
      expect(desc.includes(present), `PUT /api/me must document the pending-email model (missing: ${present})`).toBe(true);
    }
    // Anti-vacuity: pin it against the SOURCE, so this cannot pass by the
    // documentation and the code drifting together in the other direction.
    const route = fs.readFileSync(pathMod.join(root, "routes/participant.js"), "utf8");
    expect(route, "the route must still stage rather than apply").toMatch(/UPDATE users SET pending_email=/);
    expect(route).toMatch(/emailChangePending:\s*true/);
  });

  test("v7.21.18: the dry-run tag is ONE string, mirrored not re-invented", () => {
    // The marker is a STORED VALUE, not a label: it is the row in
    // competition_tags, the default analytics exclusion, the permanent-tag
    // allowlist and the thing the badge route refuses on. It was spelled
    // "internal" in eight server places and nine client ones before v7.21.18,
    // and the client copy is irreducible — public/js is a browser-only ESM graph
    // and cannot import server code. So the server owns it, the client mirrors
    // it, and this diffs the two. A divergence would be silent: the tag would
    // still be written, and every reader would simply stop recognising it, which
    // reads as "the dry-run flag stopped working" with nothing in the logs.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const read = f => fs.readFileSync(pathMod.join(root, f), "utf8");

    const srvM = /const DRY_RUN_TAG = "([^"]+)"/.exec(read("lib/competitions.js"));
    expect(srvM, "lib/competitions.js must define DRY_RUN_TAG").toBeTruthy();
    const cliM = /export const DRY_RUN_TAG = '([^']+)'/.exec(read("public/js/ui/format.js"));
    expect(cliM, "public/js/ui/format.js must export the client mirror").toBeTruthy();
    expect(cliM[1], "the client mirror of DRY_RUN_TAG has drifted from the server value").toBe(srvM[1]);

    // Anti-vacuity: prove the regex read the value the server actually uses,
    // not some unrelated string that happens to match the shape.
    expect(srvM[1], "the tag is the renamed value").toBe("test/dry run");
    const comps = require("../lib/competitions");
    expect(comps.DRY_RUN_TAG, "the parsed value must equal the exported one").toBe(srvM[1]);

    // Two properties of the STRING that other machinery depends on, and which a
    // future rename could quietly break:
    expect(srvM[1].includes(","),
      "the analytics filter ships tags as a COMMA-joined query parameter, so a comma here " +
      "would split one tag into two").toBe(false);
    expect(srvM[1], "tag writes lowercase, so any other casing would not round-trip")
      .toBe(srvM[1].toLowerCase());

    // Nothing may go back to spelling it by hand. (Comments stripped first —
    // several added by this very patch quote the old name to explain the
    // rename, which is the v7.15.15 trap.)
    const strip = src => src
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
      .split("\n").map(l => l.replace(/\/\/.*$/, "")).join("\n");
    const offenders = [];
    const SOURCES = ["server.js", "db.js", "lib/competitions.js", "public/js/ui/format.js"]
      .concat(fs.readdirSync(pathMod.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`))
      .concat(fs.readdirSync(pathMod.join(root, "public/js/features")).map(f => `public/js/features/${f}`))
      .concat(["public/js/core/main.js"]);
    for (const f of SOURCES) {
      // db.js legitimately names the OLD value — that is what it migrates FROM.
      if (f === "db.js") continue;
      if (/['"]internal['"]/.test(strip(read(f)))) offenders.push(f);
    }
    expect(offenders,
      "these files still spell the dry-run tag literally — import DRY_RUN_TAG instead " +
      "(lib/competitions.js on the server, ui/format.js on the client)").toEqual([]);
  });

  test("only the rich editor writes contentEditable: a read-only body goes through setReadOnly, which switches its toolbar off with the reason", () => {
    // `createRichEditor` (ui/richtext.js) returns `setReadOnly(reason, {also})`, the
    // one writer of a body's editability after creation: it switches every toolbar
    // control off in the same step and states the reason under the bar. A body made
    // read-only any other way (the four document-wide sweeps this replaced) leaves
    // the toolbar live, every press accepted and ignored. Comments are stripped
    // first, with the shared stripper, which keeps strings whole.
    const fs = require("fs"), path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const ROOT = path.join(__dirname, "..");
    const PROP = "content" + "Editable";
    const WRITES = [
      new RegExp(`\\.\\s*${PROP}\\s*=(?!=)`),                                    // el.contentEditable = …
      new RegExp(`\\b(?:set|remove|toggle)Attribute\\s*\\(\\s*(['"\`])${PROP}\\1`, "i"), // …Attribute('contenteditable'
      new RegExp(`\\[\\s*(['"\`])${PROP}\\1\\s*\\]\\s*=(?!=)`),                // el['contentEditable'] = …
      new RegExp(`(?:^|[{,\\s])(['"]?)${PROP}\\1\\s*:`),                          // {contentEditable: …} (Object.assign)
      /\bdesignMode\s*=(?!=)/,                                                     // document.designMode = …
    ];
    const writes = (src) => WRITES.reduce((n, re) => n + (src.match(new RegExp(re.source, re.flags + "g")) || []).length, 0);
    // PLANTED CONTROLS: each write shape is seen, and a read or a comparison is not.
    for (const w of [`x.${PROP}='false'`, `x.${PROP} = v`, `x.setAttribute('contenteditable','false')`,
      `x.removeAttribute("contenteditable")`, `x.toggleAttribute('contentEditable')`, `x['${PROP}']='false'`,
      `Object.assign(x,{${PROP}:'false'})`, `document.designMode='on'`]) {
      expect(writes(w), `the matcher sees the write ${w}`).toBe(1);
    }
    for (const r of [`a.${PROP}==='true'`, `a.${PROP}!=='true'`, `a.${PROP}==b`, `b.isContentEditable`,
      `q('.rich-body[contenteditable="true"]')`, `x.getAttribute('contenteditable')`, `document.designMode==='on'`]) {
      expect(writes(r), `the matcher leaves the read ${r} alone`).toBe(0);
    }
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith(".js")) files.push(rel);
      }
    };
    walk("public/js");
    for (const f of fs.readdirSync(path.join(ROOT, "public"))) if (f.endsWith(".js")) files.push(path.join("public", f));
    expect(files.length, "anti-vacuity: the SPA module graph was found").toBeGreaterThan(30);
    const offenders = [];
    let editorWrites = 0;
    for (const rel of files) {
      const n = writes(stripJsComments(fs.readFileSync(path.join(ROOT, rel), "utf8")));
      if (rel === path.join("public", "js", "ui", "richtext.js")) editorWrites = n;
      else if (n) offenders.push(`${rel} (${n})`);
    }
    // Exactly two: the body's creation and setReadOnly. A third write anywhere in
    // ui/richtext.js (the file is exempt from the outside rule) would be a second writer.
    expect(editorWrites, "the editor's own writes: its creation and setReadOnly, and no other").toBe(2);
    expect(offenders, "these write a rich body's editability themselves: call the editor's setReadOnly(reason) instead").toEqual([]);
  });

  test("v8.8.15: every generated download goes through ui/download.js", () => {
    // Four call sites had grown four implementations with THREE ideas about when
    // to release the object URL, including one SYNCHRONOUS revoke — the shape
    // with a real mechanism against it, since the click is dispatched
    // synchronously and the browser reads the blob afterwards. The behavioural
    // half is tests/download-revoke.spec.js; this is the half that stops a FIFTH
    // appearing, which is how the four accumulated in the first place.
    //
    // The signature is `a.download = ...`, because that is what makes an anchor a
    // FILE SAVE rather than a link. Comments are stripped first: download.js's
    // own header quotes the shapes it replaces, and self-enroll.js's QR block
    // still explains the strategy it gave up (the v7.21.13 class — a comment
    // describing a fix defeating the check for it).
    const fs = require("fs"), path = require("path");
    const files = [];
    for (const dir of ["public/js/features", "public/js/ui", "public/js/core"]) {
      const abs = path.join(__dirname, "..", dir);
      if (!fs.existsSync(abs)) continue;
      for (const f of fs.readdirSync(abs)) if (f.endsWith(".js")) files.push(path.join(dir, f));
    }
    expect(files.length, "anti-vacuity: the SPA module graph was found").toBeGreaterThan(30);

    const offenders = [];
    let helperFound = false;
    for (const rel of files) {
      const src = _stripJsComments(fs.readFileSync(path.join(__dirname, "..", rel), "utf8"));
      if (rel.endsWith("ui/download.js")) {
        helperFound = true;
        continue; // the one place allowed to do it
      }
      if (/\.download\s*=/.test(src)) offenders.push(rel);
    }
    expect(helperFound, "anti-vacuity: ui/download.js is in the scanned set").toBe(true);
    expect(offenders,
      "these build their own a[download] instead of calling downloadBlob() from ui/download.js")
      .toEqual([]);

    // And the helper still does the two things the consolidation is FOR: it must
    // not revoke in the click's own tick, and it must not rely on `pagehide`
    // alone (which never fires in an SPA that does not navigate).
    const dl = fs.readFileSync(path.join(__dirname, "..", "public/js/ui/download.js"), "utf8");
    const dlCode = _stripJsComments(dl);
    expect(dlCode, "the release runs on a timer").toMatch(/setTimeout\s*\(\s*release/);
    expect(dlCode, "…and on pagehide").toMatch(/addEventListener\s*\(\s*['"]pagehide['"]\s*,\s*release/);
    expect(dlCode, "…and the timer is a real window, not a same-tick revoke")
      .toMatch(/DOWNLOAD_URL_TTL_MS/);
  });

  test("the any-script file-name slug lives once, in ui/download.js fileNameSlug", () => {
    // Operator ruling, 14 Nov 2026: a certificate file names its holder in any
    // script by ONE function, never a second copy (the issued PDF and PNG and the
    // Rankings top three's preview; the behaviour is tests/rankings-top-three.spec.js
    // and tests/certificate-designer-state.spec.js). Any script means a Unicode
    // property class, so the signature is the class, however it is spelled: a
    // matcher on the `.replace(class, '-')` idiom misses a class held in a
    // variable, long property names, a RegExp string and a split-and-join copy.
    // Every property escape (\p{…}, \P{…}) in the SPA and the classic scripts
    // beside it is a DECISION, listed in DECIDED with its reason and checked both
    // ways. A new one either names a person in a file name (import fileNameSlug
    // instead) or does something else (a word tokeniser, an emoji test) and is
    // listed with why. None is exempt by what it is passed to: a tokeniser's
    // spaces joined by hyphens would be a copy. A copy spelled with no property
    // class at all escapes this (CLAUDE.md *Stated gaps*).
    const fs = require("fs"), path = require("path");
    const PROP = /\\[pP]\{[^}\n]*\}/g;
    const count = (src) => (_stripJsComments(src).match(PROP) || []).length;
    for (const [what, src] of [
      ["the slug's own idiom", "s.replace(/[^\\p{L}\\p{M}\\p{N}]+/gu, '-')"],
      ["a class held in a variable", "const RUNS = /[^\\p{L}\\p{M}\\p{N}]+/gu;"],
      ["long property names", "s.replace(/[^\\p{Letter}\\p{Mark}\\p{Number}]+/gu, '-')"],
      ["decimal digits only", "s.replace(/[^\\p{L}\\p{Nd}]+/gu, '-')"],
      ["a RegExp string", "new RegExp('[^\\\\p{L}\\\\p{N}]+', 'gu')"],
      ["a split and join", "s.split(/[^\\p{L}\\p{N}]+/u).filter(Boolean).join('-')"],
      ["a word tokeniser, a decision too", "s.replace(/[^\\p{L}\\p{N}]+/gu, ' ')"],
    ]) expect(count(src), `control: ${what} is counted`).toBeGreaterThan(0);
    expect(count("s.replace(/[^a-z0-9]+/g, '-')"), "control: the ASCII event-name slug is no property class").toBe(0);
    expect(count("// s.replace(/[^\\p{L}]+/gu, '-')\n/* \\p{N} */ x"), "control: a class named in a comment is not counted").toBe(0);
    // Every property escape in the SPA, by file, and why it is there.
    const DECIDED = {
      "public/js/ui/download.js": { count: 3, why: "fileNameSlug itself: the letter, mark and number classes of the one any-script file-name rule" },
    };
    const files = [];
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(__dirname, "..", rel), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(r); else if (e.name.endsWith(".js")) files.push(r);
      }
    };
    walk("public/js");
    for (const e of fs.readdirSync(path.join(__dirname, "..", "public"), { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".js")) files.push(`public/${e.name}`);
    }
    expect(files.length, "anti-vacuity: the SPA module graph was found").toBeGreaterThan(30);
    expect(files, "anti-vacuity: the classic scripts beside it are scanned too").toContain("public/theme-boot.js");
    for (const [rel, d] of Object.entries(DECIDED)) expect(d.why.length, `${rel}: the decision states its reason`).toBeGreaterThanOrEqual(40);
    const hits = {};
    for (const rel of files) {
      const n = count(fs.readFileSync(path.join(__dirname, "..", rel), "utf8"));
      if (n) hits[rel] = n;
    }
    expect(hits, "a Unicode property class outside DECIDED: a person's name in a file name imports fileNameSlug " +
      "from ui/download.js; any other use is listed in DECIDED with its reason")
      .toEqual(Object.fromEntries(Object.entries(DECIDED).map(([rel, d]) => [rel, d.count])));
  });

  test("sweep #72: the server's fileNameSlug (lib/attachments.js, the top-three ZIP's names) is the client's, word for word, and behaves alike", () => {
    // public/js cannot be required by the server, so the top-three ZIP keeps the
    // one server copy of the any-script file-name rule (CLAUDE.md, Client/server
    // mirror registry). The two bodies are compared with comments stripped and
    // spaces collapsed, and the server's is run on names in other scripts.
    const fs = require("fs"), path = require("path");
    const body = (rel) => {
      const src = _stripJsComments(fs.readFileSync(path.join(__dirname, "..", rel), "utf8"));
      const m = src.match(/function fileNameSlug\([^)]*\)\s*\{[\s\S]*?\n\}/);
      expect(m, `${rel}: its fileNameSlug is found`).toBeTruthy();
      return m[0].replace(/\s+/g, " ").trim();
    };
    const client = body("public/js/ui/download.js"), server = body("lib/attachments.js");
    expect(server, "the server copy is the client's").toBe(client);
    expect(server.replace("\\p{L}\\p{M}\\p{N}", "a-z0-9"), "CONTROL: an ASCII-only copy is told apart").not.toBe(client);
    // eslint-disable-next-line no-new-func
    const slug = new Function(`return (${server});`)();
    expect(slug("张伟")).toBe("张伟");
    expect(slug("José García")).toBe("josé-garcía");
    expect(slug("Dr. Alexandria Konstantinopoulou", { max: 30 })).toBe("dr-alexandria-konstantinopoulo");
    expect(slug("!!!", { fallback: "finisher" })).toBe("finisher");
    expect(slug(null)).toBe("file");
  });

  test("v8.8.2: the public-domain tag is one string, mirrored and never re-spelled", () => {
    // The third arm of the event-admin challenge-visibility rule. It is reachable
    // ONLY by an exact string match in SQL, so a drift between the server
    // constant and the client chip that applies it would silently stop granting
    // visibility — with the tag still rendering on the row, which is what makes
    // the failure mode invisible. That is the defect this release fixed: the
    // value was previously typed by hand into a free-text box, where "public
    // domain" was accepted, stored and inert.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const read = f => fs.readFileSync(pathMod.join(root, f), "utf8");

    const srvM = /const PUBLIC_DOMAIN_TAG = "([^"]+)"/.exec(read("lib/event-admin.js"));
    expect(srvM, "lib/event-admin.js must define PUBLIC_DOMAIN_TAG").toBeTruthy();
    const cliM = /export const PUBLIC_DOMAIN_TAG = '([^']+)'/.exec(read("public/js/ui/format.js"));
    expect(cliM, "public/js/ui/format.js must export the client mirror").toBeTruthy();
    expect(cliM[1], "the client mirror of PUBLIC_DOMAIN_TAG has drifted from the server value").toBe(srvM[1]);

    // Anti-vacuity: prove the regex read the value the server actually uses.
    expect(srvM[1], "the tag is the documented value").toBe("public-domain");
    const ea = require("../lib/event-admin");
    expect(ea.PUBLIC_DOMAIN_TAG, "the parsed value must equal the exported one").toBe(srvM[1]);

    // Properties other machinery depends on. The lowercase one is why "Public-Domain"
    // round-trips correctly while "public domain" does not: tag writes lowercase but
    // do not touch separators.
    expect(srvM[1], "tag writes lowercase, so any other casing would not round-trip")
      .toBe(srvM[1].toLowerCase());
    expect(srvM[1].includes(","),
      "the analytics filter ships tags as a COMMA-joined query parameter").toBe(false);

    // v8.8.3 — THE NEAR-MISS PREDICATE IS MIRRORED TOO, and it decides a REFUSAL.
    //
    // The server refuses a tag that collapses onto the reserved one; the client
    // copy is what marks an already-stored near miss on the challenge row and
    // offers the one-click fix. A drift would put a Fix link on an ordinary tag,
    // or — worse — leave a genuinely inert tag unmarked, which is the state that
    // cannot be diagnosed from any screen: a SOFT HYPHEN or a ZERO-WIDTH SPACE
    // renders PIXEL-IDENTICALLY to the reserved value.
    const fnBody = (src, decl) => {
      const i = src.indexOf(decl);
      expect(i, `${decl} must exist`).toBeGreaterThan(-1);
      const open = src.indexOf("{", i);
      let depth = 0, j = open;
      for (; j < src.length; j++) { if (src[j] === "{") depth++; else if (src[j] === "}") { depth--; if (!depth) break; } }
      return src.slice(open + 1, j).replace(/['"]/g, "Q").replace(/\s+/g, " ").trim();
    };
    const srvBody = fnBody(read("lib/event-admin.js"), "function publicDomainNearMiss(tag)");
    const cliBody = fnBody(read("public/js/ui/format.js"), "export function publicDomainNearMiss(tag)");
    expect(cliBody, "the client mirror of publicDomainNearMiss has drifted from the server").toBe(srvBody);

    // Anti-vacuity: two matching STUBS would satisfy the diff above. The shared
    // body must actually collapse separators, and the shipped function must answer
    // correctly across the MEASURED confusable family — including the two variants
    // nobody can see on screen.
    expect(srvBody, "the shared body must collapse separators, not merely compare strings")
      .toContain("[^a-z0-9]");
    const nm = ea.publicDomainNearMiss;
    for (const inert of ["public domain", "publicdomain", "public_domain", "public–domain",
      "public—domain", "public‑domain", "public−domain", "public－domain",
      "public domain", "public­domain", "public​domain", "Public Domain"]) {
      expect(nm(inert), `${JSON.stringify(inert)} must be recognised as a near miss`).toBe(true);
    }
    for (const fine of ["public-domain", "public-domain-2024", "publicdomains", "category:public-domain",
      "staff", "needs:cxone", ""]) {
      expect(nm(fine), `${JSON.stringify(fine)} must NOT be flagged`).toBe(false);
    }

    // Nothing may go back to spelling it by hand. Comments are stripped first —
    // several added by this patch quote the string to explain the fix, which is
    // the v7.15.15 trap.
    const strip = src => src
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
      .split("\n").map(l => l.replace(/\/\/.*$/, "")).join("\n");
    const offenders = [];
    const SOURCES = ["server.js", "lib/event-admin.js", "public/js/ui/format.js"]
      .concat(fs.readdirSync(pathMod.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`))
      .concat(fs.readdirSync(pathMod.join(root, "public/js/features")).map(f => `public/js/features/${f}`))
      .concat(["public/js/core/main.js"]);
    for (const f of SOURCES) {
      // The two DEFINITIONS legitimately contain it.
      if (f === "lib/event-admin.js" || f === "public/js/ui/format.js") continue;
      if (/['"]public-domain['"]/.test(strip(read(f)))) offenders.push(f);
    }
    expect(offenders,
      "these files spell the public-domain tag literally — import PUBLIC_DOMAIN_TAG instead " +
      "(lib/event-admin.js on the server, ui/format.js on the client)").toEqual([]);
  });

  test("v7.21.14: no spec requires lib/email", () => {
    // A spec that required it killed the CI worker outright — "worker process
    // exited unexpectedly (code=1, signal=null)", both attempts, naming nothing
    // about the cause, and passing locally every time.
    //
    // lib/email does three things AT REQUIRE TIME that a Playwright worker must
    // not do: it requires ../db, which OPENS a SQLite database — and the
    // worker's DATA_DIR is not the test server's, so it is a different database
    // created on the spot, schema and migrations and all, once per worker; it
    // reads-or-WRITES DATA_DIR/.unsubscribe-secret; and it schedules an SMTP
    // probe. db.js can also process.exit(1) from a guarded migration.
    //
    // This is the narrow, checkable form of the v7.20.2 rule. That lock covers
    // MODULE-SCOPE requires of db-opening app code; this one covers lib/email
    // anywhere in a spec, including inside a test body, because its require-time
    // side effects are not merely a stale handle — they write files and open a
    // second database. If a test needs an unsubscribe token, build it with
    // `crypto` from DATA_DIR/.unsubscribe-secret (see the scrub test above).
    const fs = require("fs"), pathMod = require("path");
    const dir = __dirname;
    const offenders = [];
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith(".js"))) {
      const src = fs.readFileSync(pathMod.join(dir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
        .split("\n").map(l => l.replace(/\/\/.*$/, "")).join("\n");
      if (/require\(\s*["'](?:\.\.\/)+lib\/email(?:\.js)?["']\s*\)/.test(src)) offenders.push(f);
    }
    expect(offenders,
      "a spec requires lib/email — it opens a SECOND database, writes " +
      "DATA_DIR/.unsubscribe-secret and starts an SMTP probe at require time, and it took " +
      "down the CI worker with an error that named none of that. Build what you need with crypto."
    ).toEqual([]);
    // Anti-vacuity: the scanner must be looking at real files with real requires
    // in them, or an empty result means nothing.
    expect(fs.readdirSync(dir).filter(n => n.endsWith(".spec.js")).length).toBeGreaterThan(20);
    // v7.21.37 — was pinned to a single hard-coded filename, which broke the
    // moment that file was split (ENOENT, in a test whose subject is lib/email).
    // Ask the QUESTION instead of naming a file: at least one spec must match the
    // require shape, which proves the regex works without caring what specs exist.
    const anyRequiresHelpers = fs.readdirSync(dir).filter(n => n.endsWith(".spec.js"))
      .some(n => /require\(\s*["']\.\/helpers["']\s*\)/.test(fs.readFileSync(pathMod.join(dir, n), "utf8")));
    expect(anyRequiresHelpers, "the scanner's require regex shape works").toBe(true);
  });

  test("v7.21.14: the alert modal mirrors alertCopy branch for branch", () => {
    // lib/admin-alerts.js says alertCopy is shared by the modal and the email
    // "so the two cannot drift" — but only the EMAIL body is literally shared.
    // The modal is a hand-written mirror (its own header says "Mirrors
    // lib/admin-alerts.js alertCopy() branch for branch"), so a branch added on
    // one side and not the other means an admin reading the email on their
    // phone and the modal on their laptop is told two different things, in the
    // middle of the outage the alert exists to explain.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const server = fs.readFileSync(pathMod.join(root, "lib/admin-alerts.js"), "utf8");
    const client = fs.readFileSync(pathMod.join(root, "public/js/features/admin-alerts.js"), "utf8");

    for (const [what, srv, cli] of [
      ["already-trusted",  /already_trusted/,                    /already_trusted/],
      ["multi-session",    /accepts_trusted_ips/,                /accepts_trusted_ips/],
      ["no eligible event", /No Booth Event or Competition is currently live/, /No Booth Event or Competition is currently live/],
      ["the direct steps", /Trusted network IPs" and save/,      /Trusted network IPs<\/strong> and save/],
      // v7.25.0 — the classifier's verdict. An unmistakable scanner no longer
      // raises a notice at all, so whatever reaches the modal or the email is
      // ambiguous and both must say which way it leans.
      ["cohort verdict",   /answered by real pages of the platform/,  /answered by real pages of the platform/],
      ["mixed verdict",    /could be a scanner, a busy shared network, or both/, /could be a scanner, a busy shared network, or both/],
      // v8.3.20 — the mixed branch SPLIT on routed_4xx. `verdict` is derived
      // from the probe RATIO alone, so a walk that touched no real endpoint at
      // all lands in "mixed" — and the sentence above then asserted "some of it
      // reached real pages of the platform", which the classifier's own counter
      // contradicted. Both halves have to reach both channels, or an admin
      // reading the email on their phone and the modal on their laptop is told
      // two different things about the same block.
      ["pure-probe verdict", /All of that traffic was asking for things this platform does not have/,
                             /All of that traffic was asking for things this platform does not have/],
      // The reader the event PUT would refuse (`can_set_trusted_ips === false`)
      // is told who can take the advice, never to save.
      ["cannot change the event", /You cannot change the event "\$\{alert\.competition_name\}" yourself, so ask an administrator who can/,
                                  /You cannot change the event <strong>\$\{comp\}<\/strong> yourself, so ask an administrator who can/],
    ]) {
      expect(srv.test(server), `lib/admin-alerts.js lost the ${what} branch`).toBe(true);
      expect(cli.test(client), `the alert MODAL is missing the ${what} branch that the email has`).toBe(true);
    }
    // The multi-session branch's two substantive remedies must reach both.
    for (const phrase of ["only available on a single-session event", "RATE_LIMIT_ALLOWLIST_IPS"]) {
      expect(server.includes(phrase), `the alert email must offer: ${phrase}`).toBe(true);
      expect(client.includes(phrase), `the alert MODAL must offer the same remedy: ${phrase}`).toBe(true);
    }
  });

  test("v7.25.0: a SILENT scanner block still logs and still audits", () => {
    // The highest-value lock in this release, because the defect it prevents is
    // invisible: nothing errors, the block still happens, the record simply
    // stops existing. The obvious implementation of "block silently" wraps too
    // much — only `_raiseIpBanAlert` may sit inside the verdict gate.
    const fs = require("fs"), pathMod = require("path");
    // Comments only — NOT _stripJsForScan, which also blanks string literals,
    // and the two things being located here (`log.warn(` and the
    // "scanner_blocked" event type) are code carrying a literal.
    const src = _stripJsComments(fs.readFileSync(pathMod.join(__dirname, "..", "server.js"), "utf8"));
    const body = src.slice(src.indexOf("function _scannerRecord("));
    const end = body.indexOf("\nfunction _scannerBlockedIpCount");
    const fn = end > 0 ? body.slice(0, end) : body;

    // EXACTLY ONE silence gate. Without this the lock is satisfied by a SECOND
    // gate added around the audit emit — measured: that mutation passed.
    const gates = (fn.match(/if \(!verdict\.silent\)/g) || []).length;
    expect(gates, "there must be exactly one silence gate, and it may contain only the alert").toBe(1);
    const gate = fn.indexOf("if (!verdict.silent)");
    expect(gate, "the alert must be gated on the verdict").toBeGreaterThan(-1);
    const alertCall = fn.indexOf("_raiseIpBanAlert(");
    expect(alertCall, "the alert call sits inside the gate").toBeGreaterThan(gate);
    // The gate's block ends at the first closing brace at its own indentation.
    const gateEnd = fn.indexOf("\n    }", gate);
    expect(gateEnd).toBeGreaterThan(gate);
    expect(alertCall).toBeLessThan(gateEnd);

    for (const [what, needle] of [
      ["the warn-level log line", "log.warn("],
      ["the scanner_blocked audit event", '"scanner_blocked"'],
    ]) {
      const at = fn.indexOf(needle);
      expect(at, `${what} must exist`).toBeGreaterThan(-1);
      expect(at, `${what} must sit OUTSIDE the silence gate — silent must not mean unrecorded`).toBeGreaterThan(gateEnd);
    }
  });

  // v7.26.0 — no source file carries a LITERAL control character.
  //
  // This exists because CLAUDE.md once claimed it did (the rule is now in
  // CLAUDE.md *Changing code and docs*), and a claimed guard that does not exist
  // is the v7.21.14 class ("an instruction that is not true is worse than no
  // instruction"). It is a real hazard rather than a
  // tidy-up: an editing tool that INTERPRETS a backslash-r escape while writing a
  // string lands the raw BYTE in the file, where it is invisible in review,
  // survives `node --check`, and silently changes what a regex matches. That
  // happened three times while the v7.26.0 sender change was being written, once
  // inside the very regex meant to strip control characters.
  //
  // TAB is deliberately ALLOWED — it is ordinary indentation in tracked files, and
  // flagging it would make the scanner wrong about working code, which is how a
  // scanner gets silenced by whoever hits it next. CR is out of scope for the same
  // reason: a CRLF file is a line-ending question, and the split below consumes it.
  test("v7.26.0: no first-party source file carries a literal control character", () => {
    const fs = require("fs");
    const pathMod = require("path");
    const root = pathMod.resolve(__dirname, "..");
    const DIRS = ["lib", "routes", "tests", "scripts", "public/js"];
    const EXT = /[.](js|cjs|mjs|json|css|html|md|yaml|yml)$/;
    const BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

    function walk(dir, out) {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
      for (const e of ents) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const full = pathMod.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (EXT.test(e.name)) out.push(full);
      }
      return out;
    }

    const files = [];
    for (const d of [...DIRS.map(x => pathMod.join(root, x)),
                     pathMod.join(root, "server.js"), pathMod.join(root, "db.js")]) {
      if (!fs.existsSync(d)) continue;
      if (fs.statSync(d).isDirectory()) walk(d, files);
      else files.push(d);
    }
    // Anti-vacuity: the sweep must have reached the files this rule is about, or
    // "no offenders" is satisfied by having scanned nothing.
    expect(files.length, "the scan found source files at all").toBeGreaterThan(150);
    for (const must of ["lib/email.js", "routes/settings.js", "tests/email-sender-name.spec.js"]) {
      expect(files.some(f => f.endsWith(must)), must + " is in the scan").toBe(true);
    }

    const offenders = [];
    for (const f of files) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const m = line.match(BAD);
        if (m) {
          const cp = m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
          offenders.push(pathMod.relative(root, f) + ":" + (i + 1) + " contains U+" + cp);
        }
      });
    }
    expect(offenders, "write control characters as backslash-uXXXX escapes, never as literal bytes").toEqual([]);
  });

  // v7.26.0 — the outbound sender is resolved in ONE place.
  //
  // The behavioural lock (tests/email-sender-name.spec.js) asserts that the
  // diagnostic and real mail produce the SAME From. That is output equality, not
  // sharing: re-inlining a `{ name: getPlatformName(), address: SENDER_ADDRESS }`
  // copy into routes/admin-misc.js passes it, because both messages in that test
  // use a clean platform name that the sanitiser does not change. The copy would
  // only diverge for a legacy control-character name — precisely the case the
  // diagnostic exists to reveal, and the one no test can reach through the API
  // once the settings route refuses such names.
  //
  // So this is a SOURCE lock, in the shape of "v7.21.13: the deduped helpers are
  // not re-invented". Two properties, both of which the pre-v7.26.0 tree violated:
  // EMAIL_FROM is read in exactly one file, and no file outside lib/email.js
  // builds a From of its own.
  test("v7.26.0: the outbound sender is resolved in ONE place", () => {
    const fs = require("fs");
    const pathMod = require("path");
    const root = pathMod.resolve(__dirname, "..");

    function collect(dir, out) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const full = pathMod.join(dir, e.name);
        if (e.isDirectory()) collect(full, out);
        else if (e.name.endsWith(".js")) out.push(full);
      }
      return out;
    }
    const files = [
      pathMod.join(root, "server.js"), pathMod.join(root, "db.js"),
      ...collect(pathMod.join(root, "lib"), []),
      ...collect(pathMod.join(root, "routes"), []),
    ];
    expect(files.length, "the scan found source files at all").toBeGreaterThan(20);

    const OWNER = pathMod.join(root, "lib", "email.js");
    expect(files.includes(OWNER), "lib/email.js is in the scan").toBe(true);

    // 1. EMAIL_FROM is read by the owner and nobody else. A second reader is how
    //    the two senders came to hold different ladders in the first place.
    const readers = files.filter(f =>
      /process[.]env[.]EMAIL_FROM/.test(_stripJsComments(fs.readFileSync(f, "utf8"))));
    expect(readers.map(f => pathMod.relative(root, f)).sort(),
      "only lib/email.js may read EMAIL_FROM — everything else calls resolveSender()")
      .toEqual(["lib/email.js"]);

    // 2. The owner really does export the resolver, and it really is the object
    //    form. Without this the lock passes against a file that reads EMAIL_FROM
    //    once and still concatenates.
    const owner = _stripJsComments(fs.readFileSync(OWNER, "utf8"));
    expect(owner, "resolveSender returns a {name, address} object").toMatch(
      /function resolveSender[^]{0,400}?return\s*\{[^}]*\bname\s*:[^}]*\baddress\s*:/);
    expect(owner, "resolveSender is exported").toMatch(/module[.]exports\s*=\s*\{[^]*resolveSender/);

    // 3. Nobody outside the owner hands nodemailer a `from`. Both senders must go
    //    through resolveSender(); `transporter.sendMail` exists in exactly two
    //    files and the second one is the diagnostic.
    for (const f of files) {
      if (f === OWNER) continue;
      const src = _stripJsComments(fs.readFileSync(f, "utf8"));
      if (!/transporter[.]sendMail/.test(src)) continue;
      expect(src, pathMod.relative(root, f) + " must call resolveSender() rather than build a From")
        .toMatch(/from:\s*resolveSender\(\)/);
      expect(src, pathMod.relative(root, f) + " must not construct a From object of its own")
        .not.toMatch(/from:\s*\{/);
    }
  });



  test("v7.25.0: the probe signatures are defined once", () => {
    // Production source only. tests/ legitimately spells these paths as
    // executable fixtures — a scanner that is wrong about working code gets
    // silenced by whoever hits it next.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const owner = fs.readFileSync(pathMod.join(root, "lib/scanner-classify.js"), "utf8");
    // Anti-vacuity floor: an emptied pattern list must not satisfy this.
    expect((owner.match(/\/\(\^\|\\\/\)|\\\.\(php/g) || []).length,
      "the owning module must actually carry the signature list").toBeGreaterThan(3);

    const files = [];
    const walk = (dir) => {
      for (const n of fs.readdirSync(dir)) {
        const p = pathMod.join(dir, n);
        if (fs.statSync(p).isDirectory()) { if (n !== "node_modules") walk(p); }
        else if (n.endsWith(".js") && p !== pathMod.join(root, "lib/scanner-classify.js")) files.push(p);
      }
    };
    walk(pathMod.join(root, "lib"));
    walk(pathMod.join(root, "routes"));
    files.push(pathMod.join(root, "server.js"));
    for (const f of files) {
      const src = _stripJsForScan(fs.readFileSync(f, "utf8"));
      for (const needle of ["wp-admin", "phpmyadmin", "phpMyAdmin"]) {
        expect(src.includes(needle),
          `${pathMod.relative(root, f)} re-spells a probe signature — they live in lib/scanner-classify.js`).toBe(false);
      }
    }
  });

  test("v7.25.0: the log sort rules are mirrored, not re-invented", () => {
    // public/js is a browser-only ESM graph and cannot import lib/, so the copy
    // is irreducible — the DIFF_PTS / DRY_RUN_TAG / compareTaskNumbers family.
    // What must not happen is the two DISAGREEING: a column would then visibly
    // reorder the moment an admin types into the search box, for a reason
    // nothing on screen explains.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const srv = fs.readFileSync(pathMod.join(root, "lib/log-sort.js"), "utf8");
    const cli = fs.readFileSync(pathMod.join(root, "public/js/features/settings-admin.js"), "utf8");
    const rank = (s, name) => {
      const m = s.match(new RegExp(name + "\\s*=\\s*\\{([^}]*)\\}"));
      expect(m, `${name} not found`).toBeTruthy();
      return m[1].replace(/\s/g, "");
    };
    expect(rank(srv, "LOG_LEVEL_RANK")).toBe(rank(cli, "_LOG_LEVEL_RANK"));
    // Anti-vacuity: two matching STUBS must not satisfy it.
    expect(rank(srv, "LOG_LEVEL_RANK")).toContain("error:4");
    const nums = (s, name) => {
      const m = s.match(new RegExp(name + "\\s*=\\s*new Set\\(\\[([^\\]]*)\\]"));
      expect(m, `${name} not found`).toBeTruthy();
      return m[1].replace(/["'\s]/g, "").split(",").filter(Boolean).sort().join(",");
    };
    expect(nums(srv, "LOG_NUMERIC_COLS")).toBe(nums(cli, "_LOG_NUMERIC_COLS"));
    expect(nums(srv, "LOG_NUMERIC_COLS")).toContain("status");
  });

  test("v7.25.0: paginationHtml emits no control that holds operator input", () => {
    // It returns a string every caller writes into a container it RE-RENDERS,
    // two of them on a 15-second poll. A stateful control in there would hand
    // the v7.20.10 swallowed-keystroke defect to five surfaces at once.
    const fs = require("fs"), pathMod = require("path");
    // Comments only: the markup this function emits IS string literals, so a
    // stripper that blanks them would leave nothing to scan and the lock would
    // pass whatever the helper contained.
    const src = _stripJsComments(fs.readFileSync(
      pathMod.join(__dirname, "..", "public/js/ui/list-controls.js"), "utf8"));
    const start = src.indexOf("export function paginationHtml(");
    expect(start).toBeGreaterThan(-1);
    // Brace-scope to the function BODY: the module legitimately emits <input>
    // in pickerFilterHtml. Note the first `{` after the name is
    // the destructured parameter object, not the body — scanning from there
    // ends at the signature and the anti-vacuity floor catches it.
    const MARK = "} = {}) {";
    const sigEnd = src.indexOf(MARK, start);
    expect(sigEnd, "paginationHtml's signature shape changed — re-point this scan").toBeGreaterThan(start);
    let i = sigEnd + MARK.length - 1, depth = 0, end = -1;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    expect(end).toBeGreaterThan(start);
    const fn = src.slice(start, end);
    for (const bad of ["<input", "<textarea", "contenteditable", "<select multiple"]) {
      expect(fn.includes(bad), `paginationHtml must not emit ${bad}`).toBe(false);
    }
    // Anti-vacuity: it does emit the stateless controls it is for.
    expect(fn).toContain("-page-next");
  });

  test("v7.25.0: /api/admin/logs documents every field it returns", () => {
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const src = fs.readFileSync(pathMod.join(root, "server.js"), "utf8");
    const at = src.indexOf('app.get("/api/admin/logs"');
    expect(at).toBeGreaterThan(-1);
    // The handler's terminal res.json({...}) — the one carrying `entries`.
    const jat = src.indexOf("    entries: finalEntries,", at);
    expect(jat).toBeGreaterThan(-1);
    const block = src.slice(jat, src.indexOf("\n  });", jat));
    const keys = [...block.matchAll(/^\s{4}([a-z_]+):/gm)].map(m => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    const swagger = fs.readFileSync(pathMod.join(root, "swagger.yaml"), "utf8");
    const opAt = swagger.indexOf("  /api/admin/logs:");
    const opEnd = swagger.indexOf("  /api/admin/logs/files:");
    const op = swagger.slice(opAt, opEnd > opAt ? opEnd : undefined);
    for (const k of keys) {
      expect(op.includes(`${k}:`), `swagger's /api/admin/logs does not document the '${k}' response field`).toBe(true);
    }
  });

  test("v7.21.6: every <img> attribute the server emits survives to the participant", () => {
    // CONFIRMED DRIFT, and it reached a participant. _transformImg does not
    // merely ALLOW attributes on an <img> — it REPLACES the bag, returning
    // exactly {src, style:"max-width:100%"}. That inline style was the ONLY
    // thing bounding an image's width. renderRich()'s ATTR_OK.img is
    // ['src','alt','width','height'] — no 'style' — so it stripped it. The
    // author saw the image constrained (the editor holds the raw stored HTML)
    // and so did the admin preview (.task-preview-desc); only the PARTICIPANT
    // view was unbounded, and the overflow-x safety net named
    // `#task-detail-card .task-desc`, a class nothing emitted.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const read = f => fs.readFileSync(pathMod.join(root, f), "utf8");

    const fnM = /function _transformImg\([\s\S]*?\n\}/.exec(read("lib/sanitise.js"));
    expect(fnM, "lib/sanitise.js must define _transformImg").toBeTruthy();
    const emitted = new Set();
    for (const m of fnM[0].matchAll(/attribs:\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(",")) { const k = part.split(":")[0].trim(); if (k) emitted.add(k); }
    }
    expect([...emitted].sort(),
      "_transformImg must emit src + style on a kept image — if that changed, the rest of " +
      "this lock is reasoning about the wrong contract").toEqual(["src", "style"]);

    const rt = read("public/js/ui/richtext.js");
    const renderFn = /export function renderRich\([\s\S]*?\n\}/.exec(rt);
    expect(renderFn, "richtext.js must export renderRich").toBeTruthy();
    const setM = /img:\s*new Set\(\[([^\]]*)\]\)/.exec(renderFn[0]);
    expect(setM, "renderRich must declare an img entry in ATTR_OK").toBeTruthy();
    const kept = new Set(setM[1].split(",").map(x => x.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean));

    // A server-emitted attribute the renderer drops must be listed here WITH a
    // compensating mechanism. An unlisted one is silent data loss.
    const DELIBERATELY_DROPPED = new Set(["style"]);
    const undocumented = [...emitted].filter(a => !kept.has(a) && !DELIBERATELY_DROPPED.has(a));
    expect(undocumented,
      "the server emits these <img> attributes and renderRich strips them with nothing " +
      "compensating — a participant sees something other than what was stored:\n  " +
      undocumented.join("\n  ")).toEqual([]);

    if (!kept.has("style")) {
      const css = read("public/styles.css");
      const constrained = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
        .filter(m => /\bimg\b/.test(m[1]) && /max-width\s*:\s*100%/.test(m[2]))
        .map(m => m[1]);
      const RICH_SURFACES = ["#task-detail-card", ".task-preview-desc",
        ".task-preview-hint-body", ".task-preview-explanation", ".rich-body"];
      const uncovered = RICH_SURFACES.filter(sel => !constrained.some(c => c.includes(sel)));
      expect(uncovered,
        "renderRich drops the server-injected img max-width, and these rich-text surfaces have " +
        "no CSS rule bounding an image either. A 1920px screenshot pasted into a challenge " +
        "renders 1920px wide inside a 760px card:\n  " + uncovered.join("\n  ")).toEqual([]);
    }

    // …and the overflow containment the participant surface was SUPPOSED to have.
    // A CSS rule targeting a selector nobody emits is dead coverage that LOOKS
    // like coverage — the failure the v7.17.2 registry self-check exists for.
    expect(/\.task-desc\b/.test(read("public/styles.css"))
        && /class="task-desc"/.test(read("public/js/features/participant-tasks.js")),
      "styles.css scopes the rich-content overflow-x rule to `#task-detail-card .task-desc` but " +
      "nothing carries that class, so the rule is dead and a wide table escapes the card."
    ).toBeTruthy();
  });

  test("v8.11.3: the shipped font-size vocabulary does not grow", () => {
    // D5, and it is a FREEZE rather than a consolidation — a deliberate decision
    // recorded here because the alternative was considered and declined.
    //
    // DESIGN_SYSTEM.md §2 measured 36 distinct font-size values at v7.23.0 and
    // marks its proposed ramp NOT SHIPPED. The v8.11.2 UI audit re-measured and
    // found 41 across 327 declarations — so the vocabulary had grown by five
    // while the documented ramp stayed unbuilt, including five perceptually
    // identical sub-pixel twin pairs (.82/.83, .85/.86, .65/.66 …).
    //
    // WHY NOT CONSOLIDATE. Collapsing 41 values to a ramp touches nearly every
    // component, churns all four visual-regression baselines, and buys a
    // cosmetic gain — real regression surface for no behaviour change. The DRIFT
    // is the defect, not the absolute number, so this pins the ceiling and lets
    // the number fall on its own whenever a component is legitimately reworked.
    //
    // The ceiling MAY be lowered — and should be, after any consolidation pass.
    // It may not be raised without a reason written beside it: a new size means
    // a sixth near-duplicate of something that already ships.
    // v8.16 type scale: 41 -> 11 (styles.css reads only --fs-* tokens; the 11
    // are the standalone unsubscribe and verify pages, which cannot load it).
    // tests/type-scale-scanner.spec.js now refuses any literal in styles.css.
    const FONT_SIZE_CEILING = 11;

    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.resolve(__dirname, "..");
    const files = fs.readdirSync(pathMod.join(root, "public"))
      .filter(f => f.endsWith(".css"))
      .map(f => pathMod.join(root, "public", f));
    expect(files.length, "anti-vacuity: the public stylesheets must be found").toBeGreaterThanOrEqual(3);

    const seen = new Map();
    let declared = 0;
    for (const f of files) {
      // Comments FIRST — this stylesheet's comments quote rem and px values
      // constantly (the v7.21.13 / v8.3.5 trap), so an unstripped scan counts
      // prose as shipped vocabulary.
      const css = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/font-size\s*:\s*([^;}\n]+)/g)) {
        declared++;
        const v = m[1].trim();
        if (v.startsWith("var(") || v === "inherit") continue;   // tokens are the goal, not drift
        if (!seen.has(v)) seen.set(v, []);
        seen.get(v).push(pathMod.basename(f));
      }
    }

    // ANTI-VACUITY: a regex that stops matching would report zero and pass a
    // ceiling check silently — the exact failure this file keeps recording.
    // The v8.16 type scale moved every styles.css size onto tokens, so the floor
    // counts DECLARATIONS (tokens included), not literal values; the literals
    // left are the two standalone pages (unsubscribe.css, verify-pages.css).
    expect(declared, "anti-vacuity: font-size declarations must still be found")
      .toBeGreaterThanOrEqual(300);

    const listed = [...seen.keys()].sort().join(", ");
    expect(seen.size,
      `the shipped font-size vocabulary grew past ${FONT_SIZE_CEILING}. A new size is a sixth ` +
      `near-duplicate of something that already ships — reuse an existing value, or lower the ` +
      `ceiling here after a consolidation pass and say why.\nShipped (${seen.size}): ${listed}`
    ).toBeLessThanOrEqual(FONT_SIZE_CEILING);
  });

  test("v7.21.8: no CSS rule declares the same property twice with different values", () => {
    // THE BUG THIS CAME FROM. `.color-pop` declared z-index TWICE: v7.18.0
    // prepended the intended 200 and left the original 10 in place, and the
    // LATER declaration wins. So the rich-text colour-swatch popover rendered at
    // z-index 10 in the root stacking context — below the sticky header (100),
    // the fixed mobile #main-nav (100), .back-btn (50) and .kebab-menu (160) —
    // which is precisely the clipping v7.18.0 moved it to position:fixed to
    // prevent. Its sibling .drop-pop had the value edited in place and was right
    // all along, so the two popovers silently disagreed.
    //
    // Nothing errors on a duplicate declaration; the browser just takes the last
    // one. A half-applied edit therefore looks correct in the diff and is wrong
    // on screen, which is why this is a scanner rather than a note.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const cssFiles = fs.readdirSync(pathMod.join(root, "public")).filter(f => f.endsWith(".css"));
    const hits = [];
    for (const file of cssFiles) {
      const css = fs.readFileSync(pathMod.join(root, "public", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const sel = m[1].trim().replace(/\s+/g, " ");
        const seen = new Map();
        for (const decl of m[2].split(";")) {
          const i = decl.indexOf(":");
          if (i < 0) continue;
          const prop = decl.slice(0, i).trim().toLowerCase(), val = decl.slice(i + 1).trim();
          if (!prop || prop.startsWith("-")) continue;   // custom props + vendor prefixes
          if (!seen.has(prop)) seen.set(prop, []);
          seen.get(prop).push(val);
        }
        for (const [prop, vals] of seen) {
          if (vals.length < 2 || new Set(vals).size < 2) continue;
          // The two legitimate reasons to declare a property twice with
          // DIFFERENT values are both progressive fallbacks, where an older
          // engine ignores the second declaration: a var()/gradient/prefixed
          // value, and a newer viewport unit (the vh -> dvh pattern this
          // stylesheet uses in eight places).
          if (vals.some(v => /var\(|gradient|-webkit-|image-set/.test(v))) continue;
          if (vals.some(v => /\b\d*\.?\d+(dvh|dvw|svh|svw|lvh|lvw)\b/.test(v))) continue;
          hits.push(`${file}: ${sel.slice(0, 60)} — ${prop}: ${vals.join(" THEN ")}`);
        }
      }
    }
    expect(hits,
      "a CSS rule declares the same property twice with different values, so the FIRST one is " +
      "silently dead. If this is a deliberate progressive fallback, it must be one the scanner " +
      "recognises (a var()/gradient/prefixed value, or a newer viewport unit) — otherwise it is " +
      "a half-applied edit:\n  " + hits.join("\n  ")
    ).toEqual([]);
  });

  test("v7.17.2: a row lookup in a PAGINATED admin table narrows with its search box first", () => {
    // THE CLASS (v7.15.29, and it cost a CI round trip then):
    //
    // Every spec file on a worker shares one server and one DB, and the two
    // admin tables paginate at 30. So a spec that seeds a competition or a
    // challenge and then looks for its row is reliable only while the table is
    // short — by the time a later file runs, earlier files have pushed the
    // fixture off page 1 and the row is genuinely ABSENT, not slow. Which files
    // land on which worker decides which lookups fail, so it never reproduces
    // at WORKERS=8 locally and gets WORSE at WORKERS=2 (fewer workers ⇒ more
    // spec files per worker ⇒ more accumulated rows).
    //
    // v7.17.2 gives the Groups table pagination too, which adds a third way to
    // walk into this. Prose in CLAUDE.md did not prevent the first two, so the
    // registry below is the enforceable version: PAGINATE A TABLE → ADD ITS ROW
    // HERE, and any spec that looks a row up by seeded text must fill the
    // search box first.
    //
    // SCOPE, stated honestly (the v7.15.17 lesson about not overselling a
    // source scanner): this catches the naive and by far most common shape — a
    // `hasText` row lookup with no `.fill()` on the surface's own search input
    // anywhere earlier in the same test body. It cannot see a lookup built from
    // a variable selector, nor one narrowed by some other means. It is a cheap
    // net for the shape that has actually bitten us twice, not a proof.
    // `helpers` (v7.23.0) — shared narrowing helpers in tests/ui-admin-helpers.js
    // that fill this table's search box themselves. The comment below already
    // named them as a source of false NEGATIVES it could not see; naming them
    // here makes the check MORE accurate rather than less, because a call to
    // one of them really does narrow the table. Each helper is verified below
    // to fill the search input the entry claims, so this cannot become a
    // rubber-stamp for a helper that stops narrowing.
    const PAGINATED_TABLES = [
      { rows: "#admin-groups-body",       search: "#groups-search",       helpers: ["narrowGroupsTable"] },  // v7.17.2; v9.2.4 the one way to type into it
      { rows: "#admin-comp-body",         search: "#comp-search",         helpers: ["narrowEventsTable", "filterComps", "viewComp"] },     // v9.2.5 narrowEventsTable the one way to type into it
      { rows: "#admin-task-body",         search: "#task-search",         helpers: ["narrowChallengesTable", "findSeededTaskRow"] },       // v9.2.5 likewise
      { rows: "#admin-participants-body", search: "#participants-search", helpers: ["narrowPeopleTable"] },                            // v9.2.5 likewise
      { rows: "#admin-submissions-body",  search: "#submissions-search",  helpers: [] },
      // The Audit page pages like Raw logs (50 a page by default). Its filter bar's Actor box
      // narrows the list on the server too, but only once COMMITTED (it acts on
      // `change`, not on typing): an `onChange` box counts only when the same
      // box is committed after it is filled.
      { rows: "#admin-audit-body",        search: "#audit-search",        helpers: [], onChange: ["#audit-actor"] },
    ];
    const fs = require("fs"), pathMod = require("path");

    // A registry entry naming a selector that does not exist covers nothing
    // while LOOKING like coverage — the first draft of this test shipped three
    // such rows (#comp-tbody, #tasks-tbody, #participants-tbody: all invented)
    // and passed, which is precisely the vacuous-lock failure this suite keeps
    // relearning. So the registry checks itself against the real markup first.
    const indexHtml = fs.readFileSync(pathMod.join(__dirname, "..", "public", "index.html"), "utf8");
    const missing = [];
    for (const t of PAGINATED_TABLES) {
      for (const sel of [t.rows, t.search, ...(t.onChange || [])]) {
        if (!indexHtml.includes(`id="${sel.slice(1)}"`)) missing.push(sel);
      }
    }
    expect(missing,
      "these selectors are in the paginated-table registry but do not exist in public/index.html, " +
      "so the rows naming them can never match and silently cover nothing"
    ).toEqual([]);

    // Same anti-vacuity discipline for `helpers`: a helper that no longer fills
    // the search input it is credited with would silently turn every call site
    // into an unnarrowed lookup that this scanner then waves through.
    const helperSrc = fs.readFileSync(pathMod.join(__dirname, "ui-admin-helpers.js"), "utf8");
    const badHelpers = [];
    for (const t of PAGINATED_TABLES) {
      for (const h of t.helpers) {
        const m = new RegExp(`async function ${h}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(helperSrc);
        if (!m) { badHelpers.push(`${h} — not found in ui-admin-helpers.js`); continue; }
        // Either it fills the input itself, or it delegates to a sibling that does.
        const fillsSelf = new RegExp(`${t.search}["'\`][\\s\\S]{0,200}?\\.fill\\(`).test(m[0]);
        const delegates = t.helpers.some(o => o !== h && new RegExp(`\\b${o}\\s*\\(`).test(m[0]));
        if (!fillsSelf && !delegates) badHelpers.push(`${h} — no longer narrows ${t.search}`);
      }
    }
    expect(badHelpers,
      "a narrowing helper credited in the registry no longer fills its table's search box"
    ).toEqual([]);

    // Did `before` (the test body up to the lookup) narrow table `t`? Its search
    // box narrows as it is typed into, so a `.fill()` on it counts. An
    // `onChange` box narrows only once committed, so its `.fill()` counts only
    // when the same box is then committed through a literal locator: a change
    // event, Enter, Tab or blur after the fill.
    const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fillRe = (sel) => new RegExp(`${reEsc(sel)}["'\`]\\s*\\)\\s*\\.fill\\(|${reEsc(sel)}["'\`][\\s\\S]{0,200}?\\.fill\\(`, "g");
    const commitRe = (sel) => new RegExp(`${reEsc(sel)}["'\`]\\s*\\)\\s*\\.(?:dispatchEvent\\(\\s*["'\`]change["'\`]|press\\(\\s*["'\`](?:Enter|Tab)["'\`]|blur\\()`);
    const narrowedBefore = (t, before) => {
      if (fillRe(t.search).test(before)) return true;
      for (const sel of t.onChange || []) {
        const fills = [...before.matchAll(fillRe(sel))];
        const last = fills[fills.length - 1];
        if (last && commitRe(sel).test(before.slice(last.index + last[0].length))) return true;
      }
      // …or a shared helper that fills it — verified above to actually do so,
      // so this is recognition, not amnesty.
      return t.helpers.some(h => new RegExp(`\\b${h}\\s*\\(`).test(before));
    };
    // Planted controls: the commit rule decides, in both directions.
    const AUDIT_T = PAGINATED_TABLES.find(t => t.rows === "#admin-audit-body");
    const actorFill = `await page.locator("#audit-actor").fill(x);\n`;
    expect(narrowedBefore(AUDIT_T, actorFill), "PLANTED: a fill alone does not narrow a box that acts on change").toBe(false);
    expect(narrowedBefore(AUDIT_T, actorFill + `await page.locator("#audit-actor").dispatchEvent("change");\n`), "PLANTED: fill, then a change event").toBe(true);
    expect(narrowedBefore(AUDIT_T, actorFill + `await page.locator("#audit-actor").press("Enter");\n`), "PLANTED: fill, then Enter").toBe(true);
    expect(narrowedBefore(AUDIT_T, `await page.locator("#audit-actor").dispatchEvent("change");\n` + actorFill), "PLANTED: a commit BEFORE the fill commits nothing").toBe(false);
    expect(narrowedBefore(AUDIT_T, actorFill + `await page.locator("#other").press("Enter");\n`), "PLANTED: another box's Enter commits nothing").toBe(false);
    expect(narrowedBefore(AUDIT_T, `await page.locator("#audit-search").fill(x);\n`), "PLANTED: the search box narrows as it is typed into").toBe(true);
    expect(narrowedBefore(AUDIT_T, ""), "PLANTED: nothing narrows nothing").toBe(false);

    const bad = [];
    for (const f of fs.readdirSync(__dirname).filter(x => /\.spec\.js$/.test(x))) {
      const src = fs.readFileSync(pathMod.join(__dirname, f), "utf8");
      // Split into test bodies so "narrowed earlier" means earlier in THIS
      // test, not in some unrelated one further up the file.
      const starts = [...src.matchAll(/\btest\s*(?:\.\w+)?\s*\(/g)].map(m => m.index);
      for (let i = 0; i < starts.length; i++) {
        const body = src.slice(starts[i], starts[i + 1] ?? src.length);
        for (const t of PAGINATED_TABLES) {
          const esc = t.rows.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          // A row lookup carrying a hasText option — i.e. "find the row I seeded".
          // NOTE (v7.21.17) — this matches the OPTION form
          // `locator("… tr", {hasText: …})` only. The CSS pseudo-class spelling
          // `locator("… tr:has-text('…')")` means the same thing and is NOT
          // covered, which is how the v7.21.17 flake slipped past. Extending the
          // regex to catch it was tried and REVERTED: it produces 116 hits, and
          // the large majority are working code — absence assertions
          // (`toHaveCount(0)`, where narrowing is pointless), sites that narrow
          // through the filterComps / viewComp / findSeededTaskRow helpers this
          // `filled` check cannot see, and the screenshot spec, which is not part
          // of `npm test` at all. A scanner that is wrong about working code gets
          // silenced by whoever hits it next, so closing this properly means
          // teaching it those three exclusions and then triaging the remainder —
          // a piece of work in its own right, not a rider on an unrelated patch.
          const re = new RegExp(`locator\\(\\s*["'\`]${esc}[^"'\`]*\\btr\\b[^"'\`]*["'\`]\\s*,\\s*\\{[^}]*hasText`, "g");
          for (const m of body.matchAll(re)) {
            const before = body.slice(0, m.index);
            if (!narrowedBefore(t, before)) {
              const line = src.slice(0, starts[i] + m.index).split("\n").length;
              bad.push(`${f}:${line}  (${t.rows} — narrow with ${t.search} first)`);
            }
          }
        }
      }
    }
    expect(bad,
      "these specs look up a seeded row in a PAGINATED admin table without narrowing it " +
      "first, so the lookup silently depends on the table being short. It passes locally " +
      "and fails in CI once earlier spec files on the same worker have pushed the fixture " +
      "off page 1 — and the symptom is the full 60s test timeout, which reads as 'slow' " +
      "rather than 'absent'. Fill the table's search box before the lookup:\n  " + bad.join("\n  ")
    ).toEqual([]);
  });

  test("v9.2.4–v9.2.5: specs type into the Groups, Events, Challenges and People search boxes only through their narrowing helpers", () => {
    // THE CLASS (main CI, 21 Nov 2026: phase3-ui's Members dialog never opened).
    // Typing into an admin table's search box renders the table again 160 ms
    // later. A row already on the unfiltered first page is visible BEFORE that
    // render, so a press made then can go down on the old row and come up on
    // its replacement, and Chromium dispatches no click (the pointer and mouse
    // events arrive, click does not): the dialog never opens, and Playwright
    // reports the click done. Each helper (tests/ui-admin-helpers.js) returns
    // only once the table has rendered for the query: rerenderedAfter (every
    // row replaced) for Groups, Challenges and People; the render count for
    // Events, whose rows survive a render that leaves them unchanged (v9.2.5,
    // ui/list-controls.js patchTableRows). Their behaviour is held by
    // phase3-ui's Groups arm and admin-row-press.spec.js.
    //
    // SCOPE, stated honestly: a LITERAL locator whose selector names one of
    // the boxes (alone or inside a compound selector, with or without an
    // options object), typed into with fill, pressSequentially, type, press or
    // clear, directly or after first/last/nth; or page.fill/type/press with such
    // a selector. An aliased locator escapes.
    const fs = require("fs"), pathMod = require("path");
    const { stripJsComments } = require("./doc-registry");
    const Q = "[\"'`]", NQ = "[^\"'`]*";
    // Built from parts, so this file's own text never matches them.
    const BOXES = [
      { sel: "#groups-" + "search", helper: "narrowGroupsTable", min: 10,
        waits: /rerenderedAfter\s*\(\s*page\s*,\s*["'`]#groups-tbody["'`]\s*,\s*\(\)\s*=>\s*search\.fill\(/ },
      { sel: "#comp-" + "search", helper: "narrowEventsTable", min: 10,
        waits: /_compRenderedAfter\s*\(\s*page\s*,\s*\(\)\s*=>\s*search\.fill\(/ },
      { sel: "#task-" + "search", helper: "narrowChallengesTable", min: 20,
        waits: /rerenderedAfter\s*\(\s*page\s*,\s*["'`]#admin-task-body["'`]\s*,\s*\(\)\s*=>\s*search\.fill\(/ },
      { sel: "#participants-" + "search", helper: "narrowPeopleTable", min: 20,
        waits: /rerenderedAfter\s*\(\s*page\s*,\s*["'`]#admin-participants-body["'`]\s*,\s*\(\)\s*=>\s*search\.fill\(/ },
    ];
    const typedRe = (sel) => {
      const LIT = Q + NQ + sel + "(?![\\w-])" + NQ + Q;   // not #…-search-count / -clear
      return new RegExp(
        LIT + "\\s*(?:,\\s*\\{[^}]*\\})?\\s*\\)" +
        "(?:\\s*\\.\\s*(?:first|last|nth)\\s*\\([^)]*\\))*" +
        "\\s*\\.\\s*(?:fill|pressSequentially|type|press|clear)\\s*\\(" +
        "|\\.(?:fill|type|press)\\s*\\(\\s*" + LIT, "g");
    };
    const indexHtml = fs.readFileSync(pathMod.join(__dirname, "..", "public", "index.html"), "utf8");
    const helperRaw = stripJsComments(fs.readFileSync(pathMod.join(__dirname, "ui-admin-helpers.js"), "utf8"));
    const helpers = {};
    for (const box of BOXES) {
      const SEL = box.sel;
      for (const p of [
        `await page.locator("${SEL}").fill(name);`,
        `await pg.locator('${SEL}').pressSequentially(n, { delay: 10 });`,
        `await page.locator(\`${SEL}\`)\n      .type(x);`,
        `await page.fill("${SEL}", name);`,
        `await page.locator("${SEL}").press("Enter");`,
        `await page.locator("${SEL}").first().fill(name);`,
        `await page.locator("${SEL}").nth(0).clear();`,
        `await page.locator("#admin-page ${SEL}").fill(name);`,
        `await page.locator("${SEL}", { hasText: "" }).fill(name);`,
      ]) expect(p.match(typedRe(SEL)), `PLANTED: ${p}`).not.toBeNull();
      for (const p of [
        `await expect(page.locator("${SEL}")).toHaveValue(x);`,
        `await ${box.helper}(page, name);`,
        `await page.locator("${SEL}-count").fill(x);`,
      ]) expect(p.match(typedRe(SEL)), `PLANTED control, not typing into the box: ${p}`).toBeNull();
      // A renamed box would leave this matching nothing while passing.
      expect(indexHtml, `the search box ${SEL} exists`).toContain(`id="${SEL.slice(1)}"`);
      // The helper still types into the box AND waits for the render.
      const h = new RegExp(`async function ${box.helper}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(helperRaw);
      expect(h, `${box.helper} is defined in ui-admin-helpers.js`).not.toBeNull();
      expect(h[0], `${box.helper} types into ${SEL} through its render witness`).toMatch(box.waits);
      helpers[box.helper] = h[0];
    }
    // The Events witness is the render count, so it must read it.
    const ev = /async function _compRenderedAfter\s*\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(helperRaw);
    expect(ev && ev[0], "_compRenderedAfter waits on the Events table's render count").toMatch(/S\._compRenders\b[\s\S]*\bn > before\b/);
    expect(ev && ev[0], "…and on the search text that render filtered by").toMatch(/S\._compRenderedQuery\b[\s\S]*\bq === want\b/);

    const bad = [];
    const calls = Object.fromEntries(BOXES.map((b) => [b.helper, 0]));
    let scanned = 0;
    for (const f of fs.readdirSync(__dirname).filter((x) => /\.js$/.test(x))) {
      let src = stripJsComments(fs.readFileSync(pathMod.join(__dirname, f), "utf8"));
      if (f === "ui-admin-helpers.js") for (const body of Object.values(helpers)) src = src.replace(body, "");   // the sanctioned doors
      scanned++;
      for (const box of BOXES) {
        if (f !== pathMod.basename(__filename)) calls[box.helper] += (src.match(new RegExp(`\\b${box.helper}\\s*\\(`, "g")) || []).length;
        for (const m of src.matchAll(typedRe(box.sel))) bad.push(`${f}: ${m[0].replace(/\s+/g, " ")}   (use ${box.helper})`);   // stripping drops lines: name the text
      }
    }
    expect(scanned, "ANTI-VACUITY: the scan read the tests directory").toBeGreaterThan(100);
    for (const box of BOXES) {
      expect(calls[box.helper], `ANTI-VACUITY: specs reach ${box.sel}'s table through ${box.helper}`).toBeGreaterThanOrEqual(box.min);
    }
    expect(bad,
      "these specs type into an admin search box directly. Its render 160 ms later replaces the rows, " +
      "so a row pressed before it is a detached node and the press opens nothing. " +
      "Use the box's helper from tests/ui-admin-helpers.js:\n  " + bad.join("\n  ")
    ).toEqual([]);
  });

  test("v9.2.5: the comment stripper keeps a quoted string whole, so a route glob's `/*` hides no code", () => {
    // Every scanner over source strips comments first (stripJsComments,
    // tests/doc-registry.js; the describe-local _stripJsComments here is its
    // byte-identical copy). The string-blind form took the `/*` in a spec's
    // route glob for a comment and dropped everything up to the next `*/`:
    // over 1,000 lines of ui-admin-competitions.spec.js were invisible to
    // every scanner (v9.2.5 review).
    const { stripJsComments } = require("./doc-registry");
    const G = "**/api/admin/x/" + "*";   // built from parts
    const cases = [
      [`page.route("${G}", h);\nawait page.locator("#a").fill(n);\n// gone */ kept`, (o) => o.includes(".fill(n)") && o.includes(`"${G}"`) && !o.includes("gone")],
      [`const u = "http://x"; // gone\nnext()`, (o) => o.includes(`"http://x"`) && !o.includes("gone") && o.includes("next()")],
      [`a /* gone */ b`, (o) => o === "a  b"],
      [`s = 'it\\'s'; // gone`, (o) => o.includes("it\\'s") && !o.includes("gone")],
    ];
    for (const [src, ok] of cases) {
      const out = stripJsComments(src);
      expect(ok(out), `stripJsComments(${JSON.stringify(src)}) gave ${JSON.stringify(out)}`).toBe(true);
      expect(_stripJsComments(src), "the describe-local copy agrees").toBe(out);
    }
    expect(_stripJsComments.toString().replace(/\s+/g, " ").replace(/^function _/, "function "),
      "the describe-local copy is byte-identical to the export").toBe(stripJsComments.toString().replace(/\s+/g, " "));
  });

  test("v9.2.5: a drain of the whole document's animations skips the infinite ones (settleFiniteAnimations)", () => {
    // THE CLASS (the full suite, 22 Nov 2026: dead-affordances' collapsed-rail
    // test hung for its whole budget). A drain of document.getAnimations()
    // waits on every animation on the page, and an infinite one (a live
    // event's pulsing dot on the Events list, a loading shimmer, a spinner)
    // never finishes. Such drains used to end within 15 s by accident, when the
    // Events list's poll replaced every row and so cancelled the dot; since
    // v9.2.5 the list keeps the rows a refresh leaves unchanged.
    // tests/helpers.js settleFiniteAnimations skips animations with no end.
    //
    // SCOPE, stated honestly: a literal document.getAnimations( whose
    // statement awaits `.finished` with no finite-end filter in that statement
    // (Number.isFinite, endTime or Infinity). One element's animations, or a
    // list held in a variable and drained later, are not judged.
    const fs = require("fs"), pathMod = require("path");
    const { stripJsComments } = require("./doc-registry");
    const DOC = "document." + "getAnimations(";   // built from parts: this file must not match itself
    const unfiltered = (src) => {
      const out = [];
      for (let i = src.indexOf(DOC); i >= 0; i = src.indexOf(DOC, i + DOC.length)) {
        const end = src.indexOf(";", i);
        const stmt = src.slice(i, end < 0 ? src.length : end);
        if (/\.finished\b/.test(stmt) && !/isFinite|endTime|Infinity/.test(stmt)) out.push(stmt.replace(/\s+/g, " ").slice(0, 140));
      }
      return out;
    };
    for (const p of [
      `await page.evaluate(() => Promise.all(${DOC}{ subtree: true }).map((a) => a.finished.catch(() => {}))));`,
      `await page.evaluate(() => Promise.all(${DOC})\n  .map(a => a.finished)));`,
    ]) expect(unfiltered(p), `PLANTED: ${p}`).toHaveLength(1);
    for (const p of [
      `await page.evaluate(() => Promise.all(${DOC}).filter((a) => Number.isFinite(a.effect.getComputedTiming().endTime)).map((a) => a.finished)));`,
      `return ${DOC}).length === 0;`,
    ]) expect(unfiltered(p), `PLANTED control: ${p}`).toEqual([]);
    const helpersSrc = stripJsComments(fs.readFileSync(pathMod.join(__dirname, "helpers.js"), "utf8"));
    const h = /async function settleFiniteAnimations\s*\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(helpersSrc);
    expect(h && h[0], "settleFiniteAnimations skips animations with no finite end")
      .toMatch(/Number\.isFinite\(\s*a\.effect\.getComputedTiming\(\)\.endTime\s*\)/);
    const bad = [];
    let calls = 0;
    for (const f of fs.readdirSync(__dirname).filter((x) => /\.js$/.test(x))) {
      const src = stripJsComments(fs.readFileSync(pathMod.join(__dirname, f), "utf8"));
      if (f !== "helpers.js") calls += (src.match(/\bsettleFiniteAnimations\s*\(/g) || []).length;
      for (const st of unfiltered(src)) bad.push(`${f}: ${st}`);
    }
    expect(calls, "ANTI-VACUITY: specs drain the document through the helper").toBeGreaterThanOrEqual(6);
    expect(bad,
      "these specs wait on every animation on the page, infinite ones included, so one that never " +
      "finishes holds the test to its timeout. Use settleFiniteAnimations(page) from tests/helpers.js:\n  " + bad.join("\n  ")
    ).toEqual([]);
  });

  test("v9.2.14: a spec that paints the page's look in place first waits for the app's own look read (appearanceSettled)", () => {
    // THE CLASS (PR CI, 24 Nov 2026: tests/css-token-sites.spec.js painted the
    // Ambient look lit Cyan and read the Ice chip). Boot asks
    // GET /api/settings/appearance without awaiting it
    // (public/js/features/appearance.js loadOrgDefaultLook) and repaints the
    // resolved look on <html> when it answers, which can be after
    // <html data-booted="1"> and after a test's own paint. tests/helpers.js
    // appearanceSettled waits for S._appearanceSettled, set once that read has
    // answered and repainted.
    //
    // SCOPE, stated honestly: a FILE writing data-look, data-theme or
    // data-ambient on the document element (directly, or through a name the
    // file binds to it) must call appearanceSettled( somewhere in it. Where
    // the call sits (a later navigation brings a new read), a write through
    // any other name, and one through dataset or toggleAttribute are not judged.
    const fs = require("fs"), pathMod = require("path");
    const { stripJsComments } = require("./doc-registry");
    const DE = "document." + "documentElement";   // built from parts: this file must not match itself
    const HELPER = "appearance" + "Settled(";
    const writes = (src) => {
      const names = new Set([DE]);
      const bind = new RegExp("\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*" + DE.replace(".", "\\.") + "\\b", "g");
      for (const m of src.matchAll(bind)) names.add(m[1]);
      const out = [];
      for (const m of src.matchAll(/([A-Za-z_$][\w$.]*)\.(?:set|remove)Attribute\(\s*["'`](data-(?:look|theme|ambient))["'`]/g)) {
        if (names.has(m[1])) out.push(`${m[1]} ${m[2]}`);
      }
      return out;
    };
    const ATTR = (verb, a) => `.${verb}Attribute("data-${a}"`;
    for (const p of [
      `await page.evaluate(() => ${DE}${ATTR("set", "theme")}, "dark"));`,
      `const h = ${DE};\n h${ATTR("set", "look")}, l);`,
      `${DE}${ATTR("remove", "ambient")});`,
    ]) expect(writes(p), `PLANTED: ${p}`).toHaveLength(1);
    for (const p of [
      `m${ATTR("set", "ambient")}, ambient);`,                      // a preview element, not the page
      `${DE}.setAttribute("data-theme-x", "1");`,                  // another attribute
      `${DE}.getAttribute("data-theme");`,                         // a read
    ]) expect(writes(p), `PLANTED control: ${p}`).toEqual([]);
    const helpersSrc = stripJsComments(fs.readFileSync(pathMod.join(__dirname, "helpers.js"), "utf8"));
    const h = /async function appearanceSettled\s*\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(helpersSrc);
    expect(h && h[0], "appearanceSettled waits for the app's own witness, not for boot alone")
      .toMatch(/window\._appearanceSettled\s*===\s*true/);
    const bad = [];
    let writers = 0;
    for (const f of fs.readdirSync(__dirname).filter((x) => /\.js$/.test(x))) {
      const src = stripJsComments(fs.readFileSync(pathMod.join(__dirname, f), "utf8"));
      const w = writes(src);
      if (!w.length) continue;
      writers++;
      if (!src.includes(HELPER)) bad.push(`${f}: ${[...new Set(w)].join(", ")}`);
    }
    expect(writers, "ANTI-VACUITY: specs paint the page's look in place").toBeGreaterThanOrEqual(10);
    expect(bad,
      "these specs paint <html>'s look in place without waiting for the app's own look read, whose " +
      "late repaint can land on their paint. Call appearanceSettled(page) from tests/helpers.js first:\n  " + bad.join("\n  ")
    ).toEqual([]);
  });

  test("v7.15.30: a test that spawns a server child scrubs NODE_OPTIONS", () => {
    // NODE_OPTIONS is inherited by every child process. A test that spawns a
    // server and then asserts on its EXIT CODE or STDERR is therefore asserting
    // on a process whose node flags the runner chose, not the test.
    //
    // This is not hypothetical: v7.15.24 added
    // `NODE_OPTIONS=--require ./tests/_worker-crash-probe.cjs` to the CI job to
    // diagnose worker deaths. The probe exited 1 from its SIGTERM handler, the
    // spawned server inherited it, and the graceful-shutdown test — whose whole
    // subject is a CLEAN exit on SIGTERM — failed in CI and only in CI. A
    // diagnostic corrupted the thing it was observing.
    //
    // So: any spawn of server.js from a test must pin NODE_OPTIONS itself.
    const fs = require("fs"), pathMod = require("path");
    const bad = [];
    for (const f of fs.readdirSync(__dirname).filter(x => /\.spec\.js$/.test(x))) {
      const src = fs.readFileSync(pathMod.join(__dirname, f), "utf8");
      // Each spawn call, plus the env object literal that follows it.
      for (const m of src.matchAll(/spawn\(\s*process\.execPath[\s\S]{0,1200}?\}\s*\)/g)) {
        if (!/server\.js/.test(m[0])) continue;
        const line = src.slice(0, m.index).split("\n").length;
        // Either an inline `NODE_OPTIONS:` key, or an `env` variable pinned
        // somewhere above the spawn — BOTH shapes of that: a property write
        // (`env.NODE_OPTIONS = ""`) and an object literal built from a spread
        // (`const env = { ...serverEnv(slot), NODE_OPTIONS: "" }`). v7.20.9:
        // the second shape was missing, so a spawn that DID pin it correctly
        // was reported as an offender — and a scanner that is wrong about
        // working code is one that gets deleted by whoever hits it next.
        const inline = /NODE_OPTIONS\s*:/.test(m[0]);
        const viaVar = /NODE_OPTIONS\s*[:=]/.test(src.slice(Math.max(0, m.index - 1500), m.index));
        if (!inline && !viaVar) bad.push(`${f}:${line}`);
      }
    }
    expect(bad,
      "these tests spawn a server child without pinning NODE_OPTIONS, so an ambient " +
      "--require/--inspect/--throw-deprecation on the runner changes the child's exit " +
      "path underneath the assertion (this exact bug cost a CI round trip in v7.15.29). " +
      'Add `NODE_OPTIONS: ""` to the child env:\n  ' + bad.join("\n  ")
    ).toEqual([]);
  });

  test("v7.15.17: the session-slide skip-list resists path variants", async () => {
    // The FOURTH path gate, missed when v7.15.16 migrated the other three even
    // though its own comment cites them. Direction matters: a missed match in
    // the body-parser lookups fails CLOSED, but here it fails OPEN — the slide
    // is a session DATA write, and it would then run on exactly the endpoints
    // that regenerate() or destroy() their session mid-request.
    //
    // The slide's observable signature is a refreshed Set-Cookie carrying a new
    // Expires (see the v7.14.4 lock) — asserting on that is the only way to see
    // it from outside.
    // MUST be an authenticated session: the slide only runs for one, so an
    // anonymous context would never slide and every assertion would hold
    // vacuously (an earlier draft of this test did exactly that and passed with
    // the fix reverted).
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    try {
      const slid = async (path) => {
        const r = await api.post(path, {
          headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: {},
        });
        const sc = r.headers()["set-cookie"] || "";
        return /expires=/i.test(sc);
      };
      // Control: an ordinary authenticated write DOES slide. Without this the
      // test cannot tell "the skip-list works" from "nothing ever slides".
      expect(await slid("/api/session/keepalive"),
        "control: an authenticated write must slide, or this test proves nothing"
      ).toBe(true);
      // /api/register owns its session lifecycle and is on _SESSION_SLIDE_SKIP.
      // Every routable spelling of it must be treated the same.
      for (const v of ["/api/register", "/api/register/", "/API/register", "/api//register"]) {
        expect(await slid(v),
          `${v} is on the slide skip-list and must not slide the session — a variant that ` +
          `slips past the lookup writes to a session the handler is about to replace`
        ).toBe(false);
      }
    } finally { await api.dispose(); }
  });

  test("v7.15.15 root-cause: every abort deadline survives the response BODY read", () => {
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir)) {
        if (e === "node_modules" || e === "vendor" || e.startsWith(".")) continue;
        const full = pathMod.join(dir, e);
        const st = fs.statSync(full);
        if (st.isDirectory()) { walk(full); continue; }
        if (/\.js$/.test(e)) files.push(full);
      }
    })(pathMod.join(root, "public", "js"));
    files.push(pathMod.join(root, "lib", "http.js"));

    const offenders = [];
    for (const f of files) {
      // Strip comments FIRST, keeping line numbering intact (blank the content,
      // keep the newline). This scanner originally matched on proximity to the
      // `fetch` call and a five-line explanatory comment above the clearTimeout
      // was enough to push it out of the window — i.e. the comment describing
      // the fix defeated the check for it. Same normalisation the other
      // mechanical scanners in this file use.
      const src = fs.readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(Math.max(0, m.length - p1.length)));
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        const cleared = line.match(/clearTimeout\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/);
        if (!cleared) return;
        // v8.8.19 — COUNT THE AHEAD WINDOW IN NON-BLANK LINES. Comments are
        // already blanked above, so a fixed slice makes the window's reach
        // depend on how much prose sits inside it — the same class as the
        // proximity bug this scanner was rewritten for once already.
        const ahead = [];
        for (let j = i + 1; j < lines.length && ahead.length < 5; j++) {
          if (lines[j].trim()) ahead.push(lines[j]);
        }
        if (!/\.(json|text|arrayBuffer|blob|formData|bytes)\s*\(/.test(ahead.join("\n"))) return;

        // v8.8.19 — ASK WHETHER THIS FUNCTION ARMED THE DEADLINE IT IS CLEARING,
        // rather than whether a `fetch(` happens to appear above.
        //
        // The old behind-test flagged ANY clearTimeout near a fetch, so a
        // correctly-bounded fetch beside an unrelated debounce clear
        // (`clearTimeout(searchDebounce)`) was reported as an offender —
        // measured on a probe. A scanner that is wrong about working code is one
        // the next person deletes, so this is a liability removed as well as
        // coverage gained: detection went 4/9 to 6/9 with no new false positive,
        // picking up `features/auth.js` and `features/export-import.js`.
        //
        // Matching the IDENTIFIER is what makes it precise: a timer armed to
        // abort a request is the only one worth clearing after the body. A site
        // that arms its timer further above than this lookback is missed, which
        // fails CLOSED — under-reporting, never a false alarm.
        const behind = lines.slice(Math.max(0, i - 12), i).join("\n");
        const armed = new RegExp(
          "(?:const|let|var)\\s+" + cleared[1] + "\\s*=\\s*setTimeout\\([\\s\\S]*?abort\\s*\\("
        ).test(behind);
        if (armed) offenders.push(`${pathMod.relative(root, f)}:${i + 1}`);
      });
    }
    expect(offenders,
      "A deadline cleared BEFORE the body is read leaves a stalled body unbounded — " +
      "`fetch` resolves at response HEADERS, not at settle. Move the clearTimeout " +
      "after the body read (or into a finally that runs after it). Offending sites:\n  " +
      offenders.join("\n  ")
    ).toEqual([]);
  });

  test("v7.15.15 root-cause: the attachment preflight RESERVES, it does not merely check", () => {
    // The sibling class: check-then-act. v7.15.11 fixed it for staging; the
    // preflight added in v7.15.13 reintroduced it one layer earlier. Pinning the
    // shape means a future "cheap early check" cannot be added back without a
    // reservation and pass CI.
    const fs = require("fs"), pathMod = require("path");
    const src = fs.readFileSync(pathMod.join(__dirname, "..", "lib", "attachments.js"), "utf8");
    const fn = src.slice(src.indexOf("function preflightAttachmentBudget"));
    const body = fn.slice(0, fn.indexOf("\nfunction "));
    expect(body,
      "preflightAttachmentBudget must TAKE a reservation, not just read the budget — " +
      "otherwise N concurrent uploads all pass the same reading and stream their bodies to disk"
    ).toMatch(/reserveAttachmentBudget\s*\(/);
    expect(body, "and it must hand the reservation to the route so it can be swapped for a real-size one")
      .toMatch(/_attachPreflightRelease/);
  });

  // ── ext-audit v7.20.9 (F8) — detached work must be COUNTABLE ────────────────
  // v7.15.15 introduced detachedFanoutPending() for exactly this and covered
  // only the bulk fan-out; `sendEmailBackground` — the ordinary fire-and-forget
  // sender behind verification, lockout, unlock and group-sync mail — stayed
  // invisible to the shutdown drain for five releases. Prose in CLAUDE.md did
  // not prevent that, so this is the mechanical net: a detached send that
  // nothing counts cannot be added without failing here.
  test("v7.20.9 (F8): every DETACHED email send is countable at shutdown", () => {
    // SCOPE, stated honestly: this is a cheap net for the NAIVE shape — a
    // literal call to one of the three senders whose result is thrown away on
    // the line it appears on. It cannot see a send reached through a variable,
    // a dynamic property, or a helper of its own. It exists because F8 was
    // precisely that naive shape, repeated in six places. Clear a future
    // failure by wrapping the site, never by widening the exemptions.
    const fs = require("fs"), path = require("path");
    const root = path.resolve(__dirname, "..");
    // Strip string/template/comment CONTENT (keeping newlines). It matters twice
    // here: lib/email.js logs the literal text "sendEmailBackground(" inside a
    // template on its own error path, and the comments explaining this very fix
    // name all three senders. A scanner defeated by the comment describing it is
    // the documented v7.15.15 failure.
    const stripJs = _stripJsForScan;

    // `sendEmailBackground` is exempt from the wrap requirement ONLY because its
    // own body takes the reservation. DERIVE that from the source rather than
    // hard-coding it: if someone deletes the wrapper from the definition, every
    // bare call becomes a violation instead of the exemption silently widening.
    const emailSrc = stripJs(fs.readFileSync(path.join(root, "lib", "email.js"), "utf8"));
    const bgStart = emailSrc.indexOf("function sendEmailBackground(");
    expect(bgStart, "lib/email.js must still define sendEmailBackground").toBeGreaterThan(-1);
    const bgBody = emailSrc.slice(bgStart, emailSrc.indexOf("\n}", bgStart));
    const SELF_TRACKING = new Set();
    if (/trackDetachedSend\s*\(/.test(bgBody)) SELF_TRACKING.add("sendEmailBackground");
    expect([...SELF_TRACKING],
      "sendEmailBackground is the ordinary fire-and-forget sender (verification, lockout, " +
      "unlock, group add/remove, reconciliation). Its own body must wrap the send in " +
      "trackDetachedSend(), or none of that mail is countable at shutdown and a rolling " +
      "deployment closes the database under it."
    ).toEqual(["sendEmailBackground"]);

    const SENDERS = ["sendEmailBackground", "sendLockoutEmail", "sendUnlockEmail"];
    const files = [
      path.join(root, "server.js"),
      ...fs.readdirSync(path.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => path.join(root, "routes", f)),
      ...fs.readdirSync(path.join(root, "lib")).filter(f => f.endsWith(".js")).map(f => path.join(root, "lib", f)),
    ];
    const offenders = [];
    for (const f of files) {
      const lines = stripJs(fs.readFileSync(f, "utf8")).split("\n");
      lines.forEach((line, i) => {
        // A wrap that opens on the previous line still counts:
        //   trackDetachedSend(
        //     sendUnlockEmail(u).catch((e) => swallowed("x", e))
        //   );
        const prevOpensWrap = /trackDetachedSend\s*\(\s*$/.test(lines[i - 1] || "");
        for (const name of SENDERS) {
          const re = new RegExp("\\b" + name + "\\s*\\(", "g");
          let m;
          while ((m = re.exec(line)) !== null) {
            const pre = line.slice(0, m.index);
            if (/\bfunction\s+$/.test(pre)) continue;          // the definition itself
            if (/\b(await|return|yield)\s+$/.test(pre)) continue; // result is consumed
            if (/[=:]\s*$/.test(pre)) continue;                // assigned / stored
            if (/trackDetachedSend\s*\(/.test(pre) || prevOpensWrap) continue; // already counted
            if (SELF_TRACKING.has(name)) continue;             // counts itself (asserted above)
            offenders.push(`${path.relative(root, f)}:${i + 1} — ${name}(`);
          }
        }
      });
    }
    expect(offenders,
      "A fire-and-forget send that nothing counts is invisible to the graceful-shutdown " +
      "drain, so a rolling deployment silently loses mail the API already reported as " +
      "sending. Wrap it: trackDetachedSend(sendX(...).catch((e) => swallowed(\"<module>:<purpose>\", e))). Offending sites:\n  " +
      offenders.join("\n  ")
    ).toEqual([]);
  });

  // ── ext-audit v7.20.9 (F1) — the grading token is a KEYED value ─────────────
  test("v7.20.9 (F1): the grading token is HMAC-keyed, and the submit check is unconditional", () => {
    // taskGradingHash used to be an UNKEYED, truncated SHA-1 over
    // answer_type + correct_answer + choices, handed to the participant on every
    // GET /api/tasks/:id. Every component except the answer is already in the
    // client's hands, so the token was a published, offline-checkable oracle for
    // the one field that must stay secret — a 12-option choice answer was
    // recovered in 3 ms. Two properties have to hold together, which is why they
    // are asserted together: the token must be KEYED, and the submit path must
    // ALWAYS compare it (it was optional for back-compat, i.e. opt-out — omit
    // one field and you were graded against whatever the criteria are now).
    const fs = require("fs"), path = require("path");
    const root = path.resolve(__dirname, "..");
    // lib/scoring.js is scanned with COMMENTS stripped but STRINGS KEPT — the
    // algorithm name lives in a string literal (`createHmac("sha256", …)`), so
    // the string-blanking normaliser used for server.js below would erase the
    // very thing under test. Comment-stripping is load-bearing all the same:
    // scoring.js documents the old construction as
    // `sha1(answer_type + ":" + correct_answer + ":" + choices)` in a comment,
    // so a raw scan would report the fix as unfixed.
    //
    // v7.21.1 — this used to strip LINE comments only, and ASSERTED that the
    // module carried no block comment so the shortcut could not rot silently.
    // That assertion did its job: the A2 fix added one, and this test went red
    // rather than quietly mis-scanning. Both comment forms are stripped now, so
    // the precondition is no longer needed. Block comments are replaced by their
    // own newlines to keep line numbers intact for any future line-based check.
    const rawScoring = fs.readFileSync(path.join(root, "lib", "scoring.js"), "utf8");
    const stripComments = (src) => src
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ""))
      .split("\n").map(l => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

    const scoring = stripComments(rawScoring);
    const fnStart = scoring.indexOf("function taskGradingHash(");
    expect(fnStart, "lib/scoring.js must still define taskGradingHash").toBeGreaterThan(-1);
    const fnBody = scoring.slice(fnStart, scoring.indexOf("\n}", fnStart));
    expect(fnBody,
      "taskGradingHash must be an HMAC over a server-held secret — an unkeyed digest over " +
      "material the participant already possesses is an offline oracle for correct_answer"
    ).toMatch(/createHmac\s*\(/);
    expect(fnBody, "and it must not fall back to an unkeyed digest").not.toMatch(/createHash\s*\(/);
    expect(scoring, "no unkeyed SHA-1 anywhere in the grading module")
      .not.toMatch(/createHash\s*\(\s*["']sha1["']/i);
    // Positive control on the KEY itself: an HMAC over a constant is no better
    // than a hash, so the key must come from the persisted per-install secret.
    expect(fnBody, "the HMAC key must be the persisted DATA_DIR/.grading-secret, not a constant")
      .toMatch(/_gradingKey\s*\(\s*\)/);

    const srv = _stripJsForScan(fs.readFileSync(path.join(root, "server.js"), "utf8"));
    // Positive control FIRST, and it names the EXACT comparison — without it,
    // "the comparison is not gated" is equally satisfied by there being no
    // comparison at all, or by the normaliser having blanked the region (which
    // is precisely what a regex block-comment strip did here: it mispaired
    // against server.js's own CSS-minifier regex literals, blanked the submit
    // handler, and let a deliberately re-broken `if (submittedHash)` pass).
    expect(srv, "the submit path must compare the submitted token against the current one")
      .toMatch(/submittedHash\s*!==\s*currentHash/);
    expect(srv,
      "the comparison must be UNCONDITIONAL. Gating it behind `if (submittedHash)` makes the " +
      "mid-flight-edit protection opt-out: omit the field and the server grades you against " +
      "whatever the criteria happen to be. A missing token is treated exactly like a stale one."
    ).not.toMatch(/if\s*\(\s*submittedHash\s*\)/);
    expect(srv, "nor may it be gated by a truthiness AND on the comparison")
      .not.toMatch(/submittedHash\s*&&\s*submittedHash\s*!==/);
  });

  test("ext-audit batch 3+4 (F1): EVERY audit-emitting db.transaction in routes/ + server.js + lib/ is wrapped (no carve-out)", () => {
    // Cycle-ender. The "emit-last carve-out" caused recurring audit findings
    // because identifying 'the emit is the last statement' is error-prone (a
    // double-emit like sessions.js tsCreateTxn was misclassified). The invariant
    // is now UNCONDITIONAL: every db.transaction whose body calls a record*Event
    // / createTaskVersion helper MUST run via runTxnWithMirrorBuffer, so a
    // rollback can never strand a ghost app.jsonl mirror line. This test scans
    // the source mechanically (stripping strings/comments/template-literals first
    // so SQL parens + `${}` interpolations don't fool the brace scan) and fails
    // if ANY emit-bearing txn is left bare — catching future regressions too.
    // batch 4: the scan now spans routes/ + server.js + lib/ (batch 3 only
    // covered routes/, which missed the task-import importTxn in server.js).
    const fs = require("fs");
    const path = require("path");
    const root = path.resolve(__dirname, "..");
    const scanFiles = [
      path.join(root, "server.js"),
      path.join(root, "db.js"),
      ...fs.readdirSync(path.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => path.join(root, "routes", f)),
      ...fs.readdirSync(path.join(root, "lib")).filter(f => f.endsWith(".js")).map(f => path.join(root, "lib", f)),
    ];
    // Strip JS string/template/comment CONTENT (keep newlines) so brace/paren
    // scanning isn't fooled by SQL `(`/`)` or template `${...}` braces.
    const stripJs = (src) => {
      let out = "", i = 0; const n = src.length; let st = "code";
      while (i < n) {
        const c = src[i], c2 = src[i + 1];
        if (st === "code") {
          if (c === "/" && c2 === "/") { st = "line"; i += 2; }
          else if (c === "/" && c2 === "*") { st = "block"; i += 2; }
          else if (c === "'") { st = "sq"; out += " "; i++; }
          else if (c === '"') { st = "dq"; out += " "; i++; }
          else if (c === "`") { st = "tpl"; out += " "; i++; }
          else { out += c; i++; }
        } else if (st === "line") { if (c === "\n") { st = "code"; out += "\n"; } i++; }
        else if (st === "block") { if (c === "*" && c2 === "/") { st = "code"; i += 2; } else { if (c === "\n") out += "\n"; i++; } }
        else if (st === "sq") { if (c === "\\") i += 2; else if (c === "'") { st = "code"; i++; } else i++; }
        else if (st === "dq") { if (c === "\\") i += 2; else if (c === '"') { st = "code"; i++; } else i++; }
        else if (st === "tpl") { if (c === "\\") i += 2; else if (c === "`") { st = "code"; i++; } else { if (c === "\n") out += "\n"; i++; } }
      }
      return out;
    };
    const EMIT = /\b(record(Competition|Timeslot|User|Settings|Task|Challenge|Orphaned)?[A-Za-z]*Event|createTaskVersion)\s*\(/;
    const bare = [];
    for (const fileAbs of scanFiles) {
      const rel = path.relative(root, fileAbs);
      const clean = stripJs(fs.readFileSync(fileAbs, "utf8"));
      const lines = clean.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const declM = lines[i].match(/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*db\.transaction\s*\(/);
        const inlineWrap = /runTxnWithMirrorBuffer\s*\(\s*db\.transaction\s*\(/.test(lines[i]);
        const anonIIFE = !declM && /db\.transaction\s*\(/.test(lines[i]) && !/runTxnWithMirrorBuffer/.test(lines[i]);
        if (!declM && !inlineWrap && !anonIIFE) continue;
        // brace-scan the txn body
        let depth = 0, started = false, body = "";
        for (let j = i; j < lines.length; j++) {
          for (const ch of lines[j]) { if (ch === "{") { depth++; started = true; } else if (ch === "}") depth--; }
          body += lines[j] + "\n";
          if (started && depth <= 0) break;
        }
        if (!EMIT.test(body)) continue; // no audit emit → not in scope
        if (inlineWrap) continue;       // runTxnWithMirrorBuffer(db.transaction(...))
        if (declM) {
          const name = declM[1];
          // wrapped iff there is NO bare `name(` invocation outside the def
          let isBare = false;
          for (let k = 0; k < lines.length; k++) {
            if (k === i) continue;
            const r = new RegExp("\\b" + name + "\\s*\\(", "g"); let mm;
            while ((mm = r.exec(lines[k])) !== null) {
              const pre = lines[k].slice(0, mm.index);
              if (/runTxnWithMirrorBuffer\s*\(\s*\(\s*\)\s*=>\s*$/.test(pre)) continue;
              if (/runTxnWithMirrorBuffer\s*\(\s*$/.test(pre)) continue;
              isBare = true;
            }
          }
          if (isBare) bare.push(`${rel}:${i + 1} ${name}`);
        } else {
          bare.push(`${rel}:${i + 1} (anonymous emit-bearing IIFE)`);
        }
      }
    }
    expect(bare, `bare audit-emitting txns must be wrapped in runTxnWithMirrorBuffer:\n${bare.join("\n")}`).toEqual([]);
  });

  test("ext-audit batch 3 (F4): modal focus restoration captures the opener BEFORE focusing in", () => {
    // showModal must snapshot document.activeElement BEFORE confirmBtn.focus(),
    // else it restores focus to the hidden confirm button on close. overlayDismiss
    // owns systemic opener-capture+restore for the overlays that funnel through it.
    const fs = require("fs");
    const path = require("path");
    // Comments stripped first: the one above the capture quotes the old call.
    const mod = require("./doc-registry").stripJsComments(fs.readFileSync(path.resolve(__dirname, "..", "public/js/ui/modal.js"), "utf8"));
    // In showModal the _prevFocus capture appears BEFORE the confirmBtn.focus() call
    // (whatever its options: it focuses without scrolling).
    const capIdx = mod.indexOf("const _prevFocus=document.activeElement;");
    const focIdx = mod.search(/confirmBtn\.focus\(/);
    expect(capIdx, "_prevFocus capture not found").toBeGreaterThan(0);
    expect(focIdx, "confirmBtn.focus() not found").toBeGreaterThan(0);
    expect(capIdx, "_prevFocus must be captured BEFORE confirmBtn.focus()").toBeLessThan(focIdx);
    // overlayDismiss captures the opener (outside-overlay) + restores it on cleanup.
    expect(mod, "overlayDismiss must snapshot the opener").toMatch(/_opener\s*=\s*\(document\.activeElement[\s\S]*?!overlay\.contains\(document\.activeElement\)/);
    expect(mod, "cleanup must restore the opener").toMatch(/_opener[\s\S]*?\.focus\(\)/);
  });

  test("ext-audit batch 4 (F3+F4): UI duration cap + session-monitor forced cleanup restore focus", () => {
    const fs = require("fs");
    const path = require("path");
    const comp = fs.readFileSync(path.resolve(__dirname, "..", "public/js/features/competitions-admin.js"), "utf8");
    const sm = fs.readFileSync(path.resolve(__dirname, "..", "public/js/features/session-monitor.js"), "utf8");
    // F3: the d/h/m duration controls let days×1440 + h×60 + m exceed the server's
    // 525600-min cap; the client must reject the TOTAL before submit (≥2 sites:
    // single-comp + each multi-session row).
    const durChecks = (comp.match(/>\s*525600/g) || []).length;
    expect(durChecks, "client must validate total duration ≤525600 (single + session-row)").toBeGreaterThanOrEqual(2);
    // F4: stopSessionMonitor must tear the warn overlay down via _closeSessionWarning
    // (which restores + clears the opener), NOT a raw .remove() that leaks warnOpenerEl.
    const _stopStart = sm.indexOf("export function stopSessionMonitor");
    const _stopEnd = sm.indexOf("export function", _stopStart + 1);
    const stop = sm.slice(_stopStart, _stopEnd > 0 ? _stopEnd : _stopStart + 1500);
    expect(stop, "stopSessionMonitor must call _closeSessionWarning()").toMatch(/_closeSessionWarning\(\)/);
    expect(stop, "stopSessionMonitor must NOT raw-remove the warn overlay").not.toMatch(/getElementById\('session-warn-overlay'\)\?\.remove\(\)/);
  });

  test("the confirm modal (#modal-overlay) stacks ABOVE the dialogs that spawn it", () => {
    // A confirmation opened FROM the self-enroll / reset-link overlays (z 9500) or
    // the session-warning (9200) must render on top, not behind. Regression for the
    // self-enroll "Regenerate link" confirmation appearing under the link dialog.
    const fs = require("fs");
    const path = require("path");
    const css = fs.readFileSync(path.resolve(__dirname, "..", "public/styles.css"), "utf8");
    const zOf = (sel) => {
      const m = css.match(new RegExp(sel.replace(/[#.]/g, "\\$&") + "\\{[^}]*z-index:(\\d+)"));
      return m ? parseInt(m[1], 10) : null;
    };
    const modalZ = zOf("#modal-overlay");
    const selfEnrollZ = zOf("#self-enroll-overlay");
    const sessionWarnZ = 9200; // session-warn-overlay inline z-index
    expect(modalZ, "#modal-overlay z-index not found").toBeGreaterThan(0);
    expect(selfEnrollZ, "#self-enroll-overlay z-index not found").toBeGreaterThan(0);
    expect(modalZ, "confirm modal must stack above #self-enroll-overlay").toBeGreaterThan(selfEnrollZ);
    expect(modalZ, "confirm modal must stack above the session-warning overlay").toBeGreaterThan(sessionWarnZ);
  });

  test("the self-enroll dialog surfaces an 'inactive until enabled' state", () => {
    // A self-enroll link does nothing until self_enroll_enabled is toggled on
    // (default OFF). The dialog must visibly say so + dim the link/QR, and update
    // live on toggle — otherwise an admin copies a link that silently 404s
    // ("this link is no longer valid") for every visitor.
    const fs = require("fs");
    const path = require("path");
    const se = fs.readFileSync(path.resolve(__dirname, "..", "public/js/features/self-enroll.js"), "utf8");
    const css = fs.readFileSync(path.resolve(__dirname, "..", "public/styles.css"), "utf8");
    expect(se, "dialog must render the inactive note element").toMatch(/id="self-enroll-inactive-note"/);
    expect(se, "must have a state-render helper").toMatch(/function _seRenderEnabledState\(overlay,enabled\)/);
    // wired on open (from data.enabled) AND on a successful enabled-toggle.
    expect(se, "render state on open").toMatch(/_seRenderEnabledState\(overlay,!!data\.enabled\)/);
    expect(se, "render state on toggle").toMatch(/self_enroll_enabled'\)_seRenderEnabledState\(overlay,desired\)/);
    expect(css, "CSS must style the inactive note + dim the link/QR").toMatch(/self-enroll-inactive-note|\.se-inactive/);
  });

  test("ext-audit batch 5+6: no req.body field is string-methoded without a typeof guard (the recurring 500 class)", () => {
    // The "non-string body → .trim() → HTTP 500" class kept recurring (it had no
    // mechanical lock — see the root-cause analysis). This scanner ENDS it. It
    // flags a req.body value string-methoded without a guard in FIVE shapes:
    //   (1) destructured: `const { X } = req.body` … X.trim() / String(X)
    //   (2) direct:       req.body.X.trim() / req.body?.X.trim() / req.body.X?.trim()
    //   (3) coalesce:     (req.body.X || "").trim()  — `|| ""` only catches FALSY
    //   (4) String():     String(req.body.X || "")
    //   (5) numeric:      Number(req.body.X) / parseInt(…) / parseFloat(…), which
    //                     convert through the same toString/valueOf and throw alike
    //   (6) pass-through: fn(a, req.body?.X) / fn(req.body.X || "") hands the raw
    //                     value to a call, and `(req.body && req.body.X) || ""` keeps
    //                     a truthy object: the String() that throws is then in lib/,
    //                     where no shape above can see it (sweep #193: the code
    //                     redeem, the code request's limiter key, POST /credential).
    //                     Its guard is LOCAL, never file-wide: the statement itself
    //                     holds `typeof req.body?.X`, or the callee is a reviewed
    //                     validator that checks the type itself (PASS_VALIDATORS).
    //                     Read a body value into a typed local before handing it on.
    // batch 6 added (2)+(3): the batch-5 version tracked ONLY destructured fields,
    // so it missed forgot-password `identifier` + submit `answer` (the auditor's
    // gap finding). Recognized guards: `typeof X`, `typeof req.body?.X`,
    // `_firstNonStringField(req.body, [...])`, `_groupNameOk(X)`, and a
    // `for (const f of ["X", …]) if (… typeof req.body[f] …)` loop.
    // `.toString()` counts as a string method, and `String(X)` is NOT a guard for a
    // body value: JSON, and the form parser (`x[toString]=1`), can deliver an object
    // whose own toString is not callable, which throws inside both — so a
    // String()-wrapped body read is a fourth shape. (A req.query value is a string
    // or an array of strings under Express 5's simple parser, so String() and
    // `.toString()` stay safe there.)
    // Strings/comments/templates are stripped first; `obj.field` is excluded via a
    // lookbehind. Clear a future failure by ADDING a guard, not weakening the test.
    const fs = require("fs");
    const path = require("path");
    const root = path.resolve(__dirname, "..");
    const stripJs = (src) => {
      let o = "", i = 0; const n = src.length; let st = "code";
      while (i < n) {
        const c = src[i], c2 = src[i + 1];
        if (st === "code") {
          if (c === "/" && c2 === "/") { st = "line"; i += 2; }
          else if (c === "/" && c2 === "*") { st = "block"; i += 2; }
          else if (c === "'") { st = "sq"; o += " "; i++; }
          else if (c === '"') { st = "dq"; o += " "; i++; }
          else if (c === "`") { st = "tpl"; o += " "; i++; }
          else { o += c; i++; }
        } else if (st === "line") { if (c === "\n") { st = "code"; o += "\n"; } i++; }
        else if (st === "block") { if (c === "*" && c2 === "/") { st = "code"; i += 2; } else { if (c === "\n") o += "\n"; i++; } }
        else if (st === "sq") { if (c === "\\") i += 2; else if (c === "'") { st = "code"; i++; } else i++; }
        else if (st === "dq") { if (c === "\\") i += 2; else if (c === '"') { st = "code"; i++; } else i++; }
        else if (st === "tpl") { if (c === "\\") i += 2; else if (c === "`") { st = "code"; i++; } else { if (c === "\n") o += "\n"; i++; } }
      }
      return o;
    };
    const files = [...fs.readdirSync(path.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => "routes/" + f), "server.js"];
    // How many reads each body shape matched, guarded or not (anti-vacuity floor).
    const seen = { destructured: 0, direct: 0, coalesce: 0, string: 0, numeric: 0, passthrough: 0 };
    // Callees that check the type of what they are handed (each reviewed): a body
    // value may reach them bare. String/Number/parseInt/parseFloat are shapes (4)
    // and (5), judged there. Adding a name here is a reviewed act.
    const PASS_VALIDATORS = /^(?:[\w$]+\.)?(?:validate[A-Z]\w*|_isPlainObject|_resolveAttemptCap|sealChangeDenied|Array\.isArray|Number\.isInteger|Number\.isFinite|String|Number|parseInt|parseFloat)$/;
    const scan = (file, rawSrc, viol) => {
      const clean = stripJs(rawSrc);
      const fields = new Set();
      for (const m of clean.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*req\.body/g))
        for (const part of m[1].split(",")) { const id = part.split(":")[0].split("=")[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(id)) fields.add(id); }
      const fnsfGuarded = new Set();
      for (const m of rawSrc.matchAll(/_firstNonStringField\([^)]*\[([^\]]*)\]/g))
        for (const q of m[1].matchAll(/"([A-Za-z_$][\w$]*)"/g)) fnsfGuarded.add(q[1]);
      // `for (const f of ["a", "b"]) { if (req.body[f] != null && typeof req.body[f] !== "string") …`
      for (const m of rawSrc.matchAll(/for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s*\[([^\]]*)\]\s*\)\s*\{?\s*if\s*\([^;{]*typeof\s+req\.body\[\1\]/g))
        for (const q of m[2].matchAll(/"([A-Za-z_$][\w$]*)"/g)) fnsfGuarded.add(q[1]);
      const M = "(trim|toLowerCase|toUpperCase|normalize|toString)";
      const MQ = "(trim|toLowerCase|toUpperCase|normalize)";
      const guardOf = (f) =>
        new RegExp("typeof\\s+" + f + "\\b").test(clean) ||
        new RegExp("typeof\\s+req\\.body\\??\\." + f + "\\b").test(clean) ||
        new RegExp("\\b_groupNameOk\\(\\s*" + f + "\\b").test(clean) ||
        fnsfGuarded.has(f);
      // (1) DESTRUCTURED fields: `const { X } = req.body` then X.trim() or String(X)
      for (const f of fields) {
        if (!new RegExp("(?<![.\\w$])" + f + "\\s*\\." + M + "\\s*\\(").test(clean)
            && !new RegExp("\\bString\\(\\s*" + f + "\\b").test(clean)) continue;
        seen.destructured++;
        if (!guardOf(f))
          viol.push(`${file}: req.body.${f} (destructured) is string-methoded or String()-wrapped without a guard`);
      }
      // (2) DIRECT access: req.body.X.trim() / req.body?.X.trim() / req.body.X?.trim()
      // (batch 6 — the destructured-only scanner missed these: forgot-password
      // identifier, submit answer). Guarded by typeof req.body?.X.
      for (const m of clean.matchAll(new RegExp("req\\.body\\??\\.([A-Za-z_$][\\w$]*)\\s*\\??\\." + M + "\\s*\\(", "g"))) {
        seen.direct++;
        if (!guardOf(m[1])) viol.push(`${file}: req.body.${m[1]}.${m[2]}() (direct) without a typeof guard`);
      }
      // (3) COALESCE: (req.body.X || ...).trim(), also with leading operands
      // ((req.query.X || req.body.X || "").toString()) — `|| ""` only catches FALSY,
      // so a truthy non-string still 500s. String()-wrapped ones are shape (4).
      for (const m of clean.matchAll(new RegExp("(?<!String)\\(\\s*[^()]*?req\\.body\\??\\.([A-Za-z_$][\\w$]*)\\b[^)]*\\)\\s*\\." + M + "\\s*\\(", "g"))) {
        seen.coalesce++;
        if (!guardOf(m[1])) viol.push(`${file}: (req.body.${m[1]} || ...).${m[2]}() (coalesce) without a typeof guard`);
      }
      // (4) STRING(): String(req.body.X …)
      for (const m of clean.matchAll(/\bString\(\s*req\.body\??\.([A-Za-z_$][\w$]*)/g)) {
        seen.string++;
        if (!guardOf(m[1])) viol.push(`${file}: String(req.body.${m[1]} …) without a typeof guard`);
      }
      // (5) NUMERIC: Number(req.body.X) / parseInt(req.body.X) / parseFloat(req.body.X)
      for (const m of clean.matchAll(/\b(Number|parseInt|parseFloat)\(\s*req\.body\??\.([A-Za-z_$][\w$]*)/g)) {
        seen.numeric++;
        if (!guardOf(m[2])) viol.push(`${file}: ${m[1]}(req.body.${m[2]} …) without a typeof guard`);
      }
      // (6) PASS-THROUGH (sweep #193), guarded only at the read (see the header).
      // The window is the statement ON ITS LINE: a call inside an options object
      // (a limiter's `keyExtra`) has no `;` of its own, and the next one ends the
      // handler's first line, whose own typed read must not clear it.
      const stmtOf = (idx) => {
        const a = Math.max(clean.lastIndexOf(";", idx), clean.lastIndexOf("{", idx), clean.lastIndexOf("}", idx), clean.lastIndexOf("\n", idx)) + 1;
        const ends = [clean.indexOf(";", idx), clean.indexOf("\n", idx)].filter(i => i >= 0);
        return clean.slice(a, ends.length ? Math.min(...ends) : clean.length);
      };
      const localGuard = (f, idx) => new RegExp("typeof\\s+req\\.body\\??\\." + f + "\\b").test(stmtOf(idx));
      for (const m of clean.matchAll(/([\w$.]+)\(\s*(?:[^()]*?,\s*)?req\.body\??\.([A-Za-z_$][\w$]*)\s*(?:\|\|[^,()]*)?[,)]/g)) {
        seen.passthrough++;
        if (PASS_VALIDATORS.test(m[1].replace(/^\./, "")) || localGuard(m[2], m.index)) continue;
        viol.push(`${file}: ${m[1]}(… req.body.${m[2]} …) hands a body value on bare (read it into a typed local first)`);
      }
      for (const m of clean.matchAll(/\(\s*req\.body\s*&&\s*req\.body\.([A-Za-z_$][\w$]*)\s*\)\s*\|\|/g)) {
        seen.passthrough++;
        if (localGuard(m[1], m.index)) continue;
        viol.push(`${file}: (req.body && req.body.${m[1]}) || … keeps a truthy non-string (guard it with typeof)`);
      }
      // audit v7.7.38 — QUERY-PARAM variant. The batch-5+6 lock scanned req.body
      // ONLY; the rerun found check-nickname + admin/logs 500 on an ARRAY query param
      // (a repeated ?k=a&k=b is an array under Express 5). Same shapes, req.query.
      // Guards: `typeof req.query.X`, `typeof req.query?.X`, `String(req.query.X)`.
      const guardOfQuery = (f) =>
        new RegExp("typeof\\s+req\\.query\\??\\." + f + "\\b").test(clean) ||
        new RegExp("\\bString\\(\\s*req\\.query\\??\\." + f + "\\b").test(clean);
      // direct: req.query.X.trim() / req.query?.X.trim()
      for (const m of clean.matchAll(new RegExp("req\\.query\\??\\.([A-Za-z_$][\\w$]*)\\s*\\??\\." + MQ + "\\s*\\(", "g")))
        if (!guardOfQuery(m[1])) viol.push(`${file}: req.query.${m[1]}.${m[2]}() (direct) without a typeof guard`);
      // coalesce / ternary: (…req.query.X…).trim()
      for (const m of clean.matchAll(new RegExp("\\(\\s*[^)]*req\\.query\\??\\.([A-Za-z_$][\\w$]*)\\b[^)]*\\)\\s*\\." + MQ + "\\s*\\(", "g")))
        if (!guardOfQuery(m[1])) viol.push(`${file}: (…req.query.${m[1]}…).${m[2]}() (coalesce) without a typeof guard`);
    };
    const viol = [];
    for (const file of files) scan(file, fs.readFileSync(path.join(root, file), "utf8"), viol);
    expect(viol, `unguarded req.body/req.query string-method calls (would 500 on a non-string input):\n${viol.join("\n")}`).toEqual([]);
    const matched = Object.values(seen).reduce((a, b) => a + b, 0);
    expect(matched, `anti-vacuity: the body shapes must still match the tree's guarded reads (${JSON.stringify(seen)})`).toBeGreaterThanOrEqual(20);
    // The pass-through shape sees the tree's reviewed validator calls (twelve when
    // it was written), so a regex that stopped matching cannot pass silently.
    expect(seen.passthrough, `anti-vacuity: the pass-through shape must still match the validator calls (${JSON.stringify(seen)})`).toBeGreaterThanOrEqual(10);
    // PLANTED control: one unguarded read per shape is flagged by name; its guarded
    // twin, scanned on its own (a guard counts file-wide), is not.
    const planted = [
      "const { a1 } = req.body; a1.trim();",
      "req.body.a2.toLowerCase();",
      "(req.query.a0 || req.body.a3 || '').toString();",
      "String(req.body.a4 || '');",
      "Number(req.body.a5);",
      "parseInt(req.body.a6, 10);",
      "req.query.a7.trim();",
      "(req.query.a8 || '').trim();",
      "resolveCodeAttempt(email, req.body?.a9);",
      "const r = (req.body && req.body.b1) || '';",
      "lookup(req.body?.b2 || '');",
      // The code request's limiter key before sweep #193: a typed read of the same
      // field on the handler's first line, the next statement, must not clear it.
      "rateLimit(1, 5, 'k', { keyExtra: (req) => normaliseEmail(req.body?.b3 || '') }), csrfProtection, async (req, res) => {\n  const e = normaliseEmail(typeof req.body?.b3 === 'string' ? req.body.b3 : '');",
    ];
    const flagged = [];
    scan("planted", planted.join("\n"), flagged);
    expect(flagged.map(v => (v.match(/\.([ab]\d)\b/) || [])[1]).sort(),
      `the planted reads, one per shape:\n${flagged.join("\n")}`).toEqual(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "b1", "b2", "b3"]);
    // (6) is LOCAL: a typeof guard elsewhere in the file does not clear a bare
    // pass-through (the file-wide guard is what let sweep #193 through), while a
    // typed read in the statement itself, or a reviewed validator, does.
    const wide = [];
    scan("file-wide", "if (typeof req.body?.a9 !== 'string') x();\nresolveCodeAttempt(email, req.body?.a9);", wide);
    expect(wide.length, `a file-wide typeof must not clear a bare pass-through:\n${wide.join("\n")}`).toBe(1);
    const fine = [];
    scan("typed-read", "resolveCodeAttempt(email, typeof req.body?.a9 === 'string' ? req.body.a9 : '');\nvalidateFoo(req.body.b4);\nconst c = typeof req.body?.b5 === 'string' ? (req.body && req.body.b5) || '' : '';", fine);
    expect(fine, "a typed read in the statement, or a reviewed validator, is not flagged").toEqual([]);
    for (const line of planted.filter(l => /\ba[1-8]\b/.test(l))) {
      const f = line.match(/\b(a[1-8])\b/)[1];
      const guard = /req\.query/.test(line) && !/req\.body/.test(line)
        ? `if (typeof req.query.${f} !== 'string') return;` : `if (typeof req.body.${f} !== 'string') return; if (typeof ${f} !== 'string') return;`;
      const twin = [];
      scan("guarded", `${guard}\n${line}`, twin);
      expect(twin, `the guarded twin of: ${line}`).toEqual([]);
    }
  });

  test("ext-audit batch 7: validateBody is the boundary that makes the malformed-body class impossible", () => {
    // Unit lock for lib/validate.js — the structural fix (option 1) the comp/
    // session/tag routes now go through. Every malformed shape from batches 1-6
    // must produce a clean { error } (→ 400), and valid input must NORMALIZE
    // (trim strings, ISO dates, parse ints) so the handler never touches a raw
    // untyped value.
    const { validateBody, allOptional } = require(require("path").resolve(__dirname, "..", "lib/validate.js"));
    const S = {
      name: { type: "string", required: true, max: 120, label: "Name" },
      start_time: { type: "date", required: true, label: "Start time" },
      duration_minutes: { type: "int", required: true, min: 1, max: 525600, label: "Duration" },
      mode: { type: "enum", values: ["global", "per_slot"] },
      tags: { type: "stringArray", itemMax: 50 },
    };
    // valid → normalized
    const okv = validateBody({ name: "  Cup  ", start_time: "2026-01-01T10:00:00Z", duration_minutes: "120", tags: ["a", " b "] }, S);
    expect(okv.error, "valid body should pass").toBeUndefined();
    expect(okv.values.name).toBe("Cup");                                  // trimmed
    expect(okv.values.start_time).toBe("2026-01-01T10:00:00.000Z");       // ISO-normalized
    expect(okv.values.duration_minutes).toBe(120);                        // parsed int
    expect(okv.values.tags).toEqual(["a", "b"]);                          // trimmed elements
    // every malformed shape → { error } (would have been a 500 / corruption / blank)
    const bad = [
      { name: ["x"], start_time: "2026-01-01", duration_minutes: 60 },    // non-string → was .trim() 500
      { name: "   ", start_time: "2026-01-01", duration_minutes: 60 },    // whitespace-only → was blank stored
      { name: "x", start_time: 1, duration_minutes: 60 },                 // numeric date → was stored "1.0" → 500 on read
      { name: "x", start_time: "1.0", duration_minutes: 60 },             // invalid date
      { name: "x", start_time: "2026-01-01", duration_minutes: -1 },      // below range
      { name: "x", start_time: "2026-01-01", duration_minutes: [180] },   // array → was parseInt-coerced
      { name: "x".repeat(121), start_time: "2026-01-01", duration_minutes: 60 }, // over cap
      { name: "x", start_time: "2026-01-01", duration_minutes: 60, mode: "bogus" }, // bad enum
      { name: "x", start_time: "2026-01-01", duration_minutes: 60, tags: [1] },     // non-string tag elem
      { start_time: "2026-01-01", duration_minutes: 60 },                 // missing required name
    ];
    for (const b of bad) {
      const r = validateBody(b, S);
      expect(r.error, `should reject: ${JSON.stringify(b).slice(0, 60)}`).toBeTruthy();
    }
    // edit (allOptional): partial body OK; whitespace name still rejected.
    expect(validateBody({ duration_minutes: 90 }, allOptional(S)).values).toEqual({ duration_minutes: 90 });
    expect(validateBody({ name: "  " }, allOptional(S)).error).toBeTruthy();
    // a non-object body is rejected, not crashed-on.
    expect(validateBody(null, S).error).toBeTruthy();
    expect(validateBody(["x"], S).error).toBeTruthy();

    // ── ext-audit F3: int is STRICT — no silent parseInt truncation ──────────
    const IS = { n: { type: "int", required: true, min: 1, max: 1000, label: "N" } };
    for (const ok of [["120", 120], [120, 120], ["  7  ", 7], [1000, 1000]]) {
      const r = validateBody({ n: ok[0] }, IS);
      expect(r.error, `int should accept ${JSON.stringify(ok[0])}`).toBeUndefined();
      expect(r.values.n).toBe(ok[1]);
    }
    for (const trunc of ["10abc", "1.9", "1e2", "0x10", 1.9, "", "  ", [180], {}, true, "1,000"]) {
      expect(validateBody({ n: trunc }, IS).error, `int must REJECT ${JSON.stringify(trunc)} (no truncation)`).toBeTruthy();
    }

    // ── ext-audit F2: bool is REAL coercion — the string "false" can't enable ─
    const BS = { flag: { type: "bool", label: "Flag" } };
    for (const t of [true, 1, "true", "1", "yes", "on", "TRUE", " True "]) {
      const r = validateBody({ flag: t }, BS);
      expect(r.error, `bool true-form ${JSON.stringify(t)}`).toBeUndefined();
      expect(r.values.flag, `${JSON.stringify(t)} → true`).toBe(true);
    }
    for (const f of [false, 0, "false", "0", "no", "off", "FALSE", " False "]) {
      const r = validateBody({ flag: f }, BS);
      expect(r.error, `bool false-form ${JSON.stringify(f)}`).toBeUndefined();
      expect(r.values.flag, `${JSON.stringify(f)} → false (NOT enabled)`).toBe(false);
    }
    for (const amb of ["maybe", "2", 2, "yepp", {}, [true]]) {
      expect(validateBody({ flag: amb }, BS).error, `bool must REJECT ambiguous ${JSON.stringify(amb)}`).toBeTruthy();
    }
  });

  test("ext-audit F4: every package.json allowScripts entry matches the package-lock resolved version", () => {
    // Supply-chain control completeness. allowScripts is `name@version: true`; if a
    // dep is bumped (esbuild 0.28.0 → 0.28.1) but the allowlist entry isn't, that
    // package's install script is no longer covered and the prod Docker build warns
    // — a silent gap. This locks the two in sync so the NEXT bump that forgets the
    // allowlist fails HERE (the cycle-ender, not another hand-fix).
    const fs = require("fs");
    const path = require("path");
    const root = path.resolve(__dirname, "..");
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    const allow = pkg.allowScripts || {};
    expect(Object.keys(allow).length, "allowScripts should not be empty (native deps need build scripts)").toBeGreaterThan(0);
    const mismatches = [];
    for (const key of Object.keys(allow)) {
      const at = key.lastIndexOf("@"); // robust for scoped @scope/pkg@1.2.3
      const name = key.slice(0, at), ver = key.slice(at + 1);
      const locked = lock.packages?.[`node_modules/${name}`]?.version;
      if (!locked) { mismatches.push(`${key}: package "${name}" not found in package-lock`); continue; }
      if (locked !== ver) mismatches.push(`${key}: allowlist pins ${ver} but package-lock resolved ${locked}`);
    }
    expect(mismatches, `allowScripts entries out of sync with package-lock:\n  ${mismatches.join("\n  ")}`).toEqual([]);
  });

  test("v8.3.36: the admin email change is STAGED — this route commits no primary address", () => {
    // RE-POINTED from "ext-audit F1: the admin email-change SMTP rollback is a
    // CONDITIONAL revert". That scanner guarded a compensating UPDATE against
    // clobbering a concurrent admin's provisional state during the SMTP await.
    // v8.3.36 deleted the whole mechanism by never committing anything to
    // compensate for — so the guard's SUBJECT is now the stronger property that
    // makes the concurrency question moot: the handler writes no primary
    // address at all, and the pending slot is written atomically with a FRESH
    // code.
    const fs = require("fs");
    const path = require("path");
    const part = fs.readFileSync(path.resolve(__dirname, "..", "routes/participants.js"), "utf8");
    const code = part.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

    // 1. THE INVARIANT. Nothing in this route may write `users.email`. Comments
    //    are stripped first — this file's own paragraphs quote the statement the
    //    scanner forbids, which is the v7.21.13 trap.
    expect(code, "an admin primary-email change is staged, never committed here")
      .not.toMatch(/UPDATE users SET[^"'`]*\bemail=\?/);

    // 2. …and the main profile UPDATE must not have quietly re-acquired it.
    const mainUpdate = (code.match(/UPDATE users SET first_name=\?[^`]*/) || [""])[0];
    expect(mainUpdate, "the profile UPDATE must not carry `email`").toBeTruthy();
    expect(/(^|,)\s*email=\?/.test(mainUpdate), "…and it does not").toBe(false);

    // 3. THE STAGE ITSELF: all three columns together. Writing `pending_email`
    //    while leaving a stale `pending_email_code` in place would let a
    //    participant's older link resolve and commit the ADMIN's address under a
    //    mail describing a different one — /confirm-email resolves BY the code.
    expect(code, "the pending triple is written atomically")
      .toMatch(/UPDATE users SET pending_email=\?, pending_email_code=\?, pending_email_code_at=\? WHERE id=\?/);
    expect(code, "with a freshly minted code, not a reused one")
      .toMatch(/_adminPendingCode\s*=\s*adminEmailChanged\s*\?\s*uuid\(\)/);

    // 4. The retired machinery must not come back: it is what created the
    //    window (a provisional `verified=0` two durable readers acted on).
    for (const gone of ["revertTxn", "_adminVerifyCode", "email_change_reverted"]) {
      expect(code.includes(gone), `${gone} belongs to the retired rollback contract`).toBe(false);
    }
    expect(code, "and `verified` is no longer cleared by an admin edit")
      .not.toMatch(/UPDATE users SET verified=0, verify_code=\?/);
  });

  test("ext-audit F3: overlayDismiss returns an idempotent cleanup the shared modal runs on close", () => {
    // #modal-overlay is persistent (toggled via .open, never DOM-removed), so the
    // DOM-removal MutationObserver never fires for it — the Esc-stack entry + the
    // capturing focus-trap keydown listener would leak on every open without an
    // explicit cleanup. Lock the return + the two finish() call sites.
    const fs = require("fs");
    const path = require("path");
    const mod = fs.readFileSync(path.resolve(__dirname, "..", "public/js/ui/modal.js"), "utf8");
    expect(mod, "overlayDismiss must capture installOverlayFocusTrap's removeTrap")
      .toMatch(/removeTrap\s*=\s*installOverlayFocusTrap\(overlay\)/);
    expect(mod, "overlayDismiss must return its cleanup").toMatch(/return cleanup;/);
    // showModal + _countdownConfirm both capture the returned cleanup and run it.
    const captures = (mod.match(/cleanup\s*=\s*overlayDismiss\(overlay/g) || []).length;
    expect(captures, "both showModal and _countdownConfirm must capture cleanup").toBeGreaterThanOrEqual(2);
    expect(mod, "finish() must invoke cleanup()").toMatch(/cleanup\(\)/);
  });

  test("ext-audit F5: the attachment-insert txn re-checks task.locked INSIDE the transaction", () => {
    // The pre-txn lock check is a TOCTOU window — a superadmin could lock the task
    // between the gate and the INSERT. The insertTxn re-reads `locked` and rejects
    // (the reject:403 path also unlinks the staged temp file).
    const fs = require("fs");
    const path = require("path");
    const chal = fs.readFileSync(path.resolve(__dirname, "..", "routes/challenges.js"), "utf8");
    expect(chal, "insertTxn must re-read the lock state inside the txn")
      .toMatch(/insertTxn\s*=\s*db\.transaction\([\s\S]*?SELECT locked FROM tasks WHERE id=\?[\s\S]*?fresh && fresh\.locked[\s\S]*?reject:\s*403/);
  });

  test("ext-audit F7: PUT /api/me validates the nickname ONLY when it changes", () => {
    // Validating an UNCHANGED nickname bricked legacy users whose handle predates
    // the printable-ASCII rule from saving any other field. The charset/length/
    // uniqueness checks must sit behind `if (newNick !== user.nickname)`.
    const fs = require("fs");
    const path = require("path");
    const part = fs.readFileSync(path.resolve(__dirname, "..", "routes/participant.js"), "utf8");
    expect(part, "nickname checks must be gated on a real change")
      .toMatch(/if \(newNick !== user\.nickname\) \{[\s\S]*?_nicknameCharsOk\(newNick\)[\s\S]*?COLLATE NOCASE/);
  });

  test("leaderboard share-CTA is not rebuilt while a modal is open (badge-share focus-return a11y)", () => {
    // The 15s leaderboard poll rebuilds #lb-badge-cta; doing so while the
    // badge-share modal is open detaches the Share button that showModal captured
    // as its focus-return target, so on close focus lands at the document top.
    // The rebuild must be guarded on the modal-open + already-shown state.
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "public/js/features/leaderboard.js"), "utf8");
    expect(src, "CTA rebuild not guarded against an open modal-overlay").toMatch(/modal-overlay'\)\?\.classList\.contains\('open'\)/);
    expect(src, "CTA rebuild guard missing the _modalOpen && _alreadyShown condition").toMatch(/_modalOpen\s*&&\s*_alreadyShown/);
  });

  test("v6.10.72: public SVG assets must not embed <style> elements (CSP style-src-elem)", () => {
    // Regression lock for the v6.10.72 auditor finding: the Adobe
    // Illustrator-exported logo SVGs shipped with an inline style block
    // referencing a class-based fill, which triggered a style-src-elem
    // CSP violation on every page load (the CSP allows style="..."
    // attributes via style-src-attr 'unsafe-inline' but not inline
    // style elements). v6.10.72 replaced the class-based fill with
    // inline fill="#..." attributes on each path. If anyone re-exports
    // the logo from Illustrator and forgets to strip the style block,
    // this test catches it before CI green-lights the CSP-noisy asset.
    const fs = require("fs");
    const path = require("path");
    const PUB = path.resolve(__dirname, "..", "public");
    const svgs = fs.readdirSync(PUB).filter(n => n.endsWith(".svg")).map(n => path.join(PUB, n));
    expect(svgs.length).toBeGreaterThan(0);
    for (const f of svgs) {
      // Strip HTML/XML comments before matching so the v6.10.72 note
      // in each SVG header (which mentions the removed tag in prose
      // for historical context) doesn't trip the guard.
      const body = fs.readFileSync(f, "utf8").replace(/<!--[\s\S]*?-->/g, "");
      expect(body, `${f} contains an inline style element — CSP style-src-elem will block it`)
        .not.toMatch(/<style\b/i);
    }
  });

  test("v6.10.9: modal action rows put Cancel before primary buttons (public/*.html)", () => {
    // Button-order invariant. Every form-actions / modal-actions /
    // task-form-actions row in the static HTML shell must render
    // Cancel (or Close) as the first button — the convention matches
    // showModal's `#modal-box .modal-actions` DOM order (cancel-btn
    // before confirm-btn) + the dynamically-built overlays in
    // app.js. Pre-v6.10.9 the admin task form had Cancel at the
    // RIGHT of "Save as Draft / Save & Publish / Save Challenge" —
    // the odd one out.
    const fs = require("fs");
    const path = require("path");
    const html = fs.readFileSync(path.resolve(__dirname, "..", "public", "index.html"), "utf8");
    // For every action-row container, the first <button> must be
    // a secondary Cancel / Close. Action-row selector: `.task-form-actions`,
    // `.modal-actions`, `.profile-actions`, `.admin-profile-actions`. All are
    // in the static shell.
    const ROW_MARKERS = [
      "task-form-actions", "modal-actions", "profile-actions",
      "admin-profile-actions",
    ];
    for (const marker of ROW_MARKERS) {
      const re = new RegExp(`class="[^"]*\\b${marker}\\b[^"]*"[^>]*>([\\s\\S]*?)</div>`, "g");
      let m;
      while ((m = re.exec(html))) {
        const inner = m[1];
        // Extract the first button tag in this row.
        const btnMatch = inner.match(/<button\b[^>]*>([\s\S]*?)<\/button>/);
        if (!btnMatch) continue; // Row has no buttons — skip.
        const firstBtn = btnMatch[0];
        const firstBtnText = btnMatch[1].replace(/<[^>]+>/g, "").trim();
        // The first button qualifies as the cancel/close slot if:
        //   (a) its text literally starts with Cancel/Close/Back, OR
        //   (b) it is empty-bodied AND carries `btn secondary` class
        //       (the #modal-cancel-btn pattern — JS fills the text at
        //        runtime; static markup only wires the secondary style).
        const textOK = /^(cancel|close|back)\b/i.test(firstBtnText);
        const emptySecondary = firstBtnText === "" && /\bclass="[^"]*\bbtn\b[^"]*\bsecondary\b/.test(firstBtn);
        expect(
          textOK || emptySecondary,
          `.${marker} first button should be Cancel / Close / Back or an empty btn-secondary (found "${firstBtnText}"): ${firstBtn}`,
        ).toBe(true);
      }
    }
  });

  test("v6.16.1: ICO icon refs in HTML strings must use template literals (backticks), not single quotes", () => {
    // v6.16.1 — pre-fix the buildSolutionHtml() helper at app.js:2545
    // built the "Solution" header inside SINGLE quotes:
    //   html += '<h3 …>${ICO.solution} Solution</h3>';
    // Single quotes don't interpolate, so the literal text
    // "${ICO.solution} Solution" rendered in the DOM. Backticks +
    // ${...} would have done the right thing. This static scan
    // catches the same bug class anywhere it might recur — a line
    // containing `${ICO.<name>}` MUST be wrapped in backticks (or
    // appear inside a comment).
    const fs = require("fs");
    const path = require("path");
    const appJs = (() => { const _d = path.join(__dirname, "..", "public", "js"); const _o = []; (function _w(p){ for (const e of fs.readdirSync(p, { withFileTypes: true })) { const _f = path.join(p, e.name); if (e.isDirectory()) _w(_f); else if (e.name.endsWith(".js")) _o.push(fs.readFileSync(_f, "utf8")); } })(_d); return _o.join("\n"); })();
    const offenders = [];
    appJs.split("\n").forEach((line, i) => {
      // Skip pure-comment lines (// …) and JSDoc-ish lines (* …)
      // — referencing ${ICO.foo} in a comment is fine; the reader
      // is supposed to read it literally.
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
      // Look for `${ICO.<name>}` placeholders. If one is found AND
      // the surrounding character class indicates a non-template-
      // literal context (the chunk is wrapped in single quotes
      // not backticks), flag it.
      // The strict signal: the entire single-quoted string
      // containing the placeholder. Regex: '...${ICO.X}...' on the
      // same line, with no backtick on either side.
      const m = line.match(/'[^'`]*\$\{ICO\.[a-zA-Z]+\}[^'`]*'/);
      if (m) offenders.push({ line: i + 1, snippet: line.trim() });
    });
    expect(
      offenders,
      `${offenders.length} line(s) in public/app.js wrap \${ICO.<name>} in single quotes (won't interpolate). Use backticks:\n` +
        offenders.map(o => `  app.js:${o.line}  ${o.snippet}`).join("\n")
    ).toEqual([]);
  });

  test("v6.10.9: every focusable interactive element has :focus-visible styling", () => {
    // Design-system § 9 Accessibility rule #2: "Every interactive
    // control has :focus-visible outline". This is a drift check —
    // if someone adds a new custom role=button / tabindex=0 target
    // in app.js without a matching :focus-visible rule in styles.css,
    // this test fails loudly.
    const fs = require("fs");
    const path = require("path");
    const appJs = (() => { const _d = path.join(__dirname, "..", "public", "js"); const _o = []; (function _w(p){ for (const e of fs.readdirSync(p, { withFileTypes: true })) { const _f = path.join(p, e.name); if (e.isDirectory()) _w(_f); else if (e.name.endsWith(".js")) _o.push(fs.readFileSync(_f, "utf8")); } })(_d); return _o.join("\n"); })();
    const css = fs.readFileSync(path.resolve(__dirname, "..", "public", "styles.css"), "utf8");
    // Find class names used with tabindex=0 AND role=button (or
    // just tabindex=0 alone — anything keyboard-focusable). The
    // heuristic: scan for `<div class="<CLS>..."...tabindex="0"` /
    // similar and extract CLS. The focus-visible rule then must
    // exist for either `.CLS` or a generic element rule that
    // covers it.
    const selectors = new Set();
    // tabindex=0 on ANY element with a class. v6.20.x — was <div only, which
    // silently skipped <span>/<li>-based focusables (e.g. the group-pick chips).
    const reDivTabindex = /<\w+[^>]*\bclass="([^"]+)"[^>]*tabindex="0"/g;
    let m;
    while ((m = reDivTabindex.exec(appJs))) {
      const cls = m[1].trim().split(/\s+/)[0].replace(/\$\{.*\}/g, "");
      if (cls && !cls.includes("$")) selectors.add(cls);
    }
    // Also match class-first ordering.
    const reDivTabindex2 = /<\w+[^>]*\btabindex="0"[^>]*\bclass="([^"]+)"/g;
    while ((m = reDivTabindex2.exec(appJs))) {
      const cls = m[1].trim().split(/\s+/)[0].replace(/\$\{.*\}/g, "");
      if (cls && !cls.includes("$")) selectors.add(cls);
    }
    // Every discovered class must have a :focus-visible rule in
    // styles.css. The rule may be on the exact class or on a
    // descendant selector like `#page .CLS:focus-visible`.
    const missing = [];
    for (const cls of selectors) {
      const hit = new RegExp(`\\.${cls}[^{,]*?:focus-visible`).test(css);
      if (!hit) missing.push(cls);
    }
    expect(
      missing,
      `Classes used with tabindex=0 but no :focus-visible rule in styles.css:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  test("v6.10.26: client-side invite-dialog email validation mirrors server isValidEmailFormat", () => {
    // Locks in the invite dialog's tightened regex (v6.10.26). Pre-fix
    // the dialog accepted anything containing '@' and let the server's
    // isValidEmailFormat 400 malformed rows after a network round-trip.
    // Now both sides share `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`; changing one
    // without the other would desync again.
    const fs = require("fs");
    const path = require("path");
    const appBody = (() => { const _d = path.join(__dirname, "..", "public", "js"); const _o = []; (function _w(p){ for (const e of fs.readdirSync(p, { withFileTypes: true })) { const _f = path.join(p, e.name); if (e.isDirectory()) _w(_f); else if (e.name.endsWith(".js")) _o.push(fs.readFileSync(_f, "utf8")); } })(_d); return _o.join("\n"); })();
    // v7.0.0 — the server-side email validation (isValidEmailFormat + _EMAIL_RE)
    // moved out of server.js into lib/util.js during the route-split refactor.
    const serverBody = fs.readFileSync(path.resolve(__dirname, "..", "lib", "util.js"), "utf8");
    // The regex literal must be string-equal in client + server. v7.15.6 —
    // EXTRACT the server's literal and require the client to carry that exact
    // string, instead of hard-coding the pattern here: the old form pinned a
    // specific regex, so tightening it (ext-audit: mailbox syntax) failed this
    // test for the wrong reason and invited someone to "fix" it by pasting the
    // new literal, which would go stale again on the next change.
    const serverLit = /const _EMAIL_RE = (\/.*\/);/.exec(serverBody);
    expect(serverLit, "server (lib/util) must define _EMAIL_RE as a regex literal").toBeTruthy();
    expect(appBody, "client must ship the IDENTICAL _EMAIL_RE literal").toContain(serverLit[1]);
    // …and it must actually behave, so a future "simplification" that keeps the
    // two sides in sync but re-opens the bypass still fails here.
    const emailRe = eval(serverLit[1]); // eslint-disable-line no-eval — a literal we just matched
    expect(emailRe.test("alice@acme.com"), "ordinary address accepted").toBe(true);
    expect(emailRe.test("first.last+tag@sub.example.co.uk"), "subdomain + tag accepted").toBe(true);
    expect(emailRe.test("Alias<audit-bypass@gmail.com>"), "ext-audit: mailbox syntax rejected").toBe(false);
    expect(emailRe.test("x@gmail.com>"), "trailing bracket in domain rejected").toBe(false);
    expect(emailRe.test("a,b@x.com"), "comma (group syntax) rejected").toBe(false);
    // Client must ship `isValidEmailFormat` with the trim + length + regex triad.
    const clientFn = appBody.match(/function isValidEmailFormat\([\s\S]*?\n\}/);
    expect(clientFn, "client isValidEmailFormat function must exist").toBeTruthy();
    expect(clientFn[0]).toMatch(/trim\(\)/);
    expect(clientFn[0]).toMatch(/>\s*254/);
    expect(clientFn[0]).toMatch(/_EMAIL_RE/);
    // ext-audit (F1) — both sides ALSO enforce printable-ASCII-only emails (the
    // email NOCASE uniqueness indexes case-fold ASCII only, so a non-ASCII address
    // could bypass case-insensitive uniqueness). The ASCII guard (\x7E signature)
    // must appear INSIDE isValidEmailFormat on BOTH sides — not merely elsewhere
    // in the file (the nickname regex also uses \x20-\x7E), so we scope to the fn.
    expect(clientFn[0], "client isValidEmailFormat must enforce ASCII").toMatch(/\\x7E/);
    const serverFn = serverBody.match(/function isValidEmailFormat\([\s\S]*?\n\}/);
    expect(serverFn, "server isValidEmailFormat function must exist").toBeTruthy();
    expect(serverFn[0], "server isValidEmailFormat must enforce ASCII").toMatch(/\\x7E/);
  });

  test("v7.0.2: client admin-logs loader anchors pages 2+ by head timestamp", () => {
    // Source-level invariant for the page-1 reset fix. The client log loader
    // (`loadAdminLogs` in public/js/features/settings-admin.js) must (a) echo
    // the pinned head timestamp via `anchor=<ts>` when on page 2+, (b) NOT
    // carry the removed snapshot-changed reset-to-page-1 path (that fired on
    // every append — the bug), and (c) clear the anchor on every query-context
    // reset (stream switch, page-size change, search change, open-tab, First
    // page) so the next page-1 load re-pins from the live head.
    //
    // Testing via the UI path is flaky under parallel workers (request-listener
    // timing under load) — the source grep here is deterministic. The
    // server-side contract is covered by the sibling test "admin logs paginate
    // stably under concurrent growth via a timestamp anchor (v7.0.2)".
    const fs = require("fs");
    const path = require("path");
    const raw = (() => { const _d = path.join(__dirname, "..", "public", "js"); const _o = []; (function _w(p){ for (const e of fs.readdirSync(p, { withFileTypes: true })) { const _f = path.join(p, e.name); if (e.isDirectory()) _w(_f); else if (e.name.endsWith(".js")) _o.push(fs.readFileSync(_f, "utf8")); } })(_d); return _o.join("\n"); })();
    // Strip comments before scanning so explanatory prose (which still names
    // the removed snapshot mechanism) doesn't trip the checks. The ESM split
    // routes these globals through the S state object (`S._logsPage`); strip
    // the `S.` prefix so the shape-regexes match `_logsAnchorTs&&_logsPage>1`.
    const body = raw
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map(l => l.replace(/\/\/.*$/, ""))
      .join("\n")
      .replace(/\bS\./g, "");
    // (a) loadAdminLogs takes its page's position (page 1: none; later pages:
    //     the anchor pinned from page 1 plus an offset, or a cursor Next was
    //     answered with) from the shared segment pager, and no code hand-sets an
    //     `anchor` param any more (the operator ruling of 17 Nov 2026 moved Raw
    //     logs onto the audit trail's pager, ui/list-controls.js).
    expect(body).toMatch(/export async function loadAdminLogs[\s\S]{0,900}segmentParams\(st,pageN\)/);
    expect(body).toMatch(/export async function loadAdminLogs[\s\S]{0,700}const st=_logsPager;/);
    expect(body).not.toMatch(/searchParams\.set\(\s*'anchor'/);
    // (b) the snapshot_changed reset-to-page-1 path is gone — it forced page 1
    //     on every append, which is the bug being fixed. The old state slot
    //     names must not survive in live code either.
    expect(body).not.toMatch(/snapshot_changed/);
    expect(body).not.toMatch(/_logsSnapshotId/);
    expect(body).not.toMatch(/\b_logsPage\b|_logsAnchorTs|_logsPageSize/);
    // (c) every return to page 1 goes through ONE reset, which drops the anchor
    //     and every position, so the next page-1 load re-pins from the live head.
    const fp = body.match(/export function _logsFirstPage\(\)\{([\s\S]*?)\n\}/);
    expect(fp, "the one page-1 reset exists").toBeTruthy();
    expect(fp[1]).toMatch(/segments\s*=\s*\[\]/);
    expect(fp[1]).toMatch(/anchor\s*=\s*null/);
    expect(fp[1]).toMatch(/nextCursor\s*=\s*null/);
    const outside = body.replace(fp[0], "");
    expect(outside, "a page-1 reset outside _logsFirstPage").not.toMatch(/_logsPager\.page\s*=\s*1\b|\bst\.page\s*=\s*1\b/);
    expect(outside, "a positions reset outside _logsFirstPage").not.toMatch(/_logsPager\.segments\s*=/);
    expect((outside.match(/_logsFirstPage\(/g) || []).length, "anti-vacuity: the resets call it").toBeGreaterThanOrEqual(5);
  });
  test("v6.10.7: shipped shadow tiers match DESIGN_SYSTEM.md", () => {
    // Reconciliation lock. DESIGN_SYSTEM.md § 5 documents the three
    // shadow tiers + back-compat `--shadow` alias. This test fails
    // if any of the shipped token values drift from the documented
    // ones so the doc stays useful to the ui-polisher agent.
    const fs = require("fs");
    const path = require("path");
    const css = fs.readFileSync(path.resolve(__dirname, "..", "public", "styles.css"), "utf8");
    // THE LOOKS. styles.css generates the tiers per look and mode as
    // --sh-1/2/3 (DESIGN_SYSTEM.md, "Shadows"), tinted by the look's shadow
    // colour, and the legacy --shadow-1/2/3 and --shadow are aliases of them, so a
    // site reaching for any of the old names gets the look's value.
    const ds = fs.readFileSync(path.resolve(__dirname, "..", ".claude", "DESIGN_SYSTEM.md"), "utf8");
    for (const [legacy, now] of [["--shadow-1", "--sh-1"], ["--shadow-2", "--sh-2"], ["--shadow-3", "--sh-3"], ["--shadow", "--sh-1"]]) {
      expect(css, `${legacy} is the alias of ${now}`).toContain(`${legacy}:var(${now})`);
      expect(ds, `DESIGN_SYSTEM.md documents ${legacy} as ${now}`).toContain(`\`${legacy}\` → \`${now}\``);
    }
    // Every look's light and dark block defines all three tiers: one block per
    // look and mode, so the floor follows the look data.
    const { looks } = require("../scripts/theme/looks");
    const blocks = [...css.matchAll(/\{([^{}]*--sh-1:[^{}]*)\}/g)].map(m => m[1]);
    expect(blocks.length, "anti-vacuity: one shadow set per look and mode").toBeGreaterThanOrEqual(Object.keys(looks).length * 2);
    for (const b of blocks) for (const t of ["--sh-1:", "--sh-2:", "--sh-3:"]) expect(b).toContain(t);

    // v7.23.10 — THE STANDALONE SHELLS TOO. This lock read styles.css alone, so
    // the four sheets that redeclare these tokens for the pages reached from an
    // email were never reconciled against the spec they follow — and
    // verify-pages.css had drifted its dark tier-1 to
    // `0 1px 2px rgba(0,0,0,0.18)` while both its siblings carried the correct
    // value. A doc is only useful if everything that claims to follow it is
    // checked against it.
    //
    // Only tier 1 and tier 2 are asserted, deliberately: those are what these
    // sheets redeclare, and demanding the full ladder would flag sheets for not
    // defining tiers they never use.
    //
    // BOTH MODES. A sheet writes its default mode in a bare block (`:root`) and
    // the other mode in a block that names it: `html[data-theme="light"]` in
    // verify-pages.css, `@media (prefers-color-scheme:dark)` in unsubscribe.css.
    // Reading only "the first block" took unsubscribe.css's DAY value for its
    // night one, and checked no day value anywhere, which is how that sheet drew
    // a third tier-1 shadow, the same in both modes. So each mode's value is
    // resolved the way the cascade does it (the named block's, else the bare
    // one's), and a tier declared for one mode only paints that value in the
    // other mode too, which no single value can satisfy.
    const TIERS = {
      dark: { "--shadow-1": "0 1px 3px rgba(0,0,0,0.12)", "--shadow-2": "0 4px 12px rgba(0,0,0,0.24),0 1px 2px rgba(0,0,0,0.18)" },
      light: { "--shadow-1": "0 1px 2px rgba(15,13,26,0.06)", "--shadow-2": "0 4px 12px rgba(15,13,26,0.08),0 1px 2px rgba(15,13,26,0.06)" },
    };
    const modeNamed = (ctx) => (/data-theme="light"|prefers-color-scheme\s*:\s*light/.test(ctx) ? "light"
      : /data-theme="dark"|prefers-color-scheme\s*:\s*dark/.test(ctx) ? "dark" : null);
    // Each tier declaration, with the mode its block (selector and enclosing
    // @media preludes) names, or null for a bare block.
    const tierDecls = (css) => {
      const out = [], stack = [];
      let buf = "";
      for (const ch of css) {
        if (ch === "{") { stack.push(buf.trim()); buf = ""; continue; }
        if (ch === "}") {
          for (const m of buf.matchAll(/(--shadow-[12])\s*:\s*([^;]+)/g)) out.push({ tok: m[1], val: m[2].trim(), named: modeNamed(stack.join(" ")) });
          stack.pop(); buf = ""; continue;
        }
        buf += ch;
      }
      return out;
    };
    const valueIn = (decls, tok, mode) => {
      const pick = (named) => decls.filter(d => d.tok === tok && d.named === named).map(d => d.val).pop();
      return pick(mode) ?? pick(null) ?? null;
    };
    // Normalise BOTH sides: the sheets space these values differently from the
    // doc, and comparing a stripped actual against an unstripped expected
    // flagged two sheets that carry exactly the right value.
    const norm = v => String(v).replace(/\s+/g, "");
    const shells = fs.readdirSync(path.resolve(__dirname, "..", "public"))
      .filter(f => f.endsWith(".css") && !["fonts.css", "styles.css"].includes(f))
      .map(f => [f, fs.readFileSync(path.resolve(__dirname, "..", "public", f), "utf8")]);
    // The maintenance page's own <style> block (server.js _MAINTENANCE_HTML,
    // self-contained under its own CSP) rests its card on the same tier 1.
    const serverSrc = fs.readFileSync(path.resolve(__dirname, "..", "server.js"), "utf8");
    const mAt = serverSrc.indexOf("const _MAINTENANCE_HTML = `");
    const mStyle = mAt < 0 ? null : /<style>([\s\S]*?)<\/style>/.exec(serverSrc.slice(mAt, serverSrc.indexOf("`;", mAt)));
    expect(mStyle, "PRECONDITION: the maintenance page's <style> block was found").not.toBeNull();
    shells.push(["server.js _MAINTENANCE_HTML", mStyle[1]]);
    const drifted = [];
    let sheetsWithTiers = 0;
    for (const [f, raw] of shells) {
      const body = raw.replace(/\/\*[\s\S]*?\*\//g, " ");
      const decls = tierDecls(body);
      if (decls.length) sheetsWithTiers++;
      for (const tok of new Set(decls.map(d => d.tok))) {
        for (const mode of ["light", "dark"]) {
          const got = valueIn(decls, tok, mode), want = TIERS[mode][tok];
          if (got === null) drifted.push(`${f}: ${tok} has no ${mode} value (declared for the other mode only)`);
          else if (norm(got) !== norm(want)) drifted.push(`${f}: ${tok} in ${mode} is ${got}, DESIGN_SYSTEM says ${want}`);
        }
      }
    }
    // Anti-vacuity: both shells declare their tier tokens (and the parser read them).
    expect(sheetsWithTiers, "anti-vacuity: the standalone shells' and the maintenance page's tier declarations were read").toBeGreaterThanOrEqual(3);
    expect(drifted, `standalone shells drifted from the documented shadow tiers:\n  ${drifted.join("\n  ")}`)
      .toEqual([]);
  });

  test("v6.10.6: icons must be inline SVG, not emoji/dingbats (public/app.js + public/*.html)", () => {
    // Regression lock for the v6.10.1 → v6.10.6 sweep. The SPA
    // standardised on Feather-style inline SVGs (via the ICO
    // registry) because emoji glyphs render inconsistently across
    // operating systems — a participant on Windows sees a different
    // 🔴 than an admin on macOS, and ❌ is a completely different
    // red-X on Android vs. iOS. All icon roles must therefore go
    // through inline <svg>, never the emoji glyph itself.
    //
    // Scope: code regions only. Comments may reference the legacy
    // emoji (and do — see the ICO registry docstring + v6.10.x CLAUDE.md
    // notes) without tripping this guard.
    const fs = require("fs");
    const path = require("path");
    // Emoji that were in the sweep. These are the ones that had
    // semantic UI meaning; don't bother with decorative emoji in
    // toast messages or prose copy.
    const FORBIDDEN = ["🔒","🔴","🟢","💡","📎","📋","🏆","🔗","⏳","⏰","✅","❌","⚠️","⚠","✨","✓","✗","⟳","📧","📩","✉️","👁️","👁","👀","📝","🛠","⚙","⚙️","🥇","🥈","🥉","⏱","⏸","⌛"];
    const JS_DIR = path.resolve(__dirname, "..", "public", "js");
    const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
    const walkJs = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
      const f = path.join(d, e.name);
      return e.isDirectory() ? walkJs(f) : (e.name.endsWith(".js") ? [f] : []);
    });
    const SERVER_JS = path.resolve(__dirname, "..", "server.js");
    // Strip JS block + line comments so comment references don't
    // count. Rough but good enough for this codebase (no regex
    // literals containing `//` or emoji).
    function stripJsComments(src) {
      return src
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .split("\n")
        .map(l => l.replace(/\/\/.*$/, ""))
        .join("\n");
    }
    function stripHtmlComments(src) {
      return src.replace(/<!--[\s\S]*?-->/g, " ");
    }
    const offenders = [];
    // v7.0.0: the SPA is split into public/js/** ES modules — scan each.
    for (const jsFile of walkJs(JS_DIR)) {
      const rel = path.relative(PUBLIC_DIR, jsFile);
      const body = stripJsComments(fs.readFileSync(jsFile, "utf8"));
      for (const emo of FORBIDDEN) {
        const idx = body.indexOf(emo);
        if (idx >= 0) {
          const line = body.slice(0, idx).split("\n").length;
          offenders.push(`public/${rel}:${line} contains ${emo}`);
        }
      }
    }
    // server.js: inline HTML templates for /verify, maintenance
    // page, emails. Comments and log messages may legitimately use
    // emoji; the sweep targets HTML template strings only. As a
    // conservative proxy, strip comments and look for any forbidden
    // char — the current server.js has no non-HTML emoji.
    const serverJs = stripJsComments(fs.readFileSync(SERVER_JS, "utf8"));
    for (const emo of FORBIDDEN) {
      const idx = serverJs.indexOf(emo);
      if (idx >= 0) {
        const line = serverJs.slice(0, idx).split("\n").length;
        offenders.push(`server.js:${line} contains ${emo}`);
      }
    }
    // Sweep public/*.html (NOT deep — we don't want to touch /uploads
    // or other non-SPA static assets).
    for (const entry of fs.readdirSync(PUBLIC_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
      const body = stripHtmlComments(fs.readFileSync(path.join(PUBLIC_DIR, entry.name), "utf8"));
      for (const emo of FORBIDDEN) {
        const idx = body.indexOf(emo);
        if (idx >= 0) {
          const line = body.slice(0, idx).split("\n").length;
          offenders.push(`public/${entry.name}:${line} contains ${emo}`);
        }
      }
    }
    expect(
      offenders,
      `Emoji-as-icon usage found — use the ICO registry (Feather-style SVG) instead:\n  ${offenders.join("\n  ")}`,
    ).toHaveLength(0);
  });

  test("public/app.js routes all date formatting through fmtDt", () => {
    // v6.8.1 regression lock. fmtDt() is the canonical date/time formatter
    // for the SPA; every admin table, audit message, and participant
    // dialog is supposed to go through it so the three shapes
    // ('short' / 'long' / 'full') render consistently. A bare
    // `.toLocaleString()` on a Date produces locale-default output that
    // differs from the fmtDt-rendered neighbour in the same row. Catch
    // future drift here rather than eyeballing admin screenshots.
    const fs = require("fs");
    const path = require("path");
    const body = (() => { const _d = path.join(__dirname, "..", "public", "js"); const _o = []; (function _w(p){ for (const e of fs.readdirSync(p, { withFileTypes: true })) { const _f = path.join(p, e.name); if (e.isDirectory()) _w(_f); else if (e.name.endsWith(".js")) _o.push(fs.readFileSync(_f, "utf8")); } })(_d); return _o.join("\n"); })();
    // Flag any `X.toLocaleDateString(` at all — we have no legitimate
    // date-only use outside fmtDt.
    expect(body).not.toMatch(/\.toLocaleDateString\s*\(/);
    // For `.toLocaleString(`: skip those inside fmtDt itself (the single
    // internal call) and the one tz-offset probe (toLocaleString('en-US',
    // {timeZone..., timeZoneName:'shortOffset'})). Every other occurrence
    // on a Date is a drift.
    const lines = body.split("\n");
    const offenders = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/\.toLocaleString\s*\(/.test(line)) continue;
      // Allow: numeric formatting (e.g. `.toLocaleString()` on a number —
      // the analytics stat cards use it for thousands separators). These
      // calls use no arguments OR format a non-Date value; the heuristic
      // is "preceded by a closing paren, a number literal, or a
      // variable name that does not read like a date".
      if (/toLocaleString\(\)/.test(line) && !/new Date\b/.test(line)) continue;
      // Allow the tz-offset probe and the internal fmtDt implementation.
      if (/timeZoneName\s*:\s*['"]shortOffset['"]/.test(line)) continue;
      if (/return d\.toLocaleString\(undefined, fmtOpts\)/.test(line)) continue;
      offenders.push(`${i + 1}: ${line.trim()}`);
    }
    expect(offenders, `Raw date toLocaleString calls found in public/app.js:\n${offenders.join("\n")}\nRoute them through fmtDt(v, 'long' | 'full' | 'short').`).toHaveLength(0);
  });

  test("every light screenshot has a matching .dark.png twin", () => {
    // The help-drawer renders a <picture> for every PNG, with the dark
    // variant sourced from `{name}.dark.png`. If the twin is missing, the
    // browser still falls back to the light <img>, but users on dark mode
    // see the mismatched shot — so enforce the pairing at CI time.
    const fs = require("fs");
    const path = require("path");
    const SHOTS_DIR = path.resolve(__dirname, "..", "docs", "screenshots");
    function walk(dir, out = []) {
      if (!fs.existsSync(dir)) return out;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith(".png")) out.push(full);
      }
      return out;
    }
    const allPngs = walk(SHOTS_DIR);
    const lightShots = allPngs.filter(p => !p.endsWith(".dark.png"));
    expect(lightShots.length).toBeGreaterThan(0);
    for (const lightPath of lightShots) {
      const darkPath = lightPath.replace(/\.png$/i, ".dark.png");
      expect(
        fs.existsSync(darkPath),
        `Missing dark-theme twin for ${path.relative(SHOTS_DIR, lightPath)} — expected ${path.relative(SHOTS_DIR, darkPath)}. Re-run \`npm run docs:shots\` to regenerate both themes.`,
      ).toBe(true);
    }
  });

  test("v6.9.10: /register serves the SPA shell (same body as /, no-cache, HTML content-type)", async () => {
    // Dedicated SPA route added in v6.9.10 — both `/` and `/register`
    // map to the same rewritten index.html inside the HTML cache so
    // refresh / direct-link / invitation-email landings all resolve to
    // the same shell. The client-side bootstrap then branches on the
    // pathname to decide which page to show. Assertions:
    //   - 200 HTML (the route is wired)
    //   - Cache-Control: no-cache (matches the rest of the shell)
    //   - Body contains the register-page container so the client-side
    //     router has something to toggle visible
    //   - Body is byte-identical to what `/` returns (same cached HTML
    //     — v6.9.10's remap is purely a request-path rewrite)
    const { api } = await (async () => {
      const { request } = require("./isolated-test");
      const ctx = await request.newContext({ baseURL: require("./helpers").BASE });
      return { api: ctx };
    })();
    const r = await api.get("/register");
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"] || "").toMatch(/text\/html/i);
    expect(r.headers()["cache-control"] || "").toMatch(/no-cache/i);
    const body = await r.text();
    expect(body).toMatch(/id="register-page"/);
    // Same byte-for-byte body as `/` — prevents a future refactor from
    // accidentally serving a different file for /register (e.g. a
    // bare static copy without the content-hash rewrites).
    const rRoot = await api.get("/");
    expect(await rRoot.text()).toBe(body);
    await api.dispose();
  });

  test("/help.html serves HTML page (not markdown) and loads help.js + marked", async () => {
    // Regression lock for v6.2.x finding: the help drawer's ↗ icon used
    // to point at the raw /docs/<role>.md path (served by express.static
    // as text/plain with unresolved {{platformName}}). v6.2.4 rewires it
    // to /help.html?doc=..., a rendered HTML viewer. Verify the shell
    // exists, responds with HTML, and pulls the three pieces that make
    // the rendering work: styles.css, /vendor/marked.min.js, /help.js.
    const { api } = await apiLogin("superadmin");
    const r = await api.get("/help.html");
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"] || "").toMatch(/text\/html/i);
    const body = await r.text();
    expect(body).toMatch(/<html/i);
    expect(body).toMatch(/\/vendor\/marked\.min\.js/);
    expect(body).toMatch(/\/help-renderer\.js/);
    expect(body).toMatch(/\/help\.js/);
    expect(body).toMatch(/\/styles\.css/);
    expect(body).toMatch(/help-page-body/);
    // help.js delegates to the shared HelpRenderer (extracted in v6.2.6 so
    // drawer + page can't drift). It must still pull /api/config for the
    // platform-name substitution and call into the renderer module. Read the
    // RAW source from disk (not the served copy): under MINIFY_JS the served
    // bytes are esbuild-minified — comments stripped, locals renamed — which
    // is a serve-time transform, not a source invariant. These assertions pin
    // a SOURCE property, so they must read source.
    const fs = require("fs");
    const path = require("path");
    const helpJs = fs.readFileSync(path.join(__dirname, "..", "public", "help.js"), "utf8");
    expect(helpJs).toMatch(/\/api\/config/);
    expect(helpJs).toMatch(/\{\{platformName\}\}/);
    expect(helpJs).toMatch(/HelpRenderer/);
    // The shared renderer is the one that actually invokes marked.parse —
    // verify it loads and contains the rendering pipeline.
    const sharedR = await api.get("/help-renderer.js");
    expect(sharedR.status()).toBe(200);
    const sharedJs = await sharedR.text();
    expect(sharedJs).toMatch(/marked\.parse/);
    expect(sharedJs).toMatch(/window\.HelpRenderer/);
    await api.dispose();
  });

  test("help.js + app.js escape platform_name before substituting into markdown (v6.3.4)", async () => {
    // Regression for the SAST "untrusted data → innerHTML via setSafe"
    // flag on public/help.js:40. The primary data path is:
    //   admin PATCH /api/admin/settings platform_name
    //     → stored raw in settings table
    //     → GET /api/config returns it verbatim
    //     → help.js/app.js substitute it into the markdown body BEFORE
    //       marked.js runs
    //     → marked.js preserves inline HTML by default, so a malicious
    //       platform name reaches innerHTML as live markup
    // CSP + Trusted Types block actual script execution, but the
    // correct fix is to HTML-escape the value at the substitution sites.
    // This test pins the escape — the client JS must invoke esc()
    // on the platformName argument when doing the `.replace(...)` call.
    // Read the RAW source from disk, not the served copy: under MINIFY_JS the
    // served bytes are esbuild-minified, which renames the `esc` local — a
    // serve-time transform, not a source change. The escape-at-substitution
    // invariant this test pins is a SOURCE property, so it must read source.
    const fs = require("fs");
    const path = require("path");
    const helpJs = fs.readFileSync(path.join(__dirname, "..", "public", "help.js"), "utf8");
    // Two shapes accepted: `esc(platformName)` (current) or any other
    // explicit escape helper. The critical invariant is that the raw
    // variable is not passed unmodified as the second replace arg.
    // Note: the source regex-literal in the JS file uses `\{\{…\}\}`
    // (escaped braces), so the test pattern matches that textual form.
    expect(helpJs).toMatch(/\\\{\\\{platformName\\\}\\\}[^)]*?,\s*esc\s*\(/);
    const appJs = (() => { const _d = path.join(__dirname, "..", "public", "js"); const _o = []; (function _w(p){ for (const e of fs.readdirSync(p, { withFileTypes: true })) { const _f = path.join(p, e.name); if (e.isDirectory()) _w(_f); else if (e.name.endsWith(".js")) _o.push(fs.readFileSync(_f, "utf8")); } })(_d); return _o.join("\n"); })();
    expect(appJs).toMatch(/\\\{\\\{platformName\\\}\\\}[^)]*?,\s*esc\s*\(/);
  });

  test("docs relative links must not escape the docs/ tree — the app only serves /docs/*", () => {
    // Help drawer resolves `../foo` against the current doc's path. A
    // `[link](../foo.md)` inside `docs/user-guide/admin.md` correctly
    // resolves to `/docs/foo.md` (one level up → still under /docs/).
    // But `[link](../../README.md)` would resolve to `/README.md` (root)
    // which the Express static mount does NOT serve — producing a 404.
    // Same for any `../tests/…`, `../server.js`, etc.
    //
    // Rule: every relative markdown-link target must resolve to a path
    // that starts with `docs/`. This test walks the tree and resolves
    // each `](...)` link against its containing file, asserting the final
    // path is inside docs/.
    const fs = require("fs");
    const path = require("path");
    const DOCS_DIR = path.resolve(__dirname, "..", "docs");
    function walk(dir, out = []) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.name.endsWith(".md")) out.push(full);
      }
      return out;
    }
    // Capture the link target from standard markdown syntax `](target)`
    // — NOT external URLs (those start with a scheme), NOT inline anchors
    // (those start with `#`), NOT absolute app paths (those start with `/`).
    const LINK_RE = /\]\(([^)]+)\)/g;
    for (const f of walk(DOCS_DIR)) {
      const body = fs.readFileSync(f, "utf8");
      let m;
      while ((m = LINK_RE.exec(body)) !== null) {
        const href = m[1].split(/\s+/)[0]; // strip any " \"title\"" suffix
        if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) continue;
        const absSource = path.dirname(f);
        const resolvedAbs = path.resolve(absSource, href);
        const relToDocs = path.relative(DOCS_DIR, resolvedAbs);
        expect(
          relToDocs.startsWith("..") || path.isAbsolute(relToDocs),
          `${f}: relative link "${href}" resolves OUTSIDE the docs/ tree (→ ${relToDocs}). The in-app help drawer cannot reach paths outside /docs/.`,
        ).toBe(false);
      }
    }
  });

  test("standalone HTML pages have <meta name=color-scheme> for theme-aware controls", () => {
    // Regression for L-8 (v6.2.6): without color-scheme the browser renders
    // form controls (inputs, scrollbars, default link colours) with the
    // always-light defaults regardless of prefers-color-scheme. Most visible
    // on iOS Safari where dark-theme inputs would otherwise be white-on-light.
    const fs = require("fs");
    const path = require("path");
    const PUB_DIR = path.resolve(__dirname, "..", "public");
    // v7.23.11 — the three verify pages left this list because the FILES are gone:
    // they are rendered by _emailResultPage now (routes/auth.js). They did not
    // lose the meta — the server-rendered head check below covers them, which is
    // why that check exists.
    const standalone = ["index.html", "help.html"];
    for (const f of standalone) {
      const body = fs.readFileSync(path.join(PUB_DIR, f), "utf8");
      expect(
        /<meta\s+name=["']color-scheme["']\s+content=["']light dark["']/i.test(body),
        `${f}: missing <meta name="color-scheme" content="light dark"/>. Add to <head> so form controls render in the active theme.`,
      ).toBe(true);
    }

    // v7.23.9 — the SERVER-RENDERED standalone pages owe the same thing, and
    // had none of them. routes/auth.js renders four: the unsubscribe shell, the
    // /verify result page and both _emailResultPage outcomes. They are forks of
    // the static files above, and this is the drift that fork produced — the
    // static pages declared it, their server-rendered twins did not, so the same
    // visual surface followed the theme in one form and not the other. The
    // unsubscribe page is the one that matters most: it carries a FORM, which is
    // exactly what the rationale above is about, and it is reached from an email
    // on a phone.
    const authSrc = fs.readFileSync(path.join(PUB_DIR, "..", "routes", "auth.js"), "utf8");
    // The window reaches a head's own </head> (the result pages' heads run past
    // 400 characters since their <html> carries the platform look).
    const heads = [...authSrc.matchAll(/<!DOCTYPE html>[\s\S]{0,800}?<\/head>|<!doctype html><html[\s\S]{0,800}?<\/head>/gi)];
    // THREE since v7.23.10: the unsubscribe shell and both _emailResultPage
    // outcomes. The fourth was the /verify interstitial, deleted when
    // verification became one-click.
    expect(heads.length, "no server-rendered page heads found — the scan would be vacuous")
      .toBeGreaterThanOrEqual(3);
    const bare = heads
      .map(h => h[0])
      .filter(h => !/<meta\s+name=["']color-scheme["']\s+content=["']light dark["']/i.test(h))
      // Name it by the STYLESHEET it links, not by <title>: these titles are
      // template expressions, so a title-based message reports the literal
      // "${escapeHtml(title)}" and tells the reader nothing about which page.
      .map(h => {
        // The PAGE-SPECIFIC stylesheet, not the first one: every head links
        // fonts.css, so that names nothing. And not <title> — these titles are
        // template expressions, so a title-based message reports the literal
        // "${escapeHtml(title)}".
        const sheets = [...h.matchAll(/href="\/([a-z-]+\.css)"/gi)].map(m => m[1]);
        return sheets.find(x => x !== "fonts.css") || sheets[0] || "(no stylesheet)";
      });
    expect(bare, `server-rendered pages missing <meta name="color-scheme">: ${bare.join(", ")}`)
      .toEqual([]);

    // routes/badge.js renders the LinkedIn share page and the public certificate
    // pages (_badgeShellTop) on the same shell (verify-pages.css plus
    // theme-boot.js), so they owe the same meta; a revert to content="dark"
    // would paint the controls dark on a light page. ONE exemption, by name:
    // /credential (_credentialPageHtml) runs no theme script and keeps its fixed
    // dark appearance by design (tests/platform-look-pages.spec.js holds it as a
    // page with no script), so it declares no scheme. The exemption must match
    // exactly one head, so it goes stale loudly.
    const badgeSrc = fs.readFileSync(path.join(PUB_DIR, "..", "routes", "badge.js"), "utf8");
    const badgeHeads = [...badgeSrc.matchAll(/<!DOCTYPE html>[\s\S]{0,800}?<\/head>/gi)].map(h => h[0])
      .filter(h => /href="\/verify-pages\.css"/.test(h));
    const isCredential = (h) => /<title>Verify a certificate/.test(h) && !/theme-boot\.js/.test(h);
    expect(badgeHeads.filter(isCredential).length, "the /credential exemption names exactly one head").toBe(1);
    const shellHeads = badgeHeads.filter(h => !isCredential(h));
    expect(shellHeads.length, "anti-vacuity: the share page and the certificate pages' shell heads were found").toBeGreaterThanOrEqual(2);
    const badgeBare = shellHeads.filter(h => !/<meta\s+name=["']color-scheme["']\s+content=["']light dark["']/i.test(h))
      .map(h => (/<title>([^<]*)<\/title>/.exec(h) || [, "(no title)"])[1]);
    expect(badgeBare, `routes/badge.js shell pages missing <meta name="color-scheme" content="light dark">: ${badgeBare.join(", ")}`)
      .toEqual([]);
  });

  test("CSS accent token is unified across all standalone-page light themes", () => {
    // Regression for U-1 (v6.2.6): pre-fix the light-theme accent drifted
    // across reset-password.css (#7B2FFF) and verify-pages.css (#7B2FFF), so a
    // user transitioning email link → reset → main app saw different shades of
    // purple. Pin them to the canonical pair from styles.css (#7C3AED / #6D28D9)
    // and reject any future drift via this invariant. (intermediary.css was
    // removed with the /set-password intermediary — v7.2.x PR B / F#1+F#3.)
    const fs = require("fs");
    const path = require("path");
    const PUB_DIR = path.resolve(__dirname, "..", "public");
    // v7.23.6 — DERIVED, not a hand-maintained list. It named four sheets, and
    // public/unsubscribe.css (added that release, carrying its own --accent)
    // escaped it silently — a new standalone sheet is exactly what this lock
    // exists to police, so a registry it can be added around is the wrong
    // shape. Every public/*.css is scanned; fonts.css declares no accent, so it
    // simply never matches and needs no exemption.
    const stylesheets = fs.readdirSync(PUB_DIR).filter(f => f.endsWith(".css"));
    expect(stylesheets.length, "no stylesheets found — the scan would be vacuous").toBeGreaterThan(3);
    const FORBIDDEN = [/--accent:\s*#7B2FFF/i, /--accent:\s*#6B34FD/i, /--accent2:\s*#5722E8/i, /--accent2:\s*#6320CC/i];
    for (const f of stylesheets) {
      const body = fs.readFileSync(path.join(PUB_DIR, f), "utf8");
      for (const re of FORBIDDEN) {
        expect(
          re.test(body),
          `${f}: contains drifted accent token matching ${re}. Use the canonical pair (#7C3AED / #6D28D9) so the brand purple is consistent across the auth flow.`,
        ).toBe(false);
      }
    }
  });

  test("v6.9.3+v6.9.4: minified /styles.css preserves whitespace around `and`/`or`/`not` and around `+` inside calc()", async () => {
    // v6.9.3: the CSS minifier stripped spaces adjacent to `(` and `)`,
    // turning `@media(max-width:480px) and (orientation:portrait)` into
    // the invalid `@media(max-width:480px)and(orientation:portrait)` —
    // `and` MUST have surrounding whitespace per Media Queries Level 4.
    // Whole @media block was silently discarded; narrow-portrait header
    // fix-up stopped applying; the top bar overflowed on small phones.
    //
    // v6.9.4: the minifier also stripped spaces around `+`, so
    // `calc(60px + env(safe-area-inset-bottom))` minified to
    // `calc(60px+env(...))` which is invalid — `calc()`/`min()`/`max()`
    // require whitespace around `+` and `-` so signed numerals don't
    // ambiguate with operators. This silently killed 5 pre-existing
    // calc() rules including the help drawer's iPhone safe-area padding
    // and two popover positioners (`top:calc(100% + 4px)`). Extending
    // the regression lock to cover calc() operator spacing too.
    const { api } = await freshCtx();
    const r = await api.get("/styles.css");
    expect(r.ok()).toBeTruthy();
    const body = await r.text();
    // (A) Compound @media must keep whitespace around combinators.
    for (const bad of [")and(", ")or(", ")not("]) {
      expect(
        body.includes(bad),
        `Minified /styles.css contains "${bad}" — invalid compound @media query. Check the skip-list in _minifyCss (server.js): \`(\` and \`)\` must NOT be strip boundaries.`,
      ).toBe(false);
    }
    // (B) Every calc() expression must have whitespace around `+`.
    // Walk with balanced-paren awareness because env(), min(), etc. nest
    // inside calc. We only check `+` because `-` is already preserved by
    // the minifier (it was never in the skip-list), and `-` is ambiguous
    // with CSS identifier hyphens (`safe-area-inset-bottom`) which a
    // simple regex can't distinguish from a math operator.
    for (let i = 0; (i = body.indexOf("calc(", i)) !== -1; ) {
      let depth = 1, j = i + 5;
      while (j < body.length && depth > 0) {
        if (body[j] === "(") depth++;
        else if (body[j] === ")") depth--;
        j++;
      }
      const inner = body.substring(i + 5, j - 1);
      expect(
        /\S\+|\+\S/.test(inner),
        `Minified calc(${inner}) missing whitespace around +. Check _minifyCss skip-list in server.js — "+" must NOT be a strip boundary.`,
      ).toBe(false);
      i = j;
    }
    // (C) Positive checks: the specific rules that were previously broken
    // now survive minification intact.
    expect(body).toMatch(/@media\s*\(max-width:480px\)\s+and\s+\(orientation:portrait\)/);
    // A calc() with two `+` operators around env(), as it is written.
    expect(body).toMatch(/body\.selection-bar-open footer\{padding-bottom:calc\(120px\s+\+\s+env\(safe-area-inset-bottom\)\s+\+\s+14px\)\}/);
    await api.dispose();
  });

  test("minified /styles.css keeps the descendant space before a pseudo-class", async () => {
    // _minifyCss deleted every space before `:`, so the descendant selector
    // `a :is(b)` was served as the compound `a:is(b)`, which matches nothing:
    // 28 selectors were silently dead that way, among them most of the looks'
    // construction rules. `:` is now a strip boundary on its right only.
    const fs = require("fs");
    const path = require("path");
    // (A) The function itself, on planted input, so this arm holds whatever
    // the stylesheet happens to contain.
    const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const at = serverSrc.indexOf("function _minifyCss(src) {");
    expect(at, "anti-vacuity: _minifyCss is found in server.js").toBeGreaterThan(-1);
    const minify = new Function(`${serverSrc.slice(at, serverSrc.indexOf("\n}\n", at) + 2)}\nreturn _minifyCss;`)();
    expect(minify(".a :is(.b , .c) > .d :not(.e) {\n  color : red;\n}")).toBe(".a :is(.b,.c)>.d :not(.e){color :red}");
    expect(minify(".a:hover , .b ::before{x: y}")).toBe(".a:hover,.b ::before{x:y}");
    // (B) The server serves exactly that function's output, so (A) holds for
    // what browsers receive.
    const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
    const { api } = await freshCtx();
    const r = await api.get("/styles.css");
    expect(r.ok()).toBeTruthy();
    const body = await r.text();
    expect(body.length, "anti-vacuity: a real stylesheet was served").toBeGreaterThan(100000);
    expect(body === minify(css), "the served /styles.css is _minifyCss(public/styles.css), byte for byte").toBe(true);
    await api.dispose();
  });

  test("_minifyCss runs in linear time: four times the input takes about four times as long, not sixteen", () => {
    // It read `out[out.length - 1]` at every run of whitespace, which flattens
    // the string `+=` is building (a copy of everything written so far), so it
    // was quadratic: 1.6 s on the 530 KB stylesheet, paid by every boot, and a
    // production boot on a loaded CI runner then missed the graceful-shutdown
    // test's 15 s window. A ratio, not a budget, so the machine's speed cancels
    // out. Measured on a quarter of the stylesheet against four copies of it:
    // linear x3.9 to x4.7, quadratic x57 to x106.
    const fs = require("fs");
    const path = require("path");
    const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const at = serverSrc.indexOf("function _minifyCss(src) {");
    expect(at, "anti-vacuity: _minifyCss is found in server.js").toBeGreaterThan(-1);
    const minify = new Function(`${serverSrc.slice(at, serverSrc.indexOf("\n}\n", at) + 2)}\nreturn _minifyCss;`)();
    const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
    expect(css.length, "anti-vacuity: the real stylesheet").toBeGreaterThan(200000);
    const one = css.slice(0, Math.floor(css.length / 4));
    const four = one.repeat(4);
    // Timed in this process's CPU time, not wall time: on a runner whose other
    // workers keep every core busy a pass is paused while they run, the longer
    // pass more often, which put x12 on the linear minifier in CI (four busy
    // loops a core: wall time x11 median, CPU time x3.9 to x4.7).
    const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
    // Warm the JIT first, so no measured pass is a cold one.
    for (let k = 0; k < 4; k++) minify(one);
    const best = { one: Infinity, four: Infinity };
    for (let k = 0; k < 5; k++) {
      for (const [key, input] of [["one", one], ["four", four]]) {
        const t0 = cpuMs();
        minify(input);
        best[key] = Math.min(best[key], cpuMs() - t0);
      }
    }
    expect(best.one, "anti-vacuity: the CPU clock measured the smaller pass").toBeGreaterThan(0);
    const ratio = best.four / best.one;
    expect(ratio, `${one.length} characters took ${best.one.toFixed(1)} ms of CPU, four times as many ${best.four.toFixed(1)} ms (x${ratio.toFixed(1)})`).toBeLessThan(10);
  });

  test("v6.20.x: first-party public JS minifies cleanly via esbuild (valid + smaller)", () => {
    // Lock for accepted-disposition #5 retirement: the production process
    // minifies public/*.js at boot with esbuild (server.js _minifyJs / _jsCache,
    // gated on _MINIFY_JS). Tests run NODE_ENV=test → raw serve, so this
    // exercises the minifier directly against the real sources rather than the
    // served bytes. It catches (a) a future syntax esbuild can't handle and
    // (b) minified output that isn't valid JS — either of which would ship a
    // broken bundle in production while the (raw) test suite stayed green.
    const esbuild = require("esbuild");
    const fs = require("fs");
    const path = require("path");
    const pubDir = path.join(__dirname, "..", "public");
    // Same predicate as server.js _isMinifiableJs: first-party .js under
    // public/, excluding vendor *.min.js.
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(d, e.name);
      if (e.isDirectory()) return walk(full);
      return e.name.endsWith(".js") && !e.name.endsWith(".min.js") ? [full] : [];
    });
    const files = walk(pubDir);
    expect(files.some((f) => f.endsWith(`${path.sep}main.js`)), "walk did not find public/js/core/main.js").toBe(true);
    const opts = { loader: "js", minify: true, legalComments: "none" };
    for (const f of files) {
      const base = path.basename(f);
      const raw = fs.readFileSync(f, "utf8");
      // transformSync throws on un-minifiable input → fails the test loudly.
      // (v7.0.0: public/js/** are ES modules — transform keeps import/export.)
      const min = esbuild.transformSync(raw, opts).code;
      expect(min.length, `minified ${base} is empty`).toBeGreaterThan(0);
      expect(min.length, `minified ${base} is not smaller than raw`).toBeLessThanOrEqual(raw.length);
      // Re-parse the minified output to prove it is syntactically valid JS.
      esbuild.transformSync(min, { loader: "js" });
    }
    // v7.0.0: the production process esbuild-BUNDLES the SPA entry (its whole
    // import graph inlined into one file). Assert the bundle builds without
    // error + is non-empty + smaller than the concatenated module sources — a
    // future unresolved import / missing export / syntax error would ship a
    // broken bundle while the (raw-served) test suite stayed green.
    const entry = path.join(pubDir, "js", "core", "main.js");
    const built = esbuild.buildSync({ entryPoints: [entry], bundle: true, minify: true, format: "esm", write: false, legalComments: "none" });
    const bundle = built.outputFiles[0].text;
    expect(bundle.length, "entry bundle is empty").toBeGreaterThan(0);
    const totalRaw = walk(path.join(pubDir, "js")).reduce((n, f) => n + fs.readFileSync(f, "utf8").length, 0);
    expect(bundle.length, "bundle should be smaller than the concatenated module sources").toBeLessThan(totalRaw);
  });

  test("v6.8.10: every screenshot referenced by a user-guide .md exists; no orphan screenshots on disk", () => {
    // Hygiene test — catches two kinds of drift:
    //   1. A markdown file references ../screenshots/foo.png but the file
    //      was renamed / deleted. The guide would render a broken image
    //      when a user opens it. Fail loud at CI time instead.
    //   2. A screenshot file lingers in docs/screenshots/ after its
    //      reference was removed from the markdown (e.g. a tab renamed
    //      during a refactor and the old capture was forgotten). Orphan
    //      files bloat the repo + ship in the Docker image.
    // Both directions matter because the screenshot regen script only
    // (re)captures the shots the guide currently references — the rest
    // just sit on disk forever.
    const fs = require("fs");
    const pathMod = require("path");
    const root = pathMod.resolve(__dirname, "..");
    const guideDir = pathMod.join(root, "docs/user-guide");
    const shotDir = pathMod.join(root, "docs/screenshots");

    // 1. Collect every referenced screenshot path from the .md files.
    const referenced = new Set();
    const IMG_RE = /!\[[^\]]*\]\(([^)\s]+?)(?:\s+"[^"]*")?\)/g;
    for (const f of fs.readdirSync(guideDir).filter(n => n.endsWith(".md"))) {
      const body = fs.readFileSync(pathMod.join(guideDir, f), "utf8");
      let m;
      while ((m = IMG_RE.exec(body))) {
        const raw = m[1];
        // Only care about relative references into the screenshots tree.
        if (!raw.startsWith("../screenshots/") && !raw.startsWith("../../screenshots/")) continue;
        // Strip any ?v=<hash> query — the hash pipeline adds it at serve time.
        const bare = raw.split("?")[0];
        const resolved = pathMod.resolve(pathMod.join(guideDir, bare));
        referenced.add(resolved);
        expect(fs.existsSync(resolved), `${f} references missing screenshot: ${raw}`).toBeTruthy();
      }
    }

    // 2. Walk screenshots/ and flag any light-theme PNG not referenced.
    // Dark variants (foo.dark.png) pair with foo.png so they're matched
    // transitively via the help-renderer theme swap; we only audit the
    // base PNG names here. We explicitly skip MANIFEST.json and non-PNG
    // files (licenses, READMEs should they appear).
    const onDisk = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d)) {
        const full = pathMod.join(d, e);
        const st = fs.statSync(full);
        if (st.isDirectory()) { walk(full); continue; }
        if (!/\.png$/i.test(e)) continue;
        if (/\.dark\.png$/i.test(e)) continue;
        onDisk.push(full);
      }
    })(shotDir);
    const orphans = onDisk.filter(p => !referenced.has(p));
    expect(orphans, `Orphan screenshots not referenced by any guide:\n${orphans.map(p => "  " + pathMod.relative(root, p)).join("\n")}`).toHaveLength(0);
  });

  test("admin-only docs require an admin session; participant docs stay public (v6.3.2, v6.8.9)", async () => {
    // Regression: /docs was mounted unauthenticated in v6.2.x. An anonymous
    // visitor could read docs/user-guide/superadmin.md with its disclosure
    // of the built-in account name, password-storage path, and manual
    // reset-link sharing workflow. v6.3.2 gates admin.md, superadmin.md,
    // and the admin/superadmin screenshots behind an admin session.
    // Participant.md + participant screenshots stay public so
    // not-yet-registered visitors can still read "how do I sign up".
    // v6.8.9 removed the top-level /docs/README.md role picker — there
    // is no role-picker page anymore; each role lands directly on its
    // own guide.
    const { request } = require("./isolated-test");
    const anon = await request.newContext({ baseURL: require("./helpers").BASE });

    // Public — anonymous access OK.
    {
      const r = await anon.get("/docs/user-guide/participant.md");
      expect(r.status(), "/docs/user-guide/participant.md should be public").toBe(200);
    }
    // The removed top-level role picker now 404s — confirm it's gone.
    {
      const r = await anon.get("/docs/README.md");
      expect(r.status(), "/docs/README.md should 404 after v6.8.9 removal").toBe(404);
    }

    // Gated — anonymous gets 401.
    for (const p of [
      "/docs/user-guide/admin.md",
      "/docs/user-guide/superadmin.md",
    ]) {
      const r = await anon.get(p);
      expect(r.status(), `${p} should require admin`).toBe(401);
    }
    // A sampled admin screenshot must also be gated.
    const shotR = await anon.get("/docs/screenshots/admin/01-competitions.png");
    // Some test environments may not have captured this particular screenshot;
    // accept 401 (gated) OR 404 (file not present on disk). Only a 200 is a fail.
    expect([401, 404]).toContain(shotR.status());

    await anon.dispose();

    // Authed superadmin can read everything (excluding the removed README).
    const { api: sa } = await apiLogin("superadmin");
    for (const p of [
      "/docs/user-guide/participant.md",
      "/docs/user-guide/admin.md",
      "/docs/user-guide/superadmin.md",
    ]) {
      const r = await sa.get(p);
      expect(r.status(), `${p} should be readable by superadmin`).toBe(200);
    }
    await sa.dispose();
  });

  test("every file under docs/ is either served to admins only or on the reasoned public list (sweep #148)", async () => {
    // /docs is a DENY-LIST: _docsPathNeedsAdmin (server.js) names what needs an
    // admin session, and express.static serves every other file under docs/ to
    // anyone, signed in or not (and every file ships in the image). An internal
    // mock-up naming real companies as sample sales leads sat there, public. So
    // each file is a decision: gated by the server's own predicate, or listed in
    // PUBLIC_DOCS with the reason the public may read it. A file that is neither
    // is undecided; a public entry no file matches is stale.
    const fs = require("fs");
    const path = require("path");
    const { normaliseRoutePath } = require("../lib/util");
    const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const at = serverSrc.indexOf("function _docsPathNeedsAdmin(rawPath) {");
    expect(at, "anti-vacuity: _docsPathNeedsAdmin is found in server.js").toBeGreaterThan(-1);
    const needsAdmin = new Function("normaliseRoutePath",
      `${serverSrc.slice(at, serverSrc.indexOf("\n}\n", at) + 2)}\nreturn _docsPathNeedsAdmin;`)(normaliseRoutePath);
    const PUBLIC_DOCS = [
      { re: /^\/user-guide\/participant\.md$/, why: "the participant guide: how to sign up and play, read before an account exists" },
      { re: /^\/screenshots\/participant\/[^/]+\.png$/, why: "the participant guide's own pictures" },
      { re: /^\/screenshots\/MANIFEST\.json$/, why: "capture bookkeeping: the release that last captured and per-role picture counts; it names no person, event or route" },
    ];
    const classify = (p) => {
      const gated = needsAdmin(p);
      const listed = PUBLIC_DOCS.some(x => x.re.test(p));
      return gated && listed ? "both" : gated ? "gated" : listed ? "public" : "undecided";
    };
    // Planted controls: the classifier says what it must.
    expect(classify("/mockups/event-team-reports.html"), "control: an unlisted, ungated file is undecided").toBe("undecided");
    expect(classify("/notes/leads.pdf"), "control: so is any other new file").toBe("undecided");
    expect(classify("/user-guide/admin.md"), "control: the admin guide is gated").toBe("gated");
    expect(classify("//user-guide/SUPERADMIN.md"), "control: gated under another spelling, as the server normalises it").toBe("gated");
    expect(classify("/screenshots/participant/01-x.png"), "control: a participant picture is public").toBe("public");
    const docsDir = path.join(__dirname, "..", "docs");
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else files.push("/" + path.relative(docsDir, f).split(path.sep).join("/"));
      }
    };
    walk(docsDir);
    expect(files.length, "anti-vacuity: the docs tree is read").toBeGreaterThan(200);
    const by = { gated: [], public: [], undecided: [], both: [] };
    for (const f of files) by[classify(f)].push(f);
    expect(by.undecided, "each file under docs/ is gated by _docsPathNeedsAdmin or listed in PUBLIC_DOCS with its reason").toEqual([]);
    expect(by.both, "a gated file is never also on the public list").toEqual([]);
    expect(by.gated.length, "anti-vacuity: the gated guides and screenshots are seen").toBeGreaterThan(150);
    for (const x of PUBLIC_DOCS) expect(files.some(f => x.re.test(f)), `stale PUBLIC_DOCS entry ${x.re}: no file matches it`).toBe(true);
    // Behaviour: the deleted mock-up is not served, and the published asset map
    // names no path to it.
    const { request } = require("./isolated-test");
    const anon = await request.newContext({ baseURL: require("./helpers").BASE });
    try {
      expect((await anon.get("/docs/mockups/event-team-reports.html")).status()).toBe(404);
      const av = await (await anon.get("/asset-versions.js")).text();
      expect(av, "control: the asset map lists the docs files it serves").toContain("/docs/screenshots/participant/");
      expect(av).not.toContain("/docs/mockups/");
      expect((await anon.get("/docs/user-guide/participant.md")).status(), "control: the public guide is served").toBe(200);
    } finally { await anon.dispose(); }
  });

  test("v6.8.9: regular admins (not just superadmins) can read superadmin.md", async () => {
    // The help drawer now routes both admins and superadmins to admin.md
    // with a "Next: Superadmin guide" CTA at the bottom. That CTA is only
    // useful if regular admins actually have read access — otherwise the
    // link would 401 for them. _gateAdminDocs on the server side checks
    // req.session.isAdmin which is true for both roles, so both can read.
    // This locks in the behaviour.
    await ensureState();
    // Promote carol to regular admin for this test (seed user), then
    // confirm she can read superadmin.md. Restore at the end.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { role: "admin" },
    });
    await sa.dispose();
    try {
      const { api: carol } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      const r = await carol.get("/docs/user-guide/superadmin.md");
      expect(r.status()).toBe(200);
      await carol.dispose();
    } finally {
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, {
        headers: { "x-csrf-token": sa2Csrf, "content-type": "application/json" },
        data: { role: "participant" },
      });
      await sa2.dispose();
    }
  });

  test("v8.3.5: every dynamically created overlay obtains fixed positioning", () => {
    // THE DEFECT THIS CATCHES SHIPPED FOR SIX RELEASES AND LOOKED LIKE A BROKEN APP.
    //
    // `openSetPassword` (v7.29.0) clones the change-password dialog's markup —
    // `.card.password-card`, `.password-label-hint`, `.password-error`,
    // `.password-actions` — but every rule for those is written against
    // `#password-overlay`, and `#setpw-overlay` was in NONE of them. So the element
    // had no `position:fixed`, no centring, no z-index and no card `max-width`: it
    // rendered in normal flow as a full-width bar at the BOTTOM of the document,
    // below the footer. It was reported the moment v8.3.2's header chip made the
    // dialog prominent; until then its only entry point was a button inside another
    // dialog, which is why it survived.
    //
    // THERE ARE THREE LEGITIMATE WAYS TO GET POSITIONED, and the scanner accepts all
    // three, because a scanner that is wrong about working code gets silenced by
    // whoever hits it next: an id rule in styles.css, a class that carries one
    // (`.picker-overlay`), or an inline `style.cssText`. `#setpw-overlay` used none.
    //
    // IT STRIPS CSS COMMENTS FIRST, and that is not defensive tidying — the first
    // draft did not, so the comment block this fix added (which names
    // `#setpw-overlay` in prose, immediately above the rule) was captured as part of
    // that rule's selector list, and the scanner reported a clean tree against a
    // deliberately broken one. Verified by reverting the fix: it must name
    // `#setpw-overlay` and nothing else.
    const fs = require("fs");
    const path = require("path");
    const cssRaw = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
    const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
    const fixedSel = new Set();
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (/position\s*:\s*fixed/.test(m[2])) for (const sel of m[1].split(",")) fixedSel.add(sel.trim());
    }
    // Match the whole compound token, so `#setpw-overlay` is never satisfied by
    // `#setpw-overlay-something` or by a longer id that merely contains it.
    const declares = (tok) => [...fixedSel].some((sel) =>
      sel.split(/\s+/).some((part) => part.split(":")[0] === tok));

    const jsFiles = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f); else if (f.endsWith(".js")) jsFiles.push(f);
      }
    })(path.join(__dirname, "..", "public", "js"));

    const unstyled = [];
    const scanned = new Set();
    for (const f of jsFiles) {
      const lines = fs.readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        const m = line.match(/\.id\s*=\s*['"]([a-z0-9-]*overlay)['"]/);
        if (!m) return;
        const id = m[1];
        scanned.add(id);
        const ctx = lines.slice(Math.max(0, i - 8), i + 9).join("\n");
        const cls = (ctx.match(/className\s*=\s*['"]([^'"]+)['"]/) || [])[1] || "";
        const ok = declares(`#${id}`)
          || cls.split(/\s+/).filter(Boolean).some((c) => declares(`.${c}`))
          || /style\.cssText\s*=\s*['"`][^'"`]*position:\s*fixed/.test(ctx);
        if (!ok) unstyled.push(`${f.split("public/js/")[1]}:${i + 1} — #${id}`);
      });
    }
    // Anti-vacuity, both halves: the CSS parse must have found the rule of a LIVE
    // dynamically created overlay (the event form, built in JS and styled by its
    // own id rule), and the JS walk must have found the overlay creations, or
    // "nothing is unstyled" is equally satisfied by a regex that matched nothing.
    expect(scanned.has("comp-form-overlay"), "the JS walk really found the overlay creations").toBe(true);
    expect(scanned.size, "the JS walk found the overlay creations").toBeGreaterThanOrEqual(15);
    expect(declares("#comp-form-overlay"), "the scanner really parsed the modal rules").toBe(true);
    expect(unstyled, `these overlays render in normal flow:\n${unstyled.join("\n")}`).toEqual([]);
  });

  // ── v8.3.11 ─────────────────────────────────────────────────────────────
  // A line-preserving comment stripper for the route scanner below.
  //
  // It is NOT the two-step `block then line` form, and that matters here rather
  // than being a nicety: server.js carries the literal `accept="image/*"` inside
  // a `//` comment, so a block-first pass opens a comment there and closes it at
  // the next `*/` — MEASURED, that blanked the whole region containing the
  // `/api/tasks/:id/submit` registration (11 of the 211 registrations vanished),
  // i.e. the scanner reported a clean tree while blind to one of the very routes
  // the fix is about (v7.21.24, earned again).
  // One left-to-right alternation gets it right, because whichever comment opens
  // FIRST wins — the rule a tokeniser applies.
  //
  // Line count is preserved (comments become spaces, newlines survive) so a
  // finding can name file:line, and offsets stay comparable with the raw source.
  function _stripJsCommentsKeepLines(src) {
    return src.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (m, pre) =>
      pre === undefined ? m.replace(/[^\n]/g, " ") : pre + " ".repeat(m.length - pre.length));
  }

  test("v8.3.11 (F3): no gated route spends a rate-limit bucket before it authenticates", () => {
    // THE DEFECT this closes: eleven routes registered their limiter AHEAD of
    // their auth guard, so an anonymous 401/403 incremented a bucket the real
    // user shares. On a venue NAT that 429s the admin standing in the room —
    // the cascade class v7.15.34 / v7.16.0 exist to prevent — and on the
    // participant routes (`/api/tasks/:id/submit`, hint, navigated-away) it
    // denies submissions to the whole cohort from one unauthenticated caller.
    //
    // v7.23.0 got `export/competition-activity` right, wrote the reasoning at
    // that route, and explicitly deferred its four siblings. Prose does not
    // enumerate (v7.15.15) and the deferral outlived the memory of it, so the
    // durable guard is this scanner: a TWELFTH route registered the other way
    // round fails immediately rather than shipping.
    //
    // SCOPE IT CORRECTLY OR IT WILL BE WRONG ABOUT WORKING CODE. A route with
    // NO auth guard at all — /api/login, /api/csrf-token, /api/config,
    // /api/images/:id, the LinkedIn endpoints, /api/auth/code/*, /credential,
    // the public badge routes — is anonymous BY DESIGN, and there the limiter is
    // the ONLY control: it must stay first. So this flags only a registration
    // that HAS an auth guard and puts a limiter in front of it. A scanner that
    // demanded "limiter last, always" would be red against ~150 correct
    // registrations on day one and would be silenced by whoever hit it next.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const files = ["server.js",
      ...fs.readdirSync(pathMod.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`)];

    // A limiter is either the shared `rateLimit(...)` factory called inline, or
    // one of the named buckets built from it. Matched by SHAPE rather than by a
    // name list (exportLimiter / importLimiter / submitLimit / bulkAdminLimit /
    // destructiveAdminLimit / retentionPurgeLimit / _loginLimiter / _UNSUB_LIMIT
    // are all spelled differently), so a bucket named next year is covered
    // without anyone remembering to add it here.
    const LIMITER = /\brateLimit\s*\(|\b[A-Za-z_$][\w$]*(?:Limit|Limiter|LIMIT)\b/;
    const AUTH = /\brequire(?:Admin|SuperAdmin|Participant)\b/;
    const REG = /\bapp\.(get|post|put|patch|delete)\s*\(\s*(["'])([^"']+)\2\s*,/g;

    const gated = [], bad = [];
    let registrations = 0;
    for (const rel of files) {
      const src = _stripJsCommentsKeepLines(fs.readFileSync(pathMod.join(root, rel), "utf8"));
      REG.lastIndex = 0;
      let m;
      while ((m = REG.exec(src))) {
        registrations++;
        // Split the argument list on TOP-LEVEL commas, so `rateLimit(60_000, 20,
        // "x")` and `upload.single("file")` stay one argument each. Stop at the
        // first arrow/function — everything before it is middleware.
        let i = m.index + m[0].length, depth = 0, args = [], cur = "";
        while (i < src.length) {
          const c = src[i];
          if (c === "(" || c === "[" || c === "{") depth++;
          else if (c === ")" || c === "]" || c === "}") {
            if (c === ")" && depth === 0) { args.push(cur); break; }
            depth--;
          }
          if (c === "," && depth === 0) { args.push(cur); cur = ""; i++; continue; }
          cur += c; i++;
        }
        const mw = [];
        for (const a of args) {
          const t = a.trim();
          if (/=>|^(async\s+)?function\b/.test(t)) break;
          mw.push(t);
        }
        const li = mw.findIndex(x => LIMITER.test(x));
        const ai = mw.findIndex(x => AUTH.test(x));
        if (li < 0 || ai < 0) continue;                 // anonymous by design, or ungated — not our business
        const where = `${rel}:${src.slice(0, m.index).split("\n").length} ${m[1].toUpperCase()} ${m[3]}`;
        gated.push(where);
        // The comparison is against the FIRST guard, not "a guard exists
        // somewhere after it": /api/admin/export/settings carries requireAdmin
        // AND requireSuperAdmin, so an index test that only looked for one of
        // them would bless `requireAdmin, exportLimiter, requireSuperAdmin`.
        if (li < ai) bad.push(`${where}\n      [${mw.join(", ")}]`);
      }
    }

    // ANTI-VACUITY. Both floors are load-bearing in different directions: the
    // first says the registration walk still parses this codebase at all (the
    // stripper bug above made it silently lose 11 routes), the second says the
    // limiter/auth vocabulary still matches something. Rename `rateLimit` and
    // the second floor fires rather than the scan passing in silence (v8.3.9).
    expect(registrations, "the route walk found almost nothing — did app.<verb> registration change shape?")
      .toBeGreaterThanOrEqual(120);
    expect(gated.length,
      "the scan found hardly any GATED routes carrying a limiter, so 'none is mis-ordered' would be " +
      "vacuous — the limiter or auth-guard vocabulary has probably been renamed out from under it")
      .toBeGreaterThanOrEqual(15);

    expect(bad,
      "these routes register a rate limiter BEFORE their auth guard, so an unauthenticated 401/403 " +
      "burns a per-IP bucket the legitimate user shares. Auth first, limiter second — always, on any " +
      "route that has a guard at all:\n    " + bad.join("\n    ")
    ).toEqual([]);
  });

  test("v8.12.6 (F1): every route that parses its body AFTER its auth guard re-asks authorisation atomically with its first write", () => {
    // THE CLASS. The global 5 MB / 16 KB parsers run before the session and the
    // guards, so an ordinary JSON route's guard sees the whole body and there is
    // no window. A route that mounts a body parser IN ITS OWN CHAIN, after a
    // require* guard — multer on the two attachment uploads and the participant
    // submit, the 128 MB import parser — decides authorisation when the HEADERS
    // arrive and keeps reading afterwards, and the handler then awaits (ZIP walk,
    // hash, move) before it writes. MEASURED before
    // v8.12.6: an admin blocked, demoted or deleted anywhere in that window still
    // committed, and a blocked superadmin's participant import minted a new
    // SUPERADMIN account.
    //
    // THE PARTICIPANT TIER NEEDS TWO QUESTIONS, NOT ONE. v8.11.1 F3 re-asked the
    // SEAT (`participantAuthzDenied` reads `req.session.userId`), which under
    // impersonation is the TARGET — so the admin at the keyboard of an
    // impersonation session was re-read only by `impersonationGuard`, at the
    // headers, and a superadmin revoked while a file answer was uploading scored
    // for the participant (measured, the v8.12.6 review). A `requireParticipant`
    // route in this class must therefore carry `impersonatingHandDenied(` as well,
    // under the same placement rule. An earlier draft of this comment said F3
    // had "closed it for the participant tier"; it had closed the seat's half.
    // And a THIRD: `participantSessionDenied(`, the tombstone of a session acting
    // as its own account — a password reset, a sign-in elsewhere or a logout
    // during the upload leaves the account qualifying, so the seat question
    // cannot see it, and the hand question is asked only under impersonation.
    //
    // WHAT IS PINNED is placement, not presence: the re-check must sit with NO
    // non-returning `await` between it and the handler's first durable write
    // (`.run(`), i.e. atomic with the commit on this synchronous single-process
    // driver. "After the FIRST await" is not enough and was measured not to be —
    // a check moved from inside the upload's write transaction to just after the
    // ZIP walk passed a whole behavioural suite, leaving the hash+move window the
    // audit named wide open. The behavioural arms (admin-inflight-authz) pin that
    // the answer is honoured; this pins where it is asked.
    //
    // FAIL, never skip, on a route in the class whose handler shape is not
    // recognised: the failure mode is always the route added later, and a scanner
    // that `continue`s past what it does not understand passes in silence on
    // exactly that route. Classification is by SHAPE — any `.single/.array/
    // .fields/.any()` upload, any `express.json/raw/text/urlencoded(`, any
    // identifier ending `Parser` — so a parser named next year is covered.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const files = ["server.js",
      ...fs.readdirSync(pathMod.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`)];
    const PARSER = /\.(?:single|array|fields)\s*\(|\.any\s*\(\s*\)|\bexpress\s*\.\s*(?:json|raw|text|urlencoded)\s*\(|\b[A-Za-z_$][\w$]*Parser\b/;
    const GUARD = /\brequire[A-Z][\w$]*\b/;
    const REG = /\bapp\.(post|put|patch|delete)\s*\(\s*(["'])([^"']+)\2\s*,/g;

    const inClass = [], bad = [];
    for (const rel of files) {
      const src = _stripJsCommentsKeepLines(fs.readFileSync(pathMod.join(root, rel), "utf8"));
      REG.lastIndex = 0;
      let m;
      while ((m = REG.exec(src))) {
        // Top-level argument split, the F3 scanner's own walk (above): a
        // parser's argument list and the handler's body stay one argument each.
        let i = m.index + m[0].length, depth = 0, args = [], cur = "";
        while (i < src.length) {
          const c = src[i];
          if (c === "(" || c === "[" || c === "{") depth++;
          else if (c === ")" || c === "]" || c === "}") {
            if (c === ")" && depth === 0) { args.push(cur); break; }
            depth--;
          }
          if (c === "," && depth === 0) { args.push(cur); cur = ""; i++; continue; }
          cur += c; i++;
        }
        // The handler is the LAST argument, always. An earlier draft took the
        // first argument containing `=>`, and a limiter built with an arrow
        // (`rateLimit(…, { keyExtra: (req) => … })`, which change-password and
        // PUT /api/me carry) then read as the handler — so a body parser mounted
        // after such a limiter fell outside `chain` and the route would have left
        // the class SILENTLY (found by the v8.12.6 review fix's participant-tier
        // arm below, which needed that chain read correctly). A handler passed by
        // NAME is still caught by the shape check further down.
        const h = args.length - 1;
        const chain = args.slice(0, h);
        const gi = chain.findIndex(x => GUARD.test(x));
        const pi = chain.findIndex(x => PARSER.test(x));
        if (gi < 0 || pi < 0 || pi < gi) continue;     // no window: the guard saw the whole body, or there is no guard
        const where = `${rel}:${src.slice(0, m.index).split("\n").length} ${m[1].toUpperCase()} ${m[3]}`;
        inClass.push(m[3]);
        const handler = args[h].trim();
        if (!/^async\s*\(\s*req\s*,\s*res\s*\)\s*=>/.test(handler)) {
          bad.push(`${where}: parses its body after its guard, and its handler shape is not one this scanner can ` +
            `verify (expected \`async (req, res) =>\`) — teach the scanner the shape, do not skip the route`);
          continue;
        }
        const wants = chain.some(x => /\brequireParticipant\b/.test(x))
          ? ["participantAuthzDenied(", "impersonatingHandDenied(", "participantSessionDenied("] : ["adminAuthzDenied("];
        const firstWrite = handler.search(/\.run\s*\(/);
        for (const want of wants) {
          const at = handler.indexOf(want);
          if (at < 0) { bad.push(`${where}: parses its body after its guard and never re-asks ${want}`); continue; }
          if (firstWrite < 0 || firstWrite < at) { bad.push(`${where}: ${want} is not ahead of the handler's first durable write`); continue; }
          const awaits = (handler.slice(at, firstWrite).replace(/\breturn\s+await\b/g, "return").match(/\bawait\b/g) || []).length;
          if (awaits) bad.push(`${where}: ${awaits} await(s) between ${want} and the first write — the re-check must be atomic with the commit`);
        }
      }
    }

    // ANTI-VACUITY, twice. The floor says the walk still classifies this codebase
    // at all; the named routes say it still recognises the ones this lock was
    // written for — rename `_importJsonParser` to something without "Parser" and
    // the imports would leave the class silently while the floor might survive.
    expect(inClass.length, `the class walk found only ${JSON.stringify(inClass)} — did the parser or guard vocabulary change?`)
      .toBeGreaterThanOrEqual(5);
    for (const r of ["/api/admin/tasks/:id/attachments", "/api/admin/attachment-staging",
      "/api/admin/import/tasks", "/api/admin/import/participants", "/api/tasks/:id/submit"]) {
      expect(inClass, `${r} is no longer recognised as parsing its body after its guard`).toContain(r);
    }
    expect(bad,
      "these routes parse their body AFTER their auth guard, so authorisation was decided before the body " +
      "arrived and must be re-asked immediately before the write (adminAuthzDenied; for a participant route " +
      "participantAuthzDenied for the seat, impersonatingHandDenied for an impersonating admin AND " +
      "participantSessionDenied for the session itself), " +
      "with nothing awaited in between:\n    " + bad.join("\n    ")
    ).toEqual([]);
  });

  test("v8.12.6 (review fix): every participant write that awaits before it writes re-asks the impersonating admin and the session at commit", () => {
    // THE CLASS, one tier down from the F1 scanner above and wider than its
    // parser-after-guard shape: a `requireParticipant` route whose handler AWAITS
    // before its first durable write. Under impersonation `requireParticipant`
    // reads the TARGET, and the admin at the keyboard is re-read once, by
    // `impersonationGuard`, when the headers arrive — so anything awaited after
    // that (a file read, a bcrypt pair, a badge rasterise) is a window in which
    // a revoked admin's write still lands for the participant. MEASURED for the
    // file-answer submit: 200 and 50 points, from a superadmin blocked mid-upload.
    // Every such route must call `impersonatingHandDenied(` ahead of its first
    // `.run(`, with no await between the two — and `participantSessionDenied(`
    // under the same rule: the session itself, for a session acting as its own
    // account (a password reset, a sign-in elsewhere, a logout during the await
    // ends it and leaves the account qualifying — measured, the file answer
    // scored and a revoked change-password minted itself a fresh session).
    //
    // WHAT IS DELIBERATELY NOT IN IT, each a DECISION rather than a gap:
    //   • an `await` on a line that names a test-only hold (`test…Delay(` /
    //     `test…Park(` / `_test…DelayMs`) — it resolves at once in every
    //     environment but a test that armed it, so it opens no window in
    //     production (select-timeslot's only await is one);
    //   • the HAND question only, for a route on `_IMPERSONATION_BLOCKED`, read
    //     from lib/impersonation.js rather than restated here — refused to every
    //     impersonation tier before its handler runs, so no admin's hand can
    //     reach its window (set-password). The session question still binds it;
    //   • EXEMPT below, a route whose write the scanner cannot see because it
    //     happens inside a callee — each entry states why the guard's answer is
    //     still current when that write lands.
    // A route whose write is invisible and which is NOT exempted FAILS rather
    // than being skipped: the failure mode is always the route added later.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const files = ["server.js",
      ...fs.readdirSync(pathMod.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`)];
    const impSrc = _stripJsCommentsKeepLines(fs.readFileSync(pathMod.join(root, "lib", "impersonation.js"), "utf8"));
    const bm = impSrc.match(/const\s+_IMPERSONATION_BLOCKED\s*=\s*new\s+Set\s*\(\s*\[([^\]]*)\]/);
    expect(bm, "lib/impersonation.js no longer declares _IMPERSONATION_BLOCKED as a literal Set — teach this scanner the new shape").toBeTruthy();
    const BLOCKED = new Set((bm[1].match(/["'][^"']+["']/g) || []).map(x => x.slice(1, -1)));
    const EXEMPT = {
      "/api/competitions/:id/leave": "its only await is removeUserFromCompetition(), whose membership DELETE runs synchronously " +
        "before that function's first await, so the write lands inside the same tick as the guard's answer",
    };
    const TESTHOOK = /\btest[A-Z]\w*(?:Delay|Park)\s*\(|\b_test\w*DelayMs\b/;
    const REG = /\bapp\.(post|put|patch|delete)\s*\(\s*(["'])([^"']+)\2\s*,/g;
    const inClass = [], participantRoutes = [], bad = [];
    for (const rel of files) {
      const src = _stripJsCommentsKeepLines(fs.readFileSync(pathMod.join(root, rel), "utf8"));
      REG.lastIndex = 0;
      let m;
      while ((m = REG.exec(src))) {
        let i = m.index + m[0].length, depth = 0, args = [], cur = "";
        while (i < src.length) {
          const c = src[i];
          if (c === "(" || c === "[" || c === "{") depth++;
          else if (c === ")" || c === "]" || c === "}") {
            if (c === ")" && depth === 0) { args.push(cur); break; }
            depth--;
          }
          if (c === "," && depth === 0) { args.push(cur); cur = ""; i++; continue; }
          cur += c; i++;
        }
        const chain = args.slice(0, -1);
        if (!chain.some(x => /\brequireParticipant\b/.test(x))) continue;
        const path = m[3];
        participantRoutes.push(path);
        const where = `${rel}:${src.slice(0, m.index).split("\n").length} ${m[1].toUpperCase()} ${path}`;
        const handler = args[args.length - 1].trim();
        if (!/^(async\s*)?\(\s*req\s*,\s*res\s*\)\s*=>/.test(handler)) {
          bad.push(`${where}: a participant route whose handler shape this scanner cannot read (expected \`(req, res) =>\`) — teach the scanner the shape, do not skip the route`);
          continue;
        }
        if (!/^async\b/.test(handler)) continue;         // no await possible: the guard's answer is current at the write
        const firstWrite = handler.search(/\.run\s*\(/);
        const before = (firstWrite < 0 ? handler : handler.slice(0, firstWrite))
          .split("\n").filter(l => !TESTHOOK.test(l)).join("\n");
        if (!/\bawait\b/.test(before)) continue;         // writes before it awaits
        inClass.push(path);
        if (EXEMPT[path]) continue;
        if (firstWrite < 0) {
          bad.push(`${where}: awaits, and its write is not visible here (a callee writes). Re-ask impersonatingHandDenied ` +
            `and participantSessionDenied before the callee, or add an EXEMPT entry saying why the guard's answer is ` +
            `still current when it writes`);
          continue;
        }
        const wants = BLOCKED.has(path) ? ["participantSessionDenied("] : ["impersonatingHandDenied(", "participantSessionDenied("];
        for (const want of wants) {
          const at = handler.indexOf(want);
          if (at < 0 || at > firstWrite) { bad.push(`${where}: awaits before its first write and never re-asks ${want} ahead of it`); continue; }
          const between = handler.slice(at, firstWrite).split("\n").filter(l => !TESTHOOK.test(l)).join("\n");
          const awaits = (between.replace(/\breturn\s+await\b/g, "return").match(/\bawait\b/g) || []).length;
          if (awaits) bad.push(`${where}: ${awaits} await(s) between ${want} and the first write — it must be atomic with the commit`);
        }
      }
    }
    // ANTI-VACUITY, three ways: the walk still finds the participant surface, the
    // class still holds the routes it was written for (and set-password, whose
    // exemption must stay a real one — blocked AND in the class), and every
    // EXEMPT entry still names a route that is in the class, or it is a stale
    // decision that reads as coverage.
    expect(participantRoutes.length, `the walk found only ${participantRoutes.length} participant write routes`).toBeGreaterThanOrEqual(12);
    for (const r of ["/api/tasks/:id/submit", "/api/competitions/:id/badge"]) {
      expect(inClass, `${r} is no longer recognised as awaiting before its write`).toContain(r);
    }
    for (const [r, why] of Object.entries(EXEMPT)) {
      expect(inClass, `EXEMPT names ${r}, which is no longer in the class — delete the stale entry`).toContain(r);
      expect(why.length, `the exemption for ${r} must say why`).toBeGreaterThan(40);
    }
    expect(bad,
      "these participant routes await before they write, so an impersonating admin revoked, or a session ended, " +
      "during the await still writes as the participant. Re-ask impersonatingHandDenied(req) (except on " +
      "_IMPERSONATION_BLOCKED routes) and participantSessionDenied(req) immediately before the write:\n    " + bad.join("\n    ")
    ).toEqual([]);
  });

  test("every session purge says why: a sign-in passes kickerContext(…), any other purge a SESSION_END reason", () => {
    // A purge with no context leaves the purged browser's next
    // /api/session/status poll with no `reason`, and its popup then tells
    // somebody who was working that they were signed out for INACTIVITY — false
    // after a block, a deny, a deletion, a role change or a password reset. Only
    // a few of those doors are driven behaviourally, and the purge added next is
    // the one that forgets, so the class is held here: every call outside the
    // definition passes a 4th argument that is `kickerContext(` (a sign-in
    // door: "Signed in elsewhere") or `SESSION_END.<key>` naming a key
    // lib/sessions.js defines. A `null`, an omitted argument or a hand-built
    // object fails.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const FN = "invalidate" + "OtherSessions";
    const sessionsSrc = _stripJsCommentsKeepLines(fs.readFileSync(pathMod.join(root, "lib", "sessions.js"), "utf8"));
    const endBlock = /const SESSION_END = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(sessionsSrc);
    expect(endBlock, "SESSION_END is no longer a frozen object literal in lib/sessions.js — teach this scanner its new shape").toBeTruthy();
    const KEYS = new Set([...endBlock[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map(m => m[1]));
    expect(KEYS.size, "SESSION_END lost its reasons").toBeGreaterThanOrEqual(1);

    /** Every call of the purge in `src`, with its top-level arguments (the definition skipped). */
    function callsIn(src) {
      const out = [];
      const re = new RegExp("\\b" + FN + "\\s*\\(", "g");
      let m;
      while ((m = re.exec(src))) {
        if (/\bfunction\s+$/.test(src.slice(Math.max(0, m.index - 30), m.index))) continue;
        const args = [];
        let depth = 0, cur = m.index + m[0].length;
        for (let i = cur - 1; i < src.length; i++) {
          const c = src[i];
          if ("([{".includes(c)) depth++;
          else if (")]}".includes(c)) { depth--; if (depth === 0) { args.push(src.slice(cur, i).trim()); break; } }
          else if (c === "," && depth === 1) { args.push(src.slice(cur, i).trim()); cur = i + 1; }
        }
        if (args.length && args[args.length - 1] === "") args.pop();   // a trailing comma
        out.push({ line: src.slice(0, m.index).split("\n").length, args });
      }
      return out;
    }
    function refusal(args) {
      const a = args[3];
      if (a === undefined) return "passes no context";
      if (/^kickerContext\s*\(/.test(a)) return null;
      const k = /^SESSION_END\.([A-Za-z_$][\w$]*)$/.exec(a);
      if (k) return KEYS.has(k[1]) ? null : `names SESSION_END.${k[1]}, which lib/sessions.js does not define`;
      return `passes \`${a.slice(0, 60)}\` — neither kickerContext(…) nor SESSION_END.<reason>`;
    }
    // PLANTED CONTROLS: the checker flags what it exists to flag, and passes both legitimate idioms.
    expect(callsIn(`${FN}("userId", id, null);`).map(c => refusal(c.args))).toEqual(["passes no context"]);
    expect(callsIn(`${FN}("userId", id, null, null);`).map(c => refusal(c.args))[0]).toMatch(/neither/);
    expect(callsIn(`${FN}("userId", id, null, SESSION_END.typo);`).map(c => refusal(c.args))[0]).toMatch(/does not define/);
    expect(callsIn(`x(${FN}("userId", f(a, b), req.sessionID, kickerContext(req, { email: "superadmin" })));`).map(c => refusal(c.args))).toEqual([null]);

    const files = ["server.js",
      ...fs.readdirSync(pathMod.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`),
      ...fs.readdirSync(pathMod.join(root, "lib")).filter(f => f.endsWith(".js")).map(f => `lib/${f}`)];
    const bad = [];
    let total = 0, signIns = 0, reasons = 0;
    for (const f of files) {
      const src = _stripJsCommentsKeepLines(fs.readFileSync(pathMod.join(root, f), "utf8"));
      for (const c of callsIn(src)) {
        total++;
        const why = refusal(c.args);
        if (why) { bad.push(`${f}:${c.line}: ${why}`); continue; }
        if (/^kickerContext/.test(c.args[3])) signIns++; else reasons++;
      }
    }
    expect(bad,
      "these purges record no reason, so the purged browser is told it was signed out for inactivity. Pass " +
      "kickerContext(req, user) from a sign-in door, else SESSION_END.<reason> (lib/sessions.js):\n    " + bad.join("\n    ")
    ).toEqual([]);
    // ANTI-VACUITY: the walk still finds the purges, of both kinds (asked after `bad`, whose message names the site).
    expect(total, `only ${total} purge calls found — renamed?`).toBeGreaterThanOrEqual(7);
    expect(signIns, "fewer than the two sign-in doors (break-glass password, emailed code) pass kickerContext(…)").toBeGreaterThanOrEqual(2);
    expect(reasons, "fewer purges pass a SESSION_END reason than the organiser doors and the reaper").toBeGreaterThanOrEqual(5);
  });

  test("v8.12.7 (F1): every admin write that awaits before it writes re-asks adminAuthzDenied at commit", () => {
    // THE CLASS, the admin-tier twin of the participant scanner above and wider
    // than the v8.12.6 parser-after-guard one: an admin route whose handler
    // AWAITS before its first durable write. `requireAdmin` / `requireSuperAdmin`
    // re-read the account when the request arrives, so anything awaited after
    // that — a bcrypt hash, a ZIP walk, a hashing pool — is a window in which a
    // colleague can block, demote or delete the admin, and the write still
    // lands. The v8.12.6 scanner found this class only where a body parser sits
    // after the guard; the desk shortcut and the maintenance seeder parse their
    // bodies globally and then await a hash, so they were outside it, and both
    // committed after the admin had been revoked (v8.12.7 F1, measured: a new
    // verified account created and its sign-in code handed back). Every route
    // in the class must call `adminAuthzDenied(` with NO await between it and
    // the first write — atomic with the commit on this synchronous
    // single-process driver.
    //
    // HOW A WRITE IS FOUND, and why the transaction bodies are blanked first: a
    // `.run(` written inside `const txn = db.transaction(() => { … })` does not
    // run where it is written, it runs where `txn()` is CALLED — so text order
    // and execution order differ, and reading the body as a write would place
    // the commit at the DEFINITION, ahead of an await that really precedes it.
    // Every `db.transaction(…)` body is therefore blanked, and a write is a
    // `.run(`, `runTxnWithMirrorBuffer(`, `record…Event(`, `db.exec(`,
    // `createTaskVersion(`, `issueCode(`, or an invocation of a name bound to a
    // transaction (`txn()`, `txn.immediate()`, …). The re-check is accepted in
    // either of two places: before that first write in the handler itself, or as
    // the first thing inside the transaction the first write runs, ahead of that
    // transaction's own first write — where it executes inside the same
    // synchronous commit, which is the strongest placement there is (the desk).
    //
    // THE TRANSACTION MAY BE UNNAMED (v8.12.7 review, L1): `runTxnWithMirrorBuffer(
    // db.transaction(() => { … }))`, or `db.transaction(…)()` / `….immediate()`
    // invoked in place, is judged exactly like a named one — its body's head is
    // the commit. The first draft only followed a NAME, so blanking an unnamed
    // body hid a correct check at its head and the scanner failed a correct
    // route — the kind of wrongness about working code that gets a scanner
    // deleted. A check after that body's first write is still refused.
    //
    // THE ANSWER MUST BE ACTED ON (L2): `adminAuthzDenied(req);` alone, or
    // `const d = adminAuthzDenied(req);` with nothing testing `d` before the
    // write, reads as the re-check and refuses nothing. The call must be an
    // `if (` condition, or bound to a name tested (`if (d`, `if (!d`, `d &&`,
    // `d ||`, `d ?`) within the next few lines and ahead of the write.
    //
    // A ROUTE RE-ASKS AT ITS GUARD'S TIER OR STRICTER (L3): `{tier:"superadmin"}`
    // behind requireSuperAdmin, `{tier:"global"}` (or "superadmin") behind
    // requireGlobalAdmin. A re-check at the default admin tier is a weaker
    // question than the guard's: a superadmin demoted to admin mid-hash would
    // commit a superadmin-only act, and an admin narrowed to event admin would
    // commit a global-admin one — granting the event-admin role, the
    // self-propagation bar requireGlobalAdmin exists for (v8.7.0). A tier the
    // scanner cannot read (not a string literal) fails.
    //
    // FAIL, NEVER SKIP: a handler this scanner cannot read, and an in-class route
    // whose write it cannot see (a callee writes), both fail unless EXEMPT says
    // why. The failure mode is always the route added later.
    //
    // STATED LIMITS, each a decision rather than an oversight:
    //   • a write inside a CALLEE is invisible — it fails, it is never skipped;
    //     a `.run(` inside a nested helper DEFINITION counts at the definition
    //     (measured: none of today's out-of-class async routes writes first that
    //     way — every first write is a real statement);
    //   • a route that writes, THEN awaits, then writes again is a DECIDED
    //     exclusion: its trailing writes are bookkeeping on an act already
    //     committed under a current answer (the group routes, assign,
    //     invitations, approve, deny, bulk-approve, remove-user, unlock,
    //     reset-password, the participant PUT);
    //   • the first write is the first by TEXT, so one on a branch that is not
    //     always taken can mask an await that precedes the write on the other
    //     path — measured on today's tree, the three routes whose first write is
    //     branch-local (the participant group chip's create-a-group, the
    //     invitation's newGroups, assign's group bind) await only after every
    //     write on either path;
    //   • an await inside a nested closure DEFINITION counts where it is written,
    //     which can only put a route INTO the class — the safe direction (the
    //     invitation's queued send closure is the one today, after its first write);
    //   • string literals are not stripped, so a write-shaped string could move
    //     the first write earlier;
    //   • GET routes are out of scope — they do not write.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const files = ["server.js",
      ...fs.readdirSync(pathMod.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`)];
    const ADMIN = /\brequire(?:Admin|SuperAdmin|GlobalAdmin)\b/;
    const TESTHOOK = /\btest[A-Z]\w*(?:Delay|Park)\s*\(|\b_test\w*DelayMs\b/;
    const REG = /\bapp\.(post|put|patch|delete)\s*\(\s*(["'])([^"']+)\2\s*,/g;
    const EXEMPT = {
      "/api/admin/test-email": "its only write after the await is the audit row recording a send that already happened " +
        "during the await; the send was the act, authorised by requireSuperAdmin at the headers, and refusing the " +
        "record would erase the evidence of a completed send",
      "/api/admin/smtp-settings/test": "the same shape as /api/admin/test-email: its only write after the await is " +
        "the audit row recording a test send that already happened during the await, through a relay that is NOT saved " +
        "(nothing is stored); the send was the act, authorised at the headers by requirePermission(\"ops.smtp\"), read " +
        "live, and refusing the record would erase the evidence of a completed send",
      "/api/admin/certificate-config/preview": "it writes NOTHING, before or after its await: it renders sample data " +
        "to a PNG and sends it (no badge, image, settings or audit row; tests/certificate-config.spec.js counts the " +
        "tables). The answer it serves is a picture of a design, decided at the headers by requireAdmin and scope",
      "/api/admin/competitions/:id/certificates/resend": "its writes happen in lib/certificate-dispatch.js: the ledger " +
        "claim runs synchronously before the callee's first await, and the send itself waits on a PDF render, after " +
        "which the callee runs the route's `recheck` (adminAuthzDenied(req)) synchronously and sends nothing on a refusal",
      "/api/admin/competitions/:id/certificates/reissue": "its certificate is written by routes/badge.js " +
        "_autoIssueCertificate, which awaits the render and then, inside its write transaction and before the INSERT, runs " +
        "the route's `reissue.recheck` (adminAuthzDenied at certificates.revoke, the superadmin tier) and writes nothing on " +
        "a refusal; the handler's own writes after it are the audit rows of a certificate already committed under that " +
        "answer (lock: the in-flight demotion arm of tests/certificate-dispatch.spec.js)",
      "/api/admin/competitions/:id/team-report/send": "nothing is awaited before the route's own adminAuthzDenied(req); " +
        "lib/team-reports.js runReport then builds the report and stores the lead owners synchronously, and what it awaits " +
        "is the sends of that one act, recorded as they finish. A revocation during a send stops nothing already authorised",
    };
    const BASE_WRITES = ["\\.run\\s*\\(", "\\brunTxnWithMirrorBuffer\\s*\\(", "\\brecord\\w*Event\\s*\\(",
      "\\bdb\\s*\\.\\s*exec\\s*\\(", "\\bcreateTaskVersion\\s*\\(", "\\bissueCode\\s*\\("];
    const INNER_WRITE = new RegExp(BASE_WRITES.filter(w => !/runTxnWithMirrorBuffer/.test(w)).join("|"));
    const closeParen = (s, open) => {              // s[open] === "(" → index of its matching ")"
      let d = 0;
      for (let k = open; k < s.length; k++) {
        if (s[k] === "(") d++;
        else if (s[k] === ")" && --d === 0) return k;
      }
      return -1;
    };
    const blankOut = (s) => s.replace(/[^\n]/g, " ");
    const esc = (n) => n.replace(/\$/g, "\\$");
    const awaitsIn = (s) => (s.split("\n").filter(l => !TESTHOOK.test(l)).join("\n")
      .replace(/\breturn\s+await\b/g, "return").match(/\bawait\b/g) || []).length;
    // THE TIERS, ranked by how narrow a role set each admits (lib/middleware.js
    // ADMIN_TIER_ROLES): superadmin ⊂ global ⊂ admin. A route must re-ask at its
    // guard's tier or a stricter one — at "superadmin" behind requireSuperAdmin,
    // at "global" (or stricter) behind requireGlobalAdmin — because a looser
    // re-check is a weaker question than the guard's: a superadmin demoted to
    // admin, or an admin narrowed to event admin, mid-await would still commit.
    const TIER_RANK = { admin: 0, global: 1, superadmin: 2 };
    const GUARD_OF = { global: "requireGlobalAdmin", superadmin: "requireSuperAdmin" };
    const tierAt = (text, at) => {                  // the tier the adminAuthzDenied( call at `at` asks; null = unreadable
      const open = text.indexOf("(", at), close = closeParen(text, open);
      const args = text.slice(open + 1, close < 0 ? text.length : close);
      if (!/\btier\b/.test(args)) return "admin";
      const t = args.match(/\btier\s*:\s*["'](\w+)["']/);
      return t && Object.prototype.hasOwnProperty.call(TIER_RANK, t[1]) ? t[1] : null;
    };
    // IS THE ANSWER ACTED ON? A call whose result is discarded refuses nothing,
    // and neither does one bound to a name nothing tests — both read as the
    // re-check and are not one. Accepted: the call inside an `if (` condition
    // still open at the call, or bound (`const d = …`, `d = …`) to a name that is
    // TESTED — `if (d`, `if (!d`, `d &&`, `d ||`, `d ?` — within the next few
    // lines and before the write. A use AFTER the write is not a test of it.
    const actedOn = (text, at, until) => {
      const seg = text.slice(0, at);
      const pre = seg.slice(Math.max(seg.lastIndexOf(";"), seg.lastIndexOf("{"), seg.lastIndexOf("}")) + 1);
      let lastIf = -1;
      for (const im of pre.matchAll(/\bif\s*\(/g)) lastIf = im.index + im[0].length - 1;
      if (lastIf >= 0) {
        let d = 0;
        for (const c of pre.slice(lastIf)) { if (c === "(") d++; else if (c === ")") d--; }
        if (d > 0) return true;
      }
      const bound = pre.match(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=\s*$/);
      if (!bound) return false;
      const close = closeParen(text, text.indexOf("(", at));
      if (close < 0 || close >= until) return false;
      const windowText = text.slice(close + 1, until).split("\n").slice(0, 5).join("\n");
      const n = esc(bound[1]);
      return new RegExp(`\\bif\\s*\\(\\s*!?\\s*${n}(?![\\w$])|(?<![\\w$.])${n}\\s*(?:&&|\\|\\||\\?(?![.?]))`).test(windowText);
    };
    // Judge every adminAuthzDenied( call ahead of `write` in `text`, nearest the
    // write first: the placement passes if ONE of them is acted on, at a tier at
    // least `want`, with nothing awaited between it and the write. Otherwise the
    // failure of the call nearest the write is the one reported.
    const judge = (text, write, want) => {
      const calls = [];
      for (let k = text.indexOf("adminAuthzDenied("); k >= 0 && k < write; k = text.indexOf("adminAuthzDenied(", k + 1)) calls.push(k);
      let why = null;
      for (const at of calls.reverse()) {
        const n = awaitsIn(text.slice(at, write)), tier = tierAt(text, at);
        const w = n ? `${n} await(s) between adminAuthzDenied and the first write — it must be atomic with the commit`
          : !actedOn(text, at, write) ? "re-asks adminAuthzDenied but never acts on its answer before the first write — " +
            "test it (`if (denied) …`), or it refuses nothing"
          : tier === null ? "re-asks adminAuthzDenied at a tier this scanner cannot read — spell it as a literal"
          : TIER_RANK[tier] < TIER_RANK[want] ? `guarded by ${GUARD_OF[want]} but re-asks adminAuthzDenied below the ${want} tier`
          : null;
        if (!w) return { ok: true, calls: calls.length };
        if (!why) why = w;
      }
      if (!calls.length && text.indexOf("adminAuthzDenied(", write) >= 0) {
        return { ok: false, calls: 1, why: "re-asks adminAuthzDenied only AFTER the first write — the write has already landed" };
      }
      return { ok: false, calls: calls.length, why };
    };

    const adminWriteRoutes = [], inClass = [], bad = [];
    for (const rel of files) {
      const src = _stripJsCommentsKeepLines(fs.readFileSync(pathMod.join(root, rel), "utf8"));
      REG.lastIndex = 0;
      let m;
      while ((m = REG.exec(src))) {
        // Top-level argument split, the F3 scanner's own walk (above).
        let i = m.index + m[0].length, depth = 0, args = [], cur = "";
        while (i < src.length) {
          const c = src[i];
          if (c === "(" || c === "[" || c === "{") depth++;
          else if (c === ")" || c === "]" || c === "}") {
            if (c === ")" && depth === 0) { args.push(cur); break; }
            depth--;
          }
          if (c === "," && depth === 0) { args.push(cur); cur = ""; i++; continue; }
          cur += c; i++;
        }
        const chain = args.slice(0, -1);            // the handler is the LAST argument, always
        if (!chain.some(x => ADMIN.test(x))) continue;
        const path = m[3];
        adminWriteRoutes.push(path);
        const where = `${rel}:${src.slice(0, m.index).split("\n").length} ${m[1].toUpperCase()} ${path}`;
        const handler = args[args.length - 1].trim();
        if (!/^(async\s*)?\(\s*req\s*,\s*res\s*\)\s*=>/.test(handler)) {
          bad.push(`${where}: an admin write route whose handler shape this scanner cannot read (expected \`(req, res) =>\`) — ` +
            `teach the scanner the shape, do not skip the route`);
          continue;
        }
        if (!/^async\b/.test(handler)) continue;     // no await possible: the guard's answer is current at the write

        // Blank every db.transaction(…) body, remembering each one: its name if it
        // is BOUND to one, where it starts, and whether it is invoked IN PLACE
        // (`db.transaction(fn)()`, `….immediate()`) — which makes the
        // `db.transaction` itself the write, and leaves any binding holding the
        // transaction's RESULT, not the transaction.
        let B = handler, unreadable = false;
        const txns = [];
        const TX = /\bdb\s*\.\s*transaction\s*\(/g;
        let t;
        while ((t = TX.exec(handler))) {
          const open = t.index + t[0].length - 1, close = closeParen(handler, open);
          if (close < 0) { unreadable = true; break; }
          const inPlace = /^\s*(?:\.\s*(?:immediate|deferred|exclusive)\s*)?\(/.test(handler.slice(close + 1));
          const nm = inPlace ? null : handler.slice(0, t.index).match(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*$/);
          txns.push({ name: nm ? nm[1] : null, start: t.index, open, close, inPlace, body: handler.slice(open + 1, close) });
          B = B.slice(0, open + 1) + blankOut(handler.slice(open + 1, close)) + B.slice(close);
        }
        if (unreadable) { bad.push(`${where}: a db.transaction( whose body this scanner cannot delimit`); continue; }
        // Only a transaction written at the handler's own level can be where the
        // handler writes; one inside another transaction's body runs inside it.
        const outer = txns.filter(x => !txns.some(y => y !== x && x.start > y.open && x.start < y.close));
        const named = outer.filter(x => x.name);
        const WRITE = new RegExp([...BASE_WRITES,
          ...named.map(x => `\\b${esc(x.name)}\\s*(?:\\.\\s*(?:immediate|deferred|exclusive)\\s*)?\\(`)].join("|"));
        const wm = WRITE.exec(B);
        const firstWrite = Math.min(...[wm ? wm.index : Infinity, ...outer.filter(x => x.inPlace).map(x => x.start)]);
        if (!awaitsIn(firstWrite === Infinity ? B : B.slice(0, firstWrite))) continue;   // writes before it awaits
        inClass.push(path);
        if (EXEMPT[path]) continue;
        if (firstWrite === Infinity) {
          bad.push(`${where}: awaits, and its write is not visible here (a callee writes). Re-ask adminAuthzDenied ` +
            `before the callee, or add an EXEMPT entry saying why the guard's answer is still current when it writes`);
          continue;
        }
        const want = chain.some(x => /\brequireSuperAdmin\b/.test(x)) ? "superadmin"
          : chain.some(x => /\brequireGlobalAdmin\b/.test(x)) ? "global" : "admin";
        // Placement 1 — in the handler, ahead of the first write, nothing awaited between.
        const p1 = judge(B, firstWrite, want);
        if (p1.ok) continue;
        // Placement 2 — the head of the transaction the first write runs: a NAMED
        // one the write's statement invokes, or an UNNAMED one written inside that
        // statement (`runTxnWithMirrorBuffer(db.transaction(() => { … }))`) or
        // invoked in place as the write itself. Its body is judged exactly as the
        // handler is — acted on, at the tier, ahead of the body's first write —
        // because a check at that head runs inside the same synchronous commit.
        const po = B.indexOf("(", firstWrite), pc = closeParen(B, po);
        const stmtEnd = pc < 0 ? B.length : pc + 1;
        const stmt = B.slice(firstWrite, stmtEnd);
        const tx = named.find(x => new RegExp(`\\b${esc(x.name)}\\b`).test(stmt)) ||
          outer.filter(x => !x.name && x.start >= firstWrite && x.start < stmtEnd).sort((a, b) => a.start - b.start)[0];
        let p2 = null;
        if (tx) {
          const iw = INNER_WRITE.exec(tx.body);
          p2 = judge(tx.body, iw ? iw.index : tx.body.length, want);
          if (p2.ok) continue;
        }
        const why = p1.calls ? p1.why : p2 && p2.calls ? p2.why : null;
        bad.push(why ? `${where}: ${why}` :
          `${where}: awaits before its first write and never re-asks adminAuthzDenied( ahead of it ` +
          `(or as the first act of the transaction that write runs)`);
      }
    }

    // ANTI-VACUITY, three ways: the walk still finds the admin write surface, the
    // class still holds the routes it was written for (and the ones the v8.12.6
    // scanner already covered, so the two locks keep agreeing), and every EXEMPT
    // entry still names a route in the class with a stated reason, or it is a
    // stale decision that reads as coverage.
    expect(adminWriteRoutes.length, `the walk found only ${adminWriteRoutes.length} admin write routes — did registration change shape?`)
      .toBeGreaterThanOrEqual(60);
    // (desk-invite, bulk-seed and the participant import no longer hash a password, so they await nothing
    // before their write; the import's re-check is held by the parser-after-guard scanner above)
    for (const r of [
      "/api/admin/import/tasks",
      "/api/admin/tasks/:id/attachments", "/api/admin/attachment-staging", "/api/admin/test-email"]) {
      expect(inClass, `${r} is no longer recognised as awaiting before its write`).toContain(r);
    }
    for (const [r, why] of Object.entries(EXEMPT)) {
      expect(inClass, `EXEMPT names ${r}, which is no longer in the class — delete the stale entry`).toContain(r);
      expect(why.length, `the exemption for ${r} must say why`).toBeGreaterThan(40);
    }
    expect(bad,
      "these admin routes await before they write, so an admin blocked, demoted or deleted during the await still " +
      "commits. Re-ask adminAuthzDenied(req) — at the superadmin tier behind requireSuperAdmin, at the global tier " +
      "behind requireGlobalAdmin — immediately before the write, act on its answer, and await nothing in between:\n    " +
      bad.join("\n    ")
    ).toEqual([]);
  });

  test("v8.3.11 (F10): the nanoid lockfile floor holds (GHSA-2v37-7h3g-55p8)", () => {
    // THE RUNTIME IS NOT AFFECTED, and saying so is the point of this comment:
    // nanoid arrives only as a postcss dependency, and postcss loads
    // `nanoid/non-secure`, whose bytes are identical either side of the bump.
    // So this lock does not guard a live vulnerability — it stops the advisory
    // being SILENTLY RE-INTRODUCED by a future dependency change that happens to
    // resolve nanoid backwards, which is the only way it could return unnoticed.
    const fs = require("fs"), pathMod = require("path");
    const lock = JSON.parse(fs.readFileSync(pathMod.join(__dirname, "..", "package-lock.json"), "utf8"));
    const entry = lock.packages && lock.packages["node_modules/nanoid"];

    // ANTI-VACUITY: a tree that drops nanoid entirely would leave every
    // assertion below reading `undefined` and passing in silence, which is the
    // failure mode this lock exists to prevent. If the key is gone, say so —
    // the answer may well be "delete this test", but that must be a DECISION
    // somebody takes rather than a gap nobody notices.
    expect(entry,
      "package-lock.json no longer carries node_modules/nanoid. If the dependency is genuinely gone " +
      "this test should be deleted deliberately; until then its absence means the floor is measuring " +
      "nothing.").toBeTruthy();

    // Real semver comparison, never a string compare: "3.3.9" > "3.3.18"
    // lexically, so a naive >= would read the vulnerable range as satisfied.
    const parse = (v) => String(v).split(".").map(Number);
    const cmp = (a, b) => {
      const [A, B] = [parse(a), parse(b)];
      for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
      return 0;
    };
    expect(cmp("3.3.9", "3.3.18"), "the comparator must be numeric, not lexical").toBeLessThan(0);

    expect(cmp(entry.version, "3.3.18"),
      `nanoid is pinned at ${entry.version}; GHSA-2v37-7h3g-55p8 needs >= 3.3.18. Run ` +
      "`npm audit fix` (or bump the postcss that pulls it in) and remember that a lockfile change " +
      "forces a CI-image rebuild + digest re-pin — see ci/README.md."
    ).toBeGreaterThanOrEqual(0);
  });

  test("the package.json security overrides hold, and the lockfile resolves above each floor", () => {
    // Each override is a security pin with its reason in CLAUDE.md (*Accepted
    // audit dispositions*, Operations and UI). Deleting one, or a lockfile that
    // resolves a package below its floor, would otherwise pass the whole suite.
    // When a parent ships the fix and a pin is deleted on purpose, change this
    // test in the same change: that is the decision being recorded.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const pkg = JSON.parse(fs.readFileSync(pathMod.join(root, "package.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(pathMod.join(root, "package-lock.json"), "utf8"));

    expect(pkg.overrides, "package.json overrides no longer match the recorded security pins").toEqual({
      debug: "^4.4.3",
      qs: "^6.17.1",
      nodemon: { chokidar: "^4.0.3", minimatch: "^11.0.3" },
    });

    const parse = (v) => String(v).split(".").map(Number);
    const cmp = (a, b) => {
      const [A, B] = [parse(a), parse(b)];
      for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
      return 0;
    };
    // Negative controls: a lexical compare would get both of these wrong.
    expect(cmp("6.16.1", "6.17.1"), "the comparator must be numeric").toBeLessThan(0);
    expect(cmp("4.4.10", "4.4.3"), "the comparator must be numeric, not lexical").toBeGreaterThan(0);

    const FLOORS = { debug: ["4.4.3", 4], qs: ["6.17.1", 6], chokidar: ["4.0.3", 4], minimatch: ["11.0.3", 11] };
    const seen = { debug: 0, qs: 0, chokidar: 0, minimatch: 0 };
    const bad = [];
    for (const [key, entry] of Object.entries(lock.packages || {})) {
      const name = key.split("node_modules/").pop();
      if (name === "braces") bad.push(`${key} is back: the chokidar ^4 override exists to drop it`);
      if (name === "picomatch" && parse(entry.version)[0] === 2) bad.push(`${key} resolves picomatch 2 (${entry.version})`);
      if (!FLOORS[name]) continue;
      seen[name]++;
      const [floor, major] = FLOORS[name];
      if (parse(entry.version)[0] !== major || cmp(entry.version, floor) < 0) {
        bad.push(`${key} resolves ${entry.version}; the pin needs ^${floor}`);
      }
    }
    for (const [name, n] of Object.entries(seen)) {
      expect(n,
        `package-lock.json no longer carries ${name}. If the dependency is genuinely gone, delete its pin ` +
        "and this arm deliberately; until then its absence means the floor measures nothing.").toBeGreaterThan(0);
    }
    expect(bad,
      "a pinned dependency resolves below its security floor (a lockfile change forces a CI-image rebuild " +
      "and digest re-pin: ci/README.md):\n    " + bad.join("\n    ")).toEqual([]);
  });

  test("v8.3.11 (F11): no shipped guidance claims the event type is immutable", () => {
    // THREE CLAIMS went stale and shipped as instructions: that the event TYPE
    // cannot be changed after creation (false since v8.3.0 — it is changeable
    // while the event is UPCOMING and has no sessions), that a live
    // competition's START TIME is flatly locked, and that a LIVE COMPETITION
    // cannot be deleted (both relaxed in v8.3.10 for a superadmin on an event
    // nobody has touched). An instruction that is not true is worse than no
    // instruction (v7.29.0's FROZEN_REMEDY rule) — a reader follows it and
    // concludes the platform cannot do a thing it does.
    //
    // THE SCANNER IS BUILT AROUND THE PREDICATE, NOT AROUND ONE NOUN: any
    // sentence asserting one of those three subjects is impossible, WITHOUT a
    // qualifier naming the condition under which it becomes possible. A literal
    // search for the exact wording that was fixed would pass the moment somebody
    // re-words it, which is how prose goes stale in the first place.
    //
    // Newlines become SPACES rather than being collapsed, so the ±120-character
    // window can span a wrapped Markdown paragraph or a folded YAML block while
    // offsets still line up with the raw file for the line number.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const guideDir = pathMod.join(root, "docs", "user-guide");
    const files = ["README.md", "swagger.yaml",
      ...fs.readdirSync(guideDir).filter(f => f.endsWith(".md")).map(f => `docs/user-guide/${f}`)];

    const IMPOSSIBLE = /\b(?:is|are|stays?|remains?)\s+(?:locked|immutable|fixed)\b|\bimmutable\b|\bcan(?:not|'t|’t|\s*not)\s+be\s+(?:changed|edited|deleted|removed)\b|\bmust be ended first\b/gi;
    const SUBJECT = /\bevent[ -]?(?:type|kind)\b|\bthe (?:type|kind)\b|\bstart[ -]?(?:time|date)\b|\ba live (?:event|competition|session)\b|\blive competitions?\b/i;
    // A qualifier is what turns a false absolute into a true conditional. Each
    // one names a real precondition the platform enforces: the event has begun,
    // it has sessions, somebody has acted in it, or the caller is not a
    // superadmin. "once it is CREATED" is deliberately NOT here — that was the
    // stale claim.
    const QUALIFIER = /until the event starts|until it starts|nobody has|while [^.]{0,40}sessions?\b|superadmin|once it is under way|has (?:already )?(?:started|finished)|v8\.3\.\d|unless\b|only while\b/i;

    const claims = [], unqualified = [];
    for (const rel of files) {
      const raw = fs.readFileSync(pathMod.join(root, rel), "utf8");
      const flat = raw.replace(/[\r\n]/g, " ");   // offset-preserving: one char for one char
      IMPOSSIBLE.lastIndex = 0;
      let m;
      while ((m = IMPOSSIBLE.exec(flat))) {
        const window = flat.slice(Math.max(0, m.index - 120), m.index + m[0].length + 120);
        if (!SUBJECT.test(window)) continue;      // an impossibility about something else entirely
        const where = `${rel}:${raw.slice(0, m.index).split("\n").length}`;
        claims.push(where);
        if (!QUALIFIER.test(window)) {
          unqualified.push(`${where}\n      …${window.replace(/\s+/g, " ").trim()}…`);
        }
      }
    }

    // ANTI-VACUITY: the vocabulary must still be finding the sentences that
    // legitimately state these limits WITH their conditions. If a doc rewrite
    // rephrases every one of them, this floor fires rather than the scan going
    // quietly blind. MEASURED against the pre-fix tree: 10 claims, 9 of them
    // unqualified; against the fixed tree the same 9 are excused by the
    // conditions the fix added.
    expect(claims.length,
      "the scan found almost no locked/immutable claims about the event type, start time or deleting a " +
      "live event — the wording has moved and this scanner is now looking for nothing")
      .toBeGreaterThanOrEqual(6);

    expect(unqualified,
      "shipped guidance states one of these is impossible without naming the condition that makes it " +
      "so. Since v8.3.0 the event TYPE can change while the event is upcoming and has no sessions, and " +
      "since v8.3.10 a superadmin can correct the START TIME of — or DELETE — a live event nobody has " +
      "touched. Add the qualifier rather than deleting the sentence:\n    " + unqualified.join("\n    ")
    ).toEqual([]);
  });



  // ══════════════════════════════════════════════════════════════════════════
  // v8.3.17 — A CLASS NAME MUST LAND IN A `class` ATTRIBUTE, AND ONLY ONE
  // ══════════════════════════════════════════════════════════════════════════
  //
  // 22 table cells across two admin renderers silently lost their row
  // de-emphasis, in two shapes that both parse without complaint:
  //
  //   <td class="cell-ts" class="${cd}">          — DUPLICATE class attribute.
  //       The HTML parser keeps the FIRST and drops the rest, so `${cd}` never
  //       applied. (14 cells.)
  //   <td style="white-space:normal;${cd}">       — a CLASS NAME inside `style`.
  //       An unknown declaration is dropped at parse time. (8 cells.)
  //
  // The mechanism is a mechanical conversion: before v7.23.2 `cd` held a CSS
  // DECLARATION (`opacity:.55;`) and interpolating it into `style=` was correct.
  // v7.23.2 changed it to a CLASS NAME — rightly, because opacity composites the
  // TEXT and this cue is about content the admin still has to read — and the
  // interpolation sites were not all moved with it.
  //
  // A source scanner rather than a rendered assertion, for a measured reason:
  // 10 of the 22 broken cells carry `.cell-ts`, which styles.css already mutes
  // unconditionally — so a naive "the cell is muted" test passes WITH the bug
  // present. Attribute placement is what actually went wrong, so that is what is
  // pinned.
  test("v8.3.17: no element carries two class attributes, and no class name hides in a style attribute", () => {
    const fs = require("fs"), pathMod = require("path");
    const ROOT = pathMod.join(__dirname, "..");
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(pathMod.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith(".js")) files.push(rel);
      }
    };
    walk("public/js");
    files.push("public/index.html");

    const dupes = [], styled = [];
    // Every class this codebase interpolates as a bare name into markup. A
    // FLOOR, not an exhaustive list: adding one here is the cost of adding a
    // conditional row class, and the duplicate-attribute half below needs no
    // list at all.
    const CLASSY = /\$\{\s*(cd|cellDim|rowOpacity|contentOpacity)\s*\}/;

    for (const rel of files) {
      const src = fs.readFileSync(pathMod.join(ROOT, rel), "utf8");
      src.split("\n").forEach((line, i) => {
        // Two `class=` inside ONE tag. Scan tag by tag so a line holding several
        // elements is not falsely joined.
        for (const tag of line.match(/<[a-zA-Z][^>]*>/g) || []) {
          if ((tag.match(/\bclass\s*=/g) || []).length > 1) dupes.push(`${rel}:${i + 1}  ${tag.slice(0, 120)}`);
        }
        // A known class name interpolated INSIDE a style attribute.
        for (const attr of line.match(/style\s*=\s*"[^"]*"/g) || []) {
          if (CLASSY.test(attr)) styled.push(`${rel}:${i + 1}  ${attr.slice(0, 120)}`);
        }
      });
    }

    expect(dupes,
      "an element with two `class` attributes silently DROPS every one after the first — merge them into a " +
      "single attribute:\n    " + dupes.join("\n    ")
    ).toEqual([]);
    expect(styled,
      "a CLASS NAME interpolated into a `style` attribute is parsed as a CSS declaration and dropped. Put it " +
      "in the element's `class` attribute:\n    " + styled.join("\n    ")
    ).toEqual([]);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // v8.3.24 — THE DOC-REGISTRY ARMS
  //
  // AUTH_PATHS.md, EMAIL_RULES.md and DEVELOPMENT.md carry the densest
  // behavioural prose in the tree and had NO mechanical guard, while the
  // user-facing docs have ~100. The measured consequence: three releases
  // running, a fix's own documentation in these files went stale one release
  // later, and v8.3.22's removal of the force-verify recovery bundle sat in
  // AUTH_PATHS §5 across the release that was named for correcting it.
  //
  // NOTHING IS INFERRED FROM PROSE — see tests/doc-registry.js for the two
  // designs that were prototyped, measured and REJECTED for flagging correct
  // prose. Each doc declares what it claims to enumerate in a
  // `<!-- DOC-REGISTRY -->` manifest, and only declared claims are checked.
  //
  // THE CLAIM THESE MAKE IS NARROW, and the messages say so: every site,
  // module, reason and symbol these docs DECLARE they enumerate is decided
  // about and still exists. Not "the docs are true" — about half of AUTH_PATHS
  // is rationale, threat models and deliberate historical narrative that no
  // scanner can reach, and EMAIL_RULES §6 explicitly warns a literal-minded
  // reader off its own absolute wording.
  const _REGISTRY_DOCS = ["AUTH_PATHS.md", "EMAIL_RULES.md", "DEVELOPMENT.md", "ROLES_AND_PERMISSIONS.md"];
  const _docReg = () => _REGISTRY_DOCS.map(d => require("./doc-registry").readRegistry(d));

  // v8.3.26 — THE SPAWNED-SERVER PORT REGISTRY IS A SHARED NAMESPACE ACROSS EVERY
  // WORKER, AND IT WAS HELD BY PROSE ALONE.
  //
  // Fourteen spec files spawn their own server at `PORT_BASE + <offset>`. Nothing
  // scopes those to a worker, so the offsets are global: two files picking the
  // same one collide the moment they land on different workers of the same run,
  // and the failure is an EADDRINUSE inside a spec — where a `waitForPort` that
  // is only a TCP connect reports success against the SURVIVING server and the
  // spec then tests a foreign process (v7.21.10). CLAUDE.md listed the offsets;
  // nothing checked them.
  //
  // Four properties, because each fails a different way:
  //   • UNIQUE      — the collision the registry exists to prevent.
  //   • >= 100      — below that an offset lands in the worker-SLOT range
  //                   (`PORT_BASE + 0..workers-1`), so a spawner would fight the
  //                   very server its own file is talking to.
  //   • < STRIDE    — `scripts/test-independence.cjs` gives each shard a window
  //                   of PORT_STRIDE; an offset past it puts shard N's spawner
  //                   inside shard N+k's window, which is how a 40-wide stride
  //                   let shard 0's `+120` become shard 3's worker slot 0.
  //   • REGISTERED  — `tests/global-setup.js` pre-flights these ports, and a
  //                   spawner it does not know about is one whose leak from an
  //                   interrupted run is invisible to the guard.
  // v8.3.27 — THE CLIENT CONFIRM-EXEMPT LIST MIRRORS ONE SERVER PREDICATE, AND
  // MUST NOT MIRROR THE OTHER.
  //
  // `_impersonationWriteExempt` (public/js/core/api.js) decides whether a
  // SUPERADMIN impersonation session is fronted with the are-you-sure confirm.
  // Its header has claimed since v7.14.0 that it is kept in sync with the server,
  // and it was not: `/api/deselect-competition` joined `impersonationWriteAllowed`
  // in v8.3.8 and never arrived here, so a superadmin met "this will change real
  // data" for pressing the Events nav item — a request that changes nothing, and
  // the kind of noise that trains an operator to click through the confirms that
  // do matter.
  //
  // BOTH DIRECTIONS ARE ASSERTED, and the second is the one a well-meaning reader
  // gets wrong: `impersonationReadOnlyWriteAllowed` (the certificate mint) must
  // NEVER be exempt. It writes a durable row and publishes a permanent public
  // page; "syncing the two lists" would delete the only confirm standing in front
  // of that. The two predicates mean different things, so they mirror
  // differently.
  // ── v8.4.0 — THE REGISTRATION MATRIX, HELD MECHANICALLY ────────────────────
  //
  // Three scanners over one class, because the failure mode here is the site
  // added LATER: a seventh configurable field, a second surface that decides what
  // a sign-up form asks for, or a competition SELECT that forgets the column. None
  // of those errors anywhere — each simply makes one surface quietly answer with
  // the kind's defaults for an event an admin has configured.
  test("v8.4.0: the register form declares a default for every configurable profile field, and it matches the server's", () => {
    const fs = require("fs"), path = require("path");
    const RF = require("../lib/registration-fields");
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

    // WHY THE MARKUP HAS TO DECLARE IT. `_applyRelaxedProfileFields` runs only
    // once a join link resolves, so the RESTING form — an ordinary sign-up, an
    // invitation, a cleared token — is served by the static markup alone. Before
    // v8.4.0 "required" could be INFERRED from "in neither relaxed set", which was
    // correct only because both relaxable fields happened to be required by
    // default; three of the six are optional now, so the inference would mark
    // Salutation, Phone and LinkedIn URL required for the majority of visitors.
    const groups = [...html.matchAll(/data-relax-field="([a-z_]+)"[^>]*data-relax-default="([a-z]+)"/g)]
      .map(m => ({ field: m[1], dflt: m[2] }));
    // ANTI-VACUITY: a renamed attribute would make the regex match nothing and
    // pass in silence, which is precisely the drift this exists to catch.
    expect(groups.length, "the register form still declares relaxable groups").toBeGreaterThanOrEqual(5);

    // Every PROFILE field the module configures must have a group. The password
    // is excluded by construction (`profileColumn: null`) — it is a credential,
    // rendered by `[data-password-group]` and a different function.
    const profileKeys = RF.REGISTRATION_FIELDS.filter(f => f.profileColumn).map(f => f.key).sort();
    expect(groups.map(g => g.field).sort(), "one group per configurable PROFILE field").toEqual(profileKeys);

    // …and each declared default must EQUAL the server's own LEGACY state for it.
    // Two hand-written copies of "what is this field when no policy applies" is a
    // mirror, so it is diffed rather than trusted: a markup default of `required`
    // against a server default of `optional` means the form demands a field the
    // completion gate never asks for, and the participant cannot register at all.
    for (const g of groups) {
      expect(g.dflt, `${g.field}: the markup default must match LEGACY_STATES`).toBe(RF.LEGACY_STATES[g.field]);
    }
    // The password pair and its heading travel together, or the form ships a
    // section header over nothing when a Booth Event does not offer one.
    expect(html.includes("data-password-section"), "the retired password section is gone").toBe(false);
  });

  test("the client's default sign-up map is LEGACY_STATES, field for field, and the template editor reads it", () => {
    // policyOrDefault fills a payload that carries no policy (stale, cached) from
    // this map, so a copy that disagrees with the server renders a form the
    // server never asks for, and a Save sends it: an edit form opened that way
    // made City and Job function required on the event. The template editor had
    // a third, hand-written copy of the same default.
    const fs = require("fs"), path = require("path");
    const RF = require("../lib/registration-fields");
    const fmt = fs.readFileSync(path.join(__dirname, "..", "public", "js", "ui", "format.js"), "utf8");
    const m = fmt.match(/export const DEFAULT_REGISTRATION_FIELDS = Object\.freeze\((\{[^}]*\})\)/);
    expect(m, "anti-vacuity: format.js declares DEFAULT_REGISTRATION_FIELDS as a literal").toBeTruthy();
    const client = JSON.parse(m[1].replace(/([a-z_]+)\s*:/g, '"$1":'));
    expect(client, "the client default must equal the server's LEGACY_STATES").toEqual({ ...RF.LEGACY_STATES });
    expect(/registration_fields:\s*DEFAULT_REGISTRATION_FIELDS\b/.test(fmt), "…and it is the default policy's map").toBe(true);
    const tpl = fs.readFileSync(path.join(__dirname, "..", "public", "js", "features", "templates-admin.js"), "utf8");
    expect(tpl.includes("DEFAULT_REGISTRATION_FIELDS[k]"), "the template editor's per-field default is the shared map").toBe(true);
    expect(/k\s*===\s*['"](?:city|job_function)['"]/.test(tpl), "no hand-written default is left in the template editor").toBe(false);
  });

  // The client-mirror arms. public/js cannot import lib/ or routes/, so each of
  // these is a hand-kept copy of a server value (CLAUDE.md, *Client/server mirror
  // registry*). A copy changed on one side only goes unnoticed until someone meets
  // the mismatch: a resend button that does nothing, a field the save refuses, a
  // persona with no report. Each arm parses BOTH sources statically (lib/login-code
  // and the route modules open the database at require time) and first asserts
  // that its parse found something, so a renamed constant fails rather than
  // comparing two empty lists.
  test("client mirrors: the resend delay, report personas, template sign-up fields and the desk approval reason match the server", () => {
    const fs = require("fs"), path = require("path");
    // Comments stripped first: a commented-out older `const X = …` above the live
    // one must not be the value compared.
    const { stripJsComments } = require("./doc-registry");
    const read = (...p) => stripJsComments(fs.readFileSync(path.join(__dirname, "..", ...p), "utf8"));
    expect(stripJsComments("// const RESEND_AFTER_MS = 1;\nconst RESEND_AFTER_MS = 2;").match(/const RESEND_AFTER_MS\s*=\s*([\d_]+)\s*;/)[1],
      "CONTROL: a commented-out constant is not the one read").toBe("2");
    const num = (s) => Number(String(s).replace(/_/g, ""));

    // (a) The code step's "Send a new code" delay: a sooner button would ask for a
    // code the server's re-send suppression refuses.
    const cRes = read("public", "js", "features", "auth.js").match(/const RESEND_AFTER_MS\s*=\s*([\d_]+)\s*;/);
    const sRes = read("lib", "login-code.js").match(/const LOGIN_CODE_RESEND_MIN_MS\s*=\s*([\d_]+)\s*;/);
    expect(cRes, "anti-vacuity: auth.js declares RESEND_AFTER_MS as a literal").toBeTruthy();
    expect(sRes, "anti-vacuity: lib/login-code.js declares LOGIN_CODE_RESEND_MIN_MS as a literal").toBeTruthy();
    expect(num(sRes[1])).toBeGreaterThan(0);
    expect(num(cRes[1]), "the client's resend delay is the server's suppression window").toBe(num(sRes[1]));

    // (b) The event team's personas, in order: a persona only one side knows gets
    // no section, or a section the routes refuse.
    const cPerBlock = read("public", "js", "features", "event-team.js").match(/const PERSONAS = \[([\s\S]*?)\];/);
    const sPer = read("routes", "event-team.js").match(/const PERSONAS = (\[[^\]]*\]);/);
    expect(cPerBlock, "anti-vacuity: event-team.js declares PERSONAS").toBeTruthy();
    expect(sPer, "anti-vacuity: routes/event-team.js declares PERSONAS").toBeTruthy();
    const cPer = [...cPerBlock[1].matchAll(/id:\s*'(\w+)'/g)].map(m => m[1]);
    const sPerIds = JSON.parse(sPer[1]);
    expect(sPerIds.length, "anti-vacuity: the server lists personas").toBeGreaterThan(0);
    expect(cPer, "the client's personas are the server's, in order").toEqual(sPerIds);

    // (c) The template editor's sign-up fields: a field missing here cannot be set
    // on a template, one extra is refused by the save.
    const RF = require("../lib/registration-fields");
    const tplBlock = read("public", "js", "features", "templates-admin.js").match(/const REG_FIELDS = \[([\s\S]*?)\];/);
    expect(tplBlock, "anti-vacuity: templates-admin.js declares REG_FIELDS").toBeTruthy();
    const tplKeys = [...tplBlock[1].matchAll(/\['(\w+)',/g)].map(m => m[1]);
    expect(tplKeys.length, "anti-vacuity: REG_FIELDS lists fields").toBeGreaterThan(0);
    expect(tplKeys, "the template editor's fields are REGISTRATION_FIELDS, in order").toEqual(RF.REGISTRATION_FIELDS.map(f => f.key));

    // (d) The desk's approval reason: the menu note and the route's refusal say the
    // same sentence, so the organiser is not told two different things.
    const cDesk = read("public", "js", "ui", "nav.js").match(/export const DESK_APPROVAL_REASON\s*=\s*'([^']+)';/);
    const sDesk = read("routes", "participants.js").match(/const DESK_APPROVAL_REQUIRED\s*=\s*"([^"]+)";/);
    expect(cDesk, "anti-vacuity: nav.js declares DESK_APPROVAL_REASON").toBeTruthy();
    expect(sDesk, "anti-vacuity: routes/participants.js declares DESK_APPROVAL_REQUIRED").toBeTruthy();
    expect(cDesk[1], "the desk approval note is the route's refusal, word for word").toBe(sDesk[1]);
  });

  test("client mirrors: the certificate designer's field limits are lib/certificate-config.js's maxes", () => {
    // A designer maxlength above the server's max lets an organiser type wording
    // the save then refuses (`certificate_config_invalid`); below it, wording the
    // server accepts cannot be typed.
    const fs = require("fs"), path = require("path");
    const CC = require("../lib/certificate-config");
    const wiz = require("./doc-registry").stripJsComments(fs.readFileSync(path.join(__dirname, "..", "public", "js", "features", "certificate-wizard.js"), "utf8"));
    const lib = fs.readFileSync(path.join(__dirname, "..", "lib", "certificate-config.js"), "utf8");
    const maxesIn = (name) => {
      const block = lib.match(new RegExp(`const ${name} = Object\\.freeze\\(\\{([\\s\\S]*?)\\n\\}\\);`));
      expect(block, `anti-vacuity: lib/certificate-config.js declares ${name}`).toBeTruthy();
      const out = Object.fromEntries([...block[1].matchAll(/(\w+):\s*\{\s*max:\s*(\d+)/g)].map(m => [m[1], Number(m[2])]));
      expect(Object.keys(out).length, `anti-vacuity: ${name} lists fields`).toBeGreaterThan(0);
      return out;
    };

    // Wording fields: same keys both ways, same max.
    const tf = wiz.match(/const TEXT_FIELDS = \[([\s\S]*?)\];/);
    expect(tf, "anti-vacuity: the wizard declares TEXT_FIELDS").toBeTruthy();
    const wizText = Object.fromEntries([...tf[1].matchAll(/\['(\w+)',\s*'[^']*',\s*(\d+)\]/g)].map(m => [m[1], Number(m[2])]));
    expect(Object.keys(wizText).length, "anti-vacuity: the wizard lists wording fields").toBeGreaterThan(0);
    expect(wizText, "the wizard's wording limits are TEXT_FIELDS' maxes, key for key")
      .toEqual(Object.fromEntries(Object.entries(CC.TEXT_FIELDS).map(([k, f]) => [k, f.max])));

    // Medal wording: the headline and small-line inputs.
    const labels = maxesIn("LABEL_FIELDS");
    for (const k of Object.keys(labels)) {
      const m = wiz.match(new RegExp(`maxlength="(\\d+)" data-sec="labels" data-key="\\$\\{t\\.id\\}" data-sub="${k}"`));
      expect(m, `the wizard has a ${k} input`).toBeTruthy();
      expect(Number(m[1]), `labels.${k}: the wizard's maxlength is the server's max`).toBe(labels[k]);
    }

    // The congratulations email: every text field the server takes has an input
    // here at the server's max (the per-tier thank-yous share one area() call).
    const email = maxesIn("EMAIL_TEXT_FIELDS");
    const em = wiz.match(/const EMAIL_MESSAGE_FIELDS = \[([\s\S]*?)\];/);
    expect(em, "anti-vacuity: the wizard declares EMAIL_MESSAGE_FIELDS").toBeTruthy();
    const msgKeys = [...em[1].matchAll(/\['(\w+)',/g)].map(m => m[1]);
    const msgMax = wiz.match(/EMAIL_MESSAGE_FIELDS\.map\(\(\[k, label\]\) => area\(k, esc\(label\), \d+, (\d+)\)\)/);
    expect(msgMax, "anti-vacuity: the thank-you areas are drawn by one area() call").toBeTruthy();
    const wizEmail = Object.fromEntries(msgKeys.map(k => [k, Number(msgMax[1])]));
    for (const m of wiz.matchAll(/area\('(\w+)',\s*'[^']*',\s*\d+,\s*(\d+)\)/g)) wizEmail[m[1]] = Number(m[2]);
    for (const m of wiz.matchAll(/maxlength="(\d+)" data-sec="email" data-key="(\w+)"/g)) wizEmail[m[2]] = Number(m[1]);
    expect(wizEmail, "the wizard's email limits are EMAIL_TEXT_FIELDS' maxes, key for key").toEqual(email);
  });

  test("v8.4.0: nothing outside lib/registration-fields.js decides which kinds configure the sign-up form", () => {
    const fs = require("fs"), path = require("path");
    const DR = require("./doc-registry");
    // The v7.29.0 rule, one field over: a kind-derived rule re-written at a
    // consumer is correct on the day it is written and silently divergent
    // afterwards. `CONFIGURABLE_KINDS` is the one definition, so a server file
    // asking `event_kind === "booth"` about the registration form is the second
    // copy — and it is the one an admin's per-event configuration would disagree
    // with first.
    const roots = ["lib", "routes"];
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".js")) files.push(full);
      }
    };
    for (const r of roots) walk(path.join(__dirname, "..", r));
    files.push(path.join(__dirname, "..", "server.js"));

    const offenders = [];
    for (const f of files) {
      const rel = path.relative(path.join(__dirname, ".."), f);
      // The module that OWNS the decision is the one place it may be written.
      if (rel === path.join("lib", "registration-fields.js")) continue;
      // Comments are stripped FIRST: the prose explaining this rule quotes the
      // pattern it forbids, so an unstripped scan reports a clean tree as dirty
      // (or, worse, is quietly reworded until it passes).
      const src = DR.stripJsComments(fs.readFileSync(f, "utf8"));
      const lines = src.split("\n");
      lines.forEach((ln, i) => {
        if (!/registration_field|registrationField|linkedin_signup/.test(ln)) return;
        if (/["']booth["']/.test(ln)) offenders.push(`${rel}:${i + 1}: ${ln.trim().slice(0, 120)}`);
      });
    }
    expect(offenders, "ask CONFIGURABLE_KINDS / registrationFieldStates, never the stored value").toEqual([]);
  });

  test("v8.6.0: nothing outside lib/late-entry.js decides which kinds run a late window", () => {
    const fs = require("fs"), path = require("path");
    const DR = require("./doc-registry");
    // The v8.4.0 rule one feature over, and the same reason: a kind-derived rule
    // re-written at a consumer is correct on the day it is written and silently
    // divergent afterwards. `eventPolicy(row).lateEntry` is the one definition, so
    // a file asking `event_kind === "booth"` about the window is the second copy.
    //
    // lib/event-policy.js is exempt because it OWNS the table the values live in;
    // lib/late-entry.js is exempt because it is the module that reads it.
    const roots = ["lib", "routes"];
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".js")) files.push(full);
      }
    };
    for (const r of roots) walk(path.join(__dirname, "..", r));
    files.push(path.join(__dirname, "..", "server.js"));

    const offenders = [];
    let mentions = 0;
    for (const f of files) {
      const rel = path.relative(path.join(__dirname, ".."), f);
      if (rel === path.join("lib", "late-entry.js") || rel === path.join("lib", "event-policy.js")) continue;
      // Comments FIRST: the prose explaining this rule quotes the pattern it
      // forbids, so an unstripped scan reports a clean tree as dirty.
      const src = DR.stripJsComments(fs.readFileSync(f, "utf8"));
      src.split("\n").forEach((ln, i) => {
        if (!/late_entry|lateEntry/.test(ln)) return;
        mentions++;
        if (/["']booth["']/.test(ln)) offenders.push(`${rel}:${i + 1}: ${ln.trim().slice(0, 120)}`);
      });
    }
    expect(offenders, "ask eventPolicy(row).lateEntry, never the stored value").toEqual([]);
    // ANTI-VACUITY. Rename the columns and the regex matches nothing and passes in
    // silence — which is precisely the drift it exists to catch.
    expect(mentions, "the scanner must actually be looking at late-entry code").toBeGreaterThan(15);
  });

  test("v8.12.8: the late-entry-forbidden sentence has ONE definition, read by every refusal", () => {
    const fs = require("fs"), path = require("path");
    const DR = require("./doc-registry");
    // The create refusal, the PUT refusal and the close refusal all tell an admin
    // that a kind runs no late-entry window. Two hand-written copies existed,
    // byte-identical on the day they were written; five copies of one sentence is
    // how FROZEN_REMEDY happened (v7.29.0). `lateEntryForbiddenMessage`
    // (lib/late-entry.js) is the one definition, and this holds it there: the
    // sentence's distinctive clause may appear exactly ONCE across lib/, routes/
    // and server.js, comments stripped first (the note explaining this rule quotes
    // the sentence it forbids).
    const root = path.join(__dirname, "..");
    const files = [path.join(root, "server.js")];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".js")) files.push(full);
      }
    };
    for (const r of ["lib", "routes"]) walk(path.join(root, r));
    const CLAUSE = "only a Booth Event stays open for a walk-up";
    const sites = [];
    let calls = 0;
    for (const f of files) {
      const src = DR.stripJsComments(fs.readFileSync(f, "utf8"));
      const rel = path.relative(root, f);
      src.split("\n").forEach((ln, i) => { if (ln.includes(CLAUSE)) sites.push(`${rel}:${i + 1}`); });
      calls += (src.match(/lateEntryForbiddenMessage\(/g) || []).length;
    }
    expect(sites, "the sentence is spelled once, in lib/late-entry.js").toEqual([expect.stringMatching(/^lib[\\/]late-entry\.js:/)]);
    // ANTI-VACUITY: the definition plus the three refusals that read it. A rename
    // would empty the count and pass the single-site check in silence.
    expect(calls, "lateEntryForbiddenMessage( — the definition and its three callers").toBeGreaterThanOrEqual(4);
  });

  test("v8.12.8: no shipped guidance names the retired close-early remedy", () => {
    const fs = require("fs"), path = require("path");
    const DR = require("./doc-registry");
    // Until v8.12.8 the only way to close a Booth Event's late-entry window early
    // was a superadmin editing the ended event and setting its deadline "to now" —
    // to the minute, and refused outright for a minute after End Now (v8.12.7 F3).
    // Every organiser now has Close late entries now, to the second. The old
    // remedy survived in four documents after the control shipped (the v8.12.8
    // pre-release review), which is the FROZEN_REMEDY class: guidance naming a
    // door the reader cannot use, or no longer needs. docs/release-notes.md is
    // deliberately NOT scanned — its entries are dated history.
    const root = path.join(__dirname, "..");
    // Each pattern was proved red against the sentence it retires, in the file
    // that carried it: README / admin / superadmin at f76fd086 (plain and bold
    // "late-entry deadline to now"), swagger at f76fd086 (the field spelled
    // `late_entry_deadline_at`, and "set it to now" twice) and ROLES at 6813cc5c
    // ("which is why it is the remedy the refusal names"). The first draft of
    // this arm matched only the README wording, so it read as guarding swagger
    // and ROLES while being blind to how either had written it (review 2).
    const FORBIDDEN = [
      // "set the late-entry deadline to now", bold or not, or the field name
      /late[-_ ]entry[-_ ]?(?:\*\*)?\s*deadline(?:_at)?(?:\*\*)?`?\s+(?:below\s+)?to now/i,
      // swagger's "(set it to now to close the door early)" / "setting it to now"
      /\bset(?:ting|s)?\s+(?:it|the deadline|its deadline|that deadline)\s+to now\b/i,
      // ROLES: "The deadline reclassifies nobody, which is why it is the remedy …"
      /\bdeadline\b[^.]{0,120}\bwhy it is the remedy\b/i,
      /closing the window early[^.]{0,80}superadmin'?s job/i,       // "closing it early … is a superadmin's job"
    ];
    const prose = ["README.md", "swagger.yaml", "ROLES_AND_PERMISSIONS.md", "AUTH_PATHS.md", "EMAIL_RULES.md",
      ...fs.readdirSync(path.join(root, "docs", "user-guide")).filter(f => f.endsWith(".md")).map(f => path.join("docs", "user-guide", f))];
    const code = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".js")) code.push(full);
      }
    };
    for (const r of ["lib", "routes", path.join("public", "js")]) walk(path.join(root, r));
    const bad = [];
    for (const rel of prose) {
      // Paragraph-joined, so a phrase wrapped across lines still matches.
      const text = fs.readFileSync(path.join(root, rel), "utf8").replace(/\n(?!\n)\s*/g, " ");
      for (const re of FORBIDDEN) { const m = text.match(re); if (m) bad.push(`${rel}: …${m[0]}…`); }
    }
    for (const f of code) {
      // Comments FIRST: a note recording the retired remedy is history, not copy.
      const text = DR.stripJsComments(fs.readFileSync(f, "utf8")).replace(/\n\s*/g, " ");
      for (const re of FORBIDDEN) { const m = text.match(re); if (m) bad.push(`${path.relative(root, f)}: …${m[0]}…`); }
    }
    expect(bad, "name Close late entries now (every organiser's, to the second), not the superadmin deadline edit").toEqual([]);
    // ANTI-VACUITY: the documents must still NAME the control that replaced the
    // remedy — a scanner over files that no longer discuss late entries passes
    // in silence.
    const named = prose.filter(rel => /Close late entries now/.test(fs.readFileSync(path.join(root, rel), "utf8")));
    expect(named.length, `documents naming the control: ${named.join(", ")}`).toBeGreaterThanOrEqual(4);
  });

  test("v8.12.8: every registered_via value the code writes or tests is in swagger's registered_via enums", () => {
    const fs = require("fs"), path = require("path");
    const DR = require("./doc-registry");
    // `registered_via` exempts nothing from the completion gate (it asks every
    // account alike), but the unverified-account reaper deletes `manual` accounts
    // only, and the export writes the value verbatim while the import reads it
    // back verbatim — so an operator editing a file needs the complete
    // vocabulary. The swagger
    // enums had said [manual, linkedin] while the desk shortcut wrote `desk`
    // (the v8.12.8 pre-release review). The values are EXTRACTED from the code
    // rather than restated here, from BOTH sides:
    //   * READ — the comparisons and SQL predicates (`registered_via === "x"`);
    //   * WRITE — the value each `INSERT INTO users` / `UPDATE users SET` puts in
    //     the column (a VALUES literal, or the literals in the bound argument at
    //     that placeholder's position), plus the column DEFAULT in db.js.
    // The first draft read only comparisons, so a door WRITING a new value with no
    // comparison anywhere — the docs#15 shape exactly — left it green (review 2,
    // proved with the desk literal changed to 'kiosk'). A write it cannot read is
    // reported, never skipped.
    const root = path.join(__dirname, "..");
    const files = [path.join(root, "server.js"), path.join(root, "db.js")];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".js")) files.push(full);
      }
    };
    for (const r of ["lib", "routes"]) walk(path.join(root, r));
    // The index just past the bracket that closes the one at `open`, skipping
    // string and template literals.
    const closeOf = (src, open) => {
      let depth = 0, q = null;
      for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (q) { if (c === "\\") { i++; continue; } if (c === q) q = null; continue; }
        if (c === "'" || c === '"' || c === "`") { q = c; continue; }
        if (c === "(") depth++;
        else if (c === ")") { depth--; if (depth === 0) return i; }
      }
      return -1;
    };
    const splitTop = (body) => {
      const out = []; let depth = 0, q = null, cur = "";
      for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (q) { cur += c; if (c === "\\") { cur += body[++i] || ""; continue; } if (c === q) q = null; continue; }
        if (c === "'" || c === '"' || c === "`") { q = c; cur += c; continue; }
        if (c === "(" || c === "[" || c === "{") depth++;
        if (c === ")" || c === "]" || c === "}") depth--;
        if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
        cur += c;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    };
    const literals = (t) => [...t.matchAll(/["']([a-z_]+)["']/g)].map(m => m[1]);
    const qCount = (t) => (t.match(/\?/g) || []).length;
    const read = new Set(), written = new Set(), unreadable = [];
    let writeSites = 0;
    // The `.run(` that binds a prepared statement is the first one after it.
    const bindAt = (src, from, idx, site) => {
      const r = src.indexOf(".run(", from);
      const rc = r < 0 ? -1 : closeOf(src, r + 4);
      if (rc < 0) { unreadable.push(`${site}: no .run( after it`); return; }
      const args = splitTop(src.slice(r + 5, rc));
      if (idx >= args.length || args.some(a => a.startsWith("..."))) { unreadable.push(`${site}: bind ${idx} of ${args.length}`); return; }
      const lits = literals(args[idx]);
      if (!lits.length) { unreadable.push(`${site}: bound value carries no literal (${args[idx].slice(0, 60)})`); return; }
      lits.forEach(v => written.add(v));
    };
    for (const f of files) {
      const src = DR.stripJsComments(fs.readFileSync(f, "utf8"));
      const rel = path.relative(root, f);
      for (const m of src.matchAll(/registered_via\s*(?:===|!==|==|=|<>)\s*["']([a-z_]+)["']/g)) read.add(m[1]);
      for (const m of src.matchAll(/registered_via\s+TEXT\s+DEFAULT\s+'([a-z_]+)'/g)) written.add(m[1]);
      for (const m of src.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+users\s*\(([^)]*)\)\s*VALUES\s*\(/g)) {
        const cols = m[1].split(",").map(c => c.trim());
        const idx = cols.indexOf("registered_via");
        if (idx < 0) continue;
        writeSites++;
        const site = `${rel}:${src.slice(0, m.index).split("\n").length}`;
        const open = m.index + m[0].length - 1, close = closeOf(src, open);
        const vals = close < 0 ? [] : splitTop(src.slice(open + 1, close));
        if (vals.length !== cols.length) { unreadable.push(`${site}: ${cols.length} columns, ${vals.length} values`); continue; }
        const v = vals[idx];
        if (/^'[a-z_]+'$/.test(v)) { written.add(v.slice(1, -1)); continue; }
        if (v !== "?") { unreadable.push(`${site}: VALUES holds ${v}`); continue; }
        bindAt(src, close, vals.slice(0, idx).reduce((n, t) => n + qCount(t), 0), site);
      }
      for (const m of src.matchAll(/UPDATE\s+users\s+SET\s+([\s\S]*?)\bWHERE\b/g)) {
        const at = m[1].search(/\bregistered_via\s*=/);
        if (at < 0) continue;
        writeSites++;
        const site = `${rel}:${src.slice(0, m.index).split("\n").length}`;
        const rhs = m[1].slice(at).match(/^registered_via\s*=\s*('[a-z_]+'|\?)/);
        if (!rhs) { unreadable.push(`${site}: SET registered_via to something unreadable`); continue; }
        if (rhs[1] !== "?") { written.add(rhs[1].slice(1, -1)); continue; }
        bindAt(src, m.index + m[0].length, qCount(m[1].slice(0, at)), site);
      }
    }
    expect(unreadable, "a write to users.registered_via this scanner cannot read must be taught, not skipped").toEqual([]);
    // ANTI-VACUITY: manual and desk on BOTH sides, from at least three write
    // sites (the desk INSERT, the import's INSERT and overwrite; no code path
    // writes `linkedin` any more, though legacy rows still carry it). A rename of the column would empty both sets and pass every
    // membership check below in silence.
    expect(writeSites, "statements that write users.registered_via").toBeGreaterThanOrEqual(3);
    expect([...read].sort(), "values the code compares registered_via against").toEqual(expect.arrayContaining(["desk", "manual"]));
    const values = new Set([...read, ...written]);
    const yaml = fs.readFileSync(path.join(root, "swagger.yaml"), "utf8").split("\n");
    const indentOf = (ln) => ln.match(/^\s*/)[0].length;
    const enumVals = (t) => t.split(",").map(v => v.trim().replace(/^(["'])(.*)\1$/, "$2"));
    const enums = [];
    yaml.forEach((ln, i) => {
      if (!/^\s*registered_via:/.test(ln)) return;
      const inline = ln.match(/enum:\s*\[([^\]]*)\]/);
      if (inline) { enums.push({ line: i + 1, vals: enumVals(inline[1]) }); return; }
      // Block form: the `enum:` belongs to registered_via only while the lines stay
      // DEEPER than its own key — the next sibling property ends the look-ahead, or
      // a neighbour's enum would be blamed on this one (review 2).
      for (let j = i + 1; j < yaml.length && j < i + 12; j++) {
        if (!yaml[j].trim()) continue;
        if (indentOf(yaml[j]) <= indentOf(ln)) break;
        const m = yaml[j].match(/^\s*enum:\s*\[([^\]]*)\]/);
        if (m) { enums.push({ line: i + 1, vals: enumVals(m[1]) }); break; }
      }
    });
    expect(enums.length, "swagger declares registered_via with an enum at least twice (the participant row and the export row)").toBeGreaterThanOrEqual(2);
    const missing = [];
    for (const e of enums) for (const v of values) if (!e.vals.includes(v)) missing.push(`swagger.yaml:${e.line} lacks ${v}`);
    expect(missing, "every value the code writes or tests must be documented").toEqual([]);
    // After the membership check, so a REPLACED value is reported as the value
    // swagger lacks rather than as a missing old one.
    expect([...written].sort(), "values the code writes to registered_via").toEqual(expect.arrayContaining(["desk", "manual"]));
  });

  test("v8.6.0: BOTH badge canvases carry the late-entrant marker, from ONE declaration", () => {
    const fs = require("fs"), path = require("path");
    const DR = require("./doc-registry");
    // `buildBadgeSvg` (the share PNG) and `buildCertificateSvg` (the printed PDF)
    // are byte-for-byte duplicates of the headline/sub label decision with nothing
    // holding them together, and the failure is silent and ASYMMETRIC: change one
    // and the picture says "late entrant" while the paper does not, or the reverse.
    // A certificate is required to say so explicitly, so the two must not be able
    // to disagree — hence one declaration and this lock over both push sites.
    const src = DR.stripJsComments(fs.readFileSync(path.join(__dirname, "..", "lib", "badge.js"), "utf8"));
    expect(src.match(/LATE_ENTRY_STAT\s*=/g) || [], "the stat column is declared exactly once").toHaveLength(1);
    const pushes = src.match(/if\s*\(\s*o\.lateEntrant\s*\)\s*cols\.push\(\s*\{\s*\.\.\.LATE_ENTRY_STAT\s*\}\s*\)/g) || [];
    expect(pushes, "both canvases push it — the PNG and the certificate PDF").toHaveLength(2);
    // The VALUE is asserted here rather than only in a render test, because it is
    // the words a third party reads off the paper.
    expect(src).toContain('value: "LATE ENTRANT"');
  });

  test("v8.6.0: the client's 48-hour display span mirrors lib/late-entry.js", () => {
    const fs = require("fs"), path = require("path");
    const DR = require("./doc-registry");
    // public/js is a browser-only ESM graph and cannot import lib/, so the create
    // form's "Automatic" preview carries an irreducible COPY of the default span.
    // It is DISPLAY ONLY — ticking Automatic sends NULL and the SERVER derives the
    // stored answer — so a drift here shows a wrong preview rather than storing a
    // wrong deadline. That is exactly why it needs a lock: the failure is invisible.
    const server = DR.stripJsComments(fs.readFileSync(path.join(__dirname, "..", "lib", "late-entry.js"), "utf8"));
    const client = DR.stripJsComments(fs.readFileSync(path.join(__dirname, "..", "public", "js", "features", "competitions-admin.js"), "utf8"));
    const sm = server.match(/LATE_ENTRY_DEFAULT_SPAN_MS\s*=\s*([^;]+);/);
    const cm = client.match(/LATE_ENTRY_AUTO_SPAN_MS\s*=\s*([^;]+);/);
    expect(sm, "the server declares the default span").toBeTruthy();
    expect(cm, "and the client declares its display mirror").toBeTruthy();
    const evalSpan = (e) => Function(`"use strict";return (${e.replace(/_/g, "")})`)();
    expect(evalSpan(cm[1]), "the two spans agree").toBe(evalSpan(sm[1]));
    // ANTI-VACUITY: two matching stubs would satisfy the equality above.
    expect(evalSpan(sm[1]), "and the shared value is 48 hours").toBe(48 * 60 * 60 * 1000);
  });

  test("v8.6.6: the screenshot captures keep the fixes npm test cannot hold", () => {
    const fs = require("fs"), path = require("path");
    const DR = require("./doc-registry");
    // WHY A SOURCE LOCK. `playwright.config.js` sets
    // `testIgnore: ["**/_*.spec.js"]`, so `tests/_screenshots.spec.js` NEVER runs
    // under `npm test` and can never go red in CI. That is not theoretical: the
    // same file was skipped by TWO sweeps that fixed its siblings — v8.3.15 added
    // `dismiss-ended` to `badge-ui.spec.js` and not here, and v8.6.4 fixed four
    // `#main-nav` readiness waits across two files and not here — so three
    // captures were broken for releases with nothing to report it. This scanner
    // is the only thing standing in front of that recurrence.
    // Comments are stripped first: the fixes' own comments quote the patterns
    // they forbid (v7.21.13).
    const src = DR.stripJsComments(
      fs.readFileSync(path.join(__dirname, "_screenshots.spec.js"), "utf8"));

    // (1) A capture that AUTO-ENDS a competition and then signs the participant
    // in lands them INSIDE it, where the status poll's "Event Ended" modal
    // covers the page. MEASURED: this one line is what makes 11-badge-share pass.
    expect(src, "a capture that auto-ends a competition dismisses the ended popup")
      .toContain("/api/dismiss-ended");

    // (2) "Row 1 of the competitions table" is not the seeded competition: the
    // table sorts live-first by effective end DESCENDING, and an earlier capture
    // creates a Program 90 days out. Every Focus click must narrow first.
    const lines = src.split("\n");
    const focusAt = lines
      .map((l, i) => ({ l, i }))
      .filter(x => /data-action="comp-open"/.test(x.l));
    expect(focusAt.length, "ANTI-VACUITY: the Open (workspace) sites still exist")
      .toBeGreaterThanOrEqual(3);
    for (const { i } of focusAt) {
      const before = lines.slice(Math.max(0, i - 14), i).join("\n");
      // BOTH halves. `filterComps` alone passes VACUOUSLY — it waits for a row
      // CONTAINING the name to be visible, which is true whether or not the table
      // narrowed — so the click must also be scoped to that row rather than
      // taking `.first()` of the whole table. Measured: with the filter applied
      // and an unscoped `.first()`, the scope banner still read another event.
      expect(before, `the Focus click at line ${i + 1} narrows the table first`)
        .toMatch(/filterComps\(/);
      expect(before, `the Focus click at line ${i + 1} is scoped to the named ROW`)
        .toMatch(/#admin-comp-body tr", \{ hasText:/);
    }

    // (3) A participant capture must OWN its competition rather than inherit
    // `users.active_competition_id`, which an earlier capture clears durably by
    // clicking Competitions (that fires POST /api/deselect-competition).
    const uses = (src.match(/loginAliceIntoLive\(/g) || []).length;
    expect(uses, "the captures that need the seeded live competition select it explicitly")
      .toBeGreaterThanOrEqual(3);   // the helper + its two callers

    // (4) The manifest must report what the run CAPTURED, not what is on disk:
    // with RETRIES=0 a failed capture leaves the previous PNG in place, so a
    // disk count certifies a regeneration that did not happen.
    expect(src, "the manifest records what this pass actually wrote")
      .toMatch(/regenerated\[THEME\]\s*=/);
  });

  test("v8.4.0: every caller of _profileMissingFields selects the registration-event join", () => {
    const fs = require("fs"), path = require("path");
    const DR = require("./doc-registry");
    // `_profileMissingFields` THROWS on an under-selecting row, so this scanner is
    // belt-and-braces for the reachable case and a real guard for the one that is
    // not: a caller on a branch no test drives would otherwise 500 in production
    // the first time somebody took it. The function reads the event a participant
    // registered THROUGH, so every caller must carry the LEFT JOIN — and
    // `PROFILE_GATE_COLUMNS` / `PROFILE_GATE_JOIN` exist so there is one copy of
    // it rather than five.
    const files = ["lib/middleware.js", "routes/participant.js", "server.js"]
      .map(f => path.join(__dirname, "..", f));
    let callers = 0;
    for (const f of files) {
      const src = DR.stripJsComments(fs.readFileSync(f, "utf8"));
      const lines = src.split("\n");
      lines.forEach((ln, i) => {
        if (!/_profileMissingFields\s*\(/.test(ln)) return;
        if (/function _profileMissingFields|require\(|module\.exports|=\s*\{/.test(ln)) return;
        callers++;
        // The row must come from a SELECT that uses the shared fragment, within a
        // short window above the call — every current caller either builds the row
        // one to thirty lines up or is handed it directly.
        const win = lines.slice(Math.max(0, i - 40), i + 2).join("\n");
        const ok = /PROFILE_GATE_COLUMNS/.test(win) && /PROFILE_GATE_JOIN/.test(win);
        expect(ok, `${path.basename(f)}:${i + 1} calls _profileMissingFields on a row built without the shared gate SELECT`).toBe(true);
      });
    }
    // ANTI-VACUITY: a rename would leave the regex matching nothing and passing.
    expect(callers, "the gate still has callers to check").toBeGreaterThanOrEqual(4);
  });

  test("v8.3.27: the client confirm-exempt list mirrors the server's no-durable-change allowlist, and not the carve-out", () => {
    const fs = require("fs"), path = require("path");
    const DR = require("./doc-registry");
    const imp = DR.stripJsComments(fs.readFileSync(path.join(__dirname, "..", "lib", "impersonation.js"), "utf8"));
    const cli = DR.stripJsComments(fs.readFileSync(path.join(__dirname, "..", "public", "js", "core", "api.js"), "utf8"));

    const body = (src, fn) => {
      const i = src.indexOf(`function ${fn}(`);
      expect(i, `${fn} must exist`).toBeGreaterThan(-1);
      return src.slice(i, src.indexOf("\n}", i));
    };
    // The server's plain-string equality paths. `/api/test/` (a startsWith) and
    // navigated-away (a regex) are shapes, not paths, and are matched on both
    // sides by their own constructs.
    const serverAllowed = [...body(imp, "impersonationWriteAllowed").matchAll(/path === "([^"]+)"/g)].map(m => m[1]);
    const clientExempt = [...body(cli, "_impersonationWriteExempt").matchAll(/includes\('([^']+)'\)/g)].map(m => m[1]);

    // ANTI-VACUITY: a rename on either side would empty a list and pass in silence.
    expect(serverAllowed.length, "the server allowlist parsed as empty — impersonationWriteAllowed was probably reshaped").toBeGreaterThanOrEqual(5);
    expect(clientExempt.length, "the client exempt list parsed as empty — _impersonationWriteExempt was probably reshaped").toBeGreaterThanOrEqual(5);

    const missing = serverAllowed.filter(p2 => !clientExempt.includes(p2));
    expect(missing,
      "the server allows these under impersonation because they change NOTHING durable, but the client still " +
      "fronts them with the are-you-sure confirm. Add them to _impersonationWriteExempt:\n  " + missing.join("\n  ")
    ).toEqual([]);

    // A client entry with no server counterpart needs a stated reason — the
    // decision-per-item shape, so an accidental addition cannot hide as an extra.
    const CLIENT_ONLY_OK = new Map([["/api/csrf-token", "a GET, so the confirm could never fire for it"]]);
    const extra = clientExempt.filter(p2 => !serverAllowed.includes(p2) && !CLIENT_ONLY_OK.has(p2));
    expect(extra,
      "a path is exempt from the superadmin confirm with no server allowance and no recorded reason:\n  " + extra.join("\n  ")
    ).toEqual([]);

    // THE ASYMMETRY. The read-only tier's durable carve-out must stay confirmable.
    const carve = body(imp, "impersonationReadOnlyWriteAllowed") + imp.slice(imp.indexOf("_CERT_MINT_RE"));
    expect(carve.includes("badge"), "the carve-out predicate should still be about the badge mint").toBe(true);
    expect(clientExempt.some(p2 => p2.includes("badge")),
      "the certificate mint must NOT be exempt from the superadmin confirm — it writes a durable row and " +
      "publishes a permanent public page in the participant's name"
    ).toBe(false);
  });

  // v8.3.33 — ADMIN READINESS MAY NOT BE GATED ON `attached`.
  //
  // The admin sidebar <button>s are STATIC markup in index.html, so waiting for
  // `.admin-nav-item` to be ATTACHED is satisfied at first paint — before boot has
  // resolved who we are. `S.isSuperAdmin` starts false; a click that lands in that
  // window runs `loadAdminSettings` on a falsy flag, which hides all three cards and
  // leaves `#admin-settings-tab` PERMANENTLY zero-height (one caller, no poll,
  // nothing re-runs it). Reproduced deterministically by delaying /api/admin/me:
  // the pane was still height 0 six seconds after the flag had become true.
  // That was run 48 of the v8.3.32 60-run sweep.
  //
  // `visible` is fine and is NOT flagged: those buttons live inside #admin-page,
  // which is display:none until boot shows it, so visibility implies identity.
  // Only `attached` can be satisfied by the shell alone.
  test("v8.3.33: no spec gates admin readiness on .admin-nav-item being merely ATTACHED", () => {
    const fs = require("fs"), path = require("path");
    const dir = __dirname;
    const specs = fs.readdirSync(dir).filter(f => f.endsWith(".js"));
    const offenders = [];
    let seen = 0;
    for (const f of specs) {
      const src = _stripJsComments(fs.readFileSync(path.join(dir, f), "utf-8"));
      if (!src.includes("admin-nav-item")) continue;
      seen++;
      const re = /admin-nav-item[^\n]*?waitFor\(\s*\{[^}]*state:\s*["']attached["']/g;
      let m;
      while ((m = re.exec(src))) {
        offenders.push(`${f}: ${src.slice(m.index, m.index + 90).replace(/\s+/g, " ")}`);
      }
    }
    expect(seen, "anti-vacuity: some specs must reference .admin-nav-item, or this scanner matches nothing")
      .toBeGreaterThanOrEqual(2);
    expect(offenders, "wait for #admin-page to be VISIBLE instead — `attached` is satisfied by the static shell before boot has resolved S.isSuperAdmin")
      .toEqual([]);
  });

  test("v8.3.26: every spawned-server port offset is unique, clear of the worker slots, and registered", () => {
    const fs = require("fs"), path = require("path");
    const dir = path.join(__dirname);
    // The identifier is ASSEMBLED, not written out, and that is not fussiness:
    // a bare `PORT_BASE` token anywhere in this file — a regex literal and a
    // message string, both of which survive comment-stripping — makes the
    // v7.16.2 missing-import scanner read it as a helpers.js symbol this file
    // uses without importing, and it fails on perfectly correct code. Measured:
    // the first draft of this test did exactly that. A scanner that is wrong
    // about working code is one the next person deletes.
    const _OFFSET_RE = () => new RegExp(["PORT", "BASE"].join("_") + "\\s*\\+\\s*(\\d+)", "g");
    // `functional-security-a` deliberately re-binds the worker's OWN port to
    // assert EADDRINUSE, so it is an offset by construction and not a spawner.
    const EXEMPT = new Set(["functional-security-a.api.spec.js"]);
    const found = new Map();          // offset -> [files]
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".spec.js"))) {
      if (EXEMPT.has(f)) continue;
      // Comments first: several of these files QUOTE a sibling's offset in a
      // "registry: 140 is the login-code spec" note, which an unstripped scan
      // reads as a duplicate binding (the standing strip-comments rule).
      const src = require("./doc-registry").stripJsComments(fs.readFileSync(path.join(dir, f), "utf8"));
      for (const m of src.matchAll(_OFFSET_RE())) {
        const off = Number(m[1]);
        if (!found.has(off)) found.set(off, new Set());
        found.get(off).add(f);
      }
    }
    // ANTI-VACUITY. Renaming the port-base identifier would make the regex match
    // nothing and this arm would pass in silence — the failure it exists to catch.
    expect(found.size,
      "almost no spawner port offsets found — the port-base identifier was probably renamed and this scanner is checking nothing"
    ).toBeGreaterThanOrEqual(12);

    const gs = fs.readFileSync(path.join(dir, "global-setup.js"), "utf8");
    const regM = gs.match(/SPAWNER_OFFSETS\s*=\s*\[([^\]]*)\]/);
    expect(regM, "tests/global-setup.js must declare SPAWNER_OFFSETS").toBeTruthy();
    const registered = new Set(regM[1].split(",").map(x => Number(x.trim())).filter(Number.isFinite));

    const strideM = fs.readFileSync(path.join(dir, "..", "scripts", "test-independence.cjs"), "utf8")
      .match(/PORT_STRIDE\s*=\s*(\d+)/);
    expect(strideM, "scripts/test-independence.cjs must declare PORT_STRIDE").toBeTruthy();
    const stride = Number(strideM[1]);

    const bad = [];
    for (const [off, files] of [...found].sort((a, b) => a[0] - b[0])) {
      if (files.size > 1) bad.push(`offset +${off} is used by ${[...files].join(" AND ")} — they collide the moment they run on different workers`);
      if (off < 100) bad.push(`offset +${off} (${[...files][0]}) is inside the worker-slot range; use >= 100`);
      if (off >= stride) bad.push(`offset +${off} (${[...files][0]}) is >= the independence shard stride (${stride}), so it lands in another shard's window`);
      if (!registered.has(off)) bad.push(`offset +${off} (${[...files][0]}) is not in tests/global-setup.js SPAWNER_OFFSETS, so a leaked server on it is invisible to the pre-flight`);
    }
    for (const off of registered) {
      if (!found.has(off)) bad.push(`SPAWNER_OFFSETS lists +${off} but no spec uses it — a stale entry pre-flights a port nobody binds`);
    }
    expect(bad, "spawned-server port registry is inconsistent:\n  " + bad.join("\n  ")).toEqual([]);
  });

  test("no TEST_PORT_BASE puts a test server on a port fetch() refuses: the list is this runtime's own, global-setup refuses such a base, and the runners' defaults are clean", async () => {
    // fetch() and the browser refuse the Fetch standard's blocked ports ("bad
    // port"), so a server bound to one boots and is never reached: a base of 6500
    // put late-entry-mail's +197 on 6697, and test:changed's old 4900 put +160 and
    // +161 on 5060 and 5061.
    const fs = require("fs"), path = require("path");
    const { execFileSync } = require("child_process");
    const { FETCH_BLOCKED_PORTS, blockedPortsIn, cleanPortBases } = require("./server-env");
    const root = path.join(__dirname, "..");

    // (1) The list is what THIS runtime's fetch refuses: every entry fails "bad
    // port" before it leaves, and the unlisted port just above each does not.
    const why = async (p) => {
      try { await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(3000) }); return "answered"; }
      catch (e) { return String((e.cause && (e.cause.message || e.cause)) || e.message); }
    };
    const listed = await Promise.all(FETCH_BLOCKED_PORTS.map(async p => [p, await why(p)]));
    expect(listed.filter(([, w]) => !/bad port/i.test(w)).map(([p]) => p), "listed ports this fetch does not refuse (the list is stale)").toEqual([]);
    const above = FETCH_BLOCKED_PORTS.map(p => p + 1).filter(p => !FETCH_BLOCKED_PORTS.includes(p));
    const unlisted = await Promise.all(above.map(async p => [p, await why(p)]));
    expect(unlisted.filter(([, w]) => /bad port/i.test(w)).map(([p]) => p), "unlisted ports this fetch refuses (the list misses one)").toEqual([]);

    // (2) global-setup refuses a base that lands a spawner port on one, naming
    // it, before it probes or touches anything; a clean base gets past that check
    // (it may still find a port busy, a different refusal).
    const setupWith = (base) => {
      try {
        return execFileSync(process.execPath, ["-e",
          'require("./tests/global-setup")({ workers: 1 }).then(() => console.log("RAN"), e => console.log("REFUSED " + e.message))'],
        { cwd: root, encoding: "utf8", timeout: 30000,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "", TEST_PORT_BASE: String(base), DATA_DIR: "", UPLOADS_DIR: "" } });
      } catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; }
    };
    const bad = setupWith(6500);
    expect(bad, "a base putting +197 on 6697 is refused, by name").toMatch(/REFUSED TEST_PORT_BASE 6500 puts 6697 on the ports fetch\(\) and the browser refuse/);
    const clean = setupWith(6100);
    expect(clean, "a clean base passes the blocked-port check").toMatch(/RAN|REFUSED Ports already in use/);
    expect(clean).not.toMatch(/bad port/);

    // (3) The runners' own bases are clean: the default base at the default
    // worker count with every registered spawner offset, test:changed's base, and
    // the independence shards (which take cleanPortBases, skipping 4900).
    const gs = fs.readFileSync(path.join(__dirname, "global-setup.js"), "utf8");
    const offsets = gs.match(/SPAWNER_OFFSETS\s*=\s*\[([^\]]*)\]/)[1].split(",").map(x => Number(x.trim())).filter(Number.isFinite);
    expect(offsets.length, "PRECONDITION: read the spawner offsets").toBeGreaterThanOrEqual(12);
    const DEFAULT_BASE = Number(/DEFAULT_PORT_BASE = (\d+);/.exec(fs.readFileSync(path.join(__dirname, "server-env.js"), "utf8"))[1]);
    const WORKERS = Number(/process\.env\.WORKERS \|\| \(process\.env\.CROSS_BROWSER === "1" \? "2" : "(\d+)"\)/.exec(fs.readFileSync(path.join(root, "playwright.config.js"), "utf8"))[1]);
    const changed = fs.readFileSync(path.join(root, "scripts", "test-changed.cjs"), "utf8");
    const CHANGED_BASE = Number(/TEST_PORT_BASE: process\.env\.TEST_PORT_BASE \|\| "(\d+)"/.exec(changed)[1]);
    const ports = (base) => [...Array.from({ length: WORKERS }, (_, i) => base + i), ...offsets.map(o => base + o)];
    expect(blockedPortsIn(ports(DEFAULT_BASE)), `the default base ${DEFAULT_BASE}`).toEqual([]);
    expect(blockedPortsIn(ports(CHANGED_BASE)), `test:changed's base ${CHANGED_BASE}`).toEqual([]);
    const indep = fs.readFileSync(path.join(root, "scripts", "test-independence.cjs"), "utf8");
    expect(indep, "the independence shards take clean bases").toMatch(/portBaseFor = \(shard\) => cleanPortBases\(4700, PORT_STRIDE, shard \+ 1\)\[shard\]/);
    expect(cleanPortBases(4700, 200, 4), "4900's window holds 5060 and 5061, so it is skipped").toEqual([4700, 5100, 5300, 5500]);
  });

  test("v8.3.24: every symbol a doc registry declares still exists in the tree", () => {
    const DR = require("./doc-registry");
    const src = DR.corpus();
    const bad = [], declared = [];
    for (const reg of _docReg()) {
      const exempt = new Set(reg.exempt.map(e => e.value));
      for (const s of reg.symbols) {
        declared.push(s.value);
        if (exempt.has(s.value)) continue;
        if (!new RegExp(`\\b${s.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(src)) {
          bad.push(`${reg.doc}: DOC-SYMBOL ${s.value} — no longer in first-party source`);
        }
      }
      for (const e of reg.exempt) {
        if (!e.reason) bad.push(`${reg.doc}: DOC-EXEMPT ${e.value} carries no reason. An exemption without one is a blanket carve-out, not a decision.`);
      }
    }
    // ANTI-VACUITY. A registry emptied (or a directive renamed) would make every
    // loop above iterate nothing and pass in silence — the exact failure these
    // exist to catch. Floor set well below today's population.
    expect(declared.length,
      "the doc registries declare almost no symbols — a directive was probably renamed and these arms are now checking nothing"
    ).toBeGreaterThanOrEqual(12);
    expect(bad,
      "a doc names a symbol the code no longer has. Fix the PROSE, or add a DOC-EXEMPT line with a reason " +
      "if the doc names it deliberately as removed:\n  " + bad.join("\n  ")
    ).toEqual([]);
  });

  test("v8.3.24: a declared DOC-COVERS set matches the live mount set, in BOTH directions", () => {
    // The direction that matters most is code→doc. `POST /api/deselect-competition`
    // acquired `requireCompleteProfile` in v8.3.8 — the same commit that added 29
    // lines to AUTH_PATHS.md — and the doc's enumeration never grew. A doc→code
    // check alone stays green through that for ever, because everything the doc
    // DOES list is still true.
    const DR = require("./doc-registry");
    const regions = DR.routeRegions();
    const bad = [];
    let pairs = 0;
    for (const reg of _docReg()) {
      const exempt = new Set(reg.exempt.map(e => e.value));
      const bySymbol = new Map();
      for (const c of reg.covers) {
        pairs++;
        if (!bySymbol.has(c.symbol)) bySymbol.set(c.symbol, new Set());
        bySymbol.get(c.symbol).add(DR.routeKey(...c.site.split(/\s+/)));
      }
      for (const [symbol, claimed] of bySymbol) {
        // doc → code: every claimed site exists and really carries the symbol.
        for (const key of claimed) {
          const hits = regions.get(key);
          if (!hits) { bad.push(`${reg.doc}: DOC-COVERS ${symbol} @ ${key} — no such route`); continue; }
          if (!hits.some(h => h.signature.includes(symbol))) {
            bad.push(`${reg.doc}: DOC-COVERS ${symbol} @ ${key} — the route exists but does not carry ${symbol}`);
          }
        }
        // code → doc: every live mount is declared, or exempted with a reason.
        for (const [key, hits] of regions) {
          if (claimed.has(key) || exempt.has(`${symbol} @ ${key}`)) continue;
          if (hits.some(h => h.signature.includes(symbol))) {
            bad.push(`${reg.doc}: ${symbol} is mounted on ${key} (${hits[0].file}:${hits[0].line}) and the registry does not list it`);
          }
        }
      }
    }
    expect(pairs, "the DOC-COVERS population collapsed — this arm is checking nothing").toBeGreaterThanOrEqual(6);
    expect(bad,
      "a doc ENUMERATES the sites of a middleware or helper and the enumeration no longer matches the code. " +
      "Update the prose AND its DOC-COVERS line:\n  " + bad.join("\n  ")
    ).toEqual([]);
  });

  test("v8.3.24: a declared DOC-MODULE listing names every file in its directory", () => {
    // The shape that rots in silence: DEVELOPMENT's repository map and
    // AUTH_PATHS' source map enumerate `lib/`, and a module added later errors
    // nowhere — it just stops being true. CLAUDE.md records this list drifting
    // by sixteen modules before anyone noticed.
    const DR = require("./doc-registry");
    const fsL = require("fs"), p = require("path");
    const bad = [];
    let listed = 0;
    for (const reg of _docReg()) {
      for (const mod of reg.modules) {
        const [dir, pat] = mod.value.split("/");
        const files = fsL.readdirSync(p.join(DR.ROOT, dir)).filter(f => f.endsWith(pat.replace("*", "")));
        listed += files.length;
        for (const f of files) {
          const base = f.replace(/\.js$/, "");
          if (!new RegExp(`\\b${base.replace(/[-]/g, "[-]")}\\b`).test(reg.raw)) {
            bad.push(`${reg.doc}: DOC-MODULE ${mod.value} — \`${base}\` exists on disk and the document never names it`);
          }
        }
      }
    }
    expect(listed, "no DOC-MODULE directory resolved — the glob or the directory moved").toBeGreaterThanOrEqual(20);
    expect(bad,
      "a document enumerates a directory and has fallen behind it. Add the module to the prose:\n  " + bad.join("\n  ")
    ).toEqual([]);
  });

  test("v8.3.24: a declared DOC-SET is quoted with exactly the members the code holds", () => {
    // AUTH_PATHS §9 says `_BULK_EMAIL_REASONS` is "exactly {…} — those five".
    // v8.3.7 removed `account_approved_bulk`, leaving four, and the doc then
    // built a whole bullet on the member that is gone.
    const DR = require("./doc-registry");
    const bad = [];
    let checked = 0;
    for (const reg of _docReg()) {
      for (const s of reg.sets) {
        const members = DR.setLiteral(s.file, s.name);
        if (!members) { bad.push(`${reg.doc}: DOC-SET ${s.name} @ ${s.file} — no such Set literal`); continue; }
        checked++;
        for (const m of members) {
          if (!reg.raw.includes(m)) bad.push(`${reg.doc}: DOC-SET ${s.name} — the code holds \`${m}\` and the document never names it`);
        }
        // A DECLARED member list is checked for EXACT equality, which is the
        // only direction that catches a member the code REMOVED: AUTH_PATHS §9
        // said `_BULK_EMAIL_REASONS` is "exactly {…} — those five" after
        // v8.3.7 left four, and then built a bullet on the one that was gone.
        // Code→doc alone stays green through that, because every surviving
        // member is still named somewhere in a 1100-line document.
        if (s.claimed) {
          const want = s.claimed.split(",").map(x => x.trim()).filter(Boolean).sort().join(",");
          const got = [...members].sort().join(",");
          if (want !== got) bad.push(`${reg.doc}: DOC-SET ${s.name} — the document claims {${want}}; the code holds {${got}}`);
        }
      }
    }
    expect(checked, "no DOC-SET resolved — a set was renamed and this arm is checking nothing").toBeGreaterThanOrEqual(2);
    expect(bad, "a document quotes a Set the code has changed:\n  " + bad.join("\n  ")).toEqual([]);
  });

  test("v8.3.24: a declared DOC-REASON inventory covers every send reason in the code", () => {
    // EMAIL_RULES §7 inventories every outbound send. A new reason added to a
    // route is invisible to it, and the inventory's own release had to correct
    // six errors of exactly this shape.
    const DR = require("./doc-registry");
    const reasons = DR.emailReasons();
    const bad = [];
    let inventories = 0;
    for (const reg of _docReg()) {
      if (!reg.reasons.length) continue;
      inventories++;
      const exempt = new Set(reg.exempt.map(e => e.value));
      for (const r of reasons) {
        if (exempt.has(r)) continue;
        if (!reg.raw.includes(r)) bad.push(`${reg.doc}: the code sends \`${r}\` and the inventory never names it`);
      }
    }
    expect(inventories, "no DOC-REASON inventory declared — this arm is checking nothing").toBeGreaterThanOrEqual(1);
    expect(reasons.size, "the send-reason derivation collapsed — sendEmailLogged was probably renamed").toBeGreaterThanOrEqual(12);
    expect(bad, "an outbound email reason is undocumented:\n  " + bad.join("\n  ")).toEqual([]);
  });

  test("v8.7.0: every admin route is classified for the event-admin tier", () => {
    // THE POINT OF THIS ARM. `eventAdminGuard` refuses any /api/admin route that
    // is in neither map, so the platform already fails CLOSED at runtime — but a
    // route added by somebody who has never heard of this role would then simply
    // not work for an event admin, and the first report would come from a live
    // event. This makes the omission go red at merge instead.
    //
    // It runs in BOTH directions: a registration with no classification is the
    // gap; a classification naming a route that no longer exists is a stale
    // decision, which reads as coverage and is not.
    const DR = require("./doc-registry");
    const EA = require("../lib/event-admin");

    // The map keys are written with real parameter names (`:id`, `:tsId`);
    // routeRegions normalises every parameter to `:P`. Compare on the normalised
    // form or every parameterised route reads as unclassified.
    const norm = k => { const sp = k.indexOf(" "); return DR.routeKey(k.slice(0, sp), k.slice(sp + 1)); };

    expect(EA.EVENT_ADMIN_ROUTES instanceof Map, "EVENT_ADMIN_ROUTES must still be a Map — a rename would empty every lookup below and pass in silence").toBeTruthy();
    expect(EA.EVENT_ADMIN_FORBIDDEN instanceof Map, "EVENT_ADMIN_FORBIDDEN must still be a Map").toBeTruthy();

    const classified = new Map();
    for (const [k, v] of EA.EVENT_ADMIN_ROUTES) classified.set(norm(k), { kind: v, raw: k });
    const forbidden = new Map();
    for (const [k, v] of EA.EVENT_ADMIN_FORBIDDEN) forbidden.set(norm(k), { reason: v, raw: k });

    const both = [...classified.keys()].filter(k => forbidden.has(k));
    expect(both, "a route may be classified OR forbidden, never both").toEqual([]);

    const regions = DR.routeRegions();
    const live = new Set();
    for (const key of regions.keys()) {
      const path = key.slice(key.indexOf(" ") + 1);
      if (path.startsWith("/api/admin/") || path === "/metrics") live.add(key);
    }

    // ── direction 1: every live admin route is decided about ──────────────────
    const undecided = [...live].filter(k => !classified.has(k) && !forbidden.has(k))
      .map(k => `${k}  [${(regions.get(k) || [])[0]?.file}:${(regions.get(k) || [])[0]?.line}]`);
    expect(undecided,
      "these /api/admin routes are not classified for the event-admin tier.\n" +
      "Add each to EVENT_ADMIN_ROUTES ('scoped' | 'open' | 'superadmin') or to\n" +
      "EVENT_ADMIN_FORBIDDEN with a reason, in lib/event-admin.js. An unclassified\n" +
      "route is refused at runtime, so shipping one silently breaks the tier.").toEqual([]);

    // ── direction 2: no classification names a route that is gone ─────────────
    // A route classified ahead of its registration (lib/rbac.js
    // PENDING_ADMIN_ROUTES) is tolerated while it is not live, and must leave
    // that list the moment it is.
    const RB = require("../lib/rbac");
    const pending = new Set([...RB.PENDING_ADMIN_ROUTES].map(norm));
    const stale = [...classified.keys(), ...forbidden.keys()].filter(k => !live.has(k) && !pending.has(k));
    expect(stale,
      "these classifications name routes that are no longer registered — a stale\n" +
      "decision reads as coverage and is not").toEqual([]);
    const pendingLive = [...pending].filter(k => live.has(k));
    expect(pendingLive, "these routes are registered now — remove them from PENDING_ADMIN_ROUTES").toEqual([]);

    // ── the permission map itself, both ways, and every permission used ───────
    expect(RB.ADMIN_ROUTE_PERMISSIONS instanceof Map, "ADMIN_ROUTE_PERMISSIONS must be a Map").toBeTruthy();
    const permKeys = new Set([...RB.ADMIN_ROUTE_PERMISSIONS.keys()].map(norm));
    const noPerm = [...live].filter(k => !permKeys.has(k));
    expect(noPerm, "these live admin routes have no permission in lib/rbac.js ADMIN_ROUTE_PERMISSIONS").toEqual([]);
    const permStale = [...permKeys].filter(k => !live.has(k) && !pending.has(k));
    expect(permStale, "ADMIN_ROUTE_PERMISSIONS names routes that are not registered").toEqual([]);
    const unknownPerm = [...RB.ADMIN_ROUTE_PERMISSIONS].filter(([, v]) => !RB.PERMISSION_IDS.has(v.perm)).map(([k]) => k);
    expect(unknownPerm, "a route names a permission that is not in the catalogue").toEqual([]);
    const usedPerms = new Set([...RB.ADMIN_ROUTE_PERMISSIONS.values()].map(v => v.perm));
    // users.view / roles.manage are used by the Users & roles routes; the
    // scanner reads the map, so every catalogue entry must be reached by one.
    const unusedPerms = RB.PERMISSIONS.map(p => p.id).filter(p => !usedPerms.has(p));
    expect(unusedPerms, "these catalogue permissions guard no route — a permission nothing checks is accept-and-ignore").toEqual([]);

    // ── every 'scoped' handler actually consults the scope primitive ──────────
    // The classification says "the handler owns the row-level answer". This is
    // what checks it did. An 'open' entry is exempt by construction: there is no
    // entity. A FORBIDDEN entry is not exempt merely because the built-in event
    // admin's tier guard refuses it: a custom role scoped to its events passes
    // requireSuperAdmin / requireGlobalAdmin by holding the route's permission
    // (lib/rbac.js customRoleAllows), so every route whose permission such a role
    // may hold (grantable, and not PLATFORM_WIDE_PERMISSIONS) is held to the
    // primitive below as well (the scoped-role arm).
    const NAMES = ["competitionDenied", "taskViewDenied", "taskEditDenied", "taskScoringEditDenied",
      "taskUnassignDenied", "participantDenied", "memberTargetsDenied", "groupViewDenied",
      "groupWriteDenied", "groupDeleteDenied", "scopeFilterSql", "scopedCompetitionIds",
      "outOfScopeCompetitionIds", "isEventAdmin", "actorId"];

    // A route may reach the primitive through a FILE-LOCAL helper — `routes/challenges.js`
    // wraps the three-way challenge-visibility rule in `_taskVisibilitySql` and splices
    // it into four queries, which is better than four copies. So resolve ONE level:
    // any file-local `function _x(` whose own body calls a predicate counts as a
    // predicate for routes in that file.
    //
    // Teaching the scanner the legitimate idiom is the point. A scanner that is
    // wrong about WORKING code is one the next person deletes, and this arm is
    // the only thing standing between a 'scoped' classification and a route with
    // no row check at all.
    const DR2 = require("./doc-registry");
    const fsL2 = require("fs"), pL2 = require("path");
    const localHelpers = new Map();   // file -> Set(helper names that reach the primitive)
    // Every route a custom role scoped to its events can reach although the
    // built-in event admin cannot: its permission is grantable and not
    // platform-wide (lib/rbac.js), and the route has rows to narrow.
    const RBAC = require("../lib/rbac");
    const scopedRoleReach = [];
    for (const [k, v] of RBAC.ADMIN_ROUTE_PERMISSIONS) {
      const perm = RBAC.PERMISSIONS.find(x => x.id === v.perm);
      if (!perm || !perm.grantable || RBAC.isPlatformWidePermission(v.perm)) continue;
      if (RBAC.BUILTIN_ROLE_PERMISSIONS.event_admin.has(v.perm) || v.rows !== "scoped") continue;
      scopedRoleReach.push({ raw: k, key: norm(k) });
    }
    for (const rel of new Set([...[...classified.values()].map(v => norm(v.raw)), ...scopedRoleReach.map(r => r.key)].flatMap(k => (regions.get(k) || []).map(s => s.file)))) {
      const src = DR2.stripJsComments(fsL2.readFileSync(pL2.join(DR2.ROOT, rel), "utf8"));
      const found = new Set();
      for (const m of src.matchAll(/\bfunction\s+(_[A-Za-z0-9_]+)\s*\(/g)) {
        const start = m.index;
        // The body is bounded by the NEXT top-level function declaration, which
        // is enough: a helper that reaches the primitive does so in its own body.
        const nxt = src.indexOf("\nfunction ", start + 1);
        const body = src.slice(start, nxt === -1 ? src.length : nxt);
        if (NAMES.some(n => new RegExp(`\\b${n}\\s*\\(`).test(body))) found.add(m[1]);
      }
      localHelpers.set(rel, found);
    }

    const reaches = (site) => {
      if (NAMES.some(n => new RegExp(`\\b${n}\\s*\\(`).test(site.body))) return true;
      const helpers = localHelpers.get(site.file);
      if (!helpers) return false;
      for (const h of helpers) if (new RegExp(`\\b${h}\\s*\\(`).test(site.body)) return true;
      return false;
    };

    const unenforced = [];
    for (const [k, v] of classified) {
      if (v.kind !== "scoped") continue;
      const sites = regions.get(k) || [];
      if (!sites.length) continue;                       // covered by the stale arm
      if (!sites.some(reaches)) {
        unenforced.push(`${v.raw}  [${sites[0].file}:${sites[0].line}]`);
      }
    }
    expect(unenforced,
      "these routes are classified 'scoped' but their handlers never call into\n" +
      "lib/event-admin.js, so an event admin reaches them with NO row-level check.\n" +
      "Either add the predicate, or reclassify the route.").toEqual([]);

    // The scoped-role arm. These handlers were written for a superadmin and are
    // destructive (delete an event or a challenge, lock, recalculate, verify,
    // revoke), so attribution alone does not count: `actorId(` or `isEventAdmin(`
    // in the body says nothing about WHICH rows. Each must ask a row predicate.
    const ROW_PREDICATES = NAMES.filter(n => n !== "actorId" && n !== "isEventAdmin");
    const asksRows = (site) => ROW_PREDICATES.some(n => new RegExp(`\\b${n}\\s*\\(`).test(site.body)) ||
      [...(localHelpers.get(site.file) || [])].some(h => new RegExp(`\\b${h}\\s*\\(`).test(site.body));
    const unscopedForRoles = [];
    for (const r of scopedRoleReach) {
      const sites = regions.get(r.key) || [];
      if (!sites.length) { unscopedForRoles.push(`${r.raw}  [no registration found]`); continue; }
      if (!sites.some(asksRows)) unscopedForRoles.push(`${r.raw}  [${sites[0].file}:${sites[0].line}]`);
    }
    expect(scopedRoleReach.length, "no superadmin-tier route is reachable by a scoped custom role — the derivation from lib/rbac.js broke, or every such permission became platform-wide (then delete this arm)").toBeGreaterThanOrEqual(6);
    expect(unscopedForRoles,
      "a custom role scoped to its events reaches these routes by holding their\n" +
      "permission (customRoleAllows), and their handlers never narrow to its events.\n" +
      "Add the lib/event-admin.js predicate, or make the permission platform-wide\n" +
      "(lib/rbac.js PLATFORM_WIDE_PERMISSIONS) if nothing can narrow it.").toEqual([]);

    // ── a refusal must name a remedy ──────────────────────────────────────────
    const thin = [...forbidden.entries()].filter(([, v]) => (v.reason || "").length <= 40).map(([, v]) => v.raw);
    expect(thin, "a forbidden route's reason is rendered to the operator — it must say what is withheld and who can do it instead").toEqual([]);

    // ── anti-vacuity: a rename that empties the maps must not pass in silence ──
    expect(classified.size, "far fewer classified routes than expected — did the extraction break?").toBeGreaterThanOrEqual(60);
    expect(forbidden.size, "far fewer forbidden routes than expected").toBeGreaterThanOrEqual(12);
    expect(live.size, "the admin-route extraction found almost nothing — the registration shape changed").toBeGreaterThanOrEqual(100);
  });

  test("v8.3.24: every repo path these docs cite resolves on disk", () => {
    // Three `tests/ui-admin.spec.js` recipes and one `functional-core.api.spec.js`
    // sat inside copy-pasteable instructions for ~90 releases after v7.21.35/.37
    // split those files. A path in a recipe is an instruction, and an instruction
    // that cannot be followed is worse than none (v7.29.0's FROZEN_REMEDY rule).
    const DR = require("./doc-registry");
    const fsL = require("fs"), p = require("path");
    const bad = [];
    let checked = 0;
    const PATHY = /`((?:tests|lib|routes|public|scripts|docs|ci|perf)\/[A-Za-z0-9_./-]+\.[a-z]{1,4})`/g;
    // Spec paths are matched OUTSIDE backticks too. Three dead
    // `tests/ui-admin.spec.js` references survived ~90 releases precisely
    // because they sit inside fenced `npx playwright test …` recipes rather
    // than inline code spans — and a recipe is an instruction, so a dead path
    // there is the FROZEN_REMEDY class: an instruction that cannot be followed.
    // The shape is unambiguous enough to match unquoted; nothing else in these
    // docs looks like `tests/<name>.spec.js`.
    const SPECY = /\b(tests\/[A-Za-z0-9_.-]+\.spec\.js)\b/g;
    for (const reg of _docReg()) {
      const exempt = new Set(reg.exempt.map(e => e.value));
      const cited = [...reg.raw.matchAll(PATHY)].map(m => m[1])
        .concat([...reg.raw.matchAll(SPECY)].map(m => m[1]));
      for (const rel of cited) {
        if (exempt.has(rel) || rel.includes("*")) continue;
        checked++;
        if (!fsL.existsSync(p.join(DR.ROOT, rel))) {
          bad.push(`${reg.doc}: cites \`${rel}\`, which is not on disk`);
        }
      }
    }
    expect(checked, "no repo paths were found in these docs — the citation shape changed").toBeGreaterThanOrEqual(20);
    expect(bad,
      "a document names a file that does not exist. If it is deliberately illustrative, add a DOC-EXEMPT " +
      "line with a reason:\n  " + bad.join("\n  ")
    ).toEqual([]);
  });

  test("v8.8.26 (+v8.8.27): every node child spawned from tests/ or scripts/ decides its own DATA_DIR and UPLOADS_DIR", () => {
    // `DATA_DIR` has no default any more (lib/data-dir.js). The reason is that
    // `db.js` OPENS THE DATABASE AT REQUIRE TIME, so a process that guessed the
    // path attached to whichever data directory happened to sit beside the code
    // — in practice a live deployment's — silently, with nothing on any screen.
    // v8.8.24 is the same class one layer over: `lib/log.js` mkdirSync'd LOG_DIR
    // and replaced console.* at require time, and a Playwright worker with no
    // DATA_DIR of its own wrote its output into a running deployment's app log.
    //
    // playwright.config.js pins the variable for the WORKER, which makes the
    // class unreachable for anything a spec requires in-process. It does nothing
    // for a CHILD: a spawned node process gets whatever env the spawn site hands
    // it. All 30 sites are correct today — by CONVENTION, held by nothing, and
    // the failure mode is always the site added later (v7.15.15). Site 31
    // forgetting this does not error; it attaches a test to the operator's
    // database.
    //
    // THE CLAIM: a node child launched from tests/ must STATE a decision about
    // DATA_DIR at the site — set it, or delete it deliberately. Both mention the
    // token, which is what makes an intentional no-DATA_DIR child (the refusal
    // arms in data-dir-required.spec.js) visible rather than indistinguishable
    // from an oversight. A bare `...process.env` does NOT satisfy it: that
    // inherits the worker's own pin, which is precisely the collision v7.20.9
    // (F7) is about, and it says nothing at the site.
    //
    // WHAT IT DOES NOT CLAIM, stated rather than implied: it asserts a decision
    // is STATED, not that the value is right — it cannot evaluate an expression,
    // so it cannot tell a throwaway mkdtemp from `./data`. And it resolves ONE
    // level of indirection (an `env` identifier in the same file, or the shared
    // `serverEnv` helper by name); an env assembled by a helper in some THIRD
    // file would be reported as undecided rather than followed.
    const fs = require("fs"), pathMod = require("path");
    const dir = __dirname;

    // A STRING-AWARE balanced walk, not a naive depth count. These argument
    // lists are made of string literals — `"require('./db')"`, `` `${d}/uploads` ``
    // — and a literal holding an unmatched bracket has thrown a brace-counting
    // scanner in this repo off before (v8.1.0 PR 13), shifting its idea of where
    // every later function begins.
    const OPEN = { "(": ")", "[": "]", "{": "}" };
    function balanced(src, i) {                    // src[i] is one of ( [ {
      let depth = 0;
      for (let j = i; j < src.length; j++) {
        const c = src[j];
        if (c === '"' || c === "'" || c === "`") {
          const q = c;
          for (j++; j < src.length; j++) {
            if (src[j] === "\\") { j++; continue; }
            if (src[j] === q) break;
          }
          continue;
        }
        if (OPEN[c]) depth++;
        else if (c === ")" || c === "]" || c === "}") {
          if (--depth === 0) return src.slice(i + 1, j);
        }
      }
      return null;
    }
    // Split on DEPTH-0 commas, so `rateLimit(a, b)` and `["-e", "x"]` stay one
    // argument each.
    function splitTop(text) {
      const out = []; let depth = 0, cur = "";
      for (let j = 0; j < text.length; j++) {
        const c = text[j];
        if (c === '"' || c === "'" || c === "`") {
          const q = c; cur += c;
          for (j++; j < text.length; j++) {
            cur += text[j];
            if (text[j] === "\\") { cur += text[++j] ?? ""; continue; }
            if (text[j] === q) break;
          }
          continue;
        }
        if (OPEN[c]) depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
        cur += c;
      }
      out.push(cur);
      return out;
    }

    // `serverEnv` is the ONE definition of a test server's launch environment
    // (tests/server-env.js, v7.20.0), so a site built from it is decided — but
    // only because THAT contract is asserted here too. Without this arm the
    // allowance below would be a hole rather than a shortcut.
    // The variables a child MUST decide for itself. Both became required with no
    // default (v8.8.26, v8.8.27); adding a third here is all a future one needs.
    const REQUIRED_DIR_VARS = ["DATA_DIR", "UPLOADS_DIR"];
    const envHelper = _stripJsCommentsKeepLines(fs.readFileSync(pathMod.join(dir, "server-env.js"), "utf8"));
    // v8.8.27 — BOTH variables. `UPLOADS_DIR` became required in the same shape
    // and for a sharper reason: server.js SWEEPS that directory at every boot, so
    // a child that guessed it does not merely write to a live volume, it DELETES
    // from one. The two are separate filesystems by design (v7.15.12), so a site
    // that decides one and not the other has decided nothing about the other.
    // A child that IS Playwright pins both itself, in playwright.config.js, before
    // any spec loads — so a runner script spawning the CLI has decided by
    // delegation. Asserted here for the same reason the serverEnv allowance is:
    // otherwise it is a hole rather than a shortcut.
    const pwConfig = _stripJsCommentsKeepLines(
      fs.readFileSync(pathMod.join(dir, "..", "playwright.config.js"), "utf8"));
    for (const V of REQUIRED_DIR_VARS) {
      expect(new RegExp(`process\\.env\\.${V}\\s*=`).test(pwConfig),
        `playwright.config.js no longer pins ${V} for the worker, so every runner script that `
        + "spawns the Playwright CLI is now launching it with none").toBe(true);
    }

    for (const V of REQUIRED_DIR_VARS) {
      expect(new RegExp(`function\\s+serverEnv\\b[\\s\\S]*?\\b${V}\\s*:`).test(envHelper),
        `tests/server-env.js's serverEnv() no longer sets ${V}, so every spawn site that builds `
        + "its env from it is now launching a child with no directory of its own").toBe(true);
    }

    const decides = (s, V) => new RegExp(`\\b${V}\\b`).test(s) || /\bserverEnv\s*\(/.test(s);
    // Is this child the Playwright CLI? Matched on the argv, not the env — both
    // spellings occur (a `PW` constant built from the module path, and the literal
    // path inline), and neither says anything about `env`.
    const isPlaywrightChild = (argv) =>
      /@playwright[/\\]+test[/\\]+cli\.js/.test(argv) || /\bPW\b\s*,\s*["']test["']/.test(argv);
    // Every node child in tests/ is launched through `process.execPath` (all 30
    // of them). Keying on that rather than on the command string is what keeps
    // this precise: `db.exec(...)` and `regex.exec(...)` are not children, and a
    // scanner that matched them would be red against working code on day one.
    const CALL = /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(/g;

    const bad = [];
    let sites = 0;
    // v8.8.27 — scripts/ TOO, not just tests/. `scripts/smoke.cjs` spawns a real
    // server and set DATA_DIR but not UPLOADS_DIR, so it broke the moment that
    // variable became required — caught by `npm run smoke`, which `npm test` does
    // not run. A scanner scoped to tests/ would have reported a clean tree over
    // exactly that gap, which is the failure this whole family exists to prevent.
    const SCAN_DIRS = [dir, pathMod.join(dir, "..", "scripts")];
    for (const scanDir of SCAN_DIRS)
    for (const f of fs.readdirSync(scanDir).filter(x => /\.(js|cjs)$/.test(x))) {
      // Comments FIRST, both forms in one left-to-right alternation. Several of
      // these files narrate their own spawn options in a comment ("NODE_OPTIONS
      // is scrubbed…", "DATA_DIR: dir"), and an unstripped scan would read the
      // prose as the site.
      //
      // The LINE-PRESERVING stripper, so a finding names the real file:line. The
      // plain one deletes comments outright, and with these headers running to
      // twenty lines apiece that reported functional-security-a:3176 for a call
      // that lives at 3329 — an instruction pointing at the wrong place.
      const src = _stripJsCommentsKeepLines(fs.readFileSync(pathMod.join(scanDir, f), "utf8"));
      CALL.lastIndex = 0;
      let m;
      while ((m = CALL.exec(src))) {
        const openIdx = m.index + m[0].length - 1;
        const args = balanced(src, openIdx);
        if (args === null) continue;
        // v8.8.27 — `process.execPath` OR a bare "node". Keying on execPath alone
        // was correct for tests/ (all 30 sites use it) and WRONG the moment
        // scripts/ joined the scan: `scripts/smoke.cjs` spawns `"node"` as a
        // string literal, so the site that actually broke when UPLOADS_DIR became
        // required was invisible — a widened SCOPE with an un-widened MATCH reads
        // as coverage and is not. Measured: adding this flags exactly that site
        // and nothing else.
        if (!/^\s*(process\.execPath\b|["']node["']\s*,)/.test(args)) continue;   // not a node child
        sites++;
        const line = src.slice(0, m.index).split("\n").length;
        // A Playwright CLI child pins both variables in its own config before any
        // spec loads, so it has decided by delegation — and the contract above
        // asserts that, so this is a shortcut rather than a hole. Without it this
        // scanner is RED against four correct runner scripts, and one that is
        // wrong about working code is one the next person deletes.
        if (isPlaywrightChild(args)) continue;

        // The options object is the last top-level argument.
        const top = splitTop(args);
        const optsRaw = top[top.length - 1];
        const braceAt = optsRaw.indexOf("{");
        const optsBody = braceAt < 0 ? "" : (balanced(optsRaw, braceAt) ?? "");

        let envVal = null;
        for (const p of splitTop(optsBody)) {
          const t = p.trim();
          const kv = /^env\s*:\s*([\s\S]+)$/.exec(t);
          if (kv) { envVal = kv[1].trim(); break; }
          if (/^env$/.test(t)) { envVal = "env"; break; }      // shorthand `{ env, stdio }`
        }
        if (envVal !== null && REQUIRED_DIR_VARS.every((V) => decides(envVal, V))) continue;

        // ONE level of indirection — the idiom the v8.7.0 route scanner and the
        // v8.8.9 deferred-emit arm already resolve. MEASURED rather than assumed:
        // exactly TWO sites reach this branch (functional-security-a:3329 and
        // functional-security-c:7214, both `{ env, … }` shorthands whose object is
        // built a few lines above), and deleting it flags those two and nothing
        // else. isolated-test.js's `env: serverEnv(slot)` looks like a third and
        // is not — it is a call expression, satisfied by the `serverEnv(`
        // allowance above without ever reaching here.
        //
        // A post-declaration write is followed because this tree already uses
        // that shape — functional-security-c sets `env.NODE_OPTIONS = ""` after
        // the literal — so refusing to follow it would make the scanner wrong
        // about a working idiom, and one that is wrong about working code is one
        // the next person deletes.
        if (envVal && /^[A-Za-z_$][\w$]*$/.test(envVal)) {
          // The LAST declaration before this call, not the first in the file: a
          // spec may build several `const env = …` objects, and resolving to
          // whichever came first would answer about the wrong one.
          const DECL = new RegExp(`\\b(?:const|let|var)\\s+${envVal}\\s*=`, "g");
          let declIdx = -1, d;
          while ((d = DECL.exec(src)) && d.index < m.index) declIdx = d.index;
          if (declIdx >= 0) {
            const eq = src.indexOf("=", declIdx);
            let k = eq + 1;
            while (k < src.length && /\s/.test(src[k])) k++;
            const init = src[k] === "{"
              ? (balanced(src, k) ?? "")
              : src.slice(k, src.indexOf(";", k) < 0 ? k + 200 : src.indexOf(";", k));
            // …plus any write to the object BETWEEN its declaration and the
            // hand-off. Scoped to that region rather than the whole file, so a
            // decision taken for one child cannot vouch for a sibling.
            const region = src.slice(declIdx, m.index);
            const undecided = REQUIRED_DIR_VARS.filter((V) => {
              const mutated = new RegExp(`(?:delete\\s+)?\\b${envVal}\\s*\\.\\s*${V}\\b`).test(region)
                || new RegExp(`\\b${envVal}\\s*\\[\\s*["']${V}["']\\s*\\]`).test(region);
              return !(decides(init, V) || mutated);
            });
            if (!undecided.length) continue;
            bad.push(`${f}:${line} (undecided: ${undecided.join(", ")})`);
            continue;
          }
        }
        const missing = REQUIRED_DIR_VARS.filter((V) => !decides(envVal || optsBody || "", V));
        bad.push(`${f}:${line} (undecided: ${missing.join(", ") || "env not found"})`);
      }
    }

    // ANTI-VACUITY. A rename of `spawn`/`execFileSync`, or of `process.execPath`,
    // would empty the match set and pass in silence — which is exactly the
    // failure this exists to catch.
    expect(sites, "no node child processes were found in tests/ — the spawn shape changed and this "
      + "scanner is now matching nothing").toBeGreaterThanOrEqual(25);
    expect(bad,
      "these spawn a node child without deciding one of the required directory variables, so the "
      + "child inherits the runner's. `db.js` opens the database at REQUIRE time, and server.js "
      + "SWEEPS the uploads directory at boot — so a child with the wrong one attaches to a live "
      + "deployment's SQLite file, or DELETES from its upload volume, silently. Add "
      + "`<VAR>: <a throwaway dir>` to that spawn's `env` (or `delete env.<VAR>` if the child is "
      + "meant to have none):\n  " + bad.join("\n  ")
    ).toEqual([]);
  });

  test("v8.12.6: the unverified-account reaper's gate has one definition, read by the sweep", () => {
    // Anything that says WHEN or WHETHER the reaper takes an account is only true
    // while it asks the SAME question the sweep asks, so every reader interpolates
    // REAP_GATE_SQL rather than carrying a copy. A hand-copied gate is
    // byte-identical on the day it is written — no behavioural test can tell —
    // and drifts on the day somebody exempts a new account class from the sweep
    // and forgets the other copy. The one reader today is the sweep (the removal
    // date nothing called was deleted: operator ruling, 14 Nov 2026).
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const files = ["server.js", "db.js",
      ...fs.readdirSync(pathMod.join(root, "lib")).filter(f => f.endsWith(".js")).map(f => `lib/${f}`),
      ...fs.readdirSync(pathMod.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`)];
    // The FINGERPRINT is the predicate that makes the population, not a JOIN.
    const GATE = /approved\s*=\s*0\s+AND\s+registered_via\s*=\s*'manual'/g;
    const copies = [];
    for (const rel of files) {
      const n = (_stripJsCommentsKeepLines(fs.readFileSync(pathMod.join(root, rel), "utf8")).match(GATE) || []).length;
      for (let i = 0; i < n; i++) copies.push(rel);
    }
    expect(copies, "the reaper gate is written out exactly once, in lib/account-reaper.js").toEqual(["lib/account-reaper.js"]);
    const reaper = _stripJsCommentsKeepLines(fs.readFileSync(pathMod.join(root, "lib", "account-reaper.js"), "utf8"));
    expect((reaper.match(/\$\{\s*REAP_GATE_SQL\s*\}/g) || []).length,
      "the sweep's SELECT interpolates the one definition").toBe(1);
    // The deleted helper stays deleted: the module neither defines nor exports
    // it (CONTROL: the export line is found, and still names the sweep).
    const _exportsLine = (reaper.match(/module\.exports\s*=\s*\{[^}]*\}/) || [""])[0];
    expect(_exportsLine, "CONTROL: the export line was found and names the sweep").toMatch(/\bsweepUnverifiedAccounts\b/);
    expect(/\bscheduledRemovalAt\b/.test(reaper), "the uncalled removal-date helper is gone").toBe(false);
  });

  // v8.12.7 (external audit F2) — the realm-account ledger. Two arms, both over
  // comment-stripped, line-preserving source: every site narrates the rule it
  // keeps, quoting the call names matched here (v7.21.13).
  function _f2Block(src, headerAt, what) {
    // A block by INDENTATION: these bodies carry braces inside log strings and
    // template literals, and the codebase closes every block at the indent it
    // opened at.
    if (headerAt < 0) throw new Error(`anchor missing: ${what} — re-anchor this lock rather than weakening it`);
    const lineStart = src.lastIndexOf("\n", headerAt) + 1;
    const indent = src.slice(lineStart, headerAt).match(/^[ \t]*/)[0];
    const close = src.indexOf(`\n${indent}}`, headerAt);
    if (close < 0) throw new Error(`no closing brace at the header's indent: ${what}`);
    return src.slice(headerAt, close + indent.length + 2);
  }
  function _f2ServerSources() {
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const rels = ["server.js", "db.js",
      ...fs.readdirSync(pathMod.join(root, "lib")).filter(f => f.endsWith(".js")).map(f => `lib/${f}`),
      ...fs.readdirSync(pathMod.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`)];
    return rels.map(rel => [rel, _stripJsCommentsKeepLines(fs.readFileSync(pathMod.join(root, rel), "utf8"))]);
  }

  // The Checkmarx One removal list's three enums are the runner's OWN tables:
  // `held_reason` the overridable holds plus the one that is not, `reason`
  // every key of WITHDRAWAL_REMEDY (the copy the list sends beside each row),
  // `held_signal` every key of ADOPTION_SIGNAL_TEXT — and every sign the code
  // can record has its words there. A hold or a sign added to the code alone
  // ships an undocumented value (and a row the card cannot explain); one added
  // to swagger alone documents a value nothing sends. Comments stripped first
  // (the shared stripper), with floors so a renamed table cannot pass empty.
  test("CxOne removals: swagger's held_reason, reason and held_signal enums are the runner's own tables, and every sign it can record has words", () => {
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const { stripJsComments } = require("./doc-registry");
    const W = stripJsComments(fs.readFileSync(pathMod.join(root, "lib/cxone-withdraw.js"), "utf8"));
    const IDN = stripJsComments(fs.readFileSync(pathMod.join(root, "lib/cxone-identity.js"), "utf8"));
    const literals = (txt) => [...String(txt || "").matchAll(/"([a-z_]+)"/g)].map(m => m[1]);
    const tableKeys = (name) => {
      const at = W.search(new RegExp(String.raw`const\s+${name}\s*=\s*Object\.freeze\(\{`));
      expect(at, `${name} is defined in lib/cxone-withdraw.js`).toBeGreaterThan(-1);
      const body = W.slice(at, W.indexOf("});", at));
      return [...body.matchAll(/^\s*([a-z_]+)\s*:/gm)].map(m => m[1]);
    };
    const holdsSrc = (W.match(/const\s+OVERRIDABLE_HOLDS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/) || [])[1];
    const overridable = literals(holdsSrc);
    const remedyKeys = tableKeys("WITHDRAWAL_REMEDY");
    const signalKeys = tableKeys("ADOPTION_SIGNAL_TEXT");
    expect(overridable.length, "anti-vacuity: the overridable holds were parsed").toBeGreaterThanOrEqual(5);
    expect(remedyKeys.length, "anti-vacuity: the remedy table was parsed").toBeGreaterThanOrEqual(16);
    expect(signalKeys.length, "anti-vacuity: the sign table was parsed").toBeGreaterThanOrEqual(9);

    // What the code can record: every literal hold, and every sign — the ones the
    // runner assigns, and the classifier's verdicts other than its two non-signs.
    const heldLiterals = [...W.matchAll(/_hold\(\s*row\s*,\s*claim\s*,\s*"([a-z_]+)"/g)].map(m => m[1]);
    const runnerSigns = [...W.matchAll(/\badopted\s*=\s*"([a-z_]+)"/g), ...W.matchAll(/\?\s*"([a-z_]+)"\s*:\s*\(?\s*_emailChangedSince[^?]*\?\s*"([a-z_]+)"/g)]
      .flatMap(m => m.slice(1).filter(Boolean));
    const verdicts = [...IDN.matchAll(/verdict\s*:\s*"([a-z_]+)"/g)].map(m => m[1]).filter(v => v !== "malformed" && v !== "clean");
    expect(heldLiterals.length, "anti-vacuity: the runner's holds were found").toBeGreaterThanOrEqual(4);
    expect(runnerSigns.length + verdicts.length, "anti-vacuity: the signs were found").toBeGreaterThanOrEqual(9);

    const sw = fs.readFileSync(pathMod.join(root, "swagger.yaml"), "utf8");
    const at = sw.indexOf("\n    CxOneWithdrawalRow:\n");
    expect(at, "swagger.yaml defines CxOneWithdrawalRow").toBeGreaterThan(-1);
    const end = sw.slice(at + 1).search(/\n    [A-Za-z]\w*:\n/);
    const schema = sw.slice(at, end < 0 ? undefined : at + 1 + end);
    const enumOf = (prop) => {
      const m = new RegExp(String.raw`\n        ${prop}:\n(?:          [^\n]*\n)*?          enum: \[([^\]]*)\]`).exec(schema);
      expect(m, `swagger CxOneWithdrawalRow.${prop} has an enum`).toBeTruthy();
      return m[1].split(",").map(x => x.trim()).filter(Boolean);
    };
    const sorted = (xs) => [...new Set(xs)].sort();
    const bad = [];
    const same = (what, a, b) => { if (JSON.stringify(sorted(a)) !== JSON.stringify(sorted(b))) bad.push(`${what}: swagger [${sorted(a)}] vs code [${sorted(b)}]`); };
    same("held_reason = OVERRIDABLE_HOLDS + provenance_unconfirmed", enumOf("held_reason"), [...overridable, "provenance_unconfirmed"]);
    same("reason = the keys of WITHDRAWAL_REMEDY", enumOf("reason"), remedyKeys);
    same("held_signal = the keys of ADOPTION_SIGNAL_TEXT", enumOf("held_signal"), signalKeys);
    for (const h of heldLiterals) if (!enumOf("held_reason").includes(h)) bad.push(`the runner holds for "${h}", which swagger's held_reason does not list`);
    for (const sgn of [...runnerSigns, ...verdicts]) if (!signalKeys.includes(sgn)) bad.push(`the code can record the sign "${sgn}", which ADOPTION_SIGNAL_TEXT has no words for`);
    expect(bad, bad.join("\n")).toEqual([]);
  });

  test("v8.12.7 (F2): a deletion stamps its realm accounts INSIDE the cascade transaction, kicks the runner only after the commit, and a ledger row ends only when its account is gone, passes to a living participant or is marked removed — never for its age", () => {
    // THE STAMP IS WHAT THE RUNNER ACTS ON — never a missing users row, which an
    // integrity failure, a partial restore or a hand-edit can also produce. So it
    // must commit WITH the deletion: stamped before the transaction, a rollback
    // leaves a living participant's account marked for removal from the
    // customer's realm; stamped after it, a crash between the two leaves an
    // erased participant's account behind for ever. The KICK is the mirror
    // image — from inside the transaction, a run could start on a stamp that is
    // then rolled back.
    //
    // AND THE ROWS ARE NEVER DELETED BY THE CASCADE. A ledger row is the only
    // record that the platform made that realm account; deleting it with the
    // participant is exactly the pre-v8.12.7 state, where nothing could
    // withdraw it. The runner deletes a row once the account is gone; the
    // ledger's own claim-guarded delete serves the in-flight withdrawal.
    const sources = _f2ServerSources();
    const reaper = (sources.find(([rel]) => rel === "lib/account-reaper.js") || [])[1];
    expect(reaper, "lib/account-reaper.js exists").toBeTruthy();
    const fnHdr = reaper.search(/^function\s+deleteUserCascade\s*\(/m);
    const fn = _f2Block(reaper, fnHdr, "function deleteUserCascade(");
    const txnHdr = fn.search(/const\s+txn\s*=\s*db\.transaction\(\s*\(\)\s*=>\s*\{/);
    const txnBody = _f2Block(fn, txnHdr, "const txn = db.transaction(() => {");
    const callAt = fn.search(/\n\s*txn\(\)\s*;/);
    const stampAt = txnBody.search(/=\s*stampDeletionForUser\(\s*db\s*,\s*userId\s*,/);
    const usersAt = txnBody.search(/DELETE FROM users WHERE id\s*=\s*\?/);
    const kicks = [...fn.matchAll(/\bscheduleRealmWithdrawal\s*\(/g)].map(m => m.index);

    const deleters = [];
    for (const [rel, src] of sources) {
      const n = (src.match(/DELETE\s+FROM\s+cxone_realm_accounts\b/gi) || []).length;
      for (let i = 0; i < n; i++) deleters.push(rel);
    }
    // NO LEDGER ROW ENDS FOR ITS AGE. A row ends when its account is gone
    // (the ledger's owner-bound delete, called by the runner's `_gone` and by the
    // provisioning job's own withdrawal in `_abandon`), when it passes to a
    // living participant (`transferTo`, the one writer that un-pends a row), or
    // when a superadmin presses Mark removed (its route the only caller). An
    // age-based drop came back as a ledger DELETE in the runner; the softer forms
    // are an un-pend that turns the row "unmarked", a runner loop calling either
    // ender, or the table joining the event-retention purge.
    const srcOf = (rel) => (sources.find(([r]) => r === rel) || [])[1] || "";
    const W = srcOf("lib/cxone-withdraw.js"), L = srcOf("lib/cxone-ledger.js"), C = srcOf("lib/cxone.js");
    const span = (s, re, what) => { const at = s.search(re); return [at, at + _f2Block(s, at, what).length]; };
    const within = ([a, b], i) => i >= a && i < b;
    const hits = (s, re) => [...s.matchAll(re)].map(m => m.index);
    const LEDGER_DELETE = /DELETE\s+FROM\s+cxone_realm_accounts\b/gi;
    const dismissAt = span(W, /^function\s+dismissCxOneWithdrawal\s*\(/m, "function dismissCxOneWithdrawal(");
    const goneAt = span(W, /^function\s+_gone\s*\(/m, "function _gone(");
    const runAt = span(W, /^async\s+function\s+runWithdrawals\s*\(/m, "async function runWithdrawals(");
    const ownedAt = span(L, /^function\s+deleteOwned\s*\(/m, "function deleteOwned(");
    const forgetAt = span(L, /^function\s+forgetGoneAccount\s*\(/m, "function forgetGoneAccount(");
    const backstopAt = span(C, /^function\s+accountGoneFromRealm\s*\(/m, "function accountGoneFromRealm(");
    const transferAt = span(L, /^function\s+transferTo\s*\(/m, "function transferTo(");
    const abandonAt = span(C, /\bconst\s+_abandon\s*=\s*async\s*\(/, "const _abandon = async (");
    const unpends = [], dismissCalls = [], ownedCalls = [], forgetCalls = [];
    for (const [rel, src] of sources) {
      for (const i of hits(src, /pending_since\s*=\s*NULL\b/gi)) unpends.push([rel, i]);
      for (const i of hits(src, /(?<!function\s)\bdismissCxOneWithdrawal\s*\(/g)) dismissCalls.push([rel, i]);
      for (const i of hits(src, /(?<!function\s)\bdeleteOwned\s*\(/g)) ownedCalls.push([rel, i]);
      for (const i of hits(src, /(?<!function\s)\bforgetGoneAccount\s*\(/g)) forgetCalls.push([rel, i]);
    }
    const retention = srcOf("lib/event-retention.js");
    const runBody = W.slice(runAt[0], runAt[1]);
    const loopAt = span(runBody, /\bwhile\s*\(/, "the selection loop (while) in runWithdrawals");
    const noteCalls = hits(W, /(?<!function\s)\b_notePastRetention\s*\(/g);

    const checks = {
      "every ledger DELETE in the runner is Mark removed's (dismissCxOneWithdrawal), and there is one":
        hits(W, LEDGER_DELETE).length >= 1 && hits(W, LEDGER_DELETE).every(i => within(dismissAt, i)),
      // Both are "the account is gone": `forgetGoneAccount` is the row re-keyed to
      // somebody living before the realm answered that its account was removed.
      "every ledger DELETE in the ledger module is the owner-bound deleteOwned or forgetGoneAccount, and each has one":
        hits(L, LEDGER_DELETE).some(i => within(ownedAt, i)) && hits(L, LEDGER_DELETE).some(i => within(forgetAt, i))
        && hits(L, LEDGER_DELETE).every(i => within(ownedAt, i) || within(forgetAt, i)),
      "forgetGoneAccount is called only by accountGoneFromRealm — on the realm's own answer that the account is gone":
        forgetCalls.length >= 1 && forgetCalls.every(([rel, i]) => rel === "lib/cxone.js" && within(backstopAt, i)),
      "a row is un-pended (pending_since = NULL) only by transferTo":
        unpends.length >= 1 && unpends.every(([rel, i]) => rel === "lib/cxone-ledger.js" && within(transferAt, i)),
      "Mark removed is called only from its route in routes/admin-misc.js":
        dismissCalls.length >= 1 && dismissCalls.every(([rel]) => rel === "routes/admin-misc.js"),
      "the owner-bound ledger delete is called only by the runner's _gone and the provisioning job's _abandon":
        ownedCalls.some(([rel, i]) => rel === "lib/cxone-withdraw.js" && within(goneAt, i))
        && ownedCalls.some(([rel, i]) => rel === "lib/cxone.js" && within(abandonAt, i))
        && ownedCalls.every(([rel, i]) => (rel === "lib/cxone-withdraw.js" && within(goneAt, i)) || (rel === "lib/cxone.js" && within(abandonAt, i))),
      "the event-retention purge never names the ledger table (and still lists its own tables)":
        /EVENT_TABLES\s*=/.test(retention) && !/cxone_realm_accounts/.test(retention),
      "the past-retention note is called once, from runWithdrawals, AFTER the selection loop":
        noteCalls.length === 1 && within(runAt, noteCalls[0]) && noteCalls[0] - runAt[0] >= loopAt[1],
      "the stamp's count is captured, inside the cascade transaction": stampAt > -1,
      // In the SAME transaction as the users-row DELETE, in either order: inside
      // one transaction the order is unobservable, so demanding "before" would
      // make this scanner wrong about working code — the property is that the
      // two commit or roll back together.
      "…in the same transaction that deletes the users row": stampAt > -1 && usersAt > -1,
      "the transaction is invoked (`txn();`) after its definition": callAt > txnHdr,
      "the runner is kicked from deleteUserCascade": kicks.length >= 1,
      "…and only AFTER the commit — never inside or before the transaction": kicks.length >= 1 && kicks.every(k => k > callAt),
      "no ledger row is deleted anywhere but lib/cxone-ledger.js and lib/cxone-withdraw.js":
        deleters.every(rel => rel === "lib/cxone-ledger.js" || rel === "lib/cxone-withdraw.js"),
      // Anti-vacuity: a rename of the table empties the match above and passes in silence.
      "…and both of those really do delete ledger rows (the match is live)":
        deleters.includes("lib/cxone-ledger.js") && deleters.includes("lib/cxone-withdraw.js"),
    };
    const failing = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    expect(failing, `the cascade lost the realm-account ledger's placement (deleters: ${JSON.stringify(deleters)}):\n  ` + failing.join("\n  ")).toEqual([]);
  });

  test("v8.12.7 (F2): the withdrawal runner reaches a realm under test only on the harness's own opt-in, and every run goes through that gate", () => {
    // The shared test server must never call a realm — a developer's shell can
    // carry real CxOne credentials. `_autorunAllowed` is the gate, read on every
    // call; the spawned harness sets the opt-in in ITS OWN process. The gate is
    // only a gate if nothing goes round it, so every `_kick(` must sit in one of
    // the two functions that ask it first (`scheduleRealmWithdrawal`, or the
    // sweeper, which returns under test before it kicks — pinned in
    // periodic-sweeps.api.spec.js), and nothing outside the module may start a
    // run directly. tests/ may: the harness drives `runWithdrawals` on purpose.
    const sources = _f2ServerSources();
    const w = (sources.find(([rel]) => rel === "lib/cxone-withdraw.js") || [])[1];
    expect(w, "lib/cxone-withdraw.js exists").toBeTruthy();
    const gate = _f2Block(w, w.search(/^function\s+_autorunAllowed\s*\(/m), "function _autorunAllowed(");
    const sched = _f2Block(w, w.search(/^function\s+scheduleRealmWithdrawal\s*\(/m), "function scheduleRealmWithdrawal(");
    const sweeper = _f2Block(w, w.search(/^function\s+startCxOneWithdrawalSweeper\s*\(/m), "function startCxOneWithdrawalSweeper(");
    const kicker = _f2Block(w, w.search(/^function\s+_kick\s*\(/m), "function _kick(");
    const kickCalls = [...w.matchAll(/(?<!function\s)\b_kick\s*\(/g)].length;
    const runCalls = [...w.matchAll(/(?<!function\s)\brunWithdrawals\s*\(/g)].length;
    const outside = sources.filter(([rel, src]) => rel !== "lib/cxone-withdraw.js"
      && /\b(runWithdrawals|_kick)\s*\(/.test(src)).map(([rel]) => rel);
    const serverEnv = require("fs").readFileSync(require("path").join(__dirname, "server-env.js"), "utf8");

    const checks = {
      "_autorunAllowed is on unless NODE_ENV is test, and under test ONLY on the explicit opt-in":
        /return\s+process\.env\.NODE_ENV\s*!==\s*"test"\s*\|\|\s*process\.env\.CXONE_WITHDRAWAL_AUTORUN_IN_TEST\s*===\s*"1"\s*;/.test(gate),
      "scheduleRealmWithdrawal asks the gate as its FIRST statement":
        // (Its one optional parameter is the clock an armed re-read fires with.)
        /^function\s+scheduleRealmWithdrawal\s*\([^)]*\)\s*\{\s*if\s*\(\s*!_autorunAllowed\(\s*\)\s*\)\s*return\s+null\s*;/.test(sched),
      // Anti-vacuity floors: a rename would leave nothing to count.
      "every _kick( call sits in scheduleRealmWithdrawal or the sweeper (none elsewhere)":
        kickCalls >= 2 && kickCalls === [...(sched + sweeper).matchAll(/\b_kick\s*\(/g)].length,
      "every runWithdrawals( call sits inside _kick":
        runCalls >= 1 && runCalls === [...kicker.matchAll(/\brunWithdrawals\s*\(/g)].length,
      "nothing on the server outside the module starts a run directly": outside.length === 0,
      "the shared test server's env pins the opt-in OFF, whatever the developer's shell exports":
        /CXONE_WITHDRAWAL_AUTORUN_IN_TEST\s*:\s*""/.test(serverEnv),
    };
    const failing = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
    expect(failing, `the withdrawal runner's test gate has a way round it (outside callers: ${JSON.stringify(outside)}):\n  ` + failing.join("\n  ")).toEqual([]);
  });

  test("v8.12.6: every wording a start reminder can be sent with is documented, subject AND body, in every place that lists them", () => {
    // THE DEFECT. `reminderLeadTime` (lib/time.js) returned more wordings than
    // swagger, EMAIL_RULES §7 and README listed, so a reader expected "starts in
    // about N minutes" from a mail that said something else. Nothing tied the
    // lists to the function, so a new band would drift the same way. It now
    // returns THREE (an hour, N minutes, a minute) and null once the start is
    // reached: no reminder is mailed after the start (operator ruling, 25 Nov
    // 2026), so every list must say that too, and none may still name the
    // retired "has started" wording.
    //
    // THE WORDINGS ARE READ OUT OF THE FUNCTION, never retyped here: every
    // `{ subject: …, body: … }` it returns, comments stripped, `${min}` → `N`.
    // The participant guide says it in a participant's words — a real number
    // ("20 minutes") where the others say `N` — so it is held to the fixed
    // wordings plus "a number of minutes", not to the literal `N`.
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const src = _stripJsCommentsKeepLines(fs.readFileSync(pathMod.join(root, "lib", "time.js"), "utf8"));
    const fn = /function\s+reminderLeadTime\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(src);
    expect(fn, "reminderLeadTime must exist in lib/time.js").toBeTruthy();
    const pairs = new Map();
    for (const m of fn[1].matchAll(/\{\s*subject:\s*(["`])(.*?)\1\s*,\s*body:\s*(["`])(.*?)\3\s*\}/g)) {
      const norm = s => s.replace(/\$\{\s*min\s*\}/g, "N");
      pairs.set(norm(m[2]), norm(m[4]));
    }
    // ANTI-VACUITY: the three bands (the unusable-start fallback repeats the hour).
    expect(pairs.size, `the returned wordings were not found — the extractor matches nothing: ${[...pairs.keys()].join(" | ")}`).toBeGreaterThanOrEqual(3);
    // The too-late answer is the ruling's, so it is held here too: a start
    // already reached answers null (never a wording), and every list says so.
    expect(/if\s*\(\s*ms\s*<=\s*0\s*\)\s*return\s+null\s*;/.test(fn[1]),
      "reminderLeadTime answers null once the start is reached (no reminder is mailed after the start)").toBe(true);
    const flat = t => t.replace(/\n>\s?/g, " ").replace(/\s+/g, " ");
    const swagger = fs.readFileSync(pathMod.join(root, "swagger.yaml"), "utf8");
    const at = swagger.indexOf("\n  /api/competitions/{id}/reminder:");
    expect(at, "the reminder path is in swagger").toBeGreaterThan(0);
    const next = swagger.indexOf("\n  /api/", at + 10);
    const post = swagger.slice(at, next).split(/\n    post:/)[1] || "";
    expect(post, "the reminder POST operation was found").toMatch(/Request email reminder/);
    const docs = {
      "swagger.yaml POST /api/competitions/{id}/reminder": flat(post),
      "EMAIL_RULES.md §7 (the reminder dispatcher row)": flat((fs.readFileSync(pathMod.join(root, "EMAIL_RULES.md"), "utf8").split("\n").find(l => /reminder dispatcher/.test(l) && /`reminder`/.test(l))) || ""),
      "README.md (Email Reminders)": flat((fs.readFileSync(pathMod.join(root, "README.md"), "utf8").split("### Email Reminders")[1] || "").split("\n\n")[1] || ""),
    };
    const bad = [];
    for (const [where, text] of Object.entries(docs)) {
      expect(text.length, `precondition: ${where} was found`).toBeGreaterThan(40);
      for (const [subject, body] of pairs) {
        if (!text.includes(`"${subject}"`)) bad.push(`${where} never names the subject wording "${subject}"`);
        if (!text.includes(`"${body}"`)) bad.push(`${where} never names the body wording "${body}"`);
      }
    }
    // The participant's guide, in a participant's words.
    const guide = flat((fs.readFileSync(pathMod.join(root, "docs", "user-guide", "participant.md"), "utf8").split("> **Set a reminder.**")[1] || "").split("\n\n")[0]);
    expect(guide.length, "precondition: the guide's Set-a-reminder callout was found").toBeGreaterThan(40);
    for (const subject of pairs.keys()) {
      const re = new RegExp(`"${subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\bN\b/, "\\d+")}"`);
      if (!re.test(guide)) bad.push(`docs/user-guide/participant.md (Set a reminder) never names the subject wording "${subject}"`);
    }
    for (const [where, text] of Object.entries({ ...docs, "docs/user-guide/participant.md (Set a reminder)": guide })) {
      if (!/not sent once the start has passed/i.test(text)) bad.push(`${where} never says a reminder is not sent once the start has passed`);
      if (/"has started"/.test(text)) bad.push(`${where} still names the retired wording "has started"`);
    }
    expect(bad, "a start reminder can be sent with each of these wordings (lib/time.js reminderLeadTime), so every place that lists them must list all of them:\n  " + bad.join("\n  ")).toEqual([]);
  });
});


test.describe("Competition-state cache invalidation (v6.3.3)", () => {
  test("single-slot competition flips to ended via auto-end + subsequent status read is immediate, not up to 2s stale", async () => {
    // Regression: several write paths on competitions.ended_at used to miss
    // _invalidateCompetitionCache, so a participant-facing /api/tasks or
    // /api/leaderboard read within the 2-second TTL could still see
    // ended_at=NULL after the auto-end had committed. The test forces a
    // direct cache-poisoning (read to populate) + DB write-without-cached-
    // read, then hits /api/competitions/:id/status (participant-facing via
    // /api/status after select-competition) — which must reflect the new
    // ended state without waiting out the TTL.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");

    // Dedicated single-slot comp so we don't stomp the shared fixtures.
    const t0 = Date.now();
    const create = await sa.post("/api/admin/competitions", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { name: `CacheInvalidation-${t0}`, start_time: new Date(t0 - 60_000).toISOString(), duration_minutes: 120 },
    });
    const compId = (await create.json()).competition.id;

    // Prime the competition-cache: GET the comp list (admin path calls
    // getCompetition internally through requireCompetitionContext for any
    // fetched row).
    await sa.get("/api/admin/competitions");

    // Now the admin ends the competition via /end-now. The handler MUST
    // invalidate the cache so the next admin fetch shows ended_at set.
    const endR = await sa.post(`/api/admin/competitions/${compId}/end-now`, {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: {},
    });
    expect(endR.ok()).toBe(true);

    // Immediately re-read — admin API should show status:"ended".
    const list = await (await sa.get("/api/admin/competitions")).json();
    const afterRow = list.find(c => c.id === compId);
    expect(afterRow, "competition row missing after end-now").toBeTruthy();
    expect(afterRow.status).toBe("ended");

    await sa.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });

  test("revive via competition-edit duration extension flips status back immediately, not up to 2s stale", async () => {
    // Mirror of the ended_at=NULL path: a comp that was ended is revived by
    // extending its duration. The edit handler at server.js:4261-4265 must
    // invalidate the cache. We keep this simpler than the assignment-revival
    // path (which needs multi-step scaffolding) because the
    // _invalidateCompetitionCache() call is structurally identical across
    // all the revival sites — proving one exercises the pattern.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");

    const t0 = Date.now();
    // Live-now comp we can end and then revive by extending.
    const create = await sa.post("/api/admin/competitions", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { name: `ReviveCache-${t0}`, start_time: new Date(t0 - 60_000).toISOString(), duration_minutes: 5 },
    });
    const compId = (await create.json()).competition.id;

    // End it.
    const endR = await sa.post(`/api/admin/competitions/${compId}/end-now`, {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: {},
    });
    expect(endR.ok()).toBe(true);

    // Prime the cache with the ended-state read.
    let list = await (await sa.get("/api/admin/competitions")).json();
    let row = list.find(c => c.id === compId);
    expect(row.status).toBe("ended");

    // Extend duration — server.js PUT handler detects "was ended + new
    // scheduled end in the future" and clears ended_at via the revive
    // transaction. MUST invalidate the cache so the next admin read
    // shows the revived status immediately.
    const putR = await sa.put(`/api/admin/competitions/${compId}`, {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { duration_minutes: 240 },
    });
    expect(putR.ok()).toBe(true);

    list = await (await sa.get("/api/admin/competitions")).json();
    row = list.find(c => c.id === compId);
    expect(row.ended_at, "ended_at should be cleared after revival").toBeNull();
    expect(row.status).toBe("live");

    await sa.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });

  test("extending a TIME-EXPIRED single-slot comp revives it to LIVE with allSolved:false — never a false 'all solved'", async () => {
    // Repro of the reported bug: an admin extends the end time of a competition
    // that ended simply because its scheduled time elapsed (a "time-expired"
    // comp). For such a comp the status is purely time-derived and ended_at stays
    // NULL — the scheduler records the auto_ended EVENT but never stamps ended_at
    // (lib/scheduler.js). The server's revive block (routes/competitions.js) is
    // gated on comp.ended_at, so for a time-expired comp it is SKIPPED entirely:
    // allSolved is never computed (stays false) and the status flips back to live
    // via time arithmetic. The corrected admin edit-confirm copy + post-save toast
    // depend on exactly this contract — the bug was the UI falsely asserting
    // "all participants solved all challenges" and "it will stay ended".
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const t0 = Date.now();
    // start 2h ago + 30-min duration → already ended by time, ended_at NULL.
    const create = await sa.post("/api/admin/competitions", {
      headers: h,
      data: { name: `TimeExpired-${t0}`, start_time: new Date(t0 - 120 * 60_000).toISOString(), duration_minutes: 30 },
    });
    expect(create.ok(), `create failed: ${create.status()} ${await create.text()}`).toBeTruthy();
    const compId = (await create.json()).competition.id;
    try {
      let row = (await (await sa.get("/api/admin/competitions")).json()).find(c => c.id === compId);
      expect(row.status, "freshly time-expired comp is ended").toBe("ended");
      expect(row.ended_at, "a time-expired comp has ended_at NULL (scheduler never stamps it)").toBeNull();
      expect(row.ended_manually, "time-expired is NOT a manual end").toBeFalsy();

      // Extend the duration so the scheduled end is back in the future.
      const putR = await sa.put(`/api/admin/competitions/${compId}`, {
        headers: h, data: { duration_minutes: 600 },
      });
      expect(putR.ok(), `put failed: ${putR.status()} ${await putR.text()}`).toBeTruthy();
      const put = await putR.json();
      // The lock: NO false all-solved, and it revives to live.
      expect(put.allSolved, "a time-expired comp must never be reported all-solved").toBe(false);
      expect(put.statusChanged).toBe(true);
      expect(put.oldStatus).toBe("ended");
      expect(put.newStatus, "extending flips a time-expired comp back to live (time-derived)").toBe("live");

      row = (await (await sa.get("/api/admin/competitions")).json()).find(c => c.id === compId);
      expect(row.status).toBe("live");
      expect(row.ended_at, "ended_at stays NULL — it was never stamped").toBeNull();
    } finally {
      await sa.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      await sa.dispose();
    }
  });

  test("a MANUALLY-ended single-slot comp revives on duration-extend EVEN when all participants solved everything (v7.7.x — uniform with the timeslot path)", async () => {
    // The manual-end / all-solved asymmetry, resolved as option 1: a comp the
    // admin manually ended is a deliberate stop, and extending its duration is a
    // deliberate "give it more time", so it revives regardless of solve state —
    // mirroring the timeslot revive (routes/sessions.js), which already skips the
    // all-solved gate for manually-ended slots. Pre-v7.7.x this single-slot case
    // stayed ended because the gate was applied unconditionally; this test FAILS
    // on that old behaviour (it would report allSolved:true and stay ended).
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const t0 = Date.now();
    const create = await sa.post("/api/admin/competitions", {
      headers: h, data: { name: `ManualAllSolved-${t0}`, start_time: new Date(t0 - 5 * 60_000).toISOString(), duration_minutes: 60 },
    });
    expect(create.ok(), `create failed: ${create.status()} ${await create.text()}`).toBeTruthy();
    const compId = (await create.json()).competition.id;
    try {
      // One published task assigned to the comp.
      const tr = await sa.post("/api/admin/tasks", { headers: h, data: {
        title: `ManualAllSolved task ${t0}`, description: "<p>x</p>", difficulty: "easy",
        answer_type: "text", correct_answer: "win", explanation: "<p>e</p>", hint: "h", status: "published",
      }});
      const taskId = (await tr.json()).id;
      await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: h, data: { competitionIds: [compId] } });

      // A fresh, guaranteed-non-staff participant (shared seed users can be
      // staff-tagged by other tests, which would exclude them from the all-solved
      // query and silently defeat the discrimination).
      const pEmail = `manualsolved_${t0}@acme.com`;
      const reg = await registerPost(sa, "/api/register", { headers: h, data: {
        firstName: "Man", lastName: "Solved", nickname: `mansolved_${t0}`, email: pEmail,
        company: "Acme", title: "Engineer", avatar: "🦊", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "New York",
      }});
      expect(reg.ok(), `register failed: ${reg.status()} ${await reg.text()}`).toBeTruthy();
      const pid = (await (await sa.get("/api/admin/participants?limit=1000")).json()).participants.find(p => p.email === pEmail).id;
      await sa.post(`/api/admin/participants/${pid}/verify`, { headers: h });
      await sa.post(`/api/admin/participants/${pid}/approve`, { headers: h });
      const assignR = await sa.post("/api/admin/competitions/assign", { headers: h, data: { userIds: [pid], competitionIds: [compId] } });
      expect(assignR.ok()).toBeTruthy();

      // Manually end the comp (sets ended_manually=1 + busts the comp cache).
      const endR = await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: h, data: {} });
      expect(endR.ok()).toBeTruthy();

      // Make it genuinely all-solved by writing the correct submission DIRECTLY —
      // going through the submit endpoint would fire the all-solved auto-end and
      // clobber the manual end. This is exactly the state that pre-v7.7.x kept a
      // single-slot comp ended on extend.
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH);
      const nowIso = new Date().toISOString();
      db.prepare("INSERT INTO submissions (id, user_id, task_id, competition_id, answer, is_correct, points_delta, submitted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(`mansolved-sub-${t0}`, pid, taskId, compId, "win", 1, 50, nowIso, nowIso);
      db.close();

      let row = (await (await sa.get("/api/admin/competitions")).json()).find(c => c.id === compId);
      expect(row.status, "comp is ended after end-now").toBe("ended");
      expect(row.ended_manually, "and ended_manually=1").toBeTruthy();

      // Extend the duration → option 1: a MANUAL end revives regardless of all-solved.
      const putR = await sa.put(`/api/admin/competitions/${compId}`, { headers: h, data: { duration_minutes: 600 } });
      expect(putR.ok(), `put failed: ${putR.status()} ${await putR.text()}`).toBeTruthy();
      const put = await putR.json();
      expect(put.allSolved, "the all-solved gate is skipped for a manual end → reported false").toBe(false);
      expect(put.statusChanged).toBe(true);
      expect(put.oldStatus).toBe("ended");
      expect(put.newStatus, "a manually-ended comp revives to live on extend even when all-solved").toBe("live");
      row = (await (await sa.get("/api/admin/competitions")).json()).find(c => c.id === compId);
      expect(row.status).toBe("live");
      expect(row.ended_at, "ended_at cleared on revive").toBeNull();
    } finally {
      await sa.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      await sa.dispose();
    }
  });
});


test.describe("Scanner protection middleware (v6.3.6)", () => {
  test("middleware is installed with sensible thresholds and emits an audit event on block", () => {
    // Behavioural test would require an isolated server without
    // RATE_LIMIT_DISABLED=1 (which the per-worker harness sets so the
    // many-failed-attempts test patterns stay green). Instead: verify
    // the middleware is present in server.js with (a) the block-state
    // tracker, (b) the 429 response shape, and (c) the
    // recordOrphanedAuditEvent("security", …, "scanner_blocked", …)
    // emission — so a future regression that silently removes the
    // audit mirror is caught at CI-time.
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "server.js"), "utf8");
    // Block-state tracker.
    expect(src).toMatch(/_scannerIpRep\s*=\s*new Map/);
    expect(src).toMatch(/_SCANNER_4XX_THRESHOLD\s*=\s*\d+/);
    expect(src).toMatch(/_SCANNER_BLOCK_MS\s*=/);
    // 429 response with Retry-After.
    expect(src).toMatch(/res\.set\("Retry-After"/);
    expect(src).toMatch(/res\.status\(429\)\.json\(\{ error: "Too many invalid requests/);
    // Audit event on trigger.
    expect(src).toMatch(/recordOrphanedAuditEvent\("security"/);
    expect(src).toMatch(/"scanner_blocked"/);
    // 429 responses do NOT re-enter the counter (would otherwise
    // indefinitely prolong a block).
    expect(src).toMatch(/res\.statusCode\s*!==\s*429/);
    // Bypassed by the test harness's RATE_LIMIT_DISABLED knob.
    expect(src).toMatch(/RATE_LIMIT_DISABLED[\s\S]*?return next\(\)/);
  });

  test("audit v7.7.28 (M1): the scanner tracker honours RATE_LIMIT_ALLOWLIST_IPS (venue/CGNAT bypass)", () => {
    // The scanner-reputation middleware is IP-keyed and 429s the WHOLE address,
    // so a large legit cohort behind one allowlisted venue/CGNAT egress IP would
    // trip the 100-4xx block (mistyped passwords, expired-session 401 polls,
    // CSRF 403s all aggregate on that IP). RATE_LIMIT_ALLOWLIST_IPS is documented
    // (CLAUDE.md env table) + intended (CTF-0026) to bypass ALL rate limiters, so
    // the scanner must consult the SAME parsed allowlist as rateLimit(). Runtime
    // env can't be varied per-test (the allowlist is parsed once at module load
    // and the per-worker server boots with a fixed env), so this is a source lock
    // matching the sibling scanner + CTF-0026 middleware locks; the match logic
    // itself is covered by the parseIpAllowlist/ipAllowlistMatch unit tests.
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "server.js"), "utf8");
    const mw = fs.readFileSync(path.resolve(__dirname, "..", "lib/middleware.js"), "utf8");
    // lib/middleware.js must export the shared allowlist predicate…
    expect(mw, "_rateLimitAllowlisted must be exported for the scanner tracker to reuse")
      .toMatch(/module\.exports\s*=\s*\{[\s\S]*_rateLimitAllowlisted[\s\S]*\}/);
    // …server.js must import it (destructured name precedes the require call)…
    expect(src).toMatch(/_rateLimitAllowlisted[\s\S]{0,40}=\s*require\("\.\/lib\/middleware"\)/);
    // …and the scanner middleware must short-circuit an allowlisted IP BEFORE
    // the block check + the 4xx counting (i.e. before _scannerBlockedUntil).
    // v8.12.4 — scoped to the BLOCK middleware's own body. The first draft took
    // the file's FIRST bypass, which is the COUNT middleware's, so deleting the
    // block middleware's bypass left it green.
    const fnIdx = src.indexOf("function _scannerBlockMiddleware(req, res, next) {");
    expect(fnIdx, "the scanner BLOCK middleware is gone — it moved or was renamed").toBeGreaterThan(-1);
    const scannerCallIdx = src.indexOf("const blockedUntil = _scannerBlockedUntil(ip)", fnIdx);
    expect(scannerCallIdx, "scanner middleware block-check call site not found").toBeGreaterThan(-1);
    const body = src.slice(fnIdx, scannerCallIdx);
    expect(/_rateLimitAllowlisted\(ip\)\)\s*return next\(\)/.test(body),
      "the BLOCK middleware must bypass an allowlisted address before its block check").toBe(true);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// GROUP LEADERBOARD VISIBILITY GATING (v7.11.7)
// ═══════════════════════════════════════════════════════════════════════════════
// The group/team board is now OPT-IN per competition (group_leaderboard_enabled,
// default OFF) AND only renders with >=2 NON-EMPTY bound groups (a non-empty group
// has >=1 eligible enrolled member). Full combination matrix: setting {off,on} ×
// non-empty-group-count {0,1,2,3} + the "2 bound but 1 empty" edge, on BOTH the
// admin (?groups=1) and participant endpoints, plus the toggle (updated_at + audit).
test.describe("Group leaderboard visibility gating (v7.11.7)", () => {
  const GH = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
  let _n = 0;
  const uniq = (p) => `${p}-${Date.now()}-${_n++}`;
  async function mkP(sa, saCsrf, nick) {
    const email = `vgl_${nick}@acme.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: GH(ac), data: {
      firstName: "V", lastName: "G", nickname: nick, email, company: "Acme", title: "Eng",
      country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC",
    }});
    await anon.dispose();
    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: GH(saCsrf) });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: GH(saCsrf) });
    return { id: u.id, email, nick };
  }

  let sa, saCsrf, saH, pool;
  test.beforeAll(async () => {
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    saH = GH(saCsrf);
    pool = [];
    for (let i = 0; i < 3; i++) pool.push(await mkP(sa, saCsrf, uniq(`p${i}`)));
  });
  test.afterAll(async () => { await sa?.dispose(); });

  // A live comp; `enabled` = group_leaderboard_enabled (omit to test the default).
  const mkComp = async (enabled) => {
    const data = { name: uniq("VG"), start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240 };
    if (enabled !== undefined) data.group_leaderboard_enabled = enabled;
    return (await (await sa.post("/api/admin/competitions", { headers: saH, data })).json()).competition.id;
  };
  const mkGroup = async (members) => (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: uniq("G"), userIds: members.map(m => m.id) } })).json()).group.id;
  const bind = async (compId, gids) => { if (gids.length) expect((await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: gids, competitionIds: [compId] } })).ok()).toBeTruthy(); };
  const adminBoard = async (compId) => await (await sa.get(`/api/admin/leaderboard?competitionId=${compId}&groups=1`)).json();
  const nGroups = (board) => (board || []).filter(e => e.type === "group").length;
  const compRow = async (compId) => (await (await sa.get("/api/admin/competitions")).json()).find(c => c.id === compId);
  // A member counts toward a NON-EMPTY group only once they're on the board — which
  // happens when they ENTER the competition (login_time set). activate = the member
  // selecting the comp, mirroring "started competing" (same rule as the individual board).
  const activate = async (compId, ...members) => {
    for (const m of members) {
      const { api, csrf } = await apiLogin(m.email, PARTICIPANT_PASS);
      expect((await api.post("/api/select-competition", { headers: GH(csrf), data: { competitionId: compId } })).ok()).toBeTruthy();
      await api.dispose();
    }
  };

  test("default is OFF — a comp created WITHOUT the flag hides the board even with 2 non-empty groups", async () => {
    const [a, b] = pool;
    const compId = await mkComp(undefined); // no flag → default
    await bind(compId, [await mkGroup([a]), await mkGroup([b])]);
    await activate(compId, a, b); // both groups genuinely non-empty/active → proves the FLAG gates it
    expect(!!(await compRow(compId)).group_leaderboard_enabled, "default flag is off").toBe(false);
    expect(nGroups(await adminBoard(compId)), "2 non-empty groups but flag defaulted off → hidden").toBe(0);
  });

  test("explicit OFF hides even with 2 non-empty groups", async () => {
    const [a, b] = pool;
    const compId = await mkComp(false);
    await bind(compId, [await mkGroup([a]), await mkGroup([b])]);
    await activate(compId, a, b);
    expect(nGroups(await adminBoard(compId))).toBe(0);
  });

  test("when ON, the board needs >=2 NON-EMPTY groups (0 / 1 / two-bound-one-empty hidden; 2 and 3 shown)", async () => {
    const [a, b, c] = pool;
    // ON + 0 bound groups → hidden
    expect(nGroups(await adminBoard(await mkComp(true))), "on + 0 groups").toBe(0);
    // ON + exactly 1 non-empty group → hidden
    { const cid = await mkComp(true); await bind(cid, [await mkGroup([a])]); await activate(cid, a); expect(nGroups(await adminBoard(cid)), "on + 1 non-empty group").toBe(0); }
    // ON + 2 bound but one is EMPTY (only 1 non-empty) → hidden
    { const cid = await mkComp(true); await bind(cid, [await mkGroup([a]), await mkGroup([])]); await activate(cid, a); expect(nGroups(await adminBoard(cid)), "on + 1 non-empty + 1 empty").toBe(0); }
    // ON + 2 non-empty groups → SHOWN (2 group rows)
    { const cid = await mkComp(true); await bind(cid, [await mkGroup([a]), await mkGroup([b])]); await activate(cid, a, b); expect(nGroups(await adminBoard(cid)), "on + 2 non-empty groups").toBe(2); }
    // ON + 3 non-empty groups → SHOWN (3 group rows)
    { const cid = await mkComp(true); await bind(cid, [await mkGroup([a]), await mkGroup([b]), await mkGroup([c])]); await activate(cid, a, b, c); expect(nGroups(await adminBoard(cid)), "on + 3 non-empty groups").toBe(3); }
  });

  test("toggling the flag flips visibility, bumps updated_at, and records an audit change", async () => {
    const [a, b] = pool;
    const compId = await mkComp(false);
    await bind(compId, [await mkGroup([a]), await mkGroup([b])]);
    await activate(compId, a, b);
    expect(nGroups(await adminBoard(compId)), "off → hidden").toBe(0);
    const c1 = await compRow(compId);
    // Toggle ON (optimistic-concurrency stamp threaded through).
    const putOn = await sa.put(`/api/admin/competitions/${compId}`, { headers: saH, data: { group_leaderboard_enabled: true, expectedUpdatedAt: c1.updated_at } });
    expect(putOn.ok(), "PUT enable succeeds").toBeTruthy();
    expect(nGroups(await adminBoard(compId)), "on → shown").toBe(2);
    const c2 = await compRow(compId);
    expect(!!c2.group_leaderboard_enabled).toBe(true);
    expect(c2.updated_at, "updated_at bumped on toggle").not.toBe(c1.updated_at);
    // Audit: an `edited` competition event records the flag change.
    const Database = require("better-sqlite3");
    const auditHits = (() => { const db = new Database(TEST_DB_PATH, { readonly: true }); try {
      return db.prepare("SELECT COUNT(*) c FROM competition_events WHERE competition_id=? AND event_type='edited' AND details LIKE '%group_leaderboard_enabled%'").get(compId).c;
    } finally { db.close(); } })();
    expect(auditHits, "edited event records group_leaderboard_enabled").toBeGreaterThan(0);
    // Toggle OFF again → hidden.
    const putOff = await sa.put(`/api/admin/competitions/${compId}`, { headers: saH, data: { group_leaderboard_enabled: false, expectedUpdatedAt: c2.updated_at } });
    expect(putOff.ok(), "PUT disable succeeds").toBeTruthy();
    expect(nGroups(await adminBoard(compId)), "off again → hidden").toBe(0);
  });

  test("participant /api/leaderboard respects the same gate (off → groupBoard null; on + 2 non-empty → present)", async () => {
    const [a, b] = pool;
    const offC = await mkComp(false);
    await bind(offC, [await mkGroup([a]), await mkGroup([b])]);
    await activate(offC, b); // a self-activates below via its own select-competition
    const onC = await mkComp(true);
    await bind(onC, [await mkGroup([a]), await mkGroup([b])]);
    await activate(onC, b);
    const { api: p, csrf: pc } = await apiLogin(a.email, PARTICIPANT_PASS);
    expect((await p.post("/api/select-competition", { headers: GH(pc), data: { competitionId: offC } })).ok()).toBeTruthy();
    expect((await (await p.get("/api/leaderboard")).json()).groupBoard, "off → participant groupBoard null").toBeNull();
    expect((await p.post("/api/select-competition", { headers: GH(pc), data: { competitionId: onC } })).ok()).toBeTruthy();
    const lbOn = await (await p.get("/api/leaderboard")).json();
    await p.dispose();
    expect(lbOn.groupBoard, "on + 2 non-empty → participant groupBoard present").toBeTruthy();
    expect(lbOn.groupBoard.board.filter(e => e.type === "group").length, "both teams on the participant board").toBe(2);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// COMPETITION TAGS (v6.6.0 — replaces the v6.5.0 internal boolean column)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Event tags (v6.6.0)", () => {
  test("create competition with tags — response includes tags, audit event records them", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const t = Date.now();
    const r = await api.post("/api/admin/competitions", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: `Tag-Create-${t}`, start_time: new Date(t + 3600_000).toISOString(), duration_minutes: 60, tags: ["test/dry run", "test-run"] },
    });
    expect(r.ok()).toBe(true);
    const d = await r.json();
    expect(d.competition.tags).toContain("test/dry run");
    expect(d.competition.tags).toContain("test-run");
    // Audit event records the tags.
    const today = new Date().toISOString().slice(0, 10);
    const logs = await (await api.get(`/api/admin/logs?stream=app&date=${today}&limit=500&q=${encodeURIComponent(d.competition.id)}`)).json();
    const created = (logs.entries || []).find(e => e.source === "audit" && e.scope === "competition" && e.event_type === "created" && e.scope_id === d.competition.id);
    expect(created).toBeTruthy();
    expect(created.details.tags).toContain("test/dry run");
    await api.delete(`/api/admin/competitions/${d.competition.id}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });

  test("add/remove competition tags via POST/DELETE endpoints + audit events", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const t = Date.now();
    let r = await api.post("/api/admin/competitions", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: `Tag-AddRem-${t}`, start_time: new Date(t + 3600_000).toISOString(), duration_minutes: 60 },
    });
    const compId = (await r.json()).competition.id;
    // Add the "test/dry run" tag.
    r = await api.post(`/api/admin/competitions/${compId}/tags`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { tag: "test/dry run" },
    });
    expect(r.ok()).toBe(true);
    let d = await r.json();
    expect(d.tags).toContain("test/dry run");
    // Re-read via list to verify persistence.
    const list = await (await api.get("/api/admin/competitions")).json();
    const row = list.find(c => c.id === compId);
    expect(row.tags).toContain("test/dry run");
    // Remove the tag.
    r = await api.delete(`/api/admin/competitions/${compId}/tags/${encodeURIComponent('test/dry run')}`, {
      headers: { "x-csrf-token": csrf },
    });
    expect(r.ok()).toBe(true);
    d = await r.json();
    expect(d.tags).not.toContain("test/dry run");
    // Audit events.
    const today = new Date().toISOString().slice(0, 10);
    const logs = await (await api.get(`/api/admin/logs?stream=app&date=${today}&limit=500&q=${encodeURIComponent(compId)}`)).json();
    const added = (logs.entries || []).find(e => e.source === "audit" && e.scope === "competition" && e.event_type === "tag_added" && e.scope_id === compId);
    const removed = (logs.entries || []).find(e => e.source === "audit" && e.scope === "competition" && e.event_type === "tag_removed" && e.scope_id === compId);
    expect(added).toBeTruthy();
    expect(added.details.tag).toBe("test/dry run");
    expect(removed).toBeTruthy();
    expect(removed.details.tag).toBe("test/dry run");
    await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });

  test("tag changes on ended comp — 403 for regular admin, 200 for superadmin", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const t = Date.now();
    let r = await sa.post("/api/admin/competitions", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { name: `Tag-Ended-${t}`, start_time: new Date(t - 3600_000).toISOString(), duration_minutes: 5 },
    });
    const compId = (await r.json()).competition.id;
    await sa.post(`/api/admin/competitions/${compId}/end-now`, {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: {},
    });
    const parts = (await (await sa.get("/api/admin/participants?limit=200")).json()).participants;
    const carol = parts.find(p => p.email === "carol@acme.com");
    await sa.post(`/api/admin/participants/${carol.id}/role`, {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { role: "admin" },
    });
    await sa.dispose();
    try {
      // Carol (regular admin) → 403.
      const { api: carolApi, csrf: carolCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      const rCarol = await carolApi.post(`/api/admin/competitions/${compId}/tags`, {
        headers: { "x-csrf-token": carolCsrf, "content-type": "application/json" },
        data: { tag: "test/dry run" },
      });
      expect(rCarol.status()).toBe(403);
      await carolApi.dispose();
      // Superadmin → 200.
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      const rSa = await sa2.post(`/api/admin/competitions/${compId}/tags`, {
        headers: { "x-csrf-token": sa2Csrf, "content-type": "application/json" },
        data: { tag: "test/dry run" },
      });
      expect(rSa.ok()).toBe(true);
      await sa2.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": sa2Csrf } });
      await sa2.dispose();
    } finally {
      const { api: sa3, csrf: sa3Csrf } = await apiLogin("superadmin");
      await sa3.post(`/api/admin/participants/${carol.id}/role`, {
        headers: { "x-csrf-token": sa3Csrf, "content-type": "application/json" },
        data: { role: "participant" },
      });
      await sa3.dispose();
    }
  });

  // The DELETE twin of the guard above is a duplicated copy of the same
  // check (routes/competitions.js POST :725 vs DELETE :746) and only the POST
  // side was ever tested. `internal` is what hides a dry run from analytics
  // AND blocks badge minting, so a regular admin stripping it off a FINISHED
  // competition retroactively inflates every default analytics view and makes
  // its participants badge-eligible for a dry run.
  test("tag REMOVAL on an ended comp is superadmin-only too", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const t = Date.now();
    const compId = (await (await sa.post("/api/admin/competitions", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { name: `Tag-Ended-Del-${t}`, start_time: new Date(t - 3600_000).toISOString(), duration_minutes: 5 },
    })).json()).competition.id;
    await sa.post(`/api/admin/competitions/${compId}/end-now`, {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" }, data: {},
    });
    // Superadmin may tag an ended comp — this is also the POSITIVE CONTROL for
    // the "still tagged after the 403" assertion below.
    const addR = await sa.post(`/api/admin/competitions/${compId}/tags`, {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { tag: "test/dry run" },
    });
    expect(addR.ok(), `superadmin tag add on ended comp: ${addR.status()}`).toBe(true);
    expect((await addR.json()).tags, "precondition: the tag really is there").toContain("test/dry run");
    const parts = (await (await sa.get("/api/admin/participants?limit=200")).json()).participants;
    const carol = parts.find(p => p.email === "carol@acme.com");
    await sa.post(`/api/admin/participants/${carol.id}/role`, {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { role: "admin" },
    });
    await sa.dispose();
    try {
      // Carol (regular admin) must be refused, and nothing may be written.
      const { api: carolApi, csrf: carolCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      const rCarol = await carolApi.delete(`/api/admin/competitions/${compId}/tags/${encodeURIComponent('test/dry run')}`, {
        headers: { "x-csrf-token": carolCsrf },
      });
      expect(rCarol.status(), "regular admin must not untag an ended comp").toBe(403);
      const listCarol = await (await carolApi.get("/api/admin/competitions")).json();
      expect(listCarol.find(c => c.id === compId).tags, "the refused DELETE must not have removed the tag").toContain("test/dry run");
      await carolApi.dispose();
      // Superadmin still can — the route itself is not broken for the right tier.
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      const rSa = await sa2.delete(`/api/admin/competitions/${compId}/tags/${encodeURIComponent('test/dry run')}`, {
        headers: { "x-csrf-token": sa2Csrf },
      });
      expect(rSa.ok(), `superadmin untag on ended comp: ${rSa.status()}`).toBe(true);
      expect((await rSa.json()).tags).not.toContain("test/dry run");
      await sa2.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": sa2Csrf } });
      await sa2.dispose();
    } finally {
      const { api: sa3, csrf: sa3Csrf } = await apiLogin("superadmin");
      await sa3.post(`/api/admin/participants/${carol.id}/role`, {
        headers: { "x-csrf-token": sa3Csrf, "content-type": "application/json" },
        data: { role: "participant" },
      });
      await sa3.dispose();
    }
  });

  test("GET /api/admin/competition-tags includes the permanent 'test/dry run' tag", async () => {
    await ensureState();
    const { api } = await apiLogin("superadmin");
    const tags = await (await api.get("/api/admin/competition-tags")).json();
    expect(Array.isArray(tags)).toBe(true);
    expect(tags).toContain("test/dry run");
    await api.dispose();
  });

  test("admin competitions list includes tags array for each competition", async () => {
    await ensureState();
    const { api } = await apiLogin("superadmin");
    const list = await (await api.get("/api/admin/competitions")).json();
    for (const c of list) {
      expect(Array.isArray(c.tags)).toBe(true);
    }
    await api.dispose();
  });

  test("analytics: excludeChallengeTags filters out tagged challenges", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    // v8.1.0 — OWNS ITS DATA. This picked per_challenge[0] from a GLOBAL query and
    // assumed "the seed submits answers for some", which is not guaranteed: the
    // default analytics filter drops staff participants and dry-run competitions,
    // and this file tags the seeded carol staff, so the baseline could legitimately
    // come back EMPTY — it did, intermittently, failing on the precondition rather
    // than on anything the test is about. A competition-scoped query is also a
    // distinct cache key, so the 15 s TTL cannot serve it a stale empty result.
    const _t = Date.now().toString(36);
    const _compR = await api.post("/api/admin/competitions", {
      headers: h,
      data: { name: `TagAnalytics ${_t}`, start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600, timezone: "UTC" },
    });
    expect(_compR.ok(), `create comp: ${await _compR.text()}`).toBeTruthy();
    const _compId = (await _compR.json()).competition.id;
    const _taskR = await api.post("/api/admin/tasks", {
      headers: h,
      data: { title: `TagAnalytics ${_t}`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "yes", status: "published" },
    });
    expect(_taskR.ok(), `create task: ${await _taskR.text()}`).toBeTruthy();
    const _taskBody = await _taskR.json();
    const _bankId = _taskBody.task ? _taskBody.task.id : _taskBody.id;
    const _asgT = await api.post(`/api/admin/tasks/${_bankId}/competitions`, { headers: h, data: { competitionIds: [_compId] } });
    expect(_asgT.ok(), await _asgT.text()).toBeTruthy();
    // The event's own copy (lib/event-copies.js): what is answered there, and the row its analytics list.
    const _taskId = (await _asgT.json()).copies[0].task_id;

    const _email = `tagan-${_t}@company.example`;
    const _reg = await registerPost(api, "/api/register", {
      headers: h,
      data: {
        firstName: "Tag", lastName: "Analytics", nickname: `tagan_${_t}`, email: _email,
        company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
        password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
      },
    });
    expect(_reg.status(), await _reg.text()).toBe(200);
    const _pl = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(_email)}`)).json();
    const _u = (_pl.participants || []).find(p => p.email === _email);
    await api.post(`/api/admin/participants/${_u.id}/verify`, { headers: h });
    await api.post(`/api/admin/participants/${_u.id}/approve`, { headers: h });
    const _asg = await api.post("/api/admin/competitions/assign", { headers: h, data: { userIds: [String(_u.id)], competitionIds: [_compId] } });
    expect(_asg.ok(), `assign: ${await _asg.text()}`).toBeTruthy();
    expect((await _asg.json()).assigned).toBeGreaterThan(0);

    const _pc = await freshCtx();
    const _pli = await codeLogin(_pc.api, _email, { "x-csrf-token": _pc.csrf, "content-type": "application/json" });
    expect(_pli.ok(), `participant login: ${await _pli.text()}`).toBeTruthy();
    const _pcsrf = (await (await _pc.api.get("/api/csrf-token")).json()).csrfToken;
    const _ph = { "x-csrf-token": _pcsrf, "content-type": "application/json" };
    expect((await _pc.api.post("/api/select-competition", { headers: _ph, data: { competitionId: _compId } })).ok()).toBeTruthy();
    const _sub = await _pc.api.post(`/api/tasks/${_taskId}/submit`, {
      headers: _ph, data: { answer: "yes", gradingHash: await gradingHashFor(_pc.api, _taskId) },
    });
    expect(_sub.ok(), `submit: ${await _sub.text()}`).toBeTruthy();
    await _pc.api.dispose();

    // Submit-path challenge_events are written POST-COMMIT on a setImmediate tick,
    // so poll rather than reading once.
    const _scoped = `/api/admin/analytics/challenges?scope=competition&competitionId=${_compId}&periodPreset=all`;
    await expect.poll(async () => {
      const b = await (await api.get(_scoped)).json();
      return (b.per_challenge || []).length;
    }, { timeout: 20000, intervals: [200, 400, 800, 1600] }).toBeGreaterThan(0);
    const baseline = await (await api.get(_scoped)).json();
    const task = baseline.per_challenge.find(r => r.task_id === _taskId);
    expect(task, "our own challenge is in its own competition's analytics").toBeTruthy();
    try {
      const tagR = await api.post(`/api/admin/tasks/${task.task_id}/tags`, { headers: h, data: { tag: "sca" } });
      expect(tagR.ok()).toBeTruthy();

      // With excludeChallengeTags=sca — tagged task must NOT appear
      const a1 = await (await api.get(`${_scoped}&excludeChallengeTags=sca`)).json();
      expect(a1.per_challenge.find(r => r.task_id === task.task_id)).toBeFalsy();

      // With includeChallengeTags=sca — ONLY the tagged task appears
      const a3 = await (await api.get(`${_scoped}&includeChallengeTags=sca`)).json();
      expect(a3.per_challenge.length).toBeGreaterThan(0);
      for (const row of a3.per_challenge) {
        expect(row.tags).toContain("sca");
      }
    } finally {
      await api.delete(`/api/admin/tasks/${task.task_id}/tags/sca`, { headers: { "x-csrf-token": csrf } });
      await api.dispose();
    }
  });

  test("analytics: excludeParticipantTags filters via tag-based params", async () => {
    // v8.12.4 — COMPARED, not merely answered. The first draft asserted that
    // both reads returned a summary, which a build ignoring the tag filter also
    // does. Now: alice (who has activity from the seed) is tagged, and the
    // tagged-only read must count exactly her while the exclude read must count
    // exactly one fewer participant than the unfiltered read.
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const parts = (await (await api.get("/api/admin/participants?limit=5000")).json()).participants;
    const alice = parts.find(p => p.email === "alice@acme.com");
    const TAG = `test-exclude-${Date.now()}`;
    let n = 0;
    const read = async (q) => {
      const r = await api.get(`/api/admin/analytics/challenges?scope=global&periodPreset=all${q}&_=${TAG}-${++n}`);
      expect(r.ok(), await r.text()).toBeTruthy();
      return (await r.json()).summary;
    };
    try {
      const tagR = await api.post(`/api/admin/participants/${alice.id}/tags`, { headers: h, data: { tag: TAG } });
      expect(tagR.ok()).toBeTruthy();
      const all = await read("&excludeParticipantTags=");
      const only = await read(`&includeParticipantTags=${TAG}&excludeParticipantTags=`);
      expect(only.unique_participants, "PRECONDITION: the tagged participant has activity to filter").toBe(1);
      const without = await read(`&excludeParticipantTags=${TAG}`);
      expect(without.unique_participants, "excluding the tag removes exactly that participant")
        .toBe(all.unique_participants - 1);
    } finally {
      await api.delete(`/api/admin/participants/${alice.id}/tags/${encodeURIComponent(TAG)}`, { headers: { "x-csrf-token": csrf } });
      await api.dispose();
    }
  });

  test("analytics: excludeCompTags= (empty) overrides the default internal exclusion", async () => {
    // v7.15.16 — this test used to fetch both variants and never compare them,
    // so it could not fail: `excludeCompTags` could have been ignored entirely
    // and both `summary` objects would still be truthy. It now builds a real
    // `internal` competition with activity and asserts the two responses DIFFER
    // in the direction the parameter promises.
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const uniq = `${Date.now()}`;
    let compId, taskId, pu;
    try {
      // An internal-tagged competition with one solved challenge — activity that
      // the default filter must hide and the empty override must reveal.
      compId = (await (await api.post("/api/admin/competitions", { headers: h, data: {
        name: `Analytics internal ${uniq}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 180,
      } })).json()).competition.id;
      await api.post(`/api/admin/competitions/${compId}/tags`, { headers: h, data: { tag: "test/dry run" } });
      taskId = (await (await api.post("/api/admin/tasks", { headers: h, data: {
        title: `Analytics internal task ${uniq}`, description: "<p>x</p>", difficulty: "easy",
        answer_type: "text", correct_answer: "win", status: "published",
      } })).json()).id;
      const _asg = await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: h, data: { competitionIds: [compId] } });
      expect(_asg.ok(), await _asg.text()).toBeTruthy();
      taskId = (await _asg.json()).copies[0].task_id;   // the event's own copy: what is answered there and listed by its analytics
      // A DEDICATED participant, not the shared alice: earlier tests in this file
      // tag the shared fixtures, and analytics excludes `staff` participants by
      // default — so a stray tag makes this competition's activity invisible in
      // BOTH responses and the comparison reads hidden/hidden.
      const pEmail = `analytics${uniq}@company.com`;
      const { api: anon, csrf: anonCsrf } = await freshCtx();
      expect((await registerPost(anon, "/api/register", {
        headers: { "x-csrf-token": anonCsrf, "content-type": "application/json" },
        data: {
          firstName: "Ana", lastName: "Lytics", nickname: `analytics${uniq}`, email: pEmail,
          company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
          jobFunction: "Software Developer / Engineer", city: "Boston", password: PARTICIPANT_PASS,
        },
      })).status()).toBe(200);
      await anon.dispose();
      pu = (await (await api.get("/api/admin/participants?limit=5000")).json()).participants.find(x => x.email === pEmail);
      await api.post(`/api/admin/participants/${pu.id}/verify`, { headers: { "x-csrf-token": csrf } });
      await api.post(`/api/admin/participants/${pu.id}/approve`, { headers: { "x-csrf-token": csrf } });
      await api.post("/api/admin/competitions/assign", { headers: h, data: { userIds: [pu.id], competitionIds: [compId] } });

      const { api: al, csrf: alc } = await apiLogin(pEmail, PARTICIPANT_PASS);
      const alh = { "x-csrf-token": alc, "content-type": "application/json" };
      await al.post("/api/select-competition", { headers: alh, data: { competitionId: compId } });
      const sub = await al.post(`/api/tasks/${taskId}/submit`, { headers: alh, data: { answer: "win" , gradingHash: await gradingHashFor(al, taskId)} });
      expect((await sub.json()).correct, "seed a real solve inside the internal comp").toBeTruthy();
      await al.dispose();
      // NOTE: do not add a short "wait for the event to land" poll here. This
      // endpoint caches each query for 15 s (_ANALYTICS_CACHE_TTL_MS), so a poll
      // whose timeout is under the TTL just re-reads the same cached miss and
      // can never recover. The single poll below outlasts the TTL, which covers
      // both the cache and the submit path's deferred challenge_events drain.

      // /api/admin/analytics/challenges caches per query for 15 s
      // (_ANALYTICS_CACHE_TTL_MS), and the DEFAULT query is the one every other
      // analytics test warms — so a hit populated before this competition
      // existed can serve here. Poll both variants together for longer than the
      // TTL rather than reading each once.
      const hasTask = (b) => (b.per_challenge || []).some(c => c.task_id === taskId || c.id === taskId);
      await expect.poll(async () => {
        const d = await (await api.get("/api/admin/analytics/challenges?scope=global&periodPreset=all")).json();
        const o = await (await api.get("/api/admin/analytics/challenges?scope=global&periodPreset=all&excludeCompTags=")).json();
        const perCh = (o.per_challenge || []).length;
        return `${hasTask(d) ? "shown" : "hidden"}/${hasTask(o) ? "shown" : "hidden"} (override rows=${perCh})`;
      }, {
        timeout: 45000, intervals: [500, 1000, 2000, 4000],
        message: "expected default=hidden (internal comps excluded) and excludeCompTags= → shown. " +
                 "Comparing the two is the whole point: reading each once and asserting it is merely " +
                 "truthy cannot fail even if the parameter is ignored entirely.",
      }).toMatch(/^hidden\/shown /);
    } finally {
      if (taskId) await api.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      if (pu) await api.delete(`/api/admin/participants/${pu.id}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      await api.dispose();
    }
  });

  // v6.8.0 — cover the include* branches (not just exclude*) for the three
  // analytics tag-filter dimensions.
  test("analytics: includeChallengeTags narrows per_challenge to tagged challenges only", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    // v7.24.0 — three hardenings, after this flaked twice in one session with no
    // mechanism captured. None claims a cause; each closes a shape that is
    // fragile by inspection.
    //
    // 1. The TAG IS UNIQUE PER RUN, which makes the analytics URL unique too.
    //    This endpoint caches every query for 15 s keyed on the full query
    //    string (_ANALYTICS_CACHE_TTL_MS), and the sibling test above documents
    //    that trap at length — but a FIXED tag means a retry, or the same file
    //    run twice inside the window, can be served a body computed before the
    //    tag existed (or after the `finally` removed it). A unique tag is a
    //    guaranteed cache miss, which is cheaper and more certain than polling
    //    past the TTL.
    // 2. The tag WRITE is asserted. It was fired and ignored — and tagging is a
    //    destructive-admin route (30/min), so a refusal left the filter matching
    //    nothing, the loop below iterating zero rows, and the test passing while
    //    asserting nothing at all.
    // 3. `easy1` rather than `S.tasks[0]`, plus a non-empty floor: the seed has
    //    alice solve easy1, so it genuinely carries challenge_events. tasks[0]
    //    is whatever the admin list happens to return first and may have no
    //    activity, in which case per_challenge is empty and the loop is vacuous.
    const TAG = `v68-incl-${Date.now().toString(36)}`;
    const target = S.liveTask("Challenge easy1");   // the Live event's own copy: the row alice's seeded solve is under
    expect(target, "seed fixture: Challenge easy1 must exist").toBeTruthy();
    try {
      const tagRes = await api.post(`/api/admin/tasks/${target.id}/tags`, { headers: h, data: { tag: TAG } });
      expect(tagRes.ok(), `tagging must succeed or this test asserts nothing: ${tagRes.status()}`).toBeTruthy();
      const r = await api.get(`/api/admin/analytics/challenges?scope=global&periodPreset=all&includeChallengeTags=${TAG}`);
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      const rows = body.per_challenge || [];
      expect(rows.length, "the tagged challenge has seeded activity, so it must be IN the filtered set")
        .toBeGreaterThan(0);
      // Every per_challenge row should carry the filter tag.
      for (const row of rows) {
        expect(row.tags).toContain(TAG);
      }
    } finally {
      await api.delete(`/api/admin/tasks/${target.id}/tags/${TAG}`, { headers: { "x-csrf-token": csrf } });
      await api.dispose();
    }
  });

  test("analytics: includeParticipantTags narrows to users with the chosen tag", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const parts = (await (await api.get("/api/admin/participants?limit=200")).json()).participants;
    const alice = parts.find(p => p.email === "alice@acme.com");
    // Same three hardenings as the sibling above: a unique tag (so the 15 s
    // per-query analytics cache cannot serve a body computed before the tag
    // existed), an asserted tag write, and a floor so "at most one" cannot be
    // satisfied by a filter that matched nobody.
    const TAG = `v68-incl-user-${Date.now().toString(36)}`;
    try {
      const tagRes = await api.post(`/api/admin/participants/${alice.id}/tags`, { headers: h, data: { tag: TAG } });
      expect(tagRes.ok(), `tagging must succeed or this test asserts nothing: ${tagRes.status()}`).toBeTruthy();
      // `excludeParticipantTags=` (empty) turns OFF the default staff exclusion,
      // and that is load-bearing rather than tidy: a sibling test in this file
      // tags ALICE staff and untags her afterwards, so a run that lands while
      // that tag is on would see her excluded and the count read 0. The claim
      // here is about the INCLUDE filter, so the unrelated default must not be
      // able to decide it. (Seen as a flake the first time the floor below was
      // added; no contention mechanism is claimed, the coupling is simply real.)
      const r = await api.get(`/api/admin/analytics/challenges?scope=global&periodPreset=all&includeParticipantTags=${TAG}&excludeParticipantTags=`);
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      // At most one participant (alice) can match — and at least one, because
      // the seed has her solve easy1, so a filter that matched nobody would
      // otherwise satisfy the upper bound.
      expect(body.summary.unique_participants).toBeLessThanOrEqual(1);
      expect(body.summary.unique_participants,
        "alice has seeded activity, so the tag filter must match her").toBe(1);
    } finally {
      await api.delete(`/api/admin/participants/${alice.id}/tags/${TAG}`, { headers: { "x-csrf-token": csrf } });
      await api.dispose();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY HARDENING — CSP POSTURE + CSP REPORTING
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// BCRYPT CROSS-COMPAT (v6.8.4 — bcryptjs → native bcrypt swap)
// ═══════════════════════════════════════════════════════════════════════════════
// Locks in the "no data migration needed" claim of the engine swap. Any
// existing deployment upgrading from a pre-v6.8.4 build has a DB full of
// hashes produced by bcryptjs — we must keep reading them. Both libraries
// implement the same algorithm + wire format ($2a / $2b / $2y), so this is
// expected to work; the test exists so a future native-bcrypt upgrade that
// silently drops a prefix variant fails this assertion instead of making
// everyone's password stop working.
test.describe("bcrypt cross-compat", () => {
  const bcrypt = require("bcrypt");

  // Pre-generated with bcryptjs@3.0.3 (the engine shipped prior to v6.8.4),
  // password = "correct-horse-battery-staple", rounds = 10.
  const BJS_2B_HASH = "$2b$10$FuaedH.cKiLfrvKCj7W3SOLsUSgb8Ablsxsh4Win9nlFKXTrh8cNa";
  const BJS_PASSWORD = "correct-horse-battery-staple";

  test("native bcrypt verifies a hash written by bcryptjs@3", () => {
    expect(bcrypt.compareSync(BJS_PASSWORD, BJS_2B_HASH)).toBe(true);
    expect(bcrypt.compareSync("wrong-password", BJS_2B_HASH)).toBe(false);
  });

  test("dummy $2a hash in the login constant-time path compares without throwing", () => {
    // server.js uses a hardcoded $2a$10$… dummy hash against which the
    // login route runs bcrypt.compare on unknown emails, so response time
    // does not leak whether a user exists. The dummy is intentionally not
    // a real hash; compareSync must return false (not throw).
    const DUMMY = "$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWX";
    expect(() => bcrypt.compareSync("anything", DUMMY)).not.toThrow();
    expect(bcrypt.compareSync("anything", DUMMY)).toBe(false);
  });

  test("getRounds returns the cost embedded in the stored hash", () => {
    // Used at server.js:3378 to detect off-cost legacy hashes and trigger
    // opportunistic re-hashing after a successful login.
    expect(bcrypt.getRounds(BJS_2B_HASH)).toBe(10);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Mandatory profile fields (v6.18.x)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Mandatory profile fields (v6.18.x)", () => {
  const suffix = () => Date.now() + Math.random().toString(36).slice(2, 6);

  async function saCtx() {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    return { sa, csrf, h };
  }

  /** Register + verify + approve + set password for a new user. Returns { api, csrf, userId }. */
  async function bootstrapUser(sa, h, overrides = {}) {
    const s = suffix();
    const data = {
      firstName: "Prof", lastName: "Test", nickname: `proftest_${s}`,
      email: `proftest_${s}@acme.com`, company: "Acme Corp", title: "Engineer",
      country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "New York",
      ...overrides,
    };
    const reg = await registerPost(sa, "/api/register", { headers: h, data });
    if (!reg.ok()) throw new Error(`register failed: ${reg.status()} ${await reg.text()}`);
    const list = await (await sa.get("/api/admin/participants?limit=500")).json();
    const user = list.participants.find(p => p.email === data.email);
    await sa.post(`/api/admin/participants/${user.id}/verify`, { headers: h });
    await sa.post(`/api/admin/participants/${user.id}/approve`, { headers: h });
    return { userId: user.id, email: data.email };
  }

  test("POST /api/register accepts a blank jobFunction (the short form: not required by default)", async () => {
    const { sa, h } = await saCtx();
    try {
      const s = suffix();
      const r = await registerPost(sa, "/api/register", {
        headers: h,
        data: {
          firstName: "No", lastName: "Role", nickname: `norole_${s}`,
          email: `norole_${s}@acme.com`, company: "Acme", title: "Eng",
          country: "US", timezone: "America/New_York",
          jobFunction: "", city: "New York",
        },
      });
      expect(r.status(), await r.text()).toBe(200);
    } finally { await sa.dispose(); }
  });

  test("POST /api/register accepts a blank city (the short form: not required by default)", async () => {
    const { sa, h } = await saCtx();
    try {
      const s = suffix();
      const r = await registerPost(sa, "/api/register", {
        headers: h,
        data: {
          firstName: "No", lastName: "City", nickname: `nocity_${s}`,
          email: `nocity_${s}@acme.com`, company: "Acme", title: "Eng",
          country: "US", timezone: "America/New_York",
          jobFunction: "Software Developer / Engineer", city: "",
        },
      });
      expect(r.status(), await r.text()).toBe(200);
    } finally { await sa.dispose(); }
  });

  test("POST /api/register accepts preset role + city, stores both", async () => {
    const { sa, h } = await saCtx();
    try {
      const s = suffix();
      const r = await registerPost(sa, "/api/register", {
        headers: h,
        data: {
          firstName: "Good", lastName: "Reg", nickname: `goodreg_${s}`,
          email: `goodreg_${s}@acme.com`, company: "Acme", title: "Eng",
          country: "US", timezone: "America/New_York",
          jobFunction: "DevOps / DevSecOps Engineer", city: "Austin",
        },
      });
      expect(r.ok(), `register failed: ${r.status()} ${await r.text()}`).toBeTruthy();
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      const user = list.participants.find(p => p.email === `goodreg_${s}@acme.com`);
      expect(user?.job_function).toBe("DevOps / DevSecOps Engineer");
      expect(user?.city).toBe("Austin");
    } finally { await sa.dispose(); }
  });

  test("POST /api/register accepts free-text role (Other), stores it", async () => {
    const { sa, h } = await saCtx();
    try {
      const s = suffix();
      const r = await registerPost(sa, "/api/register", {
        headers: h,
        data: {
          firstName: "Free", lastName: "Role", nickname: `freerole_${s}`,
          email: `freerole_${s}@acme.com`, company: "Acme", title: "Eng",
          country: "US", timezone: "America/New_York",
          jobFunction: "Quantum Cloud Alchemist", city: "Portland",
        },
      });
      expect(r.ok(), `register failed: ${r.status()} ${await r.text()}`).toBeTruthy();
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      const user = list.participants.find(p => p.email === `freerole_${s}@acme.com`);
      expect(user?.job_function).toBe("Quantum Cloud Alchemist");
    } finally { await sa.dispose(); }
  });

  test("GET /api/me returns job_function, city, profile_complete, missing_fields", async () => {
    await ensureState();
    // Alice has job_function+city from helpers.js seed; acme.com is a corporate domain
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    await api.post("/api/select-competition", { headers: h, data: { competitionId: S.liveComp.id } });
    try {
      const me = await (await api.get("/api/me")).json();
      expect(me.job_function).toBe("Software Developer / Engineer");
      expect(me.city).toBe("New York");
      expect(Array.isArray(me.missing_fields)).toBeTruthy();
      expect(typeof me.profile_complete).toBe("boolean");
    } finally { await api.dispose(); }
  });

  test("GET /api/me: profile_complete true when all fields present + corporate email", async () => {
    await ensureState();
    // Alice: acme.com is not a free email; job_function + city set by seed
    const { api } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    try {
      const me = await (await api.get("/api/me")).json();
      expect(me.profile_complete).toBe(true);
      expect(me.missing_fields).toHaveLength(0);
    } finally { await api.dispose(); }
  });

  test("GET /api/me: missing_fields includes corporate_email for gmail-only user", async () => {
    const { sa, h } = await saCtx();
    try {
      // Register with a corporate email so server accepts it,
      // then swap it to gmail via DB to simulate a free-email-only profile.
      const s = suffix();
      const corpEmail = `gmtest_${s}@acme.com`;
      const gmailEmail = `gmtest_${s}@gmail.com`;
      const { userId } = await bootstrapUser(sa, h, { email: corpEmail });
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH);
      db.prepare("UPDATE users SET email=?, secondary_email=NULL WHERE id=?").run(gmailEmail, userId);
      db.close();
      // Reset password using newly updated email context (password already set by bootstrapUser)
      const { api: userApi } = await apiLogin(gmailEmail, PARTICIPANT_PASS);
      try {
        const me = await (await userApi.get("/api/me")).json();
        expect(me.missing_fields).toContain("corporate_email");
        expect(me.profile_complete).toBe(false);
      } finally { await userApi.dispose(); }
    } finally { await sa.dispose(); }
  });

  test("POST /api/select-competition returns 400 profile_incomplete when required fields missing", async () => {
    await ensureState();
    const { sa, h } = await saCtx();
    try {
      const { userId, email } = await bootstrapUser(sa, h);
      await sa.post("/api/admin/competitions/assign", {
        headers: h, data: { userIds: [userId], competitionIds: [S.liveComp.id] },
      });
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH);
      db.prepare("UPDATE users SET job_function=NULL, city=NULL, company=NULL WHERE id=?").run(userId);
      db.close();
      const { api: userApi, csrf: userCsrf } = await apiLogin(email, PARTICIPANT_PASS);
      const userH = { "x-csrf-token": userCsrf, "content-type": "application/json" };
      try {
        const r = await userApi.post("/api/select-competition", {
          headers: userH, data: { competitionId: S.liveComp.id },
        });
        expect(r.status()).toBe(400);
        const d = await r.json();
        expect(d.error).toBe("profile_incomplete");
        expect(d.missing).toContain("company");
        // The short form: City and Job function are no longer demanded by default.
        expect(d.missing).not.toContain("job_function");
        expect(d.missing).not.toContain("city");
      } finally { await userApi.dispose(); }
    } finally { await sa.dispose(); }
  });

  test("GET /api/me: missing_fields includes all unset required fields (company, title, country, timezone) and no longer job_function or city", async () => {
    const { sa, h } = await saCtx();
    try {
      const { userId, email } = await bootstrapUser(sa, h);
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH);
      db.prepare("UPDATE users SET company=NULL, title=NULL, country=NULL, timezone=NULL, job_function=NULL, city=NULL WHERE id=?").run(userId);
      db.close();
      const { api: userApi } = await apiLogin(email, PARTICIPANT_PASS);
      try {
        const me = await (await userApi.get("/api/me")).json();
        expect(me.profile_complete).toBe(false);
        for (const f of ["company", "title", "country", "timezone"]) {
          expect(me.missing_fields, `Expected ${f} in missing_fields`).toContain(f);
        }
        for (const f of ["job_function", "city"]) {
          expect(me.missing_fields, `the short form never demands ${f} by default`).not.toContain(f);
        }
      } finally { await userApi.dispose(); }
    } finally { await sa.dispose(); }
  });

  test("PUT /api/me updates job_function + city, reflected in next GET /api/me", async () => {
    const { sa, h } = await saCtx();
    try {
      const { email } = await bootstrapUser(sa, h, { jobFunction: "Application Security Engineer", city: "Chicago" });
      const { api: userApi, csrf: userCsrf } = await apiLogin(email, PARTICIPANT_PASS);
      const userH = { "x-csrf-token": userCsrf, "content-type": "application/json" };
      try {
        const put = await userApi.put("/api/me", {
          headers: userH,
          data: { jobFunction: "Security Leader (Manager, Director, CISO)", city: "Boston" },
        });
        expect(put.ok(), `PUT /api/me failed: ${put.status()} ${await put.text()}`).toBeTruthy();
        const me = await (await userApi.get("/api/me")).json();
        expect(me.job_function).toBe("Security Leader (Manager, Director, CISO)");
        expect(me.city).toBe("Boston");
      } finally { await userApi.dispose(); }
    } finally { await sa.dispose(); }
  });

  test("PUT /api/me rejects clearing required fields (company, title, country, timezone) and accepts clearing jobFunction / city", async () => {
    const { sa, h } = await saCtx();
    try {
      const { email } = await bootstrapUser(sa, h);
      const { api: userApi, csrf: userCsrf } = await apiLogin(email, PARTICIPANT_PASS);
      const userH = { "x-csrf-token": userCsrf, "content-type": "application/json" };
      try {
        for (const [field, val] of [
          ["company", ""], ["title", ""], ["country", ""],
          ["timezone", ""],
        ]) {
          const r = await userApi.put("/api/me", { headers: userH, data: { [field]: val } });
          expect(r.status(), `Expected 400 when clearing ${field}, got ${r.status()}: ${await r.text()}`).toBe(400);
        }
        for (const field of ["jobFunction", "city"]) {
          const r = await userApi.put("/api/me", { headers: userH, data: { [field]: "" } });
          expect(r.status(), `clearing ${field} is allowed under the short form: ${await r.text()}`).toBe(200);
        }
      } finally { await userApi.dispose(); }
    } finally { await sa.dispose(); }
  });

  test("PUT /api/admin/participants/:id updates job_function + city for target user", async () => {
    await ensureState();
    const { sa, h } = await saCtx();
    try {
      const { userId } = await bootstrapUser(sa, h, { jobFunction: "DevOps / DevSecOps Engineer", city: "Denver" });
      const put = await sa.put(`/api/admin/participants/${userId}`, {
        headers: h,
        data: {
          jobFunction: "Solutions / Cloud Architect", city: "San Francisco",
          firstName: "Prof", lastName: "Test",
        },
      });
      expect(put.ok(), `admin PUT failed: ${put.status()} ${await put.text()}`).toBeTruthy();
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      const user = list.participants.find(p => p.id === userId);
      expect(user?.job_function).toBe("Solutions / Cloud Architect");
      expect(user?.city).toBe("San Francisco");
    } finally { await sa.dispose(); }
  });

  // ── v7.6.x — server-side profile-completion gate across participant endpoints ──
  test("an incomplete profile is BLOCKED (400 profile_incomplete) on every participant action endpoint, but can still GET/PUT /api/me", async () => {
    await ensureState();
    const { sa, h } = await saCtx();
    let userId;
    try {
      const u = await bootstrapUser(sa, h);
      userId = u.userId;
      const email = u.email;
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH);
      db.prepare("UPDATE users SET company=NULL WHERE id=?").run(userId);
      db.close();
      const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
      const uh = { "x-csrf-token": csrf, "content-type": "application/json" };
      try {
        // EXEMPT — the incomplete user can still see + fix their profile, and keep alive.
        expect((await api.get("/api/me")).status()).toBe(200);
        expect((await api.post("/api/session/keepalive", { headers: { "x-csrf-token": csrf } })).status()).toBe(200);

        // GATED — every participant ACTION endpoint returns 400 profile_incomplete.
        const gated = [
          () => api.get("/api/my-competitions"),
          () => api.post("/api/select-timeslot", { headers: uh, data: { timeslotId: "x" } }),
          () => api.get(`/api/competitions/${S.liveComp.id}/reminder`),
          () => api.post(`/api/competitions/${S.liveComp.id}/reminder`, { headers: uh, data: {} }),
          () => api.post("/api/competitions/join", { headers: uh, data: { token: "x" } }),
          () => api.post(`/api/competitions/${S.liveComp.id}/badge`, { headers: { "x-csrf-token": csrf } }),
        ];
        for (const call of gated) {
          const r = await call();
          expect(r.status(), `expected 400 from a gated endpoint, got ${r.status()}`).toBe(400);
          expect((await r.json()).error).toBe("profile_incomplete");
        }

        // UN-BRICK — PUT /api/me completes the profile, then the gate lifts.
        const put = await api.put("/api/me", { headers: uh, data: { company: "Acme Corp" } });
        expect(put.ok()).toBeTruthy();
        expect((await api.get("/api/my-competitions")).status()).toBe(200);
      } finally { await api.dispose(); }
    } finally {
      if (userId) await sa.delete(`/api/admin/participants/${userId}`, { headers: h }).catch(() => {});
      await sa.dispose();
    }
  });

  test("requireCompetitionContext gates an incomplete profile on competition-scoped endpoints (admin-cleared edge)", async () => {
    await ensureState();
    const { sa, h } = await saCtx();
    let userId;
    try {
      const u = await bootstrapUser(sa, h);
      userId = u.userId;
      const { api } = await apiLogin(u.email, PARTICIPANT_PASS);
      try {
        // Complete profile, no event selected → the competition-context guard
        // passes the profile check and falls through to "No event selected".
        let st = await api.get("/api/status");
        expect(st.status()).toBe(400);
        expect((await st.json()).error).toBe("No event selected");
        // Admin clears a required field out-of-band → the SAME competition-scoped
        // endpoint now reports profile_incomplete (the profile check runs FIRST in
        // requireCompetitionContext, so a live in-competition session is gated too).
        const Database = require("better-sqlite3");
        const db = new Database(TEST_DB_PATH);
        db.prepare("UPDATE users SET title=NULL WHERE id=?").run(userId);
        db.close();
        st = await api.get("/api/status");
        expect(st.status()).toBe(400);
        expect((await st.json()).error).toBe("profile_incomplete");
      } finally { await api.dispose(); }
    } finally {
      if (userId) await sa.delete(`/api/admin/participants/${userId}`, { headers: h }).catch(() => {});
      await sa.dispose();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Nickname auto-generation + ASCII transliteration (v7.4.0)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Nickname auto-generation + ASCII transliteration (v7.4.0)", () => {
  test("_transliterateAscii maps accented / non-ASCII names to ASCII analogues", () => {
    const { _transliterateAscii } = require("../lib/util");
    expect(_transliterateAscii("José")).toBe("jose");
    expect(_transliterateAscii("Müller")).toBe("muller");
    expect(_transliterateAscii("Łukasz")).toBe("lukasz");   // ł does not NFKD-decompose — map covers it
    expect(_transliterateAscii("Strauß")).toBe("strauss");  // ß → ss
    expect(_transliterateAscii("Søren")).toBe("soren");     // ø → o
    expect(_transliterateAscii("Ñoño")).toBe("nono");
    expect(_transliterateAscii("François")).toBe("francois");
    expect(_transliterateAscii("O'Brien")).toBe("obrien");  // punctuation dropped
    expect(_transliterateAscii("北京")).toBe("");            // non-Latin → empty (caller falls back)
    expect(_transliterateAscii("")).toBe("");
    expect(_transliterateAscii(null)).toBe("");
  });


});


// ═══════════════════════════════════════════════════════════════════════════════
// Participant groups (v6.20) — many-to-many + live-synced competition binding
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Participant groups (v6.20)", () => {
  const Database = require("better-sqlite3");
  const openDb = () => new Database(TEST_DB_PATH, { readonly: true });
  const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  async function saCtx() {
    const { api, csrf } = await apiLogin("superadmin");
    return { api, h: { "x-csrf-token": csrf, "content-type": "application/json" } };
  }
  async function mkComp(api, h, name, startMs, dur, extra) {
    // v8.1.0 (PR 19) — callers that exercise GROUP-CLASH detection must pass
    // { group_leaderboard_enabled: true }: the rule exists only because the team
    // board averages each participant into exactly one group, so with the board
    // off there is no ambiguity to prevent and the 409 no longer fires.
    const r = await api.post("/api/admin/competitions", { headers: h, data: { name, start_time: new Date(startMs).toISOString(), duration_minutes: dur, ...(extra || {}) } });
    expect(r.ok(), `create comp: ${r.status()} ${await r.text()}`).toBeTruthy();
    return (await r.json()).competition.id;
  }
  async function mkGroup(api, h, name, userIds) {
    const r = await api.post("/api/admin/groups", { headers: h, data: { name, ...(userIds ? { userIds } : {}) } });
    expect(r.ok(), `create group: ${r.status()} ${await r.text()}`).toBeTruthy();
    return (await r.json()).group.id;
  }
  // Throwaway, approved participant — register + verify + approve. Used instead
  // of the shared seed users (S.alice/bob/carol) because other tests in this
  // file promote/block/tag those seed users, which would make assignment skip
  // them and flake these enrollment assertions. `withPassword` also runs the
  // reset flow so the user can log in (only the live-removal test needs that).
  async function mkApprovedUser(api, h, withPassword) {
    const s = uniq();
    const email = `grp_${s}@acme.com`;
    await registerPost(api, "/api/register", { headers: h, data: {
      firstName: "Grp", lastName: "User", nickname: `grpuser_${s}`, email,
      company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC",
    }});
    const list = await (await api.get("/api/admin/participants?limit=2000")).json();
    const u = list.participants.find(p => p.email === email);
    await api.post(`/api/admin/participants/${u.id}/verify`, { headers: h });
    await api.post(`/api/admin/participants/${u.id}/approve`, { headers: h });
    if (withPassword) {
    }
    return { id: u.id, email };
  }
  const mkUser = (api, h) => mkApprovedUser(api, h, true);

  test("group CRUD: create, nocase-dup 409, rename, list, delete", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid;
    try {
      const name = `Squad ${uniq()}`;
      gid = await mkGroup(api, h, name);
      const dup = await api.post("/api/admin/groups", { headers: h, data: { name: name.toLowerCase() } });
      expect(dup.status()).toBe(409);
      const newName = `Renamed ${uniq()}`;
      expect((await api.put(`/api/admin/groups/${gid}`, { headers: h, data: { name: newName } })).ok()).toBeTruthy();
      const list = await (await api.get("/api/admin/groups")).json();
      expect(list.find(g => g.id === gid)?.name).toBe(newName);
      // v7.15.32 — the RENAME-onto-a-collision branch, relocated here from a
      // near-duplicate that had been sitting in badge.api.spec.js. Creating a
      // colliding name was already covered above; renaming ONTO one is a
      // separate code path and this is the only assertion on it.
      let victim;
      try {
        const taken = `Taken ${uniq()}`;
        victim = await mkGroup(api, h, taken);
        const clash = await api.put(`/api/admin/groups/${gid}`, { headers: h, data: { name: taken.toUpperCase() } });
        expect(clash.status(), "renaming onto an existing name (case-folded) must 409").toBe(409);
        const after = await (await api.get("/api/admin/groups")).json();
        expect(after.find(g => g.id === gid)?.name, "a refused rename must not have applied").toBe(newName);
      } finally {
        if (victim) await api.delete(`/api/admin/groups/${victim}`, { headers: h }).catch(() => {});
      }
    } finally {
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  test("members add/remove + groups attached to participant payloads", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid;
    try {
      gid = await mkGroup(api, h, `Grp ${uniq()}`, [S.alice.id]);
      let mem = await (await api.get(`/api/admin/groups/${gid}/members`)).json();
      expect(mem.members.some(m => m.id === S.alice.id)).toBeTruthy();
      expect((await (await api.post(`/api/admin/groups/${gid}/members`, { headers: h, data: { userIds: [S.bob.id] } })).json()).added).toBe(1);
      const parts = await (await api.get("/api/admin/participants?limit=2000")).json();
      const alice = parts.participants.find(p => p.id === S.alice.id);
      expect(alice.groups.some(g => g.id === gid)).toBeTruthy();
      expect((await api.delete(`/api/admin/groups/${gid}/members/${S.bob.id}`, { headers: h })).ok()).toBeTruthy();
      mem = await (await api.get(`/api/admin/groups/${gid}/members`)).json();
      expect(mem.members.some(m => m.id === S.bob.id)).toBeFalsy();
    } finally {
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  test("live-sync ADD: bind to upcoming enrolls members (direct_assigned=0); direct assignment stays 1; later group add auto-enrolls", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid, compId; const users = [];
    try {
      const u1 = await mkApprovedUser(api, h); // via group
      const u2 = await mkApprovedUser(api, h); // direct
      const u3 = await mkApprovedUser(api, h); // added to group later
      users.push(u1.id, u2.id, u3.id);
      compId = await mkComp(api, h, `GSyncAdd ${uniq()}`, Date.now() + 3600_000, 60);
      gid = await mkGroup(api, h, `GSyncAdd ${uniq()}`, [u1.id]);
      await api.post("/api/admin/competitions/assign", { headers: h, data: { userIds: [u2.id], competitionIds: [compId] } });
      const bind = await api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [gid], competitionIds: [compId] } });
      expect(bind.ok(), `bind: ${bind.status()} ${await bind.text()}`).toBeTruthy();
      expect((await bind.json()).groupsBound).toBeGreaterThanOrEqual(1);
      let db = openDb();
      const row = (uid) => db.prepare("SELECT direct_assigned FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uid);
      expect(row(u1.id)?.direct_assigned).toBe(0); // via group
      expect(row(u2.id)?.direct_assigned).toBe(1); // direct
      db.close();
      await api.post(`/api/admin/groups/${gid}/members`, { headers: h, data: { userIds: [u3.id] } });
      db = openDb();
      expect(db.prepare("SELECT direct_assigned FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, u3.id)?.direct_assigned).toBe(0);
      db.close();
    } finally {
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      for (const uid of users) await api.delete(`/api/admin/participants/${uid}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  test("live-sync REMOVE: leaving a bound group removes from upcoming; a directly-assigned member is sticky", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid, compId; const users = [];
    try {
      const uDirect = await mkApprovedUser(api, h);
      const uGroupOnly = await mkApprovedUser(api, h);
      users.push(uDirect.id, uGroupOnly.id);
      compId = await mkComp(api, h, `GSyncRem ${uniq()}`, Date.now() + 3600_000, 60);
      gid = await mkGroup(api, h, `GSyncRem ${uniq()}`, [uDirect.id, uGroupOnly.id]);
      await api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [gid], competitionIds: [compId] } });
      // Promote uDirect to a direct member.
      await api.post("/api/admin/competitions/assign", { headers: h, data: { userIds: [uDirect.id], competitionIds: [compId] } });
      // Remove both from the group.
      await api.delete(`/api/admin/groups/${gid}/members/${uDirect.id}`, { headers: h });
      await api.delete(`/api/admin/groups/${gid}/members/${uGroupOnly.id}`, { headers: h });
      const db = openDb();
      const inComp = (uid) => db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uid);
      expect(inComp(uDirect.id), "direct member should stay").toBeTruthy();
      expect(inComp(uGroupOnly.id), "group-only member should be removed").toBeFalsy();
      db.close();
    } finally {
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      for (const uid of users) await api.delete(`/api/admin/participants/${uid}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  test("live-sync REMOVE from a LIVE comp writes an absence row", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid, compId; let user;
    try {
      compId = await mkComp(api, h, `GSyncLive ${uniq()}`, Date.now() - 30 * 60_000, 180); // live
      user = await mkUser(api, h);
      gid = await mkGroup(api, h, `GSyncLive ${uniq()}`, [user.id]);
      await api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [gid], competitionIds: [compId] } });
      // User logs in + selects the live comp so login_time is set.
      const { api: uApi, csrf: uCsrf } = await apiLogin(user.email, PARTICIPANT_PASS);
      await uApi.post("/api/select-competition", { headers: { "x-csrf-token": uCsrf, "content-type": "application/json" }, data: { competitionId: compId } });
      await uApi.dispose();
      // Remove from the group → live removal with absence tracking.
      await api.delete(`/api/admin/groups/${gid}/members/${user.id}`, { headers: h });
      const db = openDb();
      expect(db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, user.id)).toBeFalsy();
      expect(db.prepare("SELECT 1 FROM competition_user_absences WHERE competition_id=? AND user_id=? AND returned_at IS NULL").get(compId, user.id), "absence row written").toBeTruthy();
      db.close();
    } finally {
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      if (user) await api.delete(`/api/admin/participants/${user.id}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  test("freeze: adding a member to a group bound to an ENDED comp does not enroll them", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid, compId, liveId; const users = [];
    try {
      const uEarly = await mkApprovedUser(api, h);
      const uLate = await mkApprovedUser(api, h);
      users.push(uEarly.id, uLate.id);
      // Live comp (start in the past) so end-now actually flips status to
      // "ended" — a future-dated comp reports "upcoming" regardless of ended_at.
      compId = await mkComp(api, h, `GFreeze ${uniq()}`, Date.now() - 30 * 60_000, 60);
      gid = await mkGroup(api, h, `GFreeze ${uniq()}`, [uEarly.id]);
      await api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [gid], competitionIds: [compId] } });
      expect((await api.post(`/api/admin/competitions/${compId}/end-now`, { headers: h, data: {} })).ok()).toBeTruthy();
      // v8.12.4 — CONTROL: the same group is also bound to a LIVE event, where
      // the add MUST enrol. Without it, "not enrolled in the ended one" is
      // satisfied by a group add that enrols nobody anywhere (or that failed).
      liveId = await mkComp(api, h, `GFreezeLive ${uniq()}`, Date.now() - 30 * 60_000, 120);
      const bind = await api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [gid], competitionIds: [liveId] } });
      expect(bind.ok(), `bind to the live control: ${await bind.text()}`).toBeTruthy();
      // Adding uLate now must NOT enroll them (frozen).
      const add = await api.post(`/api/admin/groups/${gid}/members`, { headers: h, data: { userIds: [uLate.id] } });
      expect(add.ok(), `the member add itself succeeds: ${await add.text()}`).toBeTruthy();
      const db = openDb();
      try {
        expect(db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uLate.id),
          "the ENDED event is frozen").toBeFalsy();
        expect(db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(liveId, uLate.id),
          "CONTROL: the live event enrols them").toBeTruthy();
      } finally { db.close(); }
    } finally {
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      if (liveId) {
        await api.post(`/api/admin/competitions/${liveId}/end-now`, { headers: h, data: {} }).catch(() => {});
        await api.delete(`/api/admin/competitions/${liveId}`, { headers: h }).catch(() => {});
      }
      for (const uid of users) await api.delete(`/api/admin/participants/${uid}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  test("exclusion: manual removal tombstones; reconcile won't re-add; direct re-assign clears it", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid, compId; const users = [];
    try {
      const uExcl = await mkApprovedUser(api, h);
      const uTrigger = await mkApprovedUser(api, h);
      users.push(uExcl.id, uTrigger.id);
      compId = await mkComp(api, h, `GExcl ${uniq()}`, Date.now() + 3600_000, 60);
      gid = await mkGroup(api, h, `GExcl ${uniq()}`, [uExcl.id]);
      await api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [gid], competitionIds: [compId] } });
      // Manual remove → exclusion tombstone.
      await api.delete(`/api/admin/competitions/${compId}/users/${uExcl.id}`, { headers: h });
      let db = openDb();
      expect(db.prepare("SELECT 1 FROM competition_group_exclusions WHERE competition_id=? AND user_id=?").get(compId, uExcl.id), "exclusion row").toBeTruthy();
      db.close();
      // Trigger a reconcile (add another member) — uExcl must NOT be re-added.
      await api.post(`/api/admin/groups/${gid}/members`, { headers: h, data: { userIds: [uTrigger.id] } });
      db = openDb();
      expect(db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uExcl.id), "still excluded").toBeFalsy();
      db.close();
      // Direct re-assign clears the exclusion.
      await api.post("/api/admin/competitions/assign", { headers: h, data: { userIds: [uExcl.id], competitionIds: [compId] } });
      db = openDb();
      expect(db.prepare("SELECT 1 FROM competition_group_exclusions WHERE competition_id=? AND user_id=?").get(compId, uExcl.id), "exclusion cleared").toBeFalsy();
      expect(db.prepare("SELECT direct_assigned FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uExcl.id)?.direct_assigned).toBe(1);
      db.close();
    } finally {
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      for (const uid of users) await api.delete(`/api/admin/participants/${uid}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  test("unbind + group delete both reconcile (remove group-only members)", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid1, gid2, compId; const users = [];
    try {
      const uA = await mkApprovedUser(api, h);
      const uB = await mkApprovedUser(api, h);
      users.push(uA.id, uB.id);
      compId = await mkComp(api, h, `GUnbind ${uniq()}`, Date.now() + 3600_000, 60);
      gid1 = await mkGroup(api, h, `GUnbindA ${uniq()}`, [uA.id]);
      gid2 = await mkGroup(api, h, `GUnbindB ${uniq()}`, [uB.id]);
      await api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [gid1, gid2], competitionIds: [compId] } });
      // Unbind gid1 → uA removed.
      expect((await api.delete(`/api/admin/competitions/${compId}/groups/${gid1}`, { headers: h })).ok()).toBeTruthy();
      let db = openDb();
      expect(db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uA.id)).toBeFalsy();
      expect(db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uB.id)).toBeTruthy();
      db.close();
      // Delete gid2 → uB removed.
      await api.delete(`/api/admin/groups/${gid2}`, { headers: h });
      gid2 = null;
      db = openDb();
      expect(db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uB.id)).toBeFalsy();
      db.close();
    } finally {
      if (gid1) await api.delete(`/api/admin/groups/${gid1}`, { headers: h }).catch(() => {});
      if (gid2) await api.delete(`/api/admin/groups/${gid2}`, { headers: h }).catch(() => {});
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      for (const uid of users) await api.delete(`/api/admin/participants/${uid}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  test("invitation groupIds: existing user joins immediately; new user joins on registration + lands in bound comp", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid, compId; let newUserId; const users = [];
    try {
      const uExisting = await mkApprovedUser(api, h);
      users.push(uExisting.id);
      compId = await mkComp(api, h, `GInvite ${uniq()}`, Date.now() + 3600_000, 60);
      gid = await mkGroup(api, h, `GInvite ${uniq()}`);
      await api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [gid], competitionIds: [compId] } });
      // Existing user invited with the group → joins immediately + enrolled.
      const invExisting = await api.post("/api/admin/invitations", { headers: h, data: { emails: [uExisting.email], groupIds: [gid] } });
      expect(invExisting.ok(), `invite existing: ${invExisting.status()} ${await invExisting.text()}`).toBeTruthy();
      let db = openDb();
      expect(db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").get(gid, uExisting.id), "existing user joined group").toBeTruthy();
      expect(db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uExisting.id), "existing user enrolled live").toBeTruthy();
      db.close();
      // New email invited with the group → invitation stores group_ids.
      const newEmail = `ginv_${uniq()}@acme.com`;
      const invNew = await api.post("/api/admin/invitations", { headers: h, data: { emails: [newEmail], groupIds: [gid] } });
      expect(invNew.ok()).toBeTruthy();
      db = openDb();
      const invRow = db.prepare("SELECT id, group_ids FROM invitations WHERE LOWER(email)=LOWER(?) AND used_at IS NULL").get(newEmail);
      db.close();
      expect(invRow, "invitation row").toBeTruthy();
      expect(JSON.parse(invRow.group_ids)).toContain(gid);
      // Register against the invitation → joins group + reconcile enrolls into bound comp.
      const { api: reg, csrf: rc } = await freshCtx();
      const regRes = await registerPost(reg, "/api/register", { headers: { "x-csrf-token": rc, "content-type": "application/json" }, data: {
        firstName: "Inv", lastName: "Ited", nickname: `invited_${uniq()}`, email: newEmail,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "NYC", invitationId: invRow.id,
      }});
      expect(regRes.ok(), `register invited: ${regRes.status()} ${await regRes.text()}`).toBeTruthy();
      await reg.dispose();
      db = openDb();
      const newU = db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(newEmail);
      newUserId = newU?.id;
      expect(db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").get(gid, newUserId), "new user joined group").toBeTruthy();
      expect(db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, newUserId), "new user enrolled via group").toBeTruthy();
      db.close();
    } finally {
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      if (newUserId) await api.delete(`/api/admin/participants/${newUserId}`, { headers: h }).catch(() => {});
      for (const uid of users) await api.delete(`/api/admin/participants/${uid}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  test("invitation register persists job_function + city → no profile re-prompt (v6.20.x regression)", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let newUserId;
    try {
      // Admin invites a brand-new corporate email (no groups — isolate the role/city path).
      const email = `invjf_${uniq()}@acme.com`;
      const inv = await api.post("/api/admin/invitations", { headers: h, data: { emails: [email] } });
      expect(inv.ok(), `invite: ${inv.status()} ${await inv.text()}`).toBeTruthy();
      let db = openDb();
      const invRow = db.prepare("SELECT id FROM invitations WHERE LOWER(email)=LOWER(?) AND used_at IS NULL").get(email);
      db.close();
      expect(invRow, "invitation row").toBeTruthy();

      // Register through the invitation, supplying role + city exactly like the form does.
      // Use values that differ from the test-mode `??` defaults so a dropped column
      // would surface as NULL (not the default) and fail the assertion below.
      const { api: reg, csrf: rc } = await freshCtx();
      const regRes = await registerPost(reg, "/api/register", { headers: { "x-csrf-token": rc, "content-type": "application/json" }, data: {
        firstName: "Inv", lastName: "Jf", nickname: `invjf_${uniq()}`, email,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        jobFunction: "Security Researcher", city: "Tel Aviv", invitationId: invRow.id,
      }});
      expect(regRes.ok(), `register invited: ${regRes.status()} ${await regRes.text()}`).toBeTruthy();
      await reg.dispose();

      // The invited user row MUST carry the submitted role + city. Pre-fix the
      // invitation INSERT dropped both columns, so _profileMissingFields flagged
      // them and the non-dismissible profile-completion gate re-prompted for role
      // + city on first login.
      db = openDb();
      const u = db.prepare("SELECT id, job_function, city, company, title, country, timezone FROM users WHERE LOWER(email)=LOWER(?)").get(email);
      db.close();
      expect(u, "invited user row").toBeTruthy();
      newUserId = u.id;
      expect(u.job_function).toBe("Security Researcher");
      expect(u.city).toBe("Tel Aviv");
      // Every gated profile field is populated → profile complete → no re-prompt.
      for (const f of ["job_function", "city", "company", "title", "country", "timezone"]) {
        expect(u[f], `field ${f} populated`).toBeTruthy();
      }
    } finally {
      if (newUserId) await api.delete(`/api/admin/participants/${newUserId}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  test("analytics includeGroups / excludeGroups filter by membership", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid;
    try {
      // Alice has challenge_events in the seeded Test Live competition.
      gid = await mkGroup(api, h, `GAnalytics ${uniq()}`, [S.alice.id]);
      // excludeParticipantTags= disables the default "staff" exclusion so this
      // stays correct even if another test left alice promoted (staff).
      const base = `/api/admin/analytics/challenges?scope=competition&competitionId=${S.liveComp.id}&excludeParticipantTags=`;
      const full = await (await api.get(base)).json();
      const incl = await (await api.get(`${base}&includeGroups=${gid}`)).json();
      const excl = await (await api.get(`${base}&excludeGroups=${gid}`)).json();
      // includeGroups and excludeGroups partition participants (in-group vs not),
      // so their counts must sum to the unfiltered totals. Alice solved at least
      // one challenge in seed, so the in-group slice is non-empty.
      expect(full.summary.solved).toBeGreaterThanOrEqual(1);
      expect(incl.summary.solved).toBeGreaterThanOrEqual(1);
      expect(incl.summary.solved + excl.summary.solved).toBe(full.summary.solved);
      expect(incl.summary.incorrect + excl.summary.incorrect).toBe(full.summary.incorrect);
    } finally {
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  test("logs groupId filter returns only the group's members' rows", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid;
    try {
      gid = await mkGroup(api, h, `GLogs ${uniq()}`, [S.alice.id]);
      // v8.12.4 — fresh activity for BOTH alice and bob, so the filter has rows
      // to keep and rows to drop. The old loop asserted inside `if (pid)` and
      // passed on an empty result.
      for (const who of ["alice@acme.com", "bob@acme.com"]) { const x = await apiLogin(who, PARTICIPANT_PASS); await x.api.dispose(); }
      const pidOf = (e) => (e.user_id && e.user_id !== "superadmin") ? e.user_id : (e.scope === "user" ? e.scope_id : null);
      const res = await api.get(`/api/admin/logs?stream=app&groupId=${gid}&limit=200`);
      expect(res.ok()).toBeTruthy();
      const { entries } = await res.json();
      const pids = entries.map(pidOf).filter(Boolean);
      expect(pids, "the member's own rows come back").toContain(S.alice.id);
      expect(pids.every(p => p === S.alice.id), "and nobody else's").toBe(true);
      const unfiltered = (await (await api.get("/api/admin/logs?stream=app&limit=500")).json()).entries.map(pidOf);
      expect(unfiltered, "CONTROL: without the filter a non-member's row is there to drop").toContain(S.bob.id);
    } finally {
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  // v6.20.6 — picker is server-paginated and supports search/filter across
  // ALL participants (not just the first page). Asserts: members always
  // returned in full; candidates respect limit/offset; search reaches a
  // user beyond the first page (proving the filter isn't client-side over
  // a window).
  test("v6.20.6: groups picker pages and searches across ALL participants", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid; const users = [];
    try {
      const u1 = await mkApprovedUser(api, h);
      const u2 = await mkApprovedUser(api, h);
      users.push(u1.id, u2.id);
      gid = await mkGroup(api, h, `Picker ${uniq()}`, [u1.id]);
      // Members are always returned in full; candidates exclude members.
      const p1 = await (await api.get(`/api/admin/groups/${gid}/picker?limit=2`)).json();
      expect(p1.members.some(m => m.id === u1.id)).toBeTruthy();
      expect(p1.candidates.some(c => c.id === u1.id)).toBeFalsy();
      expect(p1.candidates.length).toBeLessThanOrEqual(2);
      expect(p1.candidatesTotal).toBeGreaterThanOrEqual(1);
      // Search the unique nickname of u2 (created beyond any first page) —
      // must surface even when the candidate pool is huge.
      const meRow = await (await api.get(`/api/admin/participants?limit=2000`)).json();
      const u2row = meRow.participants.find(p => p.id === u2.id);
      const p2 = await (await api.get(`/api/admin/groups/${gid}/picker?search=${encodeURIComponent(u2row.nickname)}`)).json();
      expect(p2.candidates.some(c => c.id === u2.id)).toBeTruthy();
      expect(p2.searchApplied).toBe(true);
    } finally {
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  // v6.20.6 — single batch endpoint replaces the N+1 fan-out that the
  // group-bind dialog used to do. Asserts the `bound` flag is correct
  // and ended competitions are excluded.
  test("v6.20.6: groups bound-competitions endpoint flags bindings, excludes ended", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid, liveCompId, endedCompId; const users = [];
    try {
      const u1 = await mkApprovedUser(api, h); users.push(u1.id);
      gid = await mkGroup(api, h, `Bind ${uniq()}`, [u1.id]);
      liveCompId = await mkComp(api, h, `Live ${uniq()}`, Date.now() + 3600_000, 60);
      endedCompId = await mkComp(api, h, `Ended ${uniq()}`, Date.now() - 3600_000, 30);
      await api.post(`/api/admin/competitions/${endedCompId}/end-now`, { headers: h });
      // Bind to the upcoming live one only.
      await api.post(`/api/admin/competitions/assign`, { headers: h, data: { groupIds: [gid], competitionIds: [liveCompId] } });
      const out = await (await api.get(`/api/admin/groups/${gid}/competitions`)).json();
      const live = (out.competitions || []).find(c => c.id === liveCompId);
      expect(live, "live comp present").toBeTruthy();
      expect(live.bound).toBe(true);
      expect((out.competitions || []).find(c => c.id === endedCompId), "ended comp omitted").toBeFalsy();
    } finally {
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      if (liveCompId) await api.delete(`/api/admin/competitions/${liveCompId}`, { headers: h }).catch(() => {});
      if (endedCompId) await api.delete(`/api/admin/competitions/${endedCompId}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  // v6.20.6 — cap the create-with-members payload so a single call can't
  // trigger reconciliation across an arbitrary set.
  test("v6.20.6: POST /groups caps initial-members at BULK_ADMIN_MAX (1000)", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    const fakeIds = Array.from({ length: 1001 }, (_, i) => `nope-${i}`);
    const r = await api.post("/api/admin/groups", { headers: h, data: { name: `Cap ${uniq()}`, userIds: fakeIds } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/1000/);
    await api.dispose();
  });

  test("export carries group names; import recreates a group + membership", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid; let importedUserId; let importedGroupId;
    const gName = `GExport ${uniq()}`;
    try {
      gid = await mkGroup(api, h, gName, [S.alice.id]);
      const exp = await (await api.get("/api/admin/export/participants")).json();
      const aliceRow = exp.participants.find(p => p.email === "alice@acme.com");
      expect(aliceRow.groups).toContain(gName);
      // Import a brand-new participant carrying a brand-new group name.
      const importGroupName = `GImport ${uniq()}`;
      const importEmail = `gimport_${uniq()}@acme.com`;
      const payload = { type: "hackarena-participants", version: 2, participants: [
        { first_name: "Imp", last_name: "Ort", nickname: `imp_${uniq()}`, email: importEmail, groups: [importGroupName] },
      ]};
      const dry = await (await api.post("/api/admin/import/participants", { headers: h, data: { data: payload } })).json();
      expect(dry.dryRun).toBe(true);
      const importRes = await api.post("/api/admin/import/participants", { headers: h, data: { data: payload, resolutions: {} } });
      expect(importRes.ok(), `import: ${importRes.status()} ${await importRes.text()}`).toBeTruthy();
      const db = openDb();
      const grp = db.prepare("SELECT id FROM groups WHERE name=? COLLATE NOCASE").get(importGroupName);
      expect(grp, "import created the group").toBeTruthy();
      importedGroupId = grp.id;
      const u = db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(importEmail);
      importedUserId = u?.id;
      expect(db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").get(importedGroupId, importedUserId), "membership recreated").toBeTruthy();
      db.close();
    } finally {
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      if (importedGroupId) await api.delete(`/api/admin/groups/${importedGroupId}`, { headers: h }).catch(() => {});
      if (importedUserId) await api.delete(`/api/admin/participants/${importedUserId}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  // v6.20.x — import is a live-synced group entry point: importing a participant
  // into a group bound to a live/upcoming competition must enroll them, matching
  // every other membership path (members POST, per-participant chip, invitations).
  test("v6.20.x: importing a participant into a bound group reconciles them into the competition", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid, compId, importedUserId;
    const gName = `GImportSync ${uniq()}`;
    const importEmail = `gimportsync_${uniq()}@acme.com`;
    try {
      // Group bound to a fresh UPCOMING competition (so reconcile enrolls, not freezes).
      gid = await mkGroup(api, h, gName);
      compId = await mkComp(api, h, `GImportSync ${uniq()}`, Date.now() + 3600_000, 60);
      const bind = await api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [gid], competitionIds: [compId] } });
      expect(bind.ok(), `bind: ${bind.status()} ${await bind.text()}`).toBeTruthy();
      // Import a brand-new participant carrying the bound group's name.
      const payload = { type: "hackarena-participants", version: 2, participants: [
        { first_name: "Imp", last_name: "Sync", nickname: `impsync_${uniq()}`, email: importEmail, groups: [gName] },
      ]};
      // Dry-run, then real import.
      await api.post("/api/admin/import/participants", { headers: h, data: { data: payload } });
      const res = await api.post("/api/admin/import/participants", { headers: h, data: { data: payload, resolutions: {} } });
      expect(res.ok(), `import: ${res.status()} ${await res.text()}`).toBeTruthy();
      const db = openDb();
      importedUserId = db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(importEmail)?.id;
      expect(importedUserId, "imported user exists").toBeTruthy();
      // The reconcile runs after the import txn commits — group-origin enrollment
      // (direct_assigned=0). Poll briefly to allow the post-commit reconcile.
      let enrolled = null;
      for (let i = 0; i < 20 && !enrolled; i++) {
        enrolled = db.prepare("SELECT direct_assigned FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, importedUserId);
        if (!enrolled) await new Promise(r => setTimeout(r, 50));
      }
      db.close();
      expect(enrolled, "imported member must be reconciled into the bound competition").toBeTruthy();
      expect(enrolled.direct_assigned, "import enrollment is group-origin (direct_assigned=0)").toBe(0);
    } finally {
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      if (importedUserId) await api.delete(`/api/admin/participants/${importedUserId}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  // v7.11.3 — import keeps the "one group per competition" invariant by DROPPING (not
  // rejecting) a group association that would put a participant in ≥2 groups bound to the
  // same competition. Groups bound to different comps (or nowhere) are kept.
  test("v7.11.3: import drops a clashing group association, keeps the rest", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let compId, otherComp, g1, g2, g3, importedUserId;
    const g1Name = `IClashA ${uniq()}`, g2Name = `IClashB ${uniq()}`, g3Name = `IClashC ${uniq()}`;
    const importEmail = `iclash_${uniq()}@acme.com`;
    try {
      compId = await mkComp(api, h, `IClashComp ${uniq()}`, Date.now() + 3600_000, 60, { group_leaderboard_enabled: true });
      otherComp = await mkComp(api, h, `IClashOther ${uniq()}`, Date.now() + 3600_000, 60, { group_leaderboard_enabled: true });
      g1 = await mkGroup(api, h, g1Name);
      g2 = await mkGroup(api, h, g2Name);
      g3 = await mkGroup(api, h, g3Name);
      // g1 + g2 BOTH bound to compId (empty → no bind clash); g3 bound to a DIFFERENT comp.
      for (const g of [g1, g2]) expect((await api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [g], competitionIds: [compId] } })).ok()).toBeTruthy();
      expect((await api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [g3], competitionIds: [otherComp] } })).ok()).toBeTruthy();
      // Import a participant into all three groups — g1+g2 clash on compId, g3 does not.
      const payload = { type: "hackarena-participants", version: 2, participants: [
        { first_name: "Im", last_name: "Clash", nickname: `imclash_${uniq()}`, email: importEmail, groups: [g1Name, g2Name, g3Name] },
      ]};
      await api.post("/api/admin/import/participants", { headers: h, data: { data: payload } }); // dry-run
      const res = await api.post("/api/admin/import/participants", { headers: h, data: { data: payload, resolutions: {} } });
      expect(res.ok(), `import: ${res.status()} ${await res.text()}`).toBeTruthy();
      const body = await res.json();
      expect(body.group_clashes_dropped, "response reports the dropped clash").toBeGreaterThanOrEqual(1);
      const db = openDb();
      importedUserId = db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(importEmail)?.id;
      expect(importedUserId, "imported user exists").toBeTruthy();
      const inG = (gid) => db.prepare("SELECT COUNT(*) c FROM group_members WHERE user_id=? AND group_id=?").get(importedUserId, gid).c;
      expect(inG(g1) + inG(g2), "EXACTLY ONE of the two same-comp-bound groups kept (clash dropped)").toBe(1);
      expect(inG(g3), "group bound to a DIFFERENT competition is kept").toBe(1);
      db.close();
    } finally {
      for (const g of [g1, g2, g3]) if (g) await api.delete(`/api/admin/groups/${g}`, { headers: h }).catch(() => {});
      for (const c of [compId, otherComp]) if (c) await api.delete(`/api/admin/competitions/${c}`, { headers: h }).catch(() => {});
      if (importedUserId) await api.delete(`/api/admin/participants/${importedUserId}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  // v6.20.x — per-participant group-chip routes fire the full reconcile engine
  // but had zero coverage. Add via POST /participants/:id/groups → enrolled
  // group-origin; remove via DELETE → reconciled out.
  test("v6.20.x: per-participant group-chip add/remove reconciles bound competitions", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid, compId, uid;
    try {
      const u = await mkApprovedUser(api, h); uid = u.id;
      gid = await mkGroup(api, h, `Chip ${uniq()}`);
      compId = await mkComp(api, h, `Chip ${uniq()}`, Date.now() + 3600_000, 60);
      await api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [gid], competitionIds: [compId] } });
      // Add via the per-participant chip route.
      const addR = await api.post(`/api/admin/participants/${uid}/groups`, { headers: h, data: { groupId: gid } });
      expect(addR.ok(), `chip add: ${addR.status()} ${await addR.text()}`).toBeTruthy();
      const db = openDb();
      let row = db.prepare("SELECT direct_assigned FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uid);
      expect(row, "chip add must enroll into the bound comp").toBeTruthy();
      expect(row.direct_assigned, "chip enrollment is group-origin").toBe(0);
      // Remove via the per-participant chip route → group-only member reconciled out.
      const delR = await api.delete(`/api/admin/participants/${uid}/groups/${gid}`, { headers: h });
      expect(delR.ok()).toBeTruthy();
      row = db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uid);
      db.close();
      expect(row, "chip remove must reconcile the group-only member out").toBeFalsy();
    } finally {
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      if (uid) await api.delete(`/api/admin/participants/${uid}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  // v6.20.x — manual-removal tombstone is now cleared when the user LEAVES the
  // bound group, so a later re-add via the group re-enrolls them. Pre-fix the
  // tombstone was clearable only by a direct assign → leave+rejoin stayed stuck.
  test("v6.20.x: leaving a bound group clears the tombstone so a re-add re-enrolls", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid, compId, uid;
    try {
      const u = await mkApprovedUser(api, h); uid = u.id;
      gid = await mkGroup(api, h, `Tomb ${uniq()}`, [uid]);
      compId = await mkComp(api, h, `Tomb ${uniq()}`, Date.now() + 3600_000, 60);
      await api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [gid], competitionIds: [compId] } });
      const db = openDb();
      // Member is enrolled via the group.
      expect(db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uid), "enrolled via group").toBeTruthy();
      // Manual removal writes a tombstone.
      await api.delete(`/api/admin/competitions/${compId}/users/${uid}`, { headers: h });
      expect(db.prepare("SELECT 1 FROM competition_group_exclusions WHERE competition_id=? AND user_id=?").get(compId, uid), "tombstone written on manual removal").toBeTruthy();
      // Leave the group → tombstone should clear (user no longer desired anywhere).
      await api.delete(`/api/admin/groups/${gid}/members/${uid}`, { headers: h });
      expect(db.prepare("SELECT 1 FROM competition_group_exclusions WHERE competition_id=? AND user_id=?").get(compId, uid), "tombstone cleared on group leave").toBeFalsy();
      // Re-add to the group → reconcile re-enrolls (pre-fix this stayed empty).
      await api.post(`/api/admin/groups/${gid}/members`, { headers: h, data: { userIds: [uid] } });
      let row = null;
      for (let i = 0; i < 20 && !row; i++) {
        row = db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uid);
        if (!row) await new Promise(r => setTimeout(r, 50));
      }
      db.close();
      expect(row, "re-add via group must re-enroll after tombstone clear").toBeTruthy();
    } finally {
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      if (uid) await api.delete(`/api/admin/participants/${uid}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  // v6.20.x — previously-untested admin read routes. Lightweight coverage so a
  // regression in the requireAdmin gate or the response shape is caught.
  test("v6.20.x: GET /api/admin/tags returns merged permanent+custom tags; 401/403 for non-admin", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    try {
      const r = await api.get("/api/admin/tags");
      expect(r.ok()).toBeTruthy();
      const tags = await r.json();
      expect(Array.isArray(tags)).toBeTruthy();
      expect(tags).toContain("staff");
      expect(tags).toContain("benchmark");
    } finally { await api.dispose(); }
    // Participant must not reach it.
    const { api: pa } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const pr = await pa.get("/api/admin/tags");
    expect([401, 403]).toContain(pr.status());
    await pa.dispose();
  });

  test("v6.20.x: GET /api/admin/competitions/:id/groups lists bound groups with member_count; 404 unknown", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    let gid, compId, uid;
    try {
      const u = await mkApprovedUser(api, h); uid = u.id;
      gid = await mkGroup(api, h, `BoundList ${uniq()}`, [uid]);
      compId = await mkComp(api, h, `BoundList ${uniq()}`, Date.now() + 3600_000, 60);
      await api.post("/api/admin/competitions/assign", { headers: h, data: { groupIds: [gid], competitionIds: [compId] } });
      const r = await api.get(`/api/admin/competitions/${compId}/groups`);
      expect(r.ok()).toBeTruthy();
      const { groups } = await r.json();
      const bound = (groups || []).find(g => g.id === gid);
      expect(bound, "bound group is listed").toBeTruthy();
      expect(bound.member_count).toBe(1);
      // Unknown competition → 404.
      expect((await api.get("/api/admin/competitions/nope-does-not-exist/groups")).status()).toBe(404);
    } finally {
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      if (uid) await api.delete(`/api/admin/participants/${uid}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  test("v6.20.x: GET /asset-versions.js serves the version helper as JS", async () => {
    await ensureState();
    const { api } = await saCtx();
    try {
      const r = await api.get("/asset-versions.js");
      expect(r.ok()).toBeTruthy();
      expect((r.headers()["content-type"] || "")).toMatch(/javascript/);
      expect(await r.text()).toContain("__assetUrlWithVersion");
    } finally { await api.dispose(); }
  });

  // v6.20.x — participant-tag writes invalidate the leaderboard cache for the
  // comps the user is enrolled in (CLAUDE.md writer-lock matrix). Warm the
  // board, add a `staff` tag, re-read with no TTL wait → the staff user must
  // drop off immediately (staff are excluded from the participant board).
  test("v6.20.x: adding a staff tag invalidates the leaderboard cache immediately", async () => {
    await ensureState();
    const { api, h } = await saCtx();
    const tag = uniq();
    let compId, uid;
    try {
      const u = await mkApprovedUser(api, h); uid = u.id;
      compId = await mkComp(api, h, `TagCache ${uniq()}`, Date.now() - 3600_000, 180); // live
      const taskId = (await (await api.post("/api/admin/tasks", { headers: h, data: { title: `TagCacheTask ${tag}`, difficulty: "easy", correct_answer: "x", answer_type: "text", status: "published" } })).json()).id;
      await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: h, data: { competitionIds: [compId] } });
      await api.post("/api/admin/competitions/assign", { headers: h, data: { userIds: [uid], competitionIds: [compId] } });
      // Plant a correct submission so the user is on the board.
      const dbW = new Database(TEST_DB_PATH);
      try {
        dbW.prepare("INSERT INTO submissions (id, user_id, task_id, competition_id, timeslot_id, is_correct, points_delta, answer, submitted_at) VALUES (?,?,?,?,NULL,1,50,'x',?)")
          .run(`tc_${tag}`, uid, taskId, compId, new Date().toISOString());
      } finally { dbW.close(); }
      // Warm the admin leaderboard cache — user present.
      const lb1 = await (await api.get(`/api/admin/leaderboard?competitionId=${compId}`)).json();
      expect(lb1.some(e => e.userId === uid), "user on board before staff tag").toBeTruthy();
      // Tag as staff → must bust the cache for this user's comps.
      const tagR = await api.post(`/api/admin/participants/${uid}/tags`, { headers: h, data: { tag: "staff" } });
      expect(tagR.ok()).toBeTruthy();
      // Immediate re-read (well within the 5s TTL): staff excluded.
      const lb2 = await (await api.get(`/api/admin/leaderboard?competitionId=${compId}`)).json();
      expect(lb2.some(e => e.userId === uid), "staff user must drop off the board immediately (cache busted)").toBeFalsy();
      await api.delete(`/api/admin/tasks/${taskId}`, { headers: h }).catch(() => {});
    } finally {
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      if (uid) await api.delete(`/api/admin/participants/${uid}`, { headers: h }).catch(() => {});
      await api.dispose();
    }
  });

  // v6.20.x — RECONCILE_MAX_PER_CALL (500) per-pass cap + auto-drain. Seed >500
  // members into a group bound to an upcoming comp; the first reconcile enrolls
  // exactly 500, marks the response membersDeferred, and a detached drain pass
  // finishes the remainder. Uses the maintenance-gated bulk-seed endpoint.
  test("v6.20.x: reconcile caps at 500/pass then auto-drains the overflow", async () => {
    test.slow(); // seeding 600 users + two reconcile passes
    await ensureState();
    const fs = require("fs");
    const path = require("path");
    const { api, h } = await saCtx();
    const maintFile = path.join(TEST_DATA_DIR, ".maintenance");
    const byp = `recon-cap-${uniq()}`;
    const tag = uniq();
    let gid, compId;
    const seededEmails = [];
    try {
      // Create the group + upcoming comp BEFORE entering maintenance mode — the
      // .maintenance file 503s every request that lacks the bypass header, and
      // mkGroup/mkComp use the plain admin context.
      gid = await mkGroup(api, h, `ReconCap ${tag}`);
      compId = await mkComp(api, h, `ReconCap ${tag}`, Date.now() + 3600_000, 120);
      // Now enter maintenance mode for the bulk-seed + members-add (both carry
      // the bypass header). The bind that triggers reconcile also carries it.
      fs.writeFileSync(maintFile, byp);
      const bypH = { ...h, "x-maintenance-bypass": byp };
      const N = 600;
      const users = Array.from({ length: N }, (_, i) => {
        const email = `reconcap_${tag}_${i}@acme.com`;
        seededEmails.push(email);
        return { firstName: "Rc", lastName: `Cap${i}`, nickname: `reconcap_${tag}_${i}`, email };
      });
      const seed = await api.post("/api/admin/perf/bulk-seed-users", {
        headers: bypH,
        data: { users },
      });
      expect(seed.status(), `bulk-seed: ${seed.status()} ${await seed.text().catch(() => "")}`).toBe(200);
      // Collect the seeded user ids.
      const dbR = new Database(TEST_DB_PATH, { readonly: true });
      const ph = seededEmails.map(() => "?").join(",");
      const ids = dbR.prepare(`SELECT id FROM users WHERE email IN (${ph})`).all(...seededEmails).map(r => r.id);
      dbR.close();
      expect(ids.length).toBe(N);
      // Add all N members (members endpoint cap is BULK_ADMIN_MAX=1000) — comp
      // not yet bound, so this does not reconcile.
      const addR = await api.post(`/api/admin/groups/${gid}/members`, { headers: bypH, data: { userIds: ids } });
      expect(addR.ok(), `add members: ${addR.status()} ${await addR.text().catch(() => "")}`).toBeTruthy();
      // Bind to the upcoming comp → first reconcile pass runs.
      const bind = await api.post("/api/admin/competitions/assign", { headers: bypH, data: { groupIds: [gid], competitionIds: [compId] } });
      expect(bind.ok()).toBeTruthy();
      const bindBody = await bind.json();
      expect(bindBody.membersDeferred, "bind enrolling >500 must report membersDeferred").toBe(true);
      const countEnrolled = () => {
        const d = new Database(TEST_DB_PATH, { readonly: true });
        try { return d.prepare("SELECT COUNT(*) c FROM competition_users WHERE competition_id=?").get(compId).c; }
        finally { d.close(); }
      };
      // First pass caps at 500.
      expect(countEnrolled(), "first reconcile pass enrolls exactly the per-call cap").toBe(500);
      // Detached drain pass(es) finish the remaining 100 — poll.
      let final = 0;
      for (let i = 0; i < 40 && final < N; i++) {
        final = countEnrolled();
        if (final < N) await new Promise(r => setTimeout(r, 100));
      }
      expect(final, "auto-drain enrolls the overflow without another trigger").toBe(N);
    } finally {
      try { fs.unlinkSync(maintFile); } catch (_) {}
      if (compId) await api.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      if (gid) await api.delete(`/api/admin/groups/${gid}`, { headers: h }).catch(() => {});
      // Best-effort cleanup of the 600 seeded users.
      for (const email of seededEmails) {
        const d = new Database(TEST_DB_PATH, { readonly: true });
        let id; try { id = d.prepare("SELECT id FROM users WHERE email=?").get(email)?.id; } finally { d.close(); }
        if (id) await api.delete(`/api/admin/participants/${id}`, { headers: h }).catch(() => {});
      }
      await api.dispose();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// SELF-ENROLLMENT LINK (v6.21.0) — happy paths
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Self-enrollment link (v6.21.0)", () => {
  const Database = require("better-sqlite3");
  function saHdr(csrf) { return { "x-csrf-token": csrf, "content-type": "application/json" }; }
  async function makeComp(sa, h, name) {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const cr = await sa.post("/api/admin/competitions", { headers: h, data: { name, start_time: future, duration_minutes: 120 } });
    expect(cr.ok(), `create comp: ${cr.status()} ${await cr.text()}`).toBeTruthy();
    return (await cr.json()).competition.id;
  }
  async function reveal(sa, compId) {
    const r = await sa.get(`/api/admin/competitions/${compId}/self-enroll`);
    expect(r.ok(), `reveal: ${r.status()}`).toBeTruthy();
    return r.json();
  }
  async function setFlags(sa, h, compId, body) {
    const cur = await reveal(sa, compId);
    const r = await sa.put(`/api/admin/competitions/${compId}`, { headers: h, data: { ...body, expectedUpdatedAt: cur.updated_at } });
    expect(r.ok(), `setFlags: ${r.status()} ${await r.text()}`).toBeTruthy();
    return r.json();
  }
  async function dropComp(compId) {
    const { api, csrf } = await apiLogin("superadmin");
    await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
    await api.dispose();
  }
  async function dropUserByEmail(email) {
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const id = db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email)?.id;
    db.close();
    if (!id) return;
    const { api, csrf } = await apiLogin("superadmin");
    await api.delete(`/api/admin/participants/${id}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
    await api.dispose();
  }

  test("admin reveal returns a token + /join url matching the DB; disabled by default", async () => {
    await ensureState();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const compId = await makeComp(sa, saHdr(csrf), `SE-reveal-${Date.now()}`);
    const rv = await reveal(sa, compId);
    expect(typeof rv.token).toBe("string");
    expect(rv.token.length).toBeGreaterThan(20);
    expect(rv.url).toContain(`/join/${rv.token}`);
    expect(rv.enabled).toBe(false);            // off by default
    expect(rv, "the retired instant-join switch is not on the reveal").not.toHaveProperty("allow_instant");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const row = db.prepare("SELECT self_enroll_token, self_enroll_enabled FROM competitions WHERE id=?").get(compId);
    db.close();
    expect(row.self_enroll_token).toBe(rv.token);
    expect(row.self_enroll_enabled).toBe(0);
    await sa.dispose();
    await dropComp(compId);
  });

  test("the enable toggle round-trips via PUT; list exposes the flag but never the token", async () => {
    await ensureState();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = saHdr(csrf);
    const compId = await makeComp(sa, h, `SE-toggle-${Date.now()}`);
    await setFlags(sa, h, compId, { self_enroll_enabled: true });
    const list = await (await sa.get("/api/admin/competitions")).json();
    const row = list.find(c => c.id === compId);
    expect(row.self_enroll_enabled).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(row, "self_enroll_allow_instant"), "the retired instant-join switch is not listed").toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, "self_enroll_token")).toBe(false);
    await sa.dispose();
    await dropComp(compId);
  });

  test("public preview returns the competition on an enabled link, without the token", async () => {
    await ensureState();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = saHdr(csrf);
    const compId = await makeComp(sa, h, `SE-prev-${Date.now()}`);
    const rv = await reveal(sa, compId);
    await setFlags(sa, h, compId, { self_enroll_enabled: true });
    await sa.dispose();
    const { api } = await freshCtx();
    const pr = await api.get(`/api/competitions/self-enroll/${rv.token}`);
    expect(pr.status()).toBe(200);
    const pd = await pr.json();
    expect(pd.id).toBe(compId);
    expect(typeof pd.name).toBe("string");
    expect(Object.prototype.hasOwnProperty.call(pd, "token")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(pd, "self_enroll_token")).toBe(false);
    await api.dispose();
    await dropComp(compId);
  });

  test("authenticated participant joins via token, idempotently", async () => {
    await ensureState();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = saHdr(csrf);
    const compId = await makeComp(sa, h, `SE-join-${Date.now()}`);
    const rv = await reveal(sa, compId);
    await setFlags(sa, h, compId, { self_enroll_enabled: true });
    await sa.dispose();
    const { api, csrf: pcsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    const ph = { "x-csrf-token": pcsrf, "content-type": "application/json" };
    const j1 = await api.post("/api/competitions/join", { headers: ph, data: { token: rv.token } });
    expect(j1.ok(), `join1: ${j1.status()} ${await j1.text()}`).toBeTruthy();
    const b1 = await j1.json();
    expect(b1.competitionId).toBe(compId);
    expect(b1.alreadyMember).toBe(false);
    const j2 = await api.post("/api/competitions/join", { headers: ph, data: { token: rv.token } });
    expect(j2.ok()).toBeTruthy();
    expect((await j2.json()).alreadyMember).toBe(true);
    await api.dispose();
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const cnt = db.prepare("SELECT COUNT(*) c FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, S.carol.id).c;
    db.close();
    expect(cnt).toBe(1);
    await dropComp(compId); // cascades carol's throwaway membership
  });

  test("PR B / F#8: register+joinToken actually enrolls at the first authenticated login (deferred-consume model)", async () => {
    // The unified self-enroll timing model = "enroll at first authenticated entry".
    // It also locks that login truly fires
    // _consumePendingSelfEnroll and writes the membership row. Uses instant-join so
    // the registrant can sign in immediately (grace) without a separate verify.
    await ensureState();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = saHdr(csrf);
    const compId = await makeComp(sa, h, `SE-consume-${Date.now()}`);
    const rv = await reveal(sa, compId);
    await setFlags(sa, h, compId, { self_enroll_enabled: true });
    await sa.dispose();

    const { api, csrf: rcsrf } = await freshCtx();
    const email = `se-consume-${Date.now()}-${Math.floor(Math.random() * 1e6)}@company.co`;
    const nick = `seconsume${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 28);
    const rr = await registerPost(api, "/api/register", { headers: { "x-csrf-token": rcsrf, "content-type": "application/json" }, data: {
      firstName: "Self", lastName: "Consume", nickname: nick, email, company: "Co", title: "Eng",
      country: "US", timezone: "America/New_York", jobFunction: "Security Researcher", city: "Tel Aviv",
      joinToken: rv.token, password: PARTICIPANT_PASS,
    } });
    expect(rr.ok(), `register: ${rr.status()} ${await rr.text()}`).toBeTruthy();
    await api.dispose();

    const db0 = new Database(TEST_DB_PATH, { readonly: true });
    const userId = db0.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email).id;
    // Email first: the sign-up signs the new account in, and THAT sign-in consumes
    // the marker — the "first authenticated entry" is the registration itself.
    expect(db0.prepare("SELECT approved FROM users WHERE id=?").get(userId).approved, "a join-link registrant skips the approval queue").toBe(1);
    expect(db0.prepare("SELECT pending_self_enroll_comp_id AS c FROM users WHERE id=?").get(userId).c, "consumed by the sign-up's sign-in").toBeNull();
    expect(db0.prepare("SELECT COUNT(*) n FROM competition_users WHERE user_id=? AND competition_id=?").get(userId, compId).n).toBe(1);
    db0.close();

    // First authenticated entry → enrollment fires.
    const { api: li, csrf: lc } = await freshCtx();
    const lr = await codeLogin(li, email, { "x-csrf-token": lc, "content-type": "application/json" });
    expect(lr.ok(), `login: ${lr.status()} ${await lr.text()}`).toBeTruthy();
    await li.dispose();

    const db = new Database(TEST_DB_PATH, { readonly: true });
    const cu = db.prepare("SELECT assigned_by, direct_assigned FROM competition_users WHERE user_id=? AND competition_id=?").get(userId, compId);
    const after = db.prepare("SELECT pending_self_enroll_comp_id AS c FROM users WHERE id=?").get(userId);
    db.close();
    expect(cu, "membership row written at first login").toBeTruthy();
    expect(cu.assigned_by).toBe("self_enroll");
    expect(cu.direct_assigned).toBe(1);
    expect(after.c).toBeNull();   // marker cleared

    await dropUserByEmail(email);
    await dropComp(compId);
  });

  // The sibling above proves the membership row is WRITTEN at first login. It
  // never parses the login body, so it cannot see the ordering the server
  // deliberately keeps: _consumePendingSelfEnroll runs BEFORE the rawComps
  // query ("before building the competitions list"). Lose that ordering and
  // the participant IS enrolled in the DB while the very response doLogin()
  // routes off reports zero competitions — so the just-scanned QR does not
  // auto-enter them and they land on a picker instead. Every DB-level
  // assertion still passes, which is exactly why this seam needs its own lock.
  test("PR B / F#8: the just-consumed self-enrollment is LISTED in the same login response the SPA routes off", async () => {
    await ensureState();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = saHdr(csrf);
    const compId = await makeComp(sa, h, `SE-loginlist-${Date.now()}`);
    const rv = await reveal(sa, compId);
    await setFlags(sa, h, compId, { self_enroll_enabled: true });
    await sa.dispose();

    const { api, csrf: rcsrf } = await freshCtx();
    const email = `se-loginlist-${Date.now()}-${Math.floor(Math.random() * 1e6)}@company.co`;
    const nick = `seloginlist${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 28);
    const rr = await registerPost(api, "/api/register", { headers: { "x-csrf-token": rcsrf, "content-type": "application/json" }, data: {
      firstName: "Login", lastName: "List", nickname: nick, email, company: "Co", title: "Eng",
      country: "US", timezone: "America/New_York", jobFunction: "Security Researcher", city: "Tel Aviv",
      joinToken: rv.token, password: PARTICIPANT_PASS,
    } });
    expect(rr.ok(), `register: ${rr.status()} ${await rr.text()}`).toBeTruthy();
    await api.dispose();

    const db0 = new Database(TEST_DB_PATH, { readonly: true });
    const userId = db0.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email).id;
    // Email first: already enrolled — the sign-up's own sign-in consumed the join.
    expect(db0.prepare("SELECT COUNT(*) n FROM competition_users WHERE user_id=? AND competition_id=?").get(userId, compId).n).toBe(1);
    db0.close();

    const { api: li, csrf: lc } = await freshCtx();
    const lr = await codeLogin(li, email, { "x-csrf-token": lc, "content-type": "application/json" });
    expect(lr.ok(), `login: ${lr.status()} ${await lr.text()}`).toBeTruthy();
    const lb = await lr.json();
    await li.dispose();

    // POSITIVE CONTROL — the consume really did run for this login, so a
    // failure below means the ORDERING was lost, not that nothing happened.
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const enrolled = db.prepare("SELECT COUNT(*) n FROM competition_users WHERE user_id=? AND competition_id=?").get(userId, compId).n;
    db.close();
    expect(enrolled, "the deferred enrollment must have been consumed at this login").toBe(1);

    // THE SEAM: doLogin() routes purely off d.competitions.
    expect(Array.isArray(lb.competitions)).toBe(true);
    expect(
      lb.competitions.some(c => c.id === compId),
      "the just-consumed self-enrollment must be listed in the login response the SPA routes off",
    ).toBe(true);
    expect(lb.verified, "the EMAILED code verified the account as it signed in").toBe(true);

    await dropUserByEmail(email);
    await dropComp(compId);
  });



  // ── v7.2.0 — instant-join 48h verification grace ────────────────────────────
  function _readUser(email) {
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const u = db.prepare("SELECT id, verified, self_enroll_grace_until, verify_code, reset_code, password_hash FROM users WHERE LOWER(email)=LOWER(?)").get(email);
    db.close();
    return u;
  }
  // An emailed code verifies the account it signs in, so a grace-state session is
  // built after the sign-in: unverified again, inside a live window.
  function _forceGraceActive(email) {
    const dbw = new Database(TEST_DB_PATH);
    dbw.prepare("UPDATE users SET verified=0, self_enroll_grace_until=? WHERE LOWER(email)=LOWER(?)").run(new Date(Date.now() + 3600_000).toISOString(), email);
    dbw.close();
  }
  function _forceGracePast(email) {
    const dbw = new Database(TEST_DB_PATH);
    dbw.prepare("UPDATE users SET self_enroll_grace_until=? WHERE LOWER(email)=LOWER(?)").run(new Date(Date.now() - 1000).toISOString(), email);
    dbw.close();
  }
  // Register an account through a join link. registerPost rewinds it to the
  // legacy fixture state: unverified, with a live verify_code, and NO grace
  // window. A test that needs a live window calls _forceGraceActive.
  async function makeGraceAccount(label) {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = saHdr(csrf);
    const compId = await makeComp(sa, h, `SE-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const rv = await reveal(sa, compId);
    await setFlags(sa, h, compId, { self_enroll_enabled: true });
    await sa.dispose();
    const { api, csrf: rcsrf } = await freshCtx();
    const email = `se-grace-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@company.co`;
    const nick = `segr${label}${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 28);
    const rr = await registerPost(api, "/api/register", { headers: { "x-csrf-token": rcsrf, "content-type": "application/json" }, data: {
      firstName: "Grace", lastName: "Window", nickname: nick, email, company: "Co", title: "Eng",
      country: "US", timezone: "America/New_York", jobFunction: "Security Researcher", city: "Tel Aviv",
      joinToken: rv.token, password: PARTICIPANT_PASS,
    } });
    expect(rr.ok(), `register: ${rr.status()} ${await rr.text()}`).toBeTruthy();
    const body = await rr.json();
    expect(body.ok, "the registration signed the new account in").toBe(true);
    await api.dispose();
    return { email, nick, compId };
  }









  test("the email verification link verifies a grace account and clears the window", async () => {
    await ensureState();
    const { email, compId } = await makeGraceAccount("verifylink");
    _forceGraceActive(email);
    const before = _readUser(email);
    expect(before.verify_code).toBeTruthy();
    expect(before.verified, "PRECONDITION: unverified, so the link has something to verify").toBe(0);
    expect(before.self_enroll_grace_until, "PRECONDITION: a live grace window to clear").toBeTruthy();
    const { api, csrf } = await freshCtx();
    const vr = await api.post("/verify", { headers: { "x-csrf-token": csrf, "content-type": "application/x-www-form-urlencoded" }, form: { code: before.verify_code } });
    expect([200, 302].includes(vr.status()), `verify: ${vr.status()}`).toBeTruthy();
    const after = _readUser(email);
    expect(after.verified).toBe(1);
    expect(after.self_enroll_grace_until).toBeNull();
    await api.dispose();
    await dropUserByEmail(email);
    await dropComp(compId);
  });

  test("admin force-verify clears the grace window", async () => {
    await ensureState();
    const { email, compId } = await makeGraceAccount("adminverify");
    _forceGraceActive(email);
    const u = _readUser(email);
    expect(u.verified, "PRECONDITION: unverified").toBe(0);
    expect(u.self_enroll_grace_until, "PRECONDITION: a live grace window to clear").toBeTruthy();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const vr = await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saHdr(csrf) });
    expect(vr.ok(), `admin verify: ${vr.status()} ${await vr.text()}`).toBeTruthy();
    await sa.dispose();
    const after = _readUser(email);
    expect(after.verified).toBe(1);
    expect(after.self_enroll_grace_until).toBeNull();
    await dropUserByEmail(email);
    await dropComp(compId);
  });

  test("resend-verification re-mints the verify code for a logged-in grace user; already-verified caller → 400", async () => {
    await ensureState();
    const { email, compId } = await makeGraceAccount("resend");
    const before = _readUser(email);
    // The grace user can log in and resend the verification email.
    const { api, csrf, body } = await apiLogin(email, PARTICIPANT_PASS);
    expect(body.verified, "the emailed code verified it").toBe(true);
    _forceGraceActive(email);
    const rs = await api.post("/api/resend-verification", { headers: { "x-csrf-token": csrf, "content-type": "application/json" } });
    expect(rs.ok(), `resend: ${rs.status()} ${await rs.text()}`).toBeTruthy();
    const after = _readUser(email);
    expect(after.verify_code).toBeTruthy();
    expect(after.verify_code).not.toBe(before.verify_code); // fresh code minted
    expect(after.verified).toBe(0);                          // resend does not verify
    await api.dispose();
    // An already-verified participant gets a 400, not a fresh code.
    const { api: alice, csrf: acsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const rs2 = await alice.post("/api/resend-verification", { headers: { "x-csrf-token": acsrf, "content-type": "application/json" } });
    expect(rs2.status()).toBe(400);
    await alice.dispose();
    await dropUserByEmail(email);
    await dropComp(compId);
  });

  test("requireParticipant admits a grace user, then rejects once the window lapses mid-session", async () => {
    await ensureState();
    const { email, compId } = await makeGraceAccount("midsession");
    const { api } = await apiLogin(email, PARTICIPANT_PASS);
    _forceGraceActive(email);   // signing in with an emailed code verified it; put it back in grace
    // Active grace → /api/me (requireParticipant-gated) works.
    expect((await api.get("/api/me")).status()).toBe(200);
    // Window lapses mid-session → the per-request re-check rejects (no cache bypass).
    _forceGracePast(email);
    expect((await api.get("/api/me")).status()).toBe(403);
    await api.dispose();
    await dropUserByEmail(email);
    await dropComp(compId);
  });

  test("self-enroll works for a LIVE competition (preview + authenticated join)", async () => {
    await ensureState();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = saHdr(csrf);
    // Live = started in the past, long duration still running.
    const start = new Date(Date.now() - 30 * 60_000).toISOString();
    const cr = await sa.post("/api/admin/competitions", { headers: h, data: { name: `SE-live-${Date.now()}`, start_time: start, duration_minutes: 240 } });
    expect(cr.ok(), `create live comp: ${cr.status()} ${await cr.text()}`).toBeTruthy();
    const compId = (await cr.json()).competition.id;
    const rv = await reveal(sa, compId);
    await setFlags(sa, h, compId, { self_enroll_enabled: true });
    await sa.dispose();
    // Preview reports the competition as live and 200s.
    const { api } = await freshCtx();
    const pr = await api.get(`/api/competitions/self-enroll/${rv.token}`);
    expect(pr.status()).toBe(200);
    expect((await pr.json()).status).toBe("live");
    await api.dispose();
    // Authenticated join succeeds on the live comp.
    const { api: pa, csrf: pcsrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    const j = await pa.post("/api/competitions/join", { headers: { "x-csrf-token": pcsrf, "content-type": "application/json" }, data: { token: rv.token } });
    expect(j.ok(), `join live: ${j.status()} ${await j.text()}`).toBeTruthy();
    expect((await j.json()).competitionId).toBe(compId);
    await pa.dispose();
    // Cleanup: a live comp can't be deleted directly — end it first, then drop.
    const { api: sa2, csrf: c2 } = await apiLogin("superadmin");
    await sa2.post(`/api/admin/competitions/${compId}/end-now`, { headers: { "x-csrf-token": c2 } }).catch(() => {});
    await sa2.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": c2 } }).catch(() => {});
    await sa2.dispose();
  });
});


test.describe("audit v7.7.36 (batch 11) — perf + concurrency LOWs", () => {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..");
  const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

  test("C3: decodeCxOneApiKey derives the AST base_url for region-prefixed IAM hosts (not just iam.checkmarx.net)", () => {
    // Pure decoder (no signature verification — it just base64url-decodes the JWT
    // payload for the iss claim), so we can execute it directly with a crafted key.
    const { decodeCxOneApiKey } = require("../lib/cxone");
    const mk = (iss) => "h." + Buffer.from(JSON.stringify({ iss })).toString("base64url") + ".s";
    // US host — unaffected by the bug (had "://iam." so the old replace worked).
    expect(decodeCxOneApiKey(mk("https://iam.checkmarx.net/auth/realms/t")).baseUrl).toBe("https://ast.checkmarx.net");
    // EU / region-prefixed host — pre-fix stayed on the IAM (identity) host because
    // "://iam." doesn't occur in "://eu.iam.". Now the `iam` LABEL is swapped.
    expect(decodeCxOneApiKey(mk("https://eu.iam.checkmarx.net/auth/realms/t")).baseUrl).toBe("https://eu.ast.checkmarx.net");
    expect(decodeCxOneApiKey(mk("https://deu.iam.checkmarx.com/auth/realms/x")).baseUrl).toBe("https://deu.ast.checkmarx.com");
    // tenant + iamUrl still resolve correctly.
    const d = decodeCxOneApiKey(mk("https://eu.iam.checkmarx.net/auth/realms/acme"));
    expect(d.tenant).toBe("acme");
    expect(d.iamUrl).toBe("https://eu.iam.checkmarx.net");
  });

  test("C5: the event-history pagination tie-key is the row's ROWID (monotonic), not the random UUID id", () => {
    // The UUID `id` is non-monotonic, so a same-ms insert after the anchor could
    // sort <= the tie and slip into the snapshot mid-walk. rowid is insertion-
    // ordered. Lock the SQL + filter so a revert to `id` fails here.
    const audit = read("lib/audit.js");
    expect(audit).toMatch(/changed_at = \? AND rowid <= \?/);   // the tie compares rowid
    expect(audit).not.toMatch(/changed_at = \? AND id <= \?/);  // never the UUID id
    for (const f of ["routes/events.js", "routes/settings.js"]) {
      const src = read(f);
      expect(src, `${f} maxSql selects rowid as tie`).toMatch(/rowid as tie/);
      expect(src, `${f} must not order by id`).not.toMatch(/ORDER BY changed_at DESC, id DESC/);
    }
  });

  test("C1/C6/C7/C8: every new leaderboard-cache writer invalidates by comp id (writer-lock invariant)", () => {
    // These four paths change leaderboard-relevant state (delete cascade, import
    // tag/verified flips, verify 0→1, task publish). Lock that each busts the
    // board so a future refactor can't silently drop the invalidation.
    // C1 — deleteUserCascade captures + invalidates the user's comps.
    expect(read("lib/account-reaper.js")).toMatch(/invalidateLeaderboardCache/);
    // C7 — POST /verify + reset-password becameVerified branch.
    const auth = read("routes/auth.js");
    expect(auth.match(/invalidateLeaderboardCache\(r\.competition_id\)/g) || []).not.toHaveLength(0);
    // C8 — task publish fans out over competition_tasks.
    expect(read("routes/challenges.js")).toMatch(/SELECT DISTINCT competition_id FROM competition_tasks WHERE task_id=\?[\s\S]{0,120}invalidateLeaderboardCache/);
    // C7 admin force-verify + C6 import both live behind their guards; assert the
    // import unions existing memberships before the invalidation loop.
    expect(read("server.js")).toMatch(/competition_users WHERE user_id IN[\s\S]{0,200}_touchedCompIds\.add/);
  });

  test("P2: bulk-invite reconciles each touched group ONCE after the loop, not per existing-user email", () => {
    const inv = read("routes/invitations.js");
    // The per-email reconcile call is gone; a single deferred loop over the
    // accumulated touched-group set remains.
    expect(inv).toMatch(/_touchedGroupIds\.add\(gid\)/);
    expect(inv).toMatch(/for \(const gid of _touchedGroupIds\) await reconcileGroupBoundCompetitions/);
    expect(inv, "no per-email reconcile over validGroupIds").not.toMatch(/for \(const gid of validGroupIds\) await reconcileGroupBoundCompetitions/);
  });

  test("P4/P5/P6/P8: the SPA poll/listener leaks are plugged", () => {
    // P4 — leaving a live comp for the picker stops the status + lb polls.
    expect(read("public/js/features/competition-picker.js")).toMatch(/showCompetitionsPage[\s\S]{0,1400}S\.statusPollInterval[\s\S]{0,300}S\.lbInterval/);
    // P5 — participant-view toggle clears the admin-only intervals.
    //
    // v7.15.31: the original assertion here was
    //   /S\.scopeBannerInterval[\s\S]{0,200}S\.adminCompPollInterval/
    // which only required the two identifiers to appear near each other —
    // verified vacuous by deleting all three clearInterval() calls, which left
    // this test GREEN. It now names the teardown itself, and the real guard is
    // behavioural: `admin-view-toggle.spec.js > "switching to Participant View
    // stops every admin-only background loop"` starts all three loops for real
    // and asserts they are stopped (that one does fail on the same mutant).
    for (const k of ["scopeBannerInterval", "adminCompPollInterval"]) {
      expect(read("public/js/ui/nav.js"),
        `toggleAdminView must clearInterval(S.${k}) on the way down to participant view`
      ).toContain(`clearInterval(S.${k})`);
    }
    // P6 — leaderboard poll ticks are silent (no spinner).
    expect(read("public/js/features/leaderboard.js")).toMatch(/loadLeaderboard\(\{silent:true\}\)/);
    // P8 — the sidebar's Escape handling cannot leak a listener.
    //
    // RE-POINTED in v8.11.7, and its subject is unchanged: `initAdminSidebar()`
    // runs on every admin entry, so whatever handles Escape for the drawer must
    // be registered ONCE. The old mechanism was a `document._sidebarEscWired`
    // one-shot flag around a document-level keydown listener; that listener is
    // DELETED, because being outside the shared LIFO stack meant one Escape
    // closed a modal AND the drawer underneath it on the same event.
    //
    // The drawer now pushes `_closeAdminSidebarMobile` onto `window._modalEscStack`
    // at open and pops it at close, so this asserts the stronger property: the
    // push is guarded against duplicating, there IS a matching pop, and no private
    // document-level Escape listener has come back.
    const navSrc = read("public/js/ui/nav.js");
    expect(navSrc, "the drawer must JOIN the shared Escape stack, not listen privately")
      .toMatch(/_modalEscStack[\s\S]{0,120}includes\(_closeAdminSidebarMobile\)/);
    expect(navSrc, "…and it must pop itself, or the stack grows one entry per open")
      .toMatch(/_modalEscStack[\s\S]{0,160}indexOf\(_closeAdminSidebarMobile\)/);
    expect(navSrc, "the private document-level Escape listener must not come back")
      .not.toMatch(/document\._sidebarEscWired/);
  });
});


test.describe("audit v7.7.37 (batch 12) — correctness LOWs", () => {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..");
  const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

  test("C1: __assetUrlWithVersion appends ?v= correctly to a URL that ALREADY has a query", async ({ request }) => {
    // Fetch the emitted helper and execute it against a synthetic window so we test
    // the ACTUAL shipped code (not a re-implementation). Pre-fix a query'd URL got
    // "path&v=hash&x=1" (no "?") and 404'd.
    const body = await (await request.get(require("./helpers").BASE + "/asset-versions.js")).text();
    const win = {};
    // eslint-disable-next-line no-new-func
    new Function("window", body)(win);
    win.__assetHashes = { "/a.png": "abc123", "/b.css": "def456" };
    expect(win.__assetUrlWithVersion("/a.png")).toBe("/a.png?v=abc123");
    expect(win.__assetUrlWithVersion("/a.png?x=1")).toBe("/a.png?v=abc123&x=1");
    expect(win.__assetUrlWithVersion("/b.css?x=1&y=2")).toBe("/b.css?v=def456&x=1&y=2");
    expect(win.__assetUrlWithVersion("/a.png#frag")).toBe("/a.png?v=abc123#frag");
    expect(win.__assetUrlWithVersion("/unknown.png?x=1")).toBe("/unknown.png?x=1"); // no hash → unchanged
  });

  test("C16: Kazakhstan + Paraguay tz labels show the current UTC offsets", () => {
    const ctz = read("public/js/data/country-tz.js");
    expect(ctz).toMatch(/Astana \/ Almaty \(UTC\+5\)/);
    expect(ctz).not.toMatch(/Astana \/ Almaty \(UTC\+6\)/);
    expect(ctz).toMatch(/Asuncion \(UTC-3\)/);
    expect(ctz).not.toMatch(/Asuncion \(UTC-4\)/);
  });

  test("source-locks: every batch-12 fix is present (guards reverts)", () => {
    // C2 — import within-batch nickname dedup.
    expect(read("server.js")).toMatch(/seenNicks/);
    // C3 — byte-buffer reverse reader (no per-chunk toString).
    const srv = read("server.js");
    expect(srv).toMatch(/pending\.lastIndexOf\(0x0A\)/);
    expect(srv).not.toMatch(/tail\s*=\s*buf\.toString\("utf8"\)\s*\+\s*tail/);
    // C4 — assign revive gated on a real new membership.
    expect(read("routes/participants.js")).toMatch(/if \(!affectedCompIds\.has\(comp\.id\)\) continue;/);
    // C5 — email-swap validates the immediately-active pair too.
    expect(read("routes/participant.js")).toMatch(/emailChanged && sameSlotEmails\(user\.email, newSecondary\)/);
    // C6 — remove-from-comp gates the email on a real deletion.
    expect(read("routes/participants.js")).toMatch(/if \(!didRemove\) return res\.json\(\{ ok: true, removed: false \}\)/);
    // C7 — timeslot-create purges stale comp-level reminders.
    expect(read("routes/sessions.js")).toMatch(/DELETE FROM email_reminders WHERE competition_id=\? AND \(timeslot_id IS NULL OR timeslot_id=''\) AND sent=0/);
    // C8 — author fields use CASE (clearable), not COALESCE.
    expect(read("routes/challenges.js")).toMatch(/author_name=CASE WHEN \?=1 THEN \? ELSE author_name END/);
    // C9 — batch_sent tolerates a missing competitionIds.
    expect(read("routes/invitations.js")).toMatch(/Array\.isArray\(competitionIds\) \? competitionIds\.length : 0/);
    // C10 — invited secondary re-checked inside the txn.
    expect(read("routes/auth.js")).toMatch(/secondaryEmail && emailIsTaken\(secondaryEmail\)\) \{ nicknameOrEmailTaken = true; throw new Error\("secondary_taken"\)/);
    // C11 — time-expired revive re-arms the scheduler observation (comp + timeslot).
    expect(read("routes/competitions.js")).toMatch(/oldStatus === "ended" && !comp\.ended_at[\s\S]{0,700}_resyncStatusObservationAfterRevive/);
    expect(read("routes/sessions.js")).toMatch(/newEnd > now\(\) && !updated\.ended_at[\s\S]{0,700}_resyncStatusObservationAfterRevive/);
    // C12 — task-number counters seeded by level prefix.
    expect(read("lib/competitions.js")).toMatch(/const counters = \{ 1: 0, 2: 0, 3: 0 \}/);
    expect(read("lib/competitions.js")).toMatch(/const level = diffLevel\[t\.difficulty\]/);
    // C13 — purge.sh sets a busy timeout (beside the pinned output format).
    expect(read("scripts/purge.sh")).toMatch(/sqlite3 -init \/dev\/null -batch -noheader -list -cmd "\.timeout 30000"/);
    // C14 — hint_reveals rebuild is transactional + self-healing.
    expect(read("db.js")).toMatch(/db\.transaction\(\(\) => \{[\s\S]{0,120}DROP TABLE IF EXISTS hint_reveals_v2/);
    // C15 — updated_at / first_verified_at backfills run OUTSIDE the column guard,
    // but password_set_at stays guarded (unconditional would mis-stamp it).
    const dbjs = read("db.js");
    expect(dbjs).toMatch(/if \(!compCols2\.includes\("updated_at"\)\) db\.exec\("ALTER TABLE competitions ADD COLUMN updated_at TEXT"\);\s*\n\s*db\.exec\("UPDATE competitions SET updated_at/);
    expect(dbjs).toMatch(/if \(!uCols\.includes\("password_set_at"\)\) \{[\s\S]{0,200}UPDATE users SET password_set_at/); // still guarded
    // C17 — profile-gate Save wraps the PUT in try/catch.
    expect(read("public/js/features/auth.js")).toMatch(/try\{[\s\S]{0,200}fetch\('\/api\/me',\{method:'PUT'[\s\S]{0,200}\}catch\(_\)\{[\s\S]{0,120}_btn\.disabled=false/);
    // C18 — pending countdown re-reads the chosen slot each tick.
    expect(read("public/js/features/competition-picker.js")).toMatch(/const liveTs=S\._currentChosenTimeslot\|\|null;/);
    // C19 — invite error parse takes the email prefix.
    expect(read("public/js/features/participants-admin.js")).toMatch(/if\(prefix\.includes\('@'\)\)return prefix\.toLowerCase\(\);/);
    // C20 — invite-for-comp routes through a canonical nav control: since the
    // event workspace it is the workspace's own Participants section tab (the
    // sidebar's People item would close the workspace), clicked, never a
    // hand-rolled pane switch.
    expect(read("public/js/features/participants-admin.js")).toMatch(/querySelector\('#ws-tabs \[data-section="admin-participants-tab"\]'\)\?\.click\(\)/);
    expect(read("public/js/features/participants-admin.js")).not.toMatch(/querySelectorAll\('\.tab'\)\.forEach/); // the removed pre-sidebar code (not the comment)
    // C21 — scope-banner status hoisted so the ts-focused End Now can render.
    expect(read("public/js/features/competitions-admin.js")).toMatch(/if\(comp&&timeslots\.length>0\)\{[\s\S]{0,400}currentStatus='live'/);
    // C22 — invited registration re-validates the forced primary email format.
    expect(read("routes/auth.js")).toMatch(/!isValidEmailFormat\(primaryEmail\)/);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// audit v7.7.27 batch 2 — instant-join grace participants are first-class
//   M8: a grace-active (verified=0, self_enroll_grace_until in the future)
//       participant who has engaged appears on the leaderboard.
//   M2: the all-solved auto-end scan COUNTS grace participants — a comp must NOT
//       auto-end while a grace player is still mid-challenge, and DOES end once
//       they too have solved everything (proving they're counted, not ignored).
// Product decision (operator): grace users legitimately compete → board-visible
// and auto-end-countable. The shared ACTIVE_PARTICIPANT_SQL predicate backs all
// five sites (leaderboard ×2, auto-end scan, both revive re-checks).
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("audit v7.7.27 batch 2 — grace participants count on the board + auto-end", () => {
  test("a grace participant is on the leaderboard AND holds the comp open until they solve too", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
    const now = Date.now();

    // Live single-slot comp with exactly ONE published task.
    let r = await sa.post("/api/admin/competitions", { headers: h, data: {
      name: `B2 ${stamp}`, start_time: new Date(now - 20 * 60_000).toISOString(), duration_minutes: 180,
    }});
    const compId = (await r.json()).competition.id;
    r = await sa.post("/api/admin/tasks", { headers: h, data: {
      title: `B2 Task ${stamp}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "text", correct_answer: "sol", explanation: "<p>e</p>", status: "published",
    }});
    const taskId = (await r.json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: h, data: { competitionIds: [compId] } });

    // Helper: register → approve → set a known password (this sets verified=1).
    async function mkUser(tag) {
      const email = `b2_${tag}_${stamp}@acme.com`;
      const { api: anon, csrf: ac } = await freshCtx();
      await registerPost(anon, "/api/register", { headers: { "x-csrf-token": ac, "content-type": "application/json" }, data: {
        firstName: "B2", lastName: tag, nickname: `b2_${tag}_${stamp}`, email,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "NYC",
      }});
      await anon.dispose();
      const me = (await (await sa.get("/api/admin/participants?limit=3000")).json()).participants.find(p => p.email === email);
      await sa.post(`/api/admin/participants/${me.id}/verify`, { headers: h });   // approval requires verified first
      await sa.post(`/api/admin/participants/${me.id}/approve`, { headers: h });
      await sa.post("/api/admin/competitions/assign", { headers: h, data: { userIds: [me.id], competitionIds: [compId] } });
      return { id: me.id, email };
    }
    const V = await mkUser("v");  // stays verified
    const G = await mkUser("g");  // will be flipped to grace-active

    // Flip G into the grace state: verified=0, grace deadline 24h out. (A desk
    // code sets this when it signs in an unverified account; it is synthesised
    // directly here so the test depends on nothing else.)
    {
      const Database = require("better-sqlite3");
      const dbW = new Database(TEST_DB_PATH);
      try {
        dbW.prepare("UPDATE users SET verified=0, self_enroll_grace_until=? WHERE id=?")
          .run(new Date(now + 24 * 3600_000).toISOString(), G.id);
      } finally { dbW.close(); }
    }

    // G (grace) logs in — grace admits an unverified account — engages with a WRONG answer.
    const { api: gApi, csrf: gc } = await apiLogin(G.email, PARTICIPANT_PASS);
    const gh = { "x-csrf-token": gc, "content-type": "application/json" };
    r = await gApi.post("/api/select-competition", { headers: gh, data: { competitionId: compId } });
    expect(r.ok(), `grace user can select comp: ${await r.text()}`).toBeTruthy();
    r = await gApi.post(`/api/tasks/${taskId}/submit`, { headers: gh, data: { answer: "WRONG" , gradingHash: await gradingHashFor(gApi, taskId)} });
    expect(r.ok()).toBeTruthy();

    // M8: G appears on the admin leaderboard (was excluded pre-fix by verified=1).
    let board = await (await sa.get(`/api/admin/leaderboard?competitionId=${compId}`)).json();
    expect(board.some(e => e.userId === G.id), "grace participant must be on the leaderboard").toBe(true);

    // V solves the ONLY task → V has solved everything → auto-end scan runs.
    const { api: vApi, csrf: vc } = await apiLogin(V.email, PARTICIPANT_PASS);
    const vh = { "x-csrf-token": vc, "content-type": "application/json" };
    await vApi.post("/api/select-competition", { headers: vh, data: { competitionId: compId } });
    r = await vApi.post(`/api/tasks/${taskId}/submit`, { headers: vh, data: { answer: "sol" , gradingHash: await gradingHashFor(vApi, taskId)} });
    expect(r.ok()).toBeTruthy();

    // M2: comp must STILL be live — G (counted) hasn't solved the task yet.
    let comp = (await (await sa.get("/api/admin/competitions")).json()).find(c => c.id === compId);
    expect(comp.status, "comp must NOT auto-end while a grace player is unfinished").toBe("live");
    expect(comp.ended_at == null, "ended_at must be null while grace player unfinished").toBe(true);

    // Now G solves it too → EVERY counted participant has solved all → auto-end fires.
    r = await gApi.post(`/api/tasks/${taskId}/submit`, { headers: gh, data: { answer: "sol" , gradingHash: await gradingHashFor(gApi, taskId)} });
    expect(r.ok()).toBeTruthy();
    comp = (await (await sa.get("/api/admin/competitions")).json()).find(c => c.id === compId);
    expect(comp.status, "comp must auto-end once the grace player has also solved everything").toBe("ended");

    await gApi.dispose(); await vApi.dispose(); await sa.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// audit v7.7.31 batch 6 — picker cap + register-required drift
//   M27: non-members are capped by ?limit INDEPENDENTLY of the member count, so
//        a competition with ≥limit members still surfaces candidates (pre-fix
//        `limit - members` returned zero — breaking candidate search entirely).
//   M26: POST /api/register mandates company + title (now in the swagger
//        required list too); missing either is a 400 even in test mode.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("audit v7.7.31 batch 6 — picker cap + register required", () => {
  test("M27: picker returns non-member candidates even when members ≥ limit", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const s = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    // Fresh comp; assign TWO members to it.
    const compId = (await (await api.post("/api/admin/competitions", { headers: H, data: {
      name: `M27 ${s}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60,
    }})).json()).competition.id;
    const ids = [];
    for (let n = 0; n < 2; n++) {
      const email = `m27_${s}_${n}@acme.com`;
      const { api: anon, csrf: ac } = await freshCtx();
      await registerPost(anon, "/api/register", { headers: { "x-csrf-token": ac, "content-type": "application/json" }, data: {
        firstName: "M27", lastName: `U${n}`, nickname: `m27_${s}_${n}`, email,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "NYC",
      }});
      await anon.dispose();
      const me = (await (await api.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
      await api.post(`/api/admin/participants/${me.id}/verify`, { headers: H });
      await api.post(`/api/admin/participants/${me.id}/approve`, { headers: H });
      ids.push(me.id);
    }
    await api.post("/api/admin/competitions/assign", { headers: H, data: { userIds: ids, competitionIds: [compId] } });
    // limit=1 with 2 members: pre-fix nonMemberSlots = max(0, 1-2) = 0 → zero
    // candidates. Post-fix nonMemberSlots = 1 → the pool (alice/bob/… are not in
    // THIS comp) yields at least one non-member.
    const data = await (await api.get(`/api/admin/participants/picker?competitionId=${compId}&limit=1`)).json();
    const members = data.users.filter(u => u.in_competition === 1);
    const nonMembers = data.users.filter(u => u.in_competition !== 1);
    expect(members.length, "both members returned in full").toBe(2);
    expect(nonMembers.length, "non-member candidates must still be returned despite members ≥ limit").toBeGreaterThanOrEqual(1);
    await api.dispose();
  });

  test("M26: register rejects a body missing company (mandatory, per the swagger required list)", async () => {
    const { api, csrf } = await freshCtx();
    const s = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    const base = {
      firstName: "No", lastName: "Company", nickname: `nocomp_${s}`, email: `nocomp_${s}@acme.com`,
      title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC",
    };
    const r = await registerPost(api, "/api/register", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: base });
    expect(r.status(), "missing company must 400 (not test-defaulted)").toBe(400);
    await api.dispose();
  });
});
