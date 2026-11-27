"use strict";

// SWITCHING A JOIN LINK OFF, OR REPLACING IT, UNTIES THE CODES ALREADY EMAILED
// THROUGH IT (sweep #391, operator ruling, 24 Nov 2026). A sign-in code (an
// existing account's) or an address proof (a new address's) requested through an
// event's join link, QR or event code is bound to that event: redeeming it in the
// browser that asked joins the event. Once the organiser switches the link off
// (the event PUT) or replaces it (Regenerate), every such code still live is
// untied, in the same write, and counted on that write's record
// (`join_link_untied`): redeemed, the code signs in, and the proof makes an
// account, without joining, as a sign-up through the closed link already did.
// Three things carry a link's event, and each is pinned here:
//   • the bound code and the unredeemed proof (database rows), untied by the
//     link change itself — witnessed by switching the link off and on again
//     before the redeem, when nothing else would stop the join;
//   • the requesting browser's own memory of the link it asked through (its
//     session note): a code another browser re-bound through the NEW link joins
//     nobody in a browser that asked through the old one;
//   • a redeemed proof's sign-up grant (session state): the sign-up asks that the
//     event's link is still the one this browser asked through. A grant whose
//     link closed (switched off, replaced, or the event no longer taking joins)
//     after the code was entered counts as naming no event, exactly as one the
//     switch-off untied before: a live join token on the form fills it, the
//     address's live invitation is the registration's, approval holds the rest,
//     and the answer says the link closed. A body join token for a link that
//     closed meanwhile counts as none rather than a refusal (a token this browser
//     never asked with is still refused, beside a grant that named no event).
// The pending join marker of a join-link registration is not touched (it is
// honoured after a link is switched off, on purpose).
const { test, expect } = require("./isolated-test");
const { BASE, TEST_DB_PATH, apiLogin } = require("./helpers");
const { makeParticipant, makeCompetition, grantEventAdmin, H } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const sql = (fn) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
};
let seq = 0;
const stamp = () => `${Date.now().toString(36)}${++seq}`;
const FORM = { firstName: "New", lastName: "Comer", company: "Acme", title: "Engineer", country: "GB", timezone: "Europe/London" };

/** An anonymous browser: its own session, a CSRF token, and the code doors. */
async function browserSession(playwright) {
  const ctx = await playwright.request.newContext({ baseURL: BASE });
  const csrf = (await (await ctx.get("/api/csrf-token")).json()).csrfToken;
  const h = { "x-csrf-token": csrf, "content-type": "application/json" };
  return {
    ctx, h,
    request: (email, joinToken) => ctx.post("/api/auth/code/request", { headers: h, data: { email, ...(joinToken ? { joinToken } : {}) } }),
    async redeem(email) {
      const c = await (await ctx.get("/api/test/last-login-code?email=" + encodeURIComponent(email))).json();
      const out = await (await ctx.post("/api/auth/code/redeem", { headers: h, data: { email, code: c.code } })).json();
      // The redeem regenerates the session: the next write needs its new token.
      h["x-csrf-token"] = (await (await ctx.get("/api/csrf-token")).json()).csrfToken;
      return out;
    },
    register: (extra) => ctx.post("/api/register", { headers: h, data: { ...FORM, ...(extra || {}) } }),
    dispose: () => ctx.dispose(),
  };
}

