"use strict";
const Database = require("better-sqlite3");
const path     = require("path");
const fs       = require("fs");
const crypto   = require("node:crypto");
const { swallowed } = require("./lib/best-effort");

// v8.8.26 — REQUIRED, no fallback. The next line opens the database at require
// time, so a process that guessed this path would attach to a live deployment's
// SQLite file silently. The refusal and its reasoning live in lib/data-dir.js,
// which requires `path` and nothing else — db.js must NOT reach lib/config,
// which exits without BASE_URL and would break every schema-only harness.
const DATA_DIR = require("./lib/data-dir").requireDataDir();
// Owner-only from birth: the directory holds the database (sessions, every
// account) and the HMAC secrets. A fresh database file is created 0600 before
// SQLite opens it, so it never exists world-readable under the default umask;
// an existing file's mode is the operator's and is left alone.
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const DB_PATH = path.join(DATA_DIR, "hackathon.db");
if (!fs.existsSync(DB_PATH)) {
  try { fs.closeSync(fs.openSync(DB_PATH, "wx", 0o600)); }
  catch (e) { if (e.code !== "EEXIST") throw e; }
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

// Schema — executed unconditionally with `CREATE TABLE IF NOT EXISTS` so a
// fresh install gets the full layout; an already-created DB is a no-op.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                    TEXT PRIMARY KEY,
    first_name            TEXT NOT NULL,
    last_name             TEXT NOT NULL,
    nickname              TEXT NOT NULL UNIQUE,
    company               TEXT,
    title                 TEXT,
    personal_title        TEXT,
    phone                 TEXT,
    email                 TEXT NOT NULL UNIQUE,
    secondary_email       TEXT,
    pending_email         TEXT,
    pending_email_code    TEXT,
    pending_email_code_at TEXT,
    avatar                TEXT DEFAULT 'default1',
    verify_code           TEXT,
    verify_code_at        TEXT,
    verified              INTEGER DEFAULT 0,
    approved              INTEGER DEFAULT 0,
    approved_at           TEXT,
    approved_by           TEXT,
    blocked               INTEGER DEFAULT 0,
    password_hash         TEXT,
    reset_code            TEXT,
    reset_code_at         TEXT,
    login_time            TEXT,
    last_login_time       TEXT,
    country               TEXT,
    timezone              TEXT,
    job_function          TEXT,
    city                  TEXT,
    linkedin_url          TEXT,
    registered_via        TEXT DEFAULT 'manual',
    role                  TEXT DEFAULT 'participant',
    active_competition_id TEXT,
    invitation_id         TEXT,
    invited_at            TEXT,
    invited_by            TEXT,
    failed_login_count    INTEGER DEFAULT 0,
    failed_login_first    TEXT,
    locked_until          TEXT,
    created_at            TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    description     TEXT,
    difficulty      TEXT NOT NULL CHECK(difficulty IN ('easy','medium','hard')),
    answer_type     TEXT NOT NULL DEFAULT 'text' CHECK(answer_type IN ('text','file','json','choice','any')),
    correct_answer  TEXT NOT NULL,
    explanation     TEXT,
    hint            TEXT,
    attachment_url  TEXT,
    status          TEXT DEFAULT 'published',
    author_name     TEXT,
    author_linkedin TEXT,
    locked          INTEGER DEFAULT 0,
    tags            TEXT DEFAULT '',
    active          INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id),
    task_id        TEXT NOT NULL REFERENCES tasks(id),
    competition_id TEXT,
    timeslot_id    TEXT,
    answer         TEXT,
    is_correct     INTEGER DEFAULT 0,
    points_delta   INTEGER DEFAULT 0,
    submitted_at   TEXT NOT NULL,
    -- v6.10.83: bumped whenever is_correct / points_delta is rewritten by
    -- task recalculation. Admin Submissions pagination reads MAX(updated_at)
    -- as a drift fingerprint — a change between page 1 and page N surfaces
    -- a staleness banner. Nullable so pre-v6.10.83 rows back-fill in the
    -- migration block below; INSERT paths always set it.
    updated_at     TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hint_reveals (
    competition_id  TEXT NOT NULL DEFAULT '',
    user_id         TEXT NOT NULL,
    task_id         TEXT NOT NULL,
    timeslot_id     TEXT,
    points_deducted INTEGER NOT NULL DEFAULT 0,
    revealed_at     TEXT NOT NULL,
    -- v6.10.83: bumped whenever points_deducted is rescaled by task
    -- recalculation (see server.js recalc path). Paired with
    -- submissions.updated_at as the drift fingerprint the admin
    -- Submissions tab reads to detect mid-walk UPDATE mutations.
    updated_at      TEXT,
    PRIMARY KEY (competition_id, user_id, task_id)
  );

  -- v6.12.0: gap-exclusion for solveTimeMs on remove+re-add.
  -- When an admin removes a participant from a competition (the
  -- DELETE at server.js' /api/admin/competitions/:id/users/:uid path)
  -- AND that user had competition_users.login_time already set
  -- (i.e. they were actively competing, not just pre-assigned), a
  -- row opens here with removed_at=now(), returned_at=NULL. On the
  -- later bulk-assign re-add, returned_at is set to now(), and
  -- buildLeaderboardEntries' solveTimeMs calculation subtracts the
  -- SUM of (returned_at - removed_at) intervals per user/comp so
  -- the gap during which the user had no system access doesn't
  -- count against their time-to-solve. Exists per-user-per-comp —
  -- timeslot_id pins which session the user was in (since v6.12.0
  -- enforces "cannot switch session after re-add" at the select-
  -- timeslot layer). Rows are never deleted (they're the audit
  -- trail of absence intervals).
  CREATE TABLE IF NOT EXISTS competition_user_absences (
    user_id        TEXT NOT NULL,
    competition_id TEXT NOT NULL,
    timeslot_id    TEXT,
    removed_at     TEXT NOT NULL,
    returned_at    TEXT,
    PRIMARY KEY (user_id, competition_id, removed_at)
  );

  CREATE TABLE IF NOT EXISTS user_tags (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (user_id, tag)
  );

  /* Participant groups — first-class, reusable, many-to-many with users.
     Distinct from user_tags: groups are named entities that persist even
     when empty and can be bound to competitions for live-synced membership. */
  CREATE TABLE IF NOT EXISTS groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    -- ext-audit v7.15.7: case-folded canonical name (lib/util _groupNameKey).
    -- Stored + indexed so uniqueness lookups are an indexed probe instead of a
    -- full scan + per-row normalise in JS — which the participant import ran
    -- INSIDE its per-participant group loop, i.e. O(memberships x groups) of
    -- synchronous event-loop work. Backfilled by the migration below.
    name_key   TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    added_at TEXT,
    added_by TEXT,
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS task_tags (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (task_id, tag)
  );

  CREATE TABLE IF NOT EXISTS competition_tags (
    competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    tag            TEXT NOT NULL,
    PRIMARY KEY (competition_id, tag)
  );

  CREATE TABLE IF NOT EXISTS images (
    id         TEXT PRIMARY KEY,
    data       BLOB NOT NULL,
    mime_type  TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  -- The orphaned-image sweep (lib/image-sweep.js) finds images past its grace
  -- period through this index alone: created_at sits after the blob in each row.
  CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at, id);

  -- v7.1.0: LinkedIn "I placed top-3" share badges. One point-in-time snapshot
  -- per (user, competition[, timeslot]); the unguessable token addresses the
  -- public /badge/<token> OpenGraph page. image_id → images: a copy of the share
  -- PNG that mints once stored, served only when the renderer is missing; no mint
  -- stores one any more, so every newer certificate holds '' (sweep #43).
  CREATE TABLE IF NOT EXISTS achievement_badges (
    token             TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    competition_id    TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    timeslot_id       TEXT,
    rank              INTEGER NOT NULL,
    image_id          TEXT NOT NULL,
    nickname_snapshot TEXT NOT NULL,
    -- ext-audit v7.15.6: the score AS MINTED. The PNG is a frozen point-in-time
    -- artifact, but the certificate PDF re-rendered from live data, so once a
    -- competition was revived (extend duration / re-add participants) and scores
    -- moved, one token could serve a PNG saying "1st Place - 300 pts" and a PDF
    -- saying "1st Place - 280 pts". NULL only for badges minted before this
    -- column existed, which fall back to the recompute.
    score_snapshot    INTEGER,
    -- v7.21.28: the "Salutation First Last" this badge was MINTED with. The name
    -- is drawn into the PNG, which never changes, so the PDF and the public page
    -- must read the same frozen value rather than the live profile.
    name_snapshot     TEXT,
    created_at        TEXT NOT NULL,
    revoked_at        TEXT
  );
  -- Idempotency: at most one badge per (user, competition, timeslot). NULL
  -- timeslot (global leaderboard mode) is normalised to '' so the uniqueness
  -- holds (SQLite treats NULLs as distinct in a plain unique index).
  -- v8.1.0 (PR 27) — PARTIAL on revoked_at, so a revoked badge does not block a
  -- re-mint at the INDEX level. The refusal that decides whether a re-mint is
  -- allowed at all lives in routes/badge.js; see the migration note below.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_achievement_badges_user_comp_ts
    ON achievement_badges(user_id, competition_id, IFNULL(timeslot_id, '')) WHERE revoked_at IS NULL;
  -- v7.2.x (audit, perf) — cover the competition_id FK so a competition delete's
  -- ON DELETE CASCADE doesn't full-scan achievement_badges. (user_id is already
  -- the leading column of the unique index above.)
  CREATE INDEX IF NOT EXISTS idx_achievement_badges_comp ON achievement_badges(competition_id);

  CREATE TABLE IF NOT EXISTS competitions (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    start_time        TEXT NOT NULL,
    duration_minutes  INTEGER NOT NULL,
    ended_at          TEXT,
    ended_manually    INTEGER NOT NULL DEFAULT 0,
    leaderboard_mode  TEXT DEFAULT 'per_slot',
    cxone_api_key     TEXT,
    cxone_group_name  TEXT,
    created_at        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS competition_users (
    competition_id   TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    timeslot_id      TEXT,
    login_time       TEXT,
    last_login_time  TEXT,
    ended_popup_seen INTEGER DEFAULT 0,
    cxone_username   TEXT,
    assigned_by      TEXT,
    assigned_at      TEXT,
    direct_assigned  INTEGER DEFAULT 1,
    PRIMARY KEY (competition_id, user_id)
  );

  /* Live binding: a group attached to a competition. Reconciliation keeps
     competition_users in sync as the group's membership changes. */
  CREATE TABLE IF NOT EXISTS competition_groups (
    competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    group_id       TEXT NOT NULL REFERENCES groups(id)       ON DELETE CASCADE,
    assigned_by    TEXT,
    assigned_at    TEXT,
    PRIMARY KEY (competition_id, group_id)
  );

  /* Manual-removal tombstones: a participant the admin pulled out of a
     competition they were ALSO in via a bound group. Reconciliation skips
     re-adding anyone listed here until an explicit direct re-assign clears it. */
  CREATE TABLE IF NOT EXISTS competition_group_exclusions (
    competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    user_id        TEXT NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
    excluded_at    TEXT,
    excluded_by    TEXT,
    PRIMARY KEY (competition_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS competition_tasks (
    competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    task_number    TEXT,
    assigned_by    TEXT,
    assigned_at    TEXT,
    PRIMARY KEY (competition_id, task_id)
  );

  /* v7.12.3 (audit M4) — snapshot-at-end freeze of the GROUP leaderboard (Team
     Rankings). Groups are reusable across competitions, so a post-end membership
     edit would otherwise retroactively rewrite a finished comp's team board. The
     board's computed rows are frozen here the first time it is read after the comp
     is fully ended; slot_key is the timeslot id, or '__global__' for the null
     (global-mode) board. Cleared on comp revive (see invalidateGroupLeaderboardSnapshot). */
  CREATE TABLE IF NOT EXISTS group_leaderboard_snapshots (
    competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    slot_key       TEXT NOT NULL,
    board          TEXT,
    created_at     TEXT NOT NULL,
    PRIMARY KEY (competition_id, slot_key)
  );

  CREATE TABLE IF NOT EXISTS email_reminders (
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    timeslot_id    TEXT DEFAULT '',
    send_at        TEXT NOT NULL,
    sent           INTEGER DEFAULT 0,
    claimed_at     TEXT,
    claim_token    TEXT,
    created_at     TEXT NOT NULL,
    PRIMARY KEY (user_id, competition_id)
  );

  CREATE TABLE IF NOT EXISTS competition_timeslots (
    id               TEXT PRIMARY KEY,
    competition_id   TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    start_time       TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    ended_at         TEXT,
    ended_manually   INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_timeslots_comp ON competition_timeslots(competition_id);
`);


// Create invitations table
db.exec(`
  CREATE TABLE IF NOT EXISTS invitations (
    id                 TEXT PRIMARY KEY,
    email              TEXT NOT NULL,
    competition_ids    TEXT NOT NULL DEFAULT '[]',
    group_ids          TEXT NOT NULL DEFAULT '[]',
    invited_by         TEXT NOT NULL DEFAULT 'admin',
    created_at         TEXT NOT NULL,
    used_at            TEXT,
    user_id            TEXT,
    last_send_success  INTEGER DEFAULT 0
  );
`);
// Database-level dedup for live invitations. Without this, two app instances
// sharing the DB can both fall through the SELECT … used_at IS NULL gate and
// create parallel unredeemed invitations for the same address — one of the
// links would then resolve and the other would break at the existing-account
// check during registration. The partial index only covers unredeemed rows
// so a redeemed invite doesn't block a later re-invite for the same address.
// Hard-fail like the user identity indexes — the dedup invariant the
// invitation handler relies on must actually be installed.
ensureNocaseUniqueOrFail(
  "uq_invitations_live_email", "email",
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_invitations_live_email ON invitations(email COLLATE NOCASE) WHERE used_at IS NULL",
  "SELECT LOWER(email) AS value, COUNT(*) AS n, GROUP_CONCAT(id) AS ids FROM invitations WHERE used_at IS NULL GROUP BY LOWER(email) HAVING n>1"
);
// A person's invitations by account and by address, used ones included
// (lib/full-export.js PERSON_INVITATIONS_SQL): the live index above cannot
// answer a used invitation. Not unique, so a failure only slows that read.
db.exec("CREATE INDEX IF NOT EXISTS idx_invitations_user ON invitations(user_id) WHERE user_id IS NOT NULL");
db.exec("CREATE INDEX IF NOT EXISTS idx_invitations_email_nocase ON invitations(email COLLATE NOCASE)");

// Task version history
db.exec(`
  CREATE TABLE IF NOT EXISTS task_versions (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    version_num INTEGER NOT NULL,
    changed_by  TEXT NOT NULL,
    changed_at  TEXT NOT NULL,
    snapshot    TEXT NOT NULL,
    change_type TEXT NOT NULL DEFAULT 'update'
  );
  CREATE INDEX IF NOT EXISTS idx_task_versions_task ON task_versions(task_id, version_num);
`);

// Task attachments (.zip downloads offered to participants on the task detail
// page). `detached_at` is a soft-delete flag: removing an attachment from a
// challenge only sets this timestamp, so the binary stays on disk and restore
// to an earlier version can bring back both the display name AND the content.
// Binaries are physically removed only when the parent task is hard-deleted.
// `storage_path` is stored relative to DATA_DIR so a volume move doesn't
// invalidate every row.
db.exec(`
  CREATE TABLE IF NOT EXISTS task_attachments (
    id            TEXT PRIMARY KEY,
    task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    display_name  TEXT NOT NULL,
    original_name TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    sha256        TEXT NOT NULL,
    storage_path  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    created_by    TEXT,
    order_idx     INTEGER NOT NULL DEFAULT 0,
    detached_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(task_id, detached_at, order_idx);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_task_attachments_dname
    ON task_attachments(task_id, LOWER(display_name)) WHERE detached_at IS NULL;

  CREATE TABLE IF NOT EXISTS task_attachments_staging (
    id            TEXT PRIMARY KEY,
    admin_id      TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    original_name TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    sha256        TEXT NOT NULL,
    storage_path  TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_attachments_staging_admin ON task_attachments_staging(admin_id, created_at);
`);

// Entity-scoped event history (admin-initiated state changes only).
// Foreign keys intentionally omitted — rows outlive the referenced entity so the
// central log we add later can still join on IDs after cascading deletes.
db.exec(`
  CREATE TABLE IF NOT EXISTS competition_events (
    id              TEXT PRIMARY KEY,
    competition_id  TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    changed_by      TEXT NOT NULL,
    changed_at      TEXT NOT NULL,
    details         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_competition_events_comp ON competition_events(competition_id, changed_at DESC);
  /* ext-audit: the entity-first index above serves the per-entity History views,
     but the lib/event-retention.js purge filters+orders by the timestamp ALONE
     (DELETE ... WHERE rowid IN (SELECT rowid WHERE changed_at < ? ORDER BY changed_at ASC LIMIT ?)).
     Without a timestamp-leading index SQLite full-scans the table + builds a temp
     B-tree to order. This index makes the purge subquery a COVERING range scan
     (rowid is the index's row reference) — no scan, no temp B-tree. Same rationale
     for the four sibling event tables below. (One-time cost: on the FIRST boot
     after deploy these IF-NOT-EXISTS indexes build synchronously over any
     pre-existing rows — ~1-2s per index per ~3M rows of accumulated audit history;
     every later boot is a no-op. Acceptable, but expect it once on a large DB.) */
  CREATE INDEX IF NOT EXISTS idx_competition_events_changed_at ON competition_events(changed_at);

  CREATE TABLE IF NOT EXISTS timeslot_events (
    id          TEXT PRIMARY KEY,
    timeslot_id TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    changed_by  TEXT NOT NULL,
    changed_at  TEXT NOT NULL,
    details     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_timeslot_events_ts ON timeslot_events(timeslot_id, changed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_timeslot_events_changed_at ON timeslot_events(changed_at);

  CREATE TABLE IF NOT EXISTS user_events (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    event_type TEXT NOT NULL,
    changed_by TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    details    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_user_events_user ON user_events(user_id, changed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_user_events_changed_at ON user_events(changed_at);

  CREATE TABLE IF NOT EXISTS settings_events (
    id          TEXT PRIMARY KEY,
    setting_key TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    changed_by  TEXT NOT NULL,
    changed_at  TEXT NOT NULL,
    details     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_settings_events_key ON settings_events(setting_key, changed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_settings_events_changed_at ON settings_events(changed_at);

  /* orphan_events — the DB copy of every ORPHANED audit event
     (lib/audit.js recordOrphanedAuditEvent): deletions, exports, credential
     lookups, purges, every task event. Until this table those lived only in
     app.jsonl, so the Audit page (GET /api/admin/audit) could not list them.
     competition_id / timeslot_id are lifted from the event's details at write
     time so an event admin's scope can be applied in SQL. No foreign keys, for
     the reason the four tables above have none: the row outlives its entity
     by construction. Purged by lib/event-retention.js like its siblings. */
  CREATE TABLE IF NOT EXISTS orphan_events (
    id             TEXT PRIMARY KEY,
    scope          TEXT NOT NULL,
    scope_id       TEXT,
    event_type     TEXT NOT NULL,
    changed_by     TEXT,
    changed_at     TEXT NOT NULL,
    competition_id TEXT,
    timeslot_id    TEXT,
    details        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orphan_events_changed_at ON orphan_events(changed_at);
  CREATE INDEX IF NOT EXISTS idx_orphan_events_comp ON orphan_events(competition_id, changed_at DESC);
  -- A person's deletion (lib/account-reaper.js deleteUserCascade, up to 500 a
  -- reaper run) removes the copies about them inside its write transaction:
  -- found by index, never a scan of two years of rows under the write lock.
  CREATE INDEX IF NOT EXISTS idx_orphan_events_scope ON orphan_events(scope, scope_id);

  -- Bookkeeping for the auto-start/auto-end scheduler. No event is emitted on the
  -- first observation (bootstrap); subsequent status transitions emit events.
  CREATE TABLE IF NOT EXISTS entity_status_observations (
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    last_status TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (entity_type, entity_id)
  );

  -- Per-challenge analytics events. Captures every meaningful participant
  -- interaction with a challenge: correct / incorrect submissions, hint reveals,
  -- and navigation away from an opened challenge. Starts empty on every new
  -- install; rows are only produced by the live submit / hint / nav code paths.
  CREATE TABLE IF NOT EXISTS challenge_events (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    task_id         TEXT NOT NULL,
    competition_id  TEXT NOT NULL,
    timeslot_id     TEXT,
    event_type      TEXT NOT NULL,
    details         TEXT,
    occurred_at     TEXT NOT NULL,
    /* v7.14.0 — 1 when the event was produced by an admin IMPERSONATING this
       participant. Analytics excludes such rows (WHERE ce.impersonated=0);
       nothing else reads the flag. Upgraded DBs get the column via the guarded
       ALTER in the migration section below. */
    impersonated    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_chev_comp_task_time
    ON challenge_events(competition_id, task_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_chev_user_comp_time
    ON challenge_events(user_id, competition_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_chev_type_time
    ON challenge_events(event_type, occurred_at DESC);
  /* ext-audit: timestamp-leading covering index for the lib/event-retention.js
     purge (WHERE occurred_at < ? ORDER BY occurred_at ASC) — see the matching
     comment on idx_competition_events_changed_at. */
  CREATE INDEX IF NOT EXISTS idx_chev_occurred_at ON challenge_events(occurred_at);
`);

// Performance indexes for hot query paths
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_submissions_user_comp ON submissions(user_id, competition_id);
  CREATE INDEX IF NOT EXISTS idx_submissions_task_correct ON submissions(task_id, is_correct);
  CREATE INDEX IF NOT EXISTS idx_submissions_comp_correct ON submissions(competition_id, is_correct);
  /* v6.3.0: leaderboard build batches submissions by (competition_id, user_id, timeslot_id) —
     previously unindexed, forcing a partial scan inside the user_id IN (...) filter. */
  CREATE INDEX IF NOT EXISTS idx_submissions_comp_user_ts ON submissions(competition_id, user_id, timeslot_id);
  /* v6.3.0: submit-path dedup check filters submissions by
     (user_id, task_id, competition_id, answer) with submitted_at DESC LIMIT 1.
     Adding submitted_at to the suffix lets SQLite satisfy the ORDER BY from the
     index directly instead of sorting matching rows. */
  CREATE INDEX IF NOT EXISTS idx_submissions_user_task_comp_time ON submissions(user_id, task_id, competition_id, submitted_at DESC);
  /* v6.3.0: admin /api/admin/submissions ORDER BY submitted_at / revealed_at DESC
     for a single competition was doing a table scan + sort. */
  CREATE INDEX IF NOT EXISTS idx_submissions_comp_subtime ON submissions(competition_id, submitted_at DESC);
  CREATE INDEX IF NOT EXISTS idx_hint_reveals_comp_revtime ON hint_reveals(competition_id, revealed_at DESC);
  /* audit v7.7.32 (RM8): timestamp-LEADING indexes for the UNSCOPED admin
     Submissions tab (GET /api/admin/submissions with no competitionId — the tab
     default). Those queries ORDER BY submitted_at DESC, id DESC LIMIT N (and the
     revealed_at sibling); the comp-scoped indexes above don't lead on the
     timestamp, so EXPLAIN showed SCAN ... USE TEMP B-TREE FOR ORDER BY over the
     whole table (100k-4M rows at perf-seed scale, dragging each answer payload
     through the sort + blocking the event loop). These make the global branch,
     the page-1 anchor, and the snapshot-filtered count bounded index walks.
     Mirror the comp-scoped fix that landed for the scoped path earlier. */
  CREATE INDEX IF NOT EXISTS idx_submissions_subtime ON submissions(submitted_at DESC, id DESC);
  /* hint_reveals has no id column (composite PK), and the global query's
     tie-break is the expression (user_id || pipe || task_id) DESC — not
     indexable as a column. Leading on revealed_at DESC is enough: timestamps are
     effectively unique, so SQLite walks the index for the ordering and only ever
     tie-sorts within a single equal-timestamp group (negligible). */
  CREATE INDEX IF NOT EXISTS idx_hint_reveals_revtime ON hint_reveals(revealed_at DESC);
  /* Revoked-session tombstones (ext-audit v7.15.7). A session id that has been
     purged (single-session enforcement, block/demote, expiry GC) must be
     un-writable until the in-flight request that still holds it can no longer
     produce a VALID row. v7.15.6 kept these in a capped in-process Map with a
     10-minute TTL on the assumption no request outlives that — wrong: the bulk
     invitation path awaits an SMTP fan-out (up to 1000 recipients, 8-way
     concurrency, 30 s timeouts) and can run far longer, after which the guard
     forgot the id and the resurrected row authenticated again. The cap could
     also evict an id early under a purge storm. Durable + uncapped here, keyed
     by PK so the persistence-time lookup stays O(1). Swept by expires_at. */
  CREATE TABLE IF NOT EXISTS revoked_sessions (
    id         TEXT PRIMARY KEY,
    revoked_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_revoked_sessions_exp ON revoked_sessions(expires_at);
  /* email_proofs — the emailed code for an address with NO account yet
     (lib/email-proof.js). One row per normalised address, never on a user row;
     only the sha256 of the code is stored. Deleted on redemption (single use),
     after LOCKOUT_MAX wrong guesses, and by the 5-minute sweep once expired. */
  CREATE TABLE IF NOT EXISTS email_proofs (
    email_norm    TEXT PRIMARY KEY,
    code_hash     TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    sends         INTEGER NOT NULL DEFAULT 1,
    attempts      INTEGER NOT NULL DEFAULT 0,
    join_comp_id  TEXT,
    invitation_id TEXT,
    origin        TEXT,
    last_sent_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_email_proofs_exp ON email_proofs(expires_at);
  /* express_session — the user lookups (invalidateOtherSessions,
     clearCompetitionSessionForUser) use the expression indexes created below
     the CxOne ledger (lib/session-index.js); the GC sweep still scans, kept
     bounded by the periodic expired-row cleanup. */
  CREATE INDEX IF NOT EXISTS idx_competition_users_comp ON competition_users(competition_id);
  CREATE INDEX IF NOT EXISTS idx_competition_users_user ON competition_users(user_id);
  CREATE INDEX IF NOT EXISTS idx_competition_tasks_comp ON competition_tasks(competition_id);
  CREATE INDEX IF NOT EXISTS idx_competition_tasks_task ON competition_tasks(task_id);
  CREATE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname);
  /* v6.10.70: composite index covering the pendingApproval query
       SELECT COUNT(*) FROM users
        WHERE verified=1 AND approved=0 AND blocked=0
          AND (locked_until IS NULL OR locked_until <= ?)
     that runs on every GET /api/admin/participants (the admin-dashboard
     badge). Pre-index this was a full-table scan — at 5000+ BG users
     × 3 admin VUs polling every 15-30 s during the perf run, it added
     consistent tail latency to admin_participants (p(90)=4.18 s,
     max=9.25 s on v6.10.68). A partial index narrows the candidates
     to just the rows that can satisfy the predicate (approved=0 AND
     blocked=0) — in a real tournament 99% of users are approved, so
     the partial index scans ~a handful of rows regardless of DB size.
     locked_until is included so the range check on the tail predicate
     is also index-covered. */
  CREATE INDEX IF NOT EXISTS idx_users_pending ON users(verified, approved, blocked, locked_until)
    WHERE approved=0 AND blocked=0;
  CREATE INDEX IF NOT EXISTS idx_user_tags_user ON user_tags(user_id);
  CREATE INDEX IF NOT EXISTS idx_task_tags_task ON task_tags(task_id);
  CREATE INDEX IF NOT EXISTS idx_competition_tags_comp ON competition_tags(competition_id);
  /* v6.8.0: analytics filter subqueries like
       WHERE ce.user_id IN (SELECT user_id FROM user_tags WHERE tag IN ('staff'))
     previously forced a full scan of the join table on every tag-based
     filter. tag-lead indexes turn them into index seeks. */
  CREATE INDEX IF NOT EXISTS idx_user_tags_tag ON user_tags(tag);
  CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag);
  CREATE INDEX IF NOT EXISTS idx_competition_tags_tag ON competition_tags(tag);
  /* Group membership lookups: by user (participant payloads, logs/analytics
     filters) and by group (member lists, reconciliation desired-set). */
  CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
  CREATE INDEX IF NOT EXISTS idx_competition_groups_group ON competition_groups(group_id);
  /* v6.8.0: analytics reads challenge_events by competition_id (with no
     task_id filter in the default view) + occurred_at DESC window. The
     existing (competition_id, task_id, occurred_at DESC) index starts
     with competition_id so SQLite CAN use it, but the extra task_id
     column in the middle forces a sort step. This narrower composite
     satisfies the common default-view shape directly. */
  CREATE INDEX IF NOT EXISTS idx_chev_comp_time ON challenge_events(competition_id, occurred_at DESC);

  /* v6.13.6 Fix C: covering index for the analytics aggregate pipeline.
     /api/admin/analytics/challenges runs four aggregate queries that all
     start with WHERE ce.competition_id=? and then GROUP BY (event_type)
     or (task_id, event_type) or COUNT(DISTINCT user_id). At 6K+ events
     the aggregates spent ~27 ms combined (per v6.13.5 perf-span logs).
     A composite index on the four columns the queries touch gives
     SQLite an index-only scan path: it can answer GROUP BY / COUNT
     DISTINCT without ever reading the underlying row because every
     filter, grouping key and distinct-value column is in the index.
     Column order matters: competition_id first (range seek), then
     task_id (per-task grouping), user_id (distinct counts), event_type
     (summary grouping). Non-unique; SQLite's rowid tail-appended keeps
     it valid without an explicit WITHOUT ROWID declaration. */
  CREATE INDEX IF NOT EXISTS idx_chev_comp_task_user_type
    ON challenge_events(competition_id, task_id, user_id, event_type);
`);

// Participant feedback (star ratings) on tasks
db.exec(`
  CREATE TABLE IF NOT EXISTS task_feedback (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    rating     INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, task_id)
  );
`);

// v6.16.31 — One-click HTTPS unsubscribe per RFC 8058. Recipients of
// bulk-style emails (invitation, reminder, competition_assignment,
// account_approved_bulk, removed_from_competition) get a token-signed
// `<https://.../api/unsubscribe?token=...>` URL in the
// `List-Unsubscribe` header AND in the email-body footer. POSTing the
// token (one-click via Gmail / Outlook) inserts a row here. The
// sendEmailLogged pipeline skips bulk-reason sends to addresses
// present in this table. Email is keyed by NFC-normalised lowercase
// (matches the v6.16.22 normaliser used everywhere else).
db.exec(`
  CREATE TABLE IF NOT EXISTS unsubscribed_emails (
    email             TEXT PRIMARY KEY,
    unsubscribed_at   TEXT NOT NULL,
    reason            TEXT,
    user_agent        TEXT,
    ip                TEXT
  );
`);

// Performance indexes for hint_reveals + timeslot_id columns. Declared with
// CREATE INDEX IF NOT EXISTS so they're idempotent — a fresh schema gets
// them on first boot, an already-indexed DB is a no-op.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_hint_reveals_user_comp ON hint_reveals(user_id, competition_id);
  CREATE INDEX IF NOT EXISTS idx_hint_reveals_timeslot ON hint_reveals(timeslot_id);
  CREATE INDEX IF NOT EXISTS idx_competition_users_timeslot ON competition_users(timeslot_id);
  CREATE INDEX IF NOT EXISTS idx_submissions_timeslot ON submissions(timeslot_id);
  -- v6.8.5: composite index on the exact 3-column probe used by the
  -- /api/tasks/:id "has this user revealed this task's hint?" check.
  -- Previously served by idx_hint_reveals_user_comp + row-scan for
  -- task_id; at 500 VUs × 30 tasks that's ~15 k scans per event.
  CREATE INDEX IF NOT EXISTS idx_hint_reveals_user_task_comp ON hint_reveals(user_id, task_id, competition_id);
  -- v6.12.0 — buildLeaderboardEntries does a batched gap lookup
  -- WHERE user_id IN (...) AND competition_id=? keyed on (user, comp).
  -- Also supports the re-add UPDATE at assign time
  -- (WHERE user_id=? AND competition_id=? AND returned_at IS NULL).
  CREATE INDEX IF NOT EXISTS idx_cu_absences_scope ON competition_user_absences(competition_id, user_id);
`);

// v6.10.83 migration: `updated_at` fingerprint column on submissions +
// hint_reveals for UPDATE-drift detection on /api/admin/submissions.
// The CREATE TABLE IF NOT EXISTS blocks above declare the column on
// fresh installs; the ALTER TABLE dance below adds + back-fills the
// column on databases that predate v6.10.83. Idempotent via PRAGMA
// table_info probe so re-running boot is a no-op. Back-fill copies
// submitted_at / revealed_at so MAX(updated_at) equals the pre-migration
// fingerprint — no phantom drift on the first page fetch after upgrade.
try {
  // audit v7.7.37 (C15) — run each backfill on every boot (outside the column-
  // absence guard) so a crash between the ALTER and the UPDATE self-heals instead
  // of leaving the column present-but-NULL forever. `WHERE updated_at IS NULL` is a
  // cheap no-op once applied.
  const subsHasUpdatedAt = db.prepare("PRAGMA table_info(submissions)").all().some(c => c.name === "updated_at");
  if (!subsHasUpdatedAt) db.exec("ALTER TABLE submissions ADD COLUMN updated_at TEXT");
  db.exec("UPDATE submissions SET updated_at = submitted_at WHERE updated_at IS NULL");
  const hintsHasUpdatedAt = db.prepare("PRAGMA table_info(hint_reveals)").all().some(c => c.name === "updated_at");
  if (!hintsHasUpdatedAt) db.exec("ALTER TABLE hint_reveals ADD COLUMN updated_at TEXT");
  db.exec("UPDATE hint_reveals SET updated_at = revealed_at WHERE updated_at IS NULL");
} catch (e) {
  console.error("submissions/hint_reveals updated_at migration failed:", e.message);
}

// ext-audit v7.20.9 (F2) — the CANONICAL selection for a multiple-choice
// submission, as a JSON array of choice ids.
//
// `submissions.answer` deliberately stores a human-readable rendering of the
// picked options ("Paris | Rome") because the admin Submissions view prints
// that column verbatim and a list of opaque 8-hex ids there is useless. But
// recalculate re-grades from `answer`, comparing it against `correct_answer` —
// which for a choice task is `["6bc9f335"]` — so every choice submission it
// touched flipped from +50 to -5. Keeping BOTH representations is what lets the
// admin view stay readable and the re-grade stay correct; deriving one from the
// other is not possible once an option's text has been edited.
//
// In its OWN try block on purpose: the submit path WRITES this column, so
// sharing a block with the updated_at backfills would mean one unrelated
// migration error silently leaving the column absent and 500ing every
// submission. A migration a write path depends on must not be collateral.
try {
  const subsHasCanonical = db.prepare("PRAGMA table_info(submissions)").all().some(c => c.name === "answer_canonical");
  if (!subsHasCanonical) db.exec("ALTER TABLE submissions ADD COLUMN answer_canonical TEXT");
} catch (e) {
  console.error("FATAL-ish: submissions.answer_canonical migration failed — multiple-choice submissions will fail:", e.message);
}

// ext-audit v7.15.13 (HIGH): users.linkedin_sub — the OIDC SUBJECT that
// identifies a LinkedIn account, stable for the life of that account and
// independent of its email address.
//
// The callback used to resolve an existing account by EMAIL alone. Email is a
// re-assignable attribute: a corporate address recycled to a new employee (or
// any address transferred between LinkedIn accounts) let whoever completed OAuth
// with it sign in AS the existing account — including a promoted admin. Binding
// on (issuer, subject) made the identity durable; email was used only to enroll.
//
// LinkedIn sign-in is gone, so nothing binds or reads the column now: it keeps
// the subjects stored while that door existed. The partial unique index skips
// NULLs, so it only keeps those old values unique, one account per subject.
try {
  const uCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!uCols.includes("linkedin_sub")) db.exec("ALTER TABLE users ADD COLUMN linkedin_sub TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_users_linkedin_sub ON users(linkedin_sub) WHERE linkedin_sub IS NOT NULL");
} catch (e) {
  console.error("users linkedin_sub migration failed:", e.message);
}

// ext-audit v7.15.7: groups.name_key — the case-folded canonical name, stored
// and UNIQUE-indexed. Replaces the COLLATE NOCASE index as the authority
// (NOCASE folds ASCII only) and makes the uniqueness lookup indexed instead of a
// JS full scan. Backfill is best-effort per row: a pre-existing pair that only
// differs by a non-ASCII case variant (legal before this release) would violate
// the unique index, so the index is created only if the backfill leaves no
// duplicates — otherwise the app-level check still holds the line and an
// operator can rename the collision by hand.
try {
  const gCols = db.prepare("PRAGMA table_info(groups)").all().map(c => c.name);
  if (!gCols.includes("name_key")) db.exec("ALTER TABLE groups ADD COLUMN name_key TEXT");
  const { _groupNameKey } = require("./lib/util");
  const stale = db.prepare("SELECT id, name FROM groups WHERE name_key IS NULL").all();
  if (stale.length) {
    const upd = db.prepare("UPDATE groups SET name_key=? WHERE id=?");
    db.transaction(() => { for (const g of stale) upd.run(_groupNameKey(g.name), g.id); })();
  }
  const dupes = db.prepare("SELECT COUNT(*) c FROM (SELECT name_key FROM groups GROUP BY name_key HAVING COUNT(*) > 1)").get().c;
  if (!dupes) db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_groups_name_key ON groups(name_key)");
  else console.warn(`groups.name_key: ${dupes} pre-existing case-variant collision(s) — unique index not created; rename them and restart`);
} catch (e) {
  console.error("groups name_key migration failed:", e.message);
}

// ext-audit v7.15.6: achievement_badges.score_snapshot — freeze the score at
// mint so the PDF cannot contradict the stored PNG after a competition revive.
//
// v7.21.28: achievement_badges.name_snapshot — the "Salutation First Last" the
// badge was MINTED with. Same argument as score_snapshot, and now load-bearing
// for the same reason: from this release the name is drawn INTO the PNG, which
// is frozen at mint, so reading it live for the PDF and the public page would
// let one token serve artwork and text naming the person differently the moment
// they edited their profile. NULL for badges minted before this column existed —
// their PNG carries the nickname, and both readers fall back accordingly.
try {
  const badgeCols = db.prepare("PRAGMA table_info(achievement_badges)").all().map(c => c.name);
  if (!badgeCols.includes("score_snapshot")) db.exec("ALTER TABLE achievement_badges ADD COLUMN score_snapshot INTEGER");
  if (!badgeCols.includes("name_snapshot")) db.exec("ALTER TABLE achievement_badges ADD COLUMN name_snapshot TEXT");
} catch (e) {
  console.error("achievement_badges snapshot-column migration failed:", e.message);
}

// v6.13.22: users.denied_at / denied_by / denied_reason for the explicit
// "Deny approval" admin action. NULL on every existing row (legacy users
// were never denied — denial is a forward-only state on top of the
// approval lifecycle). Same idempotent PRAGMA probe + ALTER pattern.
try {
  const usersCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!usersCols.includes("denied_at"))     db.exec("ALTER TABLE users ADD COLUMN denied_at TEXT");
  if (!usersCols.includes("denied_by"))     db.exec("ALTER TABLE users ADD COLUMN denied_by TEXT");
  if (!usersCols.includes("denied_reason")) db.exec("ALTER TABLE users ADD COLUMN denied_reason TEXT");
} catch (e) {
  console.error("users denied_* migration failed:", e.message);
}

// v6.16.0: competitions.reveal_answers_on_end. Default 0 (do NOT reveal).
// The platform's pre-v6.16.0 behaviour was unconditionally to reveal
// correct answers + explanations once every timeslot of a competition
// had ended. Some operators run repeating events (a question bank reused
// across multiple cohorts) and need the answers withheld permanently;
// some run single one-shot events and want post-mortem visibility.
// The flag is per-competition, defaults to "no reveal" (the safer choice
// — repeated reuse is more common than a one-shot post-mortem). Pre-fix
// every existing competition gets 0 on the migration; admins who want
// the legacy reveal-on-end behaviour flip the flag explicitly via the
// edit modal.
try {
  const compCols = db.prepare("PRAGMA table_info(competitions)").all().map(c => c.name);
  if (!compCols.includes("reveal_answers_on_end")) {
    db.exec("ALTER TABLE competitions ADD COLUMN reveal_answers_on_end INTEGER NOT NULL DEFAULT 0");
  }
} catch (e) {
  console.error("competitions reveal_answers_on_end migration failed:", e.message);
}

// v6.8.0 migration: hint_reveals.timeslot_id used to be `NOT NULL DEFAULT ''`
// while submissions used the nullable convention. Normalise hint_reveals to
// NULL for no-slot rows and drop the NOT NULL constraint so both tables can
// be joined without a special case. Idempotent — only rebuilds if the old
// schema is still in place.
try {
  const tsCol = db.prepare("PRAGMA table_info(hint_reveals)").all().find(c => c.name === "timeslot_id");
  if (tsCol && tsCol.notnull === 1) {
    // audit v7.7.37 (C14) — atomic + self-healing. Pre-fix the CREATE/INSERT/DROP/
    // RENAME ran as separate autocommit statements with no DROP-IF-EXISTS prelude, so
    // a crash between CREATE and DROP left a stale hint_reveals_v2 that made every
    // later boot throw "table already exists" (caught + logged) — wedging the
    // migration forever and keeping the legacy NOT NULL schema (a NULL-timeslot hint
    // write then 500s). Wrapping in a transaction rolls a mid-rebuild crash back
    // cleanly; DROP TABLE IF EXISTS clears any stale shadow table from a prior attempt.
    db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS hint_reveals_v2;
        CREATE TABLE hint_reveals_v2 (
          competition_id  TEXT NOT NULL DEFAULT '',
          user_id         TEXT NOT NULL,
          task_id         TEXT NOT NULL,
          timeslot_id     TEXT,
          points_deducted INTEGER NOT NULL DEFAULT 0,
          revealed_at     TEXT NOT NULL,
          PRIMARY KEY (competition_id, user_id, task_id)
        );
        INSERT INTO hint_reveals_v2 (competition_id, user_id, task_id, timeslot_id, points_deducted, revealed_at)
          SELECT competition_id, user_id, task_id, NULLIF(timeslot_id, ''), points_deducted, revealed_at
          FROM hint_reveals;
        DROP TABLE hint_reveals;
        ALTER TABLE hint_reveals_v2 RENAME TO hint_reveals;
        CREATE INDEX idx_hint_reveals_user_comp ON hint_reveals(user_id, competition_id);
        CREATE INDEX idx_hint_reveals_timeslot ON hint_reveals(timeslot_id);
      `);
    })();
  }
} catch (e) {
  console.error("hint_reveals v2 migration failed:", e.message);
}

// v6.16.27 — `updated_at` columns on competitions + tasks for the
// optimistic-concurrency / If-Match pattern on PUT /api/admin/
// competitions/:id and PUT /api/admin/tasks/:id. Pre-fix, two admins
// editing the same comp / task in parallel last-writer-wins silently;
// post-fix the second admin's PUT supplies the updated_at value the
// row had at GET time and the server rejects 409 if the row has
// since moved. Idempotent: PRAGMA probe + ALTER + back-fill with
// the create-time stamp (or NOW() for the tasks table which has no
// created_at column). Subsequent PUT writes set updated_at=NOW()
// inside the same statement.
try {
  // audit v7.7.37 (C15) — the ALTER and its backfill are separate autocommit
  // statements; pre-fix the backfill lived INSIDE the column-absence guard, so a
  // crash between the ALTER and the UPDATE (or a transient I/O error) left the
  // column present-but-NULL forever — and a NULL updated_at silently DISABLES the
  // optimistic-concurrency 409 for that row. Running the `WHERE updated_at IS NULL`
  // backfill on EVERY boot (outside the guard) is a cheap no-op once applied and
  // self-heals a half-applied prior attempt.
  const compCols2 = db.prepare("PRAGMA table_info(competitions)").all().map(c => c.name);
  if (!compCols2.includes("updated_at")) db.exec("ALTER TABLE competitions ADD COLUMN updated_at TEXT");
  db.exec("UPDATE competitions SET updated_at = COALESCE(ended_at, created_at) WHERE updated_at IS NULL");
  const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
  if (!taskCols.includes("updated_at")) db.exec("ALTER TABLE tasks ADD COLUMN updated_at TEXT");
  // v7.19.0 — multiple-choice challenges. JSON [{id,text},…]; the correct SET
  // rides in `correct_answer` as a JSON id array, so the existing grading-hash
  // guard covers a change to it without a second column.
  if (!taskCols.includes("choices")) db.exec("ALTER TABLE tasks ADD COLUMN choices TEXT");

  // v7.19.0 — widen the answer_type CHECK to admit 'choice'.
  //
  // A CHECK constraint lives in the table definition, so SQLite cannot ALTER it
  // — the table has to be rebuilt. `tasks` is the most-referenced table in the
  // schema (submissions, competition_tasks, task_tags, task_attachments,
  // task_versions, hint_reveals, task_feedback, challenge_events all point at
  // it), so this follows the documented 12-step procedure exactly:
  //   • foreign_keys OFF around the swap, so DROP TABLE tasks does not cascade
  //     children into oblivion;
  //   • legacy_alter_table ON, so the RENAME does not rewrite the FK clauses in
  //     those child tables to point at the temporary name;
  //   • foreign_key_check after, so a rebuild that orphaned anything is caught
  //     here rather than at some later runtime failure.
  // Guarded on the stored SQL so it runs at most once, and skipped entirely on
  // a fresh database (whose CREATE TABLE above already has the new CHECK).
  try {
    const tblSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    if (tblSql && tblSql.sql && /CHECK\(answer_type IN/.test(tblSql.sql) && !/'choice'/.test(tblSql.sql)) {
      const cols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
      const colList = cols.join(",");
      const fkWasOn = db.prepare("PRAGMA foreign_keys").get().foreign_keys;
      db.pragma("foreign_keys = OFF");
      db.pragma("legacy_alter_table = ON");
      try {
        db.transaction(() => {
          db.exec(`
            DROP TABLE IF EXISTS tasks_v2;
            CREATE TABLE tasks_v2 (
              id              TEXT PRIMARY KEY,
              title           TEXT NOT NULL,
              description     TEXT,
              difficulty      TEXT NOT NULL CHECK(difficulty IN ('easy','medium','hard')),
              answer_type     TEXT NOT NULL DEFAULT 'text' CHECK(answer_type IN ('text','file','json','choice')),
              correct_answer  TEXT NOT NULL,
              explanation     TEXT,
              hint            TEXT,
              attachment_url  TEXT,
              status          TEXT DEFAULT 'published',
              author_name     TEXT,
              author_linkedin TEXT,
              locked          INTEGER DEFAULT 0,
              tags            TEXT DEFAULT '',
              active          INTEGER DEFAULT 1,
              updated_at      TEXT,
              choices         TEXT
            );
            INSERT INTO tasks_v2 (${colList}) SELECT ${colList} FROM tasks;
            DROP TABLE tasks;
            ALTER TABLE tasks_v2 RENAME TO tasks;
          `);
          const orphans = db.prepare("PRAGMA foreign_key_check(tasks)").all();
          if (orphans.length) throw new Error(`foreign_key_check reported ${orphans.length} orphaned row(s)`);
        })();
        console.log("[migration] tasks.answer_type CHECK widened to include 'choice'");
      } finally {
        db.pragma("legacy_alter_table = OFF");
        if (fkWasOn) db.pragma("foreign_keys = ON");
      }
    }
  } catch (e) {
    console.error("tasks answer_type CHECK migration failed:", e.message);
  }

  // v8.9.0 — widen the answer_type CHECK again, to admit 'any'.
  //
  // Same procedure as the v7.19.0 block above — foreign_keys OFF around the swap,
  // legacy_alter_table ON across the RENAME, foreign_key_check after, non-fatal —
  // with ONE deliberate difference, and it is the whole reason this is not a copy
  // of that block: THE DDL IS DERIVED FROM THE LIVE `sqlite_master.sql`, NEVER
  // PASTED.
  //
  // The v7.19.0 block hard-codes `tasks_v2`'s column list as the table stood on
  // the day it was written. `attempt_cap` (v8.1.0) and `created_by_id` (v8.7.0)
  // were ADDED afterwards, by ALTERs that run BELOW this point — so on every
  // migrated database the live table carries columns that DDL does not know.
  // Paste it here and `INSERT INTO tasks_v2 (${colList})` — colList being read off
  // the LIVE table — fails "table tasks_v2 has no column named attempt_cap", is
  // swallowed by the non-fatal catch below, and the NARROW CHECK SURVIVES: every
  // 'any' write then 500s on a production database while a fresh one (whose
  // CREATE TABLE above already carries the value) is fine. That is the one shape
  // no test server can see — tests/isolated-test.js wipes the directory before
  // every file, so every test server is a first boot (the v8.3.11 join-code-index
  // lesson) — which is why tests/any-answer-migration.spec.js narrows a fresh
  // schema by hand and boots against it.
  //
  // So the CREATE is what SQLite itself stores, with the header re-pointed at the
  // temporary name and the CHECK list widened; if EITHER replacement finds
  // nothing, this THROWS rather than rebuild a table it did not understand. Two
  // facts about that stored text, verified rather than assumed: `IF NOT EXISTS`
  // is normalised away, and after the v7.19.0 RENAME the name comes back
  // DOUBLE-QUOTED (`CREATE TABLE "tasks" (`) where a fresh database's is bare —
  // hence the optional quotes in the header regex. ADD COLUMN appends to that
  // same text, which is what keeps this correct for every column added since
  // v7.19.0 and for every column added after this.
  //
  // Guarded on the stored SQL so it runs at most once, and skipped entirely on a
  // fresh database. On a database the v7.19.0 block has only just rebuilt this
  // runs second and widens what that block wrote. It stays ABOVE
  // `idx_tasks_title`: DROP TABLE takes that index with it and the CREATE INDEX
  // further down is what puts it back.
  try {
    const tblSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    if (tblSql && tblSql.sql && /CHECK\(answer_type IN/.test(tblSql.sql) && !/'any'/.test(tblSql.sql)) {
      const HEADER = /^CREATE TABLE\s+"?tasks"?\s*\(/i;
      const CHECK  = /CHECK\(answer_type\s+IN\s*\([^)]*\)\)/;
      if (!HEADER.test(tblSql.sql)) throw new Error("stored tasks DDL has an unrecognised header; refusing to derive a rebuild from it");
      if (!CHECK.test(tblSql.sql))  throw new Error("stored tasks DDL has an unrecognised answer_type CHECK; refusing to derive a rebuild from it");
      const ddl = tblSql.sql
        .replace(HEADER, "CREATE TABLE tasks_v2 (")
        .replace(CHECK, "CHECK(answer_type IN ('text','file','json','choice','any'))");
      const cols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
      const colList = cols.join(",");
      const fkWasOn = db.prepare("PRAGMA foreign_keys").get().foreign_keys;
      db.pragma("foreign_keys = OFF");
      db.pragma("legacy_alter_table = ON");
      try {
        db.transaction(() => {
          db.exec("DROP TABLE IF EXISTS tasks_v2");
          db.exec(ddl);
          db.exec(`INSERT INTO tasks_v2 (${colList}) SELECT ${colList} FROM tasks`);
          db.exec("DROP TABLE tasks");
          db.exec("ALTER TABLE tasks_v2 RENAME TO tasks");
          const orphans = db.prepare("PRAGMA foreign_key_check(tasks)").all();
          if (orphans.length) throw new Error(`foreign_key_check reported ${orphans.length} orphaned row(s)`);
        })();
        console.log("[migration] tasks.answer_type CHECK widened to include 'any'");
      } finally {
        db.pragma("legacy_alter_table = OFF");
        if (fkWasOn) db.pragma("foreign_keys = ON");
      }
    }
  } catch (e) {
    console.error("tasks answer_type CHECK ('any') migration failed:", e.message);
  }
  // tasks has no created_at — back-fill with the most recent task_versions.changed_at
  // when available, otherwise NOW().
  db.exec(`UPDATE tasks SET updated_at = COALESCE(
    (SELECT MAX(changed_at) FROM task_versions WHERE task_id = tasks.id),
    datetime('now')
  ) WHERE updated_at IS NULL`);
} catch (e) {
  console.error("competitions/tasks updated_at migration failed:", e.message);
}

// v8.3.17 (external audit) — INDEX `tasks.title`.
//
// The challenge importer's conflict scan is `SELECT id, title, locked FROM tasks
// WHERE title=?`, run once per imported row against a table with NO index on
// that column — so every one of up to 10 000 rows was a full table scan, and the
// statement was re-prepared inside the loop as well. This is a SYNCHRONOUS
// single-process server, so that time is event-loop block, which is the health
// signal v7.21.23 added `hack_arena_event_loop_blocked_ms_total` to expose.
//
// PLACED HERE, AFTER THE `tasks_v2` REBUILD BLOCK ABOVE, and that is not
// cosmetic: v8.3.11 records `uq_competitions_join_code` created ~400 lines above
// the ALTER that added its column — it failed with `no such column`, was
// swallowed by its catch, and was not retried until the next process start. An
// index must come after everything that can replace the table it sits on.
//
// PLAIN, not UNIQUE: duplicate titles are legal (the import's `rename`
// resolution deliberately mints `"X (imported)"`, and nothing forbids two
// challenges sharing a name).
try {
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_title ON tasks(title)");
} catch (e) {
  console.error("[db] could not create idx_tasks_title:", e.message);
}

// v6.16.26 — legacy DB rebuild integrity fix. The v6.8.0 hint_reveals_v2
// rebuild block above (CREATE TABLE _v2 ... INSERT ... DROP ... RENAME)
// ─────────────────────────────────────────────────────────────────────────────
// v8.1.0 (PR 25) — why a badge was minted, and the name a verifier will be
// matched against.
//
// `basis` is 'placement' | 'participation' | 'completion'. It is stored rather
// than derived because the rule that produced it can change: `rank <= 3` is what
// makes a placement badge TODAY, and a badge minted under a different rule must
// still be able to say what it was. NULL on every pre-v8.1.0 row, which reads as
// "derive it from rank the old way" — the legacy-badge posture (v7.15.7).
//
// `name_match_snapshot` holds the two name PARTS as JSON, frozen at mint.
// PARTS, NEVER FOLDED KEYS, and that is a one-way door: folded keys would freeze
// `credentialNameKey`'s algorithm at mint, so improving the fold — teaching it a
// script it mishandles — would need a backfill over every certificate ever
// issued. Parts stay comparable under whatever fold the current build uses.
{
  const abCols = db.prepare("PRAGMA table_info(achievement_badges)").all().map(c => c.name);
  if (!abCols.includes("basis")) db.exec("ALTER TABLE achievement_badges ADD COLUMN basis TEXT");
  if (!abCols.includes("name_match_snapshot")) db.exec("ALTER TABLE achievement_badges ADD COLUMN name_match_snapshot TEXT");
  // v8.1.0 (PR 26) — when the HOLDER published this badge's public page.
  //
  // NULL means unpublished. Once set it is never cleared — a page that has been
  // shared stays shared even if the kind's policy later changes.
  //
  // v8.8.9 — CORRECTED. This used to say "only a completion-kind badge is gated
  // on it", which v8.6.2 reversed twenty lines below: `_badgePageWithheld` reads
  // no event kind at all, so EVERY kind now waits for the holder's Share. The
  // reasoning it gave for the Competition carve-out — that "Share on LinkedIn or
  // download" makes publishing stated intent — did not survive the second verb:
  // somebody who opened the dialog, took the PNG and closed it had published a
  // page in their own name as a side effect of collecting a document.
  if (!abCols.includes("shared_at")) db.exec("ALTER TABLE achievement_badges ADD COLUMN shared_at TEXT");

  // v8.6.2 — THE PUBLISH-ON-SHARE GATE EXTENDS TO EVERY KIND, AND THIS FLOOR IS
  // WHAT MAKES THAT SAFE. Until now only a COMPLETION certificate's page waited
  // for the holder's Share; a Booth Event's and a Competition's went live the
  // moment the badge was minted, so a participant who minted, downloaded the PNG
  // and closed the dialog had already published a crawlable page naming them and
  // was told nothing.
  //
  // Withholding on `shared_at IS NULL` alone would take DARK every badge page
  // minted before v8.1.0, because that column was added with no backfill — and
  // those pages are live today and may be linked from a LinkedIn post. You
  // cannot un-publish something somebody has already circulated without breaking
  // their link, so rows created before this instant keep their page.
  //
  // Deliberately NOT a backfill of `shared_at`: stamping it would claim a Share
  // that never happened, on the column whose whole meaning is that the holder
  // pressed the button. The floor records the honest fact instead — these pages
  // were already published. Same shape and same reason as
  // `account_reaper_floor_at`; DO NOTHING keeps the original deploy time stable.
  db.prepare("INSERT INTO settings(key,value) VALUES('badge_page_share_gate_at', ?) ON CONFLICT(key) DO NOTHING")
    .run(new Date().toISOString());

  // v8.1.0 (PR 27) — the code printed on a certificate, which a third party types
  // at /credential together with the holder's surname.
  //
  // NEW MINTS ONLY (Question 5a = i). Every Competition badge already in the
  // table keeps a NULL code and stays unverifiable, because that is the only
  // option under which the claim-time notice is a TRUE description: a lazy or
  // backfilled assignment would make every historical badge publicly verifiable
  // by surname, retroactively, for people who were shown no notice. Noted while
  // deciding: a backfill would not rescue the PDFs already in the wild either —
  // a code only helps if it is PRINTED on the artefact the verifier holds — so
  // the cost is bounded, and a later announced backfill can still serve anyone
  // who returns and re-downloads.
  if (!abCols.includes("public_code")) db.exec("ALTER TABLE achievement_badges ADD COLUMN public_code TEXT");
  // v8.1.0 — the DATE as issued, frozen for the same reason `score_snapshot` is
  // (v7.15.6). It was re-derived live from the event's effective end on every
  // render, so extending a Program's deadline silently rewrote the date on
  // certificates already downloaded, printed and filed — and on the third-party
  // verification page, which is supposed to CONFIRM the paper. A certificate is a
  // factual claim about a finished event; the platform must not restate it.
  // NULL on a pre-v8.1.0 badge, which keeps today's live derivation as the
  // fallback (the legacy-badge posture).
  if (!abCols.includes("date_snapshot")) db.exec("ALTER TABLE achievement_badges ADD COLUMN date_snapshot TEXT");
  // v8.6.0 — WAS THIS EARNED AS A LATE ENTRANT? Frozen at mint, and the freeze is
  // the whole reason the column exists rather than the value being re-derived
  // beside `basis`.
  //
  // Lateness is a function of when somebody joined, when the event ended, and
  // whether they had finished by then — and an admin can move the second of those
  // afterwards (extend the duration and a time-expired event revives; press End Now
  // and it ends early). Re-deriving at render would let one such edit relabel a
  // certificate already downloaded, printed and filed, with the verification page
  // confirming the new wording as correct. That is precisely why `score_snapshot`
  // (v7.15.6), `date_snapshot` (v8.1.0) and `basis` (v8.1.0 PR 25) are frozen; this
  // is the same argument for the same kind of claim.
  //
  // A SEPARATE COLUMN, NOT A FOURTH `basis` VALUE. Three live readers test `basis`
  // by equality — the score label, the public page's sentence and the client's
  // await-before-share path — so `late_placement` / `late_participation` would
  // silently change all three. Lateness is orthogonal to what the certificate
  // attests, and the storage says so.
  //
  // DEFAULT 0, which is every badge minted before this release and is true of them.
  if (!abCols.includes("late_entrant")) db.exec("ALTER TABLE achievement_badges ADD COLUMN late_entrant INTEGER NOT NULL DEFAULT 0");
  // NOT PARTIAL, deliberately, and the asymmetry with the index below is the
  // point: a REVOKED code must still resolve, or the credential page cannot
  // answer "revoked" and a revoked certificate becomes indistinguishable from a
  // forged one. `_findBadge` filters `revoked_at IS NULL`, so the credential
  // lookup reads its own row.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_achievement_badges_public_code ON achievement_badges(public_code) WHERE public_code IS NOT NULL");
}

// v8.1.0 (PR 27) — the re-mint uniqueness index becomes PARTIAL.
//
// It is `(user_id, competition_id, IFNULL(timeslot_id,''))` with no predicate, so
// once a badge is revoked the participant is stuck: `_findBadge` filters
// `revoked_at IS NULL` and returns nothing, the mint proceeds, and the INSERT
// then violates the index — surfacing through the concurrent-mint catch, which
// looks the winner up with the same filtered query and finds nothing either.
//
// MAKING IT PARTIAL ALONE WOULD BE STRICTLY WORSE THAN THAT. The mint is
// `requireParticipant`, so a participant whose certificate was revoked for
// plagiarism could quietly mint a fresh valid one with a fresh code, audited as
// an ordinary mint. The refusal in routes/badge.js ships in the same unit and is
// what makes this safe; if the two ever have to be split, the refusal goes first.
//
// Narrowing an index cannot fail on existing data: the partial index covers a
// subset of the rows the full one already held.
{
  const hasPartial = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_achievement_badges_user_comp_ts'"
  ).get();
  if (hasPartial && !/revoked_at\s+IS\s+NULL/i.test(hasPartial.sql || "")) {
    db.exec("DROP INDEX uq_achievement_badges_user_comp_ts");
    db.exec("CREATE UNIQUE INDEX uq_achievement_badges_user_comp_ts ON achievement_badges(user_id, competition_id, IFNULL(timeslot_id, '')) WHERE revoked_at IS NULL");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v8.1.0 (PR 24) — the CERTIFICATE name, held apart from the profile name.
//
// TWO COLUMNS, NOT ONE FREE-TEXT FIELD, and the reason is the verification
// lookup that PR 28 builds on top: `/credential` matches a surname a third party
// types against parts frozen at mint. With two mandatory parts there are always
// ≥2 tokens, so one matching rule serves every path with no vocabulary list and
// no minimum-length floor — and a floor would be actively wrong, because "Wei Li"
// tokenises to `wei`/`li` and a three-character floor rejects a real surname.
//
// A single joined field would force keys to come from splitting a string, which
// makes the SALUTATION a guessable token (three of the seven presets clear a
// three-character floor). Excluding it needs a server-side salutation vocabulary,
// but the presets live in a browser-only ESM graph, so a server mirror is a copy
// that FAILS OPEN when stale — the guessing surface would depend on a list the
// server cannot authoritatively hold.
//
// Both NULLABLE: the profile name is the fallback, so nobody has to fill these in
// and no existing row needs a backfill.
{
  const certCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!certCols.includes("certificate_given_name")) db.exec("ALTER TABLE users ADD COLUMN certificate_given_name TEXT");
  if (!certCols.includes("certificate_family_name")) db.exec("ALTER TABLE users ADD COLUMN certificate_family_name TEXT");

  // ── v8.1.0 (PR 31) — users.profile_policy ────────────────────────────────
  //
  // Which registration policy this account was created under. A Booth Event
  // walk-up fills eight fields, not ten, and the account must keep that deal for
  // life — otherwise the profile-completion gate, which is deliberately
  // NON-DISMISSIBLE, would corner them at their next sign-in demanding two
  // fields nobody ever asked them for.
  //
  // **A STORED POLICY VALUE, NEVER A COMPETITION ID, AND THAT IS A ONE-WAY
  // DOOR.** The reference-shaped design is the obvious one and it dissolves
  // exactly when it is needed: `competition_users.competition_id` is
  // `ON DELETE CASCADE`, so deleting the Booth Event a year later would silently
  // re-impose the full field set on every walk-up who registered through it, and
  // they would each hit an inescapable gate on their next visit. A denormalised
  // value cannot evaporate.
  //
  // NULL means the ordinary full-profile policy, so every existing row keeps
  // today's behaviour with no backfill. Values are event-kind strings, read
  // through `eventPolicy`, which normalises an unrecognised one to the default —
  // so a rollback, or a kind retired later, relaxes NOTHING. That is the safe
  // direction: the failure mode is asking for a field, not silently dropping one.
  if (!certCols.includes("profile_policy")) db.exec("ALTER TABLE users ADD COLUMN profile_policy TEXT");

  // ── v8.4.0 — users.registration_competition_id ───────────────────────────
  //
  // WHICH EVENT THIS ACCOUNT WAS CREATED THROUGH. NULL for every account that
  // did not arrive through a join link — an ordinary sign-up, an invitation, an
  // import. When the column arrived (v8.4.0) that was every existing row, so that
  // release needed no backfill and changed nothing for any of them.
  //
  // v8.12.8 — AND the desk shortcut, when an event is named (operator ruling):
  // the account a desk creates for an event is that event's walk-up exactly as a
  // QR sign-up is, so it carries the pointer too (a desk account is still never
  // asked for a password — see `_profileMissingFields`). The desk accounts made
  // before that are linked once, by the guarded backfill at the end of this file,
  // where every table it reads already exists — and only those the desk made HERE:
  // an account the participant import brought in keeps no pointer, as an import
  // always has (the pointer is not exported).
  //
  // **IT DOES NOT REPLACE `profile_policy`; IT SITS BESIDE IT, AND THE PAIR IS
  // THE WHOLE DESIGN.** The block above states, correctly, that a reference
  // dissolves exactly when it is needed: this column carries no foreign key, so
  // deleting the event a year later leaves it DANGLING rather than cascading —
  // and a dangling pointer that silently meant "full profile" would re-impose
  // the complete field set on every walk-up who registered through it, behind
  // the non-dismissible gate. That argument has not changed and is why
  // `profile_policy` stays: it is the denormalised fallback the pointer needs.
  //
  //   pointer resolves  → read that event's CURRENT configuration
  //   pointer dangles   → fall back to `profile_policy`'s kind defaults
  //
  // The pointer exists because the operator asked for a change the stored
  // snapshot structurally cannot express: a field an admin makes MANDATORY after
  // someone registered must be demanded of them, immediately, even once the
  // event has ended. A snapshot answers with the deal as it was; only a pointer
  // can answer with the deal as it IS. The fallback keeps the failure direction
  // safe — a deleted event under-demands rather than stranding an account.
  //
  // No index. The gate reads it one row at a time by primary key on the user; the
  // only reads BY competition are the /api/me cache busts in routes/competitions.js
  // (a registration-fields change, and an event delete), which are rare admin
  // writes, so a full scan there is cheaper than an index maintained on every
  // user insert. (v8.12.8 corrects this note, which claimed it was never scanned.)
  if (!certCols.includes("registration_competition_id")) db.exec("ALTER TABLE users ADD COLUMN registration_competition_id TEXT");
}

// ─────────────────────────────────────────────────────────────────────────────
// v8.1.0 (PR 34) — NET ACTIVE TIME.
//
// `competition_presence` counts FIVE-MINUTE BUCKETS a participant was actually
// on the platform, per (competition, user). Elapsed time already exists and is
// the wrong number for a multi-day event: a Competition running Friday to Monday
// shows everyone ~72 hours, which ranks nobody and tells an organiser nothing.
//
// **THE BUCKET SIZE IS A ONE-WAY DOOR.** Every stored counter is a count of
// five-minute buckets, so changing the size re-scales all history — a row saying
// "84" would silently mean a different duration before and after. It is a
// constant in one place and nothing derives it.
//
// **`last_bucket` IS WHAT MAKES THE WRITE IDEMPOTENT, and it is DURABLE on
// purpose.** The obvious alternative — a process-local Map of "who have we
// counted this bucket" — loses everything on a restart and, worse, the
// `req.session` version of it would flip express-session's `isModified()` and
// emit a refreshed `Set-Cookie` on a GET, which v7.14.5 forbids outright (it
// would make every parked tab immortal). A column costs one integer per
// participant per event and survives a deploy mid-bucket.
try {
  db.exec(`CREATE TABLE IF NOT EXISTS competition_presence (
    competition_id TEXT NOT NULL,
    user_id        TEXT NOT NULL,
    buckets        INTEGER NOT NULL DEFAULT 0,
    last_bucket    INTEGER NOT NULL DEFAULT 0,
    first_seen_at  TEXT,
    last_seen_at   TEXT,
    PRIMARY KEY (competition_id, user_id),
    FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)        REFERENCES users(id)        ON DELETE CASCADE
  )`);
  // The read path is "every participant in this competition", which the PK's
  // leading column already serves. No second index: the table is one row per
  // (event, participant) and the only other query is the /metrics count.
} catch (e) {
  // Non-fatal, deliberately, and the opposite of the nine-column block: nothing
  // in the platform READS presence unless `measure_presence` is on, and it is
  // off by default — so a failure here degrades one optional column on one admin
  // board rather than breaking event creation.
  console.error("[db] could not create competition_presence:", e.message);
}

// v8.1.0 (PR 32) — the SHORT JOIN CODE's unique index used to be created HERE,
// which is ~400 lines ABOVE the ALTER that adds `competitions.join_code`. On a
// fresh database that is a guaranteed `no such column` failure, swallowed and not
// retried until the next boot. It now lives immediately after that ALTER; see the
// v8.3.11 note there. This comment is left as a signpost so the next reader who
// expects to find it grouped with the other index creations knows why it is not.

// ─────────────────────────────────────────────────────────────────────────────
// v8.1.0 — attempt caps. `tasks.attempt_cap` (NULL = uncapped) and the grant
// ledger. `competitions.attempt_cap` already exists (v8.0.0, the nine-column
// block) and is only now read.
//
// DELIBERATELY NOT INSIDE A try/catch, unlike the migrations either side of it.
// Those swallow-and-continue because a failure there degrades a feature; here the
// task create INSERT, the PUT, the version-restore UPDATE and the export all name
// the column, so a missing one is not "attempt caps are unavailable" — it is
// `SQLITE_ERROR` on every challenge write, discovered by an admin mid-setup.
// Refusing to boot is the better failure, and with a SINGLE ALTER there is no
// partial-apply state to verify afterwards the way the nine-column block needs.
//
// The grant ledger is keyed on (user, task, competition) and ACCUMULATES, so two
// admins each granting one attempt gives two. The competition is part of the key
// because the same challenge is routinely reused across events, and an attempt
// spent in March must not shorten a participant's rope in June.
{
  const capCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
  if (!capCols.includes("attempt_cap")) db.exec("ALTER TABLE tasks ADD COLUMN attempt_cap INTEGER");
  db.exec(`
    CREATE TABLE IF NOT EXISTS attempt_grants (
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      extra_attempts INTEGER NOT NULL DEFAULT 0,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (user_id, task_id, competition_id)
    );
  `);
  // The auto-end predicate reads every grant for a whole cohort at once
  // (participantsFinishedAll), which is a competition-keyed scan.
  db.exec("CREATE INDEX IF NOT EXISTS idx_attempt_grants_comp ON attempt_grants(competition_id, user_id)");
}

// ─────────────────────────────────────────────────────────────────────────────
// v8.10.0 — `tasks.answer_sealed`: the answer key belongs to its author alone.
//
// Set once at create; cleared only by the author; never re-set. The rule and
// every refusal live in `lib/answer-seal.js` (pure, unit-tested); this block is
// only the column.
//
// WHERE THIS ALTER SITS, AND WHY IT MATTERS MORE THAN IT LOOKS. It is BELOW both
// `tasks` table rebuilds (v7.19.0 at ~902, v8.9.0 at ~992), and it must be. The
// v7.19.0 rebuild HARD-CODES the `tasks_v2` DDL as the table stood in that
// release while reading `colList` from the LIVE `PRAGMA table_info(tasks)`, so a
// column added ABOVE it — beside `updated_at` and `choices`, which is exactly
// where a reader naturally puts one — makes that rebuild fail on any
// pre-v7.19.0 database with `table tasks_v2 has no column named answer_sealed`,
// swallowed by its own non-fatal catch, and the `answer_type` CHECK widening
// then silently does not happen. `attempt_cap` (above) and `created_by_id`
// (below) are the two live precedents, both in their own block far down here.
//
// NOT INSIDE A try/catch, following `attempt_cap` rather than `created_by_id`,
// and the direction of the failure is why. `created_by_id` swallows because its
// absence degrades a FEATURE and NULL is a defined fail-closed value. Here a
// swallowed ALTER leaves every seal predicate reading `undefined` — i.e.
// `answerSealed()` answers FALSE and every sealed answer becomes readable by
// every admin on the platform, silently. A single ALTER also leaves no
// partial-apply state to verify afterwards. Refusing to boot is the better
// failure when the alternative is a quiet disclosure.
//
// `INTEGER NOT NULL DEFAULT 0` — the DEFAULT is the backfill, so there is no
// second autocommit UPDATE and no crash-between-two-statements window leaving
// the column present-but-NULL for ever (the v7.7.37 C15 lesson a few hundred
// lines above). Every existing challenge is unsealed, which is both accurate and
// the only safe reading: nothing that has already been readable can be made
// secret by a migration.
{
  const _sealCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
  if (!_sealCols.includes("answer_sealed")) {
    db.exec("ALTER TABLE tasks ADD COLUMN answer_sealed INTEGER NOT NULL DEFAULT 0");
  }
}

// v8.12.2 — `task_versions.details`: a nullable JSON blob a version row may carry
// beside its snapshot. Written today by exactly one change_type,
// `sealed_reveal` — the recorded disclosure of a sealed answer and hint to a
// superadmin — and NULL for every other row, so the History dialog's diff
// renderer is untouched for ordinary versions. It holds ONLY what the History
// dialog renders (`impersonated_by`, `acting_as_id`, `via`, `fields`) — the
// seat as an ID, never an email, resolved per reader at the versions route —
// never the request context's `ip` / `user_agent`, because `task_versions` is deliberately
// EXEMPT from event retention (lib/event-retention.js) and permanent, and a
// column that quietly accumulated PII there would make that module's stated
// rationale false. The IP and agent ride the app.jsonl event, which
// scripts/purge.sh rotates.
//
// NOT INSIDE A try/catch, for the `answer_sealed` reason one block up:
// `_createTaskVersionTxn` (lib/audit.js) names the column in its INSERT for
// EVERY version write, so a swallowed ALTER would turn every challenge create,
// edit, publish and tag change into a 500 rather than degrade one feature.
{
  const _tvCols = db.prepare("PRAGMA table_info(task_versions)").all().map(c => c.name);
  if (!_tvCols.includes("details")) {
    db.exec("ALTER TABLE task_versions ADD COLUMN details TEXT");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v8.1.0 — THE ABSENCE ROW CARRIES THE SOLVE-CLOCK ANCHOR.
//
// `competition_users.login_time` is what `solveTimeMs` measures from, and
// time-to-solve is the SOLE tie-breaker on a score tie. Every removal DELETEs
// the `competition_users` row, so the anchor was destroyed; any re-add
// re-inserted with `login_time IS NULL` and the lazy stamp
// (`_stampLoginTimeIfLive`, guarded on exactly that NULL) re-anchored the clock
// to the REJOIN moment on the participant's very next request.
//
// That is not merely lossy, it INVERTS the tie-break. `buildLeaderboardEntries`
// clamps each absence interval to [loginMs, refEndMs], so with the anchor moved
// forward the whole pre-removal period falls outside the window and is excluded
// rather than just the no-access gap. For a FINISHER, `refEndMs` is their last
// correct submission and therefore PRECEDES the new anchor — the subtraction
// goes negative and is clamped to 0, the best possible value. Since v8.1.0 a
// participant can drive that themselves with two calls (leave + join), so a
// tied finisher could take 1st place, the badge and the certificate.
//
// The fix is to preserve the anchor: record it here at removal, restore it on
// re-add (`closeAbsenceAndRestoreAnchor`, lib/competitions.js).
//
// NULL means "anchor unknown" and restores NOTHING — which is exactly what
// every pre-migration row, and every absence rehydrated by the participant
// import (which does not carry this column), must mean. Today's behaviour,
// unchanged, for rows that cannot know better.
//
// Deliberately NOT inside a try/catch, and with no post-verify loop: a SINGLE
// ALTER has no partial-apply state, and both absence-row INSERTs name the
// column, so a missing one is `SQLITE_ERROR` on every participant removal
// rather than a quietly degraded feature. The PRAGMA guard makes it idempotent.
{
  const _absCols = db.prepare("PRAGMA table_info(competition_user_absences)").all().map(c => c.name);
  if (!_absCols.includes("login_time")) db.exec("ALTER TABLE competition_user_absences ADD COLUMN login_time TEXT");
}

// v8.12.6 — the ORIGINAL JOIN TIME survives a removal too, for the same reason the
// anchor above does, one column over. A late entrant is classified by WHEN THEY
// JOINED (`competition_users.assigned_at` against the event's effective end,
// lib/late-entry.js), and the removal DELETEs that row. A re-add writes a fresh
// `assigned_at`, the re-add's own time, so without this column a member who
// joined while the event ran would read as a late entrant whenever the effective
// end falls between the two (a duration edit can move it back there). The
// removal records it here; `closeAbsenceAndRestoreAnchor` restores it. Like the
// anchor, it is recorded only for a member who had ENTERED (`login_time` set): a
// member removed before entering leaves no row, so a re-add through the
// late-entry window makes them a late entrant, as the window does for anyone who
// did not play the event (`lateWindowAdmissionDenied`, lib/competitions.js).
//
// NULL means "join time unknown" and restores NOTHING — every pre-migration row,
// and every absence imported from a file that predates the field. Not inside a
// try/catch, for the reason the block above gives: every absence-row INSERT names
// the column, so a missing one is `SQLITE_ERROR` on every removal. It is in
// lib/schema-required.js, so a half-applied migration drains the instance.
{
  const _absCols2 = db.prepare("PRAGMA table_info(competition_user_absences)").all().map(c => c.name);
  if (!_absCols2.includes("assigned_at")) db.exec("ALTER TABLE competition_user_absences ADD COLUMN assigned_at TEXT");
}

// drops `updated_at` (added by the v6.10.83 migration earlier in boot)
// AND the v6.8.5 composite index `idx_hint_reveals_user_task_comp`,
// because the rebuild's INSERT-SELECT only copies the original 6 columns
// and the rebuild's CREATE INDEX block only declares 2 of the 3 indexes
// a fresh-install schema would have. On a legacy DB the new hint_reveals
// table boots without the column or composite index, and any later
// request that touches them (admin/submissions UPDATE-drift fingerprint,
// /api/admin/tasks/:id/recalculate, /api/tasks/:id hint check) 500s.
//
// Re-apply the migrations after the rebuild so the post-rebuild shape
// matches a fresh install. ALL THREE statements are idempotent (PRAGMA
// probe + IF NOT EXISTS) so a fresh-install boot is a no-op.
try {
  const hintsCols = db.prepare("PRAGMA table_info(hint_reveals)").all();
  if (!hintsCols.some(c => c.name === "updated_at")) {
    db.exec("ALTER TABLE hint_reveals ADD COLUMN updated_at TEXT");
    db.exec("UPDATE hint_reveals SET updated_at = revealed_at WHERE updated_at IS NULL");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_hint_reveals_user_task_comp ON hint_reveals(user_id, task_id, competition_id)");
  // v6.16.41 — same rebuild-drops-the-index class as the v6.16.26 fix
  // above, but the v6.16.26 patch only restored the user_task_comp
  // composite. The `idx_hint_reveals_comp_revtime` index declared at
  // db.js:391 (fresh-install path) covers `(competition_id,
  // revealed_at DESC)` and the legacy DROP TABLE wipes it; without
  // restoration, /api/admin/submissions's hint ordering + count paths
  // fall back to a table scan + sort on every admin poll. Idempotent
  // (IF NOT EXISTS) so a fresh-install boot is a no-op.
  db.exec("CREATE INDEX IF NOT EXISTS idx_hint_reveals_comp_revtime ON hint_reveals(competition_id, revealed_at DESC)");
} catch (e) {
  console.error("hint_reveals legacy-rebuild integrity fix failed:", e.message);
}

// Case-insensitive uniqueness for identity columns. The original CREATE TABLE
// declared `email TEXT NOT NULL UNIQUE` and `nickname TEXT NOT NULL UNIQUE`
// without COLLATE NOCASE, so SQLite would happily accept `Alice@x.com` and
// `alice@x.com` as two distinct accounts even though the application-level
// helpers compare with LOWER(). The COLLATE NOCASE unique indexes below
// close that gap.
//
// Hard-fail policy (v6.0.1+): if index creation rejects existing duplicates
// we ABORT startup. The previous fail-soft (log-and-continue) was unsafe
// because downstream code (the sign-in doors, every address lookup) assumes
// one row resolves per identity. Without the unique constraint actually being
// installed, a DB with case-collision rows would keep booting with ambiguous
// resolution.
// We surface the offending rows so the operator knows exactly which to
// merge before retrying.
function ensureNocaseUniqueOrFail(name, column, sql, conflictQuery) {
  try { db.exec(sql); return; }
  catch (e) {
    let conflicts = [];
    try { conflicts = db.prepare(conflictQuery).all(); }
    catch (qe) { console.error(`ensureNocaseUniqueOrFail: conflict-detail query failed for ${name}:`, qe.message); }
    const lines = [
      `FATAL: cannot create unique index ${name} on users(${column} COLLATE NOCASE).`,
      `Reason: ${e.message}`,
      `The DB contains case-collision rows that violate the case-insensitive`,
      `identity invariant the rest of the app relies on. Resolve them manually`,
      `(merge or rename) before restarting. Conflicting groups:`,
    ];
    // The colliding VALUE (an address or a nickname) is deliberately not
    // printed: this line lands in the container log, which outlives the fix.
    // The row ids are enough to find and merge the rows.
    for (const c of conflicts) lines.push(`  • ${Number(c.n)} rows share one value across ids: ${String(c.ids)}`);
    if (!conflicts.length) lines.push("  (no detail rows returned by the diagnostic query)");
    console.error(lines.join("\n"));
    process.exit(1);
  }
}
ensureNocaseUniqueOrFail(
  "uq_users_email_nocase", "email",
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_nocase ON users(email COLLATE NOCASE)",
  "SELECT LOWER(email) AS value, COUNT(*) AS n, GROUP_CONCAT(id) AS ids FROM users WHERE email IS NOT NULL GROUP BY LOWER(email) HAVING n>1"
);
ensureNocaseUniqueOrFail(
  "uq_users_nickname_nocase", "nickname",
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_users_nickname_nocase ON users(nickname COLLATE NOCASE)",
  "SELECT LOWER(nickname) AS value, COUNT(*) AS n, GROUP_CONCAT(id) AS ids FROM users WHERE nickname IS NOT NULL GROUP BY LOWER(nickname) HAVING n>1"
);
ensureNocaseUniqueOrFail(
  "uq_users_secondary_email_nocase", "secondary_email",
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_users_secondary_email_nocase ON users(secondary_email COLLATE NOCASE) WHERE secondary_email IS NOT NULL",
  "SELECT LOWER(secondary_email) AS value, COUNT(*) AS n, GROUP_CONCAT(id) AS ids FROM users WHERE secondary_email IS NOT NULL GROUP BY LOWER(secondary_email) HAVING n>1"
);
// v7.21.8 — drop the two plain email indices, which are exactly subsumed.
// idx_users_email was `ON users(email COLLATE NOCASE)` and
// uq_users_email_nocase is `UNIQUE ON users(email COLLATE NOCASE)`: identical
// column and collation, so the unique index serves every lookup the plain one
// did and is strictly stronger. Same for the secondary pair, partial WHERE
// included. Two indices on one column means two b-trees maintained on every
// write for one read path.
//
// Ordering is load-bearing: this runs AFTER ensureNocaseUniqueOrFail, which
// process.exit(1)s if the unique index cannot be created. So by the time these
// DROPs run the replacement is guaranteed to exist, and there is no window in
// which the column is unindexed. Dropping them at the CREATE site instead would
// have opened exactly that window on a database with a case collision.
try {
  db.exec("DROP INDEX IF EXISTS idx_users_email; DROP INDEX IF EXISTS idx_users_secondary_email;");
} catch (_err) { /* non-fatal: a redundant index left behind costs write amplification, not correctness */ swallowed("db:drop-redundant-index", _err); }

// v7.7.5 (ext-audit F7) — legacy non-ASCII nicknames pre-date the printable-ASCII
// rule. The NOCASE uniqueness index case-folds ASCII only, so two non-ASCII case
// variants (e.g. "Äbc"/"äbc") it cannot fold could coexist. New writes reject
// non-ASCII; existing rows are NOT rewritten (the nickname is a leaderboard handle,
// not the auth identity — the email is separately NFC+lowercase canonicalised).
// Non-fatal startup DIAGNOSTIC so an operator is aware and can ask the affected
// users to rename. GLOB '*[^ -~]*' matches any char outside printable ASCII.
try {
  const legacy = db.prepare("SELECT COUNT(*) AS n FROM users WHERE nickname GLOB '*[^ -~]*'").get().n;
  if (legacy > 0) {
    console.warn(`[db] NOTE: ${legacy} user(s) have a legacy non-ASCII nickname (predates the ASCII-only rule). They can still save profile changes (the nickname is only re-validated when changed), but those handles are case-fold-ambiguous under the NOCASE index — ask the affected users to rename to printable ASCII when convenient.`);
  }
} catch (_err) { /* diagnostic only — never block boot */ swallowed("db:boot-diagnostic", _err); }
// Group names are case-insensitive unique (so "Red Team" and "red team" can't
// both exist). Hard-fail on pre-existing collisions, same policy as user
// identity columns above. (Helper is users-worded but the index/query are
// parameterised, so it applies cleanly to the groups table.)
ensureNocaseUniqueOrFail(
  "uq_groups_name_nocase", "name",
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_groups_name_nocase ON groups(name COLLATE NOCASE)",
  "SELECT LOWER(name) AS value, COUNT(*) AS n, GROUP_CONCAT(id) AS ids FROM groups WHERE name IS NOT NULL GROUP BY LOWER(name) HAVING n>1"
);

// Schema migrations — idempotent; column already exists silently swallows the error.
for (const col of [
  "ALTER TABLE users ADD COLUMN job_function TEXT",
  "ALTER TABLE users ADD COLUMN city TEXT",
]) {
  try { db.prepare(col).run(); } catch (_err) { /* column already exists */ swallowed("db:add-column", _err); }
}
try { db.prepare("ALTER TABLE competition_users ADD COLUMN cxone_username TEXT").run(); } catch (_err) { /* column already exists */ swallowed("db:add-column", _err); }
// v8.8.15 — competition_users.cxone_user_id: the CxOne account's OWN id, stored
// beside the username it was bound under.
//
// The username cannot do this job. It is a Hack Arena nickname, unique only
// inside this deployment and meaningless in the customer's realm, and v8.3.17
// (F1) closed an attack that turned exactly that into a wrong binding. The id
// is the realm's own opaque handle, so it is the only value that can ever
// answer "is this still the SAME account we bound last time?" — which is the
// detection v8.3.17 recorded as deferred and impossible without this column.
//
// NOT backfilled, and that is the point rather than an omission: NULL means
// "bound before this column existed", which is the honest answer. Inventing an
// id from the username would recreate the very conflation the column removes.
// Non-fatal like its sibling: nothing SELECTs it by name in a way that would
// stop the platform serving, so a failed ALTER costs the diagnostic and not
// the deployment.
try { db.prepare("ALTER TABLE competition_users ADD COLUMN cxone_user_id TEXT").run(); } catch (_err) { /* column already exists */ swallowed("db:add-column", _err); }

// v8.12.7 — cxone_realm_accounts: the ledger of Checkmarx One realm accounts
// THIS platform created, so erasing a participant can withdraw theirs. The DDL
// lives in lib/cxone-ledger.js (which requires nothing, so db.js gains no
// dependency) and the unit spec executes the same string.
//
// FATAL, deliberately, unlike the swallowed ALTERs above: provisioning writes
// this table on every 201, so a server without it would create realm accounts
// it can never withdraw. There is NO foreign key (a row must outlive
// deleteUserCascade and the user_events retention purge), NO schema-required
// manifest entry for the CREATE (its key is the PRIMARY KEY inside it and both
// indexes are plain — the ALTERs below are listed) and NO export (rows key on local user ids
// an import mints fresh). There is no index on competition_users.cxone_user_id
// either: it would be a fatal statement on a column the ALTER above swallows.
db.exec(require("./lib/cxone-ledger").CXONE_REALM_ACCOUNTS_DDL);
// Session rows by user: two expression indexes (lib/session-index.js says why;
// the sign-in door's single-session purge scanned every session row without
// them). The store would create the table on first use with this same DDL; it
// is created here so the indexes exist from boot. Non-fatal: without them the
// same query is still correct, only a scan again.
try {
  const _si = require("./lib/session-index");
  db.exec(_si.SESSION_TABLE_DDL);
  for (const ddl of _si.SESSION_INDEX_DDL) db.exec(ddl);
} catch (e) { swallowed("db:session-user-index", e); }
// v8.12.7 (pre-release review) — `created_email_sha`: the sha256 of the address
// the create sent, so the withdrawal runner can hold an account whose realm
// address the tenant has since changed. The CREATE above carries it for a fresh
// database; a table an earlier build of this release created lacks it, and
// CREATE TABLE IF NOT EXISTS never adds a column. Guarded by the table's own
// columns rather than a swallowed error, and FATAL like the CREATE: every 201
// names the column, so a server without it would fail to record the accounts
// it creates. Listed as REQUIRED in lib/schema-required.js.
if (!db.prepare("PRAGMA table_info(cxone_realm_accounts)").all().some(c => c.name === "created_email_sha")) {
  db.prepare("ALTER TABLE cxone_realm_accounts ADD COLUMN created_email_sha TEXT").run();
}
// `created_baseline` (what a created account carried when its job finished:
// role ids and attribute names, no values) and `held_signal` (what made the
// runner hold an account as adopted by the tenant): the same guarded, FATAL
// shape — the provisioning job and the runner's holds write them by name.
// Both listed as REQUIRED in lib/schema-required.js.
if (!db.prepare("PRAGMA table_info(cxone_realm_accounts)").all().some(c => c.name === "created_baseline")) {
  db.prepare("ALTER TABLE cxone_realm_accounts ADD COLUMN created_baseline TEXT").run();
}
if (!db.prepare("PRAGMA table_info(cxone_realm_accounts)").all().some(c => c.name === "held_signal")) {
  db.prepare("ALTER TABLE cxone_realm_accounts ADD COLUMN held_signal TEXT").run();
}

// v7.14.0 — challenge_events.impersonated: analytics-exclusion flag for events
// produced under participant impersonation (see lib/impersonation.js). Guarded
// ALTER for upgraded DBs (fresh installs get it from the CREATE TABLE). The
// analytics covering index idx_chev_comp_task_user_type is rebuilt ONCE to
// append the new column, restoring the index-only-scan property now that every
// analytics query also filters on `ce.impersonated=0` — detected via the stored
// index SQL so the rebuild never repeats on later boots. (The base CREATE INDEX
// above deliberately keeps the pre-v7.14 definition: on an upgraded DB it runs
// BEFORE this migration adds the column — see the pending_email_code ordering
// note below for the boot-crash class this avoids.)
try {
  const chevCols = db.prepare("PRAGMA table_info(challenge_events)").all().map(c => c.name);
  if (!chevCols.includes("impersonated")) {
    db.exec("ALTER TABLE challenge_events ADD COLUMN impersonated INTEGER NOT NULL DEFAULT 0");
  }
  const chevIdx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_chev_comp_task_user_type'").get();
  if (chevIdx && chevIdx.sql && !/impersonated/.test(chevIdx.sql)) {
    db.exec("DROP INDEX idx_chev_comp_task_user_type");
    db.exec("CREATE INDEX idx_chev_comp_task_user_type ON challenge_events(competition_id, task_id, user_id, event_type, impersonated)");
  }
} catch (e) {
  console.error("challenge_events impersonated migration failed:", e.message);
}

// v6.20.x — users.password_set_at records when an account established its
// password; NULL means it has none (every create stores a placeholder hash and
// NULL). Only PUT /api/me/sign-in-method stamps it; `hasUsablePassword` needs it
// AND a real hash, and that route mails "Your password was set" the first time
// and "changed" after.
//
// One-time back-fill: every PRE-EXISTING row is stamped as already-set
// (created_at), so no established user loses the security notification on
// their next reset. The only cost is that invites issued-but-unredeemed at
// upgrade time keep the old (email-on-initial-set) behaviour until redeemed.
// Guarded on column-absence so the back-fill runs EXACTLY ONCE — re-running it
// every boot would wrongly stamp accounts created after the upgrade that are
// still pending their first password.
//
// v8.7.6 — THE BACK-FILL'S BLAST RADIUS CHANGED UNDER IT, and that is the whole
// finding. The paragraph above costed exactly one consequence: an unredeemed
// invite keeps the old notification behaviour. Then v7.29.0 gave this column a
// SECOND job — `password_set_at IS NULL` became the eligibility discriminator
// for the emailed sign-in code — and a stamp written years earlier, for a
// reason about email copy, silently closed a credential door.
//
// MEASURED against a populated pre-migration database: a passwordless account
// goes `NULL` -> `created_at` across this migration and is thereafter refused a
// sign-in code for ever. On any deployment upgraded through v6.20.x that is
// EVERY LinkedIn account then in existence — which is precisely the population
// the code door was built for, and reads as "the feature does not work at all".
//
// So the back-fill now EXCLUDES the accounts that provably never had a password
// (a LinkedIn account holds a `bcrypt(uuid)` its owner has never known — see
// `password_set_at` is the discriminator in CLAUDE.md), and a guarded one-shot
// repair below un-stamps the rows the old form corrupted.
try {
  const uCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!uCols.includes("password_set_at")) {
    db.exec("ALTER TABLE users ADD COLUMN password_set_at TEXT");
    db.exec("UPDATE users SET password_set_at = created_at " +
            "WHERE password_set_at IS NULL AND COALESCE(registered_via,'manual') <> 'linkedin'");
  }
} catch (e) {
  console.error("users password_set_at migration failed:", e.message);
}

// The repair, for databases the old back-fill already ran against.
//
// SCOPED BY THE BACK-FILL'S OWN FINGERPRINT, not by "is it LinkedIn": it clears
// only rows where `password_set_at` is EXACTLY `created_at`, which is the value
// that statement wrote and nothing else does. A LinkedIn user who has since set
// a password has a LATER stamp and is left alone — so the repair
// cannot take a real password away from anybody.
//
// GUARDED BY A SETTINGS MARKER (the `linkedin_signup_default_off_at` shape): the
// guard is the whole of its safety. Un-guarded it would re-run every boot and
// undo an admin — or the account itself — that had legitimately set a password
// since, and a setting that will not stay where it is put is worse than a wrong
// default.
//
// NOT widened to `registered_via='manual'`. An IMPORTED account is passwordless
// too and was equally mis-stamped, but the importer leaves `registered_via` at
// its 'manual' default, so such a row is indistinguishable from somebody who
// really did choose a password — and clearing THAT would hand a live account a
// second credential door nobody asked for. Under-repairing is the safe
// direction; the refusal is now audited, so the remaining cases are at least
// diagnosable (a superadmin can clear the column by hand).
try {
  const done = db.prepare("SELECT value FROM settings WHERE key='password_set_at_backfill_repaired_at'").get();
  if (!done) {
    const r = db.prepare(
      "UPDATE users SET password_set_at = NULL " +
      "WHERE registered_via = 'linkedin' AND password_set_at IS NOT NULL AND password_set_at = created_at"
    ).run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('password_set_at_backfill_repaired_at', ?) " +
               "ON CONFLICT(key) DO NOTHING").run(new Date().toISOString());
    if (r.changes > 0) {
      console.log(`[db] password_set_at repair: ${r.changes} LinkedIn account(s) re-opened to emailed sign-in codes ` +
                  "(the v6.20.x back-fill had stamped accounts that never had a password).");
    }
  }
} catch (e) {
  // Non-fatal, unlike the ALTERs: a failure here leaves the status quo — a door
  // that is shut — rather than a new wrong state, and taking the platform down
  // over it would be worse than the defect.
  console.error("password_set_at repair failed:", e.message);
}

// v6.20.0 — participant groups. New columns on existing DBs (CREATE TABLE
// definitions above cover fresh installs). `direct_assigned` distinguishes
// explicitly-assigned members (1) from members present only via a bound group
// (0) — back-filled to 1 so every pre-existing assignment is treated as
// direct and is never auto-removed by group reconciliation.
for (const sql of [
  "ALTER TABLE competition_users ADD COLUMN direct_assigned INTEGER DEFAULT 1",
  "ALTER TABLE invitations ADD COLUMN group_ids TEXT NOT NULL DEFAULT '[]'",
]) {
  try { db.prepare(sql).run(); } catch (_err) { /* column already exists */ swallowed("db:add-column", _err); }
}

// Sweep #501 (operator ruling, 23 Nov 2026) — WHO MADE AN INVITATION, by account.
// While new accounts wait for approval, an invitation approves the account it
// makes only if its inviter may approve accounts when it is used, read live
// (lib/rbac.js `inviterMayApproveNow`). `invited_by` holds an address, which can
// change hands; this holds the inviting account's id (NULL for the built-in
// superadmin and for invitations made before it, which fall back to the address).
// The invitation INSERT names the column, so the ALTER sits outside any catch: a
// swallowed failure would fail every invitation instead.
{
  const invCols = db.prepare("PRAGMA table_info(invitations)").all().map(c => c.name);
  if (!invCols.includes("invited_by_id")) db.exec("ALTER TABLE invitations ADD COLUMN invited_by_id TEXT");
}

// v6.18.16 — optimistic-concurrency token on competition_timeslots.
// PUT /api/admin/competitions/:id/timeslots/:tsId now accepts
// `expectedUpdatedAt` and rejects 409 when stale, matching the pattern
// on PUT /api/admin/competitions/:id and PUT /api/admin/tasks/:id.
// Back-filled from created_at so existing rows are not treated as
// unversioned/null (which would skip the check entirely).
try {
  const tsCols = db.prepare("PRAGMA table_info(competition_timeslots)").all().map(c => c.name);
  if (!tsCols.includes("updated_at")) db.exec("ALTER TABLE competition_timeslots ADD COLUMN updated_at TEXT");
  // audit v7.7.37 (C15) — backfill every boot (idempotent no-op once applied) so a
  // NULL updated_at can never silently skip the optimistic-concurrency 409.
  db.exec("UPDATE competition_timeslots SET updated_at = created_at WHERE updated_at IS NULL");
} catch (e) {
  console.error("competition_timeslots updated_at migration failed:", e.message);
}

// v6.18.16 — a partial index on users.verify_code: the verification path looks
// a code up (SELECT ... FROM users WHERE verify_code=?), and the partial index
// (WHERE NOT NULL) keeps it tiny — only rows with an active code are indexed.
// IF NOT EXISTS makes this idempotent on repeated boots.
//
// Its twin on users.reset_code served the password reset, which is gone: nothing
// writes or looks up reset_code any more (the column stays for old rows and
// exports), so the index is dropped. Non-fatal: an index is never load-bearing
// for correctness.
try { db.exec("DROP INDEX IF EXISTS idx_users_reset_code"); } catch (e) { console.error("idx_users_reset_code drop failed:", e.message); }
db.exec("CREATE INDEX IF NOT EXISTS idx_users_verify_code ON users(verify_code) WHERE verify_code IS NOT NULL");
// NOTE: the idx_users_pending_email_code index is created LATER, right after the
// pending_email_code column is added (the v7.5.0 migration below) — not here.
// verify_code is an original column so its index is safe to create early, but
// pending_email_code only exists post-migration on an upgrade, so indexing it here crashed boot ("no such column") for upgrades from < v7.5.

// v6.21.0 — per-competition self-enrollment link. A secret, persistent,
// non-guessable 256-bit token lets a participant follow /join/<token>,
// authenticate, and be auto-enrolled into that competition. New columns:
//   self_enroll_token         — the secret (NEVER shipped in list/me/export;
//                               revealed only via the dedicated admin GET).
//   self_enroll_enabled       — 0/1 kill switch, default OFF (admin opts in).
//   self_enroll_allow_instant — RETIRED (operator ruling, 14 Nov 2026): the
//                               "Allow instant join" switch; nothing reads or
//                               writes it, and the routes refuse it by name.
// Every PRE-EXISTING competition is back-filled with a fresh random token
// (one randomBytes per row — can't be expressed as a single UPDATE). The
// partial unique index tolerates a transiently-NULL token (a brand-new row
// before the create handler stamps it) while still guaranteeing uniqueness on
// real tokens. Guarded ALTER pattern, matching reveal_answers_on_end above.
try {
  // lib/util is pure (it requires only `net`), so db.js may reach it.
  const { _b64url } = require("./lib/util");
  const compSe = db.prepare("PRAGMA table_info(competitions)").all().map(c => c.name);
  if (!compSe.includes("self_enroll_token")) {
    db.exec("ALTER TABLE competitions ADD COLUMN self_enroll_token TEXT");
  }
  if (!compSe.includes("self_enroll_enabled")) {
    db.exec("ALTER TABLE competitions ADD COLUMN self_enroll_enabled INTEGER NOT NULL DEFAULT 0");
  }
  if (!compSe.includes("self_enroll_allow_instant")) {
    db.exec("ALTER TABLE competitions ADD COLUMN self_enroll_allow_instant INTEGER NOT NULL DEFAULT 0");
  }
  // v7.11.7 — group_leaderboard_enabled: per-competition opt-in for the group /
  // team leaderboard (default OFF). Even when ON the board only renders with >=2
  // non-empty bound groups (see lib/leaderboard.js buildGroupLeaderboard). Guarded
  // ALTER, same pattern as the self-enroll flags above.
  if (!compSe.includes("group_leaderboard_enabled")) {
    db.exec("ALTER TABLE competitions ADD COLUMN group_leaderboard_enabled INTEGER NOT NULL DEFAULT 0");
  }
  // v7.13.0 — cxone_disabled: per-competition opt-OUT of CxOne account creation
  // (default OFF, i.e. accounts ARE created). When ON, cxOneProvisionUser skips this
  // competition entirely. Guarded ALTER, same pattern as the flags above.
  if (!compSe.includes("cxone_disabled")) {
    db.exec("ALTER TABLE competitions ADD COLUMN cxone_disabled INTEGER NOT NULL DEFAULT 0");
  }
  // v7.16.0 — trusted_network_ips: a per-competition rate-limit allowlist for a
  // venue's NAT egress address. TEXT, comma-separated exact IPs and IPv4 CIDRs,
  // NULL when unset. Only settable on SINGLE-SESSION competitions, and only
  // effective while the competition is live and for 2 hours afterwards — see
  // lib/comp-allowlist.js. Guarded ALTER, same pattern as the flags above.
  if (!compSe.includes("trusted_network_ips")) {
    db.exec("ALTER TABLE competitions ADD COLUMN trusted_network_ips TEXT");
  }
  const _needTok = db.prepare("SELECT id FROM competitions WHERE self_enroll_token IS NULL").all();
  if (_needTok.length) {
    const _setTok = db.prepare("UPDATE competitions SET self_enroll_token=? WHERE id=?");
    db.transaction(rows => { for (const r of rows) _setTok.run(_b64url(crypto.randomBytes(32)), r.id); })(_needTok);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_comp_self_enroll_token ON competitions(self_enroll_token) WHERE self_enroll_token IS NOT NULL");
} catch (e) {
  console.error("competitions self_enroll migration failed:", e.message);
}

// ── v7.29.0 — EVENT KINDS ────────────────────────────────────────────────────
// The competitions table gains a discriminator and the columns the three kinds
// need. Every existing row becomes a `tournament` (the label reads "Competition")
// via the column DEFAULT, so there is no backfill statement and no window in
// which a row is typeless — SQLite populates every row inside the ALTER itself.
// db.js already records why that matters here: the `updated_at` ALTER and its
// separate UPDATE were two autocommit statements, and a crash between them left
// the column present-but-NULL for ever.
//
// FATAL, not warn — and this is the deliberate opposite of the badge-column
// disposition. The competition create INSERT names its columns explicitly and
// the admin list SELECT names all of them, so a half-applied migration does not
// degrade to "the new features are missing": it throws SQLITE_ERROR on EVERY
// competition create and EVERY admin list read, discovered by an admin trying to
// set up an event. Better to refuse to boot and say so. Precedent:
// ensureNocaseUniqueOrFail.
//
// STORED VALUES ARE OPAQUE ON PURPOSE. `booth` / `tournament` / `program` are
// not derivable from the labels ("Booth Event" / "Competition" / "Program"), so a
// future rename is a copy change rather than a fatal migration over every row,
// every export file and every audit blob. The label table lives server-side and
// is served to the client; nothing maps a label back to a value.
try {
  const compK = db.prepare("PRAGMA table_info(competitions)").all().map(c => c.name);
  const add = (col, ddl) => { if (!compK.includes(col)) db.exec(`ALTER TABLE competitions ADD COLUMN ${ddl}`); };

  add("event_kind", "event_kind TEXT NOT NULL DEFAULT 'tournament'");
  // v8.4.0 — WHICH FIELDS THIS EVENT'S SIGN-UP FORM ASKS FOR, AND WHICH IT
  // DEMANDS. Canonical JSON, one state per configurable field, parsed and
  // normalised by lib/registration-fields.js; NULL means "the kind's defaults",
  // which is every existing row and every event an admin has not configured.
  //
  // A JSON column rather than two booleans per field, and the reason is the shape
  // of the thing being stored: a set of fields (five today, more plausible later)
  // x three states, where the states are mutually exclusive per field. Two
  // booleans per field make the one unreachable combination
  // (mandatory-but-not-shown) representable,
  // so every reader would have to re-decide what to do about it; and adding a
  // field would be a migration rather than a copy change. The audit ladder
  // decomposes the blob per field, so History still reads "phone: optional →
  // required" rather than quoting JSON at an operator.
  add("registration_field_policy", "registration_field_policy TEXT");
  // v8.4.0 — may a NEW account be created on this event through LinkedIn? Sign-UP
  // only; an existing LinkedIn account signing in is never affected.
  //
  // v8.4.1 — THE DEFAULT IS 0 (NOT ALLOWED), on the operator's instruction, and
  // it applies to existing events as well as new ones. A Booth Event is a stand
  // in a public hall reached by a QR code on a table: the door that should be
  // open by default is the one the organiser has thought about, not every door
  // the platform can open. Only a Booth Event reads this column at all, so no
  // Competition or Program loses anything.
  add("linkedin_signup_enabled", "linkedin_signup_enabled INTEGER NOT NULL DEFAULT 0");
  // A Program's authority. `duration_minutes` is DERIVED from it, so the two must
  // move together; every other kind leaves this NULL.
  add("deadline_at", "deadline_at TEXT");
  // Named `time_basis`, never `solve_time_basis`: it is about to carry a value
  // that has nothing to do with solving, on a kind with no ranking at all.
  add("time_basis", "time_basis TEXT NOT NULL DEFAULT 'elapsed'");
  add("measure_presence", "measure_presence INTEGER NOT NULL DEFAULT 0");
  // The schema default is 1 because that is today's behaviour for every existing
  // row; the per-kind create default turns it OFF for booth and program.
  add("auto_end_on_all_solved", "auto_end_on_all_solved INTEGER NOT NULL DEFAULT 1");
  // Attempt caps. NULL = unlimited, which is every existing row.
  add("attempt_cap", "attempt_cap INTEGER");
  // Landing in the same migration as the columns above, but deliberately NOT in
  // COMPETITION_FIELD_SCHEMA until the phase that honours them — settable over
  // the API four phases before anything reads them is a control that appears to
  // work, one layer down.
  add("join_code", "join_code TEXT");
  // ── v8.6.0 — LATE ENTRIES ──────────────────────────────────────────────────
  //
  // DEFAULT 1, and it applies to every existing row, which is the operator's
  // instruction ("the default should be on"). Only a Booth Event reads it — the
  // POLICY prohibition in lib/event-policy.js is checked at the gate — so a
  // Competition or a Program carrying a 1 gains nothing and loses nothing, and no
  // one-shot normalisation is needed the way v8.4.1's default flip needed one.
  add("late_entry_enabled", "late_entry_enabled INTEGER NOT NULL DEFAULT 1");
  // WHEN THE WINDOW CLOSES — NULL MEANS "FOLLOW THE EVENT'S END", which is every
  // existing row and every event whose organiser has not pinned a date.
  //
  // ONE COLUMN, NOT A TIMESTAMP PLUS AN `is_overridden` FLAG. The requirement is
  // "48 hours after the event finishes, moving when the finishing time moves,
  // unless the admin pinned it" — and a stored derived value beside a flag is two
  // sources of truth whose failure mode is a writer moving the end and forgetting
  // the flag, leaving a deadline that has silently stopped following. NULL-as-
  // "derived" is the `registration_field_policy` shape (v8.4.0) and the
  // `isOpenEnded` argument (v8.1.0 PR 16) applied to the mirror-image requirement.
  add("late_entry_deadline_at", "late_entry_deadline_at TEXT");
  // ── v8.12.0 — STAFF CAN COMPETE ─────────────────────────────────────────────
  //
  // DEFAULT 0: every existing event keeps today's rule (staff and event admins
  // are never on its board), and an organiser turns it on per event. Universal
  // across the three kinds — the attribute is a decision about WHO counts, not
  // about how the kind plays — so there is no per-kind seed and no policy key.
  // It is read by lib/staff-compete.js and by nothing that tests the column
  // directly: every consumer asks a predicate there, because the question is
  // always "does THIS person compete here", never "is it set".
  add("staff_compete", "staff_compete INTEGER NOT NULL DEFAULT 0");
  // v8.15.0 — the event's CERTIFICATE DESIGN override: a partial JSON layer
  // over the global design (settings.certificate_config) and the built-in
  // defaults, validated and canonicalised by lib/certificate-config.js. NULL =
  // inherit everything, which is every existing row. Design only — no holder
  // fact lives here, so re-skinning an event never changes what its issued
  // certificates claim. Inside this fatal block because PUT/DELETE
  // .../certificate-config write it: a swallowed ADD would 500 every save.
  add("certificate_config", "certificate_config TEXT");
  // The EVENT LOOK (lib/platform-look.js): a look id painted on the event's join
  // landing and for its participants while inside it; NULL = none (every
  // existing row). `event_look_locked` = 1 also overrides a participant's own
  // choice there. Written by PUT .../look, so inside this fatal block.
  add("event_look", "event_look TEXT");
  add("event_look_locked", "event_look_locked INTEGER NOT NULL DEFAULT 0");

  // Three ALTERs are three autocommit statements, so VERIFY rather than assume.
  // A partial apply is the same wrong state as a total failure, and only a
  // re-read can tell them apart.
  const after = db.prepare("PRAGMA table_info(competitions)").all().map(c => c.name);
  const missing = ["event_kind", "registration_field_policy", "linkedin_signup_enabled",
    "deadline_at", "time_basis",
    "measure_presence", "auto_end_on_all_solved", "attempt_cap",
    "join_code", "late_entry_enabled", "late_entry_deadline_at", "staff_compete", "certificate_config", "event_look", "event_look_locked"].filter(c => !after.includes(c));
  if (missing.length) throw new Error(`columns absent after ALTER: ${missing.join(", ")}`);
  const bad = db.prepare(
    "SELECT COUNT(*) c FROM competitions WHERE event_kind IS NULL OR event_kind NOT IN ('booth','tournament','program')"
  ).get().c;
  if (bad > 0) throw new Error(`${bad} competition row(s) carry no valid event_kind`);
  // v8.2.2 — max_self_enrolled is REMOVED. The self-enrolment ceiling is gone
  // from every surface (form, API schema, the join-path enforcement and the
  // public preview's advisory `full`), so the column is dead storage.
  //
  // Guarded on presence, because DROP COLUMN on a missing column throws: a no-op
  // on a fresh DB (the ADD above is gone) and on an already-cleaned one, and a
  // single drop on a DB upgraded from a build that had it.
  //
  // Deliberately NON-FATAL, unlike the ADDs it sits beside, and the asymmetry is
  // the point: a failed ADD leaves a column that every create and list SELECT
  // names, so the platform cannot serve — a failed DROP leaves a column NOTHING
  // reads. Taking the platform down over dead storage would be the worse answer.
  try {
    if (after.includes("max_self_enrolled")) db.exec("ALTER TABLE competitions DROP COLUMN max_self_enrolled");
  } catch (dropErr) {
    console.warn("[migration] could not drop competitions.max_self_enrolled (harmless, nothing reads it):", dropErr.message);
  }
  // v8.4.0 — registration_mode is REMOVED, for the same reason and with the same
  // non-fatal posture. It was added in v7.29.0 to carry "which credential does a
  // registration through this event collect", was never read by anything, and its
  // own comment ("'simplified' is refused for every kind but booth") describes
  // precisely the decision `registration_field_policy.password` now stores.
  //
  // Leaving it would be worse than dead storage: a reader looking for where the
  // password setting lives would find a column named for it, defaulted to
  // 'standard', that governs nothing — which is the control-that-appears-to-work
  // failure aimed at whoever maintains this next.
  try {
    if (after.includes("registration_mode")) db.exec("ALTER TABLE competitions DROP COLUMN registration_mode");
  } catch (dropErr) {
    console.warn("[migration] could not drop competitions.registration_mode (harmless, nothing reads it):", dropErr.message);
  }
  // ── v8.4.1 — the v8.4.0 rows, brought to the new default ONCE ──────────────
  //
  // The ALTER above only decides what a column is born with, so a database that
  // already ran v8.4.0's migration carries `1` on every row — the old default.
  // The operator asked for the new default to apply to existing events too, so
  // those rows are flipped.
  //
  // GUARDED BY A ONE-SHOT MARKER, and that is the whole of its safety. Without it
  // this would re-run at every boot and silently undo an admin who had turned the
  // door back ON — a setting that will not stay where it is put is worse than a
  // wrong default. The marker is written whether or not any row moved, so a fresh
  // install (where the ALTER already did the work) never arms it for later.
  //
  // Non-fatal, matching the DROPs above rather than the ADDs: a failure here
  // leaves a column holding the OLD default, which is the previous release's
  // behaviour, not a broken one.
  try {
    const done = db.prepare("SELECT value FROM settings WHERE key='linkedin_signup_default_off_at'").get();
    if (!done) {
      const n = db.prepare("UPDATE competitions SET linkedin_signup_enabled=0 WHERE linkedin_signup_enabled=1").run().changes;
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('linkedin_signup_default_off_at', ?)")
        .run(new Date().toISOString());
      if (n > 0) console.log(`[db] LinkedIn sign-up defaulted OFF on ${n} existing event(s) (v8.4.1)`);
    }
  } catch (e) {
    console.warn("[migration] could not apply the v8.4.1 LinkedIn sign-up default:", e.message);
  }
} catch (e) {
  console.error([
    "FATAL: could not add the event-kind columns to `competitions`.",
    `Reason: ${e.message}`,
    "Every competition create and every admin competition list names these",
    "columns explicitly, so continuing would throw SQLITE_ERROR on both — an",
    "opaque 500 discovered while an admin is setting up an event.",
    "Remedy: restore the data volume from backup, or add the columns by hand:",
    "  ALTER TABLE competitions ADD COLUMN event_kind TEXT NOT NULL DEFAULT 'tournament';",
    "  (and likewise registration_field_policy, linkedin_signup_enabled, deadline_at,",
    "   time_basis, measure_presence, auto_end_on_all_solved, attempt_cap, join_code,",
    "   late_entry_enabled, late_entry_deadline_at, staff_compete)",
  ].join("\n"));
  process.exit(1);
}

// v8.1.0 (PR 32) — the SHORT JOIN CODE's unique index.
//
// PARTIAL on `join_code IS NOT NULL`, because every competition created before
// that release has a NULL one and a plain UNIQUE index would treat them as
// distinct in SQLite (NULLs never collide) — which is true, but the partial form
// says so explicitly and keeps the index off the rows that carry nothing.
//
// The uniqueness is what lets a code be resolved on its own, with no competition
// id alongside it, which is the entire point: someone types six characters and
// the platform finds the event.
//
// v8.3.11 — MOVED HERE, AFTER the ALTER that adds the column. It used to sit ~400
// lines above, so on a FRESH database the CREATE ran against a table that had no
// `join_code` yet, failed with `no such column`, was swallowed by the catch below,
// and was not retried until the next process start. Measured against the real
// db.js in a throwaway data directory: boot 1 had the column and no index, boot 2
// had both. In a container that "next boot" can be months away, and the entire
// test suite has never once run with the index, because tests/isolated-test.js
// wipes the data directory before every spec file — so every test server is a
// first boot.
//
// The sibling capability on this same table already had it right and is the
// template: `self_enroll_token` does ALTER → backfill → partial unique index, in
// that order, a few dozen lines above. join_code was the lone deviation.
//
// KEEP THIS BELOW THE ALTER. That is the whole fix; a future tidy-up that groups
// the index creations together would silently reintroduce it.
try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_competitions_join_code ON competitions(join_code) WHERE join_code IS NOT NULL");
} catch (e) {
  // Non-fatal, and deliberately the opposite of the nine-column block's
  // disposition: without the index the join-code LOOKUP degrades (a duplicate
  // could resolve ambiguously), but nothing else in the platform reads the
  // column, so refusing to boot would take an event down over a convenience
  // feature. Promoting it to fatal would also brick a database that already
  // holds a duplicate — reachable only by direct SQL or by violating the
  // single-process invariant, but a brick is a worse answer than a warning.
  console.error("[db] could not create uq_competitions_join_code:", e.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// v8.3.12 — `users.left_event_at`: the participant DELIBERATELY went back to the
// event list.
//
// v8.3.8's opt-out is expressed by clearing `active_competition_id` — which says
// "no event is pinned" and cannot say "they chose to unpin it". That was enough
// while the marker was the only landing rule. It is not enough now that a sole
// event is landed in on its own: without this column, a participant with one
// event who pressed Events would be put straight back in at the next sign-in, and
// the opt-out would be real for everyone EXCEPT the people most affected by it.
//
// Set by `POST /api/deselect-competition`, cleared by `select-competition` (they
// chose again, so the departure is spent). NULL on every existing row, which
// reads as "never left" — today's behaviour for anyone who has not used it.
//
// Non-fatal: a failure here leaves a column nothing reads, and the landing rule
// treats an unreadable value as "never left", which is the pre-v8.3.12 answer.
try {
  const uLeft = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!uLeft.includes("left_event_at")) db.exec("ALTER TABLE users ADD COLUMN left_event_at TEXT");
} catch (e) {
  console.error("[db] users left_event_at migration failed:", e.message);
}

// v8.3.11 — NORMALISE `auto_end_on_all_solved` FOR A KIND THAT FORBIDS IT.
//
// A Booth Event never auto-ends because everyone finished — it is a stand that
// stays open for the next walk-up. That is enforced at the gate now
// (`autoEndOnAllSolvedApplies`, lib/event-policy.js), so this migration changes
// no BEHAVIOUR; what it fixes is the REPORTED state. The column rides the admin
// list payload, so a legacy row would answer `auto_end_on_all_solved: 1` to every
// admin client while never acting on it — a wire field contradicting behaviour,
// which is this codebase's "control that appears to work" failure with the sides
// swapped.
//
// The rows exist. At v8.0.0 the competition create INSERT named `event_kind` but
// NOT `auto_end_on_all_solved`, so a Booth Event created in the one-day window
// before v8.0.1 took the schema DEFAULT of 1. Nothing has normalised them since.
//
// NON-FATAL, unlike the ALTER block above: a failure here leaves a column that
// nothing acts on, where a failed ALTER leaves one that every create and list
// SELECT names. Taking the platform down over a cosmetic field would be the worse
// answer. Idempotent — the second boot updates nothing.
//
// The kind list is DERIVED from the policy table rather than written out, so a
// future kind that gains the prohibition is normalised without anyone
// remembering to edit db.js.
try {
  const { EVENT_KINDS, eventPolicy } = require("./lib/event-policy");
  const forbidden = EVENT_KINDS
    .map(k => k.value)
    .filter(v => eventPolicy({ event_kind: v }).autoEndOnAllSolved === "never");
  if (forbidden.length) {
    const ph = "SELECT value FROM json_each(?)";
    const r = db.prepare(
      `UPDATE competitions SET auto_end_on_all_solved=0
        WHERE auto_end_on_all_solved<>0 AND event_kind IN (${ph})`
    ).run(JSON.stringify(forbidden));
    if (r.changes > 0) {
      console.log(`[db] normalised auto_end_on_all_solved=0 on ${r.changes} event(s) of a kind that never auto-ends`);
    }
  }
} catch (e) {
  console.error("[db] auto_end_on_all_solved normalisation failed:", e.message);
}

// v6.21.0 — handoff marker for self-enrollment registration. A user who
// registers through a /join/<token> link is created approved=1 (approval
// skipped) but enrollment is DEFERRED to the sign-in that follows: this column
// carries the target competition to it and is consumed (and cleared) by
// _consumePendingSelfEnroll at sign-in. NULL on
// every existing row (no back-fill), like denied_*/active_competition_id.
// Resolve-and-validate at consume time (no FK) so a deleted comp just clears
// the marker.
try {
  const uSe = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!uSe.includes("pending_self_enroll_comp_id")) {
    db.exec("ALTER TABLE users ADD COLUMN pending_self_enroll_comp_id TEXT");
  }
} catch (e) {
  console.error("users pending_self_enroll_comp_id migration failed:", e.message);
}

// v7.2.0 — the 48h email-verification grace.
//   self_enroll_grace_until — ISO deadline. Today stamped only when a desk code
//     signs in an unverified account (routes/auth.js); while the account is
//     unverified AND now < this deadline it may sign in (a visible "verify your
//     email — N left" countdown shows in the header); once it lapses, sign-in is
//     blocked until the email is verified. Cleared (NULL) the instant verified
//     flips to 1. Only pre-email-first and imported accounts are ever
//     unverified (operator ruling, 14 Nov 2026: kept for them).
//   reset_code_emailed — REMOVED (auth simplification, PR B / F#2). The column
//     was introduced to record whether a live reset_code reached a proven contact
//     channel, so the password-reset route (since removed) could decide whether
//     completing it verified the account. Nothing reads it any more. It is DROPped below (guarded so it's a no-op on a fresh DB that
//     never had it). PR A kept it vestigial to avoid a destructive migration; this
//     is that deferred cleanup.
try {
  const uG = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!uG.includes("self_enroll_grace_until")) {
    db.exec("ALTER TABLE users ADD COLUMN self_enroll_grace_until TEXT");
  }
  // v7.2.x (PR B / F#9) — sha256(OAuth code) of the LinkedIn callback that CREATED
  // this row (set at create only, never re-stamped on a later sign-in). Replaces
  // the fragile 60s-since-created heuristic for distinguishing a duplicate/replayed
  // callback from a fresh sign-in. LinkedIn sign-in is gone, so nothing writes or
  // reads the column now.
  if (!uG.includes("linkedin_last_callback_key")) {
    db.exec("ALTER TABLE users ADD COLUMN linkedin_last_callback_key TEXT");
  }
  // v7.3.0 — optional profile fields: personal_title (Mr./Mrs./Dr./… honorific
  // preset, labelled "Salutation" in the UI as of v7.6.x) and phone (locale-
  // prefilled dialing code + number). Both nullable, no backfill.
  // v7.29.0 — emailed sign-in codes. Three columns, no backfill: NULL means
  // "no live code", which is the correct state for every existing row.
  //   login_code_hash  sha256 of the code, never the code itself. NOT bcrypt:
  //                    cost-10 bcrypt on an unauthenticated endpoint at 60/min/IP
  //                    is ~70 CPU-seconds per minute per IP, an event-loop DoS on
  //                    a single-process server. The code carries ~40 bits and is
  //                    single-use with a 10-minute TTL, so a fast hash is right.
  //   login_code_at    mint time; the TTL is measured from it and a RESEND must
  //                    not move it, or three sends would buy 30 minutes.
  //   login_code_sends how many times the live code has been delivered.
  if (!uG.includes("login_code_hash")) {
    db.exec("ALTER TABLE users ADD COLUMN login_code_hash TEXT");
  }
  if (!uG.includes("login_code_at")) {
    db.exec("ALTER TABLE users ADD COLUMN login_code_at TEXT");
  }
  if (!uG.includes("login_code_sends")) {
    db.exec("ALTER TABLE users ADD COLUMN login_code_sends INTEGER NOT NULL DEFAULT 0");
  }
  if (!uG.includes("personal_title")) {
    db.exec("ALTER TABLE users ADD COLUMN personal_title TEXT");
  }
  if (!uG.includes("phone")) {
    db.exec("ALTER TABLE users ADD COLUMN phone TEXT");
  }
  // v7.5.0 — pending-email confirmation. A primary-email CHANGE is no longer
  // applied immediately; the new address is parked in pending_email with a
  // confirmation code until the user clicks the link sent to it (the current
  // email + verified state stay active throughout). All three nullable, no
  // backfill; internal markers (schema-drift EXCLUDED allow-list).
  if (!uG.includes("pending_email")) {
    db.exec("ALTER TABLE users ADD COLUMN pending_email TEXT");
  }
  if (!uG.includes("pending_email_code")) {
    db.exec("ALTER TABLE users ADD COLUMN pending_email_code TEXT");
  }
  if (!uG.includes("pending_email_code_at")) {
    db.exec("ALTER TABLE users ADD COLUMN pending_email_code_at TEXT");
  }
  // Partial index on the pending-email confirmation code — created HERE, after the
  // column-add above, NOT in the early index block (which runs before this
  // migration and so crashed boot on any upgrade from < v7.5 with
  // "no such column: pending_email_code"). Mirrors the self_enroll_token pattern:
  // ALTER the column first, then index it. Idempotent on fresh installs (the
  // column is in CREATE TABLE) and on repeat boots (IF NOT EXISTS).
  db.exec("CREATE INDEX IF NOT EXISTS idx_users_pending_email_code ON users(pending_email_code) WHERE pending_email_code IS NOT NULL");
  // The address a pending primary change reserves, found by index
  // (lib/email-identity.js `emailIsTaken`, which every sign-up asks several
  // times): the LOWER() form it replaced scanned every account per call.
  db.exec("CREATE INDEX IF NOT EXISTS idx_users_pending_email_nocase ON users(pending_email COLLATE NOCASE) WHERE pending_email IS NOT NULL");
  // The event team report's possible-duplicate check (lib/event-team.js
  // `DUP_CANDIDATES_SQL`) finds everyone sharing a lead's last name on every
  // report read; without this every read scanned all accounts. The query must
  // repeat the expression byte for byte, or the planner scans.
  db.exec("CREATE INDEX IF NOT EXISTS idx_users_last_name_key ON users(LOWER(TRIM(last_name)))");
  // v7.6.0 — first_verified_at: the timestamp an account FIRST became verified.
  // Stamped on every verified 0→1 transition (verify / reset / admin-verify /
  // email-change confirm) and NEVER cleared. The unverified-account reaper only
  // deletes rows where this is NULL, so a once-verified account is never swept.
  // Backfill every currently-verified user so they are immediately exempt, then
  // record a one-time grandfather FLOOR (the deploy time) below so accounts that
  // predate the reaper are preserved regardless of verification state.
  // audit v7.7.37 (C15) — backfill outside the column-absence guard so a crash
  // between the ALTER and the UPDATE self-heals. `WHERE verified=1 AND
  // first_verified_at IS NULL` is idempotent (every 0→1 transition stamps it
  // post-migration, so this is a no-op once applied) and only ever ADDS a reaper
  // exemption — it never wrongly clears one.
  if (!uG.includes("first_verified_at")) db.exec("ALTER TABLE users ADD COLUMN first_verified_at TEXT");
  db.exec("UPDATE users SET first_verified_at = COALESCE(approved_at, created_at, CURRENT_TIMESTAMP) WHERE verified=1 AND first_verified_at IS NULL");
  // Grandfather floor for the unverified-account reaper — set ONCE, at the first
  // boot carrying this feature. The reaper only deletes accounts created at/after
  // this instant, so pre-existing (incl. abandoned-but-unverified) accounts are
  // never mass-deleted on the upgrade. New registrations are subject to the 48h
  // rule. DO NOTHING on conflict keeps the original deploy time stable.
  db.prepare("INSERT INTO settings(key,value) VALUES('account_reaper_floor_at', ?) ON CONFLICT(key) DO NOTHING")
    .run(new Date().toISOString());
  // Guarded DROP — DROP COLUMN on a missing column throws, so gate on presence.
  // No-op on a fresh DB (the ADD migration that used to create it is gone) and on
  // an already-cleaned DB; drops it once on a DB upgraded from a pre-PR-B build.
  if (uG.includes("reset_code_emailed")) {
    db.exec("ALTER TABLE users DROP COLUMN reset_code_emailed");
  }
} catch (e) {
  console.error("users grace-migration / reset_code_emailed DROP failed:", e.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// v8.1.x — users.login_code_via: HOW the live sign-in code reached its holder.
//
// A code is one object with two provenances, and redeeming them must NOT do the
// same thing:
//   'email' — it was delivered to the account's own inbox, so redeeming it
//             proves the holder controls that mailbox, and it VERIFIES the
//             account.
//   'desk'  — an admin read it off their own screen and said it out loud. It
//             proves nothing whatsoever about the mailbox, so it must never set
//             `verified`. (The redeem path stamps the ordinary 48h verification
//             GRACE instead, or the desk fallback would sign someone in to a
//             session that requireParticipant destroys on its very first
//             request.)
//
// NULLABLE, NO BACKFILL, AND **NULL IS THE SAFE OPTION**. Every row predating
// this column, and any code minted by a caller that did not say how it was
// delivered, reads as "provenance unknown" — which is treated exactly like
// 'desk': it signs the holder in and verifies nothing. Getting this backwards
// would make an unknown provenance a silent email-verification bypass, which is
// the one failure this column exists to prevent, so the discriminator is an
// allow-list on 'email' rather than a check for 'desk'.
//
// NOT INSIDE A try/catch, deliberately, and the same call as `tasks.attempt_cap`
// above rather than the swallow-and-continue blocks either side of it: every
// mint names this column, so a missing one is not "provenance is unavailable" —
// it is SQLITE_ERROR on every code request AND on the desk reveal, i.e. the
// whole passwordless door dead at an event, discovered by an organiser with a
// queue in front of them. Refusing to boot is the better failure. With a SINGLE
// ALTER there is no partial-apply state to re-verify the way the nine-column
// block needs.
{
  const lcCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!lcCols.includes("login_code_via")) db.exec("ALTER TABLE users ADD COLUMN login_code_via TEXT");
  // users.login_code_comp_id — the event the LIVE emailed code is bound to (a
  // registration or code request that came from a join link, QR or join code).
  // Only redeeming that code enrols; it is cleared with the code. No foreign key:
  // a deleted event simply fails admission at redeem. Outside try/catch for the
  // same reason as login_code_via: every mint and clearCode() names it.
  if (!lcCols.includes("login_code_comp_id")) db.exec("ALTER TABLE users ADD COLUMN login_code_comp_id TEXT");
  // users.login_method — how the account signs in: NULL follows its role (an
  // unscoped admin role: a password; every other role: an emailed code),
  // 'password' or 'code' is the person's own choice (lib/login-method.js).
  // Outside try/catch: the sign-in-method route writes it and every sign-in
  // reads it, so a swallowed ALTER would 500 both.
  if (!lcCols.includes("login_method")) db.exec("ALTER TABLE users ADD COLUMN login_method TEXT");
}

// ── users.updated_at — optimistic concurrency on the PROFILE fields ──────────
//
// Both profile write paths were last-writer-wins: `PUT /api/me` and
// `PUT /api/admin/participants/:id` each read the row, then wrote it, with
// nothing between them. v8.3.37 narrowed the blast radius by sending only the
// fields a dialog actually CHANGED, so two people editing different fields no
// longer clobber each other — but two people editing the SAME field still do,
// silently, and both are told they succeeded. This is the `competitions`
// fingerprint (v6.16.27) applied to `users`: the client echoes the `updated_at`
// it last read, and the second writer is 409'd instead.
//
// THE BACKFILL IS NOT OPTIONAL, for the reason the competitions block above
// states in full: the check compares the caller's value against the stored one,
// so a row left NULL matches nothing the client can send and the 409 is
// silently DISABLED for exactly that row — a column present-but-NULL for ever.
// `created_at` is `TEXT NOT NULL` on this table, so it is always a usable seed.
// Outside the column-absence guard so a crash between the ALTER and the UPDATE
// self-heals, and `WHERE updated_at IS NULL` makes it idempotent (every profile
// write stamps the column post-migration, so this is a no-op once applied).
//
// IT DOES NOT COVER ROWS CREATED AFTER THIS BOOT, and that is why the READ side
// does not use the bare column. None of the six production `INSERT INTO users`
// statements names `updated_at`, so a participant registering during an event
// would carry NULL and be silently exempt from the very check this column adds.
// `profileVersionSql()` (lib/util.js) is the fingerprint every reader and the
// compare-and-swap actually use — `COALESCE(updated_at, created_at)` — so a new
// row is protected from the instant it exists. This backfill stays because the
// stored column is what `lib/schema-required.js` and `/readyz` can see, and
// because a populated column keeps the fingerprint readable in a raw SQL session.
//
// SCOPE — ONLY THE THREE PROFILE WRITERS BUMP THIS, and that is the whole
// design rather than an omission. `users` carries 61 UPDATE statements at the
// time of writing; a blanket bump (a trigger, or stamping it on every write)
// was evaluated and REFUSED. Login stamps `login_time` / `last_login_time` and
// clears the lockout counters; navigation stamps `active_competition_id`,
// `left_event_at` and `pending_self_enroll_comp_id`; credential and lifecycle
// writes touch the row constantly. Bumping on any of those means an admin's
// open Edit-Profile dialog 409s because the participant merely SIGNED IN — a
// control that fails for a reason the operator cannot see or act on. The
// version guards the PROFILE FIELDS, so only the statements that write them
// move it. A SQLite trigger was refused for the same reason plus a second: it
// would be this codebase's first, invisible to `lib/schema-required.js`, to
// `node --check` and to anyone reading the route, and its column list would be
// a fourth copy of the profile-field set with nothing diffing them.
{
  const puCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!puCols.includes("updated_at")) db.exec("ALTER TABLE users ADD COLUMN updated_at TEXT");
  db.exec("UPDATE users SET updated_at = created_at WHERE updated_at IS NULL");
}

// ── v7.21.18 — rename the dry-run competition tag: "internal" → "test/dry run" ──
//
// The marker is stored as an ordinary row in `competition_tags`, so renaming the
// concept means rewriting the stored VALUE. Everything downstream keys on that
// string — the analytics default exclusion, the permanent-tag allowlist, the
// badge refusal, the ribbon on the picker card — so an un-migrated database
// would keep its dry-run competitions marked while every reader looked for the
// new name: the competitions would silently rejoin analytics and become
// badge-eligible. That is the failure this migration exists to prevent, and it
// is why it runs unconditionally at boot rather than behind a version flag.
//
// UPDATE OR IGNORE then DELETE, rather than a bare UPDATE: the primary key is
// (competition_id, tag), so a competition that somehow carries BOTH strings
// would violate it. OR IGNORE leaves that row alone and the DELETE clears the
// old one either way — which also makes the whole thing idempotent, so a second
// boot is a no-op rather than an error.
//
// v7.21.19 (audit F6) — this is FATAL on failure, and the v7.21.18 reasoning for
// making it non-fatal was wrong in a way the same patch had already documented
// three paragraphs above: an un-migrated row does not merely "still read
// internal". Every reader looks for the NEW string, so that competition rejoins
// analytics and becomes badge-eligible — the second of which publishes a
// permanent public page in a participant's name. That is serving semantically
// wrong data, not a cosmetic marker, and it does it silently.
//
// Precedent for exiting: ensureNocaseUniqueOrFail above does the same when it
// cannot establish the case-insensitive identity invariant. The failure mode a
// transient error produces here is a restart, which is recoverable; the failure
// mode of carrying on is wrong public artefacts, which is not.
try {
  const _renamed = db.prepare("UPDATE OR IGNORE competition_tags SET tag='test/dry run' WHERE tag='internal'").run().changes;
  const _dropped = db.prepare("DELETE FROM competition_tags WHERE tag='internal'").run().changes;
  if (_renamed || _dropped) {
    console.log(`[migration] competition tag "internal" -> "test/dry run": ${_renamed} renamed, ${_dropped} duplicate row(s) removed`);
  }
  // VERIFY, rather than trust the statements' return values: a partial apply is
  // the same wrong state as a total failure, and only a re-read can tell.
  const _left = db.prepare("SELECT COUNT(*) c FROM competition_tags WHERE tag='internal'").get().c;
  if (_left > 0) throw new Error(`${_left} row(s) still carry the old tag after the rename`);
} catch (e) {
  console.error([
    'FATAL: could not migrate the competition tag "internal" -> "test/dry run".',
    `Reason: ${e.message}`,
    "Refusing to start. Every reader looks for the new tag, so leaving rows on the",
    "old one would silently return those competitions to Analytics and make them",
    "badge-eligible — a badge publishes a permanent public page.",
    "If this is transient (a locked database, for instance), restart. If it is not,",
    "resolve it directly:  UPDATE competition_tags SET tag='test/dry run' WHERE tag='internal';",
  ].join("\n"));
  process.exit(1);
}

// ── v7.27.0 — one-time backfill: drop navigated_away rows recorded AT OR AFTER
//    the participant solved that challenge ────────────────────────────────────
//
// Until v7.27.0 the SPA fired a navigated_away on the solve path itself (the
// congrats dialog is followed by showMain('tasks-page'), which is the departure
// hook), and again every time somebody re-opened a solved challenge to review
// it. Both are now refused — by the client on the solve path and, decisively, by
// the `already_solved` gate in routes/participant.js. This removes the rows the
// gate would have refused, so historical analytics matches the new rule instead
// of carrying a step change at the deploy.
//
// THE PREDICATE IS NOT A HEURISTIC. It is the gate's own rule applied
// retrospectively: a row is invalid exactly when a CORRECT submission for the
// same (user, task, competition) already existed when it was written. Both
// columns are `now().toISOString()` UTC ISO-8601, so `<=` compares
// chronologically as well as lexicographically.
//
// It deliberately KEEPS pre-solve rows. Bouncing off a challenge and coming back
// to solve it later is a real bounce, and the whole point of the signal; only
// "already solved" is noise. That also makes this strictly narrower than the
// live gate, which is the right direction for data nobody can re-derive.
//
// Competition-scoped, like the gate — a task can be assigned to several, and
// solving it in one says nothing about the others. `submissions.competition_id`
// is nullable, and a NULL never satisfies `=`, so a legacy row with no
// competition keeps its events rather than deleting on a guess.
//
// `impersonated` is not consulted, again matching the gate: the rule is about the
// challenge being solved, not about who was looking.
//
// NON-FATAL, and the marker is written only on success, so a failure retries on
// the next boot. Unlike the dry-run tag rename above, skipping this leaves the
// database exactly as v7.26.0 left it — over-counted historical analytics, which
// is the status quo being improved rather than a new wrong state. Refusing to
// start over a retrospective analytics cleanup would be disproportionate.
//
// Recorded with console.log + a settings row rather than an audit event: db.js
// cannot require lib/audit.js (that module requires db.js), and this follows the
// convention every other migration in this file already uses. The count and the
// timestamp are kept in `settings` so the deletion is discoverable afterwards.
try {
  const _navBackfillDone = db.prepare("SELECT value FROM settings WHERE key='navaway_solved_backfill_at'").get();
  if (!_navBackfillDone) {
    const _removed = db.prepare(`
      DELETE FROM challenge_events
       WHERE event_type = 'navigated_away'
         AND EXISTS (
           SELECT 1 FROM submissions s
            WHERE s.user_id        = challenge_events.user_id
              AND s.task_id        = challenge_events.task_id
              AND s.competition_id = challenge_events.competition_id
              AND s.is_correct     = 1
              AND s.submitted_at  <= challenge_events.occurred_at
         )`).run().changes;
    db.prepare("INSERT INTO settings(key,value) VALUES('navaway_solved_backfill_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(new Date().toISOString());
    db.prepare("INSERT INTO settings(key,value) VALUES('navaway_solved_backfill_removed', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(_removed));
    if (_removed > 0) {
      console.log(`[migration] navigated_away backfill: removed ${_removed} row(s) recorded at or after the challenge was solved`);
    }
  }
} catch (e) {
  console.error(
    "navigated_away solved-row backfill failed (retrying next boot):", e.message,
    "\n  Historical Analytics / activity-CSV counts stay over-reported until it succeeds; nothing else is affected."
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// v8.7.0 — THE EVENT-ADMIN SCOPE TABLE, AND THE THREE OWNERSHIP COLUMNS.
//
// `users.role='event_admin'` is the TIER (it is what `requireAdmin` admits and
// `requireSuperAdmin` refuses); `competition_admins` is the SCOPE (which events
// that tier may act on). Neither is derivable from the other, and that is the
// point: a row here for a user whose role is `admin` is inert (a global admin
// already sees everything), and `role='event_admin'` with zero rows is a
// coherent, FAIL-CLOSED state — every list comes back empty and every predicate
// refuses. Both drift directions are safe, which is why the pair is two facts
// rather than one derived one.
//
// FATAL by design, in a bare block with no try/catch — the `attempt_grants`
// disposition above, for a stronger reason. `scopedCompetitionIds()` reads this
// table on EVERY admin request made by an event admin. A missing table must stop
// the process, because the alternative is a reader who wraps the read in a catch,
// gets `[]`, and then "fixes" the empty scope by treating it as unscoped — which
// is the exact fail-open this whole feature exists to prevent.
{
  db.exec(`
    CREATE TABLE IF NOT EXISTS competition_admins (
      competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      user_id        TEXT NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
      granted_by     TEXT,
      granted_at     TEXT NOT NULL,
      PRIMARY KEY (competition_id, user_id)
    );
  `);
  // The hot query is "which competitions may this actor see", keyed on USER —
  // and the primary key's leading column is competition_id, so it cannot serve
  // it. Plain, not unique: the PK already enforces the invariant, so this is a
  // performance property and is deliberately absent from REQUIRED_INDEXES.
  db.exec("CREATE INDEX IF NOT EXISTS idx_competition_admins_user ON competition_admins(user_id)");
}

// The ownership + provenance columns. SWALLOWED, unlike the table above: each
// one degrades a FEATURE (an event admin loses edit or unassign rights over a
// row) rather than breaking a write path, and NULL is a defined, fail-closed
// value that every predicate already has to handle.
//
// A USER ID, never an email. `getAdminIdentity(req)` returns `users.email` (or
// the literal "superadmin" for the built-in account), which is right for the
// audit trail and wrong for authorization: an email genuinely moves — `PUT
// /api/me` stages a change, and since v8.3.36 so does the admin path — so an
// event admin who corrected their own address would silently lose edit rights
// over every challenge they had created, with nothing on any screen saying why.
// `competition_tasks.assigned_by` and `groups.created_by` keep their emails and
// their existing meaning. Two columns, two jobs.
//
// NO BACKFILL on any of the three. NULL means "created or assigned before this
// feature, or by an actor we did not record", which resolves to *no event admin
// owns this* — accurate, since every pre-existing row was written by a globally
// scoped admin, and fail-closed. Deriving `tasks.created_by_id` from
// `task_versions` is possible and is deliberately NOT done: it would
// retroactively grant edit rights over rows the operator never decided about,
// and it would have to map an email that may since have moved back to an id.
//
// NO FOREIGN KEYS, matching every other `*_by` column in this file
// (`competition_tasks.assigned_by`, `groups.created_by`, `group_members.added_by`).
// Ids are uuids and are never reused, so a dangling id matches no actor and the
// predicate fails closed by construction; an `ON DELETE SET NULL` added by ALTER
// would additionally make `deleteUserCascade` transfer a challenge to "unowned"
// through a path nobody reads.
try {
  const _tCols  = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
  if (!_tCols.includes("created_by_id")) db.exec("ALTER TABLE tasks ADD COLUMN created_by_id TEXT");
  const _ctCols = db.prepare("PRAGMA table_info(competition_tasks)").all().map(c => c.name);
  if (!_ctCols.includes("assigned_by_id")) db.exec("ALTER TABLE competition_tasks ADD COLUMN assigned_by_id TEXT");
  const _gCols  = db.prepare("PRAGMA table_info(groups)").all().map(c => c.name);
  if (!_gCols.includes("created_by_id")) db.exec("ALTER TABLE groups ADD COLUMN created_by_id TEXT");
} catch (e) {
  console.error(
    "[migration] could not add event-admin ownership columns:", e.message,
    "\n  Event admins lose edit / unassign / group-delete rights until it succeeds; every other tier is unaffected."
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// v8.12.8 — EXISTING DESK ACCOUNTS ARE LINKED TO THE EVENT THEY WERE CREATED FOR.
//
// The operator's ruling: an account made by the at-desk invite shortcut is that
// event's walk-up exactly as a QR sign-up is, so it reads the event's LIVE sign-up
// form through `users.registration_competition_id` (never a password — see
// `_profileMissingFields`). The desk writes the pointer from v8.12.8 on; this links
// the accounts it made before, BUT ONLY WHERE THE EVENT IS BEYOND DOUBT. A wrong
// link is worse than none: it would demand another organiser's mandatory fields of
// somebody behind a NON-DISMISSIBLE gate, while no link leaves them exactly where
// they stand today (the stamped `profile_policy` fallback).
//
// WHO IS CONSIDERED: `registered_via='desk'`, no pointer yet, and `profile_policy`
// NOT NULL. The last clause is the desk's own witness that an event was named: it
// stamped the event's kind there, and `event_kind` is NOT NULL, so a desk account
// with no event carries NULL and is never touched.
//
// `registered_via='desk'` IS NOT PROOF THE DESK MADE THE ROW HERE. The participant
// import writes the column VERBATIM from the file (both its CREATE and OVERWRITE
// branches), together with `profile_policy`, `created_at` and every membership's
// `assigned_at` — resolving each event by NAME. So a desk account exported from
// another instance and imported BEFORE this release carries every property this
// pass selects on, and its imported membership passes the witness test below to
// the millisecond. Linking it would be exactly the invented pointer the one-shot
// rule (further down) exists to prevent: the same file imported a minute after
// the upgrade is never linked, and the pointer is deliberately not portable.
//
// TWO WITNESSES, both written by the desk in its one create transaction:
//   * the `added_to_competition` user event with `via:"desk_invite"`, carrying
//     the event's id — survives the participant being removed from the event
//     later, but is purged by event retention (EVENT_RETENTION_DAYS). The import
//     cannot reproduce it: the export carries no user events, and the row hangs
//     off the account id the desk itself minted.
//   * the `competition_users` row whose `assigned_at` equals `users.created_at`
//     to the millisecond (the desk binds one `createdAt` to both) — survives
//     retention, but not a removal. THIS is the witness the import can
//     reproduce, so it counts only where the import did not write it.
// Each covers the other's blind spot.
//
// AND TWO WAYS THE IMPORT DISCLAIMS A WITNESS, read from its own audit rows:
//   * the account has a `created` event with `via:"import"` → the import MINTED
//     it, so nothing on it is the desk's work here; the whole row is skipped.
//     This is the stronger of the two: that row is written unguarded inside the
//     same transaction as the account's INSERT, so an account the import created
//     cannot exist without one, where the per-membership row below is written
//     best-effort (caught and dropped on failure).
//   * an `added_to_competition` event with `via:"import"` names the membership's
//     event → the import wrote THAT membership, so it is not a witness. This is
//     what covers the OVERWRITE branch, which records `edited` rather than
//     `created`: there the account is a genuine local one, and a witness the
//     import did NOT write — a desk audit row, a membership that predates the
//     file (the import's INSERT OR IGNORE leaves it alone and writes no row) —
//     still counts. Skipping every account an import ever touched would also
//     skip a real desk account an operator later corrected by round-tripping it.
// Both are audit rows, so both are purged by retention with everything else: an
// import older than EVENT_RETENTION_DAYS is indistinguishable from a desk account
// whose history was purged. The desk shortcut is younger than the default window,
// so only an operator-shortened window reaches that case.
//
// THE REMAINING WITNESSES MUST NAME EXACTLY ONE EVENT, and that event must still
// exist:
//   * one event, present   → linked.
//   * one event, deleted   → LEFT ALONE. The pointer would dangle from birth and
//     the gate would answer from `profile_policy` either way, so a link adds only
//     a foreign id; that is also where a QR account ends up once its event goes.
//   * two or more events   → LEFT ALONE, and reported. Inconsistent evidence is
//     not settled by picking one.
//   * none                 → LEFT ALONE (history purged AND the membership gone),
//     reported apart from an account left alone because the import disclaimed
//     its only witness.
//
// The details blob is parsed in JS, not with `json_extract`: SQLite raises on a
// malformed JSON value, which would abort the whole pass on one hand-edited row
// and retry — and fail — at every boot.
//
// GUARDED BY A ONE-SHOT MARKER (the `linkedin_signup_default_off_at` shape), armed
// whether or not a row moved, and written in the SAME transaction as the links, so
// a failure commits neither and the next boot retries. One-shot rather than
// idempotent-every-boot because only the accounts made BEFORE this release need
// it: every desk account made after carries its pointer from birth. Re-running
// would also keep re-deciding every later participant IMPORT, whose rows the
// disclaimers above turn away only while the import's own audit rows survive —
// and the pointer is deliberately not portable (it is EXCLUDED from the export),
// so no migration may invent one for them.
//
// `updated_at` is NOT bumped: it is the PROFILE fingerprint an open edit dialog
// compares against (v8.8.25), and this changes no profile field — bumping it would
// 409 a dialog left open across a restart for a conflict that never happened. No
// me-cache bust either: the cache is in-process memory and this runs at require
// time, before the server has answered a single request. Non-fatal, like every
// data repair here: a failure leaves the previous release's behaviour, not a new
// wrong state.
try {
  const done = db.prepare("SELECT value FROM settings WHERE key='desk_registration_link_backfill_at'").get();
  if (!done) {
    const deskRows = db.prepare(
      "SELECT id, created_at FROM users WHERE registered_via='desk' " +
      "AND registration_competition_id IS NULL AND profile_policy IS NOT NULL"
    ).all();
    // The LIKE clauses only narrow the read; every decision is made on the
    // parsed blob below.
    const auditRows = db.prepare(
      "SELECT event_type, details FROM user_events WHERE user_id=? AND (" +
      "(event_type='added_to_competition' AND (details LIKE '%desk_invite%' OR details LIKE '%import%')) " +
      "OR (event_type='created' AND details LIKE '%import%'))"
    );
    const deskMembership = db.prepare("SELECT competition_id FROM competition_users WHERE user_id=? AND assigned_at=?");
    const compExists = db.prepare("SELECT 1 AS x FROM competitions WHERE id=?");
    const link = db.prepare("UPDATE users SET registration_competition_id=? WHERE id=? AND registration_competition_id IS NULL");
    let linked = 0, ambiguous = 0, deleted = 0, unknown = 0, imported = 0;
    db.transaction(() => {
      for (const u of deskRows) {
        const events = new Set();
        const importedInto = new Set();
        let madeByImport = false;
        for (const a of auditRows.all(u.id)) {
          let d = null;
          try { d = JSON.parse(a.details); } catch (_) { d = null; }
          if (!d || typeof d !== "object") continue;
          if (a.event_type === "created") { if (d.via === "import") madeByImport = true; continue; }
          if (typeof d.competition_id !== "string" || !d.competition_id) continue;
          if (d.via === "desk_invite") events.add(d.competition_id);
          else if (d.via === "import") importedInto.add(d.competition_id);
        }
        if (madeByImport) { imported++; continue; }
        let disclaimed = false;
        for (const m of deskMembership.all(u.id, u.created_at)) {
          if (importedInto.has(m.competition_id)) { disclaimed = true; continue; }
          events.add(m.competition_id);
        }
        if (events.size === 0) { if (disclaimed) imported++; else unknown++; continue; }
        if (events.size > 1) { ambiguous++; continue; }
        const [cid] = events;
        if (!compExists.get(cid)) { deleted++; continue; }
        linked += link.run(cid, u.id).changes;
      }
      db.prepare("INSERT INTO settings (key, value) VALUES ('desk_registration_link_backfill_at', ?) ON CONFLICT(key) DO NOTHING")
        .run(new Date().toISOString());
    }).immediate();
    if (linked || ambiguous || deleted || unknown || imported) {
      console.log(`[migration] desk accounts linked to their event's sign-up form: ${linked}` +
        ` (left alone: ${ambiguous} ambiguous, ${deleted} whose event was deleted, ${unknown} with no surviving record,` +
        ` ${imported} brought in by a participant import)`);
    }
  }
} catch (e) {
  console.error(
    "[migration] could not link existing desk accounts to their event (retrying next boot):", e.message,
    "\n  Those accounts keep reading their event kind's default sign-up form until it succeeds; nothing else is affected."
  );
}

// ── v8.15.0 — EVENT TEMPLATES ─────────────────────────────────────────────────
//
// A template is a reusable, never-live event BLUEPRINT: a kind, the event's
// settings (a JSON object validated by the same field schema the competition
// create uses, and re-validated at every spawn) and a list of challenge ids. It
// is never an event — nothing reads it as one and nobody enrols in it — and
// spawning it (POST /api/admin/event-templates/:id/spawn) creates an ordinary
// upcoming event through the same path as Clone event.
//
// FATAL by design (no try/catch), like every base table: the template routes
// write it unconditionally. The NOCASE unique index keeps two templates from
// sharing a name that reads the same in a list; it is in REQUIRED_INDEXES
// (lib/schema-required.js).
//
// `created_by_id` is a user id with no foreign key: a template outlives its
// author (deleteUserCascade leaves rows naming somebody as an actor alone), and
// no permission is keyed on it — templates are managed by global admins only.
{
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_templates (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      event_kind    TEXT NOT NULL,
      settings      TEXT NOT NULL DEFAULT '{}',
      task_ids      TEXT NOT NULL DEFAULT '[]',
      created_by_id TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      is_builtin    INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_event_templates_name_nocase ON event_templates(name COLLATE NOCASE);
  `);
}

// v8.17.0 — TEMPLATE PROTECTION. Three columns, each named by the template routes'
// writes, so the ALTERs are OUTSIDE try/catch (a swallowed ADD would turn every
// delete, protect and restore into SQLITE_ERROR):
//   builtin_key — which built-in a row is (lib/event-template-builtins.js); NULL
//                 for an administrator's template. "Reset to default" and
//                 "Restore built-in templates" key on it, never on the name.
//   protected   — 1: nobody may delete it until a global admin unprotects it.
//   deleted_at  — a soft delete; "Recently deleted" restores it, and the daily
//                 sweep purges it TEMPLATE_RESTORE_DAYS later.
// All three are in REQUIRED_COLUMNS (lib/schema-required.js). The backfill of
// `builtin_key` for rows seeded before the column existed runs once, behind a
// settings marker, matching the seeded names.
{
  const _tplCols = db.prepare("PRAGMA table_info(event_templates)").all().map(c => c.name);
  if (!_tplCols.includes("builtin_key")) db.exec("ALTER TABLE event_templates ADD COLUMN builtin_key TEXT");
  if (!_tplCols.includes("protected")) db.exec("ALTER TABLE event_templates ADD COLUMN protected INTEGER NOT NULL DEFAULT 0");
  if (!_tplCols.includes("deleted_at")) db.exec("ALTER TABLE event_templates ADD COLUMN deleted_at TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_event_templates_deleted_at ON event_templates(deleted_at)");
}
try {
  const done = db.prepare("SELECT value FROM settings WHERE key='event_templates_builtin_key_at'").get();
  if (!done) {
    const { BUILTIN_TEMPLATES } = require("./lib/event-template-builtins");
    db.transaction(() => {
      for (const b of BUILTIN_TEMPLATES) {
        db.prepare("UPDATE event_templates SET builtin_key=? WHERE is_builtin=1 AND builtin_key IS NULL AND name=? AND event_kind=?").run(b.key, b.name, b.kind);
      }
      db.prepare("INSERT INTO settings (key, value) VALUES ('event_templates_builtin_key_at', ?) ON CONFLICT(key) DO NOTHING").run(new Date().toISOString());
    }).immediate();
  }
} catch (e) {
  console.error("[migration] could not backfill event_templates.builtin_key (retrying next boot):", e.message);
}

// v8.15.1 — AUTOMATIC CERTIFICATES AND THE CONGRATULATIONS EMAIL
// (lib/certificate-dispatch.js). Two tables, both base CREATEs (fatal, like every
// base table: a missing one would make every end path fail its enqueue).
//
// `certificate_dispatch_jobs` is the DURABLE QUEUE. Every end path (End Now, the
// scheduler's time expiry, the all-solved auto-end, session ends, Close late
// entries now) upserts one row per event (`user_id = ''`); a Program's correct
// submission that completes the participant upserts one row for that person. The
// worker drains due rows and deletes each when it is done, so a restart resumes
// whatever was pending. The primary key makes a second end of the same event an
// UPDATE of its row, never a second job.
//
// `certificate_emails` is the PER-CERTIFICATE LEDGER, keyed on the badge token —
// the certificate's identity. A row exists once a send was attempted, so the
// worker never mails one certificate twice whatever re-runs it: a revive and
// re-end re-enqueues the event, finds the row and skips. A NEW certificate (a
// first mint after a revive, or a re-issue after a revoke) has a new token and
// is mailed once. Cascades with the badge, so erasing a participant or deleting
// an event erases the ledger rows too.
db.exec(`
  CREATE TABLE IF NOT EXISTS certificate_dispatch_jobs (
    competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    user_id        TEXT NOT NULL DEFAULT '',
    reason         TEXT NOT NULL,
    due_at         TEXT NOT NULL,
    enqueued_at    TEXT NOT NULL,
    passes         INTEGER NOT NULL DEFAULT 0,
    last_error     TEXT,
    PRIMARY KEY (competition_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_certificate_dispatch_jobs_due ON certificate_dispatch_jobs(due_at);
  CREATE TABLE IF NOT EXISTS certificate_emails (
    badge_token      TEXT PRIMARY KEY REFERENCES achievement_badges(token) ON DELETE CASCADE,
    user_id          TEXT NOT NULL,
    competition_id   TEXT NOT NULL,
    status           TEXT NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    next_attempt_at  TEXT,
    first_attempt_at TEXT NOT NULL,
    sent_at          TEXT,
    updated_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_certificate_emails_comp ON certificate_emails(competition_id);
  CREATE INDEX IF NOT EXISTS idx_certificate_emails_retry ON certificate_emails(status, next_attempt_at);
`);
// `certificate_share_links` — the ONE-TIME, short-lived links the congratulations
// email carries to the LinkedIn share page (lib/certificate-share.js). Only a
// sha256 of the link is stored; it cascades with its certificate, so a revoke or
// an erasure kills the link. The daily retention pass deletes a link 30 days
// after it expired (sweep #347), oldest first through the `expires_at` index.
db.exec(`
  CREATE TABLE IF NOT EXISTS certificate_share_links (
    id_hash     TEXT PRIMARY KEY,
    badge_token TEXT NOT NULL REFERENCES achievement_badges(token) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_certificate_share_links_badge ON certificate_share_links(badge_token);
  CREATE INDEX IF NOT EXISTS idx_certificate_share_links_expires ON certificate_share_links(expires_at);
`);
// THE APPROVAL QUEUE SURVIVES AN UPGRADE FROM 8.14 (operator ruling, 15 Nov 2026).
// 8.14 and earlier held every plain sign-up for an administrator's approval;
// since 9.1.1 an emailed code approves the account unless a superadmin turns on
// Require admin approval for new accounts, which a database from 8.14 has never
// stored, so it read as off: anyone waiting got in with their next code. A
// database coming straight from 8.14 or earlier (no certificate floor yet, which
// every 9.1.1+ boot stamps below, and accounts or events already in it) boots with
// the switch ON, recorded as a settings event by `system`; a superadmin can turn
// it off. A fresh database and one already on 9.1.x keep it as it is (off unless
// a superadmin chose). Decided once (the marker), before the certificate floor.
try {
  if (!db.prepare("SELECT 1 FROM settings WHERE key='approval_gate_upgrade_checked_at'").get()) {
    db.transaction(() => {
      const at = new Date().toISOString();
      const from814 = !db.prepare("SELECT 1 FROM settings WHERE key='certificate_dispatch_floor_at'").get()
        && !!(db.prepare("SELECT 1 FROM users LIMIT 1").get() || db.prepare("SELECT 1 FROM competitions LIMIT 1").get());
      if (from814 && !db.prepare("SELECT 1 FROM settings WHERE key='require_account_approval'").get()) {
        db.prepare("INSERT INTO settings (key, value) VALUES ('require_account_approval', '1')").run();
        db.prepare("INSERT INTO settings_events (id, setting_key, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)")
          .run(crypto.randomUUID(), "require_account_approval", "updated", "system", at,
            JSON.stringify({ from: false, to: true, via: "upgrade_from_8_14" }));
      }
      db.prepare("INSERT INTO settings (key, value) VALUES ('approval_gate_upgrade_checked_at', ?) ON CONFLICT(key) DO NOTHING").run(at);
    })();
  }
} catch (e) {
  console.error("[migration] could not keep the approval queue across the upgrade:", e.message);
}
// THE LATE-ENTRY RULE'S FLOOR, stamped once: the moment this installation took
// the current late-entry rule (a late entrant joined strictly after the end; the
// operator re-decided it on 29 Oct 2026, removing a ten-minute pre-window). An
// event that ended before it keeps the old rule when its board is read
// (lib/late-entry.js `lateEntryJoinCutoff`), so an upgrade never rewrites a final
// board. Decided BEFORE this boot stamps the certificate floor below:
//   • the certificate floor exists — an installation already on 9.1.1+, where
//     both arrived in one release (on the branch, the same day): take it;
//   • no certificate floor, and events exist — a database coming straight from
//     8.14 or earlier, booting the current rule now: take now;
//   • neither — a fresh database, where no event ever ended under the old rule:
//     the epoch, so none ever uses it.
try {
  const _certFloor = db.prepare("SELECT value FROM settings WHERE key='certificate_dispatch_floor_at'").get();
  const _anyEvent = db.prepare("SELECT 1 FROM competitions LIMIT 1").get();
  const _floor = _certFloor ? _certFloor.value : (_anyEvent ? new Date().toISOString() : new Date(0).toISOString());
  db.prepare("INSERT INTO settings(key,value) VALUES('late_entry_rule_floor_at', ?) ON CONFLICT(key) DO NOTHING").run(_floor);
} catch (e) {
  console.error("[migration] could not stamp late_entry_rule_floor_at:", e.message);
}
try {
  require("./lib/late-entry").setLateEntryRuleFloor(db.prepare("SELECT value FROM settings WHERE key='late_entry_rule_floor_at'").get()?.value || null);
} catch (e) {
  console.error("[migration] could not read late_entry_rule_floor_at:", e.message);
}
// The GRANDFATHER FLOOR, stamped once (the `badge_page_share_gate_at` shape): an
// event whose effective end precedes the first boot of this release is never
// dispatched, so upgrading does not mail every participant of every finished event.
try {
  db.prepare("INSERT INTO settings(key,value) VALUES('certificate_dispatch_floor_at', ?) ON CONFLICT(key) DO NOTHING")
    .run(new Date().toISOString());
} catch (e) {
  console.error("[migration] could not stamp certificate_dispatch_floor_at:", e.message);
}

// EVENT TEAM + PERSONA REPORTS (lib/event-team.js, lib/team-reports.js). Base
// CREATEs, fatal like every base table.
//
// `event_team_members` — the people an event's reports go to, per role (several
//   per role). Recipients, NOT accounts: name + address, no platform login. The
//   address must be on the superadmin's allowed-domain list
//   (`settings.team_report_allowed_domains`), checked at add AND at send.
// `event_team_settings` — the optional lead and hot-lead targets per event.
// `event_leads` — per (event, person): the stable SDR owner (round-robin, so a
//   late update keeps the split), when the person was first reported (the late
//   delta mails only rows never reported), and the "contacted" mark set from the
//   admin app (SDRs have no login). Cascades with the event and the person.
// `team_report_jobs` — the DURABLE QUEUE (the certificate-dispatch shape): one row
//   per (event, kind); `end_key` names the end instance the job is for.
// `team_report_sends` — the per-recipient LEDGER, keyed on (event, kind,
//   end_key, address) and written `sending` BEFORE the send, so no re-run mails a
//   report twice and a crash-cut send becomes `unknown`, never retried.
db.exec(`
  CREATE TABLE IF NOT EXISTS event_team_members (
    id             TEXT PRIMARY KEY,
    competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    role           TEXT NOT NULL CHECK(role IN ('se','marketing','sales','sdr','se_manager','marketing_manager','sales_manager')),
    name           TEXT NOT NULL,
    email          TEXT NOT NULL COLLATE NOCASE,
    added_by       TEXT,
    added_at       TEXT NOT NULL,
    UNIQUE (competition_id, role, email)
  );
  CREATE INDEX IF NOT EXISTS idx_event_team_members_comp ON event_team_members(competition_id);
  CREATE TABLE IF NOT EXISTS event_team_settings (
    competition_id  TEXT PRIMARY KEY REFERENCES competitions(id) ON DELETE CASCADE,
    lead_target     INTEGER,
    hot_lead_target INTEGER,
    updated_at      TEXT
  );
  CREATE TABLE IF NOT EXISTS event_leads (
    competition_id    TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_member_id   TEXT,
    first_reported_at TEXT,
    contacted_at      TEXT,
    contacted_by      TEXT,
    PRIMARY KEY (competition_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS team_report_jobs (
    competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL,
    end_key        TEXT NOT NULL,
    due_at         TEXT NOT NULL,
    enqueued_at    TEXT NOT NULL,
    passes         INTEGER NOT NULL DEFAULT 0,
    last_error     TEXT,
    PRIMARY KEY (competition_id, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_team_report_jobs_due ON team_report_jobs(due_at);
  CREATE TABLE IF NOT EXISTS team_report_sends (
    competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL,
    end_key        TEXT NOT NULL,
    recipient      TEXT NOT NULL COLLATE NOCASE,
    persona        TEXT NOT NULL,
    status         TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    sent_at        TEXT,
    PRIMARY KEY (competition_id, kind, end_key, recipient, persona)
  );
  CREATE TABLE IF NOT EXISTS team_report_runs (
    competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    kind           TEXT NOT NULL,
    end_key        TEXT NOT NULL,
    ran_at         TEXT NOT NULL,
    PRIMARY KEY (competition_id, kind, end_key)
  );
`);

// One shot: an address that holds no role on an event's team has left that
// event's send ledger, its rows named by the removed form instead (sweep #149;
// operator ruling, 24 Nov 2026: the `tm_` fingerprint and the domain the mail's
// own record carries, never the address). The member DELETE does it from then
// on (lib/team-reports.js `forgetRemovedRecipient`); this rewrites the rows a
// member removed by an older release left under the address, which the Team
// section's recent reports would otherwise still show. Matched as that DELETE
// matches: no member row with the address on the same event (both columns
// NOCASE), so a member still on the team, or on another event's, keeps theirs.
// The form comes from lib/team-recipient.js, which the live paths use too, so
// the address added back takes these rows back (`restoreRemovedRecipient`).
// OR IGNORE: a row whose removed form the ledger already holds under the same
// key stays as it is rather than failing the boot. NON-FATAL, like every data
// repair here; the marker is written with the rewrite, even when nothing
// changed, so a failure retries on the next boot.
try {
  const done = db.prepare("SELECT value FROM settings WHERE key='team_report_removed_recipients_at'").get();
  if (!done) {
    const { removedRecipient, isRemovedRecipient } = require("./lib/team-recipient");
    const stale = db.prepare(
      "SELECT DISTINCT s.competition_id, s.recipient FROM team_report_sends s " +
      "WHERE NOT EXISTS (SELECT 1 FROM event_team_members m WHERE m.competition_id = s.competition_id AND m.email = s.recipient)"
    );
    const rename = db.prepare("UPDATE OR IGNORE team_report_sends SET recipient=? WHERE competition_id=? AND recipient=?");
    let rewritten = 0;
    db.transaction(() => {
      for (const r of stale.all()) {
        if (isRemovedRecipient(r.recipient)) continue;
        rewritten += rename.run(removedRecipient(r.recipient), r.competition_id, r.recipient).changes;
      }
      db.prepare("INSERT INTO settings (key, value) VALUES ('team_report_removed_recipients_at', ?) ON CONFLICT(key) DO NOTHING")
        .run(new Date().toISOString());
    }).immediate();
    if (rewritten) {
      console.log(`[migration] team report ledger: ${rewritten} ${rewritten === 1 ? "row" : "rows"} of members no longer on their event's team now name the address's domain and fingerprint only`);
    }
  }
} catch (e) {
  console.error("[migration] could not rewrite removed team members' report ledger rows (retrying next boot):", e.message);
}

// The three BUILT-IN templates, seeded ONCE behind a settings marker (the
// `linkedin_signup_default_off_at` shape): armed in the same transaction as the
// rows, so an operator who deletes or renames a built-in template does not get
// it back at the next boot. They carry NO challenges, deliberately: no challenges
// are seeded on a fresh platform, and where public-domain challenges exist,
// picking some on the operator's behalf would be a choice nobody made — an
// organiser adds challenges after spawning. The settings name only what differs
// from the kind's own create defaults (a Booth Event already opens self-enrolment,
// and the phone tap layout for multiple-choice challenges is kind policy, not a
// setting). Non-fatal: a failure leaves the platform without
// built-in templates — a missing convenience — and is retried at the next boot.
try {
  const seeded = db.prepare("SELECT value FROM settings WHERE key='event_templates_seeded_at'").get();
  if (!seeded) {
    const at = new Date().toISOString();
    const ins = db.prepare(
      "INSERT OR IGNORE INTO event_templates (id, name, description, event_kind, settings, task_ids, created_by_id, created_at, updated_at, is_builtin, builtin_key) " +
      "VALUES (?,?,?,?,?,'[]',NULL,?,?,1,?)"
    );
    const { BUILTIN_TEMPLATES } = require("./lib/event-template-builtins");
    db.transaction(() => {
      for (const b of BUILTIN_TEMPLATES) ins.run(crypto.randomUUID(), b.name, b.description, b.kind, JSON.stringify(b.settings), at, at, b.key);
      db.prepare("INSERT INTO settings (key, value) VALUES ('event_templates_seeded_at', ?) ON CONFLICT(key) DO NOTHING").run(at);
    }).immediate();
  }
} catch (e) {
  console.error("[migration] could not seed the built-in event templates (retrying next boot):", e.message);
}

// ROLES (lib/rbac.js). `users.role` stays the role KEY; the four built-in ids
// are today's strings, so no account row changes. Built-in roles' PERMISSIONS
// are a frozen code constant and never stored — their rows here exist so the
// Users & roles screen lists every role from one table and a custom role's
// label cannot take a built-in one's. Only CUSTOM roles have role_permissions
// rows. Base CREATEs (fatal). The built-in rows are re-asserted every boot with
// INSERT OR IGNORE, so a deleted one comes back and an existing one is left as
// it is. `idx_roles_label` is in REQUIRED_INDEXES (two roles reading the same
// in a list is ambiguous on the role menu).
db.exec(`
  CREATE TABLE IF NOT EXISTS roles (
    id            TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    description   TEXT,
    builtin       INTEGER NOT NULL DEFAULT 0,
    scope_mode    TEXT NOT NULL CHECK (scope_mode IN ('none','granted','all')),
    rank          INTEGER NOT NULL DEFAULT 0,
    created_by_id TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    version       INTEGER NOT NULL DEFAULT 1
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_label ON roles(lower(label));
  CREATE TABLE IF NOT EXISTS role_permissions (
    role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    PRIMARY KEY (role_id, permission)
  );
`);
{
  const { BUILTIN_ROLES } = require("./lib/rbac");
  const at = new Date().toISOString();
  const ins = db.prepare(`INSERT OR IGNORE INTO roles (id, label, description, builtin, scope_mode, rank, created_at, updated_at)
                          VALUES (?, ?, ?, 1, ?, ?, ?, ?)`);
  for (const r of Object.values(BUILTIN_ROLES)) ins.run(r.id, r.label, r.description, r.scope_mode, r.rank, at, at);
}

// The Audit page's indexes (GET /api/admin/audit, routes/audit.js). Its actor
// filter is an equality on `changed_by` paged newest first, so each changed_at
// event table gets a (changed_by, changed_at) index; task_versions also gets the
// timestamp-leading one its unfiltered newest-first walk reads (the other tables
// already carry theirs for the retention purge). Plain, not UNIQUE, so outside
// REQUIRED_INDEXES. HERE, at the end, below every table rebuild in this file:
// none of these tables is rebuilt today, and placing them last keeps a future
// rebuild's DROP TABLE from taking them until the next boot. Non-fatal: a missing
// index is slower, never wrong. A person row names its event inside `details`,
// so the event filter's person arm gets an EXPRESSION index: the expression is
// the route's JX("details", "$.competition_id"), and a query that does not
// repeat it walks every person row by time instead.
try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_user_events_competition ON user_events((CASE WHEN json_valid(details) THEN json_extract(details, '$.competition_id') END), changed_at);
    CREATE INDEX IF NOT EXISTS idx_competition_events_changed_by ON competition_events(changed_by, changed_at);
    CREATE INDEX IF NOT EXISTS idx_timeslot_events_changed_by ON timeslot_events(changed_by, changed_at);
    CREATE INDEX IF NOT EXISTS idx_user_events_changed_by ON user_events(changed_by, changed_at);
    CREATE INDEX IF NOT EXISTS idx_settings_events_changed_by ON settings_events(changed_by, changed_at);
    CREATE INDEX IF NOT EXISTS idx_orphan_events_changed_by ON orphan_events(changed_by, changed_at);
    CREATE INDEX IF NOT EXISTS idx_task_versions_changed_by ON task_versions(changed_by, changed_at);
    CREATE INDEX IF NOT EXISTS idx_task_versions_changed_at ON task_versions(changed_at);
  `);
} catch (e) {
  console.error("[migration] could not create the audit-page indexes (retrying next boot):", e.message);
}

// One shot: a qualifying challenge numbered before qualifying challenges had their
// own level (lib/competitions.js _assignTaskNumbers) gets its number again at the
// next read, so it comes last. The marker is written even when nothing changed.
{
  const done = db.prepare("SELECT value FROM settings WHERE key='qualifying_numbers_moved_at'").get();
  if (!done) {
    db.transaction(() => {
      db.prepare(
        `UPDATE competition_tasks SET task_number=NULL
          WHERE task_number NOT LIKE '4.%'
            AND task_id IN (SELECT task_id FROM task_tags WHERE tag LIKE 'qualifying:%')`
      ).run();
      db.prepare("INSERT INTO settings (key, value) VALUES ('qualifying_numbers_moved_at', ?) ON CONFLICT(key) DO NOTHING").run(new Date().toISOString());
    })();
  }
}

// One shot: four looks were retired (operator ruling, 13 Nov 2026), so a stored
// choice of one moves to the nearest look still offered rather than reading as
// no choice. The platform look (lib/platform-look.js) moves Hyperscreen (night
// only) to Ambient at night and the others to Signature, whether it is stored
// as `platform_look` or still as its legacy `default_look` row: the same result
// either way (operator ruling, 14 Nov 2026). An event look has no mode, so an
// event's Hyperscreen moves to Ambient with no mode and the others to
// Signature. The marker is written even when nothing changed. A browser's own
// stored pick needs nothing: theme-boot.js treats a look it does not offer as
// no choice.
{
  const done = db.prepare("SELECT value FROM settings WHERE key='looks_retired_at'").get();
  if (!done) {
    const RETIRED_LOOKS = { heritage: "signature", command: "signature", checkmarx: "signature", hyperscreen: "ambient" };
    const retired = (v) => typeof v === "string" && Object.prototype.hasOwnProperty.call(RETIRED_LOOKS, v);
    // The ONE move of a platform look, whichever way it was stored: Hyperscreen
    // was night only, so it keeps the night; colour, lock and stamp stay.
    const moveLook = (look) => {
      if (look.look === "hyperscreen") look.mode = "dark";
      look.look = RETIRED_LOOKS[look.look];
      return look;
    };
    db.transaction(() => {
      const row = db.prepare("SELECT value FROM settings WHERE key='platform_look'").get();
      let look = null;
      if (row) {
        try { look = JSON.parse(row.value); } catch (e) { swallowed("db:looks-retired-platform-look", e); }
      }
      if (look && typeof look === "object" && retired(look.look)) {
        db.prepare("UPDATE settings SET value=? WHERE key='platform_look'").run(JSON.stringify(moveLook(look)));
      }
      // The legacy row is a bare look id, read only while no platform look is
      // stored (`getPlatformLook`, the same `!value` test). It holds no mode, so
      // a Hyperscreen one that is still the look in force becomes the platform
      // look the JSON path writes (the shape `setPlatformLook` stores, its other
      // fields empty) and the legacy row is dropped, as that first write drops
      // it. Any other retired id, or a row a stored platform look outranks,
      // moves in place, with no mode.
      const legacy = db.prepare("SELECT value FROM settings WHERE key='default_look'").get();
      if (legacy && retired(legacy.value)) {
        if (legacy.value === "hyperscreen" && !row?.value) {
          db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('platform_look', ?)")
            .run(JSON.stringify(moveLook({ look: legacy.value, mode: "", ambient: "", lock: false, stamp: 0 })));
          db.prepare("DELETE FROM settings WHERE key='default_look'").run();
        } else {
          db.prepare("UPDATE settings SET value=? WHERE key='default_look'").run(RETIRED_LOOKS[legacy.value]);
        }
      }
      const moveEvent = db.prepare("UPDATE competitions SET event_look=? WHERE event_look=?");
      for (const [from, to] of Object.entries(RETIRED_LOOKS)) moveEvent.run(to, from);
      db.prepare("INSERT INTO settings (key, value) VALUES ('looks_retired_at', ?) ON CONFLICT(key) DO NOTHING").run(new Date().toISOString());
    })();
  }
}

// One shot: a PLATFORM-WIDE permission (lib/rbac.js PLATFORM_WIDE_PERMISSIONS)
// is held only by a role of scope `all`. A grant stored on another custom role
// before that rule grants nothing (`_readRoleDef` drops it); this removes the
// rows, so no grant sits stored that nothing honours, and so the role's next
// save cannot remove it unrecorded (its `before` is the honoured set). Each
// role it changes gets a `role_updated` settings event by "system" naming what
// it removed. The marker is written even when nothing changed. Its key names
// the CURRENT set's prune: the set grew in 9.1.5 (every permission whose routes
// reach beyond one event), so a database that ran the first prune
// (`platform_wide_grants_pruned_at`, three permissions) runs this one again.
{
  const done = db.prepare("SELECT value FROM settings WHERE key='every_event_grants_pruned_at'").get();
  if (!done) {
    const wide = JSON.stringify([...require("./lib/rbac").PLATFORM_WIDE_PERMISSIONS]);
    db.transaction(() => {
      const at = new Date().toISOString();
      const rows = db.prepare(
        `SELECT rp.role_id, rp.permission, r.label FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
          WHERE r.builtin = 0 AND r.scope_mode != 'all' AND rp.permission IN (SELECT value FROM json_each(?))
          ORDER BY rp.role_id, rp.permission`
      ).all(wide);
      const byRole = new Map();
      for (const r of rows) {
        if (!byRole.has(r.role_id)) byRole.set(r.role_id, { label: r.label, removed: [] });
        byRole.get(r.role_id).removed.push(r.permission);
      }
      const del = db.prepare("DELETE FROM role_permissions WHERE role_id=? AND permission=?");
      const ev = db.prepare("INSERT INTO settings_events (id, setting_key, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");
      for (const [roleId, { label, removed }] of byRole) {
        for (const p of removed) del.run(roleId, p);
        ev.run(crypto.randomUUID(), `role:${roleId}`, "role_updated", "system", at,
          JSON.stringify({ label, permissions_removed: removed, via: "platform_wide_rule" }));
      }
      db.prepare("INSERT INTO settings (key, value) VALUES ('every_event_grants_pruned_at', ?) ON CONFLICT(key) DO NOTHING").run(at);
    })();
  }
}

// One shot: a NON-GRANTABLE permission (lib/rbac.js `grantable:false`) is held
// only by the built-in roles. A grant stored on a custom role before the
// permission became non-grantable (`ops.cxone`, operator ruling, 14 Nov 2026)
// grants nothing (`_readRoleDef` drops it); this removes the rows, so no grant
// sits stored that nothing honours. Each role it changes gets a `role_updated`
// settings event by "system" naming what it removed. The marker is written even
// when nothing changed; a permission made non-grantable later needs its own.
{
  const done = db.prepare("SELECT value FROM settings WHERE key='ungrantable_grants_pruned_at'").get();
  if (!done) {
    const ungrantable = JSON.stringify(require("./lib/rbac").PERMISSIONS.filter(p => !p.grantable).map(p => p.id));
    db.transaction(() => {
      const at = new Date().toISOString();
      const rows = db.prepare(
        `SELECT rp.role_id, rp.permission, r.label FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
          WHERE r.builtin = 0 AND rp.permission IN (SELECT value FROM json_each(?))
          ORDER BY rp.role_id, rp.permission`
      ).all(ungrantable);
      const byRole = new Map();
      for (const r of rows) {
        if (!byRole.has(r.role_id)) byRole.set(r.role_id, { label: r.label, removed: [] });
        byRole.get(r.role_id).removed.push(r.permission);
      }
      const del = db.prepare("DELETE FROM role_permissions WHERE role_id=? AND permission=?");
      const ev = db.prepare("INSERT INTO settings_events (id, setting_key, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");
      for (const [roleId, { label, removed }] of byRole) {
        for (const p of removed) del.run(roleId, p);
        ev.run(crypto.randomUUID(), `role:${roleId}`, "role_updated", "system", at,
          JSON.stringify({ label, permissions_removed: removed, via: "superadmin_only_rule" }));
      }
      db.prepare("INSERT INTO settings (key, value) VALUES ('ungrantable_grants_pruned_at', ?) ON CONFLICT(key) DO NOTHING").run(at);
    })();
  }
}

// A QUESTION ADDED TO AN EVENT LIVES IN THAT EVENT (lib/event-copies.js).
// `owner_competition_id`: the event owning this question (NULL = a bank
// question). `copied_from_task_id`: the bank question it was copied from (NULL
// for one created in its event). No foreign keys on purpose: a cascade would
// erase the origin exactly when "copied from" must still be shown, and an event
// deleted leaves its questions as rows nothing assigns. OUTSIDE try/catch: every
// assign door writes both columns, so a swallowed ADD would fail each write.
// Below every `tasks` rebuild, so neither the ALTERs nor the indexes are taken
// by a DROP TABLE.
{
  const _cols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
  if (!_cols.includes("owner_competition_id")) db.exec("ALTER TABLE tasks ADD COLUMN owner_competition_id TEXT");
  if (!_cols.includes("copied_from_task_id")) db.exec("ALTER TABLE tasks ADD COLUMN copied_from_task_id TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_owner_origin ON tasks(owner_competition_id, copied_from_task_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_copied_from ON tasks(copied_from_task_id)");
}
// One shot (owner decision, ended events included): every event gets its own
// copy of every bank question it holds, and the event's answers, hints, grants,
// analytics and assignment move to the copy (lib/event-copies.js says which
// table goes where). One transaction per event, so an interrupted boot resumes
// where it stopped; the marker is written once every event is done, even when
// there was nothing to do. Preview it read-only first with
// scripts/event-copies-dry-run.js.
{
  const done = db.prepare("SELECT value FROM settings WHERE key='event_owned_questions_migrated_at'").get();
  if (!done) {
    const at = new Date().toISOString();
    const rep = require("./lib/event-copies").migrateSharedTasksToEventCopies(db, { nowIso: at });
    db.prepare("INSERT INTO settings (key, value) VALUES ('event_owned_questions_migrated_at', ?) ON CONFLICT(key) DO NOTHING").run(at);
    if (rep.questions) {
      db.prepare("INSERT INTO settings_events (id, setting_key, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)")
        .run(crypto.randomUUID(), "event_owned_questions", "updated", "system", at,
          JSON.stringify({ via: "migration", events: rep.events.length, questions: rep.questions, rows_moved: rep.rows }));
      console.log(`[migration] event-owned questions: ${rep.questions} question(s) copied into ${rep.events.length} event(s)`);
    }
  }
}

// ── Prepared-statement memo (installed AFTER every migration above) ──────────
//
// Request code calls `db.prepare(sql)` inline, so the same SQL text was compiled
// by SQLite on every request: measured in the sign-in storm
// (perf/RESULTS.md), `prepare` was the single largest self-time entry on the
// main thread — 19 % of everything the process did while saturated. A Statement
// is reusable for as long as the connection lives (SQLite re-prepares it itself
// after a schema change), so the same text is now compiled once.
//
// What makes reuse safe, and what this guards:
//   • a Statement carries MODES (pluck/raw/expand/safeIntegers) that a caller
//     could set and the next caller would inherit — reader statements are reset
//     to the defaults on every hand-out (no app code sets a mode today; this
//     keeps one later caller from silently changing another's row shape);
//   • a Statement mid-`.iterate()` is `busy` and cannot be re-entered — a busy
//     one is never handed out, the caller gets a fresh, uncached compile;
//   • dynamically built SQL (IN lists of varying length) would grow the map
//     without bound — it is capped, oldest-first eviction.
// Tests that replace `db.prepare` (to count or fail calls) wrap THIS function,
// so they keep working unchanged.
{
  const _rawPrepare = db.prepare.bind(db);
  const _PREPARE_CACHE_MAX = 2000;
  const _stmtCache = new Map();
  db.prepare = function prepareMemo(sql) {
    if (typeof sql !== "string") return _rawPrepare(sql);
    const hit = _stmtCache.get(sql);
    if (hit && !hit.busy) {
      if (hit.reader) { hit.raw(false); hit.pluck(false); hit.expand(false); }
      hit.safeIntegers(false);
      return hit;
    }
    const stmt = _rawPrepare(sql);
    if (!hit) {
      if (_stmtCache.size >= _PREPARE_CACHE_MAX) _stmtCache.delete(_stmtCache.keys().next().value);
      _stmtCache.set(sql, stmt);
    }
    return stmt;
  };
  db._preparedStatementCacheSize = () => _stmtCache.size;
}

module.exports = db;
