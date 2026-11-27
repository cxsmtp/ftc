// @ts-check
//
// THE FIRST-OPEN SOLVE CLOCK (owner decision, 27 Nov 2026): "the moment anybody
// touches the first question, that is his time to start. It should not be from
// when we begin, because that is unfair."
//
// `competitions.clock_start` = `first_open` | `entry`. A NEW Booth Event or
// Competition is created `first_open` (the kind's seed, lib/event-policy.js
// `clockStartDefault`); every row that existed before the column is `entry` (the
// column DEFAULT is its backfill), and a Program always reads `entry`. On a
// first-open event `competition_users.login_time` — the anchor `solveTimeMs`
// measures from — is written by `stampClockOnFirstTouch` (lib/middleware.js):
// the participant task GET for a scoring challenge, or a stored answer or hint
// if a client reached one first. Entering the event writes none, so a
// participant who has entered and opened nothing is off the board.
//
// Every assertion is by value, each beside a control that the mechanism it rules
// out does run: an `entry` event stamping on entry, an ordinary open stamping
// where a Quick question or an impersonated open does not.
const { test, expect } = require("./isolated-test");
const { gradingHashFor } = require("./helpers");
const {
  H, uniq, MIN, sa, makeParticipant, liveBooth, enrol, participantCtx, submit,
  rawGet, rawAll, expireEvent, outliveCompCache,
} = require("./late-entry-fixture");

