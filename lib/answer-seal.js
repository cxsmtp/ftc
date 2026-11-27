// A SEALED ANSWER — the answer key belongs to its author, and to a superadmin
// who REVEALS it, on the record.
//
// `tasks.answer_sealed` is chosen ONCE, at create, by the person creating the
// challenge. While it is set, the answer key reaches its author — the account
// named by `tasks.created_by_id` — and nobody else by default: not an event
// admin, not a global admin, not a participant after the event's answer reveal.
// v8.12.2 (operator decision, reversing v8.10.0's "superadmins included"): a
// SUPERADMIN may read it too, and edit or unseal the challenge exactly as the
// author can — but only after an explicit REVEAL, which is recorded in the
// challenge's History and in the event log, naming the superadmin (and, under
// impersonation, the seat they were sitting in). The author may UNSEAL it
// later; nobody — the author included — may seal it again, because a value
// that has been on every admin's screen cannot be made secret again by
// flipping a column.
//
// THE REVEAL IS A FACT PASSED IN, NEVER READ HERE. Every predicate below takes
// `revealed` as its LAST argument — true only when the route has established
// that the acting human is a superadmin (`actingIsSuperAdmin(req)`, a live role
// read in lib/event-admin.js) AND that they revealed THIS challenge in THIS
// session (`req.session.sealedReveals[taskId]`, written by the reveal route).
// A caller that passes nothing gets the author-only rule, which is the safe
// default and what every participant-facing caller wants. This module stays
// PURE for that reason: the `sealTypeDenied(answerType, typeHasKey)` shape —
// take the fact as an argument, keep the one definition where it already lives.
//
// WHY THIS MODULE IS PURE. It requires nothing at module scope — not `db`, not
// `lib/log`, not `lib/config` — so a spec can `require` it at column 0 and
// assert the whole matrix without spawning a server (the `lib/scanner-classify`
// and `lib/cxone-identity` precedent, and the reason those rules have real locks
// while the subsystems around them are source-pinned). Every predicate takes the
// row and the actor id as ARGUMENTS; nothing here reads a session or a request.
//
// WHY IT IS NOT IN `lib/event-admin.js`, where the sibling task gates live.
// `taskEditDenied` and friends open with `if (scopedCompetitionIds(req) === null)
// return null` — global admins and superadmins bypass ownership entirely, which
// is correct for that tier system and is the exact opposite of what a seal means.
// A seal is not a narrowing of the event-admin scope; it is an orthogonal rule
// that binds EVERY tier. Folding it in beside a predicate whose first line
// exempts two tiers is how the next reader "simplifies" it into inertness.
//
// ── WHAT IS SEALED ────────────────────────────────────────────────────────────
//
// `correct_answer` and `explanation`, and those two only.
//
//  • `correct_answer` is the key. For `answer_type='choice'` it holds the JSON
//    array of CORRECT option ids, so withholding it withholds the correctness of
//    every option — `tasks.choices` (the `[{id,text}]` list) carries no
//    correctness at all and stays on the wire, which it must: the option TEXT is
//    what a participant is shown, and an admin preview with no options renders a
//    question nobody could answer.
//  • `explanation` is sealed because in this threat model it is the key wearing
//    prose. The author seals so that colleagues who may compete or coach cannot
//    learn the answer; an explanation reading "the answer is X because…" hands it
//    to exactly those people. Shipping it would make the feature's promise false
//    while looking complete — the failure this codebase keeps paying for.
//    The cost is stated rather than hidden: a sealed challenge contributes no
//    post-event explanation to the answer reveal, and the create form says so.
//  • `hint` — SEALED SINCE v8.12.2 (operator decision; v8.10.0 had left it
//    out). It is withheld wherever the key is withheld: the admin list, the
//    editor, the History, the export, and the end-of-event free reveal to
//    participants. What it does NOT withhold is the hint a participant PAID
//    for — `hint_reveals` is that participant's own row and the paid reveal is
//    the hint's whole purpose — and that exemption is a per-(participant, task)
//    fact these helpers cannot see, so routes/participant.js applies it by hand
//    (`hintRevealed`) rather than through `redactSealedAnswer`.
//
// A SUBMITTED answer is the third secret and is not a task column at all. For
// `text` / `json` / `file` / `choice` a CORRECT submission IS the key by
// construction, and for `any` the response is the only thing there is to protect
// — so `submissions.answer` is redacted on the same predicate wherever it reaches
// a human. `submissions.answer_canonical` is never projected to a client and is
// therefore left alone, which is what keeps re-grading working.
//
// ── THE AUTHORLESS POPULATION ─────────────────────────────────────────────────
//
// `tasks.created_by_id` is NOT backfilled (v8.7.0, deliberately), the task
// import never writes it, and `actorId(req)` is NULL for the BUILT-IN superadmin,
// which has no `users` row. So three populations have no author at all:
// pre-v8.7.0 challenges, imported challenges, and anything the built-in account
// creates. A seal on such a row would be unowned — unreadable and uneditable by
// every human alive, for ever, with no remedy short of hand-written SQL.
//
// So sealing REQUIRES a resolvable author: `sealAtCreateDenied` refuses when the
// creator has no user id, naming the remedy (sign in as a real admin account).
// That is not a limitation bolted on afterwards — the feature is defined as "the
// author, and a superadmin on the record", so a challenge with no author cannot
// express it. (v8.12.2 makes a superadmin's reveal a second door into a sealed
// key, so an authorless seal would no longer be unrecoverable — but it would
// still be a key with no owner, and the create refusal is kept on purpose.)
const SEAL_DENIED_CODE   = "answer_sealed_not_author";
const SEAL_CREATE_CODE   = "answer_seal_needs_author";
const SEAL_RESEAL_CODE   = "answer_seal_is_one_way";
const SEAL_TYPE_CODE     = "answer_seal_needs_a_key";
const SEAL_PROXY_CODE    = "answer_seal_not_by_proxy";
// v8.12.2 — the reveal is refused to anybody who is not a superadmin. Declared
// here like its five siblings so no route spells it as a literal.
const SEAL_REVEAL_CODE   = "answer_seal_reveal_superadmin_only";
// v8.12.6 — a disclosure the seal ADMITS but whose record could not be written.
// See `sealRevealUnrecorded` below; declared here so no route spells it.
const SEAL_UNRECORDED_CODE   = "answer_seal_reveal_unrecorded";
const SEAL_UNRECORDED_REASON = "unrecorded";

