"use strict";

// THE STAFF-TEAMS DIRECTORY (routes/staff-teams.js, lib/staff-teams.js) and its
// two event doors. Pinned here, by value:
//
//   1. CRUD and its refusals: a team is made (201), its name is unique ignoring
//      case (409), empty / control-character / over-long / non-text names are
//      refused (400), a stale rename is refused (409); a member is added,
//      edited and removed; a bad address, a control character in a name, an
//      unknown default role and a repeat address (any case) are refused; deleting
//      a team deletes its members. Every change is an ORPHANED `staff_team`
//      audit row with the request context, naming the member id and the
//      address's DOMAIN — never the address (searched for in every row).
//   2. `has_account` is the server's read of the PRIMARY address, sent only to
//      a reader holding participants.view (a role without it gets none).
//   3. Permissions: a custom role without `teams.view` is refused the read and
//      the writes (permission_denied, naming the permission); one holding
//      `teams.view` alone reads and may not write; a role scoped to its events
//      may not be given either (platform-wide); an event admin is refused.
//   4. Team & reports → a whole team: each member under the single add's rules
//      — a disallowed domain, a member already on the team with that role and a
//      member with no role are skipped with their reasons, the allowed ones added
//      (CONTROL), each audited `team_member_added` with `via: "staff_team"` and
//      the domain only; a role sent overrides the default roles; a custom role
//      without export.data gets Marketing and SDR members skipped (the data
//      rule) while Sales is added; an event admin (no teams.view) is refused.
//   5. Organisers ← a whole team: a member with no account, an administrator and
//      an existing organiser are skipped with their reasons; a participant
//      account is granted (its role becomes event_admin, audited on both
//      histories with `via: "staff_team"`); an event admin is refused at the gate.

const { test, expect } = require("./isolated-test");
const { BASE, TEST_DB_PATH, apiLogin } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, grantEventAdmin } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const T = uniq("st").replace(/[^a-zA-Z0-9]/g, "").slice(-12);

function ro(fn) {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}
const auditRows = (teamId) => ro(db => db.prepare("SELECT event_type, details FROM orphan_events WHERE scope='staff_team' AND scope_id=? ORDER BY changed_at, rowid").all(teamId))
  .map(r => ({ type: r.event_type, details: JSON.parse(r.details || "{}") }));

async function call(api, csrf, method, url, data) {
  const r = await api.fetch(url, { method, headers: H(csrf), ...(data === undefined ? {} : { data }) });
  let body = null;
  try { body = await r.json(); } catch (_) { body = null; }
  return { status: r.status(), body };
}

let sa, saCsrf;
test.beforeAll(async () => {
  const s = await apiLogin("superadmin");
  sa = s.api; saCsrf = s.csrf;
});

async function makeTeam(name) {
  const r = await call(sa, saCsrf, "POST", "/api/admin/staff-teams", { name });
  expect(r.status, `create team ${name}: ${JSON.stringify(r.body)}`).toBe(201);
  return r.body.team;
}
async function addMember(teamId, m) {
  const r = await call(sa, saCsrf, "POST", `/api/admin/staff-teams/${teamId}/members`, m);
  expect(r.status, `add member ${m.email}: ${JSON.stringify(r.body)}`).toBe(201);
  return r.body.member;
}
async function makeRole(label, scope_mode, permissions) {
  const r = await call(sa, saCsrf, "POST", "/api/admin/roles", { label: `${label} ${T}`, scope_mode, permissions });
  expect(r.status, `role ${label}: ${JSON.stringify(r.body)}`).toBe(200);
  return r.body.role;
}
async function userWithRole(label, roleId) {
  const p = await makeParticipant(sa, saCsrf, label);
  const r = await call(sa, saCsrf, "PATCH", `/api/admin/users/${p.id}/role`, { role: roleId });
  expect(r.status, `assign ${label}: ${JSON.stringify(r.body)}`).toBe(200);
  const l = await apiLogin(p.email);
  return { ...p, api: l.api, csrf: l.csrf };
}
async function setDomains(domains) {
  const r = await call(sa, saCsrf, "PUT", "/api/admin/team-report-domains", { domains });
  expect(r.status, `set domains: ${JSON.stringify(r.body)}`).toBe(200);
}

