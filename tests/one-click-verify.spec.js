// @ts-check
//
// v7.23.10 — ONE-CLICK email verification.
//
// The link used to land on an interstitial whose only job was to turn the GET
// into a POST. That shape came from the v7.15.11 rule "a GET must never mutate",
// generalised from GET /api/unsubscribe where a scanner prefetch silently opted
// recipients OUT. This route is a REASONED exception (see routes/auth.js and the
// accepted-dispositions note in CLAUDE.md): the mutation is the outcome the
// recipient asked for by registering, it grants no capability, and — the part
// that has to be true and is what these tests pin — it PRESENTS IDEMPOTENTLY.
//
// The regression that must never ship: a mail scanner prefetches the link and
// spends the single-use code, then the human clicks and is told "Verification
// Failed" for an account that is in fact verified.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { BASE, apiLogin, freshCtx, PARTICIPANT_PASS } = require("./helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });

// Register a participant and read their verify_code straight from the database —
// the code is never on the wire, and requiring lib/email here is forbidden
// (Docs hygiene, v7.21.14: it opens a SECOND database in the worker process).
async function pendingUser(suffix) {
  const Database = require("better-sqlite3");
  const { TEST_DB_PATH } = require("./helpers");
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;
  const email = `ocv_${suffix}_${stamp}@acme.com`;
  const { api, csrf } = await freshCtx();
  const r = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "One", lastName: "Click", nickname: `ocv${suffix}${stamp}`.slice(0, 24),
      company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC", email, password: PARTICIPANT_PASS,
    },
  });
  expect(r.ok(), `register ${email}: ${r.status()} ${await r.text()}`).toBeTruthy();
  await api.dispose();
  const db = new Database(TEST_DB_PATH, { readonly: true });
  const row = db.prepare("SELECT id, verify_code, verified FROM users WHERE LOWER(email)=LOWER(?)").get(email);
  db.close();
  expect(row, `the seeded user ${email} must exist`).toBeTruthy();
  expect(row.verify_code, "PRECONDITION: registerPost's fixture state carries a verify_code (a real sign-up has none: its proven address is its verification)").toBeTruthy();
  expect(row.verified, "…and is UNVERIFIED, as an older or imported account can be, or the test proves nothing").toBe(0);
  return { email, id: row.id, code: row.verify_code };
}

function verifiedFlag(id) {
  const Database = require("better-sqlite3");
  const { TEST_DB_PATH } = require("./helpers");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  const r = db.prepare("SELECT verified, verify_code FROM users WHERE id=?").get(id);
  db.close();
  return r;
}

test("v7.23.10: ONE click from the email verifies — no interstitial", async ({ page }) => {
  const u = await pendingUser("one");
  const resp = await page.goto(`/verify?code=${encodeURIComponent(u.code)}`);
  // The old flow answered 200 with a form; the new one redirects to the result.
  expect(new URL(page.url()).pathname, "one click must land on the result page").toBe("/verified.html");
  expect(resp.status()).toBe(200);
  // Non-vacuity in the direction that matters: there must be NO button left to
  // press. A test that only checked the URL would pass against a flow that
  // redirected to an interstitial.
  await expect(page.locator("form[action='/verify'], button:has-text('Verify My Email')"),
    "the confirm step must be gone").toHaveCount(0);
  expect(verifiedFlag(u.id).verified, "the account must actually be verified").toBe(1);
});

test("v7.23.10: a scanner prefetch does NOT make the human's click fail", async ({ page, browser }) => {
  // THE POINT OF THE WHOLE DESIGN. A mail scanner GETs the link from somewhere
  // else entirely — a different client, a different network, no cookies — and
  // spends the code. Then the person clicks.
  const u = await pendingUser("scan");

  const scanner = await browser.newContext();          // no shared state, deliberately
  const pre = await scanner.request.get(`${BASE}/verify?code=${encodeURIComponent(u.code)}`);
  expect(pre.ok(), "the scanner's prefetch itself should succeed").toBeTruthy();
  await scanner.close();
  expect(verifiedFlag(u.id).verified, "the prefetch verifies the account").toBe(1);

  await page.goto(`/verify?code=${encodeURIComponent(u.code)}`);
  expect(new URL(page.url()).pathname,
    "the human must be told the truth, not 'Verification Failed'").toBe("/verified.html");
  await expect(page.locator("body")).toContainText(/verified/i);
});

