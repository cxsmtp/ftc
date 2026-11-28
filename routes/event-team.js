"use strict";

// THE EVENT TEAM AND ITS PERSONA REPORTS — the admin routes.
// (Data: lib/event-team.js. Sending: lib/team-reports.js.)
//
//   GET    /api/admin/team-report-domains                   settings.view (global admins)
//   PUT    /api/admin/team-report-domains                   superadmin (settings.edit)
//   GET    /api/admin/competitions/:id/team                 events.view, scoped
//   POST   /api/admin/competitions/:id/team                 events.edit, scoped
//   POST   /api/admin/competitions/:id/team/staff-team      events.edit, scoped, + teams.view: a whole staff team
//   DELETE /api/admin/competitions/:id/team/:memberId       events.edit, scoped
//   PUT    /api/admin/competitions/:id/team-targets         events.edit, scoped (whoever edits the event)
//   GET    /api/admin/competitions/:id/team-report          participants.view, scoped (the in-app persona views)
//   GET    /api/admin/competitions/:id/team-report/preview  participants.view, scoped (one email, HTML and text)
//   GET    /api/admin/competitions/:id/team-report/leads.csv export.data, scoped (the CRM file)
//   POST   /api/admin/competitions/:id/team-report/send     events.edit, scoped: send now
//   POST   /api/admin/competitions/:id/leads/:userId/contacted  participants.edit, scoped
//
// Every read is scoped (competitionDenied: an event admin sees only their own
// events); every write to an event asks the competitor lock first; every write
// is audited with reqContext. Team members are recipients, so a member's
// ADDRESS is never written to an audit row (its domain and the member id are;
// the mail's own `email_sent` record carries a domain and a fingerprint,
// lib/email.js), and removing a member takes it out of the event's send ledger
// too (lib/team-reports.js `forgetRemovedRecipient`). Adding a recipient and
// Send now also take what READING the reports takes (`_reportDataRefusal`): a
// mailed report is the same data in an inbox. The two report reads rebuild the
// whole report (and the managers' comparison three more), so they share a
// limiter after the guard.

const db = require("../db");
const { requireAdmin, requireGlobalAdmin, requireSuperAdmin, csrfProtection, destructiveAdminLimit, rateLimit, adminAuthzDenied } = require("../lib/middleware");
const { customRoleAllows, actorPermissions } = require("../lib/rbac");
const { _slugForDownload } = require("../lib/attachments");
const { getAdminIdentity, recordCompetitionEvent, recordSettingsEvent, recordOrphanedAuditEvent, runTxnWithMirrorBuffer, reqContext } = require("../lib/audit");
const { getCompetition } = require("../lib/competitions");
const { competitionDenied, competitorIds, scopedCompetitionIds } = require("../lib/event-admin");
const { competitorEditDenied, refuseCompetitor } = require("../lib/staff-compete");
const { swallowed } = require("../lib/best-effort");
const T = require("../lib/event-team");
const ST = require("../lib/staff-teams");
const R = require("../lib/team-reports");
const M = require("../lib/team-report-mail");
const { suggestedOpener } = require("../lib/qualifying");
const { log } = require("../lib/log");
const { PERF_SPAN_SLOW_MS } = require("../lib/config");

const exportLimiter = rateLimit(60_000, 10, "team-report-export");
const reportReadLimiter = rateLimit(60_000, 60, "team-report-read");

// A report read rebuilds the whole report on every request (and the preview may
// rebuild up to three other events' for the managers' comparison), uncached so
// an organiser's own edit shows at once. A slow one logs where its time went.
const _msSince = (t) => Number(process.hrtime.bigint() - t) / 1e6;
function _reportSpan(req, endpoint, parts) {
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  if (total <= PERF_SPAN_SLOW_MS) return;
  const ms = {};
  for (const [k, v] of Object.entries(parts)) ms[k] = v.toFixed(1);
  log.warn({ req_id: req.id, endpoint, competition_id: req.params.id, total_ms: total.toFixed(1), ...ms }, `[perf-span] slow ${endpoint}`);
}
const PERSONAS = ["se", "marketing", "sales", "sdr", "manager"];

