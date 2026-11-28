"use strict";

// THE STAFF-TEAMS DIRECTORY IN THE APP (features/staff-teams.js): Settings →
// People → Staff teams, and its two event doors. Held, by value:
//
//   • a team is made, a member added and edited and removed through the
//     dialogs, each read back from the server;
//   • the section fits a 1024 px window and a 390 px phone with nothing scrolling
//     sideways, and is axe-clean in every look by day and night;
//   • a role holding teams.view alone sees the section read-only (no New team,
//     Edit or Remove); a role without it gets no Staff teams section at all;
//   • Team & reports → Add a staff team adds the allowed members and lists who
//     was skipped with the reason, and the team list shows the added member;
//   • Organisers → Add a staff team as organisers warns that roles change, then
//     lists who was made an organiser and who was skipped, and the card shows
//     the new organiser.
const { test, expect } = require("./isolated-test");
const { BASE, apiLogin, PARTICIPANT_PASS, settleFiniteAnimations } = require("./helpers");
const { adminLogin, loginViaApi, openSettingsSection, viewComp, openOverviewDetail, AXE_GATED_IMPACTS } = require("./ui-admin-helpers");
const { H, uniq, makeParticipant, makeCompetition } = require("./event-admin-helpers");
const AxeBuilder = require("@axe-core/playwright").default;
const { looks } = require("../scripts/theme/looks");

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });

const T = uniq("stu").replace(/[^a-zA-Z0-9]/g, "").slice(-10);
const W = {};

async function call(api, csrf, method, url, data) {
  const r = await api.fetch(url, { method, headers: H(csrf), ...(data === undefined ? {} : { data }) });
  let body = null;
  try { body = await r.json(); } catch (_) { body = null; }
  return { status: r.status(), body };
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const s = await apiLogin("superadmin");
  try {
    W.part = await makeParticipant(s.api, s.csrf, "stuorg");
    const team = await call(s.api, s.csrf, "POST", "/api/admin/staff-teams", { name: `Launch crew ${T}` });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    W.team = team.body.team;
    for (const m of [
      { name: "Maya Fischer", email: `maya.${T}@corp.example`, default_role: "marketing" },
      { name: "Bea Elsewhere", email: `bea.${T}@other.example`, default_role: "sales" },
      { name: "Pat Participant", email: W.part.email, default_role: "se" },
    ]) {
      const r = await call(s.api, s.csrf, "POST", `/api/admin/staff-teams/${W.team.id}/members`, m);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    W.comp = await makeCompetition(s.api, s.csrf, "stuev");
    // An organiser of the event (an event admin: no teams.view).
    W.ea = await makeParticipant(s.api, s.csrf, "stuea");
    const g = await call(s.api, s.csrf, "POST", `/api/admin/competitions/${W.comp.id}/admins`, { userId: W.ea.id });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    for (const [key, perms] of [["reader", ["panel.access", "teams.view"]], ["none", ["panel.access", "settings.view"]]]) {
      const role = await call(s.api, s.csrf, "POST", "/api/admin/roles", { label: `Staff teams ${key} ${T}`, scope_mode: "all", permissions: perms });
      expect(role.status, JSON.stringify(role.body)).toBe(200);
      const p = await makeParticipant(s.api, s.csrf, `stu${key}`);
      const a = await call(s.api, s.csrf, "PATCH", `/api/admin/users/${p.id}/role`, { role: role.body.role.id });
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      W[key] = p;
    }
  } finally { await s.api.dispose(); }
});

async function openStaffTeams(page, who = "superadmin", pass) {
  if (who === "superadmin") await adminLogin(page);
  else { await loginViaApi(page, who, pass); await page.goto("/"); }
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-settings-tab']").first().click();
  await page.locator("#admin-settings-tab").waitFor({ state: "visible", timeout: 15000 });
  await openSettingsSection(page, "staff-teams");
  await expect(page.locator("#staff-teams-body table[data-tcols='staff-teams']")).toBeVisible({ timeout: 15000 });
}
const teamRow = (page, name) => page.locator("#staff-teams-body table[data-tcols='staff-teams'] tbody tr").filter({ hasText: name });
const memberRow = (page, text) => page.locator("#staff-teams-body table[data-tcols='staff-team-members'] tbody tr").filter({ hasText: text });

async function serverTeam(page, name) {
  const d = await (await page.request.get("/api/admin/staff-teams")).json();
  return d.teams.find((t) => t.name === name) || null;
}

