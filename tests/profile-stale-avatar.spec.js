// @ts-check
// ═══════════════════════════════════════════════════════════════════════════
// v8.3.34 (external audit) — A STALE AVATAR REF MUST NOT BECOME A DANGLING ONE
//
// The profile editor submits the WHOLE form, reading every input as it stood
// when the dialog was opened, and `PUT /api/me` has no optimistic concurrency
// (`users` has no `updated_at` at all). So a save from a dialog opened before
// some other writer replaced the avatar re-writes the OLD ref — which that
// writer's own `deleteAvatarImage` has already reclaimed.
//
// `sanitiseAvatar` accepted any `/api/images/<uuid>`-SHAPED string without
// asking whether the row existed, so the result was worse than a stale avatar:
//
//   * the row ends up pointing at an image that no longer exists — broken
//     wherever it renders (leaderboard, admin lists, the badge page);
//   * and the LIVE image goes too. `PUT /api/me` reclaims the previous blob
//     whenever the value changed, so writing dead ref W over live ref X deletes
//     X as well. Both blobs gone, the row referencing neither.
//
// The concurrent writer does not have to be a second tab of the same user: an
// organiser correcting a record through `PUT /api/admin/participants/:id`
// (which writes `avatar` too) while the participant has their editor open is a
// routine live-event occurrence, and that is the shape driven below.
//
// WHAT IS DELIBERATELY NOT FIXED HERE: the general last-writer-wins on this
// form. Closing that means either optimistic concurrency (there is no version
// column to hang it on) or a dirty-field diff — and a diff must be computed per
// BODY KEY, not per element id, because two ids collapse into `jobFunction` and
// six others are renamed, so a naive per-element diff silently drops a role
// change. That is a design change with real regression surface across two
// dialogs, not a patch.
// ═══════════════════════════════════════════════════════════════════════════
//
// 9.2.18 — AN ACCOUNT'S AVATAR MAY NOT NAME SOMEBODY ELSE'S STORED PICTURE. An
// existing-picture reference is accepted only as the account's own current
// avatar (lib/sanitise.js sanitiseAvatar `current`); any other is kept out as a
// dead reference is, through both doors (PUT /api/me, the admin edit).
// ═══════════════════════════════════════════════════════════════════════════
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH, pngDataUri } = require("./helpers");
const { makeParticipant, uniq } = require("./event-admin-helpers");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const dbGet = (sql, ...a) => {
  const d = new Database(TEST_DB_PATH, { readonly: true });
  try { return d.prepare(sql).get(...a); } finally { d.close(); }
};

