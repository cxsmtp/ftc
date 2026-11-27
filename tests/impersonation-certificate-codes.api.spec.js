// VIEWING AS A PARTICIPANT HIDES THEIR CERTIFICATE'S CODE AND LINK, unless the
// acting admin may look certificates up by code (operator ruling, 23 Nov 2026).
//
// 9.2.7 kept the credential code out of an event's issued-certificates list for
// anyone without `certificates.lookup` (a superadmin, or a role granted it): the
// list would otherwise be the code-to-holder table the audited lookup withholds.
// The participant's own surfaces still handed the code, and the token that opens
// the certificate's page, image, PDF and LinkedIn post, to any admin viewing as
// them. They are now decided by the ACTING admin (the hand, read live; never the
// seat, which is the participant): GET /api/me/certificates, every answer of the
// mint (POST /api/competitions/:id/badge), and the LinkedIn post (404).
//
// Held by value (the token and the code are searched for in the whole of every
// answer), each hidden viewer beside the viewers who keep them:
//   hidden — a built-in admin, an event admin of the event, a custom role that may
//            impersonate but not look codes up;
//   shown  — the built-in superadmin, a custom role granted the lookup (the paired
//            control of the one above: it is the permission, not the custom role),
//            and the holder's own session.
// And the hand's permission is read LIVE: taken off its role while the admin is
// viewing, the next read hides the code; given back, it shows again; and the
// hand moved to a role without it (out of band, so no session ends), hidden
// again: their role is read from their account, never from the view's snapshot.
const { test, expect } = require("./isolated-test");
const { apiLogin, TEST_DB_PATH } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, enrol, grantEventAdmin } = require("./event-admin-helpers");
const { makeAdmin } = require("./admin-inflight-helpers");

