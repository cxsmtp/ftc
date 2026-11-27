"use strict";

// MAIL WAITS WHILE MAINTENANCE MODE IS ON (operator ruling, 17 Nov 2026).
//
// A copied or restored database started with a working mail relay used to mail
// real people: the certificate dispatcher and the event-team report worker run
// at boot and on their timers whatever the installation's state. Both now ask
// the one maintenance resolver (server.js `_maintenanceState`) at the top of
// every pass: a held pass does nothing and leaves every job queued, so the copy
// and restore steps (README, RESTORE.txt), which start in maintenance, send
// nothing until it is lifted.
//
// The witness is a queued job each worker would DROP at once (its event has not
// ended, and it has no team): held, both rows stay; lifted, both are gone, which
// is also the control that the jobs were droppable. The tick hooks pass the
// maintenance gate with the bypass token, as an operator's own requests would.
//
// The start reminders and the lockout-expiry mail ask the same gate (operator
// ruling, 25 Nov 2026), and a start reminder is never mailed once its event or
// session has started: it is settled unsent with a `reminder_skipped` History
// row. The shared server's relay is dead, so `forceDelivered` stands in for a
// relay that took the mail, while `email_sent` still records each attempt.

const fs = require("fs");
const path = require("path");
const { test, expect } = require("./isolated-test");
const { BASE, TEST_DATA_DIR, TEST_DB_PATH, apiLogin } = require("./helpers");
const { H, makeCompetition, makeParticipant, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const sql = (fn) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
};

test("both mail workers hold while maintenance mode is on, and run once it is lifted", async ({ request }) => {
  const s = await apiLogin("superadmin");
  const comp = await makeCompetition(s.api, s.csrf, "mailhold");
  const due = new Date(Date.now() - 60_000).toISOString();
  sql(db => {
    db.prepare("INSERT INTO certificate_dispatch_jobs (competition_id, user_id, reason, due_at, enqueued_at) VALUES (?,?,?,?,?)")
      .run(comp.id, "", "event_end", due, due);
    db.prepare("INSERT INTO team_report_jobs (competition_id, kind, end_key, due_at, enqueued_at) VALUES (?,?,?,?,?)")
      .run(comp.id, "wrapup", "end:test", due, due);
  });
  const queued = () => sql(db => ({
    cert: db.prepare("SELECT COUNT(*) AS c FROM certificate_dispatch_jobs WHERE competition_id=?").get(comp.id).c,
    team: db.prepare("SELECT COUNT(*) AS c FROM team_report_jobs WHERE competition_id=?").get(comp.id).c,
  }));
  const tick = async (headers) => {
    const c = await request.post("/api/test/certificate-dispatch-tick", { headers, data: { force: true, competitionId: comp.id } });
    const t = await request.post("/api/test/team-report-tick", { headers, data: { force: true } });
    expect(c.ok() && t.ok(), `ticks answered ${c.status()} / ${t.status()}`).toBeTruthy();
    return { cert: await c.json(), team: await t.json() };
  };
  expect(queued(), "PRECONDITION: both jobs are queued and due").toEqual({ cert: 1, team: 1 });

  const token = `hold-${Date.now()}`;
  const file = path.join(TEST_DATA_DIR, ".maintenance");
  fs.writeFileSync(file, token);
  try {
    const held = await tick({ "X-Maintenance-Bypass": token });
    expect(held.cert.held, `the certificate pass held: ${JSON.stringify(held.cert)}`).toBe(true);
    expect(held.team.held, `the report pass held: ${JSON.stringify(held.team)}`).toBe(true);
    expect(queued(), "held, both jobs are still queued").toEqual({ cert: 1, team: 1 });
  } finally {
    fs.rmSync(file, { force: true });
  }

  const ran = await tick({});
  expect(ran.cert.held, `lifted, the certificate pass runs: ${JSON.stringify(ran.cert)}`).toBeUndefined();
  expect(ran.team.held, `lifted, the report pass runs: ${JSON.stringify(ran.team)}`).toBeUndefined();
  expect(queued(), "CONTROL: lifted, each worker drops its job (the event has not ended; it has no team)").toEqual({ cert: 0, team: 0 });
});

