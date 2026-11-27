// @ts-check
// ═══════════════════════════════════════════════════════════════════════════
// v8.3.34 (external audit) — THE SOLVE-CLOCK ANCHOR SURVIVES EXPORT → IMPORT
//
// v8.1.1 added `competition_user_absences.login_time` so that a remove-then-
// re-add restores the participant's ORIGINAL anchor instead of re-anchoring the
// solve clock to the rejoin moment. Re-anchoring forward is not a neutral
// error: `buildLeaderboardEntries` clamps each absence to [loginMs, refEndMs],
// and for a FINISHER `refEndMs` is their last correct submission — which can
// then precede the moved anchor, clamping solveTimeMs to 0, the best possible
// value on the deciding tie-break.
//
// Neither the export SELECT (routes/export-import.js) nor the import INSERT
// (server.js `_rehydrateAbsences`) ever named the column, so an export → import
// dropped the anchor silently. CLAUDE.md recorded it as open and owned by
// nobody; this closes it.
//
// TWO ARMS, because they fail to different mutations:
//   A — the EXPORT carries it. Kills the export-side omission.
//   B — the IMPORT stores it AND a later re-add actually RESTORES it. Kills the
//       import-side omission, and is what makes this a ranking lock rather than
//       a column-copy lock: "the column was written" is equally true of a build
//       where closeAbsenceAndRestoreAnchor never fires.
// ═══════════════════════════════════════════════════════════════════════════
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const dbGet = (sql, ...args) => {
  const d = new Database(TEST_DB_PATH, { readonly: true });
  try { return d.prepare(sql).get(...args); } finally { d.close(); }
};

