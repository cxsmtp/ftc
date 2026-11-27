// @ts-check
// ═══════════════════════════════════════════════════════════════════════════
// OPTIMISTIC CONCURRENCY ON `users` — the version column, the 409, and the
// control that stops it becoming a blanket bump.
//
// `users` had no version column at all, so both profile write paths were
// last-writer-wins. v8.3.37 narrowed the blast radius — a save carries only the
// fields the dialog actually CHANGED — and said plainly that it did not make
// concurrent edits safe: two people editing the SAME field still race, and both
// are told they succeeded. `users.updated_at` + `expectedUpdatedAt` + 409 is
// that fix, mirroring the `competitions` idiom (v6.16.27).
//
// WHAT EACH ARM IS FOR, and why none of them can be dropped:
//
//  1-2. STALE is refused and FRESH succeeds — the pair, on each route. The
//       stale arm asserts the DATABASE, not just the status: "the server said
//       409" is equally true of a build that 409s and writes anyway, and a
//       half-applied refusal is worse than no refusal.
//
//  3.   THE BACK-COMPAT CONTROL — omitting `expectedUpdatedAt` still succeeds.
//       Without it the whole file is satisfied by a build that 409s EVERYBODY,
//       which would brick every scripted caller and every other spec in the
//       suite; and the `? IS NULL` arm of the compare-and-swap, which is what
//       makes that true, would be locked by nothing.
//
//  4.   THE ANTI-BLANKET CONTROL, and it is the most important test here. The
//       version guards the PROFILE FIELDS, so ONLY the three statements that
//       write them bump it. `users` carries ~61 UPDATE statements; a trigger,
//       or stamping `updated_at` on every write, passes arms 1-3 unchanged and
//       breaks every real admin dialog — an organiser opens Edit Profile, the
//       participant merely SIGNS IN (which stamps `login_time` /
//       `last_login_time` and clears the lockout counters), and the save is
//       refused for a conflict that did not happen, with nothing on screen able
//       to explain it. So: save, then log in, then present the ORIGINAL
//       expectation and require it to still be accepted.
//
//  5.   The fingerprint is on BOTH wires. It is what the two dialogs echo back;
//       a route that does not publish it can send no expectation at all, and
//       the control is then present and inert on that surface.
//
//  6.   A FRESHLY REGISTERED row is protected too. No production
//       `INSERT INTO users` names `updated_at`, so the column is NULL until the
//       first profile save or the next boot's backfill — the exact "column
//       present-but-NULL silently disables the check" failure the backfill
//       exists to prevent, one account at a time. `profileVersionSql()` falls
//       back to `created_at`, and this arm is the only thing holding it.
//
// Every participant and admin here is registered BY THIS FILE. The seeded
// fixtures (alice/bob/carol) are blocked, re-passworded and tagged by other
// specs, and this file's whole subject is a value that moves when the row is
// written — borrowing one would make every assertion depend on what ran first.
// ═══════════════════════════════════════════════════════════════════════════
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH, BASE } = require("./helpers");
const Database = require("better-sqlite3");

test.use({ baseURL: BASE });

const dbGet = (sql, ...a) => {
  const d = new Database(TEST_DB_PATH, { readonly: true });
  try { return d.prepare(sql).get(...a); } finally { d.close(); }
};

/** The stored profile row, as the assertions want to read it. */
const rowOf = (id) => dbGet(
  "SELECT nickname, email, first_name, last_name, company, title, country, timezone, updated_at, created_at FROM users WHERE id=?", id);

/**
 * Register + verify + approve a participant of our own.
 *
 * Every step is asserted: `/api/register` and the two lifecycle POSTs are
 * fire-and-forget shapes, and a silently-skipped precondition surfaces much
 * later as an unattributable 401 (v7.22.5).
 */
