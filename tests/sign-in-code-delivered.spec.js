"use strict";

// WHAT THE SIGN-IN CODE DOORS DO ONCE THE MAIL HAS BEEN DELIVERED.
//
// WHY THIS FILE SPAWNS ITS OWN SERVER: the shared test server's relay is a dead
// port by design, so no mail there is ever delivered or readable. This server
// points at a capturing relay (tests/smtp-capture.js), and every code a person
// types here is read off the mail that arrived.
//
// 1. THE ADMIN'S "EMAIL SIGN-IN CODE" KEEPS THE TWO-MINUTE RE-SEND HOLD
//    (routes/participants.js POST /api/admin/participants/:id/login-code/email:
//    `codeRecentlySent(user)` → `{ok:true, sent:false, reason:"recently_sent"}`).
//    Every mint replaces the stored code, so a second press seconds after the
//    first would kill the code the person is typing. The door mints nothing while
//    an emailed code is under two minutes old (lib/login-code.js
//    LOGIN_CODE_RESEND_MIN_MS), and the hold is shared with the entry screen's
//    Continue (both mint through `issueCode`, which notes the emailed mint).
//    Of the sends, only an admin press whose send FAILS within the door's
//    deadline lifts it (`send_failed`: nobody holds that code, so a retry mints
//    at once — tests/signin-hardening.api.spec.js). A delivered send keeps it
//    (checked here); in the code, so do a send still queued at that deadline
//    (`deferred:true`, even if it fails later) and every send Continue makes
//    (detached: its failure lifts nothing), neither of them checked. So every
//    press here must come back delivered (`deferred` absent), and each code is
//    read off the mail that press or request caused: the address's mail count
//    must reach exactly the number expected, and the newest mail's code must be
//    the one stored for the account (only its sha256 is stored), never the
//    sign-up's address proof, whose subject and wording are the same.
//    The control: with the hold lifted (POST /api/test/reset-recent-code-sends)
//    the same second press mints a new code and the first stops working, which
//    is exactly what the hold prevents. A blocked or denied account is refused
//    (409 `account_inactive`) before any of this: `issueCode` does not ask
//    eligibility itself, so the route's check is what keeps it from mailing one.
//
// 2. THE JOIN-LINK CODE MAIL IN A BOOTH EVENT'S LATE-ENTRY WINDOW PROMISES WHAT
//    THE REDEEM DOES. The mail says "…also joins you to <event>" only where
//    `codeBoundJoinWillEnrol` (lib/self-enroll.js, a HAND-KEPT copy of the
//    redeem's ladder) says so. Its late-window rung — somebody who took part
//    before the end gets no new row (`late_entry_took_part`) — and its author
//    rung — a participant who wrote one of a staff-compete event's challenges
//    cannot compete there — are checked here against the redeem.
//    tests/email-scenarios.spec.js checks a participant, an organiser, a member
//    and staff where staff compete; the other rungs — an event no longer taking
//    joins and a staff spectator (an event where staff do not compete) — are
//    unchecked, as lib/self-enroll.js says.
//    The control: a newcomer is promised the join and given it.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { PORT_BASE } = require("./helpers");
const { startSmtpCapture, decodeQuotedPrintable } = require("./smtp-capture");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = PORT_BASE + 106;
const BASE = `http://127.0.0.1:${PORT}`;

let smtp, child, childOut = "", dataDir, uploadsDir, superPass;

/** A cookie-jarred JSON client for this file's own server. */
function client() {
  const jar = [];
  const call = async (method, p, data, headers = {}) => {
    const r = await fetch(BASE + p, {
      method,
      headers: { "content-type": "application/json", ...(jar.length ? { cookie: jar.join("; ") } : {}), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
      redirect: "manual",
    });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
      const kv = c.split(";")[0], k = kv.split("=")[0];
      const i = jar.findIndex(x => x.startsWith(k + "="));
      if (i >= 0) jar[i] = kv; else jar.push(kv);
    }
    const t = await r.text();
    let body = t; try { body = JSON.parse(t); } catch (_) {}
    return { status: r.status, body, text: t };
  };
  return {
    get: (p) => call("GET", p),
    async post(p, d) { return call("POST", p, d, { "x-csrf-token": (await call("GET", "/api/csrf-token")).body.csrfToken }); },
    async del(p) { return call("DELETE", p, undefined, { "x-csrf-token": (await call("GET", "/api/csrf-token")).body.csrfToken }); },
  };
}

