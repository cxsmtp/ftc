// @ts-check
//
// v8.13.4 — A REFUSED CSRF TOKEN ENDS EVERY SESSION THAT CARRIES AN IDENTITY.
//
// Operator decision 4: "CSRF failure should also end the built-in superadmin
// session as it does for other users". The EBADCSRFTOKEN handler (server.js) has
// destroyed a session signed in to a USER account since v8.3.13, keyed on
// `req.session.userId` — and the built-in superadmin has no user row
// (`builtinId`, no `userId`), so its session survived a refused token. Before
// v8.3.13 the destroy was UNCONDITIONAL, so this is not a new policy: it makes
// the code say what v8.3.13's own comment said ("destroy only an AUTHENTICATED
// session"), which the userId-only test did not.
//
// WHAT A SUPERADMIN SAW. The SPA's interceptor shows "Signed out" on any
// `csrf_invalid` and posts a logout with the SAME stale token, which is refused
// too — so for the built-in account the dialog was false and the reload put it
// straight back into the admin panel. The UI half lives in
// csrf-session-end-ui.spec.js.
//
// AND A LIVE DEFECT IN THE SAME LINE. Every impersonation session carries
// `userId` (it is the TARGET's id), so a refused token destroyed it — with no
// `impersonation_ended`, against the v7.15.11 rule that any path destroying a
// session closes the window first. The target's History kept an
// `impersonation_started` that never ended. (D) and (E) are its locks.
//
// THE AUDIT. The end of an identity-bearing session is recorded as
// `sessions_invalidated {reason:"csrf_invalid"}`, `changed_by:"system"` (the
// failed token is exactly what did NOT prove who sent it), with the request's
// IP/UA/req_id — on the session's OWNER: the user row; an orphaned `session`
// line for the built-in superadmin; under impersonation the ACTING admin, never
// the target. An ANONYMOUS refusal is kept and records nothing — auditing it
// would let an unauthenticated caller drive unbounded audit writes.
//
// Every test owns its participants (registered here, found with ?limit=5000 —
// `?search=` is a no-op on that endpoint). The built-in superadmin is single
// session, so each test signs it in afresh rather than sharing a context that a
// later test's sign-in would purge.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const { apiLogin, freshCtx, PARTICIPANT_PASS, BASE, TEST_DATA_DIR, findLogLine } = require("./helpers");
const { H, makeParticipant } = require("./event-admin-helpers");
const { stripJsComments } = require("./doc-registry");

test.use({ baseURL: BASE });

const LOGS = path.join(TEST_DATA_DIR, "logs");
const ROOT = path.join(__dirname, "..");
const BAD = "definitely-not-the-token";

/** A refused keepalive. Only the EBADCSRFTOKEN handler answers `csrf_invalid`. */
async function refusedKeepalive(api) {
  const r = await api.post("/api/session/keepalive", { headers: H(BAD), data: {} });
  expect(r.status(), "the stale token is refused").toBe(403);
  expect((await r.json()).error, "by the CSRF handler").toBe("csrf_invalid");
  const reqId = r.headers()["x-request-id"];
  expect(reqId, "the refusal carries its request id — the key the audit row is found by").toBeTruthy();
  return reqId;
}

async function eventsOf(sa, userId) {
  const r = await sa.get(`/api/admin/participants/${userId}/events?limit=200`);
  expect(r.ok(), `events of ${userId}: ${r.status()}`).toBeTruthy();
  const j = await r.json();
  return Array.isArray(j) ? j : (j.events || []);
}

