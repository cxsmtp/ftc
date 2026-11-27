"use strict";

// THE CERTIFICATE EMAIL'S LEDGER WHEN A SEND FAILS, IS STILL GOING OUT, IS
// REFUSED AFTER IT STARTED, OR IS ON ITS WAY WHEN THE SERVER STOPS (sweeps #44
// and #352).
//
// lib/certificate-dispatch.js keeps one `certificate_emails` row per certificate.
// What is held here, each beside the control that makes it mean something:
//   * a send the relay refuses is retried 5 minutes, then 30 minutes, after it
//     failed (`RETRY_BACKOFF_MS`), never sooner even by a pass that runs, and is
//     given up after its third attempt (`MAX_ATTEMPTS`): no pass sends it again,
//     forced or not, relay working or not, and the event's certificate list says
//     so; an admin's Resend still reaches the holder;
//   * Resend while the certificate's email is still on its way is refused
//     (`certificate_email_in_flight`) and leaves the ledger to that send;
//   * Resend names a participant with no live certificate (`no_certificate`):
//     one never issued, and one whose certificate was revoked;
//   * Resend whose admin session ends AFTER its PDF render is refused at its
//     re-check of the admin, which runs after the render (the session is ended
//     while the send is held there), and puts the row back exactly as it was, or
//     removes the row its claim created (`_ledgerRestore`);
//   * the shutdown drain waits for a pass that is inside a send
//     (`certificateDispatchBusy`): the server stopped while a send is held after
//     its render exits 0 once that send is delivered, its row `sent` at the next
//     start (a drain that did not wait would leave it `sending`, marked
//     `unknown` and never mailed), and the pass, stopped, keeps its job.
//
// The relay is a real capturing one (tests/smtp-capture.js): it refuses a chosen
// recipient (`rejectRecipients`) and withholds its "queued" reply on demand
// (`hold`), so a failed send and a send in flight are both driven on purpose,
// never by timing. This file spawns its own server for that relay; the worker
// never runs by itself under NODE_ENV=test, so each pass is
// `POST /api/test/certificate-dispatch-tick`, narrowed to the test's own event.
// A send is held after its render by the send park
// (`POST /api/test/certificate-send-delay`), and the server is stopped through
// its SIGTERM drain by `POST /api/test/shutdown`, then started again on the same
// data directory.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { PORT_BASE } = require("./helpers");
const { startSmtpCapture } = require("./smtp-capture");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = PORT_BASE + 101;
const BASE = `http://127.0.0.1:${PORT}`;

let smtp, child = null, childExit = null, dataDir, uploadsDir, superPass, childOut = "";