const cu = (compId, userId) => rawGet(
  "SELECT login_time, last_login_time FROM competition_users WHERE competition_id=? AND user_id=?", [compId, userId]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** The admin board, read until `pred` holds (the board is cached up to 5 s). */
async function boardUntil(api, compId, pred, message) {
  let last = null;
  await expect.poll(async () => {
    const r = await api.get(`/api/admin/leaderboard?competitionId=${encodeURIComponent(compId)}`);
    last = r.ok() ? await r.json() : null;
    return !!(last && pred(last));
  }, { timeout: 12_000, intervals: [300, 600, 1000], message }).toBe(true);
  return last;
}

/** A live event of `kind` with `n` scoring text challenges (the event's own copies). */
async function liveEvent(api, csrf, kind, { n = 2, create = {} } = {}) {
  return liveBooth(api, csrf, { kind, tasks: n, create: { self_enroll_enabled: false, ...create } });
}

test.describe("first-open solve clock", () => {
  test("defaults: a new Booth Event and Competition start at the first open, a Program on entry; the wire and the form seed agree", async () => {
    const { api, csrf } = await sa();
    try {
      for (const kind of ["booth", "tournament"]) {
        const { comp } = await liveEvent(api, csrf, kind, { n: 1 });
        expect(rawGet("SELECT clock_start FROM competitions WHERE id=?", [comp.id]).clock_start,
          `a new ${kind} event starts each clock at the first open`).toBe("first_open");
        expect(comp.policy.clock_start, "the policy wire offers the choice").toBe("allowed");
      }
      const prog = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `FO prog ${uniq()}`, event_kind: "program", start_time: new Date(Date.now() + 60 * MIN).toISOString(),
        deadline_at: new Date(Date.now() + 30 * 24 * 60 * MIN).toISOString() } });
      expect(prog.ok(), await prog.text()).toBeTruthy();
      const progComp = (await prog.json()).competition;
      expect(rawGet("SELECT clock_start FROM competitions WHERE id=?", [progComp.id]).clock_start,
        "a Program is created on the entry clock (it is unranked)").toBe("entry");
      expect(progComp.policy.clock_start).toBe("never");
      // A Program refuses the first-open clock, rather than storing and ignoring it.
      const refused = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `FO prog2 ${uniq()}`, event_kind: "program", clock_start: "first_open",
        start_time: new Date(Date.now() + 60 * MIN).toISOString(),
        deadline_at: new Date(Date.now() + 30 * 24 * 60 * MIN).toISOString() } });
      expect(refused.status()).toBe(400);
      expect((await refused.json()).code).toBe("clock_start_forbidden");
      // The kind vocabulary seeds the form from the policy, never a literal.
      // (the vocabulary rides the SPA shell's `data-event-kinds`, not /api/config)
      const shell = await (await api.get("/")).text();
      const attr = (shell.match(/data-event-kinds="([^"]*)"/) || [])[1] || "[]";
      const kinds = JSON.parse(attr.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
      const seeds = Object.fromEntries(kinds.map(k => [k.value, k.defaults && k.defaults.clock_start]));
      expect(seeds).toEqual({ booth: "first_open", tournament: "first_open", program: "entry" });
      // An explicit `entry` is honoured.
      const { comp: entryComp } = await liveEvent(api, csrf, "tournament", { n: 1, create: { clock_start: "entry" } });
      expect(rawGet("SELECT clock_start FROM competitions WHERE id=?", [entryComp.id]).clock_start).toBe("entry");
    } finally { await api.dispose(); }
  });

  test("two participants who enter together: the one who opens the first question later gets the shorter solve time and ranks first", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, taskIds } = await liveEvent(api, csrf, "tournament", { n: 2 });
      const a = await makeParticipant(api, csrf, `foa${uniq()}`);
      const b = await makeParticipant(api, csrf, `fob${uniq()}`);
      await enrol(api, csrf, comp.id, a.id);
      await enrol(api, csrf, comp.id, b.id);
      const pa = await participantCtx(a.email, comp.id);
      const pb = await participantCtx(b.email, comp.id);
      try {
        // Both have ENTERED the live event, and made competition-scoped requests.
        expect((await pa.api.get("/api/status")).ok()).toBeTruthy();
        expect((await pb.api.get("/api/status")).ok()).toBeTruthy();
        expect((await pa.api.get("/api/tasks")).ok(), "reading the list starts nothing").toBeTruthy();
        expect(cu(comp.id, a.id).login_time, "entering a first-open event starts no clock").toBeNull();
        expect(cu(comp.id, b.id).login_time, "entering a first-open event starts no clock").toBeNull();
        expect(cu(comp.id, a.id).last_login_time, "the entry itself is still recorded").toBeTruthy();
        // Off the board until the clock starts.
        const before = await (await api.get(`/api/admin/leaderboard?competitionId=${comp.id}`)).json();
        expect(before.map(e => e.userId), "entering without opening keeps them off the board").toEqual([]);

        // A opens the first question; B opens it 1.5 s later.
        const t0 = Date.now();
        expect((await pa.api.get(`/api/tasks/${taskIds[0]}`)).ok()).toBeTruthy();
        const aAnchor = Date.parse(cu(comp.id, a.id).login_time);
        expect(aAnchor, "the first open is the anchor").toBeGreaterThanOrEqual(t0 - 50);
        expect(aAnchor).toBeLessThanOrEqual(Date.now() + 50);
        await sleep(1500);
        expect((await pb.api.get(`/api/tasks/${taskIds[0]}`)).ok()).toBeTruthy();
        const bAnchor = Date.parse(cu(comp.id, b.id).login_time);
        expect(bAnchor - aAnchor, "B's clock started when B opened, not when B arrived").toBeGreaterThanOrEqual(1400);

        // A second open never moves the anchor.
        await sleep(300);
        expect((await pa.api.get(`/api/tasks/${taskIds[1]}`)).ok()).toBeTruthy();
        expect(Date.parse(cu(comp.id, a.id).login_time)).toBe(aAnchor);

        // Both solve the first challenge, A first: equal scores, A finished first.
        expect((await submit(pa.api, pa.csrf, taskIds[0])).ok()).toBeTruthy();
        expect((await submit(pb.api, pb.csrf, taskIds[0])).ok()).toBeTruthy();
        const board = await boardUntil(api, comp.id, (rows) => rows.length === 2 && rows.every(r => r.score > 0),
          "both solvers are on the board");
        const ea = board.find(e => e.userId === a.id);
        const eb = board.find(e => e.userId === b.id);
        expect(ea.score).toBe(eb.score);
        expect(eb.solveTimeMs, "the later opener's time is shorter").toBeLessThan(ea.solveTimeMs);
        expect(ea.solveTimeMs - eb.solveTimeMs, "by about the head start A's earlier open gave A's clock").toBeGreaterThan(1000);
        expect(board[0].userId, "on a score tie the shorter solve time ranks first").toBe(b.id);
      } finally { await pa.api.dispose(); await pb.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("an entry-clock event behaves as before: entering stamps the anchor and puts the participant on the board", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, taskIds } = await liveEvent(api, csrf, "tournament", { n: 2, create: { clock_start: "entry" } });
      const p = await makeParticipant(api, csrf, `foe${uniq()}`);
      await enrol(api, csrf, comp.id, p.id);
      const t0 = Date.now();
      const s = await participantCtx(p.email, comp.id);
      try {
        const anchor = cu(comp.id, p.id).login_time;
        expect(anchor, "select-competition anchors an entry clock").toBeTruthy();
        expect(Date.parse(anchor)).toBeGreaterThanOrEqual(t0 - 50);
        await boardUntil(api, comp.id, (rows) => rows.some(r => r.userId === p.id),
          "an entrant on an entry clock is on the board with no activity");
        await sleep(400);
        expect((await s.api.get(`/api/tasks/${taskIds[0]}`)).ok()).toBeTruthy();
        expect(cu(comp.id, p.id).login_time, "opening a challenge never moves an entry anchor").toBe(anchor);
      } finally { await s.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("a Quick (qualifying) question starts nothing; a scoring challenge's open does", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, taskIds } = await liveEvent(api, csrf, "booth", { n: 2, create: { add_qualifying: true } });
      const p = await makeParticipant(api, csrf, `foq${uniq()}`);
      await enrol(api, csrf, comp.id, p.id);
      const s = await participantCtx(p.email, comp.id);
      try {
        const list = await (await s.api.get("/api/tasks")).json();
        const quick = (Array.isArray(list) ? list : list.tasks || []).find(t => t.qualifying);
        expect(quick, "PRECONDITION: the event asks a Quick question").toBeTruthy();
        expect((await s.api.get(`/api/tasks/${quick.id}`)).ok()).toBeTruthy();
        expect(cu(comp.id, p.id).login_time, "opening a Quick question starts no clock").toBeNull();
        // Answering one starts nothing either, and puts nobody on the board.
        const optId = (quick.choices || [])[0]?.id;
        const q = await s.api.get(`/api/tasks/${quick.id}`);
        const qd = await q.json();
        const ans = await s.api.post(`/api/tasks/${quick.id}/submit`, { headers: H(s.csrf), data: {
          answer: JSON.stringify([optId || (qd.choices || [])[0].id]), gradingHash: await gradingHashFor(s.api, quick.id) } });
        expect(ans.ok(), await ans.text()).toBeTruthy();
        expect(cu(comp.id, p.id).login_time, "a Quick answer starts no clock").toBeNull();
        const off = await (await api.get(`/api/admin/leaderboard?competitionId=${comp.id}`)).json();
        expect(off.map(e => e.userId), "a Quick answer alone does not put anyone on the board").toEqual([]);
        // CONTROL: the scoring challenge's open does start it, after the Quick answer.
        const t0 = Date.now();
        expect((await s.api.get(`/api/tasks/${taskIds[0]}`)).ok()).toBeTruthy();
        const anchor = cu(comp.id, p.id).login_time;
        expect(anchor, "the first scoring open starts the clock").toBeTruthy();
        expect(Date.parse(anchor), "the anchor is the open, never pulled back to the Quick answer").toBeGreaterThanOrEqual(t0 - 50);
      } finally { await s.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("a stored answer, or a hint, reached without an open starts the clock; a 404 open starts nothing", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, taskIds } = await liveEvent(api, csrf, "tournament", { n: 2 });
      const other = await liveEvent(api, csrf, "tournament", { n: 1 });
      const p = await makeParticipant(api, csrf, `fos${uniq()}`);
      await enrol(api, csrf, comp.id, p.id);
      const s = await participantCtx(p.email, comp.id);
      try {
        // Another event's challenge is a 404 here and must not start this clock.
        expect((await s.api.get(`/api/tasks/${other.taskIds[0]}`)).status()).toBe(404);
        expect(cu(comp.id, p.id).login_time).toBeNull();
        // A wrong answer stored without any open.
        const r = await submit(s.api, s.csrf, taskIds[0], "nope");
        expect(r.ok(), await r.text()).toBeTruthy();
        const row = cu(comp.id, p.id);
        const sub = rawGet("SELECT submitted_at FROM submissions WHERE competition_id=? AND user_id=?", [comp.id, p.id]);
        expect(row.login_time, "the stored answer starts the clock").toBeTruthy();
        expect(Date.parse(row.login_time), "at that answer, never later").toBeLessThanOrEqual(Date.parse(sub.submitted_at));
      } finally { await s.api.dispose(); }

      // A HINT asked for without any open (a second participant, a challenge with a hint).
      const t = await api.post("/api/admin/tasks", { headers: H(csrf), data: {
        title: `FO hint ${uniq()}`, description: "<p>x</p>", difficulty: "easy", answer_type: "text",
        correct_answer: "win", hint: "<p>look closer</p>", status: "published" } });
      expect(t.ok(), await t.text()).toBeTruthy();
      const asg = await api.post(`/api/admin/tasks/${(await t.json()).id}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
      expect(asg.ok(), await asg.text()).toBeTruthy();
      const hintTask = (await asg.json()).copies[0].task_id;
      const h = await makeParticipant(api, csrf, `foh${uniq()}`);
      await enrol(api, csrf, comp.id, h.id);
      const sh = await participantCtx(h.email, comp.id);
      try {
        expect(cu(comp.id, h.id).login_time, "PRECONDITION: entered, nothing opened").toBeNull();
        const hr = await sh.api.post(`/api/tasks/${hintTask}/hint`, { headers: H(sh.csrf), data: {} });
        expect(hr.ok(), await hr.text()).toBeTruthy();
        const rev = rawGet("SELECT revealed_at FROM hint_reveals WHERE competition_id=? AND user_id=?", [comp.id, h.id]);
        expect(rev, "PRECONDITION: the hint was taken").toBeTruthy();
        const anchor = cu(comp.id, h.id).login_time;
        expect(anchor, "the hint starts the clock").toBeTruthy();
      } finally { await sh.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("an impersonated open stamps nothing; the participant's own open does", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, taskIds } = await liveEvent(api, csrf, "tournament", { n: 2 });
      const p = await makeParticipant(api, csrf, `foi${uniq()}`);
      await enrol(api, csrf, comp.id, p.id);
      const imp = await api.post(`/api/admin/participants/${p.id}/impersonate`, { headers: H(csrf) });
      expect(imp.status(), await imp.text()).toBe(200);
      const csrf2 = (await (await api.get("/api/csrf-token")).json()).csrfToken;
      expect((await api.post("/api/select-competition", { headers: H(csrf2), data: { competitionId: comp.id } })).ok()).toBeTruthy();
      const open = await api.get(`/api/tasks/${taskIds[0]}`);
      expect(open.status(), "the impersonating admin can open the target's challenge").toBe(200);
      expect(cu(comp.id, p.id).login_time, "peeking must never start the participant's clock").toBeNull();
      await api.post("/api/impersonation/exit", { headers: H(csrf2) }).catch(() => {});
      const s = await participantCtx(p.email, comp.id);
      try {
        expect((await s.api.get(`/api/tasks/${taskIds[0]}`)).ok()).toBeTruthy();
        expect(cu(comp.id, p.id).login_time, "CONTROL: the participant's own open does").toBeTruthy();
      } finally { await s.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("a late entrant's clock starts at their first open in the window, not when they join", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, taskIds } = await liveBooth(api, csrf, { tasks: 1 });
      expect(rawGet("SELECT clock_start FROM competitions WHERE id=?", [comp.id]).clock_start).toBe("first_open");
      await expireEvent(comp.id, { agoMinutes: 10 });
      const p = await makeParticipant(api, csrf, `fol${uniq()}`);
      await enrol(api, csrf, comp.id, p.id);
      const s = await participantCtx(p.email, comp.id);
      try {
        expect((await s.api.get("/api/status")).ok()).toBeTruthy();
        expect(cu(comp.id, p.id).login_time, "joining in the window starts no clock").toBeNull();
        await sleep(300);
        const t0 = Date.now();
        expect((await s.api.get(`/api/tasks/${taskIds[0]}`)).ok()).toBeTruthy();
        const anchor = cu(comp.id, p.id).login_time;
        expect(anchor, "the late entrant's first open starts it").toBeTruthy();
        expect(Date.parse(anchor)).toBeGreaterThanOrEqual(t0 - 50);
      } finally { await s.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("a rejoin restores the first-open anchor; one removed before opening anything starts afresh", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, taskIds } = await liveEvent(api, csrf, "tournament", { n: 2 });
      const p = await makeParticipant(api, csrf, `for${uniq()}`);
      const q = await makeParticipant(api, csrf, `fon${uniq()}`);
      await enrol(api, csrf, comp.id, p.id);
      await enrol(api, csrf, comp.id, q.id);
      const sp = await participantCtx(p.email, comp.id);
      const sq = await participantCtx(q.email, comp.id);
      let anchor;
      try {
        expect((await sp.api.get(`/api/tasks/${taskIds[0]}`)).ok()).toBeTruthy();
        anchor = cu(comp.id, p.id).login_time;
        expect(anchor).toBeTruthy();
        expect(cu(comp.id, q.id).login_time, "PRECONDITION: q entered and opened nothing").toBeNull();
      } finally { await sp.api.dispose(); await sq.api.dispose(); }
      for (const u of [p, q]) {
        const del = await api.delete(`/api/admin/competitions/${comp.id}/users/${u.id}`, { headers: H(csrf) });
        expect(del.ok(), await del.text()).toBeTruthy();
      }
      expect(rawAll("SELECT user_id, login_time FROM competition_user_absences WHERE competition_id=?", [comp.id]),
        "only the participant whose clock had started leaves an anchor to restore").toEqual([{ user_id: p.id, login_time: anchor }]);
      await sleep(300);
      await enrol(api, csrf, comp.id, p.id);
      await enrol(api, csrf, comp.id, q.id);
      expect(cu(comp.id, p.id).login_time, "the rejoin restores the anchor the first open wrote").toBe(anchor);
      const sp2 = await participantCtx(p.email, comp.id);
      const sq2 = await participantCtx(q.email, comp.id);
      try {
        expect((await sp2.api.get(`/api/tasks/${taskIds[1]}`)).ok()).toBeTruthy();
        expect(cu(comp.id, p.id).login_time, "opening again never re-anchors").toBe(anchor);
        const t0 = Date.now();
        expect((await sq2.api.get(`/api/tasks/${taskIds[0]}`)).ok()).toBeTruthy();
        expect(Date.parse(cu(comp.id, q.id).login_time), "q's clock starts at q's first open, now").toBeGreaterThanOrEqual(t0 - 50);
      } finally { await sp2.api.dispose(); await sq2.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("entering a live session locks the session choice even before a challenge is opened", async () => {
    const { api, csrf } = await sa();
    try {
      const create = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `FO sess ${uniq()}`, start_time: new Date(Date.now() - 10 * MIN).toISOString(), duration_minutes: 600 } });
      expect(create.ok(), await create.text()).toBeTruthy();
      const comp = (await create.json()).competition;
      const mk = async (name, offsetMin) => {
        const r = await api.post(`/api/admin/competitions/${comp.id}/timeslots`, { headers: H(csrf), data: {
          name, start_time: new Date(Date.now() + offsetMin * MIN).toISOString(), duration_minutes: 120 } });
        expect(r.ok(), await r.text()).toBeTruthy();
        return (await r.json()).timeslot.id;
      };
      const live = await mk("Now", -5);
      const later = await mk("Later", 240);
      const p = await makeParticipant(api, csrf, `fot${uniq()}`);
      await enrol(api, csrf, comp.id, p.id);
      const s = await participantCtx(p.email, comp.id);
      try {
        const pick = await s.api.post("/api/select-timeslot", { headers: H(s.csrf), data: { timeslotId: live, confirmLive: true } });
        expect(pick.ok(), await pick.text()).toBeTruthy();
        expect(cu(comp.id, p.id).login_time, "entering the live session starts no clock").toBeNull();
        const sw = await s.api.post("/api/select-timeslot", { headers: H(s.csrf), data: { timeslotId: later } });
        expect(sw.status(), "the confirm said the choice is final once joined").toBe(400);
        expect((await sw.json()).error).toMatch(/already entered a live session/);
      } finally { await s.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("the setting is locked once the event starts, editable before, and recorded", async () => {
    const { api, csrf } = await sa();
    try {
      const up = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `FO up ${uniq()}`, start_time: new Date(Date.now() + 60 * MIN).toISOString(), duration_minutes: 60 } });
      const upComp = (await up.json()).competition;
      expect(upComp.clock_start_locked, "an upcoming event offers the choice").toBeNull();
      const put = await api.put(`/api/admin/competitions/${upComp.id}`, { headers: H(csrf), data: { clock_start: "entry" } });
      expect(put.ok(), await put.text()).toBeTruthy();
      expect(rawGet("SELECT clock_start FROM competitions WHERE id=?", [upComp.id]).clock_start).toBe("entry");
      await expect.poll(() => rawAll("SELECT details FROM competition_events WHERE competition_id=? AND event_type='edited'", [upComp.id])
        .map(r => JSON.parse(r.details).changes?.clock_start).filter(Boolean),
      { timeout: 5000 }).toEqual([{ from: "first_open", to: "entry" }]);

      const { comp } = await liveEvent(api, csrf, "tournament", { n: 1 });
      const list = await (await api.get("/api/admin/competitions")).json();
      const row = (Array.isArray(list) ? list : list.competitions || []).find(c => c.id === comp.id);
      expect(row.clock_start_locked, "the live event withholds the choice, from the PUT's predicate").toBe("started");
      const locked = await api.put(`/api/admin/competitions/${comp.id}`, { headers: H(csrf), data: { clock_start: "entry" } });
      expect(locked.status()).toBe(400);
      expect((await locked.json()).code).toBe("clock_start_locked");
      // An echo of the stored value is no change, so a rename still saves.
      await outliveCompCache();
      const echo = await api.put(`/api/admin/competitions/${comp.id}`, { headers: H(csrf), data: { clock_start: "first_open", name: `FO renamed ${uniq()}` } });
      expect(echo.ok(), await echo.text()).toBeTruthy();
    } finally { await api.dispose(); }
  });

  test("time on platform is not counted before a first-open clock starts", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, taskIds } = await liveEvent(api, csrf, "tournament", { n: 2, create: { measure_presence: true } });
      const p = await makeParticipant(api, csrf, `fop${uniq()}`);
      await enrol(api, csrf, comp.id, p.id);
      const s = await participantCtx(p.email, comp.id);
      try {
        const active = { "X-Client-Active": "1" };
        expect((await s.api.get("/api/status", { headers: active })).ok()).toBeTruthy();
        expect(rawAll("SELECT * FROM competition_presence WHERE competition_id=? AND user_id=?", [comp.id, p.id]),
          "no bucket before the clock starts").toEqual([]);
        expect((await s.api.get(`/api/tasks/${taskIds[0]}`)).ok()).toBeTruthy();
        expect((await s.api.get("/api/status", { headers: active })).ok()).toBeTruthy();
        expect(rawAll("SELECT * FROM competition_presence WHERE competition_id=? AND user_id=?", [comp.id, p.id]).length,
          "CONTROL: once it has started, activity counts").toBe(1);
      } finally { await s.api.dispose(); }
    } finally { await api.dispose(); }
  });
});
