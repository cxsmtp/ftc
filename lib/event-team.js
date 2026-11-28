"use strict";

// THE EVENT TEAM AND ITS PERSONA REPORTS — the data half.
//
// An event has a TEAM of report recipients, per role, several per role:
//   se         — Solutions Engineer (runs the event; may also be its organiser)
//   marketing, sales (Account Exec), sdr
//   se_manager, marketing_manager, sales_manager — the manager CC per role
// Members are RECIPIENTS, not accounts: a name and an address, no platform
// login (they work from the email and its attached CSV). Whoever may edit the
// event adds or removes them, an event admin on their own events included
// (routes/event-team.js: events.edit, scoped). Every address must be on the
// superadmin-maintained ALLOWED-DOMAIN list (`settings.team_report_allowed_domains`),
// checked when a member is added AND again at every send (lib/team-reports.js).
//
// The reports are OBJECTIVE: every number here is computed from what the
// platform recorded (submissions, hints, feedback, memberships, user events) —
// nothing is estimated and there is no cost per lead anywhere.
//
// LEADS. Every person who took part (enrolled, not staff unless the event lets
// staff compete, not benchmark, not an admin tier, not blocked or denied) is a
// lead, classified:
//   • hot / warm / cold — lib/qualifying.js `classifyLead`, from their answers to
//     the event's qualifying questions;
//   • new / returning / possible duplicate — `returning` when they hold a
//     membership or activity in an EARLIER event (start before this one's);
//     `new` otherwise when their account was created for or through this event
//     (`registration_competition_id`, or created at/after the event was set up);
//     an older account with no earlier event is `returning` (already known).
//     `possible_duplicate` (a FLAG shown instead of new/returning) when another
//     person has the same normalised first + last name and company under a
//     different address. Never merged — two people can share a name.
//   • where from — how they arrived at THIS event (join link/QR, invitation by
//     whom, desk sign-up, import, group, added by an organiser), their first-seen
//     event and its source, and the other events they attended;
//   • opted out — their address is on the unsubscribe list: kept in the reports
//     but marked "do not email".
//
// SDR SPLIT. Leads are shared out among the event's SDRs (Marketing when the
// event has no SDR): round-robin, the next unowned lead going to the owner with
// the fewest, ties by the owner's place in the team, leads taken in user-id
// order — deterministic. The owner is STORED (`event_leads.owner_member_id`) when
// a report runs, so a late update keeps everyone's earlier share.

const crypto = require("crypto");
const db = require("../db");
const { now } = require("./time");
const { parseChoices, parseCorrectIds } = require("./choices");
const { qualifyingKeyOfTag, classifyLead, compareQualifyingKeys } = require("./qualifying");
const { earnsPlacement } = require("./badge");
const { lateEntryWindowOpen } = require("./late-entry");
const { answerSealed } = require("./answer-seal");
// The domain the records name a member's address by (the audit rows, the send
// ledger's removed form): lib/team-recipient.js, which db.js shares.
const { domainOf } = require("./team-recipient");

// The board a per_slot event ranks members with no session on (the mint ranks
// them event-wide: lib/leaderboard.js `boardSlotOf`), named where sessions are.
// In a per-session event, people who never chose a session are ranked on the
// event-wide board (as their certificates are), so their places are among
// everyone: the label says so ("ranked 4 in the whole event (no session chosen)").
const NO_SESSION_LABEL = "the whole event (no session chosen)";

const ROLES = Object.freeze(["se", "marketing", "sales", "sdr", "se_manager", "marketing_manager", "sales_manager"]);
const ROLE_LABELS = Object.freeze({
  se: "Solutions Engineer", marketing: "Marketing", sales: "Sales (Account Exec)", sdr: "SDR",
  se_manager: "SE manager", marketing_manager: "Marketing manager", sales_manager: "Sales manager",
});
const MANAGER_ROLES = new Set(["se_manager", "marketing_manager", "sales_manager"]);
const MAX_TEAM = 50;
const NAME_MAX = 120;
const EMAIL_MAX = 254;
const DOMAINS_SETTING = "team_report_allowed_domains";
const MAX_DOMAINS = 50;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// ─────────────────────────────────────────────────────────────────────────────
// The allowed-domain list (superadmin)
// ─────────────────────────────────────────────────────────────────────────────

function getAllowedDomains() {
  try {
    const raw = db.prepare("SELECT value FROM settings WHERE key=?").get(DOMAINS_SETTING)?.value;
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter(d => typeof d === "string" && DOMAIN_RE.test(d)) : [];
  } catch (_) { return []; }
}

/** Validate a list of domains: { error, code } or { domains } (lowercased, deduped). */
function validateAllowedDomains(list) {
  if (!Array.isArray(list)) return { error: "domains must be a list of domain names.", code: "team_domains_invalid" };
  if (list.length > MAX_DOMAINS) return { error: `At most ${MAX_DOMAINS} domains.`, code: "team_domains_too_many" };
  const out = [];
  for (const d of list) {
    if (typeof d !== "string") return { error: "Each domain must be text.", code: "team_domains_invalid" };
    const v = d.trim().toLowerCase().replace(/^@/, "");
    if (!DOMAIN_RE.test(v)) return { error: `"${v.slice(0, 80)}" is not a domain name (for example company.com).`, code: "team_domains_invalid" };
    if (!out.includes(v)) out.push(v);
  }
  return { domains: out };
}

function setAllowedDomains(domains) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(DOMAINS_SETTING, JSON.stringify(domains));
}

/** Is this address on the allowed list? A subdomain of a listed domain counts. */
function addressAllowed(email, domains = getAllowedDomains()) {
  const d = domainOf(email);
  if (!d) return false;
  return domains.some(x => d === x || d.endsWith("." + x));
}

// ─────────────────────────────────────────────────────────────────────────────
// Members
// ─────────────────────────────────────────────────────────────────────────────