const sql = (fn) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH);
  try { return fn(db); } finally { db.close(); }
};
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const freshCode = () => Array.from({ length: 12 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
const formatted = (c) => `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;

test.describe("viewing as a participant: their certificate's code and link go only to a hand that may look codes up", () => {
  let sa, saCsrf, comp, target, tok, code;
  const roles = {};
  const people = {};

  test.beforeAll(async () => {
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    comp = await makeCompetition(sa, saCsrf, "vacert");
    target = await makeParticipant(sa, saCsrf, "vatgt");
    await enrol(sa, saCsrf, comp.id, [target.id]);
    tok = `tok${uniq("va").replace(/[^a-z0-9]/gi, "")}`;
    code = freshCode();
    sql(db => db.prepare(`INSERT INTO achievement_badges (token, user_id, competition_id, timeslot_id, rank, image_id, nickname_snapshot, basis, public_code, created_at)
                          VALUES (?,?,?,NULL,1,?,?,'placement',?,?)`)
      .run(tok, target.id, comp.id, `img${tok}`, "vatgtnick", code, new Date().toISOString()));
    const mkRole = async (key, permissions) => {
      const r = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: { label: `View as ${key} ${Date.now()}`, scope_mode: "all", permissions } });
      expect(r.ok(), `create role ${key}: ${await r.text()}`).toBeTruthy();
      roles[key] = (await r.json()).role;
    };
    await mkRole("lookup", ["participants.view", "participants.impersonate", "certificates.lookup"]);
    await mkRole("plain", ["participants.view", "participants.impersonate"]);
    people.admin = await makeAdmin(sa, saCsrf, "vaadm", "admin");
    people.organiser = await makeParticipant(sa, saCsrf, "vaorg");
    await grantEventAdmin(sa, saCsrf, comp.id, people.organiser.id);
    for (const key of ["lookup", "plain"]) {
      people[key] = await makeParticipant(sa, saCsrf, `va${key}`);
      const r = await sa.post(`/api/admin/participants/${people[key].id}/role`, { headers: H(saCsrf), data: { role: roles[key].id } });
      expect(r.ok(), `give ${key}: ${await r.text()}`).toBeTruthy();
    }
  });

  async function viewAs(email) {
    const s = await apiLogin(email);
    const r = await s.api.post(`/api/admin/participants/${target.id}/impersonate`, { headers: H(s.csrf), data: { view: "participant" } });
    expect(r.ok(), `view as the participant: ${r.status()} ${await r.text()}`).toBeTruthy();
    const csrf = (await (await s.api.get("/api/csrf-token")).json()).csrfToken;
    return { api: s.api, csrf };
  }
  /** Every participant-side answer that could carry the code or the token. */
  async function answers(s) {
    const list = await s.api.get("/api/me/certificates");
    expect(list.ok(), await list.text()).toBeTruthy();
    const listBody = await list.json();
    const mint = await s.api.post(`/api/competitions/${comp.id}/badge`, { headers: H(s.csrf) });
    expect(mint.status(), `the mint answers the held certificate: ${await mint.text()}`).toBe(200);
    const mintBody = await mint.json();
    const me = await (await s.api.get("/api/me")).json();
    const post = await s.api.get(`/api/me/certificates/${tok}/linkedin-post`, { headers: { accept: "application/json" } });
    const held = (listBody.held || listBody.certificates || []).find(c => c.competitionId === comp.id);
    expect(held, "PRECONDITION: the certificate is listed (the check below would otherwise pass vacuously)").toBeTruthy();
    return { blob: JSON.stringify([listBody, mintBody, me]), held, mintBody, me, post };
  }

  for (const who of ["admin", "organiser", "plain"]) {
    test(`hidden from ${who === "plain" ? "a custom role that may impersonate but not look codes up" : who === "admin" ? "a built-in admin" : "the event's own organiser"}`, async () => {
      const s = await viewAs(people[who].email);
      const a = await answers(s);
      expect(a.blob, "the token is nowhere in any answer").not.toContain(tok);
      expect(a.blob, "nor the code").not.toContain(code);
      expect(a.blob, "nor the code as printed").not.toContain(formatted(code));
      expect(a.held.withheld).toBe(true);
      expect(a.mintBody.withheld).toBe(true);
      expect(a.me.impersonation && a.me.impersonation.certificate_codes).toBe(false);
      expect(a.post.status(), "the LinkedIn post, which carries the code, is the unknown-token 404").toBe(404);
      await s.api.dispose();
    });
  }

  for (const who of ["superadmin", "lookup"]) {
    test(`shown to ${who === "superadmin" ? "the built-in superadmin" : "a custom role granted the lookup (CONTROL)"}`, async () => {
      const s = await viewAs(who === "superadmin" ? "superadmin" : people.lookup.email);
      const a = await answers(s);
      expect(a.held.token).toBe(tok);
      expect(a.held.code).toBe(formatted(code));
      expect(a.held.withheld).toBeUndefined();
      expect(a.mintBody.token).toBe(tok);
      expect(a.me.impersonation.certificate_codes).toBe(true);
      expect(a.post.status()).toBe(200);
      expect((await a.post.json()).text).toContain(`code=${code}`);
      await s.api.dispose();
    });
  }

  test("the acting admin's permission is read live: taken off their role mid-view, the next read hides the code; given back, it shows again", async () => {
    const PERMS = ["participants.view", "participants.impersonate"];
    // Its own superadmin session: viewing as the built-in superadmin above signed
    // the file's first one out (one session per account).
    const { api: su, csrf: suCsrf } = await apiLogin("superadmin");
    const cr = await su.post("/api/admin/roles", { headers: H(suCsrf), data: { label: `View as live ${Date.now()}`, scope_mode: "all", permissions: [...PERMS, "certificates.lookup"] } });
    expect(cr.ok(), await cr.text()).toBeTruthy();
    let role = (await cr.json()).role;
    const who = await makeParticipant(su, suCsrf, "valive");
    const g = await su.post(`/api/admin/participants/${who.id}/role`, { headers: H(suCsrf), data: { role: role.id } });
    expect(g.ok(), await g.text()).toBeTruthy();
    const edit = async (permissions) => {
      const r = await su.put(`/api/admin/roles/${role.id}`, { headers: H(suCsrf), data: { permissions, expectedVersion: role.version } });
      expect(r.ok(), `edit the role: ${await r.text()}`).toBeTruthy();
      role = (await r.json()).role;
    };
    const s = await viewAs(who.email);
    try {
      const a1 = await answers(s);
      expect(a1.held.token, "PRECONDITION: shown while the role holds the lookup").toBe(tok);
      await edit(PERMS);
      const me = await (await s.api.get("/api/me")).json();
      expect(me.impersonation && me.impersonation.active, "PRECONDITION: still viewing as them (a role edit ends no session)").toBe(true);
      const a2 = await answers(s);
      expect(a2.blob, "the token is gone at the next read").not.toContain(tok);
      expect(a2.blob, "and the code").not.toContain(code);
      expect(a2.held.withheld).toBe(true);
      expect(a2.me.impersonation.certificate_codes).toBe(false);
      expect(a2.post.status()).toBe(404);
      await edit([...PERMS, "certificates.lookup"]);
      const a3 = await answers(s);
      expect(a3.held.token, "given back, shown again").toBe(tok);
      expect(a3.me.impersonation.certificate_codes).toBe(true);
      // Moved to another role without the lookup, out of band: the view's
      // snapshot still names the first role, the account does not.
      const pr = await su.post("/api/admin/roles", { headers: H(suCsrf), data: { label: `View as live plain ${Date.now()}`, scope_mode: "all", permissions: PERMS } });
      expect(pr.ok(), await pr.text()).toBeTruthy();
      const plainRole = (await pr.json()).role.id;
      sql(db => db.prepare("UPDATE users SET role=? WHERE id=?").run(plainRole, who.id));
      const a4 = await answers(s);
      expect(a4.blob, "moved to a role without it: hidden").not.toContain(tok);
      expect(a4.held.withheld).toBe(true);
    } finally { await s.api.dispose(); await su.dispose(); }
  });

  test("the holder's own session keeps both (CONTROL)", async () => {
    const s = await apiLogin(target.email);
    const list = await (await s.api.get("/api/me/certificates")).json();
    const held = (list.held || list.certificates || []).find(c => c.competitionId === comp.id);
    expect(held.token).toBe(tok);
    expect(held.code).toBe(formatted(code));
    expect(held.withheld).toBeUndefined();
    const me = await (await s.api.get("/api/me")).json();
    expect(me.impersonation, "no view-as block for the holder").toBeFalsy();
    await s.api.dispose();
  });
});
