// @ts-check
// v8.1.9 — CLOSE NOW LEAVES A ~60-SECOND WINDOW IN WHICH ANY SAVE REOPENED THE EVENT.
//
// `end-now` stores `Math.ceil(elapsed / 60_000)` minutes, so the scheduled end it
// derives lands up to a minute AFTER the moment the event actually ended. The
// revive gate asked only "is the scheduled end in the future?" — which inside that
// window is true of an event nobody has extended. So any save at all (a flag, a
// rename, or Save with nothing changed) found a future end, skipped the all-solved
// gate because `ended_manually` is set, and silently reopened a settled event:
// participants regained submit access and the shared-challenge freeze lifted.
//
// The rounding is NOT the defect — `ceil` is what stops a sub-minute event storing
// a zero duration, and `competitionEffectiveEnd` clamps to MIN(ended_at,
// scheduledEnd) everywhere else. The wrong inference was treating an unchanged
// schedule as a deliberate extension.
//
// EVERY TEST HERE ASSERTS ITS WINDOW AS A PRECONDITION. Without that, "the event
// stayed ended" passes on any build whose ceil window has already elapsed — the
// assertion would be about nothing. The fixtures start 61 s in the past precisely
// so `ceil` rounds up to 2 minutes and leaves ~59 s of window to act inside.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE } = require("./helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `rw${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

/** The row as the admin list reports it — the same source the UI renders from. */
async function compRow(api, id) {
  const all = await (await api.get("/api/admin/competitions")).json();
  const row = (all || []).find((c) => c.id === id);
  expect(row, "the competition must be in the admin list").toBeTruthy();
  return row;
}

/**
 * A LIVE single-slot competition that started 61 s ago, so Close Now's `ceil`
 * rounds 61 s up to 2 minutes and the stored scheduled end sits ~59 s in the
 * future — the window this file is about.
 */
async function liveComp(api, csrf, name) {
  const cr = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: { name, start_time: new Date(Date.now() - 61_000).toISOString(), duration_minutes: 600, timezone: "UTC" },
  });
  expect(cr.ok(), `create: ${await cr.text()}`).toBeTruthy();
  return (await cr.json()).competition;
}

/** Close Now, then assert the window really is open — the anti-vacuity guard. */
async function closeNowInsideWindow(api, csrf, comp) {
  const en = await api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf) });
  expect(en.ok(), `end-now: ${await en.text()}`).toBeTruthy();
  const row = await compRow(api, comp.id);
  expect(row.ended_at, "Close Now stamped ended_at").toBeTruthy();
  const schedEnd = new Date(row.start_time).getTime() + row.duration_minutes * 60_000;
  expect(schedEnd, "PRECONDITION: the stored scheduled end is still in the FUTURE — "
    + "without this the test would pass on any build, because a lapsed window revives nothing")
    .toBeGreaterThan(Date.now());
  return row;
}

test.describe("v8.1.9 — Close Now's rounding window does not reopen a settled event", () => {
  test("a save that changes nothing about the schedule leaves a just-closed competition ENDED", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const comp = await liveComp(api, csrf, `${uniq()} Window`);
      const closed = await closeNowInsideWindow(api, csrf, comp);

      // THE REALISTIC TRIGGER: pressing Save having changed nothing. The shipped
      // admin form round-trips the whole row, so an untouched save posts the
      // stored duration straight back — and an ended competition refuses a rename,
      // which makes this echo the ONLY shape an ordinary save can take here.
      const put = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf),
        data: { duration_minutes: closed.duration_minutes, expectedUpdatedAt: closed.updated_at },
      });
      expect(put.ok(), `save: ${put.status()} ${await put.text()}`).toBeTruthy();

      const after = await compRow(api, comp.id);
      expect(after.ended_at, "the event is still ended — nothing was extended").toBeTruthy();
      expect(after.status, "…and still reads as ended to every surface").toBe("ended");
      // Mutation this catches: dropping `_scheduleMoved` from the revive gate.
    } finally { await api.dispose(); }
  });

  test("POSITIVE CONTROL: extending the duration still revives it", async () => {
    // Without this, "the save did not revive" is equally satisfied by a build in
    // which a deliberate extend cannot revive either — which would break the
    // documented v7.7.x behaviour rather than fix anything.
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const comp = await liveComp(api, csrf, `${uniq()} Extend`);
      const closed = await closeNowInsideWindow(api, csrf, comp);

      const put = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf),
        data: { duration_minutes: 600, expectedUpdatedAt: closed.updated_at },
      });
      expect(put.ok(), `extend: ${put.status()} ${await put.text()}`).toBeTruthy();

      const after = await compRow(api, comp.id);
      expect(after.ended_at, "a deliberate extend clears ended_at").toBeFalsy();
      expect(after.status, "and the event is live again").toBe("live");
    } finally { await api.dispose(); }
  });

  test("the same holds for a SESSION: a no-op save does not reopen it, an extend does", async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      // A multi-session competition: the slot is what gets closed and edited.
      const cr = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: { name: `${uniq()} SlotWindow`, start_time: new Date(Date.now() - 61_000).toISOString(),
                duration_minutes: 600, timezone: "UTC" },
      });
      expect(cr.ok(), `create comp: ${await cr.text()}`).toBeTruthy();
      const comp = (await cr.json()).competition;

      const ts = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, {
        headers: H(csrf),
        data: { name: `${uniq()} Slot`, start_time: new Date(Date.now() - 61_000).toISOString(),
                duration_minutes: 600, timezone: "UTC" },
      });
      expect(ts.ok(), `create slot: ${await ts.text()}`).toBeTruthy();
      const slot = (await ts.json()).timeslot;

      const en = await api.post(`/api/admin/competitions/${comp.id}/timeslots/${slot.id}/end-now`, { headers: H(csrf) });
      expect(en.ok(), `slot end-now: ${await en.text()}`).toBeTruthy();

      const slots = async () => (await (await api.get(`/api/admin/competitions/${comp.id}/timeslots`)).json());
      let row = (await slots()).find((s) => s.id === slot.id);
      expect(row.ended_at, "the session is closed").toBeTruthy();
      const schedEnd = new Date(row.start_time).getTime() + row.duration_minutes * 60_000;
      expect(schedEnd, "PRECONDITION: the session's stored end is still in the future")
        .toBeGreaterThan(Date.now());

      // An ended session refuses a rename, so the schedule fields are the only
      // ones an ordinary save can carry — echoing them back IS the no-op save.
      const noop = await api.put(`/api/admin/competitions/${comp.id}/timeslots/${slot.id}`, {
        headers: H(csrf), data: { duration_minutes: row.duration_minutes, expectedUpdatedAt: row.updated_at },
      });
      expect(noop.ok(), `no-op save: ${noop.status()} ${await noop.text()}`).toBeTruthy();
      row = (await slots()).find((s) => s.id === slot.id);
      expect(row.ended_at, "a save that moved nothing does not reopen a closed session").toBeTruthy();

      // POSITIVE CONTROL on the same surface.
      const extend = await api.put(`/api/admin/competitions/${comp.id}/timeslots/${slot.id}`, {
        headers: H(csrf), data: { duration_minutes: 600, expectedUpdatedAt: row.updated_at },
      });
      expect(extend.ok(), `extend slot: ${extend.status()} ${await extend.text()}`).toBeTruthy();
      row = (await slots()).find((s) => s.id === slot.id);
      expect(row.ended_at, "…while extending its duration does").toBeFalsy();
      // Mutation this catches: dropping `_tsScheduleMoved` from the slot revive gate.
    } finally { await api.dispose(); }
  });
});