test.describe("staff teams — the directory", () => {
  test("CRUD, its refusals, and the audit rows (domain, never the address)", async () => {
    const name = `Field crew ${T}`;
    const team = await makeTeam(name);
    expect(team).toMatchObject({ name, member_count: 0, members: [] });

    // Names: unique ignoring case, and refused when empty, not text, too long or holding a control character.
    let r = await call(sa, saCsrf, "POST", "/api/admin/staff-teams", { name: name.toUpperCase() });
    expect([r.status, r.body.code, r.body.id]).toEqual([409, "staff_team_exists", team.id]);
    for (const [bad, code] of [["   ", "staff_team_name_required"], [42, "staff_team_name_required"], ["x".repeat(81), "staff_team_name_invalid"], ["Line\nbreak", "staff_team_name_invalid"]]) {
      r = await call(sa, saCsrf, "POST", "/api/admin/staff-teams", { name: bad });
      expect([r.status, r.body.code], `name ${JSON.stringify(bad)}`).toEqual([400, code]);
    }

    // Members.
    const addr = `maya.${T.toLowerCase()}@corp.example`;
    const m = await addMember(team.id, { name: "Maya Fischer", email: `  ${addr.toUpperCase()} `, default_role: "marketing" });
    expect(m).toMatchObject({ name: "Maya Fischer", email: addr, domain: "corp.example", default_role: "marketing", default_role_label: "Marketing" });
    for (const [body, code, field] of [
      [{ name: "No at", email: "not-an-address" }, "staff_member_email_invalid", "email"],
      [{ name: "Tab\tname", email: `tab.${T}@corp.example` }, "profile_text_control_chars", "name"],
      [{ name: "Bad role", email: `role.${T}@corp.example`, default_role: "ceo" }, "staff_member_role_invalid", "default_role"],
      [{ name: "", email: `empty.${T}@corp.example` }, "staff_member_name_required", "name"],
      [{ name: "Array", email: [`arr.${T}@corp.example`] }, "staff_member_email_required", "email"],
    ]) {
      r = await call(sa, saCsrf, "POST", `/api/admin/staff-teams/${team.id}/members`, body);
      expect([r.status, r.body.code, r.body.field], JSON.stringify(body)).toEqual([400, code, field]);
    }
    r = await call(sa, saCsrf, "POST", `/api/admin/staff-teams/${team.id}/members`, { name: "Again", email: addr.toUpperCase() });
    expect([r.status, r.body.code], "an address once per team, any case").toEqual([409, "staff_member_exists"]);

    // Edit the member; a stale edit is refused.
    r = await call(sa, saCsrf, "PUT", `/api/admin/staff-teams/${team.id}/members/${m.id}`, { name: "Maya F.", email: addr, default_role: "sdr", expectedUpdatedAt: m.updated_at });
    expect([r.status, r.body.changed, r.body.member && r.body.member.default_role]).toEqual([200, true, "sdr"]);
    r = await call(sa, saCsrf, "PUT", `/api/admin/staff-teams/${team.id}/members/${m.id}`, { name: "Stale", email: addr, expectedUpdatedAt: m.updated_at });
    expect([r.status, r.body.code], "an edit from a stale form").toEqual([409, "staff_member_changed"]);

    // Rename; a clash and a stale rename are refused.
    const other = await makeTeam(`Other ${T}`);
    r = await call(sa, saCsrf, "PUT", `/api/admin/staff-teams/${team.id}`, { name: other.name.toLowerCase() });
    expect([r.status, r.body.code]).toEqual([409, "staff_team_exists"]);
    const cur = (await call(sa, saCsrf, "GET", `/api/admin/staff-teams/${team.id}`)).body.team;
    r = await call(sa, saCsrf, "PUT", `/api/admin/staff-teams/${team.id}`, { name: `Renamed ${T}`, expectedUpdatedAt: cur.updated_at });
    expect([r.status, r.body.changed, r.body.team.name]).toEqual([200, true, `Renamed ${T}`]);
    r = await call(sa, saCsrf, "PUT", `/api/admin/staff-teams/${team.id}`, { name: `Again ${T}`, expectedUpdatedAt: cur.updated_at });
    expect([r.status, r.body.code], "a rename from a stale read").toEqual([409, "staff_team_changed"]);

    // Remove the member, then delete the team: its members go with it.
    await addMember(team.id, { name: "Sam Okafor", email: `sam.${T}@corp.example` });
    r = await call(sa, saCsrf, "DELETE", `/api/admin/staff-teams/${team.id}/members/${m.id}`);
    expect(r.status).toBe(200);
    r = await call(sa, saCsrf, "DELETE", `/api/admin/staff-teams/${team.id}`);
    expect([r.status, r.body.members_removed]).toEqual([200, 1]);
    expect((await call(sa, saCsrf, "GET", `/api/admin/staff-teams/${team.id}`)).status).toBe(404);
    expect(ro(db => db.prepare("SELECT COUNT(*) n FROM staff_team_members WHERE team_id=?").get(team.id).n), "members cascade").toBe(0);
    await call(sa, saCsrf, "DELETE", `/api/admin/staff-teams/${other.id}`);

    // The audit trail, by value: every change, the request context, and no address anywhere.
    const rows = auditRows(team.id);
    expect(rows.map(x => x.type)).toEqual(["staff_team_created", "staff_team_member_added", "staff_team_member_updated", "staff_team_renamed",
      "staff_team_member_added", "staff_team_member_removed", "staff_team_deleted"]);
    expect(rows[1].details).toMatchObject({ member_id: m.id, name: "Maya Fischer", domain: "corp.example", default_role: "marketing" });
    expect(rows[2].details.changes).toMatchObject({ name: { from: "Maya Fischer", to: "Maya F." }, default_role: { from: "marketing", to: "sdr" } });
    for (const row of rows) {
      expect(typeof row.details.ip, `${row.type} carries the request context`).toBe("string");
      expect(JSON.stringify(row.details).toLowerCase(), `${row.type} never names the address`).not.toContain(addr);
      expect(JSON.stringify(row.details).toLowerCase()).not.toContain(`sam.${T}@`.toLowerCase());
    }
  });

  test("has_account reads the primary address, and only for a reader who may see people", async () => {
    const team = await makeTeam(`Accounts ${T}`);
    const p = await makeParticipant(sa, saCsrf, "stacct");
    await addMember(team.id, { name: "Has account", email: p.email });
    await addMember(team.id, { name: "No account", email: `nobody.${T}@corp.example` });
    let got = (await call(sa, saCsrf, "GET", `/api/admin/staff-teams/${team.id}`)).body.team.members;
    expect(Object.fromEntries(got.map(x => [x.name, x.has_account]))).toEqual({ "Has account": true, "No account": false });
    const role = await makeRole("Teams reader", "all", ["panel.access", "teams.view"]);
    const u = await userWithRole("stread", role.id);
    const list = await call(u.api, u.csrf, "GET", "/api/admin/staff-teams");
    expect(list.status).toBe(200);
    expect(list.body.can_manage, "teams.view alone cannot manage").toBe(false);
    got = list.body.teams.find(t => t.id === team.id).members;
    expect(got.length).toBe(2);
    expect(got.every(x => !("has_account" in x)), "no participants.view, no account answer").toBe(true);
    // …and it may not write.
    const w = await call(u.api, u.csrf, "POST", "/api/admin/staff-teams", { name: `Nope ${T}` });
    expect([w.status, w.body.code, w.body.permission]).toEqual([403, "permission_denied", "teams.manage"]);
    await call(sa, saCsrf, "DELETE", `/api/admin/staff-teams/${team.id}`);
  });

  test("a role without teams.view is refused; a scoped role may not hold it; an event admin is refused", async () => {
    const role = await makeRole("No teams", "all", ["panel.access", "settings.view"]);
    const u = await userWithRole("stnone", role.id);
    for (const [method, url, data] of [["GET", "/api/admin/staff-teams"], ["POST", "/api/admin/staff-teams", { name: `X ${T}` }]]) {
      const r = await call(u.api, u.csrf, method, url, data);
      expect([r.status, r.body.code], `${method} ${url}`).toEqual([403, "permission_denied"]);
      expect(r.body.permission).toMatch(/^teams\.(view|manage)$/);
    }
    const scoped = await call(sa, saCsrf, "POST", "/api/admin/roles", { label: `Scoped teams ${T}`, scope_mode: "granted", permissions: ["panel.access", "teams.view"] });
    expect([scoped.status, scoped.body.code, scoped.body.permission]).toEqual([400, "role_permission_needs_every_event", "teams.view"]);
    const ev = await makeParticipant(sa, saCsrf, "stea");
    const comp = await makeCompetition(sa, saCsrf, "stea");
    await grantEventAdmin(sa, saCsrf, comp.id, ev.id);
    const l = await apiLogin(ev.email);
    const r = await call(l.api, l.csrf, "GET", "/api/admin/staff-teams");
    expect([r.status, r.body.code]).toEqual([403, "event_admin_forbidden"]);
    // CONTROL: the superadmin reads it.
    expect((await call(sa, saCsrf, "GET", "/api/admin/staff-teams")).status).toBe(200);
  });
});

