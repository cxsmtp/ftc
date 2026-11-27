// HOW AN ACCOUNT SIGNS IN — a password or an emailed code (operator ruling,
// 11 Nov 2026; lib/login-method.js, routes/auth.js). Locked here, on the wire:
//   * the ROLE decides until the person chooses: an unscoped admin role signs in
//     with a password, every other role with a code; a promotion moves a NULL
//     default and never a stored choice;
//   * POST /api/auth/sign-in-method says which step the entry screen shows, and
//     gives EVERY non-address the same password-only answer (the break-glass
//     username is never confirmed);
//   * POST /api/auth/password signs in only an account whose method is
//     `password` and that set one — an account upgraded from v8.14.x keeps the
//     password it had (operator ruling) — charges the one lockout budget on a
//     wrong password, clears it on a right one, and discloses pending approval
//     or a missing verification only after a correct password;
//   * PUT /api/me/sign-in-method sets the password when the method is chosen,
//     and changing one needs the current password or a code sign-in in the last
//     ten minutes; setting or changing one mails a notice;
//   * the built-in superadmin has no /break-glass page any more and no account
//     door: /api/login is its door alone, typed on the ordinary card;
//   * the kick popup's advice follows the method.
// Every refusal has a control of the same shape that succeeds.
const { test, expect } = require("./isolated-test");
const bcrypt = require("bcrypt");
const { freshCtx, getSuperadminPass, codeLogin, TEST_DB_PATH } = require("./helpers");
const { makeParticipant } = require("./event-admin-helpers");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const PW = "correct horse battery";

