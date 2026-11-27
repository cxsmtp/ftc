// @ts-check
//
// v8.3.6 — WHICH MAIL EACH REGISTRATION PATH ACTUALLY SENDS, read off the wire.
//
// THE DEFECT: a Booth Event walk-up who registered without a password received a
// verification link AND, when they asked for one, a sign-in code. The link was
// redundant — redeeming an EMAILED code sets `verified=1` on the identical claim
// shape `GET /verify` uses — and it was the wrong one of the two: the code does
// the link's whole job AND establishes a session, while the link on its own does
// neither. Two messages in one inbox at a stand, and the first instruction to a
// walk-up was still "go and read your email".
//
// WHY THIS SPEC SPAWNS A SERVER AND A REAL SMTP SERVER. `sendEmailLogged` records
// a `user_events.email_sent` row carrying `to` / `subject` / `reason` / `success`
// and deliberately NOT the body, and the shared test server points at a dead SMTP
// port. So the existing suite can assert what we COMPOSED and never what was
// SENT — which cannot distinguish "the verification mail is no longer sent" from
// "it is sent and we stopped logging it", and cannot read a code out of a message
// at all. CLAUDE.md *Spawned servers* records that gap (the shared relay is dead
// by design). And the v8.1.0 end-to-end test claims to read a delivered code and
// does not (its SMTP port has nothing listening; the code is planted).
//
// So the load-bearing assertion here is not that one mail is missing. It is that
// the code IN THE DELIVERED MESSAGE signs the walk-up in AND leaves the account
// verified — which is what makes the removed email redundant rather than merely
// absent. Deleting a mail because it looked unnecessary is a guess; proving the
// remaining one reaches the same state is the evidence.
const { test, expect, guardFixedPortSpec } = require("./isolated-test");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PORT_BASE } = require("./helpers");
const { startSmtpCapture } = require("./smtp-capture");
const { readySpawnedServer } = require("./spawned-server");

const PASS = "walkup-pass-123";

// v8.8.19 — this spec binds a fixed SPAWNER_OFFSETS port; see guardFixedPortSpec.
test.beforeEach(() => guardFixedPortSpec());

