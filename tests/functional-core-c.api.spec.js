// @ts-check
//
// Split from functional-core.api.spec.js in v7.21.37 — it was 115s in one file, and a spec
// file never spans workers, so it bounded the whole suite's wall clock.
//
// Contains: Participant · Admin restrictions · Timeslot edit audit (v6.2.7) · Session enforcement · Sliding session expiry (v7.14.4) · Challenge events analytics · v6.10.51: stable pagination tiebreakers · Superadmin rotation cooldown (v6.3.2) · Invitation response buckets (v6.3.2) · Admin submissions — server-side pagination + search (v6.3.3) · Leaderboard ranking invariant (v7.8.1) · Group-level leaderboard (v7.11.0) · Task recalc idempotency · Scheduler + submission race conditions · v6.13.17 — content-hashed static asset Cache-Control · LinkedIn complete: edge-case error codes (v6.18.x) · Schema migration — upgrade safety · audit v7.7.26 batch 1 — live multi-session edit + not-started 403 · audit v7.7.30 batch 5 — a11y static locks · audit v7.7.38 (batch 13) — rerun findings · Bulk assign challenges to competitions (v7.12.0)
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

test.describe("Participant", () => {
  test("csrf-token endpoint works", async () => {
    const { api } = await freshCtx();
    const r = await api.get("/api/csrf-token");
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).csrfToken).toBeTruthy();
    await api.dispose();
  });

  test("login returns assigned competitions", async () => {
    await ensureState();
    const { api, body } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    expect(body.competitions.length).toBeGreaterThanOrEqual(2);
    await api.dispose();
  });

  test("/api/me returns correct profile", async () => {
    const { api } = await aliceInLive();
    const me = await (await api.get("/api/me")).json();
    expect(me.first_name).toBe("Alice");
    expect(me.last_name).toBe("Smith");
    expect(me.email).toBe("alice@acme.com");
    expect(me.nickname).toBe("alice_s");
    await api.dispose();
  });

  test("/api/tasks returns competition tasks only", async () => {
    const { api } = await aliceInLive();
    const tasks = await (await api.get("/api/tasks")).json();
    const titles = tasks.map(t => t.title);
    expect(titles).toContain("Challenge easy1");
    expect(titles).toContain("Challenge med1");
    expect(titles).toContain("Challenge hard1");
    expect(titles).not.toContain("Challenge draft1");
    expect(titles).not.toContain("Challenge easy2"); // easy2 only in upcoming
    await api.dispose();
  });

  test("tasks in live competition have task_number assigned", async () => {
    const { api } = await aliceInLive();
    const tasks = await (await api.get("/api/tasks")).json();
    // Anti-vacuity: an empty list satisfies every per-task assertion below.
    expect(tasks.length, "the live competition serves challenges").toBeGreaterThan(0);
    // All tasks should have task_number
    for (const t of tasks) {
      expect(t.task_number, `task "${t.title}" served without a task_number`).toBeTruthy();
      // Format: N.MM where N is difficulty level
      expect(t.task_number).toMatch(/^[123]\.\d{2}$/);
    }
    // Easy tasks start with 1, medium with 2, hard with 3
    const easy = tasks.filter(t => t.difficulty === "easy");
    const medium = tasks.filter(t => t.difficulty === "medium");
    const hard = tasks.filter(t => t.difficulty === "hard");
    for (const t of easy) expect(t.task_number).toMatch(/^1\./);
    for (const t of medium) expect(t.task_number).toMatch(/^2\./);
    for (const t of hard) expect(t.task_number).toMatch(/^3\./);
    await api.dispose();
  });

  test("task detail includes task_number", async () => {
    const { api } = await aliceInLive();
    const t = await (await api.get(`/api/tasks/${S.easy1.id}`)).json();
    expect(t.task_number).toMatch(/^1\.\d{2}$/);
    await api.dispose();
  });

  // Regression: adding a task to a competition AFTER it went live previously
  // skipped numbering for the new task — the early-exit "skip if any task in
  // the comp already has a number" left it stuck on NULL forever, so
  // participants saw the new task as "(unnumbered)" alongside numbered ones.
  // The fix initialises per-difficulty counters from the max already
  // assigned and only numbers rows lacking one.
  test("late-added task in a live competition gets a task_number on next fetch", async () => {
    await ensureState();
    // Force initial numbering FIRST so when we add the new task below, the
    // pre-fix bug condition exists (some tasks already numbered, exit-early
    // would skip the new one). Without this, the test could pass against a
    // broken implementation just because numbering hadn't happened yet.
    const { api: warm } = await aliceInLive();
    const tasksBefore = await (await warm.get("/api/tasks")).json();
    expect(tasksBefore.every(x => x.task_number)).toBe(true);
    const beforeNumbersById = new Map(tasksBefore.map(x => [x.id, x.task_number]));
    await warm.dispose();

    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    // Add a fresh hard task to the already-live Test Live competition.
    const t = Date.now();
    const cr = await sa.post("/api/admin/tasks", {
      headers: saH,
      data: {
        title: `LateHard-${t}`, description: "<p>Late add</p>",
        difficulty: "hard", answer_type: "text", correct_answer: "x",
        explanation: "—", status: "published",
      },
    });
    const bankTaskId = (await cr.json()).id;
    const ar = await sa.post(`/api/admin/tasks/${bankTaskId}/competitions`, {
      headers: saH, data: { competitionIds: [S.liveComp.id] },
    });
    expect(ar.ok()).toBeTruthy();
    // The event's own copy is what its participants are served (lib/event-copies.js).
    const newTaskId = (await ar.json()).copies[0].task_id;
    await sa.dispose();
    // Drive numbering by hitting /api/tasks as a participant. ensureTaskNumbers
    // runs synchronously inside that handler.
    const { api } = await aliceInLive();
    const tasks = await (await api.get("/api/tasks")).json();
    const added = tasks.find(x => x.id === newTaskId);
    expect(added).toBeTruthy();
    // Must have a number now, in the hard bucket (3.NN), and the format gate.
    expect(added.task_number).toBeTruthy();
    expect(added.task_number).toMatch(/^3\.\d{2}$/);
    // Existing tasks must keep their original numbers (no renumbering).
    for (const t of tasks) {
      const prev = beforeNumbersById.get(t.id);
      if (prev) expect(t.task_number).toBe(prev);
    }
    await api.dispose();
  });

  // Cross-cutting invariant: NO task served to a participant via /api/tasks
  // for a live competition is allowed to be unnumbered. Catches both the
  // late-add bug above and any future regression that bypasses the
  // ensureTaskNumbers call on the hot read path.
  // First-of-difficulty case the user reported: a competition that initially
  // had no hard tasks must number the FIRST hard task added as 3.01.
  test("first hard task added to a previously-no-hard live competition gets 3.01", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const t = Date.now();
    // Build a fresh live competition with ONLY easy + medium tasks.
    const compR = await sa.post("/api/admin/competitions", {
      headers: saH,
      data: {
        name: `NoHard-${t}`,
        start_time: new Date(Date.now() - 60_000).toISOString(),
        duration_minutes: 120,
      },
    });
    const comp = (await compR.json()).competition;
    const mkTask = async (diff, title) => {
      const r = await sa.post("/api/admin/tasks", {
        headers: saH,
        data: {
          title, description: "<p>x</p>",
          difficulty: diff, answer_type: "text", correct_answer: "x",
          explanation: "—", status: "published",
        },
      });
      return (await r.json()).id;
    };
    const easyId = await mkTask("easy", `NoHard-easy-${t}`);
    const medId = await mkTask("medium", `NoHard-med-${t}`);
    await sa.post(`/api/admin/tasks/${easyId}/competitions`, { headers: saH, data: { competitionIds: [comp.id] } });
    await sa.post(`/api/admin/tasks/${medId}/competitions`, { headers: saH, data: { competitionIds: [comp.id] } });
    // Assign Alice and have her open the comp so /api/tasks runs the
    // numbering pass for easy + medium only.
    await sa.post("/api/admin/competitions/assign", {
      headers: saH, data: { userIds: [S.alice.id], competitionIds: [comp.id] },
    });
    const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await alice.post("/api/select-competition", {
      headers: { "x-csrf-token": aliceCsrf, "content-type": "application/json" },
      data: { competitionId: comp.id },
    });
    await alice.get("/api/tasks");
    await alice.dispose();
    // Now add the FIRST hard task to the live comp.
    const hardBankId = await mkTask("hard", `NoHard-hard-${t}`);
    const hardAr = await sa.post(`/api/admin/tasks/${hardBankId}/competitions`, { headers: saH, data: { competitionIds: [comp.id] } });
    expect(hardAr.ok(), await hardAr.text()).toBeTruthy();
    const hardId = (await hardAr.json()).copies[0].task_id;   // the event's own copy
    await sa.dispose();
    // Re-fetch as Alice — the new hard task must be numbered 3.01.
    const { api: alice2, csrf: alice2Csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await alice2.post("/api/select-competition", {
      headers: { "x-csrf-token": alice2Csrf, "content-type": "application/json" },
      data: { competitionId: comp.id },
    });
    const tasks = await (await alice2.get("/api/tasks")).json();
    const hard = tasks.find(x => x.id === hardId);
    expect(hard).toBeTruthy();
    expect(hard.task_number).toBe("3.01");
    await alice2.dispose();
  });

  test("solved task shows as solved", async () => {
    const { api } = await aliceInLive();
    const t = await (await api.get(`/api/tasks/${S.easy1.id}`)).json();
    expect(t.solved).toBeTruthy();
    await api.dispose();
  });

  test("leaderboard sorted with correct scores", async () => {
    const { api } = await aliceInLive();
    const lbData = await (await api.get("/api/leaderboard")).json();
    const entries = Array.isArray(lbData) ? lbData : (lbData.board || lbData.entries || []);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1].score).toBeGreaterThanOrEqual(entries[i].score);
    }
    const alice = entries.find(e => e.nickname === "alice_s");
    expect(alice).toBeTruthy();
    expect(alice.score).toBe(45); // +50 easy, -5 wrong med
    await api.dispose();
  });

  test("cannot access admin endpoints (403)", async () => {
    const { api } = await aliceInLive();
    expect((await api.get("/api/admin/tasks")).status()).toBe(403);
    expect((await api.get("/api/admin/participants")).status()).toBe(403);
    await api.dispose();
  });
});