async function joinEvent(label) {
  const s = await apiLogin("superadmin");
  try {
    const A = await makeCompetition(s.api, s.csrf, label, { self_enroll_enabled: true });
    return { s, A, token: tokenOf(A.id) };
  } catch (e) { await s.api.dispose(); throw e; }
}
const tokenOf = (compId) => sql(db => db.prepare("SELECT self_enroll_token AS t FROM competitions WHERE id=?").get(compId).t);
const boundTo = (uid) => sql(db => db.prepare("SELECT login_code_comp_id AS c FROM users WHERE id=?").get(uid).c);
const proofEvent = (email) => sql(db => db.prepare("SELECT join_comp_id AS c FROM email_proofs WHERE email_norm=?").get(email)?.c);
const inEvent = (compId, uid) => !!sql(db => db.prepare("SELECT 1 AS x FROM competition_users WHERE competition_id=? AND user_id=?").get(compId, uid));
const selfEnrolled = (uid, compId) => sql(db => db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='self_enrolled'").all(uid))
  .map(x => JSON.parse(x.details)).filter(d => d.competition_id === compId).length;
const userByEmail = (email) => sql(db => db.prepare("SELECT id, approved, approved_by, registration_competition_id AS reg, pending_self_enroll_comp_id AS pending FROM users WHERE email=?").get(email));
const resetSuppression = async (b) => b.ctx.post("/api/test/reset-recent-code-sends", { headers: b.h });
/** The newest record of `type` on the event's History, its details parsed. */
const lastCompEvent = (compId, type) => {
  const row = sql(db => db.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type=? ORDER BY changed_at DESC, rowid DESC LIMIT 1").get(compId, type));
  return row ? JSON.parse(row.details) : null;
};
async function setLink(s, compId, on) {
  const r = await s.api.put(`/api/admin/competitions/${compId}`, { headers: H(s.csrf), data: { self_enroll_enabled: on } });
  expect(r.ok(), `switch the join link ${on ? "on" : "off"}: ${r.status()} ${await r.text()}`).toBeTruthy();
}
async function regenerate(s, compId) {
  const r = await s.api.post(`/api/admin/competitions/${compId}/self-enroll/regenerate`, { headers: H(s.csrf), data: {} });
  expect(r.ok(), `regenerate: ${r.status()} ${await r.text()}`).toBeTruthy();
  const t = tokenOf(compId);
  expect(t, "PRECONDITION: the regenerate wrote a new token").toBe((await r.json()).token);
  return t;
}

test.describe("switching a join link off, or replacing it, unties the codes already emailed through it", () => {
  test("switched off: a code asked for through the link signs in and joins nothing, and the edit's record counts the live codes it untied (CONTROL: before the switch, the same flow joins)", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("untieOff");
    const p = await makeParticipant(s.api, s.csrf, "untieoffp");
    const q = await makeParticipant(s.api, s.csrf, "untieoffq");
    const dead = await makeParticipant(s.api, s.csrf, "untieoffdead");
    const b = await browserSession(playwright), c = await browserSession(playwright);
    try {
      // CONTROL, while the link is on: asked for and redeemed here, the code joins.
      await resetSuppression(c);
      await c.request(q.email, token);
      expect((await c.redeem(q.email)).ok).toBe(true);
      expect(inEvent(A.id, q.id), "CONTROL: with the link on, the bound code joins").toBe(true);

      await resetSuppression(b);
      await b.request(p.email, token);
      expect(boundTo(p.id), "PRECONDITION: the code is bound to the event").toBe(A.id);
      const newcomer = `untieoff-new-${stamp()}@acme.com`;
      await b.request(newcomer, token);
      expect(proofEvent(newcomer), "PRECONDITION: the new address's proof is bound to the event").toBe(A.id);
      // Two dead ones, which the count leaves out: a code whose window has passed
      // and an expired proof, each still naming the event.
      const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
      const expiredEmail = `untieoff-expired-${stamp()}@acme.com`;
      sql(db => {
        db.prepare("UPDATE users SET login_code_hash=?, login_code_via='email', login_code_at=?, login_code_comp_id=? WHERE id=?").run("0".repeat(64), longAgo, A.id, dead.id);
        db.prepare("INSERT INTO email_proofs (email_norm, code_hash, created_at, expires_at, sends, attempts, join_comp_id, origin, last_sent_at) VALUES (?,?,?,?,1,0,?,NULL,?)")
          .run(expiredEmail, "1".repeat(64), longAgo, longAgo, A.id, longAgo);
      });

      await setLink(s, A.id, false);
      expect(boundTo(p.id), "the switch-off untied the code").toBeNull();
      expect(proofEvent(newcomer), "…and the new address's proof").toBeNull();
      const rec = lastCompEvent(A.id, "edited");
      expect(rec.changes.self_enroll_enabled, "the edit's record").toEqual({ from: true, to: false });
      expect(rec.join_link_untied, "it counts the LIVE code and proof it untied, not the dead ones").toEqual({ codes: 1, proofs: 1 });
      expect(rec.ip, "with the request's context").toBeTruthy();

      const r = await b.redeem(p.email);
      expect(r.ok, `the code still signs in: ${JSON.stringify(r)}`).toBe(true);
      expect(inEvent(A.id, p.id), "…and joins nothing").toBe(false);
      expect(selfEnrolled(p.id, A.id), "…and no join is recorded").toBe(0);
    } finally { await b.dispose(); await c.dispose(); await s.api.dispose(); }
  });

  test("replaced: a code asked for through the old link signs in and joins nothing, and the regenerate's record counts it (CONTROL: a code asked for through the new link joins)", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("untieRegen");
    const p = await makeParticipant(s.api, s.csrf, "untieregenp");
    const q = await makeParticipant(s.api, s.csrf, "untieregenq");
    const b = await browserSession(playwright), c = await browserSession(playwright);
    try {
      await resetSuppression(b);
      await b.request(p.email, token);
      expect(boundTo(p.id), "PRECONDITION: the code is bound to the event").toBe(A.id);
      const token2 = await regenerate(s, A.id);
      expect(boundTo(p.id), "the regenerate untied the code").toBeNull();
      const rec = lastCompEvent(A.id, "self_enroll_regenerated");
      expect(rec.join_link_untied, "counted on the regenerate's record").toEqual({ codes: 1, proofs: 0 });
      expect(rec.rotated).toEqual(["link", "join_code"]);
      expect(rec.ip, "with the request's context").toBeTruthy();
      expect(JSON.stringify(rec), "no token on the record").not.toContain(token2);
      const r = await b.redeem(p.email);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(inEvent(A.id, p.id), "signed in, joined to nothing").toBe(false);
      // CONTROL: the new link works as any link does.
      await resetSuppression(c);
      await c.request(q.email, token2);
      expect(boundTo(q.id)).toBe(A.id);
      expect((await c.redeem(q.email)).ok).toBe(true);
      expect(inEvent(A.id, q.id), "CONTROL: a code asked for through the new link joins").toBe(true);
    } finally { await b.dispose(); await c.dispose(); await s.api.dispose(); }
  });

  test("switched off and on again before the code is used: the code and the proof stay untied, while a code asked for once the link is back on, or the live link's own token on the sign-up form, joins (CONTROL)", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("untieOffOn");
    const p = await makeParticipant(s.api, s.csrf, "untieoffonp");
    const q = await makeParticipant(s.api, s.csrf, "untieoffonq");
    const b = await browserSession(playwright), c = await browserSession(playwright), d = await browserSession(playwright);
    try {
      await resetSuppression(b);
      await b.request(p.email, token);
      const newcomer = `untieoffon-new-${stamp()}@acme.com`;
      await b.request(newcomer, token);
      const newcomer2 = `untieoffon-form-${stamp()}@acme.com`;
      await resetSuppression(d);
      await d.request(newcomer2, token);
      expect([boundTo(p.id), proofEvent(newcomer), proofEvent(newcomer2)], "PRECONDITION: all three are bound").toEqual([A.id, A.id, A.id]);
      await setLink(s, A.id, false);
      await setLink(s, A.id, true);
      expect(tokenOf(A.id), "PRECONDITION: the same link is live again").toBe(token);
      expect([boundTo(p.id), proofEvent(newcomer), proofEvent(newcomer2)], "switching the link off untied them, for good").toEqual([null, null, null]);
      // The browser asked through this very link, which is live again: only the
      // untie keeps the code and the proof from joining.
      expect((await b.redeem(p.email)).ok).toBe(true);
      expect(inEvent(A.id, p.id), "the code signs in and joins nothing").toBe(false);
      expect(await b.redeem(newcomer)).toMatchObject({ ok: true, needsProfile: true });
      const reg = await b.register();
      expect(reg.ok(), await reg.text()).toBeTruthy();
      const u = userByEmail(newcomer);
      expect(u.reg, "the proof made an account through no event").toBeNull();
      expect(inEvent(A.id, u.id), "…in no event").toBe(false);
      // CONTROL: asked for once the link is back on, a code joins.
      await resetSuppression(c);
      await c.request(q.email, token);
      expect((await c.redeem(q.email)).ok).toBe(true);
      expect(inEvent(A.id, q.id), "CONTROL: a code asked for through the live link joins").toBe(true);
      // CONTROL: the untie is the proof's alone. The link, live again, still joins
      // as it joins anyone: the form sends its token (as the app does), and the
      // account is made in the event.
      expect(await d.redeem(newcomer2)).toMatchObject({ ok: true, needsProfile: true });
      const reg2 = await d.register({ joinToken: token });
      expect(reg2.ok(), await reg2.text()).toBeTruthy();
      const u2 = userByEmail(newcomer2);
      expect([u2.reg, inEvent(A.id, u2.id)], "CONTROL: the live link's own token joins").toEqual([A.id, true]);
    } finally { await b.dispose(); await c.dispose(); await d.dispose(); await s.api.dispose(); }
  });

  test("replaced while a browser holds the old code: asking again through the new link (held back) does not make the old code join", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("untieHeld");
    const p = await makeParticipant(s.api, s.csrf, "untieheldp");
    const first = await browserSession(playwright), again = await browserSession(playwright);
    try {
      await resetSuppression(first);
      await first.request(p.email, token);
      expect(boundTo(p.id), "PRECONDITION: bound").toBe(A.id);
      const token2 = await regenerate(s, A.id);
      // Inside two minutes the person asks again through the new link: the request
      // is held back, so the code in the inbox is the old one, untied.
      await again.request(p.email, token2);
      expect(boundTo(p.id), "held back, the old code is still the one in the inbox, and the regenerate untied it").toBeNull();
      expect((await again.redeem(p.email)).ok).toBe(true);
      expect(inEvent(A.id, p.id), "the old code joins nothing, wherever it is typed").toBe(false);
    } finally { await first.dispose(); await again.dispose(); await s.api.dispose(); }
  });

  test("replaced, then another browser re-binds the code through the new link: typed in the browser that asked through the old link it joins nothing; asked for through the new link, it joins (CONTROL)", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("untieRebind");
    const p = await makeParticipant(s.api, s.csrf, "untierebindp");
    const q = await makeParticipant(s.api, s.csrf, "untierebindq");
    const old = await browserSession(playwright), other = await browserSession(playwright), own = await browserSession(playwright);
    try {
      await resetSuppression(old);
      await old.request(p.email, token);
      const token2 = await regenerate(s, A.id);
      // Two minutes on, a request through the new link mints a new code, bound
      // to the event again.
      await resetSuppression(other);
      await other.request(p.email, token2);
      expect(boundTo(p.id), "PRECONDITION: the new code carries the event").toBe(A.id);
      // The person types the new code in the browser that asked through the OLD
      // link: that browser asked for the event, but not through the live link.
      expect((await old.redeem(p.email)).ok).toBe(true);
      expect(inEvent(A.id, p.id), "the old link's browser joins nothing").toBe(false);
      expect(selfEnrolled(p.id, A.id)).toBe(0);
      // CONTROL: asked for through the new link in the browser that types it.
      await resetSuppression(own);
      await own.request(q.email, token2);
      expect((await own.redeem(q.email)).ok).toBe(true);
      expect(inEvent(A.id, q.id), "CONTROL: asked for through the live link, it joins").toBe(true);
    } finally { await old.dispose(); await other.dispose(); await own.dispose(); await s.api.dispose(); }
  });

  test("with approval on, a held account's code from the link no longer lets it in once the link has been switched off, even after it is back on (CONTROL: left alone, it does)", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("untieHold");
    const p = await makeParticipant(s.api, s.csrf, "untieholdp");
    const q = await makeParticipant(s.api, s.csrf, "untieholdq");
    sql(db => db.prepare("UPDATE users SET approved=0, approved_at=NULL, approved_by=NULL WHERE id IN (?, ?)").run(p.id, q.id));
    const setApproval = async (on) => {
      const r = await s.api.patch("/api/admin/settings", { headers: H(s.csrf), data: { require_account_approval: on } });
      expect(r.ok(), await r.text()).toBeTruthy();
    };
    const approved = (uid) => sql(db => db.prepare("SELECT approved FROM users WHERE id=?").get(uid).approved);
    const b = await browserSession(playwright), c = await browserSession(playwright);
    try {
      await setApproval(true);
      // CONTROL: through the link, left alone, a held account is let in and joined.
      await resetSuppression(c);
      await c.request(q.email, token);
      const rq = await c.redeem(q.email);
      expect(rq.ok, `CONTROL: ${JSON.stringify(rq)}`).toBe(true);
      expect([approved(q.id), inEvent(A.id, q.id)], "CONTROL: approved and joined").toEqual([1, true]);
      await resetSuppression(b);
      await b.request(p.email, token);
      await setLink(s, A.id, false);
      await setLink(s, A.id, true);
      const r = await b.redeem(p.email);
      expect(r, "the untied code no longer carries the link's approval").toMatchObject({ ok: false, error: "pending_approval" });
      expect([approved(p.id), inEvent(A.id, p.id)]).toEqual([0, false]);
    } finally {
      await setApproval(false);
      await b.dispose(); await c.dispose(); await s.api.dispose();
    }
  });
});

