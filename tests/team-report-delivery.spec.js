"use strict";

// WHO IS SENT THE EVENT TEAM'S REPORT, WHEN, AND WHAT A SHUTDOWN OR A CRASH
// LEAVES (lib/team-reports.js, lib/event-team.js), read off the wire: a spawned
// server mailing a capturing relay (tests/smtp-capture.js), its passes driven by
// `POST /api/test/team-report-tick` and its stop by `POST /api/test/shutdown`
// (the SIGTERM drain, which no signal reaches under NODE_ENV=test).
//
// Locks (sweeps #55 and #513), each beside its control:
//   * the allowed-domain match: with example.com allowed, notexample.com and
//     example.com.evil.test are refused and sub.example.com admitted, when a
//     member is added AND when a report is sent (a domain taken off the list
//     since stops the mail: `refused`);
//   * late entrants wait for the late window: the wrap-up goes out at the end,
//     and the late leads' delta, keyed `late:<deadline>`, is deferred while the
//     window is open (re-keyed when the deadline moves) and sent once it closes;
//   * Send now stamps nobody as reported: a late entrant it showed is still
//     carried to the team by the late delta, which Close late entries now
//     re-keys to the deadline it stores (`late:<that deadline>`, due 15 minutes
//     after the close, no longer at the window's automatic close);
//   * a pass a shutdown cuts keeps its job (a wrap-up, a 48-hour reminder): at
//     the next start the rest of the team is sent theirs, nobody twice; the
//     wrap-up's re-run stamps nobody, so a late entrant who joined after the cut
//     is left unreported and, the window having closed meanwhile, the re-run
//     itself queues the delta that carries them;
//   * a send a crash cut is marked `unknown` at the next start and never sent
//     again, while the rest of the team gets theirs.
// Every test sets the allowed-domain list, a global setting, and puts back its
// hard-coded default (empty) in its own `finally`.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { PORT_BASE } = require("./helpers");
const { startSmtpCapture } = require("./smtp-capture");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = PORT_BASE + 103;
const BASE = `http://127.0.0.1:${PORT}`;
const SETTLE_MS = 15 * 60_000;

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
    let body = t; try { body = JSON.parse(t); } catch (_) { body = t; }
    return { status: r.status, ok: r.status >= 200 && r.status < 300, body, text: t };
  };
  return {
    call,
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
  // end, so its last lines (the drain's report) are in `childOut`.
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

/** The port must be free before a respawn binds it. */
async function portFree() {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/healthz`); } catch (_) { return; }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`port ${PORT} was never freed`);
}

/** A crash: SIGKILL, nothing drained. */
async function kill() {
  if (!child) return;
  const c = child, done = childExit;
  try { c.kill("SIGKILL"); } catch (_) { /* already gone */ }
  await done;
  await portFree();
}

test.beforeAll(async () => {
  smtp = await startSmtpCapture();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "teamdeliv-"));
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "teamdeliv-up-"));
  await boot();
});
test.afterAll(async () => {
  await kill();
  if (smtp) { smtp.release(); await smtp.close().catch(e => console.warn("smtp close:", e.message)); }
  for (const d of [dataDir, uploadsDir]) fs.rmSync(d, { recursive: true, force: true });
});
test.beforeEach(async () => {
  guardFixedPortSpec();
  // A test that stopped the server and failed before starting it again must
  // not take the next one down with it.
  if (!child) { await portFree(); await boot(); }
});
test.afterEach(() => { smtp.release(); });

async function admin() {
  const c = client();
  const r = await c.post("/api/login", { email: "superadmin", password: superPass }, await c.h());
  expect(r.ok, `superadmin login: ${r.status} ${r.text}`).toBeTruthy();
  return c;
}

let seq = 0;
const stamp = () => `${Date.now().toString(36)}${++seq}`;

async function codeSignIn(c, email) {
  await c.post("/api/test/reset-recent-code-sends", {}, await c.h());
  const rq = await c.post("/api/auth/code/request", { email }, await c.h());
  expect(rq.ok, rq.text).toBeTruthy();
  const code = (await c.get(`/api/test/last-login-code?email=${encodeURIComponent(email)}`)).body.code;
  return c.post("/api/auth/code/redeem", { email, code }, await c.h());
}

/** A verified, approved participant, signed in. */
async function person(tag, { company = "Acme" } = {}) {
  const c = client();
  const s = stamp();
  const email = `${tag}-${s}@company.co`;
  const pr = await codeSignIn(c, email);   // an address proof for a new address
  expect(pr.body && pr.body.ok, `proof ${tag}: ${pr.text}`).toBe(true);
  const r = await c.post("/api/register", {
    firstName: "Pat", lastName: `L${tag}${s}`.replace(/[^a-z0-9]/gi, ""), company, title: "Engineer",
    country: "US", timezone: "America/New_York", jobFunction: "", city: "",
  }, await c.h());
  expect(r.ok, `register ${tag}: ${r.status} ${r.text}`).toBeTruthy();
  const id = sql(db => db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email).id);
  sql(db => db.prepare("UPDATE users SET verified=1, approved=1 WHERE id=?").run(id));
  return { c, email, id };
}

async function makeEvent(sa, { kind = "tournament", minutes = 600, tasks = 2, extra = {} } = {}) {
  const data = { name: `Deliv ${kind} ${stamp()}`, event_kind: kind, start_time: new Date(Date.now() - 10 * 60_000).toISOString(), timezone: "UTC", duration_minutes: minutes, ...extra };
  const cr = await sa.post("/api/admin/competitions", data, await sa.h());
  expect(cr.ok, `create: ${cr.text}`).toBeTruthy();
  const comp = cr.body.competition;
  const taskIds = [];
  for (let i = 0; i < tasks; i++) {
    const tr = await sa.post("/api/admin/tasks", {
      title: `Deliv task ${stamp()}`, description: "<p>d</p>", difficulty: "easy",
      answer_type: "text", correct_answer: `right${i}`, status: "published",
    }, await sa.h());
    expect(tr.ok, tr.text).toBeTruthy();
    expect((await sa.post(`/api/admin/tasks/${tr.body.id}/competitions`, { competitionIds: [comp.id] }, await sa.h())).ok).toBeTruthy();
    taskIds.push(tr.body.id);
  }
  return { comp, taskIds };
}

async function assign(sa, compId, ps) {
  const r = await sa.post("/api/admin/competitions/assign", { userIds: ps.map(p => p.id), competitionIds: [compId] }, await sa.h());
  expect(r.ok, r.text).toBeTruthy();
  expect(r.body.assigned, JSON.stringify(r.body)).toBe(ps.length);
}
async function enter(p, compId) {
  const sel = await p.c.post("/api/select-competition", { competitionId: compId }, await p.c.h());
  expect(sel.ok, sel.text).toBeTruthy();
}
async function submit(p, compId, taskId, answer) {
  const t = await p.c.get(`/api/tasks/${taskId}`, { "x-competition-id": compId });
  expect(t.ok, t.text).toBeTruthy();
  return p.c.post(`/api/tasks/${taskId}/submit`, { answer, gradingHash: t.body.grading_hash }, { ...(await p.c.h()), "x-competition-id": compId });
}
/** A participant who joined and answered (a wrong answer: nothing ends early). */
async function player(sa, compId, taskId, tag, opts) {
  const p = await person(tag, opts);
  await assign(sa, compId, [p]);
  await enter(p, compId);
  expect((await submit(p, compId, taskId, "nope")).body.correct).toBe(false);
  return p;
}

async function domains(sa, list) {
  const r = await sa.put("/api/admin/team-report-domains", { domains: list }, await sa.h());
  expect(r.ok, r.text).toBeTruthy();
  expect(r.body.domains).toEqual(list);
}
/**
 * The allowed-domain list back to its hard-coded default, empty: every test sets
 * it, a global setting, and calls this in its own `finally` (CLAUDE.md). The test
 * may have stopped the server, or restarted it (which signs every session out),
 * so a stopped one is started and a fresh superadmin session asks. Soft: a
 * failure here is reported beside the test's own error, never instead of it.
 */
async function restoreDomains() {
  let r;
  try {
    if (!child) { await portFree(); await boot(); }
    const sa = await admin();
    r = await sa.put("/api/admin/team-report-domains", { domains: [] }, await sa.h());
  } catch (e) { r = { ok: false, text: e.message }; }
  expect.soft(r.ok ? r.body.domains : r.text, `the allowed domains back to their default: ${r.text}`).toEqual([]);
}
async function addMember(sa, compId, role, name, email = `${name.toLowerCase()}-${stamp()}@corp.example`) {
  const r = await sa.post(`/api/admin/competitions/${compId}/team`, { role, name, email }, await sa.h());
  expect(r.ok, `add ${email}: ${r.text}`).toBeTruthy();
  return { ...r.body.member, email };
}

/**
 * End Now, then one status-scheduler pass: the scheduler also runs by itself
 * every 60 s (and once at every start), and the pass that first sees an end
 * queues the reports again (a new due time). Settled here, it never touches
 * this event's jobs afterwards, a restart included.
 */
async function endNow(sa, compId) {
  const r = await sa.post(`/api/admin/competitions/${compId}/end-now`, {}, await sa.h());
  expect(r.ok, r.text).toBeTruthy();
  const s = await sa.post("/api/test/scheduler-tick", {}, await sa.h());
  expect(s.ok, s.text).toBeTruthy();
}
async function tick(sa, force = false) {
  const r = await sa.post("/api/test/team-report-tick", { force }, await sa.h());
  expect(r.ok, `tick: ${r.text}`).toBeTruthy();
  return r.body;
}
const dueNow = (compId, kind) => sql(db => db.prepare("UPDATE team_report_jobs SET due_at=? WHERE competition_id=? AND kind=?").run(new Date(0).toISOString(), compId, kind));
const job = (compId, kind) => sql(db => db.prepare("SELECT end_key, due_at, passes FROM team_report_jobs WHERE competition_id=? AND kind=?").get(compId, kind));
const runs = (compId, kind) => sql(db => db.prepare("SELECT COUNT(*) AS n FROM team_report_runs WHERE competition_id=? AND kind=?").get(compId, kind).n);
/** The ledger of one kind of run: recipient → status. */
const sends = (compId, kind) => Object.fromEntries(sql(db => db.prepare(
  "SELECT recipient, status FROM team_report_sends WHERE competition_id=? AND kind=?").all(compId, kind)).map(r => [r.recipient, r.status]));
const sentAt = (compId, kind, recipient) => sql(db => db.prepare(
  "SELECT sent_at FROM team_report_sends WHERE competition_id=? AND kind=? AND recipient=?").get(compId, kind, recipient)).sent_at;
/** A lead's row (a report run stores one for each lead it builds), or undefined. */
const leadRow = (compId, userId) => sql(db => db.prepare("SELECT first_reported_at FROM event_leads WHERE competition_id=? AND user_id=?").get(compId, userId));
const stampOf = (compId, userId) => {
  const r = leadRow(compId, userId);
  return r ? r.first_reported_at : null;
};
const lateDeadlineOf = (compId) => sql(db => db.prepare("SELECT late_entry_deadline_at FROM competitions WHERE id=?").get(compId).late_entry_deadline_at);
const endedAtOf = (compId) => sql(db => db.prepare("SELECT ended_at FROM competitions WHERE id=?").get(compId).ended_at);
const isoPlus = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

const mailsTo = (addr, since = 0) => smtp.messages.slice(since).filter(m => (m.rcptTo || []).some(a => a.toLowerCase() === addr.toLowerCase()));
const subjectOf = (m) => String(m.header("subject") || "").replace(/=\?UTF-8\?([QB])\?([^?]*)\?=\s*/gi, (_, enc, t) => enc.toUpperCase() === "B"
  ? Buffer.from(t, "base64").toString("utf8")
  : Buffer.from(t.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8"));
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

async function settled(promise, ms, what) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} (${ms} ms). Log:\n${childOut.slice(-2000)}`)), ms); });
  try { return await Promise.race([promise, t]); } finally { clearTimeout(timer); }
}