/**
 * The task columns a seal withholds. Exported so the redaction sites and the
 * scanner that pins them read ONE list rather than three copies.
 */
const SEALED_FIELDS = Object.freeze(["correct_answer", "explanation", "hint"]);

/** Is this row's answer sealed? Tolerant of the 0/1/undefined the column yields. */
function answerSealed(task) {
  return !!(task && task.answer_sealed);
}

/**
 * Is this row's author the given actor?
 *
 * A NULL / absent actor is NEVER the author, and neither is a NULL
 * `created_by_id` — so the built-in superadmin (no user id) and an authorless row
 * both fail closed. Written positively for that reason: `a !== b` would make two
 * NULLs a match and hand every authorless challenge to the built-in account.
 */
function isTaskAuthor(task, actorUserId) {
  return !!(actorUserId && task && task.created_by_id && task.created_by_id === actorUserId);
}

/**
 * May this actor read the answer key of this row?
 *
 * The whole rule, in one place: an unsealed challenge is readable by whoever the
 * surrounding tier already admitted (this predicate says nothing about tiers), and
 * a sealed one by its author — or, since v8.12.2, by a superadmin who has
 * REVEALED it (`revealed === true`, established by the caller; see the header).
 * `revealed` is compared with `=== true` so an undefined, a stale session value
 * or a truthy object never counts.
 */
function sealedAnswerReadable(task, actorUserId, revealed = false) {
  return !answerSealed(task) || isTaskAuthor(task, actorUserId) || revealed === true;
}

/**
 * Redact the sealed columns from a task-shaped object for one reader.
 *
 * Returns the SAME object when nothing needs withholding, so the common path
 * allocates nothing; returns a shallow copy with the sealed keys DELETED — never
 * blanked — when it does.
 *
 * ABSENT, NOT EMPTY, and this is load-bearing twice over. An empty string is a
 * legitimate stored value (`answer_type='any'` stores exactly that), so blanking
 * would make "sealed" indistinguishable from "this type has no key"; and the
 * admin edit form posts `correct_answer` unconditionally, so a reader that saw an
 * empty string and saved would WIPE the key it was not allowed to read. The
 * caller's `can_see_answer: false` is what tells the client which situation it is.
 */
