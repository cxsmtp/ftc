"use strict";

// THE STAFF-TEAMS DIRECTORY — the data half (routes/staff-teams.js serves it).
//
// A platform-wide list of named teams of colleagues: the people an event's
// Team & reports sends its reports to, or who organise its events, kept once so
// a whole team can be added to an event in one step (routes/event-team.js
// `POST …/team/staff-team`, routes/competitions.js `POST …/admins/staff-team`).
//
// A MEMBER is a name, an address and an optional DEFAULT ROLE — one of the event
// team's roles (lib/event-team.js ROLES), used when the team is added to an
// event's Team & reports. Members are recipients, never accounts: an address may
// belong to an account, but that is read where it matters (`accountFor`, by the
// PRIMARY address, the one that signs in), never stored, so an account made or
// renamed later is found without anything to keep in step.
//
// The rules are the platform's own: an address passes `isValidEmailFormat`
// (lib/util.js) and the event team's own shape (`domainOf`, which the event
// team's validator requires), a name holds no control character
// (`profileTextOk`), a team name is unique ignoring case
// (`uq_staff_teams_name_nocase`). Caps bound what one request can fan out to:
// MAX_TEAMS teams, MAX_MEMBERS members a team (the event team's own cap, so a
// whole team always fits an empty event team).

const crypto = require("crypto");
const { isValidEmailFormat, profileTextOk } = require("./util");
const { domainOf } = require("./team-recipient");
const { ROLES, ROLE_LABELS } = require("./event-team");
const { now } = require("./time");

const MAX_TEAMS = 200;
const MAX_MEMBERS = 50;
const TEAM_NAME_MAX = 80;
const MEMBER_NAME_MAX = 120;
const EMAIL_MAX = 254;

/** A team name's refusal ({ error, code }), or { name } trimmed. */
function validateTeamName(v) {
  if (typeof v !== "string" || !v.trim()) return { error: "A staff team needs a name.", code: "staff_team_name_required" };
  const name = v.trim();
  if (name.length > TEAM_NAME_MAX) return { error: `A staff team's name is at most ${TEAM_NAME_MAX} characters.`, code: "staff_team_name_invalid" };
  if (!profileTextOk(name)) return { error: "A staff team's name cannot contain control characters (line breaks, tabs or other invisible codes).", code: "staff_team_name_invalid" };
  return { name };
}

/**
 * One member as sent: { error, code, field } or { name, email, default_role }.
 * `default_role` absent, null or "" means none.
 */
function validateMember(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  if (typeof b.name !== "string" || !b.name.trim()) return { error: "A team member needs a name.", code: "staff_member_name_required", field: "name" };
  if (!profileTextOk(b.name)) return { error: "A name cannot contain control characters (line breaks, tabs or other invisible codes).", code: "profile_text_control_chars", field: "name" };
  const name = b.name.trim();
  if (name.length > MEMBER_NAME_MAX) return { error: `A name is at most ${MEMBER_NAME_MAX} characters.`, code: "staff_member_name_invalid", field: "name" };
  if (typeof b.email !== "string" || !b.email.trim()) return { error: "A team member needs an email address.", code: "staff_member_email_required", field: "email" };
  const email = b.email.trim().toLowerCase();
  if (email.length > EMAIL_MAX || !isValidEmailFormat(email) || !domainOf(email)) return { error: "That is not an email address.", code: "staff_member_email_invalid", field: "email" };
  const r = b.default_role;
  if (r !== undefined && r !== null && r !== "" && (typeof r !== "string" || !ROLES.includes(r))) {
    return { error: `default_role must be one of: ${ROLES.join(", ")}, or empty.`, code: "staff_member_role_invalid", field: "default_role" };
  }
  return { name, email, default_role: r ? r : null };
}

const _MEMBER_COLS = "id, team_id, name, email, default_role, added_at, updated_at";

