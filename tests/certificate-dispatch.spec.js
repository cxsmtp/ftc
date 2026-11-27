"use strict";

// v8.15.1 — AUTOMATIC CERTIFICATES AND THE CONGRATULATIONS EMAIL, read off the wire.
//
// lib/certificate-dispatch.js issues every eligible participant's certificate
// when an event fully ends (a Program: when the participant completes) and sends
// ONE email per certificate with the PDF attached. This file spawns its OWN
// server against a REAL capturing relay (the shared test server's relay is dead
// by design, so nothing there can show what was delivered) and drives the worker
// through `POST /api/test/certificate-dispatch-tick` (it never runs by itself
// under NODE_ENV=test).
//
// What is pinned, each with its negative control:
//   * each end path — End Now, the scheduler's time expiry (and its first
//     sighting of an event or session already over, which also freezes the team
//     board), the all-solved auto-end — queues the event, and ONE pass mails each
//     eligible participant exactly once; a second pass mails nobody;
//   * the attachment is a PDF, and the copy follows the certificate's tier;
//   * not mailed: a member who never attempted, a benchmark-tagged participant,
//     a dry-run event, an event with the email switched off; an opted-out address
//     gets no mail but still gets its certificate;
//   * a revive and re-end never mails an existing certificate again, while a
//     participant who earned their first certificate after the revive is mailed;
//   * a Program completer is mailed at completion, with the completion copy;
//   * a pending job survives a restart, and a send cut by a crash is `unknown`;
//   * the admin certificate routes are scoped, and Resend really re-sends;
//   * the mail's PDF link carries `?from=email`, and a fetch through it is
//     recorded `via: "email_link"` (sweep #402);
//   * no issue stores the share image, and a server without its renderer
//     answers 503 for it unless an older certificate's stored copy exists
//     (sweep #43); an expired share link is deleted 30 days later (sweep #347).
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { PORT_BASE } = require("./helpers");
const { startSmtpCapture } = require("./smtp-capture");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = PORT_BASE + 198;
const BASE = `http://127.0.0.1:${PORT}`;

let smtp, child, childExit = null, dataDir, uploadsDir, superPass, childOut = "";

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
    const buf = Buffer.from(await r.arrayBuffer());
    const t = buf.toString("utf8");
    let body = t; try { body = JSON.parse(t); } catch (_) {}
    return { status: r.status, ok: r.status >= 200 && r.status < 300, body, text: t, buf, headers: r.headers };
  };
  return {
    get: (p, h) => call("GET", p, undefined, h),
    post: (p, d, h) => call("POST", p, d, h),
    put: (p, d, h) => call("PUT", p, d, h),
    patch: (p, d, h) => call("PATCH", p, d, h),
    del: (p, h) => call("DELETE", p, undefined, h),
    async h() { return { "x-csrf-token": (await call("GET", "/api/csrf-token")).body.csrfToken }; },
  };
}

function sql(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(path.join(dataDir, "hackathon.db"));
  try { return fn(db); } finally { db.close(); }
}

