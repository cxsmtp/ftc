// @ts-check
const { request } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const PARTICIPANT_PASS = "testpass123";
// server-env.js owns the port/data-dir rule; both are imported rather than
// re-derived so a helper can never resolve a different directory than the one
// the server was launched with (v7.21.35).
const { PORT_BASE, dataDirFor } = require("./server-env");

// Per-worker isolation: each Playwright worker gets its own server + SQLite
// data directory. Playwright sets TWO env vars in worker processes:
//   • TEST_PARALLEL_INDEX (0..workers-1, STABLE) ← the slot index we want
//   • TEST_WORKER_INDEX (monotonic, increments on every re-spawn/retry) ← NOT suitable
// A serial run (neither set) maps to slot 0 → port 4567 / data-test-0.
function workerIndex() {
  return parseInt(process.env.TEST_PARALLEL_INDEX || "0", 10);
}
function defaultBase() { return `http://localhost:${PORT_BASE + workerIndex()}`; }
// v7.21.35 — DELEGATE, never re-derive. This was a second hand-written copy of
// the data-directory rule, and once the directory started following
// TEST_PORT_BASE (server-env.js) a copy would resolve a DIFFERENT directory
// from the one the server was actually launched with — the helpers would read
// an empty database while the server wrote to the real one, which presents as
// an inexplicable auth failure rather than as a path bug.
function defaultDataDir() { return dataDirFor(workerIndex()); }

/**
 * Create a set of helpers scoped to one server (baseUrl + dataDir).
 * Playwright workers get a default client via the module-level re-exports below.
 * globalSetup calls createClient() per-worker to seed each one in parallel.
 */
