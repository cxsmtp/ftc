// v8.12.6 — WHAT THE MAIL SAYS WHEN SOMEBODY IS ADDED THROUGH A LATE-ENTRY WINDOW.
//
// Three builders compose "you have been added to this event" mail: the assign
// door, group live-sync and the invitation. Each rendered the event's Starts / Ends
// pair — and for an event joined through its late-entry window BOTH are in the
// past, so the recipient read "you have been invited to participate" above two
// times that had already gone, with nothing saying they can still play or until
// when. All three now render ONE line (`lateEntryMailLine`, lib/competitions.js)
// naming the late-entry DEADLINE, in the recipient's own zone where it is known.
//
// A real capturing SMTP server is the only way to assert this: `email_sent`
// records the subject and not the body (the v7.26.0 / v7.29.0 reasoning). Bodies
// are quoted-printable, so they are DECODED before matching (the v8.3.6 rule —
// a soft line break can split "late entrant" and `=3D` hides every `=`), and a
// recipient is matched EXACTLY, never by substring.
//
// EVERY ARM HAS A LIVE CONTROL through the same door: the change must not reach an
// ordinary running event, whose mail still names its start and end.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PORT_BASE } = require("./helpers");
const { startSmtpCapture } = require("./smtp-capture");

// This spec binds a fixed SPAWNER_OFFSETS port; see guardFixedPortSpec (v8.8.19).
test.beforeEach(() => guardFixedPortSpec());

const MIN = 60_000;

