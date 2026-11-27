"use strict";

// EVENT TEAM + PERSONA REPORTS — end to end on a spawned server with a capturing
// relay (tests/smtp-capture.js), the certificate-dispatch spec's harness.
//
// Locks:
//   * team CRUD, the allowed-domain refusal (empty list, wrong domain) and the
//     scope matrix: an event admin reads and manages their own event's team
//     (add, remove, Send now), not a decoy's, and the allowed-domain list binds
//     them as it binds every tier (they cannot read or change it); a superadmin
//     control reaches the decoy;
//   * every team report (wrap-up, delta, Monday digest, 48 h reminder, Send now)
//     and its preview is internal staff mail: no unsubscribe header, and a footer
//     line, in both parts and adding no link, says how to stop receiving them;
//   * a report whose pass throws is retried, and after the last pass given up:
//     the job goes, a warning is logged and the event's History says so;
//   * the built-in qualifying questions: seeded on a Booth Event by default, not
//     on a Competition, not when unticked; a pick-one answer is correct for any
//     option, scores 0, a non-option is refused 400; a qualifying challenge never
//     counts toward a Program's completion;
//   * lead classification BY VALUE: hot / warm / cold, new / returning /
//     possible duplicate, opted out;
//   * the SDR split is even and stable across a later report;
//   * each persona email: who receives it, exactly ONE link (the call to action),
//     the CRM CSV on Marketing's only, the repeated wrong answer in the SE's;
//   * timing: due at the end + 15 minutes, not run before; a revived event's job,
//     of any kind (the 48 h reminder too), is dropped, and the next end's report
//     queues the reminder again once; a re-end after an extension mails only the new leads; the 48 h
//     nudge goes only to an owner whose hot leads are uncontacted and have not
//     opted out (nothing when only opted-out ones wait);
//   * a removed member's address leaves the event's send ledger (sweep #149): its
//     rows stay under the domain and the mail's own `tm_` fingerprint, the Team
//     read says "removed member (domain)", the address added back takes them
//     back and is never sent a report twice, a send in flight settles on the
//     rewritten row and nothing more goes out to them, another role or another
//     event keeps the address, and the 48 h reminder still counts as sent; the
//     rows an older release left under a removed member's address are rewritten
//     once at boot, in the form of the one module db.js and the live paths share;
//   * Marketing's report with no leads attaches no file and says nobody has
//     taken part, once (its call to action's reason does not repeat it); a count
//     reads in the singular for one and in the plural for none or more, in every
//     mail;
//   * one meaning of waiting: the managers' scorecard ("Hot still to contact"),
//     its call to action and the report read count only hot leads
//     lib/event-team.js `isContactable` admits, and the contacted mark answers
//     that verdict (opting out read as the report reads it, by either address),
//     only to a role that reads the reports; never a copy: moving
//     the definition in process moves every mail's count, the reminder's too,
//     and a source arm pins each verdict the server sends to a call of it.

const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { PORT_BASE, findLogLine } = require("./helpers");
const { startSmtpCapture } = require("./smtp-capture");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = PORT_BASE + 192;
const BASE = `http://127.0.0.1:${PORT}`;
let smtp, child, childExit = null, dataDir, uploadsDir, superPass, childOut = "";

function parseMaybeJson(t) {
  try { return JSON.parse(t); } catch (_) { return t; }
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
    return { status: r.status, ok: r.status >= 200 && r.status < 300, body: parseMaybeJson(t), text: t };
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
  if (exited) throw new Error(`server exited (${exited.signal || `code ${exited.code}`}) before it was ready. Log:\n${childOut.slice(-2000)}`);
  throw new Error(`server never became ready (${lastErr && lastErr.message}). Log:\n${childOut.slice(-2000)}`);
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "teamrep-"));
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "teamrep-up-"));
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

async function codeSignIn(c, email) {
  await c.post("/api/test/reset-recent-code-sends", {}, await c.h());
  const rq = await c.post("/api/auth/code/request", { email }, await c.h());
  expect(rq.ok, rq.text).toBeTruthy();
  const code = (await c.get(`/api/test/last-login-code?email=${encodeURIComponent(email)}`)).body.code;
  return c.post("/api/auth/code/redeem", { email, code }, await c.h());
}

/** A verified, approved participant, signed in. */
async function person(tag, { first = "Pat", last = null, company = "Acme", title = "Engineer" } = {}) {
  const c = client();
  const s = stamp();
  const email = `${tag}-${s}@company.co`;
  const pr = await codeSignIn(c, email);   // an address proof for a new address
  expect(pr.body && pr.body.ok, `proof ${tag}: ${pr.text}`).toBe(true);
  const r = await c.post("/api/register", {
    firstName: first, lastName: last || `L${tag}${s}`.replace(/[^a-z0-9]/gi, ""), company, title,
    country: "US", timezone: "America/New_York", jobFunction: "", city: "",
  }, await c.h());
  expect(r.ok, `register ${tag}: ${r.status} ${r.text}`).toBeTruthy();
  const id = sql(db => db.prepare("SELECT id FROM users WHERE LOWER(email)=LOWER(?)").get(email).id);
  sql(db => db.prepare("UPDATE users SET verified=1, approved=1 WHERE id=?").run(id));
  return { c, email, id };
}

async function makeEvent(sa, { kind = "tournament", startAgoMs = 10 * 60_000, minutes = 600, extra = {}, tasks = 1 } = {}) {
  const data = { name: `Team ${kind} ${stamp()}`, event_kind: kind, start_time: new Date(Date.now() - startAgoMs).toISOString(), timezone: "UTC", ...extra };
  if (kind === "program") data.deadline_at = new Date(Date.now() + 90 * 86400e3).toISOString();
  else data.duration_minutes = minutes;
  const cr = await sa.post("/api/admin/competitions", data, await sa.h());
  expect(cr.ok, `create: ${cr.text}`).toBeTruthy();
  const comp = cr.body.competition;
  const taskIds = [];
  for (let i = 0; i < tasks; i++) {
    const tr = await sa.post("/api/admin/tasks", {
      title: `TR task ${stamp()}`, description: "<p>d</p>", difficulty: "easy",
      answer_type: "text", correct_answer: `right${i}`, status: "published",
    }, await sa.h());
    expect(tr.ok, tr.text).toBeTruthy();
    expect((await sa.post(`/api/admin/tasks/${tr.body.id}/competitions`, { competitionIds: [comp.id] }, await sa.h())).ok).toBeTruthy();
    taskIds.push(tr.body.id);
  }
  return { comp, taskIds };
}

const qTasks = (compId) => sql(db => db.prepare(
  `SELECT t.id, t.choices, tt.tag FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id JOIN task_tags tt ON tt.task_id=t.id AND tt.tag LIKE 'qualifying:%' WHERE ct.competition_id=?`
).all(compId)).map(r => ({ id: r.id, key: r.tag.slice("qualifying:".length), options: JSON.parse(r.choices) }));

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
async function answerQ(p, compId, q, key, optIndex) {
  const t = q.find(x => x.key === key);
  const r = await submit(p, compId, t.id, JSON.stringify([t.options[optIndex].id]));
  expect(r.ok, `answer ${key}: ${r.text}`).toBeTruthy();
  return r.body;
}

async function tick(sa, force = true) {
  const r = await sa.post("/api/test/team-report-tick", { force }, await sa.h());
  expect(r.ok, `tick: ${r.text}`).toBeTruthy();
  return r.body;
}

function decodeQP(s) { return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))); }
/** A MIME part's decoded body by content type, or null. */
function partOf(m, type) {
  const raw = m.raw.replace(/\r\n\.\./g, "\r\n.");
  const i = raw.search(new RegExp(`content-type:\\s*${type}`, "i"));
  if (i < 0) return null;
  const rest = raw.slice(i);
  const sep = rest.indexOf("\r\n\r\n");
  const end = rest.indexOf("\r\n--", sep);
  const head = rest.slice(0, sep);
  const b = rest.slice(sep + 4, end < 0 ? undefined : end);
  if (/base64/i.test(head)) return Buffer.from(b.replace(/\s+/g, ""), "base64").toString("utf8");
  if (/quoted-printable/i.test(head)) return Buffer.from(decodeQP(b), "latin1").toString("utf8");
  return b;
}
const htmlPart = (m) => partOf(m, "text/html") || "";
const textPart = (m) => partOf(m, "text/plain") || "";
const csvPart = (m) => partOf(m, "text/csv");
/** The subject, RFC 2047 decoded (nodemailer Q-encodes a non-ASCII one). */
const subjectOf = (m) => String(m.header("subject") || "").replace(/=\?UTF-8\?([QB])\?([^?]*)\?=\s*/gi, (_, enc, t) => enc.toUpperCase() === "B"
  ? Buffer.from(t, "base64").toString("utf8")
  : Buffer.from(t.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8"));
const mailsTo = (addr, since = 0) => smtp.messages.slice(since).filter(m => (m.rcptTo || []).some(a => a.toLowerCase() === addr.toLowerCase()));
// Every team report is internal staff mail (operator ruling, 24 Nov 2026): no
// unsubscribe header, and its footer says in words how to stop it, in both
// parts, adding no link (the call to action stays the one link).
const STOP_LINE = "To stop receiving these, ask the event's organiser to remove you.";
const STOP_LINE_HTML = STOP_LINE.replace(/'/g, "&#x27;");
function expectStopLine(m, who) {
  const html = htmlPart(m);
  expect(textPart(m), `${who}: the footer says how to stop these (plain part)`).toContain(STOP_LINE);
  expect(html, `${who}: and in the HTML part`).toContain(STOP_LINE_HTML);
  const foot = html.slice(html.indexOf('class="m-line"'));
  expect(foot, `PRECONDITION ${who}: the footer row`).toContain(STOP_LINE_HTML);
  expect(foot, `${who}: the footer adds no link`).not.toMatch(/<a\s/i);
  expect(m.header("list-unsubscribe"), `${who}: transactional, no unsubscribe header`).toBeFalsy();
}

test.describe("event team — membership, domains and scope", () => {
  test("domain allow-list refuses, team CRUD works, scope holds with a decoy event and a superadmin control", async () => {
    const sa = await admin();
    const { comp } = await makeEvent(sa);
    const { comp: decoy } = await makeEvent(sa);
    // Nothing allowed: a named refusal. The list is emptied here rather than
    // assumed, so the refusal does not depend on this test running first.
    expect((await sa.put("/api/admin/team-report-domains", { domains: [] }, await sa.h())).ok, "PRECONDITION: the allowed list is empty").toBeTruthy();
    let r = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "marketing", name: "Mia", email: "mia@corp.example" }, await sa.h());
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("team_domain_list_empty");
    r = await sa.put("/api/admin/team-report-domains", { domains: ["corp.example", "@Sales.Corp.Example", "corp.example"] }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    expect(r.body.domains).toEqual(["corp.example", "sales.corp.example"]);
    r = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "marketing", name: "Mia", email: "mia@gmail.com" }, await sa.h());
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("team_domain_not_allowed");
    r = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "marketing", name: "Mia", email: "mia@corp.example" }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    const memberId = r.body.member.id;
    r = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "boss", name: "X", email: "x@corp.example" }, await sa.h());
    expect(r.body.code).toBe("team_role_invalid");
    // Audit names the domain, never the address.
    const ev = sql(db => db.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type='team_member_added'").get(comp.id));
    expect(JSON.parse(ev.details).domain).toBe("corp.example");
    expect(ev.details).not.toContain("mia@corp.example");

    // An event admin of `comp` only.
    const ea = await person("ea");
    expect((await sa.post(`/api/admin/competitions/${comp.id}/admins`, { userId: ea.id }, await sa.h())).ok).toBeTruthy();
    const eac = client();
    const si = await codeSignIn(eac, ea.email);
    expect(si.body && si.body.ok, si.text).toBe(true);
    r = await eac.get(`/api/admin/competitions/${comp.id}/team`);
    expect(r.ok, r.text).toBeTruthy();
    expect(r.body.members.map(m => m.id)).toEqual([memberId]);
    expect(r.body.can_manage_team).toBe(true);
    expect((await eac.get(`/api/admin/competitions/${decoy.id}/team`)).status).toBe(403);
    expect((await eac.get(`/api/admin/competitions/${decoy.id}/team-report`)).status).toBe(403);
    // Their own event: any role, managers included; Send now; the domain still binds.
    r = await eac.post(`/api/admin/competitions/${comp.id}/team`, { role: "sales_manager", name: "Sam", email: "sam@corp.example" }, await eac.h());
    expect(r.ok, r.text).toBeTruthy();
    const eaMember = r.body.member.id;
    r = await eac.post(`/api/admin/competitions/${comp.id}/team`, { role: "sdr", name: "Eve", email: "eve@evil.example" }, await eac.h());
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("team_domain_not_allowed");
    r = await eac.post(`/api/admin/competitions/${comp.id}/team-report/send`, {}, await eac.h());
    expect(r.ok, r.text).toBeTruthy();
    r = await eac.del(`/api/admin/competitions/${comp.id}/team/${eaMember}`, await eac.h());
    expect(r.ok, r.text).toBeTruthy();
    // The event's History records both, with the request's context.
    const hist = sql(db => db.prepare("SELECT event_type, details FROM competition_events WHERE competition_id=? AND event_type IN ('team_member_added','team_member_removed') AND details LIKE ?").all(comp.id, `%${eaMember}%`));
    expect(hist.map(h => h.event_type).sort()).toEqual(["team_member_added", "team_member_removed"]);
    for (const h of hist) expect(JSON.parse(h.details).req_id, "reqContext").toBeTruthy();
    // Another event's team: refused, and unchanged BY VALUE.
    const decoyMember = (await sa.post(`/api/admin/competitions/${decoy.id}/team`, { role: "sdr", name: "Dee", email: "dee@corp.example" }, await sa.h())).body.member.id;
    expect((await eac.post(`/api/admin/competitions/${decoy.id}/team`, { role: "sdr", name: "Sneak", email: "sneak@corp.example" }, await eac.h())).status).toBe(403);
    expect((await eac.del(`/api/admin/competitions/${decoy.id}/team/${decoyMember}`, await eac.h())).status).toBe(403);
    expect((await eac.post(`/api/admin/competitions/${decoy.id}/team-report/send`, {}, await eac.h())).status).toBe(403);
    expect(sql(db => db.prepare("SELECT id FROM event_team_members WHERE competition_id=?").all(decoy.id).map(x => x.id))).toEqual([decoyMember]);
    // The list that bounds them is out of their reach.
    expect((await eac.put("/api/admin/team-report-domains", { domains: ["evil.example"] }, await eac.h())).status).toBe(403);
    expect((await eac.get("/api/admin/team-report-domains")).status).toBe(403);

    // A regular admin: any event, the same domain check, and not the domain list.
    const adm = await person("adm");
    expect((await sa.post(`/api/admin/participants/${adm.id}/role`, { role: "admin" }, await sa.h())).ok).toBeTruthy();
    const admc = client();
    expect((await codeSignIn(admc, adm.email)).body.ok).toBe(true);
    r = await admc.post(`/api/admin/competitions/${decoy.id}/team`, { role: "marketing", name: "Ada", email: "ada@corp.example" }, await admc.h());
    expect(r.ok, r.text).toBeTruthy();
    r = await admc.post(`/api/admin/competitions/${decoy.id}/team`, { role: "marketing", name: "Eve", email: "eve@evil.example" }, await admc.h());
    expect(r.body.code).toBe("team_domain_not_allowed");
    expect((await admc.post(`/api/admin/competitions/${decoy.id}/team-report/send`, {}, await admc.h())).ok).toBeTruthy();
    expect((await admc.del(`/api/admin/competitions/${decoy.id}/team/${decoyMember}`, await admc.h())).ok).toBeTruthy();
    expect((await admc.put("/api/admin/team-report-domains", { domains: ["evil.example"] }, await admc.h())).status).toBe(403);

    // The competitor lock binds every tier: the regular admin competing in an event.
    const { comp: compete } = await makeEvent(sa, { extra: { staff_compete: true }, tasks: 0 });
    sql(db => db.prepare("INSERT INTO competition_users (competition_id, user_id, assigned_at) VALUES (?,?,?)").run(compete.id, adm.id, new Date().toISOString()));
    r = await admc.post(`/api/admin/competitions/${compete.id}/team`, { role: "sdr", name: "Self", email: "self@corp.example" }, await admc.h());
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("competitor_cannot_edit");
    expect((await admc.post(`/api/admin/competitions/${compete.id}/team-report/send`, {}, await admc.h())).body.code).toBe("competitor_cannot_edit");
    expect((await admc.get(`/api/admin/competitions/${compete.id}/team-report`)).body.code).toBe("competitor_cannot_edit");
    r = await admc.get(`/api/admin/competitions/${compete.id}/team`);
    expect(r.body.can_manage_team).toBe(false);
    expect(r.body.manage_refusal).toContain("competing");
    expect((await sa.post(`/api/admin/competitions/${compete.id}/team`, { role: "sdr", name: "Other", email: "other@corp.example" }, await sa.h())).ok, "the built-in superadmin never competes").toBeTruthy();
    // …but may set the targets of their own event, and not of the decoy.
    r = await eac.put(`/api/admin/competitions/${comp.id}/team-targets`, { lead_target: 40, hot_lead_target: "5" }, await eac.h());
    expect(r.ok, r.text).toBeTruthy();
    expect(r.body.targets).toEqual({ lead_target: 40, hot_lead_target: 5 });
    expect((await eac.put(`/api/admin/competitions/${decoy.id}/team-targets`, { lead_target: 1 }, await eac.h())).status).toBe(403);
    // Superadmin control: the decoy is open to them, and removal works.
    expect((await sa.get(`/api/admin/competitions/${decoy.id}/team`)).ok).toBeTruthy();
    r = await sa.del(`/api/admin/competitions/${comp.id}/team/${memberId}`, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    expect((await sa.get(`/api/admin/competitions/${comp.id}/team`)).body.members).toEqual([]);
  });

  test("adding a recipient and Send now take what reading the reports takes: events.edit alone is refused, Marketing and SDR need export.data (built-in event admin CONTROL)", async () => {
    // A team member is mailed participants' details (and Marketing the CRM
    // file, each SDR a file of their own leads: operator ruling 79), so a role
    // that may not READ them here may not send them out either.
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp } = await makeEvent(sa, { tasks: 0 });
    const mkRole = async (label, permissions) => {
      const r = await sa.post("/api/admin/roles", { label: `${label} ${stamp()}`, scope_mode: "granted", permissions }, await sa.h());
      expect(r.ok, `create role ${label}: ${r.text}`).toBeTruthy();
      return r.body.role.id;
    };
    const holder = async (tag, roleId) => {
      const p = await person(tag);
      if (roleId) expect((await sa.post(`/api/admin/participants/${p.id}/role`, { role: roleId }, await sa.h())).ok, `give ${tag} its role`).toBeTruthy();
      const g = await sa.post(`/api/admin/competitions/${comp.id}/admins`, { userId: p.id }, await sa.h());
      expect(g.ok, `grant ${tag}: ${g.text}`).toBeTruthy();
      const c = client();
      expect((await codeSignIn(c, p.email)).body.ok, `${tag} signs in`).toBe(true);
      return c;
    };
    const editOnly = await holder("teamedit", await mkRole("Team editor", ["events.view", "events.edit"]));
    const noCrm = await holder("teamview", await mkRole("Team viewer", ["events.view", "events.edit", "participants.view"]));
    const ea = await holder("teamea", null);   // the built-in event admin: holds both
    const add = async (c, role, name) => c.post(`/api/admin/competitions/${comp.id}/team`, { role, name, email: `${name.toLowerCase()}-${stamp()}@corp.example` }, await c.h());
    const members = () => sql(db => db.prepare("SELECT role FROM event_team_members WHERE competition_id=? ORDER BY role").all(comp.id).map(m => m.role));

    // events.edit alone: no recipient of any role, and the GET says why.
    for (const role of ["marketing", "sdr"]) {
      const r = await add(editOnly, role, "Mallory");
      expect(r.status, `${role}: ${r.text}`).toBe(403);
      expect(r.body).toMatchObject({ code: "permission_denied", permission: "participants.view" });
    }
    let t = await editOnly.get(`/api/admin/competitions/${comp.id}/team`);
    expect(t.ok, t.text).toBeTruthy();
    expect(t.body.can_manage_team, "PRECONDITION: the competitor lock is not the reason").toBe(true);
    expect(t.body.add_refusal).toMatch(/participants' details/);
    expect(members(), "nothing was added").toEqual([]);

    // participants.view without export.data: every role but the two whose report
    // attaches a lead file (Marketing's CRM file, each SDR's own leads).
    let r = await add(noCrm, "sales", "Sal");
    expect(r.ok, `CONTROL: a role whose report carries no file: ${r.text}`).toBeTruthy();
    for (const role of ["marketing", "sdr"]) {
      r = await add(noCrm, role, "Mona");
      expect(r.status, `${role}: ${r.text}`).toBe(403);
      expect(r.body).toMatchObject({ code: "permission_denied", permission: "export.data" });
    }
    t = await noCrm.get(`/api/admin/competitions/${comp.id}/team`);
    expect(t.body.add_refusal, "may add some roles").toBeUndefined();
    expect(t.body.roles.find(x => x.id === "marketing").refusal).toMatch(/CRM file/);
    expect(t.body.roles.find(x => x.id === "sdr").refusal, "an SDR's report attaches their own leads").toMatch(/each SDR's own/);
    expect(t.body.roles.find(x => x.id === "sales").refusal, "CONTROL: Sales carries no file").toBeUndefined();
    expect(t.body.send_refusal, "no Marketing or SDR member yet, so Send now carries no lead file").toBeUndefined();
    expect(members()).toEqual(["sales"]);

    // CONTROL: the built-in event admin adds an SDR; then Send now would mail a
    // lead file, so the role without export.data is refused it, by name — the
    // SDR report alone too, and the Sales report alone is not.
    r = await add(ea, "sdr", "Sid");
    expect(r.ok, r.text).toBeTruthy();
    expect(members()).toEqual(["sales", "sdr"]);
    r = await noCrm.post(`/api/admin/competitions/${comp.id}/team-report/send`, {}, await noCrm.h());
    expect(r.status, r.text).toBe(403);
    expect(r.body.permission).toBe("export.data");
    r = await noCrm.post(`/api/admin/competitions/${comp.id}/team-report/send`, { persona: "sdr" }, await noCrm.h());
    expect(r.status, `the SDR report attaches the SDR's leads: ${r.text}`).toBe(403);
    expect(r.body.permission).toBe("export.data");
    r = await noCrm.post(`/api/admin/competitions/${comp.id}/team-report/send`, { persona: "sales" }, await noCrm.h());
    expect(r.ok, `CONTROL: the Sales report alone carries no file: ${r.text}`).toBeTruthy();
    expect((await noCrm.get(`/api/admin/competitions/${comp.id}/team`)).body.send_refusal).toMatch(/lead files/);
    r = await editOnly.post(`/api/admin/competitions/${comp.id}/team-report/send`, { persona: "sales" }, await editOnly.h());
    expect(r.status, r.text).toBe(403);
    expect(r.body.permission).toBe("participants.view");
    r = await add(ea, "marketing", "Mia");
    expect(r.ok, r.text).toBeTruthy();
    r = await ea.post(`/api/admin/competitions/${comp.id}/team-report/send`, {}, await ea.h());
    expect(r.ok, `CONTROL: the built-in event admin sends every report: ${r.text}`).toBeTruthy();
  });
});

test.describe("qualifying questions", () => {
  test("seeded on a Booth Event by default only; a pick-one answer is correct, scores 0, a non-option is refused", async () => {
    const sa = await admin();
    const { comp: booth, taskIds } = await makeEvent(sa, { kind: "booth", minutes: 120 });
    const q = qTasks(booth.id);
    expect(q.map(x => x.key).sort()).toEqual(["developers", "evaluating", "follow_up", "scanner"]);
    const { comp: tour } = await makeEvent(sa, { kind: "tournament" });
    expect(qTasks(tour.id)).toEqual([]);
    const { comp: off } = await makeEvent(sa, { kind: "booth", minutes: 120, extra: { add_qualifying: false } });
    expect(qTasks(off.id)).toEqual([]);
    const { comp: on } = await makeEvent(sa, { kind: "tournament", extra: { add_qualifying: true } });
    expect(qTasks(on.id).length).toBe(4);

    const p = await person("q1");
    await assign(sa, booth.id, [p]);
    await enter(p, booth.id);
    const dev = q.find(x => x.key === "developers");
    expect((await submit(p, booth.id, dev.id, JSON.stringify(["deadbeef"]))).status).toBe(400);
    expect((await submit(p, booth.id, dev.id, JSON.stringify([dev.options[0].id, dev.options[1].id]))).status).toBe(400);
    const okr = await submit(p, booth.id, dev.id, JSON.stringify([dev.options[3].id]));
    expect(okr.ok, okr.text).toBeTruthy();
    expect(okr.body.correct).toBe(true);
    const row = sql(db => db.prepare("SELECT is_correct, points_delta, answer, answer_canonical FROM submissions WHERE user_id=? AND task_id=?").get(p.id, dev.id));
    expect(row).toEqual({ is_correct: 1, points_delta: 0, answer: "1000+", answer_canonical: JSON.stringify([dev.options[3].id]) });
    // Negative control: the scored challenge still scores its points.
    const scored = await submit(p, booth.id, taskIds[0], "right0");
    expect(scored.body.correct).toBe(true);
    expect(sql(db => db.prepare("SELECT points_delta FROM submissions WHERE user_id=? AND task_id=?").get(p.id, taskIds[0]).points_delta)).toBe(50);
    // The participant list marks it, and never sends the tag.
    const list = await p.c.get("/api/tasks", { "x-competition-id": booth.id });
    expect(list.body.find(t => t.id === dev.id).qualifying).toBe(true);
    expect(list.body.find(t => t.id === taskIds[0]).qualifying).toBe(false);
    expect(JSON.stringify(list.body)).not.toContain("qualifying:");
  });

  test("the early end waits for the quick questions; a changed or incomplete quick answer ends nothing (operator ruling, 17 Nov 2026)", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { kind: "tournament", extra: { add_qualifying: true, self_enroll_enabled: true } });
    const q = qTasks(comp.id);
    expect(q.length, "PRECONDITION: the four qualifying questions").toBe(4);
    const endedAt = () => sql(db => db.prepare("SELECT ended_at FROM competitions WHERE id=?").get(comp.id).ended_at);
    const a = await person("allin");
    await assign(sa, comp.id, [a]);
    await enter(a, comp.id);
    // Finished while the link is open: the all-solved check is skipped.
    expect((await submit(a, comp.id, taskIds[0], "right0")).body.correct).toBe(true);
    expect(endedAt(), "PRECONDITION: an open link keeps it live").toBeNull();
    const shut = await sa.put(`/api/admin/competitions/${comp.id}`, { self_enroll_enabled: false }, await sa.h());
    expect(shut.ok, shut.text).toBeTruthy();
    // The link is closed and the one player has finished, but three quick questions are unanswered.
    await answerQ(a, comp.id, q, "developers", 1);
    expect(endedAt(), "a quick answer that leaves quick questions unanswered ends nothing").toBeNull();
    // A second player finishes the scoring challenges: the early end now waits for the quick questions.
    const b = await person("closer");
    await assign(sa, comp.id, [b]);
    await enter(b, comp.id);
    expect((await submit(b, comp.id, taskIds[0], "right0")).body.correct).toBe(true);
    expect(endedAt(), "everyone solved everything, yet quick questions are unanswered: still live").toBeNull();
    for (const k of ["scanner", "evaluating", "follow_up"]) await answerQ(a, comp.id, q, k, 0);
    await answerQ(a, comp.id, q, "developers", 2);   // a CHANGED answer completes nothing
    for (const k of ["developers", "scanner", "evaluating"]) await answerQ(b, comp.id, q, k, 0);
    expect(endedAt(), "one quick question is still unanswered").toBeNull();
    await answerQ(b, comp.id, q, "follow_up", 0);
    expect(endedAt(), "the last missing quick answer ends it").not.toBeNull();
  });

  test("a changed quick answer never ends an event its players all completed while the link was open", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { kind: "tournament", extra: { add_qualifying: true, self_enroll_enabled: true } });
    const q = qTasks(comp.id);
    const endedAt = () => sql(db => db.prepare("SELECT ended_at FROM competitions WHERE id=?").get(comp.id).ended_at);
    const a = await person("donelink");
    await assign(sa, comp.id, [a]);
    await enter(a, comp.id);
    expect((await submit(a, comp.id, taskIds[0], "right0")).body.correct).toBe(true);
    for (const k of ["developers", "scanner", "evaluating", "follow_up"]) await answerQ(a, comp.id, q, k, 0);
    expect(endedAt(), "PRECONDITION: an open link keeps it live").toBeNull();
    expect((await sa.put(`/api/admin/competitions/${comp.id}`, { self_enroll_enabled: false }, await sa.h())).ok).toBeTruthy();
    await answerQ(a, comp.id, q, "follow_up", 1);   // changed: completes nothing
    expect(endedAt(), "a changed quick answer must not end the event").toBeNull();
    // CONTROL: a newcomer who completes everything does end it.
    const b = await person("donenew");
    await assign(sa, comp.id, [b]);
    await enter(b, comp.id);
    expect((await submit(b, comp.id, taskIds[0], "right0")).body.correct).toBe(true);
    for (const k of ["developers", "scanner", "evaluating", "follow_up"]) await answerQ(b, comp.id, q, k, 0);
    expect(endedAt(), "CONTROL: the newcomer's last quick answer ends it").not.toBeNull();
  });

  test("a qualifying challenge never counts toward a Program's completion", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { kind: "program", extra: { add_qualifying: true } });
    expect(qTasks(comp.id).length).toBe(4);
    const p = await person("prog");
    await assign(sa, comp.id, [p]);
    await enter(p, comp.id);
    const r = await submit(p, comp.id, taskIds[0], "right0");
    expect(r.body.correct).toBe(true);
    // Completed WITHOUT answering any qualifying question: the per-person certificate job exists.
    const job = sql(db => db.prepare("SELECT 1 AS x FROM certificate_dispatch_jobs WHERE competition_id=? AND user_id=?").get(comp.id, p.id));
    expect(job, "the completion certificate is queued").toBeTruthy();
  });
});

