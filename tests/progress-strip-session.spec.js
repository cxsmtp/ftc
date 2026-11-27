// @ts-check
//
// THE EVENTS PAGE'S PROGRESS STRIP ON A MULTI-SESSION EVENT (public/js/features/
// competition-picker.js `_renderProgressStrip` / `_ownWindow`, fed by the event
// list's `my_session`, lib/competitions.js `listParticipantCompetitions`).
//
// The strip shares the play bar's renderer so the two cannot describe one run
// differently, and the play bar counts down the participant's OWN window
// (GET /api/status). An event row's `status` and `effective_end` describe the
// EVENT — live while any session is, ending with the last — so on a
// multi-session event the strip reads the row's `my_session` instead. Two
// sessions throughout (fixture checklist item 12: one session would look right
// when broken).
//
//   1. The list row carries `my_session` — the participant's own session, its
//      window and status as /api/status reports it — beside the event's own
//      fields (controls: null for a participant who chose no session, and for a
//      sessionless event); once that session has ended it says so while the
//      event stays live for the later one.
//   2. The strip's ring counts down that session, not the event's last (the
//      event's end is hours further), and once the session has ended the run
//      leaves the strip although the event is still live (control: before the
//      end the row is there, saying In progress).
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const MIN = 60_000;

/**
 * A live tournament with two sessions: A running now (started 5 min ago, 30 min
 * long) and B two hours away. Two challenges and an idle second participant, so
 * nothing auto-ends it (checklist item 1). `p` is placed in session A.
 */
async function twoSessionEvent(label) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const comp = await makeCompetition(sa, csrf, label);
    const t1 = await makeTask(sa, csrf, `${label}-1`);
    const t2 = await makeTask(sa, csrf, `${label}-2`);
    for (const t of [t1, t2]) await assignTask(sa, csrf, t.id, [comp.id]);
    const slot = async (name, startMs, minutes) => {
      const r = await sa.post(`/api/admin/competitions/${comp.id}/timeslots`, { headers: H(csrf), data: {
        name, start_time: new Date(startMs).toISOString(), duration_minutes: minutes } });
      expect(r.ok(), `session ${name}: ${await r.text()}`).toBeTruthy();
      return (await r.json()).timeslot;
    };
    const A = await slot("Morning", Date.now() - 5 * MIN, 30);
    const B = await slot("Afternoon", Date.now() + 120 * MIN, 60);
    const p = await makeParticipant(sa, csrf, label);
    const idle = await makeParticipant(sa, csrf, `${label}-idle`);
    await enrol(sa, csrf, comp.id, [p.id, idle.id]);
    const P = await apiLogin(p.email);
    try {
      expect((await P.api.post("/api/select-competition", { headers: H(P.csrf), data: { competitionId: comp.id } })).ok()).toBeTruthy();
      const pick = await P.api.post("/api/select-timeslot", { headers: H(P.csrf), data: { timeslotId: A.id, confirmLive: true } });
      expect(pick.ok(), `select session A: ${await pick.text()}`).toBeTruthy();
      expect((await pick.json()).ok, "precondition: the participant is in session A").toBe(true);
    } finally { await P.api.dispose(); }
    return { comp, A, B, p, idle, t1 };
  } finally { await sa.dispose(); }
}

const endOf = (slot) => new Date(slot.start_time).getTime() + slot.duration_minutes * MIN;

async function endSession(compId, slotId) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const r = await sa.post(`/api/admin/competitions/${compId}/timeslots/${slotId}/end-now`, { headers: H(csrf) });
    expect(r.ok(), `end session: ${await r.text()}`).toBeTruthy();
    return (await r.json()).timeslot;
  } finally { await sa.dispose(); }
}