test.describe("staff teams — into an event's Team & reports", () => {
  test("each member under the single add's rules: skips named with reasons, the allowed added and audited", async () => {
    try {
      await setDomains(["corp.example"]);
      const comp = await makeCompetition(sa, saCsrf, "stteam");
      const team = await makeTeam(`Report crew ${T}`);
      const okA = await addMember(team.id, { name: "Ada Allowed", email: `ada.${T}@corp.example`, default_role: "marketing" });
      const bad = await addMember(team.id, { name: "Bea Elsewhere", email: `bea.${T}@other.example`, default_role: "sales" });
      const dup = await addMember(team.id, { name: "Cy Already", email: `cy.${T}@corp.example`, default_role: "se" });
      const none = await addMember(team.id, { name: "Di Norole", email: `di.${T}@corp.example` });
      // Cy is already on the event's team with that role.
      let r = await call(sa, saCsrf, "POST", `/api/admin/competitions/${comp.id}/team`, { role: "se", name: "Cy Already", email: `cy.${T}@corp.example` });
      expect(r.status).toBe(200);

      r = await call(sa, saCsrf, "POST", `/api/admin/competitions/${comp.id}/team/staff-team`, { teamId: team.id });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.added.map(a => [a.staff_member_id, a.role, a.email])).toEqual([[okA.id, "marketing", `ada.${T}@corp.example`]]);
      const skips = Object.fromEntries(r.body.skipped.map(s => [s.staff_member_id, s.code]));
      expect(skips).toEqual({ [bad.id]: "team_domain_not_allowed", [dup.id]: "team_member_exists", [none.id]: "staff_member_no_role" });
      for (const s of r.body.skipped) expect(String(s.reason).length, `${s.name}'s reason is said`).toBeGreaterThan(10);

      const t = (await call(sa, saCsrf, "GET", `/api/admin/competitions/${comp.id}/team`)).body;
      expect(t.members.map(m => [m.role, m.email]).sort()).toEqual([["marketing", `ada.${T}@corp.example`], ["se", `cy.${T}@corp.example`]]);
      const audit = ro(db => db.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type='team_member_added' ORDER BY changed_at, rowid").all(comp.id)).map(x => JSON.parse(x.details));
      expect(audit.length, "one row per member added (the single add, then the team's one)").toBe(2);
      expect(audit[1]).toMatchObject({ via: "staff_team", staff_team_id: team.id, role: "marketing", domain: "corp.example", name: "Ada Allowed" });
      expect(typeof audit[1].ip).toBe("string");
      expect(JSON.stringify(audit[1])).not.toContain(`ada.${T}@`);

      // A role sent overrides each default: everyone allowed becomes Sales.
      r = await call(sa, saCsrf, "POST", `/api/admin/competitions/${comp.id}/team/staff-team`, { teamId: team.id, role: "sales" });
      expect(r.status).toBe(200);
      expect(r.body.added.map(a => [a.staff_member_id, a.role]).sort()).toEqual([[okA.id, "sales"], [dup.id, "sales"], [none.id, "sales"]].sort());
      expect(r.body.skipped.map(s => [s.staff_member_id, s.code])).toEqual([[bad.id, "team_domain_not_allowed"]]);

      // Refusals of the whole request.
      r = await call(sa, saCsrf, "POST", `/api/admin/competitions/${comp.id}/team/staff-team`, { teamId: team.id, role: "ceo" });
      expect([r.status, r.body.code]).toEqual([400, "team_role_invalid"]);
      r = await call(sa, saCsrf, "POST", `/api/admin/competitions/${comp.id}/team/staff-team`, { teamId: ["x"] });
      expect([r.status, r.body.code]).toEqual([400, "staff_team_required"]);
      r = await call(sa, saCsrf, "POST", `/api/admin/competitions/${comp.id}/team/staff-team`, { teamId: "no-such-team" });
      expect([r.status, r.body.code]).toEqual([404, "staff_team_not_found"]);
    } finally { await setDomains([]); }
  });

  test("the reports' data rule per member, and the event admin refused (no teams.view)", async () => {
    try {
      await setDomains(["corp.example"]);
      const comp = await makeCompetition(sa, saCsrf, "stdata");
      const team = await makeTeam(`Data rule ${T}`);
      const mk = await addMember(team.id, { name: "Mo Marketing", email: `mo.${T}@corp.example`, default_role: "marketing" });
      const sd = await addMember(team.id, { name: "Sid Sdr", email: `sid.${T}@corp.example`, default_role: "sdr" });
      const sl = await addMember(team.id, { name: "Sal Sales", email: `sal.${T}@corp.example`, default_role: "sales" });
      const role = await makeRole("Team adder", "all", ["panel.access", "events.view", "events.edit", "participants.view", "teams.view"]);
      const u = await userWithRole("stadder", role.id);
      let r = await call(u.api, u.csrf, "POST", `/api/admin/competitions/${comp.id}/team/staff-team`, { teamId: team.id });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.added.map(a => a.staff_member_id)).toEqual([sl.id]);
      expect(Object.fromEntries(r.body.skipped.map(s => [s.staff_member_id, s.code]))).toEqual({ [mk.id]: "permission_denied", [sd.id]: "permission_denied" });

      // Without teams.view: refused whole, with the permission named.
      const role2 = await makeRole("Team adder no dir", "all", ["panel.access", "events.view", "events.edit", "participants.view", "export.data"]);
      const u2 = await userWithRole("stadder2", role2.id);
      r = await call(u2.api, u2.csrf, "POST", `/api/admin/competitions/${comp.id}/team/staff-team`, { teamId: team.id });
      expect([r.status, r.body.code, r.body.permission]).toEqual([403, "permission_denied", "teams.view"]);
      const ev = await makeParticipant(sa, saCsrf, "stdataea");
      await grantEventAdmin(sa, saCsrf, comp.id, ev.id);
      const l = await apiLogin(ev.email);
      r = await call(l.api, l.csrf, "POST", `/api/admin/competitions/${comp.id}/team/staff-team`, { teamId: team.id });
      expect([r.status, r.body.permission], "an event admin may add one person, not read the directory").toEqual([403, "teams.view"]);
      // CONTROL: the same event admin's single add goes through.
      r = await call(l.api, l.csrf, "POST", `/api/admin/competitions/${comp.id}/team`, { role: "sales", name: "One by one", email: `one.${T}@corp.example` });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    } finally { await setDomains([]); }
  });
});