test.describe("leads, reports and timing", () => {
  // Its tests read what earlier ones in it made (the leads' owners, the nudge
  // job): serial, so a failure retries the chain from its beforeAll rather than
  // resuming mid-chain on state that is not there.
  test.describe.configure({ mode: "serial" });
  let sa, comp, taskIds, q;
  const ps = {}, team = {};

  test.beforeAll(async () => {
    sa = await admin();
    // company.co too: the one team member whose address is an admin account (Ada).
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example", "company.co"] }, await sa.h())).ok).toBeTruthy();
    // An EARLIER event, for the returning person.
    // (A Program started 40 days ago: still live, so the assign is accepted.)
    const earlier = await makeEvent(sa, { kind: "program", startAgoMs: 40 * 86400e3, tasks: 0 });
    ({ comp, taskIds } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 2 }));
    q = qTasks(comp.id);
    ps.hot1 = await person("hot1", { company: "Big Corp Inc.", title: "VP Engineering" });
    ps.hot2 = await person("hot2", { company: "Other Ltd", title: "Developer" });
    ps.warm = await person("warm", { company: "big corp", title: "Engineer" });
    ps.cold = await person("cold", { company: "Solo" });
    ps.ret = await person("ret", { company: "Ret Co" });
    ps.dupA = await person("dupa", { first: "Dana", last: "Twin", company: "Twin Labs" });
    ps.dupB = await person("dupb", { first: "Dana", last: "Twin", company: "Twin Labs, LLC" });
    sql(db => db.prepare("UPDATE users SET created_at=? WHERE id=?").run(new Date(Date.now() - 50 * 86400e3).toISOString(), ps.ret.id));
    await assign(sa, earlier.comp.id, [ps.ret]);
    await assign(sa, comp.id, Object.values(ps));
    for (const p of Object.values(ps)) await enter(p, comp.id);
    await answerQ(ps.hot1, comp.id, q, "developers", 3);
    await answerQ(ps.hot1, comp.id, q, "evaluating", 1);
    await answerQ(ps.hot2, comp.id, q, "follow_up", 0);
    await answerQ(ps.warm, comp.id, q, "developers", 2);
    await answerQ(ps.warm, comp.id, q, "evaluating", 3);
    // hot1 solves one scored challenge and keeps getting the other wrong.
    expect((await submit(ps.hot1, comp.id, taskIds[0], "right0")).body.correct).toBe(true);
    for (const p of [ps.hot1, ps.hot2, ps.warm]) await submit(p, comp.id, taskIds[1], "nope");
    await submit(ps.hot1, comp.id, taskIds[1], "still wrong");   // (a different answer: the same one inside 3 s is folded)
    // hot2's address is on the unsubscribe list: kept, marked "do not email".
    sql(db => db.prepare("INSERT INTO unsubscribed_emails (email, unsubscribed_at) VALUES (?,?)").run(ps.hot2.email.toLowerCase(), new Date().toISOString()));
    const add = async (role, name) => {
      const email = `${name.toLowerCase()}-${stamp()}@corp.example`;
      const r = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role, name, email }, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
      team[name] = { ...r.body.member, email };
    };
    await add("se", "Sean"); await add("marketing", "Mia"); await add("sales", "Sal");
    await add("sdr", "Sid"); await add("sdr", "Sue"); await add("marketing_manager", "Max");
    // Ada: a second SE whose address IS an account that can open the event (an
    // administrator), so hers is the one email with a button (operator ruling 79).
    const ada = await person("ada", { first: "Ada" });
    expect((await sa.post(`/api/admin/participants/${ada.id}/role`, { role: "admin" }, await sa.h())).ok, "Ada is an administrator").toBeTruthy();
    const ar = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "se", name: "Ada", email: ada.email }, await sa.h());
    expect(ar.ok, ar.text).toBeTruthy();
    team.Ada = { ...ar.body.member, email: ada.email };
    expect((await sa.put(`/api/admin/competitions/${comp.id}/team-targets`, { lead_target: 10, hot_lead_target: 3 }, await sa.h())).ok).toBeTruthy();
  });

  test("leads are classified by value", async () => {
    const r = await sa.get(`/api/admin/competitions/${comp.id}/team-report`);
    expect(r.ok, r.text).toBeTruthy();
    const by = Object.fromEntries(r.body.leads.map(l => [l.user_id, l]));
    expect(r.body.leads.length).toBe(7);
    expect(by[ps.hot1.id].signal).toBe("hot");
    expect(by[ps.hot2.id].signal).toBe("hot");
    expect(by[ps.warm.id].signal).toBe("warm");
    expect(by[ps.cold.id].signal).toBe("cold");
    expect(by[ps.ret.id].status).toBe("returning");
    expect(by[ps.cold.id].status).toBe("new");
    expect(by[ps.dupA.id].status).toBe("possible_duplicate");
    expect(by[ps.dupB.id].status).toBe("possible_duplicate");
    expect(by[ps.hot2.id].opted_out).toBe(true);
    expect(by[ps.hot1.id].opted_out).toBe(false);
    expect(by[ps.hot1.id].answers.developers).toBe("1000+");
    expect(by[ps.hot1.id].struggles.length).toBe(1);
    expect(by[ps.ret.id].other_events.length).toBe(1);
    // Sales groups "Big Corp Inc." with "big corp".
    const big = r.body.accounts.find(a => a.key === "big");   // "corp" and "inc" are legal suffixes
    expect(big.people).toBe(2);
    expect(big.top_title).toBe("VP Engineering");
    expect(r.body.summary.hot).toBe(2);
    // The SDR split is even (7 leads, 2 SDRs: 4 and 3).
    const counts = r.body.owners.map(o => r.body.leads.filter(l => l.owner_member_id === o.id).length).sort();
    expect(counts).toEqual([3, 4]);
  });

  test("the wrap-up is due 15 minutes after the end, not before; each persona gets one email, a button only where the address opens the event", async () => {
    const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h());
    expect(end.ok, end.text).toBeTruthy();
    const job = sql(db => db.prepare("SELECT * FROM team_report_jobs WHERE competition_id=? AND kind='wrapup'").get(comp.id));
    expect(job, "the wrap-up is queued by the end path").toBeTruthy();
    const lag = Date.parse(job.due_at) - Date.parse(job.end_key);
    expect(lag).toBeGreaterThanOrEqual(15 * 60_000 - 2000);
    expect(lag).toBeLessThanOrEqual(15 * 60_000 + 60_000);
    const before = smtp.messages.length;
    const t0 = await tick(sa, false);
    expect(t0.runs).toBe(0);
    expect(smtp.messages.length).toBe(before);
    const pre = (await sa.get(`/api/admin/competitions/${comp.id}/team-report`)).body.leads.map(l => [l.user_id, l.owner_member_id]);
    const t1 = await tick(sa, true);
    expect(t1.runs).toBe(1);
    const got = (name) => mailsTo(team[name].email, before);
    for (const n of ["Sean", "Mia", "Sal", "Sid", "Sue", "Max", "Ada"]) expect(got(n).length, `${n} gets exactly one email`).toBe(1);
    for (const n of ["Sean", "Mia", "Sal", "Sid", "Sue", "Max", "Ada"]) expectStopLine(got(n)[0], `wrap-up to ${n}`);
    // Operator ruling 79: the call to action is a button, the email's one link,
    // only for an address that is an account able to open the event (Ada, an
    // administrator); everyone else is told the step in words they can act on
    // without the page, and sent no link and no address at all.
    {
      const html = htmlPart(got("Ada")[0]);
      expect((html.match(/<a\s/gi) || []).length, "Ada: exactly one link, the call to action").toBe(1);
      expect(html).toContain(`/?event=${comp.id}&amp;section=`);
      expect(textPart(got("Ada")[0]), "CONTROL: no words in place of her button").not.toContain("This email has no link");
    }
    for (const n of ["Sean", "Mia", "Sal", "Sid", "Sue", "Max"]) {
      const html = htmlPart(got(n)[0]), text = textPart(got(n)[0]);
      expect((html.match(/<a\s/gi) || []).length, `${n}: no account, so no link`).toBe(0);
      expect(html, `${n}: no event address to follow`).not.toContain(`/?event=`);
      expect(text, `${n}: nor in the plain part`).not.toContain(`/?event=`);
      expect(text, `${n}: the step in words`).toMatch(/\nNext: [^\r\n]+\.\r?\n/);
      expect(text, `${n}: and what to do instead`).toContain("This email has no link: your address is not an account that can open this event");
    }
    // No step that needs the page they cannot open (a button's words: download,
    // open, edit, resend, clone, assign, review the event), in either part…
    const nextOf = (n) => { const m = textPart(got(n)[0]).match(/\nNext: ([^\r\n]+)\.\r?\n/); return m ? m[1] : null; };
    for (const n of ["Sean", "Mia", "Sal", "Sid", "Sue", "Max"]) {
      expect(nextOf(n), `${n}: a step they can take without the page`).not.toMatch(/^(Download|Open|Edit|Resend|Clone|Assign|Review the event)\b/);
      expect(htmlPart(got(n)[0]), `${n}: in the HTML part too`).not.toMatch(/class="m-fg m-next"[^>]*>Next: (Download|Open|Edit|Resend|Clone|Assign|Review the event)\b/);
    }
    // …by value: Marketing loads the attached file, the manager reads the
    // scorecard below, and the SE asks the organiser to make the edit Ada's
    // button opens (Sean and Ada are both SEs).
    expect(nextOf("Mia")).toBe("Load the attached file (7 leads) into the CRM");
    expect(nextOf("Max")).toBe("Read the scorecard below");
    const adaStep = (textPart(got("Ada")[0]).match(/\n([^\n]+)\r?\nAddress \(sign-in needed\)/) || [])[1];
    expect(adaStep, "PRECONDITION: Ada's plain part names the button's step, an edit").toMatch(/^Edit "/);
    expect(nextOf("Sean")).toBe(`Ask the event's organiser to edit ${adaStep.trim().slice("Edit ".length)}`);
    // CONTROL: a step that needs no page keeps the button's own words.
    expect(nextOf("Sal"), "Sales: the account to meet, the button's words").toMatch(/^(Plan the .+ meeting|Review .+)$/);
    // The subject line carries the finding, by value.
    expect(subjectOf(got("Sean")[0])).toContain("is over: 3 played");
    expect(subjectOf(got("Mia")[0])).toContain("7 leads from");
    expect(subjectOf(got("Mia")[0])).toContain("2 hot (target was 3)");
    expect(subjectOf(got("Max")[0])).toContain("7 leads (70% of target), 2 hot");
    // Marketing's carries the CRM file; each SDR's a file of THEIR leads (ruling
    // 79, below); nobody else's carries one.
    const csv = csvPart(got("Mia")[0]);
    expect(csv).toContain(ps.hot1.email);
    expect(csv).toContain("1000+");
    expect(csv.trim().split(/\r?\n/).length).toBe(8);   // header + 7 people
    for (const n of ["Sean", "Sal", "Max", "Ada"]) expect(csvPart(got(n)[0]), `${n}: no file`).toBeNull();
    // The SE email quotes the repeated wrong answer (an unsealed challenge).
    expect(textPart(got("Sean")[0])).toContain("nope");
    // Each SDR is sent only their own share, and the stored split matches the preview.
    const post = (await sa.get(`/api/admin/competitions/${comp.id}/team-report`)).body.leads;
    expect(post.map(l => [l.user_id, l.owner_member_id])).toEqual(pre);
    for (const n of ["Sid", "Sue"]) {
      const body = textPart(got(n)[0]);
      // (The two possible duplicates share one name, so a name proves nothing for them.)
      for (const l of post.filter(x => !x.possible_duplicate)) {
        const nm = `${l.first_name} ${l.last_name}`;
        if (l.owner_member_id === team[n].id) expect(body).toContain(nm); else expect(body).not.toContain(nm);
      }
      // Operator ruling 79: each card carries the lead's address, and the file
      // attached holds exactly this SDR's leads (by address; a duplicate's
      // address is its own), never another SDR's.
      const own = post.filter(x => x.owner_member_id === team[n].id), others = post.filter(x => x.owner_member_id !== team[n].id);
      expect(own.length, `PRECONDITION: ${n} owns leads`).toBeGreaterThan(0);
      expect(others.length, `PRECONDITION: ${n} does not own them all`).toBeGreaterThan(0);
      const html = htmlPart(got(n)[0]), file = csvPart(got(n)[0]);
      expect(file, `${n}'s report attaches a file`).toBeTruthy();
      expect(file.trim().split(/\r?\n/).length, `${n}: header + their own ${own.length}`).toBe(1 + own.length);
      for (const l of own) {
        expect(body, `${n}'s card for ${l.email} carries the address`).toContain(`Email: ${l.email}`);
        expect(html).toContain(l.email);
        expect(file, `${n}'s file holds ${l.email}`).toContain(l.email);
      }
      for (const l of others) {
        expect(file, `${n}'s file never holds another SDR's lead ${l.email}`).not.toContain(l.email);
        expect(body).not.toContain(l.email);
      }
    }
    // Never twice: the run and every send are in the ledger, and the same end
    // re-queued (another end path noticing it) is dropped without a mail.
    expect(sql(db => db.prepare("SELECT COUNT(*) AS c FROM team_report_runs WHERE competition_id=? AND kind='wrapup'").get(comp.id).c)).toBe(1);
    expect(sql(db => db.prepare("SELECT COUNT(*) AS c FROM team_report_sends WHERE competition_id=? AND kind='wrapup' AND status='sent'").get(comp.id).c)).toBe(7);
    sql(db => db.prepare("INSERT INTO team_report_jobs (competition_id, kind, end_key, due_at, enqueued_at) VALUES (?,?,?,?,?)").run(comp.id, "wrapup", job.end_key, new Date(0).toISOString(), new Date().toISOString()));
    const n1 = smtp.messages.length;
    await tick(sa, false);
    expect(mailsTo(team.Mia.email, n1).length).toBe(0);
  });

  test("a re-end after an extension mails only the new leads; the stored split is kept", async () => {
    const put = await sa.put(`/api/admin/competitions/${comp.id}`, { duration_minutes: 900 }, await sa.h());
    expect(put.ok, `revive: ${put.text}`).toBeTruthy();
    expect(put.body.competition.status).toBe("live");
    const late = await person("newbie", { company: "Fresh Co" });
    await assign(sa, comp.id, [late]);
    // Swap two stored owners, so "kept" cannot pass by the split recomputing the same answer.
    sql(db => {
      const rows = db.prepare("SELECT user_id, owner_member_id FROM event_leads WHERE competition_id=? ORDER BY user_id").all(comp.id);
      const a = rows[0], b = rows.find(r => r.owner_member_id !== a.owner_member_id);
      const up = db.prepare("UPDATE event_leads SET owner_member_id=? WHERE competition_id=? AND user_id=?");
      up.run(b.owner_member_id, comp.id, a.user_id);
      up.run(a.owner_member_id, comp.id, b.user_id);
    });
    const ownersBefore = sql(db => db.prepare("SELECT user_id, owner_member_id FROM event_leads WHERE competition_id=? ORDER BY user_id").all(comp.id));
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    expect(sql(db => db.prepare("SELECT end_key FROM team_report_jobs WHERE competition_id=? AND kind='delta'").get(comp.id)).end_key).toMatch(/^end:/);
    // Make the delta due (not forced: the 48 h nudge must stay waiting).
    sql(db => db.prepare("UPDATE team_report_jobs SET due_at=? WHERE competition_id=? AND kind='delta'").run(new Date(0).toISOString(), comp.id));
    const before = smtp.messages.length;
    await tick(sa, false);
    const mia = mailsTo(team.Mia.email, before).filter(m => /1 new lead since the last report/i.test(subjectOf(m)));
    expect(mia.length).toBe(1);
    expectStopLine(mia[0], "delta to Mia");
    // Ruling 79: Mia's address opens nothing, so the step is one she can take.
    expect(textPart(mia[0])).toContain("\nNext: Load the attached file (1 new lead) into the CRM.");
    const csv = csvPart(mia[0]);
    expect(csv.trim().split(/\r?\n/).length, "header + only the new person").toBe(2);
    expect(csv).toContain(late.email);
    expect(csv).not.toContain(ps.hot1.email);
    expect(mailsTo(team.Sean.email, before).length, "the SE gets no delta").toBe(0);
    const ownersAfter = sql(db => db.prepare("SELECT user_id, owner_member_id FROM event_leads WHERE competition_id=? AND user_id != ? ORDER BY user_id").all(comp.id, late.id));
    expect(ownersAfter).toEqual(ownersBefore);
  });

  test("the 48 h nudge goes only to an owner with uncontacted hot leads", async () => {
    const leads = (await sa.get(`/api/admin/competitions/${comp.id}/team-report`)).body.leads;
    const h1 = leads.find(l => l.user_id === ps.hot1.id), h2 = leads.find(l => l.user_id === ps.hot2.id);
    // Contact hot2; leave hot1 uncontacted.
    const c = await sa.post(`/api/admin/competitions/${comp.id}/leads/${ps.hot2.id}/contacted`, { contacted: true }, await sa.h());
    expect(c.ok, c.text).toBeTruthy();
    const ownerName = ["Sid", "Sue"].find(n => team[n].id === h1.owner_member_id);
    const otherSdr = ["Sid", "Sue"].find(n => n !== ownerName);
    expect(h2.owner_member_id === team[otherSdr].id || h2.owner_member_id === team[ownerName].id).toBe(true);
    const nj = sql(db => db.prepare("SELECT due_at FROM team_report_jobs WHERE competition_id=? AND kind='nudge'").get(comp.id));
    expect(Date.parse(nj.due_at) - Date.now(), "the nudge waits about 48 hours").toBeGreaterThan(47 * 3600e3);
    sql(db => db.prepare("UPDATE team_report_jobs SET due_at=? WHERE competition_id=? AND kind='nudge'").run(new Date(0).toISOString(), comp.id));
    const before = smtp.messages.length;
    await tick(sa, false);
    const reminders = (n) => mailsTo(team[n].email, before).filter(m => /reminder/i.test(subjectOf(m)));
    expect(reminders(ownerName).length).toBe(1);
    expectStopLine(reminders(ownerName)[0], "48 h reminder to the SDR");
    expect(textPart(reminders(ownerName)[0])).not.toContain(`${h2.first_name} ${h2.last_name}`);
    // Ruling 79: the reminder's card carries the address; it attaches no file
    // (the report it follows up did).
    expect(textPart(reminders(ownerName)[0])).toContain(`Email: ${ps.hot1.email}`);
    expect(csvPart(reminders(ownerName)[0]), "the reminder carries no file").toBeNull();
    expect(reminders(otherSdr).length).toBe(0);
    // Marketing is told how many wait; Sales and the SE are not nudged.
    expect(reminders("Mia").length).toBe(1);
    expectStopLine(reminders("Mia")[0], "48 h reminder to Marketing");
    // Ruling 79: and, with no way into the event's page, what to do about them.
    // Waiting: hot, not contacted, not opted out (the reminder's count).
    const waitingN = (await sa.get(`/api/admin/competitions/${comp.id}/team-report`)).body.leads.filter(l => l.signal === "hot" && !l.contacted_at && !l.opted_out).length;
    expect(waitingN, "PRECONDITION: hot leads wait").toBeGreaterThan(0);
    expect(textPart(reminders("Mia")[0])).toContain(`\nNext: Make sure the ${waitingN === 1 ? "1 hot lead is" : `${waitingN} hot leads are`} contacted.`);
    expect(mailsTo(team.Sal.email, before).length).toBe(0);
    expect(mailsTo(team.Sean.email, before).length).toBe(0);
  });
});