// ── Start reminders and the lockout-expiry mail ─────────────────────────────

const MAINT = path.join(TEST_DATA_DIR, ".maintenance");
const reminderRow = (userId, compId) => sql(db => db.prepare(
  "SELECT sent, claimed_at, claim_token FROM email_reminders WHERE user_id=? AND competition_id=?").get(userId, compId));
const plantReminder = (userId, compId, sendAt, extra = {}) => sql(db => db.prepare(
  "INSERT INTO email_reminders (user_id, competition_id, send_at, sent, created_at, timeslot_id, claimed_at, claim_token) VALUES (?,?,?,0,?,?,?,?)")
  .run(userId, compId, sendAt, new Date().toISOString(), extra.timeslotId || "", extra.claimedAt || null, extra.claimToken || null));
/** A user's events of one type, details parsed. */
const eventsOf = (userId, type) => sql(db => db.prepare(
  "SELECT details FROM user_events WHERE user_id=? AND event_type=? ORDER BY changed_at").all(userId, type))
  .map(r => { try { return JSON.parse(r.details); } catch (_) { return { unreadable: r.details }; } });
const reminderMails = (userId) => eventsOf(userId, "email_sent").filter(d => d.reason === "reminder");
const hourBefore = (iso) => new Date(new Date(iso).getTime() - 3600_000).toISOString();

