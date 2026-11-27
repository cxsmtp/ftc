// @ts-check
//
// v7.21.14 — a tag dialog that is REFUSED must say so.
//
// Three tag surfaces share one shape (a dialog with an input plus suggestion
// chips, and an × on each rendered chip to remove one). The COMPETITION one has
// reported its refusals for releases; the PARTICIPANT and CHALLENGE ones had
// four paths between them that checked `r.ok()` and, when it was false, did
// nothing at all — the add-dialog simply closed.
//
// So an admin typed a tag, clicked Save, watched the dialog dismiss, and the tag
// was not there. That is indistinguishable from a broken feature, which is how
// it gets reported; and on the remove path the server was sending a genuinely
// actionable sentence ("Demote to participant first") that nobody ever saw.
//
// Same class as v7.14.2 (a permission-gated row menu that shrank without saying
// why) and v7.16.7 (a list emptied by a filter, reported as an empty list):
// **gate the affordance and the explanation together.**
const { test, expect } = require("./isolated-test");
const { narrowPeopleTable } = require("./ui-admin-helpers"); // v9.2.5 — the one way to type into the admin search boxes
// The tag and group cells are outside the Participants table's default six columns.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").showAllParticipantColumns(page); });
const { registerPost } = require("./helpers");
const { apiLogin, getSuperadminPass, PARTICIPANT_PASS, BASE, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const h = csrf => ({ "x-csrf-token": csrf, "content-type": "application/json" });

// RBAC — People leaves admin accounts out unless "Show admin accounts" is
// ticked; the rows these tests look up include promoted admins. Tick it (and
// wait for the kind=all reload) before searching. It must be offered to every
// global admin, so its absence fails rather than skips.
async function showAdminAccounts(page) {
  const inc = page.locator("#p-include-admins");
  await expect(inc, "People offers Show admin accounts to a global admin").toBeVisible({ timeout: 10000 });
  if (!(await inc.isChecked())) {
    const reload = page.waitForResponse((r) => r.url().includes("/api/admin/participants?") && r.url().includes("kind=all"));
    await inc.check();
    await reload;
  }
}

async function loginSuperadmin(page) {
  const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
  const r = await page.request.post("/api/login", {
    headers: h(csrfToken), data: { email: "superadmin", password: getSuperadminPass() },
  });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
}

test.describe("v7.21.14 — a refused tag change is reported", () => {
  test("removing the staff tag from an ADMIN surfaces the server's reason", async ({ page }) => {
    // The refusal under test: "Cannot remove staff tag from admin/superadmin
    // users. Demote to participant first." It is a rule the admin can act on,
    // and before this it produced no feedback whatsoever — the chip simply
    // stayed where it was.
    const stamp = Date.now();
    const email = `tagref-${stamp}@company.com`;
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const reg = await registerPost(page.request, "/api/register", {
      headers: h((await (await page.request.get("/api/csrf-token")).json()).csrfToken),
      data: {
        firstName: "Tag", lastName: "Ref", nickname: `tagref_${stamp}`, email,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "Boston", password: PARTICIPANT_PASS,
      },
    });
    expect(reg.status(), "fixture participant registered").toBe(200);
    const u = (await (await sa.get("/api/admin/participants?limit=5000&kind=all")).json())
      .participants.find(p => p.email === email);
    expect(u, "fixture participant is listed").toBeTruthy();
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": saCsrf } });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": saCsrf } });
    // Promotion auto-applies the `staff` tag — which is exactly the tag the
    // remove path refuses to take off a privileged account.
    const promo = await sa.post(`/api/admin/participants/${u.id}/role`, { headers: h(saCsrf), data: { role: "admin" } });
    expect(promo.ok(), "fixture promoted to admin").toBeTruthy();
    const after = (await (await sa.get("/api/admin/participants?limit=5000&kind=all")).json())
      .participants.find(p => p.id === u.id);
    expect((after.tags || []), "promotion must have applied the staff tag, or there is nothing to refuse")
      .toContain("staff");
    await sa.dispose();

    await loginSuperadmin(page);
    await page.click('[data-tab-id="admin-participants-tab"]');
    await showAdminAccounts(page);
    // The table paginates at 30 and the worker DB accumulates, so narrow to the
    // fixture row first (v7.15.29) — otherwise this is a lookup for a row that
    // is genuinely absent, not slow.
    await narrowPeopleTable(page, email);
    const row = page.locator("#admin-participants-tab tr", { hasText: email }).first();
    await expect(row).toBeVisible({ timeout: 20000 });

    const x = row.locator('.tag-x[data-action="participant-tag-remove"][data-tag="staff"]').first();
    await expect(x, "the staff chip must offer a remove affordance").toBeVisible({ timeout: 10000 });
    await x.click();

    const toast = page.locator(".toast", { hasText: /Demote to participant first/i }).first();
    await expect(toast,
      "the refusal must be shown — the server sent an actionable sentence and the dialog used to swallow it"
    ).toBeVisible({ timeout: 10000 });

    // …and the state must be unchanged, so the toast is not merely cosmetic
    // cover for a half-applied change.
    const { api: sa2 } = await apiLogin("superadmin");
    const still = (await (await sa2.get("/api/admin/participants?limit=5000&kind=all")).json())
      .participants.find(p => p.id === u.id);
    expect(still.tags, "the tag must still be there — the refusal was a refusal").toContain("staff");
    await sa2.dispose();
  });

  // Stage B — a question has no tag box any more; the markers an organiser sets
  // (needs, shared) are the editor's Topic and sharing row, written through the
  // same tag routes after the save. A refusal there must be REPORTED, not
  // swallowed by the editor closing: a needs marker on a Booth Event's own
  // question is refused (a visitor's phone cannot do what it needs).
  test("a question marker the server rejects surfaces the reason, and nothing is written", async ({ page }) => {
    const stamp = Date.now();
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const ev = await sa.post("/api/admin/competitions", { headers: h(saCsrf), data: {
      name: `TagRefusal Booth ${stamp}`, event_kind: "booth",
      start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 600 } });
    expect(ev.ok(), `booth event: ${await ev.text()}`).toBeTruthy();
    const compId = (await ev.json()).competition.id;
    const mk = await sa.post("/api/admin/tasks", {
      headers: h(saCsrf),
      data: { title: `TagRefusal ${stamp}`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "a", status: "published", competitionId: compId },
    });
    expect(mk.ok(), `fixture question made in the booth: ${await mk.text()}`).toBeTruthy();
    const qid = (await mk.json()).id;
    await sa.dispose();
    const stored = async () => ((await (await page.request.get("/api/admin/tasks")).json()).find(t => t.id === qid) || {}).tags;

    await loginSuperadmin(page);
    await page.click('[data-tab-id="admin-tasks-tab"]');
    await expect.poll(() => page.evaluate((id) => !!(window.adminTasksData || []).find(t => t.id === id), qid), { timeout: 20000 }).toBe(true);
    await page.evaluate((id) => window.editTask(id), qid);
    await page.locator('[aria-controls="tf-org-body"]').click();
    await page.locator('#tf-needs-list input[data-need="desktop"]').check();
    await page.locator("#save-task-btn").click();
    // The question is live in the event, so the save asks first.
    await page.locator("#modal-confirm-btn").click();

    await expect(page.locator(".toast").filter({ hasText: /Booth/i }).first(),
      "a refused marker must report the reason, not close silently"
    ).toBeVisible({ timeout: 10000 });
    expect(await stored(), "the refusal was a refusal: no marker written").toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v8.11.4 — the GROUP chip was the last one of these four paths still silent,
// and it was silent in BOTH directions: a refusal said nothing, and a SUCCESS
// said nothing either while cascading further than any other control on the row.
//
// Removing a group membership runs `reconcileCompetitionMembership` over every
// competition that group is bound to, so for a group-origin-only member it
// writes an absence row, evicts their session and emails them that their access
// was removed — from a 24x24 `×` in a dense chip list, on a table that
// re-renders every 15 seconds, with no confirm and no toast at all.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.11.4 — the group chip confirms, reports, and is withheld with its reason", () => {
  // Register → verify → approve, returning the row. Shared by all three arms so
  // each owns its own participant (*Competition-fixture checklist* item 3): the
  // seeded three are blocked, re-passworded and tagged by other files.
  async function mkParticipant(page, sa, saCsrf, slug) {
    const stamp = Date.now();
    const email = `${slug}-${stamp}@company.com`;
    const reg = await registerPost(page.request, "/api/register", {
      headers: h((await (await page.request.get("/api/csrf-token")).json()).csrfToken),
      data: {
        firstName: "Grp", lastName: "Fix", nickname: `${slug}_${stamp}`, email,
        company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
        jobFunction: "Software Developer / Engineer", city: "Boston", password: PARTICIPANT_PASS,
      },
    });
    expect(reg.status(), `${slug} registered`).toBe(200);
    const u = (await (await sa.get("/api/admin/participants?limit=5000&kind=all")).json())
      .participants.find(p => p.email === email);
    expect(u, `${slug} is listed`).toBeTruthy();
    await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: { "x-csrf-token": saCsrf } });
    await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: { "x-csrf-token": saCsrf } });
    return { ...u, email };
  }

  async function mkGroupWith(sa, saCsrf, name, userIds) {
    const g = await sa.post("/api/admin/groups", { headers: h(saCsrf), data: { name, userIds } });
    expect(g.ok(), `group ${name} created: ${g.status()}`).toBeTruthy();
    return (await g.json()).group || (await (await sa.get("/api/admin/groups")).json()).find(x => x.name === name);
  }

  async function findRow(page, email) {
    await page.click('[data-tab-id="admin-participants-tab"]');
    await showAdminAccounts(page);
    // The table paginates at 30 and rows accumulate within a file (v7.15.29).
    await narrowPeopleTable(page, email);
    const row = page.locator("#admin-participants-tab tr", { hasText: email }).first();
    await expect(row).toBeVisible({ timeout: 20000 });
    return row;
  }

  test("the × CONFIRMS, names the participant and the group, and Cancel changes nothing", async ({ page }) => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const p = await mkParticipant(page, sa, saCsrf, "grpconf");
    const gName = `ConfGrp ${Date.now().toString(36)}`;
    const g = await mkGroupWith(sa, saCsrf, gName, [p.id]);
    // Precondition — without it "the membership survived" is equally true of a
    // fixture where the add never happened.
    const before = (await (await sa.get("/api/admin/participants?limit=5000&kind=all")).json())
      .participants.find(u => u.id === p.id);
    expect((before.groups || []).map(x => x.name), "fixture: the participant is IN the group")
      .toContain(gName);
    await sa.dispose();

    await loginSuperadmin(page);
    const row = await findRow(page, p.email);
    await row.locator('.tag-x[data-action="participant-group-remove"]').first().click();

    const modal = page.locator("#modal-overlay");
    await expect(modal, "a cascading removal must confirm first").toBeVisible({ timeout: 10000 });
    // It must NAME the target and the group — the v7.7.33 (AL12) rule, because
    // this fires from a dense row where a wrong-row misclick is easy.
    await expect(modal).toContainText(p.nickname || p.email);
    await expect(modal).toContainText(gName);
    // …and state the consequence, which is the whole reason it is confirmed.
    await expect(modal).toContainText(/lose access|emailed/i);

    await page.click("#modal-cancel-btn");
    await expect(modal).toBeHidden({ timeout: 10000 });

    const { api: sa2 } = await apiLogin("superadmin");
    const still = (await (await sa2.get("/api/admin/participants?limit=5000&kind=all")).json())
      .participants.find(u => u.id === p.id);
    expect((still.groups || []).map(x => x.name), "Cancel must change nothing")
      .toContain(gName);
    await sa2.dispose();
  });

  test("confirming removes it and SAYS so", async ({ page }) => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const p = await mkParticipant(page, sa, saCsrf, "grpdo");
    const gName = `DoGrp ${Date.now().toString(36)}`;
    await mkGroupWith(sa, saCsrf, gName, [p.id]);
    await sa.dispose();

    await loginSuperadmin(page);
    const row = await findRow(page, p.email);
    await row.locator('.tag-x[data-action="participant-group-remove"]').first().click();
    await expect(page.locator("#modal-overlay")).toBeVisible({ timeout: 10000 });
    await page.click("#modal-confirm-btn");

    // The success path was silent too: the row simply re-rendered, so an admin
    // who mis-clicked got no signal that anything had happened.
    await expect(page.locator(".toast", { hasText: new RegExp(`Removed from ${gName}`, "i") }).first(),
      "the success must be reported").toBeVisible({ timeout: 10000 });

    const { api: sa2 } = await apiLogin("superadmin");
    const after = (await (await sa2.get("/api/admin/participants?limit=5000&kind=all")).json())
      .participants.find(u => u.id === p.id);
    expect((after.groups || []).map(x => x.name), "…and it really was removed").not.toContain(gName);
    await sa2.dispose();
  });

  test("a REGULAR admin is not offered the chip controls on a privileged target, and is told why", async ({ page }) => {
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const actor = await mkParticipant(page, sa, saCsrf, "grpactor");
    const victim = await mkParticipant(page, sa, saCsrf, "grpadmin");
    const ordinary = await mkParticipant(page, sa, saCsrf, "grpplain");
    const gName = `GateGrp ${Date.now().toString(36)}`;
    await mkGroupWith(sa, saCsrf, gName, [victim.id, ordinary.id]);
    for (const id of [actor.id, victim.id]) {
      const r = await sa.post(`/api/admin/participants/${id}/role`, { headers: h(saCsrf), data: { role: "admin" } });
      expect(r.ok(), "fixture promoted to admin").toBeTruthy();
    }
    await sa.dispose();

    // Sign in as the REGULAR admin — the actor the server refuses here.
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const li = await codeLogin(page.request, actor.email, h(csrfToken));
    expect(li.ok(), `regular-admin login: ${li.status()}`).toBeTruthy();
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });

    const priv = await findRow(page, victim.email);
    // The controls are WITHHELD…
    await expect(priv.locator('.tag-x[data-action="participant-group-remove"]'),
      "the group × must not be offered where the server always refuses").toHaveCount(0);
    await expect(priv.locator('[data-action="participant-group-add"]')).toHaveCount(0);
    await expect(priv.locator('[data-action="participant-tag-remove"]')).toHaveCount(0);
    await expect(priv.locator('[data-action="participant-tag-add"]')).toHaveCount(0);
    // …WITH their reason, or the absence reads as a broken feature (v7.14.2).
    await expect(priv.locator(".chip-note").first()).toBeVisible();
    await expect(priv.locator(".chip-note").first()).toContainText(/only a superadmin/i);

    // THE CONTROL. Without it, "the × is absent" is equally satisfied by a build
    // that stopped rendering chip controls for everybody — which would be a worse
    // product than the defect being fixed.
    const plain = await findRow(page, ordinary.email);
    await expect(plain.locator('.tag-x[data-action="participant-group-remove"]').first(),
      "an ordinary participant's chips keep their controls").toBeVisible();
    await expect(plain.locator('[data-action="participant-tag-add"]').first()).toBeVisible();
    await expect(plain.locator(".chip-note")).toHaveCount(0);
  });

  test("a refusal that still reaches the server is SPOKEN, not swallowed", async ({ page }) => {
    // The withholding above means a regular admin cannot reach this 403 by
    // clicking any more — so the else branch is driven through the real client
    // function against the real server refusal, which is what it guards: a stale
    // row, a target promoted since the render, or any of the other two 403s
    // (event-admin scope, group-write-denied) this path can return.
    const { api: sa, csrf: saCsrf } = await apiLogin("superadmin");
    const actor = await mkParticipant(page, sa, saCsrf, "grpspeak");
    const victim = await mkParticipant(page, sa, saCsrf, "grpvictim");
    const gName = `SpeakGrp ${Date.now().toString(36)}`;
    const g = await mkGroupWith(sa, saCsrf, gName, [victim.id]);
    for (const id of [actor.id, victim.id]) {
      await sa.post(`/api/admin/participants/${id}/role`, { headers: h(saCsrf), data: { role: "admin" } });
    }
    await sa.dispose();

    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    await codeLogin(page.request, actor.email, h(csrfToken));
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    await findRow(page, victim.email);   // load the row into S.adminParticipantsData

    const gid = g.id;
    await page.evaluate(([uid, groupId]) => { window.removeGroup(uid, groupId); }, [victim.id, gid]);
    await expect(page.locator("#modal-overlay")).toBeVisible({ timeout: 10000 });
    await page.click("#modal-confirm-btn");

    await expect(page.locator(".toast", { hasText: /only a superadmin can modify group membership/i }).first(),
      "the server's actionable sentence must reach the admin").toBeVisible({ timeout: 10000 });

    const { api: sa2 } = await apiLogin("superadmin");
    const still = (await (await sa2.get("/api/admin/participants?limit=5000&kind=all")).json())
      .participants.find(u => u.id === victim.id);
    expect((still.groups || []).map(x => x.name), "the refusal was a refusal").toContain(gName);
    await sa2.dispose();
  });
});
