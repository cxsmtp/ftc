// @ts-check
//
// THE SIGN-IN STORM FIXES (perf/RESULTS.md, "1000-user sign-in storm").
//
// A 3000-person event start collapsed the one Node thread; the CPU profile named
// the work, and these are the changes that removed it. Each is meant to be
// invisible to a client, so each lock below asserts the CONTRACT the change must
// keep, with a control:
//
//   1. Frozen assets (server.js `_sendFrozenAsset`): the shell, stylesheet and JS
//      bundle are encoded, hashed and compressed ONCE. A client must still get
//      the same bytes for every encoding it accepts, the same ETag, Vary, a 304
//      on a matching If-None-Match and no encoding on HEAD (compression()'s own
//      rule). The identity response is the control the decoded bodies are
//      compared against.
//   2. Entrant coalescing (lib/leaderboard.js `invalidateLeaderboardCacheForEntrant`):
//      a first entry no longer rebuilds the board on the next read. A new entrant
//      must still appear within the coalesce window, and a SCORE change must
//      still invalidate at once — even on a board built a moment ago, which is
//      exactly when a coalesced bust would have kept it.
//   3. The prepared-statement memo (db.js): one SQL text yields one Statement,
//      a mode a caller set does not leak to the next caller, and a statement
//      mid-iterate is never handed out (the caller gets a fresh compile).
//   4. The sign-in lookups are indexed (perf/RESULTS.md, "3000-user sign-in
//      storm — FINAL"): the account by address (lib/account-lookup.js) and a
//      user's session rows (lib/session-index.js). The LOWER(email) and
//      `data LIKE` forms scanned the whole table per sign-in, O(N²) in a rush.
//      Locked by query plan (an index SEARCH, never a SCAN), by the SQL the real
//      code paths actually prepare, and by behaviour: the same rows as before,
//      including the impersonation ownership rule, with negative controls. Off
//      the sign-in path the same holds for Raw logs' actor names (a LIST of
//      primary addresses, lib/account-lookup.js `findUsersByPrimaryList`), the
//      event team's opted-out test (lib/event-team.js `UNSUBSCRIBED_IN_LIST_SQL`),
//      a person export's invitations (lib/full-export.js `PERSON_INVITATIONS_SQL`)
//      and the Checkmarx One address-holder check (lib/cxone-withdraw.js
//      `ADDRESS_HOLDERS_SQL`): each the EXPORTED statement, planned and run.
//   5. The WALK-UP door (sweep finding #24): every sign-up asks whether its
//      address is taken (lib/email-identity.js `emailIsTaken`) at the request,
//      the redeem and the form, and a join busts the board. The address check is
//      three point lookups, each an index search, with the old answers; a
//      newcomer's join takes the coalesced entrant bust (the board's version
//      does not move), while a rejoin bringing points back still busts outright.
//   6. The break-glass name check (lib/settings.js `breakglassNameHeldByAccount`,
//      asked by every attempt naming the current username) and the event team
//      report's possible-duplicate candidates (lib/event-team.js
//      `DUP_CANDIDATES_SQL`, asked by every report read) are index searches.
//   7. The bulk invitation's live-invitation lookup (routes/invitations.js
//      `LIVE_INVITATION_SQL`, asked once per invited address by the re-invite
//      merge and by the race loser's re-read) is a search of the partial
//      uq_invitations_live_email index at BOTH sites, with the old answer: an
//      invitation stored in another case is still found. The route runs in a
//      child (a stub `app` collects its handler), which also lands the racing
//      row the second site exists for; a server arm shows the merge end to end.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, freshCtx, gradingHashFor, TEST_DB_PATH } = require("./helpers");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

test("frozen assets: every accepted encoding decodes to the identity bytes, with one ETag, Vary, 304 and an unencoded HEAD", async () => {
  const { api } = await freshCtx();
  try {
    const shell = await api.get("/", { headers: { "accept-encoding": "identity" } });
    expect(shell.status()).toBe(200);
    const html = await shell.text();
    const js = (/src="(\/js\/core\/main\.js\?v=[^"]+)"/.exec(html) || [])[1];
    const css = (/href="(\/styles\.css\?v=[^"]+)"/.exec(html) || [])[1];
    expect(css, "the shell links the versioned stylesheet").toBeTruthy();
    // The JS bundle is served from the frozen cache only when the server bundles
    // (MINIFY_JS=1); in the raw-module mode the shell links no bundle and that
    // middleware is never reached, so it is covered where it runs.
    const paths = ["/", "/register", css, ...(js && process.env.MINIFY_JS === "1" ? [js] : [])];
    for (const p of paths) {
      const plain = await api.get(p, { headers: { "accept-encoding": "identity" } });
      expect(plain.status(), p).toBe(200);
      const body = await plain.body();
      const etag = plain.headers()["etag"];
      expect(plain.headers()["content-encoding"], `${p}: identity is not encoded (the control)`).toBeUndefined();
      expect(etag, `${p}: an ETag`).toMatch(/^W\/"/);
      expect(plain.headers()["vary"] || "", `${p}: Vary names Accept-Encoding`).toMatch(/accept-encoding/i);
      expect(body.length, `${p}: a real body`).toBeGreaterThan(1024);
      for (const [enc, want] of [["gzip", "gzip"], ["br", "br"], ["gzip, deflate, br", "br"]]) {
        const r = await api.get(p, { headers: { "accept-encoding": enc } });
        expect(r.headers()["content-encoding"], `${p} with ${enc}`).toBe(want);
        expect(r.headers()["etag"], `${p} with ${enc}: same ETag`).toBe(etag);
        expect((await r.body()).equals(body), `${p} with ${enc}: decodes to the identity bytes`).toBe(true);
      }
      const nm = await api.get(p, { headers: { "if-none-match": etag, "accept-encoding": "gzip" } });
      expect(nm.status(), `${p}: a matching If-None-Match is 304`).toBe(304);
      const head = await api.fetch(p, { method: "HEAD", headers: { "accept-encoding": "gzip, br" } });
      expect(head.status(), `${p}: HEAD`).toBe(200);
      expect(head.headers()["content-encoding"], `${p}: HEAD is never encoded`).toBeUndefined();
      expect(head.headers()["content-length"], `${p}: HEAD states the identity length`).toBe(String(body.length));
    }
  } finally { await api.dispose(); }
});

async function mkParticipant(sa, saCsrf, nick) {
  const email = `sh_${nick}@company.example`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", { headers: H(ac), data: {
    firstName: "Sh", lastName: "P", nickname: nick, email, company: "Acme", title: "Eng",
    country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "NYC",
  }});
  expect(reg.status(), `register ${nick}: ${await reg.text()}`).toBe(200);
  await anon.dispose();
  const listed = await (await sa.get(`/api/admin/participants?limit=5000`)).json();
  const u = (listed.participants || []).find(p => p.email === email);
  expect(u, `participant ${nick} exists`).toBeTruthy();
  await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: H(saCsrf) });
  await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: H(saCsrf) });
  return { id: u.id, email, nick };
}

