"use strict";

// Challenge (task) admin routes: publish, competition assignment (add / replace
// / remove), CRUD, visibility, version history + restore, lock, recalculate,
// attachments (+ staging), attachment downloads, feedback, and task tags.
// "Challenge" is the domain term; the table/route term stays `task`.
// (v7.0.0 refactor: route split — extracted verbatim from server.js.)

const { v4: uuid } = require("uuid");
const fs = require("fs");
const path = require("path");
const { boundedMulter } = require("../lib/multipart");
const db = require("../db");
const { rateLimit, destructiveAdminLimit, requireAdmin, requireSuperAdmin, requireParticipant, requireCompetitionContext, requireParticipantInCompetition, csrfProtection, adminAuthzDenied, testAdminCommitPark } = require("../lib/middleware");
const { getCompetition, competitionStatus, competitionEffectiveEnd, competitionAnySlotStarted, competitionAnySlotEnded, competitionFullyEnded, ensureTaskNumbers, _invalidateTaskNumbersCache, participantContentNotStarted, taskFrozenByEndedCompetition, lateEntryWindowOpen } = require("../lib/competitions");
const { getAdminIdentity, createTaskVersion, recordTaskAuditEvent, recordSealedReveal, sealRevealHistoryDetails, recordCompetitionEvent, recordUserEvent, recordOrphanedAuditEvent, reqContext, runTxnWithMirrorBuffer, parseStoredDetails } = require("../lib/audit");
const { swallowed } = require("../lib/best-effort");
const { isImpersonating } = require("../lib/impersonation"); // v8.12.1 — a seal is never set through somebody else's seat
const { validateUnencryptedZip, _unlinkAttachmentTempSync, _streamSha256, _attachmentValidationMessage, _slugForDownload, ATTACHMENT_MAX_BYTES, ATTACHMENT_MIME_ALLOW, ATTACHMENT_MAX_PER_TASK, ATTACHMENT_FREE_DISK_MIN_BYTES, reserveAttachmentBudget, preflightAttachmentBudget } = require("../lib/attachments");
const { challengeFitError, eventConstrainsChallenges, taskConflictingEvent } = require("../lib/challenge-fit");
const { invalidateLeaderboardCache } = require("../lib/leaderboard");
const { _invalidateMeCache, _invalidateMeCacheForComps } = require("../lib/me-cache");
const { processRichText, richTextHasContent } = require("../lib/sanitise");
const { jsonExactMatch, VALID_ANSWER_TYPES, VALID_DIFFICULTIES, POINTS, PENALTY, HINT_DEDUCTION_RATE, answerTypeHasKey, canonicaliseTextAnswers, gradeTextAnswer, normaliseTextAnswer } = require("../lib/scoring");
// v8.9.0 — the ONE refusal for a hint on an any-answer challenge (POST, PUT).
// Restore and the import make the same decision with their own posture (409 /
// skip) and cite this sentence. It names the remedy, per FROZEN_REMEDY's rule.
const ANY_HINT_REFUSAL = "An any-answer question cannot have a hint: every non-empty answer is accepted, so there is nothing to hint towards. Clear the hint, or choose another answer type.";
const { validateChoices, parseChoices, parseCorrectIds, gradeChoice, choiceIdsByText, legacySelectionIds, storedChoicePickedNothing } = require("../lib/choices");
// Event team reports — an event asks each qualifying question once (ruling N7),
// and an answered one keeps its options in place (ruling 84); lib/qualifying.js.
const { qualifyingKeysFromTags, qualifyingKeyHeldDenied, answeredOptionsChangeDenied, qualifyingOptionsFixed, qualifyingOptionsFixedSet, qualifyingNeedsPickOneDenied, tagsMakeQualifying } = require("../lib/qualifying");
const { rescoreAfterQualifyingFlip } = require("../lib/qualifying-rescore");
// A question added to an event lives in that event: the assign doors put the
// event's own copy in (lib/event-copies.js), never the bank question itself.
const { eventTaskFor, eventTaskTarget, assignedEventTaskId, eventsHolding, resolveEventTaskParam } = require("../lib/event-copies");
// A bank question id named in the session's event means that event's own copy, on the
// participant's attachment download too (its siblings: routes/participant.js, the submit).
// Per-session question sets: a question outside the session the request plays
// downloads nothing (lib/session-tasks.js).
const _resolveEventTaskForAttachment = [resolveEventTaskParam(db, "taskId"), require("../lib/session-tasks").requireTaskInSession(db, "taskId")];
const { validateUrl } = require("../lib/util");
const { validateBody } = require("../lib/validate");
const { now } = require("../lib/time");
const { ATTEMPT_CAP_MIN, ATTEMPT_CAP_MAX, attemptState, grantAttempts, resolveAttemptCap } = require("../lib/attempts"); // v8.1.0
const { _freeSpaceBytes, log } = require("../lib/log");
const { DATA_DIR, UPLOADS_DIR, BULK_ADMIN_MAX } = require("../lib/config");
// v8.7.0 — the event-admin scope. ROW-level answers only: `eventAdminGuard`
// (mounted in server.js) has already decided whether this actor may call the
// endpoint at all, so nothing in this file re-checks the tier. Every predicate
// returns null for an unscoped actor, so each new branch below is a no-op for
// admin / superadmin.
const {
  actorId, actingAdminId, actingIsSuperAdmin, sealRevealSet, sealRevealedFor, competitorIds, scopedCompetitionIds, competitionDenied,
  taskViewDenied, taskEditDenied, taskScoringEditDenied, taskUnassignDenied,
  PUBLIC_DOMAIN_TAG, publicDomainNearMiss, PUBLIC_DOMAIN_NEAR_MISS_ERROR,
  participantVisibilityScope, taskVisibilitySql,
  invalidateEventAdminScope,   // v8.12.6 — the direct upload's owner re-ask reads the role fresh
} = require("../lib/event-admin");

// v8.10.0 — the sealed answer. ORTHOGONAL to the block above: those predicates
// return null for an unscoped actor by design, whereas a seal binds every tier
// including superadmin. See lib/answer-seal.js for why the two cannot share a
// home. v8.12.1 — THE SEAL IS ASKED ABOUT THE HUMAN, NOT THE SEAT: every seal
// predicate here takes `actingAdminId(req)`, which is the acting admin's own
// id under impersonation and `actorId(req)` otherwise. An admin inside an
// event admin's panel must not read a key that organiser sealed — the seal
// binds every tier, and "through their eyes" stops at the one thing the
// platform promised nobody else would see. The competitor lock keeps
// `actorId` (the seat's rows), because that lock is about what the SEAT may
// change; the acting admin's own rows are asked at entry and by the guard.
// v8.12.2 — AND EVERY PREDICATE TAKES A THIRD ARGUMENT, `sealRevealedFor(req,
// taskId)`: true only when the acting human is a superadmin RIGHT NOW (a live
// role read) who has REVEALED this challenge in this session, at which point
// the seal treats them as the author. The reveal is its own route below,
// `POST /api/admin/tasks/:id/sealed-reveal`, and is what writes the History
// row and the event-log entry the operator asked for.
const {
  SEALED_FIELDS,
  answerSealed, isTaskAuthor, sealedAnswerReadable, redactSealedAnswer,
  redactSealedSnapshot, sealedEditDenied, sealAtCreateDenied, sealChangeDenied, sealTypeDenied,
  sealRevealDenied,
} = require("../lib/answer-seal");

// v8.12.0 — staff can compete. Like the seal, this binds EVERY tier: an actor who
// holds a row on an event whose "Staff can compete" switch is on may not change
// that event or any challenge it holds. See lib/staff-compete.js.
const {
  staffCompeteOn, unsealedAssignmentDenied, authorCompetesDenied,
  competitorEditDenied, competitorTaskEditDenied, competitorEventsForTask,
  unsealDenied, capRefused, refuseCompetitor,
} = require("../lib/staff-compete");

// v7.29.0 — THE REMEDY CLAUSE, in one place because it appeared in five error
// strings and every one of them named a remedy the platform REFUSES.
//
// All five ended "Unassign it from that competition first." — and
// DELETE /api/admin/tasks/:id/competitions/:cid refuses exactly that with a 400
// once a session has ended. It is not merely usually wrong: the advice predicate
// IMPLIES the unassign predicate, so the suggested step can never succeed. It
// shipped for four releases with a fully green suite because every lock stops at
// the status code and the first clause; not one asserts the advice.
//
// The obvious replacement — "extend the duration" — is untrue three ways, which
// is why this says WHO can act rather than naming a mechanism:
//   1. for a MULTI-SESSION competition the revive branches are gated on zero
//      slots, so extending does nothing;
//   2. an all-solved auto-ended competition re-checks all-solved and refuses to
//      revive at all;
//   3. reopening anything past its effective end is superadmin-only
//      (routes/competitions.js, routes/sessions.js) — and four of the five sites
//      are `requireAdmin`, so for the tier most likely to hit them the extend
//      remedy is never available.
// A clone-the-challenge remedy was considered and rejected: no such feature
// exists, so it would be the same defect in new clothes.
//
// The multi-session clause is not decoration: competitionAnySlotEnded is `some`,
// so ONE reopened session does not lift the freeze.
const FROZEN_REMEDY = "Reopening it is a superadmin action — and for a multi-session competition every finished session has to be reopened, not just one.";

// audit v7.12.3 (#2/#9) — bring the bulk assign-competitions route into line with
// every other bulk admin endpoint (participants/invitations/groups): a 5/min limit
// and a 1000-element array cap.
const bulkAdminLimit = rateLimit(60_000, 5, "bulk-assign-tasks");

// v8.3.17 — the caps live in lib/task-fields.js, because the CHALLENGE IMPORT
// needs the same table and was enforcing none of it (a title this path caps at
// 300 was stored by the importer at 1 000 000). One table, two writers.
const { TASK_FIELD_CAPS } = require("../lib/task-fields");

// Task attachments (.zip uploads). Separate multer + limits from the participant
// submit upload (10 MB) because the ceiling differs (64 MB ZIP). The MIME
// whitelist is deliberately lenient (browser + OS pickers disagree on the .zip
// MIME type); the real gatekeeper is validateUnencryptedZip(), which walks the
// central directory before the file is accepted. dest is the shared UPLOADS_DIR
// so the temp path matches what the boot/periodic uploads sweep expects.
const uploadAttachment = boundedMulter({
  dest: UPLOADS_DIR,
  // The client sends `file` plus `display_name` (CSRF rides the header), so: one
  // file, one text field, two parts, flat names (lib/multipart.js says why each
  // is required). The SPA cuts display_name to 200 UTF-16 units (at most 600
  // UTF-8 bytes) and the handler keeps 200 units, so under 4 KiB is ample
  // (fieldSize is the largest value admitted).
  // multer 2.2.0's CVE-2026-5038 orphan-DoS fix was incomplete; 2.4.0 finishes it
  // (CVE-2026-88932) — v8.12.7.
  limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1, fields: 1, fieldSize: 4 * 1024 - 1, fieldNameSize: 100, parts: 2, fieldNestingDepth: 0 },
  fileFilter: (_req, file, cb) => {
    const extOk = /\.zip$/i.test(file.originalname || "");
    cb(null, extOk || ATTACHMENT_MIME_ALLOW.has(file.mimetype));
  },
});

// v8.1.0 — the attempt-cap boundary, shared by create and edit so the two cannot
// disagree about what a cap is. Returns {error} | {value} where value is a
// positive integer or null (uncapped).
//
// STRICT, not lenient: `parseInt("3 tries")` is 3, and a cap silently invented
// from prose is the kind of wrong answer nobody reads back. The clamped-pagination
// disposition (v7.7.12) does not apply — this value is STORED and it decides
// whether a participant may act.
//
// An explicitly empty value (null / "" ) means UNCAPPED and is honoured, because
// removing a cap has to be expressible; `undefined` means the caller said nothing.
// Stage B — a question's TOPIC (lib/topics.js). Absent leaves it alone, null or
// "" files it under no topic, an id must name an existing topic (a value the
// route could not honour is refused, never ignored).
function _resolveTopicField(raw) {
  if (raw === undefined) return { value: undefined };
  if (raw === null || raw === "") return { value: null };
  if (typeof raw !== "string") return { error: "topic_id must be a topic id, or null for no topic." };
  const row = db.prepare("SELECT id, name FROM topics WHERE id=?").get(raw);
  if (!row) return { error: "That topic no longer exists. Pick another topic.", code: "topic_not_found" };
  return { value: row.id, name: row.name };
}

function _resolveAttemptCap(raw) {
  if (raw === undefined) return { value: undefined };
  if (raw === null || raw === "") return { value: null };
  const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
  if (!Number.isInteger(n)) return { error: "attempt_cap must be a whole number of attempts, or empty for no cap." };
  if (n < ATTEMPT_CAP_MIN) {
    // Zero is refused rather than stored — see lib/attempts.js. A challenge
    // nobody may attempt is already expressible by unpublishing it, and a stored
    // 0 would make the most-specific-wins chain answer "capped at nothing".
    return { error: `attempt_cap must be at least ${ATTEMPT_CAP_MIN}, or empty for no cap.` };
  }
  if (n > ATTEMPT_CAP_MAX) return { error: `attempt_cap must be at most ${ATTEMPT_CAP_MAX}.` };
  return { value: n };
}

// v8.1.0 (PR 30) — the fit check needs the challenge's TAGS, and this is the one
// place the three assign routes read them.
//
// THE POLICY QUESTION IS ASKED FIRST, and that ordering is what keeps the common
// path free: every Competition and every Program constrains nothing, so those
// assigns cost one in-memory policy lookup and issue NO query at all. Only a
// Booth Event pays for the tag read.
//
// `tagCache` is threaded by the bulk route, which is bounded at
// BULK_ADMIN_MAX challenges x BULK_ADMIN_MAX competitions — without it the same
// challenge's tags would be re-read once per target event.
// THE ROW AN ADD PUTS IN (lib/event-copies.js `eventTaskTarget`): re-adding a
// bank question to an event that still holds its copy (unassigned since, perhaps
// edited there) reuses that copy, so the assign doors ask every refusal (draft,
// lock, fit, seal, qualifying key) of the copy, never of the bank row. A new copy
// is made from the named row and is identical to it, so that row answers then.
function _assignTarget(task, cid) {
  const tid = eventTaskTarget(db, task.id, cid);
  if (!tid || tid === task.id) return task;
  return db.prepare("SELECT id, title, status, locked, answer_type, created_by_id, answer_sealed FROM tasks WHERE id=?").get(tid) || task;
}
// The named question's own draft and lock gates, asked again of an existing copy
// the add would reuse (the named row passed them already). `kind` names the
// bulk door's ledger key.
function _assignTargetStateRefusal(task, tgt, isSuperAdmin) {
  if (tgt === task) return null;
  if (tgt.status !== "published") return { kind: "draft", message: "This event's own copy of the question is not published; publish it in the event to add it back." };
  if (tgt.locked && !isSuperAdmin) return { kind: "locked", message: "This event's own copy of the question is locked. Only a superadmin can change event assignments." };
  return null;
}

function _fitError(task, comp, tagCache) {
  if (!eventConstrainsChallenges(comp)) return null;
  let tags = tagCache && tagCache.get(task.id);
  if (!tags) {
    tags = db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(task.id).map(r => r.tag);
    if (tagCache) tagCache.set(task.id, tags);
  }
  return challengeFitError(task, comp, tags);
}

// v8.13.3 — A DELIBERATE REFUSAL INSIDE THE ASSIGNMENT TRANSACTIONS IS MARKED
// WHERE IT IS THROWN. It is thrown rather than returned so the transaction rolls
// back whatever the loop had already written; the marker is what lets the catch
// tell a sentence meant for the caller from an internal error. The two catches
// below used to answer EVERY throw as a 400 carrying `e.message` — so a
// SQLITE_BUSY from an operator's sqlite3 session, a failed constraint, or a
// strict predicate refusing an under-selected row (lib/staff-compete.js's
// `_requireKey`, which exists to fail LOUDLY) reached the admin as a toast
// reading the driver's own text, under a status saying THEIR request was wrong,
// with no log line anywhere. An unmarked throw is now re-thrown, and the global
// handler logs it with its stack and answers the generic 500.
//
// The SHAPE is the codebase's existing deliberate-refusal object
// (`{userError: true, error}` — routes/competitions.js and routes/admin-misc.js
// use it for the CxOne key, server.js for the participant import), never an
// Error carrying the sentence in `.message`: two shapes under one marker name is
// how a later catch comes to answer `{error: e.error}` with `undefined`. `extra`
// carries the seal refusal's `code` and its refused pairs.
function _assignRefusal(error, extra = {}) {
  return { userError: true, error, ...extra };
}

// v8.7.0 — THE SQL FORM of `taskViewDenied`'s three-way rule, for the two LIST
// surfaces in this file (the challenge list, and the tag vocabulary derived from
// it). It has to be SQL rather than a per-row filter because both surfaces
// AGGREGATE over what they select — the list batch-loads competitions, versions,
// feedback, tags and attachment counts from the ids it selected, and the tag
// route DISTINCTs — so narrowing afterwards would leave those reads computed
// over rows the actor may not see.
//
// It is a deliberate MIRROR of the predicate, one arm per fact (I created it /
// it is used by an event I run / it is public-domain), because the module can
// splice one column, not a three-table rule. The predicate stays the authority
// for every NAMED entity, which bounds a drift in the safe direction: a wrong
// arm here HIDES a row the actor could still open directly, never the reverse.
//
// EXISTS rather than a JOIN so the query cannot multiply rows: no DISTINCT is
// needed and the caller's ORDER BY keeps its meaning.
//
// The definition now lives in lib/event-admin.js (`taskVisibilitySql`), shared
// with the Audit page; this file keeps its local name. The unscoped short-circuit
// is asked here too so the route-classification scanner still sees these list
// routes reach a scope primitive through this helper.
function _taskVisibilitySql(req, alias) {
  if (scopedCompetitionIds(req) === null) return { clause: "", params: [] };   // unscoped: the old query, unchanged
  return taskVisibilitySql(req, alias);
}

// Event team reports — a qualifying challenge numbers in its own level
// (lib/competitions.js _assignTaskNumbers), so gaining or losing the tag gives it
// a new number at the next read. An ended session already refused the tag change.
// Operator ruling N7 — the tag route's and restore's refusal (an event holding
// this challenge already asks the topic) names the event and its question only
// where the caller organises that event: an event admin is not told another
// organiser's event names or challenge titles.
function _heldTopicClause(req, comp, dup) {
  return competitionDenied(req, comp.id)
    ? "an event holding this question that you do not organise already has a qualifying question on this topic"
    : `“${comp.name}” holds this question and already has a qualifying question on this topic (“${dup.held_title}”)`;
}

// A Program learner an organiser's edit of challenge `taskId` has just made
// complete (it left their count, or an earlier answer to it turned correct) is
// queued for their completion certificate, as a completing answer queues it:
// only the learners THIS edit completed (lib/certificate-dispatch.js
// enqueueCompletersOf). `compIds`: the events whose count the edit changed (null:
// every event holding the challenge); `solvedBefore` for a write that changes
// answers. After the write commits; never fails the request. Deleting a
// challenge needs none: it is refused for one with answers or in a live event.
function _queueCompleters(taskId, compIds = null, solvedBefore = null) {
  try {
    const ids = compIds || db.prepare("SELECT competition_id FROM competition_tasks WHERE task_id=?").all(taskId).map(r => r.competition_id);
    require("../lib/certificate-dispatch").enqueueCompletersOf(ids, { taskId, solvedBefore });
  } catch (e) { swallowed("challenges:queue-completers", e); }
}
// Who had answered `taskId` correctly, per event, read before a write that changes answers.
function _correctSolversByEvent(taskId) {
  const m = new Map();
  for (const r of db.prepare("SELECT DISTINCT competition_id, user_id FROM submissions WHERE task_id=? AND is_correct=1").all(taskId)) {
    if (!m.has(r.competition_id)) m.set(r.competition_id, new Set());
    m.get(r.competition_id).add(r.user_id);
  }
  return m;
}

function _renumberAfterQualifyingChange(taskId) {
  const held = db.prepare("SELECT competition_id FROM competition_tasks WHERE task_id=?").all(taskId);
  db.prepare("UPDATE competition_tasks SET task_number=NULL WHERE task_id=?").run(taskId);
  for (const h of held) _invalidateTaskNumbersCache(h.competition_id);
}

// Sweep #91 — a challenge becoming, or stopping being, a qualifying question has
// its stored answers and hint costs re-priced in every event holding it, inside
// the writer's transaction (lib/qualifying-rescore.js says why and lists the
// writers). Answers the events holding the challenge, for the busts after commit
// (`_afterQualifyingFlip`).
function _rescoreAfterQualifyingFlip(req, taskId, reason) {
  return rescoreAfterQualifyingFlip(taskId, reason, getAdminIdentity(req), reqContext(req));
}
// After the commit: every event holding the challenge re-reads its board at once
// (its finish count moves even when no stored row did), and its members' /api/me.
function _afterQualifyingFlip(held) {
  for (const cid of held) invalidateLeaderboardCache(cid);
  _invalidateMeCacheForComps(held);
}

