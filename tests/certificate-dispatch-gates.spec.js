"use strict";

// WHO THE AUTOMATIC CERTIFICATE PASS LEAVES OUT, WHEN IT ISSUES NOTHING, AND HOW
// MUCH ONE PASS SENDS (sweep #44).
//
// lib/certificate-dispatch.js issues and mails every eligible participant's
// certificate when an event ends. Three of its gates, each beside the control
// that makes it mean something:
//   * a REVOKED certificate is never replaced by the automatic pass (routes/badge.js
//     `_autoIssueCertificate`: lifting a revocation is a superadmin's Issue again):
//     after a revive and a re-end, the pass issues and mails a newcomer and leaves
//     the revoked holder with their revoked certificate, mailing them nothing more;
//   * without the grandfather floor (`settings.certificate_dispatch_floor_at`,
//     which keeps an upgrade from mailing events that ended before it) the
//     dispatcher fails CLOSED (`no_floor`): nothing is issued or mailed, and the
//     event's certificate list and top-three download say why; with it back, an
//     end is issued and mailed;
//   * one pass starts at most its cap of sends for an event (plus those already
//     past the check in its other CONCURRENCY lanes), leaves the job due, and the
//     next pass — unforced, at the real MAX_SENDS_PER_PASS — sends the rest,
//     nobody twice. The capped pass runs at a cap the test hook lowers
//     (`{maxSends}`): at the real 100 it rendered 105 PDFs and outran CI's 60 s.
//
// Spawns its own server against a real capturing relay (tests/smtp-capture.js);
// the worker never runs by itself under NODE_ENV=test, so each pass is
// `POST /api/test/certificate-dispatch-tick`, narrowed to the test's own event.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { PORT_BASE } = require("./helpers");
const { startSmtpCapture } = require("./smtp-capture");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = PORT_BASE + 102;
const BASE = `http://127.0.0.1:${PORT}`;

let smtp, child, childExit = null, dataDir, uploadsDir, superPass, childOut = "";

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
    async h() { return { "x-csrf-token": (await call("GET", "/api/csrf-token")).body.csrfToken }; },
  };
}

function sql(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(path.join(dataDir, "hackathon.db"));
  try { return fn(db); } finally { db.close(); }
}

async function boot() {
  childOut = "";
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test",
      PORT: String(PORT), DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, BASE_URL: BASE,
      SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), SMTP_ALLOW_PLAINTEXT: "1",
      SUPERADMIN_PASSWORD_QUIET: "1", RATE_LIMIT_DISABLED: "1",
      NODE_OPTIONS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", d => { childOut += d; });
  child.stderr.on("data", d => { childOut += d; });
  // Watch the child's close from the start: a server that dies stops the wait
  // below at once, and kill() awaits this promise (a fresh once("exit") on a
  // child already gone would never settle and hang afterAll to its timeout).
  let exited = null;
  childExit = new Promise(resolve => child.once("close", (code, signal) => { exited = { code, signal }; resolve(exited); }));
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
  if (exited) throw new Error(`server exited (${exited.signal || `code ${exited.code}`}) before it was ready. Log:\n${childOut.slice(-2000)}`);
  throw new Error(`server never became ready. Log:\n${childOut.slice(-2000)}`);
}