/** A regular admin, promoted BEFORE anyone signs in as them (a role change purges sessions). */
async function makeAdmin(sa, saCsrf, label) {
  const p = await makeParticipant(sa, saCsrf, label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
  expect(r.ok(), `promote ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return p;
}

/** Every audit line in the newest app log, synchronously — for an ABSENCE check behind a barrier. */
function auditLinesNow() {
  const files = fs.readdirSync(LOGS).filter(f => f.startsWith("app-") && f.endsWith(".jsonl")).sort();
  if (!files.length) return [];
  return fs.readFileSync(path.join(LOGS, files[files.length - 1]), "utf8").split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(j => j && j.source === "audit");
}

test.describe("v8.13.4 — a refused CSRF token ends every signed-in session", () => {

  test("(A) the BUILT-IN superadmin's session ends, and the end is recorded on an orphaned session line", async () => {
    // The anonymous refusal goes FIRST: it must record nothing, and the
    // built-in's row below is the barrier that proves the mirror has drained
    // past it (the mirror is a FIFO of setImmediate callbacks).
    const { api: anon } = await freshCtx();
    let anonReqId;
    try { anonReqId = await refusedKeepalive(anon); } finally { await anon.dispose(); }

    const { api, csrf } = await apiLogin("superadmin");
    try {
      expect((await api.get("/api/admin/me")).status(),
        "PRECONDITION: signed in as the built-in superadmin").toBe(200);

      const reqId = await refusedKeepalive(api);

      // PRE-v8.13.4 this stayed 200: the handler keyed on userId, which the
      // built-in account does not have.
      expect((await api.get("/api/admin/me")).status(), "the built-in superadmin's session is gone").toBe(401);
      const st = await (await api.get("/api/session/status")).json();
      expect(st.active, "and the session monitor agrees").toBe(false);
      // The token that WAS good is refused now — the session it was bound to no
      // longer exists, so this is a fresh anonymous session meeting a stranger's token.
      const again = await api.post("/api/session/keepalive", { headers: H(csrf), data: {} });
      expect(again.status(), "the old good token died with its session").toBe(403);

      const row = await findLogLine(LOGS,
        j => j.source === "audit" && j.event_type === "sessions_invalidated" && j.req_id === reqId,
        { what: `the sessions_invalidated audit row for request ${reqId}` });
      expect(row.scope, "no user row exists, so it is an orphaned session-scope line").toBe("session");
      expect(row.changed_by, "the refused token proved nobody's identity").toBe("system");
      expect(row.details.reason).toBe("csrf_invalid");
      expect(row.details.principal, "it names whose session ended").toBe("superadmin");
      expect(row.ip, "with the source IP (v7.21.32)").toBeTruthy();

      // THE ABSENCE, behind the barrier above: the anonymous refusal wrote nothing.
      expect(auditLinesNow().filter(j => j.req_id === anonReqId),
        "an ANONYMOUS refusal is never audited — that would let a stranger drive audit writes").toEqual([]);

      // The access line for the refused request still names who sent it. The
      // destroy deletes req.session synchronously, before the logger's `finish`
      // hook reads it, so without the handler's stash this line was anonymous.
      const acc = await findLogLine(LOGS, j => j.req_id === reqId && j.status === 403,
        { prefix: "access-", what: `the access line for request ${reqId}` });
      expect(acc.user_id, "the access line keeps the actor the destroy took away").toBe("superadmin");
    } finally { await api.dispose(); }
  });

  test("(B) a USER account's session ends — as it always did — and now the end is recorded on its row", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    try {
      const p = await makeParticipant(sa, saCsrf, "csrfend-user");
      const { api: pc } = await apiLogin(p.email, PARTICIPANT_PASS);
      try {
        expect((await pc.get("/api/me")).status(), "PRECONDITION: signed in").toBe(200);
        const reqId = await refusedKeepalive(pc);
        expect((await pc.get("/api/me")).status(), "the session is gone").toBe(401);
      } finally { await pc.dispose(); }

      const evs = (await eventsOf(sa, p.id)).filter(e => e.event_type === "sessions_invalidated");
      expect(evs.length, "exactly one end recorded on the participant's own row").toBe(1);
      const ev = evs[0];
      expect(ev.details.reason).toBe("csrf_invalid");
      expect(ev.changed_by).toBe("system");
      expect(ev.details.ip, "with the source IP").toBeTruthy();
      expect(ev.details.req_id, "and the request it came from").toBeTruthy();
      expect(ev.details.impersonated_by, "no impersonation was involved").toBeUndefined();
    } finally { await sa.dispose(); }
  });

  test("(C) CONTROL: an ANONYMOUS session SURVIVES a refused token, and its original token still works", async () => {
    // v8.3.13 recorded this half as DEFENCE IN DEPTH: its lock refreshed the
    // token after the refusal, and a client that accepts Set-Cookie simply gets
    // a NEW session that way, so an unconditional destroy left it green. Reusing
    // the ORIGINAL token is what separates the two — only the SAME session
    // accepts it.
    const { api: anon, csrf: first } = await freshCtx();
    try {
      await refusedKeepalive(anon);
      const ok = await anon.post("/api/login", { headers: H(first), data: { email: "nobody@nowhere.test", password: "wrong" } });
      expect(ok.status(),
        "past the CSRF gate with the token minted BEFORE the refusal — 401 is the credential, which is the point").toBe(401);
      const second = (await (await anon.get("/api/csrf-token")).json()).csrfToken;
      expect(second, "the surviving session hands back the token it already holds").toBe(first);
    } finally { await anon.dispose(); }
  });

  test("(D) the built-in superadmin IMPERSONATING: the window is closed on the target, the end recorded for the actor", async () => {
    const { api: sa0, csrf: c0 } = await apiLogin("superadmin");
    let target, reqId;
    try {
      target = await makeParticipant(sa0, c0, "csrfend-imp-sa");
      const imp = await sa0.post(`/api/admin/participants/${target.id}/impersonate`, { headers: H(c0) });
      expect(imp.ok(), `impersonate: ${imp.status()} ${await imp.text()}`).toBeTruthy();
      const me = await (await sa0.get("/api/me")).json();
      expect(me.impersonation && me.impersonation.active, "PRECONDITION: impersonating").toBe(true);

      reqId = await refusedKeepalive(sa0);
      expect((await sa0.get("/api/me")).status(), "the impersonation session is gone").toBe(401);
      expect((await sa0.get("/api/admin/me")).status(), "and there is no admin session to fall back to").toBe(401);
    } finally { await sa0.dispose(); }

    const { api: sa } = await apiLogin("superadmin");
    try {
      const evs = await eventsOf(sa, target.id);
      const started = evs.filter(e => e.event_type === "impersonation_started");
      const ended = evs.filter(e => e.event_type === "impersonation_ended");
      expect(started.length, "PRECONDITION: one window was opened").toBe(1);
      // PRE-v8.13.4: zero — the session was destroyed with the window left open.
      expect(ended.length, "the window is CLOSED, exactly once").toBe(1);
      expect(ended[0].details.reason).toBe("csrf_invalid");
      expect(ended[0].changed_by, "attributed to the acting admin").toBe("superadmin");
      expect(typeof ended[0].details.duration_ms, "with its duration").toBe("number");
      expect(ended[0].details.req_id, "by the refused request").toBe(reqId);
      expect(evs.filter(e => e.event_type === "sessions_invalidated" || e.event_type === "logout_manual"),
        "and NOTHING else on the target's row — the session was the admin's, not theirs").toEqual([]);

      const row = await findLogLine(LOGS,
        j => j.source === "audit" && j.event_type === "sessions_invalidated" && j.req_id === reqId,
        { what: `the actor's sessions_invalidated row for request ${reqId}` });
      expect(row.scope, "the built-in impersonator has no user row").toBe("session");
      expect(row.details.reason).toBe("csrf_invalid");
      expect(row.details.principal).toBe("superadmin");
      expect(row.impersonated_by, "the owner's own row does not name them as their own impersonator").toBeUndefined();
      expect(row.acting_as, "but it does say whose seat they were in").toBe(target.email);
    } finally { await sa.dispose(); }
  });

  test("(E) a USER-backed regular admin IMPERSONATING: the target's window closes, the admin's own row records the end", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    try {
      const target = await makeParticipant(sa, saCsrf, "csrfend-imp-tgt");
      const adm = await makeAdmin(sa, saCsrf, "csrfend-imp-adm");
      const { api: ac, csrf: acCsrf } = await apiLogin(adm.email, PARTICIPANT_PASS);
      let reqId;
      try {
        const imp = await ac.post(`/api/admin/participants/${target.id}/impersonate`, { headers: H(acCsrf) });
        expect(imp.ok(), `impersonate: ${imp.status()} ${await imp.text()}`).toBeTruthy();
        reqId = await refusedKeepalive(ac);
        expect((await ac.get("/api/me")).status(), "the impersonation session is gone").toBe(401);
      } finally { await ac.dispose(); }

      const tEvs = await eventsOf(sa, target.id);
      const ended = tEvs.filter(e => e.event_type === "impersonation_ended");
      expect(ended.length, "the target's window is closed, exactly once").toBe(1);
      expect(ended[0].details.reason).toBe("csrf_invalid");
      expect(ended[0].changed_by, "attributed to the acting admin").toBe(adm.email);
      expect(tEvs.filter(e => e.event_type === "sessions_invalidated"),
        "the TARGET's row carries no session end — it was never their session").toEqual([]);

      const aEvs = (await eventsOf(sa, adm.id))
        .filter(e => e.event_type === "sessions_invalidated" && e.details && e.details.reason === "csrf_invalid");
      expect(aEvs.length, "the ADMIN's own row records the end of their session").toBe(1);
      expect(aEvs[0].changed_by).toBe("system");
      expect(aEvs[0].details.req_id).toBe(reqId);
      expect(aEvs[0].details.impersonated_by,
        "not 'system (impersonated by <themselves>)' in their own History").toBeUndefined();
      expect(aEvs[0].details.acting_as, "and whose seat they were in").toBe(target.email);
    } finally { await sa.dispose(); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EVERY REASON A WINDOW CAN CLOSE FOR HAS WORDS IN HISTORY.
//
// `impersonation_ended` renders through a `why` map in history.js, and a reason
// it does not know falls to a raw `ended (<code>)`. Three reasons — `login`,
// `linkedin_callback` and `password_reset` — had shipped with no words, which is
// the shape a new reason takes the day it is added unless something says so.
// A DECISION per site: every literal reason handed to `impersonationEndedDetails(`
// or to `_closeImpersonationWindowOnSessionReplace(` must have a key; a call
// whose reason this cannot read FAILS, except the closer's own pass-through.
// Comments are stripped first — the notes beside these calls quote them.
// ─────────────────────────────────────────────────────────────────────────────
test("every impersonation_ended reason the server can record has a History label", () => {
  const files = ["server.js",
    ...fs.readdirSync(path.join(ROOT, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`),
    ...fs.readdirSync(path.join(ROOT, "lib")).filter(f => f.endsWith(".js")).map(f => `lib/${f}`)];
  const reasons = new Map();   // reason → [file, …]
  const unreadable = [];
  let sites = 0;
  for (const rel of files) {
    const src = stripJsComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
    for (const m of src.matchAll(/impersonationEndedDetails\(([^)]*)\)/g)) {
      if (/^\s*imp\s*,\s*reason\s*$/.test(m[1]) && rel === "server.js") continue;   // the closer's pass-through
      if (/^\s*imp\s*,\s*reason\s*$/.test(m[1]) && rel === "lib/impersonation.js") continue;  // the definition
      const lit = m[1].match(/,\s*"([a-z_]+)"\s*$/);
      if (!lit) { unreadable.push(`${rel}: impersonationEndedDetails(${m[1]})`); continue; }
      sites++;
      reasons.set(lit[1], [...(reasons.get(lit[1]) || []), rel]);
    }
    for (const m of src.matchAll(/_closeImpersonationWindowOnSessionReplace\(([^)]*)\)/g)) {
      if (/^\s*req\s*,\s*reason\s*$/.test(m[1])) continue;   // the definition's own parameter list
      const lit = m[1].match(/^\s*req\s*,\s*"([a-z_]+)"\s*$/);
      if (!lit) { unreadable.push(`${rel}: _closeImpersonationWindowOnSessionReplace(${m[1]})`); continue; }
      sites++;
      reasons.set(lit[1], [...(reasons.get(lit[1]) || []), rel]);
    }
  }
  expect(unreadable, "a reason this scan cannot read is a reason nobody decided the words for").toEqual([]);

  const hist = stripJsComments(fs.readFileSync(path.join(ROOT, "public/js/features/history.js"), "utf8"));
  const at = hist.indexOf("case 'impersonation_ended':");
  expect(at, "the impersonation_ended renderer still exists").toBeGreaterThan(-1);
  const open = hist.indexOf("{", hist.indexOf("const why=", at));
  expect(open, "and still holds a `why` map").toBeGreaterThan(at);
  let depth = 0, end = open;
  for (; end < hist.length; end++) {
    if (hist[end] === "{") depth++;
    else if (hist[end] === "}" && --depth === 0) break;
  }
  const body = hist.slice(open + 1, end).replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
  const keys = new Set([...body.matchAll(/\b([a-z_]+)\s*:/g)].map(m => m[1]));

  const missing = [...reasons.keys()].filter(r => !keys.has(r)).map(r => `${r} (${reasons.get(r).join(", ")})`);
  expect(missing, "every reason the server records needs words in the History dialog").toEqual([]);
  // ANTI-VACUITY: eight reasons over ten literal sites (the four forced-exit
  // copies of `target_inactive` are one helper, `restoreImpersonationTargetInactive`;
  // the password-change and LinkedIn sign-in closes left with those doors).
  // A renamed helper would empty both matches and pass in silence.
  expect(reasons.size, "the scan still finds the reasons").toBeGreaterThanOrEqual(8);
  expect(sites, "and the sites").toBeGreaterThanOrEqual(10);
  expect(reasons.get("target_inactive"), "the forced exit's one copy").toEqual(["lib/impersonation.js"]);
  expect(reasons.has("csrf_invalid"), "including the refused token's own").toBe(true);
});

// The double-close guard is DEFENCE IN DEPTH and is pinned here rather than
// claimed: two refused requests on one impersonation session in flight at once
// cannot be scheduled from a test. A session already purged elsewhere has had
// its window closed by whatever purged it, so the handler records nothing twice.
test("the CSRF handler skips its audit for a session already purged elsewhere (source pin)", () => {
  const src = stripJsComments(fs.readFileSync(path.join(ROOT, "server.js"), "utf8"));
  const at = src.indexOf('err.code === "EBADCSRFTOKEN"');
  expect(at, "the handler exists").toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf('error: "csrf_invalid"', at));
  expect(body, "identity is asked through the one shared predicate").toMatch(/_sessionHasIdentity\(/);
  expect(body, "the audit is skipped for an already-purged session").toMatch(/!wasSessionPurged\(req\.sessionID\)/);
  const ctx = body.search(/=\s*reqContext\(req\)/);
  const close = body.indexOf('_closeImpersonationWindowOnSessionReplace(req, "csrf_invalid")');
  const destroy = body.search(/\.destroy\(/);
  expect(ctx, "the request context is read").toBeGreaterThan(-1);
  expect(close, "the window is closed").toBeGreaterThan(-1);
  expect(destroy, "and the session destroyed").toBeGreaterThan(-1);
  expect(ctx < destroy && close < destroy,
    "BOTH before the destroy, which deletes req.session synchronously").toBe(true);
  // And in the order the handler reasons in: the identity question first, then
  // the purged-session guard, and the audit work INSIDE that guard (the
  // pre-release review — the first draft pinned presence, not position).
  const ident = body.search(/_sessionHasIdentity\(/);
  const guard = body.search(/!wasSessionPurged\(req\.sessionID\)/);
  expect(ident < guard && guard < ctx && guard < close,
    "identity, then the purged guard, then the context read and the window close").toBe(true);
  // CONTAINMENT, not just order (the fix-delta review: a guard that wrapped
  // nothing, with the audit after it, passed the order checks above). The
  // guard's own block is brace-matched — string literals stepped over — and must
  // hold the window close and every sessions_invalidated emit; and the context
  // read must sit inside the block's `try`, so a throw reading it costs the
  // audit row and never the session end.
  const blockOf = (text, from) => {
    const open = text.indexOf("{", from);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (c === '"' || c === "'" || c === "`") { const q = c; i++; while (i < text.length && text[i] !== q) { if (text[i] === "\\") i++; i++; } continue; }
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return text.slice(open, i + 1);
    }
    return "";
  };
  const guarded = blockOf(body, guard);
  expect(guarded.length, "the purged-session guard opens a block").toBeGreaterThan(2);
  expect(guarded, "the window close is INSIDE the guard").toContain('_closeImpersonationWindowOnSessionReplace(req, "csrf_invalid")');
  expect((body.match(/"sessions_invalidated"/g) || []).length, "anti-vacuity: the handler emits the audit row").toBeGreaterThan(0);
  expect((guarded.match(/"sessions_invalidated"/g) || []).length,
    "every sessions_invalidated emit is INSIDE the guard").toBe((body.match(/"sessions_invalidated"/g) || []).length);
  expect(guarded, "the destroy is NOT inside the guard — the session ends whatever the audit did").not.toMatch(/\.destroy\(/);
  const tryAt = guarded.search(/\btry\s*\{/);
  expect(tryAt, "the guard's work runs in a try").toBeGreaterThan(-1);
  expect(blockOf(guarded, tryAt), "the request context is read INSIDE the try").toMatch(/=\s*reqContext\(req\)/);
});