function sql(fn, readonly = true) {
  const Database = require("better-sqlite3");
  const db = new Database(path.join(dataDir, "hackathon.db"), readonly ? { readonly: true } : {});
  try { return fn(db); } finally { db.close(); }
}
const codeRow = (id) => sql(db => db.prepare("SELECT login_code_hash, login_code_via, login_code_sends FROM users WHERE id=?").get(id));
const adminRequests = (id) => sql(db => db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='login_code_requested'").all(id))
  .map(r => JSON.parse(r.details || "{}")).filter(d => d.via === "admin_email").length;
const refusals = (id) => sql(db => db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='login_code_refused'").all(id))
  .map(r => JSON.parse(r.details || "{}").reason);
const mailsTo = (email) => smtp.messages.filter(m => (m.rcptTo || []).some(a => a.toLowerCase() === email.toLowerCase()));

/**
 * A captured message's MIME parts, `{ type, text }` each, decoded
 * (quoted-printable or base64, whichever the mailer chose) after undoing SMTP
 * dot-stuffing.
 */
function mailParts(raw) {
  const msg = raw.replace(/\r\n\.\./g, "\r\n.");
  const bm = msg.match(/boundary="?([^";\r\n]+)"?/i);
  const chunks = bm ? msg.split("--" + bm[1]).slice(1) : [msg];
  const out = [];
  for (const chunk of chunks) {
    const sep = chunk.indexOf("\r\n\r\n");
    if (sep < 0) continue;
    const head = chunk.slice(0, sep), body = chunk.slice(sep + 4);
    const type = ((head.match(/content-type:\s*([^;\r\n]+)/i) || [])[1] || "text/plain").trim().toLowerCase();
    const cte = ((head.match(/content-transfer-encoding:\s*([\w-]+)/i) || [])[1] || "7bit").toLowerCase();
    if (cte === "base64") out.push({ type, text: Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8") });
    else if (cte === "quoted-printable") out.push({ type, text: decodeQuotedPrintable(body) });
    else out.push({ type, text: body });
  }
  return out;
}
/** A captured message's text: every MIME part, decoded and joined. */
const mailText = (raw) => mailParts(raw).map(p => p.text).join("\n");

/**
 * The `n`-th mail (1-based) to `who.email`, once exactly `n` have arrived: a
 * send still on its way is waited for rather than an older mail read, and every
 * earlier mail was counted before the press or request this one answers. One
 * mail too many fails the wait as surely as one too few.
 */
async function nthMail(who, n) {
  await expect.poll(() => mailsTo(who.email).length, { message: `exactly ${n} mail(s) reached ${who.email}` }).toBe(n);
  return mailsTo(who.email)[n - 1];
}

/**
 * The sign-in code mail `m` carries, read off the wire: every MIME part names
 * exactly one code, the same one, and it is the code now stored for `who`
 * (lib/login-code.js stores only its sha256) — so `m` is the mail of the mint
 * that press or request made, never the sign-up's address proof (same subject
 * and wording; its code is never stored on the account) or an older code's.
 */
function codeIn(m, who) {
  const parts = mailParts(m.raw);
  expect(parts.length, `the mail to ${who.email} has a body`).toBeGreaterThan(0);
  const codes = parts.map(p => {
    const found = [...p.text.matchAll(/\b[0-9A-Z]{4}-?[0-9A-Z]{4}\b/g)].map(x => x[0]);
    expect(found, `exactly one code in the ${p.type} part of the mail to ${who.email}`).toHaveLength(1);
    return found[0];
  });
  expect([...new Set(codes)], `every part of the mail to ${who.email} names the same code`).toHaveLength(1);
  const sha = crypto.createHash("sha256").update(codes[0].replace("-", ""), "utf8").digest("hex");
  expect(sha, `the code mailed to ${who.email} is the one now stored for the account: this mint's mail`).toBe(codeRow(who.id).login_code_hash);
  return codes[0];
}

/** The code the `n`-th mail to `who` carries (`nthMail`, then `codeIn`). */
async function mailedCode(who, n) { return codeIn(await nthMail(who, n), who); }

/** A redeem in a browser of its own: the answer's `ok`. */
async function redeem(email, code) {
  const r = await client().post("/api/auth/code/redeem", { email, code });
  expect(r.status, r.text).toBe(200);
  return r.body.ok;
}

let seq = 0;
/** A participant signed up through the real doors on this server (verified, approved). */
async function participant(tag) {
  const c = client();
  const email = `${tag}-${Date.now()}-${++seq}@company.co`;
  await c.post("/api/auth/code/request", { email });
  const proof = (await c.get(`/api/test/last-login-code?email=${encodeURIComponent(email)}`)).body;
  expect(proof && proof.via, `PRECONDITION: an address proof was mailed to ${email}`).toBe("proof");
  expect((await c.post("/api/auth/code/redeem", { email, code: proof.code })).body.needsProfile).toBe(true);
  const r = await c.post("/api/register", { firstName: "Code", lastName: tag, company: "Acme", title: "Eng", country: "US", timezone: "America/New_York", email });
  expect(r.status, `register ${tag}: ${r.text}`).toBe(200);
  const id = sql(db => db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email)).id;
  // The sign-up's own mail (the proof) must have landed before any count is taken.
  await expect.poll(() => mailsTo(email).length, { message: `the sign-up's mail reached ${email}` }).toBe(1);
  return { id, email, c };   // `c` is signed in as the new account (the sign-up signs in)
}

let sa;
/** The admin's "Email sign-in code" for `userId`: the door's answer. */
async function press(userId) {
  const r = await sa.post(`/api/admin/participants/${userId}/login-code/email`, {});
  expect(r.status, r.text).toBe(200);
  return r.body;
}
/**
 * A press expected to mint and DELIVER a code. A send still queued at the door's
 * 10 s deadline answers `{sent:true, deferred:true}` too, and its mail may not
 * have arrived: every such press here must have been delivered before anything
 * reads the inbox.
 */
async function pressDelivered(userId, what = "the press") {
  const b = await press(userId);
  expect(b, `${what} minted and sent a code`).toMatchObject({ ok: true, sent: true });
  expect(b.deferred, `${what} was delivered, not left queued at the door's deadline`).toBeUndefined();
  expect(b.message).toMatch(/was emailed/);
  return b;
}

test.beforeAll(async () => {
  smtp = await startSmtpCapture();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codedelivered-"));
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "codedelivered-up-"));
  const spawnedAt = Date.now();
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test",
      PORT: String(PORT), DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, BASE_URL: BASE,
      SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), SMTP_ALLOW_PLAINTEXT: "1",
      SUPERADMIN_PASSWORD_QUIET: "1", RATE_LIMIT_DISABLED: "1", LOG_CONSOLE_MIRROR: "0",
      // A spawned child inherits NODE_OPTIONS, which can change what is observed.
      NODE_OPTIONS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", d => { childOut += d; });
  child.stderr.on("data", d => { childOut += d; });
  // POSITIVE IDENTITY: a leaked server on this port answers /api/config too; only
  // a boot stamp newer than this spawn is ours.
  let up = false;
  for (const deadline = Date.now() + 40000; !up && Date.now() < deadline;) {
    try {
      const cfg = await (await fetch(`${BASE}/api/config`)).json();
      if (cfg.server_started_at && new Date(cfg.server_started_at).getTime() >= spawnedAt) up = true;
    } catch (_) { /* not listening yet */ }
    if (!up) {
      expect(child.exitCode, `the server exited early:\n${childOut.slice(-1500)}`).toBeNull();
      await new Promise(r => setTimeout(r, 200));
    }
  }
  expect(up, `the server never became ready:\n${childOut.slice(-2000)}`).toBe(true);
  const pw = path.join(dataDir, ".superadmin-password");
  await expect.poll(() => fs.existsSync(pw), { message: "the superadmin credential is written" }).toBe(true);
  superPass = fs.readFileSync(pw, "utf8").trim();
  sa = client();
  const li = await sa.post("/api/login", { username: "superadmin", password: superPass });
  expect(li.status, `superadmin login: ${li.text}`).toBe(200);
});