function client() {
  const jar = [];
  const call = async (method, p, data, headers = {}, signal) => {
    const r = await fetch(BASE + p, {
      method, signal,
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
    call,
    get: (p, h) => call("GET", p, undefined, h),
    post: (p, d, h) => call("POST", p, d, h),
    put: (p, d, h) => call("PUT", p, d, h),
    async h() { return { "x-csrf-token": (await call("GET", "/api/csrf-token")).body.csrfToken }; },
    /** The express-session id behind this client's cookie: the key `revoked_sessions` tombstones. */
    sessionId() {
      const c = jar.find(x => x.startsWith("connect.sid="));
      const v = c ? decodeURIComponent(c.slice("connect.sid=".length)) : "";
      return v.startsWith("s:") ? v.slice(2, v.lastIndexOf(".")) : v;
    },
  };
}

function sql(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(path.join(dataDir, "hackathon.db"));
  try { return fn(db); } finally { db.close(); }
}

async function boot() {
  childOut = "";
  const c = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test",
      PORT: String(PORT), DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, BASE_URL: BASE,
      SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), SMTP_ALLOW_PLAINTEXT: "1",
      SUPERADMIN_PASSWORD_QUIET: "1", RATE_LIMIT_DISABLED: "1", LOG_CONSOLE_MIRROR: "1",
      NODE_OPTIONS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = c;
  c.stdout.on("data", d => { childOut += d; });
  c.stderr.on("data", d => { childOut += d; });
  // `close`, not `exit`: it comes after the child's stdout has been read to the
  // end, so its last lines (the shutdown drain's report) are in `childOut`.
  let exited = false;
  childExit = new Promise(resolve => c.once("close", (code, signal) => {
    exited = true;
    if (child === c) child = null;
    resolve({ code, signal });
  }));
  const spawnedAt = Date.now();
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline && !exited) {
    try {
      const r = await fetch(`${BASE}/api/config`);
      if (r.ok) {
        const cfg = await r.json();
        if (cfg.server_started_at && new Date(cfg.server_started_at).getTime() >= spawnedAt - 2000) {
          superPass = fs.readFileSync(path.join(dataDir, ".superadmin-password"), "utf8").trim();
          return;
        }
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`server never became ready. Log:\n${childOut.slice(-2000)}`);
}

/** The port must be free before a respawn binds it. */
async function portFree() {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/healthz`); } catch (_) { return; }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`port ${PORT} was never freed`);
}

async function kill() {
  if (!child) return;
  const c = child, done = childExit;
  try { c.kill("SIGKILL"); } catch (_) { /* already gone */ }
  await done;
  await portFree();
}

test.beforeAll(async () => {
  smtp = await startSmtpCapture();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "certledger-"));
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "certledger-up-"));
  await boot();
});

test.afterAll(async () => {
  await kill();
  try { smtp && await smtp.close(); } catch (_) {}
  for (const d of [dataDir, uploadsDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

test.beforeEach(async () => {
  guardFixedPortSpec();
  // A test that stopped the server and failed before starting it again must
  // not take the next one down with it.
  if (!child) { await portFree(); await boot(); }
});
// Whatever a test did to the relay, the next one starts with a relay that delivers.
test.afterEach(() => { smtp.rejectRecipients(null); smtp.release(); });

/** The built-in superadmin, signed in. Signing in again ends the previous session (one per principal). */
async function admin() {
  const c = client();
  const r = await c.post("/api/login", { email: "superadmin", password: superPass }, await c.h());
  expect(r.ok, `superadmin login: ${r.status} ${r.text}`).toBeTruthy();
  return c;
}

let seq = 0;
const stamp = () => `${Date.now()}${++seq}`;

/** A verified, approved participant, signed up and signed in through the emailed-code doors. */
async function participant(tag) {
  const c = client();
  const s = stamp();
  const email = `${tag}-${s}@company.co`;
  await c.post("/api/test/reset-recent-code-sends", undefined, await c.h());
  await c.post("/api/auth/code/request", { email }, await c.h());
  const proof = await c.get("/api/test/last-login-code?email=" + encodeURIComponent(email));
  await c.post("/api/auth/code/redeem", { email, code: proof.body && proof.body.code }, await c.h());
  const r = await c.post("/api/register", {
    firstName: "Ledger", lastName: `Holder${tag}`, nickname: `${tag}${s}`.replace(/[^a-z0-9_]/gi, "").slice(0, 20),
    company: "Acme", title: "Eng", country: "US", timezone: "America/New_York", email,
  }, await c.h());
  expect(r.ok, `register ${tag}: ${r.status} ${r.text}`).toBeTruthy();
  const id = sql(db => db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email).id);
  expect(sql(db => db.prepare("SELECT verified, approved, blocked FROM users WHERE id=?").get(id)), `PRECONDITION: ${tag} may be issued and mailed`)
    .toEqual({ verified: 1, approved: 1, blocked: 0 });
  return { c, email, id };
}

/** A live tournament of `tasks` published challenges. */
async function makeEvent(sa, { tasks = 2 } = {}) {
  const cr = await sa.post("/api/admin/competitions", {
    name: `CertLedger ${stamp()}`, event_kind: "tournament",
    start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 600, timezone: "UTC",
  }, await sa.h());
  expect(cr.ok, `create: ${cr.text}`).toBeTruthy();
  const comp = cr.body.competition;
  const taskIds = [];
  for (let i = 0; i < tasks; i++) {
    const tr = await sa.post("/api/admin/tasks", {
      title: `CL task ${stamp()}`, description: "<p>d</p>", difficulty: "easy",
      answer_type: "text", correct_answer: `right${i}`, status: "published",
    }, await sa.h());
    expect(tr.ok, tr.text).toBeTruthy();
    const a = await sa.post(`/api/admin/tasks/${tr.body.id}/competitions`, { competitionIds: [comp.id] }, await sa.h());
    expect(a.ok, a.text).toBeTruthy();
    taskIds.push(tr.body.id);
  }
  return { comp, taskIds };
}

async function assign(sa, compId, ps) {
  const r = await sa.post("/api/admin/competitions/assign", { userIds: ps.map(p => p.id), competitionIds: [compId] }, await sa.h());
  expect(r.ok, r.text).toBeTruthy();
  expect(r.body.assigned, `assigned ${JSON.stringify(r.body)}`).toBe(ps.length);
}

/** Enter the event and answer its first challenge (`right0` is correct). Nobody answers the second, so no all-solved end. */
async function play(p, compId, taskId, answer) {
  const sel = await p.c.post("/api/select-competition", { competitionId: compId }, await p.c.h());
  expect(sel.ok, sel.text).toBeTruthy();
  if (!taskId) return null;
  const t = await p.c.get(`/api/tasks/${taskId}`, { "x-competition-id": compId });
  expect(t.ok, t.text).toBeTruthy();
  const r = await p.c.post(`/api/tasks/${taskId}/submit`, { answer, gradingHash: t.body.grading_hash }, { ...(await p.c.h()), "x-competition-id": compId });
  expect(r.ok, `submit: ${r.text}`).toBeTruthy();
  return r.body;
}

/**
 * End the event, then one status-scheduler pass: the scheduler also runs by
 * itself, and the pass that first sees an end queues the event's job again
 * (new due time, passes reset), so it is settled before a test's own passes.
 */
async function endNow(sa, compId) {
  const r = await sa.post(`/api/admin/competitions/${compId}/end-now`, {}, await sa.h());
  expect(r.ok, `end-now: ${r.text}`).toBeTruthy();
  const s = await sa.post("/api/test/scheduler-tick", {}, await sa.h());
  expect(s.ok, `scheduler tick: ${s.text}`).toBeTruthy();
}

/** One dispatcher pass over THIS event's jobs and retries only. */
async function tickFor(sa, competitionId, force = true) {
  const r = await sa.post("/api/test/certificate-dispatch-tick", { force, competitionId }, await sa.h());
  expect(r.ok, `tick: ${r.text}`).toBeTruthy();
  return r.body;
}

/**
 * Captured congratulations emails to `email` (the sign-in code mails excluded),
 * from the `since`-th captured message on. The relay records a message when it
 * has arrived, whether or not its reply is being withheld (`hold`).
 */
function certMails(email, since = 0) {
  return smtp.messages.slice(since).filter(m => (m.rcptTo || []).some(a => a.toLowerCase() === email.toLowerCase())
    && /certificate/i.test(m.header("subject") || "") && !/sign-in code/i.test(m.header("subject") || ""));
}

/** Settles with `promise`, or fails naming `what` after `ms` with the server's last output. */
async function settled(promise, ms, what) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} (${ms} ms). Log:\n${childOut.slice(-2000)}`)), ms); });
  try { return await Promise.race([promise, t]); } finally { clearTimeout(timer); }
}

