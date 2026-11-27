// @ts-check
// Participant row-action matrix (v7.14.2).
//
// Locks WHICH actions each admin tier sees on each kind of participant row, and
// that every action a tier CAN see actually works end-to-end from the UI.
//
// Why this file exists: a regular admin viewing an admin/superadmin peer sees the
// menu collapse to two items (the peer-admin doctrine refuses the rest server-side).
// That was correct but invisible, and indistinguishable from the feature being
// broken — it was reported as a bug. The matrix below is the regression lock so a
// future change to any visibility condition, on either tier, fails loudly here
// rather than being discovered by an operator.
const { test, expect } = require("./isolated-test");
const { narrowPeopleTable } = require("./ui-admin-helpers"); // v9.2.5 — the one way to type into the admin search boxes
const { registerPost } = require("./helpers");
const Database = require("better-sqlite3");
const { apiLogin, freshCtx, getSuperadminPass, PARTICIPANT_PASS, BASE, TEST_DB_PATH, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const h = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });

async function loginViaApi(page, email, password) {
  const doPost = async (pw) => {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    return codeLogin(page.request, email, h(csrfToken), { password: pw });
  };
  let r = await doPost(password);
  if (r.ok()) return;
  r = await doPost(email === "superadmin" ? getSuperadminPass() : password);
  // v7.22.0 — say WHY (see the shared probe in helpers.js).
  if (!r.ok()) throw new Error(`loginViaApi(${email}) failed: ${r.status()} ${await r.text()}`
    + await require("./helpers").describeAccountState(email, password));
}

/** Log `page` in as the given admin tier and land on the Participants tab. */
async function adminTab(page, who) {
  await page.context().clearCookies();
  if (who === "superadmin") await loginViaApi(page, "superadmin", getSuperadminPass());
  else await loginViaApi(page, who, PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  const btn = page.locator("button.admin-nav-item[data-tab-id='admin-participants-tab']").first();
  await btn.waitFor({ state: "attached" });
  await btn.evaluate((el) => el.click());
  await page.locator("#admin-participants-tab").waitFor({ state: "visible", timeout: 5000 });
  // RBAC — People lists participants and organisers; this matrix also acts on
  // admin and superadmin rows, which People shows only with "Show admin
  // accounts" ticked (global admins; an event admin never has the box).
  const inc = page.locator("#p-include-admins");
  if (await inc.isVisible().catch(() => false) && !(await inc.isChecked())) {
    const reload = page.waitForResponse((r) => r.url().includes("/api/admin/participants?") && r.url().includes("kind=all"));
    await inc.check();
    await reload;
  }
}

/** Open the kebab for `email` and return its visible item labels (+ any note). */
async function kebabFor(page, email) {
  await narrowPeopleTable(page, email);
  const row = page.locator(`#admin-participants-body tr:has-text("${email}")`).first();
  await row.waitFor({ state: "visible", timeout: 10000 });
  const portal = page.locator("#kebab-portal");
  // v7.20.2 — the kebab is a TOGGLE on a POLLED list, so a single click is not
  // reliable: the participants table refreshes every 15s, and a click that
  // lands while the row is being replaced opens nothing. A click arriving while
  // another kebab is still open closes that one instead. Both leave the portal
  // hidden, which under load read as "the menu never opened" (seen at
  // WORKERS=4, never at 8 — i.e. a timing flake, not a product defect).
  //
  // v7.21.3 — the churn is the SEARCH DEBOUNCE, not a poll: `.fill()` above
  // schedules a refetch that REPLACES #admin-participants-body, and a click
  // landing on the row being swapped out opens nothing. Diagnostics from a real
  // failure showed the portal present, `display:none`, with ZERO children —
  // i.e. toggleKebab never populated it. So: let the table settle first, then
  // retry, and treat a portal with no children as NOT open (an empty menu is
  // indistinguishable from a closed one to `isVisible`, and would otherwise be
  // read as success and fail later on a missing item).
  const tbody = page.locator("#admin-participants-body");
  await expect(async () => {
    const a = await tbody.locator("tr").count();
    await page.waitForTimeout(250);
    expect(await tbody.locator("tr").count()).toBe(a);
  }).toPass({ timeout: 8000 });

  const portalReady = async () =>
    (await portal.isVisible().catch(() => false)) && (await portal.locator("button").count().catch(() => 0)) > 0;

  // v7.21.3 — do NOT press Escape before clicking. participants-admin.js's own
  // comment on closeKebab names the mechanism: the click-outside listener "can't
  // outlive its menu — otherwise opening an adjacent kebab leaves the old
  // listener attached, and it fires on the SAME click that opened the new menu".
  // Escape closes via _escHandler, which is exactly the path that can leave that
  // listener behind — so a pre-Escape makes the next click open the menu and
  // immediately close it, which is precisely the diagnostic we captured (portal
  // present, display:none, ZERO children). toggleKebab already calls closeKebab()
  // itself on entry, which tears the stale listener down properly, so clicking
  // straight in is both simpler and correct. Closing between rows is done by a
  // neutral CLICK (see closeKebab below) for the same reason.
  let opened = false;
  for (let attempt = 0; attempt < 5 && !opened; attempt++) {
    await row.locator(".kebab-btn").first().click({ timeout: 5000 }).catch(() => {});
    opened = await portalReady();
    if (!opened) {
      await portal.waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
      opened = await portalReady();
    }
  }
  if (!opened) {
    // v7.21.3 — this dump is what ROOT-CAUSED the flake (portal present,
    // display:none, ZERO children ⇒ the menu was opened and torn down by the
    // stale click-outside listener on the very same click). Keep it: no row
    // means the search filtered it away, no button means the kebab was not
    // rendered for this tier, a populated-but-hidden portal is a new cause.
    const diag = await page.evaluate((em) => {
      const rows = [...document.querySelectorAll("#admin-participants-body tr")];
      const row = rows.find(r => r.textContent.includes(em));
      const portal = document.getElementById("kebab-portal");
      return {
        totalRows: rows.length,
        rowFound: !!row,
        kebabBtns: row ? row.querySelectorAll(".kebab-btn").length : 0,
        portalExists: !!portal,
        portalDisplay: portal ? getComputedStyle(portal).display : null,
        portalChildren: portal ? portal.children.length : 0,
        searchValue: document.getElementById("participants-search")?.value ?? null,
      };
    }, email).catch(e => ({ evaluateFailed: String(e) }));
    throw new Error(`the row kebab for ${email} never opened after 5 attempts. State: ${JSON.stringify(diag)}`);
  }
  const items = await portal.locator("button").evaluateAll(els => els.map(e => e.textContent.trim().replace(/\s+/g, " ")));
  const note = await portal.locator(".kebab-note").count()
    ? (await portal.locator(".kebab-note").textContent()).trim().replace(/\s+/g, " ")
    : null;
  return { items, note, row };
}

async function closeKebab(page) {
  // v7.21.3 — a neutral CLICK, not Escape: Escape closes through _escHandler,
  // which can leave the click-outside listener attached to fire on the next
  // click (the one that opens the following row's menu). A real outside click
  // runs the listener and tears it down, which is the state the next open needs.
  await page.locator("#admin-participants-tab h2, #admin-participants-tab").first()
    .click({ position: { x: 2, y: 2 }, timeout: 3000 }).catch(() => {});
  await page.locator("#kebab-portal").waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
}

function dbGet(sql, ...args) {
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare(sql).get(...args); } finally { db.close(); }
}

