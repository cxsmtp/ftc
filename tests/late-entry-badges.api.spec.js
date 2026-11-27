// @ts-check
//
// v8.8.0 — THE LATE-ENTRY FLAG REACHES THE ROWS THAT RENDER A BADGE.
//
// An event in its late-entry window is an ENDED event that is still joinable and
// still taking submissions. v8.6.0 published `late_entry_window_open` on the
// admin events list, `_compWire` and the participant's own list; the two admin
// surfaces that render a per-row COMPETITION badge — the Challenges table and the
// Participants table — build their `competitions[]` arrays from their OWN batch
// queries and carried no such flag, so the client could not tell a late-entry
// event from any other finished one and hid both.
//
// This file locks the wire. The rendering is locked in late-entry-badges.spec.js,
// and it has to be: the badge decision is client-side, so an API test cannot see
// a regression in it (the v8.7.7 lesson).
//
// THE CONTROLS ARE THE POINT. "The flag is true" is equally satisfied by a build
// that hard-codes it, so every arm carries two:
//   * a CLOSED window on the same kind — ended long enough ago that the deadline
//     has passed — which must read FALSE; and
//   * a Competition, which `lib/event-policy.js` PROHIBITS from running a late
//     window at all, so it must read FALSE however it ended.
// Without those, a build that returned `status === 'ended'` under a new name
// would pass every positive assertion here.

const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `leb${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;
const MIN = 60_000;
const CACHE_TTL_MS = 1_000;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/**
 * Live at creation — an ENDED event refuses the CHALLENGE assignment for good,
 * and refused the participant assign too until v8.12.6 (one still taking late
 * entries now admits it, as a late entrant). The fixtures want ordinary members.
 */
async function makeEvent(api, csrf, kind) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} ${kind}`, event_kind: kind, timezone: "UTC",
      start_time: new Date(Date.now() - 5 * MIN).toISOString(), duration_minutes: 180,
      ...(kind === "booth" ? { late_entry_enabled: true } : {}),
    },
  });
  expect(r.ok(), `create ${kind}: ${await r.text()}`).toBeTruthy();
  return (await r.json()).competition;
}

async function makeTask(api, csrf, compId) {
  const r = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: {
      title: `${uniq()} probe`, description: "d", difficulty: "easy",
      answer_type: "text", correct_answer: "a", status: "published",
    },
  });
  expect(r.ok(), `create task: ${await r.text()}`).toBeTruthy();
  const id = (await r.json()).id;
  const asg = await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
  expect(asg.ok(), `assign task: ${await asg.text()}`).toBeTruthy();
  return id;
}

async function makeParticipant(api, csrf, compId) {
  const label = uniq();
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Late", lastName: "Badge", nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
  const list = await (await api.get("/api/admin/participants?limit=5000")).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, "participant findable").toBeTruthy();
  // Verified AND approved BEFORE the enrol: `/assign` SKIPS an ineligible user and
  // still answers 200, so an unverified fixture enrols nobody and the failure
  // surfaces far from its cause (the fixture checklist's rule).
  expect((await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) })).ok(), "verify").toBeTruthy();
  expect((await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) })).ok(), "approve").toBeTruthy();
  const asg = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [u.id], competitionIds: [compId] } });
  expect(asg.ok(), `enrol: ${await asg.text()}`).toBeTruthy();
  const asgBody = await asg.json();
  expect(asgBody.assigned, `the enrol really landed — got ${JSON.stringify(asgBody)}`).toBe(1);
  return { id: u.id, email };
}

/**
 * Move the whole schedule into the past so the event has ENDED.
 *
 * `agoMinutes` is how long ago it finished, which is what decides whether the
 * 48-hour window is still open. A direct write rather than End Now, because End
 * Now can only reach "ended a moment ago" and the CLOSED control needs an event
 * that finished two days back.
 */
function expireEvent(compId, agoMinutes, duration = 60) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try {
    const end = new Date(Date.now() - agoMinutes * MIN);
    const res = db.prepare("UPDATE competitions SET start_time=?, duration_minutes=? WHERE id=?")
      .run(new Date(end.getTime() - duration * MIN).toISOString(), duration, compId);
    expect(res.changes, "the direct write must land").toBe(1);
  } finally { db.close(); }
}

/** The competitions array on a CHALLENGE row, as the superadmin sees it. */
async function taskRowComps(api, taskId) {
  const r = await api.get("/api/admin/tasks");
  expect(r.ok(), `tasks: ${r.status()}`).toBeTruthy();
  const row = (await r.json()).find(t => t.id === taskId);
  expect(row, "the challenge is in the list").toBeTruthy();
  return row.competitions || [];
}

/** The competitions array on a PARTICIPANT row. */
async function participantRowComps(api, userId) {
  const r = await api.get("/api/admin/participants?limit=5000");
  expect(r.ok(), `participants: ${r.status()}`).toBeTruthy();
  const row = ((await r.json()).participants || []).find(p => p.id === userId);
  expect(row, "the participant is in the list").toBeTruthy();
  return row.competitions || [];
}

