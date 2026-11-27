// EMAIL FIRST: one entry screen, one uniform answer, and no account until a
// session that redeemed an ADDRESS PROOF submits the sign-up form.
//
// What is locked here (each with its control):
//   * POST /api/auth/code/request answers byte-identical bodies for an existing
//     account, a new work address, a new free-mail address and a reserved one;
//   * a new work address gets a proof (and a mail), a free-mail one gets neither;
//   * redeeming a proof creates NO user row; the grant it buys is single-use,
//     bound to the session that redeemed it, bound to that address, and expires;
//   * the join token rides the proof and the new account is enrolled;
//   * an invitation link's address registers through the same flow;
//   * an existing account with blank City / Job function is no longer gated.
const { test, expect, request } = require("./isolated-test");
const { freshCtx, apiLogin, TEST_DB_PATH, BASE } = require("./helpers");
const { cookieOf, sessionIdOf } = require("./admin-inflight-helpers");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const sql = (fn) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
};
let seq = 0;
const uniq = (tag) => `${tag}-${Date.now()}-${++seq}@efirst.example`;
const FORM = { firstName: "Ada", lastName: "Lovelace", company: "Analytical", title: "Engineer", country: "GB", timezone: "Europe/London" };

async function lastCode(api, email) {
  const r = await api.get("/api/test/last-login-code?email=" + encodeURIComponent(email));
  return r.ok() ? r.json() : null;
}
async function requestCode(api, csrf, email, extra) {
  await api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
  return api.post("/api/auth/code/request", { headers: H(csrf), data: { email, ...(extra || {}) } });
}
/** Request + redeem a proof on `api`; returns the redeem body and a fresh token. */
async function proveAddress(api, csrf, email, extra) {
  await requestCode(api, csrf, email, extra);
  const c = await lastCode(api, email);
  expect(c && c.via, `PRECONDITION: a proof was minted for ${email}`).toBe("proof");
  const rd = await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email, code: c.code } });
  const body = await rd.json();
  const t = (await (await api.get("/api/csrf-token")).json()).csrfToken;
  return { body, csrf: t, code: c.code };
}