function _gate(req, res, { write = false } = {}) {
  const comp = getCompetition(req.params.id);
  if (!comp) { res.status(404).json({ error: "Event not found" }); return null; }
  if (write) {
    const cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), comp.id));
    if (cmp) return null;
  }
  const denied = competitionDenied(req, comp.id);
  if (denied) { res.status(403).json({ error: denied.message, code: denied.code }); return null; }
  return comp;
}

// May this session change the allowed-domain list? The PUT's own gate
// (`requireSuperAdmin`): a superadmin, or a custom role holding `settings.edit`.
function _domainsEditable(req) {
  if (req.session.isSuperAdmin) return true;
  if (!req.session.userId || req.session.impersonator) return false;
  const u = db.prepare("SELECT role FROM users WHERE id=?").get(req.session.userId);
  return !!u && customRoleAllows(req, u.role, "settings.edit");
}

// The targets' version for the PUT's compare-and-swap (NULL: none saved yet).
function _targetsVersion(compId) {
  const r = db.prepare("SELECT updated_at FROM event_team_settings WHERE competition_id=?").get(compId);
  return r ? r.updated_at : null;
}

// THE REPORTS' DATA RULE. A team member is a recipient of participant data:
// every report carries participants' names, companies and answers (what
// `participants.view` reads in the app), and the Marketing and SDR mails attach
// a lead file — the CRM file, and each SDR's own share (operator ruling 79,
// 14 Nov 2026) — which is `export.data`, the leads.csv read. Adding a recipient
// or sending the reports puts that data in an inbox, so each takes what reading
// it here takes — or a role holding `events.edit` alone could have every
// participant's details, and a lead file, mailed to an address it reads. `crm`
// asks for a report that carries a file. Returns null, or the refusal body
// (403). The built-in roles that hold `events.edit` hold both, so only a custom
// role can be refused.
function _reportDataRefusal(req, { crm = false } = {}) {
  const perms = actorPermissions(req).perms;
  if (!perms.has("participants.view")) {
    return { error: "The team's reports carry participants' details, which your role cannot see. Ask an administrator to change your role.",
      code: "permission_denied", permission: "participants.view" };
  }
  if (crm && !perms.has("export.data")) {
    return { error: "The Marketing and SDR reports attach lead files (the CRM file and each SDR's own), which your role cannot download. Ask an administrator to change your role.",
      code: "permission_denied", permission: "export.data" };
  }
  return null;
}

// The roles whose report can attach a lead file: Marketing's the CRM file, an
// SDR's their own leads (Marketing standing in for an event with no SDR gets
// no second file in the SDR's report). Asked by ROLE: a send to either asks
// `export.data` even when no lead makes a file this time (a Marketing report
// with no leads attaches none).
const FILE_ROLES = new Set(["marketing", "sdr"]);
function _sendCarriesFile(persona, members) {
  if (!persona) return members.some(m => FILE_ROLES.has(m.role));
  return persona === "marketing" || (persona === "sdr" && members.some(m => m.role === "sdr"));
}

function _memberWire(m) {
  return { id: m.id, role: m.role, role_label: T.ROLE_LABELS[m.role], name: m.name, email: m.email, added_at: m.added_at, allowed: T.addressAllowed(m.email) };
}

