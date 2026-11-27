// @ts-check
//
// v8.12.7 — shared fixtures for the specs that revoke an admin WHILE their request
// is in flight: `admin-inflight-authz.api.spec.js` (the uploads and imports,
// v8.12.6) and `desk-invite-inflight-authz.api.spec.js` (the desk shortcut and
// the maintenance seeder, v8.12.7). Moved here verbatim from the first of those
// rather than copied into the second, for the reason `ui-admin-helpers.js`
// exists: two hand-rolled copies of `parked()` would drift, and the first
// divergence is invisible — an arm that acts before the request has reached the
// park is refused by the GUARD on the unfixed tree too, and passes vacuously.
//
// Imports `expect` from @playwright/test, NEVER `./isolated-test`: that module
// registers the per-file recycle hook AT IMPORT TIME, so a helper requiring it
// would risk the one mechanism that gives every spec file a fresh database
// (v7.21.35).
const { expect } = require("@playwright/test");
const Database = require("better-sqlite3");
const { freshCtx, TEST_DB_PATH, PARTICIPANT_PASS, codeLogin } = require("./helpers");
const { H, makeParticipant, enrol } = require("./event-admin-helpers");

function _dbGet(sql, ...a) { const d = new Database(TEST_DB_PATH, { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } }

/** A fresh API context signed in as `email`, with a CSRF token minted AFTER the login (the login regenerates the session). */
async function signIn(email, password) {
  const { api, csrf } = await freshCtx();
  const r = await codeLogin(api, email, H(csrf), { password: password });
  expect(r.ok(), `login ${email}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}
async function cookieOf(api) { return (await api.storageState()).cookies.map(c => `${c.name}=${c.value}`).join("; "); }
/** The express-session id behind a context's cookie — the key `revoked_sessions` tombstones. */
async function sessionIdOf(api) {
  const c = (await api.storageState()).cookies.find(x => x.name === "connect.sid");
  const v = decodeURIComponent(c ? c.value : "");
  return v.startsWith("s:") ? v.slice(2, v.lastIndexOf(".")) : v;
}
/** A fresh participant promoted to `role` — promoted BEFORE anyone signs in as them (a role change purges sessions). */
async function makeAdmin(sa, saCsrf, label, role = "admin") {
  const p = await makeParticipant(sa, saCsrf, label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role } });
  expect(r.ok(), `promote ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  expect(_dbGet("SELECT role FROM users WHERE id=?", p.id).role, `PRECONDITION: ${label} holds ${role}`).toBe(role);
  return p;
}

/**
 * Run `send()` with the commit-time park armed, act on the PARKED request, then
 * release it. `parked` is the server's own count of requests that entered the
 * park, so `act` runs inside the post-await window deterministically — never on
 * a blind sleep, which could land before the guard (and be refused there) or
 * after the commit (and prove nothing).
 *
 * `headers` rides on the arm, the poll and the disarm — the maintenance seeder
 * runs with DATA_DIR/.maintenance present, and the maintenance gate sits in
 * front of the test hooks too, so a hook call without the bypass header answers
 * 503 and never reaches the park.
 *
 * THE ACT MUST FINISH INSIDE THE WINDOW, and that is asserted as a PRECONDITION
 * rather than assumed: the park is time-based, so an act slowed by a loaded
 * machine (a login's bcrypt, a reset) could land after the release, and the arm
 * would then read as a product failure that names nothing about the cause. The
 * bound is taken from the moment the request ENTERED the park, as the server
 * reports it (`enteredAt`, the same machine's clock): the park lets it go
 * `delayMs` after that. It was once taken from the moment the request was SENT,
 * which also counted the work before the park (two certificate renders on a
 * slow CI runner took most of a 2.5 s window and failed a correct arm).
 *
 * v8.12.7 — THE DISARM IS ASSERTED, unless the test has already failed. It used
 * to be `.catch(() => {})`: a disarm that did not land (the 503 above, for one)
 * left the park armed, and every later admin write in the file then sat in it
 * for `delayMs` and failed somewhere that names nothing about the cause. Only
 * when the body threw is the disarm left best-effort, so the ORIGINAL failure is
 * the one reported.
 */
async function parked(sa, send, act, delayMs = 2500, headers = {}) {
  const arm = await sa.post("/api/test/admin-commit-delay", { headers, data: { delayMs } });
  expect(arm.ok(), `arm the commit park: ${arm.status()}`).toBeTruthy();
  let primary = null;
  try {
    const tSend = Date.now();
    const pending = send();
    let enteredAt = 0;
    for (;;) {
      const st = await (await sa.get("/api/test/admin-commit-delay", { headers })).json();
      if (st.parked >= 1) { enteredAt = st.enteredAt || tSend; break; }
      if (Date.now() - tSend > 10_000) throw new Error("PRECONDITION: the request never reached the commit park");
      await new Promise(r => setTimeout(r, 25));
    }
    if (act) {
      await act();
      expect(Date.now() - enteredAt, "PRECONDITION: the act finished while the request was still parked (raise delayMs)").toBeLessThan(delayMs);
    }
    return await pending;
  } catch (e) {
    primary = e;
    throw e;
  } finally {
    const d = await sa.post("/api/test/admin-commit-delay", { headers, data: { delayMs: 0 } }).catch(() => null);
    if (!primary && !(d && d.ok())) {
      // eslint-disable-next-line no-unsafe-finally
      throw new Error(`the commit park could not be disarmed (${d ? d.status() : "request failed"}) — every later admin write in this file would park`);
    }
  }
}

/**
 * A user-backed admin of `role` (the HAND) impersonating a fresh participant
 * (the SEAT), enrolled in `comp` when one is given.
 */
async function seat(sa, saCsrf, label, role, comp) {
  const hand = await makeAdmin(sa, saCsrf, `${label}h`, role);
  const p = await makeParticipant(sa, saCsrf, `${label}p`);
  if (comp) await enrol(sa, saCsrf, comp, [p.id]);
  const s = await signIn(hand.email, PARTICIPANT_PASS);
  const e = await s.api.post(`/api/admin/participants/${p.id}/impersonate`, { headers: H(s.csrf), data: { view: "participant" } });
  expect(e.ok(), `impersonate: ${e.status()} ${await e.text()}`).toBeTruthy();
  const csrf = (await (await s.api.get("/api/csrf-token")).json()).csrfToken;
  const me = await (await s.api.get("/api/me")).json();
  expect(me.impersonation && me.impersonation.active, "PRECONDITION: the session is impersonating").toBe(true);
  return { hand, p, api: s.api, csrf, sid: await sessionIdOf(s.api) };
}

module.exports = { signIn, cookieOf, sessionIdOf, makeAdmin, parked, seat };