function redactSealedAnswer(row, actorUserId, revealed = false) {
  if (!row || sealedAnswerReadable(row, actorUserId, revealed)) return row;
  const out = { ...row };
  for (const f of SEALED_FIELDS) delete out[f];
  return out;
}

/**
 * Redact a `task_versions` SNAPSHOT for one reader.
 *
 * The snapshot is a whole-row JSON blob written at every edit, so a challenge
 * sealed today has snapshots from before the seal that still carry the key — and
 * `task_versions` is exempt from event retention, i.e. it is permanent. The
 * sealing decision is therefore applied at READ time and to EVERY version, which
 * makes it retroactive: the history of a sealed challenge is sealed too.
 *
 * `sealed` is the LIVE row's flag, not the snapshot's — the snapshot predates the
 * decision and must not be allowed to vote on it.
 */
function redactSealedSnapshot(snapshot, liveTask, actorUserId, revealed = false) {
  if (!snapshot || sealedAnswerReadable(liveTask, actorUserId, revealed)) return snapshot;
  const out = { ...snapshot };
  for (const f of SEALED_FIELDS) delete out[f];
  return out;
}

/**
 * Refuse an action that would read or rewrite a sealed key.
 *
 * Returns `{ code, message }` or null, matching `lib/event-admin.js`'s `_deny`
 * shape so a caller can hand either to the same 403 responder.
 */
function sealedEditDenied(task, actorUserId, revealed = false) {
  if (sealedAnswerReadable(task, actorUserId, revealed)) return null;
  return {
    code: SEAL_DENIED_CODE,
    message: "This challenge has a sealed answer, so only the person who created it can change it or see its answer and hint. Ask them to make the change or to unseal it first — or, as a superadmin, reveal the answer (which is recorded in the challenge's history) and then edit it.",
  };
}

/**
 * v8.12.2 — may this actor read a sealed challenge's HINT on the PARTICIPANT
 * surface? The hint has one reader the answer never has: the participant who
 * PAYS for it (a `hint_reveals` row, 30% of the points) — the paid reveal is
 * the hint's whole purpose, and the seal must not take back what was bought.
 * But that exemption belongs to a participant whose deduction is REAL, i.e.
 * one who SCORES on this event's board (`scoringParticipant`, established by
 * the caller from a `competition_users` row and the event's staff rule). A
 * staff member admitted to an event without competing in it holds no board
 * for the deduction to land on, so "paying" costs them nothing and the paid
 * arm would be a free read of a sealed hint by exactly the tier the seal
 * exists to keep out. The pre-release review found a regular admin doing that
 * in their own participant view.
 *
 * `revealed` is the superadmin's door (the live role, on the participant
 * surface); `scoringParticipant` is compared with `=== true` for the reason
 * `revealed` is.
 */
function sealedHintReadable(task, actorUserId, revealed = false, scoringParticipant = false) {
  return sealedAnswerReadable(task, actorUserId, revealed) || scoringParticipant === true;
}

/**
 * v8.12.2 — WHY a sealed hint is withheld from THIS reader, so the refusal and
 * the client's panel never state a false reason (the v8.10.1 wrong-reason
 * class, found by the second pre-release review). Three reachable readers:
 *   • `competing_elsewhere` — the ACTING person competes in an event holding the
 *     challenge; asked first, because it binds even a superadmin.
 *   • `impersonating` — an admin reading through somebody else's account: the
 *     paid row is the target's, the reader is the admin.
 *   • `not_competing` — an admin-tier reader in their own participant view,
 *     here as staff without competing (the default).
 * v8.12.6 — the GET can also send `unrecorded`, which is deliberately NOT a
 * member here: it is about a reader the seal ADMITS whose record could not be
 * written. See `sealRevealUnrecorded` below for why the two stay apart.
 */
const SEALED_HINT_WITHHELD_REASONS = Object.freeze(["competing_elsewhere", "impersonating", "not_competing"]);
const _HINT_DENIED_MESSAGES = Object.freeze({
  competing_elsewhere: "This challenge's hint is sealed by its author, and you are competing in an event that holds this challenge, so it is not shown to you here either.",
  impersonating: "This challenge's hint is sealed by its author. It is shown to the participant who paid for it, to the person who created it, and to a superadmin — on the record — but not to an admin looking through someone else's account.",
  not_competing: "This challenge's hint is sealed by its author. It is shown to participants competing in this event, to the person who created it, and to a superadmin — on the record. You are here as staff and are not competing in this event, so the hint is withheld.",
});