test.describe("Admin restrictions", () => {
  // v7.21.37 — moved INSIDE this describe (its only user) so it travels with
  // the block when the file is split, rather than being left between blocks.
  async function loginAsRegularAdmin() {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { role: "admin" },
    });
    await sa.dispose();
    return apiLogin("carol@acme.com", PARTICIPANT_PASS);
  }
  // Carol is a SEEDED fixture, promoted to admin by loginAsRegularAdmin above.
  // EVERY caller must run this from a `finally`: a failing assertion that leaks
  // her promotion leaves the rest of the file running against an admin-role
  // carol, and the v8.3.28 fixture guard then fails the whole FILE.
  async function restoreCarol(extraApi) {
    if (extraApi) await extraApi.dispose();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, {
      headers: { "x-csrf-token": saCsrf, "content-type": "application/json" },
      data: { role: "participant" },
    });
    await sa.dispose();
  }

  test("admin cannot delete competitions", async () => {
    const { api, csrf } = await loginAsRegularAdmin();
    try {
      const r = await api.delete(`/api/admin/competitions/${S.liveComp.id}`, {
        headers: { "x-csrf-token": csrf },
      });
      expect(r.status()).toBe(403);
    } finally {
      await restoreCarol(api);
    }
  });

  test("admin cannot access the superadmin-only GLOBAL CxOne config", async () => {
    // v7.13.2 — the GLOBAL default CxOne config stays superadmin-only. (The
    // PER-COMPETITION override is admin-level by design — see the dedicated test in
    // "Endpoint coverage".)
    const { api, csrf } = await loginAsRegularAdmin();
    try {
      const r = await api.put(`/api/admin/default-cxone`, {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { cxone_group_name: "test" },
      });
      expect(r.status()).toBe(403);
    } finally {
      await restoreCarol(api);
    }
  });

  test("admin cannot delete users", async () => {
    const { api, csrf } = await loginAsRegularAdmin();
    try {
      const r = await api.delete(`/api/admin/participants/${S.bob.id}`, {
        headers: { "x-csrf-token": csrf },
      });
      expect(r.status()).toBe(403);
    } finally {
      await restoreCarol(api);
    }
  });

  test("admin cannot change user roles", async () => {
    const { api, csrf } = await loginAsRegularAdmin();
    try {
      const r = await api.post(`/api/admin/participants/${S.bob.id}/role`, {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { role: "admin" },
      });
      expect(r.status()).toBe(403);
    } finally {
      await restoreCarol(api);
    }
  });

  test("admin cannot block superadmin", async () => {
    // v8.12.4 — a USER-BACKED superadmin is made first. The seed has none (the
    // built-in account has no user row), so the old `if (sa)` skipped the
    // assertion on every run and the test asserted nothing.
    const { makeParticipant } = require("./event-admin-helpers");
    const { api: root, csrf: rc } = await apiLogin("superadmin");
    const H = { "x-csrf-token": rc, "content-type": "application/json" };
    const target = await makeParticipant(root, rc, "blk-sa");
    expect((await root.post(`/api/admin/participants/${target.id}/role`, { headers: H, data: { role: "superadmin" } })).ok(), "promote").toBeTruthy();
    const plain = await makeParticipant(root, rc, "blk-plain");
    await root.dispose();
    const { api, csrf } = await loginAsRegularAdmin();
    try {
      const r = await api.post(`/api/admin/participants/${target.id}/block`, { headers: { "x-csrf-token": csrf } });
      expect(r.status(), "a regular admin may not block a superadmin").toBe(403);
      // CONTROL: the same admin CAN block an ordinary participant.
      const ok = await api.post(`/api/admin/participants/${plain.id}/block`, { headers: { "x-csrf-token": csrf } });
      expect(ok.status(), `…and may block a participant: ${await ok.text()}`).toBe(200);
    } finally {
      await restoreCarol(api);
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// TIMESLOT EDIT AUDIT — v6.2.7
// Per the v6.2.7 report, editing two sessions of a competition used to produce
// a single flat audit row per timeslot with only GUIDs (no competition name,
// no session name, no visible attribution), and no competition-level event
// marking the derived end-time shift. These tests lock the three fixes in.
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Timeslot edit audit (v6.2.7)", () => {
  test("editing a timeslot mirrors a log entry with competition_name, timeslot_name, and changed_by", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tStamp = Date.now();
    // Fresh multi-slot competition so the test is hermetic.
    let r = await api.post("/api/admin/competitions", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: `Audit-Names-${tStamp}`, start_time: new Date(tStamp + 3600_000).toISOString(), duration_minutes: 240 },
    });
    const compId = (await r.json()).competition.id;
    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: `Cohort-A-${tStamp}`, start_time: new Date(tStamp + 3600_000).toISOString(), duration_minutes: 60 },
    });
    const tsId = (await r.json()).timeslot.id;

    // Edit the session — duration + name.
    r = await api.put(`/api/admin/competitions/${compId}/timeslots/${tsId}`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: `Cohort-A-Renamed-${tStamp}`, duration_minutes: 90 },
    });
    expect(r.ok()).toBeTruthy();

    // Pull the app log and find the edit row. The new schema requires:
    //   details.timeslot_name     — present + matches the old value pre-edit
    //     (the enrichment happens at write time → post-rename the log mirror
    //      would see the NEW name, but since this run uses the enriched mirror,
    //      the name present is whatever the timeslot row has at log-write
    //      time, i.e. the post-update value). Assert presence, not value.
    //   details.competition_name  — matches the created competition
    //   details.competition_id    — matches compId
    //   changed_by                — the superadmin identity (literal
    //      "superadmin" string — the built-in account doesn't resolve to a
    //      user email).
    const today = new Date().toISOString().slice(0, 10);
    // POLL. The app.jsonl mirror is setImmediate-DEFERRED (_scheduleMirrorAuditToLog)
    // so the enrichment SELECTs + file write stay off the write lock — the
    // structured *_events row is synchronous, the mirror is not. A single read
    // right after the PUT races that drain, and under WORKERS=8 the loaded event
    // loop lags it (observed failing in a full-suite run while passing 5/5 in
    // isolation). CLAUDE.md names THIS test as the poll-with-cap example; it just
    // never actually polled.
    const findEditRow = async () => {
      const logs = await (await api.get(`/api/admin/logs?stream=app&date=${today}&limit=500&q=${encodeURIComponent(tsId)}`)).json();
      return (logs.entries || []).find(e => e.source === "audit" && e.scope === "timeslot" && e.event_type === "edited" && e.scope_id === tsId);
    };
    await expect.poll(async () => !!(await findEditRow()),
      { timeout: 8000, intervals: [50, 100, 200, 400, 800, 1600] }).toBe(true);
    const editRow = await findEditRow();
    expect(editRow, `No audit:timeslot:edited row found for tsId=${tsId}`).toBeTruthy();
    expect(editRow.changed_by).toBe("superadmin");
    expect(editRow.details).toBeTruthy();
    expect(typeof editRow.details.timeslot_name).toBe("string");
    expect(editRow.details.timeslot_name.length).toBeGreaterThan(0);
    expect(editRow.details.competition_id).toBe(compId);
    expect(editRow.details.competition_name).toBe(`Audit-Names-${tStamp}`);
    // Original change payload preserved.
    expect(editRow.details.changes).toBeTruthy();
    expect(editRow.details.changes.duration_minutes).toBeTruthy();

    // Cleanup.
    await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });

  test("timeslot duration edit that shifts the competition's effective end fires a competition:effective_end_shifted event", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tStamp = Date.now();
    let r = await api.post("/api/admin/competitions", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: `End-Shift-${tStamp}`, start_time: new Date(tStamp + 3600_000).toISOString(), duration_minutes: 120 },
    });
    const compId = (await r.json()).competition.id;
    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: "First", start_time: new Date(tStamp + 3600_000).toISOString(), duration_minutes: 60 },
    });
    const ts1Id = (await r.json()).timeslot.id;

    // Extend duration — this increases the timeslot's end AND the
    // competition's derived effective end.
    r = await api.put(`/api/admin/competitions/${compId}/timeslots/${ts1Id}`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { duration_minutes: 180 },
    });
    expect(r.ok()).toBeTruthy();

    // v7.22.0 — POLL the mirror. This read is against `app.jsonl`, which
    // CLAUDE.md documents as EVENTUALLY CONSISTENT: the structured *_events row
    // commits synchronously inside the writer's transaction, but the log mirror
    // is `setImmediate`-deferred (`_scheduleMirrorAuditToLog`) precisely so the
    // enrichment SELECTs and the file write stay off the better-sqlite3 write
    // lock. A single read therefore races the drain — and under WORKERS=12 the
    // loaded event loop lags that tick, which is how this surfaced as
    // "Received: undefined". The rule is already written down ("tests asserting
    // the mirror must poll-with-cap"); this test simply predated it.
    const today = new Date().toISOString().slice(0, 10);
    let shiftRow;
    await expect.poll(async () => {
      const logs = await (await api.get(`/api/admin/logs?stream=app&date=${today}&limit=500&q=${encodeURIComponent(compId)}`)).json();
      shiftRow = (logs.entries || []).find(e => e.source === "audit" && e.scope === "competition" && e.event_type === "effective_end_shifted" && e.scope_id === compId);
      return !!shiftRow;
    }, {
      timeout: 5000,
      intervals: [50, 100, 200, 400, 800],
      message: "No competition:effective_end_shifted audit row after duration extension (polled the deferred app.jsonl mirror)",
    }).toBe(true);
    expect(shiftRow.changed_by).toBe("superadmin");
    expect(shiftRow.details).toBeTruthy();
    expect(typeof shiftRow.details.from).toBe("string");
    expect(typeof shiftRow.details.to).toBe("string");
    expect(new Date(shiftRow.details.to).getTime()).toBeGreaterThan(new Date(shiftRow.details.from).getTime());
    expect(shiftRow.details.via_timeslot_id).toBe(ts1Id);
    expect(shiftRow.details.via_timeslot_name).toBe("First");

    // Name-only edit must NOT fire an end-shift event.
    r = await api.put(`/api/admin/competitions/${compId}/timeslots/${ts1Id}`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: `First-Renamed-${tStamp}` },
    });
    expect(r.ok()).toBeTruthy();
    const logs2 = await (await api.get(`/api/admin/logs?stream=app&date=${today}&limit=500&q=${encodeURIComponent(compId)}`)).json();
    const shifts = (logs2.entries || []).filter(e => e.source === "audit" && e.scope === "competition" && e.event_type === "effective_end_shifted" && e.scope_id === compId);
    expect(shifts.length, `Name-only edit should not emit effective_end_shifted. Got ${shifts.length} shift events`).toBe(1);

    await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });

  test("task audit events use semantic event_type and carry task_title + from/to diffs (v6.2.8)", async () => {
    // Regression for the v6.2.8 task-audit rework. Pre-fix every task
    // operation emitted the generic event_type "version_created" with
    // details={change_type:<string>} — the log showed WHAT changed via
    // change_type but never WHICH values moved. Now the event_type is
    // semantic (created / edited / published / visibility_toggled /
    // locked / unlocked / restored / tag_added / tag_removed) and details
    // carry either a changes:{field:{from,to}} diff or a from/to pair.
    // _mirrorAuditToLog also resolves {task_title, difficulty}.
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tStamp = Date.now();
    // Fresh task in draft so we can exercise the full lifecycle.
    let r = await api.post("/api/admin/tasks", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        title: `TaskAudit-${tStamp}`, description: "<p>orig</p>", difficulty: "easy",
        answer_type: "text", correct_answer: "alpha", explanation: "<p>e</p>",
        hint: "h", status: "draft",
      },
    });
    const taskId = (await r.json()).id;

    // 1) PUT /api/admin/tasks/:id — edit correct_answer + difficulty.
    r = await api.put(`/api/admin/tasks/${taskId}`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { correct_answer: "beta", difficulty: "medium" },
    });
    expect(r.ok()).toBeTruthy();
    // 2) PATCH visibility — active 1→0.
    r = await api.patch(`/api/admin/tasks/${taskId}/visibility`, { headers: { "x-csrf-token": csrf } });
    expect(r.ok()).toBeTruthy();
    // 3) POST publish.
    r = await api.post(`/api/admin/tasks/${taskId}/publish`, { headers: { "x-csrf-token": csrf } });
    expect(r.ok()).toBeTruthy();
    // 4) POST lock / unlock.
    r = await api.post(`/api/admin/tasks/${taskId}/lock`, { headers: { "x-csrf-token": csrf } });
    expect(r.ok()).toBeTruthy();
    r = await api.post(`/api/admin/tasks/${taskId}/lock`, { headers: { "x-csrf-token": csrf } });
    expect(r.ok()).toBeTruthy();
    // 5) Tag add + remove.
    const tagName = `t-${tStamp}`;
    r = await api.post(`/api/admin/tasks/${taskId}/tags`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { tag: tagName },
    });
    expect(r.ok()).toBeTruthy();
    r = await api.delete(`/api/admin/tasks/${taskId}/tags/${encodeURIComponent(tagName)}`, { headers: { "x-csrf-token": csrf } });
    expect(r.ok()).toBeTruthy();

    const today = new Date().toISOString().slice(0, 10);
    // v8.12.5 — polled until all eight types have landed: the mirror is deferred.
    const _taskTypes = ["created", "edited", "visibility_toggled", "published", "locked", "unlocked", "tag_added", "tag_removed"];
    const _entries = await pollAdminLogs(api, `stream=app&date=${today}&limit=500&q=${encodeURIComponent(taskId)}`,
      (es) => _taskTypes.every((t) => es.some((e) => e.source === "audit" && e.scope === "task" && e.scope_id === taskId && e.event_type === t)),
      { what: "all eight task lifecycle rows" }).catch(() => []);
    const bySite = new Map();
    for (const e of _entries) {
      if (e.source === "audit" && e.scope === "task" && e.scope_id === taskId) {
        const list = bySite.get(e.event_type) || [];
        list.push(e);
        bySite.set(e.event_type, list);
      }
    }

    // Each semantic event type fired at least once.
    for (const type of ["created", "edited", "visibility_toggled", "published", "locked", "unlocked", "tag_added", "tag_removed"]) {
      expect(bySite.get(type)?.length || 0, `Missing audit:task:${type} row`).toBeGreaterThanOrEqual(1);
    }
    // changed_by populated on all of them.
    for (const list of bySite.values()) {
      for (const e of list) expect(e.changed_by).toBe("superadmin");
    }
    // Enrichment: every task audit row carries task_title from the log mirror.
    for (const list of bySite.values()) {
      for (const e of list) expect(typeof e.details.task_title).toBe("string");
    }
    // Edit carries a scalar diff including correct_answer + difficulty.
    const editRow = bySite.get("edited")[0];
    expect(editRow.details.changes).toBeTruthy();
    expect(editRow.details.changes.correct_answer).toEqual({ from: "alpha", to: "beta" });
    expect(editRow.details.changes.difficulty).toEqual({ from: "easy", to: "medium" });
    // Visibility diff shows active 1 → 0.
    const visRow = bySite.get("visibility_toggled")[0];
    expect(visRow.details.changes.active).toEqual({ from: 1, to: 0 });
    // Publish diff shows draft → published.
    const pubRow = bySite.get("published")[0];
    expect(pubRow.details.changes.status).toEqual({ from: "draft", to: "published" });
    // Lock diff shows locked 0 → 1; unlock shows 1 → 0.
    expect(bySite.get("locked")[0].details.changes.locked).toEqual({ from: 0, to: 1 });
    expect(bySite.get("unlocked")[0].details.changes.locked).toEqual({ from: 1, to: 0 });
    // Tag events carry the tag name.
    expect(bySite.get("tag_added")[0].details.tag).toBe(tagName);
    expect(bySite.get("tag_removed")[0].details.tag).toBe(tagName);

    // Cleanup — soft-delete the test task.
    await api.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });

  test("task restore audit row carries restored_from version context (v6.2.8)", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tStamp = Date.now();
    let r = await api.post("/api/admin/tasks", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: {
        title: `RestoreAudit-${tStamp}`, description: "<p>v1</p>", difficulty: "easy",
        answer_type: "text", correct_answer: "alpha", explanation: "<p>e</p>",
        hint: "h", status: "draft",
      },
    });
    const taskId = (await r.json()).id;
    // Create a second version via edit.
    await api.put(`/api/admin/tasks/${taskId}`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { correct_answer: "beta" },
    });
    const versions = await (await api.get(`/api/admin/tasks/${taskId}/versions`)).json();
    // Restore to the oldest version (first create).
    const oldest = versions[versions.length - 1];
    r = await api.post(`/api/admin/tasks/${taskId}/restore`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { versionId: oldest.id },
    });
    expect(r.ok()).toBeTruthy();

    const today = new Date().toISOString().slice(0, 10);
    const _isRestored = (e) => e.source === "audit" && e.scope === "task" && e.event_type === "restored" && e.scope_id === taskId;
    const _rEntries = await pollAdminLogs(api, `stream=app&date=${today}&limit=500&q=${encodeURIComponent(taskId)}`,
      (es) => es.some(_isRestored), { what: "the audit:task:restored row" }).catch(() => []);
    const restoredRow = _rEntries.find(_isRestored);
    expect(restoredRow, "No audit:task:restored row found").toBeTruthy();
    expect(restoredRow.details.change_type).toBe("restore");
    expect(restoredRow.details.restored_from).toBeTruthy();
    expect(restoredRow.details.restored_from.version_id).toBe(oldest.id);
    expect(restoredRow.details.restored_from.version_num).toBe(oldest.version_num);
    expect(typeof restoredRow.details.task_title).toBe("string");
    expect(restoredRow.changed_by).toBe("superadmin");

    await api.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });

  test("admin_view_toggled audit row is logged when admin enters/leaves participant view (v6.2.8)", async () => {
    // Regression for the v6.2.8 admin-view gap: /api/toggle-admin-view used
    // to silently change session.isAdmin without logging anything, so the
    // activity log showed nothing even though the admin had meaningfully
    // switched between admin and participant data views.
    await ensureState();
    // Promote Carol to admin for the duration of this test so we can
    // exercise the toggle as a NON-builtin admin (whose changed_by is
    // recorded as the user's email, not the literal "superadmin"). Role
    // changes go through the dedicated POST endpoint — PUT
    // /api/admin/participants/:id only handles profile fields.
    const { api: sa1, csrf: sa1Csrf } = await apiLogin("superadmin");
    await sa1.post(`/api/admin/participants/${S.carol.id}/role`, {
      headers: { "x-csrf-token": sa1Csrf, "content-type": "application/json" },
      data: { role: "admin" },
    });
    await sa1.dispose();
    try {
      const { api: carol, csrf: carolCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      // An admin user's session is auto-set to isAdmin=true on login
      // (server.js:2656), so Carol starts in admin-view. First toggle
      // drops her to participant-view; second toggle puts her back.
      let r = await carol.post("/api/toggle-admin-view", {
        headers: { "x-csrf-token": carolCsrf, "content-type": "application/json" },
        data: { mode: "participant" },
      });
      expect(r.ok()).toBeTruthy();
      // Session regen invalidated the CSRF token; grab a fresh one.
      const carolCsrf2 = (await (await carol.get("/api/csrf-token")).json()).csrfToken;
      r = await carol.post("/api/toggle-admin-view", {
        headers: { "x-csrf-token": carolCsrf2, "content-type": "application/json" },
        data: { mode: "admin" },
      });
      expect(r.ok()).toBeTruthy();
      await carol.dispose();

      const { api: sa2 } = await apiLogin("superadmin");
      const today = new Date().toISOString().slice(0, 10);
      const _isToggle = (e) => e.source === "audit" && e.scope === "user" && e.event_type === "admin_view_toggled" && e.scope_id === S.carol.id;
      const _tEntries = await pollAdminLogs(sa2, `stream=app&date=${today}&limit=500&q=${encodeURIComponent(S.carol.id)}`,
        (es) => es.filter(_isToggle).length >= 2, { what: "both admin_view_toggled rows" }).catch(() => []);
      const toggles = _tEntries.filter(_isToggle);
      expect(toggles.length, "Expected two admin_view_toggled rows (enter + leave)").toBeGreaterThanOrEqual(2);
      // The order depends on log mirror flushing; find each by mode.
      const toParticipant = toggles.find(e => e.details.mode === "participant");
      const toAdmin       = toggles.find(e => e.details.mode === "admin");
      expect(toParticipant, "Missing admin→participant toggle row").toBeTruthy();
      expect(toAdmin,       "Missing participant→admin toggle row").toBeTruthy();
      expect(toParticipant.details.is_admin).toEqual({ from: true, to: false });
      expect(toAdmin.details.is_admin).toEqual({ from: false, to: true });
      // changed_by is carol's email (not "superadmin", not "system") —
      // proves the admin user's identity, not the built-in account, is
      // attributed for the toggle action.
      for (const t of toggles) expect(t.changed_by).toBe("carol@acme.com");
      await sa2.dispose();
    } finally {
      // Demote Carol back via the proper role endpoint.
      const { api: sa3, csrf: sa3Csrf } = await apiLogin("superadmin");
      await sa3.post(`/api/admin/participants/${S.carol.id}/role`, {
        headers: { "x-csrf-token": sa3Csrf, "content-type": "application/json" },
        data: { role: "participant" },
      });
      await sa3.dispose();
    }
  });

  test("editing TWO sessions produces TWO timeslot:edited rows + one effective_end_shifted roll-up", async () => {
    // Regression for the specific report: "only 1 event logged while 2
    // sessions were modified". Edit both sessions in sequence (matching
    // the client's for-loop of PUTs) and assert both edits AND the
    // competition-level roll-up land.
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const tStamp = Date.now();
    let r = await api.post("/api/admin/competitions", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: `Two-Slot-${tStamp}`, start_time: new Date(tStamp + 3600_000).toISOString(), duration_minutes: 120 },
    });
    const compId = (await r.json()).competition.id;
    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: "Cohort-A", start_time: new Date(tStamp + 3600_000).toISOString(), duration_minutes: 60 },
    });
    const tsA = (await r.json()).timeslot.id;
    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { name: "Cohort-B", start_time: new Date(tStamp + 4500_000).toISOString(), duration_minutes: 60 },
    });
    const tsB = (await r.json()).timeslot.id;

    // Edit both sessions' durations (mirrors the client's save-competition flow).
    await api.put(`/api/admin/competitions/${compId}/timeslots/${tsA}`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { duration_minutes: 90 },
    });
    await api.put(`/api/admin/competitions/${compId}/timeslots/${tsB}`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { duration_minutes: 90 },
    });

    const today = new Date().toISOString().slice(0, 10);
    // v7.2.x (audit, F7) — the structured timeslot:edited + competition:
    // effective_end_shifted rows commit synchronously inside tsEditTxn, but the
    // app.jsonl mirror the Logs stream reads is setImmediate-deferred
    // (_scheduleMirrorAuditToLog in lib/audit.js — kept off the better-sqlite3
    // write lock by design). A single immediate read can therefore race the
    // second edit's mirror line. Poll the SAME logs URL with a finite 3s cap
    // until both edits + the roll-up appear; the ceiling preserves the original
    // guard (a genuine "only 1 of 2 events" regression still fails, not hangs).
    let editsA = [], editsB = [], shifts = [];
    const _logsDeadline = Date.now() + 3000;
    do {
      const logs = await (await api.get(`/api/admin/logs?stream=app&date=${today}&limit=500&q=${encodeURIComponent(compId)}`)).json();
      const edits = (logs.entries || []).filter(e => e.source === "audit" && e.scope === "timeslot" && e.event_type === "edited");
      editsA = edits.filter(e => e.scope_id === tsA);
      editsB = edits.filter(e => e.scope_id === tsB);
      shifts = (logs.entries || []).filter(e => e.source === "audit" && e.scope === "competition" && e.event_type === "effective_end_shifted" && e.scope_id === compId);
      if (editsA.length && editsB.length && shifts.length) break;
      await new Promise(r => setTimeout(r, 40));
    } while (Date.now() < _logsDeadline);
    expect(editsA.length, "No audit row for Cohort-A edit").toBeGreaterThanOrEqual(1);
    expect(editsB.length, "No audit row for Cohort-B edit").toBeGreaterThanOrEqual(1);
    // Each row carries the competition+timeslot context.
    for (const row of [editsA[0], editsB[0]]) {
      expect(row.details.competition_id).toBe(compId);
      expect(row.details.competition_name).toBe(`Two-Slot-${tStamp}`);
      expect(typeof row.details.timeslot_name).toBe("string");
      expect(row.changed_by).toBe("superadmin");
    }
    // Competition-level roll-up is the extra event the user was missing.
    expect(shifts.length, "No competition:effective_end_shifted roll-up for two-session edit").toBeGreaterThanOrEqual(1);

    await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });

  test("v6.18.16: PUT timeslot rejects stale expectedUpdatedAt with 409, accepts correct token", async () => {
    // Regression lock for the optimistic-concurrency guard on
    // PUT /api/admin/competitions/:id/timeslots/:tsId. Without this,
    // two concurrent Start-Now or save-competition flows could
    // silently overwrite each other's schedule changes.
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const tStamp = Date.now();
    let r = await api.post("/api/admin/competitions", {
      headers: h,
      data: { name: `OC-Ts-${tStamp}`, start_time: new Date(tStamp + 3600_000).toISOString(), duration_minutes: 60 },
    });
    const compId = (await r.json()).competition.id;
    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, {
      headers: h,
      data: { name: "OC-Slot", start_time: new Date(tStamp + 3600_000).toISOString(), duration_minutes: 60 },
    });
    const ts = (await r.json()).timeslot;
    expect(ts.updated_at, "timeslot must have updated_at after creation").toBeTruthy();

    try {
      // Stale token → 409
      const stale = await api.put(`/api/admin/competitions/${compId}/timeslots/${ts.id}`, {
        headers: h,
        data: { duration_minutes: 90, expectedUpdatedAt: "2020-01-01T00:00:00.000Z" },
      });
      expect(stale.status(), "stale expectedUpdatedAt should 409").toBe(409);
      const staleBody = await stale.json();
      expect(staleBody.conflict).toBe(true);
      expect(staleBody.currentUpdatedAt).toBe(ts.updated_at);

      // Omitting expectedUpdatedAt → 200 (backward compat)
      const noToken = await api.put(`/api/admin/competitions/${compId}/timeslots/${ts.id}`, {
        headers: h,
        data: { duration_minutes: 90 },
      });
      expect(noToken.status(), "omitting expectedUpdatedAt should still 200").toBe(200);
      const updatedTs = (await noToken.json()).timeslot;
      expect(updatedTs.updated_at, "updated_at must advance after PUT").not.toBe(ts.updated_at);

      // Correct token after the first edit → 200
      const correct = await api.put(`/api/admin/competitions/${compId}/timeslots/${ts.id}`, {
        headers: h,
        data: { duration_minutes: 120, expectedUpdatedAt: updatedTs.updated_at },
      });
      expect(correct.status(), "correct expectedUpdatedAt should 200").toBe(200);
    } finally {
      await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } });
      await api.dispose();
    }
  });
});