test.describe("a new address's sign-up, once the link it asked through has closed", () => {
  test("the proof untied by the switch-off makes an account in no event, though the form still carries the old join token; a token this browser never asked with is still refused (CONTROL)", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("untieProof");
    const b = await browserSession(playwright), c = await browserSession(playwright);
    try {
      const email = `untieproof-${stamp()}@acme.com`;
      await resetSuppression(b);
      await b.request(email, token);
      expect(proofEvent(email), "PRECONDITION: bound").toBe(A.id);
      await setLink(s, A.id, false);
      expect(proofEvent(email), "untied").toBeNull();
      expect(await b.redeem(email)).toMatchObject({ ok: true, needsProfile: true });
      // The app sends the join token it still holds with the form.
      const reg = await b.register({ joinToken: token });
      expect(reg.status(), `a closed link never refuses the sign-up: ${await reg.text()}`).toBe(200);
      const u = userByEmail(email);
      expect(u.reg, "made through no event").toBeNull();
      expect(u.pending, "…with no join waiting").toBeNull();
      expect(inEvent(A.id, u.id), "…and in none").toBe(false);
      expect(u.approved_by, "approved as an ordinary sign-up, not through the link").toBe("email_proof");
      // CONTROL: a browser that asked for its code plainly, sending the closed
      // link's token with the form, is refused as before.
      const email2 = `untieproof-plain-${stamp()}@acme.com`;
      await resetSuppression(c);
      await c.request(email2);
      expect(await c.redeem(email2)).toMatchObject({ ok: true, needsProfile: true });
      const reg2 = await c.register({ joinToken: token });
      expect(reg2.status(), "CONTROL: a token this browser never asked with is refused").toBe(409);
      expect(userByEmail(email2), "CONTROL: …and nothing is made").toBeFalsy();
    } finally { await b.dispose(); await c.dispose(); await s.api.dispose(); }
  });

  // The dropped token counts as none, so the plain screen's rule holds: a live
  // invitation to the proven address is the registration's. (A grant that still
  // names the event, its link closed after the redeem, is read the same way:
  // the describe "a link closed after the code was entered" below.)
  test("with approval on, the proof untied by the switch-off registers through the address's live invitation, though the form still carries the old join token; an uninvited one is held (CONTROL)", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("untieInv");
    const B = await makeCompetition(s.api, s.csrf, "untieInvTarget");
    const invitee = `untieinv-${stamp()}@acme.com`;
    const other = `untieinv-held-${stamp()}@acme.com`;
    const inv = await s.api.post("/api/admin/invitations", { headers: H(s.csrf), data: { emails: [invitee], competitionIds: [B.id] } });
    expect(inv.ok(), await inv.text()).toBeTruthy();
    const invId = sql(db => db.prepare("SELECT id FROM invitations WHERE email=? COLLATE NOCASE AND used_at IS NULL").get(invitee))?.id;
    expect(invId, "PRECONDITION: the invitation is live").toBeTruthy();
    const setApproval = async (on) => {
      const r = await s.api.patch("/api/admin/settings", { headers: H(s.csrf), data: { require_account_approval: on } });
      expect(r.ok(), await r.text()).toBeTruthy();
    };
    const b = await browserSession(playwright), c = await browserSession(playwright);
    try {
      await setApproval(true);
      await resetSuppression(b);
      await b.request(invitee, token);
      await resetSuppression(c);
      await c.request(other, token);
      expect([proofEvent(invitee), proofEvent(other)], "PRECONDITION: both proofs are bound to the event").toEqual([A.id, A.id]);
      await setLink(s, A.id, false);
      expect([proofEvent(invitee), proofEvent(other)], "PRECONDITION: the switch-off untied both").toEqual([null, null]);
      expect(await b.redeem(invitee)).toMatchObject({ ok: true, needsProfile: true });
      // The app sends the join token it still holds with the form.
      const reg = await b.register({ joinToken: token });
      expect(reg.status(), await reg.text()).toBe(200);
      const body = await reg.json();
      expect(body.pendingApproval, `registered through the invitation, not held: ${JSON.stringify(body)}`).toBeUndefined();
      const u = userByEmail(invitee);
      expect([u.approved, u.approved_by], "approved by its invitation").toEqual([1, "invitation"]);
      expect(sql(db => db.prepare("SELECT user_id FROM invitations WHERE id=?").get(invId)).user_id, "the invitation is this registration's").toBe(u.id);
      expect([inEvent(B.id, u.id), inEvent(A.id, u.id)], "in the invitation's event, not the closed link's").toEqual([true, false]);
      // CONTROL: the same sign-up for an address nobody invited is held, as any
      // sign-up through no event is while approval is on.
      expect(await c.redeem(other)).toMatchObject({ ok: true, needsProfile: true });
      const reg2 = await c.register({ joinToken: token });
      expect(reg2.status(), await reg2.text()).toBe(200);
      expect((await reg2.json()).pendingApproval, "CONTROL: an uninvited sign-up waits").toBe(true);
      const u2 = userByEmail(other);
      expect([u2.approved, inEvent(A.id, u2.id)], "CONTROL: …held, in no event").toEqual([0, false]);
    } finally {
      await setApproval(false);
      await b.dispose(); await c.dispose(); await s.api.dispose();
    }
  });

  test("a sign-up grant, then the link replaced while the form is open: the account joins nothing; switched off instead, the same; left alone, it joins (CONTROL)", async ({ playwright }) => {
    const { s, A, token } = await joinEvent("untieGrant");
    const B = await makeCompetition(s.api, s.csrf, "untieGrantOff", { self_enroll_enabled: true });
    const tokenB = tokenOf(B.id);
    const g = await browserSession(playwright), h = await browserSession(playwright), own = await browserSession(playwright);
    try {
      // (1) Replaced: the grant names the event, through a link that is gone.
      const email = `untiegrant-${stamp()}@acme.com`;
      await resetSuppression(g);
      await g.request(email, token);
      expect(await g.redeem(email)).toMatchObject({ ok: true, needsProfile: true });
      await regenerate(s, A.id);
      const reg = await g.register({ joinToken: token });
      expect(reg.ok(), await reg.text()).toBeTruthy();
      const u = userByEmail(email);
      expect(u.reg, "made through no event").toBeNull();
      expect(inEvent(A.id, u.id), "…and in none").toBe(false);
      // (2) Switched off instead, on another event.
      const email2 = `untiegrant-off-${stamp()}@acme.com`;
      await resetSuppression(h);
      await h.request(email2, tokenB);
      expect(await h.redeem(email2)).toMatchObject({ ok: true, needsProfile: true });
      await setLink(s, B.id, false);
      const reg2 = await h.register({ joinToken: tokenB });
      expect(reg2.ok(), await reg2.text()).toBeTruthy();
      const u2 = userByEmail(email2);
      expect([u2.reg, inEvent(B.id, u2.id)], "switched off: no event either").toEqual([null, false]);
      // (3) CONTROL: the link left alone, the grant joins.
      const email3 = `untiegrant-own-${stamp()}@acme.com`;
      const token3 = tokenOf(A.id);
      await resetSuppression(own);
      await own.request(email3, token3);
      expect(await own.redeem(email3)).toMatchObject({ ok: true, needsProfile: true });
      const reg3 = await own.register({ joinToken: token3 });
      expect(reg3.ok(), await reg3.text()).toBeTruthy();
      const u3 = userByEmail(email3);
      expect(u3.reg, "CONTROL: made through the event").toBe(A.id);
      expect(inEvent(A.id, u3.id), "CONTROL: …and joined to it").toBe(true);
    } finally { await g.dispose(); await h.dispose(); await own.dispose(); await s.api.dispose(); }
  });
});