test.describe("email-first sign-in — the address proof", () => {
  test("the code request answers byte-identically for existing, new, free-mail and reserved addresses", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    // An existing account, made through the real doors.
    const existing = uniq("exist");
    const { api: a1, csrf: c1 } = await freshCtx();
    const p = await proveAddress(a1, c1, existing);
    const reg = await a1.post("/api/register", { headers: H(p.csrf), data: { ...FORM, email: existing } });
    expect(reg.status(), await reg.text()).toBe(200);
    // A reserved address: someone's pending primary change.
    const reserved = uniq("reserved");
    sql(db => db.prepare("UPDATE users SET pending_email=? WHERE LOWER(email)=LOWER(?)").run(reserved, existing));

    const { api, csrf } = await freshCtx();
    const bodies = {};
    for (const [k, email] of [["existing", existing], ["new", uniq("new")], ["free", `free-${Date.now()}@gmail.com`], ["reserved", reserved]]) {
      const r = await requestCode(api, csrf, email);
      expect(r.status(), k).toBe(200);
      bodies[k] = await r.text();
    }
    expect(new Set(Object.values(bodies)).size, JSON.stringify(bodies)).toBe(1);
    expect(JSON.parse(bodies.new)).toEqual({ ok: true });
    await sa.dispose(); await a1.dispose(); await api.dispose();
  });

  test("a new WORK address gets a proof; a free-mail or reserved one gets nothing (and no row exists)", async () => {
    const { api, csrf } = await freshCtx();
    const work = uniq("work");
    const free = `nobody-${Date.now()}@gmail.com`;
    await requestCode(api, csrf, work);
    await requestCode(api, csrf, free);
    expect((await lastCode(api, work)).via, "control: the work address was sent a proof").toBe("proof");
    expect(await lastCode(api, free), "a free-mail address with no account is sent nothing").toBeNull();
    expect(sql(db => db.prepare("SELECT COUNT(*) n FROM email_proofs WHERE email_norm=?").get(free).n)).toBe(0);
    expect(sql(db => db.prepare("SELECT COUNT(*) n FROM email_proofs WHERE email_norm=?").get(work).n)).toBe(1);
    // Redeeming any code for the free address answers exactly like a wrong code.
    const rd = await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email: free, code: "ABCD2345" } });
    expect(await rd.json()).toEqual({ ok: false });
    await api.dispose();
  });

  test("redeeming a proof creates no account; the grant is single-use and address-bound", async () => {
    const { api, csrf } = await freshCtx();
    const email = uniq("grant");
    const p = await proveAddress(api, csrf, email);
    expect(p.body).toEqual({ ok: true, needsProfile: true, email });
    expect(sql(db => db.prepare("SELECT COUNT(*) n FROM users WHERE LOWER(email)=LOWER(?)").get(email).n),
      "no row until the form is submitted").toBe(0);
    // The proof itself is spent: the same code a second time is refused.
    const again = await api.post("/api/auth/code/redeem", { headers: H(p.csrf), data: { email, code: p.code } });
    expect((await again.json()).ok).toBe(false);
    // A body naming ANOTHER address still creates the PROVEN one.
    const r = await api.post("/api/register", { headers: H(p.csrf), data: { ...FORM, email: uniq("other") } });
    expect(r.status(), await r.text()).toBe(200);
    const d = await r.json();
    expect(d.ok).toBe(true);
    expect(d.email).toBe(email);
    const row = sql(db => db.prepare("SELECT verified, approved, nickname FROM users WHERE LOWER(email)=LOWER(?)").get(email));
    expect(row.verified, "the proven address is verified at creation").toBe(1);
    expect(row.nickname, "a nickname is suggested from the name").toMatch(/^ada_lov\d{3}$/);
    // Single use: the grant is gone (the session is now the new account's).
    const { api: b, csrf: bc } = await freshCtx();
    const second = await b.post("/api/register", { headers: H(bc), data: { ...FORM, email } });
    expect(second.status()).toBe(403);
    expect((await second.json()).code).toBe("email_proof_required");
    await api.dispose(); await b.dispose();
  });

  test("ten wrong guesses burn the code but keep the address's send budget, and the burn is on the record by domain and fingerprint", async () => {
    const { api, csrf } = await freshCtx();
    const email = uniq("burn");
    await requestCode(api, csrf, email);
    const c = await lastCode(api, email);
    expect(c && c.via, "PRECONDITION: a proof was minted").toBe("proof");
    const row = () => sql(db => db.prepare("SELECT code_hash, sends FROM email_proofs WHERE email_norm=?").get(email.toLowerCase()));
    const burns = () => sql(db => db.prepare("SELECT scope_id, details FROM orphan_events WHERE event_type='email_proof_burned' ORDER BY rowid").all());
    const requested = sql(db => db.prepare("SELECT scope_id FROM orphan_events WHERE event_type='email_proof_requested' ORDER BY rowid DESC LIMIT 1").get());
    const burnsBefore = burns().length;
    const wrong = c.code === "ABCDEFGH" ? "ABCDEFGJ" : "ABCDEFGH";
    for (let i = 1; i <= 10; i++) {
      const r = await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email, code: wrong } });
      expect((await r.json()).ok, `wrong guess ${i}`).toBe(false);
      expect(burns().length, `guess ${i}: burned only by the tenth`).toBe(burnsBefore + (i === 10 ? 1 : 0));
    }
    expect(row(), "the row stays until it expires, so its budget does").toMatchObject({ code_hash: "", sends: 1 });
    const held = await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email, code: c.code } });
    expect((await held.json()).ok, "the burned code no longer redeems").toBe(false);
    expect(burns().length, "a guess at a burned code records nothing more").toBe(burnsBefore + 1);
    // A burn no longer hands out a fresh budget: inside the re-send window nothing is minted...
    await api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
    expect(row().sends, "no new code inside the two-minute window").toBe(1);
    // ...and after it, the next code is this address's second, not a first.
    sql(db => db.prepare("UPDATE email_proofs SET last_sent_at=? WHERE email_norm=?").run(new Date(Date.now() - 3 * 60_000).toISOString(), email.toLowerCase()));
    await api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
    expect(row().sends).toBe(2);
    expect(row().code_hash, "a live code again").not.toBe("");
    const b = burns()[burnsBefore];
    const d = JSON.parse(b.details || "{}");
    expect(b.scope_id, "the burn names the address by the same fingerprint as its request").toBe(requested.scope_id);
    expect(d.domain).toBe("efirst.example");
    expect(d.ip, "with the request's source address").toBeTruthy();
    expect(JSON.stringify(b).toLowerCase().includes(email.toLowerCase()), "never the address itself").toBe(false);
    await api.dispose();
  });

  test("the grant is bound to the session that redeemed it, and it expires", async () => {
    const { api, csrf } = await freshCtx();
    const email = uniq("bound");
    const p = await proveAddress(api, csrf, email);
    // Another browser holding nothing cannot spend it.
    const { api: other, csrf: oc } = await freshCtx();
    const r1 = await other.post("/api/register", { headers: H(oc), data: { ...FORM, email } });
    expect(r1.status()).toBe(403);
    // Expire the grant in the session row (the only way to move its clock).
    const n = sql(db => {
      let changed = 0;
      for (const row of db.prepare("SELECT id, data FROM express_session").all()) {
        const s = JSON.parse(row.data);
        if (s.emailProof && s.emailProof.email === email) {
          s.emailProof.until = Date.now() - 1000;
          db.prepare("UPDATE express_session SET data=? WHERE id=?").run(JSON.stringify(s), row.id);
          changed++;
        }
      }
      return changed;
    });
    expect(n, "PRECONDITION: the grant lives in exactly one session").toBe(1);
    const r2 = await api.post("/api/register", { headers: H(p.csrf), data: { ...FORM, email } });
    expect(r2.status(), "an expired grant creates nothing").toBe(403);
    expect(sql(db => db.prepare("SELECT COUNT(*) n FROM users WHERE LOWER(email)=LOWER(?)").get(email).n)).toBe(0);
    await api.dispose(); await other.dispose();
  });

  test("a join token rides the proof: the new account is enrolled in that event", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = H(saCsrf);
    const cr = await sa.post("/api/admin/competitions", { headers: h, data: {
      name: `EF join ${Date.now()}`, event_kind: "booth", timezone: "UTC",
      start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600,
      self_enroll_enabled: true,
    } });
    expect(cr.ok(), await cr.text()).toBeTruthy();
    const compId = (await cr.json()).competition.id;
    const token = (await (await sa.get(`/api/admin/competitions/${compId}/self-enroll`)).json()).token;
    expect(token, "PRECONDITION: the event has a join token").toBeTruthy();
    const { api, csrf } = await freshCtx();
    const email = uniq("join");
    const p = await proveAddress(api, csrf, email, { joinToken: token });
    const r = await api.post("/api/register", { headers: H(p.csrf), data: { ...FORM, email } });
    expect(r.status(), await r.text()).toBe(200);
    const enrolled = sql(db => db.prepare(
      "SELECT COUNT(*) n FROM competition_users cu JOIN users u ON u.id=cu.user_id WHERE LOWER(u.email)=LOWER(?) AND cu.competition_id=?").get(email, compId).n);
    expect(enrolled, "enrolled through the event the code was requested for").toBe(1);
    await sa.dispose(); await api.dispose();
  });

  test("require_account_approval holds an ordinary sign-up, never a join-link one", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = H(saCsrf);
    const cr = await sa.post("/api/admin/competitions", { headers: h, data: {
      name: `EF approval ${Date.now()}`, event_kind: "booth", timezone: "UTC",
      start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600, self_enroll_enabled: true,
    } });
    expect(cr.ok(), await cr.text()).toBeTruthy();
    const compId = (await cr.json()).competition.id;
    const token = (await (await sa.get(`/api/admin/competitions/${compId}/self-enroll`)).json()).token;
    const signUp = async (viaJoin) => {
      const { api, csrf } = await freshCtx();
      const email = uniq("appr");
      const p = await proveAddress(api, csrf, email, viaJoin ? { joinToken: token } : {});
      const r = await api.post("/api/register", { headers: H(p.csrf), data: { ...FORM, email } });
      expect(r.status(), await r.text()).toBe(200);
      const body = await r.json();
      const row = sql(db => db.prepare("SELECT approved, verified FROM users WHERE LOWER(email)=LOWER(?)").get(email));
      await api.dispose();
      return { body, row, email };
    };
    // A held account that later signs in through the join link is approved then.
    const signInVia = async (email, extra) => {
      const { api, csrf } = await freshCtx();
      await api.post("/api/test/reset-origin-code-budget", { headers: H(csrf) });
      await requestCode(api, csrf, email, extra);
      const c = await lastCode(api, email);
      expect(c && c.via, `PRECONDITION: a sign-in code was mailed to ${email}`).not.toBe("proof");
      const rd = await (await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email, code: c.code } })).json();
      const row = sql(db => db.prepare("SELECT approved FROM users WHERE LOWER(email)=LOWER(?)").get(email));
      await api.dispose();
      return { rd, row };
    };
    try {
      const on = await sa.patch("/api/admin/settings", { headers: h, data: { require_account_approval: true } });
      expect(on.ok(), await on.text()).toBeTruthy();
      const joined = await signUp(true);
      expect(joined.row.approved, "setting ON: a join-link sign-up is approved at once").toBe(1);
      expect(joined.body.pendingApproval).toBeUndefined();
      const held = await signUp(false);
      expect(held.row.approved, "control — setting ON: an ordinary sign-up is held").toBe(0);
      expect(held.row.verified, "…but its address is proven").toBe(1);
      expect(held.body.pendingApproval).toBe(true);
      const plain = await signInVia(held.email, {});
      expect(plain.rd.error, "control — an ordinary sign-in still waits").toBe("pending_approval");
      expect(plain.row.approved).toBe(0);
      const viaLink = await signInVia(held.email, { joinToken: token });
      expect(viaLink.rd.ok, `a sign-in through the join link is let in: ${JSON.stringify(viaLink.rd)}`).toBe(true);
      expect(viaLink.row.approved, "…and approved").toBe(1);
      const off = await sa.patch("/api/admin/settings", { headers: h, data: { require_account_approval: false } });
      expect(off.ok()).toBeTruthy();
      const free = await signUp(false);
      expect(free.row.approved, "setting OFF: an ordinary sign-up is approved at once").toBe(1);
      expect(free.body.pendingApproval).toBeUndefined();
    } finally {
      await sa.patch("/api/admin/settings", { headers: h, data: { require_account_approval: false } });
      await sa.dispose();
    }
  });

  test("an invitation's address (even a free-mail one) registers through the same flow and claims it; another personal address naming it gets nothing", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const email = `invitee-${Date.now()}@gmail.com`;
    const inv = await sa.post("/api/admin/invitations", { headers: H(saCsrf), data: { emails: [email], competitionIds: [] } });
    expect(inv.ok(), await inv.text()).toBeTruthy();
    const invId = sql(db => db.prepare("SELECT id FROM invitations WHERE LOWER(email)=LOWER(?) ORDER BY created_at DESC").get(email).id);
    // The invitation counts only for ITS address: another personal address
    // naming the same invitation id is refused as free mail, as if no invitation
    // rode the request. (The invitee's own request below, with the same id, is
    // the control: the id itself is live and good.)
    {
      const other = `other-${Date.now()}@gmail.com`;
      const fp = "ep_" + require("crypto").createHash("sha256").update(other).digest("hex").slice(0, 12);
      const refusals = () => sql(db => db.prepare(
        "SELECT details FROM orphan_events WHERE event_type='email_proof_refused' AND scope_id=?"
      ).all(fp).map(x => JSON.parse(x.details || "{}").reason));
      expect(refusals(), "PRECONDITION: nothing recorded for this address yet").toEqual([]);
      const { api: oa, csrf: oc } = await freshCtx();
      const r = await requestCode(oa, oc, other, { invitationId: invId });
      expect(await r.json(), "the same uniform answer").toEqual({ ok: true });
      expect(await lastCode(oa, other), "another personal address is sent nothing on someone else's invitation").toBeNull();
      expect(sql(db => db.prepare("SELECT COUNT(*) n FROM email_proofs WHERE email_norm=?").get(other).n), "and holds no proof").toBe(0);
      expect(refusals(), "refused as free mail").toEqual(["free_email"]);
      await oa.dispose();
    }
    const { api, csrf } = await freshCtx();
    // Control: without the invitation a free-mail address is sent nothing.
    await requestCode(api, csrf, email);
    expect(await lastCode(api, email)).toBeNull();
    const p = await proveAddress(api, csrf, email, { invitationId: invId });
    expect(p.body.needsProfile).toBe(true);
    const r = await api.post("/api/register", { headers: H(p.csrf), data: { ...FORM, email, invitationId: invId } });
    expect(r.status(), await r.text()).toBe(200);
    expect(sql(db => db.prepare("SELECT used_at FROM invitations WHERE id=?").get(invId).used_at)).toBeTruthy();
    await sa.dispose(); await api.dispose();
  });

  test("with approval on, an invitee who signs up on the plain sign-in screen registers as the invitation (approved, enrolled); an uninvited sign-up is held (CONTROL)", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = H(saCsrf);
    const cr = await sa.post("/api/admin/competitions", { headers: h, data: {
      name: `EF plain invite ${Date.now()}`, event_kind: "tournament", timezone: "UTC",
      start_time: new Date(Date.now() - 60e3).toISOString(), duration_minutes: 600,
    } });
    expect(cr.ok(), await cr.text()).toBeTruthy();
    const compId = (await cr.json()).competition.id;
    const invitee = uniq("plaininv");
    const inv = await sa.post("/api/admin/invitations", { headers: h, data: { emails: [invitee], competitionIds: [compId] } });
    expect(inv.ok(), await inv.text()).toBeTruthy();
    const invId = sql(db => db.prepare("SELECT id FROM invitations WHERE LOWER(email)=LOWER(?) AND used_at IS NULL").get(invitee).id);
    try {
      const on = await sa.patch("/api/admin/settings", { headers: h, data: { require_account_approval: true } });
      expect(on.ok(), await on.text()).toBeTruthy();
      // The plain screen: no invitation id rides the code request or the form.
      const { api, csrf } = await freshCtx();
      const p = await proveAddress(api, csrf, invitee);
      const r = await api.post("/api/register", { headers: H(p.csrf), data: { ...FORM, email: invitee } });
      expect(r.status(), await r.text()).toBe(200);
      const body = await r.json();
      expect(body.ok, JSON.stringify(body)).toBe(true);
      expect(body.pendingApproval, "an invitation from an inviter who may approve (here the superadmin) is not held").toBeUndefined();
      const u = sql(db => db.prepare("SELECT id, approved, approved_by, invitation_id FROM users WHERE LOWER(email)=LOWER(?)").get(invitee));
      expect(u).toMatchObject({ approved: 1, approved_by: "invitation", invitation_id: invId });
      expect(sql(db => db.prepare("SELECT user_id FROM invitations WHERE id=?").get(invId)).user_id, "the invitation is this registration's").toBe(u.id);
      expect(sql(db => db.prepare("SELECT COUNT(*) n FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, u.id)).n,
        "enrolled in the invitation's event").toBe(1);
      // CONTROL: an uninvited address on the same screen is held.
      const { api: a2, csrf: c2 } = await freshCtx();
      const other = uniq("plainheld");
      const p2 = await proveAddress(a2, c2, other);
      const r2 = await a2.post("/api/register", { headers: H(p2.csrf), data: { ...FORM, email: other } });
      expect((await r2.json()).pendingApproval, "control: an uninvited sign-up waits").toBe(true);
      await api.dispose(); await a2.dispose();
    } finally {
      await sa.patch("/api/admin/settings", { headers: h, data: { require_account_approval: false } });
      await sa.dispose();
    }
  });

  // A HELD SIGN-UP CLAIMS NOTHING. No request reaches the ordinary held branch
  // with a live invitation to the address any more (the live-invitation lookup
  // takes it, and one address holds one live invitation), so its order is held
  // by source: the held branch answers before the first invitation claim. The
  // held-with-a-live-invitation case that remains (an inviter who may not
  // approve) is held by behaviour in tests/enrol-only-approval.api.spec.js, and a
  // link closed after the code was entered in tests/join-link-untie.api.spec.js.
  test("a held sign-up claims nothing: in POST /api/register the held branch returns before the first invitation claim", async () => {
    const fs = require("fs");
    const path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const src = stripJsComments(fs.readFileSync(path.join(__dirname, "..", "routes", "auth.js"), "utf8"));
    const open = src.indexOf('app.post("/api/register"');
    expect(open, "PRECONDITION: the register handler is found").toBeGreaterThan(-1);
    const close = src.indexOf("\n});", open);
    expect(close, "PRECONDITION: …and its end").toBeGreaterThan(open);
    const handler = src.slice(open, close);
    const held = handler.indexOf("if (!_approved) {");
    const claimCall = ["claimInvitationsForAccount", "(_newUser"].join("");
    const claim = handler.indexOf(claimCall);
    // Anti-vacuity floor: each is found exactly once, or a rename passes silently.
    expect(held, "the ordinary held branch is found").toBeGreaterThan(-1);
    expect(handler.indexOf("if (!_approved) {", held + 1), "…once").toBe(-1);
    expect(claim, "the ordinary sign-up's invitation claim is found").toBeGreaterThan(-1);
    expect(handler.indexOf(claimCall, claim + 1), "…once").toBe(-1);
    // The held block, by its braces, and the return inside it.
    let depth = 0, blockEnd = -1;
    for (let i = handler.indexOf("{", held); i < handler.length; i++) {
      if (handler[i] === "{") depth++;
      else if (handler[i] === "}" && --depth === 0) { blockEnd = i; break; }
    }
    expect(blockEnd, "the held block closes").toBeGreaterThan(held);
    const block = handler.slice(held, blockEnd);
    expect(block, "the held block answers and returns").toMatch(/return res\.json\(\{ ok: true, pendingApproval: true/);
    expect(claim, "the claim comes after the held block, so a held account claims nothing").toBeGreaterThan(blockEnd);
  });

  test("an invitation id carried over to a DIFFERENT proven address is no invitation: the sign-up goes through, the invitation stays live", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const h = H(saCsrf);
    const invited = uniq("oldaddr");
    const inv = await sa.post("/api/admin/invitations", { headers: h, data: { emails: [invited], competitionIds: [] } });
    expect(inv.ok(), await inv.text()).toBeTruthy();
    const invId = sql(db => db.prepare("SELECT id FROM invitations WHERE LOWER(email)=LOWER(?) AND used_at IS NULL").get(invited).id);
    // The SPA keeps the invitation id from the link while the person types a
    // different address: it rides the code request and the form.
    const { api, csrf } = await freshCtx();
    const typed = uniq("newaddr");
    const p = await proveAddress(api, csrf, typed, { invitationId: invId });
    const r = await api.post("/api/register", { headers: H(p.csrf), data: { ...FORM, email: typed, invitationId: invId } });
    expect(r.status(), `the different address registers: ${await r.text()}`).toBe(200);
    expect((await r.json()).ok).toBe(true);
    expect(sql(db => db.prepare("SELECT invitation_id FROM users WHERE LOWER(email)=LOWER(?)").get(typed)).invitation_id, "not as the invitation").toBeNull();
    expect(sql(db => db.prepare("SELECT used_at FROM invitations WHERE id=?").get(invId)).used_at, "the invitation stays live for its own address").toBeNull();
    // CONTROL: an id that names no invitation at all is still refused, as before.
    const { api: a2, csrf: c2 } = await freshCtx();
    const typed2 = uniq("bogus");
    const p2 = await proveAddress(a2, c2, typed2);
    const r2 = await a2.post("/api/register", { headers: H(p2.csrf), data: { ...FORM, email: typed2, invitationId: "00000000-0000-4000-8000-000000000000" } });
    expect(r2.status(), "control: an unknown invitation is the caller's error").toBe(409);
    await sa.dispose(); await api.dispose(); await a2.dispose();
  });

  test("a live desk code is not superseded by Continue, for its whole life (the walk-up types it in)", async () => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const email = uniq("desk");
    const d = await sa.post("/api/admin/participants/desk-invite", { headers: H(saCsrf), data: { email, firstName: "Desk", lastName: "Walkup" } });
    expect(d.ok(), await d.text()).toBeTruthy();
    const via = () => sql(db => db.prepare("SELECT login_code_via v FROM users WHERE LOWER(email)=LOWER(?)").get(email).v);
    expect(via(), "PRECONDITION: the desk shortcut showed a desk code").toBe("desk");
    const { api, csrf } = await freshCtx();
    await api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
    expect(via(), "Continue keeps the desk code").toBe("desk");
    // Past the in-process two-minute re-send hold: still kept, for its whole life.
    await api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
    await api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
    expect(via(), "Continue keeps a LIVE desk code whenever it is pressed").toBe("desk");
    // Control: once the desk code has expired, Continue mails a new one.
    sql(db => db.prepare("UPDATE users SET login_code_at=? WHERE LOWER(email)=LOWER(?)").run(new Date(Date.now() - 11 * 60_000).toISOString(), email));
    await api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
    expect(via(), "control: an expired desk code is replaced by an emailed one").toBe("email");
    await sa.dispose(); await api.dispose();
  });

  test("an existing account with blank City and Job function is no longer gated (the gate only shrinks)", async () => {
    const { api, csrf } = await freshCtx();
    const email = uniq("blank");
    const p = await proveAddress(api, csrf, email);
    const r = await api.post("/api/register", { headers: H(p.csrf), data: { ...FORM, email, jobFunction: "", city: "" } });
    expect(r.status(), await r.text()).toBe(200);
    sql(db => db.prepare("UPDATE users SET city=NULL, job_function=NULL WHERE LOWER(email)=LOWER(?)").run(email));
    const me = await (await api.get("/api/me")).json();
    expect(me.missing_fields, "neither field is demanded of an ordinary account").toEqual([]);
    // Control: a blank COMPANY is still demanded.
    sql(db => db.prepare("UPDATE users SET company='' WHERE LOWER(email)=LOWER(?)").run(email));
    await new Promise(res => setTimeout(res, 2100));   // outwait the 2 s /api/me cache
    const me2 = await (await api.get("/api/me")).json();
    expect(me2.missing_fields).toContain("company");
    await api.dispose();
  });

  // A REDEEM STARTS A NEW SESSION, so an id planted in the browser before it (a
  // shared kiosk, a fixed cookie) inherits neither the sign-up grant nor the
  // sign-in. The planted context sends the redeeming browser's pre-redeem cookie
  // and that session's own CSRF token; that token was accepted on the cookie
  // before the redeem, so the planted context really holds the old session.
  async function plantedCopy(api) {
    const planted = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { cookie: await cookieOf(api) } });
    const t = (await (await planted.get("/api/csrf-token")).json()).csrfToken;
    return { planted, csrf: t };
  }

  test("redeeming an address proof starts a new session: a cookie from before it holds no grant", async () => {
    const { api, csrf } = await freshCtx();
    const email = uniq("planted");
    const sid0 = await sessionIdOf(api);
    expect(sid0, "PRECONDITION: the browser holds a session before the redeem").toBeTruthy();
    const { planted, csrf: plantedCsrf } = await plantedCopy(api);
    expect(plantedCsrf, "PRECONDITION: the planted copy was issued a token on that session").toBe(csrf);
    try {
      const p = await proveAddress(api, csrf, email);
      expect(p.body.needsProfile, "PRECONDITION: the proof was redeemed").toBe(true);
      expect(await sessionIdOf(api), "the redeem moved the browser to a new session id").not.toBe(sid0);
      const r = await planted.post("/api/register", { headers: H(plantedCsrf), data: { ...FORM, email } });
      expect(r.status(), `the planted cookie cannot spend the grant: ${await r.text()}`).toBe(403);
      expect(sql(db => db.prepare("SELECT COUNT(*) n FROM users WHERE LOWER(email)=LOWER(?)").get(email).n),
        "and no account was made through it").toBe(0);
      // CONTROL: the browser that redeemed registers with its new token.
      const ok = await api.post("/api/register", { headers: H(p.csrf), data: { ...FORM, email } });
      expect(ok.status(), await ok.text()).toBe(200);
    } finally { await planted.dispose(); await api.dispose(); }
  });

  test("a code sign-in starts a new session: a cookie from before it is signed out", async () => {
    // An account made through the real doors, then signed out of.
    const email = uniq("plantsignin");
    {
      const { api: a0, csrf: c0 } = await freshCtx();
      const p0 = await proveAddress(a0, c0, email);
      const reg = await a0.post("/api/register", { headers: H(p0.csrf), data: { ...FORM, email } });
      expect(reg.status(), await reg.text()).toBe(200);
      await a0.dispose();
    }
    const { api, csrf } = await freshCtx();
    const sid0 = await sessionIdOf(api);
    const { planted } = await plantedCopy(api);
    try {
      expect((await planted.get("/api/me")).status(), "PRECONDITION: the planted session is anonymous").toBe(401);
      await requestCode(api, csrf, email);
      const c = await lastCode(api, email);
      expect(c && c.via, "PRECONDITION: a sign-in code was mailed").not.toBe("proof");
      const rd = await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email, code: c.code } });
      expect((await rd.json()).ok, "PRECONDITION: the code signed in").toBe(true);
      expect(await sessionIdOf(api), "the sign-in moved the browser to a new session id").not.toBe(sid0);
      expect((await planted.get("/api/me")).status(), "the planted cookie is not signed in").toBe(401);
      // CONTROL: the browser that redeemed is.
      expect((await api.get("/api/me")).status()).toBe(200);
    } finally { await planted.dispose(); await api.dispose(); }
  });
});

