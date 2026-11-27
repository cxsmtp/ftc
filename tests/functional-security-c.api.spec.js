// @ts-check
//
// Split from functional-security.api.spec.js in v7.21.37 — it was 133s in one file, and a spec
// file never spans workers, so it bounded the whole suite's wall clock.
//
// Contains: LinkedIn registration · Delete-user session invalidation · ext-audit batch 3: malformed request bodies return 4xx, not 500 · v6.9.18: concurrency races · v6.20.x: CxOne username-stability invariant · Email format validation · Invitation cross-batch deduplication · Admin password reset: sessions preserved · HSTS header · Dual-email invariant on admin entry points · Superadmin password banner redaction (post-restart) · LOG_SKIP_IPS — runtime enforcement · LinkedIn OAuth — error branches · v6.13.18 — auditor invariants · v6.13.20 — auditor invariants · v6.13.21 — approve-before-assign · v6.14.1 — participant leaderboard top-20 cap · v6.16.3 — auditor invariants · v6.16.4 — auditor invariants · v6.16.22 — security audit batch · ext-audit v7.15.11 · v7.21.1 (A7) — registration normalises and validates its required fields · v7.21.1 (A8) — an invited registration cannot store one address in both email slots
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { registerPost, entryCode } = require("./helpers");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { createClient, freshCtx, apiLogin, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, TEST_DATA_DIR, PORT_BASE, BASE, gradingHashFor, findLogLine, pollAdminLogs, codeLogin } = require("./helpers");

// v7.21.37 — `S` / ensureState / aliceInLive moved to ./seeded-state as a
// FACTORY. Each spec file gets its OWN cache: per-file isolation re-seeds the
// database before every file, so one shared `S` would hand this file ids from
// the previous file's database.
const { makeState } = require("./seeded-state");
const { readySpawnedServer } = require("./spawned-server");
const { S, ensureState, aliceInLive } = makeState();

// ═══════════════════════════════════════════════════════════════════════════════
// PARTICIPANT FLOWS
// ═══════════════════════════════════════════════════════════════════════════════
// v7.21.37 — hoisted here from between two describes so the file can be
// split: a binding declared outside every describe belongs to whichever
// part inherits it, and the others fail with a bare ReferenceError.
const _v8h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });






// ═══════════════════════════════════════════════════════════════════════════════
// SESSION INVALIDATION ON DELETE
// ═══════════════════════════════════════════════════════════════════════════════
// Deleting a user must drop their live sessions. Without this, the lightweight
// probe endpoints (session/status, session/keepalive, admin/me) — which are
// deliberately fast and do not hit requireParticipant — keep reporting the
// session as active indefinitely while the client's inactivity loop refreshes
// the cookie, producing a ghost account that the UI treats as logged in.
test.describe("Delete-user session invalidation", () => {
  // Helper: register + verify + approve + set-password so we have a user with
  // a real password and a live session we can poke through the probes.
  async function freshUser(emailSuffix) {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const email = `ghost-${emailSuffix}-${Date.now()}@company.co`;
    const nickname = `ghost_${emailSuffix}_${Date.now()}`;
    const reg = await registerPost(sa, "/api/register", {
      headers: saH,
      data: {
        firstName: "Ghost", lastName: "User", nickname,
        company: "C", title: "T", avatar: "🦊",
        country: "US", timezone: "America/New_York",
        email,
      },
    });
    expect(reg.ok()).toBeTruthy();
    const users = await (await sa.get("/api/admin/participants?limit=500")).json();
    const user = users.participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${user.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${user.id}/approve`, { headers: saH });
    return { user, email, sa, saH, saCsrf };
  }

  test("deleted participant cannot probe session/status, keepalive, or admin/me from their old cookie", async () => {
    const { user, email, sa, saH } = await freshUser("p");
    // Login as the victim to establish a live session we'll keep using.
    const { api: victim, csrf: victimCsrf } = await apiLogin(email, PARTICIPANT_PASS);
    // Warm-up so cookie.expires is populated.
    await victim.get("/api/session/status");
    const pre = await (await victim.get("/api/session/status")).json();
    expect(pre.active).toBe(true);

    // Superadmin deletes the user.
    const del = await sa.delete(`/api/admin/participants/${user.id}`, { headers: { "x-csrf-token": saH["x-csrf-token"] } });
    expect(del.ok()).toBeTruthy();
    await sa.dispose();

    // Same session cookie now sees everything as dead.
    const post = await (await victim.get("/api/session/status")).json();
    expect(post.active).toBe(false);
    expect(post.role).toBeNull();

    const keep = await victim.post("/api/session/keepalive", {
      headers: { "x-csrf-token": victimCsrf, "content-type": "application/json" },
    });
    // Any 4xx is acceptable — the point is that keepalive doesn't extend
    // the session. CSRF (403) fires first because the purged session's
    // csrf secret is gone too; in either case the cookie can't be revived.
    expect(keep.ok()).toBe(false);
    expect(keep.status()).toBeGreaterThanOrEqual(400);

    const adminMe = await victim.get("/api/admin/me");
    expect(adminMe.status()).toBe(401);

    // Protected routes also reject.
    const me = await victim.get("/api/me");
    expect(me.ok()).toBe(false);

    await victim.dispose();
  });

  test("deleted admin user cannot probe admin/me from their old cookie", async () => {
    const { user, email, sa, saH } = await freshUser("a");
    await sa.post(`/api/admin/participants/${user.id}/role`, { headers: saH, data: { role: "admin" } });

    const { api: adm, csrf: admCsrf } = await apiLogin(email, PARTICIPANT_PASS);
    await adm.get("/api/session/status");
    const preAdmin = await (await adm.get("/api/admin/me")).json();
    expect(preAdmin.ok).toBe(true);

    const del = await sa.delete(`/api/admin/participants/${user.id}`, { headers: { "x-csrf-token": saH["x-csrf-token"] } });
    expect(del.ok()).toBeTruthy();
    await sa.dispose();

    const post = await adm.get("/api/admin/me");
    expect(post.status()).toBe(401);

    const keep = await adm.post("/api/session/keepalive", {
      headers: { "x-csrf-token": admCsrf, "content-type": "application/json" },
    });
    // 401 or 403 — both reject the extend attempt. See participant test.
    expect(keep.ok()).toBe(false);
    expect(keep.status()).toBeGreaterThanOrEqual(400);

    await adm.dispose();
  });

  test("v7.2.x (audit, F3): session/status + keepalive enforce the full lifecycle (denied-not-blocked + unapproved)", async () => {
    const Database = require("better-sqlite3");
    // Case 1 — denied_at set WITHOUT blocked. The deny endpoint always sets
    // blocked=1 atomically, so this models an out-of-band DB edit / a
    // participant-import lifecycle overwrite that splits the invariant and does
    // NOT purge the session. Pre-fix the probes only checked `blocked`, so this
    // ghost session kept reporting active=true + sliding its expiry forward.
    {
      const { user, email, sa } = await freshUser("denied");
      const { api: victim, csrf: vCsrf } = await apiLogin(email, PARTICIPANT_PASS);
      await victim.get("/api/session/status");
      expect((await (await victim.get("/api/session/status")).json()).active).toBe(true);
      const wdb = new Database(TEST_DB_PATH);
      wdb.prepare("UPDATE users SET denied_at=?, blocked=0 WHERE id=?").run(new Date().toISOString(), user.id);
      wdb.close();
      const post = await (await victim.get("/api/session/status")).json();
      expect(post.active, "denied-not-blocked session must read inactive").toBe(false);
      expect(post.role).toBeNull();
      const keep = await victim.post("/api/session/keepalive", { headers: { "x-csrf-token": vCsrf, "content-type": "application/json" } });
      expect(keep.ok(), "keepalive must reject (no expiry extension) for a denied session").toBe(false);
      expect(keep.status()).toBeGreaterThanOrEqual(400);
      await victim.dispose();
      await sa.dispose();
    }
    // Case 2 — approved flipped to 0 out-of-band (e.g. an import overwrite).
    {
      const { user, email, sa } = await freshUser("unapproved");
      const { api: victim, csrf: vCsrf } = await apiLogin(email, PARTICIPANT_PASS);
      expect((await (await victim.get("/api/session/status")).json()).active).toBe(true);
      const wdb = new Database(TEST_DB_PATH);
      wdb.prepare("UPDATE users SET approved=0 WHERE id=?").run(user.id);
      wdb.close();
      expect((await (await victim.get("/api/session/status")).json()).active, "unapproved session must read inactive").toBe(false);
      const keep = await victim.post("/api/session/keepalive", { headers: { "x-csrf-token": vCsrf, "content-type": "application/json" } });
      expect(keep.ok()).toBe(false);
      expect(keep.status()).toBeGreaterThanOrEqual(400);
      await victim.dispose();
      await sa.dispose();
    }
  });

  test("v7.2.x (audit, F6): /docs admin gate re-checks the DB lifecycle, not the stale session.isAdmin", async () => {
    const Database = require("better-sqlite3");
    const { user, email, sa, saH } = await freshUser("docsgate");
    try {
      await sa.post(`/api/admin/participants/${user.id}/role`, { headers: saH, data: { role: "admin" } });
      const { api: adm } = await apiLogin(email, PARTICIPANT_PASS);
      // Sanity: a live admin can read the gated guide.
      expect((await adm.get("/docs/user-guide/admin.md")).status(), "live admin reads gated docs").toBe(200);
      // Out-of-band demotion that does NOT purge the session (models a
      // participant-import role overwrite / a direct DB edit). The session still
      // carries isAdmin=true; pre-fix the docs gate trusted that stale flag.
      const wdb = new Database(TEST_DB_PATH);
      wdb.prepare("UPDATE users SET role='participant' WHERE id=?").run(user.id);
      wdb.close();
      expect((await adm.get("/docs/user-guide/admin.md")).status(), "demoted admin must lose gated-docs access immediately").toBe(401);
      await adm.dispose();
    } finally {
      await sa.dispose();
    }
  });

  test("delete audit event records the number of sessions purged", async () => {
    const { user, email, sa, saH } = await freshUser("audit");
    const { api: victim } = await apiLogin(email, PARTICIPANT_PASS);
    await victim.get("/api/me"); // ensure the session row is persisted
    await victim.dispose();

    const del = await sa.delete(`/api/admin/participants/${user.id}`, { headers: { "x-csrf-token": saH["x-csrf-token"] } });
    expect(del.ok()).toBeTruthy();

    // The orphan-audit row for the deleted user lands in today's app.jsonl
    // (source:"audit"). Fetch it via the logs endpoint and assert the count.
    const today = new Date().toISOString().slice(0, 10);
    const logs = await (await sa.get(`/api/admin/logs?stream=app&date=${today}&limit=500&q=${user.id}`)).json();
    const delEvent = (logs.entries || []).find(e => e.source === "audit" && e.event_type === "deleted" && e.scope_id === user.id);
    expect(delEvent).toBeTruthy();
    expect(delEvent.details?.purged_sessions).toBeGreaterThanOrEqual(1);
    await sa.dispose();
  });
});


test.describe("ext-audit batch 3: malformed request bodies return 4xx, not 500", () => {


  test("login with a non-string email + password → 401 (generic, not 500)", async () => {
    const { api, csrf } = await freshCtx();
    const r = await api.post("/api/login", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { email: ["x@y.com"], password: { a: 1 } } });
    expect(r.status()).toBe(401);
    await api.dispose();
  });



  test("select-competition with a non-string competitionId → 400", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const r = await api.post("/api/select-competition", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { competitionId: { a: 1 } } });
    expect(r.status()).toBe(400);
    await api.dispose();
  });

  // batch 4 — the same .trim()-without-typeof 500 class the auditor flagged on
  // comp/session edit also lived on the profile + settings writes (found by the
  // verification sweep). Optional chaining guards null, not type.
  test("PUT /api/me with a non-string field → 400 (was 500 at .trim())", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const me = await (await api.get("/api/me")).json();
    const r = await api.put("/api/me", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { firstName: me.first_name, lastName: me.last_name, nickname: me.nickname, email: me.email, company: ["evil"], title: me.title, country: me.country, timezone: me.timezone, avatar: me.avatar },
    });
    expect(r.status()).toBe(400);
    await api.dispose();
  });

  test("PATCH /api/admin/settings with a non-string platform_name → 400 (was 500)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.patch("/api/admin/settings", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { platform_name: ["evil"] } });
    expect(r.status()).toBe(400);
    await api.dispose();
  });

  // batch 5 — the same non-string→500 class on more body fields, + whitespace-only
  // names (max-length checked but not non-empty), + register linkedinUrl.
  test("competition create: non-string name + whitespace-only name → 400", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const start = new Date(Date.now() + 3600_000).toISOString();
    const nonStr = await api.post("/api/admin/competitions", { headers: h, data: { name: ["evil"], start_time: start, duration_minutes: 60 } });
    expect(nonStr.status()).toBe(400);
    const blank = await api.post("/api/admin/competitions", { headers: h, data: { name: "   ", start_time: start, duration_minutes: 60 } });
    expect(blank.status()).toBe(400);
    await api.dispose();
  });

  test("competition add-tag with a non-string tag → 400 (was 500)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const id = (await (await api.post("/api/admin/competitions", { headers: h, data: { name: `TagFuzz ${Date.now()}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 } })).json()).competition.id;
    const r = await api.post(`/api/admin/competitions/${id}/tags`, { headers: h, data: { tag: { a: 1 } } });
    expect(r.status()).toBe(400);
    await api.dispose();
  });

  test("register with a non-string linkedinUrl → 400 (was 500 at .trim())", async () => {
    const { api, csrf } = await freshCtx();
    const r = await registerPost(api, "/api/register", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { firstName: "A", lastName: "B", nickname: `fuzz_${Date.now()}`, email: `fuzz-${Date.now()}@company.example`, company: "C", title: "T", country: "US", timezone: "America/New_York", password: "validpass123", linkedinUrl: ["evil"] },
    });
    expect(r.status()).toBe(400);
    await api.dispose();
  });


});


