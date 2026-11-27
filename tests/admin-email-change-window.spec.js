// @ts-check
// ═══════════════════════════════════════════════════════════════════════════
// v8.3.36 — THE ADMIN EMAIL-CHANGE WINDOW IS GONE, AND THIS PROVES IT
//
// This file was written in v8.3.34 to REPORT what the window cost. That release
// refused the transaction-boundary fix and said why in the handler itself:
// "Closing it properly means staging the admin change the way `PUT /api/me`
// stages a self-change, which is a redesign, not a patch." v8.3.36 is that
// redesign, so the file is INVERTED rather than deleted — the guarantee it
// existed for still needs a lock, and the strongest one available is the same
// fixture with the opposite expectation.
//
// The window was: `profileTxn` committed `email=<new>, verified=0`, then awaited
// SMTP outside the transaction. Two readers acted on that provisional
// `verified=0` durably —
//   * `requireParticipant` DESTROYS the session of an unverified participant,
//     and the SPA polls every 15 s;
//   * `ACTIVE_PARTICIPANT_SQL` drops them from the scoring set, so a submit
//     landing inside it could AUTO-END the competition.
// A compensating UPDATE can restore a column. It cannot restore a deleted
// session row or reopen an ended event.
//
// Staging removes the window by leaving nothing to roll back: `email`,
// `verified` and the session are untouched until the participant clicks a link
// sent to the NEW address, and `/confirm-email` owns the swap.
//
// `POST /api/test/admin-email-delay` is what makes this drivable. The shared
// test server's relay is DEAD, so the send rejects instantly and nothing can
// land in a microsecond gap — MEASURED at zero on 3 of 3 runs before the hook
// existed, which is exactly how v8.3.34's first draft asserted nothing.
// ═══════════════════════════════════════════════════════════════════════════
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const dbGet = (sql, ...a) => {
  const d = new Database(TEST_DB_PATH, { readonly: true });
  try { return d.prepare(sql).get(...a); } finally { d.close(); }
};
const dbAll = (sql, ...a) => {
  const d = new Database(TEST_DB_PATH, { readonly: true });
  try { return d.prepare(sql).all(...a); } finally { d.close(); }
};

/** A verified, approved participant of this file's own making. */
async function mkParticipant(sa, H, JH, tag, email) {
  await registerPost(sa, "/api/register", {
    headers: JH,
    data: {
      firstName: "Em", lastName: `T${tag}`, nickname: `em_${tag}`,
      email, password: PARTICIPANT_PASS, company: "Acme", title: "T",
      avatar: "default1", country: "US", timezone: "UTC",
    },
  });
  const list = await (await sa.get("/api/admin/participants?limit=5000")).json();
  const id = (list.participants || []).find(p => p.email === email)?.id;
  expect(id, "the participant must be findable").toBeTruthy();
  await sa.post(`/api/admin/participants/${id}/verify`, { headers: H });
  await sa.post(`/api/admin/participants/${id}/approve`, { headers: H });
  return id;
}

/** Drive the real /confirm-email POST (it is a scanner-safe GET→POST form). */
async function confirmWithCode(code) {
  const cs = await apiLogin("superadmin");
  try {
    return await cs.api.post("/confirm-email", {
      headers: { "x-csrf-token": cs.csrf, "content-type": "application/x-www-form-urlencoded" },
      form: { code },
    });
  } finally { await cs.api.dispose(); }
}