/**
 * The send park (`POST /api/test/certificate-send-delay`): every certificate
 * send waits there after its PDF render, before its re-checks, `delayMs` from
 * when it entered or until released. Called with no session: a test hook asks
 * for none.
 */
const sendPark = {
  async arm(delayMs) {
    const r = await client().post("/api/test/certificate-send-delay", { delayMs });
    expect(r.ok, `arm the send park: ${r.status} ${r.text}`).toBeTruthy();
    expect(r.body, "armed, nothing parked yet").toMatchObject({ delayMs, parked: 0 });
  },
  async state() {
    const r = await client().get("/api/test/certificate-send-delay");
    expect(r.ok, `read the send park: ${r.status} ${r.text}`).toBeTruthy();
    return r.body;
  },
  async release() {
    const r = await client().post("/api/test/certificate-send-delay", { release: true });
    expect(r.ok, `release the send park: ${r.status} ${r.text}`).toBeTruthy();
    return r.body.released;
  },
  /** Polls until `n` sends have entered the park; answers its state. */
  async entered(n) {
    let st = null;
    // Every 50 ms: the time a send stays parked is counted from its entry.
    await expect.poll(async () => (st = await this.state()).parked,
      { timeout: 15000, intervals: [50], message: `PRECONDITION: ${n} send(s) rendered and reached the park` }).toBe(n);
    return st;
  },
};