// `noRenderer`: the server stands for a deployment that has lost its renderer
// (tests/fixtures/no-badge-renderer.cjs makes `@resvg/resvg-js` unloadable).
async function boot({ noRenderer = false } = {}) {
  childOut = "";
  const preload = noRenderer ? ["-r", path.join(__dirname, "fixtures", "no-badge-renderer.cjs")] : [];
  child = spawn(process.execPath, [...preload, "server.js"], {
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
  // The port must be free before a respawn binds it.
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/healthz`); } catch (_) { return; }
    await new Promise(r => setTimeout(r, 100));
  }
}

test.beforeAll(async () => {
  smtp = await startSmtpCapture();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "certdisp-"));
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "certdisp-up-"));
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

/** A verified, approved participant, signed in through the emailed-code door. */
async function participant(tag) {
  const c = client();
  const s = stamp();
  const email = `${tag}-${s}@company.co`;
  const r = await registerVia(c, {
    firstName: "Cert", lastName: `Holder${tag}`, nickname: `${tag}${s}`.replace(/[^a-z0-9_]/gi, "").slice(0, 20),
    company: "Acme", title: "Eng", country: "US", timezone: "America/New_York", email,
  }, await c.h());
  expect(r.ok, `register ${tag}: ${r.status} ${r.text}`).toBeTruthy();
  const id = sql(db => db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email).id);
  sql(db => db.prepare("UPDATE users SET verified=1, approved=1 WHERE id=?").run(id));
  await c.post("/api/test/reset-recent-code-sends", {}, await c.h());
  const rq = await c.post("/api/auth/code/request", { email }, await c.h());
  expect(rq.ok, rq.text).toBeTruthy();
  const code = (await c.get(`/api/test/last-login-code?email=${encodeURIComponent(email)}`)).body.code;
  const rd = await c.post("/api/auth/code/redeem", { email, code }, await c.h());
  expect(rd.body && rd.body.ok, `sign in ${tag}: ${rd.text}`).toBe(true);
  return { c, email, id };
}

async function makeEvent(sa, { kind = "tournament", minutes = 600, startAgoMs = 10 * 60_000, tasks = 1, name = null } = {}) {
  const data = { name: name || `CertDisp ${kind} ${stamp()}`, event_kind: kind, start_time: new Date(Date.now() - startAgoMs).toISOString(), timezone: "UTC" };
  if (kind === "program") data.deadline_at = new Date(Date.now() + 90 * 86400e3).toISOString();
  else data.duration_minutes = minutes;
  const cr = await sa.post("/api/admin/competitions", data, await sa.h());
  expect(cr.ok, `create: ${cr.text}`).toBeTruthy();
  const comp = cr.body.competition;
  const taskIds = [];
  for (let i = 0; i < tasks; i++) {
    const tr = await sa.post("/api/admin/tasks", {
      title: `CD task ${stamp()}`, description: "<p>d</p>", difficulty: "easy",
      answer_type: "text", correct_answer: `right${i}`, status: "published",
    }, await sa.h());
    expect(tr.ok, tr.text).toBeTruthy();
    const a = await sa.post(`/api/admin/tasks/${tr.body.id}/competitions`, { competitionIds: [comp.id] }, await sa.h());
    expect(a.ok, a.text).toBeTruthy();
    // The event's OWN copy is the question it holds (lib/event-copies.js).
    taskIds.push(a.body.copies[0].task_id);
  }
  return { comp, taskIds };
}

async function assign(sa, compId, ps) {
  const r = await sa.post("/api/admin/competitions/assign", { userIds: ps.map(p => p.id), competitionIds: [compId] }, await sa.h());
  expect(r.ok, r.text).toBeTruthy();
  expect(r.body.assigned, `assigned ${JSON.stringify(r.body)}`).toBe(ps.length);
}

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
 * One status-scheduler pass, right after an end. The scheduler also runs by
 * itself every 60 s, and the pass that first sees the end queues the event's job
 * again (a new enqueued_at, last_error and passes reset): settling it first keeps
 * that pass from landing between a test's own passes and its reads.
 */
async function settleScheduler(sa) {
  const r = await sa.post("/api/test/scheduler-tick", {}, await sa.h());
  expect(r.ok, `scheduler tick: ${r.text}`).toBeTruthy();
}

async function tick(sa, force = true) {
  const r = await sa.post("/api/test/certificate-dispatch-tick", { force }, await sa.h());
  expect(r.ok, `tick: ${r.text}`).toBeTruthy();
  return r.body;
}

/** Captured congratulations emails to `email` (the registration's code mail excluded). */
function certMails(email) {
  return smtp.messages.filter(m => (m.rcptTo || []).some(a => a.toLowerCase() === email.toLowerCase())
    && /certificate/i.test(m.header("subject") || "") && !/sign-in code/i.test(m.header("subject") || ""));
}

/** MIME parts of a captured message, each {headers, body (decoded Buffer)}. */
function parts(raw) {
  const msg = raw.replace(/\r\n\.\./g, "\r\n.");
  const out = [];
  const walk = (chunk) => {
    const sep = chunk.indexOf("\r\n\r\n");
    if (sep < 0) return;
    const head = chunk.slice(0, sep), body = chunk.slice(sep + 4);
    const bm = head.match(/boundary="?([^";\r\n]+)"?/i);
    if (bm) { for (const sub of body.split("--" + bm[1]).slice(1)) if (!sub.startsWith("--")) walk(sub.replace(/^\r\n/, "")); return; }
    const cte = ((head.match(/content-transfer-encoding:\s*([\w-]+)/i) || [])[1] || "7bit").toLowerCase();
    let buf;
    if (cte === "base64") buf = Buffer.from(body.replace(/\s+/g, ""), "base64");
    else if (cte === "quoted-printable") buf = Buffer.from(body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
    else buf = Buffer.from(body, "utf8");
    out.push({ head, body: buf });
  };
  walk(msg);
  return out;
}
/** An RFC 2047 header decoded (nodemailer Q-encodes a non-ASCII subject). */
function decodeHeader(v) {
  return String(v || "").replace(/=\?UTF-8\?([QB])\?([^?]*)\?=\s*/gi, (_, enc, t) => enc.toUpperCase() === "B"
    ? Buffer.from(t, "base64").toString("utf8")
    : Buffer.from(t.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8"));
}
const textOf = (m) => parts(m.raw).filter(p => /content-type:\s*text\/plain/i.test(p.head)).map(p => p.body.toString("utf8")).join("\n");

const ledger = (compId) => sql(db => db.prepare("SELECT * FROM certificate_emails WHERE competition_id=?").all(compId));
const jobs = (compId) => sql(db => db.prepare("SELECT * FROM certificate_dispatch_jobs WHERE competition_id=?").all(compId));
const badges = (compId) => sql(db => db.prepare("SELECT * FROM achievement_badges WHERE competition_id=?").all(compId));

test.describe("v8.15.1 — certificates are issued and mailed at the end of an event", () => {
  test("End Now: each eligible participant is mailed once, with a PDF attached and copy for their tier; a re-run mails nobody", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa);
    const solvers = [await participant("gold"), await participant("silv"), await participant("bron")];
    const wrong = await participant("part");
    const idle = await participant("idle");
    const bench = await participant("bench");
    await assign(sa, comp.id, [...solvers, wrong, idle, bench]);
    const tg = await sa.post(`/api/admin/participants/${bench.id}/tags`, { tag: "benchmark" }, await sa.h());
    expect(tg.ok, tg.text).toBeTruthy();
    for (const p of solvers) expect((await play(p, comp.id, taskIds[0], "right0")).correct).toBe(true);
    expect((await play(wrong, comp.id, taskIds[0], "nope")).correct).toBe(false);
    await play(idle, comp.id, null);
    expect((await play(bench, comp.id, taskIds[0], "right0")).correct).toBe(true);

    expect(jobs(comp.id), "nothing is queued while the event runs").toEqual([]);
    const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h());
    expect(end.ok, end.text).toBeTruthy();
    expect(jobs(comp.id).map(j => j.reason), "End Now queued the event").toEqual(["ended"]);
    // The settle delay: an unforced pass right after the end does nothing.
    const early = await tick(sa, false);
    expect(early.sent, "the job waits out the settle delay").toBe(0);
    expect(jobs(comp.id)).toHaveLength(1);

    const out = await tick(sa);
    expect(out.sent, JSON.stringify(out)).toBe(4);
    expect(jobs(comp.id), "the job is done").toEqual([]);

    for (const p of [...solvers, wrong]) {
      await expect.poll(() => certMails(p.email).length, { message: `${p.email} got one mail`, timeout: 15000 }).toBe(1);
    }
    for (const p of [idle, bench]) expect(certMails(p.email), `${p.email} gets none`).toHaveLength(0);
    expect(badges(comp.id).map(b => b.user_id).sort(), "certificates issued to exactly the four").toEqual([...solvers, wrong].map(p => p.id).sort());

    // Tier copy, keyed on what the admin list says each one holds.
    const list = await sa.get(`/api/admin/competitions/${comp.id}/certificates`);
    expect(list.ok, list.text).toBeTruthy();
    const byUser = new Map(list.body.certificates.map(c => [c.userId, c]));
    expect([...solvers].map(p => byUser.get(p.id).tier).sort()).toEqual(["bronze", "gold", "silver"]);
    expect(byUser.get(wrong.id).tier).toBe("participation");
    for (const p of solvers) {
      const c = byUser.get(p.id);
      const txt = textOf(certMails(p.email)[0]);
      // Operator ruling, 29 Oct 2026 — warm copy, one paragraph per tier.
      expect(txt, `${c.tier}: the tier's own thank-you`).toContain(
        c.rank === 1 ? "you took 1st place in" : c.rank === 2 ? "Congratulations on finishing 2nd in" : "Congratulations on your 3rd place in");
      expect(txt, "the post button is offered").toContain("Copy my LinkedIn post");
      expect(txt).toContain(comp.name);
      expect(c.emailStatus.status).toBe("sent");
    }
    expect(textOf(certMails(wrong.email)[0]), "participation copy").toContain("Thank you for taking part");
    expect(textOf(certMails(wrong.email)[0]), "…and no placing").not.toMatch(/1st place|finishing 2nd|3rd place/);

    // The attachment is a PDF.
    const m = certMails(solvers[0].email)[0];
    expect(decodeHeader(m.header("subject")), "the subject keeps the platform prefix and names the event")
      .toMatch(new RegExp(` — Your certificate for ${comp.name}$`));
    expect(m.header("list-unsubscribe"), "bulk-optional: carries List-Unsubscribe").toBeTruthy();
    const pdf = parts(m.raw).find(p => /content-type:\s*application\/pdf/i.test(p.head));
    expect(pdf, "a PDF part is attached").toBeTruthy();
    expect(pdf.head).toMatch(/content-disposition:\s*attachment/i);
    expect(pdf.body.slice(0, 5).toString("latin1")).toBe("%PDF-");

    // Audited per recipient.
    const ev = sql(db => db.prepare("SELECT changed_by, details FROM user_events WHERE user_id=? AND event_type='certificate_emailed'").all(solvers[0].id));
    expect(ev).toHaveLength(1);
    expect(ev[0].changed_by).toBe("system");
    expect(JSON.parse(ev[0].details)).toMatchObject({ competition_id: comp.id, status: "sent", via: "automatic" });

    // A second pass mails nobody. (The second End Now is refused, 400: the event
    // already ended by hand, so it queues nothing; the idempotent close serves
    // only an event ended by time with no stamp.)
    await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h());
    const again = await tick(sa);
    expect(again.sent, "nothing is mailed twice").toBe(0);
    for (const p of [...solvers, wrong]) expect(certMails(p.email)).toHaveLength(1);

    // REVIVE, a new participant earns a certificate, RE-END: only they are mailed.
    const late = await participant("after");
    const put = await sa.put(`/api/admin/competitions/${comp.id}`, { duration_minutes: 900 }, await sa.h());
    expect(put.ok, `revive: ${put.text}`).toBeTruthy();
    expect(put.body.competition.status, "revived").toBe("live");
    await assign(sa, comp.id, [late]);
    expect((await play(late, comp.id, taskIds[0], "nope")).correct).toBe(false);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    const re = await tick(sa);
    expect(re.sent, JSON.stringify(re)).toBe(1);
    await expect.poll(() => certMails(late.email).length, { timeout: 15000 }).toBe(1);
    for (const p of [...solvers, wrong]) expect(certMails(p.email), "a held certificate is never mailed again").toHaveLength(1);
  });

  test("an event revived before its job runs mails nobody, not even a certificate already collected; its next end does", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa);
    const p = await participant("revived");
    await assign(sa, comp.id, [p]);
    // A wrong answer: attempted (a certificate), and nothing ends the event early.
    expect((await play(p, comp.id, taskIds[0], "nope")).correct).toBe(false);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    // The participant collects their certificate in the settle window…
    const mint = await p.c.post(`/api/competitions/${comp.id}/badge`, {}, await p.c.h());
    expect(mint.ok, mint.text).toBeTruthy();
    // …and the organiser revives the event before the job runs.
    const put = await sa.put(`/api/admin/competitions/${comp.id}`, { duration_minutes: 900 }, await sa.h());
    expect(put.ok, put.text).toBeTruthy();
    expect(put.body.competition.status).toBe("live");
    expect(jobs(comp.id), "the job is still queued").toHaveLength(1);
    const r = await tick(sa);
    expect(r.sent, `a live event mails nothing: ${JSON.stringify(r)}`).toBe(0);
    expect(jobs(comp.id), "the revived event's job is dropped").toEqual([]);
    expect(certMails(p.email)).toHaveLength(0);
    // Its next end mails the held certificate, once.
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    expect((await tick(sa)).sent).toBe(1);
    await expect.poll(() => certMails(p.email).length, { timeout: 15000 }).toBe(1);
    expect(badges(comp.id).map(b => b.token), "the collected certificate is the one mailed").toEqual([mint.body.token]);
  });

  test("a late entrant who joins after the first pass is issued and mailed when the late window lapses by itself", async () => {
    // A Booth Event takes late entrants for 48 h after its end. The first pass
    // (5 minutes after the end) issues everyone who played; somebody who joins
    // later, or first answers later, is issued only by the SAME job's next pass,
    // when the window closes. Before 9.1.5 the job was dropped after a pass that
    // found no late entrant waiting, and a window that lapses by itself is no end
    // path, so nothing ever issued them.
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { kind: "booth" });
    const early = await participant("ontime");
    await assign(sa, comp.id, [early]);
    expect((await play(early, comp.id, taskIds[0], "right0")).correct).toBe(true);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    const first = await tick(sa);
    expect(first.issued, `the first pass issues the participant who played: ${JSON.stringify(first)}`).toBeGreaterThanOrEqual(1);
    await expect.poll(() => certMails(early.email).length, { timeout: 15000 }).toBe(1);
    const kept = jobs(comp.id);
    expect(kept, "the job waits for the late window, though no late entrant was waiting on this pass").toHaveLength(1);
    expect(kept[0].reason).toBe("late_entry_pending");

    // Somebody joins in the late window, after that pass, and plays.
    const late = await participant("latejoin");
    await assign(sa, comp.id, [late]);
    expect((await play(late, comp.id, taskIds[0], "right0")).correct).toBe(true);
    // The window then lapses by itself: its deadline is moved into the past
    // (still after the end), as time would; no end path runs.
    sql(db => {
      const c = db.prepare("SELECT ended_at FROM competitions WHERE id=?").get(comp.id);
      db.prepare("UPDATE competitions SET late_entry_deadline_at=? WHERE id=?").run(new Date(Date.parse(c.ended_at) + 1000).toISOString(), comp.id);
    });
    // The competition read is cached for 1 s and a direct write busts nothing.
    await new Promise(r => setTimeout(r, 1200));
    const second = await tick(sa);
    expect(second.issued, `the pass after the window issues the late entrant: ${JSON.stringify(second)}`).toBe(1);
    await expect.poll(() => certMails(late.email).length, { timeout: 15000 }).toBe(1);
    expect(certMails(early.email), "nobody is mailed twice").toHaveLength(1);
    expect(badges(comp.id).length, "one certificate each").toBe(2);
    expect(jobs(comp.id), "and the job is done once the window has closed").toEqual([]);
  });

  test("a pass over N participants builds the event's board a bounded number of times, whatever N is", async () => {
    // 3000-person events: a fresh board per participant made one pass O(n²).
    // The job builds each board it needs ONCE (main + late for the one slot here)
    // and every participant's eligibility reads it. `boardBuilds` counts the
    // board COMPUTATIONS lib/leaderboard made for the event during the pass.
    const sa = await admin();
    const N = 8;
    const { comp, taskIds } = await makeEvent(sa);
    const ps = [];
    for (let i = 0; i < N; i++) ps.push(await participant(`n${i}`));
    await assign(sa, comp.id, ps);
    for (const p of ps) expect((await play(p, comp.id, taskIds[0], "nope")).correct).toBe(false);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    const out = await tick(sa);
    expect(out.sent, JSON.stringify(out)).toBe(N);
    expect(out.issued, "every one was MINTED in this pass, so every one asked for eligibility").toBe(N);
    expect(out.boardBuilds, "the counter sees the builds (anti-vacuity)").toBeGreaterThanOrEqual(1);
    expect(out.boardBuilds, `one main + one late board for the slot, not one per participant: ${JSON.stringify(out)}`).toBeLessThanOrEqual(2);
  });

  test("time expiry: the scheduler's tick queues the event; mailed once", async () => {
    const sa = await admin();
    // Ends ~15 s from now.
    const { comp, taskIds } = await makeEvent(sa, { minutes: 10, startAgoMs: 10 * 60_000 - 15_000 });
    const p = await participant("expiry");
    await assign(sa, comp.id, [p]);
    expect((await play(p, comp.id, taskIds[0], "nope")).correct).toBe(false);
    await sa.post("/api/test/scheduler-tick", {}, await sa.h());   // observed live
    const endsAt = new Date(comp.start_time).getTime() + 10 * 60_000;
    await expect.poll(() => Date.now() > endsAt + 1000, { timeout: 30000, message: "the schedule ran out" }).toBe(true);
    // Time expiry writes no end transaction: the scheduler's tick is what notices it.
    await sa.post("/api/test/scheduler-tick", {}, await sa.h());
    expect(jobs(comp.id).map(j => j.reason)).toEqual(["ended"]);
    expect((await tick(sa)).sent).toBe(1);
    await expect.poll(() => certMails(p.email).length, { timeout: 15000 }).toBe(1);
    await sa.post("/api/test/scheduler-tick", {}, await sa.h());
    expect((await tick(sa)).sent, "a later tick mails nobody").toBe(0);
    expect(certMails(p.email)).toHaveLength(1);
  });

  test("an event the scheduler first sees already ended (a restart, an event created in the past) has its team board frozen and its certificates queued", async () => {
    const sa = await admin();
    // Three events, each made never-observed by hand (no status row, no job, no
    // snapshot), as after a restart against an existing database:
    //   A: sessionless, its schedule over (the competition arm);
    //   B: one session, over (the session arm);
    //   C: CONTROL, upcoming (first seen, nothing to freeze or queue).
    const { comp: A } = await makeEvent(sa, { minutes: 60, startAgoMs: 2 * 3600e3, tasks: 0 });
    const { comp: B } = await makeEvent(sa, { tasks: 0 });
    const { comp: C } = await makeEvent(sa, { startAgoMs: -2 * 3600e3, tasks: 0 });
    const slotId = `ts-first-${stamp()}`;
    sql(db => {
      db.prepare("INSERT INTO competition_timeslots (id, competition_id, name, start_time, duration_minutes, created_at) VALUES (?,?,?,?,?,?)")
        .run(slotId, B.id, "Morning", new Date(Date.now() - 2 * 3600e3).toISOString(), 60, new Date().toISOString());
      for (const id of [A.id, B.id, C.id]) {
        db.prepare("UPDATE competitions SET group_leaderboard_enabled=1 WHERE id=?").run(id);
        db.prepare("DELETE FROM entity_status_observations WHERE entity_id IN (?, ?)").run(id, slotId);
        db.prepare("DELETE FROM certificate_dispatch_jobs WHERE competition_id=?").run(id);
        db.prepare("DELETE FROM group_leaderboard_snapshots WHERE competition_id=?").run(id);
      }
    });
    const obs = (type, id) => sql(db => db.prepare("SELECT last_status FROM entity_status_observations WHERE entity_type=? AND entity_id=?").get(type, id)?.last_status ?? null);
    const snaps = (id) => sql(db => db.prepare("SELECT COUNT(*) AS n FROM group_leaderboard_snapshots WHERE competition_id=?").get(id).n);
    for (const [type, id] of [["competition", A.id], ["timeslot", slotId], ["competition", C.id]]) {
      expect(obs(type, id), `PRECONDITION: ${type} ${id} never observed`).toBeNull();
    }
    expect([jobs(A.id).length, jobs(B.id).length, snaps(A.id), snaps(B.id)], "PRECONDITION: nothing queued or frozen").toEqual([0, 0, 0, 0]);
    // Any tick from here on (the explicit one, or the background one landing
    // first) takes the first-sighting arm, so the result cannot depend on which.
    await settleScheduler(sa);
    expect(obs("competition", A.id), "A is recorded as ended").toBe("ended");
    expect(jobs(A.id).map(j => j.reason), "A's certificates are queued").toEqual(["ended"]);
    expect(snaps(A.id), "A's team board is frozen").toBeGreaterThan(0);
    expect(obs("timeslot", slotId), "B's session is recorded as ended").toBe("ended");
    expect(jobs(B.id).map(j => j.reason), "B's certificates are queued").toEqual(["ended"]);
    expect(snaps(B.id), "B's team board is frozen").toBeGreaterThan(0);
    expect(obs("competition", C.id), "CONTROL: C is recorded as upcoming").toBe("upcoming");
    expect([jobs(C.id).length, snaps(C.id)], "CONTROL: nothing queued or frozen for an event not over").toEqual([0, 0]);
  });

  test("the all-solved auto-end queues the event; the solver is mailed once", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa);
    const p = await participant("allsolved");
    await assign(sa, comp.id, [p]);
    expect((await play(p, comp.id, taskIds[0], "right0")).correct).toBe(true);
    await expect.poll(() => sql(db => db.prepare("SELECT ended_at FROM competitions WHERE id=?").get(comp.id).ended_at),
      { message: "the solve ended the event" }).toBeTruthy();
    expect(jobs(comp.id).map(j => j.reason)).toEqual(["ended"]);
    expect((await tick(sa)).sent).toBe(1);
    await expect.poll(() => certMails(p.email).length, { timeout: 15000 }).toBe(1);
    expect(textOf(certMails(p.email)[0])).toContain("you took 1st place in");
  });

  test("an opted-out address gets no mail but keeps its certificate; a dry-run event and a switched-off event get neither", async () => {
    const sa = await admin();
    // Opted out.
    const a = await makeEvent(sa);
    const out = await participant("optout");
    await assign(sa, a.comp.id, [out]);
    await play(out, a.comp.id, a.taskIds[0], "nope");
    sql(db => db.prepare("INSERT INTO unsubscribed_emails (email, unsubscribed_at) VALUES (?, ?)").run(out.email.toLowerCase(), new Date().toISOString()));
    await sa.post(`/api/admin/competitions/${a.comp.id}/end-now`, {}, await sa.h());
    const r1 = await tick(sa);
    expect(r1.suppressed, JSON.stringify(r1)).toBe(1);
    expect(certMails(out.email)).toHaveLength(0);
    expect(badges(a.comp.id), "the certificate is still issued").toHaveLength(1);
    expect(ledger(a.comp.id).map(l => l.status)).toEqual(["suppressed"]);
    expect(sql(db => db.prepare("SELECT COUNT(*) n FROM certificate_share_links WHERE badge_token=?").get(badges(a.comp.id)[0].token).n),
      "no mail, so no live share link either").toBe(0);

    // Dry run.
    const b = await makeEvent(sa);
    const dry = await participant("dry");
    await assign(sa, b.comp.id, [dry]);
    await play(dry, b.comp.id, b.taskIds[0], "nope");
    expect((await sa.post(`/api/admin/competitions/${b.comp.id}/tags`, { tag: "test/dry run" }, await sa.h())).ok).toBeTruthy();
    await sa.post(`/api/admin/competitions/${b.comp.id}/end-now`, {}, await sa.h());
    // Switched off.
    const c = await makeEvent(sa);
    const off = await participant("off");
    await assign(sa, c.comp.id, [off]);
    await play(off, c.comp.id, c.taskIds[0], "nope");
    const cfg = await sa.put(`/api/admin/competitions/${c.comp.id}/certificate-config`, { config: { email: { enabled: false } } }, await sa.h());
    expect(cfg.ok, cfg.text).toBeTruthy();
    expect(cfg.body.effective.email.enabled).toBe(false);
    await sa.post(`/api/admin/competitions/${c.comp.id}/end-now`, {}, await sa.h());
    // CONTROL: both were really queued, so the drop is the dispatcher's decision.
    expect(jobs(b.comp.id)).toHaveLength(1);
    expect(jobs(c.comp.id)).toHaveLength(1);
    await tick(sa);
    expect(jobs(b.comp.id)).toEqual([]);
    expect(jobs(c.comp.id)).toEqual([]);
    for (const [p, cid] of [[dry, b.comp.id], [off, c.comp.id]]) {
      expect(certMails(p.email), `${p.email}: no mail`).toHaveLength(0);
      expect(badges(cid), `${p.email}: nothing minted on their behalf`).toHaveLength(0);
    }
  });

  test("a Program completer is mailed at completion, with the completion copy", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { kind: "program", tasks: 2 });
    const p = await participant("prog");
    await assign(sa, comp.id, [p]);
    expect((await play(p, comp.id, taskIds[0], "right0")).correct).toBe(true);
    expect(jobs(comp.id), "half done: nothing queued").toEqual([]);
    expect((await play(p, comp.id, taskIds[1], "right1")).correct).toBe(true);
    expect(jobs(comp.id).map(j => [j.user_id, j.reason])).toEqual([[p.id, "completed"]]);
    expect((await tick(sa)).sent).toBe(1);
    await expect.poll(() => certMails(p.email).length, { timeout: 15000 }).toBe(1);
    expect(textOf(certMails(p.email)[0])).toContain("Congratulations on completing");
    expect(badges(comp.id).map(b => b.basis)).toEqual(["completion"]);
  });

  test("a Program learner completed by an organiser's edit is queued and mailed: a hidden challenge, an unassigned one", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { kind: "program", tasks: 3 });
    const both = await participant("two");
    const one = await participant("one");
    const idle = await participant("none");
    const past = await participant("past");
    await assign(sa, comp.id, [both, one, idle, past]);
    expect((await play(both, comp.id, taskIds[0], "right0")).correct).toBe(true);
    expect((await play(both, comp.id, taskIds[1], "right1")).correct).toBe(true);
    expect((await play(one, comp.id, taskIds[0], "right0")).correct).toBe(true);
    await play(idle, comp.id, null);
    // A learner who completed earlier but was never issued (before automatic
    // issue, or while the design's email was off): their job is gone. No edit
    // completes them, so none may mail them.
    for (const i of [0, 1, 2]) expect((await play(past, comp.id, taskIds[i], `right${i}`)).correct).toBe(true);
    sql(db => db.prepare("DELETE FROM certificate_dispatch_jobs WHERE competition_id=? AND user_id=?").run(comp.id, past.id));
    expect(jobs(comp.id), "PRECONDITION: nobody queued").toEqual([]);

    // Hiding the third challenge completes the learner who solved the other two.
    const hide = await sa.patch(`/api/admin/tasks/${taskIds[2]}/visibility`, {}, await sa.h());
    expect(hide.ok && hide.body.active === 0, hide.text).toBe(true);
    expect(jobs(comp.id).map(j => [j.user_id, j.reason]), "hiding queued exactly the learner it completed").toEqual([[both.id, "completed"]]);
    // Taking the second out of the event completes the learner who solved the first.
    const un = await sa.del(`/api/admin/tasks/${taskIds[1]}/competitions/${comp.id}`, await sa.h());
    expect(un.ok, un.text).toBeTruthy();
    expect(jobs(comp.id).map(j => j.user_id).sort(), "unassigning queued the learner it completed").toEqual([both.id, one.id].sort());

    expect((await tick(sa)).sent).toBe(2);
    for (const p of [both, one]) await expect.poll(() => certMails(p.email).length, { message: `${p.email} mailed`, timeout: 15000 }).toBe(1);
    expect(certMails(idle.email), "a learner who solved nothing is never queued").toHaveLength(0);
    expect(certMails(past.email), "a learner complete before the edits is never mailed by them").toHaveLength(0);
    expect(badges(comp.id).map(b => b.basis)).toEqual(["completion", "completion"]);
  });

  test("an issue that keeps failing stops being retried, and the job then waits for the late window's close instead of closing early", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 2 });
    const ok = await participant("bok");
    const bad = await participant("bbad");
    await assign(sa, comp.id, [ok, bad]);
    for (const p of [ok, bad]) expect((await play(p, comp.id, taskIds[0], "right0")).correct).toBe(true);
    sql(db => db.exec(`CREATE TRIGGER t_issue_always BEFORE INSERT ON achievement_badges
      WHEN NEW.user_id='${bad.id}' BEGIN SELECT RAISE(ABORT, 'test: permanent write failure'); END;`));
    try {
      const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h());
      expect(end.ok, end.text).toBeTruthy();
      await settleScheduler(sa);
      for (let i = 1; i <= 12; i++) {
        await tick(sa);
        expect(jobs(comp.id).map(j => j.last_error), `pass ${i}: retried soon`).toEqual([`issue_failed:${i}`]);
      }
      await tick(sa);
      const kept = jobs(comp.id);
      expect(kept.map(j => j.reason), "the job carries on into the late window's wait, never dropped").toEqual(["late_entry_pending"]);
      expect(Date.parse(kept[0].due_at), "due after the window's close").toBeGreaterThan(Date.now() + 47 * 3600e3);
      expect(badges(comp.id).map(b => b.user_id), "the other participant was issued").toEqual([ok.id]);
    } finally {
      sql(db => db.exec("DROP TRIGGER IF EXISTS t_issue_always"));
    }
    // Leave nobody unissued: a forced pass serves every event's jobs, and a
    // restart's first scheduler pass queues an ended event again.
    await tick(sa);
    expect(badges(comp.id).map(b => b.user_id).sort(), "once the write works, the waiting job issues them").toEqual([ok.id, bad.id].sort());
    sql(db => db.prepare("DELETE FROM certificate_dispatch_jobs WHERE competition_id=?").run(comp.id));
  });

  test("a participant whose issue fails is retried by a later pass, never lost when the job closes", async () => {
    const sa = await admin();
    // Two challenges, one solved by each: nobody finishes, so no all-solved end.
    const { comp, taskIds } = await makeEvent(sa, { tasks: 2 });
    const ok = await participant("okay");
    const flaky = await participant("flaky");
    await assign(sa, comp.id, [ok, flaky]);
    for (const p of [ok, flaky]) expect((await play(p, comp.id, taskIds[0], "right0")).correct).toBe(true);
    // One participant's certificate write fails, as a write lock another process
    // holds past busy_timeout makes it fail: not the renderer, so not that branch.
    sql(db => db.exec(`CREATE TRIGGER t_issue_fails BEFORE INSERT ON achievement_badges
      WHEN NEW.user_id='${flaky.id}' BEGIN SELECT RAISE(ABORT, 'test: transient write failure'); END;`));
    try {
      const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h());
      expect(end.ok, end.text).toBeTruthy();
      await settleScheduler(sa);
      await tick(sa);
      // This event's own rows: a forced pass serves every event's jobs.
      expect(badges(comp.id).map(b => b.user_id), "PRECONDITION: the write failed for one participant only").toEqual([ok.id]);
      const kept = jobs(comp.id);
      expect(kept.map(j => j.last_error), "the job is kept for a later pass").toEqual(["issue_failed:1"]);
    } finally {
      sql(db => db.exec("DROP TRIGGER IF EXISTS t_issue_fails"));
    }
    await tick(sa);
    expect(badges(comp.id).map(b => b.user_id).sort(), "the retry issued the participant whose write failed").toEqual([ok.id, flaky.id].sort());
    expect(jobs(comp.id), "the job is done").toEqual([]);
    await expect.poll(() => certMails(flaky.email).length, { message: "the retried participant is mailed", timeout: 15000 }).toBe(1);
    expect(certMails(ok.email), "the participant issued on the first pass is mailed once").toHaveLength(1);
  });

  // Operator ruling, 29 Oct 2026 — the mail's "Copy my LinkedIn post" link: a
  // ONE-TIME, short-lived capability bound to one certificate. Viewing it (GET)
  // consumes nothing (mail scanners fetch every link); the page's POST consumes it
  // once and is the holder's publish-on-share.
  test("the LinkedIn share link: shows the post, works once, expires, is bound to its certificate", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { tasks: 2 });
    const [g, s, b] = [await participant("shg"), await participant("shs"), await participant("shb")];
    await assign(sa, comp.id, [g, s, b]);
    // An organiser, so the post names them.
    const org = await participant("org");
    const grant = await sa.post(`/api/admin/competitions/${comp.id}/admins`, { userId: org.id }, await sa.h());
    expect(grant.ok, grant.text).toBeTruthy();
    // g solves both (100), s one (50), b one and a wrong answer (45), so b is
    // third with points above zero, which Bronze needs (operator ruling, 14 Nov
    // 2026); s and b leaving one unsolved keeps the event from auto-ending.
    expect((await play(g, comp.id, taskIds[0], "right0")).correct).toBe(true);
    expect((await play(g, comp.id, taskIds[1], "right1")).correct).toBe(true);
    expect((await play(s, comp.id, taskIds[0], "right0")).correct).toBe(true);
    expect((await play(b, comp.id, taskIds[0], "right0")).correct).toBe(true);
    expect((await play(b, comp.id, taskIds[1], "nope")).correct).toBe(false);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    await tick(sa);
    for (const p of [g, s, b]) await expect.poll(() => certMails(p.email).length, { timeout: 15000 }).toBe(1);
    const linkOf = (p) => {
      const m = textOf(certMails(p.email)[0]).match(/\/badge\/([A-Za-z0-9_-]{43})\/post/);
      expect(m, `${p.email}: the mail carries a share link`).toBeTruthy();
      return m[1];
    };
    const gl = linkOf(g), sl = linkOf(s), bl = linkOf(b);
    const tokOf = (p) => sql(db => db.prepare("SELECT token, shared_at, public_code FROM achievement_badges WHERE user_id=? AND competition_id=?").get(p.id, comp.id));
    // Stored hashed and bound: the plaintext is nowhere in the table, and the row
    // names THIS holder's certificate.
    const rows = sql(db => db.prepare("SELECT * FROM certificate_share_links").all());
    expect(JSON.stringify(rows), "the link is stored only as a hash").not.toContain(gl);
    const crypto = require("crypto");
    const row = rows.find(r => r.id_hash === crypto.createHash("sha256").update(gl).digest("hex"));
    expect(row && row.badge_token, "bound to the holder's certificate").toBe(tokOf(g).token);

    // GET shows the post and consumes nothing — twice.
    const anon = client();
    for (let i = 0; i < 2; i++) {
      const page = await anon.get(`/badge/${gl}/post`);
      expect(page.status, page.text.slice(0, 200)).toBe(200);
      expect(page.text).toContain(`Proud to have earned 🥇 1st Place at ${comp.name}, hosted by @Checkmarx with Cert Holderorg!`);
      expect(page.text).toContain(`/credential?code=${tokOf(g).public_code}`);
      expect(page.text).toContain("Copy post &amp; open LinkedIn");
      expect(page.headers.get("cache-control")).toContain("no-store");
    }
    expect(tokOf(g).shared_at, "viewing does not publish").toBeNull();
    expect(sql(db => db.prepare("SELECT used_at FROM certificate_share_links WHERE badge_token=?").get(tokOf(g).token)).used_at).toBeNull();

    // The page's own POST: consumes once, publishes once.
    const page = await anon.get(`/badge/${gl}/post`);
    const csrf = page.text.match(/data-csrf="([^"]+)"/)[1];
    const use1 = await anon.post(`/badge/${gl}/post`, {}, { "x-csrf-token": csrf });
    expect(use1.status).toBe(200);
    expect(use1.body.ok, use1.text).toBe(true);
    expect(use1.body.composerUrl).toMatch(/^https:\/\/www\.linkedin\.com\/feed\/\?shareActive=true&text=Proud/);
    expect(tokOf(g).shared_at, "the share published the page").toBeTruthy();
    const use2 = await anon.post(`/badge/${gl}/post`, {}, { "x-csrf-token": csrf });
    expect(use2.body, "a second use is refused").toMatchObject({ ok: false, reason: "used" });
    const spent = await anon.get(`/badge/${gl}/post`);
    expect(spent.status).toBe(410);
    expect(spent.text).toContain("already been used");
    expect(spent.text, "a spent link shows no post").not.toContain("Proud to have earned");

    // Expired: refused, nothing published.
    sql(db => db.prepare("UPDATE certificate_share_links SET expires_at=? WHERE badge_token=?").run(new Date(Date.now() - 1000).toISOString(), tokOf(s).token));
    const sp = await anon.get(`/badge/${sl}/post`);
    expect(sp.status).toBe(410);
    expect(sp.text).toContain("expired");
    const se = await anon.post(`/badge/${sl}/post`, {}, { "x-csrf-token": csrf });
    expect(se.body).toMatchObject({ ok: false, reason: "expired" });
    expect(tokOf(s).shared_at).toBeNull();

    // Bound: revoking the certificate kills its link; a made-up link is a 404.
    const bp = await anon.get(`/badge/${bl}/post`);
    expect(bp.status, "CONTROL: live before the revoke").toBe(200);
    expect(bp.text, "the bronze wording").toContain("Proud to have earned 🥉 3rd Place");
    sql(db => db.prepare("UPDATE achievement_badges SET revoked_at=? WHERE token=?").run(new Date().toISOString(), tokOf(b).token));
    expect((await anon.get(`/badge/${bl}/post`)).status).toBe(404);
    expect((await anon.get(`/badge/${"A".repeat(43)}/post`)).status).toBe(404);
    expect((await anon.get(`/badge/short/post`)).status).toBe(404);
  });

  test("the admin certificate routes are scoped; an organiser downloads and re-sends", async () => {
    const sa = await admin();
    const mine = await makeEvent(sa);
    const other = await makeEvent(sa);
    const p = await participant("scoped");
    const q = await participant("scoped2");
    await assign(sa, mine.comp.id, [p]);
    await assign(sa, other.comp.id, [q]);
    await play(p, mine.comp.id, mine.taskIds[0], "nope");
    await play(q, other.comp.id, other.taskIds[0], "nope");
    for (const e of [mine, other]) await sa.post(`/api/admin/competitions/${e.comp.id}/end-now`, {}, await sa.h());
    await tick(sa);
    await expect.poll(() => certMails(p.email).length, { timeout: 15000 }).toBe(1);

    // An event admin of `mine` only.
    const org = await participant("org");
    const g = await sa.post(`/api/admin/competitions/${mine.comp.id}/admins`, { userId: org.id }, await sa.h());
    expect(g.ok, g.text).toBeTruthy();
    const oc = client();
    await oc.post("/api/test/reset-recent-code-sends", {}, await oc.h());
    await oc.post("/api/auth/code/request", { email: org.email }, await oc.h());
    const code = (await oc.get(`/api/test/last-login-code?email=${encodeURIComponent(org.email)}`)).body.code;
    expect((await oc.post("/api/auth/code/redeem", { email: org.email, code }, await oc.h())).body.ok).toBe(true);

    const own = await oc.get(`/api/admin/competitions/${mine.comp.id}/certificates`);
    expect(own.status, own.text).toBe(200);
    expect(own.body.certificates.map(c => c.userId)).toEqual([p.id]);
    expect(own.body.certificates[0].token, "the capability token is superadmin-only").toBeUndefined();
    const saRow = (await sa.get(`/api/admin/competitions/${mine.comp.id}/certificates`)).body.certificates[0];
    expect(saRow.token).toBeTruthy();
    // The credential code beside its holder is for whoever may look a
    // certificate up by its code (sweep #403): the superadmin, not an organiser.
    const dbCode = sql(db => db.prepare("SELECT public_code FROM achievement_badges WHERE competition_id=? AND user_id=?").get(mine.comp.id, p.id).public_code);
    expect(dbCode, "PRECONDITION: the certificate has a credential code").toMatch(/^[0-9A-Z]{12}$/);
    expect(String(saRow.code).replace(/-/g, ""), "CONTROL: the superadmin's row carries the code").toBe(dbCode);
    expect(own.body.certificates[0].code, "an event admin's row carries no credential code").toBeUndefined();
    expect(own.text, "…anywhere in the answer").not.toContain(dbCode.slice(0, 4) + "-" + dbCode.slice(4, 8));
    for (const path_ of [`/api/admin/competitions/${other.comp.id}/certificates`,
      `/api/admin/competitions/${other.comp.id}/certificates/${q.id}/certificate.pdf`,
      `/api/admin/competitions/${other.comp.id}/certificates/${q.id}/badge.png`]) {
      const r = await oc.get(path_);
      expect(r.status, `${path_}: out of scope`).toBe(403);
      expect(r.text, "no certificate bytes leak").not.toContain("%PDF");
    }
    const rs0 = await oc.post(`/api/admin/competitions/${other.comp.id}/certificates/resend`, { userId: q.id }, await oc.h());
    expect(rs0.status).toBe(403);
    // A participant reaches none of it.
    expect((await p.c.get(`/api/admin/competitions/${mine.comp.id}/certificates`)).status).toBeGreaterThanOrEqual(401);

    // In scope: the PDF downloads, audited as not the owner.
    const pdf = await oc.get(`/api/admin/competitions/${mine.comp.id}/certificates/${p.id}/certificate.pdf`);
    expect(pdf.status, pdf.text.slice(0, 200)).toBe(200);
    expect(pdf.headers.get("content-type")).toMatch(/application\/pdf/);
    expect(pdf.buf.slice(0, 5).toString("latin1")).toBe("%PDF-");
    const dl = sql(db => db.prepare("SELECT changed_by, details FROM competition_events WHERE competition_id=? AND event_type='badge_certificate_downloaded'").all(mine.comp.id));
    expect(dl.map(d => JSON.parse(d.details).by_owner)).toEqual([false]);
    expect(dl[0].changed_by.toLowerCase()).toBe(org.email.toLowerCase());
    expect((await oc.get(`/api/admin/competitions/${mine.comp.id}/certificates/${org.id}/certificate.pdf`)).status, "no certificate: 404").toBe(404);

    // Resend really re-sends, and is recorded with the organiser as the actor.
    const rs = await oc.post(`/api/admin/competitions/${mine.comp.id}/certificates/resend`, { userId: p.id }, await oc.h());
    expect(rs.status, rs.text).toBe(200);
    expect(rs.body).toMatchObject({ ok: true, status: "sent" });
    await expect.poll(() => certMails(p.email).length, { timeout: 15000 }).toBe(2);
    expect(ledger(mine.comp.id)[0]).toMatchObject({ status: "sent", attempts: 2 });
    const evs = sql(db => db.prepare("SELECT changed_by, details FROM user_events WHERE user_id=? AND event_type='certificate_emailed' ORDER BY changed_at").all(p.id));
    expect(evs.map(e => JSON.parse(e.details).via)).toEqual(["automatic", "resend"]);
    expect(evs[1].changed_by.toLowerCase()).toBe(org.email.toLowerCase());
    expect(JSON.parse(evs[1].details).ip, "the request context rides the resend").toBeTruthy();
    expect((await oc.post(`/api/admin/competitions/${mine.comp.id}/certificates/resend`, {}, await oc.h())).status).toBe(400);
  });

  test("a pending job survives a restart; a send cut by a crash is marked unknown, never retried", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa);
    const p = await participant("restart");
    await assign(sa, comp.id, [p]);
    await play(p, comp.id, taskIds[0], "nope");
    await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h());
    expect(jobs(comp.id)).toHaveLength(1);
    // A second event whose send was "in flight" when the process died.
    const cut = await makeEvent(sa);
    const q = await participant("cut");
    await assign(sa, cut.comp.id, [q]);
    await play(q, cut.comp.id, cut.taskIds[0], "nope");
    const mint = await q.c.post(`/api/competitions/${cut.comp.id}/badge`, {}, { ...(await q.c.h()) });
    // The event is still live: mint refuses, so build the held certificate the honest way after an end.
    expect(mint.status).toBe(409);
    await sa.post(`/api/admin/competitions/${cut.comp.id}/end-now`, {}, await sa.h());
    const m2 = await q.c.post(`/api/competitions/${cut.comp.id}/badge`, {}, await q.c.h());
    expect(m2.ok, m2.text).toBeTruthy();
    sql(db => {
      const t = new Date().toISOString();
      db.prepare("INSERT INTO certificate_emails (badge_token, user_id, competition_id, status, attempts, first_attempt_at, updated_at) VALUES (?,?,?,'sending',1,?,?)")
        .run(m2.body.token, q.id, cut.comp.id, t, t);
    });

    await kill();
    await boot();
    const sa2 = await admin();
    expect(ledger(cut.comp.id).map(l => l.status), "the cut send is unknown after the restart").toEqual(["unknown"]);
    expect(jobs(comp.id), "the pending job is still there").toHaveLength(1);
    const r = await tick(sa2);
    expect(r.sent, JSON.stringify(r)).toBe(1);
    await expect.poll(() => certMails(p.email).length, { timeout: 15000 }).toBe(1);
    expect(certMails(q.email), "an unknown send is not retried").toHaveLength(0);
  });
});