function createClient(opts = {}) {
  const baseUrl = opts.baseUrl || defaultBase();
  const dataDir = opts.dataDir || defaultDataDir();
  const dbPath = path.join(dataDir, "hackathon.db");

  function getSuperadminPass() {
    return fs.readFileSync(path.join(dataDir, ".superadmin-password"), "utf8").trim();
  }

  async function freshCtx() {
    const api = await request.newContext({ baseURL: baseUrl });
    const r = await api.get("/api/csrf-token");
    const d = await r.json();
    return { api, csrf: d.csrfToken };
  }

  /**
   * v7.22.0 — ONE definition of the login-failure diagnostic, shared with the
   * browser-side `loginViaApi` helpers.
   *
   * It lived inline here since v7.21.40, so the EIGHT copies of `loginViaApi`
   * threw a bare `401 {"error":"Invalid email or password"}` instead — and
   * that is where the class keeps resurfacing. Two of the three occurrences
   * chased in v7.22.0 came through a path with no diagnostic at all, which is
   * exactly the gap that made them cost a fresh investigation each time.
   */
  async function describeAccountState(who, sentPassword) {
    if (who === "superadmin") return "";
    try {
      const probe = await request.newContext({ baseURL: baseUrl });
      try {
        const pc = (await (await probe.get("/api/csrf-token")).json()).csrfToken;
        const sa = await probe.post("/api/login", {
          headers: { "x-csrf-token": pc, "content-type": "application/json" },
          data: { email: "superadmin", password: getSuperadminPass() },
        });
        if (!sa.ok()) return " | account state: could not probe (superadmin login failed)";
        const list = await (await probe.get("/api/admin/participants?limit=5000")).json();
        const u = (list.participants || []).find(p => p.email === who);
        if (!u) return " | account state: NO SUCH USER in /api/admin/participants";
        // Deliberately NOT failed_login_count: /api/admin/participants does not
        // return it, so it would print a permanently-useless "?" —
        // `locked_until` is the observable that matters anyway.
        const state = ` | account state: blocked=${u.blocked} approved=${u.approved} verified=${u.verified}` +
          ` denied_at=${u.denied_at || "null"} locked_until=${u.locked_until || "null"}` +
          ` role=${u.role}`;
        return state;
      } finally { await probe.dispose(); }
    } catch (_) {
      // Diagnostics must never mask the real failure.
      return " | account state: probe threw";
    }
  }

  // Sign in on a fresh API context. Every account signs in with an emailed code
  // (the code is read back through the test-only GET /api/test/last-login-code);
  // only the built-in superadmin has a password. `password` is accepted for the
  // superadmin and ignored for everyone else, so callers keep their signature.
  async function apiLogin(email, password) {
    const { api, csrf } = await freshCtx();
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    let r;
    if (email === "superadmin") {
      const pw = password !== undefined ? password : getSuperadminPass();
      const doPost = (p) => codeLogin(api, email, h, { password: p });
      r = await doPost(pw);
      // The built-in superadmin password rotates GLOBALLY after 10 consecutive
      // failed logins; the server writes the fresh one to the file before
      // responding, so a single re-read + retry recovers it.
      if (!r.ok() && password === undefined) r = await doPost(getSuperadminPass());
    } else {
      r = await codeLogin(api, email, h);
    }
    if (!r.ok()) {
      const why = await describeAccountState(email);
      throw new Error(`Login failed for ${email}: ${r.status()} ${await r.text()}${why}`);
    }
    const body = await r.json();
    // Session regenerated after login — get a fresh CSRF token
    const newCsrf = (await (await api.get("/api/csrf-token")).json()).csrfToken;
    return { api, csrf: newCsrf, body };
  }

  async function seedTestData() {
    const { api, csrf } = await apiLogin("superadmin");
    const h = { "x-csrf-token": csrf, "content-type": "application/json" };
    const now = Date.now();
    const comps = {};

    // Create competitions. A create that fails throws naming the competition,
    // because `recycleServer()` reports only its LAST error.
    //
    // A RETRY ADOPTS WHAT THE FAILED ATTEMPT MADE. `_spawnAndSeed` retries this
    // whole function against the SAME server, so the create of a competition an
    // earlier attempt made answers 409 on its unique name; taken as a failure,
    // every retry would fail the same way and report that 409, not the cause. On
    // a 409 the row of that name is adopted, but only when it has the seed's
    // shape (its key is its status, and its length): a same-named row of
    // another shape is refused by name, never mistaken for the seed's.
    const mkComp = async (key, data) => {
      const res = await api.post("/api/admin/competitions", { headers: h, data });
      let id = res.ok() ? (await res.json()).competition?.id : null;
      if (!id && res.status() === 409) {
        const rows = ((await (await api.get("/api/admin/competitions")).json()) || []).filter(c => c.name === data.name);
        const row = rows.length === 1 ? rows[0] : null;
        if (!row || row.status !== key || row.duration_minutes !== data.duration_minutes) {
          throw new Error(`seed: '${data.name}' exists but is not the seed's (${rows.length} row(s)` +
            (row ? `, status ${row.status}, ${row.duration_minutes} min` : "") + `; want ${key}, ${data.duration_minutes} min)`);
        }
        id = row.id;
      }
      if (!id) throw new Error(`seed: could not create '${data.name}': ${res.status()} ${await res.text()}`);
      comps[key] = id;
    };
    await mkComp("upcoming", { name: "Test Upcoming", start_time: new Date(now + 2 * 3600_000).toISOString(), duration_minutes: 120 });
    await mkComp("live", { name: "Test Live", start_time: new Date(now - 30 * 60_000).toISOString(), duration_minutes: 180 });
    await mkComp("ended", { name: "Test Ended", start_time: new Date(now - 5 * 3600_000).toISOString(), duration_minutes: 60 });
    let r;

    // Create tasks. Titles are not unique, so a retry would make a second copy of
    // each: a challenge the failed attempt made is adopted by title instead, with
    // the same shape check as the competitions above.
    const tasks = {};
    const _tl = await (await api.get("/api/admin/tasks")).json();
    const existingTasks = Array.isArray(_tl) ? _tl : (_tl.tasks || []);
    for (const [key, diff] of [["easy1","easy"],["med1","medium"],["hard1","hard"],["easy2","easy"],["draft1","easy"]]) {
      const title = `Challenge ${key}`;
      const status = key === "draft1" ? "draft" : "published";
      // The library row: an event holds its own same-titled copy (lib/event-copies.js).
      const found = existingTasks.filter(t => t.title === title && !t.owner_competition_id);
      if (found.length) {
        const t = found.length === 1 ? found[0] : null;
        if (!t || t.difficulty !== diff || t.status !== status || t.answer_type !== "text") {
          throw new Error(`seed: '${title}' exists but is not the seed's (${found.length} row(s)` +
            (t ? `, ${t.difficulty}, ${t.status}, ${t.answer_type}` : "") + `; want ${diff}, ${status}, text)`);
        }
        tasks[key] = t.id;
        continue;
      }
      r = await api.post("/api/admin/tasks", { headers: h, data: {
        title, description: `<p>Description for ${key}</p>`,
        difficulty: diff, answer_type: "text", correct_answer: `answer-${key}`,
        explanation: `<p>Explanation for ${key}</p>`, hint: `Hint for ${key}`,
        status,
      }});
      tasks[key] = r.ok() ? (await r.json()).id : null;
      if (!tasks[key]) throw new Error(`seed: could not create '${title}': ${r.status()} ${await r.text()}`);
    }

    // Assign tasks to competitions
    for (const tid of [tasks.easy1, tasks.med1, tasks.hard1]) {
      await api.post(`/api/admin/tasks/${tid}/competitions`, { headers: h, data: { competitionIds: [comps.live] } });
    }
    for (const tid of [tasks.easy1, tasks.easy2]) {
      await api.post(`/api/admin/tasks/${tid}/competitions`, { headers: h, data: { competitionIds: [comps.upcoming] } });
    }

    // Register participants (a retry skips an address the failed attempt
    // registered: its sign-up door would only sign that account in).
    const _had = new Set((((await (await api.get("/api/admin/participants?limit=200")).json()).participants) || []).map(p => p.email));
    for (const [key, first, last, nick, company] of [
      ["alice","Alice","Smith","alice_s","Acme Corp"],
      ["bob","Bob","Jones","bob_j","Initech"],
      ["carol","Carol","Lee","carol_l","Globex"],
    ]) {
      if (_had.has(`${key}@acme.com`)) continue;
      await registerPost(api, baseUrl + "/api/register", { headers: h, data: {
        firstName: first, lastName: last, nickname: nick,
        email: `${key}@acme.com`, company, title: "Engineer", avatar: "🦊",
        country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "New York",
      }});
    }

    // Verify and approve all participants
    const allUsers = await (await api.get("/api/admin/participants?limit=200")).json();
    for (const p of allUsers.participants || []) {
      if (!p.verified) await api.post(`/api/admin/participants/${p.id}/verify`, { headers: h });
      if (!p.approved) await api.post(`/api/admin/participants/${p.id}/approve`, { headers: h });
    }

    const participants = (allUsers.participants || []).filter(p => !["admin","superadmin"].includes(p.role));

    // Assign participants to competitions.
    //
    // v8.6.5 — THESE TWO CALLS WERE THE LAST FIRE-AND-FORGET STEPS IN THE SEED,
    // and they are the two that decide the fixture contract `isolated-test.js`
    // enforces ("alice is still a member of Test Live"). Two documented traps
    // met here at once: v7.22.5's "a seed step that silently does not happen is
    // worse than one that fails" — every other step throws — and the
    // fixture-checklist rule that `/assign` SKIPS an ineligible user and still
    // answers 200, so a lost alice is invisible in the response.
    //
    // Left unchecked the failure surfaced as a FULL-SUITE-ONLY flake in whatever
    // spec happened to run: its afterAll guard reported "alice is no longer a
    // member of Test Live" and named an innocent file — the guard's own warning
    // about naming the breaker rather than the tripper, defeated because the
    // breaker was the seed itself. Throwing instead lets `recycleServer()`'s five
    // retries self-heal a transient, which is the whole point of that retry loop.
    const assertAssigned = async (res, want, what) => {
      if (!res.ok()) throw new Error(`seed: assign ${what} failed: ${res.status()} ${await res.text()}`);
      const d = await res.json();
      // The COUNT, not merely the status: skipping is a 200.
      if (d.assigned !== want) {
        throw new Error(`seed: assign ${what} attached ${d.assigned} of ${want} ` +
          `(skipped staff=${d.skippedStaff} unapproved=${d.skippedUnapproved} blocked=${d.skippedBlocked})`);
      }
    };
    // A retry finds some of them already members, which the assign counts as
    // nothing assigned: each call names only the people not yet in the event
    // (read from the list above), and is skipped when everybody is.
    const notIn = (ids, cid) => ids.filter(id => !((participants.find(p => p.id === id) || {}).competitions || []).some(c => c.id === cid));
    const assignOnce = async (ids, cid, what) => {
      const todo = notIn(ids, cid);
      if (!todo.length) return;
      await assertAssigned(await api.post("/api/admin/competitions/assign", { headers: h, data: {
        userIds: todo, competitionIds: [cid],
      }}), todo.length, what);
    };
    const userIds = participants.map(p => p.id);
    await assignOnce(userIds, comps.live, "participants -> Test Live");
    const aliceId = participants.find(p => p.email === "alice@acme.com")?.id;
    const bobId = participants.find(p => p.email === "bob@acme.com")?.id;
    // A missing id means an earlier step half-succeeded; carrying on would leave
    // the upcoming competition empty and say nothing.
    if (!aliceId || !bobId) throw new Error("seed: alice/bob were not both registered");
    await assignOnce([aliceId, bobId], comps.upcoming, "alice+bob -> Test Upcoming");

    // Submit answers as Alice in the live competition
    const { api: aliceApi, csrf: aliceCsrf, body: aliceBody } = await apiLogin("alice@acme.com", PARTICIPANT_PASS);
    const liveComp = aliceBody.competitions?.find(c => c.name === "Test Live");
    // v8.6.5 — and this `if` was the same defect's second half: with the assign
    // silently skipped, alice had no membership AND no submissions, and the seed
    // reported success either way.
    if (!liveComp) throw new Error("seed: alice is not in 'Test Live' after the assign");
    {
      await aliceApi.post("/api/select-competition", {
        headers: { "x-csrf-token": aliceCsrf, "content-type": "application/json" },
        data: { competitionId: liveComp.id },
      });
      // Correct answer for easy1 / wrong answer for med1. Both fetch the task
      // first for its grading-revision token (required since v7.20.9).
      const _sh = { "x-csrf-token": aliceCsrf, "content-type": "application/json" };
      const _gh = async id => {
        const r = await aliceApi.get(`/api/tasks/${id}`, { headers: _sh });
        return r.ok() ? (await r.json()).grading_hash : "";
      };
      // A retry must not answer twice (a second wrong answer costs alice 5 more
      // points): each answer is sent only while alice has no answer of its kind.
      const _done = (() => {
        const Database = require("better-sqlite3");
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
          // Named by the library question: the event answers its own copy (lib/event-copies.js).
          return db.prepare("SELECT COALESCE(t.copied_from_task_id, s.task_id) AS task_id, s.is_correct FROM submissions s JOIN tasks t ON t.id = s.task_id WHERE s.competition_id=? AND s.user_id=?").all(liveComp.id, aliceId);
        } finally { db.close(); }
      })();
      const _has = (tid, correct) => _done.some(r => r.task_id === tid && !!r.is_correct === correct);
      if (!_has(tasks.easy1, true)) {
        await aliceApi.post(`/api/tasks/${tasks.easy1}/submit`, {
          headers: _sh, data: { answer: "answer-easy1", gradingHash: await _gh(tasks.easy1) },
        });
      }
      if (!_has(tasks.med1, false)) {
        await aliceApi.post(`/api/tasks/${tasks.med1}/submit`, {
          headers: _sh, data: { answer: "wrong-answer", gradingHash: await _gh(tasks.med1) },
        });
      }
    }
    await aliceApi.dispose();
    await api.dispose();

    return { comps, tasks };
  }

  return { baseUrl, dataDir, dbPath, getSuperadminPass, freshCtx, apiLogin, seedTestData, describeAccountState };
}