const badgeOf = (compId, userId) => sql(db => db.prepare("SELECT * FROM achievement_badges WHERE competition_id=? AND user_id=? ORDER BY created_at").all(compId, userId));
const ledgerRow = (token) => sql(db => db.prepare("SELECT * FROM certificate_emails WHERE badge_token=?").get(token));
const shareLinks = (token) => sql(db => db.prepare("SELECT COUNT(*) n FROM certificate_share_links WHERE badge_token=?").get(token).n);
const emailedEvents = (userId) => sql(db => db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='certificate_emailed' ORDER BY rowid").all(userId))
  .map(r => JSON.parse(r.details));
const resend = async (sa, compId, userId) => sa.post(`/api/admin/competitions/${compId}/certificates/resend`, { userId }, await sa.h());

test.describe("a certificate email the relay refuses is retried on a back-off, then given up", () => {
  test("retried 5 minutes, then 30 minutes after it failed, never sooner; given up after the third attempt, whatever runs; Resend still reaches the holder", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa);
    const bad = await participant("bo"), good = await participant("bg");
    await assign(sa, comp.id, [bad, good]);
    for (const p of [bad, good]) expect((await play(p, comp.id, taskIds[0], "right0")).correct).toBe(true);
    await endNow(sa, comp.id);
    // Due NOW, so UNFORCED passes run the job: a forced pass treats every retry
    // as due too, and the back-off would never be seen.
    expect(sql(db => db.prepare("UPDATE certificate_dispatch_jobs SET due_at=? WHERE competition_id=?").run(new Date(Date.now() - 1000).toISOString(), comp.id).changes),
      "PRECONDITION: the end queued the event's job").toBe(1);
    smtp.rejectRecipients(a => String(a).toLowerCase() === bad.email.toLowerCase());

    // ATTEMPT 1: the relay refuses the one holder; the other is mailed.
    const t1 = await tickFor(sa, comp.id, false);
    expect(t1, `the first pass: ${JSON.stringify(t1)}`).toMatchObject({ issued: 2, sent: 1, failed: 1, retried: 0 });
    await expect.poll(() => certMails(good.email).length, { timeout: 15000, message: "CONTROL: the other holder is mailed" }).toBe(1);
    expect(certMails(bad.email), "nothing reached the refused holder").toHaveLength(0);
    const token = badgeOf(comp.id, bad.id)[0].token;
    const gap = (r) => Date.parse(r.next_attempt_at) - Date.parse(r.updated_at);
    const r1 = ledgerRow(token);
    expect(r1).toMatchObject({ status: "failed", attempts: 1, last_error: "smtp_failed", sent_at: null });
    expect(gap(r1), `retried 5 minutes after the failure: ${r1.updated_at} → ${r1.next_attempt_at}`).toBeGreaterThanOrEqual(5 * 60_000);
    expect(gap(r1)).toBeLessThan(5 * 60_000 + 2000);
    expect(emailedEvents(bad.id).at(-1), "the failure is on the holder's History, with when it is retried")
      .toMatchObject({ status: "failed", attempt: 1, via: "automatic", error: "smtp_failed", next_attempt_at: r1.next_attempt_at });

    // NOT SOONER: a pass that runs before the retry is due sends nothing.
    const early = await tickFor(sa, comp.id, false);
    expect(early, `a pass before the retry is due: ${JSON.stringify(early)}`).toMatchObject({ retried: 0, sent: 0, failed: 0 });
    expect(ledgerRow(token), "the row is as it was").toEqual(r1);

    // ATTEMPT 2, once due (5 minutes on): refused again, retried 30 minutes later.
    const due = () => sql(db => db.prepare("UPDATE certificate_emails SET next_attempt_at=? WHERE badge_token=?").run(new Date(Date.now() - 1000).toISOString(), token));
    due();
    const t2 = await tickFor(sa, comp.id, false);
    expect(t2, `the first retry: ${JSON.stringify(t2)}`).toMatchObject({ retried: 1, failed: 1, sent: 0 });
    const r2 = ledgerRow(token);
    expect(r2).toMatchObject({ status: "failed", attempts: 2, last_error: "smtp_failed" });
    expect(gap(r2), `retried 30 minutes after the second failure: ${r2.updated_at} → ${r2.next_attempt_at}`).toBeGreaterThanOrEqual(30 * 60_000);
    expect(gap(r2)).toBeLessThan(30 * 60_000 + 2000);
    expect(emailedEvents(bad.id).at(-1)).toMatchObject({ status: "failed", attempt: 2, via: "retry", next_attempt_at: r2.next_attempt_at });

    // ATTEMPT 3, the last: refused, and given up — no next attempt.
    due();
    const t3 = await tickFor(sa, comp.id, false);
    expect(t3, `the second retry: ${JSON.stringify(t3)}`).toMatchObject({ retried: 1, failed: 1, sent: 0 });
    const r3 = ledgerRow(token);
    expect(r3, "given up after the third attempt").toMatchObject({ status: "failed", attempts: 3, last_error: "smtp_failed", next_attempt_at: null });
    const last = emailedEvents(bad.id).at(-1);
    expect(last).toMatchObject({ status: "failed", attempt: 3, via: "retry", error: "smtp_failed" });
    expect(last.next_attempt_at, "…and the History names no next attempt").toBeUndefined();
    expect(emailedEvents(bad.id), "three attempts recorded, no more").toHaveLength(3);

    // GIVEN UP means given up: a FORCED pass with a relay that now delivers sends nothing.
    smtp.rejectRecipients(null);
    const after = await tickFor(sa, comp.id, true);
    expect(after, `a forced pass after the give-up: ${JSON.stringify(after)}`).toMatchObject({ retried: 0, sent: 0 });
    expect(ledgerRow(token)).toEqual(r3);
    expect(certMails(bad.email), "nobody retried it").toHaveLength(0);
    // The organisers see it failed with nothing pending, so they know to act.
    const list = await sa.get(`/api/admin/competitions/${comp.id}/certificates`);
    expect(list.ok, list.text).toBeTruthy();
    expect(list.body.certificates.find(c => c.userId === bad.id).emailStatus)
      .toMatchObject({ status: "failed", attempts: 3, lastError: "smtp_failed", nextAttemptAt: null });
    expect(list.body.counts.failed, "counted as failed").toBe(1);

    // CONTROL: an admin's Resend is the remedy, and it reaches the holder.
    const rs = await resend(sa, comp.id, bad.id);
    expect(rs.status, rs.text).toBe(200);
    expect(rs.body).toMatchObject({ ok: true, status: "sent" });
    await expect.poll(() => certMails(bad.email).length, { timeout: 15000 }).toBe(1);
    expect(ledgerRow(token)).toMatchObject({ status: "sent", attempts: 4, last_error: null, next_attempt_at: null });
    expect(certMails(good.email), "the other holder was mailed once").toHaveLength(1);
  });
});

