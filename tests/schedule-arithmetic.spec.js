// v7.29.0 — locks for the schedule-arithmetic sites that had NONE.
//
// PR 7 hoists `start_time + duration_minutes * 60_000` out of ~21 hand-rolled
// server-side sites into one named helper, and its stated verification is "the
// full suite passes untouched". Measured, that claim does not hold: EIGHT of the
// nineteen sites the plan enumerates have no behavioural lock at all, so a
// regression at any of them would be silent and the green suite would mean
// nothing about them.
//
// These are those sites. They are written BEFORE the hoist deliberately — a lock
// added afterwards proves the new code agrees with itself, not that it agrees
// with what shipped. Each asserts the VALUE, not merely that something happened,
// because "an event was emitted" survives arithmetic that is off by an hour.
//
// Covered here (4): lib/scheduler.js:93 and :130 (the `scheduled_end` written
// into an auto_ended audit event), routes/competitions.js:587 (the time-expired
// re-arm of the status observation), routes/participants.js:324 (the
// assign-driven SLOT revive). The five email-body sites are in the companion
// spec, which needs a capturing SMTP server.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, TEST_DB_PATH } = require("./helpers");

const h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const iso = (ms) => new Date(ms).toISOString();

// The concept under test, written out longhand ON PURPOSE. If this file imported
// the helper the hoist introduces, it would assert the new code against itself
// and could not detect the hoist changing the answer.
const scheduledEnd = (startIso, minutes) => new Date(startIso).getTime() + minutes * 60_000;