test.afterAll(async () => {
  try { child && child.kill("SIGKILL"); } catch (_) {}
  // kill() returns before the port frees: wait for it, so the next spawner finds it free.
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/config`); } catch (_) { break; }
    await new Promise(r => setTimeout(r, 100));
  }
  try { smtp && await smtp.close(); } catch (_) {}
  for (const d of [dataDir, uploadsDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

// This spec binds a fixed SPAWNER_OFFSETS port: see guardFixedPortSpec.
test.beforeEach(() => guardFixedPortSpec());

test("a second press inside two minutes mints and sends nothing, and the code already mailed still signs in; with the hold lifted the second press replaces it (CONTROL)", async () => {
  const p = await participant("hold");
  const q = await participant("lifted");

  await pressDelivered(p.id, "the first press");
  const code = await mailedCode(p, 2);   // the sign-up's proof, then this press's code
  const minted = codeRow(p.id);
  expect(minted.login_code_via).toBe("email");

  const second = await press(p.id);
  expect(second, "the second press is held").toMatchObject({ ok: true, sent: false, reason: "recently_sent" });
  expect(second.message).toMatch(/less than two minutes ago/);
  expect(codeRow(p.id), "nothing was minted: the stored code, its provenance and the send count are unchanged").toEqual(minted);
  expect(mailsTo(p.email), "nothing was sent: the sign-up's mail and the first press's only").toHaveLength(2);
  expect(adminRequests(p.id), "one code request on the person's History").toBe(1);
  expect(await redeem(p.email, code), "the code the person was mailed still signs them in").toBe(true);

  // CONTROL — the same two presses with the hold lifted between them: the second
  // mints and mails a new code, and the code mailed first stops working.
  await pressDelivered(q.id, "CONTROL: the first press");
  const qFirst = await mailedCode(q, 2);
  const qMinted = codeRow(q.id);
  expect((await client().post("/api/test/reset-recent-code-sends", {})).status).toBe(200);
  await pressDelivered(q.id, "CONTROL: with the hold lifted the second press");
  expect(codeRow(q.id).login_code_hash, "CONTROL: …a new code").not.toBe(qMinted.login_code_hash);
  const qSecond = await mailedCode(q, 3);
  expect(qSecond, "CONTROL: …mailed in place of the first").not.toBe(qFirst);
  expect(await redeem(q.email, qFirst), "CONTROL: the code mailed first is dead").toBe(false);
  expect(await redeem(q.email, qSecond), "CONTROL: the new one signs in").toBe(true);
});

test("the admin's press refuses a blocked or denied account: nothing is minted, recorded or mailed; once unblocked the same press mails a code (CONTROL)", async () => {
  const b = await participant("blockedpress");
  const d = await participant("deniedpress");
  // Block B (the route toggles: assert the state it left).
  expect((await sa.post(`/api/admin/participants/${b.id}/block`, {})).status).toBe(200);
  expect(sql(db => db.prepare("SELECT blocked FROM users WHERE id=?").get(b.id)).blocked, "PRECONDITION: B is blocked").toBe(1);
  // Deny D: denial is only for an account not yet approved, so D is put back to waiting first.
  sql(db => db.prepare("UPDATE users SET approved=0 WHERE id=?").run(d.id), false);
  const dn = await sa.post(`/api/admin/participants/${d.id}/deny`, { reason: "test" });
  expect(dn.status, dn.text).toBe(200);
  expect(sql(db => db.prepare("SELECT denied_at FROM users WHERE id=?").get(d.id)).denied_at, "PRECONDITION: D is denied").toBeTruthy();

  // A denial mails the person a notice (a block mails nothing): count from once
  // it has arrived.
  await expect.poll(() => mailsTo(d.email).length, { message: "the denial notice reached D" }).toBe(2);
  const mailsBefore = { [b.id]: 1, [d.id]: 2 };
  expect(mailsTo(b.email), "PRECONDITION: B holds the sign-up's proof only").toHaveLength(1);
  for (const [who, re] of [[b, /blocked/], [d, /denied/]]) {
    const r = await sa.post(`/api/admin/participants/${who.id}/login-code/email`, {});
    expect(r.status, r.text).toBe(409);
    expect(r.body.code).toBe("account_inactive");
    expect(r.body.error).toMatch(re);
    expect(codeRow(who.id).login_code_hash, "no code was minted").toBeNull();
    expect(adminRequests(who.id), "no code request on the person's History").toBe(0);
    expect(mailsTo(who.email), "nothing was mailed").toHaveLength(mailsBefore[who.id]);
  }

  // CONTROL: unblocked, the same press mints and mails a code.
  expect((await sa.post(`/api/admin/participants/${b.id}/block`, {})).status).toBe(200);
  expect(sql(db => db.prepare("SELECT blocked FROM users WHERE id=?").get(b.id)).blocked, "CONTROL PRECONDITION: B is unblocked").toBe(0);
  await pressDelivered(b.id, "CONTROL: the press for the unblocked account");
  await mailedCode(b, 2);
  expect(adminRequests(b.id)).toBe(1);
  // The control's mail has arrived; D, refused before it, still has no code mail.
  expect(mailsTo(d.email), "the denied account was still mailed nothing more").toHaveLength(2);
});

test("the hold is shared with the entry screen: the person's own Continue holds the admin's press, and the admin's press holds Continue; the code mailed first signs in either way", async () => {
  // Continue first, then the admin.
  const r = await participant("contfirst");
  const c = client();
  expect((await c.post("/api/auth/code/request", { email: r.email })).body).toEqual({ ok: true });
  const rCode = await mailedCode(r, 2);   // Continue's send is detached: waited for
  const rMinted = codeRow(r.id);
  expect(await press(r.id), "the admin's press inside two minutes of Continue is held").toMatchObject({ ok: true, sent: false, reason: "recently_sent" });
  expect(codeRow(r.id)).toEqual(rMinted);
  expect(mailsTo(r.email)).toHaveLength(2);
  expect(await redeem(r.email, rCode), "the code Continue mailed still signs in").toBe(true);

  // The admin first, then the person's Continue.
  const s = await participant("adminfirst");
  await pressDelivered(s.id, "the admin's press");
  const sCode = await mailedCode(s, 2);
  const sMinted = codeRow(s.id);
  expect((await client().post("/api/auth/code/request", { email: s.email })).body, "the entry screen's answer is uniform").toEqual({ ok: true });
  expect(refusals(s.id), "Continue inside two minutes of the admin's press is refused, and recorded").toEqual(["recently_sent"]);
  expect(codeRow(s.id)).toEqual(sMinted);
  expect(mailsTo(s.email)).toHaveLength(2);
  expect(await redeem(s.email, sCode), "the code the admin's press mailed still signs in").toBe(true);
});

test("a code from a Booth Event's join link in its late-entry window: somebody who played the event is promised no join and given none; a newcomer is promised the join and given it (CONTROL)", async () => {
  const name = `Late promise ${Date.now()}`;
  const ev = await sa.post("/api/admin/competitions", {
    name, event_kind: "booth", add_qualifying: false, self_enroll_enabled: true,
    start_time: new Date(Date.now() - 5 * 60_000).toISOString(), duration_minutes: 180,
  });
  expect(ev.status, ev.text).toBeLessThan(300);
  const compId = ev.body.competition.id;
  const task = await sa.post("/api/admin/tasks", {
    title: `Late promise task ${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
    answer_type: "text", correct_answer: "win", status: "published",
  });
  expect(task.status, task.text).toBeLessThan(300);
  const taskId = task.body.id;
  expect((await sa.post(`/api/admin/tasks/${taskId}/competitions`, { competitionIds: [compId] })).body.assigned, "PRECONDITION: the challenge is assigned").toBe(1);
  const token = (await sa.get(`/api/admin/competitions/${compId}/self-enroll`)).body.token;
  expect(token, "PRECONDITION: a join token").toBeTruthy();
  const member = (uid) => !!sql(db => db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uid));

  const played = await participant("lateplayed");
  const fresh = await participant("latefresh");
  expect((await sa.post("/api/admin/competitions/assign", { userIds: [played.id], competitionIds: [compId] })).body.assigned, "PRECONDITION: enrolled").toBe(1);
  expect((await played.c.post("/api/select-competition", { competitionId: compId })).status).toBe(200);
  const gh = (await played.c.get(`/api/tasks/${taskId}`)).body.grading_hash;
  const sub = await played.c.post(`/api/tasks/${taskId}/submit`, { answer: "win", gradingHash: gh });
  expect(sub.body && sub.body.correct, `PRECONDITION: they played: ${sub.text}`).toBe(true);
  expect((await sa.del(`/api/admin/competitions/${compId}/users/${played.id}`)).status, "removed while live").toBe(200);
  // END the event 30 minutes ago by moving its start into the past, and put the
  // answer back before that end (the fixture trap: tests/late-entry-fixture.js).
  const end = Date.now() - 30 * 60_000;
  sql(db => {
    db.prepare("UPDATE competitions SET start_time=?, duration_minutes=60 WHERE id=?").run(new Date(end - 60 * 60_000).toISOString(), compId);
    db.prepare("UPDATE submissions SET submitted_at=? WHERE competition_id=? AND user_id=?").run(new Date(end - 20 * 60_000).toISOString(), compId, played.id);
  }, false);
  // The competition row is cached for 1 s and a direct write busts nothing: the
  // wait is the mechanism (tests/late-entry-fixture.js `outliveCompCache`).
  await new Promise(r => setTimeout(r, 1300));
  const preview = await client().get(`/api/competitions/self-enroll/${token}`);
  expect(preview.body, "PRECONDITION: ended, with its late-entry window open").toMatchObject({ status: "ended", late_entry_window_open: true });

  const LINE = "in the browser where you asked for it also joins you to";
  /** Ask for a code through the join link, read the mail that request caused, and redeem it in the same browser. */
  const viaLink = async (who) => {
    const cl = client();
    const n = mailsTo(who.email).length + 1;
    expect((await cl.post("/api/auth/code/request", { email: who.email, joinToken: token })).body).toEqual({ ok: true });
    const m = await nthMail(who, n);
    const rd = await cl.post("/api/auth/code/redeem", { email: who.email, code: codeIn(m, who) });
    expect(rd.body && rd.body.ok, `the sign-in goes through: ${rd.text}`).toBe(true);
    return mailText(m.raw);
  };
  const playedMail = await viaLink(played);
  expect(playedMail, "somebody who took part before the end is promised no join").not.toContain(LINE);
  expect(playedMail, "…the event is not named").not.toContain(name);
  expect(member(played.id), "…and the redeem gives them no row, as the mail said").toBe(false);
  const freshMail = await viaLink(fresh);
  expect(freshMail, "CONTROL: a newcomer is told the code joins them").toContain(LINE);
  expect(freshMail).toContain(name);
  expect(member(fresh.id), "CONTROL: …and the redeem enrols them").toBe(true);
});