test.describe("an admin's Resend: in flight, no certificate, and refused after it started", () => {
  test("Resend while the certificate's email is still on its way is refused and leaves the ledger to that send; once it lands, Resend sends", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa);
    const p = await participant("fl");
    await assign(sa, comp.id, [p]);
    expect((await play(p, comp.id, taskIds[0], "right0")).correct).toBe(true);
    await endNow(sa, comp.id);
    // The relay keeps the message but withholds its reply: the send stays in flight.
    // Its arrival is counted BY RECIPIENT AND SUBJECT, never by the relay's held
    // count: `hold()` withholds every message that arrives from now on, and the
    // sign-in mail `participant()` sent detached may still land meanwhile.
    const since = smtp.messages.length;
    smtp.hold();
    const pass = tickFor(sa, comp.id);
    pass.catch(() => {});
    let token;
    try {
      await expect.poll(() => certMails(p.email, since).length,
        { timeout: 15000, message: "PRECONDITION: the pass's certificate mail reached the relay, which withholds its reply" }).toBe(1);
      // Issued and claimed before that mail was sent, so both are there to read.
      token = badgeOf(comp.id, p.id)[0].token;
      const before = ledgerRow(token);
      expect(before, "PRECONDITION: the send has claimed the ledger and is waiting on the relay").toMatchObject({ status: "sending", attempts: 1 });
      const rs = await resend(sa, comp.id, p.id);
      expect(rs.status, rs.text).toBe(409);
      expect(rs.body.code).toBe("certificate_email_in_flight");
      expect(ledgerRow(token), "the refused Resend left the row to the send in flight").toEqual(before);
      expect(certMails(p.email, since), "…and sent nothing of its own").toHaveLength(1);
    } finally { smtp.release(); }
    const out = await pass;
    expect(out, JSON.stringify(out)).toMatchObject({ issued: 1, sent: 1 });
    expect(ledgerRow(token)).toMatchObject({ status: "sent", attempts: 1 });
    expect(certMails(p.email), "one mail: the pass's").toHaveLength(1);
    // CONTROL: with nothing in flight, Resend sends.
    const ok = await resend(sa, comp.id, p.id);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, status: "sent" });
    await expect.poll(() => certMails(p.email).length, { timeout: 15000 }).toBe(2);
    expect(ledgerRow(token)).toMatchObject({ status: "sent", attempts: 2 });
  });

  test("Resend for somebody holding no live certificate is refused as such: one never issued, one revoked; the holder's is sent", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa);
    const holder = await participant("nh"), idle = await participant("ni"), rev = await participant("nr");
    await assign(sa, comp.id, [holder, idle, rev]);
    for (const p of [holder, rev]) expect((await play(p, comp.id, taskIds[0], "right0")).correct).toBe(true);
    await play(idle, comp.id, null);   // entered, never answered: no certificate
    await endNow(sa, comp.id);
    const out = await tickFor(sa, comp.id);
    expect(out, JSON.stringify(out)).toMatchObject({ issued: 2, sent: 2 });
    for (const p of [holder, rev]) await expect.poll(() => certMails(p.email).length, { timeout: 15000 }).toBe(1);
    expect(badgeOf(comp.id, idle.id), "PRECONDITION: the idle member holds none").toEqual([]);
    const revToken = badgeOf(comp.id, rev.id)[0].token;
    const rv = await sa.post(`/api/admin/badges/${encodeURIComponent(revToken)}/revoke`, { reason: "test" }, await sa.h());
    expect(rv.ok, rv.text).toBeTruthy();
    const revLedger = ledgerRow(revToken);

    for (const [p, what] of [[idle, "never issued"], [rev, "revoked"]]) {
      const r = await resend(sa, comp.id, p.id);
      expect(r.status, `${what}: ${r.text}`).toBe(404);
      expect(r.body.code, what).toBe("no_certificate");
    }
    expect(ledgerRow(revToken), "the revoked certificate's ledger is untouched").toEqual(revLedger);
    expect(certMails(idle.email)).toHaveLength(0);
    expect(certMails(rev.email), "the revoked holder is not mailed again").toHaveLength(1);
    // CONTROL: the live holder's is sent.
    const ok = await resend(sa, comp.id, holder.id);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, status: "sent" });
    await expect.poll(() => certMails(holder.email).length, { timeout: 15000 }).toBe(2);
  });

  test("Resend whose admin session ends between its render and its re-check is refused there and puts the ledger back exactly: the row that was there, and none where its claim made one", async () => {
    // HOW THE REFUSAL IS REACHED. Resend claims the ledger, renders the PDF (an
    // await), then re-asks the admin synchronously before the mail goes out
    // (`recheck`: adminAuthzDenied, which reads the session TOMBSTONE a sign-in
    // elsewhere, a logout or a role change writes). Both Resends are held INSIDE
    // their send, after the render and before that re-check (the send park,
    // `POST /api/test/certificate-send-delay`), and only then is the admin's
    // session tombstoned. By that moment every header-time check has admitted
    // the request (requireAdmin admits the built-in superadmin on its session
    // flags; the session slide met no tombstone at entry), its claim is written
    // and its render done, so the re-check is the first to meet the tombstone:
    // the state of a request whose session is ended mid-render. A re-check run
    // before the render, or none, lets the mail go (seen failing on both).
    let sa = await admin();
    // A: mailed by the automatic pass, so its ledger row exists.
    const A = await makeEvent(sa);
    const pa = await participant("lra");
    await assign(sa, A.comp.id, [pa]);
    expect((await play(pa, A.comp.id, A.taskIds[0], "right0")).correct).toBe(true);
    await endNow(sa, A.comp.id);
    await tickFor(sa, A.comp.id);
    await expect.poll(() => certMails(pa.email).length, { timeout: 15000 }).toBe(1);
    const aToken = badgeOf(A.comp.id, pa.id)[0].token;
    const aBefore = ledgerRow(aToken);
    expect(aBefore, "PRECONDITION: a row records the sent mail").toMatchObject({ status: "sent", attempts: 1 });
    // B: its email switched off, so nothing was issued or mailed; the holder
    // collected their own certificate, which has no ledger row.
    const B = await makeEvent(sa);
    const pb = await participant("lrb");
    await assign(sa, B.comp.id, [pb]);
    expect((await play(pb, B.comp.id, B.taskIds[0], "right0")).correct).toBe(true);
    const off = await sa.put(`/api/admin/competitions/${B.comp.id}/certificate-config`, { config: { email: { enabled: false } } }, await sa.h());
    expect(off.ok, off.text).toBeTruthy();
    await endNow(sa, B.comp.id);
    await tickFor(sa, B.comp.id);
    const own = await pb.c.post(`/api/competitions/${B.comp.id}/badge`, {}, await pb.c.h());
    expect(own.status, own.text).toBe(200);
    const bToken = own.body.token;
    expect(ledgerRow(bToken), "PRECONDITION: no ledger row for the collected certificate").toBeUndefined();
    const before = { aLinks: shareLinks(aToken), bLinks: shareLinks(bToken), aEvents: emailedEvents(pa.id).length, bEvents: emailedEvents(pb.id).length };
    const sid = sa.sessionId();
    expect(sid, "PRECONDITION: the admin's session id").toBeTruthy();
    const h = await sa.h();

    // Both Resends are sent from a live session and held after their render; the
    // session is ended while they are held.
    const cases = [[A.comp, pa, 1, "a row that was there"], [B.comp, pb, 0, "a row the claim made"]];
    let results, failed = null;
    await sendPark.arm(5000);
    try {
      const pending = cases.map(([comp, p]) => sa.post(`/api/admin/competitions/${comp.id}/certificates/resend`, { userId: p.id }, h));
      await sendPark.entered(2);
      expect(ledgerRow(aToken), "PRECONDITION: A's Resend has claimed the row that was there").toMatchObject({ status: "sending", attempts: 2 });
      expect(ledgerRow(bToken), "PRECONDITION: B's Resend has claimed a row of its own").toMatchObject({ status: "sending", attempts: 1 });
      sql(db => db.prepare("INSERT INTO revoked_sessions (id, revoked_at, expires_at) VALUES (?,?,?)")
        .run(sid, new Date().toISOString(), new Date(Date.now() + 3600e3).toISOString()));
      expect(await sendPark.release(), "PRECONDITION: both were still held after their render when the session ended").toBe(2);
      results = await Promise.all(pending);
    } catch (e) { failed = e; throw e; } finally {
      // Disarmed for the rest of the file; asserted unless the test already failed.
      const d = await client().post("/api/test/certificate-send-delay", { delayMs: 0 }).catch(() => null);
      if (!failed && !(d && d.ok)) throw new Error("the send park could not be disarmed: every later send in this file would wait in it");
    }
    cases.forEach(([, p, mailedBefore, what], i) => {
      const r = results[i];
      expect(r.status, `${what}: ${r.text}`).toBe(401);
      expect(r.body.code, `${what}: refused at the re-check after the render`).toBe("admin_session_ended");
      expect(certMails(p.email).length, `${what}: nothing was mailed`).toBe(mailedBefore);
    });
    expect(ledgerRow(aToken), "the row is back exactly as it was").toEqual(aBefore);
    expect(ledgerRow(bToken), "the row the claim created is gone").toBeUndefined();
    expect({ aLinks: shareLinks(aToken), bLinks: shareLinks(bToken), aEvents: emailedEvents(pa.id).length, bEvents: emailedEvents(pb.id).length },
      "no share link minted, no attempt recorded").toEqual(before);

    // CONTROL: the same Resends from a live session send, and the ledger moves.
    sa = await admin();
    for (const [comp, p] of [[A.comp, pa], [B.comp, pb]]) {
      const r = await resend(sa, comp.id, p.id);
      expect(r.status, r.text).toBe(200);
      expect(r.body).toMatchObject({ ok: true, status: "sent" });
    }
    await expect.poll(() => certMails(pa.email).length, { timeout: 15000 }).toBe(2);
    await expect.poll(() => certMails(pb.email).length, { timeout: 15000 }).toBe(1);
    expect(ledgerRow(aToken)).toMatchObject({ status: "sent", attempts: 2 });
    expect(ledgerRow(bToken)).toMatchObject({ status: "sent", attempts: 1 });
  });
});