/**
 * Starts one pass with the relay withholding its answers, and resolves once the
 * pass's FIRST message to the team has arrived (so it is held, and the pass waits
 * on it). Counted by recipient, never by the relay's held count: a sign-in mail
 * an earlier step sent detached may still land meanwhile. The pass's own request
 * is dropped, so nothing waits on the pass but the pass. The caller releases.
 */
async function holdPassAtFirstSend(sa, team) {
  const h = await sa.h();
  const since = smtp.messages.length;
  const toTeam = (m) => (m.rcptTo || []).some(a => team.includes(a.toLowerCase()));
  smtp.hold();
  const ac = new AbortController();
  const pass = sa.call("POST", "/api/test/team-report-tick", { force: false }, h, ac.signal).catch(() => null);
  await expect.poll(() => smtp.messages.slice(since).filter(toTeam).length,
    { timeout: 15000, message: "the pass is held on its first send" }).toBe(1);
  ac.abort();
  await pass;
}

/**
 * One pass held on its first send to the team while the server shuts down: the
 * server is told to stop, and only then is the held send answered. Resolves to
 * the server's exit.
 */
async function passCutByShutdown(sa, team) {
  const exit = childExit;
  try {
    await holdPassAtFirstSend(sa, team);
    // The hook ends the process, so it acts only when told to in so many words.
    const unconfirmed = await sa.post("/api/test/shutdown", {}, await sa.h());
    expect(unconfirmed.status, `the hook stops nothing unasked: ${unconfirmed.text}`).toBe(400);
    const r = await sa.post("/api/test/shutdown", { confirm: "shutdown" }, await sa.h());
    expect(r.ok, `shutdown: ${r.status} ${r.text}`).toBe(true);
  } finally { smtp.release(); }
  const out = await settled(exit, 25000, "the server never exited");
  await portFree();
  return out;
}