test("a team is made, and a member added, edited and removed, through the dialogs", async ({ page }) => {
  await openStaffTeams(page);
  const name = `Partner team ${T}`;
  await page.locator("#staff-teams-body [data-action='st-new']").click();
  await expect(page.locator("#st-team")).toBeVisible();
  await page.locator("#st-team-name").fill(name);
  await page.locator("#st-team button[type='submit']").click();
  await expect(page.locator("#st-team")).toHaveCount(0);
  await expect(teamRow(page, name)).toHaveCount(1);
  expect(await serverTeam(page, name), "the team is on the server").toBeTruthy();
  // The new team is the one chosen: its members panel says it is empty.
  await expect(page.locator("#st-members-h")).toContainText(name);
  await expect(page.locator("#staff-teams-body .st-members")).toContainText("No one in this team yet.");

  // A refused member shows the server's reason in the dialog, which stays open.
  await page.locator("#staff-teams-body [data-action='st-member-add']").click();
  await page.locator("#st-member-name").fill("Ola Nordmann");
  await page.locator("#st-member-email").fill("not-an-address");
  await page.locator("#st-member button[type='submit']").click();
  await expect(page.locator("#st-member-err")).toContainText("not an email address");
  await page.locator("#st-member-email").fill(`ola.${T}@corp.example`);
  await page.locator("#st-member-role").selectOption("sales");
  await page.locator("#st-member button[type='submit']").click();
  await expect(page.locator("#st-member")).toHaveCount(0);
  await expect(memberRow(page, "Ola Nordmann")).toContainText("Sales (Account Exec)");
  let t = await serverTeam(page, name);
  expect(t.members.map((m) => [m.name, m.email, m.default_role])).toEqual([["Ola Nordmann", `ola.${T}@corp.example`, "sales"]]);

  // Edit: the name and the role.
  await memberRow(page, "Ola Nordmann").locator("[data-action='st-member-edit']").click();
  await expect(page.locator("#st-member-name")).toHaveValue("Ola Nordmann");
  await page.locator("#st-member-name").fill("Ola N.");
  await page.locator("#st-member-role").selectOption("");
  await page.locator("#st-member button[type='submit']").click();
  await expect(memberRow(page, "Ola N.")).toContainText("None");
  t = await serverTeam(page, name);
  expect(t.members.map((m) => [m.name, m.default_role])).toEqual([["Ola N.", null]]);

  // Remove, confirmed.
  await memberRow(page, "Ola N.").locator("[data-action='st-member-remove']").click();
  await page.locator("#modal-confirm-btn").click();
  await expect(page.locator("#staff-teams-body .st-members")).toContainText("No one in this team yet.");
  expect((await serverTeam(page, name)).members).toEqual([]);

  // Delete the team, confirmed.
  await teamRow(page, name).locator("[data-action='st-delete']").click();
  await page.locator("#modal-confirm-btn").click();
  await expect(teamRow(page, name)).toHaveCount(0);
  expect(await serverTeam(page, name)).toBeNull();
});

