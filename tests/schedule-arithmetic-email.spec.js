// v7.29.0 — the FIVE email-body schedule-arithmetic sites, which had no lock.
//
// `routes/participants.js:435` and `:442` (assignment mail, multi- and
// single-session), `lib/group-sync.js:288` and `:294` (group-sync mail, same two
// branches) and `routes/invitations.js:415` (invitation mail) each hand-roll
// `start_time + duration_minutes * 60000` and render it into a message body.
//
// Nothing asserted any of them. `user_events.email_sent` records `to`, `subject`,
// `reason` and `success` and deliberately NOT the body, so every other
// observation point in the suite can only see what we composed a subject for —
// which is why a real capturing SMTP server is the only way to assert what a
// participant would actually read. Same reasoning, and the same helper, as the
// v7.26.0 sender-name spec.
//
// Written BEFORE the PR 7 hoist on purpose: a lock added afterwards proves the
// new code agrees with itself, not that it agrees with what shipped.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PORT_BASE } = require("./helpers");
const { startSmtpCapture, decodeQuotedPrintable } = require("./smtp-capture");
const { stripJsComments } = require("./doc-registry");

// v8.8.19 — this spec binds a fixed SPAWNER_OFFSETS port; see guardFixedPortSpec.
test.beforeEach(() => guardFixedPortSpec());

