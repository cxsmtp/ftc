"use strict";

// Achievement-badge routes (v7.1.0):
//   • POST /api/competitions/:id/badge — mint (or return) a top-3 share badge.
//   • GET  /badge/:token               — public OpenGraph page LinkedIn crawls.
//
// Sharing is link-intent based: the SPA opens LinkedIn's share composer with
// the /badge/<token> URL; LinkedIn scrapes the OG tags here (og:image → the
// rendered PNG at /api/images/<id>) and renders the card. No w_member_social
// scope, no stored member tokens. Placement is re-verified server-side on
// every mint — the client never asserts its own rank.

const crypto = require("crypto");
const db = require("../db");
const { rateLimit, requireParticipant, requireCompleteProfile, requireAdmin, requireSuperAdmin, csrfProtection, testAdminCommitPark, adminAuthzDenied, impersonatingHandDenied, sendImpersonationCommitDenial, participantSessionDenied, sendParticipantSessionDenial } = require("../lib/middleware");
// v8.1.0 (PR 27) — the revoke route uses the platform's shared destructive-admin
// budget, spelled the same way every sibling route spells it.
const destructiveAdminLimit = rateLimit(60_000, 30, "destructive-admin");
const { actorPermissions, handHolds } = require("../lib/rbac");
const { originKeyFor } = require("../lib/login-code");   // the wrong-surname budgets' source
const { eventPolicy, eventKind, EVENT_KINDS } = require("../lib/event-policy"); // v8.1.0 — certificate mode + the kind vocabulary
const { getCompetition, competitionFullyEnded, isDryRunCompetition, participantAttempted, competitionEffectiveEnd, timeslotEffectiveEnd, lateEntryWindowOpen, lateEntryDeadline } = require("../lib/competitions");
const { buildLeaderboard, buildLateLeaderboard, boardSlotOf, rankedBoards } = require("../lib/leaderboard");
const { resolveCertificateConfig, certificateTier } = require("../lib/certificate-config");
// v8.15.1 — the automatic certificate issue and the congratulations email.
const certificateDispatch = require("../lib/certificate-dispatch");
const { buildBadgeSvg, buildCertificateSvg, renderBadgePng, renderBadgePdf, BadgeRenderUnavailable, badgeBasisLabel, generateCredentialCode, formatCredentialCode, normaliseCredentialCode, credentialNameKey, credentialNameKeyDigraph, credentialMatchKeys, isPlacementRank, earnsPlacement, isPlacementBasis, certificateNameParts, certificatePrintedName, badgeDateLabel } = require("../lib/badge");
const { getPlatformName } = require("../lib/settings");
const { platformLookAttr } = require("../lib/platform-look"); // the platform look on every page theme-boot.js paints
const { escapeHtml } = require("../lib/sanitise");
const { BASE_URL } = require("../lib/config");
const { now } = require("../lib/time");
const { impersonatorScopedCompetitionIds, impersonationScopeDenied } = require("../lib/event-admin"); // v8.8.6
const { competitorIds, competitionDenied } = require("../lib/event-admin"); // v8.12.1 — competitorIds: the seat AND the hand; v8.15.1 — competitionDenied for the admin certificate routes
const { competitorEditDenied, refuseCompetitor, staffCompeteOn } = require("../lib/staff-compete"); // v8.12.0 — the revoke door
const { getStaffOrBenchmarkSet } = require("../lib/user-tags"); // the boards' exclusion, re-asked at the automatic issue's write
const { _b64url, trackDetachedSend } = require("../lib/util");
const { recordCompetitionEvent, recordUserEvent, recordOrphanedAuditEvent, getAdminIdentity, reqContext } = require("../lib/audit");
const { swallowed } = require("../lib/best-effort");
const { impersonationActor, isImpersonating } = require("../lib/impersonation");
const { log } = require("../lib/log");
const { notQualifyingSql } = require("../lib/qualifying"); // sweep #92 — a Quick answer never dates a completion certificate
const { programStanding, programGraded, programMaxPoints, retakeRefusal, startProgramRetake, closedAttemptGrades, formatGradePercent, gradeLabel, PASS_PERCENT } = require("../lib/program-grade"); // Program grades (27 Nov 2026)
// Where a signed-in holder finds a certificate: the event's Challenges page
// carries "Your certificate" for every kind (badge-share.js renderCertificateCta).
const CERTIFICATE_HOME = "sign in and open the event: your certificate is on its Challenges page";


/**
 * What a badge calls its owner: "Salutation First Last" (family name first for a
 * name in Han, kana or Hangul), falling back to the nickname — and WHETHER that
 * fallback fired. The rule is lib/badge.js `certificatePrintedName`, the one
 * place it is decided, so the mint and every render (`_badgeArt`) read the same
 * answer as the admin board's and the account's preview of it.
 *
 * Two fallbacks, both deliberate. There may be no usable name at all (a
 * salutation on its own names nobody). And NAMES are full Unicode while the
 * badge fonts draw a fixed set of scripts (Inter, plus the Noto fallback faces:
 * lib/badge.js `canRenderText`) — nicknames are ASCII-restricted by platform
 * rule, names are not — so a name in any other script would rasterise as empty
 * boxes, i.e. a badge naming nobody, which is worse than one carrying the handle.
 * A salutation that alone stops the name being drawn is left off instead.
 *
 * `fallback` is RETURNED rather than re-derived by a second `canRenderText` call
 * at the mint, because two copies of one condition is the drift this file keeps
 * paying for — and the mint has to know it fired, or it freezes match parts
 * naming somebody the certificate never shows (see `name_match_snapshot` below).
 */
function _badgeName(user, nickname, opts) {
  return certificatePrintedName(user, nickname, opts);
}

/**
 * Was this certificate MINTED printing the nickname because the fonts of the
 * day could not draw the name? Then its frozen match parts are the nickname
 * alone (`{given: "", family: <nickname>}`, the mint's fallback branch) — a
 * minted name always has a given part. Such a certificate keeps the coverage it
 * was minted under, Inter alone and a whole name or the nickname
 * (`certificatePrintedName(…, {fallbackFaces:false})`): the faces added on
 * 14 Nov 2026, or the salutation the rule now leaves off, would otherwise
 * re-render it with a name its credential lookup does not match, so a genuine
 * copy downloaded afterwards would answer "no matching certificate". It keeps
 * what it printed (operator ruling, 14 Nov 2026). Certificates minted since then
 * print the name whenever the faces can draw it.
 */
function _mintedWithNickname(row) {
  if (!row || !row.name_match_snapshot) return false;
  let parts = null;
  try { parts = JSON.parse(row.name_match_snapshot); } catch (_) { return false; }
  return !!(parts && parts.given === "" && parts.family && parts.family === String(row.nickname_snapshot || "").trim());
}

/**
 * THE NAME AN ISSUED CERTIFICATE PRINTS, for its badge row and its holder's
 * users row (`owner`: null or undefined once the account is gone, which prints
 * what the row froze). The one decision every artefact (`_badgeArt`) and every
 * list naming an issued certificate's holder (the organisers' list) read, so a
 * list cannot name somebody the paper does not.
 */
function _heldName(row, owner) {
  return _badgeName(owner, row.name_snapshot || row.nickname_snapshot, { fallbackFaces: !_mintedWithNickname(row) });
}

/**
 * The name PARTS a render freezes — the LOOKUP side of `_badgeName`, and kept
 * beside it because the two must describe the same person by the same decision.
 *
 * The fallback branch is why this cannot be `certificateNameParts` on its own:
 * when the fonts cannot draw the name every surface prints the NICKNAME, so the
 * parts have to follow what was SHOWN — a verifier can only type what they can
 * see (v8.1.1). The printed name goes in `lastName` because
 * `credentialMatchKeys` matches on the FAMILY part.
 *
 * The mint spells this same derivation inline at the INSERT (`nameMatchParts`).
 * That is a COPY, not a shared call, so nothing stops the two drifting: they must
 * be changed together, or a certificate would report itself renamed the moment it
 * was issued.
 */
function _badgeMatchParts(user, { displayName, fallback }) {
  return fallback
    ? certificateNameParts({ firstName: "", lastName: displayName })
    : certificateNameParts({
        firstName: user && user.first_name,
        lastName: user && user.last_name,
        certificateGivenName: user && user.certificate_given_name,
        certificateFamilyName: user && user.certificate_family_name,
      });
}


// The timeslot to rank a member within: lib/leaderboard.js `boardSlotOf`, the one
// definition the event team's report reads too.
const _badgeTimeslot = boardSlotOf;

/**
 * v8.1.4 — MAY THIS PARTICIPANT MINT A CERTIFICATE FOR THIS EVENT, RIGHT NOW?
 *
 * ONE predicate, read by the mint (which ENFORCES it) and by
 * GET /api/me/certificates (which OFFERS it). They used to be two copies of the
 * rule and had already drifted: `claimable` was TAG-BLIND, while the mint
 * additionally requires the caller to be on `buildLeaderboard`'s board — which
 * EXCLUDES staff- and benchmark-tagged users. So a benchmark participant (the
 * documented assign-then-tag reference-score setup) who solved challenges in an
 * ended event was shown "Your certificate is ready — Get my certificate", and
 * pressing it answered **"You did not participate in this competition."**: false,
 * about an action the platform had just offered. That breaks both halves of
 * v7.14.2 at once — the affordance was offered where the server refuses, and the
 * refusal named something untrue. The sibling surface gets this right:
 * `canShareBadge` (routes/leaderboard.js) requires `me` for exactly this reason.
 *
 * Answers `{ok:true, me, placement, basis}` or the mint's OWN refusal as
 * `{status, body}`, so the two surfaces cannot phrase one rule differently
 * either. Do NOT re-derive any of these conditions at a call site; the whole
 * point is that there is one copy.
 *
 * `fresh` is the single deliberate difference between the callers. The mint
 * PERSISTS `rank` and `score_snapshot` into a permanent, public artefact, so it
 * must not read the 5-second leaderboard cache (v7.21.9). An OFFER persists
 * nothing and runs once per candidate competition on an ordinary page render, so
 * paying for an uncached board build there would be a poor trade for a value that
 * only decides whether a button is drawn.
 */
/**
 * v8.15.1 — the boards one dispatch job ranks against, each built ONCE (fresh)
 * and handed to `_mintEligibility` for every participant it asks about, so a pass
 * over N people costs one main and one late board per slot rather than N of each
 * (3000-person events made the per-participant build O(n²)). Lazy: a slot whose
 * participants all hold their certificate already never builds one. Used by the
 * automatic issue over an event that has ended. The boards are fresh when built,
 * NOT final: scores no longer move, but who counts on a board still can (a
 * `staff` or `benchmark` tag, a role change, a removal). So the dispatcher keeps
 * a memo only across the back-to-back passes of one run (a pass that reached its
 * send cap) and drops it whenever it defers, re-ends, closes the job or re-arms
 * it for a timed retry; and the automatic issue's write re-asks whether its
 * person still counts on the board, calling `reset()` when they do not, so the
 * rest of the run ranks on boards built again without them. `reset()` cannot
 * reach an issue already past its eligibility read (at most the other lanes of
 * one pass), which persists the rank it read.
 */
// `fresh: false` (the top-three download's podium read, which persists nothing)
// takes the boards from the leaderboard cache instead.
function _eligibilityBoards(comp, { fresh = true } = {}) {
  const main = new Map(), late = new Map();
  const key = (tsId) => (tsId == null ? "" : String(tsId));
  return {
    main(tsId) {
      const k = key(tsId);
      if (!main.has(k)) main.set(k, buildLeaderboard(comp.id, tsId, { fresh }));
      return main.get(k);
    },
    late(tsId) {
      const k = key(tsId);
      if (!late.has(k)) late.set(k, buildLateLeaderboard(comp.id, tsId, { fresh }));
      return late.get(k);
    },
    /** Forget every board built, so the next read builds it again. */
    reset() { main.clear(); late.clear(); },
  };
}

// `boards` (v8.15.1): a `_eligibilityBoards` memo to read the boards from instead
// of building them — the SAME predicate, only where the ranked entries come from.
// Absent (the mint route, the claimable offer), each call builds its own.
function _mintEligibility(userId, comp, tsId, { fresh = false, boards = null } = {}) {
  // v8.1.0 (PR 29) — a completion kind's trigger is the participant's own
  // completion, not the event's end: a Program runs to a deadline that can be a
  // year out, so requiring the event to end would make a learner who finished in
  // month two wait ten months. For an attempt kind the old rule stands and must —
  // a PLACEMENT is not knowable until the board is final.
  const certMode = eventPolicy(comp).certificate;
  const completionKind = certMode === "completion";
  if (!completionKind && !competitionFullyEnded(comp)) {
    return { status: 409, body: { error: "This event has not ended yet.", code: "not_ended" } };
  }
  if (isDryRunCompetition(comp.id)) {
    return { status: 403, body: { error: "Badges are not available for this event.", code: "dry_run" } };
  }
  // Server-authoritative eligibility — never trust a client-claimed rank. `me` is
  // the caller's row in the sorted leaderboard, which excludes staff/benchmark,
  // who therefore cannot mint at all.
  let me = (boards ? boards.main(tsId) : buildLeaderboard(comp.id, tsId, { fresh })).find(u => u.userId === userId);
  // ── v8.6.0 — A LATE ENTRANT IS ON THEIR OWN BOARD ───────────────────────────
  //
  // They are excluded from the main board by construction (that is what makes it
  // final at the event's end), so resolving `me` there alone would answer "You did
  // not participate in this competition." to somebody who did — the exact false
  // refusal this helper's header records the platform paying for once already.
  //
  // Their rank comes from the LATE board, so a "1st Place" certificate means first
  // among the late entrants, which is what the section they appear in says.
  let lateEntrant = false;
  if (!me) {
    const _lateMe = (boards ? boards.late(tsId) : buildLateLeaderboard(comp.id, tsId, { fresh })).find(u => u.userId === userId);
    if (_lateMe) { me = _lateMe; lateEntrant = true; }
  }
  if (!me) return { status: 403, body: { error: "You did not participate in this event.", code: "not_participated" } };
  // WHILE THE WINDOW IS OPEN, A LATE ENTRANT MAY TAKE PARTICIPATION ONLY.
  //
  // The rule this platform has always enforced is that a PLACEMENT is not knowable
  // until the board is final; a late board keeps moving until the deadline. So the
  // placement branch is suppressed rather than the mint refused — a late entrant
  // who has attempted can collect the certificate that IS knowable now, and the
  // placement one becomes available when their board settles.
  //
  // The cost, stated rather than buried: the mint is idempotent per
  // (user, competition, timeslot), so somebody who collects during the window
  // KEEPS the participation certificate — a later placement needs a superadmin to
  // revoke the first. Both client CTAs say so before the click.
  const _lateOpen = lateEntrant && lateEntryWindowOpen(comp, competitionEffectiveEnd(comp), Date.now());

  // A COMPLETION kind (a Program) has no ranking anywhere — PR 18 suppressed the
  // board, the score pill and the Leaderboard tab — so a placement badge would
  // publish a placing the platform refuses to show. Its certificate attests the
  // learner's GRADE instead (owner decision, 27 Nov 2026; lib/program-grade.js):
  // issued once they have FINISHED (every scoring challenge solved or out of
  // attempts) with 60% or more of the Program's points, the band and percentage
  // frozen on it. Under 60% there is no certificate: the learner is told to try
  // again.
  let grade = null;
  if (completionKind) {
    const standing = programStanding(userId, comp);
    if (!standing.finished || !standing.grade) {
      return {
        status: 403,
        body: {
          error: "Your certificate is available once you have finished every challenge in this program.",
          code: "not_completed",
        },
      };
    }
    if (!standing.grade.passed) {
      return {
        status: 403,
        body: {
          error: `Your grade is ${formatGradePercent(standing.grade.permille)}: a certificate needs ${PASS_PERCENT}% or more. Try the program again.`,
          code: "grade_below_pass",
        },
      };
    }
    grade = standing.grade;
  }
  // NO CERTIFICATE WITHOUT AN ATTEMPT. The attempt test runs BEFORE the placement
  // branch and for every attempt-kind basis: a member who entered the event and
  // did nothing can still sit at rank 2 or 3 on a thin board (score 0 beats a
  // negative score). A placement also needs points above zero (below), which no
  // one has without a correct answer. Completion is already stricter (every
  // challenge solved).
  if (!completionKind && !participantAttempted(userId, comp.id)) {
    return { status: 403, body: { error: "Badges are available to participants who attempted at least one challenge.", code: "not_attempted" } };
  }
  // A GOLD, SILVER OR BRONZE CERTIFICATE NEEDS POINTS ABOVE ZERO (operator
  // ruling, 14 Nov 2026): a top-three attempter on zero or less is issued
  // participation, which is what the podium's certificate label and the team
  // report's podium already said. `earnsPlacement` (lib/badge.js) is the one
  // definition; the podium cards themselves still show whoever holds places 1-3.
  const placement = !completionKind && !_lateOpen && earnsPlacement(me);
  return {
    ok: true,
    me,
    placement,
    // FROZEN AT MINT by the caller, beside `basis` / `rank` / `score_snapshot` /
    // `date_snapshot` and for their reason: an admin can move the event's end
    // afterwards, and re-deriving this at render would relabel a certificate
    // somebody has already downloaded and filed.
    lateEntrant,
    // So the OFFER surface can explain why a top-3 late entrant is being shown a
    // participation certificate, instead of appearing to lose their placing.
    latePlacementPending: _lateOpen && earnsPlacement(me),
    // Stored, not derived: a top-three place with points above zero is what makes
    // a placement badge TODAY, and a badge minted under a different rule must
    // still be able to say what it was.
    basis: completionKind ? "completion" : (placement ? "placement" : "participation"),
    // Program grades — frozen at mint beside `basis` (`grade_band`, `grade_permille`).
    grade,
  };
}