module.exports = function register(app) {
app.post("/api/admin/tasks/:id/publish", requireAdmin, csrfProtection, (req, res) => {
  const task = db.prepare("SELECT id, status, locked, created_by_id, answer_sealed FROM tasks WHERE id=?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Question not found" });
  // v8.12.0 — a competitor may not change a challenge held by the event they
  // compete in. Above the seal and the tier gate, for the reason the seal sits
  // above the tier gate: it binds every tier, so answering another question
  // first would hand a superadmin a different reason for the same refusal.
  { const _cmp = refuseCompetitor(res, competitorTaskEditDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  // v8.10.0 — a SEALED challenge is its author's to manage, full stop. Publishing
  // moves `status`, one of the scoring fields, so in the operator's own words this is
  // editing the challenge. It sits ABOVE the tier gate because the seal binds
  // every tier including superadmin, so answering the tier question first would
  // give a superadmin a different reason for the same refusal.
  //
  // It is here rather than only on the client because the row already withholds
  // Publish for a non-author (`can_edit` is false), and a screen that hides a
  // control the server would accept is the v7.14.2 defect with the sides swapped:
  // the next reader restores the button on the evidence that the route works.
  // Escape hatches are untouched — unassigning the challenge from an event and a
  // superadmin deleting it are both un-sealed, so nobody is ever stuck with a
  // sealed challenge they cannot get out of their event.
  {
    const denied = sealedEditDenied(task, actingAdminId(req), sealRevealedFor(req, task.id));
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  // v8.7.0 — publishing flips `status`, which is one of the scoring fields, so it
  // takes the STRICT gate rather than the owner-only one: `status` is a
  // leaderboard predicate (`buildLeaderboardEntries` counts totalTasks with
  // `status='published'`), so publishing a challenge some other admin's event
  // also holds moves that event's all-solved denominator.
  //
  // In the ordinary case this is EXACTLY the owner rule and costs nothing: a
  // draft cannot be assigned to anything (every assign route refuses a
  // non-published challenge), so `taskScoringEditDenied` finds no holding events
  // and degrades to `taskEditDenied`. It bites only on the anomalous shape a
  // global admin can create — restoring a SHARED challenge to a draft version —
  // which is precisely the case the strict gate was written for.
  //
  // Ahead of the already-published 400 because a permission answer about the
  // actor should not be preceded by a state answer about a row they may not touch.
  {
    const denied = taskScoringEditDenied(req, task);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  if (task.status === "published") return res.status(400).json({ error: "Question is already published" });
  // v6.16.14 — completes the lock-doctrine coverage. PUT /:id (line
  // 7269), PATCH /:id/visibility (v6.16.10), POST /:id/restore
  // (v6.16.13), POST /:id/recalculate (v6.16.13), submit, hint, and
  // attachments all gate on `task.locked`. Publish was the one
  // remaining gap. Superadmin can still publish a locked task because
  // they can also unlock it; regular admin gets 403.
  if (task.locked && !req.session.isSuperAdmin) {
    return res.status(403).json({ error: "Question is locked. Only a superadmin can publish a locked draft." });
  }
  // v6.16.7 — wrap UPDATE + version emit in a single txn.
  // v6.16.16 — re-assert lock state inside the txn (TOCTOU close).
  // ext-audit v7.21.1 — the ended-session freeze. `status` is a leaderboard
  // predicate (buildLeaderboardEntries counts totalTasks with
  // t.status='published'), so publishing a challenge into a competition whose
  // session has ended changes that finished competition's all-solved denominator
  // and can re-order its final ranks. See taskFrozenByEndedCompetition.
  {
    const _frozen = taskFrozenByEndedCompetition(req.params.id);
    if (_frozen) return res.status(409).json({ error: `Cannot publish — this question is in "${_frozen.name}", which has an ended session whose final standings are frozen. ${FROZEN_REMEDY}` });
  }
  const _adminId = getAdminIdentity(req);
  let _pubLockedRace = false;
  const pubTxn = db.transaction(() => {
    const lockBypass = req.session.isSuperAdmin ? 1 : 0;
    const r = db.prepare("UPDATE tasks SET status='published', updated_at=? WHERE id=? AND (locked=0 OR ?=1)").run(now().toISOString(), req.params.id, lockBypass);
    if (r.changes === 0) { _pubLockedRace = true; throw new Error("locked_race"); }
    createTaskVersion(req.params.id, _adminId, "publish", null, { changes: { status: { from: task.status, to: "published" } }, ...reqContext(req) });
  });
  try { runTxnWithMirrorBuffer(() => pubTxn()); }
  catch (e) {
    if (_pubLockedRace) return res.status(403).json({ error: "Question was locked while publishing. Only a superadmin can publish a locked draft." });
    throw e;
  }
  // audit v7.7.36 (C8) — status='published' is a leaderboard predicate (totalTasks
  // filters t.status='published'), and a task can be assigned to a live comp while
  // draft (restore-to-draft keeps competition_tasks rows). Re-publishing changes
  // totalTasks → allSolved/finish detection, so bust every assigned comp's board
  // (mirrors the visibility PATCH + restore siblings).
  for (const cid of db.prepare("SELECT DISTINCT competition_id FROM competition_tasks WHERE task_id=?").all(req.params.id).map(r => r.competition_id)) invalidateLeaderboardCache(cid);
  res.json({ ok: true });
});

// POST = additive (used by competition task picker to add a task to one competition)
app.post("/api/admin/tasks/:id/competitions", requireAdmin, csrfProtection, (req, res) => {
  // v8.1.0 (PR 30) — title + answer_type join the SELECT because the fit check
  // below needs both. A column-naming SELECT is a list that rots: when a phase
  // adds a rule that reads a column, every SELECT feeding it has to grow.
  // v8.12.0 — `answer_sealed` joins it for the staff-compete seal check below.
  const task = db.prepare("SELECT id, title, status, locked, answer_type, created_by_id, answer_sealed FROM tasks WHERE id=?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Question not found" });
  // v8.12.0 — a competitor may not add a challenge to the event they compete in.
  // Asked FIRST, over every named event, ahead of the visibility and locked-task
  // gates: the lock binds every tier, so a question answered before it hands one
  // tier a different reason for the same refusal. A non-ARRAY simply has nothing
  // to ask about; the "array required" refusal below answers it.
  const { competitionIds } = req.body || {};
  if (Array.isArray(competitionIds)) {
    // v8.13.3 — THE ELEMENTS ARE VALIDATED BEFORE ANYTHING ASKS ABOUT THEM, and
    // that placement is the fix. v8.12.0 SKIPPED a non-string element here and
    // bound it, untouched, in the transaction below — and better-sqlite3 FLATTENS
    // a one-element array, so `competitionIds: [["<E>"]]` sailed past the
    // competitor lock and was then read and INSERTed as competition E. A
    // user-backed admin or superadmin competing in E could add a challenge to
    // their own board (an event admin was refused by `competitionDenied`'s JS
    // `includes`, and the built-in superadmin is never a competitor). Every other
    // non-string shape reached the same bind and came back as the driver's own
    // text ("Too few parameter values were provided"). The bulk twin is
    // consistent because it skips such an element in BOTH loops; this route
    // skipped in one and bound in the other. One 400, the same for every tier,
    // ahead of every gate — the participants and invitations doors' sentence.
    if (competitionIds.some(c => typeof c !== "string")) return res.status(400).json({ error: "competitionIds must be an array of strings" });
    // v8.13.3 — and BOUNDED, like the bulk twin (audit v7.12.3 #9). Each element
    // costs this transaction a SELECT, two slot reads and an INSERT, so an
    // uncapped array is a write-lock hold any admin could make arbitrarily long.
    if (competitionIds.length > BULK_ADMIN_MAX) return res.status(400).json({ error: `Cannot assign a question to more than ${BULK_ADMIN_MAX} events in a single request.` });
    for (const cid of new Set(competitionIds)) {
      const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), cid));
      if (_cmp) return _cmp;
    }
  }
  // v8.7.0 — VIEW, not edit. Adding a public-domain challenge to your own event
  // is the whole point of that tag, so requiring ownership here would make it
  // inert; adding a challenge to an event changes the EVENT, not the challenge.
  {
    const denied = taskViewDenied(req, task);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  if (task.status !== "published") return res.status(400).json({ error: "Only published questions can be assigned to events" });
  // v6.16.16 — comp assignment is scoring-relevant via the auto-end
  // gate's `WHERE t.active=1` count + per-comp leaderboard membership.
  // Locked-task doctrine (PUT, visibility, publish, restore,
  // recalculate, submit, hint, attachments) all gate on `task.locked`;
  // assignment was the one remaining path that bypassed the lock.
  // A regular admin attaching a locked task to additional comps would
  // expand its scoring footprint silently. Superadmin can still
  // assign because they can also unlock.
  if (task.locked && !req.session.isSuperAdmin) {
    return res.status(403).json({ error: "Question is locked. Only a superadmin can change event assignments." });
  }
  if (!Array.isArray(competitionIds) || competitionIds.length === 0)
    return res.status(400).json({ error: "competitionIds array required" });
  // v8.7.0 — every NAMED event has to be one this actor runs, and the refusal
  // comes BEFORE the transaction: this route is already all-or-nothing (one
  // ended or unfit competition throws and assigns nothing), so a partial success
  // would be the one outcome it has never had.
  for (const cid of competitionIds) {
    const denied = competitionDenied(req, cid);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  const adminId = getAdminIdentity(req);
  // v8.7.0 — PROVENANCE, alongside the audit trail's `assigned_by` email. It is
  // what `taskUnassignDenied` reads, so an event admin can take back what they
  // added and nothing else. Two columns, two jobs: one names the actor for a
  // human reading history, the other answers an authorization question and
  // therefore must not move when an email does.
  const actingId = actorId(req);
  const assignedAt = now().toISOString();
  // Validate + insert atomically so status can't change between check and write
  const changedCids = [];
  const copies = [];
  const addTasks = db.transaction(() => {
    // v8.7.0 — `assigned_by_id` goes in THIS statement, never a follow-up UPDATE:
    // `OR IGNORE` writes nothing when the pair already exists, so an UPDATE keyed
    // on `r.changes` would leave the column NULL exactly on the OLDEST rows — and
    // NULL reads as "no event admin assigned this", i.e. nobody may remove it.
    const ins = db.prepare("INSERT OR IGNORE INTO competition_tasks (competition_id, task_id, assigned_by, assigned_at, assigned_by_id) VALUES (?,?,?,?,?)");
    let assigned = 0;
    const taskTitle = db.prepare("SELECT title FROM tasks WHERE id=?").get(task.id)?.title;
    // Ruling N7 — the qualifying keys this challenge carries (none for most).
    const _qKeys = qualifyingKeysFromTags(db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(task.id).map(r => r.tag));
    // v8.12.0 — THE SEAL REFUSAL IS COLLECTED OVER THE WHOLE REQUEST before the
    // insert loop, so a request naming two compete events reports BOTH pairs and
    // an honest `refused_total`; refusing at the first one (which the in-loop
    // check below still does, as belt and braces) would name one event of two
    // in the client's modal.
    {
      const _refusedAll = [];
      let _firstSeal = null;
      // DEDUPED: a repeated id in one request is one (challenge, event) pair, so
      // it is listed once and `refused_total` counts it once — the success path
      // already tolerates the repeat (INSERT OR IGNORE), so only the ledger saw it.
      for (const cid of new Set(competitionIds)) {
        const comp = db.prepare("SELECT id, name, event_kind, start_time, duration_minutes, ended_at, staff_compete FROM competitions WHERE id=?").get(cid);
        // An ended event keeps its own (older) refusal from the loop below.
        if (!comp || competitionStatus(comp) === "ended" || competitionAnySlotEnded(comp)) continue;
        const _tgt = _assignTarget(task, cid);
        const _seal = unsealedAssignmentDenied(_tgt, comp) || authorCompetesDenied(db, _tgt, comp);
        if (_seal) {
          _firstSeal = _firstSeal || _seal;
          _refusedAll.push({ task_id: task.id, title: task.title, competition_id: comp.id, competition_name: comp.name, reason: _seal.reason, message: _seal.message });
        }
      }
      if (_refusedAll.length) throw _assignRefusal(_firstSeal.message, { code: _firstSeal.code, refused: _refusedAll });
    }
    for (const cid of competitionIds) {
      // v8.12.0 — `staff_compete` joins the SELECT for the seal check below.
      const comp = db.prepare("SELECT id, name, event_kind, start_time, duration_minutes, ended_at, staff_compete FROM competitions WHERE id=?").get(cid);
      if (!comp) throw _assignRefusal(`Competition not found: ${cid}`);
      if (competitionStatus(comp) === "ended" || competitionAnySlotEnded(comp)) {
        throw _assignRefusal(`Cannot modify question assignments for competition "${comp.name}" — a session has already ended.`);
      }
      // v8.1.0 (PR 30) — REFUSE rather than assign-and-disappoint. This extends
      // the ended-only gate immediately above it: same transaction, same throw,
      // so a batch that names one unfit competition assigns NOTHING. Partial
      // success here would be the v7.21.19 F1 defect (a refused bulk action that
      // still mutated) in a new place.
      // The row that goes in: an existing copy this event holds is judged itself.
      const _tgt = _assignTarget(task, cid);
      { const _st = _assignTargetStateRefusal(task, _tgt, !!req.session.isSuperAdmin); if (_st) throw _assignRefusal(_st.message); }
      const _fit = _fitError(_tgt, comp);
      if (_fit) throw _assignRefusal(_fit.message);
      // v8.12.0 — THE SEAL INVARIANT AT THE ASSIGNMENT DOOR. An event that lets
      // staff compete admits only SEALED challenges (a competing admin can read
      // an unsealed key off the admin pane), and never one whose AUTHOR competes
      // there (the seal admits its author). Same posture as the fit check — one
      // refused event assigns nothing — but the refusal is STRUCTURED so the
      // client can list the offending pairs in a modal rather than a toast.
      // v8.13.3 — UNREACHABLE today, and marked anyway: the pre-pass above asks
      // the identical predicate over the identical (deduped) set inside the same
      // synchronous transaction, so nothing can change between them. Declared
      // defence in depth — a mutation dropping this marker survives every test.
      const _seal = unsealedAssignmentDenied(_tgt, comp) || authorCompetesDenied(db, _tgt, comp);
      if (_seal) {
        throw _assignRefusal(_seal.message, { code: _seal.code, refused: [{ task_id: task.id, title: task.title, competition_id: comp.id, competition_name: comp.name, reason: _seal.reason, message: _seal.message }] });
      }
      // Operator ruling N7 (14 Nov 2026) — AN EVENT ASKS EACH QUALIFYING
      // QUESTION ONCE: another event's may be shared, never one whose key this
      // event already holds (lib/qualifying.js). Asked inside the transaction, so
      // two same-key challenges sent at once cannot both land; an assignment
      // that already exists is not a change and is not asked about. Of the row
      // that goes in: a reused copy carries its own tags.
      const _tqKeys = _tgt === task ? _qKeys : qualifyingKeysFromTags(db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(_tgt.id).map(r => r.tag));
      if (_tqKeys.length && !db.prepare("SELECT 1 FROM competition_tasks WHERE competition_id=? AND task_id=?").get(cid, _tgt.id)) {
        const _dup = qualifyingKeyHeldDenied(db, comp, _tgt.id, _tqKeys);
        if (_dup) throw _assignRefusal(_dup.message, { code: _dup.code });
      }
      // The event's own question: this event's copy of a bank question (made
      // now, or found from an earlier add), or the question itself when the
      // event owns it. Another event's question is refused: copying is the
      // only way to share one.
      const _et = eventTaskFor(db, task.id, cid, { changedBy: adminId, via: "assign", nowIso: assignedAt });
      if (_et.refused) throw _assignRefusal(_et.refused.message, { code: _et.refused.code });
      const r = ins.run(cid, _et.id, adminId, assignedAt, actingId);
      copies.push({ competition_id: cid, task_id: _et.id });
      // Only count rows the INSERT OR IGNORE actually inserted. Without this
      // the response overstates the batch — a competitionIds list that
      // contains duplicates (or ids the task was already assigned to) still
      // reported `assigned = N`, misleading the UI's success toast.
      if (r.changes > 0) {
        recordCompetitionEvent(cid, "task_added", adminId, { task_id: _et.id, task_title: taskTitle, ...(_et.id !== task.id ? { copied_from: task.id } : {}), ...reqContext(req) });
        _invalidateTaskNumbersCache(cid);
        changedCids.push(cid);
        // v6.8.2 — eagerly re-number if the comp is already live/ended so
        // the admin listing shows the new challenge's X.YY id immediately
        // instead of waiting for a participant's /api/tasks hit to assign
        // it. `ensureTaskNumbers` no-ops for upcoming comps.
        ensureTaskNumbers(cid, comp);
        assigned++;
      }
    }
    return assigned;
  });
  let assigned;
  try {
    // runTxnWithMirrorBuffer (ext-audit F4): each recordCompetitionEvent
    // ("task_added") emit is followed by ensureTaskNumbers writes + further
    // loop INSERTs, so a throw past an emit (a later cid hitting an ended comp)
    // must not leak a ghost app.jsonl mirror line for the already-emitted cids.
    assigned = runTxnWithMirrorBuffer(() => addTasks());
  } catch (e) {
    // v8.12.0 — a structured refusal carries its code and the refused pairs; a
    // plain one keeps the bare `{error}` shape it has always had.
    // v8.13.3 — ONLY a MARKED refusal is answered here (see `_assignRefusal`).
    // Anything else is an internal error: re-thrown, so the global handler logs
    // it with its stack and answers the generic 500 rather than a 400 quoting the
    // driver. The try is narrowed to the transaction for the same reason — a
    // throw in the cache busts below would otherwise answer an error for a write
    // that has already COMMITTED. A coded refusal with no pairs (N7's
    // `qualifying_key_held`) carries its code alone.
    if (e && e.userError) return res.status(400).json({ error: e.error, ...(e.code ? { code: e.code, ...(e.refused ? capRefused(e.refused) : {}) } : {}) });
    throw e;
  }
  // v6.20.x — leaderboard score aggregation JOINs competition_tasks (v6.16.26),
  // so adding a task to a comp changes every member's score. Bust the cache for
  // each affected comp, matching the DELETE sibling's writer-lock invariant.
  for (const cid of changedCids) invalidateLeaderboardCache(cid);
  _invalidateMeCacheForComps(changedCids);
  // `copies`: the question each event now holds (its own copy, for a bank one).
  res.json({ ok: true, assigned, copies });
});

// v7.12.0 — BULK assign: add many challenges to many competitions in one request
// (mirrors the participants pane's bulk "Assign to Competitions"). BEST-EFFORT so a
// single bad row can't fail the batch: draft tasks, locked tasks for a regular admin,
// and ended / missing competitions are SKIPPED (not a hard 400), and the response
// reports what landed + a per-reason skip breakdown. Reuses the single-assign
// invariants: published+unlocked task doctrine, per-comp task_added audit + task-number
// re-number + leaderboard/me cache busts.
app.post("/api/admin/tasks/assign-competitions", requireAdmin, bulkAdminLimit, csrfProtection, (req, res) => {
  const { taskIds, competitionIds } = req.body;
  if (!Array.isArray(taskIds) || taskIds.length === 0) return res.status(400).json({ error: "taskIds array required" });
  if (!Array.isArray(competitionIds) || competitionIds.length === 0) return res.status(400).json({ error: "competitionIds array required" });
  // audit v7.12.3 (#9) — cap both arrays like every sibling bulk endpoint so a single
  // authenticated request can't hold the write lock for a huge batch (it was bounded
  // only by the 5 MB JSON parser → ~100k ids).
  if (taskIds.length > BULK_ADMIN_MAX || competitionIds.length > BULK_ADMIN_MAX) {
    return res.status(400).json({ error: `Cannot assign more than ${BULK_ADMIN_MAX} questions or events in a single request.` });
  }
  // Dedupe up front — repeated ids do no useful work (INSERT OR IGNORE) but each
  // still costs a SELECT/renumber pass.
  const uniqTaskIds = [...new Set(taskIds)];
  const uniqCompIds = [...new Set(competitionIds)];
  const adminId = getAdminIdentity(req);
  const actingId = actorId(req);            // v8.7.0 — provenance; see the single-assign twin
  const isSuper = !!req.session.isSuperAdmin;
  const assignedAt = now().toISOString();
  // v8.1.0 (PR 30) — `unfit` joins the skip ledger rather than becoming a 400.
  // This route's documented posture is best-effort (drafts, locked challenges and
  // ended competitions all SKIP), and one file-answer challenge must not sink a
  // 500-challenge migration. The count is surfaced in the toast, because a skip
  // counter with no human consumer is the v7.21.2 defect.
  // v8.7.0 — `outOfScope` (an event this actor does not run) and `notOwned` (a
  // challenge they may not use: not created by them, not public-domain, not
  // already in one of their events) join the ledger rather than becoming a 403.
  // This route's whole posture is best-effort, and a selection made from a
  // NARROWED list can still name a row that moved under it — refusing the batch
  // would make one stale row sink a 500-challenge assignment.
  // v8.12.0 — `unsealed` and `authorCompetes` join the ledger (the staff-compete
  // seal invariant, per (challenge, event) like `unfit`), and the REFUSED PAIRS
  // ride the response so the client can show a modal naming them. Capped at
  // REFUSED_LIST_CAP with the true total beside it — a truncated list that does
  // not admit to being truncated is a wrong answer.
  // Operator ruling N7 (14 Nov 2026) — `qualifyingHeld`: a qualifying question
  // whose key the event already holds (an event asks each one once), per
  // (challenge, event) pair like `unfit`.
  // `ownedElsewhere`: a question another event owns (it can only be copied).
  const skipped = { notFound: 0, draft: 0, locked: 0, endedComp: 0, missingComp: 0, unfit: 0, outOfScope: 0, notOwned: 0, unsealed: 0, authorCompetes: 0, qualifyingHeld: 0, ownedElsewhere: 0 };
  const copies = [];
  const unfitReasons = [];
  const refused = [];
  const changedCids = new Set();
  let assigned = 0;
  // v8.12.0 — a competitor may not add challenges to the event they compete in.
  // A 403 by name rather than a skip: the ledger is for rows that MOVED under a
  // best-effort batch, and this is an authorisation rule about the actor that
  // binds every tier — refused before any write, like the participants twin.
  for (const cid of uniqCompIds) {
    if (typeof cid !== "string") continue;
    const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), cid));
    if (_cmp) return _cmp;
  }
  const txn = db.transaction(() => {
    // audit v7.12.3 (#2) — hoist the prepared statements OUT of the loops (they were
    // recompiled per element).
    // v8.7.0 — `assigned_by_id` in the same statement, for the `OR IGNORE` reason
    // spelled out at the single-assign twin above.
    const ins = db.prepare("INSERT OR IGNORE INTO competition_tasks (competition_id, task_id, assigned_by, assigned_at, assigned_by_id) VALUES (?,?,?,?,?)");
    // v8.12.0 — `staff_compete` and `answer_sealed` join the two SELECTs for the seal check.
    const selComp = db.prepare("SELECT id, name, event_kind, start_time, duration_minutes, ended_at, staff_compete FROM competitions WHERE id=?");
    const selTask = db.prepare("SELECT id, title, status, locked, answer_type, created_by_id, answer_sealed FROM tasks WHERE id=?");
    const tagCache = new Map();
    const selTags = db.prepare("SELECT tag FROM task_tags WHERE task_id=?");
    const isIn = db.prepare("SELECT 1 FROM competition_tasks WHERE competition_id=? AND task_id=?");
    // Resolve the valid target competitions ONCE (a comp being ended/missing is
    // skipped for the whole batch, not re-checked per task).
    const validComps = [];
    for (const cid of uniqCompIds) {
      // Type-guard each element BEFORE the SQL bind: a non-string (object/array/
      // bool) would throw in better-sqlite3 and, with no try/catch around this txn,
      // 500 the whole batch — breaking the best-effort contract + the "no mutating
      // endpoint 500s on a non-string field" invariant (ext-audit batch 7). Skip it.
      if (typeof cid !== "string") { skipped.missingComp++; continue; }
      // v8.7.0 — asked BEFORE the row is read, so for an event admin "no such
      // event" and "not your event" are one answer. Asking after would make the
      // ledger an existence oracle: a one-element batch returning `missingComp`
      // rather than `outOfScope` says the id is real. Ahead of the ended check
      // for the same reason — an event they cannot see should not report its
      // lifecycle to them.
      if (competitionDenied(req, cid)) { skipped.outOfScope++; continue; }
      const comp = selComp.get(cid);
      if (!comp) { skipped.missingComp++; continue; }
      if (competitionStatus(comp) === "ended" || competitionAnySlotEnded(comp)) { skipped.endedComp++; continue; }
      validComps.push(comp);
    }
    for (const tid of uniqTaskIds) {
      if (typeof tid !== "string") { skipped.notFound++; continue; }  // same type-guard as comps above
      const task = selTask.get(tid);
      // v8.7.0 — VISIBILITY, matching the single-assign twin: assigning changes
      // the EVENT, not the challenge, so a public-domain challenge is usable by
      // anyone. `taskViewDenied` refuses a null row too, which collapses "no such
      // challenge" into the same answer for the same anti-oracle reason as the
      // competition loop above; a global admin still gets `notFound` unchanged,
      // because the predicate returns null for an unscoped actor before it reads
      // anything.
      if (taskViewDenied(req, task)) { skipped.notOwned++; continue; }
      if (!task) { skipped.notFound++; continue; }
      if (task.status !== "published") { skipped.draft++; continue; }   // only published can be assigned
      if (task.locked && !isSuper) { skipped.locked++; continue; }       // locked-task doctrine (regular admin)
      const qKeys = qualifyingKeysFromTags(selTags.all(task.id).map(r => r.tag));
      for (const comp of validComps) {
        // The row that goes in: an existing copy this event holds is judged itself.
        const tgt = _assignTarget(task, comp.id);
        { const _st = _assignTargetStateRefusal(task, tgt, isSuper); if (_st) { skipped[_st.kind]++; continue; } }
        // v8.1.0 (PR 30) — per (challenge, event), because fit is a property of
        // the PAIR: the same challenge is fine in a Competition and refused at a
        // Booth Event in the same request.
        const fit = _fitError(tgt, comp, tagCache);
        if (fit) {
          skipped.unfit++;
          if (unfitReasons.length < 5) unfitReasons.push(fit.message);
          continue;
        }
        // v8.12.0 — the seal invariant, per pair (see the single-assign twin).
        const _seal = unsealedAssignmentDenied(tgt, comp) || authorCompetesDenied(db, tgt, comp);
        if (_seal) {
          if (_seal.reason === "unsealed") skipped.unsealed++; else skipped.authorCompetes++;
          refused.push({ task_id: task.id, title: task.title, competition_id: comp.id, competition_name: comp.name, reason: _seal.reason, message: _seal.message });
          continue;
        }
        // Ruling N7 — read inside this transaction, so an earlier challenge of the
        // same batch already put into the event counts (only one of two same-key
        // questions lands). An existing assignment is not a change.
        const tqKeys = tgt === task ? qKeys : qualifyingKeysFromTags(selTags.all(tgt.id).map(r => r.tag));
        if (tqKeys.length && !isIn.get(comp.id, tgt.id) && qualifyingKeyHeldDenied(db, comp, tgt.id, tqKeys)) {
          skipped.qualifyingHeld++;
          continue;
        }
        // The event's own question (lib/event-copies.js); another event's
        // question is skipped, per pair, like `unfit`.
        const _et = eventTaskFor(db, task.id, comp.id, { changedBy: adminId, via: "bulk", nowIso: assignedAt });
        if (_et.refused) { skipped.ownedElsewhere++; continue; }
        const r = ins.run(comp.id, _et.id, adminId, assignedAt, actingId);
        copies.push({ competition_id: comp.id, task_id: _et.id, from: task.id });
        if (r.changes > 0) {
          recordCompetitionEvent(comp.id, "task_added", adminId, { task_id: _et.id, task_title: task.title, via: "bulk", ...(_et.id !== task.id ? { copied_from: task.id } : {}), ...reqContext(req) });
          changedCids.add(comp.id);
          assigned++;
        }
      }
    }
    // audit v7.12.3 (#2) — renumber each CHANGED comp ONCE after all inserts, not per
    // inserted (task,comp) row. ensureTaskNumbers busts+rebuilds the whole comp's
    // numbering (an O(rows) SELECT-JOIN-ORDER); doing it per row was O(T²) inside one
    // write transaction (measured 626 ms / 1000 tasks). Numbers are sticky, so a single
    // end-of-batch pass per comp is equivalent. (Its status gate no-ops for upcoming comps.)
    const compById = new Map(validComps.map(c => [c.id, c]));
    for (const cid of changedCids) {
      _invalidateTaskNumbersCache(cid);
      ensureTaskNumbers(cid, compById.get(cid));
    }
  });
  runTxnWithMirrorBuffer(() => txn());
  for (const cid of changedCids) invalidateLeaderboardCache(cid);
  _invalidateMeCacheForComps([...changedCids]);
  // v8.1.0 (PR 30) — the REASONS ride the response, capped at five. A bare count
  // ("3 skipped") tells an admin something is wrong and not which challenge or
  // why, on the one screen where they could fix it.
  res.json({ ok: true, assigned, skipped, copies, ...(unfitReasons.length ? { unfitReasons } : {}), ...(refused.length ? capRefused(refused) : {}) });
});

// PUT = desired-state sync (used by "Assign to Competitions" modal)
// Client sends competitionIds (desired) + expectedAssignments (snapshot when modal opened).
// Server rejects with 409 if live state has diverged, forcing the admin to refresh.
app.put("/api/admin/tasks/:id/competitions", requireAdmin, csrfProtection, (req, res) => {
  // v8.1.0 (PR 30) — title + answer_type for the fit check, as in the POST twin.
  // v8.12.0 — `answer_sealed` for the staff-compete seal check, likewise.
  const task = db.prepare("SELECT id, title, status, locked, answer_type, created_by_id, answer_sealed FROM tasks WHERE id=?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Question not found" });
  const { competitionIds, expectedAssignments } = req.body || {};
  // v8.13.3 — THE ELEMENTS ARE VALIDATED BEFORE ANYTHING ASKS ABOUT THEM, for the
  // reason the POST twin gives. Here the pre-pass below FILTERED non-strings into
  // a copy while the transaction worked on the RAW arrays, so a nested id
  // `[["<C>"]]` was read as C (better-sqlite3 flattens a one-element array) but
  // compared by JS identity in the diff: the challenge was DELETED from C and
  // re-INSERTed, rewriting `assigned_at` and `assigned_by_id` (the provenance
  // `taskUnassignDenied` reads) and emitting a spurious task_removed/task_added
  // pair — while a nested id in `expectedAssignments` answered a FALSE 409 blaming
  // a colleague, and `[{}]` answered the driver's own text. Two explicit
  // statements, one per array, each naming its own field.
  if (Array.isArray(competitionIds) && competitionIds.some(c => typeof c !== "string")) return res.status(400).json({ error: "competitionIds must be an array of strings" });
  if (Array.isArray(expectedAssignments) && expectedAssignments.some(c => typeof c !== "string")) return res.status(400).json({ error: "expectedAssignments must be an array of strings" });
  // v8.13.3 — and BOUNDED, but on the CHANGE, not on the challenge's STATE (the
  // pre-release review). This is a DESIRED-STATE endpoint: the dialog sends every
  // current assignment back, ended and unrendered ones included, so a cap on the
  // list's length capped how many events a challenge may be in at all — past
  // BULK_ADMIN_MAX, every save from the dialog would be refused, an unchanged one
  // included. So: (1) both lists are DEDUPED first, and everything below works on
  // the deduped copies — the per-id loops (competitor pre-pass, scope, existence)
  // were the cost a long list of repeats bought (measured ~5.9 s of synchronous
  // work for 100 000 copies of one id); (2) a deduped list may exceed what the
  // challenge already holds by at most BULK_ADMIN_MAX — a desired set beyond that
  // adds more than one request may, and an expected set beyond that cannot equal
  // what was shown — which bounds every per-id loop by the real state; and (3)
  // inside the transaction, the adds plus the removals are capped at
  // BULK_ADMIN_MAX, the per-request bound the POST twin and the bulk door apply.
  const desiredIds = Array.isArray(competitionIds) ? [...new Set(competitionIds)] : null;
  const expectedIds = Array.isArray(expectedAssignments) ? [...new Set(expectedAssignments)] : null;
  const _curAll = desiredIds || expectedIds
    ? new Set(eventsHolding(db, task.id).map(r => r.competition_id))
    : null;
  const _changeMsg = `Cannot add or remove more than ${BULK_ADMIN_MAX} events in one save.`;
  if (desiredIds && desiredIds.filter(cid => !_curAll.has(cid)).length > BULK_ADMIN_MAX) return res.status(400).json({ error: _changeMsg });
  if (expectedIds && expectedIds.length > _curAll.size + BULK_ADMIN_MAX) return res.status(400).json({ error: "expectedAssignments lists far more events than this question is assigned to." });
  // v8.12.0 — the ADD direction of the competitor lock, asked FIRST for the
  // reason the POST twin gives. "Adding to an event I compete in" is a fact
  // about the whole current set, so it needs no narrowing; the REMOVE direction
  // is asked inside the transaction beside the diff, where the narrowed
  // (visible) set that computes removals lives.
  if (desiredIds) {
    const _desired = new Set(desiredIds);
    for (const cid of _desired) {
      if (_curAll.has(cid)) continue;
      const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), cid));
      if (_cmp) return _cmp;
    }
    // The REMOVE direction, asked HERE as well as inside the transaction: the
    // locked-task gate below refuses a non-superadmin before the transaction is
    // ever entered, so without this pre-pass a competing REGULAR admin dropping a
    // LOCKED challenge from the event they compete in heard "locked" with no code
    // while a competing superadmin heard competitor_cannot_edit for the same act —
    // the two-reasons-for-one-act shape the DELETE door closed. Prospective
    // removals are computed against the set the client was SHOWN (the v8.8.8
    // narrowing), exactly as the transaction computes them; the in-transaction
    // check remains the race guard.
    const _scopePre = scopedCompetitionIds(req);
    for (const cid of _curAll) {
      if (_desired.has(cid)) continue;
      if (_scopePre !== null && !_scopePre.includes(cid)) continue;
      const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), cid));
      if (_cmp) return _cmp;
    }
  }
  // v8.7.0 — VIEW, as in the additive twin. This route is the other door onto the
  // same action, so it takes the same rule: a door that is merely narrower is
  // still a door, and one that is wider is a hole.
  {
    const denied = taskViewDenied(req, task);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  if (task.status !== "published") return res.status(400).json({ error: "Only published questions can be assigned to events" });
  // v6.16.16 — same lock gate as POST companion above.
  if (task.locked && !req.session.isSuperAdmin) {
    return res.status(403).json({ error: "Question is locked. Only a superadmin can change event assignments." });
  }
  if (!Array.isArray(competitionIds))
    return res.status(400).json({ error: "competitionIds array required" });
  if (!Array.isArray(expectedAssignments))
    return res.status(400).json({ error: "expectedAssignments array required" });
  // All validation and writes happen atomically inside the transaction
  const applyDiffs = db.transaction(() => {
    // Load current assignments for concurrency check and diffing
    const currentRows = eventsHolding(db, task.id);   // a bank question is "in" every event holding a copy of it
    const currentSet = new Set(currentRows.map(r => r.competition_id));
    // v8.8.8 — THE SET THE CLIENT WAS SHOWN, which since this release is not the
    // whole set. `task.competitions` is narrowed for an event admin, so both the
    // concurrency comparison and the removal diff must be narrowed WITH it or the
    // fix is worse than the leak:
    //
    //   * comparing an unfiltered `currentSet` against a narrowed
    //     `expectedAssignments` turns every save on a shared challenge into a
    //     spurious 409 blaming a colleague for a conflict that does not exist,
    //     with a "reopen the dialog" remedy that can never succeed; and
    //   * diffing removals against an unfiltered `currentSet` computes every
    //     out-of-scope assignment as a removal nobody requested — which is
    //     exactly the v8.7.7 defect, re-created by the release that narrows the
    //     projection it was worked around.
    //
    // This is why v8.7.7 recorded the projection as load-bearing for the CLIENT
    // fix and deferred narrowing it: the three had to move in one commit. The
    // preservation is now the SERVER's, by construction — it never considers a
    // row it did not show — so the client's `preservedForTask` shrinks to what it
    // was always really for, the in-scope events the dialog does not draw.
    const scope = scopedCompetitionIds(req);
    const visibleSet = scope === null
      ? currentSet
      : new Set([...currentSet].filter(cid => scope.includes(cid)));
    // v8.8.8 — SCOPE FIRST, and on BOTH arrays.
    //
    // `expectedAssignments` is a claim about what the client was SHOWN, and a
    // scoped client is no longer shown an out-of-scope event — so naming one
    // there is the same category error as naming one in the desired set.
    //
    // AHEAD OF THE CONCURRENCY CHECK, for the reason the lifecycle loop below
    // already gives one step further down: a permission answer must not be
    // preceded by an answer about an event the actor cannot see. Left below it,
    // a forged request naming another organiser's event is told to "reopen the
    // dialog to see the latest state" — advice that can never succeed, about an
    // event the dialog will never show.
    for (const cid of new Set([...desiredIds, ...expectedIds])) {
      const d = competitionDenied(req, cid);
      if (d) throw { forbidden: true, code: d.code, message: d.message };
    }
    // Validate all requested competition IDs exist.
    // v8.13.3 — BELOW THE SCOPE REFUSAL, where it used to sit above it. Asked
    // first, it answered an event admin "Competition not found: X" for an id that
    // does not exist and `event_admin_out_of_scope` for one that does but is not
    // theirs — an existence oracle the POST twin (scope first) and the bulk door
    // (its own anti-oracle note) deliberately do not offer. For an unscoped
    // actor the scope loop asks nothing, so their answer is unchanged.
    // An id already assigned exists (the foreign key), so only the new ones are
    // looked up — one prepared statement, not one per element.
    const _exists = db.prepare("SELECT 1 FROM competitions WHERE id=?");
    for (const cid of desiredIds) {
      if (currentSet.has(cid)) continue;
      if (!_exists.get(cid)) {
        throw _assignRefusal(`Competition not found: ${cid}`);
      }
    }
    // Optimistic concurrency: reject if live state differs from what client saw
    const expectedSet = new Set(expectedIds);
    if (visibleSet.size !== expectedSet.size || ![...visibleSet].every(id => expectedSet.has(id))) {
      throw { conflict: true, message: "Assignments have been modified by another admin. Please close and reopen the dialog to see the latest state." };
    }
    const desiredSet = new Set(desiredIds);
    // `toAdd` still tests the FULL set — "already assigned" is a fact about the
    // challenge, not about who is looking — while removals may only be computed
    // from what this actor was shown.
    // DEDUPED, or a repeated id lists one refused pair twice and over-counts `added`.
    const toAdd = [...desiredSet].filter(cid => !currentSet.has(cid));
    const toRemoveIds = [...visibleSet].filter(cid => !desiredSet.has(cid));
    // v8.13.3 — the per-request bound, on what this save actually changes.
    if (toAdd.length + toRemoveIds.length > BULK_ADMIN_MAX) throw _assignRefusal(_changeMsg);
    // v8.12.0 — a competitor may not add the challenge to, or take it out of, the
    // event they compete in. Only the events that CHANGE are asked about: a
    // desired state that round-trips an existing assignment on that event
    // untouched is not a change to it. Ahead of the ended/fit loop, for the
    // reason the scope refusal above gives.
    for (const cid of [...toAdd, ...toRemoveIds]) {
      const d = competitorEditDenied(db, competitorIds(req), cid);
      if (d) throw { forbidden: true, code: d.code, message: d.message, competitionId: d.competitionId, competitionName: d.competitionName };
    }
    // v8.7.0 — SCOPE THE DIFF, and refuse the WHOLE request rather than quietly
    // honouring the part of it this actor may perform.
    //
    // v8.8.8 — CHECKED AGAINST THE WHOLE DESIRED SET NOW, and the reason the old
    // comment gave for not doing so has EXPIRED rather than been overruled. It
    // said an out-of-scope event "legitimately appears in `competitionIds`,
    // because the client sends back the state it was shown" — true while the
    // client was shown every event holding the challenge, and false since this
    // release narrowed `task.competitions`. A scoped client can no longer name an
    // event it cannot see, so testing the desired set refuses no legitimate save
    // and closes the one shape the diff test could not: naming an out-of-scope
    // event that is ALREADY assigned, which lands in neither `toAdd` nor
    // `toRemoveIds` and was therefore accepted in silence.
    //
    // A removal they did not make is REFUSED, not silently kept, and that is the
    // decision worth stating: the client sent a DESIRED STATE, so keeping a row
    // it asked to drop would answer 200 to a request the server did not carry
    // out, and the dialog would then render the old assignment as though the
    // admin had never touched it — a UI that lies is worse than a refusal. This
    // route is already all-or-nothing on ended competitions, so refusing here is
    // the posture it already has.
    //
    // Ahead of the ended/fit loop below because a permission answer must not be
    // preceded by a lifecycle answer about an event the actor cannot see.
    for (const cid of toRemoveIds) {
      const d = taskUnassignDenied(req, assignedEventTaskId(db, task.id, cid) || task.id, cid);
      if (d) {
        // The out-of-scope arm of `taskUnassignDenied` is unreachable from here
        // now — `toRemoveIds` is drawn from `visibleSet`, which is the scope — so
        // this can only be the NOT-ASSIGNER arm, about an event the actor really
        // does organise. Naming it is therefore correct rather than a disclosure,
        // which is the reconsideration v8.7.7 asked for when it recorded the
        // suffix alongside the unfiltered projection.
        const nm = db.prepare("SELECT name FROM competitions WHERE id=?").get(cid)?.name;
        throw { forbidden: true, code: d.code, message: nm ? `${d.message} (event: "${nm}")` : d.message };
      }
    }
    // v8.12.0 — the seal refusal over EVERY addition before anything is judged
    // one at a time, for the reason the POST twin gives: the client's modal
    // lists the refused pairs, so it must be handed all of them.
    {
      const _refusedAll = [];
      let _firstSeal = null;
      for (const cid of toAdd) {
        const comp = db.prepare("SELECT id, name, event_kind, start_time, duration_minutes, ended_at, staff_compete FROM competitions WHERE id=?").get(cid);
        // An ended event keeps its own (older) refusal from the loop below.
        if (!comp || competitionStatus(comp) === "ended" || competitionAnySlotEnded(comp)) continue;
        const _tgt = _assignTarget(task, cid);
        const _seal = unsealedAssignmentDenied(_tgt, comp) || authorCompetesDenied(db, _tgt, comp);
        if (_seal) {
          _firstSeal = _firstSeal || _seal;
          _refusedAll.push({ task_id: task.id, title: task.title, competition_id: comp.id, competition_name: comp.name, reason: _seal.reason, message: _seal.message });
        }
      }
      if (_refusedAll.length) throw _assignRefusal(_firstSeal.message, { code: _firstSeal.code, refused: _refusedAll });
    }
    // Block any changes (add or remove) involving ended competitions
    const allChangedIds = [...toAdd, ...toRemoveIds];
    // Ruling N7 — the qualifying keys this challenge carries (none for most).
    const _qKeys = toAdd.length ? qualifyingKeysFromTags(db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(task.id).map(r => r.tag)) : [];
    for (const cid of allChangedIds) {
      // v8.12.0 — `staff_compete` joins the SELECT for the seal check below.
      const comp = db.prepare("SELECT id, name, event_kind, start_time, duration_minutes, ended_at, staff_compete FROM competitions WHERE id=?").get(cid);
      if (comp && (competitionStatus(comp) === "ended" || competitionAnySlotEnded(comp))) {
        throw _assignRefusal(`Cannot modify question assignments for competition "${comp.name}" — a session has already ended.`);
      }
      // v8.1.0 (PR 30) — the second extension of an existing ended-only gate.
      // Scoped to ADDITIONS only: `allChangedIds` also holds removals, and
      // refusing to REMOVE an unfit challenge would trap it in the event it does
      // not belong in — the frozen-competition trap (v7.29.0) rebuilt exactly.
      if (comp && toAdd.includes(cid)) {
        // The row that goes in: an existing copy this event holds is judged itself.
        const _tgt = _assignTarget(task, cid);
        { const _st = _assignTargetStateRefusal(task, _tgt, !!req.session.isSuperAdmin); if (_st) throw _assignRefusal(_st.message); }
        const fit = _fitError(_tgt, comp);
        if (fit) throw _assignRefusal(fit.message);
        // v8.12.0 — the seal invariant, ADDITIONS only for the same reason: a
        // challenge already in a compete event stays removable whatever its seal
        // (removal is the remedy the refusals name). Structured, so the client
        // can list the refused pairs.
        // v8.13.3 — UNREACHABLE today (the pre-pass above refuses the same pairs
        // first, in the same transaction); marked anyway, declared as defence in
        // depth for the reason the POST twin's in-loop check gives.
        const _seal = unsealedAssignmentDenied(_tgt, comp) || authorCompetesDenied(db, _tgt, comp);
        if (_seal) {
          throw _assignRefusal(_seal.message, { code: _seal.code, refused: [{ task_id: task.id, title: task.title, competition_id: comp.id, competition_name: comp.name, reason: _seal.reason, message: _seal.message }] });
        }
        // Operator ruling N7 (14 Nov 2026) — an event asks each qualifying
        // question once: ADDITIONS only (taking one out is always allowed).
        const _tqKeys = _tgt === task ? _qKeys : qualifyingKeysFromTags(db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(_tgt.id).map(r => r.tag));
        if (_tqKeys.length) {
          const _dup = qualifyingKeyHeldDenied(db, comp, _tgt.id, _tqKeys);
          if (_dup) throw _assignRefusal(_dup.message, { code: _dup.code });
        }
      }
    }
    const del = db.prepare("DELETE FROM competition_tasks WHERE competition_id=? AND task_id=?");
    // v8.7.0 — `assigned_by_id` in the same statement, for the `OR IGNORE` reason
    // spelled out at the additive twin above.
    const ins = db.prepare("INSERT OR IGNORE INTO competition_tasks (competition_id, task_id, assigned_by, assigned_at, assigned_by_id) VALUES (?,?,?,?,?)");
    const adminId = getAdminIdentity(req);
    const actingId = actorId(req);          // v8.7.0 — provenance; see the additive twin
    const assignedAt = now().toISOString();
    const taskTitle = db.prepare("SELECT title FROM tasks WHERE id=?").get(task.id)?.title;
    const changedCids = [];
    const copies = [];
    // Each changed event with the question it held or now holds, for the completers.
    const changedPairs = [];
    for (const cid of toRemoveIds) {
      // The question the event actually holds: its copy, for a bank question.
      const eid = assignedEventTaskId(db, task.id, cid) || task.id;
      del.run(cid, eid);
      recordCompetitionEvent(cid, "task_removed", adminId, { task_id: eid, task_title: taskTitle, ...reqContext(req) });
      _invalidateTaskNumbersCache(cid);
      changedCids.push(cid);
      changedPairs.push([eid, cid]);
    }
    for (const cid of toAdd) {
      // The event's own question (lib/event-copies.js), as on the POST twin.
      const _et = eventTaskFor(db, task.id, cid, { changedBy: adminId, via: "assign", nowIso: assignedAt });
      if (_et.refused) throw _assignRefusal(_et.refused.message, { code: _et.refused.code });
      const r = ins.run(cid, _et.id, adminId, assignedAt, actingId);
      copies.push({ competition_id: cid, task_id: _et.id });
      if (r.changes > 0) {
        recordCompetitionEvent(cid, "task_added", adminId, { task_id: _et.id, task_title: taskTitle, ...(_et.id !== task.id ? { copied_from: task.id } : {}), ...reqContext(req) });
        _invalidateTaskNumbersCache(cid);
        changedCids.push(cid);
        changedPairs.push([_et.id, cid]);
        // v6.8.2 — eagerly re-number live/ended comps so the admin table
        // shows the new challenge's X.YY id on the very next fetch.
        const comp = db.prepare("SELECT id, name, start_time, duration_minutes, ended_at FROM competitions WHERE id=?").get(cid);
        if (comp) ensureTaskNumbers(cid, comp);
      }
    }
    return { added: toAdd.length, removed: toRemoveIds.length, changedCids, copies, changedPairs };
  });
  let result;
  try {
    // runTxnWithMirrorBuffer (ext-audit F4, twin of the POST addTasks above):
    // applyDiffs emits recordCompetitionEvent ("task_removed"/"task_added") then
    // writes more in the same txn AND can throw mid-loop (a later cid hitting an
    // ended comp / a concurrency conflict) → a rollback past an emit must not
    // leak ghost app.jsonl lines for the already-emitted cids.
    result = runTxnWithMirrorBuffer(() => applyDiffs());
  } catch (e) {
    if (e && e.conflict) return res.status(409).json({ error: e.message, conflict: true });
    // v8.7.0 — the scope refusals are thrown rather than returned so the
    // transaction rolls back whatever the diff loop had already written; the
    // sentinel shape mirrors the `conflict` one directly above it.
    if (e && e.forbidden) return res.status(403).json({ error: e.message, code: e.code, ...(e.competitionId ? { competitionId: e.competitionId, competitionName: e.competitionName } : {}) });
    // v8.12.0 — a structured seal refusal carries its code and the refused pairs.
    // v8.13.3 — only a MARKED refusal; anything else is re-thrown to the global
    // handler (logged, generic 500), for the reason the POST twin gives — and
    // the try is narrowed to the transaction for the same reason.
    if (e && e.userError) return res.status(400).json({ error: e.error, ...(e.code ? { code: e.code, ...(e.refused ? capRefused(e.refused) : {}) } : {}) });
    throw e;
  }
  // v6.20.x — score aggregation JOINs competition_tasks, so any add/remove
  // changes member scores on a live comp. Bust the leaderboard cache for every
  // comp whose assignment set changed (matches the DELETE sibling).
  for (const cid of result.changedCids) invalidateLeaderboardCache(cid);
  _invalidateMeCacheForComps(result.changedCids);
  // Per event, by the question that event held: "solved it before" is asked of
  // the event's own copy, never of the bank question nobody answers.
  for (const [eid, cid] of result.changedPairs) _queueCompleters(eid, [cid]);
  res.json({ ok: true, added: result.added, removed: result.removed, copies: result.copies });
});

