// @ts-check
/**
 * Timeslot feature tests — exercises timeslot CRUD, participant selection,
 * locking, leaderboard modes, and answer reveal timing.
 */
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, PARTICIPANT_PASS } = require("./helpers");

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

/**
 * Register + verify + approve a BRAND-NEW participant and enroll them in `compId`.
 *
 * A fresh account (rather than one of the shared alice/bob/carol fixtures) is
 * deliberate: `POST /api/admin/competitions/assign` silently SKIPS staff /
 * blocked / unapproved users, and an earlier test on this worker can have
 * staff-tagged a shared fixture — which would leave no `competition_users` row
 * at all and quietly make a membership assertion vacuous.
 *
 * The enrollment is asserted here (not left to the caller) so a fixture failure
 * reads as a fixture failure rather than as the behaviour under test.
 */
async function makeEnrolledParticipant(sa, saCsrf, compId, tag) {
  const H = h(saCsrf);
  const email = `${tag}@company.com`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", {
    headers: { "x-csrf-token": ac, "content-type": "application/json" },
    data: {
      firstName: "Slot", lastName: "Fixture", nickname: tag, email,
      company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "Boston", password: PARTICIPANT_PASS,
    },
  });
  expect(reg.status(), `fixture participant ${email} registered`).toBe(200);
  await anon.dispose();

  const u = (await (await sa.get("/api/admin/participants?limit=5000")).json())
    .participants.find(p => p.email === email);
  expect(u, `fixture participant ${email} is listed`).toBeTruthy();
  await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": saCsrf } });
  await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": saCsrf } });

  const asg = await sa.post("/api/admin/competitions/assign", {
    headers: H, data: { userIds: [u.id], competitionIds: [compId] },
  });
  expect(asg.status(), "fixture assign succeeded").toBe(200);
  expect((await asg.json()).assigned,
    "the fixture participant must actually be ENROLLED — assign silently skips staff/blocked/unapproved, " +
    "and every assertion below reads the competition_users row this creates"
  ).toBeGreaterThan(0);
  return { user: u, email };
}

/**
 * v8.3.16 — THE TIMESLOT FIXTURE IS A PRECONDITION, NOT A SIDE EFFECT OF TEST #1.
 *
 * `S.tsCompId` / `S.ts1Id` / `S.ts2Id` existed only because `create competition
 * with timeslots` had run, so every test below it — and the whole `Leaderboard
 * mode` describe, which reads the same ids from ANOTHER describe — passed for a
 * reason that had nothing to do with them. Run any one alone and it failed on a
 * request to `/api/admin/competitions/undefined/timeslots`.
 *
 * Create-if-missing on a STABLE name, so the full file and a single `-g` run
 * behave identically. Idempotent: both describes call it from their own
 * `beforeAll`, and the second finds what the first made.
 */
const TS_FIXTURE_NAME = "Timeslot Fixture Comp";

