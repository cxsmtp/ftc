// v9.0.0 — THE SIGN-IN DOORS' HARDENING (operator rulings, 11 Nov 2026), on the
// wire. Each refusal has a control of the same shape that succeeds.
//   * A SECONDARY address is an unconfirmed claim, so it never signs anybody in
//     (no code is mailed to it, a redeem or a password with it fails), never
//     claims an invitation at sign-in (the claim follows the proven PRIMARY),
//     cannot be invited (the admin is told why), and Users & roles "Add user"
//     refuses it instead of offering its holder the role.
//   * An address PROOF is recorded by domain and fingerprint, never the address,
//     and proofs from one IP are capped (silently: the answer stays uniform).
//   * A DESK code: the reveal is a rival door (refused to a competitor), a live
//     desk code survives Continue for its whole life and is never replaced by the
//     admin's Email sign-in code, and an account promoted while its desk code was
//     live does not sign in with it.
const fs = require("fs");
const path = require("path");
const { test, expect } = require("./isolated-test");
const { freshCtx, getSuperadminPass, codeLogin, TEST_DB_PATH, TEST_DATA_DIR } = require("./helpers");
const { makeParticipant, makeCompetition, enrol } = require("./event-admin-helpers");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
let _n = 0;
const stamp = () => `${Date.now().toString(36)}${++_n}`;

function dbRun(fn, readonly = false) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, readonly ? { readonly: true } : {});
  try { return fn(db); } finally { db.close(); }
}
const row = (id) => dbRun((db) => db.prepare("SELECT * FROM users WHERE id=?").get(id), true);
async function token(api) { return (await (await api.get("/api/csrf-token")).json()).csrfToken; }
async function builtin() {
  const { api, csrf } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(csrf), data: { username: "superadmin", password: getSuperadminPass() } });
  expect(r.ok()).toBeTruthy();
  return { api, csrf: await token(api) };
}
async function codeSession(email) {
  const { api, csrf } = await freshCtx();
  const li = await codeLogin(api, email, H(csrf));
  expect(li.ok(), `code sign-in ${email}: ${li.status()}`).toBeTruthy();
  return { api, csrf: await token(api) };
}
async function setSecondary(email, secondary) {
  const s = await codeSession(email);
  try {
    const r = await s.api.put("/api/me", { headers: H(s.csrf), data: { secondaryEmail: secondary } });
    expect(r.status(), `secondary ${secondary}: ${await r.text()}`).toBe(200);
  } finally { await s.api.dispose(); }
}
async function requestCode(email) {
  const { api, csrf } = await freshCtx();
  try {
    await api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
    const r = await api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
    expect(r.status()).toBe(200);
    return r.json();
  } finally { await api.dispose(); }
}
async function redeem(email, code) {
  const { api, csrf } = await freshCtx();
  const r = await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email, code } });
  expect(r.status()).toBe(200);
  return { api, body: await r.json() };
}
async function lastCode(email) {
  const { api } = await freshCtx();
  try {
    const r = await api.get("/api/test/last-login-code?email=" + encodeURIComponent(email));
    return r.ok() ? r.json() : null;
  } finally { await api.dispose(); }
}

