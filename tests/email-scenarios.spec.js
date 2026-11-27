"use strict";

// v8.7.6 — EVERY EMAIL THE PLATFORM SENDS IS DRIVEN, AND THE MESSAGE IS READ OFF
// THE WIRE.
//
// Asked for directly after the sign-in-code investigation: make sure a test case
// exists for every email-emitting scenario. Before this file there were 18 send
// reasons and SEVEN that no spec so much as named — `account_approved`,
// `account_denied`, `admin_email_change_verification`, `email_change_confirmation`,
// `ip_ban_alert`, `lockout` and `login_code`, which is the one the report came in
// about. The scattered assertions that did exist mostly read the `email_sent`
// AUDIT ROW, which records what we COMPOSED: it cannot tell a mail that is no
// longer sent from one that is no longer logged, which is exactly the shape of the
// defect this release fixes.
//
// So this file spawns its OWN server against a REAL capturing relay and asserts
// the bytes that arrived. The shared test server points at a dead SMTP port by
// design, so no spec running against it can make this claim (v7.26.0 established
// the pattern for the From header; this generalises it to every reason).
//
// THE MANIFEST IS THE POINT, not the individual tests. `SCENARIOS` is
// cross-checked against the reasons the CODE actually passes to sendEmailLogged /
// sendEmailBackground, in BOTH directions, so a new send reason must be either
// exercised here or EXEMPTED with a stated reason — a decision per item, never
// blanket coverage (the `BACKUP_COVERS` shape). Adding a mail and forgetting to
// test it is the failure this exists to prevent, and it is invisible to a green
// suite otherwise.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { PORT_BASE, findLogLine } = require("./helpers");
const { startSmtpCapture } = require("./smtp-capture");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = PORT_BASE + 195;
const BASE = `http://127.0.0.1:${PORT}`;

let smtp, child, dataDir, uploadsDir, superPass;

/** A cookie-jarred JSON client for this file's own server. */
// EMAIL FIRST: an account is created only by a session that redeemed an address
// proof, so this client asks for the code, reads it back (test-only) and redeems
// it before the form. The client is then signed in as the new account.
async function registerVia(c, body) {
  const h = await c.h();
  await c.post("/api/test/reset-recent-code-sends", undefined, h);
  await c.post("/api/auth/code/request", { email: body.email }, h);
  const last = await c.get("/api/test/last-login-code?email=" + encodeURIComponent(body.email));
  await c.post("/api/auth/code/redeem", { email: body.email, code: last.body && last.body.code }, h);
  return c.post("/api/register", body, await c.h());
}

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
    return { status: r.status, ok: r.status >= 200 && r.status < 300, body, text: t };
  };
  return {
    get: (p, h) => call("GET", p, undefined, h),
    post: (p, d, h) => call("POST", p, d, h),
    put: (p, d, h) => call("PUT", p, d, h),
    del: (p, d, h) => call("DELETE", p, d, h),
    async csrf() { return (await call("GET", "/api/csrf-token")).body.csrfToken; },
    async h() { return { "x-csrf-token": await this.csrf() }; },
  };
}

/** Sign `c` in as `email` through the emailed-code door (the only door for an account row). */
async function codeSignIn(c, email) {
  const rq = await c.post("/api/auth/code/request", { email }, await c.h());
  if (!rq.ok) return rq;
  const code = (await c.get(`/api/test/last-login-code?email=${encodeURIComponent(email)}`)).body.code;
  const rd = await c.post("/api/auth/code/redeem", { email, code }, await c.h());
  return { ...rd, ok: !!(rd.body && rd.body.ok) };
}

function sql(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(path.join(dataDir, "hackathon.db"));
  try { return fn(db); } finally { db.close(); }
}

/** Wait for a message the relay really received, by envelope recipient. */
async function inboxFor(to, { since = 0, timeout = 15000, where = null } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const hit = smtp.messages.slice(since).find(m => (m.rcptTo || []).some(a => a.toLowerCase() === to.toLowerCase())
      && (!where || where(m)));
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(`no message reached ${to} within ${timeout}ms. Captured since: ` +
        JSON.stringify(smtp.messages.slice(since).map(m => ({ to: m.rcptTo, subject: m.header("subject") }))));
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

/**
 * The audit row the send wrote, so the REASON is asserted as well as the bytes.
 *
 * Two subtleties, both of which made the first draft pass or fail for the wrong
 * reason. It polls for the reason it was ASKED for, not for "any row": a
 * registration has already written a `verification` row against the same
 * address, so returning on the first non-empty result reports that one and the
 * mail actually under test may not have landed yet. And it reads the ORPHANED
 * events too — a send with no user row (an invitation, the IP-ban alert) is
 * recorded there by `sendEmailLogged(null, …)`, which is the established shape.
 */
async function sentReasons(email, reason, { timeout = 15000 } = {}) {
  // A send with NO user row — an invitation, the IP-ban alert — is recorded by
  // `sendEmailLogged(null, …)` as an ORPHANED event, and an orphaned event goes
  // ONLY to the app-log mirror; there is no table to read. So both channels are
  // consulted, and `findLogLine` is the suite's own polled reader rather than a
  // second copy of it (the mirror is `setImmediate`-deferred, so a single read
  // races it — a standing rule in this repo).
  const deadline = Date.now() + timeout;
  // v9.0.0 — an ADDRESS PROOF's record names the address only by fingerprint
  // (`to_fp`, the proof's own `ep_` scheme: sha256 of the lower-cased address),
  // never the address, so it is matched by that.
  const fp = "ep_" + require("crypto").createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 12);
  const match = (d) => String(d.to || "").toLowerCase().includes(email.toLowerCase()) || d.to_fp === fp;
  for (;;) {
    const rows = sql(db => db.prepare(
      "SELECT details FROM user_events WHERE event_type='email_sent' ORDER BY changed_at DESC LIMIT 300"
    ).all()).map(r => { try { return JSON.parse(r.details || "{}"); } catch (_) { return {}; } }).filter(match);
    if (rows.some(r => r.reason === reason)) return rows;

    try {
      const line = await findLogLine(
        path.join(dataDir, "logs"),
        (j) => j.event_type === "email_sent" && j.details && match(j.details) && j.details.reason === reason,
        { timeoutMs: 400, what: `an email_sent(${reason}) mirror line for ${email}` });
      return [...rows, line.details];
    } catch (_) { /* not yet — fall through to the deadline */ }

    if (Date.now() > deadline) return rows;
    await new Promise(r => setTimeout(r, 150));
  }
}

let seq = 0;
const uniq = (tag) => `${tag}-${Date.now()}-${++seq}@company.co`;