test.describe("v8.3.36 — an admin email change is STAGED, so it costs the participant nothing", () => {
  test("the participant stays signed in and verified THROUGHOUT the send, and the row is untouched", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf };
    const JH = { ...H, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const email = `emstage-${tag}@cust.test`;
    const newEmail = `emstage-new-${tag}@cust.test`;
    let partId;
    try {
      partId = await mkParticipant(sa, H, JH, tag, email);

      const p = await apiLogin(email, PARTICIPANT_PASS);
      try {
        expect((await p.api.get("/api/me")).status(), "precondition: the participant is signed in").toBe(200);
        expect(dbGet("SELECT verified FROM users WHERE id=?", partId).verified,
          "precondition: and verified — otherwise 'still verified' below is vacuous").toBe(1);

        await sa.post("/api/test/admin-email-delay", { headers: JH, data: { delayMs: 1500 } });
        try {
          const putP = sa.put(`/api/admin/participants/${partId}`, { headers: JH, data: { email: newEmail } });

          // THE ASSERTION THE WHOLE FILE EXISTS FOR. Pre-v8.3.36 this was a 403
          // and the session row was gone; the DB rollback could not bring it
          // back, and the 503 claimed everything had been restored.
          await new Promise(r => setTimeout(r, 300));
          const mid = await p.api.get("/api/me");
          expect(mid.status(), "MID-FLIGHT: no provisional verified=0, so nothing refuses them").toBe(200);
          expect((await mid.json()).email, "and their address is still their own").toBe(email);

          const r = await putP;
          expect(r.status(), "staging succeeds whatever SMTP did — nothing was committed to roll back").toBe(200);
          const body = await r.json();
          expect(body.emailChanged, "the live address did NOT change").toBe(false);
          expect(body.emailChangePending, "it is staged").toBe(true);
          expect(body.pendingEmail).toBe(newEmail);
          // The dead relay puts this on the undelivered branch — and it is still
          // a 200. That is the point: no lockout risk means no rollback, which
          // means no 503.
          expect(body.emailDelivered, "the dead relay puts this on the undelivered branch").toBe(false);

          const row = dbGet("SELECT email, verified, pending_email, pending_email_code FROM users WHERE id=?", partId);
          expect(row.email, "the live address is untouched").toBe(email);
          expect(row.verified, "and so is the verified flag").toBe(1);
          expect(row.pending_email, "the change is staged").toBe(newEmail);
          expect(row.pending_email_code, "with a code, or /confirm-email cannot resolve it").toBeTruthy();

          expect((await p.api.get("/api/me")).status(), "still signed in after the save").toBe(200);
          expect(dbAll("SELECT details FROM user_events WHERE user_id=? AND event_type='sessions_invalidated'", partId)
            .map(e => JSON.parse(e.details)).filter(d => /email_change/.test(d.reason || "")).length,
            "no session was invalidated by a change that has not happened").toBe(0);

          // The stage is AUDITED. An email-only save writes no `edited` event
          // (the column did not change), so without this it would be a silent
          // state change — the v7.21.32 standing rule.
          const ev = dbAll("SELECT details FROM user_events WHERE user_id=? AND event_type='email_change_requested'", partId);
          expect(ev.length, "the stage is recorded").toBeGreaterThan(0);
          const det = JSON.parse(ev[ev.length - 1].details);
          expect(det.pending_email).toBe(newEmail);
          expect(det.via, "and marked as the admin door, not a self-request").toBe("admin_edit");
        } finally {
          await sa.post("/api/test/admin-email-delay", { headers: JH, data: { delayMs: 0 } }).catch(() => {});
        }
      } finally { await p.api.dispose(); }
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: H }).catch(() => {});
      await sa.dispose();
    }
  });

  test("the participant confirms, and THEN the address moves", async () => {
    // Staging is only correct if the change actually lands. Without this arm,
    // "nothing happened at save time" is equally satisfied by a build where the
    // correction never happens at all.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf };
    const JH = { ...H, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const email = `emcfm-${tag}@cust.test`;
    const newEmail = `emcfm-new-${tag}@cust.test`;
    let partId;
    try {
      partId = await mkParticipant(sa, H, JH, tag, email);
      expect((await sa.put(`/api/admin/participants/${partId}`, { headers: JH, data: { email: newEmail } })).status()).toBe(200);
      const code = dbGet("SELECT pending_email_code FROM users WHERE id=?", partId).pending_email_code;
      expect(code, "precondition: a pending code was minted").toBeTruthy();

      const confirm = await confirmWithCode(code);
      expect(confirm.status(), `confirm: ${await confirm.text().catch(() => "")}`).toBe(200);

      const row = dbGet("SELECT email, verified, pending_email, pending_email_code FROM users WHERE id=?", partId);
      expect(row.email, "the swap lands at confirm time, not at save time").toBe(newEmail);
      expect(row.verified, "confirming proves the new address").toBe(1);
      expect(row.pending_email, "and the pending slot is cleared").toBeFalsy();
      expect(row.pending_email_code).toBeFalsy();

      // They can sign in with the corrected address — the whole point. Without
      // this, "the column changed" is equally true of a build that left the
      // account unusable.
      const again = await apiLogin(newEmail, PARTICIPANT_PASS);
      expect((await again.api.get("/api/me")).status(), "they can sign in with the corrected address").toBe(200);
      await again.api.dispose();
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: H }).catch(() => {});
      await sa.dispose();
    }
  });

  test("an admin stage SUPERSEDES a participant's own, and the stale link stops working", async () => {
    // One pending slot, two writers. The admin's is the newer instruction, so it
    // wins — and because /confirm-email resolves the row BY THE CODE, the
    // participant's already-mailed link stops resolving rather than committing
    // the admin's address under a mail describing a different one.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf };
    const JH = { ...H, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const email = `emsup-${tag}@cust.test`;
    let partId;
    try {
      partId = await mkParticipant(sa, H, JH, tag, email);

      const p = await apiLogin(email, PARTICIPANT_PASS);
      let selfCode;
      try {
        const pJH = { "x-csrf-token": p.csrf, "content-type": "application/json" };
        expect((await p.api.put("/api/me", { headers: pJH, data: { email: `emsup-self-${tag}@cust.test` } })).status()).toBe(200);
        selfCode = dbGet("SELECT pending_email_code FROM users WHERE id=?", partId).pending_email_code;
        expect(selfCode, "precondition: the participant's change is staged").toBeTruthy();
      } finally { await p.api.dispose(); }

      const adminTo = `emsup-admin-${tag}@cust.test`;
      expect((await sa.put(`/api/admin/participants/${partId}`, { headers: JH, data: { email: adminTo } })).status()).toBe(200);
      const after = dbGet("SELECT pending_email, pending_email_code FROM users WHERE id=?", partId);
      expect(after.pending_email, "the admin's instruction is the newer one").toBe(adminTo);
      expect(after.pending_email_code, "with a FRESH code — a stale one would let the old link commit the new address")
        .not.toBe(selfCode);

      const stale = await confirmWithCode(selfCode);
      expect(stale.status(), "the superseded link is not valid").toBe(400);
      const row = dbGet("SELECT email, pending_email FROM users WHERE id=?", partId);
      expect(row.email, "and nothing was committed by it").toBe(email);
      expect(row.pending_email, "the admin's stage survives the stale attempt").toBe(adminTo);
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: H }).catch(() => {});
      await sa.dispose();
    }
  });

  test("an unrelated admin save does NOT cancel a staged correction", async () => {
    // Deliberately unlike `PUT /api/me`, which cancels a pending on any
    // non-changing save. The admin dialog pre-fills the CURRENT address, so that
    // rule here would cancel an in-flight correction on every unrelated save —
    // the exact defect v8.3.34 recorded for the participant's own dialog, on the
    // door where the operator has no cancel affordance.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf };
    const JH = { ...H, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const email = `emkeep-${tag}@cust.test`;
    const newEmail = `emkeep-new-${tag}@cust.test`;
    let partId;
    try {
      partId = await mkParticipant(sa, H, JH, tag, email);
      expect((await sa.put(`/api/admin/participants/${partId}`, { headers: JH, data: { email: newEmail } })).status()).toBe(200);
      const staged = dbGet("SELECT pending_email_code FROM users WHERE id=?", partId).pending_email_code;
      expect(staged, "precondition: staged").toBeTruthy();

      // An unrelated save that echoes the CURRENT address, exactly as the admin
      // dialog does on every save.
      expect((await sa.put(`/api/admin/participants/${partId}`, { headers: JH, data: { email, company: "Elsewhere Ltd" } })).status()).toBe(200);

      const row = dbGet("SELECT pending_email, pending_email_code, company FROM users WHERE id=?", partId);
      expect(row.pending_email, "the staged correction survives an unrelated save").toBe(newEmail);
      expect(row.pending_email_code, "and keeps its code, so the mailed link still works").toBe(staged);
      expect(row.company, "while the unrelated change still lands").toBe("Elsewhere Ltd");
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: H }).catch(() => {});
      await sa.dispose();
    }
  });
});