test.describe("the secondary address never signs in", () => {
  test("no code, no redeem, no password, no invitation through a secondary; the primary works", async () => {
    const bg = await builtin();
    try {
      const p = await makeParticipant(bg.api, bg.csrf, "sh-sec");
      const sec = `squat-${stamp()}@acme.com`;
      await setSecondary(p.email, sec);
      // A code request for the secondary mints nothing on the account and sends
      // no proof either (the address is reserved by the claim).
      const before = row(p.id);
      expect(await requestCode(sec)).toEqual({ ok: true });
      const after = row(p.id);
      expect(after.login_code_hash, "no code minted through the secondary").toBe(before.login_code_hash);
      expect(dbRun((db) => db.prepare("SELECT 1 FROM email_proofs WHERE email_norm=?").get(sec), true), "no proof either").toBeUndefined();
      // A code requested at the PRIMARY cannot be redeemed with the secondary.
      expect(await requestCode(p.email)).toEqual({ ok: true });
      const c = await lastCode(p.email);
      expect(c && c.code).toBeTruthy();
      const viaSec = await redeem(sec, c.code);
      expect(viaSec.body.ok, "the secondary signs nobody in").toBe(false);
      expect(viaSec.body.needsProfile, "and is not treated as a new address either").toBeFalsy();
      await viaSec.api.dispose();
      const viaPrimary = await redeem(p.email, c.code);
      expect(viaPrimary.body.ok, "control: the same code with the primary").toBe(true);
      await viaPrimary.api.dispose();
      // A password through the secondary: refused; through the primary: signs in.
      const bcrypt = require("bcrypt");
      dbRun((db) => db.prepare("UPDATE users SET password_hash=?, password_set_at=?, login_method='password' WHERE id=?")
        .run(bcrypt.hashSync("secondary-door", 4), new Date().toISOString(), p.id));
      const x = await freshCtx();
      const a = await (await x.api.post("/api/auth/password", { headers: H(x.csrf), data: { email: sec, password: "secondary-door" } })).json();
      expect(a).toEqual({ ok: false });
      const b = await (await x.api.post("/api/auth/password", { headers: H(x.csrf), data: { email: p.email, password: "secondary-door" } })).json();
      expect(b.ok, "control: the primary signs in with it").toBe(true);
      await x.api.dispose();
    } finally { await bg.api.dispose(); }
  });

  test("a sign-in claims invitations for the PRIMARY only; an invitation to a secondary is refused at invite time", async () => {
    const bg = await builtin();
    try {
      const comp = await makeCompetition(bg.api, bg.csrf, "sh-inv");
      // An invitation stored for an address before a participant claimed it as
      // their secondary: never claimed by that participant's sign-in.
      const squatted = `inv-squat-${stamp()}@acme.com`;
      const inv = await bg.api.post("/api/admin/invitations", { headers: H(bg.csrf), data: { emails: [squatted], competitionIds: [comp.id] } });
      expect(inv.ok(), await inv.text()).toBeTruthy();
      expect((await inv.json()).invited).toBe(1);
      const p = await makeParticipant(bg.api, bg.csrf, "sh-inv-p");
      await setSecondary(p.email, squatted);
      // An invitation to the participant's PRIMARY, stored before the account
      // existed (as main left them): the control the sign-in must claim.
      const primInvId = `inv-${stamp()}`;
      dbRun((db) => db.prepare("INSERT INTO invitations (id, email, competition_ids, group_ids, invited_by, created_at) VALUES (?,?,?,?,?,?)")
        .run(primInvId, p.email, JSON.stringify([comp.id]), "[]", "admin", new Date().toISOString()));
      const s = await codeSession(p.email);
      await s.api.dispose();
      const invRows = dbRun((db) => db.prepare("SELECT email, used_at, user_id FROM invitations WHERE email IN (?, ?) COLLATE NOCASE").all(squatted, p.email), true);
      const sq = invRows.find((r) => r.email.toLowerCase() === squatted.toLowerCase());
      const pr = invRows.find((r) => r.email.toLowerCase() === p.email.toLowerCase());
      expect(sq.used_at, "the squatted secondary's invitation is not claimed").toBeNull();
      expect(pr.used_at, "control: the primary's invitation is claimed").toBeTruthy();
      expect(pr.user_id).toBe(p.id);
      // Inviting an address someone holds as a secondary: refused by name,
      // nobody enrolled, nothing stored.
      const q = await makeParticipant(bg.api, bg.csrf, "sh-inv-q");
      const qsec = `inv-qsec-${stamp()}@acme.com`;
      await setSecondary(q.email, qsec);
      const r = await bg.api.post("/api/admin/invitations", { headers: H(bg.csrf), data: { emails: [qsec], competitionIds: [comp.id] } });
      const d = await r.json();
      expect(d.errors.join(" ")).toMatch(/secondary email/);
      expect(d.assigned || 0).toBe(0);
      expect(dbRun((db) => db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, q.id), true)).toBeUndefined();
      expect(dbRun((db) => db.prepare("SELECT 1 FROM invitations WHERE email=? COLLATE NOCASE").get(qsec), true)).toBeUndefined();
      // Control: inviting q's PRIMARY enrols q.
      const r2 = await bg.api.post("/api/admin/invitations", { headers: H(bg.csrf), data: { emails: [q.email], competitionIds: [comp.id] } });
      expect((await r2.json()).assigned).toBe(1);
    } finally { await bg.api.dispose(); }
  });

  test("Add user refuses an address held as a secondary; the primary is offered", async () => {
    const bg = await builtin();
    try {
      const p = await makeParticipant(bg.api, bg.csrf, "sh-add");
      const sec = `add-sec-${stamp()}@acme.com`;
      await setSecondary(p.email, sec);
      const r = await bg.api.post("/api/admin/users", { headers: H(bg.csrf), data: { email: sec, role: "admin" } });
      expect(r.status()).toBe(409);
      const d = await r.json();
      expect(d.code).toBe("email_is_secondary");
      expect(d.id, "no account is named, so no role can be offered").toBeUndefined();
      expect(row(p.id).role).toBe("participant");
      const r2 = await bg.api.post("/api/admin/users", { headers: H(bg.csrf), data: { email: p.email, role: "admin" } });
      expect(r2.status()).toBe(409);
      const d2 = await r2.json();
      expect(d2.code, "control: the primary names its account").toBe("user_exists");
      expect(d2.id).toBe(p.id);
    } finally { await bg.api.dispose(); }
  });
});