test.describe("the other paths", () => {
  const addMember = async (sa, compId, role, name) => {
    const email = `${name.toLowerCase()}-${stamp()}@corp.example`;
    const r = await sa.post(`/api/admin/competitions/${compId}/team`, { role, name, email }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    return { ...r.body.member, email };
  };

  test("Close late entries sends only the late leads; with no SDR the leads go to Marketing", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp } = await makeEvent(sa, { kind: "booth", minutes: 120 });
    const early = await person("early", { company: "Early Co" });
    await assign(sa, comp.id, [early]);
    const mia = await addMember(sa, comp.id, "marketing", "Mona");
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    sql(db => db.prepare("UPDATE team_report_jobs SET due_at=? WHERE competition_id=? AND kind='wrapup'").run(new Date(0).toISOString(), comp.id));
    let before = smtp.messages.length;
    await tick(sa, false);
    // Marketing owns the leads: their report AND the cards.
    const first = mailsTo(mia.email, before).map(subjectOf);
    // One lead reads in the singular (operator ruling, 14 Nov 2026).
    expect(first.some(s => /— 1 lead from /.test(s)), first.join(" | ")).toBe(true);
    expect(first.some(s => /Your 1 follow-up from/.test(s)), first.join(" | ")).toBe(true);
    // The late window is open: a delta waits for its close.
    expect(sql(db => db.prepare("SELECT end_key FROM team_report_jobs WHERE competition_id=? AND kind='delta'").get(comp.id)).end_key).toMatch(/^late:/);

    const late = await person("lately", { company: "Late Co" });
    await assign(sa, comp.id, [late]);
    const close = await sa.post(`/api/admin/competitions/${comp.id}/late-entry/close`, {}, await sa.h());
    expect(close.ok, close.text).toBeTruthy();
    sql(db => db.prepare("UPDATE team_report_jobs SET due_at=? WHERE competition_id=? AND kind='delta'").run(new Date(0).toISOString(), comp.id));
    before = smtp.messages.length;
    await tick(sa, false);
    const delta = mailsTo(mia.email, before).filter(m => /1 new lead since the last report/i.test(subjectOf(m)) && csvPart(m));
    expect(delta.length).toBe(1);
    expectStopLine(delta[0], "late-entries delta");
    const csv = csvPart(delta[0]);
    expect(csv).toContain(late.email);
    expect(csv).not.toContain(early.email);
  });

  test("a Booth Event ended again after its wrap-up queues the new late window's delta once the end's own delta has run", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp } = await makeEvent(sa, { kind: "booth", minutes: 120 });
    await assign(sa, comp.id, [await person("first", { company: "First Co" })]);
    await addMember(sa, comp.id, "marketing", "Mara");
    const deltaKey = () => (sql(db => db.prepare("SELECT end_key FROM team_report_jobs WHERE competition_id=? AND kind='delta'").get(comp.id)) || {}).end_key;
    const dueNow = (kind) => sql(db => db.prepare("UPDATE team_report_jobs SET due_at=? WHERE competition_id=? AND kind=?").run(new Date(0).toISOString(), comp.id, kind));
    // The scheduler runs by itself every 60 s; its pass that first sees an end
    // queues the reports again (resetting the job's due time), so settle it first.
    const settle = async () => expect((await sa.post("/api/test/scheduler-tick", {}, await sa.h())).ok).toBeTruthy();
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    await settle();
    dueNow("wrapup");
    await tick(sa, false);
    expect(deltaKey(), "PRECONDITION: the wrap-up queued the late delta").toMatch(/^late:/);
    // Extended and ended again: that end's own delta replaces the pending one.
    const put = await sa.put(`/api/admin/competitions/${comp.id}`, { duration_minutes: 600 }, await sa.h());
    expect(put.ok && put.body.competition.status === "live", `revive: ${put.text}`).toBe(true);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    await settle();
    expect(deltaKey()).toMatch(/^end:/);
    dueNow("delta");
    await tick(sa, false);
    const key = deltaKey();
    expect(key, "the new window is open, so its close is queued again").toMatch(/^late:/);
    expect(Date.parse(key.slice("late:".length)), "at the new window's close").toBeGreaterThan(Date.now());
  });

  test("a domain removed from the list stops the mail at send time; a dry-run event and an empty team send nothing", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp } = await makeEvent(sa, { tasks: 2 });
    const m = await addMember(sa, comp.id, "sales", "Sally");
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["other.example"] }, await sa.h())).ok).toBeTruthy();
    const before = smtp.messages.length;
    const r = await sa.post(`/api/admin/competitions/${comp.id}/team-report/send`, {}, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    expect(r.body.refused).toBe(1);
    expect(r.body.sent).toBe(0);
    expect(mailsTo(m.email, before).length).toBe(0);
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    // Dry run: refused by name, and its job is dropped.
    const { comp: dry } = await makeEvent(sa, { tasks: 2, extra: { tags: ["test/dry run"] } });
    const dm = await addMember(sa, dry.id, "sales", "Dry");
    expect((await sa.post(`/api/admin/competitions/${dry.id}/team-report/send`, {}, await sa.h())).body.code).toBe("team_dry_run");
    expect((await sa.post(`/api/admin/competitions/${dry.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    sql(db => db.prepare("UPDATE team_report_jobs SET due_at=? WHERE competition_id=?").run(new Date(0).toISOString(), dry.id));
    const b2 = smtp.messages.length;
    await tick(sa, false);
    expect(mailsTo(dm.email, b2).length).toBe(0);
    const { comp: empty } = await makeEvent(sa, { tasks: 2 });
    expect((await sa.post(`/api/admin/competitions/${empty.id}/team-report/send`, {}, await sa.h())).body.code).toBe("team_empty");
  });

  test("a Program sends one Monday digest per week while it runs", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp } = await makeEvent(sa, { kind: "program", startAgoMs: 10 * 86400e3 });
    const m = await addMember(sa, comp.id, "marketing", "Wendy");
    // Started this week: not due (negative control). It starts after this week's
    // Monday 00:00 UTC at any wall-clock time, so the guard it witnesses is the
    // one deciding: at most a minute ago, and never further back than half the
    // week so far (seconds into a Monday, a few milliseconds).
    const n = new Date();
    const weekStart = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - ((n.getUTCDay() + 6) % 7));
    const freshAgo = Math.max(1, Math.min(60_000, Math.floor((Date.now() - weekStart) / 2)));
    const { comp: fresh } = await makeEvent(sa, { kind: "program", startAgoMs: freshAgo });
    expect(Date.parse(fresh.start_time), "PRECONDITION: the fresh event starts this week").toBeGreaterThan(weekStart);
    const fm = await addMember(sa, fresh.id, "marketing", "Fiona");
    const before = smtp.messages.length;
    await tick(sa, false);
    expect(mailsTo(m.email, before).length).toBeGreaterThanOrEqual(1);
    for (const w of mailsTo(m.email, before)) expectStopLine(w, "Monday digest");
    expect(mailsTo(fm.email, before).length).toBe(0);
    const again = smtp.messages.length;
    await tick(sa, false);
    expect(mailsTo(m.email, again).length).toBe(0);
  });

  // A MARK-SENT RESTORE (scripts/restore-mail.sh; operator ruling, 17 Nov 2026,
  // "Choose at restore"): `settings.restore_mail_floor_at` makes every report
  // about an end before it count as sent — the wrap-up and its lead file, a
  // delta, the 48 h reminder — while an end after it is reported as usual.
  const plantRestoreFloor = (iso) => sql(db => db.prepare(
    "INSERT INTO settings (key, value) VALUES ('restore_mail_floor_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(iso));
  const clearRestoreFloor = () => sql(db => db.prepare("DELETE FROM settings WHERE key='restore_mail_floor_at'").run());
  test("after a mark-sent restore, nothing about an end before it is reported; an end after it is", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    // A Booth Event (its qualifying questions seeded) whose lead is HOT and waits:
    // the 48-hour reminder about it would have something to say.
    const { comp: before_ } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 2 });
    const { comp: after_ } = await makeEvent(sa, { tasks: 2 });
    const pb = await person("rsB", { company: "Before Co" });
    await assign(sa, before_.id, [pb]);
    await enter(pb, before_.id);
    await answerQ(pb, before_.id, qTasks(before_.id), "follow_up", 0);
    await assign(sa, after_.id, [await person("rsA", { company: "After Co" })]);
    const mb = await addMember(sa, before_.id, "marketing", "Bella");
    const ma = await addMember(sa, after_.id, "marketing", "Alba");
    expect((await sa.post(`/api/admin/competitions/${before_.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    plantRestoreFloor(new Date().toISOString());
    try {
      await new Promise(r => setTimeout(r, 10));
      expect((await sa.post(`/api/admin/competitions/${after_.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
      sql(db => db.prepare("UPDATE team_report_jobs SET due_at=? WHERE competition_id IN (?,?) AND kind='wrapup'").run(new Date(0).toISOString(), before_.id, after_.id));
      expect(sql(db => db.prepare("SELECT COUNT(*) AS n FROM team_report_jobs WHERE competition_id=? AND kind='wrapup'").get(before_.id).n), "PRECONDITION: the end queued its wrap-up").toBe(1);
      const n0 = smtp.messages.length;
      await tick(sa, false);
      expect(mailsTo(ma.email, n0).length, "CONTROL: an end after the restore is reported").toBeGreaterThanOrEqual(1);
      expect(mailsTo(mb.email, n0), "an end before it is not").toHaveLength(0);
      expect(sql(db => db.prepare("SELECT COUNT(*) AS n FROM team_report_runs WHERE competition_id=?").get(before_.id).n)).toBe(0);
      expect(sql(db => db.prepare("SELECT COUNT(*) AS n FROM team_report_jobs WHERE competition_id=?").get(before_.id).n), "its job is dropped").toBe(0);
      // A 48 h reminder queued for that end goes the same way, though a hot lead waits.
      const waiting = (await sa.get(`/api/admin/competitions/${before_.id}/team-report`)).body.leads.filter(l => l.signal === "hot" && !l.contacted_at);
      expect(waiting.length, "PRECONDITION: a hot lead waits, so the reminder would say something").toBe(1);
      const endKey = sql(db => db.prepare("SELECT ended_at FROM competitions WHERE id=?").get(before_.id).ended_at);
      sql(db => db.prepare("INSERT INTO team_report_jobs (competition_id, kind, end_key, due_at, enqueued_at, passes) VALUES (?,?,?,?,?,0)")
        .run(before_.id, "nudge", endKey, new Date(0).toISOString(), new Date(0).toISOString()));
      const n1 = smtp.messages.length;
      await tick(sa, false);
      expect(mailsTo(mb.email, n1)).toHaveLength(0);
      expect(sql(db => db.prepare("SELECT COUNT(*) AS n FROM team_report_jobs WHERE competition_id=?").get(before_.id).n), "the reminder is dropped").toBe(0);
    } finally { clearRestoreFloor(); }
  });

  test("after a mark-sent restore, that week's Monday digest counts as sent", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp } = await makeEvent(sa, { kind: "program", startAgoMs: 10 * 86400e3 });
    const m = await addMember(sa, comp.id, "marketing", "Rhea");
    const n = new Date();
    const monday = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - ((n.getUTCDay() + 6) % 7));
    expect(Date.now() - monday > 60_000, "the run must not straddle a week start").toBe(true);
    plantRestoreFloor(new Date().toISOString());
    try {
      const n0 = smtp.messages.length;
      await tick(sa, false);
      expect(mailsTo(m.email, n0), "restored this week: the digest went out before it").toHaveLength(0);
      expect(sql(db => db.prepare("SELECT COUNT(*) AS n FROM team_report_runs WHERE competition_id=? AND kind='weekly'").get(comp.id).n)).toBe(0);
      // CONTROL: restored before this week began, the digest goes out.
      plantRestoreFloor(new Date(monday - 86400e3).toISOString());
      const n1 = smtp.messages.length;
      await tick(sa, false);
      expect(mailsTo(m.email, n1).length).toBeGreaterThanOrEqual(1);
    } finally { clearRestoreFloor(); }
  });

  test("a sealed challenge's wrong answer is counted, never quoted", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { tasks: 2 });
    const ps = [await person("s1"), await person("s2"), await person("s3")];
    await assign(sa, comp.id, ps);
    for (const p of ps) { await enter(p, comp.id); await submit(p, comp.id, taskIds[0], "secret-guess"); }
    const read = async () => (await sa.get(`/api/admin/competitions/${comp.id}/team-report`)).body.challenges.find(c => c.id === taskIds[0]);
    expect((await read()).top_wrong).toEqual({ text: "secret-guess", count: 3 });   // the unsealed control
    sql(db => db.prepare("UPDATE tasks SET answer_sealed=1 WHERE id=?").run(taskIds[0]));
    expect((await read()).top_wrong).toEqual({ text: null, count: 3 });
    const raw = await sa.get(`/api/admin/competitions/${comp.id}/team-report`);
    expect(raw.text).not.toContain("secret-guess");
  });

  // A SEALED QUALIFYING CHALLENGE'S ANSWERS ARE NEVER READ (sweep #87): the
  // reports go to team members and addresses outside the platform, who see a
  // sealed answer nowhere else. No door makes one today (a qualifying question is
  // a pick-one Any answer, which can never be sealed), so the older or imported
  // row it guards against is made here by writing the seal. It stays a
  // qualifying question: out of the challenge figures, and still "played".
  test("a sealed qualifying question's picks, and a sealed free answer, reach no report, lead file or team email; unsealed they do (CONTROL)", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    // A Booth Event: its built-in qualifying questions are READ beside the sealed
    // one, so the answers query runs with a withheld question in the event.
    const { comp } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 1 });
    const OPT = `SEALOPT${stamp()}`, FREE = `FREETEXT${stamp()}`;
    const qid = await pickOne(sa, [`${OPT}-A`, `${OPT}-B`]);
    expect((await sa.post(`/api/admin/tasks/${qid}/tags`, { tag: "qualifying:sweep87" }, await sa.h())).ok).toBeTruthy();
    const fr = await sa.post("/api/admin/tasks", { title: `Free ${stamp()}`, description: "<p>d</p>", difficulty: "easy", answer_type: "any", status: "published" }, await sa.h());
    expect(fr.ok, fr.text).toBeTruthy();
    for (const t of [qid, fr.body.id]) expect((await sa.post(`/api/admin/tasks/${t}/competitions`, { competitionIds: [comp.id] }, await sa.h())).ok).toBeTruthy();
    // Two leads answer everything; a third answers ONLY the soon-sealed question;
    // a fourth answers nothing (the "played" CONTROL).
    const ps = [await person("sq1", { company: "Seal Co" }), await person("sq2", { company: "Seal Co" })];
    const onlySealed = await person("sq3", { company: "Seal Co" });
    const idle = await person("sq4", { company: "Seal Co" });
    await assign(sa, comp.id, [...ps, onlySealed, idle]);
    const opts = choicesOf(qid);
    const q = qTasks(comp.id);
    expect(q.some(x => x.key === "developers"), "PRECONDITION: the Booth Event asks its built-in questions").toBe(true);
    for (const p of ps) {
      await enter(p, comp.id);
      expect((await submit(p, comp.id, qid, JSON.stringify([opts[0].id]))).ok).toBeTruthy();
      expect((await submit(p, comp.id, fr.body.id, `${FREE} from ${p.id}`)).ok).toBeTruthy();
      await answerQ(p, comp.id, q, "developers", 3);
    }
    await enter(onlySealed, comp.id);
    expect((await submit(onlySealed, comp.id, qid, JSON.stringify([opts[1].id]))).ok).toBeTruthy();
    const csv = async () => { const r = await sa.get(`/api/admin/competitions/${comp.id}/team-report/leads.csv`); expect(r.ok, r.text).toBeTruthy(); return r.text; };
    // CONTROL, unsealed: the pick and the free answer are read.
    const before = JSON.stringify(await report(sa, comp.id));
    expect(before, "CONTROL: the pick is read").toContain(`${OPT}-A`);
    expect(before, "CONTROL: the free answer is read").toContain(FREE);
    expect(await csv(), "CONTROL: the lead file carries the pick").toContain(`${OPT}-A`);
    // Sealed, as an older or imported row can be.
    sql(db => db.prepare("UPDATE tasks SET answer_sealed=1 WHERE id IN (?, ?)").run(qid, fr.body.id));
    const body = await report(sa, comp.id);   // answers 200: a withheld question beside read ones is no error
    const raw = JSON.stringify(body);
    expect(raw, "no sealed pick in the report").not.toContain(OPT);
    expect(raw, "no sealed free answer").not.toContain(FREE);
    expect(body.qualifying.map(x => x.key), "the sealed question is not reported").not.toContain("sweep87");
    expect(body.qualifying.map(x => x.key), "…while the built-in ones still are").toContain("developers");
    const lead = (p) => body.leads.find(l => l.user_id === p.id) || {};
    expect(ps.map(p => (lead(p).answers || {}).developers), "…with their answers").toEqual(["1000+", "1000+"]);
    expect(body.challenges.map(c => c.id), "…and the sealed one is still not a scoring challenge").not.toContain(qid);
    expect([...ps, onlySealed].map(p => lead(p).played), "answering only the sealed question still counts as playing").toEqual([true, true, true]);
    expect(lead(idle).played, "CONTROL: answering nothing does not").toBe(false);
    expect(await csv(), "no sealed pick in the lead file").not.toContain(OPT);
    // The team's email: Marketing's carries the lead file.
    const to = `mona-${stamp()}@corp.example`;
    const add = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "marketing", name: "Mona", email: to }, await sa.h());
    expect(add.ok, add.text).toBeTruthy();
    const since = smtp.messages.length;
    const send = await sa.post(`/api/admin/competitions/${comp.id}/team-report/send`, {}, await sa.h());
    expect(send.ok, send.text).toBeTruthy();
    // With no SDR on the team Marketing also stands in for one: two reports, the
    // Marketing one with the lead file and the SDR one with a card per lead.
    await expect.poll(() => mailsTo(to, since).length, { timeout: 15000, message: "Marketing's two reports are mailed" }).toBe(2);
    const mails = mailsTo(to, since);
    expect(mails.some(m => csvPart(m)), "PRECONDITION: one carries the lead file").toBe(true);
    expect(mails.map(m => htmlPart(m)).join("\n"), "PRECONDITION: the leads are in them").toContain("Seal Co");
    for (const m of mails) for (const part of [htmlPart(m), textPart(m), csvPart(m) || ""]) {
      expect(part, "no sealed pick in the email").not.toContain(OPT);
      expect(part, "no sealed free answer in the email").not.toContain(FREE);
    }
  });

  // After its run the wrap-up queues the late window's delta, reading the jobs
  // again after the run's awaits: a delta queued meanwhile (another end, a close;
  // one slot per event) keeps its own key and time (lib/team-reports.js, the
  // `pendingDelta` read). Planted here by its row, the one way to land a delta
  // while a run is held mid-send.
  test("a delta queued while the wrap-up was sending is not overwritten by it (CONTROL: with none queued, the wrap-up queues the late window's)", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const ended = async (label) => {
      const { comp } = await makeEvent(sa, { kind: "booth", minutes: 120 });
      await assign(sa, comp.id, [await person(label, { company: `${label} Co` })]);
      await addMember(sa, comp.id, "marketing", `M${label}`);
      expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
      sql(db => db.prepare("UPDATE team_report_jobs SET due_at=? WHERE competition_id=? AND kind='wrapup'").run(new Date(0).toISOString(), comp.id));
      return comp;
    };
    const delta = (id) => sql(db => db.prepare("SELECT end_key, due_at FROM team_report_jobs WHERE competition_id=? AND kind='delta'").get(id));

    const plain = await ended("plainwrap");
    expect(delta(plain.id), "PRECONDITION: no delta before the wrap-up").toBeUndefined();
    await tick(sa, false);
    expect((delta(plain.id) || {}).end_key, "CONTROL: the wrap-up queued the late window's delta").toMatch(/^late:/);

    const comp = await ended("racewrap");
    expect(delta(comp.id), "PRECONDITION: no delta before the wrap-up").toBeUndefined();
    const KEY = `end:planted-${stamp()}`, DUE = "2099-01-01T00:00:00.000Z";
    smtp.hold();
    let pass;
    try {
      pass = tick(sa, false);
      await expect.poll(() => smtp.heldCount(), { timeout: 15000, message: "the wrap-up is held mid-send" }).toBeGreaterThan(0);
      sql(db => db.prepare("INSERT INTO team_report_jobs (competition_id, kind, end_key, due_at, enqueued_at, passes) VALUES (?, 'delta', ?, ?, ?, 0)")
        .run(comp.id, KEY, DUE, new Date().toISOString()));
    } finally { smtp.release(); }
    await pass;
    expect(sql(db => db.prepare("SELECT 1 AS x FROM team_report_runs WHERE competition_id=? AND kind='wrapup'").get(comp.id)), "PRECONDITION: the wrap-up ran").toBeTruthy();
    expect(delta(comp.id), "the delta queued meanwhile kept its key and time").toEqual({ end_key: KEY, due_at: DUE });
  });
});

test.describe("revive cancels", () => {
  test("an event revived before its wrap-up runs mails nobody", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp } = await makeEvent(sa, { kind: "tournament", tasks: 2 });
    const p = await person("rv");
    await assign(sa, comp.id, [p]);
    const email = `rv-${stamp()}@corp.example`;
    expect((await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "marketing", name: "Rae", email }, await sa.h())).ok).toBeTruthy();
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    expect(sql(db => db.prepare("SELECT 1 AS x FROM team_report_jobs WHERE competition_id=?").get(comp.id))).toBeTruthy();
    expect((await sa.put(`/api/admin/competitions/${comp.id}`, { duration_minutes: 900 }, await sa.h())).ok).toBeTruthy();
    const before = smtp.messages.length;
    const t = await tick(sa, true);
    expect(t.dropped).toBeGreaterThanOrEqual(1);
    expect(mailsTo(email, before).length).toBe(0);
    expect(sql(db => db.prepare("SELECT 1 AS x FROM team_report_jobs WHERE competition_id=?").get(comp.id))).toBeUndefined();
  });

  test("a delta waiting for a re-end is dropped when the event is revived again", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp } = await makeEvent(sa, { kind: "tournament", tasks: 2 });
    await assign(sa, comp.id, [await person("dr1")]);
    const email = `dr-${stamp()}@corp.example`;
    expect((await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "marketing", name: "Dee", email }, await sa.h())).ok).toBeTruthy();
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    sql(db => db.prepare("UPDATE team_report_jobs SET due_at=? WHERE competition_id=? AND kind='wrapup'").run(new Date(0).toISOString(), comp.id));
    await tick(sa, false);
    expect(mailsTo(email).length, "the wrap-up went out").toBeGreaterThanOrEqual(1);
    expect((await sa.put(`/api/admin/competitions/${comp.id}`, { duration_minutes: 900 }, await sa.h())).ok).toBeTruthy();
    await assign(sa, comp.id, [await person("dr2")]);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    expect(sql(db => db.prepare("SELECT 1 AS x FROM team_report_jobs WHERE competition_id=? AND kind='delta'").get(comp.id))).toBeTruthy();
    expect((await sa.put(`/api/admin/competitions/${comp.id}`, { duration_minutes: 1200 }, await sa.h())).ok).toBeTruthy();
    sql(db => db.prepare("UPDATE team_report_jobs SET due_at=? WHERE competition_id=? AND kind='delta'").run(new Date(0).toISOString(), comp.id));
    const before = smtp.messages.length;
    await tick(sa, false);
    expect(mailsTo(email, before).length).toBe(0);
    expect(sql(db => db.prepare("SELECT 1 AS x FROM team_report_jobs WHERE competition_id=? AND kind='delta'").get(comp.id))).toBeUndefined();
  });

  // Sweep #85: the 48-hour reminder ran BEFORE the check that drops a revived
  // event's jobs, so a reopened event's team was still told hot leads were
  // waiting. Every kind is now dropped on a revive, and the end that follows
  // queues the reminder again, once: never after one has reached anyone (one that
  // ran with nobody waiting reached nobody, so it does not count).
  const nudgeFixture = async (tag) => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    // A Competition with the qualifying questions: no late-entry window to queue
    // deltas of its own.
    const { comp } = await makeEvent(sa, { kind: "tournament", tasks: 2, extra: { add_qualifying: true } });
    const p = await person(tag);
    await assign(sa, comp.id, [p]);
    await enter(p, comp.id);
    await answerQ(p, comp.id, qTasks(comp.id), "follow_up", 0);   // Yes: a hot lead
    const member = async (role, name) => {
      const email = `${name.toLowerCase()}-${stamp()}@corp.example`;
      const r = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role, name, email }, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
      return { ...r.body.member, email };
    };
    const sdr = await member("sdr", "Nia"), mkt = await member("marketing", "Mo");
    const job = (kind) => sql(db => db.prepare("SELECT * FROM team_report_jobs WHERE competition_id=? AND kind=?").get(comp.id, kind));
    const dueNow = (kind) => sql(db => db.prepare("UPDATE team_report_jobs SET due_at=? WHERE competition_id=? AND kind=?").run(new Date(0).toISOString(), comp.id, kind));
    const runs = (kind) => sql(db => db.prepare("SELECT COUNT(*) n FROM team_report_runs WHERE competition_id=? AND kind=?").get(comp.id, kind).n);
    const settle = async () => expect((await sa.post("/api/test/scheduler-tick", {}, await sa.h())).ok).toBeTruthy();
    const reminders = (addr, since) => mailsTo(addr, since).filter(m => /reminder/i.test(subjectOf(m)));
    const end = async () => { expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy(); await settle(); };
    const reopen = async () => {
      const put = await sa.put(`/api/admin/competitions/${comp.id}`, { duration_minutes: 900 }, await sa.h());
      expect(put.ok && put.body.competition.status === "live", `reopen: ${put.text}`).toBe(true);
    };
    // Ended and wrapped up: the reminder waits its 48 hours.
    await end();
    dueNow("wrapup");
    await tick(sa, false);
    expect(runs("wrapup"), "PRECONDITION: the wrap-up ran").toBe(1);
    expect(job("nudge"), "PRECONDITION: the wrap-up queued the reminder").toBeTruthy();
    const lead = (await sa.get(`/api/admin/competitions/${comp.id}/team-report`)).body.leads.find(l => l.user_id === p.id);
    expect(!!lead && lead.signal === "hot" && !lead.contacted_at && !lead.opted_out, "PRECONDITION: a hot lead waits").toBe(true);
    return { sa, comp, p, sdr, mkt, job, dueNow, runs, reminders, end, reopen };
  };

  test("sweep #85: a 48-hour reminder still waiting when the event is reopened is dropped; ended again, it follows that end's report", async () => {
    const f = await nudgeFixture("nr");
    await f.reopen();
    f.dueNow("nudge");
    let n0 = smtp.messages.length;
    await tick(f.sa, false);
    expect(f.reminders(f.sdr.email, n0), "no reminder about a reopened event").toHaveLength(0);
    expect(f.reminders(f.mkt.email, n0)).toHaveLength(0);
    expect(f.job("nudge"), "the reminder is dropped").toBeUndefined();
    expect(f.runs("nudge")).toBe(0);
    // Ended again: that end's report queues the reminder, 48 hours on.
    await f.end();
    expect(f.job("delta").end_key, "PRECONDITION: the re-end queued its report").toMatch(/^end:/);
    f.dueNow("delta");
    await tick(f.sa, false);
    const nj = f.job("nudge");
    expect(nj, "the re-end's report queues the reminder again").toBeTruthy();
    expect(Date.parse(nj.due_at) - Date.now(), "48 hours after that report").toBeGreaterThan(47 * 3600e3);
    f.dueNow("nudge");
    n0 = smtp.messages.length;
    await tick(f.sa, false);
    expect(f.reminders(f.sdr.email, n0)).toHaveLength(1);
    expect(f.reminders(f.mkt.email, n0)).toHaveLength(1);
    expect(subjectOf(f.reminders(f.mkt.email, n0)[0])).toMatch(/1 hot lead waiting/i);
  });

  test("sweep #85 CONTROL: an event still ended sends its waiting reminder", async () => {
    const f = await nudgeFixture("nc");
    f.dueNow("nudge");
    const n0 = smtp.messages.length;
    await tick(f.sa, false);
    expect(f.reminders(f.sdr.email, n0)).toHaveLength(1);
    expect(f.reminders(f.mkt.email, n0)).toHaveLength(1);
    expect(f.runs("nudge")).toBe(1);
    expect(f.job("nudge")).toBeUndefined();
  });

  test("sweep #85: a reminder that ran with nobody waiting reached nobody, so the next end's report queues one", async () => {
    const f = await nudgeFixture("nz");
    // The hot lead is contacted before the reminder runs: nothing waits.
    const mk = await f.sa.post(`/api/admin/competitions/${f.comp.id}/leads/${f.p.id}/contacted`, { contacted: true }, await f.sa.h());
    expect(mk.ok, mk.text).toBeTruthy();
    f.dueNow("nudge");
    let n0 = smtp.messages.length;
    await tick(f.sa, false);
    expect(f.runs("nudge"), "PRECONDITION: the reminder ran").toBe(1);
    expect(f.reminders(f.sdr.email, n0), "PRECONDITION: and reached nobody").toHaveLength(0);
    expect(f.reminders(f.mkt.email, n0)).toHaveLength(0);
    // A lead waits again, then the event is reopened and ended again.
    const un = await f.sa.post(`/api/admin/competitions/${f.comp.id}/leads/${f.p.id}/contacted`, { contacted: false }, await f.sa.h());
    expect(un.ok, un.text).toBeTruthy();
    await f.reopen();
    await f.end();
    f.dueNow("delta");
    await tick(f.sa, false);
    expect(f.job("nudge"), "the re-end's report queues a reminder").toBeTruthy();
    f.dueNow("nudge");
    n0 = smtp.messages.length;
    await tick(f.sa, false);
    expect(f.reminders(f.sdr.email, n0), "and it goes out").toHaveLength(1);
  });

  test("sweep #85: a reminder already sent is not sent again after the event is reopened and ended again", async () => {
    const f = await nudgeFixture("ns");
    f.dueNow("nudge");
    let n0 = smtp.messages.length;
    await tick(f.sa, false);
    expect(f.reminders(f.mkt.email, n0), "PRECONDITION: the reminder went").toHaveLength(1);
    await f.reopen();
    await f.end();
    f.dueNow("delta");
    await tick(f.sa, false);
    expect(f.job("nudge"), "no second reminder is queued").toBeUndefined();
    n0 = smtp.messages.length;
    await tick(f.sa, true);
    expect(f.reminders(f.sdr.email, n0)).toHaveLength(0);
    expect(f.reminders(f.mkt.email, n0)).toHaveLength(0);
  });

  // Sweep #149: removing a member rewrites their ledger rows rather than deleting
  // them, so the reminder that reached them still counts as gone out.
  test("sweep #149: a reminder whose recipients have since left the team still counts as sent: ended again, no second one is queued", async () => {
    const f = await nudgeFixture("nrm");
    f.dueNow("nudge");
    const n0 = smtp.messages.length;
    await tick(f.sa, false);
    expect(f.reminders(f.sdr.email, n0), "PRECONDITION: the reminder reached the SDR").toHaveLength(1);
    expect(f.reminders(f.mkt.email, n0), "…and Marketing").toHaveLength(1);
    // Both leave the team; an SE joins, so the team is not empty and the re-end's report runs.
    for (const m of [f.sdr, f.mkt]) {
      const d = await f.sa.del(`/api/admin/competitions/${f.comp.id}/team/${m.id}`, await f.sa.h());
      expect(d.ok, d.text).toBeTruthy();
    }
    const se = await f.sa.post(`/api/admin/competitions/${f.comp.id}/team`, { role: "se", name: "Sam", email: `sam-${stamp()}@corp.example` }, await f.sa.h());
    expect(se.ok, se.text).toBeTruthy();
    const rows = sql(db => db.prepare("SELECT recipient, status FROM team_report_sends WHERE competition_id=? AND kind='nudge' ORDER BY recipient").all(f.comp.id));
    expect(rows.map(r => r.status), `PRECONDITION: the reminder's two rows are kept, as sent: ${JSON.stringify(rows)}`).toEqual(["sent", "sent"]);
    expect(rows.every(r => /^removed:tm_[0-9a-f]{12}:corp\.example$/.test(r.recipient)), "…under the removed form, no address").toBe(true);
    await f.reopen();
    await f.end();
    f.dueNow("delta");
    await tick(f.sa, false);
    expect(f.runs("delta"), "PRECONDITION: the re-end's report ran, so the check was asked").toBe(1);
    expect(f.job("nudge"), "no second reminder is queued").toBeUndefined();
  });
});

test.describe("the order of the qualifying questions", () => {
  test("they come last, numbered in the fixed order; a later scoring challenge still numbers ahead; losing the tag renumbers", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 2 });
    const p = await person("order");
    await assign(sa, comp.id, [p]);
    await enter(p, comp.id);
    const list = async () => (await p.c.get("/api/tasks", { "x-competition-id": comp.id })).body;
    const q = qTasks(comp.id);
    const idOf = (key) => q.find(x => x.key === key).id;
    let rows = await list();
    expect(rows.map(t => t.id), "scoring first, then the fixed order").toEqual([...taskIds.slice().sort((a, b) => rows.findIndex(t => t.id === a) - rows.findIndex(t => t.id === b)),
      idOf("developers"), idOf("scanner"), idOf("evaluating"), idOf("follow_up")]);
    expect(rows.slice(-4).map(t => t.task_number)).toEqual(["4.01", "4.02", "4.03", "4.04"]);
    expect(rows.slice(0, 2).every(t => /^1\./.test(t.task_number)), JSON.stringify(rows)).toBe(true);

    // A scoring challenge added after they are numbered still comes before them.
    const late = await sa.post("/api/admin/tasks", { title: `Late ${stamp()}`, description: "<p>d</p>", difficulty: "hard", answer_type: "text", correct_answer: "x", status: "published" }, await sa.h());
    expect(late.ok, late.text).toBeTruthy();
    expect((await sa.post(`/api/admin/tasks/${late.body.id}/competitions`, { competitionIds: [comp.id] }, await sa.h())).ok).toBeTruthy();
    rows = await list();
    expect(rows.findIndex(t => t.id === late.body.id), "ahead of every qualifying question").toBe(2);
    expect(rows.find(t => t.id === late.body.id).task_number).toBe("3.01");
    expect(rows.slice(-4).map(t => t.task_number), "their numbers are sticky").toEqual(["4.01", "4.02", "4.03", "4.04"]);

    // An organiser's own qualifying key comes after the built-in four. Only a
    // pick-one question can be one (lib/qualifying.js), so it is made one first.
    const pk = await sa.put(`/api/admin/tasks/${taskIds[0]}`, { answer_type: "any", correct_answer: "", choices: [{ text: "Few" }, { text: "Many" }] }, await sa.h());
    expect(pk.ok, pk.text).toBeTruthy();
    const own = await sa.post(`/api/admin/tasks/${taskIds[0]}/tags`, { tag: "qualifying:budget" }, await sa.h());
    expect(own.ok, own.text).toBeTruthy();
    rows = await list();
    expect(rows[rows.length - 1].id).toBe(taskIds[0]);
    expect(rows[rows.length - 1].task_number).toBe("4.05");
    // Losing the tag gives it a difficulty's number again.
    const off = await sa.del(`/api/admin/tasks/${taskIds[0]}/tags/${encodeURIComponent("qualifying:budget")}`, await sa.h());
    expect(off.ok, off.text).toBeTruthy();
    rows = await list();
    expect(rows.find(t => t.id === taskIds[0]).task_number, "easy, sticky siblings kept").toMatch(/^1\./);
    expect(rows.findIndex(t => t.id === taskIds[0])).toBeLessThan(rows.length - 4);
  });

  test("a question numbered before they had their own level is moved by the one-shot migration", async () => {
    // Fresh databases never hold such a row, so the state an older build left is
    // made by hand with the server stopped, and db.js runs over it at the next boot.
    expect(sql(db => db.prepare("SELECT value FROM settings WHERE key='qualifying_numbers_moved_at'").get()), "the marker is written even with nothing to move").toBeTruthy();
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { tasks: 3 });
    const [oldQ, newQ, plain] = taskIds;
    await kill();
    const numbers = () => sql(db => Object.fromEntries(db.prepare(
      "SELECT task_id, task_number FROM competition_tasks WHERE competition_id=?").all(comp.id).map(r => [r.task_id, r.task_number])));
    sql(db => {
      const tag = db.prepare("INSERT INTO task_tags (task_id, tag) VALUES (?, ?)");
      tag.run(oldQ, "qualifying:mig-old");
      tag.run(newQ, "qualifying:mig-new");
      const num = db.prepare("UPDATE competition_tasks SET task_number=? WHERE competition_id=? AND task_id=?");
      num.run("2.01", comp.id, oldQ);   // numbered as a scoring challenge by an older build
      num.run("4.01", comp.id, newQ);   // already in the qualifying level
      num.run("1.01", comp.id, plain);  // not a qualifying challenge
      db.prepare("DELETE FROM settings WHERE key='qualifying_numbers_moved_at'").run();
    });
    expect(numbers(), "PRECONDITION: the older build's numbers").toEqual({ [oldQ]: "2.01", [newQ]: "4.01", [plain]: "1.01" });
    await boot();
    // Read straight from the database: any API read would number the row again.
    expect(numbers(), "only the qualifying row outside the 4. level loses its number").toEqual({ [oldQ]: null, [newQ]: "4.01", [plain]: "1.01" });
    expect(sql(db => db.prepare("SELECT value FROM settings WHERE key='qualifying_numbers_moved_at'").get()), "the marker is written again").toBeTruthy();

    // It runs once: a later boot leaves the same shape alone.
    await kill();
    sql(db => db.prepare("UPDATE competition_tasks SET task_number='2.01' WHERE competition_id=? AND task_id=?").run(comp.id, oldQ));
    await boot();
    expect(numbers()[oldQ], "the migration does not run twice").toBe("2.01");
  });
});

test.describe("the hot rule and the opener are pure tables", () => {
  const Q = () => require("../lib/qualifying");
  test("Hot = 250+ AND evaluating within 6 months, OR follow-up Yes; Warm = exactly one; Cold = neither", () => {
    const { classifyLead } = Q();
    // developers: 0 1–49, 1 50–249, 2 250–999, 3 1000+. evaluating: 0 No, 1 within 3, 2 3–6, 3 6–12.
    const rows = [
      [{ developers: 2, evaluating: 1 }, "hot"], [{ developers: 3, evaluating: 2 }, "hot"],
      [{ developers: 0, evaluating: 0, follow_up: 0 }, "hot"], [{ follow_up: 0 }, "hot"],
      [{ developers: 3, evaluating: 3, follow_up: 0 }, "hot"],
      [{ developers: 3, evaluating: 3 }, "warm"], [{ developers: 3, evaluating: 3, follow_up: 1 }, "warm"],
      [{ developers: 2 }, "warm"], [{ developers: 2, evaluating: 0 }, "warm"],
      [{ developers: 0, evaluating: 1 }, "warm"], [{ developers: 1, evaluating: 2 }, "warm"], [{ evaluating: 1 }, "warm"],
      [{}, "cold"], [{ developers: 1 }, "cold"], [{ developers: 1, evaluating: 3 }, "cold"],
      [{ developers: 0, evaluating: 0, follow_up: 1 }, "cold"], [{ evaluating: 3 }, "cold"],
    ];
    for (const [pos, want] of rows) expect(classifyLead(pos), JSON.stringify(pos)).toBe(want);
  });

  test("the opener says only what is informative and reads naturally with nothing to say", () => {
    const { suggestedOpener: op } = Q();
    const A = (o) => op({ first_name: "Sam", solved: 0, positions: {}, answers: {}, ...o }, "Expo");
    const big = { positions: { developers: 3 }, answers: { developers: "1000+" } };
    const small = { positions: { developers: 0 }, answers: { developers: "1–49" } };
    const evalNo = { positions: { evaluating: 0 }, answers: { evaluating: "No" } };
    const evalSoon = { positions: { evaluating: 1 }, answers: { evaluating: "Yes, within 3 months" } };
    const askYes = { positions: { follow_up: 0 }, answers: { follow_up: "Yes" } };
    const askNo = { positions: { follow_up: 1 }, answers: { follow_up: "No" } };
    // Nothing answered.
    expect(A({})).toBe("Hi Sam, thanks for joining Expo. Would a 20-minute call on how teams like yours secure their code be useful?");
    // No first name: never "Hi ,".
    expect(A({ first_name: "" })).toMatch(/^Hi, thanks for joining Expo\./);
    // A small team and a "No" are not informative: not mentioned.
    expect(A(small)).not.toMatch(/1–49|developers/);
    expect(A(evalNo)).not.toMatch(/evaluating|\bNo\b/);
    // Informative answers are.
    expect(A(big)).toContain("You mentioned your team has 1000+ developers.");
    expect(A(evalSoon)).toContain("You mentioned you are evaluating an AppSec solution (within 3 months).");
    expect(A(evalSoon)).not.toMatch(/Yes,/);
    expect(A({ positions: { evaluating: 2, developers: 2 }, answers: { evaluating: "Yes, in 3–6 months", developers: "250–999" } }))
      .toContain("You mentioned you are evaluating an AppSec solution (in 3–6 months) and your team has 250–999 developers.");
    // Asked for a follow-up: said so.
    expect(A(askYes)).toContain("You asked us to follow up.");
    expect(A({ positions: { follow_up: 0, ...big.positions }, answers: { follow_up: "Yes", ...big.answers } })).toContain("You asked us to follow up, and you mentioned your team has 1000+ developers.");
    // Said no to evaluating and to a follow-up: no pressing for a call.
    const declined = A({ positions: { follow_up: 1, evaluating: 0 }, answers: { follow_up: "No", evaluating: "No" } });
    expect(declined).toContain("no rush");
    expect(declined).not.toMatch(/20-minute|evaluating/);
    expect(A(askNo)).toContain("no rush");
    // What they solved, in the right number.
    expect(A({ solved: 1 })).toContain("and solving 1 challenge.");
    expect(A({ solved: 2 })).toContain("and solving 2 challenges.");
    // Never two spaces or a dangling comma, whatever the combination.
    for (const f of [{}, big, small, evalNo, evalSoon, askYes, askNo]) {
      const s = A(f);
      expect(s, s).not.toMatch(/ {2}|, \.|\.\.| ,/);
    }
  });
});

test.describe("each email says what to do", () => {
  const preview = async (sa, compId, persona) => {
    const r = await sa.get(`/api/admin/competitions/${compId}/team-report/preview?persona=${persona}`);
    expect(r.ok, r.text).toBeTruthy();
    return r.body;
  };
  // `email`: one address for every row (an administrator's, so each email carries
  // its button); otherwise a fresh address per member, at no account.
  const addTeam = async (sa, compId, rows, email = null) => {
    for (const [role, name] of rows) {
      const r = await sa.post(`/api/admin/competitions/${compId}/team`, { role, name, email: email || `${name.toLowerCase()}-${stamp()}@corp.example` }, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
    }
  };
  // An administrator: an address that opens every event (operator ruling 79).
  const adminAccount = async (sa, tag) => {
    const p = await person(tag, { first: "Cat" });
    expect((await sa.post(`/api/admin/participants/${p.id}/role`, { role: "admin" }, await sa.h())).ok, `${tag} is an administrator`).toBeTruthy();
    return p;
  };

  test("the call to action, per persona, by value; the emails carry the mock-up's structure", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example", "company.co"] }, await sa.h())).ok).toBeTruthy();
    const { comp, taskIds } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 1 });
    const q = qTasks(comp.id);
    const bad = await sa.put(`/api/admin/tasks/${taskIds[0]}`, { title: "Account <Timeline>" }, await sa.h());
    expect(bad.ok, bad.text).toBeTruthy();
    const big = await person("bigco", { first: "Ann", last: "Lee", company: "Big Corp", title: "Head of AppSec" });
    const b2 = await person("bigcob", { first: "Bo", last: "Ray", company: "Big Corp", title: "Developer" });
    const small = await person("small", { first: "Cy", last: "Fox", company: "Tiny", title: "Developer" });
    await assign(sa, comp.id, [big, b2, small]);
    await addTeam(sa, comp.id, [["se", "Sean"], ["marketing", "Mia"], ["sales", "Sal"], ["sdr", "Sid"], ["sales_manager", "Max"]], (await adminAccount(sa, "ctaadm")).email);
    for (const p of [big, b2, small]) {
      await enter(p, comp.id);
      expect((await submit(p, comp.id, taskIds[0], "admin")).body.correct).toBe(false);
    }
    await answerQ(big, comp.id, q, "developers", 3);
    await answerQ(big, comp.id, q, "evaluating", 1);
    await answerQ(big, comp.id, q, "follow_up", 0);

    const se = await preview(sa, comp.id, "se");
    expect(se.cta.text).toBe('Edit "Account <Timeline>"');
    expect(se.cta.url).toContain("&section=challenges");
    expect(se.text).toContain('Fix "Account <Timeline>". Only 0% solved it (0 of 3), and 3 of the wrong answers were the same: "admin".');

    const mkt = await preview(sa, comp.id, "marketing");
    expect(mkt.cta.text).toBe("Download the CRM file (3 leads)");
    expect(mkt.cta.url).toContain("&section=team");
    expect(mkt.text).toContain("Load 3 leads into the CRM today.");
    expect(mkt.text).not.toMatch(/hand over/i);

    const sales = await preview(sa, comp.id, "sales");
    expect(sales.cta.text).toBe("Plan the Big Corp meeting");
    expect(sales.text).toContain("Big Corp is the strongest account. 2 people joined, including their Head of AppSec; 1000+ developers; evaluating an AppSec solution (within 3 months); asked for a follow-up.");

    const sdr = await preview(sa, comp.id, "sdr");
    expect(sdr.cta.text).toBe("Contact Ann Lee first");
    expect(sdr.text).toContain("Contact the 1 hot lead within 48 hours.");

    const mgr = await preview(sa, comp.id, "manager");
    expect(mgr.cta.text, "everyone has an owner here").toBe("Open the event report");
    expect(mgr.cta.url).toContain("&section=team");

    // The structure of the mock-up, in every persona's HTML.
    for (const m of [se, mkt, sales, sdr, mgr]) {
      const html = m.html;
      expect(m.cta_link, "PRECONDITION: the recipient is an administrator, whose address opens the event").toBe(true);
      expect((html.match(/<a\s/gi) || []).length, "one link: the call to action").toBe(1);
      expect(html).toMatch(/class="m-btn-a"[^>]*>[^<]+<\/a>/);
      expect(html, "a highlighted block round the button").toContain('class="m-soft"');
      expect(html, "table layout").toContain('role="presentation"');
      expect(html, "no image, so nothing external").not.toMatch(/<img|url\(|https?:\/\/(?!localhost|127\.0\.0\.1)/i);
      expect(html, "an event name or title is escaped").not.toContain("<Timeline>");
      expect(m.text, "the plain part has no markup").not.toMatch(/<\/?(table|td|div|strong|p)\b/i);
      expect(m.text).toContain(m.cta.url);
      expect(m.text, "the preview's plain part says how to stop these").toContain(STOP_LINE);
      expect(html, "and its HTML, in the footer, outside the one link").toContain(STOP_LINE_HTML);
      expect(html.slice(html.indexOf('class="m-line"')), "the footer adds no link").not.toMatch(/<a\s/i);
    }
    expect(mkt.html, "the figures are a KPI row").toContain("brand new");
    expect(mkt.html, "qualifying answers are drawn").toContain('class="m-fill"');
    // The one the mail really sends carries the dark sheet; the preview's frame cannot.
    expect(se.html, "the app's CSP would refuse it in the frame").not.toContain("<style");

    // The actual send: same HTML, dark sheet included.
    const before = smtp.messages.length;
    const send = await sa.post(`/api/admin/competitions/${comp.id}/team-report/send`, { persona: "se" }, await sa.h());
    expect(send.ok, send.text).toBeTruthy();
    const sent = await (async () => { for (let i = 0; i < 50; i++) { const m = smtp.messages.slice(before); if (m.length) return m[0]; await new Promise(r => setTimeout(r, 100)); } return null; })();
    expect(sent, "the report arrived").toBeTruthy();
    const html = htmlPart(sent);
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain('name="color-scheme"');
    expect(textPart(sent), "the plain part stays").toContain('Edit "Account <Timeline>"');
    expectStopLine(sent, "Send now with a button");
  });

  // OPERATOR RULING 79 (14 Nov 2026): no dead button. The call to action is a
  // button only for an address that is an account able to open the event; every
  // other recipient is told the same step in words, with no link at all.
  test("the button goes only to an address that can open the event; everyone else is told the step in words", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example", "company.co"] }, await sa.h())).ok).toBeTruthy();
    const { comp } = await makeEvent(sa, { kind: "tournament", tasks: 1 });
    const { comp: other } = await makeEvent(sa, { kind: "tournament", tasks: 0 });
    const lead = await person("btnlead");
    await assign(sa, comp.id, [lead]);
    const role = await sa.post("/api/admin/roles", { label: `No events ${stamp()}`, scope_mode: "all", permissions: ["participants.view"] }, await sa.h());
    expect(role.ok, `create role: ${role.text}`).toBeTruthy();
    const roleTo = async (p, r) => expect((await sa.post(`/api/admin/participants/${p.id}/role`, { role: r }, await sa.h())).ok, `role ${r}`).toBeTruthy();
    const grant = async (p, c) => expect((await sa.post(`/api/admin/competitions/${c}/admins`, { userId: p.id }, await sa.h())).ok, `grant on ${c}`).toBeTruthy();
    const R = {
      admin: await adminAccount(sa, "btnadm"),
      eaHere: await person("btneah"), eaElsewhere: await person("btneae"),
      participant: await person("btnpart"), blocked: await adminAccount(sa, "btnblk"),
      noEvents: await person("btnnoev"),
    };
    await grant(R.eaHere, comp.id);
    await grant(R.eaElsewhere, other.id);
    await roleTo(R.noEvents, role.body.role.id);
    sql(db => db.prepare("UPDATE users SET blocked=1 WHERE id=?").run(R.blocked.id));
    const nobody = `nobody-${stamp()}@corp.example`;
    const want = { admin: true, eaHere: true, eaElsewhere: false, participant: false, blocked: false, noEvents: false, nobody: false };
    const addr = { ...Object.fromEntries(Object.entries(R).map(([k, p]) => [k, p.email])), nobody };
    for (const k of Object.keys(want)) {
      const r = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "sales", name: `Sal ${k}`, email: addr[k] }, await sa.h());
      expect(r.ok, `${k}: ${r.text}`).toBeTruthy();
    }
    const before = smtp.messages.length;
    const send = await sa.post(`/api/admin/competitions/${comp.id}/team-report/send`, { persona: "sales" }, await sa.h());
    expect(send.ok, send.text).toBeTruthy();
    expect(send.body.sent, "PRECONDITION: one Sales report per member").toBe(Object.keys(want).length);
    const seen = {};
    for (const k of Object.keys(want)) {
      const m = mailsTo(addr[k], before);
      expect(m.length, `${k} received the report`).toBe(1);
      const html = htmlPart(m[0]), text = textPart(m[0]);
      const links = (html.match(/<a\s/gi) || []).length;
      seen[k] = links === 1 && html.includes(`/?event=${comp.id}&amp;section=`) && text.includes(`/?event=${comp.id}&section=`) && !text.includes("This email has no link");
      if (!want[k]) {
        expect(links, `${k}: no link at all`).toBe(0);
        expect(text, `${k}: no address to follow`).not.toContain("/?event=");
        expect(text, `${k}: the step in words`).toMatch(/\nNext: [^\r\n]+\.\r?\n/);
        expect(text).toContain("ask the event's organiser");
      }
    }
    expect(seen, "a button exactly where the address opens the event").toEqual(want);
    // The preview says which it is for the role's first member (the administrator).
    const pv = await sa.get(`/api/admin/competitions/${comp.id}/team-report/preview?persona=sales`);
    expect(pv.ok, pv.text).toBeTruthy();
    expect(pv.body.cta_link).toBe(true);
  });

  test("nothing flagged: the SE is told so and offered the next step; with no owner a manager is told to assign", async () => {
    const sa = await admin();
    // Its own precondition: team members must be at an allowed domain (another
    // test in this describe setting the list is not this test's to rely on).
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp, taskIds } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 1 });
    const q = qTasks(comp.id);
    await addTeam(sa, comp.id, [["se", "Sean"], ["marketing_manager", "Max"]]);
    const p = await person("clean");
    const hot = await person("hotty", { first: "Hal", last: "Hot" });
    await assign(sa, comp.id, [p, hot]);
    await enter(p, comp.id); await enter(hot, comp.id);
    await submit(p, comp.id, taskIds[0], "right0");
    await answerQ(hot, comp.id, q, "follow_up", 0);

    let se = await preview(sa, comp.id, "se");
    expect(se.cta.text, "a live event: not 'Open the event'").toBe("Review the event");
    expect(se.text).toContain("Nothing needs fixing.");
    expect(se.subject).toContain("so far");
    // Ruling 79: these members' addresses open nothing, so each step is one they
    // can take without the event's page.
    expect(se.cta_link, "PRECONDITION: no account behind the address").toBe(false);
    expect(se.text).toContain("\nNext: Read the figures below.");

    const mgr = await preview(sa, comp.id, "manager");
    expect(mgr.cta.text, "no SDR or Marketing owner").toBe("Assign the 1 hot lead");
    expect(mgr.text).toContain("1 hot lead still to contact has no owner yet.");
    expect(mgr.text).toContain("\nNext: Ask the event's organiser to add an SDR or a Marketing owner.");

    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    se = await preview(sa, comp.id, "se");
    expect(se.cta.text, "an ended event").toBe("Clone for the next event");
    expect(se.subject).toContain("is over");
    expect(se.text).toContain("\nNext: Ask the event's organiser to clone it for the next event.");
  });

  test("answering anything counts as playing; challenge figures stay scoring only; no podium for nothing", async () => {
    const sa = await admin();
    // Its own precondition: team members must be at an allowed domain (another
    // test in this describe setting the list is not this test's to rely on).
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp, taskIds } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 1 });
    const q = qTasks(comp.id);
    await addTeam(sa, comp.id, [["se", "Sean"]]);
    const ps = [await person("pl1"), await person("pl2"), await person("pl3")];
    await assign(sa, comp.id, ps);
    for (const p of ps) { await enter(p, comp.id); await answerQ(p, comp.id, q, "scanner", 1); }

    let rep = (await sa.get(`/api/admin/competitions/${comp.id}/team-report`)).body;
    expect(rep.summary.played, "all three answered a question").toBe(3);
    expect(rep.challenges.map(c => c.id), "scoring challenges only").toEqual([taskIds[0]]);
    expect(rep.challenges[0].attempters).toBe(0);
    expect(rep.podium, "nobody has scored").toEqual([]);
    let se = await preview(sa, comp.id, "se");
    expect(se.subject).toContain("3 played");
    expect(se.text).toContain("3 played (100%)");
    expect(se.text).not.toMatch(/Podium|0 points/);
    expect(se.text, "no rate to average, so no blank tile").not.toContain("average solve rate");

    // Someone scores: they alone are on the podium, on one line.
    const ok = await submit(ps[0], comp.id, taskIds[0], "right0");
    expect(ok.body.correct).toBe(true);
    rep = (await sa.get(`/api/admin/competitions/${comp.id}/team-report`)).body;
    expect(rep.podium.map(g => [g.session, g.late, g.places.map(x => x.score)]), "one unnamed group on a sessionless event").toEqual([[null, false, [50]]]);
    se = await preview(sa, comp.id, "se");
    expect((se.text.match(/Podium:/g) || []).length).toBe(1);
    expect(se.text).toContain("50 points");
    expect(se.text).toContain("100%");
  });
});