test("entrant coalescing: a new entrant reaches the board within the window, and a score change still invalidates at once", async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  const t = uniq();
  const compId = (await (await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
    name: `SH ${t}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240,
  }})).json()).competition.id;
  // Two challenges, so one solve cannot finish the event (fixture checklist 1).
  const mkTask = async (n) => (await (await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
    title: `SH-${n} ${t}`, description: "<p>x</p>", difficulty: "hard", answer_type: "text", correct_answer: "a", status: "published",
  }})).json()).id;
  const task1 = await mkTask(1), task2 = await mkTask(2);
  for (const id of [task1, task2]) await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
  const a = await mkParticipant(sa, csrf, `a${t}`), b = await mkParticipant(sa, csrf, `b${t}`), c = await mkParticipant(sa, csrf, `c${t}`);
  const asg = await (await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [a.id, b.id, c.id], competitionIds: [compId] } })).json();
  expect(asg.assigned, `all three assigned: ${JSON.stringify(asg)}`).toBe(3);

  const A = await apiLogin(a.email), B = await apiLogin(b.email), C = await apiLogin(c.email);
  try {
    const select = async (who) => expect((await who.api.post("/api/select-competition", { headers: H(who.csrf), data: { competitionId: compId } })).ok()).toBeTruthy();
    const board = async () => {
      const r = await A.api.get("/api/leaderboard");
      expect(r.ok(), `leaderboard: ${r.status()}`).toBeTruthy();
      return (await r.json()).board || [];
    };
    const row = (lb, nick) => lb.find(e => e.nickname === nick);
    await select(A);
    const warm = await board();
    expect(row(warm, a.nick), "A is on the board after entering").toBeTruthy();
    expect(row(warm, b.nick), "control: B has not entered yet").toBeFalsy();

    // B enters right after the warm build; it must show within the window.
    const enteredAt = Date.now();
    await select(B);
    await expect.poll(async () => !!row(await board(), b.nick), { timeout: 4000, intervals: [100] }).toBe(true);
    const seenAfter = Date.now() - enteredAt;
    // The window, read from source rather than by requiring lib/ (which opens a DB).
    const LEADERBOARD_ENTRY_COALESCE_MS = Number((/const LEADERBOARD_ENTRY_COALESCE_MS = (\d+);/.exec(fs.readFileSync(path.join(__dirname, "..", "lib", "leaderboard.js"), "utf8")) || [])[1]);
    expect(LEADERBOARD_ENTRY_COALESCE_MS, "the window constant is found").toBeGreaterThan(0);
    expect(seenAfter, "the entrant appears within the coalesce window (plus request slack)").toBeLessThan(LEADERBOARD_ENTRY_COALESCE_MS + 2000);

    // A board built a moment ago, then a coalesced bust (C enters), then a SCORE
    // change: the solve must be on the very next read.
    const before = row(await board(), a.nick).score;
    await select(C);
    const sub = await A.api.post(`/api/tasks/${task1}/submit`, { headers: H(A.csrf), data: { answer: "a", gradingHash: await gradingHashFor(A.api, task1) } });
    expect(sub.ok(), `A submits: ${await sub.text()}`).toBeTruthy();
    const after = await board();
    expect(row(after, a.nick).score, "the solve is visible on the next read, not after a window").toBeGreaterThan(before);
    expect(row(after, c.nick), "and the hard invalidation also carried the coalesced entrant").toBeTruthy();
  } finally { await A.api.dispose(); await B.api.dispose(); await C.api.dispose(); await sa.dispose(); }
});

test("prepared-statement memo: one Statement per SQL text, no inherited mode, never a busy one", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-prepmemo-"));
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-prepmemo-up-"));
  const script = `
    const db = require(${JSON.stringify(path.join(__dirname, "..", "db.js"))});
    const out = {};
    const s1 = db.prepare("SELECT key, value FROM settings ORDER BY key");
    out.same = s1 === db.prepare("SELECT key, value FROM settings ORDER BY key");
    out.other = s1 !== db.prepare("SELECT key FROM settings ORDER BY key");
    db.prepare("SELECT key, value FROM settings ORDER BY key").pluck(true);
    const row = db.prepare("SELECT key, value FROM settings ORDER BY key").get();
    out.modeReset = !!row && typeof row === "object" && "value" in row;
    const it = db.prepare("SELECT key FROM settings").iterate();
    it.next();
    const during = db.prepare("SELECT key FROM settings");
    out.busyNotShared = during.busy === false;
    out.busyResult = Array.isArray(during.all());
    it.return();
    out.cached = typeof db._preparedStatementCacheSize === "function" && db._preparedStatementCacheSize() > 0;
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "", NODE_ENV: "test", DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, BASE_URL: "http://localhost:9", SMTP_HOST: "localhost" },
    encoding: "utf8", timeout: 60_000,
  });
  try {
    expect(r.status, `child: ${r.stderr}`).toBe(0);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    expect(out).toEqual({ same: true, other: true, modeReset: true, busyNotShared: true, busyResult: true, cached: true });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

test("sign-in lookups: account by address and a user's session rows are index searches with the same answers", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-signin-idx-"));
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-signin-idx-up-"));
  const root = path.join(__dirname, "..");
  const script = `
    const R = (p) => require(${JSON.stringify(root)} + "/" + p);
    const db = R("db.js");
    const { findUserByAddress, PRIMARY_SQL, SECONDARY_SQL } = R("lib/account-lookup.js");
    const { SESSION_ROWS_BY_USER_SQL } = R("lib/session-index.js");
    const plan = (sql, n) => db.prepare("EXPLAIN QUERY PLAN " + sql).all(...Array(n).fill("x")).map(r => r.detail).join(" | ");
    const out = { plans: {
      primary: plan(PRIMARY_SQL("*"), 1),
      secondary: plan(SECONDARY_SQL("*"), 1),
      sessions: plan(SESSION_ROWS_BY_USER_SQL, 2),
      control: plan("SELECT * FROM users WHERE LOWER(email)=LOWER(?) OR LOWER(secondary_email)=LOWER(?)", 2),
    } };
    const ins = db.prepare("INSERT INTO users (id, first_name, last_name, nickname, email, secondary_email, created_at) VALUES (?,?,?,?,?,?,?)");
    const at = new Date().toISOString();
    ins.run("u-a", "Ann", "A", "ann1", "ann@corp.test", "ann.alt@corp.test", at);
    ins.run("u-b", "Bob", "B", "bob1", "bob@corp.test", null, at);
    const who = (e) => { const u = findUserByAddress(db, e); return u ? u.id : null; };
    out.lookup = [who("ANN@Corp.Test"), who("Ann.Alt@CORP.test"), who("bob@corp.test"), who("nobody@corp.test"), who("")];
    out.cols = findUserByAddress(db, "bob@corp.test", "id, email");
    // What the real paths prepare: wrap the memo AFTER db.js installed it.
    const seen = [];
    const orig = db.prepare;
    db.prepare = function (sql) { seen.push(String(sql)); return orig.call(db, sql); };
    const { resolveCodeAttempt } = R("lib/login-code.js");
    const { invalidateOtherSessions, clearCompetitionSessionForUser } = R("lib/sessions.js");
    const { _resolveActor } = R("lib/audit.js");
    seen.length = 0; resolveCodeAttempt("Ann@corp.test", "ABCDEFGH"); out.redeemSql = seen.slice();
    seen.length = 0; _resolveActor("bob@corp.test"); out.actorSql = seen.slice();
    const S = (id, obj) => db.prepare("INSERT INTO express_session (id, data) VALUES (?,?)").run(id, typeof obj === "string" ? obj : JSON.stringify(obj));
    S("s-keep", { userId: "u-a" });                                        // the signing-in session itself
    S("s-old", { userId: "u-a" });                                         // A's other session: purged
    S("s-imp-by-a", { userId: "u-t", impersonator: { userId: "u-a" } });  // A impersonating T: A's, purged
    S("s-imp-of-a", { userId: "u-a", impersonator: { userId: "u-adm" } }); // an admin peeking at A: NOT A's
    S("s-b", { userId: "u-b", competitionId: "c-1" });
    S("s-bad", "not json");
    seen.length = 0;
    out.purge = invalidateOtherSessions("userId", "u-a", "s-keep", null);
    out.purgeSql = seen.slice();
    out.left = db.prepare("SELECT id FROM express_session ORDER BY id").all().map(r => r.id);
    seen.length = 0;
    out.cleared = clearCompetitionSessionForUser("u-b", "c-1");
    out.clearSql = seen.slice();
    out.bData = JSON.parse(db.prepare("SELECT data FROM express_session WHERE id='s-b'").get().data);
    db.prepare = orig;
    out.sessionSql = SESSION_ROWS_BY_USER_SQL;
    // A marked line: the audit mirror may log to stdout after this (post-commit).
    process.stdout.write("\\nSIGNIN_IDX_OUT " + JSON.stringify(out) + "\\n");
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "", NODE_ENV: "test", LOG_CONSOLE_MIRROR: "0", DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, BASE_URL: "http://localhost:9", SMTP_HOST: "localhost" },
    encoding: "utf8", timeout: 60_000,
  });
  try {
    expect(r.status, `child: ${r.stderr}`).toBe(0);
    const line = r.stdout.split("\n").find(l => l.startsWith("SIGNIN_IDX_OUT "));
    expect(line, `child stdout: ${r.stdout.slice(-2000)}`).toBeTruthy();
    const out = JSON.parse(line.slice("SIGNIN_IDX_OUT ".length));
    // Plans: index searches; the old form is the control that shows a scan reads as one.
    expect(out.plans.primary).toMatch(/SEARCH users USING INDEX uq_users_email_nocase/);
    expect(out.plans.secondary).toMatch(/SEARCH users USING INDEX uq_users_secondary_email_nocase/);
    expect(out.plans.sessions).toMatch(/idx_express_session_user/);
    expect(out.plans.sessions).toMatch(/idx_express_session_impersonator/);
    for (const k of ["primary", "secondary", "sessions"]) expect(out.plans[k], k).not.toMatch(/\bSCAN\b/);
    expect(out.plans.control).toMatch(/\bSCAN users\b/);
    // Same answers: primary and secondary, ASCII case-insensitive, null otherwise.
    expect(out.lookup).toEqual(["u-a", "u-a", "u-b", null, null]);
    expect(out.cols).toEqual({ id: "u-b", email: "bob@corp.test" });
    // The real paths prepare the indexed SQL, never the scanning form.
    for (const k of ["redeemSql", "actorSql", "purgeSql", "clearSql"]) {
      expect(out[k].length, `${k}: the path ran`).toBeGreaterThan(0);
      expect(out[k].join("\n"), k).not.toMatch(/LOWER\(email\)|data LIKE/i);
    }
    expect(out.redeemSql.some(s => /email=\? COLLATE NOCASE/.test(s))).toBe(true);
    expect(out.actorSql.some(s => /email=\? COLLATE NOCASE/.test(s))).toBe(true);
    expect(out.purgeSql).toContain(out.sessionSql);
    expect(out.clearSql).toContain(out.sessionSql);
    // The ownership rule survives: A's own other session and A's impersonation
    // session go; an admin's session impersonating A, B's and a malformed row stay.
    expect(out.purge.purgedCount).toBe(2);
    expect(out.left).toEqual(["s-b", "s-bad", "s-imp-of-a", "s-keep"]);
    expect(out.cleared.clearedCount).toBe(1);
    expect(out.bData.competitionId).toBeUndefined();
    expect(out.bData.userId).toBe("u-b");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

test("sign-in lookups: no hot-path site spells the scanning LOWER(email) form again", () => {
  const { stripJsComments } = require("./doc-registry");
  const root = path.join(__dirname, "..");
  const read = (f) => stripJsComments(fs.readFileSync(path.join(root, f), "utf8"));
  const auth = read("routes/auth.js");
  const at = auth.indexOf("function _accountByAddress(");
  expect(at, "anti-vacuity: _accountByAddress found").toBeGreaterThan(0);
  const body = auth.slice(at, auth.indexOf("\n}", at));
  // v9.0.0 — the sign-in doors resolve the PRIMARY only (findUserByPrimary); the
  // audit mirror's actor enrichment still asks both slots (findUserByAddress).
  // Both are the indexed point lookups of lib/account-lookup.js.
  expect(body).toMatch(/findUserByPrimary\(db, email\)/);
  expect(body).not.toMatch(/LOWER\(/);
  for (const [f, fn] of [["lib/login-code.js", /findUserByPrimary\(/], ["lib/audit.js", /findUserByAddress\(/]]) {
    const src = read(f);
    expect(src, `${f} uses the indexed lookup`).toMatch(fn);
    expect(src, f).not.toMatch(/LOWER\(email\)/);
  }
  const claim = read("lib/invitation-claim.js");
  expect(claim).toMatch(/FROM invitations WHERE used_at IS NULL AND email=\? COLLATE NOCASE/);
  expect(claim).not.toMatch(/LOWER\(email\)/);
});

// A source lock, because nothing a test can read reports a socket's maximum
// accept queue (/proc/net/tcp shows the current length only, and the CI image
// has no ss). The 3000-user 10 s arrival overflowed Node's default 511.
test("walk-up door: whether an address is taken is three index searches with the same answers as the scanning form", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-taken-idx-"));
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-taken-idx-up-"));
  const root = path.join(__dirname, "..");
  const script = `
    const R = (p) => require(${JSON.stringify(root)} + "/" + p);
    const db = R("db.js");
    const ins = db.prepare("INSERT INTO users (id, first_name, last_name, nickname, email, secondary_email, pending_email, pending_email_code_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
    const at = new Date().toISOString();
    const old = new Date(Date.now() - 72 * 3600 * 1000).toISOString();   // past the 48 h pending window
    ins.run("u-a", "Ann", "A", "ann1", "ann@corp.test", "ann.alt@corp.test", null, null, at);
    ins.run("u-p", "Pat", "P", "pat1", "pat@corp.test", null, "pat.new@corp.test", at, at);
    ins.run("u-x", "Xen", "X", "xen1", "xen@corp.test", null, "xen.stale@corp.test", old, at);
    const seen = [];
    const orig = db.prepare;
    db.prepare = function (sql) { seen.push(String(sql)); return orig.call(db, sql); };
    const { emailIsTaken } = R("lib/email-identity.js");
    const out = { answers: {
      primary: emailIsTaken("ANN@corp.test"), secondary: emailIsTaken("ann.alt@CORP.test"),
      pending: emailIsTaken("pat.new@corp.test"), stalePending: emailIsTaken("xen.stale@corp.test"),
      nobody: emailIsTaken("nobody@corp.test"), empty: emailIsTaken(""),
      ownPrimary: emailIsTaken("ann@corp.test", "u-a"), ownSecondary: emailIsTaken("ann.alt@corp.test", "u-a"),
      othersPrimary: emailIsTaken("ann@corp.test", "u-p"), ownPending: emailIsTaken("pat.new@corp.test", "u-p"),
    } };
    db.prepare = orig;
    out.sql = seen.filter(x => /FROM users/.test(x));
    out.plans = out.sql.map(x => db.prepare("EXPLAIN QUERY PLAN " + x).all(...Array((x.match(/[?]/g) || []).length).fill("x")).map(r => r.detail).join(" | "));
    process.stdout.write("\\nTAKEN_IDX_OUT " + JSON.stringify(out) + "\\n");
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "", NODE_ENV: "test", LOG_CONSOLE_MIRROR: "0", DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, BASE_URL: "http://localhost:9", SMTP_HOST: "localhost" },
    encoding: "utf8", timeout: 60_000,
  });
  try {
    expect(r.status, `child: ${r.stderr}`).toBe(0);
    const line = r.stdout.split("\n").find(l => l.startsWith("TAKEN_IDX_OUT "));
    expect(line, `child stdout: ${r.stdout.slice(-2000)}`).toBeTruthy();
    const out = JSON.parse(line.slice("TAKEN_IDX_OUT ".length));
    // The answers the LOWER() form gave: both slots and a live pending change
    // reserve an address, case-blind; a stale pending one does not; the caller's
    // own row is excluded on request, and only theirs.
    expect(out.answers).toEqual({ primary: true, secondary: true, pending: true, stalePending: false, nobody: false, empty: false,
      ownPrimary: false, ownSecondary: false, othersPrimary: true, ownPending: false });
    // Every statement it prepared is an index search on the three NOCASE indexes.
    expect(out.sql.length, "anti-vacuity: the lookups were seen").toBeGreaterThanOrEqual(3);
    for (const [i, sql] of out.sql.entries()) {
      expect(sql, "no scanning LOWER() form").not.toMatch(/LOWER\(/i);
      expect(out.plans[i], sql).toMatch(/SEARCH users USING INDEX (uq_users_email_nocase|uq_users_secondary_email_nocase|idx_users_pending_email_nocase)/);
      expect(out.plans[i], sql).not.toMatch(/\bSCAN users\b/);
    }
    const used = new Set(out.plans.map(pl => (/USING INDEX (\w+)/.exec(pl) || [])[1]));
    expect([...used].sort()).toEqual(["idx_users_pending_email_nocase", "uq_users_email_nocase", "uq_users_secondary_email_nocase"]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

test("walk-up door: no file on the sign-up and join path spells a scanning LOWER() address lookup", () => {
  const { stripJsComments } = require("./doc-registry");
  const root = path.join(__dirname, "..");
  const files = ["lib/email-identity.js", "routes/auth.js", "lib/email-proof.js", "lib/self-enroll.js", "routes/self-enroll.js"];
  for (const f of files) {
    const src = stripJsComments(fs.readFileSync(path.join(root, f), "utf8"));
    expect(src.length, `anti-vacuity: ${f} read`).toBeGreaterThan(500);
    expect(src, `${f} must not look an address up with LOWER()`).not.toMatch(/LOWER\((email|secondary_email|pending_email)\)/i);
  }
});

// One child for the two lookups below: each runs on a request path that must not
// scan the users table (CLAUDE.md, per-sign-in lookups are index searches).
function runUsersIndexChild(marker, body) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-users-idx-"));
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-users-idx-up-"));
  const root = path.join(__dirname, "..");
  const script = `
    const R = (p) => require(${JSON.stringify(root)} + "/" + p);
    const db = R("db.js");
    const plan = (sql) => db.prepare("EXPLAIN QUERY PLAN " + sql).all(...Array((sql.match(/[?]/g) || []).length).fill("x")).map(r => r.detail).join(" | ");
    const ins = db.prepare("INSERT INTO users (id, first_name, last_name, nickname, email, secondary_email, created_at) VALUES (?,?,?,?,?,?,?)");
    const at = new Date().toISOString();
    const out = {};
    ${body}
    process.stdout.write("\\n${marker} " + JSON.stringify(out) + "\\n");
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "", NODE_ENV: "test", LOG_CONSOLE_MIRROR: "0", DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, BASE_URL: "http://localhost:9", SMTP_HOST: "localhost" },
    encoding: "utf8", timeout: 60_000,
  });
  try {
    expect(r.status, `child: ${r.stderr}`).toBe(0);
    const line = r.stdout.split("\n").find(l => l.startsWith(marker + " "));
    expect(line, `child stdout: ${r.stdout.slice(-2000)}`).toBeTruthy();
    return JSON.parse(line.slice(marker.length + 1));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
}

test("break-glass door: the name check is two index searches with the scanning form's answers", () => {
  const out = runUsersIndexChild("BG_IDX_OUT", `
    ins.run("u-a", "Ann", "A", "ann1", "ann@corp.test", "ann.alt@corp.test", at);
    const seen = [];
    const orig = db.prepare;
    db.prepare = function (sql) { seen.push(String(sql)); return orig.call(db, sql); };
    const { breakglassNameHeldByAccount } = R("lib/settings.js");
    out.answers = [breakglassNameHeldByAccount("ANN@corp.test"), breakglassNameHeldByAccount("ann.alt@CORP.test"), breakglassNameHeldByAccount("nobody@corp.test")];
    db.prepare = orig;
    out.sql = seen.filter(x => /FROM users/.test(x));
    out.plans = out.sql.map(plan);
    out.control = plan("SELECT 1 FROM users WHERE LOWER(email)=LOWER(?) OR LOWER(secondary_email)=LOWER(?) LIMIT 1");
  `);
  expect(out.answers, "primary and secondary, case-blind; nobody else").toEqual([true, true, false]);
  expect(out.sql.length, "anti-vacuity: the lookups were seen").toBeGreaterThanOrEqual(2);
  for (const [i, sql] of out.sql.entries()) {
    expect(out.plans[i], sql).toMatch(/SEARCH users USING (COVERING )?INDEX (uq_users_email_nocase|uq_users_secondary_email_nocase)/);
    expect(out.plans[i], sql).not.toMatch(/\bSCAN users\b/);
  }
  expect(out.control, "CONTROL: the LOWER() form reads as a scan").toMatch(/\bSCAN users\b/);
});

test("event team report: the possible-duplicate candidates are an index search on the last name", () => {
  const out = runUsersIndexChild("DUP_IDX_OUT", `
    const { DUP_CANDIDATES_SQL } = R("lib/event-team.js");
    ins.run("u-1", "Ann", " Smith ", "ann1", "a1@corp.test", null, at);
    ins.run("u-2", "Ann", "SMITH", "ann2", "a2@corp.test", null, at);
    ins.run("u-3", "Bob", "Jones", "bob1", "b1@corp.test", null, at);
    out.sql = DUP_CANDIDATES_SQL;
    out.plan = plan(DUP_CANDIDATES_SQL);
    out.found = db.prepare(DUP_CANDIDATES_SQL).all(JSON.stringify(["smith"])).map(r => r.id).sort();
    out.control = plan("SELECT id FROM users WHERE LOWER(last_name) IN (SELECT value FROM json_each(?))");
  `);
  expect(out.found, "everyone with that last name, case and spaces folded; nobody else").toEqual(["u-1", "u-2"]);
  expect(out.plan, out.sql).toMatch(/SEARCH users USING INDEX idx_users_last_name_key/);
  expect(out.plan, out.sql).not.toMatch(/\bSCAN users\b/);
  expect(out.control, "CONTROL: an expression the index does not hold scans").toMatch(/\bSCAN users\b/);
  // The report prepares the constant itself, never a copy of its own.
  const { stripJsComments } = require("./doc-registry");
  const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "lib", "event-team.js"), "utf8"));
  expect(src, "buildReportData prepares DUP_CANDIDATES_SQL").toMatch(/db\.prepare\(DUP_CANDIDATES_SQL\)/);
  expect(src.match(/FROM users WHERE LOWER\(/g) || [], "the one spelling of that lookup").toHaveLength(1);
});

test("email lookups off the sign-in path: list, unsubscribe, invitation and holder lookups are index searches with the same answers", () => {
  const out = runUsersIndexChild("EMAIL_IDX_OUT", `
    const { findUsersByPrimaryList, PRIMARY_LIST_SQL } = R("lib/account-lookup.js");
    const { UNSUBSCRIBED_IN_LIST_SQL, leadContactable } = R("lib/event-team.js");
    const { PERSON_INVITATIONS_SQL } = R("lib/full-export.js");
    const { ADDRESS_HOLDERS_SQL } = R("lib/cxone-withdraw.js");
    const insU = db.prepare("INSERT INTO users (id, first_name, last_name, nickname, email, secondary_email, pending_email, created_at) VALUES (?,?,?,?,?,?,?,?)");
    insU.run("u-a", "Ann", "A", "ann1", "Ann.Mixed@Corp.Test", "ann.alt@corp.test", null, at);
    insU.run("u-b", "Bob", "B", "bob1", "bob@corp.test", null, "carl@corp.test", at);
    insU.run("u-c", "Carl", "C", "carl1", "carl@corp.test", null, null, at);
    insU.run("u-d", "Dee", "D", "dee1", "dee@corp.test", null, "dee@corp.test", at);   // one account, two slots
    insU.run("u-e", "Opal", "E", "opal1", "Opt.Out@Corp.Test", null, null, at);
    const insI = db.prepare("INSERT INTO invitations (id, email, created_at, used_at, user_id) VALUES (?,?,?,?,?)");
    insI.run("i1", "Ann.Mixed@corp.test", "2026-01-01T00:00:01.000Z", null, null);          // live, to her address
    insI.run("i2", "ann.mixed@corp.test", "2026-01-01T00:00:02.000Z", at, "u-z");           // used, by someone else
    insI.run("i3", "old@corp.test", "2026-01-01T00:00:03.000Z", at, "u-a");                 // used, by her, another address
    insI.run("i4", "nobody@corp.test", "2026-01-01T00:00:04.000Z", at, "u-y");              // unrelated
    const insX = db.prepare("INSERT INTO unsubscribed_emails (email, unsubscribed_at) VALUES (?,?)");
    insX.run("ann.alt@corp.test", at);
    insX.run("opt.out@corp.test", at);
    const OLD = {
      list: "SELECT id, email FROM users WHERE LOWER(email) IN (SELECT value FROM json_each(?)) OR LOWER(secondary_email) IN (SELECT value FROM json_each(?))",
      unsub: "SELECT email FROM unsubscribed_emails WHERE LOWER(email) IN (SELECT value FROM json_each(?))",
      inv: "SELECT competition_ids, group_ids, invited_by, created_at, used_at, user_id, last_send_success FROM invitations WHERE user_id=? OR email = ? COLLATE NOCASE ORDER BY created_at",
      holders: "SELECT id, email, verified, first_name, last_name FROM users WHERE email = ? COLLATE NOCASE OR secondary_email = ? COLLATE NOCASE OR pending_email = ? COLLATE NOCASE",
    };
    out.plans = { list: plan(PRIMARY_LIST_SQL("id, email")), unsub: plan(UNSUBSCRIBED_IN_LIST_SQL), inv: plan(PERSON_INVITATIONS_SQL), holders: plan(ADDRESS_HOLDERS_SQL) };
    out.controls = Object.fromEntries(Object.entries(OLD).map(([k, sql]) => [k, plan(sql)]));
    // Raw logs keys its map by the PRIMARY address, lower-cased: the per-key answer.
    const keys = ["ann.mixed@corp.test", "ann.alt@corp.test", "BOB@CORP.TEST", "nobody@corp.test"];
    const keyed = (rows) => { const m = new Map(rows.map(u => [u.email.toLowerCase(), u.id])); return keys.map(k => m.get(k.toLowerCase()) || null); };
    const listed = findUsersByPrimaryList(db, keys, "id, email");
    out.list = listed.map(u => u.id).sort();
    out.listKeyed = keyed(listed);
    out.listKeyedOld = keyed(db.prepare(OLD.list).all(JSON.stringify(keys.map(k => k.toLowerCase())), JSON.stringify(keys.map(k => k.toLowerCase()))));
    out.listEmpty = findUsersByPrimaryList(db, ["", null, 7]);
    const ids = (rows) => rows.map(r => r.id).sort();
    out.holders = {};
    for (const a of ["carl@corp.test", "ANN.ALT@corp.test", "dee@corp.test", "nobody@corp.test"]) {
      out.holders[a] = { now: ids(db.prepare(ADDRESS_HOLDERS_SQL).all(a, a, a)), old: ids(db.prepare(OLD.holders).all(a, a, a)) };
    }
    const order = (rows) => rows.map(r => r.created_at);
    out.inv = order(db.prepare(PERSON_INVITATIONS_SQL).all("u-a", "ann.mixed@corp.test"));
    out.invOld = order(db.prepare(OLD.inv).all("u-a", "ann.mixed@corp.test"));
    // What the opted-out test prepares while it answers: wrap the memo AFTER db.js installed it.
    const seen = [];
    const orig = db.prepare;
    db.prepare = function (sql) { seen.push(String(sql)); return orig.call(db, sql); };
    out.contactable = { a: leadContactable("c-1", "u-a"), e: leadContactable("c-1", "u-e"), b: leadContactable("c-1", "u-b") };
    db.prepare = orig;
    out.contactSql = seen;
    out.unsubSql = UNSUBSCRIBED_IN_LIST_SQL;
  `);
  // Plans: index searches on the NOCASE (or exact, for the opt-outs) indexes; each old text scans.
  expect(out.plans.list).toMatch(/SEARCH users USING INDEX uq_users_email_nocase/);
  expect(out.plans.unsub).toMatch(/SEARCH unsubscribed_emails USING COVERING INDEX sqlite_autoindex_unsubscribed_emails_1/);
  expect(out.plans.inv).toMatch(/idx_invitations_user/);
  expect(out.plans.inv).toMatch(/idx_invitations_email_nocase/);
  for (const ix of ["uq_users_email_nocase", "uq_users_secondary_email_nocase", "idx_users_pending_email_nocase"]) expect(out.plans.holders).toMatch(new RegExp(ix));
  for (const [k, pl] of Object.entries(out.plans)) expect(pl, k).not.toMatch(/\bSCAN (users|invitations|unsubscribed_emails)\b/);
  for (const [k, pl] of Object.entries(out.controls)) expect(pl, `CONTROL ${k}: the old text reads as a scan`).toMatch(/\bSCAN (users|invitations|unsubscribed_emails)\b/);
  // Answers. The list is primary only, case-blind: a secondary matches nobody,
  // in the old keyed answer as in the new.
  expect(out.list).toEqual(["u-a", "u-b"]);
  expect(out.listKeyed).toEqual(["u-a", null, "u-b", null]);
  expect(out.listKeyed, "the old two-arm text gave the same answer per key").toEqual(out.listKeyedOld);
  expect(out.listEmpty).toEqual([]);
  expect(out.holders).toEqual({
    "carl@corp.test": { now: ["u-b", "u-c"], old: ["u-b", "u-c"] },       // a primary and a pending change
    "ANN.ALT@corp.test": { now: ["u-a"], old: ["u-a"] },                  // a secondary, in another case
    "dee@corp.test": { now: ["u-d"], old: ["u-d"] },                      // two slots of one account: one holder
    "nobody@corp.test": { now: [], old: [] },
  });
  expect(out.inv, "claimed by her, or sent to her address in any case, used or not; once each, in time order").toEqual(
    ["2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.000Z", "2026-01-01T00:00:03.000Z"]);
  expect(out.inv).toEqual(out.invOld);
  // The opted-out test: her secondary opted out; a mixed-case primary whose
  // lower-case form opted out; CONTROL, someone who did not.
  expect(out.contactable).toEqual({ a: false, e: false, b: true });
  expect(out.contactSql, "the real path prepares the exported statement").toContain(out.unsubSql);
  expect(out.contactSql.join("\n")).not.toMatch(/LOWER\(email\)/i);
  // The callers prepare the exported constants, never copies of their own.
  const { stripJsComments } = require("./doc-registry");
  const read = (f) => stripJsComments(fs.readFileSync(path.join(__dirname, "..", f), "utf8"));
  const server = read("server.js");
  const at = server.indexOf("function _enrichLogRowsWithUserDetails(");
  expect(at, "anti-vacuity: the Raw logs enrichment found").toBeGreaterThan(0);
  expect(server.slice(at, server.indexOf("\n}", at))).toMatch(/findUsersByPrimaryList\(db, \[\.\.\.emails\]/);
  expect(read("routes/admin-misc.js")).toMatch(/const user = findUserByAddress\(db, email, "id"\);/);
  expect(read("lib/full-export.js")).toMatch(/db\.prepare\(PERSON_INVITATIONS_SQL\)/);
  expect(read("lib/cxone-withdraw.js")).toMatch(/db\.prepare\(ADDRESS_HOLDERS_SQL\)\.all\(addr, addr, addr\)/);
});

// THE BULK INVITATION'S LIVE-INVITATION LOOKUP, through the REAL handler. A stub
// `app` collects the route and the child calls it as the built-in superadmin (the
// guards in front of it are not this lock's subject), recording every SQL text it
// prepares. Its second site, the race loser's re-read, runs only when another
// instance's live row lands between the route's SELECT and its INSERT, a window no
// request can hold open (nothing is awaited between them): the child lands that
// row the moment the route prepares its INSERT, as the other instance's commit would.
function runInvitationRouteChild(marker, body) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-inv-idx-"));
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ha-inv-idx-up-"));
  const root = path.join(__dirname, "..");
  const script = `
    const R = (p) => require(${JSON.stringify(root)} + "/" + p);
    const db = R("db.js");
    const at = new Date().toISOString();
    const routes = {};
    const app = new Proxy({}, { get: (_, verb) => (p, ...fns) => { routes[String(verb).toUpperCase() + " " + p] = fns[fns.length - 1]; } });
    R("routes/invitations.js")(app);
    const handler = routes["POST /api/admin/invitations"];
    const orig = db.prepare;
    const run = (sql, ...a) => orig.call(db, sql).run(...a);
    const one = (sql, ...a) => orig.call(db, sql).get(...a);
    run("INSERT INTO groups (id, name, name_key, created_at) VALUES ('g-1', 'Lookup group', 'lookup group', ?)", at);
    const plant = (id, email) => run("INSERT INTO invitations (id, email, competition_ids, group_ids, invited_by, created_at, last_send_success) VALUES (?,?,'[]','[]','superadmin',?,1)", id, email, at);
    const seen = [];
    let race = null;
    db.prepare = function (sql) {
      const s = String(sql);
      seen.push(s);
      if (race && /^INSERT INTO invitations\\b/.test(s)) { const r = race; race = null; plant(r.id, r.email); }
      return orig.call(db, sql);
    };
    // One address, the group ticked: whichever live row the lookup finds gains the group.
    const invite = (address) => new Promise((resolve, reject) => {
      seen.length = 0;
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
      const req = { body: { emails: [address], groupIds: ["g-1"] }, session: { isAdmin: true, isSuperAdmin: true, builtinId: "superadmin" },
        headers: {}, ip: "127.0.0.1", id: "req-inv", sessionID: "sess-inv" };
      Promise.resolve(handler(req, res)).catch(reject);
    });
    const plan = (sql) => orig.call(db, "EXPLAIN QUERY PLAN " + sql).all(...Array((sql.match(/[?]/g) || []).length).fill("x")).map(r => r.detail).join(" | ");
    const report = (r, rowId, address) => ({
      status: r.status, invited: r.body.invited, alreadyInvited: r.body.alreadyInvited, errors: r.body.errors,
      groups: JSON.parse(one("SELECT group_ids FROM invitations WHERE id=?", rowId).group_ids),
      live: one("SELECT COUNT(*) AS n FROM invitations WHERE used_at IS NULL AND LOWER(email)=LOWER(?)", address).n,
      inserted: seen.some(s => /^INSERT INTO invitations\\b/.test(s)),
      lookups: seen.filter(s => /FROM invitations WHERE[^;]*\\bemail\\b/.test(s)),
    });
    const out = {};
    (async () => {
      ${body}
      process.stdout.write("\\n${marker} " + JSON.stringify(out) + "\\n", () => process.exit(0));
    })().catch((e) => { process.stderr.write(String((e && e.stack) || e)); process.exit(2); });
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "", NODE_ENV: "test", LOG_CONSOLE_MIRROR: "0", DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir,
      BASE_URL: "http://localhost:9", SMTP_HOST: "127.0.0.1", SMTP_PORT: "1" },
    encoding: "utf8", timeout: 60_000,
  });
  try {
    expect(r.status, `child: ${r.stderr}`).toBe(0);
    const line = r.stdout.split("\n").find(l => l.startsWith(marker + " "));
    expect(line, `child stdout: ${r.stdout.slice(-2000)}`).toBeTruthy();
    return JSON.parse(line.slice(marker.length + 1));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
}