async function mkParticipant(tag) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  const H = { "x-csrf-token": csrf };
  const JH = { ...H, "content-type": "application/json" };
  const email = `pconc-${tag}@cust.test`;
  try {
    const reg = await registerPost(sa, "/api/register", {
      headers: JH,
      data: {
        firstName: "Con", lastName: `Currency${tag}`, nickname: `pconc_${tag}`,
        email, password: PARTICIPANT_PASS, company: "Acme", title: "Engineer",
        avatar: "default1", country: "US", timezone: "America/New_York",
      },
    });
    expect(reg.ok(), `register ${email}: ${reg.status()} ${await reg.text()}`).toBeTruthy();
    const list = await (await sa.get("/api/admin/participants?limit=5000")).json();
    const id = (list.participants || []).find(p => p.email === email)?.id;
    expect(id, "the participant must be findable").toBeTruthy();
    const v = await sa.post(`/api/admin/participants/${id}/verify`, { headers: H });
    expect(v.ok(), `verify: ${v.status()}`).toBeTruthy();
    const a = await sa.post(`/api/admin/participants/${id}/approve`, { headers: H });
    expect(a.ok(), `approve: ${a.status()}`).toBeTruthy();
    return { id, email };
  } finally { await sa.dispose(); }
}

/** A signed-in API context for one of our own participants. */
async function asParticipant(email) {
  const { api, csrf } = await apiLogin(email, PARTICIPANT_PASS);
  return { api, csrf, H: { "x-csrf-token": csrf, "content-type": "application/json" } };
}

/** The fingerprint the participant's own dialog would echo. */
async function meVersion(api) {
  const r = await api.get("/api/me");
  expect(r.ok(), `GET /api/me: ${r.status()}`).toBeTruthy();
  const me = await r.json();
  expect(me.updated_at, "GET /api/me must publish the concurrency fingerprint").toBeTruthy();
  return me.updated_at;
}

/** The fingerprint the ADMIN's dialog would echo, off the list payload. */
async function adminVersion(sa, id) {
  const r = await sa.get("/api/admin/participants?limit=5000");
  expect(r.ok(), `admin list: ${r.status()}`).toBeTruthy();
  const row = ((await r.json()).participants || []).find(p => p.id === id);
  expect(row, "the participant must be on the admin list").toBeTruthy();
  expect(row.updated_at, "the admin list must publish the concurrency fingerprint").toBeTruthy();
  return row.updated_at;
}

