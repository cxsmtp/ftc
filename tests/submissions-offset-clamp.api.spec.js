// @ts-check
//
// v8.13.3 (OC-1, OC-5) — an over-range page offset is the empty past-the-end
// page, never a 500.
//
// GET /api/admin/submissions parsed `offset` with a floor and no ceiling, so
// `?offset=1e20` (parseInt reads 1) was harmless while `?offset=9300000000000000000`
// or a 401-digit string reached `LIMIT ? OFFSET ?` — and the fast path's inner
// `LIMIT offset+limit` — as a value SQLite will not bind as an integer: a generic
// 500 and an error-level stack line for an admin who typed a long number. The
// route now reads it through lib/util's clampPagingIndex (floor 0, cap 1e9), the
// one paging-index rule every list route shares. Both SQL shapes are driven: the
// branch-capped fast path (no search) and the materialised path `?q=` takes.
const { test, expect } = require("./isolated-test");
const { PARTICIPANT_PASS, apiLogin, gradingHashFor } = require("./helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.describe("v8.13.3 — submissions offset is clamped", () => {
  /** @type {any} */ let sa, saCsrf, comp, base;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    comp = await makeCompetition(sa, saCsrf, "offsetclamp");
    const task = await makeTask(sa, saCsrf, "offsetclamp");
    await assignTask(sa, saCsrf, task.id, [comp.id]);
    const p = await makeParticipant(sa, saCsrf, "offsetclamp");
    // A second enrollee who does nothing, so nothing this fixture does can end
    // the event (fixture checklist item 1).
    const idle = await makeParticipant(sa, saCsrf, "offsetidle");
    await enrol(sa, saCsrf, comp.id, [p.id, idle.id]);

    const { api, csrf } = await apiLogin(p.email, PARTICIPANT_PASS);
    try {
      const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: comp.id } });
      expect(sel.status(), await sel.text()).toBe(200);
      for (const answer of ["wrong-one", "wrong-two"]) {
        const gradingHash = await gradingHashFor(api, task.id);
        expect(gradingHash, "precondition: the challenge is open to the participant").toBeTruthy();
        const s = await api.post(`/api/tasks/${task.id}/submit`, { headers: H(csrf), data: { answer, gradingHash } });
        expect(s.status(), await s.text()).toBe(200);
        expect((await s.json()).correct).toBe(false);
      }
    } finally { await api.dispose(); }

    // The baseline every arm compares against: two rows, both reachable.
    const b = await sa.get(`/api/admin/submissions?competitionId=${comp.id}`);
    expect(b.status(), await b.text()).toBe(200);
    base = await b.json();
    expect(base.total, "precondition: the fixture wrote two submissions").toBeGreaterThanOrEqual(2);
  });

  const HUGE = ["9300000000000000000", "1e20", "9".repeat(401)];

  for (const [label, extra] of [["the fast path", ""], ["the search path", "&q=wrong"]]) {
    for (const off of HUGE) {
      test(`${label}: offset=${off.length > 24 ? `<${off.length} digits>` : off} is answered normally, not a 500`, async () => {
        const r = await sa.get(`/api/admin/submissions?competitionId=${comp.id}${extra}&offset=${off}`);
        expect(r.status(), await r.text()).toBe(200);
        const d = await r.json();
        // "1e20" parses as 1 (parseInt stops at the "e"), so it is an ordinary offset
        // of one: the SECOND row of the two-row list, not a clamp. The others exceed
        // the cap and clamp to an empty past-the-end page.
        expect(d.events).toEqual(off === "1e20" ? base.events.slice(1, 1 + d.limit) : []);
        if (off !== "1e20") expect(d.offset, "the applied offset is echoed at the cap").toBe(1_000_000_000);
        const ref = extra
          ? await (await sa.get(`/api/admin/submissions?competitionId=${comp.id}${extra}`)).json()
          : base;
        expect(d.total, "the total does not depend on the offset").toBe(ref.total);
      });
    }
  }

  test("CONTROL: an ordinary offset still pages, and a malformed one reads as 0", async () => {
    const second = await (await sa.get(`/api/admin/submissions?competitionId=${comp.id}&limit=1&offset=1`)).json();
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toEqual(base.events[1]);
    for (const bad of ["-5", "abc"]) {
      const d = await (await sa.get(`/api/admin/submissions?competitionId=${comp.id}&offset=${bad}`)).json();
      expect(d.offset, `offset=${bad} reads as 0`).toBe(0);
      expect(d.events).toEqual(base.events);
    }
  });

  test("the logs list clamps its offset by the same rule (adoption lock)", async () => {
    // Not reachable as a 500 (the logs walk never binds the offset into SQL), so
    // this pins only that the route reads it through clampPagingIndex: a huge
    // offset echoes the cap and returns no entries.
    const r = await sa.get(`/api/admin/logs?offset=${"9".repeat(40)}`);
    expect(r.status(), await r.text()).toBe(200);
    const d = await r.json();
    expect(d.entries).toEqual([]);
    expect(d.offset).toBe(1_000_000_000);
  });
});
