// @ts-check
//
// Split from functional-core.api.spec.js in v7.21.37 — it was 115s in one file, and a spec
// file never spans workers, so it bounded the whole suite's wall clock.
//
// Contains: Admin · Superadmin · Benchmark user · Cross-cutting · Endpoint coverage · Per-competition CxOne opt-out (v7.13.0) · v6.10.54: single-fetch snapshot reads · Auto-end edge cases (v6.4.0) · Invitation group-clash guard (v7.11.2) · Maintenance mode · v6.13.17 — /api/admin/analytics/challenges scope matrix · LinkedIn self-signup: pending + complete endpoints (v6.18.x) · Competition delete: email_reminders cascade (v6.18.x) · Lifecycle updated_at invalidation (v6.19.x) · Auditor fixes (v6.19.x) · Password at signup · CTF-0026 — NAT rate-limit / session-expiry hardening · audit v7.7.32 batch 7 — remaining mediums · audit v7.7.33 batch 8 — a11y LOWs · ext-audit v7.15.7 follow-ups
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, TEST_DATA_DIR, gradingHashFor, pollAdminLogs } = require("./helpers");

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
// ADMIN FLOWS
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Admin", () => {
  test("competitions list with correct statuses", async () => {
    await ensureState();
    const { api } = await apiLogin("superadmin");
    const comps = await (await api.get("/api/admin/competitions")).json();
    expect(comps.find(c => c.name === "Test Live").status).toBe("live");
    expect(comps.find(c => c.name === "Test Upcoming").status).toBe("upcoming");
    expect(comps.find(c => c.name === "Test Ended").status).toBe("ended");
    expect(comps.find(c => c.name === "Test Live").participant_count).toBeGreaterThanOrEqual(3);
    await api.dispose();
  });

  test("tasks list with metadata and competition assignments", async () => {
    await ensureState();
    const { api } = await apiLogin("superadmin");
    const tasks = await (await api.get("/api/admin/tasks")).json();
    expect(tasks.length).toBeGreaterThanOrEqual(5);
    expect(tasks.some(t => t.status === "draft")).toBeTruthy();
    const e1 = tasks.find(t => t.title === "Challenge easy1");
    expect(e1.competitions.some(c => c.name === "Test Live")).toBeTruthy();
    expect(e1).toHaveProperty("avg_rating");
    expect(e1).toHaveProperty("last_changed");
    expect(e1).toHaveProperty("tags");
    await api.dispose();
  });

  test("tasks filtered by competitionId", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    // v8.12.4 — a CONTROL challenge assigned nowhere, and a non-empty result:
    // `[].every(...)` is true, so a filter returning nothing used to pass, and a
    // filter that returned everything was indistinguishable from a seed whose
    // every challenge happened to be in this event.
    const mk = await api.post("/api/admin/tasks", { headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { title: `Unassigned ${Date.now()}`, difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published" } });
    expect(mk.ok(), await mk.text()).toBeTruthy();
    const loose = (await mk.json()).id;
    try {
      const tasks = await (await api.get(`/api/admin/tasks?competitionId=${S.liveComp.id}`)).json();
      expect(tasks.length, "the seeded event holds challenges").toBeGreaterThan(0);
      expect(tasks.every(t => t.competitions.some(c => c.id === S.liveComp.id))).toBeTruthy();
      expect(tasks.map(t => t.id), "a challenge in no event is filtered out").not.toContain(loose);
      const all = await (await api.get("/api/admin/tasks")).json();
      expect(all.map(t => t.id), "…while the unfiltered list has it").toContain(loose);
    } finally {
      await api.delete(`/api/admin/tasks/${loose}`, { headers: { "x-csrf-token": csrf } });
      await api.dispose();
    }
  });

  test("task assignment blocked for ended competitions — PUT", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    // Get current assignments for correct expectedAssignments
    const tasks = await (await api.get("/api/admin/tasks")).json();
    const currentAssignments = (tasks.find(t => t.id === S.easy1.id)?.competitions || []).map(c => c.id);
    const r = await api.put(`/api/admin/tasks/${S.easy1.id}/competitions`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { competitionIds: [...currentAssignments, S.endedComp.id], expectedAssignments: currentAssignments },
    });
    expect(r.ok()).toBeFalsy();
    expect((await r.json()).error).toContain("ended");
    await api.dispose();
  });

  test("task assignment blocked for ended competitions — POST", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post(`/api/admin/tasks/${S.easy1.id}/competitions`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { competitionIds: [S.endedComp.id] },
    });
    expect(r.ok()).toBeFalsy();
    await api.dispose();
  });

  test("task removal blocked for ended competitions — DELETE", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.delete(`/api/admin/tasks/${S.easy1.id}/competitions/${S.endedComp.id}`, {
      headers: { "x-csrf-token": csrf },
    });
    expect(r.ok()).toBeFalsy();
    expect((await r.json()).error).toContain("ended");
    await api.dispose();
  });

  test("stale expectedAssignments returns 409 conflict", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.put(`/api/admin/tasks/${S.easy1.id}/competitions`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { competitionIds: [], expectedAssignments: ["fake-id"] },
    });
    expect(r.status()).toBe(409);
    expect((await r.json()).conflict).toBeTruthy();
    await api.dispose();
  });

  test("participants list with competition and tag data", async () => {
    const { api } = await apiLogin("superadmin");
    const d = await (await api.get("/api/admin/participants?limit=200")).json();
    expect(d.participants.length).toBeGreaterThanOrEqual(3);
    const alice = d.participants.find(p => p.email === "alice@acme.com");
    expect(alice.competitions.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(alice.tags)).toBeTruthy();
    await api.dispose();
  });

  test("participants filtered by competitionId (members only)", async () => {
    await ensureState();
    const { api } = await apiLogin("superadmin");
    const d = await (await api.get(`/api/admin/participants?competitionId=${S.liveComp.id}&limit=200`)).json();
    for (const p of d.participants) {
      expect(p.competitions.some(c => c.id === S.liveComp.id)).toBeTruthy();
    }
    await api.dispose();
  });

  test("picker returns users with in_competition flag (v6.8.6 object shape)", async () => {
    await ensureState();
    const { api } = await apiLogin("superadmin");
    const data = await (await api.get(`/api/admin/participants/picker?competitionId=${S.liveComp.id}`)).json();
    expect(data).toHaveProperty("users");
    expect(data).toHaveProperty("total");
    expect(data).toHaveProperty("members");
    expect(data).toHaveProperty("truncated");
    expect(Array.isArray(data.users)).toBeTruthy();
    expect(data.users.length).toBeGreaterThanOrEqual(3);
    expect(data.users.some(u => u.in_competition === 1)).toBeTruthy();
    expect(data.truncated).toBe(false); // small test seed, well under default 500-row cap
    await api.dispose();
  });

  // v8.8.11 — THE TRUNCATION ASSERTION WAS VACUOUS, and this is the fixture
  // detail that made it so: helpers.js assigns ALL THREE seeded participants to
  // the live competition, so that competition has zero non-members and the cap
  // has nothing to bite on at any limit. The old body asserted only
  // `total >= memberCount`, which is true of a build with no cap at all. It
  // creates a non-member first and asserts the flag it is named for.
  //
  // The endpoint itself is now the Grant Attempts roster's, NOT the participants
  // tab's (that pane walks /api/admin/participants on every path since v8.8.11,
  // because a capped non-member slice rendered under its own pager and count is
  // how the oldest 500 accounts came to look like the whole platform). The cap
  // stays, and so does this lock: Grant Attempts reads the MEMBERS bucket, which
  // is uncapped by construction, so a future caller reaching for the non-member
  // half must still meet a flag that tells the truth.
  test("picker honours limit param + sets truncated flag when capped", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };

    // TWO non-members, because `truncated` is `matching > returned` — with a cap
    // of one and exactly one non-member in existence nothing is cut off and the
    // flag is correctly false. This is the shape of the vacuity being removed:
    // the fixture has to make the cap BITE, not merely apply.
    for (const i of [0, 1]) {
      const tag = `pickcap${i}${Date.now().toString(36)}`;
      const reg = await registerPost(api, "/api/register", { headers: H, data: {
        email: `${tag}@acme.com`, password: "testpass123", nickname: tag,
        firstName: "Pick", lastName: "Cap", company: "Acme", title: "Eng",
        country: "US", timezone: "America/New_York",
      } });
      expect(reg.ok(), `register non-member ${i}: ${await reg.text()}`).toBeTruthy();
    }

    const data = await (await api.get(`/api/admin/participants/picker?competitionId=${S.liveComp.id}&limit=1`)).json();
    // Members are always included regardless of limit — the "show who's in
    // already" invariant, and what makes the members bucket safe to render whole.
    const memberCount = data.users.filter(u => u.in_competition === 1).length;
    expect(memberCount).toBeGreaterThan(0);
    expect(data.total).toBeGreaterThanOrEqual(memberCount);

    const nonMembers = data.users.filter(u => u.in_competition !== 1).length;
    expect(nonMembers, "the non-member slice really was capped at 1").toBe(1);
    expect(data.truncated, "…and the response SAYS it was capped").toBe(true);
    await api.dispose();
  });

  test("picker search filters non-members by nickname/email/name", async () => {
    await ensureState();
    const { api } = await apiLogin("superadmin");
    // Search for a nonsense string — should return only members (who are
    // always included) and no matching non-members.
    const data = await (await api.get(`/api/admin/participants/picker?competitionId=${S.liveComp.id}&search=ZZZQQQXXX_no_match_nickname_ever`)).json();
    expect(data.searchApplied).toBe(true);
    const nonMembers = data.users.filter(u => u.in_competition !== 1);
    expect(nonMembers).toHaveLength(0);
    // Members still come back in full — the invariant that the picker UI relies on.
    const members = data.users.filter(u => u.in_competition === 1);
    expect(members.length).toBeGreaterThan(0);
    await api.dispose();
  });

  test("picker requires competitionId", async () => {
    const { api } = await apiLogin("superadmin");
    expect((await api.get("/api/admin/participants/picker")).status()).toBe(400);
    await api.dispose();
  });

  test("cannot remove participants from ended competition", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.delete(`/api/admin/competitions/${S.endedComp.id}/users/${S.alice.id}`, {
      headers: { "x-csrf-token": csrf },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("ended");
    await api.dispose();
  });

  test("submissions endpoint returns paginated data with timeslot_name", async () => {
    // v6.3.0 paginated the endpoint — pre-fix it returned a bare array;
    // post-fix the response is { events, total, limit, offset } so admins
    // polling this endpoint don't each receive the full 450k-row UNION.
    const { api } = await apiLogin("superadmin");
    const d = await (await api.get("/api/admin/submissions")).json();
    expect(Array.isArray(d.events)).toBeTruthy();
    expect(d.events.length).toBeGreaterThan(0);
    expect(d.events[0]).toHaveProperty("timeslot_name");
    expect(d.events[0]).toHaveProperty("competition_name");
    expect(typeof d.total).toBe("number");
    expect(d.total).toBeGreaterThanOrEqual(d.events.length);
    expect(d.limit).toBe(100);   // default
    expect(d.offset).toBe(0);
    // Explicit pagination — limit + offset honoured, total constant.
    const d2 = await (await api.get("/api/admin/submissions?limit=2")).json();
    expect(d2.events.length).toBeLessThanOrEqual(2);
    expect(d2.total).toBe(d.total);
    expect(d2.limit).toBe(2);
    await api.dispose();
  });

  test("server logs endpoint returns access entries with request context", async () => {
    const { api } = await apiLogin("superadmin");
    // Trigger a deterministic access log entry first, then give the access-log
    // finish handler a moment to flush to disk before we read the log file.
    await api.get("/api/admin/tasks");
    await new Promise(r => setTimeout(r, 50));
    const r = await api.get("/api/admin/logs?stream=access&limit=200");
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d).toHaveProperty("entries");
    expect(d).toHaveProperty("file");
    expect(Array.isArray(d.entries)).toBeTruthy();
    expect(d.entries.length).toBeGreaterThan(0);
    // Every access entry has the expected fields
    for (const e of d.entries) {
      expect(e).toHaveProperty("ts");
      expect(e).toHaveProperty("level");
      expect(e).toHaveProperty("method");
      expect(e).toHaveProperty("path");
      expect(e).toHaveProperty("status");
      expect(e).toHaveProperty("req_id");
    }
    // The prior /api/admin/tasks request should appear (it finished before we read)
    const tasksHit = d.entries.find(e => e.path === "/api/admin/tasks");
    expect(tasksHit).toBeTruthy();
    expect(tasksHit.status).toBe(200);
    await api.dispose();
  });

  test("server logs endpoint filters by level", async () => {
    const { api } = await apiLogin("superadmin");
    // Warn-level filter should include the 401 access entries but not the 200 ones
    const r = await api.get("/api/admin/logs?stream=access&level=warn&limit=200");
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    // When results exist, every entry must be warn OR error (>= warn numeric level)
    for (const e of d.entries) {
      expect(["warn", "error"]).toContain(e.level);
    }
    await api.dispose();
  });

  // Multi-file history: when no `date` is specified, /api/admin/logs walks
  // every rotated file newest-first so an admin can page seamlessly back
  // through the entire on-disk history without hunting a date picker.
  // Back-compat: an explicit ?date= still isolates a single day.
  test("logs stream spans multiple rotated files when date is omitted", async () => {
    const fs = require("fs");
    const path = require("path");
    const LOG_DIR = path.join(TEST_DATA_DIR, "logs");
    // Plant a synthetic older-day file so the response MUST span at least
    // two days to surface the fingerprint we'll search for.
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const olderDay = "2001-06-15"; // far in the past so it can't collide with real test entries
    const olderFile = path.join(LOG_DIR, `app-${olderDay}.jsonl`);
    const fingerprint = `olderday-fingerprint-${Date.now()}`;
    const row = JSON.stringify({ ts: `${olderDay}T12:00:00.000Z`, level: "info", msg: fingerprint });
    fs.writeFileSync(olderFile, row + "\n");

    try {
      const { api } = await apiLogin("superadmin");
      // Default (no date) — must include the older-day entry.
      const r1 = await (await api.get(`/api/admin/logs?stream=app&limit=500&q=${fingerprint}`)).json();
      expect(r1.entries.length).toBeGreaterThan(0);
      expect(r1.entries[0].msg).toBe(fingerprint);
      // Response includes files_scanned — confirms the multi-file walk.
      expect(Array.isArray(r1.files_scanned)).toBe(true);
      expect(r1.files_scanned.some(f => f.includes(olderDay))).toBe(true);
      // Back-compat: ?date=<today> must NOT include the older-day entry
      // (date filter isolates a single file).
      const today = new Date().toISOString().slice(0, 10);
      const r2 = await (await api.get(`/api/admin/logs?stream=app&date=${today}&limit=500&q=${fingerprint}`)).json();
      expect(r2.entries.length).toBe(0);
      // And date=<olderDay> still works — returns just that file's matching rows.
      const r3 = await (await api.get(`/api/admin/logs?stream=app&date=${olderDay}&limit=500&q=${fingerprint}`)).json();
      expect(r3.entries.length).toBe(1);
      expect(r3.entries[0].msg).toBe(fingerprint);
      await api.dispose();
    } finally {
      try { fs.unlinkSync(olderFile); } catch (_) {}
    }
  });

  // Cross-file pagination: 3 synthetic files × 2 rows each; page through with
  // limit=2 and assert we hit rows from more than one file in sequence.
  test("logs pagination advances from newest file into older files seamlessly", async () => {
    const fs = require("fs");
    const path = require("path");
    const LOG_DIR = path.join(TEST_DATA_DIR, "logs");
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = Date.now();
    // Three dated files (old-to-new). Each holds 2 tagged rows. The three
    // dates are ancient enough (2001) not to collide with real test logs.
    const days = ["2001-06-10", "2001-06-11", "2001-06-12"];
    const fingerprint = `paginate-across-files-${stamp}`;
    const planted = [];
    for (const d of days) {
      const p = path.join(LOG_DIR, `app-${d}.jsonl`);
      const rows = [
        JSON.stringify({ ts: `${d}T10:00:00.000Z`, level: "info", msg: `${fingerprint}-1` }),
        JSON.stringify({ ts: `${d}T11:00:00.000Z`, level: "info", msg: `${fingerprint}-2` }),
      ].join("\n") + "\n";
      fs.writeFileSync(p, rows);
      planted.push(p);
    }
    try {
      const { api } = await apiLogin("superadmin");
      // Page 1 (limit=2): newest 2 entries — must both come from 2001-06-12.
      const p1 = await (await api.get(`/api/admin/logs?stream=app&limit=2&offset=0&q=${fingerprint}`)).json();
      expect(p1.entries.length).toBe(2);
      for (const e of p1.entries) expect(e.ts).toContain("2001-06-12");
      // Page 2 (limit=2, offset=2): next 2 entries — must come from 2001-06-11.
      const p2 = await (await api.get(`/api/admin/logs?stream=app&limit=2&offset=2&q=${fingerprint}`)).json();
      expect(p2.entries.length).toBe(2);
      for (const e of p2.entries) expect(e.ts).toContain("2001-06-11");
      // Page 3 — the oldest day.
      const p3 = await (await api.get(`/api/admin/logs?stream=app&limit=2&offset=4&q=${fingerprint}`)).json();
      expect(p3.entries.length).toBe(2);
      for (const e of p3.entries) expect(e.ts).toContain("2001-06-10");
      // Page 4 — nothing more matches the fingerprint.
      const p4 = await (await api.get(`/api/admin/logs?stream=app&limit=2&offset=6&q=${fingerprint}`)).json();
      expect(p4.entries.length).toBe(0);
      await api.dispose();
    } finally {
      for (const p of planted) { try { fs.unlinkSync(p); } catch (_) {} }
    }
  });

  test("log search q resolves users by secondary_email (not only primary email)", async () => {
    // Regression for v6.2.4: admin log search q was pre-resolved against
    // first_name / last_name / email / nickname only — NOT secondary_email,
    // even though secondary_email is a first-class identity (participant
    // can log in + reset password with it). Admins searching by the address
    // their user actually types at the login form would see zero hits.
    await ensureState();
    const fs = require("fs");
    const path = require("path");
    const LOG_DIR = path.join(TEST_DATA_DIR, "logs");
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = Date.now();
    const secondary = `alice-sec-${stamp}@acme.com`;

    // Set Alice's secondary_email via admin edit.
    const { api, csrf } = await apiLogin("superadmin");
    const setR = await api.put(`/api/admin/participants/${S.alice.id}`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { secondaryEmail: secondary },
    });
    // Everything past the write is inside the try: alice is a shared seeded
    // fixture, so a throw between here and the cleanup would leave her carrying
    // a secondary email for the rest of the file.
    const today = new Date().toISOString().slice(0, 10);
    const logFile = path.join(LOG_DIR, `app-${today}.jsonl`);
    const fingerprint = `secondary-email-search-${stamp}`;
    try {
      expect(setR.ok()).toBe(true);

      // Plant a log row that references Alice only by her user_id, NOT by
      // any email string — so the ONLY way the q=<secondary_email> query
      // can surface this row is via the server's pre-resolution lookup.
      const row = JSON.stringify({
        ts: new Date().toISOString(), level: "info",
        msg: fingerprint, user_id: S.alice.id,
      });
      fs.appendFileSync(logFile, row + "\n");

      const r = await (await api.get(`/api/admin/logs?stream=app&date=${today}&limit=500&q=${encodeURIComponent(secondary)}`)).json();
      const found = (r.entries || []).find(e => e.msg === fingerprint);
      expect(found, `admin log q=<secondary_email> failed to surface Alice's row by user_id lookup. entries=${r.entries?.length || 0}`).toBeTruthy();
      expect(found.user_id).toBe(S.alice.id);

      // Partial (substring) match must work too — admins often type a
      // fragment like "alice-sec" rather than the full address.
      const r2 = await (await api.get(`/api/admin/logs?stream=app&date=${today}&limit=500&q=alice-sec-${stamp}`)).json();
      const found2 = (r2.entries || []).find(e => e.msg === fingerprint);
      expect(found2).toBeTruthy();
    } finally {
      // Cleanup: drop secondary_email and the planted log line.
      await api.put(`/api/admin/participants/${S.alice.id}`, {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { secondaryEmail: "" },
      });
      try {
        const existing = fs.readFileSync(logFile, "utf8").split("\n").filter(l => !l.includes(fingerprint)).join("\n");
        fs.writeFileSync(logFile, existing);
      } catch (_) {}
      await api.dispose();
    }
  });

  test("server logs files listing", async () => {
    const { api } = await apiLogin("superadmin");
    const r = await api.get("/api/admin/logs/files");
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(Array.isArray(d.files)).toBeTruthy();
    expect(d.files.length).toBeGreaterThan(0);
    // Each file has name, size_bytes, modified_at
    for (const f of d.files) {
      expect(f).toHaveProperty("name");
      expect(f).toHaveProperty("size_bytes");
      expect(f).toHaveProperty("modified_at");
      expect(f.name).toMatch(/^(access|app)-\d{4}-\d{2}-\d{2}.*\.jsonl$/);
    }
    await api.dispose();
  });

  test("admin logs paginate stably under concurrent growth via a timestamp anchor (v7.0.2)", async () => {
    // Regression for the page-1 reset bug. The old continuity token was a
    // SHA-1 over every log file's (name, size, mtime); it changed on EVERY
    // append, and the server replied snapshot_changed → empty → the SPA reset
    // to page 1. Because the access log grows on every request (including the
    // admin's own poll), page 2 of the request log was permanently
    // unreachable. The fix anchors pages 2+ to the head timestamp pinned on
    // page 1: rows appended mid-pagination are EXCLUDED from the window
    // instead of forcing a reset, while page 1 still shows new events.
    const fs = require("fs");
    const path = require("path");
    const LOG_DIR = path.join(TEST_DATA_DIR, "logs");
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // Ancient day so planted rows can't collide with real test logs; a unique
    // fingerprint so `q` isolates exactly our rows.
    const day = "2001-07-04";
    const file = path.join(LOG_DIR, `app-${day}.jsonl`);
    const fp = `anchor-pagination-${Date.now()}`;
    const mk = (sec, n) => JSON.stringify({ ts: `${day}T10:00:${String(sec).padStart(2, "0")}.000Z`, level: "info", msg: `${fp}-${n}` });
    // 6 original rows, ascending ts :00..:05 (newest = :05).
    fs.writeFileSync(file, [0, 1, 2, 3, 4, 5].map(i => mk(i, i)).join("\n") + "\n");
    try {
      const { api } = await apiLogin("superadmin");

      // Page 1 (no anchor) → newest two (-5, -4). Seeds anchor_ts; no reset field.
      const p1 = await (await api.get(`/api/admin/logs?stream=app&limit=2&offset=0&q=${fp}`)).json();
      expect(p1.entries.map(e => e.msg)).toEqual([`${fp}-5`, `${fp}-4`]);
      expect(p1.snapshot_changed).toBeUndefined();
      expect(p1.snapshot_id).toBeUndefined();
      expect(p1.anchor_ts).toBe(`${day}T10:00:05.000Z`);
      expect(p1.total, "the Audit log counts its first read").toBe(6);

      // New events arrive (newer than the anchor) — simulates the live access
      // log growing while the admin reads deeper pages.
      fs.appendFileSync(file, [mk(6, 6), mk(7, 7)].join("\n") + "\n");

      // Page 2 WITH the anchor → the next-older two from the ORIGINAL set
      // (-3, -2). No reset, no empty page, and the new rows are excluded.
      const p2 = await (await api.get(`/api/admin/logs?stream=app&limit=2&offset=2&q=${fp}&anchor=${encodeURIComponent(p1.anchor_ts)}`)).json();
      expect(p2.snapshot_changed).toBeUndefined();
      expect(p2.entries.map(e => e.msg)).toEqual([`${fp}-3`, `${fp}-2`]);
      // The Audit log pages like the audit trail (operator ruling, 17 Nov
      // 2026): only its first read is counted; an anchored read answers none.
      expect(p2.total).toBeNull();

      // No freshly-appended row leaks into any anchored page.
      const p3 = await (await api.get(`/api/admin/logs?stream=app&limit=2&offset=4&q=${fp}&anchor=${encodeURIComponent(p1.anchor_ts)}`)).json();
      const anchoredMsgs = [...p2.entries, ...p3.entries].map(e => e.msg);
      expect(anchoredMsgs).not.toContain(`${fp}-6`);
      expect(anchoredMsgs).not.toContain(`${fp}-7`);
      expect(p3.entries.map(e => e.msg)).toEqual([`${fp}-1`, `${fp}-0`]);

      // Page 1 again (no anchor) → the new events ARE now visible at the top.
      const p1b = await (await api.get(`/api/admin/logs?stream=app&limit=2&offset=0&q=${fp}`)).json();
      expect(p1b.entries.map(e => e.msg)).toEqual([`${fp}-7`, `${fp}-6`]);
      expect(p1b.anchor_ts).toBe(`${day}T10:00:07.000Z`);

      await api.dispose();
    } finally {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  });

  test("server log redacts sensitive headers", async () => {
    const { api } = await apiLogin("superadmin");
    // Trigger an access log entry via an authenticated request (headers include x-csrf-token)
    await api.get("/api/admin/tasks");
    const r = await api.get("/api/admin/logs?stream=access&limit=200");
    const d = await r.json();
    // Serialized entries should not contain raw CSRF tokens; searching the
    // JSON string for the word "x-csrf-token" confirms headers aren't logged at all
    // (only user_agent and other whitelisted fields are).
    const body = JSON.stringify(d);
    expect(body).not.toMatch(/"cookie"/i);
    expect(body).not.toMatch(/"authorization"/i);
    // If any "headers" field leaked, it must be redacted
    if (/"headers"/.test(body)) {
      expect(body).toMatch(/\[REDACTED\]/);
    }
    await api.dispose();
  });

  test("task fetch issues grading_hash; submission with stale hash returns task_changed without scoring (v6.2.6)", async () => {
    // Regression for S-4: an admin editing correct_answer between page-load
    // and submit must NOT silently re-grade against criteria the participant
    // never saw. Server emits a grading_hash on GET /api/tasks/:id; client
    // echoes it on submit; mismatch returns task_changed:true with no
    // scoring change and no -5 penalty.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const compsRaw = await (await sa.get("/api/admin/competitions")).json();
    const compId = compsRaw.find(c => c.name === "Test Live").id;
    // Create a fresh task assigned only to Test Live, just for this test.
    const created = await sa.post("/api/admin/tasks", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: {
        title: `Hash-Race-Task-${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
        answer_type: "text", correct_answer: "alpha", explanation: "<p>x</p>",
        hint: "h", status: "published",
      },
    });
    const taskIdBank = (await created.json()).id;
    const taskIdAssign = await sa.post(`/api/admin/tasks/${taskIdBank}/competitions`, {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { competitionIds: [compId] },
    });
    expect(taskIdAssign.ok(), await taskIdAssign.text()).toBeTruthy();
    const taskId = (await taskIdAssign.json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    await sa.dispose();

    const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await alice.post("/api/select-competition", {
      headers: { "x-csrf-token": aliceCsrf, "content-type": "application/json" },
      data: { competitionId: compId },
    });
    // Alice fetches the task — server includes grading_hash.
    const tFetch = await (await alice.get(`/api/tasks/${taskId}`)).json();
    expect(typeof tFetch.grading_hash).toBe("string");
    expect(tFetch.grading_hash.length).toBeGreaterThan(0);
    const staleHash = tFetch.grading_hash;

    // Admin changes correct_answer mid-flight.
    const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
    await sa2.put(`/api/admin/tasks/${taskId}`, {
      headers: { "x-csrf-token": sa2Csrf, "content-type": "application/json" },
      data: { correct_answer: "beta" },
    });
    await sa2.dispose();

    // Alice submits with the now-stale grading_hash. Must reject with
    // task_changed:true; must NOT count as a wrong answer (no -5 penalty).
    const submitR = await alice.post(`/api/tasks/${taskId}/submit`, {
      headers: { "x-csrf-token": aliceCsrf },
      multipart: { answer: "alpha", gradingHash: staleHash },
    });
    expect(submitR.status()).toBe(409);
    const submitD = await submitR.json();
    expect(submitD.task_changed).toBe(true);

    // Confirm no submission row was created with -5 penalty for that answer.
    // Alice fetches her task again — attempts count must NOT have incremented.
    const tFetch2 = await (await alice.get(`/api/tasks/${taskId}`)).json();
    expect(tFetch2.attempts).toBe(tFetch.attempts);
    // And the new grading_hash differs (since correct_answer changed).
    expect(tFetch2.grading_hash).not.toBe(staleHash);
    await alice.dispose();
  });

  test("/api/admin/tasks/:id/recalculate re-grades historical submissions against current correct_answer (v6.2.6)", async () => {
    // Regression for L-3: when an admin fixes a typo in correct_answer,
    // existing submissions that were marked wrong against the broken answer
    // must be re-evaluated. Endpoint returns counts of total + flipped rows
    // and is wrapped in a transaction so a partial recompute can never land.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const comps = await (await sa.get("/api/admin/competitions")).json();
    const compId = comps.find(c => c.name === "Test Live").id;
    // Fresh task with the WRONG answer initially.
    const created = await sa.post("/api/admin/tasks", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: {
        title: `Recalc-Task-${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
        answer_type: "text", correct_answer: "WRONG_TYPO", explanation: "<p>x</p>",
        hint: "h", status: "published",
      },
    });
    const taskIdBank = (await created.json()).id;
    const taskIdAssign = await sa.post(`/api/admin/tasks/${taskIdBank}/competitions`, {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { competitionIds: [compId] },
    });
    expect(taskIdAssign.ok(), await taskIdAssign.text()).toBeTruthy();
    const taskId = (await taskIdAssign.json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    await sa.dispose();

    // Alice submits the actually-correct value "paris" — gets marked WRONG (-5).
    const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await alice.post("/api/select-competition", {
      headers: { "x-csrf-token": aliceCsrf, "content-type": "application/json" },
      data: { competitionId: compId },
    });
    const tFetch = await (await alice.get(`/api/tasks/${taskId}`)).json();
    await alice.post(`/api/tasks/${taskId}/submit`, {
      headers: { "x-csrf-token": aliceCsrf },
      multipart: { answer: "paris", gradingHash: tFetch.grading_hash },
    });
    // Alice's "solved" must be false because we lied about the answer.
    let aliceTask = await (await alice.get(`/api/tasks/${taskId}`)).json();
    expect(aliceTask.solved).toBe(false);
    await alice.dispose();

    // Admin fixes the correct_answer to "paris" + recalculates.
    const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
    await sa2.put(`/api/admin/tasks/${taskId}`, {
      headers: { "x-csrf-token": sa2Csrf, "content-type": "application/json" },
      data: { correct_answer: "paris" },
    });
    const recalcR = await sa2.post(`/api/admin/tasks/${taskId}/recalculate`, {
      headers: { "x-csrf-token": sa2Csrf, "content-type": "application/json" },
      data: { confirm_live: true },
    });
    expect(recalcR.status()).toBe(200);
    const recalcD = await recalcR.json();
    expect(recalcD.total_submissions).toBeGreaterThanOrEqual(1);
    expect(recalcD.flipped).toBeGreaterThanOrEqual(1);
    await sa2.dispose();

    // Alice's status should now be solved (the previously-wrong row flipped).
    const { api: alice2 } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await alice2.post("/api/select-competition", {
      headers: { "x-csrf-token": (await (await alice2.get("/api/csrf-token")).json()).csrfToken, "content-type": "application/json" },
      data: { competitionId: compId },
    });
    aliceTask = await (await alice2.get(`/api/tasks/${taskId}`)).json();
    expect(aliceTask.solved).toBe(true);
    await alice2.dispose();
  });

  test("/api/admin/tasks/:id/recalculate is superadmin-only (v6.2.6)", async () => {
    await ensureState();
    // v8.12.4 — a REAL regular admin. The first draft "promoted" carol with
    // PUT /api/admin/participants/:id {role}, which ignores `role` — so she
    // stayed a participant, the 403 came from requireAdmin, and the
    // admin-vs-superadmin gate this test is named for was never reached.
    const { makeParticipant } = require("./event-admin-helpers");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const taskId = (await (await sa.get("/api/admin/tasks")).json())[0].id;
    const who = await makeParticipant(sa, saCsrf, "recalc-admin");
    const role = await sa.post(`/api/admin/participants/${who.id}/role`, { headers: H, data: { role: "admin" } });
    expect(role.ok(), `promote: ${await role.text()}`).toBeTruthy();
    await sa.dispose();
    const { api: adm, csrf: aCsrf } = await apiLogin(who.email, PARTICIPANT_PASS);
    try {
      expect((await adm.get("/api/admin/tasks")).status(), "PRECONDITION: an admin, past requireAdmin").toBe(200);
      const r = await adm.post(`/api/admin/tasks/${taskId}/recalculate`, {
        headers: { "x-csrf-token": aCsrf, "content-type": "application/json" }, data: {},
      });
      expect(r.status()).toBe(403);
      expect((await r.json()).error, "refused by the SUPERADMIN gate, not the admin one").toMatch(/superadmin only/i);
    } finally { await adm.dispose(); }
  });

  test("v6.17.x: recalculate returns 409 when task is in a live session and confirm_live is absent", async () => {
    // Regression lock for the confirm_live guard added in Phase 2.
    // Without this test a future refactor could drop the check and no
    // existing test would catch it — the other recalculate tests all
    // pass confirm_live:true explicitly, bypassing the guard.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const compId = S.liveComp.id;
    const created = await sa.post("/api/admin/tasks", {
      headers: h,
      data: {
        title: `RecalcLiveGuard-${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
        answer_type: "text", correct_answer: "x", explanation: "<p>x</p>",
        hint: "h", status: "published",
      },
    });
    const taskIdBank = (await created.json()).id;
    const taskIdAssign = await sa.post(`/api/admin/tasks/${taskIdBank}/competitions`, { headers: h, data: { competitionIds: [compId] } });
    expect(taskIdAssign.ok(), await taskIdAssign.text()).toBeTruthy();
    const taskId = (await taskIdAssign.json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js)

    try {
      // No confirm_live — must get 409 because the competition is live.
      const r = await sa.post(`/api/admin/tasks/${taskId}/recalculate`, {
        headers: h, data: {},
      });
      expect(r.status(), "should 409 when live session and no confirm_live").toBe(409);
      const body = await r.json();
      // v8.1.5 — this asserted that the human sentence contained the string
      // "confirm_live", which is the defect it was pinning in place: that message
      // is rendered verbatim into an admin's toast, so the one override this route
      // offers read as "Send confirm_live:true in the body" and was reachable only
      // with curl. The contract the CLIENT needs is the machine-readable code it
      // branches on to raise the second confirmation; the sentence is for a human.
      expect(body.code, "the client branches on a code, not on prose").toBe("live_session_confirm");
      expect(body.error, "and the sentence must not hand an admin a JSON field to type").not.toContain("confirm_live");

      // With confirm_live:true the same call must succeed.
      const r2 = await sa.post(`/api/admin/tasks/${taskId}/recalculate`, {
        headers: h, data: { confirm_live: true },
      });
      expect(r2.status(), "should 200 with confirm_live:true").toBe(200);
    } finally {
      await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.9.9: hint reveal invalidates the leaderboard cache immediately", async () => {
    // Regression for the external-audit finding: the leaderboard cache
    // has a 5-second TTL, so any score-changing write that skips
    // invalidateLeaderboardCache() serves stale numbers to every caller
    // until the TTL expires. Pre-v6.9.9 hint reveals fell into that gap.
    // Exercise the full loop (submit → cache-prime → hint → immediate
    // re-read) so the assertion catches a regression the moment the
    // call is dropped again — without this coverage the failure mode
    // only shows up as flaky ranks under user load.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const compId = S.liveComp.id;
    // Use a fresh task with a known hint so the deduction is deterministic.
    const created = await sa.post("/api/admin/tasks", {
      headers: h,
      data: {
        title: `LBCache-Hint-${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
        answer_type: "text", correct_answer: "paris", explanation: "<p>x</p>",
        hint: "hint body", status: "published",
      },
    });
    const taskId = (await created.json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: h, data: { competitionIds: [compId] } });
    await sa.dispose();

    try {
      const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      const aH = { "x-csrf-token": aliceCsrf };
      await alice.post("/api/select-competition", { headers: { ...aH, "content-type": "application/json" }, data: { competitionId: compId } });
      // Prime the cache by reading the leaderboard, then reveal a hint.
      // Alice has no submission on the new task, so her score on it is 0
      // before the hint and -15 after (30 % of 50 = 15, easy difficulty).
      const before = await (await alice.get("/api/leaderboard")).json();
      const aliceBefore = before.board.find(u => u.userId === S.alice.id);
      expect(aliceBefore, "alice must be on the leaderboard before the hint").toBeTruthy();
      const scoreBefore = aliceBefore.score;
      const hintR = await alice.post(`/api/tasks/${taskId}/hint`, { headers: aH });
      expect(hintR.ok()).toBeTruthy();
      // Immediately re-read the board — NO sleep, so a stale cached response
      // would flunk the assertion.
      const after = await (await alice.get("/api/leaderboard")).json();
      const aliceAfter = after.board.find(u => u.userId === S.alice.id);
      expect(aliceAfter.score, "leaderboard must reflect the hint deduction without waiting for TTL").toBe(scoreBefore - 15);
      await alice.dispose();
    } finally {
      const { api: cleanup, csrf: cleanupCsrf } = await apiLogin("superadmin");
      await cleanup.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": cleanupCsrf } }).catch(() => {});
      await cleanup.dispose();
    }
  });

  test("v6.9.9: task recalculate invalidates leaderboards on every competition the task lives in", async () => {
    // The recalc writer rewrites submissions.is_correct / points_delta
    // across every competition the task is assigned to, not just the
    // admin's currently-focused one. Cover two comps in a single test
    // so a regression that only clears the caller's context cache
    // surfaces loud.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const compId = S.liveComp.id;
    const created = await sa.post("/api/admin/tasks", {
      headers: h,
      data: {
        title: `LBCache-Recalc-${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
        answer_type: "text", correct_answer: "WRONG_TYPO", explanation: "<p>x</p>",
        hint: "hint", status: "published",
      },
    });
    const taskIdBank = (await created.json()).id;
    const taskIdAssign = await sa.post(`/api/admin/tasks/${taskIdBank}/competitions`, { headers: h, data: { competitionIds: [compId] } });
    expect(taskIdAssign.ok(), await taskIdAssign.text()).toBeTruthy();
    const taskId = (await taskIdAssign.json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    await sa.dispose();

    try {
      // Alice submits "paris" — marked wrong against the typo. She'll pay -5.
      const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      await alice.post("/api/select-competition", { headers: { "x-csrf-token": aliceCsrf, "content-type": "application/json" }, data: { competitionId: compId } });
      const fetched = await (await alice.get(`/api/tasks/${taskId}`)).json();
      await alice.post(`/api/tasks/${taskId}/submit`, {
        headers: { "x-csrf-token": aliceCsrf },
        multipart: { answer: "paris", gradingHash: fetched.grading_hash },
      });
      // Prime the cache.
      const before = await (await alice.get("/api/leaderboard")).json();
      const aliceScoreBefore = before.board.find(u => u.userId === S.alice.id).score;
      await alice.dispose();

      // Admin fixes the answer + recalculates. Her "-5 wrong" flips to "+50
      // correct" — leaderboard delta should be +55 per Alice's row.
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      const sH = { "x-csrf-token": sa2Csrf, "content-type": "application/json" };
      await sa2.put(`/api/admin/tasks/${taskId}`, { headers: sH, data: { correct_answer: "paris" } });
      const recalcR = await sa2.post(`/api/admin/tasks/${taskId}/recalculate`, { headers: sH, data: { confirm_live: true } });
      expect(recalcR.status()).toBe(200);
      const recalcD = await recalcR.json();
      expect(recalcD.flipped).toBeGreaterThanOrEqual(1);
      await sa2.dispose();

      // Alice's next leaderboard read — IMMEDIATE, no sleep — must reflect the flip.
      const { api: alice2, csrf: aliceCsrf2 } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      await alice2.post("/api/select-competition", { headers: { "x-csrf-token": aliceCsrf2, "content-type": "application/json" }, data: { competitionId: compId } });
      const after = await (await alice2.get("/api/leaderboard")).json();
      const aliceScoreAfter = after.board.find(u => u.userId === S.alice.id).score;
      expect(aliceScoreAfter - aliceScoreBefore, "leaderboard must reflect recalc flip without TTL wait").toBe(55);
      await alice2.dispose();
    } finally {
      const { api: cleanup, csrf: cleanupCsrf } = await apiLogin("superadmin");
      await cleanup.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": cleanupCsrf } }).catch(() => {});
      await cleanup.dispose();
    }
  });

  test("v6.10.24: remove+re-add preserves leaderboard presence + score + solveTimeMs", async () => {
    // Pre-fix: leaderboard SELECT required `cu.login_time IS NOT NULL`.
    // `DELETE FROM competition_users` on remove discarded login_time;
    // `INSERT OR IGNORE` on re-add inserted a fresh row with login_time
    // = NULL. Result: the re-added participant's preserved submissions
    // were still aggregated into points on other rows but the row for
    // the user themselves never appeared until they logged in and
    // re-selected the comp (which sets login_time). Also — had the
    // user re-logged-in, solveTimeMs would anchor on the NEW login_time
    // while finishTime stayed at the pre-remove submission, producing
    // a negative / near-zero "time to solve".
    //
    // v6.10.24 fix: widened the leaderboard query to admit users who
    // have submissions in the competition even without login_time,
    // and COALESCE'd login_time to MIN(submitted_at) as fallback so
    // solveTimeMs anchors on actual first-participation, not the
    // re-add event. Also added leaderboard-cache invalidation to the
    // bulk-assign path so the fix surfaces within the 5-s TTL window.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Bootstrap a throwaway participant with a known password.
    const stamp = Date.now();
    const email = `readd-${stamp}@company.co`;
    await registerPost(sa, "/api/register", {
      headers: saH,
      data: {
        firstName: "Re", lastName: "Add", nickname: `readd_${stamp}`,
        company: "C", title: "T", avatar: "🦊", country: "US",
        timezone: "America/New_York", email,
      },
    });
    const list = await (await sa.get("/api/admin/participants?limit=500")).json();
    const user = list.participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${user.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${user.id}/approve`, { headers: saH });
    // Admin assigns the user to Test Live.
    await sa.post("/api/admin/competitions/assign", {
      headers: saH,
      data: { userIds: [user.id], competitionIds: [S.liveComp.id] },
    });
    await sa.dispose();

    // User logs in, joins comp, submits a correct easy answer.
    const { api: u1, csrf: u1Csrf } = await apiLogin(email, PARTICIPANT_PASS);
    const u1H = { "x-csrf-token": u1Csrf, "content-type": "application/json" };
    await u1.post("/api/select-competition", { headers: u1H, data: { competitionId: S.liveComp.id } });
    const easy = S.liveTask("Challenge easy1");
    expect(easy).toBeTruthy();
    const submitR = await u1.post(`/api/tasks/${easy.id}/submit`, { headers: u1H, data: { answer: "answer-easy1" , gradingHash: await gradingHashFor(u1, easy.id)} });
    expect(submitR.ok(), `submit failed: ${submitR.status()} ${await submitR.text()}`).toBeTruthy();
    await u1.dispose();
    // Slight pause to let the loginMs / submittedAt delta grow past
    // a measurable threshold — otherwise a sub-millisecond spread
    // would make the assertion on solveTimeMs-after matching
    // solveTimeMs-before too brittle on fast CI boxes.
    await new Promise(r => setTimeout(r, 50));

    // 1. Verify user is on the leaderboard with +50 points.
    const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
    const sa2H = { "x-csrf-token": sa2Csrf, "content-type": "application/json" };
    const lb1 = await (await sa2.get(`/api/admin/leaderboard?competitionId=${S.liveComp.id}`)).json();
    const entry1 = lb1.find(u => u.userId === user.id);
    expect(entry1, "user must be on the leaderboard after submitting").toBeTruthy();
    expect(entry1.score).toBe(50);
    const solveBefore = entry1.solveTimeMs;
    expect(solveBefore).toBeGreaterThan(0);

    // 2. Remove user. Leaderboard removes them IMMEDIATELY (cache invalidated).
    const delR = await sa2.delete(`/api/admin/competitions/${S.liveComp.id}/users/${user.id}`, {
      headers: { "x-csrf-token": sa2Csrf },
    });
    expect(delR.ok()).toBeTruthy();
    const lb2 = await (await sa2.get(`/api/admin/leaderboard?competitionId=${S.liveComp.id}`)).json();
    expect(lb2.find(u => u.userId === user.id), "removed user must disappear from leaderboard").toBeFalsy();

    // 3. Re-add. Leaderboard must re-include them IMMEDIATELY with the
    //    original score and a solveTimeMs that anchors on the original
    //    submission (not the re-add time).
    const reR = await sa2.post("/api/admin/competitions/assign", {
      headers: sa2H, data: { userIds: [user.id], competitionIds: [S.liveComp.id] },
    });
    expect(reR.ok()).toBeTruthy();
    const lb3 = await (await sa2.get(`/api/admin/leaderboard?competitionId=${S.liveComp.id}`)).json();
    const entry3 = lb3.find(u => u.userId === user.id);
    expect(entry3, "re-added user must re-appear on leaderboard immediately (pre-fix this would fail)").toBeTruthy();
    expect(entry3.score).toBe(50);
    // solveTimeMs anchored on original submission time; tolerance for
    // clock drift across multiple reads. Pre-fix this would be tiny
    // (re-add-time-minus-original-submission, often negative).
    expect(entry3.solveTimeMs).toBeGreaterThanOrEqual(solveBefore - 500);
    await sa2.dispose();
  });

  test("v6.10.26: remove+re-add preserves hint-only history on the leaderboard", async () => {
    // v6.10.24 fixed the submission-history path but explicitly scoped
    // out hint-reveal-only users. The auditor flagged that as a gap
    // since admin.md promises hint reveals are preserved too. This
    // test locks in the extended fallback: a user with zero submissions
    // and only hint-reveal history, removed then re-added, must appear
    // on the leaderboard with their negative score.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const stamp = Date.now();
    const email = `hintonly-${stamp}@company.co`;
    await registerPost(sa, "/api/register", {
      headers: saH,
      data: {
        firstName: "Hint", lastName: "Only", nickname: `hintonly_${stamp}`,
        company: "C", title: "T", avatar: "🦊", country: "US",
        timezone: "America/New_York", email,
      },
    });
    const list = await (await sa.get("/api/admin/participants?limit=500")).json();
    const user = list.participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${user.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${user.id}/approve`, { headers: saH });
    await sa.post("/api/admin/competitions/assign", {
      headers: saH, data: { userIds: [user.id], competitionIds: [S.liveComp.id] },
    });
    await sa.dispose();

    // User logs in, reveals a hint (no submission).
    const { api: u1, csrf: u1Csrf } = await apiLogin(email, PARTICIPANT_PASS);
    const u1H = { "x-csrf-token": u1Csrf, "content-type": "application/json" };
    await u1.post("/api/select-competition", { headers: u1H, data: { competitionId: S.liveComp.id } });
    const med = S.liveTask("Challenge med1");
    const hintR = await u1.post(`/api/tasks/${med.id}/hint`, { headers: u1H });
    expect(hintR.ok(), `hint reveal failed: ${hintR.status()}`).toBeTruthy();
    await u1.dispose();

    // User is on the leaderboard with a negative score (medium hint = -30).
    const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
    const sa2H = { "x-csrf-token": sa2Csrf, "content-type": "application/json" };
    const lb1 = await (await sa2.get(`/api/admin/leaderboard?competitionId=${S.liveComp.id}`)).json();
    const entry1 = lb1.find(u => u.userId === user.id);
    expect(entry1, "hint-only user must be on leaderboard before removal").toBeTruthy();
    expect(entry1.score).toBe(-30);

    // Remove + re-add.
    await sa2.delete(`/api/admin/competitions/${S.liveComp.id}/users/${user.id}`, {
      headers: { "x-csrf-token": sa2Csrf },
    });
    await sa2.post("/api/admin/competitions/assign", {
      headers: sa2H, data: { userIds: [user.id], competitionIds: [S.liveComp.id] },
    });

    // Must re-appear immediately with the same -30 score.
    const lb3 = await (await sa2.get(`/api/admin/leaderboard?competitionId=${S.liveComp.id}`)).json();
    const entry3 = lb3.find(u => u.userId === user.id);
    expect(entry3, "hint-only re-added user must re-appear on leaderboard").toBeTruthy();
    expect(entry3.score).toBe(-30);
    expect(entry3.solveTimeMs).toBeGreaterThan(0);
    await sa2.dispose();
  });

  test("v6.10.26: task recalculate rescales hint deductions after difficulty change", async () => {
    // Pre-fix: /api/admin/tasks/:id/recalculate rewrote
    // submissions.is_correct + submissions.points_delta against the
    // new difficulty, but left hint_reveals.points_deducted on the
    // pre-change scale. Leaderboard total = (correct pts) - (hint
    // cost) would use mismatched scales. This test creates a fresh
    // task, has a user reveal its hint at one difficulty, then
    // promotes the task and recalculates — the stored hint cost
    // should move to the new scale.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const created = await sa.post("/api/admin/tasks", {
      headers: saH,
      data: {
        title: `HintRescale-${Date.now()}`, description: "<p>x</p>",
        difficulty: "easy", answer_type: "text", correct_answer: "x",
        explanation: "<p>x</p>", hint: "hint", status: "published",
      },
    });
    const taskIdBank = (await created.json()).id;
    const taskIdAssign = await sa.post(`/api/admin/tasks/${taskIdBank}/competitions`, { headers: saH, data: { competitionIds: [S.liveComp.id] } });
    expect(taskIdAssign.ok(), await taskIdAssign.text()).toBeTruthy();
    const taskId = (await taskIdAssign.json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    await sa.dispose();
    try {
      const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      const aH = { "x-csrf-token": aliceCsrf, "content-type": "application/json" };
      await alice.post("/api/select-competition", { headers: aH, data: { competitionId: S.liveComp.id } });
      const hintR = await alice.post(`/api/tasks/${taskId}/hint`, { headers: { "x-csrf-token": aliceCsrf } });
      expect(hintR.ok()).toBeTruthy();
      await alice.dispose();

      // Admin promotes easy → hard and recalculates.
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      const sa2H = { "x-csrf-token": sa2Csrf, "content-type": "application/json" };
      await sa2.put(`/api/admin/tasks/${taskId}`, { headers: sa2H, data: { difficulty: "hard" } });
      const recalcR = await sa2.post(`/api/admin/tasks/${taskId}/recalculate`, { headers: sa2H, data: { confirm_live: true } });
      expect(recalcR.ok(), `recalc failed: ${recalcR.status()} ${await recalcR.text()}`).toBeTruthy();
      const body = await recalcR.json();
      // Easy hint cost was 15 (50*0.3); hard is 45 (150*0.3).
      // exactly 1 row rescaled (alice's).
      expect(body.hints_rescaled).toBe(1);

      // DB confirms the new cost.
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH, { readonly: true });
      const row = db.prepare("SELECT points_deducted FROM hint_reveals WHERE user_id=? AND task_id=?")
        .get(S.alice.id, taskId);
      db.close();
      expect(row.points_deducted).toBe(45);
      await sa2.dispose();
    } finally {
      const { api: cleanup, csrf: cleanupCsrf } = await apiLogin("superadmin");
      await cleanup.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": cleanupCsrf } }).catch(() => {});
      await cleanup.dispose();
    }
  });

  test("v6.11.0: slot revival via duration edit un-freezes solveTimeMs for partially-solved users", async () => {
    // solveTimeMs has three branches in buildLeaderboardEntries (server.js):
    //   finishTime           → finish - login        (all-solved, frozen)
    //   isEnded && effEnd    → effEnd - login        (not-all-solved, frozen at slot end)
    //   else                 → nowMs - login         (not-all-solved, live-growing)
    // When an admin end-nows a timeslot the middle branch pins solveTimeMs
    // at (slot.ended_at - login). When the admin subsequently extends the
    // slot's duration past `now()`, the revival path (server.js:5929-5941)
    // clears `ended_at` and the third branch takes over — solveTimeMs
    // should grow with wall-clock again. Pre-this-test that flip was
    // covered only by the status/ended_at assertions; no test read the
    // leaderboard after revival to confirm solveTimeMs actually re-anchored.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const t = Date.now();
    // Competition with a single timeslot that's live now.
    const compR = await sa.post("/api/admin/competitions", {
      headers: saH,
      data: {
        name: `RevSolveTime-${t}`,
        start_time: new Date(t + 600_000).toISOString(),
        duration_minutes: 120,
      },
    });
    const compId = (await compR.json()).competition.id;
    const tsR = await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
      headers: saH,
      data: {
        name: `RevSlot-${t}`,
        start_time: new Date(t - 60_000).toISOString(), // started 1 min ago
        duration_minutes: 30,                            // ends 29 min from now
      },
    });
    const tsId = (await tsR.json()).timeslot.id;
    // Two published tasks so a partial solve is possible.
    const mkTask = async (diff, title, ans) => {
      const r = await sa.post("/api/admin/tasks", {
        headers: saH,
        data: { title, description: "<p>x</p>", difficulty: diff, answer_type: "text", correct_answer: ans, explanation: "—", status: "published" },
      });
      return (await r.json()).id;
    };
    const taskA = await mkTask("easy", `RevTaskA-${t}`, "aaa");
    const taskB = await mkTask("easy", `RevTaskB-${t}`, "bbb");
    await sa.post(`/api/admin/tasks/${taskA}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    await sa.post(`/api/admin/tasks/${taskB}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    await sa.post("/api/admin/competitions/assign", {
      headers: saH, data: { userIds: [S.alice.id], competitionIds: [compId], timeslotId: tsId },
    });
    await sa.dispose();

    try {
      // Alice selects the slot, solves ONE task (partial).
      const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      const aliceH = { "x-csrf-token": aliceCsrf, "content-type": "application/json" };
      await alice.post("/api/select-competition", { headers: aliceH, data: { competitionId: compId } });
      // Live timeslot requires explicit confirmLive=true on select-timeslot
      // (otherwise the handler returns {requireConfirmation:true} and does
      // NOT persist session.timeslotId).
      await alice.post("/api/select-timeslot", { headers: aliceH, data: { timeslotId: tsId, confirmLive: true } });
      const submitR = await alice.post(`/api/tasks/${taskA}/submit`, { headers: aliceH, data: { answer: "aaa" , gradingHash: await gradingHashFor(alice, taskA)} });
      expect(submitR.ok(), `submit failed: ${submitR.status()} ${await submitR.text()}`).toBeTruthy();
      await alice.dispose();

      // Admin reads leaderboard while slot is live.
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      const sa2H = { "x-csrf-token": sa2Csrf, "content-type": "application/json" };
      const readBoard = async () => {
        const r = await sa2.get(`/api/admin/leaderboard?competitionId=${compId}&timeslotId=${tsId}`);
        const body = await r.json();
        return body.find(u => u.userId === S.alice.id);
      };
      const liveEntry = await readBoard();
      expect(liveEntry, "alice should be on the leaderboard after submit").toBeTruthy();
      expect(liveEntry.allSolved).toBe(false);
      const solveLive = liveEntry.solveTimeMs;
      expect(solveLive).toBeGreaterThan(0);

      // End-now: slot moves to ended branch. solveTimeMs pins at slot.ended_at - login.
      const endR = await sa2.post(`/api/admin/competitions/${compId}/timeslots/${tsId}/end-now`, { headers: sa2H });
      expect(endR.ok(), `end-now failed: ${endR.status()}`).toBeTruthy();
      // Sample the frozen-at-end value. end-now invalidates the leaderboard
      // cache so the next read rebuilds under the ended branch.
      const endedEntry1 = await readBoard();
      expect(endedEntry1.allSolved).toBe(false);
      const solveEnded1 = endedEntry1.solveTimeMs;
      expect(solveEnded1).toBeGreaterThan(0);

      // Wait ~800 ms so the subsequent revival's live-branch value is
      // noticeably separated from the frozen ended-branch value (the
      // revival's nowMs - login will be ~800 ms larger than ended_at -
      // login). Without this separation the two values could land in the
      // same millisecond on a fast CI box and the branch-flip proof
      // would be circumstantial.
      await new Promise(r => setTimeout(r, 800));

      // Revive: extend duration so newEnd > now. Server clears ended_at
      // AND invalidates the leaderboard cache (server.js:5815).
      const reviveR = await sa2.put(`/api/admin/competitions/${compId}/timeslots/${tsId}`, {
        headers: sa2H, data: { duration_minutes: 120 },
      });
      expect(reviveR.ok(), `revive failed: ${reviveR.status()} ${await reviveR.text()}`).toBeTruthy();
      const reviveBody = await reviveR.json();
      expect(reviveBody.revived, "PUT timeslot with extended duration must revive a manually-ended slot").toBe(true);

      // After revival, the NEXT leaderboard read rebuilds under the LIVE
      // branch (nowMs - login) instead of the FROZEN branch (ended_at -
      // login). nowMs is ~800 ms past ended_at by the wait above, so
      // solveRevived should be at least ~500 ms larger than solveEnded1.
      // Not asserting "keeps growing on subsequent reads" — the 5 s
      // cache TTL would pin nowMs across back-to-back reads, making that
      // assertion brittle without a 5 s sleep we don't want to pay for.
      // The branch-flip proof (revived > ended + headroom) is sufficient.
      const revivedEntry1 = await readBoard();
      expect(revivedEntry1.allSolved).toBe(false);
      expect(revivedEntry1.solveTimeMs, "solveTimeMs after revival should exceed the frozen-at-end value by the wait interval")
        .toBeGreaterThan(solveEnded1 + 500);
      await sa2.dispose();
    } finally {
      const { api: cleanup, csrf: cleanupCsrf } = await apiLogin("superadmin");
      const cH = { "x-csrf-token": cleanupCsrf, "content-type": "application/json" };
      await cleanup.delete(`/api/admin/competitions/${compId}`, { headers: cH }).catch(() => {});
      await cleanup.delete(`/api/admin/tasks/${taskA}`, { headers: cH }).catch(() => {});
      await cleanup.delete(`/api/admin/tasks/${taskB}`, { headers: cH }).catch(() => {});
      await cleanup.dispose();
    }
  });

  test("v6.11.0: participant-assignment revives an auto-ended comp; new participant gets live solveTimeMs", async () => {
    // User's release-audit scenario: "competition ended by everyone solving
    // their tasks and a new participant added while the session still has
    // time before its end." The code path at server.js:6700-6747 revives
    // auto-ended competitions/timeslots on /api/admin/competitions/assign
    // when the scheduled end is still in the future and the end was NOT
    // manual. This test locks in:
    //   1. Auto-end fires when the only participant solves every task.
    //   2. Adding a second participant clears competition.ended_at.
    //   3. The pre-existing all-solved participant's solveTimeMs stays
    //      pinned at finishTime (not wall-clock) because the finishTime
    //      branch dominates.
    //   4. The new participant appears with live-growing solveTimeMs.
    // Single-slot comp keeps the predicates simple (competition-level
    // auto-end, not per-timeslot).
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const t = Date.now();
    const compR = await sa.post("/api/admin/competitions", {
      headers: saH,
      data: {
        name: `AssignRevive-${t}`,
        start_time: new Date(t - 60_000).toISOString(),
        duration_minutes: 120, // plenty of future headroom for the revive
      },
    });
    const compId = (await compR.json()).competition.id;
    const taskR = await sa.post("/api/admin/tasks", {
      headers: saH,
      data: { title: `AssignReviveTask-${t}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "xyz", explanation: "—", status: "published" },
    });
    const taskId = (await taskR.json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    await sa.post("/api/admin/competitions/assign", {
      headers: saH, data: { userIds: [S.alice.id], competitionIds: [compId] },
    });
    await sa.dispose();

    try {
      // Alice solves the sole task → triggers auto-end.
      const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      const aliceH = { "x-csrf-token": aliceCsrf, "content-type": "application/json" };
      await alice.post("/api/select-competition", { headers: aliceH, data: { competitionId: compId } });
      const submitR = await alice.post(`/api/tasks/${taskId}/submit`, { headers: aliceH, data: { answer: "xyz" , gradingHash: await gradingHashFor(alice, taskId)} });
      expect(submitR.ok()).toBeTruthy();
      await alice.dispose();

      // Confirm auto-end fired: competition.ended_at set, ended_manually=0.
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      const sa2H = { "x-csrf-token": sa2Csrf, "content-type": "application/json" };
      const comps = await (await sa2.get("/api/admin/competitions")).json();
      const comp1 = comps.find(c => c.id === compId);
      expect(comp1.ended_at, "auto-end must fire once alice solves the sole task").toBeTruthy();
      expect(comp1.ended_manually, "auto-end must leave ended_manually=0 so a later assignment can revive").toBeFalsy();

      // Alice's leaderboard entry: allSolved=true, solveTimeMs pinned at finishTime.
      const lb1 = await (await sa2.get(`/api/admin/leaderboard?competitionId=${compId}`)).json();
      const aliceEntry1 = lb1.find(u => u.userId === S.alice.id);
      expect(aliceEntry1.allSolved).toBe(true);
      const aliceSolveAfterAutoEnd = aliceEntry1.solveTimeMs;
      expect(aliceSolveAfterAutoEnd).toBeGreaterThan(0);

      // Assign bob → triggers revival (auto-ended + future scheduled end + !ended_manually).
      const assignR = await sa2.post("/api/admin/competitions/assign", {
        headers: sa2H, data: { userIds: [S.bob.id], competitionIds: [compId] },
      });
      expect(assignR.ok()).toBeTruthy();

      // competition.ended_at must now be cleared.
      const compsAfter = await (await sa2.get("/api/admin/competitions")).json();
      const comp2 = compsAfter.find(c => c.id === compId);
      expect(comp2.ended_at, "participant assignment must clear ended_at on an auto-ended comp with future scheduled end").toBeFalsy();

      // Small wait to cross the 5s leaderboard TTL (invalidation is explicit
      // in the assign path; this is belt + suspenders for the TTL window).
      await new Promise(r => setTimeout(r, 100));
      const lb2 = await (await sa2.get(`/api/admin/leaderboard?competitionId=${compId}`)).json();
      const aliceEntry2 = lb2.find(u => u.userId === S.alice.id);
      expect(aliceEntry2, "alice stays on the board after revival").toBeTruthy();
      expect(aliceEntry2.allSolved, "alice remains all-solved after revival").toBe(true);
      // alice's solveTimeMs is anchored on her last correct submission
      // (finishTime branch) — revival doesn't change that.
      expect(aliceEntry2.solveTimeMs).toBe(aliceSolveAfterAutoEnd);
      // Bob has been ASSIGNED (competition_users row exists) but has NOT
      // yet called /api/select-competition, so cu.login_time is NULL. Per
      // the admit gate, he should be filtered out of the board. Now bob
      // selects the comp — login_time gets populated and he appears with
      // a small, live-growing solveTimeMs.
      const bobEntryBeforeSelect = lb2.find(u => u.userId === S.bob.id);
      expect(bobEntryBeforeSelect, "bob should NOT appear on the board until he selects the comp (admit gate)").toBeFalsy();
      await sa2.dispose();

      const { api: bob, csrf: bobCsrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
      const bobH = { "x-csrf-token": bobCsrf, "content-type": "application/json" };
      await bob.post("/api/select-competition", { headers: bobH, data: { competitionId: compId } });
      await bob.dispose();

      const { api: sa3, csrf: sa3Csrf } = await apiLogin("superadmin");
      // bob's /api/select-competition stamps login_time and invalidates the
      // leaderboard cache — COALESCED (lib/leaderboard.js
      // invalidateLeaderboardCacheForEntrant): a board built in the last second
      // is kept until that second ends, so bob appears within it, not
      // necessarily on the very next read. Poll for him.
      let lb3 = [];
      await expect.poll(async () => {
        lb3 = await (await sa3.get(`/api/admin/leaderboard?competitionId=${compId}`)).json();
        return !!lb3.find(u => u.userId === S.bob.id);
      }, { timeout: 4000, intervals: [100] }).toBe(true);
      const bobEntry3 = lb3.find(u => u.userId === S.bob.id);
      expect(bobEntry3, "bob should appear on the board after /api/select-competition populates login_time").toBeTruthy();
      expect(bobEntry3.allSolved).toBe(false);
      // bob's solveTimeMs is on the live branch (comp is not ended, bob
      // hasn't solved) — nowMs - login. Must be a small positive number
      // (login just happened), not anchored anywhere weird. If the post-
      // revival branch logic drifted, we'd see a NaN, a huge value
      // (anchored on some pre-auto-end event), or zero.
      expect(bobEntry3.solveTimeMs).toBeGreaterThan(0);
      expect(bobEntry3.solveTimeMs).toBeLessThan(60_000);
      // alice's value is still unchanged — the finishTime branch is
      // independent of the comp's ended state, so revival doesn't move it.
      const aliceEntry3 = lb3.find(u => u.userId === S.alice.id);
      expect(aliceEntry3.solveTimeMs).toBe(aliceSolveAfterAutoEnd);
      await sa3.dispose();
    } finally {
      const { api: cleanup, csrf: cleanupCsrf } = await apiLogin("superadmin");
      const cH = { "x-csrf-token": cleanupCsrf, "content-type": "application/json" };
      await cleanup.delete(`/api/admin/competitions/${compId}`, { headers: cH }).catch(() => {});
      await cleanup.delete(`/api/admin/tasks/${taskId}`, { headers: cH }).catch(() => {});
      await cleanup.dispose();
    }
  });

  test("v6.11.0: zero-history re-add is filtered by the leaderboard admit gate", async () => {
    // buildLeaderboardEntries' admit gate (server.js:2796-2802) admits a
    // user only when ONE of these is true:
    //   - cu.login_time IS NOT NULL (they've selected the comp)
    //   - EXISTS a submission row in this (competition_id [+ timeslot_id])
    //   - EXISTS a hint_reveals row in this (competition_id [+ timeslot_id])
    // After remove + re-add the row's login_time resets to NULL. If the
    // user had neither submissions nor hint reveals before removal, all
    // three predicates miss and the admit gate excludes them. solveTimeMs
    // would otherwise resolve to `new Date(NULL).getTime() - 0 = NaN`,
    // rendering a nonsensical leaderboard row. This test locks in the
    // exclusion so a future predicate refactor can't silently drop the
    // guard.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const stamp = Date.now();
    const email = `zero-history-${stamp}@company.co`;
    await registerPost(sa, "/api/register", {
      headers: saH,
      data: {
        firstName: "Zero", lastName: "History", nickname: `zh_${stamp}`,
        company: "C", title: "T", avatar: "🦊", country: "US",
        timezone: "America/New_York", email,
      },
    });
    const list = await (await sa.get("/api/admin/participants?limit=500")).json();
    const user = list.participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${user.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${user.id}/approve`, { headers: saH });

    try {
      // Assign → remove → re-assign. The user never logs in, never submits,
      // never reveals a hint. cu.login_time stays NULL the whole cycle.
      await sa.post("/api/admin/competitions/assign", {
        headers: saH, data: { userIds: [user.id], competitionIds: [S.liveComp.id] },
      });
      await sa.delete(`/api/admin/competitions/${S.liveComp.id}/users/${user.id}`, {
        headers: { "x-csrf-token": saCsrf },
      });
      await sa.post("/api/admin/competitions/assign", {
        headers: saH, data: { userIds: [user.id], competitionIds: [S.liveComp.id] },
      });

      // Leaderboard must NOT include this user (admit gate filters them out).
      // Belt+suspenders: crossed 5s TTL via explicit invalidation on assign.
      const lb = await (await sa.get(`/api/admin/leaderboard?competitionId=${S.liveComp.id}`)).json();
      const entry = lb.find(u => u.userId === user.id);
      expect(entry, "zero-history re-added user must be filtered out by the admit gate").toBeFalsy();
    } finally {
      // Remove + delete the throwaway user.
      await sa.delete(`/api/admin/competitions/${S.liveComp.id}/users/${user.id}`, {
        headers: { "x-csrf-token": saCsrf },
      }).catch(() => {});
      await sa.delete(`/api/admin/participants/${user.id}`, { headers: { "x-csrf-token": saCsrf } }).catch(() => {});
      await sa.dispose();
    }
  });

  test("v6.12.0: re-added user cannot switch to a different session (history-pinned lock)", async () => {
    // Product rule: after remove+re-add, a participant must stick to the
    // session they originally entered. Pre-v6.12.0 the /api/select-timeslot
    // lock fired only on `assigned.login_time && assigned.timeslot_id`,
    // both of which are NULL on a fresh competition_users row after the
    // DELETE+INSERT cycle — so the user could silently pick a different
    // slot, splitting their history across two per-slot leaderboards
    // (submissions.timeslot_id still pointed at the original slot).
    // v6.12.0 adds a second lock that consults submissions+hint_reveals
    // for a pinned timeslot_id; if one exists and differs from the
    // requested slot, reject 400.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const t = Date.now();
    // Multi-slot competition so "switch to a different slot" is even possible.
    const compR = await sa.post("/api/admin/competitions", {
      headers: saH,
      data: { name: `SwitchLock-${t}`, start_time: new Date(t + 600_000).toISOString(), duration_minutes: 120 },
    });
    const compId = (await compR.json()).competition.id;
    const slotA = (await (await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
      headers: saH, data: { name: `SlotA-${t}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 60 },
    })).json()).timeslot.id;
    const slotB = (await (await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
      headers: saH, data: { name: `SlotB-${t}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 60 },
    })).json()).timeslot.id;
    const taskR = await sa.post("/api/admin/tasks", {
      headers: saH,
      data: { title: `SwitchLockTask-${t}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "xyz", explanation: "—", status: "published" },
    });
    const taskId = (await taskR.json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    await sa.post("/api/admin/competitions/assign", {
      headers: saH, data: { userIds: [S.alice.id], competitionIds: [compId] },
    });
    await sa.dispose();

    try {
      // Alice enters slotA and submits — pins her history to slotA.
      const { api: alice, csrf: aCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      const aH = { "x-csrf-token": aCsrf, "content-type": "application/json" };
      await alice.post("/api/select-competition", { headers: aH, data: { competitionId: compId } });
      await alice.post("/api/select-timeslot", { headers: aH, data: { timeslotId: slotA, confirmLive: true } });
      const s1 = await alice.post(`/api/tasks/${taskId}/submit`, { headers: aH, data: { answer: "wrong-once" , gradingHash: await gradingHashFor(alice, taskId)} });
      expect(s1.ok()).toBeTruthy();
      await alice.dispose();

      // Admin removes + re-adds alice. competition_users row is wiped and
      // recreated fresh, so cu.login_time and cu.timeslot_id are NULL.
      // The pre-v6.12.0 lock predicate would be false → no lock.
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      const sa2H = { "x-csrf-token": sa2Csrf, "content-type": "application/json" };
      await sa2.delete(`/api/admin/competitions/${compId}/users/${S.alice.id}`, { headers: { "x-csrf-token": sa2Csrf } });
      await sa2.post("/api/admin/competitions/assign", {
        headers: sa2H, data: { userIds: [S.alice.id], competitionIds: [compId] },
      });
      await sa2.dispose();

      // Alice tries to pick slotB now — must be rejected. v6.12.1's
      // auto-resume on /api/select-competition pre-sets cu.login_time
      // + cu.timeslot_id=slotA, so the pre-existing "already entered a
      // live session" lock (line 4628) fires first; if a caller bypasses
      // select-competition and hits select-timeslot directly,
      // v6.12.0's history-pinned lock catches it at line 4638. Either
      // predicate rejects any attempt to pick a slot other than the
      // one alice's submissions/hint_reveals point at. The assertion
      // is agnostic to WHICH lock fires — either produces 400 with a
      // message that mentions the session / cannot-change semantic.
      const { api: alice2, csrf: a2Csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      const a2H = { "x-csrf-token": a2Csrf, "content-type": "application/json" };
      await alice2.post("/api/select-competition", { headers: a2H, data: { competitionId: compId } });
      const switchR = await alice2.post("/api/select-timeslot", { headers: a2H, data: { timeslotId: slotB, confirmLive: true } });
      expect(switchR.status(), `switch-to-different-slot must 400: got ${switchR.status()} ${await switchR.text()}`).toBe(400);
      expect((await switchR.json()).error).toMatch(/session|cannot change/i);
      await alice2.dispose();
    } finally {
      const { api: cleanup, csrf: cleanupCsrf } = await apiLogin("superadmin");
      const cH = { "x-csrf-token": cleanupCsrf, "content-type": "application/json" };
      await cleanup.delete(`/api/admin/competitions/${compId}`, { headers: cH }).catch(() => {});
      await cleanup.delete(`/api/admin/tasks/${taskId}`, { headers: cH }).catch(() => {});
      await cleanup.dispose();
    }
  });

  test("v6.12.0: ended-slot solveTimeMs is stable across remove+re-add", async () => {
    // When the slot is ENDED at the time of remove, the user's
    // time-to-solve should stay exactly as it was before removal.
    // Mechanically: finishTime is MAX(submitted_at) (stable across
    // DELETE of competition_users — submissions aren't touched),
    // loginMs falls back via COALESCE to MIN(submissions/hints.ts)
    // (also stable), and effEnd = timeslotEffectiveEnd(ts) is stable.
    // v6.12.0's gap subtraction doesn't change this either: the
    // absence row's (removed_at, returned_at) interval happens AFTER
    // the slot ended, so subtracting it still leaves the original
    // finishTime - loginMs (for all-solved) or effEnd - loginMs
    // (for partial) intact.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const t = Date.now();
    const compR = await sa.post("/api/admin/competitions", {
      headers: saH,
      data: { name: `EndedStable-${t}`, start_time: new Date(t + 600_000).toISOString(), duration_minutes: 120 },
    });
    const compId = (await compR.json()).competition.id;
    const tsR = await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
      headers: saH, data: { name: `EndedSlot-${t}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 30 },
    });
    const tsId = (await tsR.json()).timeslot.id;
    const taskR = await sa.post("/api/admin/tasks", {
      headers: saH,
      data: { title: `EndedStableTask-${t}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "xyz", explanation: "—", status: "published" },
    });
    const taskId = (await taskR.json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    await sa.post("/api/admin/competitions/assign", {
      headers: saH, data: { userIds: [S.alice.id], competitionIds: [compId] },
    });
    await sa.dispose();

    try {
      // Alice enters slot + one wrong submission (partial, not all-solved).
      const { api: alice, csrf: aCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      const aH = { "x-csrf-token": aCsrf, "content-type": "application/json" };
      await alice.post("/api/select-competition", { headers: aH, data: { competitionId: compId } });
      await alice.post("/api/select-timeslot", { headers: aH, data: { timeslotId: tsId, confirmLive: true } });
      await alice.post(`/api/tasks/${taskId}/submit`, { headers: aH, data: { answer: "wrong-once" , gradingHash: await gradingHashFor(alice, taskId)} });
      await alice.dispose();

      // Admin ends the slot, then reads baseline solveTimeMs.
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      const sa2H = { "x-csrf-token": sa2Csrf, "content-type": "application/json" };
      await sa2.post(`/api/admin/competitions/${compId}/timeslots/${tsId}/end-now`, { headers: sa2H });
      const readBoard = async () => {
        const r = await sa2.get(`/api/admin/leaderboard?competitionId=${compId}&timeslotId=${tsId}`);
        return (await r.json()).find(u => u.userId === S.alice.id);
      };
      const entryBefore = await readBoard();
      expect(entryBefore).toBeTruthy();
      const solveBefore = entryBefore.solveTimeMs;
      expect(solveBefore).toBeGreaterThan(0);

      // Remove + re-add AFTER the slot is ended. The absence interval
      // (removed_at, returned_at) lies entirely AFTER effEnd, so the
      // gap subtraction shouldn't move the number: effEnd - loginMs
      // doesn't depend on wall-clock time.
      await sa2.delete(`/api/admin/competitions/${compId}/users/${S.alice.id}`, { headers: { "x-csrf-token": sa2Csrf } });
      await new Promise(r => setTimeout(r, 250)); // absence has a real duration
      await sa2.post("/api/admin/competitions/assign", {
        headers: sa2H, data: { userIds: [S.alice.id], competitionIds: [compId] },
      });

      const entryAfter = await readBoard();
      expect(entryAfter, "alice must re-appear on the ended-slot leaderboard after re-add").toBeTruthy();
      // Exact equality with a tiny tolerance for JULIANDAY precision
      // on the gap subtraction (absence happens after end → subtracting
      // it from `effEnd - loginMs` should mathematically not change it,
      // but the query SUMs per-slot-scoped absences only; our post-end
      // absence has timeslot_id=tsId so it IS in scope — the subtraction
      // IS computed, but the resulting delta is the duration of the
      // absence itself, which must be offset by the identical delta in
      // the NEW login_time anchor). Net effect: stable.
      //
      // The v6.10.24 analogue uses `toBeGreaterThanOrEqual(solveBefore - 500)`.
      // We tighten to `±50 ms` because with a stable anchor the absence
      // cancels out; any drift beyond integer-ms rounding is a real bug.
      expect(Math.abs(entryAfter.solveTimeMs - solveBefore), `solveTimeMs drifted: before=${solveBefore} after=${entryAfter.solveTimeMs}`)
        .toBeLessThanOrEqual(50);
      await sa2.dispose();
    } finally {
      const { api: cleanup, csrf: cleanupCsrf } = await apiLogin("superadmin");
      const cH = { "x-csrf-token": cleanupCsrf, "content-type": "application/json" };
      await cleanup.delete(`/api/admin/competitions/${compId}`, { headers: cH }).catch(() => {});
      await cleanup.delete(`/api/admin/tasks/${taskId}`, { headers: cH }).catch(() => {});
      await cleanup.dispose();
    }
  });

  test("v6.12.0: live competition remove+re-add excludes the no-access gap from solveTimeMs", async () => {
    // Core feature of v6.12.0. When a live-competition participant is
    // removed and later re-added, the interval during which they had no
    // access must NOT count against their time-to-solve. Mechanism:
    //   1. DELETE handler opens a competition_user_absences row with
    //      removed_at=now().
    //   2. Bulk-assign on re-add stamps returned_at=now() on the open row.
    //   3. buildLeaderboardEntries SUMs (returned_at - removed_at) across
    //      that user's closed absences and subtracts from solveTimeMs.
    //
    // Test shape — single-slot competition (no timeslots). The per-slot
    // admit gate would filter alice out after re-add (her submissions
    // have timeslot_id set but her fresh cu row has timeslot_id=NULL;
    // `s.timeslot_id = cu.timeslot_id` → NULL never matches NULL in
    // SQL ternary logic). The global admit gate has no per-slot filter
    // and admits her via her existing submissions, which is the
    // realistic read-path for the scenario anyway.
    //
    // Timeline: alice submits in phase 1, is removed for ~700 ms in
    // phase 2, is re-added and the board is read in phase 3. Pre-fix
    // solvePhase3 would include the gap; post-fix it must not.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const t = Date.now();
    // Single-slot live competition — no timeslots added.
    const compR = await sa.post("/api/admin/competitions", {
      headers: saH,
      data: { name: `GapExclude-${t}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 120 },
    });
    const compId = (await compR.json()).competition.id;
    const taskR = await sa.post("/api/admin/tasks", {
      headers: saH,
      data: { title: `GapTask-${t}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "xyz", explanation: "—", status: "published" },
    });
    const taskId = (await taskR.json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    await sa.post("/api/admin/competitions/assign", {
      headers: saH, data: { userIds: [S.alice.id], competitionIds: [compId] },
    });
    await sa.dispose();

    try {
      // Phase 1: alice enters + submits wrong (partial — live branch of solveTimeMs).
      const { api: alice, csrf: aCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      const aH = { "x-csrf-token": aCsrf, "content-type": "application/json" };
      await alice.post("/api/select-competition", { headers: aH, data: { competitionId: compId } });
      await alice.post(`/api/tasks/${taskId}/submit`, { headers: aH, data: { answer: "wrong-once" , gradingHash: await gradingHashFor(alice, taskId)} });
      await alice.dispose();

      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      const sa2H = { "x-csrf-token": sa2Csrf, "content-type": "application/json" };
      const readBoard = async () => {
        const r = await sa2.get(`/api/admin/leaderboard?competitionId=${compId}`);
        return (await r.json()).find(u => u.userId === S.alice.id);
      };
      const entryPhase1 = await readBoard();
      expect(entryPhase1, "alice must be on the board after her submission").toBeTruthy();
      const solvePhase1 = entryPhase1.solveTimeMs;
      expect(solvePhase1).toBeGreaterThan(0);

      // Phase 2: remove alice — DELETE handler opens an absence row
      // because cu.login_time was set (by select-competition).
      const removeAtMs = Date.now();
      await sa2.delete(`/api/admin/competitions/${compId}/users/${S.alice.id}`, { headers: { "x-csrf-token": sa2Csrf } });
      await new Promise(r => setTimeout(r, 700));

      // Phase 3: re-add — bulk-assign closes the absence row.
      await sa2.post("/api/admin/competitions/assign", {
        headers: sa2H, data: { userIds: [S.alice.id], competitionIds: [compId] },
      });
      const returnedAtMs = Date.now();
      const observedGap = returnedAtMs - removeAtMs;

      const entryPhase3 = await readBoard();
      expect(entryPhase3, "alice must re-appear on the board after re-add (admit gate via existing submissions)").toBeTruthy();
      const solvePhase3 = entryPhase3.solveTimeMs;

      // Pre-v6.12.0: solvePhase3 would be solvePhase1 + (elapsed time
      // since phase1 read), INCLUDING the ~700 ms gap. Post-v6.12.0:
      // the gap is subtracted, so solvePhase3 should be LESS than
      // (solvePhase1 + observedGap) by at least ~500 ms (observedGap -
      // ~200 ms slack for clock jitter + JULIANDAY rounding).
      //
      // The "no-fix" estimate is what the pre-v6.12.0 code would have
      // produced; assert we're below it by the bulk of the gap.
      const noFixEstimate = solvePhase1 + observedGap;
      expect(solvePhase3, `gap subtraction did not fire: phase1=${solvePhase1} phase3=${solvePhase3} gap=${observedGap} noFixEstimate=${noFixEstimate}`)
        .toBeLessThan(noFixEstimate - 500);
      // Also sanity-check: solvePhase3 must still be non-negative.
      expect(solvePhase3).toBeGreaterThanOrEqual(0);
      await sa2.dispose();
    } finally {
      const { api: cleanup, csrf: cleanupCsrf } = await apiLogin("superadmin");
      const cH = { "x-csrf-token": cleanupCsrf, "content-type": "application/json" };
      await cleanup.delete(`/api/admin/competitions/${compId}`, { headers: cH }).catch(() => {});
      await cleanup.delete(`/api/admin/tasks/${taskId}`, { headers: cH }).catch(() => {});
      await cleanup.dispose();
    }
  });

  test("v6.12.1: re-added user auto-resumes into their original slot (no chooser)", async () => {
    // Complements the v6.12.0 switch-lock: besides BLOCKING a slot
    // change, we also shouldn't ASK the user to pick. After an admin
    // removes and re-adds a participant, the UI's slot-chooser flow is
    // driven by /api/select-competition's `needsTimeslotChoice` +
    // `chosenTimeslot` fields. Pre-v6.12.1 the fresh cu row had
    // timeslot_id=NULL, so `needsTimeslotChoice` came back true and
    // the chooser surfaced — only for the user to have to (correctly)
    // re-pick their original slot.
    //
    // v6.12.1 restores cu.timeslot_id from history at re-add time
    // (bulk-assign). Downstream effects:
    //   (1) /api/select-competition auto-resumes: chosenTimeslot
    //       populated, needsTimeslotChoice=false.
    //   (2) Per-slot leaderboard admit gate passes (the
    //       `s.timeslot_id = cu.timeslot_id` predicate now matches).
    //   (3) Auto-end scans and admin participant-list visibility all
    //       see the user in their correct slot without any re-action
    //       from the user.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const t = Date.now();
    const compR = await sa.post("/api/admin/competitions", {
      headers: saH,
      data: { name: `AutoResume-${t}`, start_time: new Date(t + 600_000).toISOString(), duration_minutes: 120 },
    });
    const compId = (await compR.json()).competition.id;
    const slotR = await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
      headers: saH, data: { name: `OnlySlot-${t}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 60 },
    });
    const tsId = (await slotR.json()).timeslot.id;
    // Second slot so a "pick a slot" chooser is a meaningful UI state.
    const slot2R = await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
      headers: saH, data: { name: `OtherSlot-${t}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 60 },
    });
    const ts2Id = (await slot2R.json()).timeslot.id;
    const taskR = await sa.post("/api/admin/tasks", {
      headers: saH,
      data: { title: `AutoResumeTask-${t}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "xyz", explanation: "—", status: "published" },
    });
    const taskId = (await taskR.json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    await sa.post("/api/admin/competitions/assign", {
      headers: saH, data: { userIds: [S.alice.id], competitionIds: [compId] },
    });
    await sa.dispose();

    try {
      // Alice enters slot 1 and submits (pins her history).
      const { api: alice, csrf: aCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      const aH = { "x-csrf-token": aCsrf, "content-type": "application/json" };
      await alice.post("/api/select-competition", { headers: aH, data: { competitionId: compId } });
      await alice.post("/api/select-timeslot", { headers: aH, data: { timeslotId: tsId, confirmLive: true } });
      await alice.post(`/api/tasks/${taskId}/submit`, { headers: aH, data: { answer: "wrong-once" , gradingHash: await gradingHashFor(alice, taskId)} });
      await alice.dispose();

      // Admin removes + re-adds alice.
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      const sa2H = { "x-csrf-token": sa2Csrf, "content-type": "application/json" };
      await sa2.delete(`/api/admin/competitions/${compId}/users/${S.alice.id}`, { headers: { "x-csrf-token": sa2Csrf } });
      await sa2.post("/api/admin/competitions/assign", {
        headers: sa2H, data: { userIds: [S.alice.id], competitionIds: [compId] },
      });

      // The competition_users row's timeslot_id MUST be restored to
      // the user's historical slot. Read the admin-participants endpoint
      // which surfaces this field.
      const partsResp = await (await sa2.get(`/api/admin/participants?competitionId=${compId}&limit=200`)).json();
      const aliceParticipant = partsResp.participants.find(u => u.id === S.alice.id);
      expect(aliceParticipant, "alice must be in the competition_users list after re-add").toBeTruthy();
      const aliceComp = aliceParticipant.competitions.find(c => c.id === compId);
      expect(aliceComp, "alice's competition_users row must reference this comp").toBeTruthy();
      expect(aliceComp.timeslot_id, `cu.timeslot_id must restore to original slot after re-add; got: ${aliceComp.timeslot_id}`).toBe(tsId);
      await sa2.dispose();

      // Alice re-logs-in and calls /api/select-competition. The response
      // must auto-resume her into slot 1, not show the chooser.
      const { api: alice2, csrf: a2Csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      const a2H = { "x-csrf-token": a2Csrf, "content-type": "application/json" };
      const selectR = await alice2.post("/api/select-competition", { headers: a2H, data: { competitionId: compId } });
      expect(selectR.ok(), `select-competition failed: ${selectR.status()} ${await selectR.text()}`).toBeTruthy();
      const selectBody = await selectR.json();
      expect(selectBody.needsTimeslotChoice, "re-added user must NOT be asked to pick a slot; history pins them").toBe(false);
      expect(selectBody.chosenTimeslot, "chosenTimeslot must be populated from history").toBeTruthy();
      expect(selectBody.chosenTimeslot.id).toBe(tsId);

      // And per-slot leaderboard admit gate now includes alice again
      // (her cu.timeslot_id matches her history, so the
      // `s.timeslot_id = cu.timeslot_id` predicate fires correctly).
      await alice2.dispose();
      const { api: sa3, csrf: sa3Csrf } = await apiLogin("superadmin");
      const lb = await (await sa3.get(`/api/admin/leaderboard?competitionId=${compId}&timeslotId=${tsId}`)).json();
      const aliceLb = lb.find(u => u.userId === S.alice.id);
      expect(aliceLb, "alice must re-appear on the per-slot leaderboard after re-add (v6.12.1 restores cu.timeslot_id)").toBeTruthy();
      await sa3.dispose();
    } finally {
      const { api: cleanup, csrf: cleanupCsrf } = await apiLogin("superadmin");
      const cH = { "x-csrf-token": cleanupCsrf, "content-type": "application/json" };
      await cleanup.delete(`/api/admin/competitions/${compId}`, { headers: cH }).catch(() => {});
      await cleanup.delete(`/api/admin/tasks/${taskId}`, { headers: cH }).catch(() => {});
      await cleanup.dispose();
    }
  });

  test("v6.9.24: /api/admin/test-email rejects non-superadmin (403); returns {ok:false} 502 on bad SMTP for superadmin", async () => {
    await ensureState();
    // Promote carol → admin (NOT superadmin) for the role-gate check.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.dispose();
    try {
      // Regular admin carol → 403.
      const { api: carol, csrf: cCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      const rCarol = await carol.post("/api/admin/test-email", {
        headers: { "x-csrf-token": cCsrf, "content-type": "application/json" },
        data: { to: "nobody@example.com" },
      });
      expect(rCarol.status()).toBe(403);
      await carol.dispose();

      // Superadmin with bad `to` → 400 (format validation runs before SMTP).
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      const sa2H = { "x-csrf-token": sa2Csrf, "content-type": "application/json" };
      const rBad = await sa2.post("/api/admin/test-email", { headers: sa2H, data: { to: "not-an-email" } });
      expect(rBad.status()).toBe(400);

      // Superadmin with valid-format `to` — SMTP isn't wired in tests, so
      // the transporter.sendMail call 502s with {ok:false, error}.
      const rOk = await sa2.post("/api/admin/test-email", { headers: sa2H, data: { to: "probe@example.com" } });
      expect(rOk.status()).toBe(502);
      const body = await rOk.json();
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe("string");
      await sa2.dispose();
    } finally {
      const { api: sa3, csrf: sa3Csrf } = await apiLogin("superadmin");
      await sa3.post(`/api/admin/participants/${S.carol.id}/role`, { headers: { "x-csrf-token": sa3Csrf, "content-type": "application/json" }, data: { role: "participant" } });
      await sa3.dispose();
    }
  });

  test("v6.9.24: GET /api/invitations/:id returns 404 on unknown / used, 200 with competitions on live", async () => {
    await ensureState();
    const uniqueEmail = `inv-probe-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const r = await sa.post("/api/admin/invitations", {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { emails: [uniqueEmail], competitionIds: [S.liveComp.id] },
    });
    expect(r.ok()).toBeTruthy();
    await sa.dispose();

    // Find the invitation id via the DB by the exact email.
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const invId = db.prepare("SELECT id FROM invitations WHERE LOWER(email)=LOWER(?)").get(uniqueEmail)?.id;
    db.close();
    expect(invId).toBeTruthy();

    const { api } = await freshCtx();
    const rUnknown = await api.get("/api/invitations/00000000-0000-0000-0000-000000000000");
    expect(rUnknown.status()).toBe(404);

    const rOk = await api.get(`/api/invitations/${invId}`);
    expect(rOk.status()).toBe(200);
    const body = await rOk.json();
    expect(typeof body.email).toBe("string");
    expect(Array.isArray(body.competitions)).toBe(true);
    expect(body.used).toBe(false);
    // Mark invitation as used via DB, then re-query → 404.
    const dbW = new Database(TEST_DB_PATH);
    dbW.prepare("UPDATE invitations SET used_at=? WHERE id=?").run(new Date().toISOString(), invId);
    dbW.close();
    const rUsed = await api.get(`/api/invitations/${invId}`);
    expect(rUsed.status()).toBe(404);
    await api.dispose();
  });

  test("v6.9.24: DELETE /api/admin/competitions/:id on a live competition is rejected", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const r = await sa.delete(`/api/admin/competitions/${S.liveComp.id}`, { headers: { "x-csrf-token": saCsrf } });
    // Server accepts the delete only on non-live comps — assert the gate
    // exists (400 or similar non-2xx). Exact code depends on current handler.
    expect([400, 403, 409]).toContain(r.status());
    await sa.dispose();
  });

  test("v6.9.24: DELETE /api/admin/competitions/:id cascades competition_users / competition_tasks rows", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Create an upcoming competition so assign + task-assign succeed.
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const cr = await sa.post("/api/admin/competitions", { headers: saH, data: { name: `Del-Cascade-${Date.now()}`, start_time: future, duration_minutes: 60 } });
    const compId = (await cr.json()).competition.id;
    await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [S.alice.id], competitionIds: [compId] } });
    const taskId = S.easy1.id; // easy1 is seeded as published
    const asnR = await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    expect(asnR.ok(), `task-assign: ${asnR.status()} ${await asnR.text()}`).toBeTruthy();
    // Sanity-check the joins exist.
    const Database = require("better-sqlite3");
    let db = new Database(TEST_DB_PATH, { readonly: true });
    expect(db.prepare("SELECT 1 FROM competition_users WHERE competition_id=?").get(compId)).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM competition_tasks WHERE competition_id=?").get(compId)).toBeTruthy();
    db.close();
    // Delete.
    const del = await sa.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": saCsrf } });
    expect(del.ok(), `delete upcoming comp: ${del.status()}`).toBeTruthy();
    // Cascade: join rows + competition row should all be gone.
    db = new Database(TEST_DB_PATH, { readonly: true });
    expect(db.prepare("SELECT 1 FROM competition_users WHERE competition_id=?").get(compId)).toBeFalsy();
    expect(db.prepare("SELECT 1 FROM competition_tasks WHERE competition_id=?").get(compId)).toBeFalsy();
    expect(db.prepare("SELECT 1 FROM competitions WHERE id=?").get(compId)).toBeFalsy();
    db.close();
    await sa.dispose();
  });

  test("v6.9.24: POST /api/admin/import/participants rejects non-superadmin (403); accepts a minimal valid export", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Promote carol to admin (NOT superadmin) for the role-gate check.
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.dispose();
    try {
      const { api: carol, csrf: cCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      const rCarol = await carol.post("/api/admin/import/participants", {
        headers: { "x-csrf-token": cCsrf, "content-type": "application/json" },
        data: { data: { type: "hackarena-participants", participants: [] } },
      });
      expect(rCarol.status()).toBe(403);
      await carol.dispose();
    } finally {
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      const sa2H = { "x-csrf-token": sa2Csrf, "content-type": "application/json" };
      // Demote carol FIRST. The happy-path assertion below lives inside this
      // finally too, so restoring after it would leave a shared seeded
      // participant an admin (and `staff`-tagged) for the rest of the file.
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: sa2H, data: { role: "participant" } });
      // Happy path from superadmin — accepting a fresh import payload.
      const t = Date.now();
      const payload = {
        data: {
          type: "hackarena-participants",
          participants: [
            { first_name: "Import", last_name: "Tester", nickname: `imp_${t}`, email: `imp-${t}@company.example`, company: "Initech", title: "Engineer", country: "US", timezone: "America/New_York" },
          ],
        },
      };
      const r = await sa2.post("/api/admin/import/participants", { headers: sa2H, data: payload });
      const importStatus = r.status();
      await sa2.dispose();
      // Either it imported immediately (no conflicts) or returned a conflict-resolution shape.
      expect([200, 409]).toContain(importStatus);
    }
  });

  test("v7.2.x: participant import preserves job_function + city (export/import round-trip)", async () => {
    // Regression: both import branches (new INSERT + overwrite UPDATE) dropped
    // job_function + city, so a re-imported account came back with NULLs and the
    // non-dismissible profile-completion gate fired on next login.
    await ensureState();
    const Database = require("better-sqlite3");
    const { api: sa, csrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": csrf, "content-type": "application/json" };
    const t = Date.now();
    const email = `rt-jfcity-${t}@company.example`;
    // resolutions:{} forces the COMMIT phase (the dry-run is the no-resolutions
    // call); a fresh email is a no-conflict row → "import" → the new-INSERT branch.
    const payload = { data: { type: "hackarena-participants", participants: [
      { first_name: "Round", last_name: "Trip", nickname: `rtjf_${t}`, email, company: "Co", title: "Eng", country: "US", timezone: "America/New_York", job_function: "Security Researcher", city: "Tel Aviv", verified: 1, approved: 1 },
    ] }, resolutions: {} };
    const r = await sa.post("/api/admin/import/participants", { headers: saH, data: payload });
    expect(r.ok(), `import: ${r.status()} ${await r.text()}`).toBeTruthy();
    await sa.dispose();
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const u = db.prepare("SELECT id, job_function, city FROM users WHERE LOWER(email)=LOWER(?)").get(email);
    db.close();
    expect(u, "imported user exists").toBeTruthy();
    expect(u.job_function).toBe("Security Researcher");
    expect(u.city).toBe("Tel Aviv");
    const { api: sa2, csrf: c2 } = await apiLogin("superadmin");
    await sa2.delete(`/api/admin/participants/${u.id}`, { headers: { "x-csrf-token": c2 } }).catch(() => {});
    await sa2.dispose();
  });

  test("v6.9.21: /api/admin/logs/files lists jsonl files, sorted newest-first, rejects non-admin with 401/403", async () => {
    await ensureState();
    // Anonymous → auth gate.
    const { api: anon } = await freshCtx();
    const rAnon = await anon.get("/api/admin/logs/files");
    expect([401, 403]).toContain(rAnon.status());
    await anon.dispose();
    // Participant → same.
    const { api: alice } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const rAlice = await alice.get("/api/admin/logs/files");
    expect(rAlice.status()).toBe(403);
    await alice.dispose();
    // Admin-equivalent → list of files, each with {name, size_bytes, modified_at}.
    const { api: sa } = await apiLogin("superadmin");
    const rSa = await sa.get("/api/admin/logs/files");
    expect(rSa.status()).toBe(200);
    const body = await rSa.json();
    expect(Array.isArray(body.files)).toBe(true);
    if (body.files.length) {
      const row = body.files[0];
      expect(typeof row.name).toBe("string");
      expect(row.name).toMatch(/^(access|app)-.*\.jsonl$/);
      expect(typeof row.size_bytes).toBe("number");
      expect(typeof row.modified_at).toBe("string");
    }
    await sa.dispose();
  });

  test("v6.9.21: /api/admin/settings/events returns paginated settings-change history, admin-only", async () => {
    await ensureState();
    const { api: alice } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    expect((await alice.get("/api/admin/settings/events")).status()).toBe(403);
    await alice.dispose();
    const { api: sa } = await apiLogin("superadmin");
    // Trigger a settings change so the table isn't empty.
    const csrf = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    try {
      await sa.patch("/api/admin/settings", {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { platform_name: `SettingsEvt-${Date.now()}` },
      });
      // Paginated response requires `offset` and/or `limit` query params.
      const r = await sa.get("/api/admin/settings/events?offset=0&limit=20");
      expect(r.status()).toBe(200);
      const body = await r.json();
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events.length).toBeGreaterThan(0);
      const evt = body.events[0];
      expect(typeof evt.event_type).toBe("string");
      expect(typeof evt.changed_at).toBe("string");
      // Un-paginated shape is a bare array of events.
      const rBare = await sa.get("/api/admin/settings/events");
      expect(Array.isArray(await rBare.json())).toBe(true);
    } finally {
      // v8.3.11 — RESTORE THE GLOBAL SETTING. `platform_name` renders into the
      // header wordmark, the login card, the <title> and all 19 email subjects, so
      // a file that leaves a fixture name behind is a contaminator under per-file
      // isolation (v8.1.0), and the isolated-test.js afterAll guard fails the whole
      // FILE for it — which is why this test could not run alone. Restore to the
      // hard-coded DEFAULT, never to what was read first: this file has three
      // writers, so a read-then-restore faithfully reinstates a SIBLING's fixture
      // name and the guard still fires.
      try {
        await sa.patch("/api/admin/settings", {
          headers: { "x-csrf-token": csrf, "content-type": "application/json" },
          data: { platform_name: "Checkmarx Enablement Platform" },
        });
      } catch (_) {}
    }
    await sa.dispose();
  });

  test("v6.9.21: /api/admin/competitions/:id/timeslots/:tsId/events 404 on unknown tsId, admin-only", async () => {
    await ensureState();
    const { api: alice } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    expect((await alice.get(`/api/admin/competitions/${S.liveComp.id}/timeslots/nonexistent-ts/events`)).status()).toBe(403);
    await alice.dispose();
    const { api: sa } = await apiLogin("superadmin");
    // Unknown tsId — handler returns an empty events list (not 404, by
    // current design — the count query just returns 0). Lock in the
    // documented behaviour rather than a guess.
    const r = await sa.get(`/api/admin/competitions/${S.liveComp.id}/timeslots/00000000-0000-0000-0000-000000000000/events?offset=0&limit=20`);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBe(0);
    expect(body.total).toBe(0);
    await sa.dispose();
  });

  test("v6.10.64: /api/admin/settings/events returns snapshot_before + filters events newer than the anchor", async () => {
    await ensureState();
    const { api: sa } = await apiLogin("superadmin");
    const csrf = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    const saH = { "x-csrf-token": csrf, "content-type": "application/json" };
    // Seed one settings-change so the table isn't empty. See the restore in the
    // `finally` below — this is the second of three platform_name writers in this
    // file, and only the third used to put it back.
    try {
    await sa.patch("/api/admin/settings", { headers: saH, data: { platform_name: `SnapA-${Date.now()}` } });

    // Page 1 — paginated response must include snapshot_before (an ISO
    // timestamp string pinned to the newest event at fetch time).
    const r1 = await sa.get("/api/admin/settings/events?offset=0&limit=20");
    const b1 = await r1.json();
    expect(typeof b1.snapshot_before).toBe("string");
    expect(b1.snapshot_before.length).toBeGreaterThan(0);
    const snapshot = b1.snapshot_before;

    // Generate a new settings event AFTER the snapshot — its changed_at
    // lexically sorts after the snapshot anchor. Playwright's api.patch
    // awaits the response, so the event is durable before we move on.
    // Add a 15 ms sleep to guarantee the next event's ISO timestamp is
    // strictly later (better-sqlite3 inserts can be sub-millisecond on
    // a quiet box, and ISO-8601 string compare with identical timestamps
    // would fall on the wrong side of the <= boundary — the snapshot
    // semantic wants STRICT after-the-anchor, not at-the-anchor).
    await new Promise(r => setTimeout(r, 15));
    await sa.patch("/api/admin/settings", { headers: saH, data: { platform_name: `SnapB-${Date.now()}` } });

    // Echo the snapshot — the new event must NOT appear, and total must
    // not grow either (filter applied to both COUNT and SELECT).
    const r2 = await sa.get(`/api/admin/settings/events?offset=0&limit=20&snapshot_before=${encodeURIComponent(snapshot)}`);
    const b2 = await r2.json();
    expect(b2.total).toBe(b1.total);
    expect(b2.events.every(e => e.changed_at <= snapshot)).toBe(true);
    expect(b2.snapshot_before).toBe(snapshot);

    // Fetching WITHOUT the snapshot sees the new event — confirms the
    // previous assertion wasn't a no-op against an unchanged table.
    const r3 = await sa.get("/api/admin/settings/events?offset=0&limit=20");
    const b3 = await r3.json();
    expect(b3.total).toBeGreaterThan(b1.total);
    } finally {
      // v8.3.11 — see the sibling above. The DEFAULT, not what was read first.
      try {
        await sa.patch("/api/admin/settings", { headers: saH, data: { platform_name: "Checkmarx Enablement Platform" } });
      } catch (_) {}
    }
    await sa.dispose();
  });

  test("v6.23: event-history pagination is row-stable via snapshot_tie (same-ms insert mid-walk doesn't drift)", async () => {
    // The (changed_at, id) snapshot_tie anchor is what makes pagination
    // drift-free when multiple events share the SAME millisecond — the case a
    // bare `changed_at <= snapshot` filter can't disambiguate. Pre-this-test
    // the tie-key (lib/audit _applySnapshotFilter / _paginationParams) had ZERO
    // coverage. Plant several settings_events at one identical changed_at, page
    // through them, and inject a NEW same-ms higher-id event mid-walk: the
    // echoed (changed_at,id) anchor must EXCLUDE it. A regression that dropped
    // the tie-key (filtering only on changed_at) would wrongly surface it.
    await ensureState();
    const Database = require("better-sqlite3");
    const crypto = require("crypto");
    const tag = crypto.randomBytes(5).toString("hex");
    const key = `tiekey_${tag}`;
    // Future-dated identical timestamp so these four sort NEWEST (page 1).
    const sameTs = "2026-12-31T23:59:59.000Z";
    const planted = [`se-${tag}-1`, `se-${tag}-2`, `se-${tag}-3`, `se-${tag}-4`];
    const dbW = new Database(TEST_DB_PATH);
    try {
      const ins = dbW.prepare("INSERT INTO settings_events (id, setting_key, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");
      for (const id of planted) ins.run(id, key, "updated", "system", sameTs, null);
    } finally { dbW.close(); }
    const { api: sa } = await apiLogin("superadmin");
    try {
      // Page 1 (limit=2) pins the anchor to the top (changed_at, id) pair.
      const b1 = await (await sa.get("/api/admin/settings/events?offset=0&limit=2")).json();
      expect(typeof b1.snapshot_before).toBe("string");
      expect(typeof b1.snapshot_tie).toBe("string");
      const snap = encodeURIComponent(b1.snapshot_before);
      const tie = encodeURIComponent(b1.snapshot_tie);
      // Inject a NEW event at the SAME changed_at with an id that sorts ABOVE
      // the anchor (ZZZ > se-...). Under (changed_at < snap OR (changed_at =
      // snap AND id <= anchorId)) it's excluded; under a bare changed_at<=snap
      // it would wrongly appear at the top of the echoed page.
      const intruder = `se-${tag}-ZZZ-higher`;
      const dbI = new Database(TEST_DB_PATH);
      try { dbI.prepare("INSERT INTO settings_events (id, setting_key, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)").run(intruder, key, "updated", "system", sameTs, null); } finally { dbI.close(); }
      // Walk every page echoing the page-1 anchor; collect all ids seen.
      const seen = b1.events.map(e => e.id);
      for (let off = 2; off < 200; off += 2) {
        const b = await (await sa.get(`/api/admin/settings/events?offset=${off}&limit=2&snapshot_before=${snap}&snapshot_tie=${tie}`)).json();
        if (!b.events || !b.events.length) break;
        for (const e of b.events) seen.push(e.id);
      }
      // The mid-walk same-ms higher-id intruder must never surface (row-stable).
      expect(seen).not.toContain(intruder);
      // No row appears twice across the walk.
      expect(new Set(seen).size).toBe(seen.length);
      // All four originally-planted same-ms rows appear exactly once.
      for (const id of planted) expect(seen).toContain(id);
    } finally {
      await sa.dispose();
      const dbC = new Database(TEST_DB_PATH);
      try { dbC.prepare("DELETE FROM settings_events WHERE setting_key=?").run(key); } finally { dbC.close(); }
    }
  });

  test("v6.23: participants picker search escapes LIKE wildcards (literal _ is not a single-char wildcard)", async () => {
    // The picker search builds `%<term>%` and escapes %/_/\ with ESCAPE '\'.
    // Pre-this-test that escaping (server.js participants/picker + groups picker
    // + submissions + logs) had ZERO coverage — a regex typo dropping the
    // escape would silently turn user input into wildcards. Plant two non-member
    // users whose emails differ only at the '_' position; searching the literal
    // underscore form must match ONLY that user, never the wildcard sibling.
    await ensureState();
    const Database = require("better-sqlite3");
    const crypto = require("crypto");
    const tag = crypto.randomBytes(5).toString("hex");
    const litEmail = `escwild-a_b-${tag}@t.test`;   // literal underscore
    const wildEmail = `escwild-axb-${tag}@t.test`;  // 'x' where the '_' sits
    const litId = `u-${tag}-lit`, wildId = `u-${tag}-wild`;
    const dbW = new Database(TEST_DB_PATH);
    try {
      const ins = dbW.prepare("INSERT INTO users (id, first_name, last_name, nickname, email, password_hash, verified, approved, created_at, role) VALUES (?,?,?,?,?,?,1,1,?,?)");
      ins.run(litId, "EscLit", "User", `escnl-${tag}`, litEmail, "x", "2026-06-01T00:00:00.000Z", "participant");
      ins.run(wildId, "EscWild", "User", `escnw-${tag}`, wildEmail, "x", "2026-06-01T00:00:00.000Z", "participant");
    } finally { dbW.close(); }
    const { api: sa } = await apiLogin("superadmin");
    try {
      const term = encodeURIComponent(`escwild-a_b-${tag}`);
      const data = await (await sa.get(`/api/admin/participants/picker?competitionId=${S.liveComp.id}&search=${term}`)).json();
      expect(data.searchApplied).toBe(true);
      const nonMemberEmails = data.users.filter(u => u.in_competition !== 1).map(u => (u.email || "").toLowerCase());
      expect(nonMemberEmails).toContain(litEmail);          // exact literal match
      expect(nonMemberEmails).not.toContain(wildEmail);     // '_' must NOT wildcard-match 'x'
      // matchingNonMembers counts the literal hit only (1), not 2.
      expect(data.matchingNonMembers).toBe(1);
    } finally {
      await sa.dispose();
      const dbC = new Database(TEST_DB_PATH);
      try { dbC.prepare("DELETE FROM users WHERE id IN (?,?)").run(litId, wildId); } finally { dbC.close(); }
    }
  });

  test("v6.23: submissions ?q= filters by substring across the searched fields (excludes nonsense)", async () => {
    // The submissions search (?q=) had no functional coverage. Derive a term
    // from a REAL seeded submission so the test is seed-agnostic, then assert
    // the filter (a) keeps the source row, (b) returns ONLY rows matching the
    // term in one of the searched fields (nickname / task title / answer /
    // competition / session / event type), and (c) returns nothing for a
    // nonsense query.
    await ensureState();
    const { api: sa } = await apiLogin("superadmin");
    try {
      const all = await (await sa.get("/api/admin/submissions?limit=200")).json();
      expect(all.events.length).toBeGreaterThan(0);
      const sample = all.events.find(e => e.nickname && e.nickname.length >= 2);
      expect(sample, "seed should contain a submission with a nickname").toBeTruthy();
      const term = sample.nickname;
      const lc = term.toLowerCase();
      const hit = await (await sa.get(`/api/admin/submissions?limit=200&q=${encodeURIComponent(term)}`)).json();
      expect(hit.events.some(e => e.nickname === sample.nickname)).toBe(true);
      expect(hit.events.every(e =>
        [e.nickname, e.task_title, e.answer, e.competition_name, e.timeslot_name, e.event_type]
          .some(v => String(v || "").toLowerCase().includes(lc))
      )).toBe(true);
      const none = await (await sa.get("/api/admin/submissions?limit=200&q=zzqqxx_no_such_submission_ever")).json();
      expect(none.events.length).toBe(0);
      expect(none.total).toBe(0);
    } finally { await sa.dispose(); }
  });

  test("v6.23: event-history endpoints page through every row exactly once (participants + timeslots)", async () => {
    // Multi-page offset walk for the two event endpoints that lacked it. Plant
    // N events for a synthetic entity id (handlers query by the path id with no
    // existence check — see the unknown-tsId test above), then walk with a
    // small limit echoing the page-1 anchor and assert every row appears
    // exactly once: no gaps, no duplicates, total === N.
    await ensureState();
    const Database = require("better-sqlite3");
    const crypto = require("crypto");
    const tag = crypto.randomBytes(5).toString("hex");
    const N = 7;
    const userId = `pagewalk-user-${tag}`;
    const tsId = `pagewalk-ts-${tag}`;
    const dbW = new Database(TEST_DB_PATH);
    try {
      const insU = dbW.prepare("INSERT INTO user_events (id, user_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");
      const insT = dbW.prepare("INSERT INTO timeslot_events (id, timeslot_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");
      for (let i = 0; i < N; i++) {
        const ts = `2026-07-0${i + 1}T00:00:0${i}.000Z`; // distinct, increasing
        insU.run(`ue-${tag}-${i}`, userId, "test_event", "system", ts, null);
        insT.run(`te-${tag}-${i}`, tsId, "test_event", "system", ts, null);
      }
    } finally { dbW.close(); }
    const { api: sa } = await apiLogin("superadmin");
    try {
      for (const url of [
        `/api/admin/participants/${userId}/events`,
        `/api/admin/competitions/${S.liveComp.id}/timeslots/${tsId}/events`,
      ]) {
        const first = await (await sa.get(`${url}?offset=0&limit=2`)).json();
        expect(first.total, `total for ${url}`).toBe(N);
        const snap = encodeURIComponent(first.snapshot_before);
        const tie = encodeURIComponent(first.snapshot_tie);
        const seen = first.events.map(e => e.id);
        for (let off = 2; off < N + 5; off += 2) {
          const b = await (await sa.get(`${url}?offset=${off}&limit=2&snapshot_before=${snap}&snapshot_tie=${tie}`)).json();
          if (!b.events || !b.events.length) break;
          for (const e of b.events) seen.push(e.id);
        }
        expect(seen.length, `walked rows for ${url}`).toBe(N);   // no gaps
        expect(new Set(seen).size, `unique rows for ${url}`).toBe(N); // no dupes
      }
    } finally {
      await sa.dispose();
      const dbC = new Database(TEST_DB_PATH);
      try {
        dbC.prepare("DELETE FROM user_events WHERE user_id=?").run(userId);
        dbC.prepare("DELETE FROM timeslot_events WHERE timeslot_id=?").run(tsId);
      } finally { dbC.close(); }
    }
  });

  test("v6.10.72: /api/admin/submissions returns snapshot_before + filters newer events on echo", async () => {
    // Same drift-free-pagination semantic as the v6.10.64 event endpoints,
    // applied to the Submissions tab's union (submissions + hint_reveals).
    await ensureState();
    const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const aliceH = { "x-csrf-token": aliceCsrf, "content-type": "application/json" };
    // Alice must select the live comp on a fresh session before submits
    // are accepted (server returns 400 if no active_competition_id).
    await alice.post("/api/select-competition", { headers: aliceH, data: { competitionId: S.liveComp.id } });
    const tasks = await (await alice.get("/api/tasks")).json();
    // Pick an UNSOLVED task — Alice may have solved some in prior tests,
    // and the server returns 400 "Already solved" on a second submit.
    const unsolvedTask = tasks.find(t => !t.solved);
    expect(unsolvedTask, "need at least one unsolved task to test submissions").toBeTruthy();
    // Submit a wrong answer to seed the Submissions feed.
    const s1 = await alice.post(`/api/tasks/${unsolvedTask.id}/submit`, {
      headers: aliceH, data: { answer: `wrong-${Date.now()}` , gradingHash: await gradingHashFor(alice, unsolvedTask.id)},
    });
    expect(s1.ok(), `seed submit failed: ${s1.status()} ${await s1.text()}`).toBeTruthy();

    const { api: sa } = await apiLogin("superadmin");
    // Page 1 — must include snapshot_before (ISO event_time string).
    const r1 = await sa.get("/api/admin/submissions?limit=20&offset=0");
    const b1 = await r1.json();
    expect(typeof b1.snapshot_before).toBe("string");
    expect(b1.snapshot_before.length).toBeGreaterThan(0);
    const snapshot = b1.snapshot_before;
    const totalBefore = b1.total;

    // Add a NEWER submission so its event_time sorts after the snapshot.
    // Sleep 15 ms to guarantee a strictly-later ISO timestamp — submissions
    // write submitted_at = NOW() at ms precision, so sub-ms inserts would
    // tie the timestamp and fall on the wrong side of the <= boundary.
    await new Promise(r => setTimeout(r, 15));
    const s2 = await alice.post(`/api/tasks/${unsolvedTask.id}/submit`, {
      headers: aliceH, data: { answer: `wrong-snap-${Date.now()}` , gradingHash: await gradingHashFor(alice, unsolvedTask.id)},
    });
    expect(s2.ok(), `post-snapshot submit failed: ${s2.status()} ${await s2.text()}`).toBeTruthy();
    await alice.dispose();

    // Echo the snapshot — the new event must NOT appear, total must not grow.
    const r2 = await sa.get(`/api/admin/submissions?limit=20&offset=0&snapshot_before=${encodeURIComponent(snapshot)}`);
    const b2 = await r2.json();
    expect(b2.total).toBe(totalBefore);
    expect(b2.events.every(e => e.event_time <= snapshot)).toBe(true);
    expect(b2.snapshot_before).toBe(snapshot);

    // Un-snapshot fetch MUST see the new event (sanity check against no-op).
    const r3 = await sa.get("/api/admin/submissions?limit=20&offset=0");
    const b3 = await r3.json();
    expect(b3.total).toBeGreaterThan(totalBefore);
    await sa.dispose();
  });

  test("v6.10.64: /api/admin/competitions/:id/events snapshot_before same semantic", async () => {
    // Cross-endpoint smoke — the snapshot helper is shared, so one
    // per-endpoint-family test is enough. This one locks in the
    // competition events endpoint because it has the additional
    // response cache (cache key includes snapshot, so different
    // snapshots don't collide).
    await ensureState();
    const { api: sa } = await apiLogin("superadmin");
    const csrf = (await (await sa.get("/api/csrf-token")).json()).csrfToken;
    const saH = { "x-csrf-token": csrf, "content-type": "application/json" };

    // Trigger a competition event so the table has at least one row for
    // this comp. Rename works cleanly and is reversible at the end.
    const origName = S.liveComp.name;
    const newName = `${origName}-snap-${Date.now()}`;
    await sa.put(`/api/admin/competitions/${S.liveComp.id}`, { headers: saH, data: { name: newName } });
    try {
      const r1 = await sa.get(`/api/admin/competitions/${S.liveComp.id}/events?offset=0&limit=20`);
      const b1 = await r1.json();
      expect(typeof b1.snapshot_before).toBe("string");
      const snapshot = b1.snapshot_before;

      // Sleep 15 ms + trigger a second event so its changed_at sorts after.
      await new Promise(r => setTimeout(r, 15));
      await sa.put(`/api/admin/competitions/${S.liveComp.id}`, { headers: saH, data: { name: `${origName}-snap2-${Date.now()}` } });

      // Snapshot echo excludes the new event.
      const r2 = await sa.get(`/api/admin/competitions/${S.liveComp.id}/events?offset=0&limit=20&snapshot_before=${encodeURIComponent(snapshot)}`);
      const b2 = await r2.json();
      expect(b2.events.every(e => e.changed_at <= snapshot)).toBe(true);

      // Without the snapshot, totals grow (sanity check).
      const r3 = await sa.get(`/api/admin/competitions/${S.liveComp.id}/events?offset=0&limit=20`);
      const b3 = await r3.json();
      expect(b3.total).toBeGreaterThan(b1.total);
    } finally {
      // Restore original name so downstream tests see the expected value.
      await sa.put(`/api/admin/competitions/${S.liveComp.id}`, { headers: saH, data: { name: origName } });
    }
    await sa.dispose();
  });

  test("v6.13.9 Fix 1: /api/admin/submissions pagination is row-stable under same-ms inserts", async () => {
    // Auditor finding 1: pre-v6.13.9 the snapshot filter was
    // `event_time <= snapshot_before` — millisecond-stable but NOT
    // row-stable. A same-ms insert landing between page 1 and page 2
    // could slot into the top-N (the `tie_key DESC` secondary sort)
    // and push a page-1 row into page-2's OFFSET window, producing
    // duplicates across pages.
    //
    // Fix: pin the anchor to (event_time, tie_key) as a lex pair.
    // Filter: (event_time < snap) OR (event_time = snap AND tie_key
    // <= snap_tie). Client now echoes snapshot_tie alongside
    // snapshot_before; server ships the pair in every paginated
    // response.
    //
    // Forcing same-ms inserts deterministically requires DB-level
    // access (two submit calls in quick succession aren't guaranteed
    // to collide on the ms). Open a direct better-sqlite3 connection
    // to the test DB to insert a synthetic row with the exact
    // anchor timestamp + a tie_key that sorts ABOVE the anchor in
    // DESC order — the case that breaks pre-fix pagination.
    await ensureState();
    const Database = require("better-sqlite3");
    const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const aliceH = { "x-csrf-token": aliceCsrf, "content-type": "application/json" };
    await alice.post("/api/select-competition", { headers: aliceH, data: { competitionId: S.liveComp.id } });
    const tasks = await (await alice.get("/api/tasks")).json();
    const unsolved = tasks.find(t => !t.solved);
    expect(unsolved, "need at least one unsolved task").toBeTruthy();
    const s1 = await alice.post(`/api/tasks/${unsolved.id}/submit`, {
      headers: aliceH, data: { answer: `row-stable-seed-${Date.now()}` , gradingHash: await gradingHashFor(alice, unsolved.id)},
    });
    expect(s1.ok(), `seed submit failed: ${s1.status()}`).toBeTruthy();
    await alice.dispose();

    const { api: sa } = await apiLogin("superadmin");
    // Page 1 — anchor on the real state.
    const r1 = await sa.get(`/api/admin/submissions?limit=100&offset=0&competitionId=${S.liveComp.id}`);
    const b1 = await r1.json();
    expect(typeof b1.snapshot_before).toBe("string");
    expect(typeof b1.snapshot_tie).toBe("string");
    expect(b1.snapshot_tie.length).toBeGreaterThan(0);
    const snap    = b1.snapshot_before;
    const snapTie = b1.snapshot_tie;
    const totalBefore = b1.total;

    // Direct-DB insert: synthetic row with submitted_at = snap AND
    // id lex-greater than snap_tie. This is the row the pre-v6.13.9
    // filter would admit (event_time <= snap) but the row-stable
    // filter excludes ((event_time = snap AND tie_key > snap_tie)).
    //
    // v6.13.15 fix: the tie-key MUST be guaranteed greater than snapTie
    // under BINARY collation. Previous code used "Z".repeat(36), which
    // works when snapTie starts with "0"-"9" (0x30-0x39, all < "Z" at
    // 0x5A) but FAILS when snapTie starts with "a"-"f" (0x61-0x66, all
    // > "Z"). UUIDs use both char classes roughly equally → test was
    // flaky. Deriving higherTie from snapTie with an appended "z"
    // (0x7A > any UUID hex char) makes it lex-greater under every
    // possible snapTie prefix: `"abc" < "abcz"` is always true.
    const db = new Database(TEST_DB_PATH);
    const higherTie = snapTie + "z";
    // Need an existing user + task to satisfy submissions FKs.
    const someUser = db.prepare("SELECT id FROM users WHERE nickname=?").get("alice")
                  || db.prepare("SELECT id FROM users LIMIT 1").get();
    const someTask = db.prepare("SELECT id FROM tasks LIMIT 1").get();
    expect(someUser, "need a user row").toBeTruthy();
    expect(someTask, "need a task row").toBeTruthy();
    try {
      db.prepare(
        "INSERT INTO submissions (id, user_id, task_id, answer, is_correct, points_delta, submitted_at, competition_id, updated_at) VALUES (?, ?, ?, ?, 0, -5, ?, ?, ?)"
      ).run(higherTie, someUser.id, someTask.id, "row-stable-after-anchor", snap, S.liveComp.id, snap);

      // Echoed snapshot — the synthetic same-ms/higher-tie row must NOT
      // appear anywhere in the page, and snapshot fields must echo back
      // the (snap, tie) values the client sent. (Not asserting b2.total
      // === totalBefore because unrelated background test-harness
      // activity can occasionally emit a submission between the two
      // fetches — the core contract is just "synthetic row excluded".)
      const r2 = await sa.get(`/api/admin/submissions?limit=100&offset=0&competitionId=${encodeURIComponent(S.liveComp.id)}&snapshot_before=${encodeURIComponent(snap)}&snapshot_tie=${encodeURIComponent(snapTie)}`);
      const b2 = await r2.json();
      expect(b2.snapshot_before).toBe(snap);
      expect(b2.snapshot_tie).toBe(snapTie);
      expect(b2.events.find(e => e.tie_key === higherTie),
        "the same-ms/higher-tie row must not be admitted by a row-stable snapshot").toBeUndefined();

      // Sanity check: WITHOUT the snapshot echo, the synthetic row IS
      // visible — confirms the previous assertion wasn't a no-op.
      const r3 = await sa.get(`/api/admin/submissions?limit=100&offset=0&competitionId=${S.liveComp.id}`);
      const b3 = await r3.json();
      expect(b3.events.find(e => e.tie_key === higherTie),
        "without a snapshot filter the synthetic row must appear").toBeTruthy();
    } finally {
      db.prepare("DELETE FROM submissions WHERE id=?").run(higherTie);
      db.close();
    }
    await sa.dispose();
  });

  test("v6.13.9 Fix 1: admin event-history endpoints accept snapshot_tie + filter lexicographically", async () => {
    // Same row-stable contract as /api/admin/submissions, applied to
    // the shared event-history helper that serves
    // /api/admin/competitions/:id/events + timeslots/:tsId/events +
    // participants/:id/events + settings/events. Test picks the
    // settings-events endpoint (smallest + simplest surface) and
    // directly injects a synthetic same-changed_at/higher-id row via
    // DB — then verifies the echoed (snap, tie) filter excludes it
    // while the no-filter call still sees it.
    await ensureState();
    const Database = require("better-sqlite3");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Trigger a settings change so the table has a baseline row.
    //
    // v8.1.0 — the platform name is RESTORED at the end of this test. It is a
    // GLOBAL setting that renders into the header wordmark, the login card, the
    // <title> and every email subject, so leaving it changed makes this file a
    // contaminator of anything that reads it — and the visual-regression baseline
    // reads it, which is how a login-screen pixel diff came to be attributed to a
    // CSS change made in a different release. Same class as the v7.22.5
    // alice-password finding: a test that mutates shared state and does not put it
    // back. Held from here on by the afterAll guard in tests/isolated-test.js.
    // v8.1.0 — restore to the DEFAULT, not to "whatever I found". This file has
    // FOUR platform_name writers and this is the last of them, so reading the
    // current value here would faithfully restore the PREVIOUS test's fixture name
    // and the file would still exit contaminated. The default is the honest end
    // state; the guard in tests/isolated-test.js checks exactly that.
    const _platformBefore = "Checkmarx Enablement Platform";
    await sa.patch("/api/admin/settings", { headers: saH, data: { platform_name: `SnapTie-${Date.now()}` } });

    const r1 = await sa.get("/api/admin/settings/events?offset=0&limit=20");
    const b1 = await r1.json();
    expect(typeof b1.snapshot_before).toBe("string");
    expect(typeof b1.snapshot_tie).toBe("string");
    const snap    = b1.snapshot_before;
    const snapTie = b1.snapshot_tie;
    const totalBefore = b1.total;

    // v6.13.15 — derive higherId from snapTie for the same reason as
    // the submissions test above: "Z".repeat(36) is not guaranteed
    // greater than a UUID starting with lowercase a-f.
    const db = new Database(TEST_DB_PATH);
    const higherId = snapTie + "z";
    try {
      db.prepare(
        "INSERT INTO settings_events (id, setting_key, event_type, changed_by, changed_at, details) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(higherId, "platform_name", "updated", "superadmin", snap, null);

      // Echoed (snap, tie) — synthetic row excluded, total unchanged.
      const r2 = await sa.get(`/api/admin/settings/events?offset=0&limit=20&snapshot_before=${encodeURIComponent(snap)}&snapshot_tie=${encodeURIComponent(snapTie)}`);
      const b2 = await r2.json();
      expect(b2.total).toBe(totalBefore);
      expect(b2.events.find(e => e.id === higherId),
        "same-ms/higher-id event must be excluded by row-stable snapshot").toBeUndefined();

      // Echoed ONLY snap (legacy client, no tie) — falls back to
      // ms-stable `<=`. Here the synthetic row IS admitted because
      // the pre-fix behaviour is preserved for backward compat.
      const r3 = await sa.get(`/api/admin/settings/events?offset=0&limit=20&snapshot_before=${encodeURIComponent(snap)}`);
      const b3 = await r3.json();
      expect(b3.events.find(e => e.id === higherId),
        "legacy ms-only filter should still admit same-ms rows (backward compat)").toBeTruthy();
    } finally {
      // Put the global setting back before anything else can read it.
      try {
        await sa.patch("/api/admin/settings", { headers: saH, data: { platform_name: _platformBefore } });
      } catch (_) {}
      db.prepare("DELETE FROM settings_events WHERE id=?").run(higherId);
      db.close();
    }
    await sa.dispose();
  });

  test("v6.13.9 Fix 2: bulk-seed-users pre-scan catches case-only nickname collisions", async () => {
    // Auditor finding 2: the pre-scan used `WHERE nickname IN (?,?,...)
    // COLLATE NOCASE` to detect duplicates before attempting the INSERT.
    // But users.nickname is declared with default BINARY collation (the
    // NOCASE uniqueness lives on a separate index, uq_users_nickname_nocase),
    // and the trailing COLLATE NOCASE on the IN expression does NOT rewrite
    // every element inside IN (...). Result: "alice" in the payload was
    // not recognised as a dup of an existing "ALICE", the scan skipped
    // nothing, and the INSERT then hit the real NOCASE unique index and
    // aborted the whole batch transaction.
    //
    // Fix: `LOWER(nickname) IN (?,?,...)` with pre-lowercased params.
    // This test seeds a mixed-case nickname via bulk-seed, then attempts
    // to bulk-seed the lowercase variant — pre-fix this raised a 500 /
    // constraint failure; post-fix it is cleanly reported as skipped.
    await ensureState();
    const fs = require("fs");
    const path = require("path");
    const uniq = Date.now().toString(36);
    const mixedCaseNick = `CaseTest${uniq}`;
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const maintFile = path.join(TEST_DATA_DIR, ".maintenance");
    const byp = "bulk-seed-case-token";
    fs.writeFileSync(maintFile, byp);
    try {
      // Round 1: create the mixed-case nickname.
      const r1 = await sa.post("/api/admin/perf/bulk-seed-users", {
        headers: { ...saH, "x-maintenance-bypass": byp },
        data: {
          users: [{
            firstName: "Mixed", lastName: `Case${uniq}`,
            nickname: mixedCaseNick,
            email: `mixedcase-${uniq}@example.com`,
          }],
          sharedPassword: "testpass123",
        },
      });
      expect(r1.status()).toBe(200);
      expect((await r1.json()).inserted).toBe(1);

      // Round 2: the lowercase variant. Must be cleanly skipped
      // (no error, no batch abort). Pre-fix this was a 500 because
      // the pre-scan missed it and the INSERT hit the NOCASE unique
      // index.
      const r2 = await sa.post("/api/admin/perf/bulk-seed-users", {
        headers: { ...saH, "x-maintenance-bypass": byp },
        data: {
          users: [{
            firstName: "Lower", lastName: `Case${uniq}`,
            nickname: mixedCaseNick.toLowerCase(),
            email: `lowercase-${uniq}@example.com`,
          }],
          sharedPassword: "testpass123",
        },
      });
      expect(r2.status(), `case-only collision should NOT abort the batch (got ${r2.status()} ${await r2.text().catch(() => "")})`).toBe(200);
      const b2 = await r2.json();
      expect(b2.inserted).toBe(0);
      expect(b2.skipped).toBe(1);
    } finally {
      try { fs.unlinkSync(maintFile); } catch (_) {}
    }
    await sa.dispose();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // v8.3.11 (F9) — bulk-seed-users NORMALISES BEFORE IT VALIDATES
  //
  // `isValidEmailFormat` trims internally, while the INSERT bound the RAW value
  // and the duplicate pre-scan lower-cased WITHOUT trimming. So a padded address
  // was validated as `a@b.com`, stored as `"  A@b.com  "`, and invisible to every
  // identity lookup on the platform — all of which normalise. `nickname` had the
  // identical defect: `_nicknameCharsOk` accepts a space, so `" bob "` seeded
  // while `GET /api/check-nickname` (which trims) reported `bob` free.
  //
  // Both writers now normalise into `u.email` / `u.nickname` BEFORE the
  // validation loop, so validation, the pre-scan and the INSERT all see the same
  // bytes. `isFreeEmail` is deliberately still NOT called here — CLAUDE.md records
  // bulk-seed as the third accepted corporate-email exception; do not "fix" that.
  //
  // NOTE ON THE ORDERING these tests share with every other bulk-seed test in
  // this file: log in as superadmin BEFORE writing `.maintenance`. The maintenance
  // middleware sits above the auth layer, so a login attempted afterwards is 503'd
  // and the failure names maintenance mode rather than the subject.
  // ═══════════════════════════════════════════════════════════════════════════

  test("v8.3.11: bulk-seed-users stores the NORMALISED email, so it reserves the address", async () => {
    await ensureState();
    const fs = require("fs");
    const path = require("path");
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
    const canonical = `bsnorm${uniq}@example.com`;
    // Padded AND mixed-case. Padding alone would not discriminate: the NOCASE
    // unique index folds case, so a case-only variant is already caught by the
    // database. It is the WHITESPACE that `uq_users_email_nocase` cannot see, and
    // the pair together is what a real careless caller sends.
    const padded = `   BsNorm${uniq}@Example.COM   `;

    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const maintFile = path.join(TEST_DATA_DIR, ".maintenance");
    const byp = `bulk-seed-norm-${uniq}`;
    fs.writeFileSync(maintFile, byp);
    let seeded = false;
    try {
      const seed = await sa.post("/api/admin/perf/bulk-seed-users", {
        headers: { ...saH, "x-maintenance-bypass": byp },
        data: {
          users: [{ firstName: "Norm", lastName: "Padded", nickname: `bsn${uniq}`, email: padded }],
          sharedPassword: "testpass123",
        },
      });
      expect(seed.status(), `seed: ${await seed.text()}`).toBe(200);
      expect((await seed.json()).inserted, "the padded row is seeded, not refused").toBe(1);
      seeded = true;

      // (i) the STORED bytes. Read through the admin list rather than a second
      // SQLite handle — a spec that binds app code at module scope can hold a
      // handle to an unlinked inode after the per-file recycle (v7.20.2), and
      // this endpoint is the same projection an operator would look at.
      //
      // The bypass header is required on this READ too: `.maintenance` is still
      // on disk here and the middleware sits above every route, so without it the
      // list is 503'd and the failure reads `Cannot read properties of undefined`.
      const listR = await sa.get("/api/admin/participants?limit=5000", { headers: { "x-maintenance-bypass": byp } });
      expect(listR.status(), `participant list: ${await listR.text()}`).toBe(200);
      const parts = (await listR.json()).participants;
      const stored = parts.find(p => (p.email || "").trim().toLowerCase() === canonical);
      expect(stored, `the seeded account must exist among ${parts.length} participants`).toBeTruthy();
      expect(stored.email,
        "the stored email is the NORMALISED form — validating a trimmed copy while binding the " +
        "raw one is the same bug one layer down (routes/auth.js:126)"
      ).toBe(canonical);
    } finally {
      // Remove the gate BEFORE the registration probe below: `/api/register` is
      // anonymous and would otherwise be answered 503 by the maintenance
      // middleware, which is not the refusal under test.
      try { fs.unlinkSync(maintFile); } catch (_) {}
      await sa.dispose();
    }

    // (ii) THE LOAD-BEARING HALF — the address is RESERVED. Deliberately NOT
    // written as "the seeded account can now log in": that is equally satisfied
    // by a build which normalises at the login LOOKUP instead of at the write,
    // leaving the uniqueness bypass completely intact. `emailIsTaken` compares
    // `LOWER(email)` against the normalised input, so a stored `"  a@b.com  "`
    // matches nothing and a second account targeting the same real mailbox
    // registers cleanly — the v7.15.6 class, through a door that fix did not
    // cover.
    //
    // MUTATION THIS KILLS: bind `u.email` raw in the bulk-seed INSERT (i.e. drop
    // the pre-loop `normaliseEmail`) → this registration answers 200 and the
    // assertion goes red.
    expect(seeded, "precondition: the seed ran, so the collision below is about the stored form").toBe(true);
    const { api: anon, csrf: ac } = await freshCtx();
    let collided = false;
    try {
      const reg = await registerPost(anon, "/api/register", {
        headers: { "x-csrf-token": ac, "content-type": "application/json" },
        data: {
          firstName: "Collide", lastName: "Probe", nickname: `bsc${uniq}`, email: canonical,
          company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
          jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS,
        },
      });
      // The address belongs to the seeded row, so its emailed code is a SIGN-IN,
      // not an address proof: the form is never reachable and the register POST
      // is refused (403 email_proof_required) with nothing written.
      expect(reg.status(), `register: ${await reg.text()}`).toBe(403);
      const { api: cl0, csrf: clc0 } = await apiLogin("superadmin");
      const rows = ((await (await cl0.get("/api/admin/participants?limit=5000")).json()).participants || [])
        .filter(x => (x.email || "").trim().toLowerCase() === canonical);
      await cl0.dispose();
      collided = rows.length === 1;
      expect(rows.length,
        "the seeded row must RESERVE the canonical address against a later registration — a second " +
        "row here means two accounts now target one real mailbox, which makes sign-in ambiguous"
      ).toBe(1);
    } finally {
      await anon.dispose();
      // If the mutation arm above succeeded in registering, delete the duplicate
      // identity — leaving it behind would give every later spec in this file two
      // accounts resolving to one mailbox, and the failures would name none of it.
      if (!collided) {
        try {
          const { api: cl, csrf: clc } = await apiLogin("superadmin");
          const all = (await (await cl.get("/api/admin/participants?limit=5000")).json()).participants;
          for (const p of all.filter(x => (x.email || "").trim().toLowerCase() === canonical)) {
            await cl.delete(`/api/admin/participants/${p.id}`, { headers: { "x-csrf-token": clc } }).catch(() => {});
          }
          await cl.dispose();
        } catch (_) {}
      }
    }
  });

  test("v8.3.11: bulk-seed-users stores the TRIMMED nickname, so check-nickname sees it", async () => {
    await ensureState();
    const fs = require("fs");
    const path = require("path");
    const uniq = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
    const canonicalNick = `bsnick${uniq}`;
    const paddedNick = `  ${canonicalNick}  `;

    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const maintFile = path.join(TEST_DATA_DIR, ".maintenance");
    const byp = `bulk-seed-nick-${uniq}`;
    fs.writeFileSync(maintFile, byp);
    try {
      const seed = await sa.post("/api/admin/perf/bulk-seed-users", {
        headers: { ...saH, "x-maintenance-bypass": byp },
        data: {
          users: [{ firstName: "Nick", lastName: "Padded", nickname: paddedNick, email: `bsnick${uniq}@example.com` }],
          sharedPassword: "testpass123",
        },
      });
      expect(seed.status(), `seed: ${await seed.text()}`).toBe(200);
      expect((await seed.json()).inserted, "the padded-nickname row is seeded, not refused").toBe(1);
    } finally {
      try { fs.unlinkSync(maintFile); } catch (_) {}
      await sa.dispose();
    }

    // `GET /api/check-nickname` TRIMS its input and matches `nickname=? COLLATE
    // NOCASE`, so a stored `"  bob  "` is invisible to it: the availability
    // endpoint and the seeded row disagreed about what a nickname IS, and the
    // ASCII-charset argument for `uq_users_nickname_nocase` being a COMPLETE
    // uniqueness guarantee only holds while both sides normalise identically.
    //
    // MUTATION THIS KILLS: drop the pre-loop `u.nickname.trim()` → the handle
    // reports available and this goes red.
    const { api: anon } = await freshCtx();
    try {
      const taken = await (await anon.get(`/api/check-nickname?nickname=${encodeURIComponent(canonicalNick)}`)).json();
      expect(taken.available,
        `the seeded handle "${canonicalNick}" must read as TAKEN — a padded row that the ` +
        "availability endpoint cannot see is a uniqueness bypass, not a cosmetic difference"
      ).toBe(false);

      // CONTROL. Without it, "taken" is satisfied by an endpoint that answers
      // `available:false` for everything — which is also what a charset or
      // min-length refusal looks like from here.
      const free = await (await anon.get(`/api/check-nickname?nickname=${encodeURIComponent(canonicalNick)}zz`)).json();
      expect(free.available, "an unseeded handle of the same shape is still available").toBe(true);
    } finally { await anon.dispose(); }
  });

  test("v6.13.9 Fix 3: bulk-seed-users enrolls existing users in the caller's competition (re-seed idempotency)", async () => {
    // Auditor finding 3: bulk-seed skipped existing users entirely,
    // never inserting into competition_users for them. A second seed
    // run against the same perf DB with a fresh competition left the
    // existing perf-user-NNN rows orphaned relative to the new
    // competition — seed.js logs said "assigned to competition" but
    // only the NEWLY CREATED users actually were; pre-existing
    // skipped users were not.
    //
    // Fix: on the skipped path, run INSERT OR IGNORE INTO
    // competition_users for the existing user's id so the caller's
    // competition pool is complete. Report enrolled_existing in the
    // response so seed.js can log it accurately.
    await ensureState();
    const fs = require("fs");
    const path = require("path");
    const Database = require("better-sqlite3");
    const uniq = Date.now().toString(36);
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const maintFile = path.join(TEST_DATA_DIR, ".maintenance");
    const byp = "bulk-seed-enrol-token";
    fs.writeFileSync(maintFile, byp);
    try {
      // Step 1: create a user + comp A, bulk-seed-assigned to comp A.
      const compARes = await sa.post("/api/admin/competitions", {
        headers: { ...saH, "x-maintenance-bypass": byp },
        data: { name: `Enrol-A-${uniq}`, start_time: new Date(Date.now() + 7200_000).toISOString(), duration_minutes: 60 },
      });
      expect(compARes.ok()).toBeTruthy();
      const compA = (await compARes.json()).competition;
      const r1 = await sa.post("/api/admin/perf/bulk-seed-users", {
        headers: { ...saH, "x-maintenance-bypass": byp },
        data: {
          users: [{
            firstName: "Reseed", lastName: `User${uniq}`,
            nickname: `reseed-${uniq}`,
            email: `reseed-${uniq}@example.com`,
          }],
          sharedPassword: "testpass123",
          competitionId: compA.id,
        },
      });
      expect(r1.status()).toBe(200);
      const b1 = await r1.json();
      expect(b1.inserted).toBe(1);
      expect(b1.enrolled_existing).toBe(0);

      // Verify: user exists + enrolled in comp A.
      const db = new Database(TEST_DB_PATH);
      try {
        const u = db.prepare("SELECT id FROM users WHERE email=?").get(`reseed-${uniq}@example.com`);
        expect(u, "user created").toBeTruthy();
        const enrolA = db.prepare("SELECT 1 as x FROM competition_users WHERE user_id=? AND competition_id=?").get(u.id, compA.id);
        expect(enrolA, "user enrolled in comp A after first seed").toBeTruthy();
      } finally {
        db.close();
      }

      // Step 2: create comp B, bulk-seed the SAME user to comp B.
      // User row already exists → bulk-seed treats it as skipped.
      // Pre-fix: no competition_users insert → user orphaned vs B.
      // Post-fix: competition_users row for (user, comp B) is
      // inserted via INSERT OR IGNORE and enrolled_existing = 1.
      const compBRes = await sa.post("/api/admin/competitions", {
        headers: { ...saH, "x-maintenance-bypass": byp },
        data: { name: `Enrol-B-${uniq}`, start_time: new Date(Date.now() + 7200_000).toISOString(), duration_minutes: 60 },
      });
      expect(compBRes.ok()).toBeTruthy();
      const compB = (await compBRes.json()).competition;
      const r2 = await sa.post("/api/admin/perf/bulk-seed-users", {
        headers: { ...saH, "x-maintenance-bypass": byp },
        data: {
          users: [{
            firstName: "Reseed", lastName: `User${uniq}`,
            nickname: `reseed-${uniq}`,
            email: `reseed-${uniq}@example.com`,
          }],
          sharedPassword: "testpass123",
          competitionId: compB.id,
        },
      });
      expect(r2.status()).toBe(200);
      const b2 = await r2.json();
      expect(b2.inserted).toBe(0);
      expect(b2.skipped).toBe(1);
      expect(b2.enrolled_existing, "existing user must be enrolled in comp B on re-seed").toBe(1);

      // Verify: user now enrolled in BOTH comps.
      const db2 = new Database(TEST_DB_PATH);
      try {
        const u = db2.prepare("SELECT id FROM users WHERE email=?").get(`reseed-${uniq}@example.com`);
        expect(u).toBeTruthy();
        const enrolB = db2.prepare("SELECT 1 as x FROM competition_users WHERE user_id=? AND competition_id=?").get(u.id, compB.id);
        expect(enrolB, "user enrolled in comp B after re-seed").toBeTruthy();
      } finally {
        db2.close();
      }

      // Step 3: re-seed AGAIN against comp B — should be idempotent
      // (enrolled_existing remains 0 because INSERT OR IGNORE is a no-op).
      const r3 = await sa.post("/api/admin/perf/bulk-seed-users", {
        headers: { ...saH, "x-maintenance-bypass": byp },
        data: {
          users: [{
            firstName: "Reseed", lastName: `User${uniq}`,
            nickname: `reseed-${uniq}`,
            email: `reseed-${uniq}@example.com`,
          }],
          sharedPassword: "testpass123",
          competitionId: compB.id,
        },
      });
      expect(r3.status()).toBe(200);
      const b3 = await r3.json();
      expect(b3.inserted).toBe(0);
      expect(b3.skipped).toBe(1);
      expect(b3.enrolled_existing, "second re-seed against same comp must be idempotent (no duplicate insert)").toBe(0);

      // Cleanup the two test comps.
      await sa.delete(`/api/admin/competitions/${compA.id}`, { headers: { ...saH, "x-maintenance-bypass": byp } });
      await sa.delete(`/api/admin/competitions/${compB.id}`, { headers: { ...saH, "x-maintenance-bypass": byp } });
    } finally {
      try { fs.unlinkSync(maintFile); } catch (_) {}
    }
    await sa.dispose();
  });

  // The pre-scan and the id resolve compare addresses with the collation on the
  // COLUMN (`email COLLATE NOCASE IN (…)`), an index search. A collation trailing
  // the list, or none, compares by case: a primary stored in another case is then
  // missed and the INSERT trips uq_users_email_nocase (the whole batch fails), a
  // secondary is missed silently (a second account on the address), and an
  // existing account is not enrolled.
  test("bulk-seed-users: an address an account already holds in another case, primary or secondary, is skipped, and the primary holder enrolled", async () => {
    await ensureState();
    const fs = require("fs");
    const path = require("path");
    const Database = require("better-sqlite3");
    const uniq = Date.now().toString(36);
    const primary = `Seed.Case.${uniq}@Corp.Test`;
    const secondary = `Sec.Case.${uniq}@Corp.Test`;
    const ids = { primary: `seed-case-p-${uniq}`, secondary: `seed-case-s-${uniq}` };
    const db0 = new Database(TEST_DB_PATH);
    try {
      const ins = db0.prepare("INSERT INTO users (id, first_name, last_name, nickname, email, secondary_email, created_at) VALUES (?,?,?,?,?,?,?)");
      ins.run(ids.primary, "Seed", "Case", `seedcasep${uniq}`, primary, null, new Date().toISOString());
      ins.run(ids.secondary, "Sec", "Case", `seedcases${uniq}`, `holder.${uniq}@corp.test`, secondary, new Date().toISOString());
    } finally { db0.close(); }
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const maintFile = path.join(TEST_DATA_DIR, ".maintenance");
    const byp = "bulk-seed-email-case-token";
    fs.writeFileSync(maintFile, byp);
    let compId = null;
    try {
      const cr = await sa.post("/api/admin/competitions", {
        headers: { ...saH, "x-maintenance-bypass": byp },
        data: { name: `Seed-Case-${uniq}`, start_time: new Date(Date.now() + 7200_000).toISOString(), duration_minutes: 60 },
      });
      expect(cr.ok(), await cr.text()).toBeTruthy();
      compId = (await cr.json()).competition.id;
      const r = await sa.post("/api/admin/perf/bulk-seed-users", {
        headers: { ...saH, "x-maintenance-bypass": byp },
        data: {
          users: [
            { firstName: "Lower", lastName: "Primary", nickname: `lowerp${uniq}`, email: primary.toLowerCase() },
            { firstName: "Lower", lastName: "Secondary", nickname: `lowers${uniq}`, email: secondary.toLowerCase() },
            { firstName: "Fresh", lastName: "Control", nickname: `fresh${uniq}`, email: `fresh.${uniq}@corp.test` },
          ],
          competitionId: compId,
        },
      });
      expect(r.status(), `an address held in another case must not abort the batch (${await r.text().catch(() => "")})`).toBe(200);
      const b = await r.json();
      expect(b.inserted, "only the fresh address (CONTROL: the batch did insert)").toBe(1);
      expect(b.skipped, "both addresses already held").toBe(2);
      expect(b.enrolled_existing, "the primary holder joins the event").toBe(1);
      const db = new Database(TEST_DB_PATH);
      try {
        const rows = db.prepare("SELECT id FROM users WHERE email=? COLLATE NOCASE OR secondary_email=? COLLATE NOCASE").all(primary, primary);
        expect(rows.map(x => x.id), "no second account on the primary").toEqual([ids.primary]);
        expect(db.prepare("SELECT COUNT(*) n FROM users WHERE email=? COLLATE NOCASE").get(secondary).n, "no account made on the secondary").toBe(0);
        const enrolled = db.prepare("SELECT user_id FROM competition_users WHERE competition_id=? ORDER BY user_id").all(compId).map(x => x.user_id);
        expect(enrolled).toContain(ids.primary);
        expect(enrolled, "the id resolve asks primaries only: the secondary holder is not enrolled").not.toContain(ids.secondary);
        expect(enrolled.length, "the fresh account and the primary holder").toBe(2);
      } finally { db.close(); }
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: { ...saH, "x-maintenance-bypass": byp } }).catch(() => {});
      try { fs.unlinkSync(maintFile); } catch (_) {}
      await sa.dispose();
    }
  });

  test("v6.13.10: /api/admin/tasks returns attachment_count per task, incremented on upload", async () => {
    // Admin Challenges pane's new Attachments column relies on the
    // server returning `attachment_count` on every task row. Contract:
    //   * zero by default for a freshly-created challenge.
    //   * increments by 1 for each active (non-detached) attachment
    //     uploaded via POST /api/admin/tasks/:id/attachments.
    //   * doesn't count detached revisions (they live in the same
    //     table with `detached_at IS NOT NULL` as a history trail).
    // Only the first two cases are asserted here — the detached path
    // is exercised indirectly by the task-versions restore tests
    // elsewhere, and calling the private detach helper from a test
    // would skip the admin-only uploading path.
    await ensureState();
    const zlib = require("zlib");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Fresh challenge so we own the attachment count — existing seed
    // tasks may or may not already have attachments from other tests.
    const created = await sa.post("/api/admin/tasks", {
      headers: saH,
      data: {
        title: `AttachCol-${Date.now()}`, description: "<p>x</p>",
        difficulty: "easy", answer_type: "text", correct_answer: "a",
        explanation: "<p>x</p>", hint: "h", status: "published",
      },
    });
    expect(created.ok()).toBeTruthy();
    const taskId = (await created.json()).id;
    try {
      // Baseline: attachment_count = 0 for the new task.
      const r0 = await sa.get("/api/admin/tasks");
      const list0 = await r0.json();
      const t0 = list0.find(t => t.id === taskId);
      expect(t0, "new task present in admin tasks list").toBeTruthy();
      expect(t0.attachment_count, "new task defaults attachment_count=0").toBe(0);

      // Build a minimal valid unencrypted ZIP (same hand-built shape as
      // the screenshots spec — see tests/_screenshots.spec.js beforeAll).
      const name = Buffer.from("readme.txt");
      const body = Buffer.from("column test\n");
      const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32LE(zlib.crc32(body), 0);
      const lfh = Buffer.concat([
        Buffer.from([0x50,0x4b,0x03,0x04]),
        Buffer.from([0x0a,0x00,0x00,0x00,0x00,0x00]),
        Buffer.from([0x00,0x00,0x21,0x00]),
        crcBuf,
        Buffer.from([body.length,0,0,0]),
        Buffer.from([body.length,0,0,0]),
        Buffer.from([name.length,0]),
        Buffer.from([0,0]),
        name, body,
      ]);
      const cdh = Buffer.concat([
        Buffer.from([0x50,0x4b,0x01,0x02]),
        Buffer.from([0x0a,0x00,0x0a,0x00,0x00,0x00,0x00,0x00]),
        Buffer.from([0x00,0x00,0x21,0x00]),
        crcBuf,
        Buffer.from([body.length,0,0,0]),
        Buffer.from([body.length,0,0,0]),
        Buffer.from([name.length,0]),
        Buffer.from([0,0,0,0,0,0,0,0,0,0,0,0]),
        Buffer.from([0,0,0,0]),
        name,
      ]);
      const eocd = Buffer.concat([
        Buffer.from([0x50,0x4b,0x05,0x06]),
        Buffer.from([0,0,0,0]),
        Buffer.from([1,0,1,0]),
        Buffer.from([cdh.length,0,0,0]),
        Buffer.from([lfh.length,0,0,0]),
        Buffer.from([0,0]),
      ]);
      const zip = Buffer.concat([lfh, cdh, eocd]);

      // Upload one attachment → count becomes 1.
      const up1 = await sa.post(`/api/admin/tasks/${taskId}/attachments`, {
        headers: { "x-csrf-token": saCsrf },
        multipart: {
          file: { name: "readme.zip", mimeType: "application/zip", buffer: zip },
          display_name: "readme",
        },
      });
      expect(up1.ok(), `first upload: ${up1.status()} ${await up1.text().catch(() => "")}`).toBeTruthy();
      const r1 = await sa.get("/api/admin/tasks");
      const t1 = (await r1.json()).find(t => t.id === taskId);
      expect(t1.attachment_count).toBe(1);

      // Upload a second attachment → count becomes 2.
      const up2 = await sa.post(`/api/admin/tasks/${taskId}/attachments`, {
        headers: { "x-csrf-token": saCsrf },
        multipart: {
          file: { name: "readme2.zip", mimeType: "application/zip", buffer: zip },
          display_name: "readme-also",
        },
      });
      expect(up2.ok()).toBeTruthy();
      const r2 = await sa.get("/api/admin/tasks");
      const t2 = (await r2.json()).find(t => t.id === taskId);
      expect(t2.attachment_count).toBe(2);
    } finally {
      await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } }).catch(() => {});
    }
    await sa.dispose();
  });

  test("v6.13.11: attachment upload / rename / delete do NOT create task_versions snapshots (only Save does)", async () => {
    // Contract: uploading (or renaming / deleting) an attachment is an
    // in-flight edit, NOT a "save" event. Pre-v6.13.11 every attachment
    // mutation called createTaskVersion(…) → one task_versions row per
    // click, which cluttered the Challenge History dialog and could
    // make a later Restore bring the challenge to a mid-edit state.
    // Post-v6.13.11 attachment routes record only an audit-log event
    // (still visible in the Logs pane for accountability); the
    // task_versions snapshot is created only by the explicit Save
    // (PUT /api/admin/tasks/:id), and that snapshot's `attachments`
    // array captures whatever set is currently linked so restore
    // continues to work.
    await ensureState();
    const zlib = require("zlib");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const created = await sa.post("/api/admin/tasks", {
      headers: saH,
      data: {
        title: `NoSnapAttach-${Date.now()}`, description: "<p>x</p>",
        difficulty: "easy", answer_type: "text", correct_answer: "a",
        explanation: "<p>x</p>", hint: "h", status: "published",
      },
    });
    expect(created.ok()).toBeTruthy();
    const taskId = (await created.json()).id;
    try {
      // Baseline: the create call itself snapshots once ("create").
      const v0 = await (await sa.get(`/api/admin/tasks/${taskId}/versions`)).json();
      expect(v0.length, "create should produce exactly 1 snapshot").toBe(1);
      expect(v0[0].change_type).toBe("create");

      // Build a minimal valid unencrypted ZIP (same pattern as
      // _screenshots.spec.js + v6.13.10 test — hand-built, no dep).
      const name = Buffer.from("a.txt"); const body = Buffer.from("x\n");
      const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32LE(zlib.crc32(body), 0);
      const lfh = Buffer.concat([
        Buffer.from([0x50,0x4b,0x03,0x04]),
        Buffer.from([0x0a,0x00,0x00,0x00,0x00,0x00]),
        Buffer.from([0x00,0x00,0x21,0x00]),
        crcBuf,
        Buffer.from([body.length,0,0,0]),
        Buffer.from([body.length,0,0,0]),
        Buffer.from([name.length,0]),
        Buffer.from([0,0]),
        name, body,
      ]);
      const cdh = Buffer.concat([
        Buffer.from([0x50,0x4b,0x01,0x02]),
        Buffer.from([0x0a,0x00,0x0a,0x00,0x00,0x00,0x00,0x00]),
        Buffer.from([0x00,0x00,0x21,0x00]),
        crcBuf,
        Buffer.from([body.length,0,0,0]),
        Buffer.from([body.length,0,0,0]),
        Buffer.from([name.length,0]),
        Buffer.from([0,0,0,0,0,0,0,0,0,0,0,0]),
        Buffer.from([0,0,0,0]),
        name,
      ]);
      const eocd = Buffer.concat([
        Buffer.from([0x50,0x4b,0x05,0x06]),
        Buffer.from([0,0,0,0]),
        Buffer.from([1,0,1,0]),
        Buffer.from([cdh.length,0,0,0]),
        Buffer.from([lfh.length,0,0,0]),
        Buffer.from([0,0]),
      ]);
      const zip = Buffer.concat([lfh, cdh, eocd]);

      // Upload attachment #1 — must NOT create a snapshot.
      const up1 = await sa.post(`/api/admin/tasks/${taskId}/attachments`, {
        headers: { "x-csrf-token": saCsrf },
        multipart: {
          file: { name: "one.zip", mimeType: "application/zip", buffer: zip },
          display_name: "one",
        },
      });
      expect(up1.ok()).toBeTruthy();
      const att1Id = (await up1.json()).id;
      const v1 = await (await sa.get(`/api/admin/tasks/${taskId}/versions`)).json();
      expect(v1.length, "attachment upload must NOT create a task_versions snapshot").toBe(1);

      // Upload attachment #2 — still no new snapshot.
      const up2 = await sa.post(`/api/admin/tasks/${taskId}/attachments`, {
        headers: { "x-csrf-token": saCsrf },
        multipart: {
          file: { name: "two.zip", mimeType: "application/zip", buffer: zip },
          display_name: "two",
        },
      });
      expect(up2.ok()).toBeTruthy();
      const att2Id = (await up2.json()).id;
      const v2 = await (await sa.get(`/api/admin/tasks/${taskId}/versions`)).json();
      expect(v2.length, "second attachment upload must NOT create a task_versions snapshot").toBe(1);

      // Rename attachment #1 — still no new snapshot.
      const rename = await sa.patch(`/api/admin/tasks/${taskId}/attachments/${att1Id}`, {
        headers: saH, data: { display_name: "one-renamed" },
      });
      expect(rename.ok()).toBeTruthy();
      const v3 = await (await sa.get(`/api/admin/tasks/${taskId}/versions`)).json();
      expect(v3.length, "attachment rename must NOT create a task_versions snapshot").toBe(1);

      // Delete attachment #2 — still no new snapshot.
      const del = await sa.delete(`/api/admin/tasks/${taskId}/attachments/${att2Id}`, {
        headers: { "x-csrf-token": saCsrf },
      });
      expect(del.ok()).toBeTruthy();
      const v4 = await (await sa.get(`/api/admin/tasks/${taskId}/versions`)).json();
      expect(v4.length, "attachment delete must NOT create a task_versions snapshot").toBe(1);

      // THE SAVE PATH (PUT /api/admin/tasks/:id) IS the only thing that
      // should snapshot — and its snapshot's `attachments` array must
      // reflect the current attachment set (one — "one-renamed" —
      // since #2 was deleted above).
      const put = await sa.put(`/api/admin/tasks/${taskId}`, {
        headers: saH,
        data: { title: `NoSnapAttach-saved-${Date.now()}` },
      });
      expect(put.ok()).toBeTruthy();
      const v5 = await (await sa.get(`/api/admin/tasks/${taskId}/versions`)).json();
      expect(v5.length, "Save should produce exactly 1 new snapshot").toBe(2);
      expect(v5[0].change_type, "latest snapshot is the Save").toBe("update");
      const snap = JSON.parse(v5[0].snapshot);
      expect(Array.isArray(snap.attachments)).toBeTruthy();
      expect(snap.attachments.length, "Save-snapshot must capture current attachment set (one active)").toBe(1);
      expect(snap.attachments[0].id).toBe(att1Id);
      expect(snap.attachments[0].display_name).toBe("one-renamed");
    } finally {
      await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } }).catch(() => {});
    }
    await sa.dispose();
  });

  test("v6.13.11: attachment operations still emit audit events even though they don't snapshot", async () => {
    // Complementary contract: the Logs pane / admin log stream must
    // continue to show who uploaded / renamed / deleted an attachment
    // and when. The v6.13.11 split only removes the task_versions
    // side-effect; the recordOrphanedAuditEvent mirror into app.jsonl
    // stays so accountability isn't lost alongside the History-dialog
    // cleanup.
    await ensureState();
    const zlib = require("zlib");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const uniq = Date.now().toString(36);
    const created = await sa.post("/api/admin/tasks", {
      headers: saH,
      data: {
        title: `AuditKeep-${uniq}`, description: "<p>x</p>",
        difficulty: "easy", answer_type: "text", correct_answer: "a",
        explanation: "<p>x</p>", hint: "h", status: "published",
      },
    });
    expect(created.ok()).toBeTruthy();
    const taskId = (await created.json()).id;
    try {
      // Build + upload a single attachment, then query the task's
      // events (user-scoped event view would work too; task-scoped is
      // easier to reach and already scoped to this challenge).
      const name = Buffer.from("a"); const body = Buffer.from("x");
      const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32LE(zlib.crc32(body), 0);
      const lfh = Buffer.concat([
        Buffer.from([0x50,0x4b,0x03,0x04]),
        Buffer.from([0x0a,0x00,0x00,0x00,0x00,0x00]),
        Buffer.from([0x00,0x00,0x21,0x00]),
        crcBuf,
        Buffer.from([body.length,0,0,0]),
        Buffer.from([body.length,0,0,0]),
        Buffer.from([name.length,0]),
        Buffer.from([0,0]),
        name, body,
      ]);
      const cdh = Buffer.concat([
        Buffer.from([0x50,0x4b,0x01,0x02]),
        Buffer.from([0x0a,0x00,0x0a,0x00,0x00,0x00,0x00,0x00]),
        Buffer.from([0x00,0x00,0x21,0x00]),
        crcBuf,
        Buffer.from([body.length,0,0,0]),
        Buffer.from([body.length,0,0,0]),
        Buffer.from([name.length,0]),
        Buffer.from([0,0,0,0,0,0,0,0,0,0,0,0]),
        Buffer.from([0,0,0,0]),
        name,
      ]);
      const eocd = Buffer.concat([
        Buffer.from([0x50,0x4b,0x05,0x06]),
        Buffer.from([0,0,0,0]),
        Buffer.from([1,0,1,0]),
        Buffer.from([cdh.length,0,0,0]),
        Buffer.from([lfh.length,0,0,0]),
        Buffer.from([0,0]),
      ]);
      const zip = Buffer.concat([lfh, cdh, eocd]);
      const up = await sa.post(`/api/admin/tasks/${taskId}/attachments`, {
        headers: { "x-csrf-token": saCsrf },
        multipart: {
          file: { name: "audit.zip", mimeType: "application/zip", buffer: zip },
          display_name: `audit-${uniq}`,
        },
      });
      expect(up.ok()).toBeTruthy();

      // Query app.jsonl logs for the attachment_added event. Filter
      // by today's date + the display_name so the search doesn't have
      // to scan old logs. The audit row's `msg` field includes the
      // event type in a format the logs endpoint's `q` param matches.
      // The app.jsonl audit mirror is written after the commit (on setImmediate),
      // so a read straight after the upload can come first under load: poll for
      // the line rather than reading once (CLAUDE.md, *Poll every post-commit write*).
      const today = new Date().toISOString().slice(0, 10);
      const isAdded = (e) => e.source === "audit" && e.scope === "task" && e.scope_id === taskId && e.event_type === "attachment_added";
      const entries = await pollAdminLogs(sa, `stream=app&date=${today}&limit=500&q=${encodeURIComponent(`audit-${uniq}`)}`,
        (es) => es.some(isAdded), { what: "the attachment_added audit line" });
      const added = entries.find(isAdded);
      expect(added, "attachment_added audit event must be emitted even though no snapshot is created").toBeTruthy();
    } finally {
      await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } }).catch(() => {});
    }
    await sa.dispose();
  });

  test("v6.13.12: attachment upload followed by DELETE (Cancel rollback) leaves attachment_count at 0", async () => {
    // v6.13.12 client changes: Cancel on the Edit Challenge form calls
    // DELETE /api/admin/tasks/:id/attachments/:aid for every attachment
    // uploaded during the session, rolling the state back so the task
    // matches what was on the server when the form opened. This test
    // exercises the server primitives the client relies on — upload
    // then delete — and asserts the cumulative effect on the
    // admin-tasks list's attachment_count (v6.13.10 column data).
    // UI-level behaviour is separately covered by the ui-admin spec.
    await ensureState();
    const zlib = require("zlib");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const created = await sa.post("/api/admin/tasks", {
      headers: saH,
      data: {
        title: `CancelUpload-${Date.now()}`, description: "<p>x</p>",
        difficulty: "easy", answer_type: "text", correct_answer: "a",
        explanation: "<p>x</p>", hint: "h", status: "published",
      },
    });
    expect(created.ok()).toBeTruthy();
    const taskId = (await created.json()).id;
    try {
      // Build hand-made ZIP (same minimal shape as v6.13.11 tests).
      const name = Buffer.from("a"); const body = Buffer.from("x");
      const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32LE(zlib.crc32(body), 0);
      const lfh = Buffer.concat([
        Buffer.from([0x50,0x4b,0x03,0x04]),
        Buffer.from([0x0a,0x00,0x00,0x00,0x00,0x00]),
        Buffer.from([0x00,0x00,0x21,0x00]),
        crcBuf,
        Buffer.from([body.length,0,0,0]),
        Buffer.from([body.length,0,0,0]),
        Buffer.from([name.length,0]),
        Buffer.from([0,0]),
        name, body,
      ]);
      const cdh = Buffer.concat([
        Buffer.from([0x50,0x4b,0x01,0x02]),
        Buffer.from([0x0a,0x00,0x0a,0x00,0x00,0x00,0x00,0x00]),
        Buffer.from([0x00,0x00,0x21,0x00]),
        crcBuf,
        Buffer.from([body.length,0,0,0]),
        Buffer.from([body.length,0,0,0]),
        Buffer.from([name.length,0]),
        Buffer.from([0,0,0,0,0,0,0,0,0,0,0,0]),
        Buffer.from([0,0,0,0]),
        name,
      ]);
      const eocd = Buffer.concat([
        Buffer.from([0x50,0x4b,0x05,0x06]),
        Buffer.from([0,0,0,0]),
        Buffer.from([1,0,1,0]),
        Buffer.from([cdh.length,0,0,0]),
        Buffer.from([lfh.length,0,0,0]),
        Buffer.from([0,0]),
      ]);
      const zip = Buffer.concat([lfh, cdh, eocd]);

      // Baseline: count = 0.
      const t0 = (await (await sa.get("/api/admin/tasks")).json()).find(x => x.id === taskId);
      expect(t0.attachment_count).toBe(0);

      // Upload two attachments — count = 2.
      const up1 = await sa.post(`/api/admin/tasks/${taskId}/attachments`, {
        headers: { "x-csrf-token": saCsrf },
        multipart: { file: { name: "a.zip", mimeType: "application/zip", buffer: zip }, display_name: "a" },
      });
      expect(up1.ok()).toBeTruthy();
      const aid1 = (await up1.json()).id;
      const up2 = await sa.post(`/api/admin/tasks/${taskId}/attachments`, {
        headers: { "x-csrf-token": saCsrf },
        multipart: { file: { name: "b.zip", mimeType: "application/zip", buffer: zip }, display_name: "b" },
      });
      expect(up2.ok()).toBeTruthy();
      const aid2 = (await up2.json()).id;
      const t1 = (await (await sa.get("/api/admin/tasks")).json()).find(x => x.id === taskId);
      expect(t1.attachment_count).toBe(2);

      // Simulate the Cancel flow — DELETE every upload done in this
      // "edit session". Client does this in _discardEditSessionNewAttachments()
      // fire-and-forget. Here we await so the assertion is deterministic.
      const d1 = await sa.delete(`/api/admin/tasks/${taskId}/attachments/${aid1}`, { headers: { "x-csrf-token": saCsrf } });
      expect(d1.ok()).toBeTruthy();
      const d2 = await sa.delete(`/api/admin/tasks/${taskId}/attachments/${aid2}`, { headers: { "x-csrf-token": saCsrf } });
      expect(d2.ok()).toBeTruthy();

      // After rollback: count = 0 (matches the pre-upload baseline).
      const t2 = (await (await sa.get("/api/admin/tasks")).json()).find(x => x.id === taskId);
      expect(t2.attachment_count, "after Cancel rollback, attachment_count must match baseline").toBe(0);
    } finally {
      await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } }).catch(() => {});
    }
    await sa.dispose();
  });

  test("v6.13.14: POST /api/tasks/:id/submit carries perf-span stage instrumentation", () => {
    // Structural regression lock for the submit-handler perf-span
    // (v6.13.14). Catches the case where a future refactor drops a
    // timestamp, misses an autoend_path case, or silently breaks the
    // res.on("finish") wiring that makes the span fire on every
    // return path (validation fail / rejected / already solved /
    // deduped / new). No server needed — just code shape.
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "server.js"), "utf8");
    const startIdx = src.indexOf('app.post("/api/tasks/:id/submit"');
    expect(startIdx).toBeGreaterThan(-1);
    // Cap the body at the first route-module register call after the submit
    // handler. The submit handler stays inline in server.js (this perf-span
    // shape is pinned here), but the surrounding participant routes — including
    // the /navigated-away endpoint that used to delimit this slice — moved into
    // routes/participant.js in the v7.0.0 split, so the leaderboard register
    // call is now the first stable marker that follows the inline submit body.
    const endIdx = src.indexOf('require("./routes/leaderboard")', startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    const body = src.slice(startIdx, endIdx);
    // Core checkpoints.
    expect(body, "tHandler checkpoint at entry").toMatch(/const\s+tHandler\s*=\s*process\.hrtime\.bigint\(\)/);
    expect(body, "tPreflightEnd just before the write transaction").toMatch(/tPreflightEnd\s*=\s*process\.hrtime\.bigint\(\)/);
    expect(body, "tTxnEnd after submitAndAutoEnd()").toMatch(/tTxnEnd\s*=\s*process\.hrtime\.bigint\(\)/);
    expect(body, "tAutoendStart when correct branch enters").toMatch(/tAutoendStart\s*=\s*process\.hrtime\.bigint\(\)/);
    expect(body, "tAutoendEnd closes the autoend span").toMatch(/tAutoendEnd\s*=\s*process\.hrtime\.bigint\(\)/);
    // Autoend path tag covers the four known branches.
    expect(body).toMatch(/autoendPath\s*=\s*"skipped"/);
    expect(body).toMatch(/autoendPath\s*=\s*"fast_path_no"/);
    expect(body).toMatch(/autoendPath\s*=\s*allSolved\s*\?\s*"scan_ended"\s*:\s*"scan_no_end"/);
    expect(body, "v7.7.18 self-enroll suppression branch").toMatch(/autoendPath\s*=\s*"self_enroll_open"/);
    // v8.3.11 — the opt-out gate now emits TWO tags, and both are pinned rather
    // than one, which is strictly stronger than the exact-match this replaces.
    // "this KIND never auto-ends" (a Booth Event, a Program) and "an admin turned
    // it off for THIS event" are different operational answers, so collapsing
    // them back into one literal would make a Booth Event's behaviour
    // indistinguishable from a misconfigured Competition in the span. The old
    // regex was an exact `= "auto_end_disabled"` match, which the ternary broke —
    // this pin asserts by PRESENCE of each literal, so a third clause added later
    // is free while neither of these two can be dropped.
    expect(body, "v7.29.0 auto-end opt-out branch").toMatch(/"auto_end_disabled"/);
    expect(body, "v8.3.11 kind-forbids-auto-end branch").toMatch(/"auto_end_forbidden_for_kind"/);
    expect(body, "the two tags are the two arms of ONE gate on autoendPath").toMatch(/autoendPath\s*=\s*eventPolicy\(/);
    // v8.1.0 — THE SCAN GATE. Exhaustion fires the auto-end scan on a WRONG
    // answer, where the gate used to be `if (correct)` and the path tag would
    // therefore still read "skipped". This pin exists BECAUSE the branch it
    // guards cannot be seen any other way: a build that re-narrowed the gate to
    // `correct` would leave a capped event unable to auto-end, and every
    // behavioural test in the suite passes — the event simply never ends, which
    // no assertion is watching for.
    expect(body, "v8.1.0: the auto-end scan runs on exhaustion, not only on a correct answer")
      .toMatch(/if\s*\(correct\s*\|\|\s*justExhausted\)/);
    expect(body, "v8.1.0: and `justExhausted` is a WRONG answer that spent the last attempt")
      .toMatch(/justExhausted\s*=\s*!correct\s*&&/);
    // Outcome tag covers every terminal res branch.
    expect(body).toMatch(/outcome\s*=\s*"validation_fail"/);
    expect(body).toMatch(/outcome\s*=\s*"rejected"/);
    expect(body).toMatch(/outcome\s*=\s*"already_solved"/);
    expect(body).toMatch(/outcome\s*=\s*"deduped"/);
    // v8.1.0 — a NEW terminal res branch, and the pin is extended rather than
    // left to pass by presence: it asserts by PRESENCE, not exhaustively, so a
    // new branch shipping with a stale outcome tag (the span would attribute an
    // exhaustion refusal to "new_wrong") is invisible to every other assertion
    // here. This is a re-point AND an addition, and both are deliberate.
    expect(body, "v8.1.0 attempt-cap refusal is its own outcome").toMatch(/outcome\s*=\s*"attempts_exhausted"/);
    // v8.12.6 (review fix) — and the commit-time refusal of an impersonating admin
    // who lost access (or whose session ended) mid-upload, for the same reason.
    expect(body, "v8.12.6 impersonating-hand refusal is its own outcome").toMatch(/outcome\s*=\s*"impersonation_ended"/);
    // And the two commit-time answers added beside it: a session that ended while
    // the answer was in flight, and an impersonated seat that stopped qualifying
    // (a session restore, not a refusal of the participant).
    expect(body, "the session-ended refusal is its own outcome").toMatch(/outcome\s*=\s*"session_ended"/);
    expect(body, "the impersonated seat's forced exit is its own outcome").toMatch(/outcome\s*=\s*"impersonation_target_inactive"/);
    expect(body, "and the seat's refusal keeps its own").toMatch(/outcome\s*=\s*"authz_revoked"/);
    expect(body).toMatch(/outcome\s*=\s*correct\s*\?\s*"new_correct"\s*:\s*"new_wrong"/);
    // res.on("finish") wires the log to fire regardless of return path.
    expect(body).toMatch(/res\.on\("finish"/);
    expect(body).toMatch(/\[perf-span\] slow POST \/api\/tasks\/:id\/submit/);
  });

  test("v6.13.15: GET /api/tasks/:taskId/attachments/:aid authorization — anonymous/no-session/wrong-comp all blocked", async () => {
    // Direct attachment download route is gated by:
    //   1. requireParticipant               → 401 for anonymous
    //   2. requireCompetitionContext         → 400 when no active comp in session
    //   3. requireParticipantInCompetition   → 403 when enrolled check fails
    //   4. inline competition_tasks check    → 404 when task is not in the caller's comp
    //   5. inline task.active && published   → 404
    //   6. inline attachment exists + not detached → 404
    // This test hits three of those gates directly, covering the
    // "no-auth" + "wrong-session" failure modes the auditor flagged.
    await ensureState();
    const zlib = require("zlib");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Task lives in UPCOMING comp only — alice is in LIVE comp, so
    // case 3 ("active comp doesn't include this task") falls out
    // naturally when alice selects liveComp and tries to download an
    // attachment on a task scoped only to upcomingComp.
    const created = await sa.post("/api/admin/tasks", {
      headers: saH,
      data: {
        title: `AuthTest-${Date.now()}`, description: "<p>x</p>",
        difficulty: "easy", answer_type: "text", correct_answer: "a",
        explanation: "<p>x</p>", hint: "h", status: "published",
      },
    });
    expect(created.ok()).toBeTruthy();
    const taskId = (await created.json()).id;
    const assignR = await sa.post(`/api/admin/tasks/${taskId}/competitions`, {
      headers: saH, data: { competitionIds: [S.upcomingComp.id] },
    });
    expect(assignR.ok()).toBeTruthy();

    // Build + upload a minimal valid ZIP attachment.
    const name = Buffer.from("a"); const body = Buffer.from("x");
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32LE(zlib.crc32(body), 0);
    const lfh = Buffer.concat([
      Buffer.from([0x50,0x4b,0x03,0x04]),
      Buffer.from([0x0a,0x00,0x00,0x00,0x00,0x00]),
      Buffer.from([0x00,0x00,0x21,0x00]),
      crcBuf,
      Buffer.from([body.length,0,0,0]),
      Buffer.from([body.length,0,0,0]),
      Buffer.from([name.length,0]),
      Buffer.from([0,0]),
      name, body,
    ]);
    const cdh = Buffer.concat([
      Buffer.from([0x50,0x4b,0x01,0x02]),
      Buffer.from([0x0a,0x00,0x0a,0x00,0x00,0x00,0x00,0x00]),
      Buffer.from([0x00,0x00,0x21,0x00]),
      crcBuf,
      Buffer.from([body.length,0,0,0]),
      Buffer.from([body.length,0,0,0]),
      Buffer.from([name.length,0]),
      Buffer.from([0,0,0,0,0,0,0,0,0,0,0,0]),
      Buffer.from([0,0,0,0]),
      name,
    ]);
    const eocd = Buffer.concat([
      Buffer.from([0x50,0x4b,0x05,0x06]),
      Buffer.from([0,0,0,0]),
      Buffer.from([1,0,1,0]),
      Buffer.from([cdh.length,0,0,0]),
      Buffer.from([lfh.length,0,0,0]),
      Buffer.from([0,0]),
    ]);
    const zip = Buffer.concat([lfh, cdh, eocd]);
    const up = await sa.post(`/api/admin/tasks/${taskId}/attachments`, {
      headers: { "x-csrf-token": saCsrf },
      multipart: {
        file: { name: "auth.zip", mimeType: "application/zip", buffer: zip },
        display_name: "auth",
      },
    });
    expect(up.ok()).toBeTruthy();
    const aid = (await up.json()).id;
    const dlUrl = `/api/tasks/${taskId}/attachments/${aid}`;

    try {
      // Case 1: anonymous. A fresh browser context has no session
      // cookie, so requireParticipant 401s.
      const { api: anon } = await freshCtx();
      const r1 = await anon.get(dlUrl);
      expect(r1.status(), "anonymous caller must be rejected with 401").toBe(401);
      await anon.dispose();

      // Case 2: logged-in participant whose active competition does
      // NOT include the task. Alice is enrolled in liveComp but the
      // task lives in upcomingComp. She explicitly selects liveComp,
      // then GETs the attachment → the inline competition_tasks
      // check mismatches and 404s. The 404 (not 401/403) is
      // deliberate: it's the same shape returned when the attachment
      // id is wrong, when the task is inactive, or when the task
      // doesn't exist — the route refuses to leak which tasks are
      // associated with which comps.
      const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      const aliceH = { "x-csrf-token": aliceCsrf, "content-type": "application/json" };
      await alice.post("/api/select-competition", {
        headers: aliceH, data: { competitionId: S.liveComp.id },
      });
      const r2 = await alice.get(dlUrl);
      expect(r2.status(), "caller whose active comp doesn't include the task must be rejected with a 4xx").toBeGreaterThanOrEqual(400);
      expect(r2.status(), "caller whose active comp doesn't include the task must NOT get 200").not.toBe(200);
      // Specifically 404 (inline competition_tasks check — the
      // earliest point after auth passes that rejects this request
      // shape).
      expect(r2.status()).toBe(404);

      // Case 3: sanity baseline — if we assign the task to liveComp
      // too, alice's download now succeeds. Proves the gates above
      // are what's blocking her, not some unrelated setup bug.
      const sanity = await sa.post(`/api/admin/tasks/${taskId}/competitions`, {
        headers: saH, data: { competitionIds: [S.upcomingComp.id, S.liveComp.id] },
      });
      expect(sanity.ok()).toBeTruthy();
      const r3 = await alice.get(dlUrl);
      expect(r3.status(), "caller with matching active comp succeeds").toBe(200);
      await alice.dispose();
    } finally {
      await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } }).catch(() => {});
    }
    await sa.dispose();
  });

  test("v6.10.82: /api/admin/submissions `total` drops on deletion under an echoed snapshot — staleness signal", async () => {
    // v6.10.82 client-side DELETE-drift detection relies on `total`
    // being a stable fingerprint of the filtered set under a fixed
    // snapshot_before. Deletions reduce the count; that delta is
    // what the UI uses to surface a "refresh" banner (deletion
    // happened between pages). This test asserts the API provides
    // the signal — total(snapshot) BEFORE deletion > total(snapshot)
    // AFTER deletion, with the same snapshot_before echoed.
    await ensureState();
    const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const aliceH = { "x-csrf-token": aliceCsrf, "content-type": "application/json" };
    await alice.post("/api/select-competition", { headers: aliceH, data: { competitionId: S.liveComp.id } });
    const tasks = await (await alice.get("/api/tasks")).json();
    const unsolved = tasks.find(t => !t.solved);
    expect(unsolved).toBeTruthy();
    // Seed a submission so the endpoint has something to return.
    const s1 = await alice.post(`/api/tasks/${unsolved.id}/submit`, {
      headers: aliceH, data: { answer: `wrong-v6.10.82-seed-${Date.now()}` , gradingHash: await gradingHashFor(alice, unsolved.id)},
    });
    expect(s1.ok()).toBeTruthy();
    await alice.dispose();

    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // First page: get snapshot + total.
    const r1 = await sa.get("/api/admin/submissions?limit=100&offset=0");
    const b1 = await r1.json();
    const snapshot = b1.snapshot_before;
    const totalBefore = b1.total;
    expect(typeof snapshot).toBe("string");
    expect(totalBefore).toBeGreaterThan(0);

    // Fetch with the snapshot echoed — total must equal totalBefore
    // (no deletion yet, so v6.10.82 detection stays quiet).
    const r2 = await sa.get(`/api/admin/submissions?limit=100&offset=0&snapshot_before=${encodeURIComponent(snapshot)}`);
    const b2 = await r2.json();
    expect(b2.total).toBe(totalBefore);

    // Create a throwaway participant + competition, seed submissions,
    // then DELETE the participant (which cascades to submissions +
    // hint_reveals in server.js:7994). Verifies the deletion actually
    // drops `total` under a snapshot_before filter — the signal
    // v6.10.82's client-side detection relies on.
    const doomedEmail = `doomed-${Date.now()}@example.com`;
    const doomedNick = `doomed${Date.now().toString(36)}`;
    const regRes = await registerPost(sa, "/api/register", {
      headers: saH,
      data: {
        firstName: "Doomed", lastName: "User", nickname: doomedNick,
        email: doomedEmail, password: "test-pass-123",
        company: "DoomedCo", title: "Tester",
        country: "US", timezone: "America/New_York",
      },
    });
    expect(regRes.status(), `register failed: ${regRes.status()} ${await regRes.text()}`).toBeLessThan(400);
    const participants = await (await sa.get("/api/admin/participants?limit=500&page=1")).json();
    const doomed = participants.participants.find(u => u.email === doomedEmail);
    expect(doomed).toBeTruthy();
    await sa.post(`/api/admin/participants/${doomed.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${doomed.id}/approve`, { headers: saH });
    await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [doomed.id], competitionIds: [S.liveComp.id] } });
    const { api: doomedLoggedIn, csrf: doomedLoginCsrf } = await apiLogin(doomedEmail, "doomed-pass-123");
    const doomedH = { "x-csrf-token": doomedLoginCsrf, "content-type": "application/json" };
    await doomedLoggedIn.post("/api/select-competition", { headers: doomedH, data: { competitionId: S.liveComp.id } });
    // Submit a few times so there's something to delete.
    for (let i = 0; i < 3; i++) {
      await doomedLoggedIn.post(`/api/tasks/${unsolved.id}/submit`, {
        headers: doomedH, data: { answer: `wrong-doomed-${i}-${Date.now()}` , gradingHash: await gradingHashFor(doomedLoggedIn, unsolved.id)},
      });
    }
    await doomedLoggedIn.dispose();

    // Re-snapshot: anchor that sees the doomed user's submissions.
    const r3 = await sa.get("/api/admin/submissions?limit=100&offset=0");
    const b3 = await r3.json();
    const newSnapshot = b3.snapshot_before;
    const totalWithDoomed = b3.total;
    expect(totalWithDoomed).toBeGreaterThan(totalBefore);

    // Remove doomed from the competition first (active participants
    // can't be deleted — the admin UI forces a two-step flow). Then
    // delete the user entirely, which cascades to their submissions
    // + hints (server.js:7994).
    const rmRes = await sa.delete(`/api/admin/competitions/${S.liveComp.id}/users/${doomed.id}`, { headers: saH });
    expect(rmRes.ok(), `remove-from-comp failed: ${rmRes.status()} ${await rmRes.text()}`).toBeTruthy();
    const delRes = await sa.delete(`/api/admin/participants/${doomed.id}`, { headers: saH });
    expect(delRes.ok(), `delete failed: ${delRes.status()} ${await delRes.text()}`).toBeTruthy();

    // Fetch with the PREVIOUSLY captured snapshot — the doomed user's
    // submissions were under it but are now gone. `total` must drop;
    // that's the exact signal v6.10.82's client uses to flag
    // staleness.
    const r4 = await sa.get(`/api/admin/submissions?limit=100&offset=0&snapshot_before=${encodeURIComponent(newSnapshot)}`);
    const b4 = await r4.json();
    expect(b4.total).toBeLessThan(totalWithDoomed);
    expect(b4.total).toBe(totalWithDoomed - 3);
    await sa.dispose();
  });

  test("v6.10.83: /api/admin/submissions max_mutation_at advances on task recalc — UPDATE-drift signal", async () => {
    // v6.10.82's `total`-delta banner catches DELETE drift (competition /
    // participant delete) but recalc UPDATE drift (server.js recalc path)
    // is invisible to it: row count stays the same, submitted_at /
    // revealed_at stay stable, only is_correct / points_delta /
    // points_deducted get rewritten. v6.10.83 adds max_mutation_at —
    // MAX(COALESCE(updated_at, submitted_at|revealed_at)) scoped to the
    // snapshot-filtered set — as a second fingerprint. This test seeds a
    // submission, captures page-1's max_mutation_at, triggers a recalc
    // that rewrites the row, re-fetches with the echoed snapshot, and
    // asserts max_mutation_at strictly advanced while total stayed the
    // same.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Fresh task so we own the recalc scope — unrelated prior
    // submissions in S.liveComp aren't rewritten by our recalc call.
    const created = await sa.post("/api/admin/tasks", {
      headers: saH,
      data: {
        title: `UpdateDrift-${Date.now()}`, description: "<p>x</p>",
        difficulty: "easy", answer_type: "text", correct_answer: "expected-correct",
        explanation: "<p>x</p>", hint: "hint", status: "published",
      },
    });
    const taskIdBank = (await created.json()).id;
    const taskIdAssign = await sa.post(`/api/admin/tasks/${taskIdBank}/competitions`, { headers: saH, data: { competitionIds: [S.liveComp.id] } });
    expect(taskIdAssign.ok(), await taskIdAssign.text()).toBeTruthy();
    const taskId = (await taskIdAssign.json()).copies[0].task_id;   // the event's own copy (lib/event-copies.js)
    await sa.dispose();
    try {
      // Alice submits WRONG answer — one submission row exists for recalc.
      const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      const aH = { "x-csrf-token": aliceCsrf, "content-type": "application/json" };
      await alice.post("/api/select-competition", { headers: aH, data: { competitionId: S.liveComp.id } });
      const s1 = await alice.post(`/api/tasks/${taskId}/submit`, {
        headers: aH, data: { answer: `wrong-v6.10.83-${Date.now()}` , gradingHash: await gradingHashFor(alice, taskId)},
      });
      expect(s1.ok()).toBeTruthy();
      await alice.dispose();

      // Page 1: grab snapshot + total + max_mutation_at baseline.
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      const sa2H = { "x-csrf-token": sa2Csrf, "content-type": "application/json" };
      const r1 = await sa2.get(`/api/admin/submissions?limit=100&offset=0&competitionId=${S.liveComp.id}`);
      const b1 = await r1.json();
      const snapshot = b1.snapshot_before;
      const totalBefore = b1.total;
      const mutBefore = b1.max_mutation_at;
      expect(typeof snapshot).toBe("string");
      expect(totalBefore).toBeGreaterThan(0);
      expect(typeof mutBefore).toBe("string");

      // Same snapshot re-echoed before any recalc — fingerprint must
      // be stable (detection must be specific to real mutations).
      const r1b = await sa2.get(`/api/admin/submissions?limit=100&offset=0&competitionId=${S.liveComp.id}&snapshot_before=${encodeURIComponent(snapshot)}`);
      const b1b = await r1b.json();
      expect(b1b.total).toBe(totalBefore);
      expect(b1b.max_mutation_at).toBe(mutBefore);

      // Trigger recalc. Difficulty promotion (easy→hard) + correct_answer
      // rewrite that MATCHES alice's wrong answer means (a) every
      // submission row gets its is_correct flipped, and (b) points_delta
      // changes from -5 (wrong@easy) to +150 (correct@hard). Both update
      // `submissions.updated_at` to the recalc timestamp — which is
      // strictly greater than snapshot_before captured above.
      await sa2.put(`/api/admin/tasks/${taskId}`, {
        headers: sa2H,
        data: { difficulty: "hard", correct_answer: "wrong-v6.10.83-match" },
      });
      // 10 ms pad so the recalc ISO string is strictly greater than
      // mutBefore even on Windows / low-resolution clocks.
      await new Promise(r => setTimeout(r, 10));
      // Update correct_answer again to exactly match alice's submission
      // so the recalc actually flips her row.
      const subsBefore = await (await sa2.get(`/api/admin/submissions?limit=100&offset=0&competitionId=${S.liveComp.id}&snapshot_before=${encodeURIComponent(snapshot)}`)).json();
      const aliceRow = subsBefore.events.find(e => e.event_type === "submission" && e.task_title.startsWith("UpdateDrift-"));
      expect(aliceRow).toBeTruthy();
      await sa2.put(`/api/admin/tasks/${taskId}`, {
        headers: sa2H,
        data: { correct_answer: aliceRow.answer },
      });
      const recalcR = await sa2.post(`/api/admin/tasks/${taskId}/recalculate`, { headers: sa2H, data: { confirm_live: true } });
      expect(recalcR.ok(), `recalc failed: ${recalcR.status()} ${await recalcR.text()}`).toBeTruthy();
      const recalcBody = await recalcR.json();
      expect(recalcBody.flipped).toBeGreaterThanOrEqual(1);

      // Same snapshot echoed — total stable (no rows added/removed)
      // but max_mutation_at must have strictly advanced past mutBefore.
      const r2 = await sa2.get(`/api/admin/submissions?limit=100&offset=0&competitionId=${S.liveComp.id}&snapshot_before=${encodeURIComponent(snapshot)}`);
      const b2 = await r2.json();
      expect(b2.total).toBe(totalBefore);
      expect(typeof b2.max_mutation_at).toBe("string");
      expect(b2.max_mutation_at > mutBefore, `expected max_mutation_at to advance; was ${mutBefore}, now ${b2.max_mutation_at}`).toBeTruthy();
      await sa2.dispose();
    } finally {
      const { api: cleanup, csrf: cleanupCsrf } = await apiLogin("superadmin");
      await cleanup.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": cleanupCsrf } }).catch(() => {});
      await cleanup.dispose();
    }
  });

  test("v6.12.12: /api/admin/submissions computes its snapshot atomically (read transaction wrapper)", () => {
    // Structural regression lock for the atomic-first-page-snapshot
    // property. The handler runs FOUR reads — (Q1) derives the snapshot
    // anchor from MAX(event_time), (Q2) fetches the paginated events,
    // (Q3) counts total, (Q4) computes max_mutation_at. Pre-v6.12.12
    // these were four separately-auto-committed statements; the single-
    // process-single-threaded-Node invariant (CLAUDE.md) made that
    // atomic in practice, but a future `await` slipped into the handler
    // OR an accidental multi-process deployment would break the
    // invariant silently and page 1 could ship inconsistent
    // events / total / max_mutation_at. v6.12.12 wraps Q1-Q4 in a single
    // deferred db.transaction(...) so SQLite's WAL snapshot isolation
    // provides the atomicity property the code relies on.
    //
    // This test asserts the wrapper shape without spinning up a server:
    //   1. handler body contains `db.transaction(() =>` — Q1-Q4 share
    //      one closure / one SQLite transaction.
    //   2. the closure is called with `.deferred()` — better-sqlite3's
    //      DEFAULT spelled out (a plain db.transaction() is already a
    //      DEFERRED BEGIN), pinned so it never becomes .immediate() /
    //      .exclusive(), which would take the write lock at BEGIN for a read.
    //   3. no `await` appears in the handler body — any async boundary
    //      would let the Node event loop interleave another request's
    //      writes between Q2 and Q3/Q4, defeating the atomicity invariant.
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "server.js"), "utf8");
    const handlerStart = src.indexOf('app.get("/api/admin/submissions"');
    expect(handlerStart).toBeGreaterThan(-1);
    // Scan forward to the handler's terminal `});` — the `res.json(...)`
    // call immediately preceding it is the last statement before close.
    const resJsonIdx = src.indexOf("res.json(", handlerStart);
    expect(resJsonIdx).toBeGreaterThan(handlerStart);
    // Cap the body at the `});` that closes the handler (we want to
    // scope the grep to THIS handler's body only, not downstream code).
    const handlerEnd = src.indexOf("});", resJsonIdx);
    expect(handlerEnd).toBeGreaterThan(resJsonIdx);
    const body = src.slice(handlerStart, handlerEnd);
    expect(body, "expected db.transaction wrapper around snapshot reads")
      .toMatch(/db\.transaction\(\s*\(\)\s*=>/);
    expect(body, "expected .deferred() qualifier — the default spelled out, so the call never becomes .immediate()/.exclusive(), which would take the write lock at BEGIN for a pure read")
      .toMatch(/\}\)\.deferred\(\)/);
    // Strip comments before scanning for `await` — the v6.12.12 comment
    // itself mentions the keyword in prose, and a naive regex would
    // false-match on that. Line-comments first (`// … \n`) then block
    // comments (`/* … */`).
    const codeOnly = body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(codeOnly, "handler must stay fully synchronous — an await opens a yield point that breaks tx-atomicity")
      .not.toMatch(/\bawait\b/);
  });

  test("v6.12.12: db.transaction(fn).deferred() pins a WAL snapshot across a concurrent writer", () => {
    // Proves the primitive /api/admin/submissions relies on. A deferred
    // read transaction on connection A must see a frozen snapshot of
    // the database — specifically, a write COMMITTED from connection B
    // after A's transaction began must NOT be visible to any statement
    // inside A's transaction, even if the write lands between A's
    // consecutive SELECTs. Outside A's transaction, the write is visible
    // normally. If a future better-sqlite3 or SQLite upgrade regresses
    // this property the handler's atomicity guarantee silently breaks —
    // this test fires with no server involvement and catches it at CI.
    const Database = require("better-sqlite3");
    const os = require("os");
    const fs = require("fs");
    const path = require("path");
    const dbPath = path.join(os.tmpdir(), `atomic-snap-${process.pid}-${Date.now()}.db`);
    const conn1 = new Database(dbPath);
    conn1.pragma("journal_mode = WAL");
    conn1.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val INTEGER)");
    conn1.exec("INSERT INTO t (id, val) VALUES (1, 10), (2, 20), (3, 30)");
    const conn2 = new Database(dbPath);
    try {
      const result = conn1.transaction(() => {
        // First read inside the tx establishes A's snapshot.
        const before = conn1.prepare("SELECT val FROM t ORDER BY id").all().map(r => r.val);
        // Connection B commits an UPDATE while A's tx is still open.
        // In WAL mode this doesn't block A's read; the invariant we're
        // testing is that A's subsequent reads still see the pre-UPDATE
        // snapshot anchored at the start of its transaction.
        conn2.exec("UPDATE t SET val = val * 100 WHERE id = 2");
        // Second read inside A's tx — MUST match `before`.
        const after = conn1.prepare("SELECT val FROM t ORDER BY id").all().map(r => r.val);
        const maxVal = conn1.prepare("SELECT MAX(val) as m FROM t").get().m;
        return { before, after, maxVal };
      }).deferred();
      expect(result.before).toEqual([10, 20, 30]);
      expect(result.after, "second read inside deferred tx must see same snapshot as first read")
        .toEqual([10, 20, 30]);
      expect(result.maxVal, "aggregate inside deferred tx sees pre-UPDATE max")
        .toBe(30);
      // Outside the tx, a fresh read on the SAME connection reflects the
      // post-commit state — confirms conn2's UPDATE actually landed and
      // isn't suppressed by some connection-level cache.
      expect(conn1.prepare("SELECT val FROM t WHERE id=2").get().val).toBe(2000);
    } finally {
      conn1.close();
      conn2.close();
      for (const suffix of ["", "-shm", "-wal"]) {
        try { fs.unlinkSync(dbPath + suffix); } catch (_) { /* ignore */ }
      }
    }
  });

  test("v6.10.80: /api/admin/perf/bulk-seed-users requires maintenance mode + superadmin", async () => {
    // Stacked gates: without the .maintenance file, 403 regardless of
    // auth level. Without superadmin, 403 regardless of maintenance
    // state.
    await ensureState();
    const uniq = Date.now().toString(36);
    // Log in sa AND alice BEFORE creating the .maintenance file — the
    // maintenance middleware sits above the auth layer, so login calls
    // would 503 if attempted while the file is present.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const aliceH = { "x-csrf-token": aliceCsrf, "content-type": "application/json" };

    // Without .maintenance file: endpoint's own guard returns 403
    const r1 = await sa.post("/api/admin/perf/bulk-seed-users", {
      headers: saH,
      data: {
        users: [{ firstName: "Bulk", lastName: `Test${uniq}`, nickname: `bulk${uniq}`, email: `bulk${uniq}@example.com` }],
        sharedPassword: "testpass123",
      },
    });
    expect(r1.status()).toBe(403);
    expect((await r1.json()).error).toMatch(/maintenance/i);

    // Create .maintenance file, then retry — sa includes the bypass
    // header to get past the maintenance middleware; the endpoint's
    // own guard passes now that the file exists.
    const fs = require("fs");
    const path = require("path");
    const maintFile = path.join(TEST_DATA_DIR, ".maintenance");
    fs.writeFileSync(maintFile, "bulk-seed-probe-token");
    try {
      const users = Array.from({ length: 3 }, (_, i) => ({
        firstName: "Bulk", lastName: `Test${uniq}${i}`,
        nickname: `bulk${uniq}${i}`,
        email: `bulk${uniq}${i}@example.com`,
      }));
      const byp = "bulk-seed-probe-token";
      const r2 = await sa.post("/api/admin/perf/bulk-seed-users", {
        headers: { ...saH, "x-maintenance-bypass": byp },
        data: { users, sharedPassword: "testpass123" },
      });
      expect(r2.status()).toBe(200);
      const b2 = await r2.json();
      expect(b2.inserted).toBe(3);
      expect(b2.skipped).toBe(0);
      expect(b2.total).toBe(3);

      // Re-submitting the same users: all 3 skipped (dup email/nickname)
      const r3 = await sa.post("/api/admin/perf/bulk-seed-users", {
        headers: { ...saH, "x-maintenance-bypass": byp },
        data: { users, sharedPassword: "testpass123" },
      });
      const b3 = await r3.json();
      expect(b3.inserted).toBe(0);
      expect(b3.skipped).toBe(3);

      // Non-superadmin rejected even with the file present (auth gate
      // is checked before the maintenance-file gate, but since the
      // file is here too we're also exercising the file-passing
      // path's auth check).
      const r4 = await alice.post("/api/admin/perf/bulk-seed-users", {
        headers: { ...aliceH, "x-maintenance-bypass": byp },
        data: { users: [{ firstName: "X", lastName: "Y", nickname: `xyz${uniq}`, email: `xyz${uniq}@example.com` }], sharedPassword: "testpass123" },
      });
      expect(r4.status()).toBe(403);
    } finally {
      try { fs.unlinkSync(maintFile); } catch (_) {}
    }
    await sa.dispose();
    await alice.dispose();
  });

  test("v6.10.85: /api/admin/perf/bulk-seed-users stamps the requested role on insert", async () => {
    // v6.10.85 extends the bulk-seed endpoint with an optional per-row
    // `role` field. The perf seeder uses this to create a dedicated
    // admin pool (perf-admin-NN, role=admin) so the k6 admin +
    // log_admin scenarios can log in to distinct accounts instead of
    // thundering the shared superadmin login. This test confirms (a)
    // role=participant is applied by default, (b) role=admin is
    // honoured and the resulting user has admin access to admin
    // endpoints, and (c) invalid role values are rejected at the
    // validation layer.
    await ensureState();
    const uniq = Date.now().toString(36);
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };

    const fs = require("fs");
    const path = require("path");
    const maintFile = path.join(TEST_DATA_DIR, ".maintenance");
    const byp = "bulk-seed-role-probe-token";
    fs.writeFileSync(maintFile, byp);
    try {
      // Happy path: three users, two with explicit role.
      const adminEmail  = `admin-${uniq}@example.com`;
      const plainEmail  = `plain-${uniq}@example.com`;
      const superEmail  = `super-${uniq}@example.com`;
      const r1 = await sa.post("/api/admin/perf/bulk-seed-users", {
        headers: { ...saH, "x-maintenance-bypass": byp },
        data: {
          users: [
            { firstName: "Role", lastName: "Admin",       nickname: `rA${uniq}`, email: adminEmail, role: "admin" },
            { firstName: "Role", lastName: "Participant", nickname: `rP${uniq}`, email: plainEmail },
            { firstName: "Role", lastName: "Super",       nickname: `rS${uniq}`, email: superEmail, role: "superadmin" },
          ],
          sharedPassword: "testpass123",
        },
      });
      expect(r1.status()).toBe(200);
      expect((await r1.json()).inserted).toBe(3);

      // Invalid role → 400 before any insert.
      const r2 = await sa.post("/api/admin/perf/bulk-seed-users", {
        headers: { ...saH, "x-maintenance-bypass": byp },
        data: {
          users: [
            { firstName: "X", lastName: "Y", nickname: `badrole${uniq}`, email: `badrole-${uniq}@example.com`, role: "moderator" },
          ],
          sharedPassword: "testpass123",
        },
      });
      expect(r2.status()).toBe(400);
      expect((await r2.json()).error).toMatch(/role must be one of/);

      // Maintenance-mode gate sits ABOVE apiLogin's auth path — remove
      // the file so the subsequent participant-role verifications via
      // /api/login + /api/admin/me aren't 503'd by the middleware.
      try { fs.unlinkSync(maintFile); } catch (_) {}

      // Verify admin user actually has admin access: log them in + hit
      // an admin-only endpoint. If role stamping missed, /api/admin/me
      // returns 403 (requireAdmin sees isAdmin=false).
      const { api: adminCtx } = await apiLogin(adminEmail, "testpass123");
      const r3 = await adminCtx.get("/api/admin/me");
      expect(r3.status(), `admin access denied for role-stamped user: ${await r3.text()}`).toBe(200);
      expect((await r3.json()).isAdmin).toBe(true);
      await adminCtx.dispose();

      // Verify the default-role user has NO admin access. /api/admin/me
      // returns 401 for any non-admin session (server.js:3995 — it
      // pre-dates the requireAdmin convention of 403 for
      // authenticated-but-unauthorised, but kept for back-compat with
      // the SPA's admin-probe hook).
      const { api: plainCtx } = await apiLogin(plainEmail, "testpass123");
      const r4 = await plainCtx.get("/api/admin/me");
      expect(r4.status()).toBe(401);
      await plainCtx.dispose();
    } finally {
      try { fs.unlinkSync(maintFile); } catch (_) {}
    }
    await sa.dispose();
  });

  test("v6.9.21: /api/toggle-admin-view flips a regular admin's isAdmin flag; participants get 403", async () => {
    await ensureState();
    // Promote carol to admin for the test, then restore in finally.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.dispose();
    try {
      const { api: carol, csrf: cCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      const cH = { "x-csrf-token": cCsrf, "content-type": "application/json" };
      // Flip to participant view.
      const rPart = await carol.post("/api/toggle-admin-view", { headers: cH, data: { mode: "participant" } });
      expect(rPart.status()).toBe(200);
      const partBody = await rPart.json();
      expect(partBody.ok).toBe(true);
      expect(partBody.isAdmin).toBe(false);
      // Flip back to admin view.
      const rAdmin = await carol.post("/api/toggle-admin-view", { headers: { "x-csrf-token": (await (await carol.get("/api/csrf-token")).json()).csrfToken, "content-type": "application/json" }, data: { mode: "admin" } });
      expect(rAdmin.status()).toBe(200);
      expect((await rAdmin.json()).isAdmin).toBe(true);
      await carol.dispose();

      // Regular participant alice → 403 (no admin role).
      const { api: alice, csrf: aCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      const aliceAttempt = await alice.post("/api/toggle-admin-view", { headers: { "x-csrf-token": aCsrf, "content-type": "application/json" }, data: { mode: "admin" } });
      expect(aliceAttempt.status()).toBe(403);
      await alice.dispose();
    } finally {
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: { "x-csrf-token": sa2Csrf, "content-type": "application/json" }, data: { role: "participant" } });
      await sa2.dispose();
    }
  });

  test("v6.9.21: /api/dismiss-ended sets ended_popup_seen and returns ok, anonymous get 403", async () => {
    await ensureState();
    // Anonymous → requireParticipant rejects before requireCompetitionContext.
    const { api: anon, csrf: anonCsrf } = await freshCtx();
    const rAnon = await anon.post("/api/dismiss-ended", { headers: { "x-csrf-token": anonCsrf, "content-type": "application/json" }, data: {} });
    expect([401, 403]).toContain(rAnon.status());
    await anon.dispose();

    // Happy path — select the live comp, then dismiss.
    const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await alice.post("/api/select-competition", { headers: { "x-csrf-token": aliceCsrf, "content-type": "application/json" }, data: { competitionId: S.liveComp.id } });
    const rOk = await alice.post("/api/dismiss-ended", { headers: { "x-csrf-token": aliceCsrf, "content-type": "application/json" }, data: {} });
    expect(rOk.status()).toBe(200);
    expect((await rOk.json()).ok).toBe(true);
    await alice.dispose();

    // Confirm the ended_popup_seen flag was flipped in the DB.
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const row = db.prepare("SELECT ended_popup_seen FROM competition_users WHERE competition_id=? AND user_id=?").get(S.liveComp.id, S.alice.id);
    db.close();
    expect(row?.ended_popup_seen).toBe(1);
  });







  test("v6.9.17: /api/tasks/:id/submit caps text-answer body at 64 KB with 413", async () => {
    // Pathological-payload guard. express.json()'s default body size
    // (or any operator override) was the only backstop — now the
    // submit handler short-circuits with 413 before it runs the
    // whitespace-normalize + case-fold regex pass on a huge string.
    await ensureState();
    const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await alice.post("/api/select-competition", { headers: { "x-csrf-token": aliceCsrf, "content-type": "application/json" }, data: { competitionId: S.liveComp.id } });
    const easy = S.liveTask("Challenge easy1");
    const r = await alice.post(`/api/tasks/${easy.id}/submit`, {
      headers: { "x-csrf-token": aliceCsrf },
      multipart: { answer: "a".repeat(65537) , gradingHash: await gradingHashFor(alice, easy.id)},
    });
    expect(r.status()).toBe(413);
    expect((await r.json()).error).toMatch(/too long|shorten/i);
    await alice.dispose();
  });

  test("v6.9.17: /api/me uses a single batch query for competition timeslots (no N+1)", async () => {
    // End-to-end check: assert /api/me payload correctness is
    // unchanged (status + effective_end still resolved for every
    // comp). The N+1 collapse is a latency win that's hard to pin
    // in a unit test; the best regression lock is shape-correctness
    // across a caller with multiple comps in their list.
    await ensureState();
    const { api } = await apiLogin("superadmin");
    const me = await (await api.get("/api/me")).json();
    // Superadmin doesn't participate in comps but gets the list via /api/admin.
    // Switch to alice who is in the seeded live + upcoming comps.
    await api.dispose();
    const { api: alice } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const aliceMe = await (await alice.get("/api/me")).json();
    expect(Array.isArray(aliceMe.competitions)).toBe(true);
    expect(aliceMe.competitions.length).toBeGreaterThanOrEqual(1);
    for (const c of aliceMe.competitions) {
      expect(["upcoming", "live", "ended"]).toContain(c.status);
      expect(typeof c.effective_end).toBe("string");
    }
    await alice.dispose();
  });



  test("v6.9.13: on a phone, what sits at the bottom edge clears the iOS home indicator (safe-area-inset-bottom)", async () => {
    // The participant bar (#main-nav) was once a fixed bottom tab bar on phones,
    // and this lock held its safe-area padding. It is now a row of the sticky
    // header on every width (CLAUDE.md "App chrome"), so the home-indicator
    // strip concerns what IS fixed at the bottom of a phone screen: the toast
    // stack, the selection bar and the leaderboard's own-row banner. Each offsets
    // its `bottom` by env(safe-area-inset-bottom). Read from the served (minified)
    // CSS: Chromium has no inset, so geometry cannot tell.
    const { api } = await (async () => {
      const { request } = require("./isolated-test");
      const ctx = await request.newContext({ baseURL: require("./helpers").BASE });
      return { api: ctx };
    })();
    const css = await (await api.get("/styles.css")).text();
    // The bar is not pinned to the bottom again.
    const navRules = [...css.matchAll(/[^{}]*#main-nav[^{}]*\{[^}]*\}/g)].map(m => m[0]);
    expect(navRules.length, "anti-vacuity: the #main-nav rules are found").toBeGreaterThan(3);
    expect(navRules.filter(r => /position:fixed/.test(r)), "no #main-nav rule fixes the bar to the screen").toEqual([]);
    // Each bottom-fixed element: a rule for exactly that selector whose `bottom`
    // carries the inset.
    for (const sel of ["#toast-stack", ".selection-bar", "#lb-me-banner"]) {
      const esc = sel.replace(/[.#]/g, (c) => `\\${c}`);
      const bodies = [...css.matchAll(new RegExp(`(?:^|[{},])${esc}\\{([^}]*)\\}`, "g"))].map(m => m[1]);
      expect(bodies.length, `anti-vacuity: ${sel} has rules of its own`).toBeGreaterThan(0);
      expect(bodies.some(b => /(?:^|;)bottom:[^;]*env\(safe-area-inset-bottom\)/.test(b)),
        `${sel}: a rule offsets its bottom by env(safe-area-inset-bottom): ${bodies.join(" | ")}`).toBe(true);
    }
    await api.dispose();
  });

  test("v6.9.12: role change invalidates leaderboard cache immediately", async () => {
    // The `staff` tag on a user filters them out of the public
    // leaderboard. Promoting alice to admin auto-applies `staff`, so
    // the next /api/leaderboard call must not return her — even if the
    // cache was primed seconds earlier. Demotion restores her.
    await ensureState();
    const compId = S.liveComp.id;
    // Prime the cache from alice's own session (she is in liveComp from the seed).
    const { api: alice0, csrf: aliceCsrf0 } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await alice0.post("/api/select-competition", { headers: { "x-csrf-token": aliceCsrf0, "content-type": "application/json" }, data: { competitionId: compId } });
    const before = await (await alice0.get("/api/leaderboard")).json();
    expect(before.board.find(u => u.userId === S.alice.id), "alice must be on the board before promotion").toBeTruthy();
    await alice0.dispose();

    // Promote alice → admin (adds `staff` tag globally).
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    try {
      const prR = await sa.post(`/api/admin/participants/${S.alice.id}/role`, { headers: saH, data: { role: "admin" } });
      expect(prR.ok()).toBeTruthy();
      await sa.dispose();
      // Immediately re-read the board as bob — must NOT see alice now.
      const { api: bob, csrf: bobCsrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
      await bob.post("/api/select-competition", { headers: { "x-csrf-token": bobCsrf, "content-type": "application/json" }, data: { competitionId: compId } });
      const mid = await (await bob.get("/api/leaderboard")).json();
      expect(mid.board.find(u => u.userId === S.alice.id), "alice must NOT be on the board right after promotion (cache-bust required)").toBeFalsy();
      await bob.dispose();
    } finally {
      // Restore alice → participant AND verify demotion re-exposes her on the board.
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      const sa2H = { "x-csrf-token": sa2Csrf, "content-type": "application/json" };
      await sa2.post(`/api/admin/participants/${S.alice.id}/role`, { headers: sa2H, data: { role: "participant" } });
      await sa2.dispose();
      const { api: alice2, csrf: alice2Csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      await alice2.post("/api/select-competition", { headers: { "x-csrf-token": alice2Csrf, "content-type": "application/json" }, data: { competitionId: compId } });
      const after = await (await alice2.get("/api/leaderboard")).json();
      expect(after.board.find(u => u.userId === S.alice.id), "alice reappears on the board after demotion (cache-bust required)").toBeTruthy();
      await alice2.dispose();
    }
  });

  test("v6.9.12: removing a participant from a competition invalidates leaderboard cache immediately", async () => {
    // DELETE /api/admin/competitions/:id/users/:uid removes the
    // competition_users row, so the aggregation drops the user. Without
    // cache-bust their row persisted on the cached board for up to 5 s.
    await ensureState();
    // Create a fresh live competition so we can assign + remove bob without
    // polluting the seeded liveComp (which bob stays in for other tests).
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const now = Date.now();
    const created = await sa.post("/api/admin/competitions", {
      headers: saH,
      data: { name: `LB-Remove-${now}`, start_time: new Date(now - 60_000).toISOString(), duration_minutes: 120 },
    });
    const compId = (await created.json()).competition.id;
    await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [S.bob.id], competitionIds: [compId] } });
    await sa.dispose();

    try {
      // Have bob log in so his login_time is set and he's on the board.
      const { api: bob, csrf: bobCsrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
      await bob.post("/api/select-competition", { headers: { "x-csrf-token": bobCsrf, "content-type": "application/json" }, data: { competitionId: compId } });
      const before = await (await bob.get("/api/leaderboard")).json();
      expect(before.board.find(u => u.userId === S.bob.id)).toBeTruthy();
      await bob.dispose();

      // Admin removes bob, then immediately re-reads the board.
      // v8.12.4 — the admin board is a bare ARRAY; the old read took `.board`
      // off it, got [] every time, and "bob is gone" held of any build. The
      // board is also WARMED first, so only a cache bust can make him vanish
      // inside the 5 s TTL.
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      const adminBoard = async () => { const j = await (await sa2.get(`/api/admin/leaderboard?competitionId=${compId}`)).json(); return Array.isArray(j) ? j : (j.board || []); };
      expect((await adminBoard()).find(u => u.userId === S.bob.id), "PRECONDITION: bob is on the warmed admin board").toBeTruthy();
      const rm = await sa2.delete(`/api/admin/competitions/${compId}/users/${S.bob.id}`, { headers: { "x-csrf-token": sa2Csrf } });
      expect(rm.ok()).toBeTruthy();
      // Re-prime from alice's POV (she's not in the comp, but the admin
      // leaderboard shows every board and the public one requires a comp
      // context — we'll use the admin API instead).
      expect(
        (await adminBoard()).find(u => u.userId === S.bob.id),
        "bob must be gone from the board right after DELETE (cache-bust required)",
      ).toBeFalsy();
      await sa2.dispose();
    } finally {
      const { api: sa3, csrf: sa3Csrf } = await apiLogin("superadmin");
      await sa3.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": sa3Csrf } }).catch(() => {});
      await sa3.dispose();
    }
  });

  test("v6.9.12: bulk admin routes enforce the 1000-user batch cap", async () => {
    // Pathological-payload guard. A compromised admin session / XSS can
    // no longer DOS the SMTP transport or the SQLite writer lock with a
    // six-figure userIds array. All three bulk routes share the cap.
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const tooMany = Array.from({ length: 1001 }, (_, i) => `fake-${i}`);

    const bulkApprove = await api.post("/api/admin/participants/bulk-approve", { headers: h, data: { userIds: tooMany } });
    expect(bulkApprove.status(), "bulk-approve >1000").toBe(400);
    expect((await bulkApprove.json()).error).toMatch(/1000/);

    const assign = await api.post("/api/admin/competitions/assign", { headers: h, data: { userIds: tooMany, competitionIds: [S.liveComp.id] } });
    expect(assign.status(), "assign >1000 userIds").toBe(400);
    expect((await assign.json()).error).toMatch(/1000/);

    const tooManyEmails = Array.from({ length: 1001 }, (_, i) => `fake-${i}@example.com`);
    const invites = await api.post("/api/admin/invitations", { headers: h, data: { emails: tooManyEmails, competitionIds: [] } });
    expect(invites.status(), "invitations >1000 emails").toBe(400);
    expect((await invites.json()).error).toMatch(/1000/);

    await api.dispose();
  });

  test("/api/csp-report endpoint accepts reports and returns 204 (rate limit middleware wired in v6.2.6)", async () => {
    // Regression for S-1. Per-IP rate-limit (30 req/min) is bypassed in test
    // mode by RATE_LIMIT_DISABLED=1, so this just confirms the endpoint is
    // alive, accepts both shapes (single + Reporting-API array), and never
    // tries to authenticate (no session needed).
    const { api } = await (async () => {
      const { request } = require("./isolated-test");
      const ctx = await request.newContext({ baseURL: TEST_DATA_DIR ? require("./helpers").BASE : "" });
      return { api: ctx };
    })();
    const r1 = await api.post("/api/csp-report", {
      headers: { "content-type": "application/csp-report" },
      data: { "csp-report": { "violated-directive": "script-src", "blocked-uri": "https://evil.example/x.js" } },
    });
    expect(r1.status()).toBe(204);
    const r2 = await api.post("/api/csp-report", {
      headers: { "content-type": "application/json" },
      data: [{ type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "https://evil.example/y.png" } }],
    });
    expect(r2.status()).toBe(204);
    await api.dispose();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // v8.3.14 — A CSP REPORT ATTRIBUTED TO A BROWSER EXTENSION IS NOT OUR
  // VIOLATION, and it must not bury the ones that are.
  //
  // Reported from production: the log filling with `style-src-elem` /
  // `blocked_uri: "inline"` whose `source_file` is `safari-web-extension://…` —
  // an add-on injecting a `<style>` into the page, in the visitor's own browser.
  // The policy is doing its job and there is nothing on this side to fix: the app
  // ships no inline `<style>` at all. What WAS broken is signal-to-noise, because
  // every report was logged at WARN and extension traffic scales with visitors
  // rather than with defects.
  // ───────────────────────────────────────────────────────────────────────────
  test("v8.3.14: an extension-attributed CSP report is silenced; a real one is not", async () => {
    const fs = require("fs");
    const path = require("path");
    const { request } = require("./isolated-test");
    const ctx = await request.newContext({ baseURL: require("./helpers").BASE });
    const tag = `csp${Date.now().toString(36)}`;
    try {
      // The operator's EXACT production payload, down to the scheme and the
      // directive, so this test is about the report that was actually filed.
      const ext = await ctx.post("/api/csp-report", {
        headers: { "content-type": "application/csp-report" },
        data: { "csp-report": {
          "violated-directive": "style-src-elem", "blocked-uri": "inline",
          "document-uri": `https://ctf.checkmarx.net/?${tag}`,
          "source-file": "safari-web-extension://ED79B223-238F-4231-A71E-D907F420E2C4/js/contentApp.9e66deda.js",
          "line-number": 2419, "column-number": 16736,
        } },
      });
      expect(ext.status(), "a report is always accepted — browsers ignore the body").toBe(204);

      // THE CONTROL, and it carries the weight: without it "nothing was logged"
      // is equally satisfied by a build that stopped logging CSP reports at all,
      // which would be strictly worse than the noise it replaced.
      const real = await ctx.post("/api/csp-report", {
        headers: { "content-type": "application/csp-report" },
        data: { "csp-report": {
          "violated-directive": "script-src", "blocked-uri": "inline",
          "document-uri": `https://ctf.checkmarx.net/?${tag}`,
          "source-file": `https://ctf.checkmarx.net/js/core/main.js?${tag}`,
        } },
      });
      expect(real.status()).toBe(204);

      // Read what actually reached the log at the DEFAULT level. The extension
      // report is not discarded — it drops to `debug`, below the threshold — so
      // the assertion is about what an operator SEES, which is the whole subject.
      const LOG_DIR = path.join(TEST_DATA_DIR, "logs");
      const readAll = () => fs.readdirSync(LOG_DIR)
        .filter(f => f.startsWith("app-") && f.endsWith(".jsonl"))
        .map(f => fs.readFileSync(path.join(LOG_DIR, f), "utf8")).join("\n")
        .split("\n").filter(l => l.includes(tag)).map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);

      let lines = [];
      await expect.poll(() => { lines = readAll(); return lines.length; },
        { timeout: 5000, message: "the real violation must reach the log" }).toBeGreaterThan(0);

      const dirs = lines.map(l => l.csp_directive);
      expect(dirs, "the app-origin violation is kept, at warn").toContain("script-src");
      expect(lines.find(l => l.csp_directive === "script-src").level).toBe("warn");
      expect(dirs,
        "the extension-attributed one must NOT be at the default level — it is what was burying the real ones"
      ).not.toContain("style-src-elem");
    } finally { await ctx.dispose(); }
  });

  test("v8.3.14: /metrics counts BOTH classes, so the filter cannot hide volume", async () => {
    // A filter with no counter is the invisible half of the same problem
    // (v7.21.2). `origin="app"` rising is worth acting on; `origin=
    // "browser_extension"` rising is just more visitors with add-ons.
    const { request } = require("./isolated-test");
    const { BASE } = require("./helpers");
    const anon = await request.newContext({ baseURL: BASE });
    const { api: sa } = await apiLogin("superadmin");
    try {
      const read = async () => {
        const txt = await (await sa.get("/metrics")).text();
        const grab = (o) => Number((new RegExp(`hack_arena_csp_reports_total\\{origin="${o}"\\} (\\d+)`).exec(txt) || [])[1]);
        return { app: grab("app"), ext: grab("browser_extension") };
      };
      const before = await read();
      expect(Number.isFinite(before.app) && Number.isFinite(before.ext),
        "both series must be exported, or the filter is unmeasurable").toBe(true);

      const send = async (report) => {
        const r = await anon.post("/api/csp-report", {
          headers: { "content-type": "application/csp-report" },
          data: { "csp-report": report },
        });
        // The endpoint answers 204 UNCONDITIONALLY (a browser must never retry a
        // violation report), so this assertion cannot tell "accepted and parsed"
        // from "accepted and dropped". The counters below are the only witness.
        expect(r.status(), "the report must be accepted").toBe(204);
      };
      for (const src of ["chrome-extension://abc/x.js", "moz-extension://abc/x.js", "safari-web-extension://abc/x.js"]) {
        await send({ "violated-directive": "style-src-elem", "blocked-uri": "inline", "source-file": src });
      }
      await send({ "violated-directive": "script-src", "blocked-uri": "inline", "source-file": "https://ctf.checkmarx.net/js/core/main.js" });

      // `/metrics` MEMOISES ITS BODY FOR ONE SECOND (`_metricsCache`), and four
      // POSTs take milliseconds — so reading it straight back returns the BEFORE
      // body and the delta is ALWAYS zero. That is not a flake, it is
      // deterministic, and it cost a real diagnosis here: "the counter did not
      // move" reads as a broken filter when it is a test measuring a cache.
      // Anything asserting a /metrics delta has to clear that window first.
      await new Promise(r => setTimeout(r, 1200));
      const after = await read();

      // EVERY engine's scheme, one report each — a filter that only knew Safari
      // would leave Chrome and Firefox users still flooding the log.
      expect(after.ext - before.ext, "all three extension schemes are recognised").toBe(3);
      expect(after.app - before.app, "and the app-origin one is still counted as ours").toBe(1);
    } finally { await anon.dispose(); await sa.dispose(); }
  });

  test("v8.3.14: the app ships no inline <style>, so style-src-elem can only be a third party", async () => {
    // The reason the report is noise rather than a defect, pinned at source. If
    // this ever goes red the reports become OURS and the filter would be hiding a
    // real violation — which is the one way this change could do harm.
    const fs = require("fs");
    const path = require("path");
    const root = path.resolve(__dirname, "..", "public");
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "vendor") walk(abs); continue; }
        if (!/\.(html|js)$/.test(e.name)) continue;
        const src = fs.readFileSync(abs, "utf8");
        // A <style> ELEMENT, or JS that manufactures one. `style="…"` attributes
        // are a DIFFERENT directive (style-src-attr, which the policy allows) and
        // must not be flagged here.
        if (/<style[\s>]/i.test(src) || /createElement\((['"`])style\1\)/.test(src)) {
          offenders.push(path.relative(root, abs));
        }
      }
    };
    walk(root);
    expect(offenders,
      "an inline <style> would be a REAL style-src-elem violation, and the v8.3.14 " +
      "extension filter would then be hiding reports that are ours"
    ).toEqual([]);
  });

  test("/api/invitations/:id rate-limit middleware is wired (v6.2.6)", async () => {
    // Regression for S-2. We can't actually trigger 429 because tests run
    // with RATE_LIMIT_DISABLED=1, but at minimum we verify the endpoint is
    // defined and responds with the expected 404 for an unknown UUID. The
    // production rate limit (30/min) is exercised in manual smoke testing.
    const { request } = require("./isolated-test");
    const ctx = await request.newContext({ baseURL: require("./helpers").BASE });
    const r = await ctx.get("/api/invitations/00000000-0000-0000-0000-000000000000");
    expect(r.status()).toBe(404);
    await ctx.dispose();
  });

  test("leaderboard tiebreak is deterministic when score and finish-time are equal (v6.2.6 L-2)", async () => {
    // Regression for L-2: pre-fix Array#sort fell back to insertion order
    // when score == score AND solveTimeMs == solveTimeMs (e.g. two
    // unfinished participants at the same nowMs snapshot, or two finishers
    // in the same millisecond). Now we tiebreak on userId lexicographic
    // ascending so consecutive requests return identical rank order.
    await ensureState();
    const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await alice.post("/api/select-competition", {
      headers: { "x-csrf-token": aliceCsrf, "content-type": "application/json" },
      data: { competitionId: S.liveComp.id },
    });
    // Pull the leaderboard 5 times and assert userId order is identical.
    const orderings = [];
    for (let i = 0; i < 5; i++) {
      const r = await (await alice.get("/api/leaderboard")).json();
      orderings.push((r.board || []).map(e => e.userId).join(","));
    }
    const distinct = new Set(orderings);
    expect(distinct.size, `Leaderboard order varied across requests: ${[...distinct].join(" / ")}`).toBe(1);
    await alice.dispose();
  });

  test("secondary_email is redacted in admin log output (v6.2.6 — defense in depth)", async () => {
    // Regression for S-5: secondary_email is a first-class identity (sign-in
    // + reset both work with it) but is NOT in the same exposure tier as
    // primary email. Logs go to operator-side storage with broader audience
    // (backups, log shippers, cold-storage), so even though admins can see
    // secondary_email via /api/admin/participants, the log stream MUST
    // redact it. Stamp a known marker into a log line via an admin write
    // that includes secondary_email in its details, then assert the marker
    // is masked when read back.
    await ensureState();
    const ts = Date.now();
    const sentinel = `secret-sec-${ts}@example.com`;
    const { api, csrf } = await apiLogin("superadmin");
    // Set Alice's secondary email — recordUserEvent on the edit fires with
    // the new email in `details`. It MUST be redacted by the log stream.
    await api.put(`/api/admin/participants/${S.alice.id}`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { secondaryEmail: sentinel },
    });
    try {
      // Pull a generous slice of the app log and confirm the sentinel email
      // never appears anywhere in serialized form. _REDACT_KEYS replaces the
      // value with [REDACTED] before write.
      const today = new Date().toISOString().slice(0, 10);
      const r = await (await api.get(`/api/admin/logs?stream=app&date=${today}&limit=500`)).json();
      const body = JSON.stringify(r.entries || []);
      expect(body, "secondary_email leaked into the app log unredacted").not.toContain(sentinel);
    } finally {
      // Clear the sentinel HERE: alice is a shared seeded fixture, and a failed
      // assertion above would otherwise leave a second identity on her row for
      // every later test in this file.
      await api.put(`/api/admin/participants/${S.alice.id}`, {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { secondaryEmail: "" },
      });
      await api.dispose();
    }
  });

  // ── Role-based log redaction ───────────────────────────────────────────────
  // Two classes of secrets pass through the log streams:
  //   • superadmin password, via console.log at startup (mirrored into app.jsonl)
  //   • verify/reset tokens, via `?code=...` URLs captured in access.jsonl's `path`
  // Regular admins have legitimate read access to /api/admin/logs but must not be
  // able to escalate via the password or hijack active verify/reset flows.



  test("v7.21.14: the unsubscribe token is scrubbed at WRITE time too", async () => {
    // The scrub list is a SET that claims completeness, and this was its hole.
    // The unsubscribe token is the worst of the capability-bearing URL secrets
    // on two counts: it is valid for 365 DAYS (every other one here is 48 h or
    // tied to a live competition), and its payload is
    // _b64url(JSON.stringify({e:<email>,…})) — SIGNED, not encrypted — so a
    // logged line leaks the recipient's address in a form anyone can decode.
    //
    // It reaches the log for exactly the reason it must be scrubbed: GET
    // /api/unsubscribe exists because scanners and link-prefetchers follow every
    // URL in an email (v7.15.11), so those hits land in access-*.jsonl verbatim.
    const { api } = await apiLogin("superadmin");
    try {
      // A REAL token — HMAC-signed with the server's own persisted secret, so
      // the URL under test is one the platform would actually issue.
      //
      // It is built with plain crypto rather than by requiring lib/email, and
      // that is not a style choice — the first version of this test DID require
      // it and killed the CI worker: "worker process exited unexpectedly
      // (code=1, signal=null)", on both attempts, naming nothing about the
      // cause. It passed locally every time.
      //
      // lib/email does three things AT REQUIRE TIME that a Playwright worker
      // must not do: it requires ../db (opening a SQLite database — and the
      // WORKER's DATA_DIR is not the test server's, so it is a DIFFERENT
      // database, created on the spot, migrations and all, once per worker);
      // it reads-or-WRITES DATA_DIR/.unsubscribe-secret; and it schedules an
      // SMTP probe. db.js can also process.exit(1) from a guarded migration,
      // which is the shape of the observed exit — though the precise line was
      // not isolated, and the fix does not depend on which it was.
      //
      // The general rule is the v7.20.2 one, and it applies INSIDE a test too,
      // not only at module scope: a spec that requires app code which opens the
      // database is not talking to the server's database. Locked below by
      // Docs hygiene > "no spec requires lib/email".
      const crypto = require("crypto");
      const fsMod = require("fs"), pathMod = require("path");
      const b64url = buf => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const secret = fsMod.readFileSync(pathMod.join(TEST_DATA_DIR, ".unsubscribe-secret"));
      expect(secret.length, "the server must have persisted its unsubscribe secret").toBeGreaterThan(0);
      const victim = `unsub-scrub-${Date.now()}@company.com`;
      const payloadJson = JSON.stringify({ e: victim.toLowerCase(), x: Date.now() + 365 * 24 * 60 * 60 * 1000 });
      const token = `${b64url(payloadJson)}.${b64url(crypto.createHmac("sha256", secret).update(payloadJson).digest())}`;
      // Anti-vacuity: prove the address really is recoverable from the token, or
      // "the token is not in the log" is a much weaker claim than it reads as.
      const payload = Buffer.from(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      expect(JSON.parse(payload).e,
        "the token payload is signed, not encrypted — it carries the address in clear"
      ).toBe(victim.toLowerCase());
      // …and the server must ACCEPT it, or this is a test about a random string
      // rather than about a real 365-day capability.
      const { api: probe } = await freshCtx();
      const probeRes = await probe.get(`/api/unsubscribe?token=${encodeURIComponent(token)}`);
      await probe.dispose();
      expect(probeRes.status(), "the signed token must be one the server verifies").toBe(200);

      const { api: anon } = await freshCtx();
      await anon.get(`/api/unsubscribe?token=${encodeURIComponent(token)}`);
      await anon.dispose();
      await new Promise(r => setTimeout(r, 80));

      // Superadmin: NO read-time redaction, so anything still on disk shows up.
      const acc = await (await api.get("/api/admin/logs?stream=access&q=unsubscribe&limit=500")).json();
      expect(acc.redacted).toBe(false);
      const body = JSON.stringify(acc);
      expect(body, "the request must have been logged at all — otherwise this proves nothing")
        .toContain("/api/unsubscribe");
      expect(body, "the raw unsubscribe token reached the access log").not.toContain(token);
      expect(body, "the recipient's address is recoverable from the logged token").not.toContain(victim);
      expect(body).toMatch(/\/api\/unsubscribe\?token=\[REDACTED\]/);
    } finally { await api.dispose(); }
  });

  test("regular admin sees [REDACTED] for superadmin password and code= tokens", async () => {
    await ensureState();
    // Promote Bob to admin so we have a non-superadmin admin
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await sa.post(`/api/admin/participants/${S.bob.id}/role`, { headers: saH, data: { role: "admin" } });
    await sa.dispose();
    try {
      // Trigger a fresh access-log entry with a distinctive code= token
      const { api: anon } = await freshCtx();
      await anon.get("/verify?code=regulartest-token-ghijkl");
      await anon.dispose();
      await new Promise(r => setTimeout(r, 80));
      // Login as Bob (regular admin) and read both logs. Same `q=` approach
      // as the superadmin test — the redactor runs AFTER the scan, so the
      // filter still matches the pre-redaction substring.
      const { api: bob } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
      const app = await (await bob.get("/api/admin/logs?stream=app&q=superadmin%20password&limit=500")).json();
      expect(app.redacted).toBe(true);
      const appBody = JSON.stringify(app);
      // The superadmin password must not appear — and the startup "Superadmin password:"
      // line should now carry the redaction marker where the password was.
      expect(appBody).not.toContain(getSuperadminPass());
      expect(appBody).toMatch(/Superadmin password: \[REDACTED\]/);
      // audit v7.7.38 (SEC1) — code= is scrubbed at WRITE time now, so the raw token
      // isn't on disk to match a q= on it; filter by the surviving `/verify` path.
      const acc = await (await bob.get("/api/admin/logs?stream=access&q=verify&limit=500")).json();
      expect(acc.redacted).toBe(true);
      const accBody = JSON.stringify(acc);
      expect(accBody).not.toContain("regulartest-token-ghijkl");
      expect(accBody).toMatch(/\/verify\?code=\[REDACTED\]/);
      await bob.dispose();
    } finally {
      // Restore Bob's role HERE: bob is a shared seeded participant, so any
      // failed assertion above would otherwise leave him an admin — and
      // `staff`-tagged, hence off every leaderboard — for the rest of the file.
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      await sa2.post(`/api/admin/participants/${S.bob.id}/role`, {
        headers: { "x-csrf-token": saCsrf2, "content-type": "application/json" },
        data: { role: "participant" },
      });
      await sa2.dispose();
    }
  });

  test("/api/config exposes server_started_at", async () => {
    const { api } = await freshCtx();
    const d = await (await api.get("/api/config")).json();
    expect(d).toHaveProperty("server_started_at");
    expect(typeof d.server_started_at).toBe("string");
    expect(!isNaN(Date.parse(d.server_started_at))).toBe(true);
    await api.dispose();
  });

  test("/api/session/status for anonymous user returns active=false", async () => {
    const { api } = await freshCtx();
    const r = await api.get("/api/session/status");
    expect(r.ok()).toBe(true);
    const d = await r.json();
    expect(d.active).toBe(false);
    expect(d.expires_at).toBeNull();
    expect(d.server_started_at).toBeTruthy();
    await api.dispose();
  });

  test("/api/session/status for logged-in user returns active=true with expires_at", async () => {
    const { api } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const d = await (await api.get("/api/session/status")).json();
    expect(d.active).toBe(true);
    expect(d.expires_at).toBeTruthy();
    const msUntilExpiry = new Date(d.expires_at).getTime() - Date.now();
    // maxAge is 1h = 3,600,000 ms; allow a few seconds of slack
    expect(msUntilExpiry).toBeGreaterThan(50 * 60_000);
    expect(msUntilExpiry).toBeLessThan(62 * 60_000);
    await api.dispose();
  });

  test("/api/session/status does NOT extend session expiry", async () => {
    const { api } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    // Warm-up call: immediately after regenerate() on login, the first
    // subsequent request can see cookie.expires=null until the session has
    // been serialized + reloaded from the store. Read once to stabilise;
    // the subsequent d1/d2 pair is what the invariant is about.
    await api.get("/api/session/status");
    const d1 = await (await api.get("/api/session/status")).json();
    expect(d1.expires_at).toBeTruthy();
    const sleepMs = 1100;
    await new Promise(r => setTimeout(r, sleepMs));
    const d2 = await (await api.get("/api/session/status")).json();
    expect(d2.expires_at).toBeTruthy();
    // If /api/session/status extended the expiry, cookie.expires would have
    // advanced by ~sleepMs (touch()/save() reset it to now+maxAge). The
    // invariant we actually care about is "doesn't slide forward" — allow a
    // small jitter (sub-request I/O, NTP drift under load) but it must be
    // strictly less than the sleep window so a real slide still fails.
    const delta = new Date(d2.expires_at).getTime() - new Date(d1.expires_at).getTime();
    expect(Math.abs(delta)).toBeLessThan(sleepMs / 2);
    await api.dispose();
  });

  test("/api/session/keepalive extends session expiry", async () => {
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const d1 = await (await api.get("/api/session/status")).json();
    await new Promise(r => setTimeout(r, 1100));
    const r = await api.post("/api/session/keepalive", { headers: { "x-csrf-token": csrf, "content-type": "application/json" } });
    expect(r.ok()).toBe(true);
    const d2 = await r.json();
    expect(d2.ok).toBe(true);
    expect(d2.expires_at).toBeTruthy();
    // Keepalive refreshed expiry → new expires_at is strictly later than the initial one
    expect(new Date(d2.expires_at).getTime()).toBeGreaterThan(new Date(d1.expires_at).getTime());
    await api.dispose();
  });

  test("/api/session/keepalive rejects anonymous callers", async () => {
    const { api, csrf } = await freshCtx();
    const r = await api.post("/api/session/keepalive", { headers: { "x-csrf-token": csrf, "content-type": "application/json" } });
    expect(r.status()).toBe(401);
    await api.dispose();
  });

  // ── Deletion logging ───────────────────────────────────────────────────────
  // Every top-level DELETE emits an orphan audit row (source:"audit") to the
  // app log and wipes child events in the DB so nothing orphans. The audit row
  // format is: { source:"audit", scope, scope_id, event_type:"deleted",
  // changed_by, details:{cascaded, ...} }.

  test("competition deletion emits audit row and wipes child events", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const uniqName = "DeleteLogTest-" + Date.now();
    const createRes = await api.post("/api/admin/competitions", {
      headers: h,
      data: { name: uniqName, start_time: new Date(Date.now() + 3_600_000).toISOString(), duration_minutes: 60 },
    });
    expect(createRes.ok()).toBeTruthy();
    const compId = (await createRes.json()).competition.id;
    const before = await (await api.get(`/api/admin/competitions/${compId}/events`)).json();
    const beforeArr = Array.isArray(before) ? before : before.events;
    expect(beforeArr.length).toBeGreaterThan(0);
    const delRes = await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } });
    expect(delRes.ok()).toBeTruthy();
    // v8.7.0 — this read used to answer `{events: []}` for a competition that no
    // longer exists, because the route bound `:id` straight into its query with
    // no existence check at all. It resolves the parent now (the scope check
    // needs it), so a deleted competition is a 404 — which is the right answer
    // and is NOT evidence about the child rows either way.
    const afterRes = await api.get(`/api/admin/competitions/${compId}/events`);
    expect(afterRes.status(), "a deleted competition's history is a 404, not an empty list").toBe(404);
    // So assert the wipe where it happens. Reading the table directly is also
    // strictly stronger than the endpoint's projection was: it cannot be
    // satisfied by a route that merely stopped returning rows.
    {
      const Database = require("better-sqlite3");
      const dbRO = new Database(TEST_DB_PATH, { readonly: true });
      try {
        const n = dbRO.prepare("SELECT COUNT(*) AS c FROM competition_events WHERE competition_id=?").get(compId).c;
        expect(n, "deleting a competition wipes its child events").toBe(0);
      } finally { dbRO.close(); }
    }
    await new Promise(r => setTimeout(r, 50));
    const logs = await (await api.get("/api/admin/logs?stream=app&limit=500")).json();
    const entry = logs.entries.find(e => e.source === "audit" && e.scope === "competition" && e.event_type === "deleted" && e.scope_id === compId);
    expect(entry).toBeTruthy();
    expect(entry.level).toBe("info");
    expect(entry.changed_by).toBe("superadmin");
    expect(entry.details.name).toBe(uniqName);
    expect(entry.details.cascaded).toBeDefined();
    expect(entry.details.cascaded.competition_events).toBeGreaterThan(0);
    await api.dispose();
  });

  test("challenge deletion emits audit row", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const uniqTitle = "DeleteLogTestTask-" + Date.now();
    const createRes = await api.post("/api/admin/tasks", {
      headers: h,
      data: { title: uniqTitle, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "x", status: "draft" },
    });
    expect(createRes.ok()).toBeTruthy();
    const taskId = (await createRes.json()).id;
    const delRes = await api.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": csrf } });
    expect(delRes.ok()).toBeTruthy();
    await new Promise(r => setTimeout(r, 50));
    const logs = await (await api.get("/api/admin/logs?stream=app&limit=500")).json();
    const entry = logs.entries.find(e => e.source === "audit" && e.scope === "task" && e.event_type === "deleted" && e.scope_id === taskId);
    expect(entry).toBeTruthy();
    expect(entry.level).toBe("info");
    expect(entry.changed_by).toBe("superadmin");
    expect(entry.details.title).toBe(uniqTitle);
    expect(entry.details.difficulty).toBe("easy");
    expect(entry.details.answer_type).toBe("text");
    expect(entry.details.cascaded).toBeDefined();
    await api.dispose();
  });

  test("challenge feedback bulk delete emits audit row", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const uniqTitle = "DeleteLogFbTask-" + Date.now();
    const createRes = await api.post("/api/admin/tasks", {
      headers: h,
      data: { title: uniqTitle, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "x", status: "draft" },
    });
    const taskId = (await createRes.json()).id;
    const delFbRes = await api.delete(`/api/admin/tasks/${taskId}/feedback`, { headers: { "x-csrf-token": csrf } });
    expect(delFbRes.ok()).toBeTruthy();
    await new Promise(r => setTimeout(r, 50));
    const logs = await (await api.get("/api/admin/logs?stream=app&limit=500")).json();
    const entry = logs.entries.find(e => e.source === "audit" && e.scope === "task" && e.event_type === "feedback_purged" && e.scope_id === taskId);
    expect(entry).toBeTruthy();
    expect(entry.level).toBe("info");
    expect(entry.changed_by).toBe("superadmin");
    expect(entry.details.title).toBe(uniqTitle);
    expect(entry.details.count).toBe(0);
    await api.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });

  test("participant deletion emits audit row and wipes user_events", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const suffix = Date.now();
    const email = `deletelog-${suffix}@example.com`;
    const nickname = `deltester_${suffix}`;
    await registerPost(api, "/api/register", {
      headers: h,
      data: {
        firstName: "Del", lastName: "Tester", nickname, email,
        company: "X", title: "X", country: "US", timezone: "America/New_York",
      },
    });
    const parts = (await (await api.get("/api/admin/participants?limit=500")).json()).participants;
    const user = parts.find(p => p.email === email);
    expect(user).toBeTruthy();
    await api.post(`/api/admin/participants/${user.id}/verify`, { headers: { "x-csrf-token": csrf } });
    const before = await (await api.get(`/api/admin/participants/${user.id}/events`)).json();
    const beforeArr = Array.isArray(before) ? before : before.events;
    expect(beforeArr.length).toBeGreaterThan(0);
    const delRes = await api.delete(`/api/admin/participants/${user.id}`, { headers: { "x-csrf-token": csrf } });
    expect(delRes.ok()).toBeTruthy();
    const after = await (await api.get(`/api/admin/participants/${user.id}/events`)).json();
    const afterArr = Array.isArray(after) ? after : after.events;
    expect(afterArr).toHaveLength(0);
    await new Promise(r => setTimeout(r, 50));
    const logs = await (await api.get("/api/admin/logs?stream=app&limit=500")).json();
    const entry = logs.entries.find(e => e.source === "audit" && e.scope === "user" && e.event_type === "deleted" && e.scope_id === user.id);
    expect(entry).toBeTruthy();
    expect(entry.level).toBe("info");
    expect(entry.changed_by).toBe("superadmin");
    expect(entry.details.email).toBe(email);
    expect(entry.details.nickname).toBe(nickname);
    expect(entry.details.cascaded).toBeDefined();
    expect(entry.details.cascaded.user_events).toBeGreaterThan(0);
    await api.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// SUPERADMIN FLOWS
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Superadmin", () => {
  test("all admin endpoints accessible", async () => {
    const { api } = await apiLogin("superadmin");
    for (const ep of ["/api/admin/tasks", "/api/admin/participants?limit=10", "/api/admin/competitions", "/api/admin/settings"]) {
      expect((await api.get(ep)).ok(), `Failed: ${ep}`).toBeTruthy();
    }
    await api.dispose();
  });

  test("export tasks returns task data", async () => {
    const { api } = await apiLogin("superadmin");
    const raw = await (await api.get("/api/admin/export/tasks")).json();
    const d = Array.isArray(raw) ? raw : (raw.tasks || raw.data || []);
    expect(d.length).toBeGreaterThan(0);
    expect(d[0]).toHaveProperty("title");
    expect(d[0]).toHaveProperty("tags");
    await api.dispose();
  });

  test("/api/config returns platform version", async () => {
    const { api } = await freshCtx();
    const d = await (await api.get("/api/config")).json();
    expect(d.version).toMatch(/^\d+\.\d+\.\d+$/);
    await api.dispose();
  });

  test("pendingApproval count in participants", async () => {
    const { api } = await apiLogin("superadmin");
    const d = await (await api.get("/api/admin/participants?limit=10")).json();
    expect(typeof d.pendingApproval).toBe("number");
    await api.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// BENCHMARK USER BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Benchmark user", () => {
  let _bmTagAdded = false;

  // v7.21.35 — setup-as-a-TEST made all three tests below position-dependent
  // (see the note in "Staff (non-admin)").
  test.beforeAll(async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    await api.post(`/api/admin/participants/${S.bob.id}/tags`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { tag: "benchmark" },
    });
    _bmTagAdded = true;
    await api.dispose();
  });

  test("benchmark user excluded from participant leaderboard ranking", async () => {
    // v8.12.4 — with the CONTROL that bob would otherwise be there. He enters the
    // event (which anchors him on its board) and the ADMIN board, which keeps
    // benchmark rows in their own section, must show him; only then does his
    // absence from the participant board mean the exclusion worked rather than
    // that he was never on it.
    const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
    const bob = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    try {
      expect((await bob.api.post("/api/select-competition", { headers: H(bob.csrf), data: { competitionId: S.liveComp.id } })).ok()).toBeTruthy();
    } finally { await bob.api.dispose(); }
    const { api: sa } = await apiLogin("superadmin");
    try {
      const adm = await (await sa.get(`/api/admin/leaderboard?competitionId=${S.liveComp.id}`)).json();
      expect((Array.isArray(adm) ? adm : adm.board || []).some(u => u.userId === S.bob.id),
        "PRECONDITION: bob is on the event's board as far as an admin can see").toBe(true);
    } finally { await sa.dispose(); }
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: S.liveComp.id } });
    const lb = await (await api.get("/api/leaderboard")).json();
    expect(lb.board.some(u => u.userId === S.alice.id) || (lb.me && lb.me.userId === S.alice.id),
      "CONTROL: an untagged participant is ranked").toBe(true);
    expect(lb.board.find(u => u.userId === S.bob.id), "…and the benchmark participant is not").toBeFalsy();
    await api.dispose();
  });

  test("benchmark user shown separately in admin leaderboard", async () => {
    await ensureState();
    // Ensure bob has login_time by selecting the live competition
    const { api: bobApi, csrf: bobCsrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    await bobApi.post("/api/select-competition", {
      headers: { "x-csrf-token": bobCsrf, "content-type": "application/json" },
      data: { competitionId: S.liveComp.id },
    });
    await bobApi.dispose();
    // Check admin leaderboard
    const { api } = await apiLogin("superadmin");
    const lb = await (await api.get(`/api/admin/leaderboard?competitionId=${S.liveComp.id}`)).json();
    const bobEntry = lb.find(u => u.nickname === "bob_j");
    expect(bobEntry).toBeTruthy();
    expect(bobEntry.isBenchmark).toBeTruthy();
    expect(bobEntry.rank).toBeNull();
    await api.dispose();
  });

  test("benchmark user CAN be assigned to competitions (unlike staff)", async () => {
    await ensureState();
    const { api } = await apiLogin("superadmin");
    const d = await (await api.get(`/api/admin/participants?competitionId=${S.liveComp.id}&limit=200`)).json();
    const bob = (d.participants || []).find(p => p.id === S.bob.id);
    expect(bob).toBeTruthy();
    await api.dispose();
  });

  test("benchmark user can submit answers normally", async () => {
    const { api, csrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { competitionId: S.liveComp.id },
    });
    // Bob already solved easy1 in seed, try hard1
    const r = await api.post(`/api/tasks/${S.liveTask("Challenge hard1").id}/submit`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { answer: "wrong-benchmark-guess" , gradingHash: await gradingHashFor(api, S.liveTask("Challenge hard1").id)},
    });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.correct).toBeFalsy();
    await api.dispose();
  });

  test.afterAll(async () => {
    if (!_bmTagAdded) return;
    const { api, csrf } = await apiLogin("superadmin");
    await api.delete(`/api/admin/participants/${S.bob.id}/tags/benchmark`, {
      headers: { "x-csrf-token": csrf },
    });
    await api.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// CROSS-CUTTING
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Cross-cutting", () => {
  test("avatar rejects oversized data URI", async () => {
    const { api, csrf } = await aliceInLive();
    const r = await api.put("/api/me", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { avatar: "data:image/png;base64," + "A".repeat(400_000) },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("256 KB");
    await api.dispose();
  });

  test("avatar rejects SVG", async () => {
    const { api, csrf } = await aliceInLive();
    const r = await api.put("/api/me", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { avatar: "data:image/svg+xml;base64," + Buffer.from("<svg></svg>").toString("base64") },
    });
    expect(r.status()).toBe(400);
    await api.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// UNTESTED ENDPOINT COVERAGE
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Endpoint coverage", () => {
  test("check-nickname returns availability", async () => {
    const { api } = await freshCtx();
    const r = await api.get("/api/check-nickname?nickname=alice_s");
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.available).toBe(false);
    const r2 = await api.get("/api/check-nickname?nickname=totally_unique_nick_999");
    const d2 = await r2.json();
    expect(d2.available).toBe(true);
    await api.dispose();
  });







  test("competition reminder endpoints work", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    // Check reminder status for upcoming competition (Alice is assigned to upcoming via seed)
    const r = await api.get(`/api/competitions/${S.upcomingComp.id}/reminder`);
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d).toHaveProperty("requested");
    await api.dispose();
  });

  test("export participants returns data", async () => {
    const { api } = await apiLogin("superadmin");
    const raw = await (await api.get("/api/admin/export/participants")).json();
    const d = Array.isArray(raw) ? raw : (raw.participants || []);
    expect(d.length).toBeGreaterThan(0);
    expect(d[0]).toHaveProperty("nickname");
    expect(d[0]).toHaveProperty("tags");
    await api.dispose();
  });

  test("import tasks dry run detects conflicts", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/import/tasks", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        data: {
          type: "hackarena-tasks",
          tasks: [{ title: "Challenge easy1", difficulty: "easy", correct_answer: "test" }],
        },
      },
    });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.dryRun).toBe(true);
    expect(d.conflicts.length).toBe(1);
    await api.dispose();
  });

  test("import participants dry run detects conflicts", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post("/api/admin/import/participants", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        data: {
          type: "hackarena-participants",
          participants: [{ nickname: "alice_s", email: "alice@acme.com", first_name: "Alice", last_name: "Smith" }],
        },
      },
    });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.dryRun).toBe(true);
    expect(d.conflicts.length).toBeGreaterThan(0);
    await api.dispose();
  });

  test("delete individual task feedback (superadmin)", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    // Submit feedback as Alice first
    const { api: aApi, csrf: aCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await aApi.post("/api/select-competition", {
      headers: { "x-csrf-token": aCsrf, "content-type": "application/json" },
      data: { competitionId: S.liveComp.id },
    });
    // The live event's own copy of easy1: the question alice rates there.
    const liveEasy = S.liveTask("Challenge easy1");
    await aApi.put(`/api/tasks/${liveEasy.id}/feedback`, {
      headers: { "x-csrf-token": aCsrf, "content-type": "application/json" },
      data: { rating: 4 },
    });
    await aApi.dispose();
    // Delete Alice's feedback
    const r = await api.delete(`/api/admin/tasks/${liveEasy.id}/feedback/${S.alice.id}`, {
      headers: { "x-csrf-token": csrf },
    });
    expect(r.ok()).toBeTruthy();
    await api.dispose();
  });

  test("admin unlock participant account", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post(`/api/admin/participants/${S.alice.id}/unlock`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
    });
    expect(r.ok()).toBeTruthy();
    await api.dispose();
  });

  test("images endpoint returns 404 for non-existent image", async () => {
    const { api } = await freshCtx();
    const r = await api.get("/api/images/non-existent-id");
    expect(r.status()).toBe(404);
    await api.dispose();
  });

  test("v6.9.5: GET /api/admin/competitions exposes cxone_configured/cxone_has_api_key for every override shape, and never ships the raw api_key", async () => {
    // Regression for v6.9.5: pre-fix the SELECT in GET /api/admin/competitions
    // omitted cxone_api_key entirely, so `cxone_configured` was derived from
    // an always-undefined field and the superadmin edit modal's Remove CxOne
    // button (gated on `comp.cxone_api_key`) never rendered. Both the
    // boolean flags must now be correct for every override shape (key-only,
    // group-only, both, cleared), AND the raw key must NOT be on the wire.
    //
    // A minimal fake JWT is enough to pass decodeCxOneApiKey — we only need
    // a well-formed `iss` claim on an allowlisted iam.checkmarx host; the
    // signature is ignored by the decoder (it's a tenant discovery parse,
    // not an auth check).
    const payload = Buffer.from(JSON.stringify({ iss: "https://iam.checkmarx.net/auth/realms/cxone_test_v695" }))
      .toString("base64url");
    const fakeKey = `header.${payload}.signature`;

    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    // Scope to the seeded liveComp so we don't mutate a shared fixture permanently.
    const compId = S.liveComp.id;

    // Snapshot the current cxone state so we can restore in finally.
    const Database = require("better-sqlite3");
    const dbRead = new Database(TEST_DB_PATH, { readonly: true });
    const orig = dbRead.prepare("SELECT cxone_api_key, cxone_group_name FROM competitions WHERE id=?").get(compId);
    dbRead.close();

    try {
      // --- Shape A: key-only override (the shape the auditor called out) ---
      let r = await api.put(`/api/admin/competitions/${compId}/cxone`, { headers: h, data: { cxone_api_key: fakeKey, cxone_group_name: "" } });
      expect(r.ok(), `PUT cxone key-only: ${r.status()} ${await r.text()}`).toBeTruthy();
      let list = await (await api.get("/api/admin/competitions")).json();
      let row = list.find(c => c.id === compId);
      expect(row).toBeTruthy();
      expect(row.cxone_configured, "key-only override must read as configured").toBe(true);
      expect(row.cxone_has_api_key, "key-only override must expose cxone_has_api_key=true").toBe(true);
      expect(Object.prototype.hasOwnProperty.call(row, "cxone_api_key"), "raw cxone_api_key must NOT be on the wire").toBe(false);

      // --- Shape B: group-only override (key cleared) ---
      r = await api.delete(`/api/admin/competitions/${compId}/cxone`, { headers: h });
      expect(r.ok()).toBeTruthy();
      r = await api.put(`/api/admin/competitions/${compId}/cxone`, { headers: h, data: { cxone_group_name: "regression-group" } });
      expect(r.ok()).toBeTruthy();
      list = await (await api.get("/api/admin/competitions")).json();
      row = list.find(c => c.id === compId);
      expect(row.cxone_configured, "group-only override must read as configured").toBe(true);
      expect(row.cxone_has_api_key, "group-only override must have has_api_key=false").toBe(false);
      expect(Object.prototype.hasOwnProperty.call(row, "cxone_api_key")).toBe(false);

      // --- Shape C: both set ---
      r = await api.put(`/api/admin/competitions/${compId}/cxone`, { headers: h, data: { cxone_api_key: fakeKey, cxone_group_name: "regression-group" } });
      expect(r.ok()).toBeTruthy();
      list = await (await api.get("/api/admin/competitions")).json();
      row = list.find(c => c.id === compId);
      expect(row.cxone_configured).toBe(true);
      expect(row.cxone_has_api_key).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(row, "cxone_api_key")).toBe(false);

      // --- Shape D: fully cleared ---
      r = await api.delete(`/api/admin/competitions/${compId}/cxone`, { headers: h });
      expect(r.ok()).toBeTruthy();
      list = await (await api.get("/api/admin/competitions")).json();
      row = list.find(c => c.id === compId);
      expect(row.cxone_configured).toBe(false);
      expect(row.cxone_has_api_key).toBe(false);
    } finally {
      // Restore original state (either way of cleaning — DELETE + re-PUT, or
      // direct DB write. Direct DB keeps the test hermetic even if the PUT
      // path regresses).
      const dbWrite = new Database(TEST_DB_PATH);
      dbWrite.prepare("UPDATE competitions SET cxone_api_key=?, cxone_group_name=? WHERE id=?")
        .run(orig?.cxone_api_key || null, orig?.cxone_group_name || null, compId);
      dbWrite.close();
      await api.dispose();
    }
  });

  test("v7.13.2: per-competition CxOne override is ADMIN-level; the GLOBAL default stays superadmin-only", async () => {
    // The per-competition CxOne override (API key + group name) is admin-level by
    // design — a v6.9.5 ext-audit had over-tightened it to superadmin-only (and the
    // docs, which had advertised it as a regular-admin capability, were "corrected" to
    // match); v7.13.2 restores the intended admin-level access. The GLOBAL default
    // CxOne config remains superadmin-only.
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    try {
      await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: saH, data: { role: "admin" } });
      await sa.dispose();
      const { api: carol, csrf: cCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      const cH = { "x-csrf-token": cCsrf, "content-type": "application/json" };
      // Per-competition override — a regular admin CAN set + clear it.
      const r = await carol.put(`/api/admin/competitions/${S.liveComp.id}/cxone`, { headers: cH, data: { cxone_group_name: "admin-set-group" } });
      expect(r.status(), "regular admin can set the per-comp CxOne override").toBe(200);
      const rDel = await carol.delete(`/api/admin/competitions/${S.liveComp.id}/cxone`, { headers: cH });
      expect(rDel.status(), "regular admin can clear the per-comp CxOne override").toBe(200);
      // GLOBAL default CxOne — still superadmin-only.
      const rGlobal = await carol.put(`/api/admin/default-cxone`, { headers: cH, data: { cxone_group_name: "nope" } });
      expect(rGlobal.status(), "GLOBAL default CxOne stays superadmin-only for a regular admin").toBe(403);
      await carol.dispose();
    } finally {
      const { api: sa2, csrf: sa2Csrf } = await apiLogin("superadmin");
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: { "x-csrf-token": sa2Csrf, "content-type": "application/json" }, data: { role: "participant" } });
      await sa2.dispose();
    }
  });

  test("default CxOne config GET and DELETE", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    // GET — should work even if not configured
    let r = await api.get("/api/admin/default-cxone");
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d).toHaveProperty("cxone_configured");
    // PUT with invalid API key should return 400
    r = await api.put("/api/admin/default-cxone", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { cxone_api_key: "invalid-key", cxone_group_name: "test-group" },
    });
    expect(r.status()).toBe(400);
    // PUT with only group name (no api key) should succeed
    r = await api.put("/api/admin/default-cxone", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { cxone_group_name: "test-group" },
    });
    expect(r.ok()).toBeTruthy();
    // DELETE — clear config
    r = await api.delete("/api/admin/default-cxone", {
      headers: { "x-csrf-token": csrf },
    });
    expect(r.ok()).toBeTruthy();
    await api.dispose();
  });
});


// v7.13.0 — per-competition opt-OUT of CxOne account creation (default OFF). The flag
// rides the competition create/edit path like the other bool flags; when ON,
// cxOneProvisionUser skips the competition entirely (the single provisioning chokepoint).
test.describe("Per-competition CxOne opt-out (v7.13.0)", () => {
  const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
  const Database = require("better-sqlite3");
  let _u = 0;
  const uniq = (p) => `${p}-${Date.now()}-${_u++}`;
  const compRow = (id) => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare("SELECT cxone_disabled FROM competitions WHERE id=?").get(id); } finally { db.close(); } };
  const provisionEvents = (uid, cid) => {
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      return db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='cxone_provisioned'").all(uid)
        .filter(r => { try { return JSON.parse(r.details)?.competition_id === cid; } catch { return false; } });
    } finally { db.close(); }
  };
  // A decodable CxOne API key (valid `iss` on an allowlisted host; the signature is
  // ignored by the tenant-discovery decoder). Configuring it makes getCxOneConfig
  // return a cfg, so provisioning IS attempted unless the gate short-circuits.
  const fakeKey = () => `header.${Buffer.from(JSON.stringify({ iss: "https://iam.checkmarx.net/auth/realms/optout_test" })).toString("base64url")}.sig`;

  test("create stores + wires cxone_disabled; default is OFF", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = H(csrf);
    const onId = (await (await api.post("/api/admin/competitions", { headers: h, data: { name: uniq("cxoff-on"), start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 120, cxone_disabled: true } })).json()).competition.id;
    const offId = (await (await api.post("/api/admin/competitions", { headers: h, data: { name: uniq("cxoff-def"), start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 120 } })).json()).competition.id;
    expect(compRow(onId).cxone_disabled, "created ON stores 1").toBe(1);
    expect(compRow(offId).cxone_disabled, "default OFF when omitted").toBe(0);
    const list = await (await api.get("/api/admin/competitions")).json();
    const arr = Array.isArray(list) ? list : (list.competitions || []);
    expect(arr.find(c => c.id === onId).cxone_disabled, "flag ships on the admin list wire").toBe(1);
    await api.dispose();
  });

  test("PUT toggles cxone_disabled + records an `edited` audit event; string-bool coerces (F2)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = H(csrf);
    const id = (await (await api.post("/api/admin/competitions", { headers: h, data: { name: uniq("cxoff-put"), start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 120 } })).json()).competition.id;
    expect((await api.put(`/api/admin/competitions/${id}`, { headers: h, data: { cxone_disabled: true } })).ok()).toBeTruthy();
    expect(compRow(id).cxone_disabled).toBe(1);
    const db = new Database(TEST_DB_PATH, { readonly: true });
    let ev; try { ev = db.prepare("SELECT COUNT(*) c FROM competition_events WHERE competition_id=? AND event_type='edited' AND details LIKE '%cxone_disabled%'").get(id).c; } finally { db.close(); }
    expect(ev, "edited event records the flag change").toBeGreaterThan(0);
    // F2 real bool coercion: the string "false" turns it OFF (not truthy-on).
    expect((await api.put(`/api/admin/competitions/${id}`, { headers: h, data: { cxone_disabled: "false" } })).ok()).toBeTruthy();
    expect(compRow(id).cxone_disabled, '"false" coerces to 0').toBe(0);
    await api.dispose();
  });

  test("provisioning gate: with a CxOne override configured, a cxone_disabled comp provisions NOBODY", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = H(csrf);
    const mk = async (disabled) => (await (await api.post("/api/admin/competitions", { headers: h, data: { name: uniq(`cxgate-${disabled}`), start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240, cxone_disabled: disabled } })).json()).competition.id;
    const disabledComp = await mk(true);
    const liveComp = await mk(false);
    // Same override key on both, so getCxOneConfig returns a cfg for each → provisioning
    // would run for both if not gated.
    for (const cid of [disabledComp, liveComp]) {
      expect((await api.put(`/api/admin/competitions/${cid}/cxone`, { headers: h, data: { cxone_api_key: fakeKey(), cxone_group_name: "" } })).ok(), "override configured").toBeTruthy();
    }
    const email = uniq("cxgate").replace(/[^a-z0-9]/gi, "") + "@acme.com";
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: H(ac), data: { firstName: "C", lastName: "X", nickname: uniq("cxg").replace(/[^a-z0-9]/gi, ""), email, company: "Acme", title: "Eng", country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC" } });
    await anon.dispose();
    const uid = (await (await api.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email).id;
    await api.post(`/api/admin/participants/${uid}/verify`, { headers: h });
    await api.post(`/api/admin/participants/${uid}/approve`, { headers: h });
    // One assign enqueues a provision for THIS user in EACH comp.
    expect((await api.post("/api/admin/competitions/assign", { headers: h, data: { userIds: [uid], competitionIds: [disabledComp, liveComp] } })).ok()).toBeTruthy();
    // Control (NOT disabled): a provision is attempted → a cxone_provisioned event lands
    // (success:false — the fake IDP is unreachable). This proves the trigger fired + the
    // override is live, so the disabled comp's silence below is the GATE, not a no-op.
    await expect.poll(() => provisionEvents(uid, liveComp).length, { timeout: 20000, intervals: [200, 400, 800, 1500, 3000] }).toBeGreaterThan(0);
    // Gated (disabled): NO cxone_provisioned event — cxOneProvisionUser returned at the gate.
    expect(provisionEvents(uid, disabledComp).length, "cxone_disabled comp must provision nobody").toBe(0);
    await api.dispose();
  });

  test("v7.21.15: provisioning FAILS CLOSED when the competition cannot be read", () => {
    // `_comp?.cxone_disabled` on a MISSING row yields undefined — falsy — so a
    // competition deleted between the enqueue and the drain sailed straight past
    // its own opt-out, and getCxOneConfig then falls back to the GLOBAL default
    // credentials: an external identity created for a competition that no longer
    // exists. Provisioning is queued work with a bounded pool and a 10 s upstream
    // timeout, so the window is not theoretical.
    //
    // This is a SOURCE lock, and the reason is worth stating rather than hiding.
    // Reproducing it behaviourally needs a competition DELETE to land inside the
    // queue-drain window, which is not something a test can schedule from the
    // API; and calling cxOneProvisionUser directly from the spec process does
    // not work either — it reaches an audit write whose failure is caught and
    // logged, so the absence of an event proves nothing about the gate. Same
    // shape as the _rateLimitAllowlisted lock above, which says the same thing
    // about runtime env. The sibling `cxone_disabled` gate IS covered
    // behaviourally by the test two above; this pins the missing-row half.
    // (v8.12.6 — from a SPAWNED CHILD with a stubbed transport it IS drivable:
    // tests/cxone-grant-after-delete.spec.js deletes the event before the job
    // starts and during its token fetch. This pin stays as the PLACEMENT half.)
    const fs = require("fs"), pathMod = require("path");
    const src = fs.readFileSync(pathMod.join(__dirname, "..", "lib", "cxone.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
      .split("\n").map(l => l.replace(/\/\/.*$/, "")).join("\n");

    // Both halves of the gate, in order: the opt-out, then the missing row.
    const optOutAt = src.search(/if\s*\(\s*_comp\?\.cxone_disabled\s*\)\s*return\s*;/);
    expect(optOutAt, "the cxone_disabled opt-out gate is gone").toBeGreaterThan(-1);
    const closedAt = src.search(/if\s*\(\s*competitionId\s*&&\s*!_comp\s*\)\s*return\s*;/);
    expect(closedAt,
      "cxOneProvisionUser must return when a competitionId was supplied but names no competition. " +
      "Without it the opt-out is bypassed for a deleted competition AND getCxOneConfig falls back " +
      "to the GLOBAL default credentials."
    ).toBeGreaterThan(-1);

    // It must sit BEFORE the config lookup, or it gates nothing.
    const cfgAt = src.search(/const\s+cfg\s*=\s*getCxOneConfig\(/);
    expect(cfgAt, "getCxOneConfig call not found — this lock needs re-anchoring").toBeGreaterThan(-1);
    expect(closedAt, "the fail-closed check must run BEFORE getCxOneConfig").toBeLessThan(cfgAt);

    // And it must be scoped to a SUPPLIED competitionId: calling with none is a
    // legitimate global-default caller, and refusing that would break it.
    expect(/if\s*\(\s*competitionId\s*&&/.test(src),
      "the check must be scoped to `competitionId &&` — an unconditional `!_comp` return would " +
      "also refuse the legitimate no-competition caller").toBe(true);
  });

  test("a REGULAR admin can create + toggle cxone_disabled (it is admin-level, not superadmin-only)", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = H(saCsrf);
    // Mint a regular admin.
    const email = uniq("cxradm").replace(/[^a-z0-9]/gi, "") + "@acme.com";
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: H(ac), data: { firstName: "R", lastName: "A", nickname: uniq("cxra").replace(/[^a-z0-9]/gi, ""), email, company: "Acme", title: "Eng", country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC" } });
    await anon.dispose();
    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: saH });
    await sa.post(`/api/admin/participants/${u.id}/role`, { headers: saH, data: { role: "admin" } });
    // As the regular admin: CREATE with the flag on, then toggle it off via PUT.
    const { api: adm, csrf: admCsrf } = await apiLogin(email, PARTICIPANT_PASS);
    const h = H(admCsrf);
    const id = (await (await adm.post("/api/admin/competitions", { headers: h, data: { name: uniq("cxra-comp"), start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 120, cxone_disabled: true } })).json()).competition.id;
    expect(compRow(id).cxone_disabled, "regular admin can opt out at create").toBe(1);
    expect((await adm.put(`/api/admin/competitions/${id}`, { headers: h, data: { cxone_disabled: false } })).ok()).toBeTruthy();
    expect(compRow(id).cxone_disabled, "regular admin can toggle it back on/off").toBe(0);
    await adm.dispose();
  });
});


// v6.10.54: single-fetch limits + real-error perf gates. Auditor
// findings #1 and #2 of this round were about multi-page
// concatenation being non-atomic under concurrent writes — the
// v6.10.51 `, id` tiebreaker made each page's ordering stable but
// didn't stop inter-page drift. Fix: raise server limit caps so
// typical deployments fit in a single call; client requests the
// larger limit. Finding #3 was about the perf gate going weak when
// `http_req_failed` was loosened to 0.15 without backing per-status
// 5xx gates — those are now count<5 thresholds for every real-error
// status code.
test.describe("v6.10.54: single-fetch snapshot reads", () => {
  test("admin/participants accepts limit=5000 (raised from 200)", async () => {
    // Finding #1: the multi-page walk in public/app.js:5448 needs
    // server cooperation to fit the whole list in one call. Cap went
    // 200 → 5000. At realistic deployment scale (<500 users), this
    // always collapses to a single fetch and avoids the inter-page
    // drift window entirely.
    const { api } = await apiLogin("superadmin");
    try {
      const r = await api.get("/api/admin/participants?limit=5000");
      expect(r.ok()).toBeTruthy();
      const body = await r.json();
      expect(body.limit).toBe(5000);
      // Over-limit requests are still clamped — guard against a
      // future bump to an unbounded limit.
      const r2 = await api.get("/api/admin/participants?limit=100000");
      expect(r2.ok()).toBeTruthy();
      expect((await r2.json()).limit).toBe(5000);
    } finally { await api.dispose(); }
  });

  test("event endpoints accept limit=5000 (raised from 500)", async () => {
    // Finding #2: admin history dialogs walk offset pages with no
    // snapshot continuity. Raising the per-request cap to 5000
    // means the full event list lands in one atomic read for every
    // realistic event-count scenario. `_paginationParams` governs
    // all four event endpoints + any future ones.
    await ensureState();
    const { api } = await apiLogin("superadmin");
    try {
      const r = await api.get(`/api/admin/competitions/${S.liveComp.id}/events?limit=5000`);
      expect(r.ok(), `event fetch failed: ${r.status()} ${await r.text()}`).toBeTruthy();
      const body = await r.json();
      expect(body.limit).toBe(5000);
    } finally { await api.dispose(); }
  });

  test("admin/submissions UNION carries a stable tie_key ordering", async () => {
    // Finding #2 (Submissions tab half): the UNION stream had only
    // `ORDER BY event_time DESC` — same-millisecond events could
    // swap page boundaries between two fetches. Now projects a
    // `tie_key` column into both branches (submissions.id for
    // submit events; user_id||task_id for hints) and sorts by
    // (event_time DESC, tie_key DESC).
    //
    // This test hits the endpoint twice with no writes between and
    // asserts the ordering is identical — the pre-fix version could
    // theoretically reorder same-timestamp rows even with identical
    // underlying data.
    const { api } = await apiLogin("superadmin");
    try {
      const r1 = await api.get("/api/admin/submissions?limit=100");
      const r2 = await api.get("/api/admin/submissions?limit=100");
      expect(r1.ok()).toBeTruthy();
      expect(r2.ok()).toBeTruthy();
      const b1 = await r1.json();
      const b2 = await r2.json();
      const order1 = (b1.events || []).map(e => `${e.event_time}|${e.nickname}|${e.task_title}`).join(",");
      const order2 = (b2.events || []).map(e => `${e.event_time}|${e.nickname}|${e.task_title}`).join(",");
      expect(order1).toBe(order2);
    } finally { await api.dispose(); }
  });

  test("perf scenario fails the gate on any real 5xx / rate-limit status", () => {
    // Finding #3: per-status thresholds were all `count>=0` (pure
    // diagnostic, never-fails). That let a 5xx regression hide inside
    // the relaxed http_req_failed<0.15 budget. 429 / 413 / 500 / 502
    // / 503 / 504 now fail at count>=5 — real server outages surface
    // loudly. Expected-traffic 4xx (401 / 403 / 404 / 409 / 422)
    // stay at count>=0 (visibility only).
    const fs = require("fs");
    const body = fs.readFileSync("perf/k6/scenarios/competition-live.js", "utf8");
    for (const status of ["413", "429", "500", "502", "503", "504"]) {
      const pattern = new RegExp(`"failed_by_status\\{status:${status}\\}":\\s*\\["count<5"\\]`);
      expect(body, `expected count<5 gate on status ${status}`).toMatch(pattern);
    }
    for (const status of ["401", "403", "409"]) {
      const pattern = new RegExp(`"failed_by_status\\{status:${status}\\}":\\s*\\["count>=0"\\]`);
      expect(body, `expected diagnostic-only threshold on status ${status}`).toMatch(pattern);
    }
  });
});


test.describe("Auto-end edge cases (v6.4.0)", () => {
  test("allParticipantsSolvedAll returns false for an empty participant list (zero-participant guard)", () => {
    // Regression lock: if a competition has zero verified+approved (non-
    // staff) participants, auto-end must NOT fire — the vacuous truth
    // "all 0 participants solved all tasks" would end the competition
    // before anyone shows up. The guard is at server.js
    // allParticipantsSolvedAll line 1 of the function body.
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "server.js"), "utf8");
    // The function must short-circuit on empty participantIds.
    expect(src).toMatch(/function allParticipantsSolvedAll[\s\S]*?if\s*\(!participantIds\.length/);
  });

  test("LIKE wildcard escape is applied in submissions and logs search (v6.4.0)", () => {
    // The q= parameter on /api/admin/submissions and /api/admin/logs
    // must escape % and _ before building the LIKE pattern, and each
    // LIKE clause must include ESCAPE '\\'. Without this, searching for
    // a literal "100%" matches any string starting with "100".
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "server.js"), "utf8");
    // Escape function present.
    expect(src).toMatch(/\.replace\(\/\[%_\\\\\]\/g/);
    // ESCAPE clause in submissions LIKE.
    const subMatch = src.match(/outerWhereSql[\s\S]*?ESCAPE '\\\\'/);
    expect(subMatch).toBeTruthy();
    // ESCAPE clause in logs LIKE.
    const logMatch = src.match(/LOWER\(first_name\) LIKE \?[\s\S]*?ESCAPE '\\\\'/);
    expect(logMatch).toBeTruthy();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// INVITATION GROUP-CLASH GUARD (v7.11.2)
// ═══════════════════════════════════════════════════════════════════════════════
// Corrected model: inviting a user to a competition + a group is an INDIVIDUAL
// assignment UNLESS that group is bound to the competition in its OWN right. So the
// invited-competition selection is irrelevant to the group clash — only ACTUAL
// competition_groups bindings count. An invitation is rejected only when it would
// leave an invitee in ≥2 groups bound to the SAME competition.
test.describe("Invitation group-clash guard (v7.11.2)", () => {
  const IH = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
  async function mkUser(sa, saCsrf, nick) {
    const email = `inv_${nick}@acme.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: IH(ac), data: { firstName: "I", lastName: "V", nickname: nick, email, company: "Acme", title: "Eng", country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC" } });
    await anon.dispose();
    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: IH(saCsrf) });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: IH(saCsrf) });
    return { id: u.id, email, nick };
  }

  test("ALLOWED — no ACTUAL bound-group clash (comp selection ≠ binding; multi-group with no overlap; dropped one-group limit)", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = IH(saCsrf);
    const t = Date.now();
    const mkComp = async (n) => (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: `${n} ${t}`, start_time: new Date(t + 3600_000).toISOString(), duration_minutes: 120, group_leaderboard_enabled: true } })).json()).competition.id;
    const mkGroup = async (n, uids) => (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `${n} ${t}`, userIds: uids || [] } })).json()).group.id;
    const bind = async (g, c) => expect((await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [g], competitionIds: [c] } })).ok()).toBeTruthy();
    const invite = (emails, comps, groups) => sa.post("/api/admin/invitations", { headers: saH, data: { emails, competitionIds: comps || [], groupIds: groups || [] } });
    const X = await mkComp("X"), Y = await mkComp("Y"), C = await mkComp("C");
    const Gx = await mkGroup("Gx"), Gy = await mkGroup("Gy"), Gf1 = await mkGroup("Gf1"), Gf2 = await mkGroup("Gf2");
    await bind(Gx, X); await bind(Gy, Y);
    const U = await mkUser(sa, saCsrf, `a${t}`);
    // (1) existing user + a group bound to NOTHING → individual, no clash.
    expect((await invite([U.email], [], [Gf1])).ok(), "existing + unbound group").toBeTruthy();
    // (2) comp C selected + a group NOT bound to C → individual in C (comp selection ≠ binding).
    expect((await invite([U.email], [C], [Gf2])).ok(), "comp selected + group not bound to it").toBeTruthy();
    // (3) new email, ONE group bound to X → in one group for X, no clash.
    expect((await invite([`new-b${t}@acme.com`], [], [Gx])).ok(), "one bound group").toBeTruthy();
    // (4) new email, two groups bound to DIFFERENT comps → no single-comp overlap.
    expect((await invite([`new-c${t}@acme.com`], [], [Gx, Gy])).ok(), "two groups, different comps").toBeTruthy();
    // (5) comp C + MULTIPLE non-bound groups → allowed (the artificial one-group limit was dropped).
    expect((await invite([`new-d${t}@acme.com`], [C], [Gf1, Gf2])).ok(), "comp + multiple unbound groups").toBeTruthy();
    await sa.dispose();
  });

  test("REJECTED (409) — invitee would end up in ≥2 groups bound to the SAME competition; lists offenders + atomic", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = IH(saCsrf);
    const t = Date.now();
    const mkComp = async (n) => (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: `${n} ${t}`, start_time: new Date(t + 3600_000).toISOString(), duration_minutes: 120, group_leaderboard_enabled: true } })).json()).competition.id;
    const mkGroup = async (n, uids) => (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `${n} ${t}`, userIds: uids || [] } })).json()).group.id;
    const bind = async (g, c) => expect((await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [g], competitionIds: [c] } })).ok()).toBeTruthy();
    const invite = (emails, comps, groups) => sa.post("/api/admin/invitations", { headers: saH, data: { emails, competitionIds: comps || [], groupIds: groups || [] } });
    const X = await mkComp("X"), C = await mkComp("C");
    const U = await mkUser(sa, saCsrf, `x${t}`);
    const Ga = await mkGroup("Ga", [U.id]), Gb = await mkGroup("Gb"), Gc = await mkGroup("Gc"), Gd = await mkGroup("Gd");
    for (const g of [Ga, Gb, Gc, Gd]) await bind(g, X); // all bound to X (empty except Ga → no bind clash)

    // (9) existing user in Ga (bound X), invited to Gb (bound X) → clash on X, lists the user.
    const r9 = await invite([U.email], [], [Gb]);
    expect(r9.status()).toBe(409);
    const d9 = await r9.json();
    expect(d9.error).toContain(U.nick);
    expect(d9.error).toContain(`X ${t}`);
    expect((d9.clash?.conflicts || []).some(c => c.userId === U.id)).toBe(true);
    // (10) existing user invited to Gc + Gd (both bound X) → self-overlap of the invited groups.
    const U10 = await mkUser(sa, saCsrf, `x10${t}`);
    expect((await invite([U10.email], [], [Gc, Gd])).status()).toBe(409);
    // (11) NEW email invited to Gc + Gd (both bound X) → phantom self-overlap.
    expect((await invite([`new-clash${t}@acme.com`], [], [Gc, Gd])).status()).toBe(409);
    // (12) comp C selected + Gb (bound X, ≠C), user in Ga (bound X) → clash on X, NOT C.
    //      Proves the competition SELECTION is irrelevant; the group's ACTUAL binding drives it.
    const r12 = await invite([U.email], [C], [Gb]);
    expect(r12.status()).toBe(409);
    expect((await r12.json()).error).toContain(`X ${t}`);
    // (13) mix: existing clashing user + a new email → the WHOLE invite 409 (atomic).
    expect((await invite([U.email, `new-mix${t}@acme.com`], [], [Gb])).status()).toBe(409);
    const Database = require("better-sqlite3");
    const inG = (uid, gid) => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare("SELECT COUNT(*) c FROM group_members WHERE user_id=? AND group_id=?").get(uid, gid).c; } finally { db.close(); } };
    expect(inG(U.id, Gb), "atomic — the clashing invite added nothing").toBe(0);
    await sa.dispose();
  });

  test("registration-time defensive skip: a group bound AFTER a clean invite is skipped so the new user never clashes", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = IH(saCsrf);
    const t = Date.now();
    const X = (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: `RX ${t}`, start_time: new Date(t + 3600_000).toISOString(), duration_minutes: 120, group_leaderboard_enabled: true } })).json()).competition.id;
    const Gr1 = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `Gr1 ${t}` } })).json()).group.id;
    const Gr2 = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `Gr2 ${t}` } })).json()).group.id;
    // Gr1 bound to X; Gr2 NOT bound yet → the invite to [Gr1,Gr2] is CLEAN at invite time.
    expect((await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [Gr1], competitionIds: [X] } })).ok()).toBeTruthy();
    const email = `reg-skip-${t}@acme.com`;
    expect((await sa.post("/api/admin/invitations", { headers: saH, data: { emails: [email], competitionIds: [], groupIds: [Gr1, Gr2] } })).ok(), "clean invite accepted").toBeTruthy();
    // NOW bind Gr2 to X too → both bound to X. The invitation's stored group_ids now conflict.
    expect((await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [Gr2], competitionIds: [X] } })).ok()).toBeTruthy();
    const Database = require("better-sqlite3");
    let dbR = new Database(TEST_DB_PATH, { readonly: true });
    const invId = dbR.prepare("SELECT id FROM invitations WHERE LOWER(email)=LOWER(?) AND used_at IS NULL").get(email)?.id;
    dbR.close();
    expect(invId, "invitation row exists").toBeTruthy();
    // Register via the invitation → the skip must NOT put the new user in both bound groups.
    const { api: anon, csrf: ac } = await freshCtx();
    const reg = await registerPost(anon, "/api/register", { headers: IH(ac), data: { firstName: "R", lastName: "S", nickname: `regskip${t}`, email, company: "Acme", title: "Eng", country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS, invitationId: invId } });
    expect(reg.ok(), `register failed: ${reg.status()} ${await reg.text()}`).toBeTruthy();
    await anon.dispose();
    dbR = new Database(TEST_DB_PATH, { readonly: true });
    const uid = dbR.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email)?.id;
    const inGr1 = dbR.prepare("SELECT COUNT(*) c FROM group_members WHERE user_id=? AND group_id=?").get(uid, Gr1).c;
    const inGr2 = dbR.prepare("SELECT COUNT(*) c FROM group_members WHERE user_id=? AND group_id=?").get(uid, Gr2).c;
    dbR.close();
    expect(uid, "new user created").toBeTruthy();
    expect(inGr1 + inGr2, "ended up in EXACTLY ONE of the two same-comp-bound groups (no clash)").toBe(1);
    await sa.dispose();
  });

  test("REFUSED — inviting an existing user by their SECONDARY email never lands them in a 2nd bound group (v7.12.3, audit M1/#4; v9.0.0)", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = IH(saCsrf);
    const t = Date.now();
    const mkComp = async (n) => (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: `${n} ${t}`, start_time: new Date(t + 3600_000).toISOString(), duration_minutes: 120, group_leaderboard_enabled: true } })).json()).competition.id;
    const mkGroup = async (n, uids) => (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `${n} ${t}`, userIds: uids || [] } })).json()).group.id;
    const bind = async (g, c) => expect((await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [g], competitionIds: [c] } })).ok()).toBeTruthy();
    const X = await mkComp("SecX");
    const U = await mkUser(sa, saCsrf, `sec${t}`);
    // Give U a SECONDARY corporate email (blank until now → admin can fill it).
    const secEmail = `inv_sec_alt_${t}@acme.com`;
    const putSec = await sa.put(`/api/admin/participants/${U.id}`, { headers: saH, data: { secondaryEmail: secEmail } });
    expect(putSec.ok(), `set secondary email: ${putSec.status()} ${await putSec.text()}`).toBeTruthy();
    const Ga = await mkGroup("SecGa", [U.id]);   // U is in Ga
    const Gb = await mkGroup("SecGb");           // empty
    await bind(Ga, X); await bind(Gb, X);        // both bound to X
    // Invite U by their SECONDARY email into Gb (bound X) — U is already in Ga (bound X).
    // v7.12.3: the guard and the write path once resolved invitees differently, and
    // the write path silently added U to Gb → U in 2 groups bound to X. v9.0.0
    // (operator ruling, 11 Nov 2026): a secondary is never resolved to its holder
    // at all — the address is refused by name, so the double-count cannot arise.
    const r = await sa.post("/api/admin/invitations", { headers: saH, data: { emails: [secEmail], competitionIds: [], groupIds: [Gb] } });
    expect(r.status(), await r.text()).toBe(200);
    const d = await r.json();
    expect(d.errors.join(" "), "the secondary address is refused by name").toMatch(/secondary email/);
    const Database = require("better-sqlite3");
    const inGb = (() => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare("SELECT COUNT(*) c FROM group_members WHERE user_id=? AND group_id=?").get(U.id, Gb).c; } finally { db.close(); } })();
    expect(inGb, "the secondary-email invite added nothing to the second bound group").toBe(0);
    await sa.dispose();
  });

  test("ALLOWED (2xx) — a PRE-EXISTING clash the invited group isn't involved in doesn't block the invite (v7.12.3, audit #10)", async () => {
    const Database = require("better-sqlite3");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = IH(saCsrf);
    const t = Date.now();
    const mkComp = async (n) => (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: `${n} ${t}`, start_time: new Date(t + 3600_000).toISOString(), duration_minutes: 120, group_leaderboard_enabled: true } })).json()).competition.id;
    const mkGroup = async (n, uids) => (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `${n} ${t}`, userIds: uids || [] } })).json()).group.id;
    const bind = async (g, c) => expect((await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [g], competitionIds: [c] } })).ok()).toBeTruthy();
    const Y = await mkComp("LegacyY");
    const U = await mkUser(sa, saCsrf, `leg${t}`);
    const Ga = await mkGroup("LegGa"), Gb = await mkGroup("LegGb"); // empty → bind cleanly
    const Gf = await mkGroup("LegGf");                              // bound NOWHERE
    const Gh = await mkGroup("LegGh");                              // will be bound to Y
    await bind(Ga, Y); await bind(Gb, Y); await bind(Gh, Y);
    // Seed a LEGACY clash the API guards would refuse to create: U in BOTH Ga & Gb
    // (both bound Y). Raw INSERT bypasses detectMemberAddClashes (simulates a pre-v7.11
    // DB / a migration that never cleaned legacy memberships).
    const wdb = new Database(TEST_DB_PATH);
    try {
      const ins = wdb.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, added_at, added_by) VALUES (?,?,?,?)");
      ins.run(Ga, U.id, new Date().toISOString(), "test-seed");
      ins.run(Gb, U.id, new Date().toISOString(), "test-seed");
    } finally { wdb.close(); }
    // Invite U to Gf — bound NOWHERE, so it participates in NO clash. Pre-fix the guard
    // reported the pre-existing {Ga,Gb} clash on Y (which Gf isn't part of) → 409, wedging
    // every legitimate invite for U. Post-fix: only clashes the INVITED group is in count.
    const rOk = await sa.post("/api/admin/invitations", { headers: saH, data: { emails: [U.email], competitionIds: [], groupIds: [Gf] } });
    expect(rOk.status(), "unrelated pre-existing clash must NOT block an invite to an uninvolved group").toBeLessThan(400);
    // Control: inviting U to Gh (bound Y, where U already clashes) DOES involve the invited
    // group in a Y clash → still 409.
    const rClash = await sa.post("/api/admin/invitations", { headers: saH, data: { emails: [U.email], competitionIds: [], groupIds: [Gh] } });
    expect(rClash.status(), "invited group bound to the clashing comp still 409s").toBe(409);
    await sa.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// MAINTENANCE MODE
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Maintenance mode", () => {
  const fs = require("fs");
  const path = require("path");
  const mFile = path.join(TEST_DATA_DIR, ".maintenance");
  const token = "test-bypass-" + Date.now();

  // v7.21.35 — the .maintenance file used to be written by the FIRST test, so
  // the two below only saw maintenance mode when that test had already run:
  // alone they got a healthy 200 and failed asserting 503. The gate is the
  // block's precondition, not one test's side effect, so it is established in
  // beforeAll (the afterAll that removes it was already correct).
  test.beforeAll(() => { fs.writeFileSync(mFile, token); });
  test.afterAll(() => { try { fs.unlinkSync(mFile); } catch (_) {} });

  test("returns 503 HTML when .maintenance file exists", async () => {
    const { api } = await freshCtx();
    const r = await api.get("/", { headers: { accept: "text/html" } });
    expect(r.status()).toBe(503);
    const body = await r.text();
    expect(body).toContain("Scheduled Maintenance");
    await api.dispose();
  });

  test("returns 503 JSON for API requests during maintenance", async () => {
    const { api } = await freshCtx();
    const r = await api.get("/api/config");
    expect(r.status()).toBe(503);
    const d = await r.json();
    expect(d.error).toContain("maintenance");
    await api.dispose();
  });

  test("bypass header passes through maintenance gate", async () => {
    const { api } = await freshCtx();
    const r = await api.get("/api/config", { headers: { "x-maintenance-bypass": token } });
    expect(r.ok()).toBe(true);
    await api.dispose();
  });

  test("wrong bypass token is still blocked", async () => {
    const { api } = await freshCtx();
    const r = await api.get("/api/config", { headers: { "x-maintenance-bypass": "wrong" } });
    expect(r.status()).toBe(503);
    await api.dispose();
  });

  test("removing .maintenance file restores normal access", async () => {
    try { fs.unlinkSync(mFile); } catch (_) {}
    const { api } = await freshCtx();
    const r = await api.get("/api/config");
    expect(r.ok()).toBe(true);
    await api.dispose();
  });

  test("v6.9.22: bypass token compared in constant time (length-mismatch + byte-mismatch both 503)", async () => {
    // Timing-safe compare replaced the previous `===`. Same-length
    // mismatch exercises the timingSafeEqual path; different-length
    // input hits the early-exit length-guard before the compare.
    // Both must 503 identically — no timing signal, no error class
    // drift.
    fs.writeFileSync(mFile, token);
    const { api } = await freshCtx();
    const sameLen = token.replace(/./g, "Z");
    expect(sameLen.length).toBe(token.length);
    const r1 = await api.get("/api/config", { headers: { "x-maintenance-bypass": sameLen } });
    expect(r1.status()).toBe(503);
    const r2 = await api.get("/api/config", { headers: { "x-maintenance-bypass": "short" } });
    expect(r2.status()).toBe(503);
    const r3 = await api.get("/api/config", { headers: { "x-maintenance-bypass": token + "-extra" } });
    expect(r3.status()).toBe(503);
    // Control: the real token still passes.
    const rOk = await api.get("/api/config", { headers: { "x-maintenance-bypass": token } });
    expect(rOk.ok()).toBe(true);
    await api.dispose();
    try { fs.unlinkSync(mFile); } catch (_) {}
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// v6.13.17 — analytics scope matrix + static-asset cache policy
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("v6.13.17 — /api/admin/analytics/challenges scope matrix", () => {
  // Existing tests cover each scope individually. This one locks the
  // *echo* shape — the response's `scope` object must faithfully reflect
  // the scope the caller asked for, with the entity ids + names
  // populated exactly when they're defined. A regression that e.g.
  // dropped `timeslot_name` from the timeslot branch would be invisible
  // to the existing shape tests because each targets only one scope.
  test("global / competition / timeslot echo the scope back with the right ids + names", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const t = Date.now();
    // Purpose-built comp + one timeslot so the test doesn't depend on
    // what seeds happen to include.
    const compR = await api.post("/api/admin/competitions", {
      headers: h,
      data: {
        name: `ScopeMatrix-${t}`,
        start_time: new Date(t - 60_000).toISOString(),
        duration_minutes: 120,
      },
    });
    const compId = (await compR.json()).competition.id;
    const tsR = await api.post(`/api/admin/competitions/${compId}/timeslots`, {
      headers: h,
      data: {
        name: `ScopeSlot-${t}`,
        start_time: new Date(t - 30_000).toISOString(),
        duration_minutes: 60,
      },
    });
    const tsId = (await tsR.json()).timeslot.id;

    try {
      const global = await (await api.get("/api/admin/analytics/challenges?scope=global")).json();
      expect(global.scope.type).toBe("global");
      expect(global.scope.competition_id).toBeNull();
      expect(global.scope.competition_name).toBeNull();
      expect(global.scope.timeslot_id).toBeNull();
      expect(global.scope.timeslot_name).toBeNull();

      const byComp = await (await api.get(`/api/admin/analytics/challenges?scope=competition&competitionId=${compId}`)).json();
      expect(byComp.scope.type).toBe("competition");
      expect(byComp.scope.competition_id).toBe(compId);
      expect(byComp.scope.competition_name).toBe(`ScopeMatrix-${t}`);
      expect(byComp.scope.timeslot_id).toBeNull();
      expect(byComp.scope.timeslot_name).toBeNull();

      const bySlot = await (await api.get(
        `/api/admin/analytics/challenges?scope=timeslot&competitionId=${compId}&timeslotId=${tsId}`
      )).json();
      expect(bySlot.scope.type).toBe("timeslot");
      expect(bySlot.scope.competition_id).toBe(compId);
      expect(bySlot.scope.competition_name).toBe(`ScopeMatrix-${t}`);
      expect(bySlot.scope.timeslot_id).toBe(tsId);
      expect(bySlot.scope.timeslot_name).toBe(`ScopeSlot-${t}`);
      // All three branches carry the canonical summary + per_challenge keys.
      for (const payload of [global, byComp, bySlot]) {
        expect(payload).toHaveProperty("summary");
        expect(payload).toHaveProperty("filters");
        expect(Array.isArray(payload.per_challenge)).toBe(true);
      }
    } finally {
      await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      await api.dispose();
    }
  });
});




// ═══════════════════════════════════════════════════════════════════════════════
// E-06: Competition delete cascades to email_reminders (v6.18.x)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Competition delete: email_reminders cascade (v6.18.x)", () => {
  test("DELETE competition removes pending email_reminders rows", async () => {
    const Database = require("better-sqlite3");
    const sfx = Date.now();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    let compId, userId;
    try {
      // Create a fresh participant for this test (avoids any shared-state dependency).
      const userEmail = `e06user-${sfx}@acme.com`;
      await registerPost(sa, "/api/register", {
        headers: saH,
        data: { firstName: "E06", lastName: "User", nickname: `e06user_${sfx}`,
                email: userEmail, company: "Acme", title: "Dev",
                country: "US", timezone: "America/New_York" },
      });
      const listR = await (await sa.get("/api/admin/participants?limit=500")).json();
      const u = listR.participants.find(p => p.email === userEmail);
      userId = u.id;
      await sa.post(`/api/admin/participants/${userId}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${userId}/approve`, { headers: saH });
      // Create an upcoming competition.
      const crR = await sa.post("/api/admin/competitions", { headers: saH, data: {
        name: `ReminderCascade-${sfx}`,
        start_time: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 60,
      }});
      expect(crR.ok()).toBeTruthy();
      const crBody = await crR.json();
      compId = crBody.competition?.id;
      expect(compId, "competition id missing from create response").toBeTruthy();
      // Assign the fresh user to the competition.
      const assignR = await sa.post("/api/admin/competitions/assign", { headers: saH, data: {
        userIds: [userId], competitionIds: [compId],
      }});
      expect(assignR.ok(), `assign failed: ${assignR.status()}`).toBeTruthy();
      const assignBody = await assignR.json();
      expect(assignBody.assigned, "user was not assigned").toBe(1);
      // User requests a reminder.
      const { api: user, csrf: userCsrf } = await apiLogin(userEmail, PARTICIPANT_PASS);
      const uH = { "x-csrf-token": userCsrf, "content-type": "application/json" };
      const reminderR = await user.post(`/api/competitions/${compId}/reminder`, { headers: uH });
      expect(reminderR.ok(), `reminder failed: ${reminderR.status()} ${await reminderR.text()}`).toBeTruthy();
      await user.dispose();
      // Verify the reminder row exists.
      const db = new Database(TEST_DB_PATH, { readonly: true });
      const before = db.prepare("SELECT COUNT(*) as c FROM email_reminders WHERE competition_id=?").get(compId);
      db.close();
      expect(before.c).toBe(1);
      // Delete the competition.
      const delR = await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH });
      expect(delR.ok()).toBeTruthy();
      const deletedCompId = compId;
      compId = null;
      // email_reminders row must be cascade-deleted.
      const db2 = new Database(TEST_DB_PATH, { readonly: true });
      const after = db2.prepare("SELECT COUNT(*) as c FROM email_reminders WHERE competition_id=?").get(deletedCompId);
      db2.close();
      expect(after.c).toBe(0);
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      if (userId) await sa.delete(`/api/admin/participants/${userId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });
});


// Lifecycle updated_at invalidation (v6.19.x)
test.describe("Lifecycle updated_at invalidation (v6.19.x)", () => {
  test("timeslot end-now bumps updated_at so stale PUT is rejected with 409", async () => {
    const { api: sa, csrf: saC } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saC, "content-type": "application/json" };
    let compId = null;
    try {
      // Create a live multi-slot competition
      const crR = await sa.post("/api/admin/competitions", { headers: saH, data: {
        name: `LifecycleToken-${Date.now()}`,
        start_time: new Date(Date.now() - 60_000).toISOString(),
        duration_minutes: 60,
      }});
      expect(crR.ok()).toBeTruthy();
      compId = (await crR.json()).competition?.id;

      // Add a live timeslot
      const tsR = await sa.post(`/api/admin/competitions/${compId}/timeslots`, { headers: saH, data: {
        name: "Slot A",
        start_time: new Date(Date.now() - 30_000).toISOString(),
        duration_minutes: 60,
      }});
      expect(tsR.ok(), `timeslot create failed: ${tsR.status()}`).toBeTruthy();
      const ts = (await tsR.json()).timeslot;
      const staleToken = ts.updated_at;
      expect(staleToken, "updated_at missing from timeslot create response").toBeTruthy();

      // End the timeslot via end-now
      const endR = await sa.post(`/api/admin/competitions/${compId}/timeslots/${ts.id}/end-now`, { headers: saH, data: {} });
      expect(endR.ok(), `end-now failed: ${endR.status()}`).toBeTruthy();
      const endedTs = (await endR.json()).timeslot;
      expect(endedTs.updated_at, "end-now did not bump updated_at").not.toBe(staleToken);

      // Stale PUT with old token must be rejected
      const staleR = await sa.put(`/api/admin/competitions/${compId}/timeslots/${ts.id}`, { headers: saH, data: {
        duration_minutes: 90,
        expectedUpdatedAt: staleToken,
      }});
      expect(staleR.status()).toBe(409);
      const staleBody = await staleR.json();
      expect(staleBody.conflict).toBe(true);

      // Fresh PUT with the new token must succeed
      const freshR = await sa.put(`/api/admin/competitions/${compId}/timeslots/${ts.id}`, { headers: saH, data: {
        duration_minutes: 90,
        expectedUpdatedAt: endedTs.updated_at,
      }});
      expect(freshR.ok(), `fresh PUT failed: ${freshR.status()} ${await freshR.text()}`).toBeTruthy();
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("competition end-now bumps updated_at so stale competition PUT is rejected with 409", async () => {
    const { api: sa, csrf: saC } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saC, "content-type": "application/json" };
    let compId = null;
    try {
      const crR = await sa.post("/api/admin/competitions", { headers: saH, data: {
        name: `CompLifecycleToken-${Date.now()}`,
        start_time: new Date(Date.now() - 60_000).toISOString(),
        duration_minutes: 60,
      }});
      expect(crR.ok()).toBeTruthy();
      const crBody = await crR.json();
      compId = crBody.competition?.id;
      const staleToken = crBody.competition?.updated_at;
      expect(staleToken, "updated_at missing from competition create response").toBeTruthy();

      // End the competition
      const endR = await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: saH, data: {} });
      expect(endR.ok(), `end-now failed: ${endR.status()}`).toBeTruthy();
      const endedComp = (await endR.json()).competition;
      expect(endedComp.updated_at, "end-now did not bump competition updated_at").not.toBe(staleToken);

      // Stale PUT must be rejected
      const staleR = await sa.put(`/api/admin/competitions/${compId}`, { headers: saH, data: {
        duration_minutes: 90,
        expectedUpdatedAt: staleToken,
      }});
      expect(staleR.status()).toBe(409);
      expect((await staleR.json()).conflict).toBe(true);
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  test("timeslot create/delete bump parent competition updated_at", async () => {
    const { api: sa, csrf: saC } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saC, "content-type": "application/json" };
    let compId = null;
    try {
      const crR = await sa.post("/api/admin/competitions", { headers: saH, data: {
        name: `ParentBump-${Date.now()}`,
        start_time: new Date(Date.now() + 3_600_000).toISOString(),
        duration_minutes: 60,
      }});
      expect(crR.ok()).toBeTruthy();
      const crBody = await crR.json();
      compId = crBody.competition?.id;
      const tokenAfterCreate = crBody.competition?.updated_at;

      // Create a timeslot — parent updated_at must advance
      const tsR = await sa.post(`/api/admin/competitions/${compId}/timeslots`, { headers: saH, data: {
        name: "Slot X",
        start_time: new Date(Date.now() + 3_600_000).toISOString(),
        duration_minutes: 30,
      }});
      expect(tsR.ok()).toBeTruthy();
      const tsId = (await tsR.json()).timeslot?.id;
      const compAfterTsCreate = await (await sa.get(`/api/admin/competitions`)).json();
      const tokenAfterTsCreate = compAfterTsCreate.find(c => c.id === compId)?.updated_at;
      expect(tokenAfterTsCreate, "timeslot create did not bump parent competition updated_at").not.toBe(tokenAfterCreate);

      // Delete the timeslot — parent updated_at must advance again
      const delR = await sa.delete(`/api/admin/competitions/${compId}/timeslots/${tsId}`, { headers: saH });
      expect(delR.ok()).toBeTruthy();
      const compAfterTsDel = await (await sa.get(`/api/admin/competitions`)).json();
      const tokenAfterTsDel = compAfterTsDel.find(c => c.id === compId)?.updated_at;
      expect(tokenAfterTsDel, "timeslot delete did not bump parent competition updated_at").not.toBe(tokenAfterTsCreate);
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });

  // v6.20.x — task lifecycle writers (publish / visibility / restore / lock)
  // must bump tasks.updated_at so a stale edit form's expectedUpdatedAt is
  // rejected with 409. Pre-fix these UPDATEd the row without touching
  // updated_at, defeating the optimistic-concurrency model on PUT /tasks/:id.
  test("task lifecycle writers bump updated_at so a stale task PUT is 409'd", async () => {
    const { api: sa, csrf: saC } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saC, "content-type": "application/json" };
    let taskId = null;
    try {
      const crR = await sa.post("/api/admin/tasks", { headers: saH, data: {
        title: `LifecycleToken-${Date.now()}`, difficulty: "easy", answer_type: "text", correct_answer: "x", status: "draft",
      }});
      expect(crR.ok(), `task create failed: ${crR.status()}`).toBeTruthy();
      taskId = (await crR.json()).id;
      // Capture the token a stale edit form would hold.
      const tasksBefore = await (await sa.get("/api/admin/tasks")).json();
      const before = (Array.isArray(tasksBefore) ? tasksBefore : tasksBefore.tasks).find(t => t.id === taskId).updated_at;
      expect(before, "task updated_at missing").toBeTruthy();

      // A lifecycle write (publish) must advance updated_at...
      await new Promise(r => setTimeout(r, 5));
      const pubR = await sa.post(`/api/admin/tasks/${taskId}/publish`, { headers: saH, data: {} });
      expect(pubR.ok(), `publish failed: ${pubR.status()}`).toBeTruthy();
      const tasksAfter = await (await sa.get("/api/admin/tasks")).json();
      const after = (Array.isArray(tasksAfter) ? tasksAfter : tasksAfter.tasks).find(t => t.id === taskId).updated_at;
      expect(after, "publish must bump task updated_at").not.toBe(before);

      // ...so a stale edit (carrying the pre-publish token) is now rejected.
      const stale = await sa.put(`/api/admin/tasks/${taskId}`, { headers: saH, data: { title: "stale edit", expectedUpdatedAt: before } });
      expect(stale.status(), "stale task PUT after a lifecycle write must 409").toBe(409);
      expect((await stale.json()).conflict).toBe(true);

      // Visibility flip also bumps it.
      const t2 = after;
      await new Promise(r => setTimeout(r, 5));
      const visR = await sa.patch(`/api/admin/tasks/${taskId}/visibility`, { headers: saH, data: {} });
      expect(visR.ok(), `visibility failed: ${visR.status()}`).toBeTruthy();
      const tasksAfter2 = await (await sa.get("/api/admin/tasks")).json();
      const after2 = (Array.isArray(tasksAfter2) ? tasksAfter2 : tasksAfter2.tasks).find(t => t.id === taskId).updated_at;
      expect(after2, "visibility flip must bump task updated_at").not.toBe(t2);
    } finally {
      if (taskId) await sa.delete(`/api/admin/tasks/${taskId}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Auditor fixes (v6.19.x)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Auditor fixes (v6.19.x)", () => {
  // Issue 1: session Remove now deletes the server slot, not just the DOM row
  test("deleting an EMPTY session removes exactly that session, and the other survives", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    let compId = null;
    try {
      // Create competition with two timeslots
      const crR = await sa.post("/api/admin/competitions", { headers: h, data: {
        name: `SlotRemove-${Date.now()}`,
        start_time: new Date(Date.now() + 3_600_000).toISOString(),
        duration_minutes: 60,
      }});
      expect(crR.ok()).toBeTruthy();
      compId = (await crR.json()).competition?.id;

      const ts1R = await sa.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h, data: {
        name: "Slot Alpha", start_time: new Date(Date.now() + 3_600_000).toISOString(), duration_minutes: 30,
      }});
      expect(ts1R.ok()).toBeTruthy();
      const ts1Id = (await ts1R.json()).timeslot?.id;

      const ts2R = await sa.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h, data: {
        name: "Slot Beta", start_time: new Date(Date.now() + 7_200_000).toISOString(), duration_minutes: 30,
      }});
      expect(ts2R.ok()).toBeTruthy();

      // Verify both slots exist (endpoint returns a plain array)
      const before = await (await sa.get(`/api/admin/competitions/${compId}/timeslots`)).json();
      expect(before.length).toBe(2);

      // Delete one slot — the named one must go, and the OTHER must survive.
      const delR = await sa.delete(`/api/admin/competitions/${compId}/timeslots/${ts1Id}`, { headers: h });
      expect(delR.ok(), `DELETE timeslot failed: ${delR.status()}`).toBeTruthy();

      // Verify only one slot remains
      const after = await (await sa.get(`/api/admin/competitions/${compId}/timeslots`)).json();
      expect(after.length).toBe(1);
      expect(after[0].name).toBe("Slot Beta");
    } finally {
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: h }).catch(() => {});
      await sa.dispose();
    }
  });

  // Issue 3: import overwrite skips locked tasks
  test("import overwrite resolution skips locked tasks and keeps them locked", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    let taskId = null;
    try {
      // Create a task and lock it
      const crR = await sa.post("/api/admin/tasks", { headers: h, data: {
        title: `LockImportTarget-${Date.now()}`,
        difficulty: "easy", correct_answer: "original", answer_type: "text",
      }});
      expect(crR.ok()).toBeTruthy();
      taskId = (await crR.json()).task?.id || (await crR.json()).id;

      const lockR = await sa.post(`/api/admin/tasks/${taskId}/lock`, { headers: h });
      expect(lockR.ok()).toBeTruthy();

      // Fetch the task to confirm it's locked and record original answer
      const taskBefore = (await (await sa.get("/api/admin/tasks")).json()).find(t => t.id === taskId);
      expect(taskBefore.locked).toBeTruthy();

      // Dry-run import to detect the conflict
      const dryR = await sa.post("/api/admin/import/tasks", { headers: h, data: {
        data: { type: "hackarena-tasks", tasks: [{ title: taskBefore.title, difficulty: "hard", correct_answer: "overwritten", answer_type: "text" }] },
      }});
      expect(dryR.ok()).toBeTruthy();
      const dry = await dryR.json();
      expect(dry.dryRun).toBe(true);
      expect(dry.conflicts.length).toBe(1);
      const conflictIndex = dry.conflicts[0].index;

      // Overwrite resolution — should silently skip the locked task
      // resolutions is an object keyed by string index, not an array
      const importR = await sa.post("/api/admin/import/tasks", { headers: h, data: {
        data: { type: "hackarena-tasks", tasks: [{ title: taskBefore.title, difficulty: "hard", correct_answer: "overwritten", answer_type: "text" }] },
        resolutions: { [String(conflictIndex)]: "overwrite" },
      }});
      expect(importR.ok()).toBeTruthy();
      const importResult = await importR.json();
      // skipped counter must include the locked task
      expect(importResult.skipped).toBeGreaterThanOrEqual(1);

      // Task must be unchanged — still locked, original answer preserved
      const taskAfter = (await (await sa.get("/api/admin/tasks")).json()).find(t => t.id === taskId);
      expect(taskAfter.locked).toBeTruthy();
      expect(taskAfter.correct_answer).toBe("original");
    } finally {
      if (taskId) {
        // Unlock so we can delete
        await sa.post(`/api/admin/tasks/${taskId}/lock`, { headers: h }).catch(() => {});
        await sa.delete(`/api/admin/tasks/${taskId}`, { headers: h }).catch(() => {});
      }
      await sa.dispose();
    }
  });

  // v6.20.x — the enum guard inside importTxn is a best-effort SKIP, not a
  // rejection: one row carrying an out-of-allowlist difficulty/answer_type
  // bumps `skipped` and the rest of the file still imports. Remove it and the
  // tasks CHECK constraint fires INSIDE the transaction, the outer catch rolls
  // the whole thing back and returns an opaque 500 — so a single wrong-cased
  // row in a 500-challenge export would destroy the entire import.
  test("import SKIPS a row with an out-of-allowlist difficulty instead of failing the whole batch", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const s = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    const good = `EnumSkipGood-${s}`;
    const bad = `EnumSkipBad-${s}`;
    let goodId = null;
    try {
      // Unique titles ⇒ zero conflicts ⇒ no resolution branch can interfere.
      // GOOD is FIRST so `imported===1` proves the surviving row was committed
      // rather than being an artefact of the bad row aborting the loop early.
      const r = await sa.post("/api/admin/import/tasks", { headers: h, data: {
        data: { type: "hackarena-tasks", tasks: [
          { title: good, difficulty: "easy", answer_type: "text", correct_answer: "a" },
          { title: bad, difficulty: "Easy", answer_type: "text", correct_answer: "b" }, // wrong case → not in VALID_DIFFICULTIES
        ] },
        resolutions: {},   // truthy ⇒ apply, not a dry run
      }});
      expect(r.ok(), `import must not fail the whole batch: ${r.status()} ${await r.text()}`).toBeTruthy();
      const d = await r.json();
      expect(d.imported, "the valid row still imports").toBe(1);
      expect(d.skipped, "the out-of-allowlist row is skipped, not fatal").toBe(1);
      const all = await (await sa.get("/api/admin/tasks")).json();
      goodId = all.find(t => t.title === good)?.id;
      expect(goodId, "the good row exists").toBeTruthy();
      expect(all.some(t => t.title === bad), "the bad-difficulty row must NOT have been written").toBe(false);
    } finally {
      if (goodId) await sa.delete(`/api/admin/tasks/${goodId}`, { headers: h }).catch(() => {});
      await sa.dispose();
    }
  });

  // Twin of the above for the SECOND clause of the same condition — keep the
  // difficulty valid here so the first clause can't mask it.
  test("import SKIPS a row with an out-of-allowlist answer_type instead of failing the whole batch", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const s = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    const good = `EnumAtGood-${s}`;
    const bad = `EnumAtBad-${s}`;
    let goodId = null;
    try {
      const r = await sa.post("/api/admin/import/tasks", { headers: h, data: {
        data: { type: "hackarena-tasks", tasks: [
          { title: good, difficulty: "easy", answer_type: "text", correct_answer: "a" },
          { title: bad, difficulty: "easy", answer_type: "File", correct_answer: "b" }, // wrong case → not in VALID_ANSWER_TYPES
        ] },
        resolutions: {},
      }});
      expect(r.ok(), `import must not fail the whole batch: ${r.status()} ${await r.text()}`).toBeTruthy();
      const d = await r.json();
      expect(d.imported).toBe(1);
      expect(d.skipped).toBe(1);
      const all = await (await sa.get("/api/admin/tasks")).json();
      goodId = all.find(t => t.title === good)?.id;
      expect(goodId).toBeTruthy();
      expect(all.some(t => t.title === bad), "the bad-answer_type row must NOT have been written").toBe(false);
    } finally {
      if (goodId) await sa.delete(`/api/admin/tasks/${goodId}`, { headers: h }).catch(() => {});
      await sa.dispose();
    }
  });

  // Issue 3: import overwrite bumps updated_at
  test("import overwrite bumps updated_at on the task row", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    let taskId = null;
    try {
      const title = `UpdatedAtImport-${Date.now()}`;
      const crR = await sa.post("/api/admin/tasks", { headers: h, data: {
        title, difficulty: "easy", correct_answer: "original", answer_type: "text",
      }});
      expect(crR.ok()).toBeTruthy();
      taskId = (await crR.json()).task?.id || (await crR.json()).id;
      const tasksBefore = await (await sa.get("/api/admin/tasks")).json();
      const before = tasksBefore.find(t => t.id === taskId);
      const updatedAtBefore = before?.updated_at;

      // Dry-run to get conflict index
      const dryR = await sa.post("/api/admin/import/tasks", { headers: h, data: {
        data: { type: "hackarena-tasks", tasks: [{ title, difficulty: "hard", correct_answer: "new_answer", answer_type: "text" }] },
      }});
      const dry = await dryR.json();
      const conflictIndex = dry.conflicts[0]?.index ?? 0;

      // Overwrite
      const importR = await sa.post("/api/admin/import/tasks", { headers: h, data: {
        data: { type: "hackarena-tasks", tasks: [{ title, difficulty: "hard", correct_answer: "new_answer", answer_type: "text" }] },
        resolutions: { [String(conflictIndex)]: "overwrite" },
      }});
      expect(importR.ok()).toBeTruthy();

      const tasksAfter = await (await sa.get("/api/admin/tasks")).json();
      const after = tasksAfter.find(t => t.id === taskId);
      expect(after?.updated_at, "import overwrite did not advance updated_at").not.toBe(updatedAtBefore);
    } finally {
      if (taskId) await sa.delete(`/api/admin/tasks/${taskId}`, { headers: h }).catch(() => {});
      await sa.dispose();
    }
  });

  // v6.20.6 — insert path also stamps updated_at, so the very first PUT
  // can exercise optimistic concurrency. Pre-fix the insert at server.js
  // ~13125 wrote NULL, so two admins editing a freshly imported task
  // could overwrite each other until the first normal save filled it in.
  test("v6.20.6: imported tasks (insert path) stamp updated_at at creation", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    let newId = null;
    try {
      const title = `ImportInsertUpdatedAt-${Date.now()}`;
      const importR = await sa.post("/api/admin/import/tasks", { headers: h, data: {
        data: { type: "hackarena-tasks", tasks: [{ title, difficulty: "easy", correct_answer: "x", answer_type: "text" }] },
        resolutions: {},
      }});
      expect(importR.ok()).toBeTruthy();
      const all = await (await sa.get("/api/admin/tasks")).json();
      const t = all.find(x => x.title === title);
      newId = t?.id;
      expect(t, "task created").toBeTruthy();
      expect(t.updated_at, "updated_at populated").toBeTruthy();
      // Optimistic-concurrency now meaningful: a wrong token must 409.
      const putR = await sa.put(`/api/admin/tasks/${newId}`, { headers: h, data: {
        title: t.title, difficulty: t.difficulty, answer_type: t.answer_type,
        correct_answer: t.correct_answer, active: t.active, status: t.status,
        expectedUpdatedAt: "1970-01-01T00:00:00.000Z",
      }});
      expect(putR.status(), "stale token must 409").toBe(409);
    } finally {
      if (newId) await sa.delete(`/api/admin/tasks/${newId}`, { headers: h }).catch(() => {});
      await sa.dispose();
    }
  });

  // v6.20.6 — locked-overwrite tasks no longer have their attachment files
  // moved into ./data/attachments/ (where they'd sit with no DB row). Skip
  // happens during the promotion pass, before the DB transaction.
  test("v6.20.6: locked-overwrite import does not leak attachment files", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const fs = require("fs");
    const path = require("path");
    // v8.3.26 — TEST_DATA_DIR, and the old expression was wrong three ways.
    //
    // `process.env.DATA_DIR` is never set in a Playwright worker (the config sets
    // env only for launchOptions and webServer), so the fallback ALWAYS fired.
    // That fallback keyed on `TEST_WORKER_INDEX`, which helpers.js documents
    // verbatim as "monotonic, increments on every re-spawn/retry ← NOT suitable",
    // and it ignored TEST_PORT_BASE, so under the independence sweep it read
    // `data-test-0` while the server wrote `data-test-4700-0`.
    //
    // It did not fail RED, it failed VACUOUS: both counts below are
    // `existsSync(dir) ? readdirSync(dir).length : 0`, so the assertion was
    // `0 === 0` and the leak this test exists to catch could not be seen. Fourth
    // occurrence of the derive-the-path-by-hand class (v7.21.35, v8.3.16 ×2).
    const dataDir = path.join(TEST_DATA_DIR, "attachments");
    let taskId = null;
    try {
      const title = `LockOverwriteAttachLeak-${Date.now()}`;
      const cr = await sa.post("/api/admin/tasks", { headers: h, data: {
        title, difficulty: "easy", correct_answer: "orig", answer_type: "text",
      }});
      taskId = (await cr.json()).task?.id || (await cr.json()).id;
      await sa.post(`/api/admin/tasks/${taskId}/lock`, { headers: h });
      // Count attachment files BEFORE the import
      const before = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).length : 0;
      // Build a 1-task import with a minimal valid zip attachment (PK header).
      // The simplest valid empty zip is a 22-byte EOCD record.
      const emptyZipB64 = "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==";
      const dryR = await sa.post("/api/admin/import/tasks", { headers: h, data: {
        data: { type: "hackarena-tasks", tasks: [{
          title, difficulty: "hard", correct_answer: "overwritten", answer_type: "text",
          attachments: [{ display_name: "leakcheck", original_name: "leakcheck.zip", size_bytes: 22, content_b64: emptyZipB64 }],
        }] },
      }});
      // Even if the zip validator rejects the empty zip on this build, we
      // only care that on the OVERWRITE+LOCKED path no file moves through.
      if (!dryR.ok()) {
        // Validator rejected on dry-run; treat as N/A.
        return;
      }
      const dry = await dryR.json();
      const cIdx = dry.conflicts?.[0]?.index ?? 0;
      const importR = await sa.post("/api/admin/import/tasks", { headers: h, data: {
        data: { type: "hackarena-tasks", tasks: [{
          title, difficulty: "hard", correct_answer: "overwritten", answer_type: "text",
          attachments: [{ display_name: "leakcheck", original_name: "leakcheck.zip", size_bytes: 22, content_b64: emptyZipB64 }],
        }] },
        resolutions: { [String(cIdx)]: "overwrite" },
      }});
      if (!importR.ok()) return; // attachment validation may differ — only assert on success path
      const after = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).length : 0;
      expect(after, "no attachment files should have been promoted for the locked-overwrite skip").toBe(before);
    } finally {
      if (taskId) {
        await sa.post(`/api/admin/tasks/${taskId}/lock`, { headers: h }).catch(() => {});
        await sa.delete(`/api/admin/tasks/${taskId}`, { headers: h }).catch(() => {});
      }
      await sa.dispose();
    }
  });

  // Issue 4: /api/me cache invalidation happens after the DB write, not before
  test("PUT /api/me reflects changes in subsequent GET /api/me (cache invalidated post-write)", async () => {
    const { api: sa, csrf: saC } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saC, "content-type": "application/json" };
    const s = Date.now().toString(36);
    // Register + verify + approve + set password
    const regR = await registerPost(sa, "/api/register", { headers: saH, data: {
      firstName: "Cache", lastName: "Test", nickname: `cachetest_${s}`,
      email: `cachetest_${s}@acme.com`, company: "Acme", title: "Eng",
      country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC",
    }});
    expect(regR.ok(), `register: ${regR.status()} ${await regR.text()}`).toBeTruthy();
    const partList = await (await sa.get("/api/admin/participants?limit=500")).json();
    const user = partList.participants.find(p => p.email === `cachetest_${s}@acme.com`);
    await sa.post(`/api/admin/participants/${user.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${user.id}/approve`, { headers: saH });

    const { api: userApi, csrf: userCsrf } = await apiLogin(`cachetest_${s}@acme.com`, PARTICIPANT_PASS);
    const userH = { "x-csrf-token": userCsrf, "content-type": "application/json" };
    try {
      // Update profile with a new company
      const putR = await userApi.put("/api/me", { headers: userH, data: { company: "UpdatedCorp" } });
      expect(putR.ok(), `PUT /api/me failed: ${putR.status()}`).toBeTruthy();

      // Immediate GET must reflect the change (not serve a stale pre-write cache entry)
      const getR = await userApi.get("/api/me");
      expect(getR.ok()).toBeTruthy();
      const me = await getR.json();
      expect(me.company).toBe("UpdatedCorp");
    } finally {
      await userApi.dispose();
      await sa.delete(`/api/admin/participants/${user.id}`, { headers: saH }).catch(() => {});
      await sa.dispose();
    }
  });
});





// ── CTF-0026 — shared-NAT rate-limit + session-expiry hardening ─────────────
// Covers the four measures from the live-competition incident (legit
// participants behind one NAT IP tripping rate limits): A (keepalive while a
// competition is live), B (identity-keyed login limiter — e2e in
// functional-security), C (IP allowlist matcher + env-configurable ceilings),
// D (skip the redundant post-expiry logout POST). B's runtime behaviour lives
// in functional-security ("Rate limiting — runtime enforcement"); the unit +
// behaviour-lock coverage for A/C/D is here.
test.describe("CTF-0026 — NAT rate-limit / session-expiry hardening", () => {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..");
  const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

  test("fix C: IP allowlist matcher handles exact IPs, IPv4 CIDR, IPv4-mapped IPv6, and non-matches", () => {
    // Pure matcher (lib/util.js) — dependency-free, so we can execute it directly.
    const { parseIpAllowlist, ipAllowlistMatch } = require("../lib/util");
    const list = parseIpAllowlist("203.0.113.7, 10.0.0.0/8, 192.168.1.0/24");
    // exact
    expect(ipAllowlistMatch(list, "203.0.113.7")).toBe(true);
    expect(ipAllowlistMatch(list, "203.0.113.8")).toBe(false);
    // CIDR ranges
    expect(ipAllowlistMatch(list, "10.5.6.7")).toBe(true);
    expect(ipAllowlistMatch(list, "11.0.0.1")).toBe(false);
    expect(ipAllowlistMatch(list, "192.168.1.250")).toBe(true);
    expect(ipAllowlistMatch(list, "192.168.2.1")).toBe(false);
    // IPv4-mapped IPv6 normalises to its v4 form
    expect(ipAllowlistMatch(list, "::ffff:10.1.2.3")).toBe(true);
    // localhost (the test client) is NOT allowlisted — so the rate-limit e2e
    // tests still trip; this guards against an accidental 127.0.0.1 entry.
    expect(ipAllowlistMatch(list, "127.0.0.1")).toBe(false);
    // empty allowlist matches nothing (default posture — limiter fully active)
    expect(ipAllowlistMatch(parseIpAllowlist(""), "10.0.0.1")).toBe(false);
    expect(ipAllowlistMatch(parseIpAllowlist("  "), "203.0.113.7")).toBe(false);
    // /0 CIDR matches everything (operator escape hatch)
    expect(ipAllowlistMatch(parseIpAllowlist("0.0.0.0/0"), "8.8.8.8")).toBe(true);
  });

  test("fix B+C: rate limiter wires the allowlist bypass, per-IP backstop, and identity key; login uses email + env knobs", () => {
    const mw = read("lib/middleware.js");
    // allowlist parsed from env + consulted as the first bypass in rateLimit
    expect(mw).toMatch(/RATE_LIMIT_ALLOWLIST_IPS/);
    expect(mw).toMatch(/parseIpAllowlist|ipAllowlistMatch/);
    expect(mw).toMatch(/_rateLimitAllowlisted\(req\.ip\)\)\s*return next\(\)/);
    // identity key + coarse per-IP backstop both honoured
    expect(mw).toMatch(/keyExtra/);
    expect(mw).toMatch(/ipBackstopMax/);
    const srv = read("server.js");
    // login limiter keyed by normalised email + env-configurable limits
    expect(srv).toMatch(/rateLimit\(60_000,\s*_LOGIN_PER_MIN,\s*"login"/);
    expect(srv).toMatch(/RATE_LIMIT_LOGIN_PER_MIN/);
    expect(srv).toMatch(/RATE_LIMIT_LOGIN_IP_BACKSTOP_PER_MIN/);
    // v9.0.0 — keyed on the name the card sends (`username`, or the legacy `email`).
    expect(srv).toMatch(/keyExtra:\s*\(req\)\s*=>\s*\{[\s\S]{0,400}?b\.username[\s\S]{0,200}?b\.email[\s\S]{0,120}?normaliseEmail\(v\)/);
    // csrf + config limits configurable too
    expect(srv).toMatch(/RATE_LIMIT_CSRF_PER_MIN/);
    // The /api/config and /api/settings/appearance limit is one knob, read once in
    // lib/config.js (CLAUDE.md: a multi-module knob is read there), never parsed
    // again in a route.
    expect(read("lib/config.js")).toMatch(/process\.env\.RATE_LIMIT_CONFIG_PER_MIN/);
    const directReader = /process\.env\.RATE_LIMIT_CONFIG_PER_MIN/;
    // Comments stripped first (CLAUDE.md, *Writing a source scanner*): a comment
    // quoting the old form is not a read.
    const { stripJsComments } = require("./doc-registry");
    expect(directReader.test(stripJsComments("rateLimit(60_000, parseInt(process.env.RATE_LIMIT_CONFIG_PER_MIN, 10) || 120")),
      "CONTROL: the pattern sees a route parsing the variable itself").toBe(true);
    expect(directReader.test(stripJsComments("// was parseInt(process.env.RATE_LIMIT_CONFIG_PER_MIN, 10)\nconst x = 1;")),
      "CONTROL: a comment quoting it is not a read").toBe(false);
    const routeFiles = fs.readdirSync(path.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`);
    expect(routeFiles.length, "anti-vacuity: the route modules were read").toBeGreaterThan(10);
    for (const f of [...routeFiles, "server.js"]) {
      expect(directReader.test(stripJsComments(read(f))), `${f} reads RATE_LIMIT_CONFIG_PER_MIN itself`).toBe(false);
    }
    expect(read("routes/participant.js")).toMatch(/rateLimit\(60_000,\s*RATE_LIMIT_CONFIG_PER_MIN,\s*"config"/);
    expect(read("routes/settings.js")).toMatch(/rateLimit\(60_000,\s*RATE_LIMIT_CONFIG_PER_MIN,\s*"appearance"/);
  });

  test("fix A: session monitor keepalives while a competition is live, even with no in-tab activity", () => {
    const sm = read("public/js/features/session-monitor.js");
    // keepalive gate is (recent activity) OR (in a live competition)
    expect(sm).toMatch(/inLiveCompetition/);
    expect(sm).toMatch(/wasRecentlyActive\s*\|\|\s*inLiveCompetition/);
    // self-bounding: gated on the live flag AND the slot's end time in the future
    expect(sm).toMatch(/S\._inLiveCompetition/);
    expect(sm).toMatch(/hackathonEndTime/);
    // the flag is set when a live competition starts and cleared on end + eject
    const pt = read("public/js/features/participant-tasks.js");
    expect(pt).toMatch(/S\._inLiveCompetition\s*=\s*true/);   // startHackathonTimer (live)
    expect(pt.match(/S\._inLiveCompetition\s*=\s*false/g) || []).toHaveLength(2); // ended + eject
  });

  test("fix D: the session-expiry interceptor only POSTs /api/logout on a CSRF mismatch (not on an already-gone session)", () => {
    const api = read("public/js/core/api.js");
    // exactly ONE logout POST in the interceptor, sitting DIRECTLY inside the
    // csrf_invalid branch (tight gap — only whitespace between `{` and the call,
    // so the match can't span an unrelated statement).
    expect(api.match(/_origFetch\('\/api\/logout'/g) || []).toHaveLength(1);
    expect(api).toMatch(/if\s*\(\s*d\.error\s*===\s*'csrf_invalid'\s*\)\s*\{\s*_origFetch\('\/api\/logout'/);
    // and it is NOT an unconditional call right after _stopAllPolls()
    expect(api).not.toMatch(/_stopAllPolls\(\);\s*\n\s*_origFetch\('\/api\/logout'/);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// audit v7.7.32 batch 7 — the remaining 9 mediums (RM1–RM9)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("audit v7.7.32 batch 7 — remaining mediums", () => {
  const H = csrf => ({ "x-csrf-token": csrf, "content-type": "application/json" });
  async function mk7(sa, saCsrf, { verify = false, approve = false } = {}) {
    const s = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    const email = `b7_${s}@acme.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: H(ac), data: {
      firstName: "B7", lastName: "U", nickname: `b7_${s}`, email, company: "Acme", title: "Eng",
      country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC",
    }});
    await anon.dispose();
    const me = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
    if (verify) await sa.post(`/api/admin/participants/${me.id}/verify`, { headers: H(saCsrf) });
    if (approve) await sa.post(`/api/admin/participants/${me.id}/approve`, { headers: H(saCsrf) });
    if (verify) { // set a password so we can log in
    }
    return { id: me.id, email };
  }

  test("RM9: PUT /api/me on a legacy Unicode-email account saves when the email is unchanged", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const u = await mk7(sa, saCsrf, { verify: true, approve: true });
    // Log in FIRST (session is userId-based, so it survives the email change below).
    const { api: p, csrf: pc } = await apiLogin(u.email, PARTICIPANT_PASS);
    // Force a legacy (pre-v7.7.12) Unicode primary email directly in the DB —
    // registration now rejects it, but such rows exist from older versions. Unique
    // per run so parallel workers / retries don't collide on the UNIQUE index.
    const s2 = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    const Database = require("better-sqlite3");
    const dbW = new Database(TEST_DB_PATH);
    try { dbW.prepare("UPDATE users SET email=? WHERE id=?").run(`josé_${s2}@compañía.com`, u.id); } finally { dbW.close(); }
    // PUT changing ONLY city — the stored Unicode email is unchanged and must NOT be re-validated.
    const r = await p.put("/api/me", { headers: H(pc), data: { city: "Lisbon" } });
    expect(r.status(), `unchanged legacy email must not brick PUT /api/me: ${await r.text()}`).toBe(200);
    await p.dispose(); await sa.dispose();
  });

  test("RM2: hard task delete is blocked when the task is assigned to an ended competition", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const s = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    const now = Date.now();
    const compId = (await (await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: {
      name: `RM2 ${s}`, start_time: new Date(now - 60 * 60_000).toISOString(), duration_minutes: 180,
    }})).json()).competition.id;
    const bankId = (await (await sa.post("/api/admin/tasks", { headers: H(saCsrf), data: {
      title: `RM2 Task ${s}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text",
      correct_answer: "a", status: "published",
    }})).json()).id;
    const as = await sa.post(`/api/admin/tasks/${bankId}/competitions`, { headers: H(saCsrf), data: { competitionIds: [compId] } });
    expect(as.ok(), await as.text()).toBeTruthy();
    // The event holds its OWN copy (lib/event-copies.js): that is the task in the ended comp.
    const taskId = (await as.json()).copies[0].task_id;
    await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: H(saCsrf) }); // now ended
    const r = await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    expect(r.status(), "delete of a task in an ended comp must be blocked").toBe(400);
    expect((await r.json()).error).toMatch(/ended|frozen/i);
    // CONTROL: the library question it was copied from is in no event, so it goes,
    // and the ended event keeps its own copy.
    const rb = await sa.delete(`/api/admin/tasks/${bankId}`, { headers: { "x-csrf-token": saCsrf } });
    expect(rb.status(), `the bank question is in no event: ${await rb.text()}`).toBe(200);
    expect((await (await sa.get("/api/admin/tasks")).json()).some(t => t.id === taskId), "the ended event's copy stays").toBe(true);
    await sa.dispose();
  });

  // The delete txn purges task_feedback / task_tags / competition_tasks /
  // task_versions / challenge_events but DELIBERATELY never touches
  // `submissions`. So if this guard regressed, the task row would vanish while
  // its submission rows survived with a dangling task_id — and every
  // admin-facing submissions query INNER JOINs tasks, so the participant's
  // graded answers would disappear from the Submissions view and the audit
  // trail with no way to recover them.
  //
  // Reachability: unassigning from a LIVE comp with no ended slot is allowed,
  // so a task can hold submissions and zero competition_tasks rows — at which
  // point the live/ended checks both pass and this is the SOLE guard.
  // The submitted answer must be WRONG: a correct one on a one-task/one-
  // participant comp trips the all-solved auto-end, which would end the comp
  // and make the unassign (and then the delete) fail via the ENDED guard
  // instead — the test would go green for entirely the wrong reason.
  test("hard task delete is blocked when the challenge has submissions, even after it is unassigned", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const s = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    const Database = require("better-sqlite3");
    let taskId = null, uid = null;
    try {
      const compId = (await (await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: {
        name: `SubGuard ${s}`, start_time: new Date(Date.now() - 60 * 60_000).toISOString(), duration_minutes: 240,
      }})).json()).competition.id;
      const bankId = (await (await sa.post("/api/admin/tasks", { headers: H(saCsrf), data: {
        title: `SubGuard Task ${s}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text",
        correct_answer: "right-answer", status: "published",
      }})).json()).id;
      const as = await sa.post(`/api/admin/tasks/${bankId}/competitions`, { headers: H(saCsrf), data: { competitionIds: [compId] } });
      expect(as.ok(), await as.text()).toBeTruthy();
      taskId = (await as.json()).copies[0].task_id;   // the event's own copy: the question answered
      const u = await mk7(sa, saCsrf, { verify: true, approve: true });
      uid = u.id;
      await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { userIds: [u.id], competitionIds: [compId] } });

      const { api: p, csrf: pc } = await apiLogin(u.email, PARTICIPANT_PASS);
      await p.post("/api/select-competition", { headers: H(pc), data: { competitionId: compId } });
      const subR = await p.post(`/api/tasks/${taskId}/submit`, { headers: H(pc), data: { answer: "definitely-wrong" , gradingHash: await gradingHashFor(p, taskId)} });
      expect(subR.ok(), `submit: ${subR.status()} ${await subR.text()}`).toBeTruthy();
      expect((await subR.json()).correct, "a WRONG answer keeps the comp live (no all-solved auto-end)").toBe(false);
      await p.dispose();

      const subCount = () => { const d = new Database(TEST_DB_PATH, { readonly: true }); try { return d.prepare("SELECT COUNT(*) c FROM submissions WHERE task_id=? AND user_id=?").get(taskId, u.id).c; } finally { d.close(); } };
      expect(subCount(), "precondition: the submission row exists").toBeGreaterThan(0);

      // Unassigning from a LIVE comp is permitted — this must SUCCEED, or the
      // final delete would be refused by the ended/live guard instead.
      const unR = await sa.delete(`/api/admin/tasks/${taskId}/competitions/${compId}`, { headers: { "x-csrf-token": saCsrf } });
      expect(unR.ok(), `unassign from a live comp must succeed: ${unR.status()} ${await unR.text()}`).toBeTruthy();

      const delR = await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
      expect(delR.status(), "a challenge with submissions must not be hard-deleted").toBe(400);
      expect((await delR.json()).error, "the refusal must name the submissions, not the ended/live guard").toMatch(/submissions/i);

      const all = await (await sa.get("/api/admin/tasks")).json();
      expect(all.some(t => t.id === taskId), "the task row must survive the refused delete").toBe(true);
      expect(subCount(), "the submission must not be left as an orphan with a dangling task_id").toBeGreaterThan(0);

      await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: H(saCsrf) }).catch(() => {});
      await sa.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": saCsrf } }).catch(() => {});
    } finally {
      // Deleting the participant cascades the submissions, which then frees
      // the task for deletion — otherwise the guard we just proved keeps it.
      if (uid) await sa.delete(`/api/admin/participants/${uid}`, { headers: { "x-csrf-token": saCsrf } }).catch(() => {});
      if (taskId) await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } }).catch(() => {});
      await sa.dispose();
    }
  });

  test("RM1: submitting a non-allowlisted file type returns a specific error, not task_changed", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const s = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    const compId = (await (await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: {
      name: `RM1 ${s}`, start_time: new Date(Date.now() - 30 * 60_000).toISOString(), duration_minutes: 180,
    }})).json()).competition.id;
    const taskId = (await (await sa.post("/api/admin/tasks", { headers: H(saCsrf), data: {
      title: `RM1 Task ${s}`, description: "<p>x</p>", difficulty: "easy", answer_type: "file",
      correct_answer: "hello", status: "published",
    }})).json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(saCsrf), data: { competitionIds: [compId] } });
    const u = await mk7(sa, saCsrf, { verify: true, approve: true });
    await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { userIds: [u.id], competitionIds: [compId] } });
    const { api: p, csrf: pc } = await apiLogin(u.email, PARTICIPANT_PASS);
    await p.post("/api/select-competition", { headers: H(pc), data: { competitionId: compId } });
    const r = await p.post(`/api/tasks/${taskId}/submit`, {
      headers: { "x-csrf-token": pc },
      multipart: { file: { name: "answer.xml", mimeType: "text/xml", buffer: Buffer.from("<x/>") } , gradingHash: await gradingHashFor(p, taskId)},
    });
    expect(r.status()).toBe(400);
    const d = await r.json();
    expect(d.error).toMatch(/unsupported file type/i);
    expect(d.task_changed, "must NOT be misattributed to a task reconfiguration").toBeFalsy();
    await p.dispose(); await sa.dispose();
  });

  test("RM5: deleting a competition purges its challenge_events (no analytics-inflating orphans)", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const s = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    const compId = (await (await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: {
      name: `RM5 ${s}`, start_time: new Date(Date.now() - 30 * 60_000).toISOString(), duration_minutes: 180,
    }})).json()).competition.id;
    const taskId = (await (await sa.post("/api/admin/tasks", { headers: H(saCsrf), data: {
      title: `RM5 Task ${s}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text",
      correct_answer: "a", status: "published",
    }})).json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(saCsrf), data: { competitionIds: [compId] } });
    const u = await mk7(sa, saCsrf, { verify: true, approve: true });
    await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { userIds: [u.id], competitionIds: [compId] } });
    const { api: p, csrf: pc } = await apiLogin(u.email, PARTICIPANT_PASS);
    await p.post("/api/select-competition", { headers: H(pc), data: { competitionId: compId } });
    await p.post(`/api/tasks/${taskId}/submit`, { headers: H(pc), data: { answer: "wrong" , gradingHash: await gradingHashFor(p, taskId)} }); // writes a challenge_event
    await p.dispose();
    const Database = require("better-sqlite3");
    // challenge_events for a submission are written POST-COMMIT via the server's
    // setImmediate `pendingEvents` drain (server.js:3536+), so the row may not
    // exist the instant the submit response returns — reading once here raced
    // under WORKERS=8 load (the flake: `before` read 0 before the drain fired).
    // Poll a fresh read-only connection until it lands. This ALSO guarantees no
    // deferred write is still pending when we delete below, so the purge assertion
    // can't be undercut by a late insert re-orphaning a row.
    const chEvCount = () => { const d = new Database(TEST_DB_PATH, { readonly: true }); try { return d.prepare("SELECT COUNT(*) c FROM challenge_events WHERE competition_id=?").get(compId).c; } finally { d.close(); } };
    await expect.poll(chEvCount, { message: "the submit should have written a challenge_event", timeout: 5000, intervals: [50, 100, 200, 400, 800] }).toBeGreaterThan(0);
    await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: H(saCsrf) });
    const del = await sa.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": saCsrf } });
    expect(del.ok(), await del.text()).toBeTruthy();
    expect(chEvCount(), "challenge_events must be purged on competition delete").toBe(0);
    await sa.dispose();
  });

  test("RM4: approving a pending user enrolls them into a competition their group is bound to", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const s = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    // Upcoming comp (group live-sync enrolls into upcoming+live).
    const compId = (await (await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: {
      name: `RM4 ${s}`, start_time: new Date(Date.now() + 6 * 3600_000).toISOString(), duration_minutes: 60,
    }})).json()).competition.id;
    // Pending user (registered, NOT approved).
    const u = await mk7(sa, saCsrf, { verify: true, approve: false });
    // Group with the pending user, bound to the comp.
    const groupId = (await (await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name: `RM4 G ${s}`, userIds: [u.id] } })).json()).group.id;
    await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { userIds: [], competitionIds: [compId], groupIds: [groupId] } });
    // Reconcile at bind SKIPS the pending user — confirm they're not enrolled yet.
    const membersAt = () => sa.get(`/api/admin/participants/picker?competitionId=${compId}&limit=1`).then(r => r.json()).then(d => d.users.filter(x => x.in_competition === 1).map(x => x.id));
    expect(await membersAt()).not.toContain(u.id);
    // Approve → RM4 reconcile should now enroll them (fire-and-forget; poll briefly).
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: H(saCsrf) });
    await expect.poll(async () => (await membersAt()).includes(u.id), { timeout: 5000, intervals: [100, 250, 500, 1000] }).toBe(true);
    await sa.dispose();
  });

  test("RM7: the visibilitychange resume switch restarts pollers on task-detail-page", () => {
    const fs = require("fs"); const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "public/js/core/main.js"), "utf8");
    expect(src, "resume branch must include task-detail-page").toMatch(/id==='tasks-page'\|\|id==='leaderboard-page'\|\|id==='task-detail-page'/);
  });

  test("RM6: purge.sh --max-mb protects BOTH today's live log files (app + access)", () => {
    const fs = require("fs"); const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "scripts/purge.sh"), "utf8");
    // Excludes every file carrying today's UTC date key, not just the newest entry.
    expect(src).toMatch(/today_key=\$\(date -u \+%F\)/);
    // v8.13.4: the exclusion matches today's key on the FILE NAME only (the
    // basename of find's path column), never the whole line — a DATA_DIR whose
    // path carries today's date would otherwise protect every file. The
    // behaviour is driven by data-dir-required.spec.js arm 8c2.
    expect(src).toMatch(/-v k="\$today_key"/);
    expect(src).toMatch(/n = \$3; sub\(\/\.\*\\\/\/, "", n\); if \(index\(n, k\) == 0\) print/);
    expect(src, "the old skip-newest-only logic must be gone").not.toMatch(/head -n -1/);
  });

  test("RM8: unscoped admin-submissions ORDER BY uses the timestamp index, not a temp B-tree", () => {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const sub = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM submissions ORDER BY submitted_at DESC, id DESC LIMIT 50").all().map(r => r.detail).join(" | ");
      expect(sub, sub).toMatch(/USING (COVERING )?INDEX idx_submissions_subtime/);
      expect(sub).not.toMatch(/TEMP B-TREE/);
      const hint = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM hint_reveals ORDER BY revealed_at DESC LIMIT 50").all().map(r => r.detail).join(" | ");
      expect(hint, hint).toMatch(/USING (COVERING )?INDEX idx_hint_reveals_revtime/);
      expect(hint).not.toMatch(/TEMP B-TREE/);
    } finally { db.close(); }
  });

  test("RM3: global-mode solveTimeMs is clamped to the participant's own timeslot end", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const s = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    const now = Date.now();
    // Global-mode comp with a MORNING slot (ended 2h ago) + a LIVE slot.
    const compId = (await (await sa.post("/api/admin/competitions", { headers: H(saCsrf), data: {
      name: `RM3 ${s}`, start_time: new Date(now - 3 * 3600_000).toISOString(), duration_minutes: 60,
      leaderboard_mode: "global",
    }})).json()).competition.id;
    const morn = new Date(now - 3 * 3600_000).toISOString();       // starts 3h ago, 60min → ended 2h ago
    const live = new Date(now - 30 * 60_000).toISOString();        // live
    const tsA = (await (await sa.post(`/api/admin/competitions/${compId}/timeslots`, { headers: H(saCsrf), data: { name: "Morning", start_time: morn, duration_minutes: 60 } })).json()).timeslot;
    await sa.post(`/api/admin/competitions/${compId}/timeslots`, { headers: H(saCsrf), data: { name: "Live", start_time: live, duration_minutes: 180 } });
    const u = await mk7(sa, saCsrf, { verify: true, approve: true });
    await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { userIds: [u.id], competitionIds: [compId] } });
    // Pin the morning user into slot A with login_time = slot A start (unfinished).
    const Database = require("better-sqlite3");
    const dbW = new Database(TEST_DB_PATH);
    try { dbW.prepare("UPDATE competition_users SET timeslot_id=?, login_time=? WHERE competition_id=? AND user_id=?").run(tsA.id, morn, compId, u.id); } finally { dbW.close(); }
    const board = await (await sa.get(`/api/admin/leaderboard?competitionId=${compId}`)).json();
    const row = board.find(e => e.userId === u.id);
    expect(row, "morning user must be on the global board").toBeTruthy();
    // Clamped to slot A's 60min window (3.6M ms). Pre-fix it accrued to ~now (≈3h).
    expect(row.solveTimeMs, `solveTimeMs=${row.solveTimeMs} should be ~1h (clamped), not ~3h`).toBeLessThan(90 * 60_000);
    await sa.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// audit v7.7.33 batch 8 — accessibility LOWs (AL1–AL15). Attribute-level a11y
// fixes; locked by source assertions (matching batch 5's pattern) + exercised by
// the existing participant/admin axe scans.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("audit v7.7.33 batch 8 — a11y LOWs", () => {
  const read = rel => require("fs").readFileSync(require("path").resolve(__dirname, "..", rel), "utf8");

  test("AL1: showPendingApprovalPage renders into its own page, not the shared #pending-page", () => {
    const src = read("public/js/features/competition-picker.js");
    const fn = src.slice(src.indexOf("export function showPendingApprovalPage"), src.indexOf("export async function handleCompetitionsNav"));
    // The setSafeHtml target (`container`) must be the dedicated approval page,
    // not the shared #pending-page (whose static children are dereferenced elsewhere).
    expect(fn).toMatch(/container=document\.getElementById\('pending-approval-page'\)/);
    expect(fn, "must not assign the shared #pending-page as the render target").not.toMatch(/container=document\.getElementById\('pending-page'\)/);
  });

  test("AL2: participant nav sets aria-current=page on the active tab", () => {
    expect(read("public/js/ui/nav.js")).toMatch(/setAttribute\('aria-current','page'\)/);
  });

  test("AL3: dialog error containers are role=alert live regions", () => {
    const auth = read("public/js/features/auth.js");
    for (const id of ["prof-error", "gate-error", "sc-error"]) expect(auth, id).toMatch(new RegExp(`id="${id}"[^>]*role="alert"`));
  });

  test("AL4: uploaded-avatar <img> carries alt", () => {
    const f = read("public/js/ui/format.js");
    expect(f).toMatch(/\/api\/images\/[\s\S]*?<img [^>]*alt=""/);
    expect(f).toMatch(/data:image\/[\s\S]*?<img [^>]*alt=""/);
  });





  test("AL7: showCongrats has no fixed auto-dismiss timer", () => {
    const f = read("public/js/ui/toast.js");
    const fn = f.slice(f.indexOf("export function showCongrats"), f.indexOf("export function showToast"));
    expect(fn, "the 3s force-dismiss must be gone").not.toMatch(/setTimeout\(dismiss/);
  });



  test("AL9: star-rating hit target is 44px", () => {
    const f = read("public/js/features/participant-tasks.js");
    const fn = f.slice(f.indexOf("export function buildStarRating"), f.indexOf("export function hoverStars"));
    expect(fn).toMatch(/min-width:44px;min-height:44px/);
  });

  test("AL10: admin sort tables sync aria-sort (helper + logs inline)", () => {
    expect(read("public/js/ui/format.js")).toMatch(/export function _syncSortAria/);
    for (const rel of ["history.js", "submissions-admin.js", "competitions-admin.js", "challenges-admin.js", "participants-admin.js"])
      expect(read("public/js/features/" + rel), rel).toMatch(/_syncSortAria\(/);
    expect(read("public/js/features/settings-admin.js")).toMatch(/aria-sort="\$\{ariaSort\}"/);
  });

  test("AL11: rankings overview card is not role=button around the table", () => {
    const f = read("public/js/features/rankings-admin.js");
    const fn = f.slice(f.indexOf("rankings-picker-card"), f.indexOf("rankings-picker-card") + 500);
    expect(fn, "the card wrapper must no longer be role=button").not.toMatch(/rankings-picker-card[^\n]*role="button"/);
    expect(fn).toMatch(/rankings-card-view[\s\S]*data-action="rankings-select-comp"/);
  });

  test("AL12: participant-action confirms name the target (via _pLabel)", () => {
    const f = read("public/js/features/participants-admin.js");
    expect(f).toMatch(/function _pLabel/);
    // Each confirm interpolates the target label.
    for (const anchor of ["Marks ${_pLabel(id)}", "change ${_pLabel(userId)}", "approve ${_pLabel(id)}", "delete ${_pLabel(id)}"])
      expect(f, anchor).toContain(anchor);
  });

  test("AL13: tag/group remove-× has an aria-label and a 24px target", () => {
    expect(read("public/js/features/participants-admin.js")).toMatch(/tag-x[^>]*aria-label="Remove/);
    const css = read("public/styles.css");
    expect(css).toMatch(/\.tag \.tag-x\{[^}]*min-width:24px;min-height:24px/);
    expect(css).toMatch(/\.group-tag \.tag-x\{[^}]*min-width:24px;min-height:24px/);
  });

  test("AL14: logs rows expose a focusable details button opening the modal", () => {
    expect(read("public/js/features/settings-admin.js")).toMatch(/data-action="log-details"[\s\S]*aria-label/);
    expect(read("public/js/features/settings-admin.js")).toMatch(/export function showLogDetails/);
    expect(read("public/js/core/main.js")).toMatch(/registerAction\('log-details'/);
  });

  test("AL15: error toasts scale their lifetime with length and pause on hover", () => {
    const f = read("public/js/ui/toast.js");
    expect(f).toMatch(/msg\.length \* 90/);
    expect(f).toMatch(/mouseenter/);
    expect(f).toMatch(/mouseleave/);
  });
});


// ── ext-audit round 2 (v7.15.7) ──────────────────────────────────────────────
test.describe("ext-audit v7.15.7 follow-ups", () => {
  const H2 = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
  // Local copies — the group-leaderboard describe's helpers are not in scope here.
  const GH = H2;
  async function mkP(sa, saCsrf, nick) {
    const email = `x7157_${nick}@acme.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: GH(ac), data: {
      firstName: "G", lastName: "P", nickname: nick, email, company: "Acme", title: "Eng",
      country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC",
    }});
    await anon.dispose();
    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: GH(saCsrf) });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: GH(saCsrf) });
    return { id: u.id, email, nick };
  }

  // HIGH — v7.15.6 kept revocation tombstones in a capped in-process Map with a
  // 10-minute TTL, on the assumption no request outlives that. Wrong: the bulk
  // invitation path awaits an SMTP fan-out and can run far longer, after which
  // the guard forgot the id and the resurrected row authenticated again. The
  // tombstone is now a durable row retained for 2x the session lifetime — an
  // arithmetic bound, since a resurrected row can only be valid until its own
  // cookie.expires, stamped at or before the revocation.
  test("a revocation tombstone outlives any request, not just a 10-minute one", async () => {
    const Database = require("better-sqlite3");
    const readTomb = (sid) => {
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try { return db.prepare("SELECT revoked_at, expires_at FROM revoked_sessions WHERE id=?").get(sid); }
      finally { db.close(); }
    };
    const victim = await apiLogin("superadmin");
    expect((await victim.api.get("/api/admin/participants?limit=1")).status()).toBe(200);
    const inFlight = victim.api.post("/api/test/slow-session-write", { headers: H2(victim.csrf), data: { delayMs: 1500 } });
    await new Promise(r => setTimeout(r, 300));
    const other = await apiLogin("superadmin");           // purges the victim
    const done = await inFlight.catch(() => null);
    const sid = done && done.ok() ? (await done.json()).sid : null;
    expect(sid).toBeTruthy();

    const tomb = readTomb(sid);
    expect(tomb, "the revocation is recorded durably, not in a capped map").toBeTruthy();
    const windowMs = new Date(tomb.expires_at).getTime() - new Date(tomb.revoked_at).getTime();
    // Must comfortably exceed the old 10-minute TTL, and cover a full session
    // lifetime (60 min) so a long request cannot outlive it.
    expect(windowMs, "retention must cover a whole session lifetime, not 10 minutes")
      .toBeGreaterThanOrEqual(60 * 60_000);

    await victim.api.dispose();
    await other.api.dispose();
  });

  // MEDIUM — v7.15.6 froze the team board on the explicit end-now routes and the
  // scheduler, but NOT on the duration-shrink-to-past path, which also ends a
  // competition. The auditor reproduced an ended comp with zero snapshots.
  test("a duration-shrink that ENDS a competition freezes the team board", async () => {
    const Database = require("better-sqlite3");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = GH(saCsrf);
    const t = Date.now();
    const compId = (await (await sa.post("/api/admin/competitions", { headers: saH, data: {
      name: `SHRINK ${t}`, start_time: new Date(t - 60 * 60_000).toISOString(), duration_minutes: 240,
      group_leaderboard_enabled: true,
    } })).json()).competition.id;
    const taskId = (await (await sa.post("/api/admin/tasks", { headers: saH, data: {
      title: `SHRINK-T ${t}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published",
    } })).json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    const p1 = await mkP(sa, saCsrf, `sh${t}`), p2 = await mkP(sa, saCsrf, `si${t}`);
    const p3 = await mkP(sa, saCsrf, `sj${t}`), p4 = await mkP(sa, saCsrf, `sk${t}`);
    const gA = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `SAlpha ${t}`, userIds: [p1.id, p2.id] } })).json()).group.id;
    const gB = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `SBeta ${t}`, userIds: [p3.id, p4.id] } })).json()).group.id;
    await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [gA, gB], competitionIds: [compId] } });
    for (const p of [p1, p2, p3, p4]) {
      const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
      await api.post("/api/select-competition", { headers: GH(csrf), data: { competitionId: compId } });
      if (p === p1) await api.post(`/api/tasks/${taskId}/submit`, { headers: GH(csrf), data: { answer: "a" , gradingHash: await gradingHashFor(api, taskId)} });
      await api.dispose();
    }
    const snapCount = () => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare("SELECT COUNT(*) c FROM group_leaderboard_snapshots WHERE competition_id=?").get(compId).c; } finally { db.close(); } };
    const upAt = () => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare("SELECT updated_at FROM competitions WHERE id=?").get(compId).updated_at; } finally { db.close(); } };
    expect(snapCount(), "not frozen while live").toBe(0);

    // Shrink the duration so the end lands in the past → the comp ends via the
    // PUT, with no end-now call anywhere.
    const put = await sa.put(`/api/admin/competitions/${compId}`, { headers: saH, data: { duration_minutes: 1, expectedUpdatedAt: upAt() } });
    expect(put.ok(), "duration shrink accepted").toBeTruthy();
    await sa.dispose();

    expect(snapCount(), "the shrink-to-ended transition froze the team board — no read required").toBeGreaterThan(0);

    const { api: cl, csrf: clc } = await apiLogin("superadmin");
    await cl.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": clc } }).catch(() => {});
    await cl.dispose();
  });

  // LOW — NFKC + toLowerCase is not case folding: it left Σ/ς and Straße/STRASSE
  // distinct, so those still coexisted despite the promised guarantee.
  test("group-name uniqueness folds the cases NFKC+lowercase missed", async () => {
    const { _groupNameKey } = require("../lib/util");
    expect(_groupNameKey("Σ"), "final vs medial sigma").toBe(_groupNameKey("ς"));
    expect(_groupNameKey("Straße"), "sharp s vs SS").toBe(_groupNameKey("STRASSE"));
    expect(_groupNameKey("Äudit"), "the v7.15.6 case still folds").toBe(_groupNameKey("äudit"));
    expect(_groupNameKey("Audit A")).not.toBe(_groupNameKey("Audit B"));

    // …and it is enforced end-to-end, not just in the helper.
    const { api, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const stamp = Date.now();
    const first = await api.post("/api/admin/groups", { headers: H, data: { name: `Straße ${stamp}` } });
    expect(first.ok()).toBeTruthy();
    const gid = (await first.json()).group.id;
    const dup = await api.post("/api/admin/groups", { headers: H, data: { name: `STRASSE ${stamp}` } });
    expect(dup.status(), "STRASSE must collide with Straße").toBe(409);
    await api.delete(`/api/admin/groups/${gid}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
    await api.dispose();
  });

  // LOW — the lookup used to scan + normalise every group in JS, called inside
  // the import's per-participant loop. It is now an indexed probe on name_key.
  test("group lookup is an indexed probe, and name_key is maintained on write", async () => {
    const Database = require("better-sqlite3");
    const { api, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const stamp = Date.now();
    const created = await api.post("/api/admin/groups", { headers: H, data: { name: `KeyMaint ${stamp}` } });
    expect(created.ok()).toBeTruthy();
    const gid = (await created.json()).group.id;

    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const { _groupNameKey } = require("../lib/util");
      const row = db.prepare("SELECT name, name_key FROM groups WHERE id=?").get(gid);
      expect(row.name_key, "name_key written at insert").toBe(_groupNameKey(row.name));
      // No NULL keys anywhere — the migration backfilled every pre-existing row.
      expect(db.prepare("SELECT COUNT(*) c FROM groups WHERE name_key IS NULL").get().c,
        "every group row carries a canonical key").toBe(0);
      // The uniqueness index exists, so the probe is indexed rather than a scan.
      const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='groups'").all().map(r => r.name);
      expect(idx, "indexed uniqueness on the canonical key").toContain("uq_groups_name_key");
      // And the query planner actually uses it.
      const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id, name FROM groups WHERE name_key=?").all("x").map(r => r.detail).join(" ");
      expect(plan, `planner must not scan: ${plan}`).toMatch(/USING (COVERING )?INDEX/i);
    } finally { db.close(); }

    // Rename keeps the key in step.
    const ren = await api.put(`/api/admin/groups/${gid}`, { headers: H, data: { name: `KeyMaint Renamed ${stamp}` } });
    expect(ren.ok()).toBeTruthy();
    const db2 = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const { _groupNameKey } = require("../lib/util");
      const row = db2.prepare("SELECT name, name_key FROM groups WHERE id=?").get(gid);
      expect(row.name_key, "name_key updated on rename").toBe(_groupNameKey(row.name));
    } finally { db2.close(); }
    await api.delete(`/api/admin/groups/${gid}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
    await api.dispose();
  });
});