module.exports = function register(app) {
  // ── the allowed-domain list ───────────────────────────────────────────────
  app.get("/api/admin/team-report-domains", requireAdmin, requireGlobalAdmin, (req, res) => {
    res.json({ domains: T.getAllowedDomains(), can_edit: _domainsEditable(req) });
  });

  app.put("/api/admin/team-report-domains", requireSuperAdmin, csrfProtection, (req, res) => {
    const v = T.validateAllowedDomains(req.body?.domains);
    if (v.error) return res.status(400).json({ error: v.error, code: v.code });
    const from = T.getAllowedDomains();
    const changed = JSON.stringify(from) !== JSON.stringify(v.domains);
    if (changed) {
      const txn = db.transaction(() => {
        T.setAllowedDomains(v.domains);
        recordSettingsEvent(T.DOMAINS_SETTING, "updated", getAdminIdentity(req), { from, to: v.domains, ...reqContext(req) });
      });
      runTxnWithMirrorBuffer(() => txn());
    }
    res.json({ ok: true, domains: v.domains, changed });
  });

  // ── the team ──────────────────────────────────────────────────────────────
  app.get("/api/admin/competitions/:id/team", requireAdmin, (req, res) => {
    const comp = _gate(req, res);
    if (!comp) return;
    // The offer is the route's own rule: scope (asked above) and not competing, so
    // the client never offers what the writes refuse, and says why it does not.
    const lock = competitorEditDenied(db, competitorIds(req), comp.id);
    const members = T.listMembers(comp.id);
    // The reports' data rule, as the two writes ask it: who may be added (the
    // Marketing and SDR roles are sent a lead file) and whether Send now may go.
    const addRefusal = _reportDataRefusal(req);
    const crmRefusal = _reportDataRefusal(req, { crm: true });
    const sendRefusal = _reportDataRefusal(req, { crm: members.some(m => FILE_ROLES.has(m.role)) });
    res.json({
      roles: T.ROLES.map(r => ({ id: r, label: T.ROLE_LABELS[r], ...(FILE_ROLES.has(r) && crmRefusal ? { refusal: crmRefusal.error } : {}) })),
      members: members.map(_memberWire),
      targets: T.getTargets(comp.id),
      // The targets' version, for the PUT's `expectedUpdatedAt` (null: none saved).
      targets_updated_at: _targetsVersion(comp.id),
      allowed_domains: T.getAllowedDomains(),
      can_manage_team: !lock,
      ...(lock ? { manage_refusal: lock.message } : {}),
      ...(addRefusal ? { add_refusal: addRefusal.error } : {}),
      ...(sendRefusal ? { send_refusal: sendRefusal.error } : {}),
      pending: R.pendingTeamReports(comp.id),
      recent_sends: R.recentTeamReportSends(comp.id).slice(0, 30),
    });
  });

  app.post("/api/admin/competitions/:id/team", requireAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
    const comp = _gate(req, res, { write: true });
    if (!comp) return;
    const v = T.validateMember(req.body);
    if (v.error) return res.status(400).json({ error: v.error, code: v.code });
    const dataRefusal = _reportDataRefusal(req, { crm: FILE_ROLES.has(v.role) });
    if (dataRefusal) return res.status(403).json(dataRefusal);
    let out;
    const txn = db.transaction(() => {
      out = T.addMember(comp.id, v, getAdminIdentity(req));
      if (out.member) {
        // Back on the team, the address takes back its rows in the event's send
        // ledger, which its removal rewrote: it is never sent a report it already
        // received (sweep #149, lib/team-reports.js).
        R.restoreRemovedRecipient(comp.id, out.member.email);
        recordCompetitionEvent(comp.id, "team_member_added", getAdminIdentity(req), {
          member_id: out.member.id, role: v.role, name: v.name, domain: T.domainOf(v.email), ...reqContext(req),
        });
      }
    });
    // IMMEDIATE: addMember reads (the size cap, a duplicate) before it writes, and
    // a deferred BEGIN's upgrade fails SQLITE_BUSY at once while another process
    // holds the write lock, never waiting out busy_timeout.
    runTxnWithMirrorBuffer(() => txn.immediate());
    if (out.error) return res.status(409).json({ error: out.error, code: out.code });
    res.json({ ok: true, member: _memberWire(out.member) });
  });

  // A WHOLE STAFF TEAM (Settings → People → Staff teams) at once: each member is
  // added under the single add's own rules — the address on the allowed list
  // (`T.validateMember`), the reports' data rule for their role
  // (`_reportDataRefusal`), an existing member with that role kept, the team's
  // size cap — and one that fails any of them is SKIPPED, with its reason, while
  // the others are added. Each member takes `role` when one is sent, else their
  // default role; a member with neither is skipped. Reading the team takes
  // `teams.view` (platform-wide: a role scoped to its events never holds it).
  app.post("/api/admin/competitions/:id/team/staff-team", requireAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
    const comp = _gate(req, res, { write: true });
    if (!comp) return;
    if (!actorPermissions(req).perms.has("teams.view")) {
      return res.status(403).json({ error: "Your role cannot read the staff teams. Add the people one at a time, or ask an administrator.", code: "permission_denied", permission: "teams.view" });
    }
    const teamId = req.body?.teamId;
    if (typeof teamId !== "string" || !teamId) return res.status(400).json({ error: "teamId must name a staff team.", code: "staff_team_required" });
    const role = req.body?.role;
    if (role !== undefined && role !== null && role !== "" && (typeof role !== "string" || !T.ROLES.includes(role))) {
      return res.status(400).json({ error: `role must be one of: ${T.ROLES.join(", ")}, or empty for each member's default role.`, code: "team_role_invalid" });
    }
    // The base data rule, as the single add's form asks it (`add_refusal`): with
    // it refused, nobody could be added.
    const baseRefusal = _reportDataRefusal(req);
    if (baseRefusal) return res.status(403).json(baseRefusal);
    const team = ST.getTeam(db, teamId);
    if (!team) return res.status(404).json({ error: "Staff team not found", code: "staff_team_not_found" });
    const members = ST.listMembers(db, team.id);
    const added = [];
    const skipped = [];
    const skip = (m, r, code, error) => skipped.push({ staff_member_id: m.id, name: m.name, email: m.email, ...(r ? { role: r, role_label: T.ROLE_LABELS[r] } : {}), code, reason: error });
    const txn = db.transaction(() => {
      for (const m of members) {
        const r = role || m.default_role || null;
        if (!r) { skip(m, null, "staff_member_no_role", "No role: they have no default role and none was chosen."); continue; }
        const v = T.validateMember({ role: r, name: m.name, email: m.email });
        if (v.error) { skip(m, r, v.code, v.error); continue; }
        const dataRefusal = _reportDataRefusal(req, { crm: FILE_ROLES.has(v.role) });
        if (dataRefusal) { skip(m, r, dataRefusal.code, dataRefusal.error); continue; }
        const out = T.addMember(comp.id, v, getAdminIdentity(req));
        if (out.error) { skip(m, r, out.code, out.error); continue; }
        R.restoreRemovedRecipient(comp.id, out.member.email);
        recordCompetitionEvent(comp.id, "team_member_added", getAdminIdentity(req), {
          member_id: out.member.id, role: v.role, name: v.name, domain: T.domainOf(v.email),
          via: "staff_team", staff_team_id: team.id, staff_team_name: team.name, ...reqContext(req),
        });
        added.push({ ..._memberWire(out.member), staff_member_id: m.id });
      }
    });
    // IMMEDIATE, as the single add: each member's cap and repeat are read
    // before its insert.
    runTxnWithMirrorBuffer(() => txn.immediate());
    res.json({ ok: true, team: { id: team.id, name: team.name, member_count: members.length }, added, skipped });
  });

  app.delete("/api/admin/competitions/:id/team/:memberId", requireAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
    const comp = _gate(req, res, { write: true });
    if (!comp) return;
    const m = db.prepare("SELECT id, role, name, email FROM event_team_members WHERE id=? AND competition_id=?").get(req.params.memberId, comp.id);
    if (!m) return res.status(404).json({ error: "Team member not found" });
    const txn = db.transaction(() => {
      db.prepare("DELETE FROM event_team_members WHERE id=?").run(m.id);
      // Their leads go back to the pool; the next report shares them out again.
      db.prepare("UPDATE event_leads SET owner_member_id=NULL WHERE competition_id=? AND owner_member_id=?").run(comp.id, m.id);
      // And once the address holds no role on the team, it leaves the event's
      // send ledger (the team read's recent sends): its rows keep only the
      // domain and the fingerprint the mail's own record carries (sweep #149;
      // operator ruling, 24 Nov 2026).
      R.forgetRemovedRecipient(comp.id, m.email);
      recordCompetitionEvent(comp.id, "team_member_removed", getAdminIdentity(req), {
        member_id: m.id, role: m.role, name: m.name, domain: T.domainOf(m.email), ...reqContext(req),
      });
    });
    runTxnWithMirrorBuffer(() => txn());
    res.json({ ok: true });
  });

  app.put("/api/admin/competitions/:id/team-targets", requireAdmin, csrfProtection, (req, res) => {
    const comp = _gate(req, res, { write: true });
    if (!comp) return;
    const v = T.validateTargets(req.body);
    if (v.error) return res.status(400).json({ error: v.error, code: v.code });
    // `expectedUpdatedAt` (optional): the version the form was filled from. A
    // save over somebody else's newer targets is refused, not merged.
    const expected = req.body?.expectedUpdatedAt;
    if (expected !== undefined && expected !== null && typeof expected !== "string") {
      return res.status(400).json({ error: "expectedUpdatedAt must be the version the targets were read with.", code: "team_target_invalid" });
    }
    const stale = () => expected !== undefined && expected !== _targetsVersion(comp.id);
    if (stale()) return res.status(409).json({ error: "The targets were changed by someone else after you opened them. Reload to see theirs.", code: "team_targets_changed", targets: T.getTargets(comp.id), targets_updated_at: _targetsVersion(comp.id) });
    const from = T.getTargets(comp.id);
    const to = { ...from, ...v.values };
    const changed = from.lead_target !== to.lead_target || from.hot_lead_target !== to.hot_lead_target;
    if (changed) {
      const txn = db.transaction(() => {
        if (stale()) throw new Error("team_targets_changed");
        db.prepare(
          `INSERT INTO event_team_settings (competition_id, lead_target, hot_lead_target, updated_at) VALUES (?,?,?,?)
           ON CONFLICT(competition_id) DO UPDATE SET lead_target=excluded.lead_target, hot_lead_target=excluded.hot_lead_target, updated_at=excluded.updated_at`
        ).run(comp.id, to.lead_target, to.hot_lead_target, new Date().toISOString());
        recordCompetitionEvent(comp.id, "team_targets_changed", getAdminIdentity(req), { from, to, ...reqContext(req) });
      });
      // IMMEDIATE: stale() reads before the upsert (see the add above).
      try { runTxnWithMirrorBuffer(() => txn.immediate()); }
      catch (e) {
        if (e && e.message === "team_targets_changed") return res.status(409).json({ error: "The targets were changed by someone else after you opened them. Reload to see theirs.", code: "team_targets_changed" });
        throw e;
      }
    }
    res.json({ ok: true, targets: to, targets_updated_at: _targetsVersion(comp.id), changed });
  });

  // ── the reports, in the app ───────────────────────────────────────────────
  // The three report reads carry rivals' answers and free text, so a competitor
  // is refused them for the event they compete in (the full export's rule).
  app.get("/api/admin/competitions/:id/team-report", requireAdmin, reportReadLimiter, (req, res) => {
    const comp = _gate(req, res, { write: true });
    if (!comp) return;
    // `?peer=1`: only the managers' comparison, read when that view opens (it
    // rebuilds up to three other events' reports, so not on every open).
    if (req.query.peer === "1") {
      const t0 = process.hrtime.bigint();
      const peer = R.peerAverage(comp, scopedCompetitionIds(req));
      _reportSpan(req, "/api/admin/competitions/:id/team-report?peer=1", { peer_ms: _msSince(t0) });
      return res.json({ peer });
    }
    // Each lead's other events, only those this reader may open (operator
    // ruling, 15 Nov 2026; lib/event-team.js `reportForReader`).
    const tBuild = process.hrtime.bigint();
    const data = T.reportForReader(T.buildReportData(comp.id), T.canSeeScope(scopedCompetitionIds(req)));
    const buildMs = _msSince(tBuild);
    const tRest = process.hrtime.bigint();
    const members = T.listMembers(comp.id);
    const owners = T.leadOwners(members);
    // The split as it WOULD be (a read stores nothing): a lead's stored owner,
    // else the one the next report will give them (`owner_preview`).
    const split = T.splitLeads(data.leads, owners);
    const ownerName = new Map(members.map(m => [m.id, m.name]));
    // `contactable`: the one definition of a lead somebody may still reach
    // (lib/event-team.js `isContactable`), which the SDR tile and the managers'
    // row count, so the app never re-derives it (operator ruling, 14 Nov 2026).
    // One call of it, never a value of its own: a source arm in
    // tests/event-team-reports.spec.js pins every `contactable` sent.
    const leads = data.leads.map(l => ({
      ...l, company_key: undefined,
      contactable: T.isContactable(l),
      opener: suggestedOpener(l, comp.name),
      owner_member_id: split.get(l.user_id) || null,
      owner_name: ownerName.get(split.get(l.user_id)) || null,
      owner_preview: !l.owner_member_id,
    }));
    // Each persona's one call to action, the emails' own, so the app and the mail
    // cannot disagree about what to do next.
    const split_ = { ...data, leads: data.leads.map(l => ({ ...l, owner_member_id: split.get(l.user_id) || null })) };
    const _focus = (r) => ({ text: r.cta.text, why: r.cta.why || [] });
    const focus = {
      se: _focus(M.seReport(split_)), marketing: _focus(M.marketingReport(split_, split_.leads)),
      sales: _focus(M.salesReport(split_, split_.leads)), manager: _focus(M.managerReport(split_, owners, null)),
    };
    _reportSpan(req, "/api/admin/competitions/:id/team-report", { build_ms: buildMs, compose_ms: _msSince(tRest) });
    res.json({
      focus,
      comp: data.comp, targets: data.targets, qualifying: data.qualifying,
      summary: T.summarise(data), leads, accounts: T.accountsOf(data.leads),
      challenges: data.challenges, worst: data.worst, certificates: data.certificates, podium: data.podium,
      owners: owners.map(o => ({ id: o.id, name: o.name, role: o.role })),
    });
  });

  app.get("/api/admin/competitions/:id/team-report/preview", requireAdmin, reportReadLimiter, (req, res) => {
    const comp = _gate(req, res, { write: true });
    if (!comp) return;
    const persona = typeof req.query.persona === "string" ? req.query.persona : "";
    if (!PERSONAS.includes(persona)) return res.status(400).json({ error: `persona must be one of: ${PERSONAS.join(", ")}.`, code: "team_persona_invalid" });
    const members = T.listMembers(comp.id);
    const tBuild = process.hrtime.bigint();
    const data = T.buildReportData(comp.id);
    const buildMs = _msSince(tBuild);
    // Only the asked persona's messages are built: the managers' comparison
    // (three more events' reports) is read only for the managers' preview. Each
    // message names the other events its recipient may open, and the preview,
    // being read by THIS reader, never more than they may (`readerCanSee`).
    const tCompose = process.hrtime.bigint();
    const { messages } = R.composeRun(data, members.length ? members : [], "manual", { onlyPersona: persona, readerScope: scopedCompetitionIds(req) });
    _reportSpan(req, "/api/admin/competitions/:id/team-report/preview", { build_ms: buildMs, compose_ms: _msSince(tCompose) });
    const msg = messages.find(m => m.persona === persona);
    if (!msg) return res.json({ ok: true, persona, empty: true, reason: members.length ? "Nobody on the team receives this report, or there is nothing for them yet." : "This event has no team yet." });
    // `cta_link`: whether this recipient's email carries the call to action as a
    // button (their address opens the event) or in words (operator ruling 79).
    res.json({ ok: true, persona, to_role: T.ROLE_LABELS[msg.member.role], subject: msg.subject, text: msg.text, html: R.previewHtml(msg.html), cta: msg.cta, cta_link: msg.link !== false, attachment: msg.attachments ? msg.attachments[0].filename : null });
  });

  app.get("/api/admin/competitions/:id/team-report/leads.csv", requireAdmin, exportLimiter, (req, res) => {
    const comp = _gate(req, res, { write: true });
    if (!comp) return;
    // The file names each lead's other events only where this reader may open
    // them (operator ruling, 15 Nov 2026).
    const data = T.reportForReader(T.buildReportData(comp.id), T.canSeeScope(scopedCompetitionIds(req)));
    const buf = R.crmCsv(data, data.leads);
    try {
      recordOrphanedAuditEvent("export", "team-leads", "data_exported", getAdminIdentity(req), {
        ...reqContext(req), competition_id: comp.id, lead_count: data.leads.length,
      });
    } catch (e) { swallowed("event-team:leads-export-audit", e); }
    const slug = _slugForDownload(comp.name || "event");
    res.type("text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="leads-${slug}.csv"`);
    res.set("Cache-Control", "private, no-store");
    res.send(buf);
  });

  app.post("/api/admin/competitions/:id/team-report/send", requireAdmin, destructiveAdminLimit, csrfProtection, async (req, res) => {
    const comp = _gate(req, res, { write: true });
    if (!comp) return;
    const persona = req.body?.persona;
    if (persona !== undefined && persona !== null && (typeof persona !== "string" || !PERSONAS.includes(persona))) {
      return res.status(400).json({ error: `persona must be one of: ${PERSONAS.join(", ")}.`, code: "team_persona_invalid" });
    }
    const members = T.listMembers(comp.id);
    if (!members.length) return res.status(409).json({ error: "This event has no team to send reports to. Add the team first.", code: "team_empty" });
    // The Marketing and SDR reports can carry a lead file: asked for a send to
    // either role, by role, even when no lead makes a file.
    const dataRefusal = _reportDataRefusal(req, { crm: _sendCarriesFile(persona, members) });
    if (dataRefusal) return res.status(403).json(dataRefusal);
    if (require("../lib/competitions").isDryRunCompetition(comp.id)) return res.status(409).json({ error: "This event is tagged as a test or dry run, so its reports are not sent.", code: "team_dry_run" });
    const _authz = adminAuthzDenied(req);
    if (_authz) { const { status, ...body } = _authz; return res.status(status).json(body); }
    // One Send now per event at a time: a second press while the first is still
    // going out would send everyone a second full report (and lead file).
    if (R.manualRunInFlight(comp.id)) {
      return res.status(409).json({ error: "This event's reports are already being sent. Its History shows the result when they have gone.", code: "team_report_send_running" });
    }
    // Answered within the 10 s fan-out deadline: what is still going out carries
    // on (`deferred`), and its counts land on the event's History.
    const out = await R.runManualReport(comp.id, {
      actor: getAdminIdentity(req), context: { via: "send_now", ...(persona ? { persona } : {}), ...reqContext(req) }, onlyPersona: persona || null,
    });
    if (out.running) return res.status(409).json({ error: "This event's reports are already being sent. Its History shows the result when they have gone.", code: "team_report_send_running" });
    // The run failed part-way (lib/team-reports.js `runManualReport` recorded it
    // on the History): a failure the client says, never a count of what went.
    if (out.error) {
      return res.status(500).json({
        error: `The reports could not all be sent: something went wrong part-way (${out.sent} sent before it stopped). The event's History records what went out.`,
        code: "team_report_send_failed", sent: out.sent, failed: out.failed, refused: out.refused,
      });
    }
    res.json({ ok: true, ...out });
  });

  app.post("/api/admin/competitions/:id/leads/:userId/contacted", requireAdmin, csrfProtection, (req, res) => {
    const comp = _gate(req, res, { write: true });
    if (!comp) return;
    if (typeof req.body?.contacted !== "boolean") return res.status(400).json({ error: "contacted must be true or false.", code: "lead_contacted_invalid" });
    const member = db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, req.params.userId);
    if (!member) return res.status(404).json({ error: "That person is not in this event." });
    const contacted = req.body.contacted;
    const cur = db.prepare("SELECT contacted_at FROM event_leads WHERE competition_id=? AND user_id=?").get(comp.id, req.params.userId);
    const was = !!(cur && cur.contacted_at);
    if (was !== contacted) {
      const at = contacted ? new Date().toISOString() : null;
      const by = contacted ? getAdminIdentity(req) : null;
      const txn = db.transaction(() => {
        db.prepare(
          `INSERT INTO event_leads (competition_id, user_id, contacted_at, contacted_by) VALUES (?,?,?,?)
           ON CONFLICT(competition_id, user_id) DO UPDATE SET contacted_at=excluded.contacted_at, contacted_by=excluded.contacted_by`
        ).run(comp.id, req.params.userId, at, by);
        recordCompetitionEvent(comp.id, "lead_contacted", getAdminIdentity(req), { user_id: req.params.userId, contacted, ...reqContext(req) });
      });
      runTxnWithMirrorBuffer(() => txn());
    }
    // Whether the lead may still be reached now (`isContactable`, read after the
    // write), so the in-app counts follow the mark without re-deriving it. It
    // says whether they opted out, which only a role that reads the reports
    // may learn (`participants.view`, the report read's permission).
    const canRead = actorPermissions(req).perms.has("participants.view");
    res.json({ ok: true, contacted, changed: was !== contacted, ...(canRead ? { contactable: T.leadContactable(comp.id, req.params.userId) } : {}) });
  });
};