test.describe("the allowed domains bound the event team, when a member is added and when a report is sent (sweep #55)", () => {
  test("with example.com allowed, notexample.com and example.com.evil.test are refused and sub.example.com admitted; a domain taken off the list since stops the mail", async () => {
    const sa = await admin();
    try {
      const { comp, taskIds } = await makeEvent(sa);
      await player(sa, comp.id, taskIds[0], "domlead");
      const s = stamp();
      const lookA = `nora-${s}@notexample.com`, lookB = `ezra-${s}@example.com.evil.test`;
      const sub = `sue-${s}@sub.example.com`, exact = `ed-${s}@example.com`;
      const addSe = async (name, email) => sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "se", name, email }, await sa.h());
      const team = () => sql(db => db.prepare("SELECT email FROM event_team_members WHERE competition_id=?").all(comp.id)).map(r => r.email).sort();

      // AT ADD: a look-alike is not the domain, a subdomain is.
      await domains(sa, ["example.com"]);
      for (const [name, email] of [["Nora", lookA], ["Ezra", lookB]]) {
        const r = await addSe(name, email);
        expect([r.status, r.body.code], `${email} is not at example.com`).toEqual([400, "team_domain_not_allowed"]);
      }
      for (const [name, email] of [["Sue", sub], ["Ed", exact]]) {
        const r = await addSe(name, email);
        expect(r.status, `${email} is at example.com: ${r.text}`).toBe(200);
      }
      expect(team(), "only the two at example.com were added").toEqual([exact, sub].sort());

      // AT SEND: the look-alikes join while their own domains are allowed; the
      // list is then cut back to example.com.
      await domains(sa, ["notexample.com", "example.com.evil.test", "example.com"]);
      for (const [name, email] of [["Nora", lookA], ["Ezra", lookB]]) {
        const r = await addSe(name, email);
        expect(r.status, `PRECONDITION: ${email} joins while its domain is allowed: ${r.text}`).toBe(200);
      }
      await domains(sa, ["example.com"]);
      const listed = await sa.get(`/api/admin/competitions/${comp.id}/team`);
      expect(listed.ok, listed.text).toBeTruthy();
      expect(Object.fromEntries(listed.body.members.map(m => [m.email, m.allowed])), "the team list says who will not be sent the report")
        .toEqual({ [lookA]: false, [lookB]: false, [sub]: true, [exact]: true });

      await endNow(sa, comp.id);
      dueNow(comp.id, "wrapup");
      const n0 = smtp.messages.length;
      const t = await tick(sa);
      expect(t.runs, JSON.stringify(t)).toBe(1);
      expect(sends(comp.id, "wrapup"), "the ledger: refused at send, sent where the domain still allows")
        .toEqual({ [lookA]: "refused", [lookB]: "refused", [sub]: "sent", [exact]: "sent" });
      for (const a of [sub, exact]) expect(mailsTo(a, n0), `${a} is sent the wrap-up`).toHaveLength(1);
      for (const a of [lookA, lookB]) expect(mailsTo(a, n0), `${a} is sent nothing`).toHaveLength(0);
      const hist = sql(db => db.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type='team_report_sent'").all(comp.id)).map(r => JSON.parse(r.details));
      expect(hist.map(h => [h.kind, h.sent, h.refused]), "the History counts both").toEqual([["wrapup", 2, 2]]);
    } finally { await restoreDomains(); }
  });
});

