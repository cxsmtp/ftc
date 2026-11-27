// v7.29.0 — the reminder subject is plain text, and the session name is escaped
// exactly once.
//
// The highest-volume message a live event sends had two defects in one line.
// `sessionLabel` escaped the session name, `fullName` concatenated it, and the
// BODY escaped the result again — so a session called "A&B" reached the inbox as
// "A&amp;amp;B". And the SUBJECT was HTML-escaped at all, which is simply wrong:
// a subject line is not HTML, so a competition called "Dev & Sec Day" was
// announced as "Dev &amp; Sec Day".
//
// Asserted through `user_events.email_sent`, which records the composed subject.
// That is the half a recipient triages on, and it is reachable on the shared
// server; the body's single-escape is a byte-level property that would need the
// capturing SMTP server, and is stated in CLAUDE.md rather than locked here.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, TEST_DB_PATH } = require("./helpers");

const h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

test("v7.29.0: a reminder subject carries the real name, not HTML entities", async () => {
  const Database = require("better-sqlite3");
  const { api, csrf } = await apiLogin("superadmin");
  const stamp = Date.now();
  // Ampersand and angle brackets: every character escapeHtml would touch.
  const compName = `Dev & Sec <Day> ${stamp}`;

  const cr = await api.post("/api/admin/competitions", {
    headers: h(csrf),
    data: {
      name: compName,
      start_time: new Date(Date.now() + 60 * 60_000).toISOString(),
      duration_minutes: 60, timezone: "UTC",
    },
  });
  expect(cr.ok(), `create: ${cr.status()} ${await cr.text()}`).toBeTruthy();
  const compId = (await cr.json()).competition.id;

  // Own participant (standing rule 1) — and the assign endpoint silently skips
  // staff/benchmark, so a seeded pick would flake.
  const { api: reg, csrf: regCsrf } = await freshCtx();
  const email = `rem-${stamp}@company.co`;
  const rr = await registerPost(reg, "/api/register", {
    headers: h(regCsrf),
    data: {
      firstName: "Rem", lastName: "Ind", nickname: `rem_${stamp}`,
      company: "C", title: "T", country: "US", timezone: "UTC",
      email, password: "chosen-at-signup-1",
    },
  });
  expect(rr.ok(), `register: ${rr.status()} ${await rr.text()}`).toBeTruthy();
  await reg.dispose();

  let uid;
  { const db = new Database(TEST_DB_PATH);
    try {
      uid = db.prepare("SELECT id FROM users WHERE email=?").get(email).id;
      db.prepare("UPDATE users SET verified=1, approved=1 WHERE id=?").run(uid);
    } finally { db.close(); } }

  const asg = await api.post("/api/admin/competitions/assign", {
    headers: h(csrf), data: { competitionIds: [compId], userIds: [uid] },
  });
  expect(asg.ok(), `assign: ${asg.status()} ${await asg.text()}`).toBeTruthy();
  expect((await asg.json()).assigned, "the participant was assigned, not skipped").toBe(1);

  // The participant asks for their own reminder — the route is participant-only.
  // (v8.12.4: the superadmin used to ask first "in case", but the built-in
  // account has no user row, so that request was refused every time and only
  // the fallback ever ran.) Then make it due and drive one dispatcher tick.
  const { api: pApi, csrf: pCsrf } = await apiLogin(email, "chosen-at-signup-1");
  try {
    const r2 = await pApi.post(`/api/competitions/${compId}/reminder`, { headers: h(pCsrf), data: {} });
    expect(r2.ok(), `reminder: ${r2.status()} ${await r2.text()}`).toBeTruthy();
  } finally { await pApi.dispose(); }
  { const db = new Database(TEST_DB_PATH);
    try { db.prepare("UPDATE email_reminders SET send_at=? WHERE competition_id=?")
      .run(new Date(Date.now() - 60_000).toISOString(), compId); }
    finally { db.close(); } }

  const tick = await api.post("/api/test/reminder-tick", { headers: h(csrf), data: { forceDelivered: true } });
  expect(tick.ok(), `tick: ${tick.status()} ${await tick.text()}`).toBeTruthy();

  let subject = null;
  for (let i = 0; i < 50 && !subject; i++) {
    const db = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const rows = db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='email_sent'").all(uid);
      for (const row of rows) {
        let d; try { d = JSON.parse(row.details); } catch { continue; }
        if (d && d.reason === "reminder") { subject = d.subject; break; }
      }
    } finally { db.close(); }
    if (!subject) await new Promise(r => setTimeout(r, 100));
  }
  expect(subject, "the reminder was composed").toBeTruthy();
  expect(subject, "a subject line is not HTML").not.toMatch(/&amp;|&lt;|&gt;/);
  expect(subject, "it carries the name the admin typed").toContain(compName);
  await api.dispose();
});

