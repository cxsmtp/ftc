// @ts-check
//
// v8.3.20 (external audit), re-pointed at the emailed sign-in code — CHANGING
// THE ADDRESS A CODE WAS ISSUED AGAINST REVOKES WHAT IS STILL OUTSTANDING, AND
// NOTHING ELSE DOES.
//
// A sign-in code is mailed to the account's PRIMARY address and redeemed
// against it only. So:
//
//   1. /confirm-email — swaps the primary address; the claim clears the codes;
//   2. the admin email correction is STAGED, so its revocation follows the
//      address when it actually moves (at /confirm-email);
//   3. a SECONDARY-address change — by the participant, an admin or the
//      participant import — leaves the live code alone: the secondary inbox
//      never holds one, and clearing it would only destroy a code the person
//      may be typing.
//
// A dead code is asserted by REDEEMING it, not by reading the column: a cleared
// column is equally consistent with a build that stopped honouring codes at
// all, which is why each revocation also carries a control that a code minted
// AFTER the rotation still works. A kept code is asserted the same way — it
// signs its holder in.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, TEST_DB_PATH } = require("./helpers");

const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const Database = () => new (require("better-sqlite3"))(TEST_DB_PATH);

async function mkParticipant(label) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const email = `${label}-${stamp}@company.co`;
  const { api, csrf } = await freshCtx();
  const r = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: "Rev", lastName: "Ocation", nickname: `${label}_${stamp}`,
      company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
      email,
    },
  });
  expect(r.ok(), `register ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  await api.dispose();
  const db = Database();
  try {
    const u = db.prepare("SELECT id FROM users WHERE email=?").get(email);
    expect(u, "the registered row").toBeTruthy();
    db.prepare("UPDATE users SET verified=1, approved=1 WHERE id=?").run(u.id);
    return { id: u.id, email };
  } finally { db.close(); }
}

/**
 * Mint a live emailed sign-in code for `email` through the real request door
 * and return its plaintext (read through the test-only capture). The re-send
 * suppression and the per-origin budget are cleared first: every request here
 * comes from one address, and each test mints more than one code.
 */
async function plantCode(email) {
  const { api, csrf } = await freshCtx();
  try {
    await api.post("/api/test/reset-recent-code-sends", { headers: H(csrf) });
    await api.post("/api/test/reset-origin-code-budget", { headers: H(csrf) });
    const rq = await api.post("/api/auth/code/request", { headers: H(csrf), data: { email } });
    expect(rq.status(), "the code request answers 200").toBe(200);
    const code = (await (await api.get(`/api/test/last-login-code?email=${encodeURIComponent(email)}`)).json()).code;
    expect(code, `PRECONDITION: a code was minted for ${email}`).toBeTruthy();
    return code;
  } finally { await api.dispose(); }
}

function col(userId, name) {
  const db = Database();
  try { return db.prepare(`SELECT ${name} AS v FROM users WHERE id=?`).get(userId).v; }
  finally { db.close(); }
}

/** Redeem a code through the real endpoint. Returns whether it signed in. */
async function redeem(email, code) {
  const { api, csrf } = await freshCtx();
  try {
    const r = await api.post("/api/auth/code/redeem", { headers: H(csrf), data: { email, code } });
    const d = await r.json().catch(() => ({}));
    return r.status() === 200 && d.ok === true;
  } finally { await api.dispose(); }
}

/**
 * The anti-vacuity control every test needs: a code minted AFTER the rotation
 * must still redeem. Without it, "the old code is dead" is satisfied by a build
 * where no code works at all.
 */
async function expectCodeStillWorks(email, label) {
  const fresh = await plantCode(email);
  expect(await redeem(email, fresh),
    `${label}: a FRESHLY minted code must still work — otherwise "the old one died" proves nothing`).toBe(true);
}

test.describe("A change of the address a code was issued against revokes what is outstanding (v8.3.20)", () => {





  test("PUT /api/me leaves the live code alone when the SECONDARY address changes, as on an unrelated save", async () => {
    const u = await mkParticipant("secrev");

    // (i) An UNRELATED profile save must NOT destroy a live code.
    {
      // Signed in first: signing in redeems a code of its own.
      const { api, csrf } = await apiLogin(u.email);
      const keep = await plantCode(u.email);
      const r = await api.put("/api/me", { headers: H(csrf), data: { city: "Bristol" } });
      expect(r.ok(), `unrelated save: ${r.status()} ${await r.text()}`).toBeTruthy();
      await api.dispose();
      expect(await redeem(u.email, keep), "an unrelated profile save must leave the live code alone").toBe(true);
    }

    // (ii) Adding, then dropping, the secondary address keeps the code the
    // PRIMARY was sent: it is the only address a code goes to.
    for (const [what, secondaryEmail] of [["add", `alt-${Date.now()}@company.co`], ["drop", ""]]) {
      const { api, csrf } = await apiLogin(u.email);
      const code = await plantCode(u.email);
      const hash = col(u.id, "login_code_hash");
      const r = await api.put("/api/me", { headers: H(csrf), data: { secondaryEmail } });
      expect(r.ok(), `${what} secondary: ${r.status()} ${await r.text()}`).toBeTruthy();
      await api.dispose();
      expect(col(u.id, "secondary_email") || "", `PRECONDITION: the ${what} landed`).toBe(secondaryEmail);
      expect(col(u.id, "login_code_hash"), `the ${what} left the stored code as it was`).toBe(hash);
      expect(await redeem(u.email, code), `a code mailed to the primary survives the secondary ${what}`).toBe(true);
    }
  });

  test("redeeming a stale link cannot mark a NEWLY changed primary address verified", async () => {
    // The verified-bypass half, which is what makes this more than a hygiene
    // item. `verified` gates login and leaderboard membership, and
    // `first_verified_at` is never cleared — it permanently exempts the row from
    // the unverified-account reaper.
    const u = await mkParticipant("verrev");

    // Stage and confirm a primary-email change, the way the participant does.
    const newEmail = `moved-${Date.now()}@company.co`;
    let code;
    {
      const { api, csrf } = await apiLogin(u.email);
      code = await plantCode(u.email);
      const r = await api.put("/api/me", { headers: H(csrf), data: { email: newEmail } });
      expect(r.ok(), `stage email: ${r.status()} ${await r.text()}`).toBeTruthy();
      await api.dispose();
    }
    const pending = col(u.id, "pending_email_code");
    expect(pending, "the change must have been staged").toBeTruthy();
    {
      const { api, csrf } = await freshCtx();
      const r = await api.post("/confirm-email", { headers: { "x-csrf-token": csrf, "content-type": "application/x-www-form-urlencoded" }, form: { code: pending, _csrf: csrf } });
      expect(r.status(), `confirm: ${r.status()}`).toBe(200);
      await api.dispose();
    }
    expect(col(u.id, "email")).toBe(newEmail);

    // The code was issued against the OLD address; it must not now act on the new one.
    expect(await redeem(newEmail, code),
      "a code issued against the previous address must not survive the swap").toBe(false);
    await expectCodeStillWorks(newEmail, "primary-swap");
  });

  test("an ADMIN clearing the SECONDARY address leaves the code the primary was sent", async () => {
    // A code is mailed to the PRIMARY and redeemed against it only, so the
    // secondary inbox never holds one: clearing that address protects nothing by
    // revoking, and would destroy the code the person may be typing.
    const u = await mkParticipant("admsec");
    {
      const { api, csrf } = await apiLogin(u.email);
      const add = await api.put("/api/me", { headers: H(csrf), data: { secondaryEmail: `compromised-${Date.now()}@company.co` } });
      expect(add.ok(), `add secondary: ${add.status()} ${await add.text()}`).toBeTruthy();
      await api.dispose();
    }
    const code = await plantCode(u.email);

    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const r = await sa.put(`/api/admin/participants/${u.id}`, { headers: H(saCsrf), data: { secondaryEmail: "" } });
    const status = r.status(); const body = await r.text();
    await sa.dispose();
    expect(status, `the admin secondary clear must succeed: ${body}`).toBe(200);
    expect(col(u.id, "secondary_email"), "PRECONDITION: the address really was cleared").toBeFalsy();

    expect(await redeem(u.email, code), "the code mailed to the primary still signs its holder in").toBe(true);
  });

  test("an unrelated ADMIN profile save does NOT destroy a live recovery credential", async () => {
    // The control that keeps the rule from being a nuisance, and the one that
    // makes the gating clause load-bearing: an admin correcting a typo in
    // someone's company name must not silently kill the reset link that person
    // is in the middle of using.
    const u = await mkParticipant("admkeep");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const keep = await plantCode(u.email);
    const r = await sa.put(`/api/admin/participants/${u.id}`, { headers: H(saCsrf), data: { company: "Renamed Ltd" } });
    const status = r.status(); const body = await r.text();
    await sa.dispose();
    expect(status, `unrelated admin save: ${body}`).toBe(200);
    expect(await redeem(u.email, keep), "an unrelated admin save must leave the live code alone").toBe(true);
  });

  test("the participant IMPORT keeps the code when an overwrite replaces the secondary address, and revokes it when it forces re-verification (CONTROL)", async () => {
    // The third door. An ordinary `verified: 1` overwrite that swaps the
    // secondary address keeps the code the primary was sent; the
    // force-re-verification overwrite (`verified: 0`) clears it, because
    // redeeming an emailed code would undo the force.
    const u = await mkParticipant("imprev");
    const nick = `imprev_${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    {
      const db = Database();
      try { db.prepare("UPDATE users SET nickname=?, secondary_email=? WHERE id=?").run(nick, `old-${Date.now()}@company.co`, u.id); }
      finally { db.close(); }
    }
    const importRow = async (verified, secondary) => {
      const { api: sa, csrf } = await apiLogin("superadmin");
      try {
        const r = await sa.post("/api/admin/import/participants", {
          headers: H(csrf),
          data: {
            data: { type: "hackarena-participants", version: 2, participants: [{
              nickname: nick, email: u.email, first_name: "Rev", last_name: "Ocation",
              verified, secondary_email: secondary,
              country: "US", timezone: "America/New_York",
            }] },
            resolutions: { "0": "overwrite" },
          },
        });
        expect(r.ok(), `import: ${r.status()} ${await r.text()}`).toBeTruthy();
        expect((await r.json()).overwritten, "the row must have been overwritten").toBe(1);
      } finally { await sa.dispose(); }
    };

    const keep = await plantCode(u.email);
    const newSecondary = `replaced-${Date.now()}@company.co`;
    await importRow(1, newSecondary);
    expect(col(u.id, "secondary_email"), "PRECONDITION: the secondary was replaced").toBe(newSecondary);
    expect(await redeem(u.email, keep), "the code mailed to the primary survives the secondary's replacement").toBe(true);

    // CONTROL — the force-re-verification overwrite still clears a live code.
    const dead = await plantCode(u.email);
    await importRow(0, newSecondary);
    expect(col(u.id, "verified"), "PRECONDITION: the import forced re-verification").toBe(0);
    expect(await redeem(u.email, dead), "a forced re-verification revokes the live code").toBe(false);
  });

  test("the participant import accepts a BOOLEAN verified/blocked without a 500", async () => {
    // `_IMPORT_FIELD_SHAPES.flag` certifies `true`/`false` as valid, and both
    // participant binds passed the value through raw — so a shape the guard had
    // just blessed produced exactly the opaque 500 the guard exists to
    // eliminate. Worse under load: this import commits in 100-row chunks
    // (v6.16.4), so a boolean in a later row leaves the earlier ones persisted
    // under a flat failure.
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const { api: sa, csrf } = await apiLogin("superadmin");
    const r = await sa.post("/api/admin/import/participants", {
      headers: H(csrf),
      data: {
        data: { type: "hackarena-participants", version: 2, participants: [{
          nickname: `boolimp_${stamp}`, email: `boolimp-${stamp}@company.co`,
          first_name: "Bool", last_name: "Import",
          verified: true, blocked: false, approved: true,
          country: "US", timezone: "America/New_York",
        }] },
        resolutions: {},
      },
    });
    expect(r.status(), `a boolean flag must not 500: ${await r.text()}`).toBe(200);
    await sa.dispose();

    // …and it must be STORED as the integer the column is declared as, or the
    // split-brain the coercion exists to prevent simply moves table.
    const db = Database();
    try {
      const got = db.prepare("SELECT verified, blocked, typeof(verified) AS tv, typeof(blocked) AS tb FROM users WHERE email=?")
        .get(`boolimp-${stamp}@company.co`);
      expect(got, "the row imported").toBeTruthy();
      expect(got.verified).toBe(1);
      expect(got.blocked).toBe(0);
      expect(got.tv).toBe("integer");
      expect(got.tb).toBe("integer");
    } finally { db.close(); }
  });

  test("an admin email correction cannot be undone by a link mailed to the old address", async () => {
    // v8.3.36 RE-POINTED, subject unchanged: a recovery credential mailed to the
    // address an admin correction REPLACES must not survive that replacement.
    // What moved is WHEN the replacement happens. The admin edit now STAGES the
    // new primary (`pending_email`) instead of committing it, so at save time
    // nothing has been replaced — the old address is still the account's, and a
    // code mailed to it is still a code for the account's own address. Revoking
    // there would destroy a live credential for a change that may never be
    // confirmed, and would protect nothing (its holder can request another).
    //
    // The revocation therefore FOLLOWS THE ADDRESS: /confirm-email's claim
    // statement clears verify_code, reset_code and the whole login_code_*
    // quartet in the same UPDATE that swaps the address. This test drives that
    // through, which is strictly more than the old version did — it asserted the
    // revocation only on a branch the dead relay made unreachable.
    const u = await mkParticipant("admrev");
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const code = await plantCode(u.email);
    const codeHash = col(u.id, "login_code_hash");
    const corrected = `corrected-${Date.now()}@company.co`;
    const r = await sa.put(`/api/admin/participants/${u.id}`, {
      headers: H(saCsrf), data: { email: corrected },
    });
    const status = r.status();
    const body = await r.text();
    await sa.dispose();

    // Staging succeeds whatever SMTP did — nothing is committed, so nothing can
    // roll back. The dead relay no longer changes the branch taken.
    expect(status, `staging must succeed: ${body}`).toBe(200);

    // BEFORE confirmation the credential is deliberately INTACT: the address it
    // was mailed to is still the account's own. Asserting this is what stops a
    // future "revoke at stage time" edit passing silently.
    expect(col(u.id, "login_code_hash"),
      "a staged correction replaces nothing yet, so it revokes nothing yet").toBe(codeHash);

    // Confirming is the replacement — and it is where the revocation lands.
    const pendCode = col(u.id, "pending_email_code");
    expect(pendCode, "precondition: the correction is staged").toBeTruthy();
    const cs = await apiLogin("superadmin");
    const confirm = await cs.api.post("/confirm-email", {
      headers: { "x-csrf-token": cs.csrf, "content-type": "application/x-www-form-urlencoded" },
      form: { code: pendCode },
    });
    expect(confirm.status(), `confirm: ${await confirm.text().catch(() => "")}`).toBe(200);
    await cs.api.dispose();

    expect(col(u.id, "email"), "precondition: the swap landed").toBe(corrected);
    expect(await redeem(corrected, code),
      "a code to the address the correction REPLACED must be dead once it is replaced").toBe(false);
    await expectCodeStillWorks(corrected, "admin-correction");
  });

  test("an admin save that changes both addresses revokes nothing at save time; the primary's swap does", async () => {
    // Revocation follows THE ADDRESS THE CODE WAS ISSUED AGAINST: the primary.
    // The secondary applies immediately and touches no code; the primary is
    // staged, and its revocation waits for /confirm-email. This drives both in
    // one save.
    const u = await mkParticipant("bothrev");
    {
      const { api, csrf } = await apiLogin(u.email);
      const add = await api.put("/api/me", { headers: H(csrf), data: { secondaryEmail: `compromised-${Date.now()}@company.co` } });
      expect(add.ok(), `add secondary: ${add.status()} ${await add.text()}`).toBeTruthy();
      await api.dispose();
    }
    // Change BOTH in one save.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const code = await plantCode(u.email);
    const codeHash = col(u.id, "login_code_hash");
    const r = await sa.put(`/api/admin/participants/${u.id}`, {
      headers: H(saCsrf), data: { email: `moved-${Date.now()}@company.co`, secondaryEmail: "" },
    });
    const status = r.status(); const body = await r.text();
    await sa.dispose();

    expect(status, `staging must succeed: ${body}`).toBe(200);
    // The primary is STAGED — not applied.
    expect(col(u.id, "email"), "the primary is not committed yet").toBe(u.email);
    const pendCode = col(u.id, "pending_email_code");
    expect(pendCode, "it is staged").toBeTruthy();
    // The secondary DID move, and the code the primary was sent is untouched.
    expect(col(u.id, "secondary_email"), "the secondary write applies immediately").toBeFalsy();
    expect(col(u.id, "login_code_hash"), "nothing revoked the code at save time").toBe(codeHash);

    // Confirming the primary is where the code dies.
    const cs = await apiLogin("superadmin");
    const confirm = await cs.api.post("/confirm-email", {
      headers: { "x-csrf-token": cs.csrf, "content-type": "application/x-www-form-urlencoded" },
      form: { code: pendCode },
    });
    expect(confirm.status(), `confirm: ${await confirm.text().catch(() => "")}`).toBe(200);
    await cs.api.dispose();
    expect(await redeem(col(u.id, "email"), code), "the primary's swap revokes the code").toBe(false);
    await expectCodeStillWorks(col(u.id, "email"), "primary-swap-after-both");
  });

  test("a staged admin correction does not touch the participant's OWN verification link", async () => {
    // v8.3.36 RE-POINTED, subject preserved and STRENGTHENED. The old version
    // asserted that a failed admin edit RESTORED the participant's live
    // registration link, because the forward path stamped its own code over
    // `verify_code` and an early revert hard-coded it to NULL — destroying the
    // link under a 503 that said the account was restored.
    //
    // Staging deletes the whole class rather than repairing it: the admin edit
    // writes only `pending_email*`, so `verify_code` is never replaced and there
    // is nothing to restore. The assertion is therefore the stronger one — the
    // participant's own link is UNTOUCHED — and it holds on every branch rather
    // than only on a rollback the dead relay made unreachable.
    const u = await mkParticipant("vcrev");
    const planted = require("crypto").randomUUID();
    {
      const db = Database();
      try { db.prepare("UPDATE users SET verified=0, verify_code=?, verify_code_at=? WHERE id=?").run(planted, new Date().toISOString(), u.id); }
      finally { db.close(); }
    }

    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const r = await sa.put(`/api/admin/participants/${u.id}`, {
      headers: H(saCsrf), data: { email: `corrected-${Date.now()}@company.co` },
    });
    const status = r.status(); const body = await r.text();
    await sa.dispose();

    expect(status, `staging must succeed: ${body}`).toBe(200);
    expect(col(u.id, "verify_code"),
      "the admin edit stages a pending change; it does not replace the participant's own link").toBe(planted);
    expect(col(u.id, "verified"), "…nor their verified state").toBe(0);
    // ANTI-VACUITY: something really was staged, so "untouched" is not simply
    // "the request did nothing".
    expect(col(u.id, "pending_email"), "and the correction really is staged").toBeTruthy();
  });
});

test.describe("the Profile dialog says where a sign-in code goes", () => {
  test("its email tip names the primary address only — a code never goes to the secondary", () => {
    // The tip sits beside the two address fields, so it is where a person learns
    // which inbox to watch; a code is mailed to, and redeemed against, the
    // PRIMARY only (which is why a secondary change revokes nothing, above).
    const fs = require("fs"), path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", "ui", "help-tips.js"), "utf8");
    const m = src.match(/"profile\.emails"\s*:\s*"([^"]*)"/);
    expect(m, "CONTROL: the Profile dialog's email tip is found").toBeTruthy();
    expect(m[1], "it says codes go to the primary address only").toMatch(/primary address only/);
    expect(m[1], "it never offers either address").not.toMatch(/either address/);
  });
});