test("the section fits 1024 px and a 390 px phone with nothing scrolling sideways", async ({ page }) => {
  await openStaffTeams(page);
  await teamRow(page, W.team.name).locator("[data-action='st-open']").click();
  await expect(page.locator("#st-members-h")).toContainText(W.team.name);
  for (const [w, h] of [[1024, 768], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await expect(memberRow(page, "Maya Fischer")).toBeVisible();
    await settleFiniteAnimations(page);
    const g = await page.evaluate(() => {
      const card = document.getElementById("staff-teams-card").getBoundingClientRect();
      const tables = [...document.querySelectorAll("#staff-teams-body table")].map((t) => {
        const wrap = t.closest(".table-card") || t.parentElement;
        return { key: t.dataset.tcols, sw: t.scrollWidth, cw: wrap.clientWidth, right: t.getBoundingClientRect().right };
      });
      // Every control a person can see (a phone's card layout hides the table's
      // headings, with their buttons, by visibility).
      const btns = [...document.querySelectorAll("#staff-teams-card button")].filter((b) => b.getBoundingClientRect().width > 0 && getComputedStyle(b).visibility !== "hidden")
        .map((b) => ({ t: b.textContent.trim() || b.getAttribute("aria-label") || b.className, right: b.getBoundingClientRect().right }));
      return { vw: window.innerWidth, docW: document.documentElement.scrollWidth, cardRight: card.right, tables, btns };
    });
    expect(g.docW, `${w}: the page does not scroll sideways: ${JSON.stringify(g)}`).toBeLessThanOrEqual(g.vw);
    expect(g.cardRight, `${w}: the card ends inside the window`).toBeLessThanOrEqual(g.vw);
    for (const t of g.tables) {
      expect(t.sw, `${w}: ${t.key} fits its card: ${JSON.stringify(t)}`).toBeLessThanOrEqual(t.cw + 1);
      expect(t.right, `${w}: ${t.key} ends inside the window`).toBeLessThanOrEqual(g.vw);
    }
    for (const b of g.btns) expect(b.right, `${w}: "${b.t}" is on screen`).toBeLessThanOrEqual(g.vw);
  }
});

const COMBOS = Object.keys(looks).flatMap((id) => ["light", "dark"].map((mode) => ({ id, mode })));
test("the section and its member dialog are axe-clean in every look, by day and night", async ({ browser }) => {
  test.setTimeout(150_000);
  const out = [];
  for (const c of COMBOS) {
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, colorScheme: c.mode, reducedMotion: "reduce" });
    await ctx.addInitScript(([l, t]) => { try { localStorage.setItem("hck-look", l); localStorage.setItem("hck-theme", t); } catch (_) { /* no storage */ } }, [c.id, c.mode]);
    const page = await ctx.newPage();
    try {
      await openStaffTeams(page);
      await teamRow(page, W.team.name).locator("[data-action='st-open']").click();
      await expect(memberRow(page, "Maya Fischer")).toBeVisible();
      const got = await page.evaluate(() => [document.documentElement.dataset.look, document.documentElement.dataset.theme]);
      expect(got, "PRECONDITION: the page wears this look and mode").toEqual([c.id, c.mode]);
      await settleFiniteAnimations(page);
      const scan = async (sel, what) => {
        const r = await new AxeBuilder({ page }).include(sel).withTags(["wcag2a", "wcag2aa"]).analyze();
        for (const v of r.violations.filter((x) => AXE_GATED_IMPACTS.has(x.impact))) out.push(`${what} ${c.id}/${c.mode}: ${v.id} — ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
      };
      await scan("#staff-teams-card", "section");
      await memberRow(page, "Maya Fischer").locator("[data-action='st-member-edit']").click();
      await expect(page.locator("#st-member-name")).toBeVisible();
      await settleFiniteAnimations(page);
      await scan("#st-member", "member dialog");
    } finally { await ctx.close(); }
  }
  expect(out).toEqual([]);
});

test("teams.view alone reads the section without its doors; without it there is no Staff teams section", async ({ page, browser }) => {
  await openStaffTeams(page, W.reader.email, PARTICIPANT_PASS);
  await expect(teamRow(page, W.team.name)).toHaveCount(1);
  await teamRow(page, W.team.name).locator("[data-action='st-open']").click();
  await expect(memberRow(page, "Maya Fischer")).toBeVisible();
  for (const a of ["st-new", "st-rename", "st-delete", "st-member-add", "st-member-edit", "st-member-remove"]) {
    await expect(page.locator(`#staff-teams-body [data-action='${a}']`), `no ${a} for a reader`).toHaveCount(0);
  }
  await expect(page.locator("#staff-teams-body table[data-tcols='staff-team-members'] th[data-tcol='account']"), "no participants.view: no Account column").toHaveCount(0);

  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const p2 = await ctx.newPage();
  try {
    await loginViaApi(p2, W.none.email, PARTICIPANT_PASS);
    await p2.goto("/");
    await p2.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    await p2.locator("[data-action='admin-tab'][data-tab-id='admin-settings-tab']").first().click();
    // POSITIVE: the role's own sections are listed (About & health reads settings.view)…
    await expect.poll(() => p2.evaluate(() => [...document.querySelectorAll("#settings-section-list li:not([hidden]) [data-section]")].map((b) => b.dataset.section)), { timeout: 15000 })
      .toEqual(expect.arrayContaining(["health"]));
    // …and Staff teams is not, nor its card.
    const listed = await p2.evaluate(() => [...document.querySelectorAll("#settings-section-list li:not([hidden]) [data-section]")].map((b) => b.dataset.section));
    expect(listed).not.toContain("staff-teams");
    await expect(p2.locator("#staff-teams-card")).toBeHidden();
  } finally { await ctx.close(); }
});

test("Team & reports → Add a staff team: the allowed added, the skipped listed with the reason", async ({ page }) => {
  const s = await apiLogin("superadmin");
  try {
    expect((await call(s.api, s.csrf, "PUT", "/api/admin/team-report-domains", { domains: ["corp.example", "acme.com"] })).status).toBe(200);
    await adminLogin(page);
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    await page.locator("[data-action='admin-tab'][data-tab-id='admin-competitions-tab']").first().click();
    await viewComp(page, W.comp.name);
    await page.locator('#ws-tabs [data-section="admin-event-team-tab"]').click();
    const door = page.locator("#ws-team [data-action='team-add-staff-team']");
    await expect(door).toBeVisible({ timeout: 15000 });
    await door.click();
    await expect(page.locator("#st-to-event")).toBeVisible();
    await page.locator("#st-ev-team").selectOption(W.team.id);
    await expect(page.locator("#st-ev-preview")).toContainText("Maya Fischer");
    await expect(page.locator("#st-ev-preview")).toContainText("Marketing");
    await page.locator("#st-to-event button[type='submit']").click();
    const added = page.locator("#st-to-event [data-outcome='added']");
    await expect(added).toContainText("Maya Fischer");
    await expect(added).toContainText("Pat Participant");
    const skipped = page.locator("#st-to-event [data-outcome='skipped']");
    await expect(added, "the outcome is on screen, not only in the markup").toBeVisible();
    await expect(skipped).toBeVisible();
    await expect(skipped.locator("li")).toHaveCount(1);
    await expect(skipped).toContainText("Bea Elsewhere");
    await expect(skipped, "the reason names the allowed domains").toContainText("corp.example, acme.com");
    await expect(page.locator("#st-to-event .modal-foot [data-st-cancel]"), "the outcome's one button takes the focus").toBeFocused();
    await page.locator("#st-to-event .modal-foot [data-st-cancel]").click();
    await expect(page.locator("#st-to-event")).toHaveCount(0);
    // The team list was read again: the added members are on it.
    await expect(page.locator("#ws-team table[data-tcols='team-members']")).toContainText("Maya Fischer");
    const t = await (await page.request.get(`/api/admin/competitions/${W.comp.id}/team`)).json();
    expect(t.members.map((m) => m.name).sort()).toEqual(["Maya Fischer", "Pat Participant"]);
  } finally {
    await call(s.api, s.csrf, "PUT", "/api/admin/team-report-domains", { domains: [] });
    await s.api.dispose();
  }
});

test("Organisers → Add a staff team as organisers: the warning, then who was made an organiser and who was skipped", async ({ page }) => {
  await adminLogin(page);
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-competitions-tab']").first().click();
  await viewComp(page, W.comp.name);
  await openOverviewDetail(page);
  const door = page.locator("#ws-ov-orgs-add [data-action='ws-org-add-team']");
  await expect(door).toBeVisible({ timeout: 15000 });
  await door.click();
  await expect(page.locator("#st-organisers")).toBeVisible();
  await page.locator("#st-org-team").selectOption(W.team.id);
  await expect(page.locator("#st-organisers .st-warn")).toContainText("event admin");
  await expect(page.locator("#st-org-preview li").filter({ hasText: "Maya Fischer" })).toContainText("no account: will be skipped");
  await expect(page.locator("#st-org-preview li").filter({ hasText: "Pat Participant" }), "an account is not marked").not.toContainText("no account");
  await page.locator("#st-organisers button[type='submit']").click();
  const granted = page.locator("#st-organisers [data-outcome='added']");
  await expect(granted.locator("li")).toHaveCount(1);
  await expect(granted).toContainText("Pat Participant");
  await expect(granted).toContainText("event admin");
  const skipped = page.locator("#st-organisers [data-outcome='skipped']");
  await expect(granted, "the outcome is on screen, not only in the markup").toBeVisible();
  await expect(skipped).toBeVisible();
  await expect(skipped.locator("li")).toHaveCount(2);
  await expect(skipped).toContainText("No account signs in with this address.");
  await page.locator("#st-organisers .modal-foot [data-st-cancel]").click();
  await expect(page.locator("#ws-ov-orgs")).toContainText(W.part.email);
  const admins = await (await page.request.get(`/api/admin/competitions/${W.comp.id}/admins`)).json();
  expect(admins.admins.map((a) => a.id).sort()).toEqual([W.part.id, W.ea.id].sort());
});

test("an event admin (no teams.view) adds one person at a time: no staff-team door", async ({ page }) => {
  await loginViaApi(page, W.ea.email, PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-competitions-tab']").first().click();
  await viewComp(page, W.comp.name);
  await page.locator('#ws-tabs [data-section="admin-event-team-tab"]').click();
  // POSITIVE: the single add is offered (the form the door sits under)…
  await expect(page.locator("#ws-team [data-action='team-add']")).toBeVisible({ timeout: 15000 });
  // …and the staff-team door is not.
  await expect(page.locator("#ws-team [data-action='team-add-staff-team']")).toHaveCount(0);
});