// No reminder is mailed once its event or session has started (operator ruling,
// 25 Nov 2026), and the dispatcher runs every 30 s, so a reminder asked for in
// the last minute would be accepted, promised "on its way now", then skipped.
// It is refused instead (400 `start_reminder_too_late`), judged by the start the
// reminder is for: the participant's SESSION where they have one. A refusal
// leaves an existing reminder as it was.
test("a reminder asked for under a minute before the start (the session's start where there is one) is refused by name, and touches nothing", async () => {
  const Database = require("better-sqlite3");
  const { makeParticipant, makeCompetition, enrol } = require("./event-admin-helpers");
  const sql = (fn) => { const db = new Database(TEST_DB_PATH); try { return fn(db); } finally { db.close(); } };
  const { api, csrf } = await apiLogin("superadmin");
  const p = await makeParticipant(api, csrf, "remlate");
  // Everything is made hours ahead: the setup below (enrolments, a code sign-in)
  // can take a while on a loaded runner, and an event that went live meanwhile
  // would be refused for being live, not for being too close. The near starts are
  // written just before the asks.
  const soon = await makeCompetition(api, csrf, "remlate-soon", { start_time: new Date(Date.now() + 3 * 3600_000).toISOString() });
  const later = await makeCompetition(api, csrf, "remlate-later", { start_time: new Date(Date.now() + 3 * 3600_000).toISOString() });
  // A sessioned event whose own start is two hours off, while the participant's
  // session will start in 40 seconds.
  const sess = await makeCompetition(api, csrf, "remlate-session", { start_time: new Date(Date.now() + 2 * 3600_000).toISOString() });
  const ts = await api.post(`/api/admin/competitions/${sess.id}/timeslots`, { headers: h(csrf), data: { name: "Soon", start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 } });
  expect(ts.ok(), `session: ${ts.status()} ${await ts.text()}`).toBeTruthy();
  const slotId = (await ts.json()).timeslot.id;
  for (const c of [soon, later, sess]) await enrol(api, csrf, c.id, [p.id]);
  sql(db => db.prepare("UPDATE competition_users SET timeslot_id=? WHERE competition_id=? AND user_id=?").run(slotId, sess.id, p.id));
  // An earlier reminder for `soon`, standing: the refusal must not clear it.
  const planted = new Date(Date.now() - 3600_000).toISOString();
  sql(db => db.prepare("INSERT INTO email_reminders (user_id, competition_id, send_at, sent, created_at, timeslot_id) VALUES (?,?,?,0,?,'')").run(p.id, soon.id, planted, planted));
  const rowOf = (compId) => sql(db => db.prepare("SELECT send_at, sent FROM email_reminders WHERE user_id=? AND competition_id=?").get(p.id, compId) || null);

  const { api: pApi, csrf: pCsrf } = await apiLogin(p.email);
  try {
    // Now the near starts: `soon` and the session in 40 s, the control in 5 min.
    // The server keeps an event row for up to 1 s (`_competitionCache`), so the
    // asks wait that out; sessions are read fresh.
    const startIn = (ms) => new Date(Date.now() + ms).toISOString();
    sql(db => {
      db.prepare("UPDATE competitions SET start_time=? WHERE id=?").run(startIn(40_000), soon.id);
      db.prepare("UPDATE competitions SET start_time=? WHERE id=?").run(startIn(5 * 60_000), later.id);
      db.prepare("UPDATE competition_timeslots SET start_time=? WHERE id=?").run(startIn(40_000), slotId);
    });
    await new Promise(r => setTimeout(r, 1100));
    const ahead = sql(db => ({
      soon: Date.parse(db.prepare("SELECT start_time FROM competitions WHERE id=?").get(soon.id).start_time) - Date.now(),
      slot: Date.parse(db.prepare("SELECT start_time FROM competition_timeslots WHERE id=?").get(slotId).start_time) - Date.now(),
    }));
    expect(ahead.soon > 5_000 && ahead.slot > 5_000, `PRECONDITION: both starts are still ahead and under a minute away: ${JSON.stringify(ahead)}`).toBe(true);
    const ask = async (compId) => { const r = await pApi.post(`/api/competitions/${compId}/reminder`, { headers: h(pCsrf), data: {} }); return { status: r.status(), body: await r.json() }; };
    expect(await ask(soon.id), "40 seconds before the start: refused by name").toEqual({ status: 400, body: {
      code: "start_reminder_too_late", error: "This event starts in under a minute, so there is no time left to send a reminder." } });
    expect(rowOf(soon.id), "…and the reminder already set stands").toEqual({ send_at: planted, sent: 0 });
    const s = await ask(sess.id);
    expect({ status: s.status, code: s.body.code }, "the session starts in 40 seconds, though the event is two hours off: refused").toEqual({ status: 400, code: "start_reminder_too_late" });
    expect(rowOf(sess.id), "…nothing stored").toBeNull();
    // CONTROL: five minutes before the start there is time, and it goes now.
    expect(await ask(later.id), "five minutes off: accepted, sent at the next dispatch").toEqual({ status: 200, body: { ok: true, requested: true, immediate: true } });
    expect(rowOf(later.id), "…and stored").toMatchObject({ sent: 0 });
  } finally { await pApi.dispose(); await api.dispose(); }
});

