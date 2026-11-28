// @ts-check
/**
 * Timeslot feature tests — exercises timeslot CRUD, participant selection,
 * locking, leaderboard modes, and answer reveal timing.
 */
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, PARTICIPANT_PASS, TEST_DB_PATH, gradingHashFor} = require("./helpers");

const S = { ready: false };

async function ensureState() {
  if (S.ready) return;
  const { api } = await apiLogin("superadmin");
  const comps = await (await api.get("/api/admin/competitions")).json();
  S.liveComp = comps.find(c => c.name === "Test Live");
  S.upcomingComp = comps.find(c => c.name === "Test Upcoming");
  const parts = (await (await api.get("/api/admin/participants?limit=200")).json()).participants;
  S.alice = parts.find(p => p.email === "alice@acme.com");
  S.bob = parts.find(p => p.email === "bob@acme.com");
  S.carol = parts.find(p => p.email === "carol@acme.com");
  await api.dispose();
  S.ready = true;
}

function h(csrf) { return { "x-csrf-token": csrf, "content-type": "application/json" }; }

// ── Fixture helpers for the multi-session locks below ─────────────────────────
// These build PURPOSE-BUILT participants rather than reusing the shared
// alice/bob/carol pool. Earlier tests in this file tag those users `staff` /
// `benchmark` (and untag them again in cleanup); a leaked tag silently removes a
// user from every leaderboard AND from the all-solved auto-end participant scan,
// which would make the locks below pass for the wrong reason.
let _freshSeq = 0;
async function makeParticipant(api, H, label) {
  const uniq = `${Date.now().toString(36)}${(_freshSeq++).toString(36)}`;
  const email = `tsl-${label}-${uniq}@acme.com`;
  const nickname = `tsl_${label}_${uniq}`;
  await registerPost(api, "/api/register", { headers: H, data: {
    firstName: "Slot", lastName: "Tester", nickname, email,
    company: "Acme", title: "Engineer", avatar: "🦊",
    country: "US", timezone: "America/New_York",
    jobFunction: "Software Developer / Engineer", city: "New York",
  }});
  const all = await (await api.get("/api/admin/participants?limit=1000")).json();
  const u = (all.participants || []).find(p => p.email === email);
  if (!u) throw new Error(`could not register ${email}`);
  if (!u.verified) await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H });
  if (!u.approved) await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H });
  return { id: u.id, email, nickname };
}

// Creates a published challenge and (optionally) attaches it to a competition.
async function makePublishedTask(api, H, title, answer, compId) {
  const r = await api.post("/api/admin/tasks", { headers: H, data: {
    title, description: "<p>x</p>", difficulty: "easy",
    answer_type: "text", correct_answer: answer, status: "published",
  }});
  const id = (await r.json()).id;
  if (!id) throw new Error(`could not create task ${title}`);
  if (compId) {
    const a = await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H, data: { competitionIds: [compId] } });
    if (!a.ok()) throw new Error(`could not assign task ${title}: ${a.status()} ${await a.text()}`);
    // The question the event holds: its own copy (lib/event-copies.js).
    return (await a.json()).copies[0].task_id;
  }
  return id;
}

// Logs a participant in, enters `slotId`, optionally submits `answer` to
// `taskId`, and RETURNS the live context so the caller can keep reading from the
// same session (a second apiLogin for the same user would evict the first).
async function enterSlot(email, compId, slotId, taskId, answer) {
  const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
  const sc = await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: compId } });
  expect(sc.ok(), `select-competition failed for ${email}: ${await sc.text()}`).toBeTruthy();
  const st = await api.post("/api/select-timeslot", { headers: h(csrf), data: { timeslotId: slotId, confirmLive: true } });
  expect(st.ok(), `select-timeslot failed for ${email}: ${await st.text()}`).toBeTruthy();
  if (taskId) {
    const sub = await api.post(`/api/tasks/${taskId}/submit`, { headers: h(csrf), data: { answer , gradingHash: await gradingHashFor(api, taskId)} });
    expect(sub.ok(), `submit failed for ${email}: ${await sub.text()}`).toBeTruthy();
    expect((await sub.json()).correct, "the fixture submission must grade CORRECT").toBe(true);
  }
  return { api, csrf };
}