test.describe("the emails on a phone, and whose events a manager's comparison counts", () => {
  test("every persona's email fits a 360 px phone with no media query to help (the preview carries no sheet)", async ({ browser }) => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp, taskIds } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 1 });
    const q = qTasks(comp.id);
    const a = await person("dupa", { first: "Priya", last: "Nair", company: "Emirates NBD", title: "Engineering Manager" });
    const b = await person("dupb", { first: "Priya", last: "Nair", company: "Emirates NBD", title: "Engineering Manager" });
    await assign(sa, comp.id, [a, b]);
    for (const [role, name] of [["se", "Sean"], ["marketing", "Mia"], ["sales", "Sal"], ["sdr", "Sid"], ["sales_manager", "Max"]]) {
      const r = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role, name, email: `${name.toLowerCase()}-${stamp()}@corp.example` }, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
    }
    for (const p of [a, b]) {
      await enter(p, comp.id);
      expect((await submit(p, comp.id, taskIds[0], "wrong")).body.correct).toBe(false);
      await answerQ(p, comp.id, q, "developers", 3);
      await answerQ(p, comp.id, q, "evaluating", 1);
    }
    const tgt = await sa.put(`/api/admin/competitions/${comp.id}/team-targets`, { lead_target: 40, hot_lead_target: 5 }, await sa.h());
    expect(tgt.ok, tgt.text).toBeTruthy();

    const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await ctx.newPage();
    const over = {};
    for (const persona of ["se", "marketing", "sales", "sdr", "manager"]) {
      const r = await sa.get(`/api/admin/competitions/${comp.id}/team-report/preview?persona=${persona}`);
      expect(r.ok, r.text).toBeTruthy();
      expect(r.body.html, `${persona}: a sheet here would prove nothing`).not.toContain("<style");
      await page.setContent(r.body.html);
      const tiles = await page.locator(".m-panel").count();
      expect(tiles, `${persona}: the mail rendered`).toBeGreaterThan(0);
      const seen = await page.evaluate(() => {
        const width = document.documentElement.scrollWidth;
        // Innermost first: the element that sticks out, not the tables round it.
        const out = [...document.body.querySelectorAll("*")].reverse().find(e => e.getBoundingClientRect().right > 360);
        return { width, out: out ? `${out.tagName}: ${out.textContent.trim().slice(0, 40)}` : null };
      });
      if (seen.width > 360) over[persona] = seen;
    }
    expect(over, "no persona's email scrolls sideways").toEqual({});
    const mkt = (await sa.get(`/api/admin/competitions/${comp.id}/team-report/preview?persona=marketing`)).body;
    expect(mkt.text, "the status is still said").toContain("Possible duplicate");
    expect(mkt.text, "both answers stay").toContain("Developers: 1000+");
    expect(mkt.text).toContain("Evaluating: Yes, within 3 months");
    expect(mkt.text, "where a lead came from stays").toMatch(/Source: Added by /);
    const sdr = (await sa.get(`/api/admin/competitions/${comp.id}/team-report/preview?persona=sdr`)).body;
    expect(sdr.text).toMatch(/Source: Added by /);
    expect(sdr.text).not.toContain("Arrived via");
    await ctx.close();
  });

  test("an event admin's comparison counts only events they hold; a superadmin's counts all", async () => {
    const sa = await admin();
    const { comp: past } = await makeEvent(sa, { kind: "booth", startAgoMs: 3 * 3600e3, minutes: 600, tasks: 0 });
    const lead = await person("peerlead", { first: "Pia", last: "Peer" });
    await assign(sa, past.id, [lead]);
    expect((await sa.post(`/api/admin/competitions/${past.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    const { comp } = await makeEvent(sa, { kind: "booth", startAgoMs: 60_000, minutes: 600, tasks: 0 });
    const ea = await person("peerea");
    expect((await sa.post(`/api/admin/competitions/${comp.id}/admins`, { userId: ea.id }, await sa.h())).ok).toBeTruthy();
    const eac = client();
    expect((await codeSignIn(eac, ea.email)).body.ok).toBe(true);

    let r = await sa.get(`/api/admin/competitions/${comp.id}/team-report?peer=1`);
    expect(r.ok, r.text).toBeTruthy();
    expect(r.body.peer && r.body.peer.events, "control: the earlier event is there to be counted").toBeGreaterThanOrEqual(1);
    r = await eac.get(`/api/admin/competitions/${comp.id}/team-report?peer=1`);
    expect(r.ok, r.text).toBeTruthy();
    expect(r.body.peer, "no event but this one in their scope").toBeNull();
    expect((await sa.post(`/api/admin/competitions/${past.id}/admins`, { userId: ea.id }, await sa.h())).ok).toBeTruthy();
    await expect.poll(async () => {
      const x = await eac.get(`/api/admin/competitions/${comp.id}/team-report?peer=1`);
      return x.body.peer && x.body.peer.events;
    }, { message: "granted the earlier event, they see it counted", timeout: 5000 }).toBe(1);
  });
});

test.describe("a failed send, Send now, and what the records hold", () => {
  test.afterEach(() => { smtp.rejectRecipients(null); smtp.release(); });

  // A live event, ended now, with a team and one lead who answered.
  async function endedWithTeam(sa, members) {
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp, taskIds } = await makeEvent(sa, { tasks: 2 });
    const lead = await person("rtlead");
    await assign(sa, comp.id, [lead]);
    await enter(lead, comp.id);
    expect((await submit(lead, comp.id, taskIds[0], "right0")).body.correct).toBe(true);
    const team = {};
    for (const [role, name] of members) {
      const email = `${name.toLowerCase()}-${stamp()}@corp.example`;
      const r = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role, name, email }, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
      team[name] = email;
    }
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    return { comp, lead, team };
  }
  const job = (compId) => sql(db => db.prepare("SELECT kind, passes, last_error FROM team_report_jobs WHERE competition_id=? AND kind='wrapup'").get(compId));
  const ranRows = (compId) => sql(db => db.prepare("SELECT kind FROM team_report_runs WHERE competition_id=? AND kind='wrapup'").all(compId)).length;
  const stampedAt = (compId, userId) => {
    const r = sql(db => db.prepare("SELECT first_reported_at FROM event_leads WHERE competition_id=? AND user_id=?").get(compId, userId));
    return r ? r.first_reported_at : null;
  };

  test("a send that fails keeps its job and is retried; whoever received it is never sent it twice", async () => {
    const sa = await admin();
    const { comp, lead, team } = await endedWithTeam(sa, [["marketing", "Mia"], ["se", "Sid"]]);
    const mia0 = mailsTo(team.Mia).length, sid0 = mailsTo(team.Sid).length;
    smtp.rejectRecipients(a => a.toLowerCase() === team.Sid.toLowerCase());
    let out = await tick(sa);
    expect(out.retried, `the pass reports the retry: ${JSON.stringify(out)}`).toBe(1);
    // Marketing gets its report and, with no SDR on the team, the SDR share too.
    const miaFirst = mailsTo(team.Mia).length - mia0;
    expect(miaFirst, "Marketing received the wrap-up").toBeGreaterThan(0);
    expect(mailsTo(team.Sid).length - sid0, "PRECONDITION: the SE's send failed").toBe(0);
    expect(job(comp.id), "the job stays, counted and marked").toMatchObject({ passes: 1, last_error: "send_failed" });
    expect(ranRows(comp.id), "the run is not recorded while a send failed").toBe(0);
    // Marketing RECEIVED it, with this lead in its lead file: the lead is reported,
    // at the instant of that first delivery (the ledger's sent_at).
    const firstSent = sql(db => db.prepare("SELECT MIN(sent_at) AS at FROM team_report_sends WHERE competition_id=? AND kind='wrapup' AND status='sent'").get(comp.id)).at;
    expect(firstSent, "PRECONDITION: a delivery is in the ledger").toBeTruthy();
    expect(stampedAt(comp.id, lead.id), "the lead Marketing received is stamped at that delivery").toBe(firstSent);
    // The relay recovers: the next pass sends the SE theirs and nobody a second copy.
    smtp.rejectRecipients(null);
    out = await tick(sa);
    expect(mailsTo(team.Sid).length - sid0, "the retry reached the SE").toBe(1);
    expect(mailsTo(team.Mia).length - mia0, "and did not mail Marketing again").toBe(miaFirst);
    expect(job(comp.id), "the job is done").toBeUndefined();
    expect(ranRows(comp.id), "the run is recorded once everyone has it").toBe(1);
    expect(stampedAt(comp.id, lead.id), "and the stamp is the first delivery's, not moved by the retry").toBe(firstSent);
    const ledger = sql(db => db.prepare("SELECT status FROM team_report_sends WHERE competition_id=? AND kind='wrapup'").all(comp.id));
    expect(ledger.length, "PRECONDITION: every message is in the ledger").toBe(miaFirst + 1);
    expect(ledger.every(l => l.status === "sent"), `the ledger says every one was sent: ${JSON.stringify(ledger)}`).toBe(true);
    // The Team section's read carries the ledger.
    const t = await sa.get(`/api/admin/competitions/${comp.id}/team`);
    expect(t.body.recent_sends.filter(s => s.kind === "wrapup").map(s => s.status)).toEqual(ledger.map(() => "sent"));
  });

  test("a late entrant who joins between a failed pass and its retry is in no report the team received: the delta carries them", async () => {
    // A Booth Event (late entry open after the end): Marketing receives the
    // wrap-up, the SE's send fails; a late entrant joins, late entries are
    // closed and the relay recovers while the wrap-up is still retrying.
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp } = await makeEvent(sa, { kind: "booth", minutes: 120 });
    const early = await person("rtearly", { company: "Early Co" });
    await assign(sa, comp.id, [early]);
    const team = {};
    for (const [role, name] of [["marketing", "Mona"], ["se", "Sid"]]) {
      const email = `${name.toLowerCase()}-${stamp()}@corp.example`;
      expect((await sa.post(`/api/admin/competitions/${comp.id}/team`, { role, name, email }, await sa.h())).ok).toBeTruthy();
      team[name] = email;
    }
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    smtp.rejectRecipients(a => a.toLowerCase() === team.Sid.toLowerCase());
    const m0 = smtp.messages.length;
    let out = await tick(sa);
    expect(out.retried, `PRECONDITION: the SE's send failed and is retried: ${JSON.stringify(out)}`).toBe(1);
    const monaCsvs = (since) => mailsTo(team.Mona, since).map(csvPart).filter(Boolean);
    expect(monaCsvs(m0).some(c => c.includes(early.email)), "PRECONDITION: Marketing's wrap-up holds the early lead").toBe(true);
    expect(stampedAt(comp.id, early.id), "the early lead is reported").toBeTruthy();

    const late = await person("rtlate", { company: "Late Co" });
    await assign(sa, comp.id, [late]);
    const close = await sa.post(`/api/admin/competitions/${comp.id}/late-entry/close`, {}, await sa.h());
    expect(close.ok, close.text).toBeTruthy();
    expect(sql(db => db.prepare("SELECT 1 AS x FROM team_report_jobs WHERE competition_id=? AND kind='delta'").get(comp.id)),
      "PRECONDITION: no delta is queued by the close while the wrap-up has not run").toBeUndefined();
    smtp.rejectRecipients(null);
    const m1 = smtp.messages.length;
    out = await tick(sa);
    expect(mailsTo(team.Sid, m1).length, "the retry reached the SE").toBe(1);
    expect(ranRows(comp.id), "the wrap-up is done").toBe(1);
    expect(stampedAt(comp.id, late.id), "the late entrant is in no report Marketing received: not reported").toBeNull();
    expect(sql(db => db.prepare("SELECT end_key FROM team_report_jobs WHERE competition_id=? AND kind='delta'").get(comp.id)),
      "the wrap-up queues the delta that carries them").toBeTruthy();
    const m2 = smtp.messages.length;
    await tick(sa);
    const delta = monaCsvs(m2);
    expect(delta.length, `Marketing gets the delta: ${delta.length}`).toBe(1);
    expect(delta[0], "holding the late entrant").toContain(late.email);
    expect(delta[0], "and not the lead it already had").not.toContain(early.email);
    expect(monaCsvs(m0).filter(c => c.includes(late.email)).length, "the late entrant reached Marketing exactly once").toBe(1);
  });

  test("a delta's recipient who is retried gets the leads its first pass reported to the others", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp } = await makeEvent(sa, { kind: "booth", minutes: 120 });
    const early = await person("dlearly", { company: "Early Co" });
    await assign(sa, comp.id, [early]);
    const team = {};
    for (const [role, name] of [["marketing", "Mona"], ["marketing", "Moira"]]) {
      const email = `${name.toLowerCase()}-${stamp()}@corp.example`;
      expect((await sa.post(`/api/admin/competitions/${comp.id}/team`, { role, name, email }, await sa.h())).ok).toBeTruthy();
      team[name] = email;
    }
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    await tick(sa);
    expect(ranRows(comp.id), "PRECONDITION: the wrap-up went to both").toBe(1);
    const late = await person("dllate", { company: "Late Co" });
    await assign(sa, comp.id, [late]);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/late-entry/close`, {}, await sa.h())).ok).toBeTruthy();
    // The delta's first pass: Mona receives it, Moira's send fails.
    smtp.rejectRecipients(a => a.toLowerCase() === team.Moira.toLowerCase());
    const m0 = smtp.messages.length;
    let out = await tick(sa);
    const deltaJob = () => sql(db => db.prepare("SELECT passes, last_error FROM team_report_jobs WHERE competition_id=? AND kind='delta'").get(comp.id));
    expect(deltaJob(), `PRECONDITION: the delta is retried: ${JSON.stringify(out)}`).toMatchObject({ passes: 1, last_error: "send_failed" });
    const csvs = (who, since) => mailsTo(team[who], since).map(csvPart).filter(Boolean);
    expect(csvs("Mona", m0).filter(c => c.includes(late.email)).length, "Mona's delta holds the late entrant").toBe(1);
    expect(stampedAt(comp.id, late.id), "who is reported by that delivery").toBeTruthy();
    smtp.rejectRecipients(null);
    const m1 = smtp.messages.length;
    out = await tick(sa);
    const moira = csvs("Moira", m1);
    expect(moira.length, `the retry sends Moira her delta: ${JSON.stringify(out)}`).toBe(1);
    expect(moira[0], "with the late entrant the others got").toContain(late.email);
    expect(moira[0], "CONTROL: and not the wrap-up's lead").not.toContain(early.email);
    expect(mailsTo(team.Mona, m1).length, "Mona is not sent it again").toBe(0);
    expect(deltaJob(), "the delta is done").toBeUndefined();
  });

  test("a Send now that fails part-way says so and is on the History, inside the deadline and after it", async () => {
    test.setTimeout(60_000);
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp } = await makeEvent(sa, { tasks: 1 });
    const team = {};
    for (const [role, name] of [["marketing", "Fia"], ["sales", "Fay"]]) {
      const email = `${name.toLowerCase()}-${stamp()}@corp.example`;
      expect((await sa.post(`/api/admin/competitions/${comp.id}/team`, { role, name, email }, await sa.h())).ok).toBeTruthy();
      team[name] = email;
    }
    // Sales' claim in the ledger fails: the run throws after Marketing's send.
    const trig = `trg_fail_${stamp()}`.replace(/[^a-z0-9_]/gi, "_");
    sql(db => db.exec(`CREATE TRIGGER ${trig} BEFORE INSERT ON team_report_sends WHEN NEW.recipient = '${team.Fay}' BEGIN SELECT RAISE(ABORT, 'test: refused'); END`));
    const hist = () => sql(db => db.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type='team_report_sent' ORDER BY changed_at").all(comp.id)).map(r => JSON.parse(r.details));
    try {
      const r = await sa.post(`/api/admin/competitions/${comp.id}/team-report/send`, {}, await sa.h());
      expect(r.status, `a failure, not a count: ${r.text}`).toBe(500);
      expect(r.body.code).toBe("team_report_send_failed");
      expect(r.body.sent, "it says what went before it stopped").toBe(1);
      expect(r.body.ok, "never ok").toBeUndefined();
      expect(hist().map(h => [h.kind, h.error, h.sent]), "the History records it").toEqual([["manual", "internal_error", 1]]);
      expect(hist()[0].req_id, "with the request's context").toBeTruthy();
      // After the deadline: the relay holds Marketing's send past 10 s.
      smtp.hold();
      const d = await sa.post(`/api/admin/competitions/${comp.id}/team-report/send`, {}, await sa.h());
      expect(d.ok, d.text).toBeTruthy();
      expect(d.body.deferred, "PRECONDITION: answered before it finished").toBe(true);
      smtp.release();
      await expect.poll(() => hist().length, { timeout: 15000, message: "the deferred failure is on the History" }).toBe(2);
      expect(hist()[1]).toMatchObject({ kind: "manual", error: "internal_error", sent: 1 });
    } finally { sql(db => db.exec(`DROP TRIGGER IF EXISTS ${trig}`)); smtp.release(); }
    // CONTROL: with nothing failing, Send now answers its counts.
    const ok = await sa.post(`/api/admin/competitions/${comp.id}/team-report/send`, {}, await sa.h());
    expect(ok.ok, ok.text).toBeTruthy();
    expect(ok.body.sent).toBe(2);
    expect(ok.body.error).toBeUndefined();
  });

  test("the last pass gives up: the run is recorded, and leads nobody received are not stamped reported", async () => {
    const sa = await admin();
    const { comp, lead, team } = await endedWithTeam(sa, [["se", "Sol"]]);
    smtp.rejectRecipients(a => a.toLowerCase() === team.Sol.toLowerCase());
    for (let i = 1; i <= 2; i++) {
      await tick(sa);
      expect(job(comp.id), `pass ${i}: still retrying`).toMatchObject({ passes: i });
    }
    await tick(sa);
    expect(job(comp.id), "after the last pass the job is closed").toBeUndefined();
    expect(ranRows(comp.id), "and the run recorded").toBe(1);
    expect(stampedAt(comp.id, lead.id), "nobody received it: the leads stay unreported").toBeFalsy();
    const hist = sql(db => db.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type='team_report_sent'").all(comp.id)).map(r => JSON.parse(r.details));
    expect(hist.map(h => h.failed), "the History says it failed").toEqual([1]);
  });

  // A pass that THROWS (here: the database refuses the leads' owner write, which
  // comes before any send) is retried like a failed send, then given up after
  // MAX_PASSES (3): the job goes, a warning is logged and the History says so.
  // The fault is an ABORT trigger on this event's own `event_leads` rows.
  const failLeadWrites = (compId) => {
    const trig = `zz_tr_crash_${compId.replace(/[^a-zA-Z0-9]/g, "")}`;
    sql(db => db.exec(`CREATE TRIGGER ${trig} BEFORE INSERT ON event_leads WHEN NEW.competition_id='${compId}' BEGIN SELECT RAISE(ABORT,'injected'); END;`));
    expect(sql(db => db.prepare("SELECT 1 x FROM sqlite_master WHERE type='trigger' AND name=?").get(trig)), "PRECONDITION: the fault is armed").toBeTruthy();
    return () => sql(db => db.exec(`DROP TRIGGER IF EXISTS ${trig}`));
  };
  const givenUp = (compId) => sql(db => db.prepare("SELECT changed_by, details FROM competition_events WHERE competition_id=? AND event_type='team_report_given_up'").all(compId))
    .map(r => ({ by: r.changed_by, ...JSON.parse(r.details) }));

  test("a report whose pass throws every time is given up after the last pass, logged and on the History; a later pass does nothing", async () => {
    const sa = await admin();
    const { comp, team } = await endedWithTeam(sa, [["marketing", "Cora"]]);
    const unarm = failLeadWrites(comp.id);
    try {
      const m0 = smtp.messages.length;
      for (let i = 1; i <= 2; i++) {
        await tick(sa);
        expect(job(comp.id), `pass ${i}: kept for another try`).toMatchObject({ passes: i, last_error: "internal_error" });
        expect(givenUp(comp.id), `pass ${i}: not given up yet`).toEqual([]);
      }
      await tick(sa);
      expect(job(comp.id), "after the last pass the job is gone").toBeUndefined();
      expect(givenUp(comp.id), "the History says it was given up").toEqual([
        expect.objectContaining({ by: "system", kind: "wrapup", passes: 3, error: "internal_error" }),
      ]);
      const line = await findLogLine(path.join(dataDir, "logs"),
        j => j.level === "warn" && j.competition_id === comp.id && /given up/.test(j.msg || ""), { what: "the given-up warning" });
      expect(line).toMatchObject({ kind: "wrapup", passes: 3 });
      expect(mailsTo(team.Cora, m0).length, "nothing was sent").toBe(0);
      expect(ranRows(comp.id), "no run is recorded").toBe(0);
      // A later pass finds nothing to do for it.
      const out = await tick(sa);
      expect(job(comp.id), `still gone: ${JSON.stringify(out)}`).toBeUndefined();
      expect(givenUp(comp.id).length, "recorded once").toBe(1);
      expect(mailsTo(team.Cora, m0).length).toBe(0);
    } finally { unarm(); }
  });

  test("CONTROL: a report whose pass throws once is retried and sent; nothing is given up", async () => {
    const sa = await admin();
    const { comp, team } = await endedWithTeam(sa, [["marketing", "Cleo"]]);
    const unarm = failLeadWrites(comp.id);
    try {
      await tick(sa);
      expect(job(comp.id), "PRECONDITION: the first pass threw and kept the job").toMatchObject({ passes: 1, last_error: "internal_error" });
    } finally { unarm(); }
    const m0 = smtp.messages.length;
    await tick(sa);
    // (With no SDR, Marketing is sent the report and the lead cards: two mails.)
    const got = mailsTo(team.Cleo, m0);
    expect(got.map(subjectOf).some(x => /— 1 lead from /.test(x)), `the retry sends the report: ${got.map(subjectOf).join(" | ")}`).toBe(true);
    for (const m of got) expectStopLine(m, "a retried wrap-up");
    expect(job(comp.id), "and closes the job").toBeUndefined();
    expect(ranRows(comp.id)).toBe(1);
    expect(givenUp(comp.id)).toEqual([]);
  });

  test("Send now answers within its deadline, and a second press while it is still going out is refused", async () => {
    test.setTimeout(60_000);
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp } = await makeEvent(sa, { tasks: 1 });
    const email = `nina-${stamp()}@corp.example`;
    expect((await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "marketing", name: "Nina", email }, await sa.h())).ok).toBeTruthy();
    const n0 = mailsTo(email).length;
    smtp.hold();
    const t0 = Date.now();
    const first = await sa.post(`/api/admin/competitions/${comp.id}/team-report/send`, {}, await sa.h());
    const took = Date.now() - t0;
    expect(first.ok, first.text).toBeTruthy();
    expect(first.body.deferred, "the relay is slow: answered before it finished").toBe(true);
    expect(took, "within the 10 s fan-out deadline (and not long after it)").toBeLessThan(14_000);
    const second = await sa.post(`/api/admin/competitions/${comp.id}/team-report/send`, {}, await sa.h());
    expect(second.status, "a second press while it is out is refused").toBe(409);
    expect(second.body.code).toBe("team_report_send_running");
    smtp.release();
    await expect.poll(() => sql(db => db.prepare("SELECT COUNT(*) AS n FROM competition_events WHERE competition_id=? AND event_type='team_report_sent'").get(comp.id).n),
      { timeout: 15000, message: "the deferred run finishes and is recorded" }).toBe(1);
    expect(mailsTo(email).length - n0, "one report, not two").toBe(1);
    expectStopLine(mailsTo(email).slice(-1)[0], "Send now");
    // CONTROL: once it has gone, Send now works again (and answers in full).
    const third = await sa.post(`/api/admin/competitions/${comp.id}/team-report/send`, {}, await sa.h());
    expect(third.ok, third.text).toBeTruthy();
    expect(third.body.deferred).toBeUndefined();
    expect(third.body.sent).toBe(1);
  });

  test("a team member's address is never written to an audit record; the domain and a fingerprint are", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp } = await makeEvent(sa, { tasks: 1 });
    const email = `audit-${stamp()}@corp.example`;
    expect((await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "marketing", name: "Aud", email }, await sa.h())).ok).toBeTruthy();
    const count = () => sql(db => db.prepare("SELECT COUNT(*) AS n FROM orphan_events WHERE event_type='email_sent' AND details LIKE '%event_team_report%'").get().n);
    const before = count();
    const r = await sa.post(`/api/admin/competitions/${comp.id}/team-report/send`, {}, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    expect(r.body.sent, r.text).toBe(1);
    await expect.poll(count, { timeout: 10000, message: "the send is recorded" }).toBeGreaterThan(before);
    const all = sql(db => db.prepare("SELECT details FROM orphan_events WHERE event_type='email_sent' AND details LIKE '%event_team_report%'").all()).map(x => x.details);
    for (const d of all) expect(d.toLowerCase(), "no address in the record").not.toContain(email.toLowerCase());
    const parsed = all.map(d => JSON.parse(d));
    expect(parsed.some(d => d.to_domain === "corp.example" && /^tm_/.test(d.to_fp)), "the domain and a fingerprint are recorded").toBe(true);
    expect(parsed.every(d => d.to === undefined), "never `to`").toBe(true);
  });

  // SWEEP #149 (operator ruling, 24 Nov 2026): organisers read the send ledger as
  // the Team section's recent sends, so a member's address leaves it with them.
  // Their rows stay (the ledger is the once-only key and the reminder's "went
  // out" check), named by the address's domain and the `tm_` fingerprint the
  // mail's own `email_sent` row carries.
  const fpOf = (addr) => "tm_" + require("crypto").createHash("sha256").update(addr.trim().toLowerCase()).digest("hex").slice(0, 12);
  const removedForm = (addr) => `removed:${fpOf(addr)}:${addr.split("@")[1]}`;
  const ledgerOf = (compId) => sql(db => db.prepare("SELECT kind, end_key, recipient, persona, status, sent_at FROM team_report_sends WHERE competition_id=? ORDER BY recipient, persona, kind").all(compId));
  const rowsOfAddr = (compId, recipient) => ledgerOf(compId).filter(r => r.recipient === recipient).map(r => [r.kind, r.persona, r.status, r.sent_at]);
  const memberOf = async (sa, compId, email, role) => (await sa.get(`/api/admin/competitions/${compId}/team`)).body.members.find(m => m.email === email && (!role || m.role === role));

  test("sweep #149: a removed member's address leaves the send ledger and the Team read, its rows kept under the domain and the mail's own fingerprint ('removed member (domain)'); added back, it takes them back and is never sent a report it already received", async () => {
    const sa = await admin();
    const { comp, team } = await endedWithTeam(sa, [["marketing", "Mia"], ["se", "Sid"]]);
    // The SE's send fails, so the wrap-up keeps its job for a retry.
    smtp.rejectRecipients(a => a.toLowerCase() === team.Sid.toLowerCase());
    const out = await tick(sa);
    expect(out.retried, `PRECONDITION: the wrap-up is retried: ${JSON.stringify(out)}`).toBe(1);
    const miaRows = rowsOfAddr(comp.id, team.Mia);
    expect(miaRows.map(r => [r[1], r[2]]), "PRECONDITION: Marketing received its report and, with no SDR, the leads' share, under her address").toEqual([["marketing", "sent"], ["sdr", "sent"]]);
    expect(rowsOfAddr(comp.id, team.Sid).map(r => r[2]), "PRECONDITION: the SE's failed").toEqual(["failed"]);
    // Removed from the team.
    const mia = await memberOf(sa, comp.id, team.Mia);
    const del = await sa.del(`/api/admin/competitions/${comp.id}/team/${mia.id}`, await sa.h());
    expect(del.ok, del.text).toBeTruthy();
    // BY VALUE: the address is nowhere in the ledger…
    expect(JSON.stringify(ledgerOf(comp.id)).toLowerCase(), "the address is nowhere in the event's ledger").not.toContain(team.Mia.toLowerCase());
    // …her rows are all still there, as they were, under the domain and the fingerprint…
    expect(rowsOfAddr(comp.id, removedForm(team.Mia)), "her rows keep their kind, persona, status and delivery time").toEqual(miaRows);
    // …which is the mail's own record's: one fingerprint, the same in both places.
    const mailFps = () => sql(db => db.prepare("SELECT details FROM orphan_events WHERE event_type='email_sent' AND details LIKE '%event_team_report%'").all())
      .map(r => JSON.parse(r.details)).filter(d => d.to_fp === fpOf(team.Mia) && d.to_domain === "corp.example").length;
    await expect.poll(mailFps, { timeout: 10000, message: "her two mails' records carry the ledger's fingerprint" }).toBe(2);
    // CONTROL: the SE, still on the team, keeps his address.
    expect(rowsOfAddr(comp.id, team.Sid).map(r => r[2])).toEqual(["failed"]);
    // The Team read names her by her domain only.
    const t = await sa.get(`/api/admin/competitions/${comp.id}/team`);
    expect(t.ok, t.text).toBeTruthy();
    expect(t.text.toLowerCase(), "the address is nowhere in the Team read").not.toContain(team.Mia.toLowerCase());
    expect(t.text, "nor the stored form").not.toContain("removed:");
    expect(t.body.recent_sends.filter(s => s.recipient === "removed member (corp.example)").map(s => [s.persona, s.status]).sort(),
      "the recent sends say 'removed member (corp.example)'").toEqual([["marketing", "sent"], ["sdr", "sent"]]);
    expect(t.body.recent_sends.filter(s => s.recipient === team.Sid).map(s => s.status), "CONTROL: a member is named by the address").toEqual(["failed"]);
    // Added back: the address takes its rows back…
    const re = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "marketing", name: "Mia", email: team.Mia }, await sa.h());
    expect(re.ok, re.text).toBeTruthy();
    expect(rowsOfAddr(comp.id, team.Mia), "back on the team, her rows carry her address again").toEqual(miaRows);
    expect(rowsOfAddr(comp.id, removedForm(team.Mia))).toEqual([]);
    // …so the retry sends the SE his report and her nothing more.
    smtp.rejectRecipients(null);
    const m1 = smtp.messages.length;
    const out2 = await tick(sa);
    expect(mailsTo(team.Sid, m1).length, `the retry reached the SE: ${JSON.stringify(out2)}`).toBe(1);
    expect(mailsTo(team.Mia, m1).length, "and never sent Marketing the wrap-up she already had").toBe(0);
    expect(job(comp.id), "the wrap-up is done").toBeUndefined();
    expect(rowsOfAddr(comp.id, team.Mia), "one row per persona, as before").toEqual(miaRows);
  });

  test("sweep #149: a member removed while a report is going out: the send in flight settles on the rewritten row, and nothing more is sent to them or recorded under their address", async () => {
    const sa = await admin();
    // Marketing alone, with no SDR: Send now sends its report, then the leads' share.
    const { comp, team } = await endedWithTeam(sa, [["marketing", "Mia"]]);
    const mia = await memberOf(sa, comp.id, team.Mia);
    const m0 = smtp.messages.length;
    smtp.hold();
    // (A request cut by a failure below reads as a refusal, not an unhandled rejection.)
    const sending = sa.post(`/api/admin/competitions/${comp.id}/team-report/send`, {}, await sa.h()).catch(e => ({ ok: false, body: {}, text: `send now: ${e.message}` }));
    // Her first report reaches the relay, which holds its reply: the send is in flight.
    await expect.poll(() => mailsTo(team.Mia, m0).length, { timeout: 10000, message: "her first report is on the wire, waiting for the relay" }).toBe(1);
    expect(smtp.heldCount(), "PRECONDITION: its reply is held").toBeGreaterThanOrEqual(1);
    expect(ledgerOf(comp.id).map(r => [r.recipient, r.persona, r.status]), "PRECONDITION: claimed under her address, in flight").toEqual([[team.Mia, "marketing", "sending"]]);
    const del = await sa.del(`/api/admin/competitions/${comp.id}/team/${mia.id}`, await sa.h());
    expect(del.ok, del.text).toBeTruthy();
    smtp.release();
    const r = await sending;
    expect(r.ok, r.text).toBeTruthy();
    await expect.poll(() => ledgerOf(comp.id).map(x => [x.recipient, x.persona, x.status]), {
      timeout: 10000, message: `the send in flight settles on the rewritten row; the leads' share is never claimed: ${r.text}`,
    }).toEqual([[removedForm(team.Mia), "marketing", "sent"]]);
    expect(r.body.deferred, "answered inside Send now's deadline, so its counts are final").toBeUndefined();
    expect([r.body.sent, r.body.skipped, r.body.messages], "Send now's answer: two composed, one sent, the leads' share skipped").toEqual([1, 1, 2]);
    expect(mailsTo(team.Mia, m0).length, "nothing more went to her").toBe(1);
    expect(JSON.stringify(ledgerOf(comp.id)).toLowerCase(), "the address is nowhere in the ledger").not.toContain(team.Mia.toLowerCase());
  });

  test("sweep #149 CONTROL: removed and added back in the same role while a report is going out, a member is sent the rest of it, each report once", async () => {
    const sa = await admin();
    const { comp, team } = await endedWithTeam(sa, [["marketing", "Mia"]]);
    const mia = await memberOf(sa, comp.id, team.Mia);
    const m0 = smtp.messages.length;
    smtp.hold();
    // (A request cut by a failure below reads as a refusal, not an unhandled rejection.)
    const sending = sa.post(`/api/admin/competitions/${comp.id}/team-report/send`, {}, await sa.h()).catch(e => ({ ok: false, body: {}, text: `send now: ${e.message}` }));
    await expect.poll(() => mailsTo(team.Mia, m0).length, { timeout: 10000, message: "her first report is on the wire, waiting for the relay" }).toBe(1);
    expect(ledgerOf(comp.id).map(r => [r.recipient, r.persona, r.status]), "PRECONDITION: claimed under her address, in flight").toEqual([[team.Mia, "marketing", "sending"]]);
    const del = await sa.del(`/api/admin/competitions/${comp.id}/team/${mia.id}`, await sa.h());
    expect(del.ok, del.text).toBeTruthy();
    expect(ledgerOf(comp.id).map(r => r.recipient), "PRECONDITION: removed, her row in flight takes the removed form").toEqual([removedForm(team.Mia)]);
    // Added back in the same role (a new member row): the row in flight is hers again.
    const re = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "marketing", name: "Mia", email: team.Mia }, await sa.h());
    expect(re.ok, re.text).toBeTruthy();
    expect(re.body.member.id, "PRECONDITION: a new member row").not.toBe(mia.id);
    smtp.release();
    const r = await sending;
    expect(r.ok, r.text).toBeTruthy();
    expect(r.body.deferred, "answered inside Send now's deadline, so its counts are final").toBeUndefined();
    expect([r.body.sent, r.body.skipped, r.body.messages], "both of her reports went").toEqual([2, 0, 2]);
    expect(ledgerOf(comp.id).map(x => [x.recipient, x.persona, x.status]), "each settled under her address").toEqual([[team.Mia, "marketing", "sent"], [team.Mia, "sdr", "sent"]]);
    expect(mailsTo(team.Mia, m0).length, "each report once").toBe(2);
  });

  test("sweep #149: an address that still holds another role keeps its rows; its last role's removal takes it out of this event's ledger only (CONTROL: another event's rows for it are untouched)", async () => {
    const sa = await admin();
    const { comp, team } = await endedWithTeam(sa, [["marketing", "Mia"]]);
    const two = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "sales", name: "Mia", email: team.Mia }, await sa.h());
    expect(two.ok, two.text).toBeTruthy();
    // A decoy event whose team holds the same address, ended and reported too
    // (two challenges, one solved: the all-solved end must not fire first).
    const decoy = await makeEvent(sa, { tasks: 2 });
    const dl = await person("rtdecoy");
    await assign(sa, decoy.comp.id, [dl]);
    await enter(dl, decoy.comp.id);
    expect((await submit(dl, decoy.comp.id, decoy.taskIds[0], "right0")).body.correct).toBe(true);
    expect((await sa.post(`/api/admin/competitions/${decoy.comp.id}/team`, { role: "marketing", name: "Mia", email: team.Mia }, await sa.h())).ok).toBeTruthy();
    expect((await sa.post(`/api/admin/competitions/${decoy.comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    await tick(sa);
    const mine = rowsOfAddr(comp.id, team.Mia), theirs = rowsOfAddr(decoy.comp.id, team.Mia);
    expect(mine.map(r => [r[1], r[2]]), "PRECONDITION: her three reports here, under her address").toEqual([["marketing", "sent"], ["sales", "sent"], ["sdr", "sent"]]);
    expect(theirs.map(r => [r[1], r[2]]), "PRECONDITION: and the decoy's").toEqual([["marketing", "sent"], ["sdr", "sent"]]);
    // One role removed: she is still on the team, so her rows keep her address.
    const del1 = await sa.del(`/api/admin/competitions/${comp.id}/team/${(await memberOf(sa, comp.id, team.Mia, "sales")).id}`, await sa.h());
    expect(del1.ok, del1.text).toBeTruthy();
    expect(rowsOfAddr(comp.id, team.Mia), "still a member: nothing rewritten").toEqual(mine);
    // Her last role removed: out of this event's ledger…
    const del2 = await sa.del(`/api/admin/competitions/${comp.id}/team/${(await memberOf(sa, comp.id, team.Mia, "marketing")).id}`, await sa.h());
    expect(del2.ok, del2.text).toBeTruthy();
    expect(rowsOfAddr(comp.id, team.Mia)).toEqual([]);
    expect(rowsOfAddr(comp.id, removedForm(team.Mia)), "every row kept, under the removed form").toEqual(mine);
    // …and only this one's: the decoy's team still holds her, and its rows her address.
    expect(rowsOfAddr(decoy.comp.id, team.Mia), "the decoy event's rows are untouched").toEqual(theirs);
    expect(rowsOfAddr(decoy.comp.id, removedForm(team.Mia))).toEqual([]);
  });

  // SWEEP #149, ONE DEFINITION: the removed form is lib/team-recipient.js's, a
  // module that requires only crypto, so db.js (the one-shot rewrite below) and
  // the live paths take it from one place and cannot disagree.
  test("sweep #149: the removed form is defined once, in a module that requires only crypto, which db.js's one-shot rewrite and the live paths share", () => {
    const TR = require("../lib/team-recipient");
    const addr = `mia-${stamp()}@corp.example`;
    expect(TR.removedRecipient(`  ${addr.toUpperCase()} `), "the address trimmed and lower-cased: the mail's own fingerprint, then the domain").toBe(removedForm(addr));
    expect(TR.teamMemberFingerprint(addr), "the fingerprint the mail's `email_sent` row records").toBe(fpOf(addr));
    expect(TR.recipientLabel(TR.removedRecipient(addr)), "read back by its domain").toBe("removed member (corp.example)");
    expect(TR.recipientLabel(addr), "CONTROL: an address reads as itself").toBe(addr);
    expect(TR.recipientLabel(`${TR.REMOVED_RECIPIENT_PREFIX}${fpOf(addr)}:`), "a removed form with no domain").toBe("removed member");
    expect(TR.domainOf("mia:x@corp.example"), "no address holds a ':', so none is ever read as the removed form").toBeNull();
    // PURE: db.js requires it at boot, and lib/audit.js or lib/event-team.js
    // (each requiring db.js) here would be a cycle at db.js's require time.
    const { stripJsComments } = require("./doc-registry");
    const read = (rel) => stripJsComments(fs.readFileSync(path.join(__dirname, "..", rel), "utf8"));
    const reqs = [...read("lib/team-recipient.js").matchAll(/\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map(m => m[1]);
    expect(reqs, "lib/team-recipient.js requires only crypto").toEqual(["crypto"]);
    // ONE DEFINITION: no other server source spells the removed form's prefix
    // or the fingerprint's (a second copy would drift from this one), and the
    // three that must agree take them from here: db.js's rewrite and the live
    // paths name the same rows, and the mail's record names the address as the
    // ledger does.
    const walk = (dir) => fs.readdirSync(path.join(__dirname, "..", dir), { withFileTypes: true })
      .flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith(".js") ? [`${dir}/${e.name}`] : []);
    const sources = ["server.js", "db.js", ...walk("lib"), ...walk("routes")];
    expect(sources.length, "PRECONDITION: the server sources were found").toBeGreaterThan(90);
    const spelled = sources.filter(rel => /["'`](?:removed:|tm_)/.test(read(rel)));
    expect(spelled, "the two prefixes are spelled in lib/team-recipient.js alone").toEqual(["lib/team-recipient.js"]);
    for (const rel of ["db.js", "lib/team-reports.js", "lib/email.js"]) {
      expect(read(rel), `${rel} takes them from lib/team-recipient.js`).toMatch(/require\(\s*["'](?:\.\/lib|\.)\/team-recipient["']\s*\)/);
    }
  });

  // SWEEP #149, ROWS FROM BEFORE THE RULE: an older release's member DELETE
  // rewrote nothing, so a member it removed left their rows under the address,
  // which the Team read would still show. The one-shot rewrite in db.js (marker
  // `team_report_removed_recipients_at`) puts them in the removed form the live
  // paths use. Every test server is a first boot, so the older release's state
  // is made by hand with the server stopped, and db.js runs over it at the next
  // boot.
  const REMOVED_MARKER = "team_report_removed_recipients_at";
  const removedMarker = () => sql(db => db.prepare("SELECT value FROM settings WHERE key=?").get(REMOVED_MARKER));

  test("sweep #149, rows from before the rule: a member an older release removed has their ledger rows rewritten once at boot to the removed form; the Team read says 'removed member (domain)', and added back the address takes them back and is sent nothing twice (CONTROLS: a member still on the team, a member removed since, the address on another event's team)", async () => {
    expect(removedMarker(), "a first boot writes the marker though it has nothing to rewrite").toBeTruthy();
    let sa = await admin();
    const { comp, team } = await endedWithTeam(sa, [["marketing", "Mia"], ["se", "Sid"], ["sales", "Rae"]]);
    // The SE's send fails, so the wrap-up keeps its job for a retry after the restarts.
    smtp.rejectRecipients(a => a.toLowerCase() === team.Sid.toLowerCase());
    const out = await tick(sa);
    expect(out.retried, `PRECONDITION: the wrap-up is retried: ${JSON.stringify(out)}`).toBe(1);
    const miaRows = rowsOfAddr(comp.id, team.Mia), sidRows = rowsOfAddr(comp.id, team.Sid);
    expect(miaRows.map(r => [r[1], r[2]]), "PRECONDITION: Marketing received its report and, with no SDR, the leads' share").toEqual([["marketing", "sent"], ["sdr", "sent"]]);
    expect(sidRows.map(r => r[2]), "PRECONDITION: the SE's failed").toEqual(["failed"]);
    // Rae leaves through the live DELETE, so her row already has the removed form.
    const rae = await memberOf(sa, comp.id, team.Rae);
    const delRae = await sa.del(`/api/admin/competitions/${comp.id}/team/${rae.id}`, await sa.h());
    expect(delRae.ok, delRae.text).toBeTruthy();
    const raeRows = rowsOfAddr(comp.id, removedForm(team.Rae));
    expect(raeRows.map(r => [r[1], r[2]]), "PRECONDITION: Rae's row is in the removed form").toEqual([["sales", "sent"]]);
    // Another event, whose team still holds Mia.
    const { comp: decoy } = await makeEvent(sa, { tasks: 0 });
    await kill();
    const at = new Date().toISOString();
    sql(db => {
      db.prepare("INSERT INTO event_team_members (id, competition_id, role, name, email, added_by, added_at) VALUES (?,?,?,?,?,?,?)")
        .run(require("crypto").randomUUID(), decoy.id, "marketing", "Mia", team.Mia, "superadmin", at);
      db.prepare("INSERT INTO team_report_sends (competition_id, kind, end_key, recipient, persona, status, created_at, sent_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(decoy.id, "manual", at, team.Mia, "marketing", "sent", at, at);
      // What an older release's member DELETE did: the member row gone, the ledger untouched.
      db.prepare("DELETE FROM event_team_members WHERE competition_id=? AND email=?").run(comp.id, team.Mia);
      db.prepare("DELETE FROM settings WHERE key=?").run(REMOVED_MARKER);
    });
    const decoyRows = rowsOfAddr(decoy.id, team.Mia);
    expect(decoyRows.map(r => [r[0], r[1], r[2]]), "PRECONDITION: the other event's row is under her address").toEqual([["manual", "marketing", "sent"]]);
    expect(rowsOfAddr(comp.id, team.Mia), "PRECONDITION: the older release's removal left her address in the ledger").toEqual(miaRows);
    expect(removedMarker(), "PRECONDITION: the one shot has not run on this database").toBeUndefined();
    await boot();
    // BY VALUE: her address is nowhere in the event's ledger…
    expect(JSON.stringify(ledgerOf(comp.id)).toLowerCase(), "her address is nowhere in the event's ledger").not.toContain(team.Mia.toLowerCase());
    // …and her rows are all still there, as they were, in the form the live paths use.
    expect(rowsOfAddr(comp.id, removedForm(team.Mia)), "her rows keep their kind, persona, status and delivery time, under the removed form").toEqual(miaRows);
    expect(rowsOfAddr(comp.id, team.Sid), "CONTROL: a member still on the team keeps the address").toEqual(sidRows);
    expect(rowsOfAddr(comp.id, removedForm(team.Rae)), "CONTROL: a row already in the removed form is left as it was").toEqual(raeRows);
    expect(rowsOfAddr(decoy.id, team.Mia), "CONTROL: another event whose team holds the address keeps it there").toEqual(decoyRows);
    expect(removedMarker(), "the marker is written").toBeTruthy();
    // The Team read names her by her domain only.
    sa = await admin();
    const t = await sa.get(`/api/admin/competitions/${comp.id}/team`);
    expect(t.ok, t.text).toBeTruthy();
    expect(t.text.toLowerCase(), "her address is nowhere in the Team read").not.toContain(team.Mia.toLowerCase());
    expect(t.text, "nor the stored form").not.toContain("removed:");
    expect(t.body.recent_sends.filter(s => s.recipient === "removed member (corp.example)").map(s => [s.persona, s.status]).sort(),
      "the recent reports say 'removed member (corp.example)' for her rows and Rae's").toEqual([["marketing", "sent"], ["sales", "sent"], ["sdr", "sent"]]);
    expect(t.body.recent_sends.filter(s => s.recipient === team.Sid).map(s => s.status), "CONTROL: a member is named by the address").toEqual(["failed"]);
    // Added back: the address takes the rewritten rows back…
    const re = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "marketing", name: "Mia", email: team.Mia }, await sa.h());
    expect(re.ok, re.text).toBeTruthy();
    expect(rowsOfAddr(comp.id, team.Mia), "back on the team, her rows carry her address again").toEqual(miaRows);
    expect(rowsOfAddr(comp.id, removedForm(team.Mia))).toEqual([]);
    // …so the retry sends the SE his report and her nothing more.
    smtp.rejectRecipients(null);
    const m1 = smtp.messages.length;
    const out2 = await tick(sa);
    expect(mailsTo(team.Sid, m1).length, `the retry reached the SE: ${JSON.stringify(out2)}`).toBe(1);
    expect(mailsTo(team.Mia, m1).length, "and never sent Marketing the wrap-up she already had").toBe(0);
    expect(job(comp.id), "the wrap-up is done").toBeUndefined();
    // It runs once: a row an address keeps after it (here made by hand) is not rewritten at a later boot.
    await kill();
    sql(db => db.prepare("DELETE FROM event_team_members WHERE competition_id=? AND email=?").run(comp.id, team.Mia));
    await boot();
    expect(rowsOfAddr(comp.id, team.Mia), "the one shot does not run again").toEqual(miaRows);
  });

  test("targets: a save over somebody else's newer targets is refused; the version it read saves", async () => {
    const sa = await admin();
    const { comp } = await makeEvent(sa, { tasks: 0 });
    let r = await sa.get(`/api/admin/competitions/${comp.id}/team`);
    expect(r.body.targets_updated_at, "nothing saved yet").toBeNull();
    const v0 = r.body.targets_updated_at;
    r = await sa.put(`/api/admin/competitions/${comp.id}/team-targets`, { lead_target: 10, expectedUpdatedAt: v0 }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    const v1 = r.body.targets_updated_at;
    expect(v1, "a save gives the targets a version").toBeTruthy();
    // A second tab still holding the first read.
    r = await sa.put(`/api/admin/competitions/${comp.id}/team-targets`, { lead_target: 99, expectedUpdatedAt: v0 }, await sa.h());
    expect(r.status, "stale: refused").toBe(409);
    expect(r.body.code).toBe("team_targets_changed");
    expect((await sa.get(`/api/admin/competitions/${comp.id}/team`)).body.targets.lead_target, "the newer value stands").toBe(10);
    r = await sa.put(`/api/admin/competitions/${comp.id}/team-targets`, { lead_target: 12, expectedUpdatedAt: v1 }, await sa.h());
    expect(r.ok, `CONTROL: the current version saves: ${r.text}`).toBeTruthy();
    expect((await sa.put(`/api/admin/competitions/${comp.id}/team-targets`, { lead_target: 13 }, await sa.h())).ok, "absent is unchecked").toBeTruthy();
    r = await sa.put(`/api/admin/competitions/${comp.id}/team-targets`, { lead_target: 14, expectedUpdatedAt: 5 }, await sa.h());
    expect(r.status, "a wrong-typed version is refused by name").toBe(400);
  });

  test("the domain list is editable exactly where its PUT is allowed: a superadmin and a custom role holding settings.edit", async () => {
    const sa = await admin();
    expect((await sa.get("/api/admin/team-report-domains")).body.can_edit, "superadmin").toBe(true);
    const role = await sa.post("/api/admin/roles", { label: `Settings editor ${stamp()}`, scope_mode: "all", permissions: ["settings.view", "settings.edit", "events.view"] }, await sa.h());
    expect(role.ok, `create role: ${role.text}`).toBeTruthy();
    const ed = await person("domed");
    const pr = await sa.patch(`/api/admin/users/${ed.id}/role`, { role: role.body.role.id }, await sa.h());
    expect(pr.ok, `assign role: ${pr.text}`).toBeTruthy();
    const edc = client();
    expect((await codeSignIn(edc, ed.email)).body.ok).toBe(true);
    let r = await edc.get("/api/admin/team-report-domains");
    expect(r.ok, r.text).toBeTruthy();
    expect(r.body.can_edit, "a custom role holding settings.edit is offered the save").toBe(true);
    expect((await edc.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await edc.h())).ok, "…which its PUT accepts").toBeTruthy();
    // CONTROL: a built-in admin reads the list, is not offered the save, and is refused it.
    const adm = await person("domadm");
    expect((await sa.post(`/api/admin/participants/${adm.id}/role`, { role: "admin" }, await sa.h())).ok).toBeTruthy();
    const ac = client();
    expect((await codeSignIn(ac, adm.email)).body.ok).toBe(true);
    r = await ac.get("/api/admin/team-report-domains");
    expect(r.body.can_edit).toBe(false);
    expect((await ac.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await ac.h())).status).toBe(403);
  });
});