// A reminder settled unsent (its start had passed) is recorded as
// `reminder_skipped`: the participant's History and the Audit page each say so
// in words, escaping the event's name.
test("a skipped start reminder reads as such on History and the Audit page", async ({ page }) => {
  await page.goto(require("./helpers").BASE + "/");
  await page.waitForFunction(() => typeof window.formatEventChange === "function" && typeof window.auditActivityLabel === "function");
  const r = await page.evaluate(() => ({
    hist: window.formatEventChange({ event_type: "reminder_skipped", details: { competition_name: "Dev <b>&</b> Sec", reason: "event_started" } }),
    audit: window.auditActivityLabel("reminder_skipped", {}),
    control: window.auditActivityLabel("reminder_email_sent", {}),
  }));
  expect(r.hist.replace(/<[^>]+>/g, ""), "History says it was not sent, and why").toBe("Start reminder for Dev &lt;b&gt;&amp;&lt;/b&gt; Sec not sent: it had already started");
  expect(r.hist, "the event's name is escaped").not.toContain("<b>&</b>");
  expect(r.audit).toBe("Reminder not sent (already started)");
  expect(r.control, "CONTROL: a delivered reminder keeps its own words").toBe("Reminder email sent");
});

// A session ended before it started (End Now on its event moves an upcoming
// session's start to the end; End Now on the session itself does the same) will
// never start, so its unsent start reminders go with it in the same write, the
// count recorded on the session's history. Left behind, the dispatcher would skip
// them later as "not sent: it had already started", which it never was.
test("End Now on an event, or on an upcoming session, cancels that session's unsent start reminders (CONTROL: another event's reminder stays)", async () => {
  const Database = require("better-sqlite3");
  const { makeParticipant, makeCompetition, enrol } = require("./event-admin-helpers");
  const sql = (fn) => { const db = new Database(TEST_DB_PATH); try { return fn(db); } finally { db.close(); } };
  const { api, csrf } = await apiLogin("superadmin");
  try {
    const p = await makeParticipant(api, csrf, "remend");
    const at = (ms) => new Date(Date.now() + ms).toISOString();
    // Event A runs now through a session that started a minute ago; its second
    // session starts in two hours. Event B has one upcoming session of its own.
    const A = await makeCompetition(api, csrf, "remend-a", { start_time: at(3600_000) });
    const B = await makeCompetition(api, csrf, "remend-b", { start_time: at(3600_000) });
    const C = await makeCompetition(api, csrf, "remend-c", { start_time: at(3600_000) });
    const slot = async (compId, name, start) => {
      const r = await api.post(`/api/admin/competitions/${compId}/timeslots`, { headers: h(csrf), data: { name, start_time: start, duration_minutes: 60 } });
      expect(r.ok(), `session ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).timeslot.id;
    };
    const a1 = await slot(A.id, "First", at(3600_000)), a2 = await slot(A.id, "Second", at(2 * 3600_000));
    const b1 = await slot(B.id, "Only", at(2 * 3600_000));
    const c1 = await slot(C.id, "Only", at(2 * 3600_000));
    for (const c of [A, B, C]) await enrol(api, csrf, c.id, [p.id]);
    sql(db => {
      // A's first session (and A) started a minute ago: A is live, its second session upcoming.
      db.prepare("UPDATE competition_timeslots SET start_time=? WHERE id=?").run(at(-60_000), a1);
      db.prepare("UPDATE competitions SET start_time=? WHERE id=?").run(at(-60_000), A.id);
      db.prepare("UPDATE competition_users SET timeslot_id=? WHERE competition_id=? AND user_id=?").run(a2, A.id, p.id);
      db.prepare("UPDATE competition_users SET timeslot_id=? WHERE competition_id=? AND user_id=?").run(b1, B.id, p.id);
      db.prepare("UPDATE competition_users SET timeslot_id=? WHERE competition_id=? AND user_id=?").run(c1, C.id, p.id);
      const ins = db.prepare("INSERT INTO email_reminders (user_id, competition_id, send_at, sent, created_at, timeslot_id) VALUES (?,?,?,0,?,?)");
      ins.run(p.id, A.id, at(3600_000), at(0), a2);
      ins.run(p.id, B.id, at(3600_000), at(0), b1);
      ins.run(p.id, C.id, at(3600_000), at(0), c1);
    });
    await new Promise(r => setTimeout(r, 1100));   // outwait the 1 s event-row cache after the SQL writes
    const rem = (compId) => sql(db => db.prepare("SELECT sent FROM email_reminders WHERE user_id=? AND competition_id=?").get(p.id, compId) || null);
    expect([rem(A.id), rem(B.id), rem(C.id)], "PRECONDITION: one unsent reminder each").toEqual([{ sent: 0 }, { sent: 0 }, { sent: 0 }]);
    const endA = await api.post(`/api/admin/competitions/${A.id}/end-now`, { headers: h(csrf), data: {} });
    expect(endA.ok(), `End Now on A: ${endA.status()} ${await endA.text()}`).toBeTruthy();
    const endB = await api.post(`/api/admin/competitions/${B.id}/timeslots/${b1}/end-now`, { headers: h(csrf), data: {} });
    expect(endB.ok(), `End Now on B's session: ${endB.status()} ${await endB.text()}`).toBeTruthy();
    expect(rem(A.id), "A's second session ended before it started: its reminder is gone").toBeNull();
    expect(rem(B.id), "B's session ended before it started: its reminder is gone").toBeNull();
    expect(rem(C.id), "CONTROL: an event nobody ended keeps its reminder").toEqual({ sent: 0 });
    const cancelled = (tsId) => sql(db => db.prepare("SELECT details FROM timeslot_events WHERE timeslot_id=? AND event_type='ended_manually'").all(tsId)).map(r => JSON.parse(r.details).reminders_cancelled ?? null);
    expect(cancelled(a2), "the session's history counts what went").toEqual([1]);
    expect(cancelled(b1)).toEqual([1]);
    expect(cancelled(a1), "CONTROL: the session that ran had none to cancel").toEqual([null]);
    // Nothing is left for the dispatcher to skip as 'already started'.
    const tick = await (await api.post("/api/test/reminder-tick", { headers: h(csrf), data: { forceDelivered: true } })).json();
    expect(tick.ran, `PRECONDITION: the dispatcher ran: ${JSON.stringify(tick)}`).toBe(true);
    const skipped = sql(db => db.prepare("SELECT COUNT(*) n FROM user_events WHERE user_id=? AND event_type='reminder_skipped'").get(p.id).n);
    expect(skipped, "no reminder of an ended-before-start session was skipped as started").toBe(0);
  } finally { await api.dispose(); }
});
