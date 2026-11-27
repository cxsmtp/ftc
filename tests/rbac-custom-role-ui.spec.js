"use strict";

// CUSTOM ROLES IN THE BROWSER — a holder of a custom role signs in and meets
// exactly the panel its permissions open (lib/rbac.js ADMIN_ROUTE_PERMISSIONS is
// the authority; the SPA offers by ui/nav.js `adminCan`, the sidebar by
// ADMIN_NAV_PERMISSIONS, an event workspace's sections by SECTION_PERMISSIONS).
// Every role is made through the real Users & roles routes, by a superadmin.
//
//   * a role that may not read events ("Support desk": people and sign-in codes)
//     lands on its first page, never on Events: no events read, no events poll,
//     no "Could not load events." and NO refused request at all (each would count
//     towards the address's scanner block) — beside a control role that may read
//     events and does land on Events with the poll running;
//   * its row menu offers the sign-in-code doors it holds and nothing it does
//     not (no Block, Approve, Delete, Edit Profile, tag or group controls, no
//     Invite, At the desk or Export, no row checkbox), with a superadmin control
//     on the same row;
//   * a role that only reads the challenge library, or groups, gets no write
//     door there (superadmin controls);
//   * Audit's event filter reads events only with `events.view` and lists them
//     in the shared picker order (live first);
//   * the account menu names the custom role by its label, and the holder
//     switches to Participant View and back, also after a reload;
//   * a role that may only view events gets a read-only workspace: only the
//     sections it may read (tabs, phone sheet, palette), only the doors it holds
//     (⋯ menu, header, Settings, the event look), and no refused request;
//   * the other direction: a role granted `events.delete` is offered Delete,
//     and the door works;
//   * Analytics runs for a role holding `analytics.view` without the lists that
//     feed its filters (never "check your connection"), and a scoped role
//     without events is told why there is nothing to measure;
//   * `templates.view` alone: the New event page offers no template door and
//     reads nothing it may not;
//   * a regular admin meets an UNSCOPED custom role's row as a privileged
//     account (no tag or group controls, the peer note, by its label), a SCOPED
//     one as manageable — neither offers Impersonate (the route refuses every
//     custom role) — and History and the profile card name the role by its label;
//   * no dialog reads a list its role is refused: the event's Participants
//     section without the board (no Score), Invite without groups or events,
//     Grant Attempts without people, Raw logs without groups, New event and the
//     create form without templates or the challenge library — each beside a
//     role that holds the read and is shown the list;
//   * no dialog offers a write its role is refused: the group Members and Events
//     dialogs, the join-link toggle, Add user with no role to give, a template
//     row without events.clone — each pressed by a role that holds the write;
//   * a name on a board is a link only into a page the role may open, and a
//     press that reaches the link anyway opens nothing;
//   * an organiser's "Search everyone" says what it lists (their other events'
//     people), as do its tip and the empty event's advice, which names only the
//     doors the role is offered.

const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, apiLogin, waitForAdminPage } = require("./helpers");
const { loginViaApi, adminLogin, showAllParticipantColumns, openKebab, viewComp, filterComps, narrowGroupsTable, narrowChallengesTable, narrowPeopleTable } = require("./ui-admin-helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol, grantEventAdmin } = require("./event-admin-helpers");
const { openAccountMenu, openPalette } = require("./chrome-helpers");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

let sa, saCsrf, regAdmin, eaUser;
const R = {};   // roles by key
const U = {};   // holders by key
let comp, partU, freshU, doomed, task, group, liveZ, laterA, capTask, emptyComp, bindTarget, stamp, keeperTpl, refusedTpl, rejudgedTpl;

/** Every /api/ request and every refused (403) answer the page sees. */
function recordTraffic(page) {
  const t = { reads: [], refused: [] };
  page.on("request", (r) => { try { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) t.reads.push(`${r.method()} ${u.pathname}`); } catch (_) { /* not a URL */ } });
  page.on("response", (r) => { try { const u = new URL(r.url()); if (u.pathname.startsWith("/api/") && r.status() === 403) t.refused.push(`${r.request().method()} ${u.pathname}`); } catch (_) { /* not a URL */ } });
  return t;
}
/** The sidebar items the nav builder left showing, in order. */
const navShown = (page) => page.evaluate(() => [...document.querySelectorAll("#admin-sidebar .admin-nav-item[data-tab-id]")]
  .filter((b) => { const li = b.closest("li"); return !b.hidden && !(li && (li.hidden || li.style.display === "none")); })
  .map((b) => b.dataset.tabId));
/** The workspace section tabs offered, in order. */
const wsTabsShown = (page) => page.evaluate(() => [...document.querySelectorAll("#ws-tabs .ws-tab")]
  .filter((b) => !b.hidden && b.style.display !== "none" && b.getClientRects().length).map((b) => b.dataset.section));
/** Every option the palette shows for `query`: [{section, label}]. */
async function paletteOptions(page, query) {
  await page.locator("#cp-input").fill(query);
  return page.evaluate(() => [...document.querySelectorAll("#cp-list .cp-group")].flatMap((g) => {
    const section = g.querySelector(".cp-group-h").textContent.trim();
    return [...g.querySelectorAll(".cp-opt")].map((o) => ({ section, label: o.querySelector(".cp-label").textContent.trim() }));
  }));
}

async function signIn(page, who) {
  await loginViaApi(page, who.email, PARTICIPANT_PASS);
  await page.goto("/");
  await waitForAdminPage(page);
}