/** Decode a quoted-printable message to UTF-8 text (soft breaks and =XX escapes). */
function unqp(raw) {
  const s = String(raw || "").replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-F]{2}$/i.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2;
    } else {
      const code = s.charCodeAt(i);
      if (code < 0x80) bytes.push(code);
      else for (const b of Buffer.from(s[i], "utf8")) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

test.describe("v8.12.6 — mail for an event joined through its late-entry window", () => {
  test.describe.configure({ mode: "serial" });

  let child, sink, dataDir, childOut = "";
  // Declared on its own line: the v7.16.2 helpers-import guard recognises a local
  // `let BASE`, and this BASE is the SPAWNED server's URL, not the shared helper.
  let BASE;

  class Client {
    constructor() { this.cookie = ""; this.csrf = ""; }
    async go(p, opts = {}) {
      const headers = {};
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      if (this.csrf) headers["x-csrf-token"] = this.csrf;
      if (this.cookie) headers["cookie"] = this.cookie;
      const r = await fetch(`${BASE}${p}`, {
        method: opts.method || "GET", headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      if (sc.length) this.cookie = sc.map(c => c.split(";")[0]).join("; ");
      let json = null; try { json = await r.json(); } catch (_) {}
      return { status: r.status, json };
    }
    async refreshCsrf() { this.csrf = (await this.go("/api/csrf-token")).json?.csrfToken; return this.csrf; }
  }

  let sa;
  const dbPath = () => path.join(dataDir, "hackathon.db");
  function withDb(fn) {
    const Database = require("better-sqlite3");
    const db = new Database(dbPath());
    try { return fn(db); } finally { db.close(); }
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    sink = await startSmtpCapture();
    const port = PORT_BASE + 197; // registry: 196 is the login-code origin-budget spec
    BASE = `http://localhost:${port}`;
    const spawnedAt = Date.now();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "late-mail-"));
    child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        PORT: String(port), BASE_URL: BASE, DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`,
        SMTP_HOST: "127.0.0.1", SMTP_PORT: String(sink.port), SMTP_ALLOW_PLAINTEXT: "1",
        RATE_LIMIT_DISABLED: "1",
        SUPERADMIN_PASSWORD_QUIET: "1", HSTS: "0", LOG_CONSOLE_MIRROR: "0",
        NODE_OPTIONS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", b => { childOut += b.toString(); });
    child.stderr.on("data", b => { childOut += b.toString(); });

    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try {
        const r = await fetch(`${BASE}/api/config`);
        if (r.status < 500) {
          // A POSITIVE identity check (v7.21.10): a leaked server on this port
          // answers /api/config too; only a boot stamp newer than our spawn is ours.
          const cfg = await r.json().catch(() => null);
          const bootMs = cfg?.server_started_at ? new Date(cfg.server_started_at).getTime() : 0;
          if (bootMs >= spawnedAt) up = true;
        }
      } catch (_) {}
      if (!up) { expect(child.exitCode, `server exited early:\n${childOut.slice(-1500)}`).toBeNull(); await sleep(500); }
    }
    expect(up, `no server with a boot stamp newer than our spawn ever answered — check for EADDRINUSE:\n${childOut.slice(-1500)}`).toBe(true);
    const pwPath = path.join(dataDir, ".superadmin-password");
    for (let i = 0; i < 100 && !fs.existsSync(pwPath); i++) await sleep(100);
    expect(fs.existsSync(pwPath), `the superadmin credential was never written:\n${childOut.slice(-1500)}`).toBe(true);
    const pass = fs.readFileSync(pwPath, "utf8").trim();
    sa = new Client();
    await sa.refreshCsrf();
    const li = await sa.go("/api/login", { method: "POST", body: { email: "superadmin", password: pass } });
    expect(li.status, `superadmin signs in: ${JSON.stringify(li.json)}`).toBe(200);
    await sa.refreshCsrf();
  });

  async function drainPort() {
    for (let i = 0; i < 60; i++) {
      try { await fetch(`${BASE}/api/config`); } catch (_) { return; }
      await sleep(100);
    }
  }

  test.afterAll(async () => {
    try { child?.kill("SIGKILL"); } catch (_) {}
    await drainPort();
    try { await sink?.close(); } catch (_) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  });

  let seq = 0;
  async function makeParticipant(tag, timezone) {
    const stamp = `${Date.now()}${++seq}`;
    const email = `lm-${tag}-${stamp}@company.co`;
    const c = new Client();
    await c.refreshCsrf();
    // EMAIL FIRST: registration needs a live address proof in the session. This
    // server runs without NODE_ENV=test (so `registerPost`'s /api/test hooks do
    // not exist), and the proof is read from the capturing relay instead: the
    // real request -> mailed code -> redeem doors, then the form.
    const rq = await c.go("/api/auth/code/request", { method: "POST", body: { email } });
    expect(rq.status, `code request ${tag}: ${JSON.stringify(rq.json)}`).toBe(200);
    const proofMail = await sink.waitFor((m) => (m.rcptTo || []).some(a => String(a).toLowerCase() === email.toLowerCase())
      && /Your sign-in code is/.test(unqp(m.raw)));
    const code = (unqp(proofMail.raw).match(/Your sign-in code is:[\s\S]*?([0-9A-Z]{4}-?[0-9A-Z]{4})/) || [])[1];
    expect(code, `${tag}: the proof mail carries a code`).toBeTruthy();
    const rd = await c.go("/api/auth/code/redeem", { method: "POST", body: { email, code } });
    expect(rd.json && rd.json.needsProfile, `redeem ${tag}: ${JSON.stringify(rd.json)}`).toBe(true);
    await c.refreshCsrf();   // the redeem regenerated the session
    const r = await c.go("/api/register", {
      method: "POST",
      body: {
        firstName: "L", lastName: tag, nickname: `lm_${tag}_${stamp}`,
        company: "C", title: "T", country: "US", timezone,
        // Explicit: the spawned server does NOT run with NODE_ENV=test, so the
        // test-mode defaults for these two do not apply.
        jobFunction: "Software Developer / Engineer", city: "Test City",
        email, password: "chosen-at-signup-1",
      },
    });
    expect(r.status, `register ${tag}: ${JSON.stringify(r.json)}`).toBeLessThan(400);
    return withDb(db => {
      const u = db.prepare("SELECT id FROM users WHERE email=?").get(email);
      db.prepare("UPDATE users SET verified=1, approved=1 WHERE id=?").run(u.id);
      return { id: u.id, email };
    });
  }

  /** A LIVE Booth Event; `expire` moves its end 30 minutes into the past. */
  async function makeBooth(name, { expire }) {
    const r = await sa.go("/api/admin/competitions", {
      method: "POST",
      body: { name, event_kind: "booth", start_time: new Date(Date.now() - 5 * MIN).toISOString(), duration_minutes: 180, timezone: "UTC" },
    });
    expect(r.status, `create ${name}: ${JSON.stringify(r.json)}`).toBeLessThan(400);
    const id = r.json.competition.id;
    if (!expire) return { id, name, end: null, deadline: null };
    const end = new Date(Date.now() - 30 * MIN);
    withDb(db => db.prepare("UPDATE competitions SET start_time=?, duration_minutes=60 WHERE id=?")
      .run(new Date(end.getTime() - 60 * MIN).toISOString(), id));
    await sleep(1_300); // the 1 s competition-row cache
    return { id, name, end, deadline: new Date(end.getTime() + 48 * 60 * MIN) };
  }

  // Exact recipient AND the event's own name in the decoded body: the recipient has
  // already been sent a verification mail by registering, which must not match.
  const mailTo = (email, eventName) => (m) =>
    (m.rcptTo || []).some(r => String(r).toLowerCase() === email.toLowerCase()) && unqp(m.raw).includes(eventName);

  /** The recipient's HH:MM for an instant, in their zone. */
  const hhmmIn = (d, tz) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

  function assertLateCopy(body, deadline, tz, what) {
    expect(body, `${what}: names the late entrant`).toContain("late entrant");
    expect(body, `${what}: names the deadline in the recipient's zone`).toContain(hhmmIn(deadline, tz));
    expect(body, `${what}: no past Starts/Ends pair`).not.toMatch(/Starts:/);
    expect(body, `${what}: no past Starts/Ends pair`).not.toMatch(/Ends:/);
  }

  test("E1 — the ASSIGNMENT mail names the late-entry deadline in the recipient's zone; a live event keeps Starts/Ends", async () => {
    sink.clear();
    const tz = "America/New_York";
    const open = await makeBooth(`LateMailA ${Date.now()}`, { expire: true });
    const p = await makeParticipant("assign", tz);
    const a = await sa.go("/api/admin/competitions/assign", { method: "POST", body: { competitionIds: [open.id], userIds: [p.id] } });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json.lateEntryCompetitionIds, "PRECONDITION: admitted through the window").toEqual([open.id]);
    const msg = await sink.waitFor(mailTo(p.email, open.name));
    expect(msg, "the assignment mail is delivered").toBeTruthy();
    const body = unqp(msg.raw);
    assertLateCopy(body, open.deadline, tz, "assignment");
    expect(body, "and names the zone it is in").toContain(`(${tz})`);

    // CONTROL — a live event through the same door.
    const live = await makeBooth(`LateMailALive ${Date.now()}`, { expire: false });
    const q = await makeParticipant("assignlive", tz);
    const b = await sa.go("/api/admin/competitions/assign", { method: "POST", body: { competitionIds: [live.id], userIds: [q.id] } });
    expect(b.status, JSON.stringify(b.json)).toBe(200);
    const liveMsg = await sink.waitFor(mailTo(q.email, live.name));
    const liveBody = unqp(liveMsg.raw);
    expect(liveBody, "a live event still names its start").toMatch(/Starts:/);
    expect(liveBody, "and its end").toMatch(/Ends:/);
    expect(liveBody, "and says nothing about late entry").not.toContain("late entrant");
  });

  test("E2 — the GROUP-SYNC mail says the same; a live bind keeps Starts/Ends", async () => {
    sink.clear();
    const tz = "Europe/Berlin";
    const open = await makeBooth(`LateMailG ${Date.now()}`, { expire: true });
    const p = await makeParticipant("group", tz);
    const g = await sa.go("/api/admin/groups", { method: "POST", body: { name: `LMG ${Date.now()}`, userIds: [p.id] } });
    expect(g.status, JSON.stringify(g.json)).toBe(200);
    const bind = await sa.go("/api/admin/competitions/assign", { method: "POST", body: { competitionIds: [open.id], groupIds: [g.json.group.id] } });
    expect(bind.status, JSON.stringify(bind.json)).toBe(200);
    const msg = await sink.waitFor(mailTo(p.email, open.name));
    expect(msg, "the group-sync mail is delivered").toBeTruthy();
    assertLateCopy(unqp(msg.raw), open.deadline, tz, "group sync");

    // CONTROL
    const live = await makeBooth(`LateMailGLive ${Date.now()}`, { expire: false });
    const q = await makeParticipant("grouplive", tz);
    const g2 = await sa.go("/api/admin/groups", { method: "POST", body: { name: `LMG2 ${Date.now()}`, userIds: [q.id] } });
    expect(g2.status).toBe(200);
    expect((await sa.go("/api/admin/competitions/assign", { method: "POST", body: { competitionIds: [live.id], groupIds: [g2.json.group.id] } })).status).toBe(200);
    const liveBody = unqp((await sink.waitFor(mailTo(q.email, live.name))).raw);
    expect(liveBody, "a live bind still names its start").toMatch(/Starts:/);
    expect(liveBody).not.toContain("late entrant");
  });

  // v8.12.6 (review) — "YOU CAN STILL TAKE PART AS A LATE ENTRANT" IS A CLAIM ABOUT
  // THE PERSON, and the assignment mail made it about the EVENT. A multi-event
  // assign mails everybody who got a new row ANYWHERE in the request and listed
  // EVERY requested event, so a late-window event reached two people for whom the
  // sentence is false: an ordinary member who was in it before it ended (the play
  // gate refuses them) and somebody the late door had just skipped because they
  // took part (they hold no row at all), both labelled "(already enrolled)".
  // The single-event arm above cannot see it — with one event, neither of them
  // gets a new row, so no mail is sent. TWO CONTROLS, one per branch the line may
  // still be rendered on: a brand-new late entrant, and a HELD late entrant.
  test("E4 — a multi-event assign promises late play only to the people who can play there", async () => {
    sink.clear();
    const tz = "Europe/London";
    const live = await makeBooth(`LateMailMLive ${Date.now()}`, { expire: false });
    // Built LIVE so the ordinary member can join it while it runs, then ended.
    const late = await makeBooth(`LateMailMLate ${Date.now()}`, { expire: false });
    const ord = await makeParticipant("mord", tz);    // in `late` before it ended
    const held = await makeParticipant("mheld", tz);  // a late entrant of `late` already
    const took = await makeParticipant("mtook", tz);  // took part in `late`, holds no row
    const fresh = await makeParticipant("mnew", tz);  // CONTROL: brand new
    const j = await sa.go("/api/admin/competitions/assign", { method: "POST", body: { competitionIds: [late.id], userIds: [ord.id] } });
    expect(j.status, JSON.stringify(j.json)).toBe(200);
    expect(j.json.assigned, "PRECONDITION: the ordinary member joined while it ran").toBe(1);

    // End it 30 minutes ago. THE FIXTURE TRAP: re-timing the event makes the join
    // above read as AFTER the end, so it is back-dated; `took` entered and was
    // taken out while it ran (an absence row whose anchor is before the end).
    const end = new Date(Date.now() - 30 * MIN);
    const iso = (ms) => new Date(end.getTime() + ms).toISOString();
    withDb(db => {
      db.prepare("UPDATE competitions SET start_time=?, duration_minutes=60 WHERE id=?").run(iso(-60 * MIN), late.id);
      expect(db.prepare("UPDATE competition_users SET assigned_at=? WHERE competition_id=? AND user_id=?")
        .run(iso(-50 * MIN), late.id, ord.id).changes, "the back-date landed").toBe(1);
      db.prepare("INSERT INTO competition_user_absences (user_id, competition_id, removed_at, login_time, assigned_at) VALUES (?,?,?,?,?)")
        .run(took.id, late.id, iso(-15 * MIN), iso(-20 * MIN), iso(-40 * MIN));
    });
    await sleep(1_300); // the 1 s competition-row cache
    const h = await sa.go("/api/admin/competitions/assign", { method: "POST", body: { competitionIds: [late.id], userIds: [held.id] } });
    expect(h.status, JSON.stringify(h.json)).toBe(200);
    expect(h.json.lateEntryCompetitionIds, "PRECONDITION: `late` is taking late entries, and `held` joined through it").toEqual([late.id]);
    expect(h.json.assigned).toBe(1);
    sink.clear(); // the two single-event mails above are not what this arm is about

    const a = await sa.go("/api/admin/competitions/assign", {
      method: "POST", body: { competitionIds: [live.id, late.id], userIds: [ord.id, held.id, took.id, fresh.id] },
    });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json.assigned, "four new rows in `live`, one in `late` (fresh)").toBe(5);
    expect(a.json.skippedTookPart, "PRECONDITION: `took` is skipped from `late`").toBe(1);
    expect(a.json.lateEntryCompetitionIds).toEqual([late.id]);
    const deadline = new Date(end.getTime() + 48 * 60 * MIN);
    const bodyOf = async (who) => unqp((await sink.waitFor(mailTo(who.email, live.name))).raw);

    // CONTROL 1 — a brand-new late entrant is told, with the deadline.
    const fb = await bodyOf(fresh);
    expect(fb, "the new late entrant's mail lists the late event").toContain(late.name);
    expect(fb, "…with the late-entry promise").toContain("take part as a late entrant");
    expect(fb, "…and its deadline, in their zone").toContain(hhmmIn(deadline, tz));
    expect(fb, "…beside the live event's start").toMatch(/Starts:/);
    // CONTROL 2 — somebody already a late entrant there can still play: listed, and told.
    const hb = await bodyOf(held);
    expect(hb, "a held late entrant's mail lists it").toContain(late.name);
    expect(hb).toContain("(already enrolled)");
    expect(hb, "…and truly can still take part").toContain("take part as a late entrant");

    // The ordinary member — the play gate refuses them there, so no promise, and
    // nothing to invite them to in a finished event.
    const ob = await bodyOf(ord);
    expect(ob, "the ordinary member's mail names the live event").toContain(live.name);
    expect(ob, "…and makes NO late-entry promise").not.toContain("late entrant");
    expect(ob, "…and does not list the finished event").not.toContain(late.name);
    // The took-part skip — holds no row, so is neither "enrolled" nor able to play.
    const tb = await bodyOf(took);
    expect(tb, "the skipped user's mail does not list the event that refused them").not.toContain(late.name);
    expect(tb).not.toContain("late entrant");
    expect(tb, "…nor call them enrolled anywhere they are not").not.toContain("already enrolled");
  });

  // The same rule for an event that has NOT ended: a staff member on an event
  // where staff do not compete is skipped (they enter without a row), and the
  // mail used to list that event as "(already enrolled)" too. CONTROL: the event
  // they did get a row in is listed.
  test("E5 — an event the request skipped somebody from is not listed as \"already enrolled\"", async () => {
    sink.clear();
    const tz = "UTC";
    const plain = await makeBooth(`LateMailSPlain ${Date.now()}`, { expire: false });
    const r = await sa.go("/api/admin/competitions", {
      method: "POST",
      body: { name: `LateMailSComp ${Date.now()}`, event_kind: "booth", staff_compete: true, start_time: new Date(Date.now() - 5 * MIN).toISOString(), duration_minutes: 180, timezone: "UTC" },
    });
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(400);
    const comp = r.json.competition;
    const staff = await makeParticipant("mstaff", tz);
    const tag = await sa.go(`/api/admin/participants/${staff.id}/tags`, { method: "POST", body: { tag: "staff" } });
    expect(tag.status, JSON.stringify(tag.json)).toBeLessThan(400);
    const a = await sa.go("/api/admin/competitions/assign", { method: "POST", body: { competitionIds: [comp.id, plain.id], userIds: [staff.id] } });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json.assigned, "PRECONDITION: a row on the event where staff compete").toBe(1);
    expect(a.json.skippedStaff, "PRECONDITION: skipped on the one where they do not").toBe(1);
    const body = unqp((await sink.waitFor(mailTo(staff.email, comp.name))).raw);
    expect(body, "the event they joined is listed").toContain(comp.name);
    expect(body, "the one they were skipped from is not").not.toContain(plain.name);
    expect(body).not.toContain("already enrolled");
  });

  test("E3 — the INVITATION mail says the same (no account yet, so the zone is UTC and says so); a live invitation keeps Starts/Ends", async () => {
    sink.clear();
    const open = await makeBooth(`LateMailI ${Date.now()}`, { expire: true });
    const addr = `lm-inv-${Date.now()}@company.co`;
    const inv = await sa.go("/api/admin/invitations", { method: "POST", body: { emails: [addr], competitionIds: [open.id] } });
    expect(inv.status, JSON.stringify(inv.json)).toBe(200);
    const msg = await sink.waitFor(mailTo(addr, open.name));
    expect(msg, "the invitation mail is delivered").toBeTruthy();
    const body = unqp(msg.raw);
    assertLateCopy(body, open.deadline, "UTC", "invitation");
    expect(body, "an invitee has no account, so the fallback names UTC").toContain("UTC");

    // CONTROL
    const live = await makeBooth(`LateMailILive ${Date.now()}`, { expire: false });
    const addr2 = `lm-inv-live-${Date.now()}@company.co`;
    expect((await sa.go("/api/admin/invitations", { method: "POST", body: { emails: [addr2], competitionIds: [live.id] } })).status).toBe(200);
    const liveBody = unqp((await sink.waitFor(mailTo(addr2, live.name))).raw);
    expect(liveBody, "a live invitation still names its start").toMatch(/Starts:/);
    expect(liveBody).not.toContain("late entrant");
  });
});