test.describe("the lead file and the report reads", () => {
  // A quoted CSV line (lib/csv.js always quotes) into its cells.
  const cells = (line) => [...String(line).matchAll(/"((?:[^"]|"")*)"/g)].map(m => m[1].replace(/""/g, '"'));

  test("the lead file has one header row for every event: built-in answers by key, an organiser's own under Other answers", async () => {
    const sa = await admin();
    const csvOf = async (compId) => {
      const r = await sa.get(`/api/admin/competitions/${compId}/team-report/leads.csv`);
      expect(r.ok, r.text).toBeTruthy();
      return r.text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
    };
    // A: a Booth Event with the four questions, one renamed by its organiser.
    const A = await makeEvent(sa, { kind: "booth", tasks: 1 });
    const qa = qTasks(A.comp.id);
    const dev = qa.find(q => q.key === "developers");
    const renamed = `Team size ${stamp()}`;
    const ren = await sa.put(`/api/admin/tasks/${dev.id}`, { title: renamed }, await sa.h());
    expect(ren.ok, ren.text).toBeTruthy();
    const pa = await person("csva");
    await assign(sa, A.comp.id, [pa]);
    await enter(pa, A.comp.id);
    await answerQ(pa, A.comp.id, qa, "developers", 3);
    // B: a Competition with no built-in question and an organiser's own one.
    const B = await makeEvent(sa, { kind: "tournament", tasks: 1 });
    const ownTitle = `Budget ${stamp()}`;
    const own = await sa.post("/api/admin/tasks", { title: ownTitle, description: "<p>d</p>", difficulty: "easy", answer_type: "any", choices: [{ text: "Small" }, { text: "Large" }], status: "published" }, await sa.h());
    expect(own.ok, own.text).toBeTruthy();
    expect((await sa.post(`/api/admin/tasks/${own.body.id}/tags`, { tag: "qualifying:budget" }, await sa.h())).ok).toBeTruthy();
    expect((await sa.post(`/api/admin/tasks/${own.body.id}/competitions`, { competitionIds: [B.comp.id] }, await sa.h())).ok).toBeTruthy();
    const pb = await person("csvb");
    await assign(sa, B.comp.id, [pb]);
    await enter(pb, B.comp.id);
    await answerQ(pb, B.comp.id, qTasks(B.comp.id), "budget", 1);

    const a = await csvOf(A.comp.id), b = await csvOf(B.comp.id);
    expect(a[0], "one header row, whatever questions the event asks").toBe(b[0]);
    const head = cells(a[0]);
    expect(head.slice(6, 11)).toEqual(["Developers", "Code scanner", "Evaluating", "Follow-up", "Other answers"]);
    expect(a[0], "an organiser's wording is never a header").not.toContain(renamed);
    const at = (lines, email) => cells(lines.find(l => l.toLowerCase().includes(email.toLowerCase())) || "");
    const ra = at(a, pa.email), rb = at(b, pb.email);
    expect(ra[head.indexOf("Developers")], "a built-in answer under its key's column").toBe("1000+");
    expect(ra[head.indexOf("Other answers")]).toBe("");
    expect(rb[head.indexOf("Developers")], "blank where the event does not ask it").toBe("");
    expect(rb[head.indexOf("Other answers")], "an organiser's own question, with its wording").toBe(`${ownTitle}: Large`);
  });

  test("a lead no board lists is scored by the board's rule: an unassigned challenge and a second correct row do not count", async () => {
    const sa = await admin();
    // A Program ranks nobody, so every lead's Score comes from the report's own
    // aggregation. Three challenges (50 each), two solved: not a completion.
    const { comp, taskIds } = await makeEvent(sa, { kind: "program", tasks: 3 });
    const p = await person("score");
    await assign(sa, comp.id, [p]);
    await enter(p, comp.id);
    for (const i of [0, 1]) expect((await submit(p, comp.id, taskIds[i], `right${i}`)).body.correct, `solve ${i}`).toBe(true);
    const scoreNow = async () => {
      const lead = (await report(sa, comp.id)).leads.find(l => l.user_id === p.id);
      expect(lead, "PRECONDITION: the participant is a lead").toBeTruthy();
      expect(lead.rank, "PRECONDITION: no board ranks a Program").toBeNull();
      const r = await sa.get(`/api/admin/competitions/${comp.id}/team-report/leads.csv`);
      expect(r.ok, r.text).toBeTruthy();
      const lines = r.text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
      const head = cells(lines[0]);
      const row = cells(lines.find(l => l.toLowerCase().includes(p.email.toLowerCase())) || "");
      return { report: lead.score, file: row[head.indexOf("Score")] };
    };
    expect(await scoreNow(), "CONTROL: two solves, 50 each").toEqual({ report: 100, file: "100" });
    // The state Recalculate can leave (a second correct row for one challenge),
    // and a solved challenge unassigned since.
    sql(db => db.prepare(
      `INSERT INTO submissions (id, user_id, task_id, competition_id, answer, is_correct, points_delta, submitted_at)
       SELECT lower(hex(randomblob(16))), user_id, task_id, competition_id, answer, 1, points_delta, datetime('now') FROM submissions
        WHERE user_id=? AND task_id=? AND competition_id=? AND is_correct=1 LIMIT 1`).run(p.id, taskIds[0], comp.id));
    expect(sql(db => db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE user_id=? AND task_id=? AND is_correct=1").get(p.id, taskIds[0]).n), "PRECONDITION: two correct rows").toBe(2);
    const un = await sa.put(`/api/admin/tasks/${taskIds[1]}/competitions`, { competitionIds: [], expectedAssignments: [comp.id] }, await sa.h());
    expect(un.ok, un.text).toBeTruthy();
    expect(await scoreNow(), "one challenge counted once; the unassigned one not at all").toEqual({ report: 50, file: "50" });
  });

  test("a one-persona preview never computes the managers' comparison for another persona; a computed one is kept", () => {
    // In process: composeRun with the report data stubbed, watching the one
    // query peerAverage opens with (the comparison rebuilds three other events).
    const db = require("../db");
    const R = require("../lib/team-reports");
    const T = require("../lib/event-team");
    const M = require("../lib/team-report-mail");
    const saved = { prepare: db.prepare, leadOwners: T.leadOwners, splitLeads: T.splitLeads, renderMail: M.renderMail, marketingReport: M.marketingReport, managerReport: M.managerReport };
    let peerReads = 0;
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => { if (/FROM competitions WHERE event_kind=\?/.test(sql)) peerReads++; return realPrepare(sql); };
    T.leadOwners = () => [];
    T.splitLeads = () => new Map();
    M.renderMail = () => ({ html: "", text: "" });
    M.marketingReport = () => ({ subject: "m" });
    M.managerReport = () => ({ subject: "g" });
    try {
      const data = { comp: { id: `nope-${stamp()}`, name: "X", event_kind: "booth", start_time: new Date().toISOString() }, leads: [] };
      // The manager was put on the team by the built-in superadmin, so their
      // comparison covers every event (lib/team-reports.js managerPeerScope).
      const members = [{ id: "m1", role: "marketing", email: "a@corp.example", name: "A" }, { id: "m2", role: "marketing_manager", email: "b@corp.example", name: "B", added_by: "superadmin" }];
      const one = R.composeRun(data, members, "manual", { onlyPersona: "marketing" });
      expect(one.messages.map(m => m.persona), "only the asked persona's messages").toEqual(["marketing"]);
      expect(peerReads, "the comparison was not computed for Marketing's preview").toBe(0);
      const mgr = R.composeRun(data, members, "manual", { onlyPersona: "manager" });
      expect(mgr.messages.map(m => m.persona)).toEqual(["manager"]);
      expect(peerReads, "CONTROL: the managers' preview computes it").toBe(1);
      // Kept per (event, scope): a full run, a scoped read and a later read of
      // the same event cost a lookup until the comparison is PEER_CACHE_MS old.
      R.composeRun(data, members, "manual");
      expect(peerReads, "a full run reuses the comparison the preview computed").toBe(1);
      R.peerAverage(data.comp);
      expect(peerReads, "so does the next read").toBe(1);
      R.peerAverage(data.comp, ["x"]);
      expect(peerReads, "CONTROL: another actor's scope is its own comparison").toBe(2);
      R.composeRun({ ...data, comp: { ...data.comp, id: `${data.comp.id}-b` } }, members, "manual");
      expect(peerReads, "CONTROL: another event's is computed").toBe(3);
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + R.PEER_CACHE_MS + 1000;
        R.peerAverage(data.comp);
        expect(peerReads, "CONTROL: once it is old, it is computed again").toBe(4);
      } finally { Date.now = realNow; }
    } finally { Object.assign(T, { leadOwners: saved.leadOwners, splitLeads: saved.splitLeads }); Object.assign(M, { renderMail: saved.renderMail, marketingReport: saved.marketingReport, managerReport: saved.managerReport }); db.prepare = saved.prepare; }
  });

  test("the two report reads share a limiter, after the guard", async () => {
    const sa = await admin();
    const { comp } = await makeEvent(sa, { tasks: 0 });
    const anon = client();
    try {
      expect((await sa.post("/api/test/rate-limit-toggle", { enable: true }, await sa.h())).ok).toBeTruthy();
      // An anonymous caller is refused by the guard and drains nothing.
      for (let i = 0; i < 70; i++) expect((await anon.get(`/api/admin/competitions/${comp.id}/team-report`)).status).toBe(401);
      let last = null;
      for (let i = 0; i < 60; i++) {
        const r = await sa.get(i % 2 ? `/api/admin/competitions/${comp.id}/team-report` : `/api/admin/competitions/${comp.id}/team-report/preview?persona=marketing`);
        expect(r.status, `read ${i + 1} of the minute's 60: ${r.text.slice(0, 120)}`).toBe(200);
        last = r;
      }
      expect(last.ok).toBeTruthy();
      const over = await sa.get(`/api/admin/competitions/${comp.id}/team-report`);
      expect(over.status, "the 61st read in the minute is refused").toBe(429);
    } finally {
      expect((await sa.post("/api/test/rate-limit-toggle", { enable: false }, await sa.h())).ok).toBeTruthy();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The operator's rulings of 14 Nov 2026 on qualifying (lead) questions.
// ─────────────────────────────────────────────────────────────────────────────

const choicesOf = (taskId) => JSON.parse(sql(db => db.prepare("SELECT choices FROM tasks WHERE id=?").get(taskId)).choices || "null");
const inEvent = (compId, taskId) => !!sql(db => db.prepare("SELECT 1 AS x FROM competition_tasks WHERE competition_id=? AND task_id=?").get(compId, taskId));
const report = async (sa, compId) => {
  const r = await sa.get(`/api/admin/competitions/${compId}/team-report`);
  expect(r.ok, r.text).toBeTruthy();
  return r.body;
};
const libRow = async (sa, taskId) => (await sa.get("/api/admin/tasks")).body.find(t => t.id === taskId);
async function pickOne(sa, texts, title = `Own ${stamp()}`) {
  const r = await sa.post("/api/admin/tasks", { title, description: "<p>d</p>", difficulty: "easy", answer_type: "any", choices: texts.map(text => ({ text })), status: "published" }, await sa.h());
  expect(r.ok, r.text).toBeTruthy();
  return r.body.id;
}

test.describe("an event asks each qualifying question once (operator ruling N7)", () => {
  test("another event's question is refused, by name, where the event already asks its topic, and shared where it does not — at the one, the Assign dialog's and the bulk door", async () => {
    const sa = await admin();
    const { comp: A } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 0 });
    const { comp: B } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 0 });
    const { comp: C } = await makeEvent(sa, { kind: "tournament", tasks: 1 });
    const qa = qTasks(A.id), qb = qTasks(B.id);
    const id = (q, k) => q.find(x => x.key === k).id;
    const asked = (compId) => qTasks(compId).map(x => `${x.key}:${x.id}`).sort();
    expect(qTasks(C.id), "PRECONDITION: the Competition asks no qualifying question").toEqual([]);
    const bBefore = asked(B.id);

    // THE ONE DOOR (Add challenges): refused where B asks the topic, by name and
    // code, with no refused pairs; B unchanged by value.
    let r = await sa.post(`/api/admin/tasks/${id(qa, "developers")}/competitions`, { competitionIds: [B.id] }, await sa.h());
    expect(r.status, r.text).toBe(400);
    expect(r.body.code).toBe("qualifying_key_held");
    expect(r.body.error).toContain(B.name);
    expect(r.body.error).toContain("How many developers");
    expect(r.body.refused, "a code alone, no seal pairs").toBeUndefined();
    expect(asked(B.id)).toEqual(bBefore);
    // CONTROL: shared where C asks nothing on the topic — one question, two events.
    r = await sa.post(`/api/admin/tasks/${id(qa, "developers")}/competitions`, { competitionIds: [C.id] }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    expect(r.body.assigned).toBe(1);
    // …and now C asks it, B's own copy is refused there.
    r = await sa.post(`/api/admin/tasks/${id(qb, "developers")}/competitions`, { competitionIds: [C.id] }, await sa.h());
    expect(r.status, r.text).toBe(400);
    expect(r.body.code).toBe("qualifying_key_held");
    expect(inEvent(C.id, id(qb, "developers"))).toBe(false);
    // Re-sending one the event already holds is no change, and not refused.
    r = await sa.post(`/api/admin/tasks/${id(qa, "developers")}/competitions`, { competitionIds: [C.id] }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    expect(r.body.assigned).toBe(0);

    // THE ASSIGN DIALOG (desired state): A's scanner joins C; B's is then refused, nothing written.
    const put = async (taskId, add) => {
      const cur = sql(db => db.prepare("SELECT competition_id FROM competition_tasks WHERE task_id=?").all(taskId).map(x => x.competition_id));
      return sa.put(`/api/admin/tasks/${taskId}/competitions`, { competitionIds: [...new Set([...cur, ...add])], expectedAssignments: cur }, await sa.h());
    };
    r = await put(id(qa, "scanner"), [C.id]);
    expect(r.ok, r.text).toBeTruthy();
    r = await put(id(qb, "scanner"), [C.id]);
    expect(r.status, r.text).toBe(400);
    expect(r.body.code).toBe("qualifying_key_held");
    expect(inEvent(C.id, id(qb, "scanner")), "nothing changed").toBe(false);
    expect(inEvent(B.id, id(qb, "scanner")), "and B keeps its own").toBe(true);

    // BULK: a counted skip. A's and B's evaluating to C at once: the first lands,
    // the second is skipped; A's follow-up (a topic C does not ask) lands too.
    r = await sa.post("/api/admin/tasks/assign-competitions", { taskIds: [id(qa, "evaluating"), id(qb, "evaluating"), id(qa, "follow_up")], competitionIds: [C.id] }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    expect(r.body.assigned).toBe(2);
    expect(r.body.skipped.qualifyingHeld).toBe(1);
    expect(qTasks(C.id).filter(x => x.key === "evaluating").map(x => x.id), "C asks evaluating once, A's").toEqual([id(qa, "evaluating")]);
    // CONTROL: an ordinary challenge is never this skip.
    const plain = await sa.post("/api/admin/tasks", { title: `Plain ${stamp()}`, description: "<p>d</p>", difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published" }, await sa.h());
    r = await sa.post("/api/admin/tasks/assign-competitions", { taskIds: [plain.body.id], competitionIds: [C.id, B.id] }, await sa.h());
    expect([r.body.assigned, r.body.skipped.qualifyingHeld]).toEqual([2, 0]);

    // The library row names a qualifying challenge's topic (the server's parse);
    // an ordinary row carries no such field.
    expect((await libRow(sa, id(qa, "developers"))).qualifying_keys).toEqual(["developers"]);
    expect((await libRow(sa, plain.body.id)).qualifying_keys).toBeUndefined();

    // SHARED WORDING, SEPARATE ANSWERS: one question in A and C; each report reads its own event's answers.
    const pa = await person("n7a"), pc = await person("n7c");
    await assign(sa, A.id, [pa]); await assign(sa, C.id, [pc]);
    await enter(pa, A.id); await enter(pc, C.id);
    await answerQ(pa, A.id, qa, "developers", 0);
    await answerQ(pc, C.id, qa, "developers", 3);
    const ra = await report(sa, A.id), rc = await report(sa, C.id);
    expect(ra.leads.find(l => l.user_id === pa.id).answers.developers).toBe("1–49");
    expect(rc.leads.find(l => l.user_id === pc.id).answers.developers).toBe("1000+");
    expect(ra.leads.some(l => l.user_id === pc.id) || rc.leads.some(l => l.user_id === pa.id), "neither report holds the other's lead").toBe(false);
  });

  test("the tag route and restore refuse a topic an event holding the challenge already asks", async () => {
    const sa = await admin();
    const { comp: D } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 0 });   // asks the four
    const tid = await pickOne(sa, ["Lo", "Hi"]);
    expect((await sa.post(`/api/admin/tasks/${tid}/competitions`, { competitionIds: [D.id] }, await sa.h())).ok).toBeTruthy();
    const tags = (t) => sql(db => db.prepare("SELECT tag FROM task_tags WHERE task_id=? ORDER BY tag").all(t).map(x => x.tag));
    let r = await sa.post(`/api/admin/tasks/${tid}/tags`, { tag: "qualifying:developers" }, await sa.h());
    expect(r.status, r.text).toBe(409);
    expect(r.body.code).toBe("qualifying_key_held");
    expect(r.body.error).toContain(D.name);
    expect(tags(tid)).toEqual([]);
    // CONTROL: a topic D does not ask.
    r = await sa.post(`/api/admin/tasks/${tid}/tags`, { tag: "qualifying:budget" }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    expect(tags(tid)).toEqual(["qualifying:budget"]);

    // RESTORE: the version carrying `budget` cannot come back while another
    // challenge asks budget in D.
    r = await sa.del(`/api/admin/tasks/${tid}/tags/${encodeURIComponent("qualifying:budget")}`, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    const u = await pickOne(sa, ["Small", "Large"]);
    expect((await sa.post(`/api/admin/tasks/${u}/tags`, { tag: "qualifying:budget" }, await sa.h())).ok).toBeTruthy();
    expect((await sa.post(`/api/admin/tasks/${u}/competitions`, { competitionIds: [D.id] }, await sa.h())).ok, "PRECONDITION: D asks budget through u").toBeTruthy();
    const vs = (await sa.get(`/api/admin/tasks/${tid}/versions`)).body;
    const snapTags = (v) => { const s = typeof v.snapshot === "string" ? JSON.parse(v.snapshot) : (v.snapshot || {}); return s.tags || []; };
    const withBudget = vs.find(v => snapTags(v).includes("qualifying:budget"));
    expect(withBudget, "PRECONDITION: a version carries the tag").toBeTruthy();
    r = await sa.post(`/api/admin/tasks/${tid}/restore`, { versionId: withBudget.id }, await sa.h());
    expect(r.status, r.text).toBe(409);
    expect(r.body.code).toBe("qualifying_key_held");
    expect(tags(tid), "nothing restored").toEqual([]);
    // CONTROL: once u has left D, the same restore goes through.
    expect((await sa.del(`/api/admin/tasks/${u}/competitions/${D.id}`, await sa.h())).ok).toBeTruthy();
    r = await sa.post(`/api/admin/tasks/${tid}/restore`, { versionId: withBudget.id }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    expect(tags(tid)).toEqual(["qualifying:budget"]);
  });

  // Every challenge the event HOLDS asks its topic, whatever its state: showing a
  // hidden one or publishing a draft later would make the duplicate, and the
  // publish and visibility routes do not ask again.
  test("a hidden or a draft question still asks its topic: another event's question on it is refused at every assign door until that one leaves the event", async () => {
    const sa = await admin();
    const { comp: X } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 0 });   // asks the four
    const { comp: Y } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 0 });   // its questions are another event's
    const qx = qTasks(X.id), qy = qTasks(Y.id);
    const id = (q, k) => q.find(x => x.key === k).id;
    const state = (taskId) => sql(db => db.prepare("SELECT status, active FROM tasks WHERE id=?").get(taskId));
    const refusedAtEveryDoor = async (taskId, what) => {
      let r = await sa.post(`/api/admin/tasks/${taskId}/competitions`, { competitionIds: [X.id] }, await sa.h());
      expect([r.status, r.body.code], `${what}, the one door: ${r.text}`).toEqual([400, "qualifying_key_held"]);
      const cur = sql(db => db.prepare("SELECT competition_id FROM competition_tasks WHERE task_id=?").all(taskId).map(x => x.competition_id));
      r = await sa.put(`/api/admin/tasks/${taskId}/competitions`, { competitionIds: [...cur, X.id], expectedAssignments: cur }, await sa.h());
      expect([r.status, r.body.code], `${what}, the Assign dialog's: ${r.text}`).toEqual([400, "qualifying_key_held"]);
      r = await sa.post("/api/admin/tasks/assign-competitions", { taskIds: [taskId], competitionIds: [X.id] }, await sa.h());
      expect([r.body.assigned, r.body.skipped && r.body.skipped.qualifyingHeld], `${what}, the bulk door: ${r.text}`).toEqual([0, 1]);
      expect(inEvent(X.id, taskId), `${what}: nothing written`).toBe(false);
    };

    // HIDDEN: X's own developers question, hidden, still asks developers.
    let r = await sa.patch(`/api/admin/tasks/${id(qx, "developers")}/visibility`, {}, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    expect(state(id(qx, "developers")), "PRECONDITION: hidden, still published").toEqual({ status: "published", active: 0 });
    await refusedAtEveryDoor(id(qy, "developers"), "hidden");

    // DRAFT: X's own question on a topic of its own, restored to its draft
    // version while X holds it (the one way a held challenge becomes a draft).
    const key = `dr${stamp()}`.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 30);
    const dr = await sa.post("/api/admin/tasks", { title: `Draft topic ${stamp()}`, description: "<p>d</p>", difficulty: "easy", answer_type: "any", choices: [{ text: "Lo" }, { text: "Hi" }], status: "draft" }, await sa.h());
    expect(dr.ok, dr.text).toBeTruthy();
    expect((await sa.post(`/api/admin/tasks/${dr.body.id}/tags`, { tag: `qualifying:${key}` }, await sa.h())).ok).toBeTruthy();
    expect((await sa.post(`/api/admin/tasks/${dr.body.id}/publish`, {}, await sa.h())).ok).toBeTruthy();
    expect((await sa.post(`/api/admin/tasks/${dr.body.id}/competitions`, { competitionIds: [X.id] }, await sa.h())).ok).toBeTruthy();
    const snap = (v) => (typeof v.snapshot === "string" ? JSON.parse(v.snapshot) : (v.snapshot || {}));
    const draftV = (await sa.get(`/api/admin/tasks/${dr.body.id}/versions`)).body.find(v => snap(v).status === "draft" && (snap(v).tags || []).includes(`qualifying:${key}`));
    expect(draftV, "PRECONDITION: a draft version carrying the tag").toBeTruthy();
    r = await sa.post(`/api/admin/tasks/${dr.body.id}/restore`, { versionId: draftV.id }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    expect(state(dr.body.id).status, "PRECONDITION: a draft now").toBe("draft");
    expect(inEvent(X.id, dr.body.id), "PRECONDITION: still in X").toBe(true);
    const other = await pickOne(sa, ["Small", "Large"]);
    expect((await sa.post(`/api/admin/tasks/${other}/tags`, { tag: `qualifying:${key}` }, await sa.h())).ok).toBeTruthy();
    expect((await sa.post(`/api/admin/tasks/${other}/competitions`, { competitionIds: [Y.id] }, await sa.h())).ok, "another event's question on that topic").toBeTruthy();
    await refusedAtEveryDoor(other, "draft");

    // CONTROL: once each has left X, the other event's question is shared.
    for (const [mine, theirs] of [[id(qx, "developers"), id(qy, "developers")], [dr.body.id, other]]) {
      expect((await sa.del(`/api/admin/tasks/${mine}/competitions/${X.id}`, await sa.h())).ok).toBeTruthy();
      r = await sa.post(`/api/admin/tasks/${theirs}/competitions`, { competitionIds: [X.id] }, await sa.h());
      expect([r.status, r.body.assigned], r.text).toEqual([200, 1]);
    }
  });
});

test.describe("an event asks each qualifying question once: what the refusal names (ruling N7)", () => {
  test("the tag route's refusal names another organiser's event and question to nobody but who may see them, and neither the PUT nor the library says whether anybody answered there (superadmin CONTROL)", async () => {
    const sa = await admin();
    const { comp: mine } = await makeEvent(sa, { kind: "tournament", tasks: 0 });
    const { comp: theirs } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 0 });   // asks the four
    const ea = await person("n7ea");
    expect((await sa.post(`/api/admin/competitions/${mine.id}/admins`, { userId: ea.id }, await sa.h())).ok).toBeTruthy();
    const eac = client();
    expect((await codeSignIn(eac, ea.email)).body.ok).toBe(true);
    // The event admin's own pick-one challenge, in their event — and, put there
    // by a superadmin, in another organiser's event that asks developers.
    const t = await eac.post("/api/admin/tasks", { title: `EA own ${stamp()}`, description: "<p>d</p>", difficulty: "easy", answer_type: "any", choices: [{ text: "Few" }, { text: "Many" }], status: "published" }, await eac.h());
    expect(t.ok, t.text).toBeTruthy();
    expect((await eac.post(`/api/admin/tasks/${t.body.id}/competitions`, { competitionIds: [mine.id] }, await eac.h())).ok).toBeTruthy();
    expect((await sa.post(`/api/admin/tasks/${t.body.id}/competitions`, { competitionIds: [theirs.id] }, await sa.h())).ok).toBeTruthy();
    const heldTitle = qTasks(theirs.id).length && sql(db => db.prepare("SELECT title FROM tasks WHERE id=?").get(qTasks(theirs.id).find(x => x.key === "developers").id).title);
    // The event admin meets the scoring gate first (9.1.5: making a challenge
    // a qualifying question is a scoring change, refused while another
    // organiser's event holds it), and that refusal names neither.
    let r = await eac.post(`/api/admin/tasks/${t.body.id}/tags`, { tag: "qualifying:developers" }, await eac.h());
    expect(r.status, r.text).toBe(403);
    expect(r.body.code).toBe("event_admin_scoring_locked");
    expect(r.body.error).toContain("an event you do not manage");
    expect(r.text, "not the other organiser's event").not.toContain(theirs.name);
    expect(r.text, "nor its question").not.toContain(heldTitle);
    // CONTROL: a superadmin is told which.
    r = await sa.post(`/api/admin/tasks/${t.body.id}/tags`, { tag: "qualifying:developers" }, await sa.h());
    expect(r.status, r.text).toBe(409);
    expect(r.body.error).toContain(theirs.name);
    expect(r.body.error).toContain(heldTitle);

    // RULING 84, the same posture: whether anybody has answered is not told to a
    // caller the scope gate refuses. Made a qualifying question (a topic neither
    // event asks) and answered in the other organiser's event…
    // (made one by the superadmin: the event admin may not, while another
    // organiser's event holds it)…
    r = await sa.post(`/api/admin/tasks/${t.body.id}/tags`, { tag: "qualifying:budget" }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    const p = await person("n7eap");
    await assign(sa, theirs.id, [p]);
    await enter(p, theirs.id);
    const opts = choicesOf(t.body.id);
    expect((await submit(p, theirs.id, t.body.id, JSON.stringify([opts[0].id]))).ok).toBeTruthy();
    // …the event admin's reorder meets the scope refusal, not the answered one.
    const swapped = { choices: opts.slice().reverse() };
    r = await eac.put(`/api/admin/tasks/${t.body.id}`, swapped, await eac.h());
    expect(r.status, r.text).toBe(403);
    expect(r.body.code).not.toBe("qualifying_options_fixed");
    // CONTROL: a superadmin, whom the gate lets through, meets the answered rule.
    r = await sa.put(`/api/admin/tasks/${t.body.id}`, swapped, await sa.h());
    expect(r.status, r.text).toBe(409);
    expect(r.body.code).toBe("qualifying_options_fixed");
    // …nor does the library tell them: `options_fixed` rides only a row whose
    // options the caller may change (`can_edit_scoring`). The superadmin's does.
    const eaRow = (await eac.get("/api/admin/tasks")).body.find(x => x.id === t.body.id);
    expect(eaRow && eaRow.can_edit_scoring, "PRECONDITION: the scope gate refuses the event admin's option edits").toBe(false);
    expect(eaRow.options_fixed, "not told that somebody answered in another organiser's event").toBeUndefined();
    expect((await libRow(sa, t.body.id)).options_fixed, "CONTROL: the superadmin is").toBe(true);
    // CONTROL: on their own question, held and answered only in their own event,
    // the event admin passes the gate and is told (the editor's note and check).
    const own = await eac.post("/api/admin/tasks", { title: `EA own 84 ${stamp()}`, description: "<p>d</p>", difficulty: "easy", answer_type: "any", choices: [{ text: "Now" }, { text: "Later" }], status: "published" }, await eac.h());
    expect(own.ok, own.text).toBeTruthy();
    r = await eac.post(`/api/admin/tasks/${own.body.id}/tags`, { tag: `qualifying:ea${stamp()}`.toLowerCase().replace(/[^a-z0-9:_-]/g, "").slice(0, 51) }, await eac.h());
    expect(r.ok, r.text).toBeTruthy();
    expect((await eac.post(`/api/admin/tasks/${own.body.id}/competitions`, { competitionIds: [mine.id] }, await eac.h())).ok).toBeTruthy();
    const p2 = await person("n7eap2");
    await assign(sa, mine.id, [p2]);
    await enter(p2, mine.id);
    expect((await submit(p2, mine.id, own.body.id, JSON.stringify([choicesOf(own.body.id)[0].id]))).ok).toBeTruthy();
    const ownRow = (await eac.get("/api/admin/tasks")).body.find(x => x.id === own.body.id);
    expect([ownRow && ownRow.can_edit_scoring, ownRow && ownRow.options_fixed]).toEqual([true, true]);
  });
});

test.describe("an answered qualifying question's options keep their places (operator ruling 84)", () => {
  test("once anyone has answered, moving, removing or inserting an option is refused; a reword keeps its identity and an option added at the end is fine", async () => {
    const sa = await admin();
    const { comp } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 1 });
    const q = qTasks(comp.id);
    const fu = q.find(x => x.key === "follow_up"), sc = q.find(x => x.key === "scanner");
    const [yes, no] = fu.options;
    const p = await person("opts");
    await assign(sa, comp.id, [p]);
    await enter(p, comp.id);
    await answerQ(p, comp.id, q, "follow_up", 1);   // "No"
    const put = async (taskId, body) => sa.put(`/api/admin/tasks/${taskId}`, body, await sa.h());
    const before = choicesOf(fu.id);
    expect((await libRow(sa, fu.id)).options_fixed, "the library says so").toBe(true);
    for (const [what, body] of [
      ["swapped", { choices: [{ id: no.id, text: "No" }, { id: yes.id, text: "Yes" }] }],
      ["one removed", { choices: [{ id: yes.id, text: "Yes" }, { text: "Maybe" }] }],
      ["one inserted above another", { choices: [{ id: yes.id, text: "Yes" }, { text: "Maybe" }, { id: no.id, text: "No" }] }],
      ["sent without their ids", { choices: [{ text: "Yes" }, { text: "No" }] }],
      ["every option dropped", { choices: [] }],
      ["the type changed", { answer_type: "text", correct_answer: "x" }],
    ]) {
      const r = await put(fu.id, body);
      expect(r.status, `${what}: ${r.text}`).toBe(409);
      expect(r.body.code, what).toBe("qualifying_options_fixed");
      expect(choicesOf(fu.id), `${what}: unchanged`).toEqual(before);
    }
    // A reword keeps the option's identity: the earlier answer follows it.
    let r = await put(fu.id, { choices: [{ id: yes.id, text: "Yes please" }, { id: no.id, text: "No, thanks" }] });
    expect(r.ok, r.text).toBeTruthy();
    expect(choicesOf(fu.id)).toEqual([{ id: yes.id, text: "Yes please" }, { id: no.id, text: "No, thanks" }]);
    // Their answer is No, so they are out of the lead list (operator ruling, 17 Nov
    // 2026), and the follow-up breakdown, which counts everyone, shows it follow.
    const rep = await report(sa, comp.id);
    expect(rep.leads.some(l => l.user_id === p.id), "a No leaves them out of the leads").toBe(false);
    const fuCounts = rep.summary.breakdown.find(b => b.key === "follow_up").counts;
    expect(fuCounts.find(c => c.text === "No, thanks").n, "the answer reads the new wording").toBe(1);
    // An option added at the end moves nothing.
    r = await put(fu.id, { choices: [{ id: yes.id, text: "Yes please" }, { id: no.id, text: "No, thanks" }, { text: "Maybe later" }] });
    expect(r.ok, r.text).toBeTruthy();
    expect(choicesOf(fu.id).slice(0, 2).map(c => c.id)).toEqual([yes.id, no.id]);

    // CONTROL, unanswered: a qualifying question nobody has answered may be reordered.
    expect((await libRow(sa, sc.id)).options_fixed, "PRECONDITION: nobody has answered it").toBeUndefined();
    const scOpts = choicesOf(sc.id);
    r = await put(sc.id, { choices: scOpts.slice().reverse() });
    expect(r.ok, r.text).toBeTruthy();
    expect(choicesOf(sc.id).map(c => c.id)).toEqual(scOpts.map(c => c.id).reverse());
    // CONTROL, not a lead question: an answered ordinary pick-one question may be.
    const own = await pickOne(sa, ["Red", "Green"]);
    expect((await sa.post(`/api/admin/tasks/${own}/competitions`, { competitionIds: [comp.id] }, await sa.h())).ok).toBeTruthy();
    const ownOpts = choicesOf(own);
    const sub = await submit(p, comp.id, own, JSON.stringify([ownOpts[0].id]));
    expect(sub.ok, sub.text).toBeTruthy();
    expect((await libRow(sa, own)).options_fixed, "an ordinary pick-one question is not fixed").toBeUndefined();
    r = await put(own, { choices: ownOpts.slice().reverse() });
    expect(r.ok, r.text).toBeTruthy();

    // RESTORE takes the PUT's rule: once someone has answered the reordered
    // scanner question, its first version (the other order) cannot come back.
    await answerQ(p, comp.id, qTasks(comp.id), "scanner", 0);
    expect((await libRow(sa, sc.id)).options_fixed).toBe(true);
    const vs = (await sa.get(`/api/admin/tasks/${sc.id}/versions`)).body;
    const order = (v) => { const s = typeof v.snapshot === "string" ? JSON.parse(v.snapshot) : (v.snapshot || {}); return JSON.parse(s.choices || "[]").map(c => c.id).join(","); };
    const first = vs.find(v => order(v) === scOpts.map(c => c.id).join(","));
    const current = vs.find(v => order(v) === scOpts.map(c => c.id).reverse().join(","));
    expect(first && current, "PRECONDITION: both orders are in the history").toBeTruthy();
    r = await sa.post(`/api/admin/tasks/${sc.id}/restore`, { versionId: first.id }, await sa.h());
    expect(r.status, r.text).toBe(409);
    expect(r.body.code).toBe("qualifying_options_fixed");
    expect(choicesOf(sc.id).map(c => c.id)).toEqual(scOpts.map(c => c.id).reverse());
    // CONTROL: the version in today's order restores.
    r = await sa.post(`/api/admin/tasks/${sc.id}/restore`, { versionId: current.id }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
  });
});

test.describe("a Quick question's answer can be changed until the end (operator ruling 395)", () => {
  test("a qualifying pick-one takes a new pick while the person can play, whatever the attempt limit; the report reads the latest; a scoring challenge stays answered once", async () => {
    const sa = await admin();
    // One attempt per challenge: a change must not be an attempt.
    const { comp } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 1, extra: { attempt_cap: 1 } });
    const q = qTasks(comp.id);
    const fu = q.find(x => x.key === "follow_up");
    const p = await person("chg", { company: "Change Co" });
    await assign(sa, comp.id, [p]);
    await enter(p, comp.id);
    const view = async (taskId) => {
      const r = await p.c.get(`/api/tasks/${taskId}`, { "x-competition-id": comp.id });
      expect(r.ok, r.text).toBeTruthy();
      return r.body;
    };
    await answerQ(p, comp.id, q, "follow_up", 1);   // "No"
    // PRECONDITION: a No leaves them out of the lead list (operator ruling, 17 Nov 2026).
    expect((await report(sa, comp.id)).leads.some(l => l.user_id === p.id), "PRECONDITION: a No is not a lead").toBe(false);
    let lead;
    let v = await view(fu.id);
    expect(v.answer_changeable, "offered while they can play").toBe(true);
    expect(v.my_choice_ids).toEqual([fu.options[1].id]);
    const changed = await answerQ(p, comp.id, q, "follow_up", 0);   // "Yes"
    expect([changed.correct, changed.qualifying], "a new pick is taken").toEqual([true, true]);
    expect(sql(db => db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE user_id=? AND task_id=?").get(p.id, fu.id).n), "both picks are on the record").toBe(2);
    lead = (await report(sa, comp.id)).leads.find(l => l.user_id === p.id);
    expect([lead.answers.follow_up, lead.signal], "the report reads the latest").toEqual(["Yes", "hot"]);
    expect((await view(fu.id)).my_choice_ids, "and so does their own view").toEqual([fu.options[0].id]);

    // CONTROLS: a scoring pick-one question, and a qualifying question that is
    // not a pick, stay answered once.
    const own = await pickOne(sa, ["Red", "Green"]);
    expect((await sa.post(`/api/admin/tasks/${own}/competitions`, { competitionIds: [comp.id] }, await sa.h())).ok).toBeTruthy();
    const txt = await sa.post("/api/admin/tasks", { title: `Q text ${stamp()}`, description: "<p>d</p>", difficulty: "easy", answer_type: "text", correct_answer: "acme", status: "published" }, await sa.h());
    // The tag routes refuse a qualifying question that is not a pick-one question
    // (lib/qualifying.js); an older one exists only as a row tagged before that,
    // so this one is tagged as that older row was.
    sql(db => db.prepare("INSERT INTO task_tags (task_id, tag) VALUES (?,?)").run(txt.body.id, "qualifying:company_name"));
    expect((await sa.post(`/api/admin/tasks/${txt.body.id}/competitions`, { competitionIds: [comp.id] }, await sa.h())).ok).toBeTruthy();
    const ownOpts = choicesOf(own);
    expect((await submit(p, comp.id, own, JSON.stringify([ownOpts[0].id]))).ok).toBeTruthy();
    let r = await submit(p, comp.id, own, JSON.stringify([ownOpts[1].id]));
    expect(r.status, `a scoring challenge: ${r.text}`).toBe(400);
    expect(r.body.error).toBe("Already solved");
    expect((await view(own)).answer_changeable, "and is not offered").toBeUndefined();
    expect((await submit(p, comp.id, txt.body.id, "acme")).ok).toBeTruthy();
    r = await submit(p, comp.id, txt.body.id, "acme corp");
    expect(r.status, `a qualifying question that is not a pick: ${r.text}`).toBe(400);
    expect((await view(txt.body.id)).answer_changeable).toBeUndefined();

    // After the end: neither offered nor taken.
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    v = await view(fu.id);
    expect(v.answer_changeable, "not offered once they cannot play").toBeUndefined();
    r = await submit(p, comp.id, fu.id, JSON.stringify([fu.options[1].id]));
    expect(r.status, r.text).toBe(403);
    expect(sql(db => db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE user_id=? AND task_id=?").get(p.id, fu.id).n), "nothing taken").toBe(2);
    lead = (await report(sa, comp.id)).leads.find(l => l.user_id === p.id);
    expect(lead.answers.follow_up).toBe("Yes");
  });

  // The 3-second fold that protects a scoring challenge from a double click
  // would swallow a change BACK made inside it (Yes, No, Yes leaves "No" as the
  // answer) and, past it, store an unchanged pick again as another solve. A
  // changeable Quick question is compared with the person's LATEST answer.
  test("a change is compared with the latest answer: a change back inside three seconds is taken, and the same pick is no change at any age (nothing stored, thanked)", async () => {
    const sa = await admin();
    const { comp } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 0 });
    const q = qTasks(comp.id);
    const fu = q.find(x => x.key === "follow_up");
    const [yes, no] = fu.options.map(o => o.id);
    const p = await person("chgback", { company: "Back Co" });
    await assign(sa, comp.id, [p]);
    await enter(p, comp.id);
    const picks = () => sql(db => db.prepare("SELECT answer_canonical FROM submissions WHERE user_id=? AND task_id=? ORDER BY submitted_at, rowid").all(p.id, fu.id).map(x => JSON.parse(x.answer_canonical)[0]));
    const solved = () => sql(db => db.prepare("SELECT COUNT(*) AS n FROM challenge_events WHERE user_id=? AND task_id=? AND event_type='solved'").get(p.id, fu.id).n);
    // Every stored answer moved by `ms`, their order kept (a deterministic window).
    const shift = (ms) => sql(db => { const up = db.prepare("UPDATE submissions SET submitted_at=? WHERE id=?"); for (const x of db.prepare("SELECT id, submitted_at FROM submissions WHERE user_id=? AND task_id=?").all(p.id, fu.id)) up.run(new Date(Date.parse(x.submitted_at) + ms).toISOString(), x.id); });
    const pick = async (id) => { const r = await submit(p, comp.id, fu.id, JSON.stringify([id])); expect(r.ok, r.text).toBeTruthy(); return r.body; };

    expect((await pick(yes)).deduped).toBeUndefined();
    expect((await pick(no)).deduped).toBeUndefined();
    // Both answers stamped NOW (No still the later, by row order), so the third
    // pick lands inside the 3-second window of the first, whatever the machine.
    sql(db => db.prepare("UPDATE submissions SET submitted_at=? WHERE user_id=? AND task_id=?").run(new Date().toISOString(), p.id, fu.id));
    const back = await pick(yes);
    expect([back.correct, back.qualifying, back.deduped], "a change back is a change").toEqual([true, true, undefined]);
    expect(picks(), "every change stored, in order").toEqual([yes, no, yes]);
    let lead = (await report(sa, comp.id)).leads.find(l => l.user_id === p.id);
    expect([lead.answers.follow_up, lead.signal], "the report reads the latest").toEqual(["Yes", "hot"]);

    // The same pick as the answer now: no change, answered as one and thanked,
    // nothing stored — inside the window, and an hour after it.
    for (const [when, ms] of [["at once", 0], ["an hour later", -3600e3]]) {
      shift(ms);
      const same = await pick(yes);
      expect([same.correct, same.deduped, same.qualifying, same.pointsDelta], `${when}: ${JSON.stringify(same)}`).toEqual([true, true, true, 0]);
      expect(picks(), `${when}: nothing stored`).toEqual([yes, no, yes]);
    }
    // One more change, then the record: four solves, none for the two no-ops
    // (each change's events land after its commit, in order).
    expect((await pick(no)).deduped).toBeUndefined();
    await expect.poll(solved, { timeout: 5000 }).toBe(4);
    expect(solved(), "settled at four").toBe(4);
    const v = await p.c.get(`/api/tasks/${fu.id}`, { "x-competition-id": comp.id });
    expect(v.body.my_choice_ids, "their own view reads the latest").toEqual([no]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A CHALLENGE IMPORT'S OVERWRITE is the tag route's and the task PUT's other
// door (operator rulings N7 and 84 of 14 Nov 2026): a row that would make an
// event ask a qualifying topic twice, or move or remove an answered qualifying
// question's options, is skipped and counted, never applied. The round trip is
// the real one: the export's own row, edited, imported with `overwrite`.
// ─────────────────────────────────────────────────────────────────────────────

/** The challenge export's row for one challenge, matched by its (unique) title. */
async function exportedRow(sa, title) {
  const r = await sa.get("/api/admin/export/tasks?include_attachment_content=0");
  expect(r.ok, r.text).toBeTruthy();
  const rows = r.body.tasks.filter(t => t.title === title);
  expect(rows.length, `PRECONDITION: one exported row titled ${title}`).toBe(1);
  return rows[0];
}
async function importOverwrite(sa, row) {
  const r = await sa.post("/api/admin/import/tasks", { data: { type: "hackarena-tasks", tasks: [row] }, resolutions: { "0": "overwrite" } }, await sa.h());
  expect(r.ok, r.text).toBeTruthy();
  return r.body;
}
const tagsOfTask = (taskId) => sql(db => db.prepare("SELECT tag FROM task_tags WHERE task_id=? ORDER BY tag").all(taskId).map(x => x.tag));

test.describe("a challenge import's overwrite keeps both qualifying rules (operator rulings N7 and 84)", () => {
  test("N7: an overwrite that adds a topic an event holding the challenge already asks is skipped and counted (the tag route's refusal); a topic it does not ask lands", async () => {
    const sa = await admin();
    const { comp: D } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 0 });   // asks the four
    const title = `Import N7 ${stamp()}`;
    const tid = await pickOne(sa, ["Few", "Many"], title);
    expect((await sa.post(`/api/admin/tasks/${tid}/competitions`, { competitionIds: [D.id] }, await sa.h())).ok).toBeTruthy();
    const asksDevelopers = () => qTasks(D.id).filter(x => x.key === "developers").map(x => x.id);
    const before = asksDevelopers();
    expect(before.length, "PRECONDITION: D asks developers once, through its own").toBe(1);
    // The tag route refuses this very change…
    let r = await sa.post(`/api/admin/tasks/${tid}/tags`, { tag: "qualifying:developers" }, await sa.h());
    expect([r.status, r.body.code], r.text).toEqual([409, "qualifying_key_held"]);
    // …and so does the import, skipping the whole row.
    const row = await exportedRow(sa, title);
    expect(row.tags, "PRECONDITION: no qualifying tag in the file yet").toEqual([]);
    let out = await importOverwrite(sa, { ...row, description: "<p>changed</p>", tags: ["qualifying:developers"] });
    expect([out.overwritten, out.qualifying_key_held_skipped, out.qualifying_options_fixed_skipped], JSON.stringify(out)).toEqual([0, 1, 0]);
    expect(tagsOfTask(tid), "no tag written").toEqual([]);
    expect(sql(db => db.prepare("SELECT description FROM tasks WHERE id=?").get(tid).description), "nor anything else").not.toContain("changed");
    expect(asksDevelopers(), "D asks developers once").toEqual(before);
    // CONTROL: a topic D does not ask lands, and keeping it is no change.
    out = await importOverwrite(sa, { ...row, tags: ["qualifying:budget"] });
    expect([out.overwritten, out.qualifying_key_held_skipped], JSON.stringify(out)).toEqual([1, 0]);
    expect(tagsOfTask(tid)).toEqual(["qualifying:budget"]);
    out = await importOverwrite(sa, { ...row, tags: ["qualifying:budget"], description: "<p>again</p>" });
    expect([out.overwritten, out.qualifying_key_held_skipped], JSON.stringify(out)).toEqual([1, 0]);
  });

  test("84: an overwrite that moves, removes or inserts an answered qualifying question's options is skipped and counted (the PUT's refusal); a reword in place and an option added at the end land", async () => {
    const sa = await admin();
    const { comp } = await makeEvent(sa, { kind: "tournament", tasks: 0 });
    const title = `Import 84 ${stamp()}`;
    const tid = await pickOne(sa, ["Yes", "No"], title);
    const key = `imp${stamp()}`.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 30);
    expect((await sa.post(`/api/admin/tasks/${tid}/tags`, { tag: `qualifying:${key}` }, await sa.h())).ok).toBeTruthy();
    expect((await sa.post(`/api/admin/tasks/${tid}/competitions`, { competitionIds: [comp.id] }, await sa.h())).ok).toBeTruthy();
    // A bystander who never plays keeps the event live (an ended one freezes the
    // challenges, which the import skips for that reason instead).
    const p = await person("imp84"), idle = await person("imp84idle");
    await assign(sa, comp.id, [p, idle]);
    await enter(p, comp.id);
    const [yes, no] = choicesOf(tid);
    expect((await submit(p, comp.id, tid, JSON.stringify([no.id]))).ok, "answered No").toBeTruthy();
    // The PUT refuses the swap…
    let r = await sa.put(`/api/admin/tasks/${tid}`, { choices: [no, yes] }, await sa.h());
    expect([r.status, r.body.code], r.text).toEqual([409, "qualifying_options_fixed"]);
    // …and so does the import, for each way of moving what the answer reads.
    const row = await exportedRow(sa, title);
    const before = choicesOf(tid);
    for (const [what, choices] of [
      ["swapped", [no, yes]],
      ["one removed", [yes, { id: "0a1b2c3d", text: "Maybe" }]],
      ["one inserted above another", [yes, { id: "0a1b2c3d", text: "Maybe" }, no]],
    ]) {
      const out = await importOverwrite(sa, { ...row, description: "<p>changed</p>", choices: JSON.stringify(choices) });
      expect([out.overwritten, out.qualifying_options_fixed_skipped, out.qualifying_key_held_skipped], `${what}: ${JSON.stringify(out)}`).toEqual([0, 1, 0]);
      expect(choicesOf(tid), `${what}: unchanged`).toEqual(before);
    }
    // The answer still reads "No".
    expect((await report(sa, comp.id)).leads.find(l => l.user_id === p.id).answers[key]).toBe("No");
    // CONTROL: a reword in place keeps the identity, and an option at the end moves nothing.
    const reworded = [{ id: yes.id, text: "Yes please" }, { id: no.id, text: "No, thanks" }, { id: "0a1b2c3d", text: "Later" }];
    let out = await importOverwrite(sa, { ...row, choices: JSON.stringify(reworded) });
    expect([out.overwritten, out.qualifying_options_fixed_skipped], JSON.stringify(out)).toEqual([1, 0]);
    expect(choicesOf(tid)).toEqual(reworded);
    // CONTROL, not a lead question: an answered ordinary pick-one question's options may move…
    const plainTitle = `Import 84 plain ${stamp()}`;
    const plain = await pickOne(sa, ["Red", "Green"], plainTitle);
    expect((await sa.post(`/api/admin/tasks/${plain}/competitions`, { competitionIds: [comp.id] }, await sa.h())).ok).toBeTruthy();
    const [red, green] = choicesOf(plain);
    expect((await submit(p, comp.id, plain, JSON.stringify([red.id]))).ok).toBeTruthy();
    const plainRow = await exportedRow(sa, plainTitle);
    out = await importOverwrite(sa, { ...plainRow, choices: JSON.stringify([green, red]) });
    expect([out.overwritten, out.qualifying_options_fixed_skipped], JSON.stringify(out)).toEqual([1, 0]);
    expect(choicesOf(plain).map(c => c.id)).toEqual([green.id, red.id]);
    // …but not in the same act as the file making it one (read by the new places).
    out = await importOverwrite(sa, { ...plainRow, choices: JSON.stringify([red, green]), tags: [`qualifying:${key}x`] });
    expect([out.overwritten, out.qualifying_options_fixed_skipped], JSON.stringify(out)).toEqual([0, 1]);
    expect(choicesOf(plain).map(c => c.id), "unchanged").toEqual([green.id, red.id]);
    expect(tagsOfTask(plain)).toEqual([]);
  });

  // Sweep #413 — every event holds its OWN copy of each built-in qualifying
  // question, under one title, and a file row names a challenge by its title
  // alone: an overwrite that could mean more than one challenge, where a
  // qualifying question is involved, is skipped and counted rather than applied
  // to whichever copy the lookup finds first. And a qualifying tag the tag route
  // refuses (`qualifying_tag_invalid`) is not stored by a file either.
  const importRows = async (sa, rows, resolutions = {}) => {
    const r = await sa.post("/api/admin/import/tasks", { data: { type: "hackarena-tasks", tasks: rows }, resolutions }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    return r.body;
  };
  const descOf = (id) => sql(db => db.prepare("SELECT description FROM tasks WHERE id=?").get(id).description);
  const versionsOf = (id) => sql(db => db.prepare("SELECT COUNT(*) n FROM task_versions WHERE task_id=?").get(id).n);

  test("sweep #413: an overwrite naming a title several events' qualifying copies share is skipped and counted, never folded onto one; a unique title and ordinary duplicates are applied (CONTROLS)", async () => {
    const sa = await admin();
    const { comp: D1 } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 0 });
    const { comp: D2 } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 0 });
    const c1 = qTasks(D1.id).find(x => x.key === "developers").id, c2 = qTasks(D2.id).find(x => x.key === "developers").id;
    const title = sql(db => db.prepare("SELECT title FROM tasks WHERE id=?").get(c1).title);
    expect(sql(db => db.prepare("SELECT title FROM tasks WHERE id=?").get(c2).title), "PRECONDITION: both events' copies share the title").toBe(title);
    const ex = await sa.get("/api/admin/export/tasks?include_attachment_content=0");
    expect(ex.ok, ex.text).toBeTruthy();
    const row = ex.body.tasks.find(t => t.title === title);
    const before = [descOf(c1), descOf(c2), versionsOf(c1), versionsOf(c2)];
    let out = await importRows(sa, [{ ...row, description: "<p>folded</p>" }], { "0": "overwrite" });
    expect([out.overwritten, out.qualifying_copy_skipped], JSON.stringify(out)).toEqual([0, 1]);
    expect([descOf(c1), descOf(c2), versionsOf(c1), versionsOf(c2)], "neither copy is touched").toEqual(before);
    out = await importRows(sa, [{ ...row, description: "<p>folded</p>" }, { ...row, description: "<p>folded too</p>" }], { "0": "overwrite", "1": "overwrite" });
    expect([out.overwritten, out.qualifying_copy_skipped], JSON.stringify(out)).toEqual([0, 2]);
    // CONTROL: a qualifying question with a title of its own is overwritten.
    const own = `Copy ctl ${stamp()}`;
    const tid = await pickOne(sa, ["Few", "Many"], own);
    const key = `own${stamp()}`.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 30);
    expect((await sa.post(`/api/admin/tasks/${tid}/tags`, { tag: `qualifying:${key}` }, await sa.h())).ok).toBeTruthy();
    const ownRow = await exportedRow(sa, own);
    out = await importRows(sa, [{ ...ownRow, description: "<p>applied</p>" }], { "0": "overwrite" });
    expect([out.overwritten, out.qualifying_copy_skipped], `CONTROL: a unique title: ${JSON.stringify(out)}`).toEqual([1, 0]);
    expect(descOf(tid)).toContain("applied");
    // Two rows of the file overwriting that one title cannot both be meant: both skipped.
    out = await importRows(sa, [{ ...ownRow, description: "<p>a</p>" }, { ...ownRow, description: "<p>b</p>" }], { "0": "overwrite", "1": "overwrite" });
    expect([out.overwritten, out.qualifying_copy_skipped], `two rows, one title: ${JSON.stringify(out)}`).toEqual([0, 2]);
    expect(descOf(tid), "unchanged").toContain("applied");
    out = await importRows(sa, [{ ...ownRow, description: "<p>kept one</p>" }, { ...ownRow, description: "<p>b</p>" }], { "0": "overwrite", "1": "keep" });
    expect([out.overwritten, out.qualifying_copy_skipped], `CONTROL: the other row kept: ${JSON.stringify(out)}`).toEqual([1, 0]);
    // A row that can never overwrite anything (an unknown difficulty, skipped
    // whatever its resolution) does not make the valid row beside it ambiguous.
    out = await importRows(sa, [{ ...ownRow, difficulty: "banana" }, { ...ownRow, description: "<p>the valid one</p>" }], { "0": "overwrite", "1": "overwrite" });
    expect([out.overwritten, out.qualifying_copy_skipped, out.skipped], `an unusable row is not counted: ${JSON.stringify(out)}`).toEqual([1, 0, 1]);
    expect(descOf(tid)).toContain("the valid one");
    // SCOPE CONTROL: ordinary challenges sharing a title are overwritten as before.
    const dup = `Plain dup ${stamp()}`;
    for (let i = 0; i < 2; i++) {
      const r = await sa.post("/api/admin/tasks", { title: dup, description: "<p>d</p>", difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published" }, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
    }
    const dupRow = (await sa.get("/api/admin/export/tasks?include_attachment_content=0")).body.tasks.find(t => t.title === dup);
    out = await importRows(sa, [{ ...dupRow, description: "<p>plain</p>" }], { "0": "overwrite" });
    expect([out.overwritten, out.qualifying_copy_skipped], `SCOPE CONTROL: no qualifying question involved: ${JSON.stringify(out)}`).toEqual([1, 0]);
  });

  test("sweep #413: a qualifying tag the tag route refuses is not stored by a file, new row or overwrite; a well-formed one and one the challenge already carries are (CONTROLS)", async () => {
    const sa = await admin();
    const base = `Tag src ${stamp()}`;
    await pickOne(sa, ["Few", "Many"], base);
    const tmpl = await exportedRow(sa, base);
    const titleExists = (t) => !!sql(db => db.prepare("SELECT 1 x FROM tasks WHERE title=?").get(t));
    for (const bad of ["qualifying:Bad Key!", "qualifying:"]) {
      const t = `Bad tag ${stamp()}`;
      const out = await importRows(sa, [{ ...tmpl, title: t, tags: [bad] }]);
      expect([out.imported, out.qualifying_tag_invalid_skipped], `${bad}: ${JSON.stringify(out)}`).toEqual([0, 1]);
      expect(titleExists(t), `${bad}: nothing stored`).toBe(false);
    }
    const good = `Good tag ${stamp()}`;
    let out = await importRows(sa, [{ ...tmpl, title: good, tags: ["qualifying:bad-key"] }]);
    expect([out.imported, out.qualifying_tag_invalid_skipped], `CONTROL: a well-formed key: ${JSON.stringify(out)}`).toEqual([1, 0]);
    expect(sql(db => db.prepare("SELECT tt.tag FROM tasks t JOIN task_tags tt ON tt.task_id=t.id WHERE t.title=?").get(good).tag)).toBe("qualifying:bad-key");
    // An overwrite adding one is refused, and the challenge keeps its tags.
    const tid = await pickOne(sa, ["Few", "Many"], `Ow tag ${stamp()}`);
    const tidTitle = sql(db => db.prepare("SELECT title FROM tasks WHERE id=?").get(tid).title);
    const owRow = await exportedRow(sa, tidTitle);
    out = await importOverwrite(sa, { ...owRow, tags: ["qualifying:"] });
    expect([out.overwritten, out.qualifying_tag_invalid_skipped], JSON.stringify(out)).toEqual([0, 1]);
    expect(tagsOfTask(tid)).toEqual([]);
    // KEPT-TAG CONTROL: one an older import stored changes nothing, so it applies.
    sql(db => db.prepare("INSERT INTO task_tags (task_id, tag) VALUES (?, ?)").run(tid, "qualifying:bad key"));
    out = await importOverwrite(sa, { ...owRow, tags: ["qualifying:bad key"], description: "<p>round trip</p>" });
    expect([out.overwritten, out.qualifying_tag_invalid_skipped], `KEPT-TAG CONTROL: ${JSON.stringify(out)}`).toEqual([1, 0]);
    expect(descOf(tid)).toContain("round trip");
  });
});

// OPERATOR RULING 79 (14 Nov 2026), BY VALUE. A recipient whose address cannot
// open the event is told the next step in words (lib/team-report-mail.js
// `cta.textNoLink`, `renderMail`). The shared render path is locked above by
// shape (a step in words, never a button's words, no link), and the other steps
// are read by value above, in the text part or the preview only. Here the five
// steps no other test reads by value (Marketing with no leads, Sales with no
// engaged account, an SDR with nothing waiting, the SE's resend in both its
// forms, and the SE's edit of a challenge that is too easy) are each held by its
// exact sentence, in the text part AND the HTML part of the mail that was sent,
// with no link in either. The CONTROL is the same recipient made an
// administrator (an address that opens the event): the same report then carries
// the button, in the button's own words.
test.describe("the five steps read by value nowhere else, in words in both parts, with the same recipient's button as the control (operator ruling 79)", () => {
  const decodeHtml = (s) => String(s).replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_, h, d, n) =>
    (h ? String.fromCodePoint(parseInt(h, 16)) : d ? String.fromCodePoint(Number(d)) : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[n.toLowerCase()]));
  const nextLines = (text) => text.split(/\r?\n/).filter(l => /^Next:/.test(l));
  const nextParas = (html) => [...html.matchAll(/<p class="m-fg m-next"[^>]*>([^<]*)<\/p>/g)].map(x => decodeHtml(x[1]));
  const anchors = (html) => [...html.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(x => [decodeHtml(x[1]), decodeHtml(x[2])]);

  async function setUp() {
    const sa = await admin();
    // Team members' addresses: corp.example, and company.co (`person`), the one
    // whose account becomes an administrator for the control. A global setting:
    // each test puts back its default, the empty list, in its own `finally`.
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example", "company.co"] }, await sa.h())).ok).toBeTruthy();
    return sa;
  }
  async function restoreDomains(sa) {
    const r = await sa.put("/api/admin/team-report-domains", { domains: [] }, await sa.h());
    expect.soft(r.ok, `the domain list back to its default: ${r.text}`).toBeTruthy();
  }
  /** A team member whose address is an account that cannot open the event: a participant's, in no event. */
  async function member(sa, compId, role, tag) {
    const acct = await person(tag, { first: "Rae" });
    const r = await sa.post(`/api/admin/competitions/${compId}/team`, { role, name: `Rae ${tag}`, email: acct.email }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    return acct;
  }
  /** The member's account made an administrator: now an address that opens every event. */
  async function makeAdministrator(sa, acct) {
    expect((await sa.post(`/api/admin/participants/${acct.id}/role`, { role: "admin" }, await sa.h())).ok, "made an administrator").toBeTruthy();
  }
  /** Send now, one persona: the one mail it sent, to `email`. */
  async function sendNow(sa, compId, persona, email) {
    const before = smtp.messages.length;
    const r = await sa.post(`/api/admin/competitions/${compId}/team-report/send`, { persona }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    expect([r.body.messages, r.body.sent], `PRECONDITION: one ${persona} report, sent: ${r.text}`).toEqual([1, 1]);
    await expect.poll(() => mailsTo(email, before).length, { timeout: 10000 }).toBe(1);
    return mailsTo(email, before)[0];
  }
  /** The step, exactly, once in each part; no link in either. */
  function expectWords(m, step, what) {
    const html = htmlPart(m), text = textPart(m);
    expect(nextLines(text), `${what}: the step in words, in the text part`).toEqual([`Next: ${step}.`]);
    expect(nextParas(html), `${what}: the same sentence in the HTML part`).toEqual([`Next: ${step}.`]);
    expect(html.match(/<a[\s>]/gi), `${what}: no <a> in the HTML part`).toBeNull();
    expect(text.match(/<a[\s>]/gi), `${what}: nor in the text part`).toBeNull();
    for (const [part, s] of [["HTML", html], ["text", text]]) {
      expect(s, `${what}: no address of the event in the ${part} part`).not.toContain("/?event=");
      expect(s, `${what}: nor of the platform`).not.toContain(BASE);
    }
    expect(text, `${what}: and why there is no link`).toContain("This email has no link: your address is not an account that can open this event");
  }
  /** CONTROL: the same report as a button, the email's one link, in the button's own words. */
  function expectButton(m, compId, section, label, what) {
    const html = htmlPart(m), text = textPart(m);
    const url = `${BASE}/?event=${compId}&section=${section}`;
    expect(anchors(html), `${what}: one link, the button`).toEqual([[url, label]]);
    expect(html.match(/<a[\s>]/gi), `${what}: and no other`).toHaveLength(1);
    const lines = text.split(/\r?\n/);
    expect(lines, `${what}: the text part names the button's step`).toContain(label);
    expect(lines).toContain(`Address (sign-in needed): ${url}`);
    expect(nextLines(text), `${what}: no step in words`).toEqual([]);
    expect(nextParas(html)).toEqual([]);
    expect(text).not.toContain("This email has no link");
  }

  test("Marketing, with no leads yet: 'Nothing to load yet'", async () => {
    const sa = await setUp();
    try {
      const { comp } = await makeEvent(sa, { kind: "tournament", tasks: 1 });
      const mia = await member(sa, comp.id, "marketing", "wmkt");
      expect((await report(sa, comp.id)).leads, "PRECONDITION: nobody has taken part").toEqual([]);
      expectWords(await sendNow(sa, comp.id, "marketing", mia.email), "Nothing to load yet", "Marketing, no leads");
      await makeAdministrator(sa, mia);
      expectButton(await sendNow(sa, comp.id, "marketing", mia.email), comp.id, "team", "Open the lead list", "Marketing, no leads, an administrator");
    } finally { await restoreDomains(sa); }
  });

  test("Sales, with no account showing a signal: 'Nothing to plan yet'", async () => {
    const sa = await setUp();
    try {
      const { comp } = await makeEvent(sa, { kind: "tournament", tasks: 1 });
      const lead = await person("wsalel", { company: "Solo Works" });
      await assign(sa, comp.id, [lead]);
      const sal = await member(sa, comp.id, "sales", "wsal");
      // One person, cold (a Competition asks no qualifying question): an account,
      // but none that showed a signal (lib/team-report-mail.js `salesReport`).
      const rep = await report(sa, comp.id);
      expect(rep.leads.map(l => [l.user_id, l.signal]), "PRECONDITION: one lead, cold").toEqual([[lead.id, "cold"]]);
      expect(rep.accounts.map(a => [a.people, a.signal]), "PRECONDITION: one account of one, cold").toEqual([[1, "cold"]]);
      expectWords(await sendNow(sa, comp.id, "sales", sal.email), "Nothing to plan yet", "Sales, no engaged account");
      await makeAdministrator(sa, sal);
      expectButton(await sendNow(sa, comp.id, "sales", sal.email), comp.id, "team", "Open the accounts", "Sales, no engaged account, an administrator");
    } finally { await restoreDomains(sa); }
  });

  test("an SDR whose leads are all contacted or opted out: 'Nothing to follow up for now'", async () => {
    const sa = await setUp();
    try {
      const { comp } = await makeEvent(sa, { kind: "tournament", tasks: 1 });
      const reached = await person("wsdrc"), optedOut = await person("wsdro");
      await assign(sa, comp.id, [reached, optedOut]);
      const sid = await member(sa, comp.id, "sdr", "wsdr");
      const c = await sa.post(`/api/admin/competitions/${comp.id}/leads/${reached.id}/contacted`, { contacted: true }, await sa.h());
      expect(c.ok, c.text).toBeTruthy();
      sql(db => db.prepare("INSERT INTO unsubscribed_emails (email, unsubscribed_at) VALUES (?,?)").run(optedOut.email.toLowerCase(), new Date().toISOString()));
      const by = Object.fromEntries((await report(sa, comp.id)).leads.map(l => [l.user_id, l]));
      expect([!!by[reached.id].contacted_at, by[reached.id].opted_out], "PRECONDITION: one contacted").toEqual([true, false]);
      expect([!!by[optedOut.id].contacted_at, by[optedOut.id].opted_out], "PRECONDITION: one opted out").toEqual([false, true]);
      const m = await sendNow(sa, comp.id, "sdr", sid.email);
      expect(csvPart(m), "PRECONDITION: the SDR's report, with the file of their two leads").toContain(optedOut.email);
      expectWords(m, "Nothing to follow up for now", "SDR, nothing waiting");
      await makeAdministrator(sa, sid);
      expectButton(await sendNow(sa, comp.id, "sdr", sid.email), comp.id, "team", "Open your leads", "SDR, nothing waiting, an administrator");
    } finally { await restoreDomains(sa); }
  });

  test("the SE, when only certificate emails bounced: asks the organiser to resend the two, then, once one is resent, the one", async () => {
    const sa = await setUp();
    try {
      // One challenge, answered wrong by both holders: each attempted, so each is
      // issued a certificate at the end; two attempters flag nothing and make no
      // worst challenge (both need three), and a wrong answer finishes nobody, so
      // nothing ends the event before End Now.
      const { comp, taskIds } = await makeEvent(sa, { kind: "tournament", tasks: 1 });
      const holders = [await person("wseh1"), await person("wseh2")];
      await assign(sa, comp.id, holders);
      for (const p of holders) {
        await enter(p, comp.id);
        expect((await submit(p, comp.id, taskIds[0], "nope")).body.correct, "PRECONDITION: a wrong answer").toBe(false);
      }
      const sean = await member(sa, comp.id, "se", "wse");
      const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h());
      expect(end.ok, end.text).toBeTruthy();
      // The real path (lib/certificate-dispatch.js): the dispatcher issues both
      // certificates and mails them while the relay refuses both holders, pass
      // after pass, until each email is left failed after its last attempt. A
      // forced pass serves every event's due jobs, oldest first and 20 a pass,
      // so this event's may wait behind events this file ended earlier: every
      // count below is this event's own, read from its rows.
      const ledger = () => Object.fromEntries(sql(db => db.prepare("SELECT user_id, status, attempts, next_attempt_at FROM certificate_emails WHERE competition_id=?").all(comp.id))
        .map(r => [r.user_id, [r.status, r.attempts, r.next_attempt_at]]));
      const settled = () => { const rows = Object.values(ledger()); return rows.length === holders.length && rows.every(r => r[2] === null); };
      const refused = new Set(holders.map(p => p.email.toLowerCase()));
      const mailed0 = smtp.messages.length;
      smtp.rejectRecipients(a => refused.has(a.toLowerCase()));
      try {
        for (let pass = 0; pass < 20 && !settled(); pass++) {
          const t = await sa.post("/api/test/certificate-dispatch-tick", { force: true }, await sa.h());
          expect(t.ok, `certificate dispatch: ${t.text}`).toBeTruthy();
        }
      } finally { smtp.rejectRecipients(null); }
      const issuedTo = sql(db => db.prepare("SELECT user_id FROM achievement_badges WHERE competition_id=? AND revoked_at IS NULL").all(comp.id)).map(r => r.user_id).sort();
      expect(issuedTo, "PRECONDITION: the dispatcher issued both holders' certificates").toEqual(holders.map(p => p.id).sort());
      expect(ledger(), "PRECONDITION: each email failed, its last attempt spent").toEqual(Object.fromEntries(holders.map(p => [p.id, ["failed", 3, null]])));
      expect(holders.map(p => mailsTo(p.email, mailed0).length), "PRECONDITION: neither arrived").toEqual([0, 0]);
      let rep = await report(sa, comp.id);
      expect([rep.worst, rep.challenges.map(x => [x.attempters, x.flag]), rep.certificates], "PRECONDITION: nothing flagged; two issued, none delivered, two bounced")
        .toEqual([null, [[2, null]], { issued: 2, delivered: 0, bounced: 2 }]);
      let m = await sendNow(sa, comp.id, "se", sean.email);
      expectWords(m, "Ask the event's organiser to resend the 2 certificate emails", "SE, two bounced");
      expect(textPart(m), "the figures the step comes from").toContain("Certificates: 2 issued, 0 delivered by email.");
      // The organiser resends the first holder's, which the relay now takes.
      const resent0 = smtp.messages.length;
      const rs = await sa.post(`/api/admin/competitions/${comp.id}/certificates/resend`, { userId: holders[0].id }, await sa.h());
      expect([rs.status, rs.body.ok, rs.body.status], `the organiser's resend: ${rs.text}`).toEqual([200, true, "sent"]);
      expect(holders.map(p => mailsTo(p.email, resent0).length), "PRECONDITION: the first holder's arrived, the other's did not").toEqual([1, 0]);
      rep = await report(sa, comp.id);
      expect(rep.certificates, "PRECONDITION: one delivered, one still bounced").toEqual({ issued: 2, delivered: 1, bounced: 1 });
      m = await sendNow(sa, comp.id, "se", sean.email);
      expectWords(m, "Ask the event's organiser to resend the certificate email", "SE, one bounced");
      expect(textPart(m), "the figures the step comes from").toContain("Certificates: 2 issued, 1 delivered by email.");
      await makeAdministrator(sa, sean);
      expectButton(await sendNow(sa, comp.id, "se", sean.email), comp.id, "certificates", "Resend 1 certificate email", "SE, one bounced, an administrator");
    } finally { await restoreDomains(sa); }
  });

  test("the SE, when a challenge is too easy and none is the worst: asks the organiser to edit it", async () => {
    const sa = await setUp();
    try {
      const { comp, taskIds } = await makeEvent(sa, { kind: "tournament", tasks: 1 });
      const title = `Warm-up <easy> & "quick" ${stamp()}`;
      expect((await sa.put(`/api/admin/tasks/${taskIds[0]}`, { title }, await sa.h())).ok, "renamed").toBeTruthy();
      const ps = [await person("wez1"), await person("wez2"), await person("wez3")];
      await assign(sa, comp.id, ps);
      for (const p of ps) {
        await enter(p, comp.id);
        expect((await submit(p, comp.id, taskIds[0], "right0")).body.correct, "solved").toBe(true);
      }
      const sean = await member(sa, comp.id, "se", "wez");
      const rep = await report(sa, comp.id);
      expect([rep.worst, rep.challenges.map(x => [x.title, x.flag])], "PRECONDITION: 3 of 3 solved it, no worst challenge").toEqual([null, [[title, "too_easy"]]]);
      const m = await sendNow(sa, comp.id, "se", sean.email);
      expectWords(m, `Ask the event's organiser to edit "${title}"`, "SE, too easy");
      expect(htmlPart(m), "the title is escaped in the HTML part").not.toContain("<easy>");
      await makeAdministrator(sa, sean);
      expectButton(await sendNow(sa, comp.id, "se", sean.email), comp.id, "challenges", `Edit "${title}"`, "SE, too easy, an administrator");
    } finally { await restoreDomains(sa); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The operator's rulings of 14 Nov 2026 on the team-report mails: Marketing's
// report with no leads attaches no file and says nobody has taken part, once;
// the 48-hour reminder counts only leads who can be contacted (lib/event-team.js
// `isContactable`, the SDR report's own definition), and so do the managers'
// scorecard and its call to action; a count of one reads in the singular.
// ─────────────────────────────────────────────────────────────────────────────

test.describe("the team-report mails: no file without leads, a reminder only for leads who can be contacted, one is singular (operator rulings, 14 Nov 2026)", () => {
  // Every attachment of a captured mail, by file name (headers unfolded first).
  const attachmentsOf = (m) => [...String(m.raw).replace(/\r\n[ \t]+/g, " ").matchAll(/^content-disposition:\s*attachment\b([^\r\n]*)/gim)]
    .map(x => { const f = x[1].match(/filename\*?=(?:"([^"]*)"|([^;\s]+))/i); return f ? (f[1] || f[2]) : "(no name)"; });
  // A KPI row as [figure, label] pairs, from a mail's HTML part (the text part
  // has the row on one line).
  const tilesHtml = (html) => [...html.matchAll(/white-space:nowrap">([^<]*)<\/div>\s*<div class="m-muted"[^>]*>([^<]*)<\/div>/g)].map(x => [x[1], x[2]]);
  // The domain list is a global setting: each test puts back its default, the
  // empty list, in its own `finally`.
  const restoreDomains = async (sa) => {
    const r = await sa.put("/api/admin/team-report-domains", { domains: [] }, await sa.h());
    expect.soft(r.ok, `the domain list back to its default: ${r.text}`).toBeTruthy();
  };
  /** A team member at an address no account holds: their mail has no link. */
  const addMember = async (sa, compId, role, name) => {
    const email = `${name.toLowerCase()}-${stamp()}@corp.example`;
    const r = await sa.post(`/api/admin/competitions/${compId}/team`, { role, name, email }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    return { ...r.body.member, email };
  };
  /** Send now, one persona: the one mail it sent, to `email`. */
  const sendNow = async (sa, compId, persona, email) => {
    const before = smtp.messages.length;
    const r = await sa.post(`/api/admin/competitions/${compId}/team-report/send`, { persona }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    expect([r.body.messages, r.body.sent], `PRECONDITION: one ${persona} report, sent: ${r.text}`).toEqual([1, 1]);
    await expect.poll(() => mailsTo(email, before).length, { timeout: 10000 }).toBe(1);
    return mailsTo(email, before)[0];
  };
  const previewOf = async (sa, compId, persona) => {
    const r = await sa.get(`/api/admin/competitions/${compId}/team-report/preview?persona=${persona}`);
    expect(r.ok, r.text).toBeTruthy();
    return r.body;
  };
  // An in-app view's call to action (`focus` on GET …/team-report), as it reads.
  const focusWords = (f) => (f.why || []).map(x => (x && typeof x === "object" ? x.b : x)).join("");

  test("Marketing with no leads: no file is attached and the intro says nobody has taken part, once (the call to action's reason, in the mail and the in-app view, does not repeat it); CONTROL: with one lead the file and the old intro stand", async () => {
    const sa = await admin();
    try {
      expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
      const { comp } = await makeEvent(sa, { kind: "tournament", tasks: 1 });
      // At no account, so the mail carries the sentence that stands in for the
      // button: the one that names the file when there is one.
      const mia = await addMember(sa, comp.id, "marketing", "Mona");
      expect((await report(sa, comp.id)).leads, "PRECONDITION: nobody has taken part").toEqual([]);
      const NONE = "Nobody has taken part yet, so there are no leads to load.";
      const REASON = "No leads yet. The list fills as people take part.";
      const READY = "The leads are ready for your CRM.";
      const FOOT = "The CSV has one row per person";
      const pv0 = await previewOf(sa, comp.id, "marketing");
      expect([pv0.attachment, pv0.cta_link], "the preview names no file (PRECONDITION: no link for this address)").toEqual([null, false]);
      const m0 = await sendNow(sa, comp.id, "marketing", mia.email);
      expect(attachmentsOf(m0), "nothing is attached").toEqual([]);
      expect(csvPart(m0), "no CSV part").toBeNull();
      // A count of none reads in the plural: the subject and the leads tile.
      expect(subjectOf(m0)).toContain(`— 0 leads from ${comp.name}: 0 new, 0 hot`);
      expect(tilesHtml(htmlPart(m0)), "the tiles, HTML part").toEqual([["0", "leads"], ["0", "brand new"], ["0", "returning"], ["0", "hot"], ["0", "warm"], ["0", "cold"]]);
      expect(textPart(m0), "the tiles, text part").toContain("\n0 leads · 0 brand new · 0 returning · 0 hot · 0 warm · 0 cold");
      for (const [part, s] of [["text", textPart(m0)], ["HTML", htmlPart(m0)]]) {
        expect(s, `${part}: the intro says nobody has taken part`).toContain(NONE);
        for (const gone of ["ready for your CRM", "with the file attached", FOOT]) expect(s, `${part}: no "${gone}"`).not.toContain(gone);
        // Said once (operator ruling, 14 Nov 2026): the call to action's reason
        // right under the intro does not say it again.
        expect((s.match(/Nobody has taken part/g) || []).length, `${part}: "Nobody has taken part" once, in the intro`).toBe(1);
        expect(s, `${part}: the reason's old words are gone`).not.toContain("taken part so far");
      }
      expect(textPart(m0), "the call to action's reason, on its own line, text part").toContain(`\n${REASON}`);
      expect(htmlPart(m0), "…and HTML part").toContain("<strong>No leads yet. </strong>The list fills as people take part.</p>");
      // The in-app Marketing view shows that reason alone, with no intro above it.
      const focus0 = (await report(sa, comp.id)).focus.marketing;
      expect([focus0.text, focusWords(focus0)], "the in-app Marketing view's call to action").toEqual(["Open the lead list", REASON]);
      expect(textPart(m0), "the no-link sentence, with no file in it").toContain("Everything here is yours to act on; for anything that needs the event");
      // CONTROL: one lead. The file, the intro, the foot and the no-link
      // sentence's mention of the file all stand.
      const lead = await person("mktone");
      await assign(sa, comp.id, [lead]);
      expect((await report(sa, comp.id)).leads.map(l => l.user_id), "PRECONDITION: one lead").toEqual([lead.id]);
      const file = `leads-${comp.id.slice(0, 8)}.csv`;
      expect((await previewOf(sa, comp.id, "marketing")).attachment, "the preview names the file").toBe(file);
      const m1 = await sendNow(sa, comp.id, "marketing", mia.email);
      expect(attachmentsOf(m1), "the CRM file is attached").toEqual([file]);
      expect(subjectOf(m1), "one lead reads in the singular").toContain(`— 1 lead from ${comp.name}: `);
      expect(tilesHtml(htmlPart(m1))[0], "the leads tile, HTML part").toEqual(["1", "lead"]);
      expect(textPart(m1), "the leads tile, text part").toContain("\n1 lead · ");
      const rows = csvPart(m1).replace(/^\uFEFF/, "").trim().split(/\r?\n/);
      expect(rows.length, "header + the one lead").toBe(2);
      expect(rows[1]).toContain(lead.email);
      for (const [part, s] of [["text", textPart(m1)], ["HTML", htmlPart(m1)]]) {
        expect(s, `${part}: the intro stands`).toContain(READY);
        expect(s, `${part}: not the no-lead one`).not.toContain(NONE);
        expect(s, `${part}: nor the no-lead reason`).not.toContain("The list fills as people take part.");
        expect(s, `${part}: the foot describes the file`).toContain(FOOT);
        expect(s, `${part}: the no-link sentence names the file`).toContain("with the file attached");
      }
      expect(focusWords((await report(sa, comp.id)).focus.marketing), "CONTROL: the in-app view with a lead").toBe("Load 1 lead into the CRM today. The file is attached, one row per person.");
    } finally { await restoreDomains(sa); }
  });

  test("the 48-hour reminder counts only leads who can be contacted: an SDR whose only waiting hot lead opted out is sent nothing and nothing is recorded as sent; CONTROLS: a contactable one by value, and one of each says 1", async () => {
    const sa = await admin();
    try {
      expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
      const optOut = (p) => sql(db => db.prepare("INSERT INTO unsubscribed_emails (email, unsubscribed_at) VALUES (?,?)").run(p.email.toLowerCase(), new Date().toISOString()));
      // Booth Events (they ask the qualifying questions), each with one SDR, who
      // owns every lead, and Marketing; asking for a follow-up makes a lead hot.
      const setUp = async (tag, n) => {
        const { comp } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 1 });
        const q = qTasks(comp.id);
        const ps = [];
        for (let i = 0; i < n; i++) ps.push(await person(`${tag}${i}`));
        await assign(sa, comp.id, ps);
        for (const p of ps) { await enter(p, comp.id); await answerQ(p, comp.id, q, "follow_up", 0); }
        return { comp, ps, sid: await addMember(sa, comp.id, "sdr", "Sid"), mia: await addMember(sa, comp.id, "marketing", "Mia") };
      };
      const A = await setUp("rmout", 1);   // its only hot lead opted out
      const B = await setUp("rmok", 1);    // CONTROL: one who can be contacted
      const C = await setUp("rmmix", 2);   // one of each: ps[0] opts out
      optOut(A.ps[0]); optOut(C.ps[0]);
      for (const [E, out] of [[A, [true]], [B, [false]], [C, [true, false]]]) {
        const by = Object.fromEntries((await report(sa, E.comp.id)).leads.map(l => [l.user_id, l]));
        expect(E.ps.map(p => [by[p.id].signal, !!by[p.id].contacted_at, by[p.id].opted_out]), `PRECONDITION: ${E.comp.name}: hot, none contacted, opted out as set`)
          .toEqual(out.map(o => ["hot", false, o]));
      }
      const all = [A, B, C], ids = JSON.stringify(all.map(E => E.comp.id));
      const due = (kind) => sql(db => db.prepare("UPDATE team_report_jobs SET due_at=? WHERE kind=? AND competition_id IN (SELECT value FROM json_each(?))").run(new Date(0).toISOString(), kind, ids));
      const ran = (E, kind) => !!sql(db => db.prepare("SELECT 1 AS x FROM team_report_runs WHERE competition_id=? AND kind=?").get(E.comp.id, kind));

      // The wrap-up: the SDR's own report counts the same way.
      for (const E of all) expect((await sa.post(`/api/admin/competitions/${E.comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
      const wrap0 = smtp.messages.length;
      due("wrapup");
      await tick(sa, false);
      for (const E of all) expect(ran(E, "wrapup"), `PRECONDITION: ${E.comp.name}'s wrap-up ran`).toBe(true);
      const sdrWrap = (E) => { const ms = mailsTo(E.sid.email, wrap0); expect(ms.length, `${E.comp.name}: one wrap-up to the SDR`).toBe(1); return ms[0]; };
      expect(textPart(sdrWrap(A)), "A: the SDR's report says nothing is waiting").toContain("Nothing is waiting.");
      expect(textPart(sdrWrap(B))).toContain("Contact the 1 hot lead within 48 hours.");
      expect(textPart(sdrWrap(C)), "C: the one who can be contacted, not two").toContain("Contact the 1 hot lead within 48 hours.");
      expect(subjectOf(sdrWrap(C))).toContain(`Your 2 follow-ups from ${C.comp.name}: call the 1 hot first`);

      // 48 hours on: the reminder.
      const nudge0 = smtp.messages.length;
      due("nudge");
      await tick(sa, false);
      for (const E of all) expect(ran(E, "nudge"), `PRECONDITION: ${E.comp.name}'s reminder ran`).toBe(true);
      const ledger = (E) => sql(db => db.prepare("SELECT recipient, persona, status FROM team_report_sends WHERE competition_id=? AND kind='nudge' ORDER BY persona").all(E.comp.id));
      const history = (E) => sql(db => db.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type='team_report_sent'").all(E.comp.id))
        .map(r => JSON.parse(r.details)).filter(d => d.kind === "nudge").map(d => [d.messages, d.sent]);
      // A: nothing sent, nothing recorded as sent.
      expect(mailsTo(A.sid.email, nudge0).length, "A: no reminder to the SDR").toBe(0);
      expect(mailsTo(A.mia.email, nudge0).length, "A: no count to Marketing").toBe(0);
      expect(ledger(A), "A: no send in the ledger").toEqual([]);
      expect(history(A), "A: the History's record of the reminder: nothing went").toEqual([[0, 0]]);
      // B and C: reminded of the one who can be contacted, by value.
      for (const [E, reach, skip] of [[B, B.ps[0], null], [C, C.ps[1], C.ps[0]]]) {
        const sid = mailsTo(E.sid.email, nudge0), mia = mailsTo(E.mia.email, nudge0);
        expect([sid.length, mia.length], `${E.comp.name}: one reminder each to the SDR and Marketing`).toEqual([1, 1]);
        expect(subjectOf(sid[0])).toContain(`Reminder: 1 hot lead waiting from ${E.comp.name}`);
        // The count is of leads who can be contacted, and the sentence says so:
        // in C two hot leads are not marked contacted, one of them opted out.
        expect(textPart(sid[0])).toContain(`1 hot lead from ${E.comp.name} is waiting to be contacted.`);
        expect(textPart(sid[0]), "the card of the one to contact").toContain(`Email: ${reach.email}`);
        if (skip) for (const s of [textPart(sid[0]), htmlPart(sid[0]), textPart(mia[0])]) expect(s, `${E.comp.name}: no word of the lead who opted out`).not.toContain(skip.email);
        expect(subjectOf(mia[0])).toContain(`Reminder: 1 hot lead waiting from ${E.comp.name}`);
        expect(textPart(mia[0])).toContain("1 hot lead is waiting to be contacted. The SDRs have been reminded of theirs.");
        expect(textPart(mia[0])).toContain("\nNext: Make sure the 1 hot lead is contacted.");
        for (const [who, m] of [["the SDR", sid[0]], ["Marketing", mia[0]]]) {
          for (const [part, s] of [["text", textPart(m)], ["HTML", htmlPart(m)]]) expect(s, `${E.comp.name}, ${who}, ${part}: not the count of leads not marked contacted`).not.toContain("not marked contacted");
        }
        expect(ledger(E)).toEqual([{ recipient: E.mia.email, persona: "marketing", status: "sent" }, { recipient: E.sid.email, persona: "sdr", status: "sent" }]);
        expect(history(E)).toEqual([[2, 2]]);
      }
    } finally { await restoreDomains(sa); }
  });

  // The builders, in process: data shaped as lib/event-team.js builds it.
  const lead = (i, extra = {}) => ({
    user_id: `u${i}`, first_name: `Fay${i}`, last_name: `Lee${i}`, email: `fay${i}@lead.example`, company: `Co ${i}`, company_key: `co ${i}`,
    title: "Engineer", country: "US", seniority: 1, answers: {}, positions: {}, signal: "warm", status: "new", possible_duplicate: false,
    source: "Join link or QR code", first_seen_event: "Ev", first_seen_source: null, other_events: [], opted_out: false,
    score: 0, rank: null, rank_session: null, rank_late: false, played: true, solved: 0, struggles: [], free_text: [],
    owner_member_id: null, first_reported_at: null, contacted_at: null, contacted_by: null, ...extra,
  });
  const reportData = (leads, extra = {}) => ({
    comp: { id: "0f0f0f0f-0000-4000-8000-000000000000", name: "Ev", event_kind: "booth", status: "ended", start_time: "2026-11-01T00:00:00.000Z", effective_end: null, ranked: true },
    targets: { lead_target: null, hot_lead_target: null }, qualifying: [], leads, challenges: [], worst: null,
    certificates: { issued: 0, delivered: 0, bounced: 0 }, podium: [], ...extra,
  });
  const why = (r) => (r.cta.why || []).map(x => (x && typeof x === "object" ? x.b : x)).join("");

  test("a count reads in the singular for one, in the plural for none and for two: every count label in the mails, tiles in both parts, subjects and sentences (in process)", () => {
    const M = require("../lib/team-report-mail");
    const mail = (r) => M.renderMail("Plat", "Ev", { name: "Rae", email: "rae@corp.example", role: "marketing" }, r, "Marketing", { link: false });
    const unescape = (s) => s.replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
    // What each count reads; null where a count of none draws no tile or sentence.
    const W = {
      0: { lead: "leads", newLead: "new leads", company: "companies", person: "people", newPerson: "new people", dup: null, dupLine: null, optLine: null, rating: null, account: "0 accounts" },
      1: { lead: "lead", newLead: "new lead", company: "company", person: "person", newPerson: "new person", dup: "possible duplicate", dupLine: "1 person shares a name and company",
        optLine: "1 person has opted out of our email; their row is marked \"do not email\".", rating: "1 low of 1 rating", account: "1 account" },
      2: { lead: "leads", newLead: "new leads", company: "companies", person: "people", newPerson: "new people", dup: "possible duplicates", dupLine: "2 people share a name and company",
        optLine: "2 people have opted out of our email; their rows are marked \"do not email\".", rating: "2 low of 2 ratings", account: "2 accounts" },
    };
    const all = [];
    for (const n of [0, 1, 2]) {
      const w = W[n], ls = Array.from({ length: n }, (_, i) => lead(i + 1)), d = reportData(ls);
      const check = (r, rowHtml) => { const m = mail(r); all.push([n, r.subject, m.text, m.html]); expect(tilesHtml(m.html), `${n}: the tiles, HTML part`).toEqual(rowHtml); expect(m.text.split("\n"), `${n}: the tiles, text part`).toContain(rowHtml.map(([f, l]) => `${f} ${l}`).join(" · ")); return m; };
      // Marketing: the wrap-up and the new-leads update.
      let r = M.marketingReport(d, ls);
      check(r, [[`${n}`, w.lead], [`${n}`, "brand new"], ["0", "returning"], ["0", "hot"], [`${n}`, "warm"], ["0", "cold"]]);
      expect(r.subject).toBe(`${n} ${w.lead} from Ev: ${n} new, 0 hot`);
      r = M.marketingReport(d, ls, { delta: true });
      check(r, [[`${n}`, w.newLead], [`${n}`, "brand new"], ["0", "returning"], ["0", "hot"], [`${n}`, "warm"], ["0", "cold"]]);
      expect(r.subject).toBe(`Ev: ${n} ${w.newLead} since the last report (${n} new to us, 0 hot)`);
      // …with possible duplicates: the tile and the sentence under it (none for none).
      const dups = ls.map(l => ({ ...l, status: "possible_duplicate", possible_duplicate: true }));
      const md = check(M.marketingReport(reportData(dups), dups), [[`${n}`, w.lead], ["0", "brand new"], ["0", "returning"], ["0", "hot"], [`${n}`, "warm"], ["0", "cold"], ...(w.dup ? [[`${n}`, w.dup]] : [])]);
      for (const s of [md.text, md.html]) {
        if (w.dupLine) expect(s, `${n}: the duplicates sentence`).toContain(`${w.dupLine} with someone else under another address.`);
        else expect(s, "no duplicate, no sentence").not.toContain("a name and company");
      }
      // …with every lead opted out: the sentence beside the call to action, in the
      // wrap-up and in the update, one row per person (none for none).
      const outs = ls.map(l => ({ ...l, opted_out: true }));
      for (const delta of [false, true]) {
        const mo = mail(M.marketingReport(reportData(outs), outs, { delta }));
        all.push([n, "", mo.text, mo.html]);
        for (const [part, s] of [["text", mo.text], ["HTML", unescape(mo.html)]]) {
          if (w.optLine) expect(s, `${n}, ${delta ? "update" : "wrap-up"}, ${part}: the opted-out sentence`).toContain(w.optLine);
          else expect(s, `${delta ? "update" : "wrap-up"}, ${part}: nobody opted out, no sentence`).not.toContain("opted out of our email");
        }
      }
      // Sales: one warm lead per company, so each is an account.
      r = M.salesReport(d, ls);
      check(r, [[`${n}`, w.company], ["0", "ready for a meeting"], [`${n}`, w.person]]);
      expect(r.subject).toBe(`${w.account} engaged at Ev: 0 ready for a meeting`);
      check(M.salesReport(d, ls, { delta: true }), [[`${n}`, w.company], ["0", "ready for a meeting"], [`${n}`, w.newPerson]]);
      // The managers' subject.
      expect(M.managerReport(d, [], null).subject).toBe(`Scorecard for Ev: ${n} ${w.lead}, 0 hot`);
      // The SE's low ratings (none rated: no flag).
      const rated = reportData(ls, { challenges: [{ id: "t1", title: "Ch", task_number: null, attempters: 0, solvers: 0, solve_rate: null, wrong: 0, top_wrong: null, sealed: false, flag: null, ratings: n, avg_rating: n ? 1 : null, low_ratings: n }] });
      const se = mail(M.seReport(rated));
      all.push([n, "", se.text, se.html]);
      if (w.rating) {
        expect(se.text).toContain(`"Ch": ${w.rating}. Average 1.0 of 5.`);
        expect(se.html).toContain(`: ${w.rating}</p>`);
      } else expect(se.text, "no rating, no flag").not.toContain("low of");
    }
    // No plural after a one, and no singular after a none, anywhere.
    for (const [n, subject, text, html] of all.filter(x => x[0] === 1)) {
      for (const s of [subject, text, html]) expect(s, `n=${n}`).not.toMatch(/(?:^|[^0-9])1 (?:new )?(?:leads|companies|people|ratings)\b|1 person share\b|1 person has opted out of our email; their rows\b|(?:>|\b)1<\/div>\s*<div class="m-muted"[^>]*>(?:new )?(?:leads|companies|people)</);
    }
    for (const [n, subject, text, html] of all.filter(x => x[0] === 0)) {
      for (const s of [subject, text, html]) expect(s, `n=${n}`).not.toMatch(/(?:^|[^0-9])0 (?:new )?(?:lead|company|person|account)\b|>0<\/div>\s*<div class="m-muted"[^>]*>(?:new )?(?:lead|company|person)</);
    }
    expect([0, 1, 2].map(n => all.filter(x => x[0] === n).length), "the sweeps read every mail built above").toEqual([8, 8, 8]);
  });

  test("the SDR's own report counts waiting leads as the reminder does: a hot lead who opted out is not one to call (in process)", () => {
    const T = require("../lib/event-team");
    const M = require("../lib/team-report-mail");
    const hotIn = lead(1, { signal: "hot" }), hotOut = lead(2, { signal: "hot", opted_out: true });
    const hotDone = lead(3, { signal: "hot", contacted_at: "2026-11-10T00:00:00.000Z" }), cold = lead(4, { signal: "cold" }), warm = lead(5, { signal: "warm" });
    expect([hotIn, hotOut, hotDone, cold].map(T.isContactable), "the one definition: not contacted, not opted out").toEqual([true, false, false, true]);
    const sdr = (ls) => M.sdrReport(reportData(ls), ls);
    // One of each: the one who can be reached is the call, and the count.
    let r = sdr([hotIn, hotOut]);
    expect([r.cta.text, why(r), r.subject]).toEqual(["Contact Fay1 Lee1 first",
      "Contact the 1 hot lead within 48 hours. Leads go cold fast. Ask an organiser to mark each one contacted once you have reached out, and the reminder stops.",
      "Your 2 follow-ups from Ev: call the 1 hot first"]);
    // The hot leads are all opted out or contacted: start elsewhere, and say why truly.
    for (const [hot, other] of [[hotOut, cold], [hotDone, warm]]) {
      r = sdr([hot, other]);
      expect([r.cta.text, why(r), r.subject]).toEqual([`Contact ${other.first_name} ${other.last_name} first`,
        `Start with ${other.first_name} ${other.last_name}. Every hot lead of yours is marked contacted or has opted out, so this is the place to start.`,
        "Your 2 follow-ups from Ev"]);
    }
    // CONTROLS: with no hot lead at all, the words stand; with only the one who opted out, nothing waits.
    expect(why(sdr([cold]))).toBe("Start with Fay4 Lee4. None of yours is hot, so this is the place to start.");
    expect(why(sdr([warm, cold]))).toBe("Start with Fay5 Lee5. A warm lead, and the strongest you have.");
    r = sdr([hotOut]);
    expect([r.cta.text, why(r)]).toEqual(["Open your leads", "Nothing is waiting. Everyone here is marked contacted or has opted out."]);
  });

  // ── One meaning of "waiting" (operator ruling, 14 Nov 2026) ─────────────────
  // The managers' scorecard and its call to action count only the hot leads
  // somebody may still reach (lib/event-team.js `isContactable`), as the SDR's
  // report and the 48-hour reminder do, and the row reads "Hot still to contact".
  // The in-app views read that verdict per lead (`contactable`), and the
  // contacted mark answers it (tests/event-team-ui.spec.js holds the screens).

  // The scorecard's rows from a mail's HTML part, each row's cells as they read.
  const scorecardRows = (html) => {
    const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(row => [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map(c => c[1].replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()));
  };
  const toContactRow = (html) => scorecardRows(html).find(r => r[0] === "Hot still to contact");
  const ASSIGN_WHY = "Add an SDR or a Marketing owner to the event team so they are contacted.";
  const NONE_WAITING = "Nothing is stuck. No hot lead is waiting to be contacted.";

  test("the managers' scorecard counts waiting leads as the reminder does: a hot lead who opted out is neither still to contact nor one to assign, and the words beside the count stay true (in process)", () => {
    const T = require("../lib/event-team");
    const M = require("../lib/team-report-mail");
    const mail = (r) => M.renderMail("Plat", "Ev", { name: "Max", email: "max@corp.example", role: "sales_manager" }, r, "Sales manager", { link: false });
    const sdrOwner = { id: "m-sdr", name: "Sid", role: "sdr" };
    const own = (l) => ({ ...l, owner_member_id: sdrOwner.id });
    const hotIn = lead(1, { signal: "hot" }), hotIn2 = lead(2, { signal: "hot" });
    const hotOut = lead(3, { signal: "hot", opted_out: true });
    const hotDone = lead(4, { signal: "hot", contacted_at: "2026-11-10T00:00:00.000Z" });
    const warm = lead(5, { signal: "warm" });
    // [what, leads, owners, the button, its reason, the row's result]
    const cases = [
      ["the only hot lead opted out, nobody owns leads", [hotOut, warm], [], "Open the event report", NONE_WAITING, "0 Done"],
      ["CONTROL: one who can be contacted beside one who opted out, nobody owns leads", [hotIn, hotOut], [], "Assign the 1 hot lead", `1 hot lead still to contact has no owner yet. ${ASSIGN_WHY}`, "1 Pending"],
      ["CONTROL: two who can be contacted", [hotIn, hotIn2, hotOut], [], "Assign the 2 hot leads", `2 hot leads still to contact have no owner yet. ${ASSIGN_WHY}`, "2 Pending"],
      ["one owned, beside one who opted out and has no owner", [own(hotIn), hotOut], [sdrOwner], "Open the event report", "Every hot lead still to contact has an owner. 1 is still waiting to be contacted.", "1 Pending"],
      ["two owned, one who opted out", [own(hotIn), own(hotIn2), own(hotOut)], [sdrOwner], "Open the event report", "Every hot lead still to contact has an owner. 2 are still waiting to be contacted.", "2 Pending"],
      ["one contacted, one opted out and never marked", [own(hotDone), own(hotOut)], [sdrOwner], "Open the event report", NONE_WAITING, "0 Done"],
      ["no hot lead at all", [warm], [sdrOwner], "Open the event report", NONE_WAITING, "0 Done"],
    ];
    for (const [what, ls, owners, button, words, result] of cases) {
      const r = M.managerReport(reportData(ls), owners, null);
      expect([r.cta.text, why(r)], what).toEqual([button, words]);
      expect(Number(result.split(" ")[0]), `${what}: the count is of the hot leads lib/event-team.js isContactable admits`)
        .toBe(ls.filter(l => l.signal === "hot" && T.isContactable(l)).length);
      const m = mail(r);
      expect(m.text.split("\n"), `${what}: the row, text part`).toContain(`Measure: Hot still to contact | Target: — | Result: ${result} | Last 3 avg: —`);
      expect(toContactRow(m.html), `${what}: the row, HTML part`).toEqual(["Hot still to contact", "—", result, "—"]);
      for (const [part, s] of [["text", m.text], ["HTML", m.html]]) {
        for (const old of ["Hot not yet contacted", "Every hot lead has an owner", "assigned and contacted"]) expect(s, `${what}, ${part}: not "${old}"`).not.toContain(old);
      }
    }
  });

  // NEVER A COPY: every count of waiting, and every verdict the server sends,
  // is lib/event-team.js `isContactable`'s own. In process, moving the
  // definition moves the mails' counts. The two verdicts the server sends are
  // built in the server process, out of a swap's reach, so a source arm pins
  // each to a call of it.
  test("never a copy, in process: the managers' scorecard, the SDR's report and the 48-hour reminder all count by lib/event-team.js isContactable, wherever it moves", () => {
    const T = require("../lib/event-team");
    const M = require("../lib/team-report-mail");
    const R = require("../lib/team-reports");
    const mail = (r) => M.renderMail("Plat", "Ev", { name: "Max", email: "max@corp.example", role: "sales_manager" }, r, "Sales manager", { link: false });
    const hotIn = lead(1, { signal: "hot" }), hotIn2 = lead(2, { signal: "hot" });
    const hotOut = lead(3, { signal: "hot", opted_out: true });
    const hotDone = lead(4, { signal: "hot", contacted_at: "2026-11-10T00:00:00.000Z" });
    // The 48-hour reminder as lib/team-reports.js composes it, for an SDR who
    // owns every lead and Marketing: each message's persona and subject (after
    // the platform's name).
    const team = [{ id: "m-sdr", role: "sdr", name: "Sid", email: "sid@corp.example" }, { id: "m-mkt", role: "marketing", name: "Mia", email: "mia@corp.example" }];
    const reminders = (ls) => R.composeRun(reportData(ls.map(l => ({ ...l }))), team, "nudge").messages
      .map(m => [m.persona, m.subject.slice(m.subject.indexOf("Reminder:"))]);
    const reminded = (n) => [["sdr", `Reminder: ${n} hot lead${n === 1 ? "" : "s"} waiting from Ev`], ["marketing", `Reminder: ${n} hot lead${n === 1 ? "" : "s"} waiting from Ev`]];
    // CONTROLS, the definition as it stands: the lead who opted out and the one
    // marked contacted are not waiting; the reachable one is.
    expect(reminders([hotOut, hotDone]), "nobody to remind").toEqual([]);
    expect(reminders([hotIn, hotOut, hotDone]), "one to remind").toEqual(reminded(1));
    const saved = T.isContactable;
    try {
      T.isContactable = () => true;
      let r = M.managerReport(reportData([hotOut, hotDone]), [], null);
      expect([r.cta.text, why(r)], "every hot lead admitted: both count").toEqual(["Assign the 2 hot leads", `2 hot leads still to contact have no owner yet. ${ASSIGN_WHY}`]);
      expect(toContactRow(mail(r).html), "…in the scorecard's row").toEqual(["Hot still to contact", "—", "2 Pending", "—"]);
      expect(M.sdrReport(reportData([hotOut]), [hotOut]).cta.text, "…in the SDR's report").toBe("Contact Fay3 Lee3 first");
      expect(reminders([hotOut, hotDone]), "…and in the 48-hour reminder, the SDR's and Marketing's").toEqual(reminded(2));
      T.isContactable = () => false;
      r = M.managerReport(reportData([hotIn, hotIn2]), [], null);
      expect([r.cta.text, why(r)], "none admitted: nothing waits").toEqual(["Open the event report", NONE_WAITING]);
      expect(toContactRow(mail(r).html), "…in the scorecard's row").toEqual(["Hot still to contact", "—", "0 Done", "—"]);
      expect(M.sdrReport(reportData([hotIn]), [hotIn]).cta.text, "…in the SDR's report").toBe("Open your leads");
      expect(reminders([hotIn, hotIn2]), "…and no reminder").toEqual([]);
    } finally { T.isContactable = saved; }
    expect(T.isContactable, "the definition is put back").toBe(saved);
  });

  test("never a copy, at the source: every `contactable` verdict the server sends is one call of lib/event-team.js isContactable (the report read's field) or leadContactable (the contacted mark's answer), which returns isContactable's verdict; CONTROLS: the scanner refuses a copy", () => {
    const { ROOT, stripJsComments } = require("./doc-registry");
    // Just past the ")" closing the call whose "(" is at `open`; -1 if it never closes.
    const callEnd = (s, open) => {
      for (let i = open, depth = 0; i < s.length; i++) {
        if (s[i] === "(") depth++;
        else if (s[i] === ")" && --depth === 0) return i + 1;
      }
      return -1;
    };
    // At `at`: exactly one call of `callee` (a pattern) and nothing beside it.
    const oneCallAt = (s, at, callee) => {
      const m = s.slice(at).match(new RegExp(`^\\s*${callee}\\(`));
      if (!m) return false;
      const end = callEnd(s, at + m[0].length - 1);
      return end > 0 && /^\s*[,;})]/.test(s.slice(end));
    };
    const snippet = (s, at) => s.slice(at, at + 90).replace(/\s+/g, " ");
    // Every place a module (comments stripped) puts a `contactable` value. Its
    // value must be one call of the definition, through the module's own
    // binding of lib/event-team.js (in that module itself, the bare name),
    // whether a key, an assignment or a local of that name sent as a shorthand
    // (a local is the definition's only when every assignment to it is one
    // call). Reading the field (`l.contactable === true`) puts nothing.
    const verdicts = (src, rel) => {
      const own = rel === "lib/event-team.js";
      const bound = own ? null : (src.match(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["'](?:\.\.?\/)+(?:lib\/)?event-team["']\s*\)/) || [])[1];
      const callee = own ? "(?:module\\.exports\\.)?(isContactable|leadContactable)" : bound ? `${bound}\\.(isContactable|leadContactable)` : null;
      const isCall = (at) => !!callee && oneCallAt(src, at, callee);
      const via = (at) => src.slice(at).match(/isContactable|leadContactable/)[0];
      const out = [];
      const assigns = [...src.matchAll(/(?<![\w$])contactable\s*=(?![=>])/g)].map(m => ({ at: m.index + m[0].length, bare: src[m.index - 1] !== ".", index: m.index }));
      const local = assigns.filter(a => a.bare);
      const localOk = local.length > 0 && local.every(a => isCall(a.at));
      for (const a of assigns) { const ok = isCall(a.at); out.push({ rel, form: "assignment", ok, via: ok ? via(a.at) : null, text: snippet(src, a.index) }); }
      for (const m of src.matchAll(/(?<![\w$.])contactable\s*:/g)) {
        const at = m.index + m[0].length;
        const named = /^\s*contactable\s*[,})]/.test(src.slice(at));
        const ok = named ? localOk : isCall(at);
        out.push({ rel, form: "key", ok, via: ok && !named ? via(at) : null, text: snippet(src, m.index) });
      }
      for (const m of src.matchAll(/(?<=[{,]\s*)contactable(?=\s*[,}])/g)) out.push({ rel, form: "shorthand", ok: localOk, text: snippet(src, m.index) });
      return out;
    };
    // Every `return` in a function body: false (an account that is gone), one
    // call of isContactable, or a local every assignment of which is one such
    // call; anything else is a verdict of its own.
    const returnsOf = (body) => [...body.matchAll(/\breturn\b/g)].map(m => {
      const at = m.index + m[0].length;
      const DEF = "(?:module\\.exports\\.)?isContactable";
      if (/^\s*false\s*[;}]/.test(body.slice(at))) return "false";
      if (oneCallAt(body, at, DEF)) return "isContactable";
      const name = (body.slice(at).match(/^\s*([A-Za-z_$][\w$]*)\s*[;}]/) || [])[1];
      const sets = name ? [...body.matchAll(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*=(?![=>])`, "g"))] : [];
      if (sets.length && sets.every(x => oneCallAt(body, x.index + x[0].length, DEF))) return "isContactable";
      return `its own: return${snippet(body, at)}`;
    });
    const bodyOf = (src, name) => {
      const fn = src.search(new RegExp(`\\bfunction\\s+${name}\\s*\\(`));
      if (fn < 0) return null;
      const open = src.indexOf("{", callEnd(src, src.indexOf("(", fn)));
      for (let i = open, depth = 0; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
      }
      return null;
    };

    // CONTROLS: the scanner tells the definition's own verdict from a copy.
    const HEAD = 'const T = require("../lib/event-team");\n';
    const planted = (src) => verdicts(src, "routes/planted.js").map(x => [x.form, x.ok]);
    expect(planted(`${HEAD}res.json({ ...l, contactable: T.isContactable(l), opener });`), "the definition's own call").toEqual([["key", true]]);
    expect(planted(`${HEAD}res.json({ ok: true, ...(canRead ? { contactable: T.leadContactable(comp.id, req.params.userId) } : {}) });`), "…and leadContactable's").toEqual([["key", true]]);
    expect(planted(`${HEAD}const contactable = T.leadContactable(c, u); res.json({ ok, contactable }); res.json({ contactable: contactable });`), "a local holding one call, sent").toEqual([["assignment", true], ["key", true], ["shorthand", true]]);
    expect(planted(`${HEAD}l.contactable = T.isContactable(l);`), "the call, put on a lead").toEqual([["assignment", true]]);
    expect(planted(`${HEAD}const leads = ls.map(l => ({ ...l, contactable: !l.contacted_at && !l.opted_out }));`), "a copy of the rule").toEqual([["key", false]]);
    expect(planted(`${HEAD}res.json({ contactable: T.isContactable(l) && !l.blocked });`), "a term beside the call").toEqual([["key", false]]);
    expect(planted('const T = require("../lib/other");\nres.json({ contactable: T.isContactable(l) });'), "another module's isContactable").toEqual([["key", false]]);
    expect(planted(`${HEAD}const contactable = !l.contacted_at; res.json({ ok, contactable });`), "a local worked out of its own, sent").toEqual([["assignment", false], ["shorthand", false]]);
    expect(planted(`${HEAD}let contactable = T.isContactable(l); if (x) contactable = !l.opted_out; res.json({ contactable });`), "a local of the call, then changed").toEqual([["assignment", true], ["assignment", false], ["shorthand", false]]);
    expect(planted(`${HEAD}l.contactable = !l.contacted_at;`), "a copy, put on a lead").toEqual([["assignment", false]]);
    expect(planted(`${HEAD}if (l.contactable === true && f(l.contactable, 1)) x = y ? l.contactable : z;`), "reading the field puts nothing").toEqual([]);
    expect(returnsOf("if (!u) return false;\nreturn isContactable({ contacted_at: st ? st.contacted_at : null, opted_out: o });"), "the definition's verdict").toEqual(["false", "isContactable"]);
    expect(returnsOf("const ok = isContactable({ contacted_at: null, opted_out: o });\nreturn ok;"), "…held in a local").toEqual(["isContactable"]);
    expect(returnsOf("return !(st && st.contacted_at) && !_optedOutOf(u, set);")[0], "a copy of the rule").toMatch(/^its own: /);
    expect(returnsOf("return isContactable(l) && !u.blocked;")[0], "a term beside the call").toMatch(/^its own: /);
    expect(returnsOf("const ok = !(st && st.contacted_at);\nreturn ok;")[0], "a local of its own").toMatch(/^its own: /);

    // The server: server.js, routes/ and lib/.
    const strip = (rel) => stripJsComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));
    const js = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith(".js")).map(f => `${dir}/${f}`);
    const files = ["server.js", ...js("routes"), ...js("lib")];
    const found = files.flatMap(rel => verdicts(strip(rel), rel));
    expect(found.filter(s => !s.ok).map(s => `${s.rel} (${s.form}): ${s.text}`), "every `contactable` the server sends is one call of lib/event-team.js isContactable or leadContactable, never a value of its own").toEqual([]);
    // Not vacuous: both producers are found, each through its own door.
    expect(found.map(s => `${s.rel} → ${s.via}`), "the report read's field and the contacted mark's answer").toEqual(expect.arrayContaining(["routes/event-team.js → isContactable", "routes/event-team.js → leadContactable"]));
    // leadContactable answers isContactable's verdict for the stored mark and
    // the reports' opted-out test, never one of its own.
    const body = bodyOf(strip("lib/event-team.js"), "leadContactable");
    expect(body, "PRECONDITION: lib/event-team.js defines leadContactable").toBeTruthy();
    const rets = returnsOf(body);
    expect(rets.filter(x => x.startsWith("its own")), "leadContactable returns isContactable's verdict, or false for an account that is gone").toEqual([]);
    expect(rets, "…and returns it").toContain("isContactable");
    // …given the opted-out test every lead's `opted_out` comes from, not a re-typed one.
    expect(body, "leadContactable reads opting out by the reports' own test").toMatch(/\b_optedOutOf\(/);
    const build = bodyOf(strip("lib/event-team.js"), "buildReportData");
    expect(build, "PRECONDITION: lib/event-team.js defines buildReportData").toBeTruthy();
    expect(build, "PRECONDITION: its body alone, not the functions after it").not.toMatch(/\bfunction\s+(?:summarise|leadContactable)\b/);
    expect(build, "…the one buildReportData gives every lead").toMatch(/\bopted_out\s*:\s*_optedOutOf\(/);
  });

  test("the contacted mark's answer reads opting out as the report read does, by either address: a person who opted out through their secondary address is not to contact in both (CONTROL: one who did not is)", async () => {
    const sa = await admin();
    const { comp } = await makeEvent(sa, { tasks: 0 });
    const viaSecond = await person("wtcsec"), control = await person("wtcctl");
    await assign(sa, comp.id, [viaSecond, control]);
    // Their own second address, set the way they would set it, then opted out.
    const second = `alt-${stamp()}@elsewhere.example`;
    const put = await viaSecond.c.put("/api/me", { secondaryEmail: second }, await viaSecond.c.h());
    expect(put.ok, `the secondary address: ${put.text}`).toBeTruthy();
    expect(sql(db => db.prepare("SELECT secondary_email FROM users WHERE id=?").get(viaSecond.id).secondary_email), "PRECONDITION: stored").toBe(second);
    sql(db => db.prepare("INSERT INTO unsubscribed_emails (email, unsubscribed_at) VALUES (?,?)").run(second, new Date().toISOString()));
    const by = Object.fromEntries((await report(sa, comp.id)).leads.map(l => [l.user_id, l]));
    expect([viaSecond, control].map(p => [by[p.id].opted_out, by[p.id].contactable]), "the report read: opted out through the secondary address").toEqual([[true, false], [false, true]]);
    for (const [p, verdict] of [[viaSecond, false], [control, true]]) {
      const r = await sa.post(`/api/admin/competitions/${comp.id}/leads/${p.id}/contacted`, { contacted: false }, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
      expect(r.body.contactable, `the mark's answer agrees with the report read (${p === control ? "CONTROL" : "opted out through the secondary address"})`).toBe(verdict);
    }
  });

  test("one meaning of waiting, end to end: a hot lead who opted out is not still to contact in the managers' mail, its call to action or the report read, and the contacted mark answers the one definition (CONTROLS: a contactable hot lead is, by value)", async () => {
    const sa = await admin();
    try {
      expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
      // A Booth Event asks the qualifying questions: asking for a follow-up makes a lead hot.
      const { comp } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 1 });
      const q = qTasks(comp.id);
      const reach = await person("wtcin"), gone = await person("wtcout");
      await assign(sa, comp.id, [reach, gone]);
      for (const p of [reach, gone]) { await enter(p, comp.id); await answerQ(p, comp.id, q, "follow_up", 0); }
      // A manager, and nobody who owns leads: every hot lead still to contact is unowned.
      const max = await addMember(sa, comp.id, "marketing_manager", "Max");
      const leadsBy = async () => Object.fromEntries((await report(sa, comp.id)).leads.map(l => [l.user_id, l]));
      const managersSay = async (button, words, result) => {
        expect(focusWords((await report(sa, comp.id)).focus.manager), "the in-app Managers view's call to action").toBe(words);
        const pv = await previewOf(sa, comp.id, "manager");
        expect([pv.cta.text, pv.cta_link], "the managers' email's call to action (PRECONDITION: no link for this address)").toEqual([button, false]);
        expect(pv.text).toContain(words);
        expect(pv.text.split("\n").some(l => l.startsWith(`Measure: Hot still to contact | Target: — | Result: ${result} | `)), `the row reads ${result}, text part:\n${pv.text}`).toBe(true);
        expect(toContactRow(pv.html).slice(0, 3), "the row, HTML part").toEqual(["Hot still to contact", "—", result]);
        for (const s of [pv.text, pv.html]) expect(s, "the old label").not.toContain("Hot not yet contacted");
      };
      let by = await leadsBy();
      expect([reach, gone].map(p => [by[p.id].signal, by[p.id].opted_out, by[p.id].contactable]), "PRECONDITION: two hot leads, both reachable").toEqual([["hot", false, true], ["hot", false, true]]);
      await managersSay("Assign the 2 hot leads", `2 hot leads still to contact have no owner yet. ${ASSIGN_WHY}`, "2 Pending");
      // One opts out: no longer still to contact, nor one to assign.
      sql(db => db.prepare("INSERT INTO unsubscribed_emails (email, unsubscribed_at) VALUES (?,?)").run(gone.email.toLowerCase(), new Date().toISOString()));
      by = await leadsBy();
      expect([reach, gone].map(p => [by[p.id].opted_out, by[p.id].contactable]), "the report read's verdict, lead by lead").toEqual([[false, true], [true, false]]);
      await managersSay("Assign the 1 hot lead", `1 hot lead still to contact has no owner yet. ${ASSIGN_WHY}`, "1 Pending");
      // The mail as sent, in both parts.
      const m = await sendNow(sa, comp.id, "manager", max.email);
      const text = textPart(m), html = htmlPart(m);
      expect(text).toContain(`1 hot lead still to contact has no owner yet. ${ASSIGN_WHY}`);
      expect(text).toContain("\nNext: Ask the event's organiser to add an SDR or a Marketing owner.");
      expect(text.split("\n").some(l => l.startsWith("Measure: Hot still to contact | Target: — | Result: 1 Pending | ")), "the row, text part").toBe(true);
      expect(html).toContain("<strong>1 hot lead still to contact has no owner yet. </strong>");
      expect(toContactRow(html).slice(0, 3), "the row, HTML part").toEqual(["Hot still to contact", "—", "1 Pending"]);
      for (const [part, s] of [["text", text], ["HTML", html]]) {
        expect(s, `${part}: the old label`).not.toContain("Hot not yet contacted");
        expect(s, `${part}: not the count that held the lead who opted out`).not.toContain("2 hot leads");
      }
      // The contacted mark answers whether the lead may still be reached, read after the write.
      const mark = async (p, contacted) => {
        const r = await sa.post(`/api/admin/competitions/${comp.id}/leads/${p.id}/contacted`, { contacted }, await sa.h());
        expect(r.ok, r.text).toBeTruthy();
        return [r.body.contacted, r.body.contactable];
      };
      expect(await mark(reach, true), "marked: no longer to contact").toEqual([true, false]);
      expect(await mark(gone, true)).toEqual([true, false]);
      expect(await mark(gone, false), "unmarked, but opted out: still nobody's to contact").toEqual([false, false]);
      expect(await mark(reach, false), "CONTROL: unmarked and reachable: to contact again").toEqual([false, true]);
      expect(await mark(reach, true)).toEqual([true, false]);
      // Nothing waits now, though the lead who opted out was never contacted.
      by = await leadsBy();
      expect([reach, gone].map(p => [!!by[p.id].contacted_at, by[p.id].contactable])).toEqual([[true, false], [false, false]]);
      await managersSay("Open the event report", NONE_WAITING, "0 Done");
    } finally { await restoreDomains(sa); }
  });

  test("the contacted mark's answer says whether the lead may still be reached only to a role that reads the reports (participants.view); superadmin CONTROL", async () => {
    const sa = await admin();
    const { comp } = await makeEvent(sa, { tasks: 0 });
    const p = await person("wtcgate");
    await assign(sa, comp.id, [p]);
    // A role that may mark contacts (participants.edit) but not read the reports.
    const role = await sa.post("/api/admin/roles", { label: `Lead marker ${stamp()}`, scope_mode: "granted", permissions: ["events.view", "participants.edit"] }, await sa.h());
    expect(role.ok, `create role: ${role.text}`).toBeTruthy();
    const marker = await person("wtcmark");
    expect((await sa.post(`/api/admin/participants/${marker.id}/role`, { role: role.body.role.id }, await sa.h())).ok, "give the role").toBeTruthy();
    expect((await sa.post(`/api/admin/competitions/${comp.id}/admins`, { userId: marker.id }, await sa.h())).ok, "grant the event").toBeTruthy();
    const mc = client();
    expect((await codeSignIn(mc, marker.email)).body.ok, "signs in").toBe(true);
    expect((await mc.get(`/api/admin/competitions/${comp.id}/team-report`)).status, "PRECONDITION: this role cannot read the reports").toBe(403);
    const r = await mc.post(`/api/admin/competitions/${comp.id}/leads/${p.id}/contacted`, { contacted: false }, await mc.h());
    expect(r.ok, `the mark is this role's to set: ${r.text}`).toBeTruthy();
    expect(r.body, "nothing that says whether they opted out").toEqual({ ok: true, contacted: false, changed: false });
    const s = await sa.post(`/api/admin/competitions/${comp.id}/leads/${p.id}/contacted`, { contacted: false }, await sa.h());
    expect(s.body, "CONTROL: a role that reads the reports is told").toEqual({ ok: true, contacted: false, changed: false, contactable: true });
  });
});

test.describe("a lead's other events are named only to a reader who may open them (operator ruling, 15 Nov 2026)", () => {
  test("the organiser's in-app view, download and preview withhold an event outside their reach; each recipient's email and file name only the events their own account opens; CONTROLS: the superadmin, an administrator recipient", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example", "company.co"] }, await sa.h())).ok).toBeTruthy();
    try {
      // The lead's FIRST event is another organiser's Program (started 40 days
      // ago, still live so the assign is accepted); the report is for a Booth Event.
      const other = await makeEvent(sa, { kind: "program", startAgoMs: 40 * 86400e3, tasks: 0 });
      const { comp } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 1 });
      const lead = await person("othlead", { company: "Elsewhere" });
      await assign(sa, other.comp.id, [lead]);
      await assign(sa, comp.id, [lead]);
      await enter(lead, comp.id);
      // Hot, so Marketing's mail lists them under "Top hot leads", whose line
      // names their other events ("Also: …").
      const q = qTasks(comp.id);
      await answerQ(lead, comp.id, q, "developers", 3);
      await answerQ(lead, comp.id, q, "evaluating", 1);
      // An event admin who organises the Booth Event only.
      const org = await person("othorg", { first: "Ora" });
      const g = await sa.post(`/api/admin/competitions/${comp.id}/admins`, { userId: org.id }, await sa.h());
      expect(g.ok, g.text).toBeTruthy();
      const oc = client();
      expect((await codeSignIn(oc, org.email)).body.ok, "the organiser signs in").toBe(true);
      const NAME = other.comp.name;

      // The in-app view: the organiser's withholds it, the superadmin's names it.
      const mine = await oc.get(`/api/admin/competitions/${comp.id}/team-report`);
      expect(mine.ok, mine.text).toBeTruthy();
      const lm = mine.body.leads.find(l => l.user_id === lead.id);
      expect(lm, "PRECONDITION: the person is a lead of the report").toBeTruthy();
      expect(lm.other_events).toEqual([]);
      expect(lm.first_seen_event, "where they were first seen is withheld, not replaced").toBe("Another event");
      expect(lm.first_seen_source, "nor who invited them there").toBeNull();
      expect(mine.text, "the event's name appears nowhere in the organiser's report").not.toContain(NAME);
      const all = await sa.get(`/api/admin/competitions/${comp.id}/team-report`);
      const la = all.body.leads.find(l => l.user_id === lead.id);
      expect(la.other_events, "CONTROL: the superadmin reads it").toEqual([NAME]);
      expect(la.first_seen_event).toBe(NAME);

      // The download, the same way.
      const csvMine = await oc.get(`/api/admin/competitions/${comp.id}/team-report/leads.csv`);
      expect(csvMine.status, csvMine.text).toBe(200);
      expect(csvMine.text, "the organiser's file withholds it").not.toContain(NAME);
      expect(csvMine.text, "PRECONDITION: the lead is in the file").toContain(lead.email);
      const csvAll = await sa.get(`/api/admin/competitions/${comp.id}/team-report/leads.csv`);
      expect(csvAll.text, "CONTROL: the superadmin's file names it").toContain(NAME);

      // The emails: three Marketing recipients — an administrator's address
      // (first, so the preview below renders HER email), the organiser's own,
      // and an address no account holds.
      const adm = await person("othadm", { first: "Ada" });
      expect((await sa.post(`/api/admin/participants/${adm.id}/role`, { role: "admin" }, await sa.h())).ok).toBeTruthy();
      const outside = `outside-${stamp()}@corp.example`;
      for (const [name, email] of [["Ada", adm.email], ["Ora", org.email], ["Out", outside]]) {
        const r = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "marketing", name, email }, await sa.h());
        expect(r.ok, r.text).toBeTruthy();
      }
      // The organiser's preview never shows more than the organiser may see,
      // whoever's email it renders.
      const pv = await oc.get(`/api/admin/competitions/${comp.id}/team-report/preview?persona=marketing`);
      expect(pv.ok, pv.text).toBeTruthy();
      expect(pv.body.to_role, "PRECONDITION: the preview renders a Marketing email").toBeTruthy();
      expect(pv.text, "the organiser's preview of the administrator's email withholds it").not.toContain(NAME);
      const before = smtp.messages.length;
      const send = await sa.post(`/api/admin/competitions/${comp.id}/team-report/send`, { persona: "marketing" }, await sa.h());
      expect(send.ok, send.text).toBeTruthy();
      for (const email of [org.email, adm.email, outside]) await expect.poll(() => mailsTo(email, before).length, { timeout: 10000 }).toBe(1);
      const fileOf = (email) => csvPart(mailsTo(email, before)[0]) || "";
      for (const email of [org.email, adm.email, outside]) expect(fileOf(email), `PRECONDITION: ${email}'s file lists the lead`).toContain(lead.email);
      expect(fileOf(org.email), "the organiser's account opens only the Booth Event").not.toContain(NAME);
      expect(fileOf(outside), "an address no account holds is told of this event only").not.toContain(NAME);
      expect(fileOf(adm.email), "CONTROL: an administrator's account opens every event").toContain(NAME);
      for (const email of [org.email, outside]) {
        const m = mailsTo(email, before)[0];
        expect(htmlPart(m) + textPart(m), `${email}'s mail body withholds it too`).not.toContain(NAME);
      }
      const am = mailsTo(adm.email, before)[0];
      expect(textPart(am), "CONTROL: the administrator's body names it, under Top hot leads").toContain(`Also: ${NAME}`);

      // The managers' preview compares with the last ended events of the same
      // type the READER may open, as the managers' view does: an ended Booth
      // Event the organiser does not run is averaged for the superadmin only.
      // (A peer started before this event: an hour ago, still live, then ended.)
      const peerEv = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 0, startAgoMs: 60 * 60_000 });
      expect((await sa.post(`/api/admin/competitions/${peerEv.comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
      expect((await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "marketing_manager", name: "Max", email: `max-${stamp()}@corp.example` }, await sa.h())).ok).toBeTruthy();
      const leadsRow = (text) => (String(text).split("\n").find(l => l.startsWith("Measure: Leads")) || "");
      const saMgr = await sa.get(`/api/admin/competitions/${comp.id}/team-report/preview?persona=manager`);
      expect(saMgr.ok, saMgr.text).toBeTruthy();
      expect(leadsRow(saMgr.body.text), "CONTROL: the superadmin's preview averages the ended Booth Event").toMatch(/Last [1-3] avg: \d/);
      const eaMgr = await oc.get(`/api/admin/competitions/${comp.id}/team-report/preview?persona=manager`);
      expect(eaMgr.ok, eaMgr.text).toBeTruthy();
      expect(leadsRow(eaMgr.body.text), "the organiser runs no ended Booth Event, so there is nothing to average").toContain("Last 3 avg: —");
      expect((await oc.get(`/api/admin/competitions/${comp.id}/team-report?peer=1`)).body.peer, "the managers' view agrees").toBeNull();
    } finally {
      const r = await sa.put("/api/admin/team-report-domains", { domains: [] }, await sa.h());
      expect.soft(r.ok, `the domain list back to its default: ${r.text}`).toBeTruthy();
    }
  });
});

// EACH MANAGER'S COMPARISON IS THEIR APPOINTER'S (sweep #80). An organiser scoped
// to their events who puts an address on the team (their own, an alias, anyone's)
// must not be mailed the figures of events they cannot see, as their in-app view
// and preview never show them. So in every send, Send now and the automatic ones
// alike, a manager's "last 3" covers only the events whoever added them may open
// now, and, when the manager's own address is an account scoped to its events,
// only those (lib/team-reports.js managerPeerScope). The figures of the ended
// Booth Event the organiser does not run are the witness.
test.describe("a manager's comparison covers only the events their appointer may open", () => {
  test("in Send now (pressed by a superadmin) and in the wrap-up, the organiser's appointee and the organiser's own account are compared with the organiser's events alone; a superadmin's or an administrator's appointee with all (CONTROLS)", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example", "company.co"] }, await sa.h())).ok).toBeTruthy();
    try {
      // Two ended Booth Events started before the reported one: one another
      // organiser runs (one lead), one this organiser runs (two leads). An average
      // of one event is its figure, so each manager's row says which they got.
      const peerEv = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 0, startAgoMs: 60 * 60_000 });
      await assign(sa, peerEv.comp.id, [await person("peerother", { company: "Other Co" })]);
      expect((await sa.post(`/api/admin/competitions/${peerEv.comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
      const orgEv = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 0, startAgoMs: 90 * 60_000 });
      await assign(sa, orgEv.comp.id, [await person("peerown1", { company: "Own Co" }), await person("peerown2", { company: "Own Co" })]);
      expect((await sa.post(`/api/admin/competitions/${orgEv.comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
      const { comp } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 1 });
      await assign(sa, comp.id, [await person("peerlead", { company: "Peer Co" })]);
      // An event admin of the reported event and of their own ended one.
      const org = await person("peerorg", { first: "Ora" });
      for (const id of [comp.id, orgEv.comp.id]) expect((await sa.post(`/api/admin/competitions/${id}/admins`, { userId: org.id }, await sa.h())).ok).toBeTruthy();
      const oc = client();
      expect((await codeSignIn(oc, org.email)).body.ok, "the organiser signs in").toBe(true);
      // A user-backed global administrator.
      const gadm = await person("peeradmin", { first: "Gia" });
      expect((await sa.post(`/api/admin/participants/${gadm.id}/role`, { role: "admin" }, await sa.h())).ok).toBeTruthy();
      const gc = client();
      expect((await codeSignIn(gc, gadm.email)).body.ok, "the administrator signs in").toBe(true);
      const ownAddr = `peer-own-${stamp()}@corp.example`, saAddr = `peer-sa-${stamp()}@corp.example`, gAddr = `peer-ga-${stamp()}@corp.example`;
      const add = async (c, name, email) => {
        const r = await c.post(`/api/admin/competitions/${comp.id}/team`, { role: "marketing_manager", name, email }, await c.h());
        expect(r.ok, `add ${name}: ${r.text}`).toBeTruthy();
      };
      await add(oc, "Own", ownAddr);          // the organiser's appointee (any address)
      await add(sa, "Ora", org.email);        // the superadmin appoints the organiser's own account
      await add(sa, "Sam", saAddr);           // CONTROL: the superadmin's appointee
      await add(gc, "Gil", gAddr);            // CONTROL: a global administrator's appointee
      const leadsRow = (m) => (textPart(m).split("\n").find(l => l.startsWith("Measure: Leads")) || "");
      const mgr = (addr, since) => mailsTo(addr, since).find(m => /Measure: Leads/.test(textPart(m)));
      const expectRows = async (since, what) => {
        await expect.poll(() => [ownAddr, org.email, saAddr, gAddr].map(a => !!mgr(a, since)), { timeout: 15000, message: `${what}: every manager is mailed` }).toEqual([true, true, true, true]);
        expect(leadsRow(mgr(ownAddr, since)), `${what}: the organiser's appointee is compared with the organiser's own event alone`).toMatch(/Last 1 avg: 2\.0/);
        expect(leadsRow(mgr(org.email, since)), `${what}: so is the organiser's own account, whoever appointed it`).toMatch(/Last 1 avg: 2\.0/);
        expect(leadsRow(mgr(saAddr, since)), `${what}: CONTROL: the superadmin's appointee averages both ended events, and more`).toMatch(/Last [23] avg: \d/);
        expect(leadsRow(mgr(gAddr, since)), `${what}: CONTROL: so does a global administrator's`).toMatch(/Last [23] avg: \d/);
      };
      // Send now, pressed by the SUPERADMIN: the rule is the appointer's, not the presser's.
      let since = smtp.messages.length;
      expect((await sa.post(`/api/admin/competitions/${comp.id}/team-report/send`, {}, await sa.h())).ok).toBeTruthy();
      await expectRows(since, "Send now");
      // The wrap-up, which nobody presses.
      expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
      sql(db => db.prepare("UPDATE team_report_jobs SET due_at=? WHERE competition_id=? AND kind='wrapup'").run(new Date(0).toISOString(), comp.id));
      since = smtp.messages.length;
      await tick(sa, false);
      await expectRows(since, "the wrap-up");
    } finally {
      const r = await sa.put("/api/admin/team-report-domains", { domains: [] }, await sa.h());
      expect.soft(r.ok, `the domain list back to its default: ${r.text}`).toBeTruthy();
    }
  });
});

test.describe("a challenge import's overwrite completes Program learners as the challenge doors do", () => {
  test("an overwrite that hides a challenge queues the certificate of the learner it completed, and nobody else's", async () => {
    const sa = await admin();
    const { comp, taskIds } = await makeEvent(sa, { kind: "program", tasks: 2 });
    const done = await person("impdone");
    const idle = await person("impidle");
    await assign(sa, comp.id, [done, idle]);
    await enter(done, comp.id);
    expect((await submit(done, comp.id, taskIds[0], "right0")).body.correct).toBe(true);
    const jobs = () => sql(db => db.prepare("SELECT user_id, reason FROM certificate_dispatch_jobs WHERE competition_id=?").all(comp.id));
    expect(jobs(), "PRECONDITION: one of two solved, nothing queued").toEqual([]);
    const title = sql(db => db.prepare("SELECT title FROM tasks WHERE id=?").get(taskIds[1]).title);
    const out = await importOverwrite(sa, { ...(await exportedRow(sa, title)), active: 0 });
    expect(out.overwritten, JSON.stringify(out)).toBe(1);
    expect(jobs().map(j => [j.user_id, j.reason]), "the learner the overwrite completed is queued").toEqual([[done.id, "completed"]]);
  });
});

// ── A "NO" TO THE FOLLOW-UP QUESTION, AND THE JOIN CARD THAT SAYS SO ─────────
// Operator ruling, 17 Nov 2026: someone who answers No to "Would you like
// someone to follow up with you?" is left out of every lead list (lib/event-team.js
// `followUpDeclined`: never in `data.leads`), while still counted as having
// joined; and where people join an event whose report team receives their
// details, the card says so (the token preview's `shares_leads`).
test.describe("a 'No' to the follow-up question", () => {
  let sa, comp, bare, q, yes, no;
  const tokenOf = (id) => sql(db => db.prepare("SELECT self_enroll_token AS t FROM competitions WHERE id=?").get(id).t);
  const preview = async (id) => {
    const r = await client().get(`/api/competitions/self-enroll/${tokenOf(id)}`);
    expect(r.ok, r.text).toBeTruthy();
    return r.body;
  };
  test.beforeAll(async () => {
    sa = await admin();
    // Team members' addresses must be on the allowed list (this describe may run alone).
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    ({ comp } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 1 }));
    ({ comp: bare } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 0 }));
    q = qTasks(comp.id);
    yes = await person("fuyes", { company: "Yes Co" });
    no = await person("funo", { company: "Nope Co" });
    await assign(sa, comp.id, [yes, no]);
    for (const p of [yes, no]) await enter(p, comp.id);
    await answerQ(yes, comp.id, q, "follow_up", 0);
    await answerQ(no, comp.id, q, "follow_up", 1);
  });

  test("the join preview says whether the event has a report team", async () => {
    expect((await preview(comp.id)).shares_leads, "no team yet: nothing to tell").toBe(false);
    for (const [role, name] of [["marketing", "Fay"], ["sdr", "Fen"]]) {
      const r = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role, name, email: `${name.toLowerCase()}-${stamp()}@corp.example` }, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
    }
    expect((await preview(comp.id)).shares_leads, "with a team: the card says so").toBe(true);
    expect((await preview(bare.id)).shares_leads, "an event with no team still says nothing").toBe(false);
  });

  test("the join card shows the notice only where a team receives the details", async ({ page }) => {
    await page.goto(`${BASE}/join/${tokenOf(comp.id)}`);
    await expect(page.locator("#join-banner-info"), "the card names the event").toHaveText(comp.name);
    await expect(page.locator("#join-banner-leads")).toBeVisible();
    await expect(page.locator("#join-banner-leads")).toContainText("Answer No to");
    await page.goto(`${BASE}/join/${tokenOf(bare.id)}`);
    await expect(page.locator("#join-banner-info"), "CONTROL: the other card rendered").toHaveText(bare.name);
    await expect(page.locator("#join-banner-leads"), "…with no notice").toBeHidden();
  });

  test("they are out of the lead list, the accounts, the CRM file and the SDR's cards, and still counted as joined", async () => {
    const rep = await report(sa, comp.id);
    const ids = rep.leads.map(l => l.user_id);
    expect(ids, "the Yes is a lead").toContain(yes.id);
    expect(ids, "the No is not").not.toContain(no.id);
    expect(rep.accounts.map(a => a.company), "nor is their company an account").not.toContain("Nope Co");
    expect(rep.summary, "joined counts everyone; leads only the Yes").toMatchObject({ joined: 2, leads: 1, declined: 1 });
    const fu = rep.summary.breakdown.find(b => b.key === "follow_up");
    expect(fu.counts.map(c => c.n), "the follow-up answers count everyone").toEqual([1, 1]);
    const csv = await sa.get(`/api/admin/competitions/${comp.id}/team-report/leads.csv`);
    expect(csv.ok, csv.text).toBeTruthy();
    expect(csv.text, "the CRM file holds the Yes").toContain(yes.email);
    expect(csv.text, "…not the No").not.toContain(no.email);
    const sdr = await sa.get(`/api/admin/competitions/${comp.id}/team-report/preview?persona=sdr`);
    expect(sdr.ok, sdr.text).toBeTruthy();
    expect(sdr.body.text, "the SDR's cards hold the Yes").toContain(yes.email);
    expect(sdr.body.text, "…not the No").not.toContain(no.email);
    const mk = await sa.get(`/api/admin/competitions/${comp.id}/team-report/preview?persona=marketing`);
    expect(mk.ok, mk.text).toBeTruthy();
    expect(mk.body.text, "Marketing is told why someone is missing").toContain("1 person answered No to a follow-up and is left out.");
  });

  test("CONTROL: changing the answer to Yes makes them a lead again", async () => {
    await answerQ(no, comp.id, q, "follow_up", 0);
    const rep = await report(sa, comp.id);
    expect(rep.leads.map(l => l.user_id), "their latest answer counts").toContain(no.id);
    expect(rep.summary).toMatchObject({ joined: 2, leads: 2, declined: 0 });
  });
});

// ── AN ENDED EVENT WHOSE END IS MOVED KEEPS ITS WRAP-UP (operator ruling, 17 Nov 2026) ──
// The wrap-up job is keyed on the end it was queued for; a superadmin's PUT moving
// an ended event's end to another past time used to leave it keyed on the old end,
// so its pass dropped it as stale and the team never heard.
test.describe("moving an ended event's end", () => {
  test("re-queues the wrap-up for the new end, and the wrap-up goes out", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp } = await makeEvent(sa, { kind: "tournament", startAgoMs: 3 * 3600e3, minutes: 600, tasks: 0 });
    const m = await sa.post(`/api/admin/competitions/${comp.id}/team`, { role: "marketing", name: "Moe", email: `moe-${stamp()}@corp.example` }, await sa.h());
    expect(m.ok, m.text).toBeTruthy();
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    const job = () => sql(db => db.prepare("SELECT kind, end_key FROM team_report_jobs WHERE competition_id=?").all(comp.id));
    const before = job();
    expect(before.map(j => j.kind), "PRECONDITION: the end queued a wrap-up").toEqual(["wrapup"]);
    const put = await sa.put(`/api/admin/competitions/${comp.id}`, { duration_minutes: 60 }, await sa.h());
    expect(put.ok, put.text).toBeTruthy();
    const newEnd = put.body.competition.effective_end;
    expect(put.body.competition.status, "PRECONDITION: still ended").toBe("ended");
    expect(newEnd, "PRECONDITION: the end moved").not.toBe(before[0].end_key);
    expect(job(), "the wrap-up is queued for the new end").toEqual([{ kind: "wrapup", end_key: newEnd }]);
    await tick(sa);
    const runs = sql(db => db.prepare("SELECT kind, end_key FROM team_report_runs WHERE competition_id=?").all(comp.id));
    expect(runs, "the wrap-up went out for the new end").toEqual([{ kind: "wrapup", end_key: newEnd }]);
  });
});

// The report ranks on the boards the event ranks on (operator ruling, 17 Nov 2026,
// "Rank per session"): lib/leaderboard.js `rankedBoards`, the boards its
// certificates are placed on. A per_slot event with two sessions gets a podium
// per session and each lead's place in their own session; its global-mode twin,
// the same people and solves, keeps one event-wide podium (the rule follows the
// event's own ranking, not the mere presence of sessions).
test.describe("the report ranks each session on its own, as the certificates do", () => {
  const preview = async (sa, compId, persona) => {
    const r = await sa.get(`/api/admin/competitions/${compId}/team-report/preview?persona=${persona}`);
    expect(r.ok, r.text).toBeTruthy();
    return r.body;
  };
  const addTeam = async (sa, compId, rows) => {
    for (const [role, name] of rows) {
      const r = await sa.post(`/api/admin/competitions/${compId}/team`, { role, name, email: `${name.toLowerCase()}-${stamp()}@corp.example` }, await sa.h());
      expect(r.ok, r.text).toBeTruthy();
    }
  };
  const session = async (sa, compId, name, agoMs) => {
    const r = await sa.post(`/api/admin/competitions/${compId}/timeslots`, { name, start_time: new Date(Date.now() - agoMs).toISOString(), duration_minutes: 600 }, await sa.h());
    expect(r.ok, r.text).toBeTruthy();
    expect(r.body.timeslot.status, "PRECONDITION: the session is live").toBe("live");
    return r.body.timeslot.id;
  };
  const pickSession = async (p, compId, timeslotId) => {
    await enter(p, compId);
    const r = await p.c.post("/api/select-timeslot", { timeslotId, confirmLive: true }, await p.c.h());
    expect(r.ok && r.body.ok, `select-timeslot: ${r.text}`).toBeTruthy();
  };
  // Two sessions, four people: Morning m1 solves 3 and m2 2; Evening e1 solves 1
  // and e2 answers once, wrongly (on the board at -5, never on a podium). A fourth
  // challenge stays unsolved, so nothing auto-ends (fixture checklist item 1).
  const twoSessionEvent = async (sa, mode) => {
    const { comp, taskIds } = await makeEvent(sa, { kind: "tournament", minutes: 600, tasks: 4, extra: { leaderboard_mode: mode } });
    expect(sql(db => db.prepare("SELECT leaderboard_mode FROM competitions WHERE id=?").get(comp.id).leaderboard_mode), "PRECONDITION").toBe(mode);
    await addTeam(sa, comp.id, [["se", "Sana"], ["sdr", "Sid"]]);
    const morning = `Morning ${stamp()}`, evening = `Evening ${stamp()}`;
    const mId = await session(sa, comp.id, morning, 120_000);
    const eId = await session(sa, comp.id, evening, 60_000);
    const ps = { m1: await person("rpm1"), m2: await person("rpm2"), e1: await person("rpe1"), e2: await person("rpe2") };
    await assign(sa, comp.id, Object.values(ps));
    for (const [k, p] of Object.entries(ps)) await pickSession(p, comp.id, k.startsWith("m") ? mId : eId);
    const solve = async (p, n) => { for (let i = 0; i < n; i++) expect((await submit(p, comp.id, taskIds[i], `right${i}`)).body.correct).toBe(true); };
    await solve(ps.m1, 3); await solve(ps.m2, 2); await solve(ps.e1, 1);
    expect((await submit(ps.e2, comp.id, taskIds[0], "wrong")).body.correct).toBe(false);
    const name = (p) => sql(db => db.prepare("SELECT first_name || ' ' || last_name AS n FROM users WHERE id=?").get(p.id).n);
    return { comp, ps, morning, evening, name };
  };
  const places = (g) => g.places.map(x => [x.rank, x.name, x.score]);

  test("per session: a podium for each session, and each lead's place in their own session", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp, ps, morning, evening, name } = await twoSessionEvent(sa, "per_slot");
    const rep = (await sa.get(`/api/admin/competitions/${comp.id}/team-report`)).body;
    expect(rep.podium.map(g => [g.session, g.late, places(g)])).toEqual([
      [morning, false, [[1, name(ps.m1), 150], [2, name(ps.m2), 100]]],
      [evening, false, [[1, name(ps.e1), 50]]],
    ]);
    const lead = (p) => rep.leads.find(l => l.user_id === p.id);
    expect([lead(ps.e1).rank, lead(ps.e1).rank_session, lead(ps.e1).rank_late]).toEqual([1, evening, false]);
    expect([lead(ps.m2).rank, lead(ps.m2).rank_session]).toEqual([2, morning]);
    expect([lead(ps.e2).rank, lead(ps.e2).rank_session], "on their session's board, off the podium").toEqual([2, evening]);
    const se = await preview(sa, comp.id, "se");
    expect(se.text).toContain(`Podium, ${morning}: 1. ${name(ps.m1)}`);
    expect(se.text).toContain(`Podium, ${evening}: 1. ${name(ps.e1)}`);
    expect(se.text, "no event-wide podium").not.toContain("Podium:");
    const sdr = await preview(sa, comp.id, "sdr");
    expect(sdr.text).toContain(`ranked 1 in ${evening}`);
    expect(sdr.text).toContain(`ranked 2 in ${morning}`);
  });

  test("CONTROL: the same sessions ranked together keep one event-wide podium", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp, ps, name } = await twoSessionEvent(sa, "global");
    const rep = (await sa.get(`/api/admin/competitions/${comp.id}/team-report`)).body;
    expect(rep.podium.map(g => [g.session, g.late, places(g)])).toEqual([
      [null, false, [[1, name(ps.m1), 150], [2, name(ps.m2), 100], [3, name(ps.e1), 50]]],
    ]);
    const e1 = rep.leads.find(l => l.user_id === ps.e1.id);
    expect([e1.rank, e1.rank_session]).toEqual([3, null]);
    const se = await preview(sa, comp.id, "se");
    expect((se.text.match(/Podium:/g) || []).length).toBe(1);
    const sdr = await preview(sa, comp.id, "sdr");
    expect(sdr.text).toContain("ranked 3,");
    expect(sdr.text).not.toMatch(/ranked \d+ in /);
  });

  test("late entrants: their own board's place at once, their podium once late entries close", async () => {
    const sa = await admin();
    expect((await sa.put("/api/admin/team-report-domains", { domains: ["corp.example"] }, await sa.h())).ok).toBeTruthy();
    const { comp, taskIds } = await makeEvent(sa, { kind: "booth", minutes: 120, tasks: 1 });
    await addTeam(sa, comp.id, [["se", "Sela"], ["sdr", "Sidd"]]);
    const early = await person("rplate0");
    await assign(sa, comp.id, [early]);
    await enter(early, comp.id);
    expect((await submit(early, comp.id, taskIds[0], "right0")).body.correct).toBe(true);
    expect((await sa.post(`/api/admin/competitions/${comp.id}/end-now`, {}, await sa.h())).ok).toBeTruthy();
    const late = await person("rplate1");
    await assign(sa, comp.id, [late]);
    await enter(late, comp.id);
    expect((await submit(late, comp.id, taskIds[0], "right0")).body.correct).toBe(true);
    let rep = (await sa.get(`/api/admin/competitions/${comp.id}/team-report`)).body;
    const lateLead = () => rep.leads.find(l => l.user_id === late.id);
    expect([lateLead().rank, lateLead().rank_late, lateLead().rank_session], "ranked on the late entrants' board").toEqual([1, true, null]);
    expect(rep.podium.map(g => [g.session, g.late, g.places.map(x => x.rank)]), "the window is open: no late podium yet").toEqual([[null, false, [1]]]);
    expect((await preview(sa, comp.id, "sdr")).text).toContain("ranked 1 among late entrants");
    const close = await sa.post(`/api/admin/competitions/${comp.id}/late-entry/close`, {}, await sa.h());
    expect(close.ok, close.text).toBeTruthy();
    rep = (await sa.get(`/api/admin/competitions/${comp.id}/team-report`)).body;
    expect(rep.podium.map(g => [g.session, g.late, g.places.map(x => x.rank)])).toEqual([[null, false, [1]], [null, true, [1]]]);
    expect((await preview(sa, comp.id, "se")).text).toContain("Podium, late entrants: 1. ");
  });

  test("a session's name is organiser text: escaped in the email's HTML, raw in its text", () => {
    const M = require("../lib/team-report-mail");
    const data = {
      comp: { id: "0f0f0f0f-0000-4000-8000-000000000001", name: "Ev", event_kind: "tournament", status: "ended", start_time: "2026-11-01T00:00:00.000Z", effective_end: null, ranked: true },
      targets: { lead_target: null, hot_lead_target: null }, qualifying: [], leads: [], challenges: [], worst: null, declined: [],
      certificates: { issued: 0, delivered: 0, bounced: 0 },
      summary: { joined: 0, played: 0, played_pct: 0, leads: 0, hot: 0, warm: 0, cold: 0, avg_solve_rate: null, avg_rating: null },
      podium: [{ session: "<b>X</b>", late: false, places: [{ rank: 1, name: "Ann", company: "", score: 50 }] }],
    };
    const mail = M.renderMail("Plat", "Ev", { name: "Sana", email: "sana@corp.example", role: "se" }, M.seReport(data), "Solutions Engineer", { link: false });
    expect(mail.html).toContain("Podium, &lt;b&gt;X&lt;/b&gt;");
    expect(mail.html).not.toContain("<b>X</b>");
    expect(mail.text).toContain("Podium, <b>X</b>: 1. Ann");
  });
});