test.describe("Optimistic concurrency on the profile row", () => {

  test("PUT /api/me — a STALE expectedUpdatedAt is refused, and writes NOTHING", async () => {
    const { id, email } = await mkParticipant("me-stale");
    const { api, H } = await asParticipant(email);
    try {
      // Establish a real (non-NULL) stored fingerprint first, so this arm is
      // about a value that MOVED rather than about the created_at fallback —
      // arm 6 covers that case on its own.
      const v0 = await meVersion(api);
      const first = await api.put("/api/me", {
        headers: H, data: { company: "First Co", expectedUpdatedAt: v0 },
      });
      expect(first.ok(), `first save: ${first.status()} ${await first.text()}`).toBeTruthy();
      const afterFirst = rowOf(id);
      expect(afterFirst.company).toBe("First Co");

      // v0 is now stale by construction — the save above moved the row.
      const stale = await api.put("/api/me", {
        headers: H, data: { company: "Should Not Land", expectedUpdatedAt: v0 },
      });
      expect(stale.status(), "a stale expectation must be 409").toBe(409);
      const body = await stale.json();
      expect(body.conflict, "the 409 carries the competitions-shaped `conflict` flag").toBe(true);
      expect(String(body.error), "the refusal must tell the caller to reload").toMatch(/reload/i);
      // The value handed back must be the CURRENT one, not the one that lost —
      // returning the caller's own stale value would send the dialog round the
      // same 409 for ever.
      expect(body.currentUpdatedAt).toBe(await meVersion(api));
      expect(body.currentUpdatedAt).not.toBe(v0);

      // THE HALF THAT MATTERS: the refusal wrote nothing. "the server said 409"
      // is equally true of a build that 409s after committing.
      const after = rowOf(id);
      expect(after.company, "a refused save must not land").toBe("First Co");
      expect(after.updated_at, "a refused save must not move the version").toBe(afterFirst.updated_at);
    } finally { await api.dispose(); }
  });

  test("PUT /api/me — a FRESH expectedUpdatedAt succeeds and MOVES the version", async () => {
    const { id, email } = await mkParticipant("me-fresh");
    const { api, H } = await asParticipant(email);
    try {
      const v0 = await meVersion(api);
      const r = await api.put("/api/me", {
        headers: H, data: { company: "Moved Co", expectedUpdatedAt: v0 },
      });
      expect(r.ok(), `${r.status()} ${await r.text()}`).toBeTruthy();
      const after = rowOf(id);
      expect(after.company).toBe("Moved Co");
      expect(after.updated_at, "the stored column is stamped").toBeTruthy();
      const v1 = await meVersion(api);
      expect(v1, "the published fingerprint moves with the write").not.toBe(v0);
      expect(new Date(v1).getTime()).toBeGreaterThanOrEqual(new Date(v0).getTime());

      // And the NEW value is immediately usable — a fingerprint that moves but
      // cannot then be presented would be a one-shot dialog.
      const again = await api.put("/api/me", {
        headers: H, data: { title: "Staff Engineer", expectedUpdatedAt: v1 },
      });
      expect(again.ok(), `second save with the refreshed value: ${again.status()}`).toBeTruthy();
      expect(rowOf(id).title).toBe("Staff Engineer");
    } finally { await api.dispose(); }
  });

  test("CONTROL — PUT /api/me with NO expectedUpdatedAt still succeeds", async () => {
    // Back-compat, and the anti-vacuity control for the two arms above: without
    // it, "a stale value is refused" is satisfied by a build that refuses every
    // caller, which is what a missing `? IS NULL` arm would produce.
    const { id, email } = await mkParticipant("me-nocheck");
    const { api, H } = await asParticipant(email);
    try {
      const v0 = await meVersion(api);
      // Move the row first, so an unchecked save is demonstrably NOT merely
      // "the expectation happened to match".
      const bump = await api.put("/api/me", {
        headers: H, data: { company: "Bumped", expectedUpdatedAt: v0 },
      });
      expect(bump.ok(), `bump: ${bump.status()}`).toBeTruthy();

      const r = await api.put("/api/me", { headers: H, data: { title: "No Check" } });
      expect(r.ok(), `unchecked save: ${r.status()} ${await r.text()}`).toBeTruthy();
      expect(rowOf(id).title).toBe("No Check");
    } finally { await api.dispose(); }
  });

  test("PUT /api/admin/participants/:id — stale refused / fresh accepted / absent unchecked", async () => {
    const { id } = await mkParticipant("admin-cas");
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    try {
      const v0 = await adminVersion(sa, id);

      const first = await sa.put(`/api/admin/participants/${id}`, {
        headers: H, data: { company: "Admin First", expectedUpdatedAt: v0 },
      });
      expect(first.ok(), `fresh admin save: ${first.status()} ${await first.text()}`).toBeTruthy();
      const afterFirst = rowOf(id);
      expect(afterFirst.company).toBe("Admin First");
      const v1 = await adminVersion(sa, id);
      expect(v1, "the admin wire's fingerprint moves too").not.toBe(v0);

      const stale = await sa.put(`/api/admin/participants/${id}`, {
        headers: H, data: { company: "Admin Should Not Land", expectedUpdatedAt: v0 },
      });
      expect(stale.status(), "a stale admin expectation must be 409").toBe(409);
      const body = await stale.json();
      expect(body.conflict).toBe(true);
      expect(String(body.error)).toMatch(/reload/i);
      expect(body.currentUpdatedAt).toBe(v1);

      const after = rowOf(id);
      expect(after.company, "a refused admin save must not land").toBe("Admin First");
      expect(after.updated_at, "a refused admin save must not move the version").toBe(afterFirst.updated_at);

      // CONTROL — no expectation is still accepted.
      const unchecked = await sa.put(`/api/admin/participants/${id}`, {
        headers: H, data: { title: "Admin No Check" },
      });
      expect(unchecked.ok(), `unchecked admin save: ${unchecked.status()}`).toBeTruthy();
      expect(rowOf(id).title).toBe("Admin No Check");
    } finally { await sa.dispose(); }
  });

  test("ANTI-BLANKET CONTROL — a LOGIN must not invalidate an open dialog", async () => {
    // A blanket bump (a trigger, or stamping `updated_at` on every UPDATE of
    // this table) passes every other arm in this file and breaks the product:
    // signing in writes `login_time`, `last_login_time` and the lockout
    // counters, so an admin's open Edit-Profile dialog would 409 because the
    // participant did nothing but log in.
    const { id, email } = await mkParticipant("no-blanket");
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    try {
      // A real profile save first, so the fingerprint is the stored column
      // rather than the created_at fallback — a blanket bump on a NULL row
      // would otherwise be invisible here.
      const v0 = await adminVersion(sa, id);
      const seed = await sa.put(`/api/admin/participants/${id}`, {
        headers: H, data: { company: "Before Login", expectedUpdatedAt: v0 },
      });
      expect(seed.ok(), `seed save: ${seed.status()}`).toBeTruthy();

      // This is the expectation an admin's open dialog is holding.
      const held = await adminVersion(sa, id);
      const beforeLogin = rowOf(id);
      expect(beforeLogin.updated_at, "the seed save stamped the column").toBeTruthy();

      // The NON-PROFILE write: the participant signs in.
      const { api: pApi } = await asParticipant(email);
      try {
        const me = await pApi.get("/api/me");
        expect(me.ok(), "the participant really did sign in").toBeTruthy();
      } finally { await pApi.dispose(); }

      // Assert the precondition rather than trusting it: the login must have
      // WRITTEN to this row, or the arm proves nothing about a blanket bump.
      const stamped = dbGet(
        "SELECT login_time, last_login_time, updated_at FROM users WHERE id=?", id);
      expect(stamped.last_login_time, "the login must have written to this row").toBeTruthy();

      expect(stamped.updated_at,
        "a NON-PROFILE write (login) must NOT move the profile version — a blanket " +
        "bump 409s an admin dialog because the participant merely signed in"
      ).toBe(beforeLogin.updated_at);

      // And the held expectation is still good.
      const r = await sa.put(`/api/admin/participants/${id}`, {
        headers: H, data: { company: "After Login", expectedUpdatedAt: held },
      });
      expect(r.status(), `the pre-login expectation must still be accepted, got ${r.status()} ${await r.text()}`).toBe(200);
      expect(rowOf(id).company).toBe("After Login");
    } finally { await sa.dispose(); }
  });

  test("the fingerprint is on BOTH wires, and the two agree", async () => {
    const { id, email } = await mkParticipant("both-wires");
    const { api, H } = await asParticipant(email);
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const before = await meVersion(api);
      expect(await adminVersion(sa, id),
        "GET /api/me and GET /api/admin/participants must publish the SAME value — " +
        "two dialogs echoing different fingerprints for one row is a 409 nobody can act on"
      ).toBe(before);

      const r = await api.put("/api/me", {
        headers: H, data: { company: "Wired", expectedUpdatedAt: before },
      });
      expect(r.ok(), `${r.status()}`).toBeTruthy();

      const after = await meVersion(api);
      expect(after).not.toBe(before);
      expect(await adminVersion(sa, id), "both wires move together").toBe(after);
    } finally { await api.dispose(); await sa.dispose(); }
  });

  test("a FRESHLY REGISTERED row is protected — the created_at fallback", async () => {
    // No production `INSERT INTO users` names `updated_at`, so the stored column
    // is NULL until the first profile save or the next boot's backfill. A NULL
    // both-sides comparison silently disables the check for that row — the exact
    // failure db.js's backfill exists to prevent, reappearing one account at a
    // time and invisible from every screen. `profileVersionSql()` falls back to
    // `created_at`; nothing else in this file would notice if it stopped.
    const { id, email } = await mkParticipant("virgin-row");
    const raw = rowOf(id);
    expect(raw.updated_at,
      "PRECONDITION: a just-registered row has no stored updated_at (if this ever " +
      "starts failing, an INSERT learnt to stamp it and this arm needs re-pointing)"
    ).toBeFalsy();

    const { api, H } = await asParticipant(email);
    try {
      const v0 = await meVersion(api);
      expect(v0, "the fingerprint falls back to created_at").toBe(raw.created_at);

      // A wrong expectation on a NULL-column row must still be refused; without
      // the fallback this row would accept ANY value.
      const stale = await api.put("/api/me", {
        headers: H, data: { company: "Nope", expectedUpdatedAt: "1999-01-01T00:00:00.000Z" },
      });
      expect(stale.status(), "a virgin row must not be exempt from the check").toBe(409);
      expect(rowOf(id).company, "and it must write nothing").toBe("Acme");

      // The correct one is accepted, and stamps the real column from then on.
      const ok = await api.put("/api/me", {
        headers: H, data: { company: "Landed", expectedUpdatedAt: v0 },
      });
      expect(ok.ok(), `${ok.status()} ${await ok.text()}`).toBeTruthy();
      const after = rowOf(id);
      expect(after.company).toBe("Landed");
      expect(after.updated_at, "the first save populates the stored column").toBeTruthy();
    } finally { await api.dispose(); }
  });

  test("THE THIRD WRITER — a participant import moves the fingerprint too", async () => {
    // There are three profile writers, and the import overwrite is the one with
    // no dialog behind it. It is deliberately NOT a compare-and-swap: refusing a
    // 5000-row migration because one participant's profile moved would be the
    // wrong trade. What it must do is STAMP, so an admin whose Edit Profile
    // dialog was open while the import rewrote that row is refused on save
    // rather than silently overwriting what the import just wrote.
    //
    // It is also the arm that would catch a placeholder/bind DESYNC on that
    // statement — adding a column to a 30-placeholder UPDATE and forgetting its
    // bind writes the wrong value into the wrong column, silently, which
    // v8.1.0 (PR 24) records happening on this very file.
    const { id, email } = await mkParticipant("import-bump");
    const { api, H } = await asParticipant(email);
    let v0;
    try {
      // Give the row a real stored fingerprint first, so the assertion is about
      // the import MOVING it rather than about the created_at fallback.
      const seed = await api.put("/api/me", { headers: H, data: { company: "Before Import" } });
      expect(seed.ok(), `${seed.status()} ${await seed.text()}`).toBeTruthy();
      v0 = await meVersion(api);
    } finally { await api.dispose(); }
    expect(v0, "precondition: a stored fingerprint exists").toBeTruthy();

    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const before = rowOf(id);
      const row = {
        nickname: before.nickname, email, first_name: "Imported", last_name: before.last_name,
        company: "After Import", title: before.title || "T", country: before.country || "US",
        timezone: before.timezone || "UTC", job_function: "Software Developer / Engineer",
        city: "Test City", verified: 1,
      };
      const envelope = { data: { type: "hackarena-participants", participants: [row] } };
      const IH = { "x-csrf-token": csrf, "content-type": "application/json" };

      // The import is TWO PHASE: without `resolutions` it is a DRY RUN that
      // ENUMERATES conflicts, and only the second call writes. Asserting the
      // conflict is found is also the precondition — without it the second call
      // would take the INSERT branch, which is not the statement under test.
      const dry = await sa.post("/api/admin/import/participants", { headers: IH, data: envelope });
      expect(dry.ok(), `dry run: ${dry.status()} ${await dry.text()}`).toBeTruthy();
      const dryBody = await dry.json();
      expect(dryBody.conflicts?.length,
        "PRECONDITION: the existing account is seen as a conflict, so the OVERWRITE branch runs"
      ).toBeGreaterThan(0);

      const r = await sa.post("/api/admin/import/participants", {
        headers: IH, data: { ...envelope, resolutions: { "0": "overwrite" } },
      });
      expect(r.ok(), `import: ${r.status()} ${await r.text()}`).toBeTruthy();

      const after = rowOf(id);
      // The bind landed in the right column — the desync check. If a placeholder
      // and its argument ever fall out of step, one of these reads somebody
      // else's value and this fails loudly rather than corrupting a row quietly.
      expect(after.company, "the import wrote the profile").toBe("After Import");
      expect(after.first_name, "…in the right columns").toBe("Imported");
      expect(after.email, "…and did not shift the email into a name column").toBe(email);
      expect(after.updated_at, "the import stamped the fingerprint").toBeTruthy();
      expect(after.updated_at, "…and MOVED it, so an open dialog is now stale").not.toBe(v0);

      // …and the stale dialog is refused, which is the whole point of stamping.
      const { api: p2, H: H2 } = await asParticipant(email);
      try {
        const stale = await p2.put("/api/me", {
          headers: H2, data: { company: "Clobber", expectedUpdatedAt: v0 },
        });
        expect(stale.status(), "a dialog opened before the import is refused").toBe(409);
        expect(rowOf(id).company, "…and writes nothing").toBe("After Import");
      } finally { await p2.dispose(); }
    } finally { await sa.dispose(); }
  });
});