// A LINK CLOSED AFTER THE CODE WAS ENTERED. The sign-up grant still names the
// event, but its link was switched off, replaced, or the event stopped taking
// joins before the form was sent: the grant counts as naming no event, exactly
// as one the switch-off untied before the code was entered. Each sign-up is
// compared by value (an absolute tuple) AND against the same sign-up with the
// link closed before the code, or asked for plainly: an equivalence alone would
// pass were both equally wrong.
/** What a sign-up made, normalised so two accounts compare: event NAMES, and the invitation as used / used by this account. */
const signUpFacts = (email, invId) => sql(db => {
  const u = db.prepare("SELECT id, approved, approved_by, registration_competition_id AS reg, pending_self_enroll_comp_id AS pending FROM users WHERE email=?").get(email);
  if (!u) return null;
  const nameOf = (id) => (id ? (db.prepare("SELECT name FROM competitions WHERE id=?").get(id)?.name ?? `(gone ${id})`) : null);
  const events = db.prepare("SELECT c.name FROM competition_users cu JOIN competitions c ON c.id=cu.competition_id WHERE cu.user_id=? ORDER BY c.name").all(u.id).map(r => r.name);
  const inv = invId ? db.prepare("SELECT used_at, user_id FROM invitations WHERE id=?").get(invId) : null;
  const rec = db.prepare("SELECT event_type, changed_by, details FROM user_events WHERE user_id=? AND event_type IN ('created','self_registered') ORDER BY changed_at, rowid LIMIT 1").get(u.id);
  const det = rec ? JSON.parse(rec.details) : {};
  return {
    approved: u.approved, approved_by: u.approved_by, reg: nameOf(u.reg), pending: nameOf(u.pending), events,
    invitation: inv ? { used: !!inv.used_at, self: inv.user_id === u.id } : null,
    record: rec ? { type: rec.event_type, by: rec.changed_by, via: det.via, held: !!det.held_for_approval } : null,
  };
});
const invitationOf = (email) => sql(db => db.prepare("SELECT id, invited_by FROM invitations WHERE email=? COLLATE NOCASE AND used_at IS NULL").get(email));
async function inviteTo(api, csrf, emails, compId) {
  const r = await api.post("/api/admin/invitations", { headers: H(csrf), data: { emails, competitionIds: [compId] } });
  expect(r.ok(), `invite: ${await r.text()}`).toBeTruthy();
  const out = {};
  for (const e of emails) {
    out[e] = invitationOf(e);
    expect(out[e], `PRECONDITION: a live invitation for ${e}`).toBeTruthy();
  }
  return out;
}
async function setApprovalAs(s, on) {
  const r = await s.api.patch("/api/admin/settings", { headers: H(s.csrf), data: { require_account_approval: on } });
  expect(r.ok(), await r.text()).toBeTruthy();
}
/** One browser per address: ask (through `token`, or plainly) and redeem. */
async function provenBrowser(playwright, email, token, beforeRedeem) {
  const b = await browserSession(playwright);
  await resetSuppression(b);
  await b.request(email, token);
  if (beforeRedeem) await beforeRedeem();
  expect(await b.redeem(email), `PRECONDITION: ${email} holds a sign-up grant`).toMatchObject({ ok: true, needsProfile: true });
  return b;
}
async function registered(b, joinToken) {
  const r = await b.register(joinToken ? { joinToken } : {});
  expect(r.status(), await r.text()).toBe(200);
  return r.json();
}