const entryFor = (comps, compId) => comps.find(c => c.id === compId) || null;

test.describe("v8.8.0 — late_entry_window_open reaches the badge payloads", () => {
  /** @type {any} */ let S;
  let openComp, closedComp, tourComp;
  let openTask, closedTask, tourTask;
  let openUser, closedUser, tourUser;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    S = await sa();

    // Built LIVE, populated, then expired — an ended event refuses the challenge
    // assignment; the participant enrol is done while LIVE so the member is an
    // ordinary one (an event still taking late entries admits a late entrant).
    openComp = await makeEvent(S.api, S.csrf, "booth");
    openTask = await makeTask(S.api, S.csrf, openComp.id);
    openUser = await makeParticipant(S.api, S.csrf, openComp.id);

    closedComp = await makeEvent(S.api, S.csrf, "booth");
    closedTask = await makeTask(S.api, S.csrf, closedComp.id);
    closedUser = await makeParticipant(S.api, S.csrf, closedComp.id);

    tourComp = await makeEvent(S.api, S.csrf, "tournament");
    tourTask = await makeTask(S.api, S.csrf, tourComp.id);
    tourUser = await makeParticipant(S.api, S.csrf, tourComp.id);

    expireEvent(openComp.id, 30);          // ended 30 min ago  → window OPEN
    expireEvent(closedComp.id, 49 * 60);   // ended 49 h ago    → window CLOSED (48 h default)
    expireEvent(tourComp.id, 30);          // ended 30 min ago  → but the KIND forbids a window
    await new Promise(r => setTimeout(r, CACHE_TTL_MS + 250));
  });

  test("PRECONDITION — all three events really are ENDED, and only one has an open window", async () => {
    const list = await (await S.api.get("/api/admin/competitions")).json();
    const byId = Object.fromEntries(list.map(c => [c.id, c]));
    for (const id of [openComp.id, closedComp.id, tourComp.id]) {
      expect(byId[id], "the event is listed").toBeTruthy();
      expect(byId[id].status, `${id} has ended`).toBe("ended");
    }
    expect(byId[openComp.id].late_entry_window_open, "the booth's window is open").toBe(true);
    expect(byId[closedComp.id].late_entry_window_open, "the expired booth's window is closed").toBe(false);
    expect(byId[tourComp.id].late_entry_window_open, "a Competition never runs a window").toBe(false);
  });

  test("a CHALLENGE row names the flag for an open window", async () => {
    const e = entryFor(await taskRowComps(S.api, openTask), openComp.id);
    expect(e, "the event is on the challenge row").toBeTruthy();
    expect(e.status, "…as an ended event").toBe("ended");
    expect(e.late_entry_window_open, "…with its window open").toBe(true);
  });

  test("CONTROL — a challenge row reads FALSE for a closed window and for a Competition", async () => {
    const closed = entryFor(await taskRowComps(S.api, closedTask), closedComp.id);
    expect(closed, "the closed-window event is on its row").toBeTruthy();
    expect(closed.late_entry_window_open, "a lapsed deadline is not an open window").toBe(false);

    const tour = entryFor(await taskRowComps(S.api, tourTask), tourComp.id);
    expect(tour, "the Competition is on its row").toBeTruthy();
    expect(tour.late_entry_window_open, "a Competition is prohibited from running one").toBe(false);
  });

  test("a PARTICIPANT row names the flag for an open window", async () => {
    const e = entryFor(await participantRowComps(S.api, openUser.id), openComp.id);
    expect(e, "the event is on the participant row").toBeTruthy();
    expect(e.status, "…as an ended event").toBe("ended");
    expect(e.late_entry_window_open, "…with its window open").toBe(true);
  });

  test("CONTROL — a participant row reads FALSE for a closed window and for a Competition", async () => {
    const closed = entryFor(await participantRowComps(S.api, closedUser.id), closedComp.id);
    expect(closed, "the closed-window event is on its row").toBeTruthy();
    expect(closed.late_entry_window_open, "a lapsed deadline is not an open window").toBe(false);

    const tour = entryFor(await participantRowComps(S.api, tourUser.id), tourComp.id);
    expect(tour, "the Competition is on its row").toBeTruthy();
    expect(tour.late_entry_window_open, "a Competition is prohibited from running one").toBe(false);
  });

  test("the participant PICKER row carries it too, so the payloads agree", async () => {
    // The picker builds its competitions array from a THIRD query. Two of three
    // agreeing is how these drift.
    const r = await S.api.get(`/api/admin/participants/picker?competitionId=${openComp.id}`);
    expect(r.ok(), `picker: ${r.status()} ${await r.text()}`).toBeTruthy();
    const row = ((await r.json()).users || []).find(u => u.id === openUser.id);
    expect(row, "the member is in the picker").toBeTruthy();
    const e = entryFor(row.competitions || [], openComp.id);
    expect(e, "the event is on the picker row").toBeTruthy();
    expect(e.late_entry_window_open, "…with its window open").toBe(true);
  });
});