/**
 * v8.12.6 — THE RECORD GATES THE DISCLOSURE on the participant surface too.
 *
 * There the open IS the reveal: a superadmin is shown a sealed value because of
 * their tier (the live role read), not because of a session marker, so the
 * History row is the ONLY thing standing between the read and a disclosure
 * nobody wrote down. v8.12.2 wrote that row inside `try { … } catch (_) {}` and
 * shipped the value whether or not it landed — the "on the record" promise
 * failing OPEN. The explicit reveal route never did: it writes the record
 * before it sets the marker and refuses on failure. This is that rule, one
 * surface over:
 *   • `GET /api/tasks/:id` WITHHOLDS exactly the fields the record would have
 *     named and still answers 200 (an audit failure never turns a read into a
 *     500), saying why with `answer_withheld_reason` / `hint_withheld_reason`
 *     set to `SEAL_UNRECORDED_REASON`;
 *   • `POST /api/tasks/:id/hint` refuses with this `{ code, reason, message }`
 *     as a 503 BEFORE its `hint_reveals` write — so nothing is shown and nobody
 *     is charged, the impersonated TARGET included.
 * 503, not a 4xx: nothing is wrong with the actor, the record store is — and a
 * 5xx never feeds the scanner-reputation counter. The `message` is the hint
 * POST's, the one caller that sends a sentence; the GET sends only the reason
 * and the client renders its own copy for it.
 *
 * DELIBERATELY NOT A MEMBER OF `SEALED_HINT_WITHHELD_REASONS` (below). That list
 * names reasons the seal BINDS the reader; this one is about a reader the seal
 * ADMITS, and folding it in would let `sealedHintDenied(…, "unrecorded")` pair
 * the author-only code with a store-failure message. So the wire enum of the
 * GET's `hint_withheld_reason` is `[...SEALED_HINT_WITHHELD_REASONS,
 * SEAL_UNRECORDED_REASON]`, and its `answer_withheld_reason` is
 * `competing_elsewhere | unrecorded`.
 */
function sealRevealUnrecorded() {
  return {
    code: SEAL_UNRECORDED_CODE,
    reason: SEAL_UNRECORDED_REASON,
    message: "This challenge's hint is sealed by its author, and showing it to you has to be recorded in the challenge's history. That record could not be written just now, so nothing was shown and no points were deducted. Try again in a moment.",
  };
}

/**
 * Refuse a hint reveal (paid or free) on a sealed challenge to somebody the
 * seal binds. Same `{ code, message }` shape as `sealedEditDenied`; `why` is one
 * of SEALED_HINT_WITHHELD_REASONS (an unknown value falls to `not_competing`).
 */
function sealedHintDenied(task, actorUserId, revealed = false, scoringParticipant = false, why = "not_competing") {
  if (sealedHintReadable(task, actorUserId, revealed, scoringParticipant)) return null;
  return {
    code: SEAL_DENIED_CODE,
    reason: _HINT_DENIED_MESSAGES[why] ? why : "not_competing",
    message: _HINT_DENIED_MESSAGES[why] || _HINT_DENIED_MESSAGES.not_competing,
  };
}

/**
 * v8.12.2 — may this actor REVEAL a sealed challenge's answer and hint?
 *
 * The reveal is the superadmin's door into a sealed key, and it is the ONLY
 * door that is not the author's: a regular admin, an event admin and a
 * participant are refused with a named code, whatever they were sealed out of.
 * `isSuperadmin` is passed IN (the live-role answer from `actingIsSuperAdmin`,
 * never a session flag) for the purity reason in the header. An unsealed
 * challenge has nothing to reveal and is refused too, so a client cannot mint a
 * "revealed" History row on a challenge whose key everybody can already read.
 * The author's own reveal is not refused here — the route answers it as a
 * no-op, because there is nothing to disclose to the person who wrote it.
 */
function sealRevealDenied(task, isSuperadmin) {
  if (!answerSealed(task)) {
    return { code: SEAL_REVEAL_CODE, message: "This challenge's answer is not sealed, so there is nothing to reveal." };
  }
  if (isSuperadmin === true) return null;
  return {
    code: SEAL_REVEAL_CODE,
    message: "Only a superadmin can reveal a sealed answer, and the reveal is recorded in the challenge's history. Ask the person who created the challenge, or a superadmin.",
  };
}

