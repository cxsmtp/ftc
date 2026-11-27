"use strict";

// THE INDEXES THAT FIND A USER'S SESSION ROWS, defined once.
//
// express_session is the store's own table (id, data JSON). Every sign-in calls
// invalidateOtherSessions("userId", id) (one session per principal), and the
// group/organiser paths call clearCompetitionSessionForUser. Both found the
// user's rows with `data LIKE '%"userId":"<id>"%'` — a scan of EVERY session
// row, so a 3000-person sign-in rush did O(N) work per sign-in, O(N²) in all
// (perf/RESULTS.md, "3000-user sign-in storm — FINAL").
//
// Two expression indexes answer it instead: the session's own `userId`, and an
// impersonation session's `impersonator.userId` (that session BELONGS to the
// admin — lib/sessions.js invalidateOtherSessions explains the ownership rule;
// the old LIKE matched both positions, and so does this pair). json_valid
// guards the expression so a malformed row indexes as NULL instead of failing
// the store's write. The query must repeat the expression byte for byte or the
// planner cannot use the index, which is why both db.js (CREATE INDEX) and
// lib/sessions.js (SELECT) take it from here. Requires nothing.

const SESSION_USER_ID_EXPR = "(CASE WHEN json_valid(data) THEN json_extract(data, '$.userId') END)";
const SESSION_IMPERSONATOR_ID_EXPR = "(CASE WHEN json_valid(data) THEN json_extract(data, '$.impersonator.userId') END)";

// The store creates the table on first use (express-session-better-sqlite3,
// same DDL); db.js creates it first so the indexes can be built at boot.
const SESSION_TABLE_DDL = "CREATE TABLE IF NOT EXISTS express_session (id TEXT PRIMARY KEY, data TEXT)";
const SESSION_INDEX_DDL = [
  `CREATE INDEX IF NOT EXISTS idx_express_session_user ON express_session(${SESSION_USER_ID_EXPR})`,
  `CREATE INDEX IF NOT EXISTS idx_express_session_impersonator ON express_session(${SESSION_IMPERSONATOR_ID_EXPR})`,
];
const SESSION_ROWS_BY_USER_SQL =
  `SELECT id, data FROM express_session WHERE ${SESSION_USER_ID_EXPR}=? OR ${SESSION_IMPERSONATOR_ID_EXPR}=?`;

module.exports = {
  SESSION_USER_ID_EXPR, SESSION_IMPERSONATOR_ID_EXPR,
  SESSION_TABLE_DDL, SESSION_INDEX_DDL, SESSION_ROWS_BY_USER_SQL,
};