/**
 * v8.15.1 — the facts a NEW certificate is minted with, HOISTED out of the mint
 * route byte-for-byte so the automatic issue (`_autoIssueCertificate`, driven
 * by lib/certificate-dispatch.js at an event's end) cannot name the holder,
 * date or score differently from a participant's own "Get my certificate".
 * Reads only; the caller renders `svg` (its check that the artwork can be drawn
 * now: the bytes are not kept, `_NO_STORED_IMAGE`) and writes the row.
 */
function _mintInputs(userId, comp, tsId, verdict) {
  const { me, placement, basis } = verdict;
  const user = db.prepare("SELECT nickname, email, personal_title, first_name, last_name, certificate_given_name, certificate_family_name FROM users WHERE id=?").get(userId);
  const nickname = (user && user.nickname) || me.nickname || "";
  // v7.21.28 — the badge NAMES THE PERSON, artwork included. v7.21.31 records
  // what it said at mint but no longer RENDERS from that record: every surface
  // goes through _badgeArt now, so they cannot disagree, and reading live means
  // a badge minted before a profile was complete is not stuck on a handle.
  const { displayName: badgeName, fallback: nameFellBack } = _badgeName(user, nickname);
  // v8.1.0 (PR 25) — the parts the credential lookup will match, from the same
  // resolver that produced the printed name, so the paper and the lookup cannot
  // disagree about who this certificate names.
  //
  // v8.1.0 — AND THE FONT FALLBACK IS THE ONE CASE THAT MADE THAT CLAIM FALSE.
  // When the fonts cannot draw the name every surface prints the NICKNAME while
  // these parts were still frozen from first/last, so the only surname
  // /credential accepted was one appearing NOWHERE on the certificate: the
  // holder's employer types what is printed, it folds to a non-matching key,
  // and a GENUINE certificate answers "no matching certificate" — reading as
  // forged, and exhausting the per-code failure budget after ten tries. A
  // verifier can only type what they can see, so the matched parts are the
  // parts that were SHOWN. What is PRINTED is deliberately unchanged
  // (v7.21.28): a certificate naming nobody is worse than one carrying the
  // handle. Only the lookup moves.
  //
  // Routed through `certificateNameParts` rather than assembled inline so its
  // contract still holds on this branch — null when there is no usable name,
  // and the empty string never becomes a match key. The printed name goes in
  // `lastName` because `credentialMatchKeys` matches on the FAMILY part: a
  // nickname has no given/family split, and the whole of it is what gets typed.
  const nameMatchParts = nameFellBack
    ? certificateNameParts({ firstName: "", lastName: badgeName })
    : certificateNameParts({
        firstName: user && user.first_name,
        lastName: user && user.last_name,
        certificateGivenName: user && user.certificate_given_name,
        certificateFamilyName: user && user.certificate_family_name,
      });
  // v7.21.31 — the participant's own END, not the competition's start: frozen as
  // `date_snapshot`, and drawn into the share image the mint renders.
  const badgeEnd = _badgeEndDate({ user_id: userId, timeslot_id: tsId }, comp);
  const svg = buildBadgeSvg({
    platformName: getPlatformName(),
    rank: me.rank,
    competitionName: comp.name,
    displayName: badgeName,
    dateLabel: badgeDateLabel(badgeEnd),
    // Placement badges show the score; participation AND completion badges are
    // score-less — for a completion kind that is not a style choice, it is the
    // same suppression PR 18 applied everywhere else.
    scoreLabel: placement ? `${Math.round(me.score)} pts` : null,
    basis,
  });
  return { user, nickname, badgeName, nameFellBack, nameMatchParts, badgeEnd, svg };
}

// THE SHARE IMAGE IS NOT STORED (sweep #43). Every view renders it on request
// (the badge.png routes), so a copy stored at mint was only ever served to a
// deployment that had lost its renderer since, and with the artwork of the day
// it was minted; it cost ~150 KB of `images` per certificate, again for every
// Issue again, and nothing reclaimed it. `image_id` is NOT NULL, so a new
// certificate names no stored copy with ''. A certificate issued while mints
// still stored one keeps it (`_storedBadgePng`) until the certificate or its
// holder's account is deleted, which deletes the copy too.
const _NO_STORED_IMAGE = "";

// v8.15.1 — the certificate row, ONE statement for both writers (the
// participant's mint route and `_autoIssueCertificate`), so the frozen facts a
// certificate carries cannot depend on who asked for it.
const _BADGE_INSERT_SQL =
  "INSERT INTO achievement_badges (token, user_id, competition_id, timeslot_id, rank, image_id, nickname_snapshot, score_snapshot, name_snapshot, basis, name_match_snapshot, public_code, date_snapshot, late_entrant, created_at, grade_band, grade_permille) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
function _badgeInsertValues({ token, userId, comp, tsId, me, nickname, placement, badgeName, basis,
  nameMatchParts, publicCode, badgeEnd, lateEntrant, ts, grade = null }) {
  return [token, userId, comp.id, tsId, me.rank, _NO_STORED_IMAGE, nickname,
    placement && Number.isFinite(me.score) ? Math.round(me.score) : null, badgeName,
    basis,
    // The two name PARTS a verifier will be matched against, frozen here.
    // Parts and NOT folded keys — see credentialNameKey. `null` when there
    // is no usable name, so the lookup matches nothing rather than
    // everything.
    nameMatchParts ? JSON.stringify(nameMatchParts) : null,
    // v8.1.0 (PR 27) — NEW MINTS ONLY (Question 5a = i). Historical badges
    // keep a NULL code, which is what keeps the claim-time notice true.
    publicCode,
    // Frozen: see the column note in db.js.
    badgeEnd ? new Date(badgeEnd).toISOString() : null,
    // v8.6.0 — WAS THIS EARNED AS A LATE ENTRANT? Frozen for the reason the
    // three snapshots above are: the event's end can move afterwards, and a
    // certificate must keep saying what it said when it was issued.
    lateEntrant ? 1 : 0,
    ts,
    // Program grades — the band and percentage the certificate was issued with,
    // frozen for the reason the snapshots above are. NULL for every other basis.
    grade ? grade.band : null,
    grade ? grade.permille : null];
}

// The share image a certificate's row still names a stored copy of (one issued
// while mints stored it), else null. The badge.png routes serve it only when the
// renderer is missing; a certificate without one is then a 503, as the PDF is.
function _storedBadgePng(row) {
  if (!row || !row.image_id) return null;
  const stored = db.prepare("SELECT data FROM images WHERE id=?").get(row.image_id);
  return stored ? stored.data : null;
}

function _shareUrl(token) {
  const page = `${BASE_URL}/badge/${token}`;
  return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(page)}`;
}

/**
 * v7.21.30 — the artwork inputs for a badge, in ONE place.
 *
 * The PNG, the certificate PDF and the public page all draw from this, so they
 * cannot name a different person, score or date. Everything comes from the row's
 * FROZEN snapshots (v7.21.28) except the platform name, which is a live operator
 * setting and is meant to follow a rebrand.
 */
/**
 * v7.21.31 — the date is when the event ENDED FOR THIS PARTICIPANT.
 *
 * It was the competition's START time under a label reading "DATE" — so a
 * competition running 5-7 August put "5 Aug" on a certificate for something that
 * finished on the 7th. A participant in a multi-session competition ends when
 * THEIR session ends, which is not the competition's end, so the slot is resolved
 * from `competition_users` rather than from the badge row: badges only carry
 * `timeslot_id` in per-slot leaderboard mode, while the participant competed in a
 * specific session either way.
 */
function _badgeEndDate(row, comp) {
  // v8.1.0 (PR 29) — A COMPLETION CERTIFICATE IS DATED WHEN THE PERSON COMPLETED,
  // not when the event ends.
  //
  // PR 29 lets a Program certificate be earned before the deadline, and a Program
  // deadline can be a year out — so the event-end rule would print a date in the
  // FUTURE on a document someone is handing to an employer today. The last correct
  // submission is the moment the claim became true.
  //
  // Only reached at mint: from then on `date_snapshot` holds the answer, which is
  // why an already-issued certificate does not move when the deadline does.
  //
  // Sweep #92: the claim became true at the last correct answer to a SCORING
  // challenge. A Quick (qualifying) question completes nothing (lib/qualifying.js),
  // and its answer can come, or change, long after; counted here it re-dated the
  // certificate to the day of that answer.
  //
  // Program grades (27 Nov 2026): a learner FINISHES when every scoring challenge
  // is solved or out of attempts, so the claim became true at their last answer
  // to a scoring challenge, right or wrong (a wrong answer spending the last
  // attempt finishes them too). With every challenge solved that is the last
  // correct answer, as before: nothing is answered after a challenge is solved.
  if (eventPolicy(comp).certificate === "completion") {
    const last = db.prepare(
      `SELECT MAX(s.submitted_at) AS t FROM submissions s JOIN tasks t ON t.id = s.task_id
        WHERE s.user_id=? AND s.competition_id=? AND ${notQualifyingSql("t")}`
    ).get(row.user_id, comp.id);
    if (last && last.t) return new Date(last.t);
  }
  const slotId = row.timeslot_id
    || db.prepare("SELECT timeslot_id FROM competition_users WHERE competition_id=? AND user_id=?")
         .get(comp.id, row.user_id)?.timeslot_id;
  if (slotId) {
    const slot = db.prepare("SELECT * FROM competition_timeslots WHERE id=?").get(slotId);
    if (slot) return timeslotEffectiveEnd(slot);
  }
  return competitionEffectiveEnd(comp);
}

/**
 * v7.21.31 — record a badge DOWNLOAD on the competition's History.
 *
 * Minting was audited from the start; retrieving the artifact was not, so nothing
 * recorded that a certificate had actually been taken away — which is the event
 * an operator is asked about ("did they get their certificate?").
 *
 * Attribution has a wrinkle worth stating: these routes are PUBLIC and keyed only
 * on the capability token, so the fetcher may not be the badge's owner. The event
 * therefore records BOTH — `user_id` is whose badge it is, and the actor is the
 * signed-in fetcher when there is one, or "anonymous" for a bare link. reqContext
 * carries the address either way, so a link circulated beyond its owner is
 * visible rather than silently attributed to them.
 *
 * `extra` adds what only the caller knows about how the fetch came: the
 * certificate PDF fetched through the congratulations email's link carries
 * `via: "email_link"` (sweep #402), since a mail scanner opens that link as the
 * holder's own signed-out click would and the record alone cannot tell them apart.
 */
function _recordBadgeDownload(req, row, comp, kind, extra = null) {
  try {
    const owner = db.prepare("SELECT nickname, email FROM users WHERE id=?").get(row.user_id);
    const actor = req.session?.userEmail
      || (req.session?.builtinId === "superadmin" ? "superadmin" : null)
      || "anonymous";
    recordCompetitionEvent(comp.id, kind, actor, {
      user_id: row.user_id,
      nickname: owner && owner.nickname,
      rank: row.rank,
      by_owner: !!(req.session?.userId && req.session.userId === row.user_id),
      ...(extra || {}),
      ...reqContext(req),
      ...(isImpersonating(req) ? { impersonated_by: impersonationActor(req.session) } : {}),
    });
  } catch (e) {
    // audit is best-effort — never fail the download for it
    swallowed("badge:download-audit", e);
  }
}

// v8.8.20 — what the certificate tells a verifier to open. Derived from
// BASE_URL rather than written down, so a deployment on its own hostname prints
// its own address; the scheme is stripped because a printed URL reads better
// without it and every browser supplies it. Computed once — BASE_URL is a boot
// constant.
const _CREDENTIAL_VERIFY_DISPLAY =
  String(BASE_URL || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "") + "/credential";
// v8.15.0 — the same page as an absolute URL, for the certificate's QR code.
const _CREDENTIAL_VERIFY_LINK = String(BASE_URL || "").replace(/\/+$/, "") + "/credential";

/**
 * The grade a certificate was issued with (Program grades, 27 Nov 2026), from
 * its frozen columns: `{band, label, permille, percent}` (percent as printed,
 * "94%"), or null for a certificate issued without one.
 */
function _frozenGrade(row) {
  if (!row || !row.grade_band || !gradeLabel(row.grade_band) || !Number.isFinite(row.grade_permille)) return null;
  return {
    band: row.grade_band,
    label: gradeLabel(row.grade_band),
    permille: row.grade_permille,
    percent: formatGradePercent(row.grade_permille),
  };
}

function _badgeArt(row, comp) {
  const owner = db.prepare("SELECT nickname, personal_title, first_name, last_name, certificate_given_name, certificate_family_name FROM users WHERE id=?").get(row.user_id);
  const name = _heldName(row, owner);
  return {
    platformName: getPlatformName(),
    rank: row.rank,
    competitionName: comp.name,
    // v7.21.31 — read the name LIVE, and this REVERSES v7.21.28's freeze on
    // purpose. That freeze existed for one reason: the PNG was rasterised once
    // and stored, so reading the live profile for the PDF and the page would have
    // let one token name the person differently in artwork and text. v7.21.30
    // made every surface render on demand through THIS resolver, so they cannot
    // disagree however the value is obtained — and live is strictly better,
    // because a badge minted before the name landed (name_snapshot NULL, or
    // frozen as the nickname because the profile was incomplete at the time) is
    // otherwise stuck showing a handle for ever. The snapshot survives as the
    // last fallback: what it said at mint, if the live row yields nothing.
    displayName: name.displayName,
    // v8.1.1 — the parts THIS render's name would freeze, so /credential can
    // compare like with like instead of folding a salutation into one side of the
    // comparison (see `_credentialNameChanged`). Rendered by nothing:
    // `buildBadgeSvg` / `buildCertificateSvg` read named fields, so the extra key
    // is inert on the artwork paths, and every wire response built from this
    // object picks its fields explicitly.
    matchParts: _badgeMatchParts(owner, name),
    // v8.1.0 — the frozen date wins. Recomputing let an admin extending a
    // Program's deadline rewrite the date on certificates already issued, which
    // the verification page would then confirm as correct. The live derivation
    // survives only as the fallback for a pre-v8.1.0 badge.
    dateLabel: badgeDateLabel(row.date_snapshot ? new Date(row.date_snapshot) : _badgeEndDate(row, comp)),
    // The SCORE stays frozen (v7.15.6): unlike a name it is a factual claim
    // about a finished event, and a revived-and-re-ended competition moves it.
    scoreLabel: (isPlacementBasis(row.basis, row.rank) && Number.isFinite(row.score_snapshot))
      ? `${row.score_snapshot} pts` : null,
    // v8.1.0 (PR 25) — so the PNG, the PDF and the public page cannot disagree
    // about what this certificate attests. NULL on a legacy row, which the
    // renderers read as "derive it from rank the old way".
    basis: row.basis || null,
    // v8.6.0 — the LATE-ENTRANT marker, added HERE rather than at each render site
    // for this resolver's stated reason: the PNG, the certificate PDF and the
    // public page must not be able to name a different person, score, date — or
    // now, entry route. A value that reached the artwork and not this object is
    // exactly the class v7.21.30/v7.21.31 fixed, where the page showed the nickname
    // while the picture showed the name. Read from the FROZEN column; 0 on every
    // badge minted before this release, which is true of them.
    lateEntrant: !!row.late_entrant,
    // Program grades (27 Nov 2026) — the band and percentage this certificate was
    // issued with, from the FROZEN columns; null on every other certificate (a
    // completion certificate issued before grades included), which renders as
    // it always did.
    grade: _frozenGrade(row),
    // v8.8.20 — the printed verification code, and where to take it. Both are
    // read by `buildCertificateSvg` ALONE; `buildBadgeSvg` and the public page
    // ignore them, which is the decision recorded at that renderer. NULL on a
    // badge minted before v8.1.0 (PR 27), and the renderer draws nothing at all
    // for one rather than a label over a blank.
    publicCode: row.public_code || null,
    verifyUrl: _CREDENTIAL_VERIFY_DISPLAY,
    // v8.15.0 — what the QR code encodes: the credential page with the code
    // pre-filled (GET /credential reads `?code=`, and `_scrubLogPath` redacts it
    // from every log). NULL with no code, so a legacy badge draws no QR either.
    verifyLink: row.public_code ? `${_CREDENTIAL_VERIFY_LINK}?code=${encodeURIComponent(row.public_code)}` : null,
    // v8.15.0 — the certificate DESIGN (defaults <- global <- this event), read
    // LIVE on every render. Design is live and facts are frozen: everything
    // above this line is a claim about the holder and comes from the frozen row;
    // this is typography and colour around those claims. Read only by
    // `buildCertificateSvg`; the share card and the public page ignore it.
    design: resolveCertificateConfig(db, comp.id),
  };
}

// audit v7.23.6 — the shell for the badge 404. Uses inline style ATTRIBUTES,
// exactly as the badge page below does: the CSP is `style-src-attr
// 'unsafe-inline'` but `style-src-elem 'self'`, so a <style> BLOCK here would be
// silently dropped and the page would render as raw browser default — which is
// the defect this replaces, and the one the unsubscribe shell shipped with for
// eight releases. Carries no token detail and says nothing that could
// distinguish invalid from revoked from orphaned.
/**
 * v8.1.0 (PR 26), widened to EVERY KIND in v8.6.2 — is this badge's PUBLIC PAGE
 * published yet?
 *
 * Minting must never publish. That page carries an `<h1>`, `og:image`/`og:title`
 * and deliberately no robots meta, with `Cache-Control: public` — it exists to be
 * crawled — so it names the holder to anyone who finds the link. PR 26 made a
 * COMPLETION certificate wait for the holder's Share, because "Get my
 * certificate" would otherwise publish as a SIDE EFFECT of collecting a
 * document, and left the two ranked kinds publishing at mint on the grounds that
 * their CTA says "Share on LinkedIn or download", so publishing was stated
 * intent.
 *
 * That reasoning does not survive the download half of its own sentence: a
 * participant who opened the dialog, took the PNG and closed it had published a
 * page naming them and had been told nothing — the privacy note explaining the
 * publication was rendered only for the completion kind. So the rule is now
 * uniform: nothing is published until the holder presses Share, and the note is
 * shown to everybody because it is now true for everybody.
 *
 * THE FLOOR IS WHAT MAKES WIDENING IT SAFE. `shared_at` was added at v8.1.0 with
 * no backfill while badges have existed since v7.1.0, so withholding on that
 * column alone would take dark every page minted before it — pages that are live
 * today and may be linked from a post somebody has already made. A row created
 * before `settings.badge_page_share_gate_at` keeps its page; see db.js for why
 * this is a floor rather than a backfill of `shared_at`.
 *
 * Withheld means the SAME uniform 404 as invalid / revoked / orphaned — a
 * distinct status or wording here would be an oracle telling a stranger that a
 * given person holds an unshared certificate, which is precisely the fact being
 * withheld.
 *
 * `shared_at` is write-once, so a page already published stays published. The
 * predicate no longer reads the event kind at all: two readers used to restate
 * this rule and only one of them is the page.
 */
