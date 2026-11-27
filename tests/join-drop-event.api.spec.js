"use strict";

// "NOT YOUR EVENT? CONTINUE WITHOUT IT" UNTIES A CODE ALREADY MAILED WITH THE
// EVENT (operator rulings, 18 and 20 Nov 2026). A code (or, for an address no
// account holds, an address proof) requested through a join link, QR or event
// code is bound to that event: redeeming it enrols. POST
// /api/auth/code/drop-event unties it for the browser whose request minted it
// (the session's `codeRequests` note), or for this session's own sign-up grant:
//   • the code still signs in, and enrols nobody; the browser that minted it is
//     the only one that can untie it (another browser, or one whose request was
//     suppressed and minted nothing, unties nothing);
//   • an earlier join (an event already joined, a pending join) is untouched;
//   • a new address's proof and its sign-up grant are untied the same way;
//   • every answer is the same 200 {ok:true}, and the code request's answer and
//     cookie are the same whatever happened.
// And (sweep #198) a code's event counts only in a browser that asked for that
// event itself: redeemed anywhere else it signs in, or makes the new account,
// in no event and approves nobody through the link (the last describe).
const { test, expect } = require("./isolated-test");
const { BASE, TEST_DB_PATH, apiLogin } = require("./helpers");
const { makeParticipant, makeCompetition, H } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const sql = (fn) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
};
let seq = 0;
const stamp = () => `${Date.now().toString(36)}${++seq}`;

/** An anonymous browser: its own session, a CSRF token, and the code doors. */
async function browserSession(playwright) {
  const ctx = await playwright.request.newContext({ baseURL: BASE });
  const csrf = (await (await ctx.get("/api/csrf-token")).json()).csrfToken;
  const h = { "x-csrf-token": csrf, "content-type": "application/json" };
  return {
    ctx, h,
    request: (email, joinToken) => ctx.post("/api/auth/code/request", { headers: h, data: { email, ...(joinToken ? { joinToken } : {}) } }),
    drop: (data) => ctx.post("/api/auth/code/drop-event", { headers: h, ...(data === undefined ? {} : { data }) }),
    async redeem(email) {
      const c = await (await ctx.get("/api/test/last-login-code?email=" + encodeURIComponent(email))).json();
      const out = await (await ctx.post("/api/auth/code/redeem", { headers: h, data: { email, code: c.code } })).json();
      // The redeem regenerates the session: the next write needs its new token.
      h["x-csrf-token"] = (await (await ctx.get("/api/csrf-token")).json()).csrfToken;
      return out;
    },
    dispose: () => ctx.dispose(),
  };
}