test.describe("late entrants wait for the late window (sweep #55)", () => {
  test("the wrap-up goes out at the end; the late leads' delta is keyed late:<deadline>, deferred while the window is open, re-keyed when the deadline moves, and sent once it has closed", async () => {
    const sa = await admin();
    try {
      await domains(sa, ["corp.example"]);
      const { comp, taskIds } = await makeEvent(sa, { kind: "booth", minutes: 120 });
      const early = await player(sa, comp.id, taskIds[0], "lwearly", { company: "Early Co" });
      const mona = await addMember(sa, comp.id, "marketing", "Mona");
      await endNow(sa, comp.id);
      const endedAt = endedAtOf(comp.id);
      const deadline = isoPlus(endedAt, 48 * 3600e3);   // a Booth Event's window: the end + 48 h

      // CONTROL: the window open does not hold the wrap-up.
      dueNow(comp.id, "wrapup");
      let n0 = smtp.messages.length;
      await tick(sa);
      expect(runs(comp.id, "wrapup"), "the wrap-up ran while the window is open").toBe(1);
      expect(mailsTo(mona.email, n0).length, "and reached the team").toBeGreaterThan(0);
      expect(stampOf(comp.id, early.id), "its lead is reported").toBeTruthy();
      expect(job(comp.id, "delta"), "the wrap-up queues the late leads' delta for the window's close")
        .toMatchObject({ end_key: `late:${deadline}`, due_at: isoPlus(deadline, SETTLE_MS) });

      // Somebody joins late, while the window is open.
      const late = await player(sa, comp.id, taskIds[0], "lwlate", { company: "Late Co" });
      // Run before its time, the delta waits: deferred, nothing sent, nobody reported.
      dueNow(comp.id, "delta");
      n0 = smtp.messages.length;
      let t = await tick(sa);
      expect(t.deferred, JSON.stringify(t)).toBe(1);
      expect(job(comp.id, "delta"), "deferred to the window's close, under the same key")
        .toMatchObject({ end_key: `late:${deadline}`, due_at: isoPlus(deadline, SETTLE_MS) });
      expect(runs(comp.id, "delta")).toBe(0);
      expect(mailsTo(mona.email, n0), "nothing is sent while late entrants may still come").toHaveLength(0);
      expect(stampOf(comp.id, late.id), "the late entrant is not reported yet").toBeNull();

      // The deadline moves (a superadmin pins a later one): the job follows it.
      const pinned = isoPlus(endedAt, 72 * 3600e3);
      sql(db => db.prepare("UPDATE competitions SET late_entry_deadline_at=? WHERE id=?").run(pinned, comp.id));
      await new Promise(r => setTimeout(r, 1200));   // the 1 s competition cache; a direct write busts nothing
      dueNow(comp.id, "delta");
      t = await tick(sa);
      expect(t.deferred, JSON.stringify(t)).toBe(1);
      expect(job(comp.id, "delta"), "re-keyed to the new deadline").toMatchObject({ end_key: `late:${pinned}`, due_at: isoPlus(pinned, SETTLE_MS) });

      // The window lapses by itself (its deadline passes, still after the end): the
      // same job now runs and carries the late entrant alone.
      sql(db => db.prepare("UPDATE competitions SET late_entry_deadline_at=? WHERE id=?").run(isoPlus(endedAt, 1000), comp.id));
      await new Promise(r => setTimeout(r, 1200));
      dueNow(comp.id, "delta");
      n0 = smtp.messages.length;
      t = await tick(sa);
      expect(t.deferred, JSON.stringify(t)).toBe(0);
      const delta = mailsTo(mona.email, n0).filter(m => /1 new lead since the last report/i.test(subjectOf(m)) && csvPart(m));
      expect(delta, "the team is sent the late lead once the window has closed").toHaveLength(1);
      expect(csvPart(delta[0])).toContain(late.email);
      expect(csvPart(delta[0]), "and not the lead the wrap-up reported").not.toContain(early.email);
      expect(job(comp.id, "delta"), "the job is done").toBeUndefined();
      expect(runs(comp.id, "delta")).toBe(1);
      expect(stampOf(comp.id, late.id), "the late entrant is reported now").toBeTruthy();
    } finally { await restoreDomains(); }
  });
});

