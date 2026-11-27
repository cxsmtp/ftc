// @ts-check
//
// v8.6.0 — LATE ENTRIES, end to end.
//
// A Booth Event is a stand in a hall. Somebody scans the QR at 16:55 for a 17:00
// close, and by the time they have registered and signed in the event is over:
// they hold an account, an enrolment and no way to play. This file drives the
// window that keeps that door open, the classification that decides whose scores
// are ranked separately because of it, and the boundaries on both.
//
// ── HOW EVERY FIXTURE HERE MANUFACTURES "THE EVENT HAS ENDED" ────────────────
//
// The suite has no clock control, so an event that has ended and whose late window
// is open is built BACKWARDS: create it LIVE, enrol and act, then move `start_time`
// into the past so the schedule puts the end behind us. (When this was written an
// ENDED competition refused the assign — fixture checklist item 8. Since v8.12.6 an
// event still taking late entries ADMITS it, and whoever it adds is a late entrant;
// these fixtures still enrol while LIVE, because what they need is ordinary
// members who were in the event before it ended. The fixtures themselves now live
// in tests/late-entry-fixture.js.) That is a real, reachable state
// — a time-expired event leaves `ended_at` NULL, which is one of the two kinds of
// ended this platform models — and it is written directly because the PUT
// deliberately refuses a start change that would end a live event (v8.3.10).
//
// The 1-second competition-row cache means every direct write has to be waited
// out, or a handler reads the pre-write row and the assertion is about nothing.
//
// ── WHAT EACH GROUP IS ACTUALLY WORTH ───────────────────────────────────────
//
//   * The JOIN tests lock the one predicate every door funnels through
//     (`_competitionAcceptsSelfEnroll`). Their CONTROL is a booth with the toggle
//     OFF: "the join succeeded" is equally satisfied by a build that stopped
//     refusing ended events altogether, which would be far worse than the feature
//     not working.
//   * The CLASSIFICATION tests are the ones that distinguish this feature from
//     "everybody plays on". Every one carries an ordinary participant of the SAME
//     event who must NOT be able to act — without that, a build that simply
//     removed the ended gate passes the whole file.
//   * The RANKING test is the exploit lock. A late entrant's `login_time` is after
//     the event's effective end by construction, so the ordinary reference end
//     gives them a NEGATIVE solve time which the v7.21.3 clamp turns into ZERO —
//     the best possible value on the sole score-tie tie-break. It asserts a real
//     positive number, which is the only assertion that can catch that.
const { test, expect } = require("./isolated-test");
// v8.12.6 — the helpers below were moved VERBATIM into tests/late-entry-fixture.js,
// so the late-entry assignment specs build their fixtures the same way.
const {
  H, uniq, MIN, CACHE_TTL_MS, outliveCompCache,
  sa, makeParticipant, rawUpdateComp, rawGetComp, rawSetAssignedAt, liveBooth, enrol,
  expireEvent, rawBackdateSubmissions, participantCtx, submit, rawGet, rawBackdate,
} = require("./late-entry-fixture");