test.describe("Session enforcement", () => {
  test("CSRF error returns csrf_invalid and destroys session", async () => {
    const { api } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    // Verify session works before CSRF error
    const meBefore = await api.get("/api/me");
    expect(meBefore.ok()).toBe(true);

    // Send request with invalid CSRF token
    const r = await api.post("/api/logout", {
      headers: { "x-csrf-token": "invalid-token", "content-type": "application/json" },
    });
    expect(r.status()).toBe(403);
    const d = await r.json();
    expect(d.error).toBe("csrf_invalid");

    // Session should be destroyed — subsequent request fails
    const meAfter = await api.get("/api/me");
    expect(meAfter.status()).toBe(401);
    await api.dispose();
  });

  test("single session enforcement — second login invalidates first session", async () => {
    // Login as Alice — session 1
    const { api: api1, csrf: csrf1 } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    // Verify session 1 works
    const me1 = await api1.get("/api/me");
    expect(me1.ok()).toBe(true);

    // Login as Alice again — session 2 (should invalidate session 1)
    const { api: api2, csrf: csrf2 } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const me2 = await api2.get("/api/me");
    expect(me2.ok()).toBe(true);

    // Session 1 should now be invalid
    const me1After = await api1.get("/api/me");
    expect(me1After.status()).toBe(401);

    await api1.dispose();
    await api2.dispose();
  });

  test("single session enforcement — different users not affected", async () => {
    // Login as Alice and Bob simultaneously
    const { api: aliceApi } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const { api: bobApi } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);

    // Both sessions should work
    const aliceMe = await aliceApi.get("/api/me");
    expect(aliceMe.ok()).toBe(true);
    const bobMe = await bobApi.get("/api/me");
    expect(bobMe.ok()).toBe(true);

    await aliceApi.dispose();
    await bobApi.dispose();
  });

  test("single session enforcement — superadmin second login invalidates first", async () => {
    const { api: api1 } = await apiLogin("superadmin");
    const me1 = await api1.get("/api/admin/me");
    expect(me1.ok()).toBe(true);

    // Login as superadmin again — session 2
    const { api: api2 } = await apiLogin("superadmin");
    const me2 = await api2.get("/api/admin/me");
    expect(me2.ok()).toBe(true);

    // Session 1 should now be invalid
    const me1After = await api1.get("/api/admin/me");
    expect(me1After.status()).toBe(401);

    await api1.dispose();
    await api2.dispose();
  });

  test("logout_single_session event is no longer emitted by self-login (info folded into login_success)", async () => {
    // Self-login termination of the user's own prior sessions is no longer emitted as a
    // separate event — it's surfaced via `details.terminated_sessions` on login_success.
    const { api: a1 } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    await a1.dispose();
    const { api: sa1 } = await apiLogin("superadmin");
    const parts = (await (await sa1.get("/api/admin/participants?limit=200")).json()).participants;
    const bob = parts.find(p => p.email === "bob@acme.com");
    const evBefore = await (await sa1.get(`/api/admin/participants/${bob.id}/events`)).json();
    const lssBefore = evBefore.filter(e => e.event_type === "logout_single_session").length;
    await sa1.dispose();
    // Log Bob in again — prior session still live on server; would previously fire logout_single_session
    const { api: a2 } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    await a2.dispose();
    const { api: sa2 } = await apiLogin("superadmin");
    const evAfter = await (await sa2.get(`/api/admin/participants/${bob.id}/events`)).json();
    const lssAfter = evAfter.filter(e => e.event_type === "logout_single_session").length;
    // Assert: no new logout_single_session events emitted.
    expect(lssAfter).toBe(lssBefore);
    // And: the new login_success event records the termination count inline.
    const latestLogin = evAfter.filter(e => e.event_type === "login_success").slice(0)[0]; // events are DESC by changed_at
    expect(latestLogin).toBeTruthy();
    expect(latestLogin.details?.terminated_sessions).toBeGreaterThanOrEqual(1);
    await sa2.dispose();
  });

  test("built-in admin login no longer exists", async () => {
    const { api, csrf } = await freshCtx();
    const r = await api.post("/api/login", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { email: "admin", password: "anything" },
    });
    expect(r.status()).toBe(401);
    await api.dispose();
  });

  test("superadmin failed attempts do not lock out before threshold", async () => {
    // v6.10.27: reset the global counter first via a successful login
    // then IMMEDIATELY dispose so the session side-effects don't
    // collide with subsequent freshCtx login attempts. Pre-fix the
    // test fired 9 failed attempts cold — if any other test in the
    // same worker had already bumped the counter, 9 + N ≥ 10 tripped
    // the rotation and changed SUPERADMIN_PASS under the final login
    // call. Each worker has its own in-process counter, so this
    // seed-and-reset is worker-local and hermetic.
    const seed = await apiLogin("superadmin");
    await seed.api.dispose();
    // Send 9 wrong attempts (threshold is 10), then the correct password should still work
    for (let i = 0; i < 9; i++) {
      const { api, csrf } = await freshCtx();
      const r = await api.post("/api/login", {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { email: "superadmin", password: "wrong-password" },
      });
      expect(r.status()).toBe(401);
      await api.dispose();
    }
    // Correct password still works (counter resets on success)
    const { api } = await apiLogin("superadmin");
    const me = await api.get("/api/admin/me");
    expect(me.ok()).toBe(true);
    await api.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// Sliding session expiry on genuine activity (v7.14.4)
// ═══════════════════════════════════════════════════════════════════════════
// Production bug: an admin actively adding challenges was signed out exactly
// 60 minutes after LOGIN. `express-session-better-sqlite3` implements no
// `touch()`, so express-session never slid the stored `cookie.expires` on an
// ordinary request, and `req.session.touch()` alone persists nothing (the
// `isModified()` hash excludes `cookie`). The only thing that could extend a
// session was the client's DOM-activity-gated keepalive poll — one client-side
// point of failure for staying signed in. server.js now slides expiry on
// authenticated state-changing /api requests.
//
// The two halves matter equally: real work MUST slide (nobody is logged out
// mid-action), and background GET polls MUST NOT (a parked tab still times
// out). A regression in either direction breaks a real property.
test.describe("Sliding session expiry (v7.14.4)", () => {
  // ── v7.15.6 (external audit, HIGH) — a purged session must stay purged ──────
  // v7.15.2 checked the tombstone at request ENTRY, but the purge that matters
  // lands WHILE a request is in flight, so that check has already passed. The
  // store's set() is an unconditional UPSERT, so express-session's save at
  // res.end re-created the row the purge had just deleted — and the resurrected
  // row still carried the pre-purge identity, so "single session per user" and
  // block/demote failed OPEN. The auditor reproduced a deleted admin session
  // going on to return HTTP 200 on an admin endpoint.
  //
  // The race is the whole point, so this drives it deterministically: a request
  // that has ALREADY loaded the session is held open while a second login purges
  // it, then allowed to finish and save. A sequential version would be vacuous —
  // express-session would find no row and simply mint a fresh session.
  test("a session purged MID-REQUEST is not resurrected when that request saves", async () => {
    const Database = require("better-sqlite3");
    const rowCount = (sid) => {
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try { return db.prepare("SELECT COUNT(*) c FROM express_session WHERE id=?").get(sid).c; } finally { db.close(); }
    };

    const victim = await apiLogin("superadmin");
    // Establish the row, and confirm this session really is admin-capable — so a
    // later 200 would be a genuine privilege resurrection, not a no-op.
    expect((await victim.api.get("/api/admin/participants?limit=1")).status()).toBe(200);

    // Hold a request open that has loaded the session and WILL save on finish.
    const inFlight = victim.api.post("/api/test/slow-session-write", {
      headers: H(victim.csrf), data: { delayMs: 2500 },
    });
    await new Promise(r => setTimeout(r, 400));   // let it reach the handler

    // Meanwhile: the same account logs in elsewhere → invalidateOtherSessions
    // deletes + tombstones the victim's row. This is the real production path.
    const other = await apiLogin("superadmin");

    const done = await inFlight.catch(() => null);
    const sid = done && done.ok() ? (await done.json()).sid : null;
    expect(sid, "the slow request reported its session id").toBeTruthy();
    expect(rowCount(sid), "the purge deleted the victim's row").toBe(0);

    // THE assertion: the in-flight request's save must not have brought it back.
    await expect.poll(() => rowCount(sid), { timeout: 4000, intervals: [50, 100, 200, 400, 800] })
      .toBe(0);
    // …and the purged session must no longer reach an admin endpoint.
    expect((await victim.api.get("/api/admin/participants?limit=1")).status(),
      "a purged admin session must not authenticate again").not.toBe(200);

    await victim.api.dispose();
    await other.api.dispose();
  });

  const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
  const expiryOf = async (api) => (await (await api.get("/api/session/status")).json()).expires_at;
  // The expiry has 1-second resolution in practice; sleep so a slide is visible.
  const tick = () => new Promise(r => setTimeout(r, 1100));

  // THE test that matters. Sliding the stored row is invisible to the browser:
  // express-session only emits a refreshed Set-Cookie when isModified() is true,
  // and that hash EXCLUDES `cookie` — so a pure touch() left the browser counting
  // down to its ORIGINAL Expires and the session died a hard ~60 min after login
  // regardless of activity. A cookie-jar client cannot catch that (jars ignore
  // Expires), which is precisely why the bug survived: assert the header itself.
  const setCookieExpiry = (resp) => {
    const raw = resp.headers()["set-cookie"] || "";
    const m = /connect\.sid=[^;]*;[^]*?expires=([^;]+)/i.exec(raw);
    return m ? new Date(m[1]).getTime() : null;
  };

  test("a slide re-stamps the BROWSER cookie (Set-Cookie Expires moves forward), not just the stored row", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    // Baseline: the login response's own cookie deadline.
    const loginProbe = await api.post("/api/session/keepalive", { headers: H(csrf) });
    const first = setCookieExpiry(loginProbe);
    expect(first, "the keepalive must emit a Set-Cookie carrying an Expires — pre-fix it emitted none").toBeTruthy();

    await tick();
    const second = setCookieExpiry(await api.post("/api/session/keepalive", { headers: H(csrf) }));
    expect(second, "a later keepalive still re-stamps the cookie").toBeTruthy();
    expect(second, "the browser's cookie deadline must move FORWARD, or the tab dies at the original one")
      .toBeGreaterThan(first);

    // The same must hold for ordinary work, not only the keepalive.
    await tick();
    const created = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: { name: `Cookie Slide ${Date.now()}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 },
    });
    expect(created.status()).toBe(200);
    const afterWork = setCookieExpiry(created);
    expect(afterWork, "a state-changing request re-stamps the browser cookie too").toBeTruthy();
    expect(afterWork).toBeGreaterThan(second);

    const compId = (await created.json()).competition.id;
    await api.delete(`/api/admin/competitions/${compId}`, { headers: H(csrf) }).catch(() => {});
    await api.dispose();
  });

  // The "I was only reading, not changing anything" case. Sliding on writes
  // alone would log out a user who just navigates — so read-only presence is
  // carried by the client keepalive, which the SPA fires every <=30s while it
  // has seen DOM activity (click / scroll / keypress / mousemove) in the last
  // 60s. Navigating the SPA is clicks, so it fires. This test pins that a
  // browse-only session keeps sliding forward indefinitely, which is what makes
  // the write-slide a BACKSTOP rather than the only mechanism.
  test("a browse-only session (GETs + keepalive, zero writes) keeps sliding forward", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const start = await expiryOf(api);
    let last = start;
    // Three rounds of "navigate around, change nothing".
    for (let round = 0; round < 3; round++) {
      await tick();
      for (const url of ["/api/admin/competitions", "/api/admin/tasks", "/api/me"]) await api.get(url);
      // …and the keepalive the SPA sends because the human is demonstrably here.
      const k = await api.post("/api/session/keepalive", { headers: H(csrf) });
      expect(k.status()).toBe(200);
      const now = (await k.json()).expires_at;
      expect(new Date(now).getTime(),
        `round ${round}: a reading user must not lose ground`).toBeGreaterThan(new Date(last).getTime());
      expect(setCookieExpiry(k), `round ${round}: the browser cookie is re-stamped too`).toBeTruthy();
      last = now;
    }
    expect(new Date(last).getTime(),
      "after browsing only, the deadline is well beyond where it started").toBeGreaterThan(new Date(start).getTime());
    await api.dispose();
  });

  test("a genuinely idle session does NOT slide — the inactivity timeout still bites", async () => {
    // The other direction, and the reason the write-slide is scoped to writes:
    // an open-but-abandoned tab keeps polling GETs. If those slid the session,
    // nobody would ever be signed out for inactivity.
    const { api } = await apiLogin("superadmin");
    const before = await expiryOf(api);
    await tick();
    // Exactly what a parked tab does: the monitor's own status probe + data polls.
    for (let i = 0; i < 3; i++) {
      await api.get("/api/session/status");
      await api.get("/api/admin/competitions");
    }
    expect(await expiryOf(api),
      "background polling alone must never extend a session").toBe(before);
    await api.dispose();
  });

  test("a background GET poll emits NO refreshed cookie (the idle deadline is not extended)", async () => {
    const { api } = await apiLogin("superadmin");
    for (const url of ["/api/session/status", "/api/admin/competitions", "/api/me"]) {
      const r = await api.get(url);
      expect(setCookieExpiry(r), `${url} must not re-stamp the session cookie`).toBeNull();
    }
    await api.dispose();
  });

  test("a state-changing request slides expiry; a background GET poll does NOT", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const afterLogin = await expiryOf(api);
    expect(afterLogin, "session status reports an expiry").toBeTruthy();

    // GET polls are what an idle-but-open tab issues. They must not slide, or
    // the inactivity timeout would never fire for anyone with the app open.
    await tick();
    for (const url of ["/api/admin/participants?limit=1", "/api/admin/competitions", "/api/session/status"]) {
      await api.get(url);
    }
    expect(await expiryOf(api), `GET polls must not slide expiry (${afterLogin})`).toBe(afterLogin);

    // A real write — the thing the reporting admin was doing — must slide.
    await tick();
    const created = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: { name: `Slide Probe ${Date.now()}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 },
    });
    expect(created.status(), "the write itself succeeded").toBe(200);
    const afterWrite = await expiryOf(api);
    expect(new Date(afterWrite).getTime(),
      "an authenticated write must push the session expiry forward").toBeGreaterThan(new Date(afterLogin).getTime());

    // Clean up the probe competition.
    const compId = (await created.json()).competition.id;
    await api.delete(`/api/admin/competitions/${compId}`, { headers: H(csrf) }).catch(() => {});
    await api.dispose();
  });

  test("the explicit keepalive still slides expiry (belt-and-braces path intact)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const before = await expiryOf(api);
    await tick();
    const k = await api.post("/api/session/keepalive", { headers: H(csrf) });
    expect(k.status()).toBe(200);
    const reported = (await k.json()).expires_at;
    expect(new Date(reported).getTime()).toBeGreaterThan(new Date(before).getTime());
    expect(await expiryOf(api), "the keepalive's new expiry is persisted").toBe(reported);
    await api.dispose();
  });

  test("sliding is skipped for endpoints that own their session lifecycle", async () => {
    // toggle-admin-view REGENERATES the session. Sliding underneath it would
    // write to the pre-regeneration id. Assert it still works end-to-end and
    // leaves a coherent session (the risk is a broken session, not a stale
    // expiry) — the guard exists so these endpoints are never touched.
    const { api } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const freshCsrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    const r = await api.post("/api/toggle-admin-view", { headers: H(freshCsrf), data: { mode: "participant" } });
    // alice is a participant, so this is a no-op toggle that still exercises
    // the regenerate path; any non-5xx is fine, a broken session is not.
    expect(r.status(), "the regenerating endpoint did not blow up").toBeLessThan(500);
    const after = await api.get("/api/session/status");
    expect(after.status()).toBe(200);
    expect((await after.json()).active, "session survives a regenerating endpoint").toBe(true);
    await api.dispose();
  });

  test("an UNAUTHENTICATED state-changing request does not slide a session", async () => {
    // v7.15.2 (audit) — this test used to POST /api/login and assert the row
    // count grew by "<= before + 1", i.e. it explicitly tolerated the one row it
    // claimed must not appear. It could not fail: /api/login is on
    // _SESSION_SLIDE_SKIP, so the slide never runs there whatever the auth gate
    // does, AND freshCtx() has already persisted a session row via
    // GET /api/csrf-token — so deleting `if (!req.session.userId) return false`
    // would have written slidAt into that EXISTING row, leaving the count
    // unchanged and the test green.
    //
    // Probe the gate directly instead: POST an endpoint that is anonymous-
    // reachable and NOT on the skip list, then assert no session lacking a
    // userId ever carries `slidAt`. That fails the moment the gate is removed.
    //
    // The probe endpoint must be registered AFTER the slide middleware or it
    // never reaches it — /api/csp-report is mounted ~850 lines earlier and so is
    // useless here (it made a first attempt at this test vacuous too).
    // /api/auth/linkedin/complete is anonymous, state-changing, mounted after the
    // middleware, and not skip-listed; its 400 is irrelevant, since the slide
    // runs before the handler.
    const Database = require("better-sqlite3");
    const anonSlidRows = () => {
      const db = new Database(TEST_DB_PATH, { readonly: true });
      try {
        // "Authenticated" is userId OR the built-in superadmin's builtinId — the
        // latter has no userId at all, so it must be excluded here or its
        // (legitimately) slid rows read as anonymous.
        return db.prepare(`SELECT COUNT(*) c FROM express_session
                           WHERE data LIKE '%slidAt%' AND data NOT LIKE '%userId%' AND data NOT LIKE '%builtinId%'`).get().c;
      } finally { db.close(); }
    };
    const { api, csrf } = await freshCtx();
    expect(anonSlidRows(), "precondition: no anonymous session is carrying slidAt").toBe(0);
    const r = await api.post("/api/auth/linkedin/complete", { headers: H(csrf), data: { nickname: "x" } });
    expect(r.status(), "probe is anonymous-reachable and not slide-skipped").toBeLessThan(500);
    expect(anonSlidRows(), "an anonymous POST must never slide a session").toBe(0);
    // The browser half: a slide also emits a refreshed Set-Cookie. There must be none.
    const setCookie = (await r.headersArray()).filter(h => h.name.toLowerCase() === "set-cookie");
    expect(setCookie.map(h => h.value).join(" "), "no refreshed session cookie for an anonymous write").not.toMatch(/Expires=/i);
    await api.dispose();
  });
});