let ST;

test.beforeAll(async () => {
  const { api, csrf } = await apiLogin("superadmin");
  const H = h(csrf);
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5)}`;

  // Register a user; verify/approve only when asked, so each target state is real.
  const mk = async (slug, { verify = true, approve = true } = {}) => {
    const email = `pam-${slug}-${stamp}@acme.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    const r = await registerPost(anon, "/api/register", { headers: h(ac), data: {
      firstName: "Matrix", lastName: "Target", nickname: `pam_${slug}_${stamp}`.slice(0, 40), email,
      company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS,
    }});
    if (r.status() >= 400) throw new Error(`register ${email}: ${r.status()} ${await r.text()}`);
    await anon.dispose();
    const u = (await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json())
      .participants.find(p => p.email === email);
    expect(u, `created ${email}`).toBeTruthy();
    if (verify) await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H });
    if (approve) await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H });
    return { id: u.id, email };
  };

  const plain = await mk("plain");
  const unverified = await mk("unver", { verify: false, approve: false });
  const unapproved = await mk("unappr", { verify: true, approve: false });
  const blocked = await mk("blocked");
  await api.post(`/api/admin/participants/${blocked.id}/block`, { headers: H });
  const peerAdmin = await mk("peeradm");
  await api.post(`/api/admin/participants/${peerAdmin.id}/role`, { headers: H, data: { role: "admin" } });
  const peerSuper = await mk("peersup");
  await api.post(`/api/admin/participants/${peerSuper.id}/role`, { headers: H, data: { role: "superadmin" } });
  // RBAC — an UNSCOPED CUSTOM role is a privileged peer too (lib/rbac.js
  // privilegedTargetFor), and no custom role is impersonable.
  const customRole = await api.post("/api/admin/roles", { headers: H, data: { label: `PAM Desk ${stamp}`, scope_mode: "all", permissions: ["participants.view"] } });
  expect(customRole.ok(), `create custom role: ${customRole.status()} ${await customRole.text()}`).toBeTruthy();
  const peerCustom = await mk("peercus");
  const cr = await api.patch(`/api/admin/users/${peerCustom.id}/role`, { headers: H, data: { role: (await customRole.json()).role.id } });
  expect(cr.ok(), `assign custom role: ${cr.status()} ${await cr.text()}`).toBeTruthy();
  // Two custom roles SCOPED to their events: one holding events.delete, which a
  // regular admin lacks (a privileged peer only by that permission), and one
  // holding nothing the admin lacks (managed by a regular admin, never impersonable).
  const scopedRole = async (label, permissions) => {
    const r = await api.post("/api/admin/roles", { headers: H, data: { label: `${label} ${stamp}`, scope_mode: "granted", permissions } });
    expect(r.ok(), `create ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
    return (await r.json()).role.id;
  };
  const peerScopedPriv = await mk("peerscp");
  const sp = await api.patch(`/api/admin/users/${peerScopedPriv.id}/role`, { headers: H, data: { role: await scopedRole("PAM Scoped deleter", ["events.view", "events.delete"]) } });
  expect(sp.ok(), `assign scoped privileged role: ${sp.status()} ${await sp.text()}`).toBeTruthy();
  const scopedPlain = await mk("scpln");
  const sl = await api.patch(`/api/admin/users/${scopedPlain.id}/role`, { headers: H, data: { role: await scopedRole("PAM Scoped viewer", ["events.view", "participants.view"]) } });
  expect(sl.ok(), `assign scoped role: ${sl.status()} ${await sl.text()}`).toBeTruthy();
  // The regular admin whose view we assert.
  const viewerAdmin = await mk("viewer");
  await api.post(`/api/admin/participants/${viewerAdmin.id}/role`, { headers: H, data: { role: "admin" } });

  // v8.7.4 — an EVENT ADMIN row. Granted through the competition's own organiser
  // route, which is how the tier is issued in production and what puts a real
  // row in `competition_admins` — so the demote test below can prove the grants
  // are cascaded away rather than merely that a column changed.
  const eaComp = await api.post("/api/admin/competitions", { headers: H, data: {
    name: `PAM EA ${stamp}`,
    start_time: new Date(Date.now() - 60_000).toISOString(),
    duration_minutes: 600, event_kind: "tournament",
  }});
  expect(eaComp.ok(), `create event-admin fixture competition: ${eaComp.status()} ${await eaComp.text()}`).toBeTruthy();
  const eaCompId = (await eaComp.json()).competition?.id;
  expect(eaCompId, "the fixture competition must have an id").toBeTruthy();

  // v8.8.25 — A PASSWORDLESS TARGET, because `Show sign-in code` cannot be reached
  // without one. `mk` always supplies a password, which stamps `password_set_at`
  // and makes `can_use_code` false for every other fixture in this file — which is
  // precisely why that row action was missing from "the single lock" for four
  // releases. The desk-invite path is how a real one is created: verified,
  // approved, and deliberately holding no password (v7.29.0 — a password would
  // make the account permanently ineligible for the very mechanism the desk
  // fallback exists to use).
  const deskEmail = `pam-desk-${stamp}@acme.com`;
  const di = await api.post("/api/admin/participants/desk-invite", {
    headers: H, data: { email: deskEmail, firstName: "Desk", lastName: "Walkup" },
  });
  expect(di.ok(), `desk-invite: ${di.status()} ${await di.text()}`).toBeTruthy();
  const deskless = (await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(deskEmail)}`)).json())
    .participants.find(p => p.email === deskEmail);
  expect(deskless, "the desk-invited walk-up is findable").toBeTruthy();
  // PRECONDITION, asserted rather than assumed: without it "the item is offered"
  // would be satisfied by a build that offers it to everyone.
  expect(deskless.can_use_code, "the walk-up is code-eligible").toBeTruthy();   // SQLite ships 1, and the client tests truthiness

  const peerEventAdmin = await mk("peerea");
  const g = await api.post(`/api/admin/competitions/${eaCompId}/admins`, {
    headers: H, data: { userId: peerEventAdmin.id },
  });
  expect(g.ok(), `grant event admin: ${g.status()} ${await g.text()}`).toBeTruthy();
  expect((await g.json()).role_changed, "the grant really promoted them into the tier").toBe(true);
  // v8.12.1 — the two Impersonate rows get their OWN organiser. `peerEventAdmin`
  // is what the v8.7.4 demotion test turns back into a participant, so rows
  // reading it held only by file order (found by the pre-release review).
  const impEventAdmin = await mk("impea");
  const g2 = await api.post(`/api/admin/competitions/${eaCompId}/admins`, {
    headers: H, data: { userId: impEventAdmin.id },
  });
  expect(g2.ok(), `grant event admin (impersonate rows): ${g2.status()} ${await g2.text()}`).toBeTruthy();

  ST = { stamp, plain, unverified, unapproved, blocked, peerAdmin, peerSuper, peerCustom, peerScopedPriv, scopedPlain, viewerAdmin, peerEventAdmin, impEventAdmin, eaCompId, deskless };
  await api.dispose();
});

