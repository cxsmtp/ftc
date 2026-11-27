// @ts-check
//
// Split from functional-security.api.spec.js in v7.21.37 — it was 133s in one file, and a spec
// file never spans workers, so it bounded the whole suite's wall clock.
//
// Contains: Security hardening · v6.9.16: field-length caps on registration + profile writes · v6.9.18: CSRF matrix across mutating + multipart routes · v6.9.24: input fuzzing — SQL-injection payloads round-trip safely · v6.9.24: CxOne API-key SSRF guard (v6.8.5 tightening) · v6.9.24: delete-participant self-delete + last-superadmin guards · v6.9.16: /metrics endpoint shape lock · Login identity — secondary email · Rate limiting — runtime enforcement · v6.15.0 — participants export/import fidelity · v6.16.6 — auditor invariants · Self-enrollment link — security · ext-audit v7.15.12 · v7.20.9 (F1) — the grading token discloses nothing, and submit requires it · v7.20.9 (F7) — a duplicate startup must not claim the shared credential file
const { test, expect } = require("./isolated-test");
const { registerPost, entryCode } = require("./helpers");
const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { createClient, freshCtx, apiLogin, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, TEST_DATA_DIR, PORT_BASE, BASE, gradingHashFor, codeLogin } = require("./helpers");

// v7.21.37 — `S` / ensureState / aliceInLive moved to ./seeded-state as a
// FACTORY. Each spec file gets its OWN cache: per-file isolation re-seeds the
// database before every file, so one shared `S` would hand this file ids from
// the previous file's database.
const { makeState } = require("./seeded-state");
const { S, ensureState, aliceInLive } = makeState();

// ═══════════════════════════════════════════════════════════════════════════════
// PARTICIPANT FLOWS
// ═══════════════════════════════════════════════════════════════════════════════
// v7.21.37 — hoisted here from between two describes so the file can be
// split: a binding declared outside every describe belongs to whichever
// part inherits it, and the others fail with a bare ReferenceError.
const _v8h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });



// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY HARDENING — TRUST_PROXY SPOOFING + INVITATION RACE
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Security hardening", () => {
  test("TRUST_PROXY unset — X-Forwarded-For does not spoof req.ip", async () => {
    await ensureState();
    // Spoofed header — if trust proxy were enabled (or unconditional), this would
    // be what gets recorded as the client IP for the login event.
    const spoofed = "9.9.9.9";
    const { api, csrf } = await freshCtx();
    const r = await codeLogin(api, "alice@acme.com", { "x-csrf-token": csrf, "content-type": "application/json", "x-forwarded-for": spoofed });
    expect(r.ok()).toBeTruthy();
    await api.dispose();
    // Read Alice's most recent login_success event via superadmin.
    const { api: sa } = await apiLogin("superadmin");
    const events = await (await sa.get(`/api/admin/participants/${S.alice.id}/events`)).json();
    const login = events.find(e => e.event_type === "login_success");
    expect(login).toBeTruthy();
    // Without TRUST_PROXY set, req.ip is the socket peer, not the spoofed header.
    // On localhost tests that's typically "::1" or "127.0.0.1" — the important
    // thing is it is NOT the spoofed value.
    expect(login.details.ip).not.toBe(spoofed);
    await sa.dispose();
  });

  test("invitation claim is atomic — concurrent registrations yield exactly one user", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Create a fresh invitation for a unique email. No competitions — keeps the
    // test focused on the race gate, not on assignment side-effects.
    const inviteEmail = `racetest-${Date.now()}@acme.com`;
    const createRes = await sa.post("/api/admin/invitations", {
      headers: saH, data: { emails: [inviteEmail], competitionIds: [] },
    });
    expect(createRes.ok()).toBeTruthy();
    // Look up the invitation id directly in the test DB (no admin endpoint
    // exposes invitation IDs, and the normal UX is via emailed link).
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const inv = db.prepare("SELECT id FROM invitations WHERE email=?").get(inviteEmail);
    db.close();
    expect(inv?.id).toBeTruthy();
    const invitationId = inv.id;
    await sa.dispose();
    // Email first: the form is reached only by a session holding a live sign-up
    // grant for the invitation's address. TWO browsers each redeem their own
    // address proof (one after the other: a new proof supersedes the last, but a
    // redeemed grant lives in its session), so both hold a live grant for the
    // same invitation; then both forms are submitted AT ONCE. Different
    // nicknames so neither hits the UNIQUE constraint — what can reject one of
    // them is the invitation claim or the address being taken by the winner.
    const granted = async () => {
      const { api, csrf } = await freshCtx();
      let h = { "x-csrf-token": csrf, "content-type": "application/json" };
      await api.post("/api/test/reset-recent-code-sends", { headers: h });
      const rq = await api.post("/api/auth/code/request", { headers: h, data: { email: inviteEmail, invitationId } });
      expect((await rq.json()).ok).toBe(true);
      const last = await (await api.get("/api/test/last-login-code?email=" + encodeURIComponent(inviteEmail))).json();
      expect(last.via, "the invitation's address is sent an address proof").toBe("proof");
      const rd = await (await api.post("/api/auth/code/redeem", { headers: h, data: { email: inviteEmail, code: last.code } })).json();
      expect(rd.needsProfile, `the proof grants the sign-up: ${JSON.stringify(rd)}`).toBe(true);
      h = { ...h, "x-csrf-token": (await (await api.get("/api/csrf-token")).json()).csrfToken };
      return { api, h };
    };
    const ga = await granted();
    const gb = await granted();
    const mk = async ({ api, h }, suffix) => {
      const r = await api.post("/api/register", {
        headers: h,
        data: {
          firstName: "Race", lastName: `Tester${suffix}`, nickname: `racer_${suffix}_${Date.now()}`,
          email: `racer-${suffix}-${Date.now()}@company.com`,
          company: "Co", title: "Eng", avatar: "🦊",
          country: "US", timezone: "America/New_York",
          invitationId,
        },
      });
      const body = await r.json().catch(() => ({}));
      const out = { status: r.status(), body };
      await api.dispose();
      return out;
    };
    const [a, b] = await Promise.all([mk(ga, "a"), mk(gb, "b")]);
    // Exactly one should succeed; the other should return 409.
    const successes = [a, b].filter(x => x.status === 200);
    const conflicts = [a, b].filter(x => x.status === 409);
    expect(successes.length, `exactly one 200: ${JSON.stringify([a, b])}`).toBe(1);
    expect(conflicts.length, `exactly one 409: ${JSON.stringify([a, b])}`).toBe(1);
    // v8.2.3 — WHICH of the two correct refusals the loser gets is scheduling,
    // not behaviour, and asserting one of them was a flake waiting to happen.
    //
    // An invitation FORCES the primary email to the invited address, so both
    // racers try to insert the SAME address however different the ones they
    // sent were — and `routes/auth.js` has two gates between them, separated by
    // a ~100 ms bcrypt await: `emailIsTaken(primaryEmail)` just before the
    // transaction, and the `used_at IS NULL` claim inside it. A loser that
    // finishes bcrypt after the winner's INSERT lands on the first and is told
    // the email is taken; one that gets there before it lands on the second.
    // MEASURED over 30 concurrent pairs: 29 email-taken, 1 invitation-claimed —
    // and the real suite has produced the other one, which is how this surfaced.
    // Both are true, both are 409, and the invariant the test is NAMED for
    // (exactly one user, invitation claimed to them) is asserted below and held
    // in every one of those 30 races.
    expect(conflicts[0].body.error, `the loser is refused for a real reason, not a generic failure: ${JSON.stringify(conflicts[0])}`)
      .toMatch(/invitation.*already.*used|email is already registered|already has an account/i);
    // Verify via admin API that exactly one user was created and the invitation
    // is now claimed (used_at set in DB).
    const { api: sa2 } = await apiLogin("superadmin");
    const parts = (await (await sa2.get("/api/admin/participants?limit=500")).json()).participants;
    const created = parts.filter(p => p.invitation_id === invitationId);
    expect(created.length).toBe(1);
    await sa2.dispose();
    // And the DB confirms used_at is set.
    const db2 = new Database(TEST_DB_PATH, { readonly: true });
    const finalInv = db2.prepare("SELECT used_at, user_id FROM invitations WHERE id=?").get(invitationId);
    db2.close();
    expect(finalInv.used_at).toBeTruthy();
    expect(finalInv.user_id).toBe(created[0].id);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL FORMAT VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════
// isFreeEmail() is a domain denylist, not a format check. Without an
// up-front format gate, garbage like "not-an-email" passes (no domain
// match → treated as non-free → "company email" → accepted). The bad
// value then becomes a recipient string for verification / approval /
// reset / reminder mail and silently breaks delivery. Every account-flow
// entry point now validates format before any uniqueness or free-email
// check.
test.describe("v6.9.16: field-length caps on registration + profile writes", () => {
  // `_capsOk` enforces first_name≤80, last_name≤80, nickname≤40,
  // company≤120, title≤150, secondary_email≤254, linkedin_url≤500 on
  // every write path. Before this test the only coverage was avatar
  // (~400KB). A regression that drops a cap would let a caller store
  // megabytes of text in a displayed leaderboard cell.
  test("POST /api/register rejects over-cap nickname with 400", async () => {
    const { api, csrf } = await freshCtx();
    const r = await registerPost(api, "/api/register", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        firstName: "Cap", lastName: "Test",
        nickname: "a".repeat(41), // cap is 40
        email: `cap-${Date.now()}@company.example`, company: "C", title: "T",
        avatar: "🦊", country: "US", timezone: "America/New_York",
      },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/nickname|40/i);
    await api.dispose();
  });

  test("POST /api/register rejects over-cap first_name with 400", async () => {
    const { api, csrf } = await freshCtx();
    const r = await registerPost(api, "/api/register", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        firstName: "a".repeat(81), lastName: "Test",
        nickname: `cap_${Date.now()}`,
        email: `cap-${Date.now()}@company.example`, company: "C", title: "T",
        avatar: "🦊", country: "US", timezone: "America/New_York",
      },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/first_name|80/i);
    await api.dispose();
  });

  test("POST /api/register rejects over-cap linkedin_url with 400", async () => {
    const { api, csrf } = await freshCtx();
    const r = await registerPost(api, "/api/register", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        firstName: "Cap", lastName: "Test",
        nickname: `cap_${Date.now()}`,
        email: `cap-${Date.now()}@company.example`, company: "C", title: "T",
        avatar: "🦊", country: "US", timezone: "America/New_York",
        linkedinUrl: "https://linkedin.com/in/" + "a".repeat(500),
      },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/linkedin_url|500/i);
    await api.dispose();
  });

  test("PUT /api/me rejects over-cap company with 400", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const me = await (await api.get("/api/me")).json();
    const r = await api.put("/api/me", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        firstName: me.first_name, lastName: me.last_name, nickname: me.nickname,
        email: me.email, company: "a".repeat(121), title: me.title,
        country: me.country, timezone: me.timezone, avatar: me.avatar,
      },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/company|120/i);
    await api.dispose();
  });

  test("ext-audit F6: POST /api/admin/competitions rejects an over-120-char name (400)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/competitions", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: "C".repeat(121), start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/120 characters/i);
    await api.dispose();
  });

  test("ext-audit F6: POST /api/admin/competitions rejects an absurd duration (>365 days) (400)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/competitions", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: `Cap Dur ${Date.now()}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 525601 },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/525600|365 days/i);
    await api.dispose();
  });

  test("ext-audit batch 3: PUT competition (edit path) enforces the same name/duration caps", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const id = (await (await api.post("/api/admin/competitions", { headers: H, data: { name: `EditCap ${Date.now()}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 } })).json()).competition.id;
    const overName = await api.put(`/api/admin/competitions/${id}`, { headers: H, data: { name: "C".repeat(121) } });
    expect(overName.status()).toBe(400);
    expect((await overName.json()).error).toMatch(/120 characters/i);
    const overDur = await api.put(`/api/admin/competitions/${id}`, { headers: H, data: { duration_minutes: 525601 } });
    expect(overDur.status()).toBe(400);
    expect((await overDur.json()).error).toMatch(/525600|365 days/i);
    await api.dispose();
  });

  test("ext-audit batch 3: POST competition REJECTS an oversized initial tag (was silently dropped)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/competitions", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: `TagCap ${Date.now()}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60, tags: ["x".repeat(51)] },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/50 characters/i);
    await api.dispose();
  });
});


test.describe("v6.9.18: CSRF matrix across mutating + multipart routes", () => {
  // Regression lock for the contract that csrfProtection sits BEFORE
  // multer in the submit middleware chain — a refactor that flips the
  // order would let multipart bodies land on disk before the CSRF
  // check fails them. Also covers a cross-section of mutating routes
  // so a missed csrfProtection on any one of them fails loud at CI.
  test("POST /api/tasks/:id/submit with a bad CSRF header returns 403 before multer parses", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { competitionId: S.liveComp.id } });
    const easy = S.tasks.find(t => t.title === "Challenge easy1");
    // Count uploads/ files BEFORE the request — if multer ran ahead of
    // csrfProtection we'd see a stranded temp file here.
    const fs = require("fs");
    const path = require("path");
    // v7.15.4 — THIS WORKER's uploads dir, not the repo-root one. Every worker's
    // server used to share repo-root/uploads, so a concurrent worker's upload (or
    // the unlink after its submit) moved this count in either direction between
    // the two reads — a flake that a retry silently hid. UPLOADS_DIR is now
    // per-worker (playwright.config.js), which removes the shared state entirely.
    const uploads = path.join(TEST_DATA_DIR, "uploads");
    const before = fs.existsSync(uploads) ? fs.readdirSync(uploads).length : 0;
    const r = await api.post(`/api/tasks/${easy.id}/submit`, {
      headers: { "x-csrf-token": "obviously-bogus-token" },
      multipart: { answer: "ignored" , gradingHash: await gradingHashFor(api, easy.id)},
    });
    expect(r.status()).toBe(403);
    const after = fs.existsSync(uploads) ? fs.readdirSync(uploads).length : 0;
    expect(after, "multer must NOT have written a temp file — csrfProtection sits ahead of upload.single()").toBe(before);
    await api.dispose();
  });

  test("mutating admin routes reject missing / bad CSRF with 403", async () => {
    // Scan a handful of different mutating admin routes. Per-route
    // negative coverage was missing before v6.9.18; one positive case
    // for /api/me existed, nothing per-route admin.
    //
    // v6.16.26 — re-login per case. Pre-fix the test re-used a single
    // api context across all cases, and a refused token ENDS the session:
    // the server's EBADCSRFTOKEN handler destroys every session carrying an
    // identity (corrected v8.13.4 — this said csrf-sync "regenerates" it; it
    // destroys, and from v8.3.13 until v8.13.4 it spared the built-in
    // superadmin this test signs in as, because the handler keyed on userId).
    // Pre-v6.16.24's requireAdmin returned 403 indiscriminately so the test
    // still passed; post-v6.16.24's requireAdmin distinguishes "session is gone" (401)
    // from "no admin role" (403), and a second iteration on an ended session
    // would 401. Each iteration uses its own login → fresh session → CSRF
    // rejection genuinely fires before the destroy can leak into the next.
    await ensureState();
    // v6.20.x — broadened from 3 routes to a representative sample across every
    // mutating verb + route family (groups, timeslots, tags, settings,
    // invitations, task edit/visibility, competition lifecycle, participant
    // delete). CSRF is enforced before the handler body, so a 403 fires even on
    // a non-existent resource id — a missed csrfProtection on any family fails
    // loud here. Covers POST / PUT / PATCH / DELETE.
    const cases = [
      { path: `/api/admin/competitions`, method: "post", data: { name: "csrf-test", start_time: new Date().toISOString(), duration_minutes: 60 } },
      { path: `/api/admin/participants/${S.alice.id}/approve`, method: "post", data: {} },
      { path: `/api/admin/participants/${S.alice.id}/role`, method: "post", data: { role: "admin" } },
      { path: `/api/admin/participants/${S.alice.id}/tags`, method: "post", data: { tag: "csrf" } },
      { path: `/api/admin/participants/${S.alice.id}/tags/csrf`, method: "delete" },
      { path: `/api/admin/participants/${S.alice.id}/groups`, method: "post", data: { newName: "csrf-grp" } },
      { path: `/api/admin/participants/${S.bob.id}`, method: "delete" },
      { path: `/api/admin/groups`, method: "post", data: { name: "csrf-grp2" } },
      { path: `/api/admin/competitions/${S.liveComp.id}`, method: "put", data: { name: "x" } },
      { path: `/api/admin/competitions/${S.upcomingComp.id}/end-now`, method: "post", data: {} },
      { path: `/api/admin/competitions/${S.upcomingComp.id}/timeslots`, method: "post", data: { name: "t", start_time: new Date().toISOString(), duration_minutes: 30 } },
      { path: `/api/admin/settings`, method: "patch", data: { platform_name: "x" } },
      { path: `/api/admin/invitations`, method: "post", data: { emails: ["x@y.z"] } },
    ];
    const h = { "content-type": "application/json" }; // no csrf header
    for (const c of cases) {
      const { api } = await apiLogin("superadmin");
      try {
        const r = await api[c.method](c.path, { headers: h, data: c.data });
        expect(r.status(), `${c.method.toUpperCase()} ${c.path} without csrf header`).toBe(403);
      } finally {
        await api.dispose();
      }
    }
  });
});


test.describe("v6.9.24: input fuzzing — SQL-injection payloads round-trip safely", () => {
  // Prepared statements defend against SQL injection everywhere, so the
  // real risk is accidental string-concat queries sneaking into a
  // refactor. Lock in that nickname / company / answer fields accept
  // adversarial strings as TEXT and don't 500 / corrupt state.
  test("register + login accept adversarial SQL payloads as plain text", async () => {
    const payloads = [
      `'; DROP TABLE users; --`,
      `1' OR '1'='1`,
      `admin'/*`,
      `\`; DELETE FROM sessions; --`,
    ];
    for (const p of payloads) {
      const { api, csrf } = await freshCtx();
      // Register attempts with SQL payloads in free-text fields. Must NOT
      // 500; must either succeed (accepted as text) or reject with 4xx
      // for a different reason (e.g. non-company email).
      const r = await registerPost(api, "/api/register", {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: {
          firstName: p.slice(0, 40), lastName: "Fuzz",
          nickname: `fuzz_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
          email: `fuzz-${Date.now()}-${Math.floor(Math.random() * 1e6)}@company.example`,
          company: p.slice(0, 80), title: p.slice(0, 80),
          avatar: "🦊", country: "US", timezone: "America/New_York",
        },
      });
      expect([200, 400, 409]).toContain(r.status());
      // Users table still queryable after the payload.
      const check = await api.get("/api/check-nickname?nickname=alice_s");
      expect(check.status()).toBe(200);
      await api.dispose();
    }
  });
});


test.describe("v6.9.24: CxOne API-key SSRF guard (v6.8.5 tightening)", () => {
  // decodeCxOneApiKey rejects anything other than HTTPS and the iss
  // hostname must match [*.]iam.checkmarx.{net,com}. Lock in the guard
  // by feeding malicious iss values through the per-comp CxOne PUT.
  function makeJwt(issHost) {
    const payload = Buffer.from(JSON.stringify({ iss: issHost })).toString("base64url");
    return `header.${payload}.signature`;
  }
  test("iss with attacker-controlled suffix is rejected", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    // Should match /^(https:\/\/[^/]+)\/auth\/realms\/(.+)$/
    // and then hostname against CXONE_HOSTNAME_ALLOWED.
    const bad = [
      "https://iam.checkmarx.com.attacker.example/auth/realms/tenant",
      "http://iam.checkmarx.net/auth/realms/tenant", // http, not https
      "https://attacker.example/auth/realms/tenant",
      "https://iam.checkmarx.co/auth/realms/tenant", // close but not .com/.net
    ];
    for (const issHost of bad) {
      const r = await api.put(`/api/admin/competitions/${S.liveComp.id}/cxone`, {
        headers: h,
        data: { cxone_api_key: makeJwt(issHost) },
      });
      expect(r.status(), `bad iss=${issHost}`).toBe(400);
    }
    // Control: the valid shape still works.
    const ok = await api.put(`/api/admin/competitions/${S.liveComp.id}/cxone`, {
      headers: h,
      data: { cxone_api_key: makeJwt("https://iam.checkmarx.net/auth/realms/test_tenant") },
    });
    expect(ok.ok()).toBeTruthy();
    // Cleanup.
    await api.delete(`/api/admin/competitions/${S.liveComp.id}/cxone`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });
});


test.describe("v6.9.24: delete-participant self-delete + last-superadmin guards", () => {
  test("superadmin cannot delete their own account", async () => {
    await ensureState();
    // Promote carol to superadmin, then log in as carol and attempt self-delete.
    const { api: saBuiltin, csrf: saCsrf } = await apiLogin("superadmin");
    await saBuiltin.post(`/api/admin/participants/${S.carol.id}/role`, { headers: { "x-csrf-token": saCsrf, "content-type": "application/json" }, data: { role: "superadmin" } });
    await saBuiltin.dispose();
    try {
      const { api: carol, csrf: cCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      const r = await carol.delete(`/api/admin/participants/${S.carol.id}`, { headers: { "x-csrf-token": cCsrf } });
      // Must not succeed — either 400 ("cannot delete yourself") or 403.
      expect([400, 403]).toContain(r.status());
      await carol.dispose();
    } finally {
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: { "x-csrf-token": sa2Csrf, "content-type": "application/json" }, data: { role: "participant" } });
      await sa2.dispose();
    }
  });
});


test.describe("v6.9.16: /metrics endpoint shape lock", () => {
  test("/metrics returns Prometheus text-exposition format for admin, 401 for anon, 403 for participant", async () => {
    // Anonymous caller must 401 or 403 (never a leak)
    const { api: anon } = await freshCtx();
    const rAnon = await anon.get("/metrics");
    expect([401, 403]).toContain(rAnon.status());
    await anon.dispose();

    // Regular participant must 403
    const { api: alice } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const rAlice = await alice.get("/metrics");
    expect(rAlice.status()).toBe(403);
    await alice.dispose();

    // Admin (superadmin) must 200 with the expected exposition format.
    const { api: sa } = await apiLogin("superadmin");
    const r = await sa.get("/metrics");
    expect(r.status()).toBe(200);
    const body = await r.text();
    // Prometheus text-exposition format: each metric has a HELP line,
    // a TYPE line, and at least one sample. Lock in a few well-known
    // metric names so a rename (or accidental deletion) flunks the test.
    // Names live in the hack_arena_* namespace. Lock in the five
    // metric families the scraper dashboard depends on — a rename
    // or accidental deletion flunks the test loudly.
    expect(body).toMatch(/# HELP hack_arena_requests_total/);
    expect(body).toMatch(/# TYPE hack_arena_requests_total counter/);
    expect(body).toMatch(/hack_arena_requests_total \d/);
    expect(body).toMatch(/hack_arena_requests_by_status\{status="2xx"\} \d/);
    expect(body).toMatch(/hack_arena_latency_ms\{quantile="0\.95"\}/);
    expect(body).toMatch(/hack_arena_cache_sizes\{cache="leaderboard"\}/);
    expect(body).toMatch(/hack_arena_process_uptime_seconds \d/);
    expect(body).toMatch(/hack_arena_smtp_healthy -?\d/);
    expect(r.headers()["content-type"] || "").toMatch(/text\/plain/i);
    await sa.dispose();
  });
});





// ═══════════════════════════════════════════════════════════════════════════════
// LOGIN IDENTITY — dual-email model
// ═══════════════════════════════════════════════════════════════════════════════
// v9.0.0 — THE SECONDARY ADDRESS NEVER SIGNS IN (operator ruling, 11 Nov 2026).
// It is an unconfirmed claim anyone can make about an address no account holds,
// so every sign-in door resolves the PRIMARY only (lib/account-lookup.js
// `findUserByPrimary`): a code requested through the secondary is never minted
// for the account, and the account's code redeemed with it signs nobody in.
// The fuller matrix (password door, invitations, Add user) is
// tests/signin-hardening.api.spec.js.
test.describe("Login identity — secondary email", () => {
  test("a secondary email signs nobody in; the primary does", async () => {
    await ensureState();
    // Park a secondary address on Alice via admin edit.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const secondary = `alice-secondary-${Date.now()}@personal.com`;
    const r = await sa.put(`/api/admin/participants/${S.alice.id}`, {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { secondaryEmail: secondary },
    });
    expect(r.ok()).toBeTruthy();
    await sa.dispose();

    // v8.8.19 — the clear is in a `finally`. Five assertions sat between parking
    // the address and dropping it, and a leaked secondary changes the outcome of
    // every later profile edit on this row (the dual-email rule reads it).
    try {
      const { api, csrf } = await freshCtx();
      const viaSecondary = await codeLogin(api, secondary, { "x-csrf-token": csrf, "content-type": "application/json" });
      expect(viaSecondary.ok(), "the secondary address signs nobody in").toBe(false);
      expect((await api.get("/api/me")).status(), "…and no session exists").toBe(401);
      // Control: the primary signs Alice in.
      const viaPrimary = await codeLogin(api, "alice@acme.com", { "x-csrf-token": csrf, "content-type": "application/json" });
      expect(viaPrimary.ok()).toBeTruthy();
      const me = await (await api.get("/api/me")).json();
      expect(me.id).toBe(S.alice.id);
      await api.dispose();
    } finally {
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      await sa2.put(`/api/admin/participants/${S.alice.id}`, {
        headers: { "x-csrf-token": saCsrf2, "content-type": "application/json" },
        data: { secondaryEmail: "" },
      }).catch(() => {});
      await sa2.dispose();
    }
  });

  test("login by nickname is rejected (nickname is display-only, not an auth identifier)", async () => {
    await ensureState();
    const { api, csrf } = await freshCtx();
    // Alice's nickname is "alice_s" (seeded in helpers.js). Must NOT authenticate.
    const loginRes = await codeLogin(api, "alice_s", { "x-csrf-token": csrf, "content-type": "application/json" });
    expect(loginRes.status()).toBe(401);
    await api.dispose();
  });
});







// ═══════════════════════════════════════════════════════════════════════════════
// Rate limiting — runtime enforcement (v6.8.0)
// ═══════════════════════════════════════════════════════════════════════════════
// The regression suite runs with RATE_LIMIT_DISABLED=1 so the fixture bursts
// never trip 429s, but that left the actual limiter untested end-to-end.
// The test-only /api/test/rate-limit-toggle endpoint flips the flag at
// runtime; each test here enables it, fires enough requests to trip the
// bucket, asserts 429, and restores the default. Cleanup is aggressive
// (always reset the override) so a failure cannot leak into the rest of
// the suite.
test.describe("Rate limiting — runtime enforcement", () => {
  test.beforeEach(async () => {
    const { api, csrf } = await freshCtx();
    await api.post("/api/test/rate-limit-toggle", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { enable: true } });
    await api.dispose();
  });
  test.afterEach(async () => {
    const { api, csrf } = await freshCtx();
    await api.post("/api/test/rate-limit-toggle", { headers: { "x-csrf-token": csrf, "content-type": "application/json" }, data: { enable: false } });
    await api.dispose();
  });



  test("/api/config: 120 GETs per minute, then 429", async () => {
    const { api } = await freshCtx();
    let tripped = false;
    for (let i = 0; i < 130; i++) {
      const r = await api.get("/api/config");
      if (r.status() === 429) { tripped = true; break; }
    }
    expect(tripped).toBe(true);
    await api.dispose();
  });

  test("v6.21.0: self-enroll preview is rate-limited to 30/min per IP", async () => {
    // The limiter runs before the 404, so throwaway tokens are enough to trip
    // it — this bounds brute-force scraping of the token space.
    const { api } = await freshCtx();
    let tripped = false;
    for (let i = 0; i < 40; i++) {
      const r = await api.get(`/api/competitions/self-enroll/probe-${i}`);
      if (r.status() === 429) { tripped = true; break; }
    }
    expect(tripped).toBe(true);
    await api.dispose();
  });

  test("v6.9.16: register endpoint returns 429 after 10 POSTs/min from one IP", async () => {
    // /api/register is rate-limited to 10/min per IP. Without 429
    // coverage a future regression that drops the limiter silently
    // opens the door to automated signup / enumeration.
    const { api, csrf } = await freshCtx();
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    let tripped = false;
    for (let i = 0; i < 15; i++) {
      const r = await registerPost(api, "/api/register", { headers: h, data: {
        firstName: "RL", lastName: "Test", nickname: `rl_${Date.now()}_${i}`,
        email: `rl-${Date.now()}-${i}@company.example`, company: "C", title: "T",
        avatar: "🦊", country: "US", timezone: "America/New_York",
      }});
      if (r.status() === 429) { tripped = true; break; }
    }
    expect(tripped).toBe(true);
    await api.dispose();
  });

  test("v6.9.16: login endpoint returns 429 after 60 POSTs/min for one account", async () => {
    // /api/login is rate-limited to 60/min. Since CTF-0026 the bucket is keyed
    // by (IP, email) rather than IP alone — so a SINGLE account hammered from
    // one IP still trips at 60 (this test), while distinct accounts on a shared
    // IP no longer collide (the fix-B test above). Layered with the per-account
    // lockout (v6.8.0); this locks the per-account per-minute envelope at CI time.
    const { api, csrf } = await freshCtx();
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    let tripped = false;
    for (let i = 0; i < 80; i++) {
      const r = await api.post("/api/login", { headers: h, data: { email: "nobody@nowhere.invalid", password: "wrong" } });
      if (r.status() === 429) { tripped = true; break; }
    }
    expect(tripped).toBe(true);
    await api.dispose();
  });

  test("CTF-0026 (fix B): login limiter keyed by (IP,email) — distinct accounts on one IP are NOT blocked (shared-NAT fix)", async () => {
    // Pre-fix the login bucket was per-IP (60/min), so a roomful of legit
    // participants behind one venue/NAT IP all-re-logging-in at once would 429
    // each other on a CORRECT password. Now each (IP,email) gets its own bucket.
    // 65 DISTINCT emails sits in the safe window: >60 (so it WOULD have tripped
    // the old per-IP-60 bucket — that's what makes this a regression lock) yet
    // <80 (the test-env per-IP backstop, RATE_LIMIT_LOGIN_IP_BACKSTOP_PER_MIN),
    // with ~5/~15 requests of headroom on each side. Each (IP,email) bucket = 1.
    const { api, csrf } = await freshCtx();
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    let got429 = false;
    for (let i = 0; i < 65; i++) {
      const r = await api.post("/api/login", { headers: h, data: { email: `nat-distinct-${i}@nowhere.invalid`, password: "wrong" } });
      if (r.status() === 429) { got429 = true; break; }
    }
    expect(got429, "distinct-email logins from one IP must not trip the per-(IP,email) login limit").toBe(false);
    await api.dispose();
  });

  test("CTF-0026 (fix B+C): per-IP login backstop still trips runaway guessing across many emails from one IP", async () => {
    // The identity key must not let one IP fan unlimited guesses across emails.
    // A coarse per-IP backstop (env RATE_LIMIT_LOGIN_IP_BACKSTOP_PER_MIN, pinned
    // to 80 in the test server) catches it: ~85 distinct-email attempts from one
    // IP exceed the backstop and 429, even though each (IP,email) bucket is tiny.
    const { api, csrf } = await freshCtx();
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    let tripped = false;
    for (let i = 0; i < 95; i++) {
      const r = await api.post("/api/login", { headers: h, data: { email: `nat-backstop-${i}@nowhere.invalid`, password: "wrong" } });
      if (r.status() === 429) { tripped = true; break; }
    }
    expect(tripped, "per-IP login backstop must trip past its configured ceiling").toBe(true);
    await api.dispose();
  });

  test("v6.9.20: unauthenticated requests to /api/admin/logs don't burn the admin's rate-limit bucket", async () => {
    // Pre-v6.9.20 the limiter ran ahead of requireAdmin, so 60
    // anonymous GET /api/admin/logs requests from a given IP would
    // deny the real admin sitting on that same IP. Now the auth
    // gate runs first: anonymous callers get 401 without touching
    // the bucket. Fire 70 anon GETs from one context, then land
    // an admin GET from another context — the admin request must
    // succeed (pre-fix it would have been 429).
    const { api: anon } = await freshCtx();
    for (let i = 0; i < 70; i++) {
      const r = await anon.get("/api/admin/logs?page=1");
      // Every anon request must be rejected by the auth gate (401 or
      // 403), NEVER 429 — the limiter now sits downstream of
      // requireAdmin and anon calls never touch its bucket.
      expect(r.status() === 401 || r.status() === 403, `anon GET got ${r.status()}, expected 401/403`).toBe(true);
    }
    await anon.dispose();
    // Authenticated admin from the SAME-IP-family context (Playwright
    // uses the same loopback ip for every context). Must land 200.
    const { api: sa } = await apiLogin("superadmin");
    const admin = await sa.get("/api/admin/logs?page=1");
    expect(admin.status(), "admin request after anonymous burst").toBe(200);
    await sa.dispose();
  });

  test("v6.9.16: check-nickname returns 429 after 30 GETs/min from one IP", async () => {
    const { api } = await freshCtx();
    let tripped = false;
    for (let i = 0; i < 45; i++) {
      const r = await api.get(`/api/check-nickname?nickname=nx${i}`);
      if (r.status() === 429) { tripped = true; break; }
    }
    expect(tripped).toBe(true);
    await api.dispose();
  });



  test("v6.9.24: GET /verify returns 429 after 30 GETs/min from one IP", async () => {
    // Only the GET path is rate-limited (POST is CSRF-gated and less
    // useful as an enumeration vector). Lock the 30/min bucket in.
    const { api } = await freshCtx();
    let tripped = false;
    for (let i = 0; i < 40; i++) {
      const r = await api.get(`/verify?code=fake-verify-${i}`);
      if (r.status() === 429) { tripped = true; break; }
    }
    expect(tripped).toBe(true);
    await api.dispose();
  });

  test("v6.9.24: GET /api/invitations/:id returns 429 after 30 GETs/min from one IP", async () => {
    const { api } = await freshCtx();
    let tripped = false;
    for (let i = 0; i < 40; i++) {
      const r = await api.get(`/api/invitations/fake-uuid-${i}`);
      if (r.status() === 429) { tripped = true; break; }
    }
    expect(tripped).toBe(true);
    await api.dispose();
  });

  test("v6.9.24: GET /api/csrf-token returns 429 after 120 GETs/min from one IP", async () => {
    const { api } = await freshCtx();
    let tripped = false;
    for (let i = 0; i < 140; i++) {
      const r = await api.get("/api/csrf-token");
      if (r.status() === 429) { tripped = true; break; }
    }
    expect(tripped).toBe(true);
    await api.dispose();
  });

  test("v6.9.24: GET /api/images/:id returns 429 after 120 GETs/min from one IP", async () => {
    const { api } = await freshCtx();
    let tripped = false;
    for (let i = 0; i < 140; i++) {
      const r = await api.get(`/api/images/fake-${i}`);
      if (r.status() === 429) { tripped = true; break; }
    }
    expect(tripped).toBe(true);
    await api.dispose();
  });

  test("v6.9.24: export endpoints return 429 after 10 GETs/min from one IP", async () => {
    const { api } = await apiLogin("superadmin");
    let tripped = false;
    for (let i = 0; i < 15; i++) {
      const r = await api.get("/api/admin/export/tasks");
      if (r.status() === 429) { tripped = true; break; }
    }
    expect(tripped).toBe(true);
    await api.dispose();
  });

  test("disabling the override immediately stops returning 429", async () => {
    const { api, csrf } = await freshCtx();
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    // Exhaust the code request (5 per 15 min per (IP, email))
    for (let i = 0; i < 6; i++) {
      await api.post("/api/auth/code/request", { headers: h, data: { email: "x@y.invalid" } });
    }
    // Re-disable (also clears buckets)
    await api.post("/api/test/rate-limit-toggle", { headers: h, data: { enable: false } });
    // Now the endpoint should succeed again
    const rOk = await api.post("/api/auth/code/request", { headers: h, data: { email: "x@y.invalid" } });
    expect(rOk.ok()).toBeTruthy();
    // Re-enable so afterEach's "disable" runs against a known state
    await api.post("/api/test/rate-limit-toggle", { headers: h, data: { enable: true } });
    await api.dispose();
  });

  // v7.29.0 — THE JANITOR SWEEPS ON THE BUCKET'S OWN WINDOW, NOT ON ITS OWN CADENCE.
  //
  // The sweep used to delete any bucket older than a hard-coded 300_000 ms, which is
  // unrelated to the window the bucket was created with. `resend-verify` is the only
  // call site whose window exceeds that (15 min / 5), and its own comment promises
  // "5 / 15 min / IP so it can't be used to spray verification mail" — so the budget
  // was really being reset every ~5 minutes and the documented limit under-enforced
  // by 2-3x. The failure direction is permissive, which is why no 429 test ever saw it.
  //
  // v8.3.11 — THIS TEST NOW AUTHENTICATES, and the reason is the fix it tripped over.
  //
  // It used to drive the route ANONYMOUSLY and count on the 401s filling the bucket,
  // because the limiter was registered ahead of `requireParticipant`. That ordering
  // was the F3 defect: an unauthenticated caller spent a per-IP budget shared with
  // every real participant behind the same NAT, so a signed-out tab could deny
  // verification mail to a whole venue. Auth now runs first, a 401 costs nothing,
  // and this fixture has to be a REAL participant for the bucket to move at all.
  //
  // The subject is untouched — a bucket whose window outlives the sweep cadence must
  // survive a sweep inside that window. `resend-verification` is still the only call
  // site whose window (15 min) exceeds the old hard-coded 300 s deletion threshold,
  // which is why it and nothing else can witness this.
  //
  // A VERIFIED participant gets 400 "already verified" from the handler, and that is
  // fine: the limiter sits between auth and the handler, so the bucket increments on
  // every authenticated attempt whatever the handler then answers. The assertion is
  // deliberately "not 429" rather than a specific code, so it does not become a lock
  // on that handler's own refusal.
  test("v7.29.0: a bucket whose window outlives the sweep SURVIVES a sweep inside that window", async () => {
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };

    // 5 of 5 allowed by the limiter (each then answered by the handler).
    for (let i = 0; i < 5; i++) {
      const r = await api.post("/api/resend-verification", { headers: h, data: {} });
      expect(r.status(), `attempt ${i + 1} must reach the handler, not the limiter`).not.toBe(429);
    }

    // Cross the OLD 300 s deletion threshold while staying well inside the real
    // 15-minute window, then run one janitor pass.
    await api.post("/api/test/rate-limit-age", { headers: h, data: { ms: 301_000 } });
    const sweep = await api.post("/api/test/rate-limit-sweep", { headers: h, data: {} });
    expect(sweep.ok()).toBeTruthy();

    // The budget must still be spent. Pre-fix the bucket was gone and this got through.
    const r6 = await api.post("/api/resend-verification", { headers: h, data: {} });
    expect(r6.status(), "the 6th attempt is still inside the 15-minute window").toBe(429);
    await api.dispose();
  });

  // The positive control. Without it, "the bucket survived" is equally satisfied by
  // a janitor that never deletes anything — which is a memory leak, and the reason
  // the sweep exists at all.
  test("v7.29.0: a bucket PAST its own window is still swept", async () => {
    const { api, csrf } = await freshCtx();
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };

    // The register limiter (10/min per IP) is a 1-minute window, like the
    // credential limiter this used to drive.
    for (let i = 0; i < 10; i++) {
      await registerPost(api, "/api/register", { headers: h, data: {} });
    }
    const r4 = await registerPost(api, "/api/register", { headers: h, data: {} });
    expect(r4.status(), "register is 10/min, so the 11th is refused").toBe(429);

    // Age past the 60 s window and sweep: the bucket is genuinely collectable now.
    await api.post("/api/test/rate-limit-age", { headers: h, data: { ms: 61_000 } });
    const sweep = await api.post("/api/test/rate-limit-sweep", { headers: h, data: {} });
    expect((await sweep.json()).swept, "an expired bucket must actually be collected").toBeGreaterThan(0);

    const rAfter = await registerPost(api, "/api/register", { headers: h, data: {} });
    expect(rAfter.status(), "a fresh window starts once the bucket is collected").not.toBe(429);
    await api.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v6.15.0 — participants export/import fidelity (audit envelope v2).
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v6.15.0 — participants export/import fidelity", () => {
  // Helper: build a throwaway user via /register + /verify with state
  // controlled by the caller (denied / approved / role / etc). Returns
  // { id, email, sa, saH }. Caller is responsible for sa.dispose +
  // user delete in finally.
  async function _makeUserWithState(label, opts = {}) {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const email = `expimp-${label}-${tag}@cust.test`;
    const regR = await registerPost(sa, "/api/register", {
      headers: saJsonH,
      data: {
        firstName: "Exp", lastName: label, nickname: `expimp_${label}_${tag}`,
        email, company: "Acme", title: "T", avatar: "default1",
        country: "US", timezone: "America/New_York",
      },
    });
    expect(regR.ok(), `register: ${regR.status()}`).toBeTruthy();
    const list = await (await sa.get("/api/admin/participants?limit=500")).json();
    const id = (list.participants || []).find(p => p.email === email)?.id;
    expect(id).toBeTruthy();
    if (opts.verify !== false) await sa.post(`/api/admin/participants/${id}/verify`, { headers: saH });
    if (opts.approve)          await sa.post(`/api/admin/participants/${id}/approve`, { headers: saH });
    if (opts.deny)             await sa.post(`/api/admin/participants/${id}/deny`, { headers: saJsonH, data: { reason: opts.deny.reason || "" } });
    if (opts.role)             await sa.post(`/api/admin/participants/${id}/role`, { headers: saJsonH, data: { role: opts.role } });
    return { id, email, sa, saH, saJsonH };
  }

  // v7.15.8 — hoisted to describe scope so the schema-drift bookkeeping test
  // AND the behavioural export/import test below share ONE source of truth. A
  // new users column must be classified once, and whichever bucket it lands in
  // is then actually ENFORCED against the real export/CSV/import paths.
  const EXPORTED = new Set([
    // identity + profile
    "first_name", "last_name", "nickname", "email", "secondary_email",
    "company", "title", "personal_title", "phone", "avatar", "country", "timezone", "job_function", "city", "linkedin_url",
    // v8.1.0 (PR 24) — how the participant asked to be named on a formal record.
    // EXPORTED because a migration that lost it would silently re-issue every
    // certificate under the profile name instead.
    "certificate_given_name", "certificate_family_name",
    "registered_via",
    // lifecycle flags
    "verified", "approved", "blocked", "role",
    // v7.6.0 — exported so a re-import preserves a once-verified account's
    // reaper exemption (the unverified-account sweep keys on first_verified_at).
    "first_verified_at",
    // v8.1.0 (PR 31) — the registration policy the account was created under.
    // EXPORTED, and this one is a LOCKOUT if it is lost: a Booth Event walk-up
    // filled eight fields, so a re-imported account without it needs two more —
    // and the profile-completion gate that demands them is non-dismissible.
    "profile_policy",
    // approval + denial + lockout audit
    "approved_at", "approved_by",
    "denied_at", "denied_by", "denied_reason",
    "locked_until",
    // activity timestamps
    "login_time", "last_login_time", "created_at",
    // invitation provenance
    "invitation_id", "invited_at", "invited_by",
  ]);
  const EXCLUDED = new Set([
    // Sensitive — never export.
    "password_hash", "verify_code", "verify_code_at",
    "reset_code", "reset_code_at",
    // Internal pending-email confirmation markers (v7.5.0) — the staged new
    // primary + its single-use 48h confirmation code. Transient; cleared on
    // confirm/cancel/expiry. Not a portable profile field (the committed
    // `email`/`secondary_email` are what export carries).
    "pending_email", "pending_email_code", "pending_email_code_at",
    // Security counters — internal only.
    "failed_login_count", "failed_login_first",
    // v7.29.0 — emailed sign-in code. EXPORTED would put a live credential (or
    // its hash, plus the mint time that bounds a brute force) into a file
    // operators pass around, and re-deriving it on import would be meaningless:
    // a re-imported account has no in-flight code. Reversing this classification
    // means exporting a credential.
    // v8.1.4 — `login_code_via` records how a LIVE code was delivered, and is
    // read only to decide whether redeeming it may set `verified`. It is
    // in-flight credential metadata like the three beside it, meaningless on a
    // re-imported account, and exporting it would carry a verification claim
    // across a migration that the target's own mail never earned.
    "login_code_hash", "login_code_at", "login_code_sends", "login_code_via",
    // The event the live emailed code is bound to: in-flight credential metadata
    // like the four beside it (an exported binding would enrol on a target that
    // never mailed the code). Never exported.
    "login_code_comp_id",
    // The optimistic-concurrency fingerprint for the PROFILE fields. EXCLUDED
    // because it describes a version of a row on THIS platform: a target's rows
    // have their own history, so an imported value would either be stale (and
    // 409 the first admin who opens the dialog, for a conflict that happened on
    // a different deployment) or — worse — match by coincidence and vouch for a
    // read nobody made. It is re-established by the target's own boot backfill
    // and by its first profile write, so nothing is lost. Nor is the fingerprint
    // meaningfully a value: `profileVersionSql()` falls back to `created_at`,
    // which IS exported.
    "updated_at",
    // Internal nav state — meaningless across exports.
    "active_competition_id",
    // v8.3.12 — the same category, one step further: `active_competition_id`
    // records WHICH event is pinned, this records that the participant
    // deliberately UNPINNED it. Both are navigation state read only at sign-in,
    // both are meaningless on a re-imported account — and exporting this one
    // would be worse than useless, because it would carry a stale opt-out into a
    // platform where the events it referred to do not exist.
    "left_event_at",
    // v8.4.0 — the event this account was created THROUGH, read by the
    // profile-completion gate to resolve what that event currently demands. A
    // POINTER into this database's `competitions`, so it is the
    // `active_competition_id` category rather than a profile field: on a target
    // where that event does not exist it would dangle, and the gate would fall
    // back to `profile_policy` anyway — which IS exported, and is exactly the
    // denormalised value that survives a migration. Exporting the pointer would
    // add nothing and carry a foreign identity.
    "registration_competition_id",
    // Internal handoff marker (v6.21.0) — the competition a self-enrollment
    // registrant is auto-enrolled into at first login. Cleared once consumed;
    // same category as active_competition_id. Not a portable profile field.
    "pending_self_enroll_comp_id",
    // Internal idempotency marker (PR B / F#9) — sha256(OAuth code) of the
    // LinkedIn callback that last created this row, used to detect a duplicate/
    // replayed callback. Transient + LinkedIn-only; not a portable profile field.
    "linkedin_last_callback_key",
    // Identity binding (ext-audit v7.15.13) — the OIDC subject that owns this
    // LinkedIn account. It identifies a specific external account, so exporting
    // it would let an import graft someone else's LinkedIn identity onto a row;
    // it is re-established on the next real sign-in. Not a profile field.
    "linkedin_sub",
    // When the account's current password was set; with `password_hash` it is
    // what makes a password USABLE (lib/login-method.js). Credential metadata:
    // the hash is never exported, so a re-imported account has no password and
    // carrying this would claim one it does not have.
    "password_set_at",
    // v9.0.0 — how the account signs in (NULL follows its role). EXCLUDED: on a
    // target the password it would point at does not exist (never exported), so
    // an imported `password` choice would ask the person for a password they
    // never set there; NULL lets the role decide and they choose again.
    "login_method",
    // Internal grace marker (v7.2.0) — ISO deadline of the instant-join
    // 48h verification grace window. Cleared on verify; re-deriving on import
    // would be meaningless (the original window is long gone). Same category
    // as pending_self_enroll_comp_id.
    "self_enroll_grace_until",
    // Surrogate key — regenerated on insert.
    "id",
  ]);

  // ── v7.15.8 — the allow-list must have TEETH ────────────────────────────────
  // The schema-drift test above only proves every users column has been
  // CLASSIFIED. It never checks that an "EXPORTED" column actually reaches the
  // JSON export, survives a JSON import, or appears in the CSV — which is how
  // job_function / city / personal_title / phone sat in EXPORTED while the CSV
  // silently dropped two of them. These tests enforce the classification against
  // the real code paths, so a future field cannot be added to the list and then
  // quietly break export or import.
  //
  // PROFILE_IN_CSV: the participant-authored fields a human expects to find in a
  // spreadsheet. Everything else in EXPORTED is lifecycle/audit data that the CSV
  // renders differently (Status) or deliberately omits. A NEW column must be
  // classified here too — the guard below fails until it is.
  const PROFILE_IN_CSV = new Set([
    "first_name", "last_name", "nickname", "email", "secondary_email",
    "company", "title", "personal_title", "phone", "avatar",
    "country", "timezone", "job_function", "city", "linkedin_url",
    // v8.1.0 (PR 24) — an operator reconciling certificates against a cohort
    // reads them out of this file, so they belong in it.
    "certificate_given_name", "certificate_family_name",
  ]);

  test("drift guard: every EXPORTED profile column is classified for the CSV", () => {
    // Forces the decision for a NEW field: either it belongs in the CSV (add it
    // to PROFILE_IN_CSV *and* to exportParticipantsCSV) or it is lifecycle data
    // (add it here). Without this, a new profile field lands in EXPORTED and the
    // CSV silently never carries it — exactly the v7.15.8 bug.
    const NON_PROFILE = new Set([
      "registered_via", "role", "verified", "first_verified_at", "blocked", "approved",
      "approved_at", "approved_by", "denied_at", "denied_by", "denied_reason",
      "locked_until", "login_time", "last_login_time", "created_at",
      "invitation_id", "invited_at", "invited_by", "active_competition_id",
      "ended_popup_seen", "pending_email", "cxone_username",
      // v8.1.0 (PR 31) — lifecycle, not a profile field. It records which
      // registration policy applied, which is not something an operator
      // reconciles in a spreadsheet; it must survive an IMPORT (see EXPORTED
      // above), which is a different requirement from appearing in the CSV.
      "profile_policy",
    ]);
    const unclassified = [...EXPORTED].filter(c => !PROFILE_IN_CSV.has(c) && !NON_PROFILE.has(c));
    expect(unclassified,
      `EXPORTED column(s) not classified as profile-in-CSV or lifecycle: ${unclassified.join(", ")}. ` +
      `Add each to PROFILE_IN_CSV (and to exportParticipantsCSV) or to NON_PROFILE here.`).toEqual([]);
  });

  test("every profile column round-trips: JSON export → JSON import, and appears in the CSV", async ({ page }) => {
    // One user with EVERY profile column populated with a distinctive value, then
    // driven through the three real paths. Values are distinctive so a CSV column
    // that exists but is always blank cannot pass.
    const stamp = `${Date.now()}`;
    const VALUES = {
      first_name: `Drift${stamp}`, last_name: `Guard${stamp}`, nickname: `drift${stamp}`,
      email: `drift${stamp}@acme.com`, secondary_email: `drift${stamp}.alt@acme.com`,
      company: `Acme-${stamp}`, title: `Staff Engineer ${stamp}`, personal_title: "Dr.",
      phone: `+1 555 ${stamp.slice(-4)}`, avatar: "🦊",
      country: "US", timezone: "America/New_York",
      job_function: "Application Security Engineer", city: `Boston-${stamp}`,
      linkedin_url: `https://linkedin.com/in/drift${stamp}`,
      // v8.1.0 (PR 24) — set through PUT /api/me below, because registration does
      // not collect them: they are an optional refinement of a profile that
      // already exists, not something asked for at sign-up.
      certificate_given_name: `CertGiven${stamp}`, certificate_family_name: `CertFamily${stamp}`,
    };
    // Sanity: the fixture must cover the classified set, or the test is hollow.
    const uncovered = [...PROFILE_IN_CSV].filter(f => !(f in VALUES));
    expect(uncovered, `fixture is missing value(s) for: ${uncovered.join(", ")}`).toEqual([]);

    const { api: anon, csrf: ac } = await freshCtx();
    const reg = await registerPost(anon, "/api/register", {
      headers: { "x-csrf-token": ac, "content-type": "application/json" },
      data: {
        firstName: VALUES.first_name, lastName: VALUES.last_name, nickname: VALUES.nickname,
        email: VALUES.email, secondaryEmail: VALUES.secondary_email,
        company: VALUES.company, title: VALUES.title, personalTitle: VALUES.personal_title,
        phone: VALUES.phone, avatar: VALUES.avatar, country: VALUES.country, timezone: VALUES.timezone,
        jobFunction: VALUES.job_function, city: VALUES.city, linkedinUrl: VALUES.linkedin_url,
        password: PARTICIPANT_PASS,
      },
    });
    expect(reg.status(), `seed registration: ${await reg.text()}`).toBe(200);
    await anon.dispose();

    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === VALUES.email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": csrf } });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": csrf } });

    // v8.1.0 (PR 24) — the certificate name is set by its owner, through the same
    // endpoint the profile editor uses, so the round trip below is measuring a
    // value that reached the column the way a real one does.
    {
      const { api: own, csrf: oc } = await freshCtx();
      const li = await codeLogin(own, VALUES.email, { "x-csrf-token": oc, "content-type": "application/json" });
      expect(li.ok(), `owner login: ${await li.text()}`).toBeTruthy();
      const oc2 = (await (await own.get("/api/csrf-token")).json()).csrfToken;
      const put = await own.put("/api/me", { headers: { "x-csrf-token": oc2, "content-type": "application/json" },
        data: { certificateGivenName: VALUES.certificate_given_name, certificateFamilyName: VALUES.certificate_family_name } });
      expect(put.ok(), `set certificate name: ${await put.text()}`).toBeTruthy();
      await own.dispose();
    }

    // 1. JSON EXPORT carries every profile column, with the right value.
    const exp = await (await sa.get("/api/admin/export/participants")).json();
    const jrow = (exp.participants || []).find(p => p.email === VALUES.email);
    expect(jrow, "exported row present").toBeTruthy();
    const jsonBad = Object.entries(VALUES).filter(([f, v]) => jrow[f] !== v).map(([f, v]) => `${f} (want ${JSON.stringify(v)}, got ${JSON.stringify(jrow[f])})`);
    expect(jsonBad, `JSON export lost/altered: ${jsonBad.join("; ")}`).toEqual([]);

    // 2. JSON IMPORT round-trips every profile column. NOTE the import is
    //    two-phase — without `resolutions` it is only a DRY RUN, so an import
    //    test that omits it writes nothing and asserts nothing.
    const clone = { ...jrow, id: undefined, email: `rt${stamp}@acme.com`, secondary_email: null, nickname: `rt${stamp}` };
    const envelope = { ...exp, participants: [clone] };
    expect((await sa.post("/api/admin/import/participants", { headers: H, data: { data: envelope } })).ok()).toBeTruthy();
    const applied = await sa.post("/api/admin/import/participants", { headers: H, data: { data: envelope, resolutions: {} } });
    expect(applied.ok(), `import apply: ${applied.status()} ${await applied.text()}`).toBeTruthy();
    const back = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === `rt${stamp}@acme.com`);
    expect(back, "imported row exists").toBeTruthy();
    const impBad = Object.entries(VALUES)
      .filter(([f]) => f !== "email" && f !== "secondary_email" && f !== "nickname")   // deliberately re-keyed above
      .filter(([f, v]) => back[f] !== v).map(([f, v]) => `${f} (want ${JSON.stringify(v)}, got ${JSON.stringify(back[f])})`);
    expect(impBad, `JSON import lost/altered: ${impBad.join("; ")}`).toEqual([]);
    await sa.dispose();

    // 3. CSV carries every profile column's VALUE (built by the real client fn).
    // Absolute URLs: this is an API spec, so no test.use({ baseURL }) is set and
    // a relative page.request path throws "Invalid URL".
    const { csrfToken } = await (await page.request.get(`${BASE}/api/csrf-token`)).json();
    expect((await page.request.post(`${BASE}/api/login`, {
      headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
      data: { email: "superadmin", password: getSuperadminPass() },
    })).ok()).toBeTruthy();
    await page.goto(`${BASE}/`);
    await page.waitForSelector("#admin-page", { timeout: 20000 });
    await page.evaluate(async () => { await window.loadAdminParticipants(1, 5000); });
    const csv = await page.evaluate(async () => {
      let blob = null;
      const rc = URL.createObjectURL, rk = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = (b) => { blob = b; return "blob:probe"; };
      HTMLAnchorElement.prototype.click = function () {};
      try { window.exportParticipantsCSV(); } finally { URL.createObjectURL = rc; HTMLAnchorElement.prototype.click = rk; }
      return blob ? await blob.text() : null;
    });
    expect(csv, "CSV produced").toBeTruthy();
    const line = csv.split("\n").find(l => l.includes(VALUES.email));
    expect(line, "our participant has a CSV row").toBeTruthy();
    const csvMissing = [...PROFILE_IN_CSV].filter(f => !line.includes(VALUES[f]));
    expect(csvMissing,
      `CSV row does not carry: ${csvMissing.join(", ")}. Add the column to exportParticipantsCSV ` +
      `(header AND the row projection) — a header alone leaves the column blank.`).toEqual([]);
  });

  // ── v8.1.1 — the round trip above had a HOLE, and profile_policy fell into it ─
  // It walks PROFILE_IN_CSV, and PROFILE_IN_CSV deliberately EXCLUDES the
  // lifecycle columns — so an EXPORTED column that is not a spreadsheet field was
  // driven by nothing at all. `profile_policy` sat in EXPORTED for a whole
  // release, under a comment calling its loss a LOCKOUT, while the export SELECT
  // and the import INSERT both silently dropped it: a platform migration recreated
  // every Booth Event walk-up with NULL, and the NON-DISMISSIBLE completion gate
  // then demanded two fields nobody had ever collected from them.
  //
  // The guard demands a DECISION per column rather than blanket coverage — the
  // competitions drift guard's shape (v7.29.0). A rule requiring every column to
  // round-trip would be WRONG ABOUT WORKING CODE, and a guard that is wrong about
  // working code gets silenced by whoever hits it next.
  //
  // The file it imports is built by OVERWRITING the exported row rather than by
  // registering a user who happens to have every column set: an operator's
  // migration file carries values for columns no registration form can reach, and
  // that file is precisely what this must survive. Values are distinctive so a
  // column that exists but always arrives at its default cannot pass.
  const ROUND_TRIP_EXEMPT = new Map([
    ["role", "driven with a genuinely privileged value ('admin') by " +
             "'roundtrip: admin role survives export → delete → re-import' above, which " +
             "deletes the account it creates. Importing a second admin here to make one " +
             "assertion discriminating would duplicate that test and leave a privileged " +
             "row in the shared per-file database."],
  ]);

  test("v8.1.1 — every EXPORTED users column survives a real export → import, or is exempted", async () => {
    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    const key = `rtg${stamp}`;
    // Distinctive, and legal on the write path: caps apply on import, an
    // unresolvable timezone is DROPPED to empty (v7.21.1 A7), and linkedin_url
    // goes through validateUrl. A value that does not survive validation would
    // fail here as a fixture problem wearing a drift-guard's clothes.
    const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400e3).toISOString();
    const RT = {
      first_name: "RTfirst", last_name: "RTlast",
      nickname: key, email: `${key}@company.example`, secondary_email: `${key}.alt@company.example`,
      company: "RTcompany", title: "RTtitle", personal_title: "Prof.", phone: "+1 555 0142",
      avatar: "🦊", country: "PT", timezone: "America/Denver",
      job_function: "RTrole", city: "RTcity",
      linkedin_url: `https://www.linkedin.com/in/${key}`,
      certificate_given_name: "RTcertGiven", certificate_family_name: "RTcertFamily",
      registered_via: "linkedin",
      // v8.1.1 — the column this guard was written for. "booth" is the stored
      // value a Booth Event walk-up carries; NULL would be indistinguishable from
      // a dropped column, which is the whole defect.
      profile_policy: "booth",
      verified: 1, approved: 1, blocked: 1,
      first_verified_at: iso(9),
      approved_at: iso(8), approved_by: "rt-approver",
      denied_at: iso(7), denied_by: "rt-denier", denied_reason: "rt-reason",
      locked_until: iso(6),
      login_time: iso(5), last_login_time: iso(4), created_at: iso(3),
      invitation_id: `rt-invitation-${stamp}`, invited_at: iso(2), invited_by: "rt-inviter",
    };
    // Anti-vacuity: the fixture must decide every EXPORTED column, or a new one
    // silently escapes this guard the same way profile_policy escaped the last.
    const undecided = [...EXPORTED].filter(c => !(c in RT) && !ROUND_TRIP_EXEMPT.has(c));
    expect(undecided,
      `EXPORTED column(s) with no round-trip decision: ${undecided.join(", ")}. ` +
      `Give each a distinctive value in RT (and carry it through the export SELECT, the ` +
      `export projection and the import INSERT), or add it to ROUND_TRIP_EXEMPT with the reason.`)
      .toEqual([]);

    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    let importedId = null;
    try {
      // A real exported row is the base, so the file carries whatever envelope +
      // per-row keys the export actually emits — including any this test does not
      // name. Register our own participant rather than borrowing a seeded one.
      const { api: anon, csrf: ac } = await freshCtx();
      const seedEmail = `${key}.seed@company.example`;
      const reg = await registerPost(anon, "/api/register", {
        headers: { "x-csrf-token": ac, "content-type": "application/json" },
        data: {
          firstName: "Seed", lastName: "Row", nickname: `${key}s`, email: seedEmail,
          company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
          jobFunction: "Software Developer / Engineer", city: "Testville",
          password: PARTICIPANT_PASS,
        },
      });
      expect(reg.status(), `seed registration: ${await reg.text()}`).toBe(200);
      await anon.dispose();

      const exp = await (await sa.get("/api/admin/export/participants")).json();
      const base = (exp.participants || []).find(p => p.email === seedEmail);
      expect(base, "the seed row is in the export").toBeTruthy();

      // 1. EXPORT COMPLETENESS. Catches a column missing from _USERS_SELECT or
      //    from the per-row projection — which is half of what profile_policy was.
      //    Checked on the key, not the value, because the seed row legitimately
      //    holds NULL for most lifecycle columns.
      const missingKeys = [...EXPORTED].filter(c => !(c in base));
      expect(missingKeys,
        `the exported row does not carry: ${missingKeys.join(", ")}. Add each to the ` +
        `_USERS_SELECT column list AND to the per-row projection in routes/export-import.js — ` +
        `a SELECT alone leaves the key off the wire.`).toEqual([]);

      // 2. IMPORT COMPLETENESS. Catches a column missing from the import INSERT,
      //    which is the other half.
      const clone = { ...base, id: undefined, ...RT };
      const envelope = { ...exp, participants: [clone] };
      expect((await sa.post("/api/admin/import/participants", { headers: H, data: { data: envelope } })).ok(),
        "dry run").toBeTruthy();
      const applied = await sa.post("/api/admin/import/participants", { headers: H, data: { data: envelope, resolutions: {} } });
      expect(applied.ok(), `import apply: ${applied.status()} ${await applied.text()}`).toBeTruthy();

      // Read the row back from SQLite, not from /api/admin/participants: that
      // payload is a hand-written allow-list which does NOT carry profile_policy
      // (it is lifecycle data, not a spreadsheet field), so a guard reading it
      // would be blind to exactly the column that motivated it.
      const Database = require("better-sqlite3");
      const dbR = new Database(TEST_DB_PATH, { readonly: true });
      let back;
      try { back = dbR.prepare("SELECT * FROM users WHERE email=? COLLATE NOCASE").get(RT.email); }
      finally { dbR.close(); }
      expect(back, "the imported row exists").toBeTruthy();
      importedId = back.id;

      const lost = Object.entries(RT)
        .filter(([c]) => !ROUND_TRIP_EXEMPT.has(c))
        .filter(([c, v]) => back[c] !== v)
        .map(([c, v]) => `${c} (want ${JSON.stringify(v)}, got ${JSON.stringify(back[c])})`);
      expect(lost,
        `the import lost or altered: ${lost.join("; ")}. Add each column to the users INSERT ` +
        `in server.js (column list AND bind list — a column name without a placeholder ` +
        `desyncs every bind after it).`).toEqual([]);
    } finally {
      if (importedId) await sa.delete(`/api/admin/participants/${importedId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      await sa.dispose();
    }
  });

  test("schema-drift: every users-table column is in EXPORTED or EXCLUDED allow-list", async () => {
    // Whenever someone adds a new column to `users` (e.g. v6.14.0
    // added denied_at/by/reason and they dropped out of the export
    // until v6.15.0), this test fires. The allow-list is the
    // single source of truth: any new column MUST be added to one
    // of the two sets with a documented intent. Without this guard
    // export gaps go unnoticed for months.
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
    db.close();
    const orphans = cols.filter(c => !EXPORTED.has(c) && !EXCLUDED.has(c));
    expect(
      orphans,
      `users-table columns missing from BOTH the EXPORTED and EXCLUDED allow-lists:\n  ${orphans.join("\n  ")}\nAdd each new column to one of the two sets in this test (and to the export projection) so the next audit doesn't have to rediscover the gap.`
    ).toEqual([]);
    // The other direction, as the L9 audit guard does it: a decision about a column that no longer exists reads as coverage and is not; drop the entry with the column.
    const stale = [...EXPORTED, ...EXCLUDED].filter(c => !cols.includes(c));
    expect(stale, "EXPORTED or EXCLUDED names a users column that no longer exists").toEqual([]);
  });

  test("export envelope is v2 and surfaces denied / role / activity / memberships", async () => {
    // Build a user with the v6.15.0-relevant fields populated, then
    // export and verify each one shows up in the JSON. Single test
    // that covers the entire field-shape contract (faster than one
    // per field).
    await ensureState();
    const ctx = await _makeUserWithState("envelope", { approve: true });
    try {
      // Add to the seed live comp so the memberships array is non-empty.
      await ctx.sa.post("/api/admin/competitions/assign", {
        headers: ctx.saJsonH,
        data: { userIds: [ctx.id], competitionIds: [S.liveComp.id] },
      });
      const exp = await (await ctx.sa.get("/api/admin/export/participants")).json();
      expect(exp.type).toBe("hackarena-participants");
      expect(exp.version).toBe(2);
      const row = exp.participants.find(p => p.email === ctx.email);
      expect(row, "exported row exists").toBeTruthy();
      // Required v2 keys present (values may be null but the keys MUST exist).
      for (const k of [
        "approved_at", "approved_by", "denied_at", "denied_by", "denied_reason",
        "role", "locked_until", "login_time", "last_login_time", "created_at",
        "invitation_id", "invited_at", "invited_by",
        "tags", "competitions",
      ]) {
        expect(row, `missing v2 key ${k}`).toHaveProperty(k);
      }
      expect(row.role).toBe("participant");
      expect(row.approved_at).toBeTruthy();
      expect(row.approved_by).toBeTruthy();
      expect(row.created_at).toBeTruthy();
      expect(Array.isArray(row.competitions)).toBe(true);
      const liveMembership = row.competitions.find(m => m.competition_name === S.liveComp.name);
      expect(liveMembership, "Test Live membership exported by name").toBeTruthy();
    } finally {
      if (ctx.id) await ctx.sa.delete(`/api/admin/participants/${ctx.id}`, { headers: ctx.saH }).catch(() => {});
      await ctx.sa.dispose();
    }
  });

  test("roundtrip: denied user re-imports with denied_at/by/reason preserved", async () => {
    // The v6.14.0 deny state was being silently dropped on re-import
    // pre-v6.15.0. This test locks the fix.
    const ctx = await _makeUserWithState("denyrt", { deny: { reason: "audit roundtrip — disposable email provider" } });
    let reImportedId;
    try {
      const exp = await (await ctx.sa.get("/api/admin/export/participants")).json();
      const row = exp.participants.find(p => p.email === ctx.email);
      expect(row.denied_at).toBeTruthy();
      expect(row.denied_reason).toMatch(/disposable/);
      // Hard-delete the original.
      await ctx.sa.delete(`/api/admin/participants/${ctx.id}`, { headers: ctx.saH });
      // Re-import the single exported row.
      const imp = await ctx.sa.post("/api/admin/import/participants", {
        headers: ctx.saJsonH,
        data: { data: { type: "hackarena-participants", version: 2, participants: [row] }, resolutions: {} },
      });
      expect(imp.ok(), `import: ${imp.status()} ${await imp.text()}`).toBeTruthy();
      // Find re-imported user + verify state.
      // kind=all: the re-imported account holds the admin role, and People lists
      // admin accounts only on request.
      const list = await (await ctx.sa.get("/api/admin/participants?limit=500&kind=all")).json();
      const reRow = (list.participants || []).find(p => p.email === ctx.email);
      expect(reRow, "user re-imported").toBeTruthy();
      reImportedId = reRow.id;
      const Database = require("better-sqlite3");
      const dbR = new Database(TEST_DB_PATH, { readonly: true });
      const dbRow = dbR.prepare("SELECT denied_at, denied_by, denied_reason, blocked, approved FROM users WHERE id=?").get(reImportedId);
      dbR.close();
      expect(dbRow.denied_at).toBeTruthy();
      expect(dbRow.denied_by).toBeTruthy();
      expect(dbRow.denied_reason).toMatch(/disposable/);
      expect(dbRow.blocked).toBe(1);    // denied implies blocked
      expect(dbRow.approved).toBe(0);
    } finally {
      const idsToDelete = [ctx.id, reImportedId].filter(Boolean);
      for (const id of idsToDelete) await ctx.sa.delete(`/api/admin/participants/${id}`, { headers: ctx.saH }).catch(() => {});
      await ctx.sa.dispose();
    }
  });

  test("roundtrip: admin role survives export → delete → re-import", async () => {
    // role used to silently demote to "participant" on re-import.
    const ctx = await _makeUserWithState("rolert", { approve: true, role: "admin" });
    let reImportedId;
    try {
      const exp = await (await ctx.sa.get("/api/admin/export/participants")).json();
      const row = exp.participants.find(p => p.email === ctx.email);
      expect(row.role).toBe("admin");
      await ctx.sa.delete(`/api/admin/participants/${ctx.id}`, { headers: ctx.saH });
      const imp = await ctx.sa.post("/api/admin/import/participants", {
        headers: ctx.saJsonH,
        data: { data: { type: "hackarena-participants", version: 2, participants: [row] }, resolutions: {} },
      });
      expect(imp.ok()).toBeTruthy();
      const impBody = await imp.json();
      expect(impBody.role_grants).toBe(1);
      // kind=all: an admin account is listed in People only on request.
      const list = await (await ctx.sa.get("/api/admin/participants?limit=500&kind=all")).json();
      const reRow = (list.participants || []).find(p => p.email === ctx.email);
      reImportedId = reRow.id;
      expect(reRow.role).toBe("admin");
    } finally {
      const idsToDelete = [ctx.id, reImportedId].filter(Boolean);
      for (const id of idsToDelete) await ctx.sa.delete(`/api/admin/participants/${id}`, { headers: ctx.saH }).catch(() => {});
      await ctx.sa.dispose();
    }
  });

  test("roundtrip: created_at + approved_at + approved_by preserved (no importNow overwrite)", async () => {
    // Pre-v6.15.0 the insert path used importNow and "import" sentinel
    // for these. v2 export carries the originals; import respects them.
    const ctx = await _makeUserWithState("audrt", { approve: true });
    let reImportedId;
    try {
      const exp = await (await ctx.sa.get("/api/admin/export/participants")).json();
      const row = exp.participants.find(p => p.email === ctx.email);
      const origCreated  = row.created_at;
      const origApproved = row.approved_at;
      const origApprovedBy = row.approved_by;
      expect(origCreated).toBeTruthy();
      expect(origApproved).toBeTruthy();
      expect(origApprovedBy).toBeTruthy();
      await ctx.sa.delete(`/api/admin/participants/${ctx.id}`, { headers: ctx.saH });
      const imp = await ctx.sa.post("/api/admin/import/participants", {
        headers: ctx.saJsonH,
        data: { data: { type: "hackarena-participants", version: 2, participants: [row] }, resolutions: {} },
      });
      expect(imp.ok()).toBeTruthy();
      const list = await (await ctx.sa.get("/api/admin/participants?limit=500")).json();
      const reRow = (list.participants || []).find(p => p.email === ctx.email);
      reImportedId = reRow.id;
      const Database = require("better-sqlite3");
      const dbR = new Database(TEST_DB_PATH, { readonly: true });
      const dbRow = dbR.prepare("SELECT created_at, approved_at, approved_by FROM users WHERE id=?").get(reImportedId);
      dbR.close();
      expect(dbRow.created_at).toBe(origCreated);
      expect(dbRow.approved_at).toBe(origApproved);
      expect(dbRow.approved_by).toBe(origApprovedBy);
    } finally {
      const idsToDelete = [ctx.id, reImportedId].filter(Boolean);
      for (const id of idsToDelete) await ctx.sa.delete(`/api/admin/participants/${id}`, { headers: ctx.saH }).catch(() => {});
      await ctx.sa.dispose();
    }
  });

  test("roundtrip: competition memberships restored by name", async () => {
    await ensureState();
    const ctx = await _makeUserWithState("compsrt", { approve: true });
    let reImportedId;
    try {
      // Assign to two existing comps.
      await ctx.sa.post("/api/admin/competitions/assign", {
        headers: ctx.saJsonH,
        data: { userIds: [ctx.id], competitionIds: [S.liveComp.id, S.upcomingComp.id] },
      });
      const exp = await (await ctx.sa.get("/api/admin/export/participants")).json();
      const row = exp.participants.find(p => p.email === ctx.email);
      const exportedNames = (row.competitions || []).map(c => c.competition_name).sort();
      expect(exportedNames).toEqual([S.liveComp.name, S.upcomingComp.name].sort());
      await ctx.sa.delete(`/api/admin/participants/${ctx.id}`, { headers: ctx.saH });
      const imp = await ctx.sa.post("/api/admin/import/participants", {
        headers: ctx.saJsonH,
        data: { data: { type: "hackarena-participants", version: 2, participants: [row] }, resolutions: {} },
      });
      expect(imp.ok()).toBeTruthy();
      const impBody = await imp.json();
      expect(impBody.memberships_imported).toBe(2);
      const list = await (await ctx.sa.get("/api/admin/participants?limit=500")).json();
      const reRow = (list.participants || []).find(p => p.email === ctx.email);
      reImportedId = reRow.id;
      const reCompIds = (reRow.competitions || []).map(c => c.id).sort();
      expect(reCompIds).toEqual([S.liveComp.id, S.upcomingComp.id].sort());
    } finally {
      const idsToDelete = [ctx.id, reImportedId].filter(Boolean);
      for (const id of idsToDelete) await ctx.sa.delete(`/api/admin/participants/${id}`, { headers: ctx.saH }).catch(() => {});
      await ctx.sa.dispose();
    }
  });

  test("membership-name mismatch surfaces in skipped_memberships, not silently dropped", async () => {
    const ctx = await _makeUserWithState("missname", { approve: true });
    let reImportedId;
    try {
      const exp = await (await ctx.sa.get("/api/admin/export/participants")).json();
      const row = exp.participants.find(p => p.email === ctx.email);
      // Inject a synthetic membership for a comp that doesn't exist.
      row.competitions = [{ competition_name: `NoSuchCompXYZ-${crypto.randomBytes(4).toString("hex")}`, timeslot_name: null, assigned_at: null, login_time: null }];
      await ctx.sa.delete(`/api/admin/participants/${ctx.id}`, { headers: ctx.saH });
      const imp = await ctx.sa.post("/api/admin/import/participants", {
        headers: ctx.saJsonH,
        data: { data: { type: "hackarena-participants", version: 2, participants: [row] }, resolutions: {} },
      });
      expect(imp.ok()).toBeTruthy();
      const impBody = await imp.json();
      expect(impBody.memberships_imported).toBe(0);
      expect(Array.isArray(impBody.skipped_memberships)).toBe(true);
      expect(impBody.skipped_memberships.length).toBe(1);
      expect(impBody.skipped_memberships[0].competition_name).toMatch(/^NoSuchCompXYZ-/);
      expect(impBody.skipped_memberships[0].reason).toBe("competition_not_found");
      const list = await (await ctx.sa.get("/api/admin/participants?limit=500")).json();
      reImportedId = (list.participants || []).find(p => p.email === ctx.email)?.id;
    } finally {
      const idsToDelete = [ctx.id, reImportedId].filter(Boolean);
      for (const id of idsToDelete) await ctx.sa.delete(`/api/admin/participants/${id}`, { headers: ctx.saH }).catch(() => {});
      await ctx.sa.dispose();
    }
  });

  test("backwards-compat: a v1-shaped export still imports with sane defaults", async () => {
    // A pre-v6.15.0 export was version=1 and lacked all the new
    // audit / role / denial / competitions fields. This test
    // synthesises a v1 row by hand and confirms the import
    // accepts it without errors AND fills the missing fields with
    // the v1 defaults (approved_at = importNow when approved=1,
    // approved_by = "import" sentinel, role = "participant",
    // created_at = importNow, all denial fields = NULL).
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const email = `v1compat-${tag}@cust.test`;
    const v1Row = {
      first_name: "V1", last_name: "Compat", nickname: `v1compat_${tag}`,
      email, secondary_email: "", company: "Acme", title: "T",
      country: "US", timezone: "America/New_York", linkedin_url: "",
      registered_via: "manual", avatar: "default1",
      verified: 1, blocked: 0, approved: 1, tags: [],
      // Notably absent: approved_at/by, denied_*, role, login_time,
      // last_login_time, created_at, invitation_id, invited_at/by,
      // locked_until, competitions.
    };
    let reImportedId;
    try {
      const imp = await sa.post("/api/admin/import/participants", {
        headers: saJsonH,
        data: { data: { type: "hackarena-participants", version: 1, participants: [v1Row] }, resolutions: {} },
      });
      expect(imp.ok(), `v1 import: ${imp.status()} ${await imp.text()}`).toBeTruthy();
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      const reRow = (list.participants || []).find(p => p.email === email);
      expect(reRow, "v1 import created the row").toBeTruthy();
      reImportedId = reRow.id;
      expect(reRow.role || "participant").toBe("participant");
      expect(reRow.approved).toBe(1);
      expect(reRow.approved_at).toBeTruthy(); // back-fill = importNow
      expect(reRow.approved_by).toBeTruthy(); // back-fill = "import" sentinel
      expect(reRow.denied_at || null).toBeNull();
    } finally {
      if (reImportedId) await sa.delete(`/api/admin/participants/${reImportedId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("denied-without-blocked is auto-normalised to blocked=1 (denied_normalised counter)", async () => {
    // Defensive: a hand-edited or malformed import row carrying
    // denied_at without blocked=1 must be coerced so the lifecycle
    // invariant from v6.14.0 (denied implies blocked) holds. The
    // response surfaces the auto-fix via denied_normalised.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const email = `denynorm-${tag}@cust.test`;
    let reImportedId;
    try {
      const imp = await sa.post("/api/admin/import/participants", {
        headers: saJsonH,
        data: {
          data: {
            type: "hackarena-participants", version: 2,
            participants: [{
              first_name: "Norm", last_name: "Test", nickname: `denynorm_${tag}`,
              email, secondary_email: "",
              company: "Acme", title: "T", country: "US", timezone: "America/New_York",
              linkedin_url: "", registered_via: "manual", avatar: "default1",
              verified: 1, blocked: 0, approved: 0,    // <- blocked=0 inconsistent with denied_at
              denied_at: "2026-04-25T10:00:00.000Z",
              denied_by: "test-system",
              denied_reason: "import test",
              tags: [],
            }],
          },
          resolutions: {},
        },
      });
      expect(imp.ok()).toBeTruthy();
      const impBody = await imp.json();
      expect(impBody.denied_normalised).toBe(1);
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      const reRow = (list.participants || []).find(p => p.email === email);
      reImportedId = reRow?.id;
      const Database = require("better-sqlite3");
      const dbR = new Database(TEST_DB_PATH, { readonly: true });
      const dbRow = dbR.prepare("SELECT blocked, denied_at FROM users WHERE id=?").get(reImportedId);
      dbR.close();
      expect(dbRow.blocked).toBe(1);
      expect(dbRow.denied_at).toBeTruthy();
    } finally {
      if (reImportedId) await sa.delete(`/api/admin/participants/${reImportedId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("unsupported export version is rejected with 400", async () => {
    // Older / newer envelope versions outside {1, 2} fail loud
    // rather than silent — protects against a forwards-compat
    // import that would silently drop unknown fields.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    try {
      const r = await sa.post("/api/admin/import/participants", {
        headers: saJsonH,
        data: { data: { type: "hackarena-participants", version: 99, participants: [] }, resolutions: {} },
      });
      expect(r.status()).toBe(400);
      const body = await r.json();
      expect(body.error).toMatch(/Unsupported export version/i);
    } finally {
      await sa.dispose();
    }
  });

  test("CSV export header includes the v6.15.0 audit columns (schema-drift guard)", () => {
    // Static-source assertion — reads public/app.js and confirms
    // the CSV header array contains every audit column the JSON
    // export now exposes. Without this, the JSON export and the
    // CSV export would drift apart on the next field addition.
    const fs = require("fs");
    const path = require("path");
    const appJs = (() => { const _d = path.join(__dirname, "..", "public", "js"); const _o = []; (function _w(p){ for (const e of fs.readdirSync(p, { withFileTypes: true })) { const _f = path.join(p, e.name); if (e.isDirectory()) _w(_f); else if (e.name.endsWith(".js")) _o.push(fs.readFileSync(_f, "utf8")); } })(_d); return _o.join("\n"); })();
    const fnMatch = appJs.match(/function exportParticipantsCSV\(\)\{[\s\S]*?\n\}/);
    expect(fnMatch, "exportParticipantsCSV source").toBeTruthy();
    const body = fnMatch[0];
    for (const col of [
      "Approved By", "Invited By", "Role", "Locked Until",
      "Denied Date", "Denied By", "Denial Reason", "Events",
      // v6.20.x — required profile fields + memberships that were missing from
      // the CSV (present in the JSON export); guard so they can't drift out again.
      "City", "Avatar", "Groups",
      // v7.15.8 (user-field audit) — Salutation + Phone were collected by both
      // profile dialogs and carried by JSON export/import, but the CSV dropped
      // them. Headers also use the UI's OWN labels: an operator searching a CSV
      // for the on-screen label must find the column. The dialogs say "Job
      // function", so the header is "Job Function" (as in the full exports).
      "Salutation", "Phone", "Job Function", "Work Title",
    ]) {
      expect(body, `CSV header missing column: ${col}`).toContain(`'${col}'`);
    }
    // The retired label is gone, not kept beside the new one.
    expect(body, "the CSV no longer says Professional Role, a label no dialog shows").not.toContain("'Professional Role'");
    // …and the ROW must actually emit each profile field, not just the header.
    for (const f of ["personal_title", "first_name", "last_name", "nickname", "email",
                     "secondary_email", "company", "title", "job_function", "city",
                     "phone", "country", "timezone", "linkedin_url", "avatar"]) {
      expect(body, `CSV row never reads p.${f} — header present but column always blank`)
        .toMatch(new RegExp(`p\\.${f}\\b`));
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v6.16.6 — auditor batch tier-2: lifecycle re-checks, denied-invite,
// duration-shrink audit, absences round-trip, comp export, bulk-approve cache,
// uncaughtException drain.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v6.16.6 — auditor invariants", () => {
  test("requireParticipant re-checks blocked + denied + verified + approved per request", async () => {
    // Pre-fix the middleware re-checked only `blocked`. An out-of-band
    // write that flipped verified=0 / approved=0 / set denied_at left
    // an authenticated session with full access until cookie expiry.
    // Post-fix all four predicates are re-checked.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    const partEmail = `lifecycle-${tag}@cust.test`;
    const partPass = "lifecyclePw123!";
    let partId;
    try {
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Life", lastName: "Cycle", nickname: `lifecycle_${tag}`,
          email: partEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "America/New_York",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      partId = (list.participants || []).find(p => p.email === partEmail)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${partId}/approve`, { headers: saH });

      // Login + warm session.
      const { api: u } = await apiLogin(partEmail, partPass);
      try {
        const meR = await u.get("/api/me");
        expect(meR.ok()).toBeTruthy();
        // Out-of-band: flip approved=0.
        const dbW = new Database(TEST_DB_PATH);
        try {
          dbW.prepare("UPDATE users SET approved=0 WHERE id=?").run(partId);
        } finally {
          dbW.close();
        }
        // Next request must 403 — pre-fix this would have been 200.
        const meR2 = await u.get("/api/me");
        expect(meR2.status()).toBe(403);
      } finally {
        await u.dispose();
      }
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("Inviting a denied user is rejected with explicit error", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const partEmail = `deniedinv-${tag}@cust.test`;
    let partId;
    try {
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Den", lastName: "Inv", nickname: `deniedinv_${tag}`,
          email: partEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "America/New_York",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      partId = (list.participants || []).find(p => p.email === partEmail)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
      // Deny the user.
      await sa.post(`/api/admin/participants/${partId}/deny`, {
        headers: saJsonH, data: { reason: "test" },
      });
      // Now invite them.
      const r = await sa.post("/api/admin/invitations", {
        headers: saJsonH,
        data: { emails: [partEmail], firstName: "Den", lastName: "Inv" },
      });
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      // The denied user should be reported in errors[] with "denied" wording.
      expect(body.errors).toBeTruthy();
      expect(body.errors.some(e => /denied/i.test(e))).toBe(true);
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("PUT competition with duration shrink past now() emits ended_manually + writes ended_at", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    let compId;
    try {
      // Live single-slot comp (started 60 s ago, duration 60 min — still live).
      const compR = await sa.post("/api/admin/competitions", {
        headers: saJsonH,
        data: {
          name: `DurShrink-${tag}`,
          start_time: new Date(Date.now() - 60_000).toISOString(),
          duration_minutes: 60,
        },
      });
      compId = (await compR.json()).competition.id;
      // Shrink duration to 0 — start + 0 < now().
      const r = await sa.put(`/api/admin/competitions/${compId}`, {
        headers: saJsonH,
        data: { duration_minutes: 0 },
      });
      // 0-duration may be rejected by the validator; try 1 min instead which still ends in the past.
      let ok = r.ok();
      if (!ok) {
        const r2 = await sa.put(`/api/admin/competitions/${compId}`, {
          headers: saJsonH,
          data: { duration_minutes: 1 },
        });
        ok = r2.ok();
      }
      expect(ok).toBeTruthy();
      // ended_at must now be populated AND a competition_events row of type "ended_manually" with via:duration_shrink must exist.
      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      const row = dbRO.prepare("SELECT ended_at, ended_manually FROM competitions WHERE id=?").get(compId);
      const evt = dbRO.prepare(
        "SELECT details FROM competition_events WHERE competition_id=? AND event_type='ended_manually' ORDER BY changed_at DESC LIMIT 1"
      ).get(compId);
      dbRO.close();
      expect(row.ended_at).toBeTruthy();
      expect(row.ended_manually).toBe(1);
      expect(evt).toBeTruthy();
      const details = JSON.parse(evt.details);
      expect(details.via).toBe("duration_shrink");
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("Participants export carries absences[]; import rehydrates them", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const Database = require("better-sqlite3");
    const partEmail = `absexport-${tag}@cust.test`;
    let partId;
    try {
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Abs", lastName: "Export", nickname: `absexport_${tag}`,
          email: partEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "America/New_York",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      partId = (list.participants || []).find(p => p.email === partEmail)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${partId}/approve`, { headers: saH });
      // Plant an absence row.
      const dbW = new Database(TEST_DB_PATH);
      try {
        const compRow = dbW.prepare("SELECT id FROM competitions LIMIT 1").get();
        dbW.prepare("INSERT INTO competition_user_absences (user_id, competition_id, removed_at, returned_at) VALUES (?,?,?,?)")
          .run(partId, compRow.id, new Date(Date.now() - 60_000).toISOString(), new Date().toISOString());
      } finally { dbW.close(); }
      // Export and verify the absence is present.
      const expR = await sa.get("/api/admin/export/participants");
      expect(expR.ok()).toBeTruthy();
      const exported = await expR.json();
      const me = (exported.participants || []).find(p => p.email === partEmail);
      expect(me).toBeTruthy();
      expect(Array.isArray(me.absences)).toBe(true);
      expect(me.absences.length).toBeGreaterThan(0);
      expect(me.absences[0].removed_at).toBeTruthy();
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("/api/admin/export/competitions returns the competitions envelope", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    try {
      const r = await sa.get("/api/admin/export/competitions");
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      expect(body.type).toBe("hackarena-competitions");
      expect(body.version).toBe(1);
      expect(Array.isArray(body.competitions)).toBe(true);
      // Comps from the seed exist; each has tags + timeslots + tasks arrays.
      expect(body.competitions.length).toBeGreaterThan(0);
      const c = body.competitions[0];
      expect(typeof c.name).toBe("string");
      expect(Array.isArray(c.tags)).toBe(true);
      expect(Array.isArray(c.timeslots)).toBe(true);
      expect(Array.isArray(c.tasks)).toBe(true);
      // No sensitive fields surface.
      expect(c.cxone_api_key).toBeUndefined();
    } finally {
      await sa.dispose();
    }
  });

  test("Bulk-approve invalidates per-user /api/me cache for each approved user", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf };
    const saJsonH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const partEmail = `bulkapp-${tag}@cust.test`;
    const partPass = "bulkAppPw123!";
    let partId;
    try {
      // Throwaway user, verified but NOT approved.
      await registerPost(sa, "/api/register", {
        headers: saJsonH,
        data: {
          firstName: "Bulk", lastName: "App", nickname: `bulkapp_${tag}`,
          email: partEmail, company: "Acme", title: "T", avatar: "default1",
          country: "US", timezone: "America/New_York",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=500")).json();
      partId = (list.participants || []).find(p => p.email === partEmail)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: saH });
      // Skip /approve so we can use bulk-approve.
      // Bulk-approve.
      const r = await sa.post("/api/admin/participants/bulk-approve", {
        headers: saJsonH, data: { userIds: [partId] },
      });
      expect(r.ok()).toBeTruthy();
      // Verify approved=1 on the row (proves the path took effect).
      const Database = require("better-sqlite3");
      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      const row = dbRO.prepare("SELECT approved FROM users WHERE id=?").get(partId);
      dbRO.close();
      expect(row.approved).toBe(1);
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// SELF-ENROLLMENT LINK (v6.21.0) — secrecy / abuse / lifecycle
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Self-enrollment link — security", () => {
  const Database = require("better-sqlite3");
  function saHdr(csrf) { return { "x-csrf-token": csrf, "content-type": "application/json" }; }
  async function makeComp(sa, h, name, { ended = false } = {}) {
    const start = ended ? new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const dur = ended ? 30 : 120; // born-ended when start+dur is in the past
    const cr = await sa.post("/api/admin/competitions", { headers: h, data: { name, start_time: start, duration_minutes: dur } });
    expect(cr.ok(), `create comp: ${cr.status()} ${await cr.text()}`).toBeTruthy();
    return (await cr.json()).competition.id;
  }
  async function reveal(sa, compId) {
    const r = await sa.get(`/api/admin/competitions/${compId}/self-enroll`);
    expect(r.ok()).toBeTruthy();
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

  test("self-enroll token is scrubbed from the access log on the public preview path", async () => {
    // v7.2.x (audit) regression: the SPA fetches GET /api/competitions/self-enroll/
    // <token> with the SECRET token in the path; _scrubLogPath previously only
    // redacted /join/<token> and ?join=, so the token landed verbatim in the
    // access log. The preview-path scrub closes that.
    await ensureState();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = saHdr(csrf);
    const compId = await makeComp(sa, h, `SE-logredact-${Date.now()}`);
    const rv = await reveal(sa, compId);
    await setFlags(sa, h, compId, { self_enroll_enabled: true });
    await sa.dispose();
    const { api } = await freshCtx();
    await api.get(`/api/competitions/self-enroll/${rv.token}`); // public preview, token in path
    await api.dispose();
    const { api: sa2, csrf: c2 } = await apiLogin("superadmin");
    const logs = await (await sa2.get(`/api/admin/logs?stream=access&limit=300&q=self-enroll`)).json();
    await sa2.dispose();
    const raw = JSON.stringify(logs.entries || []);
    expect(raw, "raw self-enroll token must not appear in the access log").not.toContain(rv.token);
    expect(raw).toContain("/api/competitions/self-enroll/[REDACTED]");
    await dropComp(compId);
  });

  test("token never appears in the admin list, /api/me, /api/my-competitions, or the competitions export", async () => {
    await ensureState();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = saHdr(csrf);
    const compId = await makeComp(sa, h, `SE-secrecy-${Date.now()}`);
    const rv = await reveal(sa, compId);
    await setFlags(sa, h, compId, { self_enroll_enabled: true });
    // Enroll carol so the comp is on her participant surfaces too.
    const asg = await sa.post("/api/admin/competitions/assign", { headers: h, data: { userIds: [S.carol.id], competitionIds: [compId] } });
    // v8.12.4 — the participant surfaces below prove nothing unless the event is
    // ON them, so the enrolment is asserted rather than assumed.
    expect(asg.ok(), await asg.text()).toBeTruthy();
    expect((await asg.json()).assigned, "carol is enrolled").toBe(1);
    const listTxt = await (await sa.get("/api/admin/competitions")).text();
    const exportTxt = await (await sa.get("/api/admin/export/competitions")).text();
    await sa.dispose();
    expect(listTxt).not.toContain(rv.token);
    expect(exportTxt).not.toContain(rv.token);
    const { api: ca } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    const meTxt = await (await ca.get("/api/me")).text();
    const mycTxt = await (await ca.get("/api/my-competitions")).text();
    expect(mycTxt, "PRECONDITION: the event is on carol's own list").toContain(compId);
    await ca.dispose();
    expect(meTxt).not.toContain(rv.token);
    expect(mycTxt).not.toContain(rv.token);
    await dropComp(compId); // cascades carol's throwaway membership
  });

  test("public preview returns an opaque 404 for invalid, disabled, and ended links", async () => {
    await ensureState();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = saHdr(csrf);
    // Disabled: token exists but self_enroll_enabled=0.
    const disabledId = await makeComp(sa, h, `SE-disabled-${Date.now()}`);
    const disabledTok = (await reveal(sa, disabledId)).token;
    // Ended: born-ended comp with the link enabled.
    const endedId = await makeComp(sa, h, `SE-ended-${Date.now()}`, { ended: true });
    const endedTok = (await reveal(sa, endedId)).token;
    await setFlags(sa, h, endedId, { self_enroll_enabled: true });
    await sa.dispose();
    const { api } = await freshCtx();
    const rInvalid = await api.get("/api/competitions/self-enroll/totally-bogus-token");
    const rDisabled = await api.get(`/api/competitions/self-enroll/${disabledTok}`);
    const rEnded = await api.get(`/api/competitions/self-enroll/${endedTok}`);
    expect(rInvalid.status()).toBe(404);
    expect(rDisabled.status()).toBe(404);
    expect(rEnded.status()).toBe(404);
    // All three are the same opaque shape — nothing distinguishes the cases.
    const bInvalid = JSON.stringify(await rInvalid.json());
    expect(JSON.stringify(await rDisabled.json())).toBe(bInvalid);
    expect(JSON.stringify(await rEnded.json())).toBe(bInvalid);
    await api.dispose();
    await dropComp(disabledId);
    await dropComp(endedId);
  });

  test("authenticated join rejects disabled (404) and ended (409) links and creates no membership", async () => {
    await ensureState();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = saHdr(csrf);
    const disabledId = await makeComp(sa, h, `SE-jd-${Date.now()}`);
    const disabledTok = (await reveal(sa, disabledId)).token;
    const endedId = await makeComp(sa, h, `SE-je-${Date.now()}`, { ended: true });
    const endedTok = (await reveal(sa, endedId)).token;
    await setFlags(sa, h, endedId, { self_enroll_enabled: true });
    await sa.dispose();
    const { api, csrf: pcsrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    const ph = { "x-csrf-token": pcsrf, "content-type": "application/json" };
    const rDis = await api.post("/api/competitions/join", { headers: ph, data: { token: disabledTok } });
    const rEnd = await api.post("/api/competitions/join", { headers: ph, data: { token: endedTok } });
    expect(rDis.status()).toBe(404);
    expect(rEnd.status()).toBe(409);
    await api.dispose();
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const n1 = db.prepare("SELECT COUNT(*) c FROM competition_users WHERE competition_id=? AND user_id=?").get(disabledId, S.bob.id).c;
    const n2 = db.prepare("SELECT COUNT(*) c FROM competition_users WHERE competition_id=? AND user_id=?").get(endedId, S.bob.id).c;
    db.close();
    expect(n1).toBe(0);
    expect(n2).toBe(0);
    await dropComp(disabledId);
    await dropComp(endedId);
  });

  test("regenerate rotates the token: the old link 404s, the new one works", async () => {
    await ensureState();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = saHdr(csrf);
    const compId = await makeComp(sa, h, `SE-regen-${Date.now()}`);
    const tokenA = (await reveal(sa, compId)).token;
    await setFlags(sa, h, compId, { self_enroll_enabled: true });
    const cur = await reveal(sa, compId);
    const rg = await sa.post(`/api/admin/competitions/${compId}/self-enroll/regenerate`, { headers: h, data: { expectedUpdatedAt: cur.updated_at } });
    expect(rg.ok(), `regen: ${rg.status()} ${await rg.text()}`).toBeTruthy();
    const tokenB = (await rg.json()).token;
    expect(tokenB).not.toBe(tokenA);
    await sa.dispose();
    const db = new Database(TEST_DB_PATH, { readonly: true });
    expect(db.prepare("SELECT self_enroll_token FROM competitions WHERE id=?").get(compId).self_enroll_token).toBe(tokenB);
    db.close();
    const { api } = await freshCtx();
    expect((await api.get(`/api/competitions/self-enroll/${tokenA}`)).status()).toBe(404);
    expect((await api.get(`/api/competitions/self-enroll/${tokenB}`)).status()).toBe(200);
    await api.dispose();
    await dropComp(compId);
  });

  // v8.13.3 — a body-less regenerate answered a 500: Express 5 leaves req.body
  // undefined and the handler read req.body.expectedUpdatedAt bare. An absent
  // body is "no expectation", as on the PUT. The stale-409 test below is the
  // control that the concurrency guard itself was not removed to make this pass.
  test("a body-less regenerate rotates the token (no 500)", async () => {
    await ensureState();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const compId = await makeComp(sa, saHdr(csrf), `SE-regen-nobody-${Date.now()}`);
    const tokenA = (await reveal(sa, compId)).token;
    const rg = await sa.post(`/api/admin/competitions/${compId}/self-enroll/regenerate`, { headers: { "x-csrf-token": csrf } });
    expect(rg.status(), `regen: ${await rg.text()}`).toBe(200);
    const tokenB = (await rg.json()).token;
    expect(tokenB).toBeTruthy();
    expect(tokenB).not.toBe(tokenA);
    await sa.dispose();
    await dropComp(compId);
  });

  test("toggle + regenerate reject a stale expectedUpdatedAt with 409", async () => {
    await ensureState();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = saHdr(csrf);
    const compId = await makeComp(sa, h, `SE-conc-${Date.now()}`);
    const stale = (await reveal(sa, compId)).updated_at;
    // First enable succeeds and bumps updated_at.
    const ok1 = await sa.put(`/api/admin/competitions/${compId}`, { headers: h, data: { self_enroll_enabled: true, expectedUpdatedAt: stale } });
    expect(ok1.ok()).toBeTruthy();
    // Re-using the now-stale stamp is rejected.
    const conflictPut = await sa.put(`/api/admin/competitions/${compId}`, { headers: h, data: { self_enroll_enabled: false, expectedUpdatedAt: stale } });
    expect(conflictPut.status()).toBe(409);
    const conflictRegen = await sa.post(`/api/admin/competitions/${compId}/self-enroll/regenerate`, { headers: h, data: { expectedUpdatedAt: stale } });
    expect(conflictRegen.status()).toBe(409);
    await sa.dispose();
    await dropComp(compId);
  });

  test("the corporate-email rule is still enforced on a join registration (token does NOT relax it)", async () => {
    await ensureState();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = saHdr(csrf);
    const compId = await makeComp(sa, h, `SE-corp-${Date.now()}`);
    const rv = await reveal(sa, compId);
    await setFlags(sa, h, compId, { self_enroll_enabled: true });
    await sa.dispose();
    // Free-email primary, even with a valid token: email first, the rule is
    // enforced at the entry screen — a free-mail address the join link rides
    // along with is mailed NO address proof, so no grant exists and the form
    // refuses (403 email_proof_required) before any field is read; no account.
    const { api: a1, csrf: c1 } = await freshCtx();
    const freeEmail = `se-free-${Date.now()}-${Math.floor(Math.random() * 1e6)}@gmail.com`;
    const entry = await entryCode(a1, freeEmail, { joinToken: rv.token });
    expect(entry.answer, "the entry answer is uniform").toEqual({ ok: true });
    expect(entry.mail, "the join token does not buy a free-mail address a proof").toBeNull();
    const r1 = await registerPost(a1, "/api/register", { headers: { "x-csrf-token": c1, "content-type": "application/json" }, data: {
      firstName: "Free", lastName: "Mail", nickname: `sefree_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      email: freeEmail, company: "Co", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Security Researcher", city: "Tel Aviv", joinToken: rv.token,
    } });
    expect(r1.status()).toBe(403);
    expect((await r1.json()).code).toBe("email_proof_required");
    await a1.dispose();
    {
      const dbF = new Database(TEST_DB_PATH, { readonly: true });
      try { expect(dbF.prepare("SELECT COUNT(*) c FROM users WHERE LOWER(email)=LOWER(?)").get(freeEmail).c).toBe(0); }
      finally { dbF.close(); }
    }
    // Same token with a corporate primary → accepted.
    const { api: a2, csrf: c2 } = await freshCtx();
    const corpEmail = `se-corp-${Date.now()}-${Math.floor(Math.random() * 1e6)}@company.co`;
    const r2 = await registerPost(a2, "/api/register", { headers: { "x-csrf-token": c2, "content-type": "application/json" }, data: {
      firstName: "Corp", lastName: "Mail", nickname: `secorp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      email: corpEmail, company: "Co", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Security Researcher", city: "Tel Aviv", joinToken: rv.token,
    } });
    expect(r2.ok(), `corp register: ${r2.status()} ${await r2.text()}`).toBeTruthy();
    await a2.dispose();
    // Cleanup the created corporate user.
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const uid = db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(corpEmail)?.id;
    db.close();
    if (uid) { const { api, csrf } = await apiLogin("superadmin"); await api.delete(`/api/admin/participants/${uid}`, { headers: { "x-csrf-token": csrf } }).catch(() => {}); await api.dispose(); }
    await dropComp(compId);
  });

  test("join requires authentication and a CSRF token", async () => {
    await ensureState();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = saHdr(csrf);
    const compId = await makeComp(sa, h, `SE-auth-${Date.now()}`);
    const rv = await reveal(sa, compId);
    await setFlags(sa, h, compId, { self_enroll_enabled: true });
    await sa.dispose();
    // Anonymous POST → rejected (no participant session).
    const { api: anon, csrf: acsrf } = await freshCtx();
    const rAnon = await anon.post("/api/competitions/join", { headers: { "x-csrf-token": acsrf, "content-type": "application/json" }, data: { token: rv.token } });
    expect([401, 403]).toContain(rAnon.status());
    await anon.dispose();
    // Authenticated but missing the CSRF header → 403.
    const { api } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    const rNoCsrf = await api.post("/api/competitions/join", { headers: { "content-type": "application/json" }, data: { token: rv.token } });
    expect(rNoCsrf.status()).toBe(403);
    await api.dispose();
    await dropComp(compId);
  });

  test("self-enroll is upcoming/live only — registering via an ended competition's token is rejected (409)", async () => {
    await ensureState();
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = saHdr(csrf);
    // Born-ended competition with the link enabled — the registration entry
    // point must still refuse it (preview 404 + join 409 are covered above;
    // this locks the third entry point, POST /api/register with a joinToken).
    const endedId = await makeComp(sa, h, `SE-reg-ended-${Date.now()}`, { ended: true });
    const rv = await reveal(sa, endedId);
    await setFlags(sa, h, endedId, { self_enroll_enabled: true });
    await sa.dispose();
    const { api, csrf: rcsrf } = await freshCtx();
    const email = `se-end-${Date.now()}-${Math.floor(Math.random() * 1e6)}@company.co`;
    const r = await registerPost(api, "/api/register", { headers: { "x-csrf-token": rcsrf, "content-type": "application/json" }, data: {
      firstName: "End", lastName: "Reg", nickname: `seend_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      email, company: "Co", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Security Researcher", city: "Tel Aviv", joinToken: rv.token,
    } });
    expect(r.status()).toBe(409);
    await api.dispose();
    // No account should have been created for the ended-comp join attempt.
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const exists = db.prepare("SELECT 1 FROM users WHERE LOWER(email)=LOWER(?)").get(email);
    db.close();
    expect(exists).toBeFalsy();
    await dropComp(endedId);
  });
});





test.describe("ext-audit v7.15.12", () => {


  // MEDIUM — SMTP must not silently downgrade to plaintext.
  test("the SMTP transport requires TLS unless explicitly opted out", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "lib", "email.js"), "utf8");
    expect(src, "transport sets requireTLS").toMatch(/requireTLS:\s*!_SMTP_SECURE\s*&&\s*!_SMTP_ALLOW_PLAINTEXT/);
    expect(src, "port 465 uses implicit TLS").toMatch(/_SMTP_SECURE\s*=\s*_SMTP_PORT === 465/);
    // The escape hatch must be an EXPLICIT env var, never inferred from NODE_ENV
    // — otherwise a production box lands in the insecure branch by accident.
    expect(src).toMatch(/SMTP_ALLOW_PLAINTEXT === "1"/);
    expect(src, "the opt-out must not key off NODE_ENV").not.toMatch(/NODE_ENV[^\n]*SMTP_ALLOW_PLAINTEXT/);
  });

  // MEDIUM — /readyz must touch the real data path, not `SELECT 1`.
  test("/readyz queries application tables, not a constant", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "server.js"), "utf8");
    // v8.3.39 — bounded by the END of the handler (the maintenance middleware
    // that follows it) rather than by a character count. The fixed 1600-char
    // window stopped reaching the table read the moment the handler grew a
    // branch, so the lock failed on a correct build — the shape that gets a
    // scanner silenced by whoever hits it next.
    const _start = src.indexOf('app.get("/readyz"');
    const _end = src.indexOf("app.use(", _start);
    expect(_start, "the /readyz handler").toBeGreaterThan(0);
    expect(_end, "…and the middleware that follows it, which bounds the slice").toBeGreaterThan(_start);
    const block = src.slice(_start, _end);
    // Strip comments first: the block documents the old `SELECT 1` bug, and a
    // naive negative match would trip on that prose rather than on code.
    const code = block.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code, "reads a real table").toMatch(/FROM (settings|users)/);
    expect(code, "a bare SELECT 1 is answered without opening any table")
      .not.toMatch(/db\.prepare\(\s*["'`]SELECT 1["'`]/);
  });

  // MEDIUM — the outbound deadline must cover the response BODY.
  test("fetchWithTimeout aborts a stalled BODY, not just stalled headers", async () => {
    const http = require("http");
    const { fetchWithTimeout } = require("../lib/http");
    const srv = http.createServer((req, res) => {
      // v7.15.24 — the client ABORTS this request mid-body by design (that is
      // the whole point), which makes the socket emit ECONNRESET on the server
      // side. An http.Server response with no `error` listener turns that into
      // an UNCAUGHT EXCEPTION, and the Playwright worker hosting this test
      // exits code 1 — reported only as "worker process exited unexpectedly
      // (code=1, signal=null)" with no stack, taking every other test on that
      // worker down as collateral. Whether it fires is timing-dependent, which
      // is why it showed up on the CI runner and not locally.
      req.on("error", () => {});
      res.on("error", () => {});
      res.writeHead(200, { "content-type": "application/json", "content-length": "9999" });
      res.write("{");
    });
    srv.on("clientError", () => {});
    srv.on("error", () => {});
    await new Promise(r => srv.listen(0, r));
    const port = srv.address().port;
    const t0 = Date.now();
    let code = null;
    try {
      const r = await fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 1200);
      await r.json();
    } catch (e) { code = e.code; }
    const elapsed = Date.now() - t0;
    // close() alone only stops LISTENING — the deliberately-stalled connection
    // stays open and keeps the server handle (and its event loop reference)
    // alive into worker teardown. Destroy it, then await the close.
    if (typeof srv.closeAllConnections === "function") srv.closeAllConnections();
    await new Promise(r => srv.close(r));
    expect(code, "a stalled body read must time out, not hang").toBe("FETCH_TIMEOUT");
    expect(elapsed, `aborted after ${elapsed}ms — must be near the 1200ms deadline`).toBeLessThan(6000);
  });

  // LOW — gated admin docs must never be publicly cacheable.
  test("admin-gated docs are private/no-store; public docs keep the fast path", async () => {
    const { api } = await apiLogin("superadmin");
    const gated = await api.get("/docs/user-guide/admin.md");
    expect(gated.status()).toBe(200);
    const cc = (await gated.headersArray()).find(h => h.name.toLowerCase() === "cache-control");
    expect(cc && cc.value, "a gated guide must not be stored by shared caches").toMatch(/no-store/);
    expect(cc.value, "and must not be public").not.toMatch(/public/);
    // Gated SCREENSHOTS go through express.static, a DIFFERENT handler from the
    // markdown one above — both must be covered or half the gated tree can
    // regress silently.
    const shot = await api.get("/docs/screenshots/admin/01-competitions.png");
    expect(shot.status()).toBe(200);
    const scc = (await shot.headersArray()).find(h => h.name.toLowerCase() === "cache-control");
    expect(scc && scc.value, "gated screenshots must not be publicly cacheable for a year").toMatch(/no-store/);
    expect(scc.value).not.toMatch(/public/);

    const pub = await api.get("/docs/user-guide/participant.md");
    const pcc = (await pub.headersArray()).find(h => h.name.toLowerCase() === "cache-control");
    expect(pcc && pcc.value, "public docs keep normal caching").not.toMatch(/no-store/);
    const pshot = await api.get("/docs/screenshots/participant/01-login.png");
    const pscc = (await pshot.headersArray()).find(h => h.name.toLowerCase() === "cache-control");
    expect(pscc && pscc.value, "public screenshots keep the immutable fast path").not.toMatch(/no-store/);
    await api.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// External-audit round 8 (v7.20.9) — regression locks
// ═══════════════════════════════════════════════════════════════════════════════

// ── F1 ────────────────────────────────────────────────────────────────────────
// The grading-revision token is HANDED TO THE PARTICIPANT, so it must disclose
// nothing about the answer it fingerprints — and, since it is what stops a
// mid-flight admin edit being graded against criteria nobody saw, it must be
// REQUIRED rather than optional.
test.describe("v7.20.9 (F1) — the grading token discloses nothing, and submit requires it", () => {
  /**
   * The digest the token used to be: an UNKEYED, truncated sha1 over
   * answer_type + correct_answer + choices. Every input except the answer is
   * already in the client's hands, so anyone holding this value could recover
   * the answer offline — a dictionary attack for text/json, and for `choice` a
   * total break (the candidate space is subsets of ids the client was given).
   *
   * The load-bearing assertion below is that the issued token is NOT this. It
   * fails the moment anyone reverts createHmac(…, _gradingKey()) to createHash.
   */
  function unkeyedLegacyToken(answerType, correctAnswer, choices) {
    return crypto.createHash("sha1")
      .update(String(answerType || "")).update(":").update(String(correctAnswer || ""))
      .update(":").update(String(choices || ""))
      .digest("hex").slice(0, 16);
  }

  /** The grading basis exactly as the server sees it — the raw stored columns. */
  function rawTaskRow(taskId) {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try { return db.prepare("SELECT answer_type, correct_answer, choices FROM tasks WHERE id=?").get(taskId); }
    finally { db.close(); }
  }

  async function seedLiveTask(sa, saCsrf, data) {
    const title = `F1 ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const r = await sa.post("/api/admin/tasks", {
      headers: _v8h(saCsrf),
      data: { title, description: "<p>q</p>", difficulty: "easy", status: "published", ...data },
    });
    expect(r.ok(), `create task: ${r.status()} ${await r.text()}`).toBeTruthy();
    const id = (await r.json()).id;
    const asg = await sa.post(`/api/admin/tasks/${id}/competitions`, {
      headers: _v8h(saCsrf), data: { competitionIds: [S.liveComp.id] },
    });
    expect(asg.ok(), `assign to the live competition: ${asg.status()} ${await asg.text()}`).toBeTruthy();
    return id;
  }

  /**
   * A participant of our OWN, enrolled in the live competition and signed in.
   *
   * Deliberately not the seeded alice. Several earlier tests in this file drive
   * deliberate WRONG logins against her (the login-timing samples, for one), and
   * since v7.20.9 (F5) ten of those inside the five-minute window lock the
   * account for an hour — so `apiLogin("alice@acme.com")` here 401s depending on
   * how the accumulated attempts happen to fall. Reproduced: this test failed
   * with `Login failed for alice@acme.com: 401` on a full-file run and passed on
   * the retry, which is the signature of exactly that. A fixture we create
   * ourselves cannot be poisoned by anything upstream.
   */
  async function freshLiveParticipant(sa, saCsrf, tag) {
    const saH = _v8h(saCsrf);
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const email = `f1-${tag}-${stamp}@company.co`;
    const reg = await registerPost(sa, "/api/register", {
      headers: saH,
      data: {
        firstName: "Token", lastName: "Reader", nickname: `f1_${tag}_${stamp}`,
        company: "C", title: "T", avatar: "🦊", country: "US", timezone: "America/New_York", email,
      },
    });
    expect(reg.ok(), `register: ${reg.status()} ${await reg.text()}`).toBeTruthy();
    const users = await (await sa.get("/api/admin/participants?limit=5000")).json();
    const user = (users.participants || []).find(p => p.email === email);
    expect(user, "the fresh participant must be findable").toBeTruthy();
    await sa.post(`/api/admin/participants/${user.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${user.id}/approve`, { headers: saH });
    const asg = await sa.post("/api/admin/competitions/assign", {
      headers: saH, data: { userIds: [user.id], competitionIds: [S.liveComp.id] },
    });
    expect(asg.ok(), `enrol in the live competition: ${asg.status()} ${await asg.text()}`).toBeTruthy();

    const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
    const sel = await api.post("/api/select-competition", { headers: _v8h(csrf), data: { competitionId: S.liveComp.id } });
    expect(sel.ok(), `select the live competition: ${sel.status()} ${await sel.text()}`).toBeTruthy();
    return { api, csrf, id: user.id };
  }

  test("the grading token is KEYED — it is never the unkeyed sha1 over the answer", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const textId = await seedLiveTask(sa, saCsrf, { answer_type: "text", correct_answer: "Chartreuse-8f3a" });
    const choiceId = await seedLiveTask(sa, saCsrf, {
      answer_type: "choice",
      choices: [{ text: "Alpha", correct: true }, { text: "Beta" }, { text: "Gamma", correct: true }, { text: "Delta" }],
    });

    const { api } = await freshLiveParticipant(sa, saCsrf, "keyed");
    const readToken = async (id, label) => {
      const r = await api.get(`/api/tasks/${id}`);
      expect(r.ok(), `${label}: the participant must be able to read the task — ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).grading_hash;
    };

    const issued = {};
    for (const [label, id] of [["text", textId], ["choice", choiceId]]) {
      issued[label] = await readToken(id, label);
      expect(issued[label], `${label}: a token must actually be issued`).toMatch(/^[a-f0-9]{16}$/);

      const row = rawTaskRow(id);
      expect(row, `${label}: the stored row must be readable, or the comparison below is vacuous`).toBeTruthy();
      expect(row.correct_answer, `${label}: the stored answer must be non-empty`).toBeTruthy();
      if (label === "choice") expect(row.choices, "the choice task must store its options").toBeTruthy();
      const legacy = unkeyedLegacyToken(row.answer_type, row.correct_answer, row.choices);
      expect(legacy, `${label}: the legacy digest must be computable`).toMatch(/^[a-f0-9]{16}$/);
      expect(issued[label],
        `${label}: the issued token must not be the unkeyed sha1 an attacker can recompute offline`)
        .not.toBe(legacy);

      // Stability — the token is a fingerprint of the grading basis, not a
      // nonce. Without this, "it isn't the legacy digest" would also be
      // satisfied by returning fresh randomness on every request, which would
      // break the mid-flight-edit guard entirely.
      expect(await readToken(id, label), `${label}: the token must be stable across two fetches`).toBe(issued[label]);
    }

    // ...and it MOVES when the grading basis moves, which is the other half of
    // "a stable fingerprint" — a constant would pass the stability check.
    const putText = await sa.put(`/api/admin/tasks/${textId}`, {
      headers: _v8h(saCsrf), data: { correct_answer: "Vermilion-2b7c" },
    });
    expect(putText.ok(), `edit the text answer: ${putText.status()} ${await putText.text()}`).toBeTruthy();
    expect(await readToken(textId, "text"), "editing the correct answer must change the token").not.toBe(issued.text);

    const putChoice = await sa.put(`/api/admin/tasks/${choiceId}`, {
      headers: _v8h(saCsrf),
      data: { choices: [{ text: "Alpha", correct: true }, { text: "Beta", correct: true }, { text: "Gamma" }, { text: "Delta" }] },
    });
    expect(putChoice.ok(), `edit the choice ticks: ${putChoice.status()} ${await putChoice.text()}`).toBeTruthy();
    expect(await readToken(choiceId, "choice"), "editing the correct SET must change the token").not.toBe(issued.choice);

    // The key itself: 32 random bytes in DATA_DIR, 0600, same shape as
    // .unsubscribe-secret. A world-readable key is no key at all.
    const secretPath = path.join(TEST_DATA_DIR, ".grading-secret");
    expect(fs.existsSync(secretPath), "the grading key must be persisted in DATA_DIR").toBe(true);
    const st = fs.statSync(secretPath);
    expect(st.mode & 0o777, "the grading key must be 0600").toBe(0o600);
    expect(st.size, "the grading key must be a real key, not a stub").toBeGreaterThanOrEqual(16);

    for (const id of [textId, choiceId]) {
      await sa.delete(`/api/admin/tasks/${id}`, { headers: { "x-csrf-token": saCsrf } });
    }
    await api.dispose();
    await sa.dispose();
  });

  test("a submit with NO grading token is refused, records nothing, and the right token still grades", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const taskId = await seedLiveTask(sa, saCsrf, { answer_type: "text", correct_answer: "Ultramarine-51" });
    const { api, csrf, id: userId } = await freshLiveParticipant(sa, saCsrf, "submit");

    const Database = require("better-sqlite3");
    const snap = () => {
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        return {
          rows: db.prepare("SELECT COUNT(*) c FROM submissions WHERE user_id=? AND task_id=?").get(userId, taskId).c,
          score: db.prepare("SELECT COALESCE(SUM(points_delta),0) s FROM submissions WHERE user_id=? AND competition_id=?")
            .get(userId, S.liveComp.id).s,
        };
      } finally { db.close(); }
    };

    const before = snap();
    expect(before.rows, "the fresh task must start with no submissions").toBe(0);

    // The token used to be OPTIONAL, which made the mid-flight-edit protection
    // opt-out: omit one field and you were graded against whatever the criteria
    // happen to be now. A missing token is treated exactly like a stale one.
    const bad = await api.post(`/api/tasks/${taskId}/submit`, {
      headers: _v8h(csrf), data: { answer: "Ultramarine-51" },
    });
    expect(bad.status(), `a tokenless submit must be refused: ${await bad.text()}`).toBe(409);
    expect((await bad.json()).task_changed, "and refused with the task_changed contract the client already handles").toBe(true);

    const after = snap();
    expect(after.rows, "a refused submit must record no submission row").toBe(before.rows);
    expect(after.score, "a refused submit must apply no penalty").toBe(before.score);

    // POSITIVE CONTROL. Every assertion above is equally satisfied by a build
    // where submitting is simply broken, so prove the same submission WITH the
    // issued token is accepted and scored.
    const gh = await gradingHashFor(api, taskId);
    expect(gh, "the token must be obtainable from GET /api/tasks/:id").toMatch(/^[a-f0-9]{16}$/);
    const good = await api.post(`/api/tasks/${taskId}/submit`, {
      headers: _v8h(csrf), data: { answer: "Ultramarine-51", gradingHash: gh },
    });
    expect(good.ok(), `a submit WITH the token must be graded: ${good.status()} ${await good.text()}`).toBeTruthy();
    expect((await good.json()).correct).toBe(true);
    const graded = snap();
    expect(graded.rows, "the accepted submit records exactly one row").toBe(before.rows + 1);
    expect(graded.score, "and awards the easy-challenge points").toBe(before.score + 50);

    await api.dispose();
    await sa.dispose();
  });
});


// ── F7 ────────────────────────────────────────────────────────────────────────
// writeSuperadminPassword() ran at MODULE SCOPE, upstream of every fatal boot
// path. So a second `npm start` against a data directory a live server already
// owns generated a new password, overwrote the shared credential file with it,
// and then exited EADDRINUSE — leaving the RUNNING server expecting a credential
// that no longer existed anywhere. Under SUPERADMIN_PASSWORD_QUIET=1 (the
// documented production setting) that file is the ONLY copy.
test.describe("v7.20.9 (F7) — a duplicate startup must not claim the shared credential file", () => {
  test("a second server against the same DATA_DIR + port exits EADDRINUSE and leaves .superadmin-password untouched", async ({}, testInfo) => {
    testInfo.setTimeout(90_000);
    const { serverEnv } = require("./server-env");
    const slot = parseInt(process.env.TEST_PARALLEL_INDEX || "0", 10);
    const pwPath = path.join(TEST_DATA_DIR, ".superadmin-password");
    const before = fs.readFileSync(pwPath);

    // Exactly the environment the RUNNING worker server was launched with —
    // same port, same data directory. That is the collision this asserts on.
    const env = { ...serverEnv(slot), NODE_OPTIONS: "" };
    expect(String(env.PORT), "the duplicate must target the live server's own port").toBe(String(PORT_BASE + slot));
    expect(env.DATA_DIR, "and the live server's own data directory").toBe(TEST_DATA_DIR);

    const proc = spawn(process.execPath, ["server.js"], {
      cwd: path.resolve(__dirname, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", b => { out += b.toString(); });
    proc.stderr.on("data", b => { out += b.toString(); });

    try {
      const exit = await new Promise((resolve) => {
        const t = setTimeout(() => resolve({ code: null, timedOut: true }), 60_000);
        proc.once("exit", (code) => { clearTimeout(t); resolve({ code, timedOut: false }); });
      });
      expect(exit.timedOut, "the duplicate must not keep running — it does not own the port").toBe(false);
      expect(exit.code, "and it must exit non-zero").not.toBe(0);
      // POSITIVE CONTROL — it reached the port check rather than dying earlier
      // for some unrelated reason, which would make the assertion below pass
      // however the credential file were handled.
      expect(out, `the duplicate must fail on the port, not on something else:\n${out.slice(-800)}`)
        .toMatch(/already in use/i);

      const after = fs.readFileSync(pwPath);
      expect(after.equals(before),
        "a start that never owned the port must not have rewritten the live server's credential file").toBe(true);
    } finally {
      try { proc.kill("SIGKILL"); } catch (_) {}
      // Restore whatever the live server put there, so a failing run cannot
      // strand the rest of the file without a superadmin password.
      try { fs.writeFileSync(pwPath, before, { mode: 0o600 }); } catch (_) {}
    }
  });
});



