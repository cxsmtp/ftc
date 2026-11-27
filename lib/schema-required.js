// v8.3.39 (external audit) — THE SCHEMA A RUNNING SERVER IS ENTITLED TO ASSUME.
//
// Almost every migration in `db.js` is wrapped in a try/catch that logs and
// carries on. That posture is deliberate and mostly right: a failure there is
// usually one degraded feature, and refusing to start would turn a survivable
// upgrade hiccup into an outage. But the catch cannot tell the two apart, and
// several of those columns are named explicitly by write paths —
// `submissions.answer_canonical` by every multiple-choice submit,
// `users.login_code_hash` by every sign-in code — so a swallowed
// ALTER leaves the platform serving traffic while those operations 500. The one
// signal that should have caught it could not: `/readyz` probes two tables by
// primary key, which says nothing about a COLUMN or an INDEX.
//
// It is not hypothetical. v8.3.11 shipped a `CREATE UNIQUE INDEX` positioned
// above the ALTER that adds its column: it failed with `no such column`, was
// swallowed, and was not retried until the next process start — months, in a
// container — so the platform ran with no uniqueness constraint on a
// participant-facing join code and nothing anywhere said so.
//
// So the boot ASSERTS the schema and readiness reports the answer. The posture
// is the documented liveness/readiness split (v7.15.11), not a fatal exit: the
// orchestrator drains the instance while the operator keeps the shell they need
// to fix it.
//
// PURE — this module requires NOTHING, so a spec may require it at module scope
// (the `lib/scanner-classify.js` precedent) and drive the whole matrix against a
// throwaway database with no server in the way.
//
// ---------------------------------------------------------------------------
// WHAT BELONGS IN THE MANIFEST, and why it is exactly this and not "everything".
//
// A column declared in a base `CREATE TABLE` cannot be missing: that block is
// NOT wrapped in a try, so a failure there throws out of `db.js` and the process
// never starts. The columns that CAN be missing are precisely the ones added by
// an `ALTER TABLE … ADD COLUMN`, which is a mechanically extractable set — and a
// scanner (`functional-core-b.api.spec.js > Docs hygiene`) requires every one of
// them to appear here or in EXEMPT_COLUMNS with a reason. Coverage is therefore
// not a promise in prose; a new ALTER goes red until somebody DECIDES about it
// (the `BACKUP_COVERS` shape, v7.21.34).
//
// INDEXES are split on a line that is about correctness rather than taste: a
// UNIQUE index enforces an invariant the application relies on and its absence
// is a data-integrity hole, while a plain index is a performance property whose
// absence makes the platform slow rather than wrong. So every unique index is
// required and no plain one is.
"use strict";

// table -> columns added by an ALTER in db.js that the application requires.
const REQUIRED_COLUMNS = Object.freeze({
  achievement_badges: ["basis", "date_snapshot", "late_entrant", "name_match_snapshot",
                       "name_snapshot", "public_code", "score_snapshot", "shared_at"],
  challenge_events: ["impersonated"],
  competition_timeslots: ["updated_at"],
  competition_user_absences: ["assigned_at", "login_time"],
  competition_users: ["cxone_username", "cxone_user_id", "direct_assigned"],
  // Every create writes `created_email_sha` (lib/cxone-ledger.js recordCreated)
  // and the runner's email-change hold reads it; a creating job writes
  // `created_baseline` (recordCreationBaseline) and the runner's adoption check
  // reads it; the runner's holds write `held_signal` and the superadmin's list
  // reads it.
  cxone_realm_accounts: ["created_baseline", "created_email_sha", "held_signal"],
  competitions: ["attempt_cap", "auto_end_on_all_solved", "certificate_config", "cxone_disabled", "deadline_at",
                 "event_kind", "event_look", "event_look_locked", "group_leaderboard_enabled", "join_code",
                 "late_entry_deadline_at", "late_entry_enabled",
                 "linkedin_signup_enabled", "measure_presence",
                 "registration_field_policy", "reveal_answers_on_end",
                 "self_enroll_allow_instant",
                 "self_enroll_enabled", "self_enroll_token", "staff_compete", "time_basis",
                 "trusted_network_ips", "updated_at"],
  competition_tasks: ["assigned_by_id"],
  // Template protection (v8.17.0): delete, protect, restore and reset write them.
  event_templates: ["builtin_key", "deleted_at", "protected"],
  groups: ["created_by_id", "name_key"],
  hint_reveals: ["updated_at"],
  invitations: ["group_ids", "invited_by_id"],
  submissions: ["answer_canonical", "updated_at"],
  tasks: ["answer_sealed", "attempt_cap", "choices", "copied_from_task_id", "created_by_id", "owner_competition_id", "updated_at"],
  task_versions: ["details"],
  users: ["certificate_family_name", "certificate_given_name", "city", "denied_at", "denied_by",
          "denied_reason", "first_verified_at", "job_function", "left_event_at",
          "linkedin_last_callback_key", "linkedin_sub", "login_code_at", "login_code_hash",
          "login_code_comp_id", "login_code_sends", "login_code_via", "login_method", "password_set_at", "pending_email",
          "pending_email_code", "pending_email_code_at", "pending_self_enroll_comp_id",
          "personal_title", "phone", "profile_policy", "registration_competition_id",
          "self_enroll_grace_until", "updated_at"],
});