// ═══════════════════════════════════════════════════════════════════════════
// The join door
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.6.0 — joining after the event has ended", () => {
  test("the join link still works inside the window — and does NOT with late entries off", async () => {
    const { api, csrf } = await sa();
    try {
      // ── THE CONTROL, and it carries most of this test's weight. "The join
      // succeeded" is equally satisfied by a build that stopped refusing ended
      // events at all, which is a far worse regression than the feature not
      // working. An identical booth with the toggle OFF must still refuse.
      const off = await liveBooth(api, csrf, { create: { late_entry_enabled: false } });
      const offTok = (await (await api.get(`/api/admin/competitions/${off.comp.id}/self-enroll`)).json()).token;
      await expireEvent(off.comp.id);
      const offPrev = await api.get(`/api/competitions/self-enroll/${offTok}`);
      expect(offPrev.status(), "control: an ended booth with late entries OFF still 404s the preview").toBe(404);

      // ── THE SUBJECT ──
      const on = await liveBooth(api, csrf);
      expect(on.comp.late_entry_enabled, "late entries default ON for a Booth Event").toBeTruthy();
      const tok = (await (await api.get(`/api/admin/competitions/${on.comp.id}/self-enroll`)).json()).token;
      // CONTROL: while the event is live the preview says so, with no window flag.
      const livePrev = await api.get(`/api/competitions/self-enroll/${tok}`);
      expect(livePrev.status()).toBe(200);
      expect(await livePrev.json(), "a live event's preview").toMatchObject({ status: "live", late_entry_window_open: false });
      await expireEvent(on.comp.id);

      const prev = await api.get(`/api/competitions/self-enroll/${tok}`);
      expect(prev.status(), `the preview resolves inside the window: ${await prev.text()}`).toBe(200);
      // The landing labels it from this flag ("Late entry open", not "Ended").
      expect(await prev.json(), "the preview says the window is open").toMatchObject({ status: "ended", late_entry_window_open: true });

      // And the authenticated join, which is the door a returning walk-up uses.
      const p = await makeParticipant(api, csrf, uniq());
      const { api: pApi, csrf: pCsrf } = await participantCtx(p.email, null);
      try {
        const join = await pApi.post("/api/competitions/join", { headers: H(pCsrf), data: { token: tok } });
        expect(join.ok(), `join inside the window: ${await join.text()}`).toBeTruthy();
      } finally { await pApi.dispose(); }
    } finally { await api.dispose(); }
  });

  test("the window CLOSES at the deadline, and the refusal is the ordinary ended one", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp } = await liveBooth(api, csrf);
      const tok = (await (await api.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json()).token;
      // Ended three days ago: past the 48-hour default, so the window has closed.
      await expireEvent(comp.id, { agoMinutes: 3 * 24 * 60 });
      const prev = await api.get(`/api/competitions/self-enroll/${tok}`);
      expect(prev.status(), "past the deadline the preview 404s exactly as before").toBe(404);
    } finally { await api.dispose(); }
  });

  test("a Competition never opens a window, whatever its column says", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp } = await liveBooth(api, csrf, { kind: "tournament" });
      const tok = (await (await api.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json()).token;
      // The column is FORCED on, which the API refuses — so this is the theorem
      // test: whatever the row holds, the POLICY prohibition answers first. It is
      // the only test in this file that distinguishes the policy clause from the
      // column clause.
      rawUpdateComp(comp.id, "late_entry_enabled=1");
      await expireEvent(comp.id);
      const prev = await api.get(`/api/competitions/self-enroll/${tok}`);
      expect(prev.status(), "a forced column does not defeat the prohibition").toBe(404);
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Who is a late entrant, and who may play on
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.6.0 — the classification", () => {
  test("a late arrival plays on; an ordinary participant of the SAME event does not", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, taskIds } = await liveBooth(api, csrf, { tasks: 2 });
      const early = await makeParticipant(api, csrf, uniq());
      const late = await makeParticipant(api, csrf, uniq());
      await enrol(api, csrf, comp.id, early.id);
      await enrol(api, csrf, comp.id, late.id);

      const effEnd = await expireEvent(comp.id);
      // `early` joined while the event was live; `late` five minutes AFTER the
      // close. Both rows are written by the same path, so the ONLY thing
      // separating them is the timestamp — which is the rule under test.
      rawSetAssignedAt(comp.id, early.id, new Date(effEnd.getTime() - 60 * MIN).toISOString());
      rawSetAssignedAt(comp.id, late.id, new Date(effEnd.getTime() + 5 * MIN).toISOString());

      // ── THE CONTROL. Without it, a build that simply deleted the ended gate
      // passes every other assertion in this file.
      const e = await participantCtx(early.email, comp.id);
      try {
        const st = await (await e.api.get("/api/status")).json();
        expect(st.status, "an ordinary participant's event is over").toBe("ended");
        expect(st.late_entry.is_late_entrant, "and they are not a late entrant").toBeFalsy();
        const sub = await submit(e.api, e.csrf, taskIds[0]);
        expect(sub.status(), "and they cannot submit").toBe(403);
      } finally { await e.api.dispose(); }

      // ── THE SUBJECT ──
      const l = await participantCtx(late.email, comp.id);
      try {
        const st = await (await l.api.get("/api/status")).json();
        expect(st.late_entry.is_late_entrant, "the late arrival is classified late").toBeTruthy();
        expect(st.late_entry.window_open, "and their window is open").toBeTruthy();
        // `/api/status` has always described the CALLER's own window, which is why
        // a multi-session participant gets their timeslot's — so a late entrant is
        // told "live", ending at the late deadline.
        expect(st.status, "their own window is live").toBe("live");
        expect(new Date(st.end).getTime(), "and it runs to the late deadline")
          .toBeGreaterThan(effEnd.getTime());

        const sub = await submit(l.api, l.csrf, taskIds[0]);
        const body = await sub.json();
        expect(sub.status(), `a late entrant may submit: ${JSON.stringify(body)}`).toBe(200);
        expect(body.correct, "and it is graded").toBeTruthy();

        // The hint gate is a separate site and moves with the submit one.
        const hint = await l.api.post(`/api/tasks/${taskIds[1]}/hint`, { headers: H(l.csrf) });
        expect([200, 400]).toContain(hint.status());   // 400 only if the task has no hint
        expect(hint.status(), "the hint gate is not the ended refusal").not.toBe(403);
      } finally { await l.api.dispose(); }
    } finally { await api.dispose(); }
  });

  // Operator ruling, 29 Oct 2026 — THERE IS NO PRE-WINDOW. Somebody who joined
  // five minutes before the close and had NOT finished used to be a late entrant
  // (the old ten-minute rule); now anyone who joined the LIVE event is ordinary.
  // The control is the same person shape one minute after the end: late.
  test("somebody who joined minutes BEFORE the end, unfinished, is an ordinary participant (no pre-window)", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, taskIds } = await liveBooth(api, csrf, { tasks: 2 });
      const justBefore = await makeParticipant(api, csrf, uniq());
      const justAfter = await makeParticipant(api, csrf, uniq());
      for (const u of [justBefore, justAfter]) await enrol(api, csrf, comp.id, u.id);

      // One solve of two while LIVE: they are on the board and NOT finished, which
      // is exactly the person the old pre-window made late.
      const b = await participantCtx(justBefore.email, comp.id);
      try {
        const sub = await submit(b.api, b.csrf, taskIds[0]);
        expect((await sub.json()).correct, "the solve must land while live").toBeTruthy();
      } finally { await b.api.dispose(); }

      const effEnd = await expireEvent(comp.id);
      rawSetAssignedAt(comp.id, justBefore.id, new Date(effEnd.getTime() - 5 * MIN).toISOString());
      rawBackdateSubmissions(comp.id, justBefore.id, new Date(effEnd.getTime() - 2 * MIN).toISOString());
      rawSetAssignedAt(comp.id, justAfter.id, new Date(effEnd.getTime() + 1 * MIN).toISOString());

      const b2 = await participantCtx(justBefore.email, comp.id);
      try {
        const st = await (await b2.api.get("/api/status")).json();
        expect(st.late_entry.window_open, "the window IS open — this is not why they are ordinary").toBeTruthy();
        expect(st.late_entry.is_late_entrant, "a live-event joiner is NOT a late entrant").toBeFalsy();
        expect(st.status, "so their event is over like everybody else's").toBe("ended");
      } finally { await b2.api.dispose(); }
      const a2 = await participantCtx(justAfter.email, comp.id);
      try {
        const st = await (await a2.api.get("/api/status")).json();
        expect(st.late_entry.is_late_entrant, "CONTROL: a post-end joiner IS a late entrant").toBeTruthy();
      } finally { await a2.api.dispose(); }

      // And they are on the MAIN board, not the late one.
      const board = await (await api.get(`/api/admin/leaderboard?competitionId=${comp.id}`)).json();
      const row = board.find(u => u.nickname === justBefore.nickname);
      expect(row, "the live joiner is on the board").toBeTruthy();
      expect(row.isLateEntrant, "on the MAIN section").toBeFalsy();
    } finally { await api.dispose(); }
  });

  test("an ALREADY-ENROLLED participant who returns is not made late by coming back", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, taskIds } = await liveBooth(api, csrf, { tasks: 1 });
      const p = await makeParticipant(api, csrf, uniq());
      await enrol(api, csrf, comp.id, p.id);
      const tok = (await (await api.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json()).token;
      const effEnd = await expireEvent(comp.id);
      rawSetAssignedAt(comp.id, p.id, new Date(effEnd.getTime() - 60 * MIN).toISOString());

      // They open the join link again inside the window. Every enrolment INSERT is
      // INSERT OR IGNORE, so `assigned_at` is NOT re-stamped — they joined an hour
      // before the close and coming back does not change that.
      const c = await participantCtx(p.email, comp.id);
      try {
        const join = await c.api.post("/api/competitions/join", { headers: H(c.csrf), data: { token: tok } });
        expect(join.ok(), `re-join is idempotent: ${await join.text()}`).toBeTruthy();
        const st = await (await c.api.get("/api/status")).json();
        expect(st.late_entry.is_late_entrant, "re-opening the link does not make somebody late").toBeFalsy();
        const sub = await submit(c.api, c.csrf, taskIds[0]);
        expect(sub.status(), "and they still cannot play on").toBe(403);
      } finally { await c.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("the window closing stops play, and the refusal is the ordinary ended one", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, taskIds } = await liveBooth(api, csrf, { tasks: 1 });
      const p = await makeParticipant(api, csrf, uniq());
      await enrol(api, csrf, comp.id, p.id);
      // Ended three days ago — past the 48-hour default.
      const effEnd = await expireEvent(comp.id, { agoMinutes: 3 * 24 * 60 });
      rawSetAssignedAt(comp.id, p.id, new Date(effEnd.getTime() + 5 * MIN).toISOString());

      const c = await participantCtx(p.email, comp.id);
      try {
        const st = await (await c.api.get("/api/status")).json();
        expect(st.late_entry.is_late_entrant, "they DID arrive late").toBeTruthy();
        expect(st.late_entry.window_open, "but the window has closed").toBeFalsy();
        expect(st.status, "so their window is over too").toBe("ended");
        const sub = await submit(c.api, c.csrf, taskIds[0]);
        expect(sub.status(), "and they cannot submit").toBe(403);
      } finally { await c.api.dispose(); }
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The board
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.6.0 — the late-entrant section of the leaderboard", () => {
  test("late entrants are ranked separately, and their solve time is a REAL number", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, taskIds } = await liveBooth(api, csrf, { tasks: 2 });
      const main = await makeParticipant(api, csrf, uniq());
      const lateA = await makeParticipant(api, csrf, uniq());
      const lateB = await makeParticipant(api, csrf, uniq());
      for (const u of [main, lateA, lateB]) await enrol(api, csrf, comp.id, u.id);

      // `main` scores while the event is live, so the main board has a real row.
      const m = await participantCtx(main.email, comp.id);
      try { expect((await (await submit(m.api, m.csrf, taskIds[0])).json()).correct).toBeTruthy(); }
      finally { await m.api.dispose(); }

      const effEnd = await expireEvent(comp.id);
      rawSetAssignedAt(comp.id, main.id, new Date(effEnd.getTime() - 60 * MIN).toISOString());
      rawSetAssignedAt(comp.id, lateA.id, new Date(effEnd.getTime() + 2 * MIN).toISOString());
      rawSetAssignedAt(comp.id, lateB.id, new Date(effEnd.getTime() + 10 * MIN).toISOString());

      // Both late entrants score, A more than B, so the ordering is decided by
      // SCORE rather than by a tie-break that might be masking the clamp bug.
      const a = await participantCtx(lateA.email, comp.id);
      try {
        expect((await (await submit(a.api, a.csrf, taskIds[0])).json()).correct).toBeTruthy();
        expect((await (await submit(a.api, a.csrf, taskIds[1])).json()).correct).toBeTruthy();
      } finally { await a.api.dispose(); }
      const b = await participantCtx(lateB.email, comp.id);
      try { expect((await (await submit(b.api, b.csrf, taskIds[0])).json()).correct).toBeTruthy(); }
      finally { await b.api.dispose(); }

      const board = await (await api.get(`/api/admin/leaderboard?competitionId=${comp.id}`)).json();
      const rowOf = n => board.find(u => u.nickname === n);

      expect(rowOf(main.nickname).isLateEntrant, "the early scorer is on the main section").toBeFalsy();
      expect(rowOf(main.nickname).rank, "and holds rank 1 of it").toBe(1);

      const A = rowOf(lateA.nickname), Bb = rowOf(lateB.nickname);
      expect(A.isLateEntrant && Bb.isLateEntrant, "both late arrivals are marked late").toBeTruthy();
      // Ranks are WITHIN the late section, which is why "#1" appears twice on this
      // board and why the CSV needs its own column to tell the two apart.
      expect(A.rank, "the higher-scoring late entrant is 1st of the late section").toBe(1);
      expect(Bb.rank, "and the other is 2nd").toBe(2);

      // ── THE EXPLOIT LOCK ──
      // A late entrant's login_time is after the event's effective end, so the
      // ORDINARY reference end gives a negative solve time which the v7.21.3 clamp
      // turns into ZERO — the best possible value on the sole score-tie tie-break.
      // A real positive number is the only assertion that catches that.
      expect(Bb.solveTimeMs, "a late entrant's solve time is measured against THEIR window").toBeGreaterThan(0);
      expect(A.solveTimeMs, "for both of them").toBeGreaterThan(0);

      // And the participant wire carries the section under the main board's rules.
      const p = await participantCtx(lateA.email, comp.id);
      try {
        const lb = await (await p.api.get("/api/leaderboard")).json();
        expect(lb.lateBoard, "the participant wire carries a late board").toBeTruthy();
        expect(lb.lateBoard.board.map(r => r.nickname), "with both late entrants")
          .toEqual(expect.arrayContaining([lateA.nickname, lateB.nickname]));
        expect(lb.board.map(r => r.nickname), "and the MAIN board excludes them")
          .not.toEqual(expect.arrayContaining([lateA.nickname]));
        expect(lb.board.map(r => r.nickname), "while keeping the early scorer")
          .toEqual(expect.arrayContaining([main.nickname]));
        // No `_`-prefixed internal may reach a participant entry — the structural
        // rule `stripInternal` enforces and net-active-time.spec.js locks.
        for (const row of [...lb.lateBoard.board, lb.lateBoard.me].filter(Boolean)) {
          for (const k of Object.keys(row)) {
            expect(k.startsWith("_"), `late board leaks an internal key: ${k}`).toBeFalsy();
          }
        }
      } finally { await p.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("with no late entrants the section is absent, not empty", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, taskIds } = await liveBooth(api, csrf, { tasks: 1 });
      const p = await makeParticipant(api, csrf, uniq());
      await enrol(api, csrf, comp.id, p.id);
      const c = await participantCtx(p.email, comp.id);
      try {
        expect((await (await submit(c.api, c.csrf, taskIds[0])).json()).correct).toBeTruthy();
        const lb = await (await c.api.get("/api/leaderboard")).json();
        expect(lb.lateBoard, "no late entrants means no section at all").toBeNull();
      } finally { await c.api.dispose(); }
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Certificates
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.6.0 — a late entrant's certificate says so", () => {
  test("participation while the window is open; the marker is frozen and rendered", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, taskIds } = await liveBooth(api, csrf, { tasks: 1 });
      const p = await makeParticipant(api, csrf, uniq());
      await enrol(api, csrf, comp.id, p.id);
      const effEnd = await expireEvent(comp.id);
      rawSetAssignedAt(comp.id, p.id, new Date(effEnd.getTime() + 5 * MIN).toISOString());

      const c = await participantCtx(p.email, comp.id);
      try {
        expect((await (await submit(c.api, c.csrf, taskIds[0])).json()).correct, "the late entrant scores").toBeTruthy();
        const mint = await c.api.post(`/api/competitions/${comp.id}/badge`, { headers: H(c.csrf) });
        expect(mint.ok(), `mint: ${await mint.text()}`).toBeTruthy();
        const badge = await mint.json();
        expect(badge.lateEntrant, "the payload says late entrant").toBeTruthy();
        // PARTICIPATION only while the window is open: a placement is not knowable
        // until the late board is final, which is the rule the platform has always
        // enforced, applied to the board that is still moving.
        expect(badge.basis, "participation while the window is open").toBe("participation");

        // The artefacts. The PNG and the PDF render on request from the FROZEN
        // column, so both must carry the marker or the picture and the paper
        // disagree about what the certificate attests.
        const png = await c.api.get(`/badge/${badge.token}/badge.png`);
        expect(png.ok(), "the PNG renders").toBeTruthy();
        // v8.6.2 — the page is withheld until its holder shares, so publishing it
        // is a PRECONDITION here. The subject is unchanged: what the page SAYS
        // about a late entrant, not when it goes live.
        const sh = await c.api.post(`/badge/${badge.token}/shared`, { headers: { "x-csrf-token": c.csrf } });
        expect(sh.ok(), await sh.text()).toBeTruthy();
        const page = await c.api.get(`/badge/${badge.token}`);
        expect(page.ok(), "the public page resolves once shared").toBeTruthy();
        expect(await page.text(), "and its sentence says late entrant").toContain("late entrant");

        // And the verification page a third party reads.
        const cred = await c.api.post("/credential", {
          form: { code: badge.publicCode, surname: "Probe" },
        });
        expect(cred.ok(), "the credential page answers").toBeTruthy();
        const credHtml = await cred.text();
        expect(credHtml, "the certificate resolves").toContain("Certificate verified");
        expect(credHtml, "and the page states the entry route").toContain("Late entrant");
      } finally { await c.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("an ORDINARY participant's certificate is unchanged", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, taskIds } = await liveBooth(api, csrf, { tasks: 1 });
      const p = await makeParticipant(api, csrf, uniq());
      await enrol(api, csrf, comp.id, p.id);
      const c1 = await participantCtx(p.email, comp.id);
      try { expect((await (await submit(c1.api, c1.csrf, taskIds[0])).json()).correct).toBeTruthy(); }
      finally { await c1.api.dispose(); }

      const effEnd = await expireEvent(comp.id);
      rawSetAssignedAt(comp.id, p.id, new Date(effEnd.getTime() - 60 * MIN).toISOString());

      const c = await participantCtx(p.email, comp.id);
      try {
        const mint = await c.api.post(`/api/competitions/${comp.id}/badge`, { headers: H(c.csrf) });
        expect(mint.ok(), `mint: ${await mint.text()}`).toBeTruthy();
        const badge = await mint.json();
        expect(badge.lateEntrant, "an ordinary participant's certificate is NOT marked").toBeFalsy();
        // Placement, because they are alone on a main board they finished — the
        // ordinary path, unaffected by the window being open.
        expect(badge.basis, "and the ordinary placement rules still apply").toBe("placement");
        const page = await c.api.get(`/badge/${badge.token}`);
        expect(await page.text(), "the page says nothing about late entry").not.toContain("late entrant");
      } finally { await c.api.dispose(); }
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The admin surface: the deadline, its boundaries and the audit
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.6.0 — configuring the window", () => {
  test("the deadline FOLLOWS the end while unpinned, and STOPS following once pinned", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp } = await liveBooth(api, csrf, { duration: 60 });
      const readWire = async () => (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === comp.id);

      const before = await readWire();
      expect(before.late_entry_deadline_at, "unpinned by default").toBeNull();
      const end1 = new Date(new Date(before.start_time).getTime() + before.duration_minutes * MIN);
      expect(new Date(before.late_entry_deadline_effective).getTime(), "resolved to end + 48 h")
        .toBe(end1.getTime() + 48 * 3600_000);

      // Move the end. The resolved deadline must move with it — which is the whole
      // point of storing NULL rather than a computed timestamp.
      const put = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { duration_minutes: 120, expectedUpdatedAt: before.updated_at },
      });
      expect(put.ok(), `extend: ${await put.text()}`).toBeTruthy();
      const after = await readWire();
      expect(new Date(after.late_entry_deadline_effective).getTime(), "the deadline followed the end")
        .toBe(end1.getTime() + 60 * MIN + 48 * 3600_000);

      // Pin it. Now it must NOT follow.
      const pinned = new Date(end1.getTime() + 60 * MIN + 6 * 3600_000).toISOString();
      const pin = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { late_entry_deadline_at: pinned, expectedUpdatedAt: after.updated_at },
      });
      expect(pin.ok(), `pin: ${await pin.text()}`).toBeTruthy();
      const pinnedRow = await readWire();
      expect(new Date(pinnedRow.late_entry_deadline_at).getTime()).toBe(new Date(pinned).getTime());

      const put2 = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { duration_minutes: 180, expectedUpdatedAt: pinnedRow.updated_at },
      });
      expect(put2.ok(), `extend again: ${await put2.text()}`).toBeTruthy();
      const stillPinned = await readWire();
      expect(new Date(stillPinned.late_entry_deadline_effective).getTime(), "a pinned deadline does NOT follow")
        .toBe(new Date(pinned).getTime());

      // And clearing it puts it back on automatic — the instruction `allowEmpty`
      // on the server's date rule exists to make expressible.
      const clear = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { late_entry_deadline_at: "", expectedUpdatedAt: stillPinned.updated_at },
      });
      expect(clear.ok(), `clear: ${await clear.text()}`).toBeTruthy();
      const cleared = await readWire();
      expect(cleared.late_entry_deadline_at, "cleared back to automatic").toBeNull();
      expect(new Date(cleared.late_entry_deadline_effective).getTime(), "and follows the end again")
        .toBe(end1.getTime() + 120 * MIN + 48 * 3600_000);
    } finally { await api.dispose(); }
  });

  test("a deadline before the end, or absurdly far out, is REFUSED rather than clamped", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp } = await liveBooth(api, csrf, { duration: 60 });
      const row = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === comp.id);
      const end = new Date(new Date(row.start_time).getTime() + row.duration_minutes * MIN);

      const early = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf),
        data: { late_entry_deadline_at: new Date(end.getTime() - MIN).toISOString(), expectedUpdatedAt: row.updated_at },
      });
      expect(early.status(), "a deadline before the end is refused").toBe(400);
      expect((await early.json()).code).toBe("late_entry_deadline_invalid");

      const far = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf),
        data: { late_entry_deadline_at: new Date(end.getTime() + 90 * 24 * 3600_000).toISOString(), expectedUpdatedAt: row.updated_at },
      });
      expect(far.status(), "and one 90 days out is refused").toBe(400);
      expect((await far.json()).code).toBe("late_entry_deadline_invalid");

      // Nothing was stored by either refusal.
      expect(rawGetComp(comp.id).late_entry_deadline_at, "a refusal stores nothing").toBeNull();
    } finally { await api.dispose(); }
  });

  test("the settings are REFUSED for a kind that cannot run a window, at create AND at edit", async () => {
    const { api, csrf } = await sa();
    try {
      const bad = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: {
          name: `LE refuse ${uniq()}`, event_kind: "tournament",
          start_time: new Date(Date.now() + MIN).toISOString(), duration_minutes: 60,
          late_entry_enabled: true,
        },
      });
      expect(bad.status(), "create refuses it for a Competition").toBe(400);
      expect((await bad.json()).code).toBe("late_entry_forbidden");

      // The EDIT mirror matters independently: without it an admin reaches the
      // forbidden state by REORDERING — create a Booth Event with a window, then
      // change the kind.
      const { comp } = await liveBooth(api, csrf, { kind: "tournament" });
      const row = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === comp.id);
      const put = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { late_entry_enabled: true, expectedUpdatedAt: row.updated_at },
      });
      expect(put.status(), "and the PUT refuses it too").toBe(400);
      expect((await put.json()).code).toBe("late_entry_forbidden");
    } finally { await api.dispose(); }
  });

  test("a kind change away from Booth RESETS both columns", async () => {
    const { api, csrf } = await sa();
    try {
      // Upcoming and sessionless, which is the only state in which the kind may
      // change (eventKindChangeLock).
      const create = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: {
          name: `LE kind ${uniq()}`, event_kind: "booth",
          start_time: new Date(Date.now() + 60 * MIN).toISOString(), duration_minutes: 60,
        },
      });
      expect(create.ok(), `create: ${await create.text()}`).toBeTruthy();
      const comp = (await create.json()).competition;
      const end = new Date(new Date(comp.start_time).getTime() + 60 * MIN);
      const row0 = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === comp.id);
      const pin = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf),
        data: { late_entry_deadline_at: new Date(end.getTime() + 6 * 3600_000).toISOString(), expectedUpdatedAt: row0.updated_at },
      });
      expect(pin.ok(), `pin: ${await pin.text()}`).toBeTruthy();
      const row1 = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === comp.id);
      expect(row1.late_entry_deadline_at, "pinned before the kind change").toBeTruthy();

      const change = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { event_kind: "tournament", expectedUpdatedAt: row1.updated_at },
      });
      expect(change.ok(), `kind change: ${await change.text()}`).toBeTruthy();
      const after = rawGetComp(comp.id);
      // Clearing is what makes "booth events only" true of the DATA and not merely
      // of the readers: a dormant deadline must not spring back to life if the
      // event is ever changed back.
      expect(after.late_entry_deadline_at, "the deadline is cleared").toBeNull();
      expect(after.late_entry_enabled, "and the toggle goes to the target kind's seed").toBe(0);
    } finally { await api.dispose(); }
  });

  test("both columns are AUDITED at create and at edit", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp } = await liveBooth(api, csrf, { duration: 60 });
      const row = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === comp.id);
      const end = new Date(new Date(row.start_time).getTime() + row.duration_minutes * MIN);
      const pinned = new Date(end.getTime() + 6 * 3600_000).toISOString();
      const put = await api.put(`/api/admin/competitions/${comp.id}`, {
        headers: H(csrf), data: { late_entry_enabled: false, late_entry_deadline_at: pinned, expectedUpdatedAt: row.updated_at },
      });
      expect(put.ok(), `edit: ${await put.text()}`).toBeTruthy();

      const events = await (await api.get(`/api/admin/competitions/${comp.id}/events`)).json();
      const list = events.events || events;
      const created = list.find(e => e.event_type === "created");
      expect(created, "the create event exists").toBeTruthy();
      const cd = typeof created.details === "string" ? JSON.parse(created.details) : created.details;
      expect(cd.late_entry_enabled, "create records the toggle").toBe(true);
      expect("late_entry_deadline_at" in cd, "and the deadline").toBeTruthy();

      const edited = list.find(e => e.event_type === "edited");
      expect(edited, "the edit event exists").toBeTruthy();
      const ed = typeof edited.details === "string" ? JSON.parse(edited.details) : edited.details;
      const changes = ed.changes || ed;
      expect(changes.late_entry_enabled, "the toggle change is recorded in both directions")
        .toEqual({ from: true, to: false });
      // The STORED value, never the resolved instant: History records what the
      // admin chose, and a resolved timestamp would read as a pin they never made.
      expect(changes.late_entry_deadline_at.from, "from null").toBeNull();
      expect(new Date(changes.late_entry_deadline_at.to).getTime()).toBe(new Date(pinned).getTime());
    } finally { await api.dispose(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v8.12.7 — closing late entries right after End Now
// ═══════════════════════════════════════════════════════════════════════════
//
// The late-entry deadline used to be judged against the event's SCHEDULED end.
// End Now stores `Math.ceil(elapsed / 60_000)` minutes, so for up to a minute
// after an organiser pressed it the scheduled end still lay AHEAD — and the one
// remedy the platform names for "stop taking late entries" (pin the deadline to
// now) was refused as "before the event ends" for an event that had just ended.
// It is judged against the EFFECTIVE end the save leaves now: `ended_at` while the
// event stays ended, and the new scheduled end when the same save revives it.
//
// Every arm asserts the precondition that makes it discriminate. The End Now arms
// check that the stored scheduled end is still in the FUTURE (once that lapses the
// old rule and the new one agree, and the arm would pass on either build). The
// LEGACY arms plant `ended_at` hours before a schedule still running, so they
// discriminate with no clock race at all.
test.describe("v8.12.7 — closing late entries right after End Now", () => {
  const DAY = 24 * 60 * MIN;
  const schedEndMs = row => new Date(row.start_time).getTime() + row.duration_minutes * MIN;
  const wireRow = async (api, id) => (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === id);
  const putComp = (api, csrf, id, data) => api.put(`/api/admin/competitions/${id}`, { headers: H(csrf), data });
  const memberRows = (compId, userId) =>
    rawGet("SELECT COUNT(*) AS n FROM competition_users WHERE competition_id=? AND user_id=?", [compId, userId]).n;

  /** A LIVE booth that started 61 s ago, closed with a REAL End Now. */
  async function endNowBooth(api, csrf) {
    const { comp, taskIds } = await liveBooth(api, csrf, {
      create: { start_time: new Date(Date.now() - 61_000).toISOString(), duration_minutes: 600 },
    });
    const en = await api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf) });
    expect(en.ok(), `end-now: ${await en.text()}`).toBeTruthy();
    const row = rawGetComp(comp.id);
    expect(row.ended_at, "End Now stamped ended_at").toBeTruthy();
    expect(row.ended_manually, "and recorded a MANUAL end").toBe(1);
    expect(new Date(row.ended_at).getTime(),
      "PRECONDITION: ceil rounding left the stored scheduled end AFTER the moment the event ended")
      .toBeLessThan(schedEndMs(row));
    return { comp, taskIds, row };
  }

  /**
   * The legacy v8.0.0 auto-ended shape: `ended_at` stamped, `ended_manually=0`,
   * and a schedule still running for hours. The end is a past instant with a
   * NON-ZERO seconds field, so its floor-minute is strictly earlier than it and the
   * refusal copy can be checked to the second. Anybody to be enrolled is enrolled
   * while LIVE: an assign into this shape takes the legacy REVIVE path, not the
   * late-entry one.
   */
  async function legacyEndedBooth(api, csrf, { tasks = 1, participant = null } = {}) {
    const { comp, taskIds } = await liveBooth(api, csrf, { tasks, duration: 600 });
    if (participant) await enrol(api, csrf, comp.id, participant.id);
    const endedAt = new Date(Math.floor((Date.now() - 2 * MIN) / MIN) * MIN + 37_123);
    rawUpdateComp(comp.id, "ended_at=?, ended_manually=0", [endedAt.toISOString()]);
    await outliveCompCache();
    const row = rawGetComp(comp.id);
    expect(schedEndMs(row) - Date.now(), "PRECONDITION: the schedule still runs for hours").toBeGreaterThan(60 * MIN);
    expect((await wireRow(api, comp.id)).status, "PRECONDITION: and yet the event reads ended").toBe("ended");
    return { comp, taskIds, row, endedAt };
  }

  test("pinning the deadline to NOW straight after End Now is ACCEPTED, and closes every door", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp } = await endNowBooth(api, csrf);

      // CONTROLS FIRST: the automatic window is open, so both doors admit somebody.
      // Without these, "the assign is refused afterwards" is equally satisfied by
      // an event that was never taking late entries.
      const early = await makeParticipant(api, csrf, uniq());
      const ctrl = await api.post("/api/admin/competitions/assign", {
        headers: H(csrf), data: { userIds: [early.id], competitionIds: [comp.id] },
      });
      expect(ctrl.status(), `CONTROL assign: ${await ctrl.text()}`).toBe(200);
      expect((await ctrl.json()).assigned, "CONTROL: the window admits a late entrant before the pin").toBe(1);
      const reveal = await (await api.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json();
      expect(reveal.token, "the join token is revealed").toBeTruthy();
      expect((await api.get(`/api/competitions/self-enroll/${reveal.token}`)).status(),
        "CONTROL: the join link resolves inside the window").toBe(200);

      const row = rawGetComp(comp.id);
      const deadline = new Date();
      expect(deadline.getTime(), "PRECONDITION: the scheduled end is still ahead — the window the old rule refused in")
        .toBeLessThan(schedEndMs(row) - 2000);
      expect(deadline.getTime(), "and the deadline is after the moment the event ended")
        .toBeGreaterThan(new Date(row.ended_at).getTime());

      const dry = await putComp(api, csrf, comp.id, {
        late_entry_deadline_at: deadline.toISOString(), validate_only: true, expectedUpdatedAt: row.updated_at,
      });
      expect(dry.status(), `dry run: ${await dry.text()}`).toBe(200);
      expect((await dry.json()).validated, "the pre-flight answers the same way").toBe(true);
      expect(rawGetComp(comp.id).late_entry_deadline_at, "a dry run stores nothing").toBeNull();

      const put = await putComp(api, csrf, comp.id, {
        late_entry_deadline_at: deadline.toISOString(), expectedUpdatedAt: row.updated_at,
      });
      expect(put.status(), `pin to now: ${await put.text()}`).toBe(200);
      const after = rawGetComp(comp.id);
      expect(new Date(after.late_entry_deadline_at).getTime(), "the pin is stored").toBe(deadline.getTime());
      expect(after.ended_at, "the event is NOT revived").toBe(row.ended_at);
      expect(after.ended_manually, "and stays a manual end").toBe(1);
      expect(after.duration_minutes, "with its schedule untouched").toBe(row.duration_minutes);

      const wire = await wireRow(api, comp.id);
      expect(wire.late_entry_window_open, "the window is closed").toBe(false);
      expect(new Date(wire.late_entry_deadline_effective).getTime(), "at exactly the pin").toBe(deadline.getTime());

      const late = await makeParticipant(api, csrf, uniq());
      const refused = await api.post("/api/admin/competitions/assign", {
        headers: H(csrf), data: { userIds: [late.id], competitionIds: [comp.id] },
      });
      expect(refused.status(), "an assign after the pin is refused").toBe(400);
      expect((await refused.json()).error, "with the ordinary manual-end refusal").toMatch(/ended manually/);
      expect(memberRows(comp.id, late.id), "and no row is written").toBe(0);
      expect((await api.get(`/api/competitions/self-enroll/${reveal.token}`)).status(),
        "the join link is dead too").toBe(404);
    } finally { await api.dispose(); }
  });

  test("the legacy shape — ended hours before a schedule still running — closes to NOW and stops play", async () => {
    const { api, csrf } = await sa();
    try {
      const p = await makeParticipant(api, csrf, uniq());
      const { comp, taskIds, row, endedAt } = await legacyEndedBooth(api, csrf, { tasks: 2, participant: p });
      // They joined AFTER the end, which is what makes them a late entrant.
      rawSetAssignedAt(comp.id, p.id, new Date(endedAt.getTime() + 10_000).toISOString());

      const c = await participantCtx(p.email, comp.id);
      try {
        const st = await (await c.api.get("/api/status")).json();
        expect(st.late_entry.is_late_entrant, "PRECONDITION: a late entrant").toBeTruthy();
        expect(st.late_entry.window_open, "PRECONDITION: inside the automatic window").toBeTruthy();
        expect((await (await submit(c.api, c.csrf, taskIds[0])).json()).correct,
          "CONTROL: they can play before the pin").toBeTruthy();

        const put = await putComp(api, csrf, comp.id, {
          late_entry_deadline_at: new Date().toISOString(), expectedUpdatedAt: row.updated_at,
        });
        expect(put.status(), `pin to now: ${await put.text()}`).toBe(200);
        const after = rawGetComp(comp.id);
        expect(after.ended_at, "the event is NOT revived").toBe(row.ended_at);
        expect(after.duration_minutes, "and its schedule is untouched").toBe(row.duration_minutes);

        const sub = await submit(c.api, c.csrf, taskIds[1]);
        expect(sub.status(), "the closed window stops play").toBe(403);
      } finally { await c.api.dispose(); }
    } finally { await api.dispose(); }
  });

  test("a deadline AT the end, or at the minute the end fell in, is refused in words that name the moment", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, row, endedAt } = await legacyEndedBooth(api, csrf);
      const floorMinute = new Date(Math.floor(endedAt.getTime() / MIN) * MIN);
      expect(floorMinute.getTime(), "PRECONDITION: the floor-minute is strictly before the end")
        .toBeLessThan(endedAt.getTime());

      // The floor-minute is what the form sends when the organiser types the
      // minute the event ended in — the case the new copy exists to explain.
      for (const [label, when] of [["equal to the end", endedAt], ["the minute the end fell in", floorMinute]]) {
        const r = await putComp(api, csrf, comp.id, {
          late_entry_deadline_at: when.toISOString(), expectedUpdatedAt: row.updated_at,
        });
        expect(r.status(), `${label}: ${await r.text()}`).toBe(400);
        const body = await r.json();
        expect(body.code, label).toBe("late_entry_deadline_invalid");
        expect(body.error, `${label}: names the moment it ended`).toMatch(/ended at .* UTC/);
        expect(body.error, `${label}: to the second`).toContain(":37 UTC");
        expect(body.error, `${label}: and the remedy`).toMatch(/choose the next minute/);
        expect(body.error, `${label}: never "leave it on automatic" — that does not close anything`)
          .not.toMatch(/automatic/i);
        expect(rawGetComp(comp.id).late_entry_deadline_at, `${label}: nothing is stored`).toBeNull();
      }

      // CONTROL: the next minute — the remedy the refusal names — is accepted.
      const next = new Date(floorMinute.getTime() + MIN);
      const ok = await putComp(api, csrf, comp.id, {
        late_entry_deadline_at: next.toISOString(), expectedUpdatedAt: row.updated_at,
      });
      expect(ok.status(), `the next minute: ${await ok.text()}`).toBe(200);
      expect(new Date(rawGetComp(comp.id).late_entry_deadline_at).getTime()).toBe(next.getTime());
    } finally { await api.dispose(); }
  });

  test("a save that REVIVES the event judges the deadline against the NEW end", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, row } = await endNowBooth(api, csrf);
      const newDur = row.duration_minutes + 60;
      const newEndMs = new Date(row.start_time).getTime() + newDur * MIN;
      expect(newEndMs, "PRECONDITION: the extension puts the scheduled end ahead, so this save revives")
        .toBeGreaterThan(Date.now() + 30 * MIN);

      // THE M2 WITNESS. It also passes on the pre-v8.12.7 build; what it catches is
      // a build that judges every save against `ended_at`, which would accept a
      // window that is over before the revived event even ends.
      const bad = await putComp(api, csrf, comp.id, {
        duration_minutes: newDur, late_entry_deadline_at: new Date(Date.now() + 5000).toISOString(),
        expectedUpdatedAt: row.updated_at,
      });
      expect(bad.status(), `a deadline inside the revived event: ${await bad.text()}`).toBe(400);
      expect((await bad.json()).code).toBe("late_entry_deadline_invalid");
      const still = rawGetComp(comp.id);
      expect(still.ended_at, "refused, so still ended").toBe(row.ended_at);
      expect(still.duration_minutes, "and not extended").toBe(row.duration_minutes);

      const pin = new Date(newEndMs + 60 * MIN);
      const good = await putComp(api, csrf, comp.id, {
        duration_minutes: newDur, late_entry_deadline_at: pin.toISOString(), expectedUpdatedAt: row.updated_at,
      });
      expect(good.status(), `a deadline after the new end: ${await good.text()}`).toBe(200);
      const after = rawGetComp(comp.id);
      expect(after.ended_at, "the extend revived the event").toBeNull();
      expect(new Date(after.late_entry_deadline_at).getTime(), "with the pin stored").toBe(pin.getTime());
      expect((await wireRow(api, comp.id)).status, "and it is live again").toBe("live");
    } finally { await api.dispose(); }
  });

  test("an ECHO of the stored pin is not re-judged against the end End Now moved — a real change still is", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp } = await liveBooth(api, csrf);
      const r0 = rawGetComp(comp.id);
      const pin = new Date(schedEndMs(r0) + 29 * DAY + 23 * 60 * MIN).toISOString();
      const pinPut = await putComp(api, csrf, comp.id, { late_entry_deadline_at: pin, expectedUpdatedAt: r0.updated_at });
      expect(pinPut.status(), `PRECONDITION: inside the 30-day cap while live: ${await pinPut.text()}`).toBe(200);

      const en = await api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf) });
      expect(en.ok(), `end-now: ${await en.text()}`).toBeTruthy();
      const r1 = rawGetComp(comp.id);
      expect(r1.ended_at, "End Now stamped ended_at").toBeTruthy();
      const storedPin = r1.late_entry_deadline_at;
      expect(new Date(storedPin).getTime() - new Date(r1.ended_at).getTime(),
        "PRECONDITION: judged against the end End Now left, the stored pin breaks the 30-day cap")
        .toBeGreaterThan(30 * DAY);

      const echo = await putComp(api, csrf, comp.id, {
        late_entry_deadline_at: storedPin, attempt_cap: 3, expectedUpdatedAt: r1.updated_at,
      });
      expect(echo.status(), `an unrelated save echoing the pin: ${await echo.text()}`).toBe(200);
      const r2 = rawGetComp(comp.id);
      expect(r2.late_entry_deadline_at, "the column is byte-identical").toBe(storedPin);
      expect(r2.attempt_cap, "and the unrelated field saved").toBe(3);

      const events = await (await api.get(`/api/admin/competitions/${comp.id}/events`)).json();
      const capEdit = (events.events || events).map(e => ({
        ...e, d: typeof e.details === "string" ? JSON.parse(e.details) : e.details,
      })).find(e => e.event_type === "edited" && (e.d.changes || e.d).attempt_cap);
      expect(capEdit, "the edit is audited").toBeTruthy();
      expect("late_entry_deadline_at" in (capEdit.d.changes || capEdit.d),
        "and an echo is not recorded as a deadline change").toBe(false);

      // CONTROL: one second is a real change, and the cap still applies to it.
      const moved = await putComp(api, csrf, comp.id, {
        late_entry_deadline_at: new Date(new Date(storedPin).getTime() + 1000).toISOString(),
        expectedUpdatedAt: r2.updated_at,
      });
      expect(moved.status(), `a real change: ${await moved.text()}`).toBe(400);
      expect((await moved.json()).code).toBe("late_entry_deadline_invalid");
      expect(rawGetComp(comp.id).late_entry_deadline_at, "and nothing is stored").toBe(storedPin);
    } finally { await api.dispose(); }
  });

  test("an echo on a save that MOVES the schedule is still judged", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, row } = await endNowBooth(api, csrf);
      const pinPut = await putComp(api, csrf, comp.id, {
        late_entry_deadline_at: new Date().toISOString(), expectedUpdatedAt: row.updated_at,
      });
      expect(pinPut.status(), `pin to now: ${await pinPut.text()}`).toBe(200);
      const r1 = rawGetComp(comp.id);
      const newDur = r1.duration_minutes + 60;
      expect(new Date(r1.start_time).getTime() + newDur * MIN,
        "PRECONDITION: the extension would revive the event").toBeGreaterThan(Date.now() + 30 * MIN);

      // Echoing the pin while extending would leave a revived event whose late
      // window closed before it even ends — a window that can never open.
      const r = await putComp(api, csrf, comp.id, {
        duration_minutes: newDur, late_entry_deadline_at: r1.late_entry_deadline_at, expectedUpdatedAt: r1.updated_at,
      });
      expect(r.status(), `extend while echoing the pin: ${await r.text()}`).toBe(400);
      expect((await r.json()).code).toBe("late_entry_deadline_invalid");
      const r2 = rawGetComp(comp.id);
      expect(r2.ended_at, "refused, so still ended").toBe(r1.ended_at);
      expect(r2.duration_minutes, "and not extended").toBe(r1.duration_minutes);
    } finally { await api.dispose(); }
  });

  // A RE-TICK IS NO ECHO. An echo of the stored pin skips the 30-day cap only on a
  // save that neither moves the schedule nor switches late entries back on; a
  // re-tick is judged in full, against the cap and the end. A first draft skipped
  // the whole validator for an echo, so this two-save sequence — what the edit
  // form does when an organiser switches late entries off, extends the event, and
  // later switches them back on (a hidden deadline block sends nothing, and the
  // re-ticked one sends the stored pin) — stored a pin four hours BEFORE the end:
  // a window that can never open, with nothing refusing it. This test holds the
  // after-the-end refusal for a re-tick (the cap's arm sits with the stored-pin
  // locks).
  test("a re-tick sending a pin the end has since moved past is refused (a re-tick is no echo)", async () => {
    const { api, csrf } = await sa();
    try {
      /** An UPCOMING booth, 2 h long, its deadline pinned 1 h after its end. */
      const pinnedBooth = async () => {
        const start = new Date(Math.floor(Date.now() / MIN) * MIN + 60 * MIN);
        const r = await api.post("/api/admin/competitions", {
          headers: H(csrf),
          data: {
            name: `LE ${uniq()}`, event_kind: "booth", start_time: start.toISOString(), duration_minutes: 120,
            late_entry_deadline_at: new Date(start.getTime() + 180 * MIN).toISOString(), self_enroll_enabled: true,
          },
        });
        expect(r.ok(), `create: ${await r.text()}`).toBeTruthy();
        const comp = (await r.json()).competition;
        expect(comp.status, "PRECONDITION: the fixture is upcoming").toBe("upcoming");
        const row = rawGetComp(comp.id);
        expect(row.late_entry_deadline_at, "PRECONDITION: the deadline is pinned").toBeTruthy();
        expect(row.late_entry_enabled, "PRECONDITION: and late entries are on").toBe(1);
        return { comp, row };
      };
      /** Save 1: late entries OFF and the end moved by `addMinutes`, no deadline sent. */
      const untickAndExtend = async (comp, row, addMinutes) => {
        const r = await putComp(api, csrf, comp.id, {
          late_entry_enabled: false, duration_minutes: row.duration_minutes + addMinutes, expectedUpdatedAt: row.updated_at,
        });
        expect(r.status(), `save 1 (untick + extend): ${await r.text()}`).toBe(200);
        const after = rawGetComp(comp.id);
        expect(after.late_entry_enabled, "PRECONDITION: save 1 switched late entries off").toBe(0);
        expect(after.late_entry_deadline_at, "PRECONDITION: and left the pin where it was").toBe(row.late_entry_deadline_at);
        return after;
      };
      /** Save 2: re-tick, echoing the stored pin and changing nothing else. */
      const retick = (comp, row, extra = {}) => putComp(api, csrf, comp.id, {
        late_entry_enabled: true, late_entry_deadline_at: row.late_entry_deadline_at, expectedUpdatedAt: row.updated_at, ...extra,
      });

      const { comp, row } = await pinnedBooth();
      const r1 = await untickAndExtend(comp, row, 300);
      expect(schedEndMs(r1) - new Date(r1.late_entry_deadline_at).getTime(),
        "PRECONDITION: the end now lies four hours AFTER the stored pin").toBe(4 * 60 * MIN);

      const dry = await retick(comp, r1, { validate_only: true });
      expect(dry.status(), `the dry run meets the refusal: ${await dry.text()}`).toBe(400);
      const bad = await retick(comp, r1);
      expect(bad.status(), `save 2 (re-tick, echoing the pin): ${await bad.text()}`).toBe(400);
      const body = await bad.json();
      expect(body.code).toBe("late_entry_deadline_invalid");
      expect(body.error, "it says the deadline must be after the end").toMatch(/must be after the event ends/);
      const r2 = rawGetComp(comp.id);
      expect(r2.late_entry_enabled, "nothing is stored: late entries stay off").toBe(0);
      expect(r2.late_entry_deadline_at, "and the pin is untouched").toBe(r1.late_entry_deadline_at);
      expect(r2.updated_at, "and the row was not written at all").toBe(r1.updated_at);

      // CONTROL, the SAME two saves where the move leaves the pin AFTER the end:
      // the echo is accepted — so the refusal above is about where the pin lies,
      // not about re-ticking or echoing.
      const c = await pinnedBooth();
      const c1 = await untickAndExtend(c.comp, c.row, 30);
      expect(new Date(c1.late_entry_deadline_at).getTime(), "PRECONDITION: the pin is still after the end")
        .toBeGreaterThan(schedEndMs(c1));
      const ok = await retick(c.comp, c1);
      expect(ok.status(), `CONTROL save 2: ${await ok.text()}`).toBe(200);
      const c2 = rawGetComp(c.comp.id);
      expect(c2.late_entry_enabled, "CONTROL: late entries are back on").toBe(1);
      expect(c2.late_entry_deadline_at, "CONTROL: with the pin byte-identical").toBe(c1.late_entry_deadline_at);
    } finally { await api.dispose(); }
  });

  test("a pin moved BEHIND a late entrant's answer does not hand them a zero solve time", async () => {
    const { api, csrf } = await sa();
    try {
      const { comp, taskIds } = await liveBooth(api, csrf, { tasks: 2 });
      const effEnd = await expireEvent(comp.id, { agoMinutes: 30 });
      // Enrolled INSIDE the window, so both are late entrants.
      const A = await makeParticipant(api, csrf, uniq());
      const B = await makeParticipant(api, csrf, uniq());
      await enrol(api, csrf, comp.id, A.id);
      await enrol(api, csrf, comp.id, B.id);

      const a = await participantCtx(A.email, comp.id);
      try {
        expect((await (await submit(a.api, a.csrf, taskIds[0])).json()).correct,
          "A solves ONE of the two, so stays unfinished").toBeTruthy();
      } finally { await a.api.dispose(); }
      const loginA = new Date(rawGet(
        "SELECT login_time FROM competition_users WHERE competition_id=? AND user_id=?", [comp.id, A.id]).login_time).getTime();
      const lastCorrectA = new Date(rawGet(
        "SELECT MAX(submitted_at) AS t FROM submissions WHERE competition_id=? AND user_id=? AND is_correct=1",
        [comp.id, A.id]).t).getTime();
      expect(lastCorrectA, "PRECONDITION: A's answer landed after A's clock started").toBeGreaterThan(loginA);

      // The pin moves BEHIND A's answer — and behind A's own start — while staying
      // after the end, so it is a deadline the platform accepts.
      const pin = new Date(loginA - 5000);
      expect(pin.getTime(), "PRECONDITION: the pin is still after the end").toBeGreaterThan(effEnd.getTime());
      // B started before the pin and has no answer at all: the control row.
      const loginB = new Date(pin.getTime() - 60_000);
      rawBackdate("competition_users", "login_time", comp.id, B.id, loginB.toISOString());

      const r0 = rawGetComp(comp.id);
      const put = await putComp(api, csrf, comp.id, {
        late_entry_deadline_at: pin.toISOString(), expectedUpdatedAt: r0.updated_at,
      });
      expect(put.status(), `pin behind A's answer: ${await put.text()}`).toBe(200);

      const board = await (await api.get(`/api/admin/leaderboard?competitionId=${comp.id}`)).json();
      const rowA = board.find(u => u.nickname === A.nickname);
      const rowB = board.find(u => u.nickname === B.nickname);
      expect(rowA && rowB, "PRECONDITION: both are on the admin board").toBeTruthy();
      expect(rowA.isLateEntrant && rowB.isLateEntrant, "PRECONDITION: both are late entrants").toBeTruthy();
      expect(rowA.allSolved, "PRECONDITION: A is unfinished").toBeFalsy();
      // Without the floor A's reference end is the pin, BEFORE A's own start: the
      // v7.21.3 clamp turns that into zero, the best value on the tie-break.
      expect(rowA.solveTimeMs, "A is measured to their last correct answer, not clamped to zero")
        .toBe(lastCorrectA - loginA);
      expect(rowB.solveTimeMs, "CONTROL: B, with no answer after the pin, still ends at the pin")
        .toBe(pin.getTime() - loginB.getTime());
    } finally { await api.dispose(); }
  });
});
