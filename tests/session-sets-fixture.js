// @ts-check
//
// Fixtures for PER-SESSION QUESTION SETS (owner decision, 27 Nov 2026): a
// Competition with two sessions whose questions can differ, built through the
// real doors (create, session add, question assign, the per-question sessions
// PUT) and made LIVE by re-timing its rows, because a session's questions can
// only be chosen while it is upcoming. Shared by the API spec and the UI spec.
const { expect } = require("@playwright/test");
const { H, uniq, MIN, rawRun, rawGet, outliveCompCache } = require("./late-entry-fixture");

/** A question created through the Question bank and assigned: returns the EVENT's copy id. */
async function addQuestion(api, csrf, compId, { difficulty = "easy", title } = {}) {
  const t = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: { title: title || `SQ ${difficulty} ${uniq()}`, description: "<p>q</p>", difficulty, answer_type: "text", correct_answer: "win", status: "published" },
  });
  expect(t.ok(), `create question: ${await t.text()}`).toBeTruthy();
  const id = (await t.json()).id;
  const asg = await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
  expect(asg.ok(), `assign: ${await asg.text()}`).toBeTruthy();
  return (await asg.json()).copies[0].task_id;
}

/**
 * An UPCOMING Competition with sessions A and B (names returned), created with
 * `create` settings (e.g. `{leaderboard_overall: true, leaderboard_percent: true}`).
 * Auto-end on, self-enrolment off, the entry clock (so entering anchors the
 * solve clock and a back-date can set it), no qualifying questions.
 */
async function sessionEvent(api, csrf, { create = {}, sessions = 2 } = {}) {
  const start = Date.now() + 60 * MIN;
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `SQ ${uniq()}`, event_kind: "tournament", add_qualifying: false,
      start_time: new Date(start).toISOString(), duration_minutes: 600,
      self_enroll_enabled: false, clock_start: "entry", ...create,
    },
  });
  expect(r.ok(), `create: ${await r.text()}`).toBeTruthy();
  const comp = (await r.json()).competition;
  const slots = [];
  for (let i = 0; i < sessions; i++) {
    const name = `Session ${String.fromCharCode(65 + i)} ${uniq()}`;
    const s = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, {
      headers: H(csrf), data: { name, start_time: new Date(start + i * MIN).toISOString(), duration_minutes: 240 },
    });
    expect(s.ok(), `add session: ${await s.text()}`).toBeTruthy();
    slots.push({ id: (await s.json()).timeslot.id, name });
  }
  return { comp, slots };
}

/** PUT one question's sessions; returns the response. */
function setSessions(api, csrf, compId, taskId, timeslotIds, extra = {}) {
  return api.put(`/api/admin/competitions/${compId}/tasks/${taskId}/sessions`, { headers: H(csrf), data: { timeslotIds, ...extra } });
}

/**
 * Make sessions live by re-timing them (and the event row): each named session
 * starts `agoMinutes` ago. A direct write: the session routes refuse moving a
 * start into the past only for a started session, and these are upcoming.
 */
async function goLive(compId, slotIds, { agoMinutes = 5 } = {}) {
  const startIso = new Date(Date.now() - agoMinutes * MIN).toISOString();
  rawRun("UPDATE competitions SET start_time=? WHERE id=?", [startIso, compId]);
  for (const id of slotIds) rawRun("UPDATE competition_timeslots SET start_time=? WHERE id=?", [startIso, id]);
  await outliveCompCache();
}

/**
 * End the event: every session (and the event) ended half a second ago — AFTER
 * the test server booted, so the automatic certificate issue's grandfather
 * floor (the boot of a fresh database) does not drop it.
 */
async function endAll(compId) {
  const startIso = new Date(Date.now() - 60 * MIN - 500).toISOString();
  rawRun("UPDATE competitions SET start_time=?, duration_minutes=60 WHERE id=?", [startIso, compId]);
  rawRun("UPDATE competition_timeslots SET start_time=?, duration_minutes=60 WHERE competition_id=?", [startIso, compId]);
  await outliveCompCache();
}

/** A participant session selected into the event AND its session (`slotId`). */
async function chooseSession(ctx, slotId) {
  const r = await ctx.api.post("/api/select-timeslot", { headers: H(ctx.csrf), data: { timeslotId: slotId, confirmLive: true } });
  expect(r.ok(), `select-timeslot: ${await r.text()}`).toBeTruthy();
  const body = await r.json();
  expect(body.ok, `select-timeslot answered ok: ${JSON.stringify(body)}`).toBe(true);
}

module.exports = { addQuestion, sessionEvent, setSessions, goLive, endAll, chooseSession, rawGet };
