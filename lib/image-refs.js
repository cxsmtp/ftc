"use strict";

// THE MANIFEST OF IMAGE REFERENCES: every text or blob column of every table,
// each with a decision about whether it can name a stored image
// (lib/image-sweep.js reads the `scan` and `ids` columns; lib/sanitise.js
// deleteAvatarImage asks the same list before reclaiming a replaced avatar).
//
//   scan    the column may hold `/api/images/<uuid>` inside its text;
//   ids     the column holds a bare `images.id`;
//   exempt  it cannot name a picture anyone is shown, for the reason given.
//
// A missing decision is a deleted picture: an image named only by a column the
// sweep does not read is reclaimed a week after it was stored. So
// tests/image-sweep.spec.js reads the schema of a booted database and fails on
// a column with no decision, on a column decided twice and on an entry naming a
// column that no longer exists. A doubtful column is scanned: scanning a column
// that never holds a picture only keeps an image longer.
//
// PURE — requires nothing, so a spec may require it at module scope.

// The reasons, named once. A column's reason is the claim a reviewer checks.
const WHY = Object.freeze({
  id: "an identifier, key or foreign key the server writes; never a path",
  time: "a timestamp the server writes",
  enum: "a value from a fixed set (or a JSON of fixed keys) the server validates",
  secret: "a hash, code or token the server writes",
  plain: "plain text drawn escaped wherever it is shown, never as an image",
  record: "a record of something that happened, shown as text (History, Audit, logs), never drawn as an image; a challenge's restore reads task_versions.snapshot, which is scanned",
  answer: "a participant's answer, shown as text and graded, never drawn as an image",
  machine: "machine-written bookkeeping (a job, a ledger, a realm read), never shown as an image",
  store: "the image store itself",
  session: "session state: no image is held in a session",
});