async function kill() {
  if (!child) return;
  const c = child, done = childExit; child = null;
  try { c.kill("SIGKILL"); } catch (_) { /* already gone */ }
  await done;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/healthz`); } catch (_) { return; }
    await new Promise(r => setTimeout(r, 100));
  }
}

test.beforeAll(async () => {
  smtp = await startSmtpCapture();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "certgates-"));
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "certgates-up-"));
  await boot();
});

test.afterAll(async () => {
  await kill();
  try { smtp && await smtp.close(); } catch (_) {}
  for (const d of [dataDir, uploadsDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

test.beforeEach(() => guardFixedPortSpec());

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
    firstName: "Gate", lastName: `Holder${tag}`, nickname: `${tag}${s}`.replace(/[^a-z0-9_]/gi, "").slice(0, 20),
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
    name: `CertGates ${stamp()}`, event_kind: "tournament",
    start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 600, timezone: "UTC",
  }, await sa.h());
  expect(cr.ok, `create: ${cr.text}`).toBeTruthy();
  const comp = cr.body.competition;
  const taskIds = [];
  for (let i = 0; i < tasks; i++) {
    const tr = await sa.post("/api/admin/tasks", {
      title: `CG task ${stamp()}`, description: "<p>d</p>", difficulty: "easy",
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
  const t = await p.c.get(`/api/tasks/${taskId}`, { "x-competition-id": compId });
  expect(t.ok, t.text).toBeTruthy();
  const r = await p.c.post(`/api/tasks/${taskId}/submit`, { answer, gradingHash: t.body.grading_hash }, { ...(await p.c.h()), "x-competition-id": compId });
  expect(r.ok, `submit: ${r.text}`).toBeTruthy();
  return r.body;
}

/** End the event, then settle the status scheduler's first sight of the end (it re-queues the job). */
async function endNow(sa, compId) {
  const r = await sa.post(`/api/admin/competitions/${compId}/end-now`, {}, await sa.h());
  expect(r.ok, `end-now: ${r.text}`).toBeTruthy();
  const s = await sa.post("/api/test/scheduler-tick", {}, await sa.h());
  expect(s.ok, `scheduler tick: ${s.text}`).toBeTruthy();
}

/** One dispatcher pass over THIS event's jobs and retries only (`maxSends` lowers its cap). */
async function tickFor(sa, competitionId, force = true, maxSends) {
  const r = await sa.post("/api/test/certificate-dispatch-tick", { force, competitionId, ...(maxSends === undefined ? {} : { maxSends }) }, await sa.h());
  expect(r.ok, `tick: ${r.text}`).toBeTruthy();
  return r.body;
}

function certMails(email) {
  return smtp.messages.filter(m => (m.rcptTo || []).some(a => a.toLowerCase() === email.toLowerCase())
    && /certificate/i.test(m.header("subject") || "") && !/sign-in code/i.test(m.header("subject") || ""));
}

const badgesOf = (compId, userId) => sql(db => db.prepare("SELECT * FROM achievement_badges WHERE competition_id=? AND user_id=? ORDER BY created_at").all(compId, userId));
const jobs = (compId) => sql(db => db.prepare("SELECT * FROM certificate_dispatch_jobs WHERE competition_id=?").all(compId));
const ledger = (compId) => sql(db => db.prepare("SELECT * FROM certificate_emails WHERE competition_id=?").all(compId));
const autoMints = (compId, userId) => sql(db => db.prepare(
  "SELECT COUNT(*) n FROM competition_events WHERE competition_id=? AND event_type='badge_minted' AND json_extract(details,'$.user_id')=?").get(compId, userId).n);

test.describe("the automatic certificate pass: a revoked certificate, a missing floor, and its per-pass cap", () => {
  test("a revoked certificate is never replaced by the automatic pass: after a revive and a re-end, a newcomer is issued and mailed, the revoked holder is not", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa);
    const rev = await participant("rv"), kept = await participant("rk");
    await assign(sa, comp.id, [rev, kept]);
    for (const p of [rev, kept]) expect((await play(p, comp.id, taskIds[0], "right0")).correct).toBe(true);
    await endNow(sa, comp.id);
    const first = await tickFor(sa, comp.id);
    expect(first, JSON.stringify(first)).toMatchObject({ issued: 2, sent: 2 });
    for (const p of [rev, kept]) await expect.poll(() => certMails(p.email).length, { timeout: 15000 }).toBe(1);
    const revoked = badgesOf(comp.id, rev.id)[0];
    const r = await sa.post(`/api/admin/badges/${encodeURIComponent(revoked.token)}/revoke`, { reason: "test: misconduct" }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    const revokedLedger = ledger(comp.id).find(l => l.badge_token === revoked.token);

    // REVIVE, a newcomer earns a certificate, RE-END: the event's job is queued again.
    const put = await sa.put(`/api/admin/competitions/${comp.id}`, { duration_minutes: 900 }, await sa.h());
    expect(put.ok, `revive: ${put.text}`).toBeTruthy();
    expect(put.body.competition.status, "revived").toBe("live");
    const late = await participant("rn");
    await assign(sa, comp.id, [late]);
    expect((await play(late, comp.id, taskIds[0], "nope")).correct).toBe(false);
    await endNow(sa, comp.id);
    expect(jobs(comp.id).map(j => j.reason), "PRECONDITION: the re-end queued the event").toEqual(["ended"]);
    const second = await tickFor(sa, comp.id);
    // The newcomer is issued and mailed; the revoked holder and the holder already
    // mailed are both passed over.
    expect(second, JSON.stringify(second)).toMatchObject({ issued: 1, sent: 1, skipped: 2 });
    await expect.poll(() => certMails(late.email).length, { timeout: 15000, message: "CONTROL: the newcomer is mailed" }).toBe(1);
    expect(badgesOf(comp.id, late.id).filter(b => !b.revoked_at), "CONTROL: the newcomer holds a live certificate").toHaveLength(1);

    const rows = badgesOf(comp.id, rev.id);
    expect(rows.map(b => b.token), "the revoked holder still has only the revoked certificate").toEqual([revoked.token]);
    expect(rows[0].revoked_at, "…still revoked").toBeTruthy();
    expect(certMails(rev.email), "and is not mailed again").toHaveLength(1);
    expect(autoMints(comp.id, rev.id), "nothing was minted on their behalf after the revoke").toBe(1);
    expect(ledger(comp.id).find(l => l.badge_token === revoked.token), "the revoked certificate's ledger is as it was").toEqual(revokedLedger);
    expect(certMails(kept.email), "the other holder is not mailed twice").toHaveLength(1);
  });

  test("without the grandfather floor nothing is issued or mailed, and the event's certificate pages say why; with it back, an end is mailed", async () => {
    const sa = await admin();
    const KEY = "certificate_dispatch_floor_at";
    // Put back as found: the floor has no hard-coded default, it is this server's
    // own first-boot instant (a fresh database, spawned by this file).
    const floor = sql(db => db.prepare("SELECT value FROM settings WHERE key=?").get(KEY));
    expect(floor && floor.value, "PRECONDITION: this installation has the floor").toBeTruthy();
    const E = await makeEvent(sa);
    const p = await participant("nf");
    await assign(sa, E.comp.id, [p]);
    expect((await play(p, E.comp.id, E.taskIds[0], "right0")).correct, "a first place with points: a podium to miss").toBe(true);
    sql(db => db.prepare("DELETE FROM settings WHERE key=?").run(KEY));
    try {
      await endNow(sa, E.comp.id);
      expect(jobs(E.comp.id), "PRECONDITION: the end queued the event").toHaveLength(1);
      const list = await sa.get(`/api/admin/competitions/${E.comp.id}/certificates`);
      expect(list.ok, list.text).toBeTruthy();
      expect(list.body.automaticRefusal, "the organisers are told why nothing will be issued").toBe("no_floor");
      const top3 = await sa.get(`/api/admin/competitions/${E.comp.id}/certificates/top3.zip`);
      expect(top3.status, top3.text.slice(0, 300)).toBe(409);
      expect(top3.body).toMatchObject({ code: "certificates_not_issued_automatically", reason: "no_floor" });
      const out = await tickFor(sa, E.comp.id);
      expect(out, `fails closed: ${JSON.stringify(out)}`).toMatchObject({ jobs: 1, dropped: 1, issued: 0, sent: 0 });
      expect(jobs(E.comp.id), "the job is closed").toEqual([]);
      expect(badgesOf(E.comp.id, p.id), "nothing issued").toEqual([]);
      expect(ledger(E.comp.id), "nothing sent").toEqual([]);
    } finally {
      sql(db => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(KEY, floor.value));
    }
    expect(sql(db => db.prepare("SELECT value FROM settings WHERE key=?").get(KEY)), "the floor is back as it was").toEqual(floor);
    expect(certMails(p.email), "nobody was mailed").toHaveLength(0);

    // CONTROL: with the floor, the same path issues and mails.
    const F = await makeEvent(sa);
    const q = await participant("nfc");
    await assign(sa, F.comp.id, [q]);
    expect((await play(q, F.comp.id, F.taskIds[0], "right0")).correct).toBe(true);
    await endNow(sa, F.comp.id);
    const okList = await sa.get(`/api/admin/competitions/${F.comp.id}/certificates`);
    expect(okList.body.automaticRefusal, "nothing in the way").toBeNull();
    const ok = await tickFor(sa, F.comp.id);
    expect(ok, JSON.stringify(ok)).toMatchObject({ issued: 1, sent: 1 });
    await expect.poll(() => certMails(q.email).length, { timeout: 15000 }).toBe(1);
  });

  test("one pass starts at most its cap of sends for an event and leaves the job due; the next pass, unforced, sends the rest, nobody twice", async () => {
    // The pass's parallel lanes and real cap, from the module itself: a task checks
    // the cap before its issue and counts itself after it, so up to CONCURRENCY - 1
    // lanes already past the check can each start one more. The capped pass runs
    // at a lowered cap above the lanes, so the check (not the first wave) stops it.
    const src = fs.readFileSync(path.resolve(__dirname, "..", "lib", "certificate-dispatch.js"), "utf8");
    const REAL_CAP = Number((/\bconst MAX_SENDS_PER_PASS = (\d+);/.exec(src) || [])[1]);
    const LANES = Number((/\bconst CONCURRENCY = (\d+);/.exec(src) || [])[1]);
    const CAP = LANES + 2;
    const N = CAP + LANES + 1;   // more than one capped pass can start
    expect(LANES > 0 && REAL_CAP >= N, `PRECONDITION: read the lanes (${LANES}) and a real cap (${REAL_CAP}) the unforced pass cannot reach`).toBe(true);
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { tasks: 1 });
    // N members SEEDED BY SQL, each with one wrong answer, as
    // perf/certificate-dispatch-scale.cjs does (N sign-ups through the API would
    // measure registration): every one of them earns a participation certificate.
    const start = Date.parse(comp.start_time);
    const s = stamp();
    const people = [];
    sql(db => db.transaction(() => {
      const iu = db.prepare(`INSERT INTO users (id, first_name, last_name, nickname, email, company, title, country, timezone,
        job_function, city, verified, approved, role, created_at) VALUES (?,?,?,?,?,'Acme','Eng','US','UTC','Engineer','NYC',1,1,'participant',?)`);
      const im = db.prepare("INSERT INTO competition_users (competition_id, user_id, login_time, assigned_at, direct_assigned) VALUES (?,?,?,?,1)");
      const is = db.prepare(`INSERT INTO submissions (id, user_id, task_id, competition_id, answer, is_correct, points_delta, submitted_at, updated_at)
        VALUES (?,?,?,?,'no',0,-5,?,?)`);
      for (let i = 0; i < N; i++) {
        const id = crypto.randomUUID();
        const email = `cap${i}-${s}@company.co`;
        iu.run(id, "Cap", `Holder${i}`, `cap${s}x${i}`, email, new Date().toISOString());
        const at = new Date(start + 60_000 + i * 50).toISOString();
        im.run(comp.id, id, at, at);
        is.run(crypto.randomUUID(), id, taskIds[0], comp.id, at, at);
        people.push({ id, email });
      }
    })());
    await endNow(sa, comp.id);

    const first = await tickFor(sa, comp.id, true, CAP);
    expect(first.sent, `the first pass stops at the cap: ${JSON.stringify(first)}`).toBeGreaterThanOrEqual(CAP);
    expect(first.sent, "…and starts no more than the lanes already past the check").toBeLessThanOrEqual(CAP + LANES - 1);
    expect(first.issued, "it issued exactly the certificates it sent").toBe(first.sent);
    const kept = jobs(comp.id);
    expect(kept, "the job is kept for the rest").toHaveLength(1);
    expect(kept[0].passes, "one capped pass counted").toBe(1);
    expect(Date.parse(kept[0].due_at), "and left due now, not after the settle delay").toBeLessThanOrEqual(Date.now());
    expect(ledger(comp.id), "one ledger row per mail started").toHaveLength(first.sent);

    // UNFORCED, at the real cap: the job is due, so an ordinary pass takes it.
    const second = await tickFor(sa, comp.id, false);
    expect(second, `the next pass sends the rest: ${JSON.stringify(second)}`).toMatchObject({ jobs: 1, sent: N - first.sent, issued: N - first.sent });
    expect(jobs(comp.id), "and the job is done").toEqual([]);
    const rows = ledger(comp.id);
    expect(rows.map(r => r.status).filter(st => st !== "sent"), "every mail went out").toEqual([]);
    expect(new Set(rows.map(r => r.user_id)).size, "one certificate email per holder").toBe(N);
    await expect.poll(() => people.filter(p => certMails(p.email).length === 1).length, { timeout: 30000, message: "each holder mailed exactly once" }).toBe(N);
    expect(people.filter(p => certMails(p.email).length !== 1), "nobody mailed twice").toEqual([]);
  });
});