test.describe("v7.29.0 — schedule arithmetic that nothing was asserting", () => {
  const Database = require("better-sqlite3");

  async function makeComp(api, csrf, { name, startMs, minutes }) {
    const r = await api.post("/api/admin/competitions", {
      headers: h(csrf),
      data: { name, start_time: iso(startMs), duration_minutes: minutes, timezone: "UTC" },
    });
    expect(r.ok(), `create ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
    return (await r.json()).competition.id;
  }

  // lib/scheduler.js:93 — the competition auto_ended event's scheduled_end.
  // `scheduled_end` appears in ZERO specs today, so the value written into the
  // forensic record for every time-expired competition is unasserted.
  test("the scheduler records the competition's real scheduled end on auto_ended", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = Date.now();
    // Time-expired: started 3h ago, ran 45 minutes. A non-round duration so an
    // off-by-an-hour or a minutes/seconds slip cannot land on the right answer.
    const startMs = stamp - 3 * 3600_000;
    const minutes = 45;
    // Created LIVE and observed once first: the scheduler records a first sighting
    // and `continue`s, so an entity born already-ended never TRANSITIONS and emits
    // nothing (v7.15.11). Only the live→ended step produces the event under test.
    const compId = await makeComp(api, csrf, { name: `SchedEnd ${stamp}`, startMs: stamp - 60_000, minutes: 600 });
    expect((await api.post("/api/test/scheduler-tick", { headers: h(csrf), data: {} })).ok()).toBeTruthy();
    { const db0 = new Database(TEST_DB_PATH);
      try { db0.prepare("UPDATE competitions SET start_time=?, duration_minutes=? WHERE id=?").run(iso(startMs), minutes, compId); }
      finally { db0.close(); } }

    const tick = await api.post("/api/test/scheduler-tick", { headers: h(csrf), data: {} });
    expect(tick.ok(), `tick: ${tick.status()} ${await tick.text()}`).toBeTruthy();

    const db = new Database(TEST_DB_PATH);
    let ev;
    try {
      ev = db.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type='auto_ended'").get(compId);
    } finally { db.close(); }
    expect(ev, "a time-expired competition is auto-ended by the tick").toBeTruthy();
    const d = JSON.parse(ev.details);
    expect(d.scheduled_end, "the recorded end is start + duration, to the millisecond")
      .toBe(iso(scheduledEnd(iso(startMs), minutes)));
    await api.dispose();
  });

  // lib/scheduler.js:130 — the same value for a SESSION. A separate expression on
  // a separate row type, so one lock cannot stand in for the other.
  test("the scheduler records a session's real scheduled end on auto_ended", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = Date.now();
    // The parent must still be live, or the competition-level branch ends it
    // first and the session branch is not what we are measuring.
    const compId = await makeComp(api, csrf, { name: `SchedEndTs ${stamp}`, startMs: stamp - 3600_000, minutes: 600 });

    const slotStartMs = stamp - 2 * 3600_000;
    const slotMinutes = 25;
    // Same first-sighting rule as above: create it LIVE, observe, then expire it.
    const ts = await api.post(`/api/admin/competitions/${compId}/timeslots`, {
      headers: h(csrf),
      data: { name: `Slot ${stamp}`, start_time: iso(stamp - 60_000), duration_minutes: 600, timezone: "UTC" },
    });
    expect(ts.ok(), `slot: ${ts.status()} ${await ts.text()}`).toBeTruthy();
    const tsBody = await ts.json();
    const tsId = tsBody.timeslot?.id || tsBody.id;
    expect(tsId, "the session id is in the create response").toBeTruthy();
    expect((await api.post("/api/test/scheduler-tick", { headers: h(csrf), data: {} })).ok()).toBeTruthy();
    { const db0 = new Database(TEST_DB_PATH);
      try { db0.prepare("UPDATE competition_timeslots SET start_time=?, duration_minutes=? WHERE id=?").run(iso(slotStartMs), slotMinutes, tsId); }
      finally { db0.close(); } }

    const tick = await api.post("/api/test/scheduler-tick", { headers: h(csrf), data: {} });
    expect(tick.ok()).toBeTruthy();

    const db = new Database(TEST_DB_PATH);
    let ev;
    try {
      ev = db.prepare("SELECT details FROM timeslot_events WHERE timeslot_id=? AND event_type='auto_ended'").get(tsId);
    } finally { db.close(); }
    expect(ev, "a time-expired session is auto-ended by the tick").toBeTruthy();
    expect(JSON.parse(ev.details).scheduled_end)
      .toBe(iso(scheduledEnd(iso(slotStartMs), slotMinutes)));
    await api.dispose();
  });

  // routes/competitions.js:587 — the time-expired re-arm.
  //
  // After a revive, the status observation is only re-synced when the NEW
  // scheduled end is still in the future. Get that arithmetic wrong and the
  // re-sync either never fires (the scheduler will not observe the competition
  // again) or fires for a competition that is still over. Only a source lock
  // covered this; nothing asserted the boundary.
  test("extending a time-expired competition past now re-arms its status observation", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = Date.now();
    const startMs = stamp - 2 * 3600_000;
    const compId = await makeComp(api, csrf, { name: `Rearm ${stamp}`, startMs, minutes: 30 }); // ended

    // Let the scheduler observe it as ended, so there is an observation to re-arm.
    await api.post("/api/test/scheduler-tick", { headers: h(csrf), data: {} });
    const before = await (await api.get(`/api/admin/competitions`)).json();
    const row = before.find(c => c.id === compId);
    expect(row.status, "it really is ended before we extend").toBe("ended");

    // Extend so the scheduled end is comfortably in the future.
    const put = await api.put(`/api/admin/competitions/${compId}`, {
      headers: h(csrf),
      data: { duration_minutes: 600, expectedUpdatedAt: row.updated_at },
    });
    expect(put.ok(), `extend: ${put.status()} ${await put.text()}`).toBeTruthy();

    const after = (await (await api.get(`/api/admin/competitions`)).json()).find(c => c.id === compId);
    expect(after.status, "a time-expired competition revives on extend").toBe("live");

    // The re-arm is what lets the scheduler auto-end it AGAIN later. Observable:
    // the observation row is back to a non-ended status for this id.
    const db = new Database(TEST_DB_PATH);
    try {
      const obs = db.prepare("SELECT last_status FROM entity_status_observations WHERE entity_type='competition' AND entity_id=?").get(compId);
      expect(obs, "the observation exists").toBeTruthy();
      expect(obs.last_status, "and no longer says ended, or the tick will never look at it again").not.toBe("ended");
    } finally { db.close(); }
    await api.dispose();
  });

  // routes/participants.js:324 — the assign-driven SLOT revive.
  //
  // Adding participants to a competition revives any auto-ended session whose
  // scheduled end is still in the future. Nothing asserted the boundary, so a
  // slip here either resurrects a session that is genuinely over or fails to
  // revive one the admin has just added people to.
  test("assigning participants revives an auto-ended session whose scheduled end is still ahead", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    const stamp = Date.now();
    const compId = await makeComp(api, csrf, { name: `SlotRevive ${stamp}`, startMs: stamp - 3600_000, minutes: 600 });

    // A session that started an hour ago and runs for ten more — so its SCHEDULED
    // end is in the future — which we then end by hand-clearing ended_manually
    // after an end-now, i.e. exactly the auto-ended shape the revive looks for.
    const tsRes = await api.post(`/api/admin/competitions/${compId}/timeslots`, {
      headers: h(csrf),
      data: { name: `Slot ${stamp}`, start_time: iso(stamp - 3600_000), duration_minutes: 660, timezone: "UTC" },
    });
    expect(tsRes.ok(), `slot: ${tsRes.status()} ${await tsRes.text()}`).toBeTruthy();
    const body = await tsRes.json();
    const tsId = body.timeslot?.id || body.id;

    const db = new Database(TEST_DB_PATH);
    try {
      // auto-ended: ended_at set, ended_manually 0, scheduled end still ahead.
      db.prepare("UPDATE competition_timeslots SET ended_at=?, ended_manually=0 WHERE id=?")
        .run(new Date().toISOString(), tsId);
    } finally { db.close(); }

    // OWN the participant (standing rule 1). Picking one out of the seeded pool
    // flakes: POST /api/admin/competitions/assign SILENTLY SKIPS staff, benchmark,
    // blocked and unapproved users, so if the first match happens to carry a
    // `staff` tag the assign succeeds, touches nothing, and the revive never runs
    // — surfacing as a failed revive assertion that says nothing about the cause.
    // Seen once on a full-suite run before this was fixed.
    const { api: reg, csrf: regCsrf } = await freshCtx();
    const pEmail = `slotrev-${stamp}@company.co`;
    const rr = await registerPost(reg, "/api/register", {
      headers: h(regCsrf),
      data: {
        firstName: "Slot", lastName: "Rev", nickname: `slotrev_${stamp}`,
        company: "C", title: "T", country: "US", timezone: "UTC",
        email: pEmail, password: "chosen-at-signup-1",
      },
    });
    expect(rr.ok(), `register: ${rr.status()} ${await rr.text()}`).toBeTruthy();
    await reg.dispose();
    let pid;
    { const dbu = new Database(TEST_DB_PATH);
      try {
        pid = dbu.prepare("SELECT id FROM users WHERE email=?").get(pEmail).id;
        dbu.prepare("UPDATE users SET verified=1, approved=1 WHERE id=?").run(pid);
      } finally { dbu.close(); } }

    const asg = await api.post("/api/admin/competitions/assign", {
      headers: h(csrf), data: { competitionIds: [compId], userIds: [pid] },
    });
    expect(asg.ok(), `assign: ${asg.status()} ${await asg.text()}`).toBeTruthy();
    // Assert the PRECONDITION: a skipped assign is a success with nothing done,
    // and the revive assertion below would then fail for the wrong reason.
    expect((await asg.json()).assigned, "the participant was really assigned, not skipped").toBe(1);

    const db2 = new Database(TEST_DB_PATH);
    try {
      const ts = db2.prepare("SELECT ended_at FROM competition_timeslots WHERE id=?").get(tsId);
      expect(ts.ended_at, "the session is revived, because its scheduled end has not passed").toBeNull();
    } finally { db2.close(); }
    await api.dispose();
  });

  // v7.29.0 — the hoist's lasting guard.
  //
  // NOT a column-name match. `duration_minutes` appears on 92 server-side lines
  // and only ~20 were ever arithmetic, so a scanner keyed on the column would be
  // red against ~72 correct lines on day one — and a scanner that is wrong about
  // working code gets silenced by whoever hits it next. Two narrow patterns
  // instead, each matching the SHAPE of the thing being forbidden.
  test("nothing re-invents start + duration", () => {
    const fs = require("fs"), pathMod = require("path");
    const root = pathMod.join(__dirname, "..");
    const strip = src => src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, m => m.replace(/[^\n]/g, " "));
    const walk = (dir) => fs.readdirSync(pathMod.join(root, dir))
      .filter(f => f.endsWith(".js")).map(f => `${dir}/${f}`);
    const files = ["server.js", "db.js", ...walk("routes"), ...walk("lib")];

    const offenders = [];
    for (const f of files) {
      // lib/competitions.js OWNS the expression — it is the helper's body.
      if (f === "lib/competitions.js") continue;
      const src = strip(fs.readFileSync(pathMod.join(root, f), "utf8"));
      src.split("\n").forEach((line, i) => {
        // (1) the column multiplied by a minute.
        if (/duration_minutes\s*(\|\|\s*\d+\s*\))?\s*\*\s*60(_?000)?\b/.test(line)) {
          offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
          return;
        }
        // (2) the DERIVED-VARIABLE form, which pattern (1) structurally cannot
        // see. Two live sites hid here — the shrink-to-past detector that
        // force-ends a live competition, and the perf seeder — so the hoist that
        // exists to give this concept a name would have skipped them.
        if (/\b\w*[Dd]ur(ation)?\w*\s*\*\s*60_?000\b/.test(line)) {
          offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
        }
      });
    }
    expect(offenders,
      "use scheduledEnd(row) from lib/competitions. If a site genuinely needs different " +
      "clamping (lib/comp-allowlist._endMs does), call the helper for the ARITHMETIC and " +
      "keep the difference local, with the reason written down."
    ).toEqual([]);
  });
});