test("v7.23.10: a refresh after verifying does not re-enter the handler", async ({ page }) => {
  // Post/redirect/get, which the interstitial used to provide. The browser must
  // rest on a static page whose reload re-fetches that page and mutates nothing.
  const u = await pendingUser("prg");
  await page.goto(`/verify?code=${encodeURIComponent(u.code)}`);
  expect(new URL(page.url()).pathname).toBe("/verified.html");
  await page.reload();
  expect(new URL(page.url()).pathname, "a reload must stay on the result page").toBe("/verified.html");
  await expect(page.locator("body")).toContainText(/verified/i);
});

test("v7.23.10: an ALREADY-VERIFIED user past the 48h window is not told the link expired", async ({ page }) => {
  // The sharpest edge in this design. The code now survives a successful
  // verification, so without the already-verified check running BEFORE the
  // expiry check, the same user clicking their own link at T+48h would be told
  // "Link Expired" — for an account that is verified. Wrong twice over.
  const u = await pendingUser("aged");
  await page.goto(`/verify?code=${encodeURIComponent(u.code)}`);
  expect(new URL(page.url()).pathname).toBe("/verified.html");

  // Age the receipt past the window.
  const Database = require("better-sqlite3");
  const { TEST_DB_PATH } = require("./helpers");
  const dbw = new Database(TEST_DB_PATH);
  dbw.prepare("UPDATE users SET verify_code_at=? WHERE id=?")
    .run(new Date(Date.now() - 90 * 60 * 60 * 1000).toISOString(), u.id);
  dbw.close();

  await page.goto(`/verify?code=${encodeURIComponent(u.code)}`);
  expect(new URL(page.url()).pathname,
    "an aged code on a VERIFIED account must still report success").toBe("/verified.html");
});

test("v7.23.10: an expired code on an UNVERIFIED account still says expired", async ({ page }) => {
  // The negative control for the test above: moving the already-verified check
  // ahead of the expiry check must not disable the expiry branch itself.
  const u = await pendingUser("exp");
  const Database = require("better-sqlite3");
  const { TEST_DB_PATH } = require("./helpers");
  const dbw = new Database(TEST_DB_PATH);
  dbw.prepare("UPDATE users SET verify_code_at=? WHERE id=?")
    .run(new Date(Date.now() - 90 * 60 * 60 * 1000).toISOString(), u.id);
  dbw.close();

  await page.goto(`/verify?code=${encodeURIComponent(u.code)}`);
  expect(new URL(page.url()).pathname).toBe("/verify-expired.html");
  expect(verifiedFlag(u.id).verified, "an expired code must NOT verify anybody").toBe(0);
});

test("v7.23.10: an unknown code still fails, and verifies nobody", async ({ page }) => {
  await page.goto("/verify?code=definitely-not-a-real-code");
  expect(new URL(page.url()).pathname).toBe("/verify-failed.html");
});

test("v7.23.10: the redirect is no-store, so a cached failure cannot outlive it", async () => {
  // A 302 with no Cache-Control is heuristically cacheable. An intermediary
  // holding on to a FAILURE redirect would keep answering for a user whose
  // situation has since changed.
  const { api } = await freshCtx();
  const r = await api.get("/verify?code=definitely-not-a-real-code", { maxRedirects: 0 });
  expect(r.status(), "a considered answer must stay a redirect, never a 4xx — a "
    + "non-429 4xx feeds the scanner-reputation counter (v7.21.24)").toBe(302);
  expect((r.headers()["cache-control"] || "").toLowerCase()).toContain("no-store");
  await api.dispose();
});