test.describe("v8.3.34 — absence login_time is portable", () => {
  test("ARM A — a REAL removal exports the anchor it captured", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf };
    const JH = { ...H, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    let compId, partId;
    try {
      // Own competition, own participant (fixture-checklist items 2 and 3) — a
      // seeded participant is blocked/tagged/re-passworded by earlier tests.
      compId = (await (await sa.post("/api/admin/competitions", {
        headers: JH,
        data: {
          name: `AbsAnchor-${tag}`,
          start_time: new Date(Date.now() - 10 * 60_000).toISOString(),
          duration_minutes: 300,
        },
      })).json()).competition.id;

      const email = `absanchor-${tag}@cust.test`;
      await registerPost(sa, "/api/register", {
        headers: JH,
        data: {
          firstName: "Abs", lastName: "Anchor", nickname: `absanchor_${tag}`,
          email, password: PARTICIPANT_PASS, company: "Acme", title: "T",
          avatar: "default1", country: "US", timezone: "America/New_York",
        },
      });
      const list = await (await sa.get(`/api/admin/participants?limit=5000`)).json();
      partId = (list.participants || []).find(p => p.email === email)?.id;
      expect(partId, "the new participant must be findable").toBeTruthy();
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: H });
      await sa.post(`/api/admin/participants/${partId}/approve`, { headers: H });

      // The assign endpoint SKIPS ineligible users silently, so assert it landed.
      const asg = await sa.post("/api/admin/competitions/assign", {
        headers: JH, data: { userIds: [partId], competitionIds: [compId] },
      });
      expect((await asg.json()).assigned, "assign must have landed").toBe(1);

      // Entering a LIVE competition is what stamps the anchor.
      const p = await apiLogin(email, PARTICIPANT_PASS);
      try {
        await p.api.post("/api/select-competition", {
          headers: { "x-csrf-token": p.csrf, "content-type": "application/json" },
          data: { competitionId: compId },
        });
        await p.api.get("/api/status");
      } finally { await p.api.dispose(); }

      const anchor = dbGet("SELECT login_time FROM competition_users WHERE competition_id=? AND user_id=?", compId, partId)?.login_time;
      expect(anchor, "precondition: entering a live competition stamps the solve-clock anchor").toBeTruthy();
      // v8.12.6 — and the join time, which the removal now records beside it.
      const joinedAt = dbGet("SELECT assigned_at FROM competition_users WHERE competition_id=? AND user_id=?", compId, partId)?.assigned_at;
      expect(joinedAt, "precondition: the membership carries its join time").toBeTruthy();

      // Remove them — this is what writes the absence row.
      const rem = await sa.delete(`/api/admin/competitions/${compId}/users/${partId}`, { headers: H });
      expect(rem.ok(), `removal request: ${rem.status()}`).toBeTruthy();
      expect((await rem.json()).removed, "the removal must actually have matched a membership row").toBe(true);

      const absRow = dbGet("SELECT login_time, assigned_at, returned_at FROM competition_user_absences WHERE user_id=? AND competition_id=?", partId, compId);
      expect(absRow, "precondition: the removal wrote an absence row").toBeTruthy();
      expect(absRow.login_time, "precondition: v8.1.1 captured the anchor onto the absence row").toBe(anchor);
      expect(absRow.assigned_at, "v8.12.6 — and the join time").toBe(joinedAt);

      // THE ASSERTION. Pre-fix the exported object had no login_time at all.
      const exported = await (await sa.get("/api/admin/export/participants")).json();
      const me = (exported.participants || []).find(x => x.email === email);
      expect(me, "the participant is in the export").toBeTruthy();
      const abs = (me.absences || []).find(a => a.competition_name === `AbsAnchor-${tag}`);
      expect(abs, "the absence is in the export").toBeTruthy();
      expect(abs.login_time, "the EXPORT carries the solve-clock anchor").toBe(anchor);
      // v8.12.6 — the join time travels with it: it is what decides whether a
      // re-added participant is a late entrant.
      expect(abs.assigned_at, "the EXPORT carries the original join time").toBe(joinedAt);
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: H }).catch(() => {});
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: H }).catch(() => {});
      await sa.dispose();
    }
  });

  test("ARM B — the IMPORT stores the anchor, and a later re-add RESTORES it", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf };
    const JH = { ...H, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    let compId, uid;
    try {
      compId = (await (await sa.post("/api/admin/competitions", {
        headers: JH,
        data: {
          name: `AbsImp-${tag}`,
          start_time: new Date(Date.now() - 10 * 60_000).toISOString(),
          duration_minutes: 300,
        },
      })).json()).competition.id;

      // A distinctive anchor, far enough in the past that it cannot be confused
      // with the moment of the re-add below — which is the whole subject.
      const ORIGINAL_ANCHOR = new Date(Date.now() - 3 * 3600_000).toISOString();
      // v8.12.6 — a distinctive original JOIN time too, for the same reason.
      const ORIGINAL_JOIN = new Date(Date.now() - 4 * 3600_000).toISOString();
      const email = `absimp-${tag}@cust.test`;
      const payload = {
        type: "hackarena-participants",
        version: 2,
        exported_at: new Date().toISOString(),
        participants: [{
          first_name: "AbsImp", last_name: "Anchor", nickname: `absimp_${tag}`,
          email, verified: 1, approved: 1, country: "US", timezone: "UTC",
          competitions: [],
          absences: [{
            competition_name: `AbsImp-${tag}`,
            removed_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
            // OPEN absence (returned_at null) — closeAbsenceAndRestoreAnchor
            // only restores from a row that is still open.
            returned_at: null,
            login_time: ORIGINAL_ANCHOR,
            assigned_at: ORIGINAL_JOIN,
          }],
        }],
      };
      // Without `resolutions` the endpoint is a DRY RUN and asserts nothing.
      const r = await sa.post("/api/admin/import/participants", { headers: JH, data: { data: payload, resolutions: {} } });
      expect(r.ok(), `import: ${r.status()} ${await r.text().catch(() => "")}`).toBeTruthy();
      const body = await r.json();
      expect(body.absences_imported, "the absence row was rehydrated").toBeGreaterThan(0);

      uid = dbGet("SELECT id FROM users WHERE email=?", email)?.id;
      expect(uid, "the imported participant exists").toBeTruthy();

      // ASSERTION 1 — the import STORED the anchor. Kills the import-side omission.
      const abs = dbGet("SELECT login_time, assigned_at, returned_at FROM competition_user_absences WHERE user_id=? AND competition_id=?", uid, compId);
      expect(abs, "the absence row landed").toBeTruthy();
      expect(abs.login_time, "the IMPORT stored the solve-clock anchor").toBe(ORIGINAL_ANCHOR);
      expect(abs.assigned_at, "v8.12.6 — and the original join time").toBe(ORIGINAL_JOIN);

      // ASSERTION 2 — and a re-add RESTORES it rather than re-anchoring to now.
      // This is what makes it a ranking lock: "the column was copied" is equally
      // true of a build where the restore never fires.
      const asg = await sa.post("/api/admin/competitions/assign", {
        headers: JH, data: { userIds: [uid], competitionIds: [compId] },
      });
      expect((await asg.json()).assigned, "re-add must have landed").toBe(1);

      const cu = dbGet("SELECT login_time, assigned_at FROM competition_users WHERE competition_id=? AND user_id=?", compId, uid);
      expect(cu, "membership restored").toBeTruthy();
      expect(cu.login_time, "the re-add restores the ORIGINAL anchor, not the rejoin moment").toBe(ORIGINAL_ANCHOR);
      expect(cu.assigned_at, "v8.12.6 — and the ORIGINAL join time, not the re-add moment").toBe(ORIGINAL_JOIN);
    } finally {
      if (uid) await sa.delete(`/api/admin/participants/${uid}`, { headers: H }).catch(() => {});
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: H }).catch(() => {});
      await sa.dispose();
    }
  });

  test("a malformed login_time in an uploaded file degrades to NULL, it does not sink the import", async () => {
    // better-sqlite3 SPREADS an array as positional bindings, so an unguarded
    // sixth bind of `["a","b"]` would push a seventh onto a six-placeholder
    // statement and 500 the whole participant import — the v8.3.20 field-shape
    // class. A wrong-typed field is one row's unusable value, never a batch abort.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf };
    const JH = { ...H, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    let compId, uid;
    try {
      compId = (await (await sa.post("/api/admin/competitions", {
        headers: JH,
        data: { name: `AbsBad-${tag}`, start_time: new Date(Date.now() + 3600_000).toISOString(), duration_minutes: 60 },
      })).json()).competition.id;

      const email = `absbad-${tag}@cust.test`;
      const payload = {
        type: "hackarena-participants", version: 2, exported_at: new Date().toISOString(),
        participants: [{
          first_name: "AbsBad", last_name: "Shape", nickname: `absbad_${tag}`,
          email, verified: 1, approved: 1, country: "US", timezone: "UTC",
          competitions: [],
          absences: [{
            competition_name: `AbsBad-${tag}`,
            removed_at: new Date(Date.now() - 60_000).toISOString(),
            returned_at: null,
            login_time: ["not", "a", "timestamp"],
            // v8.12.6 — the join time takes the same shape guard.
            assigned_at: { not: "a timestamp" },
          }],
        }],
      };
      const r = await sa.post("/api/admin/import/participants", { headers: JH, data: { data: payload, resolutions: {} } });
      expect(r.status(), "a wrong-typed field must not 500 the import").toBe(200);
      expect((await r.json()).absences_imported, "the row still imports").toBeGreaterThan(0);

      uid = dbGet("SELECT id FROM users WHERE email=?", email)?.id;
      const abs = dbGet("SELECT login_time, assigned_at FROM competition_user_absences WHERE user_id=? AND competition_id=?", uid, compId);
      expect(abs, "the absence row landed").toBeTruthy();
      expect(abs.login_time, "an unusable anchor is stored as NULL — 'unknown', which restores nothing").toBeNull();
      expect(abs.assigned_at, "and so is an unusable join time").toBeNull();
    } finally {
      if (uid) await sa.delete(`/api/admin/participants/${uid}`, { headers: H }).catch(() => {});
      if (compId) await sa.delete(`/api/admin/competitions/${compId}`, { headers: H }).catch(() => {});
      await sa.dispose();
    }
  });
});