test("bulk invitation: the live-invitation lookup is an index search at both its sites, and still finds an address stored in another case", () => {
  const out = runInvitationRouteChild("INV_IDX_OUT", `
    // Site 1, the re-invite merge: the live row is there before the request.
    plant("inv-a", "Bob.A@Example.COM");
    out.merge = report(await invite("bob.a@example.com"), "inv-a", "bob.a@example.com");
    // Site 2, the race loser's re-read: the row lands between the SELECT and the INSERT.
    race = { id: "inv-b", email: "Bob.B@Example.COM" };
    out.race = report(await invite("bob.b@example.com"), "inv-b", "bob.b@example.com");
    out.raceLanded = race === null;
    // CONTROL: another address's live row is not this address's invitation.
    plant("inv-c", "Other@Example.COM");
    out.other = report(await invite("bob.c@example.com"), "inv-c", "bob.c@example.com");
    out.plans = [...out.merge.lookups, ...out.race.lookups].map(plan);
    out.control = plan("SELECT id FROM invitations WHERE LOWER(email)=LOWER(?) AND used_at IS NULL");
  `);
  // Site 1 found the row stored in another case, so the route never reached its
  // INSERT (a miss there would be rescued by site 2, with the same response).
  expect(out.merge, "the re-invite merge").toMatchObject({ status: 200, invited: 0, alreadyInvited: ["bob.a@example.com"], errors: [], groups: ["g-1"], live: 1, inserted: false });
  expect(out.merge.lookups, "one lookup: the merge's").toHaveLength(1);
  // Site 2: the INSERT met the other instance's row, and the re-read found it.
  expect(out.raceLanded, "PRECONDITION: the racing row landed at the route's INSERT").toBe(true);
  expect(out.race, "the race loser's re-read").toMatchObject({ status: 200, invited: 0, alreadyInvited: ["bob.b@example.com"], errors: [], groups: ["g-1"], live: 1, inserted: true });
  expect(out.race.lookups, "two lookups: the merge's, then the re-read's").toHaveLength(2);
  // CONTROL: no live row for the address, so a new invitation; the other row is untouched.
  expect(out.other, "an address nobody invited").toMatchObject({ status: 200, invited: 1, alreadyInvited: [], errors: [], groups: [], live: 1, inserted: true });
  // Every lookup either site prepared is one SQL text, a SEARCH of the live-email index.
  expect(new Set([...out.merge.lookups, ...out.race.lookups]).size, "both sites prepare one SQL text").toBe(1);
  expect(out.plans, "anti-vacuity: three lookups planned").toHaveLength(3);
  for (const [i, sql] of [...out.merge.lookups, ...out.race.lookups].entries()) {
    expect(sql, "no scanning LOWER() form").not.toMatch(/LOWER\(/i);
    expect(out.plans[i], sql).toMatch(/SEARCH invitations USING (COVERING )?INDEX uq_invitations_live_email \(email=\?\)/);
    expect(out.plans[i], sql).not.toMatch(/\bSCAN invitations\b/);
  }
  expect(out.control, "CONTROL: the LOWER() form reads as a scan").toMatch(/\bSCAN invitations\b/);
  // The source: both sites prepare the one constant, and nothing in the file
  // spells an address lookup the index cannot serve.
  const { stripJsComments } = require("./doc-registry");
  const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "routes", "invitations.js"), "utf8"));
  expect(src.match(/db\.prepare\(LIVE_INVITATION_SQL\)\.get\(email\)/g) || [], "the merge and the re-read both prepare LIVE_INVITATION_SQL").toHaveLength(2);
  const liveByAddress = /FROM invitations WHERE[^"]*(used_at IS NULL[^"]*\bemail\b|\bemail\b[^"]*used_at IS NULL)/g;
  expect(src.match(liveByAddress) || [], "the one spelling of the live-invitation lookup: LIVE_INVITATION_SQL").toHaveLength(1);
  expect(src, "routes/invitations.js must not look an address up with LOWER()").not.toMatch(/LOWER\((email|secondary_email)\)/i);
});

