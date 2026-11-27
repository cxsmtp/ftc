// @ts-check
//
// v8.12.4 — the REASON an audit event records, for the branches no test read.
//
// A coverage-driven sweep found these emits running under the suite while no
// assertion anywhere named the reason they record. That is the dangerous
// shape for an audit trail: the History dialog renders `reason` / `via` to an
// operator trying to work out what happened, every emit is deliberately
// non-fatal, and a wrong or dropped reason therefore fails NOTHING — the row
// still appears, it just says the wrong thing. Each test drives the real flow
// and reads the stored row back.
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH, gradingHashFor } = require("./helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const Database = require("better-sqlite3");

function events(table, key, id, type) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare(`SELECT changed_by, details FROM ${table} WHERE ${key}=? AND event_type=? ORDER BY rowid`)
      .all(id, type).map(r => ({ actor: r.changed_by, d: JSON.parse(r.details || "{}") }));
  } finally { db.close(); }
}
/** Deferred emits (post-commit setImmediate) land after the response — poll. */
async function eventually(fn, what) {
  let v;
  await expect.poll(() => { v = fn(); return v.length; }, { timeout: 5000, message: what }).toBeGreaterThan(0);
  return v;
}
/** A session that starts in a few seconds, so it can be chosen upcoming and then run live. */
async function sessionStartingSoon(sa, csrf, compId, name, ms = 3000) {
  const startsAt = Date.now() + ms;
  const r = await sa.post(`/api/admin/competitions/${compId}/timeslots`, { headers: H(csrf), data: {
    name, start_time: new Date(startsAt).toISOString(), duration_minutes: 60 } });
  expect(r.ok(), `timeslot ${name}: ${await r.text()}`).toBeTruthy();
  return { id: (await r.json()).timeslot.id, startsAt };
}
const waitUntil = (t) => new Promise((r) => setTimeout(r, Math.max(0, t - Date.now()) + 750));

