// @ts-check
//
// A START REMINDER NAMES THE EVENT AND SESSION AS THEY ARE WHEN IT IS COMPOSED.
//
// A dispatcher pass reads every due row once, then claims and mails them one
// at a time, awaiting each send. An organiser who renames the event or the
// session while a roster's batch is going out must not have the rest of the
// roster told the old name (*Wording at send time*). The names are re-read
// after each row's claim.
//
// The witness: two participants, one session, one due batch. The test-only
// tick's `delayMs` parks each row after composing it and before sending it, so
// while the FIRST row is parked the event and its session are renamed through
// the admin routes; the SECOND row, still unclaimed then (checked), must carry
// the new names. The first row, composed before the rename, carries the old
// ones: the control that the rename really landed mid-batch. Read through
// `user_events.email_sent`, which records the composed subject, as the other
// reminder specs read it.
const { test, expect } = require("./isolated-test");
const { apiLogin, TEST_DB_PATH } = require("./helpers");
const { makeParticipant, makeCompetition, enrol } = require("./event-admin-helpers");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

test("a rename while a reminder batch is going out reaches every mail composed after it", async () => {
  test.setTimeout(90_000);
  const Database = require("better-sqlite3");
  const sql = (fn) => { const db = new Database(TEST_DB_PATH); try { return fn(db); } finally { db.close(); } };
  const { api, csrf } = await apiLogin("superadmin");
  try {
    const at = (ms) => new Date(Date.now() + ms).toISOString();
    const comp = await makeCompetition(api, csrf, "rem-rename", { start_time: at(3 * 3600_000) });
    const oldSlot = `Morning ${Date.now()}`;
    const ts = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, { headers: H(csrf), data: { name: oldSlot, start_time: at(3600_000), duration_minutes: 60 } });
    expect(ts.ok(), `session: ${ts.status()} ${await ts.text()}`).toBeTruthy();
    const slotId = (await ts.json()).timeslot.id;
    const a = await makeParticipant(api, csrf, "remrn-a");
    const b = await makeParticipant(api, csrf, "remrn-b");
    await enrol(api, csrf, comp.id, [a.id, b.id]);
    const due = new Date(Date.now() - 60_000).toISOString();
    sql((db) => {
      for (const u of [a, b]) {
        db.prepare("UPDATE competition_users SET timeslot_id=? WHERE competition_id=? AND user_id=?").run(slotId, comp.id, u.id);
        db.prepare("INSERT INTO email_reminders (user_id, competition_id, send_at, sent, created_at, timeslot_id) VALUES (?,?,?,0,?,?)").run(u.id, comp.id, due, due, slotId);
      }
    });
    const claimed = () => sql((db) => db.prepare("SELECT user_id FROM email_reminders WHERE competition_id=? AND claimed_at IS NOT NULL").all(comp.id).map((r) => r.user_id));

    const tick = api.post("/api/test/reminder-tick", { headers: H(csrf), data: { delayMs: 3000, forceDelivered: true } });
    // Park, then act: the first row is claimed (and, everything up to the park
    // being synchronous, composed and parked) while the second is not.
    const deadline = Date.now() + 10_000;
    let first = [];
    while (Date.now() < deadline && (first = claimed()).length !== 1) await new Promise((r) => setTimeout(r, 20));
    expect(first, "PRECONDITION: exactly one row claimed, the other waiting").toHaveLength(1);

    const newComp = `${comp.name} renamed`;
    const newSlot = `${oldSlot} renamed`;
    const rc = await api.put(`/api/admin/competitions/${comp.id}`, { headers: H(csrf), data: { name: newComp } });
    expect(rc.ok(), `rename event: ${rc.status()} ${await rc.text()}`).toBeTruthy();
    const rs = await api.put(`/api/admin/competitions/${comp.id}/timeslots/${slotId}`, { headers: H(csrf), data: { name: newSlot } });
    expect(rs.ok(), `rename session: ${rs.status()} ${await rs.text()}`).toBeTruthy();
    expect(claimed(), "PRECONDITION: the renames landed before the second row was claimed").toEqual(first);

    const t = await tick;
    expect(t.ok(), `tick: ${t.status()} ${await t.text()}`).toBeTruthy();
    expect((await t.json()).delivered, "both rows went out").toBe(2);

    const subjectOf = (uid) => sql((db) => {
      for (const row of db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='email_sent'").all(uid)) {
        let d; try { d = JSON.parse(row.details); } catch (_) { continue; }
        if (d && d.reason === "reminder") return d.subject;
      }
      return null;
    });
    const firstId = first[0];
    const secondId = firstId === a.id ? b.id : a.id;
    const s1 = subjectOf(firstId);
    const s2 = subjectOf(secondId);
    expect(s1, "CONTROL: the row composed before the rename names the event as it was").toContain(`${comp.name} (${oldSlot})`);
    expect(s2, "the row composed after the rename names the event and session as they are").toContain(`${newComp} (${newSlot})`);
    const sent = sql((db) => db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='reminder_email_sent'").get(secondId));
    expect(JSON.parse(sent.details).competition_name, "the History record names it as mailed").toBe(newComp);
  } finally { await api.dispose(); }
});