/** Validate one member to add: { error, code } or { role, name, email }. */
function validateMember(body) {
  const b = body && typeof body === "object" ? body : {};
  if (typeof b.role !== "string" || !ROLES.includes(b.role)) return { error: `role must be one of: ${ROLES.join(", ")}.`, code: "team_role_invalid" };
  if (typeof b.name !== "string" || !b.name.trim()) return { error: "A team member needs a name.", code: "team_name_required" };
  const name = b.name.trim();
  if (name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) return { error: `A name is at most ${NAME_MAX} printable characters.`, code: "team_name_invalid" };
  if (typeof b.email !== "string") return { error: "A team member needs an email address.", code: "team_email_required" };
  const email = b.email.trim().toLowerCase();
  if (email.length > EMAIL_MAX || !domainOf(email)) return { error: "That is not an email address.", code: "team_email_invalid" };
  const domains = getAllowedDomains();
  if (!domains.length) return { error: "No email domains are allowed for event team reports yet. A superadmin adds them under Settings, Email.", code: "team_domain_list_empty" };
  if (!addressAllowed(email, domains)) return { error: `Event team reports go only to addresses at ${domains.join(", ")}. Ask a superadmin to add the domain under Settings, Email.`, code: "team_domain_not_allowed" };
  return { role: b.role, name, email };
}

function listMembers(competitionId) {
  return db.prepare("SELECT id, role, name, email, added_by, added_at FROM event_team_members WHERE competition_id=? ORDER BY added_at, id").all(competitionId);
}

/**
 * Operator ruling 79 (14 Nov 2026) — CAN THIS ADDRESS OPEN THE EVENT'S PAGE?
 * A report's one button opens the event in the admin console, which works only
 * for an account that signs in there and may open this event: found by its
 * PRIMARY address (the one that signs in), active as `requireAdmin` re-reads it
 * (not blocked or denied, verified and approved, an admin tier), holding
 * `events.view`, and with the event in scope (every event for an unscoped role,
 * an organiser grant otherwise). Anyone else is sent no button and no link: the
 * email says in words what to do (lib/team-report-mail.js `renderMail`).
 */
function memberOpensEvent(email, competitionId) {
  const { findUserByPrimary } = require("./account-lookup");
  const u = findUserByPrimary(db, typeof email === "string" ? email.trim() : "", "id, role, blocked, denied_at, verified, approved");
  if (!u || u.blocked || u.denied_at || !u.verified || !u.approved) return false;
  const rbac = require("./rbac");
  const cls = rbac.roleClass(u.role);
  if (cls === "none" || !rbac.roleHasPermission(u.role, "events.view")) return false;
  if (cls === "all") return true;
  return !!db.prepare("SELECT 1 FROM competition_admins WHERE competition_id=? AND user_id=?").get(competitionId, u.id);
}