function _badgeShareGateFloor() {
  return db.prepare("SELECT value FROM settings WHERE key='badge_page_share_gate_at'").get()?.value || null;
}

// `floor` may be passed by a caller judging many rows, so the setting is read
// once per list rather than once per unshared certificate.
function _badgePageWithheld(row, floor = _badgeShareGateFloor()) {
  if (row.shared_at) return false;
  // Grandfathered: its page was already live before the gate existed.
  if (floor && row.created_at && String(row.created_at) < floor) return false;
  return true;
}

// THE STANDALONE SHELL for the public certificate pages: the same sheet
// (verify-pages.css) and theme script as the LinkedIn share page and the pages
// opened from an email, so they follow the platform's mode and lock (the look
// rides <html>: tests/platform-look-pages.spec.js SOURCE arm) and fall under the
// standalone Flat Design and radius scanners (tests/theme-tokens.spec.js). No
// style="" attribute: those escape every stylesheet scanner. The brand is not a
// heading: each page's h1 is its subject, inside <main>.
const _SHELL_FOOTER = `<footer><div class="footer-logo"><img class="logo-dark" src="/checkmarx-logo-white.svg" alt="Checkmarx"/><img class="logo-light" src="/checkmarx-logo-blue.svg" alt="Checkmarx"/></div>
<div class="footer-copy">&copy; 2026 Checkmarx Ltd. All Rights Reserved.</div></footer>`;

function _badgeShellTop(platform, { title, headExtra = "", robots = false }) {
  const E = escapeHtml;
  return `<!DOCTYPE html><html lang="en"${platformLookAttr()}><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/><meta name="color-scheme" content="light dark"/>
${robots ? `<meta name="robots" content="noindex,nofollow"/>\n` : ""}<title>${title}</title><link rel="icon" href="/favicon.webp"/>
${headExtra}<link rel="stylesheet" href="/fonts.css"/><link rel="stylesheet" href="/verify-pages.css"/>
<script src="/theme-boot.js"></script></head><body>
<header><div class="brand"><img class="logo-dark" src="/checkmarx-logo-white.svg" alt="Checkmarx"/><img class="logo-light" src="/checkmarx-logo-blue.svg" alt="Checkmarx"/><span>${E(platform)}</span></div></header>`;
}

// v8.13.3 — ONE sentence for all four causes (an invalid token, a revoked badge, an
// orphaned one, and a completion certificate its holder has not yet shared), so the
// body stays byte-identical across them and still names none of them. It used to say
// the badge "may have been removed by its owner" — no route lets a holder remove a
// badge, so that explained nothing that can happen, and for the withheld case it told
// a stranger the holder had removed something they simply had not published.
// It takes no argument: its only inputs are the platform's name and look, never
// anything about the link asked for.
function _badgeNotFoundHtml() {
  const platform = getPlatformName();
  return `${_badgeShellTop(platform, { title: `Badge not available | ${escapeHtml(platform)}`, robots: true })}
<main role="main"><div class="card badge-gone"><h1>This badge isn't available</h1><p>The link may be incorrect, or this badge is not published or is no longer available.</p><a class="btn" href="/">Go to the home page</a></div></main>
${_SHELL_FOOTER}</body></html>`;
}

// The LinkedIn share page (GET /badge/:link/post). Self-contained like the email
// result pages (verify-pages.css, no SPA), and JS-light: one module that copies
// the post through `ui/clipboard.js` `copyText` (execCommand fallback for plain
// http venue LANs) and opens LinkedIn's feed composer. `spent` renders the
// used/expired answer with no post on it.
function _sharePageHtml({ platformName, post = null, eventName = "", csrfToken = "", linkToken = "", spent = null }) {
  const E = escapeHtml;
  const head = `<!DOCTYPE html><html lang="en"${platformLookAttr()}><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="color-scheme" content="light dark"/>
<meta name="robots" content="noindex,nofollow"/>
<title>Share your certificate | ${E(platformName)}</title><link rel="icon" href="/favicon.webp"/>
<link rel="stylesheet" href="/fonts.css"/><link rel="stylesheet" href="/verify-pages.css"/>
<script src="/theme-boot.js"></script></head><body>
<header><h1><img class="logo-dark" src="/checkmarx-logo-white.svg" alt="Checkmarx"/><img class="logo-light" src="/checkmarx-logo-blue.svg" alt="Checkmarx"/><span>${E(platformName)}</span></h1></header>`;
  const foot = _SHELL_FOOTER + "</body></html>";
  if (spent) {
    const msg = spent === "used"
      ? `This share link has already been used. To share your certificate again, ${CERTIFICATE_HOME}.`
      : `This share link has expired. To share your certificate, ${CERTIFICATE_HOME}.`;
    return `${head}<main role="main"><div class="card" role="status"><h2>Link no longer active</h2><p>${E(msg)}</p><a class="btn" href="/">Go to ${E(platformName)}</a></div></main>${foot}`;
  }
  return `${head}<main role="main"><div class="card share-post-card" id="share-post" data-link="${E(linkToken)}" data-csrf="${E(csrfToken)}">
<h2>Share your certificate on LinkedIn</h2>
<p>Here is a post about ${E(post.achievement)} at <strong>${E(eventName)}</strong>. Edit it if you like, then copy it and paste it into LinkedIn.</p>
<label for="share-post-text" class="share-post-label">Your post</label>
<textarea id="share-post-text" rows="5" spellcheck="true">${E(post.text)}</textarea>
<p class="share-post-tip">To tag <strong>Checkmarx</strong> and the organisers, type <strong>@</strong> in LinkedIn and pick them from its suggestions — a link cannot create real tags.</p>
<div class="share-post-actions">
<button type="button" class="btn" id="share-post-go">Copy post &amp; open LinkedIn</button>
<button type="button" class="btn secondary" id="share-post-copy">Copy post</button>
</div>
<p class="share-post-status" id="share-post-status" role="status" aria-live="polite"></p>
<p class="share-post-note">This link works once. Copying the post and opening LinkedIn uses it up and publishes your certificate page, so LinkedIn can show it.</p>
<p class="share-post-fallback" id="share-post-fallback" role="status">If the buttons do not respond, reload this page.</p>
</div></main>
<script type="module" src="/js/features/certificate-share-page.js"></script>${foot}`;
}

function _badgePayload(row, { mayReadCodes = true } = {}) {
  // What THIS certificate prints, by the decision its artwork reads (`_heldName`,
  // as `_badgeArt` does), so the dialog's notes describe the picture beside them:
  // for a new mint and for a certificate already held alike, since the dialog
  // re-POSTs here to open a held one and most are issued by the dispatcher.
  const owner = db.prepare("SELECT nickname, personal_title, first_name, last_name, certificate_given_name, certificate_family_name FROM users WHERE id=?").get(row.user_id);
  const printed = _heldName(row, owner);
  // The nickname note gives the fonts as its reason, so it goes out only where
  // they are: a certificate issued with the nickname keeps printing it once the
  // fonts draw the name (`_mintedWithNickname`: its lookup expects the
  // nickname), and "cannot draw your name" would be false there.
  const fontsCannotDraw = printed.fallback && _badgeName(owner, "").fallback;
  return {
    // Viewed as the holder by an admin who may not look codes up: no code and no
    // token (`_participantMayReadCodes`), and the client says why.
    ...(mayReadCodes ? { token: row.token } : { withheld: true }),
    // v8.11.1 (external audit F7) — IS THE PUBLIC PAGE LIVE YET?
    //
    // Since v8.6.2 NOTHING publishes until its holder presses Share, whatever the
    // event kind — but this payload, which is what drives the share dialog,
    // carried no publication state at all, so the client could only guess from
    // `basis` and guessed the pre-v8.6.2 answer. `_badgePageWithheld` is the ONE
    // predicate the page itself and `GET /api/me/certificates` already read; this
    // gives the third reader the same answer rather than a fourth restatement of
    // the rule.
    published: !_badgePageWithheld(row),
    // v8.1.0 (PR 24) — TRUE when the certificate will carry the participant's
    // NICKNAME because the badge fonts cannot draw their name. The client cannot
    // work this out for itself: `canRenderText` reads the shipped font binaries'
    // cmap, which only the server has. Without the flag the substitution is
    // silent, and the person most affected — someone whose name is in a script
    // the subset misses — is the least likely to guess why.
    ...(fontsCannotDraw ? { name_fallback: true } : {}),
    // TRUE when the name is printed without the salutation, which alone stopped
    // the fonts drawing it (operator ruling, 14 Nov 2026: the dialog says so).
    // Never beside `name_fallback`: a nickname has no salutation to leave off.
    ...(printed.salutationDropped ? { salutation_dropped: true } : {}),
    rank: row.rank,
    // From the frozen basis, as the label beside it is: a late entrant's
    // participation certificate keeps its podium rank, and is still no placing.
    placement: isPlacementBasis(row.basis, row.rank),
    rankLabel: badgeBasisLabel(row.basis, row.rank),
    basis: row.basis || null,
    // v8.6.0 — so the share dialog and the certificates list can label it. FROZEN
    // at mint, so it says what the artefact says rather than what the event's
    // schedule now implies.
    lateEntrant: !!row.late_entrant,
    // Program grades — the frozen band and percentage; absent without one.
    ...(_frozenGrade(row) ? { grade: _frozenGrade(row) } : {}),
    // v8.1.0 (PR 27) — absent on a pre-v8.1.0 badge, which has no code at all.
    ...(mayReadCodes && row.public_code ? { publicCode: row.public_code, publicCodeFormatted: formatCredentialCode(row.public_code) } : {}),
    // v7.21.30 — rendered on request, not the copy stored at mint. See the route.
    ...(mayReadCodes ? {
      imageUrl: `${BASE_URL}/badge/${row.token}/badge.png`,
      badgeUrl: `${BASE_URL}/badge/${row.token}`,
      shareUrl: _shareUrl(row.token),
    } : {}),
  };
}

// Idempotency lookup — mirrors uq_achievement_badges_user_comp_ts (NULL slot ⇒ '').
function _findBadge(userId, compId, tsId) {
  return db.prepare(
    "SELECT * FROM achievement_badges WHERE user_id=? AND competition_id=? AND IFNULL(timeslot_id,'')=IFNULL(?, '') AND revoked_at IS NULL"
  ).get(userId, compId, tsId);
}

const _REVOKED_SQL =
  "SELECT token FROM achievement_badges WHERE user_id=? AND competition_id=? AND IFNULL(timeslot_id,'')=IFNULL(?, '') AND revoked_at IS NOT NULL";

/**
 * v8.15.1 — ISSUE A CERTIFICATE WITH NO REQUEST, for lib/certificate-dispatch.js
 * at an event's end (or a Program participant's completion).
 *
 * The same decisions as the participant's own mint, in the same order and from
 * the same helpers — the held certificate is returned as a fact; a revoked one is
 * never replaced (lifting a revocation is an admin act); eligibility is
 * `_mintEligibility` with `fresh: true`, because this persists rank and score —
 * plus ONE that only an automatic issue needs: a late entrant whose window is
 * still open is DEFERRED rather than minted. A participant pressing the button
 * in the window chooses to take participation and keep it (the CTA says so); an
 * automatic mint would make that choice for them, so it waits for the window to
 * close and for their placing to be final.
 *
 * Re-asked inside the write, after the render await: revocation (the mint's
 * TOCTOU), membership and the account's lifecycle (blocked or denied while the
 * certificate was drawn). Answers `{row, minted}`, `{skip: reason}` or
 * `{defer: Date}`; throws `BadgeRenderUnavailable` for the caller to retry.
 *
 * `reissue` (a superadmin's Issue again, POST …/certificates/reissue; operator
 * ruling, 17 Nov 2026): the ONE way past a revocation. The revoked certificate
 * stays revoked; a new one is drawn from the event's current results, by the same
 * steps. `reissue.recheck()` re-asks the acting admin inside the write, after the
 * render (Resend's pattern); a refusal answers `{skip: "admin_refused", denied}`.
 * The caller records the audit (with its request's context), not this function.
 */
// An account the automatic issue never mints for (blocked, denied, not
// approved): `_autoIssueCertificate`'s write re-checks it, and the podium below
// leaves such a place out, since no certificate will ever fill it.
function _accountNeverIssued(u) { return !u || !!u.blocked || !!u.denied_at || !u.approved; }

// ISSUE AGAIN's refusals (POST …/certificates/reissue), by the code the
// eligibility predicate or the write answers: one table, so the Issued list's
// note and the route's answer say the same thing.
const _NO_CERT_NOW = "The event's current results give them no certificate.";
const _REISSUE_REFUSALS = {
  not_ended: [409, "This event has not ended, so its results are not final. Issue it again once it ends."],
  late_entry_open: [409, "Late entry is still open, so their placing is not final. Issue it again once late entry closes."],
  dry_run: [409, "Certificates are not issued for a dry-run event."],
  not_participated: [409, _NO_CERT_NOW],
  not_attempted: [409, _NO_CERT_NOW],
  not_completed: [409, _NO_CERT_NOW],
  not_member: [409, "They are no longer in this event."],
  account_inactive: [409, "Their account is blocked, denied or not approved, so no certificate can be issued."],
};
function _reissueRefusal(code) { return _REISSUE_REFUSALS[code] || [409, _NO_CERT_NOW]; }

// Would Issue again issue this participant a certificate now? The route's own
// checks, read-only, for the Issued list: null when it would, else the refusal's
// code (the list says why rather than leave the button out unexplained).
function _issueAgainRefusal(userId, comp) {
  // In the route's own order (`_autoIssueCertificate`): eligibility, the late
  // window, then (in its write) membership and the account.
  const v = _mintEligibility(userId, comp, _badgeTimeslot(comp, userId));
  if (!v.ok) return (v.body && v.body.code) || "not_participated";
  if (v.lateEntrant && lateEntryWindowOpen(comp, competitionEffectiveEnd(comp), Date.now())) return "late_entry_open";
  if (!db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, userId)) return "not_member";
  if (_accountNeverIssued(db.prepare("SELECT blocked, denied_at, approved FROM users WHERE id=?").get(userId))) return "account_inactive";
  return null;
}

/**
 * THE PODIUM OF EVERY BOARD an ended event ranks on, as the mint awards it: one
 * per session in per_slot mode, else the main board and the late entrants'
 * board (a late entrant places on their own board, and only once their window
 * has closed). On each, the ranks 1-3 the mint's own verdict
 * (`_mintEligibility`) makes a placement, minus accounts the automatic issue
 * never mints for; each place says whether a certificate of ANY kind (live or
 * revoked) is already held for that board — a participation certificate taken
 * in the late window, or a revoked one, is settled, never replaced. For the
 * top-three download (routes/export-import.js, through lib/certificate-dispatch.js
 * `placementPodium`), which compares it with what is issued. Persists nothing,
 * so it reads the cached boards. The boards are lib/leaderboard.js
 * `rankedBoards`, which the event team's report reads too.
 */