// THE "Ends:" LINE OF EVERY MAIL ASKS ONE HELPER (operator ruling, 14 Nov 2026):
// lib/competitions.js eventEndMailText, which says "No fixed deadline" for an
// open-ended Program, whose stored deadline is a placeholder ten years out. A
// builder that formats the end itself prints that placeholder. Comments are
// stripped first; the floor is the three builders the behavioural arms below
// drive (the assignment, group-sync and invitation mails).
test("SOURCE: every mail's \"Ends:\" line prints eventEndMailText(…)", () => {
  const root = path.resolve(__dirname, "..");
  const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith(".js") ? [`${d}/${e.name}`] : []);
  const sites = [], bad = [];
  for (const f of ["server.js", ...walk("lib"), ...walk("routes")]) {
    const src = stripJsComments(fs.readFileSync(path.join(root, f), "utf8"));
    for (const m of src.matchAll(/\bEnds:\s*([^<\n]*)/g)) {
      sites.push(f);
      if (!/^\$\{eventEndMailText\(/.test(m[1])) bad.push(`${f}: Ends: ${m[1].slice(0, 90)}`);
    }
  }
  for (const f of ["routes/participants.js", "routes/invitations.js", "lib/group-sync.js"]) {
    expect(sites, `the ${f} builder is found (${JSON.stringify(sites)})`).toContain(f);
  }
  expect(bad, "every Ends: line prints eventEndMailText(…)").toEqual([]);
});

test.describe("v7.29.0 — the scheduled end an email actually shows", () => {
  test.describe.configure({ mode: "serial" });

  let child, sink, dataDir, childOut = "";
  // Declared on its own line deliberately: the v7.16.2 helpers-import guard
  // recognises a local `let BASE` but not a name buried in a multi-declarator
  // list, and this BASE is the SPAWNED server's URL, not the shared helper.
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
  const iso = (ms) => new Date(ms).toISOString();

  // What the body is expected to contain, derived independently of the server.
  // formatEmailDate renders in a timezone; rather than reimplement it, assert on
  // the DAY-OF-MONTH and the HH:MM of the UTC instant, with the fixture pinned to
  // a UTC-rendered recipient. A wrong multiplier moves the clock by orders of
  // magnitude, so this discriminates without duplicating the formatter.
  const hhmmUtc = (ms) => new Date(ms).toISOString().slice(11, 16);

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    sink = await startSmtpCapture();
    const port = PORT_BASE + 141; // registry: 140 is the login-code spec
    BASE = `http://localhost:${port}`;
    const spawnedAt = Date.now();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-mail-"));
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

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try {
        const r = await fetch(`${BASE}/api/config`);
        if (r.status < 500) {
          // v7.21.10 — a POSITIVE IDENTITY CHECK, not just a 200. A health probe
          // answers for whoever holds the port: a previous server on this port
          // (a leaked run, or the preceding --repeat-each pass, whose kill()
          // returns before the kernel releases the socket) answers /api/config
          // identically, so readiness would pass while OUR child died of
          // EADDRINUSE — surfacing later as a missing .superadmin-password.
          const cfg = await r.json().catch(() => null);
          const bootMs = cfg?.server_started_at ? new Date(cfg.server_started_at).getTime() : 0;
          if (bootMs >= spawnedAt) up = true;
        }
      } catch (_) {}
      if (!up) { expect(child.exitCode, `server exited early:\n${childOut.slice(-1500)}`).toBeNull(); await sleep(500); }
    }
    expect(up, `no server with a boot stamp newer than our spawn ever answered — check for EADDRINUSE:\n${childOut.slice(-1500)}`).toBe(true);

    // TWO independent readiness signals. The HTTP probe proves the socket is
    // accepting; it does not prove the boot side-effects have landed, and the
    // credential file is written from the listening handler rather than before
    // it. Polling for it is the difference between a clear failure and an ENOENT
    // that names nothing.
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

  // kill() returns before the kernel releases the socket, so a subsequent spawn on
  // this port dies of EADDRINUSE — which under --repeat-each is the very next
  // pass. Wait for the port to stop answering rather than hoping.
  async function drainPort() {
    for (let i = 0; i < 60; i++) {
      try { await fetch(`${BASE}/api/config`); } catch (_) { return; }
      await new Promise(r => setTimeout(r, 100));
    }
  }

  test.afterAll(async () => {
    try { child?.kill("SIGKILL"); } catch (_) {}
    await drainPort();
    try { await sink?.close(); } catch (_) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  });

  async function makeParticipant(tag) {
    const stamp = `${Date.now()}${Math.floor(process.hrtime()[1] / 1000)}`;
    const email = `sm-${tag}-${stamp}@company.co`;
    const c = new Client();
    await c.refreshCsrf();
    // Email first: the entry screen mails a new work address a proof; redeeming
    // it grants this session the sign-up. No NODE_ENV=test here, so the code is
    // read off the captured mail.
    const CODE_RE = /\b([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})\b/;
    const since = sink.messages.length;
    const rq = await c.go("/api/auth/code/request", { method: "POST", body: { email } });
    expect(rq.status, `code request ${tag}`).toBe(200);
    // Body only: the Message-ID header (`<8hex-4hex-4hex-4hex-12hex@…>`) can
    // carry two all-digit 4-hex groups that CODE_RE would take for the code.
    const bodyOf = (m) => { const raw = m.raw || ""; const i = raw.indexOf("\r\n\r\n"); return raw.slice(i >= 0 ? i : Math.max(0, raw.indexOf("\n\n"))); };
    const proofMail = await sink.waitFor(m => sink.messages.indexOf(m) >= since && (m.rcptTo || []).includes(email) && CODE_RE.test(bodyOf(m)));
    const proof = (bodyOf(proofMail).match(CODE_RE) || [])[1];
    const pr = await c.go("/api/auth/code/redeem", { method: "POST", body: { email, code: proof } });
    expect(pr.json && pr.json.needsProfile, `the proof grants the sign-up: ${JSON.stringify(pr.json)}`).toBe(true);
    await c.refreshCsrf();   // the redeem regenerated the session
    const r = await c.go("/api/register", {
      method: "POST",
      body: {
        firstName: "S", lastName: tag, nickname: `sm_${tag}_${stamp}`,
        company: "C", title: "T", country: "US", timezone: "UTC",
        // Supplied explicitly: the spawned server deliberately does NOT run with
        // NODE_ENV=test (production forces a Secure cookie, which express-session
        // refuses over plain HTTP), so the test-mode defaults for these two do
        // not apply here.
        jobFunction: "Software Developer / Engineer", city: "Test City",
        email, password: "chosen-at-signup-1",
      },
    });
    expect(r.status, `register ${tag}: ${JSON.stringify(r.json)}`).toBeLessThan(400);
    const Database = require("better-sqlite3");
    const db = new Database(path.join(dataDir, "hackathon.db"));
    try {
      const u = db.prepare("SELECT id FROM users WHERE email=?").get(email);
      db.prepare("UPDATE users SET verified=1, approved=1 WHERE id=?").run(u.id);
      return { id: u.id, email };
    } finally { db.close(); }
  }

  async function makeComp(name, startMs, minutes) {
    const r = await sa.go("/api/admin/competitions", {
      method: "POST",
      body: { name, start_time: iso(startMs), duration_minutes: minutes, timezone: "UTC" },
    });
    expect(r.status, `create ${name}: ${JSON.stringify(r.json)}`).toBeLessThan(400);
    return r.json.competition.id;
  }

  // routes/participants.js:442 — the SINGLE-session branch of the assignment mail.
  test("the assignment email shows a single-session competition's real end", async () => {
    sink.clear();
    const stamp = Date.now();
    // Deliberately not a round hour: a minutes/seconds or *60 vs *60000 slip
    // cannot coincidentally land on the right clock time.
    const startMs = Date.UTC(2031, 4, 14, 9, 5, 0);
    const minutes = 95; // ends 10:40 UTC
    const compId = await makeComp(`MailSingle ${stamp}`, startMs, minutes);
    const p = await makeParticipant("single");

    const asg = await sa.go("/api/admin/competitions/assign", {
      method: "POST", body: { competitionIds: [compId], userIds: [p.id] },
    });
    expect(asg.status, `assign: ${JSON.stringify(asg.json)}`).toBeLessThan(400);

    const msg = await sink.waitFor(m => (m.raw || "").includes(p.email) && /Ends:/i.test(m.raw || ""));
    expect(msg, "the assignment mail is delivered").toBeTruthy();
    expect(msg.raw, "the END clock time is start + duration, not start + duration seconds")
      .toContain(hhmmUtc(startMs + minutes * 60_000));
  });

  // routes/participants.js:435 — the MULTI-session branch. A separate expression
  // over timeslot rows, so the single-session lock cannot stand in for it.
  test("the assignment email shows each session's real end", async () => {
    sink.clear();
    const stamp = Date.now();
    const compId = await makeComp(`MailMulti ${stamp}`, Date.UTC(2031, 5, 1, 8, 0, 0), 600);
    const slotStart = Date.UTC(2031, 5, 1, 13, 20, 0);
    const slotMinutes = 35; // ends 13:55 UTC
    const ts = await sa.go(`/api/admin/competitions/${compId}/timeslots`, {
      method: "POST",
      body: { name: `Sess ${stamp}`, start_time: iso(slotStart), duration_minutes: slotMinutes, timezone: "UTC" },
    });
    expect(ts.status, `slot: ${JSON.stringify(ts.json)}`).toBeLessThan(400);

    const p = await makeParticipant("multi");
    const asg = await sa.go("/api/admin/competitions/assign", {
      method: "POST", body: { competitionIds: [compId], userIds: [p.id] },
    });
    expect(asg.status, `assign: ${JSON.stringify(asg.json)}`).toBeLessThan(400);

    const msg = await sink.waitFor(m => (m.raw || "").includes(p.email) && /Sess /.test(m.raw || ""));
    expect(msg, "the assignment mail is delivered").toBeTruthy();
    expect(msg.raw, "the SESSION end clock time is its own start + its own duration")
      .toContain(hhmmUtc(slotStart + slotMinutes * 60_000));
  });

  // routes/invitations.js:415 — the invitation mail.
  test("the invitation email shows the competition's real end", async () => {
    sink.clear();
    const stamp = Date.now();
    const startMs = Date.UTC(2031, 6, 3, 11, 10, 0);
    const minutes = 145; // ends 13:35 UTC
    const compId = await makeComp(`MailInvite ${stamp}`, startMs, minutes);
    const email = `sm-inv-${stamp}@company.co`;

    const inv = await sa.go("/api/admin/invitations", {
      method: "POST", body: { emails: [email], competitionIds: [compId] },
    });
    expect(inv.status, `invite: ${JSON.stringify(inv.json)}`).toBeLessThan(400);

    const msg = await sink.waitFor(m => (m.raw || "").includes(email));
    expect(msg, "the invitation mail is delivered").toBeTruthy();
    expect(msg.raw, "the END clock time is start + duration")
      .toContain(hhmmUtc(startMs + minutes * 60_000));
  });

  // lib/group-sync.js:294 and :288 — the group-sync mail, both branches.
  //
  // Fired when a group BOUND to a competition gains a member. A separate module
  // from the assignment mail with its own copy of the same arithmetic, so neither
  // of the assignment locks stands in for it. One group bound to a single-session
  // AND a multi-session competition exercises both branches from one add.
  test("the group-sync email shows real ends for both single- and multi-session competitions", async () => {
    sink.clear();
    const stamp = Date.now();

    const singleStart = Date.UTC(2031, 7, 9, 7, 45, 0);
    const singleMinutes = 115; // ends 09:40 UTC
    const singleId = await makeComp(`GsSingle ${stamp}`, singleStart, singleMinutes);

    const multiId = await makeComp(`GsMulti ${stamp}`, Date.UTC(2031, 7, 10, 8, 0, 0), 600);
    const slotStart = Date.UTC(2031, 7, 10, 15, 25, 0);
    const slotMinutes = 50; // ends 16:15 UTC
    const ts = await sa.go(`/api/admin/competitions/${multiId}/timeslots`, {
      method: "POST",
      body: { name: `GsSess ${stamp}`, start_time: iso(slotStart), duration_minutes: slotMinutes, timezone: "UTC" },
    });
    expect(ts.status, `slot: ${JSON.stringify(ts.json)}`).toBeLessThan(400);

    const g = await sa.go("/api/admin/groups", { method: "POST", body: { name: `GsGroup ${stamp}` } });
    expect(g.status, `group: ${JSON.stringify(g.json)}`).toBeLessThan(400);
    const groupId = g.json.group?.id || g.json.id;
    expect(groupId, "the group id is in the create response").toBeTruthy();

    // Bind the group to BOTH competitions, then add the member — so the add is
    // what triggers the mail, which is the path under test.
    const bind = await sa.go("/api/admin/competitions/assign", {
      method: "POST", body: { competitionIds: [singleId, multiId], userIds: [], groupIds: [groupId] },
    });
    expect(bind.status, `bind: ${JSON.stringify(bind.json)}`).toBeLessThan(400);

    const p = await makeParticipant("gsync");
    const add = await sa.go(`/api/admin/groups/${groupId}/members`, {
      method: "POST", body: { userIds: [p.id] },
    });
    expect(add.status, `add member: ${JSON.stringify(add.json)}`).toBeLessThan(400);

    const single = await sink.waitFor(m => (m.raw || "").includes(p.email) && (m.raw || "").includes("GsSingle"));
    expect(single, "the single-session group-sync mail is delivered").toBeTruthy();
    expect(single.raw, "single-session end is start + duration")
      .toContain(hhmmUtc(singleStart + singleMinutes * 60_000));

    const multi = await sink.waitFor(m => (m.raw || "").includes(p.email) && (m.raw || "").includes("GsSess"));
    expect(multi, "the multi-session group-sync mail is delivered").toBeTruthy();
    expect(multi.raw, "session end is its own start + its own duration")
      .toContain(hhmmUtc(slotStart + slotMinutes * 60_000));
  });

  // ── AN OPEN-ENDED PROGRAM'S MAIL SAYS "No fixed deadline" (operator ruling,
  // 14 Nov 2026). "No fixed deadline" in the event form stores a deadline ten
  // years out, and these mails printed it: "Ends: <a date in 2036>". Decided by
  // isOpenEnded when the mail is built (lib/competitions.js eventEndMailText).
  // Every arm sends an open-ended Program AND a dated one through the same door,
  // in one request where the door allows: the dated one must still print its
  // deadline, so a builder that printed the words for every Program fails.
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  /** "14 Nov 2026", the day formatEmailDate prints in UTC, derived independently. */
  const dayUtc = (ms) => { const d = new Date(ms); return `${String(d.getUTCDate()).padStart(2, "0")} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const escRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  /** The event's Starts/Ends pair in the decoded HTML part, or null. */
  const lineFor = (body, name) => {
    const m = body.match(new RegExp(`<li><strong>${escRe(name)}</strong><br/>Starts: ([^<]*)<br/>Ends: ([^<]*)</li>`));
    return m ? { starts: m[1], ends: m[2] } : null;
  };
  const OPEN_WORDS = "No fixed deadline";

  async function makeProgram(name, startMs, deadlineMs) {
    const r = await sa.go("/api/admin/competitions", {
      method: "POST",
      body: { name, event_kind: "program", start_time: iso(startMs), deadline_at: iso(deadlineMs), timezone: "UTC" },
    });
    expect(r.status, `create ${name}: ${JSON.stringify(r.json)}`).toBeLessThan(400);
    return r.json.competition.id;
  }

  /** An open-ended and a dated Program, starting at the same whole minute an hour out. */
  async function programPair(tag) {
    const stamp = Date.now();
    const startMs = Math.ceil((Date.now() + 3600_000) / 60_000) * 60_000;
    const open = { name: `OpenProg ${tag} ${stamp}`, startMs, deadlineMs: startMs + 3652 * 86400_000 };
    // Not a round figure: a wrong end cannot land on the right clock by chance.
    const dated = { name: `DatedProg ${tag} ${stamp}`, startMs, deadlineMs: startMs + (12 * 1440 + 5 * 60 + 7) * 60_000 };
    open.id = await makeProgram(open.name, open.startMs, open.deadlineMs);
    dated.id = await makeProgram(dated.name, dated.startMs, dated.deadlineMs);
    open.year = String(new Date(open.deadlineMs).getUTCFullYear());
    return { open, dated };
  }

  /** The two lines of one decoded mail body, asserted by value. */
  function assertOpenAndDated(body, { open, dated }, door) {
    const o = lineFor(body, open.name), d = lineFor(body, dated.name);
    expect(o, `${door}: the open-ended Program is listed (${body.slice(0, 600)})`).toBeTruthy();
    expect(o.ends, `${door}: the open-ended Program's end`).toBe(OPEN_WORDS);
    expect(o.starts, `${door}: its start is kept`).toContain(dayUtc(open.startMs));
    expect(o.starts).toContain(hhmmUtc(open.startMs));
    // No date in the placeholder's year anywhere in the mail, either part.
    expect(body, `${door}: no placeholder date`).not.toMatch(new RegExp(`\\b\\d{2} [A-Z][a-z]{2} ${open.year}\\b`));
    // CONTROL: the dated Program prints its deadline, never the words.
    expect(d, `${door}: the dated Program is listed`).toBeTruthy();
    expect(d.ends, `${door}: a dated Program prints its deadline's day`).toContain(dayUtc(dated.deadlineMs));
    expect(d.ends, `${door}: and its clock time`).toContain(hhmmUtc(dated.deadlineMs));
    expect(d.ends).not.toContain(OPEN_WORDS);
  }

  test("an open-ended Program's assignment mail says \"Ends: No fixed deadline\"; a dated one's prints its deadline", async () => {
    sink.clear();
    const pair = await programPair("asg");
    const p = await makeParticipant("oe-asg");
    const asg = await sa.go("/api/admin/competitions/assign", {
      method: "POST", body: { competitionIds: [pair.open.id, pair.dated.id], userIds: [p.id] },
    });
    expect(asg.status, `assign: ${JSON.stringify(asg.json)}`).toBeLessThan(400);
    expect(asg.json.assigned, "both enrolments made").toBe(2);
    // ONE mail lists both events: the control rides the same builder call.
    const msg = await sink.waitFor(m => (m.rcptTo || []).includes(p.email)
      && decodeQuotedPrintable(m.raw).includes(pair.open.name) && decodeQuotedPrintable(m.raw).includes(pair.dated.name));
    assertOpenAndDated(decodeQuotedPrintable(msg.raw), pair, "assignment");
    // The plain-text part says the same (its lines end CRLF on the wire).
    expect(decodeQuotedPrintable(msg.raw).replace(/\r/g, ""), "the text part's end")
      .toMatch(new RegExp(`- ${escRe(pair.open.name)}\\nStarts: [^\\n]*\\nEnds: ${OPEN_WORDS}\\n`));
  });

  test("an open-ended Program's invitation mail says \"Ends: No fixed deadline\"; a dated one's prints its deadline", async () => {
    sink.clear();
    const pair = await programPair("inv");
    const email = `sm-oe-inv-${Date.now()}@company.co`;
    const inv = await sa.go("/api/admin/invitations", {
      method: "POST", body: { emails: [email], competitionIds: [pair.open.id, pair.dated.id] },
    });
    expect(inv.status, `invite: ${JSON.stringify(inv.json)}`).toBeLessThan(400);
    const msg = await sink.waitFor(m => (m.rcptTo || []).includes(email));
    assertOpenAndDated(decodeQuotedPrintable(msg.raw), pair, "invitation");
  });

  test("an open-ended Program's group-sync mail says \"Ends: No fixed deadline\"; a dated one's prints its deadline", async () => {
    sink.clear();
    const pair = await programPair("gs");
    const g = await sa.go("/api/admin/groups", { method: "POST", body: { name: `OeGroup ${Date.now()}` } });
    expect(g.status, `group: ${JSON.stringify(g.json)}`).toBeLessThan(400);
    const groupId = g.json.group?.id || g.json.id;
    expect(groupId, "the group id is in the create response").toBeTruthy();
    const bind = await sa.go("/api/admin/competitions/assign", {
      method: "POST", body: { competitionIds: [pair.open.id, pair.dated.id], userIds: [], groupIds: [groupId] },
    });
    expect(bind.status, `bind: ${JSON.stringify(bind.json)}`).toBeLessThan(400);
    const p = await makeParticipant("oe-gs");
    const add = await sa.go(`/api/admin/groups/${groupId}/members`, { method: "POST", body: { userIds: [p.id] } });
    expect(add.status, `add member: ${JSON.stringify(add.json)}`).toBeLessThan(400);
    // One mail per event on this door: read each and assert it by value.
    const forEvent = async (ev) => decodeQuotedPrintable((await sink.waitFor(m => (m.rcptTo || []).includes(p.email)
      && decodeQuotedPrintable(m.raw).includes(ev.name))).raw);
    const openBody = await forEvent(pair.open), datedBody = await forEvent(pair.dated);
    const o = lineFor(openBody, pair.open.name), d = lineFor(datedBody, pair.dated.name);
    expect(o && o.ends, "group sync: the open-ended Program's end").toBe(OPEN_WORDS);
    expect(o.starts).toContain(dayUtc(pair.open.startMs));
    expect(openBody).not.toMatch(new RegExp(`\\b\\d{2} [A-Z][a-z]{2} ${pair.open.year}\\b`));
    expect(d && d.ends, "group sync: a dated Program prints its deadline").toContain(dayUtc(pair.dated.deadlineMs));
    expect(d.ends).toContain(hhmmUtc(pair.dated.deadlineMs));
  });
});
