"use strict";

// WHO IS WARNED THAT DELETING A PERSON REMOVES THEIR CHECKMARX ONE ACCOUNT.
// Operator ruling, 24 Nov 2026: the warning goes to anyone who can delete.
//
// Deleting a person also tries to remove the Checkmarx One account the platform
// created for them in the customer's tenant. The delete confirm says so from the
// People row's `has_cxone_realm_account`, which the server sends to exactly the
// sessions DELETE /api/admin/participants/:id admits at its requireSuperAdmin: a
// superadmin, or a custom role holding `participants.delete`, read live.
//
//   * API: a custom role holding `participants.delete` gets the flag on the
//     person the ledger holds an account for (and not on a person it holds none
//     for); the built-in admin, who cannot delete, never gets it; a custom role
//     without `participants.delete` does not either;
//   * the 5 s participants cache cannot carry the flag across the question: the
//     same holder, moved between a deleting and a non-deleting role out of band
//     (no cache bust), is answered for the role it holds NOW, both ways;
//   * UI: the custom-role deleter's delete confirm names the account, and the
//     toast tells them a superadmin follows the removal up (the removals page
//     needs `ops.cxone`, which only a superadmin holds), and removes by hand an
//     account the platform created but never recorded, and checks the tenant
//     for a set-up record nobody can read; the superadmin's own
//     wording is held by tests/cxone-withdrawals-ui.spec.js.
//
// Ledger rows are planted through a better-sqlite3 handle on the worker server's
// database, as tests/cxone-withdrawals-ui.spec.js does.