test.describe("a link closed after the code was entered: the sign-up reads its grant as naming no event", () => {
  test("with approval off, a link closed after the code was entered gives the sign-up a link closed before gets: no event, the address's live invitation registers it, an uninvited one is approved as an ordinary sign-up (CONTROLS: closed before the code, a plain code, the link left alone)", async ({ playwright }) => {
    const { s, A: A1, token: t1 } = await joinEvent("lateOff1");
    const browsers = [];
    try {
      const A2 = await makeCompetition(s.api, s.csrf, "lateOff2", { self_enroll_enabled: true });
      const A0 = await makeCompetition(s.api, s.csrf, "lateOff0", { self_enroll_enabled: true });
      const A3 = await makeCompetition(s.api, s.csrf, "lateOff3", { self_enroll_enabled: true });
      const AE = await makeCompetition(s.api, s.csrf, "lateOffEnd", { self_enroll_enabled: true });
      const B = await makeCompetition(s.api, s.csrf, "lateOffTarget");
      const [t2, t0, t3, tE] = [tokenOf(A2.id), tokenOf(A0.id), tokenOf(A3.id), tokenOf(AE.id)];
      const e = (tag) => `lateoff-${tag}-${stamp()}@acme.com`;
      const invA1 = e("inva1"), invA2 = e("inva2"), invA0 = e("inva0"), invPlain = e("invplain"), invEnd = e("invend");
      const unA1 = e("una1"), unA3 = e("una3");
      const inv = await inviteTo(s.api, s.csrf, [invA1, invA2, invA0, invPlain, invEnd], B.id);
      // Invited to the very event whose link closes: the invitation adds them to it.
      const A4 = await makeCompetition(s.api, s.csrf, "lateOffSelf", { self_enroll_enabled: true });
      const t4 = tokenOf(A4.id), invSelf = e("invself");
      const invS = await inviteTo(s.api, s.csrf, [invSelf], A4.id);
      const ask = async (email, token, beforeRedeem) => { const b = await provenBrowser(playwright, email, token, beforeRedeem); browsers.push(b); return b; };
      // Closed BEFORE the code is entered: the switch-off unties the proof.
      const bA0 = await ask(invA0, t0, () => setLink(s, A0.id, false));
      // Asked for and redeemed; these links close below, after the redeem.
      const bA1 = await ask(invA1, t1), bA2 = await ask(invA2, t2), bEnd = await ask(invEnd, tE);
      const bUn1 = await ask(unA1, t1), bUn3 = await ask(unA3, t3), bPlain = await ask(invPlain, null);
      const bSelf = await ask(invSelf, t4);
      await setLink(s, A4.id, false);
      await setLink(s, A1.id, false);
      await regenerate(s, A2.id);
      const end = await s.api.post(`/api/admin/competitions/${AE.id}/end-now`, { headers: H(s.csrf), data: {} });
      expect(end.ok(), `end now: ${await end.text()}`).toBeTruthy();

      const rA1 = await registered(bA1, t1), rA2 = await registered(bA2, t2), rEnd = await registered(bEnd, tE);
      const rUn1 = await registered(bUn1, t1), rUn3 = await registered(bUn3, null), rPlain = await registered(bPlain, null);
      const rA0 = await registered(bA0, t0);
      const rSelf = await registered(bSelf, t4);

      const by = inv[invA1].invited_by;
      const INVITED = { approved: 1, approved_by: "invitation", reg: null, pending: null, events: [B.name],
        invitation: { used: true, self: true }, record: { type: "created", by, via: "invitation", held: false } };
      expect(signUpFacts(invA1, inv[invA1].id), "switched off after the code: registered through the invitation, in its event only").toEqual(INVITED);
      expect(signUpFacts(invA2, inv[invA2].id), "replaced after the code: the same").toEqual(INVITED);
      expect(signUpFacts(invEnd, inv[invEnd].id), "the event ended after the code: the same").toEqual(INVITED);
      expect(signUpFacts(unA1, null), "uninvited, switched off after the code: an ordinary sign-up in no event").toEqual({
        approved: 1, approved_by: "email_proof", reg: null, pending: null, events: [], invitation: null,
        record: { type: "self_registered", by: "system", via: "email_proof", held: false } });
      // EQUIVALENCE: closed before the code, and a plain code, give what closed after gives.
      expect(signUpFacts(invA0, inv[invA0].id), "EQUIVALENCE: closed before the code").toEqual(signUpFacts(invA1, inv[invA1].id));
      expect(signUpFacts(invPlain, inv[invPlain].id), "EQUIVALENCE: asked plainly").toEqual(signUpFacts(invA1, inv[invA1].id));
      // CONTROL: the link left alone, the grant alone (no body token) joins.
      expect(signUpFacts(unA3, null), "CONTROL: a live link's grant joins").toEqual({
        approved: 1, approved_by: "self_enroll", reg: A3.name, pending: null, events: [A3.name], invitation: null,
        record: { type: "self_registered", by: "system", via: "self_enroll", held: false } });
      // The answer says the event named could not be joined, only where it was so.
      expect([rA1, rA2, rEnd, rUn1, rA0].map(r => r.join_link_closed), "the answer says the link closed").toEqual([true, true, true, true, true]);
      expect([rUn3.join_link_closed, rPlain.join_link_closed], "CONTROL: a live link, or none named, says nothing").toEqual([undefined, undefined]);
      // Invited to the closed link's own event: the invitation added them to it, so
      // the answer never says they were not added (by value: they are in it).
      expect(signUpFacts(invSelf, invS[invSelf].id).events, "PRECONDITION: the invitation enrolled them in the link's own event").toEqual([A4.name]);
      expect(rSelf.join_link_closed, "added to that event after all: the answer says nothing").toBeUndefined();
      expect([rA1, rA2, rEnd, rUn1, rA0, rUn3, rPlain, rSelf].map(r => r.pendingApproval), "nobody waits with approval off").toEqual(Array(8).fill(undefined));
    } finally {
      for (const b of browsers) await b.dispose();
      await s.api.dispose();
    }
  });
  test("with approval on, a link closed after the code was entered no longer holds an invited newcomer: the invitation registers them; an uninvited one waits, as does one invited by a role that cannot approve; a live link's token on the form still joins; any dead token beside it adds nothing (CONTROLS: closed before the code, the link left alone)", async ({ playwright }) => {
    const { s, A: A1, token: t1 } = await joinEvent("lateOn1");
    const browsers = [];
    try {
      const A2 = await makeCompetition(s.api, s.csrf, "lateOn2", { self_enroll_enabled: true });
      const A0 = await makeCompetition(s.api, s.csrf, "lateOn0", { self_enroll_enabled: true });
      const A3 = await makeCompetition(s.api, s.csrf, "lateOn3", { self_enroll_enabled: true });
      const B = await makeCompetition(s.api, s.csrf, "lateOnTarget");
      // An event whose link was never on and that nobody asked through: a dead token.
      const C = await makeCompetition(s.api, s.csrf, "lateOnDead");
      const [t2, t0, t3, tC] = [tokenOf(A2.id), tokenOf(A0.id), tokenOf(A3.id), tokenOf(C.id)];
      expect(tC, "PRECONDITION: the closed event has a token").toBeTruthy();
      // A role that may invite into B but not approve accounts (sweep #501's inviter).
      const role = await s.api.post("/api/admin/roles", { headers: H(s.csrf), data: { label: `Late enrol-only ${stamp()}`, scope_mode: "granted", permissions: ["events.view", "participants.view", "participants.enrol"] } });
      expect(role.ok(), await role.text()).toBeTruthy();
      const enrolOnly = await makeParticipant(s.api, s.csrf, "lateonenrol");
      const gr = await s.api.patch(`/api/admin/users/${enrolOnly.id}/role`, { headers: H(s.csrf), data: { role: (await role.json()).role.id } });
      expect(gr.ok(), await gr.text()).toBeTruthy();
      await grantEventAdmin(s.api, s.csrf, B.id, enrolOnly.id);

      const e = (tag) => `lateon-${tag}-${stamp()}@acme.com`;
      const invA1 = e("inva1"), invA0 = e("inva0"), invNew = e("invnew"), heldInv = e("heldinv");
      const unA1 = e("una1"), unNew = e("unnew"), unOld = e("unold"), unDead = e("undead"), unA3 = e("una3");
      const inv = await inviteTo(s.api, s.csrf, [invA1, invA0, invNew], B.id);
      const org = await apiLogin(enrolOnly.email);
      let held;
      try { held = (await inviteTo(org.api, org.csrf, [heldInv], B.id))[heldInv]; } finally { await org.api.dispose(); }

      await setApprovalAs(s, true);
      const ask = async (email, token, beforeRedeem) => { const b = await provenBrowser(playwright, email, token, beforeRedeem); browsers.push(b); return b; };
      const bA0 = await ask(invA0, t0, () => setLink(s, A0.id, false));
      const bA1 = await ask(invA1, t1), bHeld = await ask(heldInv, t1), bUn1 = await ask(unA1, t1), bDead = await ask(unDead, t1);
      const bNew = await ask(unNew, t2), bOld = await ask(unOld, t2), bInvNew = await ask(invNew, t2), bUn3 = await ask(unA3, t3);
      await setLink(s, A1.id, false);
      const t2new = await regenerate(s, A2.id);

      const rA1 = await registered(bA1, t1), rA0 = await registered(bA0, t0), rHeld = await registered(bHeld, t1);
      const rUn1 = await registered(bUn1, t1), rDead = await registered(bDead, tC);
      const rNew = await registered(bNew, t2new), rOld = await registered(bOld, t2), rInvNew = await registered(bInvNew, t2new);
      const rUn3 = await registered(bUn3, null);

      // THE FIX: the invited newcomer is let in by the invitation, not held.
      expect(rA1.pendingApproval, `invited, link closed after the code: not held: ${JSON.stringify(rA1)}`).toBeUndefined();
      const by = inv[invA1].invited_by;
      expect(signUpFacts(invA1, inv[invA1].id), "registered through the invitation, in its event only").toEqual({
        approved: 1, approved_by: "invitation", reg: null, pending: null, events: [B.name],
        invitation: { used: true, self: true }, record: { type: "created", by, via: "invitation", held: false } });
      expect(rA0.pendingApproval, "EQUIVALENCE: closed before the code, not held either").toBeUndefined();
      expect(signUpFacts(invA0, inv[invA0].id), "EQUIVALENCE: closed before the code").toEqual(signUpFacts(invA1, inv[invA1].id));
      // An invitation from a role that cannot approve still waits, its invitation live.
      expect(rHeld.pendingApproval, "invited by a role that cannot approve: still held").toBe(true);
      expect(signUpFacts(heldInv, held.id), "…waiting, enrolled nowhere, the invitation unspent").toEqual({
        approved: 0, approved_by: null, reg: null, pending: null, events: [],
        invitation: { used: false, self: false }, record: { type: "created", by: held.invited_by, via: "invitation", held: true } });
      // Uninvited: held, as any sign-up through no event is while approval is on.
      const HELD_PLAIN = { approved: 0, approved_by: null, reg: null, pending: null, events: [], invitation: null,
        record: { type: "self_registered", by: "system", via: "email_proof", held: false } };
      expect(rUn1.pendingApproval, "uninvited: held").toBe(true);
      expect(signUpFacts(unA1, null)).toEqual(HELD_PLAIN);
      // Replaced after the code: the NEW link on the form (the one the visitor
      // opened) joins and approves; the old one counts as none and waits.
      expect(rNew.pendingApproval, "the new live link's token joins").toBeUndefined();
      expect(signUpFacts(unNew, null), "…approved through the live link though approval is on").toEqual({
        approved: 1, approved_by: "self_enroll", reg: A2.name, pending: null, events: [A2.name], invitation: null,
        record: { type: "self_registered", by: "system", via: "self_enroll", held: false } });
      expect(rOld.pendingApproval, "the old token: held").toBe(true);
      expect(signUpFacts(unOld, null)).toEqual(HELD_PLAIN);
      // Invited, the new live link's token on the form: the link wins over the
      // invitation lookup (the invitation is claimed at the sign-in, as for any
      // sign-up through a live link).
      expect(rInvNew.pendingApproval).toBeUndefined();
      expect(signUpFacts(invNew, inv[invNew].id), "invited, new live token: joined through the link").toEqual({
        approved: 1, approved_by: "self_enroll", reg: A2.name, pending: null, events: [A2.name, B.name].sort(),
        invitation: { used: true, self: true }, record: { type: "self_registered", by: "system", via: "self_enroll", held: false } });
      // A dead token this browser never asked through, beside a grant whose own
      // link closed: dropped too, never a refusal; the sign-up waits.
      expect(rDead.pendingApproval, `a dead token beside a closed grant is no refusal: ${JSON.stringify(rDead)}`).toBe(true);
      expect(signUpFacts(unDead, null)).toEqual(HELD_PLAIN);
      // CONTROL: the link left alone, the grant alone joins and approves.
      expect(signUpFacts(unA3, null), "CONTROL: a live link's grant").toEqual({
        approved: 1, approved_by: "self_enroll", reg: A3.name, pending: null, events: [A3.name], invitation: null,
        record: { type: "self_registered", by: "system", via: "self_enroll", held: false } });
      expect([rA1, rA0, rHeld, rUn1, rOld, rDead].map(r => r.join_link_closed), "the answer says the link closed").toEqual(Array(6).fill(true));
      expect([rNew, rInvNew, rUn3].map(r => r.join_link_closed), "CONTROL: a live link joined, nothing to say").toEqual([undefined, undefined, undefined]);
    } finally {
      await setApprovalAs(s, false);
      for (const b of browsers) await b.dispose();
      await s.api.dispose();
    }
  });
});