test.describe("staff teams — as an event's organisers", () => {
  test("accounts are granted as the single pick grants; no account, administrators and existing organisers skipped", async () => {
    const comp = await makeCompetition(sa, saCsrf, "storg");
    const team = await makeTeam(`Organisers ${T}`);
    const part = await makeParticipant(sa, saCsrf, "storgp");
    const adm = await makeParticipant(sa, saCsrf, "storga");
    const pr = await call(sa, saCsrf, "POST", `/api/admin/participants/${adm.id}/role`, { role: "admin" });
    expect(pr.status, JSON.stringify(pr.body)).toBe(200);
    const already = await makeParticipant(sa, saCsrf, "storge");
    await grantEventAdmin(sa, saCsrf, comp.id, already.id);
    const mP = await addMember(team.id, { name: "Pat Participant", email: part.email });
    const mN = await addMember(team.id, { name: "Nia Noaccount", email: `nia.${T}@corp.example` });
    const mA = await addMember(team.id, { name: "Ari Admin", email: adm.email });
    const mE = await addMember(team.id, { name: "Eve Existing", email: already.email });

    // An event admin is refused at the gate; a role without teams.view inline.
    const l = await apiLogin(already.email);
    let r = await call(l.api, l.csrf, "POST", `/api/admin/competitions/${comp.id}/admins/staff-team`, { teamId: team.id });
    expect([r.status, r.body.code]).toEqual([403, "event_admin_forbidden"]);
    const role = await makeRole("Organiser maker", "all", ["panel.access", "events.view", "events.organisers"]);
    const u = await userWithRole("storgrole", role.id);
    r = await call(u.api, u.csrf, "POST", `/api/admin/competitions/${comp.id}/admins/staff-team`, { teamId: team.id });
    expect([r.status, r.body.permission]).toEqual([403, "teams.view"]);
    expect(ro(db => db.prepare("SELECT role FROM users WHERE id=?").get(part.id).role), "nothing granted by the refusals").toBe("participant");

    r = await call(sa, saCsrf, "POST", `/api/admin/competitions/${comp.id}/admins/staff-team`, { teamId: team.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.granted.map(g => [g.staff_member_id, g.user_id, g.role_changed])).toEqual([[mP.id, part.id, true]]);
    expect(Object.fromEntries(r.body.skipped.map(s => [s.staff_member_id, s.code]))).toEqual({
      [mN.id]: "staff_member_no_account", [mA.id]: "event_admin_target_privileged", [mE.id]: "already_organiser",
    });
    const orgs = ro(db => db.prepare("SELECT user_id FROM competition_admins WHERE competition_id=? ORDER BY user_id").all(comp.id).map(x => x.user_id));
    expect(orgs).toEqual([part.id, already.id].sort());
    expect(ro(db => db.prepare("SELECT role FROM users WHERE id=?").get(part.id).role)).toBe("event_admin");
    expect(ro(db => db.prepare("SELECT role FROM users WHERE id=?").get(adm.id).role), "an administrator is never demoted").toBe("admin");
    const ce = ro(db => db.prepare("SELECT details FROM competition_events WHERE competition_id=? AND event_type='event_admin_granted' ORDER BY changed_at DESC, rowid DESC LIMIT 1").get(comp.id));
    expect(JSON.parse(ce.details)).toMatchObject({ user_id: part.id, role_changed: true, via: "staff_team", staff_team_id: team.id });
    const ue = ro(db => db.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='event_admin_granted'").get(part.id));
    expect(JSON.parse(ue.details)).toMatchObject({ via: "staff_team", competition_id: comp.id });

    // Again: now everyone is either an organiser or skipped for good.
    r = await call(sa, saCsrf, "POST", `/api/admin/competitions/${comp.id}/admins/staff-team`, { teamId: team.id });
    expect(r.body.granted).toEqual([]);
    expect(r.body.skipped.find(s => s.staff_member_id === mP.id).code).toBe("already_organiser");
    r = await call(sa, saCsrf, "POST", `/api/admin/competitions/${comp.id}/admins/staff-team`, { teamId: "missing" });
    expect([r.status, r.body.code]).toEqual([404, "staff_team_not_found"]);
  });
});