test.describe("v8.12.4 — the reasons the History dialog renders", () => {
  test("pressing Events records the departure as left_event_view, naming the event left", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const comp = await makeCompetition(sa, csrf, "leave-view");
      const p = await makeParticipant(sa, csrf, "leave-view");
      await enrol(sa, csrf, comp.id, [p.id]);
      const s = await apiLogin(p.email, PARTICIPANT_PASS);
      try {
        expect((await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: comp.id } })).ok()).toBeTruthy();
        const de = await s.api.post("/api/deselect-competition", { headers: H(s.csrf) });
        expect(de.ok(), await de.text()).toBeTruthy();
        const ev = events("user_events", "user_id", p.id, "active_competition_changed").filter(e => e.d.reason === "left_event_view");
        expect(ev, "the deliberate departure is recorded once, with its reason").toHaveLength(1);
        expect(ev[0].d.from).toBe(comp.id);
        expect(ev[0].d.to).toBeNull();
        expect(ev[0].actor, "attributed to the participant, not 'system'").toBe(p.email);
        expect(ev[0].d.ip, "and carries their address (v7.21.32)").toBeTruthy();
      } finally { await s.api.dispose(); }
    } finally { await sa.dispose(); }
  });

  test("asking for a reminder TWICE clears the first as reset_before_reset — never two reminders", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const comp = await makeCompetition(sa, csrf, "remind-twice", { start_time: new Date(Date.now() + 6 * 3_600_000).toISOString() });
      const p = await makeParticipant(sa, csrf, "remind-twice");
      await enrol(sa, csrf, comp.id, [p.id]);
      const s = await apiLogin(p.email, PARTICIPANT_PASS);
      try {
        for (let i = 0; i < 2; i++) {
          const r = await s.api.post(`/api/competitions/${comp.id}/reminder`, { headers: H(s.csrf), data: {} });
          expect(r.ok(), `reminder ${i + 1}: ${await r.text()}`).toBeTruthy();
        }
        const db = new Database(TEST_DB_PATH, { readonly: true });
        try {
          expect(db.prepare("SELECT COUNT(*) n FROM email_reminders WHERE user_id=? AND competition_id=?").get(p.id, comp.id).n,
            "at most one reminder per participant per event").toBe(1);
        } finally { db.close(); }
        const ev = events("user_events", "user_id", p.id, "reminder_cleared");
        expect(ev.map(e => e.d.reason)).toEqual(["reset_before_reset"]);
        expect(ev[0].d.competition_id).toBe(comp.id);
      } finally { await s.api.dispose(); }
    } finally { await sa.dispose(); }
  });

  test("switching session clears the reminder set for the OLD one, as timeslot_selected", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const comp = await makeCompetition(sa, csrf, "remind-switch", { start_time: new Date(Date.now() + 6 * 3_600_000).toISOString() });
      const mk = async (name, h) => {
        const r = await sa.post(`/api/admin/competitions/${comp.id}/timeslots`, { headers: H(csrf), data: {
          name, start_time: new Date(Date.now() + h * 3_600_000).toISOString(), duration_minutes: 60 } });
        expect(r.ok(), `timeslot ${name}: ${await r.text()}`).toBeTruthy();
        return (await r.json()).timeslot.id;
      };
      const a = await mk("Early", 5), b = await mk("Late", 9);
      const p = await makeParticipant(sa, csrf, "remind-switch");
      await enrol(sa, csrf, comp.id, [p.id]);
      const s = await apiLogin(p.email, PARTICIPANT_PASS);
      try {
        expect((await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: comp.id } })).ok()).toBeTruthy();
        expect((await s.api.post("/api/select-timeslot", { headers: H(s.csrf), data: { timeslotId: a } })).ok()).toBeTruthy();
        const rem = await s.api.post(`/api/competitions/${comp.id}/reminder`, { headers: H(s.csrf), data: {} });
        expect(rem.ok(), `reminder: ${await rem.text()}`).toBeTruthy();
        const sw = await s.api.post("/api/select-timeslot", { headers: H(s.csrf), data: { timeslotId: b } });
        expect(sw.ok(), `switch: ${await sw.text()}`).toBeTruthy();
        const ev = await eventually(() => events("user_events", "user_id", p.id, "reminder_cleared"),
          "the switch clears the reminder on the record");
        expect(ev.map(e => e.d.reason)).toEqual(["timeslot_selected"]);
        const db = new Database(TEST_DB_PATH, { readonly: true });
        try {
          expect(db.prepare("SELECT COUNT(*) n FROM email_reminders WHERE user_id=? AND competition_id=?").get(p.id, comp.id).n,
            "the reminder for a session they no longer attend is gone").toBe(0);
        } finally { db.close(); }
      } finally { await s.api.dispose(); }
    } finally { await sa.dispose(); }
  });

  test("ending the LAST live session by hand ends the event too, recorded as via last_timeslot_ended", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const comp = await makeCompetition(sa, csrf, "last-slot-manual", { start_time: new Date(Date.now() + 3_600_000).toISOString() });
      const ts = await sessionStartingSoon(sa, csrf, comp.id, "Only");
      await waitUntil(ts.startsAt);
      const end = await sa.post(`/api/admin/competitions/${comp.id}/timeslots/${ts.id}/end-now`, { headers: H(csrf), data: {} });
      expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();
      const ev = events("competition_events", "competition_id", comp.id, "ended_manually");
      expect(ev, "the event's own History says it ended, and why").toHaveLength(1);
      expect(ev[0].d.via).toBe("last_timeslot_ended");
      expect(ev[0].actor, "attributed to the admin who pressed it").toBe("superadmin");
    } finally { await sa.dispose(); }
  });

  test("a stamped ended_at is an END at the very millisecond it was stamped (the boundary that made the test above intermittent)", async () => {
    // Every writer stamps `ended_at` with "now" and then, a few synchronous
    // statements later, asks whether the event has fully ended. With the end
    // treated as INCLUSIVE that question landed on the stamp's own millisecond
    // about one run in a few hundred and answered "live", so ending the last
    // session left the event un-ended. The clock is pinned here, which is the
    // only way to reach that instant on purpose. The require is IN the test
    // (v7.20.2): lib/competitions opens the database at require time.
    const { timeslotStatus, competitionStatus } = require("../lib/competitions");
    const RealDate = Date;
    const T = RealDate.parse("2026-03-01T10:00:00.000Z");
    global.Date = class extends RealDate {
      constructor(...a) { if (a.length) super(...a); else super(T); }
      static now() { return T; }
    };
    try {
      const at = new RealDate(T).toISOString();
      const slot = { start_time: new RealDate(T - 3_600_000).toISOString(), duration_minutes: 120, ended_at: at };
      expect(timeslotStatus(slot), "a session stamped ended NOW has ended").toBe("ended");
      expect(timeslotStatus({ ...slot, ended_at: null }), "CONTROL: the same session, unstamped, is live").toBe("live");
      // An upcoming session ended early is stamped with start = end = now.
      expect(timeslotStatus({ start_time: at, duration_minutes: 0, ended_at: at })).toBe("ended");
      const comp = { id: "no-such-comp", start_time: slot.start_time, duration_minutes: 120, ended_at: at, ended_manually: 1 };
      expect(competitionStatus(comp, []), "the single-slot twin").toBe("ended");
      expect(competitionStatus({ ...comp, ended_at: null, ended_manually: 0 }, []), "CONTROL: single-slot, unstamped").toBe("live");
    } finally { global.Date = RealDate; }
  });

  test("the last session auto-ending on all-solved ends the event too, recorded as reason last_timeslot_ended", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const comp = await makeCompetition(sa, csrf, "last-slot-auto", { start_time: new Date(Date.now() + 3_600_000).toISOString() });
      const task = await makeTask(sa, csrf, "last-slot-auto");
      await assignTask(sa, csrf, task.id, [comp.id]);
      const ts = await sessionStartingSoon(sa, csrf, comp.id, "Only");
      const p = await makeParticipant(sa, csrf, "last-slot-auto");
      await enrol(sa, csrf, comp.id, [p.id]);
      const s = await apiLogin(p.email, PARTICIPANT_PASS);
      try {
        expect((await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: comp.id } })).ok()).toBeTruthy();
        expect((await s.api.post("/api/select-timeslot", { headers: H(s.csrf), data: { timeslotId: ts.id } })).ok()).toBeTruthy();
        await waitUntil(ts.startsAt);
        const sub = await s.api.post(`/api/tasks/${task.id}/submit`, { headers: H(s.csrf),
          data: { answer: "a", gradingHash: await gradingHashFor(s.api, task.id) } });
        expect(sub.ok(), `submit: ${await sub.text()}`).toBeTruthy();
        expect((await sub.json()).correct, "PRECONDITION: the only participant solves the only challenge").toBe(true);
        const ev = await eventually(() => events("competition_events", "competition_id", comp.id, "auto_ended"),
          "the event's auto-end is recorded");
        expect(ev[0].d.reason).toBe("last_timeslot_ended");
        expect(ev[0].actor).toBe("system");
        const slot = await eventually(() => events("timeslot_events", "timeslot_id", ts.id, "auto_ended"), "the session's own auto-end");
        expect(slot[0].d.reason, "…while the SESSION says why it ended").toBe("all_participants_solved");
      } finally { await s.api.dispose(); }
    } finally { await sa.dispose(); }
  });
});