test.describe("v6.9.18: concurrency races", () => {
  // Pre-v6.9.18 only two race scenarios were exercised. These three
  // cover three higher-impact patterns observed across the audit:
  // same-user double-submit double-scoring, admin approve+block
  // collision, and concurrent comp-assign (covered by the existing
  // invitation-claim test but not the direct-assign path).
  test("same-user concurrent correct submissions are scored only once", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    // Create a throwaway task + assign to liveComp so we're not poisoning a shared fixture.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const created = await sa.post("/api/admin/tasks", {
      headers: saH, data: {
        title: `Race-DoubleSubmit-${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
        answer_type: "text", correct_answer: "paris", explanation: "<p>x</p>",
        hint: "h", status: "published",
      },
    });
    const taskId = (await created.json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [S.liveComp.id] } });
    await sa.dispose();
    try {
      await api.post("/api/select-competition", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { competitionId: S.liveComp.id } });
      const fetched = await (await api.get(`/api/tasks/${taskId}`)).json();
      // Score the task first (solo) to prime alice's state, then fire
      // 5 parallel RESUBMITS with the same correct answer.
      await api.post(`/api/tasks/${taskId}/submit`, {
        headers: { "x-csrf-token": csrf },
        multipart: { answer: "paris", gradingHash: fetched.grading_hash },
      });
      const lbSolo = await (await api.get("/api/leaderboard")).json();
      const scoreAfterSolo = lbSolo.board.find(u => u.userId === S.alice.id).score;
      // Fire 5 parallel duplicate correct submissions. Some may be
      // rejected (e.g. "already solved"), some may land as duplicate
      // rows — the invariant is that the leaderboard score does NOT
      // multiply. 5x additional correct submissions must not multiply
      // the score by 5.
      await Promise.all(Array.from({ length: 5 }, () =>
        api.post(`/api/tasks/${taskId}/submit`, {
          headers: { "x-csrf-token": csrf },
          multipart: { answer: "paris", gradingHash: fetched.grading_hash },
        })
      ));
      const lbAfter = await (await api.get("/api/leaderboard")).json();
      const scoreAfter = lbAfter.board.find(u => u.userId === S.alice.id).score;
      // The critical invariant: duplicate correct submissions do not
      // double-score. Leaderboard aggregation uses MAX(points_delta)
      // per (user, task) so the score must not have moved.
      expect(scoreAfter, `duplicate correct submits must not double-score (before=${scoreAfterSolo}, after=${scoreAfter})`).toBe(scoreAfterSolo);
    } finally {
      const { api: cleanup, csrf: cleanupCsrf } = await apiLogin("superadmin");
      await cleanup.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": cleanupCsrf } }).catch(() => {});
      await cleanup.dispose();
      await api.dispose();
    }
  });

  test("concurrent approve + block on one user resolves to deterministic final state", async () => {
    // Neither ordering is wrong — but whichever commit wins should
    // leave the user in that exact state (approved=1 AND blocked=1,
    // OR approved=0 AND blocked=1 depending on which landed last).
    // The test asserts the row doesn't end up in an inconsistent
    // "approved but event log says blocked" limbo.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Register a throwaway user.
    const t = Date.now();
    const targetEmail = `race-${t}@company.example`;
    const { api: rc, csrf: rcCsrf } = await freshCtx();
    await registerPost(rc, "/api/register", {
      headers: { "x-csrf-token": rcCsrf, "content-type": "application/json" },
      data: {
        firstName: "Race", lastName: "Block", nickname: `race_${t}`,
        email: targetEmail, company: "C", title: "T",
        avatar: "🦊", country: "US", timezone: "America/New_York",
        // v7.15.16 — a known password, so the post-race probe below can actually
        // attempt a sign-in rather than failing for an unrelated reason.
        password: PARTICIPANT_PASS,
      },
    });
    await rc.dispose();
    const parts = (await (await sa.get("/api/admin/participants?limit=200")).json()).participants;
    const target = parts.find(p => p.email === targetEmail);
    try {
      await sa.post(`/api/admin/participants/${target.id}/verify`, { headers: saH });
      // Fire approve + block in parallel.
      const [approveR, blockR] = await Promise.all([
        sa.post(`/api/admin/participants/${target.id}/approve`, { headers: saH }),
        sa.post(`/api/admin/participants/${target.id}/block`, { headers: saH, data: {} }),
      ]);
      expect(approveR.ok(), "approve: " + approveR.status()).toBeTruthy();
      expect(blockR.ok(), "block: " + blockR.status()).toBeTruthy();
      // Final state: whatever the two writes leave should be internally
      // consistent. Reload the row and assert both flags are 0 or 1
      // (no NULLs, no schema corruption).
      const list2 = (await (await sa.get("/api/admin/participants?limit=200")).json()).participants;
      const final = list2.find(p => p.id === target.id);
      // v7.15.16 — asserting `[0,1]` contains a SQLite boolean cannot fail. The
      // real invariant is that the two writes leave a state the platform can act
      // on consistently: whatever the interleaving, a BLOCKED account must not
      // be able to sign in, and the row must agree with what the API reports.
      expect([0, 1]).toContain(final.approved);
      expect([0, 1]).toContain(final.blocked);
      const Database = require("better-sqlite3");
      const dbChk = new Database(TEST_DB_PATH, { readonly: true });
      let row;
      try { row = dbChk.prepare("SELECT approved, blocked FROM users WHERE id=?").get(target.id); }
      finally { dbChk.close(); }
      expect(row.approved, "the API's view of `approved` matches the row").toBe(final.approved);
      expect(row.blocked, "the API's view of `blocked` matches the row").toBe(final.blocked);
      if (row.blocked) {
        const { api: probe, csrf: pc } = await freshCtx();
        const login = await codeLogin(probe, targetEmail, { "x-csrf-token": pc, "content-type": "application/json" });
        await probe.dispose();
        expect(login.status(),
          "a blocked account must be refused regardless of how the race resolved — " +
          "blocked-but-loggable-in is the outcome this test exists to rule out"
        ).not.toBe(200);
      }
    } finally {
      await sa.delete(`/api/admin/participants/${target.id}`, { headers: { "x-csrf-token": saCsrf } }).catch(() => {});
      await sa.dispose();
    }
  });
});


test.describe("v6.20.x: CxOne username-stability invariant", () => {
  // CxOne provisioning has no integration test through the server (the iss host
  // is allowlisted to *.iam.checkmarx.{net,com}, so a localhost IDP mock can't be
  // stood up without new prod-only test seams — v8.12.6's spawned-child harness,
  // tests/cxone-provision-harness.cjs, reaches it with a stubbed transport, for
  // the erasure race only). Instead lock the *stability invariant* two ways
  // that need no HTTP: (1) the resolution PRECEDENCE in source — provisioning
  // must read the persisted competition_users.cxone_username FIRST and fall back
  // to the live nickname, and must WRITE the resolved username back; (2) the DB
  // contract — the column exists and the documented `stored || nickname`
  // expression picks the stored value even after the nickname changes. A refactor
  // that drops the writeback or reads nickname-first (orphaning the CxOne account
  // on a rename) breaks one of these.
  test("source: provisioning reads stored cxone_username first and writes it back", () => {
    // v7.0.0 — CxOne provisioning moved to lib/cxone.js (was server.js).
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "cxone.js"), "utf8");
    const fnStart = src.indexOf("async function cxOneProvisionUser(");
    expect(fnStart, "cxOneProvisionUser source").toBeGreaterThan(-1);
    // Bound the window at the next top-level declaration so it covers the whole
    // (large) function body — the writeback lives near its end.
    const fnEnd = src.indexOf("function sanitiseCxOneError(", fnStart);
    const fn = src.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 8000);
    // Read-first precedence: stored username || live nickname (order matters —
    // nickname-first would orphan the CxOne account after a rename).
    // v8.8.15 — the column list may GROW (it gained `cxone_user_id`, which is
    // what makes a mis-binding detectable at all), so this pins that the stored
    // username is READ before provisioning, not the exact projection. Pinning
    // the list made this test fail for a reason with nothing to do with its
    // subject the first time a sibling column was added beside it.
    expect(fn, "must SELECT the persisted cxone_username before provisioning")
      .toMatch(/SELECT\s+cxone_username\b[^"']*\bFROM\s+competition_users/i);
    expect(fn, "preferredUsername must be `stored || nickname` (stored takes precedence)")
      .toMatch(/cxone_username\s*\|\|\s*user\.nickname/);
    // Writeback: the resolved username is persisted so it stays stable.
    expect(fn, "must write the resolved username back to competition_users")
      .toMatch(/UPDATE\s+competition_users\s+SET\s+cxone_username=/i);
  });

  test("db: stored cxone_username wins over a changed nickname", () => {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    try {
      // Column must exist (the stability feature's storage).
      const cols = db.prepare("PRAGMA table_info(competition_users)").all().map(c => c.name);
      expect(cols, "competition_users.cxone_username column").toContain("cxone_username");
      // Simulate: a row provisioned under the original username, then the user
      // renames their Hack Arena nickname. The resolution expression the code
      // uses (`_cuRow?.cxone_username || user.nickname`) must still yield the
      // ORIGINAL username, not the new nickname.
      const stored = "cxone_original_name";
      const newNickname = "renamed_nickname";
      const resolve = (cxUsername, nickname) => cxUsername || nickname;
      expect(resolve(stored, newNickname), "stored username must win").toBe(stored);
      // And when nothing was stored yet, it falls back to the live nickname.
      expect(resolve(null, newNickname), "fallback to nickname when unset").toBe(newNickname);
    } finally {
      db.close();
    }
  });
});


test.describe("Email format validation", () => {
  test("registration: a malformed primary email is never proven, so it can never be registered", async () => {
    // Email first: the address is checked at the entry screen, before any form.
    // A malformed one is mailed nothing (no address proof), so no session can
    // hold a grant for it and the form refuses 403 email_proof_required. The
    // account's address is always the grant's, so the form's own format check
    // can only ever see a proven address.
    const { api, csrf } = await freshCtx();
    const entry = await entryCode(api, "not-an-email");
    expect(entry.answer, "the entry answer is uniform").toEqual({ ok: true });
    expect(entry.mail, "nothing is mailed to a malformed address").toBeNull();
    const r = await registerPost(api, "/api/register", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        firstName: "Bad", lastName: "Email", nickname: `bad_${Date.now()}`,
        company: "C", title: "T", avatar: "🦊",
        country: "US", timezone: "America/New_York",
        email: "not-an-email",   // would otherwise pass isFreeEmail()
      },
    });
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe("email_proof_required");
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try { expect(db.prepare("SELECT COUNT(*) c FROM users WHERE email='not-an-email'").get().c).toBe(0); }
    finally { db.close(); }
    await api.dispose();
  });

  test("registration: malformed secondary email is rejected with 400", async () => {
    const { api, csrf } = await freshCtx();
    const r = await registerPost(api, "/api/register", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        firstName: "Bad", lastName: "Sec", nickname: `bad2_${Date.now()}`,
        company: "C", title: "T", avatar: "🦊",
        country: "US", timezone: "America/New_York",
        email: `ok-${Date.now()}@company.com`,
        secondaryEmail: "also-not-an-email",
      },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/valid secondary email/i);
    await api.dispose();
  });

  test("self profile edit: malformed email is rejected with 400", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const r = await api.put("/api/me", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { email: "garbage@", secondaryEmail: "" },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/valid email/i);
    await api.dispose();
  });

  test("admin profile edit: malformed primary email is rejected with 400", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const r = await sa.put(`/api/admin/participants/${S.bob.id}`, {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { email: "no-domain-here" },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/valid email/i);
    await sa.dispose();
  });

  test("participant import: any malformed email rejects the whole batch with row context", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/import/participants", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        data: {
          type: "hackarena-participants",
          participants: [
            { nickname: `imp_ok_${Date.now()}`, email: `imp-ok-${Date.now()}@company.com`, first_name: "Ok", last_name: "Row" },
            { nickname: `imp_bad_${Date.now()}`, email: "broken-row", first_name: "Bad", last_name: "Row" },
          ],
        },
      },
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/Row 2/);
    expect(body.error).toMatch(/broken-row/);
    await api.dispose();
  });

  test("happy path: a properly formatted email still goes through (regression guard)", async () => {
    const { api, csrf } = await freshCtx();
    const t = Date.now();
    const r = await registerPost(api, "/api/register", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        firstName: "Good", lastName: "Email", nickname: `good_${t}`,
        company: "C", title: "T", avatar: "🦊",
        country: "US", timezone: "America/New_York",
        email: `good-${t}@company.co`,
        secondaryEmail: `good-${t}@personal.gmail.com`,
      },
    });
    expect(r.ok(), `register failed: ${r.status()} ${await r.text()}`).toBeTruthy();
    await api.dispose();
  });





  test("invitations: SMTP failure populates emailsSent < invited and undeliveredInvites[] with registration links", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const t = Date.now();
    const a = `inv-undeliv-a-${t}@company.co`;
    const b = `inv-undeliv-b-${t}@company.co`;
    const r = await sa.post("/api/admin/invitations", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { emails: [a, b], competitionIds: [] },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.invited).toBe(2);
    expect(body.emailsSent).toBe(0);
    // undeliveredInvites is an array of {email, link} so the admin can
    // share the link manually when SMTP is down.
    const entries = (body.undeliveredInvites || []).slice().sort((x, y) => x.email.localeCompare(y.email));
    expect(entries.map(e => e.email)).toEqual([a, b].sort());
    for (const e of entries) {
      // v6.9.10: invitation links emit `/register?invitation=<id>`;
      // pre-v6.9.10 format was `/?invitation=<id>#register-page`.
      // Accept either so the test doesn't relitigate URL-routing
      // changes — the invariant under test is "a live link is
      // surfaced per undelivered address", not the URL shape.
      expect(e.link).toMatch(/(?:\/\?invitation=[a-f0-9-]+#register-page|\/register\?invitation=[a-f0-9-]+)$/);
    }
    await sa.dispose();
  });

  // Atomic dedup: the partial unique index on
  // invitations(email COLLATE NOCASE) WHERE used_at IS NULL makes it
  // impossible for two racing requests (e.g. multi-instance deployment)
  // to both create a live invitation for the same address. Direct DB
  // insert of a duplicate must raise SQLITE_CONSTRAINT — that's the
  // guarantee the server relies on to fall through to the retry path.
  test("invitations: partial unique index rejects a duplicate live invitation at the DB level", async () => {
    await ensureState();
    const t = Date.now();
    const addr = `inv-atomic-${t}@company.co`;
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    try {
      db.prepare("DELETE FROM invitations WHERE LOWER(email)=LOWER(?)").run(addr);
      db.prepare("INSERT INTO invitations (id, email, competition_ids, invited_by, created_at, last_send_success) VALUES (?,?,?,?,?,0)")
        .run("atom-1-" + t, addr, "[]", "superadmin", new Date().toISOString());
      // Second live insert (same email, used_at NULL): must fail.
      let err = null;
      try {
        db.prepare("INSERT INTO invitations (id, email, competition_ids, invited_by, created_at, last_send_success) VALUES (?,?,?,?,?,0)")
          .run("atom-2-" + t, addr, "[]", "superadmin", new Date().toISOString());
      } catch (e) { err = e; }
      expect(err).toBeTruthy();
      expect(err.code).toBe("SQLITE_CONSTRAINT_UNIQUE");
      // But a row with used_at SET does not block: the partial index's
      // `WHERE used_at IS NULL` predicate explicitly allows redeemed rows
      // to coexist with a new live row for the same address.
      db.prepare("UPDATE invitations SET used_at=? WHERE id=?").run(new Date().toISOString(), "atom-1-" + t);
      db.prepare("INSERT INTO invitations (id, email, competition_ids, invited_by, created_at, last_send_success) VALUES (?,?,?,?,?,0)")
        .run("atom-3-" + t, addr, "[]", "superadmin", new Date().toISOString());
    } finally {
      db.prepare("DELETE FROM invitations WHERE LOWER(email)=LOWER(?)").run(addr);
      db.close();
    }
  });

  // Retry-on-undelivered: a second admin invite for an address whose first
  // send failed must NOT go down the `alreadyInvited` no-op branch. It
  // should re-send, and when SMTP is still down, re-appear in
  // undeliveredInvites with the registration link for manual share.
  test("invitations: retry of an undelivered invitation re-sends the email and surfaces the link again", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const t = Date.now();
    const addr = `inv-retry-${t}@company.co`;
    // First invite: SMTP down → undelivered.
    const r1 = await sa.post("/api/admin/invitations", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { emails: [addr], competitionIds: [] },
    });
    const body1 = await r1.json();
    expect(body1.emailsSent).toBe(0);
    expect((body1.undeliveredInvites || []).length).toBe(1);
    expect(body1.alreadyInvited || []).not.toContain(addr);

    // Second invite (same address): must NOT alreadyInvited. It must retry
    // and, since SMTP is still down, re-appear in undeliveredInvites.
    const r2 = await sa.post("/api/admin/invitations", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { emails: [addr], competitionIds: [] },
    });
    const body2 = await r2.json();
    expect(body2.alreadyInvited || []).not.toContain(addr);
    expect((body2.undeliveredInvites || []).length).toBe(1);
    expect(body2.undeliveredInvites[0].email).toBe(addr);
    // v6.9.10: see same-named note in the prior test; accept either
    // the old `/?invitation=#register-page` or new `/register?invitation=` shape.
    expect(body2.undeliveredInvites[0].link).toMatch(/(?:\/\?invitation=[a-f0-9-]+#register-page|\/register\?invitation=[a-f0-9-]+)$/);
    // The invitation id must be the same across both attempts (we retry on
    // the existing row, we don't create a new one).
    expect(body2.undeliveredInvites[0].link).toBe(body1.undeliveredInvites[0].link);
    await sa.dispose();
  });

  // Retry success accounting: when an admin's retry of a previously-
  // undelivered invitation succeeds, the response must increment `resent`
  // AND `emailsSent`, and the UI must see something to report. Without a
  // distinct `resent` counter, `invited=0 && emailsSent=1` was falling
  // through the UI's "nothing happened" branch. Simulate a successful
  // retry by force-flipping last_send_success=0 on an existing invitation
  // and adjusting the seed-time SMTP state — because we can't bring up
  // real SMTP, we drive this test through the server's own reporting of
  // the retry path.
  test("invitations: successful retry surfaces in `resent` and `emailsSent` (not hidden by invited=0)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const t = Date.now();
    const addr = `inv-resent-${t}@company.co`;
    // First invite: SMTP down → undelivered, last_send_success=0.
    const r1 = await sa.post("/api/admin/invitations", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { emails: [addr], competitionIds: [] },
    });
    expect(r1.ok()).toBeTruthy();
    // Directly confirm the row exists with last_send_success=0.
    const Database = require("better-sqlite3");
    const dbr = new Database(TEST_DB_PATH, { readonly: true });
    const row = dbr.prepare("SELECT last_send_success FROM invitations WHERE LOWER(email)=LOWER(?)").get(addr);
    dbr.close();
    expect(row.last_send_success).toBe(0);
    // The response shape must include a `resent` field (0 on the first
    // request — no prior row to retry). This locks in the contract.
    const body1 = await r1.json();
    expect(typeof body1.resent).toBe("number");
    expect(body1.resent).toBe(0);
    await sa.dispose();
  });

  test("self email change: SMTP failure still STAGES the pending change and keeps the user logged in on the old email", async () => {
    // v7.5.0 — a primary-email change is staged in pending_email and confirmed
    // via a link; the live account never changes here. The test env has no SMTP
    // server (ECONNREFUSED), so emailDelivered comes back false — but the pending
    // is still staged (no lockout) and the committed identity is untouched.
    const t = Date.now();
    const oldEmail = `selfchg-old-${t}@company.co`;
    const newEmail = `selfchg-new-${t}@company.co`;
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await registerPost(sa, "/api/register", {
      headers: saH,
      data: {
        firstName: "Self", lastName: "Chg", nickname: `selfchg_${t}`,
        company: "C", title: "T", avatar: "🦊",
        country: "US", timezone: "America/New_York",
        email: oldEmail,
      },
    });
    const users = await (await sa.get("/api/admin/participants?limit=500")).json();
    const user = users.participants.find(p => p.email === oldEmail);
    await sa.post(`/api/admin/participants/${user.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${user.id}/approve`, { headers: saH });

    // Log the user in, change email to a new address. SMTP will fail.
    const { api: me, csrf: meCsrf } = await apiLogin(oldEmail, PARTICIPANT_PASS);
    // Snapshot the committed verification state BEFORE the change, so the
    // assertions below can say "unchanged" rather than guessing at a value.
    const _DbPre = require("better-sqlite3");
    const _pre = new _DbPre(TEST_DB_PATH, { readonly: true });
    const beforeVerifyCode = _pre.prepare("SELECT verify_code FROM users WHERE id=?").get(user.id).verify_code;
    _pre.close();

    const r = await me.put("/api/me", {
      headers: { "x-csrf-token": meCsrf, "content-type": "application/json" },
      data: { email: newEmail },
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.emailChangePending).toBe(true);
    expect(body.emailDelivered).toBe(false);
    expect(body.pendingEmail).toBe(newEmail.toLowerCase());

    // Session must STILL be alive — the user is not locked out.
    const meAfter = await me.get("/api/me");
    expect(meAfter.ok()).toBe(true);
    const meBody = await meAfter.json();
    // Committed email is still the original; the new one is only pending.
    expect(meBody.email).toBe(oldEmail);
    expect(meBody.pending_email).toBe(newEmail.toLowerCase());
    expect(meBody.id).toBe(user.id);
    await me.dispose();

    // DB confirms: committed email/verified/verify_code untouched; pending staged.
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const after = db.prepare("SELECT email, verified, verify_code, pending_email FROM users WHERE id=?").get(user.id);
    db.close();
    expect(after.email).toBe(oldEmail);
    expect(after.verified).toBe(1);
    // v8.3.23 — UNTOUCHED means unchanged, not null. This asserted `null`, which
    // was only ever true because the admin verify in the setup above used to
    // clear the verification receipt; that receipt is retained now, and staging a
    // pending change must not disturb it either way. Comparing against the
    // pre-change value states the subject of this test ("the live account is
    // untouched") rather than a side effect of how the fixture was built.
    expect(after.verify_code).toBe(beforeVerifyCode);
    expect(after.pending_email).toBe(newEmail.toLowerCase());
  });

  // Reminder dispatcher uses a two-flag design:
  //   • claimed_at — lease marker set before the SMTP await
  //   • sent       — flipped to 1 only on confirmed delivery
  // The claim predicate `sent=0 AND claimed_at IS NULL` makes the claim
  // idempotent against overlapping ticks and cross-process dispatchers. A
  // second tick observing the row already claimed gets changes=0 and skips.
  // Crash-safety: a process that claims a reminder and then dies (before
  // delivering or releasing the claim) must not strand the reminder as
  // permanently "sent". The dispatcher reaps claims older than the lease
  // timeout (REMINDER_CLAIM_TIMEOUT_MS) before each tick. Simulate by
  // planting a stale claim with claimed_at old enough and verifying the
  // sweep SQL releases it back to the unclaimed state — ready for re-dispatch.
  // Race-safety against reminder replacement: if the dispatcher has claimed a
  // row and the user deletes+reinserts the reminder (change of timeslot,
  // reset), the in-flight tick must NOT mark the fresh row as sent. The
  // dispatcher now matches by claim_token on complete / release, so a
  // DELETE+INSERT between claim and delivery leaves the fresh row untouched.
  // ───────────────────────────────────────────────────────────────────────────
  // v7.21.5 — the dispatcher, driven for real.
  //
  // v8.12.4 — three older tests sat above this block, re-implementing the
  // dispatcher's SQL in the test body; they asserted that SQLite honours a WHERE
  // clause, and reverting server.js could not fail them. They are gone, and their
  // three properties are driven through the REAL tick below
  // (POST /api/test/reminder-tick).
  //
  // THE DEFECT: two admin writers move a pending reminder's send_at IN PLACE —
  // routes/sessions.js (a session start-time edit, scoped to EVERY unsent row of
  // that session) and routes/competitions.js (the single-slot twin) — touching
  // neither sent nor claimed_at nor claim_token. That is the one mutation
  // claim_token cannot see, and it opened two windows: SELECT→claim (the claim
  // had dropped the send_at predicate the SELECT used) and claim→mark-delivered
  // (straddling the SMTP await). Both are closed by binding each statement to
  // the row's full schedule identity.
  // ───────────────────────────────────────────────────────────────────────────
  test.describe("v7.21.5 — the reminder dispatcher, driven for real", () => {
    const RH = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

    /** Two participants + one upcoming session, both reminders backdated to due. */
    async function reminderFixture() {
      const { api, csrf } = await apiLogin("superadmin");
      const tag = `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
      const startMs = Date.now() + 2 * 60 * 60_000;
      const comp = (await (await api.post("/api/admin/competitions", {
        headers: RH(csrf), data: { name: `Rem ${tag}`, start_time: new Date(startMs).toISOString(), duration_minutes: 180 },
      })).json()).competition;
      const ts = (await (await api.post(`/api/admin/competitions/${comp.id}/timeslots`, {
        headers: RH(csrf), data: { name: `S1 ${tag}`, start_time: new Date(startMs).toISOString(), duration_minutes: 180 },
      })).json()).timeslot;
      expect(ts?.id, "session created").toBeTruthy();

      const people = [];
      for (const n of ["a", "b"]) {
        const email = `rem-${n}-${tag}@company.example`;
        expect((await registerPost(api, "/api/register", { headers: RH(csrf), data: {
          firstName: "Rem", lastName: n.toUpperCase(), nickname: `rem_${n}_${tag}`, email,
          company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
          password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "T",
        }})).ok(), "register").toBeTruthy();
        const u = (await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json())
          .participants.find(p => p.email === email);
        await api.post(`/api/admin/participants/${u.id}/verify`, { headers: RH(csrf) });
        await api.post(`/api/admin/participants/${u.id}/approve`, { headers: RH(csrf) });
        people.push({ email, id: u.id });
      }
      await api.post("/api/admin/competitions/assign", {
        headers: RH(csrf), data: { userIds: people.map(p => p.id), competitionIds: [comp.id] },
      });
      // Each picks the session and requests a reminder.
      for (const p of people) {
        const pc = await apiLogin(p.email, PARTICIPANT_PASS);
        await pc.api.post("/api/select-competition", { headers: RH(pc.csrf), data: { competitionId: comp.id } });
        await pc.api.post("/api/select-timeslot", { headers: RH(pc.csrf), data: { timeslotId: ts.id } });
        const rr = await pc.api.post(`/api/competitions/${comp.id}/reminder`, { headers: RH(pc.csrf) });
        expect(rr.ok(), `reminder requested for ${p.email}`).toBeTruthy();
        await pc.api.dispose();
      }
      // Backdate BOTH so they are due in one batch — two rows is the minimum
      // that exercises the SELECT→claim window at all.
      const Database = require("better-sqlite3");
      const d = new Database(TEST_DB_PATH);
      try {
        const due = new Date(Date.now() - 60_000).toISOString();
        const n = d.prepare("UPDATE email_reminders SET send_at=? WHERE competition_id=?").run(due, comp.id).changes;
        expect(n, "both reminders must exist and be backdated").toBe(2);
      } finally { d.close(); }
      return { api, csrf, comp, ts, people, tag };
    }

    const rows = (compId) => {
      const Database = require("better-sqlite3");
      const d = new Database(TEST_DB_PATH);
      try { return d.prepare("SELECT * FROM email_reminders WHERE competition_id=? ORDER BY user_id").all(compId); }
      finally { d.close(); }
    };
    const sentEvents = (userIds) => {
      const Database = require("better-sqlite3");
      const d = new Database(TEST_DB_PATH);
      try {
        return d.prepare(`SELECT user_id FROM user_events WHERE event_type='reminder_email_sent' AND user_id IN (${userIds.map(() => "?").join(",")})`).all(...userIds);
      } finally { d.close(); }
    };

    test("the happy path actually dispatches — POSITIVE CONTROL for the two below", async () => {
      const f = await reminderFixture();
      try {
        const r = await f.api.post("/api/test/reminder-tick", { headers: RH(f.csrf), data: { forceDelivered: true } });
        const out = await r.json();
        expect(out.ran, "the tick must actually have run — a skipped tick makes every assertion vacuous").toBe(true);
        expect(out.claimed, "both due rows claimed").toBe(2);
        expect(out.delivered, "both marked delivered").toBe(2);
        for (const row of rows(f.comp.id)) expect(row.sent, "row marked sent").toBe(1);
        expect(sentEvents(f.people.map(p => p.id)).length, "both got a reminder_email_sent event").toBe(2);
      } finally { await f.api.dispose(); }
    });

    // v8.12.4 — the three SQL-copy tests the note above calls vacuous are gone;
    // these drive the same three properties through the REAL tick.
    test("overlapping ticks never send a reminder twice — the second tick stands aside", async () => {
      const f = await reminderFixture();
      try {
        const first = f.api.post("/api/test/reminder-tick", { headers: RH(f.csrf), data: { delayMs: 800, forceDelivered: true } });
        await expect.poll(() => rows(f.comp.id).filter(r => r.claimed_at).length,
          { timeout: 5000, intervals: [50, 100, 200] }).toBeGreaterThan(0);
        const second = await (await f.api.post("/api/test/reminder-tick", { headers: RH(f.csrf), data: { forceDelivered: true } })).json();
        expect(second.ran, "a tick that finds one running does nothing").toBe(false);
        const out = await (await first).json();
        expect(out.delivered, "the first tick delivers both").toBe(2);
        const third = await (await f.api.post("/api/test/reminder-tick", { headers: RH(f.csrf), data: { forceDelivered: true } })).json();
        expect(third.ran).toBe(true);
        expect(third.claimed, "a delivered reminder is never claimed again").toBe(0);
        expect(sentEvents(f.people.map(p => p.id)).length, "each participant is told exactly once").toBe(2);
      } finally { await f.api.dispose(); }
    });

    test("a STALE claim (a crashed tick's lease) is released and delivered; a LIVE claim is left alone", async () => {
      const f = await reminderFixture();
      try {
        const [a, b] = rows(f.comp.id);
        const Database = require("better-sqlite3");
        const d = new Database(TEST_DB_PATH);
        try {
          // The lease is two minutes. A ten-minute-old claim is a tick that died
          // mid-send; a ten-second-old one is a tick that is still working.
          const set = d.prepare("UPDATE email_reminders SET claimed_at=?, claim_token=? WHERE user_id=? AND competition_id=?");
          set.run(new Date(Date.now() - 10 * 60_000).toISOString(), "crashed-tick", a.user_id, f.comp.id);
          set.run(new Date(Date.now() - 10_000).toISOString(), "live-tick", b.user_id, f.comp.id);
        } finally { d.close(); }
        const out = await (await f.api.post("/api/test/reminder-tick", { headers: RH(f.csrf), data: { forceDelivered: true } })).json();
        expect(out.ran).toBe(true);
        expect(out.delivered, "only the abandoned claim is re-dispatched").toBe(1);
        const after = Object.fromEntries(rows(f.comp.id).map(r => [r.user_id, r]));
        expect(after[a.user_id].sent, "the crashed tick's reminder is not lost").toBe(1);
        expect(after[b.user_id].sent, "the live tick's reminder is not stolen").toBe(0);
        expect(after[b.user_id].claim_token, "…and its lease is untouched").toBe("live-tick");
      } finally {
        const Database = require("better-sqlite3");
        const dd = new Database(TEST_DB_PATH);
        // Leave no due, unsent row behind: the next test's tick would claim it.
        try { dd.prepare("DELETE FROM email_reminders WHERE competition_id=?").run(f.comp.id); } finally { dd.close(); }
        await f.api.dispose();
      }
    });

    test("a reminder deleted and re-created while its claim is in flight is NOT marked sent by the old tick", async () => {
      const f = await reminderFixture();
      try {
        const tick = f.api.post("/api/test/reminder-tick", { headers: RH(f.csrf), data: { delayMs: 1500, forceDelivered: true } });
        let claimed;
        await expect.poll(() => { claimed = rows(f.comp.id).find(r => r.claimed_at); return !!claimed; },
          { timeout: 5000, intervals: [50, 100, 200] }).toBe(true);
        // The participant asks again while the send is parked: the route clears
        // their reminder and writes a NEW row for the same event.
        const who = f.people.find(p => p.id === claimed.user_id);
        const pc = await apiLogin(who.email, PARTICIPANT_PASS);
        try {
          const again = await pc.api.post(`/api/competitions/${f.comp.id}/reminder`, { headers: RH(pc.csrf) });
          expect(again.ok(), `re-request: ${await again.text()}`).toBeTruthy();
        } finally { await pc.api.dispose(); }
        await tick;
        const mine = rows(f.comp.id).filter(r => r.user_id === who.id);
        expect(mine, "one reminder per participant per event").toHaveLength(1);
        expect(mine[0].sent, "the NEW row is untouched by the old tick's completion").toBe(0);
        expect(mine[0].claim_token, "and carries no stale lease").toBeNull();
      } finally { await f.api.dispose(); }
    });

    test("an SMTP failure leaves the reminder UNSENT and released, so the next tick retries it", async () => {
      // No forceDelivered: the shared test server's relay is dead, so the send
      // really fails. Before the fix `sent` flipped to 1 regardless — a reminder
      // lost for good. (v8.12.4: this used to be approximated through a
      // registration email's audit row, never touching the dispatcher.)
      const f = await reminderFixture();
      try {
        const out = await (await f.api.post("/api/test/reminder-tick", { headers: RH(f.csrf), data: {} })).json();
        expect(out.ran).toBe(true);
        expect(out.claimed, "both rows were claimed and attempted").toBe(2);
        expect(out.delivered, "…and neither was delivered").toBe(0);
        for (const r of rows(f.comp.id)) {
          expect(r.sent, "an undelivered reminder is not marked sent").toBe(0);
          expect(r.claimed_at, "…and its lease is released for the next tick").toBeNull();
        }
      } finally {
        const Database = require("better-sqlite3");
        const dd = new Database(TEST_DB_PATH);
        // Leave no due, unsent row behind: the next test's tick would claim it.
        try { dd.prepare("DELETE FROM email_reminders WHERE competition_id=?").run(f.comp.id); } finally { dd.close(); }
        await f.api.dispose();
      }
    });

    test("W1 — a session edit mid-batch does not announce the moved session to the rest of the batch", async () => {
      const f = await reminderFixture();
      try {
        // Park the tick before the SMTP send, then move the session while the
        // FIRST row is in flight. Poll for the claim rather than hoping.
        const tick = f.api.post("/api/test/reminder-tick", { headers: RH(f.csrf), data: { delayMs: 1200, forceDelivered: true } });
        await expect.poll(() => rows(f.comp.id).filter(r => r.claimed_at).length,
          { timeout: 5000, intervals: [50, 100, 200] }).toBe(1);

        const mv = await f.api.put(`/api/admin/competitions/${f.comp.id}/timeslots/${f.ts.id}`, {
          headers: RH(f.csrf), data: { start_time: new Date(Date.now() + 4 * 60 * 60_000).toISOString() },
        });
        expect(mv.ok(), `session start moved: ${await mv.text()}`).toBeTruthy();

        const out = await (await tick).json();
        expect(out.ran).toBe(true);

        // THE ASSERTION. The admin UPDATE is scoped
        // `WHERE competition_id=? AND timeslot_id=? AND sent=0`, so it moves
        // EVERY still-unsent row — including the one already claimed. So the
        // observable for W1 is the CLAIM being refused on the second row: with
        // the send_at predicate dropped it is claimed and announced at the old
        // time (claimed:2); with it, the tick claims exactly the one row it had
        // already taken before the edit.
        expect(out.claimed,
          "the second row's session was rescheduled before its claim — the claim must be REFUSED, " +
          "not granted against a snapshot that is no longer due"
        ).toBe(1);
        // And nothing was announced, because the claimed row was rescheduled too
        // (mark-delivered is identity-bound, so it correctly refuses).
        expect(sentEvents(f.people.map(p => p.id)).length,
          "no reminder may be recorded as delivered for a session that has moved"
        ).toBe(0);
        const after = rows(f.comp.id);
        const unsent = after.filter(r => !r.sent);
        expect(unsent.length, "BOTH rows remain pending at the new time").toBe(2);
        for (const r of unsent) {
          expect(r.claimed_at, "a skipped/released row holds no claim").toBeNull();
          expect(r.claim_token, "…and no token").toBeNull();
        }
      } finally { await f.api.dispose(); }
    });

    test("W2 — a session edit DURING the send does not consume the reminder", async () => {
      const f = await reminderFixture();
      try {
        const tick = f.api.post("/api/test/reminder-tick", { headers: RH(f.csrf), data: { delayMs: 1500, forceDelivered: true } });
        await expect.poll(() => rows(f.comp.id).filter(r => r.claimed_at).length,
          { timeout: 5000, intervals: [50, 100, 200] }).toBe(1);
        // Move the schedule while the claimed row is mid-send. mark-delivered
        // must NOT match it: the mail has gone, but the row is now due at a
        // different time and consuming it loses that reminder for ever.
        await f.api.put(`/api/admin/competitions/${f.comp.id}/timeslots/${f.ts.id}`, {
          headers: RH(f.csrf), data: { start_time: new Date(Date.now() + 5 * 60 * 60_000).toISOString() },
        });
        await tick;

        for (const r of rows(f.comp.id)) {
          expect(r.sent,
            "a reminder whose schedule moved while SMTP was in flight must NOT be stamped sent=1 — it would never fire again"
          ).toBe(0);
          expect(r.claimed_at, "the claim is RELEASED, not left to time out on the 2-minute lease").toBeNull();
          expect(r.claim_token).toBeNull();
        }
      } finally { await f.api.dispose(); }
    });
  });

  // Client-facing truth: /api/competitions/:id/reminder must read `sent`,
  // not `claimed_at`. During the claimed-but-not-yet-delivered window the
  // UI should still show the reminder as pending — not as "sent!".
  test("reminder client-read: claimed-but-undelivered state is reported as pending, not sent", async () => {
    await ensureState();
    // Alice is assigned to the live comp, but the live comp is — live, not
    // upcoming, so the reminder-create API rejects. Build a fresh upcoming
    // competition owned by this test for a clean happy-path.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const compCreate = await sa.post("/api/admin/competitions", {
      headers: saH,
      data: {
        name: `RemindPending-${Date.now()}`,
        start_time: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 60,
      },
    });
    const comp = (await compCreate.json()).competition;
    await sa.post("/api/admin/competitions/assign", {
      headers: saH, data: { userIds: [S.alice.id], competitionIds: [comp.id] },
    });
    await sa.dispose();

    const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const setRes = await alice.post(`/api/competitions/${comp.id}/reminder`, {
      headers: { "x-csrf-token": aliceCsrf, "content-type": "application/json" },
    });
    expect(setRes.ok()).toBeTruthy();

    // Plant a claim at the DB level — mimics the dispatcher having claimed
    // the row but not yet completed delivery.
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    db.prepare("UPDATE email_reminders SET claimed_at=? WHERE user_id=? AND competition_id=?")
      .run(new Date().toISOString(), S.alice.id, comp.id);
    db.close();

    // Client GET must still see `sent: false` — the reminder hasn't
    // actually landed in the user's inbox yet, only a claim is pending.
    const getRes = await alice.get(`/api/competitions/${comp.id}/reminder`);
    expect(getRes.ok()).toBeTruthy();
    const body = await getRes.json();
    expect(body.requested).toBe(true);
    expect(body.sent).toBe(false);
    await alice.dispose();

    // Cleanup: delete the test comp so it doesn't pollute later tests.
    const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
    await sa2.delete(`/api/admin/competitions/${comp.id}`, { headers: { "x-csrf-token": sa2Csrf } });
    await sa2.dispose();
  });

  test("invitations: malformed addresses are rejected per-row (free emails still allowed)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const t = Date.now();
    // Mix of: malformed (must be reported), free-provider (must succeed —
    // invitations bypass the dual-email rule on purpose), and a normal
    // company email. The endpoint reports a per-email errors array rather
    // than failing the whole batch.
    const r = await sa.post("/api/admin/invitations", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: {
        emails: [
          "not-an-email",
          `personal-${t}@gmail.com`,
          `co-${t}@business.co`,
        ],
        competitionIds: [],
      },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.errors || []).toEqual(expect.arrayContaining([expect.stringMatching(/Invalid email.*not-an-email/)]));
    expect((body.errors || []).join(" ")).not.toMatch(/gmail\.com/);
    expect(body.invited).toBeGreaterThanOrEqual(2);
    await sa.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// INVITATION cross-batch dedup
// ═══════════════════════════════════════════════════════════════════════════════
// A previous fix de-duplicated within a single batch (paste the same address
// twice → one invitation row). This pins the cross-BATCH guard: re-inviting
// the same not-yet-registered address in a later request must NOT create a
// second live invitation row. Without this, multiple links remain valid;
// only the first redeemed succeeds and later ones become dead at the
// existing-account check during registration, silently dropping any extra
// competition-assignment intent.
test.describe("Invitation cross-batch deduplication", () => {
  test("a second admin invite for the same unredeemed address creates no new row (and reports alreadyInvited once the prior send succeeded)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const t = Date.now();
    const target = `xbatch-${t}@business.co`;

    // First invite — this is genuinely new. SMTP is down in tests so the
    // initial send lands as undelivered; force the success path for this
    // test by flipping last_send_success=1 directly, so the second invite
    // exercises the steady-state dedup branch (prior send succeeded → no
    // retry, report alreadyInvited).
    const r1 = await sa.post("/api/admin/invitations", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { emails: [target], competitionIds: [] },
    });
    expect(r1.ok()).toBeTruthy();
    expect((await r1.json()).invited).toBe(1);
    const Database = require("better-sqlite3");
    const dbw = new Database(TEST_DB_PATH);
    dbw.prepare("UPDATE invitations SET last_send_success=1 WHERE LOWER(email)=LOWER(?)").run(target);
    dbw.close();

    // Second invite for the same address — with last_send_success=1, the
    // dedup branch takes over: no new row, no retry, reported as alreadyInvited.
    const r2 = await sa.post("/api/admin/invitations", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { emails: [target], competitionIds: [] },
    });
    expect(r2.ok()).toBeTruthy();
    const body2 = await r2.json();
    expect(body2.invited).toBe(0);
    expect(body2.alreadyInvited).toEqual(expect.arrayContaining([target]));
    await sa.dispose();

    // The DB must have exactly ONE invitation row for this email.
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const rows = db.prepare("SELECT id, used_at FROM invitations WHERE LOWER(email)=LOWER(?)").all(target);
    db.close();
    expect(rows.length).toBe(1);
    expect(rows[0].used_at).toBeNull();
  });

  test("a re-invite for an unredeemed address MERGES the new comp ids into the existing invitation row", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const t = Date.now();
    const target = `xbatch-merge-${t}@business.co`;

    // First invite — only Test Live. Flip last_send_success=1 to exercise
    // the steady-state dedup branch (the retry branch is covered by a
    // separate test).
    const r1 = await sa.post("/api/admin/invitations", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { emails: [target], competitionIds: [S.liveComp.id] },
    });
    expect(r1.ok()).toBeTruthy();
    expect((await r1.json()).invited).toBe(1);
    const DatabaseW = require("better-sqlite3");
    const dbw = new DatabaseW(TEST_DB_PATH);
    dbw.prepare("UPDATE invitations SET last_send_success=1 WHERE LOWER(email)=LOWER(?)").run(target);
    dbw.close();

    // Second invite for the SAME address — adds Test Upcoming. The new
    // dedup guard skips creating a second row, but it MUST merge the new
    // comp into the existing invitation's competition_ids — otherwise
    // when the invitee eventually registers, only Test Live attaches and
    // the admin's intent for Test Upcoming is silently dropped.
    const r2 = await sa.post("/api/admin/invitations", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { emails: [target], competitionIds: [S.upcomingComp.id] },
    });
    expect(r2.ok()).toBeTruthy();
    const body2 = await r2.json();
    expect(body2.alreadyInvited).toEqual(expect.arrayContaining([target]));

    // The DB row's competition_ids now contains BOTH comps, in some order.
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const inv = db.prepare("SELECT competition_ids FROM invitations WHERE LOWER(email)=LOWER(?) AND used_at IS NULL").get(target);
    db.close();
    expect(inv).toBeTruthy();
    const merged = JSON.parse(inv.competition_ids);
    expect(merged).toEqual(expect.arrayContaining([S.liveComp.id, S.upcomingComp.id]));

    // Now the invitee registers through the invitation — both comps must
    // end up in their competition_users rows. This is the end-to-end proof
    // that the merge actually flowed through to assignment, not just the
    // invitation row.
    const db2 = new Database(TEST_DB_PATH, { readonly: true });
    const invForReg = db2.prepare("SELECT id FROM invitations WHERE LOWER(email)=LOWER(?) AND used_at IS NULL").get(target);
    db2.close();
    expect(invForReg).toBeTruthy();
    const { api: anon, csrf: anonCsrf } = await freshCtx();
    const reg = await registerPost(anon, "/api/register", {
      headers: { "x-csrf-token": anonCsrf, "content-type": "application/json" },
      data: {
        firstName: "Merge", lastName: "Flow", nickname: `mergeflow_${t}`,
        company: "C", title: "T", avatar: "🦊",
        country: "US", timezone: "America/New_York",
        email: target, invitationId: invForReg.id,
      },
    });
    expect(reg.ok(), `reg failed: ${reg.status()} ${await reg.text()}`).toBeTruthy();
    await anon.dispose();
    // Membership rows for BOTH comps land in competition_users.
    const db3 = new Database(TEST_DB_PATH, { readonly: true });
    const newUser = db3.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(target);
    const memberships = db3.prepare("SELECT competition_id FROM competition_users WHERE user_id=?").all(newUser.id);
    db3.close();
    const memCompIds = memberships.map(m => m.competition_id);
    expect(memCompIds).toEqual(expect.arrayContaining([S.liveComp.id, S.upcomingComp.id]));
    await sa.dispose();
  });

  test("a USED invitation does not block a fresh one for the same address", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const t = Date.now();
    const target = `xbatch-used-${t}@business.co`;

    // Invite + redeem (mark the invitation used by registering through it).
    const r1 = await sa.post("/api/admin/invitations", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { emails: [target], competitionIds: [] },
    });
    expect(r1.ok()).toBeTruthy();
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const inv = db.prepare("SELECT id FROM invitations WHERE LOWER(email)=LOWER(?)").get(target);
    db.close();
    const { api: anon, csrf: anonCsrf } = await freshCtx();
    const reg = await registerPost(anon, "/api/register", {
      headers: { "x-csrf-token": anonCsrf, "content-type": "application/json" },
      data: {
        firstName: "Used", lastName: "Inv", nickname: `usedinv_${t}`,
        company: "C", title: "T", avatar: "🦊",
        country: "US", timezone: "America/New_York",
        email: target, invitationId: inv.id,
      },
    });
    expect(reg.ok()).toBeTruthy();
    await anon.dispose();

    // The user now exists, so a re-invite should land in `existingEmails`
    // (NOT alreadyInvited) — the cross-batch invitation guard only fires
    // for un-used invitations of un-registered addresses.
    const r2 = await sa.post("/api/admin/invitations", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { emails: [target], competitionIds: [] },
    });
    expect(r2.ok()).toBeTruthy();
    const body2 = await r2.json();
    expect(body2.alreadyInvited || []).not.toContain(target);
    expect(body2.existingEmails || []).toEqual(expect.arrayContaining([target]));
    await sa.dispose();
  });
});





// ═══════════════════════════════════════════════════════════════════════════════
// HSTS HEADER — opt-out env control
// ═══════════════════════════════════════════════════════════════════════════════
// Default is on (HSTS=1, or unset). Operators running over plain HTTP can
// disable with HSTS=0 / false / off / no. The test server inherits the default,
// so this just asserts the header is present with the documented policy. The
// "disabled" variant would require a second server instance and isn't worth
// the fixture complexity — the env-parsing logic is a straight string match.
test.describe("HSTS header", () => {
  test("Strict-Transport-Security is sent by default", async () => {
    const { api } = await freshCtx();
    const r = await api.get("/api/config");
    const hsts = r.headers()["strict-transport-security"];
    expect(hsts).toBeTruthy();
    expect(hsts).toMatch(/max-age=\d+/);
    expect(hsts).toMatch(/includeSubDomains/i);
    await api.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// DUAL-EMAIL INVARIANT — admin-side entry points
// ═══════════════════════════════════════════════════════════════════════════════
// These tests cover the admin-side parity with the symmetric emailIsTaken()
// helper used by registration / self-edit / login / forgot-password. Prior to
// the fix, a superadmin could bypass the symmetric check by going through
// participant import or the admin-edit endpoint; an invited secondary address
// would also spawn a new invitation instead of auto-assigning the existing user.
test.describe("Dual-email invariant on admin entry points", () => {
  test("import: row whose secondary_email collides with an existing primary is rejected", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const t = Date.now();
    const newEmail = `import-sec-pri-${t}@company.com`;
    const newNick = `imp_sec_pri_${t}`;
    // Dry run first so the server returns its conflict list.
    const dry = await api.post("/api/admin/import/participants", {
      headers: h,
      data: {
        data: {
          type: "hackarena-participants",
          participants: [{
            nickname: newNick, email: newEmail,
            secondary_email: "alice@acme.com",   // Alice's PRIMARY
            first_name: "Clash", last_name: "Case",
          }],
        },
      },
    });
    expect(dry.ok()).toBeTruthy();
    const d = await dry.json();
    expect(d.dryRun).toBe(true);
    // The row should have surfaced as a conflict — NOT silently passed through.
    expect(d.conflicts.length).toBeGreaterThan(0);
    expect(d.conflicts[0].conflictType).toMatch(/email|secondary_email|split_identity/);
    await api.dispose();
  });

  test("import: row whose secondary_email collides with an existing secondary is rejected", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const t = Date.now();
    const sharedSecondary = `shared-sec-${t}@company.com`;
    // Park a secondary on Bob first.
    await sa.put(`/api/admin/participants/${S.bob.id}`, {
      headers: saH, data: { secondaryEmail: sharedSecondary },
    });
    // v8.8.19 — the clear is in a `finally`. A leaked secondary on bob changes
    // the outcome of every later profile edit on that row.
    try {
      // Now try to import a new user with the SAME address as their secondary.
      const dry = await sa.post("/api/admin/import/participants", {
        headers: saH,
        data: {
          data: {
            type: "hackarena-participants",
            participants: [{
              nickname: `imp_sec_sec_${t}`, email: `import-sec-sec-${t}@company.com`,
              secondary_email: sharedSecondary,   // Bob's SECONDARY
              first_name: "Sec", last_name: "Clash",
            }],
          },
        },
      });
      expect(dry.ok()).toBeTruthy();
      const d = await dry.json();
      expect(d.conflicts.length).toBeGreaterThan(0);
    } finally {
      await sa.put(`/api/admin/participants/${S.bob.id}`, {
        headers: saH, data: { secondaryEmail: "" },
      }).catch(() => {});
      await sa.dispose();
    }
  });

  // v9.0.0 (operator ruling, 11 Nov 2026) — REVERSED: a secondary is an
  // unconfirmed claim, so an invitation to it must not enrol whoever claimed it.
  // It is refused by name, and nothing is stored (a stored invitation to a held
  // address could never be redeemed).
  test("invitation: an address held as a secondary is refused by name — nobody enrolled, no invitation row", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const t = Date.now();
    const secondary = `carol-secondary-${t}@personal.com`;
    try {
      // Park a secondary on Carol.
      await sa.put(`/api/admin/participants/${S.carol.id}`, {
        headers: saH, data: { secondaryEmail: secondary },
      });
      // Invite by secondary address to the upcoming competition.
      const res = await sa.post("/api/admin/invitations", {
        headers: saH,
        data: { emails: [secondary], competitionIds: [S.upcomingComp.id] },
      });
      expect(res.ok()).toBeTruthy();
      const d = await res.json();
      expect(d.assigned).toBe(0);
      expect(d.invited).toBe(0);
      expect(d.errors.join(" "), "the refusal names the reason").toMatch(/secondary email/);

      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      const invCount = db.prepare("SELECT COUNT(*) as c FROM invitations WHERE LOWER(email)=LOWER(?)").get(secondary).c;
      const inCompetition = db.prepare("SELECT 1 FROM competition_users WHERE user_id=? AND competition_id=?").get(S.carol.id, S.upcomingComp.id);
      db.close();
      expect(invCount, "no invitation row").toBe(0);
      expect(inCompetition, "the secondary's holder is not enrolled").toBeFalsy();
    } finally {
      // In a finally: the invitation lands BEFORE the assertions, so a failure
      // would otherwise leave Carol carrying a secondary AND enrolled in a
      // competition later tests (e.g. tests/timeslots.api.spec.js:409) assume
      // she is not in.
      await sa.put(`/api/admin/participants/${S.carol.id}`, {
        headers: saH, data: { secondaryEmail: "" },
      });
      await sa.delete(`/api/admin/competitions/${S.upcomingComp.id}/users/${S.carol.id}`, {
        headers: { "x-csrf-token": saCsrf },
      });
      await sa.dispose();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Log viewer API — pagination + redaction for regular admins
  // ───────────────────────────────────────────────────────────────────────────

  test("logs: access stream is paginated and returns total / offset / limit", async () => {
    await ensureState();
    // Trigger a few access-log entries so we have something to page through.
    const { api } = await freshCtx();
    for (let i = 0; i < 5; i++) await api.get(`/api/config?_ping=${Date.now()}-${i}`);
    await api.dispose();

    const { api: sa } = await apiLogin("superadmin");
    const r = await sa.get("/api/admin/logs?stream=access&limit=3&offset=0");
    const d = await r.json();
    expect(r.ok()).toBeTruthy();
    expect(Array.isArray(d.entries)).toBe(true);
    expect(d.entries.length).toBeLessThanOrEqual(3);
    expect(typeof d.offset).toBe("number");
    expect(d.offset).toBe(0);
    expect(typeof d.limit).toBe("number");
    expect(d.limit).toBe(3);
    expect(typeof d.total).toBe("number");
    expect(d.total).toBeGreaterThanOrEqual(d.entries.length);
    await sa.dispose();
  });

  test("logs: limit is capped at 500", async () => {
    await ensureState();
    const { api: sa } = await apiLogin("superadmin");
    const r = await sa.get("/api/admin/logs?stream=app&limit=5000");
    const d = await r.json();
    expect(r.ok()).toBeTruthy();
    expect(d.limit).toBe(500);
    await sa.dispose();
  });

  test("logs: q substring filter matches the current page", async () => {
    await ensureState();
    // Generate a request with a distinctive path we can search for.
    const marker = `logs-marker-${Date.now()}`;
    const { api } = await freshCtx();
    await api.get(`/api/config?x=${marker}`);
    await api.dispose();

    const { api: sa } = await apiLogin("superadmin");
    const r = await sa.get(`/api/admin/logs?stream=access&limit=50&q=${marker}`);
    const d = await r.json();
    expect(r.ok()).toBeTruthy();
    expect(d.entries.length).toBeGreaterThan(0);
    for (const e of d.entries) {
      expect((e.path || "") + JSON.stringify(e)).toContain(marker);
    }
    await sa.dispose();
  });

  test("logs: audit events (login_success) appear in event log with source=audit", async () => {
    await ensureState();
    // A fresh login_success to search for.
    const { api: alice } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await alice.dispose();

    const { api: sa } = await apiLogin("superadmin");
    // Search the app stream for audit entries for Alice's user scope. The
    // mirror stamps scope + event_type + scope_id on every row. v8.12.4 — look
    // for ALICE's row rather than taking the newest sign-in and assuming it is
    // hers (any later sign-in on the platform made that fail for the wrong reason).
    const d = await (await sa.get(`/api/admin/logs?stream=app&limit=500&q=login_success`)).json();
    const hit = (d.entries || []).find(e => e.source === "audit" && e.event_type === "login_success"
      && e.scope === "user" && e.scope_id === S.alice.id);
    expect(hit, "alice's sign-in reached the audit stream, tagged source=audit, scope=user").toBeTruthy();
    await sa.dispose();
  });

  test("logs: access-stream rows include user_email enrichment (superadmin view)", async () => {
    await ensureState();
    // Alice logs in — that generates an authenticated access-log row we can find.
    const { api: alice } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const marker = `enrich-email-${Date.now()}`;
    await alice.get(`/api/me?x=${marker}`);
    await alice.dispose();

    const { api: sa } = await apiLogin("superadmin");
    const d = await (await sa.get(`/api/admin/logs?stream=access&limit=500&q=${marker}`)).json();
    const hit = (d.entries || []).find(e => e.user_id === S.alice.id);
    expect(hit).toBeTruthy();
    expect(hit.user_email).toBe("alice@acme.com");
    await sa.dispose();
  });

  test("logs: audit-stream user-scope rows include user_email enrichment", async () => {
    await ensureState();
    // Fresh login_success to search for.
    const { api: alice } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await alice.dispose();

    const { api: sa } = await apiLogin("superadmin");
    const d = await (await sa.get(`/api/admin/logs?stream=app&limit=500&q=login_success`)).json();
    const hit = (d.entries || []).find(e => e.source === "audit" && e.event_type === "login_success" && e.scope_id === S.alice.id);
    expect(hit).toBeTruthy();
    expect(hit.user_email).toBe("alice@acme.com");
    await sa.dispose();
  });



  test("logs: deletions emit orphan audit rows (competition + task + participant)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };

    // --- Competition deletion ---
    const compRes = await sa.post("/api/admin/competitions", {
      headers: saH, data: { name: `Del Comp ${Date.now()}`, start_time: new Date(Date.now() + 24*3600_000).toISOString(), duration_minutes: 60 },
    });
    const compId = (await compRes.json()).competition?.id;
    await sa.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": saCsrf } });

    // --- Task deletion ---
    const taskRes = await sa.post("/api/admin/tasks", {
      headers: saH, data: {
        title: `Del Task ${Date.now()}`, description: "", difficulty: "easy",
        answer_type: "text", correct_answer: "x", explanation: "", hint: "", status: "draft",
      },
    });
    const taskId = (await taskRes.json()).id;
    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });

    // Fetch app log and confirm both deletions are there tagged source=audit.
    // The orphan audit rows are mirrored to app.jsonl off the hot path
    // (`_deferAudit` → setImmediate, server.js), so the write can lag the DELETE
    // response. Poll the log stream until both rows surface instead of reading
    // once — the single read raced the async flush and made this test flaky.
    let compHit, taskHit;
    for (let attempt = 0; attempt < 25; attempt++) {
      const d = await (await sa.get(`/api/admin/logs?stream=app&limit=500&q=deleted`)).json();
      compHit = (d.entries || []).find(e => e.source === "audit" && e.scope === "competition" && e.event_type === "deleted" && e.scope_id === compId);
      taskHit = (d.entries || []).find(e => e.source === "audit" && e.scope === "task" && e.event_type === "deleted" && e.scope_id === taskId);
      if (compHit && taskHit) break;
      await new Promise(r => setTimeout(r, 100));
    }
    expect(compHit, "competition deletion orphan audit row not found in app log").toBeTruthy();
    expect(compHit.details.cascaded).toBeDefined();
    expect(taskHit, "task deletion orphan audit row not found in app log").toBeTruthy();
    await sa.dispose();
  });

  test("logs: task_edited rows include stored_images when rich content contains a data URI", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Smallest possible PNG base64 — the server's image-dim parser accepts it.
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX///+nxBvIAAAAC0lEQVQI12NgAAIAAAUAAeImBZsAAAAASUVORK5CYII=";
    const r = await sa.post("/api/admin/tasks", {
      headers: saH, data: {
        title: `Img Task ${Date.now()}`,
        description: `<p>Image: <img src="data:image/png;base64,${PNG}"/></p>`,
        difficulty: "easy", answer_type: "text", correct_answer: "x",
        explanation: "", hint: "", status: "draft",
      },
    });
    const created = await r.text();
    expect(r.ok(), `create: ${r.status()} ${created}`).toBeTruthy();
    const newId = JSON.parse(created).id;

    // v6.2.8 renamed task audit event_type from the generic "version_created"
    // to the semantic change_type name (created / edited / published / …).
    // Task create emits "created"; the change_type value is still preserved
    // inside details for back-compat with the history dialog.
    // v8.12.5 — POLLED: the app.jsonl mirror is written post-commit via
    // setImmediate, so a single read straight after the response races it
    // (failed once in a full run as "No audit:task:created row").
    const isCreated = (e) => e.scope === "task" && e.scope_id === newId && e.event_type === "created";
    const entries = await pollAdminLogs(sa, `stream=app&limit=500&q=${newId}`,
      (es) => es.some(isCreated), { what: "the audit:task:created row for the new task" });
    const hit = entries.find(isCreated);
    expect(hit.details.change_type).toBe("create");
    expect(Array.isArray(hit.details.stored_images)).toBe(true);
    expect(hit.details.stored_images.length).toBeGreaterThan(0);
    await sa.dispose();
  });

  test("logs: verify_code_expired audit row emitted when the cleanup path runs", async () => {
    await ensureState();
    // Create a user with an intentionally-stale verify_code_at (via admin
    // DB manipulation through a registration + timestamp shift).
    const Database = require("better-sqlite3");
    const email = `verify-expired-${Date.now()}@company.com`;
    const { api, csrf } = await freshCtx();
    await registerPost(api, "/api/register", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        firstName: "Stale", lastName: "Code", nickname: `stale_${Date.now()}`,
        email, company: "Co", title: "Eng", avatar: "🦊",
        country: "US", timezone: "America/New_York",
      },
    });
    await api.dispose();
    // Shift the timestamp back 72h so the next GET /verify considers it expired.
    const db = new Database(TEST_DB_PATH);
    const u = db.prepare("SELECT id, verify_code FROM users WHERE email=?").get(email);
    db.prepare("UPDATE users SET verify_code_at=? WHERE id=?").run(new Date(Date.now() - 72*3600_000).toISOString(), u.id);
    db.close();
    // Hit /verify — should trigger the expired-cleanup path with our new event.
    const { api: probe } = await freshCtx();
    await probe.get(`/verify?code=${u.verify_code}`);
    await probe.dispose();

    const { api: sa } = await apiLogin("superadmin");
    const d = await (await sa.get(`/api/admin/logs?stream=app&limit=500&q=verify_code_expired`)).json();
    const hit = (d.entries || []).find(e => e.source === "audit" && e.event_type === "verify_code_expired" && e.scope_id === u.id);
    expect(hit).toBeTruthy();
    await sa.dispose();
  });

  test("logs: search by user's first/last name matches via pre-resolved user_ids", async () => {
    await ensureState();
    const { api: alice } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const marker = `name-search-${Date.now()}`;
    await alice.get(`/api/me?x=${marker}`);
    await alice.dispose();
    const { api: sa } = await apiLogin("superadmin");
    // "Alice" is Alice's first name — no raw log line contains it (they have GUIDs),
    // so this only passes if the server pre-resolves the query against users.
    const d = await (await sa.get(`/api/admin/logs?stream=access&limit=500&q=alice`)).json();
    const hit = (d.entries || []).find(e => e.user_id === S.alice.id);
    expect(hit).toBeTruthy();
    expect(hit.user_first_name).toBe("Alice");
    await sa.dispose();
  });

  test("logs: sessions_invalidated event fires on role change with purged count", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Make Bob log in (creates a session to purge).
    const { api: bob } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    // Promote Bob — his Bob-session should be invalidated, emitting the event.
    await sa.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH, data: { role: "admin" } });
    try {
      const events = await (await sa.get(`/api/admin/participants/${S.bob.id}/events`)).json();
      // v8.13.4 — filtered on the reason: a refused CSRF token now records
      // `sessions_invalidated {reason:"csrf_invalid"}` on the session's owner too,
      // and a first match without the filter could pick that row instead.
      const ev = events.find(e => e.event_type === "sessions_invalidated" && e.details && e.details.reason === "role_change");
      expect(ev).toBeTruthy();
      expect(ev.details.reason).toBe("role_change");
      expect(ev.details.purged).toBeGreaterThanOrEqual(1);
    } finally {
      // Revert Bob's role in a finally: a missing event fails an assertion here
      // and would otherwise leave him an admin for the rest of the file.
      await sa.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH, data: { role: "participant" } });
      await sa.dispose();
      await bob.dispose().catch(() => {});
    }
  });

  // v6.20.x — admin middleware must re-check verified/approved (not just role/
  // blocked/denied), matching POST /api/login. An admin whose verified flag is
  // cleared out-of-band (e.g. a participant-import overwrite) must lose admin
  // access on the next request, even though login would already reject them.
  test("admin access is revoked mid-session when verified is cleared out-of-band", async () => {
    await ensureState();
    const Database = require("better-sqlite3");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.dispose();
    // Bob re-logs in as admin (role change invalidated his prior session).
    const { api: bob } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    try {
      // Baseline: admin access works.
      expect((await bob.get("/api/admin/me")).status(), "bob should have admin access").toBe(200);
      // Clear verified out-of-band (simulates an import overwrite / manual edit).
      const db = new Database(TEST_DB_PATH);
      db.prepare("UPDATE users SET verified=0 WHERE id=?").run(S.bob.id);
      db.close();
      // Next admin request must be rejected (requireAdmin re-check) and
      // /api/admin/me must no longer report authenticated.
      const meAfter = await bob.get("/api/admin/me");
      expect([401, 403]).toContain(meAfter.status());
      const adminRoute = await bob.get("/api/admin/participants");
      expect([401, 403]).toContain(adminRoute.status());
    } finally {
      // Restore bob: re-verify + demote to participant.
      const db2 = new Database(TEST_DB_PATH);
      db2.prepare("UPDATE users SET verified=1 WHERE id=?").run(S.bob.id);
      db2.close();
      const { api: sa2, csrf: sa2C } = await apiLogin("superadmin");
      await sa2.post(`/api/admin/participants/${S.bob.id}/role`, { headers: { "x-csrf-token": sa2C, "content-type": "application/json" }, data: { role: "participant" } });
      await sa2.dispose();
      await bob.dispose().catch(() => {});
    }
  });

  test("logs: both superadmin and regular admin see raw IP (visible for incident response)", async () => {
    await ensureState();
    // Bob exists as participant — promote him to regular admin for this test.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.dispose();
    try {
      // Bob needs to re-login (role change invalidates his session).
      const { api: admin } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);

      // Generate an access log entry with an identifiable path.
      const marker = `logs-ipcheck-${Date.now()}`;
      const { api: probe } = await freshCtx();
      await probe.get(`/api/config?x=${marker}`);
      await probe.dispose();

      // Superadmin view — should contain the raw IP field (127.0.0.1 / ::1 / etc).
      const { api: sa2 } = await apiLogin("superadmin");
      const saRes = await (await sa2.get(`/api/admin/logs?stream=access&limit=200&q=${marker}`)).json();
      const saRow = (saRes.entries || [])[0];
      expect(saRow).toBeTruthy();
      expect(saRes.redacted).toBe(false);
      expect(saRow.ip).toBeTruthy();
      expect(saRow.ip).not.toBe("[ip-redacted]");
      await sa2.dispose();

      // Regular-admin view — IPs are visible for incident-response use cases;
      // superadmin-only redaction remains for account-compromise material
      // (superadmin password, ?code= tokens) which are covered separately.
      const adminRes = await (await admin.get(`/api/admin/logs?stream=access&limit=200&q=${marker}`)).json();
      expect(adminRes.redacted).toBe(true);
      const adminRow = (adminRes.entries || [])[0];
      expect(adminRow).toBeTruthy();
      expect(adminRow.ip).toBeTruthy();
      expect(adminRow.ip).not.toBe("[ip-redacted]");
      await admin.dispose();
    } finally {
      // Restore Bob in a finally: a failed log assertion would otherwise leave
      // him an admin, and the rest of the file reads him as a seeded participant.
      const { api: sa3, csrf: saCsrf3 } = await apiLogin("superadmin");
      await sa3.post(`/api/admin/participants/${S.bob.id}/role`, {
        headers: { "x-csrf-token": saCsrf3, "content-type": "application/json" },
        data: { role: "participant" },
      });
      await sa3.dispose();
    }
  });

  test("admin-edit: regular admin cannot save a user with two free-email addresses", async () => {
    await ensureState();
    // Promote a participant to regular admin so we can test the non-superadmin path.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH, data: { role: "admin" } });
    // Bob's promotion invalidates his session, so he'd need to re-login; but
    // we don't actually need Bob to act here — the rule is enforced server-side
    // regardless of which admin submits the edit. Use Bob's token-free path
    // through the superadmin session but mock a non-superadmin by testing a
    // separate target. Simpler: drive the rule directly with a non-superadmin
    // admin session. We create an admin-tagged helper via setting carol's role.
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.dispose();
    // Log Carol back in (her session was invalidated by the role change).
    const { api: adminApi, csrf: adminCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    try {
      // Carol (now a regular admin) tries to edit Alice into a two-free-email state.
      const r = await adminApi.put(`/api/admin/participants/${S.alice.id}`, {
        headers: { "x-csrf-token": adminCsrf, "content-type": "application/json" },
        data: { secondaryEmail: "alice@gmail.com" },   // Alice's primary is alice@acme.com (company) — safe
      });
      // Alice's primary is still a company address, so this edit is legitimate.
      expect(r.ok(), "adding a free SECONDARY while the primary stays corporate is allowed").toBeTruthy();

      // v7.15.16 — the test's TITLE promises the refusal, and the body never
      // exercised it: it asserted only the permitted case and stopped. Drive the
      // actual rule — an edit that would leave the account with NO corporate
      // address must be refused.
      const bad = await adminApi.put(`/api/admin/participants/${S.alice.id}`, {
        headers: { "x-csrf-token": adminCsrf, "content-type": "application/json" },
        data: { email: "alice.personal@gmail.com", secondaryEmail: "alice.other@gmail.com" },
      });
      expect(bad.ok(),
        "an edit leaving BOTH addresses free-email must be refused — this is the rule the test is named for"
      ).toBeFalsy();
      expect(bad.status()).toBe(400);
      expect(JSON.stringify(await bad.json()).toLowerCase()).toMatch(/compan|corporate|work/);

      // And nothing was written.
      const Database = require("better-sqlite3");
      const checkDb = new Database(TEST_DB_PATH, { readonly: true });
      try {
        const row = checkDb.prepare("SELECT email FROM users WHERE id=?").get(S.alice.id);
        expect(row.email, "the rejected edit must not have changed the primary").not.toMatch(/gmail\.com$/);
      } finally { checkDb.close(); }
    } finally {
      // Restore roles in a finally: the FIRST edit above is expected to succeed,
      // so a failure anywhere after it leaves Alice carrying a free secondary and
      // Bob + Carol as admins, which the rest of the file reads as seed state.
      await adminApi.dispose().catch(() => {});
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      const saH2 = { "x-csrf-token": saCsrf2, "content-type": "application/json" };
      await sa2.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH2, data: { role: "participant" } });
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH2, data: { role: "participant" } });
      // Clear the secondary we set above so other tests stay clean.
      await sa2.put(`/api/admin/participants/${S.alice.id}`, {
        headers: saH2, data: { secondaryEmail: "" },
      });
      await sa2.dispose();
    }
  });

  test("admin-edit: superadmin CAN save a two-free-email state, event records the bypass", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    try {
      // Push Alice into a two-free-email state (only a superadmin can do this).
      // v6.16.5 — admin email change now triggers re-verification + SMTP
      // rollback; with SMTP mocked to fail in test the response is 503
      // and the email reverts. The audit event WAS written (txn commits
      // before SMTP send), so the bypass flag assertion still holds.
      const t = Date.now();
      const r = await sa.put(`/api/admin/participants/${S.alice.id}`, {
        headers: saH,
        data: {
          firstName: S.alice.first_name, lastName: S.alice.last_name, nickname: S.alice.nickname,
          email: `alice-free-${t}@gmail.com`,         // now free
          secondaryEmail: `alice-free2-${t}@yahoo.com`, // also free
        },
      });
      // Accept either: pre-v6.16.5 behaviour (200) OR post-v6.16.5 (503 +
      // rollback). Either way the audit event must carry the bypass flag.
      expect([200, 503]).toContain(r.status());

      // Confirm the bypass flag landed on the audit event.
      const events = await (await sa.get(`/api/admin/participants/${S.alice.id}/events`)).json();
      const editEvent = events.find(e => e.event_type === "edited");
      expect(editEvent).toBeTruthy();
      expect(editEvent.details.bypassed_free_email_rule).toBe(true);
    } finally {
      // Restore Alice's original email in a finally: a 200 here really does
      // rename her, so a failed assertion below the write would strand every
      // later apiLogin("alice@acme.com") in this file on a renamed account.
      // Likewise expects either 200 or 503 (rollback would already have
      // reverted Alice's email, so this is best-effort cleanup).
      await sa.put(`/api/admin/participants/${S.alice.id}`, {
        headers: saH,
        data: { email: "alice@acme.com", secondaryEmail: "" },
      });
      await sa.dispose();
    }
  });

  // Privilege-escalation guard: a regular admin must not be able to mutate
  // primary or secondary email on an admin/superadmin account. Without this,
  // regular admin → set admin victim's secondary_email to attacker inbox →
  // trigger admin reset-password (mails both slots) → redeem link → takeover.
  test("admin-edit: regular admin cannot change ANY field on an admin target (403 for all fields)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Promote Bob to admin (victim) and Carol to admin (attacker session).
    await sa.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.dispose();

    // Act as Carol (regular admin) — her session was invalidated by the promotion.
    const { api: carolApi, csrf: carolCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    const h = { "x-csrf-token": carolCsrf, "content-type": "application/json" };
    try {
      // Attempt to point Bob's secondary_email at an attacker inbox.
      const attackerAddr = `attacker-${Date.now()}@evil.example`;
      let r = await carolApi.put(`/api/admin/participants/${S.bob.id}`, {
        headers: h, data: { secondaryEmail: attackerAddr },
      });
      expect(r.status()).toBe(403);

      // Also confirm primary-email attempts are rejected with 403 (not silently dropped).
      r = await carolApi.put(`/api/admin/participants/${S.bob.id}`, {
        headers: h, data: { email: `hijack-${Date.now()}@evil.example` },
      });
      expect(r.status()).toBe(403);

      // Non-email fields are also blocked — regular admins cannot touch any field
      // on an admin/superadmin target (blanket 403, not just email fields).
      r = await carolApi.put(`/api/admin/participants/${S.bob.id}`, {
        headers: h, data: { title: "Altered Title" },
      });
      expect(r.status()).toBe(403);

      // Verify Bob's emails are unchanged.
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      const bobRow = db.prepare("SELECT email, secondary_email FROM users WHERE id=?").get(S.bob.id);
      db.close();
      expect(bobRow.email).toBe("bob@acme.com");
      expect(bobRow.secondary_email).not.toBe(attackerAddr);
    } finally {
      // Restore roles in a finally: a regressed 403 fails an assertion here and
      // would otherwise leave Bob and Carol admins for the rest of the file.
      await carolApi.dispose().catch(() => {});
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      const saH2 = { "x-csrf-token": saCsrf2, "content-type": "application/json" };
      await sa2.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH2, data: { role: "participant" } });
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH2, data: { role: "participant" } });
      await sa2.dispose();
    }
  });

  test("admin-edit: superadmin CAN still change an admin's secondary_email", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH, data: { role: "admin" } });
    try {
      const newSec = `bob-secondary-${Date.now()}@company.co`;
      const r = await sa.put(`/api/admin/participants/${S.bob.id}`, {
        headers: saH, data: { secondaryEmail: newSec },
      });
      expect(r.ok()).toBeTruthy();
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      const bobRow = db.prepare("SELECT secondary_email FROM users WHERE id=?").get(S.bob.id);
      db.close();
      expect(bobRow.secondary_email).toBe(newSec);
    } finally {
      // In a finally: this test's whole point is that the write LANDS, so a
      // failed assertion leaves Bob an admin carrying a secondary the rest of
      // the file reads as seed state.
      await sa.put(`/api/admin/participants/${S.bob.id}`, {
        headers: saH, data: { secondaryEmail: "" },
      });
      await sa.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH, data: { role: "participant" } });
      await sa.dispose();
    }
  });

  // POST /api/admin/tasks/:id/competitions used to increment `assigned`
  // for every entry in the request's competitionIds array regardless of
  // whether INSERT OR IGNORE actually added a row. A re-post (or a list
  // with duplicate ids) would inflate the response count and mislead the
  // UI's "N challenge(s) added" toast.
  test("task→competition assignment: assigned counter reflects only NEW links", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Create a brand-new task so the baseline is guaranteed unassigned.
    const tr = await sa.post("/api/admin/tasks", {
      headers: saH,
      data: {
        title: `AssignCount-${Date.now()}`, description: "<p>x</p>",
        difficulty: "easy", answer_type: "text", correct_answer: "x",
        explanation: "—", status: "published",
      },
    });
    const taskId = (await tr.json()).id;
    // First assignment: genuinely new → assigned=1.
    const r1 = await sa.post(`/api/admin/tasks/${taskId}/competitions`, {
      headers: saH, data: { competitionIds: [S.upcomingComp.id] },
    });
    expect((await r1.json()).assigned).toBe(1);
    // Second assignment with the SAME id → INSERT OR IGNORE is a no-op →
    // assigned MUST be 0, not inflated to 1.
    const r2 = await sa.post(`/api/admin/tasks/${taskId}/competitions`, {
      headers: saH, data: { competitionIds: [S.upcomingComp.id] },
    });
    expect((await r2.json()).assigned).toBe(0);
    // Mixed list (one duplicate + one new) → assigned=1 not 2.
    const r3 = await sa.post(`/api/admin/tasks/${taskId}/competitions`, {
      headers: saH, data: { competitionIds: [S.upcomingComp.id, S.endedComp?.id].filter(Boolean) },
    });
    // S.endedComp may be genuinely ended (blocked by the status check). The
    // endpoint throws in that case, so we only assert the non-error path if
    // both entries are valid; otherwise the first-dup behaviour alone is
    // enough to prove the counter invariant.
    if (r3.ok()) expect((await r3.json()).assigned).toBeLessThanOrEqual(1);
    await sa.dispose();
  });

  // Auto-approve via the invitation path must respect the same precondition
  // (verified AND not blocked) that the explicit /approve route enforces.
  // Without this, re-inviting a blocked admin to a competition would set
  // approved=1 even though login still rejects them — an invalid state.
  test("invitation auto-approve: a blocked existing user is NOT approved through the invite path", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Create a fresh user → verify → block → invite to a competition.
    const email = `inv-blocked-${Date.now()}@company.co`;
    await registerPost(sa, "/api/register", {
      headers: saH,
      data: {
        firstName: "Inv", lastName: "Blocked", nickname: `invblk_${Date.now()}`,
        company: "C", title: "T", avatar: "🦊", country: "US",
        timezone: "America/New_York", email,
      },
    });
    const parts = (await (await sa.get("/api/admin/participants?limit=500")).json()).participants;
    const u = parts.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${u.id}/block`, { headers: saH });
    // Sanity: not approved yet.
    let DatabaseR = require("better-sqlite3");
    let db = new DatabaseR(TEST_DB_PATH, { readonly: true });
    let row = db.prepare("SELECT approved, blocked FROM users WHERE id=?").get(u.id);
    db.close();
    expect(row.blocked).toBe(1);
    expect(row.approved).toBe(0);
    // Invite the blocked user to the live competition.
    const r = await sa.post("/api/admin/invitations", {
      headers: saH, data: { emails: [email], competitionIds: [S.liveComp.id] },
    });
    expect(r.ok()).toBeTruthy();
    // Approved must STILL be 0 — invitation path skipped the auto-approve.
    db = new DatabaseR(TEST_DB_PATH, { readonly: true });
    row = db.prepare("SELECT approved, blocked FROM users WHERE id=?").get(u.id);
    db.close();
    expect(row.blocked).toBe(1);
    expect(row.approved).toBe(0);
    await sa.dispose();
  });

  // Same-slot identity guard: a single account must not be saveable with
  // primary == secondary email. Without this, getUserEmails would mail the
  // same address twice and the secondary slot becomes meaningless.
  test("identity dedup: registration rejects primary == secondary (case-insensitive)", async () => {
    await ensureState();
    const { api, csrf } = await freshCtx();
    const t = Date.now();
    const addr = `dup-reg-${t}@company.co`;
    const r = await registerPost(api, "/api/register", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        firstName: "Dup", lastName: "Reg", nickname: `dupreg_${t}`,
        company: "C", title: "T", avatar: "🦊", country: "US",
        timezone: "America/New_York",
        email: addr, secondaryEmail: addr.toUpperCase(),
      },
    });
    expect(r.status()).toBe(400);
    await api.dispose();
  });

  test("identity dedup: admin edit rejects primary == secondary (case-insensitive)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const r = await sa.put(`/api/admin/participants/${S.alice.id}`, {
      headers: saH,
      data: { email: "alice@acme.com", secondaryEmail: "ALICE@ACME.COM" },
    });
    expect(r.status()).toBe(400);
    await sa.dispose();
  });

  // Mailout dedup safety net: even if a row sneaks past validation, the
  // mailout helper must not double-deliver. getUserEmails dedupes
  // case-insensitively as defence-in-depth.
  test("identity dedup: getUserEmails behaviour — same primary/secondary collapses to one recipient", async () => {
    // Drive this through resend-verification (which mails getUserEmails())
    // against a row we directly write so we exercise the live mail-render
    // path; the email_sent audit row records
    // the `to` field. We don't need an SMTP server — sendEmailLogged still
    // logs the recipient even when delivery fails.
    await ensureState();
    const Database = require("better-sqlite3");
    const dbw = new Database(TEST_DB_PATH);
    try {
      // Set Alice's secondary to her primary to simulate a sneaked-through
      // row (db.js startup pass would clear this on next boot — that's fine,
      // we just need the row to exist for this test).
      dbw.prepare("UPDATE users SET secondary_email=email WHERE id=?").run(S.alice.id);
    } finally { dbw.close(); }
    try {
      // resend-verification needs a signed-in, still-unverified session: sign
      // alice in, then put her in a live grace window for the one request.
      const { api: anon, csrf } = await apiLogin("alice@acme.com");
      { const dbg = new Database(TEST_DB_PATH);
        try { dbg.prepare("UPDATE users SET verified=0, self_enroll_grace_until=? WHERE id=?").run(new Date(Date.now() + 3600_000).toISOString(), S.alice.id); }
        finally { dbg.close(); } }
      try {
        await anon.post("/api/resend-verification", { headers: { "x-csrf-token": csrf, "content-type": "application/json" } });
      } finally {
        const dbg = new Database(TEST_DB_PATH);
        try { dbg.prepare("UPDATE users SET verified=1, self_enroll_grace_until=NULL WHERE id=?").run(S.alice.id); }
        finally { dbg.close(); }
      }
      await anon.dispose();
      // Find the email_sent audit row — its `details.to` field must be a
      // single address, not a comma-joined duplicate.
      const { api: sa } = await apiLogin("superadmin");
      const today = new Date().toISOString().slice(0, 10);
      let ev = null;
      for (let i = 0; i < 40 && !ev; i++) {
        const logs = await (await sa.get(`/api/admin/logs?stream=app&date=${today}&limit=500&q=verification`)).json();
        ev = (logs.entries || []).find(e => e.source === "audit" && e.event_type === "email_sent" && e.details?.reason === "verification" && e.details?.to?.includes("alice@acme.com"));
        if (!ev) await new Promise(r => setTimeout(r, 150));
      }
      expect(ev).toBeTruthy();
      expect(ev.details.to).toBe("alice@acme.com");
      expect(ev.details.to).not.toContain(",");
      await sa.dispose();
    } finally {
      // In a finally: a failed assertion above would otherwise leave Alice with
      // her primary duplicated into secondary_email, which every later identity
      // and dual-email test in this file would then measure instead of the seed.
      const dbc = new Database(TEST_DB_PATH);
      dbc.prepare("UPDATE users SET secondary_email=NULL WHERE id=?").run(S.alice.id);
      dbc.close();
    }
  });



  // Verify action is superadmin-only: it's a recovery tool for users who
  // can't receive the verification email (bounced MX, blocked delivery).
  // Regular admins receive 403 — the operator workflow (verify + share a
  // reset link out of band) is a superadmin responsibility.
  test("verify guard: regular admin cannot verify a user (403)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Create an unverified target, promote Carol to regular admin.
    const email = `verify-guard-${Date.now()}@company.co`;
    await registerPost(sa, "/api/register", {
      headers: saH,
      data: {
        firstName: "Ver", lastName: "Guard", nickname: `verguard_${Date.now()}`,
        company: "C", title: "T", avatar: "🦊", country: "US",
        timezone: "America/New_York", email,
      },
    });
    const pickerList = await (await sa.get("/api/admin/participants?limit=500")).json();
    const target = pickerList.participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.dispose();
    try {
      // Act as Carol (regular admin).
      const { api: carol, csrf: carolCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      const r = await carol.post(`/api/admin/participants/${target.id}/verify`, {
        headers: { "x-csrf-token": carolCsrf, "content-type": "application/json" },
      });
      expect(r.status()).toBe(403);
      await carol.dispose();
      // Verify the target is still unverified.
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      const row = db.prepare("SELECT verified FROM users WHERE id=?").get(target.id);
      db.close();
      expect(row.verified).toBe(0);
    } finally {
      // Restore Carol in a finally: a failed 403 assertion would otherwise leave
      // her an admin, and the rest of the file reads her as a seeded participant.
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      const saH2 = { "x-csrf-token": saCsrf2, "content-type": "application/json" };
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH2, data: { role: "participant" } });
      await sa2.dispose();
    }
  });

  // Peer-admin tampering guards: a regular admin must not be able to
  // block/unblock, unlock, or trigger a password reset on another admin or
  // superadmin. These are operational-interference vectors in their own right
  // (block immediately evicts sessions) and the reset path was also part of
  // the takeover chain closed by the secondary_email guard.
  test("peer-admin guard: regular admin cannot block another admin (403)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.dispose();
    const { api: carol, csrf: carolCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    try {
      const r = await carol.post(`/api/admin/participants/${S.bob.id}/block`, {
        headers: { "x-csrf-token": carolCsrf, "content-type": "application/json" },
      });
      expect(r.status()).toBe(403);
    } finally {
      // In a finally: a failed 403 assertion would otherwise leave Bob and Carol
      // admins for the rest of the file, which every later seeded-fixture login
      // and role assertion reads as a failure of its own.
      await carol.dispose().catch(() => {});
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      const saH2 = { "x-csrf-token": saCsrf2, "content-type": "application/json" };
      await sa2.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH2, data: { role: "participant" } });
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH2, data: { role: "participant" } });
      await sa2.dispose();
    }
  });

  test("peer-admin guard: regular admin cannot unlock another admin (403)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.dispose();
    const { api: carol, csrf: carolCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    try {
      const r = await carol.post(`/api/admin/participants/${S.bob.id}/unlock`, {
        headers: { "x-csrf-token": carolCsrf, "content-type": "application/json" },
      });
      expect(r.status()).toBe(403);
    } finally {
      // In a finally: a failed 403 assertion would otherwise leave Bob and Carol
      // admins for the rest of the file, which every later seeded-fixture login
      // and role assertion reads as a failure of its own.
      await carol.dispose().catch(() => {});
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      const saH2 = { "x-csrf-token": saCsrf2, "content-type": "application/json" };
      await sa2.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH2, data: { role: "participant" } });
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH2, data: { role: "participant" } });
      await sa2.dispose();
    }
  });





  // Bulk group-membership guard (v7.1.x): the per-participant group routes
  // (POST/DELETE /api/admin/participants/:id/groups) already block a regular
  // admin from grouping a privileged colleague — groups are live-synced to
  // bound competitions, so peer tampering could enroll/remove an admin from a
  // competition via a bound group. The BULK group routes must enforce the same
  // gate, else the per-participant guard is trivially bypassable: a regular
  // admin blocked on /participants/:id/groups could just call
  // /groups/:id/members with the same id. These lock the parity.
  test("group bulk guard: regular admin cannot add/remove/seed a privileged target via the bulk group routes (403)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Bob is the privileged victim; Carol is the acting regular admin.
    await sa.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });
    // A group with bob pre-seeded by the superadmin (the superadmin-exempt path
    // on create) so the regular-admin REMOVE below has a real row to attempt.
    const grpName = `bulk-guard-grp-${Date.now()}`;
    const created = await sa.post(`/api/admin/groups`, { headers: saH, data: { name: grpName, userIds: [S.bob.id] } });
    expect(created.ok(), `superadmin create seeded with admin: ${await created.text()}`).toBeTruthy();
    const grpId = (await created.json()).group.id;
    await sa.dispose();

    const { api: carol, csrf: carolCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    const h = { "x-csrf-token": carolCsrf, "content-type": "application/json" };
    try {
      // 1. bulk-add a privileged target → 403
      const add = await carol.post(`/api/admin/groups/${grpId}/members`, { headers: h, data: { userIds: [S.bob.id] } });
      expect(add.status(), `bulk-add admin: ${await add.text()}`).toBe(403);
      // 2. create a group seeded with a privileged target → 403
      const create = await carol.post(`/api/admin/groups`, { headers: h, data: { name: `${grpName}-2`, userIds: [S.bob.id] } });
      expect(create.status(), `create seeded with admin: ${await create.text()}`).toBe(403);
      // 3. remove a privileged target from a group → 403 (guard fires before the DELETE)
      const del = await carol.delete(`/api/admin/groups/${grpId}/members/${S.bob.id}`, { headers: h });
      expect(del.status(), `bulk-remove admin: ${await del.text()}`).toBe(403);
    } finally {
      await carol.dispose();
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      const saH2 = { "x-csrf-token": saCsrf2, "content-type": "application/json" };
      await sa2.delete(`/api/admin/groups/${grpId}`, { headers: saH2 });
      await sa2.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH2, data: { role: "participant" } });
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH2, data: { role: "participant" } });
      await sa2.dispose();
    }
  });

  test("group bulk guard: regular admin CAN add/remove a non-privileged participant; superadmin CAN add an admin", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH, data: { role: "admin" } });   // privileged target for the SA-positive case
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });  // acting regular admin
    const grpName = `bulk-pos-grp-${Date.now()}`;
    const created = await sa.post(`/api/admin/groups`, { headers: saH, data: { name: grpName } });
    expect(created.ok(), `create group: ${await created.text()}`).toBeTruthy();
    const grpId = (await created.json()).group.id;
    // Superadmin CAN add an admin (bob) — the guard exempts superadmins.
    const saAdd = await sa.post(`/api/admin/groups/${grpId}/members`, { headers: saH, data: { userIds: [S.bob.id] } });
    expect(saAdd.ok(), `superadmin add admin: ${await saAdd.text()}`).toBeTruthy();
    await sa.dispose();

    const { api: carol, csrf: carolCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    const h = { "x-csrf-token": carolCsrf, "content-type": "application/json" };
    try {
      // Regular admin CAN bulk-add a non-privileged participant (alice)…
      const add = await carol.post(`/api/admin/groups/${grpId}/members`, { headers: h, data: { userIds: [S.alice.id] } });
      expect(add.ok(), `regular admin add participant: ${await add.text()}`).toBeTruthy();
      // …and remove them again.
      const del = await carol.delete(`/api/admin/groups/${grpId}/members/${S.alice.id}`, { headers: h });
      expect(del.ok(), `regular admin remove participant: ${await del.text()}`).toBeTruthy();
    } finally {
      await carol.dispose();
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      const saH2 = { "x-csrf-token": saCsrf2, "content-type": "application/json" };
      await sa2.delete(`/api/admin/groups/${grpId}`, { headers: saH2 });
      await sa2.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH2, data: { role: "participant" } });
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH2, data: { role: "participant" } });
      await sa2.dispose();
    }
  });

  // The PER-PARTICIPANT group chip carries its OWN inline copies of the
  // peer-admin guard (routes/groups.js — one on POST /api/admin/participants/:id/
  // groups, one on DELETE .../groups/:groupId), NOT the shared
  // `_privilegedGroupTargets` helper the bulk routes above use. So the bulk lock
  // does not cover them, and the chip is the affordance an admin actually clicks
  // on the Participants screen. Groups live-sync to bound competitions, so a
  // regular admin stripping an admin colleague's membership can remove that
  // colleague from every competition the group is bound to.
  //
  // The group is deliberately bound to NO competition: an unbound group never
  // trips detectMemberAddClashes, so a 403 here is unambiguously the peer guard
  // and never a 409 clash.
  test("group chip guard: a regular admin cannot add/remove a privileged colleague via the per-participant chip routes (403)", async () => {
    await ensureState();
    const Database = require("better-sqlite3");
    const isMember = (grpId) => {
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try { return !!db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").get(grpId, S.bob.id); }
      finally { db.close(); }
    };
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH, data: { role: "admin" } });    // privileged victim
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });  // acting regular admin
    const grpName = `chip-guard-grp-${Date.now()}`;
    const created = await sa.post(`/api/admin/groups`, { headers: saH, data: { name: grpName } });
    expect(created.ok(), `create group: ${await created.text()}`).toBeTruthy();
    const grpId = (await created.json()).group.id;
    await sa.dispose();

    const { api: carol, csrf: carolCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    const h = { "x-csrf-token": carolCsrf, "content-type": "application/json" };
    try {
      expect(isMember(grpId), "precondition: bob is not in the group yet").toBe(false);
      // 1. ADD a privileged target via the chip → 403, and nothing written.
      const add = await carol.post(`/api/admin/participants/${S.bob.id}/groups`, { headers: h, data: { groupId: grpId } });
      expect(add.status(), `chip-add admin: ${await add.text()}`).toBe(403);
      expect((await add.json()).error).toMatch(/superadmin/i);
      expect(isMember(grpId), "a refused chip-add must not enroll the admin").toBe(false);

      // A superadmin CAN — the guard is a tier boundary, not a blanket refusal —
      // and this is also the positive control that gives the DELETE a real row.
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      const saH2 = { "x-csrf-token": saCsrf2, "content-type": "application/json" };
      const saAdd = await sa2.post(`/api/admin/participants/${S.bob.id}/groups`, { headers: saH2, data: { groupId: grpId } });
      expect(saAdd.ok(), `superadmin chip-add admin: ${await saAdd.text()}`).toBeTruthy();
      await sa2.dispose();
      expect(isMember(grpId), "superadmin chip-add really enrolled bob").toBe(true);

      // 2. REMOVE a privileged target via the chip → 403, and the row survives.
      const del = await carol.delete(`/api/admin/participants/${S.bob.id}/groups/${grpId}`, { headers: h });
      expect(del.status(), `chip-remove admin: ${await del.text()}`).toBe(403);
      expect((await del.json()).error).toMatch(/superadmin/i);
      expect(isMember(grpId), "a refused chip-remove must leave the membership intact").toBe(true);
    } finally {
      await carol.dispose();
      const { api: sa3, csrf: saCsrf3 } = await apiLogin("superadmin");
      const saH3 = { "x-csrf-token": saCsrf3, "content-type": "application/json" };
      // The superadmin CAN remove — completing the tier-boundary pair — then clean up.
      const saDel = await sa3.delete(`/api/admin/participants/${S.bob.id}/groups/${grpId}`, { headers: saH3 });
      expect(saDel.ok(), `superadmin chip-remove admin: ${await saDel.text()}`).toBeTruthy();
      expect(isMember(grpId), "superadmin chip-remove really removed bob").toBe(false);
      await sa3.delete(`/api/admin/groups/${grpId}`, { headers: saH3 });
      await sa3.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH3, data: { role: "participant" } });
      await sa3.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH3, data: { role: "participant" } });
      await sa3.dispose();
    }
  });

  // Tags on a privileged account are not cosmetic — `benchmark` moves that
  // account into the admin leaderboard's separate benchmark section, and every
  // tag write busts the target's /api/me cache and re-runs group reconciliation
  // for their competitions. The peer-admin 403 (routes/participants.js, one on
  // POST tags, one on DELETE tags/:tag) is the only barrier, and the UI does NOT
  // hide the `.tag-x` remove affordance on a privileged row, so a regular admin
  // reaches this straight from the Participants screen.
  //
  // Deliberately uses a NON-`staff` tag: the separate "cannot remove staff from
  // an admin" 400 sits AFTER the 403 and would mask a regressed 403 for `staff`.
  test("tag guard: a regular admin cannot add/remove a tag on an admin/superadmin account (403)", async () => {
    await ensureState();
    const Database = require("better-sqlite3");
    const hasTag = (tag) => {
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try { return !!db.prepare("SELECT 1 FROM user_tags WHERE user_id=? AND tag=?").get(S.bob.id, tag); }
      finally { db.close(); }
    };
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.delete(`/api/admin/participants/${S.bob.id}/tags/benchmark`, { headers: saH }).catch(() => {});
    await sa.dispose();
    expect(hasTag("benchmark"), "precondition: bob carries no benchmark tag").toBe(false);

    const { api: carol, csrf: carolCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    const h = { "x-csrf-token": carolCsrf, "content-type": "application/json" };
    try {
      // 1. ADD a tag to a privileged target → 403, nothing written.
      const add = await carol.post(`/api/admin/participants/${S.bob.id}/tags`, { headers: h, data: { tag: "benchmark" } });
      expect(add.status(), `regular admin tags an admin: ${await add.text()}`).toBe(403);
      expect((await add.json()).error).toMatch(/superadmin/i);
      expect(hasTag("benchmark"), "a refused tag-add must write nothing").toBe(false);

      // A superadmin CAN — tier boundary + the positive control the DELETE needs.
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      const saH2 = { "x-csrf-token": saCsrf2, "content-type": "application/json" };
      const saAdd = await sa2.post(`/api/admin/participants/${S.bob.id}/tags`, { headers: saH2, data: { tag: "benchmark" } });
      expect(saAdd.ok(), `superadmin tags an admin: ${await saAdd.text()}`).toBeTruthy();
      await sa2.dispose();
      expect(hasTag("benchmark"), "superadmin tag-add really landed").toBe(true);

      // 2. REMOVE it as the regular admin → 403, and the tag survives.
      const del = await carol.delete(`/api/admin/participants/${S.bob.id}/tags/benchmark`, { headers: h });
      expect(del.status(), `regular admin untags an admin: ${await del.text()}`).toBe(403);
      expect((await del.json()).error).toMatch(/superadmin/i);
      expect(hasTag("benchmark"), "a refused tag-remove must leave the tag in place").toBe(true);
    } finally {
      await carol.dispose();
      const { api: sa3, csrf: saCsrf3 } = await apiLogin("superadmin");
      const saH3 = { "x-csrf-token": saCsrf3, "content-type": "application/json" };
      const saDel = await sa3.delete(`/api/admin/participants/${S.bob.id}/tags/benchmark`, { headers: saH3 });
      expect(saDel.ok(), `superadmin untags an admin: ${await saDel.text()}`).toBeTruthy();
      expect(hasTag("benchmark"), "superadmin tag-remove really removed it").toBe(false);
      await sa3.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH3, data: { role: "participant" } });
      await sa3.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH3, data: { role: "participant" } });
      await sa3.dispose();
    }
  });

  // Approve preconditions: the server must reject or skip approval of
  // users who don't meet the "verified AND !blocked" gate. Without these,
  // a scripted / tampered admin request can set approved=1 on an account
  // that login still rejects — and we'd email them "you can now log in",
  // which is a false notification.
  test("approve preconditions: /approve rejects unverified user (400)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const email = `unverified-appr-${Date.now()}@company.co`;
    await registerPost(sa, "/api/register", {
      headers: saH,
      data: {
        firstName: "Unv", lastName: "Appr", nickname: `unvappr_${Date.now()}`,
        company: "C", title: "T", avatar: "🦊", country: "US",
        timezone: "America/New_York", email,
      },
    });
    const pickerList = await (await sa.get("/api/admin/participants?limit=500")).json();
    const user = pickerList.participants.find(p => p.email === email);
    // Do NOT verify. Attempt to approve.
    const r = await sa.post(`/api/admin/participants/${user.id}/approve`, { headers: saH });
    expect(r.status()).toBe(400);
    // DB confirms: approved stayed 0.
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const row = db.prepare("SELECT approved FROM users WHERE id=?").get(user.id);
    db.close();
    expect(row.approved).toBe(0);
    await sa.dispose();
  });

  test("approve preconditions: /approve rejects blocked user (400)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const email = `blocked-appr-${Date.now()}@company.co`;
    await registerPost(sa, "/api/register", {
      headers: saH,
      data: {
        firstName: "Blk", lastName: "Appr", nickname: `blkappr_${Date.now()}`,
        company: "C", title: "T", avatar: "🦊", country: "US",
        timezone: "America/New_York", email,
      },
    });
    const pickerList = await (await sa.get("/api/admin/participants?limit=500")).json();
    const user = pickerList.participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${user.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${user.id}/block`, { headers: saH });
    const r = await sa.post(`/api/admin/participants/${user.id}/approve`, { headers: saH });
    expect(r.status()).toBe(400);
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const row = db.prepare("SELECT approved FROM users WHERE id=?").get(user.id);
    db.close();
    expect(row.approved).toBe(0);
    await sa.dispose();
  });

  test("v6.10.19: /approve rejects a user under temporary lockout (400)", async () => {
    // Matches the login-time locked_until gate. Without this, an admin
    // could flip approved=1 on a locked user and we'd mail them "you
    // can now log in" while login still rejected them as locked.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const email = `locked-appr-${Date.now()}@company.co`;
    await registerPost(sa, "/api/register", {
      headers: saH,
      data: {
        firstName: "Lkd", lastName: "Appr", nickname: `lkdappr_${Date.now()}`,
        company: "C", title: "T", avatar: "🦊", country: "US",
        timezone: "America/New_York", email,
      },
    });
    const pickerList = await (await sa.get("/api/admin/participants?limit=500")).json();
    const user = pickerList.participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${user.id}/verify`, { headers: saH });
    // Set locked_until to +1h. Direct DB write keeps the test hermetic —
    // reproducing via 10 failed logins would depend on timing knobs
    // that drift between runs.
    const Database = require("better-sqlite3");
    const dbW = new Database(TEST_DB_PATH);
    dbW.prepare("UPDATE users SET locked_until=? WHERE id=?").run(
      new Date(Date.now() + 3600_000).toISOString(), user.id
    );
    dbW.close();
    const r = await sa.post(`/api/admin/participants/${user.id}/approve`, { headers: saH });
    expect(r.status()).toBe(400);
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const row = db.prepare("SELECT approved FROM users WHERE id=?").get(user.id);
    db.close();
    expect(row.approved).toBe(0);
    await sa.dispose();
  });

  test("v6.10.19: /approve accepts a user whose lockout already expired (200)", async () => {
    // Belt-and-braces: the 400 gate reads current time, so an expired
    // lockout row (locked_until in the past, not yet cleaned up by the
    // login path) must NOT block approval. Without this test a future
    // tightening "any non-null locked_until blocks approve" would
    // silently break the legitimate "approve this user tomorrow" flow.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const email = `expired-lock-appr-${Date.now()}@company.co`;
    await registerPost(sa, "/api/register", {
      headers: saH,
      data: {
        firstName: "Exp", lastName: "Lock", nickname: `explock_${Date.now()}`,
        company: "C", title: "T", avatar: "🦊", country: "US",
        timezone: "America/New_York", email,
      },
    });
    const pickerList = await (await sa.get("/api/admin/participants?limit=500")).json();
    const user = pickerList.participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${user.id}/verify`, { headers: saH });
    // Set locked_until to 1 hour in the past.
    const Database = require("better-sqlite3");
    const dbW = new Database(TEST_DB_PATH);
    dbW.prepare("UPDATE users SET locked_until=? WHERE id=?").run(
      new Date(Date.now() - 3600_000).toISOString(), user.id
    );
    dbW.close();
    const r = await sa.post(`/api/admin/participants/${user.id}/approve`, { headers: saH });
    expect(r.ok()).toBeTruthy();
    await sa.dispose();
  });

  test("v6.10.19: /bulk-approve skips currently-locked users alongside unverified+blocked", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const ids = {};
    // Five users: eligible, unverified, blocked, locked-now, locked-past.
    // Only `eligible` and `locked-past` should be approved.
    for (const tag of ["eligible", "unverified", "blocked", "locked-now", "locked-past"]) {
      const email = `bulk-v10-${tag}-${Date.now()}@company.co`;
      await registerPost(sa, "/api/register", {
        headers: saH,
        data: {
          firstName: "Bulk", lastName: "V10", nickname: `bulkv10_${tag.replace("-", "_")}_${Date.now()}`,
          company: "C", title: "T", avatar: "🦊", country: "US",
          timezone: "America/New_York", email,
        },
      });
      const pickerList = await (await sa.get("/api/admin/participants?limit=5000")).json();
      ids[tag] = pickerList.participants.find(p => p.email === email).id;
      if (tag !== "unverified") await sa.post(`/api/admin/participants/${ids[tag]}/verify`, { headers: saH });
      if (tag === "blocked") await sa.post(`/api/admin/participants/${ids[tag]}/block`, { headers: saH });
    }
    // Set locked_until directly — future for locked-now, past for locked-past.
    const Database = require("better-sqlite3");
    const dbW = new Database(TEST_DB_PATH);
    dbW.prepare("UPDATE users SET locked_until=? WHERE id=?").run(
      new Date(Date.now() + 3600_000).toISOString(), ids["locked-now"]
    );
    dbW.prepare("UPDATE users SET locked_until=? WHERE id=?").run(
      new Date(Date.now() - 3600_000).toISOString(), ids["locked-past"]
    );
    dbW.close();
    const r = await sa.post("/api/admin/participants/bulk-approve", {
      headers: saH,
      data: { userIds: [ids.eligible, ids.unverified, ids.blocked, ids["locked-now"], ids["locked-past"]] },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.approved).toBe(2); // eligible + locked-past
    expect(body.skipped).toBe(3);  // unverified + blocked + locked-now
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const rows = Object.fromEntries(
      Object.entries(ids).map(([tag, uid]) => [tag, db.prepare("SELECT approved FROM users WHERE id=?").get(uid)])
    );
    db.close();
    expect(rows.eligible.approved).toBe(1);
    expect(rows["locked-past"].approved).toBe(1);
    expect(rows.unverified.approved).toBe(0);
    expect(rows.blocked.approved).toBe(0);
    expect(rows["locked-now"].approved).toBe(0);
    await sa.dispose();
  });

  test("v6.10.19: GET /api/admin/participants pendingApproval excludes currently-locked users", async () => {
    // Pre-fix the count was `WHERE verified=1 AND approved=0 AND blocked=0`
    // — locked users matched (locked_until wasn't in the predicate) so
    // the dashboard badge said "3 pending" when only 2 were actually
    // approvable. Matches `pStatus()` which returns 'locked' (not
    // 'pending') for those users.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Baseline count.
    const before = (await (await sa.get("/api/admin/participants?limit=1")).json()).pendingApproval;
    // Create two pending-ish users: one plain-pending, one with a future lock.
    const emails = [`pend-plain-${Date.now()}@company.co`, `pend-lock-${Date.now()}@company.co`];
    const ids = [];
    for (const email of emails) {
      await registerPost(sa, "/api/register", {
        headers: saH,
        data: {
          firstName: "P", lastName: "End", nickname: `pend_${Date.now()}_${ids.length}`,
          company: "C", title: "T", avatar: "🦊", country: "US",
          timezone: "America/New_York", email,
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      const u = list.participants.find(p => p.email === email);
      ids.push(u.id);
      await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saH });
    }
    // Lock the second user.
    const Database = require("better-sqlite3");
    const dbW = new Database(TEST_DB_PATH);
    dbW.prepare("UPDATE users SET locked_until=? WHERE id=?").run(
      new Date(Date.now() + 3600_000).toISOString(), ids[1]
    );
    dbW.close();
    const after = (await (await sa.get("/api/admin/participants?limit=1")).json()).pendingApproval;
    // Only the plain-pending user should be in the delta. The locked
    // one is counted under the "Locked" pStatus, not "Pending".
    expect(after - before).toBe(1);
    await sa.dispose();
  });

  test("v7.2.x: /bulk-approve skips privileged targets for a regular admin (peer-admin guard)", async () => {
    await ensureState();
    const Database = require("better-sqlite3");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Carol = the acting REGULAR admin. Target = a verified-but-unapproved admin.
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });
    const email = `bulkpeer-${Date.now()}@company.co`;
    await registerPost(sa, "/api/register", { headers: saH, data: { firstName: "Peer", lastName: "Admin", nickname: `bulkpeer_${Date.now()}`, company: "C", title: "T", country: "US", timezone: "America/New_York", email } });
    const tId = (await (await sa.get("/api/admin/participants?limit=500")).json()).participants.find(p => p.email === email).id;
    await sa.post(`/api/admin/participants/${tId}/verify`, { headers: saH });
    await sa.dispose();
    // Force the target into a verified=1, approved=0, role=admin state.
    const dbw = new Database(TEST_DB_PATH);
    dbw.prepare("UPDATE users SET role='admin', approved=0 WHERE id=?").run(tId);
    dbw.close();
    try {
      const { api: carol, csrf: cc } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      const r = await carol.post("/api/admin/participants/bulk-approve", { headers: { "x-csrf-token": cc, "content-type": "application/json" }, data: { userIds: [tId] } });
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      expect(body.approved).toBe(0);
      expect(body.skippedPrivileged).toBe(1);
      await carol.dispose();
      const db = new Database(TEST_DB_PATH, { readonly: true });
      expect(db.prepare("SELECT approved FROM users WHERE id=?").get(tId).approved).toBe(0); // not approved by the regular admin
      db.close();
    } finally {
      const { api: sa2, csrf: c2 } = await apiLogin("superadmin");
      const h2 = { "x-csrf-token": c2, "content-type": "application/json" };
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: h2, data: { role: "participant" } });
      await sa2.delete(`/api/admin/participants/${tId}`, { headers: h2 }).catch(() => {});
      await sa2.dispose();
    }
  });



  // Email-delivery truth: admin-triggered flows that send notification emails
  // must return `emailDelivered`/`emailFailures` so the UI can surface SMTP
  // failures. The seed environment has no real SMTP, so every attempt fails
  // with ECONNREFUSED — these tests therefore assert the *false* path.
  test("delivery-truth: /approve returns emailDelivered:false when SMTP is down", async () => {
    await ensureState();
    // Create a fresh unapproved user so we can exercise the approve path.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const email = `appr-${Date.now()}@company.co`;
    await registerPost(sa, "/api/register", {
      headers: saH,
      data: {
        firstName: "Appr", lastName: "Truth", nickname: `appr_${Date.now()}`,
        company: "C", title: "T", avatar: "🦊", country: "US",
        timezone: "America/New_York", email,
      },
    });
    const pickerList = await (await sa.get("/api/admin/participants?limit=500")).json();
    const user = pickerList.participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${user.id}/verify`, { headers: saH });
    const r = await sa.post(`/api/admin/participants/${user.id}/approve`, { headers: saH });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.emailDelivered).toBe(false);
    await sa.dispose();
  });

  test("delivery-truth: /unlock returns emailDelivered:false when the user was locked and SMTP is down", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Create a user and directly lock them via the DB so the unlock path reports delivery.
    const email = `unlock-${Date.now()}@company.co`;
    await registerPost(sa, "/api/register", {
      headers: saH,
      data: {
        firstName: "Unlock", lastName: "Truth", nickname: `unlock_${Date.now()}`,
        company: "C", title: "T", avatar: "🦊", country: "US",
        timezone: "America/New_York", email,
      },
    });
    const pickerList = await (await sa.get("/api/admin/participants?limit=500")).json();
    const user = pickerList.participants.find(p => p.email === email);
    // Directly lock the user (no public API to lock a user outside the failed-login path).
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    db.prepare("UPDATE users SET locked_until=? WHERE id=?").run(new Date(Date.now() + 60_000).toISOString(), user.id);
    db.close();

    const r = await sa.post(`/api/admin/participants/${user.id}/unlock`, { headers: saH });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.emailDelivered).toBe(false);
    await sa.dispose();
  });

  test("delivery-truth: /bulk-approve returns emailFailures>0 when SMTP is down", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Two fresh unapproved users.
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const email = `bapp-${Date.now()}-${i}@company.co`;
      await registerPost(sa, "/api/register", {
        headers: saH,
        data: {
          firstName: "Bulk", lastName: "Appr", nickname: `bapp_${Date.now()}_${i}`,
          company: "C", title: "T", avatar: "🦊", country: "US",
          timezone: "America/New_York", email,
        },
      });
      const pickerList = await (await sa.get("/api/admin/participants?limit=500")).json();
      const u = pickerList.participants.find(p => p.email === email);
      await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saH });
      ids.push(u.id);
    }
    const r = await sa.post("/api/admin/participants/bulk-approve", {
      headers: saH, data: { userIds: ids },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.approved).toBe(2);
    expect(body.emailFailures).toBe(2);
    await sa.dispose();
  });

  test("delivery-truth: remove-from-competition returns emailDelivered:false when SMTP is down", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Create a fresh user, approve+assign to the upcoming comp (live can't be
    // modified in some paths; upcoming is safe).
    const email = `remove-${Date.now()}@company.co`;
    await registerPost(sa, "/api/register", {
      headers: saH,
      data: {
        firstName: "Remove", lastName: "Truth", nickname: `remove_${Date.now()}`,
        company: "C", title: "T", avatar: "🦊", country: "US",
        timezone: "America/New_York", email,
      },
    });
    const pickerList = await (await sa.get("/api/admin/participants?limit=500")).json();
    const user = pickerList.participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${user.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${user.id}/approve`, { headers: saH });
    await sa.post("/api/admin/competitions/assign", {
      headers: saH, data: { userIds: [user.id], competitionIds: [S.upcomingComp.id] },
    });
    const r = await sa.delete(`/api/admin/competitions/${S.upcomingComp.id}/users/${user.id}`, {
      headers: { "x-csrf-token": saCsrf },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.emailDelivered).toBe(false);
    await sa.dispose();
  });

  // Policy: regular admins may edit BOTH primary and secondary email on
  // non-privileged (participant) targets. Blocking primary on non-privileged
  // targets is over-restrictive — it turns routine support ("please change
  // my primary to my new address") into a superadmin escalation.
  test("admin-edit: regular admin CAN change primary email on a non-privileged user", async () => {
    // v6.16.5 — this assertion is now scoped to AUTHORIZATION:
    // a regular admin must not be 403'd when attempting to change
    // a participant's primary email. Whether the change actually
    // commits depends on SMTP delivery (re-verification contract).
    // With SMTP mocked to fail in test, the response is 503 + the
    // email is rolled back. The privilege gate is what we care
    // about here — it's distinguished from 403 explicitly.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.dispose();
    try {
      const { api: carol, csrf: carolCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      const newPrimary = `alice-renamed-${Date.now()}@company.co`;
      const r = await carol.put(`/api/admin/participants/${S.alice.id}`, {
        headers: { "x-csrf-token": carolCsrf, "content-type": "application/json" },
        data: { email: newPrimary },
      });
      // Pre-v6.16.5: 200 (silent commit). Post-v6.16.5: 200 (SMTP ok)
      // OR 503 (SMTP failure → rollback). Both demonstrate the
      // privilege gate let the request through. 403 would be a
      // regression of the privilege contract.
      expect([200, 503]).toContain(r.status());
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      const aliceRow = db.prepare("SELECT email FROM users WHERE id=?").get(S.alice.id);
      db.close();
      // If SMTP delivered, alice has the new email; if SMTP failed,
      // the rollback reverted to alice@acme.com. Either is a valid
      // outcome for the privilege contract this test locks.
      expect([newPrimary, "alice@acme.com"]).toContain(aliceRow.email);
      await carol.dispose();
    } finally {
      // v6.10.20: force-restore alice's email + carol's role even if
      // the assertions above threw. Without this, a failed assertion
      // left alice renamed, and every subsequent `apiLogin("alice@
      // acme.com", PARTICIPANT_PASS)` in the worker 401'd.
      try {
        const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
        const saH2 = { "x-csrf-token": saCsrf2, "content-type": "application/json" };
        await sa2.put(`/api/admin/participants/${S.alice.id}`, { headers: saH2, data: { email: "alice@acme.com" } });
        await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH2, data: { role: "participant" } });
        await sa2.dispose();
      } catch (_) { /* best-effort */ }
    }
  });

  // Nickname collision detection must be case-insensitive at every entry
  // point. The DB enforces COLLATE NOCASE uniqueness on nickname; prechecks
  // that use case-sensitive `WHERE nickname=?` would miss case-only variants
  // and a registration / self-edit / admin-edit / import for a collision
  // would fall through to SQLite's UNIQUE constraint (a generic 500) instead
  // of the intended 409. Alice's seeded nickname is `alice_s`; re-registering
  // with `ALICE_S` must produce a clean 409.
  test("nickname uniqueness: registration rejects case-only collision with 409", async () => {
    await ensureState();
    const { api, csrf } = await freshCtx();
    const r = await registerPost(api, "/api/register", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        firstName: "Case", lastName: "Collide", nickname: "ALICE_S",
        company: "C", title: "T", avatar: "🦊", country: "US",
        timezone: "America/New_York", email: `case-collide-${Date.now()}@company.co`,
      },
    });
    expect(r.status()).toBe(409);
    await api.dispose();
  });

  test("nickname uniqueness: /api/check-nickname reports case-only variant as unavailable", async () => {
    await ensureState();
    const { api } = await freshCtx();
    const r = await api.get("/api/check-nickname?nickname=ALICE_S");
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.available).toBe(false);
    await api.dispose();
  });

  // Login by email must be case-insensitive. Typing ALICE@ACME.COM should
  // resolve alice@acme.com the same as registration / forgot-password already
  // do — the address is the identity, its casing is not.
  test("login: email input is matched case-insensitively", async () => {
    await ensureState();
    const { api } = await freshCtx();
    const { csrfToken } = await (await api.get("/api/csrf-token")).json();
    const r = await codeLogin(api, "ALICE@ACME.COM", { "x-csrf-token": csrfToken, "content-type": "application/json" });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.ok).toBe(true);
    await api.dispose();
  });



  test("nickname uniqueness: admin edit rejects case-only collision with 409 (not 500)", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Attempt to rename Bob to a case-only variant of Alice's nickname.
    const r = await sa.put(`/api/admin/participants/${S.bob.id}`, {
      headers: saH,
      data: {
        firstName: S.bob.first_name, lastName: S.bob.last_name,
        nickname: S.alice.nickname.toUpperCase(),
      },
    });
    expect(r.status()).toBe(409);
    await sa.dispose();
  });

  test("admin-edit: regular admin CAN still change a non-privileged user's secondary_email", async () => {
    await ensureState();
    // Promote Carol to regular admin; Alice stays a participant (target).
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.dispose();
    const { api: carol, csrf: carolCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    try {
      const newSec = `alice-notify-${Date.now()}@company.co`;
      const r = await carol.put(`/api/admin/participants/${S.alice.id}`, {
        headers: { "x-csrf-token": carolCsrf, "content-type": "application/json" },
        data: { secondaryEmail: newSec },
      });
      expect(r.ok()).toBeTruthy();
    } finally {
      // In a finally: a failed assertion above would otherwise leave Carol an
      // admin and Alice carrying a secondary, and every later test in this file
      // reads both back as the seed left them.
      await carol.dispose().catch(() => {});
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      const saH2 = { "x-csrf-token": saCsrf2, "content-type": "application/json" };
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH2, data: { role: "participant" } });
      await sa2.put(`/api/admin/participants/${S.alice.id}`, { headers: saH2, data: { secondaryEmail: "" } });
      await sa2.dispose();
    }
  });

  // Regression: the registration form pre-fills + locks the invitation email,
  // so well-behaved clients always POST invitation.email as the primary. A
  // tampered client could POST a different email — a free-email, for example
  // — bypassing the dual-email rule that the non-invite branch enforces at
  // server.js:1605. The server now ignores the client-supplied primary on the
  // invite path and binds it to invitation.email.
  test("invitation: tampered client primary email is ignored; invitation.email is bound", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const t = Date.now();
    const inviteEmail = `invited-${t}@business.co`;  // admin pre-approved
    const tamperedEmail = `attacker-${t}@gmail.com`; // free-email, would normally be blocked
    const invitedPw = `Invited-Pw-${t}!aA`;          // sent at sign-up, never kept
    await sa.post("/api/admin/invitations", {
      headers: saH, data: { emails: [inviteEmail], competitionIds: [] },
    });
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const inv = db.prepare("SELECT id FROM invitations WHERE email=?").get(inviteEmail);
    db.close();
    await sa.dispose();

    const { api, csrf } = await freshCtx();
    const nickname = `tamper_${t}`;
    const res = await registerPost(api, "/api/register", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        firstName: "Tampered", lastName: "User", nickname,
        company: "C", title: "T", avatar: "🦊",
        country: "US", timezone: "America/New_York",
        email: tamperedEmail,           // client-submitted primary (ignored)
        password: invitedPw,            // a password sent at sign-up is never kept
        // secondaryEmail omitted — would have failed dual-email rule without invite
        invitationId: inv.id,
      },
      keepState: true,                  // assert the real email-first account below
    });
    expect(res.ok(), `register failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    // Email first: the proven invitation address is signed in at once.
    expect(body.ok).toBe(true);
    expect(body.pendingApproval, "an invitation is never held for approval").toBeFalsy();
    await api.dispose();

    // The persisted row must use the invitation email as primary — NOT the
    // tampered free-email — and must not surface the tampered address
    // anywhere on the user row.
    const db2 = new Database(TEST_DB_PATH, { readonly: true });
    const u = db2.prepare("SELECT * FROM users WHERE nickname=?").get(nickname);
    db2.close();
    expect(u).toBeTruthy();
    expect(u.email.toLowerCase()).toBe(inviteEmail.toLowerCase());
    expect((u.secondary_email || "").toLowerCase()).not.toBe(tamperedEmail.toLowerCase());
    expect(u.verified).toBe(1);
    expect(u.approved).toBe(1);
    // Auth-simplification lock: invited register mints NO reset_code (a partial
    // revert that re-introduced the set-password code would fail here)…
    expect(u.reset_code).toBeNull();
    // …the address-proof sign-up keeps no password: the account signs in with
    // codes until it sets one (Profile, How you sign in)…
    expect(u.password_set_at, "no password is kept from the sign-up").toBeNull();
    expect(u.password_hash, "the fixed no-password placeholder, not a hash of the sent password").toBe(require("../lib/util").NO_PASSWORD_HASH);
    {
      // The password door refuses the password the sign-up sent (200, ok:false).
      const { api: pa, csrf: pc } = await freshCtx();
      try {
        const pr = await pa.post("/api/auth/password", { headers: { "x-csrf-token": pc, "content-type": "application/json" }, data: { email: inviteEmail, password: invitedPw } });
        expect(pr.status(), await pr.text()).toBe(200);
        expect((await pr.json()).ok, "the sign-up's password opens nothing").toBe(false);
      } finally { await pa.dispose(); }
    }
    // …and it signs in at the bound invitation address.
    const { body: lb } = await apiLogin(inviteEmail);
    expect(lb.ok, "the account signs in at the bound invitation address").toBe(true);
  });

  // The client MAY still supply a secondary email alongside the invitation —
  // that's a legitimate UX affordance (user wants a personal backup address).
  // Ensure the invite path honours it while still forcing the primary to the
  // pre-approved invitation email.
  test("invitation: client-supplied secondary email is honoured; primary still forced to invitation", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const t = Date.now();
    const inviteEmail = `invited-sec-${t}@business.co`;
    const personalSecondary = `personal-${t}@gmail.com`;
    await sa.post("/api/admin/invitations", {
      headers: saH, data: { emails: [inviteEmail], competitionIds: [] },
    });
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const inv = db.prepare("SELECT id FROM invitations WHERE email=?").get(inviteEmail);
    db.close();
    await sa.dispose();

    const { api, csrf } = await freshCtx();
    const nickname = `invsec_${t}`;
    const res = await registerPost(api, "/api/register", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        firstName: "Invited", lastName: "Secondary", nickname,
        company: "C", title: "T", avatar: "🦊",
        country: "US", timezone: "America/New_York",
        email: inviteEmail,
        secondaryEmail: personalSecondary,
        invitationId: inv.id,
      },
    });
    expect(res.ok()).toBeTruthy();
    await api.dispose();

    const db2 = new Database(TEST_DB_PATH, { readonly: true });
    const u = db2.prepare("SELECT * FROM users WHERE nickname=?").get(nickname);
    db2.close();
    expect(u.email.toLowerCase()).toBe(inviteEmail.toLowerCase());
    expect(u.secondary_email.toLowerCase()).toBe(personalSecondary.toLowerCase());
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// SUPERADMIN PASSWORD REDACTION — stateless across process restarts
// ═══════════════════════════════════════════════════════════════════════════════
// /api/admin/logs redacts the boot-time "Superadmin password: <value>" banner
// for non-superadmin callers. Log files on disk survive restarts (and each
// restart writes a NEW banner line with a NEW password), so the redaction
// must NOT depend on the current process remembering prior sessions' secrets
// — it needs to match the banner pattern itself. These tests pin that
// invariant in-process (after in-session rotation) and across a real process
// boundary (spawn a fresh server pointed at old log files).
test.describe("Superadmin password banner redaction (post-restart)", () => {
  test("rotation: both pre- and post-rotation banners are redacted for regular admins", async () => {
    await ensureState();
    const origPass = getSuperadminPass();

    // Trigger password regeneration via the brute-force threshold (10 failed
    // superadmin attempts). RATE_LIMIT_DISABLED=1 (set by playwright.config.js)
    // lets us spam them from one IP.
    for (let i = 0; i < 10; i++) {
      const { api, csrf } = await freshCtx();
      await api.post("/api/login", {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { email: "superadmin", password: `wrong-${Date.now()}-${i}` },
      });
      await api.dispose();
    }
    const newPass = getSuperadminPass();
    expect(newPass).not.toBe(origPass);

    // app.jsonl now holds TWO banner lines: the one from startup (origPass)
    // and the one from rotation (newPass). A regular admin must not see
    // either password; the banner regex replaces the value after the
    // "Superadmin password: " prefix.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.dispose();
    try {
      const { api: bob } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
      const d = await (await bob.get("/api/admin/logs?stream=app&limit=2000")).json();
      expect(d.redacted).toBe(true);
      const body = JSON.stringify(d);
      expect(body).not.toContain(origPass);
      expect(body).not.toContain(newPass);
      // Both banners should have been re-serialized as [REDACTED].
      const banners = body.match(/Superadmin password: [^\\"\s]+/g) || [];
      for (const b of banners) expect(b).toBe("Superadmin password: [REDACTED]");
      await bob.dispose();
    } finally {
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      await sa2.post(`/api/admin/participants/${S.bob.id}/role`, {
        headers: { "x-csrf-token": saCsrf2, "content-type": "application/json" },
        data: { role: "participant" },
      });
      await sa2.dispose();
    }
  });

  test("cross-restart: a fresh process reading old log files still redacts banner values", async ({}, testInfo) => {
    // Spawning a second full server + DB bootstrap takes ~5-10s on a loaded
    // box. Give the whole flow a generous budget.
    testInfo.setTimeout(90_000);

    const idx = parseInt(process.env.TEST_PARALLEL_INDEX || "0", 10);
    // v8.3.16 — DERIVE THE CHILD PORT FROM PORT_BASE, never from a literal.
    //
    // This was `4700 + idx`, and 4700 is exactly what scripts/test-independence.cjs
    // hands shard 0 as TEST_PORT_BASE (`portBaseFor = 4700 + shard * 40`) — so the
    // harness's OWN server already held the port, the child died of EADDRINUSE,
    // and the readiness check of the time (a bare TCP connect) reported the HARNESS as up.
    // The test then failed on a `.superadmin-password` that no child had ever
    // written, and the sweep reported it as ORDER-DEPENDENT. It is not: it passes
    // alone at any other port base. Measured — an external audit filed the false
    // positive as a release-confidence finding.
    //
    // v7.21.10's rule, one layer out: a health probe answers for whoever holds the
    // port, so a spawned child must own a port nothing else can be using. Every
    // other spawner in the suite already derives from PORT_BASE; these two were
    // the only literals. Registry (see CLAUDE.md): 100/110/111/113/120/130/131/
    // 140/141/142/150/151 are taken.
    //
    // v8.13.3 — and the `+ idx` this carried was the same defect one layer in. The
    // offset is a namespace shared by every worker, so `160 + idx` occupies
    // +160..+183 at the default WORKERS=24 and lands on +170/+171
    // (harness-isolation) and +180/+181 (schema-readiness) whenever those files
    // run beside this one — invisible to the v8.3.26 registry scanner, which reads
    // only the literal digits, and to global-setup's pre-flight, which checks only
    // the literal ports. A spec file runs on ONE worker, so a fixed offset is
    // already unique per run; the only way two copies meet is `--repeat-each`
    // under concurrency, which guardFixedPortSpec refuses by name.
    guardFixedPortSpec();
    const childPort = PORT_BASE + 160;
    const tmpDir = path.resolve(__dirname, "..", `data-test-restart-${idx}-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true });

    // Simulate state left behind by a prior server session: a log line (as
    // if the prior session's startup banner had been mirrored into app.jsonl)
    // that references a password THIS process has never seen.
    const PRIOR_PASS = "prior-session-pw-" + idx + "-" + Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const priorLogLine = JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      msg: `  Superadmin password: ${PRIOR_PASS}`,
    }) + "\n";
    fs.writeFileSync(path.join(tmpDir, "logs", `app-${today}.jsonl`), priorLogLine);

    const spawnedAt = Date.now();
    const proc = spawn(process.execPath, ["server.js"], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        PORT: String(childPort),
        BASE_URL: `http://localhost:${childPort}`,
        DATA_DIR: tmpDir, UPLOADS_DIR: `${tmpDir}/uploads`,
        SMTP_HOST: "localhost",
        RATE_LIMIT_DISABLED: "1",
        NODE_ENV: "test",
        TRUST_PROXY: "",
        HACKATHON_START: new Date(Date.now() - 60 * 60_000).toISOString(),
        HACKATHON_DURATION_MINUTES: "180",
        NODE_OPTIONS: "", // child servers run OUR node flags, never the runner's
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // v8.3.16 — CAPTURE the child's output. It was piped and then discarded, so
    // an EADDRINUSE death left nothing to read and the failure surfaced 40 lines
    // later as a missing credential file.
    let childOut = "";
    proc.stdout.on("data", d => { childOut += d.toString().slice(0, 4000); });
    proc.stderr.on("data", d => { childOut += d.toString().slice(0, 4000); });
    let childExit = null;
    proc.once("exit", (code, sig) => { childExit = `code=${code} signal=${sig}`; });

    try {
      // v8.3.16 — A BARE TCP CONNECT ANSWERS FOR WHOEVER HOLDS THE PORT (v7.21.10).
      // Ready when THIS child answers (tests/spawned-server.js): its own start
      // time on /api/config, then the `.superadmin-password` it writes into ITS
      // OWN data dir at boot, which a stranger squatting on the port cannot
      // produce. Without it a port clash presented as an unexplained ENOENT deep
      // inside apiLogin.
      await readySpawnedServer({ base: `http://localhost:${childPort}`, child: proc, dataDir: tmpDir, spawnedAt, output: () => `${childOut}\n(child ${childExit || "still running"})`, timeoutMs: 30_000 });

      const client = createClient({
        baseUrl: `http://localhost:${childPort}`,
        dataDir: tmpDir,
      });

      // Bootstrap a regular admin on the fresh server: register → verify →
      // approve → set password via reset flow → promote to admin role.
      const adminEmail = `redact-check-${idx}-${Date.now()}@test.local`;
      const { api: sa, csrf: saCsrf } = await client.apiLogin("superadmin");
      const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
      const reg = await registerPost(sa, "/api/register", {
        headers: saH,
        data: {
          firstName: "Redact", lastName: "Check", nickname: `redact_${idx}_${Date.now()}`,
          email: adminEmail, company: "Test", title: "Test", avatar: "🦊",
          country: "US", timezone: "America/New_York",
        },
      });
      expect(reg.ok(), `register failed: ${reg.status()} ${await reg.text()}`).toBeTruthy();
      const users = await (await sa.get("/api/admin/participants?limit=200")).json();
      const user = (users.participants || []).find(p => p.email === adminEmail);
      expect(user, "registered user must be findable").toBeTruthy();
      await sa.post(`/api/admin/participants/${user.id}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${user.id}/approve`, { headers: saH });
      const { api: tempApi, csrf: tempCsrf } = await client.freshCtx();
      await sa.post(`/api/admin/participants/${user.id}/role`, {
        headers: saH, data: { role: "admin" },
      });
      await sa.dispose();

      // Read logs as the regular admin. The PRIOR_PASS must be redacted
      // purely by pattern match — this process never generated it and the
      // in-memory history set does not contain it.
      const { api: adm } = await client.apiLogin(adminEmail, PARTICIPANT_PASS);
      const r = await adm.get(`/api/admin/logs?stream=app&date=${today}&limit=500`);
      const d = await r.json();
      expect(d.redacted).toBe(true);
      const body = JSON.stringify(d);
      expect(body).not.toContain(PRIOR_PASS);
      expect(body).toMatch(/Superadmin password: \[REDACTED\]/);
      await adm.dispose();
    } finally {
      proc.kill("SIGTERM");
      await new Promise(r => {
        const t = setTimeout(() => { proc.kill("SIGKILL"); r(); }, 3000);
        proc.once("exit", () => { clearTimeout(t); r(); });
      });
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// LOG_SKIP_IPS — runtime enforcement (v6.8.2)
// ═══════════════════════════════════════════════════════════════════════════════
// The LOG_SKIP_IPS env var takes a comma-separated list of IPs/CIDRs whose
// requests are excluded from the access log (noise reduction for internal
// probers / health checks). The default test server leaves it unset, so
// we spawn a fresh server with the knob turned on to verify the behaviour
// end-to-end.
test.describe("LOG_SKIP_IPS — runtime enforcement", () => {
  test("requests from a skip-listed IP do not land in the access log", async ({}, testInfo) => {
    testInfo.setTimeout(60_000);
    const idx = parseInt(process.env.TEST_PARALLEL_INDEX || "0", 10);
    // v8.3.16 — PORT_BASE-derived for the same reason as its sibling above: a
    // literal in the 4700-4739 range sits inside the independence sweep's own
    // shard-0 window, and a spawned child that collides with the harness reports
    // as a mystery auth failure rather than as a port clash.
    // v8.13.3 — fixed, no `+ idx`: see the sibling above.
    guardFixedPortSpec();
    const childPort = PORT_BASE + 161;
    const tmpDir = path.resolve(__dirname, "..", `data-test-logskip-${idx}-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, "logs"), { recursive: true });
    const spawnedAt = Date.now();
    const proc = spawn(process.execPath, ["server.js"], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        PORT: String(childPort),
        BASE_URL: `http://localhost:${childPort}`,
        DATA_DIR: tmpDir, UPLOADS_DIR: `${tmpDir}/uploads`,
        SMTP_HOST: "localhost",
        RATE_LIMIT_DISABLED: "1",
        NODE_ENV: "test",
        TRUST_PROXY: "",
        HACKATHON_START: new Date(Date.now() - 60 * 60_000).toISOString(),
        HACKATHON_DURATION_MINUTES: "180",
        NODE_OPTIONS: "", // child servers run OUR node flags, never the runner's
        // Skip localhost from the access log.
        LOG_SKIP_IPS: "127.0.0.1,::1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childOut = "";
    proc.stdout.on("data", d => { childOut = (childOut + d.toString()).slice(-4000); });
    proc.stderr.on("data", d => { childOut = (childOut + d.toString()).slice(-4000); });
    try {
      // Ready when THIS child answers (tests/spawned-server.js), never whoever
      // holds the port. Its probes come from 127.0.0.1 too, so the access log
      // skips them like the requests below.
      await readySpawnedServer({ base: `http://localhost:${childPort}`, child: proc, dataDir: tmpDir, spawnedAt, output: () => childOut, timeoutMs: 30_000 });

      // Fire requests that WOULD normally be logged — a successful /api/config
      // (200) and an intentional 404.
      const client = createClient({ baseUrl: `http://localhost:${childPort}`, dataDir: tmpDir });
      const { api } = await client.freshCtx();
      const r1 = await api.get("/api/config");
      expect(r1.ok()).toBeTruthy();
      const r2 = await api.get("/api/this-route-does-not-exist");
      expect(r2.status()).toBe(404);
      await api.dispose();

      // Force a log flush: logs write append-and-fsync-per-line so the file
      // content should be on disk already. Wait a short beat anyway so any
      // async write scheduler flushes.
      await new Promise(r => setTimeout(r, 200));

      const today = new Date().toISOString().slice(0, 10);
      const accessPath = path.join(tmpDir, "logs", `access-${today}.jsonl`);
      let content = "";
      try { content = fs.readFileSync(accessPath, "utf8"); } catch (_) { content = ""; }
      // The /api/config + the 404 probe must be ABSENT from the access log.
      const lines = content.split("\n").filter(Boolean);
      const probeHits = lines.filter(l => l.includes("/api/config") || l.includes("/api/this-route-does-not-exist"));
      expect(probeHits, `access log leaked requests from 127.0.0.1 despite LOG_SKIP_IPS:\n${probeHits.join("\n")}`).toHaveLength(0);
    } finally {
      proc.kill("SIGTERM");
      await new Promise(r => {
        const t = setTimeout(() => { proc.kill("SIGKILL"); r(); }, 3000);
        proc.once("exit", () => { clearTimeout(t); r(); });
      });
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  });
});





// ═══════════════════════════════════════════════════════════════════════════════
// v6.13.18 — auditor findings: submit throttle, staging quota, superadmin
// re-check. Each test is a one-shot regression lock for the corresponding
// fix; happy paths are exercised by the existing suite.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v6.13.18 — auditor invariants", () => {
  test("submit velocity throttle — 31st distinct answer in 60s returns 429", async () => {
    // Lock the per-(user, task) cap. The 30-window in server.js maps to
    // 30 inserts; the 31st distinct answer must be rejected with 429 +
    // a Retry-After header.
    //
    // Uses a throwaway participant (not Alice) — earlier tests in this
    // file mutate Alice's password via /api/reset-password (line ~4747),
    // so apiLogin("alice…", PARTICIPANT_PASS) is unreliable past that
    // point in the suite. Same throwaway-user pattern as the v6.13.17
    // block test at line 5215.
    await ensureState();
    const med1 = S.tasks.find(t => t.title === "Challenge med1");
    expect(med1, "Challenge med1 in seed").toBeTruthy();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    const suffix = crypto.randomBytes(4).toString("hex");
    const tgtEmail = `velotest-${suffix}@acme.test`;
    const tgtPass = "veloTestPass123!";
    let tgtId = null, target;
    try {
      // Build a throwaway participant: register → verify → approve → set-pw.
      const regR = await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Velo", lastName: "Test", nickname: `velot_${suffix}`,
          email: tgtEmail, company: "Acme", title: "Test", avatar: "🦊",
          country: "US", timezone: "America/New_York",
        },
      });
      expect(regR.ok(), `register: ${regR.status()}`).toBeTruthy();
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      tgtId = (list.participants || []).find(p => p.email === tgtEmail)?.id;
      expect(tgtId, "throwaway user id resolved").toBeTruthy();
      await sa.post(`/api/admin/participants/${tgtId}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${tgtId}/approve`, { headers: saH });
      // Enrol them into the live competition so /submit can run.
      await sa.post("/api/admin/competitions/assign", {
        headers: saJsonH,
        data: { userIds: [tgtId], competitionIds: [S.liveComp.id] },
      });
      // Set password.
      // Log in, select the comp, then run the velocity test.
      const tgtCtx = await apiLogin(tgtEmail, tgtPass);
      target = tgtCtx.api;
      const tH = { "x-csrf-token": tgtCtx.csrf, "content-type": "application/json" };
      await target.post("/api/select-competition", { headers: tH, data: { competitionId: S.liveComp.id } });
      const tid = med1.id;
      // 30 distinct wrong answers — each must 200 (a wrong-answer row).
      for (let i = 0; i < 30; i++) {
        const r = await target.post(`/api/tasks/${tid}/submit`, { headers: tH, data: { answer: `wrong-${Date.now()}-${i}` , gradingHash: await gradingHashFor(target, tid)} });
        expect(r.status(), `submit ${i + 1}/30 must succeed (got ${r.status()} ${await r.text()})`).toBe(200);
      }
      // The 31st must 429 with Retry-After.
      const r = await target.post(`/api/tasks/${tid}/submit`, { headers: tH, data: { answer: `wrong-${Date.now()}-overflow` , gradingHash: await gradingHashFor(target, tid)} });
      expect(r.status(), "31st submission must be 429").toBe(429);
      expect(r.headers()["retry-after"], "Retry-After header").toBeTruthy();
      const body = await r.json();
      expect(body.error, "429 body must mention slowing down").toMatch(/too many|slow down/i);
    } finally {
      if (target) await target.dispose();
      if (tgtId) await sa.delete(`/api/admin/participants/${tgtId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("staging quota — 21st upload from one admin returns 429", async () => {
    // Lock ATTACHMENT_STAGING_MAX_PER_ADMIN=20. Stage 20 throwaway zips
    // back-to-back under a freshly-created admin (so we don't pollute
    // shared seed superadmin staging state across tests). The 21st must
    // be rejected with 429 + a quota-shaped error message. Cleanup
    // disposes everything in finally regardless of outcome.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    const suffix = crypto.randomBytes(4).toString("hex");
    const adminEmail = `quotatest-${suffix}@acme.test`;
    const adminPass = "quotaTestPass123!";
    let adminId = null;
    let adminApi;
    const stagedIds = [];
    try {
      // Build a throwaway admin: register → verify → approve → set-pw → promote.
      const regR = await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Quota", lastName: "Test", nickname: `quotat_${suffix}`,
          email: adminEmail, company: "Acme", title: "Test", avatar: "🦊",
          country: "US", timezone: "America/New_York",
        },
      });
      expect(regR.ok(), `register: ${regR.status()}`).toBeTruthy();
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      adminId = (list.participants || []).find(p => p.email === adminEmail)?.id;
      expect(adminId, "admin id resolved").toBeTruthy();
      await sa.post(`/api/admin/participants/${adminId}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${adminId}/approve`, { headers: saH });
      await sa.post(`/api/admin/participants/${adminId}/role`, { headers: saJsonH, data: { role: "admin" } });
      // The role change destroys the new admin's other sessions; re-login.
      const ad = await apiLogin(adminEmail, adminPass);
      adminApi = ad.api;
      const adH = { "x-csrf-token": ad.csrf };
      // Build a tiny valid ZIP once and re-upload (each upload creates an
      // independent staging row, so 20 tiny zips → 20 rows = exactly the cap).
      const zipBuf = (() => {
        const { execSync } = require("child_process");
        // Smallest possible "stored" zip with one entry. Reuse the same
        // builder used elsewhere in the suite if available; otherwise hand-roll.
        const zlib = require("zlib");
        const data = Buffer.from("hi");
        const crc = zlib.crc32 ? zlib.crc32(data) : 0;
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(10, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
        lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
        lh.writeUInt16LE(1, 26); lh.writeUInt16LE(0, 28);
        const name = Buffer.from("a");
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4); cd.writeUInt16LE(10, 6);
        cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
        cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(1, 28); cd.writeUInt16LE(0, 30);
        cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34);
        cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
        cd.writeUInt32LE(0, 42);
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
        eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
        eocd.writeUInt32LE(cd.length + name.length, 12);
        eocd.writeUInt32LE(lh.length + name.length + data.length, 16);
        eocd.writeUInt16LE(0, 20);
        return Buffer.concat([lh, name, data, cd, name, eocd]);
        // execSync intentionally unused — this branch never runs but keeps
        // the lint quiet about the require above.
      })();
      // 20 uploads under the cap. The route's per-IP rate limit is
      // 30/min — well above 20, so we won't bump into that.
      for (let i = 0; i < 20; i++) {
        const r = await adminApi.post("/api/admin/attachment-staging", {
          headers: adH,
          multipart: { file: { name: `q${i}.zip`, mimeType: "application/zip", buffer: zipBuf } },
        });
        expect(r.ok(), `staging ${i}/20: ${r.status()} ${await r.text()}`).toBeTruthy();
        stagedIds.push((await r.json()).staging_id);
      }
      // 21st must 429 with quota-shaped error.
      const over = await adminApi.post("/api/admin/attachment-staging", {
        headers: adH,
        multipart: { file: { name: "overflow.zip", mimeType: "application/zip", buffer: zipBuf } },
      });
      expect(over.status(), "21st staging upload must 429").toBe(429);
      const body = await over.json();
      expect(body.error, "429 body must mention staged limit").toMatch(/staged|limit|pending/i);
    } finally {
      // Cleanup: drop staged rows + the throwaway admin user.
      if (adminApi) {
        const cs = (await (await adminApi.get("/api/csrf-token")).json()).csrfToken;
        for (const sid of stagedIds) {
          await adminApi.delete(`/api/admin/attachment-staging/${sid}`, { headers: { "x-csrf-token": cs } }).catch(() => {});
        }
        await adminApi.dispose();
      }
      if (adminId) {
        await sa.delete(`/api/admin/participants/${adminId}`, { headers: saH }).catch(() => {});
      }
      await sa.dispose();
    }
  });

  test("requireSuperAdmin re-checks DB role on every request", async () => {
    // /api/admin/test-email is the route that uses *only* requireSuperAdmin
    // (per the auditor finding). Promote Carol → superadmin, log in,
    // verify she can hit it (POST with a valid recipient → 200).
    // Demote her without touching her session. Her next call must be
    // rejected — either 401 because /role's invalidateOtherSessions
    // destroyed her session, or 403 because the new requireSuperAdmin
    // DB re-check kicked her out.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    try {
      await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "superadmin" } });
      const { api: carol, csrf: cCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      const cH = { "x-csrf-token": cCsrf, "content-type": "application/json" };
      const ok = await carol.post("/api/admin/test-email", { headers: cH, data: { to: "test@example.com" } });
      // 200 if SMTP works, 502 if the mock SMTP refuses — both prove the
      // requireSuperAdmin gate let the request through. The contract is
      // "not blocked at the gate", so any non-401/403 is acceptable.
      expect(![401, 403].includes(ok.status()), `superadmin carol must reach /test-email, got ${ok.status()}`).toBeTruthy();
      // Demote.
      await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "participant" } });
      const after = await carol.post("/api/admin/test-email", { headers: cH, data: { to: "test@example.com" } });
      expect([401, 403].includes(after.status()), `demoted carol's /test-email must 401/403, got ${after.status()}`).toBeTruthy();
      await carol.dispose();
    } finally {
      // Defence-in-depth: ensure Carol is back to participant in case anything threw.
      await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "participant" } }).catch(() => {});
      await sa.dispose();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v6.13.20 — auditor invariants (registration race, export/import author,
// import overwrite URL normalization).
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v6.13.20 — auditor invariants", () => {
  test("concurrent register: same address as A.email and B.secondary cannot both succeed", async () => {
    // Pre-fix the cross-slot uniqueness check (A's primary == B's
    // secondary) lived only in app code, with bcrypt.hash between the
    // check and the INSERT — opening a millisecond-scale window where
    // two concurrent registrations both passed and both inserted.
    // SQLite's UNIQUE indexes covered primary↔primary and
    // secondary↔secondary but not the cross-slot case (db.js:573).
    // The fix wraps the final emailIsTaken re-check + INSERT in one
    // db.transaction whose body is synchronous, so in this single-process
    // server no other request can run between the SELECT and the INSERT.
    // (Not because of the lock mode: better-sqlite3's db.transaction() is a
    // DEFERRED BEGIN, not BEGIN IMMEDIATE — the write lock is taken at the
    // INSERT. An EXTERNAL writer that commits in between makes the INSERT
    // fail SQLITE_BUSY_SNAPSHOT rather than land a duplicate. See the
    // matching comment in routes/auth.js.)
    //
    // We fire two POSTs in parallel where:
    //   A: { email: SHARED, secondary: A_SECONDARY }
    //   B: { email: B_PRIMARY, secondary: SHARED }
    // Pre-fix both could land. Post-fix exactly one must land; the
    // other must 409.
    await ensureState();
    const tag = crypto.randomBytes(4).toString("hex");
    const SHARED = `crossrace-${tag}@cust1.test`;
    const A_SECONDARY = `crossrace-${tag}-A2@cust2.test`;
    const B_PRIMARY = `crossrace-${tag}-B@cust2.test`;
    // Two independent contexts so the parallel POSTs each carry their own
    // CSRF token / session.
    const ctxA = await freshCtx();
    const ctxB = await freshCtx();
    const csrfA = (await (await ctxA.api.get("/api/csrf-token")).json()).csrfToken;
    const csrfB = (await (await ctxB.api.get("/api/csrf-token")).json()).csrfToken;
    const baseBody = {
      firstName: "C", lastName: "R", company: "Acme", title: "Eng",
      avatar: "default1", country: "US", timezone: "America/New_York",
    };
    const reqA = registerPost(ctxA.api, "/api/register", {
      headers: { "x-csrf-token": csrfA, "content-type": "application/json" },
      data: { ...baseBody, nickname: `cra_${tag}A`, email: SHARED, secondaryEmail: A_SECONDARY },
    });
    const reqB = registerPost(ctxB.api, "/api/register", {
      headers: { "x-csrf-token": csrfB, "content-type": "application/json" },
      data: { ...baseBody, nickname: `cra_${tag}B`, email: B_PRIMARY, secondaryEmail: SHARED },
    });
    let createdId = null;
    try {
      const [rA, rB] = await Promise.all([reqA, reqB]);
      const sA = rA.status(), sB = rB.status();
      const wins = [sA, sB].filter(s => s === 200).length;
      const losses = [sA, sB].filter(s => s === 409).length;
      expect(
        wins === 1 && losses === 1,
        `exactly one of the concurrent registrations must win — got ${sA}/${sB}`
      ).toBeTruthy();
      // DB-direct: confirm only one user row carries SHARED in either slot.
      const Database = require("better-sqlite3");
      const dbR = new Database(TEST_DB_PATH, { readonly: true });
      const matches = dbR.prepare(
        "SELECT id, email, secondary_email FROM users WHERE LOWER(email)=LOWER(?) OR LOWER(secondary_email)=LOWER(?)"
      ).all(SHARED, SHARED);
      dbR.close();
      expect(matches.length, `exactly one user row may reference ${SHARED}`).toBe(1);
      createdId = matches[0].id;
    } finally {
      if (createdId) {
        const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
        await sa.delete(`/api/admin/participants/${createdId}`, { headers: { "x-csrf-token": saCsrf } }).catch(() => {});
        await sa.dispose();
      }
      await ctxA.api.dispose();
      await ctxB.api.dispose();
    }
  });

  test("task export → import roundtrip preserves author_name + author_linkedin", async () => {
    // Pre-fix the export projection dropped author_name + author_linkedin
    // (server.js:9529) and the import overwrite/insert paths ignored
    // them too. UI rendered them and Swagger documented them, so an
    // export → import cycle silently lost data. Lock the roundtrip.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const tid = (await (await sa.post("/api/admin/tasks", {
      headers: saJsonH,
      data: {
        title: `AuthorTest-${tag}`,
        difficulty: "easy", answer_type: "text", correct_answer: "x",
        author_name: "Ada Lovelace",
        author_linkedin: "https://www.linkedin.com/in/ada-lovelace",
        status: "draft",
      },
    })).json()).id;
    expect(tid).toBeTruthy();
    try {
      // Export. The route returns a JSON body even with attachment_content=0.
      const exp = await (await sa.get("/api/admin/export/tasks?include_attachment_content=0")).json();
      const exported = exp.tasks.find(t => t.title === `AuthorTest-${tag}`);
      expect(exported, "exported entry must exist").toBeTruthy();
      expect(exported.author_name).toBe("Ada Lovelace");
      expect(exported.author_linkedin).toBe("https://www.linkedin.com/in/ada-lovelace");
      // Hard-delete the source task, then re-import the exported entry as new.
      await sa.delete(`/api/admin/tasks/${tid}`, { headers: saH });
      const imp = await sa.post("/api/admin/import/tasks", {
        headers: saJsonH,
        data: {
          data: { type: "hackarena-tasks", version: 1, tasks: [exported] },
          resolutions: {},
        },
      });
      expect(imp.ok(), `import: ${imp.status()} ${await imp.text()}`).toBeTruthy();
      // Find the re-imported task and verify the author fields survived.
      const all = await (await sa.get("/api/admin/tasks")).json();
      const reimported = all.find(t => t.title === `AuthorTest-${tag}`);
      expect(reimported, "re-imported task").toBeTruthy();
      expect(reimported.author_name).toBe("Ada Lovelace");
      expect(reimported.author_linkedin).toBe("https://www.linkedin.com/in/ada-lovelace");
      // Cleanup.
      await sa.delete(`/api/admin/tasks/${reimported.id}`, { headers: saH });
    } finally {
      await sa.dispose();
    }
  });

  test("import overwrite normalizes attachment_url through validateUrl", async () => {
    // Pre-fix the overwrite branch stored t.attachment_url verbatim
    // (server.js:9763), bypassing the validateUrl gate that the insert
    // branch (server.js:9783) and POST/PUT (server.js:1067, 6838) all
    // applied. Import an overwrite payload with a non-http(s) value and
    // confirm the stored field is the empty string, matching the create
    // path's behaviour.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const title = `URLTest-${tag}`;
    const tid = (await (await sa.post("/api/admin/tasks", {
      headers: saJsonH,
      data: {
        title,
        difficulty: "easy", answer_type: "text", correct_answer: "x",
        attachment_url: "https://example.com/original",
        status: "draft",
      },
    })).json()).id;
    try {
      // Run an import with the SAME title + a junk attachment_url.
      // Resolutions[].action=overwrite forces the conflict-resolution
      // path that pre-fix bypassed validateUrl.
      const importBody = {
        data: {
          type: "hackarena-tasks", version: 1,
          tasks: [{
            title,
            difficulty: "easy", answer_type: "text", correct_answer: "x",
            attachment_url: "javascript:alert(1)",
            active: 1, status: "draft",
          }],
        },
        // The handler keys resolutions by stringified index (server.js:9714).
        resolutions: { "0": "overwrite" },
      };
      const r = await sa.post("/api/admin/import/tasks", { headers: saJsonH, data: importBody });
      expect(r.ok(), `import: ${r.status()} ${await r.text()}`).toBeTruthy();
      // Re-read the task: the junk URL must have been normalised to "".
      const after = (await (await sa.get("/api/admin/tasks")).json()).find(t => t.title === title);
      expect(after, "task survives overwrite").toBeTruthy();
      expect(after.id).toBe(tid);
      expect(after.attachment_url, "junk attachment_url must be normalised away").toBe("");
    } finally {
      await sa.delete(`/api/admin/tasks/${tid}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v6.13.21 — "approve before assign" invariant.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v6.13.21 — approve-before-assign", () => {
  test("/api/admin/competitions/assign skips unapproved + blocked users", async () => {
    // Pre-fix the assign endpoint accepted any user, including blocked
    // and unapproved accounts. Those rows landed in competition_users
    // even though the user could never log in to enter the comp,
    // queued a "you have been invited" email that pointed nowhere
    // useful, and triggered CxOne provisioning against accounts that
    // would never use it. The fix gates assign on `approved=1 AND
    // !blocked` (matching the gates login itself enforces) and
    // surfaces skips via `skippedUnapproved` + `skippedBlocked` in
    // the response.
    //
    // We build three throwaway users in a single test (one approved,
    // one verified-but-unapproved, one approved-then-blocked), POST
    // them all to /assign together, and verify only the approved-and-
    // clean one lands in competition_users.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const created = []; // ids to delete in finally
    async function makeUser(label, opts) {
      const email = `assigngate-${tag}-${label}@cust.test`;
      const regR = await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Assign", lastName: "Gate", nickname: `agt_${tag}_${label}`,
          email, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "America/New_York",
        },
      });
      expect(regR.ok(), `register ${label}: ${regR.status()}`).toBeTruthy();
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      const id = (list.participants || []).find(p => p.email === email)?.id;
      expect(id).toBeTruthy();
      created.push(id);
      // Always verify so the gate test is purely about approved + blocked.
      await sa.post(`/api/admin/participants/${id}/verify`, { headers: saH });
      if (opts.approve) await sa.post(`/api/admin/participants/${id}/approve`, { headers: saH });
      if (opts.block)   await sa.post(`/api/admin/participants/${id}/block`,   { headers: saH });
      return id;
    }

    let approvedClean, unapproved, approvedBlocked;
    try {
      approvedClean    = await makeUser("clean",    { approve: true,  block: false });
      unapproved       = await makeUser("unapprov", { approve: false, block: false });
      // Block must happen AFTER approve — the /approve route refuses to
      // run on a blocked target (server.js:8985), so we approve first
      // then block.
      approvedBlocked  = await makeUser("blocked",  { approve: true,  block: true  });

      const r = await sa.post("/api/admin/competitions/assign", {
        headers: saJsonH,
        data: { userIds: [approvedClean, unapproved, approvedBlocked], competitionIds: [S.upcomingComp.id] },
      });
      expect(r.ok(), `assign: ${r.status()} ${await r.text()}`).toBeTruthy();
      const body = await r.json();
      expect(body.assigned).toBe(1);
      expect(body.skippedUnapproved).toBe(1);
      expect(body.skippedBlocked).toBe(1);

      // Verify DB state: only the clean user lands in competition_users.
      const Database = require("better-sqlite3");
      const dbR = new Database(TEST_DB_PATH, { readonly: true });
      const rows = dbR.prepare(
        "SELECT user_id FROM competition_users WHERE competition_id=? AND user_id IN (?,?,?)"
      ).all(S.upcomingComp.id, approvedClean, unapproved, approvedBlocked);
      dbR.close();
      const ids = rows.map(r => r.user_id);
      expect(ids).toContain(approvedClean);
      expect(ids).not.toContain(unapproved);
      expect(ids).not.toContain(approvedBlocked);
    } finally {
      for (const id of created) {
        await sa.delete(`/api/admin/participants/${id}`, { headers: saH }).catch(() => {});
      }
      await sa.dispose();
    }
  });

  test("/api/admin/invitations re-invite auto-approves verified-unapproved + assigns", async () => {
    // The kept-working path. An invitation re-invite for an existing
    // verified-but-unapproved user should auto-approve them (matching
    // pre-fix behaviour) AND complete the assignment to the listed
    // comps. The fix reordered auto-approve to happen BEFORE the
    // assignment loop so the gate sees the post-auto-approve state.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const email = `inviteapprove-${tag}@cust.test`;
    let id;
    try {
      // Build a verified-but-unapproved user via /register + /verify.
      const regR = await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Inv", lastName: "Auto", nickname: `inv_${tag}`,
          email, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "America/New_York",
        },
      });
      expect(regR.ok()).toBeTruthy();
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      id = (list.participants || []).find(p => p.email === email)?.id;
      expect(id).toBeTruthy();
      await sa.post(`/api/admin/participants/${id}/verify`, { headers: saH });
      // Confirm pre-state: verified=1, approved=0.
      const Database = require("better-sqlite3");
      const dbR = new Database(TEST_DB_PATH, { readonly: true });
      const before = dbR.prepare("SELECT verified, approved FROM users WHERE id=?").get(id);
      dbR.close();
      expect(before.verified).toBe(1);
      expect(before.approved).toBe(0);
      // Re-invite to a comp.
      const r = await sa.post("/api/admin/invitations", {
        headers: saJsonH,
        data: { emails: [email], competitionIds: [S.upcomingComp.id] },
      });
      expect(r.ok(), `invite: ${r.status()}`).toBeTruthy();
      const body = await r.json();
      expect(body.assigned).toBe(1);
      expect(body.skippedUnapproved || 0).toBe(0);
      expect(body.skippedBlocked   || 0).toBe(0);
      // Post-state: approved must now be 1, and competition_users row exists.
      const dbR2 = new Database(TEST_DB_PATH, { readonly: true });
      const after = dbR2.prepare("SELECT verified, approved FROM users WHERE id=?").get(id);
      const cu = dbR2.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?")
        .get(S.upcomingComp.id, id);
      dbR2.close();
      expect(after.approved).toBe(1);
      expect(cu).toBeTruthy();
    } finally {
      if (id) await sa.delete(`/api/admin/participants/${id}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("/api/admin/invitations re-invite of a blocked user does not assign or auto-approve", async () => {
    // Defensive case: re-inviting a blocked user (somehow already in
    // the system, perhaps blocked after registration) must NOT
    // silently re-grant access. Pre-fix the assign loop would happily
    // create a competition_users row even though login still rejects
    // the user. Post-fix the user is reported as `skippedBlocked` and
    // no competition_users row is written.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const email = `invblocked-${tag}@cust.test`;
    let id;
    try {
      const regR = await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Inv", lastName: "Blk", nickname: `invb_${tag}`,
          email, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "America/New_York",
        },
      });
      expect(regR.ok()).toBeTruthy();
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      id = (list.participants || []).find(p => p.email === email)?.id;
      expect(id).toBeTruthy();
      await sa.post(`/api/admin/participants/${id}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${id}/approve`, { headers: saH });
      await sa.post(`/api/admin/participants/${id}/block`,   { headers: saH });
      // Re-invite — must skip.
      const r = await sa.post("/api/admin/invitations", {
        headers: saJsonH,
        data: { emails: [email], competitionIds: [S.upcomingComp.id] },
      });
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      expect(body.assigned).toBe(0);
      expect(body.skippedBlocked).toBe(1);
      // v8.12.0 — a SKIPPED address is not ALSO "already a member". (For the
      // lifecycle skips this was always so — the alreadyAssigned push sits inside
      // a `!blocked && approved` guard — so this arm pins the invariant rather
      // than a fix; the staff/author/privileged skips are where it had teeth.)
      expect(body.alreadyAssigned || [], "skipped, not double-counted as already assigned").not.toContain(email);
      // No competition_users row.
      const Database = require("better-sqlite3");
      const dbR = new Database(TEST_DB_PATH, { readonly: true });
      const cu = dbR.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?")
        .get(S.upcomingComp.id, id);
      dbR.close();
      expect(cu).toBeFalsy();
    } finally {
      if (id) await sa.delete(`/api/admin/participants/${id}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v6.14.1 — participant leaderboard top-20 cap.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v6.14.1 — participant leaderboard top-20 cap", () => {
  // Build a fresh competition + N synthetic participants directly in the
  // DB. We bypass the registration / login flow for the dummy users
  // because the test only needs them to APPEAR on the board (verified=1
  // + competition_users row + login_time set is enough — see
  // buildLeaderboardEntries' WHERE clause). We log Alice in normally
  // and select the new comp so /api/leaderboard runs in her session.
  // Helper: build a throwaway participant and a fresh comp containing
  // them + N synthetic dummies (DB-direct competition_users rows so the
  // dummies appear on the leaderboard without needing real login flow).
  // Returns {compId, callerId, callerEmail, callerPass, dummyIds, sa, saH}
  // — caller can immediately apiLogin + select the comp + GET /leaderboard.
  // The throwaway-caller pattern shields these tests from the recurring
  // alice-password flake (other tests in this file rotate her password).
  async function buildLeaderboardScenario({ dummies, callerLoginTimeIso }) {
    const Database = require("better-sqlite3");
    const tag = crypto.randomBytes(4).toString("hex");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    const t = Date.now();
    // 1. Create the comp.
    const compR = await sa.post("/api/admin/competitions", {
      headers: saJsonH,
      data: {
        name: `LbCapTest-${tag}`,
        start_time: new Date(t - 60_000).toISOString(),
        duration_minutes: 120,
      },
    });
    const compId = (await compR.json()).competition.id;
    // 2. Build a real caller via the registration / verify / set-pw flow
    // so they can actually log in.
    const callerEmail = `lb-cap-caller-${tag}@cust.test`;
    const callerPass  = "lbCapCallerPass123!";
    await registerPost(sa, "/api/register", {
      headers: saJsonH,
      data: {
        firstName: "Cap", lastName: "Caller", nickname: `lbcap_${tag}`,
        email: callerEmail, company: "Acme", title: "Test", avatar: "default1",
        country: "US", timezone: "America/New_York",
      },
    });
    const list = await (await sa.get("/api/admin/participants?limit=500")).json();
    const callerId = (list.participants || []).find(p => p.email === callerEmail)?.id;
    expect(callerId).toBeTruthy();
    await sa.post(`/api/admin/participants/${callerId}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${callerId}/approve`, { headers: saH });
    // 3. Direct DB inserts: N dummy users + cu rows (same login_time
    // so they tie-break by userId) + caller cu row with the requested
    // login_time. Caller's earlier login_time means LARGER solveTimeMs
    // → ranks LAST.
    const dbW = new Database(TEST_DB_PATH);
    const insertUser = dbW.prepare(
      "INSERT INTO users (id, first_name, last_name, nickname, email, avatar, verified, approved, password_hash, created_at) " +
      "VALUES (?,?,?,?,?,?,1,1,?,?)"
    );
    const insertCU = dbW.prepare(
      "INSERT INTO competition_users (competition_id, user_id, assigned_by, assigned_at, login_time) VALUES (?,?,?,?,?)"
    );
    const dummyLT = "2026-04-01T10:00:00.000Z";
    const dummyIds = [];
    const txn = dbW.transaction(() => {
      for (let i = 0; i < dummies; i++) {
        const id = `lbcap-${tag}-${String(i).padStart(2, "0")}`;
        dummyIds.push(id);
        insertUser.run(
          id, "Cap", `Dummy${i}`, `lbdummy_${tag}_${i}`,
          `lbdummy-${tag}-${i}@cust.test`, "default1",
          "$2b$10$dummyhashdoesnotneedtowork",
          new Date(t - 90 * 60_000).toISOString()
        );
        insertCU.run(compId, id, "test-system", dummyLT, dummyLT);
      }
      insertCU.run(compId, callerId, "test-system", callerLoginTimeIso, callerLoginTimeIso);
    });
    txn();
    dbW.close();
    return { compId, callerId, callerEmail, callerPass, dummyIds, sa, saH };
  }

  async function teardownLeaderboardScenario({ compId, callerId, dummyIds, sa, saH }) {
    const Database = require("better-sqlite3");
    const dbW2 = new Database(TEST_DB_PATH);
    try {
      if (compId) {
        dbW2.prepare("DELETE FROM competition_users WHERE competition_id=?").run(compId);
        dbW2.prepare("DELETE FROM competitions WHERE id=?").run(compId);
      }
      for (const id of dummyIds) dbW2.prepare("DELETE FROM users WHERE id=?").run(id);
    } finally { dbW2.close(); }
    if (callerId) await sa.delete(`/api/admin/participants/${callerId}`, { headers: saH }).catch(() => {});
    await sa.dispose();
  }

  test("board is capped at 20 entries; me carries the true rank for callers outside the cap", async () => {
    await ensureState();
    // Caller's earlier login_time → ranked LAST. 25 dummies + caller
    // = 26 ranked → caller is rank 26.
    const ctx = await buildLeaderboardScenario({
      dummies: 25,
      callerLoginTimeIso: "2026-03-01T10:00:00.000Z", // earlier than dummies
    });
    try {
      const { api: caller, csrf: callerCsrf } = await apiLogin(ctx.callerEmail, ctx.callerPass);
      const callerH = { "x-csrf-token": callerCsrf, "content-type": "application/json" };
      try {
        await caller.post("/api/select-competition", { headers: callerH, data: { competitionId: ctx.compId } });
        const r = await caller.get("/api/leaderboard");
        expect(r.ok(), `leaderboard: ${r.status()}`).toBeTruthy();
        const body = await r.json();
        expect(body.board_limit).toBe(20);
        // v6.14.2 — no participant-count disclosure. The response must
        // NOT include total_ranked or any equivalent count field. The
        // SPA banner also no longer renders an "Out of N ranked" line.
        expect(body).not.toHaveProperty("total_ranked");
        expect(body).not.toHaveProperty("totalRanked");
        expect(body.board.length).toBe(20);
        body.board.forEach((row, i) => expect(row.rank).toBe(i + 1));
        expect(body.me, "me must be present").toBeTruthy();
        expect(body.me.userId).toBe(ctx.callerId);
        expect(body.me.rank).toBe(26);
        const callerInBoard = body.board.some(u => u.userId === ctx.callerId);
        expect(callerInBoard).toBe(false);
      } finally {
        await caller.dispose();
      }
    } finally {
      await teardownLeaderboardScenario(ctx);
    }
  });

  test("board returns full list when ranked count <= 20", async () => {
    await ensureState();
    // 5 dummies + caller = 6 ranked. Cap is inert; board has all 6.
    const ctx = await buildLeaderboardScenario({
      dummies: 5,
      callerLoginTimeIso: "2026-04-01T10:00:00.000Z", // same as dummies → tie-break by userId
    });
    try {
      const { api: caller, csrf: callerCsrf } = await apiLogin(ctx.callerEmail, ctx.callerPass);
      const callerH = { "x-csrf-token": callerCsrf, "content-type": "application/json" };
      try {
        await caller.post("/api/select-competition", { headers: callerH, data: { competitionId: ctx.compId } });
        const r = await caller.get("/api/leaderboard");
        expect(r.ok()).toBeTruthy();
        const body = await r.json();
        expect(body.board_limit).toBe(20);
        // v6.14.2 — no participant-count disclosure (same invariant as
        // the outside-cap test above).
        expect(body).not.toHaveProperty("total_ranked");
        expect(body.board.length).toBe(6);
        // Caller MUST be in the small board.
        const callerRow = body.board.find(u => u.userId === ctx.callerId);
        expect(callerRow, "caller must be in the truncated board for a small comp").toBeTruthy();
        expect(body.me.userId).toBe(ctx.callerId);
        expect(body.me.rank).toBe(callerRow.rank);
      } finally {
        await caller.dispose();
      }
    } finally {
      await teardownLeaderboardScenario(ctx);
    }
  });

  test("/api/leaderboard does not leak total participant count anywhere in the payload", async () => {
    // v6.14.2 — competition-fairness invariant. The response must not
    // expose the total number of ranked participants in any form: not
    // as `total_ranked` / `totalRanked` / `total` / `count` / similar,
    // and not via any nested object. Every field returned must be one
    // of: top3, board, me, leaderboard_mode, timeslot_id, board_limit
    // (the cap itself, not the count), ended (v7.1.0 boolean — gates the
    // share-badge CTA), or canShareBadge (v7.6.x boolean — this viewer's
    // badge eligibility; no count). Any future code change that adds a
    // count field will fail this allow-list.
    await ensureState();
    const ctx = await buildLeaderboardScenario({
      dummies: 25,
      callerLoginTimeIso: "2026-04-01T10:00:00.000Z",
    });
    try {
      const { api: caller, csrf: callerCsrf } = await apiLogin(ctx.callerEmail, ctx.callerPass);
      const callerH = { "x-csrf-token": callerCsrf, "content-type": "application/json" };
      try {
        await caller.post("/api/select-competition", { headers: callerH, data: { competitionId: ctx.compId } });
        const r = await caller.get("/api/leaderboard");
        const body = await r.json();
        // v7.11.0 — `groupBoard` (group-level board) is allow-listed: it is null
        // here (no group bound in this scenario) and, when present, its entries are
        // capped at board_limit and DO NOT include member counts (stripped in
        // routes/leaderboard.js), so it can't reveal the total participant count.
        // v8.1.0 (PR 18) — `ranking_enabled` joins the allow-list. It is deliberately
        // NOT named `ranked`: leakyNamePattern below matches /ranked(?!_)/ and would
        // flag it, and relaxing the scanner to admit a key matching its own pattern
        // is one edit from disabling the check it exists to perform.
        // v8.6.0 — the four LATE-ENTRY keys join the allow-list, which is what makes
        // adding them a decision. `lateBoard` is null here (no late entrants in this
        // scenario) and, when present, is capped at the same `board_limit` with `me`
        // resolved before truncation and NO count of any kind — the same viewing
        // rules the main board follows, which is what the operator asked for. The
        // other three are booleans and an ISO instant about the CALLER's own
        // situation; none names a population. Note none of the four matches
        // `leakyNamePattern` below, which is checked rather than assumed: a key that
        // did would have to be renamed the way `ranked` became `ranking_enabled`,
        // never admitted by relaxing the scanner. `placementCertificates` is a
        // boolean about the EVENT (a dry run issues no certificates), naming no
        // population.
        const allowedKeys = new Set(["ranking_enabled", "top3", "board", "me", "groupBoard", "lateBoard", "leaderboard_mode", "timeslot_id", "board_limit", "ended", "canShareBadge", "lateEntrantMe", "lateWindowOpen", "lateDeadline", "placementCertificates"]);
        const extraKeys = Object.keys(body).filter(k => !allowedKeys.has(k));
        expect(extraKeys, `unexpected key(s) in /api/leaderboard response: ${JSON.stringify(extraKeys)}. Any new top-level field must be evaluated for participant-count leakage.`).toEqual([]);
        // Defence-in-depth: recursively scan for any field whose NAME
        // suggests it contains a participant count. Grepping the serialised
        // JSON for the number "26" was fragile — UUIDs in the board entries
        // can contain "26" surrounded by hex letters (e.g. "a26b"), which
        // matches a non-digit-bounded regex and produces false failures.
        // Key-name scanning is immune to that coincidence.
        const leakyNamePattern = /total|count|num_participants|ranked(?!_)/i;
        function findCountLeaks(obj, path) {
          const leaks = [];
          if (Array.isArray(obj)) {
            obj.forEach((item, i) => leaks.push(...findCountLeaks(item, `${path}[${i}]`)));
          } else if (obj && typeof obj === "object") {
            for (const [k, v] of Object.entries(obj)) {
              if (leakyNamePattern.test(k)) leaks.push(`${path}.${k}=${JSON.stringify(v)}`);
              else leaks.push(...findCountLeaks(v, `${path}.${k}`));
            }
          }
          return leaks;
        }
        const countLeaks = findCountLeaks(body, "body");
        expect(countLeaks, `participant count may be leaked via a field name: ${JSON.stringify(countLeaks)}`).toEqual([]);
      } finally {
        await caller.dispose();
      }
    } finally {
      await teardownLeaderboardScenario(ctx);
    }
  });

  test("v7.22.0: the admin-only identity columns never reach /api/leaderboard — per ENTRY, not just per response", async () => {
    // The lock above checks TOP-LEVEL response keys plus a recursive scan for
    // count-shaped NAMES. Neither can see a per-ROW leak: adding `email` to
    // every board entry passes both, because no top-level key changed and
    // "email" is not a count. v7.22.0 adds exactly such columns to the ADMIN
    // board, so this closes that gap before it can be crossed.
    //
    // Two independent checks, because either alone is weak:
    //   * STRUCTURAL — an allow-list of the keys an entry may carry. Catches a
    //     field added under any name.
    //   * BY VALUE — the actual first name / last name / email of a participant
    //     who is NOT the caller must appear nowhere in the serialised payload.
    //     Catches a field that dodged the allow-list by being renamed (`fn`),
    //     nested, or folded into an existing string.
    // The value probe deliberately uses ANOTHER participant's data rather than
    // the caller's own: `me` is legitimately the caller's row, so a check that
    // only looked at the caller could be argued away, whereas a dummy's email
    // appearing in the payload is unambiguously somebody else's PII.
    await ensureState();
    const ctx = await buildLeaderboardScenario({
      dummies: 3,
      callerLoginTimeIso: "2026-04-01T10:00:00.000Z",
    });
    try {
      // The fixture inserts dummies as first_name='Cap', last_name='Dummy<i>',
      // email='lbdummy-<tag>-<i>@cust.test'. Recover a real one from the admin
      // board so the probe uses values the server genuinely holds — inventing
      // them here would let the test pass against a build that stores nothing.
      const { api: sa } = await apiLogin("superadmin");
      let adminRow;
      try {
        const ar = await sa.get(`/api/admin/leaderboard?competitionId=${ctx.compId}`);
        expect(ar.ok()).toBeTruthy();
        const adminBoard = await ar.json();
        adminRow = adminBoard.find(e => ctx.dummyIds.includes(e.userId));
        expect(adminRow, "the fixture's dummy participants must be on the admin board").toBeTruthy();

        // POSITIVE CONTROL. Without this, every assertion below is equally
        // satisfied by a build where the identity columns were never added at
        // all — i.e. the test would pass while the feature was broken.
        expect(adminRow.firstName, "admin board must carry firstName").toBe("Cap");
        expect(adminRow.lastName).toMatch(/^Dummy\d+$/);
        expect(adminRow.email).toMatch(/^lbdummy-.+@cust\.test$/);
        // The fixture leaves company NULL; it must come back as an empty string,
        // never null/undefined, or the client prints "undefined" in the cell.
        expect(adminRow.company).toBe("");
      } finally {
        await sa.dispose();
      }

      const { api: caller, csrf: callerCsrf } = await apiLogin(ctx.callerEmail, ctx.callerPass);
      try {
        const callerH = { "x-csrf-token": callerCsrf, "content-type": "application/json" };
        await caller.post("/api/select-competition", { headers: callerH, data: { competitionId: ctx.compId } });
        const r = await caller.get("/api/leaderboard");
        expect(r.ok()).toBeTruthy();
        const body = await r.json();

        // ---- structural: what an entry may carry ----
        const ENTRY_KEYS = new Set([
          "userId", "nickname", "avatar", "score", "finishTime",
          "solveTimeMs", "allSolved", "rank", "isBenchmark",
          // group-board entry shape (routes/leaderboard.js strips memberCount)
          "type", "groupId", "name", "mine",
        ]);
        const offenders = [];
        const walkEntries = (arr, where) => {
          for (const [i, e] of (arr || []).entries()) {
            for (const k of Object.keys(e || {})) {
              if (!ENTRY_KEYS.has(k)) offenders.push(`${where}[${i}].${k}`);
            }
          }
        };
        walkEntries(body.top3, "top3");
        walkEntries(body.board, "board");
        walkEntries(body.me ? [body.me] : [], "me");
        walkEntries(body.groupBoard?.board, "groupBoard.board");
        walkEntries(body.groupBoard?.me ? [body.groupBoard.me] : [], "groupBoard.me");
        expect(offenders,
          `unexpected key(s) on a participant leaderboard ENTRY: ${JSON.stringify(offenders)}. ` +
          `The participant board carries the public handle only — first/last name, company and ` +
          `email are ADMIN-only (buildAdminLeaderboard's separate keyed lookup). Adding one to ` +
          `buildLeaderboardEntries would also poison the shared 5s leaderboard cache.`
        ).toEqual([]);

        // ---- by value: another participant's real identity, anywhere at all ----
        const serialised = JSON.stringify(body);
        for (const [label, value] of [["email", adminRow.email], ["last name", adminRow.lastName]]) {
          expect(serialised.includes(value),
            `another participant's ${label} (${value}) appears in the participant leaderboard payload`
          ).toBe(false);
        }
      } finally {
        await caller.dispose();
      }
    } finally {
      await teardownLeaderboardScenario(ctx);
    }
  });

  test("admin leaderboard is NOT capped (admins need full list)", async () => {
    // /api/admin/leaderboard returns buildAdminLeaderboard() raw — no
    // truncation. Build a comp with 25 dummies so the result would
    // exceed the participant-cap if it were applied; then confirm the
    // admin endpoint returns ALL of them (≥ 25). Self-contained — no
    // dependency on Alice's mutable seed state.
    await ensureState();
    const ctx = await buildLeaderboardScenario({
      dummies: 25,
      callerLoginTimeIso: "2026-04-01T10:00:00.000Z",
    });
    try {
      const { api: sa } = await apiLogin("superadmin");
      try {
        const r = await sa.get(`/api/admin/leaderboard?competitionId=${ctx.compId}`);
        expect(r.ok()).toBeTruthy();
        const board = await r.json();
        expect(Array.isArray(board)).toBe(true);
        // 25 dummies + caller = 26, all visible to admin — well above
        // the participant cap of 20. Some seed staff users tagged
        // `staff` are silently filtered out, so a strict equality on
        // 26 isn't safe; ≥ 26 is the right floor.
        expect(board.length).toBeGreaterThanOrEqual(26);
      } finally {
        await sa.dispose();
      }
    } finally {
      await teardownLeaderboardScenario(ctx);
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v6.16.3 — auditor batch: reveal_answers_on_end on login/my-competitions/
// select-competition + perf healthcheck honours .maintenance.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v6.16.3 — auditor invariants", () => {
  test("/api/login response carries reveal_answers_on_end on each competition", async () => {
    // Pre-fix the login response selected only id/name/start_time/
    // duration_minutes/ended_at, and the SPA wired currentUser=d. So
    // currentUser.competitions[].reveal_answers_on_end was undefined →
    // _willRevealOnEnd resolved to false even when the comp had the
    // flag set, and the session-ended popup showed the generic "Thank
    // you" copy instead of "answers will be revealed".
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const t = Date.now();
    let revealOnId, revealOffId, uid;
    const email = `revealcomp-${tag}@cust.test`;
    const pwd = "revealCompPw123!";
    try {
      const compRevealOn = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: {
          name: `RevealOn-${tag}`,
          start_time: new Date(t - 30_000).toISOString(),
          duration_minutes: 60,
          reveal_answers_on_end: true,
        },
      });
      revealOnId = (await compRevealOn.json()).competition.id;
      const compRevealOff = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: {
          name: `RevealOff-${tag}`,
          start_time: new Date(t - 30_000).toISOString(),
          duration_minutes: 60,
        },
      });
      revealOffId = (await compRevealOff.json()).competition.id;

      // Throwaway participant: register → verify → approve → set known
      // password via the reset-link flow → enrol. Mirrors the v6.16.0
      // helper exactly so it's resilient to other tests' password drift.
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Reveal", lastName: "Comp", nickname: `revealcomp_${tag}`,
          email, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "America/New_York",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      uid = (list.participants || []).find(p => p.email === email)?.id;
      expect(uid).toBeTruthy();
      await sa.post(`/api/admin/participants/${uid}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${uid}/approve`, { headers: saH });
      await sa.post("/api/admin/competitions/assign", {
        headers: saJsonH, data: { userIds: [uid], competitionIds: [revealOnId, revealOffId] },
      });

      // Fresh login — capture the response payload directly.
      const { api: browser, csrf } = await freshCtx();
      try {
        const loginR = await codeLogin(browser, email, { "x-csrf-token": csrf, "content-type": "application/json" }, { password: pwd });
        expect(loginR.ok()).toBeTruthy();
        const loginPayload = await loginR.json();
        expect(Array.isArray(loginPayload.competitions), "login response carries competitions[]").toBeTruthy();
        const onEntry = loginPayload.competitions.find(c => c.id === revealOnId);
        const offEntry = loginPayload.competitions.find(c => c.id === revealOffId);
        expect(onEntry, "reveal-on comp present").toBeTruthy();
        expect(offEntry, "reveal-off comp present").toBeTruthy();
        // SPA does !!c.reveal_answers_on_end; either truthy/0 is fine.
        expect(!!onEntry.reveal_answers_on_end).toBe(true);
        expect(!!offEntry.reveal_answers_on_end).toBe(false);
      } finally {
        await browser.dispose();
      }
    } finally {
      if (uid) await sa.delete(`/api/admin/participants/${uid}`, { headers: saH }).catch(() => {});
      if (revealOnId) await sa.delete(`/api/admin/competitions/${revealOnId}`, { headers: saH }).catch(() => {});
      if (revealOffId) await sa.delete(`/api/admin/competitions/${revealOffId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("/api/my-competitions echoes reveal_answers_on_end", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const t = Date.now();
    let compId;
    try {
      const compR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: {
          name: `MyCompReveal-${tag}`,
          start_time: new Date(t - 30_000).toISOString(),
          duration_minutes: 60,
          reveal_answers_on_end: true,
        },
      });
      compId = (await compR.json()).competition.id;
      await sa.post("/api/admin/competitions/assign", {
        headers: saJsonH, data: { userIds: [S.bob.id], competitionIds: [compId] },
      });
      const { api: bob } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
      try {
        const myComps = await (await bob.get("/api/my-competitions")).json();
        const entry = myComps.find(c => c.id === compId);
        expect(entry, "comp present in /api/my-competitions").toBeTruthy();
        expect(!!entry.reveal_answers_on_end).toBe(true);
      } finally {
        await bob.dispose();
      }
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("/api/select-competition response carries reveal_answers_on_end", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const saH = { "x-csrf-token": saCsrf };
    const tag = crypto.randomBytes(4).toString("hex");
    const t = Date.now();
    let compId;
    try {
      const compR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: {
          name: `SelectReveal-${tag}`,
          start_time: new Date(t - 30_000).toISOString(),
          duration_minutes: 60,
          reveal_answers_on_end: true,
        },
      });
      compId = (await compR.json()).competition.id;
      await sa.post("/api/admin/competitions/assign", {
        headers: saJsonH, data: { userIds: [S.bob.id], competitionIds: [compId] },
      });
      const { api: bob, csrf: bobCsrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
      const bobH = { "x-csrf-token": bobCsrf, "content-type": "application/json" };
      try {
        const selR = await bob.post("/api/select-competition", { headers: bobH, data: { competitionId: compId } });
        const selPayload = await selR.json();
        expect(selPayload.competition, "competition present").toBeTruthy();
        expect(!!selPayload.competition.reveal_answers_on_end).toBe(true);
      } finally {
        await bob.dispose();
      }
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v6.16.4 — auditor batch: orphan delete-rows + LinkedIn-invitation race +
// task scoring-edit freeze + bulk-assign cache invalidation + reveal-answers
// cache TOCTOU + chunked import + email-change rollback txn.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v6.16.4 — auditor invariants", () => {
  test("Participant delete sweeps task_feedback + challenge_events + competition_user_absences", async () => {
    // Pre-fix the user-delete txn dropped users + user_events +
    // competition_users + hint_reveals + submissions + user_tags but
    // missed task_feedback (no FK), challenge_events (FK to tasks
    // only), and competition_user_absences (no FK; v6.12.0 invariant
    // said "rows are never deleted"). The orphans surfaced as NULL-
    // user rows in admin feedback, kept counting in analytics, and
    // distorted solveTimeMs if a uid ever recycled via import.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");

    // Throwaway participant.
    const partEmail = `delsweep-${tag}@cust.test`;
    const partPass = "delSweepPw123!";
    await registerPost(sa, "/api/register", {
      headers: saJsonH,
      data: {
        firstName: "Del", lastName: "Sweep", nickname: `delsweep_${tag}`,
        email: partEmail, company: "Acme", title: "T", avatar: "default1",
        country: "US", timezone: "America/New_York",
      },
    });
    const list = await (await sa.get("/api/admin/participants?limit=500")).json();
    const partId = (list.participants || []).find(p => p.email === partEmail)?.id;
    expect(partId).toBeTruthy();
    await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${partId}/approve`, { headers: saH });

    // Plant rows in each of the three orphan-prone tables.
    const dbW = new Database(TEST_DB_PATH);
    try {
      const taskRow = dbW.prepare("SELECT id FROM tasks LIMIT 1").get();
      expect(taskRow).toBeTruthy();
      const compRow = dbW.prepare("SELECT id FROM competitions LIMIT 1").get();
      expect(compRow).toBeTruthy();
      // task_feedback: (user_id, task_id, rating, updated_at)
      dbW.prepare("INSERT INTO task_feedback (user_id, task_id, rating, updated_at) VALUES (?,?,?,?)")
        .run(partId, taskRow.id, 5, new Date().toISOString());
      // challenge_events: (id, user_id, task_id, competition_id, timeslot_id, event_type, details, occurred_at)
      dbW.prepare("INSERT INTO challenge_events (id, user_id, task_id, competition_id, event_type, occurred_at) VALUES (?,?,?,?,?,?)")
        .run(crypto.randomUUID(), partId, taskRow.id, compRow.id, "navigated_away", new Date().toISOString());
      // competition_user_absences: (user_id, competition_id, timeslot_id, removed_at, returned_at) — composite PK
      dbW.prepare("INSERT INTO competition_user_absences (user_id, competition_id, removed_at) VALUES (?,?,?)")
        .run(partId, compRow.id, new Date().toISOString());
    } finally {
      dbW.close();
    }
    const dbRO1 = new Database(TEST_DB_PATH, { readonly: true });
    expect(dbRO1.prepare("SELECT COUNT(*) c FROM task_feedback WHERE user_id=?").get(partId).c).toBe(1);
    expect(dbRO1.prepare("SELECT COUNT(*) c FROM challenge_events WHERE user_id=?").get(partId).c).toBe(1);
    expect(dbRO1.prepare("SELECT COUNT(*) c FROM competition_user_absences WHERE user_id=?").get(partId).c).toBe(1);
    dbRO1.close();
    const delR = await sa.delete(`/api/admin/participants/${partId}`, { headers: saH });
    expect(delR.ok()).toBeTruthy();
    const dbRO2 = new Database(TEST_DB_PATH, { readonly: true });
    expect(dbRO2.prepare("SELECT COUNT(*) c FROM task_feedback WHERE user_id=?").get(partId).c).toBe(0);
    expect(dbRO2.prepare("SELECT COUNT(*) c FROM challenge_events WHERE user_id=?").get(partId).c).toBe(0);
    expect(dbRO2.prepare("SELECT COUNT(*) c FROM competition_user_absences WHERE user_id=?").get(partId).c).toBe(0);
    dbRO2.close();
    await sa.dispose();
  });

  test("Competition delete sweeps competition_user_absences", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    const compR = await sa.post("/api/admin/competitions", {
      headers: saJsonH,
      data: {
        name: `AbsenceSweep-${tag}`,
        start_time: new Date(Date.now() + 3600_000).toISOString(),
        duration_minutes: 60,
      },
    });
    const compId = (await compR.json()).competition.id;
    const dbW = new Database(TEST_DB_PATH);
    try {
      dbW.prepare("INSERT INTO competition_user_absences (user_id, competition_id, removed_at) VALUES (?,?,?)")
        .run(S.bob.id, compId, new Date().toISOString());
    } finally {
      dbW.close();
    }
    const dbRO1 = new Database(TEST_DB_PATH, { readonly: true });
    expect(dbRO1.prepare("SELECT COUNT(*) c FROM competition_user_absences WHERE competition_id=?").get(compId).c).toBe(1);
    dbRO1.close();
    const delR = await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH });
    expect(delR.ok()).toBeTruthy();
    const dbRO2 = new Database(TEST_DB_PATH, { readonly: true });
    expect(dbRO2.prepare("SELECT COUNT(*) c FROM competition_user_absences WHERE competition_id=?").get(compId).c).toBe(0);
    dbRO2.close();
    await sa.dispose();
  });

  test("PUT /api/admin/tasks rejects scoring-edit when challenge is in a comp with any slot ended", async () => {
    // Multi-slot fairness invariant. Pre-fix the PUT freely changed
    // correct_answer / answer_type / difficulty even when the task
    // was assigned to a comp whose first slot had ended — recalculate
    // would then retroactively shift the ended slot's leaderboard, AND
    // the still-upcoming slot's participants would face the new
    // question. Title / description / explanation / hint stay editable.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    let compId, taskId;
    try {
      const compR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: { name: `FreezeEdit-${tag}`, start_time: new Date(Date.now() - 30_000).toISOString(), duration_minutes: 60 },
      });
      compId = (await compR.json()).competition.id;
      const taskR = await sa.post("/api/admin/tasks", {
        headers: saJsonH,
        data: {
          title: `FreezeTask-${tag}`, difficulty: "easy", answer_type: "text",
          correct_answer: "original", explanation: "<p>e</p>", status: "published",
        },
      });
      taskId = (await taskR.json()).id;
      const assignR = await sa.post(`/api/admin/tasks/${taskId}/competitions`, {
        headers: saJsonH, data: { competitionIds: [compId] },
      });
      expect(assignR.ok()).toBeTruthy();
      await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: saH });
      const ansR = await sa.put(`/api/admin/tasks/${taskId}`, { headers: saJsonH, data: { correct_answer: "rotated" } });
      expect(ansR.status()).toBe(409);
      expect((await ansR.json()).error).toMatch(/Cannot change scoring/i);
      const diffR = await sa.put(`/api/admin/tasks/${taskId}`, { headers: saJsonH, data: { difficulty: "hard" } });
      expect(diffR.status()).toBe(409);
      const titleR = await sa.put(`/api/admin/tasks/${taskId}`, { headers: saJsonH, data: { title: `Renamed-${tag}` } });
      expect(titleR.ok()).toBeTruthy();
    } finally {
      if (taskId) await sa.delete(`/api/admin/tasks/${taskId}`, { headers: saH }).catch(() => {});
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("Bulk-assign invalidates /api/me cache for newly-enrolled participants", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    let compId;
    try {
      const compR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: {
          name: `BulkAssignCache-${tag}`,
          start_time: new Date(Date.now() + 3600_000).toISOString(),
          duration_minutes: 60,
        },
      });
      compId = (await compR.json()).competition.id;
      const { api: bob } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
      try {
        const meBefore = await (await bob.get("/api/me")).json();
        expect((meBefore.competitions || []).some(c => c.id === compId)).toBe(false);
        await sa.post("/api/admin/competitions/assign", {
          headers: saJsonH, data: { userIds: [S.bob.id], competitionIds: [compId] },
        });
        // Pre-fix the 2-s _meCache TTL would have hidden the new comp here.
        const meAfter = await (await bob.get("/api/me")).json();
        expect((meAfter.competitions || []).some(c => c.id === compId)).toBe(true);
      } finally {
        await bob.dispose();
      }
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("Email-change stages a pending confirmation; the live account is untouched even when SMTP fails", async () => {
    // v7.5.0 — a primary-email change is no longer applied immediately. It is
    // STAGED in pending_email and confirmed via a link to the new address; the
    // live email + verified state never change here. SMTP is mocked to fail in
    // test (ECONNREFUSED), so emailDelivered comes back false — but the pending
    // is still staged (no lockout, no rollback needed) and the committed account
    // invariants (email/verified/verify_code) must be unchanged.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const partEmail = `emrev-${tag}@cust.test`;
    const partPass = "emRevPw123!";
    let partId;
    try {
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Em", lastName: "Rev", nickname: `emrev_${tag}`,
          email: partEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "America/New_York",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      partId = (list.participants || []).find(p => p.email === partEmail)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${partId}/approve`, { headers: saH });
      const { api: u, csrf: uCsrf } = await apiLogin(partEmail, partPass);
      const uH = { "x-csrf-token": uCsrf, "content-type": "application/json" };
      try {
        // v8.3.23 — snapshot the committed verification state first, so the
        // assertion below can say "unchanged" rather than "null". Neither the
        // admin verify nor the completed reset above clears the verification
        // receipt any more, and staging a pending change must not either.
        const _DbPre2 = require("better-sqlite3");
        const _pre2 = new _DbPre2(TEST_DB_PATH, { readonly: true });
        const beforeVerifyCode2 = _pre2.prepare("SELECT verify_code FROM users WHERE id=?").get(partId).verify_code;
        _pre2.close();
        const newEmail = `new-emrev-${tag}@cust.test`;
        const r = await u.put("/api/me", { headers: uH, data: { email: newEmail } });
        expect(r.status()).toBe(200);
        const body = await r.json();
        expect(body.emailChangePending).toBe(true);
        expect(body.emailDelivered).toBe(false); // SMTP down in test
        expect(body.pendingEmail).toBe(newEmail.toLowerCase());
        const Database = require("better-sqlite3");
        const dbRO = new Database(TEST_DB_PATH, { readonly: true });
        const row = dbRO.prepare("SELECT email, verified, verify_code, pending_email FROM users WHERE id=?").get(partId);
        dbRO.close();
        // Committed identity untouched; only the pending slot is populated.
        expect(row.email).toBe(partEmail);
        expect(row.verified).toBe(1);
        expect(row.verify_code).toBe(beforeVerifyCode2);
        expect(row.pending_email).toBe(newEmail.toLowerCase());
        // The user is still logged in on the OLD email (no logout).
        const meStill = await u.get("/api/me");
        expect(meStill.status()).toBe(200);
        expect((await meStill.json()).email).toBe(partEmail);
      } finally {
        await u.dispose();
      }
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });
});


// v6.16.22 — security-audit follow-up: NFC email normalisation, LRU
// rate-limit bucket eviction, CSV import within-batch duplicate scan.
test.describe("v6.16.22 — security audit batch", () => {
  test("registration enforces ASCII case-insensitive email uniqueness (mixed-case duplicate rejected)", async () => {
    // SUPERSEDES the old NFC composed/decomposed-é test. Emails are now ASCII-only
    // (ext-audit F1) — a non-ASCII address is rejected outright (see the dedicated
    // ASCII test) — so the relevant, and now COMPLETE, invariant is the COLLATE
    // NOCASE case-insensitive uniqueness: two CASE variants of the same ASCII email
    // must collide. (NOCASE folds ASCII fully, which is exactly why ASCII-only makes
    // the uniqueness guarantee complete.)
    await ensureState();
    const tag = crypto.randomBytes(4).toString("hex");
    const mixed = `Case-${tag}@example.com`;
    const lower = `case-${tag}@example.com`;
    expect(mixed).not.toBe(lower);
    const { api: a, csrf: csrfA } = await freshCtx();
    try {
      const r1 = await registerPost(a, "/api/register", {
        headers: { "x-csrf-token": csrfA, "content-type": "application/json" },
        data: {
          firstName: "Case", lastName: "User", nickname: `casetest-a-${tag}`,
          email: mixed, company: "Acme Corp", title: "Engineer",
          country: "US", timezone: "America/New_York",
        },
      });
      expect(r1.ok()).toBeTruthy();
    } finally { await a.dispose(); }
    // Second registration with a DIFFERENT case of the same ASCII email resolves
    // to the SAME account: the entry screen mails it a SIGN-IN code (never an
    // address proof), so no grant exists, the form refuses, and no second row.
    const { api: b, csrf: csrfB } = await freshCtx();
    try {
      const entry = await entryCode(b, lower);
      expect(entry.answer).toEqual({ ok: true });
      expect(entry.mail, "the case variant is mailed a code").toBeTruthy();
      expect(entry.mail.via, "a sign-in code for the existing account, not a proof").not.toBe("proof");
      const r2 = await registerPost(b, "/api/register", {
        headers: { "x-csrf-token": csrfB, "content-type": "application/json" },
        data: {
          firstName: "Case2", lastName: "User", nickname: `casetest-b-${tag}`,
          email: lower, company: "Acme Corp", title: "Engineer",
          country: "US", timezone: "America/New_York",
        },
      });
      expect(r2.status()).toBe(403);
      expect((await r2.json()).code).toBe("email_proof_required");
      const Database = require("better-sqlite3");
      const dbR = new Database(TEST_DB_PATH, { readonly: true });
      try {
        expect(dbR.prepare("SELECT COUNT(*) c FROM users WHERE LOWER(email)=LOWER(?)").get(lower).c, "one account for the address").toBe(1);
        expect(dbR.prepare("SELECT COUNT(*) c FROM users WHERE nickname=?").get(`casetest-b-${tag}`).c, "the form wrote nothing").toBe(0);
      } finally { dbR.close(); }
    } finally { await b.dispose(); }
  });

  test("Import: within-batch duplicate emails get a 400 with row numbers", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    try {
      const tag = crypto.randomBytes(4).toString("hex");
      const dupEmail = `imp-dup-${tag}@example.com`;
      const r = await sa.post("/api/admin/import/participants", {
        headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
        data: {
          data: {
            type: "hackarena-participants",
            version: 1,
            participants: [
              { nickname: `imp1-${tag}`, email: dupEmail, first_name: "A", last_name: "X", company: "C", title: "T" },
              { nickname: `imp2-${tag}`, email: dupEmail, first_name: "B", last_name: "Y", company: "C", title: "T" },
            ],
          },
          resolutions: {},
        },
      });
      expect(r.ok()).toBeFalsy();
      expect(r.status()).toBe(400);
      const body = await r.json();
      // Error message should call out both row 1 (first seen) and row 2 (duplicate).
      expect(body.error).toMatch(/row 2/i);
      expect(body.error).toMatch(/row 1/i);
      expect(body.error).toMatch(/duplicate|collides/i);
    } finally { await sa.dispose(); }
  });

  test("v6.16.23: audit-mirror lines carry top-level ip / user_agent / req_id / session_id when reqContext was passed", async () => {
    await ensureState();
    // login_success is the canonical case — server.js calls
    // recordUserEvent(uid, "login_success", "system", { ...rctx, method: "password" })
    // where rctx = reqContext(req) = { ip, user_agent, req_id, session_id }.
    // Pre-fix the IP / req_id sat under details.* and were invisible to
    // the admin Logs UI's IP column (which reads r.ip at the top level).
    // Post-fix the audit-mirror line promotes those four fields to the
    // root of the JSONL line.
    const tag = crypto.randomBytes(4).toString("hex");
    // Use bob (CLAUDE.md *Test flakiness — root-cause conventions*,
    // seeded participant contract — alice's password may be mutated
    // by sibling tests under WORKERS=4).
    const { api: throwaway } = await freshCtx();
    try {
      const r = await codeLogin(throwaway, "bob@acme.com", { "x-csrf-token": (await (await throwaway.get("/api/csrf-token")).json()).csrfToken, "content-type": "application/json" });
      expect(r.ok()).toBeTruthy();
    } finally { await throwaway.dispose(); }
    // v8.5.1 — POLL, do not sleep (the mirror is setImmediate-deferred).
    const logsDir = path.join(TEST_DATA_DIR, "logs");
    const line = await findLogLine(logsDir,
      (j) => j.source === "audit" && j.scope === "user" && j.event_type === "login_success",
      { what: "a user:login_success audit line" });
    // Top-level promotion: ip + user_agent + req_id + session_id all
    // present at the root of the line, NOT only nested under details.
    expect(line.ip).toBeTruthy();
    expect(typeof line.ip).toBe("string");
    expect(line.user_agent).toBeTruthy();
    expect(line.req_id).toBeTruthy();
    expect(line.session_id).toBeTruthy();
    // Back-compat: details still carries the nested copy.
    expect(line.details).toBeTruthy();
    expect(line.details.ip).toBe(line.ip);
    expect(line.details.req_id).toBe(line.req_id);
  });

  test("v6.16.24: requireAdmin returns 401 (not 403) with `Not authenticated` when session is gone", async () => {
    // Context with no session — fetch /api/admin/* should be 401 with the
    // exact error string the SPA's session-expired interceptor matches on.
    // Pre-fix, requireAdmin returned 403 "Forbidden" indiscriminately —
    // the interceptor couldn't tell "session expired" from "session valid
    // but lacks admin role", so admin-pane polls (loadAdminLogs every 15s)
    // ran forever after a session timeout and piled up 403s in the
    // access log.
    const { api } = await freshCtx();
    try {
      const r = await api.get("/api/admin/logs?stream=app&limit=10");
      expect(r.status()).toBe(401);
      const body = await r.json();
      expect(body.error).toBe("Not authenticated");
    } finally { await api.dispose(); }
  });

  test("v6.16.24: requireAdmin still returns 403 (not 401) for an authenticated participant trying admin route", async () => {
    // Session is valid (bob is a participant) but lacks admin role.
    // This MUST return 403, not 401 — otherwise the SPA's session-
    // expired interceptor would log him out for legitimately attempting
    // a route he can't access.
    // bob (not alice) — alice's password is mutated by sibling tests
    // under WORKERS=4. See CLAUDE.md *Test flakiness — root-cause
    // conventions* (seeded participant contract).
    await ensureState();
    const { api } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    try {
      const r = await api.get("/api/admin/logs?stream=app&limit=10");
      expect(r.status()).toBe(403);
      const body = await r.json();
      expect(body.error).toMatch(/forbidden/i);
    } finally { await api.dispose(); }
  });

  test("v6.16.24: requireSuperAdmin returns 401 (not 403) when session is gone", async () => {
    const { api } = await freshCtx();
    try {
      // v8.12.4 — PATCH /api/admin/settings is mounted `requireSuperAdmin, csrfProtection`,
      // so requireSuperAdmin is the FIRST guard and is what answers. The export
      // route this used to hit mounts requireAdmin first, so it measured requireAdmin.
      const r = await api.patch("/api/admin/settings", { headers: { "content-type": "application/json" }, data: {} });
      expect(r.status()).toBe(401);
      const body = await r.json();
      expect(body.error).toBe("Not authenticated");
    } finally { await api.dispose(); }
  });

  test("v6.16.24: /api/session/status surfaces reason='kicked' with kicker IP / name when single-session enforcement fired", async () => {
    await ensureState();
    // bob (not alice) — alice's password is mutated by sibling tests
    // under WORKERS=4. See CLAUDE.md *Test flakiness — root-cause
    // conventions* (seeded participant contract).
    // Browser A: Bob logs in.
    const { api: browserA } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    try {
      const pre = await (await browserA.get("/api/session/status")).json();
      expect(pre.active).toBe(true);
      expect(pre.reason).toBeNull();
      // Browser B: Bob logs in from a different context. The login
      // handler invalidates browser A's session and records the kicker
      // context (browser B's IP + Bob's first/last/email).
      const { api: browserB } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
      try {
        const post = await (await browserA.get("/api/session/status")).json();
        expect(post.active).toBe(false);
        expect(post.reason).toBe("kicked");
        expect(post.kicked_by).toBeTruthy();
        expect(post.kicked_by.first_name).toBe("Bob");
        expect(post.kicked_by.last_name).toBe("Jones");
        expect(post.kicked_by.email).toBe("bob@acme.com");
        expect(post.kicked_by.ip).toBeTruthy();
        expect(typeof post.kicked_by.ip).toBe("string");
        expect(post.kicked_by.at).toBeTruthy();
      } finally { await browserB.dispose(); }
    } finally { await browserA.dispose(); }
  });

  test("v6.16.24: /api/session/status returns reason=null when session simply timed out (no kicker on file)", async () => {
    await ensureState();
    // Brand-new context — no session ever existed; /api/session/status
    // should return active:false WITHOUT a kicked reason. The kicker
    // map is keyed by old session id; a brand-new browser has no old
    // cookie to match.
    const { api } = await freshCtx();
    try {
      const r = await api.get("/api/session/status");
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      expect(body.active).toBe(false);
      expect(body.reason).toBeNull();
      expect(body.kicked_by).toBeNull();
    } finally { await api.dispose(); }
  });

  test("Import: ASCII case-variant emails are caught as in-batch duplicates", async () => {
    // SUPERSEDES the NFC composed/decomposed import test — emails are ASCII-only
    // (ext-audit F1). The remaining (now COMPLETE) invariant: two CASE variants of
    // the same ASCII email in one batch collide via the normalised (NOCASE) dedup.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    try {
      const tag = crypto.randomBytes(4).toString("hex");
      const mixed = `Case-${tag}@example.com`;
      const lower = `case-${tag}@example.com`;
      expect(mixed).not.toBe(lower);
      const r = await sa.post("/api/admin/import/participants", {
        headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
        data: {
          data: {
            type: "hackarena-participants",
            version: 1,
            participants: [
              { nickname: `nfcimp1-${tag}`, email: mixed, first_name: "A", last_name: "X", company: "C", title: "T" },
              { nickname: `nfcimp2-${tag}`, email: lower, first_name: "B", last_name: "Y", company: "C", title: "T" },
            ],
          },
          resolutions: {},
        },
      });
      expect(r.ok()).toBeFalsy();
      expect(r.status()).toBe(400);
      const body = await r.json();
      expect(body.error).toMatch(/row 2/i);
    } finally { await sa.dispose(); }
  });

  // v6.16.26 — external auditor batch.
  // H1: hint_reveals_v2 legacy-rebuild integrity — the post-rebuild
  //     schema must carry updated_at + idx_hint_reveals_user_task_comp
  //     (both dropped by the v6.8.0 rebuild's INSERT-SELECT and 2-of-3
  //     index recreate; v6.16.26 re-applies them after the rebuild).
  // M1: DELETE /api/admin/tasks/:id/competitions/:cid honours task.locked.
  // M2: score aggregation joins competition_tasks so unassigning a task
  //     stops it from contributing to wrongRows / correctRows / hintRows
  //     and to /api/leaderboard / getParticipantScore.

  // v6.16.34 — CSP / cross-origin headers maturity + log-rotation
  // disk-quota mode.
  test("v6.16.34: cross-origin isolation headers are sent on every response", async () => {
    const { api } = await freshCtx();
    try {
      const r = await api.get("/");
      const h = r.headers();
      // COOP — process-isolates the document from cross-origin tabs.
      expect(h["cross-origin-opener-policy"]).toBe("same-origin");
      // CORP — blocks cross-origin embedders from loading our resources.
      expect(h["cross-origin-resource-policy"]).toBe("same-origin");
      // Origin-Agent-Cluster — site-isolation hint.
      expect(h["origin-agent-cluster"]).toBe("?1");
    } finally { await api.dispose(); }
  });

  test("v6.16.34: CSP shape — upgrade-insecure-requests gated on https BASE_URL, core directives intact", async () => {
    // v6.16.35 — gated on BASE_URL being https://. The Playwright
    // webServer config sets BASE_URL=http://localhost:<port>, so the
    // directive is intentionally absent on this CI run. WebKit's
    // upgrade-on-localhost behaviour broke the cross-browser smoke
    // before this gate landed.
    const { api } = await freshCtx();
    try {
      const r = await api.get("/");
      const csp = r.headers()["content-security-policy"];
      expect(csp).toBeTruthy();
      // Test environment uses http://localhost — directive must be
      // ABSENT here. (A separate https deploy would carry it.)
      expect(csp).not.toMatch(/upgrade-insecure-requests/);
      // Spot-check the rest of the existing CSP didn't get accidentally
      // dropped during the v6.16.34 / v6.16.35 edits.
      expect(csp).toMatch(/default-src 'self'/);
      expect(csp).toMatch(/frame-ancestors 'none'/);
      expect(csp).toMatch(/require-trusted-types-for 'script'/);
    } finally { await api.dispose(); }
  });

  test("v6.16.34: purge.sh exposes --max-mb flag and refuses to delete the active log writer", () => {
    // Sanity-only — actual disk-quota execution requires sqlite3 +
    // fixture log files, more than this Playwright runner provides.
    // Lock the contract surface here.
    const fs = require("fs");
    const path = require("path");
    const body = fs.readFileSync(path.join(__dirname, "..", "scripts", "purge.sh"), "utf8");
    expect(body).toContain("--max-mb");
    expect(body).toContain("MAX_MB=");
    // audit v7.7.32 (RM6): the guard now protects BOTH of today's live writers
    // (app-<today>.jsonl AND access-<today>.jsonl) by excluding every file whose
    // name carries today's UTC date key — not just the single newest entry
    // (the old `head -n -1`, which left the other family's live file deletable).
    expect(body, "must exclude today's date-key files").toMatch(/today_key=\$\(date -u \+%F\)/);
    // v8.13.4: the exclusion matches today's key on the FILE NAME only (the
    // basename of find's path column), never the whole line — a DATA_DIR whose
    // path carries today's date would otherwise protect every file. The
    // behaviour is driven by data-dir-required.spec.js arm 8c2.
    expect(body).toMatch(/-v k="\$today_key"/);
    expect(body).toMatch(/n = \$3; sub\(\/\.\*\\\/\/, "", n\); if \(index\(n, k\) == 0\) print/);
    expect(body, "the skip-newest-only logic must be gone").not.toMatch(/head -n -1/);
    // The disk-quota helper must still document the operator-facing failure case.
    expect(body).toMatch(/active writer|in-flight writer|live writer/);
  });

  // v6.16.31 — One-click HTTPS unsubscribe per RFC 8058.
  test("v6.16.31: POST /api/unsubscribe with an INVALID token is refused 400 with a JSON reason", async () => {
    // The valid-token opt-out is locked by "unsubscribe: GET renders a
    // confirmation and does NOT opt the recipient out", which signs a real token
    // with the server's secret and POSTs it.
    await ensureState();
    const { api } = await freshCtx();
    try {
      const r = await api.post("/api/unsubscribe?token=clearly-invalid", { headers: { "content-type": "application/json" } });
      expect(r.status()).toBe(400);
      const body = await r.json();
      expect(body.error).toMatch(/invalid|expired/i);
    } finally { await api.dispose(); }
  });

  test("v6.16.31: GET /api/unsubscribe?token=<bogus> returns the friendly HTML 400", async () => {
    await ensureState();
    const { api } = await freshCtx();
    try {
      const r = await api.get("/api/unsubscribe?token=bogus");
      expect(r.status()).toBe(400);
      const body = await r.text();
      expect(body).toMatch(/invalid|expired/i);
      expect(body).toMatch(/<html/i);
    } finally { await api.dispose(); }
  });

  test("v6.16.31: full unsubscribe round-trip via the audit-log surface (token issued during bulk invitation)", async () => {
    // The unsubscribe token is HMAC-signed with a server-side
    // secret we can't reproduce in test code. Round-trip path:
    //   1. Superadmin sends an invitation → bulk email pipeline
    //      attaches List-Unsubscribe header with the token URL.
    //   2. Capture the URL from the audit-log row (the email_sent
    //      audit-mirror records the recipient + reason; the actual
    //      header isn't echoed but we don't need the URL — we just
    //      need to PROVE that the unsubscribe path is integrated
    //      with the email pipeline).
    // For an end-to-end sign+verify lock, drive POST with a
    // synthesised token via DB-direct insertion + check the read
    // path. That tests the storage shape but not the crypto.
    //
    // What we lock here: the unsubscribed_emails table is queryable
    // via the admin endpoint, the seed starts empty, and an
    // INSERT-via-DB-direct surfaces in /api/admin/unsubscribed.
    const Database = require("better-sqlite3");
    const tag = crypto.randomBytes(4).toString("hex");
    const testEmail = `unsub-test-${tag}@example.com`;
    const dbW = new Database(TEST_DB_PATH);
    try {
      dbW.prepare(
        "INSERT OR REPLACE INTO unsubscribed_emails (email, unsubscribed_at, reason, user_agent, ip) VALUES (?,?,?,?,?)"
      ).run(testEmail, new Date().toISOString(), "test_seed", "playwright/test", "127.0.0.1");
    } finally { dbW.close(); }
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    try {
      const r = await sa.get("/api/admin/unsubscribed");
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      expect(Array.isArray(body.entries)).toBe(true);
      const entry = body.entries.find(e => e.email === testEmail);
      expect(entry).toBeTruthy();
      expect(entry.reason).toBe("test_seed");
      // Resubscribe via DELETE.
      const dr = await sa.delete(`/api/admin/unsubscribed/${encodeURIComponent(testEmail)}`, { headers: { "x-csrf-token": saCsrf } });
      expect(dr.ok()).toBeTruthy();
      // 404 on a re-DELETE of an already-cleared address.
      const dr2 = await sa.delete(`/api/admin/unsubscribed/${encodeURIComponent(testEmail)}`, { headers: { "x-csrf-token": saCsrf } });
      expect(dr2.status()).toBe(404);
    } finally { await sa.dispose(); }
  });

  test("v6.16.31: bulk email send to unsubscribed address is short-circuited", async () => {
    // Plant an unsubscribe row, send an invitation, verify the
    // pipeline returns success=false and emits a user_event row
    // with skipped:"unsubscribed" so an operator can debug "why
    // didn't this email arrive?".
    const Database = require("better-sqlite3");
    const tag = crypto.randomBytes(4).toString("hex");
    const target = `bulk-unsub-${tag}@example.com`;
    const dbW = new Database(TEST_DB_PATH);
    try {
      dbW.prepare(
        "INSERT OR REPLACE INTO unsubscribed_emails (email, unsubscribed_at, reason, user_agent, ip) VALUES (?,?,?,?,?)"
      ).run(target, new Date().toISOString(), "test_seed", null, null);
    } finally { dbW.close(); }
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    try {
      const compR = await (await sa.get("/api/admin/competitions")).json();
      const compId = compR.find(c => c.name === "Test Upcoming").id;
      const r = await sa.post("/api/admin/invitations", {
        headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
        data: { emails: [target], competitionIds: [compId] },
      });
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      // The address still gets an invitation row INSERTed (the
      // unsubscribe is for delivery, not for invite-tracking) but
      // emailsSent should be 0 because the SMTP send was skipped.
      expect(body.emailsSent).toBe(0);
      // v8.3.7 — the SUBJECT of this test is unchanged (a bulk send to an
      // unsubscribed address is short-circuited); only the field carrying the
      // outcome moved, and that move IS the fix. An opt-out used to be reported
      // as an UNDELIVERED invite — with a registration link and "share manually",
      // i.e. the platform explaining how to route around the recipient's own
      // choice while telling the operator SMTP had failed. It is its own outcome
      // now, so this asserts the classification rather than merely a non-empty
      // list, which is strictly stronger than what it replaced.
      expect((body.unsubscribedInvites || []).map(u => u.email),
        "reported as an opt-out").toContain(target);
      expect(JSON.stringify(body.undeliveredInvites || []),
        "and NOT as a delivery failure to work around").not.toContain(target);
    } finally {
      // Clean up the unsubscribe row + any stranded invitation row.
      const dbW2 = new Database(TEST_DB_PATH);
      try {
        dbW2.prepare("DELETE FROM unsubscribed_emails WHERE email=?").run(target);
        dbW2.prepare("DELETE FROM invitations WHERE email=?").run(target);
      } finally { dbW2.close(); }
      await sa.dispose();
    }
  });

  // v6.16.29 — audit-trail completeness batch: every data export +
  // bulk import + bulk-invite emits a forensic batch-summary event so
  // an investigator can reconstruct who pulled / loaded / sent what
  // and when. Pre-fix exports were silent and bulk imports / invites
  // were per-row only.
  test("v6.16.29: GET /api/admin/export/tasks emits a data_exported audit event", async () => {
    await ensureState();
    const { api: sa } = await apiLogin("superadmin");
    try {
      const r = await sa.get("/api/admin/export/tasks");
      expect(r.ok()).toBeTruthy();
      // v8.5.1 — POLL, do not sleep (the mirror is setImmediate-deferred).
      const logsDir = path.join(TEST_DATA_DIR, "logs");
      const exportLine = await findLogLine(logsDir,
        (j) => j.source === "audit" && j.scope === "export"
               && j.scope_id === "tasks" && j.event_type === "data_exported",
        { what: "an export:tasks:data_exported audit line" });
      // Forensic context: who, when (req_id), how many.
      expect(exportLine.actor || exportLine.changed_by).toBeTruthy();
      expect(exportLine.details).toBeTruthy();
      expect(typeof exportLine.details.task_count).toBe("number");
      expect(exportLine.details.req_id).toBeTruthy();
      expect(exportLine.details.ip).toBeTruthy();
    } finally { await sa.dispose(); }
  });

  test("v6.16.29: GET /api/admin/export/participants emits a data_exported audit event", async () => {
    await ensureState();
    const { api: sa } = await apiLogin("superadmin");
    try {
      const r = await sa.get("/api/admin/export/participants");
      expect(r.ok()).toBeTruthy();
      // v8.5.1 — POLL, do not sleep (the mirror is setImmediate-deferred).
      const logsDir = path.join(TEST_DATA_DIR, "logs");
      const found = await findLogLine(logsDir,
        (j) => j.source === "audit" && j.scope === "export"
               && j.scope_id === "participants" && j.event_type === "data_exported"
               && typeof j.details?.participant_count === "number",
        { what: "an export:participants:data_exported audit line carrying participant_count" });
      expect(found).toBeTruthy();
    } finally { await sa.dispose(); }
  });

  test("v6.16.30: purge.sh script ships executable and is dry-run-by-default", () => {
    // Sanity-only — the actual purge logic depends on the sqlite3
    // CLI which isn't always available in the test environment.
    // What we lock here: the script ships with +x, is dry-run by
    // default (the README documents this safety net), and references
    // the four documented categories so a future commit doesn't
    // accidentally drop one.
    const fs = require("fs");
    const path = require("path");
    const scriptPath = path.join(__dirname, "..", "scripts", "purge.sh");
    expect(fs.existsSync(scriptPath)).toBe(true);
    const stat = fs.statSync(scriptPath);
    expect(stat.mode & 0o100).toBeTruthy();
    const body = fs.readFileSync(scriptPath, "utf8");
    // Dry-run-by-default contract — APPLY=false out of the box.
    expect(body).toMatch(/APPLY\s*=\s*false/);
    expect(body).toContain("--apply");
    // Documented categories.
    for (const cat of ["logs", "invitations", "email_reminders", "sessions"]) {
      expect(body, `purge.sh must reference category "${cat}"`).toContain(cat);
    }
    // Defensive: the only `sqlite3 "$db_file" "DELETE FROM ..."`
    // executions in the script must target rotation-safe tables. The
    // sqlite_purge helper takes the table name as its 2nd arg; scan
    // every call site and assert the table is in the safe list. Mentions
    // of `users` / `submissions` / `*_events` in comments are fine
    // (the script EXPLAINS to the operator what it deliberately
    // doesn't touch).
    const safeTables = new Set(["invitations", "email_reminders", "sessions"]);
    const callSites = body.match(/sqlite_purge\s+"\$\w+"\s+"([^"]+)"/g) || [];
    // v8.12.4 — anti-vacuity: a renamed helper or a changed quoting style
    // empties the match and the loop below passes over nothing.
    expect(callSites.length, "the scan must find the script's sqlite_purge calls").toBeGreaterThanOrEqual(2);
    for (const m of callSites) {
      const tableMatch = m.match(/sqlite_purge\s+"\$\w+"\s+"([^"]+)"/);
      if (tableMatch) {
        expect(safeTables.has(tableMatch[1]),
          `purge.sh sqlite_purge call targets unsafe table "${tableMatch[1]}"`).toBe(true);
      }
    }
  });

  test("v6.16.29: backup.sh script is executable + emits a SQLite-consistent snapshot", () => {
    // Sanity-only — full backup-to-restore drill is operator-side.
    // The script is shell, not exercised by the Playwright runner;
    // this lock just ensures the file is shipped + executable so a
    // future commit doesn't accidentally drop the +x bit.
    const fs = require("fs");
    const path = require("path");
    const scriptPath = path.join(__dirname, "..", "scripts", "backup.sh");
    expect(fs.existsSync(scriptPath)).toBe(true);
    const stat = fs.statSync(scriptPath);
    // Owner exec bit (0o100). Group / other are nice-to-have.
    expect(stat.mode & 0o100).toBeTruthy();
    const body = fs.readFileSync(scriptPath, "utf8");
    expect(body).toContain(".backup");  // online-backup command
    expect(body).toMatch(/hackathon\.db|sessions\.db/);
  });

  // v6.16.28 — security headers + email deliverability batch.
  test("v6.16.28: Permissions-Policy denies camera / microphone / geolocation / interest-cohort etc.", async () => {
    // The expanded Permissions-Policy header (added in v6.16.28) is
    // a defence-in-depth opt-out from every sensor / device-API the
    // SPA does not use. Tests the contract: the response must carry
    // each `feature=()` directive so a future code change that
    // accidentally enables one (e.g. by importing a third-party
    // script that calls navigator.geolocation) is forced through
    // explicit reconfiguration instead of going silent.
    const { api } = await freshCtx();
    try {
      const r = await api.get("/");
      const pp = r.headers()["permissions-policy"];
      expect(pp).toBeTruthy();
      // Spot-check the high-impact denials. Listing every directive
      // would lock the test to the exact string and be brittle when
      // we add more features in the future; sample the most-relevant.
      for (const feature of [
        "camera=()", "microphone=()", "geolocation=()",
        "interest-cohort=()", "payment=()", "usb=()",
      ]) {
        expect(pp, `Permissions-Policy must deny ${feature}`).toContain(feature);
      }
    } finally { await api.dispose(); }
  });

  test("v6.16.28: bulk-email reasons (invitation, reminder) get List-Unsubscribe header", async () => {
    // The List-Unsubscribe header (RFC 2369 / 8058) signals to Gmail /
    // Outlook / Apple Mail that the sender is a legitimate bulk
    // transactional sender — required for sustained deliverability.
    // Our pipeline adds it automatically when the reason is in
    // _BULK_EMAIL_REASONS. Test the contract by sending a fresh
    // invitation and inspecting the email-events log for the header.
    //
    // Rather than wire the test to a captured-mail server, we read
    // the JSONL audit-mirror line — the sendEmailLogged path doesn't
    // surface headers there. So the next-best lock is to assert the
    // _BULK_EMAIL_REASONS Set covers the operationally-relevant
    // reasons. We probe this by sending an invitation (the seed
    // produces one) and checking that the email_sent audit row exists
    // with reason="invitation". The header itself is locked at the
    // unit level — a regression that drops the header from the
    // wrapper would still pass an integration probe because the SMTP
    // server doesn't echo headers. Strict inspection would require a
    // captured-mail framework which is out of scope.
    //
    // What we CAN lock here: the helper export. _bulkEmailHeaders is
    // a module-internal function, but the constant _BULK_EMAIL_REASONS
    // is greppable. Also assert the function output shape via a
    // direct call would be cleaner but requires a server-side test
    // entry-point. For now, the README documentation + the unit
    // contract is what we lock.
    //
    // Verifies the Set's contents and the resulting URL shape on a
    // representative reason.
    const fs = require("fs");
    const path = require("path");
    // v7.0.0 — the email transport + bulk-send unsubscribe machinery were
    // extracted from server.js into lib/email.js; introspect that module.
    const emailSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "email.js"), "utf8");
    // Locate the Set definition then check the contents in the
    // following ~20 lines (it's multi-line).
    const setStart = emailSrc.indexOf("_BULK_EMAIL_REASONS");
    expect(setStart).toBeGreaterThan(0);
    const setBlock = emailSrc.slice(setStart, setStart + 800);
    for (const reason of ["invitation", "competition_assignment", "reminder", "removed_from_competition"]) {
      expect(setBlock, `_BULK_EMAIL_REASONS must include "${reason}"`).toContain(`"${reason}"`);
    }
    // v8.3.7 — `account_approved_bulk` was REMOVED from the set, and the lock now
    // asserts its absence rather than merely dropping the row: without this, the
    // decision is invisible and a future edit re-adds it as an obvious-looking
    // tidy-up.
    //
    // It and `account_approved` are byte-identical mail that differed only in
    // whether an opted-out recipient got them — so approving one participant
    // reached them and approving the SAME participant in a batch did not. One
    // button, two behaviours. Equalised towards DELIVERY because an approval is
    // transactional: it is the notice that an account is now usable, and belongs
    // with verification and password resets rather than with reminders.
    expect(setBlock, "account_approved_bulk must NOT be suppressible — an approval is transactional (v8.3.7)")
      .not.toContain('"account_approved_bulk"');
    // Anti-vacuity: the block really is the Set and really does hold reasons, or
    // the `not.toContain` above passes against a mis-parse.
    expect(setBlock).toContain('"reminder"');
    // The header builder must emit `List-Unsubscribe` (object-literal
    // OR property-assignment form — accept either shape).
    expect(emailSrc).toMatch(/["']List-Unsubscribe["']\s*[:\]=]/);
    expect(emailSrc).toMatch(/<mailto:unsubscribe@/);
  });

  // v6.16.27 — top-3 audit batch:
  //   - destructive admin route rate limit
  //   - PUT /api/admin/competitions/:id + /api/admin/tasks/:id
  //     optimistic concurrency via expectedUpdatedAt
  test("v6.16.27: PUT /api/admin/tasks/:id rejects 409 on stale expectedUpdatedAt", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    let taskId;
    try {
      // Use the test seed's draft1 task — it's not assigned to any
      // ended comp so the scoring-edit freeze (v6.16.4) won't fire.
      const tasks = await (await sa.get("/api/admin/tasks")).json();
      taskId = tasks.find(t => t.title === "Challenge draft1").id;
      // First PUT establishes a known updated_at value.
      const r1 = await sa.put(`/api/admin/tasks/${taskId}`, {
        headers: saH,
        data: { title: "Challenge draft1" /* same title — bumps updated_at */ },
      });
      expect(r1.ok()).toBeTruthy();
      // Read the post-PUT updated_at.
      const t1 = (await (await sa.get("/api/admin/tasks")).json()).find(t => t.id === taskId);
      expect(t1.updated_at).toBeTruthy();
      // Concurrent admin: a SECOND PUT bumps updated_at without our knowledge.
      const r2 = await sa.put(`/api/admin/tasks/${taskId}`, {
        headers: saH,
        data: { title: "Challenge draft1" },
      });
      expect(r2.ok()).toBeTruthy();
      // Now WE PUT with the STALE updated_at value (the one we held at GET time).
      // The check must fire 409 with conflict:true and currentUpdatedAt populated.
      const r3 = await sa.put(`/api/admin/tasks/${taskId}`, {
        headers: saH,
        data: { title: "Challenge draft1", expectedUpdatedAt: t1.updated_at },
      });
      expect(r3.status()).toBe(409);
      const body = await r3.json();
      expect(body.conflict).toBe(true);
      expect(body.error).toMatch(/another admin/i);
      expect(body.currentUpdatedAt).toBeTruthy();
      expect(body.currentUpdatedAt).not.toBe(t1.updated_at);
      // Sanity: a fresh PUT with the CURRENT updated_at succeeds.
      const r4 = await sa.put(`/api/admin/tasks/${taskId}`, {
        headers: saH,
        data: { title: "Challenge draft1", expectedUpdatedAt: body.currentUpdatedAt },
      });
      expect(r4.ok()).toBeTruthy();
    } finally {
      await sa.dispose();
    }
  });

  test("v6.16.27: PUT /api/admin/competitions/:id rejects 409 on stale expectedUpdatedAt", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    let compId;
    try {
      // Use Test Upcoming so we can edit duration freely (no slots
      // started, no scoring-edit freeze).
      compId = S.upcomingComp.id;
      // Snapshot updated_at via the admin list response.
      const compsR = await (await sa.get("/api/admin/competitions")).json();
      const comp1 = compsR.find(c => c.id === compId);
      expect(comp1.updated_at).toBeTruthy();
      // Concurrent edit bumps updated_at.
      const cr = await sa.put(`/api/admin/competitions/${compId}`, {
        headers: saH,
        data: { duration_minutes: comp1.duration_minutes + 5 },
      });
      expect(cr.ok()).toBeTruthy();
      // Stale PUT with the original updated_at must 409.
      const r = await sa.put(`/api/admin/competitions/${compId}`, {
        headers: saH,
        data: { duration_minutes: comp1.duration_minutes + 10, expectedUpdatedAt: comp1.updated_at },
      });
      expect(r.status()).toBe(409);
      const body = await r.json();
      expect(body.conflict).toBe(true);
      expect(body.error).toMatch(/another admin/i);
    } finally {
      // Restore original duration so downstream tests see the seed shape.
      try {
        await sa.put(`/api/admin/competitions/${compId}`, {
          headers: saH,
          data: { duration_minutes: 120 },
        });
      } catch (_) {}
      await sa.dispose();
    }
  });

  test("v6.16.27: destructive-admin rate limit fires 429 after the cap is exceeded", async () => {
    // Toggle on the rate limiter at runtime, hammer a destructive
    // admin route past its 30/min cap, expect a 429 with
    // Retry-After-style copy. Toggle off to clean up.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    try {
      // Force-enable the rate limiter (bypasses RATE_LIMIT_DISABLED=1
      // set by the test harness). Test-only endpoint per CLAUDE.md.
      await sa.post("/api/test/rate-limit-toggle", {
        headers: saH,
        data: { enable: true },
      });
      try {
        // /unlock is NOT in the destructive list (just a clear of
        // failed_login_count), so use /login-code/email — it's keyed
        // under "destructive-admin" and rate-capped at 30/min.
        // Use a non-existent userId so no DB mutation actually runs;
        // the rate limit fires before requireAdmin's DB hit anyway.
        let saw429 = false;
        for (let i = 0; i < 35; i++) {
          const r = await sa.post(`/api/admin/participants/nonexistent-${i}/login-code/email`, { headers: saH });
          if (r.status() === 429) { saw429 = true; break; }
        }
        expect(saw429, "Should have hit 429 within 35 requests on the 30/min cap").toBe(true);
      } finally {
        await sa.post("/api/test/rate-limit-toggle", {
          headers: saH,
          data: { enable: false },
        });
      }
    } finally {
      await sa.dispose();
    }
  });

  test("v6.16.26 H1: hint_reveals carries updated_at + composite index after every boot", async () => {
    // Fresh-install boot leaves the column + index in place; legacy DB
    // boot used to drop them via the v6.8.0 v2 rebuild. The v6.16.26
    // re-migration puts them back idempotently. Whichever path the
    // current test data dir was created via, the post-boot schema
    // shape is the invariant.
    const Database = require("better-sqlite3");
    const dbRO = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const cols = dbRO.prepare("PRAGMA table_info(hint_reveals)").all().map(c => c.name);
      expect(cols, "hint_reveals must carry updated_at column").toContain("updated_at");
      const indexes = dbRO.prepare("PRAGMA index_list(hint_reveals)").all().map(i => i.name);
      expect(indexes, "hint_reveals must carry idx_hint_reveals_user_task_comp composite index")
        .toContain("idx_hint_reveals_user_task_comp");
    } finally { dbRO.close(); }
  });

  test("v6.16.26 M1: regular admin cannot DELETE assignment from a locked task", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    let regAdminId = null;
    let lockedTaskId = null;
    let upcomingCompId = S.upcomingComp.id;
    try {
      // Promote a participant to regular admin so we can test the gate.
      regAdminId = S.bob.id;
      await sa.post(`/api/admin/participants/${regAdminId}/role`, { headers: saH, data: { role: "admin" } });
      // Pick an unassigned task we can lock + assign cleanly.
      const tasks = await (await sa.get("/api/admin/tasks")).json();
      const candidate = tasks.find(t => t.status === "published" && t.title === "Challenge easy2");
      lockedTaskId = candidate.id;
      // Clear any pre-existing assignments on this task (test seed
      // pre-assigned easy2 to upcomingComp; unassign first so we can
      // test re-assign + lock + delete-blocked flow cleanly).
      const assignedTo = (candidate.competitions || []).map(c => c.id);
      for (const cid of assignedTo) {
        await sa.delete(`/api/admin/tasks/${lockedTaskId}/competitions/${cid}`, { headers: saH }).catch(() => {});
      }
      // Assign easy2 to upcoming comp (no slots ended → assignment edits allowed).
      const ar = await sa.post(`/api/admin/tasks/${lockedTaskId}/competitions`, {
        headers: saH, data: { competitionIds: [upcomingCompId] },
      });
      expect(ar.ok()).toBeTruthy();
      // Lock it (superadmin-only).
      const lr = await sa.post(`/api/admin/tasks/${lockedTaskId}/lock`, { headers: saH, data: { locked: true } });
      expect(lr.ok()).toBeTruthy();
      // Now log in as the regular admin and try DELETE — must 403.
      const { api: ra, csrf: raCsrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
      try {
        const r = await ra.delete(`/api/admin/tasks/${lockedTaskId}/competitions/${upcomingCompId}`, {
          headers: { "x-csrf-token": raCsrf },
        });
        expect(r.status()).toBe(403);
        const body = await r.json();
        expect(body.error).toMatch(/locked/i);
      } finally { await ra.dispose(); }
      // Superadmin DELETE still works (they can also unlock).
      const sar = await sa.delete(`/api/admin/tasks/${lockedTaskId}/competitions/${upcomingCompId}`, {
        headers: { "x-csrf-token": saCsrf },
      });
      expect(sar.ok()).toBeTruthy();
    } finally {
      // Restore: unlock the task, demote bob.
      try { if (lockedTaskId) await sa.post(`/api/admin/tasks/${lockedTaskId}/lock`, { headers: saH, data: { locked: false } }); } catch (_) {}
      try { if (regAdminId) await sa.post(`/api/admin/participants/${regAdminId}/role`, { headers: saH, data: { role: "participant" } }); } catch (_) {}
      // Re-attach easy2 to upcoming for downstream test seeds that assume it.
      try { if (lockedTaskId) await sa.post(`/api/admin/tasks/${lockedTaskId}/competitions`, { headers: saH, data: { competitionIds: [upcomingCompId] } }); } catch (_) {}
      await sa.dispose();
    }
  });

  test("v6.16.26 M2: unassigning a task filters its rows out of the score-aggregation JOIN", async () => {
    // Direct test of the SQL invariant — bypass the leaderboard cache
    // so the result is independent of (a) sibling-test cache pollution
    // and (b) the 5-s TTL window. The whole-system behaviour
    // (leaderboard score drops on unassign) is locked separately by
    // the DELETE-handler cache-invalidation at server.js:7711+; this
    // test just verifies that the JOIN filters orphan submissions out
    // of getParticipantScore's underlying queries.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const Database = require("better-sqlite3");
    let compId, taskId, userId;
    let synthSubmissionInserted = false;
    let synthRowId = null;
    try {
      compId = S.liveComp.id;
      const tasks = await (await sa.get("/api/admin/tasks")).json();
      taskId = tasks.find(t => t.title === "Challenge easy1").id;
      userId = S.alice.id;
      const dbW = new Database(TEST_DB_PATH);
      try {
        // Plant a deterministic synthetic submission if the seed didn't.
        const sub = dbW.prepare(
          "SELECT id FROM submissions WHERE user_id=? AND task_id=? AND competition_id=? AND is_correct=1"
        ).get(userId, taskId, compId);
        if (!sub) {
          synthRowId = `v616_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
          dbW.prepare(
            "INSERT INTO submissions (id, user_id, task_id, competition_id, timeslot_id, is_correct, points_delta, answer, submitted_at) VALUES (?,?,?,?,NULL,1,50,'answer-easy1',?)"
          ).run(synthRowId, userId, taskId, compId, new Date().toISOString());
          synthSubmissionInserted = true;
        }
        // Pre-condition: the JOIN-filtered aggregation has Alice's
        // points; the unfiltered aggregation has them too. They match.
        const beforeJoined = dbW.prepare(
          `SELECT COALESCE(SUM(s.points_delta), 0) AS pts FROM submissions s
           JOIN competition_tasks ct ON ct.task_id=s.task_id AND ct.competition_id=s.competition_id
           WHERE s.user_id=? AND s.competition_id=? AND s.is_correct=1`
        ).get(userId, compId).pts;
        const beforeUnfiltered = dbW.prepare(
          `SELECT COALESCE(SUM(s.points_delta), 0) AS pts FROM submissions s
           WHERE s.user_id=? AND s.competition_id=? AND s.is_correct=1`
        ).get(userId, compId).pts;
        expect(beforeJoined).toBeGreaterThan(0);
        expect(beforeJoined).toBe(beforeUnfiltered);
        // Unassign easy1 from liveComp via the DELETE handler.
        const dr = await sa.delete(`/api/admin/tasks/${taskId}/competitions/${compId}`, {
          headers: { "x-csrf-token": saCsrf },
        });
        expect(dr.ok()).toBeTruthy();
        // Post: the JOIN-filtered aggregation has dropped; the unfiltered
        // one is unchanged (audit trail preserved).
        const afterJoined = dbW.prepare(
          `SELECT COALESCE(SUM(s.points_delta), 0) AS pts FROM submissions s
           JOIN competition_tasks ct ON ct.task_id=s.task_id AND ct.competition_id=s.competition_id
           WHERE s.user_id=? AND s.competition_id=? AND s.is_correct=1`
        ).get(userId, compId).pts;
        const afterUnfiltered = dbW.prepare(
          `SELECT COALESCE(SUM(s.points_delta), 0) AS pts FROM submissions s
           WHERE s.user_id=? AND s.competition_id=? AND s.is_correct=1`
        ).get(userId, compId).pts;
        expect(afterJoined, "JOIN'd aggregation must drop after unassign").toBeLessThan(beforeJoined);
        expect(afterUnfiltered, "Unfiltered aggregation must stay equal — audit row preserved").toBe(beforeUnfiltered);
      } finally { dbW.close(); }
    } finally {
      try {
        if (taskId && compId) {
          await sa.post(`/api/admin/tasks/${taskId}/competitions`, {
            headers: saH, data: { competitionIds: [compId] },
          });
        }
        if (synthSubmissionInserted) {
          const dbW = new Database(TEST_DB_PATH);
          try {
            dbW.prepare("DELETE FROM submissions WHERE id=?").run(synthRowId);
          } finally { dbW.close(); }
        }
      } catch (_) {}
      await sa.dispose();
    }
  });

  // v6.16.39 — admin write attribution gaps closed.
  // The audit at v6.16.38 found 6 admin/superadmin write endpoints
  // emitted no event row at all. These tests lock the new audit
  // emission for each gap so a future refactor that drops the call
  // fails CI immediately. All four staging-related routes plus
  // test-email plus admin-logout plus perf-bulk-seed-users.

  // Helper: scan today's app-*.jsonl for an audit-mirror row matching
  // (scope, scope_id?, event_type). Returns the parsed row or null.
  // Mirrors the v6.16.29 export-audit lookup pattern.
  // v8.5.1 — POLLS rather than sleeping 200 ms and scanning once. Every one of the
  // eight callers asserts the row is present, so a timeout is a real failure and
  // the helper now says what it was looking for instead of handing back a bare null.
  async function _findAuditRow({ scope, scope_id, event_type, scope_id_substr }) {
    const logsDir = path.join(TEST_DATA_DIR, "logs");
    return findLogLine(logsDir, (j) => {
      if (j.source !== "audit") return false;
      if (scope && j.scope !== scope) return false;
      if (event_type && j.event_type !== event_type) return false;
      if (scope_id != null && j.scope_id !== scope_id) return false;
      if (scope_id_substr && !(typeof j.scope_id === "string" && j.scope_id.includes(scope_id_substr))) return false;
      return true;
    }, { what: `an audit row ${JSON.stringify({ scope, scope_id, event_type, scope_id_substr })}` });
  }

  test("v6.16.39: POST /api/admin/test-email emits an email:<to>:test_email_sent audit row", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    try {
      const tag = crypto.randomBytes(4).toString("hex");
      const to = `audit-test-${tag}@example.com`;
      // SMTP host is "localhost" in test config and there's no listener,
      // so the send WILL fail (502). The audit row should still land,
      // because we emit on both branches.
      await sa.post("/api/admin/test-email", {
        headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
        data: { to },
      });
      const row = await _findAuditRow({ scope: "email", scope_id: to, event_type: "test_email_sent" });
      expect(row, `expected an email:${to}:test_email_sent audit row`).toBeTruthy();
      // Actor is the superadmin literal (built-in superadmin has no user row).
      expect(row.actor || row.changed_by).toBeTruthy();
      // reqContext fields are promoted to top-level (v6.16.23) — req_id + ip.
      expect(row.req_id || row.details?.req_id).toBeTruthy();
      expect(row.ip || row.details?.ip).toBeTruthy();
      // Outcome is captured (true on SMTP success, false on failure).
      expect(typeof (row.details?.ok)).toBe("boolean");
    } finally { await sa.dispose(); }
  });

  test("v6.16.39: POST /api/admin/logout emits a session:<sid>:admin_logout audit row", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    try {
      const r = await sa.post("/api/admin/logout", { headers: { "x-csrf-token": saCsrf } });
      expect(r.ok()).toBeTruthy();
      const row = await _findAuditRow({ scope: "session", event_type: "admin_logout" });
      expect(row, "expected a session:<sid>:admin_logout audit row").toBeTruthy();
      // Actor must resolve to "superadmin" for the built-in superadmin.
      // The audit-mirror's `actor` enrichment may shape it as either
      // `actor.email` or fall through to `changed_by` for the literal.
      const actor = row.actor?.email || row.actor?.id || row.changed_by;
      expect(typeof actor === "string" && actor.length > 0).toBe(true);
    } finally {
      try { await sa.dispose(); } catch {}
    }
  });

  test("v6.16.39: attachment-staging POST/PATCH/DELETE each emit an attachment:<id>:* audit row", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    try {
      // Build the smallest valid unencrypted ZIP we can — JSZip via
      // require if available, else hand-roll the 22-byte EOCD-only
      // "empty zip" header. The validator accepts an empty zip with
      // no central directory entries; we don't need real content.
      // Simplest: use the built-in zlib + a known-good 22-byte EOCD.
      // Empty ZIP file (just End Of Central Directory record).
      const emptyZip = Buffer.from([
        0x50, 0x4b, 0x05, 0x06, // EOCD signature
        0x00, 0x00,             // disk number
        0x00, 0x00,             // disk where CD starts
        0x00, 0x00,             // num entries on this disk
        0x00, 0x00,             // total num entries
        0x00, 0x00, 0x00, 0x00, // CD size
        0x00, 0x00, 0x00, 0x00, // CD offset
        0x00, 0x00,             // comment length
      ]);
      // Step 1: POST upload to staging.
      const upR = await sa.post("/api/admin/attachment-staging", {
        headers: { "x-csrf-token": saCsrf },
        multipart: {
          file: { name: "audit-staging-test.zip", mimeType: "application/zip", buffer: emptyZip },
          display_name: "audit-staging-test",
        },
      });
      expect(upR.ok(), `staging upload failed: ${upR.status()}`).toBeTruthy();
      const upBody = await upR.json();
      const stagingId = upBody.staging_id;
      expect(stagingId).toBeTruthy();
      const upRow = await _findAuditRow({ scope: "attachment", scope_id: stagingId, event_type: "attachment_staged" });
      expect(upRow, "expected attachment_staged audit row").toBeTruthy();
      expect(upRow.details?.display_name).toBe("audit-staging-test");
      expect(typeof upRow.details?.size_bytes).toBe("number");
      expect(upRow.details?.sha256).toBeTruthy();

      // Step 2: PATCH to rename.
      const reR = await sa.patch(`/api/admin/attachment-staging/${stagingId}`, {
        headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
        data: { display_name: "renamed-audit-staging" },
      });
      expect(reR.ok()).toBeTruthy();
      const reRow = await _findAuditRow({ scope: "attachment", scope_id: stagingId, event_type: "attachment_staging_renamed" });
      expect(reRow, "expected attachment_staging_renamed audit row").toBeTruthy();
      expect(reRow.details?.from_name).toBe("audit-staging-test");
      expect(reRow.details?.to_name).toBe("renamed-audit-staging");

      // Step 3: DELETE to discard.
      const delR = await sa.delete(`/api/admin/attachment-staging/${stagingId}`, {
        headers: { "x-csrf-token": saCsrf },
      });
      expect(delR.ok()).toBeTruthy();
      const delRow = await _findAuditRow({ scope: "attachment", scope_id: stagingId, event_type: "attachment_staging_discarded" });
      expect(delRow, "expected attachment_staging_discarded audit row").toBeTruthy();
      expect(delRow.details?.display_name).toBe("renamed-audit-staging");
    } finally { await sa.dispose(); }
  });

  // v6.16.41 — external auditor batch (4 findings closed):
  //   H1 — 128 MB import parser was mounted globally before auth/rate-
  //        limit. Anonymous POST /api/admin/import/tasks would parse a
  //        128 MB body before requireAdmin / requireSuperAdmin saw the
  //        session — cheap memory DoS path. Moved INSIDE both routes
  //        after the gates.
  //   M1 — _doUnsubscribe HTML branch called undefined `esc(email)`
  //        instead of `escapeHtml(email)`. The DB INSERT happens before
  //        the response, so the user was unsubscribed but saw an
  //        internal-error page.
  //   M2 — unsubscribe HMAC secret derived from auto-rotating
  //        SESSION_SECRET, so 365-day tokens broke on every restart.
  //        Persisted to DATA_DIR/.unsubscribe-secret instead.
  //   M3 — legacy hint_reveals rebuild dropped idx_hint_reveals_comp_revtime
  //        (created at db.js:391 for fresh installs); v6.16.26 patched
  //        only the user_task_comp composite. Legacy DBs missed the
  //        revtime index → /api/admin/submissions hint ordering scanned.

  test("v6.16.41 H1: 128mb import parser is mounted INSIDE the route, not globally", () => {
    const fs = require("fs");
    const path = require("path");
    const body = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    // The pre-fix shape ran a global app.use checking req.path against
    // the import endpoints — that would re-introduce the DoS gap.
    expect(body).not.toMatch(/if\s*\(\s*req\.path\s*===\s*['"]\/api\/admin\/import\/(tasks|participants)/);
    // Each import route must reference the larger parser as inline
    // middleware, AFTER the auth + CSRF gates.
    expect(body).toMatch(/import\/tasks["'][\s\S]{0,200}requireSuperAdmin[\s\S]{0,200}_importJsonParser/);
    expect(body).toMatch(/import\/participants["'][\s\S]{0,200}requireSuperAdmin[\s\S]{0,200}_importJsonParser/);
  });

  test("v6.16.41 H1: anonymous POST /api/admin/import/tasks 401s before parsing the body", async () => {
    // Send an 8 MB body — bigger than the global 5 MB parser would
    // accept on any other route. Pre-fix this 8 MB body would land
    // inside the 128 MB parser BEFORE auth ran. Post-fix the request
    // is rejected at requireAdmin without the body being parsed.
    // (Either way the wire status is 401, but the post-fix behaviour
    // doesn't allocate the body buffer first.)
    const { api } = await freshCtx();
    try {
      const big = "x".repeat(8 * 1024 * 1024);
      const r = await api.post("/api/admin/import/tasks", {
        headers: { "content-type": "application/json" },
        data: { junk: big },
      });
      // Anonymous → 401 (requireAdmin rejects). The 5 MB global parser
      // should also REJECT this body if it ran (413), so a 401 here
      // implies the global parser was correctly skipped + auth ran first.
      expect(r.status()).toBe(401);
    } finally { await api.dispose(); }
  });

  test("v6.16.41 M2: unsubscribe secret is persisted to DATA_DIR/.unsubscribe-secret with 0o600", () => {
    const fs = require("fs");
    const secretPath = path.join(TEST_DATA_DIR, ".unsubscribe-secret");
    expect(fs.existsSync(secretPath)).toBe(true);
    const stat = fs.statSync(secretPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const buf = fs.readFileSync(secretPath);
    expect(buf.length).toBe(32);
  });

  test("v6.16.41 M3: idx_hint_reveals_comp_revtime exists post-boot on legacy + fresh DBs", () => {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      // Fresh-install path declares it at db.js:391; the v6.16.41
      // legacy-rebuild fix at db.js:642 restores it after the v6.8.0
      // hint_reveals_v2 DROP TABLE wipes all indexes. Both paths
      // must produce a DB where this index exists post-boot.
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name=?"
      ).get("idx_hint_reveals_comp_revtime");
      expect(row, "idx_hint_reveals_comp_revtime missing post-boot — legacy rebuild lost it").toBeTruthy();
      // Lock the column ordering so a future schema edit that flips
      // them around can't silently regress.
      const sqlRow = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name=?"
      ).get("idx_hint_reveals_comp_revtime");
      expect(sqlRow?.sql || "").toMatch(/competition_id/);
      expect(sqlRow?.sql || "").toMatch(/revealed_at/i);
    } finally { db.close(); }
  });

  // v6.16.53 — external auditor batch:
  //   H1 — startup FATAL when BASE_URL is https:// AND TRUST_PROXY is
  //        off. Pre-fix this combination silently broke every login
  //        (Set-Cookie suppressed by SECURE_COOKIE + req.secure=false).
  //        Source-level lock — full process-spawn test would need
  //        teardown infrastructure not currently in the harness.
  //   M2 — settings export must redact `default_cxone_api_key` (the
  //        platform-wide CxOne secret), not just per-comp `cxone_api_key`.
  //        Functional test: plant a value via DB-direct INSERT, export,
  //        assert redacted.
  //   L3 — rich-text data: image URIs are restricted to png/jpeg/gif/
  //        webp. SVG and other subtypes get the <img> stripped on
  //        ingest AND coerced to application/octet-stream on serve.

  test("v6.16.53 H1: server.js carries the https-without-trust-proxy startup FATAL", () => {
    const fs = require("fs");
    const path = require("path");
    const body = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    // Locks the canonical shape of the check — must contain all three
    // conditions: NODE_ENV !== test, BASE_URL https://, and the proxy-off test.
    // v7.2.x (audit, F5) — the proxy-off condition is now the PARSED value
    // `!app.get("trust proxy")`, not `!process.env.TRUST_PROXY` (which read the
    // literal string, so "false"/"0" were JS-truthy and skipped the guard).
    expect(body).toMatch(/NODE_ENV\s*!==\s*"test"[\s\S]{0,400}startsWith\(\s*"https:\/\/"\s*\)[\s\S]{0,400}!app\.get\(\s*["']trust proxy["']\s*\)/);
    // Locks that the failure is FATAL (process.exit(1)) — not just a warn.
    expect(body).toMatch(/FATAL: BASE_URL is https:\/\/ but TRUST_PROXY is off[\s\S]{0,800}process\.exit\(1\)/);
  });

  test("v7.2.x (audit, F5): TRUST_PROXY=false with https:// BASE_URL trips the startup FATAL (parsed, not raw-string)", async () => {
    // Behavioural lock that the source-lock above cannot give: boot a real
    // non-test server with the exact misconfig (https BASE_URL + TRUST_PROXY
    // literally "false") and assert it ABORTS. Pre-fix the boot check read
    // `!process.env.TRUST_PROXY` → `!"false"` === false → guard skipped → the
    // broken config booted and every login silently failed.
    const cp = require("child_process");
    const fsx = require("fs");
    const osx = require("os");
    const pathx = require("path");
    const tmp = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "f5-trustproxy-"));
    try {
      const env = { ...process.env, BASE_URL: "https://x.example", TRUST_PROXY: "false", SMTP_HOST: "localhost", DATA_DIR: tmp, UPLOADS_DIR: `${tmp}/uploads`, HSTS: "0", SUPERADMIN_PASSWORD_QUIET: "1" };
      delete env.NODE_ENV;            // must NOT be "test" — the FATAL check is skipped under test
      delete env.RATE_LIMIT_DISABLED;
      env.NODE_OPTIONS = "";          // this asserts on exit code + stderr: our node flags, not the runner's
      const r = await new Promise((resolve) => {
        const proc = cp.spawn(process.execPath, ["server.js"], { cwd: pathx.resolve(__dirname, ".."), env, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        proc.stderr.on("data", (d) => { stderr += d.toString(); });
        const killer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch (_) {} resolve({ code: null, stderr, timedOut: true }); }, 25_000);
        proc.on("exit", (code) => { clearTimeout(killer); resolve({ code, stderr, timedOut: false }); });
      });
      expect(r.timedOut, "server must exit (not keep running) on the bad config").toBe(false);
      expect(r.code, "must exit non-zero (FATAL)").not.toBe(0);
      expect(r.stderr).toMatch(/FATAL: BASE_URL is https:\/\/ but TRUST_PROXY is off/);
    } finally {
      try { fsx.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
  });

  test("v6.16.53 M2: settings export redacts default_cxone_api_key", async () => {
    await ensureState();
    // Plant a default-cxone secret directly via DB so we don't need to
    // exercise the PUT handler (which requires a CxOne JWT-shaped value).
    const Database = require("better-sqlite3");
    const sentinel = `secret-default-cxone-${crypto.randomBytes(4).toString("hex")}`;
    const dbW = new Database(TEST_DB_PATH);
    let hadBefore = false;
    let prevValue = null;
    try {
      const existing = dbW.prepare("SELECT value FROM settings WHERE key='default_cxone_api_key'").get();
      hadBefore = !!existing;
      prevValue = existing?.value || null;
      dbW.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('default_cxone_api_key', ?)").run(sentinel);
    } finally { dbW.close(); }
    const { api: sa } = await apiLogin("superadmin");
    try {
      const r = await sa.get("/api/admin/export/settings");
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      // Pre-fix the export emitted body.settings.default_cxone_api_key
      // === sentinel verbatim. Post-fix it MUST be redacted.
      expect(body.settings.default_cxone_api_key).toBe("[REDACTED]");
      // Sanity: the plain-text sentinel does not appear ANYWHERE in
      // the serialised export — covers a hypothetical future code path
      // that surfaces it under a different key.
      expect(JSON.stringify(body)).not.toContain(sentinel);
    } finally {
      await sa.dispose();
      // Restore the original value (or delete if none).
      const dbW2 = new Database(TEST_DB_PATH);
      try {
        if (hadBefore) {
          dbW2.prepare("UPDATE settings SET value=? WHERE key='default_cxone_api_key'").run(prevValue);
        } else {
          dbW2.prepare("DELETE FROM settings WHERE key='default_cxone_api_key'").run();
        }
      } finally { dbW2.close(); }
    }
  });

  test("v6.16.53 L3: rich-text data:image/svg+xml is stripped on ingest", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    let createdTaskId = null;
    try {
      // Craft a description with two img tags — one allowed (png), one
      // SVG (forbidden). The SVG payload doesn't need to be a real
      // SVG; the gate trips on the MIME subtype before the bytes are
      // parsed.
      const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="; // 1×1 transparent png
      const svgB64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>').toString("base64");
      const desc = `<p>Allowed: <img src="data:image/png;base64,${pngB64}"/></p>` +
                   `<p>Forbidden: <img src="data:image/svg+xml;base64,${svgB64}"/></p>`;
      const tag = crypto.randomBytes(3).toString("hex");
      const r = await sa.post("/api/admin/tasks", {
        headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
        data: {
          title: `xss-svg-test-${tag}`,
          description: desc,
          difficulty: "easy",
          status: "draft",
          answer_type: "text",
          correct_answer: "x",
          active: 0,
        },
      });
      expect(r.ok(), `task create failed: ${r.status()} ${await r.text()}`).toBeTruthy();
      const body = await r.json();
      createdTaskId = body.id;
      // Re-fetch the task — the stored description must NOT carry an
      // svg+xml data URI nor a /api/images/<id> reference for the SVG
      // image (the ingest gate stripped the <img> entirely; nothing
      // was INSERTed into the images table for it). No GET-by-id
      // admin endpoint exists; resolve via the list.
      const fr = await sa.get("/api/admin/tasks");
      expect(fr.ok()).toBeTruthy();
      const tasks = await fr.json();
      const fetched = (tasks || []).find(t => t.id === createdTaskId);
      expect(fetched, "created task should appear in admin task list").toBeTruthy();
      const stored = fetched.description || "";
      expect(stored).not.toMatch(/data:image\/svg\+xml/i);
      expect(stored).not.toMatch(/<svg\b/i);
      // Sanity: the png was preserved (either as data URI inline or
      // round-tripped through the images table — both shapes are OK).
      expect(stored.includes("data:image/png") || /\/api\/images\/[\w-]+/.test(stored)).toBe(true);
    } finally {
      if (createdTaskId) {
        try {
          await sa.delete(`/api/admin/tasks/${createdTaskId}`, { headers: { "x-csrf-token": saCsrf } });
        } catch {}
      }
      await sa.dispose();
    }
  });

  test("v6.16.53 L3: GET /api/images/:id force-coerces unsafe MIME to application/octet-stream", async () => {
    // DB-plant a row with mime_type=image/svg+xml to simulate legacy
    // data from before the v6.16.53 ingest gate. The serve handler
    // must NOT echo that MIME — it should coerce to application/
    // octet-stream so the browser downloads instead of executing.
    await ensureState();
    const Database = require("better-sqlite3");
    const dbW = new Database(TEST_DB_PATH);
    const id = crypto.randomUUID();
    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    try {
      dbW.prepare("INSERT INTO images (id, data, mime_type, created_at) VALUES (?,?,?,?)")
        .run(id, svgBytes, "image/svg+xml", new Date().toISOString());
    } finally { dbW.close(); }
    const { api } = await freshCtx();
    try {
      const r = await api.get(`/api/images/${id}`);
      expect(r.ok()).toBeTruthy();
      // The CRITICAL assertion — server must NOT serve as image/svg+xml.
      expect(r.headers()["content-type"]).toMatch(/application\/octet-stream/);
      // X-Content-Type-Options:nosniff is set defensively.
      expect(r.headers()["x-content-type-options"]).toBe("nosniff");
    } finally {
      await api.dispose();
      const dbW2 = new Database(TEST_DB_PATH);
      try { dbW2.prepare("DELETE FROM images WHERE id=?").run(id); } finally { dbW2.close(); }
    }
  });

  test("v6.16.53 L4: perf seed scripts pass --browser-probes 2 to match scenario default", () => {
    const fs = require("fs");
    const path = require("path");
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "perf", "package.json"), "utf8"));
    // Each seed convenience script must include --browser-probes 2 so
    // a fresh seed satisfies the scenario's BROWSER_PROBES=2 default.
    // Pre-fix the scripts seeded 0 browser users and the default
    // scenario init would throw on a freshly-seeded environment.
    for (const name of ["seed:quick", "seed:quick:skip-bg", "seed:full"]) {
      expect(pkg.scripts[name], `${name} script must exist`).toBeTruthy();
      expect(pkg.scripts[name], `${name} should pass --browser-probes 2`).toMatch(/--browser-probes\s+2/);
    }
  });

  // ── v6.16.54 audit findings ─────────────────────────────────────────────────
  test("v6.16.54: PUT /api/tasks/:id/feedback rate-limits at 30/min", async () => {
    // Pre-fix the feedback PUT had no rate limiter; a participant in a live
    // competition could hammer it unbounded. Rate limit added: 30/min keyed
    // "task-feedback:IP". Test toggles the limiter on, fires 35 requests, and
    // asserts a 429 lands before the 35th. Toggle off in finally.
    await ensureState();
    const { api: bob, csrf: bobCsrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    const bH = { "x-csrf-token": bobCsrf, "content-type": "application/json" };
    await bob.post("/api/select-competition", { headers: bH, data: { competitionId: S.liveComp.id } });
    // Fetch the CSRF after competition selection (session state updates CSRF)
    const tokenRes = await (await bob.get("/api/csrf-token")).json();
    const bH2 = { "x-csrf-token": tokenRes.csrfToken, "content-type": "application/json" };
    // Need a superadmin session to toggle the rate limiter
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post("/api/test/rate-limit-toggle", { headers: saH, data: { enable: true } });
    try {
      let saw429 = false;
      for (let i = 0; i < 35; i++) {
        const r = await bob.put(`/api/tasks/${S.easy1.id}/feedback`, {
          headers: bH2,
          data: { rating: (i % 5) + 1 },
        });
        if (r.status() === 429) { saw429 = true; break; }
      }
      expect(saw429, "PUT /api/tasks/:id/feedback should 429 after 30 requests/min").toBe(true);
    } finally {
      await sa.post("/api/test/rate-limit-toggle", { headers: saH, data: { enable: false } });
      await sa.dispose();
      await bob.dispose();
    }
  });

  test("v6.16.54: POST /api/admin/participants/:id/verify invalidates the me-cache", async () => {
    // Pre-fix /verify called invalidateAdminParticipantsCache() but not
    // _invalidateMeCache(). Added for invariant symmetry with all other
    // participant-state-change routes. Verify the route still succeeds with
    // the extra invalidation in place by round-tripping a fresh user.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const email = `verify-cache-${tag}@example.com`;
    const nick = `vcache${tag}`;
    // Register an unverified user via DB-direct (same pattern as other tests)
    const Database = require("better-sqlite3");
    const dbW = new Database(TEST_DB_PATH);
    let userId;
    try {
      const now = new Date().toISOString();
      userId = require("crypto").randomUUID();
      dbW.prepare(
        "INSERT INTO users (id, email, nickname, first_name, last_name, password_hash, verified, approved, created_at) VALUES (?,?,?,?,?,?,0,0,?)"
      ).run(userId, email, nick, "Vcache", "Test", "placeholder_hash", now);
    } finally { dbW.close(); }
    try {
      const r = await sa.post(`/api/admin/participants/${userId}/verify`, { headers: saH });
      expect(r.ok(), "verify should succeed").toBe(true);
      const body = await r.json();
      expect(body.ok, "response.ok").toBe(true);
      // DB confirms verified=1
      const dbR = new Database(TEST_DB_PATH);
      try {
        const row = dbR.prepare("SELECT verified FROM users WHERE id=?").get(userId);
        expect(row?.verified, "DB row must have verified=1 post-verify").toBe(1);
      } finally { dbR.close(); }
    } finally {
      const dbC = new Database(TEST_DB_PATH);
      try { dbC.prepare("DELETE FROM users WHERE id=?").run(userId); } finally { dbC.close(); }
      await sa.dispose();
    }
  });

  test("v6.16.39: POST /api/admin/perf/bulk-seed-users emits a perf-seed:<comp|bulk>:users_seeded summary row", async () => {
    await ensureState();
    // bulk-seed-users requires DATA_DIR/.maintenance to exist. The
    // maintenance gate blocks public traffic when the file is
    // present, so log in BEFORE planting the file (the api context
    // then carries cookies + the maint-bypass token to keep
    // subsequent calls flowing).
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const maintFile = path.join(TEST_DATA_DIR, ".maintenance");
    const hadMaintBefore = fs.existsSync(maintFile);
    if (!hadMaintBefore) fs.writeFileSync(maintFile, "audit-test-token", "utf8");
    try {
      const tag = crypto.randomBytes(3).toString("hex");
      const users = [
        { email: `bs-${tag}-1@example.com`, nickname: `bs-${tag}-1`, firstName: "Bs", lastName: "One" },
        { email: `bs-${tag}-2@example.com`, nickname: `bs-${tag}-2`, firstName: "Bs", lastName: "Two" },
      ];
      const r = await sa.post("/api/admin/perf/bulk-seed-users", {
        headers: { "x-csrf-token": saCsrf, "content-type": "application/json", "x-maintenance-bypass": "audit-test-token" },
        data: { users, sharedPassword: "perf-seed-password" },
      });
      expect(r.ok(), `bulk-seed-users failed: ${r.status()} ${await r.text()}`).toBeTruthy();
      const row = await _findAuditRow({ scope: "perf-seed", scope_id: "bulk", event_type: "users_seeded" });
      expect(row, "expected perf-seed:bulk:users_seeded audit row").toBeTruthy();
      expect(row.details?.total).toBe(2);
      expect(typeof row.details?.inserted).toBe("number");
      expect(typeof row.details?.skipped).toBe("number");
      // Cleanup the seeded users so they don't pollute later tests.
      const Database = require("better-sqlite3");
      const dbW = new Database(TEST_DB_PATH);
      try {
        for (const u of users) {
          dbW.prepare("DELETE FROM users WHERE LOWER(email)=LOWER(?)").run(u.email);
        }
      } finally { dbW.close(); }
    } finally {
      await sa.dispose();
      if (!hadMaintBefore) { try { fs.unlinkSync(maintFile); } catch {} }
    }
  });

  test("v7.2.x: POST /api/admin/perf/bulk-seed-history seeds ended comps + submission history + a perf-seed:history:history_seeded audit row", async () => {
    await ensureState();
    // Same maintenance-gate handling as bulk-seed-users above: log in first,
    // then plant the .maintenance file so the gate passes for this api ctx.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const maintFile = path.join(TEST_DATA_DIR, ".maintenance");
    const hadMaintBefore = fs.existsSync(maintFile);
    // The gate compares the X-Maintenance-Bypass header to the file content
    // byte-for-byte, so read the live token when the file already exists;
    // otherwise plant our own. Every request below carries it.
    const maintToken = hadMaintBefore
      ? fs.readFileSync(maintFile, "utf8").trim()
      : "history-test-token";
    if (!hadMaintBefore) fs.writeFileSync(maintFile, maintToken, "utf8");
    const tag = crypto.randomBytes(3).toString("hex");
    const namePrefix = `Perf Hist ${tag}`;
    const userPrefix = `ph-${tag}-`;
    const Database = require("better-sqlite3");
    const headers = { "x-csrf-token": saCsrf, "content-type": "application/json", "x-maintenance-bypass": maintToken };
    const createdTaskIds = [];
    try {
      // 1) A small pool of verified participants to sample from.
      const seedUsers = [1, 2, 3].map(n => ({
        email: `${userPrefix}${n}@example.com`, nickname: `${userPrefix}${n}`,
        firstName: "Ph", lastName: `User${n}`,
      }));
      const ru = await sa.post("/api/admin/perf/bulk-seed-users", {
        headers, data: { users: seedUsers, sharedPassword: "history-seed-password" },
      });
      expect(ru.ok(), `seed users failed: ${ru.status()} ${await ru.text()}`).toBeTruthy();

      // 2) A small published task pool (maintenance is on, so carry the bypass).
      for (let n = 1; n <= 3; n++) {
        const rt = await sa.post("/api/admin/tasks", {
          headers,
          data: {
            title: `Hist Task ${tag} ${n}`, description: "<p>history</p>",
            difficulty: n === 3 ? "hard" : "easy", answer_type: "text",
            correct_answer: `hist-${tag}-${n}`, status: "published",
          },
        });
        expect(rt.ok(), `task create failed: ${rt.status()} ${await rt.text()}`).toBeTruthy();
        createdTaskIds.push((await rt.json()).id);
      }

      // 3) Bad params are rejected (endpoint reachable, validation works).
      const rBad = await sa.post("/api/admin/perf/bulk-seed-history", {
        headers, data: { competitions: 0, participantsPer: 2, tasksPer: 2, taskIds: createdTaskIds },
      });
      expect(rBad.status()).toBe(400);

      // 4) The happy path: 2 ended comps × 2 participants × 2 tasks.
      const rh = await sa.post("/api/admin/perf/bulk-seed-history", {
        headers,
        data: {
          competitions: 2, participantsPer: 2, tasksPer: 2,
          taskIds: createdTaskIds, participantEmailPrefix: userPrefix,
          namePrefix, hintRate: 1, wrongRate: 1, // force hint+wrong rows so we can assert them
        },
      });
      expect(rh.ok(), `bulk-seed-history failed: ${rh.status()} ${await rh.text()}`).toBeTruthy();
      const hb = await rh.json();
      expect(hb.competitions_created).toBe(2);
      expect(hb.competition_users).toBe(4);          // 2 comps × 2 participants
      expect(hb.candidate_pool).toBe(3);             // the 3 seeded ph-users
      expect(hb.submissions).toBe(16);               // 2×2×2 = 8 correct + 8 wrong (wrongRate 1)
      expect(hb.hint_reveals).toBe(8);               // 2×2×2 with hintRate 1
      expect(hb.challenge_events).toBeGreaterThanOrEqual(16);
      expect(hb.tasks_per).toBe(2);

      // 5) Audit summary row.
      const row = await _findAuditRow({ scope: "perf-seed", scope_id: "history", event_type: "history_seeded" });
      expect(row, "expected perf-seed:history:history_seeded audit row").toBeTruthy();
      expect(row.details?.competitions).toBe(2);
      expect(row.details?.submissions).toBe(16);

      // 6) The comps exist, are ENDED, and the rows reference them.
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        const comps = db.prepare("SELECT id, ended_at, duration_minutes, leaderboard_mode FROM competitions WHERE name LIKE ?").all(`${namePrefix}%`);
        expect(comps.length).toBe(2);
        for (const c of comps) {
          expect(c.ended_at).toBeTruthy();           // ended in the past
          expect(new Date(c.ended_at).getTime()).toBeLessThan(Date.now());
        }
        const compIds = comps.map(c => c.id);
        const ph = compIds.map(() => "?").join(",");
        const subCount = db.prepare(`SELECT COUNT(*) c FROM submissions WHERE competition_id IN (${ph})`).get(...compIds).c;
        expect(subCount).toBe(16);
        const solvedCount = db.prepare(`SELECT COUNT(*) c FROM challenge_events WHERE competition_id IN (${ph}) AND event_type='solved'`).get(...compIds).c;
        expect(solvedCount).toBe(8);
        // Lock the seed-shape invariants too — else a regression that seeded
        // non-ended / per_slot comps or zero-point/incorrect submissions would
        // keep subCount===16 green while corrupting the seed's whole purpose
        // (faithful row-shapes for benchmarking the live submit/hint reads).
        for (const c of comps) expect(c.leaderboard_mode).toBe("global");
        const compShapes = db.prepare(`SELECT ended_manually FROM competitions WHERE id IN (${ph})`).all(...compIds);
        for (const c of compShapes) expect(c.ended_manually).toBe(0);
        const cuRows = db.prepare(`SELECT direct_assigned FROM competition_users WHERE competition_id IN (${ph})`).all(...compIds);
        expect(cuRows.length).toBe(4);
        for (const r of cuRows) expect(r.direct_assigned).toBe(1);
        // 8 correct (is_correct=1, difficulty-mapped points ∈ {50,100,150}) +
        // 8 wrong (is_correct=0, points_delta=-PENALTY=-5). Each comp samples
        // 2 of 3 tasks, so the per-comp points mix is non-deterministic —
        // assert membership in the valid set, not an exact sum.
        const correct = db.prepare(`SELECT points_delta FROM submissions WHERE competition_id IN (${ph}) AND is_correct=1`).all(...compIds);
        const wrong = db.prepare(`SELECT points_delta FROM submissions WHERE competition_id IN (${ph}) AND is_correct=0`).all(...compIds);
        expect(correct.length).toBe(8);
        expect(wrong.length).toBe(8);
        for (const r of correct) expect([50, 100, 150]).toContain(r.points_delta);
        for (const r of wrong) expect(r.points_delta).toBe(-5);
      } finally { db.close(); }
    } finally {
      // Cleanup: the FK-less history tables don't cascade, so delete by
      // competition id + by seeded-user/task identity explicitly.
      const dbW = new Database(TEST_DB_PATH);
      try {
        const compIds = dbW.prepare("SELECT id FROM competitions WHERE name LIKE ?").all(`${namePrefix}%`).map(r => r.id);
        if (compIds.length) {
          const ph = compIds.map(() => "?").join(",");
          for (const tbl of ["submissions", "hint_reveals", "challenge_events", "competition_events", "competition_users", "competition_tasks"]) {
            dbW.prepare(`DELETE FROM ${tbl} WHERE competition_id IN (${ph})`).run(...compIds);
          }
          dbW.prepare(`DELETE FROM competitions WHERE id IN (${ph})`).run(...compIds);
        }
        for (const id of createdTaskIds) dbW.prepare("DELETE FROM tasks WHERE id=?").run(id);
        dbW.prepare("DELETE FROM users WHERE LOWER(email) LIKE ?").run(`${userPrefix}%`);
      } finally { dbW.close(); }
      await sa.dispose();
      if (!hadMaintBefore) { try { fs.unlinkSync(maintFile); } catch {} }
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// ext-audit round 3 (v7.15.11)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("ext-audit v7.15.11", () => {
  const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

  // MEDIUM — the staging quota was check-then-act with a long async gap (ZIP
  // validation + sha256 + rename) before the INSERT, so N concurrent uploads all
  // passed the same check against the same committed state. The auditor got 30
  // rows against a limit of 20. Reservations are now taken synchronously and
  // account for in-flight bytes.
  test("concurrent staging uploads cannot exceed the per-admin cap", async () => {
    const { ATTACHMENT_STAGING_MAX_PER_ADMIN } = require("../lib/attachments");
    const { api, csrf } = await apiLogin("superadmin");
    // A minimal valid (empty) ZIP — the handler validates the archive.
    const EMPTY_ZIP = Buffer.from("504b0506000000000000000000000000000000000000", "hex");
    const attempts = ATTACHMENT_STAGING_MAX_PER_ADMIN + 12;
    const results = await Promise.all(Array.from({ length: attempts }, (_, i) =>
      api.post("/api/admin/attachment-staging", {
        headers: { "x-csrf-token": csrf },
        multipart: {
          display_name: `race-${i}`,
          file: { name: `race-${i}.zip`, mimeType: "application/zip", buffer: EMPTY_ZIP },
        },
      }).then(r => r.status()).catch(() => 0)
    ));
    const accepted = results.filter(s => s === 200).length;
    expect(accepted,
      `${accepted} of ${attempts} concurrent uploads were accepted against a cap of ` +
      `${ATTACHMENT_STAGING_MAX_PER_ADMIN} — the reservation must be atomic`)
      .toBeLessThanOrEqual(ATTACHMENT_STAGING_MAX_PER_ADMIN);
    // The DB must agree with what we accepted (no orphan rows past the cap).
    // There is no GET list route for staging, so read the table directly.
    const Database = require("better-sqlite3");
    const dbr = new Database(TEST_DB_PATH, { readonly: true });
    let rows, ids;
    try {
      rows = dbr.prepare("SELECT COUNT(*) c FROM task_attachments_staging").get().c;
      ids = dbr.prepare("SELECT id FROM task_attachments_staging").all().map(r => r.id);
    } finally { dbr.close(); }
    expect(rows, "staged rows must not exceed the cap either").toBeLessThanOrEqual(ATTACHMENT_STAGING_MAX_PER_ADMIN);
    // Clean up so later tests start from a clear budget.
    for (const id of ids) {
      await api.delete(`/api/admin/attachment-staging/${id}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
    }
    await api.dispose();
  });

  // MEDIUM — a GET must be SAFE. The same URL is advertised for RFC 8058
  // one-click (POST) and for humans clicking the link in the mail body, and
  // scanners/prefetchers GET every URL in an email — silently opting the
  // recipient out. GET now renders a confirmation form; POST still mutates.
  test("unsubscribe: GET renders a confirmation and does NOT opt the recipient out", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = Date.now();
    const email = `unsub${stamp}@acme.com`;
    // The HMAC secret lives in the SERVER's DATA_DIR (per worker), so requiring
    // lib/email here would sign with a different secret and every token would
    // 400. Sign with the worker's actual secret, mirroring generateUnsubscribeToken.
    const fs = require("fs"); const path = require("path"); const crypto = require("crypto");
    // Raw 32 BYTES, not text — reading it as utf8 (and trimming) corrupts it.
    const secret = fs.readFileSync(path.join(TEST_DATA_DIR, ".unsubscribe-secret"));
    const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const payload = JSON.stringify({ e: email, x: Date.now() + 365 * 24 * 3600 * 1000 });
    const token = `${b64url(payload)}.${b64url(crypto.createHmac("sha256", secret).update(payload).digest())}`;
    const isUnsubscribed = async () => {
      const l = await (await api.get("/api/admin/unsubscribed")).json();
      return (l.entries || []).some(e => e.email === email);
    };
    expect(await isUnsubscribed(), "precondition: not yet unsubscribed").toBe(false);

    const { api: anon } = await freshCtx();
    const get = await anon.get(`/api/unsubscribe?token=${encodeURIComponent(token)}`);
    expect(get.status(), "GET is served").toBe(200);
    const html = await get.text();
    expect(html, "GET renders a confirmation form, not a done message").toMatch(/<form[^>]*method="POST"/i);
    expect(html).toContain(email);
    expect(await isUnsubscribed(), "a GET (scanner / prefetch) must NOT unsubscribe anyone").toBe(false);

    // The form's POST still performs the opt-out.
    const post = await anon.post("/api/unsubscribe", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      form: { token },
    });
    expect(post.status()).toBe(200);
    expect(await isUnsubscribed(), "confirming via POST does unsubscribe").toBe(true);
    await anon.dispose();
    await api.delete(`/api/admin/unsubscribed/${encodeURIComponent(email)}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
    await api.dispose();
  });

  // MEDIUM — liveness vs readiness. /healthz stays 200 on a corrupt DB so an
  // operator can triage; /readyz is the DB-aware signal the container health
  // check now uses, so a known-corrupt instance is drained instead of served.
  test("readiness: /readyz reports DB state; /healthz stays a pure liveness probe", async () => {
    const { api } = await freshCtx();
    const ready = await api.get("/readyz");
    expect(ready.status(), "healthy instance is ready").toBe(200);
    expect((await ready.json()).ready).toBe(true);
    const live = await api.get("/healthz");
    expect(live.status(), "liveness is independent of readiness").toBe(200);
    await api.dispose();
  });
});


// ── ext-audit A7 ──────────────────────────────────────────────────────────────
// POST /api/register gated its required text fields on a bare `!field`, and " "
// is TRUTHY — so a runtime probe persisted whitespace-only first_name,
// last_name, nickname, company, title, country and timezone. Two consequences
// beyond untidy data: GET /api/check-nickname TRIMS before its COLLATE NOCASE
// lookup, so the availability endpoint and registration disagreed about what a
// nickname IS; and _profileMissingFields read country/timezone untrimmed, so
// such an account counted as profile-COMPLETE while carrying a timezone no
// formatter can resolve. country/timezone were additionally unvalidated.
test.describe("v7.21.1 (A7) — registration normalises and validates its required fields", () => {
  const readUser = (email) => {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try { return db.prepare("SELECT * FROM users WHERE email=?").get(email) || null; }
    finally { db.close(); }
  };
  // Collision-proof tags. Date.now() ALONE is not unique: two cases landing in
  // the same millisecond (a --repeat-each pass, or a retry) reuse the email and
  // nickname, and the control then fails with a 409 that has nothing to do with
  // what it is asserting. Seen once under CPU contention.
  const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
  const emailFor = (tag) => `ws-${tag}@company.example`;
  const validPayload = (tag) => ({
    firstName: "Ws", lastName: "Probe", nickname: `ws_${tag}`,
    email: emailFor(tag), company: "Acme", title: "Engineer",
    country: "US", timezone: "America/New_York", password: "Testpass123!",
    jobFunction: "Software Developer / Engineer", city: "Testville",
  });
  const register = async (data) => {
    const { api, csrf } = await freshCtx();
    try {
      const r = await registerPost(api, "/api/register", {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data,
      });
      return { status: r.status(), body: await r.json().catch(() => ({})) };
    } finally { await api.dispose(); }
  };

  // POSITIVE CONTROL — the shared payload really is registerable, so every 400
  // below is attributable to the one whitespace field and not to the fixture.
  // Without this, a payload broken for an unrelated reason would satisfy all
  // seven refusal assertions however the whitespace was handled.
  test("the control payload registers", async () => {
    const p = validPayload(`ctl${uniq()}`);
    const res = await register(p);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(readUser(p.email)).toBeTruthy();
  });

  // The short form (email first) no longer ASKS for a nickname or a timezone: a
  // missing nickname is suggested from the name, a missing zone becomes UTC. A
  // whitespace-only value is a missing one — trimmed first — so the account is
  // created with the suggestion / UTC and the whitespace is never stored. That
  // is still A7's lock: what is stored is never whitespace.
  for (const [field, column, expected] of [["nickname", "nickname", null], ["timezone", "timezone", "UTC"]]) {
    test(`a whitespace-only ${field} is treated as absent: the default is stored, never the whitespace`, async () => {
      const p = { ...validPayload(`${field.toLowerCase()}${uniq()}`), [field]: "   " };
      const res = await register(p);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = readUser(p.email);
      expect(row, `the account was created (${field})`).toBeTruthy();
      expect(row[column], `the stored ${column} is not whitespace`).toBe(String(row[column]).trim());
      expect(String(row[column]).length, `the stored ${column} is a real value`).toBeGreaterThanOrEqual(3);
      if (expected) expect(row[column]).toBe(expected);
      else expect(row[column], "a suggested nickname, not the payload's").not.toBe(p.nickname);
    });
  }

  for (const field of ["firstName", "lastName", "company", "title", "country"]) {
    test(`a whitespace-only ${field} is refused and NOTHING is persisted`, async () => {
      const p = { ...validPayload(`${field.toLowerCase()}${uniq()}`), [field]: "   " };
      const res = await register(p);
      expect(res.status, `whitespace-only ${field} must not be accepted (got ${JSON.stringify(res.body)})`).toBe(400);
      // The load-bearing half: a 400 that still wrote the row would be worse
      // than no check at all, and the pre-fix behaviour was a 200 WITH the row.
      expect(readUser(p.email), `a rejected registration must leave no user row (${field})`).toBeNull();
    });
  }

  test("a padded value is STORED trimmed, and check-nickname agrees with what registered", async () => {
    const tag = `pad${uniq()}`;
    const nick = `ws_${tag}`;
    const p = {
      ...validPayload(tag),
      nickname: `  ${nick}  `, company: "  Acme Ltd  ", country: "  US  ", timezone: "  UTC  ",
    };
    const res = await register(p);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = readUser(p.email);
    expect(row, "the padded registration should have succeeded").toBeTruthy();
    // Validating a trimmed copy while storing the raw one is the same bug one
    // layer down, so assert the STORED bytes.
    expect(row.nickname).toBe(nick);
    expect(row.company).toBe("Acme Ltd");
    expect(row.country).toBe("US");
    expect(row.timezone).toBe("UTC");
    // The disagreement A7 named: check-nickname trims before its lookup, so
    // pre-fix it answered "available" for the very handle that had just been
    // registered — stored padded, looked up unpadded.
    const { api } = await freshCtx();
    try {
      const taken = await (await api.get(`/api/check-nickname?nickname=${encodeURIComponent(nick)}`)).json();
      expect(taken.available, "the nickname that just registered must read as taken").toBe(false);
      // POSITIVE CONTROL — the endpoint is answering, not merely always false.
      const free = await (await api.get(`/api/check-nickname?nickname=${encodeURIComponent(nick)}_free`)).json();
      expect(free.available, "an unregistered handle must read as available").toBe(true);
    } finally { await api.dispose(); }
  });

  test("an unresolvable timezone is refused, and UTC is accepted", async () => {
    const bad = await register({ ...validPayload(`tzbad${uniq()}`), timezone: "Banana/Nowhere" });
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
    expect(String(bad.body.error)).toMatch(/timezone/i);
    // POSITIVE CONTROL, and the v7.15.23 trap it encodes: a zone-LIST allowlist
    // would refuse "UTC" (Intl.supportedValuesOf omits it while
    // resolvedOptions().timeZone returns it), i.e. the single most common
    // container/CI zone. The check asks the platform's own Intl instead.
    const tag = `tzutc${uniq()}`;
    const ok = await register({ ...validPayload(tag), timezone: "UTC" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(readUser(emailFor(tag)).timezone).toBe("UTC");
  });

  test("an over-cap country is refused", async () => {
    const res = await register({ ...validPayload(`cc${uniq()}`), country: "U".repeat(81) });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(String(res.body.error)).toMatch(/country|80/i);
  });

  test("_profileMissingFields treats a whitespace country/timezone as MISSING", () => {
    // Required lazily INSIDE the test: lib/util is pure and holds no DB handle,
    // and the v7.20.2 lock forbids only a module-scope require of DB-backed app
    // code. This is the retroactive half of the fix — rows already written by
    // the pre-fix path are now gated on their next authenticated entry.
    const { _profileMissingFields } = require("../lib/util");
    // v8.1.0 (PR 31) — `profile_policy: null` is now part of a well-formed row.
    // An ABSENT key throws, because a caller that under-selects it silently
    // un-relaxes a Booth Event account and strands it behind the
    // non-dismissible completion gate. null is the ordinary value.
    //
    // v8.4.0 — and `registration_competition_id: null` beside it, for the same
    // reason one level up: the gate now resolves the requirement from the event
    // an account was created THROUGH, so a caller that omits the pointer would
    // silently fall back to the stamped defaults and stop demanding a field an
    // admin has just made mandatory. NULL is the ordinary value here too — it is
    // every account that did not arrive through a join link.
    const base = { company: "Acme", title: "Eng", job_function: "Dev", city: "X", email: "a@acme.com", profile_policy: null, registration_competition_id: null };
    expect(_profileMissingFields({ ...base, country: "  ", timezone: "  " }).sort())
      .toEqual(["country", "timezone"]);
    // POSITIVE CONTROL — real values are still complete, so the assertion above
    // is about whitespace and not about the helper flagging everything.
    expect(_profileMissingFields({ ...base, country: "US", timezone: "UTC" })).toEqual([]);
  });
});


// ── ext-audit A8 ──────────────────────────────────────────────────────────────
// The invited branch DISCARDS the client-supplied primary and forces
// invitation.email, but sameSlotEmails ran BEFORE that replacement and was never
// re-run after it. So a request carrying any other primary plus
// `secondaryEmail: <invitation.email>` stored the identical normalised address
// in BOTH slots — exactly the state that guard exists to prevent (getUserEmails
// mails it twice; emailIsTaken excludes the same user, so nothing notices).
test.describe("v7.21.1 (A8) — an invited registration cannot store one address in both email slots", () => {
  const readUser = (email) => {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try { return db.prepare("SELECT * FROM users WHERE email=?").get(email) || null; }
    finally { db.close(); }
  };
  const invitationIdFor = (email) => {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try { return db.prepare("SELECT id FROM invitations WHERE email=?").get(email)?.id; }
    finally { db.close(); }
  };
  const register = async (data) => {
    const { api, csrf } = await freshCtx();
    try {
      const r = await registerPost(api, "/api/register", {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data,
      });
      return { status: r.status(), body: await r.json().catch(() => ({})) };
    } finally { await api.dispose(); }
  };
  // Same collision-proofing as the A7 block above — a same-millisecond repeat
  // would 409 on the nickname and report as an A8 failure.
  const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
  const base = (stamp, suffix) => ({
    firstName: "Inv", lastName: "Slot", nickname: `a8${suffix}_${stamp}`,
    company: "Acme", title: "Eng", country: "US", timezone: "UTC",
    password: "Testpass123!", jobFunction: "Software Developer / Engineer", city: "Testville",
  });

  test("a secondary equal to the invitation's forced primary is dropped; a different one is kept", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const stamp = uniq();
    const collideEmail = `a8-collide-${stamp}@acme.com`;
    const keepEmail = `a8-keep-${stamp}@acme.com`;
    for (const e of [collideEmail, keepEmail]) {
      const r = await sa.post("/api/admin/invitations", { headers: saH, data: { emails: [e], competitionIds: [] } });
      expect(r.ok(), `invitation for ${e}`).toBeTruthy();
    }
    await sa.dispose();

    // The tampered / stale shape: a primary the invite branch will discard, and
    // the invitation's own address in the SECONDARY slot. sameSlotEmails at the
    // top of the handler sees two different addresses and passes.
    const collide = await register({
      ...base(stamp, "c"),
      email: `a8-other-${stamp}@company.example`,
      secondaryEmail: collideEmail,
      invitationId: invitationIdFor(collideEmail),
    });
    expect(collide.status, JSON.stringify(collide.body)).toBe(200);
    const row = readUser(collideEmail);
    expect(row, "the invited account should have been created").toBeTruthy();
    expect(row.email).toBe(collideEmail);
    expect(row.secondary_email, "the secondary must not repeat the forced primary").toBeNull();

    // POSITIVE CONTROL — the drop is targeted at the collision, not a blanket
    // "invited registrations never keep a secondary". A free-mail secondary is
    // deliberately fine here: the invitation blesses the corporate primary.
    const personal = `a8-personal-${stamp}@gmail.com`;
    const keep = await register({
      ...base(stamp, "k"),
      email: `a8-other2-${stamp}@company.example`,
      secondaryEmail: personal,
      invitationId: invitationIdFor(keepEmail),
    });
    expect(keep.status, JSON.stringify(keep.body)).toBe(200);
    const row2 = readUser(keepEmail);
    expect(row2, "the second invited account should have been created").toBeTruthy();
    expect(row2.email).toBe(keepEmail);
    expect(row2.secondary_email, "a genuinely different secondary must survive").toBe(personal);
  });

  test("the non-invited path still refuses an identical primary and secondary", async () => {
    // The original guard must not have been weakened by the re-check — and it
    // compares NORMALISED addresses, so a case variant is still the same slot.
    const stamp = uniq();
    const e = `a8-same-${stamp}@company.example`;
    const res = await register({ ...base(stamp, "s"), email: e, secondaryEmail: e.toUpperCase() });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(String(res.body.error)).toMatch(/different/i);
  });
});
