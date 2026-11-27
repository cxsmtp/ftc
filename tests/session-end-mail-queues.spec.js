"use strict";

// ENDING AN EVENT THROUGH ITS SESSIONS, AND ENDING A PROGRAM, QUEUES ITS MAIL
// (routes/sessions.js; lib/certificate-dispatch.js `enqueueCertificateDispatch`,
// which also queues the event team's wrap-up through lib/team-reports.js
// `enqueueTeamReport`), read off the wire: a spawned server mailing a capturing
// relay, its workers driven by `POST /api/test/certificate-dispatch-tick` and
// `POST /api/test/team-report-tick` (neither runs by itself under test).
//
// Locks (sweep #349): each session route that can be the event's end queues the
// certificates and the team's wrap-up the moment it answers, and one pass of
// each worker issues and mails them:
//   * a session's End now, the last one running (CONTROL: ending one while
//     another runs queues neither);
//   * deleting the last session still to run (CONTROL: the earlier session's end
//     queued nothing, one being still to run);
//   * bulk-deleting the sessions still to run;
//   * shortening the last running session to the time it has run (its save);
//   * a Program ended with an event team gets its wrap-up (its certificates go
//     to each learner who completes, so its end queues no certificate job: the
//     team's wrap-up is queued before that early return).
// The jobs are read straight after the route answers. The status scheduler also
// notices a session that ENDED (within 60 s), so a read after its pass could not
// tell the route's queueing from the scheduler's. Once it has seen the earlier
// sessions end, a deleted session leaves it nothing to notice: there the route is
// the only path that queues anything.
// Every test sets the allowed-domain list, a global setting, and puts back its
// hard-coded default (empty) in its own `finally`.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { PORT_BASE } = require("./helpers");
const { startSmtpCapture } = require("./smtp-capture");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = PORT_BASE + 104;
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
    del: (p, h) => call("DELETE", p, undefined, h),
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
  const c = spawn(process.execPath, ["server.js"], {
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
  child = c;
  c.stdout.on("data", d => { childOut += d; });
  c.stderr.on("data", d => { childOut += d; });
  // `close`, not `exit`: it comes after the child's stdout has been read to the
  // end, so its last lines are in `childOut`. A server that dies stops the wait
  // below at once, its log tail in the error, and `kill()` never waits for an
  // exit that has already happened.
  let exited = null;
  childExit = new Promise(resolve => c.once("close", (code, signal) => {
    exited = { code, signal };
    if (child === c) child = null;
    resolve(exited);
  }));
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

/** The port must be free before anything binds it again. */
async function portFree() {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/healthz`); } catch (_) { return; }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`port ${PORT} was never freed`);
}

/** SIGKILL, then the port drained. A server that has already exited is not waited for. */
async function kill() {
  if (!child) return;
  const c = child, done = childExit;
  try { c.kill("SIGKILL"); } catch (_) { /* already gone */ }
  await done;
  await portFree();
}

test.beforeAll(async () => {
  smtp = await startSmtpCapture();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sessend-"));
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sessend-up-"));
  await boot();
});
test.afterAll(async () => {
  await kill();
  if (smtp) await smtp.close().catch(e => console.warn("smtp close:", e.message));
  for (const d of [dataDir, uploadsDir]) fs.rmSync(d, { recursive: true, force: true });
});
test.beforeEach(() => guardFixedPortSpec());

async function admin() {
  const c = client();
  const r = await c.post("/api/login", { email: "superadmin", password: superPass }, await c.h());
  expect(r.ok, `superadmin login: ${r.status} ${r.text}`).toBeTruthy();
  return c;
}

let seq = 0;
const stamp = () => `${Date.now().toString(36)}${++seq}`;

/** A verified, approved participant, signed in through the emailed-code door. */
async function person(tag) {
  const c = client();
  const s = stamp();
  const email = `${tag}-${s}@company.co`;
  const code = async () => {
    await c.post("/api/test/reset-recent-code-sends", {}, await c.h());
    const rq = await c.post("/api/auth/code/request", { email }, await c.h());
    expect(rq.ok, rq.text).toBeTruthy();
    return (await c.get(`/api/test/last-login-code?email=${encodeURIComponent(email)}`)).body.code;
  };
  const pr = await c.post("/api/auth/code/redeem", { email, code: await code() }, await c.h());
  expect(pr.body && pr.body.ok, `proof ${tag}: ${pr.text}`).toBe(true);
  const r = await c.post("/api/register", {
    firstName: "Sess", lastName: `End${tag}${s}`.replace(/[^a-z0-9]/gi, ""), company: "Acme", title: "Engineer",
    country: "US", timezone: "America/New_York", jobFunction: "", city: "",
  }, await c.h());
  expect(r.ok, `register ${tag}: ${r.status} ${r.text}`).toBeTruthy();
  const id = sql(db => db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email).id);
  sql(db => db.prepare("UPDATE users SET verified=1, approved=1 WHERE id=?").run(id));
  return { c, email, id };
}

async function makeEvent(sa, { kind = "tournament" } = {}) {
  const data = { name: `SessEnd ${kind} ${stamp()}`, event_kind: kind, start_time: new Date(Date.now() - 2 * 3600e3).toISOString(), timezone: "UTC" };
  if (kind === "program") data.deadline_at = new Date(Date.now() + 90 * 86400e3).toISOString();
  else data.duration_minutes = 600;
  const cr = await sa.post("/api/admin/competitions", data, await sa.h());
  expect(cr.ok, `create: ${cr.text}`).toBeTruthy();
  const comp = cr.body.competition;
  // Two challenges, one answered: nobody finishes, so nothing ends the event early.
  const taskIds = [];
  for (let i = 0; i < 2; i++) {
    const tr = await sa.post("/api/admin/tasks", {
      title: `SessEnd task ${stamp()}`, description: "<p>d</p>", difficulty: "easy",
      answer_type: "text", correct_answer: `right${i}`, status: "published",
    }, await sa.h());
    expect(tr.ok, tr.text).toBeTruthy();
    expect((await sa.post(`/api/admin/tasks/${tr.body.id}/competitions`, { competitionIds: [comp.id] }, await sa.h())).ok).toBeTruthy();
    taskIds.push(tr.body.id);
  }
  return { comp, taskIds };
}

/** A session `agoMin` minutes ago (negative: in the future) lasting `minutes`. */
async function session(sa, compId, name, agoMin, minutes = 600) {
  const r = await sa.post(`/api/admin/competitions/${compId}/timeslots`, {
    name: `${name} ${stamp()}`, start_time: new Date(Date.now() - agoMin * 60_000).toISOString(), duration_minutes: minutes,
  }, await sa.h());
  expect(r.ok, r.text).toBeTruthy();
  expect(r.body.timeslot.status, `PRECONDITION: ${name} is ${agoMin > 0 ? "live" : "upcoming"}`).toBe(agoMin > 0 ? "live" : "upcoming");
  return r.body.timeslot.id;
}

/** Joins the event, takes the session, and answers one challenge wrongly (attempted: a certificate). */
async function playIn(sa, compId, timeslotId, taskId, tag) {
  const p = await person(tag);
  const a = await sa.post("/api/admin/competitions/assign", { userIds: [p.id], competitionIds: [compId] }, await sa.h());
  expect(a.ok && a.body.assigned === 1, `assign ${tag}: ${a.text}`).toBe(true);
  const sel = await p.c.post("/api/select-competition", { competitionId: compId }, await p.c.h());
  expect(sel.ok, sel.text).toBeTruthy();
  if (timeslotId) {
    const ts = await p.c.post("/api/select-timeslot", { timeslotId, confirmLive: true }, await p.c.h());
    expect(ts.ok && ts.body.ok, `select-timeslot ${tag}: ${ts.text}`).toBeTruthy();
  }
  const t = await p.c.get(`/api/tasks/${taskId}`, { "x-competition-id": compId });
  expect(t.ok, t.text).toBeTruthy();
  const r = await p.c.post(`/api/tasks/${taskId}/submit`, { answer: "nope", gradingHash: t.body.grading_hash }, { ...(await p.c.h()), "x-competition-id": compId });
  expect(r.ok && r.body.correct === false, `submit ${tag}: ${r.text}`).toBe(true);
  return p;
}

/** The event team: a Marketing member at corp.example, which the allowed-domain list (a global setting) admits. */
async function team(sa, compId) {
  const d = await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h());
  expect(d.ok, d.text).toBeTruthy();
  const email = `mona-${stamp()}@corp.example`;
  const r = await sa.post(`/api/admin/competitions/${compId}/team`, { role: "marketing", name: "Mona", email }, await sa.h());
  expect(r.ok, r.text).toBeTruthy();
  return email;
}
/**
 * The allowed-domain list back to its hard-coded default, empty: every test sets
 * it (`team`) and calls this in its own `finally` (CLAUDE.md). Soft: a failure
 * here is reported beside the test's own error, never instead of it.
 */
async function restoreDomains(sa) {
  let r;
  try { r = await sa.put("/api/admin/team-report-domains", { domains: [] }, await sa.h()); }
  catch (e) { r = { ok: false, text: e.message }; }
  expect.soft(r.ok ? r.body.domains : r.text, `the allowed domains back to their default: ${r.text}`).toEqual([]);
}

const certJobs = (compId) => sql(db => db.prepare("SELECT user_id, reason FROM certificate_dispatch_jobs WHERE competition_id=?").all(compId));
const teamJobs = (compId) => sql(db => db.prepare("SELECT kind, end_key FROM team_report_jobs WHERE competition_id=?").all(compId));
const badges = (compId) => sql(db => db.prepare("SELECT user_id FROM achievement_badges WHERE competition_id=? AND revoked_at IS NULL").all(compId)).map(b => b.user_id).sort();
const certMails = (email) => smtp.messages.filter(m => (m.rcptTo || []).some(a => a.toLowerCase() === email.toLowerCase())
  && /certificate/i.test(m.header("subject") || "") && !/sign-in code/i.test(m.header("subject") || ""));
const mailsTo = (addr) => smtp.messages.filter(m => (m.rcptTo || []).some(a => a.toLowerCase() === addr.toLowerCase()));
/** A message's CSV attachment, decoded, or null. */
function csvPart(m) {
  const raw = m.raw.replace(/\r\n\.\./g, "\r\n.");
  const i = raw.search(/content-type:\s*text\/csv/i);
  if (i < 0) return null;
  const rest = raw.slice(i);
  const sep = rest.indexOf("\r\n\r\n");
  const end = rest.indexOf("\r\n--", sep);
  const head = rest.slice(0, sep), b = rest.slice(sep + 4, end < 0 ? undefined : end);
  if (/base64/i.test(head)) return Buffer.from(b.replace(/\s+/g, ""), "base64").toString("utf8");
  if (/quoted-printable/i.test(head)) return Buffer.from(b.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
  return b;
}
const wrapupRows = (compId) => sql(db => db.prepare("SELECT status FROM team_report_sends WHERE competition_id=? AND kind='wrapup'").all(compId)).map(r => r.status);
const runs = (compId) => sql(db => db.prepare("SELECT kind, end_key FROM team_report_runs WHERE competition_id=?").all(compId));
const statusOf = async (sa, compId) => {
  const r = await sa.get("/api/admin/competitions");
  expect(r.ok, r.text).toBeTruthy();
  return (Array.isArray(r.body) ? r.body : r.body.competitions).find(c => c.id === compId).status;
};

/** One status-scheduler pass (it also runs by itself every 60 s, and once at start). */
async function settle(sa) {
  const s = await sa.post("/api/test/scheduler-tick", {}, await sa.h());
  expect(s.ok, s.text).toBeTruthy();
}

/** Nothing of this event is queued, by value. */
function nothingQueued(compId, why) {
  expect(certJobs(compId), `${why}: no certificate job`).toEqual([]);
  expect(teamJobs(compId), `${why}: no team report job`).toEqual([]);
}
/** The certificates and the wrap-up were queued (read at once, before any scheduler pass). */
function bothQueued(compId, why) {
  expect(certJobs(compId), `${why}: the certificates are queued`).toEqual([{ user_id: "", reason: "ended" }]);
  expect(teamJobs(compId).map(j => j.kind), `${why}: the team's wrap-up is queued`).toEqual(["wrapup"]);
}

/**
 * One pass of each worker: every participant is issued and mailed a certificate,
 * and the team is sent the wrap-up. The scheduler is settled first (its pass that
 * first sees an end queues the reports again with a new due time), then the
 * wrap-up is made due without forcing, so no other event's job runs.
 */
async function mailsGoOut(sa, compId, players, member) {
  await settle(sa);
  const c = await sa.post("/api/test/certificate-dispatch-tick", { force: true, competitionId: compId }, await sa.h());
  expect(c.ok, c.text).toBeTruthy();
  expect(badges(compId), "every participant who played is issued a certificate").toEqual(players.map(p => p.id).sort());
  for (const p of players) await expect.poll(() => certMails(p.email).length, { timeout: 15000, message: `${p.email} is mailed theirs` }).toBe(1);
  sql(db => db.prepare("UPDATE team_report_jobs SET due_at=? WHERE competition_id=? AND kind='wrapup'").run(new Date(0).toISOString(), compId));
  const before = mailsTo(member).length;
  const t = await sa.post("/api/test/team-report-tick", { force: false }, await sa.h());
  expect(t.ok, t.text).toBeTruthy();
  expect(runs(compId).filter(r => r.kind === "wrapup"), "the wrap-up ran").toHaveLength(1);
  expect(wrapupRows(compId).length, "PRECONDITION: the wrap-up had messages").toBeGreaterThan(0);
  expect(wrapupRows(compId).every(s_ => s_ === "sent"), `every one was sent: ${JSON.stringify(wrapupRows(compId))}`).toBe(true);
  expect(mailsTo(member).length - before, "the team's Marketing member is sent the wrap-up").toBe(wrapupRows(compId).length);
  const files = mailsTo(member).slice(before).map(csvPart).filter(Boolean);
  for (const p of players) expect(files.some(f => f.includes(p.email)), `the wrap-up's lead file holds ${p.email}`).toBe(true);
}

test.describe("ending an event through its sessions queues its certificates and its team's wrap-up (sweep #349)", () => {
  test("a session's End now: ending one while another runs queues nothing; ending the last queues both, and one pass of each mails them", async () => {
    const sa = await admin();
    try {
      const { comp, taskIds } = await makeEvent(sa);
      const morning = await session(sa, comp.id, "Morning", 90);
      const evening = await session(sa, comp.id, "Evening", 30);
      const pm = await playIn(sa, comp.id, morning, taskIds[0], "endm");
      const pe = await playIn(sa, comp.id, evening, taskIds[0], "ende");
      const member = await team(sa, comp.id);

      let r = await sa.post(`/api/admin/competitions/${comp.id}/timeslots/${morning}/end-now`, {}, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
      expect(r.body.timeslot.status).toBe("ended");
      expect(await statusOf(sa, comp.id), "PRECONDITION: the other session runs on").toBe("live");
      nothingQueued(comp.id, "CONTROL: a session ended while another runs");

      r = await sa.post(`/api/admin/competitions/${comp.id}/timeslots/${evening}/end-now`, {}, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
      bothQueued(comp.id, "the last session's End now");
      expect(await statusOf(sa, comp.id)).toBe("ended");
      await mailsGoOut(sa, comp.id, [pm, pe], member);
    } finally { await restoreDomains(sa); }
  });

  test("deleting the last session still to run ends the event: the route queues both (no scheduler pass would)", async () => {
    const sa = await admin();
    try {
      const { comp, taskIds } = await makeEvent(sa);
      const morning = await session(sa, comp.id, "Morning", 60);
      const later = await session(sa, comp.id, "Later", -120);
      const pm = await playIn(sa, comp.id, morning, taskIds[0], "delm");
      const member = await team(sa, comp.id);
      const r0 = await sa.post(`/api/admin/competitions/${comp.id}/timeslots/${morning}/end-now`, {}, await sa.h());
      expect(r0.ok, r0.text).toBeTruthy();
      // The scheduler sees that end now, while a session is still to run: no later
      // pass of it has anything left to notice, so the delete alone can queue.
      await settle(sa);
      nothingQueued(comp.id, "CONTROL: one session is still to run");

      const r = await sa.del(`/api/admin/competitions/${comp.id}/timeslots/${later}`, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
      bothQueued(comp.id, "deleting the last session still to run");
      expect(await statusOf(sa, comp.id)).toBe("ended");
      await mailsGoOut(sa, comp.id, [pm], member);
    } finally { await restoreDomains(sa); }
  });

  test("bulk-deleting the sessions still to run ends the event: the route queues both", async () => {
    const sa = await admin();
    try {
      const { comp, taskIds } = await makeEvent(sa);
      const morning = await session(sa, comp.id, "Morning", 60);
      const later = await session(sa, comp.id, "Later", -120);
      const last = await session(sa, comp.id, "Last", -240);
      const pm = await playIn(sa, comp.id, morning, taskIds[0], "bulkm");
      const member = await team(sa, comp.id);
      const r0 = await sa.post(`/api/admin/competitions/${comp.id}/timeslots/${morning}/end-now`, {}, await sa.h());
      expect(r0.ok, r0.text).toBeTruthy();
      await settle(sa);   // as above: from here only the delete can queue
      nothingQueued(comp.id, "CONTROL: two sessions are still to run");

      const r = await sa.post(`/api/admin/competitions/${comp.id}/timeslots/bulk-delete`, { timeslotIds: [later, last] }, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
      expect(r.body.deleted).toBe(2);
      bothQueued(comp.id, "bulk-deleting the sessions still to run");
      await mailsGoOut(sa, comp.id, [pm], member);
    } finally { await restoreDomains(sa); }
  });

  test("shortening the last running session to the time it has run ends the event: the session's save queues both", async () => {
    const sa = await admin();
    try {
      const { comp, taskIds } = await makeEvent(sa);
      const morning = await session(sa, comp.id, "Morning", 30);
      const pm = await playIn(sa, comp.id, morning, taskIds[0], "shrm");
      const member = await team(sa, comp.id);
      // Shortened to the 30 minutes it has run, the session ends at the moment it was
      // created (after the server's first boot, the certificates' grandfather floor),
      // so what the participant did since is dated inside it (no clock control:
      // activity after the new end would make them a late entrant, off the board).
      const start = Date.parse(sql(db => db.prepare("SELECT start_time FROM competition_timeslots WHERE id=?").get(morning).start_time));
      const at = (min) => new Date(start + min * 60_000).toISOString();
      sql(db => {
        expect(db.prepare("UPDATE competition_users SET assigned_at=?, login_time=? WHERE competition_id=? AND user_id=?").run(at(1), at(1), comp.id, pm.id).changes).toBe(1);
        expect(db.prepare("UPDATE submissions SET submitted_at=? WHERE competition_id=? AND user_id=?").run(at(2), comp.id, pm.id).changes).toBe(1);
      });
      nothingQueued(comp.id, "CONTROL: the session runs");

      const r = await sa.put(`/api/admin/competitions/${comp.id}/timeslots/${morning}`, { duration_minutes: 30 }, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
      expect([r.body.timeslot.status, r.body.revived]).toEqual(["ended", false]);
      bothQueued(comp.id, "the session's save that ended it");
      await mailsGoOut(sa, comp.id, [pm], member);
    } finally { await restoreDomains(sa); }
  });
});

test.describe("a Program ended with an event team (sweep #349)", () => {
  test("End now queues the team's wrap-up and it goes out; no event-wide certificate job (a Program issues to each completer)", async () => {
    const sa = await admin();
    try {
      const { comp, taskIds } = await makeEvent(sa, { kind: "program" });
      const p = await playIn(sa, comp.id, null, taskIds[0], "prog");
      const member = await team(sa, comp.id);
      const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h());
      expect(end.ok, end.text).toBeTruthy();
      expect(end.body.competition.status).toBe("ended");
      expect(teamJobs(comp.id).map(j => j.kind), "the Program's end queues the team's wrap-up").toEqual(["wrapup"]);
      expect(certJobs(comp.id), "CONTROL: and no event-wide certificate job").toEqual([]);

      await settle(sa);
      sql(db => db.prepare("UPDATE team_report_jobs SET due_at=? WHERE competition_id=? AND kind='wrapup'").run(new Date(0).toISOString(), comp.id));
      const before = mailsTo(member).length;
      const t = await sa.post("/api/test/team-report-tick", { force: false }, await sa.h());
      expect(t.ok, t.text).toBeTruthy();
      const effEnd = sql(db => db.prepare("SELECT ended_at FROM competitions WHERE id=?").get(comp.id).ended_at);
      expect(runs(comp.id), "the wrap-up went out for the Program's end").toEqual([{ kind: "wrapup", end_key: effEnd }]);
      expect(mailsTo(member).length - before, "the team is sent it").toBeGreaterThan(0);
      expect(wrapupRows(comp.id).every(s_ => s_ === "sent")).toBe(true);
      const files = mailsTo(member).slice(before).map(csvPart).filter(Boolean);
      expect(files.some(f => f.includes(p.email)), "Marketing's lead file holds the learner").toBe(true);
    } finally { await restoreDomains(sa); }
  });
});