test.describe("the secondary address at the desk", () => {
  test("the desk shortcut names an address held as a secondary instead of pointing at its holder's code", async () => {
    const bg = await builtin();
    try {
      const p = await makeParticipant(bg.api, bg.csrf, "sh-deskdup");
      const sec = `desk-sec-${stamp()}@acme.com`;
      await setSecondary(p.email, sec);
      const r = await bg.api.post("/api/admin/participants/desk-invite", { headers: H(bg.csrf), data: { email: sec, firstName: "Walk", lastName: "Up" } });
      expect(r.status()).toBe(409);
      const d = await r.json();
      expect(d.code).toBe("email_taken");
      expect(d.error).toMatch(/secondary email, which never signs anyone in/);
      expect(d.error, "never sends the walk-up to a desk code for an address that cannot sign in").not.toMatch(/Show sign-in code/);
      // Control: the PRIMARY points at its holder's door. The holder has signed
      // in (setting the secondary above), so that door is the emailed code: a
      // code is shown at the desk only before a first sign-in (operator ruling,
      // 14 Nov 2026).
      const r2 = await bg.api.post("/api/admin/participants/desk-invite", { headers: H(bg.csrf), data: { email: p.email, firstName: "Walk", lastName: "Up" } });
      expect(r2.status()).toBe(409);
      expect((await r2.json()).error).toMatch(/Email sign-in code/);
    } finally { await bg.api.dispose(); }
  });
});

test.describe("address proofs", () => {
  test("a proof is recorded by domain and fingerprint, never the address", async () => {
    const domain = `proof-${stamp()}.example`;
    const addr = `walkup.${stamp()}@${domain}`;
    expect(await requestCode(addr)).toEqual({ ok: true });
    let rows = [];
    await expect.poll(() => {
      rows = dbRun((db) => db.prepare("SELECT event_type, details FROM orphan_events WHERE details LIKE ?").all(`%${domain}%`), true);
      return rows.some((r) => r.event_type === "email_sent");
    }, { message: "the proof's email_sent record", timeout: 10_000 }).toBe(true);
    const sent = JSON.parse(rows.find((r) => r.event_type === "email_sent").details);
    expect(sent.reason).toBe("email_proof");
    expect(sent.to_domain).toBe(domain);
    expect(sent.to_fp).toMatch(/^ep_/);
    expect(sent.to, "no address field").toBeUndefined();
    for (const r of rows) expect(r.details.includes(addr), `${r.event_type} must not carry the address`).toBe(false);
    // Nor the app log.
    const logDir = path.join(TEST_DATA_DIR, "logs");
    const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.startsWith("app-")) : [];
    expect(files.length, "the app log exists (control)").toBeGreaterThan(0);
    for (const f of files) expect(fs.readFileSync(path.join(logDir, f), "utf8").includes(addr), `${f} must not carry the address`).toBe(false);
  });

  test("address proofs from one IP are capped, silently; an existing account's code is not", async () => {
    const bg = await builtin();
    const { api, csrf } = await freshCtx();
    try {
      const p = await makeParticipant(bg.api, bg.csrf, "sh-budget");
      expect((await api.post("/api/test/rate-limit-toggle", { data: { enable: true } })).ok()).toBeTruthy();
      const tag = stamp();
      const addr = (i) => `pb-${tag}-${i}@budget-${tag}.example`;
      const bodies = [];
      for (let i = 0; i < 42; i++) {
        const r = await api.post("/api/auth/code/request", { headers: H(csrf), data: { email: addr(i) } });
        expect(r.status(), `request ${i + 1}: never a 429 — the answer stays uniform`).toBe(200);
        bodies.push(await r.text());
      }
      expect(new Set(bodies).size, "one body for every request").toBe(1);
      const proofs = (i) => !!dbRun((db) => db.prepare("SELECT 1 FROM email_proofs WHERE email_norm=?").get(addr(i)), true);
      // Each address is its own (IP, address) bucket at 1 of 5, so only the
      // per-IP proof budget (40 in test servers) can refuse.
      expect(proofs(0) && proofs(39), "the first 40 new addresses get a proof").toBe(true);
      expect(proofs(40) || proofs(41), "the 41st and 42nd get none").toBe(false);
      await expect.poll(() => dbRun((db) => db.prepare("SELECT COUNT(*) c FROM orphan_events WHERE event_type='email_proof_refused' AND details LIKE ?").get('%"ip_budget"%'), true).c,
        { message: "the refusal is audited" }).toBeGreaterThan(0);
      // Control: an EXISTING account's code still goes out from the same IP.
      const before = row(p.id).login_code_hash;
      await api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
      const r = await api.post("/api/auth/code/request", { headers: H(csrf), data: { email: p.email } });
      expect(r.status()).toBe(200);
      expect(row(p.id).login_code_hash, "a sign-in code is not a proof: not charged, not refused").not.toBe(before);
    } finally {
      await api.post("/api/test/rate-limit-toggle", { data: { enable: false } });
      await api.dispose();
      await bg.api.dispose();
    }
  });
});