async function joinEvent(label) {
  const s = await apiLogin("superadmin");
  try {
    const A = await makeCompetition(s.api, s.csrf, label, { self_enroll_enabled: true });
    const token = sql(db => db.prepare("SELECT self_enroll_token AS t FROM competitions WHERE id=?").get(A.id).t);
    return { s, A, token };
  } catch (e) { await s.api.dispose(); throw e; }
}
const boundTo = (uid) => sql(db => db.prepare("SELECT login_code_comp_id AS c FROM users WHERE id=?").get(uid).c);
const codeHash = (uid) => sql(db => db.prepare("SELECT login_code_hash AS h FROM users WHERE id=?").get(uid).h);
const inEvent = (compId, uid) => !!sql(db => db.prepare("SELECT 1 AS x FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uid));
const resetSuppression = async (b) => b.ctx.post("/api/test/reset-recent-code-sends", { headers: b.h });

test.describe("Not your event? unties a code already mailed with the event", () => {
  test("the browser that asked unties its code: it still signs in, and joins nothing", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("dropA");
    const p = await makeParticipant(s.api, s.csrf, "dropp");
    const q = await makeParticipant(s.api, s.csrf, "dropq");
    await s.api.dispose();
    const b = await browserSession(playwright);
    try {
      await resetSuppression(b);
      expect((await b.request(p.email, token)).ok()).toBeTruthy();
      expect(boundTo(p.id), "PRECONDITION: the code is bound to the event").toBe(A.id);
      const h0 = codeHash(p.id);
      const d = await b.drop({ email: p.email });
      expect(d.status()).toBe(200);
      expect(await d.text()).toBe('{"ok":true}');
      expect(boundTo(p.id), "untied").toBeNull();
      expect(codeHash(p.id), "the code itself is unchanged").toBe(h0);
      const r = await b.redeem(p.email);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(inEvent(A.id, p.id), "signed in without joining").toBe(false);
      const ev = sql(db => db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='login_code_event_dropped'").all(p.id)).map(x => JSON.parse(x.details));
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ competition_id: A.id });
      expect(ev[0].ip, "the request context is recorded").toBeTruthy();
    } finally { await b.dispose(); }
    // CONTROL: the same request without the drop joins.
    const b2 = await browserSession(playwright);
    try {
      await resetSuppression(b2);
      await b2.request(q.email, token);
      expect((await b2.redeem(q.email)).ok).toBe(true);
      expect(inEvent(A.id, q.id), "CONTROL: the bound code enrols").toBe(true);
    } finally { await b2.dispose(); }
  });

  test("no other browser can untie it, not even one that asked again and was refused", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("dropB");
    const p = await makeParticipant(s.api, s.csrf, "dropother");
    await s.api.dispose();
    const mine = await browserSession(playwright), other = await browserSession(playwright), asker = await browserSession(playwright);
    try {
      await resetSuppression(mine);
      await mine.request(p.email, token);
      expect(boundTo(p.id)).toBe(A.id);
      const d = await other.drop({ email: p.email });
      expect(await d.text(), "the same answer").toBe('{"ok":true}');
      expect(boundTo(p.id), "an address alone unties nothing").toBe(A.id);
      // A browser whose own request was suppressed (inside two minutes) minted nothing.
      expect((await asker.request(p.email, token)).ok()).toBeTruthy();
      await asker.drop({ email: p.email });
      expect(boundTo(p.id), "a suppressed request holds no code to untie").toBe(A.id);
      expect(sql(db => db.prepare("SELECT COUNT(*) AS n FROM user_events WHERE user_id=? AND event_type='login_code_event_dropped'").get(p.id).n)).toBe(0);
      expect((await mine.redeem(p.email)).ok).toBe(true);
      expect(inEvent(A.id, p.id), "the code still enrols as it was minted").toBe(true);
    } finally { await mine.dispose(); await other.dispose(); await asker.dispose(); }
  });

  test("it unties only the address asked for, of the ones this browser asked about, and leaves an earlier join alone", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("dropC");
    const B = await makeCompetition(s.api, s.csrf, "dropCearlier");
    const C = await makeCompetition(s.api, s.csrf, "dropCpending", { self_enroll_enabled: true });
    const p = await makeParticipant(s.api, s.csrf, "dropcp");
    const q = await makeParticipant(s.api, s.csrf, "dropcq");
    const as = await s.api.post("/api/admin/competitions/assign", { headers: H(s.csrf), data: { userIds: [p.id], competitionIds: [B.id] } });
    expect((await as.json()).assigned, "PRECONDITION: p already joined B").toBe(1);
    await s.api.dispose();
    // A pending join from an earlier registration (the marker the sign-in consumes).
    sql(db => db.prepare("UPDATE users SET pending_self_enroll_comp_id=? WHERE id=?").run(C.id, p.id));
    const b = await browserSession(playwright);
    try {
      await resetSuppression(b);
      // One browser asks about both addresses: two notes in one session.
      await b.request(p.email, token);
      await b.request(q.email, token);
      expect([boundTo(p.id), boundTo(q.id)], "PRECONDITION").toEqual([A.id, A.id]);
      await b.drop({ email: q.email });
      expect(boundTo(q.id), "the address asked for is untied").toBeNull();
      expect(boundTo(p.id), "the other address's code is untouched").toBe(A.id);
      await b.drop({ email: p.email });
      expect(boundTo(p.id)).toBeNull();
      expect((await b.redeem(p.email)).ok).toBe(true);
      expect(inEvent(A.id, p.id)).toBe(false);
      expect(inEvent(B.id, p.id), "an event already joined stays").toBe(true);
      expect(inEvent(C.id, p.id), "the earlier pending join still happens").toBe(true);
    } finally { await b.dispose(); }
  });

  test("a code another browser re-minted since is not this browser's to untie (a sign-in code and a proof)", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("dropR");
    const p = await makeParticipant(s.api, s.csrf, "dropremint");
    await s.api.dispose();
    const email = `remint-${stamp()}@acme.com`;
    const proofEvent = () => sql(db => db.prepare("SELECT join_comp_id AS c FROM email_proofs WHERE email_norm=?").get(email)?.c);
    const first = await browserSession(playwright), owner = await browserSession(playwright);
    try {
      await resetSuppression(first);
      await first.request(p.email, token);
      await first.request(email, token);
      const h0 = codeHash(p.id);
      // Two minutes on, the owner asks again through the same link: a new code and
      // a new proof, both bound to the event.
      await resetSuppression(owner);
      await owner.request(p.email, token);
      await owner.request(email, token);
      expect(codeHash(p.id), "PRECONDITION: the code was re-minted").not.toBe(h0);
      expect([boundTo(p.id), proofEvent()], "PRECONDITION").toEqual([A.id, A.id]);
      await first.drop({ email: p.email });
      await first.drop({ email });
      expect(boundTo(p.id), "the owner's new code keeps its event").toBe(A.id);
      expect(proofEvent(), "the owner's new proof keeps its event").toBe(A.id);
      expect((await owner.redeem(p.email)).ok).toBe(true);
      expect(inEvent(A.id, p.id), "and still enrols").toBe(true);
    } finally { await first.dispose(); await owner.dispose(); }
  });

  test("a new address: its proof, and then its sign-up grant, are untied the same way", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("dropD");
    await s.api.dispose();
    const local = `newcomer-${stamp()}`;
    const email = `${local}@acme.com`;
    const proofEvent = () => sql(db => db.prepare("SELECT join_comp_id AS c FROM email_proofs WHERE email_norm=?").get(email)?.c);
    const b = await browserSession(playwright), other = await browserSession(playwright);
    try {
      await resetSuppression(b);
      await b.request(email, token);
      expect(proofEvent(), "PRECONDITION: the proof is bound").toBe(A.id);
      await other.drop({ email });
      expect(proofEvent(), "CONTROL: another browser unties nothing").toBe(A.id);
      await b.drop({ email });
      expect(proofEvent()).toBeNull();
      const audit = sql(db => db.prepare("SELECT details FROM orphan_events WHERE event_type='email_proof_event_dropped' ORDER BY rowid DESC LIMIT 1").get());
      const det = JSON.parse(audit.details);
      expect(det).toMatchObject({ stage: "proof", domain: "acme.com", competition_id: A.id });
      expect(audit.details, "the address itself is never recorded").not.toContain(local);
      const rd = await b.redeem(email);
      expect(rd).toMatchObject({ ok: true, needsProfile: true });
      const reg = await b.ctx.post("/api/register", { headers: b.h, data: {
        firstName: "New", lastName: "Comer", company: "Acme", title: "Engineer", country: "GB", timezone: "Europe/London" } });
      expect(reg.ok(), await reg.text()).toBeTruthy();
      const u = sql(db => db.prepare("SELECT id, registration_competition_id AS r FROM users WHERE email=?").get(email));
      expect(u.r, "registered through no event").toBeNull();
      expect(inEvent(A.id, u.id)).toBe(false);
    } finally { await b.dispose(); await other.dispose(); }

    // THE GRANT: a proof redeemed WITH the event, then "Not your event?" on the form.
    const email2 = `newcomer-${stamp()}@acme.com`;
    const g = await browserSession(playwright);
    try {
      await resetSuppression(g);
      await g.request(email2, token);
      expect((await g.redeem(email2)).ok).toBe(true);
      expect((await g.drop({ email: email2 })).ok()).toBeTruthy();
      const reg = await g.ctx.post("/api/register", { headers: g.h, data: {
        firstName: "Grant", lastName: "Holder", company: "Acme", title: "Engineer", country: "GB", timezone: "Europe/London" } });
      expect(reg.ok(), await reg.text()).toBeTruthy();
      const u = sql(db => db.prepare("SELECT id, registration_competition_id AS r FROM users WHERE email=?").get(email2));
      expect(u.r).toBeNull();
      expect(inEvent(A.id, u.id), "the sign-up joined nothing").toBe(false);
    } finally { await g.dispose(); }
  });

  test("every answer is the same, and so is the code request's, whatever happened", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("dropE");
    const p = await makeParticipant(s.api, s.csrf, "dropuni");
    await s.api.dispose();
    const b = await browserSession(playwright);
    try {
      await resetSuppression(b);
      const answers = [];
      const ask = async (email, jt) => {
        const r = await b.request(email, jt);
        answers.push({ email, status: r.status(), body: await r.text(), cookie: r.headersArray().some(x => x.name.toLowerCase() === "set-cookie") });
      };
      await ask(p.email, token);                                // sent (bound)
      await ask(p.email, token);                                // recently sent: suppressed
      await ask(`nobody-${stamp()}@acme.com`, token);           // an address no account holds: a proof
      await ask(`someone-${stamp()}@gmail.com`, token);         // free mail, no invitation: nothing sent
      for (const a of answers) expect({ status: a.status, body: a.body, cookie: a.cookie }, a.email).toEqual({ status: 200, body: '{"ok":true}', cookie: true });
      // Every well-formed drop answers alike, cookie included, whether this browser
      // was mailed a code (first p), was mailed one already untied (p again), was
      // sent nothing (the free-mail address) or never asked (a new address): for
      // free mail, "was sent something" would say whether an account holds it.
      const free = answers[3].email;
      for (const email of [p.email, p.email, free, answers[2].email, `never-${stamp()}@acme.com`]) {
        const d = await b.drop({ email });
        expect({ status: d.status(), body: await d.text(), cookie: d.headersArray().some(x => x.name.toLowerCase() === "set-cookie") }, email)
          .toEqual({ status: 200, body: '{"ok":true}', cookie: true });
      }
      for (const data of [{ email: 42 }, { email: "not-an-address" }, {}, undefined]) {
        const d = await b.drop(data);
        expect(d.status(), JSON.stringify(data)).toBe(200);
        expect(await d.text(), JSON.stringify(data)).toBe('{"ok":true}');
      }
      expect(boundTo(p.id), "the first drop untied; the rest changed nothing and said the same").toBeNull();
    } finally { await b.dispose(); }
    expect(A.id).toBeTruthy();
  });
});

