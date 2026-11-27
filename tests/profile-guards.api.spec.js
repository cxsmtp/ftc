// @ts-check
// ─────────────────────────────────────────────────────────────────────────────
// Live profile and approval guards whose only behavioural tests went with the
// LinkedIn sign-in and password removal, held again:
//
//   1. a non-http(s) LinkedIn URL is refused at every door that stores one
//      (registration, the self profile PUT, the admin profile PUT): the value
//      is rendered into an href, and esc() does not change a URL's scheme;
//   2. Deny is idempotent, Approve reverses a denial in one step, and a regular
//      admin may not deny an admin (the peer-admin rule) — each beside a control;
//   3. a profile update (self or admin) refused for another field, or an admin
//      save refused as stale, stores no avatar image (the avatar is validated
//      early and stored late, and handed back if the write fails; `images` has
//      no sweeper).
// ─────────────────────────────────────────────────────────────────────────────
const { test, expect } = require("./isolated-test");
const Database = require("better-sqlite3");
const { apiLogin, freshCtx, registerPost, pngDataUri, PARTICIPANT_PASS, TEST_DB_PATH, BASE } = require("./helpers");
const { H, uniq, makeParticipant } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

function dbGet(sql, ...a) { const d = new Database(TEST_DB_PATH, { readonly: true }); try { return d.prepare(sql).get(...a); } finally { d.close(); } }

const FORM = { firstName: "Link", lastName: "Guard", company: "Acme", title: "Engineer", country: "GB", timezone: "Europe/London" };
const BAD_URLS = ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>"];
const GOOD_URL = "https://www.linkedin.com/in/someone-real";