test.describe("RBAC — a custom role in the browser", () => {
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
    stamp = Date.now();
    const mkRole = async (key, label, scope_mode, permissions) => {
      const r = await sa.post("/api/admin/roles", { headers: H(saCsrf), data: { label: `${label} ${stamp}`, scope_mode, permissions } });
      expect(r.ok(), `create role ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
      R[key] = (await r.json()).role;
    };
    await mkRole("desk", "Support desk", "all", ["participants.view", "participants.signin_codes"]);
    await mkRole("viewer", "Event viewer", "all", ["events.view"]);
    await mkRole("closer", "Event closer", "all", ["events.view", "events.delete"]);
    await mkRole("analyst", "Analyst", "all", ["events.view", "analytics.view"]);
    await mkRole("scopedAnalyst", "Scoped analyst", "granted", ["analytics.view"]);
    await mkRole("tpl", "Template reader", "all", ["templates.view"]);
    await mkRole("tplMgr", "Template keeper", "all", ["templates.view", "templates.manage"]);
    await mkRole("tplMgrLib", "Template keeper with library", "all", ["templates.view", "templates.manage", "challenges.view"]);
    await mkRole("scopedDesk", "Scoped desk", "granted", ["participants.view"]);
    await mkRole("chReader", "Library reader", "all", ["challenges.view"]);
    await mkRole("grpReader", "Group reader", "all", ["groups.view"]);
    await mkRole("auditor", "Auditor", "all", ["audit.view"]);
    // Each dialog's lists and writes, beside a role holding what the first lacks.
    await mkRole("leadReader", "Lead reader", "all", ["events.view", "participants.view"]);
    await mkRole("scoreReader", "Score reader", "all", ["events.view", "participants.view", "leaderboard.view"]);
    await mkRole("enroller", "Enroller", "all", ["participants.view", "participants.enrol"]);
    await mkRole("fullEnroller", "Full enroller", "all", ["participants.view", "participants.enrol", "groups.view", "events.view"]);
    await mkRole("granter", "Granter", "all", ["challenges.view", "challenges.edit", "events.view"]);
    await mkRole("granterPeople", "Granter with people", "all", ["challenges.view", "challenges.edit", "events.view", "participants.view"]);
    await mkRole("binder", "Group binder", "all", ["groups.view", "participants.enrol"]);
    await mkRole("signage", "Signage", "all", ["events.view", "events.join_link"]);
    await mkRole("signageEdit", "Signage editor", "all", ["events.view", "events.join_link", "events.edit"]);
    await mkRole("keeper", "Keeper", "all", ["users.view", "users.manage"]);          // users.manage: only a superadmin gives it
    await mkRole("keeperPlus", "Keeper plus", "all", ["users.view", "users.manage", "events.view"]);   // may give Event viewer
    await mkRole("creator", "Creator", "all", ["events.view", "events.create"]);
    await mkRole("creatorFull", "Creator full", "all", ["events.view", "events.create", "templates.view", "challenges.view", "challenges.assign"]);
    await mkRole("ranker", "Ranker", "all", ["events.view", "leaderboard.view"]);
    await mkRole("rankerPeople", "Ranker with people", "all", ["events.view", "leaderboard.view", "participants.view"]);
    await mkRole("logReader", "Log reader", "all", ["audit.view", "audit.raw_logs"]);
    await mkRole("logReaderGroups", "Log reader with groups", "all", ["audit.view", "audit.raw_logs", "groups.view"]);
    const give = async (key) => {
      const u = await makeParticipant(sa, saCsrf, `cr${key.toLowerCase()}`);   // lower case: the stored address is folded
      const r = await sa.patch(`/api/admin/users/${u.id}/role`, { headers: H(saCsrf), data: { role: R[key].id } });
      expect(r.ok(), `assign ${key}: ${r.status()} ${await r.text()}`).toBeTruthy();
      U[key] = u;
    };
    for (const k of Object.keys(R)) await give(k);
    regAdmin = await makeParticipant(sa, saCsrf, "craadmin");
    const pr = await sa.post(`/api/admin/participants/${regAdmin.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
    expect(pr.ok(), `promote admin: ${pr.status()}`).toBeTruthy();
    comp = await makeCompetition(sa, saCsrf, "crcomp");
    doomed = await makeCompetition(sa, saCsrf, "crdoomed");
    partU = await makeParticipant(sa, saCsrf, "crpart");
    await enrol(sa, saCsrf, comp.id, [partU.id]);
    // A participant who never signs in: a code is shown at the desk only for one
    // (operator ruling, 14 Nov 2026); partU signs in below.
    freshU = await makeParticipant(sa, saCsrf, "crfresh");
    task = await makeTask(sa, saCsrf, "crtask");
    // For the event pickers' shared order: a LIVE event whose name sorts last
    // alphabetically, and a later upcoming one whose name sorts first.
    liveZ = await makeCompetition(sa, saCsrf, "zzlive");
    laterA = await makeCompetition(sa, saCsrf, "aalater", { start_time: new Date(Date.now() + 2 * 86400e3).toISOString() });
    const gr = await sa.post("/api/admin/groups", { headers: H(saCsrf), data: { name: `CR group ${stamp}` } });
    expect(gr.ok(), `create group: ${gr.status()} ${await gr.text()}`).toBeTruthy();
    const gb = await gr.json();
    group = { id: gb.id || (gb.group && gb.group.id), name: `CR group ${stamp}` };
    expect(group.id, "PRECONDITION: the group exists").toBeTruthy();
    // The group has a member and is bound to `comp`, so its Members dialog has a
    // Remove to offer and its Events dialog a bound event and unbound ones.
    const gm = await sa.post(`/api/admin/groups/${group.id}/members`, { headers: H(saCsrf), data: { userIds: [partU.id] } });
    expect(gm.ok(), `group member: ${gm.status()} ${await gm.text()}`).toBeTruthy();
    const gbind = await sa.post("/api/admin/competitions/assign", { headers: H(saCsrf), data: { groupIds: [group.id], competitionIds: [comp.id] } });
    expect(gbind.ok(), `bind group: ${gbind.status()} ${await gbind.text()}`).toBeTruthy();
    // A capped challenge on the live event (Grant Attempts is offered only where
    // a cap holds), and the participant entered it and opened that challenge, so
    // the board lists them (its clock starts at the first open; opening spends no
    // attempt).
    capTask = await makeTask(sa, saCsrf, "crcap", { attempt_cap: 2 });
    const capAsg = await assignTask(sa, saCsrf, capTask.id, [comp.id]);
    const p = await apiLogin(partU.email, PARTICIPANT_PASS);
    try {
      const sel = await p.api.post("/api/select-competition", { headers: H(p.csrf), data: { competitionId: comp.id } });
      expect(sel.ok(), `PRECONDITION: the participant entered the event: ${sel.status()} ${await sel.text()}`).toBeTruthy();
      const opened = await p.api.get(`/api/tasks/${capAsg.copies[0].task_id}`);
      expect(opened.ok(), `PRECONDITION: the participant opened its challenge: ${opened.status()}`).toBeTruthy();
    } finally { await p.api.dispose(); }
    // A built-in event admin organising `comp` and an event with nobody in it.
    emptyComp = await makeCompetition(sa, saCsrf, "crempty");
    bindTarget = await makeCompetition(sa, saCsrf, "crbind");   // the binder's own target
    eaUser = await makeParticipant(sa, saCsrf, "crea");
    await grantEventAdmin(sa, saCsrf, comp.id, eaUser.id);
    await grantEventAdmin(sa, saCsrf, emptyComp.id, eaUser.id);
    // A template holding one challenge, for the template editor's library door
    // (made here: a later test's superadmin sign-in ends this API session).
    const tplTask = await makeTask(sa, saCsrf, "crtpltask");
    const tplName = `CR keeper tpl ${stamp}`;
    const cr = await sa.post("/api/admin/event-templates", { headers: H(saCsrf), data: {
      name: tplName, description: "", event_kind: "tournament", settings: { duration_minutes: 60 }, task_ids: [tplTask.id],
    } });
    expect(cr.ok(), `PRECONDITION: template: ${cr.status()} ${await cr.text()}`).toBeTruthy();
    keeperTpl = { tplTask, tplName, tplId: (await cr.json()).template.id };
    // A Booth Event template holding two challenges, one of which a `needs:` tag
    // has since made unfit for the kind: the template's save re-judges its whole
    // list and refuses that one, naming it (task_id).
    const keep = await makeTask(sa, saCsrf, "crtplkeep");
    const unfit = await makeTask(sa, saCsrf, "crtplunfit");
    const refusedName = `CR refused tpl ${stamp}`;
    const cr2 = await sa.post("/api/admin/event-templates", { headers: H(saCsrf), data: {
      name: refusedName, description: "", event_kind: "booth", settings: { duration_minutes: 60 }, task_ids: [keep.id, unfit.id],
    } });
    expect(cr2.ok(), `PRECONDITION: booth template: ${cr2.status()} ${await cr2.text()}`).toBeTruthy();
    const tg = await sa.post(`/api/admin/tasks/${unfit.id}/tags`, { headers: H(saCsrf), data: { tag: "needs:desktop" } });
    expect(tg.ok(), `PRECONDITION: the needs: tag: ${tg.status()} ${await tg.text()}`).toBeTruthy();
    refusedTpl = { keep, unfit, name: refusedName, id: (await cr2.json()).template.id };
    // The same shape again, for the note a change of event type answers.
    const keep3 = await makeTask(sa, saCsrf, "crtplkeep3");
    const unfit3 = await makeTask(sa, saCsrf, "crtplunfit3");
    const rejudgedName = `CR rejudged tpl ${stamp}`;
    const cr3 = await sa.post("/api/admin/event-templates", { headers: H(saCsrf), data: {
      name: rejudgedName, description: "", event_kind: "booth", settings: { duration_minutes: 60 }, task_ids: [keep3.id, unfit3.id],
    } });
    expect(cr3.ok(), `PRECONDITION: second booth template: ${cr3.status()} ${await cr3.text()}`).toBeTruthy();
    const tg3 = await sa.post(`/api/admin/tasks/${unfit3.id}/tags`, { headers: H(saCsrf), data: { tag: "needs:desktop" } });
    expect(tg3.ok(), `PRECONDITION: the needs: tag: ${tg3.status()} ${await tg3.text()}`).toBeTruthy();
    rejudgedTpl = { keep: keep3, unfit: unfit3, name: rejudgedName, id: (await cr3.json()).template.id };
  });
  test.afterAll(async () => { if (sa) await sa.dispose(); });

  test("a role that may not read events lands on its first page: no events read, no poll, no refused request", async ({ page }) => {
    const t = recordTraffic(page);
    await showAllParticipantColumns(page);
    // WHICH PANE THE PANEL FIRST PAINTS: the landing itself must choose the
    // role's page, not show Events and re-land once the permissions are re-read.
    await page.addInitScript(() => {
      const seen = () => {
        const page = document.getElementById("admin-page");
        if (!page || !page.classList.contains("active") || window.__firstAdminPane) return;
        const ev = document.getElementById("admin-competitions-tab"), pp = document.getElementById("admin-participants-tab");
        window.__firstAdminPane = ev && getComputedStyle(ev).display !== "none" ? "events" : (pp && getComputedStyle(pp).display !== "none" ? "people" : "other");
      };
      new MutationObserver(seen).observe(document, { subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    });
    await signIn(page, U.desk);
    // Its one page, and the landing is that page, not the Events pane.
    await expect.poll(() => navShown(page), { message: "the sidebar shows only the page the role may use", timeout: 15000 }).toEqual(["admin-participants-tab"]);
    await expect(page.locator("#admin-participants-tab")).toBeVisible();
    await expect(page.locator("#admin-competitions-tab")).toBeHidden();
    await narrowPeopleTable(page, partU.email);   // the People table pages at 30: narrow first
    await expect(page.locator("#admin-participants-body tr", { hasText: partU.email }).first(), "People loaded").toBeVisible({ timeout: 15000 });
    // One snapshot after the positive match (a toast fades).
    expect(await page.locator("#toast-stack").innerText().catch(() => ""), "no load-failure toast").not.toMatch(/Could not load/);
    expect(t.reads.filter((x) => x === "GET /api/admin/competitions"), "no events read").toEqual([]);
    for (const p of ["/api/admin/tasks", "/api/admin/submissions", "/api/admin/leaderboard", "/api/admin/groups", "/api/admin/alerts"]) {
      expect(t.reads.filter((x) => x === `GET ${p}`), `no read of ${p}`).toEqual([]);
    }
    expect(await page.evaluate(() => window.S.adminCompPollInterval), "no events poll runs").toBeNull();
    expect(await page.evaluate(() => window.__firstAdminPane), "the panel's first paint is the role's own page, never Events").toBe("people");
    // Every pane loader asks its own permission before it reads, whoever calls
    // it (a scope change, a session end and the polls all call them).
    const before = t.reads.length;
    await page.evaluate(async () => {
      await Promise.all([window.loadAdminCompetitions(), window.loadAdminTasks(), window.loadAdminSubmissions(), window.loadAdminGroups()]);
      window.loadAdminRankingsTab();
    });
    expect(t.reads.slice(before).filter((x) => /^GET \/api\/admin\/(competitions|tasks|submissions|leaderboard|groups)$/.test(x)), "no loader read what the role may not").toEqual([]);
    expect(t.refused, "the panel sent no request its role is refused").toEqual([]);
    // CONTROL for the recorder: a refused read made here is seen.
    await page.evaluate(() => fetch("/api/admin/competitions"));
    await expect.poll(() => t.refused.length).toBe(1);
  });

  test("control: a role that may read events lands on Events, reads them and runs the events poll", async ({ page }) => {
    const t = recordTraffic(page);
    await signIn(page, U.viewer);
    await expect.poll(() => navShown(page), { timeout: 15000 }).toEqual(["admin-competitions-tab"]);
    await expect(page.locator("#admin-competitions-tab")).toBeVisible();
    await filterComps(page, comp.name);   // the Events table pages at 30: narrow first
    await expect(page.locator("#admin-comp-body tr", { hasText: comp.name }).first()).toBeVisible({ timeout: 15000 });
    expect(t.reads, "the events list was read").toContain("GET /api/admin/competitions");
    expect(await page.evaluate(() => window.S.adminCompPollInterval), "the events poll runs").not.toBeNull();
    // No New Event for a role without events.create, and no refused request.
    await expect(page.locator("#new-competition-btn")).toBeHidden();
    expect(t.refused).toEqual([]);
  });

  test("Support desk's row menu offers the sign-in code doors and nothing it may not do (superadmin control)", async ({ page, browser }) => {
    test.setTimeout(120_000);
    // CONTROL: a superadmin's menu on the same row holds the doors withheld below.
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const sp = await ctx.newPage();
      await showAllParticipantColumns(sp);
      await adminLogin(sp);
      await sp.evaluate(() => window.adminTab(null, "admin-participants-tab"));
      await narrowPeopleTable(sp, freshU.email);
      const srow = sp.locator("#admin-participants-body tr", { hasText: freshU.email }).first();
      await expect(srow).toBeVisible({ timeout: 15000 });
      await expect(srow.locator(".tag-add", { hasText: "+ tag" }), "CONTROL: the superadmin gets the tag control").toHaveCount(1);
      await expect(srow.locator(".tag-add", { hasText: "+ group" }), "CONTROL: and the group control").toHaveCount(1);
      for (const id of ["#invite-participants-btn", "#desk-invite-btn", "#p-export-menu-btn"]) await expect(sp.locator(id), `CONTROL: ${id}`).toBeVisible();
      await expect(srow.locator('td.cb-cell input[type="checkbox"]'), "CONTROL: the row can be selected").toHaveCount(1);
      await openKebab(sp, srow);
      const sk = await sp.locator("#kebab-portal").innerText();
      for (const want of ["Block", "Edit Profile", "Delete", "Show sign-in code"]) expect(sk, `CONTROL: ${want}`).toContain(want);
    } finally { await ctx.close(); }

    const t = recordTraffic(page);
    await showAllParticipantColumns(page);
    await signIn(page, U.desk);
    await narrowPeopleTable(page, freshU.email);
    const row = page.locator("#admin-participants-body tr", { hasText: freshU.email }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row.locator(".tag-add"), "no tag control without participants.edit").toHaveCount(0);
    await expect(row.locator(".tag-x")).toHaveCount(0);
    // The header's doors: Invite and At the desk are participants.enrol, the
    // Export menu export.data or data.import — none of them this role's.
    for (const id of ["#invite-participants-btn", "#desk-invite-btn", "#p-export-menu-btn"]) await expect(page.locator(id), `${id} is not this role's`).toBeHidden();
    await expect(page.locator('#admin-participants-tab [data-help="people.desk"]'), "nor the tip of the hidden At the desk").toBeHidden();
    // A row is selected only for a bulk door, and it holds none.
    await expect(row.locator('td.cb-cell input[type="checkbox"]'), "no row checkbox without a bulk door").toHaveCount(0);
    await expect(page.locator("#select-all-participants"), "nor Select all").toBeHidden();
    await openKebab(page, row);
    const k = await page.locator("#kebab-portal").innerText();
    expect(k).toContain("Show sign-in code");
    expect(k).toContain("Email sign-in code");
    expect(k, "the profile opens read-only").toContain("View Profile");
    for (const gone of ["Edit Profile", "Block", "Approve", "Deny", "Verify", "Delete", "Impersonate", "View as participant", "event admin", "Promote", "Add to event"]) {
      expect(k, `${gone} is not this role's`).not.toContain(gone);
    }
    // A participant who has signed in is only EMAILED a code from the desk, and
    // the menu says so (operator ruling, 14 Nov 2026).
    await page.keyboard.press("Escape");
    await narrowPeopleTable(page, partU.email);
    const signedRow = page.locator("#admin-participants-body tr", { hasText: partU.email }).first();
    await expect(signedRow).toBeVisible({ timeout: 15000 });
    await openKebab(page, signedRow);
    const ks = await page.locator("#kebab-portal").innerText();
    expect(ks, "a signed-in row is offered no shown code").not.toContain("Show sign-in code");
    expect(ks, "…and is told why").toContain("Has signed in before");
    expect(ks, "…keeping the emailed code").toContain("Email sign-in code");
    expect(t.refused).toEqual([]);
  });

  test("the account menu names a custom role, and its holder switches to Participant View and back, also after a reload", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await signIn(page, U.desk);
    let menu = await openAccountMenu(page);
    await expect(menu.locator(".pm-role"), "the role chip is the role's own label").toHaveText(R.desk.label);
    await menu.locator('[data-action="toggle-admin-view"][data-on="false"]').click();
    await expect(page.locator("#main-nav .nav-btn").first(), "participant view").toBeVisible({ timeout: 20000 });
    await expect(page.locator("#admin-page")).toBeHidden();
    menu = await openAccountMenu(page);
    await expect(menu.locator(".pm-role")).toHaveText(R.desk.label);
    await expect(menu.locator('[data-action="toggle-admin-view"][data-on="true"]'), "the way back is offered").toHaveCount(1);
    // A staff browser keeps its own look under a platform lock: an admin role's
    // holder in Participant View is staff, as a built-in admin is.
    expect(await page.evaluate(() => { try { return localStorage.getItem("hck-staff"); } catch (_) { return "n/a"; } }), "this browser counts as staff").toBe("1");
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(page.locator("#main-nav .nav-btn").first()).toBeVisible({ timeout: 20000 });
    menu = await openAccountMenu(page);
    const back = menu.locator('[data-action="toggle-admin-view"][data-on="true"]');
    await expect(back, "still offered after a reload").toHaveCount(1);
    await back.click();
    await waitForAdminPage(page);
    await expect.poll(() => navShown(page), { timeout: 15000 }).toEqual(["admin-participants-tab"]);
    // CONTROL: a participant's browser has no view switch and is not staff.
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const pp = await ctx.newPage();
      await loginViaApi(pp, partU.email, PARTICIPANT_PASS);
      await pp.goto("/");
      await expect(pp.locator("#main-nav .nav-btn").first(), "PRECONDITION: the participant's own view").toBeVisible({ timeout: 20000 });
      const pm = await openAccountMenu(pp);
      await expect(pm.locator('[data-action="toggle-admin-view"]'), "CONTROL: no view switch for a participant").toHaveCount(0);
      expect(await pp.evaluate(() => { try { return localStorage.getItem("hck-staff"); } catch (_) { return "n/a"; } }), "CONTROL: not a staff browser").toBeNull();
    } finally { await ctx.close(); }
  });

  test("a role that may only view events gets a read-only workspace: its sections, its doors, no refused request", async ({ page }) => {
    test.setTimeout(120_000);
    const t = recordTraffic(page);
    await signIn(page, U.viewer);
    await viewComp(page, comp.name);
    await expect.poll(() => wsTabsShown(page), { message: "only the sections events.view reads", timeout: 15000 })
      .toEqual(["admin-event-overview-tab", "admin-event-team-tab", "admin-event-settings-tab"]);
    // The header: no Invite, no join pill; the ⋯ menu holds only the reads.
    await expect(page.locator('#ws-quick [data-action="ws-invite"]')).toHaveCount(0);
    await expect(page.locator(".ws-join-pill")).toHaveCount(0);
    await page.locator("#ws-quick .ws-more-btn").click();
    await expect(page.locator("#kebab-portal")).toBeVisible();
    const items = await page.locator("#kebab-portal [data-action]").evaluateAll((els) => els.map((e) => e.dataset.action));
    expect(items, "only the doors events.view opens").toEqual(["comp-history", "comp-organisers", "comp-delivery"]);
    await page.keyboard.press("Escape");
    // The palette inherits the same gates (Invite and every workspace write).
    await openPalette(page);
    const acts = (await paletteOptions(page, "")).filter((o) => o.section === "Actions").map((o) => o.label);
    for (const gone of ["Invite people", "Edit settings", "Clone", "Export everything", "Add from bank", "Sign up at the desk", "Join-link settings", "Save as template", "New event", "New question"]) {
      expect(acts, `${gone} is not this role's`).not.toContain(gone);
    }
    expect(acts, "POSITIVE: the read doors are listed").toContain("History");
    const go = (await paletteOptions(page, "")).filter((o) => o.section === "Go to").map((o) => o.label);
    for (const gone of ["Participants", "Challenges", "Rankings", "Activity", "Analytics", "Certificates"]) expect(go, `${gone} section is not offered`).not.toContain(gone);
    await page.keyboard.press("Escape");
    // Settings: read-only, said so, and no Save look.
    await page.locator('#ws-tabs [data-section="admin-event-settings-tab"]').click();
    await expect(page.locator("#admin-event-settings-tab")).toContainText("Your role can view this event's settings, not change them.");
    await expect(page.locator('#admin-event-settings-tab [data-action="comp-edit"]')).toHaveCount(0);
    await expect(page.locator('#admin-event-settings-tab [data-action="event-look-save"]')).toHaveCount(0);
    // The Events row menu asks the same permissions.
    await page.locator("#ws-record [data-action='scope-clear'], [data-action='scope-clear']").first().click();
    const row = page.locator("#admin-comp-body tr", { hasText: comp.name }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await openKebab(page, row);
    const rowItems = await page.locator("#kebab-portal [data-action]").evaluateAll((els) => els.map((e) => e.dataset.action));
    for (const gone of ["comp-edit", "comp-assign-challenges", "comp-manage-participants", "comp-self-enroll", "comp-end-now", "comp-delete", "comp-export-activity"]) {
      expect(rowItems, `${gone} is not offered`).not.toContain(gone);
    }
    for (const p of ["/api/admin/submissions", "/api/admin/leaderboard", "/api/admin/tasks", "/api/admin/participants"]) {
      expect(t.reads.filter((x) => x === `GET ${p}`), `the workspace read no ${p}`).toEqual([]);
    }
    expect(t.refused, "no refused request").toEqual([]);
  });

  test("a role granted events.delete is offered Delete, and the door works", async ({ page }) => {
    test.setTimeout(120_000);
    const t = recordTraffic(page);
    await signIn(page, U.closer);
    await filterComps(page, doomed.name);
    const row = page.locator("#admin-comp-body tr", { hasText: doomed.name }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await openKebab(page, row);
    const del = page.locator('#kebab-portal [data-action="comp-delete"]');
    await expect(del, "the permission it was granted is offered").toHaveCount(1);
    await expect(page.locator('#kebab-portal [data-action="comp-edit"]'), "control: no Edit without events.edit").toHaveCount(0);
    await del.click();
    const box = page.locator("#modal-overlay.open");
    await expect(box).toBeVisible();
    await expect(box).toContainText("Delete Event");
    await page.locator("#modal-confirm-btn").click();
    // Read through the holder's own session (events.view): the built-in
    // superadmin's API session ends whenever a browser signs it in elsewhere.
    await expect.poll(async () => { const l = await (await page.request.get("/api/admin/competitions")).json(); return Array.isArray(l) && !l.some((c) => c.id === doomed.id) && l.some((c) => c.id === comp.id); },
      { message: "the event is gone server-side (and the list read is real: the other event is still there)", timeout: 15000 }).toBe(true);
    expect(t.refused).toEqual([]);
  });

  test("Analytics runs for a role holding analytics.view without the filter lists; a scoped role with no events is told why", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const t = recordTraffic(page);
    await signIn(page, U.analyst);
    await expect.poll(() => navShown(page), { timeout: 15000 }).toEqual(["admin-competitions-tab", "admin-analytics-tab"]);
    await page.locator('button.admin-nav-item[data-tab-id="admin-analytics-tab"]').click();
    await expect(page.locator("#analytics-summary")).toContainText("Choose what to measure", { timeout: 15000 });
    await expect(page.locator("#admin-analytics-tab"), "never blames the connection").not.toContainText("Check your connection");
    for (const p of ["/api/admin/tasks", "/api/admin/tags", "/api/admin/groups"]) expect(t.reads.filter((x) => x === `GET ${p}`), `no read of ${p}`).toEqual([]);
    const q = page.waitForResponse((r) => r.url().includes("/api/admin/analytics/challenges"));
    await page.locator('#analytics-summary [data-action="analytics-set-scope"][data-value="global"]').click();
    expect((await q).status(), "the role's own query runs").toBe(200);
    await expect(page.locator("#analytics-table-card")).toBeVisible();
    expect(t.refused).toEqual([]);

    // A role scoped to its events, holding analytics but not events: told why.
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const sp = await ctx.newPage();
      const t2 = recordTraffic(sp);
      await signIn(sp, U.scopedAnalyst);
      await expect.poll(() => navShown(sp), { timeout: 15000 }).toEqual(["admin-analytics-tab"]);
      await expect(sp.locator("#admin-analytics-tab"), "the landing is Analytics, and it says why there is nothing to measure")
        .toContainText("Your role can see analytics but not events", { timeout: 15000 });
      expect(t2.refused).toEqual([]);
    } finally { await ctx.close(); }
  });

  test("templates.view alone: the New event page offers no template door and reads nothing it may not (superadmin control)", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const sp = await ctx.newPage();
      await adminLogin(sp);
      await sp.evaluate(() => window.adminTab(null, "admin-templates-tab"));
      await expect(sp.locator("#tpl-new-btn"), "CONTROL: the superadmin gets New template").toBeVisible({ timeout: 15000 });
      await expect(sp.locator(".tpl-kind").first(), "CONTROL: and the blank starters").toBeVisible();
      await expect(sp.locator(".tpl-row-more").first(), "CONTROL: and each row's menu").toBeVisible();
      expect(await sp.locator("#tpl-list .tpl-row .card-open").count(), "CONTROL: and each row starts an event").toBeGreaterThan(0);
      await expect(sp.locator("#tpl-no-start")).toHaveCount(0);
    } finally { await ctx.close(); }

    const t = recordTraffic(page);
    await signIn(page, U.tpl);
    await expect.poll(() => navShown(page), { timeout: 15000 }).toEqual(["admin-templates-tab"]);
    await expect(page.locator("#admin-templates-tab")).toBeVisible();
    const firstRow = page.locator("#tpl-list .tpl-row").first();
    await expect(firstRow, "the templates it may see are listed").toBeVisible({ timeout: 15000 });
    await expect(page.locator("#tpl-new-btn")).toBeHidden();
    await expect(page.locator(".tpl-kind"), "no blank starter without events.create").toHaveCount(0);
    await expect(page.locator(".tpl-row-more"), "no template menu without templates.manage").toHaveCount(0);
    await expect(page.locator("#tpl-deleted")).toBeHidden();
    // Starting an event from a template is a spawn (events.clone): the rows list
    // the templates and are no door, and the list says why once.
    await expect(page.locator("#tpl-no-start"), "the reason is said").toContainText("not start events from them");
    await expect(page.locator("#tpl-list .card-open"), "no start button on any row").toHaveCount(0);
    await expect(page.locator('#tpl-list [data-action="tpl-pick"]'), "no row is a door").toHaveCount(0);
    const before = t.reads.length;
    await firstRow.locator(".tpl-row-main").click();
    await expect(page.locator("#tpl-spin"), "pressing a row opens nothing").toBeHidden();
    expect(await page.locator("#toast-stack").innerText().catch(() => ""), "and refuses nothing").not.toMatch(/cannot start an event/);
    expect(t.reads.slice(before), "and asks nothing").toEqual([]);
    expect(t.reads.filter((x) => x === "GET /api/admin/event-templates/deleted"), "no read of the deleted templates").toEqual([]);
    expect(t.refused).toEqual([]);
  });

  test("the template editor reads the challenge library only with challenges.view: without it, the template's own challenges with Remove but no picker, said why, and Save keeps them (a role holding it: control)", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const { tplTask, tplName, tplId } = keeperTpl;
    const openEditor = async (pg) => {
      await expect.poll(() => navShown(pg), { timeout: 15000 }).toContain("admin-templates-tab");
      await pg.locator('button.admin-nav-item[data-tab-id="admin-templates-tab"]').click();
      const row = pg.locator("#tpl-list .tpl-row", { hasText: tplName });
      await expect(row).toHaveCount(1, { timeout: 15000 });
      await row.locator(".tpl-row-more").click();
      await expect(pg.locator("#kebab-portal.open")).toBeVisible();
      await pg.locator('#kebab-portal [data-action="tpl-edit"]').click();
      const ed = pg.locator("#tpl-editor");
      await expect(ed.locator("#tpl-ed-name"), "the editor opens on the template").toHaveValue(tplName, { timeout: 15000 });
      return ed;
    };
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const cp = await ctx.newPage();
      const ct = recordTraffic(cp);
      await signIn(cp, U.tplMgrLib);
      const ced = await openEditor(cp);
      await expect(ced.locator("#tpl-ed-task-search"), "CONTROL: the picker is offered").toBeVisible();
      await expect(ced.locator(`[data-tpl-task="${tplTask.id}"][data-op="remove"]`), "CONTROL: and each challenge can be removed").toBeVisible();
      await expect(ced.locator("#tpl-ed-task-unseen")).toHaveCount(0);
      await expect.poll(() => ct.reads.includes("GET /api/admin/tasks"), { message: "CONTROL: the library was read" }).toBe(true);
      expect(ct.refused).toEqual([]);
    } finally { await ctx.close(); }

    const t = recordTraffic(page);
    await signIn(page, U.tplMgr);
    const ed = await openEditor(page);
    await expect(ed.locator("#tpl-ed-task-unseen"), "the editor says why no challenge can be added")
      .toHaveText("Your role cannot view the challenge library, so it cannot add challenges here. The template keeps the challenges listed above unless you remove them.");
    await expect(ed.locator("#tpl-ed-tasks .tpl-ed-task-title"), "the template's own challenge is listed").toHaveText([tplTask.title]);
    await expect(ed.locator("#tpl-ed-task-search"), "no picker").toHaveCount(0);
    await expect(ed.locator('[data-tpl-task][data-op="remove"]'), "Remove needs no library read, so it stays").toHaveCount(1);
    await ed.locator("#tpl-ed-duration").fill("45");
    await ed.locator('button[type="submit"]').click();
    await expect(ed, "the save went through").toHaveCount(0, { timeout: 15000 });
    const { api: sa2 } = await apiLogin("superadmin");
    let back;
    try { back = await (await sa2.get(`/api/admin/event-templates/${tplId}`)).json(); } finally { await sa2.dispose(); }
    expect(back.template.settings.duration_minutes, "the change was stored").toBe(45);
    expect(back.template.tasks.map((x) => x.id), "the template kept its challenge").toEqual([tplTask.id]);
    expect(t.reads.filter((x) => x === "GET /api/admin/tasks"), "no library read").toEqual([]);
    expect(t.refused, "no refused request").toEqual([]);
  });

  test("without challenges.view, a challenge the template's save refuses is named on its row, and its Remove takes it out so the template saves (the other challenge: control)", async ({ page }) => {
    test.setTimeout(120_000);
    const { keep, unfit, name, id } = refusedTpl;
    const t = recordTraffic(page);
    await signIn(page, U.tplMgr);
    await expect.poll(() => navShown(page), { timeout: 15000 }).toContain("admin-templates-tab");
    await page.locator('button.admin-nav-item[data-tab-id="admin-templates-tab"]').click();
    const row = page.locator("#tpl-list .tpl-row", { hasText: name });
    await expect(row).toHaveCount(1, { timeout: 15000 });
    await row.locator(".tpl-row-more").click();
    await expect(page.locator("#kebab-portal.open")).toBeVisible();
    await page.locator('#kebab-portal [data-action="tpl-edit"]').click();
    const ed = page.locator("#tpl-editor");
    await expect(ed.locator("#tpl-ed-name"), "the editor opens on the template").toHaveValue(name, { timeout: 15000 });
    await expect(ed.locator("#tpl-ed-task-unseen"), "PRECONDITION: the role reads no library").toBeVisible();
    const item = (task) => ed.locator("#tpl-ed-tasks .tpl-ed-task", { hasText: task.title });
    await expect(item(unfit), "PRECONDITION: both challenges listed").toHaveCount(1);
    await expect(item(keep)).toHaveCount(1);
    await expect(ed.locator("#tpl-ed-tasks .tpl-ed-why"), "no reason before a save").toHaveCount(0);
    // The save re-judges the list and refuses the unfit challenge by id.
    const refused = page.waitForResponse((r) => r.url().endsWith(`/api/admin/event-templates/${id}`) && r.request().method() === "PUT");
    await ed.locator('button[type="submit"]').click();
    const ans = await refused;
    expect(ans.status(), "PRECONDITION: the save was refused").toBe(400);
    const body = await ans.json();
    expect(body.task_id, "PRECONDITION: the refusal names the unfit challenge").toBe(unfit.id);
    await expect(ed.locator("#tpl-ed-err"), "the refusal is said").toHaveText(body.error);
    await expect(item(unfit).locator(".tpl-ed-why"), "and on the challenge it names, with the remedy").toHaveText(`${body.error} Remove it to save.`);
    await expect(item(keep).locator(".tpl-ed-why"), "CONTROL: not on the other challenge").toHaveCount(0);
    await item(unfit).locator('[data-op="remove"]').click();
    await expect(item(unfit), "Remove took it out").toHaveCount(0);
    await expect(ed.locator("#tpl-ed-tasks .tpl-ed-why"), "and its reason with it").toHaveCount(0);
    await ed.locator('button[type="submit"]').click();
    await expect(ed, "the save went through").toHaveCount(0, { timeout: 15000 });
    const { api: sa2 } = await apiLogin("superadmin");
    let back;
    try { back = await (await sa2.get(`/api/admin/event-templates/${id}`)).json(); } finally { await sa2.dispose(); }
    expect(back.template.tasks.map((x) => x.id), "the template keeps the other challenge and not the removed one").toEqual([keep.id]);
    expect(t.reads.filter((x) => x === "GET /api/admin/tasks"), "no library read").toEqual([]);
    expect(t.refused, "no 403").toEqual([]);
  });

  // The note answers the form as it was saved: an event type the challenge fits
  // answers it, so it goes, and the save that follows keeps both challenges. A
  // change the list is not judged against (the name) leaves it: control.
  test("the save's note on a challenge row goes when the event type changes (a name change keeps it: control), and the template then saves with it", async ({ page }) => {
    test.setTimeout(120_000);
    const { keep, unfit, name, id } = rejudgedTpl;
    await signIn(page, U.tplMgr);
    await expect.poll(() => navShown(page), { timeout: 15000 }).toContain("admin-templates-tab");
    await page.locator('button.admin-nav-item[data-tab-id="admin-templates-tab"]').click();
    const row = page.locator("#tpl-list .tpl-row", { hasText: name });
    await expect(row).toHaveCount(1, { timeout: 15000 });
    await row.locator(".tpl-row-more").click();
    await expect(page.locator("#kebab-portal.open")).toBeVisible();
    await page.locator('#kebab-portal [data-action="tpl-edit"]').click();
    const ed = page.locator("#tpl-editor");
    await expect(ed.locator("#tpl-ed-name"), "the editor opens on the template").toHaveValue(name, { timeout: 15000 });
    await expect(ed.locator("#tpl-ed-kind"), "PRECONDITION: a Booth Event template").toHaveValue("booth");
    const item = (task) => ed.locator("#tpl-ed-tasks .tpl-ed-task", { hasText: task.title });
    const refused = page.waitForResponse((r) => r.url().endsWith(`/api/admin/event-templates/${id}`) && r.request().method() === "PUT");
    await ed.locator('button[type="submit"]').click();
    const ans = await refused;
    expect(ans.status(), "PRECONDITION: the save was refused").toBe(400);
    const body = await ans.json();
    expect(body.task_id, "PRECONDITION: the refusal names the unfit challenge").toBe(unfit.id);
    await expect(item(unfit).locator(".tpl-ed-why"), "PRECONDITION: the note is on its row").toHaveText(`${body.error} Remove it to save.`);
    // CONTROL: a change the list is not judged against leaves the note.
    const renamed = `${name} renamed`;
    await ed.locator("#tpl-ed-name").fill(renamed);
    await ed.locator("#tpl-ed-name").press("Tab");
    await expect(item(unfit).locator(".tpl-ed-why"), "CONTROL: a name change keeps the note").toHaveText(`${body.error} Remove it to save.`);
    // A Competition may hold a challenge that needs a desktop: the note goes.
    await ed.locator("#tpl-ed-kind").selectOption("tournament");
    await expect(ed.locator("#tpl-ed-tasks .tpl-ed-why"), "the event type answered it, so no row says Remove it to save").toHaveCount(0);
    await expect(item(unfit), "the challenge is still listed").toHaveCount(1);
    await expect(item(keep)).toHaveCount(1);
    await ed.locator('button[type="submit"]').click();
    await expect(ed, "the save went through").toHaveCount(0, { timeout: 15000 });
    const { api: sa2 } = await apiLogin("superadmin");
    let back;
    try { back = await (await sa2.get(`/api/admin/event-templates/${id}`)).json(); } finally { await sa2.dispose(); }
    expect(back.template.event_kind, "saved as a Competition").toBe("tournament");
    expect(back.template.tasks.map((x) => x.id).sort(), "keeping both challenges").toEqual([keep.id, unfit.id].sort());
  });

  test("a regular admin meets an unscoped custom role as a privileged account and a scoped one as manageable, by label; History names it", async ({ page }) => {
    test.setTimeout(120_000);
    const t = recordTraffic(page);
    await showAllParticipantColumns(page);
    await signIn(page, regAdmin);
    await page.evaluate(() => window.adminTab(null, "admin-participants-tab"));
    await page.locator("#p-include-admins").check();
    await narrowPeopleTable(page, U.desk.email);
    const all = page.locator("#admin-participants-body tr", { hasText: U.desk.email }).first();
    await expect(all, "PRECONDITION: the unscoped holder is listed with admin accounts shown").toBeVisible({ timeout: 15000 });
    await expect(all.locator('td[data-pcol="role"]'), "the role cell names the custom role").toContainText(R.desk.label);
    await expect(all.locator('td[data-pcol="role"]')).not.toContainText("Participant");
    await expect(all.locator(".tag-add"), "no tag control on an unscoped admin account").toHaveCount(0);
    await expect(all.locator(".chip-note").first(), "the reason is said").toBeVisible();
    await openKebab(page, all);
    let k = await page.locator("#kebab-portal").innerText();
    expect(k).toContain(`${R.desk.label} account — only superadmins can manage it`);
    for (const gone of ["Block", "Email sign-in code", "Impersonate", "View as participant"]) expect(k, `${gone} on an unscoped admin`).not.toContain(gone);
    await page.keyboard.press("Escape");
    // The profile card names the custom role by its label too, never its id.
    await all.locator('.action-cell [data-action="participant-view-profile"]').click();
    const card = page.locator("#profile-card-overlay");
    await expect(card.locator(".pc-role"), "the card's role chip is the role's label").toHaveText(R.desk.label, { timeout: 15000 });
    await expect(card, "never the role's id").not.toContainText(R.desk.id);
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    // CONTROL: a participant's card says Participant.
    await narrowPeopleTable(page, partU.email);
    const prow = page.locator("#admin-participants-body tr", { hasText: partU.email }).first();
    await expect(prow).toBeVisible({ timeout: 15000 });
    await prow.locator('.action-cell [data-action="participant-view-profile"]').click();
    await expect(card.locator(".pc-role"), "CONTROL: a built-in role keeps its own name").toHaveText("Participant", { timeout: 15000 });
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);

    await narrowPeopleTable(page, U.scopedDesk.email);
    const scoped = page.locator("#admin-participants-body tr", { hasText: U.scopedDesk.email }).first();
    await expect(scoped).toBeVisible();
    await expect(scoped.locator('td[data-pcol="role"]')).toContainText(R.scopedDesk.label);
    await expect(scoped.locator(".tag-add", { hasText: "+ tag" }), "CONTROL: a scoped role's account is manageable").toHaveCount(1);
    await expect(scoped.locator(".tag-add", { hasText: "+ group" })).toHaveCount(1);
    await openKebab(page, scoped);
    k = await page.locator("#kebab-portal").innerText();
    expect(k, "CONTROL: Block is offered on it").toContain("Block");
    expect(k, "but never Impersonate: the route refuses every custom role").not.toMatch(/Impersonate|View as participant/);
    // History: the role change names the role by its label.
    await page.locator('#kebab-portal [data-action="participant-history"]').click();
    await expect(page.locator("#hist-overlay")).toContainText(`${R.scopedDesk.label} (custom role)`, { timeout: 15000 });
    await expect(page.locator("#hist-overlay")).not.toContainText(R.scopedDesk.id);
    expect(t.refused).toEqual([]);
  });

  test("a role that may only read the challenge library gets no write door on it (superadmin control)", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const findRow = async (pg) => {
      await narrowChallengesTable(pg, task.title);
      const r = pg.locator("#admin-task-body tr", { hasText: task.title }).first();
      await expect(r, "PRECONDITION: the challenge is listed").toBeVisible({ timeout: 15000 });
      return r;
    };
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const sp = await ctx.newPage();
      await adminLogin(sp);
      await sp.evaluate(() => window.adminTab(null, "admin-tasks-tab"));
      const srow = await findRow(sp);
      await expect(sp.locator('#new-task-btn-row [data-action="open-task-form"]'), "CONTROL: New challenge").toBeVisible();
      await expect(sp.locator("#export-tasks-btn"), "CONTROL: Export").toBeVisible();
      await expect(srow.locator('td.cb-cell input[type="checkbox"]'), "CONTROL: the row can be selected to assign").toHaveCount(1);
      await openKebab(sp, srow);
      const sk = await sp.locator("#kebab-portal").innerText();
      for (const want of ["Edit", "Delete"]) expect(sk, `CONTROL: ${want}`).toContain(want);   // stage B: assigning is the selection bar's Add to events (the box above)
    } finally { await ctx.close(); }

    const t = recordTraffic(page);
    await signIn(page, U.chReader);
    await expect.poll(() => navShown(page), { timeout: 15000 }).toEqual(["admin-tasks-tab"]);
    const row = await findRow(page);
    await expect(page.locator('#new-task-btn-row [data-action="open-task-form"]'), "no New challenge without challenges.edit").toBeHidden();
    await expect(page.locator("#import-tasks-btn")).toBeHidden();
    await expect(page.locator("#export-tasks-btn"), "no Export without export.data").toBeHidden();
    await expect(row.locator('td.cb-cell input[type="checkbox"]'), "nothing to select for: no assign").toHaveCount(0);
    await expect(page.locator("#select-all-challenges")).toBeHidden();
    await openKebab(page, row);
    const items = await page.locator("#kebab-portal [data-action]").evaluateAll((els) => els.map((e) => e.dataset.action));
    expect(items, "POSITIVE: the reads stay").toContain("task-history");
    for (const gone of ["task-edit", "task-publish", "task-toggle-visibility", "task-assign-to-comps", "task-attempt-grant", "task-toggle-lock", "task-recalculate", "task-delete"]) {
      expect(items, `${gone} is not this role's`).not.toContain(gone);
    }
    expect(t.refused, "no refused request").toEqual([]);
  });

  test("a role that may only read groups opens Members and Events read-only, with no New Group, Rename or Delete (superadmin control)", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const findRow = async (pg) => {
      await narrowGroupsTable(pg, group.name);   // v9.2.4 — waits out the re-render a press could straddle
      const r = pg.locator("#groups-tbody tr", { hasText: group.name }).first();
      await expect(r, "PRECONDITION: the group is listed").toBeVisible({ timeout: 15000 });
      return r;
    };
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const sp = await ctx.newPage();
      await adminLogin(sp);
      await sp.evaluate(() => window.adminTab(null, "admin-groups-tab"));
      const srow = await findRow(sp);
      await expect(sp.locator('#admin-groups-tab [data-action="group-create"]'), "CONTROL: New Group").toBeVisible();
      for (const a of ["group-rename", "group-delete"]) await expect(srow.locator(`[data-action="${a}"]`), `CONTROL: ${a}`).toHaveCount(1);
      // CONTROL: the dialogs' writes, for a role that holds them.
      await srow.locator('[data-action="group-manage-members"]').click();
      await expect(sp.locator("#gm-add"), "CONTROL: Add Selected").toBeVisible({ timeout: 15000 });
      await expect(sp.locator("[data-rm]"), "CONTROL: Remove on the member").toHaveCount(1);
      await sp.locator("#gm-close").click();
      await srow.locator('[data-action="group-bind-comps"]').click();
      await expect(sp.locator("#gc-save"), "CONTROL: Save").toBeVisible({ timeout: 15000 });
      expect(await sp.locator(".gc-cb:not([disabled])").count(), "CONTROL: boxes the superadmin may change").toBeGreaterThan(1);
      await expect(sp.locator("#gc-perm-note")).toHaveCount(0);
    } finally { await ctx.close(); }

    const t = recordTraffic(page);
    await signIn(page, U.grpReader);
    await expect.poll(() => navShown(page), { timeout: 15000 }).toEqual(["admin-groups-tab"]);
    const row = await findRow(page);
    await expect(page.locator('#admin-groups-tab [data-action="group-create"]'), "no New Group without groups.manage").toBeHidden();
    for (const a of ["group-rename", "group-delete"]) await expect(row.locator(`[data-action="${a}"]`), `${a} is not this role's`).toHaveCount(0);
    // Members: the membership is read (groups.view) — and offered read-only, with
    // why: adding and removing are groups.manage routes.
    await row.locator('[data-action="group-manage-members"]').click();
    await expect(page.locator("#gm-readonly-note"), "the dialog says it is read-only, and why").toContainText("Your role can see this group's members", { timeout: 15000 });
    await expect(page.locator("#gm-members"), "POSITIVE: the member is listed").toContainText(partU.email);
    await expect(page.locator("#gm-add"), "no Add Selected").toHaveCount(0);
    await expect(page.locator("[data-rm]"), "no Remove").toHaveCount(0);
    await expect(page.locator("#gm-search"), "no search for people to add").toHaveCount(0);
    await page.locator("#gm-close").click();
    // Events: which events the group is in (a read), nothing it could change.
    await row.locator('[data-action="group-bind-comps"]').click();
    await expect(page.locator("#gc-perm-note"), "the dialog says why nothing can change").toContainText("not change them", { timeout: 15000 });
    await expect(page.locator(`#gc-list .gc-cb[value="${comp.id}"]`), "POSITIVE: the bound event is shown ticked").toBeChecked();
    expect(await page.locator(".gc-cb").count(), "PRECONDITION: events are listed").toBeGreaterThan(1);
    await expect(page.locator(".gc-cb:not([disabled])"), "every box is disabled").toHaveCount(0);
    await expect(page.locator("#gc-save"), "no Save").toHaveCount(0);
    await page.locator("#gc-close").click();
    expect(t.refused, "no refused request").toEqual([]);
    expect(t.reads, "POSITIVE: the dialogs' reads ran").toEqual(expect.arrayContaining([`GET /api/admin/groups/${group.id}/picker`, `GET /api/admin/groups/${group.id}/competitions`]));
  });

  test("a role that may bind groups to events but not change groups: only unbound events can be ticked, and Save works", async ({ page }) => {
    test.setTimeout(120_000);
    const t = recordTraffic(page);
    await signIn(page, U.binder);
    await expect.poll(() => navShown(page), { timeout: 15000 }).toContain("admin-groups-tab");
    // v9.2.4 — Groups is this role's only page, so the landing has opened it (and
    // started its load); opening it again would start a second load that could
    // land after the typing below and replace the row mid-press.
    if (!(await page.locator("#admin-groups-tab").isVisible())) await page.evaluate(() => window.adminTab(null, "admin-groups-tab"));
    await narrowGroupsTable(page, group.name);   // v9.2.4 — waits out the re-render a press could straddle
    const row = page.locator("#groups-tbody tr", { hasText: group.name }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.locator('[data-action="group-bind-comps"]').click();
    await expect(page.locator("#gc-perm-note"), "the half it may not do is named").toContainText("can add this group to an event, not take it off one", { timeout: 15000 });
    // Taking it off `comp` is groups.manage: that box is ticked and disabled…
    const bound = page.locator(`#gc-list .gc-cb[value="${comp.id}"]`);
    await expect(bound).toBeChecked();
    await expect(bound).toBeDisabled();
    // …adding it is participants.enrol: an unbound event's box can be ticked.
    const unbound = page.locator(`#gc-list .gc-cb[value="${bindTarget.id}"]`);
    await expect(unbound, "CONTROL: the bind half is offered").toBeEnabled();
    await unbound.check();
    const saved = page.waitForResponse((r) => r.url().endsWith("/api/admin/competitions/assign") && r.request().method() === "POST");
    await page.locator("#gc-save").click();
    expect((await saved).status(), "the bind it offered is the bind the server makes").toBe(200);
    expect(t.refused, "no refused request").toEqual([]);
  });

  test("Audit: its event filter reads events only with events.view, and lists them live first (superadmin control)", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const sp = await ctx.newPage();
      await adminLogin(sp);
      await sp.evaluate(() => window.adminTab(null, "admin-audit-tab"));
      const opts = sp.locator("#audit-event option");
      await expect.poll(() => opts.count(), { message: "CONTROL: the events are listed", timeout: 15000 }).toBeGreaterThan(2);
      const names = await opts.allInnerTexts();
      const iLive = names.indexOf(liveZ.name), iLater = names.indexOf(laterA.name);
      expect(iLive, "PRECONDITION: both events listed").toBeGreaterThan(0);
      expect(iLater).toBeGreaterThan(0);
      expect(iLive, "the shared picker order: the live event first, though its name sorts last").toBeLessThan(iLater);
    } finally { await ctx.close(); }

    const t = recordTraffic(page);
    await signIn(page, U.auditor);
    await expect.poll(() => navShown(page), { timeout: 15000 }).toEqual(["admin-audit-tab"]);
    await expect(page.locator("#admin-audit-tab #audit-view-trail"), "the Audit page is the landing").toBeVisible({ timeout: 15000 });
    await expect(page.locator("#audit-event option"), "only All events: there is no event list to read").toHaveText(["All events"]);
    expect(t.reads.filter((x) => x === "GET /api/admin/competitions"), "no events read").toEqual([]);
    expect(t.reads, "POSITIVE: the trail itself was read").toContain("GET /api/admin/audit");
    expect(t.refused, "no refused request").toEqual([]);
  });

  test("an event's Participants section reads no board without leaderboard.view, and offers no Score (a role with it: control)", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const cp = await ctx.newPage();
      const ct = recordTraffic(cp);
      await showAllParticipantColumns(cp);
      await signIn(cp, U.scoreReader);
      await viewComp(cp, comp.name);
      await cp.locator('#ws-tabs [data-section="admin-participants-tab"]').click();
      await narrowPeopleTable(cp, partU.email);   // the People table pages at 30: narrow first
      const crow = cp.locator("#admin-participants-body tr", { hasText: partU.email }).first();
      await expect(crow, "PRECONDITION: the event's participant is listed").toBeVisible({ timeout: 15000 });
      await expect(crow.locator('td[data-pcol="score"]'), "CONTROL: the Score column shows the board's score").toHaveText("0", { timeout: 15000 });
      expect(ct.reads, "CONTROL: the board was read").toContain("GET /api/admin/leaderboard");
      expect(ct.refused).toEqual([]);
    } finally { await ctx.close(); }

    const t = recordTraffic(page);
    await showAllParticipantColumns(page);   // every column asked for: only the role can take Score away
    await signIn(page, U.leadReader);
    await viewComp(page, comp.name);
    await page.locator('#ws-tabs [data-section="admin-participants-tab"]').click();
    await narrowPeopleTable(page, partU.email);   // the People table pages at 30: narrow first
    const row = page.locator("#admin-participants-body tr", { hasText: partU.email }).first();
    await expect(row, "PRECONDITION: the event's participant is listed").toBeVisible({ timeout: 15000 });
    await expect(page.locator('#p-table th[data-pcol="score"]'), "no Score column without the board").toBeHidden();
    await expect(row.locator('td[data-pcol="score"]')).toBeHidden();
    await expect(row.locator('td[data-pcol="company"]'), "CONTROL: the other columns asked for are shown").toBeVisible();
    await page.locator("#p-columns-btn").click();
    await expect(page.locator("#p-columns-pop"), "the Columns menu says why").toContainText("(your role cannot see scores)");
    await page.keyboard.press("Escape");
    // A re-render (another search) reads no board either.
    await narrowPeopleTable(page, partU.nickname);
    await expect(page.locator("#admin-participants-body"), "the re-rendered table still lists them").toContainText(partU.nickname);
    expect(t.reads.filter((x) => x === "GET /api/admin/leaderboard"), "no board read").toEqual([]);
    expect(t.refused, "no refused request").toEqual([]);
  });

  test("Invite reads only the lists its role may: without groups or events it says so (a role holding both: control)", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const cp = await ctx.newPage();
      const ct = recordTraffic(cp);
      await signIn(cp, U.fullEnroller);
      await cp.evaluate(() => window.adminTab(null, "admin-participants-tab"));
      await cp.locator("#invite-participants-btn").click();
      await expect(cp.locator("#invite-group-list"), "CONTROL: the groups are listed").toContainText(group.name, { timeout: 15000 });
      await expect(cp.locator(".invite-comp-list"), "CONTROL: and the events").toContainText(comp.name);
      expect(ct.reads, "CONTROL: the group list was read").toContain("GET /api/admin/groups");
      expect(ct.refused).toEqual([]);
    } finally { await ctx.close(); }

    const t = recordTraffic(page);
    await signIn(page, U.enroller);
    await expect(page.locator("#invite-participants-btn"), "PRECONDITION: Invite is this role's").toBeVisible({ timeout: 15000 });
    await page.locator("#invite-participants-btn").click();
    await expect(page.locator("#invite-group-unseen"), "no groups: said, not failed").toHaveText("Your role cannot see groups, so nobody you invite is added to one.", { timeout: 15000 });
    await expect(page.locator("#invite-comp-unseen"), "no events: said, not claimed absent").toHaveText("Your role cannot see events, so nobody you invite is added to one.");
    await expect(page.locator("#invite-overlay")).not.toContainText("Could not load");
    await expect(page.locator("#invite-overlay")).not.toContainText("No live, upcoming or late-entry events");
    await expect(page.locator("#invite-submit-btn"), "POSITIVE: Send is still offered").toBeEnabled();
    expect(t.reads.filter((x) => x === "GET /api/admin/groups"), "no group read").toEqual([]);
    expect(t.refused, "no refused request").toEqual([]);
  });

  test("Grant Attempts is offered only with the participants read its dialog makes, and then lists the event's people", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const openRowMenu = async (pg) => {
      await pg.evaluate(() => window.adminTab(null, "admin-tasks-tab"));
      await narrowChallengesTable(pg, capTask.title);
      const r = pg.locator("#admin-task-body tr", { hasText: capTask.title }).first();
      await expect(r, "PRECONDITION: the capped challenge is listed").toBeVisible({ timeout: 15000 });
      await openKebab(pg, r);
    };
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const cp = await ctx.newPage();
      const ct = recordTraffic(cp);
      await signIn(cp, U.granterPeople);
      await openRowMenu(cp);
      await cp.locator('#kebab-portal [data-action="task-attempt-grant"]').click();
      await expect(cp.locator("#ag-people"), "CONTROL: the dialog lists the event's participant").toContainText(partU.nickname, { timeout: 15000 });
      expect(ct.reads.some((x) => x === "GET /api/admin/participants/picker"), "CONTROL: the people were read").toBe(true);
      expect(ct.refused).toEqual([]);
    } finally { await ctx.close(); }

    const t = recordTraffic(page);
    await signIn(page, U.granter);
    await openRowMenu(page);
    await expect(page.locator('#kebab-portal [data-action="task-history"]'), "POSITIVE: the menu is open").toHaveCount(1);
    await expect(page.locator('#kebab-portal [data-action="task-attempt-grant"]'), "no Grant Attempts without participants.view").toHaveCount(0);
    expect(t.refused, "no refused request").toEqual([]);
  });

  test("Join-link settings: without events.edit the toggle is disabled and says why; with it, it saves", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const openJoinLink = async (pg) => {
      await viewComp(pg, comp.name);
      await pg.locator("#ws-quick .ws-more-btn").click();
      await pg.locator('#kebab-portal [data-action="comp-self-enroll"]').click();
      await expect(pg.locator("#self-enroll-enabled"), "PRECONDITION: the dialog is open").toBeVisible({ timeout: 15000 });
    };
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const cp = await ctx.newPage();
      const ct = recordTraffic(cp);
      await signIn(cp, U.signageEdit);
      await openJoinLink(cp);
      const en = cp.locator("#self-enroll-enabled");
      await expect(en, "CONTROL: the toggle is offered").toBeEnabled();
      await expect(cp.locator("#self-enroll-perm-note")).toHaveCount(0);
      // "Allow instant join" was retired (operator ruling, 14 Nov 2026).
      await expect(cp.locator("#self-enroll-instant"), "the retired switch is not offered").toHaveCount(0);
      for (let i = 0; i < 2; i++) {   // flipped, then back to where it was
        const put = cp.waitForResponse((r) => r.url().endsWith(`/api/admin/competitions/${comp.id}`) && r.request().method() === "PUT");
        await en.click();
        expect((await put).status(), "CONTROL: the toggle saves").toBe(200);
      }
      expect(ct.refused).toEqual([]);
    } finally { await ctx.close(); }

    const t = recordTraffic(page);
    await signIn(page, U.signage);
    await openJoinLink(page);
    await expect(page.locator("#self-enroll-perm-note"), "the reason is said").toContainText("not turn self-enrollment on or off");
    await expect(page.locator("#self-enroll-enabled")).toBeDisabled();
    await expect(page.locator("#self-enroll-enabled")).toHaveAttribute("aria-describedby", "self-enroll-perm-note");
    await expect(page.locator('#self-enroll-overlay [data-action="self-enroll-regenerate"]'), "POSITIVE: Regenerate (events.join_link) stays").toBeVisible();
    await expect(page.locator("#self-enroll-input"), "POSITIVE: the link itself is shown").not.toHaveValue("");
    expect(t.refused, "no refused request").toEqual([]);
  });

  test("Add user is offered only while the role may give a role, and then it adds (a role that may give one: control)", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const cp = await ctx.newPage();
      const ct = recordTraffic(cp);
      await signIn(cp, U.keeperPlus);
      await cp.evaluate(() => window.adminTab(null, "admin-users-tab"));
      await cp.locator('[data-action="ua-add-user"]').click({ timeout: 15000 });
      const opts = await cp.locator("#ua-add-role option").evaluateAll((os) => os.map((o) => o.value));
      expect(opts, "CONTROL: the role it may give is offered").toContain(R.viewer.id);
      await cp.locator("#ua-add-email").fill(`cradd${stamp}@acme.com`);
      await cp.locator("#ua-add-role").selectOption(R.viewer.id);
      const added = cp.waitForResponse((r) => r.url().endsWith("/api/admin/users") && r.request().method() === "POST");
      await cp.locator('#ua-add button[type="submit"]').click();
      expect((await added).status(), "CONTROL: the user is added").toBe(200);
      expect(ct.refused).toEqual([]);
    } finally { await ctx.close(); }

    const t = recordTraffic(page);
    await signIn(page, U.keeper);
    await expect(page.locator("#ua-add-none"), "no role to give: said instead of a door that cannot work").toHaveText("Your role cannot give any admin role, so it cannot add users.", { timeout: 15000 });
    await expect(page.locator('[data-action="ua-add-user"]')).toHaveCount(0);
    await expect(page.locator("#ua-users-list"), "POSITIVE: the users are listed").toContainText(U.keeper.email);
    expect(t.refused, "no refused request").toEqual([]);
  });

  test("New event for a role that may create but not see templates: blank starters only, no refused read (a role holding both: control)", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const cp = await ctx.newPage();
      const ct = recordTraffic(cp);
      await signIn(cp, U.creatorFull);
      await cp.locator("#new-competition-btn").click({ timeout: 15000 });
      await expect(cp.locator("#tpl-list .tpl-row").first(), "CONTROL: the templates are listed").toBeVisible({ timeout: 15000 });
      await cp.locator('[data-action="new-event-start"]').first().click();
      // Stage B — the form picks no questions (the event's one door is + Add
      // from bank), so even a role that may read the bank reads nothing here.
      await expect(cp.locator("#comp-name"), "CONTROL: the form is open").toBeVisible({ timeout: 15000 });
      await expect(cp.locator("#comp-ch-search"), "the form lists no questions").toHaveCount(0);
      expect(ct.reads.filter((x) => x === "GET /api/admin/tasks"), "no library read from the form").toEqual([]);
      expect(ct.refused).toEqual([]);
    } finally { await ctx.close(); }

    const t = recordTraffic(page);
    await signIn(page, U.creator);
    await expect.poll(() => navShown(page), { message: "New event is offered to a role that may create", timeout: 15000 }).toEqual(["admin-competitions-tab", "admin-templates-tab"]);
    await page.locator("#new-competition-btn").click({ timeout: 15000 });
    await expect(page.locator("#tpl-list-unseen"), "no templates: said, not failed").toHaveText("Your role cannot see templates. Start a blank event above.", { timeout: 15000 });
    await expect(page.locator('[data-action="new-event-start"]').first(), "POSITIVE: the blank starters").toBeVisible();
    await page.locator('[data-action="new-event-start"]').first().click();
    await expect(page.locator("#comp-ch-search"), "the form lists no questions").toHaveCount(0);
    await expect(page.locator("#comp-name"), "POSITIVE: the create form is open").toBeVisible();
    expect(t.reads.filter((x) => x === "GET /api/admin/event-templates" || x === "GET /api/admin/tasks"), "no template or library read").toEqual([]);
    expect(t.refused, "no refused request").toEqual([]);
  });

  test("a name on Live rankings links only into a page the role may open; a press that gets there anyway opens nothing", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const openBoard = async (pg) => {
      await pg.locator('button.admin-nav-item[data-tab-id="admin-rankings-tab"]').click();
      await expect(pg.locator("#admin-rankings-tab").getByText(partU.nickname, { exact: true }).first(), "PRECONDITION: the participant is on the board").toBeVisible({ timeout: 20000 });
    };
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const cp = await ctx.newPage();
      await signIn(cp, U.rankerPeople);
      await openBoard(cp);
      const link = cp.locator(`.rk-player-link[data-nickname="${partU.nickname}"]`).first();
      await expect(link, "CONTROL: a role that may read people gets the link").toBeVisible();
      await link.click();
      await expect(cp.locator("#admin-participants-tab"), "CONTROL: and it opens People").toBeVisible({ timeout: 15000 });
      await expect(cp.locator("#participants-search"), "CONTROL: narrowed to that person").toHaveValue(partU.nickname);
      await expect(cp.locator("#admin-participants-body"), "CONTROL: who is listed").toContainText(partU.nickname, { timeout: 15000 });
    } finally { await ctx.close(); }

    const t = recordTraffic(page);
    await signIn(page, U.ranker);
    await openBoard(page);
    await expect(page.locator(`.rk-player-link[data-nickname="${partU.nickname}"]`), "no link into a page the role cannot open").toHaveCount(0);
    await expect(page.locator(".rk-player-name", { hasText: partU.nickname }).first(), "the plain name instead").toBeVisible();
    // A press that reaches the action anyway (a link drawn before the role was
    // known) opens nothing, and says why.
    await page.evaluate((nick) => {
      const b = document.createElement("button");
      b.dataset.action = "rankings-open-participant";
      b.dataset.nickname = nick;
      document.body.appendChild(b);
      b.click();
      b.remove();
    }, partU.nickname);
    await expect(page.locator("#toast-stack"), "it says why").toContainText("Your role cannot open that page.");
    await expect(page.locator("#admin-participants-tab"), "People is not opened").toBeHidden();
    await expect(page.locator("#admin-rankings-tab"), "the board stays").toBeVisible();
    expect(t.refused, "no refused request").toEqual([]);
  });

  test("Raw logs reads the group list only with groups.view, and drops its Group filter otherwise (a role with it: control)", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const cp = await ctx.newPage();
      const ct = recordTraffic(cp);
      await signIn(cp, U.logReaderGroups);
      await cp.evaluate(() => window.adminTab(null, "admin-logs-tab"));
      await expect(cp.locator("#logs-group-filter"), "CONTROL: the Group filter is offered").toBeVisible({ timeout: 15000 });
      await expect.poll(() => cp.locator("#logs-group-filter option").allInnerTexts(), { message: "CONTROL: with the groups", timeout: 15000 }).toContain(group.name);
      expect(ct.refused).toEqual([]);
    } finally { await ctx.close(); }

    const t = recordTraffic(page);
    await signIn(page, U.logReader);
    await page.evaluate(() => window.adminTab(null, "admin-logs-tab"));
    await expect.poll(() => t.reads.includes("GET /api/admin/logs"), { message: "POSITIVE: the log itself was read", timeout: 15000 }).toBe(true);
    await expect(page.locator("#logs-group-filter"), "no Group filter without groups.view").toBeHidden();
    expect(t.reads.filter((x) => x === "GET /api/admin/groups"), "no group read").toEqual([]);
    expect(t.refused, "no refused request").toEqual([]);
  });

  test("an organiser's Search everyone names their other events' people, as do its tip and the empty event's advice (regular admin: control)", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const scopeBox = (pg) => pg.locator("#p-ws-scope");
    const openEmpty = async (pg) => {
      await viewComp(pg, emptyComp.name);
      await pg.locator('#ws-tabs [data-section="admin-participants-tab"]').click();
      await expect(scopeBox(pg), "PRECONDITION: the event's Participants section is open").toBeVisible({ timeout: 15000 });
    };
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const cp = await ctx.newPage();
      await signIn(cp, regAdmin);
      await openEmpty(cp);
      await expect(scopeBox(cp), "CONTROL: an administrator searches every account").toHaveText("Search everyone on the platform");
      await expect(cp.locator("#p-ws-scope-help .help-tip-note"), "CONTROL: and its tip says so").toHaveText(/^Lists every account on the platform/);
      await expect(cp.locator("#admin-participants-body"), "CONTROL: the advice names the box").toContainText("Nobody is in this event yet. Use Invite, the join link, or Search everyone on the platform to add people.");
    } finally { await ctx.close(); }

    await signIn(page, eaUser);
    await openEmpty(page);
    await expect(scopeBox(page), "the box says what it lists for an organiser").toHaveText("Show people from your other events");
    await expect(page.locator("#p-ws-scope-help .help-tip-btn"), "its tip is named after those words").toHaveAttribute("aria-label", "About Show people from your other events");
    await expect(page.locator("#p-ws-scope-help .help-tip-note"), "the organiser's tip, not the administrator's").toHaveText("Lists the people of your other events too, not only this event's, so you can add someone with Add to event.");
    await expect(page.locator("#admin-participants-body")).toContainText("Nobody is in this event yet. Use Invite, the join link, or Show people from your other events to add people.");

    // A role offered none of those doors is told only the fact.
    const ctx2 = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
    try {
      const lp = await ctx2.newPage();
      await signIn(lp, U.leadReader);
      await openEmpty(lp);
      await expect(lp.locator("#admin-participants-body td.table-empty-row"), "no door it is not offered is named").toHaveText("Nobody is in this event yet.");
    } finally { await ctx2.close(); }
  });
});