/**
 * May a challenge of this ANSWER TYPE be sealed at all? (v8.10.1)
 *
 * A seal protects a KEY. `answer_type='any'` — "Any answer (free response)" —
 * has none: v8.9.0 stores `correct_answer=""` for it by construction, and
 * `answerTypeHasKey` is the predicate that says so. So sealing one withholds an
 * empty string and refuses everybody else the edit rights — a control that
 * appears to work, which this codebase holds to be worse than no control.
 *
 * IT IS NOT MERELY VACUOUS, WHICH IS WHY IT IS REFUSED RATHER THAN TOLERATED.
 * The seal also redacts SUBMITTED answers, and for `any` the submission is the
 * participant's own free response — the entire content such a challenge exists
 * to collect. Sealed, its responses vanish from the Submissions stream and its
 * column is dropped from the focused-participants CSV for everyone but the
 * author, so an organiser who asked the room a question can no longer read the
 * answers. The seal would take away the feature rather than protect it.
 *
 * `typeHasKey` IS PASSED IN RATHER THAN DERIVED HERE. `lib/scoring.js`'s
 * `answerTypeHasKey` owns the question of which types carry a key, and this
 * module must not require it: `lib/scoring` reaches `lib/config`, which
 * `process.exit(1)`s without `BASE_URL`, so importing it would destroy the
 * purity the header above is built on and take the column-0 spec with it. The
 * `lib/late-entry.js` shape — take the FACT as an argument, keep the one
 * definition where it already lives.
 *
 * Written POSITIVELY over "has a key" rather than as `type === "any"`, so a
 * future keyless answer type is refused with no edit here (*Recurring rules*:
 * fail CLOSED on a value invented later).
 */
function sealTypeDenied(answerType, typeHasKey) {
  if (typeHasKey) return null;
  return {
    code: SEAL_TYPE_CODE,
    message: "A sealed answer is the answer this challenge is graded against, and an \"Any answer (free response)\" challenge has no answer to seal — every response is accepted. Sealing it would also hide the responses from everyone but you, which is the opposite of what that answer type is for. Choose another answer type, or leave the answer unsealed.",
  };
}

/**
 * May this actor SEAL a challenge they are creating?
 *
 * Only if we can record who they are. See THE AUTHORLESS POPULATION above.
 *
 * v8.12.1 — and only with their OWN hand. `byProxy` is true when the creating
 * session is an impersonation (an admin inside an event admin's panel): the
 * seat that would become `created_by_id` is the organiser's, the person typing
 * the key is somebody else. Sealing there would hand the organiser sole custody
 * of a key they never wrote and lock its real author out of it the moment they
 * exit — the authorless population in a new shape. Refused with its own code so
 * the client can say WHY rather than "no account".
 */
function sealAtCreateDenied(actorUserId, byProxy = false) {
  if (byProxy) {
    return {
      code: SEAL_PROXY_CODE,
      message: "A sealed answer belongs to the person who typed it, and you are creating this challenge through another organiser's panel. Exit impersonation and create it from your own account, or leave the answer unsealed.",
    };
  }
  if (actorUserId) return null;
  return {
    code: SEAL_CREATE_CODE,
    message: "A sealed answer belongs to the account that created the challenge, and this session has no such account. Sign in as an admin user and create it there, or leave the answer unsealed.",
  };
}

/**
 * Police a change to the flag itself.
 *
 *   0 -> 0   fine (nothing said, or said no)
 *   1 -> 1   fine — echoing the stored value back is not a change, so a client
 *            that round-trips the whole row keeps working (the `event_kind` rule)
 *   1 -> 0   UNSEAL: the author, or a superadmin who has revealed it (v8.12.2)
 *   0 -> 1   REFUSED for everyone, author included
 *
 * The last one is the one-way door. Between creation and now the key has been on
 * the wire to every admin tier, in `task_versions`, in the tasks export and in
 * `app.jsonl`; a column flip cannot retrieve any of that, so a platform that
 * accepted it would be promising a secrecy it had already lost. Refusing is the
 * only honest answer, and it is refused with its reason rather than ignored.
 */
