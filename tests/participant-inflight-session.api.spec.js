// @ts-check
//
// A FILE ANSWER IN FLIGHT WHEN ITS SESSION ENDS IS NOT GRADED.
//
// The submit's guards run when the request HEADERS arrive; multer then reads the
// body and the handler awaits the file read before it writes. A password reset, a
// sign-in elsewhere or a logout during that window tombstones the session and
// leaves the ACCOUNT qualifying, so the account re-check at commit
// (`participantAuthzDenied`) cannot see it, and the impersonating-admin re-check
// (`impersonatingHandDenied`) is asked only under impersonation. MEASURED before
// `participantSessionDenied` existed: each of the three answered 200 and scored
// 50 points for a session the platform had ended.
//
// Every arm parks the answer in its read window (`submit-read-delay`), acts
// there, and asserts the WHOLE refusal, that nothing was written, and what the
// session can still do afterwards. The CONTROL makes each zero mean something.
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, PARTICIPANT_PASS } = require("./helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const { signIn, seat } = require("./admin-inflight-helpers");
const {
  SESSION_ENDED, dbGet, dbExec, tombstoned, endedWindows, ownSession, enter, fileSubmit, parkedSubmit, wrote,
  settledChallengeEvents, sessionCookiesIn, cookieExpiryMs, sessionStatus,
} = require("./participant-inflight-fixture");

const ENDED_BODY = { error: SESSION_ENDED, code: "session_ended" };

test.describe("a session that ends while its file answer is in flight", () => {
  let sa, saCsrf, compId, taskId;
  test.beforeAll(async () => {
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    compId = (await makeCompetition(sa, saCsrf, "pis")).id;
    // A FILE answer: `submit-read-delay` parks inside the file branch only.
    taskId = (await makeTask(sa, saCsrf, "pisf", { answer_type: "file", correct_answer: "win" })).id;
    await assignTask(sa, saCsrf, taskId, [compId]);
    // A bystander who never answers, so a correct submission can never be the
    // one that finishes the event (fixture checklist item 1).
    const by = await makeParticipant(sa, saCsrf, "pisby");
    await enrol(sa, saCsrf, compId, [by.id]);
  });
  test.afterAll(async () => { await sa?.dispose(); });

  async function own(label) { const v = await ownSession(sa, saCsrf, label, compId); await enter(v, compId); return v; }
  const parked = (v, act) => parkedSubmit(sa, saCsrf, v, taskId, act);
  async function expectNothingStored(v, what) {
    const w = wrote(v.p.id, taskId);
    expect(w.c, `${what}: no submission row`).toBe(0);
    expect(w.pts, `${what}: no score`).toBe(0);
    expect(await settledChallengeEvents(sa, v.p.id, taskId), `${what}: no challenge event`).toBe(0);
  }

  test("CONTROL: an untouched session's parked file answer is graded, and its response re-stamps the SAME session's cookie", async () => {
    const v = await own("pisk");
    try {
      const before = (await v.api.storageState()).cookies.find(c => c.name === "connect.sid");
      const r = await parked(v, null);
      expect(r.status, r.text).toBe(200);
      expect(r.json.correct, "the answer was graded").toBe(true);
      expect(r.json.pointsDelta).toBeGreaterThan(0);
      expect(wrote(v.p.id, taskId).c).toBe(1);
      await expect.poll(() => settledChallengeEvents(sa, v.p.id, taskId), { message: "the solve's challenge event lands", timeout: 5000 }).toBeGreaterThan(0);
      // The positive half of the revoked-cookie filter, on the same route: a
      // LIVE session's late response still carries its sliding cookie, for the
      // same id, with a later expiry — or browser cookies would expire however
      // active the participant was.
      const sent = sessionCookiesIn(r.r, v.sid);
      expect(sent.length, "the live session's Set-Cookie was sent").toBe(1);
      expect(cookieExpiryMs(sent[0]), "with an expiry no earlier than the one it replaces").toBeGreaterThanOrEqual(Math.floor(before.expires) * 1000);
    } finally { await v.api.dispose(); }
  });



  test("a sign-in ELSEWHERE mid-upload: refused, nothing stored, and the next poll names the other login", async () => {
    const v = await own("pise");
    try {
      const r = await parked(v, async () => { const o = await signIn(v.p.email, PARTICIPANT_PASS); await o.api.dispose(); });
      expect(tombstoned(v.sid), "PRECONDITION: the other login tombstoned this session").toBe(true);
      expect(r.status, r.text).toBe(401);
      expect(r.json).toEqual(ENDED_BODY);
      // The negative half of the revoked-cookie filter (the CONTROL above is the
      // positive): this request slid its session when it arrived, so its late
      // response would re-stamp the revoked id's cookie over the browser's new
      // one; `_dropRevokedSessionCookie` withholds exactly that header.
      expect(sessionCookiesIn(r.r, v.sid), "no Set-Cookie re-stamps the revoked session").toEqual([]);
      await expectNothingStored(v, "signed in elsewhere");
      const st = await sessionStatus(v.api);
      expect(st.active).toBe(false);
      expect(st.reason).toBe("kicked");
      expect(st.kicked_by && st.kicked_by.email, "the other login, named").toBe(v.p.email);
      expect(st.kicked_by.builtin, "a user account, not the built-in superadmin (whose popup remedy is a restart)").toBe(false);
    } finally { await v.api.dispose(); }
  });

  test("a LOGOUT from the same session mid-upload: refused, nothing stored", async () => {
    const v = await own("pisl");
    try {
      const r = await parked(v, async () => {
        const lo = await v.api.post("/api/logout", { headers: H(v.csrf) });
        expect(lo.ok(), `logout: ${await lo.text()}`).toBeTruthy();
      });
      expect(r.status, r.text).toBe(401);
      expect(r.json).toEqual(ENDED_BODY);
      expect(tombstoned(v.sid), "PRECONDITION: the logout tombstoned this session").toBe(true);
      expect(sessionCookiesIn(r.r, v.sid), "no Set-Cookie re-stamps the signed-out session").toEqual([]);
      await expectNothingStored(v, "logged out");
    } finally { await v.api.dispose(); }
  });



  test("an unreadable tombstone table at commit REFUSES (fail closed), and the session survives it", async () => {
    const v = await own("pisx");
    let renamed = false;
    try {
      const r = await parked(v, async () => { dbExec("ALTER TABLE revoked_sessions RENAME TO revoked_sessions_pisx"); renamed = true; });
      expect(tombstoned.bind(null, v.sid), "PRECONDITION: the table is unreadable").toThrow();
      dbExec("ALTER TABLE revoked_sessions_pisx RENAME TO revoked_sessions"); renamed = false;
      expect(r.status, r.text).toBe(401);
      expect(r.json).toEqual(ENDED_BODY);
      await expectNothingStored(v, "unreadable tombstones");
      // Only the COMMIT fails closed. The cookie filter stayed fail-open — the
      // live session's sliding cookie still went out with the refusal, or an
      // active browser's cookie would expire on a DB hiccup — and the session
      // was not revoked, so it is still signed in.
      expect(sessionCookiesIn(r.r, v.sid).length, "the live session's cookie was still re-stamped").toBe(1);
      expect(tombstoned(v.sid), "nothing tombstoned this session").toBe(false);
      expect((await v.api.get("/api/me")).status()).toBe(200);
    } finally {
      if (renamed) dbExec("ALTER TABLE revoked_sessions_pisx RENAME TO revoked_sessions");
      await v.api.dispose();
    }
  });

  test("…and the same unreadable table refuses an IMPERSONATED answer at commit (the hand's tombstone arm fails closed too)", async () => {
    const v = await seat(sa, saCsrf, "pisxi", "superadmin", compId);
    await enter(v, compId);
    let renamed = false;
    try {
      const r = await parked(v, async () => { dbExec("ALTER TABLE revoked_sessions RENAME TO revoked_sessions_pisxi"); renamed = true; });
      dbExec("ALTER TABLE revoked_sessions_pisxi RENAME TO revoked_sessions"); renamed = false;
      expect(r.status, r.text).toBe(403);
      expect(r.json).toEqual({ error: "impersonation_ended", reason: "session_ended", code: "admin_session_ended" });
      await expectNothingStored(v, "unreadable tombstones, impersonated");
    } finally {
      if (renamed) dbExec("ALTER TABLE revoked_sessions_pisxi RENAME TO revoked_sessions");
      await v.api.dispose();
    }
  });

  // ── under impersonation: the seat stops qualifying mid-upload ─────────────

  async function impersonating(label) {
    const v = await seat(sa, saCsrf, label, "superadmin", compId);
    await enter(v, compId);
    return v;
  }

  test("under impersonation, the TARGET blocked mid-upload gets requireParticipant's own forced exit, closed once", async () => {
    const v = await impersonating("pisi");
    try {
      const r = await parked(v, async () => {
        const b = await sa.post(`/api/admin/participants/${v.p.id}/block`, { headers: H(saCsrf) });
        expect(b.ok(), `block: ${await b.text()}`).toBeTruthy();
        expect((await b.json()).blocked, "the block TOOK (the route is a toggle)").toBe(1);
        expect(tombstoned(v.sid), "PRECONDITION: blocking the target does not end the admin's session").toBe(false);
      });
      expect(r.status, r.text).toBe(403);
      expect(r.json, "the forced-exit shape the client turns into a toast and a reload").toEqual({ error: "impersonation_ended", reason: "target_inactive" });
      await expectNothingStored(v, "target blocked");
      expect(endedWindows(v.p.id), "the window was closed by the refusal itself, once").toEqual(["target_inactive"]);
      const am = await v.api.get("/api/admin/me");
      expect(am.status(), "the acting admin is restored").toBe(200);
      const me = await (await v.api.get("/api/me")).json();
      expect(me.impersonation && me.impersonation.active, "and no longer impersonating").toBeFalsy();
      expect(endedWindows(v.p.id), "no request after it closes the window again").toEqual(["target_inactive"]);
    } finally { await v.api.dispose(); }
  });

  test("CONTROL: under impersonation, a target REMOVED from the event mid-upload is refused with the membership sentence, still impersonating", async () => {
    const v = await impersonating("pisu");
    try {
      const r = await parked(v, async () => {
        const d = await sa.delete(`/api/admin/competitions/${compId}/users/${v.p.id}`, { headers: H(saCsrf) });
        expect(d.ok(), `remove: ${await d.text()}`).toBeTruthy();
      });
      expect(r.status, r.text).toBe(403);
      expect(r.json).toEqual({ error: "You are not assigned to this event" });
      await expectNothingStored(v, "target removed");
      expect(endedWindows(v.p.id), "nothing ended").toEqual([]);
      const me = await (await v.api.get("/api/me")).json();
      expect(me.impersonation && me.impersonation.active, "still looking through the seat").toBe(true);
    } finally { await v.api.dispose(); }
  });
});