test.describe("a shutdown waits for a certificate send in flight (sweep #352)", () => {
  test("the server stopped while a pass is inside a send waits for it: exit 0, the mail delivered once, its row sent (never unknown) at the next start; the stopped pass keeps its job, which the next start closes mailing nobody twice", async () => {
    // The drain (`gracefulShutdown`, reached by `POST /api/test/shutdown`) must
    // not close the database while a pass is between its ledger claim and its
    // send: closed there, the row is left `sending`, the next start marks it
    // `unknown` and nothing ever mails the certificate. The pass is held inside
    // its send, after the PDF render, by the send park for DELAY (under the
    // drain's 5 s budget), and the server is told to stop while it is held.
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa);
    const p = await participant("sd");
    await assign(sa, comp.id, [p]);
    expect((await play(p, comp.id, taskIds[0], "right0")).correct).toBe(true);
    await endNow(sa, comp.id);
    const jobs = () => sql(db => db.prepare("SELECT COUNT(*) n FROM certificate_dispatch_jobs WHERE competition_id=?").get(comp.id).n);
    expect(jobs(), "PRECONDITION: the end queued the event's job").toBe(1);
    const since = smtp.messages.length;
    const exit = childExit;
    const DELAY = 2000;
    let token, stopAsked = false;
    await sendPark.arm(DELAY);
    try {
      // The pass's own request is dropped once it is held, so nothing waits on the
      // pass but the pass: an open request holds the HTTP server's close, and so
      // the drain, whatever the gauge says.
      const h = await sa.h();
      const ac = new AbortController();
      const pass = sa.call("POST", "/api/test/certificate-dispatch-tick", { force: true, competitionId: comp.id }, h, ac.signal).catch(() => null);
      const held = await sendPark.entered(1);
      token = badgeOf(comp.id, p.id)[0].token;   // issued before its send
      expect(ledgerRow(token), "PRECONDITION: the send has claimed the ledger").toMatchObject({ status: "sending", attempts: 1 });
      expect(certMails(p.email, since), "PRECONDITION: nothing has reached the relay yet").toHaveLength(0);
      ac.abort();
      await pass;
      stopAsked = true;
      const r = await sa.post("/api/test/shutdown", { confirm: "shutdown" }, await sa.h());
      expect(r.ok, `shutdown: ${r.status} ${r.text}`).toBe(true);
      expect(Date.now() - held.enteredAt, "PRECONDITION: the server was told to stop while the send was still held (raise DELAY)").toBeLessThan(DELAY);
    } finally {
      // Failing before the stop leaves this server running with the park armed:
      // disarm it, or every later send in the file waits in it.
      if (!stopAsked) await client().post("/api/test/certificate-send-delay", { delayMs: 0 }).catch(() => null);
    }
    const out = await settled(exit, 25000, "the server never exited");
    await portFree();
    expect(out, `the drain finished and exited cleanly. Log:\n${childOut.slice(-1500)}`).toEqual({ code: 0, signal: null });
    expect(childOut, "the drain says it waited for the certificate pass").toMatch(/Shutdown complete \([^)]*certificates drained/);
    expect(certMails(p.email, since), "the send in flight was finished and delivered, once").toHaveLength(1);
    expect(jobs(), "the pass stopped after that send and kept its job for the next start").toBe(1);

    // The next start.
    await boot();
    expect(ledgerRow(token), "the send was finished, never cut: its row is sent, not unknown").toMatchObject({ status: "sent", attempts: 1, last_error: null });
    const sa2 = await admin();
    const again = await tickFor(sa2, comp.id);
    expect(again, `the next start's pass: ${JSON.stringify(again)}`).toMatchObject({ jobs: 1, issued: 0, sent: 0 });
    expect(jobs(), "and it closes the job").toBe(0);
    expect(certMails(p.email, since), "nobody is mailed twice").toHaveLength(1);
    expect(ledgerRow(token)).toMatchObject({ status: "sent", attempts: 1 });
  });
});