test.describe("the History says how many codes a link change untied", () => {
  test("the edit and the regenerate name the count in words; none, or an older record, adds nothing", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html[data-booted='1']")).toHaveCount(1, { timeout: 15000 });
    expect(await page.evaluate(() => typeof window.formatEventChange), "PRECONDITION: the renderer is on window").toBe("function");
    const fmt = (ev) => page.evaluate((e) => window.formatEventChange(e), ev);
    const off = { changes: { self_enroll_enabled: { from: true, to: false } } };
    const edited = await fmt({ event_type: "edited", details: { ...off, join_link_untied: { codes: 2, proofs: 1 } } });
    expect(edited).toContain("3 sign-in codes already emailed through the join link no longer join anyone to this event");
    const regen = await fmt({ event_type: "self_enroll_regenerated", details: { rotated: ["link", "join_code"], join_link_untied: { codes: 1, proofs: 0 } } });
    expect(regen).toContain("Join link and short code regenerated");
    expect(regen).toContain("1 sign-in code already emailed through the old link no longer joins anyone to this event");
    // CONTROLS: nothing untied, or an older record without the count.
    const none = await fmt({ event_type: "edited", details: { ...off, join_link_untied: { codes: 0, proofs: 0 } } });
    expect(none).not.toContain("sign-in code");
    expect(none).toContain("self_enroll_enabled");
    expect(await fmt({ event_type: "self_enroll_regenerated", details: { rotated: ["link", "join_code"] } })).toBe("Join link and short code regenerated");
    expect(await fmt({ event_type: "self_enroll_regenerated", details: {} })).toBe("Join link regenerated");
  });
});