// A CODE'S EVENT COUNTS ONLY FOR THE BROWSER THAT ASKED FOR IT (sweep #198).
// Anyone holding an event's public join link can ask for a code for any address
// with that event named, and the mail goes to the address's owner. Redeemed in a
// browser that did not ask for that event itself (its own `codeRequests` note),
// the code signs in, or proves a new address, as if it carried no event: it
// enrols nobody and approves nobody through the link (routes/auth.js
// `_sessionNamedEvent`). A browser that asked for the same event still joins,
// even when another browser's code came first.
test.describe("a code another browser asked for, with an event, joins nobody here", () => {
  const selfEnrolled = (uid, compId) => sql(db => db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='self_enrolled'").all(uid))
    .map(x => JSON.parse(x.details)).filter(d => d.competition_id === compId).length;

  test("redeemed in a browser that never asked, the stranger's code signs in and joins nothing; asked for here, it joins (CONTROL)", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("originA");
    const p = await makeParticipant(s.api, s.csrf, "originp");
    const q = await makeParticipant(s.api, s.csrf, "originq");
    await s.api.dispose();
    const stranger = await browserSession(playwright), owner = await browserSession(playwright);
    try {
      await resetSuppression(stranger);
      expect((await stranger.request(p.email, token)).ok()).toBeTruthy();
      expect(boundTo(p.id), "PRECONDITION: the stranger's request bound the owner's code to the event").toBe(A.id);
      const r = await owner.redeem(p.email);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(inEvent(A.id, p.id), "the owner is signed in and joined to nothing").toBe(false);
      expect(selfEnrolled(p.id, A.id), "…and no join is recorded").toBe(0);
    } finally { await stranger.dispose(); await owner.dispose(); }
    // CONTROL: the same code, asked for in the browser that types it, joins.
    const own = await browserSession(playwright);
    try {
      await resetSuppression(own);
      await own.request(q.email, token);
      expect((await own.redeem(q.email)).ok).toBe(true);
      expect(inEvent(A.id, q.id), "CONTROL: a code asked for here with the event joins it").toBe(true);
      expect(selfEnrolled(q.id, A.id)).toBe(1);
    } finally { await own.dispose(); }
  });

  test("the owner's own plain request, held back by the stranger's code, joins nothing; their own request for the same event joins", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("originB");
    const p = await makeParticipant(s.api, s.csrf, "originbp");
    const q = await makeParticipant(s.api, s.csrf, "originbq");
    await s.api.dispose();
    const stranger = await browserSession(playwright), owner = await browserSession(playwright), device = await browserSession(playwright);
    try {
      await resetSuppression(stranger);
      await stranger.request(p.email, token);
      // The owner presses Continue on the plain sign-in screen inside two
      // minutes: the request is held back, and the code in their inbox is the
      // stranger's, bound to the event.
      await owner.request(p.email);
      expect(boundTo(p.id), "PRECONDITION: the code is still the stranger's, bound to the event").toBe(A.id);
      expect((await owner.redeem(p.email)).ok).toBe(true);
      expect(inEvent(A.id, p.id), "a browser that asked for no event joins none").toBe(false);
      // CONTROL: on another device the owner opened the same join link: that
      // browser asked for the event (its request held back by the first one's
      // code), so the code joins there.
      await resetSuppression(stranger);
      await stranger.request(q.email, token);
      await device.request(q.email, token);
      expect((await device.redeem(q.email)).ok).toBe(true);
      expect(inEvent(A.id, q.id), "CONTROL: a browser that asked for the same event joins it").toBe(true);
    } finally { await stranger.dispose(); await owner.dispose(); await device.dispose(); }
  });

  test("a browser that asked plainly first, then for the event (held back by its other device's code), joins it with that code", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("originF");
    const p = await makeParticipant(s.api, s.csrf, "originfp");
    await s.api.dispose();
    const owner = await browserSession(playwright), device = await browserSession(playwright);
    try {
      // 1. Plainly (no event): a code is minted for this browser.
      await resetSuppression(owner);
      await owner.request(p.email);
      expect(boundTo(p.id), "PRECONDITION: the first code carries no event").toBeNull();
      // 2. Two minutes on, the person's other device asks through the join link:
      //    a new code, bound to the event, replaces the first.
      await resetSuppression(device);
      await device.request(p.email, token);
      expect(boundTo(p.id), "PRECONDITION: the code in the inbox now carries the event").toBe(A.id);
      // 3. This browser now asks through the join link too, inside two minutes:
      //    held back (the code is on its way), but it asked for the event.
      await owner.request(p.email, token);
      expect(boundTo(p.id), "PRECONDITION: held back, so the code is the device's").toBe(A.id);
      expect((await owner.redeem(p.email)).ok).toBe(true);
      expect(inEvent(A.id, p.id), "a browser that asked for the event joins it, whatever it asked before").toBe(true);
    } finally { await owner.dispose(); await device.dispose(); }
  });

  test("'Not your event?' in this browser means no event here, even for a code it could not untie, and even after the event is put back", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("originC");
    const p = await makeParticipant(s.api, s.csrf, "origincp");
    const q = await makeParticipant(s.api, s.csrf, "origincq");
    await s.api.dispose();
    const stranger = await browserSession(playwright), owner = await browserSession(playwright);
    try {
      // (1) The stranger's code came first; the owner asked for the event too
      // (held back), then said "Not your event?". The code is not this
      // browser's to untie, so it stays bound, and still joins nothing here.
      await resetSuppression(stranger);
      await stranger.request(p.email, token);
      await owner.request(p.email, token);
      await owner.drop({ email: p.email });
      expect(boundTo(p.id), "PRECONDITION: another browser's code is not untied").toBe(A.id);
      expect((await owner.redeem(p.email)).ok).toBe(true);
      expect(inEvent(A.id, p.id), "the browser said no event, so it joins none").toBe(false);
      // (2) The owner's own code, untied; two minutes on, the stranger asks
      // again with the event, minting a new code bound to it: no join here.
      await resetSuppression(owner);
      await owner.request(q.email, token);
      await owner.drop({ email: q.email });
      expect(boundTo(q.id), "PRECONDITION: untied").toBeNull();
      await resetSuppression(stranger);
      await stranger.request(q.email, token);
      expect(boundTo(q.id), "PRECONDITION: the stranger's new code carries the event again").toBe(A.id);
      expect((await owner.redeem(q.email)).ok).toBe(true);
      expect(inEvent(A.id, q.id), "the event put back by another browser joins nothing here").toBe(false);
    } finally { await stranger.dispose(); await owner.dispose(); }
  });

  test("with approval on, the stranger's code does not approve a held account through the join link; asked for here, it does (CONTROL)", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("originD");
    const p = await makeParticipant(s.api, s.csrf, "origindp");
    const q = await makeParticipant(s.api, s.csrf, "origindq");
    // Two held accounts: their address proven, waiting for an organiser.
    sql(db => db.prepare("UPDATE users SET approved=0, approved_at=NULL, approved_by=NULL WHERE id IN (?, ?)").run(p.id, q.id));
    const setApproval = async (on) => {
      const r = await s.api.patch("/api/admin/settings", { headers: H(s.csrf), data: { require_account_approval: on } });
      expect(r.ok(), await r.text()).toBeTruthy();
    };
    const approved = (uid) => sql(db => db.prepare("SELECT approved FROM users WHERE id=?").get(uid).approved);
    const stranger = await browserSession(playwright), owner = await browserSession(playwright), own = await browserSession(playwright);
    try {
      await setApproval(true);
      await resetSuppression(stranger);
      await stranger.request(p.email, token);
      const r = await owner.redeem(p.email);
      expect(r, "the owner still waits for an organiser").toMatchObject({ ok: false, error: "pending_approval" });
      expect(approved(p.id), "…the join link approved nothing").toBe(0);
      expect(inEvent(A.id, p.id)).toBe(false);
      // CONTROL: the held account's own browser came through the join link.
      await resetSuppression(own);
      await own.request(q.email, token);
      const rq = await own.redeem(q.email);
      expect(rq.ok, `CONTROL: through its own join link a held account is let in: ${JSON.stringify(rq)}`).toBe(true);
      expect(approved(q.id), "CONTROL: …and approved").toBe(1);
      expect(inEvent(A.id, q.id)).toBe(true);
    } finally {
      await setApproval(false);
      await s.api.dispose();
      await stranger.dispose(); await owner.dispose(); await own.dispose();
    }
  });

  test("a new address: a proof another browser asked for with the event makes an account in no event; asked for here, the account joins (CONTROL)", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("originE");
    await s.api.dispose();
    const FORM = { firstName: "New", lastName: "Comer", company: "Acme", title: "Engineer", country: "GB", timezone: "Europe/London" };
    const stranger = await browserSession(playwright), owner = await browserSession(playwright), own = await browserSession(playwright);
    try {
      const email = `origin-new-${stamp()}@acme.com`;
      await resetSuppression(stranger);
      await stranger.request(email, token);
      expect(sql(db => db.prepare("SELECT join_comp_id AS c FROM email_proofs WHERE email_norm=?").get(email)?.c), "PRECONDITION: the proof carries the event").toBe(A.id);
      expect(await owner.redeem(email)).toMatchObject({ ok: true, needsProfile: true });
      const reg = await owner.ctx.post("/api/register", { headers: owner.h, data: FORM });
      expect(reg.ok(), await reg.text()).toBeTruthy();
      const u = sql(db => db.prepare("SELECT id, registration_competition_id AS r FROM users WHERE email=?").get(email));
      expect(u.r, "registered through no event").toBeNull();
      expect(inEvent(A.id, u.id), "…and joined to none").toBe(false);
      // CONTROL: asked for in the browser that signs up.
      const email2 = `origin-own-${stamp()}@acme.com`;
      await resetSuppression(own);
      await own.request(email2, token);
      expect((await own.redeem(email2)).ok).toBe(true);
      const reg2 = await own.ctx.post("/api/register", { headers: own.h, data: FORM });
      expect(reg2.ok(), await reg2.text()).toBeTruthy();
      const u2 = sql(db => db.prepare("SELECT id, registration_competition_id AS r FROM users WHERE email=?").get(email2));
      expect(u2.r, "CONTROL: registered through the event").toBe(A.id);
      expect(inEvent(A.id, u2.id), "CONTROL: …and joined to it").toBe(true);
    } finally { await stranger.dispose(); await owner.dispose(); await own.dispose(); }
  });
});