app.delete("/api/admin/tasks/:id/competitions/:cid", requireAdmin, csrfProtection, (req, res) => {
  // v6.16.26 — close the locked-task DELETE bypass. POST + PUT (sister
  // routes above) both gate on `task.locked && !req.session.isSuperAdmin`
  // per the lock doctrine (CLAUDE.md *Freeze, lock and Booth fit*).
  // DELETE was the residual path that let a regular admin shrink a
  // locked task's competition footprint by unassigning it, silently
  // muting it from the leaderboard while the lock was meant to freeze
  // scoring assignments. Superadmin can still unassign because they
  // can also unlock. Same gate, same error copy as POST/PUT.
  // The question the event holds: naming a bank question means this event's
  // copy of it (lib/event-copies.js); its own lock is the one that binds.
  const eid = (typeof req.params.cid === "string" && assignedEventTaskId(db, req.params.id, req.params.cid)) || req.params.id;
  const task = db.prepare("SELECT id, locked FROM tasks WHERE id=?").get(eid);
  // v8.12.0 — a competitor may not take a challenge out of the event they compete
  // in. FIRST, as on every other task door: the lock binds every tier, so a
  // question answered ahead of it (the locked-task gate, the assigner rule) would
  // hand one tier a different reason for the same refusal — measured before this
  // was hoisted: a competing event admin heard `event_admin_not_assigner` and a
  // competing admin on a locked challenge heard "locked" with no code at all.
  { const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), req.params.cid)); if (_cmp) return _cmp; }
  if (task && task.locked && !req.session.isSuperAdmin) {
    return res.status(403).json({ error: "Question is locked. Only a superadmin can change event assignments." });
  }
  // v8.7.0 — an event admin may take back only what they added: the challenge
  // bank is shared, so removing somebody else's assignment silently shrinks an
  // event they do not run (`competition_tasks` is a leaderboard input — see the
  // cache bust below). The predicate asks about the actor's scope FIRST, so this
  // runs before the competition is even read and an out-of-scope event never
  // gets a found/not-found answer.
  {
    const denied = taskUnassignDenied(req, eid, req.params.cid);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  const comp = db.prepare("SELECT id, name, start_time, duration_minutes, ended_at FROM competitions WHERE id=?").get(req.params.cid);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  if (competitionStatus(comp) === "ended" || competitionAnySlotEnded(comp)) {
    return res.status(400).json({ error: `Cannot modify question assignments for event "${comp.name}" — a session has already ended.` });
  }
  const adminId = getAdminIdentity(req);
  const taskTitle = db.prepare("SELECT title FROM tasks WHERE id=?").get(eid)?.title;
  const removeTaskTxn = db.transaction(() => {
    const r = db.prepare("DELETE FROM competition_tasks WHERE competition_id=? AND task_id=?").run(req.params.cid, eid);
    if (r.changes > 0) recordCompetitionEvent(req.params.cid, "task_removed", adminId, { task_id: eid, task_title: taskTitle, ...reqContext(req) });
    return r.changes;
  });
  const changes = runTxnWithMirrorBuffer(() => removeTaskTxn());
  // v6.16.26 — invalidate the leaderboard cache after unassign so the
  // M2 fix (score aggregation joins competition_tasks) takes effect on
  // the next reader within the 5-s cache window. Same writer-lock
  // invariant as POST/PUT companions and the visibility-flip fix in
  // v6.16.7. Pre-fix the JOIN change would have been correct but the
  // cached pre-DELETE entries kept serving stale phantom scores until
  // the TTL elapsed naturally.
  if (changes > 0) {
    invalidateLeaderboardCache(req.params.cid);
    _invalidateMeCacheForComps([req.params.cid]);
    _invalidateTaskNumbersCache(req.params.cid);
    _queueCompleters(eid, [req.params.cid]);
  }
  res.json({ ok: true });
});

// ── Admin task CRUD ─────────────────────────────────────────────────────────

app.get("/api/admin/tasks", requireAdmin, (req, res) => {
  const competitionId = req.query.competitionId;
  // v8.7.0 — `?competitionId=` NAMES an event, so an out-of-scope one is REFUSED
  // rather than answered with an empty list. On an admin surface "this event has
  // no challenges" and "this is not your event" render identically, and the empty
  // answer is itself a probe: it would let an event admin enumerate which
  // challenges somebody else's event does NOT hold, one id at a time.
  if (competitionId) {
    const denied = competitionDenied(req, competitionId);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    // v8.13.3 (UNK-1) — and a NAMED event that does not exist is a 404, not an
    // empty list: "this event holds no challenges" is a claim about an event, and
    // there is no event to make it about. Asked AFTER the scope refusal, so an
    // event admin hears the same 403 for an unknown id as for somebody else's
    // event and the answer is not an existence oracle (the participants list and
    // picker, routes/participants.js, take the same order).
    if (!getCompetition(competitionId)) return res.status(404).json({ error: "Event not found" });
  }
  // v8.7.0 — the three-way visibility rule, spliced into the SQL so that every
  // batch load below (competitions, versions, feedback, tags, attachment counts)
  // is computed over exactly the rows this actor may see. `clause` is empty for
  // an unscoped actor, leaving both queries semantically identical to what they
  // were. It is applied to the competition-scoped branch too — redundant there,
  // since the refusal above proves that event is in scope — so the two branches
  // cannot drift apart if either is edited later.
  const _vis = _taskVisibilitySql(req, "t");
  let tasks;
  if (competitionId) {
    tasks = db.prepare(
      `SELECT t.* FROM tasks t
       JOIN competition_tasks ct ON ct.task_id=t.id
       WHERE ct.competition_id=?${_vis.clause}
       ORDER BY t.difficulty, t.title`
    ).all(competitionId, ..._vis.params);
  } else {
    tasks = db.prepare(`SELECT t.* FROM tasks t WHERE 1=1${_vis.clause} ORDER BY t.difficulty, t.title`).all(..._vis.params);
  }
  // Batch: competitions, versions, feedback for all tasks at once
  const taskIds = tasks.map(t => t.id);
  const ph = "SELECT value FROM json_each(?)";

  // Batch competition assignments (including task_number for live/ended competitions)
  const compMap = new Map();
  if (taskIds.length) {
    const compRows = db.prepare(
      // v8.8.0 — `event_kind`, `late_entry_enabled` and `late_entry_deadline_at`
      // join the projection so the row can carry `late_entry_window_open`. They
      // are NOT optional: `lateEntryWindowOpen` asks `eventPolicy`, which THROWS
      // on a row with no `event_kind` key rather than guessing a kind — the same
      // strictness `eventPolicyForWire` has, and for the same reason.
      `SELECT ct.task_id, ct.task_number, c.id, c.name, c.start_time, c.duration_minutes, c.ended_at, c.ended_manually,
              c.event_kind, c.late_entry_enabled, c.late_entry_deadline_at, c.staff_compete, NULL AS copy_id FROM competitions c
       JOIN competition_tasks ct ON ct.competition_id=c.id WHERE ct.task_id IN (${ph})
       UNION ALL
       SELECT et.copied_from_task_id, ct.task_number, c.id, c.name, c.start_time, c.duration_minutes, c.ended_at, c.ended_manually,
              c.event_kind, c.late_entry_enabled, c.late_entry_deadline_at, c.staff_compete, ct.task_id FROM competitions c
       JOIN competition_tasks ct ON ct.competition_id=c.id
       JOIN tasks et ON et.id=ct.task_id AND et.owner_competition_id=c.id
       WHERE et.copied_from_task_id IN (${ph})`
    ).all(JSON.stringify(taskIds), JSON.stringify(taskIds));
    // A BANK question is listed in every event holding a copy of it (lib/event-copies.js),
    // its entry naming that event's question as `copy_id`: the Assign dialog shows,
    // and the desired-state PUT diffs, the events the question is used in.
    // audit v7.7.36 (P1) — batch-load every referenced competition's timeslots
    // ONCE (WHERE competition_id IN (...)) instead of competitionStatus(r) falling
    // through to a per-row getCompetitionTimeslots query. Pre-fix, a task reused
    // across N comps re-queried each comp's slots once per assignment row (N+1) —
    // the same fix already applied to the participants list + picker. Comps with
    // no slot rows map to [] → competitionStatus uses single-slot logic.
    const _slotCompIds = [...new Set(compRows.map(r => r.id))];
    const _slotsByComp = new Map();
    if (_slotCompIds.length) {
      const sph = "SELECT value FROM json_each(?)";
      for (const s of db.prepare(`SELECT * FROM competition_timeslots WHERE competition_id IN (${sph}) ORDER BY start_time`).all(JSON.stringify(_slotCompIds))) {
        if (!_slotsByComp.has(s.competition_id)) _slotsByComp.set(s.competition_id, []);
        _slotsByComp.get(s.competition_id).push(s);
      }
    }
    // v8.8.0 — ONE clock for the whole page, so two rows of one response cannot
    // land on opposite sides of a late-entry deadline.
    const _leNow = Date.now();
    for (const r of compRows) {
      if (!compMap.has(r.task_id)) compMap.set(r.task_id, []);
      const _slots = _slotsByComp.get(r.id) || [];
      compMap.get(r.task_id).push({
        id: r.id, name: r.name, status: competitionStatus(r, _slots), task_number: r.task_number || null,
        // The event has ENDED and its late window is still open. Kept as a
        // SEPARATE flag rather than a fourth `status` value: `competitionStatus`
        // feeds the scoring freeze, the kind-change lock and the certificate
        // gate, and the window extends PLAY rather than the event (lib/late-entry.js).
        late_entry_window_open: lateEntryWindowOpen(r, competitionEffectiveEnd(r, _slots), _leNow),
        // v8.12.0 — the per-event switch, so the editor can withhold the AUTHOR's
        // Unseal control while the challenge sits in a compete event (the server
        // refuses that save with `answer_seal_in_compete_event`; offering the
        // tick where the save is certain to be refused is the v7.14.2 class).
        // Boolean, like `can_unassign` beside it on the same entry.
        staff_compete: !!r.staff_compete,
        ...(r.copy_id ? { copy_id: r.copy_id } : {}),
      });
    }
  }
  // Batch latest versions (use window function to pick latest per task)
  const verMap = new Map();
  if (taskIds.length) {
    const verRows = db.prepare(
      `SELECT task_id, changed_at, changed_by FROM task_versions WHERE task_id IN (${ph})
       AND change_type <> 'sealed_reveal'
       AND version_num = (SELECT MAX(v2.version_num) FROM task_versions v2 WHERE v2.task_id=task_versions.task_id AND v2.change_type <> 'sealed_reveal')`
    ).all(JSON.stringify(taskIds));
    for (const r of verRows) verMap.set(r.task_id, r);
  }
  // Batch feedback
  const fbMap = new Map();
  if (taskIds.length) {
    const fbRows = db.prepare(
      `SELECT task_id, AVG(rating) as avg_rating, COUNT(*) as feedback_count FROM task_feedback WHERE task_id IN (${ph}) GROUP BY task_id`
    ).all(JSON.stringify(taskIds));
    for (const r of fbRows) fbMap.set(r.task_id, r);
  }
  // Batch tags
  const tagMap = new Map();
  if (taskIds.length) {
    const tagRows = db.prepare(`SELECT task_id, tag FROM task_tags WHERE task_id IN (${ph})`).all(JSON.stringify(taskIds));
    for (const r of tagRows) {
      if (!tagMap.has(r.task_id)) tagMap.set(r.task_id, []);
      tagMap.get(r.task_id).push(r.tag);
    }
  }
  const _topicNames = require("../lib/topics").topicNamesFor(db, taskIds);
  // v6.13.10 — attachment count per task. The admin Challenges pane's
  // new Attachments column sorts + displays a badge per row, and the
  // count is a common decision cue ("does this challenge ship with
  // supporting files?") that we'd rather surface in the list than
  // force an admin to open each challenge to discover. Only active
  // attachments counted (detached_at IS NULL); detached revisions live
  // in the same table as a history trail and don't reflect the
  // challenge's current surface to participants.
  const attachMap = new Map();
  if (taskIds.length) {
    const atRows = db.prepare(
      `SELECT task_id, COUNT(*) as c FROM task_attachments WHERE task_id IN (${ph}) AND detached_at IS NULL GROUP BY task_id`
    ).all(JSON.stringify(taskIds));
    for (const r of atRows) attachMap.set(r.task_id, r.c);
  }
  // v8.7.0 — THE ANSWER, NOT THE RULE.
  //
  // The client must never re-derive "may I edit this?" — it cannot see
  // `created_by_id` (which is not on the wire, and should not be: it is an
  // internal user id), and a second copy of a three-part rule is one edit away
  // from offering a control the server refuses. So the row carries the answer,
  // computed from the SAME predicate the write routes enforce.
  //
  // v8.8.8 — THE SCOPE PRIMITIVE, KEPT rather than discarded. `_eaScoped` was
  // `scopedCompetitionIds(req) !== null`, which threw away the ids it had just
  // resolved; the projection below needs them per row, and calling
  // `competitionDenied` once per assignment would be N predicate invocations on
  // the list path for no extra safety — this IS the array that predicate reads.
  //
  // `_eaScope` is null for admin / superadmin, and every flag is then `true` —
  // byte-identical behaviour to before, and no per-row predicate work on the hot
  // path for the tier that has no scope.
  //
  // Named WITHOUT a leading underscore deliberately: `_compWire` and
  // `stripInternal` delete `_`-prefixed keys structurally, so an underscore here
  // would silently drop the flag and the client would hide every control.
  const _eaScope = scopedCompetitionIds(req);
  const _eaScoped = _eaScope !== null;
  // v8.10.0 — the sealed answer, and THIS IS THE WIDEST REDACTION SITE ON THE
  // PLATFORM.
  //
  // There is no `GET /api/admin/tasks/:id`. This list is the ONLY admin read of a
  // task row, and the admin SPA renders the challenge list, the edit form, the
  // choices editor, the extra-answers editor, the "View as Participant" preview
  // and the History dialog's diff entirely from what lands here. So the key had
  // to stop being SENT rather than stop being drawn: `S` is mirrored onto
  // `window` (core/main.js), so any renderer-level blanking is readable from the
  // console, from DevTools' Network tab, and from `window.adminTasksData`.
  //
  // It is a PER-ROW decision, never a blanket drop of the column: the author has
  // to keep editing their own challenge, and this payload is the only place the
  // edit form can get the value from.
  //
  // `can_see_answer` rides the row beside `can_edit` / `can_edit_scoring` and for
  // the same v8.7.0 reason — THE ANSWER, NOT THE RULE. The client cannot re-derive
  // it: `created_by_id` is an internal user id, and a second copy of the rule is
  // one edit away from rendering a blank field as an empty answer and saving it.
  const _sealActor = actingAdminId(req);
  // v8.12.2 — THE SUPERADMIN'S REVEALS, resolved ONCE for the page: the set of
  // challenges this session's superadmin has revealed (`{}` for anybody who is
  // not a superadmin right now — the live role read inside `sealRevealSet`),
  // plus whether the acting human MAY reveal at all, which decides the
  // `can_reveal_answer` offer below. Both are per-request facts, not per-row.
  const _reveals = sealRevealSet(req);
  const _actingSuper = actingIsSuperAdmin(req);
  // v8.12.1 — the SEAT and the HAND (`competitorIds`): under an impersonated
  // admin view the events the acting admin competes in withhold the hint and
  // collapse the row's edit flags exactly as the organiser's own would — a
  // hint read through somebody else's panel is still read for free.
  const _competeActor = competitorIds(req);
  // v8.12.0 — THE EVENTS THIS ACTOR COMPETES IN, resolved ONCE for the page. A
  // challenge held by one of them is read-only for this actor whatever their
  // tier (every write door refuses it — `competitorTaskEditDenied`), so the row
  // says so in `competing_in` and collapses its edit flags, the v8.7.0
  // answer-not-the-rule shape. The HINT is withheld too: it is deliberately not
  // a sealed field (a participant pays 30% of the points to read it), so the
  // seal's redaction never touches it, and a competing admin reading it off
  // this pane would be reading it for free.
  const _competingSet = new Set(
    _competeActor.length
      ? db.prepare(`SELECT cu.competition_id FROM competition_users cu JOIN competitions c ON c.id = cu.competition_id WHERE cu.user_id IN (SELECT value FROM json_each(?)) AND c.staff_compete = 1`).all(JSON.stringify(_competeActor)).map(r => r.competition_id)
      : []
  );
  // Event team reports — the answers the dialogs and the editor render from
  // (lib/qualifying.js), never re-derive: `qualifying_keys` (the server's own
  // parse of the challenge's `qualifying:<key>` tags; an event asks each key
  // once, ruling N7) and `options_fixed` (an answered qualifying pick-one
  // question, whose options keep their places, ruling 84). Each only when it
  // applies, so every other row is unchanged.
  const _optsFixed = qualifyingOptionsFixedSet(db, tasks, id => tagMap.get(id));
  const result = tasks.map(t0 => {
    const _revealed = _reveals[t0.id] === true;
    const t = redactSealedAnswer(t0, _sealActor, _revealed);
    const latest = verMap.get(t.id);
    const fb = fbMap.get(t.id);
    const comps = compMap.get(t.id) || [];
    // v8.8.8 — NARROWED. v8.7.0 scoped every list an event admin opens and left
    // this projection alone, so a shared challenge still named the id, name,
    // STATUS and internal task_number of every event holding it — including
    // events run by somebody else. ROLES_AND_PERMISSIONS §6 states the opposite
    // rule for the sibling `competitions` column on the participant row, which
    // has been narrowed since v8.7.0: one line apart, two answers.
    //
    // Each leaked entry also rendered as a `comp-focus` badge with role=button,
    // so clicking one dead-ended in a 403 — the affordance-that-lies defect
    // (v7.14.2) on top of the disclosure.
    const visible = _eaScoped ? comps.filter(c => _eaScope.includes(c.id)) : comps;
    // WITHHELD IS COUNTED, NOT SILENT, and that is not decoration: an event
    // admin may legally make cosmetic edits to a challenge another organiser is
    // running (v8.8.5 froze the SCORING fields and deliberately left the rest),
    // and the client's "this challenge is in live event(s)" confirmation is
    // built from this array. Narrowing it to nothing would delete that warning
    // exactly when it matters most — a change landing on participants who are
    // answering right now.
    //
    // So the shape v8.8.6 chose for the same tension one feature over: the
    // server says WHICH SITUATION this is, because the client cannot tell an
    // unused challenge from a narrowed one by looking at an empty array. A count
    // and a liveness flag are a far smaller disclosure than a name, and unlike
    // the name they are operationally necessary.
    const withheldComps = _eaScoped ? comps.filter(c => !_eaScope.includes(c.id)) : [];
    // A sealed challenge is editable by its author and by NOBODY else, whatever
    // the tier — so the seal decides `can_edit` outright rather than narrowing
    // the event-admin answer. Both flags collapse together: every write path the
    // strict flag governs also rewrites or re-grades against the key.
    const _sealBlocks = !sealedAnswerReadable(t0, _sealActor, _revealed);
    // v8.12.0 — a competitor is locked out of the whole row: every flag false,
    // the key and the hint withheld. The key SHOULD already be sealed and not
    // theirs to read (the invariant), but the invariant is enforced at doors and
    // a projection must not rest on it — belt and braces, stated.
    const competingIn = comps.filter(c => _competingSet.has(c.id)).map(c => ({ id: c.id, name: c.name, status: c.status }));
    const _competes = competingIn.length > 0;
    const canEdit = !_competes && !_sealBlocks && (!_eaScoped || !taskEditDenied(req, t));
    // Stricter than can_edit: the scoring fields additionally require that
    // every event holding this challenge is one of mine (see §9.1 of
    // ROLES_AND_PERMISSIONS.md). Only computed when it can differ.
    const canEditScoring = canEdit && (!_eaScoped || !taskScoringEditDenied(req, t));
    const row = {
      ...t,
      // Absent `correct_answer` means WITHHELD, never empty — `answer_type='any'`
      // legitimately stores an empty key, so the client needs this to tell the
      // two apart, and it is what stops a save wiping a value it never read.
      can_see_answer: !_sealBlocks && !_competes,
      // v8.12.2 — the two reveal facts the client renders from and never
      // re-derives. `can_reveal_answer` is the OFFER: sealed, not the author's
      // own, not yet revealed, the acting human a superadmin, and not held by an
      // event they compete in (a reveal there is the seal invariant's back door
      // — the route refuses it, so the row must not offer it). `answer_revealed`
      // is the STATE: this session's superadmin has revealed it, so the key on
      // the row is theirs by that act rather than by authorship, and the copy
      // must not tell them they wrote it.
      ...(answerSealed(t0) && !isTaskAuthor(t0, _sealActor) && _actingSuper && !_competes
        ? (_revealed ? { answer_revealed: true } : { can_reveal_answer: true })
        : {}),
      competing_in: competingIn,
      // Per-competition, because "may I take this out of THAT event" depends on
      // who put it there — the row-level answer the unassign route enforces.
      competitions: visible.map(c => ({
        ...c,
        can_unassign: !_competingSet.has(c.id) && (!_eaScoped || !taskUnassignDenied(req, c.copy_id || t.id, c.id)),
      })),
      // Emitted only when something IS withheld, so every unscoped payload and
      // every unshared challenge is byte-identical to before.
      ...(withheldComps.length ? {
        withheld_competition_count: withheldComps.length,
        withheld_live: withheldComps.some(c => c.status === "live"),
        // v8.12.0 — and whether any withheld event lets staff COMPETE, present
        // only when true: the editor withholds the author's Unseal control
        // while a compete event holds the challenge (`unsealDenied` refuses that
        // save at ANY status), and the narrowed `competitions[]` cannot carry
        // that fact for an event the actor does not organise. Without it an
        // event-admin author whose sealed challenge sits only in somebody
        // else's compete event was OFFERED the tick and met the 409 — the
        // v7.14.2 class. A boolean, never a name: the count above is already
        // the whole disclosure this row makes about those events.
        ...(withheldComps.some(c => c.staff_compete) ? { withheld_compete: true } : {}),
      } : {}),
      tags: tagMap.get(t.id) || [],
      // Stage B — the question's topic (lib/topics.js): `topic_id` rides the
      // row as stored; its name is joined here so every list can show it.
      topic_name: _topicNames.get(t.id) || null,
      ...(qualifyingKeysFromTags(tagMap.get(t.id)).length ? { qualifying_keys: qualifyingKeysFromTags(tagMap.get(t.id)) } : {}),
      // Only where this caller may change the options at all (`can_edit_scoring`):
      // whether anybody has answered is not told to a caller the PUT's scope gate
      // refuses first (the PUT asks the gate, then ruling 84), and the editor
      // locks the options box for them anyway.
      ...(_optsFixed.has(t.id) && canEditScoring ? { options_fixed: true } : {}),
      can_edit: canEdit,
      can_edit_scoring: canEditScoring,
      last_changed: latest?.changed_at || null,
      changed_by: latest?.changed_by || null,
      avg_rating: fb?.avg_rating || null,
      feedback_count: fb?.feedback_count || 0,
      attachment_count: attachMap.get(t.id) || 0,
    };
    if (_competes) {
      for (const f of SEALED_FIELDS) delete row[f];
      delete row.hint;
      // TRUE only when there was a hint to withhold: a challenge with none has
      // nothing withheld, and the editor would otherwise announce a withheld hint
      // over a box that was always empty.
      row.hint_withheld = !!t0.hint;
    } else if (_sealBlocks) {
      // v8.12.2 — the SEAL withholds the hint too (it is in SEALED_FIELDS, so
      // `redactSealedAnswer` above already deleted it); the marker is the same
      // one the competitor branch emits, with the same "only when there was a
      // hint" rule, because the editor, the preview and the importer all key
      // the withheld-hint state on it and a second marker would be a second
      // thing for them to disagree about. The client tells the two reasons
      // apart by `competing_in` (non-empty) versus `can_see_answer === false`.
      row.hint_withheld = !!t0.hint;
    }
    return row;
  });
  res.json(result);
});


// v7.19.0 — multiple-choice. Returns { error } or { choices, correct_answer }
// (both already JSON strings, ready to bind). For every other answer type it
// returns nulls, so the caller binds `choices = NULL` and nothing changes.
function _resolveChoiceFields(body, answerType) {
  // Event team reports — an `any` challenge may carry options: a pick-one
  // question (every option accepted). No options = a free response, as before.
  if (answerType === "any") {
    const sv = require("../lib/choices").validateSurveyChoices(body.choices);
    if (sv.error) return { error: sv.error };
    return { choicesJson: sv.choices ? JSON.stringify(sv.choices) : null, correctAnswer: undefined };
  }
  if (answerType !== "choice") return { choicesJson: null, correctAnswer: undefined };
  const v = validateChoices(body.choices);
  if (v.error) return { error: v.error };
  return { choicesJson: JSON.stringify(v.choices), correctAnswer: v.correctAnswer };
}