async function ensureTsFixture() {
  if (S.tsCompId) return;
  const { api, csrf } = await apiLogin("superadmin");
  try {
    const now = Date.now();
    const comps = await (await api.get("/api/admin/competitions")).json();
    let comp = comps.find(c => c.name === TS_FIXTURE_NAME);
    if (!comp) {
      const r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
        name: TS_FIXTURE_NAME, start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 120,
      }});
      expect(r.ok(), `timeslot fixture competition created: ${await r.text()}`).toBeTruthy();
      comp = (await r.json()).competition;
    }
    S.tsCompId = comp.id;

    let slots = await (await api.get(`/api/admin/competitions/${S.tsCompId}/timeslots`)).json();
    if (slots.length < 2) {
      // The names are asserted verbatim by `list timeslots for competition`, and
      // `edit timeslot` renames the FIRST one — so re-derive both ids from the
      // list afterwards rather than from the create responses.
      for (const [name, offset] of [["Morning Session", 3600_000], ["Afternoon Session", 7200_000]]) {
        if (slots.some(s => s.name === name)) continue;
        const r = await api.post(`/api/admin/competitions/${S.tsCompId}/timeslots`, { headers: h(csrf), data: {
          name, start_time: new Date(now + offset).toISOString(), duration_minutes: 60,
        }});
        expect(r.ok(), `timeslot fixture slot "${name}" created: ${await r.text()}`).toBeTruthy();
      }
      slots = await (await api.get(`/api/admin/competitions/${S.tsCompId}/timeslots`)).json();
    }
    expect(slots.length, "the timeslot fixture carries exactly two sessions").toBe(2);
    S.ts1Id = slots[0].id;
    S.ts2Id = slots[1].id;
  } finally { await api.dispose(); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIMESLOT CRUD
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Timeslot CRUD", () => {
  test.beforeAll(ensureTsFixture);

  test("create competition with timeslots", async () => {
    // Uses its OWN uniquely-named competition: the shared fixture is established
    // in beforeAll, so this test is free to assert what it is actually about —
    // that a competition and its sessions can be created — without also being
    // the thing every test below it depends on.
    const { api, csrf } = await apiLogin("superadmin");
    const now = Date.now();
    let r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `Timeslot Create Probe ${now}`, start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 120,
    }});
    expect(r.ok()).toBeTruthy();
    const compId = (await r.json()).competition?.id;
    expect(compId).toBeTruthy();

    // Add two timeslots
    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(csrf), data: {
      name: "Morning Session", start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 60,
    }});
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).timeslot?.id).toBeTruthy();

    r = await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(csrf), data: {
      name: "Afternoon Session", start_time: new Date(now + 7200_000).toISOString(), duration_minutes: 60,
    }});
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).timeslot?.id).toBeTruthy();

    await api.delete(`/api/admin/competitions/${compId}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });

  test("list timeslots for competition", async () => {
    const { api } = await apiLogin("superadmin");
    const r = await api.get(`/api/admin/competitions/${S.tsCompId}/timeslots`);
    expect(r.ok()).toBeTruthy();
    const slots = await r.json();
    expect(slots.length).toBe(2);
    expect(slots[0].name).toBe("Morning Session");
    expect(slots[1].name).toBe("Afternoon Session");
    expect(slots[0].status).toBe("upcoming");
    await api.dispose();
  });

  test("competition list includes timeslots", async () => {
    const { api } = await apiLogin("superadmin");
    const comps = await (await api.get("/api/admin/competitions")).json();
    const tc = comps.find(c => c.id === S.tsCompId);
    expect(tc).toBeTruthy();
    expect(tc.timeslots.length).toBe(2);
    expect(["global","per_slot"]).toContain(tc.leaderboard_mode);
    await api.dispose();
  });

  test("edit timeslot", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.put(`/api/admin/competitions/${S.tsCompId}/timeslots/${S.ts1Id}`, {
      headers: h(csrf), data: { name: "Early Morning Session" },
    });
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).timeslot.name).toBe("Early Morning Session");
    await api.dispose();
  });

  test("cannot add timeslots after submissions exist", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    // The live competition has submissions — adding timeslots should fail
    const r = await api.post(`/api/admin/competitions/${S.liveComp.id}/timeslots`, { headers: h(csrf), data: {
      name: "Should Fail", start_time: new Date().toISOString(), duration_minutes: 60,
    }});
    expect(r.ok()).toBeFalsy();
    expect((await r.json()).error).toContain("submissions");
    await api.dispose();
  });

  test("POST timeslot validates start_time and duration_minutes", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    // Invalid start_time
    let r = await api.post(`/api/admin/competitions/${S.tsCompId}/timeslots`, { headers: h(csrf), data: {
      name: "Bad Time", start_time: "not-a-date", duration_minutes: 60,
    }});
    expect(r.ok()).toBeFalsy();
    expect((await r.json()).error).toMatch(/start time/i); // batch 7 — validateBody standardized the message
    // Invalid duration
    r = await api.post(`/api/admin/competitions/${S.tsCompId}/timeslots`, { headers: h(csrf), data: {
      name: "Bad Dur", start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: -5,
    }});
    expect(r.ok()).toBeFalsy();
    expect((await r.json()).error).toMatch(/duration/i); // batch 7 — validateBody standardized the message
    await api.dispose();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE RULES
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Lifecycle rules", () => {
  let _compId, _liveTs, _pendingTs;

  // v8.3.16 — WAS a `test("setup: …")`, which is the anti-pattern the standing
  // rule names: the five lifecycle tests below read `_compId` / `_liveTs` /
  // `_pendingTs` and only ever got them because that "test" happened to run
  // first. Alone, each failed on `Cannot read properties of undefined
  // (reading 'id')`. Setup belongs in a hook, where a single `-g` run gets it
  // too — and the cleanup below is an `afterAll` for the same reason.
  test.beforeAll(async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const now = Date.now();
    let r = await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `Lifecycle ${now}`, start_time: new Date(now - 60_000).toISOString(), duration_minutes: 240,
    }});
    expect(r.ok(), `lifecycle fixture competition created: ${await r.text()}`).toBeTruthy();
    _compId = (await r.json()).competition?.id;
    expect(_compId, "lifecycle fixture competition id").toBeTruthy();
    // Live session (started 1 min ago)
    r = await api.post(`/api/admin/competitions/${_compId}/timeslots`, { headers: h(csrf), data: {
      name: "Live Sess", start_time: new Date(now - 60_000).toISOString(), duration_minutes: 120,
    }});
    expect(r.ok(), `live session created: ${await r.text()}`).toBeTruthy();
    _liveTs = (await r.json()).timeslot;
    // Pending session (starts in 1 hour)
    r = await api.post(`/api/admin/competitions/${_compId}/timeslots`, { headers: h(csrf), data: {
      name: "Pending Sess", start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 120,
    }});
    expect(r.ok(), `pending session created: ${await r.text()}`).toBeTruthy();
    _pendingTs = (await r.json()).timeslot;
    expect(_liveTs?.id && _pendingTs?.id, "both lifecycle sessions exist").toBeTruthy();
    await api.dispose();
  });

  test.afterAll(async () => {
    if (!_compId) return;
    const { api, csrf } = await apiLogin("superadmin");
    await api.delete(`/api/admin/competitions/${_compId}`, { headers: { "x-csrf-token": csrf } });
    await api.dispose();
  });

  test("cannot change start_time of a started session", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.put(`/api/admin/competitions/${_compId}/timeslots/${_liveTs.id}`, {
      headers: h(csrf), data: { start_time: new Date(Date.now() + 7200_000).toISOString() },
    });
    expect(r.ok()).toBeFalsy();
    expect((await r.json()).error).toContain("start time");
    await api.dispose();
  });

  test("cannot delete a started session", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.delete(`/api/admin/competitions/${_compId}/timeslots/${_liveTs.id}`, {
      headers: { "x-csrf-token": csrf },
    });
    expect(r.ok()).toBeFalsy();
    expect((await r.json()).error).toContain("started");
    await api.dispose();
  });

  // The test above hits the FIRST delete guard (status !== upcoming) and returns
  // before the participant check is ever reached, so the assigned-participants
  // guard had no coverage anywhere in the suite. It is the only thing standing
  // between an admin tidying up sessions and silently ejecting participants who
  // have already picked one: deleting the row strands their
  // competition_users.timeslot_id on a nonexistent slot (the per-slot leaderboard
  // join drops them) and wipes their email_reminders for that slot.
  test("cannot delete an upcoming session a participant has already chosen", async () => {
    const Database = require("better-sqlite3");
    const { TEST_DB_PATH } = require("./helpers");
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const stamp = Date.now();
    const soon = new Date(stamp + 7200_000).toISOString();   // +2h → stays UPCOMING throughout

    const comp = (await (await sa.post("/api/admin/competitions", { headers: H, data: {
      name: `DelGuard ${stamp}`, start_time: soon, duration_minutes: 120,
    }})).json()).competition;
    expect(comp && comp.id, "competition created").toBeTruthy();

    let apiP;
    try {
      const ts = (await (await sa.post(`/api/admin/competitions/${comp.id}/timeslots`, { headers: H, data: {
        name: "Chosen Session", start_time: soon, duration_minutes: 60,
      }})).json()).timeslot;
      expect(ts && ts.id, "timeslot created").toBeTruthy();

      const { user } = await makeEnrolledParticipant(sa, csrf, comp.id, `delg${stamp}`);

      // The participant pins the UPCOMING slot — no confirmLive needed, and the
      // 200 must be a real commit, not the `{ok:false, requireConfirmation:true}`
      // shape a live slot returns.
      const { api, csrf: pc } = await apiLogin(user.email, PARTICIPANT_PASS);
      apiP = api;
      const PH = { "x-csrf-token": pc, "content-type": "application/json" };
      expect((await api.post("/api/select-competition", { headers: PH, data: { competitionId: comp.id } })).status()).toBe(200);
      const sel = await api.post("/api/select-timeslot", { headers: PH, data: { timeslotId: ts.id } });
      expect(sel.status()).toBe(200);
      const selD = await sel.json();
      expect(selD.requireConfirmation, "an upcoming slot is pinned outright").toBeFalsy();
      expect(selD.ok, "the slot choice committed").toBeTruthy();

      // POSITIVE CONTROL — the guard reads exactly this row. Without it, a 400
      // for some unrelated reason would look like the guard firing.
      const dbR = new Database(TEST_DB_PATH, { readonly: true });
      try {
        const row = dbR.prepare("SELECT timeslot_id FROM competition_users WHERE competition_id=? AND user_id=?")
          .get(comp.id, user.id);
        expect(row && row.timeslot_id, "the participant is pinned to the slot the DELETE will target").toBe(ts.id);
      } finally { dbR.close(); }

      const del = await sa.delete(`/api/admin/competitions/${comp.id}/timeslots/${ts.id}`, {
        headers: { "x-csrf-token": csrf },
      });
      expect(del.status(), "deleting a session a participant has chosen must be refused").toBe(400);
      expect((await del.json()).error).toMatch(/assigned participants/i);

      // The guard must fire BEFORE any write — the slot is still there.
      const slots = await (await sa.get(`/api/admin/competitions/${comp.id}/timeslots`)).json();
      expect(slots.map(s => s.id), "the refused DELETE wrote nothing").toContain(ts.id);
    } finally {
      if (apiP) await apiP.dispose();
      await sa.delete(`/api/admin/competitions/${comp.id}`, { headers: { "x-csrf-token": csrf } });
      await sa.dispose();
    }
  });

  test("end-now on pending session sets start_time=now, duration=0", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post(`/api/admin/competitions/${_compId}/timeslots/${_pendingTs.id}/end-now`, {
      headers: h(csrf),
    });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.timeslot.duration_minutes).toBe(0);
    expect(d.timeslot.ended_at).toBeTruthy();
    await api.dispose();
  });

  test("end-now on live session adjusts duration", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post(`/api/admin/competitions/${_compId}/timeslots/${_liveTs.id}/end-now`, {
      headers: h(csrf),
    });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.timeslot.ended_at).toBeTruthy();
    // Duration adjusted to actual runtime (should be ~1 minute, much less than original 120)
    expect(d.timeslot.duration_minutes).toBeLessThan(120);
    await api.dispose();
  });

  test("cannot change start_time of a live single-slot competition", async () => {
    await ensureState();
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.put(`/api/admin/competitions/${S.liveComp.id}`, {
      headers: h(csrf), data: { start_time: new Date(Date.now() + 7200_000).toISOString() },
    });
    expect(r.ok()).toBeFalsy();
    expect((await r.json()).error).toContain("start time");
    await api.dispose();
  });

  test("regular admin cannot edit ended competition with past end time", async () => {
    await ensureState();
    // Promote Carol to admin, login as Carol
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    await sa.post(`/api/admin/participants/${S.carol.id}/role`, { headers: h(saCsrf), data: { role: "admin" } });
    await sa.dispose();
    // v8.8.19 — the demotion is in a `finally`. Promotion auto-adds the `staff`
    // tag, which removes carol from every leaderboard AND makes the assign
    // endpoint silently skip her — an unattributable failure two tests later.
    try {
      const { api, csrf } = await apiLogin("carol@acme.com", PARTICIPANT_PASS);
      // "Test Ended" has start_time 5h ago + 60min duration = ended 4h ago
      const comps = await (await api.get("/api/admin/competitions")).json();
      const ended = comps.find(c => c.name === "Test Ended");
      if (ended) {
        const r = await api.put(`/api/admin/competitions/${ended.id}`, {
          headers: h(csrf), data: { duration_minutes: 999 },
        });
        expect(r.status()).toBe(403);
      }
      await api.dispose();
    } finally {
      const { api: sa2, csrf: saCsrf2 } = await apiLogin("superadmin");
      await sa2.post(`/api/admin/participants/${S.carol.id}/role`, { headers: h(saCsrf2), data: { role: "participant" } }).catch(() => {});
      await sa2.dispose();
    }
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// LEADERBOARD MODE
// ═══════════════════════════════════════════════════════════════════════════════
test.describe("Leaderboard mode", () => {
  // v8.3.16 — S.tsCompId belongs to the `Timeslot CRUD` describe above, so this
  // test read it only because that whole block had run first. The fixture helper
  // is idempotent, so calling it here costs nothing in a full-file run and is
  // what makes a single `-g` run work.
  test.beforeAll(ensureTsFixture);

  test("can set leaderboard_mode before any slot starts", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.put(`/api/admin/competitions/${S.tsCompId}`, {
      headers: h(csrf), data: { leaderboard_mode: "global" },
    });
    expect(r.ok()).toBeTruthy();
    const comps = await (await api.get("/api/admin/competitions")).json();
    expect(comps.find(c => c.id === S.tsCompId).leaderboard_mode).toBe("global");
    // Set it back to per_slot (the default)
    await api.put(`/api/admin/competitions/${S.tsCompId}`, {
      headers: h(csrf), data: { leaderboard_mode: "per_slot" },
    });
    await api.dispose();
  });

  // `leaderboard_mode` is the ONE competition field that is not routed through
  // validateBody/COMPETITION_FIELD_SCHEMA — it is destructured raw and its only
  // validation is a hand-rolled allowlist. `competitions` carries no CHECK
  // constraints, so an unrecognised value would be COALESCE'd straight into the
  // row and then read as "not per_slot" by every consumer (lib/leaderboard.js,
  // routes/leaderboard.js, routes/badge.js, rankings-admin.js): a multi-session
  // competition would silently switch from per-session boards to one merged
  // global board with nothing on screen saying so. The admin form even renders a
  // stored junk value as "Per Session", so the corruption is invisible in the UI
  // and self-erasing on the next save — only an API-level test can lock it.
  test("a leaderboard_mode outside the allowlist is rejected and never persisted", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = Date.now();
    // A dedicated, far-future competition: the allowlist check at the top of the
    // block is followed by the started-lock, so on a comp whose slots had started
    // a rejection would be ambiguous — and under the mutation the started-lock
    // would 400 in the allowlist's place and the test would pass vacuously.
    const comp = (await (await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `LbMode ${stamp}`, start_time: new Date(stamp + 86400_000).toISOString(), duration_minutes: 120,
    }})).json()).competition;
    expect(comp && comp.id, "competition created").toBeTruthy();
    const readMode = async () => {
      const comps = await (await api.get("/api/admin/competitions")).json();
      return comps.find(c => c.id === comp.id)?.leaderboard_mode;
    };

    try {
      const before = await readMode();
      expect(["global", "per_slot"], "precondition: the stored mode starts canonical").toContain(before);

      const r = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: h(csrf), data: { leaderboard_mode: "banana" },
      });
      expect(r.status(), "an unrecognised leaderboard_mode must be refused").toBe(400);
      expect((await r.json()).error).toMatch(/global.*per_slot/);

      // The load-bearing assertion: a status-only check would still pass if the
      // route 400'd for some unrelated reason while storing the junk value.
      const after = await readMode();
      expect(after, "the rejected value must not reach the column").toBe(before);
      expect(["global", "per_slot"], "the stored mode stays canonical").toContain(after);

      // Positive control — mode changes ARE permitted on this competition, so the
      // 400 above was the allowlist and not the any-slot-started lock.
      const ok = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: h(csrf), data: { leaderboard_mode: before === "global" ? "per_slot" : "global" },
      });
      expect(ok.status(), "a CANONICAL mode change is accepted on this same competition").toBe(200);
      expect(await readMode()).toBe(before === "global" ? "per_slot" : "global");
    } finally {
      await api.delete(`/api/admin/competitions/${comp.id}`, { headers: { "x-csrf-token": csrf } });
      await api.dispose();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BACKWARD COMPATIBILITY
// ═══════════════════════════════════════════════════════════════════════════════// ═══════════════════════════════════════════════════════════════════════════════
// ext-audit batch 4: session/competition edit validation (lower-bound + type + date)
// ═══════════════════════════════════════════════════════════════════════════════
// batch 3 added only UPPER bounds to the edit paths; the auditor found the holes:
// duration -1 persisted, duration 0 returned 200 + a bogus "changed to 0" audit
// event, and invalid dates / non-string names produced 500. The edit paths now
// validate type + date-validity + the full [1, 525600] range, like create.
test.describe("ext-audit batch 4: edit validation", () => {
  let ctx;
  test.beforeAll(async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const now = Date.now();
    const compId = (await (await api.post("/api/admin/competitions", { headers: h(csrf), data: {
      name: `B4 EditVal ${now}`, start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 240,
    } })).json()).competition.id;
    const tsId = (await (await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(csrf), data: {
      name: "EVS1", start_time: new Date(now + 3600_000).toISOString(), duration_minutes: 60,
    } })).json()).timeslot.id;
    ctx = { compId, tsId };
    await api.dispose();
  });

  const putTs = async (data) => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.put(`/api/admin/competitions/${ctx.compId}/timeslots/${ctx.tsId}`, { headers: h(csrf), data });
    await api.dispose();
    return r.status();
  };

  test("session edit: duration -1 → 400 (was 200 + persisted -1)", async () => {
    expect(await putTs({ duration_minutes: -1 })).toBe(400);
  });
  test("session edit: duration 0 → 400 (was 200 + bogus audit event)", async () => {
    expect(await putTs({ duration_minutes: 0 })).toBe(400);
  });
  test("session edit: invalid start_time → 400 (was 500)", async () => {
    expect(await putTs({ start_time: "not-a-date" })).toBe(400);
  });
  test("session edit: non-string name → 400 (was 500)", async () => {
    expect(await putTs({ name: ["evil"] })).toBe(400);
  });
  test("session edit: a valid duration still succeeds (200)", async () => {
    expect(await putTs({ duration_minutes: 90 })).toBe(200);
  });

  // batch 5 (the HIGH-impact corruption): a NUMERIC start_time (1) is a "valid"
  // Date, so the old isNaN() check passed, the RAW value was stored ("1.0"), and
  // the next GET /api/admin/competitions 500'd parsing that back. Reject numeric
  // start_time AND prove the comp list still loads after the attempt.
  test("session edit: numeric start_time → 400 and does NOT corrupt the comp list", async () => {
    expect(await putTs({ start_time: 1 })).toBe(400);
    const { api } = await apiLogin("superadmin");
    const list = await api.get("/api/admin/competitions");
    expect(list.status(), "GET /api/admin/competitions must still load (no stored bad date)").toBe(200);
    await api.dispose();
  });
  test("session create: whitespace-only name → 400", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.post(`/api/admin/competitions/${ctx.compId}/timeslots`, { headers: h(csrf), data: { name: "   ", start_time: new Date(Date.now() + 7200_000).toISOString(), duration_minutes: 30 } });
    await api.dispose();
    expect(r.status()).toBe(400);
  });

  test("competition edit: non-string name → 400 (was 500)", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const r = await api.put(`/api/admin/competitions/${ctx.compId}`, { headers: h(csrf), data: { name: ["evil"] } });
    await api.dispose();
    expect(r.status()).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ext-audit v7.15.15 (LOW) — the live-session confirmation must survive the
// start boundary
// ═══════════════════════════════════════════════════════════════════════════════
// Timeslot status is TIME-DERIVED, so a slot that reads `upcoming` at the top of
// the handler can be `live` by the time the write transaction runs. The
// transaction re-read the status but used it only to reject an ENDED slot, so a
// participant crossing the boundary was stamped into a live session WITHOUT the
// "you cannot change your choice" confirmation — and was then told the session
// was still upcoming, sending the client to the wrong view.
test.describe("Live-session confirmation at the start boundary (v7.15.15)", () => {
  const Database = require("better-sqlite3");
  const { TEST_DB_PATH } = require("./helpers");

  test("a slot that goes live during selection demands confirmation and reports LIVE", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    const stamp = Date.now();
    // A competition with a slot starting a moment from now.
    // Both create endpoints wrap their row: { ok, competition|timeslot: {...} }.
    const comp = (await (await sa.post("/api/admin/competitions", {
      headers: H,
      data: { name: `Boundary ${stamp}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 },
    })).json()).competition;
    expect(comp && comp.id, "competition created").toBeTruthy();
    // The create response wraps the row: { ok, timeslot: {...} }.
    const ts = (await (await sa.post(`/api/admin/competitions/${comp.id}/timeslots`, {
      headers: H,
      data: { name: "Slot A", start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 },
    })).json()).timeslot;
    expect(ts && ts.id, "timeslot created").toBeTruthy();

    // A fresh participant, enrolled.
    const email = `bnd${stamp}@company.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    expect((await registerPost(anon, "/api/register", {
      headers: { "x-csrf-token": ac, "content-type": "application/json" },
      data: {
        firstName: "Bnd", lastName: "Ary", nickname: `bnd${stamp}`, email,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "Boston", password: PARTICIPANT_PASS,
      },
    })).status()).toBe(200);
    await anon.dispose();
    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": csrf } });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": csrf } });
    await sa.post("/api/admin/competitions/assign", {
      headers: H, data: { userIds: [u.id], competitionIds: [comp.id] },
    });

    const { api, csrf: pc } = await apiLogin(email, PARTICIPANT_PASS);
    try {
      await api.post("/api/select-competition", {
        headers: { "x-csrf-token": pc, "content-type": "application/json" },
        data: { competitionId: comp.id },
      });
      // Park the handler between its first status read and its write
      // transaction, then move the slot across its start boundary inside that
      // window. Doing it BEFORE the request instead would be caught by the
      // pre-transaction check and prove nothing — an earlier draft of this test
      // did exactly that and passed with the fix reverted.
      await sa.post("/api/test/select-timeslot-delay", { headers: H, data: { delayMs: 1200 } });
      const pending = api.post("/api/select-timeslot", {
        headers: { "x-csrf-token": pc, "content-type": "application/json" },
        data: { timeslotId: ts.id },          // NO confirmLive
      });
      await new Promise(r => setTimeout(r, 400));
      const db = new Database(TEST_DB_PATH);
      try {
        db.prepare("UPDATE competition_timeslots SET start_time=? WHERE id=?")
          .run(new Date(Date.now() - 60_000).toISOString(), ts.id);
      } finally { db.close(); }
      const r = await pending;
      await sa.post("/api/test/select-timeslot-delay", { headers: H, data: { delayMs: 0 } });
      const d = await r.json();
      expect(d.requireConfirmation,
        `(response was ${r.status()} ${JSON.stringify(d)}) ` +
        "a slot that is LIVE by the time the write runs must demand confirmation — " +
        "being stamped into a live session without it is exactly what the prompt exists to prevent"
      ).toBeTruthy();

      // Nothing was committed: the participant is not pinned to the slot.
      const dbR = new Database(TEST_DB_PATH, { readonly: true });
      try {
        const row = dbR.prepare("SELECT timeslot_id FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, u.id);
        expect(row.timeslot_id, "and no slot was stamped without consent").toBeFalsy();
      } finally { dbR.close(); }

      // With confirmation, it succeeds AND reports the status it committed against.
      const ok = await api.post("/api/select-timeslot", {
        headers: { "x-csrf-token": pc, "content-type": "application/json" },
        data: { timeslotId: ts.id, confirmLive: true },
      });
      const od = await ok.json();
      expect(ok.status()).toBe(200);
      expect(od.timeslot.status,
        "the response must report the status the transaction committed against — " +
        "answering 'upcoming' for a slot just joined as LIVE sends the client to the wrong view"
      ).toBe("live");
    } finally {
      await api.dispose();
      await sa.delete(`/api/admin/competitions/${comp.id}`, { headers: { "x-csrf-token": csrf } });
      await sa.dispose();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// The slot-choice lock — the ENDED half
// ═══════════════════════════════════════════════════════════════════════════════
// `POST /api/select-timeslot` refuses a slot change when the participant's
// CURRENT slot is `live` OR `ended`. Only the `live` half was covered anywhere in
// the suite (and even there, by a test whose own comment says it is "agnostic to
// WHICH lock fires"). The `ended` half is what stops a morning participant, once
// their session closes, from hopping into the still-upcoming afternoon session —
// a second run at the same challenges and a score split across two per-slot
// boards. It needs no admin action at all: two sessions and a participant who
// waits.
test.describe("Slot-choice lock", () => {
  const Database = require("better-sqlite3");
  const { TEST_DB_PATH } = require("./helpers");

  test("a participant whose session has ENDED cannot move to another session", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const stamp = Date.now();

    const comp = (await (await sa.post("/api/admin/competitions", { headers: H, data: {
      name: `SlotLock ${stamp}`, start_time: new Date(stamp - 60_000).toISOString(), duration_minutes: 300,
    }})).json()).competition;
    expect(comp && comp.id, "competition created").toBeTruthy();

    let apiP;
    try {
      // Slot A is LIVE (so entering it stamps competition_users.login_time, which
      // is what arms the lock); Slot B is upcoming and stays that way.
      const slotA = (await (await sa.post(`/api/admin/competitions/${comp.id}/timeslots`, { headers: H, data: {
        name: "Morning", start_time: new Date(stamp - 60_000).toISOString(), duration_minutes: 120,
      }})).json()).timeslot;
      const slotB = (await (await sa.post(`/api/admin/competitions/${comp.id}/timeslots`, { headers: H, data: {
        name: "Afternoon", start_time: new Date(stamp + 7200_000).toISOString(), duration_minutes: 60,
      }})).json()).timeslot;
      expect(slotA?.id && slotB?.id, "both sessions created").toBeTruthy();

      const { user } = await makeEnrolledParticipant(sa, csrf, comp.id, `slk${stamp}`);
      const { api, csrf: pc } = await apiLogin(user.email, PARTICIPANT_PASS);
      apiP = api;
      const PH = { "x-csrf-token": pc, "content-type": "application/json" };
      expect((await api.post("/api/select-competition", { headers: PH, data: { competitionId: comp.id } })).status()).toBe(200);
      const join = await api.post("/api/select-timeslot", { headers: PH, data: { timeslotId: slotA.id, confirmLive: true } });
      expect(join.status(), "the participant joins the live morning session").toBe(200);
      expect((await join.json()).ok).toBeTruthy();

      // Close the morning session.
      const endNow = await sa.post(`/api/admin/competitions/${comp.id}/timeslots/${slotA.id}/end-now`, { headers: H });
      expect(endNow.status(), "morning session ended").toBe(200);

      // PRECONDITION — the whole point is the ENDED branch. If slot A were still
      // live, the `live` half of the lock would produce the same 400 and this
      // test would say nothing about the branch it is named for.
      const slots = await (await sa.get(`/api/admin/competitions/${comp.id}/timeslots`)).json();
      expect(slots.find(s => s.id === slotA.id)?.status,
        "the participant's own session must be ENDED (not live) when the switch is attempted"
      ).toBe("ended");
      expect(slots.find(s => s.id === slotB.id)?.status,
        "and the target session must be selectable on its own merits"
      ).toBe("upcoming");

      const switchR = await api.post("/api/select-timeslot", { headers: PH, data: { timeslotId: slotB.id } });
      expect(switchR.status(),
        "a participant whose session has ENDED must not be able to move to the still-upcoming one — " +
        "that is a second run at the same challenges and a score split across two per-slot boards"
      ).toBe(400);
      // Deliberately the specific message: /cannot change your choice/i also
      // matches the v6.12.0 history-pinned lock, so it would not pin which guard
      // fired.
      expect((await switchR.json()).error).toMatch(/already entered a live session/i);

      const dbR = new Database(TEST_DB_PATH, { readonly: true });
      try {
        const row = dbR.prepare("SELECT timeslot_id FROM competition_users WHERE competition_id=? AND user_id=?")
          .get(comp.id, user.id);
        expect(row && row.timeslot_id, "and the pinned session is unchanged").toBe(slotA.id);
      } finally { dbR.close(); }
    } finally {
      if (apiP) await apiP.dispose();
      await sa.delete(`/api/admin/competitions/${comp.id}`, { headers: { "x-csrf-token": csrf } });
      await sa.dispose();
    }
  });
});