test.describe("Challenge events analytics", () => {
  // Shared Bob-in-Live session across the test block. Bob is seeded but has
  // no submission / hint / nav-away activity — gives us a clean slate that
  // doesn't collide with Alice's seeded rows.
  async function bobInLive() {
    await ensureState();
    const { api, csrf } = await apiLogin("bob@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { competitionId: S.liveComp.id },
    });
    return { api, csrf };
  }

  function readChallengeEvents(userId, taskId) {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      return db.prepare(
        "SELECT event_type, details, occurred_at FROM challenge_events WHERE user_id=? AND task_id=? ORDER BY occurred_at"
      ).all(userId, taskId);
    } finally { db.close(); }
  }

  // v6.10.29: challenge_events inserts are deferred to `setImmediate`
  // after the submission transaction commits (v6.8.2). The test's
  // submit → read sequence races that tick: the submission row is
  // durable by the time api.dispose() returns, but the event row may
  // not yet be. Poll with a short cap so a slow scheduling tick
  // doesn't fail deterministically.
  async function awaitChallengeEvents(userId, taskId, expectedTypes, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    let rows;
    while (Date.now() < deadline) {
      rows = readChallengeEvents(userId, taskId);
      const types = new Set(rows.map(r => r.event_type));
      if (expectedTypes.every(t => types.has(t))) return rows;
      await new Promise(r => setTimeout(r, 40));
    }
    return rows;
  }

  test("submit writes incorrect then solved rows to challenge_events", async () => {
    await ensureState();
    const hard = S.liveTask("Challenge hard1");
    // v6.10.28: hermetic setup — wipe bob's prior submissions +
    // challenge_events for Challenge hard1 before running. Pre-fix
    // a retry (RETRIES=1 default) or a `--repeat-each` stress run
    // would land on the server's `is_correct=1 → 400 "Already
    // solved"` gate because the previous attempt's correct
    // submission stayed in the DB. Also clears old challenge_events
    // rows so the `rows.find(r => r.event_type === "solved")` lookup
    // lands on *this* run's solved row rather than a stale one with
    // pre-flip points.
    const Database = require("better-sqlite3");
    const dbW = new Database(TEST_DB_PATH);
    dbW.prepare("DELETE FROM submissions WHERE user_id=? AND task_id=?").run(S.bob.id, hard.id);
    dbW.prepare("DELETE FROM challenge_events WHERE user_id=? AND task_id=?").run(S.bob.id, hard.id);
    dbW.close();

    const { api, csrf } = await bobInLive();
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    // Wrong
    let r = await api.post(`/api/tasks/${hard.id}/submit`, { headers: h, data: { answer: "nope" , gradingHash: await gradingHashFor(api, hard.id)} });
    expect(r.ok(), `first (wrong) submit failed: ${r.status()} ${await r.text()}`).toBeTruthy();
    // Correct
    r = await api.post(`/api/tasks/${hard.id}/submit`, { headers: h, data: { answer: "answer-hard1" , gradingHash: await gradingHashFor(api, hard.id)} });
    expect(r.ok(), `second (correct) submit failed: ${r.status()} ${await r.text()}`).toBeTruthy();
    await api.dispose();

    const rows = await awaitChallengeEvents(S.bob.id, hard.id, ["incorrect", "solved"]);
    const types = rows.map(r => r.event_type);
    expect(types).toContain("incorrect");
    expect(types).toContain("solved");
    const solved = rows.find(r => r.event_type === "solved");
    const details = JSON.parse(solved.details);
    expect(details.points_delta).toBe(150);
    expect(details.answer_length).toBe("answer-hard1".length);
    expect(details.attempt_number).toBeGreaterThanOrEqual(1);
  });

  test("hint reveal writes hint_revealed row", async () => {
    const { api, csrf } = await bobInLive();
    const h = { "x-csrf-token": csrf };
    const med = S.liveTask("Challenge med1");
    const r = await api.post(`/api/tasks/${med.id}/hint`, { headers: h });
    expect(r.ok()).toBeTruthy();
    await api.dispose();

    // v6.10.29: poll for the deferred event row (see awaitChallengeEvents
    // comment for the v6.8.2 setImmediate-deferral race).
    const rows = await awaitChallengeEvents(S.bob.id, med.id, ["hint_revealed"]);
    const hint = rows.find(r => r.event_type === "hint_revealed");
    expect(hint).toBeTruthy();
    const details = JSON.parse(hint.details);
    // medium difficulty -> 30 points deducted (100 * 0.3)
    expect(details.points_deducted).toBe(30);
  });

  test("navigated-away endpoint writes one row + dedupes within 2s", async () => {
    const { api, csrf } = await bobInLive();
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const easy = S.liveTask("Challenge easy1");
    const before = readChallengeEvents(S.bob.id, easy.id).filter(r => r.event_type === "navigated_away").length;
    let r = await api.post(`/api/tasks/${easy.id}/navigated-away`, { headers: h, data: { via: "spa_nav" } });
    expect(r.ok()).toBeTruthy();
    const first = await r.json();
    expect(first.ok).toBe(true);
    expect(first.deduped).toBeFalsy();
    // Second immediate post → dedupe
    r = await api.post(`/api/tasks/${easy.id}/navigated-away`, { headers: h, data: { via: "pagehide" } });
    expect(r.ok()).toBeTruthy();
    const second = await r.json();
    expect(second.deduped).toBe(true);
    await api.dispose();

    // v6.10.29: poll for the post-increment count (deferred insert).
    const deadline = Date.now() + 2000;
    let navAways = [];
    while (Date.now() < deadline) {
      navAways = readChallengeEvents(S.bob.id, easy.id).filter(r => r.event_type === "navigated_away");
      if (navAways.length >= before + 1) break;
      await new Promise(r => setTimeout(r, 40));
    }
    expect(navAways.length).toBe(before + 1);
    const via = JSON.parse(navAways[navAways.length - 1].details).via;
    expect(via).toBe("spa_nav");
  });

  test("navigated-away returns 403 for non-member of competition", async () => {
    await ensureState();
    // Carol is seeded but not assigned to Test Upcoming — use that to get a
    // missing-competition scenario. Carol is in Test Live, so we request for a
    // task that isn't in her current competition.
    const { api, csrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { competitionId: S.liveComp.id },
    });
    // draft1 isn't assigned to Test Live → 404, not 403. Use a task in upcoming.
    const easy2 = S.tasks.find(t => t.title === "Challenge easy2" && !t.owner_competition_id);
    const r = await api.post(`/api/tasks/${easy2.id}/navigated-away`, {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { via: "spa_nav" },
    });
    // easy2 is only in upcoming — not in Carol's current Live competition.
    expect(r.status()).toBe(404);
    await api.dispose();
  });
});


// v6.10.51: stable pagination tiebreakers — auditor flagged that the
// unscoped /api/admin/participants and the four event-list endpoints
// were paginating with ORDER BY <timestamp> and no secondary sort, so
// any rows sharing the timestamp (millisecond resolution) could swap
// page boundaries between two reads — silently duplicating or skipping
// rows on multi-page admin fetches. Both queries now carry an `id`
// tiebreaker. These tests reproduce the same-timestamp condition via
// direct DB writes and assert ordering is deterministic + paged reads
// don't double-count or miss.
test.describe("v6.10.51: stable pagination tiebreakers", () => {
  function dbWrite() {
    const Database = require("better-sqlite3");
    return new Database(TEST_DB_PATH);
  }

  test("admin/participants paginated reads are stable when users share created_at", async () => {
    await ensureState();
    const sharedTs = "2026-04-01T01:23:45.000Z";
    const u1Id = "tiebreak-user-1-" + Date.now();
    const u2Id = "tiebreak-user-2-" + Date.now();
    // Direct insert with identical created_at + assignment to a comp.
    const db = dbWrite();
    try {
      const insertUser = db.prepare(
        "INSERT INTO users (id, first_name, last_name, nickname, email, password_hash, verified, approved, created_at, role) VALUES (?,?,?,?,?,?,1,1,?,?)"
      );
      insertUser.run(u1Id, "Tie", "User1", "tie-user-1-" + Date.now(), `tie-1-${Date.now()}@acme.com`, "x", sharedTs, "participant");
      insertUser.run(u2Id, "Tie", "User2", "tie-user-2-" + Date.now(), `tie-2-${Date.now()}@acme.com`, "x", sharedTs, "participant");
      const insertCu = db.prepare(
        "INSERT OR IGNORE INTO competition_users (competition_id, user_id, assigned_by, assigned_at) VALUES (?,?,?,?)"
      );
      insertCu.run(S.liveComp.id, u1Id, "test", sharedTs);
      insertCu.run(S.liveComp.id, u2Id, "test", sharedTs);
    } finally { db.close(); }

    const { api } = await apiLogin("superadmin");
    try {
      // Fetch the FULL list multiple times — both tied users must appear,
      // and their relative order must be the same on every read. The
      // `, id` tiebreaker (ascending) means the lexicographically-smaller
      // id is always first.
      const seen = [];
      for (let i = 0; i < 3; i++) {
        const r = await api.get(`/api/admin/participants?competitionId=${S.liveComp.id}&limit=200`);
        expect(r.ok()).toBeTruthy();
        const ids = (await r.json()).participants.map(p => p.id).filter(id => id === u1Id || id === u2Id);
        seen.push(ids.join(","));
      }
      expect(seen[0]).toBe(seen[1]);
      expect(seen[1]).toBe(seen[2]);
      expect(seen[0]).toContain(u1Id);
      expect(seen[0]).toContain(u2Id);
      // Order should match `id` ASC (sqlite collation defaults to BINARY).
      const expectedOrder = [u1Id, u2Id].sort().join(",");
      expect(seen[0]).toBe(expectedOrder);

      // Page through with limit=1 — both users must surface, no overlap.
      // (Wait long enough for the v6.10.47 admin_participants 5-s cache
      // to flush so each page sees the post-insert state.)
      // Bust the cache by adding/removing a tag on a different user.
      const targetTag = await api.post(`/api/admin/participants/${S.alice.id}/tags`, {
        headers: { "x-csrf-token": (await (await api.get("/api/csrf-token")).json()).csrfToken, "content-type": "application/json" },
        data: { tag: "cache-bust-" + Date.now() },
      });
      expect(targetTag.ok()).toBeTruthy();
    } finally {
      await api.dispose();
      // Cleanup: drop the test users so they don't leak into later tests.
      const db2 = dbWrite();
      try {
        db2.prepare("DELETE FROM competition_users WHERE user_id IN (?,?)").run(u1Id, u2Id);
        db2.prepare("DELETE FROM users WHERE id IN (?,?)").run(u1Id, u2Id);
      } finally { db2.close(); }
    }
  });

  test("competition events paginated reads are stable when events share changed_at", async () => {
    await ensureState();
    const sharedTs = "2026-04-01T02:34:56.000Z";
    const e1Id = "tie-evt-1-" + Date.now();
    const e2Id = "tie-evt-2-" + Date.now();
    const db = dbWrite();
    try {
      // Wipe any pre-existing tie-event rows from prior runs to keep the
      // assertion focused on the two we control.
      db.prepare("DELETE FROM competition_events WHERE id LIKE 'tie-evt-%'").run();
      const insert = db.prepare(
        "INSERT INTO competition_events (id, competition_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)"
      );
      insert.run(e1Id, S.liveComp.id, "test_tie_event", "test", sharedTs, '{"slot":1}');
      insert.run(e2Id, S.liveComp.id, "test_tie_event", "test", sharedTs, '{"slot":2}');
    } finally { db.close(); }

    const { api } = await apiLogin("superadmin");
    try {
      // Wait briefly for the v6.10.50 events cache to expire (5 s TTL,
      // and the writes above bypassed `recordCompetitionEvent`'s
      // invalidation hook).
      await new Promise(r => setTimeout(r, 5100));
      const seen = [];
      for (let i = 0; i < 3; i++) {
        const r = await api.get(`/api/admin/competitions/${S.liveComp.id}/events?limit=500&offset=0`);
        expect(r.ok()).toBeTruthy();
        const events = (await r.json()).events;
        const ids = events.filter(e => e.event_type === "test_tie_event").map(e => e.id);
        seen.push(ids.join(","));
        // Bust the cache between iterations by appending a benign tag op.
        const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
        await api.post(`/api/admin/participants/${S.alice.id}/tags`, {
          headers: { "x-csrf-token": csrf, "content-type": "application/json" },
          data: { tag: "evt-tie-" + i + "-" + Date.now() },
        });
      }
      expect(seen[0]).toBe(seen[1]);
      expect(seen[1]).toBe(seen[2]);
      expect(seen[0]).toContain(e1Id);
      expect(seen[0]).toContain(e2Id);
      // ORDER BY changed_at DESC, id DESC — the lexicographically larger
      // id comes first for the same timestamp.
      const expectedOrder = [e1Id, e2Id].sort().reverse().join(",");
      expect(seen[0]).toBe(expectedOrder);
    } finally {
      await api.dispose();
      const db2 = dbWrite();
      try { db2.prepare("DELETE FROM competition_events WHERE id IN (?,?)").run(e1Id, e2Id); }
      finally { db2.close(); }
    }
  });

  test("perf scenario doesn't import textSummary from a remote URL", () => {
    const fs = require("fs");
    const body = fs.readFileSync("perf/k6/scenarios/competition-live.js", "utf8");
    // The v6.10.50 jslib.k6.io import was a release-ops risk on
    // air-gapped hosts. v6.10.51 vendors textSummary into ../lib/.
    // Match only `import` statements (not docstring comments) so the
    // explanation comment can keep its historical reference.
    expect(body).not.toMatch(/^import\b[^\n]*jslib\.k6\.io/m);
    expect(body).toMatch(/from "\.\.\/lib\/text-summary\.js"/);
  });

  test("maintenance HTML response sends Cache-Control: no-store", async () => {
    // Auditor finding #3: the maintenance middleware sits in front of
    // the asset pipeline, so a request for a long-cache versioned URL
    // (`/styles.css?v=abc123`) returns the maintenance HTML body with
    // a 503 status. Without explicit `Cache-Control: no-store`,
    // browsers/intermediaries can heuristically cache the 503 body
    // under that exact URL — making recovery from maintenance sticky
    // until cache TTL elapses or the user does a hard reload.
    const fs = require("fs");
    const path = require("path");
    const maintFile = path.join(TEST_DATA_DIR, ".maintenance");
    fs.writeFileSync(maintFile, "probe-token-v6.10.51");
    try {
      // Both branches: HTML for non-API requests, JSON for /api/* and
      // Accept: application/json. Both should carry no-store.
      const { api } = await freshCtx();
      try {
        const htmlR = await api.get("/styles.css?v=fakehash");
        expect(htmlR.status()).toBe(503);
        expect(htmlR.headers()["cache-control"]).toMatch(/no-store/);
        const jsonR = await api.get("/api/config");
        expect(jsonR.status()).toBe(503);
        expect(jsonR.headers()["cache-control"]).toMatch(/no-store/);
      } finally { await api.dispose(); }
    } finally {
      try { fs.unlinkSync(maintFile); } catch (_) {}
    }
  });
});


test.describe("Superadmin rotation cooldown (v6.3.2)", () => {
  test("post-rotation the triggering IP is blocked from superadmin login — further 10-attempt bursts do NOT re-rotate during the cooldown", async () => {
    // Regression: pre-fix, a single IP could rotate the superadmin
    // password every ~10 seconds (10 bad attempts over the 60/min rate
    // limit). The v6.3.2 fix adds (a) a global cooldown that suppresses
    // further rotations for 10 min and (b) an IP-block that rejects the
    // triggering IP's subsequent superadmin login attempts for the same
    // window without incrementing the counter.
    //
    // Assertion strategy: sample the rotation count in the app log
    // BEFORE our burst, fire 10 + 15 bad attempts, then sample AFTER.
    // The delta must be exactly 1 regardless of other rotations this
    // worker's server logged during earlier tests.
    await ensureState();
    const { freshCtx } = require("./helpers");
    const { api: saApi0 } = await apiLogin("superadmin");
    const today = new Date().toISOString().slice(0, 10);
    const countRotations = async (apiCtx) => {
      const r = await (await apiCtx.get(`/api/admin/logs?stream=app&date=${today}&limit=500&q=rotated`)).json();
      return (r.entries || []).filter(e =>
        e.source === "audit" && e.scope === "settings"
        && e.scope_id === "superadmin_password" && e.event_type === "rotated").length;
    };
    const before = await countRotations(saApi0);
    await saApi0.dispose();

    // Burst 1: 10 bad attempts triggers the one allowed rotation.
    const { api, csrf } = await freshCtx();
    for (let i = 0; i < 10; i++) {
      await api.post("/api/login", {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { email: "superadmin", password: `definitely-wrong-${i}` },
      });
    }
    // Burst 2: 15 further bad attempts from the same IP. With the fix,
    // every one of these is short-circuited by the IP-block so neither
    // the counter nor the rotation fires again. Without the fix, the
    // counter would cross threshold again on attempt 25 (absolute) and
    // re-rotate — a second audit row.
    for (let i = 0; i < 15; i++) {
      const r = await api.post("/api/login", {
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        data: { email: "superadmin", password: `still-wrong-${i}` },
      });
      expect(r.status()).toBe(401);
    }
    await api.dispose();

    const { api: saApi1 } = await apiLogin("superadmin");
    const after = await countRotations(saApi1);
    await saApi1.dispose();

    expect(after - before, `expected exactly one new rotation during the 25-attempt burst; got ${after - before}`).toBe(1);
  });
});


test.describe("Invitation response buckets (v6.3.2)", () => {
  test("inviting an existing user to a competition they're ALREADY in returns alreadyAssigned, not silent no-op", async () => {
    // Regression: pre-fix this case left the UI stuck on the generic
    // "No new invitations sent — all addresses were already invited or
    // invalid" toast, because the server response carried neither an
    // `assigned++` increment nor an entry in any returned bucket.
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    // Alice is already assigned to the live comp via the seed data.
    const r = await api.post("/api/admin/invitations", {
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      data: { emails: ["alice@acme.com"], competitionIds: [S.liveComp.id] },
    });
    expect(r.ok()).toBe(true);
    const d = await r.json();
    expect(d.invited).toBe(0);
    expect(d.assigned).toBe(0);
    expect(Array.isArray(d.alreadyAssigned)).toBe(true);
    expect(d.alreadyAssigned).toContain("alice@acme.com");
    // Not mis-classified — she's already a user AND already a member, so
    // neither the "existing without assignment" bucket nor the "new
    // invitation" bucket should claim her.
    expect(d.existingEmails).not.toContain("alice@acme.com");
    expect(d.alreadyInvited).not.toContain("alice@acme.com");
    await api.dispose();
  });
});


