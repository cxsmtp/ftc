"use strict";

// THE ONE INDEXED "which account holds this address" LOOKUP.
//
// The sign-in doors ask only the PRIMARY half (`findUserByPrimary`: the code
// request, the redeem, the password door, the sign-in-method lookup); the audit
// mirror's actor enrichment (`_resolveActor`, lib/audit.js) asks both. Each used
// to spell it
//   WHERE LOWER(email)=LOWER(?) OR LOWER(secondary_email)=LOWER(?)
// which no index can serve: SQLite scanned the whole users table for every
// call, so a 3000-person sign-in rush did O(N) work per request — O(N²) in all
// (perf/RESULTS.md, "3000-user sign-in storm — FINAL"). Rewriting it as one
// `email=? COLLATE NOCASE OR secondary_email=? COLLATE NOCASE` still scans: the
// planner will not union the full primary index with the PARTIAL secondary one.
// Two point lookups, primary first, each answered by its own UNIQUE NOCASE
// index (`uq_users_email_nocase`, `uq_users_secondary_email_nocase`), do.
//
// Same answer as the LOWER() form: SQLite's LOWER and NOCASE both fold ASCII
// only, addresses are ASCII by rule (normaliseEmail, the NOCASE unique indexes),
// and no two accounts can hold one address in either slot (emailIsTaken checks
// both slots), so at most one row matches — primary first just makes "which
// row" deterministic where the OR left it to the plan.
//
// A LIST of addresses (Raw logs' actor names, server.js) is one search of the
// same primary index, `email COLLATE NOCASE IN (SELECT value FROM json_each(?))`,
// primary only like `findUserByPrimary`. The collation goes on the COLUMN: on
// the value side (`IN (SELECT value COLLATE NOCASE …)`), or with none, the
// planner takes the BINARY unique index and the match follows case.
//
// Pure: the caller passes its db handle (routes, lib/login-code's lazy db_(),
// lib/audit) so this module requires nothing and fits anywhere in the graph.

const _COLUMNS_RE = /^(\*|[a-z_]+(, ?[a-z_]+)*)$/;
const PRIMARY_SQL = (cols) => `SELECT ${cols} FROM users WHERE email=? COLLATE NOCASE LIMIT 1`;
const SECONDARY_SQL = (cols) => `SELECT ${cols} FROM users WHERE secondary_email=? COLLATE NOCASE LIMIT 1`;
const PRIMARY_LIST_SQL = (cols) => `SELECT ${cols} FROM users WHERE email COLLATE NOCASE IN (SELECT value FROM json_each(?))`;

/**
 * The account whose primary or secondary address is `email` (ASCII
 * case-insensitive), or null. `columns` is a fixed column list from the
 * caller's source ("*" by default), never user input.
 */
function findUserByAddress(db, email, columns = "*") {
  if (typeof email !== "string" || !email) return null;
  if (!_COLUMNS_RE.test(columns)) throw new Error("findUserByAddress: bad column list");
  return db.prepare(PRIMARY_SQL(columns)).get(email)
    || db.prepare(SECONDARY_SQL(columns)).get(email)
    || null;
}

/**
 * The account whose PRIMARY address is `email`, or null. Every sign-in door
 * asks this, never `findUserByAddress`: the secondary address is an unconfirmed
 * claim anyone can make about any address no account holds (EMAIL_RULES.md), so
 * it never signs anybody in, never receives a sign-in code and never claims an
 * invitation (operator ruling, 11 Nov 2026).
 */
function findUserByPrimary(db, email, columns = "*") {
  if (typeof email !== "string" || !email) return null;
  if (!_COLUMNS_RE.test(columns)) throw new Error("findUserByPrimary: bad column list");
  return db.prepare(PRIMARY_SQL(columns)).get(email) || null;
}

/**
 * Every account whose PRIMARY address is one of `emails` (ASCII
 * case-insensitive): one index search for the whole list. Non-string and empty
 * entries are dropped; none left is [].
 */
function findUsersByPrimaryList(db, emails, columns = "*") {
  const list = (Array.isArray(emails) ? emails : []).filter(e => typeof e === "string" && e);
  if (!list.length) return [];
  if (!_COLUMNS_RE.test(columns)) throw new Error("findUsersByPrimaryList: bad column list");
  return db.prepare(PRIMARY_LIST_SQL(columns)).all(JSON.stringify(list));
}

module.exports = { findUserByAddress, findUserByPrimary, findUsersByPrimaryList, PRIMARY_SQL, SECONDARY_SQL, PRIMARY_LIST_SQL };