test.describe("desk codes", () => {
  test("the reveal is a rival door: refused to a competitor, served to a non-competing admin", async () => {
    const bg = await builtin();
    try {
      const comp = await makeCompetition(bg.api, bg.csrf, "sh-rival", { staff_compete: true });
      const a = await makeParticipant(bg.api, bg.csrf, "sh-rival-a");
      const a2 = await makeParticipant(bg.api, bg.csrf, "sh-rival-a2");
      const p = await makeParticipant(bg.api, bg.csrf, "sh-rival-p");
      for (const u of [a, a2]) {
        const r = await bg.api.post(`/api/admin/participants/${u.id}/role`, { headers: H(bg.csrf), data: { role: "admin" } });
        expect(r.ok()).toBeTruthy();
      }
      await enrol(bg.api, bg.csrf, comp.id, [a.id, p.id]);
      const sa = await codeSession(a.email);
      const r = await sa.api.post(`/api/admin/participants/${p.id}/login-code/reveal`, { headers: H(sa.csrf) });
      expect(r.status(), await r.text()).toBe(403);
      expect((await r.json()).code).toBe("competitor_cannot_edit");
      expect(row(p.id).login_code_hash, "no code was minted").toBeNull();
      const sa2 = await codeSession(a2.email);
      const ok = await sa2.api.post(`/api/admin/participants/${p.id}/login-code/reveal`, { headers: H(sa2.csrf) });
      expect(ok.status(), "control: a non-competing admin is served").toBe(200);
      expect((await ok.json()).code).toBeTruthy();
      await Promise.all([sa.api.dispose(), sa2.api.dispose()]);
    } finally { await bg.api.dispose(); }
  });

  test("a live desk code survives Continue and the admin's Email sign-in code, for its whole life", async () => {
    const bg = await builtin();
    try {
      const p = await makeParticipant(bg.api, bg.csrf, "sh-desk");
      const rv = await bg.api.post(`/api/admin/participants/${p.id}/login-code/reveal`, { headers: H(bg.csrf) });
      expect(rv.status()).toBe(200);
      const deskCode = (await rv.json()).code;
      const minted = row(p.id);
      // requestCode forgets the in-process two-minute suppression first, so this
      // is Continue pressed long after the reveal.
      expect(await requestCode(p.email)).toEqual({ ok: true });
      const afterContinue = row(p.id);
      expect(afterContinue.login_code_via, "Continue did not replace the desk code").toBe("desk");
      expect(afterContinue.login_code_hash).toBe(minted.login_code_hash);
      const em = await bg.api.post(`/api/admin/participants/${p.id}/login-code/email`, { headers: H(bg.csrf) });
      expect(await em.json()).toMatchObject({ ok: true, sent: false, reason: "desk_code_live" });
      expect(row(p.id).login_code_hash, "nor did the admin's email door").toBe(minted.login_code_hash);
      const rd = await redeem(p.email, deskCode);
      expect(rd.body.ok, "the desk code still signs in").toBe(true);
      await rd.api.dispose();
      // Control: with no live desk code, Continue mints an emailed one.
      expect(await requestCode(p.email)).toEqual({ ok: true });
      expect(row(p.id).login_code_via).toBe("email");
    } finally { await bg.api.dispose(); }
  });

  test("an account promoted while its desk code was live does not sign in with it", async () => {
    const bg = await builtin();
    try {
      const p = await makeParticipant(bg.api, bg.csrf, "sh-promo");
      const q = await makeParticipant(bg.api, bg.csrf, "sh-promo-ctl");
      const codes = {};
      for (const u of [p, q]) {
        const rv = await bg.api.post(`/api/admin/participants/${u.id}/login-code/reveal`, { headers: H(bg.csrf) });
        expect(rv.status()).toBe(200);
        codes[u.id] = (await rv.json()).code;
      }
      const pr = await bg.api.post(`/api/admin/participants/${p.id}/role`, { headers: H(bg.csrf), data: { role: "admin" } });
      expect(pr.ok()).toBeTruthy();
      const r1 = await redeem(p.email, codes[p.id]);
      expect(r1.body.ok, "a desk code is for participants only").toBe(false);
      expect(row(p.id).login_code_hash, "and it is spent").toBeNull();
      const r2 = await redeem(q.email, codes[q.id]);
      expect(r2.body.ok, "control: a participant's desk code signs in").toBe(true);
      await Promise.all([r1.api.dispose(), r2.api.dispose()]);
    } finally { await bg.api.dispose(); }
  });
});