test.describe("v7.14.2 — participant row-action matrix", () => {

  test("REGULAR ADMIN sees the full participant action set (impersonate, block, reset) — the reported bug", async ({ page }) => {
    await adminTab(page, ST.viewerAdmin.email);
    const { items } = await kebabFor(page, ST.plain.email);
    // Everything a regular admin is entitled to on an ordinary participant.
    for (const label of ["View profile", "Edit Profile", "History", "Impersonate", "Block", "Email sign-in code"]) {
      expect(items.some(i => i.includes(label)), `regular admin sees "${label}" — got ${JSON.stringify(items)}`).toBe(true);
    }
    // And nothing superadmin-only leaks in.
    for (const label of ["Delete", "Promote", "Demote", "Verify"]) {
      expect(items.some(i => i.includes(label)), `regular admin must NOT see "${label}"`).toBe(false);
    }
    await closeKebab(page);
  });

  test("SUPERADMIN sees the regular-admin set plus the superadmin-only actions", async ({ page }) => {
    await adminTab(page, "superadmin");
    const { items } = await kebabFor(page, ST.plain.email);
    for (const label of ["View profile", "Edit Profile", "History", "Impersonate", "Block", "Email sign-in code", "Promote to Admin", "Promote to Superadmin", "Delete"]) {
      expect(items.some(i => i.includes(label)), `superadmin sees "${label}" — got ${JSON.stringify(items)}`).toBe(true);
    }
    await closeKebab(page);
  });

  test("a PRIVILEGED peer explains itself to a regular admin instead of silently collapsing", async ({ page }) => {
    await adminTab(page, ST.viewerAdmin.email);
    for (const [target, word] of [[ST.peerAdmin, "Admin"], [ST.peerSuper, "Superadmin"]]) {
      const { items, note } = await kebabFor(page, target.email);
      // The restriction is now NAMED — this is what made the collapse read as a bug.
      expect(note, `a note explains why the menu is short for ${target.email}`).toBeTruthy();
      expect(note).toContain(`${word} account`);
      expect(note).toMatch(/only superadmins can manage it/i);
      // Edit Profile opens read-only for this case, so it is labelled honestly.
      expect(items.some(i => i.includes("View Profile")), `labelled View Profile — got ${JSON.stringify(items)}`).toBe(true);
      expect(items.some(i => i.includes("Edit Profile"))).toBe(false);
      // The read-only profile card is a read, so every row keeps it.
      expect(items.some(i => i.includes("View profile")), `View profile on a privileged peer — got ${JSON.stringify(items)}`).toBe(true);
      // The peer-admin doctrine still holds: no state-changing action offered.
      for (const label of ["Block", "Unblock", "Email sign-in code", "Impersonate", "Delete", "Promote", "Demote"]) {
        expect(items.some(i => i.includes(label)), `regular admin must NOT get "${label}" on a privileged peer`).toBe(false);
      }
      await closeKebab(page);
    }
  });

  test("an UNSCOPED CUSTOM-role row is a privileged peer to a regular admin, and nobody may impersonate it", async ({ page }) => {
    await adminTab(page, ST.viewerAdmin.email);
    const { items, note } = await kebabFor(page, ST.peerCustom.email);
    // A custom role is named by its own label (the row's role_label).
    expect(note, "the restriction is named").toMatch(new RegExp(`^PAM Desk ${ST.stamp} account — only superadmins can manage it$`));
    expect(items.some(i => i.includes("View Profile")), `labelled View Profile — got ${JSON.stringify(items)}`).toBe(true);
    expect(items.some(i => i.includes("Edit Profile"))).toBe(false);
    for (const label of ["Block", "Email sign-in code", "Impersonate", "Delete"]) {
      expect(items.some(i => i.includes(label)), `regular admin must NOT get "${label}" on a custom unscoped role`).toBe(false);
    }
    await closeKebab(page);
    // Control: a superadmin manages it, but the custom role is never impersonable
    // — and the menu says so rather than shrinking silently.
    await adminTab(page, "superadmin");
    const sa = await kebabFor(page, ST.peerCustom.email);
    expect(sa.note, "no restriction note for a superadmin, only why Impersonate is missing").toBe("Accounts with a custom role cannot be impersonated");
    for (const label of ["Block", "Email sign-in code", "Edit Profile"]) {
      expect(sa.items.some(i => i.includes(label)), `superadmin keeps "${label}" — got ${JSON.stringify(sa.items)}`).toBe(true);
    }
    expect(sa.items.some(i => i.includes("Impersonate")), "a custom role is refused impersonation_target_custom_role").toBe(false);
    await closeKebab(page);
    // CONTROL: an ordinary participant's menu carries no such note.
    const ctl = await kebabFor(page, ST.plain.email);
    expect(ctl.note, "a participant row has no custom-role note").toBeNull();
    expect(ctl.items.some(i => i.includes("Impersonate")), "…and keeps Impersonate").toBe(true);
    await closeKebab(page);
  });

  test("a SCOPED custom role is privileged to a regular admin exactly when it holds what the admin lacks (the server's answer, not the role's class)", async ({ page }) => {
    await adminTab(page, ST.viewerAdmin.email);
    // Holds events.delete: the peer menu, named.
    const priv = await kebabFor(page, ST.peerScopedPriv.email);
    expect(priv.note, "the restriction is named, by the role's own label").toMatch(new RegExp(`^PAM Scoped deleter ${ST.stamp} account — only superadmins can manage it$`));
    expect(priv.items.some(i => i.includes("View Profile")), `labelled View Profile — got ${JSON.stringify(priv.items)}`).toBe(true);
    for (const label of ["Edit Profile", "Block", "Email sign-in code", "Impersonate"]) {
      expect(priv.items.some(i => i.includes(label)), `regular admin must NOT get "${label}" on a role holding events.delete`).toBe(false);
    }
    await closeKebab(page);
    // Holds nothing the admin lacks: managed like a participant, minus Impersonate, with the reason.
    const ok = await kebabFor(page, ST.scopedPlain.email);
    expect(ok.note, "why Impersonate is missing").toBe("Accounts with a custom role cannot be impersonated");
    for (const label of ["Edit Profile", "Block", "Email sign-in code"]) {
      expect(ok.items.some(i => i.includes(label)), `regular admin keeps "${label}" on a role inside their own — got ${JSON.stringify(ok.items)}`).toBe(true);
    }
    expect(ok.items.some(i => i.includes("Impersonate"))).toBe(false);
    await closeKebab(page);
  });

  test("a SUPERADMIN retains full control over privileged peers (the restriction is tier-specific, not global)", async ({ page }) => {
    await adminTab(page, "superadmin");
    const { items, note } = await kebabFor(page, ST.peerAdmin.email);
    expect(note, "no restriction note for a superadmin").toBeNull();
    for (const label of ["Block", "Email sign-in code", "Edit Profile", "Delete"]) {
      expect(items.some(i => i.includes(label)), `superadmin keeps "${label}" on a peer admin`).toBe(true);
    }
    // Impersonation of a privileged account is refused for EVERY tier by design.
    expect(items.some(i => i.includes("Impersonate")), "nobody may impersonate a privileged account").toBe(false);
    await closeKebab(page);
  });

  test("target lifecycle states offer exactly the applicable actions, per tier", async ({ page }) => {
    // Unverified: only a superadmin can Verify; nobody may impersonate an
    // account that cannot log in.
    await adminTab(page, "superadmin");
    let k = await kebabFor(page, ST.unverified.email);
    expect(k.items.some(i => i.includes("Verify")), "superadmin can Verify an unverified target").toBe(true);
    expect(k.items.some(i => i.includes("Impersonate")), "unverified target is not impersonatable").toBe(false);
    await closeKebab(page);

    // Unapproved (but verified): Approve + Deny are offered.
    //
    // v8.8.25 — DENY IS ASSERTED NOW. The comment above has claimed "Approve +
    // Deny are offered" since this file was written and only Approve was ever
    // checked, on this file's OWN fixture — the clearer of the two breaches of
    // CLAUDE.md's claim that this is "the single lock over which actions each
    // admin tier sees on each kind of participant row".
    k = await kebabFor(page, ST.unapproved.email);
    expect(k.items.some(i => i.includes("Approve")), "Approve offered on a verified-unapproved target").toBe(true);
    expect(k.items.some(i => i.includes("Deny")), "Deny Approval offered on a verified-unapproved target").toBe(true);
    expect(k.items.some(i => i.includes("Impersonate")), "unapproved target is not impersonatable").toBe(false);
    await closeKebab(page);

    // v8.8.25 — SHOW SIGN-IN CODE. Gated on `can_use_code`, which is ACCOUNT-based
    // rather than tier-based, so it needs its own fixture — and the CONTROL is the
    // half that matters: an UNAPPROVED participant must NOT be offered it (a desk
    // code cannot approve), or "the item appears" is satisfied by a build that
    // offers it to everyone and hands each of them a code the server will refuse.
    k = await kebabFor(page, ST.deskless.email);
    expect(k.items.some(i => i.includes("Show sign-in code")), "offered on a passwordless walk-up").toBe(true);
    await closeKebab(page);
    k = await kebabFor(page, ST.unapproved.email);
    expect(k.items.some(i => i.includes("Show sign-in code")), "CONTROL — withheld from an unapproved account").toBe(false);
    await closeKebab(page);
    k = await kebabFor(page, ST.peerAdmin.email);
    expect(k.items.some(i => i.includes("Show sign-in code")), "CONTROL — withheld from a privileged target").toBe(false);
    await closeKebab(page);

    // Blocked: Unblock replaces Block; no impersonation.
    k = await kebabFor(page, ST.blocked.email);
    expect(k.items.some(i => i.includes("Unblock")), "Unblock offered on a blocked target").toBe(true);
    expect(k.items.some(i => i.includes("Impersonate")), "blocked target is not impersonatable").toBe(false);
    await closeKebab(page);

    // A regular admin sees the same lifecycle-driven set minus superadmin-only Verify.
    await adminTab(page, ST.viewerAdmin.email);
    k = await kebabFor(page, ST.unverified.email);
    expect(k.items.some(i => i.includes("Verify")), "Verify stays superadmin-only").toBe(false);
    expect(k.items.some(i => i.includes("Block")), "a regular admin can still Block an unverified participant").toBe(true);
    await closeKebab(page);

    // v8.8.25 — BOTH new rows for THIS tier as well. Deny is gated on `canBlock`
    // and the code item on the account, so neither is superadmin-only; asserting
    // only the superadmin half would leave the tier axis this file exists for
    // untested on exactly the two actions it was missing.
    k = await kebabFor(page, ST.unapproved.email);
    expect(k.items.some(i => i.includes("Deny")), "a regular admin is offered Deny Approval").toBe(true);
    await closeKebab(page);
    k = await kebabFor(page, ST.deskless.email);
    expect(k.items.some(i => i.includes("Show sign-in code")), "a regular admin is offered the sign-in code").toBe(true);
    await closeKebab(page);
    k = await kebabFor(page, ST.unapproved.email);
    expect(k.items.some(i => i.includes("Show sign-in code")), "CONTROL — and not for an unapproved account").toBe(false);
    await closeKebab(page);
  });

  test("every action a REGULAR ADMIN sees on a participant actually works from the UI", async ({ page }) => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const target = await (async () => {
      const email = `pam-work-${ST.stamp}@acme.com`;
      const { api: anon, csrf: ac } = await freshCtx();
      await registerPost(anon, "/api/register", { headers: h(ac), data: {
        firstName: "Works", lastName: "Target", nickname: `pam_wk_${ST.stamp}`.slice(0, 40), email,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS,
      }});
      await anon.dispose();
      const u = (await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json())
        .participants.find(p => p.email === email);
      await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H });
      await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H });
      return { id: u.id, email };
    })();
    await api.dispose();

    await adminTab(page, ST.viewerAdmin.email);

    // 1. History opens a dialog.
    await kebabFor(page, target.email);
    await page.locator("#kebab-portal button:has-text('History')").first().click();
    await expect(page.locator("#hist-overlay")).toBeVisible({ timeout: 8000 });
    await page.keyboard.press("Escape");
    await expect(page.locator("#hist-overlay")).toHaveCount(0, { timeout: 5000 });

    // 2. Edit Profile opens an EDITABLE dialog (not the read-only peer variant) and
    //    saves. A regular admin may FILL BLANK fields but not overwrite populated
    //    ones (documented "fill blank fields only" rule) — assert both halves, so
    //    the tier boundary is locked in the direction of permitted AND refused.
    await kebabFor(page, target.email);
    await page.locator("#kebab-portal button:has-text('Edit Profile')").first().click();
    const prof = page.locator("#admin-profile-overlay");
    await expect(prof).toBeVisible({ timeout: 8000 });
    await expect(prof.locator("text=Read-only view"), "regular admin edits a participant for real").toHaveCount(0);
    await expect(prof.locator("#adp-company"), "a POPULATED field stays locked for a regular admin").toBeDisabled();
    const phone = prof.locator("#adp-phone");
    await expect(phone, "a BLANK optional field is fillable by a regular admin").toBeEnabled();
    await phone.fill("+15550142");
    await prof.locator("button:has-text('Save')").first().click();
    // Dirty form → "Save changes?" confirm (the edit-profile dialog contract).
    await expect(page.locator("#modal-overlay")).toContainText(/save/i, { timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();
    await expect.poll(() => dbGet("SELECT phone FROM users WHERE id=?", target.id).phone || "",
      { timeout: 10000 }).toContain("5550142");
    await page.locator("#admin-profile-overlay").waitFor({ state: "detached", timeout: 8000 }).catch(() => {});

    // 3. Block, then Unblock — both from the kebab, both persisted.
    await kebabFor(page, target.email);
    await page.locator("#kebab-portal button:has-text('Block')").first().click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    if (await page.locator("#modal-overlay.open").count()) await page.locator("#modal-confirm-btn").click();
    await expect.poll(() => dbGet("SELECT blocked FROM users WHERE id=?", target.id).blocked, { timeout: 8000 }).toBe(1);
    await kebabFor(page, target.email);
    await page.locator("#kebab-portal button:has-text('Unblock')").first().click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    if (await page.locator("#modal-overlay.open").count()) await page.locator("#modal-confirm-btn").click();
    await expect.poll(() => dbGet("SELECT blocked FROM users WHERE id=?", target.id).blocked, { timeout: 8000 }).toBe(0);

    // 4. Email sign-in code mints a real EMAILED code (the admin is shown none).
    // The account's registration mailed it a code moments ago; a code under two
    // minutes old is never replaced, so forget that to exercise a real send.
    await page.request.post("/api/test/reset-recent-code-sends");
    const beforeCode = dbGet("SELECT login_code_hash FROM users WHERE id=?", target.id).login_code_hash;
    await kebabFor(page, target.email);
    await page.locator("#kebab-portal button:has-text('Email sign-in code')").first().click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    if (await page.locator("#modal-overlay.open").count()) await page.locator("#modal-confirm-btn").click();
    await expect.poll(() => dbGet("SELECT login_code_hash, login_code_via FROM users WHERE id=?", target.id),
      { timeout: 10000 }).toMatchObject({ login_code_via: "email" });
    expect(dbGet("SELECT login_code_hash FROM users WHERE id=?", target.id).login_code_hash).not.toBe(beforeCode);

    // 5. Impersonate → participant view + banner → Exit → back in the admin panel.
    await kebabFor(page, target.email);
    await page.locator("#kebab-portal button:has-text('Impersonate')").first().click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();
    const banner = page.locator("#impersonation-banner");
    await banner.waitFor({ state: "visible", timeout: 15000 });
    await expect(banner).toContainText(/read-only/i);
    await page.locator("#impersonation-banner [data-action='impersonation-exit']").click();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 15000 });
    await expect(page.locator("#impersonation-banner")).toHaveCount(0);
  });

  test("superadmin-only actions work from the UI: Verify, Approve, Promote/Demote, Delete", async ({ page }) => {
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const email = `pam-sa-${ST.stamp}@acme.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: h(ac), data: {
      firstName: "SaOnly", lastName: "Target", nickname: `pam_sa_${ST.stamp}`.slice(0, 40), email,
      company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS,
    }});
    await anon.dispose();
    const uid = (await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json())
      .participants.find(p => p.email === email).id;
    await api.dispose();

    await adminTab(page, "superadmin");

    // Verify (unverified target) — the primary button carries it too; use the kebab.
    await kebabFor(page, email);
    await page.locator("#kebab-portal button:has-text('Verify')").first().click();
    // The confirm names the recovery door that exists (Show sign-in code), never
    // the removed Reset Password.
    const verifyDlg = page.locator("#modal-overlay.open");
    await expect(verifyDlg, "Verify asks first").toBeVisible({ timeout: 5000 });
    await expect(verifyDlg).toContainText("Show sign-in code");
    await expect(verifyDlg).not.toContainText("Reset Password");
    await page.locator("#modal-confirm-btn").click();
    await expect.poll(() => dbGet("SELECT verified FROM users WHERE id=?", uid).verified, { timeout: 10000 }).toBe(1);
    // v8.12.4 — this used to close a bundled reset-link popup "if present". The
    // bundle was removed in v8.3.22 (Reset Password is the only route that
    // hands over a link), so the branch had been dead ever since and asserted
    // nothing. The removal is now the assertion: verify says so, and no link.
    await expect(page.locator("#toast-stack .toast").filter({ hasText: "User verified!" }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#reset-link-overlay"), "verify hands over no reset link").toHaveCount(0);

    // Approve.
    await kebabFor(page, email);
    await page.locator("#kebab-portal button:has-text('Approve')").first().click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    if (await page.locator("#modal-overlay.open").count()) await page.locator("#modal-confirm-btn").click();
    await expect.poll(() => dbGet("SELECT approved FROM users WHERE id=?", uid).approved, { timeout: 10000 }).toBe(1);

    // Promote to Admin, then Demote to Participant.
    await kebabFor(page, email);
    await page.locator("#kebab-portal button:has-text('Promote to Admin')").first().click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();
    await expect.poll(() => dbGet("SELECT role FROM users WHERE id=?", uid).role, { timeout: 10000 }).toBe("admin");
    await kebabFor(page, email);
    await page.locator("#kebab-portal button:has-text('Demote to Participant')").first().click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();
    await expect.poll(() => dbGet("SELECT role FROM users WHERE id=?", uid).role, { timeout: 10000 }).toBe("participant");

    // Delete.
    await kebabFor(page, email);
    await page.locator("#kebab-portal button:has-text('Delete')").first().click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
    await page.locator("#modal-confirm-btn").click();
    await expect.poll(() => dbGet("SELECT id FROM users WHERE id=?", uid), { timeout: 10000 }).toBeUndefined();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // v8.7.4 — the EVENT-ADMIN row.
  //
  // The role chain had branches for participant / admin / superadmin and no
  // `else`, so on an event-admin row `roleKm` was the empty string and a
  // SUPERADMIN had no way to demote an event admin from any screen — while the
  // role route accepts the move in both directions and cascades every grant
  // away, and ROLES_AND_PERMISSIONS states the capability as one the operator
  // requires. Reachable only with curl, which is not shipped.
  // ───────────────────────────────────────────────────────────────────────────

  // ───────────────────────────────────────────────────────────────────────────
  // v8.12.1 — IMPERSONATE ON AN EVENT-ADMIN ROW, FOR BOTH GLOBAL TIERS.
  //
  // An event admin can now be impersonated in EITHER of their views, and the
  // dialog asks which. The row action is the same "Impersonate" item it always
  // was; what changes is that it carries the target's ROLE so the dialog can
  // offer the picker, and that the entry dialog for this row is the two-view
  // one. Asserted for both tiers (the standing rule), on a fixture of their
  // OWN — `impEventAdmin`, never `peerEventAdmin`, which the v8.7.4 demotion
  // test below turns back into a participant — with the role asserted as a
  // PRECONDITION rather than inferred from the attribute under test.
  // ───────────────────────────────────────────────────────────────────────────

  for (const who of ["superadmin", "admin"]) {
    test(`v8.12.1 — ${who}: Impersonate on an EVENT ADMIN row carries the role and opens the two-view dialog`, async ({ page }) => {
      expect(dbGet("SELECT role FROM users WHERE id=?", ST.impEventAdmin.id).role, "precondition: the fixture really is an event admin").toBe("event_admin");
      await adminTab(page, who === "superadmin" ? "superadmin" : ST.viewerAdmin.email);
      const { items } = await kebabFor(page, ST.impEventAdmin.email);
      expect(items.some(i => i.includes("Impersonate")),
        `${who} sees Impersonate on an event-admin row — got ${JSON.stringify(items)}`).toBe(true);
      const btn = page.locator("#kebab-portal button:has-text('Impersonate')").first();
      await expect(btn, "the item carries the target's role for the dialog").toHaveAttribute("data-role", "event_admin");
      await btn.click();
      await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
      await expect(page.locator("#modal-title")).toContainText(/Impersonate event admin/i);
      await expect(page.locator('#modal-body input[name="imp-view"]'), "both views are offered").toHaveCount(2);
      await expect(page.locator('#modal-body input[name="imp-view"][value="admin"]'), "the panel is the default").toBeChecked();
      await expect(page.locator("#modal-body"), "the tier is stated").toContainText(who === "superadmin" ? /full access/i : /read-only/i);
      // CONTROL on the same tier: a PARTICIPANT row's dialog has no picker.
      await page.locator("#modal-cancel-btn").click();
      const k2 = await kebabFor(page, ST.plain.email);
      expect(k2.items.some(i => i.includes("Impersonate"))).toBe(true);
      const btn2 = page.locator("#kebab-portal button:has-text('Impersonate')").first();
      await expect(btn2).toHaveAttribute("data-role", "participant");
      await btn2.click();
      await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });
      await expect(page.locator("#modal-title")).toContainText(/Impersonate participant/i);
      await expect(page.locator('#modal-body input[name="imp-view"]'), "no picker for a participant").toHaveCount(0);
      await page.locator("#modal-cancel-btn").click();
    });
  }

  test("v8.7.4 — a SUPERADMIN can move an EVENT ADMIN out of the tier from the row", async ({ page }) => {
    await adminTab(page, "superadmin");
    const { items } = await kebabFor(page, ST.peerEventAdmin.email);
    for (const label of ["Promote to Admin", "Promote to Superadmin", "Demote to Participant"]) {
      expect(items.some(i => i.includes(label)),
        `superadmin sees "${label}" on an event-admin row — got ${JSON.stringify(items)}`).toBe(true);
    }
    // The per-EVENT revoke is a different control and is NOT a substitute: it
    // drops one grant and deliberately leaves the role in place. Asserting both
    // are distinguishable is what stops a future reader deleting one for the
    // other.
    expect(items.some(i => /Remove as event admin/i.test(i)),
      "the per-event revoke is not offered here — no event is focused").toBe(false);
    await closeKebab(page);
  });

  test("v8.7.4 — demoting an event admin clears the role AND every event grant", async ({ page }) => {
    // The end-to-end proof. `role` alone would pass against a build that wrote
    // the column and left the grants behind, which is the state the route's own
    // transaction exists to prevent — an inert scope that silently re-arms the
    // next time somebody is granted the tier.
    const uid = ST.peerEventAdmin.id;
    expect(dbGet("SELECT role FROM users WHERE id=?", uid).role,
      "precondition: the fixture really is an event admin").toBe("event_admin");
    expect(dbGet("SELECT COUNT(*) AS n FROM competition_admins WHERE user_id=?", uid).n,
      "precondition: …with a real event grant").toBeGreaterThan(0);

    await adminTab(page, "superadmin");
    await kebabFor(page, ST.peerEventAdmin.email);
    await page.locator("#kebab-portal button:has-text('Demote to Participant')").first().click();
    await page.locator("#modal-overlay.open").waitFor({ state: "visible", timeout: 5000 });

    // The verb, and the warning. `rank` had no entry for the tier, so it scored
    // 0 — the same as a participant — and this demotion announced itself as
    // "Promote to undefined" on both counts.
    await expect(page.locator("#modal-title")).toContainText("Demote to Participant");
    await expect(page.locator("#modal-body"),
      "the operator is told the events go, before clicking").toContainText("removes every event they organise");
    // The COUNT, which the superadmin guide promises the confirmation gives.
    await expect(page.locator("#modal-body"),
      "…and how many, from the row they are looking at").toContainText("(1)");

    await page.locator("#modal-confirm-btn").click();
    await expect.poll(() => dbGet("SELECT role FROM users WHERE id=?", uid).role, { timeout: 10000 })
      .toBe("participant");
    await expect.poll(() => dbGet("SELECT COUNT(*) AS n FROM competition_admins WHERE user_id=?", uid).n,
      { timeout: 10000 }).toBe(0);
    // And the SERVER's own figure is reported back, not merely the row's guess.
    await expect(page.locator("#toast-stack"),
      "the irreversible half is reported, not silent").toContainText("1 event grant cleared");
  });

  test("CONTROL: a REGULAR ADMIN gets no role controls on an event-admin row", async ({ page }) => {
    // Without this, "the role controls render" is satisfied by a build that
    // shows them to every admin — which would offer a control the role route
    // (superadmin-only) then refuses. A global admin is NOT restricted from
    // managing an event admin in general, so the ordinary manage set must still
    // be there: that is what makes this a control on the ROLE gate specifically
    // rather than on the peer-privilege rule.
    const { api, csrf } = await apiLogin("superadmin");
    const H = h(csrf);
    const fresh = `pam-peerea2-${ST.stamp}@acme.com`;
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", { headers: h(ac), data: {
      firstName: "Matrix", lastName: "Target", nickname: `pam_peerea2_${ST.stamp}`.slice(0, 40), email: fresh,
      company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS,
    }});
    await anon.dispose();
    const u2 = (await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(fresh)}`)).json())
      .participants.find(p => p.email === fresh);
    await api.post(`/api/admin/participants/${u2.id}/verify`, { headers: H });
    await api.post(`/api/admin/participants/${u2.id}/approve`, { headers: H });
    const g = await api.post(`/api/admin/competitions/${ST.eaCompId}/admins`, { headers: H, data: { userId: u2.id } });
    expect(g.ok(), `grant event admin (control): ${g.status()} ${await g.text()}`).toBeTruthy();
    await api.dispose();

    await adminTab(page, ST.viewerAdmin.email);
    const { items } = await kebabFor(page, fresh);
    for (const label of ["Promote", "Demote"]) {
      expect(items.some(i => i.includes(label)),
        `a regular admin must NOT see "${label}" — got ${JSON.stringify(items)}`).toBe(false);
    }
    // …and the tier is not privileged in a GLOBAL admin's eyes, so they keep
    // the ordinary controls over it.
    expect(items.some(i => i.includes("Edit Profile")),
      "a global admin still manages an event admin normally").toBe(true);
    await closeKebab(page);
  });
});