function listTeams(db) {
  return db.prepare("SELECT id, name, created_at, updated_at FROM staff_teams ORDER BY name COLLATE NOCASE, id").all();
}
function getTeam(db, id) {
  if (typeof id !== "string") return null;
  return db.prepare("SELECT id, name, created_at, updated_at FROM staff_teams WHERE id=?").get(id) || null;
}
function teamByName(db, name) {
  return db.prepare("SELECT id, name FROM staff_teams WHERE name=? COLLATE NOCASE").get(String(name).trim()) || null;
}
function listMembers(db, teamId) {
  return db.prepare(`SELECT ${_MEMBER_COLS} FROM staff_team_members WHERE team_id=? ORDER BY name COLLATE NOCASE, id`).all(teamId);
}
/** Every team's members, keyed by team id (one read for the directory). */
function membersByTeam(db) {
  const out = new Map();
  for (const m of db.prepare(`SELECT ${_MEMBER_COLS} FROM staff_team_members ORDER BY name COLLATE NOCASE, id`).all()) {
    if (!out.has(m.team_id)) out.set(m.team_id, []);
    out.get(m.team_id).push(m);
  }
  return out;
}
function getMember(db, teamId, memberId) {
  if (typeof memberId !== "string") return null;
  return db.prepare(`SELECT ${_MEMBER_COLS} FROM staff_team_members WHERE id=? AND team_id=?`).get(memberId, teamId) || null;
}

/**
 * The account a member's address signs in as: found by the PRIMARY address
 * (lib/account-lookup.js `findUserByPrimary`, an index search), never the
 * secondary, which signs nobody in. Read where it is used, never stored.
 */
function accountFor(db, email, cols = "id, role") {
  const { findUserByPrimary } = require("./account-lookup");
  return findUserByPrimary(db, typeof email === "string" ? email.trim() : "", cols) || null;
}

function insertTeam(db, name, createdBy) {
  const id = crypto.randomUUID();
  const at = now().toISOString();
  db.prepare("INSERT INTO staff_teams (id, name, created_by, created_at, updated_at) VALUES (?,?,?,?,?)").run(id, name, createdBy || null, at, at);
  return getTeam(db, id);
}

function touchTeam(db, teamId) {
  db.prepare("UPDATE staff_teams SET updated_at=? WHERE id=?").run(now().toISOString(), teamId);
}

/** Add one member (validated): { member } or { error, code } (full, a repeat address). */
function insertMember(db, teamId, m, addedBy) {
  if (db.prepare("SELECT COUNT(*) AS c FROM staff_team_members WHERE team_id=?").get(teamId).c >= MAX_MEMBERS) {
    return { error: `A staff team has at most ${MAX_MEMBERS} members.`, code: "staff_team_full" };
  }
  if (db.prepare("SELECT 1 FROM staff_team_members WHERE team_id=? AND email=?").get(teamId, m.email)) {
    return { error: "That address is already in this team.", code: "staff_member_exists" };
  }
  const id = crypto.randomUUID();
  const at = now().toISOString();
  db.prepare("INSERT INTO staff_team_members (id, team_id, name, email, default_role, added_by, added_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, teamId, m.name, m.email, m.default_role, addedBy || null, at, at);
  touchTeam(db, teamId);
  return { member: getMember(db, teamId, id) };
}

/** The wire shape of one member. `hasAccount`: whether to say if the address signs in. */
function memberWire(db, m, { hasAccount = false } = {}) {
  const out = {
    id: m.id, name: m.name, email: m.email, domain: domainOf(m.email),
    default_role: m.default_role || null, default_role_label: m.default_role ? ROLE_LABELS[m.default_role] : null,
    added_at: m.added_at, updated_at: m.updated_at,
  };
  if (hasAccount) out.has_account = !!accountFor(db, m.email, "id");
  return out;
}

module.exports = {
  MAX_TEAMS, MAX_MEMBERS, TEAM_NAME_MAX, MEMBER_NAME_MAX, EMAIL_MAX,
  validateTeamName, validateMember,
  listTeams, getTeam, teamByName, listMembers, membersByTeam, getMember, accountFor,
  insertTeam, touchTeam, insertMember, memberWire,
};