test.describe("Admin submissions — server-side pagination + search (v6.3.3)", () => {
  test("offset paging reaches rows older than the first-page window", async () => {
    await ensureState();
    const { api: sa } = await apiLogin("superadmin");
    // Default (limit=100, offset=0) → up to 100 events, total matches COUNT.
    const p0 = await (await sa.get("/api/admin/submissions")).json();
    expect(p0.limit).toBe(100);
    expect(p0.offset).toBe(0);
    expect(Array.isArray(p0.events)).toBe(true);

    // Page 2 with a small page — total is constant, offset/limit honoured.
    const p1 = await (await sa.get("/api/admin/submissions?limit=2&offset=0")).json();
    const p2 = await (await sa.get("/api/admin/submissions?limit=2&offset=2")).json();
    expect(p1.total).toBe(p2.total);
    expect(p1.limit).toBe(2);
    expect(p2.offset).toBe(2);
    // Pages don't overlap.
    const p1Times = new Set(p1.events.map(e => e.event_time));
    for (const e of p2.events) expect(p1Times.has(e.event_time)).toBe(false);
    await sa.dispose();
  });

  test("?q=<substr> filters submissions+hints and pagination respects the filtered total", async () => {
    await ensureState();
    const { api: sa } = await apiLogin("superadmin");
    // Alice's seed submission was "answer-easy1" (correct). Search for
    // "alice_s" — should match her nickname on that row.
    const r = await (await sa.get("/api/admin/submissions?q=alice_s")).json();
    expect(r.total).toBeGreaterThan(0);
    for (const e of r.events) {
      const hay = [e.nickname, e.task_title, e.answer, e.competition_name, e.timeslot_name, e.event_type]
        .map(v => (v || "").toLowerCase()).join(" ");
      expect(hay).toContain("alice_s");
    }
    // Bogus search → 0 matches but response shape intact.
    const r2 = await (await sa.get("/api/admin/submissions?q=___definitely-not-a-match-___")).json();
    expect(r2.total).toBe(0);
    expect(r2.events).toEqual([]);
    await sa.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// LEADERBOARD RANKING INVARIANT (v7.8.1)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Leaderboard ranking invariant (v7.8.1)", () => {
  // Locks the fix for the "lower-scoring finisher outranks a higher-scoring
  // non-finisher" bug. One scenario engineers three participants in a single
  // live comp with two easy tasks (50 pts each):
  //   • bob   — solves ONLY task A            → score 50, NOT all-solved
  //   • carol — solves A+B, 10 wrong on B     → score 50, all-solved (TIE with bob)
  //   • alice — solves A+B, 12 wrong on B     → score 40, all-solved (LOWEST score)
  // Expected ranks (score DESC primary, then time-to-solve ASC): carol #1, bob #2,
  // alice #3 — proving (1) raw score is primary [alice is LAST despite all-solved],
  // (2) all-solved is NOT an independent factor, and (3) a score tie is broken by
  // time-to-solve [carol, a finisher with a frozen small solveTimeMs, beats bob,
  // whose unfinished live solveTimeMs keeps growing]. Pre-v7.8.1 an `allSolved`
  // primary key ranked alice + carol above bob regardless of score.
  test("raw score is PRIMARY; time-to-solve only breaks ties; all-solved is NOT a rank factor", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const t = Date.now();

    // Use FRESH, dedicated participants — never the shared seeded alice/bob/carol.
    // The leaderboard's participation filter (ACTIVE_PARTICIPANT_SQL) requires
    // approved=1 AND verified=1, and other tests in this file mutate the seeded
    // accounts' verified/approved/blocked/staff state (that state accumulates in
    // the per-worker DB), which would flakily filter one of them off the board.
    // Fresh accounts guarantee a clean approved+verified, non-staff precondition.
    const mkParticipant = async (email, nick) => {
      await registerPost(sa, "/api/register", { headers: saH, data: {
        firstName: "R", lastName: "Ank", nickname: nick, email,
        company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "New York",
      }});
      const all = await (await sa.get("/api/admin/participants?limit=1000")).json();
      const u = (all.participants || []).find(p => p.email === email);
      if (!u) throw new Error(`could not register ${email}`);
      await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: saH });
      return { id: u.id, email };
    };
    const hi  = await mkParticipant(`rank-hi-${t}@acme.com`,  `rank_hi_${t}`);  // partial, HIGH score, not all-solved
    const tie = await mkParticipant(`rank-tie-${t}@acme.com`, `rank_tie_${t}`); // all-solved, TIES hi on score
    const lo  = await mkParticipant(`rank-lo-${t}@acme.com`,  `rank_lo_${t}`);  // all-solved, LOWEST score

    // Live single-slot comp (started 1 min ago, 4h long so it never auto-times-out here).
    const compR = await sa.post("/api/admin/competitions", {
      headers: saH,
      data: { name: `RankInv-${t}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 240 },
    });
    const compId = (await compR.json()).competition.id;
    const mkTask = async (title, ans) => {
      const r = await sa.post("/api/admin/tasks", {
        headers: saH,
        data: { title, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: ans, explanation: "—", status: "published" },
      });
      return (await r.json()).id;
    };
    const taskA = await mkTask(`RankInvA-${t}`, "aaa");
    const taskB = await mkTask(`RankInvB-${t}`, "bbb");
    await sa.post(`/api/admin/tasks/${taskA}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    await sa.post(`/api/admin/tasks/${taskB}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    const assignR = await sa.post("/api/admin/competitions/assign", {
      headers: saH, data: { userIds: [hi.id, tie.id, lo.id], competitionIds: [compId] },
    });
    expect(assignR.ok(), "assign of the 3 fresh participants must succeed").toBeTruthy();
    await sa.dispose();

    try {
      const session = async (email) => {
        const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
        const H = { "x-csrf-token": csrf, "content-type": "application/json" };
        const selR = await api.post("/api/select-competition", { headers: H, data: { competitionId: compId } });
        expect(selR.ok(), `select-competition failed for ${email}: ${selR.status()} ${await selR.text()}`).toBeTruthy();
        return { api, H };
      };
      const solve = async (s, taskId, ans) => s.api.post(`/api/tasks/${taskId}/submit`, { headers: s.H, data: { answer: ans, gradingHash: await gradingHashFor(s.api, taskId) } });
      const wrongN = async (s, taskId, n) => { for (let i = 0; i < n; i++) { const r = await solve(s, taskId, `nope-${i}`); expect(r.ok(), `wrong submit ${i} failed`).toBeTruthy(); } };

      // HI first (earliest login → his live-growing solveTimeMs is unambiguously
      // larger than a finisher's frozen finish−login on the tie). Partial + HIGH score.
      const hiS = await session(hi.email);
      expect((await solve(hiS, taskA, "aaa")).ok()).toBeTruthy();  // +50 → score 50, not all-solved
      await hiS.api.dispose();

      // TIE — all-solved, score 50: solve A, 10 wrong on B (−50), solve B.
      const tieS = await session(tie.email);
      expect((await solve(tieS, taskA, "aaa")).ok()).toBeTruthy();
      await wrongN(tieS, taskB, 10);
      expect((await solve(tieS, taskB, "bbb")).ok()).toBeTruthy(); // 50+50−50 = 50, all-solved
      await tieS.api.dispose();

      // LO — all-solved, LOWEST score 40: solve A, 12 wrong on B (−60), solve B.
      const loS = await session(lo.email);
      expect((await solve(loS, taskA, "aaa")).ok()).toBeTruthy();
      await wrongN(loS, taskB, 12);
      expect((await solve(loS, taskB, "bbb")).ok()).toBeTruthy(); // 50+50−60 = 40, all-solved
      await loS.api.dispose();

      // Read the uncapped admin leaderboard (single fetch; submit already busted the cache).
      const { api: sa2 } = await apiLogin("superadmin");
      const board = await (await sa2.get(`/api/admin/leaderboard?competitionId=${compId}`)).json();
      await sa2.dispose();
      const row = (id) => board.find(u => u.userId === id);
      const hiRow = row(hi.id), tieRow = row(tie.id), loRow = row(lo.id);
      expect(hiRow && tieRow && loRow, "all three participants present on the board").toBeTruthy();

      // Scores are exactly as engineered (self-validates the wrong-answer accounting).
      expect(hiRow.score).toBe(50);
      expect(tieRow.score).toBe(50);
      expect(loRow.score).toBe(40);
      expect(hiRow.allSolved).toBe(false);
      expect(tieRow.allSolved).toBe(true);
      expect(loRow.allSolved).toBe(true);

      // INVARIANT 1 + 3 — raw score is PRIMARY; all-solved is NOT a factor:
      // lo (all-solved, 40) ranks BELOW hi (not-all-solved, 50). This is the bug.
      expect(loRow.rank, "lower-scoring finisher must rank BELOW a higher-scoring non-finisher").toBeGreaterThan(hiRow.rank);
      expect(loRow.rank).toBeGreaterThan(tieRow.rank);

      // INVARIANT 2 — score tie broken by time-to-solve (lower = better):
      // tie (finished, frozen small solveTimeMs) beats hi (unfinished, growing).
      expect(tieRow.solveTimeMs).toBeLessThan(hiRow.solveTimeMs);
      expect(tieRow.rank, "on a score tie the faster/finished participant ranks first").toBeLessThan(hiRow.rank);

      // Concrete final order.
      expect(tieRow.rank).toBe(1);
      expect(hiRow.rank).toBe(2);
      expect(loRow.rank).toBe(3);
    } finally {
      // Best-effort teardown. End the comp first so a failed delete (live comps
      // with submissions can't be deleted) still leaves it ENDED — not surfacing
      // as a joinable/live comp in later tests.
      const { api: cl, csrf: clCsrf } = await apiLogin("superadmin");
      const cH = { "x-csrf-token": clCsrf, "content-type": "application/json" };
      await cl.post(`/api/admin/competitions/${compId}/end-now`, { headers: cH }).catch(() => {});
      await cl.delete(`/api/admin/competitions/${compId}`, { headers: cH }).catch(() => {});
      await cl.delete(`/api/admin/tasks/${taskA}`, { headers: cH }).catch(() => {});
      await cl.delete(`/api/admin/tasks/${taskB}`, { headers: cH }).catch(() => {});
      await cl.dispose();
    }
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// GROUP-LEVEL LEADERBOARD (v7.11.0)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Group-level leaderboard (v7.11.0)", () => {
  const GH = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
  // Fresh verified+approved participant (own account, isolated from the shared
  // seed pool), optionally carrying a user-tag. Returns { id, email, nick }.
  async function mkP(sa, saCsrf, nick, tag) {
    const email = `glb_${nick}@acme.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: GH(ac), data: {
      firstName: "G", lastName: "P", nickname: nick, email, company: "Acme", title: "Eng",
      country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC",
    }});
    await anon.dispose();
    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: GH(saCsrf) });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: GH(saCsrf) });
    if (tag) await sa.post(`/api/admin/participants/${u.id}/tags`, { headers: GH(saCsrf), data: { tag } });
    return { id: u.id, email, nick };
  }
  const wrongs = (tid, n) => Array.from({ length: n }, (_, i) => [tid, `no${i}`]);

  test("group averages + solo individuals + dual membership + staff/benchmark exclusion + ranking (reqs 1-6)", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = GH(saCsrf);
    const t = Date.now();
    const compId = (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: `GLB ${t}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 240, group_leaderboard_enabled: true } })).json()).competition.id;
    const mkTask = async (title, ans) => (await (await sa.post("/api/admin/tasks", { headers: saH, data: { title, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: ans, status: "published" } })).json()).id;
    const t1 = await mkTask(`GLB-A ${t}`, "a");
    const t2 = await mkTask(`GLB-B ${t}`, "b");
    for (const tid of [t1, t2]) await sa.post(`/api/admin/tasks/${tid}/competitions`, { headers: saH, data: { competitionIds: [compId] } });

    const alice = await mkP(sa, saCsrf, `a${t}`);
    const bob = await mkP(sa, saCsrf, `b${t}`);
    const carol = await mkP(sa, saCsrf, `c${t}`);
    const dave = await mkP(sa, saCsrf, `d${t}`);
    const eve = await mkP(sa, saCsrf, `e${t}`, "benchmark"); // excluded (req 5)

    const alpha = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `Alpha ${t}`, userIds: [alice.id, bob.id] } })).json()).group.id;
    const beta = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `Beta ${t}`, userIds: [carol.id] } })).json()).group.id;
    // Bind the two groups; then DIRECT-assign alice (→ dual, req 6), dave (→ solo, req 4), eve (benchmark).
    expect((await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [alpha, beta], competitionIds: [compId] } })).ok()).toBeTruthy();
    expect((await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [alice.id, dave.id, eve.id], competitionIds: [compId] } })).ok()).toBeTruthy();
    await sa.dispose();

    const play = async (email, seq) => {
      const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
      const h = GH(csrf);
      expect((await api.post("/api/select-competition", { headers: h, data: { competitionId: compId } })).ok()).toBeTruthy();
      for (const [tid, ans] of seq) expect((await api.post(`/api/tasks/${tid}/submit`, { headers: h, data: { answer: ans , gradingHash: await gradingHashFor(api, tid)} })).ok()).toBeTruthy();
      await api.dispose();
    };
    await play(alice.email, [[t1, "a"], [t2, "b"]]);                    // 100
    await play(bob.email, [[t1, "a"], ...wrongs(t2, 4), [t2, "b"]]);    // 50 + (50-20) = 80  → Alpha avg (100+80)/2 = 90
    await play(carol.email, [[t1, "a"]]);                              // 50               → Beta avg 50
    await play(dave.email, [[t1, "a"], ...wrongs(t2, 6), [t2, "b"]]);   // 50 + (50-30) = 70 (solo)
    await play(eve.email, [[t1, "a"], [t2, "b"]]);                     // 100 but benchmark → excluded

    const { api: sa2 } = await apiLogin("superadmin");
    const gboard = await (await sa2.get(`/api/admin/leaderboard?competitionId=${compId}&groups=1`)).json();
    await sa2.dispose();
    const groupEntry = (name) => gboard.find(e => e.type === "group" && e.name.startsWith(name));
    const soloEntry = (id) => gboard.find(e => e.type === "individual" && e.userId === id);

    expect(groupEntry("Alpha").score).toBe(90);          // req 2 — mean(100,80)
    expect(groupEntry("Alpha").memberCount).toBe(2);
    expect(groupEntry("Beta").score).toBe(50);
    expect(soloEntry(dave.id).score).toBe(70);           // req 4 — solo (not in any group)
    expect(soloEntry(alice.id).score).toBe(100);         // req 6 — dual (direct + in Alpha) appears solo too
    expect(soloEntry(bob.id), "group-only member must NOT appear solo").toBeFalsy();     // req 1
    expect(soloEntry(carol.id), "group-only member must NOT appear solo").toBeFalsy();   // req 1
    expect(soloEntry(eve.id), "benchmark participant is excluded entirely").toBeFalsy(); // req 5
    expect(gboard.some(e => e.type === "group" && e.name.startsWith("Beta") && e.memberCount === 1)).toBe(true);
    // req 3 — ranking by average score DESC: alice(100) > Alpha(90) > dave(70) > Beta(50).
    expect(soloEntry(alice.id).rank).toBe(1);
    expect(groupEntry("Alpha").rank).toBe(2);
    expect(soloEntry(dave.id).rank).toBe(3);
    expect(groupEntry("Beta").rank).toBe(4);

    const { api: cl, csrf: clc } = await apiLogin("superadmin");
    await cl.post(`/api/admin/competitions/${compId}/end-now`, { headers: GH(clc) }).catch(() => {});
    await cl.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": clc } }).catch(() => {});
    await cl.dispose();
  });

  // v7.15.2 (audit) — the v7.12.3 lock below only exercises the competition-PUT
  // (duration-extend) revive. The bulk participant-assign path ALSO revives an
  // auto-ended comp, and it was busting the competition + leaderboard caches
  // while never dropping the frozen group snapshot: revive → compete → re-end
  // then served the PRE-revive team averages forever, so the newly assigned
  // cohort never appeared on Team Rankings.

  // ext-audit v7.15.6 (MEDIUM) — "Final team standings can change after
  // competition end." The snapshot used to be written lazily on the first
  // post-end READ, so everything between the end and that read was still live.
  // The auditor ended a competition, removed a member BEFORE anyone opened the
  // board, and moved a team from 22.5 pts / rank 2 to 45 pts / rank 1 — then
  // that wrong figure froze permanently. The window is worst in exactly the case
  // this feature exists for: a comp that ends overnight and is never opened.
  // Every end transition now freezes eagerly.
  test("ext-audit: the team board is frozen AT the end, so a membership edit before the first read cannot rewrite it", async () => {
    const Database = require("better-sqlite3");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = GH(saCsrf);
    const t = Date.now();
    const compId = (await (await sa.post("/api/admin/competitions", { headers: saH, data: {
      name: `EAGER ${t}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 240,
      group_leaderboard_enabled: true,
      clock_start: "entry",   // members join the board by entering it
    } })).json()).competition.id;
    const mkTask = async (title, ans) => (await (await sa.post("/api/admin/tasks", { headers: saH, data: {
      title, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: ans, status: "published",
    } })).json()).id;
    const t1 = await mkTask(`EAGER-A ${t}`, "a");
    await sa.post(`/api/admin/tasks/${t1}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    const p1 = await mkP(sa, saCsrf, `ea${t}`), p2 = await mkP(sa, saCsrf, `eb${t}`);
    const p3 = await mkP(sa, saCsrf, `ec${t}`), p4 = await mkP(sa, saCsrf, `ed${t}`);
    const gA = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `EAlpha ${t}`, userIds: [p1.id, p2.id] } })).json()).group.id;
    const gB = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `EBeta ${t}`, userIds: [p3.id, p4.id] } })).json()).group.id;
    expect((await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [gA, gB], competitionIds: [compId] } })).ok()).toBeTruthy();
    await sa.dispose();

    // Only p1 scores, so Alpha's average is dragged down by p2's zero — the
    // auditor's shape: removing p2 post-end would double Alpha's average.
    const play = async (email, solve) => {
      const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
      const h = GH(csrf);
      expect((await api.post("/api/select-competition", { headers: h, data: { competitionId: compId } })).ok()).toBeTruthy();
      if (solve) expect((await api.post(`/api/tasks/${t1}/submit`, { headers: h, data: { answer: "a" , gradingHash: await gradingHashFor(api, t1)} })).ok()).toBeTruthy();
      await api.dispose();
    };
    await play(p1.email, true);   // 50
    await play(p2.email, false);  // 0  → Alpha avg 25
    await play(p3.email, false);
    await play(p4.email, false);  // Beta avg 0

    const snapCount = () => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare("SELECT COUNT(*) c FROM group_leaderboard_snapshots WHERE competition_id=?").get(compId).c; } finally { db.close(); } };
    const alphaScore = async () => {
      const { api } = await apiLogin("superadmin");
      const board = await (await api.get(`/api/admin/leaderboard?competitionId=${compId}&groups=1`)).json();
      await api.dispose();
      const e = (board || []).find(x => x.type === "group" && String(x.name).startsWith("EAlpha"));
      return e ? e.score : null;
    };

    expect(await alphaScore(), "live: Alpha averages 50 and 0").toBe(25);

    // End the competition — and DO NOT read the board afterwards.
    const { api: e1, csrf: e1c } = await apiLogin("superadmin");
    expect((await e1.post(`/api/admin/competitions/${compId}/end-now`, { headers: GH(e1c) })).ok()).toBeTruthy();
    await e1.dispose();
    // THE fix: the snapshot exists already, written by the end itself.
    expect(snapCount(), "the end transition froze the board — no read required").toBeGreaterThan(0);

    // Now do exactly what the auditor did: remove the zero-scoring member
    // before anyone has opened Rankings.
    const { api: m1, csrf: m1c } = await apiLogin("superadmin");
    expect((await m1.delete(`/api/admin/groups/${gA}/members/${p2.id}`, { headers: { "x-csrf-token": m1c } })).ok()).toBeTruthy();
    await m1.dispose();

    // Pre-fix this first read computed Alpha = avg({50}) = 50 and froze THAT.
    expect(await alphaScore(), "the finished standings must be unchanged by the post-end edit").toBe(25);

    const { api: cl, csrf: clc } = await apiLogin("superadmin");
    await cl.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": clc } }).catch(() => {});
    await cl.dispose();
  });

  test("Group leaderboard snapshot (v7.15.2, audit): an ASSIGN-driven revive also drops the frozen snapshot", async () => {
    const Database = require("better-sqlite3");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = GH(saCsrf);
    const t = Date.now();
    // ONE task, so that everyone solving it triggers the all-solved AUTO-end —
    // which is the only state the assign path revives (ended_at set + ended_manually=0).
    const compId = (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: `SNAPA ${t}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 240, group_leaderboard_enabled: true } })).json()).competition.id;
    const taskId = (await (await sa.post("/api/admin/tasks", { headers: saH, data: { title: `SNAPA-T ${t}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published" } })).json()).id;
    await sa.post(`/api/admin/tasks/${taskId}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    const p1 = await mkP(sa, saCsrf, `xa${t}`), p2 = await mkP(sa, saCsrf, `xb${t}`);
    const p3 = await mkP(sa, saCsrf, `xc${t}`), p4 = await mkP(sa, saCsrf, `xd${t}`);
    const latecomer = await mkP(sa, saCsrf, `xe${t}`);
    const gA = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `XAlpha ${t}`, userIds: [p1.id, p2.id] } })).json()).group.id;
    const gB = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `XBeta ${t}`, userIds: [p3.id, p4.id] } })).json()).group.id;
    expect((await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [gA, gB], competitionIds: [compId] } })).ok()).toBeTruthy();
    await sa.dispose();

    const solve = async (email) => {
      const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
      const h = GH(csrf);
      expect((await api.post("/api/select-competition", { headers: h, data: { competitionId: compId } })).ok()).toBeTruthy();
      expect((await api.post(`/api/tasks/${taskId}/submit`, { headers: h, data: { answer: "a" , gradingHash: await gradingHashFor(api, taskId)} })).ok()).toBeTruthy();
      await api.dispose();
    };
    for (const p of [p1, p2, p3, p4]) await solve(p.email);   // everyone solves everything → auto-end

    const row = () => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare("SELECT ended_at, ended_manually FROM competitions WHERE id=?").get(compId); } finally { db.close(); } };
    const snapCount = () => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare("SELECT COUNT(*) c FROM group_leaderboard_snapshots WHERE competition_id=?").get(compId).c; } finally { db.close(); } };
    await expect.poll(() => row().ended_at, { timeout: 5000, intervals: [50, 100, 200, 400, 800] }).toBeTruthy();
    expect(row().ended_manually, "all-solved auto-end leaves ended_manually=0").toBeFalsy();

    // Read once post-end → lazily freezes the snapshot.
    const { api: r1 } = await apiLogin("superadmin");
    await r1.get(`/api/admin/leaderboard?competitionId=${compId}&groups=1`);
    await r1.dispose();
    expect(snapCount(), "a snapshot row was frozen on the first post-end read").toBe(1);

    // The fix under test: assigning a new participant revives the comp, and that
    // revive must invalidate the frozen snapshot exactly as the PUT path does.
    const { api: as, csrf: asC } = await apiLogin("superadmin");
    expect((await as.post("/api/admin/competitions/assign", { headers: GH(asC), data: { userIds: [latecomer.id], competitionIds: [compId] } })).ok()).toBeTruthy();
    await as.dispose();
    expect(row().ended_at, "assign revived the auto-ended comp").toBeFalsy();
    expect(snapCount(), "the assign-driven revive dropped the frozen snapshot").toBe(0);

    const { api: cl, csrf: clc } = await apiLogin("superadmin");
    await cl.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": clc } }).catch(() => {});
    await cl.dispose();
  });

  test("Group leaderboard snapshot-at-end freeze (v7.12.3, audit M4): ended team board is frozen; post-end membership edit can't rewrite it; revive recomputes", async () => {
    const Database = require("better-sqlite3");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = GH(saCsrf);
    const t = Date.now();
    // Live comp (started 60s ago), group board enabled.
    const compId = (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: `SNAP ${t}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 240, group_leaderboard_enabled: true } })).json()).competition.id;
    const mkTask = async (title, ans) => (await (await sa.post("/api/admin/tasks", { headers: saH, data: { title, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: ans, status: "published" } })).json()).id;
    const t1 = await mkTask(`SNAP-A ${t}`, "a");
    const t2 = await mkTask(`SNAP-B ${t}`, "b");
    for (const tid of [t1, t2]) await sa.post(`/api/admin/tasks/${tid}/competitions`, { headers: saH, data: { competitionIds: [compId] } });
    const alice = await mkP(sa, saCsrf, `sa${t}`);
    const bob = await mkP(sa, saCsrf, `sb${t}`);
    const carol = await mkP(sa, saCsrf, `sc${t}`);
    const dave = await mkP(sa, saCsrf, `sd${t}`);
    const alpha = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `SAlpha ${t}`, userIds: [alice.id, bob.id] } })).json()).group.id;
    const beta = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `SBeta ${t}`, userIds: [carol.id, dave.id] } })).json()).group.id;
    expect((await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [alpha, beta], competitionIds: [compId] } })).ok()).toBeTruthy();
    await sa.dispose();

    const play = async (email, seq) => {
      const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
      const h = GH(csrf);
      expect((await api.post("/api/select-competition", { headers: h, data: { competitionId: compId } })).ok()).toBeTruthy();
      for (const [tid, ans] of seq) expect((await api.post(`/api/tasks/${tid}/submit`, { headers: h, data: { answer: ans , gradingHash: await gradingHashFor(api, tid)} })).ok()).toBeTruthy();
      await api.dispose();
    };
    await play(alice.email, [[t1, "a"], [t2, "b"]]);                    // 100
    await play(bob.email, [[t1, "a"], ...wrongs(t2, 4), [t2, "b"]]);    // 80  → SAlpha avg 90
    await play(carol.email, [[t1, "a"]]);                              // 50
    await play(dave.email, [[t1, "a"]]);                              // 50  → SBeta avg 50

    const readAlpha = async () => {
      const { api } = await apiLogin("superadmin");
      const board = await (await api.get(`/api/admin/leaderboard?competitionId=${compId}&groups=1`)).json();
      await api.dispose();
      const e = (board || []).find(x => x.type === "group" && x.name.startsWith("SAlpha"));
      return e ? e.score : null;
    };
    const compUpdatedAt = () => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare("SELECT updated_at FROM competitions WHERE id=?").get(compId).updated_at; } finally { db.close(); } };
    const snapCount = () => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare("SELECT COUNT(*) c FROM group_leaderboard_snapshots WHERE competition_id=?").get(compId).c; } finally { db.close(); } };

    // While LIVE: SAlpha averages alice(100)+bob(80) = 90.
    expect(await readAlpha()).toBe(90);

    // End the competition, then read once (→ lazily freezes the snapshot).
    const { api: e1, csrf: e1c } = await apiLogin("superadmin");
    expect((await e1.post(`/api/admin/competitions/${compId}/end-now`, { headers: GH(e1c) })).ok()).toBeTruthy();
    await e1.dispose();
    expect(await readAlpha(), "board still reads 90 immediately after end").toBe(90);
    expect(snapCount(), "a snapshot row was written on first post-end read").toBe(1);

    // Post-end membership edit: remove bob from SAlpha. If the board recomputed LIVE,
    // SAlpha would jump to alice(100)=100. Frozen → it must STAY 90.
    const { api: m1, csrf: m1c } = await apiLogin("superadmin");
    expect((await m1.delete(`/api/admin/groups/${alpha}/members/${bob.id}`, { headers: { "x-csrf-token": m1c } })).ok()).toBeTruthy();
    await m1.dispose();
    expect(await readAlpha(), "ended team board is FROZEN — post-end group edit can't rewrite it").toBe(90);

    // Revive (extend duration) → the frozen snapshot is dropped → the board recomputes
    // LIVE, now reflecting bob's removal (SAlpha = alice only = 100).
    const { api: rv, csrf: rvc } = await apiLogin("superadmin");
    const put = await rv.put(`/api/admin/competitions/${compId}`, { headers: GH(rvc), data: { duration_minutes: 300, expectedUpdatedAt: compUpdatedAt() } });
    expect(put.ok(), "duration-extend revives the manually-ended comp").toBeTruthy();
    await rv.dispose();
    expect(snapCount(), "revive invalidated the snapshot").toBe(0);
    expect(await readAlpha(), "revived (live) board recomputes fresh — bob is gone").toBe(100);

    const { api: cl, csrf: clc } = await apiLogin("superadmin");
    await cl.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": clc } }).catch(() => {});
    await cl.dispose();
  });

  test("req 7: binding a group whose member is already in another bound group is BLOCKED with a descriptive clash error", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = GH(saCsrf);
    const t = Date.now();
    const mkComp = async (name) => (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: `${name} ${t}`, start_time: new Date(t + 3600_000).toISOString(), duration_minutes: 120, group_leaderboard_enabled: true } })).json()).competition.id;
    const compId = await mkComp("Clash");
    const ux = await mkP(sa, saCsrf, `x${t}`);
    const uy = await mkP(sa, saCsrf, `y${t}`);
    const P = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `P ${t}`, userIds: [ux.id, uy.id] } })).json()).group.id;
    const Q = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `Q ${t}`, userIds: [ux.id] } })).json()).group.id;
    // Bind P — fine.
    expect((await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [P], competitionIds: [compId] } })).ok()).toBeTruthy();
    // Bind Q — ux is in P and Q → 409 clash, disallowed.
    const r2 = await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [Q], competitionIds: [compId] } });
    expect(r2.status()).toBe(409);
    const d2 = await r2.json();
    expect(d2.error).toContain(ux.nick);                                   // names the clashing participant
    expect(d2.error).toContain(`P ${t}`);                                  // names both groups they're in
    expect(d2.error).toContain(`Q ${t}`);
    const conflict = (d2.clash?.conflicts || []).find(c => c.userId === ux.id);
    expect(conflict, "structured clash lists the clashing user").toBeTruthy();
    expect(conflict.groups.length).toBeGreaterThanOrEqual(2);
    // Q must NOT have been bound (atomic — no partial bind).
    const Database = require("better-sqlite3");
    const bound = (cid, gid) => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare("SELECT COUNT(*) c FROM competition_groups WHERE competition_id=? AND group_id=?").get(cid, gid).c; } finally { db.close(); } };
    expect(bound(compId, P)).toBe(1);
    expect(bound(compId, Q)).toBe(0);
    // Binding P + Q TOGETHER on a fresh comp (they share ux) also clashes.
    const compId2 = await mkComp("Clash2");
    const r3 = await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [P, Q], competitionIds: [compId2] } });
    expect(r3.status()).toBe(409);
    expect(bound(compId2, P)).toBe(0);   // atomic — neither bound
    expect(bound(compId2, Q)).toBe(0);
    await sa.dispose();
    const { api: cl, csrf: clc } = await apiLogin("superadmin");
    for (const c of [compId, compId2]) await cl.delete(`/api/admin/competitions/${c}`, { headers: { "x-csrf-token": clc } }).catch(() => {});
    await cl.dispose();
  });

  test("req 7 back-door (v7.11.1): adding a member to a group already bound to a competition where they're in another bound group is BLOCKED", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = GH(saCsrf);
    const t = Date.now();
    const compId = (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: `BD ${t}`, start_time: new Date(t + 3600_000).toISOString(), duration_minutes: 120, group_leaderboard_enabled: true } })).json()).competition.id;
    const ux = await mkP(sa, saCsrf, `bdx${t}`);
    const uy = await mkP(sa, saCsrf, `bdy${t}`);
    const P = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `BP ${t}`, userIds: [ux.id] } })).json()).group.id;
    const Q = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `BQ ${t}` } })).json()).group.id; // empty
    const R = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `BR ${t}` } })).json()).group.id; // empty + unbound
    // Bind P (has ux) + Q (empty → no bind clash) to the comp.
    expect((await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [P, Q], competitionIds: [compId] } })).ok()).toBeTruthy();

    const Database = require("better-sqlite3");
    const inGroup = (uid, gid) => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare("SELECT COUNT(*) c FROM group_members WHERE user_id=? AND group_id=?").get(uid, gid).c; } finally { db.close(); } };

    // (a) bulk member-add: adding ux to Q → clash (ux would be in P + Q, both bound to compId).
    const r1 = await sa.post(`/api/admin/groups/${Q}/members`, { headers: saH, data: { userIds: [ux.id] } });
    expect(r1.status()).toBe(409);
    const d1 = await r1.json();
    expect(d1.error).toContain(ux.nick);       // names the participant
    expect(d1.error).toContain(`BP ${t}`);     // the OTHER group they're in
    expect(d1.error).toContain(`BD ${t}`);     // the competition where the clash occurs
    expect((d1.clash?.conflicts || []).some(c => c.userId === ux.id), "structured clash lists the participant").toBe(true);
    expect(inGroup(ux.id, Q), "clash blocked the add — atomic").toBe(0);

    // (b) per-participant add: adding ux to Q → clash too.
    const r2 = await sa.post(`/api/admin/participants/${ux.id}/groups`, { headers: saH, data: { groupId: Q } });
    expect(r2.status()).toBe(409);
    expect(inGroup(ux.id, Q)).toBe(0);

    // (c) NON-clash: uy (not in any other bound group) added to Q → allowed.
    expect((await sa.post(`/api/admin/groups/${Q}/members`, { headers: saH, data: { userIds: [uy.id] } })).ok()).toBeTruthy();
    expect(inGroup(uy.id, Q)).toBe(1);
    // (d) group bound NOWHERE: adding ux to the unbound R → allowed (no clash possible).
    expect((await sa.post(`/api/admin/groups/${R}/members`, { headers: saH, data: { userIds: [ux.id] } })).ok()).toBeTruthy();
    expect(inGroup(ux.id, R)).toBe(1);

    await sa.dispose();
    const { api: cl, csrf: clc } = await apiLogin("superadmin");
    await cl.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": clc } }).catch(() => {});
    await cl.dispose();
  });

  test("participant /api/leaderboard exposes groupBoard (with the caller's team marked) when groups are bound; null otherwise", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = GH(saCsrf);
    const t = Date.now();
    const mkLiveComp = async (name) => {
      // `entry`: each member joins the board by entering it.
      const cid = (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: `${name} ${t}`, start_time: new Date(t - 60_000).toISOString(), duration_minutes: 240, group_leaderboard_enabled: true, clock_start: "entry" } })).json()).competition.id;
      const tid = (await (await sa.post("/api/admin/tasks", { headers: saH, data: { title: `${name}-T ${t}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published" } })).json()).id;
      await sa.post(`/api/admin/tasks/${tid}/competitions`, { headers: saH, data: { competitionIds: [cid] } });
      return { cid, tid };
    };
    const u1 = await mkP(sa, saCsrf, `p1${t}`);
    const u2 = await mkP(sa, saCsrf, `p2${t}`);
    const withGroups = await mkLiveComp("PGB");
    // v7.11.7 — the board needs >=2 non-empty groups, so bind two single-member teams
    // (u1's own team + u2's). No clash: each user is in exactly one bound group.
    const g1 = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `Team ${t}`, userIds: [u1.id] } })).json()).group.id;
    const g2 = (await (await sa.post("/api/admin/groups", { headers: saH, data: { name: `Rivals ${t}`, userIds: [u2.id] } })).json()).group.id;
    await sa.post("/api/admin/competitions/assign", { headers: saH, data: { groupIds: [g1, g2], competitionIds: [withGroups.cid] } });
    const noGroups = await mkLiveComp("NoGrp");
    await sa.post("/api/admin/competitions/assign", { headers: saH, data: { userIds: [u1.id], competitionIds: [noGroups.cid] } });
    await sa.dispose();

    // v7.11.7 — u2 must be on the board too so Rivals is a non-empty (active) group,
    // giving the 2 non-empty groups the board now requires.
    { const { api: p2, csrf: p2c } = await apiLogin(u2.email, PARTICIPANT_PASS);
      expect((await p2.post("/api/select-competition", { headers: GH(p2c), data: { competitionId: withGroups.cid } })).ok()).toBeTruthy();
      await p2.dispose(); }

    // Bound-group comp → groupBoard present, caller's team marked mine.
    const { api: p, csrf: pc } = await apiLogin(u1.email, PARTICIPANT_PASS);
    expect((await p.post("/api/select-competition", { headers: GH(pc), data: { competitionId: withGroups.cid } })).ok()).toBeTruthy();
    await p.post(`/api/tasks/${withGroups.tid}/submit`, { headers: GH(pc), data: { answer: "a" , gradingHash: await gradingHashFor(p, withGroups.tid)} });
    const lb = await (await p.get("/api/leaderboard")).json();
    await p.dispose();
    expect(lb.groupBoard, "groupBoard present when enabled + >=2 non-empty groups").toBeTruthy();
    expect(Array.isArray(lb.groupBoard.board)).toBe(true);
    const team = lb.groupBoard.board.find(e => e.type === "group" && e.mine);
    expect(team, "caller's own team on the group board").toBeTruthy();
    expect(team.name.startsWith("Team"), "caller's team is 'Team' (not the rivals)").toBe(true);

    // No-group comp → groupBoard null.
    const { api: p2, csrf: pc2 } = await apiLogin(u1.email, PARTICIPANT_PASS);
    expect((await p2.post("/api/select-competition", { headers: GH(pc2), data: { competitionId: noGroups.cid } })).ok()).toBeTruthy();
    const lb2 = await (await p2.get("/api/leaderboard")).json();
    await p2.dispose();
    expect(lb2.groupBoard, "no groups bound → groupBoard is null").toBeNull();

    const { api: cl, csrf: clc } = await apiLogin("superadmin");
    for (const c of [withGroups.cid, noGroups.cid]) {
      await cl.post(`/api/admin/competitions/${c}/end-now`, { headers: GH(clc) }).catch(() => {});
      await cl.delete(`/api/admin/competitions/${c}`, { headers: { "x-csrf-token": clc } }).catch(() => {});
    }
    await cl.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Task recalc idempotency (v6.8.0)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Task recalc idempotency", () => {
  test("recalculating a task twice produces the same leaderboard", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    // easy1 has Alice's correct submission from seedTestData.
    // /api/admin/leaderboard returns a bare array of participant rows.
    await api.post(`/api/admin/tasks/${S.tasks[0].id}/recalculate`, { headers: { "x-csrf-token": csrf } });
    const mid = await (await api.get(`/api/admin/leaderboard?competitionId=${S.liveComp.id}`)).json();
    await api.post(`/api/admin/tasks/${S.tasks[0].id}/recalculate`, { headers: { "x-csrf-token": csrf } });
    const after = await (await api.get(`/api/admin/leaderboard?competitionId=${S.liveComp.id}`)).json();
    // Per-user scores must be identical across two recalcs.
    expect(Array.isArray(after)).toBe(true);
    expect(after.length).toBe(mid.length);
    const byId = new Map(mid.map(r => [r.userId, r]));
    for (const row of after) {
      const prev = byId.get(row.userId);
      expect(prev).toBeTruthy();
      expect(row.score).toBe(prev.score);
    }
    await api.dispose();
  });

  // v6.8.2 — exercise the full "edit a challenge → participants drop
  // to wrong → restore the prior version → re-run recalc → scores come
  // back" round trip. Previously only the scalar recalc was tested; the
  // version-restore path had no coverage.
  test("restore a prior task version then recalc — scores round-trip", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const now = Date.now();

    // Self-contained comp + participant so we don't perturb the shared
    // alice-in-Test-Live fixture.
    let r = await api.post("/api/admin/competitions", { headers: h, data: {
      name: `Restore Rescore ${now}`,
      start_time: new Date(now - 60_000).toISOString(),
      duration_minutes: 120,
    }});
    const compId = (await r.json()).competition?.id;

    r = await api.post("/api/admin/tasks", { headers: h, data: {
      title: `Restore Task ${now}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "text", correct_answer: "original-answer", status: "published",
    }});
    const bankId = (await r.json()).id;
    // The event's own copy: the question alice answers, and the one edited,
    // restored and recalculated below (lib/event-copies.js).
    const asg = await api.post(`/api/admin/tasks/${bankId}/competitions`, { headers: h, data: { competitionIds: [compId] }});
    expect(asg.ok(), await asg.text()).toBeTruthy();
    const taskId = (await asg.json()).copies[0].task_id;
    await api.post("/api/admin/competitions/assign", { headers: h, data: {
      userIds: [S.alice.id, S.bob.id], competitionIds: [compId],
    }});
    await api.dispose();

    // Alice submits the ORIGINAL correct answer — scores 50 (easy).
    const { api: alice, csrf: aliceCsrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const ha = { "x-csrf-token": aliceCsrf, "content-type": "application/json" };
    await alice.post("/api/select-competition", { headers: ha, data: { competitionId: compId }});
    const subR = await alice.post(`/api/tasks/${taskId}/submit`, { headers: ha, data: { answer: "original-answer" , gradingHash: await gradingHashFor(alice, taskId)}});
    expect(subR.ok()).toBeTruthy();
    expect((await subR.json()).correct).toBe(true);
    await alice.dispose();

    // Admin edits the task — correct_answer is now "new-answer". v1 is
    // preserved in task_versions; is_correct on Alice's submission should
    // flip to 0 after recalc.
    const { api: admin, csrf: aCsrf } = await apiLogin("superadmin");
    const hAdmin = { "x-csrf-token": aCsrf, "content-type": "application/json" };
    const editR = await admin.put(`/api/admin/tasks/${taskId}`, { headers: hAdmin, data: { correct_answer: "new-answer" }});
    expect(editR.ok()).toBeTruthy();
    await admin.post(`/api/admin/tasks/${taskId}/recalculate`, { headers: hAdmin, data: { confirm_live: true } });

    const Database = require("better-sqlite3");
    const db1 = new Database(TEST_DB_PATH, { readonly: true });
    const midRow = db1.prepare("SELECT is_correct, points_delta FROM submissions WHERE user_id=? AND task_id=? ORDER BY submitted_at DESC LIMIT 1").get(S.alice.id, taskId);
    db1.close();
    expect(midRow).toBeTruthy();
    expect(midRow.is_correct).toBe(0);

    // Restore the previous version (v1) — correct_answer goes back to
    // "original-answer" — then recalc again. Alice's row should flip
    // back to is_correct=1.
    const verRes = await admin.get(`/api/admin/tasks/${taskId}/versions`);
    const versions = await verRes.json();
    // versions are newest-first; v1 is the oldest — the original pre-edit
    // snapshot we want to restore.
    const v1 = versions[versions.length - 1];
    expect(v1).toBeTruthy();
    const restoreR = await admin.post(`/api/admin/tasks/${taskId}/restore`, { headers: hAdmin, data: { versionId: v1.id }});
    expect(restoreR.ok()).toBeTruthy();
    await admin.post(`/api/admin/tasks/${taskId}/recalculate`, { headers: hAdmin, data: { confirm_live: true } });

    const db2 = new Database(TEST_DB_PATH, { readonly: true });
    const afterRow = db2.prepare("SELECT is_correct, points_delta FROM submissions WHERE user_id=? AND task_id=? ORDER BY submitted_at DESC LIMIT 1").get(S.alice.id, taskId);
    db2.close();
    expect(afterRow.is_correct).toBe(1);
    expect(afterRow.points_delta).toBeGreaterThan(0);

    // Cleanup: end the comp, delete it (cascade clears submissions),
    // then delete the orphan task.
    await admin.post(`/api/admin/competitions/${compId}/end-now`, { headers: { "x-csrf-token": aCsrf } });
    await admin.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": aCsrf } });
    await admin.delete(`/api/admin/tasks/${bankId}`, { headers: { "x-csrf-token": aCsrf } });
    await admin.dispose();
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// SCHEDULER + SUBMISSION RACE CONDITIONS
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Scheduler + submission race conditions", () => {
  test("auto-start: competition transitions upcoming→live when start_time passes", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    let compId;
    try {
      // Create a competition starting 2 seconds in the future, duration 60 min
      const startTime = new Date(Date.now() + 2000).toISOString();
      const r = await api.post("/api/admin/competitions", {
        headers: h,
        data: { name: `AutoStart-${Date.now()}`, start_time: startTime, duration_minutes: 60 },
      });
      expect(r.ok()).toBeTruthy();
      compId = (await r.json()).competition.id;

      // Poll GET /api/admin/competitions every 500ms (up to 90 seconds max)
      // waiting for the competition to appear with status "live".
      // The scheduler runs every ~60s so we need patience.
      let found = false;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const comps = await (await api.get("/api/admin/competitions")).json();
        const comp = comps.find(c => c.id === compId);
        expect(comp, "competition must still exist").toBeTruthy();
        // The admin endpoint computes status server-side from
        // start_time / duration_minutes / ended_at.
        if (comp.status === "live") {
          found = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      expect(found, "competition should have transitioned to live within 90s").toBe(true);
    } finally {
      // Clean up: delete the competition
      if (compId) {
        await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } });
      }
      await api.dispose();
    }
  });

  test("submission to an ended competition is rejected even under concurrent auto-end", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    let compId, taskId, participantId;
    const suffix = Date.now();
    const email = `racetest-${suffix}@example.com`;
    try {
      // Create a competition that started 1 second ago with duration_minutes: 1
      // (so it ends in ~59 seconds)
      const startTime = new Date(Date.now() - 1000).toISOString();
      let r = await sa.post("/api/admin/competitions", {
        headers: saH,
        data: { name: `RaceEnd-${suffix}`, start_time: startTime, duration_minutes: 1 },
      });
      expect(r.ok()).toBeTruthy();
      compId = (await r.json()).competition.id;

      // Create a task and assign to the competition
      r = await sa.post("/api/admin/tasks", {
        headers: saH,
        data: {
          title: `RaceTask-${suffix}`, description: "<p>race</p>",
          difficulty: "easy", answer_type: "text", correct_answer: "racewin",
          status: "published",
        },
      });
      expect(r.ok()).toBeTruthy();
      taskId = (await r.json()).id;
      r = await sa.post(`/api/admin/tasks/${taskId}/competitions`, {
        headers: saH, data: { competitionIds: [compId] },
      });
      expect(r.ok()).toBeTruthy();

      // Create and approve a participant, assign them to the competition
      r = await registerPost(sa, "/api/register", {
        headers: saH,
        data: {
          firstName: "Race", lastName: "Tester", nickname: `racer_${suffix}`,
          email, company: "TestCo", title: "QA",
          country: "US", timezone: "America/New_York",
        },
      });
      const parts = (await (await sa.get("/api/admin/participants?limit=500")).json()).participants;
      const user = parts.find(p => p.email === email);
      expect(user, "registered user should exist").toBeTruthy();
      participantId = user.id;
      await sa.post(`/api/admin/participants/${participantId}/verify`, { headers: saH });
      await sa.post(`/api/admin/participants/${participantId}/approve`, { headers: saH });


      // Assign participant to the competition
      await sa.post("/api/admin/competitions/assign", {
        headers: saH, data: { userIds: [participantId], competitionIds: [compId] },
      });

      // Login as the participant, select the competition
      const { api: pApi, csrf: pCsrf } = await apiLogin(email, PARTICIPANT_PASS);
      try {
        await pApi.post("/api/select-competition", {
          headers: { "x-csrf-token": pCsrf, "content-type": "application/json" },
          data: { competitionId: compId },
        });

        // End the competition manually via POST /api/admin/competitions/:id/end-now
        const endR = await sa.post(`/api/admin/competitions/${compId}/end-now`, {
          headers: saH, data: {},
        });
        expect(endR.ok()).toBe(true);

        // Immediately try submitting an answer
        const submitR = await pApi.post(`/api/tasks/${taskId}/submit`, {
          headers: { "x-csrf-token": pCsrf, "content-type": "application/json" },
          data: { answer: "racewin" , gradingHash: await gradingHashFor(pApi, taskId)},
        });
        // Expect either 403 (ended — the guard works) or 200 (slipped through
        // before the end was visible — valid race outcome). If 403, the fix works.
        expect([200, 403]).toContain(submitR.status());
        if (submitR.status() === 403) {
          const body = await submitR.json();
          expect(body.error).toContain("ended");
        }
      } finally {
        await pApi.dispose();
      }
    } finally {
      // Clean up: delete task, participant, competition (order matters for FK)
      if (taskId) {
        await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
      }
      if (participantId) {
        await sa.delete(`/api/admin/participants/${participantId}`, { headers: { "x-csrf-token": saCsrf } });
      }
      if (compId) {
        await sa.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": saCsrf } });
      }
      await sa.dispose();
    }
  });
});


test.describe("v6.13.17 — content-hashed static asset Cache-Control", () => {
  // Server policy (server.js:2180-2300): a static asset fetched with a
  // ?v=<hash> query gets `public, max-age=31536000, immutable`, and the
  // same asset fetched without the query gets `public, max-age=300`.
  // This is the whole point of the content-hashing: immutable caching
  // only kicks in when the URL is hash-stamped. A regression that
  // flipped the bare URL to immutable would poison browser caches
  // across deploys. Lock both branches at once.
  test("?v=<hex> hits get immutable 1y; bare URL stays short-cache", async () => {
    const { api } = await freshCtx();
    try {
      const hashed = await api.get("/styles.css?v=deadbeef0123");
      expect(hashed.ok(), "hashed stylesheet must 200").toBeTruthy();
      expect(hashed.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");

      const bare = await api.get("/styles.css");
      expect(bare.ok(), "bare stylesheet must 200").toBeTruthy();
      expect(bare.headers()["cache-control"]).toBe("public, max-age=300");
    } finally {
      await api.dispose();
    }
  });
});





test.describe("Schema migration — upgrade safety", () => {
  // Regression for the production 7.2.x→7.7.x upgrade crash: db.js created
  // idx_users_pending_email_code BEFORE the pending_email_code column was
  // ALTER-added, so any upgrade from a pre-v7.5 schema died at boot with
  // "SqliteError: no such column: pending_email_code". This test seeds the exact
  // OLD users schema and runs db.js's full migration path against it in a child
  // process (db.js sets up the schema at require-time) — it must exit 0 and land
  // the new column + index. Catches this AND any future index/migration that
  // references an ALTER-added user column before it exists.
  test("db.js migrates a pre-v7.5 users schema (no pending_email columns) without crashing", () => {
    const Database = require("better-sqlite3");
    const { execFileSync } = require("child_process");
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-migtest-"));
    try {
      const dbPath = path.join(dir, "hackathon.db");
      // OLD (v7.2.x) users schema: has reset_code/verify_code (original columns),
      // LACKS pending_email_code + the other v7.5+ columns the migrations add.
      const seed = new Database(dbPath);
      seed.exec(`CREATE TABLE users (
        id TEXT PRIMARY KEY, nickname TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
        secondary_email TEXT, password TEXT, first_name TEXT, last_name TEXT,
        company TEXT, title TEXT, country TEXT, timezone TEXT, avatar TEXT, linkedin_url TEXT,
        verify_code TEXT, verify_code_at TEXT, verified INTEGER DEFAULT 0,
        approved INTEGER DEFAULT 0, approved_at TEXT, approved_by TEXT, blocked INTEGER DEFAULT 0,
        reset_code TEXT, reset_code_at TEXT, locked_until TEXT,
        role TEXT DEFAULT 'participant', registered_via TEXT DEFAULT 'manual',
        active_competition_id TEXT, created_at TEXT NOT NULL)`);
      seed.prepare("INSERT INTO users (id,nickname,email,verified,approved,created_at) VALUES (?,?,?,?,?,?)")
        .run("u1", "oldnick", "old@acme.com", 1, 1, new Date().toISOString());
      const preCols = seed.prepare("PRAGMA table_info(users)").all().map(c => c.name);
      seed.close();
      expect(preCols, "seed must NOT already have pending_email_code").not.toContain("pending_email_code");

      // Run db.js's migration path against the old DB. A migration crash → non-zero exit.
      const repoRoot = path.resolve(__dirname, "..");
      execFileSync(process.execPath, ["-e", "require('./db')"], {
        cwd: repoRoot,
        env: { ...process.env, DATA_DIR: dir, UPLOADS_DIR: `${dir}/uploads`, NODE_ENV: "test" },
        stdio: "pipe",
        timeout: 30000,
      });

      // The migration landed: the column + its index now exist.
      const migrated = new Database(dbPath, { readonly: true });
      const cols = migrated.prepare("PRAGMA table_info(users)").all().map(c => c.name);
      const idx = migrated.prepare("PRAGMA index_list(users)").all().map(i => i.name);
      migrated.close();
      expect(cols, "pending_email_code column not added on upgrade").toContain("pending_email_code");
      expect(idx, "idx_users_pending_email_code not created on upgrade").toContain("idx_users_pending_email_code");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("db.js: idx_users_pending_email_code is created AFTER its column-add (source-order lock)", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "db.js"), "utf8");
    const addPos = src.indexOf("ADD COLUMN pending_email_code");
    const idxPos = src.indexOf("idx_users_pending_email_code ON users(pending_email_code");
    expect(addPos, "pending_email_code column-add missing from db.js").toBeGreaterThan(-1);
    expect(idxPos, "idx_users_pending_email_code CREATE missing from db.js").toBeGreaterThan(-1);
    expect(idxPos, "the index is created BEFORE its column-add (upgrade crash)").toBeGreaterThan(addPos);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// audit v7.7.26 batch 1 — live-event reliability
//   H1:  the comp-level start-time lock must EXEMPT an unchanged value, so a
//        whole-form client (or the multi-mode derived aggregate) can still save
//        name/reveal/duration edits on a live competition.
//   M16: the participant task routes' "window not started" 403 must carry a
//        structured discriminator (not_started / needsSlot) so the SPA can
//        route back to the pending/session-picker view instead of falsely
//        ejecting "You are no longer in this event."
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("audit v7.7.26 batch 1 — live multi-session edit + not-started 403", () => {
  test("H1: PUT with an UNCHANGED start_time on a live multi-session comp saves; a CHANGED one still 400s", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
    const now = Date.now();
    // Multi-session comp: session A live (started 10 min ago), session B
    // upcoming (+2h) → competitionStatus = "live" (mixed slots).
    let r = await api.post("/api/admin/competitions", { headers: h, data: {
      name: `H1 Multi ${stamp}`, start_time: new Date(now - 10 * 60_000).toISOString(), duration_minutes: 60,
    }});
    expect(r.ok()).toBeTruthy();
    const compId = (await r.json()).competition.id;
    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h, data: {
      name: "A live", start_time: new Date(now - 10 * 60_000).toISOString(), duration_minutes: 60,
    }});
    expect(r.ok()).toBeTruthy();
    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h, data: {
      name: "B upcoming", start_time: new Date(now + 2 * 3600_000).toISOString(), duration_minutes: 60,
    }});
    expect(r.ok()).toBeTruthy();
    // Echoing back the STORED start_time (what a whole-form client sends —
    // pre-fix this 400'd, blocking every form edit of a live multi comp).
    const stored = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === compId);
    r = await api.put(`/api/admin/competitions/${compId}`, { headers: h, data: {
      name: `H1 Multi ${stamp} renamed`, start_time: new Date(stored.start_time).toISOString(),
    }});
    expect(r.status(), `unchanged start_time must pass the live-lock: ${await r.text()}`).toBe(200);
    const renamed = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === compId);
    expect(renamed.name).toBe(`H1 Multi ${stamp} renamed`);
    // A genuinely DIFFERENT start_time on a live comp stays locked (rule #1).
    // v8.3.10 — this fixture is MULTI-SESSION, which is why it still refuses even
    // for the superadmin driving it: the v8.3.10 relaxation is scoped to SLOTLESS
    // events, because a multi-session competition's status never reads
    // `comp.start_time` at all (its slots decide), so writing it would be a
    // control that appears to work. That this test needed only its assertion
    // re-pointed — not its fixture — is the evidence the relaxation did not leak
    // into the multi-session path. Asserting the CODE rather than the sentence,
    // because the code is the contract and the wording is free to improve.
    r = await api.put(`/api/admin/competitions/${compId}`, { headers: h, data: {
      start_time: new Date(now + 3600_000).toISOString(),
    }});
    expect(r.status()).toBe(400);
    const _startRefusal = await r.json();
    expect(_startRefusal.code).toBe("start_time_locked_sessions");
    expect(_startRefusal.error).toMatch(/Cannot change the start time/);
    await api.dispose();
  });

  test("M16: the not-started 403 on /api/tasks carries not_started + needsSlot discriminators", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
    const now = Date.now();
    // Fresh participant (no shared-pool pollution — alice/bob active-comp
    // state is load-bearing for other tests in this worker).
    const email = `m16_${stamp}@acme.com`;
    const { api: anon, csrf: anonCsrf } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: { "x-csrf-token": anonCsrf, "content-type": "application/json" }, data: {
      firstName: "M16", lastName: "User", nickname: `m16_${stamp}`, email,
      company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC",
    }});
    await anon.dispose();
    const parts = (await (await sa.get("/api/admin/participants?limit=2000")).json()).participants;
    const me = parts.find(p => p.email === email);
    expect(me, "fresh participant created").toBeTruthy();
    await sa.post(`/api/admin/participants/${me.id}/verify`, { headers: h });
    await sa.post(`/api/admin/participants/${me.id}/approve`, { headers: h });
    // Multi-session comp: A live, B upcoming — comp status "live" while the
    // participant's own window can still be not-started.
    let r = await sa.post("/api/admin/competitions", { headers: h, data: {
      name: `M16 Multi ${stamp}`, start_time: new Date(now - 10 * 60_000).toISOString(), duration_minutes: 60,
    }});
    const compId = (await r.json()).competition.id;
    await sa.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h, data: {
      name: "A live", start_time: new Date(now - 10 * 60_000).toISOString(), duration_minutes: 60,
    }});
    const tsB = (await (await sa.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h, data: {
      name: "B upcoming", start_time: new Date(now + 2 * 3600_000).toISOString(), duration_minutes: 60,
    }})).json()).timeslot;
    await sa.post("/api/admin/competitions/assign", { headers: h, data: { userIds: [me.id], competitionIds: [compId] } });

    const { api: p, csrf: pc } = await apiLogin(email, PARTICIPANT_PASS);
    const ph = { "x-csrf-token": pc, "content-type": "application/json" };
    r = await p.post("/api/select-competition", { headers: ph, data: { competitionId: compId } });
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).needsTimeslotChoice).toBeTruthy();
    // (1) No slot chosen yet → 403 with needsSlot:true (route to the session picker).
    r = await p.get("/api/tasks");
    expect(r.status()).toBe(403);
    let body = await r.json();
    expect(body.not_started, "no-slot 403 must carry not_started:true").toBe(true);
    expect(body.needsSlot, "no-slot 403 must carry needsSlot:true").toBe(true);
    // (2) Upcoming slot chosen → 403 with not_started:true, needsSlot:false
    //     (route to the pending/countdown view — the participant IS a member).
    r = await p.post("/api/select-timeslot", { headers: ph, data: { timeslotId: tsB.id } });
    expect(r.ok(), await r.text()).toBeTruthy();
    r = await p.get("/api/tasks");
    expect(r.status()).toBe(403);
    body = await r.json();
    expect(body.not_started, "chosen-upcoming-slot 403 must carry not_started:true").toBe(true);
    expect(body.needsSlot).toBe(false);
    // Same discriminator on the task-detail route.
    const anyTask = (await (await sa.get("/api/admin/tasks")).json())[0];
    r = await p.get(`/api/tasks/${anyTask.id}`);
    expect(r.status()).toBe(403);
    expect((await r.json()).not_started).toBe(true);
    await p.dispose();
    await sa.dispose();
  });
});


// audit v7.7.30 batch 5 (a11y) — static locks for the fixes whose surfaces are
// awkward to drive live (the header timer's live-region setting; the submit
// result + hint live regions; the import-conflict radio names).
test.describe("audit v7.7.30 batch 5 — a11y static locks", () => {
  test("M18: #header-timer is aria-live=off (no per-second screen-reader chatter)", () => {
    const fs = require("fs"); const path = require("path");
    const html = fs.readFileSync(path.resolve(__dirname, "..", "public/index.html"), "utf8");
    const m = html.match(/<div id="header-timer"[^>]*>/);
    expect(m, "#header-timer element not found").toBeTruthy();
    expect(m[0], "#header-timer must be aria-live=off").toMatch(/aria-live="off"/);
    expect(m[0], "the per-second polite live region must be gone").not.toMatch(/aria-live="polite"/);
  });

  test("M19: submit-result + hint area are live regions", () => {
    const fs = require("fs"); const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "public/js/features/participant-tasks.js"), "utf8");
    expect(src).toMatch(/id="submit-result" role="status" aria-live="polite"/);
    expect(src).toMatch(/id="hint-area" role="status" aria-live="polite"/);
    // Focus restore helper after the in-flight button disable.
    expect(src).toMatch(/_restoreSubmitFocus/);
  });

  test("M22: import conflict-resolution radios carry aria-labels", () => {
    const fs = require("fs"); const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "public/js/features/export-import.js"), "utf8");
    expect(src).toMatch(/value="keep"[^>]*aria-label="Keep existing/);
    expect(src).toMatch(/value="overwrite"[^>]*aria-label="Overwrite existing/);
    expect(src).toMatch(/value="rename"[^>]*aria-label="Add /);
  });

  test("M20: the click dispatcher pre-focuses the kebab trigger before running a menu action", () => {
    const fs = require("fs"); const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "public/js/core/main.js"), "utf8");
    // The trigger focus must happen BEFORE fn(ev, el) so a dialog captures it.
    const focusIdx = src.indexOf("_kebab._srcBtn.focus()");
    // v8.3.20 — RE-POINTED, not weakened. The three dispatchers now share one
    // `_runHandler`, because the synchronous try/catch they each carried could
    // not see a rejected promise and almost every handler is async. The SUBJECT
    // is unchanged and still discriminating: the kebab trigger must be focused
    // BEFORE the handler runs, so a dialog the handler opens captures a live
    // opener rather than a node closeKebab is about to detach.
    const fnIdx = src.indexOf("_runHandler(fn, ev, el, 'action handler'");
    expect(focusIdx, "kebab trigger pre-focus missing").toBeGreaterThan(-1);
    expect(focusIdx, "trigger must be focused before the handler runs").toBeLessThan(fnIdx);
  });
});


test.describe("audit v7.7.38 (batch 13) — rerun findings", () => {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..");
  const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

  test("H1: GET /api/check-nickname does not 500 on an array nickname query param (anonymous)", async ({ request }) => {
    const BASE = require("./helpers").BASE;
    // Repeated key → Express 5 array → pre-fix (arr||"").trim() → TypeError → 500.
    const r = await request.get(BASE + "/api/check-nickname?nickname=a&nickname=b");
    expect(r.status(), "must not 500 on a non-string query param").toBeLessThan(500);
    const body = await r.json();
    expect(body).toHaveProperty("available");
    // sanity: the normal string case still works
    const r2 = await request.get(BASE + "/api/check-nickname?nickname=zzz_probe_" + Date.now());
    expect(r2.ok()).toBeTruthy();
  });

  test("H4: POST /api/admin/tasks 400s (not 500) on a non-string correct_answer", async () => {
    const { apiLogin } = require("./helpers");
    const { api, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    for (const bad of [{}, ["a", "b"]]) {
      const r = await api.post("/api/admin/tasks", { headers: H, data: { title: "H4 probe", difficulty: "easy", answer_type: "text", correct_answer: bad } });
      expect(r.status(), `correct_answer=${JSON.stringify(bad)} must 400, never 500`).toBe(400);
    }
    // control: a valid string still creates
    const ok = await api.post("/api/admin/tasks", { headers: H, data: { title: "H4 ok " + Date.now(), difficulty: "easy", answer_type: "text", correct_answer: "answer" } });
    expect(ok.ok()).toBeTruthy();
    await api.dispose();
  });

  test("source-locks: every batch-13 fix is present", () => {
    const p = read("routes/participants.js");
    // R1 — bulk-approve loop reconciles group membership.
    expect(p).toMatch(/approved\+\+;[\s\S]{0,700}reconcileUserGroupCompetitions\(user\.id, \{ actor: approvedBy \}\)/);
    // SEC2 — role-demotion reconciles when the staff tag was removed.
    // v8.1.8 — this pinned the ROLE delta alone, which was the defect: the staff
    // tag is written UNCONDITIONALLY by this handler (v7.21.32's comment says so),
    // so a same-role POST that removed a participant-role helper's staff tag made
    // them group-eligible without ever reconciling — leaving a group-bound member
    // silently un-enrolled, where the dedicated DELETE /tags/staff route reconciles
    // on the tag delta. Both halves are pinned now: the original demotion arm, and
    // the `staffRemoved` arm that is the fix.
    // RBAC — "not an admin or superadmin" is now "not an unscoped (class `all`) role".
    expect(p).toMatch(/staffRemoved \|\| \(oldRole !== role && !_isGlobalRole\(role, \{ live: true \}\)\)\) reconcileUserGroupCompetitions/);
    // H1/H2/H3 — query params type-guarded.
    expect(read("routes/auth.js")).toMatch(/typeof req\.query\.nickname === "string"/);
    expect(read("server.js")).toMatch(/typeof req\.query\.level === "string"/);
    expect(read("routes/export-import.js")).toMatch(/typeof req\.query\.competitionId === "string"/);
    // H4 — challenges type-guard loop (both create + edit → replace_all appears twice).
    // v8.13.3 — re-pointed, subject unchanged: `attachment_url` joined the list on
    // both routes (it was the one text field left out — a two-element array 500'd
    // the INSERT, and on edit `{}` / `false` silently CLEARED the stored URL), so
    // the literal pinned here grew by one name. Pinning the old literal would now
    // demand the defect back.
    expect((read("routes/challenges.js").match(/for \(const f of \["correct_answer", "description", "explanation", "hint", "author_name", "author_linkedin", "attachment_url"\]\)/g) || []).length).toBeGreaterThanOrEqual(2);
    // SEC1 — code= scrubbed at write time in _scrubLogPath (the rule + its marker).
    const srv = read("server.js");
    // v8.1.0 — the flags are now `gi`, not `i`, and this pattern accepts either.
    // The lock's subject is that the `?code=` scrub EXISTS at write time; the
    // first-match-only flag was incidental to it, and making the replacement
    // global is strictly stronger — it was `/i`, so `?code=decoy&code=<real>`
    // left the second copy on disk verbatim.
    expect(srv).toMatch(/\.replace\(\/\(\[\?&\]code=\)\[\^&#\]\+\/g?i, "\$1\[REDACTED\]"\)/);
    expect(srv).toMatch(/audit v7\.7\.38 \(SEC1\)/);
    // S1/S5 — swagger true-ups.
    const sw = read("swagger.yaml");
    expect(sw).toMatch(/enrolled_existing: \{ type: integer/);
    expect(sw).not.toMatch(/created: \{ type: integer \}\n\s*enrolled: \{ type: integer \}/); // the fictional bulk-seed shape is gone
    expect(sw).toMatch(/platform_name: \{ type: string, maxLength: 120/);
  });


});


// ═══════════════════════════════════════════════════════════════════════════════
// BULK ASSIGN CHALLENGES TO COMPETITIONS (v7.12.0)
// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/admin/tasks/assign-competitions {taskIds, competitionIds} — the backend
// for the Challenges pane's bulk checkboxes. BEST-EFFORT: draft tasks, locked tasks
// (for a regular admin), and ended / missing competitions are SKIPPED (not 400).
test.describe("Bulk assign challenges to competitions (v7.12.0)", () => {
  const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
  let _u = 0;
  const uniq = (p) => `${p}-${Date.now()}-${_u++}`;
  const Database = require("better-sqlite3");
  const mkTask = async (sa, saH, name, status = "published") => (await (await sa.post("/api/admin/tasks", { headers: saH, data: { title: uniq(name), description: "<p>x</p>", difficulty: "easy", answer_type: "text", correct_answer: "a", status } })).json()).id;
  const mkComp = async (sa, saH, name, startOffsetMs = 3600_000) => (await (await sa.post("/api/admin/competitions", { headers: saH, data: { name: uniq(name), start_time: new Date(Date.now() + startOffsetMs).toISOString(), duration_minutes: 120 } })).json()).competition.id;
  // The challenge is in the event: itself, or (for a bank question) the event's
  // own copy of it, which is what every assign door puts in (lib/event-copies.js).
  const isAssigned = (cid, tid) => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare("SELECT COUNT(*) c FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id WHERE ct.competition_id=? AND (t.id=? OR (t.copied_from_task_id=? AND t.owner_competition_id=ct.competition_id))").get(cid, tid, tid).c > 0; } finally { db.close(); } };
  const compTaskCount = (cid) => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return db.prepare("SELECT COUNT(*) c FROM competition_tasks WHERE competition_id=?").get(cid).c; } finally { db.close(); } };
  // Register + verify + approve + promote → a logged-in REGULAR-admin context.
  async function mkAdmin(sa, saH) {
    const email = uniq("baadm").replace(/[^a-z0-9]/gi, "") + "@acme.com";
    const nick = uniq("ba").replace(/[^a-z0-9]/gi, "");
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: H(ac), data: { firstName: "B", lastName: "A", nickname: nick, email, company: "Acme", title: "Eng", country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC" } });
    await anon.dispose();
    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saH });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: saH });
    await sa.post(`/api/admin/participants/${u.id}/role`, { headers: saH, data: { role: "admin" } });
    return await apiLogin(email, PARTICIPANT_PASS);
  }

  test("assigns many challenges to many competitions in one call (2 tasks × 2 comps → 4)", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const saH = H(csrf);
    const t1 = await mkTask(sa, saH, "BA-t1"), t2 = await mkTask(sa, saH, "BA-t2");
    const c1 = await mkComp(sa, saH, "BA-c1"), c2 = await mkComp(sa, saH, "BA-c2");
    const r = await sa.post("/api/admin/tasks/assign-competitions", { headers: saH, data: { taskIds: [t1, t2], competitionIds: [c1, c2] } });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.assigned, "2 tasks × 2 comps = 4 assignments").toBe(4);
    for (const c of [c1, c2]) for (const t of [t1, t2]) expect(isAssigned(c, t)).toBe(true);
    await sa.dispose();
  });

  test("idempotent — re-assigning already-assigned pairs adds 0", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const saH = H(csrf);
    const t1 = await mkTask(sa, saH, "BA-idem"); const c1 = await mkComp(sa, saH, "BA-idem-c");
    expect((await (await sa.post("/api/admin/tasks/assign-competitions", { headers: saH, data: { taskIds: [t1], competitionIds: [c1] } })).json()).assigned).toBe(1);
    expect((await (await sa.post("/api/admin/tasks/assign-competitions", { headers: saH, data: { taskIds: [t1], competitionIds: [c1] } })).json()).assigned).toBe(0);
    expect(compTaskCount(c1)).toBe(1);
    await sa.dispose();
  });

  test("best-effort: skips draft tasks, ended competitions, and missing ids", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const saH = H(csrf);
    const pub = await mkTask(sa, saH, "BA-pub");
    const draft = await mkTask(sa, saH, "BA-draft", "draft");
    const live = await mkComp(sa, saH, "BA-live", -60_000);        // started 1m ago → live
    const ended = await mkComp(sa, saH, "BA-ended", -5 * 3600_000); // start -5h, dur 120 → ended
    const r = await sa.post("/api/admin/tasks/assign-competitions", { headers: saH, data: { taskIds: [pub, draft, "no-such-task"], competitionIds: [live, ended, "no-such-comp"] } });
    const d = await r.json();
    expect(d.assigned, "only published-task × live-comp lands").toBe(1);
    expect(isAssigned(live, pub)).toBe(true);
    expect(isAssigned(ended, pub), "ended comp is skipped").toBe(false);
    expect(isAssigned(live, draft), "draft task is skipped").toBe(false);
    expect(d.skipped.draft).toBe(1);
    expect(d.skipped.notFound).toBe(1);
    expect(d.skipped.endedComp).toBe(1);
    expect(d.skipped.missingComp).toBe(1);
    await sa.dispose();
  });

  test("locked tasks: skipped for a regular admin, assigned by a superadmin", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const saH = H(csrf);
    const locked = await mkTask(sa, saH, "BA-locked");
    await sa.post(`/api/admin/tasks/${locked}/lock`, { headers: saH }); // toggle → locked
    const c1 = await mkComp(sa, saH, "BA-locked-c");
    // Regular admin → the locked task is skipped, nothing assigned.
    const { api: adm, csrf: ac } = await mkAdmin(sa, saH);
    const dReg = await (await adm.post("/api/admin/tasks/assign-competitions", { headers: H(ac), data: { taskIds: [locked], competitionIds: [c1] } })).json();
    await adm.dispose();
    expect(dReg.assigned, "regular admin can't assign a locked task").toBe(0);
    expect(dReg.skipped.locked).toBe(1);
    expect(isAssigned(c1, locked)).toBe(false);
    // Superadmin → assigns (can also unlock, so the lock isn't a barrier).
    const dSuper = await (await sa.post("/api/admin/tasks/assign-competitions", { headers: saH, data: { taskIds: [locked], competitionIds: [c1] } })).json();
    expect(dSuper.assigned).toBe(1);
    expect(isAssigned(c1, locked)).toBe(true);
    await sa.dispose();
  });

  test("validation: empty/absent taskIds or competitionIds → 400", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const saH = H(csrf);
    const t1 = await mkTask(sa, saH, "BA-val"); const c1 = await mkComp(sa, saH, "BA-val-c");
    expect((await sa.post("/api/admin/tasks/assign-competitions", { headers: saH, data: { taskIds: [], competitionIds: [c1] } })).status()).toBe(400);
    expect((await sa.post("/api/admin/tasks/assign-competitions", { headers: saH, data: { taskIds: [t1], competitionIds: [] } })).status()).toBe(400);
    expect((await sa.post("/api/admin/tasks/assign-competitions", { headers: saH, data: { taskIds: [t1] } })).status()).toBe(400);
    await sa.dispose();
  });

  test("v7.12.3 (audit #9): an over-cap taskIds/competitionIds array is rejected with 400 (BULK_ADMIN_MAX)", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const saH = H(csrf);
    const t1 = await mkTask(sa, saH, "BA-cap"); const c1 = await mkComp(sa, saH, "BA-cap-c");
    const bigTasks = Array.from({ length: 1001 }, (_, i) => `bt-${i}`);
    const bigComps = Array.from({ length: 1001 }, (_, i) => `bc-${i}`);
    expect((await sa.post("/api/admin/tasks/assign-competitions", { headers: saH, data: { taskIds: bigTasks, competitionIds: [c1] } })).status(), "1001 task ids → 400").toBe(400);
    expect((await sa.post("/api/admin/tasks/assign-competitions", { headers: saH, data: { taskIds: [t1], competitionIds: bigComps } })).status(), "1001 comp ids → 400").toBe(400);
    // Exactly 1000 (mostly-missing ids) is UNDER the cap → best-effort 200, not 400.
    const ok = await sa.post("/api/admin/tasks/assign-competitions", { headers: saH, data: { taskIds: [t1, ...Array.from({ length: 999 }, (_, i) => `bx-${i}`)], competitionIds: [c1] } });
    expect(ok.status(), "1000 task ids is under the cap → 200").toBe(200);
    expect((await ok.json()).assigned, "only the one real task lands").toBe(1);
    await sa.dispose();
  });

  test("emits a task_added (via:bulk) audit event per newly-assigned competition", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const saH = H(csrf);
    const t1 = await mkTask(sa, saH, "BA-audit"); const c1 = await mkComp(sa, saH, "BA-audit-c");
    await sa.post("/api/admin/tasks/assign-competitions", { headers: saH, data: { taskIds: [t1], competitionIds: [c1] } });
    const db = new Database(TEST_DB_PATH, { readonly: true });
    let hits; try { hits = db.prepare("SELECT COUNT(*) c FROM competition_events WHERE competition_id=? AND event_type='task_added' AND details LIKE '%\"via\":\"bulk\"%'").get(c1).c; } finally { db.close(); }
    expect(hits).toBeGreaterThan(0);
    await sa.dispose();
  });

  test("best-effort: a non-scalar array element is skipped, never a 500 (ext-audit batch-7 invariant)", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const saH = H(csrf);
    const pub = await mkTask(sa, saH, "BA-scalar"); const live = await mkComp(sa, saH, "BA-scalar-c", -60_000);
    // Object / array elements would throw on the SQL bind → the batch must NOT 500.
    const r = await sa.post("/api/admin/tasks/assign-competitions", { headers: saH, data: { taskIds: [pub, {}, [1]], competitionIds: [live, { bad: true }] } });
    expect(r.status(), "non-scalar element must be skipped, not a 500").toBe(200);
    const d = await r.json();
    expect(d.assigned, "the one valid pair still lands").toBe(1);
    expect(isAssigned(live, pub)).toBe(true);
    expect(d.skipped.notFound).toBe(2);     // {} and [1]
    expect(d.skipped.missingComp).toBe(1);  // { bad:true }
    await sa.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v8.3.34 (external audit) — AN EMPTY `.maintenance` SENTINEL
//
// `_maintenanceToken()` answered two different questions with one value: it
// returned `""` for an EMPTY file and `null` for a missing one, both falsy. So
// the traffic gate and /readyz (which asked for the CONTENT) said "not in
// maintenance" while both perf-seed guards (which asked `fs.statSync`, i.e.
// EXISTENCE) said it WAS — and `touch $DATA_DIR/.maintenance` is exactly what
// the perf endpoint's own 403 tells an operator to do. The result was a live
// public site, a load balancer told the box was ready, a boot banner reading
// `maintenance=ON`, and `bulk-seed-users` / `bulk-seed-history` unlocked.
//
// Every pre-existing maintenance test writes a NON-EMPTY token, so all of them
// exercise `{active:true, token:<x>}` and are behaviourally unchanged by the
// fix — which is why the case this closes would otherwise ship unlocked in
// BOTH directions.
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.3.34 — the maintenance sentinel: existence is the mode, content is the token", () => {
  const fs = require("fs");
  const path = require("path");
  const maintFile = path.join(TEST_DATA_DIR, ".maintenance");

  test.afterEach(() => { try { fs.unlinkSync(maintFile); } catch (_) {} });

  test("an EMPTY sentinel engages maintenance on every surface, and no header can bypass it", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const saH = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    try {
      // PRECONDITION — the platform is serving normally before we touch anything.
      // Without this the assertions below are equally satisfied by a box that was
      // already 503ing for an unrelated reason.
      expect((await sa.get("/api/config")).status(), "precondition: serving before the sentinel exists").toBe(200);
      expect((await sa.get("/readyz")).status(), "precondition: ready before the sentinel exists").toBe(200);

      fs.writeFileSync(maintFile, "");

      // 1. The traffic gate. Pre-fix this returned 200 — the whole finding.
      const cfg = await sa.get("/api/config");
      expect(cfg.status(), "an empty sentinel 503s public traffic").toBe(503);

      // 2. Readiness agrees, so a load balancer stops sending traffic.
      const rz = await sa.get("/readyz");
      expect(rz.status(), "/readyz reports the outage").toBe(503);
      expect((await rz.json()).reason).toBe("maintenance");

      // 3. THE NON-OBVIOUS ONE, and the reason `token.length > 0` is mandatory
      //    rather than belt-and-braces: `timingSafeEqual` of two EMPTY buffers
      //    returns true, and an empty header value arrives as "" and passes the
      //    `typeof header === "string"` guard. Without that clause, making an
      //    empty sentinel "active" would hand every caller a one-line bypass —
      //    strictly worse than the defect being fixed.
      const byp = await sa.get("/api/config", { headers: { "x-maintenance-bypass": "" } });
      expect(byp.status(), "an EMPTY bypass header must not satisfy an EMPTY token").toBe(503);
      const byp2 = await sa.get("/api/config", { headers: { "x-maintenance-bypass": "anything" } });
      expect(byp2.status(), "nor any other header — an empty sentinel has NO bypass").toBe(503);

      // 4. The perf seeder — the capability the empty sentinel used to unlock.
      //    It is now unreachable over HTTP, refused by the gate before its own
      //    guard is even consulted.
      const seed = await sa.post("/api/admin/perf/bulk-seed-users", {
        headers: saH,
        data: { users: [{ firstName: "X", lastName: "Y", nickname: `es${Date.now().toString(36)}`, email: `es-${Date.now().toString(36)}@example.com` }], sharedPassword: "testpass123" },
      });
      expect(seed.status(), "bulk-seed is not reachable behind an engaged gate").toBe(503);
    } finally { await sa.dispose(); }
  });

  test("CONTROL — a sentinel WITH a token still serves the bypass, and removing it restores service", async () => {
    // Without this the test above is satisfied by a build that 503s whenever the
    // file exists at all and has lost the bypass mechanism entirely — which is
    // what the perf tooling depends on.
    const { api: sa } = await apiLogin("superadmin");
    try {
      const byp = `tok-${Date.now().toString(36)}`;
      fs.writeFileSync(maintFile, byp);
      expect((await sa.get("/api/config")).status(), "no header → gated").toBe(503);
      expect((await sa.get("/api/config", { headers: { "x-maintenance-bypass": byp } })).status(),
        "the correct token still passes").toBe(200);
      expect((await sa.get("/api/config", { headers: { "x-maintenance-bypass": byp + "x" } })).status(),
        "a wrong token does not").toBe(503);
      fs.unlinkSync(maintFile);
      expect((await sa.get("/api/config")).status(), "removing the sentinel restores service").toBe(200);
    } finally { await sa.dispose(); }
  });
});