function dbRun(fn, readonly = false) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, readonly ? { readonly: true } : {});
  try { return fn(db); } finally { db.close(); }
}
const row = (id) => dbRun((db) => db.prepare("SELECT * FROM users WHERE id=?").get(id), true);
/** A password set the way a v8.14.x account has one: a bcrypt hash and password_set_at. */
function plantPassword(id, plain) {
  dbRun((db) => db.prepare("UPDATE users SET password_hash=?, password_set_at=? WHERE id=?")
    .run(bcrypt.hashSync(plain, 4), new Date().toISOString(), id));
}
async function token(api) { return (await (await api.get("/api/csrf-token")).json()).csrfToken; }
async function builtin() {
  const { api, csrf } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(csrf), data: { username: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `built-in sign-in: ${r.status()}`).toBeTruthy();
  return { api, csrf: await token(api) };
}
async function setRole(bg, id, role) {
  const r = await bg.api.post(`/api/admin/participants/${id}/role`, { headers: H(bg.csrf), data: { role } });
  expect(r.ok(), `role ${role}: ${r.status()} ${await r.text()}`).toBeTruthy();
}
async function anon() { const { api, csrf } = await freshCtx(); return { api, csrf }; }
async function methodOf(email) {
  const a = await anon();
  try {
    const r = await a.api.post("/api/auth/sign-in-method", { headers: H(a.csrf), data: { email } });
    expect(r.status(), `sign-in-method ${email}`).toBe(200);
    return r.json();
  } finally { await a.api.dispose(); }
}
async function passwordSignIn(api, csrf, email, password) {
  const r = await api.post("/api/auth/password", { headers: H(csrf), data: { email, password } });
  expect(r.status(), `password door answers 200 for every outcome (${email})`).toBe(200);
  return r.json();
}
async function codeSession(email) {
  const { api, csrf } = await freshCtx();
  const li = await codeLogin(api, email, H(csrf));
  expect(li.ok(), `code sign-in ${email}: ${li.status()}`).toBeTruthy();
  return { api, csrf: await token(api), body: await li.json() };
}
const eventsOf = (userId, type) => dbRun((db) => db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type=? ORDER BY rowid").all(userId, type), true)
  .map((r) => JSON.parse(r.details || "{}"));
async function pollEvent(userId, type, pred = () => true) {
  let found = null;
  await expect.poll(() => {
    const rows = dbRun((db) => db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type=? ORDER BY rowid DESC").all(userId, type), true);
    found = rows.map((r) => JSON.parse(r.details || "{}")).find(pred) || null;
    return !!found;
  }, { message: `${type} event for ${userId}`, timeout: 10_000 }).toBe(true);
  return found;
}

test.describe("sign-in method — defaults, the entry step and the password door", () => {
  test("the role decides until the person chooses; a promotion moves only a NULL default", async () => {
    const bg = await builtin();
    try {
      const p = await makeParticipant(bg.api, bg.csrf, "lm-part");
      const a = await makeParticipant(bg.api, bg.csrf, "lm-admin");
      const e = await makeParticipant(bg.api, bg.csrf, "lm-chose");
      await setRole(bg, a.id, "admin");
      // Participant: code. Admin with no password: password, not yet set.
      expect(await methodOf(p.email)).toEqual({ ok: true, method: "code" });
      expect(await methodOf(a.email)).toEqual({ ok: true, method: "password", code_offered: true, password_set: false });
      // An unknown work address and a malformed one: the code step, like a participant.
      expect(await methodOf(`nobody-${Date.now()}@acme.com`)).toEqual({ ok: true, method: "code" });
      // EVERY non-address gets the same password-only answer: the break-glass
      // name is never confirmed (control: an arbitrary word answers identically).
      const bgName = await methodOf("superadmin");
      expect(bgName).toEqual({ ok: true, method: "password", code_offered: false });
      expect(await methodOf("not-the-name")).toEqual(bgName);
      // A blocked admin answers like a code account (nothing to sign in with).
      const blk = await makeParticipant(bg.api, bg.csrf, "lm-blocked");
      await setRole(bg, blk.id, "admin");
      expect((await methodOf(blk.email)).method).toBe("password");
      dbRun((db) => db.prepare("UPDATE users SET blocked=1 WHERE id=?").run(blk.id));
      expect(await methodOf(blk.email)).toEqual({ ok: true, method: "code" });

      // A stored choice survives a promotion; a NULL default follows it.
      const es = await codeSession(e.email);
      const put = await es.api.put("/api/me/sign-in-method", { headers: H(es.csrf), data: { method: "code" } });
      expect(put.status(), await put.text()).toBe(200);
      expect((await put.json()).login_method_is_default).toBe(false);
      await setRole(bg, e.id, "admin");
      await setRole(bg, p.id, "admin");
      expect((await methodOf(e.email)).method, "a stored choice is the person's, whatever the role").toBe("code");
      expect((await methodOf(p.email)).method, "control: a NULL default follows the promotion").toBe("password");
      await es.api.dispose();
    } finally { await bg.api.dispose(); }
  });

  test("an upgraded account's password signs in; wrong ones lock; a correct one clears the lock", async () => {
    const bg = await builtin();
    try {
      const a = await makeParticipant(bg.api, bg.csrf, "lm-upgraded");
      await setRole(bg, a.id, "admin");
      plantPassword(a.id, PW);
      expect(await methodOf(a.email)).toEqual({ ok: true, method: "password", code_offered: true, password_set: true });
      const x = await anon();
      // Wrong passwords: {ok:false}, counted on the account's ONE budget.
      const wrong = await passwordSignIn(x.api, x.csrf, a.email, "not it");
      expect(wrong).toEqual({ ok: false });
      const unknown = await passwordSignIn(x.api, x.csrf, `ghost-${Date.now()}@acme.com`, "not it");
      expect(JSON.stringify(unknown), "an unknown address answers exactly like a wrong password").toBe(JSON.stringify(wrong));
      expect(row(a.id).failed_login_count).toBe(1);
      for (let i = 2; i <= 9; i++) await passwordSignIn(x.api, x.csrf, a.email, `nope-${i}`);
      expect(row(a.id).locked_until, "PRECONDITION: nine wrong passwords do not lock").toBeNull();
      expect(eventsOf(a.id, "auto_locked"), "nor record a lock").toEqual([]);
      await passwordSignIn(x.api, x.csrf, a.email, "nope-10");
      const locked = row(a.id);
      expect(locked.locked_until, "the tenth wrong password locks the account").toBeTruthy();
      expect(locked.failed_login_count).toBe(10);
      const lockEvents = eventsOf(a.id, "auto_locked");
      expect(lockEvents.map((d) => ({ method: d.method, failed_count: d.failed_count, until: !!d.until })),
        "…and records the lock once, naming the door").toEqual([{ method: "password", failed_count: 10, until: true }]);
      expect(lockEvents[0].ip, "with the request context").toBeTruthy();
      // A guess while locked is not counted again, nor recorded as a second lock.
      await passwordSignIn(x.api, x.csrf, a.email, "still wrong");
      expect(row(a.id).failed_login_count).toBe(10);
      expect(eventsOf(a.id, "auto_locked").length, "no second lock is recorded").toBe(1);
      // The correct password is honoured while locked and clears the lock.
      const ok = await passwordSignIn(x.api, x.csrf, a.email, PW);
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
      expect(ok.role).toBe("admin");
      expect(ok).toMatchObject({ login_method: "password", has_password: true, password_required: false });
      const after = row(a.id);
      expect(after.locked_until).toBeNull();
      expect(after.failed_login_count).toBe(0);
      expect((await x.api.get("/api/admin/me")).status(), "the session is real").toBe(200);
      const ev = await pollEvent(a.id, "login_success", (d) => d.method === "password");
      expect(ev.ip, "a user-caused sign-in carries the request context").toBeTruthy();
      await pollEvent(a.id, "auto_unlocked", (d) => d.reason === "correct_password");
      await x.api.dispose();
    } finally { await bg.api.dispose(); }
  });

  test("a code account's password signs nobody in; choosing password brings it back", async () => {
    const bg = await builtin();
    try {
      const p = await makeParticipant(bg.api, bg.csrf, "lm-codeacct");
      plantPassword(p.id, PW);      // an old v8.14.x password on a participant (default: code)
      const x = await anon();
      expect(await passwordSignIn(x.api, x.csrf, p.email, PW)).toEqual({ ok: false });
      await pollEvent(p.id, "login_failed", (d) => d.reason === "password_not_in_use");
      expect(row(p.id).failed_login_count, "a password at a code account is not a guess at anything").toBe(0);
      // Choosing password with one already set needs nothing new.
      const s = await codeSession(p.email);
      const put = await s.api.put("/api/me/sign-in-method", { headers: H(s.csrf), data: { method: "password" } });
      expect(put.status(), await put.text()).toBe(200);
      expect(await put.json()).toMatchObject({ ok: true, login_method: "password", has_password: true, password_required: false });
      const ok = await passwordSignIn(x.api, x.csrf, p.email, PW);
      expect(ok.ok, "control: the same password signs in once the method is password").toBe(true);
      // Back to codes: the password is kept but refused again.
      const s2 = await codeSession(p.email);
      const back = await s2.api.put("/api/me/sign-in-method", { headers: H(s2.csrf), data: { method: "code" } });
      expect(back.status()).toBe(200);
      const y = await anon();
      expect(await passwordSignIn(y.api, y.csrf, p.email, PW)).toEqual({ ok: false });
      expect(row(p.id).password_hash.startsWith("$2"), "switching to codes keeps the stored password").toBe(true);
      await Promise.all([x.api.dispose(), y.api.dispose(), s.api.dispose(), s2.api.dispose()]);
    } finally { await bg.api.dispose(); }
  });

  test("choosing a password sets it; a change needs the current one or a fresh code sign-in", async () => {
    const bg = await builtin();
    try {
      const p = await makeParticipant(bg.api, bg.csrf, "lm-setpw");
      const a = await codeSession(p.email);
      const put = (s, data) => s.api.put("/api/me/sign-in-method", { headers: H(s.csrf), data });
      // Password chosen with none set and none sent: refused, nothing stored.
      let r = await put(a, { method: "password" });
      expect(r.status()).toBe(400);
      expect((await r.json()).code).toBe("password_required");
      r = await put(a, { method: "password", password: "short" });
      expect((await r.json()).code).toBe("password_invalid");
      r = await put(a, { method: "code", password: "longenough1" });
      expect((await r.json()).code).toBe("password_not_used");
      r = await put(a, { method: "nonsense" });
      expect((await r.json()).code).toBe("login_method_invalid");
      r = await put(a, { method: ["password"] });
      expect(r.status(), "a non-text field is refused, never a 500").toBe(400);
      expect(row(p.id).login_method).toBeNull();
      // The first password: set with the method.
      r = await put(a, { method: "password", password: PW });
      expect(r.status(), await r.text()).toBe(200);
      expect(await r.json()).toMatchObject({ login_method: "password", has_password: true, password_required: false, login_method_is_default: false });
      await pollEvent(p.id, "password_set");
      await pollEvent(p.id, "login_method_changed", (d) => d.to === "password" && d.from === null);
      await pollEvent(p.id, "email_sent", (d) => d.reason === "password_changed_notification");
      // C signs in with the password (not a code): a change needs the current one.
      const c = await anon();
      expect((await passwordSignIn(c.api, c.csrf, p.email, PW)).ok).toBe(true);
      const cs = { api: c.api, csrf: await token(c.api) };
      r = await put(cs, { method: "password", password: "a new password 1" });
      expect((await r.json()).code).toBe("current_password_required");
      r = await put(cs, { method: "password", password: "a new password 1", currentPassword: "wrong one" });
      expect((await r.json()).code).toBe("current_password_wrong");
      expect(row(p.id).failed_login_count, "a wrong current password is a guess like any other").toBe(1);
      r = await put(cs, { method: "password", password: "a new password 1", currentPassword: PW });
      expect(r.status(), await r.text()).toBe(200);
      await pollEvent(p.id, "password_changed");
      await pollEvent(p.id, "email_sent", (d) => d.reason === "password_changed_notification" && /changed/.test(d.subject || ""));
      expect((await c.api.get("/api/me")).status(), "the changing session stays signed in").toBe(200);
      // A fresh CODE sign-in may change it without the current password (the
      // recovery for a forgotten one).
      const d = await codeSession(p.email);
      r = await put(d, { method: "password", password: "after a code 2" });
      expect(r.status(), await r.text()).toBe(200);
      const z = await anon();
      expect((await passwordSignIn(z.api, z.csrf, p.email, "a new password 1")).ok, "the old password no longer works").toBe(false);
      expect((await passwordSignIn(z.api, z.csrf, p.email, "after a code 2")).ok, "control: the new one does").toBe(true);
      await Promise.all([a.api.dispose(), c.api.dispose(), d.api.dispose(), z.api.dispose()]);
    } finally { await bg.api.dispose(); }
  });

  test("only an EMAILED code opens the forgotten-password window; a view switch keeps it", async () => {
    const bg = await builtin();
    try {
      // A desk code (read out by an organiser) proves nothing about the inbox.
      const p = await makeParticipant(bg.api, bg.csrf, "lm-deskwin");
      plantPassword(p.id, PW);
      dbRun((db) => db.prepare("UPDATE users SET login_method='password' WHERE id=?").run(p.id));
      const rv = await bg.api.post(`/api/admin/participants/${p.id}/login-code/reveal`, { headers: H(bg.csrf) });
      expect(rv.status()).toBe(200);
      const d = await freshCtx();
      const rd = await d.api.post("/api/auth/code/redeem", { headers: H(d.csrf), data: { email: p.email, code: (await rv.json()).code } });
      expect((await rd.json()).ok, "the desk code signs in").toBe(true);
      const dt = await token(d.api);
      const r1 = await d.api.put("/api/me/sign-in-method", { headers: H(dt), data: { method: "password", password: "changed by desk 1" } });
      expect((await r1.json()).code, "a desk-code session must give the current password").toBe("current_password_required");
      // An emailed-code session may, and keeps that window across a view switch.
      const a = await makeParticipant(bg.api, bg.csrf, "lm-togglewin");
      await setRole(bg, a.id, "admin");
      plantPassword(a.id, PW);
      const s = await codeSession(a.email);
      for (const mode of ["participant", "admin"]) {
        const t = await s.api.post("/api/toggle-admin-view", { headers: H(await token(s.api)), data: { mode } });
        expect(t.ok(), `toggle to ${mode}: ${await t.text()}`).toBeTruthy();
      }
      const r2 = await s.api.put("/api/me/sign-in-method", { headers: H(await token(s.api)), data: { method: "password", password: "changed after code 2" } });
      expect(r2.status(), await r2.text()).toBe(200);
      await Promise.all([d.api.dispose(), s.api.dispose()]);
    } finally { await bg.api.dispose(); }
  });

  test("an admin with no password signs in by code, is told it owes one, and may keep codes", async () => {
    const bg = await builtin();
    try {
      const a = await makeParticipant(bg.api, bg.csrf, "lm-noset");
      await setRole(bg, a.id, "admin");
      const s = await codeSession(a.email);
      expect(s.body).toMatchObject({ ok: true, login_method: "password", has_password: false, password_required: true, login_method_is_default: true });
      const me = await (await s.api.get("/api/admin/me")).json();
      expect(me.password_required, "the admin shell learns it too").toBe(true);
      const r = await s.api.put("/api/me/sign-in-method", { headers: H(s.csrf), data: { method: "code" } });
      expect(r.status()).toBe(200);
      expect(await r.json()).toMatchObject({ login_method: "code", password_required: false, login_method_is_default: false });
      expect(await methodOf(a.email)).toEqual({ ok: true, method: "code" });
      // A password-method admin with none set cannot sign in with any password.
      const b = await makeParticipant(bg.api, bg.csrf, "lm-noset2");
      await setRole(bg, b.id, "admin");
      const x = await anon();
      expect(await passwordSignIn(x.api, x.csrf, b.email, "")).toEqual({ ok: false });
      expect(await passwordSignIn(x.api, x.csrf, b.email, "anything at all")).toEqual({ ok: false });
      await pollEvent(b.id, "login_failed", (d) => d.reason === "no_password");
      await Promise.all([s.api.dispose(), x.api.dispose()]);
    } finally { await bg.api.dispose(); }
  });

  test("pending, unverified, blocked and denied: reasons only after a correct password", async () => {
    const bg = await builtin();
    try {
      const p = await makeParticipant(bg.api, bg.csrf, "lm-life");
      await setRole(bg, p.id, "admin");
      plantPassword(p.id, PW);
      const x = await anon();
      dbRun((db) => db.prepare("UPDATE users SET approved=0 WHERE id=?").run(p.id));
      expect(await passwordSignIn(x.api, x.csrf, p.email, "wrong")).toEqual({ ok: false });
      expect(await passwordSignIn(x.api, x.csrf, p.email, PW)).toEqual({ ok: false, error: "pending_approval" });
      dbRun((db) => db.prepare("UPDATE users SET approved=1, verified=0, self_enroll_grace_until=NULL WHERE id=?").run(p.id));
      expect(await passwordSignIn(x.api, x.csrf, p.email, PW)).toEqual({ ok: false, error: "verify_by_code" });
      dbRun((db) => db.prepare("UPDATE users SET verified=1, blocked=1 WHERE id=?").run(p.id));
      expect(await passwordSignIn(x.api, x.csrf, p.email, PW), "blocked: no reason given").toEqual({ ok: false });
      dbRun((db) => db.prepare("UPDATE users SET blocked=0, denied_at=? WHERE id=?").run(new Date().toISOString(), p.id));
      expect(await passwordSignIn(x.api, x.csrf, p.email, PW), "denied: no reason given").toEqual({ ok: false });
      dbRun((db) => db.prepare("UPDATE users SET denied_at=NULL WHERE id=?").run(p.id));
      expect((await passwordSignIn(x.api, x.csrf, p.email, PW)).ok, "control: the same password, account restored").toBe(true);
      await x.api.dispose();
    } finally { await bg.api.dispose(); }
  });

  test("the built-in superadmin: no /break-glass page, its door is /api/login alone", async () => {
    const bg = await builtin();
    try {
      const { api } = await freshCtx();
      expect((await api.get("/break-glass")).status(), "the special page is gone").toBe(404);
      expect((await api.get("/")).status(), "control: the sign-in page is served").toBe(200);
      const a = await makeParticipant(bg.api, bg.csrf, "lm-door");
      await setRole(bg, a.id, "admin");
      plantPassword(a.id, PW);
      const x = await anon();
      // An account's password is no good at the break-glass door…
      const viaLogin = await x.api.post("/api/login", { headers: H(x.csrf), data: { username: a.email, password: PW } });
      expect(viaLogin.status()).toBe(401);
      // …and the break-glass password is no good at the account door.
      expect(await passwordSignIn(x.api, x.csrf, "superadmin", getSuperadminPass())).toEqual({ ok: false });
      // Control: each door signs in its own.
      expect((await passwordSignIn(x.api, x.csrf, a.email, PW)).ok).toBe(true);
      const y = await anon();
      const ok = await y.api.post("/api/login", { headers: H(y.csrf), data: { username: "SuperAdmin", password: getSuperadminPass() } });
      expect(ok.status()).toBe(200);
      expect((await ok.json()).isBreakglass).toBe(true);
      await Promise.all([api.dispose(), x.api.dispose(), y.api.dispose()]);
    } finally { await bg.api.dispose(); }
  });

  test("the kick popup's advice follows the method", async () => {
    const bg = await builtin();
    try {
      const pa = await makeParticipant(bg.api, bg.csrf, "lm-kick-pw");
      await setRole(bg, pa.id, "admin");
      plantPassword(pa.id, PW);
      const pc = await makeParticipant(bg.api, bg.csrf, "lm-kick-code");
      const kicked = async (signIn) => {
        const first = await signIn();
        await signIn();
        const st = await (await first.get("/api/session/status")).json();
        await first.dispose();
        return st;
      };
      const pwSt = await kicked(async () => { const x = await anon(); expect((await passwordSignIn(x.api, x.csrf, pa.email, PW)).ok).toBe(true); return x.api; });
      expect(pwSt.reason).toBe("kicked");
      expect(pwSt.kicked_by.passwordless, "a password account is told to change its password").toBe(false);
      const codeSt = await kicked(async () => (await codeSession(pc.email)).api);
      expect(codeSt.kicked_by.passwordless, "control: a code account is told to guard its inbox").toBe(true);
    } finally { await bg.api.dispose(); }
  });

  test("a credential is the owner's: blocked under impersonation for every tier", async () => {
    const bg = await builtin();
    try {
      const p = await makeParticipant(bg.api, bg.csrf, "lm-imp");
      const imp = await bg.api.post(`/api/admin/participants/${p.id}/impersonate`, { headers: H(bg.csrf), data: {} });
      expect(imp.ok(), await imp.text()).toBeTruthy();
      const t = await token(bg.api);
      const impMe = await (await bg.api.get("/api/me")).json();
      expect(impMe.impersonation && impMe.impersonation.active, "PRECONDITION: impersonating").toBe(true);
      for (const k of ["login_method", "has_password", "password_required", "login_method_is_default"]) {
        expect(k in impMe, `${k} is withheld under impersonation`).toBe(false);
      }
      const r = await bg.api.put("/api/me/sign-in-method", { headers: H(t), data: { method: "password", password: PW } });
      expect(r.status(), await r.text()).toBe(403);
      const pw = await bg.api.post("/api/auth/password", { headers: H(t), data: { email: p.email, password: PW } });
      expect(pw.status()).toBe(403);
      expect(row(p.id).password_set_at, "nothing was set on the target").toBeNull();
      // Control: the owner sees the fields and sets the password.
      const s = await codeSession(p.email);
      expect((await (await s.api.get("/api/me")).json()).login_method).toBe("code");
      const own = await s.api.put("/api/me/sign-in-method", { headers: H(s.csrf), data: { method: "password", password: PW } });
      expect(own.status()).toBe(200);
      await s.api.dispose();
    } finally { await bg.api.dispose(); }
  });
});