test("the list row carries the participant's own session beside the event's window", async () => {
  test.setTimeout(90_000);
  const f = await twoSessionEvent("mys");
  // A sessionless event for the same participant: the control for "no sessions".
  const { api: sa, csrf } = await apiLogin("superadmin");
  let plain;
  try {
    plain = await makeCompetition(sa, csrf, "mys-plain");
    await enrol(sa, csrf, plain.id, [f.p.id]);
  } finally { await sa.dispose(); }

  const rowsFor = async (email) => {
    const L = await apiLogin(email);
    try { return await (await L.api.get("/api/my-competitions")).json(); } finally { await L.api.dispose(); }
  };
  let rows = await rowsFor(f.p.email);
  let row = rows.find((c) => c.id === f.comp.id);
  expect(row, "the event is on the participant's list").toBeTruthy();
  expect(row.my_session, "the participant's own session, as /api/status reports it").toEqual({
    id: f.A.id, start: new Date(f.A.start_time).toISOString(), end: new Date(endOf(f.A)).toISOString(), status: "live",
  });
  expect(row.status, "the EVENT is live").toBe("live");
  expect(new Date(row.effective_end).getTime(), "and the EVENT ends with its last session, hours after the participant's").toBe(endOf(f.B));
  expect(rows.find((c) => c.id === plain.id).my_session, "CONTROL: a sessionless event has no own session").toBeNull();
  expect((await rowsFor(f.idle.email)).find((c) => c.id === f.comp.id).my_session,
    "CONTROL: a participant who chose no session has none").toBeNull();

  // The participant's session ends early; the event lives on for session B.
  const ended = await endSession(f.comp.id, f.A.id);
  rows = await rowsFor(f.p.email);
  row = rows.find((c) => c.id === f.comp.id);
  expect(row.my_session.status, "their session has ended").toBe("ended");
  expect(row.my_session.end, "at the moment it was ended").toBe(ended.effective_end);
  expect(row.status, "while the event is still live for the later session").toBe("live");
});

test("the strip counts down the participant's own session, and lets the run go when it has ended", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await twoSessionEvent("strip");
  await loginViaApi(page, f.p.email);
  await page.goto("/");
  // The run is played: the challenge list is what records it for the strip.
  await expect(page.locator("#task-grid .task-card").first(), "PRECONDITION: in the event, session A").toBeVisible({ timeout: 20000 });
  await page.locator("#nav-competitions").click();
  await expect(page.locator("#competitions-page")).toHaveClass(/active/, { timeout: 10000 });
  const row = page.locator(`#ev-progress .ev-prog[data-comp-id="${f.comp.id}"]`);
  await expect(row, "the run under way is on the strip").toBeVisible({ timeout: 10000 });
  await expect(row.locator(".ev-prog-name .eyebrow")).toHaveText("In progress");

  // The ring reads what is left of session A — about 25 minutes — not the
  // event's three hours.
  const left = () => row.locator(".qa-gauge .qa-gauge-val").evaluate((el) => {
    const parts = el.textContent.trim().split(":").map(Number);
    const secs = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts.length === 2 ? parts[0] * 60 + parts[1] : NaN;
    return { text: el.textContent.trim(), secs, now: Date.now() };
  });
  await expect.poll(async () => (await left()).text, { message: "the ring is painted" }).toMatch(/\d/);
  const m = await left();
  const own = (endOf(f.A) - m.now) / 1000;
  const event = (endOf(f.B) - m.now) / 1000;
  expect(Math.abs(m.secs - own), `the ring counts down session A (${m.text}; A ends in ${Math.round(own)} s, the event in ${Math.round(event)} s)`).toBeLessThan(5);

  // Session A ends early; the event lives on for session B. The run is over, so
  // it leaves the strip.
  await endSession(f.comp.id, f.A.id);
  const listed = await page.evaluate(async (id) => (await (await fetch("/api/my-competitions")).json()).find((c) => c.id === id), f.comp.id);
  expect(listed && listed.status, "precondition: the event itself is still live").toBe("live");
  await page.evaluate(() => window.loadMyCompetitions());
  await expect(row, "a run whose session has ended is not offered as one in progress").toHaveCount(0);
});