function addMember(competitionId, m, addedBy) {
  if (db.prepare("SELECT COUNT(*) AS c FROM event_team_members WHERE competition_id=?").get(competitionId).c >= MAX_TEAM) {
    return { error: `An event team has at most ${MAX_TEAM} members.`, code: "team_too_large" };
  }
  if (db.prepare("SELECT 1 FROM event_team_members WHERE competition_id=? AND role=? AND email=?").get(competitionId, m.role, m.email)) {
    return { error: "That person already has this role on the event team.", code: "team_member_exists" };
  }
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO event_team_members (id, competition_id, role, name, email, added_by, added_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, competitionId, m.role, m.name, m.email, addedBy || null, now().toISOString());
  return { member: db.prepare("SELECT id, role, name, email, added_by, added_at FROM event_team_members WHERE id=?").get(id) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Targets
// ─────────────────────────────────────────────────────────────────────────────

function getTargets(competitionId) {
  const r = db.prepare("SELECT lead_target, hot_lead_target FROM event_team_settings WHERE competition_id=?").get(competitionId);
  return { lead_target: r ? r.lead_target : null, hot_lead_target: r ? r.hot_lead_target : null };
}

/** Each target: a whole number 0..100000, or null (none). undefined = unchanged. */
function validateTargets(body) {
  const b = body && typeof body === "object" ? body : {};
  const out = {};
  for (const k of ["lead_target", "hot_lead_target"]) {
    if (b[k] === undefined) continue;
    if (b[k] === null || b[k] === "") { out[k] = null; continue; }
    const n = typeof b[k] === "number" ? b[k] : (typeof b[k] === "string" && /^\d+$/.test(b[k].trim()) ? Number(b[k].trim()) : NaN);
    if (!Number.isInteger(n) || n < 0 || n > 100000) return { error: `${k} must be a whole number from 0 to 100000, or empty.`, code: "team_target_invalid" };
    out[k] = n;
  }
  const extra = Object.keys(b).find(k => k !== "lead_target" && k !== "hot_lead_target" && k !== "expectedUpdatedAt");
  if (extra !== undefined) return { error: `"${String(extra).slice(0, 40)}" is not a field of this request. Send { lead_target, hot_lead_target }.`, code: "team_target_unknown_key" };
  return { values: out };
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation helpers
// ─────────────────────────────────────────────────────────────────────────────

const _COMPANY_SUFFIXES = new Set(["inc", "incorporated", "ltd", "limited", "llc", "llp", "lp", "gmbh", "ag", "sa", "sas", "sarl", "bv", "nv", "plc", "corp", "corporation", "co", "company", "pty", "pte", "oy", "ab", "as", "spa", "srl", "kk", "the", "group", "holdings"]);
/** Company name for grouping: case, punctuation and common legal suffixes folded. */
function normaliseCompany(s) {
  const words = String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && _COMPANY_SUFFIXES.has(words[words.length - 1])) words.pop();
  while (words.length > 1 && words[0] === "the") words.shift();
  return words.join(" ");
}
function _normName(s) {
  return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// A simple, explainable ranking from title keywords (higher = more senior).
const _SENIORITY = [
  [6, /\b(chief|ceo|cto|ciso|cio|cso|cpo|coo|cfo|founder|co-founder|owner|president)\b/],
  [5, /\b(vp|svp|evp|vice president)\b/],
  [4, /\b(head|director)\b/],
  [3, /\b(principal|staff|lead|architect|manager)\b/],
  [2, /\b(senior|sr)\b/],
];
function seniorityOf(title) {
  const t = String(title || "").toLowerCase();
  for (const [score, re] of _SENIORITY) if (re.test(t)) return score;
  return t.trim() ? 1 : 0;
}

function _sourceLabel(ev) {
  if (!ev) return "Added by an organiser";
  if (ev.event_type === "self_enrolled") return "Join link or QR code";
  let d = {};
  try { d = ev.details ? JSON.parse(ev.details) : {}; } catch (_) { d = {}; }
  const via = d.via || "";
  if (via === "invitation" || via === "invitation_existing_account") return `Invitation by ${ev.changed_by}`;
  if (via === "desk_invite") return "Desk sign-up";
  if (via === "import") return "Import";
  if (via === "group_sync") return "Group membership";
  return `Added by ${ev.changed_by}`;
}

// The event is read only once `json_valid` holds: json_extract throws on stored
// text that is not JSON, and one such row failed every report on the event.
function _arrivalEvent(userId, competitionId) {
  return db.prepare(
    `SELECT event_type, changed_by, details FROM user_events
      WHERE user_id=? AND event_type IN ('self_enrolled','added_to_competition')
        AND (CASE WHEN json_valid(details) THEN json_extract(details, '$.competition_id') END)=?
      ORDER BY changed_at LIMIT 1`
  ).get(userId, competitionId) || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The report data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The event's qualifying challenges whose answers the reports read:
 * [{taskId, key, title, options:[{id,text}]}].
 *
 * A SEALED one is never read (sweep #87): the reports go to event-team members
 * and to addresses outside the platform, who see a sealed answer nowhere else,
 * and its author's reveal is not theirs. None can be made today (a qualifying
 * question is a pick-one Any answer, which can never be sealed), but an older
 * row tagged before that rule, or a sealed challenge an import overwrote into
 * another type, can carry both. It is still a qualifying question (it scores
 * nothing and stays out of the challenge figures: `_qualifyingRows`'s
 * `withheldIds`), it just has no answers to report.
 */
function qualifyingChallenges(competitionId) { return _qualifyingRows(competitionId).readable; }
function _qualifyingRows(competitionId) {
  const rows = db.prepare(
    `SELECT t.id, t.title, t.choices, t.answer_sealed, tt.tag FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id
       JOIN task_tags tt ON tt.task_id=t.id AND tt.tag LIKE 'qualifying:%'
      WHERE ct.competition_id=? AND t.active=1 AND t.status='published' ORDER BY tt.tag, t.id`
  ).all(competitionId);
  const seen = new Set(), readable = [], withheldIds = [];
  for (const r of rows) {
    const key = qualifyingKeyOfTag(r.tag);
    if (!key) continue;
    // Before the one-per-key choice, so an unsealed twin of a sealed one is read.
    if (answerSealed(r)) { withheldIds.push(r.id); continue; }
    if (seen.has(key)) continue;   // one challenge per key: the first by id
    seen.add(key);
    readable.push({ taskId: r.id, key, title: r.title, options: parseChoices(r.choices) });
  }
  // Built-in keys first, in their defined order; the organiser's own after.
  readable.sort((a, b) => compareQualifyingKeys(a.key, b.key));
  return { readable, withheldIds };
}

/** The people who count as leads, with their user rows. */
function _leadUsers(comp) {
  const users = db.prepare(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.secondary_email, u.company, u.title, u.country,
            u.role, u.created_at, u.registration_competition_id, cu.assigned_at
       FROM competition_users cu JOIN users u ON u.id=cu.user_id
      WHERE cu.competition_id=? AND COALESCE(u.blocked,0)=0 AND u.denied_at IS NULL
      ORDER BY u.id`
  ).all(comp.id);
  const rbac = require("./rbac");
  const { getStaffOrBenchmarkSet } = require("./user-tags");
  const off = getStaffOrBenchmarkSet(users.map(u => u.id), { staffCompete: !!comp.staff_compete });
  return users.filter(u => !off.has(u.id) && rbac.roleClass(u.role) === "none");
}

// Compared exactly, a search of the table's primary key: its one writer
// (routes/auth.js `_doUnsubscribe`) stores the unsubscribe token's
// `normaliseEmail` output, lower case, and lib/email.js `_isUnsubscribed`, the
// send suppression itself, compares the same way. The person's own addresses
// can be stored in any case, so they are lowered first.
const UNSUBSCRIBED_IN_LIST_SQL = "SELECT email FROM unsubscribed_emails WHERE email IN (SELECT value FROM json_each(?))";

function _unsubscribed(addresses) {
  const list = addresses.filter(Boolean).map(a => String(a).toLowerCase());
  if (!list.length) return new Set();
  const rows = db.prepare(UNSUBSCRIBED_IN_LIST_SQL).all(JSON.stringify(list));
  return new Set(rows.map(r => String(r.email).toLowerCase()));
}

/** Opted out of our email: either of the person's addresses is in `set` (`_unsubscribed`). */
function _optedOutOf(u, set) {
  return set.has(String(u.email).toLowerCase()) || (!!u.secondary_email && set.has(String(u.secondary_email).toLowerCase()));
}

// Everyone sharing a lead's normalised last name: the possible-duplicate
// candidates, folded in JS. The expression is db.js's idx_users_last_name_key,
// repeated byte for byte, or the planner scans every account.
const DUP_CANDIDATES_SQL =
  "SELECT id, first_name, last_name, company, email FROM users WHERE LOWER(TRIM(last_name)) IN (SELECT value FROM json_each(?))";

/**
 * The people's qualifying answers, by POSITION (`qAns`: userId -> {key: 0-based
 * position}) and by text (`qText`), from each person's LATEST answer per
 * question (a Quick question's answer can be changed while they can still play,
 * operator ruling 395: a later row replaces an earlier one; rowid breaks a
 * same-instant tie). The READABLE questions' answers only (`qchal`, from
 * `_qualifyingRows`): a withheld (sealed) one's are never read, so they are
 * never fetched either. The one reader, shared by the reports
 * (`buildReportData`) and the platform's marketing figures (`leadSignals`).
 */
function _qualifyingAnswers(competitionId, qchal, idsJson) {
  const qAns = new Map();
  const qText = new Map();
  if (qchal.length && idsJson !== "[]") {
    const rows = db.prepare(
      `SELECT s.user_id, s.task_id, s.answer_canonical, s.submitted_at FROM submissions s
        WHERE s.competition_id=? AND s.task_id IN (SELECT value FROM json_each(?)) AND s.user_id IN (SELECT value FROM json_each(?))
        ORDER BY s.submitted_at, s.rowid`
    ).all(competitionId, JSON.stringify(qchal.map(q => q.taskId)), idsJson);
    for (const r of rows) {
      const q = qchal.find(x => x.taskId === r.task_id);
      if (!q) continue;
      const picked = parseCorrectIds(r.answer_canonical);
      const pos = picked.length === 1 ? q.options.findIndex(o => o.id === picked[0]) : -1;
      if (pos < 0) continue;
      if (!qAns.has(r.user_id)) { qAns.set(r.user_id, {}); qText.set(r.user_id, {}); }
      qAns.get(r.user_id)[q.key] = pos;
      qText.get(r.user_id)[q.key] = q.options[pos].text;
    }
  }
  return { qAns, qText };
}

/**
 * The lead figures of one event without the rest of a report: who counts as a
 * lead (`_leadUsers`, the reports' own set), each one's signal by
 * `classifyLead` over the same answers the reports read (`_qualifyingAnswers`),
 * whether they said No to the follow-up question (`followUpDeclined`: out of
 * every lead list, as in the reports) and whether an organiser marked them
 * contacted (`event_leads.contacted_at`). `asked` is false for an event whose
 * readable qualifying questions are none: its people are no leads to anybody.
 * Read by the marketing figures (lib/marketing-analytics.js), which must agree
 * with the reports event by event and must not build a board to do it.
 */
function leadSignals(competitionId) {
  const { getCompetition } = require("./competitions");
  const comp = getCompetition(competitionId);
  if (!comp) return { asked: false, leads: [], declined: [] };
  const { readable: qchal } = _qualifyingRows(comp.id);
  if (!qchal.length) return { asked: false, leads: [], declined: [] };
  const users = _leadUsers(comp);
  const { qAns } = _qualifyingAnswers(comp.id, qchal, JSON.stringify(users.map(u => u.id)));
  const contacted = new Set(db.prepare("SELECT user_id FROM event_leads WHERE competition_id=? AND contacted_at IS NOT NULL").all(comp.id).map(r => r.user_id));
  const rows = users.map(u => {
    const positions = qAns.get(u.id) || {};
    return { user_id: u.id, positions, signal: classifyLead(positions), contacted: contacted.has(u.id) };
  });
  return { asked: true, leads: rows.filter(l => !followUpDeclined(l)), declined: rows.filter(followUpDeclined) };
}

/**
 * Everything the four persona reports (and the in-app Reports view) read, for
 * one event, computed now. `opts.sealedVisible(taskRow)` decides whether a
 * sealed challenge's wrong-answer text may be shown (default: never).
 */
function buildReportData(competitionId, opts = {}) {
  const { getCompetition, competitionStatus, competitionEffectiveEnd } = require("./competitions");
  const { eventPolicy } = require("./event-policy");
  const comp = getCompetition(competitionId);
  if (!comp) return null;
  const ranked = !!eventPolicy(comp).ranked;
  const leadsRaw = _leadUsers(comp);
  const ids = leadsRaw.map(u => u.id);
  const idsJson = JSON.stringify(ids);
  const { readable: qchal, withheldIds: qWithheld } = _qualifyingRows(comp.id);
  // Every qualifying challenge, a sealed one whose answers are not read included:
  // none of them is a scoring challenge in the figures below.
  const qTaskIds = new Set([...qchal.map(q => q.taskId), ...qWithheld]);

  const { qAns, qText } = _qualifyingAnswers(comp.id, qchal, idsJson);

  // Score and rank from the boards the event ranks on (lib/leaderboard.js
  // `rankedBoards`, the boards its certificates are placed on: each session on its
  // own in per_slot mode, and the late entrants' board), each person on the board
  // the mint ranks them on (operator ruling, 17 Nov 2026). Fresh: a report
  // persists nothing, but it must agree with the final standings. A session is
  // named only where there is more than one main board to tell apart.
  const board = new Map();       // userId -> { ...board row, session, late }
  const rankedRows = [];         // [{ session, late, rows }] in board order
  if (ranked) {
    try {
      const { buildLeaderboard, buildLateLeaderboard, rankedBoards } = require("./leaderboard");
      const { boards, slotOf } = rankedBoards(comp);
      const named = boards.filter(b => !b.late).length > 1;
      for (const b of boards) {
        const rows = (b.late ? buildLateLeaderboard : buildLeaderboard)(comp.id, b.timeslotId, { fresh: true })
          .filter(r => (slotOf.has(r.userId) ? slotOf.get(r.userId) : null) === b.timeslotId);
        const session = named && !b.late ? (b.timeslotId ? (b.timeslotName || "") : NO_SESSION_LABEL) : null;
        for (const r of rows) if (!board.has(r.userId)) board.set(r.userId, { ...r, session, late: b.late });
        rankedRows.push({ session, late: b.late, rows });
      }
    } catch (e) { require("./best-effort").swallowed("event-team:board", e); /* the reports still go without ranks */ }
  }
  // Anyone no board lists (every lead on an unranked event, an account the
  // boards leave out) is scored by the board's own rule, never a second sum: a
  // challenge unassigned since does not count, nor a second correct row.
  const scoreOf = require("./leaderboard").scoreTotals(comp.id, ids);

  // The challenges that count (not qualifying), with per-person activity.
  const tasks = db.prepare(
    `SELECT t.id, t.title, t.answer_type, t.choices, t.answer_sealed, t.created_by_id, ct.task_number
       FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id
      WHERE ct.competition_id=? AND t.active=1 AND t.status='published' ORDER BY ct.task_number, t.title`
  ).all(comp.id).filter(t => !qTaskIds.has(t.id));
  const taskIdsJson = JSON.stringify(tasks.map(t => t.id));
  const subs = (ids.length && tasks.length) ? db.prepare(
    `SELECT user_id, task_id, is_correct, answer, submitted_at FROM submissions
      WHERE competition_id=? AND task_id IN (SELECT value FROM json_each(?)) AND user_id IN (SELECT value FROM json_each(?))
      ORDER BY submitted_at`
  ).all(comp.id, taskIdsJson, idsJson) : [];

  const perTask = new Map(tasks.map(t => [t.id, { attempters: new Set(), solvers: new Set(), wrong: 0, wrongTexts: new Map() }]));
  const perUser = new Map(ids.map(id => [id, { solved: new Set(), wrongBy: new Map(), freeText: [] }]));
  for (const s of subs) {
    const pt = perTask.get(s.task_id), pu = perUser.get(s.user_id);
    if (!pt || !pu) continue;
    pt.attempters.add(s.user_id);
    pu.played = true;
    if (s.is_correct) { pt.solvers.add(s.user_id); pu.solved.add(s.task_id); }
    else {
      pt.wrong++;
      const k = String(s.answer || "").trim();
      if (k) pt.wrongTexts.set(k, (pt.wrongTexts.get(k) || 0) + 1);
      pu.wrongBy.set(s.task_id, (pu.wrongBy.get(s.task_id) || 0) + 1);
    }
  }
  // "Played" means answered anything, a qualifying question included. (The
  // challenge figures above and below stay scoring challenges only.)
  if (ids.length) {
    for (const r of db.prepare("SELECT DISTINCT user_id FROM submissions WHERE competition_id=? AND user_id IN (SELECT value FROM json_each(?))").all(comp.id, idsJson)) {
      const pu = perUser.get(r.user_id);
      if (pu) pu.played = true;
    }
  }
  // Free-text answers to `any` challenges (not pick-one), latest per challenge;
  // never a sealed one's (only an older row or an import can be one), as above.
  const anyTasks = tasks.filter(t => t.answer_type === "any" && parseChoices(t.choices).length < 2 && !answerSealed(t));
  for (const s of subs) {
    const t = anyTasks.find(x => x.id === s.task_id);
    if (!t || !s.is_correct) continue;
    const pu = perUser.get(s.user_id);
    const prev = pu.freeText.findIndex(f => f.taskId === t.id);
    const row = { taskId: t.id, title: t.title, answer: String(s.answer || "").slice(0, 500) };
    if (prev >= 0) pu.freeText[prev] = row; else pu.freeText.push(row);
  }

  // Ratings (task_feedback has no event id: only this event's people, on this event's challenges).
  const ratings = (ids.length && tasks.length) ? db.prepare(
    `SELECT task_id, rating FROM task_feedback WHERE task_id IN (SELECT value FROM json_each(?)) AND user_id IN (SELECT value FROM json_each(?))`
  ).all(taskIdsJson, idsJson) : [];
  const ratingBy = new Map();
  for (const r of ratings) {
    if (!ratingBy.has(r.task_id)) ratingBy.set(r.task_id, []);
    ratingBy.get(r.task_id).push(r.rating);
  }

  const sealedVisible = typeof opts.sealedVisible === "function" ? opts.sealedVisible : () => false;
  const challenges = tasks.map(t => {
    const pt = perTask.get(t.id);
    const attempters = pt.attempters.size, solvers = pt.solvers.size;
    const rate = attempters ? solvers / attempters : null;
    let topWrong = null;
    const mayShow = !answerSealed(t) || sealedVisible(t);
    for (const [text, n] of pt.wrongTexts) if (n >= 2 && (!topWrong || n > topWrong.count)) topWrong = { text: mayShow ? text.slice(0, 200) : null, count: n };
    const rs = ratingBy.get(t.id) || [];
    return {
      id: t.id, title: t.title, task_number: t.task_number || null,
      attempters, solvers, solve_rate: rate, wrong: pt.wrong,
      top_wrong: topWrong, sealed: answerSealed(t),
      flag: attempters >= 3 ? (rate > 0.9 ? "too_easy" : rate < 0.2 ? "too_hard" : null) : null,
      ratings: rs.length, avg_rating: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
      low_ratings: rs.filter(x => x <= 2).length,
    };
  });
  const worst = challenges.filter(c => c.attempters >= 3 && c.solve_rate !== null && (c.solve_rate < 0.2 || (c.top_wrong && c.top_wrong.count >= 3)))
    .sort((a, b) => a.solve_rate - b.solve_rate || b.wrong - a.wrong)[0] || null;

  // Earlier events, other events, first-seen.
  const startIso = comp.start_time;
  const memberships = ids.length ? db.prepare(
    `SELECT cu.user_id, c.id AS cid, c.name, c.start_time, cu.assigned_at FROM competition_users cu JOIN competitions c ON c.id=cu.competition_id
      WHERE cu.user_id IN (SELECT value FROM json_each(?)) ORDER BY c.start_time`
  ).all(idsJson) : [];
  const activityEarlier = ids.length ? new Set(db.prepare(
    `SELECT DISTINCT s.user_id FROM submissions s JOIN competitions c ON c.id=s.competition_id
      WHERE s.user_id IN (SELECT value FROM json_each(?)) AND s.competition_id != ? AND c.start_time < ?`
  ).all(idsJson, comp.id, startIso).map(r => r.user_id)) : new Set();
  const byUserMs = new Map();
  for (const m of memberships) { if (!byUserMs.has(m.user_id)) byUserMs.set(m.user_id, []); byUserMs.get(m.user_id).push(m); }

  // Possible duplicates: same normalised first+last+company as ANOTHER person, another address.
  const dupKeys = new Map();
  if (ids.length) {
    const keyOf = (u) => `${_normName(u.first_name)}|${_normName(u.last_name)}|${normaliseCompany(u.company)}`;
    const wanted = new Set(leadsRaw.map(keyOf));
    // Candidates: everyone sharing a normalised last name, folded in JS.
    const lastNames = [...new Set(leadsRaw.map(u => String(u.last_name || "").trim().toLowerCase()).filter(Boolean))];
    const cands = lastNames.length ? db.prepare(DUP_CANDIDATES_SQL).all(JSON.stringify(lastNames)) : [];
    for (const c of cands) {
      const k = keyOf(c);
      if (!wanted.has(k)) continue;
      if (!dupKeys.has(k)) dupKeys.set(k, new Set());
      dupKeys.get(k).add(String(c.email).toLowerCase());
    }
    for (const u of leadsRaw) u._dupKey = keyOf(u);
  }

  const optedOut = _unsubscribed(leadsRaw.flatMap(u => [u.email, u.secondary_email]));
  const stored = new Map(db.prepare("SELECT user_id, owner_member_id, first_reported_at, contacted_at, contacted_by FROM event_leads WHERE competition_id=?").all(comp.id).map(r => [r.user_id, r]));
  const compCreatedMs = Date.parse(comp.created_at || comp.start_time) || 0;

  const leadEvents = new Map();   // user id -> what `reportForReader` needs
  const leads = leadsRaw.map(u => {
    const ms = byUserMs.get(u.id) || [];
    const earlier = ms.filter(m => m.cid !== comp.id && m.start_time < startIso);
    const returning = earlier.length > 0 || activityEarlier.has(u.id);
    const fromThis = u.registration_competition_id === comp.id || (Date.parse(u.created_at) || 0) >= compCreatedMs;
    const dupSet = dupKeys.get(u._dupKey);
    const possibleDuplicate = !!(dupSet && [...dupSet].some(e => e !== String(u.email).toLowerCase()));
    const status = possibleDuplicate ? "possible_duplicate" : (returning ? "returning" : (fromThis ? "new" : "returning"));
    const first = ms[0] || null;
    const pu = perUser.get(u.id);
    const b = board.get(u.id);
    const struggles = [...pu.wrongBy.entries()].filter(([tid, n]) => n >= 2 && !pu.solved.has(tid))
      .map(([tid]) => (tasks.find(t => t.id === tid) || {}).title).filter(Boolean);
    const st = stored.get(u.id) || {};
    return {
      user_id: u.id, first_name: u.first_name, last_name: u.last_name, email: u.email,
      company: u.company || "", company_key: normaliseCompany(u.company), title: u.title || "", country: u.country || "",
      seniority: seniorityOf(u.title),
      answers: qText.get(u.id) || {}, positions: qAns.get(u.id) || {},
      signal: classifyLead(qAns.get(u.id) || {}),
      status, possible_duplicate: possibleDuplicate,
      source: _sourceLabel(_arrivalEvent(u.id, comp.id)),
      // The person's OTHER events, withheld until a reader is known: each
      // reader is given `reportForReader` (operator ruling, 15 Nov 2026).
      ..._leadEventFields(_leadEventsEntry(leadEvents, u.id, first, ms), comp, _SEES_NONE),
      opted_out: _optedOutOf(u, optedOut),
      score: b ? b.score : (scoreOf.get(u.id) || 0), rank: b ? b.rank : null,
      rank_session: b ? b.session : null, rank_late: !!(b && b.late),
      played: !!pu.played, solved: pu.solved.size, struggles, free_text: pu.freeText,
      owner_member_id: st.owner_member_id || null, first_reported_at: st.first_reported_at || null,
      contacted_at: st.contacted_at || null, contacted_by: st.contacted_by || null,
    };
  });

  // Certificates: issued / delivered / bounced.
  const certIssued = db.prepare("SELECT COUNT(*) AS c FROM achievement_badges WHERE competition_id=? AND revoked_at IS NULL").get(comp.id).c;
  const certRows = db.prepare("SELECT status, COUNT(*) AS c FROM certificate_emails WHERE competition_id=? GROUP BY status").all(comp.id);
  const certBy = Object.fromEntries(certRows.map(r => [r.status, r.c]));
  // Nobody stands on a podium for nothing: an event where no one scored has none.
  // One group per board the event ranks on that has a place (`rankedRows`), each
  // the places that earn a Gold, Silver or Bronze certificate there (lib/badge.js
  // `earnsPlacement`: the top three with points above zero). The late entrants'
  // board joins only once their window has closed: until then a late placing is
  // not final, and the automatic issue waits for it too.
  const lateOpen = (() => {
    try { return lateEntryWindowOpen(comp, competitionEffectiveEnd(comp), now().getTime()); }
    catch (e) { require("./best-effort").swallowed("event-team:late-window", e); return true; }
  })();
  const podium = [];
  for (const g of rankedRows) {
    if (g.late && lateOpen) continue;
    const places = g.rows.filter(r => earnsPlacement(r)).sort((a, b) => a.rank - b.rank).map(r => {
      const l = leads.find(x => x.user_id === r.userId);
      return { rank: r.rank, name: l ? `${l.first_name} ${l.last_name}`.trim() : (r.nickname || ""), company: l ? l.company : "", score: r.score };
    });
    if (places.length) podium.push({ session: g.session, late: g.late, places });
  }

  const effEnd = competitionEffectiveEnd(comp);
  // A "No" to the follow-up question takes the person out of every lead list
  // (`followUpDeclined`); the podium above, the event's results, still names them.
  const declined = leads.filter(followUpDeclined);
  const data = {
    comp: { id: comp.id, name: comp.name, event_kind: comp.event_kind, status: competitionStatus(comp), start_time: comp.start_time, effective_end: effEnd ? effEnd.toISOString() : null, ranked },
    targets: getTargets(comp.id),
    qualifying: qchal.map(q => ({ key: q.key, title: q.title, options: q.options.map(o => o.text) })),
    leads: leads.filter(l => !followUpDeclined(l)), declined, challenges, worst,
    certificates: { issued: certIssued, delivered: certBy.sent || 0, bounced: (certBy.failed || 0) + (certBy.unknown || 0) },
    podium,
  };
  _LEAD_EVENTS.set(data, leadEvents);
  return data;
}

// ─────────────────────────────────────────────────────────────
// What a lead row says about the person's OTHER events
// ─────────────────────────────────────────────────────────────
//
// A lead row names the other events the person joined (`other_events`) and the
// event where the platform first met them with who invited or added them there
// (`first_seen_event`, `first_seen_source`). Operator ruling, 15 Nov 2026: a
// reader is told only about the events they may open. In the app and the
// downloaded leads file that is the reader's own scope; in an email it is the
// RECIPIENT's account (the rule the email's button already follows), and a
// recipient with no account is told about this event only.
//
// So `buildReportData` names no other event at all (fail closed: a consumer
// that never asks for a reader gets nothing), and keeps what it needs to answer
// a reader in a WeakMap keyed by the data object, never on the rows a route
// might spread to the wire. `reportForReader(data, canSee)` returns a copy whose
// rows answer for that reader.
const _LEAD_EVENTS = new WeakMap();
const _SEES_NONE = () => false;
const ANOTHER_EVENT = "Another event";

function _leadEventsEntry(into, userId, first, ms) {
  const entry = {
    ms: ms.map(m => ({ cid: m.cid, name: m.name })),
    first: first ? { cid: first.cid, name: first.name } : null,
    // Who invited or added them to their first event, read once here, said only
    // to a reader who may open that event.
    firstSource: first ? _sourceLabel(_arrivalEvent(userId, first.cid)) : null,
  };
  into.set(userId, entry);
  return entry;
}

function _leadEventFields(entry, comp, canSee) {
  if (!entry) return { first_seen_event: comp.name, first_seen_source: null, other_events: [] };
  const sees = (cid) => cid === comp.id || !!canSee(cid);
  const first = entry.first;
  return {
    first_seen_event: !first ? comp.name : (sees(first.cid) ? first.name : ANOTHER_EVENT),
    first_seen_source: first && sees(first.cid) ? entry.firstSource : null,
    other_events: entry.ms.filter(m => m.cid !== comp.id && canSee(m.cid)).map(m => m.name),
  };
}

/** A copy of the report data whose lead rows answer for a reader who may open
 *  exactly the events `canSee(eventId)` admits (this event always). */
function reportForReader(data, canSee) {
  if (!data) return data;
  const map = _LEAD_EVENTS.get(data) || new Map();
  const out = { ...data, leads: data.leads.map(l => ({ ...l, ..._leadEventFields(map.get(l.user_id), data.comp, canSee) })) };
  _LEAD_EVENTS.set(out, map);
  return out;
}

/** `canSee` for a scope as lib/event-admin.js `scopedCompetitionIds` answers it:
 *  null is every event, an array those events. */
function canSeeScope(ids) {
  if (ids === null || ids === undefined) return () => true;
  const set = new Set(ids);
  return (cid) => set.has(cid);
}

/** The events an email RECIPIENT may open, by `memberOpensEvent`'s rule: null
 *  every event, [] none (no account, or one that may not open events), else the
 *  events their scoped account organises. */
function memberEventScope(email) {
  const { findUserByPrimary } = require("./account-lookup");
  const u = findUserByPrimary(db, typeof email === "string" ? email.trim() : "", "id, role, blocked, denied_at, verified, approved");
  if (!u || u.blocked || u.denied_at || !u.verified || !u.approved) return [];
  const rbac = require("./rbac");
  const cls = rbac.roleClass(u.role);
  if (cls === "none" || !rbac.roleHasPermission(u.role, "events.view")) return [];
  if (cls === "all") return null;
  return db.prepare("SELECT competition_id FROM competition_admins WHERE user_id=?").all(u.id).map(r => r.competition_id);
}

/**
 * A "NO" TO THE FOLLOW-UP QUESTION LEAVES THE PERSON OUT OF EVERY LEAD LIST
 * (operator ruling, 17 Nov 2026): the built-in `follow_up` quick question's
 * second option, read by POSITION like `classifyLead` (its options keep their
 * places once answered). `buildReportData` never puts them in `data.leads`, so
 * no report, file, card, owner split or count of leads holds them; they are kept
 * in `data.declined`, read only for how many joined and played and what everyone
 * answered (`summarise`). Their latest answer counts, so a change to Yes makes
 * them a lead again.
 */
function followUpDeclined(l) { return !!(l && l.positions && l.positions.follow_up === 1); }

/**
 * Whether the event has a report team: its participants' details then reach that
 * team, and the join landing says so (`shares_leads` on the token preview;
 * operator ruling, 17 Nov 2026).
 */
function sharesLeads(competitionId) {
  return !!db.prepare("SELECT 1 AS x FROM event_team_members WHERE competition_id=? LIMIT 1").get(competitionId);
}

/** Counts per status/signal, for the scorecard and the marketing summary. */
function summarise(data) {
  const s = { leads: data.leads.length, hot: 0, warm: 0, cold: 0, new: 0, returning: 0, possible_duplicate: 0, opted_out: 0, contacted_hot: 0 };
  for (const l of data.leads) {
    s[l.signal]++; s[l.status]++;
    if (l.opted_out) s.opted_out++;
    if (l.signal === "hot" && l.contacted_at) s.contacted_hot++;
  }
  // Who joined and played, and what everyone answered, count the people who said
  // No to a follow-up too: they are out of the lead lists, not out of the event.
  const everyone = data.leads.concat(data.declined || []);
  s.joined = everyone.length;
  s.played = everyone.filter(l => l.played).length;
  s.declined = (data.declined || []).length;
  // Over the scoring challenges anyone tried; null when there is nothing to average.
  const tried = (data.challenges || []).filter(c => c.solve_rate != null);
  const rated = (data.challenges || []).filter(c => c.ratings);
  s.avg_solve_rate = tried.length ? tried.reduce((a, c) => a + c.solve_rate, 0) / tried.length : null;
  s.avg_rating = rated.length ? rated.reduce((a, c) => a + c.avg_rating, 0) / rated.length : null;
  // Qualifying breakdown: per question, the count per option (author order).
  s.breakdown = data.qualifying.map(q => ({
    key: q.key, title: q.title,
    counts: q.options.map(text => ({ text, n: everyone.filter(l => l.answers[q.key] === text).length })),
    unanswered: everyone.filter(l => l.answers[q.key] === undefined).length,
  }));
  return s;
}

/** Group leads by normalised company: [{company, people, top_title, best, signal}] strongest first. */
function accountsOf(leads) {
  const by = new Map();
  for (const l of leads) {
    const k = l.company_key || "(no company)";
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(l);
  }
  const rank = { hot: 3, warm: 2, cold: 1 };
  const out = [...by.entries()].map(([k, ls]) => {
    const senior = ls.slice().sort((a, b) => b.seniority - a.seniority)[0];
    const best = ls.slice().sort((a, b) => rank[b.signal] - rank[a.signal])[0];
    const counts = {};
    for (const l of ls) for (const [q, v] of Object.entries(l.answers)) { counts[q] = counts[q] || new Map(); counts[q].set(v, (counts[q].get(v) || 0) + 1); }
    return {
      company: ls.map(l => l.company).find(Boolean) || "(no company)", key: k, people: ls.length,
      top_title: senior ? senior.title : "", signal: best ? best.signal : "cold",
      hot: ls.filter(l => l.signal === "hot").length,
      answers: best ? best.answers : {},
      positions: best ? best.positions : {},
    };
  });
  out.sort((a, b) => rank[b.signal] - rank[a.signal] || b.hot - a.hot || b.people - a.people || a.company.localeCompare(b.company));
  return out;
}

/**
 * A lead somebody may still reach out to: not marked contacted, and not opted
 * out of our email (operator rulings, 14 Nov 2026). The ONE meaning of
 * "waiting": the SDR's report counts and picks its first call from these, the
 * 48-hour reminder counts only these (its SDR shares and Marketing's count), and
 * the managers' scorecard and call to action count only these. The in-app views
 * read it per lead (`contactable` on GET …/team-report, and the contacted mark's
 * answer, `leadContactable`), never a copy.
 */
function isContactable(l) { return !l.contacted_at && !l.opted_out; }

/**
 * `isContactable` for one person in the event, read now (the answer the contacted
 * mark gives the in-app views): their stored mark and the reports' own opted-out
 * test. False for an account that is gone. It returns `isContactable`'s verdict,
 * never one of its own (a source arm in tests/event-team-reports.spec.js).
 */
function leadContactable(competitionId, userId) {
  const u = db.prepare("SELECT email, secondary_email FROM users WHERE id=?").get(userId);
  if (!u) return false;
  const st = db.prepare("SELECT contacted_at FROM event_leads WHERE competition_id=? AND user_id=?").get(competitionId, userId);
  return isContactable({ contacted_at: st ? st.contacted_at : null, opted_out: _optedOutOf(u, _unsubscribed([u.email, u.secondary_email])) });
}

/** The owners leads are shared among: SDRs, else Marketing. */
function leadOwners(members) {
  const sdr = members.filter(m => m.role === "sdr");
  return sdr.length ? sdr : members.filter(m => m.role === "marketing");
}

/**
 * Share unowned leads among the owners (round-robin by fewest, ties by team
 * order, leads in user-id order). Pure: returns Map(userId -> ownerId) for every
 * lead, keeping an existing owner that is still on the team.
 */
function splitLeads(leads, owners) {
  const out = new Map();
  if (!owners.length) return out;
  const ownerIds = owners.map(o => o.id);
  const load = new Map(ownerIds.map(id => [id, 0]));
  const sorted = leads.slice().sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
  for (const l of sorted) if (l.owner_member_id && load.has(l.owner_member_id)) { out.set(l.user_id, l.owner_member_id); load.set(l.owner_member_id, load.get(l.owner_member_id) + 1); }
  for (const l of sorted) {
    if (out.has(l.user_id)) continue;
    let pick = ownerIds[0];
    for (const id of ownerIds) if (load.get(id) < load.get(pick)) pick = id;
    out.set(l.user_id, pick);
    load.set(pick, load.get(pick) + 1);
  }
  return out;
}

/** Persist owners (and the reported stamp when `markReported`). Inside the caller's write. */
function persistLeadOwners(competitionId, leads, ownerMap, { markReported = false, at = now().toISOString() } = {}) {
  const up = db.prepare(
    `INSERT INTO event_leads (competition_id, user_id, owner_member_id, first_reported_at) VALUES (?,?,?,?)
     ON CONFLICT(competition_id, user_id) DO UPDATE SET owner_member_id=excluded.owner_member_id,
       first_reported_at=COALESCE(event_leads.first_reported_at, excluded.first_reported_at)`
  );
  for (const l of leads) up.run(competitionId, l.user_id, ownerMap.get(l.user_id) || null, markReported ? at : null);
}

module.exports = {
  ROLES, ROLE_LABELS, MANAGER_ROLES, DOMAINS_SETTING,
  getAllowedDomains, validateAllowedDomains, setAllowedDomains, addressAllowed, domainOf,
  validateMember, listMembers, addMember, memberOpensEvent,
  getTargets, validateTargets,
  normaliseCompany, seniorityOf, qualifyingChallenges,
  buildReportData, leadSignals, DUP_CANDIDATES_SQL, UNSUBSCRIBED_IN_LIST_SQL, reportForReader, canSeeScope, memberEventScope, summarise, followUpDeclined, sharesLeads, accountsOf, isContactable, leadContactable, leadOwners, splitLeads, persistLeadOwners,
};