// Ends + deletes a competition (delete refuses while it is live) and then the
// challenges it used (task delete refuses while assigned to an ended comp).
async function dropComp(compId, taskIds = []) {
  const { api, csrf } = await apiLogin("superadmin");
  await api.post(`/api/admin/competitions/${compId}/end-now`, { headers: h(csrf) });
  await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } });
  for (const tid of taskIds) await api.delete(`/api/admin/tasks/${tid}`, { headers: { "x-csrf-token": csrf } });
  await api.dispose();
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIMESLOT CRUD
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Backward compatibility", () => {
  test("my-competitions returns timeslots array", async () => {
    // v7.21.40 — OWNS ITS PARTICIPANT. This authenticated as the shared seeded
    // `alice` and went flaky with `401 Invalid email or password`: this file
    // mutates the alice/bob/carol pool (its own header comment says so), so
    // whether alice is still usable depends on which tests precede this one.
    // The assertion is about the SHAPE of /api/my-competitions — every entry
    // carries a timeslots array — and does not care whose competitions they
    // are, so a freshly registered participant serves it exactly as well and
    // cannot be poisoned by a sibling. (apiLogin now reports the account's
    // lifecycle state on a 401, so if this ever fails again it will say why.)
    await ensureState();
    const { api: sa0, csrf: sa0c } = await apiLogin("superadmin");
    const mine = await makeParticipant(sa0, h(sa0c), "mycomps");
    // Assign it to the same two competitions the assertions below name, so the
    // fresh participant sees exactly what the shared alice saw. S.tsCompId is
    // the multi-slot competition built by the Timeslot CRUD block; when this
    // test runs alone that is undefined and the tsComp assertions are skipped,
    // which is why the sweep never flagged it as order-dependent.
    const wanted = [S.liveComp.id, S.tsCompId].filter(Boolean);
    await sa0.post("/api/admin/competitions/assign", {
      headers: h(sa0c), data: { userIds: [mine.id], competitionIds: wanted },
    });
    await sa0.dispose();
    const { api } = await apiLogin(mine.email, PARTICIPANT_PASS);
    const comps = await (await api.get("/api/my-competitions")).json();
    // Every competition should have a timeslots array
    for (const c of comps) {
      expect(Array.isArray(c.timeslots)).toBe(true);
    }
    // Single-slot competition (Test Live) should have empty timeslots
    const live = comps.find(c => c.name === "Test Live");
    expect(live.timeslots.length).toBe(0);
    // Multi-slot competition (created in Timeslot CRUD) should have timeslots with correct structure
    const tsComp = comps.find(c => c.id === S.tsCompId);
    if (tsComp) {
      expect(tsComp.timeslots.length).toBeGreaterThan(0);
      for (const ts of tsComp.timeslots) {
        expect(ts.id).toBeTruthy();
        expect(ts.name).toBeTruthy();
        expect(ts.start_time).toBeTruthy();
        expect(typeof ts.duration_minutes).toBe("number");
      }
    }
    await api.dispose();
  });

  // v7.22.0 — owns its participant, for the same reason as the test below.
  //
  // Observed once at WORKERS=12: `Login failed for alice@acme.com: 401` with the
  // v7.21.40 diagnostic reporting a perfectly healthy account
  // (blocked=0 approved=1 verified=1 denied_at=null locked_until=null), which
  // rules out every lifecycle cause and leaves the credential itself. NO
  // mechanism is claimed — nothing in this file re-passwords alice, and it did
  // not reproduce — so this closes the KNOWN-fragile shape rather than a
  // theorised one: `alice` is a shared seeded fixture that lifecycle tests
  // across the suite block, lock and re-password (v7.15.32), and this test never
  // needed HER, only *a* participant enrolled in the single-slot competition.
  // Every assertion keeps its full strength.
  test("single-slot competition works as before", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const mine = await makeParticipant(sa, h(saCsrf), "singleslot");
    const asg = await sa.post("/api/admin/competitions/assign", {
      headers: h(saCsrf), data: { userIds: [mine.id], competitionIds: [S.liveComp.id] },
    });
    expect(asg.ok(), `assign participant: ${asg.status()}`).toBeTruthy();
    await sa.dispose();

    const { api, csrf } = await apiLogin(mine.email, PARTICIPANT_PASS);
    // Select the live competition (no timeslots)
    const r = await api.post("/api/select-competition", {
      headers: h(csrf), data: { competitionId: S.liveComp.id },
    });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.timeslots.length).toBe(0);
    expect(d.needsTimeslotChoice).toBeFalsy();
    // Tasks still work
    const tasks = await (await api.get("/api/tasks")).json();
    expect(tasks.length).toBeGreaterThan(0);
    // Leaderboard still works
    const lb = await (await api.get("/api/leaderboard")).json();
    expect(lb.board.length).toBeGreaterThan(0);
    await api.dispose();
  });

  // v7.15.32 — uses its OWN participant rather than the shared alice.
  //
  // `ended_popup_seen` is per (user, competition) and DURABLE, and the very
  // next test dismisses it for alice on this same competition. So this test
  // asserting `false` was order-dependent: it passed on a clean DB and failed
  // on any second pass over the file (reproduced with --repeat-each=3 → 2
  // failures). That is a latent trap rather than a cosmetic one — it makes the
  // file un-rerunnable and would fail for real if the two tests were ever
  // reordered or this one retried after the other had run.
  //
  // A participant created here cannot have dismissed anything, so the
  // assertion keeps its full strength and stops depending on execution order.
  test("status endpoint returns timeslot-aware data and ended_popup_seen", async () => {
    await ensureState();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const fresh = await makeParticipant(sa, h(saCsrf), "popup");
    const asg = await sa.post("/api/admin/competitions/assign", {
      headers: h(saCsrf), data: { userIds: [fresh.id], competitionIds: [S.liveComp.id] },
    });
    expect(asg.ok(), `assign fresh participant: ${asg.status()}`).toBeTruthy();
    await sa.dispose();

    const { api, csrf } = await apiLogin(fresh.email, PARTICIPANT_PASS);
    const sc = await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: S.liveComp.id } });
    expect(sc.ok(), `select-competition: ${await sc.text()}`).toBeTruthy();
    const status = await (await api.get("/api/status")).json();
    expect(status.status).toBeTruthy();
    expect(status.competition_fully_ended).toBeDefined();
    expect(status.timeslot_name).toBeNull(); // single-slot, no timeslot
    expect(status.ended_popup_seen, "a participant who has never dismissed sees false").toBe(false);
    await api.dispose();
  });

  test("dismiss-ended persists across sessions", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: S.liveComp.id } });
    // Dismiss
    const r = await api.post("/api/dismiss-ended", { headers: h(csrf) });
    expect(r.ok()).toBeTruthy();
    // Verify it persists
    const status = await (await api.get("/api/status")).json();
    expect(status.ended_popup_seen).toBe(true);
    await api.dispose();
    // Verify with a fresh login
    const { api: api2 } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const comps2 = await (await api2.get("/api/my-competitions")).json();
    const live2 = comps2.find(c => c.name === "Test Live");
    if (live2) {
      const { api: api3, csrf: csrf3 } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
      await api3.post("/api/select-competition", { headers: h(csrf3), data: { competitionId: live2.id } });
      const status2 = await (await api3.get("/api/status")).json();
      expect(status2.ended_popup_seen).toBe(true);
      await api3.dispose();
    }
    await api2.dispose();
  });

  test("task detail returns competition_fully_ended flag", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: S.liveComp.id } });
    const tasks = await (await api.get("/api/tasks")).json();
    if (tasks.length > 0) {
      const detail = await (await api.get(`/api/tasks/${tasks[0].id}`)).json();
      expect(detail).toHaveProperty("competition_fully_ended");
    }
    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STAFF vs BENCHMARK BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Staff vs benchmark behavior", () => {
  // Tests use carol for staff (tagged/untagged per-test) and bob for benchmark
  test("staff user skipped during competition assignment", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    // Tag carol as staff
    const parts = await (await api.get("/api/admin/participants?limit=200")).json();
    const carol = (parts.participants || []).find(p => p.email === "carol@acme.com");
    S.carol = carol;
    await api.post(`/api/admin/participants/${carol.id}/tags`, { headers: h(csrf), data: { tag: "staff" } });
    try {
      // Try to assign carol — should be skipped
      const r = await api.post("/api/admin/competitions/assign", { headers: h(csrf), data: {
        userIds: [carol.id], competitionIds: [S.upcomingComp.id],
      }});
      const d = await r.json();
      expect(r.ok()).toBeTruthy();
      expect(d.assigned).toBe(0);
      expect(d.skippedStaff).toBe(1);
    } finally {
      // In a finally because a leaked `staff` tag removes carol from every later
      // leaderboard and from the all-solved participant scan — the tests below
      // would then pass for the wrong reason rather than fail.
      await api.delete(`/api/admin/participants/${carol.id}/tags/staff`, { headers: { "x-csrf-token": csrf } });
      await api.dispose();
    }
  });

  test("benchmark user CAN be assigned to competition", async () => {
    // v8.12.4 — a participant of its OWN, not the seeded bob. The seed already
    // enrols bob in "Test Upcoming", so the assign took the already-a-member
    // path and `skippedStaff: 0` held whether or not a benchmark user is
    // skipped: the test could not fail on its subject. It also flaked once in
    // CI with a bare non-2xx (no mechanism claimed — the body was not captured,
    // which is why every call here now reports it).
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const u = await makeParticipant(api, h(csrf), "bench");
      const tag = await api.post(`/api/admin/participants/${u.id}/tags`, { headers: h(csrf), data: { tag: "benchmark" } });
      expect(tag.ok(), `tag benchmark: ${tag.status()} ${await tag.text()}`).toBeTruthy();
      const r = await api.post("/api/admin/competitions/assign", { headers: h(csrf), data: {
        userIds: [u.id], competitionIds: [S.upcomingComp.id],
      }});
      const body = await r.text();
      expect(r.ok(), `assign: ${r.status()} ${body}`).toBeTruthy();
      const d = JSON.parse(body);
      expect(d.assigned, `a benchmark user is ENROLLED, not skipped: ${body}`).toBe(1);
      expect(d.skippedStaff).toBe(0);
    } finally {
      await api.dispose();
    }
  });

  test("staff user can join any competition without assignment", async () => {
    await ensureState();
    // Carol is neither staff nor assigned to upcoming — tag her as staff for this test
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const parts = await (await sa.get("/api/admin/participants?limit=200")).json();
    const carol = (parts.participants || []).find(p => p.email === "carol@acme.com");
    await sa.post(`/api/admin/participants/${carol.id}/tags`, { headers: h(saCsrf), data: { tag: "staff" } });
    await sa.dispose();

    // Opened BEFORE the try so the finally always has an admin context to untag
    // carol with: a leaked `staff` tag removes her from every later leaderboard
    // and from the all-solved participant scan.
    const { api: admin, csrf: adminCsrf } = await apiLogin("superadmin");
    try {
      const { api, csrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      // Carol (staff) should be able to select the upcoming competition even though not assigned
      const r = await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: S.upcomingComp.id } });
      expect(r.ok()).toBeTruthy();
      await api.dispose();

      // Verify she's NOT in competition_users for that competition
      const parts2 = await (await admin.get(`/api/admin/participants?competitionId=${S.upcomingComp.id}&limit=200`)).json();
      const carolInList = (parts2.participants || []).find(p => p.id === carol.id);
      expect(carolInList).toBeFalsy();
    } finally {
      // Cleanup: remove staff tag from carol
      await admin.delete(`/api/admin/participants/${carol.id}/tags/staff`, { headers: { "x-csrf-token": adminCsrf } });
      await admin.dispose();
    }
  });

  test("staff can switch timeslots freely without lock", async () => {
    await ensureState();
    const { api: admin, csrf: adminCsrf } = await apiLogin("superadmin");
    // Tag carol as staff for this test
    await admin.post(`/api/admin/participants/${S.carol.id}/tags`, { headers: h(adminCsrf), data: { tag: "staff" } });
    let compId;
    try {
      // Create a live multi-slot competition
      const now = Date.now();
      let r = await admin.post("/api/admin/competitions", { headers: h(adminCsrf), data: {
        name: `Staff Switch ${now}`, start_time: new Date(now - 60_000).toISOString(), duration_minutes: 240,
      }});
      compId = (await r.json()).competition?.id;
      r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(adminCsrf), data: {
        name: "Slot A", start_time: new Date(now - 60_000).toISOString(), duration_minutes: 120,
      }});
      const slotA = (await r.json()).timeslot?.id;
      r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(adminCsrf), data: {
        name: "Slot B", start_time: new Date(now - 30_000).toISOString(), duration_minutes: 120,
      }});
      const slotB = (await r.json()).timeslot?.id;

      // Carol (staff) selects competition and slot A
      const { api: carol, csrf: carolCsrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      await carol.post("/api/select-competition", { headers: h(carolCsrf), data: { competitionId: compId } });
      r = await carol.post("/api/select-timeslot", { headers: h(carolCsrf), data: { timeslotId: slotA, confirmLive: true } });
      expect(r.ok()).toBeTruthy();
      // Switch to slot B — should succeed for staff
      r = await carol.post("/api/select-timeslot", { headers: h(carolCsrf), data: { timeslotId: slotB, confirmLive: true } });
      expect(r.ok()).toBeTruthy();
      await carol.dispose();
    } finally {
      // In a finally because either select above can fail: carol would then keep
      // the `staff` tag, which removes her from every later leaderboard and from
      // the all-solved participant scan.
      if (compId) await admin.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": adminCsrf } });
      await admin.delete(`/api/admin/participants/${S.carol.id}/tags/staff`, { headers: { "x-csrf-token": adminCsrf } });
      await admin.dispose();
    }
  });

  test("promoting to admin auto-adds staff tag", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    // Promote carol to admin
    const parts = await (await api.get("/api/admin/participants?limit=200")).json();
    const carol = (parts.participants || []).find(p => p.email === "carol@acme.com");
    if (carol) {
      const r = await api.post(`/api/admin/participants/${carol.id}/role`, { headers: h(csrf), data: { role: "admin" } });
      try {
        const d = await r.json();
        expect(r.ok()).toBeTruthy();
        expect(d.tags).toContain("staff");
        // Demote back — staff tag should be removed
        const r2 = await api.post(`/api/admin/participants/${carol.id}/role`, { headers: h(csrf), data: { role: "participant" } });
        const d2 = await r2.json();
        expect(d2.tags).not.toContain("staff");
      } finally {
        // Either assertion above can fire before the demote runs, leaving carol
        // an admin carrying the auto `staff` tag for the rest of the file. The
        // seed role is re-posted rather than read back, and posting a role the
        // user already holds is accepted, so the happy path is unaffected.
        await api.post(`/api/admin/participants/${carol.id}/role`, { headers: h(csrf), data: { role: "participant" } });
      }
    }
    await api.dispose();
  });

  test("cannot remove staff tag from admin/superadmin", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    // Promote carol to admin (which auto-adds staff tag)
    await api.post(`/api/admin/participants/${S.carol.id}/role`, { headers: h(csrf), data: { role: "admin" } });
    try {
      // Try removing staff tag — should fail
      const r = await api.delete(`/api/admin/participants/${S.carol.id}/tags/staff`, { headers: { "x-csrf-token": csrf } });
      expect(r.ok()).toBeFalsy();
      expect((await r.json()).error).toContain("Demote");
    } finally {
      // Cleanup: demote carol back (auto-removes staff tag). In a finally
      // because a refusal that does NOT come leaves her an admin with the staff
      // tag, and every later test that signs in as carol or expects her on a
      // board fails instead.
      await api.post(`/api/admin/participants/${S.carol.id}/role`, { headers: h(csrf), data: { role: "participant" } });
      await api.dispose();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-SLOT ANSWER-REVEAL GATE (v6.7.0)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Multi-slot answer reveal gate", () => {
  // A competition with two live timeslots must keep correct_answer +
  // explanation hidden from every slot's GET /api/tasks/:id response until
  // ALL slots have ended. Otherwise a participant whose slot has just ended
  // could read the answer and share it with a later slot that is still live.
  test("correct_answer + explanation hidden while any slot is live; revealed once all end", async () => {
    await ensureState();
    const { api: admin, csrf: adminCsrf } = await apiLogin("superadmin");
    const now = Date.now();

    // v6.16.0 — default for new competitions is reveal_answers_on_end=false.
    // This test was originally written when reveal-on-end was hardcoded to
    // true; it still asserts the "answers revealed once every slot ends"
    // contract, so opt the test comp INTO the new flag.
    let r = await admin.post("/api/admin/competitions", { headers: h(adminCsrf), data: {
      name: `Reveal Gate ${now}`, start_time: new Date(now - 60_000).toISOString(), duration_minutes: 60,
      reveal_answers_on_end: true,
    }});
    const compId = (await r.json()).competition?.id;

    r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(adminCsrf), data: {
      name: "Slot A", start_time: new Date(now - 60_000).toISOString(), duration_minutes: 60,
    }});
    const slotA = (await r.json()).timeslot?.id;
    r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(adminCsrf), data: {
      name: "Slot B", start_time: new Date(now - 30_000).toISOString(), duration_minutes: 60,
    }});
    const slotB = (await r.json()).timeslot?.id;

    r = await admin.post("/api/admin/tasks", { headers: h(adminCsrf), data: {
      title: `Reveal Gate Task ${now}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "text", correct_answer: "secret-answer",
      explanation: "<p>the explanation</p>", status: "published",
    }});
    const taskId = (await r.json()).id;
    await admin.post(`/api/admin/tasks/${taskId}/competitions`, { headers: h(adminCsrf), data: { competitionIds: [compId] }});

    // v7.22.7 — own participant + asserted preconditions (see the leaderboard
    // tests below: assign SKIPS staff/benchmark, so a borrowed fixture can be
    // silently un-enrolled and every later read is meaningless).
    const revealP = await makeParticipant(admin, h(adminCsrf), "reveal");
    const revealAsg = await admin.post("/api/admin/competitions/assign", { headers: h(adminCsrf), data: {
      userIds: [revealP.id], competitionIds: [compId],
    }});
    expect(revealAsg.ok(), `assign: ${revealAsg.status()} ${await revealAsg.text()}`).toBeTruthy();
    expect((await revealAsg.json().catch(() => ({}))).assigned, "the assign must enrol the participant").toBe(1);
    await admin.dispose();

    // …enters slot A
    const { api: alice, csrf: aliceCsrf } = await apiLogin(revealP.email, PARTICIPANT_PASS);
    const rsc = await alice.post("/api/select-competition", { headers: h(aliceCsrf), data: { competitionId: compId } });
    expect(rsc.ok(), `select-competition: ${rsc.status()} ${await rsc.text()}`).toBeTruthy();
    const rst = await alice.post("/api/select-timeslot", { headers: h(aliceCsrf), data: { timeslotId: slotA, confirmLive: true } });
    expect(rst.ok(), `select-timeslot: ${rst.status()} ${await rst.text()}`).toBeTruthy();

    // Both slots LIVE — answer/explanation MUST be hidden
    let t = await (await alice.get(`/api/tasks/${taskId}`)).json();
    expect(t.competition_fully_ended).toBe(false);
    expect(t.correct_answer).toBeUndefined();
    expect(t.explanation).toBeUndefined();

    // End only slot A — slot B still live, still hide
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    await sa.post(`/api/admin/competitions/${compId}/timeslots/${slotA}/end-now`, { headers: h(saCsrf) });
    t = await (await alice.get(`/api/tasks/${taskId}`)).json();
    expect(t.competition_fully_ended).toBe(false);
    expect(t.correct_answer).toBeUndefined();
    expect(t.explanation).toBeUndefined();

    // End slot B — now fully ended, reveal
    await sa.post(`/api/admin/competitions/${compId}/timeslots/${slotB}/end-now`, { headers: h(saCsrf) });
    t = await (await alice.get(`/api/tasks/${taskId}`)).json();
    expect(t.competition_fully_ended).toBe(true);
    expect(t.correct_answer).toBe("secret-answer");
    expect(t.explanation).toContain("the explanation");

    // Cleanup (comp delete cascades to competition_tasks; task has submissions=0 so deletable)
    await sa.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.delete(`/api/admin/tasks/${taskId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
    await alice.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Leaderboard mode: per_slot vs global separation (v6.8.2)
// ═══════════════════════════════════════════════════════════════════════════════
// When a multi-slot competition runs in `per_slot` mode, the admin
// leaderboard must return ONLY the participants of the queried slot.
// Switching the same competition to `global` mode must merge both slots'
// participants into one ranking. This was previously untested — only
// the mode-setter endpoint was verified, not the runtime behaviour it
// controls.
test.describe("Leaderboard mode — per_slot vs global", () => {
  test("per_slot mode scopes the admin leaderboard to the queried slot", async () => {
    await ensureState();
    const { api: admin, csrf: adminCsrf } = await apiLogin("superadmin");
    const now = Date.now();
    // Live multi-slot comp, per_slot mode — this is the default.
    let r = await admin.post("/api/admin/competitions", { headers: h(adminCsrf), data: {
      name: `PerSlot Ranking ${now}`,
      start_time: new Date(now - 60_000).toISOString(),
      duration_minutes: 240,
      leaderboard_mode: "per_slot",
    }});
    const compId = (await r.json()).competition?.id;
    r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(adminCsrf), data: {
      name: "Slot A", start_time: new Date(now - 60_000).toISOString(), duration_minutes: 120,
    }});
    const slotA = (await r.json()).timeslot?.id;
    r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(adminCsrf), data: {
      name: "Slot B", start_time: new Date(now - 30_000).toISOString(), duration_minutes: 120,
    }});
    const slotB = (await r.json()).timeslot?.id;

    // Attach one task so the participants have something to solve.
    r = await admin.post("/api/admin/tasks", { headers: h(adminCsrf), data: {
      title: `Slot Rank Task ${now}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "text", correct_answer: "slot-answer", status: "published",
    }});
    const taskId = (await r.json()).id;
    await admin.post(`/api/admin/tasks/${taskId}/competitions`, { headers: h(adminCsrf), data: { competitionIds: [compId] }});

    // v7.22.7 — OWNS ITS PARTICIPANTS, AND ASSERTS ITS PRECONDITIONS.
    //
    // It used the seeded alice and bob and checked NONE of the setup calls, so
    // every way the fixture can be unusable produced the same silent outcome: an
    // EMPTY board and `expect(idsA).toContain(alice)` failing with
    // `Received array: []`, which names nothing. The assign endpoint SKIPS a
    // staff or benchmark user (by design), and this very file tags carol staff
    // and bob benchmark a few tests earlier — so a leaked or 2-second-CACHED tag
    // silently un-enrols the participant and the board is empty for a reason the
    // failure never mentions. This is fixture-checklist item 4 biting in the
    // direction that fails rather than the one that passes vacuously.
    //
    // Own participants remove the exposure; asserting each call means a broken
    // precondition now fails AS a precondition.
    const mkP = async (label) => {
      const email = `perslot-${label}-${now}@company.co`;
      const { api: reg, csrf: regCsrf } = await freshCtx();
      const rr = await registerPost(reg, "/api/register", { headers: h(regCsrf), data: {
        firstName: "Slot", lastName: label, nickname: `perslot_${label}_${now}`, email,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        password: PARTICIPANT_PASS,
      }});
      expect(rr.ok(), `register ${label}: ${rr.status()} ${await rr.text()}`).toBeTruthy();
      await reg.dispose();
      const list = await (await admin.get("/api/admin/participants?limit=5000")).json();
      const u = (list.participants || []).find(x => x.email === email);
      expect(u, `participant ${email} must exist`).toBeTruthy();
      await admin.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": adminCsrf } });
      await admin.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": adminCsrf } });
      return { id: u.id, email };
    };
    const pA = await mkP("a");
    const pB = await mkP("b");

    const asg = await admin.post("/api/admin/competitions/assign", { headers: h(adminCsrf), data: {
      userIds: [pA.id, pB.id], competitionIds: [compId],
    }});
    expect(asg.ok(), `assign: ${asg.status()} ${await asg.text()}`).toBeTruthy();
    const asgBody = await asg.json().catch(() => ({}));
    expect(asgBody.assigned,
      `the assign enrolled nobody — the endpoint SKIPS staff/benchmark/blocked users, ` +
      `so the board would be empty for a reason this test never states. Response: ${JSON.stringify(asgBody)}`
    ).toBe(2);
    await admin.dispose();

    // A picks slot A, B picks slot B, each submits. Every call asserted.
    const act = async (p, slot) => {
      const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
      const sc = await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: compId }});
      expect(sc.ok(), `select-competition ${p.email}: ${sc.status()} ${await sc.text()}`).toBeTruthy();
      const st = await api.post("/api/select-timeslot", { headers: h(csrf), data: { timeslotId: slot, confirmLive: true }});
      expect(st.ok(), `select-timeslot ${p.email}: ${st.status()} ${await st.text()}`).toBeTruthy();
      const sub = await api.post(`/api/tasks/${taskId}/submit`, { headers: h(csrf), data: { answer: "slot-answer", gradingHash: await gradingHashFor(api, taskId) }});
      expect(sub.ok(), `submit ${p.email}: ${sub.status()} ${await sub.text()}`).toBeTruthy();
      await api.dispose();
    };
    await act(pA, slotA);
    await act(pB, slotB);

    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    // Slot-A leaderboard must contain Alice but NOT Bob, and vice-versa.
    const boardA = await (await sa.get(`/api/admin/leaderboard?competitionId=${compId}&timeslotId=${slotA}`)).json();
    const boardB = await (await sa.get(`/api/admin/leaderboard?competitionId=${compId}&timeslotId=${slotB}`)).json();
    const idsA = boardA.map(r => r.userId);
    const idsB = boardB.map(r => r.userId);
    expect(idsA, `slot-A board: ${JSON.stringify(idsA)}`).toContain(pA.id);
    expect(idsA).not.toContain(pB.id);
    expect(idsB, `slot-B board: ${JSON.stringify(idsB)}`).toContain(pB.id);
    expect(idsB).not.toContain(pA.id);

    // Cleanup
    await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: h(saCsrf) });
    await sa.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });

  test("global mode merges both slots' participants into one board", async () => {
    await ensureState();
    const { api: admin, csrf: adminCsrf } = await apiLogin("superadmin");
    const now = Date.now();
    let r = await admin.post("/api/admin/competitions", { headers: h(adminCsrf), data: {
      name: `Global Ranking ${now}`,
      start_time: new Date(now - 60_000).toISOString(),
      duration_minutes: 240,
      leaderboard_mode: "global",
    }});
    const compId = (await r.json()).competition?.id;
    r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(adminCsrf), data: {
      name: "Slot A", start_time: new Date(now - 60_000).toISOString(), duration_minutes: 120,
    }});
    const slotA = (await r.json()).timeslot?.id;
    r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(adminCsrf), data: {
      name: "Slot B", start_time: new Date(now - 30_000).toISOString(), duration_minutes: 120,
    }});
    const slotB = (await r.json()).timeslot?.id;
    r = await admin.post("/api/admin/tasks", { headers: h(adminCsrf), data: {
      title: `Global Rank Task ${now}`, description: "<p>x</p>", difficulty: "easy",
      answer_type: "text", correct_answer: "global-answer", status: "published",
    }});
    const taskId = (await r.json()).id;
    await admin.post(`/api/admin/tasks/${taskId}/competitions`, { headers: h(adminCsrf), data: { competitionIds: [compId] }});
    // v7.22.7 — own participants + asserted preconditions, same as its per_slot
    // sibling: the assign SKIPS a staff/benchmark user, and this file tags carol
    // staff and bob benchmark earlier, so a borrowed fixture can be silently
    // un-enrolled and the board comes back empty for a reason the failure never
    // states.
    const pA = await makeParticipant(admin, h(adminCsrf), "globa");
    const pB = await makeParticipant(admin, h(adminCsrf), "globb");
    const asg = await admin.post("/api/admin/competitions/assign", { headers: h(adminCsrf), data: {
      userIds: [pA.id, pB.id], competitionIds: [compId],
    }});
    expect(asg.ok(), `assign: ${asg.status()} ${await asg.text()}`).toBeTruthy();
    expect((await asg.json().catch(() => ({}))).assigned, "the assign must enrol BOTH participants").toBe(2);
    await admin.dispose();

    const actG = async (p, slot) => {
      const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
      const sc = await api.post("/api/select-competition", { headers: h(csrf), data: { competitionId: compId }});
      expect(sc.ok(), `select-competition ${p.email}: ${sc.status()} ${await sc.text()}`).toBeTruthy();
      const st = await api.post("/api/select-timeslot", { headers: h(csrf), data: { timeslotId: slot, confirmLive: true }});
      expect(st.ok(), `select-timeslot ${p.email}: ${st.status()} ${await st.text()}`).toBeTruthy();
      const sub = await api.post(`/api/tasks/${taskId}/submit`, { headers: h(csrf), data: { answer: "global-answer", gradingHash: await gradingHashFor(api, taskId) }});
      expect(sub.ok(), `submit ${p.email}: ${sub.status()} ${await sub.text()}`).toBeTruthy();
      await api.dispose();
    };
    await actG(pA, slotA);
    await actG(pB, slotB);

    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    // In global mode the comp's leaderboard merges BOTH slots — passing
    // a timeslotId should be ignored (since mode=global), returning the
    // full board each time.
    const board = await (await sa.get(`/api/admin/leaderboard?competitionId=${compId}`)).json();
    const ids = board.map(r => r.userId);
    expect(ids, `global board: ${JSON.stringify(ids)}`).toContain(pA.id);
    expect(ids, `global board: ${JSON.stringify(ids)}`).toContain(pB.id);

    await sa.post(`/api/admin/competitions/${compId}/end-now`, { headers: h(saCsrf) });
    await sa.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": saCsrf } });
    await sa.dispose();
  });

  // The two tests above both read the ADMIN board. The PARTICIPANT board's own
  // per_slot scoping — `routes/leaderboard.js` deriving tsId from
  // req.session.timeslotId — had NO coverage: every other /api/leaderboard test
  // in the suite runs against a single-slot competition, so nothing observed the
  // session's timeslot reaching buildLeaderboard. If that scoping is lost, an
  // afternoon-session participant reads the morning cohort's scores.
  test("per_slot scopes the PARTICIPANT leaderboard to the caller's own session", async () => {
    await ensureState();
    const { api: admin, csrf: adminCsrf } = await apiLogin("superadmin");
    const H = h(adminCsrf);
    const now = Date.now();
    let r = await admin.post("/api/admin/competitions", { headers: H, data: {
      name: `PerSlot Participant Board ${now}`,
      start_time: new Date(now - 60_000).toISOString(),
      duration_minutes: 240,
      leaderboard_mode: "per_slot",
    }});
    const compId = (await r.json()).competition?.id;
    expect(compId).toBeTruthy();
    r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: H, data: {
      name: "Slot A", start_time: new Date(now - 60_000).toISOString(), duration_minutes: 120,
    }});
    const slotA = (await r.json()).timeslot?.id;
    r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: H, data: {
      name: "Slot B", start_time: new Date(now - 30_000).toISOString(), duration_minutes: 120,
    }});
    const slotB = (await r.json()).timeslot?.id;
    expect(slotA && slotB).toBeTruthy();

    // TWO published challenges, one solve each: with a single challenge the sole
    // occupant of each slot would solve EVERYTHING and trip the per-timeslot
    // all-solved auto-end, so the fixture would no longer be the live competition
    // this behaviour is about.
    const taskIds = [
      await makePublishedTask(admin, H, `PerSlot Board Task 1 ${now}`, "ps-answer-1", compId),
      await makePublishedTask(admin, H, `PerSlot Board Task 2 ${now}`, "ps-answer-2", compId),
    ];

    const morning = await makeParticipant(admin, H, "psa");
    const afternoon = await makeParticipant(admin, H, "psb");
    const assign = await admin.post("/api/admin/competitions/assign", { headers: H, data: {
      userIds: [morning.id, afternoon.id], competitionIds: [compId],
    }});
    expect((await assign.json()).assigned, "both fixture participants must actually enroll").toBe(2);
    await admin.dispose();

    const afternoonCtx = await enterSlot(afternoon.email, compId, slotB, taskIds[0], "ps-answer-1");
    await afternoonCtx.api.dispose();
    const morningCtx = await enterSlot(morning.email, compId, slotA, taskIds[0], "ps-answer-1");

    // POSITIVE CONTROL: both participants really are on this competition's board —
    // the admin's unscoped read merges the sessions. Without this, "the other
    // cohort is absent" below could hold simply because nobody was ever there.
    const { api: sa } = await apiLogin("superadmin");
    const mergedIds = (await (await sa.get(`/api/admin/leaderboard?competitionId=${compId}`)).json()).map(x => x.userId);
    expect(mergedIds).toContain(morning.id);
    expect(mergedIds).toContain(afternoon.id);

    const lb = await (await morningCtx.api.get("/api/leaderboard")).json();
    const ids = lb.board.map(x => x.userId);
    expect(ids, "the caller's own session is on their board").toContain(morning.id);
    expect(ids, "the OTHER session's cohort must not leak onto the caller's board").not.toContain(afternoon.id);
    expect(lb.timeslot_id, "the participant board must be scoped to the caller's own session").toBe(slotA);
    await morningCtx.api.dispose();
    await sa.dispose();

    await dropComp(compId, taskIds);
  });

  // rankings-admin.js appends `&timeslotId=` whenever a session is focused in the
  // scope banner, whatever the competition's mode — so the mode gate at
  // routes/leaderboard.js is what keeps a GLOBAL-mode comp returning the merged
  // board. No test ever passed a timeslotId to a global-mode competition, so an
  // admin silently seeing half the field would not have been caught.
  test("global mode IGNORES an explicit timeslotId on the admin board", async () => {
    await ensureState();
    const { api: admin, csrf: adminCsrf } = await apiLogin("superadmin");
    const H = h(adminCsrf);
    const now = Date.now();
    let r = await admin.post("/api/admin/competitions", { headers: H, data: {
      name: `Global Ranking TsIgnored ${now}`,
      start_time: new Date(now - 60_000).toISOString(),
      duration_minutes: 240,
      leaderboard_mode: "global",
    }});
    const compId = (await r.json()).competition?.id;
    expect(compId).toBeTruthy();
    r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: H, data: {
      name: "Slot A", start_time: new Date(now - 60_000).toISOString(), duration_minutes: 120,
    }});
    const slotA = (await r.json()).timeslot?.id;
    r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: H, data: {
      name: "Slot B", start_time: new Date(now - 30_000).toISOString(), duration_minutes: 120,
    }});
    const slotB = (await r.json()).timeslot?.id;
    expect(slotA && slotB).toBeTruthy();

    const taskIds = [
      await makePublishedTask(admin, H, `Global TsIgnored Task 1 ${now}`, "gt-answer-1", compId),
      await makePublishedTask(admin, H, `Global TsIgnored Task 2 ${now}`, "gt-answer-2", compId),
    ];
    const inA = await makeParticipant(admin, H, "gta");
    const inB = await makeParticipant(admin, H, "gtb");
    const assign = await admin.post("/api/admin/competitions/assign", { headers: H, data: {
      userIds: [inA.id, inB.id], competitionIds: [compId],
    }});
    expect((await assign.json()).assigned).toBe(2);
    await admin.dispose();

    for (const [who, slot] of [[inA, slotA], [inB, slotB]]) {
      const ctx = await enterSlot(who.email, compId, slot, taskIds[0], "gt-answer-1");
      await ctx.api.dispose();
    }

    const { api: sa } = await apiLogin("superadmin");
    // POSITIVE CONTROL: the unfiltered board really does hold both.
    const plainIds = (await (await sa.get(`/api/admin/leaderboard?competitionId=${compId}`)).json()).map(x => x.userId);
    expect(plainIds).toContain(inA.id);
    expect(plainIds).toContain(inB.id);
    // The lock: the SAME board, requested with Slot A focused. Mode is global, so
    // the slot filter must be discarded and Slot B's occupant must still appear.
    const scopedIds = (await (await sa.get(`/api/admin/leaderboard?competitionId=${compId}&timeslotId=${slotA}`)).json()).map(x => x.userId);
    expect(scopedIds, "a focused session must not hide Slot A's own cohort").toContain(inA.id);
    expect(scopedIds, "global mode must ignore the timeslotId and keep the board merged").toContain(inB.id);
    await sa.dispose();

    await dropComp(compId, taskIds);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Per-slot auto-end cascade
// ═══════════════════════════════════════════════════════════════════════════════
// CLAUDE.md: "Auto-end: per-timeslot when all participants solve all challenges."
// The submit path scopes its participant scan to `cu.timeslot_id=?`; every other
// auto-end fixture in the suite is single-cohort, where the scoped and unscoped
// queries return the identical set, so the scoping itself was never exercised.
// Drop it and the morning session keeps running until the afternoon cohort also
// finishes — a per-slot auto-end silently becomes a competition-wide one.
test.describe("Per-slot auto-end cascade", () => {
  test("a session auto-ends when ITS OWN cohort finishes, while a sibling session is still live", async () => {
    await ensureState();
    const { api: admin, csrf: adminCsrf } = await apiLogin("superadmin");
    const H = h(adminCsrf);
    const now = Date.now();
    let r = await admin.post("/api/admin/competitions", { headers: H, data: {
      name: `Slot Autoend ${now}`,
      start_time: new Date(now - 60_000).toISOString(),
      duration_minutes: 240,
    }});
    const compId = (await r.json()).competition?.id;
    expect(compId).toBeTruthy();
    r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: H, data: {
      name: "Slot A", start_time: new Date(now - 60_000).toISOString(), duration_minutes: 120,
    }});
    const slotA = (await r.json()).timeslot?.id;
    r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: H, data: {
      name: "Slot B", start_time: new Date(now - 30_000).toISOString(), duration_minutes: 120,
    }});
    const slotB = (await r.json()).timeslot?.id;
    expect(slotA && slotB).toBeTruthy();

    // ONE challenge, so the slot-A occupant finishing means their whole cohort has.
    const taskId = await makePublishedTask(admin, H, `Slot Autoend Task ${now}`, "ae-answer", compId);
    const finisher = await makeParticipant(admin, H, "aea");
    const idler = await makeParticipant(admin, H, "aeb");
    const assign = await admin.post("/api/admin/competitions/assign", { headers: H, data: {
      userIds: [finisher.id, idler.id], competitionIds: [compId],
    }});
    expect((await assign.json()).assigned).toBe(2);
    await admin.dispose();

    // The idler occupies Slot B and never submits. With the slot filter removed
    // they land in Slot A's scan too and, having solved nothing, keep it open.
    const idlerCtx = await enterSlot(idler.email, compId, slotB, null, null);
    await idlerCtx.api.dispose();

    const { api: sa } = await apiLogin("superadmin");
    const slots = async () => {
      const list = await (await sa.get(`/api/admin/competitions/${compId}/timeslots`)).json();
      return { a: list.find(s => s.id === slotA), b: list.find(s => s.id === slotB) };
    };
    // POSITIVE CONTROL: neither session has ended yet, so the transition asserted
    // below is a real one rather than a pre-existing state.
    const before = await slots();
    expect(before.a.ended_at, "Slot A must still be open before the solve").toBeFalsy();
    expect(before.a.status).toBe("live");
    expect(before.b.status).toBe("live");
    await sa.dispose();

    const finisherCtx = await enterSlot(finisher.email, compId, slotA, taskId, "ae-answer");
    await finisherCtx.api.dispose();

    const { api: sa2 } = await apiLogin("superadmin");
    const list = await (await sa2.get(`/api/admin/competitions/${compId}/timeslots`)).json();
    const a = list.find(s => s.id === slotA);
    const b = list.find(s => s.id === slotB);
    // THE LOCK: Slot A ends off its OWN cohort, even though Slot B's occupant has
    // solved nothing. Unscope the scan and this ended_at stays null.
    expect(a.ended_at, "Slot A must auto-end when ITS cohort finishes").toBeTruthy();
    expect(a.status).toBe("ended");
    // The sibling is untouched and the competition is still running. (These hold
    // under the mutation too — they document the cascade, they do not catch it.)
    expect(b.ended_at).toBeFalsy();
    expect(b.status).toBe("live");
    const comp = (await (await sa2.get("/api/admin/competitions")).json()).find(c => c.id === compId);
    expect(comp.status).toBe("live");
    expect(comp.ended_at).toBeFalsy();
    await sa2.dispose();

    await dropComp(compId, [taskId]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Challenge-assignment freeze after a session ends
// ═══════════════════════════════════════════════════════════════════════════════
// CLAUDE.md: "Challenge assignments frozen once any timeslot has ended." Every
// existing test of the ended-assignment path uses a single-slot FULLY-ended
// competition, which satisfies the `competitionStatus(comp)==="ended"` half of
// the guard's disjunction — so the multi-session half (competitionAnySlotEnded)
// was dead to the whole suite. Changing the challenge set after one cohort has
// finished retroactively rewrites their totalTasks, allSolved flag and badge
// eligibility, and hands the two cohorts different competitions.
test.describe("Challenge-assignment freeze after a session ends", () => {
  test("with one session ENDED and another LIVE, assignment is refused on POST, PUT and DELETE", async () => {
    await ensureState();
    const { api: admin, csrf: adminCsrf } = await apiLogin("superadmin");
    const H = h(adminCsrf);
    const now = Date.now();
    let r = await admin.post("/api/admin/competitions", { headers: H, data: {
      name: `Assign Freeze ${now}`,
      start_time: new Date(now - 60_000).toISOString(),
      duration_minutes: 240,
    }});
    const compId = (await r.json()).competition?.id;
    expect(compId).toBeTruthy();
    r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: H, data: {
      name: "Slot A", start_time: new Date(now - 60_000).toISOString(), duration_minutes: 120,
    }});
    const slotA = (await r.json()).timeslot?.id;
    r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: H, data: {
      name: "Slot B", start_time: new Date(now - 30_000).toISOString(), duration_minutes: 120,
    }});
    const slotB = (await r.json()).timeslot?.id;
    expect(slotA && slotB).toBeTruthy();

    // POSITIVE CONTROL: while both sessions are live the very same POST succeeds,
    // so the 400s below are the freeze and not a broken request shape.
    const attached = await makePublishedTask(admin, H, `Assign Freeze Attached ${now}`, "af-1", compId);
    const listed = async () => (await (await admin.get(`/api/admin/tasks?competitionId=${compId}`)).json()).map(t => t.id);
    expect(await listed(), "the pre-freeze assignment must have landed").toContain(attached);

    // End ONLY Slot A. The competition itself stays LIVE (Slot B is running), so
    // this exercises the `competitionAnySlotEnded` disjunct specifically.
    const endR = await admin.post(`/api/admin/competitions/${compId}/timeslots/${slotA}/end-now`, { headers: H });
    expect(endR.ok(), `ending Slot A failed: ${await endR.text()}`).toBeTruthy();
    const comp = (await (await admin.get("/api/admin/competitions")).json()).find(c => c.id === compId);
    expect(comp.status, "the competition itself must still be LIVE").toBe("live");
    expect(comp.timeslots.find(s => s.id === slotA).status).toBe("ended");
    expect(comp.timeslots.find(s => s.id === slotB).status).toBe("live");

    const fresh = await makePublishedTask(admin, H, `Assign Freeze Fresh ${now}`, "af-2", null);

    // POST — add a challenge.
    const post = await admin.post(`/api/admin/tasks/${fresh}/competitions`, { headers: H, data: { competitionIds: [compId] } });
    expect(post.status(), "POST assign must be refused").toBe(400);
    expect((await post.json()).error).toMatch(/session has already ended/i);
    expect(await listed(), "the refused POST must not have attached the challenge").not.toContain(fresh);

    // PUT — the sync/diff sibling, same guard, its own call site.
    const put = await admin.put(`/api/admin/tasks/${fresh}/competitions`, { headers: H, data: {
      competitionIds: [compId], expectedAssignments: [],
    }});
    expect(put.status(), "PUT sync must be refused").toBe(400);
    expect((await put.json()).error).toMatch(/session has already ended/i);
    expect(await listed(), "the refused PUT must not have attached the challenge").not.toContain(fresh);

    // DELETE — removing a challenge is just as retroactive as adding one.
    const del = await admin.delete(`/api/admin/tasks/${attached}/competitions/${compId}`, { headers: { "x-csrf-token": adminCsrf } });
    expect(del.status(), "DELETE unassign must be refused").toBe(400);
    expect((await del.json()).error).toMatch(/session has already ended/i);
    expect(await listed(), "the refused DELETE must not have detached the challenge").toContain(attached);
    await admin.dispose();

    await dropComp(compId, [attached, fresh]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Participant status window is slot-scoped
// ═══════════════════════════════════════════════════════════════════════════════
// The participant's countdown is driven straight off /api/status's start/end
// (participant-tasks.js sets S.hackathonEndTime = new Date(st.end)). In a
// multi-session competition the competition's effective end is the LAST session's
// end, so if the slot window is lost a 10:00-12:00 participant is shown an 18:00
// deadline and the timer's own end-trigger never fires. Every existing
// /api/status assertion in the suite is against the single-slot comp (they pin
// timeslot_name === null), so no test ever observed a slot-scoped window.
test.describe("Participant status window is slot-scoped", () => {
  test("/api/status reports the caller's OWN session window, not the competition's", async () => {
    await ensureState();
    const { api: admin, csrf: adminCsrf } = await apiLogin("superadmin");
    const H = h(adminCsrf);
    const now = Date.now();
    let r = await admin.post("/api/admin/competitions", { headers: H, data: {
      name: `Slot Window ${now}`,
      start_time: new Date(now - 60_000).toISOString(),
      duration_minutes: 400,
    }});
    const compId = (await r.json()).competition?.id;
    expect(compId).toBeTruthy();
    // Deliberately far apart: a short first session and a long second one, so the
    // slot end and the competition end cannot coincide by accident.
    r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: H, data: {
      name: "Slot A", start_time: new Date(now - 60_000).toISOString(), duration_minutes: 90,
    }});
    const slotAObj = (await r.json()).timeslot;
    r = await admin.post(`/api/admin/competitions/${compId}/timeslots`, { headers: H, data: {
      name: "Slot B", start_time: new Date(now - 30_000).toISOString(), duration_minutes: 300,
    }});
    const slotBObj = (await r.json()).timeslot;
    expect(slotAObj?.id && slotBObj?.id).toBeTruthy();

    const taskId = await makePublishedTask(admin, H, `Slot Window Task ${now}`, "sw-answer", compId);
    const p = await makeParticipant(admin, H, "sw");
    const assign = await admin.post("/api/admin/competitions/assign", { headers: H, data: {
      userIds: [p.id], competitionIds: [compId],
    }});
    expect((await assign.json()).assigned).toBe(1);
    await admin.dispose();

    const ctx = await enterSlot(p.email, compId, slotAObj.id, null, null);
    const st = await (await ctx.api.get("/api/status")).json();
    await ctx.api.dispose();

    const slotAStartMs = new Date(slotAObj.start_time).getTime();
    const slotAEndMs = slotAStartMs + 90 * 60_000;
    const slotBEndMs = new Date(slotBObj.start_time).getTime() + 300 * 60_000;

    expect(st.timeslot_name).toBe("Slot A");
    expect(st.status).toBe("live");
    expect(new Date(st.start).toISOString(), "start is the caller's own session start")
      .toBe(new Date(slotAObj.start_time).toISOString());
    // THE LOCK: the countdown deadline is Slot A's end, ~3.5 hours before the
    // competition's (which is Slot B's end).
    expect(Math.abs(new Date(st.end).getTime() - slotAEndMs), "end must be the caller's OWN session end")
      .toBeLessThan(2000);
    expect(st.end, "the session end must not be the competition end").not.toBe(st.competition_end);
    // Positive control on the fixture itself: the two ends really are far apart,
    // so the inequality above is meaningful.
    expect(Math.abs(new Date(st.competition_end).getTime() - slotBEndMs)).toBeLessThan(2000);
    expect(slotBEndMs - slotAEndMs).toBeGreaterThan(3 * 60 * 60_000);

    await dropComp(compId, [taskId]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Email-reminder reschedule on competition start-time edit (v6.8.2)
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Email reminder reschedule on edit", () => {
  test("moving a competition's start_time moves the pending reminder with it", async () => {
    // v7.22.8 — flaked once at full-suite parallelism: `setR.ok()` came back
    // false with a bare `Received: false`, naming nothing. It was the LAST
    // test in this file still authenticating as the shared seeded `alice`
    // (the class this file's own header warns about), and its assign +
    // select-competition setup calls were unchecked, so ANY silently-skipped
    // precondition surfaced as a reminder refusal pointing at the wrong
    // place. No mechanism is claimed — the tag churn in this file targets
    // carol/bob, not alice, and the refusal body was not captured. Hardened
    // per the standing rules instead: own participant, every setup call
    // asserted, and failures that carry the response body.
    const { api: admin, csrf: adminCsrf } = await apiLogin("superadmin");
    const now = Date.now();
    const me = await makeParticipant(admin, h(adminCsrf), "remind");
    // Upcoming single-slot comp so reminders are schedulable.
    let r = await admin.post("/api/admin/competitions", { headers: h(adminCsrf), data: {
      name: `Reminder Reschedule ${now}`,
      start_time: new Date(now + 4 * 60 * 60 * 1000).toISOString(),
      duration_minutes: 60,
    }});
    expect(r.ok(), `competition created: ${r.status()}`).toBeTruthy();
    const compId = (await r.json()).competition?.id;
    expect(compId, "competition id present").toBeTruthy();
    const asg = await admin.post("/api/admin/competitions/assign", { headers: h(adminCsrf), data: {
      userIds: [me.id], competitionIds: [compId],
    }});
    expect(asg.ok(), `assign accepted: ${asg.status()}`).toBeTruthy();
    const asgBody = await asg.json();
    expect(asgBody.assigned, `assign really enrolled the participant: ${JSON.stringify(asgBody)}`).toBe(1);
    await admin.dispose();

    // The participant sets a reminder via their own flow.
    const { api: part, csrf: partCsrf } = await apiLogin(me.email, PARTICIPANT_PASS);
    const sel = await part.post("/api/select-competition", { headers: h(partCsrf), data: { competitionId: compId }});
    expect(sel.ok(), `select-competition: ${sel.status()} ${await sel.text()}`).toBeTruthy();
    const setR = await part.post(`/api/competitions/${compId}/reminder`, { headers: h(partCsrf) });
    expect(setR.ok(), `reminder set: ${setR.status()} ${await setR.text()}`).toBeTruthy();
    await part.dispose();

    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH, { readonly: true });
    const before = db.prepare("SELECT send_at FROM email_reminders WHERE user_id=? AND competition_id=?").get(me.id, compId);
    db.close();
    expect(before).toBeTruthy();
    expect(before.send_at).toBeTruthy();

    // Admin moves the start time forward by 2 hours.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const newStart = new Date(now + 6 * 60 * 60 * 1000).toISOString();
    const editR = await sa.put(`/api/admin/competitions/${compId}`, { headers: h(saCsrf), data: { start_time: newStart } });
    expect(editR.ok()).toBeTruthy();
    await sa.dispose();

    // The reminder's send_at must now be 1 hour before the NEW start.
    const db2 = new Database(TEST_DB_PATH, { readonly: true });
    const after = db2.prepare("SELECT send_at FROM email_reminders WHERE user_id=? AND competition_id=?").get(me.id, compId);
    db2.close();
    expect(after).toBeTruthy();
    const expectedSendAt = new Date(new Date(newStart).getTime() - 60 * 60 * 1000).toISOString();
    expect(after.send_at).toBe(expectedSendAt);
    expect(after.send_at).not.toBe(before.send_at);

    // Cleanup
    const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
    await sa2.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": saCsrf2 } });
    await sa2.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ══════════════════════════════════════════════════════════════════════════════
// v6.20.x — Tier-3 lifecycle regression locks: leaderboard_mode lock-after-start
// (negative), and the parent-competition updated_at bump on end-now + timeslot
// edit (the v6.20.23 optimistic-concurrency fix).
// ══════════════════════════════════════════════════════════════════════════════
test.describe("v6.20.x: lifecycle invariants", () => {
  // Build a live multi-slot comp whose slots already started (start_time in the
  // past). Returns ids + the admin api/csrf.
  async function buildStartedComp(label) {
    const { api, csrf } = await apiLogin("superadmin");
    const now = Date.now();
    let r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `${label} ${now}`, start_time: new Date(now - 60_000).toISOString(), duration_minutes: 240, leaderboard_mode: "per_slot",
    }});
    const compId = (await r.json()).competition?.id;
    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(csrf), data: {
      name: "Slot A", start_time: new Date(now - 60_000).toISOString(), duration_minutes: 120,
    }});
    const slotA = (await r.json()).timeslot?.id;
    return { api, csrf, compId, slotA };
  }
  function compById(list, id) { return (Array.isArray(list) ? list : (list.competitions || list)).find(c => c.id === id); }

  test("leaderboard_mode cannot change after a session has started (400)", async () => {
    const { api, csrf, compId } = await buildStartedComp("LbModeLock");
    try {
      const r = await api.put(`/api/admin/competitions/${compId}`, { headers: h(csrf), data: { leaderboard_mode: "global" } });
      expect(r.status(), "changing leaderboard_mode after a slot started must 400").toBe(400);
      expect((await r.json()).error).toMatch(/after a session has started/i);
    } finally {
      await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } });
      await api.dispose();
    }
  });

  // v7.15.32 — REPURPOSED. This was "competition end-now bumps the competition
  // updated_at (optimistic-concurrency)", a duplicate of
  // functional-core.api.spec.js > "competition end-now bumps updated_at so
  // stale competition PUT is rejected with 409" — which asserts strictly more
  // (the response echo and `conflict:true`).
  //
  // Its ONLY unique reach was that its competition has real sessions, so
  // end-now's per-slot cascade loop (routes/competitions.js) actually executes
  // — and that loop had NO assertions on it anywhere in the suite: no test
  // ended a competition and then looked at its session rows. Rather than
  // delete the duplicate and lose that, it now tests the cascade itself, which
  // is a different guarantee from the parent's updated_at bump:
  //   • a LIVE session is ended and its duration truncated to what it actually ran
  //   • an UPCOMING session is CANCELLED — pulled back to now with duration 0,
  //     so it can never subsequently go live under an ended competition
  test("competition end-now cascades to its sessions: live ones end, upcoming ones are cancelled", async () => {
    const { api, csrf, compId, slotA } = await buildStartedComp("EndNowCascade");
    try {
      const now = Date.now();
      // A second session that has NOT started — the other half of the cascade.
      const upR = await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(csrf), data: {
        name: "Slot B", start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 90,
      }});
      expect(upR.ok(), `create upcoming slot: ${upR.status()}`).toBeTruthy();
      const slotB = (await upR.json()).timeslot?.id;

      const readSlots = async () => {
        const body = await (await api.get(`/api/admin/competitions/${compId}/timeslots`)).json();
        const rows = body.timeslots || body;
        return { a: rows.find(t => t.id === slotA), b: rows.find(t => t.id === slotB) };
      };

      // POSITIVE CONTROL — neither session is ended before the act, so the
      // assertions below cannot be satisfied by a fixture that was already done.
      const pre = await readSlots();
      expect(pre.a.ended_at, "Slot A must be running before end-now").toBeFalsy();
      expect(pre.b.ended_at, "Slot B must be pending before end-now").toBeFalsy();
      expect(pre.b.duration_minutes, "Slot B starts with a real duration").toBe(90);

      const r = await api.post(`/api/admin/competitions/${compId}/end-now`, { headers: h(csrf) });
      expect(r.ok(), `end-now: ${r.status()}`).toBeTruthy();

      const post = await readSlots();
      // The LIVE session: ended, flagged as a manual end, and truncated to the
      // ~1 minute it actually ran rather than left at its scheduled 120.
      expect(post.a.ended_at, "a LIVE session must be ended by the cascade").toBeTruthy();
      expect(post.a.ended_manually, "…and marked as manually ended").toBeTruthy();
      expect(post.a.duration_minutes,
        "…with its duration truncated to what it actually ran, not its scheduled 120"
      ).toBeLessThan(120);

      // The UPCOMING session: cancelled outright. Duration 0 is what stops it
      // from going live later under a competition that has already finished.
      expect(post.b.ended_at, "an UPCOMING session must be cancelled by the cascade").toBeTruthy();
      expect(post.b.duration_minutes, "…to a zero-length window").toBe(0);
      expect(new Date(post.b.start_time).getTime(),
        "…and pulled back from its future start so it can never begin"
      ).toBeLessThanOrEqual(Date.now() + 1000);
    } finally {
      await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } });
      await api.dispose();
    }
  });

  test("timeslot edit bumps the PARENT competition updated_at (v6.20.23)", async () => {
    const { api, csrf, compId, slotA } = await buildStartedComp("TsEditBump");
    try {
      const before = compById(await (await api.get("/api/admin/competitions")).json(), compId).updated_at;
      await new Promise(r => setTimeout(r, 5));
      // Edit the slot's duration — shifts competitionEffectiveEnd.
      const r = await api.put(`/api/admin/competitions/${compId}/timeslots/${slotA}`, { headers: h(csrf), data: { duration_minutes: 180 } });
      expect(r.ok()).toBeTruthy();
      const after = compById(await (await api.get("/api/admin/competitions")).json(), compId).updated_at;
      expect(after, "a timeslot edit must advance the parent competition updated_at").not.toBe(before);
    } finally {
      await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } });
      await api.dispose();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
test.describe("Cleanup", () => {
  test("delete test competition", async () => {
    if (!S.tsCompId) return;
    const { api, csrf } = await apiLogin("superadmin");
    await api.delete(`/api/admin/competitions/${S.tsCompId}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });
});