// ISSUE AGAIN (operator ruling, 17 Nov 2026, "Warn + allow re-issue"): a revive
// leaves issued certificates as issued; a certificate a superadmin revokes can
// then be issued again from the event's current results, through
// POST …/certificates/reissue: a NEW certificate (new token and code), the revoked
// one still revoked, mailed through the dispatcher like any other.
test.describe("a revoked certificate can be issued again from the current results", () => {
  const issuedCount = async (sa, compId) => {
    const r = await sa.get("/api/admin/competitions");
    expect(r.ok, r.text).toBeTruthy();
    const row = (Array.isArray(r.body) ? r.body : r.body.competitions).find(c => c.id === compId);
    return row.certificates_issued;
  };
  const listed = async (sa, compId) => {
    const r = await sa.get(`/api/admin/competitions/${compId}/certificates`);
    expect(r.ok, r.text).toBeTruthy();
    return r.body.certificates;
  };
  const reissue = async (c, compId, userId) => c.post(`/api/admin/competitions/${compId}/certificates/reissue`, { userId }, await c.h());
  const revoke = async (sa, token) => {
    const r = await sa.post(`/api/admin/badges/${encodeURIComponent(token)}/revoke`, { reason: "the placing moved" }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
  };
  const liveRow = (compId, userId) => sql(db => db.prepare("SELECT * FROM achievement_badges WHERE competition_id=? AND user_id=? AND revoked_at IS NULL").all(compId, userId));
  const ownMint = async (p, compId) => p.c.post(`/api/competitions/${compId}/badge`, {}, await p.c.h());

  test("a revive keeps them as issued; revoked, one is issued again from the new board, mailed once with a new code; never by the holder", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { tasks: 3 });
    const a = await participant("riA"), b = await participant("riB");
    await assign(sa, comp.id, [a, b]);
    expect((await play(a, comp.id, taskIds[0], "right0")).correct).toBe(true);
    expect((await play(b, comp.id, taskIds[0], "nope")).correct).toBe(false);
    expect(await issuedCount(sa, comp.id), "CONTROL: none before the end, never undefined").toBe(0);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    await tick(sa);
    for (const p of [a, b]) await expect.poll(() => certMails(p.email).length, { timeout: 15000 }).toBe(1);
    const aFirst = liveRow(comp.id, a.id)[0], bFirst = liveRow(comp.id, b.id)[0];
    expect([aFirst.basis, aFirst.rank, bFirst.basis]).toEqual(["placement", 1, "participation"]);
    expect(await issuedCount(sa, comp.id)).toBe(2);
    // Held: Issue again is refused while a live certificate stands.
    const held = await reissue(sa, comp.id, b.id);
    expect([held.status, held.body.code]).toEqual([409, "certificate_held"]);

    // REVIVE; B now outscores A; END again. Issued certificates stay as issued.
    const put = await sa.put(`/api/admin/competitions/${comp.id}`, { duration_minutes: 900 }, await sa.h());
    expect(put.ok, `revive: ${put.text}`).toBeTruthy();
    expect(put.body.competition.status).toBe("live");
    expect((await play(b, comp.id, taskIds[1], "right1")).correct).toBe(true);
    expect((await play(b, comp.id, taskIds[2], "right2")).correct).toBe(true);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    expect((await tick(sa)).sent, "nobody is mailed again").toBe(0);
    expect(liveRow(comp.id, b.id).map(r => [r.token, r.basis]), "B keeps the participation certificate").toEqual([[bFirst.token, "participation"]]);

    // REVOKE B's: the list offers Issue again on it, the count drops, the holder cannot re-mint.
    let rows = await listed(sa, comp.id);
    expect(rows.find(c => c.userId === b.id).canIssueAgain, "a live certificate is not offered again").toBeUndefined();
    await revoke(sa, rows.find(c => c.userId === b.id).token);
    rows = await listed(sa, comp.id);
    expect(rows.filter(c => c.userId === b.id).map(c => [c.revoked, !!c.canIssueAgain])).toEqual([[true, true]]);
    expect(await issuedCount(sa, comp.id)).toBe(1);
    const own = await ownMint(b, comp.id);
    expect([own.status, own.body.code], "the holder cannot replace a revoked certificate").toEqual([403, "revoked"]);

    // ISSUE AGAIN: a new certificate from the current board, mailed once.
    const ri = await reissue(sa, comp.id, b.id);
    expect(ri.status, ri.text).toBe(200);
    expect(ri.body).toMatchObject({ ok: true, emailQueued: true, certificate: { userId: b.id, tier: "gold", rank: 1, basis: "placement" } });
    const bNew = liveRow(comp.id, b.id);
    expect(bNew).toHaveLength(1);
    expect([bNew[0].basis, bNew[0].rank]).toEqual(["placement", 1]);
    expect(bNew[0].token).not.toBe(bFirst.token);
    expect(bNew[0].public_code).not.toBe(bFirst.public_code);
    expect(sql(db => db.prepare("SELECT revoked_at FROM achievement_badges WHERE token=?").get(bFirst.token)).revoked_at, "the old one stays revoked").toBeTruthy();
    expect(await issuedCount(sa, comp.id)).toBe(2);
    await expect.poll(() => certMails(b.email).length, { timeout: 15000, message: "mailed at once, no pass needed" }).toBe(2);
    await expect.poll(() => sql(db => db.prepare("SELECT status FROM certificate_emails WHERE badge_token=?").get(bNew[0].token))?.status, { timeout: 15000 }).toBe("sent");
    const sentVia = sql(db => db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='certificate_emailed'").all(b.id)).map(r => JSON.parse(r.details).via);
    expect(sentVia.sort()).toEqual(["automatic", "reissue"]);
    const ev = sql(db => db.prepare("SELECT changed_by, details FROM user_events WHERE user_id=? AND event_type='badge_reissued'").all(b.id));
    expect(ev).toHaveLength(1);
    expect(ev[0].changed_by).toBe("superadmin");
    expect(JSON.parse(ev[0].details)).toMatchObject({ competition_id: comp.id, basis: "placement", rank: 1, previous_basis: "participation" });
    expect(JSON.parse(ev[0].details).ip, "the request context rides the audit").toBeTruthy();
    const minted = sql(db => db.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type='badge_minted'").all(comp.id)).map(r => JSON.parse(r.details));
    expect(minted.filter(d => d.via === "reissue").map(d => d.user_id)).toEqual([b.id]);
    expect((await ownMint(b, comp.id)).body.token, "the holder's own button now returns the new certificate").toBe(bNew[0].token);
    // CONTROL: A's certificate is untouched, mailed once.
    expect(liveRow(comp.id, a.id).map(r => [r.token, r.rank])).toEqual([[aFirst.token, 1]]);
    expect(certMails(a.email)).toHaveLength(1);
    const again = await reissue(sa, comp.id, b.id);
    expect([again.status, again.body.code], "issued: a second press is refused").toEqual([409, "certificate_held"]);

    // A's too, from the same board: 2nd place now.
    await revoke(sa, aFirst.token);
    const ra = await reissue(sa, comp.id, a.id);
    expect(ra.status, ra.text).toBe(200);
    expect(ra.body.certificate).toMatchObject({ tier: "silver", rank: 2 });

    // TWO PRESSES AT ONCE: exactly one certificate.
    await revoke(sa, bNew[0].token);
    const both = await Promise.all([reissue(sa, comp.id, b.id), reissue(sa, comp.id, b.id)]);
    expect(both.map(r => r.status).sort(), JSON.stringify(both.map(r => r.body))).toEqual([200, 409]);
    expect(liveRow(comp.id, b.id)).toHaveLength(1);
  });

  test("Issue again tells the truth about the email: an opted-out holder is not being emailed", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { tasks: 2 });
    const p = await participant("riOpt");
    await assign(sa, comp.id, [p]);
    expect((await play(p, comp.id, taskIds[0], "right0")).correct).toBe(true);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    await tick(sa);
    await expect.poll(() => certMails(p.email).length, { timeout: 15000 }).toBe(1);
    await revoke(sa, liveRow(comp.id, p.id)[0].token);
    sql(db => db.prepare("INSERT INTO unsubscribed_emails (email, unsubscribed_at) VALUES (?,?)").run(p.email.toLowerCase(), new Date().toISOString()));
    const ri = await reissue(sa, comp.id, p.id);
    expect(ri.status, ri.text).toBe(200);
    expect(ri.body.emailQueued, "the holder opted out: no email is on its way").toBe(false);
    expect(liveRow(comp.id, p.id), "the certificate is still issued").toHaveLength(1);
    await expect.poll(() => sql(db => db.prepare("SELECT status FROM certificate_emails WHERE badge_token=?").get(liveRow(comp.id, p.id)[0].token))?.status, { timeout: 15000 }).toBe("suppressed");
    expect(certMails(p.email)).toHaveLength(1);
  });

  test("Issue again waits for the final board, and follows the event's email switch", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { tasks: 2 });
    const p = await participant("riW");
    await assign(sa, comp.id, [p]);
    expect((await play(p, comp.id, taskIds[0], "right0")).correct).toBe(true);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    await tick(sa);
    await expect.poll(() => certMails(p.email).length, { timeout: 15000 }).toBe(1);
    await revoke(sa, liveRow(comp.id, p.id)[0].token);
    const put = await sa.put(`/api/admin/competitions/${comp.id}`, { duration_minutes: 900 }, await sa.h());
    expect(put.ok, `revive: ${put.text}`).toBeTruthy();
    const early = await reissue(sa, comp.id, p.id);
    expect([early.status, early.body.code], "the board is not final").toEqual([409, "not_ended"]);
    expect(liveRow(comp.id, p.id), "nothing was issued").toHaveLength(0);
    const row = (await listed(sa, comp.id)).find(c => c.userId === p.id);
    expect(row.canIssueAgain, "not offered while the event runs").toBeUndefined();
    expect(row.issueAgainRefused, "…and the list says why").toBe(early.body.error);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    const cfg = await sa.put(`/api/admin/competitions/${comp.id}/certificate-config`, { config: { email: { enabled: false } } }, await sa.h());
    expect(cfg.ok, cfg.text).toBeTruthy();
    const ri = await reissue(sa, comp.id, p.id);
    expect(ri.status, ri.text).toBe(200);
    expect(ri.body.emailQueued, "the event's email switch is off").toBe(false);
    expect(liveRow(comp.id, p.id)).toHaveLength(1);
    await tick(sa);
    expect(certMails(p.email), "no mail with the switch off").toHaveLength(1);
  });

  test("a superadmin or a role holding Revoke certificates issues again; an admin or event admin cannot; demoted mid-render, nothing is issued", async () => {
    const sa = await admin();
    // Two challenges, one left unsolved: one solver finishing everything would end it (fixture item 1).
    const { comp, taskIds } = await makeEvent(sa, { tasks: 2 });
    const p = await participant("riR");
    await assign(sa, comp.id, [p]);
    expect((await play(p, comp.id, taskIds[0], "right0")).correct).toBe(true);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    await tick(sa);
    await revoke(sa, liveRow(comp.id, p.id)[0].token);
    const signIn = async (email) => {
      const c = client();
      await c.post("/api/test/reset-recent-code-sends", {}, await c.h());
      await c.post("/api/auth/code/request", { email }, await c.h());
      const code = (await c.get(`/api/test/last-login-code?email=${encodeURIComponent(email)}`)).body.code;
      expect((await c.post("/api/auth/code/redeem", { email, code }, await c.h())).body.ok).toBe(true);
      return c;
    };
    const adm = await participant("riAdm");
    expect((await sa.post(`/api/admin/participants/${adm.id}/role`, { role: "admin" }, await sa.h())).ok).toBeTruthy();
    const ac = await signIn(adm.email);
    const r1 = await reissue(ac, comp.id, p.id);
    expect(r1.status, `built-in admin: ${r1.text}`).toBe(403);
    const ar = (await ac.get(`/api/admin/competitions/${comp.id}/certificates`)).body.certificates.find(c => c.userId === p.id);
    expect([ar.token, ar.canIssueAgain, ar.issueAgainRefused, ar.code], "an admin is offered neither the token, the button nor the credential code").toEqual([undefined, undefined, undefined, undefined]);
    const org = await participant("riOrg");
    expect((await sa.post(`/api/admin/competitions/${comp.id}/admins`, { userId: org.id }, await sa.h())).ok).toBeTruthy();
    const oc = await signIn(org.email);
    expect((await reissue(oc, comp.id, p.id)).status, "event admin").toBe(403);
    expect(liveRow(comp.id, p.id), "nothing was issued").toHaveLength(0);
    // A user-backed superadmin demoted to admin WHILE the certificate is drawn
    // issues nothing: the acting admin is re-asked inside the write.
    const sup = await participant("riSup");
    expect((await sa.post(`/api/admin/participants/${sup.id}/role`, { role: "superadmin" }, await sa.h())).ok).toBeTruthy();
    const sc = await signIn(sup.email);
    expect((await sa.post("/api/test/admin-commit-delay", { delayMs: 4000 }, await sa.h())).ok).toBeTruthy();
    try {
      const pending = reissue(sc, comp.id, p.id);
      await expect.poll(async () => (await sa.get("/api/test/admin-commit-delay")).body.parked, { timeout: 15000, message: "the reissue is parked after its render" }).toBe(1);
      expect((await sa.post(`/api/admin/participants/${sup.id}/role`, { role: "admin" }, await sa.h())).ok).toBeTruthy();
      const late = await pending;
      expect([late.status, late.body.code], `demoted mid-render: ${late.text}`).toEqual([403, "admin_access_revoked"]);
      expect(liveRow(comp.id, p.id), "nothing was issued").toHaveLength(0);
    } finally {
      await sa.post("/api/test/admin-commit-delay", { delayMs: 0 }, await sa.h());
    }
    // A custom role holding Revoke certificates (and what reading the list takes):
    // offered Issue again, never the token (a permanent link to the PDF), and it
    // issues.
    const role = await sa.post("/api/admin/roles", { label: `Reissuer ${stamp()}`, scope_mode: "all",
      permissions: ["panel.access", "events.view", "certificates.view", "certificates.revoke"] }, await sa.h());
    expect(role.ok, role.text).toBeTruthy();
    const cr = await participant("riRole");
    const pr = await sa.patch(`/api/admin/users/${cr.id}/role`, { role: role.body.role.id }, await sa.h());
    expect(pr.ok, pr.text).toBeTruthy();
    const rc = await signIn(cr.email);
    const rrow = (await rc.get(`/api/admin/competitions/${comp.id}/certificates`)).body.certificates.find(c => c.userId === p.id);
    expect([rrow.canIssueAgain, rrow.token, rrow.code], "offered Issue again; the token stays the superadmin's, the code lookup's").toEqual([true, undefined, undefined]);
    const ok = await reissue(rc, comp.id, p.id);
    expect(ok.status, ok.text).toBe(200);
    expect(liveRow(comp.id, p.id)).toHaveLength(1);
    expect(ok.body.certificate.code, "the new certificate's code is not in the answer either").toBeUndefined();
    expect(liveRow(comp.id, p.id)[0].public_code, "PRECONDITION: the new certificate has a code").toBeTruthy();
    // CONTROL: a role granted Look up a certificate by its code sees each code
    // beside its holder.
    const lrole = await sa.post("/api/admin/roles", { label: `Looker ${stamp()}`, scope_mode: "all",
      permissions: ["panel.access", "events.view", "certificates.view", "certificates.lookup"] }, await sa.h());
    expect(lrole.ok, lrole.text).toBeTruthy();
    const lu = await participant("riLook");
    expect((await sa.patch(`/api/admin/users/${lu.id}/role`, { role: lrole.body.role.id }, await sa.h())).ok).toBeTruthy();
    const lc = await signIn(lu.email);
    const lrow = (await lc.get(`/api/admin/competitions/${comp.id}/certificates`)).body.certificates.find(c => c.userId === p.id && !c.revoked);
    expect(String(lrow.code).replace(/-/g, ""), "CONTROL: the lookup permission sees the code").toBe(liveRow(comp.id, p.id)[0].public_code);
  });
});