// table -> { scan: path-scanned columns, ids: columns holding a bare image id,
//            exempt: { <WHY key>: columns } }. Space-separated names.
const IMAGE_REF_HOLDERS = Object.freeze({
  achievement_badges: { ids: "image_id", exempt: { id: "token user_id competition_id timeslot_id public_code", time: "created_at revoked_at shared_at date_snapshot", enum: "basis", plain: "nickname_snapshot name_snapshot name_match_snapshot" } },
  attempt_grants: { exempt: { id: "user_id task_id competition_id", time: "updated_at" } },
  certificate_dispatch_jobs: { exempt: { id: "competition_id user_id", time: "due_at enqueued_at", machine: "reason last_error" } },
  certificate_emails: { exempt: { id: "badge_token user_id competition_id", time: "next_attempt_at first_attempt_at sent_at updated_at", machine: "status last_error" } },
  certificate_share_links: { exempt: { secret: "id_hash", id: "badge_token", time: "created_at expires_at used_at" } },
  challenge_events: { exempt: { id: "id user_id task_id competition_id timeslot_id", enum: "event_type", record: "details", time: "occurred_at" } },
  competition_admins: { exempt: { id: "competition_id user_id granted_by", time: "granted_at" } },
  competition_events: { exempt: { id: "id competition_id changed_by", enum: "event_type", record: "details", time: "changed_at" } },
  competition_group_exclusions: { exempt: { id: "competition_id user_id excluded_by", time: "excluded_at" } },
  competition_groups: { exempt: { id: "competition_id group_id assigned_by", time: "assigned_at" } },
  competition_presence: { exempt: { id: "competition_id user_id", time: "first_seen_at last_seen_at" } },
  competition_tags: { exempt: { id: "competition_id", plain: "tag" } },
  competition_tasks: { exempt: { id: "competition_id task_id assigned_by assigned_by_id task_number", time: "assigned_at" } },
  competition_timeslots: { exempt: { id: "id competition_id", plain: "name", time: "start_time ended_at created_at updated_at" } },
  competition_user_absences: { exempt: { id: "user_id competition_id timeslot_id", time: "removed_at returned_at login_time assigned_at" } },
  competition_users: { exempt: { id: "competition_id user_id timeslot_id cxone_user_id assigned_by", plain: "cxone_username", time: "login_time last_login_time assigned_at" } },
  // The certificate design layer is validated text and colours today; scanned so
  // a design field that names a picture later is covered without a decision.
  competitions: { scan: "certificate_config", exempt: {
    id: "id", plain: "name cxone_group_name trusted_network_ips",
    time: "start_time ended_at created_at updated_at deadline_at late_entry_deadline_at",
    enum: "leaderboard_mode event_kind registration_field_policy time_basis event_look",
    secret: "cxone_api_key self_enroll_token join_code" } },
  cxone_realm_accounts: { exempt: {
    id: "cxone_user_id user_id competition_id claim_token", plain: "iam_origin tenant created_username override_by",
    time: "provenance_at recorded_at pending_since first_failed_at next_attempt_at override_at transferred_at claimed_at given_up_at",
    secret: "created_email_sha",
    machine: "provenance instance_origin deletion_source last_error held_reason override_reason created_baseline held_signal" } },
  email_proofs: { exempt: { id: "email_norm join_comp_id invitation_id", secret: "code_hash", time: "created_at expires_at last_sent_at", machine: "origin" } },
  email_reminders: { exempt: { id: "user_id competition_id timeslot_id claim_token", time: "send_at claimed_at created_at" } },
  entity_status_observations: { exempt: { id: "entity_type entity_id", enum: "last_status", time: "observed_at" } },
  event_leads: { exempt: { id: "competition_id user_id owner_member_id contacted_by", time: "first_reported_at contacted_at" } },
  event_team_members: { exempt: { id: "id competition_id added_by", enum: "role", plain: "name email", time: "added_at" } },
  event_team_settings: { exempt: { id: "competition_id", time: "updated_at" } },
  // An author writes a template's description and settings and a spawn copies
  // them into an event: scanned.
  event_templates: { scan: "description settings", exempt: { id: "id created_by_id builtin_key", plain: "name", enum: "event_kind", time: "created_at updated_at deleted_at", machine: "task_ids" } },
  express_session: { exempt: { id: "id", session: "data" } },
  // A frozen team board copies each member's avatar (lib/leaderboard.js
  // _saveGroupSnapshot) and serves it for good once the event has ended.
  group_leaderboard_snapshots: { scan: "board", exempt: { id: "competition_id slot_key", time: "created_at" } },
  group_members: { exempt: { id: "group_id user_id added_by", time: "added_at" } },
  groups: { exempt: { id: "id name_key created_by created_by_id", plain: "name", time: "created_at" } },
  hint_reveals: { exempt: { id: "competition_id user_id task_id timeslot_id", time: "revealed_at updated_at" } },
  images: { exempt: { store: "id data mime_type created_at" } },
  invitations: { exempt: { id: "id competition_ids group_ids invited_by user_id invited_by_id", plain: "email", time: "created_at used_at" } },
  orphan_events: { exempt: { id: "id scope scope_id changed_by competition_id timeslot_id", enum: "event_type", record: "details", time: "changed_at" } },
  revoked_sessions: { exempt: { id: "id", time: "revoked_at expires_at" } },
  role_permissions: { exempt: { id: "role_id", enum: "permission" } },
  roles: { exempt: { id: "id created_by_id", plain: "label description", enum: "scope_mode", time: "created_at updated_at" } },
  // Every setting: the global certificate design, the platform look, and any
  // value a later setting stores.
  settings: { scan: "value", exempt: { id: "key" } },
  settings_events: { exempt: { id: "id setting_key changed_by", enum: "event_type", record: "details", time: "changed_at" } },
  submissions: { exempt: { id: "id user_id task_id competition_id timeslot_id", answer: "answer answer_canonical", time: "submitted_at updated_at" } },
  task_attachments: { exempt: { id: "id task_id created_by storage_path", plain: "display_name original_name", secret: "sha256", time: "created_at detached_at" } },
  task_attachments_staging: { exempt: { id: "id admin_id storage_path", plain: "display_name original_name", secret: "sha256", time: "created_at" } },
  task_feedback: { exempt: { id: "user_id task_id", time: "updated_at" } },
  task_tags: { exempt: { id: "task_id", plain: "tag" } },
  // A version snapshot is the challenge as it was, which "restore to version"
  // writes back: an image only an old version names must survive.
  task_versions: { scan: "snapshot", exempt: { id: "id task_id changed_by", time: "changed_at", enum: "change_type", record: "details" } },
  // The three rich-text fields (the SPA's renderRich draws them). The answer key
  // and the options are drawn as text.
  tasks: { scan: "description explanation hint", exempt: {
    id: "id created_by_id owner_competition_id copied_from_task_id topic_id", plain: "title author_name author_linkedin attachment_url tags",
    enum: "difficulty answer_type status", answer: "correct_answer choices", time: "updated_at" } },
  // A topic is a plain name (lib/topics.js); nothing in it can name a picture.
  topics: { exempt: { id: "id created_by created_by_id", plain: "name", time: "created_at updated_at" } },
  team_report_jobs: { exempt: { id: "competition_id end_key", enum: "kind", time: "due_at enqueued_at", machine: "last_error" } },
  team_report_runs: { exempt: { id: "competition_id end_key", enum: "kind", time: "ran_at" } },
  team_report_sends: { exempt: { id: "competition_id end_key recipient", enum: "kind persona status", time: "created_at sent_at" } },
  timeslot_events: { exempt: { id: "id timeslot_id changed_by", enum: "event_type", record: "details", time: "changed_at" } },
  unsubscribed_emails: { exempt: { id: "email", plain: "reason user_agent ip", time: "unsubscribed_at" } },
  user_events: { exempt: { id: "id user_id changed_by", enum: "event_type", record: "details", time: "changed_at" } },
  user_tags: { exempt: { id: "user_id", plain: "tag" } },
  users: { scan: "avatar", exempt: {
    id: "id email secondary_email pending_email invitation_id active_competition_id registration_competition_id pending_self_enroll_comp_id login_code_comp_id linkedin_sub invited_by approved_by denied_by",
    plain: "first_name last_name nickname company title personal_title phone country timezone job_function city linkedin_url denied_reason certificate_given_name certificate_family_name",
    enum: "registered_via role profile_policy login_code_via login_method",
    secret: "pending_email_code verify_code password_hash reset_code login_code_hash linkedin_last_callback_key",
    time: "pending_email_code_at verify_code_at approved_at reset_code_at login_time last_login_time invited_at failed_login_first locked_until created_at denied_at password_set_at left_event_at self_enroll_grace_until login_code_at first_verified_at updated_at" } },
});

const _words = (s) => (s ? String(s).trim().split(/\s+/).filter(Boolean) : []);

// [{table, column, kind:'scan'|'ids'|'exempt', reason?}] — the manifest flattened,
// for the sweep and for the test that holds it to the schema.
function imageRefDecisions() {
  const out = [];
  for (const [table, d] of Object.entries(IMAGE_REF_HOLDERS)) {
    for (const c of _words(d.scan)) out.push({ table, column: c, kind: "scan" });
    for (const c of _words(d.ids)) out.push({ table, column: c, kind: "ids" });
    for (const [why, cols] of Object.entries(d.exempt || {})) {
      for (const c of _words(cols)) out.push({ table, column: c, kind: "exempt", reason: why });
    }
  }
  return out;
}

module.exports = { IMAGE_REF_HOLDERS, IMAGE_REF_EXEMPT_REASONS: WHY, imageRefDecisions };
