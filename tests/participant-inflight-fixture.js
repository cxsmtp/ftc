// @ts-check
//
// Shared fixtures for the specs that END A PARTICIPANT'S SESSION while one of
// its writes is in flight (`participant-inflight-session*.spec.js`): the file
// answer and the certificate mint await before they write, and `participantSessionDenied` re-asks the session at
// commit. The admin twins' helpers (`parked`, `seat`, `signIn`) are reused from
// admin-inflight-helpers.js rather than copied.
//
// Imports `expect` from @playwright/test, NEVER `./isolated-test` (see
// admin-inflight-helpers.js for why).
const { expect } = require("@playwright/test");
const Database = require("better-sqlite3");
const { TEST_DB_PATH, gradingHashFor, PARTICIPANT_PASS } = require("./helpers");
const { H, makeParticipant, enrol } = require("./event-admin-helpers");
const { signIn, sessionIdOf } = require("./admin-inflight-helpers");

/** The sentence every commit-time "the session ended" refusal carries (admin and participant twins alike). */
const SESSION_ENDED = "Your session ended before this finished, so nothing was saved. Try again — if you are asked to sign in, do that first.";

function dbGet(sql, ...a) { const d = new Database(TEST_DB_PATH, { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } }
function dbAll(sql, ...a) { const d = new Database(TEST_DB_PATH, { readonly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } }
function dbRun(sql, ...a) { const d = new Database(TEST_DB_PATH); try { return d.prepare(sql).run(...a); } finally { d.close(); } }
function dbExec(sql) { const d = new Database(TEST_DB_PATH); try { d.exec(sql); } finally { d.close(); } }

const tombstoned = (sid) => !!dbGet("SELECT 1 AS x FROM revoked_sessions WHERE id=?", sid);
/** Every `impersonation_ended` reason on `uid`'s History, oldest first. */
function endedWindows(uid) {
  return dbAll("SELECT details FROM user_events WHERE user_id=? AND event_type='impersonation_ended' ORDER BY changed_at", uid)
    .map(r => { try { return JSON.parse(r.details).reason; } catch { return null; } });
}

/** A fresh participant signed in as THEMSELVES (no impersonation), enrolled in `compId` when given. */
async function ownSession(sa, saCsrf, label, compId) {
  const p = await makeParticipant(sa, saCsrf, label);
  if (compId) await enrol(sa, saCsrf, compId, [p.id]);
  const s = await signIn(p.email, PARTICIPANT_PASS);
  return { p, api: s.api, csrf: s.csrf, sid: await sessionIdOf(s.api) };
}
async function enter(v, compId) {
  const sel = await v.api.post("/api/select-competition", { headers: H(v.csrf), data: { competitionId: compId } });
  expect(sel.ok(), `select-competition: ${sel.status()} ${await sel.text()}`).toBeTruthy();
}
async function fileSubmit(v, taskId, csrf = v.csrf) {
  const hash = await gradingHashFor(v.api, taskId);
  expect(hash, "PRECONDITION: the challenge is readable through this session").toBeTruthy();
  return v.api.post(`/api/tasks/${taskId}/submit`, { headers: { "x-csrf-token": csrf },
    multipart: { gradingHash: hash, file: { name: "answer.txt", mimeType: "text/plain", buffer: Buffer.from("win") } } });
}

/**
 * The file answer parked inside its read window, `act` run there, then
 * released. `parked` is the server's own count of requests that entered the
 * park, so `act` runs inside the window deterministically; that it also
 * FINISHED inside it is asserted as a PRECONDITION, from the moment the request
 * was sent (no later than its entry into the park), because the park is
 * time-based and a slow act would otherwise read as a product failure.
 */
async function parkedSubmit(sa, saCsrf, v, taskId, act, delayMs = 3500) {
  const arm = await sa.post("/api/test/submit-read-delay", { headers: H(saCsrf), data: { delayMs } });
  expect(arm.ok(), "arm the file-read park").toBeTruthy();
  let primary = null;
  try {
    const tSend = Date.now();
    const pending = fileSubmit(v, taskId);
    for (;;) {
      const n = (await (await sa.get("/api/test/submit-read-delay")).json()).parked;
      if (n >= 1) break;
      if (Date.now() - tSend > 10_000) throw new Error("PRECONDITION: the submission never reached the file-read park");
      await new Promise(r => setTimeout(r, 25));
    }
    if (act) {
      await act();
      expect(Date.now() - tSend, "PRECONDITION: the act finished while the answer was still parked (raise delayMs)").toBeLessThan(delayMs);
    }
    const r = await pending;
    const json = await r.json().catch(() => ({}));
    return { r, status: r.status(), json, text: JSON.stringify(json) };
  } catch (e) { primary = e; throw e; }
  finally {
    const d = await sa.post("/api/test/submit-read-delay", { headers: H(saCsrf), data: { delayMs: 0 } }).catch(() => null);
    // eslint-disable-next-line no-unsafe-finally
    if (!primary && !(d && d.ok())) throw new Error("the file-read park could not be disarmed — every later file answer in this file would park");
  }
}

const wrote = (uid, taskId) => dbGet("SELECT COUNT(*) c, COALESCE(SUM(points_delta),0) pts FROM submissions WHERE user_id=? AND task_id=?", uid, taskId);
/** challenge_events are written on a deferred tick: a later answered request proves the tick has run. */
async function settledChallengeEvents(sa, uid, taskId) {
  await sa.get("/api/test/submit-read-delay");
  return dbGet("SELECT COUNT(*) c FROM challenge_events WHERE user_id=? AND task_id=?", uid, taskId).c;
}
/** Every `Set-Cookie` entry for session `sid` a response carries. */
function sessionCookiesIn(r, sid) {
  const prefix = `connect.sid=${encodeURIComponent("s:" + sid)}.`;
  return r.headersArray().filter(h => h.name.toLowerCase() === "set-cookie" && h.value.startsWith(prefix)).map(h => h.value);
}
const cookieExpiryMs = (c) => { const m = /expires=([^;]+)/i.exec(c); return m ? Date.parse(m[1]) : NaN; };
/** GET /api/session/status through `api` (its cookie jar decides which session is asked about). */
async function sessionStatus(api) { return (await api.get("/api/session/status")).json(); }

module.exports = {
  SESSION_ENDED, dbGet, dbAll, dbRun, dbExec, tombstoned, endedWindows,
  ownSession, enter, fileSubmit, parkedSubmit, wrote, settledChallengeEvents,
  sessionCookiesIn, cookieExpiryMs, sessionStatus,
};