function _placementPodium(comp) {
  const boards = _eligibilityBoards(comp, { fresh: false });
  const { boards: ranked, slotOf } = rankedBoards(comp);
  const heldStmt = db.prepare("SELECT 1 FROM achievement_badges WHERE competition_id=? AND user_id=? AND IFNULL(timeslot_id,'')=IFNULL(?,'') LIMIT 1");
  const userStmt = db.prepare("SELECT blocked, denied_at, approved FROM users WHERE id=?");
  const out = [];
  for (const { timeslotId: tsId, timeslotName, late } of ranked) {
    const places = [];
    for (const e of (late ? boards.late(tsId) : boards.main(tsId))) {
      if (!isPlacementRank(e.rank)) continue;
      // Ranked where the mint ranks them, or not on this board for the mint.
      if ((slotOf.has(e.userId) ? slotOf.get(e.userId) : _badgeTimeslot(comp, e.userId)) !== tsId) continue;
      const v = _mintEligibility(e.userId, comp, tsId, { boards });
      if (!v.ok || !v.placement || !!v.lateEntrant !== late) continue;
      if (_accountNeverIssued(userStmt.get(e.userId))) continue;
      places.push({ userId: e.userId, rank: e.rank, held: !!heldStmt.get(comp.id, e.userId, tsId) });
    }
    out.push({ timeslotId: tsId, timeslotName: tsId ? (timeslotName || null) : null, late, places });
  }
  return out;
}

async function _autoIssueCertificate(userId, comp, { boards = null, reissue = null } = {}) {
  const tsId = _badgeTimeslot(comp, userId);
  const existing = _findBadge(userId, comp.id, tsId);
  if (existing) return { row: existing, minted: false };
  if (!reissue && db.prepare(_REVOKED_SQL).get(userId, comp.id, tsId)) return { skip: "revoked" };
  const verdict = _mintEligibility(userId, comp, tsId, { fresh: true, boards });
  if (!verdict.ok) return { skip: (verdict.body && verdict.body.code) || `refused_${verdict.status}` };
  if (verdict.lateEntrant) {
    const _effEnd = competitionEffectiveEnd(comp);
    if (lateEntryWindowOpen(comp, _effEnd, Date.now())) return { defer: lateEntryDeadline(comp, _effEnd) };
  }
  const { me, placement, basis, lateEntrant } = verdict;
  const { nickname, badgeName, nameMatchParts, badgeEnd, svg } = _mintInputs(userId, comp, tsId, verdict);
  // Rendered, never kept (`_NO_STORED_IMAGE`): the check that the artwork can be
  // drawn now. Without a renderer it throws BadgeRenderUnavailable, and the
  // dispatcher retries later rather than issue a certificate nobody can download.
  await renderBadgePng(svg);
  // Tests hold Issue again's render window open, to revoke the admin inside it.
  if (reissue) await testAdminCommitPark();
  const ts = now().toISOString();
  const token = _b64url(crypto.randomBytes(32));
  const publicCode = generateCredentialCode(crypto.randomBytes);
  let denied = null;
  const _autoPersist = db.transaction(() => {
    if (reissue) {
      denied = reissue.recheck();
      if (denied) return "admin_refused";
    } else if (db.prepare(_REVOKED_SQL).get(userId, comp.id, tsId)) return "revoked";
    if (!db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, userId)) return "not_member";
    if (_accountNeverIssued(db.prepare("SELECT blocked, denied_at, approved FROM users WHERE id=?").get(userId))) return "account_inactive";
    // Still on this event's board (operator ruling, 24 Nov 2026)? A `staff` or
    // `benchmark` tag or an off-board role landing after the eligibility read
    // (the render's await, or a board memo built passes ago) is honoured here:
    // the boards' own exclusion, read uncached.
    if (getStaffOrBenchmarkSet([userId], { staffCompete: staffCompeteOn(comp) }).has(userId)) return "off_board";
    db.prepare(_BADGE_INSERT_SQL).run(..._badgeInsertValues({
      token, userId, comp, tsId, me, nickname, placement, badgeName, basis,
      nameMatchParts, publicCode, badgeEnd, lateEntrant, ts, grade: verdict.grade,
    }));
    return null;
  });
  let refused;
  try {
    // IMMEDIATE: a read-then-write transaction whose deferred BEGIN meets another
    // process's write lock (the purge script) fails at the upgrade without
    // waiting; taking the lock first waits out busy_timeout instead.
    refused = _autoPersist.immediate();
  } catch (e) {
    // Lost a race with the participant's own mint — theirs is the certificate.
    const winner = _findBadge(userId, comp.id, tsId);
    if (winner) return { row: winner, minted: false };
    throw e;
  }
  if (refused) {
    // The memo still ranks them, so everyone below them would be issued the
    // rank they had with them on the board: rebuild it for the rest of the run.
    if (refused === "off_board" && boards && typeof boards.reset === "function") boards.reset();
    return { skip: refused, ...(denied ? { denied } : {}) };
  }
  if (!reissue) {
    try {
      recordCompetitionEvent(comp.id, "badge_minted", "system", {
        user_id: userId, nickname, rank: me.rank, placement, via: "automatic",
      });
    } catch (e) {
      // audit is best-effort
      swallowed("badge:auto-mint-audit", e);
    }
  }
  return { row: db.prepare("SELECT * FROM achievement_badges WHERE token=?").get(token), minted: true, nickname, rank: me.rank, placement };
}

/**
 * v8.15.1 — the certificate PDF for a held badge: the bytes and a filename the
 * holder can find later. ONE render path for the public download, the admin
 * download and the email attachment, so the three cannot differ.
 */
async function _certificatePdfFor(row, comp) {
  const art = _badgeArt(row, comp);
  const svg = buildCertificateSvg(art);
  const pdf = await renderBadgePdf(svg, `${badgeBasisLabel(row.basis, row.rank)} — ${comp.name} — ${art.displayName}`);
  // A filename the participant can find later; ASCII-folded because
  // Content-Disposition filenames are not reliably Unicode across clients.
  const slug = String(comp.name).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "certificate";
  // `holder`: the name the certificate prints, for a file named after its
  // holder (the top-three ZIP); the downloads keep `filename`.
  return { pdf, filename: `${slug}-certificate.pdf`, holder: art.displayName };
}

/**
 * The tier/score view of a certificate an admin or its holder lists. It never
 * carries the credential CODE: who may see a code beside its holder is a
 * permission (`_certificateCode`), not a list.
 */
function _certificateFacts(row) {
  const tier = certificateTier({ basis: row.basis, rank: row.rank });
  return {
    tier,
    rank: row.rank,
    label: badgeBasisLabel(row.basis, row.rank),
    basis: row.basis || null,
    score: (isPlacementBasis(row.basis, row.rank) && Number.isFinite(row.score_snapshot)) ? row.score_snapshot : null,
    lateEntrant: !!row.late_entrant,
    issuedAt: row.created_at,
    // Program grades (27 Nov 2026): the band and percentage it was issued with,
    // frozen; null for any other certificate.
    grade: _frozenGrade(row),
  };
}

// THE CODE BESIDE ITS HOLDER (sweep #403). Joining a credential code to the
// person who holds it is what GET /api/admin/credential/:code exists to keep to
// the permission Look up a certificate by its code (`certificates.lookup`: a
// superadmin, or a role granted it), audited per lookup. An admin list carrying
// every code beside its holder's name and email would hand the same table, in
// bulk and unaudited, to every admin who can open the event (for a regular admin,
// every event). So the admin answers carry the code only for that permission; a
// certificate's own PDF still prints it, one holder per download, and each
// download is audited (`badge_certificate_downloaded`).
function _mayReadCodes(req) { return actorPermissions(req).perms.has("certificates.lookup"); }
// THE PARTICIPANT'S OWN SURFACES, VIEWED AS THEM (operator ruling, 23 Nov 2026).
// The holder sees their certificate's code and its token (the link to its page,
// image, PDF and LinkedIn post) always. An admin viewing as them is the admin
// list's reader in another seat: they see those only when the ACTING admin (the
// hand, read live; never the seat, which is the participant) holds the same
// `certificates.lookup`, else the answers carry `withheld: true` instead. Asked
// at each send, after any await.
function _participantMayReadCodes(req) { return !isImpersonating(req) || handHolds(req, "certificates.lookup"); }
function _certificateCode(row, mayReadCodes) {
  return mayReadCodes && row && row.public_code ? { code: formatCredentialCode(row.public_code) } : {};
}

/**
 * v8.15.1 — the door checks for the admin certificate routes, in the order every
 * competition door uses: 404, then (writes only) the competitor lock, then scope.
 * Answers `{comp}` or `{sent}`.
 */
function _adminCertificateGate(req, res, { write = false } = {}) {
  const comp = getCompetition(req.params.id);
  if (!comp) return { sent: res.status(404).json({ error: "Event not found" }) };
  if (write) {
    const cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), comp.id));
    if (cmp) return { sent: cmp };
  }
  const denied = competitionDenied(req, comp.id);
  if (denied) return { sent: res.status(403).json({ error: denied.message, code: denied.code }) };
  return { comp };
}

/** The live (unrevoked) certificate a participant holds for an event, if any. */
function _heldCertificate(compId, userId) {
  return db.prepare(
    "SELECT * FROM achievement_badges WHERE competition_id=? AND user_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1"
  ).get(compId, userId);
}

