"use strict";

// MAIL WAITS WHILE THE DATABASE FAILED ITS BOOT INTEGRITY OR SCHEMA CHECK
// (operator rulings, 24 and 25 Nov 2026; sweeps #336 and #511).
//
// Both boot checks are loud but not fatal: the process stays up so an operator
// can sign in and triage, and /readyz refuses traffic. The certificate
// dispatcher and the event-team report worker used to ask only whether
// maintenance mode was on, so a corrupt or half-migrated database kept minting
// certificates and mailing them, and mailing team reports, while the load
// balancer was told the instance was not ready. Both now hold on the one
// instance-health gate the Checkmarx One runners read (server.js
// `_instanceInService`: integrity, schema and maintenance). A held pass answers
// `held: true` and starts nothing; every job stays queued, and goes out once the
// database is fixed and the server restarted (the checks run only at boot). The
// start-reminder dispatcher asks the same gate (25 Nov 2026), so the reminder a
// participant set for an upcoming event waits with them.
//
// One data directory, three boots of a spawned server, read off a capturing
// relay (tests/smtp-capture.js):
//   1. a migration did NOT apply (a table squats on a required index's name, the
//      shape tests/schema-readiness.spec.js reproduces): /readyz `db_schema`;
//      the event's end has queued a certificate job and a team wrap-up, and both
//      passes hold: no certificate minted, no ledger row, nothing mailed. An
//      admin's Send now is not a pass and still sends (the hold delays the
//      automatic mail only, as under maintenance);
//   2. the schema repaired, the database CORRUPT instead (an index whose stored
//      definition no longer matches its rows; PRAGMA integrity_check reports
//      the rows missing from it): /readyz `db_integrity`; both passes hold, the
//      same jobs still queued;
//   3. repaired and restarted: /readyz ready, and the same passes issue and mail
//      the certificate and send the wrap-up, which is the CONTROL that the held
//      jobs were deliverable all along (a hold stuck on would fail here).
// The maintenance arm of the same gate: tests/mail-hold-maintenance.api.spec.js.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { PORT_BASE } = require("./helpers");
const { startSmtpCapture } = require("./smtp-capture");
const { verifySchema } = require("../lib/schema-required");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = PORT_BASE + 186;
const BASE = `http://127.0.0.1:${PORT}`;

let smtp, child = null, childExit = null, dataDir, uploadsDir, superPass, childOut = "";

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
    let body = t; try { body = JSON.parse(t); } catch (_) { body = t; }
    return { status: r.status, ok: r.status >= 200 && r.status < 300, body, text: t };
  };
  return {
    get: (p, h) => call("GET", p, undefined, h),
    post: (p, d, h) => call("POST", p, d, h),
    put: (p, d, h) => call("PUT", p, d, h),
    async h() { return { "x-csrf-token": (await call("GET", "/api/csrf-token")).body.csrfToken }; },
  };
}

const dbPath = () => path.join(dataDir, "hackathon.db");
function sql(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath());
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
  // `close`, not `exit`: it comes after the child's output has been read to the end.
  let exited = null;
  childExit = new Promise(resolve => c.once("close", (code, signal) => {
    exited = { code, signal };
    if (child === c) child = null;
    resolve(exited);
  }));
  // Ready means THIS process answers: its own start time, then its own password
  // file. /readyz is what is under test and never turns green on a broken boot.
  const spawnedAt = Date.now();
  const deadline = spawnedAt + 40000;
  let lastErr = null;
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
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`${exited ? `server exited (${exited.signal || `code ${exited.code}`}) before it was ready` : `server never became ready (${lastErr && lastErr.message})`}. Log:\n${childOut.slice(-2000)}`);
}