test("bulk invitation, through the server: a re-invite in another case merges into the live invitation; another address is a new one (CONTROL)", async () => {
  // End to end, where either site alone would give this answer (the per-site
  // witness is the child test above): an older or imported invitation can hold
  // its address in another case, and the route's addresses are folded to lower.
  const { api: sa, csrf } = await apiLogin("superadmin");
  const t = uniq();
  const stored = `Lookup.${t}@Example.COM`, fresh = `fresh.${t}@example.com`;
  const invId = `inv-lookup-${t}`;
  const sql = (fn) => { const Database = require("better-sqlite3"); const d = new Database(TEST_DB_PATH); try { return fn(d); } finally { d.close(); } };
  try {
    const g = await sa.post("/api/admin/groups", { headers: H(csrf), data: { name: `Lookup ${t}` } });
    expect(g.ok(), `group: ${await g.text()}`).toBeTruthy();
    const gid = (await g.json()).group.id;
    sql(d => d.prepare("INSERT INTO invitations (id, email, competition_ids, group_ids, invited_by, created_at, last_send_success) VALUES (?,?,'[]','[]','superadmin',?,1)")
      .run(invId, stored, new Date().toISOString()));
    const r = await sa.post("/api/admin/invitations", { headers: H(csrf), data: { emails: [stored.toLowerCase(), fresh], groupIds: [gid] } });
    expect(r.status(), await r.text()).toBe(200);
    const body = await r.json();
    expect(body.alreadyInvited, "the stored invitation is found").toEqual([stored.toLowerCase()]);
    expect(body.invited, "CONTROL: the other address gets a new invitation").toBe(1);
    const rows = sql(d => d.prepare("SELECT id, email, group_ids FROM invitations WHERE used_at IS NULL AND LOWER(email) IN (?, ?) ORDER BY LOWER(email)")
      .all(stored.toLowerCase(), fresh));
    expect(rows.map(x => [x.email, JSON.parse(x.group_ids)]), "one live invitation each: the stored one gained the group").toEqual([[fresh, [gid]], [stored, [gid]]]);
    expect(rows.find(x => x.email === stored).id, "the merge landed on the stored row, not a second one").toBe(invId);
  } finally { await sa.dispose(); }
});