module.exports = function register(app) {
  // v8.15.1 — the automatic issue and its PDF, handed to the dispatcher (a lib
  // module cannot require a route module).
  certificateDispatch.setCertificateIssuer({ issue: _autoIssueCertificate, renderPdf: _certificatePdfFor, boardsFor: _eligibilityBoards, podium: _placementPodium });

  // ── Mint (or return the existing) badge for a verified top-3 finish ──────────
  app.post("/api/competitions/:id/badge", requireParticipant, rateLimit(60_000, 20, "badge-mint"), requireCompleteProfile, csrfProtection, async (req, res) => {
    const userId = req.session.userId;
    const comp = getCompetition(req.params.id);
    if (!comp) return res.status(404).json({ error: "Event not found" });

    // v8.8.6 — THE ONE DURABLE WRITE AN IMPERSONATION SESSION CAN MAKE, and it
    // was unscoped. The certificate mint is the read-only tier's single carve-out
    // (v8.3.25, impersonationReadOnlyWriteAllowed), so an event admin impersonating
    // a participant could mint a real certificate on an event they do not organise
    // — measured, achievement_badges 0 to 1 — publishing a permanent artefact in
    // that participant's name off the back of an event outside their remit.
    //
    // REFUSED HERE rather than folded into impersonationReadOnlyWriteAllowed: that
    // predicate matches on the PATH alone and cannot resolve the entity, which is
    // the documented reason the event-admin gate is not global. And it is refused
    // ABOVE the idempotent existing-badge return, because handing back a badge for
    // an out-of-scope event would disclose its token — a live capability that opens
    // the PNG, the PDF and the public page with no auth.
    {
      const _denied = impersonationScopeDenied(req, comp.id);
      if (_denied) return res.status(403).json({ error: _denied.message, code: _denied.code });
    }

    // Must be (or have been) a member of this competition. Asked again inside the
    // write transaction below: the render is an await.
    const MEMBER_SQL = "SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?";
    const NOT_MEMBER = "You are not a participant in this event.";
    const member = db.prepare(MEMBER_SQL).get(comp.id, userId);
    if (!member) return res.status(403).json({ error: NOT_MEMBER });

    const tsId = _badgeTimeslot(comp, userId);

    // Idempotent: a prior badge is reused (the image is a point-in-time snapshot).
    //
    // v8.1.4 — AND IT RUNS BEFORE THE LIFECYCLE REFUSALS, which is a fix rather
    // than a tidy-up. AN ALREADY-MINTED BADGE IS A FACT, NOT A REQUEST TO MINT,
    // and every refusal below is about MINTING. With the not-ended 409 and the
    // dry-run 403 first, the PR 29 held-certificate CTA — which retrieves the
    // badge by re-POSTing here — told every existing holder "This competition has
    // not ended yet." for the whole of an admin REVIVE, a supported path; and a
    // dry-run tag applied after minting made their own certificate permanently
    // unreachable, with a refusal naming a state they cannot influence.
    //
    // The revocation check deliberately stays BELOW this: `_findBadge` filters
    // `revoked_at IS NULL`, so a revoked badge can never be returned here, and
    // the re-mint refusal is what stops the holder minting a replacement.
    const existing = _findBadge(userId, comp.id, tsId);
    if (existing) return res.json(_badgePayload(existing, { mayReadCodes: _participantMayReadCodes(req) }));

    // v8.1.0 (PR 27) — A REVOKED CERTIFICATE IS NOT RE-MINTABLE, and this refusal
    // is why the uniqueness index below it could safely become partial.
    //
    // `_findBadge` filters `revoked_at IS NULL`, so a revoked badge is invisible
    // above and the mint would proceed. Before PR 27 the INSERT then hit a
    // non-partial unique index and failed confusingly; making that index partial
    // WITHOUT this check would be strictly worse — the mint is
    // `requireParticipant`, so a participant whose certificate was revoked for
    // plagiarism could quietly obtain a fresh valid one with a fresh code,
    // audited as an ordinary mint. Lifting a revocation is an admin act.
    const revoked = db.prepare(
      "SELECT token FROM achievement_badges WHERE user_id=? AND competition_id=? AND IFNULL(timeslot_id,'')=IFNULL(?, '') AND revoked_at IS NOT NULL"
    ).get(userId, comp.id, tsId);
    if (revoked) {
      return res.status(403).json({
        error: "This certificate has been revoked. Please contact the organisers.",
        code: "revoked",
      });
    }

    // Server-authoritative eligibility — never trust a client-claimed rank, and
    // never spell this rule out here again: `_mintEligibility` is the ONE copy,
    // shared with the `claimable` list that offers this button (v8.1.4).
    //
    // v7.21.9 — `fresh`: this mint PERSISTS `rank` and `score_snapshot` into
    // achievement_badges, and a PUBLIC OpenGraph page plus the certificate PDF
    // render those for ever. Reading the 5-second leaderboard cache here meant a
    // mint in the seconds after a time-expiry or a duration-shrink end could
    // capture the pre-end board — and if the stale rank crossed the top-3
    // boundary that publishes a PLACEMENT badge ("3rd Place" + score) for someone
    // whose true finish was 4th, or the reverse. Immutable artefact, so it gets
    // an uncached read.
    const verdict = _mintEligibility(userId, comp, tsId, { fresh: true });
    if (!verdict.ok) return res.status(verdict.status).json(verdict.body);
    const { me, placement, basis, lateEntrant } = verdict;

    const { user, nickname, badgeName, nameMatchParts, badgeEnd, svg } = _mintInputs(userId, comp, tsId, verdict);

    // The share image is rendered here and never kept (`_NO_STORED_IMAGE`: every
    // view renders it on request). The render stays as the mint's check that the
    // artwork can be drawn now, so a deployment without its renderer refuses the
    // mint rather than issue a certificate nobody can download.
    try {
      await renderBadgePng(svg); // async: rasterises on the libuv threadpool, off the event loop
    } catch (e) {
      if (e instanceof BadgeRenderUnavailable) return res.status(503).json({ error: "Badge rendering is temporarily unavailable." });
      throw e;
    }

    // Test-only hold (resolves at once unless a test armed it): the render above
    // is the window, and it is milliseconds long for a test-sized badge.
    await testAdminCommitPark();
    const ts = now().toISOString();
    const token = _b64url(crypto.randomBytes(32));
    const publicCode = generateCredentialCode(crypto.randomBytes);
    let _hand = null, _sess = null, _gone = false;
    const persist = db.transaction(() => {
      // v8.1.0 — RE-CHECK REVOCATION INSIDE THE TRANSACTION. The check above runs
      // before `await renderBadgePng`, which yields the event loop for the length
      // of a rasterise; a revoke landing in that window would otherwise be
      // overtaken, and because the uniqueness index is partial on `revoked_at` the
      // INSERT succeeds — handing the revoked holder a fresh valid certificate
      // with a fresh code. Same shape as the v7.15.13 submit-path TOCTOU: when a
      // decision is made before an await, re-make it after.
      const revokedNow = db.prepare(
        "SELECT 1 FROM achievement_badges WHERE user_id=? AND competition_id=? AND IFNULL(timeslot_id,'')=IFNULL(?, '') AND revoked_at IS NOT NULL"
      ).get(userId, comp.id, tsId);
      if (revokedNow) { const e = new Error("revoked_mid_mint"); e._revokedMidMint = true; throw e; }
      // v8.12.6 (review fix) — UNDER IMPERSONATION, THE ADMIN AT THE KEYBOARD IS
      // RE-ASKED HERE, beside the revocation re-check above and for the same reason:
      // `impersonationGuard` read the acting admin when the headers arrived, and
      // the render above is an await. A regular admin's read-only session may
      // mint (the v8.3.25 carve-out, hence `readOnlyTier`), so this refuses only
      // an acting admin who lost admin access, or a session that ended, while
      // the certificate was being drawn.
      _hand = impersonatingHandDenied(req, { readOnlyTier: true });
      if (_hand) return;
      // AND THE SESSION AND ITS PERSON, for the same reason: the account's
      // lifecycle (the seat's under impersonation, answered with the forced
      // exit), the tombstone of a session acting as its own account, and the
      // membership the mint was admitted on — a participant removed from the
      // event while the certificate was drawn must not be issued one.
      _sess = participantSessionDenied(req);
      if (_sess) return;
      if (!db.prepare(MEMBER_SQL).get(comp.id, userId)) { _gone = true; return; }
      // ext-audit v7.15.6 — the score AS MINTED (`score_snapshot`): every
      // artefact behind the token renders from it, so a revived competition
      // moving scores cannot change a certificate already issued. Placement
      // badges are the only variant that shows a score.
      db.prepare(_BADGE_INSERT_SQL).run(..._badgeInsertValues({
        token, userId, comp, tsId, me, nickname, placement, badgeName, basis,
        nameMatchParts, publicCode, badgeEnd, lateEntrant, ts, grade: verdict.grade,
      }));
    });
    try {
      persist();
    } catch (e) {
      if (e && e._revokedMidMint) {
        return res.status(403).json({ error: "This certificate has been revoked. Please contact the organisers.", code: "revoked" });
      }
      // Lost a concurrent-mint race against the unique index — return the winner.
      const winner = _findBadge(userId, comp.id, tsId);
      if (winner) return res.json(_badgePayload(winner, { mayReadCodes: _participantMayReadCodes(req) }));
      throw e;
    }
    // The re-checks above wrote nothing; answered after the transaction because
    // ending or restoring a session is not a thing to do inside one.
    if (_hand) return sendImpersonationCommitDenial(req, res, _hand);
    if (_sess) return sendParticipantSessionDenial(req, res, _sess);
    if (_gone) return res.status(403).json({ error: NOT_MEMBER });
    // Forensic trail — a mint creates a PUBLIC, PII-bearing artifact (the /badge
    // OG page carries nickname/comp/date/placement). Record it on the per-comp
    // History + Logs, best-effort (never block the response) and AFTER commit
    // (so there's no rollback ghost-line risk; only fires on a genuine new mint,
    // not the idempotent re-fetch above).
    try {
      // v7.15.2 (audit) — tag an impersonated mint. This one matters most of the
      // three: minting publishes a PERMANENT public page carrying the
      // participant's nickname and placement, so without this the competition
      // History records that the participant published themselves.
      recordCompetitionEvent(comp.id, "badge_minted", (user && user.email) || "system", {
        user_id: userId, nickname, rank: me.rank, placement, ...reqContext(req),
        ...(isImpersonating(req) ? { impersonated_by: impersonationActor(req.session) } : {}),
      });
    } catch (e) {
      // audit is best-effort
      swallowed("badge:mint-audit", e);
    }
    // The notes (`name_fallback`, `salutation_dropped`) are the artwork
    // resolver's own decision, read in `_badgePayload` for this row as for a held
    // one, so the note and the picture cannot disagree.
    res.json(_badgePayload(db.prepare("SELECT * FROM achievement_badges WHERE token=?").get(token), { mayReadCodes: _participantMayReadCodes(req) }));
  });

  // ── Program grades: TRY AGAIN (owner decision, 27 Nov 2026) ─────────────────
  //
  // Under 60% a Program learner gets no certificate and is told to try the quiz
  // again: this starts a fresh attempt. Allowed only while the Program is live,
  // to a member who has finished below the pass mark and holds no certificate
  // (lib/program-grade.js `retakeRefusal`, asked again inside the write). The
  // attempt's answers and hints to the scoring challenges move to
  // `program_attempts` (nothing is deleted), and the retake is recorded on the
  // learner's History (`program_retake_started`, with the request's context).
  //
  // REFUSED UNDER IMPERSONATION, every tier: a fresh attempt made while viewing as
  // somebody must not count as theirs (the join's reason, 21 Nov 2026).
  app.post("/api/competitions/:id/program/retake", requireParticipant, rateLimit(60_000, 10, "program-retake"), csrfProtection, (req, res) => {
    const userId = req.session.userId;
    const comp = getCompetition(req.params.id);
    if (!comp) return res.status(404).json({ error: "Event not found" });
    if (isImpersonating(req)) {
      return res.status(403).json({ error: "While you view as this participant, the program cannot be started again for them.", code: "impersonation_retake_refused" });
    }
    const self = db.prepare("SELECT email FROM users WHERE id=?").get(userId);
    const out = startProgramRetake(userId, comp, { changedBy: (self && self.email) || "system", context: reqContext(req) });
    if (!out || !out.ok) {
      const r = out || { status: 409, code: "program_retake_refused", error: "The program could not be started again." };
      return res.status(r.status).json({ error: r.error, code: r.code });
    }
    res.json({
      ok: true,
      attempt: out.attempt,
      closed: { attempt: out.closed.attempt, points: out.closed.points, max: out.closed.max, permille: out.closed.permille,
        percent: formatGradePercent(out.closed.permille), band: out.closed.band, label: out.closed.label },
    });
  });

  // ── Certificate PDF (v7.15.0) ─────────────────────────────────────────────
  // A PDF alongside the PNG: it is what people actually attach to an email or
  // file with a training record. Public and keyed on the same capability token
  // as the badge page (so the certificate can be downloaded straight from the
  // public page without signing in) with the same uniform 404 — no
  // token-existence oracle — and the token is scrubbed from the access log by
  // `_scrubLogPath`'s `/badge/<token>` rule, which stops at the path separator
  // and so still redacts with this suffix appended.
  //
  // The artwork is regenerated from the SAME inputs the mint used rather than
  // stored: minting requires a fully-ended competition, so submissions have
  // stopped and the board is frozen, and the score printed is the one frozen at
  // mint (`score_snapshot`). Nothing a certificate renders is stored.
  // v7.21.30 — the share PNG is RENDERED ON REQUEST.
  //
  // It used to be rasterised once at mint and stored in `images`, and every view
  // served those frozen bytes — so a badge minted before an artwork change kept
  // the OLD design for ever, which is exactly what happened at v7.21.29. The
  // certificate PDF has always regenerated; the PNG now matches it, and the two
  // draw from one resolver so they cannot disagree.
  //
  // No mint stores a copy any more (`_NO_STORED_IMAGE`, sweep #43). A certificate
  // issued while mints still did keeps its copy, served only when the rasteriser
  // is missing; every other certificate then answers 503, as the PDF always has.
  // v8.1.0 (PR 26) — THE ARTEFACT ROUTES ARE DELIBERATELY NOT GATED on
  // `shared_at`, and this is not an oversight in the publish-on-share work.
  //
  // The PAGE is the crawlable, indexable surface — an `<h1>` naming the holder,
  // og tags, and no robots meta — so that is what stays unresolvable until the
  // holder shares. The PNG and the PDF are how the holder COLLECTS their
  // certificate from their own share dialog; gating them would make "Get my
  // certificate" unable to give them a certificate. They remain what they have
  // always been: capability URLs, reachable only by someone holding the token.
  // The token reaches the holder's own surfaces, the public page once its holder
  // shares it, and the congratulations email, which links the PDF (sweep #402:
  // that link is marked, so its fetches say they may be a mail scanner's).
  app.get("/badge/:token/badge.png", rateLimit(60_000, 60, "badge-png"), async (req, res) => {
    const row = db.prepare("SELECT * FROM achievement_badges WHERE token=? AND revoked_at IS NULL").get(req.params.token);
    const comp = row ? db.prepare("SELECT * FROM competitions WHERE id=?").get(row.competition_id) : null;
    // Same uniform 404 as the page and the certificate — no existence oracle.
    if (!row || !comp) return res.status(404).type("text/plain").send("Not found");

    let png;
    try {
      png = await renderBadgePng(buildBadgeSvg(_badgeArt(row, comp)));
    } catch (e) {
      if (!(e instanceof BadgeRenderUnavailable)) throw e;
      png = _storedBadgePng(row);
      if (!png) return res.status(503).json({ error: "Badge rendering is unavailable." });
    }
    // v7.21.31 — audit the DOWNLOAD, not every fetch. This same URL is the page's
    // og:image, so it is pulled by every page view and by every crawler
    // re-scrape; logging those would bury the one line an operator cares about
    // under machine traffic. The client's "Download image" link carries ?dl=1, so
    // a deliberate act is distinguishable from a render.
    if (req.query.dl) _recordBadgeDownload(req, row, comp, "badge_image_downloaded");
    res.type("image/png")
      // Short, deliberately. A crawler re-scrape should pick up an artwork change
      // rather than serving last year's design from a year-long cache.
      .set("Cache-Control", "public, max-age=300")
      .send(png);
  });

  // v7.21.31 — the LinkedIn share, recorded. The composer opens on linkedin.com,
  // so this POST is the only moment the platform can observe that a participant
  // actually shared. Token-keyed and CSRF-protected like every other write; it
  // deliberately does NOT require the caller to be the badge's owner, because the
  // same public link is shareable by anyone who has it — the event records who
  // clicked and whose badge it was, which is the honest pair.
  app.post("/badge/:token/shared", csrfProtection, rateLimit(60_000, 30, "badge-shared"), (req, res) => {
    const row = db.prepare("SELECT * FROM achievement_badges WHERE token=? AND revoked_at IS NULL").get(req.params.token);
    const comp = row ? db.prepare("SELECT * FROM competitions WHERE id=?").get(row.competition_id) : null;
    if (!row || !comp) return res.status(404).json({ error: "Not found" });
    _recordBadgeDownload(req, row, comp, "badge_shared");
    // v8.1.0 (PR 26) — PUBLISHING IS THE OWNER'S ACT, and this route is
    // TOKEN-authenticated: it has no `requireParticipant` and no ownership check,
    // because it exists to record that a share happened and the badge page is
    // public by design. Gating publication on it as-is would therefore let anyone
    // who was sent the link publish the page — a gate that is decorative.
    //
    // So the AUDIT keeps firing for every share click (that forensic record is
    // unchanged, and `by_owner` already distinguishes them), while only the
    // owner's click stamps `shared_at`. Written once: a page that has been
    // published stays published.
    const isOwner = !!req.session.userId && req.session.userId === row.user_id;
    if (isOwner && !row.shared_at) {
      db.prepare("UPDATE achievement_badges SET shared_at=? WHERE token=? AND shared_at IS NULL")
        .run(now().toISOString(), row.token);
    }
    res.json({ ok: true, published: isOwner || !!row.shared_at });
  });

  // ── Operator ruling, 29 Oct 2026 — THE LINKEDIN SHARE PAGE ────────────────────
  //
  // `:token` here is the ONE-TIME SHARE LINK from the congratulations email
  // (lib/certificate-share.js), never a badge token — it rides this path so the
  // existing `/badge/<capability>` log scrub covers it. The GET only SHOWS the
  // post (mail scanners fetch every link; consuming on GET would burn it); the
  // page's "Copy post & open LinkedIn" POST consumes it, once, and is the
  // holder's publish-on-share (`shared_at`, write-once) — the link is bound to
  // the certificate, so its POST stands for the owner's own Share.
  app.get("/badge/:token/post", rateLimit(60_000, 60, "badge-post-page"), (req, res) => {
    const share = require("../lib/certificate-share");
    const r = share.resolveShareLink(db, req.params.token);
    res.set("Cache-Control", "no-store").set("X-Robots-Tag", "noindex, nofollow").type("html");
    if (!r.ok && r.reason !== "used" && r.reason !== "expired") return res.status(404).send(_badgeNotFoundHtml());
    const comp = db.prepare("SELECT * FROM competitions WHERE id=?").get(r.badge.competition_id);
    if (!comp) return res.status(404).send(_badgeNotFoundHtml());
    const platformName = getPlatformName();
    if (!r.ok) {
      return res.status(410).send(_sharePageHtml({ platformName, spent: r.reason }));
    }
    const post = share.linkedinPostFor(db, r.badge, comp, { platformName });
    const csrfToken = String(require("../lib/middleware").generateToken(req)).replace(/[^a-zA-Z0-9_\-]/g, "");
    res.send(_sharePageHtml({ platformName, post, eventName: comp.name, csrfToken, linkToken: req.params.token }));
  });

  app.post("/badge/:token/post", csrfProtection, rateLimit(60_000, 30, "badge-post-use"), (req, res) => {
    const share = require("../lib/certificate-share");
    const r = share.resolveShareLink(db, req.params.token);
    if (!r.ok) {
      return res.json({ ok: false, reason: r.reason === "unknown" || r.reason === "revoked" ? "gone" : r.reason,
        error: r.reason === "used" ? `This link has already been used. To share again, ${CERTIFICATE_HOME}.`
          : r.reason === "expired" ? `This link has expired. To share again, ${CERTIFICATE_HOME}.`
          : "This link is not valid." });
    }
    const comp = db.prepare("SELECT * FROM competitions WHERE id=?").get(r.badge.competition_id);
    if (!comp) return res.json({ ok: false, reason: "gone", error: "This link is not valid." });
    if (!share.consumeShareLink(db, req.params.token)) {
      return res.json({ ok: false, reason: "used", error: `This link has already been used. To share again, ${CERTIFICATE_HOME}.` });
    }
    if (!r.badge.shared_at) {
      db.prepare("UPDATE achievement_badges SET shared_at=? WHERE token=? AND shared_at IS NULL").run(now().toISOString(), r.badge.token);
    }
    try {
      const owner = db.prepare("SELECT nickname FROM users WHERE id=?").get(r.badge.user_id);
      recordCompetitionEvent(comp.id, "badge_shared", "anonymous", {
        user_id: r.badge.user_id, nickname: owner && owner.nickname, rank: r.badge.rank,
        by_owner: true, via: "share_link", ...reqContext(req),
      });
    } catch (e) {
      // best-effort, as every badge retrieval audit
      swallowed("badge:share-audit", e);
    }
    const post = share.linkedinPostFor(db, r.badge, comp, { platformName: getPlatformName() });
    res.json({ ok: true, published: true, composerUrl: share.linkedinComposerUrl(post.text) });
  });

  // The same post for a signed-in holder's own certificate card (badge-share.js),
  // so both surfaces copy one text.
  app.get("/api/me/certificates/:token/linkedin-post", requireParticipant, rateLimit(60_000, 60, "my-cert-post"), (req, res) => {
    const row = db.prepare("SELECT * FROM achievement_badges WHERE token=? AND revoked_at IS NULL").get(req.params.token);
    // The post carries the certificate's code: viewed as the holder by an admin
    // who may not look codes up, the same 404 as an unknown token (a guessed
    // token is not confirmed).
    if (!row || row.user_id !== req.session.userId || !_participantMayReadCodes(req)) return res.status(404).json({ error: "Not found" });
    const comp = db.prepare("SELECT * FROM competitions WHERE id=?").get(row.competition_id);
    if (!comp) return res.status(404).json({ error: "Not found" });
    const share = require("../lib/certificate-share");
    const post = share.linkedinPostFor(db, row, comp, { platformName: getPlatformName() });
    res.set("Cache-Control", "no-store").json({ text: post.text, composerUrl: share.linkedinComposerUrl(post.text) });
  });

  app.get("/badge/:token/certificate.pdf", rateLimit(60_000, 30, "badge-pdf"), async (req, res) => {
    const row = db.prepare("SELECT * FROM achievement_badges WHERE token=? AND revoked_at IS NULL").get(req.params.token);
    const comp = row ? db.prepare("SELECT * FROM competitions WHERE id=?").get(row.competition_id) : null;
    if (!row || !comp) return res.status(404).type("text/plain").send("Not found");

    // v7.21.30 — the SAME resolver the PNG route uses, so one token can never
    // serve artwork and a certificate that disagree. What it carries and why:
    //
    //  • score_snapshot (v7.15.6/.7) — the score AS MINTED. Recomputing let a
    //    revived-and-re-ended competition produce a PDF contradicting the PNG.
    //    A legacy badge has no snapshot and the board it was drawn against is
    //    gone, so its score is omitted rather than guessed.
    //  • name_snapshot (v7.21.28) — the name AS MINTED, for the same reason now
    //    that the name is drawn into the artwork. A legacy badge falls back to
    //    the live name, keeping the v7.21.27 behaviour.
    //
    // The certificate uses the 3:2 canvas; the share image keeps LinkedIn's
    // OpenGraph ratio. The A4 page letterboxes this one, which is what printing
    // wants anyway.
    // v8.15.1 — through `_certificatePdfFor`, the one render the admin download
    // and the congratulations email's attachment also use.
    let out;
    try {
      out = await _certificatePdfFor(row, comp);
    } catch (e) {
      // Same posture as the PNG mint: a missing rasteriser is a 503, never a crash.
      if (e instanceof BadgeRenderUnavailable) return res.status(503).json({ error: "Certificate rendering is unavailable." });
      throw e;
    }
    const pdf = out.pdf;
    // Every request is recorded as a download: the certificate is embedded nowhere
    // and no page's og tags name it. But the congratulations email links it (the
    // PDF is also attached), and mail scanners and link prefetchers fetch every
    // link in a mail, signed out like the holder's own click from it. The mail's
    // link is marked (lib/certificate-dispatch.js `isCertificateMailLink`), so
    // those fetches are recorded `via: "email_link"`, and History says they may
    // be a scanner's rather than claim the holder took it (sweep #402). The mark
    // grants and changes nothing else: the token is the access.
    _recordBadgeDownload(req, row, comp, "badge_certificate_downloaded",
      certificateDispatch.isCertificateMailLink(req) ? { via: "email_link" } : null);
    res.type("application/pdf")
      .set("Content-Disposition", `attachment; filename="${out.filename}"`)
      .set("Cache-Control", "public, max-age=300")
      .send(pdf);
  });

  // ── Public OpenGraph page (no auth) — what LinkedIn crawls + a human lands on ─
  /**
   * A stable pseudonym for a credential code, for the audit trail.
   *
   * Lets an investigator group repeated lookups of ONE code — which is what the
   * record is for — without storing a value that can be replayed against
   * /credential. Truncated: 12 hex is ample to correlate within a log file and
   * useless as a credential.
   */
  function _codeFingerprint(code) {
    if (!code) return "(none)";
    return "cf_" + crypto.createHash("sha256").update(String(code)).digest("hex").slice(0, 12);
  }

  /** JSON.parse that answers null instead of throwing on a corrupt column. */
  function _safeJson(v) { try { return JSON.parse(v); } catch (_) { return null; } }

  /** The kind's human label, or nothing when the vocabulary cannot name it. */
  function eventKindLabelServer(comp) {
    try { return (EVENT_KINDS.find(k => k.value === eventKind(comp)) || {}).label || null; }
    catch (_) { return null; }
  }

  /**
   * v8.1.1 — has the holder's name actually MOVED since this certificate was
   * issued?
   *
   * BOTH SIDES ARE THE SAME SHAPE, and that is the whole fix. The frozen parts
   * are given + family only, while the printed name PREPENDS `personal_title` —
   * and `credentialNameKey` strips punctuation but keeps letters, so "Dr."
   * survives as "dr" and `janedoe` differed from `drjanedoe` deterministically.
   * Every holder who had ever picked a salutation — an ordinary optional profile
   * field with seven presets — was told on a trust document that their name had
   * changed, on a certificate naming them byte-for-byte as minted. So the
   * comparison is frozen parts against the parts TODAY's render would freeze,
   * never against the printed string. A salutation is not part of the identity
   * /credential matches on and must not take part here either.
   *
   * No frozen record (a pre-PR-25 badge) or no live name at all means NO CLAIM: a
   * page that cannot know must not assert that something changed. What the page
   * DISPLAYS is untouched — it shows the current name and discloses a genuine
   * change, which is the settled v8.1.0 decision.
   */
  function _credentialNameChanged(frozen, live) {
    if (!frozen || !live) return false;
    const f = `${frozen.given} ${frozen.family}`, l = `${live.given} ${live.family}`;

    // v8.8.18 — THE DISCLOSURE MUST NOT CONTRADICT THE LOOKUP. Once
    // `credentialMatchKeys` accepts `Mueller` for a certificate frozen as
    // `Müller`, declaring that same pair a CHANGED NAME on the page beside it
    // would have the platform assert two things at once. So the tolerance here
    // is exactly the lookup's and no wider.
    //
    // The primary equality is tested FIRST and is not merely an optimisation:
    // it is what keeps `Müller` vs `Muller` unchanged (their digraph forms
    // DIFFER — `mueller` against `muller`), and what keeps two names with no
    // usable key at all from reading as a change against each other.
    if (credentialNameKey(f) === credentialNameKey(l)) return false;
    return credentialNameKeyDigraph(f) !== credentialNameKeyDigraph(l);
  }

  /**
   * The verification page. Server-rendered and works with JavaScript disabled:
   * a verifier is a stranger meeting the platform once, often on a phone, and
   * often inside a corporate browser policy.
   */
  function _credentialPageHtml(verdict, { code = "" } = {}) {
    const E = escapeHtml;
    const platform = getPlatformName();
    let result = "";
    if (verdict && verdict.throttled) {
      result = `<div class="cred-card cred-warn" role="alert">
        <h2>Too many attempts</h2>
        <p>Please wait a little while and try again. If you are checking several certificates, they are counted separately.</p>
      </div>`;
    } else if (verdict && verdict.found) {
      const rows = [
        ["Name", verdict.name],
        [verdict.kind || "Event", verdict.competitionName],
        ["Awarded for", verdict.label],
        // v8.6.0 — the certificate says "LATE ENTRANT" on its face, so the page a
        // verifier reads has to say it too: a document and its own verification
        // disagreeing about what it attests is the worst answer this page can give.
        // A row rather than a footnote, because it is a fact ABOUT the award and
        // belongs beside the other facts.
        ...(verdict.lateEntrant ? [["Entry", "Late entrant"]] : []),
        ["Date", verdict.dateLabel],
        ...(verdict.scoreLabel ? [["Score", verdict.scoreLabel]] : []),
        // Program grades (27 Nov 2026): the grade the certificate prints, frozen.
        ...(verdict.grade ? [["Grade", `${verdict.grade.label} (${verdict.grade.percent})`]] : []),
        ["Code", verdict.code],
      ].filter(([, v]) => v);
      result = `<div class="cred-card ${verdict.revoked ? "cred-revoked" : "cred-ok"}" role="status">
        <h2>${verdict.revoked ? "This certificate has been revoked" : "Certificate verified"}</h2>
        ${verdict.revoked ? `<p class="cred-note">It was issued by ${E(platform)}, and is no longer valid.</p>` : ""}
        <dl class="cred-facts">${rows.map(([k, v]) => `<dt>${E(k)}</dt><dd>${E(String(v))}</dd>`).join("")}</dl>
        ${verdict.nameChanged ? `<p class="cred-note">The holder's name has changed since this certificate was issued; the current name is shown.</p>` : ""}
      </div>`;
    } else if (verdict) {
      // THE ONE ANSWER A FAILURE EVER GIVES. A wrong surname and an unknown code
      // are the same response, so the code alone never reveals who holds it.
      result = `<div class="cred-card cred-warn" role="alert">
        <h2>No matching certificate</h2>
        <p>Check the code and the surname exactly as they appear on the certificate, then try again.</p>
      </div>`;
    }
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Verify a certificate — ${E(platform)}</title>
<link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/verify-pages.css">
</head><body>
<main class="cred-main" role="main">
  <h1>Verify a certificate</h1>
  <p class="cred-lead">Enter the code printed on the certificate and the holder's surname.</p>
  ${result}
  <form class="cred-form" method="post" action="/credential">
    <div class="form-group">
      <label for="cred-code">Certificate code</label>
      <input id="cred-code" name="code" value="${E(code)}" autocomplete="off" spellcheck="false"
             inputmode="latin" required aria-describedby="cred-code-hint" maxlength="32">
      <p class="cred-hint" id="cred-code-hint">12 characters, as printed &mdash; for example ABCD-EFGH-JKMN.</p>
    </div>
    <div class="form-group">
      <label for="cred-surname">Holder&rsquo;s surname</label>
      <input id="cred-surname" name="surname" autocomplete="off" required aria-describedby="cred-surname-hint" maxlength="100">
      <p class="cred-hint" id="cred-surname-hint">Accents and capitals do not matter. A Chinese, Japanese or Korean name printed as one word begins with the surname: type the whole name as printed, without a title such as Dr., or only the surname, for example 张伟 or 张.</p>
    </div>
    <button type="submit" class="btn">Verify</button>
  </form>
</main>
</body></html>`;
  }

  // v8.1.0 (PR 29) — THE CERTIFICATE'S HOME.
  //
  // Until this endpoint there was none. The only route to a certificate was the
  // CTA on the leaderboard — and PR 18 hides the Leaderboard tab for a kind with
  // no ranking, so a Program participant could earn a certificate and have no way
  // whatsoever to reach it. The document existed and its owner could not get it.
  //
  // Lists what this participant HOLDS, plus what they could claim right now, so
  // one call drives the whole surface.
  app.get("/api/me/certificates", requireParticipant, rateLimit(60_000, 60, "my-certificates"), (req, res) => {
    const userId = req.session.userId;
    // v8.8.6 — narrowed for an event-admin impersonation session, and it ships with
    // the mint above rather than after it: this payload hands over the badge TOKEN,
    // which is a live capability opening the PNG, the PDF and the public page with
    // no auth at all. Leaving the list unscoped while scoping the mint would close
    // the write and leave the read wide open.
    //
    // Spliced into the SQL rather than filtered afterwards, so the empty-scope arm
    // is expressible: an organiser with no grants matches nothing rather than
    // everything.
    const _impIds = impersonatorScopedCompetitionIds(req);
    const _certScope = _impIds === null
      ? { clause: "", params: [] }
      : (_impIds.length
        ? { clause: " AND b.competition_id IN (SELECT value FROM json_each(?))", params: [JSON.stringify(_impIds)] }
        : { clause: " AND 1=0", params: [] });
    const rows = db.prepare(
      `SELECT b.*, c.name AS competition_name, c.event_kind
         FROM achievement_badges b JOIN competitions c ON c.id = b.competition_id
        WHERE b.user_id = ?${_certScope.clause} ORDER BY b.created_at DESC`
    ).all(userId, ..._certScope.params);

    const _floor = _badgeShareGateFloor();
    const _mails = certificateDispatch.certificateEmailStates(rows.map(r => r.token));
    // Viewed as this participant by an admin who may not look codes up: no code,
    // no token and no links (operator ruling, 23 Nov 2026).
    const _mayCode = _participantMayReadCodes(req);
    const held = rows.map((row) => {
      const comp = getCompetition(row.competition_id);
      const art = comp ? _badgeArt(row, comp) : null;
      return {
        ...(_mayCode ? { token: row.token } : { withheld: true }),
        // v8.1.4 — THE ID, because `claimable` has always carried one and this
        // did not, so the client was left matching the held certificate by NAME.
        // `competitions.name` has no uniqueness constraint, so a participant
        // viewing one of two identically-named events — a recurring programme is
        // the ordinary case — was shown the OTHER event's issue date and
        // credential code under this one's heading, and the button beneath it then
        // POSTed the mint for the event they were actually looking at and was
        // correctly refused, contradicting the card directly above it.
        competitionId: row.competition_id,
        competitionName: row.competition_name,
        kind: (EVENT_KINDS.find(k => k.value === eventKind(comp || row)) || {}).label || null,
        label: badgeBasisLabel(row.basis, row.rank),
        basis: row.basis || null,
        // v8.6.0 — frozen at mint, so a held certificate is labelled by what it
        // says rather than by what the event's schedule now implies.
        lateEntrant: !!row.late_entrant,
        dateLabel: art ? art.dateLabel : null,
        // The name THIS certificate prints, from the resolver every artefact
        // reads, so the Leaderboard card's rendition of it names the holder as
        // the certificate does (family name first for a Chinese, Japanese or
        // Korean name, the nickname where the fonts cannot draw the name).
        name: art ? art.displayName : null,
        revoked: !!row.revoked_at,
        // Whether the PUBLIC page is live — from the ONE predicate the page
        // itself uses, never a restatement of it. Since v8.6.2 no badge of any
        // kind publishes until its holder shares, so this is the participant's
        // answer to "can anyone find this?".
        published: !_badgePageWithheld(row, _floor),
        ...(_mayCode && row.public_code ? { code: formatCredentialCode(row.public_code) } : {}),
        // v8.15.1 — what the certificate says (tier, rank, frozen score) and when
        // it was issued, so the list can name every certificate without a fetch.
        tier: _certificateFacts(row).tier,
        // Program grades — the band and percentage it was issued with (null without).
        grade: _frozenGrade(row),
        rank: row.rank,
        score: _certificateFacts(row).score,
        issuedAt: row.created_at,
        // v8.15.1 — when the congratulations email carrying it was delivered, or
        // null (never sent, opted out, or not delivered yet).
        emailedAt: _mails.get(row.token)?.sent_at || null,
        // v8.15.1 — a REVOKED certificate gets no download links: every artefact
        // route answers its uniform 404 for one, so offering them was a dead link.
        ...(row.revoked_at || !_mayCode ? {} : {
          badgeUrl: `${BASE_URL}/badge/${row.token}`,
          imageUrl: `${BASE_URL}/badge/${row.token}/badge.png`,
          pdfUrl: `${BASE_URL}/badge/${row.token}/certificate.pdf`,
        }),
      };
    });

    // CLAIMABLE: events this participant could mint from right now.
    //
    // v8.1.4 — through `_mintEligibility`, i.e. the mint's OWN predicate rather
    // than a second statement of it. This block used to re-derive the rule and had
    // already drifted: it was tag-blind, so a benchmark participant was offered a
    // certificate the mint then refused with an untrue reason (see the helper).
    // The v7.14.2 rule is that the affordance and its outcome agree, and the only
    // way to keep two surfaces agreeing is for there to be one rule.
    const have = new Set(rows.map(r => r.competition_id));
    const claimable = [];
    for (const m of db.prepare("SELECT competition_id FROM competition_users WHERE user_id=?").all(userId)) {
      if (have.has(m.competition_id)) continue;
      // v8.8.6 — the OFFER is narrowed with the list, or the organiser is invited
      // to mint exactly the certificate the route above now refuses.
      if (_impIds !== null && !_impIds.includes(m.competition_id)) continue;
      const comp = getCompetition(m.competition_id);
      if (!comp) continue;
      // Cached board read: an offer persists nothing, so it does not need — and
      // should not pay for — the mint's uncached build. See the helper.
      const _verdict = _mintEligibility(userId, comp, _badgeTimeslot(comp, userId));
      if (!_verdict.ok) continue;
      claimable.push({
        competitionId: comp.id,
        competitionName: comp.name,
        kind: (EVENT_KINDS.find(k => k.value === eventKind(comp)) || {}).label || null,
        // v8.6.0 — the OFFER carries the two facts that shape what the button
        // promises, from the SAME verdict the mint will use rather than a second
        // reading of the rule. `latePlacementPending` is the one that has to be
        // said out loud: a top-3 late entrant collecting now takes a PARTICIPATION
        // certificate and keeps it, because the mint is idempotent — so the CTA
        // must state that before the click rather than after it (v7.14.2).
        lateEntrant: !!_verdict.lateEntrant,
        latePlacementPending: !!_verdict.latePlacementPending,
      });
    }
    // PROGRAM GRADES (owner decision, 27 Nov 2026) — "the program should tell you
    // where you stand": for each Program this learner is in (narrowed as the list
    // is), their grade now, whether it counts yet (finished), and whether Try
    // again is open to them, from the route's own predicate (`retakeRefusal`), so
    // the button is offered exactly where the route accepts it.
    const programs = [];
    for (const m of db.prepare("SELECT competition_id FROM competition_users WHERE user_id=?").all(userId)) {
      if (_impIds !== null && !_impIds.includes(m.competition_id)) continue;
      const comp = getCompetition(m.competition_id);
      if (!comp || !programGraded(comp)) continue;
      const st = programStanding(userId, comp);
      const refused = st.grade ? retakeRefusal(userId, comp, st) : null;
      programs.push({
        competitionId: comp.id,
        competitionName: comp.name,
        finished: st.finished,
        attempt: st.attempt,
        passPercent: PASS_PERCENT,
        grade: st.grade ? {
          points: st.grade.points, max: st.grade.max, permille: st.grade.permille,
          percent: formatGradePercent(st.grade.permille), band: st.grade.band, label: st.grade.label, passed: st.grade.passed,
        } : null,
        canRetake: !!st.grade && !refused,
        // Closed attempts (Try again), oldest first: the grade each ended on.
        previousAttempts: closedAttemptGrades(comp.id, userId).map(a => ({
          attempt: a.attempt_no, points: a.points, max: a.max_points, permille: a.grade_permille,
          percent: formatGradePercent(a.grade_permille), band: a.grade_band, label: gradeLabel(a.grade_band), closedAt: a.closed_at,
        })),
      });
    }
    res.json({ certificates: held, claimable, programs });
  });

  // ── Program grades: THE ORGANISERS' VIEW (owner decision, 27 Nov 2026) ───────
  //
  // Each learner's grade in a Program, for the Rankings pane's Progress card: the
  // current attempt (whether it counts yet: Finished), how many attempts they
  // have closed with Try again, and the certificate they hold. The people the
  // boards leave out (staff, benchmark, off-board roles) are left out here too.
  // Scoped like the certificate list (404, then `competitionDenied`); 400 for an
  // event that is not graded.
  app.get("/api/admin/competitions/:id/grades", requireAdmin, rateLimit(60_000, 60, "admin-grades"), (req, res) => {
    const comp = getCompetition(req.params.id);
    if (!comp) return res.status(404).json({ error: "Event not found" });
    const denied = competitionDenied(req, comp.id);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    if (!programGraded(comp)) return res.status(400).json({ error: "Only a Program is graded.", code: "not_a_program" });
    const members = db.prepare(
      `SELECT u.id, u.nickname, u.first_name, u.last_name, u.email FROM competition_users cu JOIN users u ON u.id = cu.user_id
        WHERE cu.competition_id = ?`
    ).all(comp.id);
    const off = getStaffOrBenchmarkSet(members.map(m => m.id), { staffCompete: staffCompeteOn(comp) });
    const held = new Map(db.prepare("SELECT * FROM achievement_badges WHERE competition_id=? AND revoked_at IS NULL").all(comp.id).map(b => [b.user_id, b]));
    const closed = new Map(db.prepare("SELECT user_id, COUNT(*) AS n FROM program_attempts WHERE competition_id=? GROUP BY user_id").all(comp.id).map(r => [r.user_id, r.n]));
    const rows = members.filter(m => !off.has(m.id)).map((m) => {
      const st = programStanding(m.id, comp);
      const b = held.get(m.id);
      return {
        userId: m.id, nickname: m.nickname || null, firstName: m.first_name || null, lastName: m.last_name || null, email: m.email || null,
        finished: st.finished,
        attempt: st.attempt,
        previousAttempts: closed.get(m.id) || 0,
        grade: st.grade ? {
          points: st.grade.points, max: st.grade.max, permille: st.grade.permille, percent: formatGradePercent(st.grade.permille),
          band: st.grade.band, label: st.grade.label, passed: st.grade.passed,
        } : null,
        certificate: b ? { issuedAt: b.created_at, grade: _frozenGrade(b) } : null,
      };
    });
    rows.sort((a, b) => ((b.grade ? b.grade.permille : -1) - (a.grade ? a.grade.permille : -1))
      || String(a.nickname || "").localeCompare(String(b.nickname || ""), undefined, { sensitivity: "base" })
      || String(a.userId).localeCompare(String(b.userId)));
    res.json({ passPercent: PASS_PERCENT, maxPoints: programMaxPoints(comp.id), rows });
  });

  // ── v8.15.1 — ADMIN: THE CERTIFICATES ISSUED FOR AN EVENT ─────────────────────
  //
  // The organiser's view of who holds what (the top three first), whether the
  // congratulations email reached them, and a download of any issued
  // certificate. Scoped like every event door: an event admin sees only their own
  // events. The badge TOKEN — the public capability behind the page, the PNG and
  // the PDF — is never on this payload except for a superadmin (the revoke route
  // takes it); downloads go through the admin routes below instead, which are
  // session-gated, `no-store`, and audited with `by_owner: false`. The credential
  // CODE rides a row only for a reader who may look certificates up by code
  // (`_certificateCode`).
  app.get("/api/admin/competitions/:id/certificates", requireAdmin, rateLimit(60_000, 60, "admin-certificates"), (req, res) => {
    const gate = _adminCertificateGate(req, res);
    if (gate.sent) return gate.sent;
    const comp = gate.comp;
    const rows = db.prepare(
      `SELECT b.*, u.id AS u_id, u.nickname AS u_nickname, u.first_name AS u_first_name, u.last_name AS u_last_name, u.email AS u_email,
              u.personal_title AS u_personal_title, u.certificate_given_name AS u_certificate_given_name, u.certificate_family_name AS u_certificate_family_name
         FROM achievement_badges b LEFT JOIN users u ON u.id = b.user_id
        WHERE b.competition_id = ?
        ORDER BY (b.revoked_at IS NOT NULL), CASE WHEN b.basis='placement' OR (b.basis IS NULL AND b.rank BETWEEN 1 AND 3) THEN 0 ELSE 1 END,
                 b.rank, b.created_at, b.token`
    ).all(comp.id);
    // The token (a permanent link to the holder's PDF, and the revoke route's
    // key) goes to a superadmin only; "Issue again" is answered to whoever may
    // revoke (a superadmin, or a custom role holding the permission).
    const sa = !!req.session.isSuperAdmin;
    const canRevoke = actorPermissions(req).perms.has("certificates.revoke");
    const mayCode = _mayReadCodes(req);
    const base = `/api/admin/competitions/${encodeURIComponent(comp.id)}/certificates`;
    // "Issue again" is answered on ONE revoked certificate per participant and
    // board where no live one stands, for an actor the route admits (it may
    // revoke, and is not competing): `canIssueAgain`, or the route's refusal as
    // `issueAgainRefused` (`_issueAgainRefusal`, the route's own checks), so the
    // list never offers what the route refuses nor withholds it unexplained.
    const _mayReissue = canRevoke && !competitorEditDenied(db, competitorIds(req), comp.id);
    const _summary = req.query.summary === "1";
    const _liveKeys = new Set(rows.filter(r => !r.revoked_at).map(r => `${r.user_id}|${r.timeslot_id || ""}`));
    const _answered = new Set();
    const _issueAgain = (row) => {
      if (!_mayReissue || !row.revoked_at) return {};
      const key = `${row.user_id}|${row.timeslot_id || ""}`;
      if (_liveKeys.has(key) || _answered.has(key)) return {};
      _answered.add(key);
      const code = _issueAgainRefusal(row.user_id, comp);
      return code ? { issueAgainRefused: _reissueRefusal(code)[1] } : { canIssueAgain: true };
    };
    // ONE ledger query and ONE settings read for the whole list, never one per row.
    const _floor = _badgeShareGateFloor();
    const _mails = certificateDispatch.certificateEmailStates(rows.map(r => r.token));
    const certificates = rows.map((row) => {
      const mail = _mails.get(row.token) || null;
      // The holder's users row, from the join (no query per certificate).
      const owner = row.u_id ? {
        nickname: row.u_nickname, personal_title: row.u_personal_title, first_name: row.u_first_name, last_name: row.u_last_name,
        certificate_given_name: row.u_certificate_given_name, certificate_family_name: row.u_certificate_family_name,
      } : null;
      return {
        userId: row.user_id,
        nickname: row.u_nickname || row.nickname_snapshot || null,
        firstName: row.u_first_name || null,
        lastName: row.u_last_name || null,
        // The name THIS certificate prints (`_heldName`, the rule its artwork
        // reads), so the list names the holder as the certificate does: family
        // name first for a Chinese, Japanese or Korean name, the nickname where
        // the certificate prints it. The browser never composes it.
        name: _heldName(row, owner).displayName || null,
        email: row.u_email || null,
        ..._certificateFacts(row),
        ..._certificateCode(row, mayCode),
        revoked: !!row.revoked_at,
        revokedAt: row.revoked_at || null,
        published: !_badgePageWithheld(row, _floor),
        emailStatus: mail ? {
          status: mail.status, attempts: mail.attempts, sentAt: mail.sent_at || null,
          lastError: mail.last_error || null, nextAttemptAt: mail.next_attempt_at || null, updatedAt: mail.updated_at,
        } : null,
        ...(row.revoked_at ? {} : {
          pdfUrl: `${base}/${encodeURIComponent(row.user_id)}/certificate.pdf`,
          imageUrl: `${base}/${encodeURIComponent(row.user_id)}/badge.png`,
        }),
        ...(sa ? { token: row.token } : {}),
        ...(_summary ? {} : _issueAgain(row)),
      };
    });
    const cfg = resolveCertificateConfig(db, comp.id);
    // The figures a summary shows (the workspace Overview), counted here so a
    // caller that needs only them can ask `?summary=1` and skip the rows.
    const _live = certificates.filter(c => !c.revoked);
    const counts = {
      issued: _live.length,
      revoked: certificates.length - _live.length,
      emailed: _live.filter(c => c.emailStatus && c.emailStatus.status === "sent").length,
      failed: _live.filter(c => c.emailStatus && c.emailStatus.status === "failed").length,
    };
    res.set("Cache-Control", "no-store").json({
      competitionId: comp.id,
      emailEnabled: !!(cfg.email && cfg.email.enabled),
      // Why the dispatcher would issue nothing for this event if it ran now
      // (`automaticIssueRefusal`: email_disabled, ended_before_floor, dry_run,
      // no_floor), or null. A job still waiting (`pending`) is no promise while
      // this is set: the dispatcher decides when it runs.
      automaticRefusal: certificateDispatch.automaticIssueRefusal(comp),
      pending: certificateDispatch.pendingDispatchFor(comp.id).map(j => ({
        scope: j.user_id ? "participant" : "event", reason: j.reason, dueAt: j.due_at,
      })),
      counts,
      ...(_summary ? {} : { certificates }),
    });
  });

  // An issued certificate's PDF / share image, for an organiser. Same render as
  // the holder's own download; recorded on the event's History as a download
  // with `by_owner: false` (and the admin as the actor).
  app.get("/api/admin/competitions/:id/certificates/:userId/certificate.pdf", requireAdmin, rateLimit(60_000, 30, "admin-certificate-pdf"), async (req, res) => {
    const gate = _adminCertificateGate(req, res);
    if (gate.sent) return gate.sent;
    const row = _heldCertificate(gate.comp.id, req.params.userId);
    if (!row) return res.status(404).json({ error: "This participant holds no issued certificate for this event.", code: "no_certificate" });
    let out;
    try {
      out = await _certificatePdfFor(row, gate.comp);
    } catch (e) {
      if (e instanceof BadgeRenderUnavailable) return res.status(503).json({ error: "Certificate rendering is unavailable." });
      throw e;
    }
    _recordBadgeDownload(req, row, gate.comp, "badge_certificate_downloaded");
    res.type("application/pdf")
      .set("Content-Disposition", `attachment; filename="${out.filename}"`)
      .set("Cache-Control", "private, no-store")
      .send(out.pdf);
  });

  app.get("/api/admin/competitions/:id/certificates/:userId/badge.png", requireAdmin, rateLimit(60_000, 30, "admin-certificate-png"), async (req, res) => {
    const gate = _adminCertificateGate(req, res);
    if (gate.sent) return gate.sent;
    const row = _heldCertificate(gate.comp.id, req.params.userId);
    if (!row) return res.status(404).json({ error: "This participant holds no issued certificate for this event.", code: "no_certificate" });
    let png;
    try {
      png = await renderBadgePng(buildBadgeSvg(_badgeArt(row, gate.comp)));
    } catch (e) {
      if (!(e instanceof BadgeRenderUnavailable)) throw e;
      png = _storedBadgePng(row);
      if (!png) return res.status(503).json({ error: "Badge rendering is unavailable." });
    }
    _recordBadgeDownload(req, row, gate.comp, "badge_image_downloaded");
    res.type("image/png")
      .set("Content-Disposition", `attachment; filename="certificate-${row.rank}.png"`)
      .set("Cache-Control", "private, no-store")
      .send(png);
  });

  // Re-send one participant's congratulations email now. An explicit act, so it
  // runs even with the event's email switch off; an opted-out address is still
  // honoured (reported, never overridden). 200 with `ok:false` for a delivery
  // that did not happen, so the client branches on the payload.
  app.post("/api/admin/competitions/:id/certificates/resend", requireAdmin, rateLimit(60_000, 30, "admin-certificate-resend"), csrfProtection, async (req, res) => {
    const gate = _adminCertificateGate(req, res, { write: true });
    if (gate.sent) return gate.sent;
    const userId = req.body?.userId;
    if (typeof userId !== "string" || !userId) {
      return res.status(400).json({ error: "Name the participant as { userId }.", code: "user_id_required" });
    }
    const row = _heldCertificate(gate.comp.id, userId);
    if (!row) return res.status(404).json({ error: "This participant holds no issued certificate for this event.", code: "no_certificate" });
    // A blocked, denied or unapproved account is not mailed (sweep #212): it is
    // refused here, before the render, and asked again after it at the send.
    if (_accountNeverIssued(db.prepare("SELECT blocked, denied_at, approved FROM users WHERE id=?").get(userId))) {
      return res.status(409).json({ error: "Not sent: this participant's account is blocked, denied or not approved.", code: "account_inactive" });
    }
    // The send awaits a PDF render, so the admin is re-asked AFTER it, at the send
    // (`recheck`, run synchronously just before the mail goes out): an admin
    // blocked, demoted or deleted meanwhile sends nothing.
    const p = trackDetachedSend(certificateDispatch.resendCertificateEmail(row, gate.comp, {
      actor: getAdminIdentity(req), context: { ...reqContext(req) },
      recheck: () => adminAuthzDenied(req),
    }));
    let timer;
    const deadline = new Promise(r => { timer = setTimeout(() => r({ status: "deferred" }), 10_000); if (timer.unref) timer.unref(); });
    const out = await Promise.race([p, deadline]);
    clearTimeout(timer);
    if (out.status === "refused") {
      return res.status(out.refusal.status).json({ error: out.refusal.error, code: out.refusal.code });
    }
    if (out.status === "in_flight") {
      return res.status(409).json({ error: "This certificate's email is being sent right now. Check again in a moment.", code: "certificate_email_in_flight" });
    }
    if (out.status === "sent") return res.json({ ok: true, status: "sent" });
    if (out.status === "deferred") return res.json({ ok: true, status: "sending", deferred: true });
    if (out.status === "suppressed") {
      return res.json({ ok: false, status: "suppressed", error: "Not sent: this participant has unsubscribed from these emails. They can still download the certificate from the event's Challenges page." });
    }
    return res.json({ ok: false, status: "failed", error: "The email could not be delivered. It is recorded on the participant's History; try again later." });
  });

  // ISSUE AGAIN (operator ruling, 17 Nov 2026). Issued certificates never change
  // by themselves: a revive that moves the placings leaves them as issued. After a
  // superadmin revokes one, this issues a NEW certificate from the event's current
  // results: a new code, the revoked one still resolving as revoked. It is the
  // only way past a revocation: the holder's own "Get my certificate" stays
  // refused (a revocation can be for misconduct) and the automatic issue never
  // replaces a revoked certificate. The steps are the automatic issue's
  // (`_autoIssueCertificate` with `reissue`), so eligibility is the mint's; the
  // email goes through the dispatcher (a per-person job), so the event's email
  // switch, retries and never-twice apply.
  const _HELD = "They already hold a live certificate for this event. Revoke it first to issue a new one.";
  app.post("/api/admin/competitions/:id/certificates/reissue", requireAdmin, requireSuperAdmin, destructiveAdminLimit, csrfProtection, async (req, res) => {
    const gate = _adminCertificateGate(req, res, { write: true });
    if (gate.sent) return gate.sent;
    const comp = gate.comp;
    const userId = req.body?.userId;
    if (typeof userId !== "string" || !userId) {
      return res.status(400).json({ error: "Name the participant as { userId }.", code: "user_id_required" });
    }
    const tsId = _badgeTimeslot(comp, userId);
    if (_findBadge(userId, comp.id, tsId)) return res.status(409).json({ error: _HELD, code: "certificate_held" });
    const revoked = db.prepare(
      "SELECT basis, rank FROM achievement_badges WHERE user_id=? AND competition_id=? AND IFNULL(timeslot_id,'')=IFNULL(?, '') AND revoked_at IS NOT NULL ORDER BY revoked_at DESC LIMIT 1"
    ).get(userId, comp.id, tsId);
    if (!revoked) return res.status(404).json({ error: "This participant holds no revoked certificate for this event.", code: "no_revoked_certificate" });
    let r;
    try {
      // The render is an await: the acting admin is re-asked inside the write.
      r = await _autoIssueCertificate(userId, comp, { reissue: { recheck: () => adminAuthzDenied(req, { perm: "certificates.revoke" }) } });
    } catch (e) {
      if (e instanceof BadgeRenderUnavailable) return res.status(503).json({ error: "Certificate rendering is unavailable." });
      throw e;
    }
    if (r.skip && r.denied) return res.status(r.denied.status).json({ error: r.denied.error, code: r.denied.code });
    if (r.defer || r.skip) {
      const code = r.defer ? "late_entry_open" : r.skip;
      const [st, msg] = _reissueRefusal(code);
      return res.status(st).json({ error: msg, code });
    }
    if (!r.minted) return res.status(409).json({ error: _HELD, code: "certificate_held" });   // a racing issue won
    const actor = getAdminIdentity(req);
    try {
      recordUserEvent(userId, "badge_reissued", actor, {
        competition_id: comp.id, competition_name: comp.name, basis: r.row.basis, rank: r.row.rank,
        previous_basis: revoked.basis || null, previous_rank: revoked.rank == null ? null : revoked.rank, ...reqContext(req),
      });
    } catch (e) { swallowed("badge:reissue-audit", e); }
    try {
      recordCompetitionEvent(comp.id, "badge_minted", actor, {
        user_id: userId, nickname: r.nickname, rank: r.rank, placement: r.placement, via: "reissue", ...reqContext(req),
      });
    } catch (e) { swallowed("badge:reissue-mint-audit", e); }
    // Mailed now, detached (like Resend), with the event's email switch honoured.
    // An opted-out holder's send is recorded as suppressed, and the answer says
    // no email is on its way.
    const send = certificateDispatch.sendReissuedCertificate(r.row, comp, { actor, context: { ...reqContext(req) } });
    if (send) trackDetachedSend(send.catch((e) => swallowed("badge:reissue-send", e)));
    return res.json({ ok: true, certificate: { userId, ..._certificateFacts(r.row), ..._certificateCode(r.row, _mayReadCodes(req)) }, emailQueued: !!send && !certificateDispatch.holderOptedOut(userId) });
  });

  // v8.1.0 (PR 29) — resolve a code to its HOLDER. SUPERADMIN ONLY.
  //
  // This is the deliberate bypass of the name gate that /credential exists to
  // enforce, so it sits at the tier that can already delete a participant. The
  // sharper reason is the log surface: a credential code can reach app.jsonl and
  // access-*.jsonl, and any REGULAR admin can read those through
  // GET /api/admin/logs — so an admin-tier resolver would hand every admin a
  // code-to-holder path across every event that has ever run. For the same reason
  // the admin certificate lists carry a code only for this route's permission
  // (`_certificateCode`); a regular admin still downloads any certificate of an
  // event they can open, one audited PDF at a time.
  app.get("/api/admin/credential/:code", requireAdmin, requireSuperAdmin, rateLimit(60_000, 30, "credential-resolve"), (req, res) => {
    const code = normaliseCredentialCode(req.params.code);
    if (!code) return res.status(400).json({ error: "That is not a usable certificate code." });
    const row = db.prepare("SELECT * FROM achievement_badges WHERE public_code=?").get(code);
    // A role scoped to its events reaches this route by holding Look up a
    // certificate by its code, and finds only its own events' certificates; one
    // from another event answers exactly as an unknown code, so the lookup says
    // nothing about events outside its reach.
    if (!row || competitionDenied(req, row.competition_id)) return res.status(404).json({ error: "No certificate with that code." });
    const comp = getCompetition(row.competition_id);
    const user = db.prepare("SELECT id, first_name, last_name, nickname, email FROM users WHERE id=?").get(row.user_id);
    try {
      recordUserEvent(row.user_id, "credential_resolved", getAdminIdentity(req), {
        ...reqContext(req),
        // The fingerprint, not the code: this row lands in the same logs the
        // resolver exists because of.
        code_fingerprint: _codeFingerprint(code),
        competition_id: row.competition_id, revoked: !!row.revoked_at,
      });
    } catch (e) { log.error({ ...reqContext(req), err: e.message }, "credential_resolved audit failed"); }
    res.json({
      token: row.token,
      revoked: !!row.revoked_at,
      revoked_at: row.revoked_at || null,
      basis: row.basis || null,
      competition: comp ? { id: comp.id, name: comp.name } : null,
      holder: user ? { id: user.id, name: [user.first_name, user.last_name].filter(Boolean).join(" "), nickname: user.nickname, email: user.email } : null,
    });
  });

  // ── /credential — third-party verification (v8.1.0, PR 28) ───────────────
  //
  // TWO INPUTS: the 12-character code printed on the certificate, and the
  // holder's surname. A WRONG SURNAME IS BYTE-IDENTICAL TO AN UNKNOWN CODE —
  // deliberately, and documented in swagger so nobody "fixes" it. Without that,
  // the code alone becomes a lookup that reveals who holds it, and codes reach
  // app.jsonl and access-*.jsonl in cleartext.
  //
  // FAILURES ONLY on both guessing buckets. Counting successes would be a denial
  // of service on the credential itself: an HR team verifying a cohort of sixty
  // is the legitimate load this exists to serve, and it must never be what locks
  // the credential out.
  const CREDENTIAL_IP_FAIL_MAX = 30;          // per hour, per source
  const CREDENTIAL_CODE_FAIL_MAX = 10;        // per hour, per (code, source) — see below
  const CREDENTIAL_FAIL_WINDOW_MS = 60 * 60 * 1000;
  // The per-code budget is counted per (code, source), never per code alone
  // (operator ruling, 24 Nov 2026). A code is public once its holder posts it,
  // so a per-code count let any one reader of that post spend ten wrong
  // surnames and refuse every real verifier of the certificate for an hour.
  // Keyed with the source, one reader can only block their own checks. A
  // SOURCE is the sign-in code's origin (lib/login-code.js originKeyFor: an
  // IPv4 /24, an IPv6 /64; operator ruling, 24 Nov 2026), never one address: a
  // single IPv6 connection holds billions of addresses, each of which would
  // start a fresh count. The accepted cost: someone with many such networks
  // gets more guesses at one code, each still needing the holder's surname,
  // and each network still held to 10 per code and 30 in all per hour.
  // 10/hour is ~5x real need. Hour-long buckets rely on the rate-limit janitor
  // sweeping each bucket on its own window, not on the sweep cadence.
  const _credFails = new Map();               // key -> { start, count }
  function _credFailCount(key) {
    const rec = _credFails.get(key);
    if (!rec || (Date.now() - rec.start) >= CREDENTIAL_FAIL_WINDOW_MS) return 0;
    return rec.count;
  }
  function _credFailRecord(key) {
    const rec = _credFails.get(key);
    if (!rec || (Date.now() - rec.start) >= CREDENTIAL_FAIL_WINDOW_MS) _credFails.set(key, { start: Date.now(), count: 1 });
    else rec.count++;
    // Bounded: an unauthenticated caller must not be able to grow this without
    // limit. OLDEST-FIRST, and never `clear()`.
    //
    // The first version fell back to `_credFails.clear()` when the expiry pass
    // freed nothing, which is a control an attacker can operate: 20 001 failing
    // lookups with DISTINCT codes are all inside the window, so nothing expires,
    // the map is wiped, and every live per-code budget — including the one
    // protecting the code being attacked — resets to zero. That defeats the
    // "a top-100-surname sweep takes days" argument the whole design rests on.
    // Map preserves insertion order, so the oldest live entries are simply the
    // ones at the front.
    if (_credFails.size > 20000) {
      const cutoff = Date.now() - CREDENTIAL_FAIL_WINDOW_MS;
      for (const [k, v] of _credFails) if (v.start < cutoff) _credFails.delete(k);
      for (const k of _credFails.keys()) {
        if (_credFails.size <= 20000) break;
        _credFails.delete(k);
      }
    }
  }

  /** The one answer a failed lookup ever gives. */
  const _credentialUnknown = { found: false };

  app.get("/credential", rateLimit(60_000, 60, "credential-page"), (req, res) => {
    res.type("html").set("Cache-Control", "no-store").send(_credentialPageHtml(null, {
      code: typeof req.query.code === "string" ? req.query.code : "",
    }));
  });

  // The platform limiter here is a VOLUME BACKSTOP, not the guessing control, and
  // its ceiling is generous on purpose: at 30/min it would refuse an HR team
  // checking a cohort of sixty — the exact load this endpoint exists to serve, and
  // the load the failures-only rule was chosen to protect. Its 429 is also JSON
  // regardless of Accept, so a form user would see raw JSON; keeping it far above
  // real use means the bespoke buckets below (which render the page) are what a
  // human actually meets.
  app.post("/credential", rateLimit(60_000, 120, "credential-lookup"), (req, res) => {
    // Text only (sweep #193): a non-string code or surname is an unknown
    // certificate, answered like any other miss, never a 500.
    const rawCode = typeof req.body?.code === "string" ? req.body.code : "";
    const rawName = typeof req.body?.surname === "string" ? req.body.surname : "";
    const code = normaliseCredentialCode(rawCode);
    const typed = credentialNameKey(rawName);
    // An address originKeyFor cannot read keeps its own budget, as before.
    const source = originKeyFor(req.ip) || `ip:${req.ip}`;
    const ipKey = `src:${source}`;
    const codeKey = code ? `code:${code}|src:${source}` : null;

    const wantsJson = (req.get("accept") || "").includes("application/json");
    const answer = (verdict, status = 200) => {
      if (wantsJson) return res.status(status).set("Cache-Control", "no-store").json(verdict);
      return res.status(status).type("html").set("Cache-Control", "no-store")
        .send(_credentialPageHtml(verdict, { code: rawCode }));
    };

    // Throttled BEFORE the lookup, so a refused caller costs one Map read.
    if (_credFailCount(ipKey) >= CREDENTIAL_IP_FAIL_MAX
        || (codeKey && _credFailCount(codeKey) >= CREDENTIAL_CODE_FAIL_MAX)) {
      // 429, which the scanner-reputation counter already ignores — so a verifier
      // fumbling a surname can never contribute to an IP-wide block.
      return answer({ found: false, throttled: true }, 429);
    }

    // An empty code or an empty typed name matches NOTHING.
    //
    // The `typed` half is DEFENCE IN DEPTH, not the protection — measured: with
    // this guard removed the lookup still refuses, because `credentialMatchKeys`
    // never emits the empty key and a Set cannot contain what was never added.
    // That is where the property is locked (see the match-keys unit test, whose
    // mutation IS caught). Kept because a future fold that returned "" for some
    // input would otherwise make every certificate verifiable by typing nothing,
    // and this line is the cheaper of the two places to be sure.
    //
    // The `code` half is not redundant: without it every empty submission would
    // run a query.
    let row = null;
    if (code && typed) {
      row = db.prepare("SELECT * FROM achievement_badges WHERE public_code=?").get(code);
    }
    const parts = row && row.name_match_snapshot ? _safeJson(row.name_match_snapshot) : null;
    const matches = !!(row && parts && credentialMatchKeys(parts).has(typed));

    if (!matches) {
      _credFailRecord(ipKey);
      if (codeKey) _credFailRecord(codeKey);
      try {
        recordOrphanedAuditEvent("credential", _codeFingerprint(code), "credential_lookup_failed", "anonymous", {
          ...reqContext(req), code_present: !!code, name_present: !!typed, code_known: !!row,
        });
      } catch (e) {
        // audit is best-effort
        swallowed("badge:credential-lookup-audit", e);
      }
      return answer(_credentialUnknown);
    }

    const comp = db.prepare("SELECT * FROM competitions WHERE id=?").get(row.competition_id);
    if (!comp) return answer(_credentialUnknown);
    const art = _badgeArt(row, comp);
    try {
      // NEITHER THE TOKEN NOR THE RAW CODE. Both are capabilities: the token opens
      // the PNG and the PDF with no auth at all — which is exactly why
      // `_scrubLogPath` has redacted it from the ACCESS log since v7.1.0 — and the
      // code is one of the two factors this endpoint exists to require. This blob
      // reaches app.jsonl, which any regular admin can read through
      // GET /api/admin/logs, so writing either here would hand every admin a
      // bypass of the very gate above it. `user_id` + `competition_id` identify
      // the row for forensics, and the fingerprint correlates repeated lookups of
      // one code without being usable as that code.
      recordOrphanedAuditEvent("credential", _codeFingerprint(code), "credential_verified", "anonymous", {
        ...reqContext(req), user_id: row.user_id, competition_id: comp.id, revoked: !!row.revoked_at,
      });
    } catch (e) {
      // audit is best-effort
      swallowed("badge:credential-resolved-audit", e);
    }

    // A REVOKED certificate RESOLVES and says so. Its code index is deliberately
    // not filtered on revocation, because "this was revoked" and "this never
    // existed" are different answers and a verifier needs the first one.
    return answer({
      found: true,
      revoked: !!row.revoked_at,
      revoked_at: row.revoked_at || null,
      // The page is an authoritative RE-RENDER, so it shows the CURRENT name and
      // discloses that it has moved — a stale name is a worse answer, and the
      // holder can pre-empt the disclosure by asking for a revocation.
      name: art.displayName,
      nameChanged: _credentialNameChanged(parts, art.matchParts),
      basis: row.basis || null,
      label: badgeBasisLabel(row.basis, row.rank),
      // FROZEN, so the page confirms what the paper says rather than what the
      // event's schedule now implies.
      lateEntrant: !!row.late_entrant,
      kind: eventKindLabelServer(comp),
      competitionName: comp.name,
      dateLabel: art.dateLabel,
      scoreLabel: art.scoreLabel,
      grade: art.grade,
      code: formatCredentialCode(row.public_code),
    });
  });

  // v8.1.0 (PR 27) — revoke a certificate.
  //
  // SUPERADMIN, matching the tier that can already delete a participant: this
  // invalidates an artefact a third party may be holding, and the page it serves
  // afterwards says "revoked" rather than 404 — see the non-partial `public_code`
  // index. Setting `revoked_at` also makes the badge invisible to `_findBadge`,
  // and the re-mint refusal on the mint path is what stops the holder simply
  // minting a replacement.
  app.post("/api/admin/badges/:token/revoke", requireAdmin, requireSuperAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
    const row = db.prepare("SELECT * FROM achievement_badges WHERE token=?").get(req.params.token);
    if (!row) return res.status(404).json({ error: "Certificate not found" });
    // A role scoped to its events reaches this route by holding Revoke
    // certificates, and revokes only its own events' certificates.
    { const denied = competitionDenied(req, row.competition_id); if (denied) return res.status(403).json({ error: denied.message, code: denied.code }); }
    if (row.revoked_at) return res.status(409).json({ error: "That certificate is already revoked.", code: "already_revoked" });
    // v8.12.0 — a certificate is a fact about ONE event's board; a competitor on
    // that board may not revoke one of its certificates (the competitor lock's
    // artefact door). Asked after the 404 and the already-revoked 409, before
    // anything is written; the built-in superadmin is never a competitor.
    { const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), row.competition_id)); if (_cmp) return _cmp; }
    const iso = now().toISOString();
    db.prepare("UPDATE achievement_badges SET revoked_at=? WHERE token=? AND revoked_at IS NULL").run(iso, row.token);
    const comp = db.prepare("SELECT id, name FROM competitions WHERE id=?").get(row.competition_id);
    try {
      // No token: History, the person export and the Audit page show these
      // details, and the event and basis already name the certificate.
      recordUserEvent(row.user_id, "badge_revoked", getAdminIdentity(req), {
        competition_id: row.competition_id,
        competition_name: comp ? comp.name : null,
        basis: row.basis || null,
        reason: typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null,
        ...reqContext(req),
      });
    } catch (e) { log.error({ ...reqContext(req), err: e.message }, "badge_revoked audit failed"); }
    res.json({ ok: true, revoked_at: iso });
  });

  app.get("/badge/:token", rateLimit(60_000, 60, "badge-page"), (req, res) => {
    const row = db.prepare("SELECT * FROM achievement_badges WHERE token=? AND revoked_at IS NULL").get(req.params.token);
    const comp = row ? db.prepare("SELECT * FROM competitions WHERE id=?").get(row.competition_id) : null;
    // Uniform 404 for invalid / revoked / orphaned — no token-existence oracle.
    //
    // audit v7.23.6 — this was a 130-byte fragment: no viewport, no stylesheet,
    // no brand, rendered in the browser's default serif. A badge link is PUBLIC
    // and circulated on LinkedIn, so the people most likely to meet this page
    // are strangers meeting the platform for the first time, on a phone. It is
    // drawn by the standalone shell (_badgeShellTop, verify-pages.css), as the
    // badge page itself is. The 404 status, the uniform wording and the absence
    // of any token detail are UNCHANGED — the response must stay
    // indistinguishable for invalid, revoked, orphaned and unshared tokens.
    if (!row || !comp || _badgePageWithheld(row)) {
      res.status(404).type("html").send(_badgeNotFoundHtml());
      return;
    }
    const rankLabel = badgeBasisLabel(row.basis, row.rank);
    const platform = getPlatformName();
    const imgAbs = `${BASE_URL}/badge/${row.token}/badge.png`;
    const pageAbs = `${BASE_URL}/badge/${row.token}`;
    const title = `${rankLabel} — ${comp.name}`;
    // v7.21.28 — the page names whoever the ARTWORK names. The badge image is
    // this page's og:image, so once the PNG carries the person's name a caption
    // still reading the nickname would contradict the picture beside it — and it
    // would buy no privacy, because the name is already in the image LinkedIn
    // renders. A legacy badge (name_snapshot NULL) has the nickname in its
    // artwork, so the caption stays on the nickname for exactly the same reason.
    // v7.21.31 — the SAME resolver as the artwork. The page used to fall back to
    // the nickname where the image fell back to the live name, so a badge minted
    // before name_snapshot existed showed the person in the picture and the
    // handle in the caption right beside it.
    const art = _badgeArt(row, comp);
    const shownName = art.displayName;
    // v8.1.0 (PR 25) — three sentences, not two. "Took part in" understates a
    // completion (that wording exists for someone who merely attempted), and
    // "finished Nth" would publish a placing the platform refuses to show for a
    // completion kind. A legacy row has no basis and keeps exactly its old
    // sentence.
    // v8.6.0 — a LATE-ENTRANT certificate says so in the sentence too, not only in
    // the artwork. This page is the OpenGraph description a share renders and the
    // caption beside the picture; a picture reading "LATE ENTRANT" over a sentence
    // that does not is the artwork-vs-caption contradiction v7.21.31 fixed.
    //
    // A placement reads "finished 1st among the late entrants", because that is
    // what the rank means — first on the late board, not first at the event.
    const _late = art.lateEntrant;
    const desc = row.basis === "completion"
      ? (art.grade
        ? `${shownName} completed ${comp.name} on ${platform}, graded ${art.grade.label} (${art.grade.percent}).`
        : `${shownName} completed ${comp.name} on ${platform}.`)
      : isPlacementBasis(row.basis, row.rank)
        ? (_late
          ? `${shownName} finished ${rankLabel.toLowerCase()} among the late entrants in ${comp.name} on ${platform}.`
          : `${shownName} finished ${rankLabel.toLowerCase()} in ${comp.name} on ${platform}.`)
        : (_late
          ? `${shownName} took part in ${comp.name} as a late entrant, on ${platform}.`
          : `${shownName} took part in ${comp.name} on ${platform}.`);
    const dateLabel = art.dateLabel;
    const E = escapeHtml;

    // The OpenGraph block LinkedIn reads (og:image is the share card, 1200x627);
    // no robots line, as a published page is meant to be found.
    const og = `<meta name="description" content="${E(desc)}"/>
<meta property="og:type" content="website"/>
<meta property="og:title" content="${E(title)}"/>
<meta property="og:description" content="${E(desc)}"/>
<meta property="og:image" content="${E(imgAbs)}"/>
<meta property="og:image:width" content="1200"/>
<meta property="og:image:height" content="627"/>
<meta property="og:url" content="${E(pageAbs)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${E(title)}"/>
<meta name="twitter:description" content="${E(desc)}"/>
<meta name="twitter:image" content="${E(imgAbs)}"/>
`;
    res.type("html").set("Cache-Control", "public, max-age=300").send(`${_badgeShellTop(platform, { title: `${E(title)} · ${E(platform)}`, headExtra: og })}
<main class="badge-main" role="main"><article class="card badge-card"><img src="/badge/${E(row.token)}/badge.png" alt="${E(title)}" width="1200" height="627"/><h1>${E(shownName)} — ${E(rankLabel)}</h1><p class="badge-meta">${E(comp.name)}${dateLabel ? ` · ${E(dateLabel)}` : ""}</p></article></main>
${_SHELL_FOOTER}</body></html>`);
  });
};