/** The port must be free before a respawn binds it. */
async function portFree() {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/healthz`); } catch (_) { return; }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`port ${PORT} was never freed`);
}

/** SIGKILL, then wait for the process and its port: the database is changed only with no server on it. */
async function kill() {
  if (!child) return;
  const c = child, done = childExit;
  try { c.kill("SIGKILL"); } catch (_) { /* already gone */ }
  await done;
  await portFree();
}

test.beforeAll(async () => {
  smtp = await startSmtpCapture();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailhold-health-"));
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mailhold-health-up-"));
});
test.afterAll(async () => {
  await kill();
  if (smtp) { smtp.release(); await smtp.close().catch(e => console.warn("smtp close:", e.message)); }
  for (const d of [dataDir, uploadsDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});
test.beforeEach(() => guardFixedPortSpec());

// ── The two ways a boot check fails, each undone by the operator's fix ───────

// THE SCHEMA. db.js heals a missing column or index at every start, so dropping
// one proves nothing; what it cannot heal is a NAME COLLISION. With a table
// called `uq_users_linkedin_sub` present, its `CREATE UNIQUE INDEX IF NOT EXISTS`
// fails ("there is already a table named …"), the migration's catch swallows it,
// and the required index is missing: tests/schema-readiness.spec.js measures
// exactly this. Dropping the table lets the next start create the index.
const SCHEMA_DECOY = "uq_users_linkedin_sub";
const breakSchema = () => sql(db => db.exec(`CREATE TABLE ${SCHEMA_DECOY} (decoy TEXT)`));
const repairSchema = () => sql(db => db.exec(`DROP TABLE ${SCHEMA_DECOY}`));

// THE INTEGRITY. An index whose stored definition is rewritten to another column
// no longer matches the rows it holds, which PRAGMA integrity_check reports as
// "row N missing from index …" (quick_check does not look). better-sqlite3
// ignores `writable_schema` unless unsafe mode is on. Nothing in the app reads or
// writes this table, so only the check sees the damage; dropping the table (and
// its index) is the repair.
function breakIntegrity() {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath());
  try {
    db.exec("CREATE TABLE health_decoy (a INTEGER, b INTEGER); CREATE INDEX health_decoy_a ON health_decoy(a);"
      + " INSERT INTO health_decoy (a, b) VALUES (1, 101), (2, 102), (3, 103);");
    db.unsafeMode(true);
    db.pragma("writable_schema = ON");
    const n = db.prepare("UPDATE sqlite_master SET sql='CREATE INDEX health_decoy_a ON health_decoy(b)' WHERE type='index' AND name='health_decoy_a'").run().changes;
    db.pragma("writable_schema = OFF");
    db.unsafeMode(false);
    expect(n, "PRECONDITION: the index's definition was rewritten").toBe(1);
  } finally { db.close(); }
  const first = sql(db => db.pragma("integrity_check")[0].integrity_check);
  expect(first, "PRECONDITION: integrity_check now fails, as the boot check will see it").toMatch(/missing from index health_decoy_a/);
}
const repairIntegrity = () => sql(db => {
  db.exec("DROP TABLE health_decoy");
  expect(db.pragma("integrity_check")[0].integrity_check, "PRECONDITION: the repair leaves an intact database").toBe("ok");
});

/** /readyz says the state the test built: `reason` null means ready. */
async function expectReadiness(reason) {
  const r = await fetch(`${BASE}/readyz`);
  const body = await r.json();
  if (reason === null) expect({ status: r.status, body }, "the instance is ready").toEqual({ status: 200, body: { ready: true } });
  else expect({ status: r.status, ready: body.ready, reason: body.reason }, `PRECONDITION: /readyz names ${reason}`)
    .toEqual({ status: 503, ready: false, reason });
}

// ── The fixture: an ended event with a participant who took part and a team ──

async function admin() {
  const c = client();
  const r = await c.post("/api/login", { email: "superadmin", password: superPass }, await c.h());
  expect(r.ok, `superadmin login: ${r.status} ${r.text}`).toBeTruthy();
  return c;
}

let seq = 0;
const stamp = () => `${Date.now().toString(36)}${++seq}`;

/**
 * The allowed-domain list (a global setting) back to its hard-coded default,
 * empty, on the server that is up. Soft: a failure here is reported beside the
 * test's own error, never instead of it. With no server up (a failure between two
 * boots) the setting lives only in this spawned server's own database, which
 * afterAll deletes.
 */
async function restoreDomains() {
  if (!child) return;
  let r;
  try {
    const sa = await admin();
    r = await sa.put("/api/admin/team-report-domains", { domains: [] }, await sa.h());
  } catch (e) { r = { ok: false, text: e.message }; }
  expect.soft(r.ok ? r.body.domains : r.text, `the allowed domains back to their default: ${r.text}`).toEqual([]);
}

/** A verified, approved participant, signed up and signed in through the emailed-code doors. */
async function participant() {
  const c = client();
  const s = stamp();
  const email = `hold-${s}@company.co`;
  await c.post("/api/test/reset-recent-code-sends", undefined, await c.h());
  const rq = await c.post("/api/auth/code/request", { email }, await c.h());
  expect(rq.ok, `code request: ${rq.text}`).toBeTruthy();
  const proof = await c.get("/api/test/last-login-code?email=" + encodeURIComponent(email));
  const rd = await c.post("/api/auth/code/redeem", { email, code: proof.body && proof.body.code }, await c.h());
  expect(rd.body && rd.body.ok, `proof: ${rd.text}`).toBe(true);
  const r = await c.post("/api/register", {
    firstName: "Hold", lastName: `Health${s}`.replace(/[^a-z0-9]/gi, ""), company: "Acme", title: "Engineer",
    country: "US", timezone: "America/New_York", jobFunction: "", city: "",
  }, await c.h());
  expect(r.ok, `register: ${r.status} ${r.text}`).toBeTruthy();
  const id = sql(db => db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email).id);
  expect(sql(db => db.prepare("SELECT verified, approved, blocked FROM users WHERE id=?").get(id)), "PRECONDITION: the participant may be issued and mailed")
    .toEqual({ verified: 1, approved: 1, blocked: 0 });
  return { c, email, id };
}

/**
 * A live tournament with two challenges, a Solutions Engineer on its team, and
 * one participant who answered the first wrongly (so nothing ends it early), then
 * End Now and one status-scheduler pass, which settles the end's jobs: the
 * scheduler's first sighting of an end queues them again (a new due time), and
 * settled here it never touches them afterwards, a restart included.
 */
async function endedEventWithTeam(sa) {
  const cr = await sa.post("/api/admin/competitions", {
    name: `Mail hold ${stamp()}`, event_kind: "tournament", timezone: "UTC",
    start_time: new Date(Date.now() - 10 * 60_000).toISOString(), duration_minutes: 600,
  }, await sa.h());
  expect(cr.ok, `create: ${cr.text}`).toBeTruthy();
  const comp = cr.body.competition;
  const taskIds = [];
  for (let i = 0; i < 2; i++) {
    const tr = await sa.post("/api/admin/tasks", {
      title: `Mail hold task ${stamp()}${i}`, description: "<p>d</p>", difficulty: "easy",
      answer_type: "text", correct_answer: `right${i}`, status: "published",
    }, await sa.h());
    expect(tr.ok, tr.text).toBeTruthy();
    const a = await sa.post(`/api/admin/tasks/${tr.body.id}/competitions`, { competitionIds: [comp.id] }, await sa.h());
    expect(a.ok, a.text).toBeTruthy();
    taskIds.push(tr.body.id);
  }
  const memberEmail = `sam-${stamp()}@corp.example`;
  const mr = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "se", name: "Sam", email: memberEmail }, await sa.h());
  expect(mr.ok, `add the team member: ${mr.text}`).toBeTruthy();

  const p = await participant();
  const as = await sa.post("/api/admin/competitions/assign", { userIds: [p.id], competitionIds: [comp.id] }, await sa.h());
  expect(as.ok && as.body.assigned, `assign: ${as.text}`).toBe(1);
  const sel = await p.c.post("/api/select-competition", { competitionId: comp.id }, await p.c.h());
  expect(sel.ok, sel.text).toBeTruthy();
  const t = await p.c.get(`/api/tasks/${taskIds[0]}`, { "x-competition-id": comp.id });
  expect(t.ok, t.text).toBeTruthy();
  const sub = await p.c.post(`/api/tasks/${taskIds[0]}/submit`, { answer: "nope", gradingHash: t.body.grading_hash }, { ...(await p.c.h()), "x-competition-id": comp.id });
  expect(sub.ok && sub.body.correct, `a wrong answer, so the participant took part: ${sub.text}`).toBe(false);

  const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h());
  expect(end.ok, `end-now: ${end.text}`).toBeTruthy();
  const tick = await sa.post("/api/test/scheduler-tick", {}, await sa.h());
  expect(tick.ok, `scheduler tick: ${tick.text}`).toBeTruthy();
  return { comp, p, memberEmail };
}

// ── What the passes did, read by value ──────────────────────────────────────

/** The three passes once: both mail workers, forced (every job due), the certificate one narrowed to this event, and the start reminders. */
async function passes(compId) {
  const c = await client().post("/api/test/certificate-dispatch-tick", { force: true, competitionId: compId });
  const t = await client().post("/api/test/team-report-tick", { force: true });
  const r = await client().post("/api/test/reminder-tick", {});
  expect(c.ok && t.ok && r.ok, `ticks answered ${c.status} ${c.text} / ${t.status} ${t.text} / ${r.status} ${r.text}`).toBeTruthy();
  return { cert: c.body, team: t.body, rem: r.body };
}

/**
 * An upcoming tournament 50 minutes off, the participant enrolled, and their own
 * start reminder set through the real door: its hour has begun, so it is due at
 * the next dispatch.
 */
async function upcomingWithReminder(sa, p) {
  const cr = await sa.post("/api/admin/competitions", {
    name: `Reminder hold ${stamp()}`, event_kind: "tournament", timezone: "UTC",
    start_time: new Date(Date.now() + 50 * 60_000).toISOString(), duration_minutes: 60,
  }, await sa.h());
  expect(cr.ok, `create the upcoming event: ${cr.text}`).toBeTruthy();
  const comp = cr.body.competition;
  const as = await sa.post("/api/admin/competitions/assign", { userIds: [p.id], competitionIds: [comp.id] }, await sa.h());
  expect(as.ok && as.body.assigned, `assign: ${as.text}`).toBe(1);
  const set = await p.c.post(`/api/competitions/${comp.id}/reminder`, {}, await p.c.h());
  expect(set.ok && set.body.immediate, `the participant's reminder, due at once: ${set.text}`).toBe(true);
  return comp;
}
const reminderRow = (compId, userId) => sql(db => db.prepare(
  "SELECT sent, claimed_at, claim_token FROM email_reminders WHERE competition_id=? AND user_id=?").get(compId, userId));
