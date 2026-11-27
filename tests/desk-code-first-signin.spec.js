// @ts-check
//
// A CODE IS SHOWN AT THE DESK ONLY FOR AN ACCOUNT THAT HAS NEVER SIGNED IN
// (operator ruling, 14 Nov 2026).
//
// "Show sign-in code" hands an organiser a working code for the account: typed
// at the sign-in screen it is a full session as that person, covering all of
// their events. It exists for the walk-up just added at the desk, or the one
// whose first emailed code never arrived. After a first sign-in the desk can
// only EMAIL a code to the sign-in address. Held at every door that names it:
//
//   * the reveal (`POST …/login-code/reveal`) refuses 409 `signed_in_before`,
//     naming Email sign-in code;
//   * the People row carries `can_use_code: 0` with that reason, so the kebab
//     withholds the item and says why (the browser half below);
//   * the desk sign-up's duplicate-address answer names Email sign-in code;
//   * a desk code shown BEFORE a first sign-in by another door no longer signs
//     anyone in afterwards (the redeem asks the same `hasSignedIn`);
//   * a manual Verify of the walk-up leaves the desk code they hold working.
//
// Every refusal is paired with the never-signed-in control on the same path,
// and "has signed in" is reached through the real redeem, so the lock follows
// what `stampLoginTimes` records.
const { test, expect } = require("./isolated-test");
const Database = require("better-sqlite3");
const { freshCtx, getSuperadminPass, registerPost, TEST_DB_PATH, BASE } = require("./helpers");
const { adminLogin, openKebab, narrowPeopleTable } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `fs${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()} ${await r.text()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/** A walk-up made at the desk: verified, approved, never signed in, code in hand. */
async function deskInvite(api, csrf, email) {
  const r = await api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email } });
  expect(r.status(), `desk-invite ${email}: ${await r.text()}`).toBe(200);
  return r.json();
}

async function redeem(email, code) {
  const { api, csrf } = await freshCtx();
  try {
    const r = await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email, code } });
    expect(r.status(), "redeem answers 200 whatever the outcome").toBe(200);
    return await r.json();
  } finally { await api.dispose(); }
}

function dbGet(sql, ...args) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
}

// The participants page is cached 5 s by (actor, page, limit): a fresh limit per
// read is a cache key nothing else has used.
let listLimit = 1700;
async function listRow(api, id) {
  const r = await api.get(`/api/admin/participants?limit=${listLimit++}`);
  expect(r.ok(), `participants list: ${r.status()}`).toBeTruthy();
  const row = (await r.json()).participants.find((p) => p.id === id);
  expect(row, `participant ${id} is on the list page`).toBeTruthy();
  return row;
}

test.describe("Show sign-in code: never-signed-in accounts only (operator ruling, 14 Nov 2026)", () => {
  test("the reveal and the row offer a code until the first sign-in, then refuse it naming Email sign-in code", async () => {
    const { api, csrf } = await sa();
    try {
      const email = `${uniq()}@company.example`;
      const walk = await deskInvite(api, csrf, email);

      // CONTROL — never signed in: the row offers the code and the reveal hands one over.
      const before = await listRow(api, walk.id);
      expect(before.login_time, "PRECONDITION: the desk account has never signed in").toBeFalsy();
      expect(before.can_use_code, "a never-signed-in walk-up is offered a code").toBe(1);
      expect(before.code_blocked_reason).toBeNull();
      const shown = await api.post(`/api/admin/participants/${walk.id}/login-code/reveal`, { headers: H(csrf), data: {} });
      expect(shown.status(), `reveal before any sign-in: ${await shown.text()}`).toBe(200);
      const code = (await shown.json()).code;
      expect(code, "a code is shown").toBeTruthy();

      // The walk-up signs in with it: that is the first sign-in.
      expect((await redeem(email, code)).ok, "the shown code signs them in").toBe(true);
      expect(dbGet("SELECT login_time FROM users WHERE id=?", walk.id).login_time, "the sign-in was recorded").toBeTruthy();

      // After it: no more shown codes, said by name, with the door that remains.
      const after = await listRow(api, walk.id);
      expect(after.can_use_code, "the row no longer offers a shown code").toBe(0);
      expect(after.code_blocked_reason, "and names why").toBe("signed_in_before");
      const refused = await api.post(`/api/admin/participants/${walk.id}/login-code/reveal`, { headers: H(csrf), data: {} });
      expect(refused.status(), "a named refusal").toBe(409);
      const body = await refused.json();
      expect(body.code).toBe("signed_in_before");
      expect(body.error, "the refusal names the door that still works").toMatch(/Email sign-in code/);
      expect(JSON.stringify(body), "no code rides the refusal").not.toMatch(/[0-9A-Z]{4}-[0-9A-Z]{4}/);
      expect(dbGet("SELECT login_code_hash FROM users WHERE id=?", walk.id).login_code_hash,
        "nothing was minted by the refused reveal").toBeNull();

      // The remaining door works: Email sign-in code still mints a code. The
      // shared test server's relay is dead by design, so the send fails — and
      // its answer must not point at the shown code this account is refused.
      const emailed = await api.post(`/api/admin/participants/${walk.id}/login-code/email`, { headers: H(csrf), data: {} });
      expect(emailed.status(), `Email sign-in code: ${await emailed.text()}`).toBe(200);
      expect(dbGet("SELECT login_code_via FROM users WHERE id=?", walk.id).login_code_via,
        "Email sign-in code minted an emailed code").toBe("email");
      const emailedBody = await emailed.json();
      expect(emailedBody.reason, "PRECONDITION: the dead relay refused the send").toBe("send_failed");
      expect(emailedBody.message, "the failed send does not point at the shown code").not.toMatch(/Show sign-in code/);
    } finally { await api.dispose(); }
  });

  test("CONTROL — Email sign-in code's failed send still points a never-signed-in walk-up at Show sign-in code", async () => {
    const { api, csrf } = await sa();
    try {
      const walk = await deskInvite(api, csrf, `${uniq()}@company.example`);
      // Let the desk code lapse (a live one is never replaced by an emailed one).
      const db = new Database(TEST_DB_PATH);
      try { db.prepare("UPDATE users SET login_code_at=? WHERE id=?").run(new Date(Date.now() - 3600_000).toISOString(), walk.id); }
      finally { db.close(); }
      const emailed = await api.post(`/api/admin/participants/${walk.id}/login-code/email`, { headers: H(csrf), data: {} });
      expect(emailed.status(), `Email sign-in code: ${await emailed.text()}`).toBe(200);
      const b = await emailed.json();
      expect(b.reason, "PRECONDITION: the dead relay refused the send").toBe("send_failed");
      expect(b.message, "for someone who has never signed in, the desk fallback is named").toMatch(/Show sign-in code/);
    } finally { await api.dispose(); }
  });

  test("the desk sign-up's duplicate answer names Email sign-in code once the holder has signed in, Show sign-in code before (CONTROL)", async () => {
    const { api, csrf } = await sa();
    try {
      const email = `${uniq()}@company.example`;
      const walk = await deskInvite(api, csrf, email);

      // CONTROL — never signed in: the remedy is the shown code.
      const dup0 = await api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email } });
      expect(dup0.status()).toBe(409);
      expect((await dup0.json()).error, "before a sign-in the remedy is Show sign-in code").toMatch(/Show sign-in code/);

      expect((await redeem(email, walk.code)).ok, "the desk sign-up's own code signs them in").toBe(true);
      const dup1 = await api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email } });
      expect(dup1.status()).toBe(409);
      const err = (await dup1.json()).error;
      expect(err, "after it, the remedy is the emailed code").toMatch(/Email sign-in code/);
      expect(err, "…and it never points at the shown code it would be refused").not.toMatch(/use Show sign-in code/);
    } finally { await api.dispose(); }
  });

  test("a sign-in whose login stamp fails is refused, so the account never reads as never-signed-in after signing in", async () => {
    // The stamp is the reveal's only input, so it is not best-effort: a failed
    // write must fail the sign-in rather than leave a signed-in account offered a
    // shown code. The failure is planted with a trigger that aborts only the
    // stamp's UPDATE (it names login_time), only for this account.
    const { api, csrf } = await sa();
    const email = `${uniq()}@company.example`;
    const walk = await deskInvite(api, csrf, email);
    const trig = `fs_stamp_fail_${TAG}_${(seq++).toString(36)}`;
    const w = new Database(TEST_DB_PATH);
    try {
      w.exec(`CREATE TRIGGER ${trig} BEFORE UPDATE OF login_time, last_login_time ON users ` +
        `WHEN NEW.id = '${walk.id.replace(/'/g, "''")}' BEGIN SELECT RAISE(ABORT, 'stamp refused by the test'); END`);
      const { api: anon, csrf: ac } = await freshCtx();
      try {
        const r = await anon.post("/api/auth/code/redeem", { headers: H(ac), data: { email, code: walk.code } });
        const text = await r.text();
        expect(r.status(), `the sign-in is refused when its stamp fails: ${text}`).toBe(500);
        expect(text, "…and nothing claims it succeeded").not.toMatch(/"ok"\s*:\s*true/);
        expect((await anon.get("/api/me")).status(), "no session was granted").toBe(401);
      } finally { await anon.dispose(); }
      const row = dbGet("SELECT login_time, last_login_time FROM users WHERE id=?", walk.id);
      expect(row.login_time, "never signed in, and it says so").toBeNull();
      expect(row.last_login_time).toBeNull();
      expect((await listRow(api, walk.id)).can_use_code, "so the desk may still show a code").toBe(1);
    } finally {
      try { w.exec(`DROP TRIGGER IF EXISTS ${trig}`); } finally { w.close(); }
    }
    try {
      // CONTROL — with the stamp working, the same account signs in with a
      // freshly shown code, and from then on the desk can only email one.
      const shown = await api.post(`/api/admin/participants/${walk.id}/login-code/reveal`, { headers: H(csrf), data: {} });
      expect(shown.status(), `reveal after the failed sign-in: ${await shown.text()}`).toBe(200);
      expect((await redeem(email, (await shown.json()).code)).ok, "the sign-in goes through").toBe(true);
      expect(dbGet("SELECT login_time FROM users WHERE id=?", walk.id).login_time, "and is recorded").toBeTruthy();
      const again = await api.post(`/api/admin/participants/${walk.id}/login-code/reveal`, { headers: H(csrf), data: {} });
      expect(again.status(), "the shown code is refused from then on").toBe(409);
    } finally { await api.dispose(); }
  });

  test("a desk code shown before a first sign-in by another door does not sign anyone in afterwards", async () => {
    const { api, csrf } = await sa();
    try {
      // Two walk-ups, each holding a code shown at the desk.
      const emailA = `${uniq()}@company.example`;
      const emailB = `${uniq()}@company.example`;
      const a = await deskInvite(api, csrf, emailA);
      const b = await deskInvite(api, csrf, emailB);
      // A signs in by another door while its desk code is live: the sign-in
      // bookkeeping every door writes (`stampLoginTimes`).
      const db = new Database(TEST_DB_PATH);
      try {
        const at = new Date().toISOString();
        db.prepare("UPDATE users SET login_time=?, last_login_time=? WHERE id=?").run(at, at, a.id);
      } finally { db.close(); }
      expect(dbGet("SELECT login_code_via FROM users WHERE id=?", a.id).login_code_via, "PRECONDITION: A still holds a live desk code").toBe("desk");

      expect((await redeem(emailA, a.code)).ok, "A's desk code, shown before its first sign-in, is refused after it").toBeFalsy();
      expect(dbGet("SELECT login_code_hash FROM users WHERE id=?", a.id).login_code_hash, "…and spent").toBeNull();
      // CONTROL — B never signed in, and its desk code still works.
      expect((await redeem(emailB, b.code)).ok, "a never-signed-in walk-up's desk code still signs them in").toBe(true);
    } finally { await api.dispose(); }
  });

  test("a manual Verify leaves the desk code the walk-up holds alone: it still signs them in", async () => {
    const { api, csrf } = await sa();
    try {
      // An approved, UNVERIFIED account that has never signed in: a join-link
      // registration (approved by the link, rewound to the unverified fixture
      // state), the account the desk reveals a code for and then verifies.
      const cr = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
        name: `Verify keeps code ${uniq()}`, event_kind: "tournament", timezone: "UTC", self_enroll_enabled: true,
        start_time: new Date(Date.now() - 60e3).toISOString(), duration_minutes: 600,
      } });
      expect(cr.ok(), await cr.text()).toBeTruthy();
      const compId = (await cr.json()).competition.id;
      const token = (await (await api.get(`/api/admin/competitions/${compId}/self-enroll`)).json()).token;
      expect(token, "PRECONDITION: a join token").toBeTruthy();
      const email = `${uniq()}@company.example`;
      const { api: anon, csrf: ac } = await freshCtx();
      try {
        const reg = await registerPost(anon, "/api/register", { headers: H(ac), data: {
          email, joinToken: token, firstName: "Walk", lastName: "Up", company: "Acme", title: "Eng",
          country: "GB", timezone: "Europe/London",
        } });
        expect(reg.ok(), `join-link registration: ${reg.status()} ${await reg.text()}`).toBeTruthy();
      } finally { await anon.dispose(); }
      const id = dbGet("SELECT id FROM users WHERE LOWER(email)=LOWER(?)", email).id;
      expect(dbGet("SELECT approved, verified, login_time, last_login_time FROM users WHERE id=?", id),
        "PRECONDITION: approved, unverified, never signed in").toEqual({ approved: 1, verified: 0, login_time: null, last_login_time: null });

      const shown = await api.post(`/api/admin/participants/${id}/login-code/reveal`, { headers: H(csrf), data: {} });
      expect(shown.status(), `reveal: ${await shown.text()}`).toBe(200);
      const code = (await shown.json()).code;
      const held = dbGet("SELECT login_code_hash, login_code_via, login_code_at FROM users WHERE id=?", id);
      expect(held.login_code_hash, "PRECONDITION: a desk code is stored").toBeTruthy();
      expect(held.login_code_via).toBe("desk");

      const v = await api.post(`/api/admin/participants/${id}/verify`, { headers: H(csrf), data: {} });
      expect(v.status(), `verify: ${await v.text()}`).toBe(200);
      expect(dbGet("SELECT verified FROM users WHERE id=?", id).verified, "PRECONDITION: the verify landed").toBe(1);
      expect(dbGet("SELECT login_code_hash, login_code_via, login_code_at FROM users WHERE id=?", id),
        "the verify left the stored code, its provenance and its age alone").toEqual(held);

      // CONTROL: a wrong well-formed code is refused, so the redeem below is a real check.
      expect((await redeem(email, "ZZZZ-ZZZZ")).ok, "CONTROL: a wrong code signs nobody in").toBeFalsy();
      expect((await redeem(email, code)).ok, "the code the desk showed still signs the walk-up in").toBe(true);
    } finally { await api.dispose(); }
  });
});