test.describe("no screen promises that instant join skips or postpones the email check", () => {
  // Every sign-up proves its address with a code BEFORE the account exists, and
  // a join-link sign-up is approved whatever the approval setting, so the
  // retired "Allow instant join" switch never skipped verification nor held
  // anyone for approval (operator ruling, 14 Nov 2026, retired it). A label
  // saying either sends an organiser to a control that does what it does not.
  test("the organiser copy for instant join makes neither claim", () => {
    const fs = require("fs");
    const path = require("path");
    const { stripJsComments } = require("./doc-registry");
    const FALSE_CLAIMS = /skips? (?:the )?email verification|confirm(?:s)? (?:their|your) email later|verify (?:their|your) email later/i;
    // Anti-vacuity: both former labels are seen; the true walk-up copy is not.
    expect(FALSE_CLAIMS.test("Allow instant join — let new users skip email verification")).toBe(true);
    expect(FALSE_CLAIMS.test("Walk-ups play at once (confirm their email later)")).toBe(true);
    expect(FALSE_CLAIMS.test("Walk-ups confirm their email first.")).toBe(false);
    const root = path.join(__dirname, "..", "public", "js");
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) files.push(p); } };
    walk(root);
    expect(files.length, "the SPA's modules were read").toBeGreaterThan(40);
    const hits = [];
    for (const f of files) {
      const s = stripJsComments(fs.readFileSync(f, "utf8"));
      s.split("\n").forEach((line, i) => { if (FALSE_CLAIMS.test(line)) hits.push(`${path.relative(root, f)}:${i + 1}`); });
    }
    expect(hits, "copy claiming instant join skips or postpones the email check").toEqual([]);
  });
});