const { test, expect } = require("./isolated-test");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const { BASE, PARTICIPANT_PASS, apiLogin, waitForAdminPage, TEST_DB_PATH } = require("./helpers");
const { loginViaApi, clickTab } = require("./ui-admin-helpers");
const { H, makeParticipant } = require("./event-admin-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

const CX_NOTE = "The platform created a Checkmarx One account for them; it will try to remove it from the customer's tenant too.";

function dbGet(sql, ...a) {
  const d = new Database(TEST_DB_PATH, { readonly: true });
  try { return d.prepare(sql).get(...a); } finally { d.close(); }
}
function dbRun(sql, ...a) {
  const d = new Database(TEST_DB_PATH, { timeout: 5000 });
  try { return d.prepare(sql).run(...a); } finally { d.close(); }
}
let seq = 0;
/** A ledger row: an account THIS installation created a minute ago for `userId`. */
function plant(userId) {
  const now = new Date().toISOString();
  const row = {
    cxone_user_id: crypto.randomUUID(), iam_origin: "https://iam.checkmarx.net", tenant: "tenant1",
    realm_confirmed: 1, user_id: userId, competition_id: null, created_username: `cxdel${Date.now().toString(36)}${seq++}`,
    provenance: "created", provenance_at: now, instance_origin: new URL(BASE).origin,
    recorded_at: now, pending_since: null, deletion_source: null, attempts: 0,
    first_failed_at: null, next_attempt_at: null, last_error: null, held_reason: null, attention: 0,
    override_reason: null, override_by: null, override_at: null, transferred_at: null,
    claim_token: null, claimed_at: null, given_up_at: null,
  };
  const cols = Object.keys(row);
  dbRun(`INSERT INTO cxone_realm_accounts (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`, row);
  return row.cxone_user_id;
}

/** The People row's flag for `id`, as this session reads the list. */
async function flagFor(api, id) {
  const r = await api.get("/api/admin/participants?limit=5000");
  expect(r.ok(), `participants list: ${r.status()}`).toBeTruthy();
  const row = (await r.json()).participants.find((p) => p.id === id);
  expect(row, "PRECONDITION: the person is on the page").toBeTruthy();
  return "has_cxone_realm_account" in row ? row.has_cxone_realm_account : "absent";
}

test.describe("the Checkmarx One delete warning reaches whoever can delete", () => {
  let sa, saCsrf, deleterRole, deskRole;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    const stamp = Date.now();
    const mkRole = async (label, permissions) => {
      const r = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: { label: `${label} ${stamp}`, scope_mode: "all", permissions } });
      expect(r.ok(), `create role ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).role;
    };
    deleterRole = await mkRole("Account remover", ["participants.view", "participants.delete"]);
    deskRole = await mkRole("People desk", ["participants.view"]);
  });
  test.afterAll(async () => { if (sa) await sa.dispose(); });

  async function holder(label, roleId) {
    const u = await makeParticipant(sa, saCsrf, label);
    const r = await sa.patch(`/api/admin/users/${u.id}/role`, { headers: H(saCsrf), data: { role: roleId } });
    expect(r.ok(), `assign ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
    return u;
  }

  test("API: a role holding participants.delete gets the flag; the built-in admin and a role without it do not", async () => {
    const withAcct = await makeParticipant(sa, saCsrf, "cxdelwith");
    const without = await makeParticipant(sa, saCsrf, "cxdelwithout");
    plant(withAcct.id);
    const deleter = await holder("cxdeldeleter", deleterRole.id);
    const desk = await holder("cxdeldesk", deskRole.id);
    const regAdmin = await makeParticipant(sa, saCsrf, "cxdeladmin");
    const pr = await sa.post(`/api/admin/participants/${regAdmin.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
    expect(pr.ok(), `promote admin: ${pr.status()}`).toBeTruthy();

    // Superadmin CONTROL: the flag is on the planted person and only on them.
    expect(await flagFor(sa, withAcct.id)).toBe(true);
    expect(await flagFor(sa, without.id)).toBe("absent");

    const d = await apiLogin(deleter.email, PARTICIPANT_PASS);
    const a = await apiLogin(regAdmin.email, PARTICIPANT_PASS);
    const k = await apiLogin(desk.email, PARTICIPANT_PASS);
    try {
      expect(await flagFor(d.api, withAcct.id), "a custom role that may delete is warned").toBe(true);
      expect(await flagFor(d.api, without.id), "…only where the ledger holds an account").toBe("absent");
      expect(await flagFor(a.api, withAcct.id), "the built-in admin cannot delete, so is not told").toBe("absent");
      expect(await flagFor(k.api, withAcct.id), "a custom role without participants.delete is not told").toBe("absent");
      // The admin's refusal at the door, so "cannot delete" is the server's fact, not the test's.
      const del = await a.api.delete(`/api/admin/participants/${without.id}`, { headers: H(a.csrf) });
      expect(del.status(), "the built-in admin's delete is refused").toBe(403);
      // Within the cache's 5 s window, the deleter's warmed page reaches neither of the others.
      expect(await flagFor(d.api, withAcct.id)).toBe(true);
      expect(await flagFor(a.api, withAcct.id)).toBe("absent");
    } finally {
      await d.api.dispose(); await a.api.dispose(); await k.api.dispose();
    }
  });

  test("the cache answers for the role held NOW: moved between roles out of band, within 5 s, both ways", async () => {
    const victim = await makeParticipant(sa, saCsrf, "cxdelcache");
    plant(victim.id);
    const mover = await holder("cxdelmover", deleterRole.id);
    const m = await apiLogin(mover.email, PARTICIPANT_PASS);
    try {
      // Warm the entry as a deleter, then change the role by SQL (an out-of-band
      // write busts no cache: an import or a hand edit) and read again at once.
      const t0 = Date.now();
      expect(await flagFor(m.api, victim.id), "PRECONDITION: warmed as a deleter").toBe(true);
      dbRun("UPDATE users SET role=? WHERE id=?", deskRole.id, mover.id);
      expect(await flagFor(m.api, victim.id), "no longer a deleter: the warmed page must not answer").toBe("absent");
      dbRun("UPDATE users SET role=? WHERE id=?", deleterRole.id, mover.id);
      expect(await flagFor(m.api, victim.id), "a deleter again: the non-deleter's page must not answer").toBe(true);
      expect(Date.now() - t0, "every read fell inside the cache's 5 s window").toBeLessThan(5000);
    } finally {
      dbRun("UPDATE users SET role=? WHERE id=?", deleterRole.id, mover.id);
      await m.api.dispose();
    }
  });

  test("UI: the custom-role deleter's confirm names the account, and the toast says a superadmin follows it up", async ({ page }) => {
    const victim = await makeParticipant(sa, saCsrf, "cxdelui");
    const control = await makeParticipant(sa, saCsrf, "cxdeluictl");
    plant(victim.id);
    const deleter = await holder("cxdeluideleter", deleterRole.id);

    await loginViaApi(page, deleter.email, PARTICIPANT_PASS);
    await page.goto("/");
    await waitForAdminPage(page);
    await clickTab(page, "participants");
    await expect.poll(() => page.evaluate((want) => {
      const d = (window.S && window.S.adminParticipantsData) || [];
      return want.every((i) => d.some((u) => u.id === i));
    }, [victim.id, control.id]), { timeout: 20000, message: "the participants model never held the test's rows" }).toBe(true);
    // The role holds no ops.cxone (only a superadmin does): the toast's branch.
    expect(await page.evaluate(() => Array.isArray(window.S.permissions) && window.S.permissions.includes("ops.cxone"))).toBe(false);

    const openDelete = async (id) => {
      await page.evaluate((i) => { window.deleteParticipant(i); }, id);
      await expect(page.locator("#modal-overlay.open")).toBeVisible();
      await expect(page.locator("#modal-title")).toHaveText("Delete User");
      return page.locator("#modal-body").innerText();
    };
    // CONTROL first: no account, no sentence.
    const plain = await openDelete(control.id);
    expect(plain).toContain("This will permanently delete");
    expect(plain).not.toContain("Checkmarx One");
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal-overlay.open")).toHaveCount(0);

    const named = await openDelete(victim.id);
    expect(named).toContain(CX_NOTE);
    const resP = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes(`/api/admin/participants/${victim.id}`));
    await page.locator("#modal-confirm-btn").click();
    const res = await resP;
    expect(await res.json()).toEqual({ ok: true, cxone_withdrawals_scheduled: 1 });
    await expect(page.locator("#toast-stack .toast").filter({ hasText: "User deleted." }).last()).toHaveText(
      "User deleted. Removal of 1 Checkmarx One account the platform created has been scheduled — a superadmin follows it up under Settings → Checkmarx One account removals.");
    expect(dbGet("SELECT id FROM users WHERE id=?", victim.id)).toBeFalsy();

    // An account the platform created but never recorded (history says so, the
    // ledger holds no row): the sentence asking for removal by hand names a
    // superadmin too, for a deleter who cannot reach the tenant's key.
    const orphan = await makeParticipant(sa, saCsrf, "cxdeluiorphan");
    dbRun("INSERT INTO user_events (id, user_id, event_type, changed_by, changed_at, details) VALUES (?, ?, 'cxone_provisioned', 'system', ?, ?)",
      crypto.randomUUID(), orphan.id, new Date().toISOString(),
      JSON.stringify({ success: true, already_existed: false, cxone_user_id: crypto.randomUUID(), username: `cxorphan${seq++}` }));
    await clickTab(page, "participants");
    await expect.poll(() => page.evaluate((i) => ((window.S && window.S.adminParticipantsData) || []).some((u) => u.id === i), orphan.id),
      { timeout: 20000, message: "the participants model never held the orphan's row" }).toBe(true);
    await openDelete(orphan.id);
    const resO = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes(`/api/admin/participants/${orphan.id}`));
    await page.locator("#modal-confirm-btn").click();
    expect(await (await resO).json()).toEqual({ ok: true, cxone_accounts_unrecorded: 1 });
    await expect(page.locator("#toast-stack .toast").filter({ hasText: "not in its records" }).last()).toHaveText(
      "User deleted. 1 Checkmarx One account the platform created for them is not in its records, so it cannot be removed automatically; a superadmin removes it in the tenant by hand.");
    await expect(page.locator("#toast-stack .toast").filter({ hasText: "not in its records" }).last(),
      "CONTROL — a readable record asks for no tenant check").not.toContainText("could not be read");

    // A set-up record nobody can read: the deleter is told a superadmin checks
    // the tenant (no "Audit page" pointer: that is for the key's holder).
    const torn = await makeParticipant(sa, saCsrf, "cxdeluitorn");
    dbRun("INSERT INTO user_events (id, user_id, event_type, changed_by, changed_at, details) VALUES (?, ?, 'cxone_provisioned', 'system', ?, ?)",
      crypto.randomUUID(), torn.id, new Date().toISOString(), `{"success":true,"already_existed":false,"username":"cxtorn${seq++}"`);
    await clickTab(page, "participants");
    await expect.poll(() => page.evaluate((i) => ((window.S && window.S.adminParticipantsData) || []).some((u) => u.id === i), torn.id),
      { timeout: 20000, message: "the participants model never held the torn record's row" }).toBe(true);
    await openDelete(torn.id);
    const resT = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes(`/api/admin/participants/${torn.id}`));
    await page.locator("#modal-confirm-btn").click();
    expect(await (await resT).json()).toEqual({ ok: true, cxone_records_unreadable: 1 });
    await expect(page.locator("#toast-stack .toast").filter({ hasText: "could not be read" }).last()).toHaveText(
      "User deleted. 1 Checkmarx One set-up record of theirs could not be read, so the platform cannot tell which account, if any, it names; a superadmin checks the tenant for an account of theirs.");
  });
});