app.post("/api/admin/tasks", requireAdmin, csrfProtection, (req, res) => {
  const { title, description, difficulty, answer_type, explanation, hint, attachment_url, status, author_name, author_linkedin, staging_attachments } = req.body;
  let { correct_answer } = req.body;
  // v7.19.0 — a multiple-choice task derives correct_answer from the ticked
  // choices, so the client does not send one; every other type still must.
  const _isChoice = answer_type === "choice";
  // v8.9.0 — `any` carries no correct answer at all (answerTypeHasKey), so the
  // requirement is skipped for it exactly as it is for `choice`, which derives one.
  if (!title || !difficulty || (!_isChoice && answerTypeHasKey(answer_type) && !correct_answer)) return res.status(400).json({ error: "Missing fields" });
  // batch 5 — title must be NON-EMPTY TEXT (reject a non-string → bind/format 500; reject whitespace-only → a blank stored title).
  if (typeof title !== "string" || !title.trim()) return res.status(400).json({ error: "Title must be non-empty text" });
  // audit v7.7.38 (H4) — type-guard every remaining text field bound into SQL /
  // processRichText / validateUrl. Pre-fix only `title` was guarded, so a truthy
  // non-string correct_answer ({}/array) passed the truthiness + caps checks (the
  // caps loop skips non-strings) and 500'd at the INSERT bind; description/
  // explanation/hint reach processRichText and author_* bind raw.
  // v8.13.3 — `attachment_url` joins the list. It was the one text field left out,
  // and `validateUrl` RETURNS ITS INPUT whenever `new URL(String(input))` parses —
  // so a two-element array of URLs (whose String() is a parseable URL) reached the
  // INSERT bind and answered 500 "Failed to create challenge.", a one-element
  // array was stored flattened, and `{}` was silently stored as "".
  for (const f of ["correct_answer", "description", "explanation", "hint", "author_name", "author_linkedin", "attachment_url"]) {
    if (req.body[f] != null && typeof req.body[f] !== "string") return res.status(400).json({ error: `${f} must be text` });
  }
  // v6.20.x — enum-validate scoring/answer fields (see VALID_* above).
  if (!VALID_DIFFICULTIES.has(difficulty)) return res.status(400).json({ error: "difficulty must be one of: easy, medium, hard." });
  if (answer_type != null && !VALID_ANSWER_TYPES.has(answer_type)) return res.status(400).json({ error: "answer_type must be one of: text, json, file, choice, any." });
  for (const [f, max] of Object.entries(TASK_FIELD_CAPS)) {
    const v = req.body[f];
    if (v != null && typeof v === "string" && v.length > max)
      return res.status(400).json({ error: `${f} must be at most ${max} characters.` });
  }
  const _cf = _resolveChoiceFields(req.body, answer_type);
  if (_cf.error) return res.status(400).json({ error: _cf.error });
  if (_cf.correctAnswer !== undefined) correct_answer = _cf.correctAnswer;
  // v8.9.0 — the EFFECTIVE type, resolved the way the INSERT below defaults it.
  // This sits AFTER the string type-guard and the enum guard above (a
  // non-string would otherwise be String()ed past the guard) and BEFORE the
  // attachment-staging block below (a 400 raised after the binaries have moved
  // out of staging orphans them — the F3 ordering rule).
  const _effTypeC = answer_type || "text";
  if (_effTypeC === "text") {
    // Multiple accepted answers ride newline-separated in correct_answer; the
    // stored form is canonical (trimmed lines, blanks and duplicates dropped),
    // and a list with no usable line is the "Missing fields" case the truthiness
    // check above cannot see ("\n \n" is truthy).
    correct_answer = canonicaliseTextAnswers(correct_answer);
    if (!correct_answer) return res.status(400).json({ error: "Missing fields" });
  } else if (_effTypeC === "any") {
    // No key, and NEVER a hint: refused rather than silently dropped, because a
    // field the platform accepts and ignores is a control that appears to work.
    correct_answer = "";
    if (richTextHasContent(hint)) return res.status(400).json({ error: ANY_HINT_REFUSAL });
  }
  const _capC = _resolveAttemptCap(req.body.attempt_cap);
  if (_capC.error) return res.status(400).json({ error: _capC.error });
  const _attemptCap = _capC.value === undefined ? null : _capC.value;
  const _topicC = (req.body.topic_id == null || typeof req.body.topic_id === "string") ? _resolveTopicField(req.body.topic_id) : { error: "topic_id must be a topic id, or null for no topic." };
  if (_topicC.error) return res.status(400).json({ error: _topicC.error, ...(_topicC.code ? { code: _topicC.code } : {}) });
  // v8.10.0 — SEAL THE ANSWER. Create is the only moment it can be chosen; the
  // PUT refuses 0 -> 1 for everyone (lib/answer-seal.js, sealChangeDenied).
  //
  // The boolean is validated with the v8.3.20 idiom rather than coerced with
  // `? 1 : 0`: `active` was bound RAW into an INTEGER column with no CHECK and
  // produced a split-brain where SQL read TEXT 'yes' as INACTIVE while JS read it
  // as ACTIVE. A seal read the wrong way is a silent disclosure, so the same
  // refusal applies — a value that is not a boolean or 0/1 is a 400, never a
  // guess.
  const _sealRaw = req.body.answer_sealed;
  if (_sealRaw != null && typeof _sealRaw !== "boolean" && _sealRaw !== 0 && _sealRaw !== 1) {
    return res.status(400).json({ error: "answer_sealed must be true or false." });
  }
  const _wantSealed = _sealRaw == null ? 0 : (_sealRaw ? 1 : 0);
  // A seal names an author, so it needs one. The built-in superadmin has no
  // `users` row and therefore no `created_by_id` — sealing there would produce a
  // challenge no human could ever read or edit. Refused with the remedy, ahead of
  // the staging block so a 400 cannot orphan promoted binaries.
  if (_wantSealed) {
    // v8.10.1 — a seal protects a KEY, and `any` has none. Refused BEFORE the
    // authorless check only because both are cheap; either order is correct,
    // since neither writes.
    const _st = sealTypeDenied(_effTypeC, answerTypeHasKey(_effTypeC));
    if (_st) return res.status(400).json({ error: _st.message, code: _st.code });
    // v8.12.1 — and never through somebody else's seat (see lib/answer-seal.js).
    const _sd = sealAtCreateDenied(actorId(req), isImpersonating(req));
    if (_sd) return res.status(400).json({ error: _sd.message, code: _sd.code });
  }
  const taskStatus = (status === "published") ? "published" : "draft";
  const id = uuid();
  const storedImageIds = [];
  const adminId = getAdminIdentity(req);
  // CREATED INSIDE AN EVENT (lib/event-copies.js): `competitionId` makes the
  // question the event's own from birth, never a bank question, and a published
  // one is assigned to it at once. Every rule the assign doors ask about the
  // pair is asked here, in their order, before anything is written.
  const ownerCompId = req.body.competitionId;
  let ownerComp = null;
  if (ownerCompId != null) {
    if (typeof ownerCompId !== "string" || !ownerCompId) return res.status(400).json({ error: "competitionId must be an event id." });
    const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), ownerCompId));
    if (_cmp) return _cmp;
    const denied = competitionDenied(req, ownerCompId);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    ownerComp = db.prepare("SELECT id, name, event_kind, start_time, duration_minutes, ended_at, staff_compete FROM competitions WHERE id=?").get(ownerCompId);
    if (!ownerComp) return res.status(404).json({ error: "Event not found" });
    if (competitionStatus(ownerComp) === "ended" || competitionAnySlotEnded(ownerComp)) {
      return res.status(400).json({ error: `Cannot modify question assignments for event "${ownerComp.name}" — a session has already ended.` });
    }
    const _probe = { id, title, answer_type: _effTypeC, answer_sealed: _wantSealed, created_by_id: actorId(req) };
    const _fit = _fitError(_probe, ownerComp);
    if (_fit) return res.status(400).json({ error: _fit.message });
    const _seal = unsealedAssignmentDenied(_probe, ownerComp) || authorCompetesDenied(db, _probe, ownerComp);
    if (_seal) return res.status(400).json({ error: _seal.message, code: _seal.code });
  }

  // Validate staging_attachments shape + ownership BEFORE any DB work so the
  // whole create either succeeds or rolls back cleanly. The client can send an
  // array of at most ATTACHMENT_MAX_PER_TASK entries, each referencing a
  // staging row owned by this admin. Duplicate display names (case-insensitive)
  // are rejected up-front. The move-and-insert happens atomically inside the
  // create transaction below.
  let stagingSpecs = [];
  if (Array.isArray(staging_attachments) && staging_attachments.length) {
    if (staging_attachments.length > ATTACHMENT_MAX_PER_TASK) {
      return res.status(409).json({ error: `Maximum ${ATTACHMENT_MAX_PER_TASK} attachments per question.` });
    }
    const seenNames = new Set();
    for (const sa of staging_attachments) {
      if (!sa || typeof sa.staging_id !== "string" || (sa.display_name != null && typeof sa.display_name !== "string")) return res.status(400).json({ error: "Invalid staging_attachments entry." });
      const row = db.prepare(
        "SELECT id, display_name, original_name, size_bytes, sha256, storage_path FROM task_attachments_staging WHERE id=? AND admin_id=?"
      ).get(sa.staging_id, adminId);
      if (!row) return res.status(400).json({ error: "Staged attachment not found or not owned by this admin." });
      const displayName = String(sa.display_name || row.display_name || "").trim().replace(/\.zip$/i, "").slice(0, 200) || "attachment";
      const key = displayName.toLowerCase();
      if (seenNames.has(key)) return res.status(409).json({ error: "Duplicate display name in staged attachments." });
      seenNames.add(key);
      stagingSpecs.push({ stagingRow: row, display_name: displayName, order_idx: Number.isInteger(sa.order_idx) ? sa.order_idx : stagingSpecs.length });
    }
  }

  // Pre-allocate final ids + storage paths so we can move the binaries out
  // of staging BEFORE the DB transaction touches any rows. This reversed
  // order is the only way to keep DB + filesystem consistent when a late
  // I/O error (ENOSPC, EACCES, cross-volume copy failure) would otherwise
  // leave task_attachments rows pointing at files that never got written.
  const nowIso = new Date().toISOString();
  for (const spec of stagingSpecs) {
    spec.finalId  = uuid();
    spec.finalRel = path.posix.join("attachments", `${spec.finalId}.zip`);
  }

  const movesApplied = []; // [{src, dst}] — kept for compensation if the DB txn fails later
  for (const spec of stagingSpecs) {
    const _base = path.resolve(DATA_DIR);
    const srcAbs = path.resolve(path.join(DATA_DIR, String(spec.stagingRow.storage_path || "")));
    if (!srcAbs.startsWith(_base + path.sep)) throw new Error("attachment path escapes DATA_DIR");
    const dstAbs = path.join(DATA_DIR, spec.finalRel);
    try { fs.renameSync(srcAbs, dstAbs); }
    catch (renameErr) {
      let copyOk = false;
      if (renameErr.code === "EXDEV") {
        try { fs.copyFileSync(srcAbs, dstAbs); fs.unlinkSync(srcAbs); copyOk = true; }
        catch (copyErr) {
          try { fs.unlinkSync(dstAbs); } catch (unlinkErr) { swallowed("challenges:create-unlink-partial-copy", unlinkErr); }
          log.error({ ...reqContext(req), tag: "attachments", err: copyErr && copyErr.message }, "[attachments] cross-volume move failed");
        }
      }
      if (!copyOk) {
        // Undo every prior move so the staging files are back where they
        // started and the caller can retry. Staging rows were untouched so
        // far — no DB compensation needed here.
        for (const mv of movesApplied) {
          try { fs.renameSync(mv.dst, mv.src); } catch (undoErr) { swallowed("challenges:create-undo-move", undoErr); }
        }
        log.error({ ...reqContext(req), tag: "attachments", err: renameErr && renameErr.message }, "[attachments] promotion rename failed");
        return res.status(500).json({ error: "Failed to store attachment file." });
      }
    }
    movesApplied.push({ src: srcAbs, dst: dstAbs });
  }

  // All binaries are at their final destination. Now do the DB work
  // atomically. If this throws, rename the files back so the next request
  // can retry against an intact staging area.
  const createTxn = db.transaction(() => {
    // v6.16.27 — stamp updated_at at creation so the PUT handler's
    // optimistic-concurrency check can compare against a populated
    // value on the very first edit.
    // v8.7.0 — `created_by_id` is the OWNERSHIP stamp every task predicate reads,
    // and it is a user id, not `adminId` (an email): an email moves, and an event
    // admin who corrected their own address would otherwise lose edit rights over
    // every challenge they had created, silently. NULL for the built-in
    // superadmin, which owns nothing and needs to own nothing.
    db.prepare("INSERT INTO tasks (id,title,description,difficulty,answer_type,correct_answer,choices,explanation,hint,attachment_url,active,status,author_name,author_linkedin,attempt_cap,updated_at,created_by_id,answer_sealed,topic_id) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)")
      .run(id, title, processRichText(description||"", storedImageIds), difficulty, answer_type||"text", correct_answer, _cf.choicesJson, processRichText(explanation||"", storedImageIds), _effTypeC === "any" ? null : processRichText(hint||"", storedImageIds), validateUrl(attachment_url), taskStatus, author_name||null, validateUrl(author_linkedin)||null, _attemptCap, now().toISOString(), actorId(req), _wantSealed, _topicC.value === undefined ? null : _topicC.value);
    if (ownerComp) {
      db.prepare("UPDATE tasks SET owner_competition_id=? WHERE id=?").run(ownerComp.id, id);
      if (taskStatus === "published") {
        db.prepare("INSERT OR IGNORE INTO competition_tasks (competition_id, task_id, assigned_by, assigned_at, assigned_by_id) VALUES (?,?,?,?,?)")
          .run(ownerComp.id, id, adminId, nowIso, actorId(req));
        recordCompetitionEvent(ownerComp.id, "task_added", adminId, { task_id: id, task_title: title, via: "created_in_event", ...reqContext(req) });
        _invalidateTaskNumbersCache(ownerComp.id);
        ensureTaskNumbers(ownerComp.id, ownerComp);
      }
    }
    for (const spec of stagingSpecs) {
      db.prepare(
        "INSERT INTO task_attachments (id, task_id, display_name, original_name, size_bytes, sha256, storage_path, created_at, created_by, order_idx) VALUES (?,?,?,?,?,?,?,?,?,?)"
      ).run(spec.finalId, id, spec.display_name, spec.stagingRow.original_name, spec.stagingRow.size_bytes, spec.stagingRow.sha256, spec.finalRel, nowIso, adminId, spec.order_idx);
      db.prepare("DELETE FROM task_attachments_staging WHERE id=?").run(spec.stagingRow.id);
    }
  });

  try { runTxnWithMirrorBuffer(() => createTxn()); } catch (e) {
    for (const mv of movesApplied) {
      try { fs.renameSync(mv.dst, mv.src); } catch (undoErr) { swallowed("challenges:create-txn-undo-move", undoErr); }
    }
    log.error({ ...reqContext(req), tag: "attachments", err: e && e.message }, "[attachments] task create txn failed");
    return res.status(500).json({ error: "Failed to create question." });
  }

  if (ownerComp && taskStatus === "published") {
    invalidateLeaderboardCache(ownerComp.id);
    _invalidateMeCacheForComps([ownerComp.id]);
  }
  createTaskVersion(id, adminId, "create", storedImageIds, { ...reqContext(req), ...(ownerComp ? { competition_id: ownerComp.id } : {}) });
  res.json({ ok: true, id, status: taskStatus, ...(ownerComp ? { owner_competition_id: ownerComp.id } : {}) });
});

