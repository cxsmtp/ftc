"use strict";

const express      = require("express");
const compression  = require("compression");
const session      = require("express-session");
const SQLiteStore  = require("express-session-better-sqlite3")(session, require("./db"));
const path         = require("path");
const fs           = require("fs");
const { v4: uuid } = require("uuid");
const { boundedMulter, declaredLengthGate } = require("./lib/multipart");
const crypto       = require("crypto");
const yauzl        = require("yauzl");
const db           = require("./db");
// v7.0.0 refactor — foundational env config extracted to lib/config.js (imported
// with the same names). The FATAL BASE_URL check + the per-process SESSION_SECRET
// generation now run there, once, at require time. bcrypt cost stays 10 (native
// bcrypt@6 on the libuv threadpool; legacy hashes re-hashed on login).
const { PLATFORM_VERSION, BASE_URL, SESSION_SECRET, DATA_DIR, PERF_SPAN_SLOW_MS } = require("./lib/config"); // UPLOADS_DIR comes via lib/http below (same config value, re-exported)
// formatEmailDate now lives in lib/time.js (imported alongside now() below).

// ═══════════════════════════════════════════════════════════════════════════
//   SERVER LOG — JSONL files under DATA_DIR/logs, disk-space driven retention.
//   Two streams:
//     • access-YYYY-MM-DD.jsonl  — one line per HTTP request
//     • app-YYYY-MM-DD.jsonl     — info/warn/error/debug application events
//   Configuration via env vars:
//     LOG_LEVEL (debug|info|warn|error; default info)
//     LOG_DIR   (default DATA_DIR/logs)
//     LOG_MIN_FREE_MB  (default 500; trigger cleanup below this free-space threshold)
//     LOG_MIN_FREE_PCT (default 5;   or below this percentage of volume — whichever is larger)
//     LOG_DISABLE_ACCESS (true disables HTTP access logging; default false)
//     LOG_CONSOLE_MIRROR (default true in non-prod, false in prod — also mirror to stdout)
// ═══════════════════════════════════════════════════════════════════════════
const { log, logAccess, sanitiseForLog, LOG_DIR, LOG_DISABLE_ACCESS, LOG_LEVELS, _freeSpaceBytes, logWriteFailureCount } = require("./lib/log"); // v7.0.0: logging/redaction/retention extracted to lib/log.js
const { swallowed, unrecordedSwallowCount } = require("./lib/best-effort");
// Crash-safety: capture unhandled errors so they appear in logs instead of vanishing.
process.on("unhandledRejection", (err) => {
  log.error({ err: err && err.stack ? err.stack : String(err) }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  log.error({ err: err && err.stack ? err.stack : String(err) }, "Uncaught exception");
  // v6.16.6 — drain via gracefulShutdown instead of a bare 100-ms
  // timeout-then-exit. Pre-fix the in-flight HTTP requests got TCP
  // RSTs (no _httpServer.close()), the deferred audit writes were
  // dropped (no db.close() ordering), and SQLite's WAL was left in
  // checkpointed state if a checkpoint was running — the boot-time
  // PRAGMA integrity_check on next start would catch DB corruption,
  // but the audit chain still had a gap. Routing through
  // gracefulShutdown reuses the v6.8.5 drain (in-flight requests +
  // 5 s deferred-audit drain + db.close()) with the same 20 s
  // overall watchdog. Function is a no-op if shutdown is already
  // in progress, so a cascade of uncaught errors during shutdown
  // doesn't loop.
  try { gracefulShutdown("uncaughtException", 1); }
  catch (_) {
    // If gracefulShutdown itself throws, fall back to the original
    // behaviour: best-effort log flush then exit.
    setTimeout(() => process.exit(1), 100);
  }
});

// In-memory set of every superadmin password active in THIS process (initial +
// rotations). Used as a defence-in-depth fallback in redactLogEntryForRegularAdmin
// to scrub the password string from any log entry that happens to reference it
// outside the known banner format. Not persisted: the banner pattern itself is
// handled by a stateless regex below so post-restart redaction doesn't depend
// on remembering prior sessions' secrets on disk.
const _superadminPasswordHistory = new Set();
function generateSuperadminPassword() {
  const p = crypto.randomBytes(16).toString("base64url");
  _superadminPasswordHistory.add(p);
  return p;
}
let SUPERADMIN_PASS = generateSuperadminPassword();
function writeSuperadminPassword() {
  try { fs.writeFileSync(path.join(DATA_DIR, ".superadmin-password"), SUPERADMIN_PASS, { mode: 0o600 }); } catch (e) { console.error("Failed to write superadmin password file:", e.message); }
}
// ext-audit v7.20.9 (F7) — the FIRST write is deferred until this process has
// proven it owns the port. It used to happen right here, at module scope.
//
// Every fatal boot path exits downstream of this point: the EADDRINUSE
// pre-check, the cluster refusal, and the https/TRUST_PROXY FATAL. So a second
// `npm start` against a data directory a live server already owns generated a
// NEW password, overwrote DATA_DIR/.superadmin-password with it, and then
// exited — leaving the RUNNING server expecting a credential that no longer
// exists anywhere on disk. Under SUPERADMIN_PASSWORD_QUIET=1 (the documented
// production setting, so the plaintext never reaches a log shipper) that file is
// the ONLY copy, so one mistyped command locks the operator out of their own
// live event, silently, with the misleading message "Port N is already in use".
//
// It is now written from the portCheck 'listening' handler — see the call site
// beside app.listen. That is still strictly BEFORE the socket accepts, so a
// test that polls raw TCP and then reads the file cannot race it, which is what
// the original early write was protecting against.
// SUPERADMIN_PASSWORD_QUIET=1 suppresses the stdout banner so container log
// shippers (Docker / journald / Loki) don't permanently archive the plaintext
// password. The file at DATA_DIR/.superadmin-password (mode 0o600) remains the
// authoritative source either way.
const _SUPERADMIN_QUIET = ["1","true","yes"].includes(String(process.env.SUPERADMIN_PASSWORD_QUIET||"").trim().toLowerCase());
function logSuperadminPassword() {
  writeSuperadminPassword();
  if (_SUPERADMIN_QUIET) {
    console.log("Superadmin password rotated (SUPERADMIN_PASSWORD_QUIET=1) — see DATA_DIR/.superadmin-password");
    return;
  }
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Superadmin password: ${SUPERADMIN_PASS}`);
  console.log("  Sign in on the sign-in page with the break-glass username (default: superadmin)");
  console.log("═══════════════════════════════════════════════════");
}
const { cleanupUpload, UPLOADS_DIR } = require("./lib/http"); // upload cleanup; lib/http also owns the outbound fetch deadline (CxOne)
const { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_PER_TASK, ATTACHMENT_FREE_DISK_MIN_BYTES, validateUnencryptedZip, _attachmentValidationMessage } = require("./lib/attachments"); // v7.0.0: attachment validation + budget helpers extracted

// isFreeEmail / isValidEmailFormat (+ _EMAIL_RE) / sameSlotEmails + the
// FREE_EMAIL_PROVIDERS list now live in lib/util.js (imported at the top of
// this file). getUserEmails lives in lib/email.js. The client ships the same
// _EMAIL_RE literal (public/js/features/auth.js); a CI test keeps the two in sync.

// v6.16.22 — NFC normalisation closes a Unicode-equivalence bypass on
// the duplicate-email gate. Pre-fix, two registrations with visually-
// identical emails but different byte sequences (e.g. `é` as U+00E9 vs
// `e + combining acute U+0065 U+0301`) would both pass the
// `LOWER(email)=LOWER(?)` comparison because SQLite's LOWER is byte-
// preserving on non-ASCII. NFC normalisation collapses both forms to
// the same canonical sequence; combined with `toLowerCase()` it gives
// SQLite-LOWER-comparable bytes that match across encoding variants.
//
// Applied at the registration / email-change write sites (so new rows
// store the normalised form) AND at every comparison site (so input
// queries match the stored normalised form). Existing rows that
// pre-date this fix are NOT migrated — they were stored with whatever
// the prior `.toLowerCase()` produced, and the practical impact for
// English-only deployments is negligible. Any future Unicode-input
// bypass attempt against the new write path is rejected at INSERT.
// normaliseEmail / validateUrl / _b64url / _b64urlDecode now live in lib/util.js
// (imported at the top of this file). The comment block above documents the
// NFC-normalisation rationale that lib/util.js's normaliseEmail implements.

// Symmetric email-uniqueness check: an address can never collide with *any* other
// user's email OR secondary_email, regardless of which slot the caller is checking.
// Previously primary-vs-primary and secondary-vs-both checks were asymmetric, which
// let the same address be stored as A.email and B.secondary_email — a lookup
// matching either column would then resolve to whichever row SQLite returned
// first. Keeping the check symmetric closes that ambiguity.
// emailIsTaken now lives in lib/email-identity.js (imported at the top of this file).

// ── Platform name ─────────────────────────────────────────────
// v7.29.0 - this was a SECOND, boot-time COALESCE chain over the same three
// sources as lib/settings.getPlatformName(), read once at require time and used
// only by the startup banner. A shared value with two fallback ladders is not
// shared (v7.21.31), so the ladder is deleted and the banner asks the owner.

// ── Competition & timeslot helpers ──────────────────────────────────────────
// Competition-metadata cache (v6.3.0). getCompetition() is called in every
// requireCompetitionContext gate + leaderboard build + event-recording mirror
// — a hot path under live load. The row itself rarely changes (an admin edit
// is a handful of actions over the life of the event), so a small 2-second
// TTL trades a negligible staleness window for dropping the repeated
// prepared-statement execute + row fetch on the worst-case poll cadence.
// The cache is invalidated explicitly by the edit / delete / end-now /
// revive endpoints (see _invalidateCompetitionCache below).
const { scheduledEnd, getCompetition, _invalidateCompetitionCache, getTimeslot, hasTimeslots, timeslotStatus, competitionStatus, competitionEffectiveEnd, competitionFullyEnded, lateEntryWindowOpen, _competitionCacheSize, taskFrozenByEndedCompetition, _invalidateTaskNumbersCache, publishedTaskCount, scoringParticipantIds, DRY_RUN_TAG } = require("./lib/competitions"); // v7.0.0: competition/session helpers + per-competition row cache + task numbering

// ── Task numbering: assign N.MM codes when competition first goes live ──────
// Pre-v6.0.5 behaviour skipped numbering entirely once ANY task in the comp
// had a number. That meant a task added to a live competition AFTER the
// initial numbering pass would never get a number — participants saw it as
// "(unnumbered)" alongside the numbered ones. Now: initialise per-difficulty
// counters from the MAX existing number in each difficulty bucket, and
// assign numbers only to rows currently NULL. Existing numbers are sticky
// (never renumbered) so the assignment is stable across additions.
// The per-competition task-numbering cluster (_assignTaskNumbers,
// ensureTaskNumbers, _invalidateTaskNumbersCache + the _taskNumbersAssignedCache
// Set) now lives in lib/competitions.js (imported at the top of this file) —
// it already owns competitionStatus, so the move is cycle-free.

// requireCompetitionContext + requireParticipantInCompetition now live in
// lib/middleware.js (imported at the top of this file), alongside the rate
// limiter, CSRF, and the auth guards.


// ── CheckmarxOne integration ─────────────────────────────────────────────────
// v6.8.5: tightened SSRF guard. Previously accepted any https? URL embedded
// in the JWT's `iss` claim — an operator pasting a hostile/malformed JWT
// could redirect the token-exchange + API calls at arbitrary hosts. Now:
//   - protocol MUST be https (http:// is rejected so refresh tokens never
//     cross the wire in plaintext)
//   - hostname MUST match one of the Checkmarx upstreams (iam.checkmarx.net,
//     iam.checkmarx.com, deu.iam.checkmarx.net, etc. — any third-level
//     `iam.` subdomain of `checkmarx.net` / `checkmarx.com`).
// Anything else decodes to null and the operator gets a "CxOne API key
// invalid" error at save-time instead of silently pointing the SSRF.
const { cxOneInflight, cxOneQueueDepth, cxOneQueueDropped, cxOneCreateUnconfirmedCounts, stopCxOneProvisionRetries, startCxOneProvisionResume, cxOneProvisionRetriesPending, cxOneProvisionDeferredCounts } = require("./lib/cxone"); // v7.0.0: CxOne provisioning extracted
// v8.12.7 — the runner that withdraws realm accounts created for since-deleted
// participants (lib/cxone-withdraw.js), started in the listen callback below.
const { startCxOneWithdrawalSweeper, stopCxOneWithdrawalSweeper, cxOneWithdrawalsBusy, cxOneWithdrawalTotals, cxOneWithdrawalCounts, listCxOneWithdrawals, cxOneWithdrawalPastRetentionCount } = require("./lib/cxone-withdraw");

// v7.0.0 refactor — scoring primitives extracted to lib/scoring.js (POINTS,
// PENALTY, the difficulty/answer-type enum allowlists, jsonExactMatch). Imported
// with the same names so every call site below is unchanged.
const { POINTS, PENALTY, HINT_DEDUCTION_RATE, VALID_DIFFICULTIES, VALID_ANSWER_TYPES, jsonExactMatch, taskGradingHash, answerTypeHasKey, canonicaliseTextAnswers, gradeTextAnswer, normaliseTextAnswer } = require("./lib/scoring");
// v8.3.17 — the challenge import clamps to the SAME per-field caps the create/PUT
// path enforces; it previously enforced none of them.
const { clampTaskField } = require("./lib/task-fields");
const { parseChoices, parseCorrectIds, parseSubmittedIds, gradeChoice, describeSelection, storedChoiceRowError, isSurveyTask, storedSurveyRowError } = require("./lib/choices");
const { isQualifyingTask, notQualifyingSql, qualifyingSql, qualifyingAnsweredAll, qualifyingKeysFromTags, qualifyingKeyHeldDenied, answeredOptionsChangeDenied, qualifyingOptionsFixed, qualifyingNeedsPickOneDenied, tagsMakeQualifying, malformedQualifyingTags } = require("./lib/qualifying"); // event team reports
const { rescoreAfterQualifyingFlip } = require("./lib/qualifying-rescore"); // sweep #91: the import's overwrite is a tag door too
// v7.19.0 — import a task's multiple-choice options. Stored verbatim when it
// parses to a well-formed list (IDs must survive, because correct_answer
// references them); anything malformed becomes NULL rather than a half-built
// question that renders with no options.
function _importChoices(t) {
  // Event team reports — an `any` row may carry options (a pick-one question).
  if (t.answer_type !== "choice" && t.answer_type !== "any") return null;
  const parsed = parseChoices(t.choices);
  return parsed.length ? JSON.stringify(parsed) : null;
}
// v7.19.0 — is an incoming choice row actually IMPORTABLE?
//
// Returning null from _importChoices would otherwise create a `choice` task
// with no options: an unanswerable question, created silently, with both
// columns still well-formed so nothing downstream complains. The import already
// skips rows whose difficulty/answer_type are not valid enums, so a choice row
// that cannot produce a working question is skipped the same way — a bad row
// must not sink the whole import, but nor may it land broken.
//
// The correct ids must also NAME REAL OPTIONS. A hand-edited export can carry a
// correct_answer referencing an id that no longer exists, which produces a
// question that cannot be answered correctly by anyone.
// ext-audit v7.20.9 (F10) — delegates to the ONE canonical predicate. The hand-
// rolled subset that used to live here checked only "≥2 options, ≥1 correct, not
// all correct, correct ids exist", so duplicate ids, duplicate option text and
// non-canonical ids all imported cleanly. See lib/choices.js for what each of
// those actually breaks.
function _importChoiceRowOk(t) {
  if (t.answer_type !== "choice") return true;
  return storedChoiceRowError(t.choices, t.correct_answer) === null;
}
// v8.9.0 — an `any` row carrying a hint is skipped the same way, and for the
// same reason: the create/edit routes REFUSE a hint on an any-answer challenge
// (every non-empty answer is accepted, so a hint has nothing to point at), and
// importing one would land a row those routes can never produce. A file whose
// hint is merely empty markup (`<p></p>`, a lone `&nbsp;`) is fine.
function _importAnyRowOk(t) {
  if ((t.answer_type || "text") !== "any") return true;
  // Event team reports — its options, when it carries any, must form a valid
  // pick-one question (ids kept verbatim, so a bad set is skipped, not repaired).
  if (t.choices != null && t.choices !== "" && storedSurveyRowError(t.choices) !== null) return false;
  return !richTextHasContent(t.hint);
}
// A challenge-import row the transaction skips (counted in `skipped`) whatever its
// resolution, before it reads any live state: no title, difficulty or key; an
// unknown difficulty or answer type; a choice, any-answer or text row it cannot
// store. ONE definition: the transaction's skip, the rich-text pass ahead of it
// (which sanitises only rows the transaction may write) and the count of the
// file's rows overwriting each title (sweep #413: a row that can never overwrite
// anything must not make another row look ambiguous) all ask it.
function _importRowUnusable(t) {
  const type = t.answer_type || "text";
  if (typeof t.title !== "string" || !t.title.trim() || !t.difficulty || (answerTypeHasKey(type) && !t.correct_answer)) return true;   // v8.3.20 — trim; v8.9.0 — `any` has no key
  // v6.20.x — a difficulty/answer_type outside the enums would later break
  // scoring (POINTS[bad] → undefined → submit-txn throw), as the create/update
  // enum guards say.
  if (!VALID_DIFFICULTIES.has(t.difficulty) || (t.answer_type != null && !VALID_ANSWER_TYPES.has(t.answer_type))) return true;
  if (!_importChoiceRowOk(t)) return true;
  if (!_importAnyRowOk(t)) return true;   // v8.9.0 — an any-answer row may not carry a hint
  // v8.9.0 — a text row whose accepted-answer list holds no usable line (only
  // blanks) would store "", which the create/edit routes refuse.
  if (type === "text" && !canonicaliseTextAnswers(t.correct_answer)) return true;
  return false;
}
// The stored column is a JSON STRING, but a hand-authored import file may carry
// a real array. better-sqlite3 refuses a non-primitive bind, so passing that
// through raw would throw and roll back the whole import. Canonicalise for
// `choice`; every other answer type keeps its verbatim string. Ids are
// preserved exactly — this only re-serialises the list.
function _importCorrectAnswer(t) {
  const type = t.answer_type || "text";   // the INSERT defaults an absent type to text
  if (type === "choice") return JSON.stringify(parseCorrectIds(t.correct_answer));
  // v8.9.0 — `any` has no key (the NOT NULL column holds ""); a `text` list is
  // canonicalised exactly as the create/edit routes do it, so an exported row
  // round-trips to the same bytes the platform would have written itself.
  if (type === "any") return "";
  if (type === "text") return canonicaliseTextAnswers(t.correct_answer);
  return t.correct_answer;
}

// ext-audit v7.21.1 — every import row must be a PLAIN OBJECT before anything
// dereferences it.
//
// `null`, a string, a number or a nested array in the rows array reached
// `t.title` / `p.email` and either threw (500) or was bound straight into SQL.
// These are superadmin-only endpoints, but a 500 tells the operator nothing
// about which row of their file is wrong.
//
// This REFUSES the batch rather than skipping the row, which is the opposite of
// the documented "a bad row must not sink the import" posture — deliberately.
// That posture covers rows that are well-TYPED but semantically unimportable (a
// bad enum, an unanswerable choice row): the file is fine, one row cannot be
// used. A wrong-TYPED element means the FILE is malformed, and these handlers
// already 400 the whole batch for a malformed email, an in-batch duplicate and a
// bad attachment. It also has to hold for a second reason: the guard runs before
// the DRY RUN returns, and a dry run has no `skipped` channel — silently
// dropping a row there would make the conflict indices the resolution UI sends
// back disagree with the real import's.
//
// v8.3.20 (external audit) — THE ROW SHAPE WAS CHECKED AND THE FIELD SHAPES WERE
// NOT, so a wrong-typed FIELD reached the same binds a wrong-typed ROW used to.
//
// Measured against a real server: `title: {a:1}` and `title: true` both produce
// the opaque 500 this guard exists to replace ("An internal error occurred"),
// naming no row; `correct_answer: {}` and `active: {}` sink the whole batch the
// same way. The worst is NOT a crash — better-sqlite3 spreads an ARRAY as
// POSITIONAL bindings, so `title: ["x"]` is accepted, matches a conflict against
// a title the file never named, and STORES `x`. A silently wrong title is worse
// than a refusal.
//
// Same posture and the same two reasons as the row check above: a wrong-TYPED
// field means the FILE is malformed, and the check must run before the dry run
// returns or the conflict indices the resolution UI sends back would disagree
// with the real import's.
//
// `fields` is a per-caller table of {name, kind}. Only shapes that would reach a
// bind or a string method are policed — a semantically unusable but well-typed
// value (a bad enum, an out-of-range cap) is still SKIPPED per the standing
// "a bad row must not sink the import" rule.
// v8.3.39 (external audit) — ONE definition of the role vocabulary. It was
// declared inside the bulk-seed handler and nowhere else, so the participant
// import — the other superadmin-only path that writes `users.role` straight out
// of an uploaded file — had nothing to check against and `users.role` carries no
// CHECK constraint.
// v8.7.0 — `event_admin` joins the set. MANDATORY, not cosmetic: `_ALLOWED_ROLES`
// and the import's drop-invalid-role logic both read this Set, so omitting it
// would make a participant import carrying `role:"event_admin"` silently drop the
// value and land a participant with orphan `competition_admins` rows — inert
// (they cannot pass requireAdmin) but a silent demotion nobody can diagnose.
const USER_ROLES = new Set(["participant", "admin", "superadmin", "event_admin"]);

const _IMPORT_FIELD_SHAPES = {
  // `str`  — must be a string when present at all.
  str: (v) => typeof v === "string",
  // `flag` — anything a boolean can be COERCED from, i.e. anything that is not
  // an object or an array. The write sites normalise it to the integer 0 or 1.
  //
  // THIS DELIBERATELY REJECTS ONLY WHAT CANNOT BE BOUND AT ALL, and a first
  // draft that demanded exactly `true`/`false`/`0`/`1` was wrong in a way that
  // would have bricked a real migration. `tasks.active` and `users.verified`
  // are INTEGER columns with no CHECK, the PRE-v8.3.20 importer bound them raw,
  // and the export projects the column VERBATIM — so a deployment carrying rows
  // this very defect created (`active: 99`, `active: "yes"`) could export them
  // and then have the whole file 400'd on the way back in. Refusing a value the
  // platform's own export emits is worse than the defect: it strands the data.
  //
  // A domain violation is therefore NORMALISED at the write (`v ? 1 : 0`), the
  // same posture as the field caps, while an object or array — which
  // better-sqlite3 cannot bind and which no export can produce — is a malformed
  // FILE and is refused with the row named.
  flag: (v) => typeof v !== "object",
  // `answer` — text for every answer type EXCEPT `choice`, where a
  // hand-authored file may legitimately carry a real ARRAY of option ids and
  // `_importCorrectAnswer` re-serialises it. So this one has to consult the row
  // rather than the value alone; an object is never legitimate either way, and
  // was reaching the bind as a 500.
  answer: (v, row) => (row && row.answer_type === "choice") ? (typeof v === "string" || Array.isArray(v)) : typeof v === "string",
};
function _importRowShapeError(rows, noun, fields) {
  for (const [i, r] of rows.entries()) {
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      return `${noun} #${i + 1} is not an object. The file is malformed — every entry must be a ${noun.toLowerCase()} record.`;
    }
    for (const [name, kind] of Object.entries(fields || {})) {
      const v = r[name];
      // Absent / null is the caller's business (a default, a COALESCE, a skip);
      // only a PRESENT value of the WRONG SHAPE is a malformed file.
      //
      // And EMPTINESS is deliberately not policed here. A blank title is
      // well-typed and merely unimportable, so it belongs to the SKIP posture
      // (`if (!t.title) continue`) exactly as a bad `difficulty` does — the
      // v7.21.1 (A10) line this whole check is built on. A first draft rejected
      // it and would have turned one blank row in a 500-challenge migration
      // into a refused file.
      if (v === undefined || v === null) continue;
      if (!_IMPORT_FIELD_SHAPES[kind](v, r)) {
        const want = kind === "flag" ? "true/false, 0/1 or a number"
          : kind === "answer" ? "text (or a list of option ids on a choice challenge)"
          : "text";
        return `${noun} #${i + 1} has an invalid "${name}". The file is malformed — expected ${want}.`;
      }
    }
  }
  return null;
}

const { escapeHtml, sanitiseAvatar, sanitiseRichText, extractAndStoreImages, richTextHasContent, deleteAvatarImage, takeDroppedImageCount, _RICH_IMG_ALLOWED_SUBTYPES } = require("./lib/sanitise"); // v7.0.0: sanitization extracted
// v8.1.0 (PR 13) — the kind label table + the collective noun, pre-rendered once as
// HTML-attribute-safe JSON for the SPA-shell substitution below. Source constants,
// so there is nothing to recompute per request and nothing to go stale until deploy.
const { eventKindsForWire, EVENT_COLLECTIVE, eventPolicy, autoEndOnAllSolvedApplies, clockStartsAtFirstOpen } = require("./lib/event-policy");
const _EVENT_KINDS_ATTR = escapeHtml(JSON.stringify(eventKindsForWire()));
const _EVENT_COLLECTIVE_ATTR = escapeHtml(JSON.stringify(EVENT_COLLECTIVE));
// The emailed sign-in code's lifetime (LOGIN_CODE_TTL_MS, fixed at boot) rides
// the shell beside the kind table, for the same reason: the sign-in card reuses
// the code step only while the code lives, and a throttled /api/config at a
// venue NAT must not leave it guessing (GET /api/config still reports it).
const _LOGIN_CODE_TTL_ATTR = String(require("./lib/config").LOGIN_CODE_TTL_MS);
const { parseTrustProxy, parseIpAllowlist, ipAllowlistMatch, normaliseRoutePath, detachedFanoutPending, trackDetachedSend, normaliseEmail, NO_PASSWORD_HASH, validateUrl, isFreeEmail, isValidEmailFormat, sameSlotEmails, _capsOk, _firstNonStringField, isValidTimezone, _nicknameCharsOk, NICKNAME_CHARSET_ERROR, GROUP_NAME_MAX, _groupNameKey, clampPagingIndex, PAGING_INDEX_MAX, profileTextControlField } = require("./lib/util"); // v7.0.0: pure cross-cutting helpers + email-shape predicates + profile caps + group-name validation
const { refuseRepeatedQuery } = require("./lib/validate"); // v8.13.3 — the query-string boundary (QAB-1, QAB-6)
const { getPlatformName, getBreakglassUsername, breakglassNameHeldByAccount } = require("./lib/settings"); // v7.0.0: settings accessors extracted
const { getPlatformLook } = require("./lib/platform-look"); // the superadmin's platform look, on the SPA shell
const { clearLockout, expiredLockouts } = require("./lib/lockout"); // v7.29.0: the per-account lockout threshold + its three columns own one module
const { loginCodeCounters, _testLastLoginCode, _resetRecentSends } = require("./lib/login-code"); // v7.29.0
const { sweepExpiredProofs, _resetProofOriginSpend } = require("./lib/email-proof");
const { emailIsTaken } = require("./lib/email-identity"); // v7.0.0: email-uniqueness check extracted
const { _invalidateMeCache, _invalidateMeCacheForComps, _meCacheSize } = require("./lib/me-cache"); // v7.0.0: /api/me cache extracted (single process-global instance)
const { invalidateAdminParticipantsCache } = require("./lib/participants-cache"); // v7.0.0: admin-participants page cache extracted
const { invalidateOtherSessions, markSessionPurged, wasSessionPurged, sweepRevokedSessions, SESSION_COOKIE_NAME, setCookieCarriesSession, kickerContext, _sessionHasIdentity, _extractOldSessionId } = require("./lib/sessions"); // v7.0.0: single-session enforcement + kick-context cache extracted
const { _updateStatusObservation, runStatusSchedulerTick, startStatusScheduler } = require("./lib/scheduler");
// v8.15.1 — automatic certificates + the congratulations email (a durable queue
// the end paths fill and this worker drains; joins the shutdown drain below).
const { enqueueCertificateDispatch, enqueueCompletionCertificate, enqueueCompletersOf, runCertificateDispatch, certificateDispatchBusy, startCertificateDispatcher, stopCertificateDispatcher, setCertificateMailHold } = require("./lib/certificate-dispatch"); // v7.0.0: auto-start/end status scheduler extracted
const { startAccountReaper, sweepUnverifiedAccounts, sweepStaleVerifyCodes} = require("./lib/account-reaper"); // v7.6.0 — unverified-account reaper
const { startEventRetentionReaper, sweepExpiredEvents } = require("./lib/event-retention"); // v7.7.17 — *_events 2-year retention purge
const { reconcileGroupBoundCompetitions, detectMemberAddClashes, findGroupByName, reconcileDrainPending } = require("./lib/group-sync"); // v7.0.0: group→competition live-sync engine extracted (top of DAG)
const { smtpHealthy, smtpSendsPending, closeTransport, getUserEmails, buildEmail, sendEmailLogged, sendUnlockEmail } = require("./lib/email"); // v7.0.0: email subsystem + composed senders extracted
const { getParticipantScore, invalidateLeaderboardCache, freezeGroupLeaderboardSnapshots, _leaderboardCacheEntryCount } = require("./lib/leaderboard"); // v7.0.0: leaderboard aggregation + cache extracted
const { _invalidateUserTagsCache, _userTagsCacheSize } = require("./lib/user-tags"); // v7.0.0: user-tag reads + cache extracted
// v7.16.0 — per-competition trusted networks + operator alerting for IP bans.
const { competitionAllowlistMatch, anyCompetitionLive,
        setScannerBlockClearer } = require("./lib/comp-allowlist");
const { recordIpBanAlert, deliverAlert, _clearAllAlertsForTests } = require("./lib/admin-alerts");
const { classifyHit, isProbeSignature, addPathBit, flattenPath, classifyScannerTraffic, probeEarlyBlockDue, PROBE_EARLY_THRESHOLD, PROBE_SAMPLE_MAX, PROBE_SAMPLE_PATH_MAX } = require("./lib/scanner-classify"); // v7.25.0 — scanner vs venue
const { LOG_SORT_COLUMNS, makeLogComparator } = require("./lib/log-sort"); // v7.25.0 — global ordering for a FILTERED /api/admin/logs read
const { setTestSelectTimeslotDelay, setTestAdminEmailDelay, setTestAdminCommitDelay, testAdminCommitDelay, testAdminCommitPark, releaseTestAdminCommitPark, rateLimit, _setTestRateLimitForceEnabled, _rateLimitBucketCount, _sweepRateLimitBuckets, _ageRateLimitBuckets, generateToken, csrfProtection, requireParticipant, requireAdmin, requireSuperAdmin, requireCompetitionContext, requireParticipantInCompetition, participantAuthzDenied, adminAuthzDenied, impersonatingHandDenied, sendImpersonationCommitDenial, participantSessionDenied, sendParticipantSessionDenial, _rateLimitAllowlisted, stampClockOnFirstTouch } = require("./lib/middleware"); // v7.0.0: per-route middleware (rate-limit/CSRF/auth guards) extracted
const { impersonationGuard, impersonationActor, impersonationEndedDetails, isImpersonating } = require("./lib/impersonation"); // v7.14.0 — participant impersonation (write gate + audit-actor helper)
const { eventAdminGuard, actorId, actingAdminId, sealRevealSet, sealRevealedFor, competitorIds, competitionDenied, scopeFilterSql, scopedCompetitionIds, groupViewDenied } = require("./lib/event-admin"); // v8.7.0 — the default-deny route gate, plus the row-level scope predicates the inline reporting handlers below enforce
// v8.10.0 — the sealed answer. Two consumers in this file: the admin submissions
// redaction and the tasks-import refusals. See lib/answer-seal.js.
const { sealedAnswerReadable, submissionAnswerProjection, answerSealed, sealTypeDenied } = require("./lib/answer-seal");
const { staffCompeteOn: _staffCompeteOn, authoredAssignedTasks: _authoredAssignedTasks, competitorIn: _competitorIn, competitorEventsForTask: _competitorEventsForTask, competitorGroupDenied: _competitorGroupDenied, competitorRivalDenied } = require("./lib/staff-compete"); // v8.12.0 — staff can compete
const { findUserByPrimary, findUsersByPrimaryList } = require("./lib/account-lookup"); // index searches on uq_users_email_nocase

const UPLOAD_ALLOWED_MIME = new Set(["text/plain", "text/csv", "application/json", "application/octet-stream"]);
// The submit handler's caps, in UTF-16 code units: a text answer, and a file
// answer once read and trimmed. The multipart limits below are derived from them.
const SUBMIT_ANSWER_MAX_CHARS = 65536;
const SUBMIT_FILE_ANSWER_MAX_CHARS = 1_048_576;
const SUBMIT_ANSWER_TOO_LONG = "Answer too long. Please shorten your submission.";
const SUBMIT_FILE_ANSWER_TOO_LARGE = "Uploaded file is too large. Maximum answer size is 1 MB.";
// The 413 sentences for multer's size and count refusals (_describeRequestError),
// declared here because the submit route's declared-length gate is built from one
// of them at registration.
const _BODY_LIMIT_HINT = "Reduce the size and try again — retrying unchanged will not help.";
const _FORM_SHAPE_HINT = "Retrying it unchanged will not help.";
const _MULTER_TOO_LARGE = Object.freeze({
  LIMIT_FILE_SIZE:   `That file is too large. ${_BODY_LIMIT_HINT}`,
  LIMIT_FIELD_VALUE: `A text field in that upload is too long. ${_BODY_LIMIT_HINT}`,
  LIMIT_FIELD_KEY:   `A field name in that upload is too long. ${_FORM_SHAPE_HINT}`,
  LIMIT_FIELD_COUNT: `That upload has more form fields than this endpoint accepts. ${_FORM_SHAPE_HINT}`,
  LIMIT_FILE_COUNT:  `That upload carries more files than this endpoint accepts. ${_FORM_SHAPE_HINT}`,
  LIMIT_PART_COUNT:  `That upload has more parts than this endpoint accepts. ${_FORM_SHAPE_HINT}`,
});
// The client sends `file` OR `answer`, plus `gradingHash` (CSRF rides the
// x-csrf-token header: csrfProtection runs before multer). So: one file, two
// text fields, three parts, flat names (lib/multipart.js says why each is
// required). fieldSize: a text answer the handler accepts is at most 3 UTF-8
// bytes per code unit (a lone surrogate is sent as U+FFFD, an astral character
// is 2 units in 4 bytes), and fieldSize is the largest value multer admits, so
// every answer up to the handler's cap reaches the handler and its own sentence.
const _SUBMIT_UPLOAD_LIMITS = {
  fileSize: 10 * 1024 * 1024, files: 1, fields: 2,
  fieldSize: 3 * SUBMIT_ANSWER_MAX_CHARS, fieldNameSize: 100, parts: 3, fieldNestingDepth: 0,
};
const upload = boundedMulter({
  dest: UPLOADS_DIR,
  // The aborted-upload orphan DoS (CVE-2026-5038) was only partly fixed by multer
  // 2.2.0 — an upload aborted before the storage engine assigned the path could
  // still leave a whole file behind; 2.4.0 finishes it (CVE-2026-88932, v8.12.7).
  // The hourly UPLOADS_DIR sweep (v8.8.15) remains the backstop either way.
  limits: _SUBMIT_UPLOAD_LIMITS,
  fileFilter: (req, file, cb) => {
    if (UPLOAD_ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    // audit v7.7.32 (RM1) — flag the rejection so the submit handler can return a
    // SPECIFIC "unsupported file type" 400. Pre-fix a non-allowlisted MIME (e.g.
    // an .xml/.md/.yaml answer file → text/xml, text/markdown, application/x-yaml)
    // was silently dropped (cb(null,false)); the handler then saw !req.file and
    // returned the MISLEADING "challenge now expects a file upload …
    // task_changed" response — blaming an admin reconfig for a plain bad MIME and
    // making the SPA reload the task, with every retry of that file failing the same.
    req._uploadRejected = { name: file.originalname, mime: file.mimetype };
    cb(null, false);
  },
});

// Task attachments (.zip downloads). Separate multer + limits from the submit
// upload because the ceilings differ (10 MB for a participant file-answer vs
// 64 MB for an admin-uploaded ZIP). MIME whitelist is deliberately lenient
// because browser + OS pickers disagree on the .zip MIME type; the real
// gatekeeper is validateUnencryptedZip() which walks the central directory
// before the file is accepted.
// The ATTACHMENT_* limit constants + validateUnencryptedZip + the attachment
// validation/budget helpers now live in lib/attachments.js (imported at the top
// of this file). The boot/periodic sweep schedulers + the on-disk dirs + the
// multer instance stay here.
// v6.13.18 — per-(user, task) submission velocity throttle. The gameplay
// model is "unlimited attempts" (every wrong answer is independently
// scored, with a -5 penalty), but a malicious or scripted client can
// post novel answers as fast as the wire allows — every one of which
// becomes a row in submissions + a row in challenge_events + an
// app.jsonl audit line. At 100 req/s sustained on one (user, task), one
// participant doubles the per-minute write load of a 500-VU live event.
// This cap is intentionally generous so that legitimate retry behaviour
// (a fast typist, an autocomplete misfire, a "double-tap" race that
// falls outside the 3 s same-answer dedupe) still fits inside it; the
// floor is set so a brute-force loop becomes obvious.
const SUBMIT_VELOCITY_MAX_PER_MIN = 30;
// uploadAttachment (the .zip multer instance) now lives in routes/challenges.js
// — its only consumers are the attachment upload + staging routes there.
const ATTACHMENTS_DIR         = path.join(DATA_DIR, "attachments");
const ATTACHMENTS_STAGING_DIR = path.join(DATA_DIR, "attachments-staging");
// UPLOADS_DIR joins them: multer needs it to exist before the first upload, and
// since v7.15.4 it can point outside the repo root (per-worker in tests).
for (const d of [ATTACHMENTS_DIR, ATTACHMENTS_STAGING_DIR, UPLOADS_DIR]) {
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o750 }); } catch (_err) { swallowed("server:best-effort", _err); }
}

/**
 * Verify `filePath` is a structurally valid, unencrypted ZIP archive with no
 * zip-bomb characteristics. Returns `{size_bytes, entries}` on success or
 * rejects with an Error whose `.code` is one of: "not_a_zip" | "encrypted" |
 * "zip_bomb" | "too_many_entries" | "too_large" | "corrupted".
 *
 * Streams the central directory only — never decompresses. O(entries). No
 * allocation spikes (yauzl's lazyEntries mode drives entry emission on
 * demand). Fails fast on the first encrypted entry rather than walking the
 * whole archive.
 *
 * Encryption detection covers all three general-purpose bitflag positions
 * the ZIP spec reserves for it (bit 0 = traditional PKWARE, bit 6 = strong
 * encryption / AE-x, bit 13 = masked central-directory headers).
 */
// validateUnencryptedZip now lives in lib/attachments.js (imported at the top).
// v6.8.5 — sweep the uploads dir and drop files older than 1 hour. The normal
// submit flow deletes its temp file on completion (cleanupUpload), but a
// SIGKILL between multer.write and cleanupUpload leaves the temp on disk
// indefinitely.
//
// v8.8.15 — AND IT RUNS ON A TIMER, not only at boot. The original comment said
// "after a few restart cycles the uploads/ volume would accumulate stranded
// temp files forever", which reasons about restarts — but the platform is a
// long-uptime single process, so the boot-only version reclaimed nothing at all
// between deployments. That is the wrong way round for the two things that make
// this directory matter: it is a SEPARATE VOLUME from DATA_DIR, and the upload
// capacity check measures free space on it (v7.15.12), so stranded temps do not
// merely waste disk — they eventually refuse legitimate uploads.
//
// The 1-hour TTL is the guard, so no recency clause is needed: a file this old
// cannot be an in-flight upload. Hourly cadence, so a stranded temp is reclaimed
// between one and two hours after it was abandoned.
function _sweepUploadsTemp() {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) return 0;
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
    let reaped = 0;
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      try {
        const full = path.join(UPLOADS_DIR, f);
        const st = fs.statSync(full);
        if (st.isFile() && st.mtimeMs < cutoff) { fs.unlinkSync(full); reaped++; }
      } catch (_err) { /* ignore individual file errors */ swallowed("server:boot-sweep-file", _err); }
    }
    return reaped;
  } catch (_) { return 0; /* uploads dir absent is fine */ }
}
_sweepUploadsTemp();
if (process.env.NODE_ENV !== "test") {
  setInterval(() => {
    const reaped = _sweepUploadsTemp();
    if (reaped > 0) console.log(`[uploads] periodic sweep: reaped ${reaped} stranded temp file(s)`);
  }, 60 * 60_000).unref();
}

// Attachment sweeps: on-boot garbage collection for (a) the permanent
// attachments dir where a DB-committed delete may have failed to unlink the
// file on disk, (b) the staging dir where an abandoned create flow left
// files without a matching staging row, (c) staging rows older than 1 hour.
// Each sweep is scoped to one directory and tolerates individual failures.
// Periodic staging sweep runs every 10 min so abandoned-and-forgotten
// uploads don't grow disk usage unbounded between restarts.
try {
  if (fs.existsSync(ATTACHMENTS_DIR)) {
    const referenced = new Set(
      db.prepare("SELECT storage_path FROM task_attachments").all().map(r => path.basename(r.storage_path))
    );
    let reaped = 0;
    for (const f of fs.readdirSync(ATTACHMENTS_DIR)) {
      if (!referenced.has(f)) {
        try { fs.unlinkSync(path.join(ATTACHMENTS_DIR, f)); reaped++; } catch (_err) { swallowed("server:best-effort", _err); }
      }
    }
    if (reaped > 0) console.log(`[attachments] boot sweep: reaped ${reaped} orphaned file(s) from attachments/`);
  }
} catch (_err) { swallowed("server:best-effort", _err); }

function _sweepStagingAttachments(ttlMs) {
  try {
    const cutoff = new Date(Date.now() - ttlMs).toISOString();
    const expired = db.prepare(
      "SELECT id, storage_path FROM task_attachments_staging WHERE created_at < ?"
    ).all(cutoff);
    if (expired.length === 0) return 0;
    const del = db.prepare("DELETE FROM task_attachments_staging WHERE id=?");
    for (const row of expired) {
      try {
        // Inline path-containment guard (Checkmarx-recognized sanitizer) — see
        // the note in lib/attachments.js. Only unlink a server-generated
        // storage_path that resolves strictly under DATA_DIR.
        const _base = path.resolve(DATA_DIR);
        const abs = path.resolve(path.join(DATA_DIR, String(row.storage_path || "")));
        if (abs.startsWith(_base + path.sep)) fs.unlinkSync(abs);
      } catch (_err) { swallowed("server:best-effort", _err); }
      del.run(row.id);
    }
    return expired.length;
  } catch (_) { return 0; }
}
// (a) files with no staging row → orphan from a write-then-row-insert crash.
//
// v8.8.15 — PERIODIC, AND THE RECENCY GUARD IS WHAT MAKES THAT SAFE. The row
// sweep beside it has run every 10 minutes since v6.16.x while this FILE sweep
// stayed boot-only, so a ZIP of up to 64 MB stranded by a crash between the
// rename and the INSERT sat on the backed-up DATA_DIR volume until the next
// deployment — and it counts against the global staging byte ceiling only
// through the TABLE, so the operator could not even see why the disk was full.
//
// THE GUARD IS A HARD PREREQUISITE, NOT DEFENCE IN DEPTH. Adding a timer to the
// unguarded version reproduces the v6.16.9 data-loss bug exactly:
// `POST /api/admin/attachment-staging` renames the file into this directory
// BEFORE its INSERT (routes/challenges.js — the rename is explicitly commented
// as preceding the row), so a tick landing in that window sees a file no row
// references and deletes it, and the INSERT then commits a row pointing at
// nothing. Same `max(mtimeMs, ctimeMs)` reading as the permanent sweep, for the
// v6.16.14 reason: `ctime` is set by rename(2) and cannot be backdated by
// `fs.utimesSync`, so it survives a writer that touches mtime.
function _sweepStagingFiles(recencyMs = 5 * 60_000) {
  try {
    if (!fs.existsSync(ATTACHMENTS_STAGING_DIR)) return 0;
    const referenced = new Set(
      db.prepare("SELECT storage_path FROM task_attachments_staging").all().map(r => path.basename(r.storage_path))
    );
    // The window is an ARGUMENT only so a test can drive the reaping half at
    // all: `ctime` cannot be moved from userspace (that is the whole point of
    // reading it), so a file this process just wrote can never be made to look
    // five minutes old. Every caller in the running server uses the default.
    const recencyCutoffMs = Date.now() - recencyMs;
    let reaped = 0;
    for (const f of fs.readdirSync(ATTACHMENTS_STAGING_DIR)) {
      if (referenced.has(f)) continue;
      const filePath = path.join(ATTACHMENTS_STAGING_DIR, f);
      let stat;
      try { stat = fs.statSync(filePath); } catch (_) { continue; }
      if (Math.max(stat.mtimeMs || 0, stat.ctimeMs || 0) > recencyCutoffMs) continue; // in-flight upload
      try { fs.unlinkSync(filePath); reaped++; } catch (_err) { swallowed("server:best-effort", _err); }
    }
    return reaped;
  } catch (_) { return 0; }
}
try {
  const reapedFiles = _sweepStagingFiles();
  if (reapedFiles > 0) console.log(`[attachments] boot sweep: reaped ${reapedFiles} orphaned file(s) from attachments-staging/`);
  // (b) staging rows older than 1 hour → the admin walked away or crashed
  const reapedRows = _sweepStagingAttachments(60 * 60 * 1000);
  if (reapedRows > 0) console.log(`[attachments] boot sweep: reaped ${reapedRows} stale staging row(s)`);
} catch (_err) { swallowed("server:best-effort", _err); }
if (process.env.NODE_ENV !== "test") {
  // ONE timer for both halves of the staging directory: the row sweep unlinks
  // the files it owns, this one reclaims the files no row ever claimed. Rows
  // first, so a file whose row has just expired is reaped by its own row rather
  // than becoming an orphan this tick has to wait 5 minutes to touch.
  setInterval(() => {
    const rows = _sweepStagingAttachments(60 * 60 * 1000);
    if (rows > 0) console.log(`[attachments] periodic sweep: reaped ${rows} stale staging row(s)`);
    const files = _sweepStagingFiles();
    if (files > 0) console.log(`[attachments] periodic sweep: reaped ${files} orphaned file(s) from attachments-staging/`);
  }, 10 * 60_000).unref();
}
// v6.16.7 — periodic sweep of the PERMANENT attachments dir. Pre-fix
// the permanent dir was only swept at boot (above). On a long-uptime
// server, orphan files (binaries that survived a txn rollback's
// best-effort unlink, or a future code path that moved a file then
// errored before the row insert without cleanup) accumulate
// indefinitely. The sweep walks every file in ATTACHMENTS_DIR and
// removes any whose storage_path isn't referenced by task_attachments.
// Daily cadence is plenty — orphans don't grow at any meaningful
// rate.
function _sweepPermanentAttachments() {
  try {
    if (!fs.existsSync(ATTACHMENTS_DIR)) return 0;
    const referenced = new Set(
      db.prepare("SELECT storage_path FROM task_attachments").all().map(r => path.basename(r.storage_path))
    );
    // v6.16.9 — recency cutoff. Pre-fix the sweep racy-deleted files
    // that the direct-upload path had just renamed into ATTACHMENTS_DIR
    // but hadn't yet INSERTed into task_attachments. The rename happens
    // BEFORE the txn at server.js:7853, so a sweep tick landing in that
    // window saw the file with no row reference and unlinked it — the
    // INSERT then committed a row pointing at a missing file (silent
    // data loss; download 404s). The 5-min skew here is generous: the
    // direct-upload txn typically completes in tens of ms, so anything
    // newer than 5 min is presumed in-flight. The sweep runs daily so
    // a "missed" orphan file lingers at most one day longer.
    // v6.16.14 — gate on max(mtimeMs, ctimeMs). `ctime` (inode metadata
    // change time) is updated by `rename(2)` and `link(2)` and CAN'T
    // be set by `fs.utimesSync`. `mtime` reflects content modification
    // and is settable, so a future writer that backdates mtime would
    // race the sweep. Using max() picks whichever is more recent so
    // either signal protects in-flight files.
    const recencyCutoffMs = Date.now() - 5 * 60_000;
    let reaped = 0;
    for (const f of fs.readdirSync(ATTACHMENTS_DIR)) {
      if (referenced.has(f)) continue;
      const filePath = path.join(ATTACHMENTS_DIR, f);
      let stat;
      try { stat = fs.statSync(filePath); } catch (_) { continue; }
      const tCheck = Math.max(stat.mtimeMs || 0, stat.ctimeMs || 0);
      if (tCheck > recencyCutoffMs) continue; // in-flight upload, skip
      try { fs.unlinkSync(filePath); reaped++; } catch (_err) { swallowed("server:best-effort", _err); }
    }
    return reaped;
  } catch (_) { return 0; }
}
if (process.env.NODE_ENV !== "test") {
  setInterval(() => {
    const reaped = _sweepPermanentAttachments();
    if (reaped > 0) console.log(`[attachments] permanent dir sweep: reaped ${reaped} orphan file(s)`);
  }, 24 * 60 * 60_000).unref();
}
// cleanupUpload + UPLOADS_DIR now live in lib/http.js (imported at the top of
// this file) so both the submit route and the boot multipart error handler can
// reach them without a server→route edge.

// The SMTP transporter, its health probe (_smtpHealthy / smtpHealthy()), and
// the FATAL SMTP_HOST check now live in lib/email.js (required at the top of
// this file). transporter + smtpHealthy are imported for the /api/admin/test-
// email route and the /metrics SMTP gauge respectively.




// Length caps for user-supplied identity and profile strings (v6.8.0).
// Without these, registration and self-edit accepted arbitrary-length
// nicknames / names / company / title values — a 1 MB nickname would
// persist into users.nickname and flow into every audit log line,
// leaderboard JSON payload, and email greeting from that point on.
// Caps are generous enough for real names (longest registered personal
// name on record is ~30 chars; corporate titles around ~100) but low
// enough that the per-request memory footprint is bounded.
// USER_FIELD_CAPS / _capsOk / _profileMissingFields now live in lib/util.js
// (imported at the top of this file). TASK_FIELD_CAPS now lives in
// routes/challenges.js (its only consumers are the task create/edit routes).
// getPlatformName + _invalidatePlatformNameCache now live in lib/settings.js
// (imported at the top of this file).

// buildEmail now lives in lib/email.js (imported at the top of this file).

// sendLockoutEmail / sendUnlockEmail / sendVerificationEmail now live in
// lib/email.js (imported at the top of this file), composed over its buildEmail
// / sendEmailLogged / sendEmailBackground primitives.

const app = express();
// Drop the default X-Powered-By: Express header so every response doesn't
// advertise the framework + version to reconnaissance scanners.
app.disable("x-powered-by");
// Deployment shape is operator-defined. Default is to NOT trust any proxy so that a
// direct client cannot spoof `req.ip` via X-Forwarded-For — which would otherwise
// let them bypass rate limits (the sign-in and sign-up doors) and poison every
// IP attribution in the audit event log. Operators behind a real reverse proxy
// (nginx, Cloudflare, k8s-ingress, etc.) must explicitly opt in with TRUST_PROXY.
//
// Accepts the same values Express does, keywords in any case (lib/util.js
// parseTrustProxy, which says why):
//   unset / "false" / "0"   — trust nothing (default, safest)
//   "true"                  — trust all proxies (only when upstream strips the header)
//   "1", "2", …             — trust that many hops
//   "loopback"/"linklocal"/"uniquelocal" — preset CIDR lists
//   comma-separated IP/CIDR list — passed through to Express
// See https://expressjs.com/en/guide/behind-proxies.html for the full contract.
(function configureTrustProxy() {
  app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));
})();

// Request ID + access log middleware — runs first so everything downstream has req.id.
const _IS_DEV = process.env.NODE_ENV !== "production";
// IPs whose access-log entries are silently dropped. Entirely opt-in via
// the LOG_SKIP_IPS env var (comma-separated) — no built-in defaults, so
// test suites that run against 127.0.0.1 still see their access log entries
// and existing tests that assert on them keep passing.
//
// Supports both exact addresses and CIDR notation:
//   LOG_SKIP_IPS=127.0.0.1,::1,::ffff:127.0.0.1,172.17.0.0/16,10.0.0.0/8
//
// In a Docker Compose setup, add LOG_SKIP_IPS to the environment block of
// the app service; in k8s, set it in the pod spec's env section.
//
// v7.21.13 — this was a hand-rolled SECOND implementation of exactly what
// lib/util.js's parseIpAllowlist / ipAllowlistMatch already do, and lib/util.js
// even documented itself as "mirrors the LOG_SKIP_IPS parsing in server.js".
// A mirror is not a shared implementation, and the two had drifted: v7.20.9
// (F11) taught the util version to CANONICALISE an address before comparing it
// (RFC 5952 via the WHATWG URL parser, plus unwrapping IPv4-mapped IPv6), and
// this copy never learnt it. So `LOG_SKIP_IPS=2001:db8::1` did not skip a
// client the proxy reported as `2001:0DB8:0000:0000:0000:0000:0000:0001` — the
// same host, written the other way — and the failure is the silent kind: the
// operator believes an address is excluded and its requests keep landing in the
// access log. Deleting the copy fixes that by construction.
const _accessLogSkip = parseIpAllowlist(process.env.LOG_SKIP_IPS || "");
function _accessLogShouldSkip(ip) {
  return !!ip && ipAllowlistMatch(_accessLogSkip, ip);
}
// v6.21.0 — the self-enrollment token is a secret that travels in the URL
// (canonical /join/<token>, plus the ?join=<token> fallback). The access log
// records the full request path, so without scrubbing the token would land
// verbatim in app/access logs — and any downstream log shipper or backup.
// _REDACT_KEYS only scrubs object keys in structured context, not the raw
// path string, so this closes that gap. Replace the token with a placeholder.
// v8.1.0 — the replacements are GLOBAL. They were `/i` (first match only), so a
// duplicated query parameter — `?code=decoy&code=<real>` — left the second copy in
// the log verbatim. An attacker cannot exploit that against themselves, but a
// crawler or a mistyped link can put a live credential on disk, which is the whole
// thing this function exists to prevent.
function _scrubLogPath(p) {
  if (!p || typeof p !== "string") return p;
  return p
    .replace(/\/join\/[^/?#]+/gi, "/join/[REDACTED]")
    // v8.1.0 (PR 32) — the SHORT JOIN CODE. It is printed on a sign, so it is
    // not a secret in the way the token beside it is — but the lookup EXCHANGES
    // it for that token, which makes it capability-bearing in a URL, and the
    // token is scrubbed precisely so a log shipper or a backup cannot hand
    // someone a join capability. Uniform rule, same reasoning as the unsubscribe
    // token in v7.21.14: the one URL secret the list did not cover is the one
    // that gets used.
    .replace(/\/api\/competitions\/join-code\/[^/?#]+/gi, "/api/competitions/join-code/[REDACTED]")
    .replace(/([?&]join=)[^&#]+/gi, "$1[REDACTED]")
    // v7.22.8 — the LinkedIn OAuth start (GET /api/auth/linkedin?joinToken=…)
    // carried the self-enroll secret as a query param, and the `join=` rule
    // above cannot match it. That route is gone with LinkedIn sign-in; the rule
    // stays for any request that still names the parameter (a stale client or
    // bookmark), which is logged like any other.
    .replace(/([?&]jointoken=)[^&#]+/gi, "$1[REDACTED]")
    // v7.1.0 — keep the (public but capability-bearing) badge token out of logs.
    .replace(/\/badge\/[^/?#]+/gi, "/badge/[REDACTED]")
    // v8.6.1 — the badge REVOKE route takes the same capability as a path
    // segment under `/badges/` (plural), which the rule above cannot match, and
    // no `?token=` is involved either — so this was the one capability-shaped
    // path parameter in this set with no rule at all. Found by the EVENTS_*.md
    // cleanup, whose design note had predicted it and whose deletion would have
    // been the last record of it.
    //
    // Scope it honestly: on the SUCCESS path the token is already dead by the
    // time the access line is written (the UPDATE precedes `res.on("finish")`,
    // and every serving route filters `revoked_at IS NULL`). It is LIVE on the
    // refusal paths that return before the handler — a regular admin's 403 from
    // `requireSuperAdmin`, a 429, a CSRF failure — and `GET /api/admin/logs` is
    // `requireAdmin`, so that is the reachable read. A standing-rule violation
    // with a narrow live window rather than a ready exploit; one line closes it.
    .replace(/\/api\/admin\/badges\/[^/?#]+/gi, "/api/admin/badges/[REDACTED]")
    // DELETE /api/admin/unsubscribed/:email carries the opted-out ADDRESS as a
    // path segment. The access log (and the Logs pane regular admins read) is no
    // place for it: an identity in a URL gets its rule like a capability does.
    .replace(/\/api\/admin\/unsubscribed\/[^/?#]+/gi, "/api/admin/unsubscribed/[REDACTED]")
    // A holder's own certificate card asks for its LinkedIn post by the BADGE
    // TOKEN as a path segment (GET /api/me/certificates/:token/linkedin-post);
    // the `/badge/` rule above cannot see it, and the token is the capability
    // that downloads the certificate as anyone.
    .replace(/\/api\/me\/certificates\/[^/?#]+/gi, "/api/me/certificates/[REDACTED]")
    // Typed IDENTITIES in a query string: the Audit page's actor filter and the
    // pickers' name-or-address search carry an operator's typing about a person.
    .replace(/([?&](?:actor|search)=)[^&#]+/gi, "$1[REDACTED]")
    // v7.2.x (audit) — the SPA fetches the public preview with the SECRET
    // self-enroll token in the path; redact it here too (the /join scrub above
    // never saw the API path).
    .replace(/\/api\/competitions\/self-enroll\/[^/?#]+/gi, "/api/competitions/self-enroll/[REDACTED]")
    // audit v7.7.38 (SEC1) — scrub the capability-bearing verify / confirm-email /
    // credential `?code=` at WRITE time, so such a code never
    // lands in access-*.jsonl (or its backups / log-shippers) in cleartext. Read-time
    // redaction (_CODE_REDACT_RE in redactLogEntryForRegularAdmin) only covered
    // regular admins viewing /api/admin/logs — the on-disk file + superadmins saw it.
    // Consistent with how join/badge/self-enroll tokens are already scrubbed here.
    .replace(/([?&]code=)[^&#]+/gi, "$1[REDACTED]")
    // v8.1.0 (PR 29) — the superadmin code-to-holder resolver takes the credential
    // code as a PATH SEGMENT, which the `?code=` rule above cannot see. Caught by
    // its own test rather than by review, which is the argument for that test:
    // the resolver exists BECAUSE codes reach the logs, so leaking one into the
    // access log on the way to resolving it is the defect wearing its own uniform.
    .replace(/\/api\/admin\/credential\/[^/?#]+/gi, "/api/admin/credential/[REDACTED]")
    // v7.21.13 — the unsubscribe token was the one capability-bearing URL secret
    // this list did not cover, and it is the WORST of them on two counts. It is
    // valid for 365 DAYS (every other token here is 48 h or tied to a live
    // competition), and its payload is `_b64url(JSON.stringify({e: <email>,…}))`
    // — signed, not encrypted — so an access-log line does not merely leak a
    // capability, it leaks the RECIPIENT'S EMAIL ADDRESS in a form anyone can
    // decode. It reaches the log because GET /api/unsubscribe exists for exactly
    // the reason it must be scrubbed: link-prefetchers and scanners follow it
    // (v7.15.11), so those hits land in access-*.jsonl verbatim.
    .replace(/([?&]token=)[^&#]+/gi, "$1[REDACTED]")
    // v8.3.16 — THE INVITATION ID, which was the LAST capability-bearing URL
    // parameter this list did not cover, and the reachability multiplier behind
    // the LinkedIn invitation-identity takeover fixed in the same release.
    //
    // It reaches the log by `GET /register?invitation=<id>` (the link in every
    // invitation email) and `GET /api/invitations/:id` as a path segment (and,
    // for a stale client, the removed LinkedIn start's `?invitationId=`). It is
    // a BEARER capability with no expiry, and `GET /api/admin/logs` is `requireAdmin` — so before
    // this, any REGULAR admin could read live invitation ids out of the access
    // log. The v7.21.13 rule, third time: the one URL secret the list did not
    // cover is the one that gets used.
    .replace(/([?&]invitation(id)?=)[^&#]+/gi, "$1[REDACTED]")
    .replace(/\/api\/invitations\/[^/?#]+/gi, "/api/invitations/[REDACTED]")
    // v8.10.0 — THE ONE PLACE A SUBMITTED ANSWER CAN REACH A URL.
    //
    // A participant's answer arrives in a POST body, which this logger never
    // records, so the submit path is clean by construction. The Submissions
    // search is the exception: `GET /api/admin/submissions?q=<term>` matches the
    // term against `submissions.answer`, so an admin looking for what somebody
    // wrote puts a real participant answer in the query string — and from there
    // into `access-*.jsonl`, which every REGULAR admin reads through
    // GET /api/admin/logs and which `scripts/backup.sh` copies.
    //
    // Scrubbed rather than the endpoint narrowed, because the search itself is
    // the job that pane exists for. `q` is used by several admin list endpoints
    // and the term is an operator's own typing on all of them, so the rule is
    // deliberately not scoped to one path — the cost is that a log reader cannot
    // see what an admin searched for, which is not a fact any of them needs.
    .replace(/([?&]q=)[^&#]+/gi, "$1[REDACTED]");
}
// v7.21.28 — WHO made this request, in one place.
//
// The access log has carried this since v6.16.19; the [perf-span] lines carried
// none of it, so a slow-request warning named a route and a duration and nothing
// else. On a shared venue address "somebody's upload was slow" is not actionable
// — the operator needs to know whose, and from where, which is the same argument
// the v7.21.24 error-handler fix made. One definition, so the two cannot drift.
//
// Built-in superadmin has no DB row, so the email column reads "superadmin" as
// the conventional placeholder. While an admin impersonates a participant the
// identity fields attribute to the TARGET (the request genuinely acts as them)
// and `impersonated_by` preserves the link to the acting admin.
function _requestActor(req) {
  const out = {
    ip: req.ip,
    user_id: req.session?.userId || (req.session?.builtinId === "superadmin" ? "superadmin" : null),
    email: req.session?.userEmail || (req.session?.builtinId === "superadmin" ? "superadmin" : null),
  };
  if (req.session?.impersonator) out.impersonated_by = impersonationActor(req.session);
  return out;
}
// The access line's actor fields: `_requestActor` plus the display names.
function _accessActor(req) {
  return {
    ..._requestActor(req),
    first_name: req.session?.userFirstName || null,
    last_name: req.session?.userLastName || null,
  };
}

app.use((req, res, next) => {
  req.id = uuid();
  res.setHeader("X-Request-ID", req.id);
  if (LOG_DISABLE_ACCESS) return next();
  // HEAD requests (probes, preflight-style checks) are noisy in dev — skip them.
  if (_IS_DEV && req.method === "HEAD") return next();
  // Skip access-log entries for healthcheck / container-probe traffic.
  // Configured via LOG_SKIP_IPS env (exact IPs + CIDR ranges).
  if (_accessLogShouldSkip(req.ip)) return next();
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const ctx = {
      req_id: req.id,
      method: req.method,
      path: _scrubLogPath(req.originalUrl || req.url),
      status: res.statusCode,
      ms,
      // v8.13.4 — a handler that DESTROYS the session leaves the actor it read
      // on `req._actorAtDestroy`: express-session's destroy() deletes req.session
      // synchronously, before this `finish` hook runs, so the line about the
      // request that ended a session used to name nobody (the CSRF refusal).
      ...(req._actorAtDestroy || _accessActor(req)),
      user_agent: (req.headers["user-agent"] || "").slice(0, 300),
      session_id: req.sessionID || null,
    };
    const len = res.getHeader("content-length");
    if (len) ctx.bytes = Number(len);
    // Use warn/error levels for 4xx/5xx so queries by level surface problems.
    const lvl = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logAccess[lvl](ctx, `${req.method} ${ctx.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// ───────────────────────────────────────────────────────────────────────────
// Scanner / abuse-scan protection (v6.3.6). Tracks the 4xx response rate per
// IP over a rolling 10-minute window; when one IP accumulates
// _SCANNER_4XX_THRESHOLD failures, it gets a 429 "Too many invalid requests"
// response with a Retry-After header for the next _SCANNER_BLOCK_MS (15 min
// default). The existing per-endpoint rateLimit() middleware covers specific
// hot routes (the sign-in doors, register, …); this global tracker
// catches the OTHER pattern — a scanner hammering dozens of distinct URLs
// looking for /wp-admin, /.env, /phpmyadmin, etc. — all 404s from the static
// fallthrough that no single per-endpoint limit would see.
//
// Legitimate polling breakdown:
//   /api/me          401 every 15s while logged out = 40/10min
//   /api/admin/me    401 every 15s = 40/10min
//   CSRF failures on a real user typo = a handful
// Even a heavy user on multiple tabs tops out well under the 100 threshold;
// a scanner at 1 req/sec across 200 paths blows past it in 2 minutes.
//
// Bypassed when RATE_LIMIT_DISABLED=1 — same knob the per-endpoint limiter
// uses — so the existing test harness that fires bursts of failed logins
// stays green without a second env var.
//
// v7.25.0 — the block is now CLASSIFIED, and only one of the two kinds is
// announced. See lib/scanner-classify.js for the predicate and every
// threshold's reasoning; the short version:
//
//   • traffic dominated by unrouted 404s on distinct, known-bad paths — the
//     /.env, /wp-admin, /phpmyadmin walk — is a scanner. It is blocked
//     SILENTLY: no email, no modal, because no admin decision exists to make.
//     Such an address is also blocked EARLIER (PROBE_EARLY_THRESHOLD), since
//     it has already proven what it is.
//   • anything else — and in particular a roomful of expired sessions polling
//     /api/* and collecting ROUTED 401s — still raises the v7.16.0 operator
//     alert, unchanged. That is the case the alert exists for.
//
// SILENT IS NOT INVISIBLE. Both kinds still emit the log.warn and the
// `scanner_blocked` audit event (carrying the verdict and the probe stats), and
// both move the /metrics counters. Only `_raiseIpBanAlert` is gated — see the
// Docs-hygiene lock that pins exactly that.
const _SCANNER_WINDOW_MS = 10 * 60 * 1000;
const _SCANNER_4XX_THRESHOLD = 100;
const _SCANNER_BLOCK_MS = 15 * 60 * 1000;
const _SCANNER_MAX_ENTRIES = 10000;
// ip → { count4xx, probe4xx, routed4xx, other4xx, probeBits, signatureBits,
//        signatureHits, probeSample[], windowStart, blockedUntil, thresholdKind }
const _scannerIpRep = new Map();
// Lifetime block counters, exposed on /metrics. A silent block would otherwise
// be visible only to somebody who went looking in the Logs tab, and the whole
// point of classifying is that nobody is told to go and look.
const _scannerBlockStats = { probe: 0, cohort: 0, mixed: 0 };
let _scannerSilentBlocks = 0;
// Test-only: the shared harness sets RATE_LIMIT_DISABLED=1, which
// short-circuits the tracker before it counts anything. This forces it back on
// for one spec without arming every per-endpoint limiter as well (which is what
// reusing the rate-limit toggle would do, and it would change the behaviour of
// every other spec that toggles it).
let _testScannerForceEnabled = false;
// v7.16.0 — operator alerting for scanner blocks. See lib/admin-alerts.js for
// why the state is in-process and how the two delivery channels are chosen.
function _countLiveAdminSessions() {
  // "Is anyone actually watching the admin panel right now?" — the answer
  // decides between an in-app modal and an email to the superadmins. Read from
  // the session store rather than a counter we maintain, so a crash or a
  // restart cannot leave it lying.
  try {
    const nowIso = new Date().toISOString();
    const rows = db.prepare("SELECT data FROM express_session").all();
    let n = 0;
    for (const r of rows) {
      let d; try { d = JSON.parse(r.data); } catch (_) { continue; }
      if (!d || !(d.isAdmin || d.isSuperAdmin)) continue;
      const exp = d.cookie && d.cookie.expires;
      if (exp && new Date(exp).toISOString() <= nowIso) continue; // lapsed
      n++;
    }
    return n;
  } catch (_) { return 0; }
}
// v8.3.20 — returns ROWS ({ email, timezone }), not bare strings: the IP-ban
// alert renders its deadline in the recipient's own timezone, so the reader's
// zone has to travel with their address. `timezone` is nullable and can be
// blank or invalid (the participant import blanks an unusable zone by design,
// bulk-seed writes one unvalidated, and requireCompleteProfile is mounted on
// participant surfaces only — so a superadmin is never prompted for it);
// formatEmailDate falls back to a named UTC string for all three cases, so no
// recipient is ever skipped over a formatting input. The built-in superadmin
// has no `users` row and is correctly absent here, as it always was.
function _listSuperadminRecipients() {
  try {
    return db.prepare(
      "SELECT email, timezone FROM users WHERE role='superadmin' AND blocked=0 AND denied_at IS NULL AND email IS NOT NULL"
    ).all().filter(r => r && r.email);
  } catch (_) { return []; }
}
// Clear any scanner block covered by one allowlist entry (an exact IP or a
// CIDR). Returns how many blocked addresses were released.
function _scannerClearMatching(entry) {
  const one = parseIpAllowlist(entry);
  let n = 0;
  for (const [ip, rec] of _scannerIpRep) {
    if (!rec.blockedUntil) continue;
    if (ipAllowlistMatch(one, ip)) { _scannerIpRep.delete(ip); n++; }
  }
  return n;
}
setScannerBlockClearer(_scannerClearMatching);

function _raiseIpBanAlert(ip, rec, verdict) {
  const live = anyCompetitionLive();
  const alert = recordIpBanAlert({
    ip,
    blockedUntil: rec.blockedUntil,
    count4xx: rec.count4xx,
    competition: live,
    // v7.25.0 — the copy used to assert flatly that the traffic "is the pattern
    // of a scanner", which for the cohort case is exactly what the classifier
    // has just decided it is NOT, and it contradicted the paragraph below it
    // ("IF THIS IS YOUR VENUE'S WI-FI, this is expected"). Now that the verdict
    // exists, say which one it is.
    verdict: verdict && verdict.verdict,
    // v8.3.20 — the copy branches on this, not on the verdict label: a pure
    // probe walk with no signature match is "mixed" by ratio while having
    // touched no real endpoint at all.
    routed4xx: verdict && verdict.routed_4xx,
    // If the address was already trusted it should never have been blocked;
    // the copy has to say so rather than send the admin to add it again.
    alreadyTrusted: !!competitionAllowlistMatch(ip),
  });
  if (!alert) return; // already open, or a superadmin ruled this IP a scanner
  // Delivery is fire-and-forget: an SMTP hop must never sit on the request
  // that happened to be the hundredth 4xx.
  deliverAlert(alert, {
    countLiveAdminSessions: _countLiveAdminSessions,
    listSuperadminEmails: _listSuperadminRecipients,
    baseUrl: BASE_URL,
    // v8.3.20 — ONE address per call. deliverAlert owns the fan-out now,
    // because the BODY differs per recipient (the block deadline is rendered in
    // that superadmin's timezone). Returning sendEmailLogged's boolean is what
    // makes the `emailed` count on the audit event truthful: it catches its own
    // SMTP error and returns false rather than throwing, so the old shape
    // recorded N deliveries whenever the relay was down.
    sendMail: (to, subject, text) => sendEmailLogged(null, { to, subject, text }, "ip_ban_alert"),
  }).then(r => {
    try {
      recordOrphanedAuditEvent("security", ip, "ip_ban_alert_raised", "system", {
        ip, channel: r.channel, competition_id: alert.competition_id,
        already_trusted: alert.already_trusted, recipients: r.recipients || 0,
        // v7.20.9 (F6) — the mail now goes out even when an admin session
        // exists, so record what was ACTUALLY delivered rather than only which
        // surface was primary. Same argument as v7.16.4: the alert that tells
        // you to create a rate-limit bypass has to be auditable itself.
        emailed: r.emailed || 0,
      });
    } catch (_err) { swallowed("server:best-effort", _err); }
  }).catch((e) => swallowed("server:ip-ban-alert", e, { level: "warn" }));
}

function _scannerRecord(ip, hit) {
  const now = Date.now();
  let rec = _scannerIpRep.get(ip);
  if (!rec || (now - rec.windowStart) > _SCANNER_WINDOW_MS) {
    // v7.25.0 — CARRY `blockedUntil` ACROSS THE WINDOW ROLL. Writing null here
    // silently lifted a live 15-minute block after 10 minutes, and it was
    // reachable: the COUNT half has no admin exemption (only the BLOCK half
    // does), so an exempt admin sharing a blocked address keeps landing counted
    // 4xx, and the first one after the roll replaced the record — unblocking
    // the whole room early with nothing recording that it had happened.
    //
    // Everything else resets, and must: the classification counters describe a
    // window that has ended. Carrying them forward would leave `probe4xx`
    // already past the early threshold while `count4xx` restarted at 0, so the
    // ratio would exceed 1 and the early block would re-fire on a single
    // request of fresh evidence.
    const carry = (rec && rec.blockedUntil && rec.blockedUntil > now) ? rec.blockedUntil : null;
    const kind = carry ? rec.thresholdKind : null;
    rec = {
      count4xx: 0, probe4xx: 0, routed4xx: 0, other4xx: 0,
      // v8.3.20 — the distinct-path fingerprint is 64 buckets (two 32-bit
      // words), because the scale silence arm's bar cannot be expressed in one:
      // a ~100-path walk saturates a 32-bit mask at the moment the block fires.
      probeBits: 0, probeBitsHi: 0, signatureBits: 0, signatureBitsHi: 0,
      signatureHits: 0, probeSample: [],
      windowStart: now, blockedUntil: carry, thresholdKind: kind,
    };
    _scannerIpRep.set(ip, rec);
  }
  rec.count4xx++;
  const bucket = classifyHit(hit);
  if (bucket === "routed") rec.routed4xx++;
  else if (bucket === "probe") {
    rec.probe4xx++;
    const p = hit.path || "";
    [rec.probeBits, rec.probeBitsHi] = addPathBit(rec.probeBits, rec.probeBitsHi, p);
    if (isProbeSignature(p)) {
      rec.signatureHits++;
      [rec.signatureBits, rec.signatureBitsHi] = addPathBit(rec.signatureBits, rec.signatureBitsHi, p);
    }
    if (rec.probeSample.length < PROBE_SAMPLE_MAX) rec.probeSample.push(p);
  } else rec.other4xx++;

  // Two triggers. The ordinary one is unchanged and still catches everything;
  // the probe one only ever fires for traffic that would ALSO have been
  // silenced, so nothing that would have alerted is blocked sooner than before.
  const standardDue = rec.count4xx >= _SCANNER_4XX_THRESHOLD;
  const earlyDue = !standardDue && probeEarlyBlockDue(rec, PROBE_EARLY_THRESHOLD);
  if ((standardDue || earlyDue) && !rec.blockedUntil) {
    rec.blockedUntil = now + _SCANNER_BLOCK_MS;
    rec.thresholdKind = earlyDue ? "probe_early" : "standard";
    const verdict = classifyScannerTraffic(rec);
    _scannerBlockStats[verdict.verdict] = (_scannerBlockStats[verdict.verdict] || 0) + 1;
    if (verdict.silent) _scannerSilentBlocks++;
    // v7.16.0 — an IP ban during a live competition is very likely the venue's
    // NAT address, and the failure is otherwise SILENT: a room full of people
    // locked out, and nothing in the admin UI saying why. Raise an operator
    // alert here, at block creation, so it fires exactly once per block rather
    // than on every subsequent refused request.
    //
    // v7.25.0 — but ONLY when the traffic could plausibly be that room. This
    // one call is the entire gate; everything below it runs for both verdicts.
    if (!verdict.silent) {
      try { _raiseIpBanAlert(ip, rec, verdict); } catch (_err) { /* never break the tracker */ swallowed("server:ip-ban-alert", _err); }
    }
    const _cls = {
      verdict: verdict.verdict,
      silent: verdict.silent,
      threshold_kind: rec.thresholdKind,
      probe_4xx: verdict.probe_4xx,
      routed_4xx: verdict.routed_4xx,
      other_4xx: verdict.other_4xx,
      probe_distinct_paths: verdict.probe_distinct_paths,
      probe_distinct_saturated: verdict.probe_distinct_saturated,
      // v8.3.20 — WHICH silence arm decided, so a silent block says why it was
      // silent rather than only that it was.
      silence_basis: verdict.silence_basis,
      signature_hits: verdict.signature_hits,
      signature_distinct_paths: verdict.signature_distinct_paths,
      probe_ratio: verdict.probe_ratio,
      sample_paths: rec.probeSample.slice(0, PROBE_SAMPLE_MAX),
    };
    // Two-layer record:
    //   1. log.warn → visible in the Logs tab's Event-log stream as a
    //      warning row (useful for operators who sort by level).
    //   2. recordOrphanedAuditEvent("security", …) → mirrors to
    //      app.jsonl with source:"audit", so the event appears in any
    //      forensic audit-event query alongside password rotations,
    //      session invalidations, and other security-relevant rows.
    //      The ip is the scope_id so an investigator can filter the
    //      audit stream to one source address directly.
    try {
      log.warn({
        ip, count4xx: rec.count4xx,
        block_ms: _SCANNER_BLOCK_MS,
        window_ms: _SCANNER_WINDOW_MS,
        ..._cls,
      }, verdict.silent
        ? "Scanner detected — IP blocked (no alert raised: probe traffic)"
        : "Scanner detected — IP blocked");
    } catch (_err) { swallowed("server:best-effort", _err); }
    try {
      recordOrphanedAuditEvent("security", ip, "scanner_blocked", "system", {
        ip,
        count_4xx: rec.count4xx,
        window_ms: _SCANNER_WINDOW_MS,
        block_ms: _SCANNER_BLOCK_MS,
        blocked_until: new Date(rec.blockedUntil).toISOString(),
        // Deliberately the SAME event type for both verdicts. An investigator
        // filtering the audit stream for scanner blocks has to see all of them;
        // a separate `scanner_blocked_silent` would split the forensic record
        // in half along the one axis nobody would think to query.
        ..._cls,
      });
    } catch (_err) { swallowed("server:best-effort", _err); }
  }
  // Size cap: when the map overshoots, drop the single oldest entry. Keeps
  // worst-case memory bounded while an attacker cycles source IPs — the GC
  // interval below handles steady-state churn.
  if (_scannerIpRep.size > _SCANNER_MAX_ENTRIES) {
    let oldestIp = null, oldest = Infinity;
    for (const [k, v] of _scannerIpRep) {
      if (v.windowStart < oldest) { oldest = v.windowStart; oldestIp = k; }
    }
    if (oldestIp) _scannerIpRep.delete(oldestIp);
  }
}
function _scannerBlockedIpCount() {
  const now = Date.now();
  let n = 0;
  for (const r of _scannerIpRep.values()) if (r.blockedUntil && r.blockedUntil > now) n++;
  return n;
}
function _scannerBlockedUntil(ip) {
  const rec = _scannerIpRep.get(ip);
  if (!rec || !rec.blockedUntil) return 0;
  if (rec.blockedUntil <= Date.now()) { rec.blockedUntil = null; return 0; }
  return rec.blockedUntil;
}
// Periodic GC: drop entries whose window has fully elapsed AND which are no
// longer blocked. Runs every minute.
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of _scannerIpRep) {
    const windowDone = (now - r.windowStart) > _SCANNER_WINDOW_MS;
    const notBlocked = !r.blockedUntil || r.blockedUntil <= now;
    if (windowDone && notBlocked) _scannerIpRep.delete(ip);
  }
}, 60 * 1000).unref();
// ext-audit v7.20.9 (F6) — the tracker is SPLIT into COUNT (here) and BLOCK
// (after the session middleware, see `_scannerBlockMiddleware`).
//
// Counting has to stay this early, ahead of the HTML/CSS/JS caches and
// `express.static`, so it still sees responses those terminate — a scanner
// walking `/wp-admin`, `/.env`, `/phpmyadmin` produces static 404s and that is
// the signal the tracker was built on.
//
// Blocking moved because it was IP-wide and ran before sessions, so it refused
// the admin panel to a signed-in admin who happened to share the blocked
// address — which at a hackathon is the normal case, not an edge one: the
// organiser is in the room, on the room's NAT. The remedy the alert instructs
// them to apply (add the venue to the competition's trusted networks) lives
// behind exactly the routes the block was denying them.
app.use((req, res, next) => {
  if (!_testScannerForceEnabled && (process.env.RATE_LIMIT_DISABLED === "1" || process.env.RATE_LIMIT_DISABLED === "true")) return next();
  const ip = req.ip || "unknown";
  // audit v7.7.28 (M1) — RATE_LIMIT_ALLOWLIST_IPS bypasses ALL rate limiters
  // (CLAUDE.md env table + CTF-0026 intent). The scanner-reputation tracker is
  // IP-keyed and 429s the WHOLE address, so a large legit cohort behind one
  // allowlisted venue/CGNAT egress IP would otherwise trip the 100-4xx block
  // (mistyped passwords, expired-session 401 polls, CSRF 403s all aggregate on
  // that IP). Skip both the block check AND the 4xx counting for an allowlisted
  // IP — same bypass rateLimit() already applies.
  if (_rateLimitAllowlisted(ip)) return next();
  // v7.25.0 — capture the path HERE, in the middleware body, not in the
// v8.3.13 — see the call site. "Am I signed in?", asked by a client that does
// not yet know, answered 401. Not abuse, and not a signal of it.
const _IDENTITY_PROBE_PATHS = new Set(["/api/me", "/api/admin/me"]);
function _isIdentityProbe401(req, res) {
  if (res.statusCode !== 401) return false;
  if (String(req.method || "").toUpperCase() !== "GET") return false;
  if (!_IDENTITY_PROBE_PATHS.has(normaliseRoutePath(req.path || ""))) return false;
  // A 401 to a session that DOES carry an identity means something went wrong
  // and stays countable.
  return !_sessionHasIdentity(req.session);
}

// A browser whose session ENDED (an idle expiry, a restart's new session secret,
// a sign-out elsewhere) still presents that session's cookie, and its next poll
// is refused 401, its keepalive 403 `csrf_invalid`. That is the browser finding
// out, not abuse; counted, a classroom whose sessions end together over a long
// break or a restart blocks its own address (operator ruling, 17 Nov 2026).
// Recognised by the cookie naming a session this request did not run in: the
// server no longer holds it, so express-session started a new one. Only a GET's
// 401 and a CSRF refusal, and only while the session carries no identity. A
// caller can claim it with any cookie, which buys nothing: an anonymous GET's
// 401 opens nothing, and the probe counters (unrouted 404s) are unchanged.
function _isStaleSessionRefusal(req, res) {
  const s = res.statusCode;
  if (!((s === 401 && String(req.method || "").toUpperCase() === "GET") || (s === 403 && req._csrfRefused))) return false;
  const old = _extractOldSessionId(req);
  return !!old && old !== req.sessionID && !_sessionHasIdentity(req.session);
}

  // closure. `app.use("/docs", …)` rewrites req.url for its sub-stack, and
  // res.on("finish") can fire at an arbitrary stack state; a const taken at
  // entry cannot be wrong. `req.path` is the query-stripped, normalised
  // pathname, which is also the right distinct-path key — `originalUrl` would
  // let one probed path become unbounded "distinct" paths via query variation.
  //
  // Scrub AT INGEST, before the value is stored anywhere. This is required
  // today, not defensive: the SPA-shell middleware only serves GET/HEAD, so
  // `POST /join/<token>` falls through to an unrouted 404 and would otherwise
  // put a live 256-bit self-enroll secret into an audit event and app.jsonl.
  // flattenPath then forces a real copy — a bare slice retains its parent
  // string, and req.path is itself a view onto a request line Node accepts up
  // to ~16 KB.
  const hitPath = flattenPath(_scrubLogPath(req.path), PROBE_SAMPLE_PATH_MAX);
  res.on("finish", () => {
    // Only client-side failures — 5xx is a server bug, not abuse. Don't
    // count 429s we emit ourselves either, or a blocked IP would keep
    // pushing its own counter higher and prolong its block indefinitely.
    // v8.8.25 — 413 IS EXCLUDED, FOR THE SAME REASON 429 IS: it is a size answer
    // about ONE request, not evidence about a caller. v7.21.24 measured the
    // cascade — 100 oversized uploads from one address lock the WHOLE address out
    // of the API for fifteen minutes — and the ordinary way to produce one is
    // somebody sending a photograph straight off a camera roll (a profile picture,
    // an answer file) or a sign-up over its 16 KB cap. Behind a venue NAT that is
    // a room of people, which is exactly the population the tracker must not block. A
    // scanner is characterised by walking PATHS, which is what the probe counters
    // measure; nothing about a large body says anything, and a scanner that wanted
    // to could spend the budget far more cheaply with 404s.
    if (res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 429 && res.statusCode !== 413) {
      // v8.3.13 — THE PLATFORM'S OWN BOOT MUST NOT SPEND THE ABUSE BUDGET.
      //
      // `boot()` asks "am I signed in?" on EVERY page load: `GET /api/me`, and
      // if that is refused, `GET /api/admin/me`. For a visitor who is simply not
      // signed in, BOTH answer 401 — and both were counted. So an anonymous page
      // load cost TWO of the 100-in-10-minutes budget, and roughly fifty
      // arrivals from one address blocked the WHOLE address for fifteen minutes.
      // Behind a venue NAT that is a room of people opening the link, which is
      // the platform's most ordinary moment, and the block then 429s
      // `/api/csrf-token` — so it surfaced as `csrf_invalid` at the login card,
      // naming the wrong subsystem entirely.
      //
      // A 401 here is not a REFUSAL, it is the ANSWER: these two endpoints exist
      // to be asked, by a client that does not yet know. Nothing is opened up —
      // an anonymous caller learns nothing from either, and both were already
      // free to call as often as they liked; all that changes is that asking the
      // question no longer counts as abuse. Deliberately narrow: GET only, 401
      // only, and only while the session carries no identity. (A session that
      // died is _isStaleSessionRefusal's.)
      if (!_isIdentityProbe401(req, res) && !_isStaleSessionRefusal(req, res)) {
        // `req.route` is only populated once a handler matches, so it must be
        // read here rather than at entry. Reading it at finish is already
        // production-proven in this file — see _routeKey().
        _scannerRecord(ip, { path: hitPath, routed: !!req.route, status: res.statusCode });
      }
    }
  });
  next();
});

// The BLOCK half. Mounted immediately after `session(...)` so it can read
// `req.session` — see the note on the COUNT half above.
function _scannerBlockMiddleware(req, res, next) {
  if (!_testScannerForceEnabled && (process.env.RATE_LIMIT_DISABLED === "1" || process.env.RATE_LIMIT_DISABLED === "true")) return next();
  // v7.25.0 — the test-only routes are mounted AFTER this middleware and carry
  // no auth, so once a spec has deliberately blocked 127.0.0.1 the endpoint
  // that clears the block is itself refused: the afterEach fails, the block
  // stands for 15 minutes, and every later test in the file dies with a bare
  // 429 naming nothing. That is the v7.16.8 cross-spec failure exactly, so the
  // escape hatch is unblockable — under NODE_ENV=test only.
  if (process.env.NODE_ENV === "test" && req.path.startsWith("/api/test/")) return next();
  const ip = req.ip || "unknown";
  if (_rateLimitAllowlisted(ip)) return next();
  // Test the block FIRST: on the overwhelmingly common path (nothing blocked)
  // this is one Map lookup and we are done, and the admin check below — which
  // can touch the DB — only ever runs for an address that is actually refused.
  const blockedUntil = _scannerBlockedUntil(ip);
  if (!blockedUntil) return next();
  if (_scannerBlockExempt(req)) return next();
  const retryAfter = Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000));
  res.set("Retry-After", String(retryAfter));
  // `code` lets a browser tell the block from a rate limiter: it then sends nothing
  // until Retry-After, and asks the session check first (public/js/core/api.js).
  return res.status(429).json({ error: "Too many invalid requests from this address. Try again later.", code: "address_blocked" });
}
// Is this request's session an ADMIN's, and therefore exempt from the block?
//
// Not a soft check: it requires a cookie-signed session, which an attacker
// cannot forge and which anyone holding is already past every other gate. The
// per-route rateLimit() limiters are untouched, so an admin session is not a
// channel for unlimited requests — it only restores the operator's ability to
// reach the control that lifts the block.
//
// The session FLAGS are not sufficient on their own: `POST /api/toggle-admin-
// view` clears `isAdmin` to render the participant chrome, so an admin who was
// looking at the participant view when the room got blocked would be refused —
// including on the very request that would toggle them back, which is the one
// state with no way out at all. So a user-backed session falls back to reading
// the role. That read only happens for an address that is already blocked.
//
// v8.7.3 — `event_admin` IS an admin tier here, and omitting it put exactly the
// tier this exemption was written for into the state the paragraph above calls
// "the one state with no way out at all". The scanner block is GLOBAL (it
// precedes every route, the SPA shell included), so a scanner-blocked venue NAT
// — the v7.15.34 / v7.16.0 cascade this exists for — locked an event admin out
// of the API, the page and the reload alike, for the full fifteen minutes,
// while a REGULAR admin beside them on the same address was exempt. An event
// organiser standing in the room on the venue's Wi-Fi is the likeliest person
// on the platform to meet it.
//
// One Set, read by BOTH branches, because they had already drifted from
// `lib/impersonation.js`'s acting-admin re-read, which enumerates all three.
// RBAC — the admin tiers are every role whose class is not `none` (the three
// built-in ones and every custom admin role); an unknown role key is `none`.
const _ADMIN_TIER_ROLES = { has: (role) => require("./lib/rbac").roleClass(role) !== "none" };
function _scannerBlockExempt(req) {
  const s = req.session;
  if (!s) return false;
  // v8.12.1 — THE IMPERSONATION BRANCH IS ASKED FIRST. An impersonation session
  // can be ADMIN-SHAPED now (an event admin's panel opened through their seat
  // sets `isAdmin`), so the flag shortcut below would have exempted such a
  // session on the TARGET's standing and skipped the acting-admin re-read that
  // v7.21.12 put here — the frozen-snapshot defect back through a new door.
  const _impId = s.impersonator && s.impersonator.userId;
  if (s.impersonator && !_impId && s.impersonator.builtinId === "superadmin") return true;
  if (_impId) {
    try {
      const impRow = db.prepare("SELECT role, blocked, denied_at FROM users WHERE id=?").get(_impId);
      return !!impRow && !impRow.blocked && !impRow.denied_at
        && _ADMIN_TIER_ROLES.has(impRow.role);
    } catch (_) { return false; }
  }
  if (s.isAdmin || s.isSuperAdmin || s.builtinId) return true;
  // An impersonation session belongs to the admin, not the target (its surface
  // userId is the participant's), so exempt on the impersonator's own role.
  //
  // v7.21.12 — read that role from the DATABASE, not from the entry snapshot.
  // `s.impersonator.userRole` is frozen at the moment impersonation began, so a
  // demoted or blocked ex-admin kept a scanner-ban exemption for the life of the
  // session — while the non-impersonating branch below has always hit the DB
  // for exactly this reason. This only ever runs for an address that is
  // already blocked, so the extra lookup is off the common path. (The lookup
  // itself sits ABOVE the flag shortcut since v8.12.1 — see the top.)
  if (!s.userId) return false;
  try {
    const row = db.prepare("SELECT role FROM users WHERE id=?").get(s.userId);
    return !!row && _ADMIN_TIER_ROLES.has(row.role);
  } catch (_) { return false; }
}

// HSTS is opt-out rather than opt-in: the common deployment is HTTPS-only, so
// defaulting the header on keeps existing deployments protected. Operators on
// plain HTTP or mixed setups can turn it off with HSTS=0 (also accepts "false"
// / "off"). The header itself is defined once so hot-path cost stays a simple
// setHeader call.
const _HSTS_ENABLED = !["0", "false", "off", "no"].includes(String(process.env.HSTS || "").trim().toLowerCase());
app.use((req, res, next) => {
  // v6.16.28 — broaden Permissions-Policy so the platform proactively
  // disables every sensor / device-API the SPA does not use. Each
  // `feature=()` line denies origin + every embedded frame access to
  // that capability. Defence-in-depth against (a) compromised
  // third-party scripts that try to access camera / microphone /
  // geolocation, (b) future feature creep where someone forgets to
  // explicitly opt out. `interest-cohort=()` opts the platform out of
  // the FLoC / Topics behaviour-cohort signal.
  res.setHeader("Permissions-Policy",
    "accelerometer=(), " +
    "ambient-light-sensor=(), " +
    "autoplay=(), " +
    "battery=(), " +
    "camera=(), " +
    "display-capture=(), " +
    "document-domain=(), " +
    "encrypted-media=(), " +
    "fullscreen=(self), " +
    "geolocation=(), " +
    "gyroscope=(), " +
    "interest-cohort=(), " +
    "magnetometer=(), " +
    "microphone=(), " +
    "midi=(), " +
    "payment=(), " +
    "picture-in-picture=(), " +
    "publickey-credentials-get=(), " +
    "screen-wake-lock=(), " +
    "sync-xhr=(), " +
    "usb=(), " +
    "web-share=(), " +
    "xr-spatial-tracking=()");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (_HSTS_ENABLED) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  // v6.16.34 — cross-origin isolation headers. Each is defence-in-
  // depth on top of the existing CSP/Trusted Types stack.
  //
  //   Cross-Origin-Opener-Policy: same-origin
  //     If a victim opens a malicious tab via window.open, the
  //     malicious tab cannot access window.opener back into our
  //     origin. Mitigates Spectre-style cross-origin probing AND
  //     the older window.opener tab-nabbing class of attacks.
  //
  //   Cross-Origin-Resource-Policy: same-origin
  //     Tells browsers not to let cross-origin documents embed our
  //     resources (no <img src="our-server/avatar.png" /> from
  //     attacker.com). Same-origin is the strict default; nothing
  //     about the platform legitimately wants cross-site embed.
  //
  //   Origin-Agent-Cluster: ?1
  //     Site-isolation hint — asks the browser to put this origin
  //     in its own renderer process. Prevents same-site-but-cross-
  //     origin pages (subdomains) from sharing memory in case of
  //     a future Spectre-class vulnerability.
  //
  // NOT enabling Cross-Origin-Embedder-Policy because `require-corp`
  // would require every cross-origin resource (Google Fonts, cdnjs)
  // to ship matching `Cross-Origin-Resource-Policy: cross-origin`
  // headers, which we don't control. The marginal SharedArrayBuffer
  // / high-resolution-timer enablement isn't worth coupling our
  // ability to ship to upstream CDN config.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Origin-Agent-Cluster", "?1");
  // X-XSS-Protection is a retired IE/old-Chrome header; modern browsers ignore it
  // and some older values actively enable XSS exploit paths. Removed entirely.
  //
  // CSP additions vs the previous policy:
  //   • base-uri 'self'        — blocks <base href="evil.com"> redirection attacks
  //   • form-action 'self'     — blocks injected <form action=evil> credential theft
  //   • require-trusted-types-for 'script' + trusted-types app-html default
  //                            — enforces Trusted Types. The client registers a
  //                              passthrough 'default' policy (ECharts writes
  //                              innerHTML itself), which also admits every direct
  //                              innerHTML write in app code; setSafeHtml() uses the
  //                              'app-html' policy. Neither policy sanitises (see
  //                              the trusted-types directive below).
  //   • report-uri /api/csp-report — CSP violations stream to the app log so
  //                              real-world XSS attempts are visible.
  //   • connect-src is now 'self' only. v6.20.x self-hosted the fonts
  //     (public/fonts.css → /vendor/fonts/*.woff2), so the previous
  //     fonts.googleapis.com / fonts.gstatic.com grants (+ their preconnect
  //     attribution workaround, v6.10.22 / v6.10.52) were removed. font-src is
  //     'self'. v7.7.19 — highlight.js (CSS + JS) is now self-hosted under
  //     /vendor/highlight/, so cdnjs was dropped too: the CSP has NO third-party
  //     origin at all — script-src/style-src* are 'self' only (object-src 'none',
  //     base-uri/form-action 'self'). Nothing loads cross-origin.
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; " +
    // 'unsafe-inline' REMOVED from script-src in v5.0.0 — every onclick="…" in
    // the SPA is now an addEventListener-style data-action dispatched from a
    // single document-level listener (public/js/core/main.js). Injected HTML can
    // no longer execute JavaScript via inline event-handler attributes.
    "script-src 'self'; " +
    // style-src is split into two narrower directives in v5.2.0:
    //   • style-src-elem  — controls <style> blocks and <link rel=stylesheet>.
    //     'unsafe-inline' is REMOVED; an injected <style> block (defence-in-
    //     depth on top of the server sanitizer's tag whitelist) cannot apply
    //     CSS now. The application's own CSS lives in /styles.css (v5.2.0
    //     extracted the previously-inline <style> block out of index.html).
    //   • style-src-attr  — controls inline style="…" attributes only.
    //     'unsafe-inline' is RETAINED here because the SPA still uses ~650
    //     inline style attributes in template strings and ~hundreds of
    //     el.style.x = … DOM mutations. CSS-attribute injection is much
    //     lower-impact than <style>-block injection (no attribute selectors
    //     for keystroke logging) and the main exfiltration vector
    //     (background-image: url(attacker.com)) is already blocked by the
    //     img-src 'self' data: directive below.
    // The legacy style-src directive is kept as a fallback for the very few
    // user agents that don't yet honour style-src-elem / style-src-attr
    // (those browsers still get the original permissive behaviour).
    // v6.20.x — fonts self-hosted (see public/fonts.css), so the Google Fonts
    // origins were dropped from style-src*/font-src/connect-src. v7.7.19 —
    // highlight.js self-hosted (/vendor/highlight/), so cdnjs was dropped too:
    // style-src* + script-src are now 'self' only, no third-party origin remains.
    "style-src-elem 'self'; " +
    "style-src-attr 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "font-src 'self'; " +
    "connect-src 'self'; " +
    "object-src 'none'; " + // v7.2.x (audit) — explicit; don't inherit <object>/<embed> from default-src 'self'
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    // Trusted Types ENFORCED. Three policies are allowed (vendor-script-src is
    // described below):
    //   • app-html — used by setSafeHtml() for SPA-controlled DOM writes (and by
    //                the help page's own mirror, public/help.js). A pure
    //                passthrough too, so it sanitises nothing. A direct
    //                assignment does NOT throw, because the default policy
    //                admits it, so the routing is held elsewhere: under
    //                public/js, HTML is written only through setSafeHtml (the
    //                raw-write scan in tests/html-sink-escape.spec.js); in the
    //                classic scripts outside the module graph (public/help.js),
    //                by review. The same spec's escape scan holds that every
    //                value reaching a public/js sink is escaped, provably inert
    //                or a reviewed exception on its ALLOW list.
    //   • default  — passthrough policy created in
    //                public/js/core/trusted-types.js, accepted as the
    //                global fallback for vendor libraries (ECharts) that
    //                internally call element.innerHTML for tooltip /
    //                hidden-DOM scaffolding. The default policy was removed
    //                in v5.1.0 and re-added in v5.7.0 specifically because
    //                ECharts (Apache, self-hosted at /vendor/echarts.min.js)
    //                cannot be reached by code that adopts a NAMED policy.
    //                The policy itself is a pure passthrough — its purpose
    //                is satisfying the TT requirement, not sanitisation — and
    //                it admits EVERY innerHTML write in the page, not only
    //                ECharts'; only its createScript / createScriptURL throw.
    //                The XSS defence for HTML is escaping at the call site
    //                (esc()) under script-src 'self'; a browser without Trusted
    //                Types runs no policy at all.
    "require-trusted-types-for 'script'; " +
    // v6.10.36 — added `vendor-script-src`: a named policy with a strict
    // URL allowlist (v6.21.0: /vendor/echarts.min.js + /vendor/qrcode.min.js)
    // that the lazy loaders (`loadEchartsOnDemand` in features/analytics-admin.js,
    // `_ensureQrLib` in features/self-enroll.js) use to set <script>.src at
    // runtime. The default policy still throws on createScriptURL so stray
    // assignments fail closed; the
    // vendor policy selectively permits those static paths.
    "trusted-types app-html vendor-script-src default; " +
    // v6.16.34 — `upgrade-insecure-requests` forces any subresource
    // URL declared as `http://` (in user-injected HTML, e.g. a
    // pasted-in challenge description with an http:// image link)
    // to be fetched over https://. Defence-in-depth: the platform's
    // own templates already use https://, but a sanitiser bypass
    // that smuggled an http:// img-src would still upgrade.
    //
    // v6.16.35 — gated on `BASE_URL` starting with `https://`. The
    // W3C spec says clients SHOULD treat localhost / 127.0.0.1 as
    // exempt from the upgrade (they're "potentially trustworthy
    // origins" — RFC 8164), but this is a SHOULD not a MUST and
    // WebKit's implementation upgrades regardless on at least
    // some versions. Skipping the directive on plain-http BASE_URL
    // protects WebKit-driven test runs (CI cross-browser job) and
    // any HTTP-only dev deploy. The directive ships unchanged on
    // every HTTPS production deploy.
    (BASE_URL.startsWith("https://") ? "upgrade-insecure-requests; " : "") +
    "report-uri /api/csp-report");
  next();
});

// CSP violation reports land here. Browsers POST a small JSON document describing
// which directive was violated, the blocked URL, the source file and line. We log
// at warn level so the admin log-viewer surfaces real-world XSS attempts without
// operators having to tail a separate stream.
//
// Rate-limited (v6.2.6) because the endpoint is unauthenticated by design (the
// browser fires reports before any session) and an attacker could otherwise
// flood the JSONL log file by POST'ing arrays of fake violations until the
// rotation-cap (500 MB/file) burns disk and drowns out real events. 30
// reports/min/IP is generous for a real browser hitting a malformed page —
// the entry-cap below additionally bounds a single batched report.
//
// rateLimit is deferred via the arrow wrapper because this app.post() runs at
// module-load time, and rateLimit's body reads `RATE_LIMIT_DISABLED` (a `const`
// declared further down the file). The `function` declaration is hoisted but
// its body would TDZ-fail if invoked here at registration. Per-request
// invocation runs after full module load.
// v8.3.14 — A CSP REPORT ATTRIBUTED TO A BROWSER EXTENSION IS NOT OUR VIOLATION.
//
// Reported from production: the log filling with `style-src-elem` /
// `blocked_uri: "inline"` reports whose `source_file` is
// `safari-web-extension://…`. That is an extension injecting a `<style>` into
// the page — a password manager, a dark-mode or translation add-on, Grammarly —
// running in the visitor's browser, in the visitor's own profile. The policy is
// doing exactly its job by refusing it, and there is nothing on this side to fix:
// the app ships NO inline `<style>` at all (no `<style>` in any shipped HTML, and
// no JS that creates one), so `style-src-elem 'inline'` cannot originate here.
//
// DO NOT "FIX" THIS BY RELAXING THE POLICY. Adding `'unsafe-inline'` to
// `style-src-elem` would re-open a real XSS sink for the whole site so that a
// third party's add-on can stop generating reports. The report is the noise, not
// the policy.
//
// WHAT IS ACTUALLY BROKEN IS THE SIGNAL-TO-NOISE. Every report was logged at
// WARN, so extension traffic — which scales with visitors, not with defects —
// buries the reports that ARE ours. That is the failure this file keeps naming in
// other forms (v7.25.0: a detector that cries wolf is not conservative, it is
// broken).
//
// So an extension-attributed report drops to DEBUG rather than being discarded:
// below the default `LOG_LEVEL` so it costs nothing, and recoverable in full by
// lowering it, which matters the day someone needs to prove a report really was a
// third party's. Both classes are counted on `/metrics`, so the volume stays
// visible even while the lines do not — a filter with no counter is the invisible
// half of this same problem.
//
// The scheme list is by PREFIX and covers every engine's extension origin.
// `webkit-masked-url:` is Safari's placeholder for an injected source it declines
// to name, which is the same situation with the URL withheld.
const _EXTENSION_URL_SCHEMES = [
  "chrome-extension:", "moz-extension:", "safari-web-extension:",
  "safari-extension:", "ms-browser-extension:", "webkit-masked-url:",
];
function _cspFromBrowserExtension(sourceFile, blockedUri) {
  // Either field can carry it: the violating CODE is usually named by
  // `source_file`, but an extension loading its own asset shows up as a
  // `blocked_uri` instead.
  return [sourceFile, blockedUri].some(v =>
    typeof v === "string" && _EXTENSION_URL_SCHEMES.some(p => v.toLowerCase().startsWith(p)));
}
const _cspReportCounts = { app: 0, extension: 0 };

app.post("/api/csp-report", (req, res, next) => rateLimit(60_000, 30, "csp-report")(req, res, next), express.json({ limit: "64kb", type: ["application/csp-report", "application/json", "application/reports+json"] }), (req, res) => {
  try {
    // Firefox and classic Chromium use { "csp-report": {...} }; newer Reporting API
    // uses an array of { type: "csp-violation", body: {...} }. Flatten both shapes.
    // Cap entries-per-payload so a single 64 KB POST can't expand into hundreds
    // of log lines.
    const payload = (Array.isArray(req.body) ? req.body : [req.body]).slice(0, 20);
    for (const entry of payload) {
      const report = entry?.["csp-report"] || entry?.body || entry;
      if (!report) continue;
      const sourceFile = report["source-file"] || report.sourceFile || null;
      const blockedUri = report["blocked-uri"] || report.blockedURL || null;
      // Attribution reads the RAW values (the scrub below never alters a scheme
      // prefix, so this is belt-and-braces rather than load-bearing).
      const fromExtension = _cspFromBrowserExtension(sourceFile, blockedUri);
      // v8.13.3 — THE THREE BROWSER-REPORTED URLS ARE SCRUBBED BEFORE THEY ARE
      // LOGGED. A CSP report carries the reporting page's URL with its QUERY STRING
      // (the spec drops only the fragment and userinfo), and several pages hold a
      // live capability there for their whole life: /register?invitation=<id>,
      // /join/<token> until boot's replaceState, /credential?code=. A violation on
      // such a page that is not an extension's — an HTTPS-inspecting proxy or
      // antivirus injecting inline script is the realistic one — wrote the capability into app.jsonl at warn,
      // which every REGULAR admin reads through Logs and `scripts/backup.sh` copies.
      // The same `_scrubLogPath` the access logger uses: its rules are unanchored
      // substrings, so an absolute URL scrubs exactly as a path does, and a null or
      // a non-string (a forged report) passes through untouched.
      const fields = {
        csp_directive: report["violated-directive"] || report.effectiveDirective || null,
        blocked_uri: _scrubLogPath(blockedUri),
        document_uri: _scrubLogPath(report["document-uri"] || report.documentURL || null),
        source_file: _scrubLogPath(sourceFile),
        line_number: report["line-number"] || report.lineNumber || null,
        column_number: report["column-number"] || report.columnNumber || null,
        original_policy: (report["original-policy"] || report.originalPolicy || "").slice(0, 300),
        ip: req.ip, user_agent: (req.headers["user-agent"] || "").slice(0, 300),
      };
      if (fromExtension) {
        _cspReportCounts.extension++;
        // DEBUG, not discarded: invisible at the default LOG_LEVEL, and fully
        // recoverable by lowering it. See the note above the scheme list.
        log.debug({ ...fields, attributed_to: "browser_extension" }, "CSP violation (browser extension)");
      } else {
        _cspReportCounts.app++;
        log.warn(fields, "CSP violation");
      }
    }
  } catch (_err) { /* best-effort — never fail a report ingest */ swallowed("server:csp-report", _err); }
  // Browsers ignore the response body; 204 keeps the log clean.
  res.status(204).end();
});
// DYNAMIC BODIES UNDER 8 KB GO OUT AS THEY ARE. A gzip or brotli
// stream per response (created, fed, flushed, destroyed) was the largest
// app-controllable self-time in the 1000-user storm profile (perf/RESULTS.md),
// and almost all of it was spent on the polls, whose bodies are 1-3 KB: the
// zlib set-up costs more main-thread time than the bytes it saves cost the
// network. Bodies of 8 KB and more (admin lists, exports) are still compressed;
// the frozen shell, stylesheet and bundle are pre-compressed once at their own
// 1 KB threshold (_assetEntry) and never reach this stream.
const COMPRESS_THRESHOLD_BYTES = 8 * 1024;
app.use(compression({ threshold: COMPRESS_THRESHOLD_BYTES }));
// Whether the HANDLER finished its response, for the error handler's
// headersSent guard. res.writableEnded cannot say: for a body of
// COMPRESS_THRESHOLD_BYTES (8 KB) or more to a gzip/br client, compression()'s
// res.end only ends its zlib stream, and the
// real end runs a threadpool callback later, so a fault raised straight after
// the send arrives with the response complete but not yet ended. Mounted
// directly after compression() so this wraps compression's end; set only once
// that end returns, so an end that throws leaves the response partial.
app.use(function _markEndCalled(req, res, next) {
  const end = res.end;
  res.end = function (...args) { const r = end.apply(this, args); res.locals._endCalled = true; return r; };
  next();
});

// v6.8.5 — lightweight metrics collection. Per-request we bump a global
// counter bucketed by status-family (2xx/4xx/5xx) and maintain a 1-s
// rolling latency sample (reservoir of the last 1024 observations). The
// /metrics endpoint below serves this in Prometheus text-exposition format
// so an operator can answer "current p95 latency" / "error rate" without
// hand-parsing logs. Counters are intentionally simple (not per-route) so
// the middleware cost is ~100 ns/request and doesn't perturb timings.
//
// v6.12.13 — per-route latency reservoir added alongside the top-level
// 1024-sample one. The watch-metrics CSV observed p95 creep 3→18 ms
// over an 85-min sustained run with p50 flat at ~1.2 ms — smells like
// a slow tail on one or two endpoints buried inside the global
// aggregate. Per-route buckets (keyed on Express's matched route
// pattern, e.g. "GET /api/tasks/:id") attribute the tail by endpoint
// so the next run's CSV can pinpoint which handler is drifting. 128
// samples per route is plenty for p95 at any realistic cadence (hot
// routes churn it every few seconds; rare routes hold their small
// total-sample set until the run ends). Map capped at 128 distinct
// routes with FIFO eviction so an unbounded-URL attack can't grow
// the map.
//
// PERF_SPAN_SLOW_MS (env) controls the threshold at which the four
// instrumented handlers emit `[perf-span] slow <route>` log lines.
// Default 300 ms matches v6.10.89's "quiet tripwire" posture; set to
// e.g. 20 for a temporary diagnostic run where we want to localise a
// sub-100-ms p95 tail by route.
const _metrics = {
  requests: { total: 0, s2xx: 0, s4xx: 0, s5xx: 0 },
  latencies: new Float32Array(1024),
  latencyIdx: 0,
  latencyFilled: 0,
  rateLimited429: 0,
};
const _perRouteMetrics = new Map();
const _PER_ROUTE_CAP = 128;
const _PER_ROUTE_RESERVOIR = 128;
function _routeKey(req) {
  // req.route is populated by Express once a handler matches. For
  // unmatched paths (404 static-fallback, maintenance middleware
  // response) we bucket by method alone to avoid unbounded cardinality
  // from arbitrary URLs.
  if (req.route && typeof req.route.path === "string") {
    return `${req.method} ${req.route.path}`;
  }
  return `${req.method} (unmatched)`;
}
function _recordPerRouteLatency(req, ms) {
  const key = _routeKey(req);
  let bucket = _perRouteMetrics.get(key);
  if (!bucket) {
    if (_perRouteMetrics.size >= _PER_ROUTE_CAP) {
      // Map preserves insertion order; evict the oldest entry to cap
      // memory under a route-set explosion. In practice the app has
      // ~50-60 distinct routes total so this path almost never fires.
      const firstKey = _perRouteMetrics.keys().next().value;
      _perRouteMetrics.delete(firstKey);
    }
    bucket = {
      samples: new Float32Array(_PER_ROUTE_RESERVOIR),
      idx: 0,
      filled: 0,
      count: 0,
    };
    _perRouteMetrics.set(key, bucket);
  }
  bucket.count++;
  bucket.samples[bucket.idx] = ms;
  bucket.idx = (bucket.idx + 1) % bucket.samples.length;
  if (bucket.filled < bucket.samples.length) bucket.filled++;
}
function _perRoutePercentile(bucket, p) {
  if (bucket.filled === 0) return 0;
  const slice = Array.from(bucket.samples.slice(0, bucket.filled)).sort((a, b) => a - b);
  const idx = Math.min(slice.length - 1, Math.floor(slice.length * p));
  return Number(slice[idx].toFixed(2));
}
// v7.21.23 — cumulative event-loop BLOCKED time, in milliseconds.
//
// This exists because of the one way v7.21.22 could hide a real problem. The
// server cannot read a socket while its loop is blocked, so a synchronous stall
// — a long better-sqlite3 statement, a resvg rasterise, a bcrypt that slipped
// off the threadpool — delays the body's 'end' event exactly as a weak network
// does, and would be excused as "the participant was slow". In a
// single-process server that is the most important failure mode there is, so it
// must not be the one the split silently absorbs.
//
// A drift counter measures it directly: a timer that should fire every
// `_LOOP_SAMPLE_MS` and fires later was, by definition, unable to run. Cheap
// (20 Hz, unref'd, three numbers) and it under-reports only stalls shorter than
// the sample period, which are far below any threshold that matters here.
const _LOOP_SAMPLE_MS = 50;
let _loopBlockedMs = 0;
let _loopLastTick = process.hrtime.bigint();
setInterval(() => {
  const now = process.hrtime.bigint();
  _loopBlockedMs += Math.max(0, Number(now - _loopLastTick) / 1e6 - _LOOP_SAMPLE_MS);
  _loopLastTick = now;
}, _LOOP_SAMPLE_MS).unref();
// Read the counter INCLUDING a stall currently in progress. Without this the
// reader would depend on whether the timers phase happened to run before the
// poll phase that delivered the body — i.e. on libuv ordering rather than on
// what actually happened.
function _loopBlockedNow() {
  const drift = Number(process.hrtime.bigint() - _loopLastTick) / 1e6 - _LOOP_SAMPLE_MS;
  return _loopBlockedMs + Math.max(0, drift);
}

// v7.21.22 — split a request's wall-clock into the part the SERVER is
// responsible for and the part it spent waiting for the client's body.
//
// `slow` is decided on the server share alone. A participant on a weak
// connection is not a slow endpoint, and warning as though they were is how a
// genuinely useful signal gets trained into background noise during exactly the
// event it exists for.
//
// Only the SUBMIT span uses this, deliberately: it is the one instrumented route
// that takes a request body, and the other four are GETs with nothing to wait
// for (their 'end' never fires, so this would compute a no-op split). If one of
// them ever starts accepting a body, route it through here rather than
// re-deriving the arithmetic — that is how four copies of one formula came to
// exist in the first place.
function _perfSplit(req, tHandler, tFinish) {
  const preludeMs = req._perfT0 ? Number(tHandler - req._perfT0) / 1e6 : 0;
  const bodyMs = Number(tFinish - tHandler) / 1e6;
  const totalMs = preludeMs + bodyMs;
  // Time from headers to the last byte of the body. Unknown (null) when nothing
  // consumed the stream — for a body-less GET there is nothing to wait for.
  const clientBodyMs = (req._perfT0 && req._perfBodyEnd)
    ? Number(req._perfBodyEnd - req._perfT0) / 1e6 : null;
  // v7.21.23 — how much of that window the server spent unable to run. Time the
  // loop was blocked is the SERVER's, however much it looks like a slow client
  // from the socket's point of view, so only the remainder is excused.
  const loopBlockedMs = (req._perfBlocked0 != null && req._perfBlockedBodyEnd != null)
    ? Math.max(0, req._perfBlockedBodyEnd - req._perfBlocked0) : 0;
  const networkMs = clientBodyMs == null ? null : Math.max(0, clientBodyMs - loopBlockedMs);
  // Never let a clock quirk make the server share negative or exceed the total.
  const clamped = networkMs == null ? 0 : Math.max(0, Math.min(networkMs, totalMs));
  return {
    preludeMs, bodyMs, totalMs, clientBodyMs, loopBlockedMs,
    serverMs: totalMs - clamped,
    // What the middleware chain itself cost, once the waiting is taken out.
    middlewareMs: Math.max(0, preludeMs - clamped),
  };
}

app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  // v6.10.84 — expose the per-request start on req so downstream handlers
  // can compute `middleware prelude` timing (tHandlerEnter - req._perfT0).
  // The /api/status micro-timing diagnostic uses this to attribute slow
  // status polls to middleware vs handler body.
  req._perfT0 = start;
  // v7.21.22 — stamp when the CLIENT finished sending the body.
  //
  // `_perfT0` is taken when the request HEADERS arrive, so everything measured
  // from it up to handler entry includes the time the server spent waiting for
  // the rest of the request to turn up. On a venue Wi-Fi mid-competition that is
  // the dominant term, and it was being reported as `prelude_ms` — i.e. as
  // server middleware cost. A real line from a live event read total 1002.5 ms /
  // prelude 1000.9 ms while every server stage was under 2 ms; reproduced
  // exactly by flushing headers and holding the body back for one second.
  //
  // The stream's own 'end' is the honest boundary: it fires when the last byte
  // arrives, whoever ends up consuming it. If nothing reads the body (a GET the
  // parsers skip) it never fires, and the readers below treat that as "unknown"
  // rather than assuming zero.
  req._perfBlocked0 = _loopBlockedNow();
  req.once("end", () => {
    req._perfBodyEnd = process.hrtime.bigint();
    req._perfBlockedBodyEnd = _loopBlockedNow();
  });
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    _metrics.requests.total++;
    if (res.statusCode >= 500) _metrics.requests.s5xx++;
    else if (res.statusCode === 429) { _metrics.requests.s4xx++; _metrics.rateLimited429++; }
    else if (res.statusCode >= 400) _metrics.requests.s4xx++;
    else if (res.statusCode >= 200) _metrics.requests.s2xx++;
    _metrics.latencies[_metrics.latencyIdx] = ms;
    _metrics.latencyIdx = (_metrics.latencyIdx + 1) % _metrics.latencies.length;
    if (_metrics.latencyFilled < _metrics.latencies.length) _metrics.latencyFilled++;
    _recordPerRouteLatency(req, ms);
  });
  next();
});
function _latencyPercentile(p) {
  if (_metrics.latencyFilled === 0) return 0;
  const slice = Array.from(_metrics.latencies.slice(0, _metrics.latencyFilled)).sort((a, b) => a - b);
  const idx = Math.min(slice.length - 1, Math.floor(slice.length * p));
  return Number(slice[idx].toFixed(2));
}

// Maintenance mode — gate all traffic behind a static page when
// DATA_DIR/.maintenance EXISTS. The file CONTENT is the bypass token;
// requests carrying X-Maintenance-Bypass: <token> pass through (perf tests).
//
// v8.3.34 (external audit) — EXISTENCE IS THE MODE, CONTENT IS THE TOKEN, and
// until this release one function answered both questions with one value.
// `_maintenanceToken()` returned `""` for an EMPTY file and `null` for a missing
// one — both falsy — so five call sites disagreed about the same sentinel:
//
//   * the traffic gate below and /readyz asked for the TOKEN, so an empty file
//     meant "not in maintenance": the site kept serving the public, and the
//     load balancer was told the box was ready;
//   * both perf-seed guards asked `fs.statSync`, i.e. EXISTENCE, so the same
//     empty file ENABLED `bulk-seed-users` / `bulk-seed-history` — endpoints
//     that write thousands of users and millions of submission rows;
//   * the boot banner asked `fs.existsSync` and printed `maintenance=ON`.
//
// `touch $DATA_DIR/.maintenance` is exactly what an operator does when the
// perf endpoint's own 403 tells them to "create DATA_DIR/.maintenance first",
// so the platform's own instruction produced the one state where seeding is
// permitted against a live public site. The two states are indistinguishable
// in `ls`. Recorded as a known trap since v8.3.11 and closed here.
//
// The resolver now returns BOTH facts, and this is the whole of the fix: the
// code's own comment above has always said existence = mode, content = token.
//
// FAIL CLOSED ON AN UNREADABLE SENTINEL. Only ENOENT means "no maintenance".
// A file that exists but cannot be read — `chmod 000`, root-owned, a directory
// of that name, EIO — is an operator who engaged maintenance and whose
// intent we cannot read; collapsing that into "off" would silently ignore a
// `sudo tee` and keep serving. It is reported as ACTIVE with NO bypass token,
// which is the safe direction for a gate whose only job is to stop traffic.
const _MAINTENANCE_FILE = path.join(DATA_DIR, ".maintenance");
function _maintenanceState() {
  // The common case — no sentinel — is answered by a stat that RETURNS undefined
  // for ENOENT (and only ENOENT) instead of a read that throws: building the
  // ENOENT Error on every request was measurable main-thread time in the sign-in
  // storm (perf/RESULTS.md). Anything else still goes through the read below, so
  // an unreadable sentinel stays fail-closed, and a file removed between the two
  // calls is the read's ENOENT, i.e. inactive, as before.
  let st;
  try { st = fs.statSync(_MAINTENANCE_FILE, { throwIfNoEntry: false }); } catch (_) { st = null; }
  if (st === undefined) return { active: false, token: "" };
  let raw;
  try { raw = fs.readFileSync(_MAINTENANCE_FILE, "utf8"); }
  catch (e) {
    if (e && e.code === "ENOENT") return { active: false, token: "" };
    return { active: true, token: "" };
  }
  return { active: true, token: raw.trim() };
}
// v6.10.46 — maintenance page now respects prefers-color-scheme.
// Previous (v6.10.44) used only inline style="" attrs and was locked
// to dark mode because inline attrs can't carry @media queries. This
// revision uses a <style> block with light/dark palettes and relaxes
// the CSP *for this response only* so the block isn't dropped by
// `style-src-elem 'self'`. The maintenance HTML is a static
// server-rendered constant with no user input, no scripts, and no
// external resources — a minimal CSP (`default-src 'none';
// style-src 'unsafe-inline'; img-src data:`) is applied in the
// maintenance middleware below to preserve the fail-closed posture
// for everything except the inline style block this page legitimately
// needs. The SVG retains explicit width/height so it renders
// correctly even when styles are stripped by aggressive extensions.
const _MAINTENANCE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Scheduled Maintenance</title>
<style>
  :root{
    color-scheme: light dark;
    /* Dark palette (default) — matches the SPA's dark theme. */
    --m-bg: #0b0817;
    --m-surface: #141029;
    --m-border: #2a2540;
    --m-text: #f1eefe;
    --m-muted: #9b96bf;
    --m-accent: #a0a5ff;
    --m-badge: #1e1942;
    /* The standalone shells' names (DESIGN_SYSTEM.md §4, §5): the card at
       Signature's --r-l, resting on the tier-1 shadow of each mode. Flat
       Design 3.0: no blurred shadow, no gradient (tests/theme-tokens.spec.js
       reads this block beside the standalone sheets). */
    --r-l: 18px;
    --shadow-1: 0 1px 3px rgba(0,0,0,0.12);
  }
  @media (prefers-color-scheme: light){
    :root{
      /* Light palette — matches the SPA's light theme (surface + accent
         tuned to be legible on a near-white background). */
      --m-bg: #f5f5fa;
      --m-surface: #ffffff;
      --m-border: #e0dfe8;
      --m-text: #1a1528;
      --m-muted: #5a5670;
      --m-accent: #5b3fde;
      --m-badge: #efedfa;
      --shadow-1: 0 1px 2px rgba(15,13,26,0.06);
    }
  }
  *{box-sizing: border-box;}
  body{
    margin:0; padding:24px; min-height:100vh;
    display:flex; align-items:center; justify-content:center;
    background: var(--m-bg); color: var(--m-text);
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    line-height:1.5; -webkit-font-smoothing: antialiased;
  }
  main{
    max-width:440px; width:100%; padding:48px 32px; text-align:center;
    background: var(--m-surface); border:1px solid var(--m-border);
    border-radius: var(--r-l); box-shadow: var(--shadow-1);
  }
  .badge{
    display:inline-flex; align-items:center; justify-content:center;
    width:72px; height:72px; border-radius:50%;
    background: var(--m-badge); margin:0 auto 24px;
  }
  .badge svg{stroke: var(--m-accent); display:block;}
  h1{
    font-size:1.75rem; font-weight:700; margin:0 0 12px;
    letter-spacing:-0.01em; color: var(--m-text);
  }
  p{font-size:1rem; color: var(--m-muted); margin:0;}
</style>
</head>
<body>
  <main>
    <div class="badge" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
      </svg>
    </div>
    <h1>Scheduled Maintenance</h1>
    <p>The platform is undergoing scheduled maintenance and will be back shortly. Thank you for your patience.</p>
  </main>
</body>
</html>`;
// infra audit (#3): dedicated liveness probe mounted BEFORE the maintenance
// middleware so it always returns 200 — even during scheduled maintenance.
// The container healthcheck previously probed /api/config, which the
// maintenance gate 503s, driving the container "unhealthy" (and, under
// orchestrators with `condition: service_healthy`, evicted/recreated) during a
// planned, no-restart maintenance window. /healthz reports process liveness
// only — it never touches the DB or app state.
// ext-audit v7.15.11 — LIVENESS vs READINESS. /healthz answers "is the process
// alive" and deliberately still returns 200 on a corrupt DB, so an operator can
// reach the box and triage (that is the documented intent of the boot integrity
// check: log loudly, keep running). But it was ALSO the container health check,
// so a known-corrupt database stayed traffic-ready and a load balancer kept
// routing normal users to it. /readyz is the DB-aware signal: it fails while the
// boot integrity check has failed, or while maintenance mode is engaged, so the
// orchestrator drains the instance without killing the shell an operator needs.
let _dbIntegrityOk = true;                 // flipped by the boot check below
// v8.3.39 (external audit) — flipped by boot check 2b. Separate from
// `_dbIntegrityOk` on purpose: "the file is corrupt" and "the upgrade did not
// finish" are different operator problems with different remedies, and a probe
// that collapsed them would send somebody to the backups over a swallowed ALTER.
let _dbSchemaOk = true;
// ext-audit v7.15.13 — test-only: milliseconds to hold the submit path's file-read
// window open, so a test can deterministically mutate the challenge DURING it.
// Only ever set by /api/test/submit-read-delay, which is registered under the
// NODE_ENV=test gate; it stays 0 in every other environment.
let _testSubmitReadDelayMs = 0;
// v8.12.6 (review fix) — how many submissions have ENTERED that window since it
// was last set, so a test acts on a deterministic signal rather than a blind
// sleep (the `admin-commit-delay` shape). Read by the hook's GET.
let _testSubmitReadParked = 0;
const _setDbIntegrityFailed = () => { _dbIntegrityOk = false; };
const _setDbSchemaIncomplete = () => { _dbSchemaOk = false; };
// THE INSTANCE-HEALTH GATE, one definition for everything it holds: the
// database passed the boot integrity and schema checks, and maintenance mode is
// off. It holds both mail workers (a pass answers `held:true` and leaves every
// job queued, so no certificate or team report goes out from a copied, restored,
// corrupt or half-migrated database: operator rulings, 17 and 24 Nov 2026) and
// the Checkmarx One runners (they create and remove accounts in a customer's
// tenant). Read LIVE on every pass: lifting maintenance resumes them with no
// restart, while a failed boot check holds them until the database is fixed and
// the server restarted, as the checks run only at boot. /readyz answers each
// reason apart (and also probes the tables, which this gate does not). It also
// holds the start-reminder dispatcher (runReminderTick, asked before the pass and
// before each claim) and the lockout-expiry pass (runLockoutExpiryPass, the
// "your account is unlocked" mail): operator ruling, 25 Nov 2026.
function _instanceInService() {
  return _dbIntegrityOk && _dbSchemaOk && !_maintenanceState().active;
}

app.get("/healthz", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ ok: true, status: "alive" });
});
app.get("/readyz", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!_dbIntegrityOk) {
    return res.status(503).json({ ready: false, reason: "db_integrity",
      detail: "PRAGMA integrity_check failed at boot — restore from backup before serving traffic." });
  }
  // v8.3.39 (external audit) — A HALF-APPLIED MIGRATION MUST NOT READ AS READY.
  // Almost every ALTER in db.js is wrapped in a try/catch that logs and carries
  // on, and the two probes below cannot see the difference: they read `settings`
  // and `users` by primary key, which succeeds whether or not
  // `submissions.answer_canonical` or `users.login_code_hash` ever landed. So an
  // instance whose submit path or sign-in codes 500 on every request would
  // report 200 here and take load-balancer traffic. Reason is coarse on
  // purpose — this endpoint is unauthenticated, and the column names are in the
  // boot log where the operator already is.
  if (!_dbSchemaOk) {
    return res.status(503).json({ ready: false, reason: "db_schema" });
  }
  if (_maintenanceState().active) {
    return res.status(503).json({ ready: false, reason: "maintenance" });
  }
  // ext-audit v7.15.12 — actually touch the APPLICATION data path. v7.15.11's
  // comment claimed a PK read but the query was `SELECT 1`, which SQLite answers
  // without opening a single table: after dropping `users`, /readyz still said
  // 200 while ordinary API routes 500'd. Read a required table by primary key —
  // still O(1), but it fails if the schema is gone or the file is unreadable.
  try {
    db.prepare("SELECT value FROM settings WHERE key='last_platform_version'").get();
    db.prepare("SELECT id FROM users LIMIT 1").get();
  } catch (e) {
    // ext-audit v7.15.13 — /readyz is PUBLIC (a load balancer must reach it
    // unauthenticated), so the raw SQLite message must not ship: it names tables,
    // columns and file paths. Generic to the caller, detailed in the log.
    try { log.error({ err: e && e.message }, "readiness probe: database check failed"); } catch (_err) { swallowed("server:best-effort", _err); }
    return res.status(503).json({ ready: false, reason: "db_unavailable" });
  }
  res.status(200).json({ ready: true });
});
app.use((req, res, next) => {
  const maint = _maintenanceState();
  if (!maint.active) return next();
  const token = maint.token;
  // v6.9.22: timing-safe compare so an attacker can't use response
  // timing to recover the bypass token byte-by-byte from outside the
  // data volume. `crypto.timingSafeEqual` requires same-length Buffers,
  // so length-mismatch is a fast-fail (the attacker already learns
  // the length of the stored token, which is not a secret — it's a
  // UUID-shape by convention). Actual byte comparison is constant
  // time.
  //
  // v8.3.34 — `token.length > 0` is MANDATORY, not belt-and-braces, and it is
  // the trap that makes the resolver change above safe. An empty sentinel now
  // engages maintenance, and `timingSafeEqual(Buffer.from(""), Buffer.from(""))`
  // returns TRUE — measured. An absent header is already excluded by the
  // `typeof header === "string"` guard, but a header sent as `X-Maintenance-
  // Bypass:` with an empty value arrives as `""` and reaches the compare. So
  // without this clause an empty sentinel would let EVERY caller bypass with a
  // one-line header — strictly worse than the defect being fixed. An empty file
  // means maintenance with NO bypass; the escape hatch is `rm`.
  const header = req.headers["x-maintenance-bypass"];
  const headerBuf = typeof header === "string" ? Buffer.from(header, "utf8") : null;
  const tokenBuf = Buffer.from(token, "utf8");
  if (token.length > 0 && headerBuf && headerBuf.length === tokenBuf.length && crypto.timingSafeEqual(headerBuf, tokenBuf)) return next();
  // v6.10.51 — `Cache-Control: no-store` on every maintenance response
  // (both the JSON branch and the HTML branch). Without this, the
  // maintenance middleware sits in front of the asset pipeline, so a
  // request for a long-cache versioned URL like `/styles.css?v=abc123`
  // returns the maintenance HTML body (or the 503 JSON) — and 503s
  // without explicit no-store can be heuristically cached by browsers
  // and intermediaries. Post-maintenance the cached entry would still
  // be the maintenance body, served from cache for the same versioned
  // URL until the user manually clears or the TTL elapses. no-store
  // forbids any caching, so recovery from maintenance is immediate
  // and doesn't depend on cache hygiene downstream.
  res.setHeader("Cache-Control", "no-store");
  const wantsJson = req.headers.accept?.includes("application/json") || req.path.startsWith("/api/");
  if (wantsJson) return res.status(503).json({ error: "The platform is undergoing scheduled maintenance." });
  // v6.10.46 — relax CSP for this response so the <style> block with
  // prefers-color-scheme queries isn't dropped by the global
  // `style-src-elem 'self'` rule. Replacement CSP is MINIMAL: no
  // scripts, no external fetches, no frames — only inline styles.
  // Safe because the response body is a server-rendered static
  // constant (no user input, no dynamic data interpolation).
  res.setHeader("Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'");
  res.status(503).type("html").send(_MAINTENANCE_HTML);
});

// Body size caps. 5 MB is generous for task descriptions with a handful
// of embedded images (extractAndStoreImages will move base64 data URIs
// into the images table immediately) but small enough that the pre-rate-
// limit memory footprint is bounded.
//
// v6.13.19 — auth-endpoint cap. Pre-fix the comment claimed "auth
// endpoints receive a smaller body cap downstream via per-route json
// parsers", but no such parsers existed — every unauthenticated request to
// a sign-in or sign-up door (`_AUTH_PATHS` below, `/api/check-nickname`
// included) could force the server to parse up to 5 MB
// before the per-route rate limiter even ran. A pre-mount tiny parser
// (16 KB; far above any legitimate auth body) closes that with a 413
// at parse time. Once it has consumed the stream, the global 5 MB parser
// downstream is a no-op for these paths — body-parser 2 skips a request whose
// stream has already finished (`onFinished.isFinished(req)`, read.js), not one
// with `req._body` set as body-parser 1 did. (v8.13.3: the old wording named the
// body-parser 1 mechanism.)
//
// `/api/register` is in this set too: the sign-up takes no photo (a preset
// picture or nothing), so 16 KB is generous for its fields.
// v8.1.0 (PR 28) — public, session-less HTML forms. `/credential` is the only
// member today. BOTH parsers must know about it: v7.15.14 exists because capping
// the JSON body alone left a form-encoded bypass, and the content type does not
// change what an unauthenticated caller may make the process buffer.
// v8.13.3 — `/api/unsubscribe` joins it: the RFC 8058 one-click POST and the
// confirmation form are session-less forms too, and the route-level 8 KB parser it
// carried was dead (the 5 MB parser below consumed the stream first), so an
// anonymous caller could make it buffer 5 MB.
const _PUBLIC_FORM_PATHS = new Set(["/credential", "/api/unsubscribe"]);

const _AUTH_PATHS = new Set([
  "/api/login", // the built-in superadmin's break-glass password
  "/api/auth/password", "/api/me/sign-in-method", // an account's password: sign-in, set and change
  "/api/auth/sign-in-method", // which step the entry screen shows (an address)
  "/api/auth/code/request", "/api/auth/code/redeem", // the emailed sign-in code
  "/api/auth/code/drop-event", // "Not your event?": unties a code this browser was mailed
  "/api/check-nickname",
  "/api/register", // the sign-up form (no photo: a preset picture or nothing)
]);
// v6.16.16 — test-only routes get the same 16-KB cap as auth routes.
// These endpoints are gated by `NODE_ENV === "test"` and intentionally
// absent in production builds, but defence-in-depth costs ~3 lines:
// if NODE_ENV ever leaks to production (operator misconfig, stray
// docker-compose override), an unauthenticated 5-MB body POST against
// a test route would parse before the route handler runs.
//
// v8.14.0 — matched by PREFIX, on both parsers. A hand-kept Set had drifted to
// 15 of the 35 hooks, and only the JSON parser consulted it, so a URL-encoded
// body reached every hook through the 5 MB parser. Every path under the prefix
// gets the cap, routed or not; nothing there needs more.
const _isTestPath = (p) => p.startsWith("/api/test/");
const _authJsonParser = express.json({ limit: "16kb" });
// v7.14.0 — match on a LOWERCASED path. Express routes case-insensitively by
// default, so `POST /API/login` reaches the login handler; a case-sensitive
// Set lookup here silently handed it the generic 5 MB parser instead of this
// 16 KB auth cap. (Same normalisation the impersonation write gate needs — see
// lib/impersonation.js.) Every member of both Sets is already lowercase.
app.use((req, res, next) => {
  // ext-audit v7.15.16 — normaliseRoutePath, not bare toLowerCase: Express also
  // routes non-strictly, so `POST /api/login/` reached the handler while this
  // exact-Set lookup missed it and handed the request the 5 MB global parser.
  const p = normaliseRoutePath(req.path);
  if (_AUTH_PATHS.has(p) || _PUBLIC_FORM_PATHS.has(p) || _isTestPath(p)) return _authJsonParser(req, res, next);
  next();
});
// Import endpoints accept attachment binaries inline as base64, so a full
// export round-trip can push a single task's payload well past the generic
// 5 MB limit. 128 MB caps the maximum attachment mass per import at roughly
// 96 MB raw (the remaining headroom absorbs the ~33 % base64 inflation plus
// JSON scaffolding).
//
// v6.16.41 — applied INSIDE the import routes after rate-limit + auth +
// CSRF gates instead of as a path-matching global app.use. Pre-fix an
// anonymous POST /api/admin/import/tasks would have its body parsed at
// the 128 MB ceiling BEFORE requireAdmin / requireSuperAdmin saw the
// session — a cheap memory-DoS vector. Post-fix the parser only runs
// after the request has been authenticated as superadmin and within
// the importLimiter cap (5/min/IP). The global 5 MB parser below skips
// the import paths so it doesn't pre-empt the larger ceiling on the
// authenticated path.
const _importJsonParser = express.json({ limit: "128mb" });
const _IMPORT_PATHS = new Set(["/api/admin/import/tasks", "/api/admin/import/participants"]);
const _expressJson5mb = express.json({ limit: "5mb" });
app.use((req, res, next) => {
  // Normalised for the same routing reasons as the auth cap above.
  if (_IMPORT_PATHS.has(normaliseRoutePath(req.path))) return next();
  return _expressJson5mb(req, res, next);
});
// ext-audit v7.15.14 — the auth-path cap must cover URL-ENCODED bodies too.
//
// The 16 KB cap above only wrapped express.json(), so a login/register posted
// as `application/x-www-form-urlencoded` skipped it and landed on this 5 MB
// parser — a 1 MiB form login reached authentication while the identical JSON
// body was rejected 413. The whole point of the small cap is to bound what an
// unauthenticated caller can make the process buffer and parse BEFORE the
// route's own rate limiter runs, and content type does not change that.
const _authUrlencodedParser = express.urlencoded({ extended: true, limit: "16kb" });
const _urlencoded5mb = express.urlencoded({ extended: true, limit: "5mb" });
app.use((req, res, next) => {
  // Same lowercasing as the JSON cap — Express routes case-insensitively, so
  // `POST /API/login` must not slip past a case-sensitive Set lookup.
  const p = normaliseRoutePath(req.path);
  if (_AUTH_PATHS.has(p)) return _authUrlencodedParser(req, res, next);
  // v8.1.0 (PR 28) — PUBLIC FORMS get the auth-sized cap, for the auth-path
  // reason: they are reachable with no session at all, so what an unauthenticated
  // caller can make this single-process server buffer must be bounded. The
  // credential lookup carries two short strings; 16 KB is generous.
  //
  // Kept as its own set rather than folded into _AUTH_PATHS, because that set
  // is the anonymous sign-in and sign-up doors; these are public forms.
  if (_PUBLIC_FORM_PATHS.has(p) || _isTestPath(p)) return _authUrlencodedParser(req, res, next);
  return _urlencoded5mb(req, res, next);
});

// v8.13.3 — AN ABSENT BODY IS AN EMPTY BODY.
//
// Express 5 / body-parser 2 leave `req.body` UNDEFINED whenever no parser consumed
// the request — no body at all, or a content type nobody parses (text/plain,
// application/octet-stream, no Content-Type) — and 37 handlers destructured it
// (`const { competitionId } = req.body`), so a body-less POST was a 500 with an
// error-level stack line, five of them reachable anonymously with a CSRF token
// anyone can mint. v7.22.8 fixed ONE site (toggle-admin-view) with `req.body?.`
// and the class survived everywhere else; this fixes it for every route
// registered below, by construction.
//
// Its partner is the body-SHAPE refusal composed into csrfProtection
// (lib/middleware.js): a NON-EMPTY payload in a type the route cannot parse is a
// 415 rather than silently becoming this `{}` — accept-and-ignore is a control
// that appears to work. Only a body-LESS request reaches a CSRF-PROTECTED handler
// as `{}`. The refusal lives inside csrfProtection, so the two state-changing
// routes outside it — POST /credential and POST /api/unsubscribe — still read an
// unparsed body as empty (an empty lookup; unsubscribe's token rides the query
// string, so a mail provider's multipart one-click still works). Stated, not
// changed (the pre-release review).
//
// THREE PLACEMENT RULES, each load-bearing:
//   - BELOW every global body parser, so a parsed body is never overwritten.
//     A ROUTE-level parser (the 128 MB import parser, multer) still runs after it
//     and replaces it: body-parser 2 decides by onFinished / hasBody / type, never
//     by req.body, and multer assigns a fresh object.
//   - BELOW `app.post("/api/csp-report", …)`, the one mutating route registered
//     above the parsers. Its handler treats a truthy entry as a report, so a
//     preset `{}` there would turn every empty or text/plain report into a logged
//     empty violation.
//   - ABOVE every other mutating route. A body-reading route registered above
//     this line is the one way the 500 comes back (a source arm pins it).
//
// STATED CONSEQUENCE: a body-less request to an all-optional edit route is now a
// 200 no-op (exactly what a JSON `{}` already was) where it used to be a 500, or,
// on a validateBody route, a 400 "Request body must be an object". That can bump
// an `updated_at` and so 409 a colleague's open form — the same as `{}` today. Do
// not "restore" the 400 by removing this: the 500s were the defect.
const _BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
app.use((req, res, next) => {
  if (req.body === undefined && _BODY_METHODS.has(req.method)) req.body = {};
  next();
});

// Content-hashed static assets (v6.8.1). At startup we walk public/, hash
// every non-HTML file, and rewrite every HTML file's `href`/`src` asset
// references to append `?v=<hash>`. When the file content changes, the
// hash changes, the URL changes, and browsers re-fetch. When it doesn't
// change, browsers hit the local cache forever (public, max-age=1y,
// immutable). Requests without the version query fall back to the old
// 5-minute cache so a direct /styles.css URL stays fresh within minutes.
// The server embeds the full file list + hashes at boot; on a bump or
// file edit, nodemon restarts (version.json is now watched in
// nodemon.json) which recomputes the hash map.
const _PUBLIC_DIR = path.join(__dirname, "public");
const _assetVersions = new Map();
// v6.8.10: startup-time CSS minification. The project deliberately has no
// build step — so the conventional answer ("minify in webpack / esbuild")
// isn't available. Instead we minify once per boot: the cold-start cost
// is ~5-20 ms for a 60 KB stylesheet, amortised over every subsequent
// serve. We hash the MINIFIED content (not the original file) so the
// version query in the HTML rewrite still matches what clients receive.
// Minified bodies are cached in `_cssCache` and served by a route that
// sits in front of express.static; misses fall through to the normal
// static handler (so non-minified CSS, if any, still works).
//
// Minifier semantics (intentionally conservative):
//   • strip /* ... */ comments outside strings
//   • collapse runs of whitespace; drop spaces around { } ; , > ~ and
//     AFTER (never before) `:` — keeping them elsewhere preserves selector
//     descendant boundaries like `div span` and `a :is(b)`, media-query
//     parens and calc() operators
//   • remove trailing `;` before `}`
// The minifier does NOT rewrite shorthand, inline colours, or mangle
// identifiers — it's a size-reducer, not a mangler. Output is still
// human-readable if someone opens devtools on a 200 KB stylesheet.
//
// It runs in LINEAR time and must stay so: `last` is the character most
// recently appended to `out`. Reading `out[out.length - 1]` instead flattens
// the string `+=` has been building, a copy of everything written so far at
// every run of whitespace: quadratic, 1.6 s on the 530 KB stylesheet, paid by
// every boot (each test file's server included), and enough to keep a
// production boot on a loaded CI runner from listening within 15 s.
const _cssCache = new Map();
function _minifyCss(src) {
  let out = "";
  let last = "";
  const n = src.length;
  for (let i = 0; i < n;) {
    const ch = src[i];
    if (ch === "/" && src[i+1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const q = ch;
      out += ch; last = ch; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\" && i + 1 < n) { out += src[i] + src[i+1]; last = src[i+1]; i += 2; continue; }
        last = src[i]; out += src[i++];
      }
      if (i < n) { out += src[i]; last = src[i]; i++; }
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      while (i < n && (src[i] === " " || src[i] === "\t" || src[i] === "\n" || src[i] === "\r")) i++;
      const prev = last;
      const next = src[i];
      // `(` and `)` are NOT safe strip-boundaries — `@media(x)and(y)` is
      // invalid CSS (media-query `and` requires surrounding whitespace). A
      // space between `)` and an identifier, or between an identifier and
      // `(`, must be preserved; otherwise the whole @media block is
      // discarded and narrow-viewport rules silently stop matching.
      //
      // v6.9.4: `+` is also off the list — `calc(10px + 5px)` is invalid
      // without the spaces (the spec requires whitespace around `+` and
      // `-` inside math functions to distinguish them from signed
      // numbers). Cost of keeping `+` in sibling selectors un-stripped
      // (`.a + .b`) is ~20 bytes across the whole stylesheet. `-` is
      // already preserved because it was never in the list.
      //
      // `:` is a strip boundary on its RIGHT only. A space BEFORE it is, in
      // a selector, a descendant combinator: `a :is(b)` glued to `a:is(b)`
      // is a compound that matches nothing, which silently voided every
      // rule written that way. In a declaration (`color :red`) the kept
      // space costs one byte.
      if (prev && next && !"{};:,>~".includes(prev) && !"{};,>~".includes(next)) { out += " "; last = " "; }
      continue;
    }
    out += ch; last = ch;
    i++;
  }
  return out.replace(/;\}/g, "}");
}
// v6.20.x: startup-time JS minification — the JS twin of _minifyCss above.
// Retires accepted-disposition #5 ("app.js ships un-minified") by minifying
// the first-party scripts at boot via esbuild, mirroring the CSS pipeline:
// minify once per boot, cache the body, hash the MINIFIED content so
// ?v=<hash> matches what clients receive, fall through to raw serve on miss.
//
// DEV-LOOP INVARIANT: gated on _MINIFY_JS, which is OFF in dev and test. So
// `npm run dev` / a Cursor debug launch serve public/*.js RAW from the working
// tree — the SERVER is never stale here, and browser breakpoints map 1:1 to
// the source you edit. nodemon DOES watch public/ (v8.7.2) and restarting does
// not disturb either property; it is there for the browser's sake, because
// /js/core/main.js is referenced from index.html and so carries a ?v=<hash>
// frozen at boot, and any ?v= URL is answered max-age=31536000, immutable with
// no dev gate — so without a restart the browser never re-requests it. Minification runs only
// in the production process (or with MINIFY_JS=1).
//
// esbuild is loaded lazily + defensively, so a broken install falls back to raw
// serve rather than wedging boot: a missing PACKAGE warns once, here; a package
// whose platform binary is missing warns once per file it cannot minify, and the
// SPA is then served as raw modules (measured, v8.13.4).
const _jsCache = new Map();
const _MINIFY_JS = process.env.NODE_ENV === "production" || process.env.MINIFY_JS === "1";
let _esbuild = null;
if (_MINIFY_JS) {
  try { _esbuild = require("esbuild"); }
  catch (e) { console.warn("[minify-js] esbuild unavailable — serving JS un-minified:", e && e.message); }
}
// A first-party .js asset we minify: any .js under public/ that isn't already
// minified (vendor *.min.js is left untouched).
function _isMinifiableJs(name) { return name.endsWith(".js") && !name.endsWith(".min.js"); }
function _minifyJs(src) {
  // Minify only (no bundling). At the default esnext target esbuild does NO
  // syntax downleveling — it mangles locals, strips whitespace/comments, folds
  // constants. Top-level names in a classic <script> are GLOBALS and esbuild
  // preserves them, so data-action wiring + cross-file refs stay intact.
  return _esbuild.transformSync(src, { loader: "js", minify: true, legalComments: "none" }).code;
}
function _hashFile(p) {
  try {
    // CSS goes through the minifier first so the hash matches served bytes.
    if (p.endsWith(".css")) {
      const raw = fs.readFileSync(p, "utf8");
      const min = _minifyCss(raw);
      return crypto.createHash("sha256").update(min).digest("hex").slice(0, 12);
    }
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 12);
  } catch (_) { return ""; }
}
(function _collectAssets(dir, base, urlPrefix) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return; }
  for (const f of entries) {
    const full = path.join(dir, f);
    const rel = path.posix.join(base, f);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (st.isDirectory()) { _collectAssets(full, rel, urlPrefix); continue; }
    // HTML is rewritten in-memory (see _htmlCache below); its URL stays
    // un-versioned so the top-level document keeps a stable URL across
    // version bumps and browser bookmarks continue to work.
    if (f.endsWith(".html")) continue;
    // Likewise for .md: the markdown file IS a content document whose URL
    // is referenced by the SPA (`/docs/user-guide/participant.md` etc.),
    // so we don't hash the URL itself. The markdown body is rewritten
    // (v6.8.2) so image references inside it gain ?v=<hash> query strings
    // that point at the hashed screenshot files.
    if (f.endsWith(".md")) continue;
    // v6.8.10: for .css we minify at boot and cache the minified body.
    // The hash computed by _hashFile matches the minified content, so
    // ?v=<hash> URLs stay consistent with what the middleware serves.
    if (f.endsWith(".css")) {
      try {
        const min = _minifyCss(fs.readFileSync(full, "utf8"));
        _cssCache.set(urlPrefix + rel, min);
      } catch (_err) { /* fall back to raw serve via express.static */ swallowed("server:asset-serve", _err); }
    }
    // v6.20.x / v7.0.0: minifiable first-party JS — minify once at boot, cache
    // the body, and hash the MINIFIED bytes so ?v=<hash> matches what the
    // _jsCache middleware serves. continue so the raw-hash line below doesn't
    // overwrite it. Any failure logs + falls through to the raw hash + raw serve.
    if (_MINIFY_JS && _esbuild && _isMinifiableJs(f)) {
      const urlPath = urlPrefix + rel;
      try {
        // v7.0.0 ESM split: the SPA entry is esbuild-BUNDLED (its whole import
        // graph inlined into one file) so prod serves a single content-hashed
        // /js/core/main.js with zero extra module requests. Its sub-modules
        // under /js/** are inlined here — skip individual minify/serve (they're
        // never requested in prod); they fall through to a raw hash + raw serve
        // as a defensive fallback only.
        if (urlPath === "/js/core/main.js") {
          const bundled = _esbuild.buildSync({ entryPoints: [full], bundle: true, minify: true, format: "esm", write: false, legalComments: "none" }).outputFiles[0].text;
          _jsCache.set(urlPath, bundled);
          _assetVersions.set(urlPath, crypto.createHash("sha256").update(bundled).digest("hex").slice(0, 12));
          continue;
        }
        if (urlPath.startsWith("/js/")) {
          // ESM sub-module — inlined in the bundle above; do not minify/cache
          // individually. Raw-hash it so a bare request still resolves via
          // express.static: the emailed certificate share page loads its own
          // module (features/certificate-share-page.js) and ui/clipboard.js so.
          _assetVersions.set(urlPath, _hashFile(full));
          continue;
        }
        // Standalone classic scripts (theme-boot / help / help-renderer /
        // asset-versions): per-file transform-only minify.
        const min = _minifyJs(fs.readFileSync(full, "utf8"));
        _jsCache.set(urlPath, min);
        _assetVersions.set(urlPath, crypto.createHash("sha256").update(min).digest("hex").slice(0, 12));
        continue;
      } catch (e) {
        console.warn("[minify-js] failed for", rel, "— serving raw:", e && e.message);
      }
    }
    _assetVersions.set(urlPrefix + rel, _hashFile(full));
  }
})(_PUBLIC_DIR, "", "/");
const _DOCS_DIR = path.join(__dirname, "docs");
(function _collectDocsAssets(dir, base, urlPrefix) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return; }
  for (const f of entries) {
    const full = path.join(dir, f);
    const rel = path.posix.join(base, f);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (st.isDirectory()) { _collectDocsAssets(full, rel, urlPrefix); continue; }
    if (f.endsWith(".md")) continue;
    _assetVersions.set(urlPrefix + rel, _hashFile(full));
  }
})(_DOCS_DIR, "", "/docs/");

// Now that every public + docs asset has a hash, compute the content
// hash of /asset-versions.js itself and register it in the same map so
// the HTML rewrite below picks it up and emits
// `<script src="/asset-versions.js?v=<hash>">`. That lets us serve the
// helper with max-age=1y immutable (see the app.get handler further
// down). Pre-v6.8.3 the file was no-cache and cost a round trip on
// every page load.
const _assetVersionsJsBody = `window.__assetHashes = ${JSON.stringify(Object.fromEntries(_assetVersions))};
window.__assetUrlWithVersion = function(u){var s=String(u||""),q=s.indexOf("?"),h=s.indexOf("#"),bare=s,tail="";
if(q>=0&&(h<0||q<h)){bare=s.slice(0,q);tail=s.slice(q);}else if(h>=0){bare=s.slice(0,h);tail=s.slice(h);}
var v=window.__assetHashes[bare];if(!v)return u;/* audit v7.7.37 (C1): the version query ALWAYS starts with "?" — the tail's own leading "?" is rewritten to "&" below, so a pre-existing query no longer produced a URL with no "?" (e.g. "/a.png&v=h&x=1"). */return bare+"?v="+v+tail.replace(/^\\?/,"&");};
`;
const _assetVersionsJsHash = crypto.createHash("sha256").update(_assetVersionsJsBody).digest("hex").slice(0, 12);
_assetVersions.set("/asset-versions.js", _assetVersionsJsHash);

function _rewriteAssetRefs(html) {
  return html.replace(/(href|src)="(\/[^"?#]+)"/g, (m, attr, url) => {
    const v = _assetVersions.get(url);
    return v ? `${attr}="${url}?v=${v}"` : m;
  });
}

// Rewrite relative image/link URLs inside a markdown file to include the
// content-hash query (v6.8.2). The markdown author writes paths relative
// to the .md file (`![alt](../screenshots/foo.png)`); we resolve them
// against the .md file's location and look the result up in the asset
// version map. Fully-qualified URLs, in-document anchors, and assets not
// in the map pass through untouched.
function _rewriteMarkdownAssetRefs(md, mdUrlPath) {
  // mdUrlPath is e.g. /docs/user-guide/participant.md. The dir is the
  // parent of that path (/docs/user-guide), which is what relative paths
  // in the markdown resolve against.
  const mdDir = path.posix.dirname(mdUrlPath);
  return md.replace(/(!\[[^\]]*\]\(|\]\()([^)\s]+)/g, (m, prefix, url) => {
    if (/^(?:\w+:|\/\/|#)/.test(url)) return m;
    const resolved = url.startsWith("/") ? url : path.posix.normalize(path.posix.join(mdDir, url));
    const v = _assetVersions.get(resolved);
    if (!v) return m;
    const sep = url.includes("?") ? "&" : "?";
    return `${prefix}${url}${sep}v=${v}`;
  });
}

// Cache rewritten markdown bodies at startup. Like _htmlCache, nodemon
// restarts on file changes so the cache stays fresh.
const _mdCache = new Map();
(function _loadMdCache(dir, base, urlPrefix) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return; }
  for (const f of entries) {
    const full = path.join(dir, f);
    const rel = path.posix.join(base, f);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (st.isDirectory()) { _loadMdCache(full, rel, urlPrefix); continue; }
    if (!f.endsWith(".md")) continue;
    try {
      const mdUrl = urlPrefix + rel;
      _mdCache.set(mdUrl, _rewriteMarkdownAssetRefs(fs.readFileSync(full, "utf8"), mdUrl));
    } catch (_err) { swallowed("server:best-effort", _err); }
  }
})(_DOCS_DIR, "", "/docs/");

const _htmlCache = new Map();
(function _loadHtmlCache(dir, base) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return; }
  for (const f of entries) {
    const full = path.join(dir, f);
    const rel = path.posix.join(base, f);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (st.isDirectory()) { _loadHtmlCache(full, rel); continue; }
    if (f.endsWith(".html")) {
      try { _htmlCache.set("/" + rel, _rewriteAssetRefs(fs.readFileSync(full, "utf8"))); } catch (_err) { swallowed("server:best-effort", _err); }
    }
  }
})(_PUBLIC_DIR, "");

// Serve rewritten HTML before express.static falls through to the raw
// file. `/` → /index.html. HTML is always no-cache so fresh hashes
// propagate on first request after a restart.
//
// v6.9.10: `/register` is a dedicated SPA entry point for account
// creation — it serves the same index.html and the client-side
// bootstrap routes the user straight to #register-page. Lets us link
// to "Create an account" from marketing pages / invitation emails /
// anywhere else with a clean URL instead of the old `/?invitation=…#register-page`
// fragment hack.
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const reqPath = (req.path === "/" || req.path === "/register" || req.path.startsWith("/join/")) ? "/index.html" : req.path;
  const rewritten = _htmlCache.get(reqPath);
  if (!rewritten) return next();
  // v6.10.92 / v6.10.93 — perf-span on SPA shell serve, scoped to
  // `/` and `/register` (the SPA entry points browser probes hit).
  // The v6.10.92 every-call diagnostic against ctf.checkmarx.net
  // measured total ~0.3-0.6 ms (prelude ~0 ms, send ~0.4 ms) on 47 KB
  // of rewritten HTML — confirming browser_page_load p(90)=7.37 s
  // is ~99.99% network + TLS + asset cascade, NOT shell serve.
  // v6.10.93 reverts to the 300 ms threshold (same pattern as the
  // admin perf-spans) so the logger stays on as a tripwire for real
  // regressions (e.g. _htmlCache rebuild on every request, middleware
  // stack change) without spamming the log on every probe.
  const _isSpaEntry = (req.path === "/" || req.path === "/register" || req.path.startsWith("/join/"));
  const tHandler = _isSpaEntry ? process.hrtime.bigint() : 0n;
  res.set("Cache-Control", "no-cache");
  // v7.23.6 (audit Wave 6) — hydrate {{platformName}} at SEND time.
  //
  // /verified.html, /verify-expired.html and /verify-failed.html are reached by
  // REDIRECT from /verify, so the handler cannot interpolate anything — and they
  // hard-coded the COMPETITION_NAME fallback ("Tournament") plus a literal
  // "Checkmarx" in the title, while every server-RENDERED sibling
  // (_emailResultPage) interpolates getPlatformName(). So an operator who named
  // their platform anything else sent a verification email under that name and
  // landed the recipient on a page branded "Tournament".
  //
  // Doing it here rather than at boot is deliberate: the platform name is a
  // runtime SETTING, so a boot-time rewrite would go stale the moment an
  // operator renamed. These responses are already `no-cache`, and the guard
  // makes it a single `includes` scan for every page that has no placeholder
  // (index.html included). getPlatformName() is memoised.
  // v8.1.0 (PR 13) — the KIND LABEL TABLE rides the SPA shell, not /api/config,
  // and that is a correctness decision rather than an optimisation.
  // fetchTransientRetry is 3 attempts over ~1.2 s (400 ms then 800 ms) against a
  // SIXTY-second, 120/min bucket, so at a venue NAT all three attempts land inside
  // the same throttled minute — and the create chooser's only remedy would be a
  // reload into the same 429. It would also make a failed /api/config cost the
  // ability to create an event, where today it costs the wordmark and a version
  // badge. The labels are a SOURCE constant that changes only on deploy, so they
  // should not travel over a rate-limited pre-login endpoint at all.
  //
  // A `data-` attribute rather than an inline <script> sidesteps CSP and Trusted
  // Types entirely — no nonce, no policy, no judgement about whether
  // type="application/json" is script. escapeHtml turns `"` into `&quot;`, and
  // `dataset` hands back the DECODED string, so JSON.parse on the client is safe.
  //
  // Both payloads are computed ONCE at module load: unlike the platform name these
  // are source constants with no runtime setting behind them, so the per-request
  // work is the substitution alone.
  //
  // The guard tests the platformName placeholder rather than a bare `{{`, and the
  // reason is not style: several source scanners locate an enclosing function by
  // counting braces, and a string literal holding two UNMATCHED `{` silently
  // shifts every function boundary they compute for the rest of the file. That
  // cost a genuine false positive on the v7.21.32 reqContext guard, which then
  // flagged three unrelated background emits 2 600 lines below here. The app's
  // page carries {{platformName}} (in its <title>) and the help page only
  // {{platformLook}} (theme-boot.js runs there too), so the guard asks for
  // either placeholder — balanced braces, and one or two `includes` scans.
  //
  // The substituted page is then a frozen body per (page, platform name, platform
  // look) and is
  // sent through _sendFrozenAsset: encoded, hashed and compressed once, not on
  // every request. A rename gives a new key, so the next request renders afresh.
  // The PLATFORM LOOK (lib/platform-look.js) rides the shell the same way, on
  // <html data-platform-look>, so theme-boot.js paints the superadmin's look
  // before the first frame — the anonymous sign-in page and the help page
  // included. It is a runtime setting, so it is part of the frozen body's key.
  const _lookJson = JSON.stringify(getPlatformLook());
  const _shellKey = `html:${reqPath}\u0000${getPlatformName()}\u0000${_lookJson}`;
  const body = _assetEntries.has(_shellKey) ? "" : (rewritten.includes("{{platformName}}") || rewritten.includes("{{platformLook}}"))
    ? rewritten
      .replaceAll("{{platformName}}", escapeHtml(getPlatformName()))
      .replaceAll("{{platformLook}}", escapeHtml(_lookJson))
      .replaceAll("{{eventKinds}}", _EVENT_KINDS_ATTR)
      .replaceAll("{{eventCollective}}", _EVENT_COLLECTIVE_ATTR)
      .replaceAll("{{loginCodeTtl}}", _LOGIN_CODE_TTL_ATTR)
    : rewritten;
  res.type("html");
  _sendFrozenAsset(req, res, _shellKey, body);
  if (_isSpaEntry) {
    const tRespond = process.hrtime.bigint();
    const preludeMs = req._perfT0 ? Number(tHandler - req._perfT0) / 1e6 : 0;
    const sendMs = Number(tRespond - tHandler) / 1e6;
    const totalMs = preludeMs + sendMs;
    if (totalMs > PERF_SPAN_SLOW_MS) {
      log.warn({
        req_id: req.id,
        ..._requestActor(req),
        // v8.13.3 — scrubbed: `_isSpaEntry` includes /join/<token>, so a slow
        // shell serve wrote the self-enroll token into app.jsonl, which a
        // regular admin reads through Logs.
        endpoint: "GET " + _scrubLogPath(req.path),
        total_ms: totalMs.toFixed(1),
        prelude_ms: preludeMs.toFixed(1),
        send_ms: sendMs.toFixed(2),
        html_bytes: rewritten.length,
      }, "[perf-span] slow SPA shell");
    }
  }
});

// ONE ENCODE PER ASSET, NOT PER REQUEST. The SPA shell, the stylesheet and the JS
// bundle are bodies frozen at boot (the shell per platform name and platform
// look), yet every
// request re-did all the work on them: encode the string to bytes, hash it for
// the ETag, and run it through compression() — a fresh gzip/brotli stream over
// the largest responses the server sends. Measured in the 3000-user sign-in
// storm (perf/RESULTS.md), that was the biggest single block of main-thread time
// while a room opened the page at once, which is exactly when the process can
// least afford it. So each body is encoded, hashed and compressed (gzip and
// brotli) ONCE, on first use, and later requests are a negotiated buffer write.
//
// What the client sees is unchanged: the same weak ETag the app's own etag
// function computes (compression() never changed it either), Vary:
// Accept-Encoding, Content-Encoding only when the client accepts it and the body
// is at least 1 KB (this cache's own threshold; compression() starts at 8 KB),
// 304 on a matching If-None-Match and
// no body on HEAD — the last two via res.send(), which compression() then leaves
// alone because the response already names its encoding.
const _ASSET_ENTRIES_MAX = 64;
const _assetEntries = new Map();
function _assetEntry(key, body) {
  let ent = _assetEntries.get(key);
  if (ent) return ent;
  const raw = Buffer.from(body, "utf8");
  ent = { raw, etag: app.get("etag fn")(raw), gzip: null, br: null };
  if (raw.length >= 1024) {
    const zlib = require("zlib");
    ent.gzip = zlib.gzipSync(raw, { level: 6 });
    ent.br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
  }
  if (_assetEntries.size >= _ASSET_ENTRIES_MAX) _assetEntries.delete(_assetEntries.keys().next().value);
  _assetEntries.set(key, ent);
  return ent;
}
function _sendFrozenAsset(req, res, key, body) {
  const ent = _assetEntry(key, body);
  res.set("ETag", ent.etag);
  res.vary("Accept-Encoding");
  let out = ent.raw;
  // compression()'s own choices: never for HEAD, and brotli over gzip whenever
  // the client accepts both.
  if (ent.gzip && req.method !== "HEAD") {
    if (req.acceptsEncodings("br") === "br") { res.set("Content-Encoding", "br"); out = ent.br; }
    else if (req.acceptsEncodings("gzip") === "gzip") { res.set("Content-Encoding", "gzip"); out = ent.gzip; }
  }
  res.send(out);
}
// v6.8.10: CSS minified-cache middleware. Sits ahead of express.static so
// .css requests get the pre-minified body from _cssCache; everything else
// falls through. Mirrors the _htmlCache pattern above (no-store-busting
// logic, same version-query cache policy).
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (!req.path.endsWith(".css")) return next();
  const body = _cssCache.get(req.path);
  if (body === undefined) return next();
  res.set("Content-Type", "text/css; charset=utf-8");
  const url = req.originalUrl || req.url || "";
  if (/\?v=[a-f0-9]+/.test(url)) {
    res.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.set("Cache-Control", "public, max-age=300");
  }
  _sendFrozenAsset(req, res, "css:" + req.path, body);
});
// v6.20.x: JS minified-cache middleware — the JS twin of the CSS one above.
// Serves the boot-minified body from _jsCache ahead of express.static; a miss
// (always, in dev/test — _jsCache is only populated when _MINIFY_JS is on)
// falls through to the raw static serve, which is what keeps the working tree
// directly debuggable.
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (!req.path.endsWith(".js")) return next();
  const body = _jsCache.get(req.path);
  if (body === undefined) return next();
  res.set("Content-Type", "text/javascript; charset=utf-8");
  const url = req.originalUrl || req.url || "";
  if (/\?v=[a-f0-9]+/.test(url)) {
    res.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    res.set("Cache-Control", "public, max-age=300");
  }
  _sendFrozenAsset(req, res, "js:" + req.path, body);
});
const _publicStatic = express.static(_PUBLIC_DIR, {
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    const url = res.req.originalUrl || res.req.url || "";
    if (/\?v=[a-f0-9]+/.test(url)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      // Fallback for direct hits without the version query (legacy links,
      // browser URL bar) — stay cache-shy so deploys propagate quickly.
      res.setHeader("Cache-Control", "public, max-age=300");
    }
  },
});
// AN API REQUEST NEVER ASKS THE DISK. Mounted ahead of every route,
// the static handler stat()ed `public/api/...` for every API call before falling
// through (the third-largest self-time in the 1000-user storm profile:
// perf/RESULTS.md). `public/` holds no `api` directory, so for those paths the
// stat could only ever answer ENOENT; skipping it changes no response. The test
// is a plain case-insensitive prefix on the raw path: any spelling it misses
// (an escaped slash) still falls through exactly as before.
app.use(function _publicStaticUnlessApi(req, res, next) {
  const p = req.path;
  if (p.length > 4 && p.charCodeAt(0) === 47 && p.slice(1, 5).toLowerCase() === "api/") return next();
  return _publicStatic(req, res, next);
});
// Expose docs/ so the in-app Help drawer (public/js/features/help-drawer.js)
// can fetch the role-scoped markdown guides and their screenshots from the
// same origin.
// The /docs mount itself is installed AFTER the session middleware below
// (v6.3.2 — see `_gateAdminDocs` there). An earlier version of this
// comment claimed docs were "non-sensitive" and mounted unconditionally;
// that was true for participant.md + README.md but NOT for admin.md /
// superadmin.md, which document internal operational workflows (the built-in
// superadmin's password file, signing in someone whose mail is broken with a
// desk sign-in code, etc). Those are now gated on an authenticated admin session.
// Session cookie Secure flag (v6.2.6): defence-in-depth — set Secure when ANY
// of these signal an HTTPS deployment, instead of relying on NODE_ENV alone:
//   • NODE_ENV === "production" (the original signal)
//   • BASE_URL begins with "https://" (operator declared an HTTPS public URL)
//   • Express trust-proxy is enabled (deployment terminates TLS upstream and
//     the operator opted in via TRUST_PROXY)
// A staging deployment that forgets NODE_ENV=production would previously ship
// a cookie without Secure and let any on-path attacker capture the session id
// in the cleartext hop between proxy and app — even though the public URL is
// HTTPS. Any one of the three checks above closes that gap.
const SECURE_COOKIE = process.env.NODE_ENV === "production"
  || (typeof BASE_URL === "string" && /^https:/i.test(BASE_URL))
  || !!app.get("trust proxy");

// v8.3.13 — WILL express-session REFUSE TO SET THE SESSION COOKIE ON THIS REQUEST?
//
// It applies exactly one rule: a `secure` cookie is dropped unless the request
// is secure, where "secure" means `req.secure` — which, with `trust proxy` on,
// is decided by `X-Forwarded-Proto`. Mirroring the rule here rather than
// inferring it from a missing header is what keeps this true for every
// deployment shape: direct TLS, a proxy that forwards the header, and a proxy
// that does not.
//
// The failure it detects is SILENT by construction. express-session's own
// notice is a `debug()` call, so a deployment in this state ships tokens that
// cannot work and says nothing at all — which is how it reached production as
// "csrf_invalid", a name from the wrong subsystem.
function _sessionCookieWouldBeDropped(req) {
  return !!SECURE_COOKIE && !req.secure;
}

// One line a minute, not one per request: an ingress in this state produces the
// condition on EVERY request, and a per-request line would bury the log it is
// meant to make legible (the v7.21.24 lesson — an operational message has to be
// findable). It names the two things that decide the verdict, because they are
// exactly what the operator has to go and look at.
// v8.3.13 — TRUST_PROXY SAYS ONE HOP AND THE REQUEST CAME THROUGH MORE.
//
// `TRUST_PROXY=1` trusts exactly one hop, so `req.ip` is taken from the LAST
// entry of `X-Forwarded-For`. Put a CDN or a WAF in front of an existing nginx
// and that entry becomes the INNER PROXY's address — identical for every visitor.
// Every client then shares ONE per-IP rate-limit bucket and ONE scanner counter:
// measured, 130 requests from 130 distinct client addresses began 429-ing at the
// 120th, and a brand-new visitor was refused on their first request.
//
// It is the best fit for a fault that appears "suddenly, with no restart",
// because the change is in the infrastructure and the app never learns of it.
// And the symptom it produces is not "you are rate limited" — a 429 on
// `/api/csrf-token` leaves the client with no token, so it surfaces at the login
// card as `csrf_invalid`.
//
// Warned, never guessed at: the app cannot know the real topology, so it reports
// the discrepancy and leaves the operator to decide. Rate-limited to one line a
// minute for the same reason as the sibling below — the condition holds for every
// request, so a line each would bury it.
let _hopWarnAt = 0;
function _warnProxyHopMismatch(req) {
  const trust = app.get("trust proxy");
  if (typeof trust !== "number" || trust < 1) return;   // only the hop-count form is checkable
  const xff = req.headers["x-forwarded-for"];
  if (!xff) return;
  const hops = String(xff).split(",").length;
  if (hops <= trust) return;
  const t = Date.now();
  if (t - _hopWarnAt < 60_000) return;
  _hopWarnAt = t;
  log.warn({ trust_proxy: trust, xff_hops: hops, resolved_req_ip: req.ip, path: _scrubLogPath(req.path) },
    "X-Forwarded-For carries MORE hops than TRUST_PROXY trusts — req.ip is a PROXY's address, not the client's, so every visitor shares one rate-limit bucket and one scanner counter. Set TRUST_PROXY to the real hop count.");
}

let _insecureCookieWarnAt = 0;
function _warnInsecureSessionCookie(req) {
  const t = Date.now();
  if (t - _insecureCookieWarnAt < 60_000) return;
  _insecureCookieWarnAt = t;
  // NOTE the argument order: lib/log.js takes (context, message), not the other
  // way round — passing them reversed drops every field SILENTLY, which is
  // precisely the failure this line exists to prevent. Caught by its own lock.
  log.error({
    // Scrubbed although the only caller today is GET /api/csrf-token (a constant
    // path): v8.13.3's log-sink scanner requires every request path a sink logs to
    // pass through `_scrubLogPath`, so a future caller cannot quietly carry a
    // capability-bearing path into app.jsonl through this diagnostic.
    path: _scrubLogPath(req.path),
    x_forwarded_proto: req.headers["x-forwarded-proto"] || null,
    req_protocol: req.protocol,
    trust_proxy: String(app.get("trust proxy")),
    base_url: BASE_URL,
    secure_cookie: SECURE_COOKIE,
  }, "session cookie SUPPRESSED — the app believes this connection is not secure, so express-session will not send it and every subsequent request will fail CSRF. Fix the reverse proxy (X-Forwarded-Proto: https) or TRUST_PROXY.");
}
// v7.15.6 (ext-audit HIGH) — enforce the purge tombstone at PERSISTENCE time.
//
// v7.15.2 checked `wasSessionPurged()` in the slide middleware, i.e. at request
// ENTRY. That is the wrong moment: the purge that matters happens WHILE a
// request is in flight (an admin re-logs in elsewhere, or is blocked/demoted),
// so the entry check has already passed. The store's `set()` is an
// unconditional `INSERT ... ON CONFLICT DO UPDATE`, so express-session's save at
// res.end RE-CREATES the row the purge just deleted — and the resurrected row
// still carries the pre-purge identity, so the "single session per user" and
// block/demote guarantees fail OPEN. The external auditor reproduced a deleted
// admin session reappearing and getting HTTP 200 on an admin endpoint.
//
// The entry check is kept (it avoids pointless writes), but THIS is the
// authoritative one: no code path — the slide, an impersonation marker, a CSRF
// token rotation, or any future session write — can resurrect a tombstoned id,
// because every one of them funnels through store.set().
const _sessionStore = new SQLiteStore();
const _storeSet = _sessionStore.set.bind(_sessionStore);
_sessionStore.set = function (id, data, callback) {
  if (wasSessionPurged(id)) {
    // Report success: the caller (express-session at res.end) has nothing
    // useful to do with an error here, and the desired end state — no row —
    // already holds. Throwing would only surface as an unhandled save error.
    if (typeof callback === "function") callback();
    return;
  }
  return _storeSet(id, data, callback);
};

// v8.11.1 (external audit F1) — AND THE SAME RULE ON THE WAY OUT.
//
// The block above closes the class for a session somebody ELSE revoked, because
// `invalidateOtherSessions` and the expiry GC both call `markSessionPurged`
// first. LOGOUT called neither: `req.session.destroy()` reaches the store's
// plain `DELETE FROM express_session`, no tombstone is written, and the guard
// above has nothing to recognise — so a request already in flight on the same
// cookie saves at `res.end`, the wrapper waves it through, and the store's
// `INSERT … ON CONFLICT DO UPDATE` RE-CREATES the row carrying the pre-logout
// identity. The resurrected row then slides forward on every later write, so it
// is revived permanently rather than until the original cookie deadline.
//
// MEASURED on the pure production path, no test hook: a multipart body trickled
// to `POST /admin/attachment-staging` over 2.5 s, Logout fired at +600 ms; the
// upload answered 400 "not a valid ZIP", the row came back, and `/api/admin/me`
// answered 200 superadmin afterwards. It reaches a SINGLE TAB: `doLogout` calls
// `location.reload()` immediately, which ABORTS the in-flight request — and an
// aborted request still runs to completion server-side and still saves.
//
// Wrapping `destroy` rather than patching the two logout handlers is the whole
// point: there are FOURTEEN `req.session.destroy()` sites across routes/ and
// lib/, plus `regenerate()`'s internal destroy, and the next one is added by
// somebody who has never read this comment. Every one of them funnels through
// here, exactly as every write funnels through `set`.
//
// Tombstoning `regenerate()`'s old id is correct and not incidental: that id is
// never written again either, and the new session gets a new id which is not
// tombstoned. The retention is the same derived bound the purge path uses
// (`REVOCATION_RETENTION_MS`, swept by the session GC), so the extra row per
// logout and per login is reclaimed on the same schedule.
const _storeDestroy = _sessionStore.destroy.bind(_sessionStore);
_sessionStore.destroy = function (id, callback) {
  markSessionPurged(id);
  return _storeDestroy(id, callback);
};

app.use(session({
  name: SESSION_COOKIE_NAME,
  store: _sessionStore,
  secret: SESSION_SECRET,
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 60 * 60 * 1000, httpOnly: true, sameSite: "lax", secure: SECURE_COOKIE }
}));

// THE THIRD ENFORCEMENT POINT OF THE TOMBSTONE, after persistence (`set`) and the
// way out (`destroy`): THE WIRE. A request whose session was revoked while it was
// in flight still holds the dead id in `req.sessionID`, and the slide marked the
// session modified, so express-session's header hook re-sends that id's cookie
// with the late response — and a browser that meanwhile got a REPLACEMENT session
// (a sign-in or view toggle in another tab) has it
// overwritten and is signed out. So the one `Set-Cookie` entry that carries a
// tombstoned id is dropped at header time, after any purge; every other entry
// passes (a clear, another id). A regenerated request holds its NEW, untombstoned
// id and keeps its cookie, and a live session keeps its sliding re-stamp. The
// tombstone read fails open: dropping a live session's cookie on a DB hiccup
// would expire an active browser.
function _dropRevokedSessionCookie(req, res, next) {
  const _set = res.setHeader.bind(res);
  res.setHeader = function (name, value) {
    if (typeof name === "string" && name.toLowerCase() === "set-cookie" && typeof req.sessionID === "string") {
      const all = Array.isArray(value) ? value : [value];
      if (all.some(c => setCookieCarriesSession(c, req.sessionID)) && wasSessionPurged(req.sessionID)) {
        const kept = all.filter(c => !setCookieCarriesSession(c, req.sessionID));
        if (!kept.length) { res.removeHeader("Set-Cookie"); return res; }
        value = kept;
      }
    }
    return _set(name, value);
  };
  next();
}
app.use(_dropRevokedSessionCookie);

// ext-audit v7.20.9 (F6) — the scanner-reputation BLOCK, mounted here rather
// than beside its counter so it can read req.session and exempt a signed-in
// admin. See _scannerBlockMiddleware for the full reasoning. Note
// `saveUninitialized:false`: a request refused here still writes no session row,
// so the "one row per anonymous /api/csrf-token" amplification the early block
// used to prevent does not come back — /api/csrf-token is a route, and every
// route is still behind this.
app.use(_scannerBlockMiddleware);

// v7.14.0 — participant-impersonation write gate. Mounted immediately after the
// session middleware, BEFORE any route, so a regular admin impersonating a
// participant is read-only BY CONSTRUCTION: every state-changing /api request
// (minus the navigation/telemetry allowlist in lib/impersonation.js) is
// rejected with 403 "Not allowed in impersonation mode". Superadmin-origin
// impersonation passes through (the SPA fronts writes with an are-you-sure
// confirm). No-op for non-impersonation sessions. v8.12.1 — the SAME gate
// covers an event admin's panel opened through impersonation: the session is
// admin-shaped there and every `/api/admin` write goes through this exact
// tier test, so a regular admin reads the organiser's panel and changes
// nothing, and a superadmin's writes are confirmed and attributed.
app.use(impersonationGuard);

// v8.7.0 — the event-admin DEFAULT-DENY route gate. Mounted immediately after
// impersonationGuard, BEFORE any route, so an `/api/admin/*` endpoint that has
// not been classified for this tier is REFUSED rather than silently reachable.
// That is what makes the role safe to extend one file at a time: at every
// intermediate state an unclassified route fails closed. The handler still owns
// the row-level answer; this only decides whether the endpoint is theirs at all.
// It is a no-op for every other actor, and returns early for a PARTICIPANT-
// SHAPED impersonation (where req.session.userId is the TARGET and no admin
// route is reachable anyway). v8.12.1 — an ADMIN-SHAPED impersonation (an event
// admin's panel through their seat) is gated like the organiser themselves:
// `req.session.userId` is the seat, so the classification and the scope are
// the target's own, which is the whole point of looking through their eyes.
app.use(eventAdminGuard());

// v8.13.3 (QAB-1) — THE ADMIN QUERY-STRING BOUNDARY. Express 5's 'simple' query
// parser turns a REPEATED key into a string[], and better-sqlite3 spreads an array
// into positional binds: `/api/admin/submissions?competitionId=a&competitionId=b`
// was a generic 500 with an error-level stack line, and the same shape broke the
// admin leaderboard (before its scope check, so for an event admin too), the
// participants list and picker, the tasks list and the analytics window — and,
// where a site coerced instead of binding, gave a SILENT wrong answer (the two
// exports went platform-wide, a logs group filter matched nothing). v7.7.38 H3
// fixed this one site at a time and the class survived everywhere else, so it is
// refused here, once, for every /api/admin/ route — present and future. A repeated
// scope id is ambiguous ("which event?"), and a named entity is refused, never
// narrowed or widened (the v8.7.0 rule).
//
// SCOPED TO AN ADMIN-SHAPED SESSION, deliberately. Mounted globally, the refusal
// would run before route matching and before requireAdmin: an anonymous caller
// would get 400 where requireAdmin answers 401, and an UNROUTED
// /api/admin/<junk>?a=1&a=2 would get 400 instead of the router's 404 — which
// lib/scanner-classify.js counts as 'other' rather than 'probe', quietly taking
// probe evidence away from the scanner silence/early-block decision. Gated on
// `isAdmin` (set for every admin tier, the built-in superadmin and an organiser's
// impersonated panel; cleared in participant view), so everybody else meets
// exactly the answer they met before. After eventAdminGuard, so an event admin on
// a FORBIDDEN route still hears that refusal rather than this one.
//
// normaliseRoutePath, not req.path: Express routes /API/admin/... and
// /api//admin/... case-insensitively and non-strictly (the v7.15.16 rule).
app.use((req, res, next) => {
  if (!req.session || !req.session.isAdmin) return next();
  if (!normaliseRoutePath(req.path).startsWith("/api/admin/")) return next();
  return refuseRepeatedQuery(req, res, next);
});

// ── Sliding session expiry on genuine activity (v7.14.4) ────────────────────
// BUG THIS FIXES: an actively-working user was signed out exactly 60 minutes
// after LOGIN, no matter how much they were doing. Reported from production by
// an admin who was adding challenges to competitions and got bounced to the
// login screen ~2.5 minutes after a successful write.
//
// Why it happened: `express-session-better-sqlite3` implements no `touch()`
// method, so express-session's touch branch (`storeImplementsTouch && …`) is
// dead code here — the STORED `cookie.expires` is never slid on an ordinary
// request. `rolling` wouldn't help either: it only re-sends the Set-Cookie
// header, while the stale `expires` comes back from the store on the next
// request. And `req.session.touch()` alone persists nothing, because
// express-session's `isModified()` hash deliberately excludes `cookie`, so
// `shouldSave()` stays false. Net effect: the ONLY thing that could extend a
// session was the client's `POST /api/session/keepalive`, which fires from a
// 30-second poll gated on DOM-activity heuristics. Any tab where that poll was
// dead, throttled, or failing silently hit the hard 60-minute wall mid-work
// with no warning — a single client-side point of failure for staying logged in.
//
// The fix: slide expiry server-side on requests that can only come from a real
// person doing something — authenticated, state-changing (`POST`/`PUT`/`PATCH`/
// `DELETE`) `/api` calls. You cannot idle your way into a POST, so this keeps
// the inactivity timeout honest: a parked tab only issues background GET polls
// (`/api/session/status`, `/api/status`, `/api/me`, leaderboard, admin lists),
// none of which slide anything, so it still expires on schedule. The client
// keepalive stays as-is and remains the mechanism that covers read-only
// browsing; this makes it a belt-and-braces rather than the only line.
//
// Excluded: the endpoints that own their own session lifecycle. They
// regenerate() or destroy() the session mid-request, so touching + saving it
// underneath them would either resurrect a row that was about to be destroyed
// or write to the pre-regeneration id.
//
// v8.8.25 — AND A SECOND CLASS: A NON-GET THAT NO HUMAN PRESSED.
//
// The invariant above is "you cannot idle your way into a POST", and that is the
// whole of why a write is trustworthy evidence that a person acted. It was not
// TRUE: three POSTs are fired by a TIMER or by the tab going away, and every one
// of them slid the session.
//
// The residual v7.14.5 recorded — "a read-only user, outside a live competition,
// whose client monitor is dead" — prescribed a DENYLIST over the GET polls. That
// remedy is unnecessary and was aimed the wrong way: every interval-driven read
// in `public/js` is a GET, and no GET slides, deliberately (a parked tab polls
// for ever, so sliding on reads would make the inactivity timeout a dead
// control). The hole that is actually open is the mirror image — non-GETs that
// are not human acts:
//
//   • `/api/tasks/:id/navigated-away` — fired from the `visibilitychange`→hidden
//     handler and from `pagehide` (`public/js/core/main.js`). Backgrounding a tab
//     is the OPPOSITE of working in the app, and it is exactly the v7.14.5
//     scenario: a participant who backgrounds the Arena tab to sit in their IDE
//     slid their session ON THE WAY OUT. It carries a path parameter, so a
//     literal entry here could never match — it is regex-matched in
//     `_shouldSlideSession` below, beside the impersonate arm.
//   • `/api/dismiss-ended` — fired once at the ended transition from the 15 s
//     `/api/status` poll, via `handleCompetitionEnded`. No human act at all: the
//     clock ran out and a timer noticed.
//
// DELIBERATELY NOT LISTED: `/api/select-competition`. The picker poll can reach
// it (transition-gated — it returns early unless the `/api/my-competitions`
// payload changed), but it is also the endpoint a participant hits when they
// CLICK an event card, which is unambiguously a person acting and is the common
// case by far. Skipping it would DELETE a legitimate slide from every
// participant entering an event — a worse failure than the residual it closes,
// and the wrong direction: this list exists to stop a slide nobody earned, never
// to withhold one somebody did.
const _SESSION_SLIDE_SKIP = new Set([
  "/api/login", "/api/logout", "/api/admin/logout", "/api/register",
  "/api/auth/code/redeem", "/api/auth/password", // regenerate their own session
  "/api/toggle-admin-view", "/api/impersonation/exit",
  "/api/session/keepalive", // already touches + saves itself
  // v8.8.25 — poll-driven, not human-driven. See the second class above.
  "/api/dismiss-ended",
]);
const _SESSION_SLIDE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Slide a session's expiry so BOTH halves move: the stored row AND the browser's
// cookie. `touch()` alone does neither reliably, and that asymmetry is the actual
// production bug:
//
//   • The stored row needs a write, and this store has no `touch()`, so
//     express-session's touch branch never runs.
//   • The BROWSER needs a fresh `Set-Cookie` with a later `Expires`. Whether one
//     is emitted comes down to `shouldSetCookie()`, which for a same-id session
//     is `rolling || (cookie.expires != null && isModified(session))` — and
//     `isModified()` hashes the session with the `cookie` property EXCLUDED. So
//     changing only the expiry is invisible to it: no `Set-Cookie`, and the
//     browser keeps counting down to the ORIGINAL deadline. That is why
//     `POST /api/session/keepalive` — the entire mechanism meant to keep people
//     signed in — was a no-op from the browser's point of view, giving every
//     session an ABSOLUTE ~60-minute life anchored at login rather than an idle
//     timeout. Sliding only the row would have left that bug fully intact and
//     merely hidden it from server-side assertions.
//
// Mutating one DATA field is what makes `isModified()` true, which gets us the
// refreshed `Set-Cookie` AND makes express-session persist the row itself at
// response end (no explicit save, so no double write and no racing callback).
//
// NB: do NOT "simplify" this to `rolling: true`. That re-stamps the browser
// cookie on every response but never updates the stored row (no `touch()`), so
// `_sweepExpiredSessions` would start DELETING sessions of people still working
// ~60 minutes after login — the same bug with the sides swapped.
function _slideSession(req) {
  req.session.touch();                       // new cookie.expires in memory
  req.session.slidAt = Date.now();           // DATA change => Set-Cookie + save
}
function _shouldSlideSession(req) {
  if (!_SESSION_SLIDE_METHODS.has(req.method)) return false;
  // Lowercased for the same case-insensitive-routing reason as the auth-body
  // cap + the impersonation guard: Express dispatches `/API/…` to the same
  // handler, and here a missed match would silently drop the slide.
  // v7.15.17 — normaliseRoutePath, not bare toLowerCase. This was the FOURTH
  // path gate and the one v7.15.16 missed while migrating the other three, even
  // though its own comment above cites them. Direction matters here: for the
  // body-parser lookups a missed match fails CLOSED, but a missed match here
  // fails OPEN — the slide (a session DATA write) then runs on exactly the
  // endpoints that regenerate() or destroy() their session mid-request.
  // Reproduced on v7.15.16: `POST /api/register/` emitted a refreshed
  // Set-Cookie where `POST /api/register` correctly did not.
  const p = normaliseRoutePath(req.path);
  if (!p.startsWith("/api/")) return false;
  if (_SESSION_SLIDE_SKIP.has(p)) return false;
  if (p.startsWith("/api/test/")) return false;
  // `/api/admin/participants/:id/impersonate` regenerates the session too.
  if (/^\/api\/admin\/participants\/[^/]+\/impersonate$/.test(p)) return false;
  // v8.8.25 — `/api/tasks/:id/navigated-away` is fired by the tab going away
  // (`visibilitychange`→hidden and `pagehide`), which is the opposite of a human
  // acting in the app. A path parameter, so it cannot live in the literal Set;
  // matched here for the same reason the impersonate arm is. Both run against
  // `normaliseRoutePath(p)`, so the v7.15.16/v7.15.17 variant hardening covers
  // them — a `/API/tasks/<id>/navigated-away/` spelling is skipped too.
  if (/^\/api\/tasks\/[^/]+\/navigated-away$/.test(p)) return false;
  return true;
}
app.use((req, res, next) => {
  if (!req.session) return next();
  const authed = !!req.session.userId || req.session.builtinId === "superadmin";
  if (!authed || !_shouldSlideSession(req)) return next();
  // v7.15.2 (audit): never slide a session that has already been PURGED. The
  // slide is a data write, so express-session would persist it at res.end and
  // the store's INSERT ... ON CONFLICT would resurrect the row — handing a
  // long-running request the power to undo a sign-out-elsewhere or an expiry
  // GC that happened while it was still in flight.
  if (wasSessionPurged(req.sessionID)) return next();
  try { _slideSession(req); } catch (_err) { /* never let sliding break the request */ swallowed("server:session-slide", _err); }
  next();
});

// ── v8.1.0 (PR 34) — NET ACTIVE TIME ────────────────────────────────────────
//
// Counts five-minute buckets a participant was actually on the platform. Runs on
// any authenticated request carrying `X-Client-Active`, which the SPA sets only
// when there has been real user INTENT recently — see `core/api.js`. A poll from
// a tab nobody is looking at carries no header and counts nothing, which is the
// whole point: elapsed time already measures "the event was running".
//
// Everything about this is designed to be cheap and to fail quietly. It is the
// last thing before the route, it never throws into the request, and when
// `measure_presence` is off (the default, and every event that predates this)
// the cost is one property read.
app.use((req, res, next) => {
  try { _recordPresenceIfActive(req); } catch (_err) { /* never let presence break a request */ swallowed("server:presence", _err); }
  next();
});

/**
 * v8.3.11 — the ACTION allow-list. The rule it encodes: an ACTION endpoint
 * counts WITHOUT `X-Client-Active`, because the request itself is the
 * evidence; a POLLED endpoint counts only WITH it. Reasoning and the
 * fail-closed argument for an allow-list: CLAUDE.md, *Presence needs
 * corroboration, and the header was the only evidence*.
 *
 * A request on this list is its own evidence that a human acted, so it counts a
 * bucket whether or not the client declared itself active. Matched on METHOD plus
 * a normalised path, so `/API/tasks/` cannot slip past the way v7.15.16 records a
 * raw-path comparison doing — over-normalising is the safe direction here, since
 * the worst it can do is count a request that was going to count anyway.
 *
 * The id segment is matched as a shape rather than resolved: this runs before the
 * route layer, so `req.route` is not populated yet and a database read to confirm
 * the task exists would be a per-request cost for a metric.
 */
const _PRESENCE_ACTION_EXACT = new Set(["get /api/tasks"]);
const _PRESENCE_ACTION_PATTERNS = [
  { method: "post", re: /^\/api\/tasks\/[^/]+\/submit$/ },
  { method: "post", re: /^\/api\/tasks\/[^/]+\/hint$/ },
  { method: "put",  re: /^\/api\/tasks\/[^/]+\/feedback$/ },
  { method: "get",  re: /^\/api\/tasks\/[^/]+$/ },
];
function _isPresenceActionRequest(req) {
  const method = String(req.method || "").toLowerCase();
  const p = normaliseRoutePath(req.path || "");
  if (_PRESENCE_ACTION_EXACT.has(`${method} ${p}`)) return true;
  return _PRESENCE_ACTION_PATTERNS.some(x => x.method === method && x.re.test(p));
}

/**
 * The gate. Split out so the middleware above stays one line and this can be
 * read as a list of reasons NOT to count.
 */
function _recordPresenceIfActive(req) {
  // ── v8.3.11 — THE HEADER IS A CLIENT ASSERTION, AND IT WAS THE ONLY EVIDENCE ──
  //
  // The design specified two ways a request qualifies: an ACTION endpoint counts
  // WITHOUT the header, "because the request itself is the evidence"; a POLLED
  // endpoint counts only WITH it. Only the second half was
  // ever built, so every route needed the header — and since the presence
  // tie-break ranks LOWER first among score-tied finishers, a client that simply
  // omitted one header scored a perfect ZERO and WON the tie against an honest
  // participant. Zero is not reachable honestly: the floor for someone who did
  // anything at all is one bucket.
  //
  // The likelier victim is not a cheat, and it is why this is worth fixing rather
  // than documenting: a corporate proxy or WAF that strips unknown request headers
  // zeroes an HONEST participant and thereby rewards them, silently, with nothing
  // on any screen saying why. §14 states as fact that "a stripped header degrades
  // the metric rather than zeroing it" — which was true of the design and false of
  // the code.
  //
  // AN ALLOW-LIST, NEVER A POLL DENY-LIST. v7.14.5's warning about the session
  // slide applies verbatim: misclassify one polled endpoint in a deny-list and a
  // parked tab accrues presence forever, which is the measurement being defended.
  // An allow-list fails CLOSED — an endpoint invented later is simply not in it,
  // so the worst case is the pre-v8.3.11 behaviour for that route.
  //
  // WHY THESE FIVE AND NOTHING ELSE. Each is issued only by a human doing
  // something: submitting, buying a hint, rating a challenge, opening the
  // challenge list, opening one challenge. Critically, NONE of them is polled —
  // `loadTasks` runs on navigation, on an ended-transition and after a submit,
  // never on a timer, so a tab left open issues none of these. The 15-second
  // `/api/status` poll and the leaderboard poll are deliberately absent and still
  // require the header.
  if (req.get("X-Client-Active") !== "1" && !_isPresenceActionRequest(req)) return;
  const userId = req.session?.userId;
  const compId = req.session?.competitionId;
  if (!userId || !compId) return;

  // IMPERSONATION NEVER ACCRUES. An admin looking at a participant's view must
  // not add to that participant's time on the platform — the same rule that keeps
  // impersonation out of `login_time` and out of analytics (v7.14.0).
  if (req.session.impersonator) return;

  const comp = getCompetition(compId);
  if (!comp || !comp.measure_presence) return;

  // ── ONLY A LIVE EVENT ACCRUES ────────────────────────────────────────────
  //
  // A finished event stops counting and so does one that has not begun. Status
  // is time-derived, so neither end needs a hook — the moment it stops reading
  // `live`, writes stop.
  //
  // THE TEST IS POSITIVE, AND DELIBERATELY NOT AN ENUMERATION OF THE STATUSES
  // THAT ARE NOT LIVE. An `!== "ended"` gate counted the LOBBY:
  // `select-competition` sets the session for an UPCOMING event (the countdown
  // page), and the SPA's keepalive carries `X-Client-Active` whenever a human is
  // present — so a participant who arrived early banked one bucket every five
  // minutes before a single challenge existed. Under `time_basis='presence'` the
  // finishers-only comparator ranks LOWER presence better, so on a score tie the
  // EARLY ARRIVER was ranked below the punctual one, and the exported "Time on
  // Platform" could exceed "Time to Solve", which reads as a data bug. Written
  // positively, a status value invented later fails CLOSED rather than counting.
  //
  // THIS IS THE SYMMETRY WITH `_stampLoginTimeIfLive` (lib/middleware.js): the
  // solve clock refuses to anchor before the entity is live for exactly this
  // reason, and two clocks answering different questions about "has this
  // started?" is the inconsistency being fixed. The rule is therefore its rule
  // verbatim — for a multi-slot competition the participant's OWN slot governs,
  // so someone whose session has not opened yet accrues nothing while another
  // cohort is running. A session id that names a deleted or foreign slot falls
  // back to the competition, matching what `requireCompetitionContext` leaves in
  // `req.timeslot` once it has cleared such a value.
  const _ts = req.session.timeslotId ? getTimeslot(req.session.timeslotId) : null;
  const live = (_ts && _ts.competition_id === compId)
    ? timeslotStatus(_ts) === "live"
    : competitionStatus(comp) === "live";
  if (!live) return;

  // ── A FIRST-OPEN CLOCK THAT HAS NOT STARTED ──────────────────────────────
  //
  // On an event whose solve clock starts at the participant's first open of a
  // scoring challenge (lib/event-policy.js `clockStartsAtFirstOpen`), time
  // spent before it is not theirs to be measured on: the solve clock does not
  // count it, so neither does the platform clock, or "Time on Platform" would
  // exceed "Time to Solve" for exactly the participant who read the list first.
  if (clockStartsAtFirstOpen(comp)
      && !db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=? AND login_time IS NOT NULL").get(compId, userId)) return;

  // ── THE COMPLETION FREEZE ────────────────────────────────────────────────
  //
  // THIS IS THE RULE NOBODY WOULD WRITE UNPROMPTED, and without it the feature
  // is actively unfair. Net active time breaks score ties; a participant who
  // finishes and then stays on the platform reading the leaderboard keeps
  // accruing, while one who finishes and closes the tab does not. So on a tie
  // the leader who sticks around LOSES to a slower finisher who left — the
  // opposite of what the number is supposed to reward.
  //
  // Once they are finished, their clock stops. `participantsFinishedAll` is the
  // shared predicate (solved OR out of attempts), so a capped event freezes an
  // exhausted participant too — they cannot do anything more either.
  const total = publishedTaskCount(compId);
  if (total > 0 && participantsFinishedAll([userId], compId, total)) return;

  recordPresence(compId, userId);
}

// /docs/ mount, gated on admin session for the admin + superadmin guides
// and their role-specific screenshots (v6.3.2). README.md + participant.md
// + participant screenshots remain public so a not-yet-registered visitor
// can still read "how do I sign up and start solving". The auth gate sits
// BEFORE the express.static handler so the file is never served without
// the session check. 401 keeps parity with the other admin-only endpoints
// — the help-viewer client (public/help.js) looks for that status and
// renders a "sign in as admin to view this guide" message instead of a
// raw 404.
// ext-audit v7.15.12 — shared with the static handler's setHeaders so the
// caching policy and the auth policy can never disagree about which docs are
// gated.
// ext-audit v7.15.16 — normalise BEFORE matching. `express.static` collapses a
// doubled slash, so testing the raw path let `/docs//user-guide/superadmin.md`
// serve the superadmin guide — which names the built-in account and the on-disk
// password path — to an anonymous caller. See normaliseRoutePath in lib/util.js.
// v8.5.0 — the release notes join the gated set, and the reason is the same one
// that makes the header button admin-only: the notes describe operator-facing
// capability, and offering a control the server is certain to refuse is the
// v7.14.2 defect. Gating here and hiding the button there are ONE decision, taken
// from the same predicate on both sides (`S.isAdmin || S.isSuperAdmin` in the SPA,
// a live admin row here) — so a participant who guesses the URL meets the same
// answer the button's absence already gave them.
function _docsPathNeedsAdmin(rawPath) {
  const p = normaliseRoutePath(rawPath);
  return /^\/user-guide\/admin\.md$/.test(p)
      || /^\/user-guide\/superadmin\.md$/.test(p)
      // v8.7.0 — the event-admin guide is gated with its siblings. It names the
      // organiser surface and the refusals that bound it, which is operator-facing
      // capability; it is served to every admin tier, event admins included
      // (_gateAdminDocs admits `event_admin`), and to nobody else.
      || /^\/user-guide\/event-admin\.md$/.test(p)
      || /^\/release-notes\.md$/.test(p)
      || /^\/screenshots\/admin\//.test(p)
      || /^\/screenshots\/event-admin\//.test(p)
      || /^\/screenshots\/superadmin\//.test(p);
}
function _gateAdminDocs(req, res, next) {
  const p = req.path || ""; // relative to the /docs mount
  const needsAdmin = _docsPathNeedsAdmin(p);
  if (needsAdmin) {
    // v7.2.x (audit, F6) — DB-backed lifecycle re-check, not the stale
    // `session.isAdmin` flag. requireAdmin already re-reads the user row on
    // every request and rejects a demoted/blocked/denied/unverified/unapproved
    // admin; the docs gate must match. Pre-fix, an admin demoted out-of-band —
    // e.g. a participant-import role/lifecycle overwrite, which does NOT purge
    // sessions — kept reading gated guides + screenshots until session expiry.
    // The built-in superadmin (builtinId, no user row) is always live.
    let liveAdmin = false;
    if (req.session?.builtinId === "superadmin") {
      liveAdmin = true;
    } else if (req.session?.userId) {
      // Any signed-in account, not only an admin VIEW: an organiser in
      // Participant View still opens their own guide (the help drawer routes an
      // event admin to it whatever the view), and the class below decides.
      const u = db.prepare("SELECT role, blocked, denied_at, verified, approved FROM users WHERE id=?").get(req.session.userId);
      // v8.7.0 — `event_admin` is an admin tier for the purposes of the in-app
      // guides, EXCEPT the superadmin one. That guide names the built-in
      // superadmin account and the on-disk path of its password file, which a
      // scoped organiser has no business reading — and widening the gate here
      // without the carve-out would have handed it to them, which is how a tier
      // addition silently becomes a disclosure. A plain `admin` keeps the access
      // it has always had; only the new tier is excluded.
      const _wantsSuperGuide = /^\/user-guide\/superadmin\.md$/.test(normaliseRoutePath(p))
                            || /^\/screenshots\/superadmin\//.test(normaliseRoutePath(p));
      // RBAC — by class: the superadmin guide to the unscoped (`all`) roles, the
      // rest to every admin-class role.
      const _cls = u ? require("./lib/rbac").roleClass(u.role, { live: true }) : "none";
      const _tierOk = _wantsSuperGuide ? _cls === "all" : _cls !== "none";
      const _impDocs = req.session.impersonator || null;
      if (_impDocs) {
        // v8.12.1 — AN IMPERSONATED ADMIN VIEW IS THE ORGANISER'S SEAT, and the
        // guides follow the seat's tier (an event admin's: never the superadmin
        // guide). Two things differ from the plain branch, both for the reason
        // `requireAdmin`'s forced exit gives: the TARGET's `verified` is NOT
        // asked (v7.15.8 admits an unverified target, and the entry, the toggle
        // and requireAdmin all agree on the four columns — this gate was the
        // one that did not, so an unverified organiser's seat was DOWNGRADED
        // the moment the SPA fetched a guide, into the flags-cleared /
        // marker-intact strand every later admin request then 403'd from);
        // and the ACTING admin's row is re-read too (a demoted ex-admin must
        // not keep reading gated guides through a seat). On failure the flags
        // are LEFT ALONE — the forced exit belongs to requireAdmin, which
        // restores the acting admin and closes the window; a docs gate that
        // clears the flags strands the session with no exit.
        const _a = _impDocs.builtinId === "superadmin" ? { ok: true }
          : (_impDocs.userId ? db.prepare("SELECT role, blocked, denied_at, verified, approved FROM users WHERE id=?").get(_impDocs.userId) : null);
        const _actingLive = !!(_a && (_a.ok || (require("./lib/rbac").roleClass(_a.role, { live: true }) === "all" && !_a.blocked && !_a.denied_at && _a.verified && _a.approved)));
        liveAdmin = !!(u && !u.blocked && !u.denied_at && u.approved && u.role === "event_admin" && _tierOk && _actingLive);
      } else {
        liveAdmin = !!(u && !u.blocked && !u.denied_at && u.verified && u.approved && _tierOk);
        if (!liveAdmin && req.session.isAdmin) { req.session.isAdmin = false; req.session.isSuperAdmin = false; }
      }
    }
    if (!liveAdmin) {
      return res.status(401).json({ error: "Authentication required. Sign in as an admin to view this guide." });
    }
  }
  return next();
}
// v6.8.2: same content-hash cache policy as /public. Markdown files are
// served from _mdCache (rewritten image URLs include ?v=<hash>). Binary
// assets with the query get immutable year-long caching; direct hits
// without the query fall back to a short 5-minute cache.
function _serveMarkdownHashed(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (!req.path.endsWith(".md")) return next();
  const rewritten = _mdCache.get("/docs" + req.path);
  if (!rewritten) return next();
  res.set("Content-Type", "text/markdown; charset=utf-8");
  // `no-cache` still permits a SHARED cache to store the payload (it only forces
  // revalidation), so a gated guide could sit in a proxy. ext-audit v7.15.12 —
  // admin.md / superadmin.md get private, no-store like their screenshots.
  if (_docsPathNeedsAdmin(req.path || "")) {
    res.set("Cache-Control", "private, no-store");
    res.set("Vary", "Cookie");
  } else {
    res.set("Cache-Control", "no-cache");
  }
  res.send(rewritten);
}
// Asset-versions script body is generated above (before _htmlCache so
// the HTML rewrite includes the ?v=<hash> query). This route just serves
// it with the appropriate cache policy based on the incoming URL.
app.get("/asset-versions.js", (req, res) => {
  res.type("application/javascript");
  const url = req.originalUrl || req.url || "";
  if (url.includes(`?v=${_assetVersionsJsHash}`)) {
    res.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    // Direct hit without the version query — stay cache-shy so a deploy
    // with a fresh hash propagates immediately.
    res.set("Cache-Control", "no-cache");
  }
  res.send(_assetVersionsJsBody);
});

app.use("/docs", _gateAdminDocs, _serveMarkdownHashed, express.static(_DOCS_DIR, {
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    const url = res.req.originalUrl || res.req.url || "";
    // ext-audit v7.15.12 — a GATED doc must never be cached as `public`. The
    // origin correctly 401s an anonymous request, but the successful response
    // for an admin was `public, max-age=31536000, immutable` with no credential
    // variance: a shared/proxy cache could serve those screenshots to anyone,
    // and the admin's own browser kept them for a year after logout or
    // demotion. `private, no-store` for the gated subtree; public docs
    // (participant.md, README, participant screenshots) keep the fast path.
    if (_docsPathNeedsAdmin(res.req.path || "")) {
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Vary", "Cookie");
      return;
    }
    if (/\?v=[a-f0-9]+/.test(url)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.setHeader("Cache-Control", "public, max-age=300");
    }
  },
}));

// Expired-session GC (v6.3.0). express-session-better-sqlite3 never deletes
// expired rows on its own — the `destroy` method only drops a known session
// id, and there's no `touch` / `pruneSessions` hook. That means the
// `express_session` table grows monotonically with every login for the life
// of the process. The issue compounds because invalidateOtherSessions() and
// clearCompetitionSessionForUser() both do `SELECT id, data FROM
// express_session` and JSON.parse each row — O(N_total_sessions_ever) on
// every login. Sweep expired rows every 5 minutes to keep that O(N) bounded.
//
// Design: parse cookie.expires / cookie._expires (both shapes that
// express-session writes) and delete rows that are already past. A single
// transaction keeps the per-sweep cost bounded even with thousands of rows.
// v7.14.1 — extracted from the setInterval below into a named function so a
// test can drive one pass on demand (POST /api/test/sweep-sessions), matching
// the account-reaper / event-retention / attachment-sweep pattern. Returns the
// per-pass counts. Best-effort throughout: the GC must never kill the process.
function _sweepExpiredSessions() {
  let purged = 0, impersonationsClosed = 0, proofsSwept = 0;
  try {
    const rows = db.prepare("SELECT id, data FROM express_session").all();
    const nowMs = Date.now();
    const expiredIds = [];
    // v7.14.1 — an impersonation session that simply times out (60-min cookie,
    // or the admin closed the browser) ends the window too. Collect those so
    // the target's history never keeps an unclosed `impersonation_started`.
    const expiredImpersonations = [];
    for (const r of rows) {
      let parsed;
      try { parsed = JSON.parse(r.data); } catch { expiredIds.push(r.id); continue; }
      const expStr = parsed?.cookie?.expires || parsed?.cookie?._expires || null;
      if (expStr) {
        const expMs = new Date(expStr).getTime();
        if (Number.isFinite(expMs) && expMs < nowMs) {
          expiredIds.push(r.id);
          if (parsed.impersonator && parsed.userId) {
            expiredImpersonations.push({ targetId: parsed.userId, imp: parsed.impersonator });
          }
        }
      }
    }
    if (expiredIds.length) {
      // Tombstone BEFORE the delete (see lib/sessions.js): store.set() consults
      // these, so marking first leaves no window for an in-flight request's save
      // to re-create the row.
      for (const id of expiredIds) markSessionPurged(id);
      const del = db.prepare("DELETE FROM express_session WHERE id=?");
      const tx = db.transaction(() => { for (const id of expiredIds) del.run(id); });
      tx();
      // Emit a single audit row so operators can see GC sweeps in the log.
      // log.info is the global JSONL logger; runs outside any session.
      try { log.info({ purged: expiredIds.length, remaining: rows.length - expiredIds.length }, "Session GC sweep"); } catch (_err) { swallowed("server:best-effort", _err); }
      // Best-effort, post-commit: never let an audit failure break the sweep.
      for (const w of expiredImpersonations) {
        try {
          recordUserEvent(w.targetId, "impersonation_ended", impersonationActor({ impersonator: w.imp }),
            impersonationEndedDetails(w.imp, "session_expired"));
          impersonationsClosed++;
        } catch (_err) { /* best-effort */ swallowed("server:session-gc", _err); }
      }
      purged = expiredIds.length;
    }
    // ext-audit v7.15.7 — reclaim tombstones past their retention window. Done
    // here rather than on a separate timer so there is one session-GC cadence.
    sweepRevokedSessions();
    // Expired address proofs (lib/email-proof.js) ride the same cadence: a dead
    // proof is already refused on read, so this only reclaims rows.
    proofsSwept = sweepExpiredProofs();
  } catch (_err) { /* GC is best-effort; never kill the process */ swallowed("server:session-gc", _err); }
  return { purged, impersonationsClosed, proofsSwept };
}
setInterval(_sweepExpiredSessions, 5 * 60_000).unref();

// Invalidate all other sessions matching a key/value pair (single-session enforcement).
//
// All current call sites are the user's own /api/login — so the "other session"
// being terminated is ALWAYS one of the user's own prior sessions. Emitting a
// separate `logout_single_session` event in that case is redundant with the
// `login_success` event that's recorded a moment earlier and is universally
// confusing in user history (it appears right after login and makes it look like
// the user was just logged out, even though they're still logged in via the
// fresh session). Instead of emitting the event, we return counts to the caller
// so the new login event can include `terminated_sessions` context inline.
//
// Sessions that are already expired or were created within the last few minutes
// (double-submit / duplicate-login races) are purged silently regardless.
// Clear competition-scoped session fields (competitionId, timeslotId) on
// every persisted session that belongs to `userId` AND currently points at
// `competitionId`. Returns the number of sessions that were actually modified.
//
// Used when an admin removes the user from a competition: without this, the
// participant's browser keeps a stale "still in <comp>" UI state until it
// hits a stricter endpoint (tasks / submit / leaderboard all gate on
// requireParticipantInCompetition and will 403 properly — the gap is the
// session-state-reading probes + /api/me that happily echo the stale values
// until the session is touched again). We surgically clear the two fields
// rather than deleting the session so the user stays logged in and lands on
// the competition picker on next request.
// SQLite doesn't give us an index on JSON fields inside the session data
// blob, but the JSON.stringify output is stable enough that a LIKE on the
// exact `"key":"value"` substring is an effective prefilter — the scan is
// still O(N) but SQLite does it in C over tight byte buffers, which is
// ~10× faster than dragging every row through JSON.parse in JS. Safe only
// when the value is a constrained alphabet (UUID / literal "superadmin");
// otherwise fall back to the full scan to avoid LIKE-wildcard injection.
// Single-session enforcement (clearCompetitionSessionForUser,
// invalidateOtherSessions, _extractOldSessionId) + the kicked-session context
// cache (lookupKickedSession) now live in lib/sessions.js (imported at the top
// of this file) — a single process-global instance, with its own .unref'd TTL
// janitor running at module load.

// The in-memory rate limiter (rateLimit + its per-IP buckets + the per-request
// disabled flag) now lives in lib/middleware.js (imported at the top of this
// file). _setTestRateLimitForceEnabled backs the test toggle below;
// _rateLimitBucketCount feeds the /metrics rate_limit gauge.
// Test-only hook. Mounted alongside the other /api/test/* routes when
// NODE_ENV=test. POST { enable: true } turns rate limits ON for the
// process; POST { enable: false } reverts to the env-var behaviour and
// clears the accumulated buckets so a previous test's counts don't spill
// into the next.
if (process.env.NODE_ENV === "test") {
  app.post("/api/test/rate-limit-toggle", express.json(), (req, res) => {
    const enabled = _setTestRateLimitForceEnabled(!!(req.body && req.body.enable));
    res.json({ ok: true, enabled });
  });
  // v7.29.0 — drive ONE janitor pass on demand. The sweep used to be an
  // anonymous arrow inlined into setInterval, so nothing could observe it: from a
  // spec the only signals were "did a 429 happen" and the /metrics bucket gauge,
  // and neither distinguishes "the bucket expired on its own window" from "the
  // janitor deleted it early". Same shape as POST /api/test/sweep-sessions.
  app.post("/api/test/rate-limit-sweep", express.json(), (req, res) => {
    res.json({ ok: true, ..._sweepRateLimitBuckets() });
  });
  // v8.8.25 — the sign-in code's per-origin sub-budget lives in PROCESS memory
  // (single-process invariant), so a spec cannot clear it from its own SQLite
  // handle the way it clears `users.login_code_sends`. Without this hook the
  // budget carries across tests in one file and every later assertion measures
  // whatever the previous test spent.
  app.post("/api/test/reset-origin-code-budget", express.json(), (req, res) => {
    const { _resetOriginSpend } = require("./lib/login-code");
    // The address-proof origin share (lib/email-proof.js) is the same budget.
    res.json({ ok: true, cleared: _resetOriginSpend() + _resetProofOriginSpend() });
  });
  // Rewind every bucket's start so a spec can cross a 15-minute window without
  // waiting it out — the POST /api/test/scanner-age-window precedent.
  app.post("/api/test/rate-limit-age", express.json(), (req, res) => {
    const aged = _ageRateLimitBuckets(parseInt(req.body && req.body.ms, 10) || 0);
    res.json({ ok: true, aged });
  });
  // v6.16.9 — invoke the permanent-attachments sweep on demand so the
  // regression test for the recency cutoff doesn't have to wait for
  // the daily setInterval. NODE_ENV=test gate matches the rate-limit
  // toggle above; the function itself is defined unconditionally and
  // only the production-side scheduler is gated behind NODE_ENV.
  // ext-audit v7.15.11 — drive one status-scheduler tick on demand so a test can
  // lock the FIRST-OBSERVATION freeze (an entity first seen already ended) without
  // waiting on the 60-second interval.
  app.post("/api/test/scheduler-tick", (req, res) => {
    try { runStatusSchedulerTick(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Event-owned questions (lib/event-copies.js). `legacy-shared-assign {on}`: the
  // assign doors put the bank question itself into the event, as the previous
  // release did, so a spec can build that database through the real doors.
  // `event-copies-migrate {dryRun}`: run the boot's batch migration now (its
  // marker is not consulted) and bust what it changes, after the commit.
  app.post("/api/test/legacy-shared-assign", (req, res) => {
    require("./lib/event-copies")._setLegacySharedAssignForTest(req.body?.on === true);
    res.json({ ok: true, on: req.body?.on === true });
  });
  app.post("/api/test/event-copies-migrate", (req, res) => {
    const rep = require("./lib/event-copies").migrateSharedTasksToEventCopies(db, { dryRun: req.body?.dryRun === true });
    if (req.body?.dryRun !== true) {
      const ids = rep.events.map(e => e.competition_id);
      for (const cid of ids) { invalidateLeaderboardCache(cid); _invalidateTaskNumbersCache(cid); }
      _invalidateMeCacheForComps(ids);
      invalidateAdminParticipantsCache();
    }
    res.json({ ok: true, ...rep });
  });
  // v7.21.5 — drive ONE reminder-dispatcher tick on demand. The 30 s interval is
  // disabled under NODE_ENV=test, so without this the dispatcher is unreachable
  // from the suite and its only "tests" re-implemented its SQL. Per-invocation
  // options rather than a process-global *-delay setter: a delay left set by one
  // spec is exactly the cross-spec leak that cost 27 CI failures in v7.16.8.
  // v8.15.1 — drive ONE certificate-dispatch pass. The worker never runs by itself
  // under NODE_ENV=test (the shared server's relay is dead by design), so this is
  // the only way a lock reaches it. `{force:true}` treats every job and retry as
  // due, skipping the post-end settle delay and the retry back-off.
  // `{competitionId}` narrows the pass to that event's jobs and retries: the
  // shared relay fails every send, so an unscoped forced pass also renders and
  // re-sends every certificate the file's other events queued. `{maxSends}` (a
  // positive integer) lowers that one pass's per-job send cap, never above
  // MAX_SENDS_PER_PASS, so the cap is provable with a few certificates.
  app.post("/api/test/certificate-dispatch-tick", express.json(), async (req, res) => {
    try {
      const scope = req.body && req.body.competitionId;
      if (scope !== undefined && typeof scope !== "string") return res.status(400).json({ error: "competitionId must be a string" });
      const maxSends = req.body && req.body.maxSends;
      if (maxSends !== undefined && !(Number.isInteger(maxSends) && maxSends > 0)) return res.status(400).json({ error: "maxSends must be a positive integer" });
      const out = await runCertificateDispatch({ force: !!(req.body && req.body.force === true), competitionId: scope === undefined ? null : scope, maxSends: maxSends === undefined ? null : maxSends });
      res.json({ ok: true, ...out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Park every certificate SEND (lib/certificate-dispatch.js `_sendFor`, which
  // every certificate email goes through: grep `_sendFor(`) after its PDF render
  // and before its re-checks, so a test can end the admin's session, or stop the
  // server, while a send is on its way. Its own park, apart from
  // `admin-commit-delay`. `{delayMs}` arms it (0-5000 ms; setting it zeroes
  // `parked`); `{release:true}` lets every parked send go on at once and leaves
  // the setting as it is; the GET answers `{delayMs, parked, enteredAt}`.
  app.post("/api/test/certificate-send-delay", express.json(), (req, res) => {
    const cd = require("./lib/certificate-dispatch");
    if (req.body && req.body.release === true) return res.json({ ok: true, released: cd.releaseTestCertificateSendPark(), ...cd.testCertificateSendDelay() });
    res.json({ ok: true, ...cd.setTestCertificateSendDelay(Math.min(5000, Math.max(0, parseInt(req.body && req.body.delayMs, 10) || 0))) });
  });
  app.get("/api/test/certificate-send-delay", (req, res) => res.json(require("./lib/certificate-dispatch").testCertificateSendDelay()));
  // Event team reports — one pass of lib/team-reports.js; `{force:true}` treats
  // every job as due (skips the 15-minute settle and the 48-hour nudge wait).
  app.post("/api/test/team-report-tick", express.json(), async (req, res) => {
    try {
      const out = await require("./lib/team-reports").runTeamReports({ force: !!(req.body && req.body.force === true) });
      res.json({ ok: true, ...out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Run the SIGTERM drain, `gracefulShutdown` (end of this file), which no signal
  // reaches under NODE_ENV=test: the workers stop starting work at once (a mail
  // pass finishes the send it is on, then stops), the drain waits for them, the
  // database closes and the process exits 0: the only way a lock can reach a
  // pass that a shutdown cuts. Answered after the workers are stopped, on a connection it
  // closes, so the drain never waits for the caller. It ends the process, so it
  // acts only when told to in so many words (`{confirm: "shutdown"}`): a stray
  // or mistaken POST from a spec must never stop a shared worker's server.
  app.post("/api/test/shutdown", (req, res) => {
    if (req.body?.confirm !== "shutdown") return res.status(400).json({ error: 'send {confirm: "shutdown"}' });
    gracefulShutdown("test-shutdown", 0);
    res.set("Connection", "close").json({ ok: true });
  });
  // One start-reminder pass. Answers `held:true` (and claims nothing) while the
  // instance is out of service; `started` counts rows settled unsent because
  // their start had passed.
  app.post("/api/test/reminder-tick", express.json(), async (req, res) => {
    const b = req.body || {};
    try {
      const out = await runReminderTick({
        delayMs: Math.min(5000, Math.max(0, parseInt(b.delayMs, 10) || 0)),
        forceDelivered: !!b.forceDelivered,
      });
      res.json({ ok: true, ...out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // One lockout-expiry pass (the 30 s timer is off under test). Answers
  // `held:true` while the instance is out of service, as the reminder tick does.
  app.post("/api/test/lockout-expiry-tick", express.json(), (req, res) => {
    try { res.json({ ok: true, ...runLockoutExpiryPass() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post("/api/test/sweep-attachments", express.json(), (req, res) => {
    const reaped = _sweepPermanentAttachments();
    // v8.8.15 — the two sweeps that became periodic in the same release. Both
    // are `setInterval` bodies disabled under NODE_ENV=test, so this hook is the
    // ONLY way a lock can drive them; without it the guard that makes the
    // staging file sweep safe to run periodically is asserted by nothing.
    // `stagingRecencyMs` shrinks the in-flight window so the REAPING half is
    // drivable — the `{ttlMs}` idiom /api/test/reap-accounts already uses.
    // Omitted, it is the shipped 5 minutes, which is what the guard test asserts.
    const _rec = Math.min(5 * 60_000, Math.max(0, parseInt(req.body && req.body.stagingRecencyMs, 10) || 0));
    const staging = _sweepStagingFiles(req.body && req.body.stagingRecencyMs != null ? _rec : undefined);
    const uploads = _sweepUploadsTemp();
    res.json({ ok: true, reaped, staging, uploads });
  });
  // v7.15.6 (ext-audit HIGH) — reproduce the session-resurrection race
  // deterministically. The defect needs a request that LOADED the session
  // before the purge and SAVES it after; a sequential test can't produce that
  // (express-session would simply mint a fresh session and the assertion would
  // pass with the fix reverted). This mutates the session, holds the request
  // open while the test purges it from another context, then lets the response
  // — and its save — complete. Returns the session id so the test can watch
  // that exact row.
  // ext-audit v7.15.13 — hold the submit path's file read open for a fixed
  // window so a test can deterministically mutate the challenge DURING it. The
  // race is otherwise unreproducible: readFile on a small file completes in
  // well under a millisecond, so an admin write would never land inside it and
  // the test would pass with the fix reverted.
  app.post("/api/test/submit-read-delay", express.json(), (req, res) => {
    _testSubmitReadDelayMs = Math.min(5000, Math.max(0, parseInt(req.body && req.body.delayMs, 10) || 0));
    _testSubmitReadParked = 0;
    res.json({ ok: true, delayMs: _testSubmitReadDelayMs });
  });
  app.get("/api/test/submit-read-delay", (req, res) => res.json({ delayMs: _testSubmitReadDelayMs, parked: _testSubmitReadParked }));
  // v7.21.23 — block the event loop SYNCHRONOUSLY, on purpose.
  //
  // The submit span excuses time spent waiting for a participant's body, so the
  // case that must not be excused is a server stall that DELAYS that body — the
  // socket cannot be read while the loop is blocked, so it looks identical from
  // the outside. Nothing else in the suite can produce a genuine stall: every
  // other delay hook awaits, which is precisely what this must not do.
  //
  // Responds FIRST, then blocks, so the caller is released and can start the
  // upload it is about to stall. `afterMs` gives it time to do so.
  // v7.21.24 — force a genuine 5xx through the generic error handler.
  //
  // The 500 branch is the case that handler is NAMED for, and it was the one
  // with no coverage at all: nothing in the suite reaches it, so "a server bug
  // is logged with its stack and does NOT leak internals to the caller" could
  // not be asserted. `mode:"async"` throws from an async handler, which Express 5
  // funnels through the same place via a rejected promise — the path 38 async
  // handlers in this codebase depend on. `mode:"after-send"` answers 200 first,
  // then throws: the handler must not write a second response (a double fault);
  // `mode:"after-send-large"` does the same with a body over the compression threshold (8 KB), which
  // compression() gzips for a gzip client; `mode:"after-write"` sends only part
  // of a body first, and `mode:"after-write-bad-end"` then fails in res.end itself.
  app.post("/api/test/throw", express.json(), async (req, res) => {
    const msg = typeof req.body?.message === "string" && req.body.message ? req.body.message : "deliberate test failure";
    if (req.body && req.body.mode === "async") { await new Promise(r => setImmediate(r)); }
    if (req.body && req.body.mode === "after-send") res.json({ sent: true });
    if (req.body && req.body.mode === "after-send-large") res.json({ sent: true, pad: "x".repeat(16384) });
    if (req.body && req.body.mode === "after-write") { res.type("text/plain"); res.write("partial"); }
    if (req.body && req.body.mode === "after-write-bad-end") {
      res.type("text/plain"); res.write("partial");
      try { res.end({ not: "a chunk" }); } catch (e) { throw new Error(`${msg}: ${e.message}`); }
    }
    throw new Error(msg);
  });
  // v8.3.11 — bank N distinct presence buckets for one (event, participant).
  //
  // Needed because presence is quantised to five minutes and the suite has no
  // clock control: within one test every real request falls in the SAME bucket,
  // so two participants who both act end up on exactly one bucket each and no
  // test can manufacture a presence DIFFERENCE. That difference is the only thing
  // that makes a presence tie-break assertion discriminating.
  //
  // Calls the real `recordPresence` with a synthetic instant per bucket, OLDEST
  // FIRST, because the ON CONFLICT branch only increments while
  // `last_bucket < excluded.last_bucket`. So this exercises the production write
  // — including its membership SELECT — rather than reaching past it with an
  // INSERT, and a participant who is not enrolled banks nothing here either.
  app.post("/api/test/presence-seed", express.json(), (req, res) => {
    const { competitionId, userId } = req.body || {};
    const n = Math.min(500, Math.max(1, parseInt(req.body && req.body.buckets, 10) || 1));
    if (typeof competitionId !== "string" || typeof userId !== "string") {
      return res.status(400).json({ error: "competitionId and userId are required" });
    }
    let banked = 0;
    for (let i = n - 1; i >= 0; i--) {
      if (recordPresence(competitionId, userId, now().getTime() - i * BUCKET_MS)) banked++;
    }
    res.json({ ok: true, banked, ms: presenceMs(competitionId, userId) });
  });
  app.post("/api/test/block-loop", express.json(), (req, res) => {
    const blockMs = Math.min(5000, Math.max(0, parseInt(req.body && req.body.blockMs, 10) || 0));
    const afterMs = Math.min(5000, Math.max(0, parseInt(req.body && req.body.afterMs, 10) || 0));
    res.json({ ok: true, blockMs, afterMs });
    setTimeout(() => {
      const until = Date.now() + blockMs;
      while (Date.now() < until) { /* deliberately synchronous */ }
    }, afterMs);
  });
  app.post("/api/test/select-timeslot-delay", express.json(), (req, res) => {
    setTestSelectTimeslotDelay(Math.min(5000, Math.max(0, parseInt(req.body && req.body.delayMs, 10) || 0)));
    res.json({ ok: true });
  });
  // v7.15.17 — send response HEADERS, then stall the BODY. This is the shape the
  // whole "deadline must survive the body" class is about, and it cannot be
  // checked by reading source: the correct implementations deliberately have no
  // body read in the same function (they hand the timer onward), so a scanner
  // has nothing local to reason about. A client that bounds its deadline
  // properly settles here; one that clears at headers hangs for ever.
  app.get("/api/test/stall-body", (req, res) => {
    // v7.15.24 — clients abort this mid-body BY DESIGN, so the socket will emit
    // ECONNRESET here. Without listeners that becomes an uncaught exception and
    // takes the process down; see the twin note on the stalled-body test in
    // functional-security.api.spec.js.
    req.on("error", () => {});
    res.on("error", () => {});
    res.status(200);
    res.set("content-type", "application/json");
    res.flushHeaders();                   // commit the headers on the wire NOW
    res.write(" ");                       // ...plus one byte of body...
    // ...and the body never completes. The socket is closed after a generous
    // ceiling so a leaked request cannot outlive the test run.
    setTimeout(() => { try { res.end("{}"); } catch (_err) { swallowed("server:best-effort", _err); } }, 60_000).unref();
  });
  // v8.12.6 — park an admin upload/import immediately before its commit-time
  // re-check (`adminAuthzDenied`), so a test can revoke the admin INSIDE the
  // post-body window — and, since v8.12.7, the desk shortcut and the seeder before
  // their commit (grep `testAdminCommitPark(` for the set). Setting it
  // resets the `parked` counter; the GET reports how many requests have entered
  // the park, which is the test's readiness signal. `{release:true}` lets every
  // request parked now go on at once and leaves the setting as it is.
  app.post("/api/test/admin-commit-delay", express.json(), (req, res) => {
    if (req.body && req.body.release === true) return res.json({ ok: true, released: releaseTestAdminCommitPark(), ...testAdminCommitDelay() });
    setTestAdminCommitDelay(Math.min(5000, Math.max(0, parseInt(req.body && req.body.delayMs, 10) || 0)));
    res.json({ ok: true, ...testAdminCommitDelay() });
  });
  app.get("/api/test/admin-commit-delay", (req, res) => res.json(testAdminCommitDelay()));
  // The last challenge import's rich-text pass as the server measured it, in CPU
  // time (`_importPassWitness`, beside the import route).
  app.get("/api/test/import-prepass", (req, res) => res.json({ ok: true, pass: _lastImportPass }));
  app.post("/api/test/admin-email-delay", express.json(), (req, res) => {
    setTestAdminEmailDelay(Math.min(5000, Math.max(0, parseInt(req.body && req.body.delayMs, 10) || 0)));
    res.json({ ok: true });
  });
  // The last sign-in code minted for an address (plaintext, in memory, test
  // processes only — lib/login-code `_testLastLoginCode`). Only the hash is
  // stored, so this is how a spec signs in through the real code door.
  app.get("/api/test/last-login-code", (req, res) => {
    const e = _testLastLoginCode(typeof req.query.email === "string" ? req.query.email : "");
    if (!e) return res.status(404).json({ error: "no code minted for that address" });
    res.json({ code: e.code, at: e.at, via: e.via, competition_id: e.competitionId });
  });
  // Rewind an account just created by the email-first registration to a FIXTURE
  // state: unverified (with a live verify_code), never signed in, and pending
  // unless it came through a join link or an invitation. No sign-up creates it
  // any more (an older or imported account can still be in it), and it is only
  // part of what the pre-email-first form left: an ordinary registration was
  // unverified and pending, but an invited one was verified with no verify_code,
  // and a join-link one deferred its join to the first sign-in (`deferJoin`
  // below restores that). tests/helpers.js `registerPost` calls it by default so
  // specs written against that state keep testing what they test; specs about
  // what a sign-up really creates pass `{ keepState: true }`
  // (tests/signup-real-state.api.spec.js pins both). Test processes only.
  app.post("/api/test/registration-legacy-state", express.json(), (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    const u = findUserByPrimary(db, email, "id, approved_by, registration_competition_id");
    if (!u) return res.status(404).json({ error: "no such account" });
    const keepApproved = u.approved_by === "self_enroll" || u.approved_by === "invitation";
    // `deferJoin: true` — the pre-email-first join-link registration also DEFERRED
    // the enrolment to the first sign-in (`pending_self_enroll_comp_id` set, no
    // row). The email-first registration signs in, so it enrols at once: undo
    // that one row and put the marker back, for specs about the deferred consume.
    if (req.body?.deferJoin === true && u.approved_by === "self_enroll" && u.registration_competition_id) {
      db.prepare("DELETE FROM competition_users WHERE competition_id=? AND user_id=?").run(u.registration_competition_id, u.id);
      db.prepare("UPDATE users SET pending_self_enroll_comp_id=?, active_competition_id=NULL WHERE id=?").run(u.registration_competition_id, u.id);
    }
    db.prepare(`UPDATE users SET verified=0, first_verified_at=NULL, verify_code=?, verify_code_at=?,
        login_time=NULL, last_login_time=NULL
        ${keepApproved ? "" : ", approved=0, approved_at=NULL, approved_by=NULL"} WHERE id=?`)
      .run(uuid(), new Date().toISOString(), u.id);
    _invalidateMeCache(u.id);
    invalidateAdminParticipantsCache();
    res.json({ ok: true, id: u.id, approved: keepApproved });
  });
  // Forget the re-send suppression (process-resident), so a spec can request a
  // second code inside two minutes on purpose.
  // Address proofs keep their last send on the row, so it is rewound there too.
  app.post("/api/test/reset-recent-code-sends", (req, res) => {
    const proofs = db.prepare("UPDATE email_proofs SET last_sent_at='1970-01-01T00:00:00.000Z'").run().changes;
    res.json({ ok: true, cleared: _resetRecentSends() + proofs });
  });
  app.post("/api/test/slow-session-write", express.json(), (req, res) => {
    const sid = req.sessionID;
    req.session.slowWriteMarker = Date.now();          // guarantees a save at res.end
    const delay = Math.min(5000, Math.max(0, parseInt(req.body && req.body.delayMs, 10) || 500));
    setTimeout(() => { res.json({ ok: true, sid }); }, delay);
  });
  // v7.14.1 — drive one expired-session GC pass on demand, so a test can lock
  // the "an expired IMPERSONATION session closes its audit window" contract
  // without waiting on the 5-minute interval.
  // v7.16.5 — raise an IP-ban alert in THIS process. The alert store is
  // in-process by design, so a spec that requires lib/admin-alerts gets its own
  // Map and the server never sees what it wrote — the browser poll would then
  // be tested against an alert that does not exist. Provoking a real ban would
  // need 100 rejected requests over ten minutes and would rate-limit the very
  // session doing the asserting.
  // v7.16.8 — clear every alert. Alerts live in the SERVER process and outlive
  // the spec that raised one, so an alert left open leaks into every later spec
  // on that worker: the SPA raises a blocking modal over the admin panel and
  // `#admin-alert-overlay intercepts pointer events` on every subsequent click.
  // That took out 27 tests in CI, and only in CI, because the file distribution
  // across four workers put the raiser and the victims together where eight
  // workers had not.
  app.post("/api/test/clear-ip-ban-alerts", (req, res) => {
    _clearAllAlertsForTests();
    res.json({ ok: true });
  });

  app.post("/api/test/raise-ip-ban-alert", (req, res) => {
    const b = req.body || {};
    const alert = recordIpBanAlert({
      ip: String(b.ip || "198.51.100.1"),
      blockedUntil: Date.now() + (parseInt(b.blockMs, 10) || 15 * 60_000),
      count4xx: parseInt(b.count4xx, 10) || 103,
      competition: b.competitionName ? { id: b.competitionId || "test", name: b.competitionName, accepts_trusted_ips: b.acceptsTrustedIps !== false } : null,
      alreadyTrusted: !!b.alreadyTrusted,
    });
    res.json({ ok: true, alert: alert ? { id: alert.id, ip: alert.ip } : null });
  });

  // v7.25.0 — the scanner tracker, drivable.
  //
  // The shared harness sets RATE_LIMIT_DISABLED=1, which short-circuits BOTH
  // scanner middlewares before they count or block, so until now the only way
  // to reach a real cascade was a spawned server (~90 s per case). These three
  // give the shared server a way in — and the reset is not a convenience:
  // a block on 127.0.0.1 lasts 15 minutes and 429s every later NON-ADMIN
  // request in the file, so a spec that arms the tracker MUST disarm and reset
  // it in an `afterEach` (the v7.16.8 rule; draining at the start of the next
  // test always lets the LAST test in the file escape).
  //
  // Note the block middleware exempts /api/test/ under NODE_ENV=test, or these
  // would themselves be refused by the block they exist to clear.
  app.post("/api/test/scanner-toggle", (req, res) => {
    _testScannerForceEnabled = !!(req.body && req.body.enable);
    res.json({ ok: true, enabled: _testScannerForceEnabled });
  });
  app.post("/api/test/scanner-reset", (req, res) => {
    const cleared = _scannerIpRep.size;
    _scannerIpRep.clear();
    res.json({ ok: true, cleared });
  });
  // Rewind an address's window start so a test can cross the 10-minute roll
  // without waiting it out. The roll is where a live block used to be silently
  // discarded, and that is not reachable any other way from a spec.
  app.post("/api/test/scanner-age-window", (req, res) => {
    const b = req.body || {};
    const rec = _scannerIpRep.get(String(b.ip || "127.0.0.1"));
    if (!rec) return res.json({ ok: false, tracked: false });
    rec.windowStart -= (parseInt(b.ms, 10) || _SCANNER_WINDOW_MS + 60_000);
    res.json({ ok: true, window_start: new Date(rec.windowStart).toISOString() });
  });
  // Read the tracker's own view of one address. Without it the only observable
  // is "did a 429 happen", which cannot tell an EARLY probe block apart from an
  // ordinary one at 100 — i.e. cannot see the feature at all — and a failure
  // says "expected 429, got 200" instead of naming which counter was short.
  app.get("/api/test/scanner-state", (req, res) => {
    const ip = String(req.query.ip || "127.0.0.1");
    const rec = _scannerIpRep.get(ip);
    if (!rec) return res.json({ tracked: false, ip });
    res.json({
      tracked: true, ip,
      count_4xx: rec.count4xx,
      blocked: !!(rec.blockedUntil && rec.blockedUntil > Date.now()),
      blocked_until: rec.blockedUntil ? new Date(rec.blockedUntil).toISOString() : null,
      threshold_kind: rec.thresholdKind || null,
      sample_paths: rec.probeSample.slice(),
      ...classifyScannerTraffic(rec),
    });
  });

  app.post("/api/test/sweep-sessions", (req, res) => {
    res.json({ ok: true, ..._sweepExpiredSessions() });
  });
  // v7.6.0 — drive one unverified-account reaper pass on demand. Accepts optional
  // { ttlMs, limit, floorIso } so a test can age the cutoff / disable the floor
  // without waiting 48h or for the hourly interval.
  app.post("/api/test/reap-accounts", express.json(), (req, res) => {
    const { ttlMs, limit, floorIso } = req.body || {};
    const summary = sweepUnverifiedAccounts({ ttlMs, limit, floorIso });
    // v7.23.10 — the stale verify-code sweep rides the same tick in production
    // (lib/account-reaper.js), so the test hook drives both or a lock could not
    // reach it without waiting out the hourly timer.
    const codes = sweepStaleVerifyCodes({ ttlMs });
    res.json({ ok: true, ...summary, ...codes });
  });

  // v7.7.17 — drive one *_events retention purge on demand. Accepts optional
  // { ttlMs, limit, nowIso } so a test can age the cutoff / cap the run without
  // waiting 2 years or for the daily interval.
  // { imageGraceMs, imageLimit, imageRefsWarnMs } do the same for the
  // orphaned-image sweep (the last lowers its slow-collection warning threshold).
  app.post("/api/test/purge-events", express.json(), (req, res) => {
    const { ttlMs, limit, nowIso, templateTtlMs, imageGraceMs, imageLimit, imageRefsWarnMs } = req.body || {};
    const opts = {};
    if (ttlMs != null) opts.ttlMs = ttlMs;
    if (typeof templateTtlMs === "number") opts.templateTtlMs = templateTtlMs;
    if (typeof imageGraceMs === "number") opts.imageGraceMs = imageGraceMs;
    if (typeof imageLimit === "number") opts.imageLimit = imageLimit;
    if (typeof imageRefsWarnMs === "number") opts.imageRefsWarnMs = imageRefsWarnMs;
    if (limit != null) opts.limit = limit;
    if (typeof nowIso === "string") { const d = new Date(nowIso); if (!isNaN(d.getTime())) opts.now = d; }
    // The daily pass's own hold on the image sweep, never a test-only copy.
    opts.isHealthy = _instanceInService;
    const summary = sweepExpiredEvents(opts);
    res.json({ ok: true, ...summary });
  });
  // v9.2.10 — the storm witnesses (tests/storm-witnesses.api.spec.js). Two of the
  // sign-in storm fixes are invisible to a client by design, so nothing a spec
  // could read showed them being reverted:
  //   * how many times a competition's board was COMPUTED (a cache hit is not
  //     counted: lib/leaderboard.js leaderboardComputeCount), which the coalesced
  //     first-entry bust keeps to one per window however many people enter;
  //   * how many compressions ran: the frozen shell, stylesheet and bundle are
  //     compressed once per entry (_assetEntry), never per request. Counted by
  //     wrapping zlib's gzip, brotli and deflate entry points, and only once a
  //     spec arms it (the POST, which also zeroes the counts), so no other spec's
  //     server runs through the wrapper.
  app.get("/api/test/leaderboard-builds", (req, res) => {
    const id = typeof req.query.competitionId === "string" ? req.query.competitionId : "";
    if (!id) return res.status(400).json({ error: "competitionId must be a string" });
    res.json({ ok: true, builds: require("./lib/leaderboard").leaderboardComputeCount(id) });
  });
  const _zlibCounts = { gzipSync: 0, brotliCompressSync: 0, createGzip: 0, createBrotliCompress: 0, createDeflate: 0 };
  let _zlibCountArmed = false;
  app.post("/api/test/compression-count", (req, res) => {
    if (!_zlibCountArmed) {
      const zlib = require("zlib");
      for (const name of Object.keys(_zlibCounts)) {
        const orig = zlib[name];
        Object.defineProperty(zlib, name, {
          value: function countedZlibCall(...args) { _zlibCounts[name]++; return orig.apply(this, args); },
          writable: true, enumerable: true, configurable: true,
        });
      }
      _zlibCountArmed = true;
    }
    for (const name of Object.keys(_zlibCounts)) _zlibCounts[name] = 0;
    res.json({ ok: true, armed: true, ..._zlibCounts });
  });
  app.get("/api/test/compression-count", (req, res) => res.json({ ok: true, armed: _zlibCountArmed, ..._zlibCounts }));
}
// (The 5-minute rate-limit-bucket cleanup interval runs inside lib/middleware.js.)

// CSRF (generateToken + csrfProtection) is set up in lib/middleware.js and
// imported at the top of this file. csrfProtection is applied per-route (not
// globally); on the file-upload route it runs before multer (token via the
// x-csrf-token header) to prevent temp file writes from forged requests.

// Expose CSRF token for client-side requests. Rate-limited (v6.8.0): every
// call issues a fresh token and writes it into the session's CSRF secret —
// unbounded calls from an anonymous IP would pointlessly churn the session
// store and waste CPU on token generation.
// v8.3.13 — A TOKEN IS WORTHLESS WITHOUT THE SESSION IT BELONGS TO, and this
// endpoint used to hand one out anyway.
//
// Reported from production as "many login attempts fail with csrf_invalid, with
// no server restart". PROVEN against the running deployment: with
// `SECURE_COOKIE` on, express-session REFUSES to emit `Set-Cookie` for any
// request it does not consider secure —
//   `if (req.session.cookie.secure && !issecure(req, trustProxy)) return;`
// — and this handler happily answered `200 {csrfToken}` regardless. The browser
// therefore held a token for a session it could never present, so the very next
// POST was `403 csrf_invalid`, for ever, for that visitor. Measured on the live
// server: no `X-Forwarded-Proto` → 200, a valid token, and NO `Set-Cookie`;
// `X-Forwarded-Proto: https` → the cookie appears.
//
// It is reachable without anyone touching the app: the process listens on
// 0.0.0.0, so a direct hit on the port, a second ingress, or a proxy hop that
// stops forwarding the header all land here. And NOTHING said so — express
// -session's own "not secured" is debug-only, so the operator's only signal was
// a CSRF error naming the wrong subsystem entirely.
//
// So the endpoint now REFUSES rather than lying. `session_cookie_blocked` names
// the real condition and the fix; 503 because it is the deployment that is
// wrong, not the request. In every correctly-configured deployment — including
// plain-http dev, where `SECURE_COOKIE` is false — this branch is unreachable
// and the behaviour is byte-identical.
//
// `no-store` is not decoration either: this is a per-session credential and the
// route set no cache headers at all, so a CDN or WAF placed in front could
// serve one visitor's token to another.
app.get("/api/csrf-token", rateLimit(60_000, parseInt(process.env.RATE_LIMIT_CSRF_PER_MIN, 10) || 120, "csrf"), (req, res) => {
  res.set("Cache-Control", "no-store");
  // Every SPA boot passes through here exactly once, which makes it the natural
  // place to notice a proxy chain that does not match TRUST_PROXY.
  _warnProxyHopMismatch(req);
  if (_sessionCookieWouldBeDropped(req)) {
    _warnInsecureSessionCookie(req);
    return res.status(503).json({
      error: "session_cookie_blocked",
      message: "The server cannot set a session cookie on this connection, so a CSRF token would not work. Reach the site over HTTPS, or have the reverse proxy send X-Forwarded-Proto: https.",
    });
  }
  res.json({ csrfToken: generateToken(req) });
});

// Image serving is keyed by a 128-bit UUID but a leaked or logged id stays
// retrievable until the picture is deleted — cap the request rate so hostile
// clients can't churn cache bandwidth either. 120/min is ample because a browser
// keeps each picture for a day (the Cache-Control below), so ordinary viewing
// asks for it at most once a day.
//
// CACHING: `private, max-age=86400` plus a strong ETag (the image id). A picture
// can be DELETED (a replaced or erased avatar, an orphan the daily sweep
// reclaims, lib/image-sweep.js), so it must not outlive that in a cache:
// `private` keeps every shared proxy or CDN from holding a copy, and a browser
// keeps its own for at most a day, then revalidates (304 while the row exists,
// 404 once it is gone). Never `no-cache` (a revalidation per view would spend the
// venue NAT's shared images bucket) and never `public`/`immutable` again (an
// erased person's photo would keep showing for a year).
app.get("/api/images/:id", rateLimit(60_000, 120, "images"), (req, res) => {
  const meta = db.prepare("SELECT id, mime_type FROM images WHERE id=?").get(req.params.id);
  if (!meta) return res.status(404).end();
  res.set("Cache-Control", "private, max-age=86400");
  // The id names one set of bytes for the row's whole life, so it is a strong
  // validator; an id outside [\w-] (none is minted) gets no ETag.
  if (/^[\w-]+$/.test(meta.id)) res.set("ETag", `"${meta.id}"`);
  // Express compares If-None-Match with the ETag set above; a match is answered
  // without reading the blob.
  if (req.fresh) return res.status(304).end();
  const img = db.prepare("SELECT data, mime_type FROM images WHERE id=?").get(meta.id);
  if (!img) return res.status(404).end();
  // v6.16.53 — defence in depth on the serve path. Pre-fix any
  // mime_type stored in the images table was echoed verbatim as the
  // response Content-Type. The v6.16.53 ingest gates (above) prevent
  // new SVG/unsupported MIMEs from being stored, but a row planted
  // before the fix could still be served as `image/svg+xml` and
  // execute scripts inline. Validate against the same allowlist on
  // egress; any non-allowlisted MIME gets force-coerced to
  // `application/octet-stream` so the browser downloads instead of
  // renders/executes.
  const m = /^image\/([a-z0-9+.-]+)$/i.exec(img.mime_type || "");
  const subtype = m && m[1].toLowerCase();
  const safe = subtype && _RICH_IMG_ALLOWED_SUBTYPES.has(subtype);
  res.set("Content-Type", safe ? img.mime_type : "application/octet-stream");
  // X-Content-Type-Options:nosniff is already set globally by the security-header
  // middleware above (this app sets its headers by hand — there is no helmet
  // dependency, despite what this comment used to claim), but defence in depth
  // here too: this route serves user-uploaded bytes.
  res.set("X-Content-Type-Options", "nosniff");
  res.send(img.data);
});

const { now, formatEmailDate, reminderLeadTime } = require("./lib/time"); // v7.0.0: shared clock + email-date helpers

// v8.1.0 — attempt caps. `attemptsWire` is the ONE projection of the state onto
// the participant wire, used by every submit response that carries it, so the
// three terminal branches cannot describe the same standing three ways. The CAP
// fields are absent entirely when the challenge is uncapped — an
// `attempts_left: null` would have to be interpreted by every client, and "the
// key is absent" is the shape a stale client already handles correctly.
//
// v8.13.2 (external audit) — BUT THE COUNT IS NOT A CAP FIELD, and it goes to
// every challenge. `attempts` is the number of answers stored so far — the field
// GET /api/tasks/:id has always sent for every challenge under the same name, and
// the one the card prints as "N attempt(s)". With no count on an uncapped
// challenge's response the card could not update it after a wrong answer, so it
// went on showing the number from when the challenge was opened until it was
// reopened. A plain count needs no interpreting, so sending it uncapped breaks
// nothing the absent-key rule above protects. `attempts_used` stays as the cap
// projection's own member, equal to `attempts` whenever it is present.
const { attemptState, participantsFinishedAll, participantsFinishedAllDetail,
        ATTEMPT_CAP_MIN, ATTEMPT_CAP_MAX } = require("./lib/attempts");
const { taskConflictingEvent } = require("./lib/challenge-fit");
const { recordPresence, presenceMs, presenceRowCount, BUCKET_MS } = require("./lib/presence");
function attemptsWire(st) {
  if (!st) return {};
  const count = Number.isInteger(st.used) ? { attempts: st.used } : {};
  if (!st.capped) return count;
  return { ...count, attempts_cap: st.effective, attempts_used: st.used, attempts_left: st.left };
}

// requireParticipant / requireAdmin / requireSuperAdmin now live in
// lib/middleware.js (imported at the top of this file). Each re-reads the user
// row to enforce the full account lifecycle on every request.

// ── Admin identity for audit fields ──────────────────────────────────────────
const { getAdminIdentity, createTaskVersion, recordCompetitionEvent, recordTimeslotEvent, recordUserEvent, recordSettingsEvent, recordOrphanedAuditEvent, recordChallengeEvent, runTxnWithMirrorBuffer, _deferAudit, reqContext, deferredAuditPending } = require("./lib/audit"); // v7.0.0: audit trail + task-version + event cache + row-stable pagination
// The email transport wrappers (sendEmailLogged / sendEmailBackground), the
// bulk-send unsubscribe machinery (_BULK_EMAIL_REASONS, the persisted HMAC
// secret, generate/verifyUnsubscribeToken, _bulkEmailHeaders, _isUnsubscribed)
// now live in lib/email.js (imported at the top of this file). sendEmailLogged
// / sendEmailBackground / verifyUnsubscribeToken are imported; the rest is
// internal to the module.

// The status scheduler (runStatusSchedulerTick + startStatusScheduler) and the
// observation-table writers (_updateStatusObservation /
// _resyncStatusObservationAfterRevive) now live in lib/scheduler.js (imported at
// the top of this file). startStatusScheduler() is called from the app.listen
// callback below; the 60s interval handle lives inside the module.

// ── Score / leaderboard (competition-scoped) ────────────────────────────────

// User-tag reads + the short-TTL tag cache (getUserTags, isStaff, isBenchmark,
// getStaffOrBenchmarkSet, _invalidateUserTagsCache) now live
// in lib/user-tags.js (imported at the top of this file). _userTagsCacheSize
// feeds the /metrics user_tags gauge; tag-mutation routes call
// _invalidateUserTagsCache after their write.

/**
 * Check if all given participants have solved all tasks in a competition.
 * Single batched query instead of per-participant loop.
 */
// v7.21.13 — the imported-tag write, shared by the task import's overwrite and
// create branches. They were byte-identical apart from the task id, so the
// batch-5 non-string skip had to be remembered twice; the next rule (a length
// cap, a charset guard) would have had to be too.
function _applyImportedTaskTags(taskId, tags) {
  const insertTag = db.prepare("INSERT OR IGNORE INTO task_tags (task_id, tag) VALUES (?,?)");
  // batch 5 — skip non-string tags (would 500 at tag.trim()).
  for (const tag of tags) if (typeof tag === "string" && tag.trim()) insertTag.run(taskId, tag.trim().toLowerCase());
}
// Stage B — the imported question's topic, by NAME (the file carries no topic
// id: lib/topics.js). An existing topic of that name (case-insensitive) is used,
// else one is made; null or "" files it under no topic; a name the topic rules
// refuse leaves the question as it was. Inside the import's transaction.
function _applyImportedTopic(taskId, name) {
  const T = require("./lib/topics");
  if (name === null || (typeof name === "string" && !name.trim())) {
    db.prepare("UPDATE tasks SET topic_id=NULL WHERE id=?").run(taskId);
    return;
  }
  if (typeof name !== "string" || T.topicNameError(name)) return;
  const found = T.topicByName(db, name);
  const topicId = found ? found.id : T.insertTopic(db, name, { createdBy: "import" });
  db.prepare("UPDATE tasks SET topic_id=? WHERE id=?").run(topicId, taskId);
}

// v8.1.0 — the name and the zero-participant guard are unchanged (both are
// source-pinned, and all three call sites pass the same arguments), but the RULE
// is now "solved OR out of attempts". Delegating rather than reimplementing is
// what keeps one definition: the revive refusals in routes/competitions.js and
// routes/sessions.js reach the new semantics through this function without
// knowing caps exist. With no caps configured anywhere the predicate is exactly
// what it always was.
function allParticipantsSolvedAll(participantIds, competitionId, totalTasks) {
  if (!participantIds.length || totalTasks <= 0) return false;
  return participantsFinishedAll(participantIds, competitionId, totalTasks);
}


/**
 * Calculate participant score. Only filters by timeslotId when the competition
 * is in per_slot leaderboard mode. In global mode a participant's visible score
 * must match their position on the global leaderboard, which aggregates across
 * all timeslots — filtering by the caller's current timeslot would otherwise
 * under-count submissions made while the participant was in a different slot.
 */
// The leaderboard subsystem — getParticipantScore, the 5-second leaderboard
// cache + invalidateLeaderboardCache, buildLeaderboardEntries, sortLeaderboard,
// buildLeaderboard / buildAdminLeaderboard — now lives in lib/leaderboard.js
// (imported at the top of this file). _leaderboardCacheEntryCount feeds the
// /metrics cache-size gauge; invalidateLeaderboardCache is called from every
// leaderboard-relevant write path (see the CLAUDE.md writer-lock table).

// ── Auth ──────────────────────────────────────────────────────────────────────

// ── Account lifecycle + session routes ───────────────────────────────────────

// Registration, nickname availability, email-unsubscribe, email verification,
// the emailed sign-in code (the sign-in door for every account row) and
// logout / admin-logout live in routes/auth.js, registered here in one call.
// POST /api/login (the built-in superadmin's break-glass door; it mutates the
// superadmin-password state) stays inline below.
require("./routes/auth")(app);

// Verification landing page — shows a confirm button instead of verifying on GET.
// Prevents link scanners / prefetchers from accidentally activating accounts.
// Rate-limited to slow code-enumeration attacks (the response code distinguishes
// valid / expired / unknown so an unauthenticated caller can probe verify_code
// values; the 128-bit UUID space makes practical enumeration unrealistic but
// the limit removes the side channel).
// /verify (GET/POST) now lives in routes/auth.js (registered above).

// Track consecutive failed superadmin login attempts GLOBALLY (v6.8.0).
//
// Earlier (v6.3.2) this was per-IP, which prevented one attacker from
// rotating the password by spamming from a single address — but meant a
// distributed brute force across many IPs could never trip the threshold.
// Back to a single global counter paired with a global rotation cooldown:
//   • N=10 consecutive failed attempts from ANY IP within the sliding
//     window triggers a password rotation.
//   • After a rotation, the global cooldown suppresses further rotations
//     for ROTATION_COOLDOWN_MS regardless of attacker pattern (caps rate
//     at 6/hour on the default 10 min).
//   • Any successful superadmin login resets the counter. The sliding
//     window auto-resets after _SUPERADMIN_FAIL_WINDOW_MS of quiet.
//
// The general login rate limit (60/min per IP) and the single-session
// enforcement still apply on top.
let _superadminFailGlobal = { count: 0, first: 0 };
let _superadminLastRotatedAt = 0;
// Restore rotation cooldown across restarts so a process kill can't be used
// to reset the 10-min cooldown and trigger rapid successive rotations.
try {
  const _rot = db.prepare("SELECT value FROM settings WHERE key='superadmin_rotation_last_at'").get();
  if (_rot?.value) _superadminLastRotatedAt = parseInt(_rot.value, 10) || 0;
} catch (_err) { swallowed("server:best-effort", _err); }
const SUPERADMIN_REGEN_THRESHOLD = 10;
const _SUPERADMIN_FAIL_WINDOW_MS = 15 * 60 * 1000; // 15 min sliding window
const _SUPERADMIN_ROTATION_COOLDOWN_MS = 10 * 60 * 1000; // 10 min global cooldown
function _superadminFailRecord() {
  const t = Date.now();
  if (_superadminFailGlobal.count === 0 || (t - _superadminFailGlobal.first) > _SUPERADMIN_FAIL_WINDOW_MS) {
    _superadminFailGlobal = { count: 0, first: t };
  }
  _superadminFailGlobal.count++;
  return _superadminFailGlobal.count;
}
function _superadminFailReset() {
  _superadminFailGlobal = { count: 0, first: 0 };
}
function _superadminRotationOnCooldown() {
  return _superadminLastRotatedAt > 0
      && (Date.now() - _superadminLastRotatedAt) < _SUPERADMIN_ROTATION_COOLDOWN_MS;
}

// The break-glass door's limiter (POST /api/login, the built-in superadmin
// only): RATE_LIMIT_LOGIN_PER_MIN (default 60) a minute per (IP, name), keyed on
// the username the sign-in card sends (or the legacy `email` field), plus a
// coarse per-IP backstop of RATE_LIMIT_LOGIN_IP_BACKSTOP_PER_MIN (default 600) a
// minute, so names fanned out from one IP stay capped. No account lockout
// applies here: the door charges none, and a wrong break-glass password counts
// towards the password rotation instead (_superadminFail*). routes/auth.js reads
// the same two settings for the account password door and the sign-in-method
// lookup, keyed by address there, so a roomful of accounts behind one venue NAT
// does not share a bucket.
const _LOGIN_PER_MIN = parseInt(process.env.RATE_LIMIT_LOGIN_PER_MIN, 10) || 60;
const _LOGIN_IP_BACKSTOP_PER_MIN = parseInt(process.env.RATE_LIMIT_LOGIN_IP_BACKSTOP_PER_MIN, 10) || 600;
const _loginLimiter = rateLimit(60_000, _LOGIN_PER_MIN, "login", {
  // The sign-in card sends the break-glass name as `username`; `email` is the
  // legacy field. Keyed on whichever came, so one IP's attempts at different
  // names do not share one bucket.
  keyExtra: (req) => {
    const b = req.body || {};
    const v = typeof b.username === "string" ? b.username : (typeof b.email === "string" ? b.email : "");
    return v ? normaliseEmail(v) : "";
  },
  ipBackstopMax: _LOGIN_IP_BACKSTOP_PER_MIN,
});
// v7.15.2 (audit) — close an open impersonation window before a login REPLACES
// the session. `/api/login` is on the impersonation allowlist for both tiers (a
// session-replacing escape hatch), but `regenerate()` destroys the row carrying
// the `impersonator` marker BEFORE invalidateOtherSessions or the expiry sweep
// could ever see it — so neither of v7.14.1's other closers fires and the
// target's History keeps an `impersonation_started` that never ends. Call this
// on the SUCCESS paths only (a failed login leaves the session untouched, so
// the window is still legitimately open). Best-effort: never block a login.
// v8.13.4 — and from the EBADCSRFTOKEN handler, which DESTROYS rather than
// replaces the session (reason "csrf_invalid") and is the same rule's fifth
// instance: it had destroyed every impersonation session with no close since
// v7.14.0. The name stays — it is cited by name in AUTH_PATHS.md.
function _closeImpersonationWindowOnSessionReplace(req, reason) {
  const imp = req.session && req.session.impersonator;
  if (!imp) return;
  const targetId = req.session.userId;
  if (!targetId) return;
  try {
    recordUserEvent(targetId, "impersonation_ended", impersonationActor(req.session),
      { ...impersonationEndedDetails(imp, reason), ...reqContext(req) });
  } catch (_err) { /* audit must never break sign-in */ swallowed("server:login-audit", _err); }
}

// POST /api/login — THE BUILT-IN SUPERADMIN'S BREAK-GLASS DOOR, and nothing else.
//
// Accounts sign in through routes/auth.js: with their password
// (POST /api/auth/password) or an emailed code (POST /api/auth/code/request →
// /redeem), whichever their sign-in method is (lib/login-method.js). This route
// accepts only the break-glass username (a setting; default `superadmin`) with
// the boot-generated password from DATA_DIR/.superadmin-password, typed on the
// ordinary sign-in card: anything that is not an address shows the password box
// there, and there is no code door for it. It is how an operator gets in when
// mail is down.
//
// ANY OTHER NAME GETS ONE GENERIC 401 WITH NO LOOKUP. The answer cannot depend
// on whether an address exists, because the handler never asks: no SELECT, no
// bcrypt, no lifecycle branch, no lockout charge.
const _LOGIN_NOT_PASSWORD = "Those details did not sign you in.";
app.post("/api/login", _loginLimiter, csrfProtection, async (req, res) => {
  // Coerce non-string fields to "" so a malformed body cannot 500.
  const password = typeof req.body.password === "string" ? req.body.password : "";
  // THE ONE BREAK-GLASS ACCOUNT. `username` (or the legacy `email` field) must
  // equal the CURRENT `breakglass_username` setting (default `superadmin`,
  // case-insensitive). Anything else — an old name after a rename, any address —
  // gets the one generic 401 with no lookup. The name is re-checked against
  // every account's addresses here as well as when it is set: if an account
  // ever holds it, the break-glass door stays shut for that name.
  const _rawName = typeof req.body.username === "string" ? req.body.username
    : (typeof req.body.email === "string" ? req.body.email : "");
  const email = normaliseEmail(_rawName);
  const safeEq = (a, b) => { const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b)); const maxLen = Math.max(ba.length, bb.length); const pa = Buffer.alloc(maxLen); const pb = Buffer.alloc(maxLen); ba.copy(pa); bb.copy(pb); return ba.length === bb.length && crypto.timingSafeEqual(pa, pb); };
  const _isBreakglassName = !!email && email === getBreakglassUsername() && !breakglassNameHeldByAccount(email);

  if (_isBreakglassName && safeEq(password, SUPERADMIN_PASS)) {
    _superadminFailReset();
    _closeImpersonationWindowOnSessionReplace(req, "login");
    return req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: "Session error" });
      req.session.builtinId = "superadmin";
      req.session.isAdmin = true;
      req.session.isSuperAdmin = true;
      // Enforce single session for superadmin — with the kicker's context, so the
      // other browser is told it was signed in elsewhere rather than idle, and
      // (`builtin`) is given a restart as the remedy.
      invalidateOtherSessions("builtinId", "superadmin", req.sessionID, kickerContext(req, { email: "superadmin", builtin: true }));
      // No user row exists (builtinId), so this is a session-scoped orphaned event.
      try { recordOrphanedAuditEvent("session", req.sessionID, "superadmin_login_success", "superadmin", reqContext(req)); } catch (_err) { swallowed("server:best-effort", _err); }
      res.json({ ok: true, role: "admin", isSuperAdmin: true, isEventAdmin: false, isBreakglass: true });
    });
  }

  // Failed superadmin attempt — regenerate password after GLOBAL threshold
  // (v6.8.0). Global cooldown still caps rotations to 1 per 10 minutes so
  // a sustained attacker can't keep the operator chasing a new password.
  if (_isBreakglassName) {
    const count = _superadminFailRecord();
    if (count >= SUPERADMIN_REGEN_THRESHOLD) {
      if (_superadminRotationOnCooldown()) {
        try { recordSettingsEvent("superadmin_password", "rotation_suppressed", "system", { reason: "cooldown", attempts: count, ...reqContext(req) }); } catch (_err) { swallowed("server:best-effort", _err); }
      } else {
        SUPERADMIN_PASS = generateSuperadminPassword();
        _superadminLastRotatedAt = Date.now();
        try { db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('superadmin_rotation_last_at', ?)").run(String(_superadminLastRotatedAt)); } catch (_err) { swallowed("server:best-effort", _err); }
        _superadminFailReset();
        console.warn(`Superadmin password regenerated after ${SUPERADMIN_REGEN_THRESHOLD} consecutive failed attempts (global). Global rotation cooldown active for ${_SUPERADMIN_ROTATION_COOLDOWN_MS / 60_000} minutes.`);
        logSuperadminPassword();
        try { recordSettingsEvent("superadmin_password", "rotated", "system", { reason: "brute_force_threshold", attempts: SUPERADMIN_REGEN_THRESHOLD, cooldown_ms: _SUPERADMIN_ROTATION_COOLDOWN_MS, ...reqContext(req) }); } catch (_err) { swallowed("server:best-effort", _err); }
      }
    }
  }
  // A wrong password for the right name answers EXACTLY like a wrong name, so
  // this door is no oracle for the break-glass username.
  return res.status(401).json({ error: _LOGIN_NOT_PASSWORD, code: "use_sign_in_code" });
});

// POST /api/logout now lives in routes/auth.js (registered above).

// v6.8.5: per-user 2-second cache for /api/me. The client polls this on every
// navigation + periodically; the response is stable across a 2-second window
// (profile updates go through PUT /api/me which invalidates the entry). At
// 500 VUs on a 15-s poll cadence this saves ~200 DB stmts/s on the hot path.
// The /api/me cache (the _meCache Map + _invalidateMeCache /
// _invalidateMeCacheForComps + the get/set helpers) now lives in lib/me-cache.js
// (imported at the top of this file) — a single process-global instance.

// ── Participant account / session / gameplay routes ──────────────────────────

// The participant-facing routes (account + session: GET/PUT /api/me, admin-view
// reflection; competition + timeslot selection; status/config/
// keepalive; email reminders; and the participant challenge surface: list,
// detail, hint, navigated-away, feedback) now live in routes/participant.js,
// registered here in one call. The hot POST /api/tasks/:id/submit handler stays
// inline below (its perf-span shape is source-introspection-pinned). uuid /
// bcrypt / crypto and the shared helpers (taskGradingHash -> lib/scoring,
// deleteAvatarImage -> lib/sanitise, participantContentNotStarted ->
// lib/competitions) are imported by the module / still resident here as needed.
require("./routes/participant")(app);

// ── Self-enrollment link (v6.21.0) ──────────────────────────────────────────
// A per-competition secret, persistent, non-guessable token lets a participant
// follow /join/<token>, authenticate, and be auto-enrolled into that
// competition (and a first-timer register, skipping the approval queue). The
// token is the only secret — it ships ONLY via the admin reveal GET, never in
// the competitions list / /api/me / exports, and is scrubbed from the access
// log. Helpers here; admin reveal/regenerate live in the admin-competitions
// block; register-via-join + the login consume live in their respective paths.

// The self-enrollment engine (_genSelfEnrollToken, _resolveJoinableComp,
// _selfEnrollEnrollTxn, _selfEnrollSideEffects, _consumePendingSelfEnroll) now
// lives in lib/self-enroll.js — a strict leaf
// consumer that never imports routes/*. _competitionAcceptsSelfEnroll is in
// lib/competitions.js.

// Public link preview — shows the competition name on the /join landing before
// the user authenticates. Rate-limited like the invitation lookup. Uniform 404
// for invalid / disabled / ended so the endpoint can't be used as an oracle to
// distinguish a real-but-disabled token from one that never existed.
// Self-enrollment routes (public preview + join, admin reveal + regenerate) now
// live in routes/self-enroll.js (registered here, ahead of the participant
// /api/competitions/* routes for the shared prefix — harmless under Express 5).
require("./routes/self-enroll")(app);
require("./routes/badge")(app);
// v8.15.0 — the certificate DESIGN (global, per-event override, preview).
require("./routes/certificate-config")(app);
// The per-event look (routes/event-look.js; lib/platform-look.js).
require("./routes/event-look")(app);
// Stage B — the Question bank's topics (routes/topics.js; lib/topics.js).
require("./routes/topics")(app);
// The event workspace Overview's live read (routes/event-overview.js).
require("./routes/event-overview")(app);
// The event team and its persona reports (routes/event-team.js; lib/event-team.js, lib/team-reports.js).
require("./routes/event-team")(app);

// Reminder email sender — runs every 30 seconds.
//
// Crash-safety + DELETE+INSERT race-safety: every row tracks THREE flags.
//   • `claimed_at`  — timestamp set by a dispatcher tick when it takes
//                     ownership of the row just before the SMTP await. Used
//                     for the stale-claim sweep (lease timeout).
//   • `claim_token` — uuid set alongside `claimed_at`; an identity for THIS
//                     specific claim attempt. The dispatcher matches its own
//                     claim_token on complete/release so it can't bleed state
//                     into a row it no longer owns — which matters when the
//                     user deletes and recreates a reminder (same user_id /
//                     competition_id, different row) while this tick is still
//                     awaiting SMTP. Without the token match, a post-delivery
//                     `UPDATE SET sent=1 WHERE user_id=? AND competition_id=?`
//                     would mark the NEW (un-dispatched) row as sent, silently
//                     suppressing the replacement reminder.
//   • `sent`        — flipped to 1 only on confirmed SMTP delivery. This is
//                     what the client GET reads — nothing claims delivery
//                     until it actually happened.
//
// Why three flags: a single sent=0/1 flag can't distinguish "in flight" from
// "not yet started", and matching on (user_id, comp_id) alone can't tell the
// row is the SAME row as at claim time. The claim_token closes both gaps.
// Crashed claims are reaped by the stale-claim sweep (lease
// REMINDER_CLAIM_TIMEOUT_MS); clients only see sent=1 once delivery is real.
//
// Ordering inside a tick:
//   1. Sweep `claimed_at` older than the lease timeout — abandoned claims
//      from a prior crashed tick or dead process.
//   2. SELECT due rows where sent=0 AND claimed_at IS NULL.
//   3. For each: atomically claim via
//         UPDATE SET claimed_at=?, claim_token=? WHERE sent=0 AND claimed_at IS NULL.
//   4. Send. On success: `UPDATE SET sent=1 WHERE claim_token=?`
//            On failure: `UPDATE SET claimed_at=NULL, claim_token=NULL WHERE claim_token=?`
//      Both match by token alone; if the row was deleted between claim and
//      completion, both updates are 0-row no-ops — exactly what we want.
// Single-process overlap still also guarded by `_reminderTickRunning`.
const REMINDER_CLAIM_TIMEOUT_MS = 2 * 60 * 1000;
let _reminderTickRunning = false;
// infra audit (#1): gated behind NODE_ENV!=='test' (so WORKERS=8 test replicas
// don't fire real reminder DB/SMTP work every 30s) and .unref()'d (so the timer
// never keeps the event loop alive) — matching the attachment-sweep / session-GC
// timers.
// v7.21.5 — the tick body is a named function so a test can drive ONE pass.
// The interval is disabled under NODE_ENV=test, so before this the dispatcher
// was unreachable from the suite: the three "reminder dispatcher" tests in
// functional-security re-implemented its SQL inside the test and asserted that
// SQLite honours a WHERE clause. Every line of this function could be reverted
// with all three green. `opts` is honoured only from the test-only endpoint and
// is inert by default.
async function runReminderTick(opts = {}) {
  if (_reminderTickRunning) return { ran: false, claimed: 0, delivered: 0, skipped: 0, started: 0 };
  // HELD WHILE THE INSTANCE IS OUT OF SERVICE (operator ruling, 25 Nov 2026):
  // maintenance mode, or a database that failed its boot integrity or schema
  // check (the one gate, `_instanceInService`, never a copy), so no start
  // reminder goes out from a copied, restored, corrupt or half-migrated
  // database. Answered BEFORE the pass starts: a held tick touches nothing (no
  // stale-claim sweep, no claim), and its early return never reaches the
  // `finally` that clears `_reminderTickRunning`.
  if (!_instanceInService()) return { ran: false, held: true, claimed: 0, delivered: 0, skipped: 0, started: 0 };
  _reminderTickRunning = true;
  let _claimed = 0, _delivered = 0, _skipped = 0, _started = 0, _heldMid = false;
  try {
    // Stale-claim sweep: release claims that are older than the lease.
    // Covers both intra-process crash recovery (rare) and abandoned claims
    // from a second app instance sharing the DB. Clear claim_token too so
    // the row's next-tick claim starts clean.
    const staleCutoff = new Date(Date.now() - REMINDER_CLAIM_TIMEOUT_MS).toISOString();
    db.prepare("UPDATE email_reminders SET claimed_at=NULL, claim_token=NULL WHERE sent=0 AND claimed_at IS NOT NULL AND claimed_at<=?").run(staleCutoff);

    const due = db.prepare(
      `SELECT er.*, u.email, u.secondary_email, u.first_name, u.nickname, u.timezone,
              c.name as comp_name, c.start_time,
              ct.name as timeslot_name, ct.start_time as timeslot_start_time
       FROM email_reminders er
       JOIN users u ON u.id=er.user_id
       JOIN competitions c ON c.id=er.competition_id
       -- v6.8.0: require the participant to still be assigned to the comp.
       -- A user removed between reminder-set and reminder-send otherwise
       -- still received the mail because the JOIN tree didn't reach
       -- competition_users. Staff (not in competition_users) can always
       -- self-enter every competition; no reminders are ever set for them.
       JOIN competition_users cu ON cu.user_id=er.user_id AND cu.competition_id=er.competition_id
       LEFT JOIN competition_timeslots ct ON ct.id=er.timeslot_id
       WHERE er.sent=0 AND er.claimed_at IS NULL AND er.send_at<=?`
    ).all(now().toISOString());
    if (!due.length) return { ran: true, claimed: 0, delivered: 0, skipped: 0, started: 0 };
    const platformName = getPlatformName();
    // v7.21.5 — the claim and the completion are bound to the row's full
    // SCHEDULE IDENTITY, not just its PK. Two admin writers move a pending
    // reminder IN PLACE — routes/sessions.js (session start edit, scoped to
    // every unsent row of that session) and routes/competitions.js (the
    // single-slot twin) — and neither touches sent / claimed_at / claim_token.
    // That is the one mutation claim_token cannot see, and it opened TWO
    // windows:
    //   • SELECT → claim: the claim dropped the `send_at<=?` predicate the
    //     SELECT used, so a moved row was still claimed and still announced at
    //     its OLD time. Reaches rows 2..N of a batch, through the previous
    //     row's SMTP await.
    //   • claim → mark-delivered: straddles the await, so mark-delivered still
    //     matched the rescheduled row and stamped sent=1 — permanently
    //     consuming a reminder that was now due at a different time. This one
    //     reaches row 1 as well, so fixing only the claim fixes only half.
    // Exact equality is stronger than restoring `send_at<=?`: the snapshot
    // value already satisfied that, and equality also catches a move BACKWARDS.
    const claimStmt = db.prepare("UPDATE email_reminders SET claimed_at=?, claim_token=? WHERE sent=0 AND claimed_at IS NULL AND user_id=? AND competition_id=? AND send_at=? AND COALESCE(timeslot_id,'')=?");
    const markDeliveredStmt = db.prepare("UPDATE email_reminders SET sent=1 WHERE claim_token=? AND send_at=? AND COALESCE(timeslot_id,'')=?");
    const releaseClaimStmt = db.prepare("UPDATE email_reminders SET claimed_at=NULL, claim_token=NULL WHERE claim_token=?");
    // The event's and session's NAMES as they are when this row's mail is
    // composed, never the batch's earlier read: a batch awaits one SMTP send per
    // row, and an organiser who renames the event meanwhile must not have the
    // rest of the roster told the old name (*Wording at send time*). Read after
    // the claim; a row gone meanwhile keeps the batch's names.
    const namesNowStmt = db.prepare("SELECT c.name AS comp_name, (SELECT ct.name FROM competition_timeslots ct WHERE ct.id=?) AS timeslot_name FROM competitions c WHERE c.id=?");
    for (const r of due) {
      // ASKED AGAIN BEFORE EACH CLAIM: a batch awaits one SMTP send per row and
      // can run for minutes (a roster shares one send_at), so maintenance
      // switched on mid-batch stops further claims; the rows left unclaimed go
      // out on the first tick after the hold lifts.
      if (!_instanceInService()) { _heldMid = true; break; }
      // Atomically claim the row with a fresh token. If another tick / instance
      // beat us to it, claim.changes === 0 and we skip — no duplicate dispatch.
      const claimToken = uuid();
      const claim = claimStmt.run(now().toISOString(), claimToken, r.user_id, r.competition_id, r.send_at, r.timeslot_id ?? '');
      // A row whose schedule moved is SKIPPED and left sent=0 with its new
      // send_at — never salvaged by re-reading and re-composing. The snapshot is
      // a five-table join carrying a business rule (the competition_users JOIN,
      // v6.8.0, so a removed participant stops receiving mail); recomposing
      // would duplicate that query at a second site, which is the class this
      // repo keeps paying for. A later tick picks it up when it is genuinely
      // due — at most 30 s late on a mail that says "starts in about 1 hour".
      if (claim.changes !== 1) { _skipped++; continue; }
      _claimed++;
      {
        const n = namesNowStmt.get(r.timeslot_id || null, r.competition_id);
        if (n) {
          r.comp_name = n.comp_name;
          if (r.timeslot_id && n.timeslot_name != null) r.timeslot_name = n.timeslot_name;
        }
      }

      // The start this row reminds about: its SESSION's for a sessioned
      // reminder (an event live through an earlier session still owes a later
      // session's reminder), else the event's. The claim proved send_at
      // unchanged, and every writer that moves a start re-times send_at (End
      // Now, which moves an upcoming session's start to its end, deletes that
      // session's unsent reminders instead), so the snapshot is current here.
      const start = new Date(r.timeslot_start_time || r.start_time);
      // v8.12.6 (sweep) — the lead time is COMPUTED, at send time, from the start
      // this row carries (lib/time.js reminderLeadTime): a reminder set late, or
      // moved earlier with its event, used to arrive saying "about 1 hour" ten
      // minutes before the start. The ordinary case's copy is unchanged.
      const lead = reminderLeadTime(start.getTime(), Date.now());
      if (lead === null) {
        // NEVER AFTER THE START (operator ruling, 25 Nov 2026): its event or
        // session began before this row could go out (held while out of
        // service, the server down across the start). Settled UNSENT: sent=1
        // is "never send this", as a restore's mark-sent already uses it, and
        // the participant's History says so. The settle and its record are ONE
        // transaction: a row is never consumed without the record that is its
        // only trace; if either fails the claim is released and the next tick
        // tries again.
        let settled;
        try {
          settled = runTxnWithMirrorBuffer(() => db.transaction(() => {
            const s = markDeliveredStmt.run(claimToken, r.send_at, r.timeslot_id ?? '');
            if (s.changes > 0) {
              recordUserEvent(r.user_id, "reminder_skipped", "system", {
                competition_id: r.competition_id, competition_name: r.comp_name,
                timeslot_id: r.timeslot_id || null, send_at: r.send_at,
                start_time: start.toISOString(), reason: "event_started",
              });
            }
            return s.changes;
          })());
        } catch (e) {
          releaseClaimStmt.run(claimToken);
          swallowed("server:reminder-skip-settle", e, { level: "warn" });
          continue;
        }
        if (settled > 0) _started++;
        else { _skipped++; releaseClaimStmt.run(claimToken); }
        continue;
      }
      const dateStr = formatEmailDate(start, r.timezone);
      // v7.29.0 — build the label from RAW values and escape ONCE, at the sink.
      // Pre-fix `sessionLabel` escaped the session name here, `fullName`
      // concatenated it, and the BODY escaped the result again — so a session
      // called "A&B" rendered as "A&amp;amp;B". Worse, the SUBJECT was escaped at
      // all: a subject line is not HTML, so "Dev & Sec Day" reached the inbox as
      // "Dev &amp; Sec Day". This is the highest-volume message a live event
      // sends.
      const sessionLabel = r.timeslot_name ? ` (${r.timeslot_name})` : '';
      const fullName = `${r.comp_name}${sessionLabel}`;
      const loginUrl = BASE_URL;
      const { html, text } = buildEmail(platformName, {
        greeting: r.first_name || r.nickname,
        body: `<p>This is a reminder that <strong>${escapeHtml(fullName)}</strong> ${lead.body}.</p>`
          + `<p><strong>Start time:</strong> ${escapeHtml(dateStr)}</p>`,
        linkUrl: loginUrl, linkText: "Go to " + platformName,
        fallbackNote: "You requested this reminder. If you no longer wish to participate, you can ignore this message.",
      });
      // Test-only park point. One place covers BOTH windows: everything from
      // the claim to here is synchronous, so a delay here is the await the
      // admin writers race against in production.
      if (opts.delayMs) await new Promise(res => setTimeout(res, opts.delayMs));
      let delivered = !!(await sendEmailLogged(r.user_id, { to: getUserEmails(r), subject: `${platformName} — ${fullName} ${lead.subject}`, html, text }, "reminder", { competitionId: r.competition_id }));
      // Substitutes ONLY the SMTP result boolean, after sendEmailLogged has run
      // and recorded its event — the hermetic test env has no SMTP sink, so the
      // mark-delivered branch is otherwise unreachable from a test.
      if (opts.forceDelivered) delivered = true;
      if (delivered) {
        // Match on claim_token so a DELETE+INSERT that happened while SMTP
        // was in flight can't have its replacement row marked sent=1. If
        // the row is gone, this is a 0-row no-op and the replacement row's
        // fresh (NULL, NULL) claim state survives untouched — the next
        // dispatcher tick will pick it up.
        const r2 = markDeliveredStmt.run(claimToken, r.send_at, r.timeslot_id ?? '');
        if (r2.changes > 0) {
          _delivered++;
          try { recordUserEvent(r.user_id, "reminder_email_sent", "system", { competition_id: r.competition_id, competition_name: r.comp_name, timeslot_id: r.timeslot_id || null, send_at: r.send_at }); } catch (_err) { swallowed("server:best-effort", _err); }
        } else {
          // The schedule moved while SMTP was in flight. The mail has gone and
          // cannot be recalled, but the ROW must not be consumed — release the
          // claim so the reminder re-fires at its new time instead of waiting
          // out the 2-minute stale lease for a row that is already correct.
          _skipped++;
          releaseClaimStmt.run(claimToken);
        }
      } else {
        // SMTP rejected. Release this tick's claim. Matched by token so a
        // racing DELETE+INSERT leaves the fresh row untouched.
        releaseClaimStmt.run(claimToken);
      }
    }
  } finally {
    _reminderTickRunning = false;
  }
  return { ran: true, ...(_heldMid ? { held: true } : {}), claimed: _claimed, delivered: _delivered, skipped: _skipped, started: _started };
}
// infra audit (#1): gated behind NODE_ENV!=='test' and .unref()'d.
if (process.env.NODE_ENV !== "test") setInterval(() => { runReminderTick(); }, 30_000).unref();

// Lockout expiry poller — runs every 30 seconds, sends unlock emails for expired
// lockouts. infra audit (#1): NODE_ENV!=='test' gated + .unref()'d, like the
// reminder poller above. The pass is a named function so a test can drive one
// (POST /api/test/lockout-expiry-tick), as the reminder tick is.
// HELD WHILE THE INSTANCE IS OUT OF SERVICE (operator ruling, 25 Nov 2026), on
// the one gate: a held pass touches nothing, so the lock keeps its state and the
// "your account is unlocked" mail goes out once service resumes, never from a
// copied, restored, corrupt or half-migrated database. A sign-in's own
// auto-unlock (a request, not a pass) is not held.
function runLockoutExpiryPass() {
  if (!_instanceInService()) return { ran: false, held: true, unlocked: 0 };
  const expired = expiredLockouts();
  for (const u of expired) {
    clearLockout(u.id);
    // Mirror the on-login auto-unlock event (server.js ~2191) so forensic
    // analysis doesn't miss lockouts that expired while the user was offline.
    try { recordUserEvent(u.id, "auto_unlocked", "system", { reason: "lockout_expired", was_locked_until: u.locked_until }); } catch (_err) { swallowed("server:best-effort", _err); }
    trackDetachedSend(sendUnlockEmail(u, null).catch((e) => swallowed("server:unlock-mail", e, { level: "warn" })));   // v7.20.9 (F8) — countable at shutdown
  }
  return { ran: true, unlocked: expired.length };
}
if (process.env.NODE_ENV !== "test") setInterval(() => { runLockoutExpiryPass(); }, 30_000).unref();

// ── Tasks (participant, competition-scoped) ─────────────────────────────────

// v6.20.x — challenge CONTENT (titles, descriptions, attachment ZIPs) must not
// be readable before the participant's window is live. The submit/hint routes
// already block an `upcoming` slot/comp (server.js ~7047 / ~7178); the three
// participant READ routes below did not, so an enrolled participant could
// `POST /api/select-competition` for an UPCOMING comp (that route has no
// upcoming rejection) and read every published task — and download attachment
// payloads — before their slot started, defeating competition fairness. This
// gate mirrors the submit/hint `upcoming` check. `ended` stays readable so
// post-event review is unaffected. A multi-slot comp with no slot chosen = not
// yet admitted to any slot → treated as not-started (the SPA always chooses a
// slot before loading tasks, so this only blocks direct API callers).
// Returns a {status, name} block when content must be withheld, else null.
// participantContentNotStarted now lives in lib/competitions.js (imported at the
// top of this file) — shared by these participant task routes and the
// attachment-download route in routes/challenges.js.

// GET /api/tasks, GET /api/tasks/:id, POST /api/tasks/:id/hint now live in
// routes/participant.js (registered above). taskGradingHash -> lib/scoring.js.

const submitLimit = rateLimit(60_000, 120, "submit");
// A body DECLARING more than the submit form can accept is refused before multer
// reads a byte of it, with the sentence an over-limit file gets (an honest client
// only gets here by choosing too large a file).
const _submitDeclaredLengthGate = declaredLengthGate(_SUBMIT_UPLOAD_LIMITS, _MULTER_TOO_LARGE.LIMIT_FILE_SIZE);
// A bank question id named in the session's event means that event's own copy (lib/event-copies.js).
const _resolveEventTask = require("./lib/event-copies").resolveEventTaskParam(db, "id");
app.post("/api/tasks/:id/submit", requireParticipant, submitLimit, requireCompetitionContext, requireParticipantInCompetition, _resolveEventTask, csrfProtection, _submitDeclaredLengthGate, upload.single("file"), async (req, res) => {
  // v6.13.14 — perf-span instrumentation. POST /api/tasks/:id/submit
  // is the hot write-path on the platform; v6.13.13's 4 h run logged
  // its p95 creeping 4.6 → 16.1 ms (3.5×). Stages worth splitting:
  //   preflight_ms  — input validation, task lookup, grading-hash
  //                   check, file read, answer trim, grade compare.
  //                   Everything before the write transaction.
  //   txn_ms        — the db.transaction closure: status recheck,
  //                   dedupe window, submission INSERT, queued event
  //                   payloads, auto-end scan (conditional).
  //   autoend_ms    — the slice of txn_ms spent on the auto-end
  //                   machinery alone. Zero when the submit was
  //                   wrong / skipped / short-circuited by the
  //                   v6.8.1 fast-path. Dominates txn_ms when the
  //                   submit actually triggers the N-user scan.
  //   postcommit_ms — leaderboard-cache invalidation + scheduling the
  //                   setImmediate audit-event drain. The drain
  //                   itself runs on the next tick, outside this span.
  // res.on("finish") captures whichever res.json() / res.status().json()
  // path the request actually takes, so the span fires on normal
  // success AND on early validation rejections AND on deduped /
  // already-solved / rejected-on-ended paths. `outcome` is the tag
  // for which terminal branch the request landed on.
  const tHandler = process.hrtime.bigint();
  let tPreflightEnd = null;
  let tTxnEnd = null;
  let tAutoendStart = null;
  let tAutoendEnd = null;
  let autoendPath = "skipped";
  let outcome = "validation_fail";
  res.on("finish", () => {
    const tFinish = process.hrtime.bigint();
    const sp = _perfSplit(req, tHandler, tFinish);
    // v7.21.22 — the threshold is on the SERVER share. This route accepts the
    // participant's answer, so on a venue network the wait for their body can be
    // the whole of the wall clock while every server stage is sub-millisecond —
    // and it was reported as `prelude_ms`, which reads as middleware cost.
    const slowServer = sp.serverMs > PERF_SPAN_SLOW_MS;
    const slowClient = sp.clientBodyMs != null && sp.clientBodyMs > PERF_SPAN_SLOW_MS;
    if (!slowServer && !slowClient) return;
    const preflightMs = tPreflightEnd ? Number(tPreflightEnd - tHandler)   / 1e6 : sp.bodyMs;
    const txnMs       = (tPreflightEnd && tTxnEnd) ? Number(tTxnEnd - tPreflightEnd) / 1e6 : 0;
    const autoendMs   = (tAutoendStart && tAutoendEnd) ? Number(tAutoendEnd - tAutoendStart) / 1e6 : 0;
    const postcommitMs = tTxnEnd ? Number(tFinish - tTxnEnd) / 1e6 : 0;
    const fields = {
      req_id: req.id,
      // v7.21.28 — WHO and from WHERE. A "slow client upload" line naming only a
      // route is not actionable: on a shared venue address the operator needs to
      // know whose connection, and from which address, before they can do
      // anything about it.
      ..._requestActor(req),
      endpoint: "POST /api/tasks/:id/submit",
      total_ms: sp.totalMs.toFixed(1),
      // What the server is answerable for, and what it merely waited through.
      server_ms: sp.serverMs.toFixed(1),
      client_body_ms: sp.clientBodyMs == null ? null : sp.clientBodyMs.toFixed(1),
      // How much of that window the server was blocked and could not read the
      // socket. Non-zero here means the "slow client" reading is not safe.
      loop_blocked_ms: sp.loopBlockedMs.toFixed(1),
      // `prelude_ms` keeps its name and its place in the breakdown, but no longer
      // carries the client's transmission time.
      prelude_ms: sp.middlewareMs.toFixed(1),
      body_ms: sp.bodyMs.toFixed(2),
      preflight_ms: preflightMs.toFixed(2),
      txn_ms: txnMs.toFixed(2),
      autoend_ms: autoendMs.toFixed(2),
      autoend_path: autoendPath,
      postcommit_ms: postcommitMs.toFixed(2),
      outcome,
      file_upload: !!req.file,
    };
    // Two different findings, two different messages. "The endpoint is slow" and
    // "this participant's connection is slow" call for different responses, and a
    // WARN that fires on the second one every time the venue Wi-Fi dips is how an
    // operator learns to ignore the first.
    if (slowServer) log.warn(fields, "[perf-span] slow POST /api/tasks/:id/submit");
    else log.info(fields, "[perf-span] slow CLIENT upload on POST /api/tasks/:id/submit (server was fast)");
  });

  const compId = req.session.competitionId;
  const compName = sanitiseForLog(req.competition.name);
  // For multi-slot: check the participant's timeslot status, not the competition status
  const activeStatus = req.timeslot ? timeslotStatus(req.timeslot) : req.competitionStatus;
  const activeName = req.timeslot ? sanitiseForLog(req.timeslot.name) : compName;
  // v8.6.0 — a LATE ENTRANT plays on past the end, and only they do.
  //
  // `req.lateEntry.canPlay` is resolved once by requireCompetitionContext and is
  // already the conjunction of "the window is open" and "this participant arrived
  // late", so a gate cannot check one half and forget the other. An ordinary
  // participant of the same event still meets this refusal the instant it ends.
  //
  // BOTH gates on this path move together — this one and the in-transaction
  // re-check on `freshComp` below. Widening only this one makes every late
  // submission fail at the second with the same "<name> has ended" sentence, which
  // is indistinguishable from the feature not working at all.
  const _lateCanPlay = !!(req.lateEntry && req.lateEntry.canPlay);
  if (activeStatus === "ended" && !_lateCanPlay) { cleanupUpload(req); return res.status(403).json({ error: `${activeName} has ended` }); }
  if (activeStatus === "upcoming") { cleanupUpload(req); return res.status(403).json({ error: `${activeName} has not started yet` }); }
  if (hasTimeslots(compId) && !req.session.timeslotId) { cleanupUpload(req); return res.status(400).json({ error: "Please choose a session before submitting answers." }); }
  // v6.9.17: cap the text answer at SUBMIT_ANSWER_MAX_CHARS. The file-answer
  // path is already bounded by multer (10 MB). The text path inherited the
  // express.json() default (~100 KB or whatever the operator set via
  // the global limit) and then ran two full-text allocations + a
  // regex pass per submission — under 200-VU concurrent submits a
  // pathological 1 MB payload becomes a meaningful event-loop cost.
  // 64K characters is well above any legitimate text / JSON answer.
  const _answerText = typeof req.body.answer === "string" ? req.body.answer : "";
  if (_answerText.length > SUBMIT_ANSWER_MAX_CHARS) {
    cleanupUpload(req);
    return res.status(413).json({ error: SUBMIT_ANSWER_TOO_LONG });
  }

  const inComp = db.prepare("SELECT 1 FROM competition_tasks WHERE competition_id=? AND task_id=?").get(compId, req.params.id);
  if (!inComp) { cleanupUpload(req); return res.status(404).json({ error: "Challenge not found" }); }

  // `let`, not `const`: the file path re-reads this after its await and grades
  // against the fresh row (see the re-validation block below).
  let task = db.prepare("SELECT * FROM tasks WHERE id=? AND active=1 AND status='published'").get(req.params.id);
  // Set once this request STORES an answer: only a stored answer may start a
  // first-open solve clock (lib/middleware.js `stampClockOnFirstTouch`), never
  // a refused or folded one.
  let _answerStored = false;
  if (!task) { cleanupUpload(req); return res.status(404).json({ error: "Challenge not found" }); }
  // The locked flag was previously cosmetic — only blocked admin edits in the
  // UI. Honour it on submit too: a locked task is treated as frozen, so neither
  // late-arriving submissions nor admin-initiated regrading can mutate score.
  if (task.locked) { cleanupUpload(req); return res.status(423).json({ error: "This challenge is locked and is no longer accepting submissions." }); }
  // audit v7.7.32 (RM1) — the upload was rejected by the MIME filter (a file
  // WAS chosen, just not an accepted type). Return a specific, actionable error
  // BEFORE the task_changed check below, which would otherwise misattribute this
  // to an admin reconfiguration and trigger a pointless task reload.
  if (req._uploadRejected) {
    cleanupUpload(req);
    return res.status(400).json({ error: "Unsupported file type — upload a plain-text file (e.g. .txt, .json, or .csv)." });
  }
  // Mismatch between the request body shape and the current task.answer_type
  // usually means the admin reconfigured the challenge mid-session. Return a
  // structured error and DO NOT count this as a wrong answer (no -5 penalty).
  // Client should reload task data and re-render the correct input UI.
  const requestHasFile = !!req.file;
  if (task.answer_type === "file" && !requestHasFile) {
    cleanupUpload(req);
    return res.status(400).json({ error: "This challenge now expects a file upload. Please reload the page.", task_changed: true });
  }
  if (task.answer_type !== "file" && requestHasFile) {
    cleanupUpload(req);
    return res.status(400).json({ error: "This challenge no longer accepts file answers. Please reload the page.", task_changed: true });
  }
  // Grading-basis snapshot check (v6.2.6). If the client-submitted gradingHash
  // doesn't match the freshly-computed one, an admin changed correct_answer
  // (or answer_type / choices) between the participant's page-load and this
  // submit. Refuse to grade against criteria the participant didn't see — they
  // get task_changed:true with no -5 penalty, and the client reloads the task.
  //
  // ext-audit v7.20.9 (F1) — the token is now REQUIRED. It was optional for
  // back-compat with pre-v6.2.6 clients, which meant the guard was opt-out:
  // omit one field and the server would grade you against whatever the criteria
  // happen to be right now. An optional guard is not a guard, and there are no
  // pre-v6.2.6 clients left — the SPA has echoed it since, and it is issued on
  // every GET /api/tasks/:id. A missing token is treated exactly like a stale
  // one (409 + task_changed, no penalty), so the client's existing recovery
  // path — reload the challenge and retry — already handles it.
  // typeof, never `.toString()`: a JSON or form-encoded body can carry an object
  // whose own `toString` is not callable, or a deeply nested array, and either
  // threw here (a 500) — a non-string token is simply a missing one.
  const submittedHash = typeof req.body.gradingHash === "string" ? req.body.gradingHash : "";
  {
    const currentHash = taskGradingHash(task.answer_type, task.correct_answer, task.choices);
    if (submittedHash !== currentHash) {
      cleanupUpload(req);
      return res.status(409).json({ error: "This challenge was just updated by an admin. Reload the page to see the new version — your attempt was NOT counted.", task_changed: true });
    }
  }
  let answer = "";
  if (req.file) {
    // Async read + unlink (v6.8.0): the sync file operations used to block
    // the event loop during a submission burst (last-minute scramble on a
    // 30-challenge live event). Reading asynchronously yields to other
    // concurrent requests while the disk I/O is in flight.
    const filename = path.basename(req.file.path);
    const safePath = path.join(UPLOADS_DIR, filename);
    // Refused unread when its size cannot fit the cap below: an answer within the
    // cap takes at most 3 bytes per code unit (an invalid byte run decodes to one
    // U+FFFD per at most 3 bytes), so a larger file fits only by carrying more
    // leading and trailing whitespace than that — refused too, rather than
    // pulling up to 10 MB into memory to find out.
    if (!(req.file.size <= 3 * SUBMIT_FILE_ANSWER_MAX_CHARS)) {
      try { await fs.promises.unlink(safePath); } catch (_err) { /* best-effort; the uploads sweep is the backstop */ swallowed("server:submit-unlink", _err); }
      return res.status(413).json({ error: SUBMIT_FILE_ANSWER_TOO_LARGE });
    }
    try {
      answer = (await fs.promises.readFile(safePath, "utf8")).trim();
    } catch (e) {
      try { await fs.promises.unlink(safePath); } catch (_err) { swallowed("server:best-effort", _err); }
      return res.status(500).json({ error: "Could not read the uploaded file. Please try again." });
    }
    try { await fs.promises.unlink(safePath); } catch (_err) { /* best-effort */ swallowed("server:submit-unlink", _err); }
    if (_testSubmitReadDelayMs) { _testSubmitReadParked++; await new Promise(r => setTimeout(r, _testSubmitReadDelayMs)); }
    if (answer.length > SUBMIT_FILE_ANSWER_MAX_CHARS) {
      return res.status(413).json({ error: SUBMIT_FILE_ANSWER_TOO_LARGE });
    }
    // ext-audit v7.15.13 — RE-READ the challenge after the await.
    //
    // Everything above (assignment, task row, lock, answer_type, gradingHash)
    // was read BEFORE `await readFile`, and that await yields the event loop.
    // An admin who locks the challenge, edits the correct answer, unpublishes
    // it, or unassigns it from the competition during the read used to be
    // ignored entirely: grading ran against the stale snapshot, so a locked
    // challenge still awarded its points. Only the FILE path has this window —
    // the text path never awaits between the checks and grading.
    //
    // The checks are repeated rather than moved because the pre-read pass is
    // what avoids reading a file we were never going to grade; this pass is
    // what makes the decision current. Same status codes and same
    // `task_changed` contract, so the client behaves identically.
    const freshInComp = db.prepare("SELECT 1 FROM competition_tasks WHERE competition_id=? AND task_id=?").get(compId, req.params.id);
    if (!freshInComp) return res.status(404).json({ error: "Challenge not found" });
    const freshTask = db.prepare("SELECT * FROM tasks WHERE id=? AND active=1 AND status='published'").get(req.params.id);
    if (!freshTask) return res.status(404).json({ error: "Challenge not found" });
    if (freshTask.locked) return res.status(423).json({ error: "This challenge is locked and is no longer accepting submissions." });
    if (freshTask.answer_type !== "file") {
      return res.status(400).json({ error: "This challenge no longer accepts file answers. Please reload the page.", task_changed: true });
    }
    if (submittedHash !== taskGradingHash(freshTask.answer_type, freshTask.correct_answer, freshTask.choices)) {
      return res.status(409).json({ error: "This challenge was just updated by an admin. Reload the page to see the new version — your attempt was NOT counted.", task_changed: true });
    }
    // Grade against what is true NOW, not what was true before the read.
    task = freshTask;
  } else {
    // batch 6 — `(x||"")` lets a truthy non-string reach .trim() → 500; typeof-guard to "".
    // v8.9.0 — an `any` answer is stored VERBATIM (no trim, no case fold): the
    // operator's rule for that type is "accept as is", and the submissions view
    // and the free-text CSV render exactly what was typed.
    const _rawAnswer = typeof req.body.answer === "string" ? req.body.answer : "";
    answer = task.answer_type === "any" ? _rawAnswer : _rawAnswer.trim();
  }
  // Event team reports — a PICK-ONE question (`any` with options, lib/choices.js
  // `isSurveyTask`): exactly ONE of this challenge's option ids, else 400 before
  // grading (no row, no attempt), like a malformed multiple-choice answer.
  const _survey = isSurveyTask(task);

  // v8.9.0 — an any-answer challenge accepts every NON-EMPTY answer, so an empty
  // or whitespace-only one is not a wrong answer to be penalised, it is a
  // validation failure: refused BEFORE grading, no row written, no -5. A 4xx is
  // safe here for the reason the hint route's 400 is — the client already
  // refuses an empty box, so only a scripted caller reaches this.
  if (task.answer_type === "any" && !answer.trim()) {
    return res.status(400).json({ error: "An answer is required." });
  }

  let correct = false;
  let answerCanonical = null;   // v7.20.9 (F2) — choice tasks only; see below.
  if (task.answer_type === "choice") {
    // v7.19.0 — the participant submits choice IDs (never positions: the
    // options are shuffled per participant, so position means nothing here).
    // All-or-nothing: the selected SET must equal the correct SET. That keeps
    // `submissions.is_correct` a genuine boolean, which the all-solved auto-end,
    // the leaderboard dedup and the analytics solve-rate all depend on.
    const _picked = parseSubmittedIds(answer);
    const _choices = parseChoices(task.choices);
    const _valid = new Set(_choices.map(c => c.id));
    // v8.14.6 — an answer must be one or more of THIS challenge's options and
    // nothing else. Anything else is not a wrong answer but a malformed request,
    // refused BEFORE grading like an empty `any` answer: no row, no -5, no
    // attempt. The page sends only ids it was served, and the grading-hash check
    // above refuses a page whose options have changed, so only a scripted
    // caller reaches this (why a 4xx is safe). Graded wrong, a pick of nothing
    // was stored as "(nothing selected)", which Recalculate after a switch to
    // `any` read as a non-empty answer and turned into a solve.
    if (!_picked.length || !_picked.every(id => _valid.has(id))) {
      return res.status(400).json({ error: "Choose one or more of this challenge's options." });
    }
    correct = gradeChoice(_picked, parseCorrectIds(task.correct_answer));
    // Store what a human can read: the admin Submissions view renders this
    // column verbatim, and a list of opaque 8-hex ids there is useless.
    answer = describeSelection(_picked, _choices);
    // ext-audit v7.20.9 (F2) — and store the CANONICAL selection alongside it.
    // The human rendering is lossy: option text can be edited afterwards, and
    // two options could share a label, so it cannot be turned back into ids
    // reliably. `POST /api/admin/tasks/:id/recalculate` re-grades from this
    // column; without it, it compared "Paris | Rome" against `["6bc9f335"]`
    // and turned every correct choice submission into a -5.
    answerCanonical = JSON.stringify(_picked);
  } else if (task.answer_type === "json") {
    try { correct = jsonExactMatch(JSON.parse(answer), JSON.parse(task.correct_answer)); } catch { correct = false; }
  } else if (task.answer_type === "any" && _survey) {
    // Event team reports — every OPTION is accepted; anything that is not exactly
    // one of them is refused, not graded. Stored like a choice answer (text for
    // the reader, the id list for the reports and Recalculate).
    const _picked = parseSubmittedIds(answer);
    const _choices = parseChoices(task.choices);
    const _valid = new Set(_choices.map(c => c.id));
    if (_picked.length !== 1 || !_valid.has(_picked[0])) {
      return res.status(400).json({ error: "Choose one of this question's options." });
    }
    correct = true;
    answer = describeSelection(_picked, _choices);
    answerCanonical = JSON.stringify(_picked);
  } else if (task.answer_type === "any") {
    // v8.9.0 — non-empty was enforced above; every such answer is correct.
    correct = true;
  } else if (task.answer_type === "text") {
    // v8.9.0 — `correct_answer` is a newline-separated list of accepted
    // answers (one line = today's single answer, byte-for-byte the old rule);
    // each is compared with all whitespace stripped and case folded.
    correct = gradeTextAnswer(answer, task.correct_answer);
  } else {
    // file — the ONE stored string, whole. Deliberately NOT the list rule: a
    // file's expected content may legitimately span several lines.
    correct = normaliseTextAnswer(answer) === normaliseTextAnswer(task.correct_answer);
  }

  // Event team reports — a QUALIFYING challenge scores nothing (lib/qualifying.js).
  const _qualifyingTask = isQualifyingTask(db, task.id);
  const pts = _qualifyingTask ? 0 : (correct ? POINTS[task.difficulty] : -PENALTY);
  const tsId = req.session.timeslotId || null;
  const selfInfo = db.prepare("SELECT email, nickname FROM users WHERE id=?").get(req.session.userId);
  const identity = selfInfo?.email || "system";
  // v7.14.0 — impersonation context, captured BEFORE the txn + deferred event
  // drain (the queued emits run on a later tick, so the flag must ride the
  // bound args — never re-read req.session inside a deferred fn). A submit can
  // only arrive here impersonated from a SUPERADMIN-origin session (the global
  // impersonationGuard rejects regular-admin writes); the submission row is
  // real, but the challenge_events row is stamped impersonated=1 so analytics
  // never counts it, and the audit events carry impersonated_by for forensics.
  const impersonated = isImpersonating(req);
  const impCtx = impersonated ? { impersonated_by: impersonationActor(req.session) } : null;

  // Wrap status recheck + already-solved check + submission insert + auto-end in a
  // single transaction so a concurrent auto-end cannot slip between status check
  // and insert (TOCTOU race).
  //
  // v6.8.2 — event-table inserts (_events tables + challenge_events) are
  // collected into `pendingEvents` inside the transaction and fired AFTER
  // commit via setImmediate. Keeps the write lock held only for the
  // correctness-critical path (submission insert + auto-end UPDATE). At
  // 100+ submits/s during a final-minute scramble this removes ~5
  // downstream insert statements from the per-submit lock-hold window.
  // Trade-off: a server crash between commit and the drain tick loses the
  // audit events for that submission, but the submission row itself is
  // durable — forensic reconstruction from the row plus surrounding audit
  // remains possible.
  const pendingEvents = [];
  const queueEvent = (fn, ...args) => pendingEvents.push([fn, args]);
  // v8.8.9 — read ONCE, here, while the request is still in hand.
  const reqCtx = reqContext(req);

  // v6.13.14 — preflight boundary. Everything from the handler body
  // start through validation + task lookup + file read + grading has
  // run; the next call starts the write transaction.
  tPreflightEnd = process.hrtime.bigint();
  const submitAndAutoEnd = db.transaction(() => {
    // Re-verify competition/timeslot status inside the write transaction.
    // "Inside the transaction" is what makes every re-read below
    // authoritative — NOT the lock mode: better-sqlite3's db.transaction()
    // is a DEFERRED BEGIN, so the write lock is only taken at the first
    // write (the submissions INSERT), after these reads. They hold because
    // the body is synchronous, so in this single-process server no other
    // request can run between a read and the INSERT; and an EXTERNAL
    // writer that commits in between makes that INSERT fail
    // SQLITE_BUSY_SNAPSHOT rather than act on the stale read.
    const freshComp = getCompetition(compId);
    // v8.1.7 — a VANISHED competition is a refusal, not "not ended".
    //
    // `req.competition` / `req.competitionStatus` were snapshotted by
    // requireCompetitionContext BEFORE multer consumed the upload, and the
    // status re-check below tests only `=== "ended"` — but
    // `competitionStatus(null)` returns null, so a competition deleted under
    // this request would fall THROUGH the guard rather than into it: graded,
    // and INSERTed with a competition_id that no longer resolves.
    // `submissions.competition_id` has no foreign key, so that row would
    // survive the delete's own explicit purge as an orphan, and the participant
    // would be told their answer had been accepted for an event that is gone.
    // The adjacent auto-end branch already guards `freshComp &&` for exactly
    // this case; this closes the same door on the grading path.
    //
    // STATED PLAINLY: this is DEFENCE IN DEPTH today and removing it changes
    // nothing observable. The delete purges `competition_tasks` in the same
    // transaction, so both the pre-read assignment check and the file path's
    // post-read re-check already answer 404 "Challenge not found" first, and
    // there is no await between the last of those and this transaction for a
    // delete to land in. The lock in tests/lifecycle-tail.spec.js therefore
    // drives the reachable shape (the request is refused and no row is written)
    // and pins this line at source; do not read it as behaviourally covered.
    //
    // 404 rather than the 403 below, and the same sentence
    // requireCompetitionContext answers with, because that is what the
    // participant's next request would tell them anyway.
    if (!freshComp) return { compGone: true };
    // v8.11.1 (external audit F3) — AND THE PARTICIPANT IS STILL ENTITLED TO ACT.
    //
    // `requireParticipant` and `requireParticipantInCompetition` ran before
    // multer consumed the body, so on a file submission their answer is as old as
    // the upload. An admin who blocks a participant for cheating, or removes them
    // from the event, is told 200 — and the suspended submission then commits,
    // grades, scores and can auto-end the event. Measured at 30 s with no test
    // hook. This is the v7.15.13 rule ("re-check everything the window can
    // invalidate, not only the row that motivated it") applied to the half that
    // release left out: it re-read the TASK and never the ACTOR.
    //
    // The predicate is `lib/middleware.js`'s, shared with the guards rather than
    // spelled a third time here; it deliberately does not re-ask `verified`.
    //
    // v8.12.6 (review fix) — AND, UNDER IMPERSONATION, THE ADMIN AT THE KEYBOARD.
    // `req.session.userId` is the TARGET here, so `participantAuthzDenied` asks
    // only about the seat; the acting admin was read once, by impersonationGuard, when the
    // headers arrived. A superadmin impersonating a participant and revoked
    // while this file answer was still uploading was answered 200 and scored for
    // the participant — measured. Asked first: the refusal it gives is about the
    // session, and must not be pre-empted by an answer about the target.
    const _hand = impersonatingHandDenied(req);
    if (_hand) return { handDenied: _hand };
    const _authz = participantAuthzDenied(req.session.userId, compId);
    if (_authz) return { authzDenied: _authz };
    // AND THE SESSION ITSELF, for a session acting as its own account: a password
    // reset, a sign-in elsewhere or a logout during the upload tombstones the
    // session and leaves the account qualifying, so neither line above sees it
    // (lib/middleware.js `participantSessionDenied`).
    const _sess = participantSessionDenied(req);
    if (_sess) return { sessionDenied: _sess };
    const freshStatus = req.timeslot
      ? timeslotStatus(getTimeslot(req.session.timeslotId) || req.timeslot)
      : competitionStatus(freshComp);
    // v8.6.0 — the late-entry twin of the pre-transaction gate above. This is the
    // one that HOLDS: it reads `freshComp` inside the write transaction, so an admin
    // who ended the event or turned late entries off during the upload is honoured.
    //
    // `_lateCanPlay` is deliberately NOT re-derived here from `freshComp`. Whether
    // this participant ARRIVED late is a fact about a timestamp already written and
    // cannot change under the request; what CAN change is the event's schedule and
    // its toggle, and both are re-read by `lateEntryWindowOpen` against the fresh
    // row. Re-running the whole classification would add two queries inside the
    // write transaction to re-answer a question with no new inputs.
    if (freshStatus === "ended" && !(_lateCanPlay && lateEntryWindowOpen(freshComp, competitionEffectiveEnd(freshComp), Date.now()))) return { rejected: "ended" };

    // Operator ruling 395 (14 Nov 2026) — A QUICK QUESTION'S ANSWER CAN BE
    // CHANGED while the person can still play (the gates above): a qualifying
    // pick-one question takes a new pick as another row, and the reports and the
    // person's own view read the latest. Never a scoring challenge, which keeps
    // "already solved"; the attempt cap below does not bind a change either.
    // One definition (lib/qualifying.js), shared with the challenge read and the
    // list's `out_of_attempts`, so neither says spent what this would take.
    const _changeable = require("./lib/qualifying").changeableQuickQuestion(task, _qualifyingTask);
    if (!_changeable && db.prepare("SELECT id FROM submissions WHERE user_id=? AND task_id=? AND competition_id=? AND is_correct=1").get(req.session.userId, task.id, compId))
      return { alreadySolved: true };

    // Idempotency window: a double-click / browser-retry / two-tab race that
    // submits the *same* answer text within 3 seconds is folded into a single
    // submission so the user is never penalised twice for one logical attempt.
    // Different answers within 3s are still independent submissions.
    // v6.16.11 — uses now() rather than Date.now() so a test stub on the
    // platform clock propagates here.
    const dedupCutoff = new Date(now().getTime() - 3000).toISOString();
    // ext-audit v7.21.1 — the dedup key is the MACHINE value where one exists.
    //
    // `submissions.answer` holds a HUMAN rendering for a choice task, and
    // describeSelection() joins the picked options with " | " — so selecting one
    // option literally named "A | B" renders identically to selecting separate
    // options A and B, and the second submission was silently swallowed as a
    // duplicate. v7.20.9 made exactly this argument for recalculate and missed
    // this site. COALESCE rather than a direct bind: `answer_canonical` is NULL
    // for text/json/file, and `answer_canonical = NULL` is never true, which
    // would quietly disable the dedup for the three original answer types.
    const dedupKey = answerCanonical ?? answer;
    // Operator ruling 395 — A CHANGEABLE QUICK QUESTION IS COMPARED WITH THE
    // PERSON'S LATEST ANSWER, at any age, never with the 3 s window: the same
    // pick as their answer now is no change (answered `deduped`, nothing
    // stored), and any other pick is a change, even back to one they made a
    // moment ago (the window would fold that into the older row and leave the
    // later pick as their answer). The order is the reports' and `my_choice_ids`'.
    let recentSame;
    if (_changeable) {
      const _latest = db.prepare(
        "SELECT id, is_correct, COALESCE(answer_canonical, answer) AS k FROM submissions WHERE user_id=? AND task_id=? AND competition_id=? ORDER BY submitted_at DESC, rowid DESC LIMIT 1"
      ).get(req.session.userId, task.id, compId);
      recentSame = _latest && _latest.k === dedupKey ? _latest : null;
    } else {
      recentSame = db.prepare(
        "SELECT id, is_correct, points_delta FROM submissions WHERE user_id=? AND task_id=? AND competition_id=? AND COALESCE(answer_canonical, answer)=? AND submitted_at >= ? ORDER BY submitted_at DESC LIMIT 1"
      ).get(req.session.userId, task.id, compId, dedupKey, dedupCutoff);
    }
    // v8.13.1 (external audit) — and with the participant's CURRENT attempt
    // standing. The repeat that gets folded is usually a RETRY whose first
    // response was lost (venue wi-fi), so the card still shows the count from
    // before that first answer: "2 left" when 1 is, with no last-attempt warning
    // on the next confirm. One cap read and two indexed counts, on a rare path.
    if (recentSame) return { deduped: true, correct: !!recentSame.is_correct, attempts: attemptState(req.session.userId, task, freshComp) };

    // v8.1.0 — THE ATTEMPT CAP, enforced inside the write transaction.
    //
    // Placed AFTER already-solved (a participant who has solved it is never
    // blocked) and AFTER dedup (a double-click must not spend an attempt), and
    // BEFORE the velocity throttle, because "you have no attempts left" is the
    // more specific and more actionable answer and this path writes nothing
    // anyway. `freshComp` and `task` are the rows re-read inside this same
    // transaction, so a cap raised or a grant made a moment ago is already visible.
    const capBefore = attemptState(req.session.userId, task, freshComp);
    if (capBefore.exhausted && !_changeable) return { attemptsExhausted: true, attempts: capBefore };

    // v6.13.18 — per-(user, task) velocity throttle. Bounded by an
    // index on submissions(user_id, task_id, competition_id) — the
    // count is read-only, runs inside the same transaction as the
    // INSERT below, and adds ~0.05 ms in the live-comp profile. Reads
    // a 60-second window only; the dedupe check above already covers
    // the 3-second sub-window for same-answer collisions, so this cap
    // exists exclusively to bound DIFFERENT-answer write volume.
    // v6.16.11 — same now()-based clock as dedupCutoff above.
    const velocityCutoff = new Date(now().getTime() - 60_000).toISOString();
    const recentCount = db.prepare(
      "SELECT COUNT(*) AS c FROM submissions WHERE user_id=? AND task_id=? AND competition_id=? AND submitted_at >= ?"
    ).get(req.session.userId, task.id, compId, velocityCutoff).c;
    if (recentCount >= SUBMIT_VELOCITY_MAX_PER_MIN) return { rateLimited: true };

    // v6.10.83: updated_at mirrors submitted_at on INSERT; recalc bumps it
    // so /api/admin/submissions MAX(updated_at) surfaces drift mid-walk.
    const submittedAtIso = now().toISOString();
    db.prepare("INSERT INTO submissions (id,user_id,task_id,answer,is_correct,points_delta,submitted_at,competition_id,timeslot_id,updated_at,answer_canonical) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(uuid(), req.session.userId, task.id, answer, correct ? 1 : 0, pts, submittedAtIso, compId, tsId, submittedAtIso, answerCanonical);
    _answerStored = true;

    // Audit trail — every submission attempt, correct or wrong.
    const evDetails = {
      competition_id: compId,
      task_id: task.id,
      task_title: task.title,
      timeslot_id: tsId,
      correct,
      points_delta: pts,
      // v8.8.9 — the requester's ip/ua/req_id, captured at QUEUE time. These
      // emits drain post-commit via setImmediate, so `req` must be read while
      // the request is still in hand: `req.ip` is a lazy getter onto the socket.
      ...reqCtx,
      ...(impCtx || {}),
    };
    const compEvDetails = {
      user_id: req.session.userId,
      nickname: selfInfo?.nickname || null,
      task_id: task.id,
      task_title: task.title,
      timeslot_id: tsId,
      correct,
      points_delta: pts,
      ...reqCtx,
      ...(impCtx || {}),
    };
    const evType = correct ? "submission_correct" : "submission_wrong";
    queueEvent(recordUserEvent, req.session.userId, evType, identity, evDetails);
    // DB rows only — the user-scope mirror above already carries competition_id
    // and timeslot_id, so the competition/timeslot mirrors would be redundant.
    queueEvent(recordCompetitionEvent, compId, evType, identity, compEvDetails, { mirror: false });
    if (tsId) queueEvent(recordTimeslotEvent, tsId, evType, identity, compEvDetails, { mirror: false });

    // Per-challenge analytics row. attempt_number counted post-insert so the
    // row just written is included (first attempt → 1). The COUNT still runs
    // inside the tx so it sees a consistent view including the just-written
    // submission; the event INSERT itself is deferred to post-commit.
    const attemptNumber = db.prepare(
      "SELECT COUNT(*) as c FROM submissions WHERE user_id=? AND task_id=? AND competition_id=?"
    ).get(req.session.userId, task.id, compId).c;
    queueEvent(recordChallengeEvent, req.session.userId, task.id, compId, tsId,
      correct ? "solved" : "incorrect",
      // v8.10.0 — `answer_length` is omitted for a SEALED challenge. It is a weak
      // oracle rather than a disclosure — knowing the key is nine characters long
      // narrows a guess without revealing it — but `challenge_events` is read by
      // any admin with database access and the seal's whole claim is that the
      // answer reaches nobody. A length is a property OF the answer, so it goes.
      // Omitted rather than zeroed: a stored 0 is a real length for an empty
      // submission, and analytics reads none of these fields, so absence costs
      // nothing measurable.
      { points_delta: pts, ...(task.answer_sealed ? {} : { answer_length: answer.length }), attempt_number: attemptNumber, ...(impCtx || {}) },
      impersonated);

    // v8.1.0 — did THIS submission spend the participant's last attempt?
    //
    // The auto-end scan below has always been gated on `correct`, and that gate
    // cannot fire in the case attempt caps introduce: exhaustion is BY DEFINITION
    // a wrong answer. Without this the last participant to run out makes a capped
    // event never auto-end — everyone else is done, the board cannot move, and it
    // runs to its deadline with nothing happening.
    // v8.13.2 — the uncapped branch counts the answer just stored too: `used`
    // reaches the card as its "N attempt(s)" header (attemptsWire), and leaving it
    // at the pre-insert count would make that number lag by exactly one.
    const capAfter = capBefore.capped
      ? { ...capBefore, used: capBefore.used + 1, left: Math.max(0, capBefore.effective - (capBefore.used + 1)),
          exhausted: (capBefore.used + 1) >= capBefore.effective }
      : { ...capBefore, used: capBefore.used + 1 };
    const justExhausted = !correct && capAfter.capped && capAfter.exhausted;

    // Auto-end check: per-timeslot if multi-slot, per-competition if single-slot
    // Staff and benchmark users are excluded from this check
    let autoEndInfo = null;
    if (correct || justExhausted) {
      tAutoendStart = process.hrtime.bigint();
      // A QUALIFYING (Quick) answer asks whether everyone has finished only as
      // the person's FIRST answer to that question: the early end now waits for
      // the quick questions too (operator ruling, 17 Nov 2026), so a first answer
      // can be the one that completes the event. A changed answer completes
      // nothing, and running the scan on it ended an event whose participants
      // had all finished while it stayed live (a join link open then closed).
      if (_qualifyingTask && db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE user_id=? AND task_id=? AND competition_id=?")
        .get(req.session.userId, task.id, compId).c > 1) {
        autoendPath = "qualifying_answer";
        tAutoendEnd = process.hrtime.bigint();
        return { autoEndInfo: null, attempts: capAfter };
      }
      // v7.7.18 — suppress the "all solved" auto-end while SELF-ENROLLMENT is OPEN
      // for this competition (self_enroll_enabled=1). A new participant can join via
      // the /join link at any moment, so ending the instant the CURRENT enrollees
      // finish everything is premature: it would freeze the comp and 404 the live
      // self-enroll link. Time-based ends + manual end-now are unaffected — only
      // this early all-solved end is skipped (and we skip the whole scan, a cheap
      // win for self-enroll comps). See "Auto-end vs self-enrollment" in CLAUDE.md.
      // ext-audit v7.21.1 — `freshComp`, NOT `req.competition`.
      //
      // On the FILE path `req.competition` is a snapshot taken before multer and
      // before the `await fs.promises.readFile` — i.e. it can be a whole upload
      // old. v7.15.13 re-read the TASK across that window but left this check on
      // the stale competition, so toggling self-enrollment during an upload
      // produced the opposite auto-end decision: a competition that should have
      // stayed open auto-ended (freezing it and 404ing its live /join link — the
      // worse direction), or one that should have ended stayed open. `freshComp`
      // is read inside this same transaction and is already the authority for the
      // ended/status re-check above. The `&&` guard stays: getCompetition returns
      // null for a competition deleted mid-upload, and an unguarded read would
      // turn that into a 500.
      if (freshComp && freshComp.self_enroll_enabled) {
        autoendPath = "self_enroll_open";
        tAutoendEnd = process.hrtime.bigint();
        // v8.1.0 — EVERY exit from this transaction carries `attempts`, including
        // the three auto-end fast paths. Caught by a test: the last attempt is the
        // one that enters this block, so forgetting it here made `attempts_left`
        // vanish from the response for exactly the submission where the number
        // matters most — the one that spends the participant's last try.
        return { autoEndInfo: null, attempts: capAfter };
      }
      // v8.1.0 (PR 16) — honour the per-event auto-end opt-out. Until now the
      // column existed and NOTHING read it, so a Program would have auto-ended the
      // moment its first enrollee finished: closed to everyone after them on a kind
      // built for rolling enrolment, every shared challenge frozen, and STUCK
      // closed, because the extend-the-deadline revive re-checks all-solved and
      // refuses while it still holds. Read from `freshComp` for the same
      // reason the self-enroll check above is — the snapshot can be a whole upload
      // old, and this decision must be made on the row as it is now.
      //
      // v8.3.11 — THE KIND'S PROHIBITION JOINS THE COLUMN, and the rule now lives
      // in ONE place (`autoEndOnAllSolvedApplies`, lib/event-policy.js) because it
      // has three consumers: this scan and the two revive gates, which until now
      // asked a weaker question and could refuse to reopen an event that was never
      // able to auto-end in the first place.
      //
      // Reading the policy rather than trusting the column turns the Booth
      // guarantee from a CONVENTION into a THEOREM. Before this it rested on three
      // cooperating writers all storing 0 — the create bind, the kind-change reset,
      // and the column's absence from COMPETITION_FIELD_SCHEMA — which is correct
      // and one writer away from silently false. It HAS been false: at v8.0.0 the
      // create INSERT did not name the column, so a Booth Event created in that
      // one-day window took the schema DEFAULT 1 and auto-ends to this day. db.js
      // normalises those rows on boot; this gate is what makes the rule hold for a
      // row no migration reached — direct SQL, a restored backup, a future writer.
      //
      // TWO TAGS, ONE RULE. The span must say WHICH clause refused: "this kind
      // never auto-ends" and "an admin turned it off for this event" are different
      // operational answers, and collapsing them would make a Booth Event's
      // behaviour indistinguishable from a misconfigured Competition.
      if (freshComp && !autoEndOnAllSolvedApplies(freshComp)) {
        autoendPath = eventPolicy(freshComp).autoEndOnAllSolved === "never"
          ? "auto_end_forbidden_for_kind"
          : "auto_end_disabled";
        tAutoendEnd = process.hrtime.bigint();
        return { autoEndInfo: null, attempts: capAfter };
      }
      const totalTasks = publishedTaskCount(compId);
      // v6.8.1 — cheap pre-filter: the current submitter can only be the
      // "last solver" if they themselves have now solved every task. If
      // their personal count is still below totalTasks, skip the full
      // allParticipantsSolvedAll scan entirely. At 100 submits/s during a
      // final-minute burst this collapses the per-submit auto-end scan
      // from an N-user aggregate to a single COUNT that already hits the
      // idx_submissions_user_comp index.
      if (totalTasks > 0) {
        const mineSolved = db.prepare(
          `SELECT COUNT(DISTINCT s.task_id) as c FROM submissions s
           JOIN competition_tasks ct ON ct.task_id=s.task_id AND ct.competition_id=s.competition_id
           JOIN tasks t ON t.id=s.task_id
           WHERE s.user_id=? AND s.competition_id=? AND s.is_correct=1 AND t.active=1 AND t.status='published' AND ${notQualifyingSql("t")}`
        ).get(req.session.userId, compId).c;
        // v8.1.0 — THE FAST PATH ENCODED THE SAME ASSUMPTION AS THE OUTER GATE,
        // one layer down, and fixing only the gate left it dead.
        //
        // Its premise is "the submitter can only be the last one finished if they
        // have SOLVED everything". Under an attempt cap a participant is finished
        // by EXHAUSTION too, with `mineSolved` still 0 — so the scan was skipped
        // on precisely the submission that completes a capped event, and it never
        // ended. Measured: the auto-end test reported "live" with the outer gate
        // already correct.
        //
        // The cheap COUNT stays FIRST and an uncapped event takes one extra
        // indexed EXISTS and then behaves exactly as before — the hot path this
        // fast path exists for (a correct submit during a final-minute burst) is
        // unchanged. Only when a cap is actually in play do we ask the shared
        // predicate, and only about THIS ONE participant.
        let mineFinished = mineSolved >= totalTasks;
        if (!mineFinished && (freshComp?.attempt_cap != null || db.prepare(
          `SELECT 1 FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id
            WHERE ct.competition_id=? AND t.active=1 AND t.status='published' AND t.attempt_cap IS NOT NULL LIMIT 1`
        ).get(compId))) {
          mineFinished = participantsFinishedAll([req.session.userId], compId, totalTasks);
        }
        if (!mineFinished) {
          tAutoendEnd = process.hrtime.bigint();
          autoendPath = "fast_path_no";
          return { autoEndInfo: null, attempts: capAfter };
        }
      }
      if (totalTasks > 0) {
        // audit v7.7.27 (M2) — players inside the 48h verification grace
        // (verified=0, grace active) count as participants, so the comp can't auto-end "everyone
        // solved everything" while they're still mid-challenge. That rule, and
        // the staff/benchmark exclusion beside it, live in scoringParticipantIds
        // (v7.21.13) so this scan and both revive gates cannot disagree.
        const participants = scoringParticipantIds(compId, tsId || null);
        if (participants.length > 0) {
          // v8.3.11 — the DETAIL variant, so the emit can say why it fired.
          // Since v8.1.0 the predicate means "solved OR out of attempts", while
          // both emits below still recorded `all_participants_solved` and five
          // shipped sentences repeated it. Under an attempt cap that is a false
          // claim in the one record an admin opens to find out what happened.
          // `exhausted` is derived inside the predicate's own loop rather than by
          // a second query here — see lib/attempts.js for why.
          const _finished = participantsFinishedAllDetail(participants, compId, totalTasks);
          // ...and, where the event asks quick questions, everyone has answered
          // them all (`qualifyingAnsweredAll`): ending without them cut them off.
          const allSolved = _finished.finished && qualifyingAnsweredAll(db, participants, compId);
          const _exhaustedExtra = _finished.exhausted > 0
            ? { exhausted_participants: _finished.exhausted }
            : {};
          autoendPath = allSolved ? "scan_ended" : "scan_no_end";   // waiting for quick questions is a scan that did not end
          if (allSolved) {
            const endedAt = now().toISOString();
            if (tsId) {
              const ts = getTimeslot(tsId);
              const tsStartMs = ts ? new Date(ts.start_time).getTime() : 0;
              const tsActualDur = tsStartMs ? Math.max(1, Math.ceil((new Date(endedAt).getTime() - tsStartMs) / 60_000)) : null;
              const r = db.prepare("UPDATE competition_timeslots SET ended_at=?, updated_at=? WHERE id=? AND ended_at IS NULL").run(endedAt, endedAt, tsId);
              if (r.changes > 0) {
                queueEvent(recordTimeslotEvent, tsId, "auto_ended", "system", { reason: "all_participants_solved", duration_minutes: tsActualDur, ...reqCtx, ..._exhaustedExtra });
                _updateStatusObservation("timeslot", tsId, "ended");
                autoEndInfo = { timeslot_id: tsId };
              }
              const comp = getCompetition(compId);
              if (comp && competitionFullyEnded(comp)) {
                _invalidateCompetitionCache(compId);
                const r2 = db.prepare("UPDATE competitions SET ended_at=?, updated_at=? WHERE id=? AND ended_at IS NULL").run(endedAt, endedAt, compId);
                if (r2.changes > 0) {
                  queueEvent(recordCompetitionEvent, compId, "auto_ended", "system", { reason: "last_timeslot_ended", ...reqCtx });
                  // single-slot competitions are observed in the scheduler; multi-slot comps are not observed,
                  // but updating here is cheap and keeps the invariant that any emitted transition is recorded.
                  _updateStatusObservation("competition", compId, "ended");
                  autoEndInfo = { ...(autoEndInfo || {}), competition_id: compId };
                }
              } else if (comp && r.changes > 0) {
                // v6.20.x — this submit auto-ended ONE slot but the competition
                // is still live. Bump the parent competition's updated_at so a
                // concurrent admin holding a stale token is correctly 409'd: the
                // comp's effective end just shifted. Mirrors the per-slot manual
                // end-now path, which bumps the parent in its else branch. Gated
                // on r.changes>0 so we only bump when THIS call ended the slot.
                _invalidateCompetitionCache(compId);
                db.prepare("UPDATE competitions SET updated_at=? WHERE id=?").run(endedAt, compId);
              }
            } else {
              // v7.21.1 — same reason as the self-enroll check above: prefer the
              // row re-read inside this lock. The `|| req.competition` fallback
              // keeps this branch as crash-safe as it was for a competition
              // deleted mid-upload.
              const compStartMs = new Date((freshComp || req.competition).start_time).getTime();
              const compActualDur = Math.max(1, Math.ceil((new Date(endedAt).getTime() - compStartMs) / 60_000));
              _invalidateCompetitionCache(compId);
              const r = db.prepare("UPDATE competitions SET ended_at=?, updated_at=? WHERE id=? AND ended_at IS NULL").run(endedAt, endedAt, compId);
              if (r.changes > 0) {
                queueEvent(recordCompetitionEvent, compId, "auto_ended", "system", { reason: "all_participants_solved", duration_minutes: compActualDur, ...reqCtx, ..._exhaustedExtra });
                _updateStatusObservation("competition", compId, "ended");
                autoEndInfo = { competition_id: compId };
              }
            }
          }
        }
      }
      if (tAutoendStart && !tAutoendEnd) tAutoendEnd = process.hrtime.bigint();
    }
    // v8.1.0 — the POST-insert state, so the response tells the participant how
    // many attempts they have left INCLUDING the one they just spent. Returning
    // `capBefore` here would report the count from before the submission and the
    // number on screen would lag reality by exactly one attempt.
    return { autoEndInfo, attempts: capAfter };
  });
  const result = submitAndAutoEnd();
  // v6.13.14 — transaction boundary: everything after this is
  // outside the write lock.
  tTxnEnd = process.hrtime.bigint();
  // ext-audit v7.15.6 — the all-solved auto-end is a real end transition, so
  // freeze the team board(s) immediately rather than leaving them live until
  // somebody opens Rankings. Post-commit + best-effort: bookkeeping must never
  // fail a submission. No-op unless this submit actually ended the comp.
  if (result && result.autoEndInfo && result.autoEndInfo.competition_id) {
    freezeGroupLeaderboardSnapshots(result.autoEndInfo.competition_id);
    // v8.15.1 — an end is an end: queue the certificates and the congratulations email.
    enqueueCertificateDispatch(result.autoEndInfo.competition_id, { reason: "ended" });
  }
  // v6.8.2 — drain the queued audit events outside the transaction so the
  // per-submit write lock is released as soon as the submission row +
  // auto-end UPDATE commit. The audit rows still land in their respective
  // _events tables, just a tick later.
  if (pendingEvents.length) {
    _deferAudit(() => {
      for (const [fn, args] of pendingEvents) {
        try { fn(...args); } catch (e) { console.error("deferred submit event persist failed:", e.message); }
      }
    });
  }
  invalidateLeaderboardCache(compId);
  // An answer stored before any open (a client that never opened the challenge)
  // starts a first-open clock at that answer; a no-op once an open has stamped it.
  if (_answerStored) stampClockOnFirstTouch(req, task);
  // v8.1.7 — its OWN outcome tag, not folded into "rejected": the perf span
  // asserts by presence, so a terminal branch shipping under a neighbour's tag
  // would attribute a vanished-competition refusal to "the event has ended" in
  // the one record an operator reads afterwards.
  if (result?.compGone)     { outcome = "competition_gone"; return res.status(404).json({ error: "Event not found. It may have been deleted. Please select a new event." }); }
  // v8.11.1 (F3) — its OWN outcome tag, for the reason the branch above states:
  // the perf span asserts by PRESENCE, so a blocked-mid-upload refusal filed
  // under a neighbour's tag would read afterwards as "the event had ended".
  // The sentence is the guards' own, so a participant refused here and refused
  // on their next ordinary request is told the same thing twice.
  //
  // Under impersonation an ACCOUNT refusal is the seat stopping qualifying, and
  // gets requireParticipant's own forced exit (the admin restored, the window
  // closed `target_inactive`) — under its own tag, because it is a session
  // restore and not a refusal of the participant. A membership refusal is not
  // mapped: requireParticipantInCompetition answers impersonation with that
  // sentence too.
  if (result?.authzDenied && result.authzDenied.lifecycle && isImpersonating(req)) {
    outcome = "impersonation_target_inactive"; return sendParticipantSessionDenial(req, res, result.authzDenied);
  }
  if (result?.authzDenied)  { outcome = "authz_revoked";  return sendParticipantSessionDenial(req, res, result.authzDenied); }
  // v8.12.6 (review fix) — its OWN outcome tag too, for the same reason: the
  // impersonating admin lost access (or the session ended) mid-upload, which is
  // neither the participant being blocked nor the event having ended.
  if (result?.handDenied)   { outcome = "impersonation_ended"; return sendImpersonationCommitDenial(req, res, result.handDenied); }
  // Its OWN tag too: the session ended (a reset, a sign-in elsewhere, a logout)
  // while the answer was in flight — nothing graded, nothing stored.
  if (result?.sessionDenied) { outcome = "session_ended"; return sendParticipantSessionDenial(req, res, result.sessionDenied); }
  if (result?.rejected)     { outcome = "rejected";       return res.status(403).json({ error: `${activeName} has ended` }); }
  if (result?.alreadySolved) { outcome = "already_solved"; return res.status(400).json({ error: "Already solved" }); }
  if (result?.attemptsExhausted) {
    // v8.1.0 — 200, NOT 4xx, and the reason is the same one the emailed-code
    // endpoints answer 200 for (v7.29.0): the scanner-reputation counter counts
    // every non-429 4xx per IP and blocks the WHOLE address for 15 minutes at 100
    // in ten. A room of participants behind one NAT hitting a cap they were told
    // about is ordinary, expected traffic — a few hundred of them must not lock
    // the venue out of the API mid-event.
    //
    // `pointsDelta: 0` is load-bearing on the client: a 200 landing in the
    // existing `if (!d.correct)` branch renders "Incorrect. -5 pts penalty." and
    // announces a penalty that was never taken. The client branches on
    // `d.refused` FIRST — see PR 23.
    outcome = "attempts_exhausted";
    return res.json({ correct: false, refused: "attempts_exhausted", pointsDelta: 0,
      score: getParticipantScore(req.session.userId, compId, req.session.timeslotId),
      ...attemptsWire(result.attempts) });
  }
  if (result?.rateLimited) {
    // v6.13.18 — per-(user, task) submission cap exceeded. 429 with
    // Retry-After:60 lets the client back off cleanly; the response
    // does NOT count as a new submission so no -5 penalty applies.
    outcome = "rate_limited";
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "Too many submissions for this challenge. Please slow down and try again in a minute." });
  }
  if (result?.deduped) {
    // Same answer text submitted within 3s — return the prior outcome verbatim
    // so the client UI matches its first response. No new event is recorded.
    //
    // v8.13.1 (external audit) — AND THE ATTEMPT STANDING, reversing v8.1.0's
    // "deliberately carries NO attempt fields". That reasoning was that the
    // participant is already looking at the number; the repeat that reaches here
    // is most often a retry whose FIRST response never arrived, so the number
    // they are looking at is the one from before that answer was charged (the
    // first submission spent an attempt; this one spends nothing). The fields are
    // the same projection every other outcome carries: on an uncapped challenge
    // that is the `attempts` count alone (v8.13.2), the cap fields being absent.
    outcome = "deduped";
    // `qualifying`, as on a graded answer: a Quick question's unchanged pick
    // (ruling 395) is thanked, never congratulated.
    return res.json({ correct: !!result.correct, pointsDelta: 0, deduped: true, score: getParticipantScore(req.session.userId, compId, req.session.timeslotId),
      ...(_qualifyingTask ? { qualifying: true } : {}),
      ...attemptsWire(result.attempts) });
  }
  outcome = correct ? "new_correct" : "new_wrong";
  // v8.15.1 — a Program has no common end: the answer that finishes a learner
  // (correct, or spending their last attempt; Program grades, 27 Nov 2026) queues
  // their certificate and email when they passed. A no-op for any other kind
  // (kind first) and for an answer that leaves something unanswered.
  if (correct || (result && result.attempts && result.attempts.exhausted)) enqueueCompletionCertificate(compId, req.session.userId);
  _invalidateMeCache(req.session.userId);
  // `qualifying`: the client thanks them instead of announcing a solve and a score.
  res.json({ correct, pointsDelta: pts, score: getParticipantScore(req.session.userId, compId, req.session.timeslotId),
    ...(_qualifyingTask ? { qualifying: true } : {}),
    ...attemptsWire(result?.attempts) });
});

// Records a navigated_away challenge_event. Fired by the client when the
// participant leaves an opened challenge — intra-SPA navigation, tab close,
// or tab backgrounding. Future analytics use this to identify challenges
// participants bounce off of. Back-to-back POSTs within 2 seconds for the
// same (user, task, comp) are deduplicated because pagehide and
// visibilitychange=hidden often fire together.
// POST /api/tasks/:id/navigated-away + PUT /api/tasks/:id/feedback now live in
// routes/participant.js (registered above).

// ── Leaderboard ───────────────────────────────────────────────────────────────

// v6.14.1 / v6.14.2 — board is capped at the top 20 for the participant
// view. `me` is computed from the FULL ranked list (so the requester's
// true rank is reported even when they're outside the top 20), then
// the board is truncated. The client renders the requester's row in a
// "your placement" banner below the table when me.rank > 20. There is
// no pagination — the cap + me banner are the entire surface a
// participant sees.
//
// **No participant-count disclosure (v6.14.2).** The response
// deliberately does NOT expose the total number of ranked participants
// — neither as an explicit `total_ranked` field (removed in v6.14.2)
// nor through any other channel. This matches a competition-fairness
// requirement: participants must not be able to see how many people
// they're competing against. Implicit inferences via `board.length`
// (min of 20 and total) and `me.rank` (when the caller is outside
// the cap) are intrinsic to any visible leaderboard view; nothing
// further is volunteered.
//
// Admin leaderboard (/api/admin/leaderboard) is uncapped + carries
// the full list — admins are not subject to the same fairness rule.
// Leaderboard routes (GET /api/leaderboard + GET /api/admin/leaderboard) now
// live in routes/leaderboard.js (registered here).
require("./routes/leaderboard")(app);

// ── Admin ─────────────────────────────────────────────────────────────────────

// ── Competition CRUD ─────────────────────────────────────────────────────────

// Competition CRUD + lifecycle + tags + per-comp CxOne now live in
// routes/competitions.js. allParticipantsSolvedAll stays here (test-pinned) and
// is injected for the end-now / revive all-solved guard.
require("./routes/competitions")(app, { allParticipantsSolvedAll });

// ── Timeslot CRUD ───────────────────────────────────────────────────────────

// Session (timeslot) routes (list/create/edit/delete/end-now) now live in
// routes/sessions.js. allParticipantsSolvedAll stays here (test-pinned) and is
// injected for the timeslot-edit auto-end-revive branch.
require("./routes/sessions")(app, { allParticipantsSolvedAll });

// ── Task lifecycle endpoints ─────────────────────────────────────────────────

// Challenge (task) admin routes (publish, competition assignment, CRUD,
// visibility, versions/restore, lock, recalculate, attachments + staging,
// attachment downloads, feedback, task tags) now live in routes/challenges.js.
// TASK_FIELD_CAPS and the .zip multer instance are module-local there. participantContentNotStarted (shared with the participant
// task routes above) lives in lib/competitions.js.
require("./routes/challenges")(app);

// ── Competition tags ────────────────────────────────────────────────────────
// Same pattern as user_tags and task_tags. Pre-defined dry-run tag
// (always returned by the list endpoint even if no competitions use it yet).
// Editing tags on ended competitions is superadmin-only.

// COMPETITION_PERMANENT_TAGS now lives in routes/competitions.js (its only consumer).


// ── Competition user assignment ─────────────────────────────────────────────

// ── Participant-group live-sync engine (v6.20.0) ─────────────────────────────
// A group bound to a competition (competition_groups) keeps that competition's
// membership reconciled as the group changes. The functions below are the
// shared core both the manual assign/remove routes and the reconciler use, so
// synced changes carry the same absence-tracking, slot-restore, session
// eviction, CxOne provisioning, and emails as manual ones.

// The group→competition live-sync engine (addUserToCompetitionViaGroup,
// removeUserFromCompetition, reconcileCompetitionMembership + its detached
// overflow-drain, reconcileGroupBoundCompetitions, _clearTombstonesForGroupLeave,
// and the assignment/removal mail builders) now lives in lib/group-sync.js
// (imported at the top of this file) — top of the DAG, a strict consumer of leaf
// libs only. The RECONCILE_MAX_* caps + the dedup drain Set live inside the module.

// Participant admin routes (assign, remove, list/picker, tags, lifecycle,
// profile edit, delete) now live in routes/participants.js. Groups + invitations
// register here too (their calls previously sat in the participants span).
require("./routes/participants")(app);
require("./routes/groups")(app);
require("./routes/invitations")(app);
require("./routes/users")(app); // RBAC — Users & roles (admin accounts, custom roles)

// ── Misc superadmin routes (default CxOne, test-email, unsubscribed) ──────────

// Default-CxOne credential (get/set/clear), the operator SMTP test-email
// diagnostic, and the unsubscribed-list view + re-subscribe now live in
// routes/admin-misc.js, registered here in one call.
require("./routes/admin-misc")(app, { isHealthy: _instanceInService,
  // Settings → Backups & health reads the same facts the gate does, each apart.
  healthState: () => ({ integrity: _dbIntegrityOk, schema: _dbSchemaOk, maintenance: _maintenanceState().active }) });
// Settings → Email (SMTP): the mail relay in force, saved in the app or from the
// environment (routes/smtp-settings.js).
require("./routes/smtp-settings")(app);

// ── Admin participants ──────────────────────────────────────────────────────

// v6.10.47 — response cache for /api/admin/participants, keyed on
// (competitionId, page, limit). Each uncached call does 5 DB
// statements + serialises up to 200 users × ~25 columns each + their
// tags + competition lists to JSON. The admin dashboard can have
// several tabs open + a 15-30 s polling loop; a 5 s TTL cache
// collapses those sustained polls to one DB hit every 5 s per
// distinct key. Staleness is bounded by TTL; every admin-side write
// path below that affects participant state MUST call
// `invalidateAdminParticipantsCache()` after its DB commit so that
// the very-next GET reflects the change (the existing `mutations-
// admin.api.spec.js` suite verifies this invariant on every writer —
// a new writer that forgets the call will fail its own assertion
// immediately). The aggregate helper clears every key rather than
// trying to invalidate only the affected (comp, page, limit) tuple
// because most writes can touch multiple pages' users and the
// small-map clear is cheaper than tracking dirty keys.
// The admin-participants page cache (Map + keyer + TTL + get/set + invalidate)
// now lives in lib/participants-cache.js (imported at the top of this file) — a
// single process-global instance.


// inlineImageRefs + inlineAvatar (export-only) now live in routes/export-import.js.

// deleteAvatarImage now lives in lib/sanitise.js (imported at the top of this
// file) — shared by PUT /api/me (routes/participant.js) and the participant
// import path below.

// v6.8.5: export endpoints rate-limited (10/min per IP). These dump the
// full challenge / participant catalogue and are expensive to generate;
// unbounded hammering either wedges the DB or exfiltrates the corpus much
// faster than an operator can notice. The limiter is admin-scoped (all
// callers are already past requireAdmin) so false positives are rare.
// exportLimiter now lives in routes/export-import.js (its only consumer).
// v6.16.7 — importLimiter mirrors the export-side cap. Pre-fix the
// import endpoints were unrate-limited; a leaked CSRF token (or a
// rogue admin-tooling script) could drive arbitrary 128-MB JSON
// parses + base64-decode + zip-validate cycles, peg the event loop,
// and saturate `uploads/`. Imports are admin-only behind requireAdmin
// + requireSuperAdmin so the limit is generous (5/min/IP); a real
// migration is one large POST per data file, not a tight loop.
const importLimiter = rateLimit(60_000, 5, "import");
// v9.2.13 — how long the challenge import's rich-text pass works before it lets
// queued requests run (the pass ahead of the import transaction, below).
const IMPORT_RICH_TEXT_SLICE_MS = 20;
// What the last challenge import's rich-text pass did, as the server measured it,
// for GET /api/test/import-prepass (test processes only: elsewhere nothing is
// measured). In the main thread's CPU time, never wall time: a runner busy with
// other work pauses the process, which stretches a wall-clock span and not the
// work in it. `passCpuMs` is the pass, `txnCpuMs` the import transaction;
// `longestHoldCpuMs` the longest the event loop went without a turn while the
// pass ran, read by a probe that takes every turn it is given, so it measures
// the yields that happened, not the ones the code meant; `answeredDuringPass`
// the responses the server finished meanwhile (none, were the pass one unbroken
// stretch); `parkedWhenPassEnded` whether the commit-time park had been entered.
let _lastImportPass = null;
function _importPassWitness() {
  if (process.env.NODE_ENV !== "test") return null;
  // This thread's CPU; on a Node without threadCpuUsage, the process's (GC
  // helper threads included, so a little more, never less).
  const cpuMs = () => { const u = (process.threadCpuUsage || process.cpuUsage).call(process); return (u.user + u.system) / 1000; };
  const w = { rows: 0, passCpuMs: 0, longestHoldCpuMs: 0, answeredDuringPass: 0, parkedWhenPassEnded: null, txnCpuMs: null };
  _lastImportPass = w;
  const answered0 = _metrics.requests.total;
  const passAt = cpuMs();
  let turnAt = passAt, probing = true, txnAt = 0;
  const held = () => { const now = cpuMs(); w.longestHoldCpuMs = Math.max(w.longestHoldCpuMs, now - turnAt); turnAt = now; return now; };
  const turn = () => { if (!probing) return; held(); setImmediate(turn); };
  setImmediate(turn);
  return {
    passEnded(rows) {
      if (!probing) return;
      probing = false;
      w.passCpuMs = held() - passAt;
      w.rows = rows;
      w.answeredDuringPass = _metrics.requests.total - answered0;
      w.parkedWhenPassEnded = testAdminCommitDelay().parked;
    },
    txnStarting() { txnAt = cpuMs(); },
    txnEnded() { w.txnCpuMs = cpuMs() - txnAt; },
  };
}
// Export cap: total raw attachment bytes across the whole export. Base64
// inflates by ~33 %, so the on-wire JSON is bounded around 96 MB worst case.
// Matches the 128 MB import body limit so a round-trip never fails a
// previously-accepted export.
// EXPORT_MAX_ATTACHMENT_BYTES_TOTAL now lives in routes/export-import.js.

// Admin export routes (tasks/participants/competitions/settings) now live in
// routes/export-import.js. The 2 import routes stay inline below (test-pinned).
require("./routes/export-import")(app);

app.post("/api/admin/import/tasks", requireAdmin, requireSuperAdmin, importLimiter, csrfProtection, _importJsonParser, async (req, res) => {
  const { data, resolutions } = req.body;
  if (!data || data.type !== "hackarena-tasks" || !Array.isArray(data.tasks))
    return res.status(400).json({ error: "Invalid challenge export file" });
  if (data.tasks.length > 10000)
    return res.status(400).json({ error: `Too many challenges (${data.tasks.length}). Maximum is 10,000.` });
  {
    const _shape = _importRowShapeError(data.tasks, "Challenge", {
      title: "str", description: "str", explanation: "str", hint: "str",
      status: "str", author_name: "str", author_linkedin: "str",
      attachment_url: "str", active: "flag", correct_answer: "answer",
      // v8.10.0 — shape-checked so a malformed value 400s at the boundary rather
      // than reaching the `=== 1 || === true` test below, where an object or an
      // array would read as "not sealed" and quietly import a row the source
      // platform had sealed.
      answer_sealed: "flag",
      // Stage B — the topic by name (lib/topics.js).
      topic: "str",
    });
    if (_shape) return res.status(400).json({ error: _shape });
  }
  // v6.16.7 — free-disk floor. Pre-fix the direct attachment-upload
  // path checked _freeSpaceBytes (v6.13.18) but imports didn't. A
  // 128-MB import with attachments could fill the volume and starve
  // SQLite WAL. The cap is the same global ATTACHMENT_FREE_DISK_MIN_BYTES
  // because the import unzips into the same `attachments/` dir.
  const _disk = _freeSpaceBytes(DATA_DIR);
  if (_disk && _disk.free < ATTACHMENT_FREE_DISK_MIN_BYTES) {
    return res.status(507).json({ error: "Insufficient free disk space for an import. Free up storage and retry." });
  }

  // Cap the array to a safe upper bound and iterate with for-of (no numeric loop condition from body)
  const tasks = data.tasks.slice(0, 10000);

  // Detect conflicts
  //
  // v8.3.17 (external audit) — the statement is PREPARED ONCE, and `tasks.title`
  // is indexed (db.js). This was `db.prepare(...)` INSIDE the loop against an
  // unindexed column, i.e. one statement compilation plus one full table scan per
  // imported row — O(rows x tasks), synchronously, on a single-process server.
  // Measured by the audit at 263 ms for 10 000 rows before a single write.
  // The library is what a file overwrites: bank questions only, never an event's own
  // (same-titled) copy of one (lib/event-copies.js).
  const _conflictStmt = db.prepare("SELECT id, title, locked FROM tasks WHERE title=? AND owner_competition_id IS NULL");
  const conflicts = [];
  for (const [i, t] of tasks.entries()) {
    // v8.3.20 — TRIM, matching the create path's own `title.trim()` guard. A
    // whitespace-only title is truthy, so it slipped past all three of these
    // skip guards and was STORED — a row an admin can open and cannot save,
    // which is the v8.3.17 F4 defect class. It is well-typed, so it SKIPS
    // rather than refusing the file (the wrong-TYPE case is refused by
    // _importRowShapeError, above).
    if (typeof t.title !== "string" || !t.title.trim()) continue;
    const existing = _conflictStmt.get(t.title);
    if (existing) conflicts.push({ index: i, title: t.title, existingId: existing.id, locked: !!existing.locked });
  }
  // v8.3.20 (external audit) — INDEX THE CONFLICTS ONCE. Both passes below did
  // `conflicts.find(c => c.index === i)` inside a loop over the same 10 000
  // rows, so a fully-conflicting file cost N²/2 element visits per pass —
  // measured 115-166 ms of pure comparison at N=10 000, against 3.3 ms for this
  // Map, and the second pass holds the SQLite write lock while it does it.
  // `index` is unique per row, so the Map is exactly equivalent to `find`'s
  // first match.
  //
  // Stated honestly, because the auditor blamed this for the whole stall and
  // that does not survive measurement: it is ~3% of it. The statements are
  // compiled once (db.prepare is memoised); the rich-text sanitising runs in its
  // own pass before the transaction (below).
  const conflictByIndex = new Map(conflicts.map(c => [c.index, c]));

  // Dry run: return conflicts for resolution
  if (!resolutions) {
    return res.json({ dryRun: true, total: tasks.length, conflicts });
  }

  // Pre-validate attachment payloads OUTSIDE the DB txn. Decode base64,
  // cross-check size + sha256, validate the zip. Bail the whole import on
  // the first malformed attachment so we don't end up with half the tasks
  // imported and the rest refused. Tmp files are cleaned up on any failure
  // path or post-commit move.
  const preparedAttachments = new Map(); // taskIndex → [{displayName, originalName, sizeBytes, sha256, orderIdx, _tmpPath}]
  for (const [i, t] of tasks.entries()) {
    if (!Array.isArray(t.attachments) || t.attachments.length === 0) continue;
    if (t.attachments.length > ATTACHMENT_MAX_PER_TASK) {
      return res.status(400).json({ error: `Task "${t.title}": too many attachments (max ${ATTACHMENT_MAX_PER_TASK}).` });
    }
    const seen = new Set();
    const list = [];
    for (const a of t.attachments) {
      if (!a || typeof a.display_name !== "string" || !a.display_name.trim()) continue;
      if (typeof a.content_b64 !== "string" || !a.content_b64) continue; // metadata-only attachments silently skipped
      const displayName = a.display_name.trim().replace(/\.zip$/i, "").slice(0, 200) || "attachment";
      const key = displayName.toLowerCase();
      if (seen.has(key)) return res.status(409).json({ error: `Task "${t.title}": duplicate attachment display name "${displayName}".` });
      seen.add(key);
      let buf;
      try { buf = Buffer.from(a.content_b64, "base64"); }
      catch { return res.status(400).json({ error: `Task "${t.title}" attachment "${displayName}": invalid base64 content.` }); }
      if (buf.length === 0) return res.status(400).json({ error: `Task "${t.title}" attachment "${displayName}": empty content.` });
      if (buf.length > ATTACHMENT_MAX_BYTES) return res.status(400).json({ error: `Task "${t.title}" attachment "${displayName}": exceeds ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB.` });
      list.push({
        displayName,
        originalName: String(a.original_name || displayName + ".zip").slice(0, 200),
        sizeBytes: buf.length,
        sha256: typeof a.sha256 === "string" ? a.sha256 : null,
        orderIdx: Number.isInteger(a.order_idx) ? a.order_idx : list.length,
        _buffer: buf,
      });
    }
    if (list.length) preparedAttachments.set(i, list);
  }

  // Validate every buffered zip before any DB writes. Async (yauzl) — must
  // happen outside the synchronous db.transaction below.
  //
  // v8.3.17 (external audit) — EVERY tmp file written so far is removed when this
  // loop bails, not just the one that failed. Each early return used to unlink
  // only its own `tmpPath`, so an import whose 200th attachment was malformed
  // left the 199 already-validated ZIPs behind in UPLOADS_DIR — up to the 64 MB
  // per-attachment ceiling each, reclaimed only by the boot sweep. The file that
  // fails is the LAST one written, which is exactly why the single unlink looked
  // complete.
  const _validatedTmp = [];
  const _abortValidation = async (status, body) => {
    for (const p of _validatedTmp) { try { await fs.promises.unlink(p); } catch (_err) { swallowed("server:unlink-temp", _err); } }
    _validatedTmp.length = 0;
    return res.status(status).json(body);
  };
  for (const [i, list] of preparedAttachments) {
    for (const spec of list) {
      const tmpPath = path.join(UPLOADS_DIR, `import-${uuid()}.zip`);
      try {
        await fs.promises.writeFile(tmpPath, spec._buffer);
        // Tracked from the moment it exists on disk, so the failure paths below
        // reclaim THIS one too.
        _validatedTmp.push(tmpPath);
        try { await validateUnencryptedZip(tmpPath); }
        catch (e) {
          return await _abortValidation(400, { error: `Task "${tasks[i].title}" attachment "${spec.displayName}": ${_attachmentValidationMessage(e.code)}` });
        }
        const computed = crypto.createHash("sha256").update(spec._buffer).digest("hex");
        if (spec.sha256 && spec.sha256 !== computed) {
          return await _abortValidation(400, { error: `Task "${tasks[i].title}" attachment "${spec.displayName}": sha256 mismatch — export may be corrupted.` });
        }
        spec.sha256 = computed;
        spec._tmpPath = tmpPath;
        spec._buffer = null; // let GC reclaim; the tmp file is the source of truth from here
      } catch (e) {
        // The write itself may have failed, so tmpPath may not be tracked.
        try { await fs.promises.unlink(tmpPath); } catch (_err) { swallowed("server:unlink-temp", _err); }
        console.error("[attachments] import validation failed:", e && e.message);
        return await _abortValidation(500, { error: "Attachment validation failed." });
      }
    }
  }

  // v9.2.13 — THE RICH-TEXT SANITISING, BEFORE THE TRANSACTION AND IN SLICES.
  // Sanitising description, explanation and hint (sanitize-html parses and
  // filters each one) was the transaction's largest single cost: measured at
  // 2.5 s of a 6.5 s stall for 10 000 rows, all of it with the event loop held.
  // It reads nothing but the file, so it runs here, letting queued requests run
  // after every IMPORT_RICH_TEXT_SLICE_MS of work, and the transaction binds the
  // result. Storing a field's embedded images is a WRITE, so it stays in the
  // transaction, for the rows it writes, with the clamps that measure what is
  // stored after it: a rolled-back import or a skipped row stores no image, and
  // `fields_truncated` / `images_dropped` count only rows written. Ahead of the
  // commit-time re-check below, so no await separates that check from the writes.
  const _sanitisedRich = new Map();   // row index → its three sanitised fields
  const _passWitness = _importPassWitness();   // a test process's account of the pass; null elsewhere
  try {
    let _sliceAt = performance.now();
    for (const [i, t] of tasks.entries()) {
      if (_importRowUnusable(t)) continue;   // the transaction's first skip: nothing of the row is stored
      _sanitisedRich.set(i, {
        description: sanitiseRichText(t.description || ""),
        explanation: sanitiseRichText(t.explanation || ""),
        hint: sanitiseRichText(t.hint || ""),
      });
      if (performance.now() - _sliceAt >= IMPORT_RICH_TEXT_SLICE_MS) {
        await new Promise(r => setImmediate(r));
        _sliceAt = performance.now();
      }
    }
  } catch (e) {
    console.error("[import] rich-text sanitising failed:", e && e.message);
    return await _abortValidation(500, { error: "Import failed." });
  } finally {
    _passWitness?.passEnded(_sanitisedRich.size);
  }

  // v8.12.6 — test-only park before the commit-time re-check (lib/middleware.js).
  await testAdminCommitPark();
  // v8.12.6 (external audit F1) — THE ACTING SUPERADMIN, re-asked at commit. The
  // LAST awaits are the rich-text pass and the validation loop above (and before
  // them the 128 MB body parser, mounted after requireSuperAdmin, so the guard
  // answered before the body arrived). Everything below — the moves and the
  // import transaction — is synchronous, so this one check is atomic with the
  // commit. Only validated tmp files exist yet, and the abort path reclaims them.
  {
    const _authz = adminAuthzDenied(req, { tier: "superadmin" });
    if (_authz) { const { status, ...body } = _authz; return await _abortValidation(status, body); }
  }

  // Decide every task's resolution up-front so we know which attachments
  // will actually be promoted. Any spec that's in `preparedAttachments` but
  // belongs to a "keep" resolution needs its tmp file cleaned up afterwards.
  const resolutionByIndex = new Map();
  // Sweep #413 — how many of the file's rows would overwrite each title (an
  // overwrite that could mean more than one challenge is refused in the txn).
  const _overwritesByTitle = new Map();
  const _sameTitleStmt = db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(${qualifyingSql("t")}), 0) AS q FROM tasks t WHERE t.title=? AND t.owner_competition_id IS NULL`);
  const specsToPromote = []; // specs whose tmp file we'll move to ./data/attachments/
  for (const [i, t] of tasks.entries()) {
    if (typeof t.title !== "string" || !t.title.trim() || !t.difficulty || (answerTypeHasKey(t.answer_type) && !t.correct_answer)) continue;   // v8.3.20 — trim, as above; v8.9.0 — `any` has no key
    const conflict = conflictByIndex.get(i);
    const resolution = resolutions[String(i)] || (conflict ? "keep" : "import");
    resolutionByIndex.set(i, resolution);
    if (conflict && resolution === "overwrite" && !_importRowUnusable(t)) _overwritesByTitle.set(t.title, (_overwritesByTitle.get(t.title) || 0) + 1);
    if (conflict && resolution === "keep") continue;
    // v6.20.6 — locked overwrites are skipped inside the DB txn (line ~13090),
    // so promoting their attachment files would leak orphan zips into
    // ./data/attachments/ with no row in task_attachments referencing them.
    // Skip them here too — they share the same "keep" outcome from a
    // filesystem perspective. v8.14.4 — read FRESH, like the transaction's own
    // check: the dry-run snapshot predates the validation awaits, and nothing
    // awaits between here and the transaction. Read stale, a challenge UNLOCKED
    // in that window was overwritten with its live attachments detached and the
    // file's never linked.
    if (conflict && resolution === "overwrite") {
      const _lk = db.prepare("SELECT locked FROM tasks WHERE id=?").get(conflict.existingId);
      if (!_lk || _lk.locked) continue;
    }
    for (const spec of (preparedAttachments.get(i) || [])) {
      spec._finalId  = uuid();
      spec._finalRel = path.posix.join("attachments", `${spec._finalId}.zip`);
      specsToPromote.push(spec);
    }
  }

  // Move tmp → ./data/attachments/ BEFORE touching the DB. Rationale: the
  // reviewer flagged that returning {ok:true} while files failed to land is
  // silent data loss. By moving first, a late I/O error can be rolled back
  // cleanly (undo prior moves, never insert rows). A failure AFTER the DB
  // txn would be irrecoverable — rows would point at missing files. So the
  // sequence is: move all → db txn → on db failure, unlink the moved files
  // (they have no rows referencing them, so no data loss — the base64 is
  // still in the request body if the admin wants to retry).
  const movesApplied = []; // [{src, dst, spec}]
  const cleanupAllTmp = () => {
    for (const list of preparedAttachments.values()) {
      for (const s of list) {
        if (s._tmpPath && !movesApplied.some(m => m.src === s._tmpPath)) {
          try { if (fs.existsSync(s._tmpPath)) fs.unlinkSync(s._tmpPath); } catch (_err) { swallowed("server:unlink-temp", _err); }
        }
      }
    }
  };
  for (const spec of specsToPromote) {
    const srcAbs = spec._tmpPath;
    const dstAbs = path.join(DATA_DIR, spec._finalRel);
    try { fs.renameSync(srcAbs, dstAbs); }
    catch (renameErr) {
      let copyOk = false;
      if (renameErr.code === "EXDEV") {
        try { fs.copyFileSync(srcAbs, dstAbs); fs.unlinkSync(srcAbs); copyOk = true; }
        catch (copyErr) {
          try { fs.unlinkSync(dstAbs); } catch (_err) { swallowed("server:best-effort", _err); }
          console.error("[attachments] import cross-volume move failed:", copyErr && copyErr.message);
        }
      }
      if (!copyOk) {
        // Undo already-applied moves by renaming each dst back to its
        // original tmp path. Then clean every remaining tmp file.
        for (const mv of movesApplied) {
          try { fs.renameSync(mv.dst, mv.src); } catch (_err) { swallowed("server:best-effort", _err); }
        }
        cleanupAllTmp();
        console.error("[attachments] import rename failed:", renameErr && renameErr.message);
        return res.status(500).json({ error: "Failed to store attachment file." });
      }
    }
    movesApplied.push({ src: srcAbs, dst: dstAbs, spec });
  }
  // Tmp files from "keep" resolutions have no final destination; drop them
  // now so /uploads/ doesn't hold the leftovers for the hourly sweep.
  cleanupAllTmp();

  // Apply import inside a transaction. DB-only — all filesystem work is
  // already done above. On failure we compensate by deleting the moved
  // files; no rows exist to reference them so there's no dangling state.
  const adminId = getAdminIdentity(req);
  // concurrency-cache audit (#4): collect the ids of overwritten tasks so we can
  // bust the leaderboard cache for the comps they're assigned to — the overwrite
  // path mutates active/status/correct_answer/difficulty/answer_type, all of
  // which feed the board (active/status are filter predicates).
  const overwrittenTaskIds = new Set();
  // Overwritten challenges whose place in what finishes an event moved (active,
  // published, qualifying): after the commit, a Program learner the overwrite
  // completed is queued for their certificate, as the challenge doors queue them.
  const completionCountMoved = new Set();
  // Overwritten challenges that became, or stopped being, qualifying questions:
  // their numbers are cleared in the transaction and the events' number caches
  // dropped after the commit, as the tag doors do.
  const qualifyingFlipped = new Set();
  const _countsTowardFinish = (id) => {
    const r = db.prepare("SELECT t.active, t.status, EXISTS (SELECT 1 FROM task_tags q WHERE q.task_id=t.id AND q.tag LIKE 'qualifying:%') AS qual FROM tasks t WHERE t.id=?").get(id);
    return !!r && r.active === 1 && r.status === "published" && !r.qual;
  };
  // v8.3.34 (external audit) — WHICH promoted files actually received a row.
  //
  // The pre-flight loop above decides what to promote and skips THREE cases;
  // the transaction below skips SEVEN. The four it does not model — an invalid
  // difficulty/answer_type enum, an unanswerable choice row, a challenge frozen
  // by an ended session, and a challenge unfit for its Booth Event — were each
  // added by a LATER release (v6.20.x, v7.20.9, v7.21.1, v8.1.0 PR 30) and none
  // reached the pre-flight loop, whose own comment states the invariant they
  // broke. A row skipped by one of those four had its ZIP already renamed into
  // DATA_DIR/attachments/ and got no `task_attachments` row: an orphan file.
  //
  // The durable fix is NOT a fifth copy of the skip predicate — that is the
  // drift this class is made of. Reconcile against what the transaction ACTUALLY
  // did, so the next skip branch is handled without anyone remembering.
  //
  // Declared OUT here rather than returned from the txn: `res.json` spreads the
  // txn's return value wholesale, so returning it would put internal attachment
  // UUIDs on the wire (a Set also serialises as `{}`). A JS Set survives a
  // rollback, which is harmless — the catch branch unlinks every moved file
  // unconditionally.
  const insertedFinalIds = new Set();
  const importTxn = db.transaction(() => {
    let imported = 0, skipped = 0, overwritten = 0, attachmentsImported = 0, fieldsTruncated = 0;
    // v8.10.0 — sealed rows refused, counted separately from `skipped` so the
    // operator can tell "this file had rows I could not apply" from "this file
    // carried sealed answers, which do not migrate". Two different remedies.
    let sealedSkipped = 0;
    // Sweep #87 — overwrites that would give a sealed challenge an answer type a
    // seal cannot hold (an Any answer): counted apart, the remedy differs.
    let sealedTypeSkipped = 0;
    let competitorSkipped = 0; // v8.12.0 — overwrites refused by the competitor lock
    // Operator rulings N7 and 84 (14 Nov 2026) — overwrites refused by the
    // qualifying-question rules, each counted apart: the remedies differ.
    let qualifyingKeyHeldSkipped = 0, qualifyingOptionsFixedSkipped = 0, qualifyingNotPickOneSkipped = 0;
    // Sweep #413 — an overwrite that cannot say which qualifying copy it means,
    // and a row adding a malformed qualifying tag.
    let qualifyingCopySkipped = 0, qualifyingTagInvalidSkipped = 0;
    // v8.3.20 — embedded images STRIPPED for exceeding RICH_IMG_MAX_BYTES. Reported
    // beside fields_truncated, for the same reason: a silent drop is the v7.21.2 defect.
    let imagesDropped = 0;
    takeDroppedImageCount();   // clear any residue from an earlier request
    for (const [i, t] of tasks.entries()) {
      const _rowType = t.answer_type || "text";   // v8.9.0 — the INSERT below defaults it the same way
      if (_importRowUnusable(t)) { skipped++; continue; }   // the shared skip (above, with its reasons)
      const resolution = resolutionByIndex.get(i);
      const conflict = conflictByIndex.get(i);

      if (conflict && resolution === "keep") { skipped++; continue; }
      // Sweep #413 — EACH EVENT HAS ITS OWN COPY of a qualifying question, under
      // one title, and a file row names a challenge by its title alone (the export
      // carries no id: it would mean nothing on another server). An overwrite that
      // could mean more than one challenge (several share the title, or several
      // rows of the file overwrite it) where a qualifying question is involved is
      // skipped and counted, never applied to whichever copy the lookup finds
      // first. Asked before every other overwrite check, which would be asking
      // about that arbitrary copy; read fresh, as the lock below is.
      if (conflict && resolution === "overwrite") {
        const _st = _sameTitleStmt.get(t.title);
        const _fileQual = Array.isArray(t.tags) && tagsMakeQualifying(t.tags);
        if ((_st.n > 1 || (_overwritesByTitle.get(t.title) || 0) > 1) && (_st.q || _fileQual)) { qualifyingCopySkipped++; continue; }
      }
      // v8.14.4 (external audit R3) — THE LOCK IS READ HERE, NOT FROM `conflicts`.
      // That snapshot was taken before the attachment validation awaits (and the
      // 128 MB body parse before it), so a superadmin who locks the challenge in
      // that window was overruled: the answer, description and attachments were
      // rewritten anyway. Every other overwrite check below already reads the
      // row fresh; nothing awaits between this read and the UPDATE. A challenge
      // deleted meanwhile is skipped too: its tag, version and attachment rows
      // would fail their foreign keys and roll back the whole file.
      if (conflict && resolution === "overwrite") {
        const _live = db.prepare("SELECT locked FROM tasks WHERE id=?").get(conflict.existingId);
        if (!_live || _live.locked) { skipped++; continue; }
      }
      // ext-audit v7.21.1 — the ended-session freeze reaches the IMPORT too.
      //
      // An overwrite rewrites difficulty, answer_type, correct_answer, choices,
      // active AND status on an EXISTING task, i.e. every column the freeze
      // protects — with no guard at all. v7.20.9 fixed the PUT half of this and
      // its own release note recorded the import path as still unguarded; this
      // closes it. SKIPPED rather than 400 because that is this handler's
      // documented posture for a row it cannot apply (drafts, locked tasks, bad
      // enums all skip): one frozen challenge must not sink a 500-row migration.
      // The count already surfaces to the operator as `skipped`.
      if (conflict && resolution === "overwrite" && taskFrozenByEndedCompetition(conflict.existingId)) { skipped++; continue; }
      // v8.1.0 (PR 30) — the SIXTH enforcement site, and the only one that can
      // break BOTH halves of the rule in a single statement: the overwrite writes
      // `answer_type` and, when the file carries tags, DELETEs the whole tag set
      // and re-applies the file's. So one imported row can simultaneously turn a
      // challenge into a file answer and tag it `needs:desktop`, on a challenge a
      // live Booth Event is already serving.
      //
      // Checked against the ROW AS IT WILL BE STORED — the imported answer_type
      // and the imported tags — not against the current values, or it would
      // always pass. The `Array.isArray` mirrors the write below exactly: a file
      // omitting `tags` leaves the existing set alone, so that is what fit is
      // judged against.
      if (conflict && resolution === "overwrite") {
        const _nextTags = Array.isArray(t.tags)
          ? t.tags.filter(x => typeof x === "string").map(x => x.trim().toLowerCase())
          : db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(conflict.existingId).map(r => r.tag);
        if (taskConflictingEvent(db, conflict.existingId, { title: t.title, answer_type: t.answer_type || "text" }, _nextTags)) { skipped++; continue; }
      }
      // v8.10.0 — THE SEAL, on both halves of this loop, and the two halves need
      // opposite treatments.
      //
      // (a) OVERWRITING a sealed challenge the importer does not author would
      //     rewrite `correct_answer` — a value they were refused on every read
      //     path — from a file. SKIPPED rather than 400, this handler's documented
      //     posture for a row it cannot apply, so one sealed challenge cannot sink
      //     a 500-row migration; counted as `sealed_skipped` because a skip with
      //     no consumer is the v7.21.2 defect.
      // (b) A FILE ROW CARRYING `answer_sealed: 1` is skipped whatever the branch.
      //     The import deliberately writes no `created_by_id` (a user id means
      //     nothing on another server — the same reasoning that EXCLUDES it from
      //     the export), so importing such a row would produce a sealed challenge
      //     with NO author: unreadable and uneditable by every human alive. The
      //     alternative — importing it unsealed — would silently break the promise
      //     the source platform made. Neither is acceptable, so it is refused and
      //     reported, and the guides say to create a sealed challenge fresh on the
      //     target instead.
      if (conflict && resolution === "overwrite") {
        const _exSeal = db.prepare("SELECT answer_sealed, created_by_id FROM tasks WHERE id=?").get(conflict.existingId);
        if (_exSeal && !sealedAnswerReadable(_exSeal, actingAdminId(req), sealRevealedFor(req, conflict.existingId))) { sealedSkipped++; continue; } // v8.12.1 — the human, not the seat; v8.12.2 — a revealed superadmin overwrites as the author would
        // Sweep #87 — the overwrite's UPDATE never writes `answer_sealed`, so a
        // sealed challenge stays sealed: the file's answer type must be one a seal
        // can hold (lib/answer-seal.js `sealTypeDenied`, the task PUT's and
        // restore's rule). A sealed challenge made an Any answer would be a seal
        // over no key, and a qualifying one no report may read.
        if (answerSealed(_exSeal) && sealTypeDenied(_rowType, answerTypeHasKey(_rowType))) { sealedTypeSkipped++; continue; }
        // v8.12.0 — THE COMPETITOR LOCK'S IMPORT DOOR: an overwrite rewrites a
        // challenge the importer competes on (its answer among other things), so
        // a challenge held by an event they compete in is skipped and counted,
        // exactly as the seal above. A compete event holds sealed challenges
        // only, so for a non-author this is the seal's skip already; the
        // AUTHOR is who this catches — the seal admits them, the lock does not.
        if (_competitorEventsForTask(db, competitorIds(req), conflict.existingId).length) { competitorSkipped++; continue; }
        // Operator rulings 84 and N7 (14 Nov 2026) — THE OVERWRITE IS THE TASK
        // PUT'S AND THE TAG ROUTE'S OTHER DOOR, held to the rules they enforce
        // (lib/qualifying.js; restore asks the same two, in this order), and
        // skipped and counted like the rows above rather than refusing the file:
        //   84 — once anyone has answered a qualifying pick-one question, its
        //        options keep their places: a row that moves, removes or inserts
        //        one, or drops them all, is not applied (qualifying now, or made
        //        one by the file's own tags);
        //   N7 — a `qualifying:<key>` the file ADDS is refused where an event
        //        holding this challenge already asks that key through another
        //        challenge (a key it already carries changes nothing). Read inside
        //        this transaction, so an earlier row of the same file counts.
        const _qStored = db.prepare("SELECT id, answer_type, choices FROM tasks WHERE id=?").get(conflict.existingId);
        const _qFileTags = Array.isArray(t.tags) ? t.tags.filter(x => typeof x === "string").map(x => x.trim().toLowerCase()) : null;
        if (qualifyingOptionsFixed(db, _qStored, _qFileTags)
          && answeredOptionsChangeDenied(parseChoices(_qStored.choices), parseChoices(_importChoices(t)))) { qualifyingOptionsFixedSkipped++; continue; }
        if (_qFileTags) {
          const _qHas = new Set(qualifyingKeysFromTags(db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(conflict.existingId).map(r => r.tag)));
          const _qAdded = qualifyingKeysFromTags(_qFileTags).filter(k => !_qHas.has(k));
          if (_qAdded.length && db.prepare("SELECT c.id, c.name FROM competition_tasks ct JOIN competitions c ON c.id=ct.competition_id WHERE ct.task_id=?").all(conflict.existingId)
            .some(c => qualifyingKeyHeldDenied(db, c, conflict.existingId, _qAdded))) { qualifyingKeyHeldSkipped++; continue; }
        }
      }
      if (t.answer_sealed === 1 || t.answer_sealed === true) { sealedSkipped++; continue; }
      // A qualifying question is a pick-one question (lib/qualifying.js
      // `qualifyingNeedsPickOneDenied`, the tag route's and the PUT's rule): a
      // row that would store a qualifying challenge of another type, or without
      // its options, is skipped and counted. Its tags are the file's when it
      // carries them, else (an overwrite) the ones the challenge keeps.
      {
        // Sweep #413 — a `qualifying:` tag the tag route would refuse
        // (`qualifying_tag_invalid`) is not stored by a file either: the row is
        // skipped and counted. One the challenge already carries (an older import
        // stored it) changes nothing, so a round trip still applies.
        if (Array.isArray(t.tags)) {
          const _kept = (conflict && resolution === "overwrite") ? new Set(db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(conflict.existingId).map(r => r.tag)) : new Set();
          if (malformedQualifyingTags(t.tags).some(x => !_kept.has(x))) { qualifyingTagInvalidSkipped++; continue; }
        }
        const _rowTags = Array.isArray(t.tags) ? t.tags.filter(x => typeof x === "string")
          : (conflict && resolution === "overwrite" ? db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(conflict.existingId).map(r => r.tag) : []);
        if (tagsMakeQualifying(_rowTags) && qualifyingNeedsPickOneDenied({ answer_type: t.answer_type || "text", choices: _importChoices(t) })) { qualifyingNotPickOneSkipped++; continue; }
      }

      // v8.3.17 (external audit) — CLAMP TO THE SAME CAPS THE NORMAL PATH USES.
      // The import enforced none of them, so a title this platform caps at 300
      // was stored at 1 000 000 — a row an admin can open in the edit form and
      // cannot save. Clamping (not rejecting) is this handler's own idiom for a
      // well-typed-but-unusable value, and `fields_truncated` carries the count
      // to the operator, because a silent clamp would be the v7.21.2 defect.
      const _clamp = (field, v) => {
        const r = clampTaskField(field, v);
        if (r.truncated) fieldsTruncated++;
        return r.value;
      };
      // v9.2.13 — the fields were sanitised before the transaction (the pass
      // above it); storing their embedded images is a write, so it happens here,
      // for a row being written, and the clamps measure the text as stored.
      const _rich = _sanitisedRich.get(i);
      if (!_rich) throw new Error(`challenge import: row ${i + 1} reached the transaction unsanitised`);
      const desc = _clamp("description", extractAndStoreImages(_rich.description));
      const expl = _clamp("explanation", extractAndStoreImages(_rich.explanation));
      // v8.9.0 — an `any` row stores hint NULL (the routes never write one for it;
      // `_importAnyRowOk` has already refused a row with real hint content).
      // v8.12.0 — a row exported by a COMPETITOR carries `hint: null, hint_withheld: 1`
      // (the export withholds the hint from them); on an overwrite that must keep
      // the stored hint rather than wipe it with an empty one, the sealed-answer
      // rule one field over. On a create there is nothing to keep.
      const hint = _rowType === "any" ? null
        : (t.hint_withheld && conflict && resolution === "overwrite")
          ? (db.prepare("SELECT hint FROM tasks WHERE id=?").get(conflict.existingId)?.hint ?? null)
          : _clamp("hint", extractAndStoreImages(_rich.hint));
      // The row still imports — an oversized image is a property of one field,
      // not a reason to sink a 500-challenge migration — but the operator has to
      // be told the content is not all there.
      imagesDropped += takeDroppedImageCount();

      // v8.3.20 (external audit) — FINISH THE v8.3.17 F4 CLAMP.
      //
      // That pass routed 4 of the 6 capped string fields through `_clamp` and
      // left two: `correct_answer` (cap 65536) and `author_linkedin` (cap 500)
      // both carry a `TASK_FIELD_CAPS` entry and neither was clamped, so the
      // import could still store a value the edit form refuses to save — the
      // exact "a row an admin can open and cannot save" defect F4 was filed for.
      // `validateUrl` checks the protocol and returns the string verbatim with
      // no length limit, so it is not a substitute.
      const correctAnswer = _clamp("correct_answer", _importCorrectAnswer(t));

      let targetTaskId;
      // v6.13.20 — author attribution + URL normalisation for both branches.
      // Pre-fix, overwrite stored t.attachment_url verbatim while insert
      // ran it through validateUrl (server.js:9783); both branches now go
      // through validateUrl. Both branches also persist author_name and
      // author_linkedin so an export → import roundtrip preserves them.
      // author_linkedin is an optional URL field; same validateUrl gate.
      const normalisedAttachmentUrl = validateUrl(t.attachment_url) || "";
      // v8.3.20 — `author_name` was clamped with a bare `.slice()`, so its
      // truncation was NOT counted in `fields_truncated`: a silent clamp, which
      // lib/task-fields.js's own header calls the v7.21.2 defect. Through
      // `_clamp` it is reported like every other field.
      const authorName = _clamp("author_name", typeof t.author_name === "string" ? t.author_name : "") || null;
      const authorLinkedin = _clamp("author_linkedin", validateUrl(t.author_linkedin) || "") || null;
      // v8.1.0 — the attempt ceiling, sanitised the same way on BOTH branches.
      // A file can carry anything, so a value that is not a positive whole number
      // in range becomes NULL (uncapped) rather than being stored: the import
      // posture is "a bad row must not sink the batch", and an unusable cap is a
      // property of one field, not a reason to reject 500 challenges. Uncapped is
      // also the SAFE direction — it can be tightened afterwards, whereas a
      // nonsense cap silently locks participants out of a challenge.
      const importedCap = (Number.isInteger(t.attempt_cap) && t.attempt_cap >= ATTEMPT_CAP_MIN && t.attempt_cap <= ATTEMPT_CAP_MAX)
        ? t.attempt_cap : null;
      // v8.3.20 (external audit) — NORMALISE, do not merely accept.
      //
      // `t.status || "draft"` stored ANY string verbatim (measured:
      // `status:"banana"`), where the create path normalises to exactly
      // published-or-draft. `tasks.status` has no CHECK, so the two writers
      // disagreed about what the column may hold; copying the create path's own
      // expression makes them agree. Fail-closed either way (every reader
      // filters `status='published'`), and recoverable via Publish — but a
      // column whose value nothing produced is a wrong answer waiting for the
      // first reader that stops filtering.
      const importedStatus = (t.status === "published") ? "published" : "draft";
      // `t.active ?? 1` bound a raw value into an INTEGER column with no CHECK.
      // Measured: `active:"yes"` stored as TEXT, which SQL predicates
      // (`WHERE t.active=1`, the all-solved denominator) read as INACTIVE while
      // JS predicates (`if (!task.active)`) read as ACTIVE — a split-brain
      // invisible from every screen. The shape guard above refuses only an
      // object or an array (which cannot be bound at all); THIS is what makes a
      // merely wrong-domain value safe, coercing it to the integer the column is
      // declared as. The two split on purpose: refusing `active: 99` would brick
      // a migration off a database an older importer wrote, since the export
      // projects the column verbatim.
      const importedActive = (t.active === undefined || t.active === null) ? 1 : (t.active ? 1 : 0);
      if (conflict && resolution === "overwrite") {
        const _countedBefore = _countsTowardFinish(conflict.existingId);
        const _qualifyingBefore = isQualifyingTask(db, conflict.existingId);
        db.prepare(`UPDATE tasks SET description=?, difficulty=?, answer_type=?, correct_answer=?, choices=?, explanation=?, hint=?, attachment_url=?, author_name=?, author_linkedin=?, active=?, status=?, attempt_cap=?, updated_at=? WHERE id=?`)
          .run(desc, t.difficulty, t.answer_type || "text", correctAnswer, _importChoices(t), expl, hint, normalisedAttachmentUrl, authorName, authorLinkedin, importedActive, importedStatus, importedCap, new Date().toISOString(), conflict.existingId);
        if (Array.isArray(t.tags)) {
          db.prepare("DELETE FROM task_tags WHERE task_id=?").run(conflict.existingId);
          _applyImportedTaskTags(conflict.existingId, t.tags);
        }
        // Sweep #91 — an overwrite that makes the challenge a qualifying question,
        // or no longer one, is the tag doors' change: the answers already given
        // are re-priced in every event holding it, at the overwritten difficulty
        // (a frozen or locked challenge was skipped above), and its numbers are
        // cleared so it numbers in its new place.
        if (isQualifyingTask(db, conflict.existingId) !== _qualifyingBefore) {
          rescoreAfterQualifyingFlip(conflict.existingId, "import", adminId, reqContext(req));
          db.prepare("UPDATE competition_tasks SET task_number=NULL WHERE task_id=?").run(conflict.existingId);
          qualifyingFlipped.add(conflict.existingId);
        }
        // Overwrite also replaces attachments: soft-detach existing links so
        // restore can roll them back, then the prepared attachments become
        // the new linked set.
        if (preparedAttachments.has(i)) {
          db.prepare("UPDATE task_attachments SET detached_at=? WHERE task_id=? AND detached_at IS NULL")
            .run(new Date().toISOString(), conflict.existingId);
        }
        targetTaskId = conflict.existingId;
        overwrittenTaskIds.add(conflict.existingId);
        if (_countsTowardFinish(conflict.existingId) !== _countedBefore) completionCountMoved.add(conflict.existingId);
        if (t.topic !== undefined) _applyImportedTopic(conflict.existingId, t.topic);
        createTaskVersion(conflict.existingId, adminId, "import");
        overwritten++;
      } else {
        const title = _clamp("title", (conflict && resolution === "rename") ? `${t.title} (imported)` : t.title);
        const newId = uuid();
        // v6.20.6 — stamp updated_at at insert so the first PUT correctly
        // exercises optimistic concurrency. Pre-fix newly-imported tasks
        // had NULL updated_at, which the PUT handler treats as "no
        // existing token to compare" — two admins could overwrite each
        // other until the first normal save populated the field.
        // v8.7.0 — `created_by_id` is DELIBERATELY absent from this list, and from
        // the overwrite branch below. NULL means "no event admin owns this", which
        // is both accurate and fail-closed for a challenge that arrived from
        // another platform: the superadmin running the import is not its author,
        // and stamping them would be inert until the day that account is narrowed
        // to `event_admin` — at which point they would silently own the whole
        // imported bank. The column is EXCLUDED from the export for the matching
        // reason (a user id means nothing on another server), recorded in
        // tests/tasks-drift.spec.js.
        db.prepare("INSERT INTO tasks (id,title,description,difficulty,answer_type,correct_answer,choices,explanation,hint,attachment_url,author_name,author_linkedin,active,status,attempt_cap,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(newId, title, desc, t.difficulty, t.answer_type || "text", correctAnswer, _importChoices(t), expl, hint, normalisedAttachmentUrl, authorName, authorLinkedin, importedActive, importedStatus, importedCap, new Date().toISOString());
        if (Array.isArray(t.tags)) _applyImportedTaskTags(newId, t.tags);
        if (t.topic != null) _applyImportedTopic(newId, t.topic);
        targetTaskId = newId;
        createTaskVersion(newId, adminId, "import");
        imported++;
      }

      const nowIso = new Date().toISOString();
      const insertStmt = db.prepare(
        "INSERT INTO task_attachments (id, task_id, display_name, original_name, size_bytes, sha256, storage_path, created_at, created_by, order_idx) VALUES (?,?,?,?,?,?,?,?,?,?)"
      );
      for (const spec of (preparedAttachments.get(i) || [])) {
        if (!spec._finalRel) continue; // belonged to a skipped task
        insertStmt.run(spec._finalId, targetTaskId, spec.displayName, spec.originalName, spec.sizeBytes, spec.sha256, spec._finalRel, nowIso, adminId, spec.orderIdx);
        insertedFinalIds.add(spec._finalId);
        attachmentsImported++;
      }
    }
    return { imported, skipped, overwritten, attachments_imported: attachmentsImported, fields_truncated: fieldsTruncated, images_dropped: imagesDropped, sealed_skipped: sealedSkipped, sealed_type_skipped: sealedTypeSkipped, competitor_skipped: competitorSkipped,
      qualifying_key_held_skipped: qualifyingKeyHeldSkipped, qualifying_options_fixed_skipped: qualifyingOptionsFixedSkipped,
      qualifying_not_pick_one_skipped: qualifyingNotPickOneSkipped,
      qualifying_copy_skipped: qualifyingCopySkipped, qualifying_tag_invalid_skipped: qualifyingTagInvalidSkipped };
  });

  let importResult;
  // runTxnWithMirrorBuffer (ext-audit batch 4): importTxn emits per-task
  // createTaskVersion audit events INSIDE the txn (and can throw mid-loop — a
  // second task-version insert failing rolls the whole import back). Without the
  // buffer, a rollback leaves ghost `audit:` lines in app.jsonl for tasks the DB
  // never kept. (The batch-3 scanner only covered routes/, so server.js was
  // missed; the scanner now spans routes/ + server.js + lib/.)
  _passWitness?.txnStarting();
  try { importResult = runTxnWithMirrorBuffer(() => importTxn()); }
  catch (e) {
    for (const mv of movesApplied) {
      try { fs.unlinkSync(mv.dst); } catch (_err) { swallowed("server:unlink-temp", _err); }
    }
    console.error("[attachments] import txn failed:", e && e.message);
    return res.status(500).json({ error: "Import failed." });
  }
  _passWitness?.txnEnded();

  // v8.3.34 — reclaim every promoted file the transaction did NOT reference.
  // Joined on the uuid, never on a derived path: `_finalRel` is built with
  // path.posix.join while `dst` is path.join(DATA_DIR, …), and comparing paths
  // across separator conventions is how the v8.3.20 prefix-vacuity bug happened.
  // Best-effort per file — a failed unlink must never turn a COMMITTED import
  // into a 500, which would be strictly worse than the leak; the daily
  // `_sweepPermanentAttachments()` remains the backstop, and is why this defect
  // was bounded at ~24 h rather than the unbounded growth it was filed as.
  let orphansReclaimed = 0;
  for (const mv of movesApplied) {
    if (insertedFinalIds.has(mv.spec._finalId)) continue;
    try { fs.unlinkSync(mv.dst); orphansReclaimed++; } catch (_err) { swallowed("server:best-effort", _err); }
  }
  if (orphansReclaimed > 0) {
    console.log(`[attachments] import reconciliation: reclaimed ${orphansReclaimed} promoted file(s) whose row was skipped`);
  }

  // concurrency-cache audit (#4): the overwrite branch changed leaderboard-
  // relevant task columns (active/status/correct_answer/difficulty/answer_type).
  // Bust the board cache + the per-user /api/me score cache for every comp each
  // overwritten task is assigned to — matching the visibility/restore/recalc
  // writer-lock siblings. (No-op when nothing was overwritten.)
  if (overwrittenTaskIds.size) {
    const affectedCompIds = new Set();
    const compsForTask = db.prepare("SELECT DISTINCT competition_id FROM competition_tasks WHERE task_id=?");
    for (const tid of overwrittenTaskIds) for (const r of compsForTask.all(tid)) affectedCompIds.add(r.competition_id);
    for (const cid of affectedCompIds) invalidateLeaderboardCache(cid);
    if (affectedCompIds.size) _invalidateMeCacheForComps([...affectedCompIds]);
    for (const tid of qualifyingFlipped) for (const r of compsForTask.all(tid)) _invalidateTaskNumbersCache(r.competition_id);
    for (const tid of completionCountMoved) {
      try { enqueueCompletersOf(compsForTask.all(tid).map(r => r.competition_id), { taskId: tid }); }
      catch (e) { swallowed("server:import-completers", e); }
    }
  }

  // v6.16.29 — batch-summary audit event. Per-task createTaskVersion
  // calls already lock the per-row trail; this row reconstructs the
  // bulk operation as a single forensic record (admin / total / counts).
  try {
    recordOrphanedAuditEvent("import", "tasks", "batch_imported", adminId, {
      ...reqContext(req),
      total: data.tasks.length,
      imported: importResult.imported,
      overwritten: importResult.overwritten,
      skipped: importResult.skipped,
      attachments_imported: importResult.attachments_imported || 0,
      ...(orphansReclaimed > 0 ? { attachment_files_reclaimed: orphansReclaimed } : {}),
    });
  } catch (_err) { swallowed("server:best-effort", _err); }
  res.json({ ok: true, ...importResult });
});

app.post("/api/admin/import/participants", requireAdmin, requireSuperAdmin, importLimiter, csrfProtection, _importJsonParser, async (req, res) => {
  const { data, resolutions } = req.body;
  if (!data || data.type !== "hackarena-participants" || !Array.isArray(data.participants))
    return res.status(400).json({ error: "Invalid participant export file" });
  // v6.15.0 — accept envelope versions 1 and 2. v1 exports omit the
  // audit / role / denial / competitions fields; the import code
  // below uses safe per-field defaults so legacy exports continue to
  // import without errors. Anything unknown (>2) is rejected to make
  // a future schema break loud rather than silent.
  if (data.version != null && data.version !== 1 && data.version !== 2) {
    return res.status(400).json({ error: `Unsupported export version ${data.version}. Re-export with the same or newer server.` });
  }
  if (data.participants.length > 5000)
    return res.status(400).json({ error: `Too many participants (${data.participants.length}). Maximum is 5,000 per import.` });

  // Cap the array to a safe upper bound and iterate with for-of (no numeric loop condition from body)
  const participants = data.participants.slice(0, 5000);
  {
    // v8.3.39 (external audit) — THE MAP HAS TO COVER EVERY FIELD THAT REACHES A
    // BIND, not just the profile ones. Fourteen lifecycle / audit fields were
    // written straight into the INSERT as `p.X || <default>` with no shape check
    // at all: better-sqlite3 SPREADS an array as positional bindings and refuses a
    // boolean outright, so a single `{"login_time": ["a","b"]}` or
    // `{"role": true}` threw out of the write transaction and 500'd the import
    // with the opaque message this whole mechanism exists to replace. Worse under
    // the v6.16.4 chunking: the throw aborts chunk K while chunks 0..K-1 stay
    // COMMITTED, and a raw 500 carries none of the `partial:` accounting the
    // handler works to keep truthful. Same class as the absence-row binds
    // v8.3.34 (F6) guarded — this is the rest of it.
    //
    // `avatar` is deliberately absent: it is the one field that already reaches
    // its bind through a type-guarding sink (`sanitiseAvatar` returns undefined
    // for a non-string since v8.3.35), so listing it would newly 400 a file that
    // imports safely today.
    const _shape = _importRowShapeError(participants, "Participant", {
      email: "str", secondary_email: "str", nickname: "str",
      first_name: "str", last_name: "str", company: "str", title: "str",
      personal_title: "str", phone: "str", country: "str", timezone: "str",
      job_function: "str", city: "str", linkedin_url: "str",
      certificate_given_name: "str", certificate_family_name: "str",
      registered_via: "str", verified: "flag", blocked: "flag",
      // v8.3.39 — every remaining directly-bound field.
      role: "str", approved_at: "str", approved_by: "str",
      denied_at: "str", denied_by: "str", denied_reason: "str",
      locked_until: "str", login_time: "str", last_login_time: "str",
      invitation_id: "str", invited_at: "str", invited_by: "str",
      created_at: "str", first_verified_at: "str",
    });
    if (_shape) return res.status(400).json({ error: _shape });
  }

  // ext-audit v7.21.1 (A7) — the import bound `p.country || ""` / `p.timezone || ""`
  // RAW, so a padded or outright invalid value landed in the users row. An invalid
  // timezone is the harmful one: it is later handed to Intl by formatEmailDate, so
  // the RangeError surfaces in a background email send, far from this import.
  //
  // A bad row must not sink the batch (the v7.11.3 posture), so an unusable zone is
  // DROPPED to empty rather than rejected — that routes the participant into the
  // profile-completion gate, which is the designed mechanism for "a required field
  // is not usable" and lets them fix it themselves at first login. Counted and
  // reported, never silent.
  let _invalidTimezonesDropped = 0;
  // v8.3.39 (external audit) — `users.role` has no CHECK constraint and the
  // import bound it verbatim, so a file could persist `role: "wizard"`. Nothing
  // downstream rejects it: `requireAdmin` tests for the two privileged spellings,
  // so an unrecognised role behaves as a participant almost everywhere and shows
  // up as itself on the admin screen — a row nobody can explain, from a control
  // nobody used.
  //
  // DROPPED rather than refused or rewritten, and the choice matters at both
  // binds. Deleting the key makes `_has(p, "role")` false, so the INSERT falls
  // through to its `participant` default and the OVERWRITE leaves the column
  // ALONE — the `profile_policy` rule (an absent key preserves what is there),
  // which is what stops a malformed file silently demoting an existing admin.
  // Refusing the whole file would be the harsher answer for a value the
  // platform's own export could have produced while this defect was live.
  let _invalidRolesDropped = 0;
  for (const p of participants) {
    if (typeof p.country === "string") p.country = p.country.trim();
    if (typeof p.timezone === "string") p.timezone = p.timezone.trim();
    if (p.timezone && !isValidTimezone(p.timezone)) { p.timezone = ""; _invalidTimezonesDropped++; }
    // The shape check above has already guaranteed string-or-absent.
    // A role is recognised when it names a role in THIS installation: a built-in
    // one or a custom role from Users & roles (its export emits the role id).
    if (p.role !== undefined && p.role !== null && !require("./lib/rbac").roleDefinition(p.role, { live: true })) { delete p.role; _invalidRolesDropped++; }
  }

  // Reject the whole batch upfront if any row has a malformed primary or
  // secondary email — it's cheaper for the admin to fix the file once
  // than to import bad rows that later silently break verification /
  // approval / reset / reminder mailouts. Rows with no email at all are
  // already silently skipped further down (treated as "missing required
  // field"), so we only validate non-empty values.
  for (const [i, p] of participants.entries()) {
    if (p.email && !isValidEmailFormat(p.email))
      return res.status(400).json({ error: `Row ${i+1}: primary email "${p.email}" is not a valid email address.` });
    if (p.secondary_email && !isValidEmailFormat(p.secondary_email))
      return res.status(400).json({ error: `Row ${i+1}: secondary email "${p.secondary_email}" is not a valid email address.` });
  }

  // v6.20.x — canonicalise emails ONCE, up-front, so every downstream step
  // (DB conflict lookup, store, within-batch dedup) operates on normalised
  // values. Normal writes run normaliseEmail() (trim + NFC + lowercase) before
  // store and emailIsTaken() assumes stored emails are already canonical; the
  // import previously stored raw values and conflict-checked with LOWER(), so
  // Unicode NFC/NFD variants (composed `é` vs decomposed `e`+U+0301) could
  // bypass the case-insensitive/normalised identity model. Mutating p here keeps
  // the import consistent with the rest of the codebase with a single pass.
  for (const p of participants) {
    if (p.email) p.email = normaliseEmail(p.email);
    if (p.secondary_email) p.secondary_email = normaliseEmail(p.secondary_email);
  }

  // v6.16.22 — within-batch duplicate scan. Pre-fix two rows with the same
  // email (or with a primary in row A matching a secondary in row B) would
  // both pass the per-row uniqueness check (which only consulted the live
  // DB) and the second INSERT would either clobber audit-row order or
  // skip silently depending on the resolution path. Surface duplicates as
  // a 400 with row numbers so the operator can fix the file before
  // re-running. Normalised email comparison so encoding variants
  // (composed `é` vs decomposed `e + U+0301`) collapse correctly.
  const seenInBatch = new Map(); // normalised email → first-row index
  // audit v7.7.37 (C2) — also scan nicknames within the batch. Pre-fix only emails
  // were deduped, so two rows sharing a nickname (or a NOCASE case variant) with
  // distinct emails both passed the DB conflict scan (which runs before any batch
  // row is inserted), and the SECOND row's INSERT tripped uq_users_nickname_nocase —
  // a raw SqliteError (not the {userError} shape) that the chunk-catch re-threw as a
  // generic 500 AFTER earlier chunks had already committed. Surface it as the same
  // 400-with-row-numbers as the email scan so the operator can fix the file first.
  const seenNicks = new Map(); // LOWER(nickname) → first-row index
  for (const [i, p] of participants.entries()) {
    if (p.email) {
      const norm = normaliseEmail(p.email);
      if (seenInBatch.has(norm)) {
        return res.status(400).json({ error: `Duplicate primary email "${p.email}" in row ${i+1}; first seen in row ${seenInBatch.get(norm)+1}. Deduplicate the import file before re-running.` });
      }
      seenInBatch.set(norm, i);
    }
    if (p.secondary_email) {
      const norm = normaliseEmail(p.secondary_email);
      if (seenInBatch.has(norm)) {
        return res.status(400).json({ error: `Secondary email "${p.secondary_email}" in row ${i+1} collides with email in row ${seenInBatch.get(norm)+1}. Deduplicate the import file before re-running.` });
      }
      seenInBatch.set(norm, i);
    }
    if (p.nickname && typeof p.nickname === "string" && p.nickname.trim()) {
      const nlow = p.nickname.trim().toLowerCase();
      if (seenNicks.has(nlow)) {
        return res.status(400).json({ error: `Duplicate nickname "${p.nickname}" in row ${i+1}; first seen in row ${seenNicks.get(nlow)+1}. Deduplicate the import file before re-running.` });
      }
      seenNicks.set(nlow, i);
    }
  }

  // Detect conflicts. Email matching is now symmetric across primary AND
  // secondary columns to match the rest of the identity model (registration,
  // admin edit). An import row whose primary OR secondary
  // email collides with any existing user's primary OR secondary is a
  // conflict, not a silent duplicate-identity insert.
  const conflicts = [];
  // v9.2.13 — TWO INDEX SEARCHES PER ADDRESS (lib/account-lookup.js: primary,
  // then secondary, each answered by its own UNIQUE NOCASE index), never
  // `LOWER(email)=LOWER(?) OR LOWER(secondary_email)=LOWER(?)`, which no index
  // serves: it read every account for every row, so a 5 000-row file against
  // 10 000 accounts held the event loop 7.4 s, its dry run included (measured;
  // the chunk loop after it took about a second). The same answer: addresses
  // are ASCII by rule and no two accounts hold one address.
  const { findUserByAddress } = require("./lib/account-lookup");
  const findByAnyEmail = (addr) => findUserByAddress(db, addr, "id");
  for (const [i, p] of participants.entries()) {
    if (!p.nickname || !p.email) continue;
    const byNick = db.prepare("SELECT id FROM users WHERE nickname=? COLLATE NOCASE").get(p.nickname);
    const byEmail = findByAnyEmail(p.email);
    const bySecondary = p.secondary_email ? findByAnyEmail(p.secondary_email) : null;
    // If any two of {nickname, primary-email, secondary-email} each hit a
    // *different* existing user we cannot safely overwrite — flag the row so the
    // UI forces a rename/keep decision. audit v7.7.29 (M4) — pre-fix only the
    // primary-vs-secondary axis was guarded; a row whose nickname matched user A
    // but whose email matched user B was typed "both" with existingId=A.id, and
    // overwrite then applied the row (profile, verified/blocked, tags,
    // memberships) to A while silently ignoring the email that identifies B (the
    // email column is never rewritten on overwrite) — wrong-account corruption.
    // Treat all three identity axes uniformly.
    const hit = byEmail || bySecondary;
    const _idset = new Set([byNick?.id, byEmail?.id, bySecondary?.id].filter(Boolean));
    const splitIdentity = _idset.size > 1;
    if (byNick || hit) {
      let conflictType;
      if (splitIdentity) conflictType = "split_identity";
      else if (byNick && hit) conflictType = "both";
      else if (byNick) conflictType = "nickname";
      else if (byEmail && bySecondary) conflictType = "email";
      else if (byEmail) conflictType = "email";
      else conflictType = "secondary_email";
      conflicts.push({
        index: i,
        nickname: p.nickname,
        email: p.email,
        secondary_email: p.secondary_email || null,
        conflictType,
        existingId: splitIdentity ? null : (byNick?.id || hit?.id),
      });
    }
  }

  // Dry run
  if (!resolutions) {
    return res.json({ dryRun: true, total: participants.length, conflicts });
  }

  // The index `_processOneImportRow` below reads per row, inside the chunked
  // write transactions, instead of a linear scan of `conflicts`.
  const conflictByIndex = new Map(conflicts.map(c => [c.index, c]));
  // Test-only park before the commit-time re-check (lib/middleware.js).
  await testAdminCommitPark();

  // v8.12.6 (external audit F1) — THE ACTING SUPERADMIN, re-asked at commit. The
  // window is the 128 MB body parser, mounted after requireSuperAdmin, so the
  // guard answered before the body arrived. MEASURED before this existed: a
  // superadmin blocked inside such a window still imported, and a row asking for
  // role "superadmin" minted a new verified SUPERADMIN account — privilege that
  // outlived the revocation. Nothing below awaits until every chunk has
  // committed, so this one synchronous check covers all of them; nothing has
  // been written yet, so a refusal leaves nothing behind.
  {
    const _authz = adminAuthzDenied(req, { tier: "superadmin" });
    if (_authz) { const { status, ...body } = _authz; return res.status(status).json(body); }
  }

  // Apply import — in 100-row chunk transactions (v6.16.4, below), so a failure
  // is atomic per CHUNK, not per file: earlier chunks stay committed and the
  // response reports how far it got (`partial`).
  const importAdminId = getAdminIdentity(req);
  // v6.15.0 — list of v2 audit / lifecycle fields the import will
  // persist when present in the payload. Kept as a single source of
  // truth so the overwrite UPDATE (dynamic) and the insert INSERT
  // (fixed) stay aligned. The order here MUST match the INSERT
  // VALUES list below — see the comment there.
  const _V2_AUDIT_FIELDS = [
    "approved_at", "approved_by",
    "denied_at", "denied_by", "denied_reason",
    "role",
    "locked_until",
    "login_time", "last_login_time",
    "invitation_id", "invited_at", "invited_by",
    "created_at",
    // v8.1.1 — profile_policy belongs to THIS list rather than the base
    // overwrite UPDATE, and the distinction is the whole point. That UPDATE
    // writes every column unconditionally (`p.country || ""`), so an older file
    // with no `profile_policy` key would WIPE a Booth Event walk-up's stored
    // deal and strand them behind the non-dismissible completion gate — the
    // exact lockout this column exists to prevent. This mechanism writes only
    // when the payload carries the key, so an older file preserves what is
    // there. (Not audit data, despite the name — the list's real semantic is
    // "v2 fields written only when supplied".)
    "profile_policy",
  ];
  const _has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
  const importNowForBatch = now().toISOString();
  // v6.15.0 — rehydrate competition memberships from a v2 export.
  // Comp lookups by NAME (export is portable across server identities,
  // UUIDs are local). Timeslot lookups by NAME within the comp; if the
  // exported timeslot_name doesn't match (e.g. renamed on the target),
  // timeslot_id stays NULL and the user gets the slot picker on first
  // login. INSERT OR IGNORE so re-running the same import is a no-op.
  // Returns the count of rows actually inserted.
  // v6.20.0 — group memberships from the export, resolved/created by name
  // (nocase). Additive on import; returns the count of new memberships added.
  // v6.20.x — group ids that gained at least one membership during this import.
  // After the import commits we reconcile each so imported members enroll into
  // the group's bound live/upcoming competitions (groups are live-synced — every
  // other membership entry point already reconciles; import was the gap).
  const _touchedGroupIds = new Set();
  // v7.11.3 — count of group associations DROPPED on import to keep the "one group per
  // competition" invariant (a user who'd otherwise land in ≥2 groups bound to one comp).
  let _droppedGroupClashes = 0;
  // v8.12.0 — group associations DROPPED because the group is bound to an event
  // the acting superadmin competes in: adding an account to it live-syncs a row
  // into that event, the transitive door every group route refuses for a
  // competitor. The direct `competitions` entry for the same event is skipped
  // as `actor_competes`; without this the same import reached the same board
  // through its `groups` field.
  let _droppedGroupCompete = 0;
  // concurrency-cache audit (#2): the import creates/overwrites users (verified/
  // approved/blocked/role + tags) and rehydrates competition_users rows that may
  // carry a non-null login_time. None of that busted the documented caches. Track
  // the comps whose membership changed + the user ids touched so we can flush the
  // leaderboard / /api/me / admin-participants caches after the chunks commit.
  const _touchedCompIds = new Set();
  const _importedUserIds = new Set();
  function _rehydrateGroups(userId, p, adminId, nowIso) {
    if (!Array.isArray(p.groups) || p.groups.length === 0) return 0;
    let added = 0;
    const insGM = db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, added_at, added_by) VALUES (?,?,?,?)");
    for (const rawName of p.groups) {
      if (typeof rawName !== "string" || !rawName.trim() || rawName.trim().length > GROUP_NAME_MAX) continue;
      const trimmed = rawName.trim();
      let g = findGroupByName(trimmed);
      if (!g) {
        const gid = uuid();
        try {
          db.prepare("INSERT INTO groups (id, name, name_key, created_at, created_by) VALUES (?,?,?,?,?)").run(gid, trimmed, _groupNameKey(trimmed), nowIso, adminId);
          recordOrphanedAuditEvent("group", gid, "group_created", adminId, { name: trimmed, members: 0, via: "import", ...reqContext(req) });
          g = { id: gid };
        } catch (_) { g = findGroupByName(trimmed); }
      }
      // v7.11.3 — keep the "one group per competition" invariant on import: DROP a group
      // association that would put this user in ≥2 groups bound to the SAME competition.
      // detectMemberAddClashes reads current state (incl. groups added earlier in this
      // import), so the greedy drop is order-consistent. A brand-new group (bound nowhere)
      // never triggers it; unlikely in practice, but handled rather than corrupting the board.
      if (g && detectMemberAddClashes(g.id, [userId]).length) { _droppedGroupClashes++; continue; }
      if (g && _competitorGroupDenied(db, competitorIds(req), g.id)) { _droppedGroupCompete++; continue; }
      if (g && insGM.run(g.id, userId, nowIso, adminId).changes > 0) {
        added++; _touchedGroupIds.add(g.id);
        // audit-event-logging audit (v7.7.15) — per-membership group-add event so
        // an import-driven group membership shows in the user history, matching the
        // invitation/LinkedIn rehydrate (group_added) + the per-participant route.
        try { recordUserEvent(userId, "group_added", adminId, { ...reqContext(req), group_id: g.id, group_name: trimmed, via: "import" }); } catch (_err) { swallowed("server:best-effort", _err); }
      }
    }
    return added;
  }

  function _rehydrateMemberships(userId, p, adminId, nowIso, skippedAccum) {
    if (!Array.isArray(p.competitions) || p.competitions.length === 0) return 0;
    let inserted = 0;
    const insertCU = db.prepare(
      "INSERT OR IGNORE INTO competition_users (competition_id, user_id, timeslot_id, assigned_by, assigned_at, login_time) VALUES (?,?,?,?,?,?)"
    );
    // v8.3.39 (external audit) — v8.3.34 (F6) guarded every value bound out of
    // `absences[]` and left this, its twin, untouched; v8.3.35 then fixed the
    // `timeslot_name` lookup THERE and recorded the same shape here as
    // pre-existing rather than closing it. `assigned_at` / `login_time` /
    // `timeslot_name` all come straight out of the uploaded file and all three
    // reach a bind, where better-sqlite3 spreads an array and refuses a boolean —
    // 500ing a 5,000-row migration on one malformed nested object. A wrong-typed
    // timestamp degrades to NULL (the absence loop's posture: a well-typed row's
    // unusable FIELD is not a batch abort); a wrong-typed slot NAME skips the row,
    // because binding it is the lookup itself and there is nothing to degrade to.
    const _ts = (v) => (typeof v === "string" && v ? v : null);
    // v8.12.0 — THE STAFF ROW-WRITER RULE, read straight off `user_tags` rather
    // than through `isStaff`: the tags were rewritten a few statements up in this
    // same pass and the 2 s tag cache is busted only at the END of the import,
    // so the cached answer here can be the pre-import one.
    const _staffNow = !!db.prepare("SELECT 1 FROM user_tags WHERE user_id=? AND tag='staff'").get(userId);
    const _scOn = _staffCompeteOn, _authored = _authoredAssignedTasks;
    // v8.12.0 — THE COMPETITOR LOCK'S IMPORT DOOR: the acting superadmin may not
    // enrol anybody into an event they compete in through a migration file any
    // more than through the assign route. Skipped and reported, in this
    // handler's own posture (one row must not sink the file).
    const _actorUid = actorId(req);
    for (const m of p.competitions) {
      if (!m || typeof m.competition_name !== "string") continue;
      if (m.timeslot_name !== undefined && m.timeslot_name !== null && typeof m.timeslot_name !== "string") continue;
      const comp = db.prepare(
        "SELECT id, name, staff_compete FROM competitions WHERE name=? ORDER BY created_at LIMIT 1"
      ).get(m.competition_name);
      if (!comp) {
        skippedAccum.push({ email: p.email, competition_name: m.competition_name, reason: "competition_not_found" });
        continue;
      }
      // A staff row lands only on an event where staff compete, and never on one
      // holding a challenge this user authored — both reported in the skip
      // ledger, since a migration that silently dropped an enrolment is the
      // failure this whole handler works to avoid.
      // A row the account ALREADY holds is a membership and takes the idempotent
      // path (INSERT OR IGNORE, a no-op), not a skip entry about a member — the
      // assign and invitation doors' rule.
      const _heldRow = !!db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, userId);
      if (_staffNow && !_scOn(comp) && !_heldRow) {
        skippedAccum.push({ email: p.email, competition_name: m.competition_name, reason: "staff_not_competing" });
        continue;
      }
      if (_scOn(comp) && _authored(db, userId, comp.id).length) {
        skippedAccum.push({ email: p.email, competition_name: m.competition_name, reason: "author_competes" });
        continue;
      }
      if (_actorUid && userId !== _actorUid && _competitorIn(db, _actorUid, comp.id)) {
        skippedAccum.push({ email: p.email, competition_name: m.competition_name, reason: "actor_competes" });
        continue;
      }
      let tsId = null;
      if (m.timeslot_name) {
        const ts = db.prepare(
          "SELECT id FROM competition_timeslots WHERE competition_id=? AND name=? LIMIT 1"
        ).get(comp.id, m.timeslot_name);
        if (ts) tsId = ts.id;
        // else: silently leave NULL — slot picker will surface on next login
      }
      // The acting superadmin's OWN row into a compete event is written (they may
      // enrol themselves, as at every door) but never with a file-supplied
      // `login_time`: that column is the solve-clock anchor the tie-break is
      // measured from, and a chosen anchor is a chosen placing. NULL lets the
      // ordinary lazy stamp anchor it honestly.
      const _ownCompete = !!_actorUid && userId === _actorUid && _scOn(comp);
      const r = insertCU.run(comp.id, userId, tsId, adminId, _ts(m.assigned_at) || nowIso, _ownCompete ? null : _ts(m.login_time));
      if (r.changes > 0) {
        inserted++; _touchedCompIds.add(comp.id);
        // audit-event-logging audit (v7.7.15) — parity with the bulk-assign,
        // group-sync, and invitation enrollment paths: an import-driven enrollment
        // must show in BOTH the competition history and the user history.
        try { recordCompetitionEvent(comp.id, "user_added", adminId, { ...reqContext(req), user_id: userId, via: "import" }); } catch (_err) { swallowed("server:best-effort", _err); }
        try { recordUserEvent(userId, "added_to_competition", adminId, { ...reqContext(req), competition_id: comp.id, competition_name: m.competition_name, via: "import" }); } catch (_err) { swallowed("server:best-effort", _err); }
      }
    }
    return inserted;
  }
  // v6.16.6 — rehydrate absence rows from the v2 export's `absences[]`
  // array. INSERT OR IGNORE on the composite PK so a re-run of the
  // import is a no-op. Mismatched competition/timeslot names are
  // silently dropped (a `competition_user_absences` row pointing at
  // a non-existent comp would orphan immediately, and the gap
  // accounting it's tracking is by definition lost without the comp).
  // v6.16.9 — rehydrate absence rows from a v2 export's `absences[]`.
  // Pre-fix an exported `timeslot_name` that didn't resolve on the
  // target left tsId=NULL, and the row was inserted that way. The
  // leaderboard's gap query at server.js:3329 filters with
  // `(timeslot_id=? OR timeslot_id IS NULL)` — so a NULL absence got
  // subtracted from EVERY per-slot leaderboard for that comp instead
  // of just the slot the user was actually absent from. A user with
  // one real absence from slot A would have the gap subtracted from
  // slots B and C too — silent solveTimeMs corruption on round-trip,
  // which is exactly the use case v6.16.6 was meant to support.
  // Now: when timeslot_name is present but doesn't resolve, skip the
  // row + push to skipped_absences so the operator can act
  // (recreate the slot, hand-edit the export, etc.). Pure-comp
  // absences (timeslot_name absent) still apply globally as before.
  function _rehydrateAbsences(userId, p, skippedAccum) {
    if (!Array.isArray(p.absences) || p.absences.length === 0) return 0;
    let inserted = 0;
    // v8.12.0 — THE COMPETITOR LOCK'S OTHER IMPORT DOOR. A closed absence is
    // SUBTRACTED from solveTimeMs (lib/leaderboard.js), the tie-break that decides
    // placings, so an absence row is a board input as surely as a membership row
    // is: one on an event the acting superadmin competes in — a rival's, or their
    // own on any compete event — is skipped and reported, the posture the
    // membership loop above already takes.
    const _absActor = actorId(req);
    const insertAbs = db.prepare(
      "INSERT OR IGNORE INTO competition_user_absences (user_id, competition_id, timeslot_id, removed_at, returned_at, login_time, assigned_at) VALUES (?,?,?,?,?,?,?)"
    );
    // v8.3.34 (external audit) — EVERY value bound below comes straight out of
    // an uploaded JSON file, and better-sqlite3 SPREADS an array as POSITIONAL
    // bindings: one `{"login_time": ["a","b"]}` would push a seventh binding
    // onto a six-placeholder statement and throw a RangeError, 500ing the whole
    // participant import. That is exactly the class v8.3.20 closed for the
    // CHALLENGE import ("the challenge import polices field SHAPES, not only
    // row shapes"). `removed_at` / `returned_at` carried the same latent hazard
    // and are guarded here too rather than left as the one shape that can still
    // sink a 500-row migration. A wrong-typed timestamp is a well-typed row's
    // unusable FIELD, so it degrades to NULL — never a batch abort.
    const _ts = (v) => (typeof v === "string" && v ? v : null);
    for (const a of p.absences) {
      // v8.3.34 — `removed_at` must be a non-empty STRING, not merely truthy.
      // It is `TEXT NOT NULL` and part of the primary key, so a wrong-typed
      // value binding to NULL would raise a constraint error and sink the whole
      // import; skipping the row is this handler's documented posture for a row
      // it cannot apply.
      if (!a || typeof a.competition_name !== "string" || typeof a.removed_at !== "string" || !a.removed_at) continue;
      const comp = db.prepare("SELECT id, staff_compete FROM competitions WHERE name=? ORDER BY created_at LIMIT 1").get(a.competition_name);
      if (!comp) {
        skippedAccum.push({ email: p.email, competition_name: a.competition_name, reason: "competition_not_found" });
        continue;
      }
      if (_absActor && _staffCompeteOn(comp) && (userId === _absActor || _competitorIn(db, _absActor, comp.id))) {
        skippedAccum.push({ email: p.email, competition_name: a.competition_name, reason: "actor_competes" });
        continue;
      }
      let tsId = null;
      // v8.3.35 — `timeslot_name` is bound into the lookup below from the same
      // uploaded object, so it needs the same shape guard as the values bound
      // into the INSERT: an array/object/boolean here spreads or throws in
      // better-sqlite3 and 500s the whole import, which is the failure this
      // block's comment claims to have closed. Pre-existing (v6.16.9), fixed
      // here so that claim is true rather than aspirational.
      if (a.timeslot_name !== undefined && a.timeslot_name !== null && typeof a.timeslot_name !== "string") continue;
      if (a.timeslot_name) {
        const ts = db.prepare("SELECT id FROM competition_timeslots WHERE competition_id=? AND name=? LIMIT 1").get(comp.id, a.timeslot_name);
        if (ts) tsId = ts.id;
        else {
          // Slot was renamed/deleted on the target. Skip rather than
          // silently widen the gap-subtraction to all slots.
          skippedAccum.push({
            email: p.email,
            competition_name: a.competition_name,
            timeslot_name: a.timeslot_name,
            reason: "timeslot_not_found",
          });
          continue;
        }
      }
      // `login_time` NULL is the legacy/unknown case and is CORRECT: a pre-fix
      // export file carries no such key, and closeAbsenceAndRestoreAnchor
      // (lib/competitions.js) treats a NULL anchor as "unknown" and restores
      // nothing — byte-identical to the behaviour before this fix. Inventing an
      // anchor from removed_at would be a wrong answer that ranks somebody.
      // v8.12.6 — `assigned_at` (the original join time a re-add restores) takes the
      // same shape guard and the same NULL-means-unknown reading as `login_time`.
      const r = insertAbs.run(userId, comp.id, tsId, _ts(a.removed_at), _ts(a.returned_at), _ts(a.login_time), _ts(a.assigned_at));
      if (r.changes > 0) inserted++;
    }
    return inserted;
  }
  // v6.16.4 — counters lifted out of the txn closure so chunked
  // sub-transactions below can accumulate across chunks.
  let imported = 0, skipped = 0, overwritten = 0;
  // v6.15.0 — response counters.
  let memberships_imported = 0;
  let absences_imported = 0;     // v6.16.6 — competition_user_absences rows rehydrated
  const skippedMemberships = []; // { email, competition_name, reason }
  const skippedAbsences = [];    // v6.16.9 — { email, competition_name, timeslot_name?, reason }
  let denied_normalised = 0;     // rows where denied_at present but blocked=0/missing → blocked=1
  let rivalSkipped = 0;          // v8.14.4 — overwrites refused: the importer competes alongside the account
  let privilegedSkipped = 0;     // rows a non-superadmin importer may not apply (a privileged account, or a role beyond theirs)
  let controlCharsSkipped = 0;   // rows whose single-line profile text holds a control character (lib/util.js profileTextOk)
  let avatarLinksDropped = 0;    // rows whose avatar is a /api/images/ link to no stored picture, or to one that is not the overwritten account's own: not stored (an overwrite keeps the current avatar, a new account gets the default)
  // Avatars an overwrite replaced. Reclaimed ONCE, after the last row of the
  // whole import (below the chunk loop), each asked through the image manifest
  // then: reclaimed at the row, a picture a LATER row of the same file names
  // would already be gone.
  const _replacedAvatars = [];
  let role_grants = 0;            // rows where the import set role=admin or role=superadmin
  // v8.8.25 — ONE stamp for the whole import, not one per row. The overwrite
  // branch writes it into `users.updated_at`, the optimistic-concurrency
  // fingerprint two profile dialogs compare against. Per-batch rather than
  // per-row because the import is one operator action: a thousand rows carrying
  // a thousand distinct millisecond stamps says nothing more than one does, and
  // a single value makes "which import moved this row" answerable.
  const _importedAtIso = new Date().toISOString();
  // Per-row body — same logic the original single-txn loop ran. Kept as a
  // closure so the chunked sub-txns below can call it and the per-row
  // throws (`{ userError: true, ... }`) bubble out to the chunk's catch.
  const _processOneImportRow = (i) => {
    const pRaw = participants[i];
    if (!pRaw.nickname || !pRaw.email || !pRaw.first_name || !pRaw.last_name) { skipped++; return; }
    const conflict = conflictByIndex.get(i);
    const resolution = resolutions[String(i)] || (conflict ? "keep" : "import");

    if (conflict && resolution === "keep") { skipped++; return; }
    // A control character in single-line profile text (a name, the company…)
    // skips the row, insert or overwrite, before it is counted or its avatar
    // stored: one row must not sink the file, and a stored value is never
    // rewritten (lib/util.js profileTextOk).
    if (profileTextControlField(pRaw)) { controlCharsSkipped++; return; }
    // v8.14.4 — an OVERWRITE's two skips come first, before anything below
    // counts the row (`denied_normalised`, `role_grants`) or stores its avatar
    // (`sanitiseAvatar` inserts into `images`, which only the daily orphaned-image sweep reclaims, a week later).
    if (conflict && resolution === "overwrite" && conflict.conflictType !== "split_identity") {
      // RE-READ AT THE WRITE, NOT AT THE DRY RUN. `conflicts` was built before
      // the handler's last await (the commit-time park; any await added later),
      // so the account may be gone by now: its tag and membership rows would
      // then fail their foreign keys and sink the chunk.
      if (!db.prepare("SELECT 1 FROM users WHERE id=?").get(conflict.existingId)) { skipped++; return; }
      // (external audit R1) THE RIVAL DOOR'S IMPORT SIDE. An overwrite rewrites
      // `blocked`, `verified`, `approved`, the denial, the role and the whole tag
      // set (`benchmark` included): every account door `competitorRivalDenied`
      // shuts on somebody the importer competes alongside. The membership,
      // absence and group doors were already closed here; the account itself
      // was not, so a refused Block could be done through a file. Skipped and
      // counted, the tasks import's `competitor_skipped` posture: one row must
      // not sink the file.
      if (competitorRivalDenied(db, competitorIds(req), conflict.existingId)) { rivalSkipped++; return; }
    }
    // THE ESCALATION RULE'S IMPORT SIDE (lib/rbac.js). Any role holding
    // `data.import` reaches this route, so a row does only what the role route
    // and the account doors let this importer do: an overwrite of an account
    // that is a privileged target for them (it rewrites the address its sign-in
    // codes go to: privilegedTargetFor), or a row giving a role that can do more
    // than their own (roleAssignDenied), is skipped and counted. A superadmin
    // passes both.
    if (!req.session.isSuperAdmin) {
      const _rb = require("./lib/rbac");
      const _over = !!conflict && resolution === "overwrite" && conflict.conflictType !== "split_identity";
      const _cur = _over ? ((db.prepare("SELECT role FROM users WHERE id=?").get(conflict.existingId) || {}).role || "participant") : "participant";
      if ((_over && _rb.privilegedTargetFor(req, _cur))
          || (typeof pRaw.role === "string" && pRaw.role !== _cur && _rb.roleAssignDenied(req, _cur, pRaw.role))) { privilegedSkipped++; return; }
    }

    // v6.15.0 — defensive normalisation. The deny invariant
    // (server.js:9054) sets denied_at + blocked=1 atomically; if a
    // hand-edited or legacy export carries denied_at without
    // blocked=1, force blocked=1 to keep the lifecycle consistent.
    // Track in `denied_normalised` so the operator sees the auto-fix.
    const p = (pRaw.denied_at && !pRaw.blocked)
      ? (denied_normalised++, { ...pRaw, blocked: 1 })
      : pRaw;

    // v6.15.0 — track role grants for audit. Endpoint is gated by
    // requireSuperAdmin so the actual privilege check is done; this
    // counter exists so the UI can surface "imported N admins / M
    // superadmins" instead of the silent role=admin assignment that
    // pre-v6.15.0 dropped on the floor (role wasn't even read).
    if (_has(p, "role") && require("./lib/rbac").isGlobalClassRole(p.role, { live: true })) {   // an unscoped role, built-in or custom
      role_grants++;
    }

    // A `/api/images/` link must name a stored picture (lib/sanitise.js
    // sanitiseAvatar, `preserve`); one that does not is not stored and is
    // counted: an overwrite keeps the account's current avatar (below), a new
    // account gets the default.
    // A link may name only the overwritten account's OWN current picture (a new
    // account has none): lib/sanitise.js sanitiseAvatar `current`.
    const _curAvatar = (conflict && resolution === "overwrite" && conflict.existingId)
      ? (db.prepare("SELECT avatar FROM users WHERE id=?").get(conflict.existingId) || {}).avatar : undefined;
    const _avatarIn = sanitiseAvatar(p.avatar, { preserve: true, current: _curAvatar });
    const _avatarLinkDead = _avatarIn === undefined && typeof p.avatar === "string" && /^\/api\/images\//i.test(p.avatar);
    if (_avatarLinkDead) avatarLinksDropped++;
    let avatar = _avatarIn || "default1";

    if (conflict && resolution === "overwrite") {
      if (conflict.conflictType === "split_identity") {
        throw { userError: true, error: `Row ${i+1}: the nickname "${p.nickname}" and email "${p.email}"${p.secondary_email ? `/"${p.secondary_email}"` : ""} resolve to different existing users — choose rename or keep, not overwrite.`, conflictIndex: i };
      }
      const uid = conflict.existingId;
      // Even on overwrite we must re-validate the secondary email against
      // the rest of the user base: the existing primary/secondary values
      // we're replacing may be ok, but the INCOMING secondary could collide
      // with a *third* user's primary or secondary slot.
      if (p.secondary_email && emailIsTaken(p.secondary_email, uid)) {
        throw { userError: true, error: `Row ${i+1}: secondary email "${p.secondary_email}" is already used by another account.`, conflictIndex: i };
      }
      if (sameSlotEmails(p.email, p.secondary_email)) {
        throw { userError: true, error: `Row ${i+1}: primary and secondary email must be different.`, conflictIndex: i };
      }
      const oldRow = db.prepare("SELECT avatar FROM users WHERE id=?").get(uid);
      if (_avatarLinkDead && oldRow) avatar = oldRow.avatar;
      // v7.2.0 — an import overwrite that sets verified (defaults to 1) must also
      // clear any verification-grace deadline, so a verified=1 row can never keep
      // a stale self_enroll_grace_until (invariant: verified=1 ⇒ grace NULL).
      // v7.6.0 — fill first_verified_at on overwrite if the row becomes verified
      // and didn't already carry the stamp (COALESCE preserves a real prior one).
      // v8.3.20 — COERCE TO 0/1 ONCE, and bind that everywhere.
      //
      // These were bound RAW, so `verified: true` from a hand-authored file (a
      // shape `_IMPORT_FIELD_SHAPES.flag` certifies as valid) threw
      // "SQLite3 can only bind numbers, strings, bigints, buffers, and null"
      // — the opaque 500 the shape guard exists to eliminate, produced by a row
      // the guard had just blessed. Because this import commits in 100-row
      // chunks (v6.16.4), a boolean in row 121 also left rows 1-100 persisted
      // under a flat failure. The tasks import already normalises `active` this
      // way; these are the same fields on the other side of the file.
      const _ovVerified = (p.verified === undefined || p.verified === null) ? 1 : (p.verified ? 1 : 0);
      const _ovBlocked  = (p.blocked  === undefined || p.blocked  === null) ? 0 : (p.blocked  ? 1 : 0);
      const _ovFirstVerified = p.first_verified_at || (_ovVerified ? importNowForBatch : null);
      // ext-audit batch 3 (F2) — apply the SAME per-field length caps as the
      // insert branch (below) + register / PUT /api/me. Pre-fix the overwrite
      // path persisted oversized company/title/name/etc. the other write paths
      // reject. (nickname is NOT in this UPDATE — it's preserved — so it's not
      // re-capped here.)
      const _ovCap = _capsOk({ first_name: p.first_name, last_name: p.last_name, company: p.company, title: p.title, personal_title: p.personal_title, phone: p.phone, job_function: p.job_function, city: p.city, secondary_email: p.secondary_email, linkedin_url: p.linkedin_url });
      if (_ovCap) throw { userError: true, error: `Row ${i+1}: ${_ovCap.field} must be at most ${_ovCap.max} characters.`, conflictIndex: i };
      // audit v7.7.29 (M7) — `approved` must be overwritten too. Pre-fix the base
      // UPDATE wrote verified + blocked but omitted approved, while approved_at /
      // approved_by DID come through _V2_AUDIT_FIELDS — so a v2 export with
      // approved=1 could stamp approved_at yet leave the row approved=0 (a user
      // who still can't log in, with contradictory audit fields). COALESCE(?,
      // approved): honour the payload value (including a real 0) when present,
      // keep the existing value when absent (v1 exports omit it — unchanged).
      // (approved is NOT in _V2_AUDIT_FIELDS, whose `|| null` mapping would
      // corrupt a boolean 0 → NULL.)
      const _ovApproved = _has(p, "approved") ? (p.approved ? 1 : 0) : null;
      db.prepare(`UPDATE users SET first_name=?, last_name=?, company=?, title=?, personal_title=?, phone=?, certificate_given_name=?, certificate_family_name=?, country=?, timezone=?, job_function=?, city=?, linkedin_url=?, registered_via=?, avatar=?, verified=?, first_verified_at=COALESCE(first_verified_at, ?), blocked=?, approved=COALESCE(?, approved), secondary_email=?, self_enroll_grace_until=CASE WHEN ?=1 THEN NULL ELSE self_enroll_grace_until END, verify_code=CASE WHEN ?=1 THEN verify_code ELSE NULL END, verify_code_at=CASE WHEN ?=1 THEN verify_code_at ELSE NULL END, login_code_hash=CASE WHEN ?=1 THEN login_code_hash ELSE NULL END, login_code_at=CASE WHEN ?=1 THEN login_code_at ELSE NULL END, login_code_via=CASE WHEN ?=1 THEN login_code_via ELSE NULL END, login_code_sends=CASE WHEN ?=1 THEN login_code_sends ELSE 0 END, updated_at=? WHERE id=?`)
        .run(p.first_name, p.last_name, p.company || "", p.title || "", p.personal_title || null, p.phone || null, p.certificate_given_name || null, p.certificate_family_name || null, p.country || "", p.timezone || "", p.job_function || null, p.city || null, validateUrl(p.linkedin_url), p.registered_via || "manual", avatar, _ovVerified, _ovFirstVerified, _ovBlocked, _ovApproved, p.secondary_email || null, _ovVerified,
          // v7.23.10 — REQUIRED by one-click verification. That change stopped
          // nulling verify_code on success (the retained code is what lets a
          // human clicking after a mail scanner be told the truth instead of
          // "Verification Failed"), so a code now stays live for its 48h window.
          // This is the ONE path that sets verified=0 WITHOUT replacing the code —
          // the admin email change re-mints one in the same statement. Left alone,
          // an operator importing verified=0 to force re-verification could be
          // silently undone by a late scanner re-crawl or the user re-clicking the
          // old link. Clearing the code only when verified is being set to 0 keeps
          // the ordinary verified=1 import byte-identical.
          _ovVerified, _ovVerified,
          // v8.3.20 (external audit) — the same idiom extended to the emailed
          // sign-in code, which can also UNDO the force: redeeming one re-stamps
          // `verified=1` + `first_verified_at`, and `first_verified_at` is never
          // cleared, so it also exempts the row from the 48 h unverified-account
          // reaper for good. Four binds, all the SAME coerced `_ovVerified`, so an
          // ordinary verified=1 import stays byte-identical exactly as the
          // paragraph above promises.
          _ovVerified, _ovVerified, _ovVerified, _ovVerified,
          // v8.8.25 — the THIRD profile writer, so it moves the optimistic-
          // concurrency fingerprint. Deliberately NOT a compare-and-swap: an
          // import is a bulk migration with no dialog behind it, and refusing a
          // 5000-row file because one participant's profile moved would be the
          // wrong trade. Stamping it is what matters — an admin whose Edit
          // Profile dialog is open while an import rewrites that row is then
          // REFUSED on save rather than silently overwriting the import.
          _importedAtIso,
          uid);
      // Reclaimed after the whole import, not here (see `_replacedAvatars`).
      if (oldRow && oldRow.avatar !== avatar && oldRow.avatar) _replacedAvatars.push(oldRow.avatar);
      // A replaced SECONDARY address leaves the live sign-in code alone: a code is
      // mailed to the primary and redeemed against it only (the rule `PUT /api/me`
      // and the admin edit keep). The CASE clauses above clear it only for the
      // force-re-verification import (`verified: 0`).
      // v6.15.0 — additionally update v2 audit fields ONLY when
      // present in the import payload. This means a v1 export
      // (which omits these fields) preserves the existing audit
      // row state on overwrite — same as pre-v6.15.0 behaviour. A
      // v2 export brings them through. The dynamic UPDATE only
      // touches columns the payload explicitly carries, so an
      // operator editing two fields in a hand-rolled JSON doesn't
      // inadvertently wipe the audit columns they didn't include.
      const _v2Sets = [];
      const _v2Vals = [];
      for (const col of _V2_AUDIT_FIELDS) {
        if (_has(p, col)) {
          _v2Sets.push(`${col}=?`);
          // v8.3.39 (external audit) — this loop builds its column list and its
          // bind list DYNAMICALLY from the uploaded object, which makes it the
          // one site where a shape the row-level check does not know about still
          // reaches SQLite. Every member of _V2_AUDIT_FIELDS is now shape-checked
          // up front except `profile_policy`, which the INSERT branch deliberately
          // COERCES rather than refuses; coercing here too keeps the two branches
          // saying the same thing and makes the loop safe by construction if the
          // list grows again.
          _v2Vals.push(typeof p[col] === "string" && p[col] ? p[col] : null);
        }
      }
      if (_v2Sets.length) {
        db.prepare(`UPDATE users SET ${_v2Sets.join(", ")} WHERE id=?`).run(..._v2Vals, uid);
      }
      db.prepare("DELETE FROM user_tags WHERE user_id=?").run(uid);
      const insertTag = db.prepare("INSERT OR IGNORE INTO user_tags (user_id, tag) VALUES (?,?)");
      for (const tag of (p.tags || [])) if (typeof tag === "string" && tag.trim()) insertTag.run(uid, tag.trim()); // batch 5 — skip non-string tags (would 500 at the SQL bind)
      // v7.1.x — every unscoped role (admin, superadmin, a custom one) is always
      // `staff` (parity with the role-change endpoint), so leaderboards/analytics exclude them; the
      // explicit-tags loop above won't add it unless the payload listed it.
      { const _ir = db.prepare("SELECT role FROM users WHERE id=?").get(uid); if (_ir && require("./lib/rbac").isGlobalClassRole(_ir.role, { live: true })) insertTag.run(uid, "staff"); }
      _rehydrateGroups(uid, p, importAdminId, importNowForBatch); // v6.20.0 — additive group memberships
      // Rehydrate competition memberships from the v2 export. INSERT
      // OR IGNORE so existing memberships aren't disturbed (the
      // import is additive on overwrite — destructive membership
      // changes go through the participants UI, not import).
      memberships_imported += _rehydrateMemberships(uid, p, importAdminId, importNowForBatch, skippedMemberships);
      absences_imported += _rehydrateAbsences(uid, p, skippedAbsences);
      recordUserEvent(uid, "edited", importAdminId, { ...reqContext(req), via: "import_overwrite" });
      _importedUserIds.add(uid);
      overwritten++;
    } else {
      let nick = p.nickname;
      let email = p.email;
      let secondary = p.secondary_email || null;
      if (conflict && resolution === "rename") {
        const overrides = resolutions[`${i}_rename`] || {};
        if (overrides.nickname) nick = String(overrides.nickname).trim();
        if (overrides.email) email = normaliseEmail(overrides.email);
        if (overrides.secondary_email !== undefined) secondary = overrides.secondary_email ? normaliseEmail(overrides.secondary_email) : null;
        // v7.2.x (audit, F2) — rename overrides are operator-supplied AFTER the
        // up-front base-row validation + canonicalisation, so they must run the
        // SAME identity gates every normal account flow enforces. Pre-fix the raw
        // override reached the INSERT unvalidated, letting a superadmin persist a
        // malformed/non-canonical email (defeating the NFC+lowercase identity
        // invariant emailIsTaken relies on) or an out-of-cap / <3-char nickname
        // that registration + profile-edit reject. Throw the existing rename
        // {userError, conflictIndex} shape so the chunk rolls back to the 400.
        if (nick.length < 3)
          throw { userError: true, error: `Row ${i+1}: nickname "${nick}" must be at least 3 characters.`, conflictIndex: i };
        if (!_nicknameCharsOk(nick))
          throw { userError: true, error: `Row ${i+1}: ${NICKNAME_CHARSET_ERROR}`, conflictIndex: i };
        const _renameCap = _capsOk({ nickname: nick, secondary_email: secondary });
        if (_renameCap)
          throw { userError: true, error: `Row ${i+1}: ${_renameCap.field} must be at most ${_renameCap.max} characters.`, conflictIndex: i };
        if (!isValidEmailFormat(email))
          throw { userError: true, error: `Row ${i+1}: renamed primary email "${email}" is not a valid email address.`, conflictIndex: i };
        if (secondary && !isValidEmailFormat(secondary))
          throw { userError: true, error: `Row ${i+1}: renamed secondary email "${secondary}" is not a valid email address.`, conflictIndex: i };
        if (db.prepare("SELECT id FROM users WHERE nickname=? COLLATE NOCASE").get(nick))
          throw { userError: true, error: `Nickname "${nick}" is still taken. Please choose a different one.`, conflictIndex: i };
        if (emailIsTaken(email))
          throw { userError: true, error: `Email "${email}" is already registered (as a primary or secondary address). Please choose a different one.`, conflictIndex: i };
        if (secondary && emailIsTaken(secondary))
          throw { userError: true, error: `Secondary email "${secondary}" is already registered (as a primary or secondary address). Please choose a different one.`, conflictIndex: i };
      } else if (!conflict) {
        // ext-audit v7.15.14 (HIGH) — re-check the PRIMARY email here too.
        //
        // Conflict detection runs up front, before the handler's last await. A
        // concurrent profile edit landing in that window can take the address this row was cleared
        // to use — and SQLite's UNIQUE indexes only cover primary↔primary and
        // secondary↔secondary, never the CROSS-slot case (this row's primary ==
        // another account's secondary), so nothing downstream catches it. The
        // result is one address resolving to two accounts, which makes login and
        // password recovery ambiguous. The secondary was already re-checked
        // here; the primary was the gap.
        if (emailIsTaken(email))
          throw { userError: true, error: `Row ${i+1}: primary email "${email}" was registered by another account while this import was running. Re-run the import.`, conflictIndex: i };
        // v8.14.4 — and the NICKNAME, for the same window: its uniqueness was
        // decided by the dry run too, and a collision here is a raw constraint
        // error, so the chunk failed as a 500 with no `partial:` after earlier
        // chunks had committed. The rename branch already re-asks it.
        if (db.prepare("SELECT id FROM users WHERE nickname=? COLLATE NOCASE").get(nick))
          throw { userError: true, error: `Row ${i+1}: nickname "${nick}" was registered by another account while this import was running. Re-run the import.`, conflictIndex: i };
        // No conflict flagged up front — but the import row still could
        // contain a secondary_email that collides in isolation. Re-check.
        if (secondary && emailIsTaken(secondary))
          throw { userError: true, error: `Row ${i+1}: secondary email "${secondary}" is already used by another account.`, conflictIndex: i };
        // v7.2.x (ext-audit F1) — a non-conflict base row bypasses the rename
        // branch above, so enforce the same nickname min-length + ASCII charset
        // gate here, keeping the users.nickname column ASCII-only (so the
        // COLLATE NOCASE uniqueness index is complete).
        if (nick.length < 3)
          throw { userError: true, error: `Row ${i+1}: nickname "${nick}" must be at least 3 characters.`, conflictIndex: i };
        if (!_nicknameCharsOk(nick))
          throw { userError: true, error: `Row ${i+1}: ${NICKNAME_CHARSET_ERROR}`, conflictIndex: i };
      }
      if (sameSlotEmails(email, secondary))
        throw { userError: true, error: `Row ${i+1}: primary and secondary email must be different.`, conflictIndex: i };
      // v7.7.5 (ext-audit F6) — apply the SAME per-field length caps as register /
      // PUT /api/me to EVERY imported row, so an import can't persist oversized
      // profile fields (company/title/name/etc.) the normal write paths reject.
      // (The rename branch above only capped nickname/secondary_email.)
      const _impCap = _capsOk({
        first_name: p.first_name, last_name: p.last_name, nickname: nick,
        company: p.company, title: p.title, personal_title: p.personal_title, phone: p.phone,
        job_function: p.job_function, city: p.city, secondary_email: secondary, linkedin_url: p.linkedin_url,
      });
      if (_impCap)
        throw { userError: true, error: `Row ${i+1}: ${_impCap.field} must be at most ${_impCap.max} characters.`, conflictIndex: i };
      const uid = uuid();
      const importNow = importNowForBatch;
      // v6.15.0 — full v2 INSERT. Backwards-compat: when a v1 export
      // is being imported, every v2 field is absent and falls back
      // to its v1 default below (approved_at = importNow when
      // approved=1 / approved_by = importAdminId / role =
      // "participant" / created_at = importNow / everything else
      // NULL). When a v2 export is imported, the values come
      // through verbatim, so a roundtrip preserves every column.
      const v2_approved_at  = _has(p, "approved_at")  ? (p.approved_at  || null) : (p.approved ? importNow : null);
      const v2_approved_by  = _has(p, "approved_by")  ? (p.approved_by  || null) : (p.approved ? importAdminId : null);
      const v2_denied_at    = p.denied_at    || null;
      const v2_denied_by    = p.denied_by    || null;
      const v2_denied_reason= p.denied_reason|| null;
      const v2_role         = p.role         || "participant";
      const v2_locked_until = p.locked_until || null;
      const v2_login_time   = p.login_time   || null;
      const v2_last_login_t = p.last_login_time || null;
      const v2_invitation_id= p.invitation_id|| null;
      const v2_invited_at   = p.invited_at   || null;
      const v2_invited_by   = p.invited_by   || null;
      const v2_created_at   = _has(p, "created_at") && p.created_at ? p.created_at : importNow;
      // v7.6.0 — carry first_verified_at through the round-trip; if the export
      // predates the field but the row is verified, stamp it from created_at so a
      // re-imported verified account is never seen as "never verified" by the
      // unverified-account reaper. A verified=0 import stays NULL (genuinely
      // unverified → subject to the same 48h rule as any unverified account).
      // v8.3.20 — same coercion as the overwrite branch above; see the note there.
      const v2_verified     = (p.verified === undefined || p.verified === null) ? 1 : (p.verified ? 1 : 0);
      const v2_blocked      = (p.blocked  === undefined || p.blocked  === null) ? 0 : (p.blocked  ? 1 : 0);
      const v2_approved     = (p.approved === undefined || p.approved === null) ? 1 : (p.approved ? 1 : 0);
      const v2_first_verified_at = p.first_verified_at || (v2_verified ? v2_created_at : null);
      // v8.1.1 — the registration policy the account was created under. Carried
      // VERBATIM: it is a stored DEAL, not a value this side may re-derive, and
      // the two fields it drops were never collected from the walk-up in the
      // first place. An absent key (a file predating the column) is NULL, which
      // is the full-profile default every ordinary account already carries.
      //
      // A non-string is coerced to NULL rather than bound raw — an object would
      // 500 at the bind (batch 5), and the two answers are behaviourally the same
      // anyway because `eventPolicy` normalises anything it does not recognise to
      // the default, which relaxes nothing. So there is no value worth risking a
      // 500 to preserve.
      const v2_profile_policy = typeof p.profile_policy === "string" && p.profile_policy.trim() ? p.profile_policy.trim() : null;
      db.prepare(`INSERT INTO users (
          id, first_name, last_name, nickname, company, title, personal_title, phone, email, secondary_email,
          certificate_given_name, certificate_family_name,
          avatar, verified, first_verified_at, blocked, approved, approved_at, approved_by,
          denied_at, denied_by, denied_reason,
          role, locked_until, login_time, last_login_time,
          invitation_id, invited_at, invited_by, profile_policy,
          password_hash, country, timezone, job_function, city, linkedin_url, registered_via, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?
        )`).run(
          uid, p.first_name, p.last_name, nick, p.company || "", p.title || "", p.personal_title || null, p.phone || null, email, secondary,
          p.certificate_given_name || null, p.certificate_family_name || null,
          avatar, v2_verified, v2_first_verified_at, v2_blocked, v2_approved, v2_approved_at, v2_approved_by,
          v2_denied_at, v2_denied_by, v2_denied_reason,
          v2_role, v2_locked_until, v2_login_time, v2_last_login_t,
          v2_invitation_id, v2_invited_at, v2_invited_by, v2_profile_policy,
          // v7.2.x (audit) — job_function + city were exported but dropped on import,
          // re-creating every re-imported account with NULLs → the profile gate fired.
          // An imported account is passwordless, as every other create is: it
          // signs in by an emailed code (`password_set_at` stays NULL).
          NO_PASSWORD_HASH, p.country || "", p.timezone || "", p.job_function || null, p.city || null, validateUrl(p.linkedin_url), p.registered_via || "manual", v2_created_at
        );
      const insertTag = db.prepare("INSERT OR IGNORE INTO user_tags (user_id, tag) VALUES (?,?)");
      for (const tag of (p.tags || [])) if (typeof tag === "string" && tag.trim()) insertTag.run(uid, tag.trim()); // batch 5 — skip non-string tags (would 500 at the SQL bind)
      // v7.1.x — every unscoped role (admin, superadmin, a custom one) is always
      // `staff` (parity with the role-change endpoint), so leaderboards/analytics exclude them; the
      // explicit-tags loop above won't add it unless the payload listed it.
      { const _ir = db.prepare("SELECT role FROM users WHERE id=?").get(uid); if (_ir && require("./lib/rbac").isGlobalClassRole(_ir.role, { live: true })) insertTag.run(uid, "staff"); }
      _rehydrateGroups(uid, p, importAdminId, importNow); // v6.20.0 — additive group memberships
      // v6.15.0 — rehydrate competition memberships from the v2
      // export. Same code path as overwrite; helper isolates the
      // comp-by-name + ts-by-name lookups.
      memberships_imported += _rehydrateMemberships(uid, p, importAdminId, importNow, skippedMemberships);
      absences_imported += _rehydrateAbsences(uid, p, skippedAbsences);
      // Flag company-email rule bypass so the superadmin-only import path
      // leaves an auditable trail even though it's allowed by policy.
      const pFree = isFreeEmail(email || "");
      const sFree = secondary ? isFreeEmail(secondary) : true;
      const ev = { via: "import", email };
      if (pFree && sFree) ev.bypassed_free_email_rule = true;
      recordUserEvent(uid, "created", importAdminId, ev);
      if (p.approved) recordUserEvent(uid, "approved", importAdminId, { ...reqContext(req), via: "import" });
      // v6.15.0 — explicit denial / role audit rows so a re-imported
      // denied user / admin user / etc. shows up in the user_events
      // log with the correct event type, not just as a bare "created".
      if (v2_denied_at) recordUserEvent(uid, "denied", importAdminId, { ...reqContext(req), via: "import", reason: v2_denied_reason || null });
      if (v2_role && v2_role !== "participant") recordUserEvent(uid, "role_changed", importAdminId, { ...reqContext(req), via: "import", from: "participant", to: v2_role });
      _importedUserIds.add(uid);
      imported++;
    }
  };
  // v6.16.4 — chunked sub-transactions instead of a single big txn.
  // Pre-fix the entire import (5000 rows × multiple inserts each) ran
  // inside ONE db.transaction(), holding the SQLite write lock (taken at
  // its first write — `db.transaction()` is a DEFERRED BEGIN, not the
  // BEGIN IMMEDIATE this comment used to name) for several seconds. This
  // comment also used to say that starved live /submit, /hint and admin
  // edits "on busy_timeout=5000"; it did not, and nothing in this process
  // ever waits on that lock — better-sqlite3 is synchronous, so a live
  // request waits on the blocked EVENT LOOP instead, and busy_timeout only
  // governs a writer in ANOTHER process (README, *Import atomicity*). With
  // chunks of 100 rows each sub-txn commits in tens of milliseconds and the
  // writer lock releases between chunks. Stated precisely, because the
  // original sentence ("and live traffic interleaves cleanly") over-claimed:
  // the loop below never yields to the event loop between chunks, so IN THIS
  // PROCESS a live /submit still waits for the whole chunk loop (one
  // synchronous stall); what the per-chunk release buys is that an EXTERNAL
  // writer on the file is not held off for the whole import, plus the
  // partial-commit semantics below.
  //
  // Trade-off: a userError thrown inside chunk K aborts that chunk only.
  // Chunks 0..K-1 are persisted. The error response now carries
  // `partial: { imported, ... }` so the operator can see how far the
  // import got and recompute resolutions for a re-run. Re-running with
  // the same JSON is idempotent because already-imported rows surface
  // as conflicts on the next dry-run.
  const IMPORT_CHUNK_SIZE = 100;
  let chunkErr = null;
  try {
    for (let chunkStart = 0; chunkStart < participants.length; chunkStart += IMPORT_CHUNK_SIZE) {
      const chunkEnd = Math.min(chunkStart + IMPORT_CHUNK_SIZE, participants.length);
      // v6.16.12 — snapshot counters BEFORE the chunk so a userError
      // mid-chunk can roll the JS-locals back to match the rolled-back
      // DB state. Pre-fix the per-row mutations (`imported++`,
      // `memberships_imported += …`, `skippedAbsences.push(…)`, etc.)
      // accumulated in JS even when their corresponding DB writes
      // were inside the txn that ultimately rolled back. The
      // `partial:` response then claimed rows had landed when they
      // hadn't — operators re-running the import double-billed audit
      // events for "already-imported" rows that had actually rolled
      // back. Snapshot/restore on userError keeps `partial:` truthful.
      const _snapshot = {
        imported, skipped, overwritten,
        memberships_imported, absences_imported,
        denied_normalised, role_grants, rivalSkipped, privilegedSkipped, controlCharsSkipped, avatarLinksDropped,
        // v8.14.4 — the group drops happen inside the chunk too, and now reach
        // `partial:` (the client's stop toast renders them).
        droppedGroupClashes: _droppedGroupClashes, droppedGroupCompete: _droppedGroupCompete,
        // Arrays: capture length now; restore by truncating on rollback.
        skipped_memberships_len: skippedMemberships.length,
        skipped_absences_len: skippedAbsences.length,
        replaced_avatars_len: _replacedAvatars.length,
      };
      const chunkTxn = db.transaction(() => {
        for (let i = chunkStart; i < chunkEnd; i++) _processOneImportRow(i);
      });
      // v6.16.13 — wrap chunkTxn in runTxnWithMirrorBuffer so a
      // userError-driven rollback drops the audit-mirror buffer too.
      // Pre-fix _processOneImportRow's recordUserEvent calls fired
      // setImmediate mirror lines into app.jsonl regardless of whether
      // the chunk's txn committed; ~50-100 ghost "audit:user:created"
      // / "audit:user:approved" / "audit:user:edited" entries per
      // failed chunk would survive past the rollback. Closes the same
      // bug class v6.16.9 closed at the seven other wrapped sites.
      try { runTxnWithMirrorBuffer(() => chunkTxn()); }
      catch (e) {
        // Restore counters from the pre-chunk snapshot — the txn
        // rollback already reverted DB writes; this keeps in-process
        // bookkeeping in lockstep.
        imported = _snapshot.imported;
        skipped = _snapshot.skipped;
        overwritten = _snapshot.overwritten;
        memberships_imported = _snapshot.memberships_imported;
        absences_imported = _snapshot.absences_imported;
        denied_normalised = _snapshot.denied_normalised;
        role_grants = _snapshot.role_grants;
        rivalSkipped = _snapshot.rivalSkipped;
        privilegedSkipped = _snapshot.privilegedSkipped;
        controlCharsSkipped = _snapshot.controlCharsSkipped;
        avatarLinksDropped = _snapshot.avatarLinksDropped;
        _droppedGroupClashes = _snapshot.droppedGroupClashes;
        _droppedGroupCompete = _snapshot.droppedGroupCompete;
        skippedMemberships.length = _snapshot.skipped_memberships_len;
        skippedAbsences.length = _snapshot.skipped_absences_len;
        // The rolled-back chunk replaced nothing.
        _replacedAvatars.length = _snapshot.replaced_avatars_len;
        if (e && e.userError) { chunkErr = e; break; }
        throw e;
      }
    }
  } catch (e) {
    // Non-user errors (DB / FS / unexpected) bubble up to the global handler.
    throw e;
  }
  // Every row the import will write is written (the committed chunks, on the
  // partial path too): reclaim each avatar an overwrite replaced, once, asking
  // the image manifest now (deleteAvatarImage), so a picture a later row of the
  // file named is kept.
  for (const ref of new Set(_replacedAvatars)) {
    try { deleteAvatarImage(ref); } catch (e) { swallowed("server:import-reclaim-replaced-avatar", e); }
  }
  // v6.20.x — reconcile every group the import touched so newly-imported members
  // enroll into the group's bound (live/upcoming) competitions, honouring the
  // live-sync contract. Runs after the chunk txns commit; covers the partial-
  // failure path too (committed chunks may already have added memberships).
  // Large groups overflow the per-pass cap and drain via detached follow-ups.
  for (const gid of _touchedGroupIds) {
    try { await reconcileGroupBoundCompetitions(gid, { actor: importAdminId }); } catch (_err) { swallowed("server:best-effort", _err); }
  }
  // v6.20.x — the import rewrites user_tags for many users across chunks; clear
  // the whole getUserTags cache once (cheaper + simpler than tracking every uid).
  _invalidateUserTagsCache();
  // concurrency-cache audit (#2): honour the documented writer-lock invariants
  // the import previously skipped. (1) admin-participants list is stale for 5s
  // after the import writes/overwrites users → bust it. (2) a rehydrated
  // membership with login_time + historical submissions belongs on the board →
  // bust the leaderboard cache for every touched comp. (3) an overwritten user's
  // /api/me (profile/role/verified) is stale for 2s → bust each touched user's
  // me-cache. Runs on the partial-failure path too (committed chunks already
  // mutated state). reconcileGroupBoundCompetitions above only covers comps bound
  // to touched groups, not the direct membership rehydration here.
  invalidateAdminParticipantsCache();
  // audit v7.7.36 (C6) — an OVERWRITE can flip tags (staff/benchmark) or verified
  // — both leaderboard-eligibility predicates — on an ALREADY-enrolled user, whose
  // comps aren't in _touchedCompIds (that only tracks NEW memberships). Union every
  // imported user's existing comps so their boards bust too (mirrors the
  // interactive tag routes' per-comp fan-out).
  if (_importedUserIds.size) {
    const ids = [..._importedUserIds];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const ph = "SELECT value FROM json_each(?)";
      for (const r of db.prepare(`SELECT DISTINCT competition_id FROM competition_users WHERE user_id IN (${ph})`).all(JSON.stringify(chunk))) _touchedCompIds.add(r.competition_id);
    }
  }
  for (const cid of _touchedCompIds) invalidateLeaderboardCache(cid);
  for (const uid of _importedUserIds) _invalidateMeCache(uid);
  if (chunkErr) {
    return res.status(400).json({
      error: chunkErr.error,
      conflictIndex: chunkErr.conflictIndex,
      // Prior chunks have already committed; surface the partial counters
      // so the operator can re-run with corrections without losing context.
      partial: { imported, skipped, overwritten, memberships_imported, absences_imported, skipped_memberships: skippedMemberships, skipped_absences: skippedAbsences, denied_normalised, role_grants, rival_skipped: rivalSkipped, privileged_skipped: privilegedSkipped, control_chars_skipped: controlCharsSkipped, avatar_links_dropped: avatarLinksDropped, group_clashes_dropped: _droppedGroupClashes, group_actor_competes_dropped: _droppedGroupCompete },
    });
  }
  // v6.16.29 — batch-summary audit event. Per-row recordUserEvent
  // calls already lock the per-user trail; this row reconstructs the
  // whole bulk import (admin / source-version / counts) as a single
  // forensic record so an investigator doesn't have to aggregate
  // 1000 user_events rows manually.
  try {
    recordOrphanedAuditEvent("import", "participants", "batch_imported", importAdminId, {
      ...reqContext(req),
      envelope_version: data.version || 1,
      total: data.participants.length,
      imported, overwritten, skipped,
      memberships_imported,
      absences_imported,
      skipped_memberships: skippedMemberships.length,
      skipped_absences: skippedAbsences.length,
      denied_normalised,
      role_grants,
      rival_skipped: rivalSkipped,
      privileged_skipped: privilegedSkipped,
      control_chars_skipped: controlCharsSkipped,
      avatar_links_dropped: avatarLinksDropped,
    });
  } catch (_err) { swallowed("server:best-effort", _err); }
  res.json({
    ok: true,
    imported, skipped, overwritten,
    memberships_imported,
    absences_imported,    // v6.16.6
    skipped_memberships: skippedMemberships,
    skipped_absences: skippedAbsences,
    denied_normalised,
    role_grants,
    group_clashes_dropped: _droppedGroupClashes, // v7.11.3 — invariant-preserving drops
    group_actor_competes_dropped: _droppedGroupCompete, // v8.12.0 — the group door onto an event the importer competes in
    invalid_timezones_dropped: _invalidTimezonesDropped, // v7.21.1 (A7) — cleared to empty, gate re-prompts
    invalid_roles_dropped: _invalidRolesDropped, // v8.3.39 — unrecognised role ignored; insert defaults, overwrite preserves
    rival_skipped: rivalSkipped, // v8.14.4 — accounts of people the importer competes alongside, not overwritten
    privileged_skipped: privilegedSkipped, // rows a non-superadmin importer may not apply: a privileged account, or a role beyond their own
    control_chars_skipped: controlCharsSkipped, // rows whose names or other single-line profile text hold a control character
    avatar_links_dropped: avatarLinksDropped, // avatar links to no stored picture or to another account's, not stored (overwrite keeps the current avatar, a new account gets the default)
  });
});

// ── Perf-only bulk-seed-users ──────────────────────────────────────────────
// v6.10.80 — high-throughput user creation for perf-test seeding. Replaces
// the N × /api/register calls seed.js was making (BG 5000 users ~10 min,
// perf 321 users ~15 s even after v6.10.79 parallelisation) with a single
// POST that:
//   1. Hashes nothing: every row stores the fixed `NO_PASSWORD_HASH`
//      placeholder (no password), so no bcrypt round is spent per user.
//   2. Runs the whole batch inside ONE db.transaction() so disk syncs
//      happen once at commit, not 5000× per row.
//   3. Sets `verified=1, approved=1` in the INSERT directly — no
//      separate verify + approve admin-request loops needed.
//   4. Optionally inserts into `competition_users` in the same
//      transaction — no separate /api/admin/competitions/assign call.
// Expected: 10-min BG seed → ~1 s. 15-s perf seed → sub-second.
//
// Safety gates (stacked, ALL must pass):
//   * requireAdmin + requireSuperAdmin (auth, as with /import endpoints) — and,
//     since v8.12.7, re-asked at commit, as the imports are
//     (`adminAuthzDenied`, superadmin tier)
//   * csrfProtection (same as /import)
//   * DATA_DIR/.maintenance must be ENGAGED. This is the same gate the
//     perf container requires for its maintenance mode; operators who
//     forgot to create the file against a live box hit a 403 here BEFORE
//     any insert happens. The guard reads the file from disk on every
//     request (`_maintenanceState()`), so it is OS-level and independent
//     of any in-memory flag an attacker could flip.
//     v8.3.34 — it used to be its OWN `fs.statSync`, i.e. EXISTENCE, while
//     the traffic gate asked for the file's CONTENT. An empty sentinel
//     therefore satisfied THIS guard while the site kept serving the
//     public — and `touch` is precisely what the 403 below invites. One
//     predicate now, so the two can no longer disagree.
//   * Max 5000 users per call (matches /import cap).
//
// Duplicates (existing email or nickname) are silently skipped so a
// re-seed against the same DB doesn't error the whole batch — matches
// /api/register's 409-to-seed.js translation.
app.post("/api/admin/perf/bulk-seed-users", requireAdmin, requireSuperAdmin, csrfProtection, async (req, res) => {
  if (!_maintenanceState().active) return res.status(403).json({ error: "bulk-seed-users requires maintenance mode — create DATA_DIR/.maintenance with a bypass token first." });

  const { users, sharedPassword, competitionId } = req.body || {};
  // v8.13.3 (BTB-6) — the event id is BOUND (the enrolment INSERT, the audit row)
  // and is a Map key in the leaderboard-cache bust, so only a string may reach
  // them: an object was a 500 on the bind, and a ONE-element array was flattened
  // by better-sqlite3 and silently ACCEPTED (enrolled, audited as an array, cache
  // bust missed).
  if (competitionId != null && typeof competitionId !== "string")
    return res.status(400).json({ error: "competitionId must be text" });
  if (!Array.isArray(users) || users.length === 0)
    return res.status(400).json({ error: "users array required (non-empty)" });
  if (users.length > 5000)
    return res.status(400).json({ error: `Too many users (${users.length}). Maximum is 5000 per call.` });
  // `sharedPassword` is accepted and IGNORED (older perf tooling still sends it):
  // seeded rows get no password (`NO_PASSWORD_HASH`), so they sign in with
  // emailed codes.
  void sharedPassword;

  // Validate every row upfront — cheaper to fail the whole batch once
  // than to partially insert and leave half-seeded state.
  // v6.10.85 — optional `role` field per row; the allowed values are USER_ROLES,
  // never a list re-spelled here (v8.7.0). Lets the perf seeder create a
  // dedicated admin pool in the same maintenance-gated bulk call so the
  // perf scenarios can log in to distinct admin accounts instead of
  // thundering the shared superadmin login and tripping
  // single-session-per-user kills. No new endpoint needed.
  const _ALLOWED_ROLES = USER_ROLES; // v8.3.39 — one definition (see USER_ROLES)
  // v8.3.11 — NORMALISE BEFORE VALIDATING, so validation and storage see the same
  // bytes. `isValidEmailFormat` trims internally while the INSERT bound the RAW
  // value and the duplicate pre-scan lower-cased without trimming, so
  // `"  A@b.com  "` was accepted, stored verbatim, and invisible to every identity
  // lookup — all of which normalise. The visible symptom is an account that cannot
  // log in; the sharper one is a UNIQUENESS BYPASS, because `uq_users_email_nocase`
  // folds case and not whitespace, so the padded row does not reserve the address
  // against a later legitimate registration and two rows end up targeting one
  // mailbox (the class v7.15.6 closed). `nickname` has the identical defect and is
  // fixed here too: `_nicknameCharsOk` accepts a space, so `" bob "` seeded while
  // `GET /api/check-nickname` (which trims) reported `bob` available.
  //
  // This is routes/auth.js:126's rule at the site the v7.21.1 (A7) sweep missed:
  // validating a trimmed copy while storing the raw one is the same bug one layer
  // down.
  for (const u of users) {
    if (u && typeof u.email === "string") u.email = normaliseEmail(u.email);
    if (u && typeof u.nickname === "string") u.nickname = u.nickname.trim();
  }
  for (const [i, u] of users.entries()) {
    if (!u || typeof u !== "object")
      return res.status(400).json({ error: `users[${i}] not an object` });
    // v8.13.3 (BTB-6) — every profile field this row BINDS must be text.
    // firstName/lastName were only truthiness-checked and company…city went raw
    // into the INSERT (`_capsOk` skips a non-string), so an object or an array was
    // a 500 for the whole batch. `avatar` is listed too: sanitiseAvatar quietly
    // turned a non-string into the default, an accept-and-ignore this makes a 400.
    { const _ns = _firstNonStringField(u, ["firstName", "lastName", "company", "title", "country", "timezone", "job_function", "city", "avatar"]);
      if (_ns) return res.status(400).json({ error: `users[${i}]: ${_ns} must be text` }); }
    if (!u.email || !isValidEmailFormat(u.email))
      return res.status(400).json({ error: `users[${i}]: invalid email "${u.email}"` });
    if (!u.nickname || typeof u.nickname !== "string")
      return res.status(400).json({ error: `users[${i}]: nickname required` });
    if (!_nicknameCharsOk(u.nickname))
      return res.status(400).json({ error: `users[${i}]: ${NICKNAME_CHARSET_ERROR}` });
    if (!u.firstName || !u.lastName)
      return res.status(400).json({ error: `users[${i}]: firstName and lastName required` });
    // v8.7.0 — the message is DERIVED from the set it validates against. It was a
    // hand-written literal and went stale the moment `event_admin` joined
    // USER_ROLES: an error naming a smaller set than the code accepts sends the
    // reader hunting a bug in a value that is in fact allowed (FROZEN_REMEDY).
    if (u.role != null && !_ALLOWED_ROLES.has(u.role))
      return res.status(400).json({ error: `users[${i}]: role must be one of ${[..._ALLOWED_ROLES].join("|")}` });
    // ext-audit batch 3 (F2) — enforce the SAME per-field length caps as
    // register / import. Maintenance-mode only, but an oversized field would
    // otherwise land in a leaderboard/admin cell unbounded.
    const _bsCap = _capsOk({ first_name: u.firstName, last_name: u.lastName, nickname: u.nickname, company: u.company, title: u.title, job_function: u.job_function, city: u.city, secondary_email: u.secondary_email, linkedin_url: u.linkedin_url });
    if (_bsCap)
      return res.status(400).json({ error: `users[${i}]: ${_bsCap.field} must be at most ${_bsCap.max} characters.` });
    {
      // The perf seeder writes the same columns, so it obeys the same text rule.
      const ctl = profileTextControlField({ first_name: u.firstName, last_name: u.lastName, company: u.company, title: u.title, job_function: u.job_function, city: u.city, country: u.country });
      if (ctl) return res.status(400).json({ error: `users[${i}]: ${ctl} cannot contain control characters.`, code: "profile_text_control_chars", field: ctl });
    }
  }

  if (competitionId) {
    const comp = db.prepare("SELECT id FROM competitions WHERE id=?").get(competitionId);
    if (!comp) return res.status(400).json({ error: `event not found: ${competitionId}` });
  }

  // No password: the fixed non-bcrypt placeholder (lib/util NO_PASSWORD_HASH).
  const passwordHash = NO_PASSWORD_HASH;

  // v8.12.7 — test-only park before the commit-time re-check (lib/middleware.js).
  await testAdminCommitPark();
  // v8.12.7 (external audit F1, the same defect one route over) — THE ACTING
  // SUPERADMIN, re-asked at commit, at the SUPERADMIN tier. requireSuperAdmin
  // answered when the headers arrived and the hash above is a yield; MEASURED
  // before this, a superadmin demoted to plain admin inside it still seeded, and
  // a row asking for `role: "superadmin"` minted a verified SUPERADMIN account —
  // the v8.12.6 participant-import finding through a door that sweep did not
  // reach. The admin tier here would be exactly that hole. Everything from this
  // check to the batch transaction is synchronous (the duplicate pre-scan is
  // reads), so one check is atomic with the commit, and nothing has been written
  // yet. Maintenance mode ending during the hash is deliberately NOT re-asked:
  // the operator who ends it is the operator running the seed.
  {
    const _authz = adminAuthzDenied(req, { tier: "superadmin" });
    if (_authz) { const { status, ...body } = _authz; return res.status(status).json(body); }
  }
  const createdAt = now().toISOString();
  const adminId = getAdminIdentity(req);

  // Pre-scan for duplicate emails + nicknames in one batched query pair
  // (vs per-row UNIQUE-constraint trips which cost a transaction rollback).
  const lowerEmails = users.map(u => u.email.toLowerCase());
  const emailPlaceholders = "SELECT value FROM json_each(?)";
  const existingEmailRows = db.prepare(
    `SELECT LOWER(email) as e FROM users WHERE email COLLATE NOCASE IN (${emailPlaceholders})
     UNION ALL
     SELECT LOWER(secondary_email) as e FROM users WHERE secondary_email COLLATE NOCASE IN (${emailPlaceholders})`
  ).all(JSON.stringify(lowerEmails), JSON.stringify(lowerEmails));
  const takenEmails = new Set(existingEmailRows.map(r => r.e).filter(Boolean));
  // v6.13.9 Fix 2 — the collation goes on the LEFT operand: `nickname
  // COLLATE NOCASE IN (…)` compares every value in the list without case,
  // and searches uq_users_nickname_nocase (the email lookups here search
  // their NOCASE indexes the same way). A collation trailing the list
  // (`nickname IN (…) COLLATE NOCASE`), or none (the column is BINARY),
  // compares by case: an existing "ALICE" was missed when the payload said
  // "alice", the insert then tripped the NOCASE unique index and the whole
  // batch aborted instead of skipping the duplicate. `LOWER(x) = …` folds
  // too but no index serves it: every call read the whole users table.
  const nicksLower = users.map(u => u.nickname.toLowerCase());
  const nickPlaceholders = "SELECT value FROM json_each(?)";
  const existingNickRows = db.prepare(
    `SELECT LOWER(nickname) as n FROM users WHERE nickname COLLATE NOCASE IN (${nickPlaceholders})`
  ).all(JSON.stringify(nicksLower));
  const takenNicks = new Set(existingNickRows.map(r => r.n));

  const insertUser = db.prepare(
    `INSERT INTO users (
       id, first_name, last_name, nickname, company, title, email,
       secondary_email, avatar, verify_code, verify_code_at,
       verified, approved, approved_at, approved_by, password_hash,
       country, timezone, job_function, city, created_at, role
     ) VALUES (?,?,?,?,?,?,?, NULL, ?, NULL, NULL, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertCU = competitionId
    ? db.prepare("INSERT OR IGNORE INTO competition_users (competition_id, user_id, assigned_by, assigned_at) VALUES (?,?,?,?)")
    : null;

  // v6.13.9 Fix 3 — resolve existing-user ids up-front so the bulk
  // transaction can enroll SKIPPED users into the current competition
  // alongside freshly-inserted ones. Pre-fix, bulk-seed skipped the
  // user entirely (no competition_users insert), so a second seed
  // against the same DB left the existing users orphaned relative to
  // the new competition — seed-data.json's participantCount would
  // count them by email-prefix match but VUs would fail to interact
  // with the new competition because their competition_users row
  // (if any) still pointed at a prior run's competition id.
  // One keyed lookup per skipped row is cheap — it's still the same
  // single transaction, one SELECT per skip vs. the original zero.
  const idByEmailLower = new Map();
  if (competitionId) {
    const existingIdRows = db.prepare(
      `SELECT id, LOWER(email) as e FROM users WHERE email COLLATE NOCASE IN (${emailPlaceholders})`
    ).all(JSON.stringify(lowerEmails));
    for (const r of existingIdRows) idByEmailLower.set(r.e, r.id);
  }

  let inserted = 0, skipped = 0, enrolledExisting = 0;
  const bulkTxn = db.transaction(() => {
    for (const u of users) {
      const emailLower = u.email.toLowerCase();
      const nickLower = u.nickname.toLowerCase();
      if (takenEmails.has(emailLower) || takenNicks.has(nickLower)) {
        skipped++;
        // v6.13.9 Fix 3 — enroll existing users in the caller's
        // competition too. INSERT OR IGNORE is a no-op for users
        // already enrolled, so idempotent rerun is safe; for users
        // who exist but are enrolled in a DIFFERENT competition (the
        // typical re-seed pattern: fresh competitionId, existing
        // perf-user-NNN rows), this fills the gap that broke the
        // post-rerun seed-data.json / competition membership
        // contract. Only attempted when the caller passed a
        // competitionId — admin-only seeds (no comp) keep the
        // pre-fix behaviour.
        if (insertCU) {
          const existingId = idByEmailLower.get(emailLower);
          if (existingId) {
            const r = insertCU.run(competitionId, existingId, adminId, createdAt);
            if (r.changes) enrolledExisting++;
          }
        }
        continue;
      }
      const uid = uuid();
      const role = u.role || "participant";
      insertUser.run(
        uid, u.firstName, u.lastName, u.nickname,
        u.company || null, u.title || null, u.email,
        sanitiseAvatar(u.avatar) || "default1",
        createdAt, adminId, passwordHash,
        u.country || null, u.timezone || null,
        u.job_function || null, u.city || null,
        createdAt, role
      );
      if (insertCU) insertCU.run(competitionId, uid, adminId, createdAt);
      // Track in the in-batch sets so duplicates WITHIN the same request
      // are also caught (two users in the same array with the same
      // nickname would otherwise both try to INSERT).
      takenEmails.add(emailLower); takenNicks.add(nickLower);
      inserted++;
    }
  });
  // v6.16.17 — defensive runTxnWithMirrorBuffer wrap. The bulkTxn
  // currently makes no `recordUserEvent` calls so the v6.16.9 mirror-
  // buffer leak class doesn't apply today. Pre-emptive wrap: if a
  // future patch adds an audit call to the loop body, the wrapper
  // is already in place — the v6.16.9 ghost-mirror-line bug can't
  // silently regress here.
  runTxnWithMirrorBuffer(() => bulkTxn());

  // v6.16.39 — batch-summary audit row. Pre-fix the perf-only seed
  // of up to 5000 users (+ optional competition_users enrolment) ran
  // with no audit attribution at all. Maintenance-gated, but it's
  // still mass user creation that should leave a forensic anchor for
  // who ran which seed batch + when. One row per call (the per-row
  // user_events would dwarf the batch shape; the summary is what an
  // operator actually needs to reconstruct).
  try {
    recordOrphanedAuditEvent("perf-seed", competitionId || "bulk", "users_seeded", adminId, {
      total: users.length,
      inserted,
      skipped,
      enrolled_existing: enrolledExisting,
      competition_id: competitionId || null,
      ...reqContext(req),
    });
  } catch (_err) { /* never let audit logging block the response */ swallowed("server:export-audit", _err); }

  // Invalidate caches once at the end.
  invalidateAdminParticipantsCache();
  if (competitionId) invalidateLeaderboardCache(competitionId);
  _invalidateMeCache();

  res.json({ inserted, skipped, total: users.length, enrolled_existing: enrolledExisting });
});

// ── Perf-only bulk-seed-history ────────────────────────────────────────────
// v7.2.x — high-throughput historical-competition seeding for perf tests.
// `bulk-seed-users` makes the user table production-sized; this makes the
// HISTORY tables (submissions / hint_reveals / challenge_events /
// competition_events / competition_users + the competitions list) production-
// sized too, so the admin polling reads (Submissions, Analytics, per-comp
// Events, the competition list, leaderboard) are benchmarked against a
// populated DB instead of the near-empty tables a fresh seed leaves behind.
//
// For each of `competitions` rows it creates one ENDED competition (past
// start + ended_at), assigns a random `tasksPer` subset of the supplied
// published `taskIds` pool, samples `participantsPer` distinct existing
// participants, and writes — directly, mirroring the exact row shapes the
// live submit / hint paths produce — a correct submission for every
// (participant, task) plus a configurable fraction of preceding wrong
// attempts, hint reveals and navigated-away events. Every write is a plain
// INSERT (no answer grading, no bcrypt, no per-row HTTP) so ~1M rows land in
// a few seconds.
//
// Safety gates are identical to bulk-seed-users (requireAdmin +
// requireSuperAdmin + csrfProtection + DATA_DIR/.maintenance must exist), so
// this can never run against a live box. One transaction PER competition
// bounds the WAL growth and lets a partial failure leave whole prior comps
// committed.
app.post("/api/admin/perf/bulk-seed-history", requireAdmin, requireSuperAdmin, csrfProtection, (req, res) => {
  if (!_maintenanceState().active) return res.status(403).json({ error: "bulk-seed-history requires maintenance mode — create DATA_DIR/.maintenance with a bypass token first." });

  const body = req.body || {};
  const competitions = parseInt(body.competitions);
  const participantsPer = parseInt(body.participantsPer);
  const tasksPer = parseInt(body.tasksPer);
  const taskIds = Array.isArray(body.taskIds) ? body.taskIds.filter(x => typeof x === "string" && x) : [];
  const namePrefix = (typeof body.namePrefix === "string" && body.namePrefix.trim())
    ? body.namePrefix.trim().slice(0, 80) : "Perf History";
  const participantEmailPrefix = typeof body.participantEmailPrefix === "string" ? body.participantEmailPrefix : "";
  const spreadDays = Math.max(1, Math.min(3650, parseInt(body.spreadDays) || 180));
  const durationMinutes = Math.max(1, Math.min(1440, parseInt(body.durationMinutes) || 60));
  const clamp01 = (v, dflt) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : dflt);
  const wrongRate = clamp01(body.wrongRate, 0.25);
  const hintRate = clamp01(body.hintRate, 0.15);
  const navAwayRate = clamp01(body.navAwayRate, 0.05);
  const writeCompetitionEvents = body.competitionEvents !== false; // default ON (faithful to live submit path)

  // Validation + caps.
  if (!Number.isInteger(competitions) || competitions < 1 || competitions > 500)
    return res.status(400).json({ error: "competitions must be an integer in [1, 500]" });
  if (!Number.isInteger(participantsPer) || participantsPer < 1 || participantsPer > 2000)
    return res.status(400).json({ error: "participantsPer must be an integer in [1, 2000]" });
  if (!Number.isInteger(tasksPer) || tasksPer < 1 || tasksPer > 100)
    return res.status(400).json({ error: "tasksPer must be an integer in [1, 100]" });
  if (taskIds.length === 0)
    return res.status(400).json({ error: "taskIds array required (non-empty)" });

  // Work-unit cap — guards against an accidental runaway seed (e.g. a fat-
  // fingered 500 × 2000 × 100). The dominant cost scales with this product.
  const effTasksPerPlanned = Math.min(tasksPer, taskIds.length);
  const workUnits = competitions * participantsPer * effTasksPerPlanned;
  const WORK_CAP = 4_000_000;
  if (workUnits > WORK_CAP)
    return res.status(400).json({ error: `Requested ${workUnits} (competitions×participantsPer×tasksPer) work units exceeds the ${WORK_CAP} cap. Lower one of the three.` });

  // Resolve the task pool (difficulty drives the points written).
  const taskPlaceholders = "SELECT value FROM json_each(?)";
  const taskRows = db.prepare(
    `SELECT id, difficulty FROM tasks WHERE id IN (${taskPlaceholders})`
  ).all(JSON.stringify(taskIds));
  if (taskRows.length === 0)
    return res.status(400).json({ error: "none of the supplied taskIds resolved to a task" });
  const effectiveTasksPer = Math.min(tasksPer, taskRows.length);

  // Resolve the candidate participant pool (sampled fresh per competition).
  // Gate on `approved=1` too — the leaderboard build + auto-end scan both
  // require verified=1 AND approved=1, so a seeded UNapproved participant's
  // solve rows would be silently dropped by those readers' own SQL gate and
  // never surface in the very leaderboard the seed exists to populate.
  // (staff/benchmark-tagged users are still admitted; the read side filters
  // them out, but excluding them here would need a per-id tag lookup — not
  // worth it for a perf seed, and the bg-user- pool carries no such tags.)
  const POOL_CAP = 50_000;
  let candidateRows;
  if (participantEmailPrefix) {
    const likePrefix = participantEmailPrefix.toLowerCase().replace(/[%_\\]/g, "\\$&") + "%";
    candidateRows = db.prepare(
      `SELECT id FROM users WHERE role='participant' AND verified=1 AND approved=1 AND LOWER(email) LIKE ? ESCAPE '\\' LIMIT ?`
    ).all(likePrefix, POOL_CAP);
  } else {
    candidateRows = db.prepare(
      `SELECT id FROM users WHERE role='participant' AND verified=1 AND approved=1 LIMIT ?`
    ).all(POOL_CAP);
  }
  const candidateIds = candidateRows.map(r => r.id);
  if (candidateIds.length === 0)
    return res.status(400).json({ error: `no candidate participants found (role=participant, verified=1, approved=1${participantEmailPrefix ? `, email LIKE "${participantEmailPrefix}%"` : ""})` });
  const effectiveParticipantsPer = Math.min(participantsPer, candidateIds.length);

  const adminId = getAdminIdentity(req);
  const nowMs = now().getTime();
  const DAY_MS = 86_400_000;

  // Prepared statements reused across the whole seed.
  const insComp = db.prepare("INSERT INTO competitions (id, name, start_time, duration_minutes, ended_at, ended_manually, leaderboard_mode, created_at) VALUES (?,?,?,?,?,0,'global',?)");
  const insCompTask = db.prepare("INSERT OR IGNORE INTO competition_tasks (competition_id, task_id, task_number, assigned_by, assigned_at) VALUES (?,?,?,?,?)");
  const insCU = db.prepare("INSERT OR IGNORE INTO competition_users (competition_id, user_id, login_time, last_login_time, ended_popup_seen, assigned_by, assigned_at, direct_assigned) VALUES (?,?,?,?,1,?,?,1)");
  const insSub = db.prepare("INSERT INTO submissions (id,user_id,task_id,answer,is_correct,points_delta,submitted_at,competition_id,timeslot_id,updated_at) VALUES (?,?,?,?,?,?,?,?,NULL,?)");
  const insHint = db.prepare("INSERT OR IGNORE INTO hint_reveals (competition_id, user_id, task_id, points_deducted, revealed_at, timeslot_id, updated_at) VALUES (?,?,?,?,?,NULL,?)");
  const insChEv = db.prepare("INSERT INTO challenge_events (id, user_id, task_id, competition_id, timeslot_id, event_type, details, occurred_at) VALUES (?,?,?,?,NULL,?,?,?)");
  const insCompEv = db.prepare("INSERT INTO competition_events (id, competition_id, event_type, changed_by, changed_at, details) VALUES (?,?,?,?,?,?)");

  let compCount = 0, cuCount = 0, subCount = 0, hintCount = 0, chEvCount = 0, compEvCount = 0;

  // Partial Fisher-Yates: sample `n` distinct entries from an index pool,
  // re-randomising the leading n positions each call (uniform per call).
  const userIdx = candidateIds.map((_, i) => i);
  const taskIdx = taskRows.map((_, i) => i);
  function sampleFrom(idxArr, src, n) {
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(Math.random() * (idxArr.length - i));
      const t = idxArr[i]; idxArr[i] = idxArr[j]; idxArr[j] = t;
    }
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = src[idxArr[i]];
    return out;
  }

  const seedComp = db.transaction((compIdx) => {
    const compId = uuid();
    // Spread comp starts backwards over [now - spreadDays, now - 1 day],
    // newest first so the competition list's default DESC ordering shows a
    // realistic recent-to-old gradient.
    const ageDays = competitions <= 1
      ? 1
      : 1 + ((spreadDays - 1) * compIdx) / (competitions - 1);
    const startMs = nowMs - ageDays * DAY_MS;
    const startIso = new Date(startMs).toISOString();
    const endMs = scheduledEnd({ start_time: new Date(startMs).toISOString(), duration_minutes: durationMinutes }).getTime();
    const endedIso = new Date(endMs).toISOString();
    const compName = `${namePrefix} ${String(compIdx + 1).padStart(3, "0")}`;
    insComp.run(compId, compName, startIso, durationMinutes, endedIso, startIso);
    compCount++;

    // Each event holds its OWN copy of the sampled questions (lib/event-copies.js),
    // as every assign door now makes it; the history rows below name the copy.
    const compTasks = sampleFrom(taskIdx, taskRows, effectiveTasksPer)
      .map(t => ({ ...t, id: require("./lib/event-copies").copyTaskIntoEvent(db, t.id, compId, { changedBy: "perf-seed", via: "perf_seed", nowIso: startIso }) }));
    let tn = 1;
    for (const t of compTasks) insCompTask.run(compId, t.id, String(tn++), adminId, startIso);

    const users = sampleFrom(userIdx, candidateIds, effectiveParticipantsPer);
    const windowMs = Math.max(1, endMs - startMs);
    for (const uid of users) {
      insCU.run(compId, uid, startIso, startIso, "perf-seed", startIso);
      cuCount++;
      for (const t of compTasks) {
        const pts = POINTS[t.difficulty] != null ? POINTS[t.difficulty] : POINTS.easy;
        const correctOffset = Math.floor(windowMs * (0.2 + Math.random() * 0.75));
        const correctMs = startMs + correctOffset;

        // Optional hint reveal (earliest event in the per-task timeline).
        if (Math.random() < hintRate) {
          const hintMs = startMs + Math.floor(correctOffset * Math.random() * 0.5);
          const hIso = new Date(hintMs).toISOString();
          const deduction = Math.round(pts * HINT_DEDUCTION_RATE);
          const r = insHint.run(compId, uid, t.id, deduction, hIso, hIso);
          if (r.changes) hintCount++;
          insChEv.run(uuid(), uid, t.id, compId, "hint_revealed", JSON.stringify({ points_deducted: deduction }), hIso);
          chEvCount++;
          if (writeCompetitionEvents) {
            insCompEv.run(uuid(), compId, "hint_revealed", "perf-seed", hIso, JSON.stringify({ user_id: uid, task_id: t.id, points_deducted: deduction }));
            compEvCount++;
          }
        }

        // Optional wrong attempt before the correct one.
        if (Math.random() < wrongRate) {
          const wrongMs = startMs + Math.floor(correctOffset * (0.5 + Math.random() * 0.4));
          const wIso = new Date(wrongMs).toISOString();
          insSub.run(uuid(), uid, t.id, "perf-wrong-answer", 0, -PENALTY, wIso, compId, wIso);
          subCount++;
          insChEv.run(uuid(), uid, t.id, compId, "incorrect", JSON.stringify({ points_delta: -PENALTY, answer_length: 17, attempt_number: 1 }), wIso);
          chEvCount++;
          if (writeCompetitionEvents) {
            insCompEv.run(uuid(), compId, "submission_wrong", "perf-seed", wIso, JSON.stringify({ user_id: uid, task_id: t.id, correct: false, points_delta: -PENALTY }));
            compEvCount++;
          }
        }

        // Occasional navigated-away (analytics 4th bucket).
        if (Math.random() < navAwayRate) {
          const naMs = startMs + Math.floor(correctOffset * Math.random() * 0.9);
          insChEv.run(uuid(), uid, t.id, compId, "navigated_away", null, new Date(naMs).toISOString());
          chEvCount++;
        }

        // The winning correct submission (every participant solves every task).
        const cIso = new Date(correctMs).toISOString();
        insSub.run(uuid(), uid, t.id, `perf-history-${t.id.slice(0, 8)}`, 1, pts, cIso, compId, cIso);
        subCount++;
        insChEv.run(uuid(), uid, t.id, compId, "solved", JSON.stringify({ points_delta: pts, answer_length: 14, attempt_number: 1 }), cIso);
        chEvCount++;
        if (writeCompetitionEvents) {
          insCompEv.run(uuid(), compId, "submission_correct", "perf-seed", cIso, JSON.stringify({ user_id: uid, task_id: t.id, correct: true, points_delta: pts }));
          compEvCount++;
        }
      }
    }

    // Lifecycle events bracket the per-submission rows.
    if (writeCompetitionEvents) {
      insCompEv.run(uuid(), compId, "created", "perf-seed", startIso, JSON.stringify({ name: compName, seeded: true }));
      insCompEv.run(uuid(), compId, "auto_ended", "perf-seed", endedIso, JSON.stringify({ reason: "all_participants_solved_all", seeded: true }));
      compEvCount += 2;
    }
  });

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < competitions; i++) seedComp(i);
  const elapsedMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);

  // Audit summary — one forensic anchor for the whole batch, mirroring the
  // bulk-seed-users summary row (per-row events would dwarf the shape).
  try {
    recordOrphanedAuditEvent("perf-seed", "history", "history_seeded", adminId, {
      competitions: compCount,
      participants_per: effectiveParticipantsPer,
      tasks_per: effectiveTasksPer,
      submissions: subCount,
      hint_reveals: hintCount,
      challenge_events: chEvCount,
      competition_events: compEvCount,
      candidate_pool: candidateIds.length,
      ...reqContext(req),
    });
  } catch (_err) { /* never let audit logging block the response */ swallowed("server:export-audit", _err); }

  // These competitions are brand-new ids, so no leaderboard-cache entry can
  // exist for them yet — nothing to invalidate there. The admin participants
  // cache CAN now be stale (new competition_users rows change membership
  // counts), so bust it once at the end.
  invalidateAdminParticipantsCache();

  res.json({
    competitions_created: compCount,
    participants_per: effectiveParticipantsPer,
    tasks_per: effectiveTasksPer,
    competition_users: cuCount,
    submissions: subCount,
    hint_reveals: hintCount,
    challenge_events: chEvCount,
    competition_events: compEvCount,
    candidate_pool: candidateIds.length,
    elapsed_ms: elapsedMs,
  });
});

// ── Admin submissions ───────────────────────────────────────────────────────

app.get("/api/admin/submissions", requireAdmin, (req, res) => {
  // v6.12.14 — perf-span instrumentation. Per-route CSV showed this
  // endpoint's p95 creeping 2.4 → 30 ms over a 3h sustained run (p50
  // tracked it 2 → 23 ms, so the whole distribution shifted, not just
  // the tail). Without per-stage timing we can't tell which of the
  // four reads (snapshot anchor, events, count, max_mutation_at)
  // dominates under DB growth. Log fires when total_ms >
  // PERF_SPAN_SLOW_MS; the four stage durations are captured inside
  // the deferred transaction closure and read out for logging below.
  const tHandler = process.hrtime.bigint();
  // Paginated (v6.3.0): pre-fix this endpoint returned the entire submissions
  // + hint_reveals UNION for the filter — for a 200-participant / 300-task
  // event that's hundreds of thousands of rows and tens of MB of JSON per
  // admin refresh. With admins polling at 15-30s, the endpoint was the single
  // biggest bandwidth + JSON-serialise cost on the dashboard. Now capped at
  // `limit` (default 100, max 500) with `offset` for paging. The UI's default
  // page size is 100; back-compat for pre-v6.3.0 clients that omitted the
  // params is preserved — they get 100 most-recent events instead of the
  // full dump.
  const competitionId = req.query.competitionId;
  const timeslotId = req.query.timeslotId;
  // v8.7.0 — a NAMED event is refused, never silently narrowed. Narrowing an
  // out-of-scope competitionId to nothing renders as "this event has no
  // submissions", which an organiser cannot tell apart from a genuinely quiet
  // event; the 403 says which it is. A bare timeslotId with no competitionId
  // needs no check of its own — the scope branches below ignore it entirely.
  const _subDenied = competitionId ? competitionDenied(req, competitionId) : null;
  if (_subDenied) return res.status(403).json({ error: _subDenied.message, code: _subDenied.code });
  // v8.13.3 (UNK-1) — a named event that does not exist is a 404, not "no
  // submissions yet": that is a claim about an event, and there is none. After
  // the scope refusal, so an event admin cannot use the difference to learn
  // which ids exist (routes/participants.js and the admin task list agree).
  if (competitionId && !getCompetition(competitionId)) return res.status(404).json({ error: "Event not found" });
  // v8.10.0 — the sealed answer. A submitted answer to a sealed challenge is the
  // key by construction for `text` / `json` / `file` / `choice` (a CORRECT
  // submission IS the accepted value) and is the only secret there is for `any`,
  // so it is withheld from everyone but the challenge's author. `null` for the
  // built-in superadmin, which authors nothing — `IS NOT ?` against NULL is then
  // true for every row, so it fails closed.
  // v8.12.1 — THE HUMAN, NOT THE SEAT (`actingAdminId`): under an impersonated
  // admin view `req.session.userId` is the ORGANISER, so keying on it showed a
  // superadmin in that panel every answer submitted to the organiser's sealed
  // challenges — and the `?q=` LIKE below would have confirmed a guessed key
  // through the count. This was the one seal site the v8.12.1 sweep missed (it
  // is inline here rather than in routes/challenges.js), found by the
  // pre-release review; `actingAdminId` is null for the built-in, so the
  // fail-closed shape above is kept.
  // v8.12.2 — THE SUPERADMIN'S REVEALS reach this stream too: a revealed
  // challenge's submitted answers read as they do for the author, in the
  // projection AND in the `?q=` LIKE (the search oracle the projection alone
  // does not close). Resolved once per request, and NARROWED to challenges the
  // acting human does not compete in — a reveal is refused to a competitor at
  // reveal time, and a row that appeared later must not widen it here, because
  // rivals' answers to a compete event's challenge are the one thing that
  // stream must never show a competitor. Empty for anyone who is not a
  // superadmin right now (the live role read inside `sealRevealSet`).
  // The rule lives once, in lib/answer-seal.js `submissionAnswerProjection`,
  // shared with the Audit page (routes/audit.js) so the two streams agree.
  const _subProj = submissionAnswerProjection(req);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  // v8.13.3 (OC-1) — clamped ABOVE as well as below. `Math.max(0, parseInt(…))`
  // floored and nothing capped, so an offset past int64 (a 19-digit
  // ?offset=9300000000000000000, or a ~309-digit string, which parseInt reads as
  // Infinity — not ?offset=1e20, which parseInt stops at the "e" and reads as 1)
  // reached BOTH the materialised path's
  // `LIMIT ? OFFSET ?` and the fast path's inner `LIMIT offset+limit`, and
  // better-sqlite3 binds a number as an INTEGER only inside int64: SQLITE_MISMATCH,
  // a generic 500 and an error-level stack line per request. The clamped value is
  // past the end, i.e. the empty page any over-range offset already returns.
  const offset = clampPagingIndex(req.query.offset);
  // v6.3.3: optional substring filter. The Submissions tab UI previously
  // scoped its search to the 500-row client slice — no way to reach older
  // matches without narrowing by competition first. Pushing the filter to
  // SQL means the UI's search box and paginator together cover the full
  // event stream.
  const q = (req.query.q || "").toString().trim().toLowerCase();
  // v7.21.16 (long-list phase 5) — SERVER-SIDE SORT.
  //
  // The client has always sorted, but only the rows of the page it happened to
  // be holding, and it said so ("Sorted within this page"). That is honest and
  // still useless for the job an admin actually has: "show me the biggest point
  // swings" or "show me every wrong answer", across a whole event.
  //
  // WHY THIS IS NOT JUST AN ORDER BY PARAMETER. The default read is a
  // branch-capped walk: each of the two UNION branches takes its newest
  // (offset+limit) rows off its own descending index and the outer query sorts
  // the <=2N result. That is correct ONLY under the event_time ordering — the
  // union of the two newest-N sets contains the true global newest-N, but it
  // does NOT contain the true global highest-N-by-points. So a non-default sort
  // has to materialise the filtered set first, exactly as the search path
  // already does, and sort that. Reusing that path IS the implementation; the
  // fast path is untouched and still serves every poll, because a poll does not
  // sort — which is what keeps the 15-30 s dashboard refresh cheap.
  const SUB_SORTS = {
    time:        "event_time",
    participant: "LOWER(COALESCE(nickname,''))",
    competition: "LOWER(COALESCE(competition_name,''))",
    session:     "LOWER(COALESCE(timeslot_name,''))",
    task:        "LOWER(COALESCE(task_title,''))",
    // Mirrors what the cell RENDERS (correct / hint / wrong). Sorting on the raw
    // is_correct column would scatter hints, whose is_correct is NULL.
    event:       "CASE WHEN event_type='hint' THEN 'hint' WHEN is_correct=1 THEN 'correct' ELSE 'wrong' END",
    points:      "points_delta",
  };
  const sortKeyRaw = (req.query.sort || "").toString().trim();
  const sortKey = Object.prototype.hasOwnProperty.call(SUB_SORTS, sortKeyRaw) ? sortKeyRaw : null;
  const sortDir = (req.query.dir || "").toString().trim().toLowerCase() === "asc" ? "ASC" : "DESC";
  // `time` DESC is the default ordering, so asking for it explicitly must not
  // cost the fast path. Only a genuinely different ordering forces the full one.
  const sortIsDefault = !sortKey || (sortKey === "time" && sortDir === "DESC");
  // The deterministic tail is NOT optional (v6.10.54): without a total order,
  // rows sharing a sort key swap page boundaries between two fetches and the
  // table drops or duplicates rows as the admin pages through.
  const orderBySql = sortIsDefault
    ? "ORDER BY event_time DESC, tie_key DESC"
    : `ORDER BY ${SUB_SORTS[sortKey]} ${sortDir}, event_time DESC, tie_key DESC`;
  // v6.10.72 — `snapshot_before` drift-free pagination token. Mirrors
  // the shape added for event endpoints in v6.10.64: first page
  // returns the newest `event_time` in the response; the client echoes
  // it on every subsequent page; the server AND-clauses it onto the
  // UNION branches so submissions / hint_reveals inserted during the
  // operator's walk never shift OFFSET positions. Both underlying
  // tables are insert-only (submissions never UPDATE; hint_reveals
  // never UPDATE) so the snapshot gives a completely drift-free
  // multi-page view. event_time is an ISO-8601 string across both
  // branches, so lexical `<=` compare tracks insertion order.
  const snapshotBeforeRaw = typeof req.query.snapshot_before === "string"
    ? req.query.snapshot_before.trim() : "";
  const snapshotBefore = snapshotBeforeRaw || null;
  // v6.13.9 Fix 1 — row-stable snapshot tie-breaker. Same-millisecond
  // inserts between page fetches can otherwise shift offsets: the
  // pre-v6.13.9 `event_time <= snapshot` filter admits rows with the
  // same event_time as the anchor, so a new row inserted at exactly
  // the anchor's timestamp can slot into the top-N and bump a
  // page-1 row into page 2's OFFSET window. The fix pins the anchor
  // to (event_time, tie_key) as a lexicographic pair: filter admits
  // rows with (event_time < snap) OR (event_time = snap AND tie_key
  // <= snap_tie). Under the (event_time DESC, tie_key DESC) sort
  // that's the set of rows at or after the anchor in the total
  // order — exactly what pagination needs to stay row-stable under
  // bursty writes. snapshot_tie is echoed the same way as
  // snapshot_before: first page derives it from the top row of the
  // result set, subsequent pages echo it back.
  const snapshotTieRaw = typeof req.query.snapshot_tie === "string"
    ? req.query.snapshot_tie.trim() : "";
  const snapshotTie = snapshotTieRaw || null;
  // v6.10.54 — `tie_key` column projected into both UNION branches so
  // the outer ORDER BY has a deterministic secondary sort. Without it,
  // same-event_time rows could swap page boundaries between two
  // fetches, making the Submissions tab drop or duplicate rows on
  // next-page navigation under concurrent submit / reveal traffic.
  // submissions.id is a UUID; hint_reveals has a composite PK so we
  // compose user_id||task_id — both are UTF-8 strings and sort
  // deterministically via SQLite's BINARY collation.
  const SUB_SELECT = `
    SELECT 'submission' as event_type, s.submitted_at as event_time, s.id as tie_key,
      u.nickname, t.title as task_title,
      s.answer, s.is_correct, s.points_delta, c.name as competition_name, ts.name as timeslot_name,
      t.answer_sealed as _sealed, t.created_by_id as _author, t.id as _task_id
    FROM submissions s JOIN users u ON u.id=s.user_id JOIN tasks t ON t.id=s.task_id
      LEFT JOIN competitions c ON c.id=s.competition_id
      LEFT JOIN competition_timeslots ts ON ts.id=s.timeslot_id`;
  const HINT_SELECT = `
    SELECT 'hint' as event_type, h.revealed_at as event_time,
      (h.user_id || '|' || h.task_id) as tie_key,
      u.nickname, t.title as task_title,
      NULL as answer, NULL as is_correct, -h.points_deducted as points_delta, c.name as competition_name, ts.name as timeslot_name,
      t.answer_sealed as _sealed, t.created_by_id as _author, t.id as _task_id
    FROM hint_reveals h JOIN users u ON u.id=h.user_id JOIN tasks t ON t.id=h.task_id
      LEFT JOIN competitions c ON c.id=h.competition_id
      LEFT JOIN competition_timeslots ts ON ts.id=h.timeslot_id`;
  let subWhere, hintWhere, scopeParams;
  if (competitionId && timeslotId) {
    subWhere  = "WHERE s.competition_id=? AND s.timeslot_id=?";
    hintWhere = "WHERE h.competition_id=? AND h.timeslot_id=?";
    scopeParams = [competitionId, timeslotId];
  } else if (competitionId) {
    subWhere  = "WHERE s.competition_id=?";
    hintWhere = "WHERE h.competition_id=?";
    scopeParams = [competitionId];
  } else {
    subWhere  = "";
    hintWhere = "";
    scopeParams = [];
  }
  // v8.7.0 — EVENT-ADMIN SCOPE, spliced into EVERY branch including the empty
  // one. That empty branch IS the point: with no competitionId this is the
  // platform-wide read, so an event admin left unfiltered there sees every
  // submission on the platform. `scopeFilterSql` yields "" for an unscoped
  // actor, so admin / superadmin get byte-identical SQL and the old parameters.
  //
  // THE PARAMETER ORDER IS LOAD-BEARING. A UNION binds positionally, and every
  // statement below binds this one shared `scopeParams` array — grep it rather
  // than trusting a count here. The two clauses therefore differ ONLY in the
  // column alias and must contribute the same placeholders in the same order —
  // hence a single push, after the competition/timeslot parameters and before
  // any snapshot ones.
  const _subScope  = scopeFilterSql(req, "s.competition_id");
  const _hintScope = scopeFilterSql(req, "h.competition_id");
  // The fragment starts " AND ", for splicing into an existing WHERE; a branch
  // that has no WHERE of its own needs the keyword supplied instead.
  const _spliceScope = (where, clause) =>
    !clause ? where : (where ? `${where}${clause}` : `WHERE ${clause.slice(5)}`);
  subWhere  = _spliceScope(subWhere,  _subScope.clause);
  hintWhere = _spliceScope(hintWhere, _hintScope.clause);
  scopeParams = [...scopeParams, ..._subScope.params];

  // Search runs as an outer WHERE on the UNION — the union shape already
  // aliases nickname / task_title / answer / competition_name / timeslot_name
  // consistently, so one outer filter covers both event types. Match
  // order mirrors the pre-v6.3.3 client filter so a user searching "hint"
  // still lands on hint rows via event_type.
  const hasQ = q.length > 0;
  // Escape SQL LIKE wildcards so a literal search for "a_b" or "100%"
  // matches the exact characters instead of treating _ and % as single-
  // char / any-string wildcards. The ESCAPE clause tells SQLite which
  // character is our escape prefix.
  const _qEsc = q.replace(/[%_\\]/g, "\\$&");
  const like = `%${_qEsc}%`;
  // v6.10.72 — outer-WHERE assembly as composable fragments so the
  // search filter and the snapshot_before filter can coexist.
  // event_time is projected by both union branches (SUB_SELECT /
  // HINT_SELECT), so a single outer `event_time <= ?` clause covers
  // both at once without threading the filter into each branch's
  // inner subWhere.
  // v6.10.78 — derive the snapshot anchor FIRST when the client didn't
  // echo one (first page). The anchor is the MAX(event_time) across
  // the union's scope; we then apply `event_time <= snapshot_before`
  // to BOTH the count and the select so the reported total is scoped
  // to the same snapshot the subsequent pages will see. Pre-fix the
  // count ran unfiltered and the snapshot was derived from events[0]
  // AFTER the select, which meant page 1's total counted events newer
  // than its own anchor — page 2 with snapshot filter would reach a
  // smaller effective total and "Load more" could show a page count
  // the client couldn't actually page through. Computing the anchor
  // upfront unifies the count's scope with what every subsequent page
  // sees.
  // v6.12.12 — wrap the four reads (snapshot anchor, events, total,
  // max_mutation_at) in a single deferred transaction. SQLite's WAL
  // snapshot isolation then guarantees all four statements observe the
  // same database state, even if a recalc / delete / insert commits
  // mid-handler from another connection. Under the project's single-
  // process invariant (CLAUDE.md) this was already implicitly true
  // because the sync handler body can't be interrupted by the event
  // loop, but wrapping it in a read tx formalises the invariant so it
  // survives (a) a future async refactor that slips an `await` into the
  // handler and opens a yield point, and (b) an accidental multi-process
  // deployment that gets past the v6.8.5 cluster boot check (another
  // process's writer could previously commit between Q2 and Q4 and
  // leave visible rows internally inconsistent with total /
  // max_mutation_at). `.deferred()` spells out better-sqlite3's DEFAULT —
  // a plain `db.transaction(fn)()` is already a DEFERRED BEGIN, NOT a write
  // lock — and it is pinned (functional-core-a) so this call never becomes
  // `.immediate()` / `.exclusive()`, which WOULD take the write (RESERVED)
  // lock at BEGIN — so a pure read would wait on, or fail behind, any
  // external writer, and hold one off while it ran. (Concurrent admins in
  // THIS process never contend either way: the handler is synchronous.) A
  // body that only reads never takes the write lock at all. Cost: zero —
  // deferred BEGIN in WAL mode acquires no
  // OS-level lock and performs no disk I/O; the only effective change
  // is that the four statements share one WAL snapshot rather than
  // re-reading the WAL-index header per statement.
  let tSnapshot, tEvents, tCount, tMutMax;
  const { events, total, effectiveSnapshot, effectiveTie, maxMutationAt } = db.transaction(() => {
    let effectiveSnapshot = snapshotBefore;
    // v6.13.9 Fix 1 — derive BOTH the event_time AND the tie_key of
    // the top row in the global (event_time DESC, tie_key DESC) sort.
    // Pre-v6.13.9 the derivation used MAX(event_time) alone, giving a
    // ms-stable but row-unstable anchor: a same-ms insert after page 1
    // could slot into the top-N and bump the anchor row out. The tie
    // pair pins the anchor row exactly.
    let effectiveTie = snapshotTie;
    if (!effectiveSnapshot) {
      // ORDER BY + LIMIT 1 instead of MAX(), because MAX(event_time)
      // alone wouldn't tell us WHICH row at that timestamp is the
      // anchor. Same index/scan cost as the old MAX path (one leaf-
      // page hit per branch under idx_*_comp_time, bounded-by-scope).
      const anchorSql = `SELECT event_time, tie_key FROM (
        SELECT s.submitted_at as event_time, s.id as tie_key FROM submissions s ${subWhere}
        UNION ALL
        SELECT h.revealed_at as event_time, (h.user_id || '|' || h.task_id) as tie_key FROM hint_reveals h ${hintWhere})
        ORDER BY event_time DESC, tie_key DESC LIMIT 1`;
      const anchorRow = db.prepare(anchorSql).get(...scopeParams, ...scopeParams);
      effectiveSnapshot = anchorRow ? anchorRow.event_time : null;
      effectiveTie      = anchorRow ? anchorRow.tie_key    : null;
    }
    tSnapshot = process.hrtime.bigint();

    // v6.13.6 Fix A — split the events/count path by whether the request
    // carries a q-search. Pre-fix, every call materialised the full
    // comp-scoped UNION (6K+ rows at 3h runtime), applied any outer
    // filters, then sorted by event_time for LIMIT/OFFSET. That full
    // materialise + sort was 55% of the body time per v6.13.5 perf-span
    // logs (mean events_ms=13.3 ms) and count was another 27% (mean
    // count_ms=6.6 ms) because it re-ran the same UNION under COUNT.
    //
    // The NO-SEARCH path (vast majority of admin polls) now:
    //   1. Pushes the snapshot filter AND a LIMIT equal to offset+limit
    //      into each UNION branch. Each branch is a pure index walk on
    //      (competition_id, timestamp DESC) — no extra sort — capped at
    //      offset+limit rows. Correctness: the top-N globally by
    //      event_time DESC is a subset of (top-N from subs) ∪ (top-N
    //      from hints), because a row's branch rank is always ≥ its
    //      global rank when the branch is a subset of the global set.
    //      Outer sort operates on ≤ 2·(offset+limit) rows instead of
    //      the full comp-scoped set.
    //   2. Does separate per-table indexed range counts (with the
    //      snapshot filter when present) and sums them in app code.
    //      Each branch is an index-lookup count — sub-millisecond.
    //
    // The WITH-SEARCH path (hasQ=true) keeps the original materialise-
    // and-filter shape because the LIKE clause touches columns that
    // only exist AFTER the JOINs in each branch; pushing the LIKE into
    // each branch would mean repeating the filter + outer-event_type
    // column wouldn't be available until the UNION level.
    let events, total;
    // A non-default SORT joins the search on this path, for the reason given at
    // SUB_SORTS: the branch-capped walk below is only correct under event_time.
    if (hasQ || !sortIsDefault) {
      // The LIKE is added only when there IS a search — a sort must not filter.
      // v8.10.0 — THE SEARCH IS AN ORACLE, and closing the projection alone
      // leaves it wide open. `#submissions-search` reaches this LIKE and the pane
      // renders a match COUNT, so an admin could type a guessed answer and be told
      // whether any participant had submitted it — confirming the key without ever
      // painting it. That is the whole of what a redaction at the cell would have
      // missed.
      //
      // The answer term is therefore matched against the SAME CASE the projection
      // uses, so a sealed row's answer is an empty string to the search exactly as
      // it is to the reader. Per ROW, not per request: an ordinary challenge stays
      // fully searchable, which is the job this box exists for.
      //
      // The actor id is BOUND, never interpolated, and pushed in the same order the
      // clause names it — this UNION binds positionally, so the two lists have to
      // move together or every later parameter shifts.
      // v8.12.2 — a revealed challenge is searchable like the author's own; the
      // ids are BOUND (never interpolated) and an empty set takes an explicit
      // always-true arm rather than an `IN ()`, which standard SQL forbids.
      const _sealedAnswer = _subProj.sqlAnswer();
      const outerConditions = hasQ ? [
        "(LOWER(COALESCE(nickname,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(task_title,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(" + _sealedAnswer.sql + ",'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(competition_name,'')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(timeslot_name,'')) LIKE ? ESCAPE '\\' OR LOWER(event_type) LIKE ? ESCAPE '\\')",
      ] : [];
      const outerParams = hasQ ? [like, like, ..._sealedAnswer.params, like, like, like, like] : [];
      if (effectiveSnapshot) {
        // v6.13.9 Fix 1 — row-stable lexicographic compare on
        // (event_time, tie_key) when both are provided; fall back to
        // ms-stable `event_time <= ?` for legacy clients that echo
        // only the timestamp.
        if (effectiveTie) {
          outerConditions.push("(event_time < ? OR (event_time = ? AND tie_key <= ?))");
          outerParams.push(effectiveSnapshot, effectiveSnapshot, effectiveTie);
        } else {
          outerConditions.push("event_time <= ?");
          outerParams.push(effectiveSnapshot);
        }
      }
      // A sort with no search and no snapshot leaves nothing to filter on, and a
      // bare `WHERE` is a syntax error — emit no clause at all in that case.
      const outerWhereSql = outerConditions.length ? ` WHERE ${outerConditions.join(" AND ")}` : "";
      // v6.10.54 — ORDER BY event_time DESC, tie_key DESC keeps ordering
      // deterministic across pages under concurrent writes.
      const unionSql = `SELECT * FROM (${SUB_SELECT} ${subWhere} UNION ALL ${HINT_SELECT} ${hintWhere})${outerWhereSql} ${orderBySql} LIMIT ? OFFSET ?`;
      events = db.prepare(unionSql).all(...scopeParams, ...scopeParams, ...outerParams, limit, offset);
      tEvents = process.hrtime.bigint();
      const countSql = `SELECT COUNT(*) as c FROM (${SUB_SELECT} ${subWhere} UNION ALL ${HINT_SELECT} ${hintWhere})${outerWhereSql}`;
      total = db.prepare(countSql).get(...scopeParams, ...scopeParams, ...outerParams).c;
    } else {
      const branchCap = offset + limit;
      // Inner WHERE on the raw tables (no alias — this goes inside the
      // derived-table subquery that uses the composite index). Built
      // from competitionId / timeslotId / snapshot, same scope contract
      // as the existing subWhere / hintWhere but without the `s.` / `h.`
      // alias prefix since we're not yet inside the JOIN'd query.
      let subInnerFilter  = "";
      let hintInnerFilter = "";
      if (competitionId && timeslotId) {
        subInnerFilter  = "WHERE competition_id=? AND timeslot_id=?";
        hintInnerFilter = "WHERE competition_id=? AND timeslot_id=?";
      } else if (competitionId) {
        subInnerFilter  = "WHERE competition_id=?";
        hintInnerFilter = "WHERE competition_id=?";
      }
      // v8.7.0 — the same scope, UNALIASED: this filter sits inside the derived
      // subquery over the raw table, ahead of the JOINs, so there is no `s.` /
      // `h.` to qualify with. It must move in lockstep with the aliased pair
      // above, and does so safely because `subInnerParams` seeds itself from the
      // SAME `scopeParams`: a clause added there and not here (or the reverse)
      // is an immediate placeholder mismatch, not a silent unfiltered read.
      const _innerScope = scopeFilterSql(req, "competition_id");
      subInnerFilter  = _spliceScope(subInnerFilter,  _innerScope.clause);
      hintInnerFilter = _spliceScope(hintInnerFilter, _innerScope.clause);
      // v6.13.9 Fix 1 — row-stable lexicographic pair filter on the
      // branch's timestamp + natural tie-key column (submissions.id
      // for subs, user_id||task_id for hints). Falls back to the
      // ms-stable `<=` form when the client didn't echo a tie (legacy
      // callers before the field existed).
      const subInnerParams  = [...scopeParams];
      const hintInnerParams = [...scopeParams];
      if (effectiveSnapshot && effectiveTie) {
        const subClause  = "(submitted_at < ? OR (submitted_at = ? AND id <= ?))";
        const hintClause = "(revealed_at < ? OR (revealed_at = ? AND (user_id || '|' || task_id) <= ?))";
        subInnerFilter  = subInnerFilter  ? `${subInnerFilter} AND ${subClause}`   : `WHERE ${subClause}`;
        hintInnerFilter = hintInnerFilter ? `${hintInnerFilter} AND ${hintClause}` : `WHERE ${hintClause}`;
        subInnerParams.push(effectiveSnapshot, effectiveSnapshot, effectiveTie);
        hintInnerParams.push(effectiveSnapshot, effectiveSnapshot, effectiveTie);
      } else if (effectiveSnapshot) {
        subInnerFilter  = subInnerFilter  ? `${subInnerFilter} AND submitted_at <= ?`  : "WHERE submitted_at <= ?";
        hintInnerFilter = hintInnerFilter ? `${hintInnerFilter} AND revealed_at <= ?` : "WHERE revealed_at <= ?";
        subInnerParams.push(effectiveSnapshot);
        hintInnerParams.push(effectiveSnapshot);
      }
      // Shape: FROM (SELECT * FROM submissions WHERE … ORDER BY … LIMIT ?) s JOIN …
      // The inner subquery is a descending walk on the composite index
      // (competition_id, submitted_at DESC) capped at branchCap rows —
      // SQLite can't do that in-place with compound-SELECT LIMIT
      // grammar, but a derived-table subquery is legal and has the
      // identical effect. Crucially the JOINs with users / tasks /
      // competitions / timeslots now run over only the ≤branchCap
      // surviving rows per branch instead of the full comp-scoped set,
      // which was the main cost driver in the pre-Fix-A shape.
      const subBranchSql = `
        SELECT 'submission' as event_type, s.submitted_at as event_time, s.id as tie_key,
          u.nickname, t.title as task_title,
          s.answer, s.is_correct, s.points_delta, c.name as competition_name, ts.name as timeslot_name,
          t.answer_sealed as _sealed, t.created_by_id as _author, t.id as _task_id
        FROM (SELECT * FROM submissions ${subInnerFilter} ORDER BY submitted_at DESC, id DESC LIMIT ?) s
          JOIN users u ON u.id=s.user_id
          JOIN tasks t ON t.id=s.task_id
          LEFT JOIN competitions c ON c.id=s.competition_id
          LEFT JOIN competition_timeslots ts ON ts.id=s.timeslot_id`;
      const hintBranchSql = `
        SELECT 'hint' as event_type, h.revealed_at as event_time,
          (h.user_id || '|' || h.task_id) as tie_key,
          u.nickname, t.title as task_title,
          NULL as answer, NULL as is_correct, -h.points_deducted as points_delta, c.name as competition_name, ts.name as timeslot_name,
          t.answer_sealed as _sealed, t.created_by_id as _author, t.id as _task_id
        FROM (SELECT * FROM hint_reveals ${hintInnerFilter} ORDER BY revealed_at DESC, (user_id || '|' || task_id) DESC LIMIT ?) h
          JOIN users u ON u.id=h.user_id
          JOIN tasks t ON t.id=h.task_id
          LEFT JOIN competitions c ON c.id=h.competition_id
          LEFT JOIN competition_timeslots ts ON ts.id=h.timeslot_id`;
      const unionSql = `SELECT * FROM (${subBranchSql} UNION ALL ${hintBranchSql}) ORDER BY event_time DESC, tie_key DESC LIMIT ? OFFSET ?`;
      events = db.prepare(unionSql).all(
        ...subInnerParams,  branchCap,
        ...hintInnerParams, branchCap,
        limit, offset,
      );
      tEvents = process.hrtime.bigint();
      // Separate per-table range counts — no UNION materialisation.
      // Uses the same composite index as the events subqueries; each
      // is an O(log N) seek + leaf scan, sub-millisecond at any
      // realistic row count.
      // v8.7.0 — ONE counting shape for every case. The three no-snapshot
      // branches this replaces re-spelled the filter as literal SQL and so
      // bypassed the scope entirely — the last of them counted the WHOLE
      // platform. That branch is reachable, not theoretical: `effectiveSnapshot`
      // is null exactly when the (now scoped) anchor query found no rows, i.e.
      // for an event admin whose own events are empty, who would then have been
      // handed the platform's total beside an empty list. `subInnerFilter`
      // already carries competition / timeslot / snapshot / scope, and
      // degenerates to "" with no parameters for an unscoped platform-wide
      // read — byte-identical to the branches removed.
      total = db.prepare(`SELECT COUNT(*) as c FROM submissions ${subInnerFilter}`).get(...subInnerParams).c
            + db.prepare(`SELECT COUNT(*) as c FROM hint_reveals ${hintInnerFilter}`).get(...hintInnerParams).c;
    }
    tCount = process.hrtime.bigint();
    // v6.10.83 — UPDATE-drift fingerprint. `total` (v6.10.82) catches DELETE
    // drift (competition / participant delete). Recalc rewrites `is_correct`
    // / `points_delta` / `points_deducted` without changing row count or
    // row insertion timestamps, so neither `total` nor the `snapshot_before`
    // filter surfaces it. This separate aggregate returns MAX(updated_at)
    // scoped to the same (competition/timeslot, snapshot_before) contract
    // the paginated events honour. Client stores the value from page 1 and
    // compares on every subsequent page; a change means a row was rewritten
    // mid-walk. Narrower than SUB_SELECT/HINT_SELECT (no user/task joins)
    // because the fingerprint only needs the two raw timestamp columns.
    // Note: the search-text filter (`q`) is intentionally NOT applied here —
    // it'd require joining back to users/tasks for nickname/title matching
    // and we'd rather let an unrelated row's recalc still show as drift for
    // a searching admin than quietly miss it.
    let maxMutationAt = null;
    if (effectiveSnapshot) {
      // v6.13.9 Fix 1 — scope the mut-max query to the same row set
      // the paginated events honour. With a tie-key pair, use the
      // lexicographic compare; without (legacy client), fall back to
      // the ms-stable `<=`.
      let subScopeWhere, hintScopeWhere, subScopeParams, hintScopeParams;
      if (effectiveTie) {
        const subLex  = "(s.submitted_at < ? OR (s.submitted_at = ? AND s.id <= ?))";
        const hintLex = "(h.revealed_at < ? OR (h.revealed_at = ? AND (h.user_id || '|' || h.task_id) <= ?))";
        subScopeWhere  = subWhere  ? `${subWhere} AND ${subLex}`   : `WHERE ${subLex}`;
        hintScopeWhere = hintWhere ? `${hintWhere} AND ${hintLex}` : `WHERE ${hintLex}`;
        subScopeParams  = [...scopeParams, effectiveSnapshot, effectiveSnapshot, effectiveTie];
        hintScopeParams = [...scopeParams, effectiveSnapshot, effectiveSnapshot, effectiveTie];
      } else {
        subScopeWhere = subWhere
          ? `${subWhere} AND s.submitted_at <= ?`
          : "WHERE s.submitted_at <= ?";
        hintScopeWhere = hintWhere
          ? `${hintWhere} AND h.revealed_at <= ?`
          : "WHERE h.revealed_at <= ?";
        subScopeParams  = [...scopeParams, effectiveSnapshot];
        hintScopeParams = [...scopeParams, effectiveSnapshot];
      }
      const mutMaxSql = `SELECT MAX(m) as m FROM (
        SELECT MAX(COALESCE(s.updated_at, s.submitted_at)) as m FROM submissions s ${subScopeWhere}
        UNION ALL
        SELECT MAX(COALESCE(h.updated_at, h.revealed_at)) as m FROM hint_reveals h ${hintScopeWhere}
      )`;
      const mutMaxRow = db.prepare(mutMaxSql).get(...subScopeParams, ...hintScopeParams);
      maxMutationAt = (mutMaxRow && mutMaxRow.m) ? mutMaxRow.m : null;
    }
    tMutMax = process.hrtime.bigint();
    return { events, total, effectiveSnapshot, effectiveTie, maxMutationAt };
  }).deferred();
  // v8.10.0 — ONE redaction site covering BOTH SQL shapes.
  //
  // `GET /api/admin/submissions` has two mutually exclusive query plans — the
  // plain UNION and the branch-capped fast path — each with its own `s.answer`
  // projection, so a redaction applied to one is invisible in ordinary testing of
  // the other (which plan runs depends on whether a sort or a search is active).
  // Doing it here, on the array both plans produce, is what makes that
  // impossible.
  //
  // The `_sealed` / `_author` columns exist only to make this decision and are
  // DELETED on the way out: `_author` is an internal user id and must not reach a
  // client, and the underscore prefix marks both as internal in the house style.
  // What ships instead is `answer_sealed` plus `answer_visible` — the answer, not
  // the rule, so the client renders "sealed" rather than an empty cell.
  const _subEvents = events.map(e => {
    const _sealed = !!e._sealed;
    const _visible = _subProj.visible(e);
    const { _sealed: _s, _author: _a, _task_id: _t, ...row } = e;
    return {
      ...row,
      ...(_visible ? {} : { answer: null }),
      ...(_sealed ? { answer_sealed: true, answer_visible: _visible } : {}),
    };
  });
  res.json({ events: _subEvents, total, limit, offset,
    // v7.21.16 — echo the applied ordering. The client renders a
    // "Sorted within this page" note when it sorted locally; it must NOT show
    // that note when the server did the sorting globally, and the only honest
    // way to know is to be told which happened.
    sort: sortKey, dir: sortKey ? sortDir.toLowerCase() : null, sorted_globally: !sortIsDefault,
    snapshot_before: effectiveSnapshot,
    snapshot_tie:    effectiveTie,
    max_mutation_at: maxMutationAt,
  });
  const tRespond = process.hrtime.bigint();
  const bodyMs = Number(tRespond - tHandler) / 1e6;
  const preludeMs = req._perfT0 ? Number(tHandler - req._perfT0) / 1e6 : 0;
  const totalMs = preludeMs + bodyMs;
  // v6.12.14 — per-stage breakdown. snapshot_ms / events_ms / count_ms /
  // mut_max_ms all measure inside the deferred tx closure, so they
  // include SQL execution but exclude JSON-serialisation (respond_ms
  // captures that). Under DB growth the expectation is events_ms and
  // count_ms dominate, with snapshot_ms and mut_max_ms small and
  // stable — if those two grow too, the MAX-based aggregates are also
  // being pulled under by the scan.
  if (totalMs > PERF_SPAN_SLOW_MS) {
    const snapshotMs = Number(tSnapshot - tHandler) / 1e6;
    const eventsMs   = Number(tEvents   - tSnapshot) / 1e6;
    const countMs    = Number(tCount    - tEvents)   / 1e6;
    const mutMaxMs   = Number(tMutMax   - tCount)    / 1e6;
    const respondMs  = Number(tRespond  - tMutMax)   / 1e6;
    log.warn({
      req_id: req.id,
      ..._requestActor(req),
      endpoint: "/api/admin/submissions",
      total_ms: totalMs.toFixed(1),
      prelude_ms: preludeMs.toFixed(1),
      body_ms: bodyMs.toFixed(2),
      snapshot_ms: snapshotMs.toFixed(2),
      events_ms: eventsMs.toFixed(2),
      count_ms: countMs.toFixed(2),
      mut_max_ms: mutMaxMs.toFixed(2),
      respond_ms: respondMs.toFixed(2),
      row_count: events.length,
      total_rows: total,
      comp_scope: competitionId ? (timeslotId ? "comp+slot" : "comp") : "global",
      has_q: hasQ,
      snapshot_echoed: !!snapshotBefore,
    }, "[perf-span] slow /api/admin/submissions");
  }
});

// ── Admin challenge-event analytics ─────────────────────────────────────────
// Aggregates rows from the `challenge_events` table into summary + per-
// challenge totals for the Analytics admin pane. Read-only; admins only.
//
// Filter design notes:
//   • `scope` is the dominant axis: global (no comp/slot bound), per-
//     competition, or per-timeslot. Only global accepts a time window
//     — competition/session windows are implicit.
//   • Difficulty / task-id / tag filters AND together with the scope.
//   • Tag filter is applied in JS after the SQL aggregation so we don't
//     have to hand-roll an "any-of" join in SQLite — the per-task tag
//     set is small enough that the JS side is O(rows*tags).
//   • Staff/benchmark are user-scoped exclusions via NOT IN subqueries
//     against user_tags. Defaults: exclude staff, include benchmark
//     (matches the operator's mental model — staff are organisers,
//     benchmark users are reference scores worth keeping in the chart).
function _resolveAnalyticsWindow(preset, from, to) {
  // Explicit from/to win over preset; missing parts left null mean
  // unbounded on that side. ISO8601 strings throughout.
  if (from || to) return { from: from || null, to: to || null };
  const nowIso = now().toISOString();
  const ago = (days) => new Date(Date.now() - days * 86400_000).toISOString();
  switch (preset) {
    case "month":    return { from: ago(30),  to: nowIso };
    case "3months":  return { from: ago(90),  to: nowIso };
    case "6months":  return { from: ago(180), to: nowIso };
    case "year":     return { from: ago(365), to: nowIso };
    case "all":
    default:         return { from: null, to: null };
  }
}

// Tiny TTL cache over /api/admin/analytics/challenges (v6.8.0). Admin
// dashboards poll this on the order of every 15-60 s; a 3-second cache
// collapses overlapping refreshes from multiple admins into a single
// run. Key is the full query string so every filter permutation caches
// independently. Invalidated by the simple TTL expiry — challenge_events
// accrue fast enough that a longer TTL would mask a real delta.
const _analyticsCache = new Map();
// v6.13.6 Fix B — TTL raised 3 s → 15 s. Admin Analytics tab polls at
// 15-30 s cadence; at the previous 3 s every admin poll missed the
// cache and re-ran the 4-query aggregate pipeline (mean 27.9 ms per
// v6.13.5 perf-span logs). 15 s captures roughly half of
// consecutive polls while keeping the view "near real time" during
// a live event. Freshness tradeoff: an analytics snapshot can now be
// up to 15 s stale instead of 3 s; for a hackathon dashboard that's
// still well within operator expectations (challenge-events don't
// move on the same scale as leaderboard position).
const _ANALYTICS_CACHE_TTL_MS = 15_000;
const _ANALYTICS_CACHE_MAX_ENTRIES = 256;
function _analyticsCacheKey(req) {
  // req.url includes the query string after the path; stable across a
  // repeated poll that parses to the same filter-param object.
  //
  // v8.7.0 — THE ACTOR IS PART OF THE KEY, and this closes a real cross-tier
  // leak that predates the event-admin role. The body is a function of WHO asked
  // as well as of what they asked, so on a bare `req.url` key a superadmin's
  // platform-wide response is served to an event admin issuing the same query
  // string — and, the other way round, a narrowed body to a superadmin, which
  // reads as data having vanished. The cost is that the 256-entry LRU no longer
  // collapses two admins' identical polls into one entry; absorbing ONE admin's
  // 15-30 s refresh is the job it was added for, and it still does that.
  //
  // The SCOPE rides the key too, not just the actor id. `invalidateEventAdminScope`
  // clears the scope cache but knows nothing about this one, so without the scope
  // in the key a revoked grant would keep answering from an entry computed under
  // the OLD scope for up to the 15 s TTL — the actor sees an event they no longer
  // organise. Keying on the scope makes the stale entry unreachable rather than
  // needing a second invalidator wired across two more route files; it is `null`
  // for admin / superadmin, so their keys are unchanged in shape and in count.
  const _scope = scopedCompetitionIds(req);
  return `${actorId(req) || "builtin"}|${_scope === null ? "*" : _scope.join(",")}|${req.url || ""}`;
}

app.get("/api/admin/analytics/challenges", requireAdmin, (req, res) => {
  // v6.12.14 — perf-span instrumentation. Per-route CSV showed this
  // endpoint's p95 creeping 3.3 → 34 ms over a 3h sustained run with
  // the same "whole distribution shifts right" shape as
  // /api/admin/submissions. Aggregates over challenge_events (linear
  // in events), tasks, and tags. Stage boundaries:
  //   setup_ms    — input parsing + comp/slot lookup
  //   summary_ms  — the two aggregate queries (by event_type + distinct)
  //   per_task_ms — the two per-task aggregate queries
  //   meta_ms     — task metadata / tag / task_number / tag-filter re-query
  //   respond_ms  — JSON serialise + send
  // Cache hits skip the body and are not measured (they're sub-ms).
  const tHandler = process.hrtime.bigint();
  const _ck = _analyticsCacheKey(req);
  const _hit = _analyticsCache.get(_ck);
  if (_hit && (Date.now() - _hit.ts) < _ANALYTICS_CACHE_TTL_MS) return res.json(_hit.data);
  const scope = String(req.query.scope || "global");
  if (!["global", "competition", "timeslot"].includes(scope)) {
    return res.status(400).json({ error: "scope must be one of: global, competition, timeslot" });
  }
  const competitionId = req.query.competitionId ? String(req.query.competitionId) : null;
  const timeslotId    = req.query.timeslotId    ? String(req.query.timeslotId)    : null;
  if (scope === "competition" && !competitionId)
    return res.status(400).json({ error: "competitionId is required for scope=competition" });
  if (scope === "timeslot" && (!competitionId || !timeslotId))
    return res.status(400).json({ error: "competitionId and timeslotId are required for scope=timeslot" });
  // v8.7.0 — a platform-wide aggregate has no scoped answer, so it is REFUSED
  // rather than quietly narrowed to the actor's events: a chart labelled
  // "global" that silently covers one event is a wrong answer nothing on the
  // screen can reveal. 400 rather than 403 because the request is malformed FOR
  // THIS ACTOR — the remedy is a different scope, not a different person — and
  // the message names it. `scopedCompetitionIds` is null for admin and
  // superadmin (never [], which is the grantless event admin and must still be
  // refused), so this branch cannot fire for them. The v8.1.0 behaviour where a
  // client that has chosen NO scope prompts instead of querying is untouched.
  if (scope === "global" && scopedCompetitionIds(req) !== null) {
    return res.status(400).json({
      error: "Platform-wide analytics cover every event on the platform. Choose one of your own events to analyse instead.",
      code: "event_admin_global_scope",
    });
  }
  // Refused BEFORE the existence lookup below, so an out-of-scope id cannot be
  // probed for existence: the answer is 403 whether or not the event is real.
  // The timeslot needs no separate check — it is validated below to belong to
  // this competition, so the competition's scope decides it.
  const _anDenied = competitionId ? competitionDenied(req, competitionId) : null;
  if (_anDenied) return res.status(403).json({ error: _anDenied.message, code: _anDenied.code });

  // Resolve scope-bound entities (for the response echo + comp-name lookup)
  let comp = null, ts = null;
  if (competitionId) {
    comp = getCompetition(competitionId);
    if (!comp) return res.status(404).json({ error: "Event not found" });
  }
  if (timeslotId) {
    ts = getTimeslot(timeslotId);
    if (!ts || ts.competition_id !== competitionId)
      return res.status(404).json({ error: "Timeslot not found in the specified event" });
  }

  // Time window — only meaningful for global; comp/session inherit their
  // entity bounds via the competition_id / timeslot_id filter and ignore
  // the dropdown.
  const win = scope === "global"
    ? _resolveAnalyticsWindow(req.query.periodPreset || "all", req.query.from, req.query.to)
    : { from: null, to: null };

  // Filters
  const taskIds = (req.query.taskIds || "").toString().split(",").map(s => s.trim()).filter(Boolean);
  const difficulties = (req.query.difficulties || "").toString().split(",").map(s => s.trim()).filter(Boolean)
    .filter(d => ["easy", "medium", "hard"].includes(d));
  const tagsFilter = (req.query.tags || "").toString().split(",").map(s => s.trim()).filter(Boolean);
  const excludeChallengeTags = (req.query.excludeChallengeTags || "").toString().split(",").map(s => s.trim()).filter(Boolean);
  const includeChallengeTags = (req.query.includeChallengeTags || "").toString().split(",").map(s => s.trim()).filter(Boolean);
  // Participant tag filtering. Default: exclude "staff" (organisers don't
  // count in participant metrics), include "benchmark" (reference scores
  // are useful). Generalised via excludeParticipantTags / includeParticipantTags
  // (v6.6.0) — the legacy includeStaff / includeBenchmark booleans are
  // mapped into the tag-based params for back-compat.
  const _rawExclPart = req.query.excludeParticipantTags !== undefined
    ? req.query.excludeParticipantTags : null;
  const _rawInclPart = req.query.includeParticipantTags !== undefined
    ? req.query.includeParticipantTags : null;
  // Legacy compat: if old booleans are present but new params are not, map them
  const includeStaff     = String(req.query.includeStaff)     === "true";
  const includeBenchmark = String(req.query.includeBenchmark) !== "false";
  const excludeParticipantTags = _rawExclPart !== null
    ? _rawExclPart.toString().split(",").map(s => s.trim()).filter(Boolean)
    : [...(!includeStaff ? ["staff"] : []), ...(!includeBenchmark ? ["benchmark"] : [])];
  const includeParticipantTags = _rawInclPart !== null
    ? _rawInclPart.toString().split(",").map(s => s.trim()).filter(Boolean)
    : [];
  // v6.20.0 — participant GROUP filtering (CSV of group ids). Independent of
  // the participant-tag filter; the UI offers a Tags|Groups toggle but the
  // server applies whatever is sent. includeGroups narrows to members of the
  // listed groups; excludeGroups removes them.
  const includeGroups = (req.query.includeGroups || "").toString().split(",").map(s => s.trim()).filter(Boolean);
  const excludeGroups = (req.query.excludeGroups || "").toString().split(",").map(s => s.trim()).filter(Boolean);
  // v8.7.0 — a group id is a NAMED entity, so an unreadable one is refused
  // rather than applied. Applied, it is a membership oracle: the filter narrows
  // by group over the actor's OWN participants, so the movement in the counts
  // answers "which of my people are in that group" for a group the actor is not
  // entitled to see. This is the only vocabulary reaching this response that
  // the competition scope does not already narrow — the per-challenge tags
  // belong to challenges used by the actor's own event, which they may view.
  // `groupViewDenied` returns null for admin and superadmin, so it is inert.
  for (const _gid of [...includeGroups, ...excludeGroups]) {
    const _gDenied = groupViewDenied(req, _gid);
    if (_gDenied) return res.status(403).json({ error: _gDenied.message, code: _gDenied.code });
  }
  // v6.6.0: competition tag filter. Competitions carrying the dry-run tag are
  // excluded from global analytics by default (same principle as "staff" for
  // participants). The admin can opt in via the tag picker, or use it to filter
  // by any competition tag. v7.21.18 — the tag string is DRY_RUN_TAG
  // ("test/dry run", renamed from "internal"); it is imported rather than
  // spelled here so this default cannot drift from the value actually stored.
  const _rawExclComp = req.query.excludeCompTags !== undefined
    ? req.query.excludeCompTags : null;
  const _rawInclComp = req.query.includeCompTags !== undefined
    ? req.query.includeCompTags : null;
  const excludeCompTags = _rawExclComp !== null
    ? _rawExclComp.toString().split(",").map(s => s.trim()).filter(Boolean)
    : [DRY_RUN_TAG];
  const includeCompTags = _rawInclComp !== null
    ? _rawInclComp.toString().split(",").map(s => s.trim()).filter(Boolean)
    : [];

  // Build WHERE — parameterised; each id list is ONE bound JSON array (`json_each`).
  const where = [];
  const params = [];
  // v7.14.0 — actions performed under participant impersonation never count
  // towards analytics. The single push covers all five queries below (the four
  // aggregates + the filtered-distinct re-query interpolate the same whereSql).
  // The column is NOT NULL DEFAULT 0 (migration backfills 0), so no COALESCE;
  // idx_chev_comp_task_user_type was rebuilt with `impersonated` appended so
  // the aggregate pipeline keeps its index-only-scan property.
  where.push("ce.impersonated=0");
  // Event team reports — a qualifying question has no wrong answer, so a row for
  // it would read as a 100% solve rate: it is not a challenge analytics measures.
  where.push("ce.task_id NOT IN (SELECT task_id FROM task_tags WHERE tag LIKE 'qualifying:%')");
  if (scope === "competition") { where.push("ce.competition_id=?"); params.push(competitionId); }
  if (scope === "timeslot") { where.push("ce.competition_id=? AND ce.timeslot_id=?"); params.push(competitionId, timeslotId); }
  if (win.from) { where.push("ce.occurred_at >= ?"); params.push(win.from); }
  if (win.to)   { where.push("ce.occurred_at <= ?"); params.push(win.to); }
  if (taskIds.length) {
    where.push(`ce.task_id IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(taskIds));
  }
  if (difficulties.length) {
    where.push(`t.difficulty IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(difficulties));
  }
  // Participant tag exclusion (generalised from the old staff/benchmark booleans)
  if (excludeParticipantTags.length) {
    const ph = "SELECT value FROM json_each(?)";
    where.push(`ce.user_id NOT IN (SELECT user_id FROM user_tags WHERE tag IN (${ph}))`);
    params.push(JSON.stringify(excludeParticipantTags));
  }
  if (includeParticipantTags.length) {
    const ph = "SELECT value FROM json_each(?)";
    where.push(`ce.user_id IN (SELECT user_id FROM user_tags WHERE tag IN (${ph}))`);
    params.push(JSON.stringify(includeParticipantTags));
  }
  // v6.20.0 — participant group filtering (by group id).
  if (includeGroups.length) {
    const ph = "SELECT value FROM json_each(?)";
    where.push(`ce.user_id IN (SELECT user_id FROM group_members WHERE group_id IN (${ph}))`);
    params.push(JSON.stringify(includeGroups));
  }
  if (excludeGroups.length) {
    const ph = "SELECT value FROM json_each(?)";
    where.push(`ce.user_id NOT IN (SELECT user_id FROM group_members WHERE group_id IN (${ph}))`);
    params.push(JSON.stringify(excludeGroups));
  }
  // Competition tag exclusion: exclude comps tagged with any of excludeCompTags
  // (default: the dry-run tag). includeCompTags narrows to ONLY comps with those tags.
  if (scope === "global") {
    if (excludeCompTags.length) {
      const ph = "SELECT value FROM json_each(?)";
      where.push(`ce.competition_id NOT IN (SELECT competition_id FROM competition_tags WHERE tag IN (${ph}))`);
      params.push(JSON.stringify(excludeCompTags));
    }
    if (includeCompTags.length) {
      const ph = "SELECT value FROM json_each(?)";
      where.push(`ce.competition_id IN (SELECT competition_id FROM competition_tags WHERE tag IN (${ph}))`);
      params.push(JSON.stringify(includeCompTags));
    }
  }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const baseFrom = "FROM challenge_events ce JOIN tasks t ON t.id=ce.task_id";

  // v6.12.14 — perf-span setup-boundary. Everything up to here is
  // inputs parsing + single-row scope lookups (getCompetition /
  // getTimeslot which hit the _competitionCache).
  const tSetup = process.hrtime.bigint();
  // Read-snapshot isolation (v6.8.0): wrap the multi-query read pipeline in a
  // single transaction so an admin tag add/remove committed between the
  // summary and per-challenge queries can't split the response into two
  // inconsistent views. better-sqlite3 WAL mode gives each open transaction
  // a fixed snapshot — this only affects cross-query consistency, never
  // live writers. COMMIT is in the `finally` so a throw still closes the
  // implicit lock.
  db.exec("BEGIN");
  try {
  // ── A ONE-WAY DOOR ON `challenge_events` (recorded here v8.6.1) ───────────
  //
  // DO NOT ADD AN `opened` / `viewed` EVENT TYPE. An "the participant looked at
  // this challenge" signal is the obvious next analytics ask, and it would be a
  // silent, platform-wide regression rather than an addition:
  //
  //   * `unique_participants` (just below) and the per-task `u` that becomes
  //     `unique_attempters` are `COUNT(DISTINCT ce.user_id)` with **no
  //     event_type predicate**. They count whoever appears in the table at all.
  //   * `unique_attempters` is the DENOMINATOR of the solve rate, and has been a
  //     visible admin column since v7.27.0.
  //
  // So the day a view event starts being written, "attempters" quietly becomes
  // "viewers", and EVERY solve rate on the platform drops overnight with nothing
  // on any screen saying why — no error, no failing test, and the historical
  // series is not comparable either side of the change.
  //
  // If such a type is genuinely wanted, the predicate has to move first: give
  // these two queries (and the `event_type in summary` fold above) an explicit
  // attempt-type allow-list, and decide what the existing stored series means.
  // That is a deliberate analytics change, not a new row in a table.
  //
  // Summary: counts per event_type plus distinct user/task counts.
  const evRows = db.prepare(
    `SELECT ce.event_type AS event_type, COUNT(*) AS c ${baseFrom} ${whereSql} GROUP BY ce.event_type`
  ).all(...params);
  const summary = { solved: 0, incorrect: 0, hint_revealed: 0, navigated_away: 0,
                    unique_participants: 0, unique_challenges: 0 };
  for (const r of evRows) if (r.event_type in summary) summary[r.event_type] = r.c;
  const dRow = db.prepare(
    `SELECT COUNT(DISTINCT ce.user_id) AS u, COUNT(DISTINCT ce.task_id) AS t ${baseFrom} ${whereSql}`
  ).get(...params);
  summary.unique_participants = dRow?.u || 0;
  summary.unique_challenges   = dRow?.t || 0;
  const tSummary = process.hrtime.bigint();

  // Per-challenge: counts by (task_id, event_type) + distinct users per task.
  const perTaskEvRows = db.prepare(
    `SELECT ce.task_id AS task_id, ce.event_type AS event_type, COUNT(*) AS c ${baseFrom} ${whereSql} GROUP BY ce.task_id, ce.event_type`
  ).all(...params);
  const perTaskUniqRows = db.prepare(
    `SELECT ce.task_id AS task_id, COUNT(DISTINCT ce.user_id) AS u ${baseFrom} ${whereSql} GROUP BY ce.task_id`
  ).all(...params);
  const tPerTask = process.hrtime.bigint();

  const taskIdSet = new Set(perTaskUniqRows.map(r => r.task_id));
  // Lookup task metadata + tags + (when scope is comp/session) task_number.
  let perChallenge = [];
  if (taskIdSet.size) {
    const ids = [...taskIdSet];
    const placeholders = "SELECT value FROM json_each(?)";
    const taskMetaRows = db.prepare(
      `SELECT id, title, difficulty FROM tasks WHERE id IN (${placeholders})`
    ).all(JSON.stringify(ids));
    const tagRows = db.prepare(
      `SELECT task_id, tag FROM task_tags WHERE task_id IN (${placeholders})`
    ).all(JSON.stringify(ids));
    const tagsByTask = new Map();
    for (const r of tagRows) {
      if (!tagsByTask.has(r.task_id)) tagsByTask.set(r.task_id, []);
      tagsByTask.get(r.task_id).push(r.tag);
    }
    let numbersByTask = new Map();
    if (scope !== "global") {
      const numRows = db.prepare(
        `SELECT task_id, task_number FROM competition_tasks WHERE competition_id=? AND task_id IN (${placeholders})`
      ).all(competitionId, JSON.stringify(ids));
      for (const r of numRows) numbersByTask.set(r.task_id, r.task_number);
    }
    const meta = new Map(taskMetaRows.map(r => [r.id, r]));
    const counts = new Map(); // task_id -> { solved, incorrect, hint_revealed, navigated_away }
    for (const r of perTaskEvRows) {
      if (!counts.has(r.task_id)) counts.set(r.task_id, { solved: 0, incorrect: 0, hint_revealed: 0, navigated_away: 0 });
      const bucket = counts.get(r.task_id);
      if (r.event_type in bucket) bucket[r.event_type] = r.c;
    }
    const uniq = new Map(perTaskUniqRows.map(r => [r.task_id, r.u]));
    perChallenge = ids.map(id => {
      const m = meta.get(id);
      const c = counts.get(id) || { solved: 0, incorrect: 0, hint_revealed: 0, navigated_away: 0 };
      return {
        task_id: id,
        task_number: numbersByTask.get(id) || null,
        title: m?.title || "(deleted task)",
        difficulty: m?.difficulty || null,
        tags: tagsByTask.get(id) || [],
        solved: c.solved, incorrect: c.incorrect,
        hint_revealed: c.hint_revealed, navigated_away: c.navigated_away,
        unique_attempters: uniq.get(id) || 0,
      };
    });
    // Challenge tag filter: include/exclude/legacy any-match.
    const _challTagIncl = includeChallengeTags.length ? includeChallengeTags : tagsFilter;
    if (_challTagIncl.length) {
      const wanted = new Set(_challTagIncl);
      perChallenge = perChallenge.filter(row => row.tags.some(t => wanted.has(t)));
    }
    if (excludeChallengeTags.length) {
      const unwanted = new Set(excludeChallengeTags);
      perChallenge = perChallenge.filter(row => !row.tags.some(t => unwanted.has(t)));
    }
    if (_challTagIncl.length || excludeChallengeTags.length) {
      // Recompute summary against the filtered task subset so the donut and
      // the table stay consistent: the per-challenge view is the truth.
      const filteredIds = new Set(perChallenge.map(r => r.task_id));
      const recomputed = { solved: 0, incorrect: 0, hint_revealed: 0, navigated_away: 0 };
      const userSet = new Set();
      for (const row of perTaskEvRows) {
        if (!filteredIds.has(row.task_id)) continue;
        if (row.event_type in recomputed) recomputed[row.event_type] += row.c;
      }
      // Distinct user count after tag filter requires a re-query against
      // the same WHERE plus the task_id IN (filtered).
      if (filteredIds.size) {
        const fIds = [...filteredIds];
        const fRow = db.prepare(
          `SELECT COUNT(DISTINCT ce.user_id) AS u ${baseFrom} ${whereSql}${where.length ? " AND " : "WHERE "}ce.task_id IN (SELECT value FROM json_each(?))`
        ).get(...params, JSON.stringify(fIds));
        userSet.add(fRow?.u || 0);
        Object.assign(summary, recomputed, { unique_participants: fRow?.u || 0, unique_challenges: filteredIds.size });
      } else {
        Object.assign(summary, { solved: 0, incorrect: 0, hint_revealed: 0, navigated_away: 0,
                                 unique_participants: 0, unique_challenges: 0 });
      }
    }
    // Default WIRE sort: total events desc, then title asc, then task_id.
    //
    // v7.24.0 — `task_id` is a new, and load-bearing, third key. tasks.title is
    // NOT unique, so without it two challenges tied on both total events and
    // title fell through to SQLite's GROUP BY output order, which is not a
    // promise: the same query could answer in a different order on two polls
    // and the table would appear to reshuffle (v6.10.54 — a sort key that is
    // not total is not a sort).
    //
    // This is the order on the WIRE. The admin pane re-sorts client-side, by
    // challenge number in a competition scope and by name globally (v7.24.0),
    // and it can do that because the whole filtered set is on the wire —
    // there is no pagination here to make the server's order load-bearing. The
    // sort is deliberately NOT parameterised: the cache key is the full query
    // string, so a sort+dir pair would multiply every existing filter
    // permutation by ~22 against a 256-entry LRU, and two of the client's
    // columns (total, solve rate) are derived values the server would have to
    // re-derive — a second definition of each.
    perChallenge.sort((a, b) => {
      const tA = a.solved + a.incorrect + a.hint_revealed + a.navigated_away;
      const tB = b.solved + b.incorrect + b.hint_revealed + b.navigated_away;
      if (tA !== tB) return tB - tA;
      return (a.title || "").localeCompare(b.title || "") || String(a.task_id).localeCompare(String(b.task_id));
    });
  }

  const _payload = {
    scope: {
      type: scope,
      competition_id: comp?.id || null,
      competition_name: comp?.name || null,
      timeslot_id: ts?.id || null,
      timeslot_name: ts?.name || null,
      from: win.from, to: win.to,
    },
    filters: {
      task_ids: taskIds,
      difficulties,
      tags: tagsFilter,
      excludeChallengeTags, includeChallengeTags,
      excludeCompTags, includeCompTags,
      excludeParticipantTags, includeParticipantTags,
      includeGroups, excludeGroups,
    },
    summary,
    per_challenge: perChallenge,
  };
  // v6.8.5: O(1) LRU eviction. Map iteration in V8 is insertion-ordered, so
  // the oldest entry is the first key returned by keys(). Previous impl did
  // O(N log N) sort + N/2 deletes on every miss past the cap; under a
  // crafted-filter flood at 500 VUs that pegged the event loop for 20-50 ms
  // per trigger. Now: eject oldest single entry each time the cap is hit,
  // then re-insert the fresh entry (set() moves the key to the tail so
  // hot queries keep being protected from eviction).
  if (_analyticsCache.size >= _ANALYTICS_CACHE_MAX_ENTRIES) {
    const oldestKey = _analyticsCache.keys().next().value;
    if (oldestKey !== undefined) _analyticsCache.delete(oldestKey);
  }
  _analyticsCache.delete(_ck); // re-insert to bump to tail (LRU update on hit)
  _analyticsCache.set(_ck, { data: _payload, ts: Date.now() });
  // v6.12.14 — tMeta closes the per-task-metadata + tag-filter stage;
  // if taskIdSet was empty we skipped the block entirely and tMeta
  // equals tPerTask (meta_ms would be 0). Captured here so the log
  // picks it up regardless of branch.
  const tMeta = process.hrtime.bigint();
  res.json(_payload);
  const tRespond = process.hrtime.bigint();
  const bodyMs = Number(tRespond - tHandler) / 1e6;
  const preludeMs = req._perfT0 ? Number(tHandler - req._perfT0) / 1e6 : 0;
  const totalMs = preludeMs + bodyMs;
  if (totalMs > PERF_SPAN_SLOW_MS) {
    const setupMs   = Number(tSetup   - tHandler) / 1e6;
    const summaryMs = Number(tSummary - tSetup)   / 1e6;
    const perTaskMs = Number(tPerTask - tSummary) / 1e6;
    const metaMs    = Number(tMeta    - tPerTask) / 1e6;
    const respondMs = Number(tRespond - tMeta)    / 1e6;
    log.warn({
      req_id: req.id,
      ..._requestActor(req),
      endpoint: "/api/admin/analytics/challenges",
      scope,
      total_ms: totalMs.toFixed(1),
      prelude_ms: preludeMs.toFixed(1),
      body_ms: bodyMs.toFixed(2),
      setup_ms: setupMs.toFixed(2),
      summary_ms: summaryMs.toFixed(2),
      per_task_ms: perTaskMs.toFixed(2),
      meta_ms: metaMs.toFixed(2),
      respond_ms: respondMs.toFixed(2),
      task_count: taskIdSet.size,
      challenge_count: perChallenge.length,
      summary_solved: summary.solved,
      has_filters: !!(taskIds.length || difficulties.length || tagsFilter.length
                    || includeChallengeTags.length || excludeChallengeTags.length
                    || excludeCompTags.length || includeCompTags.length
                    || excludeParticipantTags.length || includeParticipantTags.length),
    }, "[perf-span] slow /api/admin/analytics/challenges");
  }
  } finally {
    try { db.exec("COMMIT"); } catch (_err) { /* no-op if already rolled back */ swallowed("server:read-snapshot-commit", _err); }
  }
});

// ── Admin leaderboard (competition-scoped, required) ─────────────────────────

// (GET /api/admin/leaderboard is registered by routes/leaderboard.js, above.)

// v6.8.5 — metrics endpoint for operator observability. Exposes the
// counters + latency reservoir populated by the request-counting
// middleware in Prometheus text-exposition format. Gated on requireAdmin
// so scraping is privileged (operators behind the reverse proxy can point
// at /metrics with an admin cookie, or an ops team can carve out a
// separate exposed route if they prefer). The payload is deliberately
// small — process-level health (memory, uptime) + counters + latency
// quantiles — because a single instance serving 500 VUs doesn't need a
// kitchen-sink metrics library.
// v6.16.7 — 1-s response cache. Pre-fix every scrape sorted the
// 1024-entry latency reservoir 4 times (once per quantile call) under
// the request-thread CPU. A misconfigured Prometheus agent in
// tight-loop mode burned single-core CPU continuously. Caching for
// 1 s amortises the work — Prometheus's typical 15-60 s scrape
// interval has cache hit rate 0% in normal operation, so this is a
// pure protection layer against pathological clients.
let _metricsCache = { ts: 0, body: null };
app.get("/metrics", requireAdmin, (req, res) => {
  const _nowMs = Date.now();
  if (_metricsCache.body && (_nowMs - _metricsCache.ts) < 1000) {
    res.type("text/plain; version=0.0.4");
    return res.send(_metricsCache.body);
  }
  const mem = process.memoryUsage();
  const lines = [
    `# HELP hack_arena_requests_total Total HTTP requests handled since boot`,
    `# TYPE hack_arena_requests_total counter`,
    `hack_arena_requests_total ${_metrics.requests.total}`,
    `hack_arena_requests_by_status{status="2xx"} ${_metrics.requests.s2xx}`,
    `hack_arena_requests_by_status{status="4xx"} ${_metrics.requests.s4xx}`,
    `hack_arena_requests_by_status{status="5xx"} ${_metrics.requests.s5xx}`,
    `hack_arena_rate_limited_429 ${_metrics.rateLimited429}`,
    `# HELP hack_arena_latency_ms Request latency quantiles (rolling 1024-sample reservoir)`,
    `# TYPE hack_arena_latency_ms summary`,
    `hack_arena_latency_ms{quantile="0.5"} ${_latencyPercentile(0.5)}`,
    `hack_arena_latency_ms{quantile="0.95"} ${_latencyPercentile(0.95)}`,
    `hack_arena_latency_ms{quantile="0.99"} ${_latencyPercentile(0.99)}`,
    `hack_arena_latency_samples ${_metrics.latencyFilled}`,
    `# HELP hack_arena_cache_sizes Current in-memory cache populations`,
    `# TYPE hack_arena_cache_sizes gauge`,
    `hack_arena_cache_sizes{cache="leaderboard"} ${_leaderboardCacheEntryCount()}`,
    `hack_arena_cache_sizes{cache="rate_limit"} ${_rateLimitBucketCount()}`,
    `hack_arena_cache_sizes{cache="analytics"} ${_analyticsCache.size}`,
    `hack_arena_cache_sizes{cache="me"} ${_meCacheSize()}`,
    `hack_arena_cache_sizes{cache="user_tags"} ${_userTagsCacheSize()}`,
    `hack_arena_cache_sizes{cache="competition"} ${_competitionCacheSize()}`,
    `# HELP hack_arena_process Process-level health`,
    `# TYPE hack_arena_process gauge`,
    `hack_arena_process_uptime_seconds ${Math.floor(process.uptime())}`,
    `hack_arena_process_memory_rss_bytes ${mem.rss}`,
    `hack_arena_process_memory_heap_used_bytes ${mem.heapUsed}`,
    // v7.21.23 — cumulative milliseconds the event loop was unable to run. In a
    // single-process server this is the health signal: a rising rate means
    // synchronous work is stalling every other request, and it is also what
    // stops the submit span's client/server split from excusing a server stall
    // as a slow participant. A counter, not a gauge — rate() it.
    `hack_arena_event_loop_blocked_ms_total ${_loopBlockedNow().toFixed(0)}`,
    `hack_arena_smtp_healthy ${smtpHealthy() === true ? 1 : smtpHealthy() === false ? 0 : -1}`,
    // v7.29.0 — emailed sign-in codes. Both endpoints answer 200 on EVERY path
    // (a non-429 4xx feeds the scanner counter, which blocks a whole venue NAT),
    // so they are the only unauthenticated surfaces contributing nothing to it —
    // these families are their ONLY monitoring. `outcome="ineligible"` mixes
    // refused accounts and refused addresses with ordinary free-mail visitors
    // (lib/login-code.js explains the series); the audited reasons say which,
    // except for an empty or malformed address, which is counted and never
    // recorded.
    //
    // v8.1.0 (PR 33) — `hack_arena_login_code_enabled` went with the flag. A gauge
    // that can only ever report 1 tells an operator nothing, and leaving it would
    // imply a switch that no longer exists.
    `# HELP hack_arena_login_code_requests_total Sign-in code requests by outcome`,
    `# TYPE hack_arena_login_code_requests_total counter`,
    `# HELP hack_arena_csp_reports_total CSP violation reports by what they are attributed to`,
    `# TYPE hack_arena_csp_reports_total counter`,
    // v8.3.14 — the counter is what keeps the extension filter honest. Those
    // reports drop to DEBUG so they stop burying ours, and a filter with no
    // counter is the invisible half of the same problem: `origin="app"` rising is
    // a signal worth acting on, `origin="browser_extension"` rising is just more
    // visitors with add-ons.
    `hack_arena_csp_reports_total{origin="app"} ${_cspReportCounts.app}`,
    `hack_arena_csp_reports_total{origin="browser_extension"} ${_cspReportCounts.extension}`,
    `# HELP hack_arena_presence_rows Participants with recorded net active time`,
    `# TYPE hack_arena_presence_rows gauge`,
    `hack_arena_presence_rows ${presenceRowCount()}`,
    ...Object.entries(loginCodeCounters().request).map(([o, n]) => `hack_arena_login_code_requests_total{outcome="${o}"} ${n}`),
    `# HELP hack_arena_login_code_redeems_total Sign-in code redemptions by outcome`,
    `# TYPE hack_arena_login_code_redeems_total counter`,
    ...Object.entries(loginCodeCounters().redeem).map(([o, n]) => `hack_arena_login_code_redeems_total{outcome="${o}"} ${n}`),
    `# HELP hack_arena_login_code_event_drops_total "Not your event?" requests to untie an emailed sign-in code or address proof from its event, by outcome`,
    `# TYPE hack_arena_login_code_event_drops_total counter`,
    ...Object.entries(loginCodeCounters().drop).map(([o, n]) => `hack_arena_login_code_event_drops_total{outcome="${o}"} ${n}`),
    `# HELP hack_arena_email_proof_refusals_unrecorded_total Address-proof refusals counted instead of recorded, past their source's record budget, by reason`,
    `# TYPE hack_arena_email_proof_refusals_unrecorded_total counter`,
    ...Object.entries(loginCodeCounters().unrecorded).map(([o, n]) => `hack_arena_email_proof_refusals_unrecorded_total{reason="${o}"} ${n}`),
    // v7.25.0 — scanner-block visibility. There were no scanner families here
    // at all, which was tolerable while every block emailed somebody: the
    // notification WAS the monitoring. A probe-classified block is deliberately
    // silent, so without these it would be observable only by an operator who
    // already suspected it and went digging in the Logs tab.
    `# HELP hack_arena_scanner_tracked_ips Addresses currently in the scanner-reputation window`,
    `# TYPE hack_arena_scanner_tracked_ips gauge`,
    `hack_arena_scanner_tracked_ips ${_scannerIpRep.size}`,
    `# HELP hack_arena_scanner_blocked_ips Addresses currently serving a scanner block`,
    `# TYPE hack_arena_scanner_blocked_ips gauge`,
    `hack_arena_scanner_blocked_ips ${_scannerBlockedIpCount()}`,
    `# HELP hack_arena_scanner_blocks_total Scanner blocks since boot, by traffic verdict`,
    `# TYPE hack_arena_scanner_blocks_total counter`,
    `hack_arena_scanner_blocks_total{verdict="probe"} ${_scannerBlockStats.probe}`,
    `hack_arena_scanner_blocks_total{verdict="cohort"} ${_scannerBlockStats.cohort}`,
    `hack_arena_scanner_blocks_total{verdict="mixed"} ${_scannerBlockStats.mixed}`,
    `# HELP hack_arena_scanner_blocks_silent_total Scanner blocks that raised no operator alert`,
    `# TYPE hack_arena_scanner_blocks_silent_total counter`,
    `hack_arena_scanner_blocks_silent_total ${_scannerSilentBlocks}`,
    // v6.16.14 — outstanding deferred-audit work counter. See
    // server.js:_deferAudit / runTxnWithMirrorBuffer. Steady-state
    // value should oscillate at low single digits; trending upward
    // is the canonical signal that setImmediate is starved (e.g.
    // a long blocking statement somewhere). Surfacing here lets the
    // operator see drain pressure in real time, not just from the
    // graceful-shutdown log line.
    `# HELP hack_arena_deferred_audit_pending Outstanding _deferAudit / mirror-buffer work in libuv micro-task pool`,
    `# TYPE hack_arena_deferred_audit_pending gauge`,
    `hack_arena_deferred_audit_pending ${deferredAuditPending()}`,
    // v6.16.16 — CxOne provisioning queue depth + lifetime drops.
    // The cap (CXONE_QUEUE_MAX) prevents unbounded growth; this
    // gauge lets operators see if the backlog is approaching it.
    // `dropped` is a counter (cumulative) — Prometheus rate() over
    // it surfaces sustained pressure.
    `# HELP hack_arena_cxone_queue_depth Pending CxOne provisioning tasks waiting for the 5-in-flight semaphore`,
    `# TYPE hack_arena_cxone_queue_depth gauge`,
    `hack_arena_cxone_queue_depth ${cxOneQueueDepth()}`,
    `# HELP hack_arena_cxone_queue_inflight CxOne provisioning HTTP calls currently in flight`,
    `# TYPE hack_arena_cxone_queue_inflight gauge`,
    `hack_arena_cxone_queue_inflight ${cxOneInflight()}`,
    // ext-audit v7.15.15 — detached bulk-email sends still running after their
    // request replied. Non-zero for a sustained period means SMTP is degraded
    // and admins are seeing provisional counts; the shutdown drain waits on it.
    `# HELP hack_arena_detached_email_pending Bulk email sends still running after their request returned`,
    `# TYPE hack_arena_detached_email_pending gauge`,
    `hack_arena_detached_email_pending ${detachedFanoutPending()}`,
    // Mails being sent or waiting for a pooled SMTP connection (lib/email.js):
    // in flight on one of its connections, or queued in sendEmailLogged for one.
    `# HELP hack_arena_smtp_sends_pending Mails being sent or waiting for a pooled SMTP connection, not yet answered`,
    `# TYPE hack_arena_smtp_sends_pending gauge`,
    `hack_arena_smtp_sends_pending ${smtpSendsPending()}`,
    // ext-audit v7.20.9 (F8) — detached group→competition reconciliation passes,
    // queued or running. Non-zero for a sustained period means a very large bind
    // is still draining; the shutdown drain waits on it too.
    `# HELP hack_arena_reconcile_drain_pending Group-to-competition membership reconciliation passes queued but not yet run`,
    `# TYPE hack_arena_reconcile_drain_pending gauge`,
    `hack_arena_reconcile_drain_pending ${reconcileDrainPending()}`,
    `# HELP hack_arena_cxone_queue_dropped_total CxOne tasks dropped due to queue overflow (FIFO)`,
    `# TYPE hack_arena_cxone_queue_dropped_total counter`,
    `hack_arena_cxone_queue_dropped_total ${cxOneQueueDropped()}`,
    // Errors with no other witness: an ignored error swallowed() could not
    // write to the log, and a log line lib/log.js could not write.
    `# HELP hack_arena_swallow_unrecorded_total Deliberately ignored errors that could not be written to the log`,
    `# TYPE hack_arena_swallow_unrecorded_total counter`,
    `hack_arena_swallow_unrecorded_total ${unrecordedSwallowCount()}`,
    `# HELP hack_arena_log_write_failures_total Log writes, rotations and console mirrors that failed`,
    `# TYPE hack_arena_log_write_failures_total counter`,
    `hack_arena_log_write_failures_total ${logWriteFailureCount()}`,
  ];
  // v8.12.7 — Checkmarx One accounts the platform created for since-deleted
  // participants. The gauge is what is still waiting (by state); the counter is
  // every outcome the runner reached since boot. `needs_attention`, `held`,
  // `given_up` and `unmarked` are what the superadmin banner counts, so a
  // sustained non-zero there is a decision nobody has taken yet. The
  // past-retention gauge is read from the same rows (it is not a state): no row
  // is dropped for its age, so it counts the ones kept past the window.
  try {
    const wrows = listCxOneWithdrawals();
    const wc = cxOneWithdrawalCounts({ rows: wrows });
    lines.push(`# HELP hack_arena_cxone_withdrawals Checkmarx One accounts of deleted participants still awaiting removal, by state`,
      `# TYPE hack_arena_cxone_withdrawals gauge`);
    for (const st of ["retrying", "held", "needs_attention", "given_up", "unmarked"]) lines.push(`hack_arena_cxone_withdrawals{state="${st}"} ${wc[st] || 0}`);
    lines.push(`# HELP hack_arena_cxone_withdrawals_past_retention Checkmarx One account removals still unresolved although scheduled longer ago than EVENT_RETENTION_DAYS (kept, never dropped)`,
      `# TYPE hack_arena_cxone_withdrawals_past_retention gauge`,
      `hack_arena_cxone_withdrawals_past_retention ${cxOneWithdrawalPastRetentionCount({ rows: wrows })}`);
    const wt = cxOneWithdrawalTotals();
    lines.push(`# HELP hack_arena_cxone_withdrawals_total Checkmarx One account-removal outcomes since boot, by result`,
      `# TYPE hack_arena_cxone_withdrawals_total counter`);
    for (const k of ["withdrawn", "already_gone", "transferred", "held", "failed", "given_up"]) lines.push(`hack_arena_cxone_withdrawals_total{result="${k}"} ${wt[k] || 0}`);
    lines.push(`# HELP hack_arena_cxone_provision_retries_pending Checkmarx One set-ups deferred because the account they reached was being removed, waiting to retry`,
      `# TYPE hack_arena_cxone_provision_retries_pending gauge`,
      `hack_arena_cxone_provision_retries_pending ${cxOneProvisionRetriesPending()}`);
    const dc = cxOneProvisionDeferredCounts();
    lines.push(`# HELP hack_arena_cxone_provision_deferred_total Checkmarx One set-ups not linked to an account the platform was removing, since boot, by reason`,
      `# TYPE hack_arena_cxone_provision_deferred_total counter`);
    for (const k of ["removal_in_flight", "removal_outcome_unknown", "recently_removed", "removal_raced_match"]) lines.push(`hack_arena_cxone_provision_deferred_total{reason="${k}"} ${dc[k] || 0}`);
    // A realm account the platform may have created but could not RECORD — the
    // one population the ledger cannot see, so the only signal it gets.
    const uc = cxOneCreateUnconfirmedCounts();
    lines.push(`# HELP hack_arena_cxone_create_unconfirmed_total Checkmarx One account creations the platform could not confirm or record, by reason`,
      `# TYPE hack_arena_cxone_create_unconfirmed_total counter`);
    for (const k of ["no_location", "non_201", "id_not_uuid", "post_unanswered", "ledger_write_failed"]) lines.push(`hack_arena_cxone_create_unconfirmed_total{reason="${k}"} ${uc[k] || 0}`);
  } catch (e) { try { console.warn("[metrics] cxone withdrawal families unavailable:", e.message); } catch (_err) { swallowed("server:best-effort", _err); } }
  // v6.12.13 — per-route latency + request-count lines. Keyed on the
  // matched Express route pattern (`GET /api/tasks/:id` etc) so path
  // cardinality stays bounded regardless of how many distinct task
  // UUIDs have been hit. Only routes with >0 samples are emitted so the
  // scrape body stays small on a freshly-booted instance.
  lines.push(
    `# HELP hack_arena_latency_by_route_ms Per-route latency quantiles (rolling ${_PER_ROUTE_RESERVOIR}-sample reservoir per route)`,
    `# TYPE hack_arena_latency_by_route_ms summary`,
  );
  for (const [key, bucket] of _perRouteMetrics) {
    if (bucket.filled === 0) continue;
    const esc = key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    lines.push(
      `hack_arena_latency_by_route_ms{route="${esc}",quantile="0.5"} ${_perRoutePercentile(bucket, 0.5)}`,
      `hack_arena_latency_by_route_ms{route="${esc}",quantile="0.95"} ${_perRoutePercentile(bucket, 0.95)}`,
      `hack_arena_latency_by_route_ms{route="${esc}",quantile="0.99"} ${_perRoutePercentile(bucket, 0.99)}`,
      `hack_arena_requests_by_route_total{route="${esc}"} ${bucket.count}`,
    );
  }
  lines.push(``);
  // v6.16.7 — populate the 1-s response cache.
  const _body = lines.join("\n");
  _metricsCache = { ts: _nowMs, body: _body };
  res.set("Content-Type", "text/plain; version=0.0.4");
  res.send(_body);
});

// v6.8.5 — operator-triggered test email. Superadmin-only. Sends a small
// self-test message to a specified recipient and returns success/failure
// inline instead of asking the operator to grep the log file. Useful after
// SMTP credential rotation or a DNS change.
// POST /api/admin/test-email + GET/DELETE /api/admin/unsubscribed now live in
// routes/admin-misc.js (registered above).

// ── Admin settings ──────────────────────────────────────────────────────────

// Settings routes (GET/PATCH /api/admin/settings + GET /api/admin/settings/events)
// now live in routes/settings.js (registered here; absolute method-specific paths).
require("./routes/settings")(app);

// ── Event history (read-only admin audit endpoints) ────────────────────────
// Pagination: ?offset=<n>&limit=<n>. Response shape: {events, total, offset, limit}.
// For backward compatibility: if neither offset nor limit is provided, returns
// a plain array (legacy clients) capped at 500.
// _parseEventRows / _paginationParams / _applySnapshotFilter / _eventListResponse
// live in lib/audit.js — the row-stable pagination of the four audit-history
// routes (competition, session and participant events in routes/events.js, and
// settings events in routes/settings.js). The submissions and logs lists in this
// file parse their own offset and snapshot; the only paging code they share with
// the history routes is lib/util's clampPagingIndex (v8.13.3 — this used to say
// they shared these helpers, which they never did).


// v6.10.50 — response cache for /api/admin/competitions/:id/events.
// Same playbook as the admin_participants cache (v6.10.47): admin
// dashboards poll the history dialog at the same 15-30 s cadence,
// and each call does COUNT + SELECT on competition_events (the
// table grows linearly with every state-change). Latest perf run
// p(90) = 1.78 s vs 1.5 s threshold — repeated identical polls
// rebuild the same response every time. 5-s TTL collapses them.
//
// Invalidation is centralised inside `recordCompetitionEvent` —
// every INSERT into competition_events funnels through that one
// function, so a single invalidate() call there covers all writers
// (competition CRUD, end-now, assign, remove, revive, ts ops, ...).
// Compare with admin_participants which had to thread invalidation
// through 14 separate routes.
// Admin event-history routes (competition/timeslot/participant events) now
// live in routes/events.js (registered here).
require("./routes/events")(app);
// The Audit page's one stream over every recorded act (GET /api/admin/audit).
require("./routes/audit")(app);
// (GET /api/admin/settings/events is registered by routes/settings.js, above.)

// Admin read access to the JSONL server logs. Reads the file corresponding to
// the requested date (or today) and returns paginated most-recent-first entries,
// optionally filtered by minimum level, a since timestamp, and a free-text query.
//
// Redaction policy for non-superadmin callers. Two tiers:
//
//   Always-redacted (account-compromise material — a regular admin MUST NOT
//   see these regardless of operational need):
//     1. Superadmin password. The boot-time banner printed by
//        logSuperadminPassword() is console.log-mirrored into app.jsonl with
//        the fixed prefix "Superadmin password: <value>". We match that
//        pattern with a stateless regex so prior-session passwords embedded
//        in old log files stay redacted across restarts/upgrades without
//        needing to persist historical secrets on disk. The in-memory
//        _superadminPasswordHistory set is an additional defence-in-depth
//        layer that covers the password value if it ever leaks into a log
//        entry via a channel other than the banner format (current session
//        only; not relied on for post-restart correctness).
//     2. Capability codes in URL query strings (`?code=…`: the verify link,
//        the email-change confirmation, /credential). These ride in the
//        access-log `path` field; a leaked one acts on the target account.
//        audit v7.7.38 (SEC1):
//        `code=` is now ALSO scrubbed at WRITE time by `_scrubLogPath`, so the raw
//        code never reaches disk at all (the read-time rule below is retained as
//        defence-in-depth + to redact any legacy pre-v7.7.38 log lines).
//
//   Visible to regular admins (operational need > privacy cost for a time-
//   boxed hackathon platform):
//     • Email addresses — admins need to contact users during incidents.
//     • IP addresses — admins need to identify abuse sources and correlate
//       brute-force patterns. (Re-tighten here if the deployment context ever
//       changes to require IP blinding.)
//     • First / last name — admins need to know who they're dealing with.
//
// Regex replacements are applied to the JSON-encoded form of the row so they
// catch values in both top-level fields and nested context objects.
// Reverse-streaming line reader (v6.8.0). Opens the file, seeks from EOF
// backwards in 64 KB chunks, and yields complete lines in newest-first
// order without ever loading the full file into memory. Used by the admin
// logs pane — critical because rotated files can hit 500 MB and the old
// fs.readFile+split approach blew the heap every time an admin opened the
// Logs tab. The reader is a true async generator; callers consume via
// `for await (const { text, start } of _readLinesReverse(path))` and can break
// early to stop the stream the moment they've found enough entries. `start` is
// the byte offset the line begins at, and `end` reads only the bytes before it:
// the Audit log's Next resumes exactly below a row (`[file, start]`, its cursor).
async function* _readLinesReverse(filePath, chunkSize = 64 * 1024, end = Infinity) {
  const stat = await fs.promises.stat(filePath);
  let pos = Math.min(stat.size, end);
  if (!(pos > 0)) return;
  const fh = await fs.promises.open(filePath, "r");
  try {
    // audit v7.7.37 (C3) — accumulate RAW BYTES and only decode COMPLETE lines.
    // Pre-fix each 64 KB chunk was `buf.toString("utf8")`-decoded independently, so a
    // multi-byte UTF-8 char straddling the read boundary decoded to U+FFFD in both
    // halves (mojibake + a `q=` substring filter then missed that line). A newline
    // (0x0A) never occurs inside a multi-byte sequence, so scanning the byte buffer
    // for it is safe and every sliced line is complete, valid UTF-8.
    let pending = Buffer.alloc(0);
    while (pos > 0) {
      const readSize = Math.min(chunkSize, pos);
      pos -= readSize;
      const buf = Buffer.alloc(readSize);
      await fh.read(buf, 0, readSize, pos);
      pending = Buffer.concat([buf, pending]);
      let nl;
      while ((nl = pending.lastIndexOf(0x0A)) !== -1) {
        const line = pending.subarray(nl + 1);
        pending = pending.subarray(0, nl);
        yield { text: line.toString("utf8"), start: pos + nl + 1 };
      }
    }
    if (pending.length) yield { text: pending.toString("utf8"), start: 0 };
  } finally {
    await fh.close();
  }
}

const _CODE_REDACT_RE = /([?&]code=)[^&"\s]+/g;
// The banner printed at startup / after rotation is the one known channel that
// leaks a plaintext superadmin password into app.jsonl. Matching the prefix
// rather than specific password values means this redaction is stateless and
// survives restarts (a process restarted against old log files will still
// scrub prior sessions' banners). The negative character class stops at the
// first whitespace or JSON string terminator so the password value — whatever
// character set it uses — is captured fully.
const _SUPERADMIN_BANNER_RE = /(Superadmin password: )[^\s"]+/g;
function redactLogEntryForRegularAdmin(entry) {
  let json;
  try { json = JSON.stringify(entry); } catch { return entry; }
  json = json.replace(_SUPERADMIN_BANNER_RE, "$1[REDACTED]");
  for (const p of _superadminPasswordHistory) {
    if (p) json = json.split(p).join("[REDACTED]");
  }
  json = json.replace(_CODE_REDACT_RE, "$1[REDACTED]");
  try { return JSON.parse(json); } catch { return entry; }
}

// Enrichment: bulk-resolve user GUIDs (access-log `user_id` field and audit-log
// `scope_id` on user-scope rows) to current identifying fields (email, first
// name, last name). Done in one DB query per response so per-line lookups
// stay O(1) in memory and we don't hit the DB once per row. Log files
// intentionally store GUIDs (stable, immune to profile changes); the
// human-readable fields are a display-time affordance.
function _enrichLogRowsWithUserDetails(rows) {
  const ids = new Set();
  const emails = new Set();
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    if (r.user_id && typeof r.user_id === "string" && r.user_id !== "superadmin") ids.add(r.user_id);
    if (r.source === "audit" && r.scope === "user" && r.scope_id) ids.add(r.scope_id);
    // v6.16.19 — also resolve `changed_by` (the actor on non-user-scope
    // audit rows: competition / timeslot / settings / security edits).
    // Pre-fix the Actor column for those rows showed only a bare email
    // even though the JSONL line carried the actor object — the
    // server-side enrichment never computed it for legacy lines that
    // pre-date v6.16.19. Resolve here so the UI can render names.
    if (r.changed_by && typeof r.changed_by === "string") {
      const cb = r.changed_by;
      if (cb.includes("@")) emails.add(cb.toLowerCase());
      else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cb)) ids.add(cb);
    }
  }
  if (!ids.size && !emails.size) return;
  const m = new Map();
  const groupsById = new Map(); // v6.20.0 — participant group names for the Groups column
  if (ids.size) {
    const idArr = [...ids];
    const ph = "SELECT value FROM json_each(?)";
    const found = db.prepare(`SELECT id, email, first_name, last_name FROM users WHERE id IN (${ph})`).all(JSON.stringify(idArr));
    for (const u of found) m.set(u.id, u);
    for (const g of db.prepare(
      `SELECT gm.user_id, gr.name FROM group_members gm JOIN groups gr ON gr.id=gm.group_id
       WHERE gm.user_id IN (${ph}) ORDER BY gr.name COLLATE NOCASE`
    ).all(JSON.stringify(idArr))) {
      if (!groupsById.has(g.user_id)) groupsById.set(g.user_id, []);
      groupsById.get(g.user_id).push(g.name);
    }
  }
  // Email lookup runs separately so a single-row email match doesn't
  // bloat the IN(...) for the id case.
  // Matched on the PRIMARY address only, one search of its NOCASE index: a
  // secondary is an unconfirmed claim anyone can make about an address, so a
  // log row is never attributed to whoever lists it as theirs.
  const emailMap = new Map();
  if (emails.size) {
    const found = findUsersByPrimaryList(db, [...emails], "id, email, first_name, last_name");
    for (const u of found) {
      if (u.email) emailMap.set(u.email.toLowerCase(), u);
    }
  }
  const attach = (r, id) => {
    const u = m.get(id);
    if (!u) return;
    r.user_email = u.email;
    r.user_first_name = u.first_name || null;
    r.user_last_name = u.last_name || null;
    r.user_groups = groupsById.get(id) || []; // v6.20.0
  };
  const attachActor = (r, u) => {
    if (!u) return;
    r.actor_email = u.email;
    r.actor_first_name = u.first_name || null;
    r.actor_last_name = u.last_name || null;
  };
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    if (r.user_id && m.has(r.user_id)) attach(r, r.user_id);
    else if (r.source === "audit" && r.scope === "user" && r.scope_id && m.has(r.scope_id)) attach(r, r.scope_id);
    if (r.changed_by && typeof r.changed_by === "string") {
      const cb = r.changed_by;
      if (cb.includes("@") && emailMap.has(cb.toLowerCase())) attachActor(r, emailMap.get(cb.toLowerCase()));
      else if (m.has(cb)) attachActor(r, m.get(cb));
    }
  }
}

// Rate-limited so a compromised admin token can't trivially exfiltrate every
// historical log file via rapid requests. The cap is generous for normal UI
// browsing (one tab paging) but slows scripted bulk pulls.
// v6.4.0: handler is async so the fs.promises.readFile() inside yields the
// event loop during disk I/O. Pre-fix the readFileSync blocked the entire
// process for 500ms+ per 500 MB file — one admin browsing logs with a
// search term stalled every participant's in-flight request.
// v6.9.20: rate limiter was previously in front of requireAdmin so
// unauthenticated requests also burned the 60/min bucket for the
// caller's IP — admins sharing an office IP could deny each other
// via a single bot probe. Moving requireAdmin ahead means only
// authenticated-admin traffic counts against the bucket. Anonymous
// callers still get the 401 from requireAdmin without polluting
// the limiter's per-IP bookkeeping.
// v6.8.5: hard scan-budget. With a highly-selective filter (q matches almost
// nothing, or a deep offset) the walk can otherwise scan tens of millions of
// lines. Cap the lines scanned per request — well beyond any legitimate
// pagination depth, but it guarantees the worst-case slow path cannot stall the
// event loop for more than a few hundred ms.
//
// v7.25.0 — env-readable. It is the one thing that decides whether a filtered
// read can report an exact total, and therefore whether the pager's page count,
// Last button and page-jump are live; an operator with a very large log and a
// fast disk may reasonably want it higher. It is also what lets a test reach
// the "the ranking covers only what was scanned" branch without planting a
// 200 000-line fixture.
const LOG_SCAN_BUDGET = Math.max(1000, parseInt(process.env.LOG_SCAN_BUDGET, 10) || 200_000);
// The deepest (offset + limit) a globally-sorted read will serve. Peak
// retention is 2× this many parsed rows — measured at ~558 B each, so ~28 MB at
// the default. Beyond it the read falls back to page-local ordering and says
// why. Raising it is one constant with a linear, stated cost.
const LOG_SORT_MAX_WINDOW = Math.max(100, parseInt(process.env.LOG_SORT_MAX_WINDOW, 10) || 25_000);
// One globally-sorted walk at a time, process-wide. See the note at its use.
let _logSortInFlight = false;
// RAW LOGS' AUDIT LOG PAGES LIKE THE AUDIT TRAIL (operator ruling, 17 Nov 2026,
// "Page like the trail"): its first read is counted, up to the trail's own cap;
// a later read answers no count and stops at its page; Next goes by a cursor, a
// byte position below the page's last row (or below the last line examined when
// LOG_SCAN_BUDGET cut the walk, with `searched_to`), so it costs the same at any
// depth. The Request log keeps a count on every read and issues no cursor: it is
// the hot file, polled every 15 s, and nothing asked to change it.
const LOG_COUNT_MAX = require("./routes/audit").AUDIT_COUNT_MAX;
// A cursor is `[file, position, inode]`, opaque on the wire. The file must be
// one of THIS stream's files (the readdir list the walk itself uses, never a
// path built from the request), found by its identity: a size rotation renames
// the file it was read in and opens a new one under the old name, so a cursor
// follows its inode to the rotated name (whose place in the walk is the same);
// a file whose inode is gone, or a position past its end, is refused.
function _logFileStat(f) {
  try { return fs.statSync(path.join(LOG_DIR, f)); } catch (e) { swallowed("server:logs-cursor-stat", e); return null; }
}
function _encodeLogCursor(at) {
  const st = _logFileStat(at.f);
  return Buffer.from(JSON.stringify([at.f, at.p, st ? st.ino : null]), "utf8").toString("base64url");
}
function _decodeLogCursor(raw, files) {
  if (typeof raw !== "string" || !raw || raw.length > 400) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length !== 3 || !Number.isSafeInteger(v[1]) || v[1] < 0 || !Number.isFinite(v[2])) return null;
    let f = files.find(x => x === v[0]);
    let st = f ? _logFileStat(f) : null;
    if (!st || st.ino !== v[2]) {
      f = files.find(x => { const sx = _logFileStat(x); return !!sx && sx.ino === v[2]; });
      st = f ? _logFileStat(f) : null;
    }
    if (!f || !st || v[1] > st.size) return null;
    return { f, p: v[1] };
  } catch (e) { swallowed("server:logs-cursor-decode", e); return null; }
}

app.get("/api/admin/logs", requireAdmin, rateLimit(60_000, 60, "adminlogs"), async (req, res) => {
  const stream = req.query.stream === "access" ? "access" : "app";
  const minLevel = LOG_LEVELS[(typeof req.query.level === "string" ? req.query.level : "").toLowerCase()] || null; // audit v7.7.38 (H2) — type-guard: an array `level` → .toLowerCase() → 500
  const since = req.query.since ? Date.parse(req.query.since) : null;
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));
  // v8.13.3 (OC-5) — the ONE paging-index definition. Never a 500 here (the
  // offset only feeds JS arithmetic over the file walk), but an Infinity offset
  // echoed as `"offset": null`; it now echoes the cap.
  const offset = clampPagingIndex(req.query.offset);
  const q = (req.query.q || "").toString().trim().toLowerCase();
  const groupFilterId = (req.query.groupId || "").toString().trim(); // v6.20.0 — filter to a group's current members
  const isSuperAdmin = !!req.session.isSuperAdmin;

  // ── v7.25.0: ordering ─────────────────────────────────────────────────────
  //
  // Sorting used to be purely client-side over the rows in hand, and the pager
  // honestly said "Sorted within this page". That is useless for the job this
  // tab exists for: filter to one address, then reach its OLDEST request. The
  // oldest row is on the last page by construction, so a page-local sort can
  // never surface it.
  //
  // A FILTERED read now sorts globally. An UNFILTERED one deliberately does
  // not: that set is the whole on-disk history, so ranking it would mean
  // walking every rotated file on every 15-second poll, and the operator has a
  // search box. `sortable_globally` is echoed so the client never has to mirror
  // this predicate — a drifted mirror here would produce a plausible NOTE
  // rather than an error, which is the worst way for it to be wrong.
  const sortKeyRaw = (req.query.sort || "").toString().trim();
  // Ignore an unrecognised column, never reject it (the v7.21.16 posture): the
  // value comes from a header click, so a stale client asking for a retired
  // column must still get rows. `has` on a Set, so nothing from a prototype
  // can smuggle through.
  const sortKey = LOG_SORT_COLUMNS.has(sortKeyRaw) ? sortKeyRaw : null;
  const sortDir = (req.query.dir || "").toString().trim().toLowerCase() === "asc" ? "asc" : "desc";
  // The walk IS newest-first, so ts DESC is the default and asking for it
  // explicitly must not cost the fast path — otherwise a client echoing its own
  // sort state downgrades every poll onto the exhaustive walk.
  const sortIsDefault = !sortKey || (sortKey === "ts" && sortDir === "desc");
  // Exactly the set the early-stop guard below already treats as "filtered", so
  // this handler holds ONE definition of the word. `date` is deliberately not
  // in it: a single day of the access log during a live event is not a narrow
  // set, and `date` alone still early-stops. `anchor` is not a filter at all —
  // it removes only rows NEWER than a pin, and if it qualified then page 1 of a
  // view would sort page-locally while page 2 of the same view sorted globally.
  const hasNarrowingFilter = !!(q || minLevel || since || groupFilterId);
  // Retention is bounded by offset+limit, not by the size of the matched set —
  // see the selection below — so the only input that can blow memory is the
  // paging depth, which is known from the query string before any file is
  // opened. That is what makes this ONE decision, taken up front, with no
  // abandon-and-redo path.
  const sortWindow = offset + limit;
  const sortableGlobally = hasNarrowingFilter && sortWindow <= LOG_SORT_MAX_WINDOW;
  // A globally-sorted walk reads to exhaustion and retains up to 2×(offset+limit)
  // parsed rows. One at a time, process-wide: the per-route 60/min limiter is
  // bypassed for an allowlisted venue address (v7.16.0), so N admins on the
  // room's Wi-Fi could otherwise run N of these concurrently in a
  // single-process server. A second caller falls back to page-local ordering
  // and is TOLD so, rather than queueing behind a walk it cannot see.
  const wantsGlobalSort = !sortIsDefault && sortableGlobally;
  // A page read by position (the Audit log's `cursor`, see LOG_COUNT_MAX) is a
  // stretch of the walk in its own order, so it is never ranked globally: a sort
  // then reorders only that page, and says so (`cursor`). A ranked list pages
  // from its first page by offset (the client starts a global sort there).
  const cursorRaw = (req.query.cursor || "").toString().trim();
  const globalSort = wantsGlobalSort && !_logSortInFlight && !cursorRaw;
  let sortUnavailable = null;
  if (!sortIsDefault) {
    if (!hasNarrowingFilter) sortUnavailable = "unfiltered";
    else if (sortWindow > LOG_SORT_MAX_WINDOW) sortUnavailable = "window_too_deep";
    else if (cursorRaw) sortUnavailable = "cursor";
    else if (!globalSort) sortUnavailable = "busy";
  }

  // File list to walk: honour an explicit ?date=YYYY-MM-DD for back-compat
  // (single-day view) OR — default — walk EVERY rotated file for this stream,
  // newest-first, so a scrolling admin can page seamlessly backwards across
  // days without hunting through a date picker. Filenames lex-sort by date,
  // and size-overflow rotations (`app-YYYY-MM-DD-HH-MM-SS.jsonl`) sort after
  // the parent day as expected.
  const dateExplicit = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date);
  let filesToScan;
  if (dateExplicit) {
    const f = path.join(LOG_DIR, `${stream}-${req.query.date}.jsonl`);
    filesToScan = fs.existsSync(f) ? [path.basename(f)] : [];
  } else {
    try {
      filesToScan = fs.readdirSync(LOG_DIR)
        .filter(f => new RegExp(`^${stream}-.*\\.jsonl$`).test(f))
        .sort((a, b) => b.localeCompare(a)); // newest filename first
    } catch (_) { filesToScan = []; }
  }

  // Timestamp-anchored pagination (v7.0.2, replaces the v6.2.6 file-hash
  // snapshot). Page 1 sends no anchor and reads the live newest-first window,
  // so freshly-appended entries are visible. Pages 2+ echo back the head
  // entry's timestamp via ?anchor=<ISO ts>; the walk then skips anything
  // newer, pinning the window so rows appended while the admin reads deeper
  // pages can't shift it (which would duplicate rows across page boundaries).
  // The old snapshot fingerprinted every file's (name, size, mtime) and
  // returned snapshot_changed → reset-to-page-1 on ANY change; because the
  // access log grows on every request (including the admin's own poll), that
  // tripped on every fetch and made page 2 permanently unreachable. Anchoring
  // by ts also subsumes rotation safety: a rotated-in newer file has ts >
  // anchor (excluded); older rotated files have ts <= anchor (included in
  // order). The response echoes `anchor_ts` (the newest matching entry's ts)
  // for the client to pin on its next page.
  const anchorRaw = (req.query.anchor || "").toString().trim();
  const anchorMs = anchorRaw ? Date.parse(anchorRaw) : NaN;
  const hasAnchor = Number.isFinite(anchorMs);
  // The one predicate that splits the two streams' paging (see LOG_COUNT_MAX).
  const pagesLikeTrail = stream === "app";
  let cur = null;
  if (cursorRaw) {
    if (hasAnchor) return res.status(400).json({ error: "Send a cursor or an anchor, not both.", code: "logs_position_conflict" });
    cur = pagesLikeTrail ? _decodeLogCursor(cursorRaw, filesToScan) : null;
    if (!cur) return res.status(400).json({ error: "That page link is not valid. Start again from the first page.", code: "logs_cursor_invalid" });
  }
  // Only the first read is counted on the Audit log (no anchor, no cursor, offset 0).
  const firstRead = !hasAnchor && !cur && offset === 0;

  if (!filesToScan.length) {
    return res.json({ entries: [], file: null, files_scanned: [], count: 0, total: 0, offset, limit, redacted: !isSuperAdmin, anchor_ts: null,
      total_exact: true, truncated_reason: null, total_pages: 1, has_more: false, next_cursor: null, searched_to: null, offset_max: PAGING_INDEX_MAX });
  }

  // Resolve q against the users table once so per-line filtering accepts
  // rows that reference a matching GUID even when the raw JSON only has the
  // GUID itself. Email substring match catches "alice@" / "@acme.com".
  const qUserIds = new Set();
  if (q) {
    try {
      // Escape SQL LIKE wildcards (%, _) so literal searches work as
      // expected — same treatment as /api/admin/submissions (v6.4.0).
      const _logQEsc = q.replace(/[%_\\]/g, "\\$&");
      const pattern = `%${_logQEsc}%`;
      // secondary_email is COALESCE'd because the column is nullable and
      // LOWER(NULL) LIKE '%anything%' evaluates to NULL (falsy) — so rows
      // with no secondary wouldn't match anyway, but COALESCE makes that
      // explicit and keeps the query planner happy on all SQLite versions.
      // secondary_email must be searchable because it is an address the user
      // owns and is mailed at (it never signs in), so admins searching
      // logs by "the address a user actually uses" must find them.
      const hits = db.prepare(
        "SELECT id FROM users WHERE LOWER(first_name) LIKE ? ESCAPE '\\' OR LOWER(last_name) LIKE ? ESCAPE '\\' OR LOWER(email) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(secondary_email,'')) LIKE ? ESCAPE '\\' OR LOWER(nickname) LIKE ? ESCAPE '\\'"
      ).all(pattern, pattern, pattern, pattern, pattern);
      for (const u of hits) qUserIds.add(u.id);
      // v6.20.0 — a search term that matches a group name surfaces that
      // group's members' rows, so admins can search logs "by group".
      const gPattern = `%${_logQEsc}%`;
      for (const gm of db.prepare(
        "SELECT gm.user_id FROM group_members gm JOIN groups g ON g.id=gm.group_id WHERE LOWER(g.name) LIKE ? ESCAPE '\\'"
      ).all(gPattern)) qUserIds.add(gm.user_id);
    } catch (_err) { /* best-effort; fall back to raw-line match only */ swallowed("server:logs-parse-line", _err); }
  }

  // v6.20.0 — resolve the explicit group filter to its current member set.
  let groupMemberIds = null;
  if (groupFilterId) {
    groupMemberIds = new Set(db.prepare("SELECT user_id FROM group_members WHERE group_id=?").all(groupFilterId).map(r => r.user_id));
  }

  // Walk files newest-first; within each file walk lines newest-first via a
  // reverse chunked reader (v6.8.0). Pre-v6.8.0 this loaded the full file
  // into memory with fs.promises.readFile — for a 500 MB access log that
  // meant allocating the whole file per request, which blew up under
  // concurrent admins and stalled the event loop during parse. The reader
  // below seeks from EOF backwards in 64 KB chunks and yields complete
  // lines newest-first, so the common "look at the last 50 entries" page
  // stops after one or two chunks regardless of file size.
  let total = 0;
  let headTs = null;       // newest entry past every filter → the anchor the client pins
  let truncated = false;
  let sinceBoundHit = false;
  const entries = [];
  const filesTouched = [];
  let scanned = 0;
  let scanBudgetHit = false;
  let earlyStopHit = false;
  // v7.25.0 — the globally-sorted selection. `cand` holds at most
  // HIGH_WATER = 2×(offset+limit) rows: everything ranked worse than the
  // requested window can be discarded the moment it is known to be worse, so
  // retention scales with PAGING DEPTH and not with the size of the matched set
  // (which is what makes the cap decidable from the query string alone).
  //
  // Batch-trim rather than a binary heap, deliberately: a heap needs its own
  // sift ordering, which is a second implementation of the comparator and
  // exactly the drift this codebase keeps rediscovering. Here ONE comparator
  // does the trim and the final ordering.
  const HIGH_WATER = sortWindow * 2;
  const cmp = globalSort ? makeLogComparator(sortKey, sortDir) : null;
  const cand = globalSort ? [] : null;
  let walkSeq = 0;
  // Where the walk is: the last line examined (a budget cut's continuation) and
  // its time, and the page's last row (Next reads below it).
  let lastSeen = null, lastSeenTs = null, pageEnd = null;
  // ONE stop point. The Request log's is the old early stop, verbatim: only a
  // fully unfiltered, unanchored page stops at its page plus one (an active
  // filter or anchor makes `total` a count worth finishing). The Audit log's first
  // read counts to the trail's cap; any later read stops at its page plus one.
  // A globally-sorted read always walks to exhaustion.
  const stopAt = globalSort ? Infinity
    : pagesLikeTrail ? (firstRead ? LOG_COUNT_MAX + 1 : offset + limit + 1)
      : ((!q && !minLevel && !since && !groupMemberIds && !hasAnchor) ? offset + limit + 1 : Infinity);
  if (globalSort) _logSortInFlight = true;
  try {
  outer: for (const fname of (cur ? filesToScan.slice(filesToScan.indexOf(cur.f)) : filesToScan)) {
    const filePath = path.join(LOG_DIR, fname);
    let contributed = false;
    try {
      for await (const { text: line, start } of _readLinesReverse(filePath, undefined, cur && fname === cur.f ? cur.p : Infinity)) {
        if (!line) continue;
        if (++scanned > LOG_SCAN_BUDGET) { scanBudgetHit = true; truncated = true; break outer; }
        lastSeen = { f: fname, p: start };
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (row && row.ts) lastSeenTs = row.ts;
        if (minLevel && (LOG_LEVELS[row.level] || 0) < minLevel) continue;
        if (since && row.ts && Date.parse(row.ts) < since) { sinceBoundHit = true; break outer; }
        if (q) {
          const rawMatch = line.toLowerCase().includes(q);
          const scopeId = row.source === "audit" && row.scope === "user" ? row.scope_id : null;
          const userHit = (row.user_id && qUserIds.has(row.user_id)) || (scopeId && qUserIds.has(scopeId));
          if (!rawMatch && !userHit) continue;
        }
        if (groupMemberIds) {
          // v6.20.0 — keep only rows tied to a participant in the filtered group.
          const scopeId = row.source === "audit" && row.scope === "user" ? row.scope_id : null;
          const pid = (row.user_id && row.user_id !== "superadmin") ? row.user_id : scopeId;
          if (!pid || !groupMemberIds.has(pid)) continue;
        }
        // v7.0.2 — anchor: pages 2+ pin to the head as it was when paging
        // began. Skip anything newer so rows appended mid-pagination can't
        // shift the window (and don't count toward the anchored total).
        if (hasAnchor && row.ts) {
          const t = Date.parse(row.ts);
          if (Number.isFinite(t) && t > anchorMs) continue;
        }
        // First row past every filter (newest-first walk) is the head — the
        // anchor timestamp the client echoes back on its next page.
        //
        // v7.25.0 — this stays computed from WALK order and must never be taken
        // from the sorted page. Under `ts` ASC the sorted page 1 holds the
        // OLDEST rows, so seeding the anchor from it would pin the next page to
        // an ancient ceiling and the admin would page forward into an empty
        // table.
        if (headTs === null && row.ts) headTs = row.ts;
        if (globalSort) {
          cand.push({ row, seq: walkSeq++, file: fname });
          if (cand.length >= HIGH_WATER) { cand.sort(cmp); cand.length = sortWindow; }
        } else if (total >= offset && entries.length < limit) {
          entries.push(row);
          pageEnd = { f: fname, p: start };
          contributed = true;
        }
        total++;
        if (total >= stopAt) {
          truncated = true;
          earlyStopHit = true;
          break outer;
        }
      }
    } catch (_err) { /* file disappeared mid-read (rotation race) — skip */ swallowed("server:logs-read-file", _err); }
    if (contributed) filesTouched.push(fname);
  }
  } finally { if (globalSort) _logSortInFlight = false; }
  if (globalSort) {
    cand.sort(cmp);
    for (const c of cand.slice(offset, offset + limit)) {
      entries.push(c.row);
      if (!filesTouched.includes(c.file)) filesTouched.push(c.file);
    }
  }
  _enrichLogRowsWithUserDetails(entries);
  const finalEntries = isSuperAdmin ? entries : entries.map(redactLogEntryForRegularAdmin);
  // The Audit log counts its first read only (a sorted read has walked everything
  // anyway); past the cap the count is a floor. `full`: rows match past this page.
  const counted = !pagesLikeTrail || firstRead || globalSort;
  const capHit = pagesLikeTrail && firstRead && earlyStopHit;
  const full = total > offset + limit;
  const shownTotal = capHit ? LOG_COUNT_MAX : total;
  res.json({
    entries: finalEntries,
    file: dateExplicit ? filesToScan[0] : null,      // back-compat for single-day responses
    files_scanned: filesTouched,                     // NEW: which rotated files contributed rows
    count: finalEntries.length,
    total: counted ? shownTotal : null,
    offset, limit,
    truncated: truncated || sinceBoundHit,
    redacted: !isSuperAdmin,
    anchor_ts: headTs,                               // v7.0.2 timestamp-anchored pagination
    // ── v7.25.0 ──────────────────────────────────────────────────────────────
    sort: sortKey, dir: sortKey ? sortDir : null,
    // Can this query be ranked as a whole? The client drives its copy from THIS
    // rather than re-deriving "is a filter applied", so the two can never
    // disagree about which ordering the rows are actually in.
    sortable_globally: sortableGlobally,
    // Did it happen? False when the scan budget cut the walk short, because a
    // ranking of the newest 200 000 matches is not a ranking of every match and
    // must not be presented as one.
    sorted_globally: globalSort && !scanBudgetHit,
    sort_scope: sortIsDefault ? "default"
      : (globalSort ? (scanBudgetHit ? "scanned_prefix" : "global") : "page"),
    // Why not, when a global sort was asked for and did not happen. A flag
    // whose reason has no client consumer is the defect class this repo names
    // explicitly, so the client renders one sentence per value.
    sort_unavailable: globalSort && scanBudgetHit ? "scan_budget" : sortUnavailable,
    sort_max_window: LOG_SORT_MAX_WINDOW,
    // `total` is exact unless the walk was cut short. NOT `!truncated`:
    // `sinceBoundHit` is a CLEAN stop — the walk is newest-first, so the first
    // row older than `since` proves every remaining row is out of scope — yet
    // it sets `truncated`, which made a `since`-filtered view render "N+" and
    // disable Last over a count that was exact. `truncated` keeps its old
    // meaning for any other consumer; this is the field the pager uses.
    total_exact: counted && !scanBudgetHit && !earlyStopHit,
    truncated_reason: scanBudgetHit ? "scan_budget" : capHit ? "count_cap" : earlyStopHit ? "early_stop" : sinceBoundHit ? "since_bound" : null,
    total_pages: counted ? Math.max(1, Math.ceil(shownTotal / limit)) : null,
    // Paging like the trail. `has_more`: matches lie past this page, or the walk
    // was cut before it could tell. `next_cursor` (the Audit log, in the walk's
    // own order, so not on a globally ranked read):
    // below this page's last row, else below the last line a cut walk examined.
    has_more: full || scanBudgetHit,
    next_cursor: pagesLikeTrail && !globalSort
      ? (full && pageEnd ? _encodeLogCursor(pageEnd) : (scanBudgetHit && lastSeen ? _encodeLogCursor(lastSeen) : null))
      : null,
    searched_to: pagesLikeTrail && scanBudgetHit && !full ? lastSeenTs : null,
    offset_max: PAGING_INDEX_MAX,
    scanned,
  });
});

// List available log files so admins can pick a date without guessing.
//
// v8.13.3 — TWO defects in one handler. (1) The failure answered
// `detail: e.message`, an fs error naming the ABSOLUTE log path (`ENOENT: no such
// file or directory, stat '/…/data/logs/access-….jsonl'`) — an undocumented field
// no client reads; it is logged now and the response says only what failed. (2)
// The per-file stat sat inside the ONE try, so a single entry that vanished
// between the readdir and its stat (`scripts/purge.sh` runs in another process) or
// a dangling one failed the WHOLE listing. Each entry is stat'ed on its own and an
// unreadable one is skipped, with a warn line naming it.
app.get("/api/admin/logs/files", requireAdmin, (req, res) => {
  let names;
  try {
    names = fs.readdirSync(LOG_DIR).filter(f => /^(access|app)-.*\.jsonl$/.test(f));
  } catch (e) {
    log.error({ ...reqContext(req), err: e && e.message, code: e && e.code }, "logs/files: could not read the log directory");
    return res.status(500).json({ error: "Failed to list log directory" });
  }
  const files = [];
  for (const f of names) {
    try {
      const st = fs.statSync(path.join(LOG_DIR, f));
      files.push({ name: f, size_bytes: st.size, modified_at: st.mtime.toISOString() });
    } catch (e) {
      log.warn({ ...reqContext(req), file: f, code: e && e.code }, "logs/files: skipped an entry that could not be stat'ed");
    }
  }
  files.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  res.json({ files });
});

// POST /api/admin/logout now lives in routes/auth.js (registered above).
// CSRF error handler — end a signed-in session and return an identifiable code so the frontend signs out
app.use((err, req, res, next) => {
  if (err.code === "EBADCSRFTOKEN") {
    req._csrfRefused = true; // read by the scanner count (_isStaleSessionRefusal)
    // v8.3.13 — KEEP AN ANONYMOUS SESSION, and the distinction is what makes
    // recovery possible. For an anonymous session a destroy was self-defeating —
    // the session being destroyed is the very session the retry needs, so a
    // single stale token at the login card became permanent for that page: the
    // client refetches, gets a token for a NEW session, and the browser is still
    // presenting the old cookie. That is the amplifier that turned a rare fault
    // into the reported "many situations", and it is why the fix has to be here
    // as well as in the client's retry. Nothing is weakened: an anonymous session
    // holds no identity and no privilege — it exists to carry a CSRF token — so
    // keeping it costs an attacker nothing, and the token they failed to guess is
    // unchanged. Since v8.13.4 that half is LOCKED (csrf-token-delivery reuses the
    // token minted before the refusal, which only the SAME session accepts); it
    // was recorded as defence in depth while its test refreshed the token, which
    // a destroyed session survives too.
    //
    // v8.13.4 — END EVERY SESSION THAT CARRIES AN IDENTITY (operator decision):
    // a user account, the built-in superadmin, and an impersonation session.
    // v8.3.13 meant exactly this ("destroy only an AUTHENTICATED session") and
    // keyed it on `userId`, which the built-in superadmin does not have — so its
    // session survived a refused token, the SPA's "Signed out" was false for it,
    // and the reload put it straight back into the admin panel. Before v8.3.13
    // the destroy was unconditional, so this restores the built-in's old
    // behaviour as well as matching v8.3.13's stated intent. Under `sameSite:
    // "lax"` a forged cross-site POST arrives without the session cookie, so a
    // refusal reaching an identity-bearing session is in practice a STALE token
    // (another tab's regenerate, an empty token after a throttled refresh) — it
    // is ended because its token no longer proves who holds it, not as evidence
    // of an attack, and the audit row below says no more than that.
    //
    // IN THIS ORDER, and the order is load-bearing: express-session's destroy()
    // deletes req.session synchronously, so everything that READS it — the
    // request context, the impersonation marker, the access-log actor — runs
    // first.
    const s = req.session;
    if (_sessionHasIdentity(s)) {
      // A session already purged elsewhere (a sign-in elsewhere, the idle sweep,
      // a second refused request on the same cookie in flight at once) had its
      // end recorded and any impersonation window closed by that path — record
      // nothing twice. DEFENCE IN DEPTH: that race cannot be scheduled from a
      // test, so csrf-session-end.api.spec.js pins it at source.
      if (!wasSessionPurged(req.sessionID)) {
        try {
          // INSIDE the try: under impersonation reqContext reads the acting
          // admin's row (getAdminIdentity), and a throw there must cost the
          // audit row, never the session end below (v8.13.4 review).
          const _csrfCtx = reqContext(req);
          const imp = s.impersonator;
          if (imp) {
            // v7.15.11 — any path that destroys a session closes the impersonation
            // window first. Every impersonation session carries the TARGET's userId,
            // so it has always been destroyed here — with no `impersonation_ended`,
            // leaving the target's History holding a window that never closed.
            _closeImpersonationWindowOnSessionReplace(req, "csrf_invalid");
            // The session is the ACTING admin's, so its end is recorded there and
            // NEVER on the target's row (the /api/logout rule: no fabricated session
            // event on a participant). `impersonated_by` is dropped — on the owner's
            // own row it would name them as their own impersonator — while
            // `acting_as` stays, saying whose seat they were in.
            if (imp.userId) {
              recordUserEvent(imp.userId, "sessions_invalidated", "system",
                { ..._csrfCtx, impersonated_by: undefined, reason: "csrf_invalid", purged: 1 });
            } else {
              recordOrphanedAuditEvent("session", req.sessionID, "sessions_invalidated", "system",
                { ..._csrfCtx, impersonated_by: undefined, reason: "csrf_invalid", purged: 1, principal: "superadmin" });
            }
          } else if (s.userId) {
            recordUserEvent(s.userId, "sessions_invalidated", "system",
              { ..._csrfCtx, reason: "csrf_invalid", purged: 1 });
          } else {
            // The built-in superadmin has no user row: an orphaned session-scope
            // line, the convention of `superadmin_login_success`.
            recordOrphanedAuditEvent("session", req.sessionID, "sessions_invalidated", "system",
              { ..._csrfCtx, reason: "csrf_invalid", purged: 1, principal: "superadmin" });
          }
        } catch (_err) { /* the audit must never stop the session ending */ swallowed("server:session-end-audit", _err); }
      }
      req._actorAtDestroy = _accessActor(req);
      s.destroy(() => {});
    }
    return res.status(403).json({ error: "csrf_invalid" });
  }
  next(err);
});

// v7.21.24 — turn a framework error into the two answers this handler owes:
// what to TELL the caller, and what to RECORD.
//
// Reported from a live competition as a log line reading, in its entirety,
// "Unhandled error: request entity too large" — no endpoint, no address, no
// user, no size. Four different body caps (16 KB auth, 5 MB global, 128 MB
// import, 64 KB csp-report) emit that byte-identical sentence, so it did not
// even say which limit had been hit, and the caller was told "An internal error
// occurred. Please try again." — untrue on both counts: the server is fine, and
// an identical retry can only fail identically.
//
// `err.expose` is the library telling us which is which: http-errors sets it to
// `status < 500`, i.e. "this refusal is the caller's business". Client errors
// therefore get a real reason; 5xx keeps the generic message, because that is
// the case where the message could carry internals. (_BODY_LIMIT_HINT and the
// multer sentences, _MULTER_TOO_LARGE, are declared above `upload`.)
function _fmtBytesShort(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}
// v8.13.3 — the request-PARSE errors a client can provoke with a malformed
// multipart body. multer hands busboy's plain Errors (no `status`) straight to
// next(err), so each was a 500 with an error-level stack line — "a malformed
// request body must not 500" (batch 7, v7.21.24) on the three upload routes, which
// are exactly the routes v8.13.3's 415 deliberately lets multipart reach. The set
// is busboy 1.6's own wording (node_modules/busboy/lib), anchored, so a handler
// that throws an ordinary Error is never mistaken for one; the caller is told a
// fixed sentence rather than busboy's text.
const _MULTIPART_PARSE_ERRORS = /^(?:Multipart: Boundary not found|Malformed part header|Unexpected end of (?:form|file)|Malformed content type|Missing Content-Type|Unsupported content type: |Malformed urlencoded form)/;
// A CONNECTION THAT CLOSED mid-request: usually the client (a tab shut
// mid-upload, dropped venue Wi-Fi), but Node's own requestTimeout ends a request
// the same way, and the errors cannot tell the two apart, so the sentence names
// neither party. multer fails the request with a plain "Request aborted" /
// "Request closed" Error (no status), raw-body with type `request.aborted`, a
// request stream with ECONNRESET "aborted". None is a handler fault, and the
// socket is gone: the handler records it once at warn and answers nothing (no
// 500, no access line, nothing for scanner reputation, which counts finished
// responses). Gated on the socket really being gone, so a handler that throws an
// Error with the same words still reaches the 500 branch.
const CONNECTION_CLOSED_SENTENCE = "the connection closed before the request finished";
function _clientClosedRequest(err, req) {
  if (!err || !req || err.name === "MulterError") return false;
  const gone = !!(req.destroyed || req.readableAborted || (req.socket && req.socket.destroyed));
  if (!gone) return false;
  if (err.type === "request.aborted") return true;
  const msg = String(err.message || "");
  if (!err.status && /^Request (?:aborted|closed)$/.test(msg)) return true;
  return err.code === "ECONNRESET" && msg === "aborted";
}
function _describeRequestError(err, req) {
  if (_clientClosedRequest(err, req)) {
    return { status: 499, clientClosed: true, message: null, logMessage: CONNECTION_CLOSED_SENTENCE, type: "connection.closed" };
  }
  const type = err && err.type;
  const limit = _fmtBytesShort(err && err.limit);
  const length = _fmtBytesShort(err && err.length);
  // body-parser / raw-body. The messages are written here rather than echoed,
  // because entity.parse.failed's message can quote the start of the caller's
  // own body — harmless to them, but it does not belong in a response we also
  // want to be safe to log.
  if (type === "entity.too.large") {
    return {
      status: 413,
      message: `That request was too large${limit ? ` — this endpoint accepts up to ${limit}` : ""}${length ? `, and ${length} was sent` : ""}. ${_BODY_LIMIT_HINT}`,
    };
  }
  // v8.13.3 — `logMessage` is what the LOG line says instead of err.message, for
  // the two refusals whose own message quotes something the log must not hold.
  // entity.parse.failed: V8's JSON.parse message quotes a slice of the body
  // ('Unexpected token \'h\', …"password":hunter2}" is not valid JSON'), so a
  // malformed login body put a password into app.jsonl, which every regular admin
  // reads through Logs.
  if (type === "entity.parse.failed") return { status: 400, message: "The request body was not valid JSON.", logMessage: "the request body was not valid JSON" };
  if (type === "charset.unsupported" || type === "encoding.unsupported") {
    return { status: err.status || 415, message: "That request used a character set or content encoding this endpoint does not support." };
  }
  // multer. MulterError carries {name, message, code, field} and NO status, so
  // without this every limit it enforces — including the deliberate file-size
  // and nesting guards — was served as a 500 telling the user the platform had
  // broken when their upload was simply too big.
  // The size and count codes are 413 with a fixed sentence (_MULTER_TOO_LARGE):
  // 413 stays out of scanner reputation, which matters for a participant on a
  // venue NAT who pastes an oversized answer. A text answer too long for the
  // submit form gets the handler's own sentence, so one action meets one
  // sentence whatever script it was typed in. `err.field` is compared, never echoed.
  if (err && err.name === "MulterError") {
    if (err.code === "LIMIT_FIELD_VALUE" && err.field === "answer" && req && req.method === "POST"
        && req.route && req.route.path === "/api/tasks/:id/submit") {
      return { status: 413, message: SUBMIT_ANSWER_TOO_LONG };
    }
    if (Object.prototype.hasOwnProperty.call(_MULTER_TOO_LARGE, err.code)) return { status: 413, message: _MULTER_TOO_LARGE[err.code] };
    return { status: 400, message: `Upload rejected: ${err.message}.` };
  }
  // v8.13.3 — a malformed multipart body (see _MULTIPART_PARSE_ERRORS). Gated on
  // the request really being multipart as well as on the wording, so the match can
  // only ever classify what busboy was handed.
  if (err && !err.status && err.name !== "MulterError" && req && typeof req.is === "function"
      && req.is("multipart") && _MULTIPART_PARSE_ERRORS.test(String(err.message || ""))) {
    return { status: 400, message: "The upload was not a valid multipart form.", type: "multipart.parse.failed" };
  }
  // v8.13.3 — A MALFORMED PERCENT-ESCAPE IN A ROUTE PARAMETER. Express 5's router
  // decodes every param before any handler runs and, on a URIError, sets status
  // 400 and REWRITES the message to `Failed to decode param '<the raw value>'`
  // (node_modules/router/lib/layer.js). On half the routes that take a param the
  // raw value is a CAPABILITY — /badge/:token, /api/invitations/:id,
  // /api/competitions/self-enroll/:token, /api/competitions/join-code/:code,
  // /api/admin/credential/:code — so the `Request refused: ${err.message}` line
  // wrote the capability into app.jsonl right beside a `path` field that
  // `_scrubLogPath` had correctly redacted: the scrub defeated on the very line
  // meant to enforce it. Decoding precedes every guard, so even an anonymous
  // request to the superadmin-only resolver wrote it. The log says a constant; the
  // caller gets a real reason (it was a 400 reading "An internal error occurred",
  // because the router sets no `expose`).
  if (err instanceof URIError && /^Failed to decode param /.test(String(err.message || ""))) {
    return { status: 400, message: "The request path contained malformed percent-encoding.", logMessage: "malformed percent-encoding in a route parameter", type: "path.param.malformed" };
  }
  // v8.13.3 — the two body-SHAPE refusals csrfProtection raises (lib/middleware.js
  // `_requestBodyRefusal`): a non-empty payload in a content type no parser on
  // that route handles (415), or a top-level JSON array where every handler reads
  // an object (400). They carry their own sentence and a code the client can
  // branch on; routing them through here is what gives them the req_id-joined
  // warn line every other refused body gets.
  if (type === "content-type.unsupported" || type === "body.not.object") {
    return { status: err.status, message: err.message, code: err.code_public || null, type };
  }
  const status = (err && (err.status || err.statusCode)) || 500;
  // Anything else the framework marked safe to surface (a 4xx from http-errors)
  // says its own piece; a 5xx never does.
  if (status < 500 && err && err.expose && err.message) return { status, message: err.message };
  return { status, message: "An internal error occurred. Please try again." };
}

function _sentResponseState(res) {
  if (res.writableEnded) return "ended";
  return res.locals && res.locals._endCalled ? "flushing" : "partial";
}

// Generic error handler — return JSON for API routes, prevent Express HTML defaults
app.use((err, req, res, _next) => {
  cleanupUpload(req);
  const { status, message, logMessage, code, type: _descType, clientClosed } = _describeRequestError(err, req);
  // Everything below was already on the request and was being thrown away. The
  // access log carries the same req_id, so the two files join on it instead of
  // on a timestamp — which under load is not a join at all.
  const ctx = {
    req_id: req && req.id,
    method: req && req.method,
    path: _scrubLogPath((req && (req.originalUrl || req.url)) || ""),
    status,
    ip: req && req.ip,
    // The body parsers run BEFORE session(), so an oversized body has no session
    // to attribute — null here is honest rather than missing. For an error
    // raised inside a route these are populated.
    user_id: req?.session?.userId || (req?.session?.builtinId === "superadmin" ? "superadmin" : null),
    email: req?.session?.userEmail || (req?.session?.builtinId === "superadmin" ? "superadmin" : null),
    err_type: _descType || (err && (err.type || err.code)) || null,
    // Which cap, and by how much — the two facts the operator actually needed.
    limit_bytes: err && Number.isFinite(err.limit) ? err.limit : null,
    length_bytes: err && Number.isFinite(err.length) ? err.length : null,
    // `status` above is what this handler WOULD answer; the client already has this.
    // `response`: "ended", "flushing" (the handler ended it, compression has
    // not) or "partial" (the client sees a truncation).
    ...(res.headersSent ? { headers_sent: true, sent_status: res.statusCode, response: _sentResponseState(res) } : {}),
  };
  if (clientClosed) {
    // Nobody is listening: one warn line (status 499, nginx's "client closed
    // request"), no response, and the socket made sure of (destroy is idempotent).
    log.warn(ctx, `Request abandoned: ${CONNECTION_CLOSED_SENTENCE}`);
    if (req.socket && !req.socket.destroyed) req.socket.destroy();
    return;
  }
  if (status >= 500) {
    // The case this handler is NAMED for. Express 5 forwards every rejected
    // async handler here, so without the stack a genuine bug arrives as a bare
    // sentence with no throw site.
    ctx.stack = (err && err.stack) || String(err);
    log.error(ctx, `Unhandled error: ${(err && err.message) || err}`);
  } else {
    // A client error is not a server error. Logging it at `error` contradicted
    // the access logger, which has always classified the same request as `warn`.
    //
    // v8.13.3 — `logMessage` replaces err.message where the latter quotes a
    // capability or the caller's body (see _describeRequestError).
    log.warn(ctx, `Request refused: ${logMessage || (err && err.message) || err}`);
  }
  // The response is already (partly) on the wire. Writing another throws
  // ERR_HTTP_HEADERS_SENT here, and Express's final handler then cuts the socket of
  // a response that had finished. A finished one (ended, or ended by its handler
  // and still being compressed) is left alone; a partial one has its socket cut,
  // so the client sees a truncation, not a body that looks whole.
  if (res.headersSent) {
    if (_sentResponseState(res) === "partial" && req.socket) req.socket.destroy();
    return;
  }
  res.status(status).json(code ? { error: message, code } : { error: message });
});

const PORT = process.env.PORT || 3000;
// The listen backlog (see the app.listen call). Not configurable: the kernel's
// somaxconn is the real ceiling, and it caps this silently.
const LISTEN_BACKLOG = 4096;

// v6.8.5 — boot-time sanity checks (see corresponding writeup in README).
// Each check logs + (where fatal) exits the process before listen() rather
// than fail mid-request. The goal is "if it's going to break, break loudly
// at boot, not at T+0 under load".

// 1. Cluster detection. The README explicitly mandates single-process
//    deployment; running under pm2 `exec_mode: cluster` or the Node cluster
//    module silently breaks every in-memory cache (leaderboard, rate-limit,
//    session-per-user, analytics). Refuse to start in a worker process so
//    a misconfigured deployment is impossible.
try {
  const cluster = require("cluster");
  if (typeof cluster.isPrimary === "boolean" ? !cluster.isPrimary : cluster.isWorker) {
    console.error("FATAL: Hack Arena must run as the primary/standalone process — cluster workers produce stale per-process caches. See README § 'Run as a single process'.");
    process.exit(1);
  }
} catch (_err) { /* cluster module always present, but survive if it's not */ swallowed("server:cluster-check", _err); }

// 2. DB integrity check. A prior unclean shutdown (SIGKILL mid-write, OOM,
//    VM snapshot) can leave the SQLite file corrupted; queries may limp
//    along for a while before failing in the middle of a live tournament.
//    PRAGMA integrity_check is cheap (<200ms on a ~10 MB DB) so always-run
//    is the right trade-off. On failure we log LOUDLY but keep running so
//    an operator can still log in and triage.
try {
  const rows = db.pragma("integrity_check");
  const first = Array.isArray(rows) && rows[0] ? (rows[0].integrity_check || rows[0]) : null;
  if (first && first !== "ok") {
    console.error(`WARNING: SQLite integrity_check returned "${first}". Database may be corrupted; restore from latest backup (see README § Backup & Restore) before serving traffic.`);
    // ext-audit v7.15.11 — mark the instance NOT READY. The process keeps
    // running on purpose (an operator must be able to log in and triage), but
    // /readyz now fails so the orchestrator / load balancer stops sending normal
    // traffic to a database we know is corrupt.
    _setDbIntegrityFailed();
  }
} catch (e) {
  console.error("WARNING: could not run PRAGMA integrity_check:", e.message);
  // Could not verify → treat as not-ready rather than assume healthy.
  _setDbIntegrityFailed();
}

// 2b. REQUIRED SCHEMA (v8.3.39, external audit). `db.js` runs ~60 migrations and
//    swallows almost every failure, which is right for the ones whose loss costs
//    a feature and wrong for the ones a write path names by column. Nothing
//    checked afterwards, and readiness could not have: it probes two tables by
//    primary key. `lib/schema-required.js` carries the manifest — every column an
//    ALTER adds, and every UNIQUE index — plus a decision per exemption, and a
//    scanner keeps it in step with db.js so a new migration cannot arrive
//    uncovered.
//
//    NOT fatal, deliberately, and for the same reason as the integrity check
//    above: drain the instance, keep the shell. The log names every missing
//    object because that is the operator's actual next step.
try {
  const { verifySchema } = require("./lib/schema-required");
  const _schema = verifySchema(db);
  if (!_schema.ok) {
    const _missing = [...(_schema.missingColumns || []), ...(_schema.missingIndexes || [])];
    console.error(
      "WARNING: the database schema is INCOMPLETE — one or more migrations did not apply.\n" +
      (_schema.error ? `  Schema could not be read: ${_schema.error}\n` : "") +
      (_missing.length ? `  Missing: ${_missing.join(", ")}\n` : "") +
      "  /readyz will report not-ready so the load balancer drains this instance.\n" +
      "  Look for a '[db]' / 'migration failed' line earlier in this log, fix the cause and restart."
    );
    _setDbSchemaIncomplete();
  }
} catch (e) {
  console.error("WARNING: could not verify the database schema:", e.message);
  // Could not verify → not-ready rather than assume healthy, exactly as above.
  _setDbSchemaIncomplete();
}

// 3. Platform-version tracking. Store the version we're booting as. If the
//    previously-stored version differs, log the transition — catches "old
//    container accidentally deployed against upgraded DB" and the reverse.
try {
  const prev = db.prepare("SELECT value FROM settings WHERE key='last_platform_version'").get()?.value || null;
  db.prepare("INSERT INTO settings(key,value) VALUES('last_platform_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(PLATFORM_VERSION);
  if (prev && prev !== PLATFORM_VERSION) {
    console.log(`Platform version transitioned: ${prev} → ${PLATFORM_VERSION}`);
  }
} catch (e) { /* settings upsert is non-fatal if the table schema is stale */ swallowed("server:version-settings-upsert", e); }

// 4. Reverse-proxy configuration sanity. If TRUST_PROXY is set but BASE_URL
//    declares HTTP, the deployment is almost certainly misconfigured:
//    Secure-flag cookies would refuse to flow back to the browser. Warn.
//    v7.2.x (audit, F5) — gate on the PARSED value `app.get("trust proxy")`,
//    not the raw env string: `process.env.TRUST_PROXY` is the literal string,
//    so "false"/"0" are JS-truthy and read as "enabled". configureTrustProxy()
//    above already resolved the env into Express (false when off), so reusing
//    its result keeps these checks in lockstep with the cookie logic at
//    SECURE_COOKIE (which is also app.get("trust proxy")-derived).
if (app.get("trust proxy") && (process.env.BASE_URL || "").startsWith("http://")) {
  console.warn("WARNING: TRUST_PROXY is enabled but BASE_URL is http://. Browsers refuse to send Secure-flagged session cookies over HTTP; sessions will appear to drop. Use https:// in BASE_URL, or unset TRUST_PROXY for plain-HTTP dev.");
}
// v8.13.3 (TP-1) — TRUST_PROXY=true TRUSTS EVERY HOP, so `req.ip` is the LEFTMOST
// X-Forwarded-For entry: a value the CLIENT writes itself behind any proxy that
// APPENDS to the header rather than overwriting it — nginx's
// `$proxy_add_x_forwarded_for`, an AWS ALB in its default append mode, Cloudflare.
// That makes every per-IP limiter, the scanner block, RATE_LIMIT_ALLOWLIST_IPS and
// a competition's Trusted network IPs (a forged venue address bypasses every
// limiter) and every audit IP client-chosen. The topology is the operator's to
// know, so this WARNS rather than refuses — a proxy that overwrites the header is
// a legitimate place for `true` — and it is once, at boot: the runtime hop
// diagnostic cannot judge `true` (it reads a hop COUNT), and a per-request line
// would also fire on a correctly configured overwrite-then-append chain, crying
// wolf for ever. Gated on the PARSED value, like the checks either side.
if (app.get("trust proxy") === true) {
  console.warn("WARNING: TRUST_PROXY=true trusts EVERY hop, so req.ip is the LEFTMOST X-Forwarded-For entry — a value the client writes itself behind any proxy that appends to the header (nginx $proxy_add_x_forwarded_for, an AWS ALB in its default append mode, Cloudflare). Rate limits, the scanner block, RATE_LIMIT_ALLOWLIST_IPS / Trusted network IPs and every audit IP then come from the client. Set TRUST_PROXY to the hop count instead (1 behind one proxy); use true only behind a proxy that OVERWRITES X-Forwarded-For.");
}
// v6.16.53 — the OPPOSITE misconfig is far worse and silent: HTTPS
// BASE_URL with TRUST_PROXY off. SECURE_COOKIE is forced (correctly)
// when BASE_URL is https://, but Express then sees `req.secure=false`
// because the actual TCP connection from the proxy to node is HTTP and
// the X-Forwarded-Proto header is ignored. Result: Set-Cookie with the
// Secure flag is suppressed (the cookie never reaches the browser),
// every request looks anonymous, /api/csrf-token returns 200 with no
// session, and /api/login fails csrf_invalid forever — with zero
// signal in the access log that anything is wrong. FATAL on startup
// (skip in NODE_ENV=test where the testbed runs http://localhost
// without a proxy) so the operator notices BEFORE the live tournament.
if (process.env.NODE_ENV !== "test"
    && (process.env.BASE_URL || "").startsWith("https://")
    && !app.get("trust proxy")) {  // v7.2.x (audit, F5): parsed value, not raw env — "false"/"0" must count as OFF here so this FATAL guard fires
  console.error("FATAL: BASE_URL is https:// but TRUST_PROXY is off. Express won't trust X-Forwarded-Proto from the reverse proxy, the session cookie's Secure flag stops it from reaching the browser, and every login will silently fail with csrf_invalid. Set TRUST_PROXY=1 (with the proxy actually setting X-Forwarded-Proto), or use http:// in BASE_URL for a direct/dev deploy without a proxy. Aborting startup.");
  process.exit(1);
}

// 5. Achievement-badge rendering availability (v7.1.0). Non-fatal: badges are a
//    nice-to-have, so a missing @resvg/resvg-js binary or absent badge fonts
//    must not block a tournament. But warn loudly at boot rather than letting
//    every top-3 finisher's mint silently 503 under load.
try {
  if (!require("./lib/badge").badgeRenderingAvailable()) {
    console.warn("WARNING: achievement-badge rendering is unavailable (missing @resvg/resvg-js binary or lib/fonts/badge/*.ttf). The LinkedIn share-badge endpoint will return 503; everything else is unaffected.");
  }
} catch (e) { console.warn("WARNING: badge-rendering self-check failed:", e.message); }

const portCheck = require('net').createServer();
portCheck.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Exiting.`);
    process.exit(1);
  }
  throw err;
});

// v6.8.5 — server handle is captured so SIGTERM/SIGINT handlers below can
// call server.close() for a graceful drain. Previously `docker stop` hard-
// killed after the 10 s grace window, cutting off in-flight submissions.
let _httpServer = null;
portCheck.once('listening', () => {
  portCheck.close(() => {
    // ext-audit v7.20.9 (F7) — only NOW has this process shown it is not a
    // duplicate start against a data volume a live server already owns, so only
    // now may it claim the shared credential file. See the note at the
    // writeSuperadminPassword definition. Synchronous and ahead of app.listen,
    // so the file is on disk before anything can connect.
    writeSuperadminPassword();
    // LISTEN_BACKLOG: how many finished TCP handshakes the kernel holds while
    // the one thread is busy. Node's default (511) overflowed in a 3000-person
    // 10 s arrival: the kernel then DROPS the handshake and the browser's page
    // load waits out SYN retransmits (1 s, 3 s, 7 s …) or is reset — measured
    // as 33 000 ListenOverflows and multi-second first loads (perf/RESULTS.md,
    // "3000-user sign-in storm — FINAL"). The kernel caps it at
    // net.core.somaxconn (4096 by default).
    _httpServer = app.listen(PORT, '0.0.0.0', LISTEN_BACKLOG, () => {
      // Richer boot banner (v6.8.5): previously only printed platform name
      // + port. Now surfaces the full operational context so an operator
      // can confirm the right data volume, env, proxy mode, asset pipeline,
      // and maintenance state at a glance without cross-referencing env.
      // v8.3.34 — the banner reads the SAME predicate as the gate. It used to
      // ask fs.existsSync while the gate asked for the token, so an empty
      // sentinel printed `maintenance=ON` over a site that was serving traffic.
      const maintToken = _maintenanceState().active;
      const assetCount = (typeof _assetVersions === "object" && _assetVersions) ? _assetVersions.size : "?";
      console.log(`${getPlatformName()} v${PLATFORM_VERSION} running on :${PORT}`);
      // v6.10.88 / v6.10.89 — greppable startup marker so an operator
      // can confirm from app.jsonl alone that the running build
      // contains the perf-span instrumentation (answers "is the code
      // even loaded" with one grep). Paired with the perf-span
      // threshold-logger on the routes it names; each emits
      // `[perf-span] slow <route>` when its server-side total exceeds
      // PERF_SPAN_SLOW_MS.
      console.log(`[perf-span] instrumentation loaded for /api/status, /api/admin/competitions/:id/events, /api/admin/participants, /api/admin/submissions, /api/admin/analytics/challenges, POST /api/tasks/:id/submit, SPA-shell GET /, /api/participant/pulse, /api/admin/competitions/:id/overview-pulse, /api/admin/competitions/:id/team-report (incl. ?peer=1), /api/admin/competitions/:id/team-report/preview (v${PLATFORM_VERSION})`);
      console.log(`  [perf-span] slow threshold = ${PERF_SPAN_SLOW_MS} ms (set PERF_SPAN_SLOW_MS env to lower for temporary diagnostic runs)`);
      console.log(`  NODE_ENV=${process.env.NODE_ENV || "(unset → dev)"} | DATA_DIR=${DATA_DIR} | TRUST_PROXY=${app.get("trust proxy") || "off"} | maintenance=${maintToken ? "ON" : "off"}`);
      console.log(`  Asset versions loaded: ${assetCount} | HSTS=${_HSTS_ENABLED ? "on" : "off"} | SMTP=${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}`);
      const comps = db.prepare("SELECT COUNT(*) as c FROM competitions").get().c;
      console.log(`  Competitions: ${comps}`);
      logSuperadminPassword();
      try { recordSettingsEvent("superadmin_password", "rotated", "system", { reason: "server_start" }); } catch (_err) { swallowed("server:best-effort", _err); }
      startStatusScheduler();
      // Both mail workers hold while the instance is out of service (the gate
      // `_instanceInService`: maintenance mode, or a database that failed its
      // boot integrity or schema check), so neither mails from a copied or
      // restored database started in maintenance, nor from a corrupt or
      // half-migrated one. Set before each worker starts, so not even its first
      // pass gets past it. (The start reminders and the lockout-expiry mail ask
      // the same gate inside runReminderTick and runLockoutExpiryPass.)
      setCertificateMailHold(() => !_instanceInService());
      require("./lib/team-reports").setTeamReportMailHold(() => !_instanceInService());
      startCertificateDispatcher(); // v8.15.1 — marks crash-cut sends unknown; the 60 s worker (not under test)
      require("./lib/team-reports").startTeamReports(); // event team reports: the same shape
      startAccountReaper(); // v7.6.0 — hourly sweep of abandoned never-verified sign-ups
      // v7.7.17 — daily purge of *_events older than the retention window (2y
      // default). Its orphaned-image sweep runs only while the instance is in
      // service (the same gate, read live): a corrupt, half-migrated or
      // maintenance-mode database deletes no picture.
      startEventRetentionReaper({ isHealthy: _instanceInService });
      // v8.12.7 — the Checkmarx One withdrawal runner. It deletes accounts in a
      // CUSTOMER's tenant, so it runs only while this instance is known-good: a
      // database that failed its integrity check, a half-applied migration, or
      // maintenance mode each stop it (the instance-health gate, read LIVE on
      // every tick, so lifting maintenance resumes it with no restart). Returns
      // early under test.
      startCxOneWithdrawalSweeper({ isHealthy: _instanceInService });
      // Checkmarx One set-ups a deferral promised to retry (its History row says
      // so) and that the last process stopped before it could: queued again the
      // first time this instance is in service — the same gate, read live, so a
      // boot in maintenance resumes them once it is lifted. Not under test — the
      // shared server never calls a realm.
      if (process.env.NODE_ENV !== "test") startCxOneProvisionResume({ isHealthy: _instanceInService });
    });
    _httpServer.keepAliveTimeout = 65_000;
    _httpServer.headersTimeout   = 66_000;
    // infra audit (#6): the portCheck pre-bind only narrows the race — between
    // portCheck.close() above and app.listen() another process can grab the
    // port (classic TOCTOU). Without an 'error' listener on the real server the
    // late EADDRINUSE/EACCES emits unhandled and bubbles to uncaughtException →
    // gracefulShutdown (a noisy, misleading failure). Attach one here so a
    // port-conflict still produces the clean "Exiting" message the pre-check
    // was meant to guarantee.
    _httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        console.error(`Port ${PORT} could not be bound (${err.code}). Exiting.`);
        process.exit(1);
      }
      throw err;
    });
  });
});
portCheck.listen(PORT, '0.0.0.0');

// v6.8.5 — graceful shutdown. SIGTERM (docker stop, k8s pod delete) and
// SIGINT (Ctrl-C in local dev) both drain in-flight HTTP requests for up
// to 20 s, then close DB + session store so no writes are lost to SIGKILL.
// Important: we DO NOT register these in test mode — Playwright workers
// send SIGKILL directly when tearing down, and listening for SIGTERM
// produces warning spam in the test logs.
let _shuttingDown = false;
function gracefulShutdown(signal, exitCode = 0) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  // v8.12.7 — first, so no new withdrawal pass starts while we drain; one
  // already in flight is waited on below.
  try { stopCxOneWithdrawalSweeper(); } catch (_err) { swallowed("server:best-effort", _err); }
  // v8.15.1 — the certificate worker starts no new issue or send; the one in
  // flight is drained below.
  try { stopCertificateDispatcher(); } catch (_err) { swallowed("server:best-effort", _err); }
  try { require("./lib/team-reports").stopTeamReports(); } catch (_err) { swallowed("server:best-effort", _err); }
  // …and no pending Checkmarx One set-up retry starts remote work into a drain
  // that exit can cut: each is cancelled and recorded (the next boot resumes it).
  let _cxoneRetriesStopped = 0;
  try { _cxoneRetriesStopped = stopCxOneProvisionRetries(); } catch (_err) { swallowed("server:best-effort", _err); }
  console.log(`${signal} received — draining connections…`);
  const timeoutHandle = setTimeout(() => {
    console.error("Graceful shutdown timed out after 20 s; forcing exit.");
    process.exit(1);
  }, 20_000);
  timeoutHandle.unref();
  const finish = () => {
    // v6.16.5 — drain outstanding _deferAudit work before db.close().
    // Pre-fix the v6.8.2 setImmediate-deferred audit-row inserts could
    // still be queued in the libuv micro-task pool when db.close()
    // ran. Once the connection closed, those callbacks threw "The
    // database connection is not open" and silently lost the audit
    // row — submission/membership row was durable, audit chain had a
    // gap. The drain sub-budget is 5 s; if anything outlives it the
    // outer 20-s watchdog still force-exits.
    const drainDeadline = Date.now() + 5_000;
    const drainAndClose = () => {
      // v6.16.16 — also wait on `_cxOneQueue` + `_cxOneInflight`.
      // Pre-fix the drain only checked `_deferredAuditPending`. CxOne
      // provisioning fires post-success `_deferAudit` calls (audit
      // row for "user added to comp"), so a SIGTERM mid-bulk-assign
      // could see `_deferredAuditPending === 0` momentarily, drop the
      // db.close() guillotine, and the next CxOne completion's
      // post-success `_deferAudit` would throw "database is not
      // open" — silently losing the audit row. Now drain waits on
      // both counters within the same 5-s sub-budget.
      const auditDrained = deferredAuditPending() === 0;
      const cxoneDrained = cxOneInflight() === 0 && cxOneQueueDepth() === 0;
      // ext-audit v7.15.15 — also wait on DETACHED EMAIL FAN-OUT.
      //
      // v7.15.14 capped how long bulk assign / approve / invite hold their
      // response open and let the remainder run detached — which fixed the
      // client-timeout problem but created a new one: a rolling deployment
      // could exit mid-fan-out and silently drop invitation and approval
      // emails the API had already reported as sending. Same reasoning that
      // added the cxone counters to this drain in v6.16.16.
      const mailDrained = detachedFanoutPending() === 0;
      // ext-audit v7.20.9 (F8) — also wait on DETACHED MEMBERSHIP RECONCILIATION.
      // A group bind larger than RECONCILE_MAX_PER_CALL finishes one pass in the
      // request and schedules the rest; nothing here knew about those, so a
      // rolling deployment could close the database mid-drain and leave a
      // competition permanently mis-enrolled. Each pass completes within a turn,
      // so the existing setImmediate re-arm below gives every queued pass its
      // tick and the 5 s sub-budget still bounds a pathological chain.
      const reconcileDrained = reconcileDrainPending() === 0;
      // v8.12.7 — and a Checkmarx One withdrawal in flight. Its realm DELETE
      // and the ledger write recording it are two steps; closing the database
      // between them leaves a row the next boot retries (a realm 404 reads as
      // already gone), so this is about not wasting the call, not about safety.
      const withdrawalDrained = !cxOneWithdrawalsBusy();
      // v8.15.1 — and a certificate-dispatch pass (a mint, a PDF render, the send):
      // cut mid-send, its ledger row is left `sending` and the next boot marks it
      // `unknown` rather than risk mailing it twice.
      const certificatesDrained = !certificateDispatchBusy() && !require("./lib/team-reports").teamReportsBusy();
      if ((auditDrained && cxoneDrained && mailDrained && reconcileDrained && withdrawalDrained && certificatesDrained) || Date.now() > drainDeadline) {
        // The pooled SMTP transport's idle connections go once the mail drain
        // above has answered (or timed out). A tracked (detached) send still on a
        // relay connection, or still waiting for one in sendEmailLogged
        // (_acquireSlot), at that point is counted under "mail timed out" below
        // and is never sent.
        closeTransport();
        try { db.close(); } catch (_err) { swallowed("server:best-effort", _err); }
        const detail = [];
        detail.push(auditDrained ? "audit drained" : `audit timed out: ${deferredAuditPending()} remaining`);
        detail.push(cxoneDrained ? "cxone drained" : `cxone timed out: ${cxOneQueueDepth()} queued + ${cxOneInflight()} in flight`);
        detail.push(mailDrained ? "mail drained" : `mail timed out: ${detachedFanoutPending()} sends remaining`);
        detail.push(reconcileDrained ? "reconcile drained" : `reconcile timed out: ${reconcileDrainPending()} passes remaining`);
        detail.push(withdrawalDrained ? "withdrawals drained" : "withdrawal timed out: withdrawal in flight");
        detail.push(certificatesDrained ? "certificates drained" : "certificate dispatch timed out: a pass in flight");
        if (_cxoneRetriesStopped) detail.push(`cxone set-up retries stopped for the next start: ${_cxoneRetriesStopped}`);
        console.log(`Shutdown complete (${detail.join("; ")}; exit=${exitCode}).`);
        process.exit(exitCode);
      } else {
        setImmediate(drainAndClose);
      }
    };
    drainAndClose();
  };
  if (_httpServer) _httpServer.close(finish); else finish();
}
if (process.env.NODE_ENV !== "test") {
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
}