// A MARK-SENT RESTORE (scripts/restore-mail.sh; operator ruling, 17 Nov 2026,
// "Choose at restore"): `settings.restore_mail_floor_at` joins the grandfather
// floor. An event that ended before it is neither issued nor mailed (its holders
// collect their own); a Program completion queued before it is dropped; a send
// first tried before it is not retried. Ends, completions and sends after it go
// out as usual.
test.describe("a mark-sent restore counts what ended before it as sent", () => {
  const plant = (iso) => sql(db => db.prepare(
    "INSERT INTO settings (key, value) VALUES ('restore_mail_floor_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(iso));
  const unplant = () => sql(db => db.prepare("DELETE FROM settings WHERE key='restore_mail_floor_at'").run());
  const tickFor = async (sa, competitionId) => {
    const r = await sa.post("/api/test/certificate-dispatch-tick", { force: true, competitionId }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    return r.body;
  };

  test("an event that ended before it is neither issued nor mailed; one ending after it is; retries follow the same line", async () => {
    const sa = await admin();
    const A = await makeEvent(sa, { tasks: 2 }), B = await makeEvent(sa, { tasks: 2 });
    const pa = await participant("rsA"), pb = await participant("rsB");
    await assign(sa, A.comp.id, [pa]);
    await assign(sa, B.comp.id, [pb]);
    expect((await play(pa, A.comp.id, A.taskIds[0], "right0")).correct).toBe(true);
    expect((await play(pb, B.comp.id, B.taskIds[0], "right0")).correct).toBe(true);
    expect((await sa.post(`/api/admin/competitions/${A.comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    const R = new Date().toISOString();
    plant(R);
    try {
      await new Promise(r => setTimeout(r, 10));
      expect((await sa.post(`/api/admin/competitions/${B.comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
      expect(jobs(A.comp.id), "PRECONDITION: the end queued its job").toHaveLength(1);
      await tickFor(sa, A.comp.id);
      await tickFor(sa, B.comp.id);
      await expect.poll(() => certMails(pb.email).length, { timeout: 15000, message: "CONTROL: an end after the restore is mailed" }).toBe(1);
      expect(badges(A.comp.id), "nothing is issued for an end before it").toEqual([]);
      expect(jobs(A.comp.id), "its job is dropped").toEqual([]);
      expect(certMails(pa.email)).toHaveLength(0);
      // The holder collects it themselves, as before automatic issue; nobody is mailed.
      const own = await pa.c.post(`/api/competitions/${A.comp.id}/badge`, {}, await pa.c.h());
      expect(own.status, own.text).toBe(200);
      expect(own.body.token).toBeTruthy();
      await tickFor(sa, A.comp.id);
      expect(certMails(pa.email)).toHaveLength(0);

      // RETRIES: a failed send last tried before the restore is not retried…
      const tok = badges(B.comp.id)[0].token;
      await expect.poll(() => ledger(B.comp.id)[0]?.status, { timeout: 15000 }).toBe("sent");
      const firstTried = new Date(Date.parse(R) - 120_000).toISOString();
      const fail = (lastTried) => sql(db => db.prepare("UPDATE certificate_emails SET status='failed', attempts=1, next_attempt_at=?, first_attempt_at=?, updated_at=? WHERE badge_token=?")
        .run(new Date(0).toISOString(), firstTried, lastTried, tok));
      fail(new Date(Date.parse(R) - 60_000).toISOString());
      await tickFor(sa, B.comp.id);
      expect(ledger(B.comp.id)[0]).toMatchObject({ status: "failed", attempts: 1, next_attempt_at: null });
      expect(certMails(pb.email)).toHaveLength(1);
      // …and CONTROL: one first tried before it but tried again since (an admin's
      // Resend after the restore) is.
      fail(new Date(Date.parse(R) + 1).toISOString());
      await tickFor(sa, B.comp.id);
      await expect.poll(() => certMails(pb.email).length, { timeout: 15000 }).toBe(2);
      expect(ledger(B.comp.id)[0]).toMatchObject({ status: "sent", attempts: 2 });
    } finally { unplant(); }
  });

  test("a floor more than a day ahead is ignored: it would stop every automatic mail", async () => {
    const sa = await admin();
    const E = await makeEvent(sa, { tasks: 2 });
    const pe = await participant("rsF");
    await assign(sa, E.comp.id, [pe]);
    expect((await play(pe, E.comp.id, E.taskIds[0], "right0")).correct).toBe(true);
    plant("2999-01-01T00:00:00.000Z");
    try {
      expect((await sa.post(`/api/admin/competitions/${E.comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
      await tickFor(sa, E.comp.id);
      await expect.poll(() => certMails(pe.email).length, { timeout: 15000, message: "mailed as if no floor were set" }).toBe(1);
    } finally { unplant(); }
  });

  test("a Program completion queued before it is dropped; one after it is mailed", async () => {
    const sa = await admin();
    const P = await makeEvent(sa, { kind: "program", tasks: 1 });
    const early = await participant("rsPE"), late = await participant("rsPL");
    await assign(sa, P.comp.id, [early, late]);
    expect((await play(early, P.comp.id, P.taskIds[0], "right0")).correct).toBe(true);
    await expect.poll(() => jobs(P.comp.id).map(j => j.user_id), { message: "PRECONDITION: the completion is queued" }).toEqual([early.id]);
    plant(new Date().toISOString());
    try {
      await new Promise(r => setTimeout(r, 10));
      expect((await play(late, P.comp.id, P.taskIds[0], "right0")).correct).toBe(true);
      await tickFor(sa, P.comp.id);
      await expect.poll(() => certMails(late.email).length, { timeout: 15000, message: "CONTROL: a completion after the restore is mailed" }).toBe(1);
      expect(badges(P.comp.id).map(b => b.user_id), "only the later completion is issued").toEqual([late.id]);
      expect(certMails(early.email)).toHaveLength(0);
      expect(jobs(P.comp.id)).toEqual([]);
    } finally { unplant(); }
  });
});

// SWEEP #212: a send re-asks the holder after its render. The automatic pass reads
// its holders (unblocked, not denied, approved, members) BEFORE the render's
// await, and the retry of a failed send read nothing about the account at all,
// so a participant blocked or denied after a failed first send was still mailed
// the certificate and a fresh one-time LinkedIn link. Every send now asks
// synchronously after its last await; such a send is settled `skipped`, never
// retried, and an admin's Resend is refused instead.
// SWEEP #405: the plain-text part showed an event name holding & or an
// apostrophe as HTML entities; `fallbackNote` is plain text now (buildEmail
// escapes it for the HTML part), and the body's entities decode `&amp;` last.
test.describe("sweeps #212 and #405 — who a retried certificate email reaches, and what its text says", () => {
  const shareLinks = (token) => sql(db => db.prepare("SELECT COUNT(*) n FROM certificate_share_links WHERE badge_token=?").get(token).n);
  const lastEmailed = (userId) => sql(db => {
    const r = db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='certificate_emailed' ORDER BY rowid DESC LIMIT 1").get(userId);
    return r ? JSON.parse(r.details) : null;
  });
  const rowOf = (compId, userId) => ledger(compId).find(r => r.user_id === userId);

  test("a failed send is not retried to a holder blocked, denied, no longer approved or removed since; an active member's is", async () => {
    const sa = await admin();
    const ev = await makeEvent(sa, { tasks: 2 }); // a second, unsolved challenge keeps the all-solved end away (fixture item 1)
    const ctl = await participant("r212ctl"), blk = await participant("r212blk"), den = await participant("r212den"),
      una = await participant("r212una"), gone = await participant("r212gone");
    const all = [ctl, blk, den, una, gone];
    await assign(sa, ev.comp.id, all);
    for (const p of all) expect((await play(p, ev.comp.id, ev.taskIds[0], "right0")).correct).toBe(true);
    smtp.rejectRecipients(a => all.some(p => p.email.toLowerCase() === String(a).toLowerCase()));
    try {
      expect((await sa.post(`/api/admin/competitions/${ev.comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
      await settleScheduler(sa);
      await tick(sa);
      await expect.poll(() => ledger(ev.comp.id).filter(r => r.status === "failed" && r.next_attempt_at).length,
        { timeout: 15000, message: "PRECONDITION: every first send failed and is due a retry" }).toBe(all.length);
    } finally { smtp.rejectRecipients(null); }
    const tokenOf = (p) => badges(ev.comp.id).find(b => b.user_id === p.id).token;
    // A forced tick runs the retry pass straight after the first one, so each
    // holder may already have failed twice: count from here, with a retry left.
    const linksBefore = new Map(all.map(p => [p.id, shareLinks(tokenOf(p))]));
    const attemptsBefore = new Map(all.map(p => [p.id, rowOf(ev.comp.id, p.id).attempts]));
    for (const p of all) {
      expect(linksBefore.get(p.id), `PRECONDITION: ${p.email}'s failed sends minted share links`).toBeGreaterThanOrEqual(1);
      expect(attemptsBefore.get(p.id), `PRECONDITION: ${p.email} has a retry left`).toBeLessThan(3);
    }
    // Since the failed send: blocked; denied ALONE (blocked stays 0, so each clause
    // is seen on its own); no longer approved; removed from the event.
    sql(db => {
      db.prepare("UPDATE users SET blocked=1 WHERE id=?").run(blk.id);
      db.prepare("UPDATE users SET denied_at=? WHERE id=?").run(new Date().toISOString(), den.id);
      db.prepare("UPDATE users SET approved=0 WHERE id=?").run(una.id);
      db.prepare("DELETE FROM competition_users WHERE competition_id=? AND user_id=?").run(ev.comp.id, gone.id);
    });
    const t = await tick(sa);
    expect(t.retried, `the pass retried all five: ${JSON.stringify(t)}`).toBeGreaterThanOrEqual(all.length);
    await expect.poll(() => certMails(ctl.email).length, { timeout: 15000, message: "CONTROL: the active member's retry is mailed" }).toBe(1);
    expect(rowOf(ev.comp.id, ctl.id)).toMatchObject({ status: "sent", attempts: attemptsBefore.get(ctl.id) + 1 });
    expect(shareLinks(tokenOf(ctl)), "CONTROL: the mail that went out carries a fresh share link").toBe(linksBefore.get(ctl.id) + 1);
    for (const [p, why] of [[blk, "account_inactive"], [den, "account_inactive"], [una, "account_inactive"], [gone, "not_member"]]) {
      expect(certMails(p.email), `${p.email} is not mailed`).toHaveLength(0);
      expect(rowOf(ev.comp.id, p.id), `${p.email}: settled, not retried`).toMatchObject({ status: "skipped", last_error: why, next_attempt_at: null });
      expect(shareLinks(tokenOf(p)), `${p.email}: no new share link`).toBe(linksBefore.get(p.id));
      expect(lastEmailed(p.id), `${p.email}: the attempt is on their History`).toMatchObject({ status: "skipped", skipped: why, via: "retry" });
    }
    // A skipped send is never retried.
    await tick(sa);
    for (const p of [blk, den, una, gone]) {
      expect(certMails(p.email)).toHaveLength(0);
      expect(rowOf(ev.comp.id, p.id).status).toBe("skipped");
    }
    expect(certMails(ctl.email)).toHaveLength(1);
  });

  test("an admin's Resend is refused for a blocked holder and leaves the ledger as it was; unblocked, it sends", async () => {
    const sa = await admin();
    const ev = await makeEvent(sa, { tasks: 2 }); // a second, unsolved challenge keeps the all-solved end away (fixture item 1)
    const p = await participant("r212rs");
    await assign(sa, ev.comp.id, [p]);
    expect((await play(p, ev.comp.id, ev.taskIds[0], "right0")).correct).toBe(true);
    expect((await sa.post(`/api/admin/competitions/${ev.comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    await settleScheduler(sa);
    await tick(sa);
    await expect.poll(() => certMails(p.email).length, { timeout: 15000, message: "PRECONDITION: the holder was mailed" }).toBe(1);
    const token = badges(ev.comp.id)[0].token;
    const before = rowOf(ev.comp.id, p.id);
    expect(before).toMatchObject({ status: "sent", attempts: 1 });
    sql(db => db.prepare("UPDATE users SET blocked=1 WHERE id=?").run(p.id));
    const r = await sa.post(`/api/admin/competitions/${ev.comp.id}/certificates/resend`, { userId: p.id }, await sa.h());
    expect(r.status, r.text).toBe(409);
    expect(r.body.code).toBe("account_inactive");
    expect(rowOf(ev.comp.id, p.id), "the ledger keeps its last real outcome").toEqual(before);
    expect(shareLinks(token), "no share link was minted").toBe(1);
    expect(certMails(p.email)).toHaveLength(1);
    sql(db => db.prepare("UPDATE users SET blocked=0 WHERE id=?").run(p.id));
    const ok = await sa.post(`/api/admin/competitions/${ev.comp.id}/certificates/resend`, { userId: p.id }, await sa.h());
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, status: "sent" });
    await expect.poll(() => certMails(p.email).length, { timeout: 15000, message: "CONTROL: unblocked, Resend sends" }).toBe(2);
  });

  test("the certificate mail's plain text shows the event's name as written; its HTML escapes it once", async () => {
    const sa = await admin();
    // An apostrophe, an ampersand, a quote, and the TEXT "&lt;" (which must stay
    // four characters in the plain text, not become "<").
    const name = `Bob's R&D "Day" &lt;${stamp()}&gt;`;
    const ev = await makeEvent(sa, { name, tasks: 2 });
    const p = await participant("r405");
    await assign(sa, ev.comp.id, [p]);
    expect((await play(p, ev.comp.id, ev.taskIds[0], "right0")).correct).toBe(true);
    expect((await sa.post(`/api/admin/competitions/${ev.comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    await settleScheduler(sa);
    await tick(sa);
    await expect.poll(() => certMails(p.email).length, { timeout: 15000 }).toBe(1);
    const m = certMails(p.email)[0];
    const text = textOf(m);
    expect(text, "the footnote names the event as written").toContain(`You are receiving this because you took part in ${name}.`);
    expect(text, "the gold message names the event as written").toContain(`you took 1st place in ${name}!`);
    expect(text, "no entity reaches the plain text").not.toMatch(/&amp;|&#x27;|&quot;|&lt;[^0-9]/);
    const html = parts(m.raw).filter(x => /content-type:\s*text\/html/i.test(x.head)).map(x => x.body.toString("utf8")).join("\n");
    const once = name.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
    expect(html, "CONTROL: the HTML part escapes the name exactly once").toContain(`took part in ${once}.`);
    expect(html, "never twice").not.toContain("&amp;amp;");
    expect(decodeHeader(m.header("subject")), "the subject carries the raw name").toContain(`Your certificate for ${name}`);
  });
});

test.describe("v8.15.1 — the dispatcher's source locks", () => {
  test("sweep #405: every mail's fallbackNote is a raw value, which buildEmail escapes once for the HTML part", () => {
    const { stripJsComments } = require("./doc-registry");
    const root = path.resolve(__dirname, "..");
    const files = [
      ...fs.readdirSync(path.join(root, "lib")).filter(f => f.endsWith(".js")).map(f => "lib/" + f),
      ...fs.readdirSync(path.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => "routes/" + f),
      "server.js",
    ];
    const notes = [];
    for (const f of files) {
      const src = stripJsComments(fs.readFileSync(path.join(root, f), "utf8"));
      for (const m of src.matchAll(/\bfallbackNote:\s*([^\n]*)/g)) notes.push({ f, v: m[1] });
    }
    // Pre-escaped (an escaper's call) or HTML (a tag or an entity) is the defect:
    // buildEmail escapes the note itself, so either reaches the reader twice-escaped.
    const bad = (v) => /\bescapeHtml\(|\bE_?\(|\besc\(|<[a-z/]|&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i.test(v);
    expect(bad("`took part in ${E_(eventName)}.`"), "matcher self-test: an escaper call").toBe(true);
    expect(bad("`register for ${escapeHtml(platformName)}`"), "matcher self-test: escapeHtml").toBe(true);
    expect(bad("\"see <b>this</b>\""), "matcher self-test: markup").toBe(true);
    expect(bad("`took part in ${eventName}.`"), "matcher self-test: a raw value").toBe(false);
    expect(bad("\"Ask the R&D team.\""), "matcher self-test: a bare ampersand is text").toBe(false);
    expect(notes.filter(n => bad(n.v)).map(n => `${n.f}: ${n.v}`), "a fallbackNote passed escaped or as HTML").toEqual([]);
    expect(notes.length, "anti-vacuity: the mails' notes are still found").toBeGreaterThanOrEqual(15);
    const email = fs.readFileSync(path.join(root, "lib", "email.js"), "utf8");
    expect(email, "buildEmail escapes the note for the HTML part").toContain("${esc(fallbackNote)}");
    expect(email, "and writes it as it is in the plain text").not.toContain("fallbackNote.replace(");
  });

  test("every end transition that freezes the team board also queues the event's certificates", () => {
    // `freezeGroupLeaderboardSnapshots` is the documented "this is an end" hook
    // (CLAUDE.md, *Group leaderboard*: every not-ended → ended transition calls
    // it). An end path that freezes but does not enqueue would end an event and
    // mail nobody, which no behavioural test of the OTHER paths would notice.
    const { stripJsComments } = require("./doc-registry");
    const root = path.resolve(__dirname, "..");
    const files = ["server.js", "lib/scheduler.js",
      ...fs.readdirSync(path.join(root, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`)];
    let sites = 0;
    const bad = [];
    for (const rel of files) {
      const lines = stripJsComments(fs.readFileSync(path.join(root, rel), "utf8")).split("\n");
      lines.forEach((ln, i) => {
        if (!/\bfreezeGroupLeaderboardSnapshots\s*\(/.test(ln) || /require\(/.test(ln)) return;
        sites++;
        const near = lines.slice(i, i + 4).join("\n");
        if (!/\benqueueCertificateDispatch\s*\(/.test(near)) bad.push(`${rel}:${i + 1}: ${ln.trim()}`);
      });
    }
    expect(sites, "the walk still finds the end paths").toBeGreaterThanOrEqual(12);
    expect(bad, "these end transitions freeze the board but never queue the certificates:\n  " + bad.join("\n  ")).toEqual([]);
  });

  test("the email section of the certificate design: {event} is a placeholder there and nowhere else", () => {
    const CC = require("../lib/certificate-config");
    expect(CC.validateCertificateConfig({ email: { enabled: false, subject: "Well done at {event}", intro: "Thanks from {platform}." } }).ok).toBe(true);
    expect(CC.validateCertificateConfig({ email: { subject: "{who}" } }).code).toBe("certificate_config_unknown_token");
    expect(CC.validateCertificateConfig({ text: { title: "{event}" } }).code, "the artwork keeps its one placeholder").toBe("certificate_config_unknown_token");
    expect(CC.validateCertificateConfig({ email: { enabled: "yes" } }).code).toBe("certificate_config_bad_type");
    expect(CC.validateCertificateConfig({ email: { subject: "" } }).code).toBe("certificate_config_required");
    expect(CC.validateCertificateConfig({ email: { cc: "x" } }).code).toBe("certificate_config_unknown_key");
    expect(CC.mergeCertificateConfig().email, "on by default").toEqual(CC.EMAIL_DEFAULTS);
    expect(CC.EMAIL_DEFAULTS).toMatchObject({ enabled: true, subject: "Your certificate for {event}", intro: "" });
    for (const t of ["gold", "silver", "bronze", "participation", "completion"]) {
      expect(CC.EMAIL_DEFAULTS[`message_${t}`], `${t} has its own thank-you`).toContain("{event}");
    }
    expect(new Set(["gold", "silver", "bronze", "participation", "completion"].map(t => CC.EMAIL_DEFAULTS[`message_${t}`])).size, "five distinct paragraphs").toBe(5);
    expect(CC.validateCertificateConfig({ email: { linkedin_post: "I won {achievement} at {event} with {organisers}" } }).ok).toBe(true);
    expect(CC.validateCertificateConfig({ email: { message_gold: "{achievement}" } }).code, "{achievement} belongs to the post only").toBe("certificate_config_unknown_token");
    expect(CC.mergeCertificateConfig({ email: { enabled: false } }, { email: { enabled: true } }).email.enabled, "an event can switch it back on").toBe(true);
    expect(CC.fillTokens("At {event} on {platform}", { platformName: "P", eventName: "E" })).toBe("At E on P");
  });
});

// ─── SWEEPS #402, #43 AND #347 (operator rulings, 24 Nov 2026, "as recommended") ──

/** One forced dispatcher pass over ONE event's jobs and retries (a pass otherwise serves every event the file ended). */
async function tickFor(sa, competitionId) {
  const r = await sa.post("/api/test/certificate-dispatch-tick", { force: true, competitionId }, await sa.h());
  expect(r.ok, `tick: ${r.text}`).toBeTruthy();
  return r.body;
}
const htmlOf = (m) => parts(m.raw).filter(x => /content-type:\s*text\/html/i.test(x.head)).map(x => x.body.toString("utf8")).join("\n");

// SWEEP #402: mail scanners and link prefetchers fetch every link in a mail,
// signed out, exactly as the holder's own click from it arrives, and the PDF
// route records every fetch as a download. The mail's link carries a marker, so
// those fetches are recorded `via: "email_link"` (History and the Audit page then
// say they may be a scanner's: tests/certificate-mail-link-history.spec.js).
test.describe("sweep #402 — the email's link to the PDF says it came from the email", () => {
  const downloads = (compId) => sql(db => db.prepare("SELECT changed_by, details FROM competition_events WHERE competition_id=? AND event_type='badge_certificate_downloaded' ORDER BY rowid").all(compId))
    .map(r => ({ actor: String(r.changed_by).toLowerCase(), ...JSON.parse(r.details || "{}") }));

  test("the mail links the PDF with ?from=email; a fetch through it is recorded via email_link, the holder's own session's too; any other fetch is a plain download; the mark grants nothing", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { tasks: 2 });
    const p = await participant("mlink");
    await assign(sa, comp.id, [p]);
    expect((await play(p, comp.id, taskIds[0], "right0")).correct).toBe(true);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    await settleScheduler(sa);
    await tickFor(sa, comp.id);
    await expect.poll(() => certMails(p.email).length, { timeout: 15000 }).toBe(1);
    const token = badges(comp.id)[0].token;
    const pdfPath = `/badge/${token}/certificate.pdf`;
    const marked = `${BASE}${pdfPath}?from=email`;
    const m = certMails(p.email)[0];
    // The mail's link to the PDF, by value, in both parts, and never unmarked.
    for (const [part, body] of [["text", textOf(m)], ["html", htmlOf(m)]]) {
      expect(body, `${part}: the link to the PDF carries the mark`).toContain(marked);
      expect(body.split(marked).join(""), `${part}: and no link to it goes without the mark`).not.toContain(pdfPath);
    }
    // The holder's own list links it plainly: a click there is no mail link.
    const mine = await p.c.get("/api/me/certificates");
    expect(mine.ok, mine.text).toBeTruthy();
    expect(mine.body.certificates.find(c => c.token === token).pdfUrl, "the holder's own list links it unmarked").toBe(`${BASE}${pdfPath}`);
    expect(downloads(comp.id), "PRECONDITION: nothing has fetched it yet").toEqual([]);

    const anon = client();
    const viaMail = await anon.get(new URL(marked).pathname + new URL(marked).search);
    expect(viaMail.status, viaMail.text.slice(0, 200)).toBe(200);
    expect(viaMail.buf.slice(0, 5).toString("latin1")).toBe("%PDF-");
    const plain = await anon.get(pdfPath);
    expect(plain.status).toBe(200);
    expect(plain.buf.equals(viaMail.buf), "the mark changes nothing in the answer").toBe(true);
    expect(plain.headers.get("content-disposition")).toBe(viaMail.headers.get("content-disposition"));
    const others = ["?from=emailx", "?from=Email", "?from=email&from=email", "?via=email_link"];
    for (const q of others) expect((await anon.get(pdfPath + q)).status, `${q}: still the PDF`).toBe(200);
    const own = await p.c.get(`${pdfPath}?from=email`);
    expect(own.status).toBe(200);
    const d = downloads(comp.id);
    expect(d.map(x => [x.actor, "via" in x ? x.via : null, x.by_owner]), "recorded by value, oldest first").toEqual([
      ["anonymous", "email_link", false],              // through the mail's link: a scanner, or the holder's signed-out click
      ["anonymous", null, false],                      // CONTROL: a plain download
      ...others.map(() => ["anonymous", null, false]), // any other value is a plain download
      [p.email.toLowerCase(), "email_link", true],     // the holder's own signed-in click on the mail's link
    ]);
    for (const x of d) expect(x.ip, "each carries the request context").toBeTruthy();

    // The mark grants nothing: an unknown token and a revoked certificate answer
    // the uniform 404 with or without it, and record nothing.
    const fake = `/badge/${"A".repeat(43)}/certificate.pdf`;
    const f0 = await anon.get(fake), f1 = await anon.get(`${fake}?from=email`);
    expect(f0.status).toBe(404);
    expect([f1.status, f1.text], "an unknown token, marked").toEqual([404, f0.text]);
    const rv = await sa.post(`/api/admin/badges/${encodeURIComponent(token)}/revoke`, { reason: "sweep 402 control" }, await sa.h());
    expect(rv.ok, rv.text).toBeTruthy();
    const r1 = await anon.get(`${pdfPath}?from=email`);
    expect([r1.status, r1.text], "a revoked certificate, marked").toEqual([404, f0.text]);
    expect(downloads(comp.id), "a refused fetch records nothing").toHaveLength(d.length);
  });
});

// SWEEP #43: the share image is rendered on every request, so no issue stores a
// copy of it (each cost ~150 KB of `images`, again per Issue again, and nothing
// reclaimed it). Asserted on the table itself, by value, around each of the three
// ways a certificate is issued.
test.describe("sweep #43 — no issue stores the share image", () => {
  const imageIds = () => sql(db => db.prepare("SELECT id FROM images ORDER BY id").all().map(r => r.id));

  test("the participant's own mint, the automatic issue and Issue again leave `images` as it was; the image and the PDF still render, for the link's holder and for an organiser", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { tasks: 2 });
    const own = await participant("img43own"), auto = await participant("img43auto");
    await assign(sa, comp.id, [own, auto]);
    expect((await play(own, comp.id, taskIds[0], "right0")).correct).toBe(true);
    expect((await play(auto, comp.id, taskIds[0], "nope")).correct).toBe(false);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    await settleScheduler(sa);
    const before = imageIds();
    // 1. The participant's own Get my certificate, in the settle window.
    const m = await own.c.post(`/api/competitions/${comp.id}/badge`, {}, await own.c.h());
    expect(m.ok, m.text).toBeTruthy();
    expect(badges(comp.id).map(b => b.user_id), "PRECONDITION: the mint wrote its certificate, to this server's database").toEqual([own.id]);
    expect(imageIds(), "the participant's mint stored no image").toEqual(before);
    // 2. The automatic issue: the event's job issues the other participant.
    const t = await tickFor(sa, comp.id);
    expect(t.issued, `the pass issued the second certificate: ${JSON.stringify(t)}`).toBe(1);
    expect(badges(comp.id).map(b => b.user_id).sort()).toEqual([own.id, auto.id].sort());
    expect(imageIds(), "the automatic issue stored no image").toEqual(before);
    // 3. Issue again, past a revocation.
    const first = badges(comp.id).find(b => b.user_id === auto.id);
    const rv = await sa.post(`/api/admin/badges/${encodeURIComponent(first.token)}/revoke`, { reason: "sweep 43" }, await sa.h());
    expect(rv.ok, rv.text).toBeTruthy();
    const ri = await sa.post(`/api/admin/competitions/${comp.id}/certificates/reissue`, { userId: auto.id }, await sa.h());
    expect(ri.status, ri.text).toBe(200);
    expect(badges(comp.id), "PRECONDITION: Issue again wrote a new certificate").toHaveLength(3);
    expect(imageIds(), "Issue again stored no image").toEqual(before);
    expect(badges(comp.id).map(b => b.image_id), "no certificate names a stored copy").toEqual(["", "", ""]);

    // The share image and the PDF render for whoever holds the link, and the
    // organiser's downloads too.
    const anon = client();
    for (const b of badges(comp.id).filter(x => !x.revoked_at)) {
      const png = await anon.get(`/badge/${b.token}/badge.png`);
      expect(png.status, png.text.slice(0, 200)).toBe(200);
      expect(png.headers.get("content-type")).toMatch(/^image\/png/);
      expect(png.buf.slice(0, 8).toString("hex"), "a PNG").toBe("89504e470d0a1a0a");
      const pdf = await anon.get(`/badge/${b.token}/certificate.pdf`);
      expect([pdf.status, pdf.buf.slice(0, 5).toString("latin1")]).toEqual([200, "%PDF-"]);
      const apng = await sa.get(`/api/admin/competitions/${comp.id}/certificates/${b.user_id}/badge.png`);
      expect([apng.status, apng.buf.slice(0, 8).toString("hex")]).toEqual([200, "89504e470d0a1a0a"]);
      const apdf = await sa.get(`/api/admin/competitions/${comp.id}/certificates/${b.user_id}/certificate.pdf`);
      expect([apdf.status, apdf.buf.slice(0, 5).toString("latin1")]).toEqual([200, "%PDF-"]);
    }
    expect(imageIds(), "nor does rendering store anything").toEqual(before);
  });
});

// SWEEP #347: every certificate mail (its retries and every Resend too) mints a
// one-time share link, and nothing ever deleted one. The daily retention pass
// (driven here by POST /api/test/purge-events) now deletes a link 30 days after
// it expired, used or not, oldest first and capped per pass. Until then it says
// it has expired; after, it is the page's uniform not-found.
test.describe("sweep #347 — a share link is deleted 30 days after it expired", () => {
  test("expired 40 and 31 days ago: deleted, oldest first within the per-pass cap, and the page is then the uniform not-found; 29 days ago: kept, still saying so; a live one: kept", async () => {
    const crypto = require("crypto");
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { tasks: 2 });
    const ps = [await participant("sl347a"), await participant("sl347b"), await participant("sl347c"), await participant("sl347d")];
    await assign(sa, comp.id, ps);
    for (const p of ps) expect((await play(p, comp.id, taskIds[0], "right0")).correct).toBe(true);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    await settleScheduler(sa);
    await tickFor(sa, comp.id);
    for (const p of ps) await expect.poll(() => certMails(p.email).length, { timeout: 15000 }).toBe(1);
    const linkOf = (p) => {
      const mm = textOf(certMails(p.email)[0]).match(/\/badge\/([A-Za-z0-9_-]{43})\/post/);
      expect(mm, `${p.email}: the mail carries a share link`).toBeTruthy();
      return mm[1];
    };
    const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
    const links = ps.map(linkOf);
    const rowid = (l) => sql(db => db.prepare("SELECT rowid AS r FROM certificate_share_links WHERE id_hash=?").get(hash(l))).r;
    // The two to go: the one written LATER expired EARLIER, so "oldest first" is
    // told apart from the order the rows were written in.
    const [early, later] = links.slice(0, 2).sort((x, y) => rowid(x) - rowid(y));
    const DAY = 86_400_000;
    const age = (l, days) => sql(db => db.prepare("UPDATE certificate_share_links SET expires_at=? WHERE id_hash=?").run(new Date(Date.now() - days * DAY).toISOString(), hash(l)));
    age(later, 40);
    age(early, 31);
    // A used link goes the same way: the 31-day one was used before it expired.
    sql(db => db.prepare("UPDATE certificate_share_links SET used_at=? WHERE id_hash=?").run(new Date(Date.now() - 35 * DAY).toISOString(), hash(early)));
    const kept = links[2], live = links[3];
    age(kept, 29);
    const exists = (l) => !!sql(db => db.prepare("SELECT 1 AS x FROM certificate_share_links WHERE id_hash=?").get(hash(l)));
    const all = () => [later, early, kept, live].map(exists);

    const anon = client();
    const never = await anon.get(`/badge/${"B".repeat(43)}/post`);
    expect(never.status, "the uniform not-found, from a link that never existed").toBe(404);
    // PRECONDITIONS: before the pass each old link still says what became of it.
    const pre = await anon.get(`/badge/${later}/post`);
    expect([pre.status, /expired/.test(pre.text)], "40 days past its expiry, before the pass: it says it expired").toEqual([410, true]);
    const preUsed = await anon.get(`/badge/${early}/post`);
    expect([preUsed.status, /already been used/.test(preUsed.text)], "the used one says so").toEqual([410, true]);
    expect(all()).toEqual([true, true, true, true]);

    // A pass capped at one deletes the OLDEST past the 30 days, and says more remain.
    const p1 = await sa.post("/api/test/purge-events", { limit: 1 }, await sa.h());
    expect(p1.ok, p1.text).toBeTruthy();
    expect(p1.body).toMatchObject({ share_links_purged: 1, share_links_capped: true, total: 0 });
    expect(all(), "the 40-day one went first").toEqual([false, true, true, true]);
    // The next (uncapped) pass takes the rest past the 30 days, and no more.
    const p2 = await sa.post("/api/test/purge-events", {}, await sa.h());
    expect(p2.body).toMatchObject({ share_links_purged: 1, share_links_capped: false });
    expect(all(), "the 31-day one went next; 29 days past expiry and a live one stay").toEqual([false, false, true, true]);
    const p3 = await sa.post("/api/test/purge-events", {}, await sa.h());
    expect(p3.body.share_links_purged, "nothing more is due").toBe(0);

    // Deleted: the page is the uniform not-found, byte for byte.
    for (const l of [later, early]) {
      const r = await anon.get(`/badge/${l}/post`);
      expect([r.status, r.text]).toEqual([404, never.text]);
    }
    // Kept: 29 days past expiry it still says it expired; the live one still works.
    const rk = await anon.get(`/badge/${kept}/post`);
    expect([rk.status, /expired/.test(rk.text)]).toEqual([410, true]);
    const rl = await anon.get(`/badge/${live}/post`);
    expect([rl.status, rl.text.includes("Copy post &amp; open LinkedIn")]).toEqual([200, true]);
    // Each pass that deleted some is recorded; the one that deleted none is not.
    const recs = sql(db => db.prepare("SELECT details FROM orphan_events WHERE event_type='events_purged' ORDER BY rowid").all())
      .map(r => JSON.parse(r.details)).filter(dd => "share_links_purged" in dd);
    expect(recs.map(dd => dd.share_links_purged)).toEqual([1, 1]);
    // The certificates themselves are untouched.
    expect(badges(comp.id).filter(b => !b.revoked_at)).toHaveLength(4);
  });
});

// SWEEP #43, the other half: a deployment whose renderer has gone missing since
// its certificates were issued. With no stored copy to fall back on, the share
// image answers 503, as the PDF always has; a certificate issued while issues
// still stored one is served that copy. And neither the participant's mint nor
// the automatic issue issues a certificate nobody could download.
test.describe("sweep #43 — a deployment that has lost its renderer", () => {
  test("the share image is a 503 without a stored copy and an older certificate's copy is served, the PDF a 503; no certificate is issued, and the automatic issue waits", async () => {
    test.setTimeout(180_000);
    let sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { tasks: 2 });
    const held = await participant("nr43held"), older = await participant("nr43old"), later = await participant("nr43late");
    await assign(sa, comp.id, [held, older, later]);
    for (const p of [held, older, later]) expect((await play(p, comp.id, taskIds[0], "nope")).correct).toBe(false);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    await settleScheduler(sa);
    for (const p of [held, older]) {
      const r = await p.c.post(`/api/competitions/${comp.id}/badge`, {}, await p.c.h());
      expect(r.ok, `collected while the renderer was there: ${r.text}`).toBeTruthy();
    }
    const tok = (p) => badges(comp.id).find(b => b.user_id === p.id).token;
    // `older` stands for a certificate issued while issues still stored a copy.
    const OLD = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(`stored at an older issue ${stamp()}`)]);
    const oldId = `old43-${stamp()}`;
    sql(db => {
      db.prepare("INSERT INTO images (id, data, mime_type, created_at) VALUES (?,?,?,?)").run(oldId, OLD, "image/png", new Date().toISOString());
      db.prepare("UPDATE achievement_badges SET image_id=? WHERE token=?").run(oldId, tok(older));
    });
    expect(childOut, "CONTROL: a server with its renderer does not warn").not.toContain("achievement-badge rendering is unavailable");

    await kill();
    await boot({ noRenderer: true });
    try {
      expect(childOut, "PRECONDITION: this server has no renderer").toContain("achievement-badge rendering is unavailable");
      sa = await admin();
      const anon = client();
      // The share image: 503 without a stored copy; an older certificate's copy, served as it is.
      const none = await anon.get(`/badge/${tok(held)}/badge.png`);
      expect([none.status, none.body && none.body.error]).toEqual([503, "Badge rendering is unavailable."]);
      const stored = await anon.get(`/badge/${tok(older)}/badge.png`);
      expect(stored.status, stored.text.slice(0, 200)).toBe(200);
      expect(stored.headers.get("content-type")).toMatch(/^image\/png/);
      expect(stored.buf.equals(OLD), "the stored copy, byte for byte").toBe(true);
      const aNone = await sa.get(`/api/admin/competitions/${comp.id}/certificates/${held.id}/badge.png`);
      expect(aNone.status, "the organiser's download, likewise").toBe(503);
      const aStored = await sa.get(`/api/admin/competitions/${comp.id}/certificates/${older.id}/badge.png`);
      expect([aStored.status, aStored.buf.equals(OLD)]).toEqual([200, true]);
      // The PDF has never had a stored copy: 503 for both.
      for (const p of [held, older]) {
        const pdf = await anon.get(`/badge/${tok(p)}/certificate.pdf`);
        expect([pdf.status, pdf.body && pdf.body.error]).toEqual([503, "Certificate rendering is unavailable."]);
      }

      // No certificate nobody could download: the participant's own mint refuses…
      // (signed in again: a restart's new session secret ended the old session)
      const lc = client();
      await lc.post("/api/test/reset-recent-code-sends", {}, await lc.h());
      expect((await lc.post("/api/auth/code/request", { email: later.email }, await lc.h())).ok).toBeTruthy();
      const code = (await lc.get(`/api/test/last-login-code?email=${encodeURIComponent(later.email)}`)).body.code;
      const rd = await lc.post("/api/auth/code/redeem", { email: later.email, code }, await lc.h());
      expect(rd.body && rd.body.ok, `sign in again: ${rd.text}`).toBe(true);
      const mint = await lc.post(`/api/competitions/${comp.id}/badge`, {}, await lc.h());
      expect([mint.status, mint.body && mint.body.error]).toEqual([503, "Badge rendering is temporarily unavailable."]);
      expect(badges(comp.id).filter(b => b.user_id === later.id), "nothing issued to them").toEqual([]);
      // …and the automatic issue waits for the renderer, keeping its job.
      await tickFor(sa, comp.id);
      expect(badges(comp.id).filter(b => b.user_id === later.id), "the automatic issue issued nothing").toEqual([]);
      const job = jobs(comp.id);
      expect(job.map(j => j.last_error), "the job is kept, to try again").toEqual(["render_unavailable"]);
      expect(Date.parse(job[0].due_at)).toBeGreaterThan(Date.now());
      expect(sql(db => db.prepare("SELECT COUNT(*) AS n FROM images WHERE id=?").get(oldId).n), "the stored copy stays").toBe(1);
    } finally {
      await kill();
      await boot();
    }
  });
});
