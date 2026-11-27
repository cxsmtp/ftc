// @ts-check
/**
 * v7.21.13 — the three surfaces that answer "which competitions may this
 * participant see, and what is each one's status" must agree.
 *
 * POST /api/login, GET /api/me and GET /api/my-competitions each built that
 * list by hand. They agreed on the SELECT and diverged on what came after:
 * /api/me and /api/my-competitions batch-load every competition's timeslots in
 * one query and pass them to competitionStatus / competitionEffectiveEnd
 * (v6.9.17), while the login copy called both with no slots — so each call
 * re-issued getCompetitionTimeslots, 2N indexed SELECTs per sign-in, on the one
 * path a whole cohort hits inside a minute.
 *
 * They are one shared builder now (listParticipantCompetitions). This file
 * asserts the thing a source scanner cannot — that the three surfaces genuinely
 * report the same status and the same effective end for the same participant,
 * and that the extraction did not quietly reshape any of the three payloads.
 *
 * WHAT IT CANNOT SEE, stated plainly: the N+1 itself. competitionStatus(c) with
 * no slots FETCHES them itself, so dropping the batched argument gives byte-
 * identical answers and differs only in query count — measured here by
 * mutation, and it passes. Nothing observable over HTTP distinguishes the two.
 * The batching is therefore pinned by the source lock in functional-core
 * ("v7.21.13: the deduped helpers are not re-invented"), which requires the
 * shared builder to both issue the single IN (…) query AND pass its result to
 * competitionStatus. Two locks, two halves; neither is sufficient alone.
 *
 * THE FIXTURE MUST BE MULTI-SESSION. A single-slot competition has no
 * competition_timeslots rows at all, so status and effective_end come out
 * identical whether the slots were batched, fetched per-competition, or never
 * fetched — the assertion would hold for every possible implementation, which
 * is the definition of a vacuous test. Sessions are the only input that makes
 * the batched-slots argument observable from outside.
 */
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, PARTICIPANT_PASS, codeLogin } = require("./helpers");

const h = csrf => ({ "x-csrf-token": csrf, "content-type": "application/json" });