test.describe("Send now reports nobody as reported (sweep #55)", () => {
  test("a late entrant Send now showed the team is still carried to it by the late delta, which the close re-keys to its own deadline; no stamp moves", async () => {
    const sa = await admin();
    try {
      await domains(sa, ["corp.example"]);
      const { comp, taskIds } = await makeEvent(sa, { kind: "booth", minutes: 120 });
      const early = await player(sa, comp.id, taskIds[0], "snearly", { company: "Early Co" });
      const mia = await addMember(sa, comp.id, "marketing", "Mia");
      await endNow(sa, comp.id);
      const deadline = isoPlus(endedAtOf(comp.id), 48 * 3600e3);   // the window's automatic close
      dueNow(comp.id, "wrapup");
      await tick(sa);
      const earlyStamp = stampOf(comp.id, early.id);
      expect(earlyStamp, "PRECONDITION: the wrap-up reported the early lead").toBeTruthy();

      const late = await player(sa, comp.id, taskIds[0], "snlate", { company: "Late Co" });
      const n0 = smtp.messages.length;
      const r = await sa.post(`/api/admin/competitions/${comp.id}/team-report/send`, {}, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
      expect(r.body.sent, JSON.stringify(r.body)).toBeGreaterThan(0);
      const shown = mailsTo(mia.email, n0).map(csvPart).filter(Boolean);
      expect(shown.some(c => c.includes(late.email)), "PRECONDITION: Send now's lead file shows the late entrant").toBe(true);
      expect(stampOf(comp.id, late.id), "Send now reports nobody: the late entrant is still unreported").toBeNull();
      expect(stampOf(comp.id, early.id), "and no stamp moves").toBe(earlyStamp);

      // Late entries close. The late delta the wrap-up queued waits for the
      // window's automatic close; the close re-keys it to the deadline it stores
      // and makes it due 15 minutes after the close.
      expect(job(comp.id, "delta"), "PRECONDITION: the wrap-up's late delta waits for the window's automatic close")
        .toMatchObject({ end_key: `late:${deadline}`, due_at: isoPlus(deadline, SETTLE_MS) });
      const c0 = Date.now();
      const close = await sa.post(`/api/admin/competitions/${comp.id}/late-entry/close`, {}, await sa.h());
      const c1 = Date.now();
      expect(close.ok, close.text).toBeTruthy();
      const closedTo = lateDeadlineOf(comp.id);
      expect(Date.parse(closedTo) >= c0 - 1 && Date.parse(closedTo) < c1, `PRECONDITION: the close stored a deadline at the press: ${closedTo}`).toBe(true);
      const rekeyed = job(comp.id, "delta");
      expect(rekeyed && rekeyed.end_key, "the close re-keys the late delta to the deadline it stored").toBe(`late:${closedTo}`);
      const dueMs = Date.parse(rekeyed.due_at) - SETTLE_MS;
      expect(dueMs >= c0 && dueMs <= c1, `and makes it due ${SETTLE_MS / 60_000} minutes after the close, no longer at ${isoPlus(deadline, SETTLE_MS)}: ${rekeyed.due_at}`).toBe(true);

      // The delta carries the late entrant to the team.
      dueNow(comp.id, "delta");
      const n1 = smtp.messages.length;
      await tick(sa);
      const delta = mailsTo(mia.email, n1).filter(m => /1 new lead since the last report/i.test(subjectOf(m)) && csvPart(m));
      expect(delta, "the delta carries the late entrant to the team").toHaveLength(1);
      expect(csvPart(delta[0])).toContain(late.email);
      expect(csvPart(delta[0]), "CONTROL: not the lead the wrap-up reported").not.toContain(early.email);
      expect(stampOf(comp.id, late.id), "reported by the delta's delivery").toBeTruthy();
      expect(runs(comp.id, "delta"), "the delta ran under the close's key").toBe(1);
      expect(sql(db => db.prepare("SELECT end_key FROM team_report_runs WHERE competition_id=? AND kind='delta'").get(comp.id).end_key)).toBe(`late:${closedTo}`);
    } finally { await restoreDomains(); }
  });
});

test.describe("a pass a shutdown or a crash cuts (sweep #513)", () => {
  test("a wrap-up a shutdown cuts keeps its job: at the next start the rest of the team is sent theirs, nobody twice, and the re-run stamps nobody: a late entrant who joined since is left unreported, for the delta it queues", async () => {
    const sa = await admin();
    try {
      await domains(sa, ["corp.example"]);
      // A Booth Event: its late window lets somebody join between the cut and the re-run.
      const { comp, taskIds } = await makeEvent(sa, { kind: "booth", minutes: 120 });
      const lead = await player(sa, comp.id, taskIds[0], "cutlead");
      const sean = await addMember(sa, comp.id, "se", "Sean");
      const sal = await addMember(sa, comp.id, "sales", "Sal");
      await endNow(sa, comp.id);
      dueNow(comp.id, "wrapup");
      const n0 = smtp.messages.length;

      const exit = await passCutByShutdown(sa, [sean.email, sal.email]);
      expect(exit, `the drain finished and exited cleanly. Log:\n${childOut.slice(-1500)}`).toEqual({ code: 0, signal: null });
      expect(childOut, "the pass was drained, not cut off by the database closing").toMatch(/Shutdown complete \([^)]*certificates drained/);

      // What the cut left: one recipient was sent theirs, the other nothing; the
      // job is kept and no run is recorded.
      const cut = sends(comp.id, "wrapup");
      expect(Object.values(cut), `one send, completed: ${JSON.stringify(cut)}`).toEqual(["sent"]);
      const first = Object.keys(cut)[0];
      expect([sean.email, sal.email]).toContain(first);
      const rest = first === sean.email ? sal.email : sean.email;
      expect(mailsTo(first, n0), "the send in flight was delivered").toHaveLength(1);
      expect(mailsTo(rest, n0), "nothing after the stop").toHaveLength(0);
      expect(job(comp.id, "wrapup"), "the job is kept").toBeTruthy();
      expect(runs(comp.id, "wrapup"), "no run is recorded").toBe(0);
      const stamped = stampOf(comp.id, lead.id);
      expect(stamped, "the lead is reported at that first delivery").toBe(sentAt(comp.id, "wrapup", first));

      // The next start. Before the wrap-up runs again somebody joins in the late
      // window, and late entries are then closed: the close queues no delta while
      // the wrap-up has not run (the wrap-up accounts for whoever is left), so a
      // delta pending after the re-run is the re-run's own.
      await boot();
      const sa2 = await admin();
      expect(sends(comp.id, "wrapup"), "a graceful stop leaves nothing in flight to mark").toEqual(cut);
      const late = await player(sa2, comp.id, taskIds[0], "cutlate");
      const close = await sa2.post(`/api/admin/competitions/${comp.id}/late-entry/close`, {}, await sa2.h());
      expect(close.ok, close.text).toBeTruthy();
      const closedTo = lateDeadlineOf(comp.id);
      expect(job(comp.id, "delta"), "PRECONDITION: no delta is pending before the re-run").toBeUndefined();
      expect(leadRow(comp.id, late.id), "PRECONDITION: no report has seen the late entrant yet").toBeUndefined();
      const t0 = Date.now();
      await tick(sa2);
      const t1 = Date.now();
      expect(mailsTo(rest, n0), "the rest of the team is sent theirs").toHaveLength(1);
      expect(mailsTo(first, n0), "and nobody a second copy").toHaveLength(1);
      expect(sends(comp.id, "wrapup")).toEqual({ [sean.email]: "sent", [sal.email]: "sent" });
      expect(runs(comp.id, "wrapup"), "the run is recorded once everyone has it").toBe(1);
      expect(job(comp.id, "wrapup"), "and the job is done").toBeUndefined();
      // The re-run stamps nobody. The late entrant is one of its leads (it stored
      // their row) but in no copy the first recipient was sent, so is left
      // unreported; the lead keeps the first delivery's stamp.
      expect(leadRow(comp.id, late.id), "the re-run stamps nobody: the late entrant is left unreported").toEqual({ first_reported_at: null });
      expect(stampOf(comp.id, lead.id), "the lead keeps the first delivery's stamp").toBe(stamped);
      // The window being closed, nothing else will report them: the re-run
      // queues the delta that does.
      const queued = job(comp.id, "delta");
      expect(queued && queued.end_key, "the re-run queues the late entrant's delta").toBe(`late:${closedTo}`);
      const dueMs = Date.parse(queued.due_at) - SETTLE_MS;
      expect(dueMs >= t0 && dueMs <= t1, `queued by the re-run, due ${SETTLE_MS / 60_000} minutes after it: ${queued.due_at}`).toBe(true);

      // CONTROL: the late entrant can be reported: the delta goes to Sales (an SE
      // is sent no delta) and reports them at its delivery.
      dueNow(comp.id, "delta");
      await tick(sa2);
      expect(sends(comp.id, "delta"), "the delta goes out").toEqual({ [sal.email]: "sent" });
      expect(stampOf(comp.id, late.id), "and reports the late entrant at its delivery").toBe(sentAt(comp.id, "delta", sal.email));
    } finally { await restoreDomains(); }
  });

  test("a 48-hour reminder a shutdown cuts keeps its job: at the next start the rest of the team is sent theirs, nobody twice", async () => {
    const sa = await admin();
    try {
      await domains(sa, ["corp.example"]);
      // A Competition with the qualifying questions; the lead answers Yes to the
      // follow-up question, which makes them HOT, so the reminder has something to say.
      const { comp } = await makeEvent(sa, { extra: { add_qualifying: true } });
      const p = await person("nudgelead");
      await assign(sa, comp.id, [p]);
      await enter(p, comp.id);
      const fu = sql(db => db.prepare(
        `SELECT t.id, t.choices FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id JOIN task_tags tt ON tt.task_id=t.id AND tt.tag='qualifying:follow_up' WHERE ct.competition_id=?`
      ).get(comp.id));
      expect(fu, "PRECONDITION: the event asks the follow-up question").toBeTruthy();
      const yes = await submit(p, comp.id, fu.id, JSON.stringify([JSON.parse(fu.choices)[0].id]));
      expect(yes.ok, yes.text).toBeTruthy();
      const nia = await addMember(sa, comp.id, "sdr", "Nia");
      const mo = await addMember(sa, comp.id, "marketing", "Mo");
      await endNow(sa, comp.id);
      dueNow(comp.id, "wrapup");
      await tick(sa);
      expect(runs(comp.id, "wrapup"), "PRECONDITION: the wrap-up ran").toBe(1);
      expect(job(comp.id, "nudge"), "PRECONDITION: and queued the reminder").toBeTruthy();
      const lead = (await sa.get(`/api/admin/competitions/${comp.id}/team-report`)).body.leads.find(l => l.user_id === p.id);
      expect(!!lead && lead.signal === "hot" && lead.contactable, "PRECONDITION: a hot lead waits").toBe(true);

      dueNow(comp.id, "nudge");
      const reminders = (addr) => mailsTo(addr).filter(m => /Reminder:/.test(subjectOf(m)));
      expect(reminders(nia.email).length + reminders(mo.email).length, "PRECONDITION: no reminder yet").toBe(0);
      const exit = await passCutByShutdown(sa, [nia.email, mo.email]);
      expect(exit, `exited cleanly. Log:\n${childOut.slice(-1500)}`).toEqual({ code: 0, signal: null });
      const cut = sends(comp.id, "nudge");
      expect(Object.values(cut), `one reminder, sent: ${JSON.stringify(cut)}`).toEqual(["sent"]);
      const first = Object.keys(cut)[0];
      expect([nia.email, mo.email]).toContain(first);
      const rest = first === nia.email ? mo.email : nia.email;
      expect(reminders(first)).toHaveLength(1);
      expect(reminders(rest), "nothing after the stop").toHaveLength(0);
      expect(job(comp.id, "nudge"), "the reminder's job is kept").toBeTruthy();
      expect(runs(comp.id, "nudge"), "no run is recorded").toBe(0);

      await boot();
      const sa2 = await admin();
      await tick(sa2);
      expect(reminders(rest), "the rest of the team is sent theirs").toHaveLength(1);
      expect(reminders(first), "and nobody a second").toHaveLength(1);
      expect(sends(comp.id, "nudge")).toEqual({ [nia.email]: "sent", [mo.email]: "sent" });
      expect(runs(comp.id, "nudge")).toBe(1);
      expect(job(comp.id, "nudge")).toBeUndefined();
    } finally { await restoreDomains(); }
  });

  test("a send a crash cuts is marked unknown at the next start and never sent again; the rest of the team gets theirs", async () => {
    const sa = await admin();
    try {
      await domains(sa, ["corp.example"]);
      const { comp, taskIds } = await makeEvent(sa);
      await player(sa, comp.id, taskIds[0], "crashlead");
      const sean = await addMember(sa, comp.id, "se", "Sean");
      const sal = await addMember(sa, comp.id, "sales", "Sal");
      await endNow(sa, comp.id);
      dueNow(comp.id, "wrapup");
      const n0 = smtp.messages.length;

      // The pass is held on its first send, and the process dies.
      try {
        await holdPassAtFirstSend(sa, [sean.email, sal.email]);
        await kill();
      } finally { smtp.release(); }
      const cut = sends(comp.id, "wrapup");
      expect(Object.values(cut), `PRECONDITION: one send in flight when the process died: ${JSON.stringify(cut)}`).toEqual(["sending"]);
      const first = Object.keys(cut)[0];
      expect([sean.email, sal.email]).toContain(first);
      const rest = first === sean.email ? sal.email : sean.email;
      expect(mailsTo(first, n0), "PRECONDITION: the relay had it, unanswered").toHaveLength(1);
      expect(job(comp.id, "wrapup"), "the job survives the crash").toBeTruthy();

      // The next start marks the cut send unknown, before any pass.
      await boot();
      expect(sends(comp.id, "wrapup"), "the cut send is unknown at the next start").toEqual({ [first]: "unknown" });
      await expect.poll(() => childOut, { timeout: 10000, message: "and the start says so" }).toContain("marked unknown (not retried)");
      const sa2 = await admin();
      await tick(sa2);
      expect(mailsTo(rest, n0), "the rest of the team is sent theirs").toHaveLength(1);
      expect(mailsTo(first, n0), "an unknown send is never sent again").toHaveLength(1);
      expect(sends(comp.id, "wrapup")).toEqual({ [first]: "unknown", [rest]: "sent" });
      expect(runs(comp.id, "wrapup"), "the run is recorded").toBe(1);
      expect(job(comp.id, "wrapup")).toBeUndefined();
    } finally { await restoreDomains(); }
  });
});
