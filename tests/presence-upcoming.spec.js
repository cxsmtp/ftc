// v8.1.0 — PRESENCE DOES NOT ACCRUE IN THE LOBBY.
//
// `_recordPresenceIfActive` (server.js) gated only on `competitionStatus(comp)
// === "ended"`. But `POST /api/select-competition` sets the session for an
// UPCOMING event — that is the countdown page — and the SPA's keepalive and
// polls carry `X-Client-Active` whenever a human is present. So a participant
// who arrived early banked one five-minute bucket every five minutes before a
// single challenge existed. Under `time_basis='presence'` the finishers-only
// comparator ranks LOWER presence better, so on a score tie the EARLY ARRIVER
// was ranked BELOW the punctual one, and the exported "Time on Platform" could
// exceed "Time to Solve" — which reads as a data bug.
//
// The gate is now a POSITIVE liveness test, mirroring `_stampLoginTimeIfLive`
// (lib/middleware.js) exactly, the participant's OWN slot governing a multi-slot
// event. Two clocks answering different questions about "has this started?" is
// the inconsistency being fixed.
//
// THE DISCRIMINATING MUTATION FOR EVERY TEST BELOW is reverting the gate to
// `if (competitionStatus(comp) === "ended") return;`.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, BASE, codeLogin } = require("./helpers");

// `page.request` resolves relative URLs against this; without it the request
// context fails with a bare "Invalid URL" that names nothing.
test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `pu${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/** Every test owns its competition — a shared one carries another test's schedule. */
async function makeEvent(api, csrf, extra = {}) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} Ev`, timezone: "UTC",
      // The ENTRY clock: these tests count presence from entering the event, and
      // presence waits for the solve clock, which on the first-open clock (the
      // default) starts only at a first opened challenge. When a clock starts
      // is not this file's subject.
      clock_start: "entry",
      start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600,
      ...extra,
    },
  });
  expect(r.ok(), `create: ${await r.text()}`).toBeTruthy();
  return (await r.json()).competition;
}

/** Every test owns its participants — never authenticate as a seeded fixture. */
async function makeParticipant(api, csrf) {
  const label = uniq();
  const email = `${label}@company.example`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", {
    headers: H(ac),
    data: {
      firstName: "Lobby", lastName: "Waiter", nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS,
    },
  });
  expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
  await anon.dispose();
  const u = (await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json())
    .participants.find(p => p.email === email);
  expect(u, `participant ${email} must exist after register`).toBeTruthy();
  await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  return { id: u.id, email, nickname: label };
}

/** The assign endpoint SILENTLY SKIPS ineligible users — assert the count. */
async function assign(api, csrf, compId, userIds) {
  const r = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { competitionIds: [compId], userIds },
  });
  expect(r.ok(), `assign: ${await r.text()}`).toBeTruthy();
  expect((await r.json()).assigned, "precondition: everyone was really enrolled").toBe(userIds.length);
}

/** Sign in and select — returns the select payload so status is a precondition. */
async function enter(email, compId) {
  const { api, csrf: c0 } = await freshCtx();
  const li = await codeLogin(api, email, H(c0));
  expect(li.ok(), `login ${email}: ${await li.text()}`).toBeTruthy();
  const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  return { api, csrf, sel: await sel.json() };
}

async function compRow(api, compId) {
  const list = await (await api.get("/api/admin/competitions")).json();
  const c = list.find(x => x.id === compId);
  expect(c, "the competition is in the admin list").toBeTruthy();
  return c;
}

/** Read the stored bucket row directly — the observable the write path owns. */
function presenceRow(compId, userId) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return db.prepare("SELECT buckets, last_bucket FROM competition_presence WHERE competition_id=? AND user_id=?")
      .get(compId, userId) || null;
  } finally { db.close(); }
}