/**
 * Sign in on an EXISTING request context (an APIRequestContext or page.request)
 * the way the SPA does: request an emailed code, read it back through the
 * test-only GET /api/test/last-login-code, redeem it. The built-in superadmin
 * (the only password left) posts /api/login instead, with `opts.password`.
 *
 * Returns a response-shaped object so call sites written against /api/login
 * keep working: `ok()` is true only when the sign-in SUCCEEDED (the redeem
 * door answers 200 for every outcome and puts the verdict in `ok`), `status()`
 * is 200 / 403 (pending approval) / 401 (refused), `json()` the redeem body.
 * `opts.base` prefixes the paths for callers that used an absolute URL.
 */
async function codeLogin(ctx, email, headers, opts = {}) {
  const base = opts.base || "";
  let h = headers;
  if (!h) {
    const t = (await (await ctx.get(base + "/api/csrf-token")).json()).csrfToken;
    h = { "x-csrf-token": t, "content-type": "application/json" };
  }
  if (email === "superadmin") {
    return ctx.post(base + "/api/login", { headers: h, data: { email, password: opts.password !== undefined ? opts.password : defaultClient.getSuperadminPass() } });
  }
  // "Sign in now": forget the two-minute re-send suppression first, so a code the
  // account was mailed moments ago (a registration, another sign-in) cannot leave
  // this address without a fresh one. Specs about the suppression itself request
  // codes directly, not through this helper.
  await ctx.post(base + "/api/test/reset-recent-code-sends", { headers: h });
  const rq = await ctx.post(base + "/api/auth/code/request", { headers: h, data: { email, ...(opts.joinToken ? { joinToken: opts.joinToken } : {}) } });
  if (!rq.ok()) return rq;
  const c = await ctx.get(base + "/api/test/last-login-code?email=" + encodeURIComponent(email));
  const code = c.ok() ? (await c.json()).code : "NOCODE00";
  const rd = await ctx.post(base + "/api/auth/code/redeem", { headers: h, data: { email, code } });
  if (!rd.ok()) return rd;
  const raw = await rd.json().catch(() => ({}));
  // An address with NO account redeems an address proof (`needsProfile`): that
  // signs nobody in, so it is a refusal here (use registerPost to create one).
  const body = raw.needsProfile ? { ...raw, ok: false, error: "no_account" } : raw;
  const status = body.ok ? 200 : (body.error === "pending_approval" ? 403 : 401);
  const text = JSON.stringify(body.ok ? body : { ...body, error: body.error || "sign_in_refused" });
  return {
    ok: () => !!body.ok,
    status: () => status,
    json: async () => JSON.parse(text),
    text: async () => text,
    headers: () => rd.headers(),
    headersArray: () => rd.headersArray(),
    url: () => rd.url(),
    _redeem: rd,
  };
}

/**
 * POST /api/register the way the SPA reaches it: EMAIL FIRST. An account is
 * created only by a session holding a live address-proof grant, so this runs
 * the real doors in a FRESH request context — request a code for the address
 * (with the body's joinToken / invitationId, as the entry screen sends them),
 * read it back through GET /api/test/last-login-code, redeem it (which grants
 * the session), then submit the form — and returns the registration's response
 * (status, headers and parsed body captured before the context is disposed).
 *
 * The fresh context keeps the CALLER's session exactly as it was: a spec that
 * registers someone from an admin's context stays that admin. An invitation's
 * proof is requested for the invitation's own address (the account always gets
 * the proven address).
 *
 * Passed straight through, unchanged, on the caller's context: a call with no
 * CSRF header (a CSRF lock) or a body without a string `email` (shape locks).
 */
async function registerPost(ctx, url, opts = {}) {
  const data = opts && opts.data;
  const hdrs = (opts && opts.headers) || {};
  const hasCsrf = Object.keys(hdrs).some(k => k.toLowerCase() === "x-csrf-token");
  if (!hasCsrf || !data || typeof data !== "object" || Array.isArray(data)
      || typeof data.email !== "string" || !data.email.trim()) {
    return ctx.post(url, opts);
  }
  const probe = await ctx.get(String(url).replace(/\/api\/register.*$/, "/api/config"));
  const origin = new URL(probe.url()).origin;
  const c = await request.newContext({ baseURL: origin });
  try {
    const tok = async () => (await (await c.get("/api/csrf-token")).json()).csrfToken;
    let h = { "x-csrf-token": await tok(), "content-type": "application/json" };
    let email = data.email.trim().toLowerCase();
    if (typeof data.invitationId === "string" && data.invitationId) {
      const inv = await c.get("/api/invitations/" + encodeURIComponent(data.invitationId));
      if (inv.ok()) email = String((await inv.json()).email || email).trim().toLowerCase();
    }
    await c.post("/api/test/reset-recent-code-sends", { headers: h });
    await c.post("/api/auth/code/request", { headers: h, data: {
      email,
      ...(typeof data.joinToken === "string" && data.joinToken ? { joinToken: data.joinToken } : {}),
      ...(typeof data.invitationId === "string" && data.invitationId ? { invitationId: data.invitationId } : {}),
    } });
    const last = await c.get("/api/test/last-login-code?email=" + encodeURIComponent(email));
    const lastBody = last.ok() ? await last.json() : null;
    if (lastBody && lastBody.via === "proof") {
      const rd = await c.post("/api/auth/code/redeem", { headers: h, data: { email, code: lastBody.code } });
      const rdb = rd.ok() ? await rd.json() : {};
      if (rdb.needsProfile) h = { ...h, "x-csrf-token": await tok() };   // the redeem regenerated the session
    }
    const extra = {};
    for (const [k, v] of Object.entries(hdrs)) {
      const lk = k.toLowerCase();
      if (lk !== "x-csrf-token" && lk !== "cookie" && lk !== "content-type") extra[k] = v;
    }
    const { keepState, deferJoin, ...postOpts } = opts;
    const r = await c.post("/api/register", { ...postOpts, headers: { ...extra, ...h }, data });
    const raw = await r.text();
    // By default the new account is rewound to a FIXTURE state (POST
    // /api/test/registration-legacy-state): unverified with a live verify_code,
    // never signed in, and pending unless a join link or an invitation made it.
    // No sign-up creates that state today (a real one is verified with no
    // verify_code, and signed in at once unless approval holds it), and an
    // invited or join-link account never looked like it, even before email-first;
    // it is kept so specs written against it keep testing what they test.
    // `keepState: true` keeps what the doors really created (pinned, beside this
    // default, in tests/signup-real-state.api.spec.js). `deferJoin: true` also
    // puts a join-link registration's enrolment back to "deferred to the first
    // sign-in" (marker set, no row), as it used to be.
    if (!keepState && r.status() === 200) {
      let made = null;
      try { made = JSON.parse(raw); } catch (_) { made = null; }
      if (made && made.email) {
        await c.post("/api/test/registration-legacy-state", { headers: h, data: { email: made.email, ...(deferJoin ? { deferJoin: true } : {}) } });
      }
    }
    const snapshot = { status: r.status(), headers: r.headers(), headersArray: r.headersArray(), url: r.url() };
    return {
      ok: () => snapshot.status >= 200 && snapshot.status < 300,
      status: () => snapshot.status,
      statusText: () => "",
      text: async () => raw,
      json: async () => JSON.parse(raw),
      headers: () => snapshot.headers,
      headersArray: () => snapshot.headersArray,
      url: () => snapshot.url,
    };
  } finally {
    await c.dispose();
  }
}