// SAVE TO BANK (stage B) — an event's own question copied back into the
// Question bank as a NEW bank question (lib/event-copies.js copyTaskToBank):
// never a link and never an overwrite of the bank question it came from. Gates,
// in order: 404; not an event's question (400 `save_to_bank_not_event`); the
// competitor lock (a competitor may not take a copy of a question their event
// holds); scope (`taskViewDenied`: a question of an event the caller organises);
// the seal (a key the caller may not read is not theirs to copy); a quick
// question (400 `save_to_bank_qualifying`: an event's own, by rule). The new
// question belongs to whoever saved it (`created_by_id`), or to the source's
// author when the answer is sealed, so the seal still names that person.
// Recorded as the new question's `created` version, `via: save_to_bank`, naming
// the source and its event.
app.post("/api/admin/tasks/:id/save-to-bank", requireAdmin, csrfProtection, (req, res) => {
  const src = db.prepare("SELECT * FROM tasks WHERE id=?").get(req.params.id);
  if (!src) return res.status(404).json({ error: "Question not found" });
  if (!src.owner_competition_id) return res.status(400).json({ error: "This question is already in the Question bank.", code: "save_to_bank_not_event" });
  { const _cmp = refuseCompetitor(res, competitorTaskEditDenied(db, competitorIds(req), src.id)); if (_cmp) return _cmp; }
  {
    const denied = taskViewDenied(req, src);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  {
    const denied = sealedEditDenied(src, actingAdminId(req), sealRevealedFor(req, src.id));
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  if (tagsMakeQualifying(db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(src.id).map(r => r.tag))) {
    return res.status(400).json({ error: "A quick question belongs to its event and cannot be saved to the Question bank.", code: "save_to_bank_qualifying" });
  }
  const adminId = getAdminIdentity(req);
  const createdById = answerSealed(src) ? (src.created_by_id || null) : actorId(req);
  let id;
  const _stbTxn = db.transaction(() => {
    id = require("../lib/event-copies").copyTaskToBank(db, src.id, { createdById });
  });
  runTxnWithMirrorBuffer(() => _stbTxn());
  createTaskVersion(id, adminId, "create", [], { via: "save_to_bank", saved_from: src.id, competition_id: src.owner_competition_id, ...reqContext(req) });
  res.json({ ok: true, id, title: src.title });
});

app.put("/api/admin/tasks/:id", requireAdmin, csrfProtection, (req, res) => {
  // Capture the full pre-edit row so the audit log can diff every field the
  // caller actually mutated (v6.2.8). Pre-fix, task edits were mirrored with
  // only `{change_type:"update"}` — useful for history navigation but opaque
  // for an operator reviewing the log who wants to know "what exactly did
  // Alice change about this challenge?".
  const existing = db.prepare("SELECT * FROM tasks WHERE id=?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Question not found" });
  // v8.12.0 — a competitor may not change a challenge held by the event they
  // compete in. Above the seal and the tier gate, for the reason the seal sits
  // above the tier gate: it binds every tier, so answering another question
  // first would hand a superadmin a different reason for the same refusal.
  { const _cmp = refuseCompetitor(res, competitorTaskEditDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  if (existing.locked) return res.status(403).json({ error: "Question is locked. Only a superadmin can unlock it." });
  // v8.7.0 — editing is OWNER-ONLY, checked before ANY side effect: this handler
  // goes on to sanitise rich text (which STORES images) and to move attachment
  // binaries out of staging, so a refusal raised later would leave both behind.
  // `existing` is a `SELECT *`, so it carries `created_by_id`.
  {
    const denied = taskEditDenied(req, existing);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  // v8.10.0 — A SEALED ANSWER IS EDITABLE BY ITS AUTHOR AND BY NOBODY ELSE.
  //
  // This is the one task gate that binds EVERY tier — the `taskEditDenied` call
  // above returns null for admin and superadmin by design, so it cannot express
  // this. It sits immediately after it and for the identical reason: above every
  // side effect, because the handler below stores rich-text images and promotes
  // attachment binaries out of staging.
  //
  // It gates the WHOLE PUT, not just the answer fields, which is the plain
  // reading of the rule and also the only defensible one: the value the caller
  // would be editing around is one they were not allowed to read, and this
  // handler posts `correct_answer` unconditionally from the admin form, so a
  // permitted title-only save by a non-author would arrive carrying an absent key
  // and COALESCE past it — or, from a hand-built client, overwrite it blind.
  {
    const denied = sealedEditDenied(existing, actingAdminId(req), sealRevealedFor(req, existing.id));
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  // THE FLAG ITSELF: unseal is the author's to perform (or, since v8.12.2, a
  // superadmin's who has revealed the key), re-sealing is nobody's.
  // Checked separately from the gate above because the author passes that one and
  // still may not re-seal, and because an ECHO of the stored value must not be
  // read as a change (the `event_kind` rule) — a client round-tripping the whole
  // row keeps working.
  {
    const denied = sealChangeDenied(existing, req.body.answer_sealed, actingAdminId(req), sealRevealedFor(req, existing.id));
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  if (req.body.answer_sealed != null && typeof req.body.answer_sealed !== "boolean"
      && req.body.answer_sealed !== 0 && req.body.answer_sealed !== 1) {
    return res.status(400).json({ error: "answer_sealed must be true or false." });
  }
  // COALESCE semantics: absent means unchanged. Only a real 1 -> 0 transition
  // writes, and `sealChangeDenied` has already refused every other direction.
  const _sealVal = (req.body.answer_sealed == null || !!req.body.answer_sealed === answerSealed(existing))
    ? null
    : 0;
  // v8.12.0 — THE UNSEAL DOOR of the staff-compete seal invariant. A sealed
  // challenge sitting in an event where staff compete may not be unsealed while
  // it is assigned there, whatever the event's status (an ended event is
  // revivable, and no revive path re-asks — lib/staff-compete.js says why): the
  // moment it is, its key is on the admin pane of every competing admin. 409 rather than 403 — nothing about the ACTOR is
  // wrong (the author is the one person entitled to unseal), the challenge is
  // simply in a state that refuses it, and the remedy is named.
  if (_sealVal === 0) {
    // Scoped for an event-admin author: named only the events they organise,
    // the rest a count (`withheld_competition_count`) — the v8.8.8 rule.
    const _unseal = unsealDenied(db, existing.id, scopedCompetitionIds(req));
    if (_unseal) return res.status(409).json({ error: _unseal.message, code: _unseal.code, competitions: _unseal.competitions, ...(_unseal.withheld_competition_count ? { withheld_competition_count: _unseal.withheld_competition_count } : {}) });
  }
  // v6.16.27 — optimistic-concurrency / If-Match check (see the
  // sibling check on PUT /api/admin/competitions/:id). When the
  // client supplies `expectedUpdatedAt` and it doesn't match the
  // stored value, two admins are racing the same task — surface 409
  // instead of last-writer-wins overwriting silently. Omitting the
  // field stays back-compat with scripted callers / the legacy
  // admin UI that pre-dated this check.
  if (req.body.expectedUpdatedAt && existing.updated_at && req.body.expectedUpdatedAt !== existing.updated_at) {
    return res.status(409).json({
      error: "This question was modified by another admin since you opened it. Reload to see the latest values, then retry.",
      conflict: true,
      currentUpdatedAt: existing.updated_at,
    });
  }
  const { title, description, difficulty, answer_type, explanation, hint, attachment_url, active, author_name, author_linkedin, staging_attachments } = req.body;
  let { correct_answer } = req.body;
  // batch 5 — when title is provided it must be NON-EMPTY TEXT (edit uses COALESCE,
  // so undefined leaves it unchanged; a non-string/whitespace value must 400).
  if (title != null && (typeof title !== "string" || !title.trim())) return res.status(400).json({ error: "Title must be non-empty text" });
  // audit v7.7.38 (H4) — same type-guard on edit (COALESCE / processRichText / CASE binds).
  // v8.13.3 — `attachment_url` too, and on EDIT its absence was DATA LOSS rather
  // than a 500: `attachment_url != null ? validateUrl(attachment_url) : null`
  // turns `{}`, `[]`, `false` or `0` into "", and COALESCE("", attachment_url)
  // then CLEARED the stored URL with a 200. A cleared URL is still expressible —
  // as the empty STRING, which is what the editor sends.
  for (const f of ["correct_answer", "description", "explanation", "hint", "author_name", "author_linkedin", "attachment_url"]) {
    if (req.body[f] != null && typeof req.body[f] !== "string") return res.status(400).json({ error: `${f} must be text` });
  }
  const storedImageIds = [];
  const adminId = getAdminIdentity(req);
  for (const [f, max] of Object.entries(TASK_FIELD_CAPS)) {
    const v = req.body[f];
    if (v != null && typeof v === "string" && v.length > max)
      return res.status(400).json({ error: `${f} must be at most ${max} characters.` });
  }
  // v6.20.x — enum-validate scoring/answer fields when provided (PUT uses
  // COALESCE so undefined leaves the column unchanged; only reject a bad value).
  if (difficulty != null && !VALID_DIFFICULTIES.has(difficulty)) return res.status(400).json({ error: "difficulty must be one of: easy, medium, hard." });
  if (answer_type != null && !VALID_ANSWER_TYPES.has(answer_type)) return res.status(400).json({ error: "answer_type must be one of: text, json, file, choice, any." });
  // v8.3.20 (external audit) — `active` is bound RAW into `active=COALESCE(?,active)`
  // and appears in neither the H4 typeof loop above nor TASK_FIELD_CAPS, so this
  // ADMIN-tier route accepted whatever it was handed. Measured: `active:"yes"`
  // -> 200 and stored as TEXT; `active:99` -> 200; `active:{}` / `active:true`
  // -> 500. `tasks.active` is INTEGER with no CHECK, and a stored TEXT value is a
  // split-brain: SQL predicates (`WHERE t.active=1`, the all-solved denominator)
  // read it as INACTIVE while JS predicates (`if (!task.active)`) read it as
  // ACTIVE, so a challenge is simultaneously hidden and visible with nothing on
  // any screen saying so. COALESCE means undefined/null still leaves the column
  // alone; only a PRESENT value is policed, and then coerced to the integer the
  // column is declared as. The create path is unaffected — it hard-codes 1.
  if (active != null && typeof active !== "boolean" && active !== 0 && active !== 1) {
    return res.status(400).json({ error: "active must be true/false or 0/1." });
  }
  const _activeVal = active == null ? null : (active ? 1 : 0);
  // v8.1.0 — resolved HERE, before any attachment staging work, for the same
  // reason F3 hoisted the choice resolution: a 400 raised after the binaries have
  // been moved out of staging orphans those files on disk.
  const _capU = _resolveAttemptCap(req.body.attempt_cap);
  if (_capU.error) return res.status(400).json({ error: _capU.error });
  const _topicU = (req.body.topic_id == null || typeof req.body.topic_id === "string") ? _resolveTopicField(req.body.topic_id) : { error: "topic_id must be a topic id, or null for no topic." };
  if (_topicU.error) return res.status(400).json({ error: _topicU.error, ...(_topicU.code ? { code: _topicU.code } : {}) });

  // ext-audit v7.20.9 (F3) — resolve the multiple-choice fields FIRST, because
  // the fairness check below has to test the value that will actually be
  // STORED, not the one the client happened to name.
  //
  // This block used to sit ~90 lines further down, after the attachment
  // staging work, and that ordering broke the fairness invariant in BOTH
  // directions at once:
  //
  //   • BYPASS — a `choices`-only PUT leaves `req.body.correct_answer`
  //     undefined, so the check saw "no scoring edit attempted" and waved it
  //     through; the block below then derived a NEW correct_answer from the
  //     choices and wrote it. The correct answer of a challenge in an ended
  //     session could be changed by simply not naming the field.
  //   • FALSE POSITIVE — the admin form posts `correct_answer` unconditionally,
  //     and for a choice task that input is empty (the answer lives in the
  //     choice ticks). So `"" !== '["ab12cd34"]'` read as a scoring edit and a
  //     plain typo fix on the title returned 409.
  //
  // Both disappear once the effective values are computed before the test.
  // Nothing between here and the old location is needed to resolve them: it
  // depends only on req.body.choices, answer_type and existing.answer_type.
  const _effType = answer_type != null ? answer_type : existing.answer_type;
  // v8.10.1 — SEALED AND KEYLESS MAY NOT COEXIST, checked on the PROSPECTIVE
  // state rather than on what arrived. The reachable move is switching a sealed
  // challenge to "Any answer (free response)": `answer_sealed` is unchanged by
  // this request (the one-way door means it can only ever go 1 -> 0 here), so
  // the forbidden pair is assembled out of the STORED flag and the INCOMING
  // type, and testing either alone misses it.
  //
  // Result-based, so the two escapes are both single saves that pass: unseal it,
  // or leave the type alone. A row that somehow already holds the pair is
  // therefore not bricked — it is refused until one of those two is done, and
  // the message names both.
  {
    const _sealAfter = req.body.answer_sealed == null
      ? answerSealed(existing)
      : !!req.body.answer_sealed;
    if (_sealAfter) {
      const _st = sealTypeDenied(_effType, answerTypeHasKey(_effType));
      if (_st) return res.status(400).json({ error: _st.message, code: _st.code });
    }
  }
  let _choicesJson;              // undefined ⇒ leave the column alone
  if (_effType === "choice") {
    if (req.body.choices !== undefined) {
      const _v = validateChoices(req.body.choices);
      if (_v.error) return res.status(400).json({ error: _v.error });
      _choicesJson = JSON.stringify(_v.choices);
      correct_answer = _v.correctAnswer;
    } else if (answer_type === "choice" && existing.answer_type !== "choice") {
      // Switching an existing task TO multiple-choice without supplying any
      // choices would leave a choice task with nothing to choose from.
      return res.status(400).json({ error: "Switching to multiple choice requires a list of choices." });
    } else {
      // A choice task edited without touching its choices: the stored answer is
      // unchanged, so make sure it cannot read as an edit below.
      correct_answer = existing.correct_answer;
    }
  } else if (_effType === "any" && req.body.choices !== undefined) {
    // Event team reports — the options of a pick-one question (none = a free
    // response). Every option is accepted, so an option edit moves no grade.
    const _sv = require("../lib/choices").validateSurveyChoices(req.body.choices);
    if (_sv.error) return res.status(400).json({ error: _sv.error });
    _choicesJson = _sv.choices ? JSON.stringify(_sv.choices) : null;
  } else if (answer_type != null && (existing.answer_type === "choice" || existing.answer_type === "any") && answer_type !== existing.answer_type) {
    // Switching AWAY from multiple choice (or a pick-one question): drop the
    // stale options rather than leaving them to confuse a later switch back.
    _choicesJson = null;
  }
  // v8.9.0 — TEXT: multiple accepted answers, newline-separated, stored CANONICAL.
  //
  // The comparison below is canonical-vs-canonical, and that is load-bearing.
  // No write site trimmed this column before v8.9.0 — the admin form posts the
  // input untrimmed — so the stored corpus is NOT canonical, and comparing a
  // canonical incoming value against a raw stored one would make a title-only
  // re-save of a padded legacy value read as a scoring edit: 409 on a frozen
  // challenge, 403 for an event admin, and a silent grading-hash move on an
  // unfrozen one. When the two agree the column is left ALONE (undefined is the
  // COALESCE no-op AND the `_scoringEditAttempted` "not supplied" value), so an
  // unchanged answer never rewrites the row or moves the grading hash.
  if (_effType === "text" && correct_answer != null) {
    const _incoming = canonicaliseTextAnswers(correct_answer);
    if (!_incoming) return res.status(400).json({ error: "correct_answer cannot be empty." });
    correct_answer = _incoming === canonicaliseTextAnswers(existing.correct_answer) ? undefined : _incoming;
  }
  // v8.9.0 — ANY: no key, never a hint (see the POST twin for why it is refused
  // rather than dropped). The admin form posts `correct_answer` unconditionally,
  // so on an already-`any` row the value is "not supplied" rather than an edit;
  // on a SWITCH to `any` the key is cleared, which is a scoring edit and is
  // frozen by the same gate as every other type change.
  if (_effType === "any") {
    if (richTextHasContent(hint)) return res.status(400).json({ error: ANY_HINT_REFUSAL });
    correct_answer = existing.answer_type === "any" ? undefined : "";
  }
  // ext-audit v7.20.9 (F3, adjacent) — an EMPTY correct_answer must not be
  // stored. The column is written with `COALESCE(?,correct_answer)`, whose
  // no-change sentinel is NULL, so an empty STRING is a value: it overwrote the
  // answer and left a challenge nobody can solve — and worse, the text
  // comparison strips whitespace on both sides, so an empty stored answer makes
  // an empty SUBMISSION grade as CORRECT. Same shape as the `title` guard above,
  // and the same class as the v7.15.8 "an admin save must never erase a
  // mandatory field" rule. Checked HERE, after the choice resolution, because
  // the admin form legitimately posts an empty `correct_answer` for a choice
  // task (the answer lives in the ticks) and that value has just been replaced.
  if (_effType !== "any" && correct_answer != null && !String(correct_answer).trim()) {
    return res.status(400).json({ error: "correct_answer cannot be empty." });
  }

  // v6.16.4 — multi-slot fairness invariant. Pre-fix the PUT handler
  // freely changed `correct_answer` / `answer_type` / `difficulty` even
  // when the task was assigned to a comp where one slot had already
  // ended and another was still upcoming. Recalculate (`/recalculate`)
  // would then flip is_correct / points_delta against the new answer
  // for the ended slot's submissions — retroactively shifting that
  // slot's leaderboard — AND the still-upcoming slot's participants
  // would face the new question. The "Challenge assignments are frozen
  // once any timeslot has ended" rule (CLAUDE.md timeslots section)
  // covered ASSIGN/REMOVE only; the same fairness logic applies to
  // scoring-affecting EDITS. Title, description, explanation, hint,
  // attachment_url, author_name and author_linkedin are NOT scoring-affecting
  // and remain editable. (`active` USED to be listed here and was wrong — see
  // the v7.21.1 note below.)
  //
  // v7.20.9 — `correct_answer` here is the EFFECTIVE value (see above). Note
  // what is deliberately NOT frozen: editing a choice's TEXT, or adding a wrong
  // option, changes `choices` but not `correct_answer`, and grading is on choice
  // IDs — so no stored score can move and a typo fix stays allowed. Freezing
  // that too would just re-create the over-strict half of this bug.
  // ext-audit v7.21.1 — `active` JOINS the freeze test.
  //
  // The comment above used to list `active` among the fields that are "NOT
  // scoring-affecting and remain editable", while the RESTORE handler in this
  // same file froze it — two contradictory definitions of one rule, and the
  // restore one is correct: `active` is a leaderboard predicate
  // (buildLeaderboardEntries counts totalTasks with `t.active=1`), so hiding a
  // challenge in an ended competition shrinks the all-solved denominator and
  // re-orders its finished ranks. The PUT was therefore only PARTLY frozen.
  const _scoringEditAttempted =
    (correct_answer !== undefined && correct_answer !== existing.correct_answer) ||
    (answer_type    !== undefined && answer_type    !== existing.answer_type) ||
    (difficulty     !== undefined && difficulty     !== existing.difficulty)     ||
    (active         !== undefined && Number(active) !== Number(existing.active));
  // v8.7.0 — THE STRICTER GATE, for the scoring-relevant fields only.
  //
  // Owning a challenge is not enough to re-grade it: a global admin may have
  // assigned it to an event this actor does not run, and moving the correct
  // answer would rescore that event. `taskScoringEditDenied` therefore also
  // requires every HOLDING event to be in scope; cosmetic fields (title, bodies,
  // hint, author, attachments, tags) stay open to the owner.
  //
  // Keyed on the CHANGE, never on the field being PRESENT, and that is the
  // v7.20.9 (F3) trap one gate over: the admin form posts `correct_answer`
  // unconditionally — empty for a choice challenge — so a presence test would
  // refuse a title typo fix on every shared challenge. `_scoringEditAttempted`
  // above is already the file's own effective-value answer to that question, so
  // this reuses it rather than growing a second, subtly different definition; the
  // two extra clauses cover the scoring fields it does not track (`status` is not
  // settable through this route at all).
  //
  // Placed here, before the attachment staging block below, for the same reason
  // the choice resolution was hoisted in F3: a refusal after the binaries have
  // been promoted out of staging orphans those files on disk.
  const _scoringTouched = _scoringEditAttempted
    || (_choicesJson !== undefined && _choicesJson !== (existing.choices ?? null))
    || (_capU.value  !== undefined && (_capU.value ?? null) !== (existing.attempt_cap ?? null));
  if (_scoringTouched) {
    const denied = taskScoringEditDenied(req, existing);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  // Operator ruling 84 (14 Nov 2026) — ONCE ANYONE HAS ANSWERED A QUALIFYING
  // QUESTION, ITS OPTIONS KEEP THEIR PLACES: the reports read each answer by the
  // place of the option picked. A reworded option keeps its id (the editor keeps
  // the id of a line edited in place) and an option added at the end moves
  // nothing; moving, removing or inserting one is refused, as is dropping them
  // all (a switch to a free answer or another type). Any event, live or ended.
  // Below the scope gate (whether anybody has answered is not for a caller the
  // gate refuses) and above every side effect (the staging moves below); this
  // handler does not await, so no answer can land between this read and the UPDATE.
  if (_choicesJson !== undefined && qualifyingOptionsFixed(db, existing)) {
    const _fixed = answeredOptionsChangeDenied(parseChoices(existing.choices), _choicesJson ? JSON.parse(_choicesJson) : []);
    if (_fixed) return res.status(409).json({ error: _fixed.message, code: _fixed.code });
  }
  // A qualifying question stays a pick-one question (lib/qualifying.js
  // `qualifyingNeedsPickOneDenied`): an edit that CHANGES the type or the
  // options of a tagged challenge is asked about the state it would leave. One
  // that leaves both as they are is not (the editor sends the options on every
  // save of a multiple-choice or Any-answer challenge, compared as
  // `_scoringTouched` compares them), so an older tagged challenge of another
  // type can still be edited, or have the tag removed.
  if (((answer_type !== undefined && answer_type !== existing.answer_type) || (_choicesJson !== undefined && _choicesJson !== (existing.choices ?? null)))
      && require("../lib/qualifying").isQualifyingTask(db, existing.id)) {
    const _np = qualifyingNeedsPickOneDenied({ answer_type: _effType, choices: _choicesJson !== undefined ? _choicesJson : existing.choices });
    if (_np) return res.status(400).json({ error: _np.message, code: _np.code });
  }
  // v8.1.0 (PR 30) — CHANGING the answer type is the reordering attack on the
  // assign-side refusal: assign an ordinary text challenge to a Booth Event, then
  // edit it to `file`. Guarding only the assign routes would leave that door open,
  // so both ends move together and "no live Booth Event holds an unanswerable
  // challenge" becomes a theorem rather than a convention (v7.29.0's argument for
  // making event_kind immutable, applied here).
  //
  // Runs BEFORE the ended-session freeze below deliberately: that one is scoped to
  // ENDED events and this one to LIVE ones, so the two can never both fire, and
  // ordering them this way means a live Booth Event's refusal names the event and
  // the real remedy rather than falling through to the frozen-standings copy.
  if (answer_type !== undefined && answer_type !== existing.answer_type) {
    const _unfit = taskConflictingEvent(db, req.params.id,
      { title: title != null ? title : existing.title, answer_type },
      db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(req.params.id).map(r => r.tag));
    if (_unfit) return res.status(409).json({ error: _unfit.message, code: _unfit.code });
  }
  if (_scoringEditAttempted) {
    const _compIds = db.prepare("SELECT competition_id FROM competition_tasks WHERE task_id=?").all(req.params.id).map(r => r.competition_id);
    for (const cid of _compIds) {
      const _comp = getCompetition(cid);
      if (_comp && competitionAnySlotEnded(_comp)) {
        return res.status(409).json({
          error: `Cannot change scoring (correct_answer / answer_type / difficulty) — question is in "${_comp.name}" which has at least one ended session. Edit text-only fields instead. ${FROZEN_REMEDY}`,
        });
      }
    }
  }

  // v6.13.15 — PUT accepts `staging_attachments` now, same shape as POST.
  // Edit-form uploads write to the attachment-staging table (invisible to
  // participants), and Save promotes them into task_attachments atomically
  // with the rest of the update. Pre-v6.13.15 the edit form posted
  // directly to /api/admin/tasks/:id/attachments — participants saw the
  // file before the admin hit Save, and best-effort async DELETEs on
  // Cancel could leak the upload if they failed. The staging approach
  // makes Save the single commit point (matches create-flow behaviour)
  // and Cancel discards cleanly by deleting staging rows on close.
  //
  // Validate + count-check up front so the PUT transaction below either
  // succeeds whole or not at all; binaries get moved out of staging
  // first so a late ENOSPC rollback keeps FS + DB consistent.
  let stagingSpecs = [];
  if (Array.isArray(staging_attachments) && staging_attachments.length) {
    const currentCount = db.prepare(
      "SELECT COUNT(*) AS c FROM task_attachments WHERE task_id=? AND detached_at IS NULL"
    ).get(req.params.id).c;
    if (currentCount + staging_attachments.length > ATTACHMENT_MAX_PER_TASK) {
      return res.status(409).json({ error: `Maximum ${ATTACHMENT_MAX_PER_TASK} attachments per question.` });
    }
    const seenNames = new Set();
    for (const sa of staging_attachments) {
      if (!sa || typeof sa.staging_id !== "string" || (sa.display_name != null && typeof sa.display_name !== "string")) return res.status(400).json({ error: "Invalid staging_attachments entry." });
      const row = db.prepare(
        "SELECT id, display_name, original_name, size_bytes, sha256, storage_path FROM task_attachments_staging WHERE id=? AND admin_id=?"
      ).get(sa.staging_id, adminId);
      if (!row) return res.status(400).json({ error: "Staged attachment not found or not owned by this admin." });
      const displayName = String(sa.display_name || row.display_name || "").trim().replace(/\.zip$/i, "").slice(0, 200) || "attachment";
      const key = displayName.toLowerCase();
      if (seenNames.has(key)) return res.status(409).json({ error: "Duplicate display name in staged attachments." });
      seenNames.add(key);
      // Collision with an EXISTING active attachment on this task.
      const dupeExisting = db.prepare(
        "SELECT 1 FROM task_attachments WHERE task_id=? AND detached_at IS NULL AND LOWER(display_name)=LOWER(?)"
      ).get(req.params.id, displayName);
      if (dupeExisting) return res.status(409).json({ error: "An attachment with that display name already exists." });
      stagingSpecs.push({ stagingRow: row, display_name: displayName, order_idx: Number.isInteger(sa.order_idx) ? sa.order_idx : stagingSpecs.length });
    }
  }

  // Pre-allocate final ids + storage paths, move binaries BEFORE any DB work
  // so a rename/copy failure doesn't leave half-committed state. Matches the
  // create-flow pattern exactly.
  const nowIso = new Date().toISOString();
  for (const spec of stagingSpecs) {
    spec.finalId  = uuid();
    spec.finalRel = path.posix.join("attachments", `${spec.finalId}.zip`);
  }
  const movesApplied = [];
  for (const spec of stagingSpecs) {
    const _base = path.resolve(DATA_DIR);
    const srcAbs = path.resolve(path.join(DATA_DIR, String(spec.stagingRow.storage_path || "")));
    if (!srcAbs.startsWith(_base + path.sep)) throw new Error("attachment path escapes DATA_DIR");
    const dstAbs = path.join(DATA_DIR, spec.finalRel);
    try { fs.renameSync(srcAbs, dstAbs); }
    catch (renameErr) {
      let copyOk = false;
      if (renameErr.code === "EXDEV") {
        try { fs.copyFileSync(srcAbs, dstAbs); fs.unlinkSync(srcAbs); copyOk = true; }
        catch (copyErr) {
          try { fs.unlinkSync(dstAbs); } catch (unlinkErr) { swallowed("challenges:update-unlink-partial-copy", unlinkErr); }
          log.error({ ...reqContext(req), tag: "attachments", err: copyErr && copyErr.message }, "[attachments] cross-volume move failed on update");
        }
      }
      if (!copyOk) {
        for (const mv of movesApplied) { try { fs.renameSync(mv.dst, mv.src); } catch (undoErr) { swallowed("challenges:update-undo-move", undoErr); } }
        log.error({ ...reqContext(req), tag: "attachments", err: renameErr && renameErr.message }, "[attachments] promotion rename failed on update");
        return res.status(500).json({ error: "Failed to store attachment file." });
      }
    }
    movesApplied.push({ src: srcAbs, dst: dstAbs });
  }

  // (v7.19.0's multiple-choice resolution moved ABOVE the fairness check in
  // v7.20.9 — see the ext-audit F3 note there for why the ordering matters.)

  // Single transaction: UPDATE tasks + INSERT each promoted attachment +
  // DELETE staging rows. Reverts the binary moves on txn failure.
  let updated;
  const updateTxn = db.transaction(() => {
    // v6.16.27 — bump updated_at unconditionally so the optimistic-
    // concurrency check above sees the new value on the next reader /
    // writer.
    // audit v7.7.37 (C8) — author_name / author_linkedin are NULLABLE optionals, so
    // COALESCE (whose no-change sentinel IS null) made "clear this field" unreachable:
    // the SPA sends null for an emptied field → COALESCE kept the old value. Use a
    // CASE keyed on a "provided" flag so absent (undefined ⇒ leave) is distinct from
    // explicitly-cleared (present-but-empty ⇒ NULL). The other fields keep COALESCE
    // (they're either required or use a different absent convention).
    const _authorNameProvided = author_name !== undefined ? 1 : 0;
    const _authorNameVal = author_name ? author_name : null;
    const _authorLiProvided = author_linkedin !== undefined ? 1 : 0;
    const _authorLiVal = author_linkedin ? (validateUrl(author_linkedin) || null) : null;
    // v8.1.0 — CASE-keyed like the author fields, so "the caller said nothing"
    // (leave the cap alone) stays distinguishable from "the caller cleared it"
    // (uncap). A COALESCE would make removing a cap impossible.
    const _capProvided = _capU.value !== undefined ? 1 : 0;
    const _capVal = _capU.value === undefined ? null : _capU.value;
    // v8.9.0 — `hint` is CASE-keyed now, like the author fields: COALESCE cannot
    // write NULL, and a switch to `any` must CLEAR the hint the type forbids (the
    // v8.3.0 "a kind change resets what the new kind forbids" rule, one entity
    // over). "The caller said nothing" still leaves the column alone.
    const _hintProvided = (_effType === "any" || hint != null) ? 1 : 0;
    const _hintVal = _effType === "any" ? null : (hint != null ? processRichText(hint, storedImageIds) : null);
    const result = db.prepare(`UPDATE tasks SET title=COALESCE(?,title), description=COALESCE(?,description),
      difficulty=COALESCE(?,difficulty), answer_type=COALESCE(?,answer_type),
      correct_answer=COALESCE(?,correct_answer),
      choices=CASE WHEN ?=1 THEN ? ELSE choices END,
      explanation=COALESCE(?,explanation), hint=CASE WHEN ?=1 THEN ? ELSE hint END,
      attachment_url=COALESCE(?,attachment_url), active=COALESCE(?,active),
      author_name=CASE WHEN ?=1 THEN ? ELSE author_name END, author_linkedin=CASE WHEN ?=1 THEN ? ELSE author_linkedin END,
      attempt_cap=CASE WHEN ?=1 THEN ? ELSE attempt_cap END,
      answer_sealed=COALESCE(?,answer_sealed),
      topic_id=CASE WHEN ?=1 THEN ? ELSE topic_id END,
      updated_at=? WHERE id=?`)
      .run(title, description != null ? processRichText(description, storedImageIds) : null, difficulty, answer_type, correct_answer, _choicesJson !== undefined ? 1 : 0, _choicesJson !== undefined ? _choicesJson : null, explanation != null ? processRichText(explanation, storedImageIds) : null, _hintProvided, _hintVal, attachment_url != null ? validateUrl(attachment_url) : null, _activeVal, _authorNameProvided, _authorNameVal, _authorLiProvided, _authorLiVal, _capProvided, _capVal, _sealVal, _topicU.value !== undefined ? 1 : 0, _topicU.value === undefined ? null : _topicU.value, now().toISOString(), req.params.id);
    if (!result.changes) throw new Error("not_found");
    // Promote each staged attachment (assign order_idx at the tail so
    // pre-existing attachments keep their ordering).
    if (stagingSpecs.length) {
      const maxIdx = db.prepare(
        "SELECT COALESCE(MAX(order_idx), -1) AS m FROM task_attachments WHERE task_id=?"
      ).get(req.params.id).m;
      stagingSpecs.forEach((spec, i) => {
        db.prepare(
          "INSERT INTO task_attachments (id, task_id, display_name, original_name, size_bytes, sha256, storage_path, created_at, created_by, order_idx) VALUES (?,?,?,?,?,?,?,?,?,?)"
        ).run(spec.finalId, req.params.id, spec.display_name, spec.stagingRow.original_name, spec.stagingRow.size_bytes, spec.stagingRow.sha256, spec.finalRel, nowIso, adminId, maxIdx + 1 + i);
        db.prepare("DELETE FROM task_attachments_staging WHERE id=?").run(spec.stagingRow.id);
      });
    }
    updated = db.prepare("SELECT * FROM tasks WHERE id=?").get(req.params.id);
  });
  try { updateTxn(); } catch (e) {
    for (const mv of movesApplied) { try { fs.renameSync(mv.dst, mv.src); } catch (undoErr) { swallowed("challenges:update-txn-undo-move", undoErr); } }
    if (e && e.message === "not_found") return res.status(404).json({ error: "Question not found" });
    log.error({ ...reqContext(req), tag: "attachments", err: e && e.message }, "[attachments] task update txn failed");
    return res.status(500).json({ error: "Failed to save question." });
  }

  // Build a scalar-only diff (skip heavyweight rich-text bodies — their full
  // snapshot lives in task_versions so the history dialog can show them;
  // including them inline here would blow up the log line).
  const changes = {};
  const trackedScalar = ["title", "difficulty", "answer_type", "correct_answer", "active", "answer_sealed", "author_name", "author_linkedin", "attachment_url"];
  // v8.10.0 — a SEALED answer is recorded as "it changed", never as the two
  // values. This was the sharpest of the leaks the seal had to close and the
  // easiest to miss, because it is not a wire projection at all: `changes` is
  // mirrored into `app.jsonl`, which every REGULAR admin reads through
  // GET /api/admin/logs (whose `q` is a substring filter over the whole line), it
  // is rendered verbatim by the History dialog, and it is copied by
  // scripts/backup.sh. So the key was in cleartext on disk, for ever, from the
  // first edit — and unlike a projection there is no read-time gate that could
  // retrieve it afterwards.
  //
  // WRITE-TIME, not read-time, for exactly that reason: a redaction in
  // `redactLogEntryForRegularAdmin` would leave the plaintext on disk for backups
  // and log shippers, and a superadmin reads the log unredacted by design.
  // The rich-text fields three lines below already had the right idiom for a value
  // too sensitive or too large to inline — "(body changed — see task_versions)" —
  // so the seal reuses it rather than inventing a second convention.
  const _sealedNow = answerSealed(updated) || answerSealed(existing);
  for (const k of trackedScalar) {
    if (existing[k] === updated[k]) continue;
    changes[k] = (_sealedNow && SEALED_FIELDS.includes(k))
      ? "(sealed answer changed — visible to its author, or to a superadmin who has revealed it, in the question editor)"
      : { from: existing[k], to: updated[k] };
  }
  // Rich-text fields: record only whether they changed, not the full bodies.
  for (const k of ["description", "explanation", "hint"]) {
    if (existing[k] !== updated[k]) changes[k] = "(body changed — see task_versions)";
  }
  if (stagingSpecs.length) {
    changes.attachments_promoted = stagingSpecs.map(s => ({ id: s.finalId, display_name: s.display_name }));
  }
  // The topic by NAME (an id reads as nothing in History).
  if ((existing.topic_id || null) !== (updated.topic_id || null)) {
    const _tn = (tid) => (tid ? ((db.prepare("SELECT name FROM topics WHERE id=?").get(tid) || {}).name || null) : null);
    changes.topic = { from: _tn(existing.topic_id), to: _tn(updated.topic_id) };
  }
  createTaskVersion(req.params.id, adminId, "update", storedImageIds, Object.keys(changes).length ? { changes, ...reqContext(req) } : { ...reqContext(req) });
  // v6.20.x — bust leaderboard + /api/me caches when a scoring-relevant field
  // actually changed. `active` is an auto-end / scoring filter predicate (WHERE
  // t.active=1), and difficulty/answer_type/correct_answer feed scoring; the
  // sibling visibility + restore handlers already invalidate for exactly these.
  // Pre-fix this PUT was the one scoring-writer that skipped invalidation, so a
  // change served stale for up to the 5 s leaderboard-cache / 2 s /api/me TTL.
  if (changes.active || changes.difficulty || changes.answer_type || changes.correct_answer) {
    const _affected = db.prepare("SELECT DISTINCT competition_id FROM competition_tasks WHERE task_id=?")
      .all(req.params.id).map(r => r.competition_id);
    for (const cid of _affected) invalidateLeaderboardCache(cid);
    _invalidateMeCacheForComps(_affected);
    if (changes.active) _queueCompleters(req.params.id, _affected);
  }
  res.json({ ok: true, attachments_promoted: stagingSpecs.length });
});

app.patch("/api/admin/tasks/:id/visibility", requireAdmin, csrfProtection, (req, res) => {
  const task = db.prepare("SELECT id, active, locked, created_by_id, answer_sealed FROM tasks WHERE id=?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Question not found" });
  // v8.12.0 — a competitor may not change a challenge held by the event they
  // compete in. Above the seal and the tier gate, for the reason the seal sits
  // above the tier gate: it binds every tier, so answering another question
  // first would hand a superadmin a different reason for the same refusal.
  { const _cmp = refuseCompetitor(res, competitorTaskEditDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  // v8.10.0 — the seal, above the tier gate. See the publish twin for why this is
  // a server refusal and not merely a hidden button; `active` is the other
  // SCORING_FIELD, so hiding a sealed challenge is the same kind of edit.
  {
    const denied = sealedEditDenied(task, actingAdminId(req), sealRevealedFor(req, task.id));
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  // v8.7.0 — THE STRICT gate, not the owner-only one, and the reason is that this
  // route is the OTHER DOOR onto `active`.
  //
  // `active` is one of the scoring fields (`taskScoringEditDenied`), and `PUT /api/admin/tasks/:id` already
  // refuses to move it (via `_scoringEditAttempted` -> `taskScoringEditDenied`)
  // when some event outside this actor's scope also holds the challenge. Gating
  // this route on ownership alone left that refusal reachable-around by
  // REORDERING: the same actor, refused `{active:0}` on the PUT, flipped the same
  // column here and got 200 — the v8.1.0 (PR 30) answer_type shape exactly, where
  // guarding the assign end and not the edit end left the door open. Both ends
  // move together, so "an event admin cannot move a scoring field on an event
  // they do not run" is a theorem rather than a convention.
  //
  // The ended-session freeze below is NOT a substitute and that was the error in
  // the first draft of this gate: `taskFrozenByEndedCompetition` fires only for a
  // SETTLED board, while the case `taskScoringEditDenied` exists for is a LIVE
  // out-of-scope event — hiding a shared challenge there shrinks that event's
  // all-solved denominator (`WHERE t.active=1`) and re-orders its ranks on the
  // tie-break, which is why this handler busts that event's leaderboard cache a
  // few lines below.
  //
  // Cost, stated: the owner of a challenge some other admin's event also holds
  // can no longer hide it, and the refusal names the remedy (ask an
  // administrator). That is the same trade the PUT already makes for the same
  // column, so the two doors now answer alike.
  {
    const denied = taskScoringEditDenied(req, task);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  // v6.16.10 — gate visibility flips on locked tasks. Pre-fix only
  // PUT /api/admin/tasks/:id (line 7269) checked `task.locked`. But
  // visibility is scoring-relevant via the auto-end gate
  // (`allParticipantsSolvedAll`'s `WHERE t.active=1` count), and the
  // documented "frozen scoring" semantics for locked tasks (CLAUDE.md
  // Recalculate + v6.16.4 scoring-edit freeze) should hold uniformly.
  // Superadmin can still toggle visibility on a locked task because
  // they can also unlock it; regular admin gets 403.
  if (task.locked && !req.session.isSuperAdmin) {
    return res.status(403).json({ error: "Question is locked. Only a superadmin can change visibility." });
  }
  // v6.16.16 — TOCTOU close. The UPDATE WHERE re-asserts the lock
  // state observed at SELECT time so a concurrent /lock that lands
  // between this admin's pre-check and the UPDATE doesn't slip
  // through. r.changes==0 on a non-superadmin caller means the task
  // was just locked. Superadmin bypass keeps the existing semantics.
  const newActive = task.active ? 0 : 1;
  // v6.16.7 — wrap UPDATE + createTaskVersion in a single txn so a
  // process death between them can't leave the audit chain with a
  // gap. createTaskVersion writes to task_versions; the v6.13.x
  // attachment-staging promotion contract treats the next explicit
  // Save (PUT) as the snapshot anchor, but visibility flips also
  // emit a version row.
  const _adminId = getAdminIdentity(req);
  // v6.16.16 — UPDATE WHERE re-asserts the lock state (or superadmin
  // bypass) so a concurrent /lock that lands between SELECT and
  // UPDATE doesn't slip through. r.changes==0 means the task was
  // just locked.
  // ext-audit v7.21.1 — the same freeze, and this was the WORST of the gaps: the
  // route is requireAdmin (a REGULAR admin), the kebab entry carried no lifecycle
  // gate, and a measured probe flipped rank 1 and rank 2 on a fully-ended
  // competition with both scores unchanged. The DELETE guard's own error text
  // used to recommend this very toggle as the workaround.
  {
    const _frozen = taskFrozenByEndedCompetition(task.id);
    if (_frozen) return res.status(409).json({ error: `Cannot change visibility — this question is in "${_frozen.name}", which has an ended session whose final standings are frozen. ${FROZEN_REMEDY}` });
  }
  let _visLockedRace = false;
  const visTxn = db.transaction(() => {
    const lockBypass = req.session.isSuperAdmin ? 1 : 0;
    const r = db.prepare("UPDATE tasks SET active=?, updated_at=? WHERE id=? AND (locked=0 OR ?=1)").run(newActive, now().toISOString(), task.id, lockBypass);
    if (r.changes === 0) { _visLockedRace = true; throw new Error("locked_race"); }
    createTaskVersion(task.id, _adminId, "visibility", null, { changes: { active: { from: task.active, to: newActive } }, ...reqContext(req) });
  });
  try { runTxnWithMirrorBuffer(() => visTxn()); }
  catch (e) {
    if (_visLockedRace) return res.status(403).json({ error: "Question was locked while changing visibility. Only a superadmin can change visibility on a locked task." });
    throw e;
  }
  // v6.16.7 — visibility flip changes auto-end's `WHERE t.active=1`
  // count for every comp the task is in, so the leaderboard cache
  // must be busted across all of them.
  const _affectedComps = db.prepare("SELECT DISTINCT competition_id FROM competition_tasks WHERE task_id=?").all(task.id).map(r => r.competition_id);
  for (const cid of _affectedComps) invalidateLeaderboardCache(cid);
  _queueCompleters(task.id, _affectedComps);
  res.json({ ok: true, active: newActive });
});

app.delete("/api/admin/tasks/:id", requireAdmin, requireSuperAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const taskId = req.params.id;
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
  if (!task) return res.status(404).json({ error: "Question not found" });
  // v8.12.0 — a competitor may not change a challenge held by the event they
  // compete in. Above the seal and the tier gate, for the reason the seal sits
  // above the tier gate: it binds every tier, so answering another question
  // first would hand a superadmin a different reason for the same refusal.
  { const _cmp = refuseCompetitor(res, competitorTaskEditDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  // A role scoped to its events reaches this route by its permission; it acts on
  // a challenge only as the strict scoring gate allows (its own, every event
  // holding it in scope): the change reaches every event that holds it.
  { const denied = taskScoringEditDenied(req, task); if (denied) return res.status(403).json({ error: denied.message, code: denied.code }); }
  const adminId = getAdminIdentity(req);

  // Atomic deletion: validate and delete in a single transaction
  const deleteTxn = db.transaction(() => {
    // Re-check all blocking conditions inside the transaction
    const _assignedComps = db.prepare(
      `SELECT c.id, c.name, c.start_time, c.duration_minutes, c.ended_at FROM competitions c
       JOIN competition_tasks ct ON ct.competition_id=c.id
       WHERE ct.task_id=?`
    ).all(taskId);
    const liveComps = _assignedComps.filter(c => competitionStatus(c) === "live");
    if (liveComps.length > 0) {
      return { error: `Cannot delete question while it is used in live event(s): ${liveComps.map(c => c.name).join(", ")}` };
    }
    // audit v7.7.32 (RM2) — mirror the assignment-freeze the assign/unassign
    // routes enforce ("frozen once any session has ended"). Hard delete removes
    // this task's competition_tasks row from ENDED comps too, shrinking their
    // published-task count — which retroactively flips "solved all" and the
    // finish-time tie-break on a FROZEN final leaderboard. A never-attempted task
    // (no submissions/hints anywhere — the only deletable case, per the guards
    // below) still slips through the live-only check when it sits in an ended comp.
    const endedComps = _assignedComps.filter(c => competitionStatus(c) === "ended" || competitionAnySlotEnded(c));
    if (endedComps.length > 0) {
      // ext-audit v7.21.1 — this used to end "Hide it with the visibility toggle
      // instead." That was the platform telling the operator, in its own error
      // message, how to do the thing the guard exists to prevent: `active` is a
      // leaderboard predicate, so hiding a challenge re-orders a finished
      // competition's ranks. The toggle is now frozen too, so the advice would
      // also be wrong — unassigning is the real path.
      return { error: `Cannot delete a question assigned to an event where a session has ended (final standings are frozen): ${endedComps.map(c => c.name).join(", ")}. ${FROZEN_REMEDY}` };
    }
    if (db.prepare("SELECT 1 FROM submissions WHERE task_id=? LIMIT 1").get(taskId)) {
      return { error: "Cannot delete a question that has submissions. Use visibility toggle to hide it instead." };
    }
    if (db.prepare("SELECT 1 FROM hint_reveals WHERE task_id=? LIMIT 1").get(taskId)) {
      return { error: "Cannot delete a question that has hint reveals. Use visibility toggle to hide it instead." };
    }
    // Capture pre-delete counts for the log line (cascaded rows). Attachment
    // storage paths are collected here so we can unlink the binaries AFTER
    // the transaction commits — the ON DELETE CASCADE on task_attachments
    // drops the rows but leaves the files; catch them now before the rows
    // disappear. Linked + detached rows are all captured because hard task
    // delete is the only physical-unlink path.
    deleteTxn._attachmentPaths = db.prepare(
      "SELECT storage_path FROM task_attachments WHERE task_id=?"
    ).all(taskId).map(r => r.storage_path);
    // audit v7.7.32 (RM2) — competition_tasks is leaderboard-relevant (score
    // aggregation JOINs it), so bust the cache for every comp losing this row.
    deleteTxn._affectedComps = _assignedComps.map(c => c.id);
    deleteTxn.counts = {
      feedback: db.prepare("SELECT COUNT(*) as c FROM task_feedback WHERE task_id=?").get(taskId).c,
      tags: db.prepare("SELECT COUNT(*) as c FROM task_tags WHERE task_id=?").get(taskId).c,
      competition_assignments: db.prepare("SELECT COUNT(*) as c FROM competition_tasks WHERE task_id=?").get(taskId).c,
      versions: db.prepare("SELECT COUNT(*) as c FROM task_versions WHERE task_id=?").get(taskId).c,
      challenge_events: db.prepare("SELECT COUNT(*) as c FROM challenge_events WHERE task_id=?").get(taskId).c,
      attachments: deleteTxn._attachmentPaths.length,
    };
    // All checks passed — delete everything atomically. The task_attachments
    // rows are removed by the ON DELETE CASCADE on the FK to tasks(id); no
    // explicit DELETE needed.
    db.prepare("DELETE FROM task_feedback WHERE task_id=?").run(taskId);
    db.prepare("DELETE FROM task_tags WHERE task_id=?").run(taskId);
    db.prepare("DELETE FROM competition_tasks WHERE task_id=?").run(taskId);
    db.prepare("DELETE FROM task_versions WHERE task_id=?").run(taskId);
    db.prepare("DELETE FROM challenge_events WHERE task_id=?").run(taskId);
    db.prepare("DELETE FROM tasks WHERE id=?").run(taskId);
    return null;
  });

  const err = deleteTxn();
  if (err) return res.status(400).json(err);
  // audit v7.7.32 (RM2) — bust the leaderboard cache for every comp that lost
  // this task's assignment row (writer-lock invariant).
  for (const cid of (deleteTxn._affectedComps || [])) invalidateLeaderboardCache(cid);
  // Post-commit: unlink attachment binaries. Fire-and-forget, unreferenced
  // files are also reaped by the boot sweep.
  for (const rel of (deleteTxn._attachmentPaths || [])) {
    // An event's copy of a question shares the bank question's FILES (same
    // storage_path, lib/event-copies.js): a file another row still names stays.
    if (db.prepare("SELECT 1 FROM task_attachments WHERE storage_path=? LIMIT 1").get(rel)) continue;
    // Inline path-containment guard (Checkmarx-recognized sanitizer): resolve the
    // server-generated storage_path under DATA_DIR and only unlink if it stays
    // strictly inside the data dir. Inlined at every attachment sink — see the
    // note in lib/attachments.js; do NOT refactor back into a helper (Cx can't
    // trace sanitization through a called function).
    const _base = path.resolve(DATA_DIR);
    const abs = path.resolve(path.join(DATA_DIR, String(rel || "")));
    if (abs.startsWith(_base + path.sep)) fs.unlink(abs, () => {});
  }
  recordOrphanedAuditEvent("task", task.id, "deleted", adminId, {
    ...reqContext(req),
    title: task.title,
    difficulty: task.difficulty,
    answer_type: task.answer_type,
    cascaded: deleteTxn.counts,
  });
  res.json({ ok: true });
});

// v8.12.2 — WHO WAS THE SEAT, answered for THIS reader. A reveal made under
// impersonation stores the seat as an id (lib/audit.js `sealRevealHistoryDetails`),
// and a challenge's History is readable by every organiser `taskViewDenied`
// admits — including ones who share the challenge with some other event. So the
// seat is named only to a reader who could see that person anyway: an unscoped
// admin, the seat themselves, or an organiser the seat is enrolled in (or
// co-organises) an event with — the participants list's own rule
// (`participantVisibilityScope`), plus the co-organiser, whom the event's
// Organisers dialog already names. Anybody else is told the seat exists and not
// who it was (`acting_as_withheld`), the v8.8.4 row-scope rule: a gate that
// admits you to the ENTITY says nothing about which ROWS of it you may read.
// A deleted account resolves to `acting_as_deleted`, never to a stored address.
//
// EXISTENCE IS ASKED FIRST, for EVERY reader (second review). Visibility for a
// scoped reader is a `competition_users` / `competition_admins` hit — and a
// deletion removes exactly those rows (`deleteUserCascade`; `competition_admins`
// is ON DELETE CASCADE) — so asking visibility first told an organiser whose OWN
// participant it had been that the seat was "an account outside your events",
// a false answer, and `acting_as_deleted` reached only an unscoped reader. That
// an account no longer exists identifies nobody, so it is safe to say to all.
function _revealSeatFor(req, userId, cache) {
  if (cache.has(userId)) return cache.get(userId);
  const u = db.prepare("SELECT email, nickname FROM users WHERE id=?").get(userId);
  let out;
  if (!u) out = { acting_as_deleted: true };
  else {
    const ids = scopedCompetitionIds(req);
    let visible = ids === null || userId === actorId(req);
    if (!visible && ids.length) {
      const ph = "SELECT value FROM json_each(?)";
      visible = !!db.prepare(
        `SELECT 1 FROM competition_users WHERE user_id=? AND competition_id IN (${ph})
         UNION ALL SELECT 1 FROM competition_admins WHERE user_id=? AND competition_id IN (${ph}) LIMIT 1`
      ).get(userId, JSON.stringify(ids), userId, JSON.stringify(ids));
    }
    out = visible ? { acting_as: u.email || u.nickname || null } : { acting_as_withheld: true };
  }
  cache.set(userId, out);
  return out;
}

app.get("/api/admin/tasks/:id/versions", requireAdmin, (req, res) => {
  // v8.7.0 — a version snapshot is the WHOLE row, `correct_answer` included, so
  // this route hands over the answer key of any challenge whose id you can guess.
  // Visibility (not ownership): an event admin may legitimately read the history
  // of a public-domain challenge or one used by their own event.
  // v8.10.0 — `answer_sealed` joins this SELECT because the redaction below needs
  // it (a column-naming SELECT is a list that rots).
  const _histTask = db.prepare("SELECT id, created_by_id, answer_sealed FROM tasks WHERE id=?").get(req.params.id);
  {
    const denied = taskViewDenied(req, _histTask);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  // `snapshot` is included so the history dialog can compute before→after diffs between consecutive versions
  // v8.12.2 — `details` (NULL on every ordinary version, a small JSON blob on a
  // `sealed_reveal` row) is parsed here, server-side, by the one parser every
  // other history read uses (lib/audit.js parseStoredDetails): the client renders
  // `d.impersonated_by` off an OBJECT, and a raw string would silently drop the
  // attribution.
  const _seatCache = new Map();
  const versions = db.prepare(
    "SELECT id, version_num, changed_by, changed_at, change_type, snapshot, details FROM task_versions WHERE task_id=? ORDER BY version_num DESC"
  ).all(req.params.id).map(v => {
    let d = parseStoredDetails(v.details);
    if (d && typeof d === "object" && !Array.isArray(d) && (d.acting_as_id !== undefined || d.acting_as !== undefined)) {
      // The seat is resolved per READER and the stored id never reaches the
      // wire; `acting_as` from a pre-release row is dropped rather than trusted.
      const { acting_as_id: _seatId, acting_as: _legacySeat, ...rest } = d;
      const _seat = _seatId ? _revealSeatFor(req, _seatId, _seatCache) : {};
      // A WITHHELD seat takes its `via` with it (second review): the value
      // `impersonated_admin_view` exists only for an organiser's panel, so
      // passing it beside a withheld seat told the reader the hidden account was
      // an event admin — the one category the withholding exists to not disclose.
      if (_seat.acting_as_withheld) delete rest.via;
      d = { ...rest, ..._seat };
    }
    return { ...v, details: d };
  });
  // v8.10.0 — A SEALED CHALLENGE'S HISTORY IS SEALED TOO, and the redaction is
  // deliberately at the READ.
  //
  // `task_versions` is written as `{...task}` at every edit and is EXEMPT from
  // event retention (lib/event-retention.js), i.e. permanent. So a challenge
  // sealed today has snapshots from before the seal that still carry the key, and
  // the client renders `correct_answer` in the version diff by name
  // (TASK_FIELDS). Redacting here makes the decision RETROACTIVE, which is the
  // only version of it that is true: sealing has to seal the history or the key is
  // one dialog away.
  //
  // NOT at the write (lib/audit.js), for a reason worth keeping: restore re-reads
  // the stored snapshot and REFUSES an incomplete one ("Incomplete version
  // snapshot"), so stripping the key at write time would make every sealed
  // challenge unrestorable by its own author.
  //
  // The LIVE row's flag decides, never the snapshot's — a snapshot predates the
  // decision and must not be allowed to vote on it.
  const _sealActorH = actingAdminId(req);
  const _revealedH = sealRevealedFor(req, req.params.id); // v8.12.2 — a revealed superadmin reads the history as the author does
  // v8.12.0 — a competitor's view of the history withholds the sealed fields
  // AND the hint, for the reason the list projection gives. Every version, since
  // a snapshot from before the event existed carries the same values. This is
  // the COMPETITOR LOCK, not the seal: it binds an UNSEALED challenge a
  // competitor's event holds, and it is what stops a superadmin who revealed a
  // challenge and then enrolled in an event holding it reading the key here —
  // `_revealedH` would otherwise open it (v8.12.2). Since the hint became a
  // sealed field, the seal alone satisfies the old sealed-fixture test, so its
  // witnesses are the PLANTED unsealed challenge (staff-compete-lock) and the
  // reveal-then-enrol arm (sealed-reveal.api).
  const _competesH = competitorEventsForTask(db, competitorIds(req), req.params.id).length > 0;
  const _sealedHistory = _competesH || !sealedAnswerReadable(_histTask, _sealActorH, _revealedH);
  const out = !_sealedHistory ? versions : versions.map(v => {
    let snap;
    try { snap = JSON.parse(v.snapshot); } catch (_) { return { ...v, snapshot: v.snapshot }; }
    let red = redactSealedSnapshot(snap, _histTask, _sealActorH, _revealedH);
    if (_competesH) { red = { ...red }; for (const f of SEALED_FIELDS) delete red[f]; delete red.hint; }
    return { ...v, snapshot: JSON.stringify(red) };
  });
  res.json(out);
});

// v8.12.2 — THE REVEAL. A superadmin who is not the author asks to see a sealed
// challenge's answer and hint; the platform shows them — for the rest of this
// session, on every admin surface — and RECORDS that it did, in the
// challenge's History (a `sealed_reveal` version row naming the superadmin) and
// in the event log (`sealed_answer_revealed`, with the request context). The
// operator's ruling (v8.12.2) reverses v8.10.0's "superadmins included": the
// key stays sealed against every tier except a superadmin ON THE RECORD.
//
// WHY A ROUTE RATHER THAN THE LIST SIMPLY SHOWING IT. The admin list is the only
// read of a task row and it reloads on every tab entry and after every
// mutation, so a passive disclosure would have to be recorded per load (noise)
// or deduped through a session write on a GET (forbidden here). A deliberate
// POST is one recorded act per session per challenge, and the confirm the SPA
// puts in front of it tells the superadmin it is being recorded before they
// press it.
//
// `requireAdmin` + an inline `actingIsSuperAdmin` refusal, NOT `requireSuperAdmin`:
// that middleware reads `req.session.isSuperAdmin`, which an impersonated
// organiser's panel never carries (v8.12.1), and the ACTING human is who may
// reveal — a superadmin in an organiser's seat reveals as themselves, and the
// record says so (`impersonated_by` / `acting_as` ride both stores). The seat's
// SCOPE still binds through `taskViewDenied`. The route is a durable write, so
// under impersonation it meets `impersonationGuard`'s re-read of the acting
// admin and the SPA's "this will change real data" confirm; it is deliberately
// NOT on the impersonation write allowlist.
//
// ORDER: 404, then the competitor lock — a superadmin who competes in an event
// holding this challenge would be reading its key for free, the back door the
// v8.12.0 seal invariant exists to close (`competitor_cannot_edit`, first, like
// every other door) — then the seat's scope, then the tier. The author's own
// reveal is a 200 no-op: nothing is disclosed to the person who wrote the key,
// so nothing is recorded. A second reveal in the same session is idempotent for
// the same reason — the History row records the disclosure, not the click.
app.post("/api/admin/tasks/:id/sealed-reveal", requireAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  // `explanation` is selected only to decide whether there IS one to name in
  // the record — its value never leaves this handler.
  const task = db.prepare("SELECT id, title, created_by_id, answer_sealed, hint, explanation FROM tasks WHERE id=?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Question not found" });
  { const _cmp = refuseCompetitor(res, competitorTaskEditDenied(db, competitorIds(req), task.id)); if (_cmp) return _cmp; }
  {
    const denied = taskViewDenied(req, task);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  const actingId = actingAdminId(req);
  // The author asks to see their own key: nothing to disclose, nothing to
  // record, whatever their tier — answered BEFORE the tier question so an
  // admin-tier author is not told "only a superadmin" about a key they wrote.
  if (answerSealed(task) && isTaskAuthor(task, actingId)) {
    return res.json({ ok: true, revealed: false, author: true });
  }
  {
    const denied = sealRevealDenied(task, actingIsSuperAdmin(req));
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  if (!req.session.sealedReveals || typeof req.session.sealedReveals !== "object" || Array.isArray(req.session.sealedReveals)) {
    req.session.sealedReveals = {};
  }
  if (req.session.sealedReveals[task.id] === true) {
    return res.json({ ok: true, revealed: true, already: true });
  }
  const _ctx = reqContext(req);
  // The History row carries WHO and, under impersonation, WHOSE SEAT (as an
  // id — see `sealRevealHistoryDetails`) — never the ip / agent, which belong
  // to the retention-purged log (see db.js). Field NAMES only, never values:
  // this record must not itself become a leak. Each field is named only when
  // the challenge HAS one, because the History renders the list as a sentence
  // and a record claiming an explanation was disclosed that never existed is a
  // false record (the hint arm always had this rule; the pre-release review
  // found the explanation arm without it).
  const _fields = ["correct_answer",
    ...(richTextHasContent(task.explanation) ? ["explanation"] : []),
    ...(task.hint ? ["hint"] : [])];
  const _via = req.session.impersonator ? "impersonated_admin_view" : "admin_panel";
  // THE RECORD IS WRITTEN BEFORE THE MARKER IS SET, and the order is the whole
  // of the "on the record" promise. `recordSealedReveal`'s version INSERT can
  // throw (SQLITE_FULL, SQLITE_BUSY, a trigger); express-session saves a
  // modified session at res.end even on a 500, so a marker set first would
  // leave a superadmin holding an UNRECORDED reveal — and every retry would
  // take the idempotent `already` branch above and record nothing, for ever.
  // Written first, a failure throws out with the session untouched, and the
  // retry is a real reveal that records. Found by the pre-release review.
  recordSealedReveal(task.id, getAdminIdentity(req), sealRevealHistoryDetails(req, _via, _fields), { task_title: task.title, ..._ctx });
  req.session.sealedReveals[task.id] = true;
  res.json({ ok: true, revealed: true, fields: _fields });
});

app.post("/api/admin/tasks/:id/restore", requireAdmin, csrfProtection, (req, res) => {
  // v8.7.0 — `id` + `created_by_id` join the SELECT because the scope gate below
  // needs both (a column-naming SELECT is a list that rots).
  const taskCheck = db.prepare("SELECT id, locked, correct_answer, answer_type, difficulty, active, status, choices, created_by_id, answer_sealed FROM tasks WHERE id=?").get(req.params.id);
  if (!taskCheck) return res.status(404).json({ error: "Question not found" });
  // v8.12.0 — a competitor may not change a challenge held by the event they
  // compete in. Above the seal and the tier gate, for the reason the seal sits
  // above the tier gate: it binds every tier, so answering another question
  // first would hand a superadmin a different reason for the same refusal.
  { const _cmp = refuseCompetitor(res, competitorTaskEditDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  if (taskCheck?.locked) return res.status(403).json({ error: "Question is locked. Only a superadmin can unlock it." });
  // v8.7.0 — the STRICTER gate, and unconditionally: a restore rewrites the whole
  // row from a snapshot, so `correct_answer`, `answer_type`, `difficulty`,
  // `active`, `status` and `choices` all move whatever the operator intended. It
  // is therefore always a scoring edit, and owning the challenge is not enough
  // while some other admin's event also holds it. (Ahead of the version lookup so
  // a refusal cannot depend on which snapshot was named.)
  {
    const denied = taskScoringEditDenied(req, taskCheck);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  // v8.10.0 — and the seal, which binds every tier the gate above exempts. A
  // restore rewrites `correct_answer` from a snapshot the caller may not read, so
  // for a sealed challenge it is the author's action alone. Without this a
  // non-author could roll the key back to a value they never saw, and — with the
  // history redaction in place — could not even tell what they had done.
  {
    const denied = sealedEditDenied(taskCheck, actingAdminId(req), sealRevealedFor(req, taskCheck.id));
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  const { versionId } = req.body || {};
  // v8.13.3 — TYPE-GUARDED BEFORE THE BIND, below every gate that does not depend
  // on the body so those refusals keep their precedence. better-sqlite3 FLATTENS a
  // one-element array, so `versionId: ["<v>"]` was accepted and PERFORMED the
  // restore, while `{}`, `true` or a two-element array threw at the bind and
  // answered a bare 500. `!= null` keeps the absent → 404 contract below (the
  // driver binds undefined as NULL, which matches no row).
  if (versionId != null && typeof versionId !== "string") return res.status(400).json({ error: "versionId must be text" });
  const version = db.prepare("SELECT * FROM task_versions WHERE id=? AND task_id=?").get(versionId, req.params.id);
  if (!version) return res.status(404).json({ error: "Version not found" });
  // v8.12.2 — a `sealed_reveal` row is a RECORD, not a version: it carries a
  // snapshot only because every row must (the diff renderer pairs consecutive
  // snapshots and this check refuses an incomplete one), and "restoring" it
  // would replay the state the challenge already held when the key was shown.
  // The History dialog offers no Restore on it; a hand-built request is refused.
  if (version.change_type === "sealed_reveal") return res.status(400).json({ error: "That history entry records a sealed answer being revealed; it is not a version of the question and cannot be restored." });
  let s;
  try { s = JSON.parse(version.snapshot); } catch { return res.status(500).json({ error: "Corrupted version snapshot" }); }
  // v8.9.0 — an `any` snapshot legitimately carries an empty correct_answer.
  if (!s.title || !s.difficulty || (answerTypeHasKey(s.answer_type) && !s.correct_answer)) return res.status(500).json({ error: "Incomplete version snapshot" });
  // v8.10.1 — A RESTORE IS THE THIRD DOOR ONTO THE FORBIDDEN PAIR, and the only
  // one that assembles it out of two different points in time. `answer_sealed`
  // is deliberately NOT in the restore column list (a snapshot predating the
  // decision would otherwise UNSEAL the challenge), so the flag stays as it is
  // while `answer_type` is replayed from the snapshot — restoring a version
  // from before the type changed would leave a sealed challenge graded on a
  // type with no key. Refused with the same reason the editor gives, and 409
  // rather than 500: the snapshot is not corrupt, it is simply not restorable
  // onto a sealed challenge.
  if (answerSealed(taskCheck)) {
    const _st = sealTypeDenied(s.answer_type, answerTypeHasKey(s.answer_type));
    if (_st) return res.status(409).json({ error: _st.message, code: _st.code });
  }
  // ext-audit v7.20.9 (F4) — restore the CHOICES alongside the correct set.
  //
  // The snapshot is `{...task}` so it has always CONTAINED `choices`, but the
  // restore UPDATE's hand-written column list never mentioned it. For a
  // multiple-choice challenge that is not a cosmetic omission: `correct_answer`
  // holds choice IDs, so restoring an old answer while leaving today's options
  // in place writes correct ids that name no option — every submission then
  // grades wrong and the challenge becomes literally unsolvable, silently, with
  // both columns still well-formed.
  //
  // A snapshot predating v7.19.0 has no `choices` key at all; such a task cannot
  // have been a choice task (the type did not exist), so the column resets to
  // NULL, which is the state that version actually had.
  const _snapChoices = Object.prototype.hasOwnProperty.call(s, "choices") ? (s.choices ?? null) : null;
  // Refuse a snapshot that cannot produce an answerable question rather than
  // writing it and discovering it at the next submit. Same posture as the
  // import path's `_importChoiceRowOk`.
  if (s.answer_type === "choice") {
    const _snapOpts = parseChoices(_snapChoices);
    const _snapCorrect = parseCorrectIds(s.correct_answer);
    const _snapIds = new Set(_snapOpts.map(c => c.id));
    if (_snapOpts.length < 2 || !_snapCorrect.length || _snapCorrect.length >= _snapOpts.length || !_snapCorrect.every(id => _snapIds.has(id))) {
      return res.status(409).json({ error: "That version's multiple-choice options and correct answers do not match, so restoring it would leave a question nobody can solve." });
    }
  }
  // v8.9.0 — an any-answer version may not carry a hint (no writer stores one;
  // only a hand-edited snapshot can). Refused rather than written, the same
  // posture as the choice check above.
  if (s.answer_type === "any" && richTextHasContent(s.hint)) {
    return res.status(409).json({ error: `That version is an any-answer question that carries a hint, which the type does not allow, so it cannot be restored as it is. ${ANY_HINT_REFUSAL}` });
  }
  // v8.1.4 — THE SEVENTH MUTATION PATH, and the one PR 30 did not enumerate.
  //
  // Restore writes `answer_type` and wholesale-REPLACES `task_tags` from the
  // snapshot, so it can make an already-assigned challenge unanswerable in
  // exactly the two ways the task PUT and the tag-add already refuse. Its only
  // competition gate was the ended-session freeze below — and `challenge-fit`
  // deliberately SKIPS ended events, so the two gates cover disjoint lifecycles
  // and a LIVE Booth Event was protected by neither. Restoring a snapshot with
  // `answer_type='file'` or a `needs:*` tag onto such an event answered 200 and
  // served the walk-up a challenge they cannot do, on a participant list that is
  // deliberately unfiltered by fit. `lib/challenge-fit.js` claims the rule holds
  // "by construction"; without this it did not.
  //
  // THE PROSPECTIVE TAG LIST IS THE SNAPSHOT'S ONLY WHEN IT HAS ONE. The restore
  // transaction rewrites `task_tags` iff `Array.isArray(s.tags)`, so for a
  // pre-feature snapshot the tags that survive are today's — asking about the
  // snapshot's absent list would answer "fine" for a challenge that keeps a
  // `needs:` tag it already carries.
  //
  // Ordered BEFORE the ended-session freeze for the same reason the PUT's copy
  // is: that one is scoped to ENDED events and this one to LIVE ones, so the two
  // can never both fire, and this way a live Booth Event's refusal names the
  // event and a remedy that works rather than falling through to frozen-standings
  // copy. It sits outside the write transaction exactly as its ended-session
  // sibling does — a refusal here returns before `restoreTxn()` is ever invoked,
  // so nothing is written.
  let _qualifyingChanged = false, _qualifyingFlip = false;
  {
    const _restoreTags = Array.isArray(s.tags)
      ? s.tags.filter(t => typeof t === "string")
      : db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(req.params.id).map(r => r.tag);
    const _unfit = taskConflictingEvent(db, req.params.id,
      { title: s.title, answer_type: s.answer_type }, _restoreTags);
    if (_unfit) return res.status(409).json({ error: _unfit.message, code: _unfit.code });
    // Operator ruling 84 (14 Nov 2026) — an answered qualifying question's
    // options keep their places, the PUT's rule: a version whose options move,
    // drop or insert one is refused (qualifying now, or by the version's tags).
    if (qualifyingOptionsFixed(db, taskCheck, _restoreTags)) {
      const _fixed = answeredOptionsChangeDenied(parseChoices(taskCheck.choices), parseChoices(_snapChoices));
      if (_fixed) return res.status(409).json({ error: `Cannot restore that version — ${_fixed.message.charAt(0).toLowerCase()}${_fixed.message.slice(1)}`, code: _fixed.code });
    }
    // A qualifying question stays a pick-one question: a version that would
    // leave a qualifying challenge (by its tags after the restore) of another
    // type, or without its options, is refused like the PUT, and asked as the
    // PUT asks: a version with the same type and options as an older qualifying
    // challenge has now changes neither, so it restores.
    if (tagsMakeQualifying(_restoreTags)) {
      const _sameShape = s.answer_type === taskCheck.answer_type && (_snapChoices ?? null) === (taskCheck.choices ?? null);
      const _np = (_sameShape && require("../lib/qualifying").isQualifyingTask(db, req.params.id)) ? null
        : qualifyingNeedsPickOneDenied({ answer_type: s.answer_type, choices: _snapChoices });
      if (_np) return res.status(409).json({ error: `Cannot restore that version — ${_np.message.charAt(0).toLowerCase()}${_np.message.slice(1)}`, code: _np.code });
    }
    // Operator ruling N7 (14 Nov 2026) — an event asks each qualifying question
    // once: a key the version brings back that an event holding this challenge
    // already has through another challenge is refused, the tag route's rule.
    const _curKeys = new Set(qualifyingKeysFromTags(db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(req.params.id).map(r => r.tag)));
    const _nextKeys = new Set(qualifyingKeysFromTags(_restoreTags));
    const _newKeys = [..._nextKeys].filter(k => !_curKeys.has(k));
    // A version that adds or drops a qualifying tag is the tag routes' change:
    // it re-scores the challenge and moves every holding event's finish count,
    // so an ended session freezes it here too, and a restore that makes it
    // renumbers the challenge after the write, as they do.
    // Compared as scoring reads them (`tag LIKE 'qualifying:%'`, malformed keys
    // an import stored included), not by the well-formed keys alone.
    const _qTags = (tags) => new Set(tags.filter(t => typeof t === "string" && t.toLowerCase().startsWith("qualifying:")).map(t => t.toLowerCase()));
    const _curQ = _qTags(db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(req.params.id).map(r => r.tag));
    const _nextQ = _qTags(_restoreTags);
    _qualifyingChanged = _curQ.size !== _nextQ.size || [..._curQ].some(t => !_nextQ.has(t));
    _qualifyingFlip = (_curQ.size > 0) !== (_nextQ.size > 0);
    if (_qualifyingChanged && taskFrozenByEndedCompetition(req.params.id)) {
      return res.status(409).json({ error: `Cannot restore that version — it changes whether this is a qualifying question, and the question is in an event with an ended session. ${FROZEN_REMEDY}`, code: "qualifying_tag_frozen" });
    }
    if (_newKeys.length) {
      for (const _c of db.prepare("SELECT c.id, c.name FROM competition_tasks ct JOIN competitions c ON c.id=ct.competition_id WHERE ct.task_id=? ORDER BY c.name").all(req.params.id)) {
        const _dup = qualifyingKeyHeldDenied(db, _c, req.params.id, _newKeys);
        if (_dup) return res.status(409).json({ error: `Cannot restore that version — it makes this question a qualifying question, and ${_heldTopicClause(req, _c, _dup)}. An event asks each one once: take it out of that event first, or restore another version.`, code: _dup.code });
      }
    }
  }
  // v6.20.x — apply the SAME multi-slot fairness freeze as PUT /api/admin/tasks/:id.
  // restore rewrites correct_answer / answer_type / difficulty / active / status
  // straight from the snapshot; if any of those scoring/availability fields would
  // CHANGE while the task is in a competition that already has an ended session,
  // restoring would retroactively shift that ended slot's leaderboard (and a recalc
  // would rescore it against the snapshot answer) — exactly the case the PUT freeze
  // blocks. Text-only / attachment-only restores are still allowed.
  // v7.20.9 (ext-audit F4) — `choices` joins the freeze test. Restoring a
  // different option SET on a challenge whose ended session graded against the
  // old one changes what that session's participants were asked, and (unlike
  // the PUT case, where the correct set is re-derived from the ticks) a restore
  // can swap the options while the correct ids stay byte-identical.
  // v8.9.0 — text answers compare CANONICALLY (see the PUT twin): an older
  // snapshot may hold a padded or CRLF value that grades identically to today's
  // canonical row, and that is not a scoring change.
  const _cmpAnswer = (v) => s.answer_type === "text" ? canonicaliseTextAnswers(v) : v;
  const _restoreScoringChange =
    (_cmpAnswer(s.correct_answer) !== _cmpAnswer(taskCheck.correct_answer)) ||
    (s.answer_type    !== taskCheck.answer_type)    ||
    (s.difficulty     !== taskCheck.difficulty)     ||
    (s.active         !== taskCheck.active)         ||
    (s.status         !== taskCheck.status)         ||
    ((_snapChoices ?? null) !== (taskCheck.choices ?? null));
  if (_restoreScoringChange) {
    const _rCompIds = db.prepare("SELECT competition_id FROM competition_tasks WHERE task_id=?").all(req.params.id).map(r => r.competition_id);
    for (const cid of _rCompIds) {
      const _rComp = getCompetition(cid);
      if (_rComp && competitionAnySlotEnded(_rComp)) {
        return res.status(409).json({
          error: `Cannot restore — this version changes scoring/availability (correct_answer / answer_type / difficulty / active / status) and the question is in "${_rComp.name}" which has at least one ended session. ${FROZEN_REMEDY}`,
        });
      }
    }
  }
  const attachments_missing = [];
  // v6.16.16 — TOCTOU close. The first UPDATE re-asserts `locked=0`;
  // r.changes===0 means a concurrent /lock landed between the JS
  // pre-check and this UPDATE. Throw a sentinel to roll the txn back.
  let _restoreLockedRace = false;
  const restoreTxn = db.transaction(() => {
    // v8.1.0 — `attempt_cap` is restored too. task_versions snapshots the whole
    // row, so it has carried the column since the migration; this UPDATE's column
    // list is hand-maintained, which is exactly how `choices` went missing for a
    // release (v7.20.9 F4) and made restored choice challenges unsolvable. A
    // snapshot predating the column restores NULL — uncapped — which is the
    // correct reading of "this version had no cap".
    //
    // v8.7.0 — `created_by_id` IS DELIBERATELY ABSENT FROM THIS LIST, and must
    // stay absent. `task_versions` snapshots the whole row, so a snapshot written
    // after v8.7.0 CARRIES the column — restoring it would transfer ownership of a
    // challenge to whoever happened to own it at that version, as a side effect of
    // an operator undoing a typo. Restore rewrites CONTENT; who owns the challenge
    // is not content. (This list is hand-maintained, which is exactly how `choices`
    // went missing for a release — v7.20.9 F4 — so the omission is stated rather
    // than left to be "fixed" by the next reader completing the list.)
    //
    // v8.10.0 — `answer_sealed` IS ABSENT FOR THE SAME REASON, and the direction
    // of the failure is why it matters more. A snapshot taken BEFORE the seal
    // carries `answer_sealed: 0`, so restoring it would UNSEAL the challenge —
    // silently, as a side effect of an operator undoing a typo, and irreversibly,
    // since the platform refuses to seal an answer a second time. The seal is a
    // decision about who may read the challenge, not a version of its content, so
    // it survives every restore. Stated here rather than left implicit, and
    // asserted by tests/tasks-drift.spec.js.
    const r = db.prepare(`UPDATE tasks SET title=?, description=?, difficulty=?, answer_type=?, correct_answer=?, choices=?, explanation=?, hint=?, attachment_url=?, active=?, status=?, author_name=?, author_linkedin=?, attempt_cap=?, updated_at=? WHERE id=? AND locked=0`)
      .run(s.title, s.description, s.difficulty, s.answer_type,
           // v8.9.0 — text is written in its canonical form so a restore never
           // re-introduces a non-canonical value; `any` never carries a key.
           s.answer_type === "text" ? canonicaliseTextAnswers(s.correct_answer) : (s.answer_type === "any" ? "" : s.correct_answer),
           _snapChoices, s.explanation, s.answer_type === "any" ? null : s.hint, s.attachment_url, s.active, s.status, s.author_name||null, s.author_linkedin||null, (Number.isInteger(s.attempt_cap) && s.attempt_cap > 0 ? s.attempt_cap : null), now().toISOString(), req.params.id);
    if (r.changes === 0) { _restoreLockedRace = true; throw new Error("locked_race"); }
    // Restore tags if the snapshot includes them (backward-compatible with pre-feature snapshots)
    if (Array.isArray(s.tags)) {
      db.prepare("DELETE FROM task_tags WHERE task_id=?").run(req.params.id);
      const insertTag = db.prepare("INSERT OR IGNORE INTO task_tags (task_id, tag) VALUES (?,?)");
      for (const tag of s.tags) insertTag.run(req.params.id, tag);
    }
    // A restore that makes the challenge a qualifying question, or stops it being
    // one, re-scores its stored answers as the tag doors do (sweep #91), at the
    // restored difficulty: the UPDATE above has already written it.
    if (_qualifyingFlip) _rescoreAfterQualifyingFlip(req, req.params.id, "restore");
    // Restore attachments. Two-step: detach EVERY currently-linked row first
    // so the partial UNIQUE index on (task_id, LOWER(display_name)) doesn't
    // trip on name swaps, then re-link rows the snapshot names. Binaries are
    // never touched — they've been on disk the whole time (soft-delete
    // semantic), so a detached row's content survives for free. Rows the
    // snapshot references but that have been hard-deleted (only possible if
    // the task itself was recreated with the same id) surface in
    // `attachments_missing`.
    //
    // Legacy snapshots (written before v6.13.0) have no `attachments` key.
    // Treat that as "state had no attachments" — the only reasonable user-
    // facing semantic, since the feature didn't exist yet and restoring to
    // such a version should bring the task back to that pre-feature state.
    // Without this coercion, restoring to a legacy create/edit snapshot
    // silently leaves every later-added attachment attached, which surfaces
    // as "restore didn't remove the attachment I just added."
    const snapAttachments = Array.isArray(s.attachments) ? s.attachments : [];
    db.prepare("UPDATE task_attachments SET detached_at=? WHERE task_id=? AND detached_at IS NULL")
      .run(new Date().toISOString(), req.params.id);
    const relinkStmt = db.prepare(
      "UPDATE task_attachments SET detached_at=NULL, display_name=?, order_idx=? WHERE id=? AND task_id=?"
    );
    const probeStmt = db.prepare("SELECT 1 FROM task_attachments WHERE id=? AND task_id=?");
    for (const sa of snapAttachments) {
      if (!sa || typeof sa.id !== "string") continue;
      if (!probeStmt.get(sa.id, req.params.id)) {
        attachments_missing.push({ id: sa.id, display_name: sa.display_name });
        continue;
      }
      relinkStmt.run(String(sa.display_name || "attachment"), Number.isInteger(sa.order_idx) ? sa.order_idx : 0, sa.id, req.params.id);
    }
  });
  try { runTxnWithMirrorBuffer(() => restoreTxn()); }
  catch (e) {
    if (_restoreLockedRace) return res.status(403).json({ error: "Question was locked while restoring. Unlock it first and retry." });
    throw e;
  }
  if (_qualifyingChanged) _renumberAfterQualifyingChange(req.params.id);
  createTaskVersion(req.params.id, getAdminIdentity(req), "restore", null, {
    ...reqContext(req),
    restored_from: {
      version_id: version.id,
      version_num: version.version_num,
      snapshot_changed_at: version.changed_at,
      snapshot_changed_by: version.changed_by,
    },
    ...(attachments_missing.length ? { attachments_missing } : {}),
  });
  // v6.16.13 — restore writes leaderboard-relevant fields (active,
  // status, correct_answer, difficulty, answer_type) directly to
  // tasks. Two of these — active + status — are filter predicates in
  // every scoring + auto-end query. The v6.9.9 writer-lock invariant
  // requires invalidating each affected comp's leaderboard cache;
  // pre-fix restore was the one snapshot writer that skipped this.
  // The visibility patch (v6.16.7) is the canonical pattern.
  const _restoreAffectedComps = db.prepare(
    "SELECT DISTINCT competition_id FROM competition_tasks WHERE task_id=?"
  ).all(req.params.id).map(r => r.competition_id);
  for (const cid of _restoreAffectedComps) invalidateLeaderboardCache(cid);
  if (_qualifyingFlip) _invalidateMeCacheForComps(_restoreAffectedComps);
  if (s.active !== taskCheck.active || s.status !== taskCheck.status || _qualifyingFlip) _queueCompleters(req.params.id, _restoreAffectedComps);
  res.json({ ok: true, attachments_missing });
});

// v8.1.0 — grant a participant more attempts on one challenge in one event.
//
// ADMIN-TIER, not superadmin, for the reason the desk fallback is (v7.16.5): it is
// the admin RUNNING the event who is standing next to the participant who has run
// out, and a control they cannot reach is no control at all. Bounded the way that
// one is — participant-role targets only, the destructive-admin limiter, CSRF, and
// an event on the participant's own row attributed to the acting admin.
//
// EXPLICITLY PERMITTED ON AN ENDED EVENT, and that is not an oversight. Once every
// participant is either solved or exhausted the event auto-ends, and BOTH revive
// gates refuse while that predicate still holds — so a grant is the only route
// back that restores THIS participant's attempts without changing the challenge's
// cap for every event that holds it. Refusing here would make the state
// unrecoverable, which is the trap the frozen-competition remedy fell into
// (v7.29.0): advice whose precondition the platform itself denies.
//
// v8.3.11 — "the ONLY route back" was overstated and is corrected above. Two other
// paths reopen an auto-ended event without any all-solved check
// (`routes/participants.js` revives on a new-participant assign, and a
// remove-then-re-add does the same) — but neither gives the exhausted participant
// an attempt, so neither is a recovery for them.
//
// IT DOES NOT CLEAR `ended_at`, and must not: a grant that silently un-ended a
// settled event is the v8.1.9 accidental-revive defect. The grant is the
// PRECONDITION for the reopen, not the reopen — so the response says
// `competition_ended` and the client's toast names the second step and the tier
// that can perform it. Until v8.3.11 the admin client filtered ended events out of
// this flow at two independent points, which made the whole case reachable only
// with curl.
//
// It does NOT refuse the way the public endpoints do. Those are 200-always for
// anti-enumeration; this one is admin-gated with no enumeration surface, so a
// silent success would be v7.14.2 at API level — the admin needs to know when the
// grant did nothing.
app.post("/api/admin/tasks/:id/attempt-grant", requireAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const { userId, competitionId } = req.body || {};
  if (typeof userId !== "string" || !userId.trim()) return res.status(400).json({ error: "userId is required" });
  if (typeof competitionId !== "string" || !competitionId.trim()) return res.status(400).json({ error: "competitionId is required" });
  const extraRaw = req.body?.extra;
  const extra = typeof extraRaw === "number" ? extraRaw
    : (typeof extraRaw === "string" && /^\d+$/.test(extraRaw.trim()) ? Number(extraRaw.trim()) : NaN);
  if (!Number.isInteger(extra) || extra < 1 || extra > ATTEMPT_CAP_MAX) {
    return res.status(400).json({ error: `extra must be a whole number between 1 and ${ATTEMPT_CAP_MAX}.` });
  }

  // The grant is on the event's own question: naming a bank question means this
  // event's copy of it (lib/event-copies.js).
  const task = db.prepare("SELECT id, title, attempt_cap FROM tasks WHERE id=?").get(assignedEventTaskId(db, req.params.id, competitionId) || req.params.id);
  if (!task) return res.status(404).json({ error: "Question not found" });
  const comp = getCompetition(competitionId);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // v8.7.0 — the grant is scoped to ONE event, so the event is the only thing to
  // check: the challenge is proved visible by arm (b) of the view rule once the
  // assignment check below passes, and the participant is proved in scope by
  // being enrolled in it. Refused before the grant is written.
  {
    const denied = competitionDenied(req, competitionId);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  // v8.12.0 — a competitor may not grant attempts on the event they compete in
  // (their own least of all — a grant is a scoring-relevant write).
  { const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), competitionId)); if (_cmp) return _cmp; }
  const user = db.prepare("SELECT id, email, nickname, role FROM users WHERE id=?").get(userId);
  if (!user) return res.status(404).json({ error: "Participant not found" });
  const _enrolled = !!db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(competitionId, userId);
  // Peer-admin doctrine: granting attempts is a scoring-relevant write on someone
  // else's account, so it stops at the participant tier like every sibling.
  //
  // v8.12.0 — EXCEPT on an event where staff compete: there an enrolled admin or
  // event admin IS a competitor, with the same attempt cap and the same need for
  // a grant when they run out. The peer-admin half survives for the tiers that
  // manage accounts: a REGULAR admin still may not grant to an admin or
  // superadmin (the v7.14.2 rule), and the row-holder test stays below because
  // a grant to somebody who is not enrolled would be stored and mean nothing.
  const _competitorTarget = _enrolled && staffCompeteOn(comp);
  if ((user.role || "participant") !== "participant" && !_competitorTarget) {
    return res.status(403).json({ error: "Attempt grants apply to participant accounts only." });
  }
  // The peer half asks the ONE privileged-target predicate (lib/rbac.js
  // privilegedTargetFor): an unscoped role, or one holding what the actor lacks.
  if (_competitorTarget && require("../lib/rbac").privilegedTargetFor(req, user.role)) {
    return res.status(403).json({ error: "Only a superadmin can grant attempts to an admin or superadmin account." });
  }
  if (!_enrolled) {
    return res.status(409).json({ error: "That participant is not enrolled in this event." });
  }
  if (!db.prepare("SELECT 1 FROM competition_tasks WHERE competition_id=? AND task_id=?").get(competitionId, task.id)) {
    return res.status(409).json({ error: "That question is not assigned to this event." });
  }
  // A grant on an UNCAPPED challenge would be stored and mean nothing — the admin
  // would believe they had helped. Named, because "nothing happened" is the
  // failure mode a desk cannot diagnose.
  if (resolveAttemptCap(task, comp) === null) {
    return res.status(409).json({ error: "That question has no attempt cap in this event, so there is nothing to grant.", code: "not_capped" });
  }

  const granted = grantAttempts(userId, task.id, competitionId, extra);
  const state = attemptState(userId, task, comp);
  try {
    recordUserEvent(userId, "attempt_grant", getAdminIdentity(req), {
      task_id: task.id, task_title: task.title,
      competition_id: competitionId, competition_name: comp.name,
      extra, granted_total: granted,
      attempts_used: state.used, attempts_left: state.left,
      ...reqContext(req),
    });
  } catch (e) { log.error({ ...reqContext(req), err: e.message }, "attempt_grant audit failed"); }
  // The auto-end predicate reads grants, so a grant can UN-finish a participant
  // and the board's derived state moves with it.
  invalidateLeaderboardCache(competitionId);
  // v8.3.11 — the SERVER answers whether the participant can act on this yet. The
  // client's own status comes from a model that can be a poll old, and a grant
  // reported as an unqualified success into an event nobody can act in is the one
  // wrong answer this whole control exists to avoid.
  res.json({
    ok: true, granted_total: granted,
    competition_ended: competitionStatus(comp) === "ended",
    attempts: { cap: state.cap, granted: state.granted, effective: state.effective, used: state.used, left: state.left },
  });
});

app.post("/api/admin/tasks/:id/lock", requireAdmin, requireSuperAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const task = db.prepare("SELECT id, locked, created_by_id FROM tasks WHERE id=?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Question not found" });
  // v8.12.0 — a competitor may not change a challenge held by the event they
  // compete in. Above the seal and the tier gate, for the reason the seal sits
  // above the tier gate: it binds every tier, so answering another question
  // first would hand a superadmin a different reason for the same refusal.
  { const _cmp = refuseCompetitor(res, competitorTaskEditDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  // A role scoped to its events reaches this route by its permission; it acts on
  // a challenge only as the strict scoring gate allows (its own, every event
  // holding it in scope): the change reaches every event that holds it.
  { const denied = taskScoringEditDenied(req, task); if (denied) return res.status(403).json({ error: denied.message, code: denied.code }); }
  const newLocked = task.locked ? 0 : 1;
  // v6.16.7 — wrap UPDATE + version emit in a single txn (same
  // motivation as the visibility patch above).
  const _adminId = getAdminIdentity(req);
  const lockTxn = db.transaction(() => {
    db.prepare("UPDATE tasks SET locked=?, updated_at=? WHERE id=?").run(newLocked, now().toISOString(), task.id);
    createTaskVersion(task.id, _adminId, newLocked ? "lock" : "unlock", null, { changes: { locked: { from: task.locked, to: newLocked } }, ...reqContext(req) });
  });
  runTxnWithMirrorBuffer(() => lockTxn());
  res.json({ ok: true, locked: newLocked });
});

// Re-grade every historical submission for a task against the CURRENT
// answer_type + correct_answer. v6.2.6 — without this, an admin who fixes a
// typo in correct_answer mid-competition leaves prior submissions stuck
// scored against the broken answer (false positives + false negatives both
// possible). Superadmin-only because retroactive scoring is a destructive
// operation: it can flip a participant from "solved" to "wrong" or vice
// versa, change leaderboard rank, and propagate through any downstream auto-
// end logic. Wrapped in a single transaction so partial recompute can never
// land. Returns counts so the admin can see what changed.
app.post("/api/admin/tasks/:id/recalculate", requireAdmin, requireSuperAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
  const task = db.prepare("SELECT id, title, difficulty, answer_type, correct_answer, choices, locked, created_by_id, answer_sealed FROM tasks WHERE id=?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Question not found" });
  // v8.12.0 — a competitor may not change a challenge held by the event they
  // compete in. Above the seal and the tier gate, for the reason the seal sits
  // above the tier gate: it binds every tier, so answering another question
  // first would hand a superadmin a different reason for the same refusal.
  { const _cmp = refuseCompetitor(res, competitorTaskEditDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  // A role scoped to its events reaches this route by its permission; it acts on
  // a challenge only as the strict scoring gate allows (its own, every event
  // holding it in scope): the change reaches every event that holds it.
  { const denied = taskScoringEditDenied(req, task); if (denied) return res.status(403).json({ error: denied.message, code: denied.code }); }
  // v8.10.0 — a sealed answer is re-graded by its author alone.
  //
  // Recalculate discloses no key in its response, so this is not a redaction — it
  // is the ORACLE it would otherwise become. A superadmin cannot PUT a guessed
  // answer to a sealed challenge (the PUT refuses them), but leaving recalculate
  // open would let a non-author re-grade every stored submission against a key
  // they may not read and then read `flipped` — the count IS the answer to "was my
  // guess right", one bit at a time, and it strands real participants while doing
  // it. Raised above the lock check so a sealed challenge answers about the seal
  // rather than about a lock the caller could ask a peer to lift.
  {
    const denied = sealedEditDenied(task, actingAdminId(req), sealRevealedFor(req, task.id));
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  // v6.16.13 — recalculate gated on task.locked. The lock doctrine
  // (v6.16.4 scoring-edit freeze, v6.16.10 visibility lock-guard,
  // existing PUT/restore/submit/hint guards) treats `task.locked` as
  // "freeze scoring". Recalculate is the one path that most directly
  // rewrites scoring (is_correct, points_delta, hint points_deducted)
  // and previously bypassed the lock entirely. A superadmin who
  // intentionally locked a task to signal "scoring is frozen" could
  // have a peer superadmin silently rescore it — breaking the
  // operator-to-operator contract the lock conveys. 423 with explicit
  // "unlock first" guidance forces the reverse path.
  if (task.locked) {
    return res.status(423).json({ error: "Question is locked. Unlock it before recalculating — recalculate rewrites scoring." });
  }
  // Warn when any competition using this task has a live session — recalculating
  // mid-event changes participant scores without notice. Superadmins who have
  // read this message can override by sending `confirm_live: true` in the body.
  if (!req.body?.confirm_live) {
    const _liveComp = db.prepare(
      "SELECT c.id FROM competitions c JOIN competition_tasks ct ON ct.competition_id=c.id WHERE ct.task_id=?"
    ).all(req.params.id).find(r => {
      const c = getCompetition(r.id);
      return c && !competitionFullyEnded(c) && competitionAnySlotStarted(c);
    });
    if (_liveComp) {
      // v8.1.5 — the refusal names the ACTION, not the JSON field, and carries a
      // `code` the client branches on. The old text ("Send confirm_live:true in
      // the body") was API-speak rendered verbatim into an admin's toast, so the
      // one override this route offers was reachable only with curl — and
      // recalculate on a LIVE event is precisely where it matters, because a live
      // capped event is the only place a re-grade can strand somebody. A refusal
      // must name a remedy the person reading it can actually take (v7.29.0).
      return res.status(409).json({
        error: "A session using this question is currently live. Recalculating will change participant scores mid-event — confirm again to proceed.",
        code: "live_session_confirm",
      });
    }
  }
  // v7.21.6 — these were a hand-written ladder and penalty, in the ONE route
  // that rewrites stored scores. Change lib/scoring.js and recalculate would
  // silently rescore history against the old table while submit used the new
  // one — internally inconsistent totals, no error anywhere.
  if (POINTS[task.difficulty] == null) return res.status(400).json({ error: "Task has invalid difficulty" });
  // Event team reports — a QUALIFYING challenge scores nothing, right or wrong,
  // exactly as the submit path stores it (lib/qualifying.js).
  const _qualifying = require("../lib/qualifying").isQualifyingTask(db, task.id);
  const correctPts = _qualifying ? 0 : POINTS[task.difficulty];
  const wrongPts = _qualifying ? 0 : -PENALTY;

  // ext-audit v7.21.1 — recalculate is SCOPED AWAY FROM FROZEN COMPETITIONS.
  //
  // It rewrote `is_correct` / `points_delta` for EVERY submission on the task,
  // with no competition scoping at all — and the challenge bank is deliberately
  // many-to-many across competitions, so fixing a typo for today's event
  // silently rescored every finished past event that used the same challenge.
  // This is the only write path that moves the SCORE column (not merely the
  // tie-break) on a board whose standings are final.
  //
  // Scoped rather than REFUSED, unlike the other four writers: refusing would
  // leave a superadmin unable to correct a live event's scoring the moment the
  // challenge had ever been used before, which is the normal case for a reused
  // bank. The frozen competitions' rows are left exactly as they are and the
  // count is reported, following the v7.20.9 `unresolved` precedent — a silent
  // skip would read as "nothing needed changing".
  const _frozenCompIds = db.prepare("SELECT competition_id FROM competition_tasks WHERE task_id=?")
    .all(req.params.id).map(r => r.competition_id)
    .filter(cid => { const c = getCompetition(cid); return c && competitionAnySlotEnded(c); });
  const _frozenSet = new Set(_frozenCompIds);
  // v8.1.4 — `user_id` joins the SELECT so the strand scan below can be scoped to
  // the rows this run actually rewrote. It is read, never written.
  const _allSubs = db.prepare("SELECT id, user_id, answer, answer_canonical, is_correct, points_delta, competition_id FROM submissions WHERE task_id=?").all(req.params.id);
  const subs = _allSubs.filter(r => !_frozenSet.has(r.competition_id));
  const _solvedBefore = _correctSolversByEvent(req.params.id);   // for the completion queue, after the flips
  const frozenSkipped = _allSubs.length - subs.length;
  let flipped = 0, total = subs.length;
  // ext-audit v7.20.9 (F2) — multiple-choice re-grading.
  //
  // The generic branch below compares `submissions.answer` against
  // `correct_answer` as text. For a choice task those are two different
  // languages — the stored answer is the human rendering ("Paris | Rome") and
  // the correct answer is a JSON array of choice ids — so the comparison could
  // never be true and EVERY correct choice submission was rewritten to
  // incorrect / -5. Reproduced by the auditor and by the regression lock.
  //
  // Ids come from `answer_canonical` (written at submit since v7.20.9). Rows
  // that predate the column are re-derived from their human rendering by
  // matching option TEXT, which is exact when the options have not been
  // renamed; when it is ambiguous or unresolvable the row is LEFT ALONE and
  // counted, because guessing would reintroduce the very defect being fixed.
  const _isChoice = task.answer_type === "choice";
  const _opts = _isChoice ? parseChoices(task.choices) : [];
  const _correctIds = _isChoice ? parseCorrectIds(task.correct_answer) : [];
  const _idsByText = choiceIdsByText(_opts);
  let unresolved = 0;
  const updates = [];
  for (const s of subs) {
    let correct = false;
    if (_isChoice) {
      let picked = parseCorrectIds(s.answer_canonical);
      if (!s.answer_canonical) {
        const mapped = legacySelectionIds(s.answer, _idsByText);
        if (!mapped) { unresolved++; continue; }
        picked = mapped;
      }
      correct = gradeChoice(picked, _correctIds);
    } else if (task.answer_type === "json") {
      try { correct = jsonExactMatch(JSON.parse(s.answer || ""), JSON.parse(task.correct_answer)); } catch { correct = false; }
    } else if (task.answer_type === "any") {
      // v8.9.0 — any non-empty answer is correct. A challenge switched from
      // `text` to `any` carries old wrong rows, and re-grading them correct IS the
      // rescoring an admin runs this for. v8.14.6 — a choice answer that picked
      // nothing (an empty stored selection) is an empty answer, though its
      // "(nothing selected)" text is not.
      // A PICK-ONE question (`any` with options) is graded by the same rule:
      // its options restrict what the submit door ACCEPTS, never what counts as
      // right — every option is correct, so neither an answer given before the
      // options existed nor one on an option since reworded or removed becomes
      // wrong (the PUT's "an option edit moves no grade").
      correct = !storedChoicePickedNothing(s) && String(s.answer || "").trim().length > 0;
    } else if (task.answer_type === "text") {
      // v8.9.0 — the ONE definition, with multiple accepted answers (lib/scoring).
      correct = gradeTextAnswer(s.answer, task.correct_answer);
    } else {
      // `file`: the single-string rule, deliberately NOT the newline-split one —
      // a file's expected content may legitimately span lines.
      correct = normaliseTextAnswer(s.answer) === normaliseTextAnswer(task.correct_answer);
    }
    const newIsCorrect = correct ? 1 : 0;
    const newPts = correct ? correctPts : wrongPts;
    if (newIsCorrect !== s.is_correct || newPts !== s.points_delta) {
      updates.push({ id: s.id, user_id: s.user_id, competition_id: s.competition_id,
                     is_correct: newIsCorrect, points_delta: newPts, was_correct: s.is_correct, was_pts: s.points_delta });
    }
  }
  // v6.10.26: also rescale stored hint deductions. The hint route
  // writes `points_deducted = ROUND(POINTS[difficulty] * 0.3)` at
  // reveal time. If an admin promotes a task from easy (15 pt hint
  // cost) to hard (45 pt) or demotes the other way, historical
  // hint_reveals stay on the OLD scale while submissions move to
  // the new one — internally inconsistent total. One-shot UPDATE
  // with a `!=` guard so already-up-to-date rows don't churn.
  // `hint_reveals` has a composite PK (competition_id, user_id,
  // task_id) — no single-column id — hence the set-based update.
  const newHintCost = Math.round(correctPts * HINT_DEDUCTION_RATE);
  let hintsRescaled = 0;
  // v6.10.83: stamp `updated_at` on every rewritten submission + rescaled
  // hint_reveal so /api/admin/submissions can MAX-aggregate them into a
  // drift fingerprint. Without this, a recalc concurrent with an admin's
  // multi-page Submissions walk silently rewrites `is_correct` /
  // `points_delta` / `points_deducted` under the operator and only
  // deletion drift would surface via the v6.10.82 total-delta banner.
  const recalcAtIso = now().toISOString();
  // v6.16.16 — close the lock-TOCTOU. Pre-fix the JS pre-check at
  // line 7966 read `task.locked` from the SELECT above, then `tx`
  // ran without re-asserting. Two superadmins concurrently — one
  // running /lock, one running /recalculate — could race the lock
  // commit between SELECT and txn UPDATE. Now: re-SELECT inside the
  // txn body and throw a sentinel if locked changed.
  let _lockedRaceLost = false;
  const tx = db.transaction(() => {
    const fresh = db.prepare("SELECT locked FROM tasks WHERE id=?").get(req.params.id);
    if (fresh && fresh.locked) { _lockedRaceLost = true; throw new Error("locked_race"); }
    const upd = db.prepare("UPDATE submissions SET is_correct=?, points_delta=?, updated_at=? WHERE id=?");
    for (const u of updates) { upd.run(u.is_correct, u.points_delta, recalcAtIso, u.id); flipped++; }
    // Same scope as the submissions above — a frozen competition's hint
    // deductions are part of its final scores.
    const _hintPh = _frozenCompIds.length ? " AND competition_id NOT IN (SELECT value FROM json_each(?))" : "";
    const hintRes = db.prepare(
      `UPDATE hint_reveals SET points_deducted=?, updated_at=? WHERE task_id=? AND points_deducted != ?${_hintPh}`
    ).run(newHintCost, recalcAtIso, req.params.id, newHintCost, ...(_frozenCompIds.length ? [JSON.stringify(_frozenCompIds)] : []));
    hintsRescaled = hintRes.changes;
  });
  try { tx(); }
  catch (e) {
    if (_lockedRaceLost) {
      return res.status(423).json({ error: "Question was locked while recalculating. Unlock it first and retry." });
    }
    throw e;
  }

  // v6.9.9: a recalc rewrites is_correct / points_delta on existing
  // submissions, so every leaderboard that aggregated those rows now
  // has stale cached totals. Find each affected competition and clear
  // its cache so the next /api/leaderboard call rebuilds from the
  // updated rows. Tasks can live in multiple competitions — invalidate
  // them all. No-op when nothing flipped (admin ran recalc idempotently
  // after an earlier run with the same rules in place).
  if (flipped > 0 || hintsRescaled > 0) {
    // v6.10.26: widened to cover hint_reveals writes too — every
    // competition this task lives in (via submissions OR hint_reveals)
    // needs its cache cleared.
    const affectedComps = db.prepare(
      `SELECT DISTINCT competition_id FROM (
         SELECT competition_id FROM submissions WHERE task_id=?
         UNION
         SELECT competition_id FROM hint_reveals WHERE task_id=?
       )`
    ).all(req.params.id, req.params.id);
    for (const { competition_id } of affectedComps) invalidateLeaderboardCache(competition_id);
    // v6.20.x — /api/me embeds the participant's live score, so a recalc that
    // rewrote their submissions/hint_reveals leaves their cached /api/me score
    // stale for up to 2s. Bust the per-user cache for every participant whose
    // rows this task touched, so "your score" matches the leaderboard immediately.
    const affectedUsers = db.prepare(
      `SELECT DISTINCT user_id FROM (
         SELECT user_id FROM submissions WHERE task_id=?
         UNION
         SELECT user_id FROM hint_reveals WHERE task_id=?
       )`
    ).all(req.params.id, req.params.id);
    for (const { user_id } of affectedUsers) _invalidateMeCache(user_id);
  }

  // v8.1.0 — WHO DID THIS RECALCULATE STRAND?
  //
  // A recalculate can flip a correct row to incorrect. On a CAPPED challenge that
  // leaves a participant holding N attempts, no correct submission, and no way
  // back — permanently exhausted through no action of their own, on a challenge
  // they had solved. Nothing on the admin's screen would say so: `flipped` counts
  // rows, and a row flipping is exactly what they asked for.
  //
  // Reported as a COUNT plus the NAMES, because the remedy is per-participant (the
  // grant endpoint) and a bare number would send the admin hunting. Computed
  // AFTER the write, against the state that now exists — a prediction made before
  // it would be a second implementation of the grading.
  //
  // v8.1.4 — SCOPED TO WHAT THIS RUN ACTUALLY CAUSED. The first version walked
  // every `competition_tasks` row for the challenge and every participant who had
  // ever submitted, so it reported the whole currently-exhausted-and-unsolved
  // population: participants in FROZEN competitions this same handler had just
  // refused to re-grade, participants nothing in this run had touched, and the
  // identical set again on a zero-flip re-run. A report that says the same thing
  // whether or not you did anything is not a report.
  //
  // The candidate set is the rows that flipped correct → INCORRECT. That is the
  // only direction that can strand: taking a correct submission away is what
  // leaves a capped participant with attempts spent and nothing to show. A flip
  // the other way can only un-strand.
  //
  // The frozen exclusion is STRUCTURAL rather than a second filter: `updates` is
  // derived from `subs`, which is `_allSubs` minus `_frozenSet`, so a frozen row
  // can never appear here. Re-filtering would be a guard the tests cannot
  // exercise (a comment claiming one is worse than neither).
  const strandedByRecalc = [];
  try {
    const capTask = db.prepare("SELECT id, attempt_cap FROM tasks WHERE id=?").get(task.id);
    const solvedStmt = db.prepare(
      "SELECT 1 FROM submissions WHERE user_id=? AND task_id=? AND competition_id=? AND is_correct=1"
    );
    const nickStmt = db.prepare("SELECT nickname, email FROM users WHERE id=?");
    const seen = new Set();
    for (const u of updates) {
      // `Number(...)` because `was_correct` is whatever the driver returned for a
      // stored boolean column, while `is_correct` is the 1/0 this handler just
      // computed — a strict compare across those two is how a scan quietly stops
      // matching anything.
      //
      // THIS LINE IS DEFENCE IN DEPTH, and says so rather than claiming a guard
      // the lock exercises (the PR 28 lesson). Measured: removing it leaves the
      // scoping test green, because `updates` holds only rows that CHANGED and
      // every other shape is already excluded downstream — a wrong→right flip and
      // a points-only change on a correct row both leave the participant holding a
      // correct submission, which the `solvedStmt` check below drops, and a
      // points-only change on an INCORRECT row cannot occur at all, since the
      // wrong-answer penalty does not vary with difficulty. It stays because the
      // scan's subject is what this run TOOK AWAY, and stating that in the
      // predicate is what stops the next person widening `updates` and silently
      // turning a causal report back into a census.
      if (!(Number(u.was_correct) === 1 && Number(u.is_correct) === 0)) continue;
      const pairKey = `${u.user_id}|${u.competition_id}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      const comp = getCompetition(u.competition_id);
      if (!comp || resolveAttemptCap(capTask, comp) === null) continue;
      if (solvedStmt.get(u.user_id, task.id, u.competition_id)) continue;
      const st = attemptState(u.user_id, capTask, comp);
      if (!st.exhausted) continue;
      const who = nickStmt.get(u.user_id) || {};
      strandedByRecalc.push({
        user_id: u.user_id, competition_id: u.competition_id,
        // The NAME, not just the id: the admin's next action is to find this
        // person and grant them an attempt, and an opaque uuid does not help
        // them do that (v7.21.2 — a counter with no human consumer is a defect).
        nickname: who.nickname || who.email || null,
        competition_name: comp.name || null,
      });
    }
  } catch (e) { log.error({ ...reqContext(req), err: e.message }, "attempt-cap strand scan failed"); }

  const adminId = getAdminIdentity(req);
  try {
    recordOrphanedAuditEvent("task", task.id, "scores_recalculated", adminId, {
      // v8.1.4 — the audit blob carries what the RESPONSE carries. The count alone
      // named nobody, so the forensic record of "this recalculate left people
      // stranded" could not be joined back to who had to be helped.
      ...(strandedByRecalc.length ? {
        attempts_exhausted_after: strandedByRecalc.length,
        attempts_exhausted_who: strandedByRecalc.slice(0, 50),
      } : {}),
      ...reqContext(req),
      title: task.title,
      total_submissions: total,
      flipped: flipped,
      // v7.21.2 — record the frozen-skip count alongside the post-filter total,
      // or the audit trail carries the same understatement the toast used to:
      // `total_submissions` is what was RE-GRADED, not the challenge's whole
      // submission population, so a forensic reader needs the skipped count to
      // reconstruct why a recalc on a finished event changed nothing.
      ...(frozenSkipped ? { frozen_skipped: frozenSkipped } : {}),
      ...(unresolved ? { unresolved_choice_submissions: unresolved } : {}),
      hints_rescaled: hintsRescaled,
      hint_cost: newHintCost,
    });
  } catch (e) { swallowed("challenges:recalculate-audit", e); }
  // v7.20.9 (F2) — `unresolved` names the choice submissions that were left
  // untouched because their selection could not be recovered (pre-v7.20.9 rows
  // whose option text has since been edited). Reporting it is the honest half
  // of not guessing: a silent skip would read as "nothing needed changing".
  if (flipped > 0) _queueCompleters(req.params.id, null, _solvedBefore);
  res.json({ ok: true, total_submissions: total, flipped, hints_rescaled: hintsRescaled, unresolved, frozen_skipped: frozenSkipped,
    attempts_exhausted_after: strandedByRecalc.length, attempts_exhausted_who: strandedByRecalc.slice(0, 50), task_id: task.id });
});

// ═══════════════════════════════════════════════════════════════════════════
//   Task attachments
// ───────────────────────────────────────────────────────────────────────────
// Admin-uploaded .zip files that participants can download from the task
// detail page. Binaries live on disk at ./data/attachments/<uuid>.zip and are
// streamed via res.sendFile so neither the upload nor the download path ever
// buffers a full 64 MB archive through Node.
//
// Remove-from-challenge is a SOFT DELETE (detached_at flag) so a later
// version-history restore brings back both the display name AND the binary.
// Physical unlink happens only when the parent task is hard-deleted.
//
// Create flow uses a separate staging area (task_attachments_staging): an
// admin uploading attachments into a brand-new challenge writes them to
// staging first, and only on Save (POST /api/admin/tasks) are they promoted
// into task_attachments. Abandoned drafts are cleaned up by the boot + 10-min
// periodic sweeps (see _sweepStagingAttachments).
// ═══════════════════════════════════════════════════════════════════════════

// _unlinkAttachmentTempSync / _streamSha256 / _attachmentValidationMessage /
// _slugForDownload / _checkAttachmentStorageBudget now live in lib/attachments.js
// (imported at the top of this file).

// List attachments on a task (admin view).
app.get("/api/admin/tasks/:id/attachments", requireAdmin, (req, res) => {
  // v8.7.0 — visibility, not ownership: the list of a challenge's supporting
  // files is part of reading the challenge, which a public-domain tag or a
  // shared event already grants.
  {
    const t = db.prepare("SELECT id, created_by_id FROM tasks WHERE id=?").get(req.params.id);
    const denied = taskViewDenied(req, t);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  const rows = db.prepare(
    "SELECT id, display_name, original_name, size_bytes, created_at, created_by, order_idx " +
    "FROM task_attachments WHERE task_id=? AND detached_at IS NULL ORDER BY order_idx, created_at"
  ).all(req.params.id);
  res.json(rows);
});

// Upload an attachment directly onto an existing task (edit-flow path).
// CSRF runs BEFORE multer (per repo convention: see POST /api/tasks/:id/submit)
// so a forged request can't write a temp file to disk.
app.post("/api/admin/tasks/:id/attachments",
  requireAdmin, csrfProtection, rateLimit(60_000, 30, "admin-attach-upload"),
  // ext-audit v7.15.13 — refuse on the declared size BEFORE multer writes the
  // body to disk; the real enforcement is still the post-multer reservation.
  preflightAttachmentBudget(getAdminIdentity),
  uploadAttachment.single("file"),
  async (req, res) => {
    let _release = null;                       // set once the budget slot is reserved
    try {
      const task = db.prepare("SELECT id, locked, created_by_id FROM tasks WHERE id=?").get(req.params.id);
      if (!task) { _unlinkAttachmentTempSync(req.file?.path); return res.status(404).json({ error: "Question not found" }); }
      // v8.12.0 — the competitor lock, unlinking the temp file like its neighbours.
      {
        const _cmpDenied = competitorTaskEditDenied(db, competitorIds(req), req.params.id);
        if (_cmpDenied) { _unlinkAttachmentTempSync(req.file?.path); return refuseCompetitor(res, _cmpDenied); }
      }
      // v8.7.0 — attachments are content, so this is the cosmetic (owner-only)
      // gate. It unlinks the multer temp file on the way out exactly as the 404
      // and locked branches either side of it do: multer has already written the
      // body by the time any handler runs, so "leave nothing behind" means
      // reclaiming it here rather than refusing earlier.
      {
        const denied = taskEditDenied(req, task);
        if (denied) { _unlinkAttachmentTempSync(req.file?.path); return res.status(403).json({ error: denied.message, code: denied.code }); }
      }
      if (task.locked) { _unlinkAttachmentTempSync(req.file?.path); return res.status(403).json({ error: "Question is locked." }); }
      if (!req.file) return res.status(400).json({ error: "No file uploaded." });
      // ext-audit v7.15.12 — the DIRECT (edit-flow) upload had no in-flight
      // accounting at all: only staging reserved. Concurrent direct uploads
      // could therefore fill the upload filesystem while every request saw the
      // same pre-upload free-space reading. Same synchronous reservation as
      // staging; released in the finally below.
      // ext-audit v7.15.15 — swap the preflight's declared-size reservation for a
      // real-size one. Release FIRST, then reserve, with no await between: JS is
      // single-threaded and the server is single-process (the invariant this
      // module already relies on), so the pair is atomic and nothing can observe
      // the gap. Reserving before releasing would double-count — harmless for
      // bytes, but it consumes two slots of the per-admin ROW limit and rejects
      // the 19th of 20 legitimate uploads.
      if (req._attachPreflightRelease) { try { req._attachPreflightRelease(); } catch (e) { swallowed("challenges:attach-preflight-release", e); } }
      const _dirRes = reserveAttachmentBudget(getAdminIdentity(req), req.file.size);
      if (!_dirRes.ok) {
        _unlinkAttachmentTempSync(req.file.path);
        return res.status(_dirRes.status).json({ error: _dirRes.error });
      }
      _release = _dirRes.release;
      // v6.13.18 — disk-floor check. The per-admin staging row + byte
      // quotas don't apply on the direct route (uploads land in
      // task_attachments, not task_attachments_staging), but the disk
      // volume is shared, so a low-disk reject still has to fire here.
      {
        const disk = _freeSpaceBytes(DATA_DIR);
        if (disk && disk.free < ATTACHMENT_FREE_DISK_MIN_BYTES) {
          _unlinkAttachmentTempSync(req.file.path);
          return res.status(507).json({ error: "Server storage is too low to accept new uploads. Try again later." });
        }
      }

      const rawName = ((typeof req.body.display_name === "string" && req.body.display_name) || req.file.originalname || "").trim();
      const displayName = rawName.replace(/\.zip$/i, "").slice(0, 200) || "attachment";
      if (!displayName) { _unlinkAttachmentTempSync(req.file.path); return res.status(400).json({ error: "Display name is required." }); }

      const srcAbs = path.join(UPLOADS_DIR, path.basename(req.file.path));
      try { await validateUnencryptedZip(srcAbs); }
      catch (e) {
        _unlinkAttachmentTempSync(req.file.path);
        return res.status(400).json({ error: _attachmentValidationMessage(e.code) });
      }

      const sha256 = await _streamSha256(srcAbs);
      const attId = uuid();
      const finalRel = path.posix.join("attachments", `${attId}.zip`);
      const finalAbs = path.join(DATA_DIR, finalRel);
      try { await fs.promises.rename(srcAbs, finalAbs); }
      catch (renameErr) {
        if (renameErr.code === "EXDEV") {
          await fs.promises.copyFile(srcAbs, finalAbs);
          try { await fs.promises.unlink(srcAbs); } catch (unlinkErr) { swallowed("challenges:attach-unlink-copied-source", unlinkErr); }
        } else {
          _unlinkAttachmentTempSync(req.file.path);
          throw renameErr;
        }
      }

      // v6.13.19 — count + dupe + insert under a single writer txn so
      // two concurrent uploads can't both pass the count<10 check and
      // leave the table at 11+. The UNIQUE index on
      // (task_id, LOWER(display_name)) WHERE detached_at IS NULL
      // (db.js:284) covers the dupe-name race authoritatively; we still
      // SELECT first to return a clean 409 instead of a generic 500.
      // On any txn failure (cap exceeded, dupe race lost at INSERT,
      // I/O hiccup), the moved file at finalAbs is unlinked — pre-fix
      // the catch block only cleared the multer temp path so the
      // promoted file leaked.
      // v8.12.6 — test-only park before the commit-time re-check (lib/middleware.js).
      await testAdminCommitPark();
      const nowIso = new Date().toISOString();
      let txnResult;
      try {
        const insertTxn = db.transaction(() => {
          // v8.12.6 (external audit F1) — THE ACTING ADMIN, re-asked at commit.
          // requireAdmin ran when the headers arrived; multer, the ZIP walk, the
          // hash and the move have all happened since, and a colleague can block,
          // demote or delete the admin inside any of them. First statement, so it
          // precedes every question below and the write.
          {
            const _authz = adminAuthzDenied(req);
            if (_authz) { const { status, ...body } = _authz; return { reject: status, body }; }
          }
          // v8.12.6 — AND EVERYTHING ELSE THAT WINDOW CAN INVALIDATE (v7.21.1 A5).
          // The competitor lock and the owner gate were both asked after multer but
          // BEFORE the validate/hash/move awaits, and never again: a colleague who
          // assigns this challenge to a compete event the uploader competes in
          // lands an attachment on the uploader's own board, and an out-of-band
          // narrowing to event_admin (an import overwrite, SQL — neither
          // tombstones the session, and the predicate above admits the tier) would
          // otherwise still write to a challenge they do not own. The role is read
          // FRESH for the owner question: `_cachedRole`'s 2 s window is exactly
          // the one a narrowing lands in.
          {
            const _cmp = competitorTaskEditDenied(db, competitorIds(req), task.id);
            if (_cmp) return { reject: 403, body: { error: _cmp.message, code: _cmp.code, competitionId: _cmp.competitionId || null, competitionName: _cmp.competitionName || null } };
            // Guarded: with no id (the built-in superadmin) the invalidator clears
            // EVERY actor's cache, which is a different operation entirely.
            { const _me = actorId(req); if (_me) invalidateEventAdminScope(_me); }
            const _own = taskEditDenied(req, task);
            if (_own) return { reject: 403, body: { error: _own.message, code: _own.code } };
          }
          // v7.7.5 (ext-audit F5) — re-check the lock INSIDE the txn. The lock was
          // checked before the (slow) ZIP-validate + hash + file-move; an admin can
          // lock the task during that window. Re-reading the committed row here
          // closes the TOCTOU so a locked task can never gain an attachment.
          const fresh = db.prepare("SELECT locked FROM tasks WHERE id=?").get(task.id);
          if (fresh && fresh.locked) return { reject: 403, msg: "Question is locked." };
          const c = db.prepare(
            "SELECT COUNT(*) AS c FROM task_attachments WHERE task_id=? AND detached_at IS NULL"
          ).get(task.id).c;
          if (c >= ATTACHMENT_MAX_PER_TASK) return { reject: 409, msg: `Maximum ${ATTACHMENT_MAX_PER_TASK} attachments per question.` };
          const dupe = db.prepare(
            "SELECT 1 FROM task_attachments WHERE task_id=? AND detached_at IS NULL AND LOWER(display_name)=LOWER(?)"
          ).get(task.id, displayName);
          if (dupe) return { reject: 409, msg: "An attachment with that display name already exists." };
          const maxIdx = db.prepare(
            "SELECT COALESCE(MAX(order_idx), -1) AS m FROM task_attachments WHERE task_id=?"
          ).get(task.id).m;
          db.prepare(
            "INSERT INTO task_attachments (id, task_id, display_name, original_name, size_bytes, sha256, storage_path, created_at, created_by, order_idx) " +
            "VALUES (?,?,?,?,?,?,?,?,?,?)"
          ).run(attId, task.id, displayName, req.file.originalname || "", req.file.size, sha256, finalRel, nowIso, getAdminIdentity(req), maxIdx + 1);
          return { ok: true };
        });
        txnResult = insertTxn();
      } catch (e) {
        try { await fs.promises.unlink(finalAbs); } catch (unlinkErr) { swallowed("challenges:attach-unlink-after-txn-error", unlinkErr); }
        if (e && /UNIQUE/i.test(e.message || "")) {
          return res.status(409).json({ error: "An attachment with that display name already exists." });
        }
        throw e;
      }
      if (txnResult.reject) {
        try { await fs.promises.unlink(finalAbs); } catch (unlinkErr) { swallowed("challenges:attach-unlink-after-refusal", unlinkErr); }
        // v8.12.6 — a refusal that carries a `code` (and, for the impersonation
        // seat, a `reason`) is sent whole, or a client branching on it sees none.
        return res.status(txnResult.reject).json(txnResult.body || { error: txnResult.msg });
      }

      // v6.13.11 — no task_versions snapshot here; see recordTaskAuditEvent.
      // The next Save (PUT /api/admin/tasks/:id) will snapshot the current
      // attachment set along with any other field edits.
      recordTaskAuditEvent(task.id, getAdminIdentity(req), "attachment_added", {
        ...reqContext(req),
        change_type: "attachment_added",
        attachment: { id: attId, display_name: displayName, original_name: req.file.originalname || "", size_bytes: req.file.size },
      });
      res.json({ id: attId, display_name: displayName, original_name: req.file.originalname || "", size_bytes: req.file.size, created_at: nowIso });
    } catch (e) {
      _unlinkAttachmentTempSync(req.file?.path);
      log.error({ ...reqContext(req), tag: "attachments", err: e && e.message }, "[attachments] upload failed");
      res.status(500).json({ error: "Upload failed." });
    } finally {
      // Release the in-flight reservation on EVERY exit path (idempotent).
      if (_release) _release();
    }
  }
);

// Rename an attachment's display_name (edit the label, not the file).
app.patch("/api/admin/tasks/:id/attachments/:aid", requireAdmin, csrfProtection, (req, res) => {
  const task = db.prepare("SELECT id, locked, created_by_id FROM tasks WHERE id=?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Question not found" });
  // v8.12.0 — a competitor may not change a challenge held by the event they
  // compete in. Above the seal and the tier gate, for the reason the seal sits
  // above the tier gate: it binds every tier, so answering another question
  // first would hand a superadmin a different reason for the same refusal.
  { const _cmp = refuseCompetitor(res, competitorTaskEditDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  {   // v8.7.0 — renaming an attachment is a content edit: owner-only.
    const denied = taskEditDenied(req, task);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  if (task.locked) return res.status(403).json({ error: "Question is locked." });
  const att = db.prepare(
    "SELECT id, display_name FROM task_attachments WHERE id=? AND task_id=? AND detached_at IS NULL"
  ).get(req.params.aid, task.id);
  if (!att) return res.status(404).json({ error: "Attachment not found" });

  if (req.body.display_name != null && typeof req.body.display_name !== "string") return res.status(400).json({ error: "Display name must be text." });
  const newName = (req.body.display_name || "").trim().replace(/\.zip$/i, "").slice(0, 200);
  if (!newName) return res.status(400).json({ error: "Display name is required." });
  if (newName === att.display_name) return res.json({ ok: true });
  const dupe = db.prepare(
    "SELECT 1 FROM task_attachments WHERE task_id=? AND detached_at IS NULL AND LOWER(display_name)=LOWER(?) AND id<>?"
  ).get(task.id, newName, att.id);
  if (dupe) return res.status(409).json({ error: "An attachment with that display name already exists." });
  db.prepare("UPDATE task_attachments SET display_name=? WHERE id=?").run(newName, att.id);
  // v6.13.11 — audit-only: rename doesn't create a task_versions snapshot.
  recordTaskAuditEvent(task.id, getAdminIdentity(req), "attachment_renamed", {
    ...reqContext(req),
    change_type: "attachment_renamed",
    attachment_id: att.id, changes: { display_name: { from: att.display_name, to: newName } },
  });
  res.json({ ok: true });
});

// Soft-detach an attachment from a task. Row + binary survive so restore
// to an earlier version can bring the attachment back in full.
app.delete("/api/admin/tasks/:id/attachments/:aid", requireAdmin, csrfProtection, (req, res) => {
  const task = db.prepare("SELECT id, locked, created_by_id FROM tasks WHERE id=?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Question not found" });
  // v8.12.0 — a competitor may not change a challenge held by the event they
  // compete in. Above the seal and the tier gate, for the reason the seal sits
  // above the tier gate: it binds every tier, so answering another question
  // first would hand a superadmin a different reason for the same refusal.
  { const _cmp = refuseCompetitor(res, competitorTaskEditDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  {   // v8.7.0 — detaching an attachment is a content edit: owner-only.
    const denied = taskEditDenied(req, task);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  if (task.locked) return res.status(403).json({ error: "Question is locked." });
  const att = db.prepare(
    "SELECT id, display_name FROM task_attachments WHERE id=? AND task_id=? AND detached_at IS NULL"
  ).get(req.params.aid, task.id);
  if (!att) return res.status(404).json({ error: "Attachment not found" });
  db.prepare("UPDATE task_attachments SET detached_at=? WHERE id=?").run(new Date().toISOString(), att.id);
  // v6.13.11 — audit-only: delete doesn't create a task_versions snapshot.
  // The next Save's snapshot will omit this attachment from the
  // restorable set; the row still lives in task_attachments with
  // detached_at set so a restore of an earlier snapshot can re-link
  // the original binary + display_name.
  recordTaskAuditEvent(task.id, getAdminIdentity(req), "attachment_removed", {
    ...reqContext(req),
    change_type: "attachment_removed",
    attachment: { id: att.id, display_name: att.display_name },
  });
  res.json({ ok: true });
});

// ─── Staging (create-flow uploads, promoted atomically in POST /api/admin/tasks) ──

app.post("/api/admin/attachment-staging",
  requireAdmin, csrfProtection, rateLimit(60_000, 30, "admin-attach-upload"),
  preflightAttachmentBudget(getAdminIdentity),
  uploadAttachment.single("file"),
  async (req, res) => {
    let _release = null;                       // set once the budget slot is reserved
    // v8.12.6 — DECLARED OUTSIDE THE `try`, and that is the whole of a fix. It sat
    // inside the try block from v8.3.17 onward, so the catch's `if (_movedAbs)`
    // threw a ReferenceError from inside the catch itself: the moved ZIP was
    // stranded in attachments-staging/, the route's own "Upload failed." and its
    // log line never happened, and the global error handler answered a generic
    // 500 instead (measured with an ABORT trigger on the staging INSERT). The
    // v8.3.17 staging-twin cleanup described below had therefore never run once.
    let _movedAbs = null;
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded." });
      // v6.13.18 — quota + disk check after multer (need file size for the
      // bytes branch). Cleanup the temp file on rejection so a denied upload
      // doesn't pad the very budget that just rejected it.
      // ext-audit v7.15.11 — RESERVE the slot atomically instead of checking and
      // hoping. The old check read committed COUNT/SUM, then this handler did ZIP
      // validation + sha256 + rename (all async) before inserting, so N
      // concurrent uploads all passed the same check against the same state (30
      // simultaneous uploads produced 30 rows against a limit of 20). The
      // reservation accounts for in-flight bytes and is released in the finally
      // below — once the row is inserted, the DB row accounts for it instead.
      // ext-audit v7.15.15 — release-then-reserve, synchronously (see the
      // direct-upload route above for why the pair is atomic).
      if (req._attachPreflightRelease) { try { req._attachPreflightRelease(); } catch (e) { swallowed("challenges:staging-preflight-release", e); } }
      const _reservation = reserveAttachmentBudget(getAdminIdentity(req), req.file.size);
      if (!_reservation.ok) {
        _unlinkAttachmentTempSync(req.file.path);
        return res.status(_reservation.status).json({ error: _reservation.error });
      }
      _release = _reservation.release;
      const rawName = ((typeof req.body.display_name === "string" && req.body.display_name) || req.file.originalname || "").trim();
      const displayName = rawName.replace(/\.zip$/i, "").slice(0, 200) || "attachment";
      const srcAbs = path.join(UPLOADS_DIR, path.basename(req.file.path));
      try { await validateUnencryptedZip(srcAbs); }
      catch (e) {
        _unlinkAttachmentTempSync(req.file.path);
        return res.status(400).json({ error: _attachmentValidationMessage(e.code) });
      }
      const sha256 = await _streamSha256(srcAbs);
      const stagingId = uuid();
      const finalRel = path.posix.join("attachments-staging", `${stagingId}.zip`);
      const finalAbs = path.join(DATA_DIR, finalRel);
      // v8.3.17 (external audit) — REMEMBER THAT THE FILE HAS MOVED, exactly as
      // the direct-upload path a few hundred lines above already does ("pre-fix
      // the catch block only cleared the multer temp path so the promoted file
      // leaked"). That fix never reached this twin. From the rename below until
      // the INSERT commits the bytes live at `finalAbs` and `req.file.path` no
      // longer exists, so the catch's `_unlinkAttachmentTempSync(req.file?.path)`
      // unlinked nothing and stranded a ZIP of up to 64 MB with no row to
      // reclaim it — recovered only by the boot sweep.
      // (v8.12.6 — CORRECTION: until v8.12.6 this cleanup never ran. The
      // declaration it needs sat inside the try, so the catch threw instead; see
      // the hoist at the top of the handler.)
      try { await fs.promises.rename(srcAbs, finalAbs); _movedAbs = finalAbs; }
      catch (renameErr) {
        if (renameErr.code === "EXDEV") {
          await fs.promises.copyFile(srcAbs, finalAbs);
          _movedAbs = finalAbs;
          try { await fs.promises.unlink(srcAbs); } catch (unlinkErr) { swallowed("challenges:staging-unlink-copied-source", unlinkErr); }
        } else { _unlinkAttachmentTempSync(req.file.path); throw renameErr; }
      }
      // v8.12.6 — test-only park before the commit-time re-check (lib/middleware.js).
      await testAdminCommitPark();
      // v8.12.6 (external audit F1) — the acting admin, re-asked after the LAST
      // await and before the INSERT, with nothing awaited between: on a
      // single-process synchronous driver that is atomic with the write. The file
      // has already MOVED, so it is reclaimed from where it now is. A staged row
      // is invisible to participants and promoted only through a fresh
      // requireAdmin, so the low stakes are the budget it would hold (up to 64 MB
      // on the backed-up volume) and an `attachment_staged` record in the name of
      // a revoked account.
      {
        const _authz = adminAuthzDenied(req);
        if (_authz) {
          try { fs.unlinkSync(_movedAbs); } catch (unlinkErr) { swallowed("challenges:staging-unlink-after-authz", unlinkErr); }
          _movedAbs = null;
          const { status, ...body } = _authz;
          return res.status(status).json(body);
        }
      }
      const nowIso = new Date().toISOString();
      const adminId = getAdminIdentity(req);
      db.prepare(
        "INSERT INTO task_attachments_staging (id, admin_id, display_name, original_name, size_bytes, sha256, storage_path, created_at) VALUES (?,?,?,?,?,?,?,?)"
      ).run(stagingId, adminId, displayName, req.file.originalname || "", req.file.size, sha256, finalRel, nowIso);
      // The committed row owns the file from here: nothing below may unlink it.
      _movedAbs = null;
      // v6.16.39 — audit row for the file-state mutation. Pre-fix the
      // staging upload had zero forensic trail; an admin uploading a
      // 50 MB blob to staging only surfaced indirectly via the staging
      // quota counter. Now it lands as `attachment:<stagingId>:staged`
      // alongside the existing `attachment_added` rows that fire when
      // staging promotes into `task_attachments`.
      try {
        recordOrphanedAuditEvent("attachment", stagingId, "attachment_staged", adminId, {
          display_name: displayName,
          original_name: req.file.originalname || "",
          size_bytes: req.file.size,
          sha256,
          ...reqContext(req),
        });
      } catch (auditErr) {
        // audit failures never break the upload response
        swallowed("challenges:staging-upload-audit", auditErr);
      }
      res.json({ staging_id: stagingId, display_name: displayName, original_name: req.file.originalname || "", size_bytes: req.file.size });
    } catch (e) {
      _unlinkAttachmentTempSync(req.file?.path);
      // A file that already MOVED is not at req.file.path any more.
      if (_movedAbs) { try { fs.unlinkSync(_movedAbs); } catch (unlinkErr) { swallowed("challenges:staging-unlink-after-error", unlinkErr); } }
      log.error({ ...reqContext(req), tag: "attachments", err: e && e.message }, "[attachments] staging upload failed");
      res.status(500).json({ error: "Upload failed." });
    } finally {
      // Release the in-flight reservation on EVERY exit path. On success the
      // committed staging row now accounts for the file; on failure nothing
      // should. release() is idempotent, so this cannot under-count.
      if (_release) _release();
    }
  }
);

app.patch("/api/admin/attachment-staging/:id", requireAdmin, csrfProtection, (req, res) => {
  const adminId = getAdminIdentity(req);
  const row = db.prepare(
    "SELECT id, display_name FROM task_attachments_staging WHERE id=? AND admin_id=?"
  ).get(req.params.id, adminId);
  if (!row) return res.status(404).json({ error: "Staged attachment not found" });
  if (req.body.display_name != null && typeof req.body.display_name !== "string") return res.status(400).json({ error: "Display name must be text." });
  const newName = (req.body.display_name || "").trim().replace(/\.zip$/i, "").slice(0, 200);
  if (!newName) return res.status(400).json({ error: "Display name is required." });
  db.prepare("UPDATE task_attachments_staging SET display_name=? WHERE id=?").run(newName, row.id);
  // v6.16.39 — audit the rename so an operator can reconstruct
  // display-name churn in the staging area. Symmetric with the
  // attachment_renamed row that fires for promoted attachments.
  try {
    recordOrphanedAuditEvent("attachment", row.id, "attachment_staging_renamed", adminId, {
      from_name: row.display_name,
      to_name: newName,
      ...reqContext(req),
    });
  } catch (e) {
    // audit failures never break the rename
    swallowed("challenges:staging-rename-audit", e);
  }
  res.json({ ok: true });
});

app.delete("/api/admin/attachment-staging/:id", requireAdmin, csrfProtection, (req, res) => {
  const adminId = getAdminIdentity(req);
  const row = db.prepare(
    "SELECT id, display_name, storage_path, size_bytes FROM task_attachments_staging WHERE id=? AND admin_id=?"
  ).get(req.params.id, adminId);
  if (!row) return res.status(404).json({ error: "Staged attachment not found" });
  db.prepare("DELETE FROM task_attachments_staging WHERE id=?").run(row.id);
  try {
    const _base = path.resolve(DATA_DIR);
    const abs = path.resolve(path.join(DATA_DIR, String(row.storage_path || "")));
    if (abs.startsWith(_base + path.sep)) fs.unlinkSync(abs);
  } catch (e) { swallowed("challenges:staging-discard-unlink", e); }
  // v6.16.39 — audit the discard. Without this row the staging
  // file's existence is invisible after deletion: the upload event
  // (now also added in v6.16.39) is the only other anchor.
  try {
    recordOrphanedAuditEvent("attachment", row.id, "attachment_staging_discarded", adminId, {
      display_name: row.display_name,
      size_bytes: row.size_bytes,
      ...reqContext(req),
    });
  } catch (e) {
    // audit failures never break the delete
    swallowed("challenges:staging-discard-audit", e);
  }
  res.json({ ok: true });
});

// ─── Downloads ──────────────────────────────────────────────────────────────
// Participants fetch through the task route (competition-scoped). Admins
// have a parallel route so they can preview a challenge's attachment without
// entering a competition scope. Both stream via res.sendFile — zero-copy on
// Linux via sendfile(2).

app.get("/api/tasks/:taskId/attachments/:aid",
  requireParticipant, requireCompetitionContext, requireParticipantInCompetition, _resolveEventTaskForAttachment,
  rateLimit(60_000, 120, "attach-dl"),
  (req, res) => {
    const compId = req.session.competitionId;
    // v6.20.x — block attachment downloads before the participant's window is
    // live, mirroring the task read routes. 404 (not 403) keeps parity with the
    // route's existing "not found" responses and leaks nothing about timing.
    if (participantContentNotStarted(req)) return res.status(404).end();
    const inComp = db.prepare(
      "SELECT 1 FROM competition_tasks WHERE competition_id=? AND task_id=?"
    ).get(compId, req.params.taskId);
    if (!inComp) return res.status(404).end();
    const task = db.prepare("SELECT id, active, status FROM tasks WHERE id=?").get(req.params.taskId);
    if (!task || !task.active || task.status !== "published") return res.status(404).end();
    let att = db.prepare(
      "SELECT id, display_name, storage_path FROM task_attachments WHERE id=? AND task_id=? AND detached_at IS NULL"
    ).get(req.params.aid, task.id);
    // A BANK question's attachment id, named for the event's own copy (a link or
    // tab from before the copy, lib/event-copies.js): the copy's own row naming
    // the same file answers, while the copy still shows it. Only the attachments
    // of the bank question THIS copy came from are looked up.
    if (!att) {
      const _src = db.prepare(
        "SELECT a.storage_path FROM task_attachments a JOIN tasks t ON t.copied_from_task_id = a.task_id WHERE a.id=? AND t.id=? AND t.owner_competition_id=?"
      ).get(req.params.aid, task.id, compId);
      if (_src) {
        att = db.prepare(
          "SELECT id, display_name, storage_path FROM task_attachments WHERE task_id=? AND storage_path=? AND detached_at IS NULL ORDER BY order_idx, created_at LIMIT 1"
        ).get(task.id, _src.storage_path);
      }
    }
    if (!att) return res.status(404).end();
    const _base = path.resolve(DATA_DIR);
    const abs = path.resolve(path.join(DATA_DIR, String(att.storage_path || "")));
    if (!abs.startsWith(_base + path.sep)) return res.status(404).end();
    res.set("Content-Type", "application/zip");
    res.set("Cache-Control", "private, max-age=3600");
    res.set("Content-Disposition", `attachment; filename="${_slugForDownload(att.display_name)}.zip"`);
    res.sendFile(abs, err => { if (err && !res.headersSent) res.status(404).end(); });
  }
);

app.get("/api/admin/tasks/:taskId/attachments/:aid",
  requireAdmin, rateLimit(60_000, 60, "admin-attach-dl"),
  (req, res) => {
    // v8.7.0 — visibility. This route exists so an admin can preview a
    // challenge's attachment without entering a competition scope, which is
    // exactly why it needs one of its own now. It answers 403 rather than the
    // route's usual bare 404 because a refusal about the ACTOR should say so —
    // the 404s here are about the file, and an event admin told "not found"
    // about a colleague's challenge would go looking for a broken upload.
    {
      const t = db.prepare("SELECT id, created_by_id FROM tasks WHERE id=?").get(req.params.taskId);
      const denied = taskViewDenied(req, t);
      if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    }
    const att = db.prepare(
      "SELECT id, display_name, storage_path FROM task_attachments WHERE id=? AND task_id=? AND detached_at IS NULL"
    ).get(req.params.aid, req.params.taskId);
    if (!att) return res.status(404).end();
    const _base = path.resolve(DATA_DIR);
    const abs = path.resolve(path.join(DATA_DIR, String(att.storage_path || "")));
    if (!abs.startsWith(_base + path.sep)) return res.status(404).end();
    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", `attachment; filename="${_slugForDownload(att.display_name)}.zip"`);
    res.sendFile(abs, err => { if (err && !res.headersSent) res.status(404).end(); });
  }
);

app.get("/api/admin/tasks/:id/feedback", requireAdmin, (req, res) => {
  // v8.7.0 — visibility, and it matters more than the other read routes: the
  // rows carry each rater's name and EMAIL, so an unscoped read here is a
  // participant-directory leak keyed on a challenge id.
  {
    const t = db.prepare("SELECT id, created_by_id FROM tasks WHERE id=?").get(req.params.id);
    const denied = taskViewDenied(req, t);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  // v8.8.4 — AND THE RATERS, which the gate above does not cover. taskViewDenied
  // answers "may you open this challenge"; it says nothing about who rated it,
  // and `task_feedback` carries no competition_id, so the join was unfiltered
  // over the whole users table. Measured: an event admin read the name, nickname
  // and EMAIL of participants enrolled only in events they do not run — worst for
  // a ZERO-GRANT organiser, who through the shared pool reached every rater on the
  // platform. The comment above named this exact risk ("a participant-directory
  // leak keyed on a challenge id") and then closed only the challenge half of it.
  const _rvis = participantVisibilityScope(req, "u");
  const rows = db.prepare(
    `SELECT f.user_id, f.rating, f.updated_at, u.first_name, u.last_name, u.email, u.nickname
     FROM task_feedback f JOIN users u ON u.id = f.user_id
     WHERE f.task_id = ?${_rvis.clause} ORDER BY f.updated_at DESC`
  ).all(req.params.id, ..._rvis.params);
  res.json(rows);
});

app.delete("/api/admin/tasks/:id/feedback", requireAdmin, requireSuperAdmin, csrfProtection, (req, res) => {
  const task = db.prepare("SELECT id, title, created_by_id FROM tasks WHERE id=?").get(req.params.id);
  // v8.12.0 — a superadmin competing in an event that holds this challenge may
  // not purge the feedback left on it (every mutating door, every tier).
  { const _cmp = refuseCompetitor(res, competitorTaskEditDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  // A role scoped to its events reaches this route by its permission; the
  // feedback comes from every event holding the challenge, so it is purged only
  // as the strict scoring gate allows (its own, every holding event in scope).
  { const denied = taskScoringEditDenied(req, task); if (denied) return res.status(403).json({ error: denied.message, code: denied.code }); }
  const adminId = getAdminIdentity(req);
  // Snapshot affected users so each one gets an individual audit row, then purge.
  const affected = db.prepare("SELECT user_id, rating FROM task_feedback WHERE task_id=?").all(req.params.id);
  const result = db.prepare("DELETE FROM task_feedback WHERE task_id=?").run(req.params.id);
  for (const row of affected) {
    try { recordUserEvent(row.user_id, "feedback_removed", adminId, { task_id: req.params.id, task_title: task?.title || null, rating: row.rating, via: "bulk_purge", ...reqContext(req) }); } catch (e) { swallowed("challenges:feedback-purge-user-audit", e); }
  }
  // Task-scope summary row so the bulk op is a single entry in the challenge's
  // own history dialog (per-user rows go to each participant's history).
  try { recordOrphanedAuditEvent("task", req.params.id, "feedback_purged", adminId, { ...reqContext(req), title: task?.title || null, count: result.changes }); } catch (e) { swallowed("challenges:feedback-purge-audit", e); }
  res.json({ ok: true, deleted: result.changes });
});

app.delete("/api/admin/tasks/:id/feedback/:userId", requireAdmin, requireSuperAdmin, csrfProtection, (req, res) => {
  const task = db.prepare("SELECT id, title, created_by_id FROM tasks WHERE id=?").get(req.params.id);
  // v8.12.0 — as on the bulk purge above.
  { const _cmp = refuseCompetitor(res, competitorTaskEditDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  // A role scoped to its events reaches this route by its permission; the
  // feedback comes from every event holding the challenge, so it is purged only
  // as the strict scoring gate allows (its own, every holding event in scope).
  { const denied = taskScoringEditDenied(req, task); if (denied) return res.status(403).json({ error: denied.message, code: denied.code }); }
  const user = db.prepare("SELECT id, email, nickname FROM users WHERE id=?").get(req.params.userId);
  const prior = db.prepare("SELECT rating FROM task_feedback WHERE task_id=? AND user_id=?").get(req.params.id, req.params.userId);
  const result = db.prepare("DELETE FROM task_feedback WHERE task_id=? AND user_id=?").run(req.params.id, req.params.userId);
  if (!result.changes) return res.status(404).json({ error: "Feedback not found" });
  const adminId = getAdminIdentity(req);
  try { recordUserEvent(req.params.userId, "feedback_removed", adminId, { task_id: req.params.id, task_title: task?.title || null, rating: prior?.rating ?? null, nickname: user?.nickname || null, ...reqContext(req) }); } catch (e) { swallowed("challenges:feedback-remove-audit", e); }
  res.json({ ok: true });
});

// ── Task tags ───────────────────────────────────────────────────────────────

app.get("/api/admin/task-tags", requireAdmin, (req, res) => {
  // v8.7.0 — the tag VOCABULARY is derived from the challenges the actor can
  // see. Unnarrowed it is a read of every label on the platform, and task tags
  // are free text an admin types: ticket ids, customer names, author names. The
  // filter chips would also offer tags that match nothing in this actor's list,
  // which reads as a broken filter.
  //
  // The unscoped branch keeps the ORIGINAL query rather than taking an empty
  // splice through the JOIN: a JOIN drops a `task_tags` row whose task is gone,
  // which would be a different answer for a global admin (rule: do not change
  // behaviour for admin / superadmin).
  const _vis = _taskVisibilitySql(req, "t");
  const tags = _vis.clause
    ? db.prepare(`SELECT DISTINCT tt.tag FROM task_tags tt JOIN tasks t ON t.id = tt.task_id WHERE 1=1${_vis.clause} ORDER BY tt.tag`).all(..._vis.params).map(r => r.tag)
    : db.prepare("SELECT DISTINCT tag FROM task_tags ORDER BY tag").all().map(r => r.tag);
  res.json(tags);
});

app.post("/api/admin/tasks/:id/tags", requireAdmin, csrfProtection, (req, res) => {
  // batch 7 — boundary validation (see lib/validate.js); `tag` is validated here.
  const _v = validateBody(req.body, { tag: { type: "string", required: true, max: 50, label: "Tag" } });
  if (_v.error) return res.status(400).json({ error: _v.error });
  const tag = _v.values.tag;
  const task = db.prepare("SELECT id, title, answer_type, choices, created_by_id, answer_sealed, locked FROM tasks WHERE id=?").get(req.params.id);
  if (!task) return res.status(404).json({ error: "Question not found" });
  // v8.12.0 — a competitor may not change a challenge held by the event they
  // compete in. Above the seal and the tier gate, for the reason the seal sits
  // above the tier gate: it binds every tier, so answering another question
  // first would hand a superadmin a different reason for the same refusal.
  { const _cmp = refuseCompetitor(res, competitorTaskEditDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
  // v8.10.0 — the seal, above the tier gate, for the reason at the publish twin.
  // A tag is challenge content (the paragraph below says so), and the row already
  // withholds both `+ tag` and the per-tag `×` from a non-author.
  {
    const denied = sealedEditDenied(task, actingAdminId(req), sealRevealedFor(req, task.id));
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  // v8.7.0 — owner-only. A tag is challenge content (the `category:` convention
  // is participant-visible), and this is also the door onto the public-domain
  // tag itself: if anyone who could SEE a challenge could tag it, an event admin
  // could publish somebody else's challenge to every other event admin.
  {
    const denied = taskEditDenied(req, task);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  const cleaned = tag.toLowerCase();
  // v8.8.3 — A NEAR MISS OF THE RESERVED TAG IS REFUSED, NOT STORED.
  //
  // The visibility rule matches `public-domain` by exact equality in SQL, so
  // `public domain`, `public_domain`, any dash variant, an NBSP, a SOFT HYPHEN or a
  // ZERO-WIDTH SPACE were all accepted with 200, stored, rendered on the row as an
  // ordinary tag chip — and granted nothing. Accept-and-ignore: a control that
  // appears to work, which this codebase holds to be worse than no control. It was
  // reported twice, the second time AFTER v8.8.2 shipped the discovery chip, which
  // is the measurement saying discovery alone was not enough.
  //
  // THE GUARD IS HERE, AT THE ONE PATH A HUMAN TYPES INTO. The other two writers
  // are deliberately NOT guarded, and each is a decision rather than an omission:
  //   - version RESTORE (this file) replays a snapshot the platform itself wrote;
  //     refusing there would make an old version unrestorable over an inert label.
  //   - the task IMPORT (server.js `_applyImportedTaskTags`) is a migration tool, and
  //     its posture is that a bad value must not sink a 500-row file. Dropping the
  //     tag would be silent data loss on a file that may carry it descriptively.
  // Both are covered on screen instead: the challenge row marks a near-miss as
  // inert and offers to replace it (public/js/features/challenges-admin.js).
  if (publicDomainNearMiss(cleaned)) {
    return res.status(400).json({ error: PUBLIC_DOMAIN_NEAR_MISS_ERROR, code: "public_domain_near_miss" });
  }
  // Event team reports — `qualifying:<key>` moves the challenge out of scoring
  // and out of the finish count (lib/qualifying.js), so it is a SCORING change:
  // a malformed key is refused (it would never be read), and an ended session
  // freezes it like every other scoring field.
  if (cleaned.startsWith("qualifying:")) {
    // A SCORING change, so it takes the strict scoring gate (the owner, and every
    // event holding the challenge in the actor's scope), as publish and
    // visibility do: the owner gate above let an organiser who wrote a challenge
    // re-score, renumber and change the finish count of another organiser's
    // event that uses it.
    { const denied = taskScoringEditDenied(req, task); if (denied) return res.status(403).json({ error: _qualifyingScopeMessage(denied), code: denied.code }); }
    const _q = require("../lib/qualifying");
    if (!_q.qualifyingKeyOfTag(cleaned)) return res.status(400).json({ error: "A qualifying tag is qualifying:<key>, the key being 1–40 lowercase letters, digits, - or _.", code: "qualifying_tag_invalid" });
    { const _np = qualifyingNeedsPickOneDenied(task); if (_np) return res.status(400).json({ error: _np.message, code: _np.code }); }
    if (taskFrozenByEndedCompetition(req.params.id)) return res.status(409).json({ error: `Cannot make this a qualifying question — it is in an event with an ended session. ${FROZEN_REMEDY}`, code: "qualifying_tag_frozen" });
    // Becoming a qualifying question re-prices the answers already given (sweep
    // #91), which a lock forbids for every tier, as Recalculate's does. A
    // challenge already qualifying changes nothing and is not asked.
    if (task.locked && !_qualifyingNow(req.params.id)) return res.status(403).json({ error: QUALIFYING_LOCKED_ERROR, code: "challenge_locked" });
    // Operator ruling N7 (14 Nov 2026) — an event asks each qualifying question
    // once, so a key no event holding this challenge already has (a tag it
    // already carries changes nothing and is not asked about).
    if (!db.prepare("SELECT 1 FROM task_tags WHERE task_id=? AND tag=?").get(req.params.id, cleaned)) {
      const _key = _q.qualifyingKeyOfTag(cleaned);
      for (const _c of db.prepare("SELECT c.id, c.name FROM competition_tasks ct JOIN competitions c ON c.id=ct.competition_id WHERE ct.task_id=? ORDER BY c.name").all(req.params.id)) {
        const _dup = qualifyingKeyHeldDenied(db, _c, req.params.id, [_key]);
        if (_dup) {
          const _where = _heldTopicClause(req, _c, _dup);
          return res.status(409).json({ error: `${_where.charAt(0).toUpperCase()}${_where.slice(1)}. An event asks each one once, so this question cannot become a second one there: take it out of that event first, or use another key.`, code: _dup.code });
        }
      }
    }
  }
  // v8.1.0 (PR 30) — the other half of the reordering guard. A `needs:` tag is an
  // ordinary tag, so this is the one write path that can make an already-assigned
  // challenge unanswerable without touching the challenge's own columns.
  //
  // Checked against the PROSPECTIVE tag list (current + the new one), because the
  // question is whether the state AFTER the write is legal — asking about the
  // current list would always answer "fine" and never refuse anything.
  {
    const _next = db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(req.params.id).map(r => r.tag).concat(cleaned);
    const _unfit = taskConflictingEvent(db, req.params.id, task, _next);
    if (_unfit) return res.status(409).json({ error: _unfit.message, code: _unfit.code });
  }
  let inserted = false, _held = null;
  const _wasQualifying = _qualifyingNow(req.params.id);
  // A challenge becoming a qualifying question: its stored answers are re-scored
  // in the same transaction as the tag (sweep #91). A duplicate tag inserts nothing.
  const _flip = cleaned.startsWith("qualifying:") && !_wasQualifying;
  runTxnWithMirrorBuffer(() => db.transaction(() => {
    inserted = db.prepare("INSERT OR IGNORE INTO task_tags (task_id, tag) VALUES (?,?)").run(req.params.id, cleaned).changes > 0;
    if (!inserted) return;
    createTaskVersion(req.params.id, getAdminIdentity(req), "tag_added", null, { tag: cleaned, ...reqContext(req) });
    if (_flip) _held = _rescoreAfterQualifyingFlip(req, req.params.id, "qualifying_tag_added");
  })());
  if (inserted && cleaned.startsWith("qualifying:")) { _renumberAfterQualifyingChange(req.params.id); if (!_wasQualifying) _queueCompleters(req.params.id); }
  if (_held) _afterQualifyingFlip(_held);
  const tags = db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(req.params.id).map(r => r.tag);
  res.json({ ok: true, tags });
});

// Whether a challenge carries a `qualifying:` tag now (the tag doors' flip test).
function _qualifyingNow(taskId) {
  return !!db.prepare("SELECT 1 FROM task_tags WHERE task_id=? AND tag LIKE 'qualifying:%' LIMIT 1").get(taskId);
}
const QUALIFYING_LOCKED_ERROR = "Question is locked. Only a superadmin can unlock it, and it must be unlocked before it becomes, or stops being, a qualifying question: that re-prices the answers already given.";

// The qualifying-tag doors' scoring refusal names no event: the qualifying
// refusal names another organiser's event only to its organisers (operator ruling
// N7), and the same door must not tell through its other refusal what that one
// withholds. Every other refusal (the owner gate's) is passed through as worded.
function _qualifyingScopeMessage(denied) {
  return denied.code === "event_admin_scoring_locked"
    ? "This question is also used by an event you do not manage, so it cannot become, or stop being, a qualifying question here. Ask an administrator."
    : denied.message;
}

app.delete("/api/admin/tasks/:id/tags/:tag", requireAdmin, csrfProtection, (req, res) => {
  // v8.3.17 — `req.params` IS ALREADY DECODED. See the competition twin
  // (routes/competitions.js) for the two measured consequences. This one is the
  // sharpest of the three: a task tag carries the `category:` convention, which is
  // the ONLY task tag a participant ever sees.
  const tag = req.params.tag;
  let _locked = false;
  // v8.7.0 — owner-only, the mirror of the add. Untagging is the sharper half:
  // removing `public-domain` from a challenge somebody else shared would take it
  // away from every event admin using it, and removing a `needs:` tag changes
  // what the fit rules refuse.
  {
    const t = db.prepare("SELECT id, created_by_id, answer_sealed, locked FROM tasks WHERE id=?").get(req.params.id);
    // A missing challenge is a 404, as on the add twin; without it the seal
    // check below read `t.id` off undefined and answered a generic 500.
    if (!t) return res.status(404).json({ error: "Question not found" });
    _locked = !!t.locked;
    // v8.12.0 — the competitor lock first of all, for the reason at the publish twin.
    { const _cmp = refuseCompetitor(res, competitorTaskEditDenied(db, competitorIds(req), req.params.id)); if (_cmp) return _cmp; }
    // v8.10.0 — the seal first, for the reason at the publish twin.
    const sealDenied = sealedEditDenied(t, actingAdminId(req), sealRevealedFor(req, t.id));
    if (sealDenied) return res.status(403).json({ error: sealDenied.message, code: sealDenied.code });
    const denied = taskEditDenied(req, t);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    // Removing a qualifying tag is a SCORING change too (the challenge goes back
    // into the scoring and the finish count of every event holding it), so it
    // takes the strict scoring gate, as the add does.
    if (typeof tag === "string" && tag.toLowerCase().startsWith("qualifying:")) {
      const sDenied = taskScoringEditDenied(req, t);
      if (sDenied) return res.status(403).json({ error: _qualifyingScopeMessage(sDenied), code: sDenied.code });
    }
  }
  // Event team reports — removing a qualifying tag puts the challenge back into
  // scoring and the finish count: frozen by an ended session like adding it.
  if (typeof tag === "string" && tag.toLowerCase().startsWith("qualifying:") && taskFrozenByEndedCompetition(req.params.id)) {
    return res.status(409).json({ error: `Cannot stop this being a qualifying question — it is in an event with an ended session. ${FROZEN_REMEDY}`, code: "qualifying_tag_frozen" });
  }
  // The last qualifying tag going makes the challenge a scoring one again: its
  // stored answers are re-scored in the same transaction (sweep #91). A challenge
  // holding a second qualifying tag stays qualifying, and nothing is re-scored.
  const _isQ = () => _qualifyingNow(req.params.id);
  const _wasQ = _isQ();
  // Stopping being a qualifying question re-prices the answers already given,
  // which a lock forbids (as on the add): only when this removal takes the LAST
  // qualifying tag away.
  if (_locked && _wasQ && db.prepare("SELECT COUNT(*) AS n FROM task_tags WHERE task_id=? AND tag LIKE 'qualifying:%' AND tag<>?").get(req.params.id, tag).n === 0
      && db.prepare("SELECT 1 FROM task_tags WHERE task_id=? AND tag=?").get(req.params.id, tag)) {
    return res.status(403).json({ error: QUALIFYING_LOCKED_ERROR, code: "challenge_locked" });
  }
  let r = null, _held = null;
  runTxnWithMirrorBuffer(() => db.transaction(() => {
    r = db.prepare("DELETE FROM task_tags WHERE task_id=? AND tag=?").run(req.params.id, tag);
    if (r.changes === 0) return;
    createTaskVersion(req.params.id, getAdminIdentity(req), "tag_removed", null, { tag, ...reqContext(req) });
    if (_wasQ && !_isQ()) _held = _rescoreAfterQualifyingFlip(req, req.params.id, "qualifying_tag_removed");
  })());
  if (r.changes > 0 && typeof tag === "string" && tag.toLowerCase().startsWith("qualifying:")) _renumberAfterQualifyingChange(req.params.id);
  if (_held) _afterQualifyingFlip(_held);
  const tags = db.prepare("SELECT tag FROM task_tags WHERE task_id=?").all(req.params.id).map(r => r.tag);
  res.json({ ok: true, tags });
});
};
