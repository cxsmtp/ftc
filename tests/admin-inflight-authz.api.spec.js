// @ts-check
//
// v8.12.6 (EXTERNAL AUDIT F1) — AN ADMIN WHO IS REVOKED WHILE THEIR REQUEST IS
// STILL IN FLIGHT MUST NOT BE ABLE TO FINISH IT.
//
// requireAdmin / requireSuperAdmin run when the request HEADERS arrive. Four admin
// routes then keep reading and awaiting before they write: the two attachment
// uploads (multer streams the body AFTER the guard; the handler then walks the
// ZIP, hashes it and moves it) and the two imports (the 128 MB parser is mounted
// after the guard). MEASURED
// before the fix, every one answered 200 after a colleague had blocked, demoted
// or deleted the admin: a blocked superadmin's participant import minted a new
// SUPERADMIN account, and an event admin demoted or deleted mid-body uploaded to
// a challenge they did NOT own — the scope predicates read a non-event-admin role
// (or a missing row) as unscoped and trust requireAdmin to have vouched for the
// tier, a body ago.
//
// `adminAuthzDenied` (lib/middleware.js) is re-asked after the LAST await,
// synchronously with the write. Every refusal arm asserts the status AND the
// machine code (a 401 "Not authenticated" from the GUARD must never pass as the
// fix), that nothing was written, and that no file was left on disk — and every
// refusal has a CONTROL that commits through the same path, or "it was refused"
// is equally satisfied by a build that broke uploading.
//
// ── TWO WAYS A REQUEST IS HELD, AND WHY BOTH ─────────────────────────────────
//
// MID-BODY: headers flushed, half the multipart body written, then the arm waits
// until the server is provably INSIDE multer (a new temp file exists in this
// worker's UPLOADS_DIR — the only deterministic sign requireAdmin has already
// run), acts, and sends the rest. Without that wait a revocation that lands first
// is refused by requireAdmin on the UNFIXED tree too and the arm passes vacuously.
//
// POST-BODY: the whole request is sent, and the test-only park
// (`POST /api/test/admin-commit-delay`) holds the handler immediately BEFORE its
// commit-time re-check; the arm polls the park's `parked` counter, acts, and lets
// it go. This is the window the audit named — after the ZIP walk, the hash and
// the move — and it is the only arm that can tell a check placed AT COMMIT from
// one placed after the FIRST await: every mid-body revocation precedes every
// handler await, so a check moved out of the transaction to just after the ZIP
// walk passes all of the mid-body arms (measured on the design copy).
//
// ── WHICH ARM PINS WHICH HALF OF THE PREDICATE ────────────────────────────────
//
// A ROUTE-DRIVEN revocation (block, role change, delete, a sign-in elsewhere)
// ALSO tombstones the session, so on those arms the lifecycle half and the
// tombstone half both refuse; they are told apart only by status and code (403
// admin_access_revoked vs 401 admin_session_ended). The OUT-OF-BAND arm (a direct
// SQL block, which writes no tombstone) is therefore the SOLE pin of the
// lifecycle half's security value — do not "dedupe" it as redundant with the
// block arm. The sign-in-elsewhere and view-toggle arms are the pins of the
// tombstone half (the account row is untouched there).
//
// ── AND ONE TIER DOWN: THE ADMIN AT THE KEYBOARD OF A PARTICIPANT SEAT ───────
//
// The last describe is the v8.12.6 review's finding: a superadmin impersonating
// a PARTICIPANT writes through `requireParticipant`, which reads the TARGET, so
// the admin was re-read only by `impersonationGuard` at the headers. A file
// answer, a password change and a certificate mint each await before they write,
// and each committed after the admin had been revoked — the file answer measured
// at 200 and 50 points. `impersonatingHandDenied` re-asks at commit; the arms pin
// its three answers (session ended, access ended, read-only tier) and the
// controls that an untouched admin's write still lands.
const { test, expect } = require("./isolated-test");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { apiLogin, zipOf, serverLogTail, gradingHashFor, PARTICIPANT_PASS, BASE, TEST_DB_PATH, TEST_DATA_DIR } = require("./helpers");
const { H, uniq, makeParticipant, grantEventAdmin, makeCompetition, enrol, assignTask } = require("./event-admin-helpers");
const { signIn, cookieOf, sessionIdOf, makeAdmin, parked, seat: seatOf } = require("./admin-inflight-helpers");

test.use({ baseURL: BASE });

const UPLOADS = path.join(TEST_DATA_DIR, "uploads");
function dbGet(sql, ...a) { const d = new Database(TEST_DB_PATH, { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } }
function dbRun(sql, ...a) { const d = new Database(TEST_DB_PATH); try { return d.prepare(sql).run(...a); } finally { d.close(); } }
function dbExec(sql) { const d = new Database(TEST_DB_PATH); try { d.exec(sql); } finally { d.close(); } }
function dbAll(sql, ...a) { const d = new Database(TEST_DB_PATH, { readonly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } }
const sessionEnds = (userId) => dbAll("SELECT details FROM user_events WHERE user_id=? AND event_type='sessions_invalidated'", userId)
  .map(r => JSON.parse(r.details || "{}"));
const countFiles = (dir) => { try { return fs.readdirSync(path.join(TEST_DATA_DIR, dir)).length; } catch { return 0; } };
const importTmpFiles = () => { try { return fs.readdirSync(UPLOADS).filter(f => f.startsWith("import-")).length; } catch { return 0; } };

const ACCESS_ENDED = "Your administrator access has ended, so nothing was saved.";
const SESSION_ENDED = "Your session ended before this finished, so nothing was saved. Try again — if you are asked to sign in, do that first.";

// signIn / cookieOf / sessionIdOf / makeAdmin / parked moved to
// tests/admin-inflight-helpers.js (v8.12.7), shared with the desk-invite spec.
async function makeTask(api, csrf, extra = {}) {
  const r = await api.post("/api/admin/tasks", { headers: H(csrf), data: {
    title: `F1 ${uniq("t")}`, description: "<p>d</p>", difficulty: "easy", answer_type: "text", correct_answer: "k", status: "draft", ...extra } });
  expect(r.ok(), `create task: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()).id;
}
const attachments = (taskId) => dbGet("SELECT COUNT(*) c FROM task_attachments WHERE task_id=?", taskId).c;
const staged = (name) => dbGet("SELECT COUNT(*) c FROM task_attachments_staging WHERE display_name=?", name).c;

/** A multipart upload held open MID-BODY until the server is inside multer; `midway` runs there. */
function heldUpload({ urlPath, cookie, csrf, zip, displayName, midway }) {
  return new Promise((resolve, reject) => {
    const b = "----f1" + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="display_name"\r\n\r\n${displayName}\r\n` +
      `--${b}\r\nContent-Disposition: form-data; name="file"; filename="f1.zip"\r\nContent-Type: application/zip\r\n\r\n`);
    const body = Buffer.concat([head, zip, Buffer.from(`\r\n--${b}--\r\n`)]);
    const cut = head.length + Math.floor(zip.length / 2);
    const u = new URL(BASE + urlPath);
    const before = new Set(fs.existsSync(UPLOADS) ? fs.readdirSync(UPLOADS) : []);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: {
      cookie, "x-csrf-token": csrf, "content-type": `multipart/form-data; boundary=${b}`, "content-length": body.length } },
      res => { let t = ""; res.on("data", d => t += d); res.on("end", () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j || {}, text: t }); }); });
    req.on("error", reject);
    req.flushHeaders();
    req.write(body.subarray(0, cut));
    (async () => {
      const t0 = Date.now();
      while (!(fs.existsSync(UPLOADS) && fs.readdirSync(UPLOADS).some(f => !before.has(f)))) {
        if (Date.now() - t0 > 10_000) { req.destroy(); return reject(new Error("PRECONDITION: the upload never reached multer (no temp file in UPLOADS_DIR)")); }
        await new Promise(r => setTimeout(r, 25));
      }
      try { if (midway) await midway(); } catch (e) { req.destroy(); return reject(e); }
      req.end(body.subarray(cut));
    })();
  });
}