test("v7.23.10: POST /verify still works, for a form cached from before this release", async () => {
  const u = await pendingUser("post");
  const { api, csrf } = await freshCtx();
  const r = await api.post("/verify", {
    headers: { "x-csrf-token": csrf, "content-type": "application/x-www-form-urlencoded" },
    form: { code: u.code },
    maxRedirects: 0,
  });
  expect(r.status()).toBe(302);
  expect(r.headers()["location"]).toBe("/verified.html");
  expect(verifiedFlag(u.id).verified).toBe(1);
  await api.dispose();
});

test("v7.23.10: the spent receipt is swept, so the index does not grow for ever", async ({ page }) => {
  // The code is retained ON PURPOSE — it is what lets the second request be
  // answered truthfully — but only for its own 48h window. Without the sweep the
  // partial index idx_users_verify_code would hold one row per verified user and
  // never shrink, because most people click exactly once.
  const u = await pendingUser("sweep");
  await page.goto(`/verify?code=${encodeURIComponent(u.code)}`);
  expect(verifiedFlag(u.id).verified).toBe(1);
  expect(verifiedFlag(u.id).verify_code, "the receipt is kept while it is still useful").toBeTruthy();

  const { api: sa, csrf } = await apiLogin("superadmin");
  const r = await sa.post("/api/test/reap-accounts", { headers: H(csrf), data: { ttlMs: 0 } });
  expect(r.ok(), `reap: ${r.status()} ${await r.text()}`).toBeTruthy();
  await sa.dispose();
  expect(verifiedFlag(u.id).verify_code, "a receipt past its window must be cleared").toBeNull();
  expect(verifiedFlag(u.id).verified, "…without un-verifying anybody").toBe(1);
});