test("start reminders hold while maintenance mode is on; lifted, one whose start (or session's start) is ahead is sent and one whose start has passed is settled unsent", async ({ request }) => {
  const s = await apiLogin("superadmin");
  const p1 = await makeParticipant(s.api, s.csrf, "remhold-a");
  const p2 = await makeParticipant(s.api, s.csrf, "remhold-stale");
  const p3 = await makeParticipant(s.api, s.csrf, "remhold-session");
  // A: upcoming. B: started a minute ago. C: live through its first session,
  // the participant's reminder for its SECOND, half an hour ahead.
  const startA = new Date(Date.now() + 30 * 60_000).toISOString();
  const A = await makeCompetition(s.api, s.csrf, "remhold-ahead", { start_time: startA });
  const B = await makeCompetition(s.api, s.csrf, "remhold-started");
  const C = await makeCompetition(s.api, s.csrf, "remhold-sessions");
  const slot = async (name, startIso) => {
    const r = await s.api.post(`/api/admin/competitions/${C.id}/timeslots`, { headers: H(s.csrf), data: { name, start_time: startIso, duration_minutes: 120 } });
    expect(r.ok(), `session ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
    return (await r.json()).timeslot;
  };
  const s1 = await slot("First", new Date(Date.now() - 60_000).toISOString());
  const s2 = await slot("Second", new Date(Date.now() + 30 * 60_000).toISOString());
  expect([s1.status, s2.status], "PRECONDITION: the event is live through its first session, the second ahead").toEqual(["live", "upcoming"]);
  await enrol(s.api, s.csrf, A.id, [p1.id, p2.id]);
  await enrol(s.api, s.csrf, B.id, [p1.id]);
  await enrol(s.api, s.csrf, C.id, [p3.id]);
  const startB = sql(db => db.prepare("SELECT start_time FROM competitions WHERE id=?").get(B.id).start_time);
  expect(new Date(startB).getTime(), "PRECONDITION: B has started").toBeLessThanOrEqual(Date.now());
  expect(new Date(sql(db => db.prepare("SELECT start_time FROM competitions WHERE id=?").get(C.id).start_time)).getTime(),
    "PRECONDITION: C's own start has passed (only its session's has not)").toBeLessThanOrEqual(Date.now());

  plantReminder(p1.id, A.id, hourBefore(startA));
  plantReminder(p1.id, B.id, hourBefore(startB));
  // A claim abandoned three minutes ago: the stale-claim sweep would free it, so
  // a held tick that swept would show here.
  const staleAt = new Date(Date.now() - 3 * 60_000).toISOString();
  plantReminder(p2.id, A.id, hourBefore(startA), { claimedAt: staleAt, claimToken: "stale-hold-witness" });
  plantReminder(p3.id, C.id, hourBefore(s2.start_time), { timeslotId: s2.id });
  const before = {
    a: reminderRow(p1.id, A.id), b: reminderRow(p1.id, B.id), stale: reminderRow(p2.id, A.id), c: reminderRow(p3.id, C.id),
  };
  expect(before, "PRECONDITION: four due reminders, one of them claimed by a crashed tick").toEqual({
    a: { sent: 0, claimed_at: null, claim_token: null }, b: { sent: 0, claimed_at: null, claim_token: null },
    stale: { sent: 0, claimed_at: staleAt, claim_token: "stale-hold-witness" }, c: { sent: 0, claimed_at: null, claim_token: null },
  });

  const token = `remhold-${Date.now()}`;
  fs.writeFileSync(MAINT, token);
  try {
    const r = await request.post("/api/test/reminder-tick", { headers: { "X-Maintenance-Bypass": token }, data: { forceDelivered: true } });
    expect(r.ok(), `held tick: ${r.status()}`).toBeTruthy();
    expect(await r.json(), "the held tick answers held and claims nothing").toEqual({ ok: true, ran: false, held: true, claimed: 0, delivered: 0, skipped: 0, started: 0 });
    expect({ a: reminderRow(p1.id, A.id), b: reminderRow(p1.id, B.id), stale: reminderRow(p2.id, A.id), c: reminderRow(p3.id, C.id) },
      "held, every row is as it was: nothing claimed, settled or swept").toEqual(before);
    for (const p of [p1, p2, p3]) {
      expect({ sent: eventsOf(p.id, "reminder_email_sent").length, skipped: eventsOf(p.id, "reminder_skipped").length, mailed: reminderMails(p.id).length },
        `held, nothing recorded or attempted for ${p.email}`).toEqual({ sent: 0, skipped: 0, mailed: 0 });
    }
  } finally {
    fs.rmSync(MAINT, { force: true });
  }

  const lifted = await (await request.post("/api/test/reminder-tick", { data: { forceDelivered: true } })).json();
  expect(lifted, "lifted: the three ahead are sent (the stale claim swept first), the started one settled unsent")
    .toEqual({ ok: true, ran: true, claimed: 4, delivered: 3, skipped: 0, started: 1 });
  // CONTROL: the held rows were deliverable.
  expect(eventsOf(p1.id, "reminder_email_sent").map(d => d.competition_id), "A's reminder was sent").toEqual([A.id]);
  expect(reminderMails(p1.id).map(d => d.competition_id), "…and mailed (an attempt for A only: B was never mailed)").toEqual([A.id]);
  expect(eventsOf(p2.id, "reminder_email_sent").map(d => d.competition_id), "the stale claim was swept, then sent").toEqual([A.id]);
  // The SESSION's start decides, not the event's: C began an hour ago through
  // its first session, and the reminder for the second goes out.
  expect(eventsOf(p3.id, "reminder_email_sent").map(d => [d.competition_id, d.timeslot_id]), "the later session's reminder is sent").toEqual([[C.id, s2.id]]);
  expect(eventsOf(p3.id, "reminder_skipped"), "…and not skipped").toEqual([]);
  // NEVER AFTER THE START: B's is settled without a mail, and says why.
  const skipped = eventsOf(p1.id, "reminder_skipped");
  expect(skipped.map(d => ({ competition_id: d.competition_id, reason: d.reason, timeslot_id: d.timeslot_id })), "one History row for B")
    .toEqual([{ competition_id: B.id, reason: "event_started", timeslot_id: null }]);
  expect(new Date(skipped[0].start_time).getTime(), "it names the start that had passed").toBe(new Date(startB).getTime());
  expect(reminderMails(p1.id).filter(d => d.competition_id === B.id), "B's reminder was never mailed").toEqual([]);
  for (const [who, row] of [["A", reminderRow(p1.id, A.id)], ["B", reminderRow(p1.id, B.id)], ["stale", reminderRow(p2.id, A.id)], ["C", reminderRow(p3.id, C.id)]]) {
    expect(row.sent, `${who}: settled`).toBe(1);
  }

  const again = await (await request.post("/api/test/reminder-tick", { data: { forceDelivered: true } })).json();
  expect(again.claimed, "a settled row is never claimed again").toBe(0);
  expect(eventsOf(p1.id, "reminder_skipped"), "…nor recorded twice").toHaveLength(1);
});

test("maintenance switched on mid-batch stops the reminder pass before its next claim", async ({ request }) => {
  const s = await apiLogin("superadmin");
  const q1 = await makeParticipant(s.api, s.csrf, "remmid-1");
  const q2 = await makeParticipant(s.api, s.csrf, "remmid-2");
  const start = new Date(Date.now() + 30 * 60_000).toISOString();
  const D = await makeCompetition(s.api, s.csrf, "remmid", { start_time: start });
  await enrol(s.api, s.csrf, D.id, [q1.id, q2.id]);
  plantReminder(q1.id, D.id, hourBefore(start));
  plantReminder(q2.id, D.id, hourBefore(start));
  const rows = () => [reminderRow(q1.id, D.id), reminderRow(q2.id, D.id)];
  const claimedNow = () => sql(db => db.prepare("SELECT COUNT(*) AS n FROM email_reminders WHERE competition_id=? AND claimed_at IS NOT NULL").get(D.id).n);
  expect(claimedNow(), "PRECONDITION: nothing claimed").toBe(0);

  // The first claim parks after composing (2 s); maintenance goes on meanwhile.
  const tick = request.post("/api/test/reminder-tick", { data: { delayMs: 2000, forceDelivered: true } });
  const token = `remmid-${Date.now()}`;
  let out;
  try {
    await expect.poll(claimedNow, { timeout: 5000, intervals: [50], message: "the first row is claimed and parked" }).toBe(1);
    fs.writeFileSync(MAINT, token);
    out = await (await tick).json();
  } finally {
    fs.rmSync(MAINT, { force: true });
  }
  expect(out, "the pass stopped before its second claim, and says it held").toEqual({ ok: true, ran: true, held: true, claimed: 1, delivered: 1, skipped: 0, started: 0 });
  const after = rows();
  expect(after.filter(r => r.sent === 1), "exactly one row went out").toHaveLength(1);
  expect(after.find(r => r.sent === 0), "the other is untouched: not claimed, not settled").toEqual({ sent: 0, claimed_at: null, claim_token: null });

  // CONTROL: it was deliverable; only the hold kept it.
  const next = await (await request.post("/api/test/reminder-tick", { data: { forceDelivered: true } })).json();
  expect(next, "lifted, the held row goes out").toEqual({ ok: true, ran: true, claimed: 1, delivered: 1, skipped: 0, started: 0 });
  expect(rows().map(r => r.sent), "both sent").toEqual([1, 1]);
});

test("a reminder settled unsent is never consumed without its History row: a failed record releases the claim for the next tick", async ({ request }) => {
  const s = await apiLogin("superadmin");
  const p = await makeParticipant(s.api, s.csrf, "remtxn");
  const E = await makeCompetition(s.api, s.csrf, "remtxn");   // started a minute ago
  await enrol(s.api, s.csrf, E.id, [p.id]);
  const startE = sql(db => db.prepare("SELECT start_time FROM competitions WHERE id=?").get(E.id).start_time);
  plantReminder(p.id, E.id, hourBefore(startE));
  // The record fails for this one participant only: a trigger refuses the row.
  const trig = `remtxn_${Date.now()}`;
  sql(db => db.exec(`CREATE TRIGGER ${trig} BEFORE INSERT ON user_events WHEN NEW.event_type='reminder_skipped' AND NEW.user_id='${p.id}' BEGIN SELECT RAISE(ABORT, 'refused by test'); END;`));
  try {
    const out = await (await request.post("/api/test/reminder-tick", { data: { forceDelivered: true } })).json();
    expect(out, "claimed, then neither sent nor settled").toEqual({ ok: true, ran: true, claimed: 1, delivered: 0, skipped: 0, started: 0 });
    expect(reminderRow(p.id, E.id), "the settle rolled back with its record, and the claim was released").toEqual({ sent: 0, claimed_at: null, claim_token: null });
    expect(eventsOf(p.id, "reminder_skipped"), "no record").toEqual([]);
    expect(reminderMails(p.id), "and no mail").toEqual([]);
  } finally {
    sql(db => db.exec(`DROP TRIGGER IF EXISTS ${trig}`));
  }
  // CONTROL: the next tick settles it, with its record.
  const next = await (await request.post("/api/test/reminder-tick", { data: { forceDelivered: true } })).json();
  expect(next, "the next tick settles it").toEqual({ ok: true, ran: true, claimed: 1, delivered: 0, skipped: 0, started: 1 });
  expect(reminderRow(p.id, E.id).sent).toBe(1);
  expect(eventsOf(p.id, "reminder_skipped").map(d => d.competition_id)).toEqual([E.id]);
  expect(reminderMails(p.id), "still never mailed").toEqual([]);
});

test("the lockout-expiry pass holds while maintenance mode is on: the lapsed lock is kept and nobody is mailed until it is lifted", async ({ request }) => {
  const s = await apiLogin("superadmin");
  const p = await makeParticipant(s.api, s.csrf, "unlockhold");
  const lapsed = new Date(Date.now() - 1000).toISOString();
  sql(db => db.prepare("UPDATE users SET locked_until=?, failed_login_count=10, failed_login_first=? WHERE id=?").run(lapsed, lapsed, p.id));
  const lock = () => sql(db => db.prepare("SELECT locked_until, failed_login_count FROM users WHERE id=?").get(p.id));
  const unlockMails = () => eventsOf(p.id, "email_sent").filter(d => d.reason === "unlock");
  expect(lock(), "PRECONDITION: a lock that has lapsed").toEqual({ locked_until: lapsed, failed_login_count: 10 });

  const token = `unlockhold-${Date.now()}`;
  fs.writeFileSync(MAINT, token);
  try {
    const r = await request.post("/api/test/lockout-expiry-tick", { headers: { "X-Maintenance-Bypass": token }, data: {} });
    expect(r.ok(), `held pass: ${r.status()}`).toBeTruthy();
    expect(await r.json(), "the held pass touches nothing").toEqual({ ok: true, ran: false, held: true, unlocked: 0 });
    expect(lock(), "held, the lock keeps its state").toEqual({ locked_until: lapsed, failed_login_count: 10 });
    expect(eventsOf(p.id, "auto_unlocked"), "held, nothing recorded").toEqual([]);
  } finally {
    fs.rmSync(MAINT, { force: true });
  }
  // The pass is synchronous up to its detached mail, which it starts only for a
  // lock it cleared: the kept lock and the missing record above are the witness.
  expect(unlockMails(), "held, no unlock mail was attempted").toEqual([]);

  const out = await (await request.post("/api/test/lockout-expiry-tick", { data: {} })).json();
  expect(out, "lifted, the lapsed lock is cleared").toEqual({ ok: true, ran: true, unlocked: 1 });
  expect(lock(), "…the lock gone").toEqual({ locked_until: null, failed_login_count: 0 });
  expect(eventsOf(p.id, "auto_unlocked").map(d => d.reason), "…recorded").toEqual(["lockout_expired"]);
  await expect.poll(() => unlockMails().length, { timeout: 5000, message: "…and the unlock mail attempted" }).toBe(1);
});