// A real 1x1 PNG — small enough to sail under AVATAR_MAX_BYTES.
const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test.describe("v8.3.34 — a stale avatar ref cannot dangle", () => {
  test("re-submitting a REPLACED avatar keeps the live one instead of dangling", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf };
    const JH = { ...H, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const email = `stale-av-${tag}@cust.test`;
    let partId;
    try {
      await registerPost(sa, "/api/register", {
        headers: JH,
        data: {
          firstName: "Stale", lastName: "Avatar", nickname: `staleav_${tag}`,
          email, password: PARTICIPANT_PASS, company: "Acme", title: "T",
          avatar: "default1", country: "US", timezone: "UTC",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=5000")).json();
      partId = (list.participants || []).find(p => p.email === email)?.id;
      expect(partId, "the participant must be findable").toBeTruthy();
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: H });
      await sa.post(`/api/admin/participants/${partId}/approve`, { headers: H });

      const p = await apiLogin(email, PARTICIPANT_PASS);
      try {
        const pJH = { "x-csrf-token": p.csrf, "content-type": "application/json" };
        // 1. Upload avatar W. This is the value a dialog opened now would hold.
        const up1 = await p.api.put("/api/me", { headers: pJH, data: { avatar: PNG_1PX } });
        expect(up1.status(), `first avatar upload: ${await up1.text().catch(() => "")}`).toBe(200);
        const staleRef = dbGet("SELECT avatar FROM users WHERE id=?", partId).avatar;
        expect(staleRef, "precondition: an image ref was stored").toMatch(/^\/api\/images\//);
        const staleId = staleRef.slice("/api/images/".length);
        expect(dbGet("SELECT 1 AS x FROM images WHERE id=?", staleId), "precondition: W exists").toBeTruthy();

        // 2. A CONCURRENT WRITER replaces it — here the ordinary one, an admin
        //    correcting the record. That reclaims W.
        const up2 = await p.api.put("/api/me", { headers: pJH, data: { avatar: "🦊" } });
        expect(up2.status()).toBe(200);
        const liveRef = dbGet("SELECT avatar FROM users WHERE id=?", partId).avatar;
        expect(liveRef, "precondition: the avatar really moved").toBe("🦊");
        expect(dbGet("SELECT 1 AS x FROM images WHERE id=?", staleId),
          "precondition: the replaced image W was reclaimed — this is what makes the ref DEAD").toBeFalsy();

        // 3. THE STALE SAVE. A dialog opened at step 1 still holds W and submits
        //    it alongside an unrelated change.
        const stale = await p.api.put("/api/me", { headers: pJH, data: { avatar: staleRef, city: "Elsewhere" } });
        expect(stale.status(), "the save itself must still succeed — its other fields are good").toBe(200);

        const after = dbGet("SELECT avatar, city FROM users WHERE id=?", partId);
        // THE ASSERTION. Pre-fix this stored the dead ref.
        expect(after.avatar, "a ref naming no image is not written").toBe(liveRef);
        // …and the unrelated field the user actually changed still landed, so
        // the guard is not simply refusing the save.
        expect(after.city, "the rest of the save is unaffected").toBe("Elsewhere");
      } finally { await p.api.dispose(); }
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: H }).catch(() => {});
      await sa.dispose();
    }
  });

  test("the ADMIN route is guarded too — its reclaim is load-bearing, not defence-in-depth", async () => {
    // v8.3.35 (self-review) — the v8.3.34 spec asserted only the participant
    // path while its own header talked about an admin editing the same record.
    // `PUT /api/admin/participants/:id` performs the SAME reclaim
    // (`if (newAvatar !== user.avatar) deleteAvatarImage(user.avatar)`), and the
    // admin dialog seeds `overlay._avatar` from the row it read at open and
    // sends it on every save — so a superadmin saving a stale dialog posts an
    // already-reclaimed ref. Without the guard, `undefined` is bound straight
    // into the UPDATE.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf };
    const JH = { ...H, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const email = `admin-av-${tag}@cust.test`;
    let partId;
    try {
      await registerPost(sa, "/api/register", {
        headers: JH,
        data: {
          firstName: "Admin", lastName: "Avatar", nickname: `adminav_${tag}`,
          email, password: PARTICIPANT_PASS, company: "Acme", title: "T",
          avatar: "default1", country: "US", timezone: "UTC",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=5000")).json();
      partId = (list.participants || []).find(p => p.email === email)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: H });
      await sa.post(`/api/admin/participants/${partId}/approve`, { headers: H });

      let staleRef;
      const p = await apiLogin(email, PARTICIPANT_PASS);
      const pJH = { "x-csrf-token": p.csrf, "content-type": "application/json" };
      try {
        expect((await p.api.put("/api/me", { headers: pJH, data: { avatar: PNG_1PX } })).status()).toBe(200);
        staleRef = dbGet("SELECT avatar FROM users WHERE id=?", partId).avatar;
        expect(staleRef, "precondition: an image ref was stored").toMatch(/^\/api\/images\//);
        const staleId = staleRef.slice("/api/images/".length);
        expect((await p.api.put("/api/me", { headers: pJH, data: { avatar: "🐼" } })).status()).toBe(200);
        expect(dbGet("SELECT avatar FROM users WHERE id=?", partId).avatar,
          "precondition: the participant replaced it").toBe("🐼");
        expect(dbGet("SELECT 1 AS x FROM images WHERE id=?", staleId),
          "precondition: the old blob really was reclaimed — this is what makes the ref DEAD").toBeFalsy();
      } finally { await p.api.dispose(); }

      // The superadmin's stale dialog now saves the dead ref.
      const r = await sa.put(`/api/admin/participants/${partId}`, {
        headers: JH, data: { avatar: staleRef, company: "AdminEdited" },
      });
      expect(r.status(), `admin save: ${await r.text().catch(() => "")}`).toBe(200);
      const after = dbGet("SELECT avatar, company FROM users WHERE id=?", partId);
      expect(after.avatar, "the admin route does not write a dangling ref either").toBe("🐼");
      expect(after.company, "and the rest of the admin save still lands").toBe("AdminEdited");
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: H }).catch(() => {});
      await sa.dispose();
    }
  });

  test("a NON-STRING avatar does not 500 the route", async () => {
    // v8.3.35 (self-review of v8.3.34) — the ref-resolution check introduced the
    // v8.3.20 field-shape class into its own fix. `RegExp#test` stringifies, so
    // `["/api/images/aaaa"]` MATCHED the ref pattern; `Array.prototype.slice`
    // then returned an ARRAY, which better-sqlite3 spreads as positional
    // bindings — reproduced as a 500 on the ADMIN route, whose
    // `_firstNonStringField` list does not include `avatar`. The pre-fix branch
    // was an unconditional `return avatar`, so it never touched the value.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf };
    const JH = { ...H, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const email = `arr-av-${tag}@cust.test`;
    let partId;
    try {
      await registerPost(sa, "/api/register", {
        headers: JH,
        data: {
          firstName: "Arr", lastName: "Avatar", nickname: `arrav_${tag}`,
          email, password: PARTICIPANT_PASS, company: "Acme", title: "T",
          avatar: "🦊", country: "US", timezone: "UTC",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=5000")).json();
      partId = (list.participants || []).find(p => p.email === email)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: H });
      await sa.post(`/api/admin/participants/${partId}/approve`, { headers: H });
      const before = dbGet("SELECT avatar FROM users WHERE id=?", partId).avatar;

      for (const bad of [["/api/images/aaaa"], { a: 1 }, 42, true]) {
        const r = await sa.put(`/api/admin/participants/${partId}`, { headers: JH, data: { avatar: bad } });
        expect(r.status(), `avatar=${JSON.stringify(bad)} must not 500`).not.toBe(500);
      }
      // …and a malformed value must not silently REPLACE a real avatar either.
      expect(dbGet("SELECT avatar FROM users WHERE id=?", partId).avatar,
        "an unusable avatar leaves the stored one alone").toBe(before);
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: H }).catch(() => {});
      await sa.dispose();
    }
  });

  test("CONTROL — a LIVE image ref is still accepted, and a bad one is still a 400", async () => {
    // Without this, the test above is satisfied by a build that ignores the
    // avatar field entirely, or that 400s every image ref — either of which
    // would break avatar editing outright.
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf };
    const JH = { ...H, "content-type": "application/json" };
    const tag = crypto.randomBytes(4).toString("hex");
    const email = `live-av-${tag}@cust.test`;
    let partId;
    try {
      await registerPost(sa, "/api/register", {
        headers: JH,
        data: {
          firstName: "Live", lastName: "Avatar", nickname: `liveav_${tag}`,
          email, password: PARTICIPANT_PASS, company: "Acme", title: "T",
          avatar: "default1", country: "US", timezone: "UTC",
        },
      });
      const list = await (await sa.get("/api/admin/participants?limit=5000")).json();
      partId = (list.participants || []).find(p => p.email === email)?.id;
      await sa.post(`/api/admin/participants/${partId}/verify`, { headers: H });
      await sa.post(`/api/admin/participants/${partId}/approve`, { headers: H });

      const p = await apiLogin(email, PARTICIPANT_PASS);
      try {
        const pJH = { "x-csrf-token": p.csrf, "content-type": "application/json" };
        expect((await p.api.put("/api/me", { headers: pJH, data: { avatar: PNG_1PX } })).status()).toBe(200);
        const ref = dbGet("SELECT avatar FROM users WHERE id=?", partId).avatar;

        // Re-submitting the SAME, still-live ref is the ordinary no-op save and
        // must keep working.
        expect((await p.api.put("/api/me", { headers: pJH, data: { avatar: ref, city: "Same" } })).status()).toBe(200);
        expect(dbGet("SELECT avatar FROM users WHERE id=?", partId).avatar,
          "a live ref round-trips untouched").toBe(ref);

        // And a genuinely rejected upload is still a 400, not a silent keep.
        const bad = await p.api.put("/api/me", { headers: pJH, data: { avatar: "data:image/svg+xml;base64,PHN2Zy8+" } });
        expect(bad.status(), "an unsupported image type is still refused").toBe(400);
      } finally { await p.api.dispose(); }
    } finally {
      if (partId) await sa.delete(`/api/admin/participants/${partId}`, { headers: H }).catch(() => {});
      await sa.dispose();
    }
  });
  test("an account cannot take another account's stored photo as its avatar, by either door; its own current one round-trips and a new upload still works (CONTROLS)", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    const JH = { "x-csrf-token": csrf, "content-type": "application/json" };
    const a = await makeParticipant(sa, csrf, "avown");
    const b = await makeParticipant(sa, csrf, "avtake");
    const upload = async (who, label) => {
      const s = await apiLogin(who.email, PARTICIPANT_PASS);
      try {
        const r = await s.api.put("/api/me", { headers: { "x-csrf-token": s.csrf, "content-type": "application/json" }, data: { avatar: pngDataUri(16, uniq(label)) } });
        expect(r.status(), await r.text()).toBe(200);
      } finally { await s.api.dispose(); }
      return dbGet("SELECT avatar FROM users WHERE id=?", who.id).avatar;
    };
    const imageExists = (ref) => !!dbGet("SELECT 1 AS x FROM images WHERE id=?", String(ref).slice("/api/images/".length));
    try {
      const refA = await upload(a, "a");
      const refB = await upload(b, "b");
      expect([refA, refB].every(r => /^\/api\/images\//.test(r)) && refA !== refB, "PRECONDITION: two stored photos").toBe(true);

      // B names A's photo through PUT /api/me, beside an ordinary change.
      const s = await apiLogin(b.email, PARTICIPANT_PASS);
      const bJH = { "x-csrf-token": s.csrf, "content-type": "application/json" };
      try {
        const take = await s.api.put("/api/me", { headers: bJH, data: { avatar: refA, city: "Taken" } });
        expect(take.status(), "the save still succeeds: its other fields are good").toBe(200);
        let row = dbGet("SELECT avatar, city FROM users WHERE id=?", b.id);
        expect(row.avatar, "B keeps its own photo").toBe(refB);
        expect(row.city, "and the rest of the save lands").toBe("Taken");
        expect(imageExists(refB), "B's photo is not reclaimed").toBe(true);

        // …and the admin edit (a superadmin may replace a chosen avatar).
        const adm = await sa.put(`/api/admin/participants/${b.id}`, { headers: JH, data: { avatar: refA, company: "AdminTook" } });
        expect(adm.status(), await adm.text()).toBe(200);
        row = dbGet("SELECT avatar, company FROM users WHERE id=?", b.id);
        expect(row.avatar, "the admin door keeps B's photo too").toBe(refB);
        expect(row.company).toBe("AdminTook");
        expect(dbGet("SELECT avatar FROM users WHERE id=?", a.id).avatar, "A's avatar is untouched").toBe(refA);
        expect(imageExists(refA), "and A's photo is untouched").toBe(true);

        // CONTROL: B re-sending its own current reference keeps it.
        const own = await s.api.put("/api/me", { headers: bJH, data: { avatar: refB, city: "Own" } });
        expect(own.status()).toBe(200);
        expect(dbGet("SELECT avatar, city FROM users WHERE id=?", b.id), "its own current photo round-trips").toEqual({ avatar: refB, city: "Own" });
        expect(imageExists(refB)).toBe(true);
      } finally { await s.api.dispose(); }

      // CONTROL: a new upload still replaces it, and the replaced photo goes.
      const refC = await upload(b, "c");
      expect(refC, "a new upload is stored").toMatch(/^\/api\/images\//);
      expect(refC).not.toBe(refB);
      expect(imageExists(refB), "the replaced photo, named by nothing else, is reclaimed").toBe(false);
    } finally {
      for (const who of [a, b]) await sa.delete(`/api/admin/participants/${who.id}`, { headers: { "x-csrf-token": csrf } }).catch(() => {});
      await sa.dispose();
    }
  });
});