const multipart = (displayName, zip) => ({ display_name: displayName, file: { name: "f1.zip", mimeType: "application/zip", buffer: zip } });

const ZIP = zipOf("README.txt", "f1 ".repeat(800));

test.describe("v8.12.6 (F1) — an admin revoked mid-request cannot finish the write", () => {
  let sa, saCsrf;
  test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
  test.afterAll(async () => { await sa?.dispose(); });

  /** One admin, signed in, with a draft challenge of their own. */
  async function armed(label, role = "admin") {
    const p = await makeAdmin(sa, saCsrf, label, role);
    const s = await signIn(p.email, PARTICIPANT_PASS);
    return { p, ...s, cookie: await cookieOf(s.api), taskId: await makeTask(s.api, s.csrf) };
  }
  const block = (id) => async () => {
    const r = await sa.post(`/api/admin/participants/${id}/block`, { headers: H(saCsrf) });
    expect(r.ok(), `block: ${await r.text()}`).toBeTruthy();
    expect((await r.json()).blocked, "the block TOOK (the route is a toggle)").toBe(1);
  };
  const setRole = (id, role) => async () => {
    const r = await sa.post(`/api/admin/participants/${id}/role`, { headers: H(saCsrf), data: { role } });
    expect(r.ok(), `role ${role}: ${await r.text()}`).toBeTruthy();
  };
  const expectRevoked = (r, what) => {
    expect(r.status, `${what}: ${r.text}`).toBe(403);
    expect(r.json.code, `${what}: refused at COMMIT, not by the guard`).toBe("admin_access_revoked");
    expect(r.json.error).toBe(ACCESS_ENDED);
  };

  // ── MID-BODY, the direct route ────────────────────────────────────────────

  test("CONTROL: the same held direct upload from an untouched admin commits", async () => {
    const a = await armed("f1ok");
    try {
      const r = await heldUpload({ urlPath: `/api/admin/tasks/${a.taskId}/attachments`, cookie: a.cookie, csrf: a.csrf, zip: ZIP, displayName: uniq("d") });
      expect(r.status, r.text).toBe(200);
      expect(attachments(a.taskId)).toBe(1);
    } finally { await a.api.dispose(); }
  });

  test("an admin BLOCKED while their direct upload is arriving is refused; no row and no file are left", async () => {
    const a = await armed("f1blk");
    const filesBefore = countFiles("attachments");
    try {
      const r = await heldUpload({ urlPath: `/api/admin/tasks/${a.taskId}/attachments`, cookie: a.cookie, csrf: a.csrf, zip: ZIP, displayName: uniq("d"), midway: block(a.p.id) });
      expectRevoked(r, "blocked mid-body");
      expect(attachments(a.taskId), "nothing was attached").toBe(0);
      expect(countFiles("attachments"), "and the moved ZIP was reclaimed").toBe(filesBefore);
      // The block ended the live session, and the account's History says why
      // (beside the promotion's own session end, which has its own reason).
      expect(sessionEnds(a.p.id).filter(d => d.reason !== "role_change").map(d => ({ reason: d.reason, purged: d.purged })),
        "one session end, recorded as the block's").toEqual([{ reason: "blocked", purged: 1 }]);
    } finally { await a.api.dispose(); }
  });

  test("CONTROL: blocking an admin with no live session records no session end", async () => {
    // Promoted before anyone signed in as them (the role change ends the sign-up's
    // session), so the block purges nothing: the row above comes from the purge.
    const p = await makeAdmin(sa, saCsrf, "f1blkidle");
    const before = sessionEnds(p.id);
    expect(before.map(d => d.reason), "PRECONDITION: only the promotion's session end").toEqual(["role_change"]);
    await block(p.id)();
    expect(sessionEnds(p.id), "nothing was purged, so nothing more is recorded").toEqual(before);
  });

  test("a DEMOTED admin is refused — the role is re-asked, not only the block", async () => {
    const a = await armed("f1dem");
    try {
      const r = await heldUpload({ urlPath: `/api/admin/tasks/${a.taskId}/attachments`, cookie: a.cookie, csrf: a.csrf, zip: ZIP, displayName: uniq("d"), midway: setRole(a.p.id, "participant") });
      expectRevoked(r, "demoted mid-body");
      expect(attachments(a.taskId)).toBe(0);
    } finally { await a.api.dispose(); }
  });

  test("a DELETED admin is refused, and nothing is recorded in the built-in superadmin's name", async () => {
    const a = await armed("f1del");
    const filesBefore = countFiles("attachments");
    try {
      const r = await heldUpload({ urlPath: `/api/admin/tasks/${a.taskId}/attachments`, cookie: a.cookie, csrf: a.csrf, zip: ZIP, displayName: uniq("d"),
        midway: async () => {
          const d = await sa.delete(`/api/admin/participants/${a.p.id}`, { headers: H(saCsrf) });
          expect(d.ok(), `delete: ${d.status()} ${await d.text()}`).toBeTruthy();
          expect(dbGet("SELECT 1 AS x FROM users WHERE id=?", a.p.id), "PRECONDITION: the account is gone").toBeUndefined();
        } });
      expectRevoked(r, "deleted mid-body");
      expect(attachments(a.taskId)).toBe(0);
      // getAdminIdentity falls back to "superadmin" for a session whose row has
      // vanished, so a write that got through would be misattributed there.
      expect(dbGet("SELECT COUNT(*) c FROM task_attachments WHERE task_id=? AND created_by='superadmin'", a.taskId).c).toBe(0);
      expect(countFiles("attachments")).toBe(filesBefore);
    } finally { await a.api.dispose(); }
  });

  test("an OUT-OF-BAND block (direct SQL, no session purge) is refused — the lifecycle half, the only arm that pins it", async () => {
    const a = await armed("f1oob");
    const sid = await sessionIdOf(a.api);
    try {
      const r = await heldUpload({ urlPath: `/api/admin/tasks/${a.taskId}/attachments`, cookie: a.cookie, csrf: a.csrf, zip: ZIP, displayName: uniq("d"),
        midway: async () => { dbRun("UPDATE users SET blocked=1 WHERE id=?", a.p.id); } });
      expect(sid, "PRECONDITION: the session id was read from the cookie").toBeTruthy();
      expect(dbGet("SELECT 1 AS x FROM revoked_sessions WHERE id=?", sid), "PRECONDITION: THIS session was not tombstoned").toBeUndefined();
      expectRevoked(r, "SQL-blocked mid-body");
      expect(attachments(a.taskId)).toBe(0);
    } finally { await a.api.dispose(); }
  });

  test("a sign-in ELSEWHERE mid-upload ends the session and the write — the tombstone half, the account untouched", async () => {
    const a = await armed("f1else");
    try {
      const r = await heldUpload({ urlPath: `/api/admin/tasks/${a.taskId}/attachments`, cookie: a.cookie, csrf: a.csrf, zip: ZIP, displayName: uniq("d"),
        midway: async () => { const o = await signIn(a.p.email, PARTICIPANT_PASS); await o.api.dispose(); } });
      expect(dbGet("SELECT role, blocked FROM users WHERE id=?", a.p.id), "PRECONDITION: the account itself is untouched").toEqual({ role: "admin", blocked: 0 });
      expect(r.status, r.text).toBe(401);
      expect(r.json.code).toBe("admin_session_ended");
      expect(attachments(a.taskId)).toBe(0);
    } finally { await a.api.dispose(); }
  });

  test("an unreadable tombstone table at commit refuses an admin's direct upload (fail closed), and the session survives it", async () => {
    const a = await armed("f1tbx");
    const filesBefore = countFiles("attachments");
    let renamed = false;
    try {
      const r = await heldUpload({ urlPath: `/api/admin/tasks/${a.taskId}/attachments`, cookie: a.cookie, csrf: a.csrf, zip: ZIP, displayName: uniq("d"),
        midway: async () => { dbExec("ALTER TABLE revoked_sessions RENAME TO revoked_sessions_f1tbx"); renamed = true; } });
      dbExec("ALTER TABLE revoked_sessions_f1tbx RENAME TO revoked_sessions"); renamed = false;
      expect(r.status, r.text).toBe(401);
      expect(r.json).toEqual({ error: SESSION_ENDED, code: "admin_session_ended" });
      expect(attachments(a.taskId), "nothing was attached").toBe(0);
      expect(countFiles("attachments"), "and the moved ZIP was reclaimed").toBe(filesBefore);
      expect(dbGet("SELECT role, blocked FROM users WHERE id=?", a.p.id), "the account itself is untouched").toEqual({ role: "admin", blocked: 0 });
      // Only the commit fails closed: the session was not ended by it.
      expect((await a.api.get("/api/admin/me")).status(), "the admin is still signed in").toBe(200);
    } finally {
      if (renamed) dbExec("ALTER TABLE revoked_sessions_f1tbx RENAME TO revoked_sessions");
      await a.api.dispose();
    }
  });

  test("the SAME user switching view in another tab mid-upload refuses it — without claiming they were signed out", async () => {
    // A regenerate tombstones the old session id (the v8.11.1 F1 store wrapper),
    // so the in-flight upload's session no longer exists. Refusing is right; the
    // copy must not tell someone who is still signed in to "sign in again".
    const a = await armed("f1view");
    try {
      const r = await heldUpload({ urlPath: `/api/admin/tasks/${a.taskId}/attachments`, cookie: a.cookie, csrf: a.csrf, zip: ZIP, displayName: uniq("d"),
        midway: async () => {
          const t = await a.api.post("/api/toggle-admin-view", { headers: H(a.csrf), data: { mode: "participant" } });
          expect(t.ok(), `toggle: ${t.status()} ${await t.text()}`).toBeTruthy();
        } });
      expect(r.status, r.text).toBe(401);
      expect(r.json.code).toBe("admin_session_ended");
      expect(r.json.error).toMatch(/nothing was saved/i);
      expect(r.json.error, "the user is still signed in").not.toMatch(/sign in again/i);
      expect(attachments(a.taskId)).toBe(0);
      expect((await a.api.get("/api/me")).status(), "CONTROL: the toggled session is alive — the upload's session is what ended").toBe(200);
    } finally { await a.api.dispose(); }
  });

  test("a COLLEAGUE's in-tier role change mid-upload ends the session too — and the refusal blames nobody", async () => {
    // A superadmin PROMOTES the uploading admin: the row still qualifies (admin ⇄
    // superadmin and either → event admin all pass the row check), so only the
    // tombstone arm refuses — and the first copy of that sentence told this admin
    // "you signed out, signed in elsewhere or switched view", none of which they
    // did. The copy names no cause, and its remedy holds for this case (the
    // session is gone, so they will be asked to sign in) and for the view-toggle
    // arm above (they are not asked, and the sentence does not tell them to).
    const a = await armed("f1promo");
    try {
      const r = await heldUpload({ urlPath: `/api/admin/tasks/${a.taskId}/attachments`, cookie: a.cookie, csrf: a.csrf, zip: ZIP, displayName: uniq("d"),
        midway: setRole(a.p.id, "superadmin") });
      expect(dbGet("SELECT role, blocked FROM users WHERE id=?", a.p.id), "PRECONDITION: promoted, not revoked").toEqual({ role: "superadmin", blocked: 0 });
      expect(r.status, r.text).toBe(401);
      expect(r.json.code).toBe("admin_session_ended");
      expect(r.json.error).toMatch(/nothing was saved/i);
      expect(r.json.error, "the refusal must not name a cause the admin did not take").not.toMatch(/you signed out|signed in elsewhere|switched view/i);
      expect(r.json.error, "and it names the remedy for a session that is gone").toMatch(/sign in/i);
      expect(attachments(a.taskId)).toBe(0);
      expect((await a.api.get("/api/me")).status(), "CONTROL: the colleague's change really ended this session").toBe(401);
    } finally { await a.api.dispose(); }
  });

  test("CONTROL: the built-in superadmin (no users row) still commits a held upload", async () => {
    const taskId = await makeTask(sa, saCsrf);
    const r = await heldUpload({ urlPath: `/api/admin/tasks/${taskId}/attachments`, cookie: await cookieOf(sa), csrf: saCsrf, zip: ZIP, displayName: uniq("d") });
    expect(r.status, r.text).toBe(200);
    expect(attachments(taskId)).toBe(1);
  });

  // ── The event-admin owner gate must not WIDEN ─────────────────────────────

  async function eaUploader(label) {
    const comp = await makeCompetition(sa, saCsrf, label);
    const ea = await makeParticipant(sa, saCsrf, label);
    await grantEventAdmin(sa, saCsrf, comp.id, ea.id);            // moves the role: grant BEFORE signing in
    const s = await signIn(ea.email, PARTICIPANT_PASS);
    const theirs = await makeTask(sa, saCsrf);                    // the built-in superadmin's, not the event admin's
    return { ea, ...s, cookie: await cookieOf(s.api), theirs };
  }

  test("a DEMOTED event admin cannot upload to a challenge they do not own (demotion must not widen the owner gate)", async () => {
    const e = await eaUploader("f1eadem");
    try {
      // CONTROL: untouched, the owner gate refuses them — so a 200 below could only be the widening.
      const c = await heldUpload({ urlPath: `/api/admin/tasks/${e.theirs}/attachments`, cookie: e.cookie, csrf: e.csrf, zip: ZIP, displayName: uniq("d") });
      expect(c.status, c.text).toBe(403);
      expect(c.json.code).toBe("event_admin_not_owner");
      const r = await heldUpload({ urlPath: `/api/admin/tasks/${e.theirs}/attachments`, cookie: e.cookie, csrf: e.csrf, zip: ZIP, displayName: uniq("d"), midway: setRole(e.ea.id, "participant") });
      expectRevoked(r, "event admin demoted mid-body");
      expect(attachments(e.theirs)).toBe(0);
    } finally { await e.api.dispose(); }
  });

  test("a DELETED event admin cannot upload to a challenge they do not own, and nothing lands as 'superadmin'", async () => {
    // v8.12.6 (sweep) — NO WAIT. This arm used to sleep 2.3 s mid-body, because a
    // deletion did not clear the event-admin role cache: the handler's own owner
    // gate answered from the cached 'event_admin' for up to 2 s and refused for the
    // OLD reason, so the only way to reach the shape under test — a missing row
    // reads as UNSCOPED, the one in which the unfixed tree wrote the attachment and
    // recorded it as the built-in account — was to wait the cache out.
    // `deleteUserCascade` now busts that cache by id (lib/account-reaper.js), so the
    // owner gate reads the deletion AT ONCE and the request reaches the commit-time
    // re-check with no sleep. That makes this arm the lock on the cascade's bust as
    // well: with the bust removed, the refusal arrives from the stale cache as
    // `event_admin_not_owner` and the assertion below names it. The CONTROL is the
    // demoted arm's, on the identical `eaUploader` shape: untouched, this upload is
    // refused by the owner gate, so a revoked-at-commit refusal here can only come
    // from a fresh read. It is not repeated here on purpose — the cache entry this
    // arm races is written when THIS request's headers arrive, and a control
    // request first would start that 2 s clock earlier and narrow the window in
    // which a stale entry is still there to be read.
    const e = await eaUploader("f1eadel");
    try {
      const r = await heldUpload({ urlPath: `/api/admin/tasks/${e.theirs}/attachments`, cookie: e.cookie, csrf: e.csrf, zip: ZIP, displayName: uniq("d"),
        midway: async () => {
          const d = await sa.delete(`/api/admin/participants/${e.ea.id}`, { headers: H(saCsrf) });
          expect(d.ok(), `delete: ${d.status()} ${await d.text()}`).toBeTruthy();
        } });
      expect(r.json.code, "the deletion is read at once — a stale role cache refuses for the OLD reason (event_admin_not_owner)")
        .not.toBe("event_admin_not_owner");
      expectRevoked(r, "event admin deleted mid-body");
      expect(attachments(e.theirs)).toBe(0);
      expect(dbGet("SELECT COUNT(*) c FROM task_attachments WHERE task_id=? AND created_by='superadmin'", e.theirs).c).toBe(0);
    } finally { await e.api.dispose(); }
  });

  // ── MID-BODY, the staging route (the one the editor uses) ─────────────────

  test("CONTROL: the same held staging upload from an untouched admin commits", async () => {
    const a = await armed("f1stgok");
    const name = uniq("s");
    try {
      const r = await heldUpload({ urlPath: "/api/admin/attachment-staging", cookie: a.cookie, csrf: a.csrf, zip: ZIP, displayName: name });
      expect(r.status, r.text).toBe(200);
      expect(staged(name)).toBe(1);
    } finally { await a.api.dispose(); }
  });

  test("the STAGING upload refuses the same way, and leaves no staged row or file", async () => {
    const a = await armed("f1stg");
    const name = uniq("s");
    const filesBefore = countFiles("attachments-staging");
    try {
      const r = await heldUpload({ urlPath: "/api/admin/attachment-staging", cookie: a.cookie, csrf: a.csrf, zip: ZIP, displayName: name, midway: block(a.p.id) });
      expectRevoked(r, "blocked mid-body on staging");
      expect(staged(name)).toBe(0);
      expect(countFiles("attachments-staging"), "the moved ZIP was reclaimed").toBe(filesBefore);
    } finally { await a.api.dispose(); }
  });

  test("an INSERT that fails after the staging move answers the route's own 500 and leaves no file (the _movedAbs cleanup)", async () => {
    // The v8.3.17 staging cleanup referenced a variable declared inside the try,
    // so the catch THREW: the moved ZIP was stranded and the global handler
    // answered a generic 500 instead of the route's. An ABORT trigger forces the
    // INSERT to fail after the move; dropped in a finally, because later tests in
    // this file share the database.
    const a = await armed("f1abort");
    const name = uniq("s");
    const filesBefore = countFiles("attachments-staging");
    dbExec("CREATE TRIGGER f1_abort_staging BEFORE INSERT ON task_attachments_staging BEGIN SELECT RAISE(ABORT, 'f1 forced abort'); END;");
    try {
      const r = await a.api.post("/api/admin/attachment-staging", { headers: { "x-csrf-token": a.csrf }, multipart: multipart(name, ZIP) });
      const body = await r.json().catch(() => ({}));
      expect(r.status(), JSON.stringify(body)).toBe(500);
      expect(body.error, "the ROUTE's catch answered, not the global error handler").toBe("Upload failed.");
      expect(staged(name)).toBe(0);
      expect(countFiles("attachments-staging"), "the moved ZIP was reclaimed, not stranded").toBe(filesBefore);
      await expect.poll(() => serverLogTail({ lines: 200, match: /staging upload failed/ }),
        { message: "the route's own error line was written (the log is readable, so the negative below means something)", timeout: 5000 })
        .toContain("f1 forced abort");
      expect(serverLogTail({ lines: 200, match: /_movedAbs|Unhandled error/ }), "no ReferenceError reached the global handler")
        .toMatch(/^\(no matching/);
    } finally {
      dbExec("DROP TRIGGER IF EXISTS f1_abort_staging;");
      await a.api.dispose();
    }
  });

  // ── Impersonation: BOTH people, on the path the editor uses ───────────────

  async function viaSeat(label) {
    const hand = await makeAdmin(sa, saCsrf, `${label}h`, "superadmin");
    const seat = await makeAdmin(sa, saCsrf, `${label}s`, "event_admin");
    const s = await signIn(hand.email, PARTICIPANT_PASS);
    const e = await s.api.post(`/api/admin/participants/${seat.id}/impersonate`, { headers: H(s.csrf), data: { view: "admin" } });
    expect(e.ok(), `impersonate: ${e.status()} ${await e.text()}`).toBeTruthy();
    const csrf = (await (await s.api.get("/api/csrf-token")).json()).csrfToken;
    return { hand, seat, api: s.api, csrf, cookie: await cookieOf(s.api), taskId: await makeTask(s.api, csrf) };
  }

  test("CONTROL: a superadmin's staging upload through an organiser's panel commits", async () => {
    const v = await viaSeat("f1ic");
    const name = uniq("s");
    try {
      const r = await heldUpload({ urlPath: "/api/admin/attachment-staging", cookie: v.cookie, csrf: v.csrf, zip: ZIP, displayName: name });
      expect(r.status, r.text).toBe(200);
      expect(staged(name)).toBe(1);
    } finally { await v.api.dispose(); }
  });

  test("impersonation: the HAND demoted to plain admin mid-upload is refused (a regular admin's seat is read-only)", async () => {
    const v = await viaSeat("f1ih");
    const name = uniq("s");
    try {
      const r = await heldUpload({ urlPath: "/api/admin/attachment-staging", cookie: v.cookie, csrf: v.csrf, zip: ZIP, displayName: name, midway: setRole(v.hand.id, "admin") });
      expectRevoked(r, "hand demoted mid-body");
      expect(staged(name)).toBe(0);
    } finally { await v.api.dispose(); }
  });

  test("impersonation: the SEAT demoted mid-upload answers the forced-exit shape the client already handles", async () => {
    const v = await viaSeat("f1is");
    const name = uniq("s");
    const filesBefore = countFiles("attachments-staging");
    try {
      const r = await heldUpload({ urlPath: "/api/admin/attachment-staging", cookie: v.cookie, csrf: v.csrf, zip: ZIP, displayName: name, midway: setRole(v.seat.id, "participant") });
      expect(r.status, r.text).toBe(403);
      expect(r.json).toEqual({ error: "impersonation_ended", reason: "target_inactive", code: "admin_access_revoked" });
      expect(staged(name)).toBe(0);
      expect(countFiles("attachments-staging")).toBe(filesBefore);
    } finally { await v.api.dispose(); }
  });

  test("impersonation: the SEAT demoted mid-upload on the DIRECT route answers the same whole shape", async () => {
    const v = await viaSeat("f1isd");
    try {
      const r = await heldUpload({ urlPath: `/api/admin/tasks/${v.taskId}/attachments`, cookie: v.cookie, csrf: v.csrf, zip: ZIP, displayName: uniq("d"), midway: setRole(v.seat.id, "participant") });
      expect(r.status, r.text).toBe(403);
      expect(r.json).toEqual({ error: "impersonation_ended", reason: "target_inactive", code: "admin_access_revoked" });
      expect(attachments(v.taskId)).toBe(0);
    } finally { await v.api.dispose(); }
  });

  // ── POST-BODY: the window after the ZIP walk, the hash and the move ───────

  test("POST-BODY: a direct upload parked after the move is refused when its admin is blocked there; an untouched one commits", async () => {
    const a = await armed("f1pbd");
    const filesBefore = countFiles("attachments");
    try {
      const ok = await parked(sa, () => a.api.post(`/api/admin/tasks/${a.taskId}/attachments`, { headers: { "x-csrf-token": a.csrf }, multipart: multipart(uniq("d"), ZIP) }), null);
      expect(ok.status(), `CONTROL: ${await ok.text()}`).toBe(200);
      expect(attachments(a.taskId)).toBe(1);
      const r = await parked(sa, () => a.api.post(`/api/admin/tasks/${a.taskId}/attachments`, { headers: { "x-csrf-token": a.csrf }, multipart: multipart(uniq("d"), ZIP) }), block(a.p.id));
      const body = await r.json();
      expectRevoked({ status: r.status(), json: body, text: JSON.stringify(body) }, "blocked in the post-body window");
      expect(attachments(a.taskId), "only the control's attachment exists").toBe(1);
      expect(countFiles("attachments"), "the refused upload's moved ZIP was reclaimed").toBe(filesBefore + 1);
    } finally { await a.api.dispose(); }
  });

  test("POST-BODY: a staging upload parked after the move is refused when its admin is blocked there; an untouched one commits", async () => {
    const a = await armed("f1pbs");
    const okName = uniq("s"), name = uniq("s");
    const filesBefore = countFiles("attachments-staging");
    try {
      const ok = await parked(sa, () => a.api.post("/api/admin/attachment-staging", { headers: { "x-csrf-token": a.csrf }, multipart: multipart(okName, ZIP) }), null);
      expect(ok.status(), `CONTROL: ${await ok.text()}`).toBe(200);
      expect(staged(okName)).toBe(1);
      const r = await parked(sa, () => a.api.post("/api/admin/attachment-staging", { headers: { "x-csrf-token": a.csrf }, multipart: multipart(name, ZIP) }), block(a.p.id));
      const body = await r.json();
      expectRevoked({ status: r.status(), json: body, text: JSON.stringify(body) }, "blocked in the staging post-body window");
      expect(staged(name)).toBe(0);
      expect(countFiles("attachments-staging")).toBe(filesBefore + 1);
    } finally { await a.api.dispose(); }
  });

  test("POST-BODY: the competitor lock is re-asked at commit — a challenge assigned during the window to an event the uploader competes in refuses the upload", async () => {
    // v7.21.1 A5: re-check everything the window can invalidate. The competitor
    // lock (v8.12.0, binds every tier) was asked after multer and never again.
    // A compete event admits SEALED challenges only, and a sealed challenge needs
    // a user-backed author who is NOT enrolled in the event.
    const author = await makeAdmin(sa, saCsrf, "f1cauth", "admin");
    const up = await makeAdmin(sa, saCsrf, "f1cup", "admin");
    const E = await makeCompetition(sa, saCsrf, "f1cmp", { staff_compete: true, start_time: new Date(Date.now() + 86_400_000).toISOString() });
    await enrol(sa, saCsrf, E.id, [up.id]);                        // the uploader competes in E
    const au = await signIn(author.email, PARTICIPANT_PASS);
    const u = await signIn(up.email, PARTICIPANT_PASS);
    try {
      const T = await makeTask(au.api, au.csrf, { answer_sealed: true, status: "published" });
      const T2 = await makeTask(au.api, au.csrf, { answer_sealed: true, status: "published" });
      // CONTROL: nothing is assigned during the park, so the upload commits.
      const ok = await parked(sa, () => u.api.post(`/api/admin/tasks/${T2}/attachments`, { headers: { "x-csrf-token": u.csrf }, multipart: multipart(uniq("d"), ZIP) }), null);
      expect(ok.status(), `CONTROL: ${await ok.text()}`).toBe(200);
      expect(attachments(T2)).toBe(1);
      const r = await parked(sa, () => u.api.post(`/api/admin/tasks/${T}/attachments`, { headers: { "x-csrf-token": u.csrf }, multipart: multipart(uniq("d"), ZIP) }),
        async () => { await assignTask(sa, saCsrf, T, [E.id]); });
      const body = await r.json();
      expect(r.status(), JSON.stringify(body)).toBe(403);
      expect(body.code).toBe("competitor_cannot_edit");
      expect(body.competitionId).toBe(E.id);
      expect(attachments(T)).toBe(0);
    } finally { await au.api.dispose(); await u.api.dispose(); }
  });

  test("POST-BODY: the owner gate is re-asked at commit — an OUT-OF-BAND narrowing to event admin refuses an upload to a challenge they do not own", async () => {
    // The predicate ADMITS event_admin (an organiser may upload to their own
    // challenge), and an import overwrite or direct SQL tombstones nothing, so
    // only the route's own owner re-ask — on a FRESH role, not the 2 s cache —
    // can refuse this.
    const a = await armed("f1narrow");
    const sid = await sessionIdOf(a.api);
    const theirs = await makeTask(sa, saCsrf);
    try {
      const r = await parked(sa, () => a.api.post(`/api/admin/tasks/${theirs}/attachments`, { headers: { "x-csrf-token": a.csrf }, multipart: multipart(uniq("d"), ZIP) }),
        async () => { dbRun("UPDATE users SET role='event_admin' WHERE id=?", a.p.id); }, 1000);
      const body = await r.json();
      expect(dbGet("SELECT 1 AS x FROM revoked_sessions WHERE id=?", sid), "PRECONDITION: no tombstone — only the owner re-ask can refuse").toBeUndefined();
      expect(r.status(), JSON.stringify(body)).toBe(403);
      expect(body.code).toBe("event_admin_not_owner");
      expect(attachments(theirs)).toBe(0);
      // CONTROL: the same narrowed organiser may still upload to a challenge they DO own.
      const own = await parked(sa, () => a.api.post(`/api/admin/tasks/${a.taskId}/attachments`, { headers: { "x-csrf-token": a.csrf }, multipart: multipart(uniq("d"), ZIP) }), null);
      expect(own.status(), `CONTROL: ${await own.text()}`).toBe(200);
      expect(attachments(a.taskId)).toBe(1);
    } finally { await a.api.dispose(); }
  });

  // ── The imports ───────────────────────────────────────────────────────────

  test("the TASK import: a superadmin blocked after the attachment validation imports nothing and leaves no temp file; an untouched one imports", async () => {
    const run = async (label, act) => {
      const imp = await makeAdmin(sa, saCsrf, label, "superadmin");
      const s = await signIn(imp.email, PARTICIPANT_PASS);
      const title = `F1 imported ${uniq("t")}`;
      try {
        const r = await parked(sa, () => s.api.post("/api/admin/import/tasks", { headers: H(s.csrf), data: { resolutions: {}, data: { type: "hackarena-tasks", tasks: [{
          title, difficulty: "easy", answer_type: "text", correct_answer: "x", status: "draft", description: "<p>d</p>",
          attachments: [{ display_name: "kit", original_name: "kit.zip", content_b64: ZIP.toString("base64") }] }] } } }),
          act ? act(imp.id) : null);
        return { status: r.status(), body: await r.json(), n: dbGet("SELECT COUNT(*) c FROM tasks WHERE title=?", title).c };
      } finally { await s.api.dispose(); }
    };
    const filesBefore = countFiles("attachments");
    const ok = await run("f1timpok", null);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.n, "CONTROL: an untouched superadmin's import lands the challenge").toBe(1);
    expect(countFiles("attachments"), "…and its attachment").toBe(filesBefore + 1);
    const blk = await run("f1timpblk", block);
    expectRevoked({ status: blk.status, json: blk.body, text: JSON.stringify(blk.body) }, "task import blocked at commit");
    expect(blk.n).toBe(0);
    expect(countFiles("attachments"), "no attachment was promoted").toBe(filesBefore + 1);
    expect(importTmpFiles(), "the validated temp ZIP was reclaimed").toBe(0);
  });

  test("the PARTICIPANT import: a superadmin blocked — or demoted to plain admin — before the commit grants nothing; an untouched one imports", async () => {
    const run = async (label, act) => {
      const imp = await makeAdmin(sa, saCsrf, label, "superadmin");
      const s = await signIn(imp.email, PARTICIPANT_PASS);
      const email = `f1-imp-${uniq("x")}@acme.com`.toLowerCase();
      try {
        const r = await parked(sa, () => s.api.post("/api/admin/import/participants", { headers: H(s.csrf), data: { resolutions: {}, data: { type: "hackarena-participants", participants: [{
          email, first_name: "Im", last_name: "Port", nickname: `f1i${Date.now() % 1e6}${Math.floor(Math.random() * 1e3)}`, company: "Acme", title: "Eng",
          country: "GB", timezone: "Europe/London", job_function: "Software Developer / Engineer", city: "London",
          role: "superadmin", verified: 1, approved: 1 }] } } }),
          act ? act(imp.id) : null);
        return { status: r.status(), body: await r.json(), row: dbGet("SELECT role FROM users WHERE email=?", email) };
      } finally { await s.api.dispose(); }
    };
    const ok = await run("f1impok", null);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.row, "CONTROL: an untouched superadmin's import lands the row — as a superadmin").toEqual({ role: "superadmin" });
    const blk = await run("f1impblk", block);
    expectRevoked({ status: blk.status, json: blk.body, text: JSON.stringify(blk.body) }, "participant import blocked at commit");
    expect(blk.row, "a blocked superadmin minted no account — superadmin or otherwise").toBeUndefined();
    const dem = await run("f1impdem", (id) => setRole(id, "admin"));
    expectRevoked({ status: dem.status, json: dem.body, text: JSON.stringify(dem.body) }, "participant import by a superadmin demoted to admin");
    expect(dem.row, "the import is a SUPERADMIN write: a plain admin is refused at commit too").toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v8.12.6 (review fix) — THE IMPERSONATING ADMIN IS RE-ASKED AT THE PARTICIPANT COMMIT
// ═══════════════════════════════════════════════════════════════════════════
//
// Under impersonation `req.session.userId` is the TARGET, so `participantAuthzDenied`
// (v8.11.1 F3) asks about the seat; the acting admin is read by
// `impersonationGuard` once, at the headers. Each arm parks the write AFTER that
// read and acts inside the window, then asserts the refusal's WHOLE shape (the
// one the client turns into a toast and a reload), that nothing was written, and
// the target's History — which is how the tombstone arm is told apart from the
// hand arm on a route-driven revocation: the purge has already closed the window
// (`session_purged`), and a second `impersonation_ended` would mean the refusal
// came from the hand arm, which closes it again.
const ENDED = "impersonation_ended";
function endedWindows(uid) {
  const d = new Database(TEST_DB_PATH, { readonly: true });
  try {
    return d.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='impersonation_ended' ORDER BY changed_at")
      .all(uid).map(r => { try { return JSON.parse(r.details).reason; } catch { return null; } });
  } finally { d.close(); }
}

test.describe("v8.12.6 (review fix) — an admin revoked while impersonating cannot finish the participant's write", () => {
  let sa, saCsrf, compId, fileTaskId;
  test.beforeAll(async () => {
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    compId = (await makeCompetition(sa, saCsrf, "f1imp")).id;
    // A FILE answer: `submit-read-delay` parks inside the file branch only.
    const fileBank = await makeTask(sa, saCsrf, { answer_type: "file", correct_answer: "win", status: "published" });
    fileTaskId = (await assignTask(sa, saCsrf, fileBank, [compId])).copies[0].task_id;   // the event's own copy: the row an answer names
    // A bystander who never answers, so the control's correct submission can
    // never be the one that finishes the event (fixture checklist item 1).
    const by = await makeParticipant(sa, saCsrf, "f1impby");
    await enrol(sa, saCsrf, compId, [by.id]);
  });
  test.afterAll(async () => {
    await sa?.post("/api/test/submit-read-delay", { headers: H(saCsrf), data: { delayMs: 0 } }).catch(() => {});
    await sa?.dispose();
  });

  /** A user-backed admin of `role`, impersonating a fresh participant enrolled in `comp`. */
  const seat = (label, role, comp = compId) => seatOf(sa, saCsrf, label, role, comp);
  async function enter(v, comp = compId) {
    const sel = await v.api.post("/api/select-competition", { headers: H(v.csrf), data: { competitionId: comp } });
    expect(sel.ok(), `select-competition: ${sel.status()} ${await sel.text()}`).toBeTruthy();
  }
  const fileSubmit = async (v) => {
    const hash = await gradingHashFor(v.api, fileTaskId);
    expect(hash, "PRECONDITION: the challenge is readable through the seat").toBeTruthy();
    return v.api.post(`/api/tasks/${fileTaskId}/submit`, { headers: { "x-csrf-token": v.csrf },
      multipart: { gradingHash: hash, file: { name: "answer.txt", mimeType: "text/plain", buffer: Buffer.from("win") } } });
  };
  /** The file answer parked inside its read window (`parked` is the readiness signal), `act` run there. */
  async function parkedSubmit(v, act) {
    await enter(v);
    const arm = await sa.post("/api/test/submit-read-delay", { headers: H(saCsrf), data: { delayMs: 2000 } });
    expect(arm.ok(), "arm the file-read park").toBeTruthy();
    try {
      const pending = fileSubmit(v);
      const t0 = Date.now();
      for (;;) {
        const n = (await (await sa.get("/api/test/submit-read-delay")).json()).parked;
        if (n >= 1) break;
        if (Date.now() - t0 > 10_000) throw new Error("PRECONDITION: the submission never reached the file-read park");
        await new Promise(r => setTimeout(r, 25));
      }
      if (act) await act();
      const r = await pending;
      const json = await r.json().catch(() => ({}));
      return { status: r.status(), json, text: JSON.stringify(json) };
    } finally {
      await sa.post("/api/test/submit-read-delay", { headers: H(saCsrf), data: { delayMs: 0 } }).catch(() => {});
    }
  }
  const wrote = (uid) => dbGet("SELECT COUNT(*) c, COALESCE(SUM(points_delta),0) pts FROM submissions WHERE user_id=? AND task_id=?", uid, fileTaskId);
  /** challenge_events are written on a deferred tick: a later answered request proves the tick has run. */
  async function settledChallengeEvents(uid) {
    await sa.get("/api/test/submit-read-delay");
    return dbGet("SELECT COUNT(*) c FROM challenge_events WHERE user_id=? AND task_id=?", uid, fileTaskId).c;
  }
  const blockRoute = (id) => async () => {
    const r = await sa.post(`/api/admin/participants/${id}/block`, { headers: H(saCsrf) });
    expect(r.ok(), `block: ${await r.text()}`).toBeTruthy();
    expect((await r.json()).blocked, "the block TOOK (the route is a toggle)").toBe(1);
  };
  const roleRoute = (id, role) => async () => {
    const r = await sa.post(`/api/admin/participants/${id}/role`, { headers: H(saCsrf), data: { role } });
    expect(r.ok(), `role ${role}: ${await r.text()}`).toBeTruthy();
  };
  const expectEnded = async (v, r, reason, what) => {
    expect(r.status, `${what}: ${r.text}`).toBe(403);
    expect(r.json, `${what}: the forced-exit shape the client turns into a toast and a reload`)
      .toEqual({ error: ENDED, reason, code: reason === "session_ended" ? "admin_session_ended" : "admin_access_revoked" });
    const w = wrote(v.p.id);
    expect(w.c, `${what}: no submission row`).toBe(0);
    expect(w.pts, `${what}: no score`).toBe(0);
    expect(await settledChallengeEvents(v.p.id), `${what}: no challenge event`).toBe(0);
  };

  // ── the file-answer submit ────────────────────────────────────────────────

  test("CONTROL: an untouched superadmin's parked file answer, through the seat, commits and scores", async () => {
    const v = await seat("f1ik", "superadmin");
    try {
      const r = await parkedSubmit(v, null);
      expect(r.status, r.text).toBe(200);
      expect(r.json.correct, "the answer was graded").toBe(true);
      expect(r.json.pointsDelta).toBeGreaterThan(0);
      expect(wrote(v.p.id).c).toBe(1);
      await expect.poll(() => settledChallengeEvents(v.p.id), { message: "the solve's challenge event lands (so the refusal arms' zero means something)", timeout: 5000 })
        .toBeGreaterThan(0);
      expect(endedWindows(v.p.id), "the window is still open").toEqual([]);
    } finally { await v.api.dispose(); }
  });

  test("the superadmin BLOCKED through the route mid-upload: refused, nothing written, the window closed once", async () => {
    const v = await seat("f1ib", "superadmin");
    try {
      const r = await parkedSubmit(v, blockRoute(v.hand.id));
      expect(dbGet("SELECT 1 AS x FROM revoked_sessions WHERE id=?", v.sid), "PRECONDITION: the route tombstoned the session").toBeTruthy();
      await expectEnded(v, r, "session_ended", "blocked through the route");
      // The purge closed the window; a refusal from the hand arm would close it AGAIN.
      expect(endedWindows(v.p.id), "one impersonation_ended, the purge's own").toEqual(["session_purged"]);
    } finally { await v.api.dispose(); }
  });

  test("the superadmin blocked OUT OF BAND (direct SQL, no tombstone) mid-upload: refused by the hand arm, the session ended", async () => {
    const v = await seat("f1iq", "superadmin");
    try {
      const r = await parkedSubmit(v, async () => {
        dbRun("UPDATE users SET blocked=1 WHERE id=?", v.hand.id);
        // Checked HERE, inside the window: once refused, the session is destroyed,
        // and a destroy tombstones it too (the v8.11.1 F1 store wrapper).
        expect(dbGet("SELECT 1 AS x FROM revoked_sessions WHERE id=?", v.sid), "PRECONDITION: THIS session was not tombstoned").toBeUndefined();
      });
      await expectEnded(v, r, "actor_inactive", "blocked by SQL");
      expect(endedWindows(v.p.id), "the refusal closed the target's window itself").toEqual(["actor_inactive"]);
      expect((await v.api.get("/api/me")).status(), "no admin identity to hand back: the session is gone").toBe(401);
    } finally { await v.api.dispose(); }
  });

  test("the superadmin DEMOTED through the route mid-upload: refused (the role change ended the session)", async () => {
    const v = await seat("f1id", "superadmin");
    try {
      const r = await parkedSubmit(v, roleRoute(v.hand.id, "admin"));
      await expectEnded(v, r, "session_ended", "demoted through the route");
      expect(endedWindows(v.p.id)).toEqual(["session_purged"]);
    } finally { await v.api.dispose(); }
  });

  test("the superadmin demoted to plain admin OUT OF BAND mid-upload: the read-only tier's own refusal, the session kept", async () => {
    // What the guard answers a regular admin's write at the headers — so the
    // commit gives the same answer, and does not sign out someone still an admin.
    const v = await seat("f1ir", "superadmin");
    try {
      const r = await parkedSubmit(v, async () => { dbRun("UPDATE users SET role='admin' WHERE id=?", v.hand.id); });
      expect(r.status, r.text).toBe(403);
      expect(r.json).toEqual({ error: "Not allowed in impersonation mode", code: "impersonation_readonly" });
      expect(wrote(v.p.id).c).toBe(0);
      expect(await settledChallengeEvents(v.p.id)).toBe(0);
      expect(endedWindows(v.p.id), "nothing ended").toEqual([]);
      const me = await v.api.get("/api/me");
      expect(me.status(), "CONTROL: still signed in").toBe(200);
      expect((await me.json()).impersonation?.active, "and still looking through the seat").toBe(true);
    } finally { await v.api.dispose(); }
  });

  test("a sign-in ELSEWHERE by the impersonating superadmin mid-upload: refused by the tombstone alone, the account untouched", async () => {
    const v = await seat("f1ie", "superadmin");
    try {
      const r = await parkedSubmit(v, async () => { const o = await signIn(v.hand.email, PARTICIPANT_PASS); await o.api.dispose(); });
      expect(dbGet("SELECT role, blocked FROM users WHERE id=?", v.hand.id), "PRECONDITION: the hand still qualifies").toEqual({ role: "superadmin", blocked: 0 });
      await expectEnded(v, r, "session_ended", "signed in elsewhere");
      expect(endedWindows(v.p.id)).toEqual(["session_purged"]);
    } finally { await v.api.dispose(); }
  });






  // ── the certificate mint ──────────────────────────────────────────────────

  /** An ENDED event whose sole participant finished it — the shape a mint needs. */
  async function endedWithFinisher(label) {
    const comp = await makeCompetition(sa, saCsrf, `${label}c`);
    const t = await makeTask(sa, saCsrf, { status: "published", correct_answer: "k" });
    await assignTask(sa, saCsrf, t, [comp.id]);
    return { comp, t };
  }
  async function finish(fx, p) {
    const s = await signIn(p.email, PARTICIPANT_PASS);
    try {
      const sel = await s.api.post("/api/select-competition", { headers: H(s.csrf), data: { competitionId: fx.comp.id } });
      expect(sel.ok()).toBeTruthy();
      const sub = await s.api.post(`/api/tasks/${fx.t}/submit`, { headers: H(s.csrf), data: { answer: "k", gradingHash: await gradingHashFor(s.api, fx.t) } });
      expect((await sub.json()).correct, "PRECONDITION: the participant finished").toBe(true);
    } finally { await s.api.dispose(); }
    expect(dbGet("SELECT ended_at FROM competitions WHERE id=?", fx.comp.id).ended_at, "PRECONDITION: the all-solved auto-end fired").toBeTruthy();
  }
  async function mintSeat(label, role) {
    const fx = await endedWithFinisher(label);
    const v = await seat(label, role, fx.comp.id);
    await finish(fx, v.p);
    return { ...v, fx };
  }
  const badges = (v) => dbGet("SELECT COUNT(*) c FROM achievement_badges WHERE user_id=? AND competition_id=?", v.p.id, v.fx.comp.id).c;
  const mint = (v) => v.api.post(`/api/competitions/${v.fx.comp.id}/badge`, { headers: H(v.csrf) });

  test("CONTROL: a REGULAR admin's read-only seat still mints when untouched (the one write that tier may make)", async () => {
    const v = await mintSeat("f1mk", "admin");
    try {
      const r = await parked(sa, () => mint(v), null);
      expect(r.status(), await r.text()).toBe(200);
      expect(badges(v)).toBe(1);
    } finally { await v.api.dispose(); }
  });

  test("the certificate mint: a superadmin blocked OUT OF BAND after the render mints nothing", async () => {
    const v = await mintSeat("f1mq", "superadmin");
    try {
      const r = await parked(sa, () => mint(v), async () => { dbRun("UPDATE users SET blocked=1 WHERE id=?", v.hand.id); });
      const body = await r.json();
      expect(r.status(), JSON.stringify(body)).toBe(403);
      expect(body).toEqual({ error: ENDED, reason: "actor_inactive", code: "admin_access_revoked" });
      expect(badges(v), "no certificate was minted").toBe(0);
    } finally { await v.api.dispose(); }
  });

  test("the certificate mint: a regular admin blocked through the route after the render mints nothing", async () => {
    const v = await mintSeat("f1mb", "admin");
    try {
      const r = await parked(sa, () => mint(v), blockRoute(v.hand.id));
      const body = await r.json();
      expect(r.status(), JSON.stringify(body)).toBe(403);
      expect(body).toEqual({ error: ENDED, reason: "session_ended", code: "admin_session_ended" });
      expect(badges(v)).toBe(0);
    } finally { await v.api.dispose(); }
  });
});