test.describe("v7.21.13 — login / me / my-competitions report one competition list", () => {
  test("the three surfaces agree on status and effective_end for a multi-session competition", async () => {
    const stamp = Date.now();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");

    // Own the fixture end to end: a competition created here, and a participant
    // registered here. Nothing shared — an earlier file on this worker can have
    // staff-tagged or blocked a seeded participant, and assign() silently skips
    // such users, which would leave no competition_users row and quietly make
    // every assertion below vacuous.
    const mkComp = async (name, startOffsetMs, durationMin) => {
      const r = await sa.post("/api/admin/competitions", {
        headers: h(saCsrf),
        data: { name, start_time: new Date(stamp + startOffsetMs).toISOString(), duration_minutes: durationMin },
      });
      expect(r.ok(), `fixture competition ${name} created`).toBeTruthy();
      return (await r.json()).competition.id;
    };
    // Two competitions, so the list has more than one row to get wrong, and a
    // second one whose sessions sit at different offsets from the first.
    const compA = await mkComp(`Parity A ${stamp}`, 3_600_000, 180);
    const compB = await mkComp(`Parity B ${stamp}`, 7_200_000, 240);

    for (const [compId, offsets] of [[compA, [3_600_000, 10_800_000]], [compB, [7_200_000, 14_400_000]]]) {
      for (const [i, off] of offsets.entries()) {
        const r = await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
          headers: h(saCsrf),
          data: { name: `Session ${i + 1}`, start_time: new Date(stamp + off).toISOString(), duration_minutes: 60 },
        });
        expect(r.ok(), "fixture session created").toBeTruthy();
      }
    }

    const email = `parity-${stamp}@company.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    const reg = await registerPost(anon, "/api/register", {
      headers: h(ac),
      data: {
        firstName: "Par", lastName: "Ity", nickname: `parity_${stamp}`, email,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "Boston", password: PARTICIPANT_PASS,
      },
    });
    expect(reg.status(), "fixture participant registered").toBe(200);
    await anon.dispose();

    const u = (await (await sa.get("/api/admin/participants?limit=5000")).json())
      .participants.find(p => p.email === email);
    expect(u, "fixture participant is listed").toBeTruthy();
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": saCsrf } });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": saCsrf } });
    const asg = await sa.post("/api/admin/competitions/assign", {
      headers: h(saCsrf), data: { userIds: [u.id], competitionIds: [compA, compB] },
    });
    expect(asg.status(), "fixture assign succeeded").toBe(200);
    expect((await asg.json()).assigned, "the participant must actually be ENROLLED").toBeGreaterThan(0);
    await sa.dispose();

    // ── The three surfaces ────────────────────────────────────────────────
    const { api } = await freshCtx();
    let list;
    try {
      const csrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
      const loginRes = await codeLogin(api, email, h(csrf));
      expect(loginRes.ok(), `fixture participant signed in (got ${loginRes.status()})`).toBeTruthy();
      const fromLogin = (await loginRes.json()).competitions;

      const fromMe = (await (await api.get("/api/me")).json()).competitions;
      const myCompsRes = await api.get("/api/my-competitions");
      expect(myCompsRes.ok(), "my-competitions is readable").toBeTruthy();
      const fromMyComps = await myCompsRes.json();

      // Anti-vacuity FIRST: everything below is an equality between three
      // arrays, and three empty arrays are equal. Prove the fixture reached all
      // three surfaces before comparing them.
      const pick = arr => (arr || [])
        .filter(c => c.id === compA || c.id === compB)
        .sort((x, y) => x.id.localeCompare(y.id));
      const [L, M, C] = [pick(fromLogin), pick(fromMe), pick(fromMyComps)];
      expect(L.length, "login must list both fixture competitions").toBe(2);
      expect(M.length, "/api/me must list both fixture competitions").toBe(2);
      expect(C.length, "/api/my-competitions must list both fixture competitions").toBe(2);

      const shape = c => ({
        id: c.id, name: c.name, status: c.status, effective_end: c.effective_end,
        start_time: c.start_time, duration_minutes: c.duration_minutes,
        ended_at: c.ended_at, reveal_answers_on_end: c.reveal_answers_on_end,
      });
      expect(L.map(shape), "POST /api/login and GET /api/me disagree about the participant's competitions")
        .toEqual(M.map(shape));
      expect(C.map(shape), "GET /api/my-competitions disagrees with GET /api/me")
        .toEqual(M.map(shape));

      // effective_end must be DERIVED FROM THE SESSIONS, not from the
      // competition row's own window — otherwise the equality above is
      // satisfied by three implementations that all ignore the slots.
      // Competition B is the one to test with: its row window (2 h → 6 h) and
      // its session window (2 h → 5 h) differ, where A's happen to coincide.
      const b = M.find(c => c.id === compB);
      const rowEnd = new Date(stamp + 7_200_000 + 240 * 60_000).toISOString();
      const slotEnd = new Date(stamp + 14_400_000 + 60 * 60_000).toISOString();
      expect(new Date(b.effective_end).getTime(),
        "effective_end must come from the SESSIONS (last session end), not the competition row's own duration"
      ).toBe(new Date(slotEnd).getTime());
      expect(b.effective_end).not.toBe(rowEnd);

      // Only my-competitions carries the sessions themselves. Two sessions, in
      // start order — the shared builder sorts by (competition_id, start_time)
      // while the endpoint it replaced sorted by start_time alone, so a grouping
      // slip would show up here.
      const bc = C.find(c => c.id === compB);
      expect(bc.timeslots.map(s => s.name), "my-competitions carries the sessions in start order")
        .toEqual(["Session 1", "Session 2"]);
      expect(M.find(c => c.id === compB).timeslots,
        "/api/me must NOT carry the sessions array — it never did, and widening a payload " +
        "silently is how a refactor changes a contract").toBeUndefined();

      list = M;
    } finally { await api.dispose(); }

    expect(list.every(c => c.status === "upcoming"),
      "both fixture competitions start in the future, so both read upcoming").toBe(true);
  });
});