test.describe("v8.3.6 — registration email dispositions", () => {
  test.describe.configure({ mode: "serial" });

  // `BASE` gets its own declaration so the v7.16.2 helpers-import scanner can
  // see it is LOCAL (it matches `let\s+NAME`, not a name buried in a list). It is
  // the SPAWNED server's URL, deliberately not helpers' shared-server `BASE`.
  let BASE;
  let child, sink, dataDir, childOut = "";

  /** Minimal cookie-jar client — the spawned server is outside the Playwright fixture. */
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

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    sink = await startSmtpCapture();
    const port = PORT_BASE + 142; // registry: 140 = login-code, 141 = its sibling
    BASE = `http://localhost:${port}`;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-email-"));
    const spawnedAt = Date.now();
    child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        PORT: String(port), BASE_URL: BASE, DATA_DIR: dataDir, UPLOADS_DIR: `${dataDir}/uploads`,
        SMTP_HOST: "127.0.0.1", SMTP_PORT: String(sink.port), SMTP_ALLOW_PLAINTEXT: "1",
        RATE_LIMIT_DISABLED: "1",
        SUPERADMIN_PASSWORD_QUIET: "1", HSTS: "0", LOG_CONSOLE_MIRROR: "0",
        // v7.15.30 — a spawned server runs OUR node flags, never the runner's.
        NODE_OPTIONS: "",
        // NODE_ENV deliberately unset: `production` forces a Secure cookie, which
        // express-session refuses over plain HTTP, so there would be no session.
        // It ALSO means the NODE_ENV=test registration defaults do not apply, so
        // every registration below must supply jobFunction and city explicitly
        // unless the event's policy relaxes them (v7.29.0's spawned-server note).
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", b => { childOut += b.toString(); });
    child.stderr.on("data", b => { childOut += b.toString(); });

    const pass = await readySpawnedServer({ base: BASE, child, dataDir, spawnedAt, output: () => childOut });
    sa = new Client();
    await sa.refreshCsrf();
    const li = await sa.go("/api/login", { method: "POST", body: { email: "superadmin", password: pass } });
    expect(li.status, "superadmin signs in").toBe(200);
    await sa.refreshCsrf();
  });

  test.afterAll(async () => {
    try { child?.kill("SIGKILL"); } catch (_) {}
    try { await sink?.close(); } catch (_) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  });

  let seq = 0;
  const uniq = () => `re${Date.now().toString(36)}${seq++}`;

  async function joinableEvent(kind) {
    const r = await sa.go("/api/admin/competitions", { method: "POST", body: {
      name: `${uniq()} ${kind}`, event_kind: kind, timezone: "UTC",
      start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600,
      self_enroll_enabled: true,
    }});
    expect(r.status, `create ${kind}: ${JSON.stringify(r.json)}`).toBe(200);
    const comp = r.json.competition;
    const rv = await sa.go(`/api/admin/competitions/${comp.id}/self-enroll`);
    expect(rv.json?.token, "a join token").toBeTruthy();
    return { comp, token: rv.json.token };
  }

  /** Register, and return every message the SMTP server received for that address. */
  async function register(body) {
    const c = new Client();
    await c.refreshCsrf();
    const label = uniq();
    const email = body.email || `${label}@company.example`;
    // EMAIL FIRST: the code is requested at the entry screen, read OUT OF THE
    // DELIVERED MESSAGE, redeemed (the address proof), and only then is the form
    // submitted — so the mails this returns are everything the whole sign-up sent.
    await c.go("/api/auth/code/request", { method: "POST", body: {
      email, ...(body.joinToken ? { joinToken: body.joinToken } : {}), ...(body.invitationId ? { invitationId: body.invitationId } : {}),
    }});
    let code = null;
    for (let i = 0; i < 40 && !code; i++) {
      const m = mailsFor(email)[0];
      if (m) {
        const b = unqp(m.raw).split(/\r?\n\r?\n/).slice(1).join("\n\n");
        const hit = b.match(/\b([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})\b/);
        if (hit) code = hit[1];
      }
      if (!code) await new Promise(res => setTimeout(res, 150));
    }
    if (code) {
      await c.go("/api/auth/code/redeem", { method: "POST", body: { email, code } });
      await c.refreshCsrf();
    }
    const r = await c.go("/api/register", { method: "POST", body: {
      firstName: "Walk", lastName: "Up", nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "Testville",
      ...body, email,
    }});
    // Give the detached sends a moment to reach the sink — both the verification
    // and the code mail are dispatched in the background by design (awaiting the
    // SMTP round trip would make response time an existence oracle, v7.15.14).
    await new Promise(res => setTimeout(res, 1200));
    // EXACT recipient match, not `includes`: the addresses here share a prefix by
    // construction (`re<base36><seq>@…`), and a substring test is one collision
    // away from handing a test another test's message — which would surface as a
    // code that "does not work" and point at the server.
    return { status: r.status, json: r.json, email, client: c, mails: mailsFor(email) };
  }

  /**
   * Decode RFC 2047 encoded-words before matching.
   *
   * The subject is `<platform name> — <thing>`, and that em-dash makes nodemailer
   * encode the whole header: the raw value is
   * `=?UTF-8?Q?Checkmarx_Enablement_Platform_=E2=80=94_?= =?UTF-8?Q?Your_sign-in_code?=`.
   * Matching the raw string would have failed on the CORRECT mail — which is what
   * it did on the first run — and, worse, a naive `not.toMatch` on an encoded
   * header would PASS for a mail that should not have been sent at all. Both
   * directions need the decode.
   */
  const subjectOf = (m) => {
    const raw = m.header("subject") || "";
    return raw
      .replace(/\?=\s+=\?/g, "?==?")              // join adjacent encoded-words
      .replace(/=\?[^?]+\?([QqBb])\?([^?]*)\?=/g, (_, enc, txt) =>
        enc.toUpperCase() === "B"
          ? Buffer.from(txt, "base64").toString("utf8")
          : Buffer.from(txt.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g,
              (__, h) => String.fromCharCode(parseInt(h, 16))), "binary").toString("utf8"));
  };
  const subjects = (mails) => mails.map(subjectOf).sort();

  /** Messages whose envelope recipients EXACTLY include this address. */
  const mailsFor = (email) => sink.messages.filter(
    (m) => (m.rcptTo || []).some((t) => String(t).trim().toLowerCase() === email.toLowerCase()));

  /**
   * Un-quoted-printable enough of a body to read URLs and codes out of it.
   *
   * Soft line breaks (`=\r\n`) are the obvious half. The half that bites is
   * **`=3D`** — quoted-printable's own escape for `=`, which every URL in an HTML
   * part contains twice (`href=3D"…?invitation=3D<uuid>"`). Without decoding it,
   * a `?invitation=([0-9a-f-]{36})` match returns `3D6cb29b6f-…` — a real-looking
   * id that is the true one shifted two characters, so the failure reads
   * "invitation not found" and points at the server rather than at the parse.
   */
  const unqp = (raw) => raw.replace(/=\r?\n/g, "").replace(/=3D/gi, "=");



  test("THE REMOVED MAIL WAS REDUNDANT: the delivered code proves the address, so the new account is signed in AND verified", async () => {
    // The load-bearing test. Without it, "we stopped sending the verification
    // link" is equally satisfied by a build that simply leaves booth walk-ups
    // unverified for ever.
    const { token } = await joinableEvent("booth");
    sink.clear();
    const r = await register({ joinToken: token });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.mails.length, "one mail").toBe(1);
    // The code was read OUT OF THE DELIVERED MESSAGE (register() above), and the
    // body names exactly ONE code.
    const bodyOnly = unqp(r.mails[0].raw).split(/\r?\n\r?\n/).slice(1).join("\n\n");
    const found = [...new Set([...bodyOnly.matchAll(/\b([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})\b/g)].map(x => x[1]))];
    expect(found.length, `exactly one code in the delivered mail, got ${JSON.stringify(found)}`).toBe(1);
    expect(r.json?.ok, "the registration signed the new account in").toBe(true);
    const c = r.client;

    // The session works on its very next request (the v8.1.4 eject loop), and the
    // account is VERIFIED — which is exactly what the deleted email existed to do.
    const me = await c.go("/api/me");
    expect(me.status, "the code session survives its first request").toBe(200);
    expect(me.json?.verified, "redeeming an EMAILED code verified the account").toBe(true);
    expect(me.json?.can_change_password, "…and no password flag ships at all").toBeUndefined();
  });



  test("CONTROL: an ordinary self-registration sends ONE mail — the sign-in code, no verification link", async () => {
    // Every registration is passwordless now: the code is the account's way in,
    // and redeeming it verifies the address, so a separate verification link
    // would be a second mail saying the same thing.
    sink.clear();
    const r = await register({});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.mails.length, `exactly one mail; got: ${JSON.stringify(subjects(r.mails))}`).toBe(1);
    expect(subjects(r.mails)[0]).toMatch(/Your sign-in code/i);
    expect(subjects(r.mails)[0]).not.toMatch(/Complete Your Registration/i);
  });

  test("an INVITED registration sends ONE mail, the sign-in code — it is created already verified", async () => {
    const invEmail = `${uniq()}@company.example`;
    const inv = await sa.go("/api/admin/invitations", { method: "POST", body: { emails: [invEmail] } });
    expect(inv.status, `invite: ${JSON.stringify(inv.json)}`).toBe(200);
    // The invitation mail itself is a separate disposition and is asserted here so
    // the "nothing" below is about REGISTRATION rather than about a silent invite.
    await new Promise(res => setTimeout(res, 1200));
    const invited = mailsFor(invEmail);
    expect(invited.length, "the invitation itself is emailed").toBeGreaterThanOrEqual(1);

    // The response carries counts, not ids — so take the id from the invitation
    // LINK in the delivered mail, which is both the id we need and a check that
    // the link an invitee actually receives is well formed.
    const invBody = unqp(invited[0].raw);
    const idm = invBody.match(/\/register\?invitation=([0-9a-f-]{36})/i);
    expect(idm, `an invitation link in the mail. Body:\n${invBody.slice(0, 900)}`).toBeTruthy();
    const invitationId = idm[1];
    // Assert the invitation is live BEFORE registering against it — otherwise a
    // 409 below names "already used or does not exist" and says nothing about
    // which of the two it was.
    const look = await new Client().go(`/api/invitations/${invitationId}`);
    expect(look.status, `invitation ${invitationId} resolves: ${JSON.stringify(look.json)}`).toBe(200);
    expect(look.json?.used, "…and is unused").toBe(false);
    expect(String(look.json?.email || "").toLowerCase(), "…and is for this address").toBe(invEmail.toLowerCase());

    sink.clear();
    const r = await register({ email: invEmail, invitationId, password: PASS });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // No verification link (the invitation proved the address); only the code
    // the account signs in with, since it has no password.
    expect(r.mails.length, `one mail on an invited registration; got: ${JSON.stringify(subjects(r.mails))}`).toBe(1);
    expect(subjects(r.mails)[0]).toMatch(/Your sign-in code/i);
  });

  test("the at-desk invite sends nothing at all", async () => {
    // Its whole point: immune to the greylisting that makes the desk fallback
    // necessary. A mail here would defeat the path.
    const deskEmail = `${uniq()}@company.example`;
    sink.clear();
    const r = await sa.go("/api/admin/participants/desk-invite", { method: "POST", body: {
      email: deskEmail, firstName: "Desk", lastName: "Walkup",
    }});
    expect(r.status, `desk-invite: ${JSON.stringify(r.json)}`).toBe(200);
    expect(r.json?.code, "a code is returned on the admin's screen instead").toBeTruthy();
    await new Promise(res => setTimeout(res, 1200));
    const mine = mailsFor(deskEmail);
    expect(mine.length, `no mail at any point; got: ${JSON.stringify(subjects(mine))}`).toBe(0);
  });

  // ── v8.3.7 — SUPPRESSION IS VISIBLE, AND APPROVAL IS CONSISTENT ────────────

  /**
   * Opt an address out by minting the same token `List-Unsubscribe` carries.
   *
   * Reimplemented rather than imported: a spec must not `require("../lib/email")`
   * — that module opens a SECOND database at load time and writes files, which is
   * its own Docs-hygiene lock (v7.21.14). So it mirrors `generateUnsubscribeToken`
   * exactly, and the two details that matter are easy to get wrong:
   *   * the HMAC covers the **raw JSON payload**, not its base64url encoding (the
   *     first draft signed the encoding and got a flat "Invalid or expired token");
   *   * the secret is the RAW BYTES of `DATA_DIR/.unsubscribe-secret`, not hex.
   */
  async function unsubscribe(addr) {
    const crypto = require("crypto");
    const secret = fs.readFileSync(path.join(dataDir, ".unsubscribe-secret"));
    const b64 = (b) => Buffer.from(b).toString("base64url");
    const payload = JSON.stringify({ e: addr.toLowerCase(), x: Date.now() + 86400e3 });
    const sig = crypto.createHmac("sha256", secret).update(payload).digest();
    const token = `${b64(payload)}.${b64(sig)}`;
    const c = new Client();
    await c.refreshCsrf();
    const r = await c.go(`/api/unsubscribe?token=${encodeURIComponent(token)}`, { method: "POST", body: {} });
    expect(r.status, `unsubscribe ${addr}: ${JSON.stringify(r.json)}`).toBeLessThan(400);
    // Assert it TOOK — a silently-refused opt-out would make every assertion in
    // the tests below vacuous (they would all be about an ordinary address).
    const list = await sa.go("/api/admin/unsubscribed?limit=1000");
    const all = JSON.stringify(list.json || {});
    expect(all, `${addr} is on the unsubscribed list`).toContain(addr.toLowerCase());
  }

  test("an invitation to an UNSUBSCRIBED address is recorded, and reported as an opt-out", async () => {
    // Before v8.3.7 this send vanished completely: the suppression branch wrote a
    // `user_events` row only `if (userId)`, and the invitation site passes null
    // because the invitee has no user row yet. The admin was then shown the
    // address under `undeliveredInvites` WITH a registration link and "share
    // manually" — the platform explaining how to route around the recipient's own
    // opt-out, while telling the operator SMTP had failed.
    const addr = `${uniq()}@company.example`;
    await unsubscribe(addr);
    sink.clear();

    const inv = await sa.go("/api/admin/invitations", { method: "POST", body: { emails: [addr] } });
    expect(inv.status, `invite: ${JSON.stringify(inv.json)}`).toBe(200);
    await new Promise(res => setTimeout(res, 1200));

    // Nothing was sent…
    const got = mailsFor(addr);
    expect(got.length, `no mail to an opted-out address; got ${JSON.stringify(subjects(got))}`).toBe(0);
    // …and it is reported as an OPT-OUT, not as a failure to work around.
    expect((inv.json.unsubscribedInvites || []).map(u => u.email), "reported as unsubscribed").toContain(addr);
    expect(JSON.stringify(inv.json.undeliveredInvites || []), "NOT reported as an undelivered invite").not.toContain(addr);
    // The load-bearing half: no registration link is handed over for this address.
    expect(JSON.stringify(inv.json.unsubscribedInvites || []), "and no link to hand-deliver around the opt-out").not.toMatch(/register\?invitation=/);

    // …and the suppression left a TRACE, which is the whole defect.
    const logs = await sa.go("/api/admin/logs?limit=400&q=email_suppressed");
    const blob = JSON.stringify(logs.json || {});
    expect(blob, `an audit record of the suppression. Got: ${blob.slice(0, 500)}`).toContain("email_suppressed");
    expect(blob, "…naming the address it was withheld from").toContain(addr);
  });

  test("BOTH approval paths reach an unsubscribed account — single and bulk alike", async () => {
    // They are byte-identical mail. Before v8.3.7 `account_approved_bulk` was
    // suppressible and `account_approved` was not, so the same participant got the
    // notice or did not depending on which button an admin used. Equalised towards
    // DELIVERY: an approval is transactional — it is how someone learns the
    // account they asked for is usable.
    const mk = async () => {
      const label = uniq(), email = `${label}@company.example`;
      const r = await register({ email, firstName: "Opt", lastName: "Out" });
      expect(r.status, `register ${email}: ${JSON.stringify(r.json)}`).toBe(200);
      // A proven sign-up is approved at once; this needs a PENDING one to approve,
      // so it is rewound to the fixture state registerPost uses (unverified and
      // pending: no sign-up creates it), in this server's own database (it runs
      // without NODE_ENV=test, so it has no test hooks).
      {
        const Database = require("better-sqlite3");
        const db = new Database(path.join(dataDir, "hackathon.db"));
        try { db.prepare("UPDATE users SET verified=0, approved=0, approved_at=NULL, approved_by=NULL WHERE LOWER(email)=LOWER(?)").run(email); }
        finally { db.close(); }
      }
      const list = await sa.go("/api/admin/participants?limit=5000");
      const row = (list.json.participants || []).find(p => p.email === email);
      expect(row, "the new participant is findable").toBeTruthy();
      // `POST .../approve` REFUSES an unverified account ("approval is not
      // meaningful until the account is verified"), so verify-then-approve is the
      // only ordering the admin path allows — the documented fixture trap.
      const v = await sa.go(`/api/admin/participants/${row.id}/verify`, { method: "POST", body: {} });
      expect(v.status, `verify ${email}: ${JSON.stringify(v.json)}`).toBe(200);
      await unsubscribe(email);
      return { email, id: row.id };
    };

    const single = await mk();
    sink.clear();
    expect((await sa.go(`/api/admin/participants/${single.id}/approve`, { method: "POST", body: {} })).status).toBe(200);
    await new Promise(res => setTimeout(res, 1200));
    const gotSingle = mailsFor(single.email);
    expect(subjects(gotSingle).join(" "), "single approve reaches an unsubscribed account").toMatch(/Approved/i);

    const bulk = await mk();
    sink.clear();
    const bulkRes = await sa.go("/api/admin/participants/bulk-approve", { method: "POST", body: { userIds: [bulk.id] } });
    expect(bulkRes.status, `bulk-approve: ${JSON.stringify(bulkRes.json)}`).toBe(200);
    await new Promise(res => setTimeout(res, 1500));
    const gotBulk = mailsFor(bulk.email);
    expect(subjects(gotBulk).join(" "), "…and so does BULK approve — the asymmetry is gone").toMatch(/Approved/i);
  });

  test("CONTROL: a genuinely bulk reason IS still suppressed", async () => {
    // Without this, "approval reaches an opted-out account" is equally satisfied
    // by a build that emptied _BULK_EMAIL_REASONS and stopped honouring opt-outs
    // entirely — which is a far worse change and invisible to every test above.
    const label = uniq(), email = `${label}@company.example`;
    expect((await register({ email, firstName: "Opt", lastName: "Out" })).status).toBe(200);
    // Back to pending, in this server's own database (no test hooks here), so the
    // verify and approve below are real transitions.
    {
      const Database = require("better-sqlite3");
      const db = new Database(path.join(dataDir, "hackathon.db"));
      try { db.prepare("UPDATE users SET verified=0, approved=0, approved_at=NULL, approved_by=NULL WHERE LOWER(email)=LOWER(?)").run(email); }
      finally { db.close(); }
    }
    const list = await sa.go("/api/admin/participants?limit=5000");
    const row = (list.json.participants || []).find(p => p.email === email);
    expect(row, "findable").toBeTruthy();
    for (const act of ["verify", "approve"]) {
      expect((await sa.go(`/api/admin/participants/${row.id}/${act}`, { method: "POST", body: {} })).status).toBe(200);
    }
    await unsubscribe(email);

    const { comp } = await joinableEvent("tournament");
    sink.clear();
    const asg = await sa.go("/api/admin/competitions/assign", { method: "POST", body: {
      userIds: [row.id], competitionIds: [comp.id] } });
    expect(asg.status, `assign: ${JSON.stringify(asg.json)}`).toBe(200);
    await new Promise(res => setTimeout(res, 1500));
    const got = mailsFor(email);
    expect(got.length, `competition_assignment is still suppressed; got ${JSON.stringify(subjects(got))}`).toBe(0);
  });

  test("the request endpoint and registration send the SAME message", async () => {
    // v8.3.6 hoisted the template into lib/email so both senders share it. Two
    // hand-written copies of a credential email are one wording change away from
    // telling two people different things about the same code — and the expiry
    // sentence is the half that matters.
    const { token } = await joinableEvent("booth");
    sink.clear();
    const reg = await register({ joinToken: token, password: "" });
    expect(reg.mails.length).toBe(1);
    const fromRegistration = reg.mails[0];

    // A code mailed under two minutes ago is never replaced by a request (the
    // re-send suppression), and this server has no test hooks. A DESK code
    // replaces the mailed one and so lifts the suppression: the request below
    // then mints and mails a fresh code.
    const ppl = await sa.go("/api/admin/participants?limit=5000");
    const who = (ppl.json?.participants || []).find(p => p.email === reg.email);
    expect(who, "PRECONDITION: the registered account is listed").toBeTruthy();
    // (Email first: the sign-up mail was the ADDRESS PROOF, not a sign-in code, so
    // the new account holds no live code and the request below mints one. A live
    // desk code would now be kept, never superseded by an emailed request.)
    sink.clear();
    const c = new Client();
    await c.refreshCsrf();
    // From the same join link, so both codes are bound to (and name) the event.
    await c.go("/api/auth/code/request", { method: "POST", body: { email: reg.email, joinToken: token } });
    await new Promise(res => setTimeout(res, 1200));
    const asked = mailsFor(reg.email);
    expect(asked.length, "the request endpoint sends one").toBe(1);

    expect(subjectOf(asked[0]), "same subject").toBe(subjectOf(fromRegistration));
    // Same skeleton: compare the body with the CODE itself removed, since the two
    // codes legitimately differ (the second mint supersedes the first).
    // Compare the BODY, not the whole message. Headers are per-message by
    // definition (Message-ID, Date, the MIME boundary), and stripping them out of
    // the raw text is fiddlier than it looks: `unqp` removes `=\r\n` as a soft
    // line break, which also eats the `=` that TERMINATES the encoded-word
    // subject — joining `Subject:` and `Message-ID:` onto one line so a
    // line-anchored header pattern no longer matches either. Splitting at the
    // header/body boundary first avoids the whole class.
    //
    // What legitimately differs inside the body is the code itself (the second
    // mint supersedes the first) and the boundary marker.
    const strip = (m) => unqp(m.raw.split(/\r?\n\r?\n/).slice(1).join("\n\n"))
      .replace(/\b[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/g, "CODE")
      .replace(/--_NmP-[^\s"]+/g, "BOUNDARY")
      .replace(/^(?:Content-Type|Content-Transfer-Encoding):.*$/gim, "")
      .replace(/\s+/g, " ").trim();
    // Anti-vacuity: the strip must leave the actual message behind, or "identical"
    // is satisfied by two empty strings.
    // Email first: the sign-up mail is the ADDRESS PROOF (sent before any account
    // exists), so its body says so; it shares the sign-in code's subject and its
    // code line, so neither the subject nor the shape tells a reader which it is.
    expect(strip(fromRegistration), "the stripped body is not empty").toMatch(/Your sign-in code is/);
    expect(strip(asked[0]), "the sign-in code's body").toMatch(/Your sign-in code is/);
    expect(strip(fromRegistration), "the proof says no account exists yet").toMatch(/no account yet/i);
  });
});
