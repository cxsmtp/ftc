// @ts-check
// v8.1.3 — THE DESK FALLBACK MUST NOT MISLEAD THE ADMIN STANDING AT IT.
//
// Three refusals and one number, all of which told an organiser with a queue in
// front of them something that was not true:
//
//   #19  the reveal reported the full ten-minute TTL unconditionally, while
//        `login_code_at` anchors to the FIRST mint of the window — so on this
//        feature's own headline scenario (emailed code greylisted at T+0,
//        attendee at the desk at T+8) the admin read out "about 10 minutes" for
//        a code that died in two;
//   #20  the reveal, the row projection and the kebab all omitted `approved`
//        while POST /api/auth/code/redeem enforces it — so a passwordless
//        unapproved account (every LinkedIn self-signup still in the queue) was
//        offered the action, handed a working-LOOKING code, and refused at every
//        redemption with copy that blamed expiry;
//   #28  desk-invite's duplicate-email 409 named "Show sign-in code"
//        unconditionally, and that row action does not exist for a password
//        holder — which, since ordinary registration stamps `password_set_at`,
//        is the common case. Two refusals, neither naming anything that works.
//
// Every test owns its fixtures. The API half dodges the 5 s participants-page
// cache by asking for a distinct `limit` per read (the key is
// competitionId:page:limit and `search` is not part of it), which is
// deterministic where polling would merely be patient.
const { test, expect } = require("./isolated-test");
const Database = require("better-sqlite3");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, BASE } = require("./helpers");
const { adminLogin, openKebab, narrowPeopleTable } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `dr${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()} ${await r.text()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/** Create a walk-up at the desk: verified, approved, PASSWORDLESS, code in hand. */
async function deskInvite(api, csrf, email) {
  const r = await api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email } });
  expect(r.status(), `desk-invite ${email}: ${await r.text()}`).toBe(200);
  return r.json();
}

function dbRun(sql, ...args) {
  const db = new Database(TEST_DB_PATH);
  try { return db.prepare(sql).run(...args); } finally { db.close(); }
}

// A DIRECT db write cannot invalidate the 5 s participants-page cache the way a
// real writer does, and the browser half cannot choose its own `limit`. A tag
// round-trip is the cheapest thing that calls invalidateAdminParticipantsCache()
// on both legs.
async function bustParticipantsCache(api, csrf, id) {
  await api.post(`/api/admin/participants/${id}/tags`, { headers: H(csrf), data: { tag: "deskcachebust" } });
  await api.delete(`/api/admin/participants/${id}/tags/deskcachebust`, { headers: H(csrf) });
}

let listLimit = 900;
/** Read one row out of the admin list, on a cache key nothing else has used. */
async function listRow(api, id) {
  const r = await api.get(`/api/admin/participants?limit=${listLimit++}`);
  expect(r.ok(), `participants list: ${r.status()}`).toBeTruthy();
  const row = (await r.json()).participants.find((p) => p.id === id);
  expect(row, `participant ${id} is on the list page`).toBeTruthy();
  return row;
}

async function redeem(email, code) {
  const { api, csrf } = await freshCtx();
  try {
    const r = await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email, code } });
    // 200-ALWAYS, including every failure: a non-429 4xx feeds the
    // scanner-reputation counter, which blocks a whole NAT at 100 in ten
    // minutes. The outcome is in the payload, never in the status.
    expect(r.status(), "redeem answers 200 whatever the outcome").toBe(200);
    return await r.json();
  } finally { await api.dispose(); }
}

// ── #19 — the number ─────────────────────────────────────────────────────────
test.describe("v8.1.3 — the reveal reports the time the code actually has", () => {

  // Catches: `expires_in_minutes: Math.round(LOGIN_CODE_TTL_MS / 60000)`, the
  // shipped expression, which answers 10 for every reveal including a re-issue
  // into a window that is nearly spent. Also catches a build that drops the
  // field or reports zero, and — via the fresh-mint control — one that always
  // reports a short window, which would be equally satisfied by "not 10".
  test("a re-issue into a part-spent window reports what is LEFT, not the full TTL", async () => {
    const { api, csrf } = await sa();
    const email = `${uniq()}@company.example`;
    const walk = await deskInvite(api, csrf, email);

    // CONTROL — a fresh mint really does still get the whole window. Without
    // this, "the reissue reported 2" is satisfied by a build that under-reports
    // every code.
    expect(walk.expires_in_minutes, "a FIRST mint has the full ten-minute window").toBe(10);

    // Age the window's anchor by eight minutes. `login_code_at` is what the TTL
    // is measured from and a re-issue deliberately does not move it, so the
    // account now holds a live code with about two minutes on it.
    dbRun("UPDATE users SET login_code_at=? WHERE id=?",
      new Date(Date.now() - 8 * 60_000).toISOString(), walk.id);

    const r = await api.post(`/api/admin/participants/${walk.id}/login-code/reveal`, { headers: H(csrf), data: {} });
    expect(r.status(), `reveal: ${await r.text()}`).toBe(200);
    const rev = await r.json();
    expect(rev.code, "a code is still issued — the window is nearly spent, not gone").toBeTruthy();
    expect(rev.expires_in_minutes,
      "the admin is told the ~2 minutes that remain, not the headline 10").toBeLessThanOrEqual(2);
    expect(rev.expires_in_minutes,
      "…and it is a real number, not zero or a dropped field").toBeGreaterThanOrEqual(1);

    await api.dispose();
  });
});

// ── #20 — approval ───────────────────────────────────────────────────────────
test.describe("v8.1.3 — an unapproved account is refused, and the row says why", () => {

  // Catches: the reveal's ladder omitting `approved` (200 + a code that cannot
  // be redeemed), and the row projecting can_use_code=1 for the same account —
  // which is what put the kebab item in front of the admin in the first place.
  // The POSITIVE CONTROL at the end is what stops all of it being satisfied by a
  // build that refuses everybody.
  test("refused with the approval reason; approving it makes the code work", async () => {
    const { api, csrf } = await sa();
    const email = `${uniq()}@company.example`;
    const walk = await deskInvite(api, csrf, email);

    // Put the account into the state a LinkedIn self-signup sits in: verified,
    // passwordless, waiting in the approval queue.
    dbRun("UPDATE users SET approved=0 WHERE id=?", walk.id);
    await bustParticipantsCache(api, csrf, walk.id);

    // THE PREMISE, asserted rather than assumed: redeem has always refused an
    // unapproved account. This is the code desk-invite handed over while the
    // account was still approved, so nothing but approval has changed.
    expect((await redeem(email, walk.code)).ok,
      "redeem refuses an unapproved account — which is why the reveal must too").toBeFalsy();

    const before = await listRow(api, walk.id);
    expect(before.approved, "precondition: the account really is unapproved").toBeFalsy();
    expect(before.can_use_code, "so the row must NOT advertise a sign-in code").toBe(0);
    expect(before.code_blocked_reason, "and it must say which condition refused").toBe("not_approved");

    const refused = await api.post(`/api/admin/participants/${walk.id}/login-code/reveal`, { headers: H(csrf), data: {} });
    expect(refused.status(), "a named refusal, not a silent success (v7.14.2 at API level)").toBe(409);
    const rBody = await refused.json();
    expect(rBody.code).toBe("not_approved");
    // The remedy must be one that EXISTS for this account. It is verified, so
    // Approve is offered on the same kebab and is the whole answer.
    expect(rBody.error, "the refusal names Approve").toMatch(/approve/i);

    // ── POSITIVE CONTROL ──────────────────────────────────────────────────────
    const appr = await api.post(`/api/admin/participants/${walk.id}/approve`, { headers: H(csrf) });
    expect(appr.ok(), `approve: ${await appr.text()}`).toBeTruthy();

    const after = await listRow(api, walk.id);
    expect(after.can_use_code, "approved: the row offers the action again").toBe(1);
    expect(after.code_blocked_reason, "…with nothing left to explain").toBeNull();

    const ok = await api.post(`/api/admin/participants/${walk.id}/login-code/reveal`, { headers: H(csrf), data: {} });
    expect(ok.status(), `reveal after approve: ${await ok.text()}`).toBe(200);
    const good = await ok.json();
    // The affordance and the outcome come from the same predicate, end to end.
    expect((await redeem(email, good.code)).ok, "the revealed code really signs them in").toBe(true);

    await api.dispose();
  });

  // Catches: collapsing the two branches into one sentence that names Approve.
  // POST .../approve REFUSES an unverified account and POST .../verify is
  // superadmin-only, so telling a regular admin to "Approve it" here would be
  // one more instruction pointing at a control that will not work — the exact
  // class of defect (v7.29.0 FROZEN_REMEDY, v7.21.14) this batch is closing.
  test("an UNVERIFIED, unapproved account is told about Verify and whose job it is", async () => {
    const { api, csrf } = await sa();
    const walk = await deskInvite(api, csrf, `${uniq()}@company.example`);
    dbRun("UPDATE users SET approved=0, verified=0 WHERE id=?", walk.id);

    const r = await api.post(`/api/admin/participants/${walk.id}/login-code/reveal`, { headers: H(csrf), data: {} });
    expect(r.status()).toBe(409);
    const body = await r.json();
    expect(body.code).toBe("not_approved");
    expect(body.error, "names verification, which Approve alone cannot satisfy").toMatch(/verif/i);
    expect(body.error, "and names the tier that owns it").toMatch(/superadmin/i);

    await api.dispose();
  });
});

// ── #28 — the duplicate-email remedy ─────────────────────────────────────────
test.describe("v8.1.3 — desk-invite names a remedy that exists for THAT account", () => {



  // CONTROL — without it, "the copy no longer says Show sign-in code" is equally
  // satisfied by a build that removed that sentence altogether, which would
  // break the case the sentence was written for.
  test("a duplicate held by a PASSWORDLESS account still points at Show sign-in code", async () => {
    const { api, csrf } = await sa();
    const email = `${uniq()}@company.example`;
    await deskInvite(api, csrf, email);

    const dup = await api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email } });
    expect(dup.status()).toBe(409);
    expect((await dup.json()).error, "this account CAN use a code, so say so").toMatch(/show sign-in code/i);

    await api.dispose();
  });

  // Catches a two-branch shortcut (eligible vs "not eligible"): an unapproved
  // passwordless duplicate is the one case where a code WILL work after one
  // click, and saying "use Reset Password" there would be the wrong answer.
  test("a duplicate held by an UNAPPROVED passwordless account points at Approve", async () => {
    const { api, csrf } = await sa();
    const email = `${uniq()}@company.example`;
    const walk = await deskInvite(api, csrf, email);
    dbRun("UPDATE users SET approved=0 WHERE id=?", walk.id);

    const dup = await api.post("/api/admin/participants/desk-invite", { headers: H(csrf), data: { email } });
    expect(dup.status()).toBe(409);
    const err = (await dup.json()).error;
    expect(err, "approval is the step that unblocks this one").toMatch(/approv/i);
    expect(err, "not a password reset — the account has no password").not.toMatch(/reset password/i);

    await api.dispose();
  });
});

// ── #20, the surface an organiser actually looks at ──────────────────────────
test.describe("v8.1.3 — the kebab hides the code action for an unapproved row, and says why", () => {
  let ST;

  test.beforeAll(async () => {
    const { api, csrf } = await sa();
    const pending = await deskInvite(api, csrf, `${uniq()}@company.example`);
    const ready = await deskInvite(api, csrf, `${uniq()}@company.example`);
    dbRun("UPDATE users SET approved=0 WHERE id=?", pending.id);
    // The direct write above cannot invalidate the 5 s participants-page cache;
    // the browser cannot pick its own cache key, so bust it through a real writer.
    await bustParticipantsCache(api, csrf, pending.id);
    ST = { pending, ready };
    await api.dispose();
  });

  /** Narrow to one row, waiting out the DEBOUNCED search before touching it. */
  async function participantRow(page, email) {
    const btn = page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first();
    await btn.waitFor({ state: "attached" });
    await btn.evaluate((el) => el.click());
    await page.locator("#admin-participants-tab").waitFor({ state: "visible", timeout: 5000 });
    await narrowPeopleTable(page, email);
    // `.fill()` returns while the table still holds the pre-filter rows, so the
    // row found here can be one the debounce is about to destroy — the kebab
    // click then lands on a detached node and opens nothing (v8.1.0).
    await expect.poll(async () => page.locator("#admin-participants-body tr").count(),
      { timeout: 10000, intervals: [100, 200, 400, 800] }).toBeLessThan(5);
    const row = page.locator(`#admin-participants-body tr:has-text("${email}")`).first();
    await row.waitFor({ state: "visible", timeout: 10000 });
    return row;
  }

  // Catches: the gate keeping its old `p.can_use_code && !blocked && !denied_at`
  // shape (which offers the item for an unapproved account), and the note being
  // dropped — a menu that silently loses the one item the admin came for is
  // indistinguishable from a broken feature, and was reported as one.
  test("no Show sign-in code for an unapproved row, and a note naming Approve", async ({ page }) => {
    await adminLogin(page);

    const pendingRow = await participantRow(page, ST.pending.email);
    await openKebab(page, pendingRow);
    const portal = page.locator("#kebab-portal");
    await expect(portal.locator("button:has-text('Show sign-in code')"),
      "an unapproved account would be refused, so the item must not be offered").toHaveCount(0);
    const note = portal.locator(".kebab-note");
    await expect(note, "the absence is EXPLAINED, not silent").toHaveCount(1);
    await expect(note).toContainText(/sign-in code needs an approved account/i);
    // The remedy it names must be present in this very menu.
    await expect(note).toContainText(/approve/i);
    await expect(portal.locator("button:has-text('Approve')"),
      "…and Approve really is one item up").toHaveCount(1);
  });

  // POSITIVE CONTROL — without it, "the item was absent" is equally satisfied by
  // a build in which the row action never renders for anyone.
  test("an approved passwordless row still offers the action, with no note", async ({ page }) => {
    await adminLogin(page);

    const readyRow = await participantRow(page, ST.ready.email);
    await openKebab(page, readyRow);
    const portal = page.locator("#kebab-portal");
    await expect(portal.locator("button:has-text('Show sign-in code')"),
      "the desk fallback is reachable from an eligible row").toHaveCount(1);
    await expect(portal.locator(".kebab-note"),
      "nothing to explain when the action is there").toHaveCount(0);
  });
});