/** An RFC 2047 header decoded (nodemailer Q-encodes a non-ASCII subject, and the reminder's has an em dash). */
const decodeHeader = (v) => String(v || "").replace(/=\?UTF-8\?([QB])\?([^?]*)\?=\s*/gi, (_, enc, t) => enc.toUpperCase() === "B"
  ? Buffer.from(t, "base64").toString("utf8")
  : Buffer.from(t.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8"));
/** Start reminders to the participant (subject "… starts in …"), subjects decoded. */
const reminderSubjects = (email, since) => smtp.messages.slice(since).filter(to(email))
  .map(m => decodeHeader(subject(m))).filter(t => / starts in /.test(t));

/** Everything a pass would have changed or sent for this event. */
const state = (compId) => sql(db => ({
  certJobs: db.prepare("SELECT user_id FROM certificate_dispatch_jobs WHERE competition_id=?").all(compId),
  wrapupJobs: db.prepare("SELECT COUNT(*) AS n FROM team_report_jobs WHERE competition_id=? AND kind='wrapup'").get(compId).n,
  badges: db.prepare("SELECT COUNT(*) AS n FROM achievement_badges WHERE competition_id=?").get(compId).n,
  certEmails: db.prepare("SELECT COUNT(*) AS n FROM certificate_emails WHERE competition_id=?").get(compId).n,
  wrapupSends: db.prepare("SELECT COUNT(*) AS n FROM team_report_sends WHERE competition_id=? AND kind='wrapup'").get(compId).n,
  wrapupRuns: db.prepare("SELECT COUNT(*) AS n FROM team_report_runs WHERE competition_id=? AND kind='wrapup'").get(compId).n,
}));
// The event's certificate job (`user_id` '' : the whole event) and its wrap-up.
const QUEUED_NOTHING_DONE = { certJobs: [{ user_id: "" }], wrapupJobs: 1, badges: 0, certEmails: 0, wrapupSends: 0, wrapupRuns: 0 };

const to = (addr) => (m) => (m.rcptTo || []).some(a => a.toLowerCase() === addr.toLowerCase());
const subject = (m) => String(m.header("subject") || "");
/** Congratulations emails to the participant (their sign-in code mails excluded). */
const certMails = (email, since) => smtp.messages.slice(since).filter(m => to(email)(m)
  && /certificate/i.test(subject(m)) && !/sign-in code/i.test(subject(m)));
/** Every mail to the team member: nothing but team reports is ever sent there. */
const memberMails = (email, since) => smtp.messages.slice(since).filter(to(email));

async function expectHeld(fx, since, why) {
  const out = await passes(fx.comp.id);
  expect(out.cert.held, `${why}: the certificate pass holds: ${JSON.stringify(out.cert)}`).toBe(true);
  expect(out.team.held, `${why}: the team-report pass holds: ${JSON.stringify(out.team)}`).toBe(true);
  // A held pass starts nothing, so there is nothing still on its way to wait for.
  expect(state(fx.comp.id), `${why}: both jobs still queued; nothing minted, claimed or sent`).toEqual(QUEUED_NOTHING_DONE);
  expect(certMails(fx.p.email, since), `${why}: no congratulations email`).toHaveLength(0);
  expect(out.rem, `${why}: the reminder pass holds`).toEqual({ ok: true, ran: false, held: true, claimed: 0, delivered: 0, skipped: 0, started: 0 });
  expect(reminderRow(fx.upcoming.id, fx.p.id), `${why}: the reminder is untouched`).toEqual({ sent: 0, claimed_at: null, claim_token: null });
  expect(reminderSubjects(fx.p.email, since), `${why}: no start reminder`).toHaveLength(0);
}

test("both mail workers hold while the database failed its boot schema or integrity check, and send what they held once it is fixed and restarted", async () => {
  test.setTimeout(180_000);
  breakSchema();   // before the first start, so its migrations meet the decoy

  // ── 1. A migration did not apply ──────────────────────────────────────────
  await boot();
  await expectReadiness("db_schema");
  const missing = sql(db => verifySchema(db));
  expect({ ok: missing.ok, indexes: missing.missingIndexes, columns: missing.missingColumns },
    "PRECONDITION: the one thing missing is the decoy's index (read as the boot check reads it)")
    .toEqual({ ok: false, indexes: [SCHEMA_DECOY], columns: [] });
  const sa = await admin();
  try {
    const dom = await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h());
    expect(dom.ok && dom.body.domains, `allow the team's domain: ${dom.text}`).toEqual(["corp.example"]);
    const fx = await endedEventWithTeam(sa);
    expect(state(fx.comp.id), "PRECONDITION: the end queued the certificate job and the wrap-up, and nothing ran yet").toEqual(QUEUED_NOTHING_DONE);
    fx.upcoming = await upcomingWithReminder(sa, fx.p);
    expect(reminderRow(fx.upcoming.id, fx.p.id), "PRECONDITION: the reminder is set and due, nothing claimed").toEqual({ sent: 0, claimed_at: null, claim_token: null });
    const since = smtp.messages.length;
    await expectHeld(fx, since, "schema incomplete");
    expect(memberMails(fx.memberEmail, since), "schema incomplete: no report reached the team").toHaveLength(0);

    // CONTROL: an admin's Send now is an explicit act, not a pass, and is not
    // held, as under maintenance. It stamps nothing as reported, so the wrap-up
    // still owes the team its report.
    const sn = await sa.post(`/api/admin/competitions/${fx.comp.id}/team-report/send`, {}, await sa.h());
    expect(sn.status, `Send now: ${sn.text}`).toBe(200);
    expect(sn.body, "Send now reached the one team member").toMatchObject({ ok: true, sent: 1, failed: 0, refused: 0 });
    await expect.poll(() => memberMails(fx.memberEmail, since).length, { timeout: 15000, message: "the Send now report reached the team" }).toBe(1);
    expect(state(fx.comp.id), "…and the automatic jobs are untouched by it").toEqual(QUEUED_NOTHING_DONE);
    await kill();

    // ── 2. The schema repaired, the database corrupt ────────────────────────
    repairSchema();
    breakIntegrity();
    await boot();
    // /readyz reports integrity first, so the schema must be whole again for
    // this boot to hold on integrity ALONE (step 1 is the control that the same
    // read sees a missing index).
    await expectReadiness("db_integrity");
    expect(sql(db => verifySchema(db).ok), "PRECONDITION: the schema is complete again (only integrity holds)").toBe(true);
    await expectHeld(fx, since, "integrity failed");
    expect(memberMails(fx.memberEmail, since), "integrity failed: still only the Send now report").toHaveLength(1);
    await kill();

    // ── 3. Fixed and restarted: what was held goes out ──────────────────────
    repairIntegrity();
    await boot();
    await expectReadiness(null);
    const out = await passes(fx.comp.id);
    expect(out.cert.held, `in service, the certificate pass runs: ${JSON.stringify(out.cert)}`).toBeUndefined();
    expect(out.team.held, `in service, the team-report pass runs: ${JSON.stringify(out.team)}`).toBeUndefined();
    expect(out.cert, "the held certificate is issued and mailed").toMatchObject({ jobs: 1, issued: 1, sent: 1, failed: 0 });
    expect(out.rem, "in service, the held start reminder goes out").toEqual({ ok: true, ran: true, claimed: 1, delivered: 1, skipped: 0, started: 0 });
    await expect.poll(() => reminderSubjects(fx.p.email, since), { timeout: 15000, message: "the start reminder reached the participant" })
      .toEqual([expect.stringMatching(/ starts in \d+ minutes$/)]);
    expect(reminderRow(fx.upcoming.id, fx.p.id).sent, "…and is recorded sent").toBe(1);
    expect(out.team, "the held wrap-up is sent").toMatchObject({ jobs: 1, runs: 1, sent: 1 });
    await expect.poll(() => certMails(fx.p.email, since).length, { timeout: 15000, message: "the congratulations email reached the participant" }).toBe(1);
    await expect.poll(() => memberMails(fx.memberEmail, since).length, { timeout: 15000, message: "the wrap-up reached the team" }).toBe(2);
    expect(state(fx.comp.id), "both jobs done: one certificate issued and mailed, the wrap-up sent and recorded")
      .toEqual({ certJobs: [], wrapupJobs: 0, badges: 1, certEmails: 1, wrapupSends: 1, wrapupRuns: 1 });
    expect(sql(db => db.prepare("SELECT status FROM certificate_emails WHERE competition_id=? AND user_id=?").get(fx.comp.id, fx.p.id)),
      "the participant's certificate email is recorded sent").toEqual({ status: "sent" });
  } finally {
    await restoreDomains();
  }
});