test("v7.23.10: an import setting verified=0 kills the live receipt", async () => {
  // REQUIRED by the retained-code design, and a hole that design CREATES. The
  // code used to be nulled on success, so an operator importing verified=0 to
  // force re-verification was left with nothing live. Now the receipt survives
  // its 48h window — so without this, a late scanner re-crawl or the user
  // re-clicking the old link would silently undo a deliberate operator action.
  const u = await pendingUser("imp");
  const { api: sa, csrf } = await apiLogin("superadmin");

  const me = await (await sa.get(`/api/admin/participants?limit=5000&search=${encodeURIComponent(u.email)}`)).json();
  const row = (me.participants || []).find(p => p.email.toLowerCase() === u.email.toLowerCase());
  expect(row, "the import target must be findable").toBeTruthy();

  // Verify first, so a live receipt exists to be killed.
  const ctx = await freshCtx();
  await ctx.api.get(`/verify?code=${encodeURIComponent(u.code)}`);
  await ctx.api.dispose();
  expect(verifiedFlag(u.id).verified).toBe(1);
  expect(verifiedFlag(u.id).verify_code, "a live receipt must exist, or this is vacuous").toBeTruthy();

  // The endpoint takes { data: <an export envelope>, resolutions }. Without
  // `resolutions` it is a DRY RUN and writes nothing (CLAUDE.md *Import rules*),
  // which would make this test assert against an unchanged row.
  const payload = {
    data: { type: "hackarena-participants", participants: [{ ...row, verified: 0 }] },
    // Keyed by ROW INDEX (server.js: `resolutions[String(i)]`), not by email —
    // an email key is silently ignored and the row falls back to "keep", which
    // is a dry run wearing an overwrite's clothes.
    resolutions: { "0": "overwrite" },
  };
  const imp = await sa.post("/api/admin/import/participants", { headers: H(csrf), data: payload });
  expect(imp.ok(), `import: ${imp.status()} ${await imp.text()}`).toBeTruthy();
  await sa.dispose();

  const after = verifiedFlag(u.id);
  expect(after.verified, "the import must have taken effect").toBe(0);
  expect(after.verify_code,
    "the receipt must be cleared, or the old link silently re-verifies").toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════════════
// v8.3.23 — THE RECEIPT MUST SURVIVE EVERY OTHER ROUTE TO `verified=1`
// ═══════════════════════════════════════════════════════════════════════════════
//
// v7.23.10 moved the marker: `verified` means "done" and the retained
// `verify_code` is a 48h idempotency RECEIPT, which is the only reason a second
// click can be told "already verified" rather than "Verification Failed". It
// taught the SELF-SERVE path to keep the receipt and stopped there.
//
// Two OTHER routes reach `verified=1` and were still clearing it in the same
// statement, so each re-created the exact failure v7.23.10 exists to prevent —
// through a door it did not cover. The participant is told their verification
// FAILED for an account that is verified, and there is nothing they can do with
// that answer.
//
// The second door is by far the more common one: register → cannot find the
// verification mail → Forgot password → set a password (which verifies) → later
// find the original mail and click it.
//
// `/confirm-email` is deliberately NOT in this set and must keep clearing the
// receipt: that statement REPLACES the row's `email`, so a retained code would
// vouch for an address the account no longer has.

async function seedVerifiable(suffix) {
  const u = await pendingUser(suffix);
  const { api: sa, csrf } = await apiLogin("superadmin");
  return { u, sa, saH: { "x-csrf-token": csrf, "content-type": "application/json" } };
}

test("v8.3.23: an ADMIN manual verify leaves the participant's own link answering 'verified'", async ({ page }) => {
  const { u, sa, saH } = await seedVerifiable("adminverify");
  try {
    const v = await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: saH });
    expect(v.ok(), `verify: ${v.status()} ${await v.text()}`).toBeTruthy();
    expect(verifiedFlag(u.id).verified, "the admin verify must actually verify").toBe(1);
    // THE RECEIPT: without it the SELECT below finds no row at all.
    expect(verifiedFlag(u.id).verify_code,
      "the receipt must survive an admin verify, or the participant's link cannot answer").toBeTruthy();

    await page.goto(`/verify?code=${encodeURIComponent(u.code)}`);
    expect(new URL(page.url()).pathname,
      "the participant must be told the truth, not 'Verification Failed'").toBe("/verified.html");
    await expect(page.locator("body")).toContainText(/verified/i);
  } finally { await sa.dispose(); }
});



test("v8.3.23: /confirm-email STILL clears the receipt — it replaced the address", async ({ page }) => {
  // The control, and the reason this is not a blanket 'never clear it' rule. A
  // primary-email change swaps `users.email` in the same statement, so a
  // retained code would vouch for an address the row no longer carries. Keeping
  // it would be the opposite defect: a link that reports success about a mailbox
  // its owner no longer has on the account.
  const u = await pendingUser("confirmemail");
  const Database = require("better-sqlite3");
  const { TEST_DB_PATH } = require("./helpers");
  const stamp = `${Date.now().toString(36)}`;
  const newEmail = `ocv_moved_${stamp}@acme.com`;
  const planted = `pend-${stamp}`;
  const w = new Database(TEST_DB_PATH);
  w.prepare("UPDATE users SET pending_email=?, pending_email_code=?, pending_email_code_at=? WHERE id=?")
    .run(newEmail, planted, new Date().toISOString(), u.id);
  w.close();

  const { api, csrf } = await freshCtx();
  const r = await api.post("/confirm-email", { form: { code: planted, _csrf: csrf }, headers: { "x-csrf-token": csrf } });
  expect(r.status(), `confirm-email: ${r.status()}`).toBeLessThan(400);
  await api.dispose();

  const after = verifiedFlag(u.id);
  expect(after.verified, "confirming the new address verifies the account").toBe(1);
  expect(after.verify_code,
    "the receipt must NOT survive an address change — it would vouch for the old mailbox").toBeFalsy();
});