test("walk-up door: a newcomer's join leaves the board's version alone; a rejoin bringing points back moves it", async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  const t = uniq();
  const compId = (await (await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
    name: `SHJ ${t}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240, self_enroll_enabled: true,
  }})).json()).competition.id;
  // Two challenges, so one solve cannot finish the event (fixture checklist 1).
  const mkTask = async (n) => (await (await sa.post("/api/admin/tasks", { headers: H(csrf), data: {
    title: `SHJ-${n} ${t}`, description: "<p>x</p>", difficulty: "hard", answer_type: "text", correct_answer: "a", status: "published",
  }})).json()).id;
  const task1 = await mkTask(1), task2 = await mkTask(2);
  for (const id of [task1, task2]) await sa.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
  const token = (await (await sa.get(`/api/admin/competitions/${compId}/self-enroll`)).json()).token;
  expect(token, "PRECONDITION: a join token").toBeTruthy();
  const w = await mkParticipant(sa, csrf, `w${t}`), n = await mkParticipant(sa, csrf, `n${t}`), r = await mkParticipant(sa, csrf, `r${t}`);
  const asg = await (await sa.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [w.id], competitionIds: [compId] } })).json();
  expect(asg.assigned, "the watcher is assigned").toBe(1);
  const W = await apiLogin(w.email), N = await apiLogin(n.email), R = await apiLogin(r.email);
  try {
    const xc = { "x-competition-id": compId };
    expect((await W.api.post("/api/select-competition", { headers: H(W.csrf), data: { competitionId: compId } })).ok()).toBeTruthy();
    const version = async () => {
      const p = await W.api.get("/api/participant/pulse", { headers: xc });
      expect(p.ok(), `pulse: ${p.status()} ${await p.text()}`).toBeTruthy();
      return (await p.json()).lb_version;
    };
    const join = async (who) => {
      const j = await who.api.post("/api/competitions/join", { headers: H(who.csrf), data: { token } });
      expect(j.status(), `join: ${await j.text()}`).toBe(200);
    };
    const v0 = await version();
    await join(N);
    expect(await version(), "a newcomer's join does not move the board's version").toBe(v0);
    // R joins (a newcomer too), scores, leaves and rejoins: the rejoin brings
    // their points back onto the board, which is a score change.
    await join(R);
    expect(await version(), "R's first join is a newcomer's too").toBe(v0);
    expect((await R.api.post("/api/select-competition", { headers: H(R.csrf), data: { competitionId: compId } })).ok()).toBeTruthy();
    const sub = await R.api.post(`/api/tasks/${task1}/submit`, { headers: { ...H(R.csrf), ...xc }, data: { answer: "a", gradingHash: await gradingHashFor(R.api, task1) } });
    expect(sub.ok(), `R submits: ${await sub.text()}`).toBeTruthy();
    const v1 = await version();
    expect(v1, "CONTROL: a solve moves the version (the signal is observed)").not.toBe(v0);
    const leave = await R.api.post(`/api/competitions/${compId}/leave`, { headers: H(R.csrf) });
    expect(leave.ok(), `R leaves: ${await leave.text()}`).toBeTruthy();
    const v2 = await version();
    await join(R);
    expect(await version(), "a rejoin with points moves the version").not.toBe(v2);
  } finally { await W.api.dispose(); await N.api.dispose(); await R.api.dispose(); await sa.dispose(); }
});

test("listen backlog: the app listens with LISTEN_BACKLOG (>= 4096), not Node's default 511", () => {
  const { stripJsComments } = require("./doc-registry");
  const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8"));
  const m = src.match(/const LISTEN_BACKLOG = (\d+);/);
  expect(m, "LISTEN_BACKLOG is defined").not.toBeNull();
  expect(Number(m[1])).toBeGreaterThanOrEqual(4096);
  const listens = src.match(/\bapp\.listen\([^)]*/g) || [];
  expect(listens.length, "anti-vacuity: the app's listen call found").toBe(1);
  expect(listens[0]).toMatch(/^app\.listen\(PORT, '0\.0\.0\.0', LISTEN_BACKLOG,/);
});