test.describe("asking for somebody's sign-in code", () => {
  test("the admin's Email sign-in code reports a send the relay refused, and lifts the code's re-send suppression", async () => {
    // The shared test server's relay is a dead port by design, so every send
    // fails here: the door must say so, never "on its way". The delivered and
    // still-queued answers are driven against a capturing relay in
    // tests/email-scenarios.spec.js.
    const bg = await builtin();
    try {
      const p = await makeParticipant(bg.api, bg.csrf, "sh-failsend");
      await bg.api.post("/api/test/reset-recent-code-sends", { headers: H(bg.csrf) });
      const em = await bg.api.post(`/api/admin/participants/${p.id}/login-code/email`, { headers: H(bg.csrf) });
      expect(em.status()).toBe(200);
      const b = await em.json();
      expect(b, JSON.stringify(b)).toMatchObject({ ok: true, sent: false, reason: "send_failed" });
      expect(b.message).toMatch(/could not be sent/);
      const first = row(p.id);
      expect(first.login_code_via, "the code was minted before the send").toBe("email");
      // Nobody holds that code, so pressing again (or the person's own Continue)
      // mints a fresh one at once instead of answering that one is on its way.
      const em2 = await bg.api.post(`/api/admin/participants/${p.id}/login-code/email`, { headers: H(bg.csrf) });
      const b2 = await em2.json();
      expect(b2.reason, `the retry is not refused as recently sent: ${JSON.stringify(b2)}`).toBe("send_failed");
      expect(row(p.id).login_code_hash, "a fresh code was minted").not.toBe(first.login_code_hash);
    } finally { await bg.api.dispose(); }
  });

  test("a code requested for somebody — at the entry screen, by an admin's email door or at the desk — never signs them out", async () => {
    // The person is signed in, so the desk's reveal refuses them (a code is shown
    // only before a first sign-in: operator ruling, 14 Nov 2026) — and the
    // refusal, like every door here, leaves their session alone.
    const bg = await builtin();
    try {
      const p = await makeParticipant(bg.api, bg.csrf, "sh-keep");
      const s = await codeSession(p.email);
      const alive = async () => (await s.api.get("/api/me")).status();
      expect(await alive(), "precondition: the person is signed in").toBe(200);
      expect(await requestCode(p.email)).toEqual({ ok: true });
      expect(await alive(), "a stranger typing their address at the entry screen").toBe(200);
      await bg.api.post("/api/test/reset-recent-code-sends", { headers: H(bg.csrf) });
      const em = await bg.api.post(`/api/admin/participants/${p.id}/login-code/email`, { headers: H(bg.csrf) });
      expect(em.status(), await em.text()).toBe(200);
      expect(await alive(), "an admin's Email sign-in code").toBe(200);
      const emailed = await lastCode(p.email);
      expect(emailed && emailed.via, "PRECONDITION: the admin's door minted an emailed code").toBe("email");
      const rv = await bg.api.post(`/api/admin/participants/${p.id}/login-code/reveal`, { headers: H(bg.csrf) });
      expect(rv.status(), await rv.text()).toBe(409);
      expect((await rv.json()).code, "a signed-in person is not shown a desk code").toBe("signed_in_before");
      expect(await alive(), "a desk reveal").toBe(200);
      // Control: a SIGN-IN elsewhere ends the session (one per principal), so the
      // probe above can tell a signed-out session from a live one.
      const rd = await redeem(p.email, emailed.code);
      expect(rd.body.ok).toBe(true);
      expect(await alive(), "control: signing in elsewhere ends the first session").toBe(401);
      await Promise.all([rd.api.dispose(), s.api.dispose()]);
    } finally { await bg.api.dispose(); }
  });
});