test.describe("profile and approval guards", () => {
  let sa, saCsrf;
  test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
  test.afterAll(async () => { await sa?.dispose(); });

  /** A verified account still waiting for approval (deny is only for those). */
  async function pending(label) {
    const email = `pg-${uniq(label)}@acme.com`;
    const { api: anon, csrf } = await freshCtx();
    try {
      const reg = await registerPost(anon, "/api/register", { headers: H(csrf), data: { ...FORM, email } });
      expect(reg.ok(), `register ${label}: ${reg.status()} ${await reg.text()}`).toBeTruthy();
    } finally { await anon.dispose(); }
    const id = dbGet("SELECT id FROM users WHERE email=?", email).id;
    const v = await sa.post(`/api/admin/participants/${id}/verify`, { headers: H(saCsrf) });
    expect(v.ok(), `verify ${label}: ${await v.text()}`).toBeTruthy();
    expect(dbGet("SELECT approved FROM users WHERE id=?", id).approved, "PRECONDITION: not approved").toBe(0);
    return { id, email };
  }

  test("a non-http(s) LinkedIn URL is refused at registration, the self profile PUT and the admin PUT; an https URL is stored (CONTROL)", async () => {
    // Registration: a valid work address, so the proof grant exists and the
    // refusal is the field's.
    for (const bad of BAD_URLS) {
      const email = `pg-${uniq("lkreg")}@acme.com`;
      const { api: anon, csrf } = await freshCtx();
      try {
        const r = await registerPost(anon, "/api/register", { headers: H(csrf), data: { ...FORM, email, linkedinUrl: bad } });
        expect(r.status(), `${bad}: ${await r.text()}`).toBe(400);
        expect((await r.json()).error).toMatch(/LinkedIn URL must be a valid http/);
      } finally { await anon.dispose(); }
      expect(dbGet("SELECT COUNT(*) c FROM users WHERE email=?", email).c, "nothing was created").toBe(0);
    }
    const okEmail = `pg-${uniq("lkregok")}@acme.com`;
    { const { api: anon, csrf } = await freshCtx();
      try {
        const r = await registerPost(anon, "/api/register", { headers: H(csrf), data: { ...FORM, email: okEmail, linkedinUrl: GOOD_URL } });
        expect(r.status(), `CONTROL: ${await r.text()}`).toBe(200);
      } finally { await anon.dispose(); } }
    expect(dbGet("SELECT linkedin_url FROM users WHERE email=?", okEmail).linkedin_url, "CONTROL: an https URL is stored").toBe(GOOD_URL);

    // The person's own profile.
    const p = await makeParticipant(sa, saCsrf, "lkself");
    const s = await apiLogin(p.email, PARTICIPANT_PASS);
    try {
      for (const bad of BAD_URLS) {
        const r = await s.api.put("/api/me", { headers: H(s.csrf), data: { linkedinUrl: bad } });
        expect(r.status(), `${bad}: ${await r.text()}`).toBe(400);
        expect((await r.json()).error).toMatch(/LinkedIn URL must be a valid http/);
      }
      expect(dbGet("SELECT linkedin_url FROM users WHERE id=?", p.id).linkedin_url, "nothing was stored").toBeNull();
      const ok = await s.api.put("/api/me", { headers: H(s.csrf), data: { linkedinUrl: GOOD_URL } });
      expect(ok.status(), `CONTROL: ${await ok.text()}`).toBe(200);
      expect(dbGet("SELECT linkedin_url FROM users WHERE id=?", p.id).linkedin_url).toBe(GOOD_URL);
    } finally { await s.api.dispose(); }

    // An administrator's edit.
    const q = await makeParticipant(sa, saCsrf, "lkadmin");
    for (const bad of BAD_URLS) {
      const r = await sa.put(`/api/admin/participants/${q.id}`, { headers: H(saCsrf), data: { linkedinUrl: bad } });
      expect(r.status(), `${bad}: ${await r.text()}`).toBe(400);
      expect((await r.json()).error).toMatch(/LinkedIn URL must be a valid http/);
    }
    expect(dbGet("SELECT linkedin_url FROM users WHERE id=?", q.id).linkedin_url, "nothing was stored").toBeNull();
    const ok = await sa.put(`/api/admin/participants/${q.id}`, { headers: H(saCsrf), data: { linkedinUrl: GOOD_URL } });
    expect(ok.status(), `CONTROL: ${await ok.text()}`).toBe(200);
    expect(dbGet("SELECT linkedin_url FROM users WHERE id=?", q.id).linkedin_url).toBe(GOOD_URL);
  });

  test("Deny is idempotent and Approve reverses a denial in one step", async () => {
    const p = await pending("deny");
    const deniedEvents = () => dbGet("SELECT COUNT(*) c FROM user_events WHERE user_id=? AND event_type='denied'", p.id).c;
    const d1 = await sa.post(`/api/admin/participants/${p.id}/deny`, { headers: H(saCsrf), data: { reason: "Not this time" } });
    expect(d1.status(), await d1.text()).toBe(200);
    const b1 = await d1.json();
    expect(b1.ok).toBe(true);
    expect(b1.already, "the first deny is not a no-op").toBeUndefined();
    const r1 = dbGet("SELECT denied_at, denied_reason, blocked, approved FROM users WHERE id=?", p.id);
    expect(r1.denied_at, "denied").toBeTruthy();
    expect(r1).toMatchObject({ denied_reason: "Not this time", blocked: 1, approved: 0 });
    expect(deniedEvents()).toBe(1);

    // A second deny changes nothing and records nothing.
    const d2 = await sa.post(`/api/admin/participants/${p.id}/deny`, { headers: H(saCsrf), data: { reason: "Again" } });
    expect(d2.status(), await d2.text()).toBe(200);
    expect(await d2.json()).toEqual({ ok: true, already: true });
    expect(dbGet("SELECT denied_at, denied_reason FROM users WHERE id=?", p.id)).toEqual({ denied_at: r1.denied_at, denied_reason: "Not this time" });
    expect(deniedEvents(), "no second audit row").toBe(1);

    // Approve clears the denial, the block it set, and approves — one press.
    const ap = await sa.post(`/api/admin/participants/${p.id}/approve`, { headers: H(saCsrf) });
    expect(ap.status(), await ap.text()).toBe(200);
    expect(dbGet("SELECT denied_at, denied_by, denied_reason, blocked, approved FROM users WHERE id=?", p.id))
      .toEqual({ denied_at: null, denied_by: null, denied_reason: null, blocked: 0, approved: 1 });
    const ev = dbGet("SELECT details FROM user_events WHERE user_id=? AND event_type='approved' ORDER BY rowid DESC LIMIT 1", p.id);
    expect(JSON.parse(ev.details).via, "recorded as the reversal of a denial").toBe("deny_reversal");
  });

  test("a regular admin may not deny an admin's account; the same admin denies a participant (CONTROL)", async () => {
    const viewer = await makeParticipant(sa, saCsrf, "denyviewer");
    const target = await makeParticipant(sa, saCsrf, "denytarget");
    for (const u of [viewer, target]) {
      const r = await sa.post(`/api/admin/participants/${u.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
      expect(r.ok(), `make admin: ${await r.text()}`).toBeTruthy();
    }
    const plain = await pending("denyplain");
    const v = await apiLogin(viewer.email, PARTICIPANT_PASS);
    try {
      const refused = await v.api.post(`/api/admin/participants/${target.id}/deny`, { headers: H(v.csrf), data: { reason: "peer" } });
      expect(refused.status(), await refused.text()).toBe(403);
      expect((await refused.json()).error).toMatch(/Only superadmins can deny/);
      expect(dbGet("SELECT denied_at, blocked FROM users WHERE id=?", target.id)).toEqual({ denied_at: null, blocked: 0 });
      const ok = await v.api.post(`/api/admin/participants/${plain.id}/deny`, { headers: H(v.csrf), data: { reason: "control" } });
      expect(ok.status(), `CONTROL: ${await ok.text()}`).toBe(200);
      expect(dbGet("SELECT denied_at FROM users WHERE id=?", plain.id).denied_at, "CONTROL: the participant is denied").toBeTruthy();
    } finally { await v.api.dispose(); }
  });

  test("a profile update refused for another field stores no avatar image; an accepted one stores exactly one (CONTROL)", async () => {
    const p = await makeParticipant(sa, saCsrf, "avatarguard");
    const s = await apiLogin(p.email, PARTICIPANT_PASS);
    try {
      const images = () => dbGet("SELECT COUNT(*) c FROM images").c;
      const before = images();
      const avatarBefore = dbGet("SELECT avatar FROM users WHERE id=?", p.id).avatar;
      // A valid picture beside a nickname the route refuses AFTER validating it.
      const r = await s.api.put("/api/me", { headers: H(s.csrf), data: { avatar: pngDataUri(40, "refused-save"), nickname: "ab" } });
      expect(r.status(), await r.text()).toBe(400);
      expect((await r.json()).error).toMatch(/at least 3 characters/);
      expect(images(), "the refused save stored no image").toBe(before);
      expect(dbGet("SELECT avatar FROM users WHERE id=?", p.id).avatar, "and kept the avatar").toBe(avatarBefore);

      const ok = await s.api.put("/api/me", { headers: H(s.csrf), data: { avatar: pngDataUri(40, "accepted-save") } });
      expect(ok.status(), `CONTROL: ${await ok.text()}`).toBe(200);
      expect(images(), "CONTROL: an accepted save stores its image").toBe(before + 1);
      expect(dbGet("SELECT avatar FROM users WHERE id=?", p.id).avatar).toMatch(/^\/api\/images\//);
    } finally { await s.api.dispose(); }
  });

  test("an admin profile save refused for another field, or stale, stores no avatar image; an accepted one stores exactly one (CONTROL)", async () => {
    const t = await makeParticipant(sa, saCsrf, "admavatar");
    const o = await makeParticipant(sa, saCsrf, "admavataro");
    const images = () => dbGet("SELECT COUNT(*) c FROM images").c;
    const avatarOf = () => dbGet("SELECT avatar FROM users WHERE id=?", t.id).avatar;
    const before = images();
    const avatarBefore = avatarOf();

    // A valid picture beside a nickname the route refuses AFTER validating it.
    const taken = await sa.put(`/api/admin/participants/${t.id}`, { headers: H(saCsrf),
      data: { avatar: pngDataUri(40, "admin-refused"), nickname: o.nickname } });
    expect(taken.status(), await taken.text()).toBe(409);
    expect((await taken.json()).error).toBe("Nickname already taken");
    expect(images(), "the refused save stored no image").toBe(before);
    expect(avatarOf(), "and kept the avatar").toBe(avatarBefore);

    // A valid picture on a save whose version is stale: refused at the write,
    // after the image row exists, so the image must be handed back.
    const stale = await sa.put(`/api/admin/participants/${t.id}`, { headers: H(saCsrf),
      data: { avatar: pngDataUri(40, "admin-stale"), expectedUpdatedAt: "1999-01-01T00:00:00.000Z" } });
    expect(stale.status(), await stale.text()).toBe(409);
    expect((await stale.json()).conflict).toBe(true);
    expect(images(), "the stale save left no image behind").toBe(before);
    expect(avatarOf(), "and kept the avatar").toBe(avatarBefore);

    const ok = await sa.put(`/api/admin/participants/${t.id}`, { headers: H(saCsrf),
      data: { avatar: pngDataUri(40, "admin-accepted") } });
    expect(ok.status(), `CONTROL: ${await ok.text()}`).toBe(200);
    expect(images(), "CONTROL: an accepted save stores its image").toBe(before + 1);
    expect(avatarOf()).toMatch(/^\/api\/images\//);
  });
});