/**
 * What the entry screen's Continue sends an address, read back: request a code
 * for `email` on a FRESH context (the caller's session untouched) and return
 * `{ answer, mail }` — `answer` the request's own JSON (always `{ok:true}`),
 * `mail` the GET /api/test/last-login-code body (`via:"proof"` for an address
 * proof, otherwise a sign-in code) or null when nothing was mailed. Specs use it
 * to assert which door an address meets BEFORE any registration exists: a
 * malformed, free-mail or reserved address gets nothing, so no grant can exist
 * and POST /api/register refuses it 403 `email_proof_required`.
 */
async function entryCode(ctxOrUrl, email, extra = {}) {
  let origin = ctxOrUrl;
  if (typeof ctxOrUrl !== "string") {
    const probe = await ctxOrUrl.get("/api/config");
    origin = new URL(probe.url()).origin;
  }
  const c = await request.newContext({ baseURL: origin });
  try {
    const h = { "x-csrf-token": (await (await c.get("/api/csrf-token")).json()).csrfToken, "content-type": "application/json" };
    await c.post("/api/test/reset-recent-code-sends", { headers: h });
    const before = Date.now() - 1000;   // only a code minted by THIS request counts
    const rq = await c.post("/api/auth/code/request", { headers: h, data: { email, ...extra } });
    const answer = await rq.json().catch(() => null);
    const last = await c.get("/api/test/last-login-code?email=" + encodeURIComponent(String(email).trim().toLowerCase()));
    const got = last.ok() ? await last.json() : null;
    const mail = got && got.at >= before ? got : null;
    return { status: rq.status(), answer, mail };
  } finally {
    await c.dispose();
  }
}

// Default client used by tests running inside a Playwright worker — reads
// TEST_WORKER_INDEX to pick the right server.
// v8.5.1 — POLL THE AUDIT MIRROR, NEVER SLEEP FOR IT.
//
// `_scheduleMirrorAuditToLog` is `setImmediate`-deferred and its write does the
// enrichment SELECTs BEFORE the file write, deliberately, so the better-sqlite3
// write lock is not held across it (see CLAUDE.md, *Accepted audit dispositions*,
// ext-audit F7). A fixed `setTimeout` is therefore a guess about how loaded the
// machine is, and four sites were guessing 200-300 ms: one of them went flaky at
// WORKERS=18 with a bare `Received: null`, which names neither the deferral nor
// the contention and cost a fresh investigation.
//
// The cap is what keeps this a LOCK rather than a wait: a timeout here means the
// line was never written, not that it was written late, and the message says so
// along with what was sought and what the newest file actually held — because
// "null" is equally true of a missing emit, a mirror that stopped running, and a
// predicate that no longer matches the shape being emitted.
async function findLogLine(logsDir, predicate, opts = {}) {
  const timeoutMs = opts.timeoutMs || 10000;
  const what = opts.what || "a matching log line";
  // "app-" is the audit mirror; "access-" is the per-request log, written by an
  // INDEPENDENT path (`res.on("finish")`), so waiting for one says nothing about
  // whether the other has landed — the v8.3.39 lesson, which is why the prefix is
  // a parameter rather than a constant.
  const prefix = opts.prefix || "app-";
  const deadline = Date.now() + timeoutMs;
  let files = [], scanned = 0;
  for (;;) {
    try {
      files = fs.readdirSync(logsDir)
        .filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl")).sort();
      if (files.length) {
        const newest = path.join(logsDir, files[files.length - 1]);
        const lines = fs.readFileSync(newest, "utf8").trim().split("\n").filter(Boolean);
        scanned = lines.length;
        // Newest-first: the line we just caused is at the end.
        for (let i = lines.length - 1; i >= 0; i--) {
          let j;
          try { j = JSON.parse(lines[i]); } catch (_) { continue; }
          if (predicate(j)) return j;
        }
      }
    } catch (_) { /* the file can be mid-write or rotating; retry */ }
    if (Date.now() >= deadline) {
      throw new Error(
        `never found ${what} in ${prefix}*.jsonl within ${timeoutMs} ms. `
        + `Files: ${files.join(", ") || "(none)"}; ${scanned} lines in the newest. `
        + `This is a poll, not a sleep — a timeout means the line was never written.`);
    }
    await new Promise((rs) => setTimeout(rs, 50));
  }
}

// v8.12.5 — the same rule through the ADMIN LOGS API. `GET /api/admin/logs`
// reads the very files findLogLine does, so a single read straight after the
// action races the same deferred mirror write (one full run failed with "No
// audit:task:created row"). Polls `query` until `ready(entries)` is true and
// returns the entries; a timeout says what was sought and how many entries the
// last read held, which separates "never written" from "wrong predicate".
async function pollAdminLogs(api, query, ready, opts = {}) {
  const timeoutMs = opts.timeoutMs || 10000;
  const what = opts.what || "the expected log entries";
  const deadline = Date.now() + timeoutMs;
  let entries = [], status = 0;
  for (;;) {
    const r = await api.get(`/api/admin/logs?${query}`);
    status = r.status();
    if (r.ok()) {
      entries = (await r.json()).entries || [];
      if (ready(entries)) return entries;
    }
    if (Date.now() >= deadline) {
      throw new Error(`never found ${what} via /api/admin/logs?${query} within ${timeoutMs} ms `
        + `(last status ${status}, ${entries.length} entries). This is a poll, not a sleep.`);
    }
    await new Promise((rs) => setTimeout(rs, 100));
  }
}

const defaultClient = createClient();

/**
 * Every attachment upload is refused while it would leave the server's
 * filesystem under lib/attachments.js ATTACHMENT_FREE_DISK_MIN_BYTES (1 GiB), and
 * that floor is asked before any quota, so a test about another upload refusal
 * meets "Server storage is too low…" instead on a runner whose disk dips under
 * it (CI, 14 Nov 2026: the runner warned "Free space left: 37 MB" mid-job).
 * Waits, bounded, until the worker server's filesystem, read as the server
 * reads it (statfs bavail × bsize), has room for `bytes` more past the floor,
 * and fails naming the room it found.
 */
async function awaitUploadRoom(bytes, { timeout = 15000, dir = defaultClient.dataDir } = {}) {
  // The floor is read from the source: the module opens the database at require time.
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "attachments.js"), "utf8");
  const m = /\bATTACHMENT_FREE_DISK_MIN_BYTES\s*=\s*(\d+(?:\s*\*\s*\d+)*)\s*;/.exec(src);
  if (!m) throw new Error("awaitUploadRoom: lib/attachments.js no longer spells the upload disk floor as a product of numbers; teach this helper its new spelling");
  const floor = m[1].split("*").reduce((p, t) => p * Number(t.trim()), 1);
  const MIB = 1024 * 1024, MARGIN = 64 * MIB;
  const room = () => { const s = fs.statfsSync(dir); return s.bavail * s.bsize - floor - bytes; };
  const until = Date.now() + timeout;
  let left = room();
  while (left < MARGIN && Date.now() < until) {
    await new Promise((rs) => setTimeout(rs, 500));
    left = room();
  }
  if (left < MARGIN) {
    throw new Error(`PRECONDITION: the server's filesystem (${dir}) has ${Math.floor(left / MIB)} MB past the ${Math.round(floor / MIB)} MB upload floor once ${Math.ceil(bytes / MIB)} MB more land (margin ${MARGIN / MIB} MB) after ${timeout / 1000} s: the server refuses every upload for the disk first, so a test about another refusal cannot run on this machine`);
  }
  return left;
}