function sealChangeDenied(existing, incomingSealed, actorUserId, revealed = false) {
  const was = answerSealed(existing);
  if (incomingSealed == null) return null;              // said nothing
  const want = !!incomingSealed;
  if (want === was) return null;                        // echo, not a change
  if (want && !was) {
    return {
      code: SEAL_RESEAL_CODE,
      message: "An answer can only be sealed when the challenge is created. This one has been readable by administrators since then, so sealing it now would not make it secret. Create a new challenge with a sealed answer instead.",
    };
  }
  // 1 -> 0, the unseal. The author, or a superadmin who has revealed it — a
  // colleague must not be able to reveal somebody else's key by clearing the
  // flag, and a superadmin who has NOT revealed cannot either: clearing the
  // flag would put the key on every admin's screen with no reveal on record.
  if (!isTaskAuthor(existing, actorUserId) && revealed !== true) {
    return {
      code: SEAL_DENIED_CODE,
      message: "Only the person who created this challenge — or a superadmin who has revealed its answer — can unseal it.",
    };
  }
  return null;
}

/**
 * THE SUBMITTED-ANSWER PROJECTION — who may read a submission's `answer`, for
 * every admin stream that shows one (GET /api/admin/submissions and GET
 * /api/admin/audit). Hoisted byte-for-byte in behaviour from the Submissions
 * handler (server.js), where it was inline; one definition, so the two streams
 * cannot disagree about a sealed challenge.
 *
 * A submitted answer to a sealed challenge is the key by construction for
 * `text` / `json` / `file` / `choice` (a CORRECT submission IS the accepted
 * value) and is the only secret there is for `any`, so it is withheld from
 * everyone but:
 *   - the challenge's author, asked of THE HUMAN (`actingAdminId`), never the
 *     seat — `null` for the built-in superadmin, which authors nothing, so
 *     `_author IS NOT ?` against NULL is true for every row and fails closed;
 *   - a superadmin who REVEALED it in this session (`sealRevealSet`, a live role
 *     read), narrowed to challenges the acting human does not compete in: a
 *     reveal is refused to a competitor at reveal time, and a row that appeared
 *     later must not widen it here.
 *
 * Returns:
 *   sqlAnswer(cols) — `{ sql, params }`: a CASE expression that is the answer
 *     where readable and '' where withheld, for a `q` LIKE. THE SEARCH IS AN
 *     ORACLE, so it must match the same redacted value the reader gets. Params
 *     are BOUND (never interpolated) in the order the SQL names them; an empty
 *     reveal set takes an explicit always-true arm (`IN ()` is not standard SQL).
 *   visible(row) — whether this caller may read the row's answer, from the
 *     row's sealed flag, author id and task id.
 *
 * The lazy requires keep this module pure at module scope (see the header).
 */
function submissionAnswerProjection(req) {
  const { actingAdminId, sealRevealSet, competitorIds } = require("./event-admin");
  const { competitorEventsForTask } = require("./staff-compete");
  const db = require("../db");
  const actor = actingAdminId(req);
  const revealIds = Object.keys(sealRevealSet(req))
    .filter(id => competitorEventsForTask(db, competitorIds(req), id).length === 0);
  return {
    actor,
    revealIds,
    sqlAnswer({ sealed = "_sealed", author = "_author", taskId = "_task_id", answer = "answer" } = {}) {
      const revealArm = revealIds.length ? `${taskId} NOT IN (SELECT value FROM json_each(?))` : "1=1";
      return {
        sql: `CASE WHEN ${sealed}=1 AND (${author} IS NULL OR ${author} IS NOT ?) AND ${revealArm} THEN '' ELSE ${answer} END`,
        params: revealIds.length ? [actor, JSON.stringify(revealIds)] : [actor],
      };
    },
    visible(row) {
      const sealedRow = !!row._sealed;
      return !sealedRow || (!!actor && row._author === actor) || revealIds.includes(row._task_id);
    },
  };
}

module.exports = {
  submissionAnswerProjection,
  SEALED_FIELDS,
  SEAL_UNRECORDED_CODE, SEAL_UNRECORDED_REASON,
  answerSealed, isTaskAuthor, sealedAnswerReadable, sealedHintReadable,
  redactSealedAnswer, redactSealedSnapshot,
  sealedEditDenied, sealedHintDenied, SEALED_HINT_WITHHELD_REASONS, sealAtCreateDenied, sealChangeDenied, sealTypeDenied, sealRevealDenied,
  sealRevealUnrecorded,
};