test.describe("the People row menu withholds Show sign-in code after a first sign-in, and says why", () => {
  let ST;

  test.beforeAll(async () => {
    const { api, csrf } = await sa();
    try {
      const signedEmail = `${uniq()}@company.example`;
      const signed = await deskInvite(api, csrf, signedEmail);
      expect((await redeem(signedEmail, signed.code)).ok, "PRECONDITION: the first walk-up signed in").toBe(true);
      const fresh = await deskInvite(api, csrf, `${uniq()}@company.example`);
      // A real writer, so the 5 s participants-page cache cannot serve the row
      // as it was before the sign-in.
      await api.post(`/api/admin/participants/${signed.id}/tags`, { headers: H(csrf), data: { tag: "fscachebust" } });
      await api.delete(`/api/admin/participants/${signed.id}/tags/fscachebust`, { headers: H(csrf) });
      ST = { signed, fresh };
    } finally { await api.dispose(); }
  });

  async function participantRow(page, email) {
    const btn = page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first();
    await btn.waitFor({ state: "attached" });
    await btn.evaluate((el) => el.click());
    await page.locator("#admin-participants-tab").waitFor({ state: "visible", timeout: 5000 });
    await narrowPeopleTable(page, email);
    await expect.poll(async () => page.locator("#admin-participants-body tr").count(),
      { timeout: 10000, intervals: [100, 200, 400, 800] }).toBeLessThan(5);
    const row = page.locator(`#admin-participants-body tr:has-text("${email}")`).first();
    await row.waitFor({ state: "visible", timeout: 10000 });
    return row;
  }

  test("a signed-in row: no Show sign-in code, a note naming Email sign-in code, which is offered", async ({ page }) => {
    await adminLogin(page);
    const row = await participantRow(page, ST.signed.email);
    await openKebab(page, row);
    const portal = page.locator("#kebab-portal");
    await expect(portal.locator("button:has-text('Show sign-in code')"), "the shown code would be refused, so it is not offered").toHaveCount(0);
    const note = portal.locator(".kebab-note");
    await expect(note, "the absence is explained").toHaveCount(1);
    await expect(note).toContainText(/signed in before/i);
    await expect(note).toContainText(/Email sign-in code/);
    await expect(portal.locator("button:has-text('Email sign-in code')"), "the door it names is in this menu").toHaveCount(1);
  });

  test("CONTROL — a never-signed-in row still offers Show sign-in code, with no note", async ({ page }) => {
    await adminLogin(page);
    const row = await participantRow(page, ST.fresh.email);
    await openKebab(page, row);
    const portal = page.locator("#kebab-portal");
    await expect(portal.locator("button:has-text('Show sign-in code')"), "the desk fallback is reachable").toHaveCount(1);
    await expect(portal.locator(".kebab-note"), "nothing to explain").toHaveCount(0);
  });
});