/**
 * Fetch the grading-revision token for a challenge — REQUIRED on submit since
 * ext-audit v7.20.9 (F1).
 *
 * The token is issued by `GET /api/tasks/:id` as `grading_hash` and echoed back
 * on submit so the server can refuse to grade a participant against criteria
 * they never saw. It used to be optional, which made that protection opt-out;
 * requiring it means anything that wants its submission GRADED has to load the
 * challenge first, exactly as the SPA does.
 *
 * `apiCtx` is any authenticated request context (the GET carries no CSRF, so no
 * headers are needed). Returns "" when the task is not readable — a test
 * asserting a lifecycle REFUSAL does not need a real token anyway, because
 * ended / upcoming / locked / not-found all return before the token is checked.
 */
async function gradingHashFor(apiCtx, taskId) {
  try {
    const r = await apiCtx.get(`/api/tasks/${taskId}`);
    if (!r.ok()) return "";
    return (await r.json()).grading_hash || "";
  } catch (_) { return ""; }
}

// ── a REAL png fixture, shared ───────────────────────────────────────────────
// v7.21.25 — hoisted out of request-error-reporting.spec.js when a second spec
// needed it. Two traps are baked in, both of which produced a silently vacuous
// fixture before they were understood:
//
//  • Node's base64 decoder STOPS AT THE `=` PADDING, so the obvious shortcut of
//    appending filler to a 1x1 image yields a data URI that LOOKS megabytes long
//    and decodes to a few bytes — sailing through every size check.
//  • The noise must come from a sha256 chain, not an LCG: an LCG's low bits
//    cycle and its high bits stay correlated, so the "noise" deflates away and
//    the image comes out several times smaller than asked for.
function _crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function _pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(_crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A valid RGB PNG of `side` x `side` pixels, filled with incompressible noise. */
function makePng(side, seedText = "hackarena-avatar-fixture") {
  const zlib = require("zlib"), crypto = require("crypto");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(side * (1 + side * 3));
  let block = crypto.createHash("sha256").update(seedText).digest();
  let bi = 0;
  for (let y = 0; y < side; y++) {
    const off = y * (1 + side * 3);
    raw[off] = 0; // filter: none
    for (let i = 0; i < side * 3; i++) {
      if (bi >= block.length) { block = crypto.createHash("sha256").update(block).digest(); bi = 0; }
      raw[off + 1 + i] = block[bi++];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    _pngChunk("IHDR", ihdr),
    _pngChunk("IDAT", zlib.deflateSync(raw, { level: 1 })),
    _pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
const pngDataUri = (side, seedText) => "data:image/png;base64," + makePng(side, seedText).toString("base64");

/**
 * Wait for the admin panel, and on failure SAY WHY (v8.8.27).
 *
 * `#admin-page` is the right readiness signal — it is `display:none` until boot
 * has resolved who we are, which is why v8.3.33 forbids gating on
 * `.admin-nav-item` being merely ATTACHED. What it is NOT is self-explaining: a
 * timeout reports `N × locator resolved to hidden`, which is equally true of a
 * login that failed, an account that is not approved or verified, a role change
 * that had not landed when boot asked, a boot still in flight under load, and a
 * server that never came up. Four different bugs, one message.
 *
 * Seen twice in one full-suite run at WORKERS=18 and NOT reproducible in 3
 * isolated runs of either file, so no mechanism is claimed here and the timeout
 * is deliberately NOT widened — a blind third widening is what this codebase
 * warns against. This makes the next occurrence name itself instead.
 */
async function waitForAdminPage(page, timeout = 30000) {
  try {
    await page.locator("#admin-page").waitFor({ state: "visible", timeout });
  } catch (e) {
    let diag = "(could not read page state)";
    try {
      diag = JSON.stringify(await page.evaluate(async () => {
        const S = window.S || {};
        let adminMe = null, me = null;
        try { const r = await fetch("/api/admin/me"); adminMe = { status: r.status, body: await r.text() }; } catch (err) { adminMe = String(err); }
        try { const r = await fetch("/api/me"); me = { status: r.status }; } catch (err) { me = String(err); }
        return {
          userRole: S.userRole, isAdmin: S.isAdmin, isSuperAdmin: S.isSuperAdmin,
          isAdminView: S.isAdminView,
          visiblePages: [...document.querySelectorAll(".page")].filter(p => p.offsetParent !== null).map(p => p.id),
          adminMe, me,
        };
      }));
    } catch (e) { diag = `(diagnostic read failed: ${e && e.message})`; }
    throw new Error(
      `#admin-page never became visible within ${timeout} ms.\n`
      + `Boot resolved: ${diag}\n`
      + `An empty visiblePages means boot never routed at all (server or login); a `
      + `403/401 adminMe means the ACCOUNT is not an admin the server accepts `
      + `(unapproved, unverified, or the role had not landed); a populated `
      + `userRole with adminMe 200 means the page simply had not painted yet.\n`
      + `Original: ${e && e.message}`);
  }
}

/**
 * v8.12.3 — the worker server's OWN recent error lines, for a failure message.
 *
 * A route that fails internally answers a generic 500 ("An internal error
 * occurred" / "Upload failed."), so the response body names nothing — and the
 * per-file recycle wipes this worker's data directory (and its app log) before
 * the next spec file, so the reason is gone by the time anyone reads the report.
 * Call this in the failure branch and put what it returns in the message: the
 * error handler logs every 5xx with its stack (v7.21.24), so the line that
 * explains the 500 is on disk for exactly as long as this file is running.
 * Never throws; a missing log reads as "(no app log found)".
 */
function serverLogTail({ lines = 60, keep = 6, match = /"level":"error"|Unhandled error|SQLITE|ENOSPC|EBUSY/i } = {}) {
  try {
    const fs = require("fs"), path = require("path");
    const dir = path.join(defaultClient.dataDir, "logs");
    const files = fs.readdirSync(dir).filter(f => f.startsWith("app-")).sort();
    if (!files.length) return "(no app log found)";
    const tail = fs.readFileSync(path.join(dir, files[files.length - 1]), "utf-8").trim().split("\n").slice(-lines)
      // An unreachable relay is the test server's normal state and says nothing.
      .filter(l => match.test(l) && !/Email error \(/.test(l));
    return tail.length ? tail.slice(-keep).join("\n") : "(no matching error line in the last " + lines + " lines)";
  } catch (e) {
    return `(no app log found: ${e && e.code || e})`;
  }
}

/**
 * v8.12.4 — a one-entry STORED ZIP, the smallest archive the attachment
 * validator accepts. Shared, because four specs had grown four copies; it
 * reuses the _crc32 the PNG fixture above already needs.
 */
function zipOf(name, body) {
  const nameBuf = Buffer.from(name), data = Buffer.from(body), crc = _crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(10, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
  lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(10, 6); cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(0, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14); cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(0, 42);
  const local = Buffer.concat([lh, nameBuf, data]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + nameBuf.length, 12); eocd.writeUInt32LE(local.length, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([local, cd, nameBuf, eocd]);
}

/**
 * v9.2.5 — wait until every FINITE animation has finished: the whole
 * document's, or only those under `rootSelector`. An infinite one (a live
 * event's pulsing dot on the Events list, a loading shimmer, a spinner) never
 * finishes, so it is skipped; draining it holds the test until its timeout.
 * Such a drain used to end within 15 s by accident, when the Events list's
 * poll replaced every row and so cancelled the dot's animation; since v9.2.5
 * the list keeps the rows a refresh leaves unchanged. The one way specs drain
 * the document's animations (scanner: functional-core-b Docs hygiene).
 */
async function settleFiniteAnimations(page, rootSelector = null) {
  await page.evaluate((sel) => {
    let anims = [];
    if (!sel) anims = document.getAnimations();
    else { const root = document.querySelector(sel); if (root) anims = root.getAnimations({ subtree: true }); }
    return Promise.all(anims
      .filter((a) => a.effect && Number.isFinite(a.effect.getComputedTiming().endTime))
      .map((a) => a.finished.catch(() => {})));
  }, rootSelector);
}

/**
 * v9.2.14 — wait until the app's own boot-time look read has settled, so a
 * test that then paints the look in place (<html> data-look, data-theme,
 * data-ambient) is the last writer. Boot asks GET /api/settings/appearance
 * without awaiting it (public/js/features/appearance.js loadOrgDefaultLook)
 * and repaints the resolved look when it answers, which can be after
 * <html data-booted="1"> and after the test's paint: PR CI, 24 Nov 2026,
 * tests/css-token-sites.spec.js read the Ice chip under its Cyan paint.
 * S._appearanceSettled turns true once that read has answered and repainted,
 * or failed. Every spec painting the look in place calls this first (scanner:
 * functional-core-b Docs hygiene).
 */
async function appearanceSettled(page, timeout = 20000) {
  await page.waitForFunction(
    () => document.documentElement.getAttribute("data-booted") === "1" && window._appearanceSettled === true,
    null, { timeout },
  ).catch((e) => {
    throw new Error(`the app's own look read (GET /api/settings/appearance) never settled: ${e && e.message}`);
  });
}

/**
 * The precondition a reachability check's trial click assumes: the page is
 * RENDERING, and nothing is still animating this element's box.
 *
 * Playwright's "stable" is two consecutive requestAnimationFrame samples of an
 * equal box, so it counts FRAMES, not time. A freshly launched WebKit (WPE,
 * painted in software in the CI image, at deviceScaleFactor 3 on the iPhone
 * profiles) under CI load paints its first frames up to ~9 s apart while its JS
 * timers stay punctual, and the challenge grid's `.reveal` is started by an
 * IntersectionObserver, which only runs inside a rendering update. So: wait for
 * two frames, then for every FINITE animation on the element, its subtree and
 * its ancestors (the card's `.reveal`, `#modal-box`'s `modal-in`) to finish.
 * Infinite ones never finish and are skipped; the trial click's own stability
 * check still catches a box that never stops moving.
 *
 * Bounded in the page by `ceilingMs` (pass the project's actionTimeout); the
 * result says how many frames were painted and what was still running, so a
 * renderer that never paints fails by name rather than eating the test budget.
 */
async function settleBox(locator, ceilingMs) {
  return locator.evaluate((el, ceiling) => new Promise((resolve) => {
    const t0 = performance.now();
    let frames = 0;
    let pending = null;
    const timer = setTimeout(() => resolve({ ok: false, frames, pending, ms: Math.round(performance.now() - t0) }), ceiling);
    const tick = () => {
      if (++frames < 2) { requestAnimationFrame(tick); return; }
      const anims = [...el.getAnimations({ subtree: true })];
      for (let n = el.parentElement; n; n = n.parentElement) anims.push(...n.getAnimations());
      const finite = anims.filter((a) => a.effect && a.effect.getComputedTiming().endTime !== Infinity);
      pending = finite.map((a) => a.animationName || a.transitionProperty || "animation");
      Promise.all(finite.map((a) => a.finished.catch(() => {}))).then(() => {
        clearTimeout(timer);
        resolve({ ok: true, frames, pending, ms: Math.round(performance.now() - t0) });
      });
    };
    requestAnimationFrame(tick);
  }), ceilingMs);
}

/** Frames the page paints within `ms` (stops counting at 2). Bounded even if the page never answers. */
async function framesPainted(page, ms) {
  const count = page.evaluate((ms) => new Promise((resolve) => {
    let n = 0;
    const timer = setTimeout(() => resolve(n), ms);
    const tick = () => { if (++n >= 2) { clearTimeout(timer); resolve(n); } else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }), ms).catch(() => 0);
  return Promise.race([count, new Promise((r) => setTimeout(() => r(0), ms + 3000))]);
}

/**
 * Playwright's actionability checks without its frame-based wait: visible,
 * enabled, scrolled into view, a box that holds still across 150 ms of TIMERS,
 * and the topmost element at its centre (Playwright's hit check). Null when
 * ready, else why not.
 *
 * Each try scrolls the control with the next of Playwright's own retry
 * alignments (`IN_PAGE_SCROLLS`, its pointer actions' `scrollOptions`), as a
 * covered control is what Playwright retries them for. "nearest" alone leaves a
 * control the page was scrolled past under the sticky header, every try: on a
 * 750×340 phone the workspace opens scrolled 395 px down to the Overview's
 * heading, and its ⋯ button was "covered by profile-menu-btn" until the budget
 * ran out, where Playwright's own click scrolls it clear (CI, 24 Nov 2026).
 */
const IN_PAGE_SCROLLS = [
  { block: "nearest", inline: "nearest" },
  { block: "end", inline: "end" },
  { block: "center", inline: "center" },
  { block: "start", inline: "start" },
];
async function readyWithoutFrames(locator, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let why = "not checked";
  for (let attempt = 0; Date.now() < until; attempt++) {
    why = await locator.evaluate((el, scroll) => new Promise((resolve) => {
      if (el.disabled || el.closest("[aria-disabled=true],fieldset[disabled]")) return resolve("disabled");
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || !el.getClientRects().length) return resolve("not visible");
      el.scrollIntoView({ ...scroll, behavior: "instant" });
      const box = () => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join(","); };
      const before = box();
      setTimeout(() => {
        const after = box();
        if (after !== before) return resolve(`moving (${before} → ${after})`);
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        if (!hit || !(hit === el || el.contains(hit))) return resolve(`covered by ${hit ? (hit.id || hit.tagName) : "nothing"}`);
        resolve(null);
      }, 150);
    }), IN_PAGE_SCROLLS[attempt % IN_PAGE_SCROLLS.length], { timeout: Math.max(1000, until - Date.now()) }).catch((e) => String(e.message).split("\n")[0]);
    if (why === null) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
  return why;
}

/**
 * WEBKIT IN CI CAN STOP PAINTING WHILE THE PAGE IS FINE, and Playwright's
 * "stable" check cannot finish until it paints again.
 *
 * Measured on the CI runner's [webkit] projects (25 Oct 2026; never on a
 * developer machine, even in the pinned image on 2 CPUs): the control visible,
 * enabled and in the same box, nothing animating or loading, the page answering
 * evaluate, and NO frame for 20 s or more. "Stable" is a requestAnimationFrame
 * chain with no timeout of its own, so the click waits out its whole budget; it
 * had failed this way on nearly every CI run since cross-device.spec.js landed,
 * hidden by the retry. Frames seconds apart are ordinary there too (settleBox),
 * so a short gap is no proof of a stall, and nothing found restarts the frames.
 *
 * `mode` is "click", "tap", "trial" or "hover". The action gets 4 s first. If
 * that times out before Playwright dispatched any input (so a second try cannot
 * double-submit):
 *  - the page is painting: it is not this, so try again with what is left of
 *    `fullMs`. A slow page keeps the budget it always had, and a control that
 *    keeps moving still fails.
 *  - no frame in 1 s: run the same checks in the page on timers
 *    (`readyWithoutFrames`), then send the input with `force` (still real mouse
 *    or touch input at the control's centre; a trial sends none), and say so on
 *    stderr, which the CI log shows. A control that is not ready fails by name.
 * If it timed out AFTER the input was sent, the input is never sent again: see
 * `armPressWitness` (a hover, which nothing counts, is treated as not sent).
 * Any other failure is rethrown untouched.
 *
 * A stall outlasts one action, and 4 s per action would spend the test's budget,
 * so the page remembers it: for STALL_MEMORY_MS after one is found, an action
 * whose page still paints nothing in 300 ms goes straight to the checks in the
 * page. Positive evidence twice over: only an action, or a settle, that timed
 * out and then painted nothing for 1 s more marks it.
 */
const STALL_MEMORY_MS = 60000;
const PRESS_FIRST_MS = 4000;
const PRESS_MODES = ["click", "tap", "trial", "hover"];
const stillStalled = async (page) => page.__renderStallAt > Date.now() - STALL_MEMORY_MS && await framesPainted(page, 300) === 0;

// Playwright logs `performing <action> action` just before it sends the input
// and `<action> action done` once the browser has confirmed it. The call log is
// ANSI-coloured, so strip that first.
const _pressLog = (e) => String(e && e.message).replace(/\u001b\[[0-9;]*m/g, "");
const _pressSent = (e) => /performing \w+ action/.test(_pressLog(e));
const _pressNotSent = (e) => e.name === "TimeoutError" && /attempting \w+ action/.test(_pressLog(e)) && !_pressSent(e);
const _pressUnconfirmed = (e) => e.name === "TimeoutError" && _pressSent(e) && !/\w+ action done/.test(_pressLog(e));

/**
 * AN INPUT WEBKIT TOOK BUT NEVER CONFIRMED IS NEVER SENT AGAIN. For a click
 * Playwright sends the move, down and up together (a tap is one message), so
 * once it has logged `performing <action> action` the whole input is queued in
 * the browser, and in a rendering stall the browser can sit on it, or on its
 * confirmation, past the action's timeout (the CI runner's WebKit projects,
 * 14 Nov 2026: clicks timed out after `performing click action`, and one 20 s
 * plain click never came back). Sending it again could press twice. So before
 * each click or tap a witness in the page records the trusted "up" and click
 * events that reach the control, and a press that timed out after sending waits
 * the rest of its budget for one (`pressLanded`): once one has arrived the press
 * is done, said on stderr; if none does, the press fails by name.
 *
 * The press is sent only once its witness is armed, waiting up to half its
 * budget for a busy page to answer (on the runner WebKit took over 500 ms, the
 * old bound, so the press went without a witness, was never confirmed, and failed
 * with Playwright's bare timeout; CI, 16 Nov 2026), and a slow arming is said on
 * stderr. A page that never answers in time gets the press without a witness,
 * and if that is never confirmed it fails by name, never sent again.
 */
const PRESS_LANDING_EVENTS = ["pointerup", "mouseup", "touchend", "click"];

/** The armed witness's id, waiting up to `waitMs` for the page; when it cannot be armed, why, as a string. */
async function armPressWitness(locator, label, mode, waitMs) {
  const t0 = Date.now();
  let timer;
  const arm = locator.evaluate((el, types) => {
    const w = (window.__pressWitness = window.__pressWitness || { next: 0, byId: {} });
    const id = ++w.next;
    const seen = [];
    const onEvent = (e) => { if (e.isTrusted && e.target instanceof Node && el.contains(e.target)) seen.push(e.type); };
    for (const t of types) window.addEventListener(t, onEvent, { capture: true, passive: true });
    w.byId[id] = { seen, off: () => { for (const t of types) window.removeEventListener(t, onEvent, { capture: true }); } };
    for (const k of Object.keys(w.byId)) if (Number(k) <= id - 8) { w.byId[k].off(); delete w.byId[k]; }
    return id;
  }, PRESS_LANDING_EVENTS).catch((e) => _pressLog(e).split("\n")[0] || "it could not be armed");
  const id = await Promise.race([arm, new Promise((r) => { timer = setTimeout(() => r(`the page did not answer in ${Math.round(waitMs / 1000)} s`), waitMs); })]);
  clearTimeout(timer);
  const took = Date.now() - t0;
  if (typeof id === "number" && took > 500) process.stderr.write(`[render-stall] ${label}: the page took ${(took / 1000).toFixed(1)} s to arm the ${mode}'s witness; the ${mode} was sent once it was armed\n`);
  return id;
}

/** What the witness has seen reach the control, asked on timers (the page may not answer) until something has or `budgetMs` runs out. */
async function pressLanded(page, id, budgetMs) {
  const until = Date.now() + budgetMs;
  for (;;) {
    const seen = await Promise.race([
      page.evaluate((id) => { const w = window.__pressWitness; return w && w.byId[id] ? w.byId[id].seen.slice() : null; }, id)
        .catch((e) => String(e.message).split("\n")[0]),
      new Promise((r) => setTimeout(() => r(undefined), Math.max(250, Math.min(1500, until - Date.now())))),
    ]);
    if (Array.isArray(seen) && seen.length) return { seen };
    if (seen === null) return { seen: null, why: "its witness is gone: the page was replaced" };
    const why = Array.isArray(seen) ? "nothing reached it" : typeof seen === "string" ? seen : "the page did not answer";
    if (Date.now() + 250 >= until) return { seen: null, why };
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function awaitLanding(locator, label, mode, witness, budgetMs, e) {
  if (witness === null) throw e;
  if (typeof witness === "string") throw new Error(`${label}: the ${mode} was sent and the browser never confirmed it, and its witness was never armed (${witness}), so nothing can tell whether it arrived; it is not sent again\n${e.message}`);
  const page = locator.page();
  const r = await pressLanded(page, witness, budgetMs);
  if (!r.seen) throw new Error(`${label}: the ${mode} was sent and the browser never confirmed it, and in ${Math.round(budgetMs / 1000)} s more it never reached the control (${r.why}); it is not sent again\n${e.message}`);
  if (await framesPainted(page, 1000) === 0) page.__renderStallAt = Date.now();
  process.stderr.write(`[render-stall] ${label}: the ${mode} was sent and the browser never confirmed it; the control received it (${r.seen.join(", ")}), so it is not sent again\n`);
}

async function pressInPage(locator, label, mode, budgetMs, cause) {
  locator.page().__renderStallAt = Date.now();
  const why = await readyWithoutFrames(locator, budgetMs);
  if (why) throw new Error(`${label}: the browser painted no frame and the control is not ready: ${why}${cause ? `\n${cause}` : ""}`);
  process.stderr.write(`[render-stall] ${label}: no frame painted; checked in the page${mode === "trial" ? "" : `, then a forced ${mode}`}\n`);
  if (mode === "trial") return;
  const s0 = Date.now();
  const rest = () => Math.max(1000, budgetMs - (Date.now() - s0));
  const witness = mode === "hover" ? null : await armPressWitness(locator, label, mode, budgetMs / 2);
  const send = (timeout) => (mode === "tap" ? locator.tap({ timeout, force: true }) : mode === "hover" ? locator.hover({ timeout, force: true }) : locator.click({ timeout, force: true }));
  try {
    await send(Math.min(PRESS_FIRST_MS, rest()));
  } catch (e) {
    if (mode !== "hover" && _pressUnconfirmed(e)) return awaitLanding(locator, label, mode, witness, rest(), e);
    if (!_pressNotSent(e) && !(mode === "hover" && _pressUnconfirmed(e))) throw e;
    await send(rest());
  }
}

async function pressThroughRenderStall(locator, label, mode, fullMs) {
  if (!PRESS_MODES.includes(mode)) throw new Error(`pressThroughRenderStall: unknown mode ${JSON.stringify(mode)}`);
  const page = locator.page();
  if (await stillStalled(page)) return pressInPage(locator, label, mode, Math.max(5000, fullMs), null);
  const t0 = Date.now();
  const left = () => Math.max(1000, fullMs - (Date.now() - t0));
  const witness = mode === "click" || mode === "tap" ? await armPressWitness(locator, label, mode, fullMs / 2) : null;
  const act = (timeout) => (mode === "tap" ? locator.tap({ timeout }) : mode === "hover" ? locator.hover({ timeout }) : locator.click({ timeout, trial: mode === "trial" }));
  // A press sent and never confirmed is waited for; anything else is rethrown.
  const landed = (e) => {
    if (mode !== "hover" && _pressUnconfirmed(e)) return awaitLanding(locator, label, mode, witness, left(), e);
    throw e;
  };
  try {
    return await act(Math.min(PRESS_FIRST_MS, left()));
  } catch (e) {
    // A trial sends real input too, which its hit-target interceptor blocks in
    // the page (CI, 14 Nov 2026: a trial timed out after `performing click
    // action`). Its question is the in-page checks' own, so they answer it and
    // nothing is sent again.
    if (mode === "trial" && _pressUnconfirmed(e)) {
      process.stderr.write(`[render-stall] ${label}: the trial was sent and the browser never confirmed it; checking in the page instead\n`);
      return pressInPage(locator, label, mode, Math.max(5000, left()), e.message);
    }
    if (!_pressNotSent(e) && !(mode === "hover" && _pressUnconfirmed(e))) return landed(e);
    if (await framesPainted(page, 1000) > 0) return act(left()).catch(landed);
    return pressInPage(locator, label, mode, Math.max(5000, left()), e.message);
  }
}

/**
 * `settleBox` through the same stall. Animations only advance when the page
 * paints, so while it paints nothing their wait cannot end and is skipped (said
 * on stderr); the in-page checks that follow still require a box that holds
 * still. `settleBox` gets 4 s first, then, if the page is painting, the rest of
 * `ceilingMs`, as it always had.
 */
async function settleThroughRenderStall(locator, label, ceilingMs) {
  const page = locator.page();
  const skip = () => { process.stderr.write(`[render-stall] ${label}: no frame painted; not waiting for animations\n`); return { ok: true, frames: 0, pending: [], ms: 0, skipped: true }; };
  if (await stillStalled(page)) return skip();
  const t0 = Date.now();
  const first = await settleBox(locator, Math.min(4000, ceilingMs));
  if (first.ok) return first;
  if (await framesPainted(page, 1000) === 0) { page.__renderStallAt = Date.now(); return skip(); }
  return settleBox(locator, Math.max(1000, ceilingMs - (Date.now() - t0)));
}

/**
 * Whether the page itself has fired `DOMContentLoaded`, read from its own
 * Navigation Timing record; never from `document.readyState`, which turns
 * "interactive" before the deferred and module scripts run (the app boots in
 * one). Bounded even if the page never answers.
 */
async function _contentLoadedInPage(page, ms) {
  const read = page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const end = nav ? nav.domContentLoadedEventEnd : performance.timing.domContentLoadedEventEnd;
    return { fired: end > 0, state: `readyState "${document.readyState}", DOMContentLoaded ${end > 0 ? "fired" : "not fired"}` };
  }).catch((e) => ({ fired: false, state: `no answer (${String(e && e.message).split("\n")[0]})` }));
  return Promise.race([read, new Promise((r) => setTimeout(() => r({ fired: false, state: `no answer in ${ms} ms` }), ms))]);
}

/**
 * `page.goto(url)` through the same stall. A navigation in such a stall can
 * parse the document and run the app while the test never hears its events:
 * `load` (measured twice in the pinned CI image: a WebKit device project's
 * `page.goto("/")` spent its 30 s waiting for it, then passed on its retry) and
 * `domcontentloaded` too (a tablet WebKit `page.goto("/register")` spent its
 * 30 s waiting for that, in a run whose other WebKit projects were stalling).
 * The cross specs need neither event itself: each waits next for the app's own
 * marker. So the navigation waits for the document to commit: a third of
 * `fullMs` (10 s at most), then, said on stderr, it is sent once more for the
 * rest (a fresh WebKit page's first navigation sat uncommitted for all 30 s on
 * the runner, then passed on its retry; the page cannot be asked meanwhile, as
 * an evaluate waits for the pending navigation; every page the cross specs
 * open is a GET, safe to load twice). Then it gives
 * `domcontentloaded` 4 s and asks the page: one that has already fired it
 * goes on from the parsed document, said on stderr and remembered as a stall
 * for the actions that follow; one that has not is waited for, by the page's
 * own record, for the rest of `fullMs`, and fails naming what the page
 * reported. Then `load` gets 4 s; if the page is painting, the rest of
 * `fullMs`, as it always had, and a page that never finishes loading still
 * fails. Only a page that also painted nothing for 1 s more is let through
 * without it, said on stderr, and remembered as a stall.
 */
async function gotoThroughRenderStall(page, url, label, fullMs = 30000) {
  const t0 = Date.now();
  const left = () => Math.max(1000, fullMs - (Date.now() - t0));
  const name = label || `goto ${url}`;
  const firstMs = Math.min(10000, Math.floor(fullMs / 3));
  let resp;
  try {
    resp = await page.goto(url, { waitUntil: "commit", timeout: firstMs });
  } catch (e) {
    if (e.name !== "TimeoutError") throw e;
    const sees = page.url();
    process.stderr.write(`[render-stall] ${name}: the navigation had not committed in ${firstMs} ms (the test still sees ${sees}); sending it once more\n`);
    try {
      resp = await page.goto(url, { waitUntil: "commit", timeout: left() });
    } catch (e2) {
      // Chromium can answer the second send itself as cancelled (its own
      // `net::ERR_ABORTED`, seen on the CI runner): not committed either. The
      // rest of the budget is waited out for a commit that may still land, then
      // the same named failure; never a third send.
      const cancelled = e2.name !== "TimeoutError" && /\bnet::ERR_ABORTED\b/.test(String(e2 && e2.message));
      if (e2.name !== "TimeoutError" && !cancelled) throw e2;
      if (!cancelled || !(await page.waitForURL(url, { waitUntil: "commit", timeout: left() }).then(() => true, () => false))) {
        throw new Error(`${name}: the navigation never committed in ${fullMs} ms, sent twice (the test still saw ${sees} after the first)`);
      }
      resp = null;
    }
  }
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: Math.min(4000, left()) });
  } catch (e) {
    if (e.name !== "TimeoutError") throw e;
    let seen = await _contentLoadedInPage(page, 2000);
    if (seen.fired) {
      page.__renderStallAt = Date.now();
      process.stderr.write(`[render-stall] ${name}: the page fired domcontentloaded and the test never heard it; going on from the parsed document\n`);
      return resp;
    }
    while (!seen.fired && Date.now() - t0 < fullMs) {
      await new Promise((r) => setTimeout(r, 250));
      seen = await _contentLoadedInPage(page, Math.min(2000, left()));
    }
    if (!seen.fired) throw new Error(`${name}: domcontentloaded never fired in ${fullMs} ms (the page reports ${seen.state})`);
  }
  try {
    await page.waitForLoadState("load", { timeout: Math.min(4000, left()) });
  } catch (e) {
    if (e.name !== "TimeoutError") throw e;
    if (await framesPainted(page, 1000) > 0) await page.waitForLoadState("load", { timeout: left() });
    else {
      page.__renderStallAt = Date.now();
      process.stderr.write(`[render-stall] ${name}: no frame painted and no load event; going on from the parsed document\n`);
    }
  }
  return resp;
}

module.exports = {
  settleFiniteAnimations,
  appearanceSettled,
  gotoThroughRenderStall,
  pressThroughRenderStall,
  settleThroughRenderStall,
  awaitUploadRoom,
  zipOf,
  waitForAdminPage,
  serverLogTail,
  createClient,
  gradingHashFor,
  freshCtx: defaultClient.freshCtx,
  apiLogin: defaultClient.apiLogin,
  codeLogin,
  registerPost,
  entryCode,
  seedTestData: defaultClient.seedTestData,
  getSuperadminPass: defaultClient.getSuperadminPass,
  // v7.22.0 — shared with the browser-side loginViaApi helpers so a 401 names
  // its cause wherever it happens, not only on the apiLogin path.
  describeAccountState: defaultClient.describeAccountState,
  BASE: defaultClient.baseUrl,
  TEST_DB_PATH: defaultClient.dbPath,
  TEST_DATA_DIR: defaultClient.dataDir,
  PARTICIPANT_PASS,
  PORT_BASE,
  makePng,
  pngDataUri,
  findLogLine,
  pollAdminLogs,
};