// A DECISION per column that db.js ADDS and this manifest does not require.
// `table.column` -> the reason. Never a blanket carve-out; the scanner requires
// a real reason and refuses an entry naming a column db.js does not add.
//
// EMPTY TODAY. Every column an ALTER adds is currently required. Nearly every one
// is named by code; four are named by none and are still listed as required:
// `users.linkedin_sub` and `users.linkedin_last_callback_key` (LinkedIn sign-in
// is gone), and the retired switches `competitions.linkedin_signup_enabled` and
// `competitions.self_enroll_allow_instant` (the routes refuse their names in a
// request body; no code reads the columns). The shape of a column that belongs
// here is one added for a feature the platform can serve without.
//
// A column db.js DROPS needs no entry — the scanner
// excludes those structurally, so a decision recorded by hand could not go stale
// there and naming the column in a manifest would only re-plant a string the
// ceiling-removal scanner is right to forbid (v8.2.2).
const EXEMPT_COLUMNS = Object.freeze({});

// Unique indexes the application relies on for uniqueness enforcement.
const REQUIRED_INDEXES = Object.freeze([
  "idx_comp_self_enroll_token",
  // RBAC — two roles reading the same on the role menu.
  "idx_roles_label",
  "uq_achievement_badges_public_code",
  "uq_achievement_badges_user_comp_ts",
  "uq_competitions_join_code",
  // v8.15.0 — two templates whose names read the same in a list.
  "uq_event_templates_name_nocase",
  "uq_groups_name_nocase",
  "uq_invitations_live_email",
  "uq_task_attachments_dname",
  "uq_users_email_nocase",
  "uq_users_linkedin_sub",
  "uq_users_nickname_nocase",
  "uq_users_secondary_email_nocase",
]);

// A DECISION per unique index db.js creates and this manifest does not require.
const EXEMPT_INDEXES = Object.freeze({
  uq_groups_name_key:
    "DELIBERATELY conditional. db.js creates it only when the backfill leaves no " +
    "case-variant collisions, because a pair that was legal before v7.15.7 would " +
    "violate it; the app-level check holds the line and the operator is told to rename. " +
    "Requiring it here would drain a box for a state the migration is designed to accept.",
});

/**
 * Compare the live schema against the manifest.
 *
 * Returns `{ ok, missingColumns: ["users.linkedin_sub", …], missingIndexes: [...], error }`.
 * A read failure is reported as NOT ok with `error` set — "the schema could not
 * be read" is not evidence that it is fine.
 *
 * @param {{prepare: Function}} db  an open better-sqlite3 handle
 */
function verifySchema(db) {
  const missingColumns = [];
  const missingIndexes = [];
  try {
    for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
      let present;
      try {
        present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
      } catch (_) {
        // An unreadable table is reported as every one of its columns missing —
        // over-reporting here is the safe direction, and the boot log names the
        // table either way.
        for (const c of cols) missingColumns.push(`${table}.${c}`);
        continue;
      }
      // PRAGMA on a table that does not exist returns an EMPTY list rather than
      // throwing, so this is also the missing-table case.
      for (const c of cols) if (!present.has(c)) missingColumns.push(`${table}.${c}`);
    }
    const idx = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name)
    );
    for (const name of REQUIRED_INDEXES) if (!idx.has(name)) missingIndexes.push(name);
  } catch (e) {
    return { ok: false, missingColumns, missingIndexes, error: (e && e.message) || String(e) };
  }
  return {
    ok: missingColumns.length === 0 && missingIndexes.length === 0,
    missingColumns, missingIndexes, error: null,
  };
}

module.exports = {
  REQUIRED_COLUMNS, REQUIRED_INDEXES, EXEMPT_COLUMNS, EXEMPT_INDEXES, verifySchema,
};