/** A verified, approved participant. */
async function participant(sa, tag, opts = {}) {
  const c = client();
  const email = uniq(tag);
  const stamp = `${Date.now()}${seq}`;
  const r = await registerVia(c, {
    firstName: "Mail", lastName: "Probe", nickname: `${tag}${stamp}`.replace(/[^a-z0-9_]/gi, "").slice(0, 20),
    company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
    email,
  }, await c.h());
  expect(r.ok, `register ${tag}: ${r.status} ${r.text}`).toBeTruthy();
  const id = sql(db => db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email).id);
  sql(db => db.prepare(
    `UPDATE users SET verified=${opts.verified === false ? 0 : 1}, approved=${opts.approved === false ? 0 : 1}
       WHERE id=?`).run(id));
  return { email, id, ctx: c };
}

test.beforeAll(async () => {
  smtp = await startSmtpCapture();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailscen-"));
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailscen-up-"));
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test",
      PORT: String(PORT), DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, BASE_URL: BASE,
      SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), SMTP_ALLOW_PLAINTEXT: "1",
      SUPERADMIN_PASSWORD_QUIET: "1", RATE_LIMIT_DISABLED: "1",
      // v7.15.30 — a spawned child inherits NODE_OPTIONS, which can change the
      // very behaviour it is being observed for.
      NODE_OPTIONS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { out += d; });

  // POSITIVE IDENTITY (v7.21.10): a leaked server answers /api/config too.
  const spawnedAt = Date.now();
  const deadline = Date.now() + 40000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/config`);
      if (r.ok) {
        const cfg = await r.json();
        if (cfg.server_started_at && new Date(cfg.server_started_at).getTime() >= spawnedAt - 2000) { up = true; break; }
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  if (!up) throw new Error(`server never became ready. Log:\n${out.slice(-2000)}`);
  superPass = fs.readFileSync(path.join(dataDir, ".superadmin-password"), "utf8").trim();
});

test.afterAll(async () => {
  try { child && child.kill("SIGKILL"); } catch (_) {}
  try { smtp && await smtp.close(); } catch (_) {}
  for (const d of [dataDir, uploadsDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

/** A signed-in superadmin client. */
async function admin() {
  const c = client();
  const r = await c.post("/api/login", { email: "superadmin", password: superPass }, await c.h());
  expect(r.ok, `superadmin login: ${r.status} ${r.text}`).toBeTruthy();
  return c;
}

// ---------------------------------------------------------------------------
// THE MANIFEST. Every reason the code can pass to sendEmailLogged /
// sendEmailBackground is either `run` here or `exempt` with a stated reason.
// ---------------------------------------------------------------------------
const SCENARIOS = {
  verification: {
    what: "a signed-in account still unverified asks for the confirmation link again",
    async run() {
      const sa = await admin();
      const p = await participant(sa, "verif");
      const c = client();
      const rq = await c.post("/api/auth/code/request", { email: p.email }, await c.h());
      expect(rq.status).toBe(200);
      const code = (await c.get(`/api/test/last-login-code?email=${encodeURIComponent(p.email)}`)).body.code;
      const rd = await c.post("/api/auth/code/redeem", { email: p.email, code }, await c.h());
      expect(rd.body && rd.body.ok, rd.text).toBe(true);
      // Registration mails a code, never the link, and the code just verified the
      // account — so put it back in a live grace window to reach the resend door.
      sql(db => db.prepare("UPDATE users SET verified=0, self_enroll_grace_until=? WHERE id=?")
        .run(new Date(Date.now() + 3600_000).toISOString(), p.id));
      const before = smtp.messages.length;
      const r = await c.post("/api/resend-verification", {}, await c.h());
      expect(r.ok, r.text).toBeTruthy();
      return { email: p.email, before };
    },
  },

  login_code: {
    what: "an account asks for an emailed sign-in code",
    async run() {
      const sa = await admin();
      const p = await participant(sa, "code");
      const before = smtp.messages.length;
      const c = client();
      const r = await c.post("/api/auth/code/request", { email: p.email }, await c.h());
      expect(r.status, "200 always — a non-429 4xx feeds the scanner counter").toBe(200);
      return { email: p.email, before };
    },
  },

  password_changed_notification: {
    what: "an account sets its first password in the profile (and the notice names it)",
    async run() {
      const sa = await admin();
      const p = await participant(sa, "pwset");
      const c = client();
      const si = await codeSignIn(c, p.email);
      expect(si.ok, `code sign-in: ${si.text}`).toBeTruthy();
      const before = smtp.messages.length;
      const r = await c.put("/api/me/sign-in-method", { method: "password", password: "a long enough password" }, await c.h());
      expect(r.status, r.text).toBe(200);
      return { email: p.email, before };
    },
  },

  email_proof: {
    what: "an address with NO account asks for a code at the entry screen (the address proof)",
    async run() {
      const email = uniq("proof");
      const before = smtp.messages.length;
      const c = client();
      const r = await c.post("/api/auth/code/request", { email }, await c.h());
      expect(r.status, "200 always, the same body as for an existing account").toBe(200);
      return { email, before };
    },
  },

  invitation: {
    what: "an admin invites an address that has no account yet",
    async run() {
      const sa = await admin();
      const email = uniq("invited");
      const before = smtp.messages.length;
      const r = await sa.post("/api/admin/invitations", { emails: [email] }, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
      return { email, before };
    },
  },

  account_approved: {
    what: "an admin approves ONE pending account",
    async run() {
      const sa = await admin();
      const p = await participant(sa, "appr", { approved: false });
      const before = smtp.messages.length;
      const r = await sa.post(`/api/admin/participants/${p.id}/approve`, {}, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
      return { email: p.email, before };
    },
  },

  account_approved_bulk: {
    what: "an admin approves a BATCH — a different reason from the single approve",
    async run() {
      const sa = await admin();
      const p = await participant(sa, "bulkappr", { approved: false });
      const before = smtp.messages.length;
      const r = await sa.post("/api/admin/participants/bulk-approve", { userIds: [p.id] }, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
      return { email: p.email, before };
    },
  },

  account_denied: {
    what: "an admin denies a pending account",
    async run() {
      const sa = await admin();
      const p = await participant(sa, "denied", { approved: false });
      const before = smtp.messages.length;
      const r = await sa.post(`/api/admin/participants/${p.id}/deny`, { reason: "not this event" }, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
      return { email: p.email, before };
    },
  },

  admin_email_change_verification: {
    what: "an admin corrects a primary address — the NEW address is asked to confirm",
    async run() {
      const sa = await admin();
      const p = await participant(sa, "admemail");
      const next = uniq("admemail-new");
      const before = smtp.messages.length;
      const r = await sa.put(`/api/admin/participants/${p.id}`, { email: next }, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
      // v8.3.36 — STAGED: the live account is untouched until the new address
      // confirms, so the mail goes to the NEW address, not the current one.
      return { email: next, before };
    },
  },

  email_change_confirmation: {
    what: "a participant changes their own address — the NEW one is asked to confirm",
    async run() {
      const sa = await admin();
      const p = await participant(sa, "selfemail");
      const c = client();
      const li = await codeSignIn(c, p.email);
      expect(li.ok, `login: ${li.text}`).toBeTruthy();
      const next = uniq("selfemail-new");
      const before = smtp.messages.length;
      const r = await c.put("/api/me", { email: next }, await c.h());
      expect(r.ok, r.text).toBeTruthy();
      return { email: next, before };
    },
  },

  competition_assignment: {
    what: "an admin assigns somebody to an event",
    async run() {
      const sa = await admin();
      const p = await participant(sa, "assign");
      const comp = await sa.post("/api/admin/competitions", {
        name: `MailScen Assign ${Date.now()}-${seq}`,
        start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 120,
      }, await sa.h());
      expect(comp.ok, comp.text).toBeTruthy();
      const compId = comp.body.competition.id;
      const before = smtp.messages.length;
      const a = await sa.post("/api/admin/competitions/assign",
        { competitionIds: [compId], userIds: [p.id] }, await sa.h());
      expect(a.ok, a.text).toBeTruthy();
      expect(a.body.assigned, "the assign SKIPS ineligible users and still answers 200").toBe(1);
      return { email: p.email, before, compId, userId: p.id };
    },
  },

  removed_from_competition: {
    what: "an admin removes somebody from an event",
    async run() {
      const ctx = await SCENARIOS.competition_assignment.run();
      await inboxFor(ctx.email, { since: ctx.before });          // let the assign mail land first
      const sa = await admin();
      const before = smtp.messages.length;
      const r = await sa.del(`/api/admin/competitions/${ctx.compId}/users/${ctx.userId}`, undefined, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
      expect(r.body.removed, "a DELETE that matched no membership answers 200 too").toBe(true);
      return { email: ctx.email, before };
    },
  },

  reminder: {
    what: "the 'starts in about an hour' mail the dispatcher tick sends",
    async run() {
      const sa = await admin();
      const p = await participant(sa, "remind");
      const comp = await sa.post("/api/admin/competitions", {
        name: `MailScen Remind ${Date.now()}-${seq}`,
        start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 120,
      }, await sa.h());
      expect(comp.ok, comp.text).toBeTruthy();
      const compId = comp.body.competition.id;
      const a = await sa.post("/api/admin/competitions/assign",
        { competitionIds: [compId], userIds: [p.id] }, await sa.h());
      expect(a.body.assigned, "assign really enrolled them").toBe(1);
      await inboxFor(p.email);                                    // the assignment mail

      const c = client();
      const li = await codeSignIn(c, p.email);
      expect(li.ok, li.text).toBeTruthy();
      const set = await c.post(`/api/competitions/${compId}/reminder`, {}, await c.h());
      expect(set.ok, `set reminder: ${set.text}`).toBeTruthy();

      // Make it due, then drive ONE real tick (the interval is off under test).
      sql(db => db.prepare("UPDATE email_reminders SET send_at=? WHERE competition_id=?")
        .run(new Date(Date.now() - 60_000).toISOString(), compId));
      const before = smtp.messages.length;
      const sa2 = await admin();
      const t = await sa2.post("/api/test/reminder-tick", {}, await sa2.h());
      expect(t.ok, `tick: ${t.text}`).toBeTruthy();
      expect(t.body.ran, "`ran:false` means it was already running — a pass for the wrong reason").toBe(true);
      return { email: p.email, before };
    },
  },

  lockout: {
    what: "ten wrong sign-in codes arm the lock and tell the owner",
    async run() {
      const sa = await admin();
      const p = await participant(sa, "lockout");
      const before = smtp.messages.length;
      const c = client();
      for (let i = 0; i < 10; i++) {
        const r = await c.post("/api/auth/code/redeem", { email: p.email, code: "0000000" + i }, await c.h());
        expect(r.status, "every redeem answer is 200; the verdict is in `ok`").toBe(200);
      }
      return { email: p.email, before };
    },
  },

  unlock: {
    what: "an admin unlocks a locked account",
    async run() {
      const ctx = await SCENARIOS.lockout.run();
      await inboxFor(ctx.email, { since: ctx.before });           // the lockout mail
      const id = sql(db => db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(ctx.email).id);
      expect(sql(db => db.prepare("SELECT locked_until FROM users WHERE id=?").get(id).locked_until),
        "precondition: the account really is locked").toBeTruthy();
      const sa = await admin();
      const before = smtp.messages.length;
      const r = await sa.post(`/api/admin/participants/${id}/unlock`, {}, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
      return { email: ctx.email, before };
    },
  },

  ip_ban_alert: {
    what: "a blocked address is reported to every superadmin",
    async run() {
      const sa = await admin();
      // The built-in superadmin has no mailbox, so the recipient set needs a
      // user-backed colleague.
      const p = await participant(sa, "sa-peer");
      const rr = await sa.post(`/api/admin/participants/${p.id}/role`, { role: "superadmin" }, await sa.h());
      expect(rr.ok, `promote: ${rr.text}`).toBeTruthy();

      // A REAL CASCADE, not the alert-raising test hook: that hook calls
      // `recordIpBanAlert` only, so it never reaches `deliverAlert` — and the
      // existing ip-ban spec STUBS `sendMail`, so before this nothing in the
      // suite drove this mail onto the wire at all.
      const sa2 = await admin();
      await sa2.post("/api/test/scanner-reset", {}, await sa2.h());
      const on = await sa2.post("/api/test/scanner-toggle", { enable: true }, await sa2.h());
      expect(on.ok, `scanner-toggle: ${on.text}`).toBeTruthy();
      const before = smtp.messages.length;
      try {
        // VENUE-SHAPED traffic: unauthenticated admin reads are ROUTED 401s, so
        // neither silence arm can fire (both need many DISTINCT unrouted probe
        // paths) and the block therefore raises — and mails — an alert. This is
        // the shape `scanner-silent` and `trusted-networks-e2e` already drive,
        // and it is realistic: a roomful of expired sessions polling.
        const anon = client();
        let blockedAt = 0;
        for (let i = 1; i <= 160 && !blockedAt; i++) {
          if ((await anon.get("/api/admin/participants")).status === 429) blockedAt = i;
        }
        expect(blockedAt, "the address must really be blocked").toBeGreaterThan(0);
        const st = await sa2.get(`/api/test/scanner-state?ip=127.0.0.1`);
        expect(st.body.silent, `a silenced block raises no alert, so it would mail nothing: ${st.text}`).toBe(false);
      } finally {
        // A block on 127.0.0.1 lasts 15 minutes and would 429 every later
        // non-admin request in this file — the standing rule for this hook.
        //
        // It must be torn down through the session established BEFORE the
        // cascade: the block exempts a signed-in admin, but it does NOT exempt
        // the login that would establish one, so `await admin()` here is itself
        // 429'd and the cleanup cannot run. Measured, on this test's first pass.
        await sa2.post("/api/test/scanner-toggle", { enable: false }, await sa2.h());
        await sa2.post("/api/test/scanner-reset", {}, await sa2.h());
      }
      return { email: p.email, before };
    },
  },
};

// Reasons the code can emit that this file deliberately does NOT drive.
const EXEMPT = {
  // v8.15.1 — driven end to end, off the wire, by tests/certificate-dispatch.spec.js
  // (its own server and capturing relay): every end path, the PDF attachment, the
  // tier copy, the opt-out, the revive, the restart and the admin Resend. A copy
  // here would need an ended event with a graded attempt for one more message.
  certificate_awarded: "tests/certificate-dispatch.spec.js drives it against a capturing relay",
  // Internal staff mail to the event team: every persona, the CSV, the single
  // call to action, the timing and the nudge, off the wire, in its own spec.
  event_team_report: "tests/event-team-reports.spec.js drives it against a capturing relay",
  // Same template, same reason string, same assertions — reached through
  // `reconcileCompetitionMembership` instead of the admin route. Driving it
  // needs a bound group and adds a second path to one mail, not a second mail.
  // `group-sync.js`'s own paths are covered by `functional-core-c` and
  // `mutations-admin`.
};

// v8.8.19 — this spec binds a fixed SPAWNER_OFFSETS port; see guardFixedPortSpec.
test.beforeEach(() => guardFixedPortSpec());

test.describe("v8.7.6 — every email the platform sends is driven, and the message is read off the wire", () => {
  for (const [reason, sc] of Object.entries(SCENARIOS)) {
    test(`${reason}: ${sc.what}`, async () => {
      const ctx = await sc.run();
      const msg = await inboxFor(ctx.email, { since: ctx.before });

      // The BYTES arrived. This is the half an `email_sent` assertion cannot
      // make: that row records what we COMPOSED, so it cannot tell a mail that
      // is no longer sent from one that is no longer logged.
      expect(msg.rcptTo.map(a => a.toLowerCase()), `${reason}: envelope recipient`)
        .toContain(ctx.email.toLowerCase());
      const subject = msg.header("subject") || "";
      expect(subject.length, `${reason}: the message has a subject`).toBeGreaterThan(0);
      expect(msg.raw.length, `${reason}: and a body`).toBeGreaterThan(50);

      // …and the platform recorded WHY it sent, under this reason. Both halves,
      // because either alone is satisfied by a build that broke the other.
      const rows = await sentReasons(ctx.email, reason);
      expect(rows.map(r => r.reason), `${reason}: the audit row names the reason`).toContain(reason);
      const row = rows.find(r => r.reason === reason);
      expect(row.success, `${reason}: recorded as delivered`).toBe(true);
    });
  }

  test("the manifest covers every reason the code can emit, in BOTH directions", () => {
    // The lasting guard. A new mail added without a scenario is invisible to a
    // green suite — which is how seven reasons came to have none — so this
    // demands a DECISION per reason rather than blanket coverage.
    const { stripJsComments } = require("./doc-registry");
    const glob = (d) => fs.readdirSync(path.resolve(__dirname, "..", d))
      .filter(f => f.endsWith(".js")).map(f => path.join(d, f));
    const files = [...glob("routes"), ...glob("lib"), "server.js"];
    const live = new Set();
    for (const rel of files) {
      const src = stripJsComments(fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8"));
      for (const m of src.matchAll(/send(?:EmailLogged|EmailBackground)\s*\(/g)) {
        let i = m.index + m[0].length, depth = 1;
        while (depth && i < src.length) {
          const ch = src[i];
          if (ch === "(" || ch === "[" || ch === "{") depth++;
          else if (ch === ")" || ch === "]" || ch === "}") depth--;
          i++;
        }
        const call = src.slice(m.index + m[0].length, i - 1).trim();
        // The reason is the last argument, or the one before the optional `about`
        // object naming the event(s) the mail concerns (lib/email.js).
        const r = call.match(/"([a-z_]+)"\s*(?:,\s*\{[\s\S]*\}\s*)?$/);
        if (r) live.add(r[1]);
      }
    }
    // ANTI-VACUITY: a rename of the sender would empty the match set and pass in
    // silence, which is precisely the drift this is written for.
    expect(live.size, "the extractor still finds the platform's mail").toBeGreaterThanOrEqual(14);

    const covered = new Set([...Object.keys(SCENARIOS), ...Object.keys(EXEMPT)]);
    const missing = [...live].filter(r => !covered.has(r)).sort();
    expect(missing,
      "these send reasons are exercised by NO scenario here. Add one, or add an EXEMPT entry saying why " +
      "the mail is already driven end to end elsewhere:\n  " + missing.join("\n  ")).toEqual([]);

    const stale = [...covered].filter(r => !live.has(r)).sort();
    expect(stale,
      "these scenarios name a reason the code no longer emits — a stale entry reads as coverage and is not:\n  " +
      stale.join("\n  ")).toEqual([]);
  });
});


/**
 * Every text part of a captured message, transfer-decoded. (v8.12.6 — module
 * scope, so the reset-expiry and reminder-copy describes read bodies one way.)
 */
function decodedParts(raw) {
  // Undo SMTP dot-stuffing first: a soft-wrapped line that happens to begin
  // with "." arrives as "..", which would split `reset-password.html` in two.
  const msg = raw.replace(/\r\n\.\./g, "\r\n.");
  const bm = msg.match(/boundary="?([^";\r\n]+)"?/i);
  const chunks = bm ? msg.split("--" + bm[1]).slice(1) : [msg];
  const out = [];
  for (const chunk of chunks) {
    const sep = chunk.indexOf("\r\n\r\n");
    if (sep < 0) continue;
    const head = chunk.slice(0, sep), body = chunk.slice(sep + 4);
    const cte = ((head.match(/content-transfer-encoding:\s*([\w-]+)/i) || [])[1] || "7bit").toLowerCase();
    if (cte === "base64") out.push(Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8"));
    else if (cte === "quoted-printable") {
      out.push(Buffer.from(body.replace(/=\r?\n/g, "")
        .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8"));
    } else out.push(body);
  }
  return out;
}

test.describe("v8.12.6 (sweep) — a mail is never sent to, or recorded against, an account deleted before it went out", () => {
  test("the assignment fan-out: deleted while QUEUED → not mailed; deleted mid-SEND → recorded off the erased history", async () => {
    const sa = await admin();
    const ps = [];
    for (let i = 0; i < 9; i++) ps.push(await participant(sa, `fan${i}`));
    // Each registration mails a sign-in code (detached): let those reach the
    // relay before holding it, or they would be counted among the held sends.
    await expect.poll(() => ps.every(p => smtp.messages.some(m => (m.rcptTo || []).map(x => x.toLowerCase()).includes(p.email.toLowerCase()))),
      { timeout: 15000, message: "every registration's code mail reached the relay" }).toBe(true);
    const comp = await sa.post("/api/admin/competitions", {
      name: `MailScen Fan ${Date.now()}-${seq}`,
      start_time: new Date(Date.now() + 2 * 3600_000).toISOString(), duration_minutes: 120,
    }, await sa.h());
    expect(comp.ok, comp.text).toBeTruthy();
    const compId = comp.body.competition.id;
    const before = smtp.messages.length;
    const hdr = await sa.h();
    const reachedRelay = () => new Set(smtp.messages.slice(before).flatMap(m => (m.rcptTo || []).map(x => x.toLowerCase())));
    let queued, inFlight, assignP;
    smtp.hold();
    try {
      assignP = sa.post("/api/admin/competitions/assign", { competitionIds: [compId], userIds: ps.map(p => p.id) }, hdr);
      // The fan-out runs EIGHT at a time (routes/participants.js), so with every
      // reply held exactly eight mails are parked mid-send and one is queued.
      await expect.poll(() => smtp.heldCount(), { timeout: 15000,
        message: "eight assignment mails reach the relay and wait on its reply" }).toBe(8);
      const reached = reachedRelay();
      const waiting = ps.filter(p => !reached.has(p.email.toLowerCase()));
      expect(waiting.length, "exactly ONE mail is still queued behind the eight in flight — the arm is vacuous otherwise").toBe(1);
      queued = waiting[0];
      inFlight = ps.find(p => reached.has(p.email.toLowerCase()));
      for (const p of [queued, inFlight]) {
        const d = await sa.del(`/api/admin/participants/${p.id}`, undefined, await sa.h());
        expect(d.ok, `delete ${p.email}: ${d.status} ${d.text}`).toBeTruthy();
      }
    } finally { smtp.release(); }
    const a = await assignP;
    expect(a.ok, a.text).toBeTruthy();
    expect(a.body.assigned, "all nine were enrolled before the fan-out began").toBe(9);
    expect(a.body.emailsDeferred, "the fan-out finished inside the request, so every send below has settled").toBeFalsy();
    const logs = path.join(dataDir, "logs");

    // QUEUED: the deletion landed before its turn, so nothing is sent — and the
    // suppression is recorded WITHOUT the address it would have gone to.
    const sup = await findLogLine(logs, (j) => j.event_type === "email_suppressed" && j.details
      && j.details.user_id === queued.id, { what: `the email_suppressed line for the deleted, queued ${queued.email}` });
    expect(sup.details.skipped).toBe("recipient_deleted");
    expect(sup.details.reason).toBe("competition_assignment");
    expect(sup.details.to, "no mail went anywhere, so the erased address is not written again").toBeUndefined();
    expect(reachedRelay().has(queued.email.toLowerCase()),
      "a participant deleted while their mail was queued must never be mailed at the erased address").toBe(false);

    // MID-SEND: the mail had left and cannot be recalled — so it is recorded as an
    // ORPHANED event carrying the address, never re-inserted into the history the
    // deletion emptied.
    const orphan = await findLogLine(logs, (j) => j.event_type === "email_sent" && j.details
      && j.details.user_id === inFlight.id, { what: `the orphaned email_sent line for ${inFlight.email}` });
    expect(orphan.details.recipient_deleted).toBe(true);
    expect(orphan.details.success).toBe(true);
    expect(String(orphan.details.to).toLowerCase()).toContain(inFlight.email.toLowerCase());
    expect(sql(db => db.prepare("SELECT COUNT(*) c FROM user_events WHERE user_id=?").get(inFlight.id).c),
      "no row is written back into the deleted participant's history").toBe(0);

    // CONTROL: the seven untouched participants were mailed and it is on THEIR history.
    for (const p of ps.filter(x => x !== queued && x !== inFlight)) {
      expect(reachedRelay().has(p.email.toLowerCase()), `${p.email} was mailed`).toBe(true);
      const rows = sql(db => db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='email_sent'").all(p.id))
        .map(r => JSON.parse(r.details || "{}")).filter(d => d.reason === "competition_assignment");
      expect(rows.length, `${p.email}: the assignment mail is on their own history`).toBe(1);
      expect(rows[0].success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// v8.12.6 (sweep) — A START REMINDER STATES HOW LONG IS REALLY LEFT.
//
// The mail said "starts in about 1 hour" (subject: "starts in 1 hour") whatever
// the truth. A reminder can be set at any upcoming moment, and one whose hour
// has already begun is written with a `send_at` in the past, so the next tick
// sends it at once — measured, a reminder for an event ten minutes away arrived
// saying "about 1 hour". The copy is computed at SEND time from the stored start
// now; an ordinary reminder (sent at start − 60 min) keeps its words exactly,
// which is the control.
// ---------------------------------------------------------------------------
test.describe("v8.12.6 (sweep) — a start reminder states how long is really left", () => {
  const { reminderLeadTime } = require("../lib/time");

  async function reminderFor(tag, startInMs) {
    const sa = await admin();
    const p = await participant(sa, tag);
    const comp = await sa.post("/api/admin/competitions", {
      name: `MailScen Lead ${tag} ${Date.now()}-${seq}`,
      start_time: new Date(Date.now() + startInMs).toISOString(), duration_minutes: 120,
    }, await sa.h());
    expect(comp.ok, comp.text).toBeTruthy();
    const compId = comp.body.competition.id;
    const a = await sa.post("/api/admin/competitions/assign", { competitionIds: [compId], userIds: [p.id] }, await sa.h());
    expect(a.body.assigned, "assign really enrolled them").toBe(1);
    const c = client();
    const li = await codeSignIn(c, p.email);
    expect(li.ok, li.text).toBeTruthy();
    const set = await c.post(`/api/competitions/${compId}/reminder`, {}, await c.h());
    expect(set.ok, `set reminder: ${set.text}`).toBeTruthy();
    // Due now whatever the offset, the way the late case is in production.
    sql(db => db.prepare("UPDATE email_reminders SET send_at=? WHERE competition_id=?")
      .run(new Date(Date.now() - 1000).toISOString(), compId));
    const before = smtp.messages.length;
    const t = await sa.post("/api/test/reminder-tick", {}, await sa.h());
    expect(t.body.ran, `tick: ${t.text}`).toBe(true);
    // The sign-in code mailed just above is a detached send and can land after
    // `before`: poll for the REMINDER, never the first message to the address.
    const msg = await inboxFor(p.email, { since: before, where: m => /starts in/.test(decodedParts(m.raw).join("\n")) });
    const rows = await sentReasons(p.email, "reminder");
    const row = rows.find(r => r.reason === "reminder");
    expect(row, "the reminder is recorded").toBeTruthy();
    return { set: set.body, subject: row.subject, body: decodedParts(msg.raw).join("\n") };
  }

  test("an event ten minutes away is announced as ten minutes away, and the set-reminder answer says the mail is on its way now", async () => {
    const r = await reminderFor("lead10", 10 * 60_000);
    expect(r.set.immediate, "the reminder's hour has begun, so the server says it goes out now").toBe(true);
    expect(r.subject, "the subject no longer claims an hour").not.toMatch(/1 hour/);
    expect(r.subject).toMatch(/ starts in (9|10) minutes$/);
    expect(r.body).toMatch(/starts in about (9|10) minutes\./);
    expect(r.body).not.toMatch(/about 1 hour/);
  });

  test("CONTROL: an event two hours away keeps the original copy word for word", async () => {
    const r = await reminderFor("lead120", 2 * 3600_000);
    expect(r.set.immediate, "an ordinary reminder is not due yet when it is set").toBe(false);
    expect(r.subject).toMatch(/ starts in 1 hour$/);
    expect(r.body).toMatch(/starts in about 1 hour\./);
  });

  test("the lead-time words at each boundary (lib/time reminderLeadTime)", () => {
    const at = (ms) => reminderLeadTime(1_000_000_000_000 + ms, 1_000_000_000_000);
    const ONE_HOUR = { subject: "starts in 1 hour", body: "starts in about 1 hour" };
    // The ordinary dispatch lands a little under the hour: the original words.
    expect(at(60 * 60_000)).toEqual(ONE_HOUR);
    expect(at(59 * 60_000 + 30_000)).toEqual(ONE_HOUR);
    expect(at(54 * 60_000 + 30_000), "55 minutes rounds into the band").toEqual(ONE_HOUR);
    expect(at(54 * 60_000 + 29_000)).toEqual({ subject: "starts in 54 minutes", body: "starts in about 54 minutes" });
    expect(at(10 * 60_000)).toEqual({ subject: "starts in 10 minutes", body: "starts in about 10 minutes" });
    expect(at(90_000)).toEqual({ subject: "starts in 2 minutes", body: "starts in about 2 minutes" });
    expect(at(60_000)).toEqual({ subject: "starts in a minute", body: "starts in about a minute" });
    expect(at(1_000)).toEqual({ subject: "starts in a minute", body: "starts in about a minute" });
    // A start already reached is never worded, so never mailed (operator ruling,
    // 25 Nov 2026): null, and the dispatcher settles that reminder unsent.
    expect(at(0), "the start itself is too late").toBeNull();
    expect(at(-1), "a millisecond past is too late").toBeNull();
    expect(at(-5 * 60_000)).toBeNull();
    // An unusable start keeps the original words — the one answer never computed from it.
    expect(reminderLeadTime(NaN, Date.now())).toEqual(ONE_HOUR);
  });
});

test.describe("a single-mail admin door reports what the relay did", () => {
  test("Email sign-in code: delivered → 'was emailed'; held past the door's deadline → still being sent, and the request returns at the deadline", async () => {
    // The refused send (`sent:false, reason:"send_failed"`) is driven on the
    // shared server, whose relay is a dead port (tests/signin-hardening.api.spec.js).
    const sa = await admin();
    const p1 = await participant(sa, "admcode");
    const p2 = await participant(sa, "admheld");
    // Let the registrations' own mail reach the relay before anything is held.
    await expect.poll(() => [p1, p2].every(p => smtp.messages.some(m => (m.rcptTo || []).map(x => x.toLowerCase()).includes(p.email.toLowerCase()))),
      { timeout: 15000, message: "each registration's mail reached the relay" }).toBe(true);
    const before = smtp.messages.length;
    const r1 = await sa.post(`/api/admin/participants/${p1.id}/login-code/email`, {}, await sa.h());
    expect(r1.status, r1.text).toBe(200);
    expect(r1.body, r1.text).toMatchObject({ ok: true, sent: true });
    expect(r1.body.deferred, "delivered, not still queued").toBeUndefined();
    expect(r1.body.message).toMatch(/was emailed/);
    await inboxFor(p1.email, { since: before, where: m => /sign-in[ _]code/i.test(m.header("subject") || "")   /* RFC 2047 Q-encoding writes spaces as _ */ });

    const hdr = await sa.h();
    smtp.hold();
    let r2, took;
    try {
      const t0 = Date.now();
      r2 = await sa.post(`/api/admin/participants/${p2.id}/login-code/email`, {}, hdr);
      took = Date.now() - t0;
    } finally { smtp.release(); }
    expect(r2.status, r2.text).toBe(200);
    expect(r2.body, r2.text).toMatchObject({ ok: true, sent: true, deferred: true });
    expect(r2.body.message).toMatch(/still being sent/);
    expect(took, "the answer came at the door's 10 s deadline, while the relay still held the mail").toBeGreaterThanOrEqual(9_000);
    expect(took).toBeLessThan(20_000);
    // The detached send finishes once the relay answers.
    await inboxFor(p2.email, { since: before, where: m => /sign-in[ _]code/i.test(m.header("subject") || "")   /* RFC 2047 Q-encoding writes spaces as _ */ });
  });

  test("Approve answers at its deadline while the relay holds the notice (emailDeferred), and reports a delivered one (CONTROL)", async () => {
    // The pooled relay queues mail behind everyone else's; a committed approval
    // must not wait past the browser's 30 s abort, which reads as "try again".
    const sa = await admin();
    const held = await participant(sa, "apprheld", { approved: false });
    const ctl = await participant(sa, "apprctl", { approved: false });
    await expect.poll(() => [held, ctl].every(p => smtp.messages.some(m => (m.rcptTo || []).map(x => x.toLowerCase()).includes(p.email.toLowerCase()))),
      { timeout: 15000, message: "each registration's mail reached the relay" }).toBe(true);
    const ok = await sa.post(`/api/admin/participants/${ctl.id}/approve`, {}, await sa.h());
    expect(ok.body, ok.text).toMatchObject({ ok: true, emailDelivered: true });
    expect(ok.body.emailDeferred, "CONTROL: a delivered notice is not deferred").toBeUndefined();

    const hdr = await sa.h();
    smtp.hold();
    let r, took;
    try {
      const t0 = Date.now();
      r = await sa.post(`/api/admin/participants/${held.id}/approve`, {}, hdr);
      took = Date.now() - t0;
    } finally { smtp.release(); }
    expect(r.status, r.text).toBe(200);
    expect(r.body, r.text).toMatchObject({ ok: true, emailDelivered: null, emailDeferred: true });
    expect(took, "the answer came at the 10 s deadline, while the relay still held the notice").toBeGreaterThanOrEqual(9_000);
    expect(took).toBeLessThan(20_000);
    expect(sql(db => db.prepare("SELECT approved FROM users WHERE id=?").get(held.id).approved), "the approval itself committed").toBe(1);
  });
});

test.describe("a single-mail door's report of a send that never reached the relay", () => {
  test("a send that REJECTS (its own lookups threw) reads as not delivered and is logged at warn under the caller's label, without its message; a refusal, a delivery and a held send are not logged (CONTROL)", () => {
    // sendEmailLogged records every SMTP outcome itself and returns false; it
    // REJECTS only when its pre-send lookups throw. The door still says "could
    // not be delivered", so lib/util.js awaitDeliveryWithDeadline must leave a
    // trace that says why — at the default log level, through lib/best-effort.
    // Driven in a child with lib/log loaded and mirrored to stderr.
    const { spawnSync } = require("child_process");
    const ROOT = path.join(__dirname, "..");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mail-report-"));
    const script = `
      require(${JSON.stringify(path.join(ROOT, "lib/log.js"))});
      const { awaitDeliveryWithDeadline } = require(${JSON.stringify(path.join(ROOT, "lib/util.js"))});
      setInterval(() => {}, 1000);   // the deadline's timer is unref'd: keep the loop alive as a server does
      (async () => {
        const boom = Object.assign(new Error("no such table: secret_users_table"), { code: "SQLITE_ERROR" });
        const out = {
          rejected: await awaitDeliveryWithDeadline(Promise.reject(boom), 2000, "test:rejected"),
          refused: await awaitDeliveryWithDeadline(Promise.resolve(false), 2000, "test:refused"),
          sent: await awaitDeliveryWithDeadline(Promise.resolve(true), 2000, "test:sent"),
          held: await awaitDeliveryWithDeadline(new Promise(() => {}), 50, "test:held"),
        };
        process.stdout.write("RESULT " + JSON.stringify(out) + "\\n");
        process.exit(0);
      })();`;
    let r;
    try {
      r = spawnSync(process.execPath, ["-e", script], { cwd: ROOT, encoding: "utf8", timeout: 30_000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: "", NODE_ENV: "test", BASE_URL: "http://localhost",
          LOG_CONSOLE_MIRROR: "1", LOG_LEVEL: "info", DATA_DIR: path.join(tmp, "data"), UPLOADS_DIR: path.join(tmp, "uploads") } });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    expect(r.status, `child: ${r.stdout}${r.stderr}`).toBe(0);
    const result = JSON.parse((r.stdout.split("\n").find(l => l.startsWith("RESULT ")) || "RESULT null").slice(7));
    expect(result, "what each door would be told").toEqual({ rejected: false, refused: false, sent: true, held: null });
    const lines = `${r.stdout}\n${r.stderr}`.split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const traced = lines.filter(l => typeof l.where === "string" && l.where.startsWith("test:"));
    expect(traced.map(l => ({ level: l.level, where: l.where, err_name: l.err_name, err_code: l.err_code })),
      "exactly the rejected send is logged, at warn, by name and code").toEqual([{ level: "warn", where: "test:rejected", err_name: "Error", err_code: "SQLITE_ERROR" }]);
    expect(`${r.stdout}${r.stderr}`, "the error's message (it can name tables or addresses) is not logged").not.toContain("secret_users_table");
  });
});

test.describe("a person's own single-mail doors answer at the deadline too", () => {
  test("an email change and a resend of the verification link answer at the deadline while the relay holds the mail (emailDeferred); an accepted change is reported as sent (CONTROL)", async () => {
    const sa = await admin();
    const p = await participant(sa, "selfheld");
    const c = client();
    const li = await codeSignIn(c, p.email);
    expect(li.ok, `login: ${li.text}`).toBeTruthy();
    // Let the registration's and the sign-in's own mail reach the relay first.
    await expect.poll(() => smtp.messages.filter(m => (m.rcptTo || []).map(x => x.toLowerCase()).includes(p.email.toLowerCase())).length,
      { timeout: 15000, message: "the earlier mail reached the relay" }).toBeGreaterThanOrEqual(2);

    // CONTROL: a change the relay accepts at once is reported as sent.
    const first = uniq("selfheld-a");
    const ok = await c.put("/api/me", { email: first }, await c.h());
    expect(ok.body, ok.text).toMatchObject({ ok: true, emailChangePending: true, emailDelivered: true });
    expect(ok.body.emailDeferred, "CONTROL: a delivered confirmation is not deferred").toBeUndefined();

    // Held by the relay: the answer comes at the deadline, the change stays staged.
    const second = uniq("selfheld-b");
    const hdr = await c.h();
    smtp.hold();
    let r, took;
    try {
      const t0 = Date.now();
      r = await c.put("/api/me", { email: second }, hdr);
      took = Date.now() - t0;
    } finally { smtp.release(); }
    expect(r.status, r.text).toBe(200);
    expect(r.body, r.text).toMatchObject({ ok: true, emailChangePending: true, pendingEmail: second, emailDelivered: null, emailDeferred: true });
    expect(r.body.message).toMatch(/still being sent/);
    expect(took, "the answer came at the 10 s deadline, while the relay still held the mail").toBeGreaterThanOrEqual(9_000);
    expect(took).toBeLessThan(20_000);
    await inboxFor(second);   // the send finishes in the background

    // The resend-verification door, from a live verification grace.
    sql(db => db.prepare("UPDATE users SET verified=0, self_enroll_grace_until=? WHERE id=?")
      .run(new Date(Date.now() + 3600_000).toISOString(), p.id));
    const hdr2 = await c.h();
    smtp.hold();
    let rv, took2;
    try {
      const t0 = Date.now();
      rv = await c.post("/api/resend-verification", {}, hdr2);
      took2 = Date.now() - t0;
    } finally { smtp.release(); }
    expect(rv.status, rv.text).toBe(200);
    expect(rv.body, rv.text).toMatchObject({ ok: true, emailDelivered: null, emailDeferred: true });
    expect(took2, "the resend answered at the deadline too").toBeGreaterThanOrEqual(9_000);
    expect(took2).toBeLessThan(20_000);
  });
});

// THE SIGN-IN CODE MAIL PROMISES A JOIN ONLY TO SOMEONE THE CODE WILL ENROL
// (sweep finding #353). A code requested through a join link is bound to its
// event, and the mail said "Signing in with it will also join you to …" to every
// account — though the redeem enrols no admin-class account (operator ruling,
// 17 Nov 2026) and no staff on an event where staff compete. The line now
// follows `codeBoundJoinWillEnrol` (lib/self-enroll.js), the redeem's own rules;
// each arm checks the mail against what the redeem then does.
test.describe("the sign-in code mail promises a join only to someone the code will enrol", () => {
  test("a participant's code from a join link says it joins them, and does; an organiser's says nothing of the event, and joins nobody", async () => {
    const sa = await admin();
    const name = `Join promise ${Date.now()}`;
    const c = await sa.post("/api/admin/competitions", { name, event_kind: "tournament", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240, self_enroll_enabled: true }, await sa.h());
    expect(c.ok, c.text).toBeTruthy();
    const compId = c.body.competition.id;
    const token = (await sa.get(`/api/admin/competitions/${compId}/self-enroll`)).body.token;
    expect(token, "PRECONDITION: a live join token").toBeTruthy();
    const p = await participant(sa, "joinpromise");
    const org = await participant(sa, "joinpromiseorg");
    const role = await sa.post(`/api/admin/participants/${org.id}/role`, { role: "admin" }, await sa.h());
    expect(role.ok, `make an organiser: ${role.text}`).toBeTruthy();
    const LINE = "in the browser where you asked for it also joins you to";
    const member = (uid) => !!sql(db => db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uid));
    /** Request a code through the join link, read the mail off the wire, then redeem it. */
    const codeThroughLink = async (who) => {
      const cl = client();
      await cl.post("/api/test/reset-recent-code-sends", undefined, await cl.h());
      const before = smtp.messages.length;
      const r = await cl.post("/api/auth/code/request", { email: who.email, joinToken: token }, await cl.h());
      expect(r.status, "200 always").toBe(200);
      const msg = await inboxFor(who.email, { since: before, where: m => /sign-in.code/i.test(m.header("subject") || "") });
      const code = (await cl.get(`/api/test/last-login-code?email=${encodeURIComponent(who.email)}`)).body.code;
      const rd = await cl.post("/api/auth/code/redeem", { email: who.email, code }, await cl.h());
      expect(rd.body && rd.body.ok, `redeem: ${rd.text}`).toBe(true);
      return decodedParts(msg.raw).join("\n");
    };
    const pMail = await codeThroughLink(p);
    expect(pMail, "a participant is told the code joins them").toContain(LINE);
    expect(pMail).toContain(name);
    // …only while the link stays open: switching it off or replacing it unties
    // the code (sweep #391), so the promise says so.
    expect(pMail, "the promise holds only while the join link is open").toContain("as long as its join link is still open");
    expect(member(p.id), "…and the redeem enrols them").toBe(true);
    const oMail = await codeThroughLink(org);
    expect(oMail, "an organiser is promised nothing about the event").not.toContain(LINE);
    expect(oMail).not.toContain(name);
    expect(member(org.id), "…and the redeem enrols nobody, as the mail said").toBe(false);
    // Somebody already in the event is joined to nothing, so promised nothing.
    const again = await codeThroughLink(p);
    expect(again, "a member is promised no join").not.toContain(LINE);

    // Staff on an event where staff compete: the redeem leaves the choice to the
    // "Compete in this event?" confirm, so the mail promises nothing either.
    const sname = `Join promise staff ${Date.now()}`;
    const sc = await sa.post("/api/admin/competitions", { name: sname, event_kind: "tournament", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240, self_enroll_enabled: true, staff_compete: true }, await sa.h());
    expect(sc.ok, sc.text).toBeTruthy();
    const sId = sc.body.competition.id;
    const sToken = (await sa.get(`/api/admin/competitions/${sId}/self-enroll`)).body.token;
    const staff = await participant(sa, "joinpromisestaff");
    const tg = await sa.post(`/api/admin/participants/${staff.id}/tags`, { tag: "staff" }, await sa.h());
    expect(tg.ok, `staff tag: ${tg.text}`).toBeTruthy();
    const cl = client();
    await cl.post("/api/test/reset-recent-code-sends", undefined, await cl.h());
    const before = smtp.messages.length;
    expect((await cl.post("/api/auth/code/request", { email: staff.email, joinToken: sToken }, await cl.h())).status).toBe(200);
    const sMsg = await inboxFor(staff.email, { since: before, where: m => /sign-in.code/i.test(m.header("subject") || "") });
    const code = (await cl.get(`/api/test/last-login-code?email=${encodeURIComponent(staff.email)}`)).body.code;
    const rd = await cl.post("/api/auth/code/redeem", { email: staff.email, code }, await cl.h());
    expect(rd.body && rd.body.ok, rd.text).toBe(true);
    expect(decodedParts(sMsg.raw).join("\n"), "staff where staff compete are promised nothing").not.toContain(LINE);
    expect(!!sql(db => db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(sId, staff.id)), "…and the redeem enrols nobody").toBe(false);
  });
});

// THE SIGN-UP CODE MAIL NAMES THE EVENT ONLY AS THE BROWSER THAT ASKED WILL
// JOIN IT. A code mailed to an address no account holds (the address proof),
// asked for through an event's join link, carries that event into the sign-up
// only in the browser where it was asked for (routes/auth.js
// `_sessionNamedEvent`), so the mail says so.
test.describe("the sign-up code mail says where its event counts", () => {
  test("asked for through a join link, it says the new account joins the event in the browser where the code was asked for; asked for plainly, it names no event (CONTROL)", async () => {
    const sa = await admin();
    const name = `Proof line ${Date.now()}`;
    const c = await sa.post("/api/admin/competitions", { name, event_kind: "tournament", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 240, self_enroll_enabled: true }, await sa.h());
    expect(c.ok, c.text).toBeTruthy();
    const token = (await sa.get(`/api/admin/competitions/${c.body.competition.id}/self-enroll`)).body.token;
    expect(token, "PRECONDITION: a live join token").toBeTruthy();
    const LINE = "If you create your account in the browser where you asked for this code, it will join";
    const proofMail = async (addr, extra) => {
      const cl = client();
      await cl.post("/api/test/reset-recent-code-sends", undefined, await cl.h());
      const before = smtp.messages.length;
      const r = await cl.post("/api/auth/code/request", { email: addr, ...extra }, await cl.h());
      expect(r.status, "200 always").toBe(200);
      const msg = await inboxFor(addr, { since: before, where: m => /sign-in.code/i.test(m.header("subject") || "") });
      const code = (await cl.get(`/api/test/last-login-code?email=${encodeURIComponent(addr)}`)).body;
      expect(code && code.via, `PRECONDITION: ${addr} was mailed an address proof`).toBe("proof");
      return decodedParts(msg.raw).join("\n");
    };
    const withEvent = await proofMail(`proofline-${Date.now()}@acme-proof.example`, { joinToken: token });
    expect(withEvent, "the line says where the event counts").toContain(LINE);
    expect(withEvent, "…and names the event").toContain(name);
    expect(withEvent, "…and that it holds only while the join link is open (sweep #391)").toContain("as long as its join link is still open");
    const plain = await proofMail(`proofplain-${Date.now()}@acme-proof.example`, {});
    expect(plain, "CONTROL: asked for plainly, no event line").not.toContain("it will join");
    expect(plain).not.toContain(name);
  });
});

// THE LOCKOUT MAIL NEVER SAYS THE LOCK KEEPS GUESSES OUT. A lock refuses no
// guess: while it lasts a wrong code or password is not counted again, and a
// correct one signs the holder in and lifts it (lib/lockout.js). What bounds
// guessing is each sign-in door's rate limits. So the mail is an alarm, and it
// tells the owner how to get in.
test.describe("the lockout mail is an alarm that says how to get in", () => {
  test("it says the account was locked and that a correct code still signs the owner in, never that guesses are kept out", async () => {
    const ctx = await SCENARIOS.lockout.run();
    const msg = await inboxFor(ctx.email, { since: ctx.before, where: m => /locked/i.test(m.header("subject") || "") });
    const body = decodedParts(msg.raw).join("\n");
    expect(body, "it says the account is locked, and until when").toMatch(/marked as locked until/);
    expect(body, "…that a correct code or password still gets the owner in").toMatch(/signs you in and lifts the lock/);
    expect(body, "…and never that the lock stops guesses").not.toMatch(/against further guesses/i);
  });
});