test("a code from a staff-compete event's join link: a participant who authored one of its challenges is promised no join and given none; a newcomer is promised the join and given it (CONTROL)", async () => {
  const name = `Author promise ${Date.now()}`;
  const ev = await sa.post("/api/admin/competitions", {
    name, event_kind: "tournament", staff_compete: true, self_enroll_enabled: true,
    start_time: new Date(Date.now() - 5 * 60_000).toISOString(), duration_minutes: 180,
  });
  expect(ev.status, ev.text).toBeLessThan(300);
  const compId = ev.body.competition.id;
  const token = (await sa.get(`/api/admin/competitions/${compId}/self-enroll`)).body.token;
  expect(token, "PRECONDITION: a join token").toBeTruthy();
  const member = (uid) => !!sql(db => db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uid));

  // The author: a participant made admin, who writes a (sealed: a staff-compete
  // event holds no other) challenge and assigns it, then is made participant
  // again. Only a role of class none reaches the authorship rung: an admin-class
  // role is refused before it.
  const author = await participant("authorjoin");
  const fresh = await participant("authorfresh");
  expect((await sa.post(`/api/admin/participants/${author.id}/role`, { role: "admin" })).status, "promoted").toBe(200);
  const ac = client();
  await ac.post("/api/test/reset-recent-code-sends", {});
  expect((await ac.post("/api/auth/code/request", { email: author.email })).body).toEqual({ ok: true });
  const ak = (await ac.get(`/api/test/last-login-code?email=${encodeURIComponent(author.email)}`)).body;
  expect((await ac.post("/api/auth/code/redeem", { email: author.email, code: ak.code })).body.ok, "the admin signs in").toBe(true);
  const task = await ac.post("/api/admin/tasks", {
    title: `Author promise task ${Date.now()}`, description: "<p>x</p>", difficulty: "easy",
    answer_type: "text", correct_answer: "win", status: "published", answer_sealed: true,
  });
  expect(task.status, task.text).toBeLessThan(300);
  const taskId = task.body.id;
  expect((await ac.post(`/api/admin/tasks/${taskId}/competitions`, { competitionIds: [compId] })).body.assigned, "PRECONDITION: the challenge is assigned").toBe(1);
  expect((await sa.post(`/api/admin/participants/${author.id}/role`, { role: "participant" })).status, "made participant again").toBe(200);
  expect(sql(db => db.prepare("SELECT created_by_id FROM tasks WHERE id=?").get(taskId)).created_by_id, "PRECONDITION: they wrote it").toBe(author.id);
  expect(sql(db => db.prepare("SELECT role FROM users WHERE id=?").get(author.id)).role, "PRECONDITION: a participant again").toBe("participant");
  expect(sql(db => db.prepare("SELECT tag FROM user_tags WHERE user_id=?").all(author.id)), "PRECONDITION: untagged (so the staff skip is not what refuses)").toEqual([]);
  expect(member(author.id), "PRECONDITION: not in the event").toBe(false);

  const LINE = "in the browser where you asked for it also joins you to";
  /** Ask for a code through the join link, read the mail that request caused, and redeem it in the same browser. */
  const viaLink = async (who) => {
    const cl = client();
    await cl.post("/api/test/reset-recent-code-sends", {});
    const n = mailsTo(who.email).length + 1;
    expect((await cl.post("/api/auth/code/request", { email: who.email, joinToken: token })).body).toEqual({ ok: true });
    const m = await nthMail(who, n);
    const rd = await cl.post("/api/auth/code/redeem", { email: who.email, code: codeIn(m, who) });
    expect(rd.body && rd.body.ok, `the sign-in goes through: ${rd.text}`).toBe(true);
    return mailText(m.raw);
  };
  const authorMail = await viaLink(author);
  expect(authorMail, "an author of one of its challenges is promised no join").not.toContain(LINE);
  expect(member(author.id), "…and the redeem gives them no row, as the mail said").toBe(false);
  const freshMail = await viaLink(fresh);
  expect(freshMail, "CONTROL: a newcomer is told the code joins them").toContain(LINE);
  expect(freshMail).toContain(name);
  expect(member(fresh.id), "CONTROL: …and the redeem enrols them").toBe(true);
});