test.describe("v8.1.0 — presence accrues only while the event is under way", () => {
  test("an UPCOMING event banks NOTHING; the SAME participant on the SAME event banks once it is LIVE", async () => {
    // The two halves are one test on purpose: the participant, the competition,
    // the session, the header and the endpoints are all held fixed, so the ONLY
    // variable between "no bucket" and "a bucket" is the schedule. Phase 2 is the
    // POSITIVE CONTROL and it is essential — "no presence was recorded" is
    // equally satisfied by a build where presence never works at all.
    const { api, csrf } = await sa();
    const comp = await makeEvent(api, csrf, {
      start_time: new Date(Date.now() + 2 * 3600e3).toISOString(),   // the lobby
      measure_presence: true, time_basis: "presence",
    });
    const u = await makeParticipant(api, csrf);
    await assign(api, csrf, comp.id, [u.id]);

    const p = await enter(u.email, comp.id);
    expect(p.sel.competition.status, "precondition: they are on the countdown page").toBe("upcoming");

    // ── PHASE 1: the lobby ───────────────────────────────────────────────────
    // Both of the requests the finding names. The keepalive is the one that made
    // this reachable without any deliberate act: it fires every ≤30 s while there
    // has been DOM intent, and reading a countdown is DOM intent.
    await p.api.get("/api/status", { headers: { "X-Client-Active": "1" } });
    await p.api.post("/api/session/keepalive", { headers: { ...H(p.csrf), "X-Client-Active": "1" } });
    expect(presenceRow(comp.id, u.id), "waiting for the start is not time ON the platform").toBeNull();

    // ── PHASE 2: the same event, now under way ───────────────────────────────
    // start_time is mutable while the event is still upcoming, so this is the
    // ordinary admin edit rather than a test-only hook.
    const mv = await api.put(`/api/admin/competitions/${comp.id}`, {
      headers: H(csrf), data: { start_time: new Date(Date.now() - 3600e3).toISOString() },
    });
    expect(mv.ok(), `move the start into the past: ${await mv.text()}`).toBeTruthy();
    expect((await compRow(api, comp.id)).status, "precondition: the event is now live").toBe("live");

    await p.api.get("/api/status", { headers: { "X-Client-Active": "1" } });
    const row = presenceRow(comp.id, u.id);
    expect(row, "THE CONTROL — presence still works; only the lobby was excluded").toBeTruthy();
    expect(row.buckets, "and the lobby banked nothing to carry forward").toBe(1);
  });

  test("in a multi-session event the participant's OWN session governs, not the competition", async () => {
    // This is the branch that makes the gate agree with `_stampLoginTimeIfLive`:
    // that helper reads `req.timeslot ? req.timeslotStatus : req.competitionStatus`,
    // so the solve clock refuses to start for someone whose session has not opened
    // even while another cohort is running. A competition-level test cannot see
    // this — `competitionStatus` reads "live" for BOTH participants here — so the
    // mutation this catches is a gate that asks the competition instead of the slot.
    const { api, csrf } = await sa();
    // Created UPCOMING so both session creates land before anything has started.
    const comp = await makeEvent(api, csrf, {
      start_time: new Date(Date.now() + 3600e3).toISOString(),
      measure_presence: true, time_basis: "presence",
    });
    const mkSlot = async (name, startMs, mins) => {
      const r = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, {
        headers: H(csrf), data: { name: `${uniq()} ${name}`, start_time: new Date(startMs).toISOString(), duration_minutes: mins },
      });
      expect(r.ok(), `session ${name}: ${await r.text()}`).toBeTruthy();
      return (await r.json()).timeslot.id;
    };
    const later = await mkSlot("Afternoon", Date.now() + 2 * 3600e3, 60);   // upcoming
    const nowSlot = await mkSlot("Morning", Date.now() - 30 * 60e3, 120);   // live

    const waiting = await makeParticipant(api, csrf);
    const running = await makeParticipant(api, csrf);
    await assign(api, csrf, comp.id, [waiting.id, running.id]);

    const c = await compRow(api, comp.id);
    expect(c.status, "precondition: the COMPETITION reads live — one cohort is running").toBe("live");
    const st = Object.fromEntries(c.timeslots.map(t => [t.id, t.status]));
    expect(st[nowSlot], "precondition: one session is live").toBe("live");
    expect(st[later], "precondition: the other has not opened").toBe("upcoming");

    const pw = await enter(waiting.email, comp.id);
    const selW = await pw.api.post("/api/select-timeslot", { headers: H(pw.csrf), data: { timeslotId: later } });
    expect(selW.ok(), `pick the upcoming session: ${await selW.text()}`).toBeTruthy();

    const pr = await enter(running.email, comp.id);
    // A LIVE session locks the choice, so the pick must be confirmed.
    const selR = await pr.api.post("/api/select-timeslot", { headers: H(pr.csrf), data: { timeslotId: nowSlot, confirmLive: true } });
    expect(selR.ok(), `pick the live session: ${await selR.text()}`).toBeTruthy();

    await pw.api.get("/api/status", { headers: { "X-Client-Active": "1" } });
    await pr.api.get("/api/status", { headers: { "X-Client-Active": "1" } });

    expect(presenceRow(comp.id, waiting.id), "their own session has not opened — nothing accrues").toBeNull();
    // THE CONTROL, inside the same competition: without it "the waiter banked
    // nothing" is satisfied by a build that stopped recording for everybody.
    expect(presenceRow(comp.id, running.id)?.buckets, "the cohort that IS running accrues").toBe(1);
  });
});
