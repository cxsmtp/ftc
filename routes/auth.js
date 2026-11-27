"use strict";

// Account-lifecycle + session routes: registration, nickname availability,
// email-unsubscribe (RFC 8058), email verification, the emailed sign-in code
// (request / redeem — the sign-in door for every account row), and logout /
// admin-logout. POST /api/login (the built-in superadmin's break-glass door; it
// mutates the in-process superadmin-password state) stays inline in server.js. _doUnsubscribe / _UNSUB_LIMIT are
// module-local (used only by these routes). (v7.0.0 refactor: route split —
// extracted verbatim from server.js.)

const { v4: uuid } = require("uuid");
const db = require("../db");
const { rateLimit, csrfProtection, generateToken, requireParticipant, applyAutoResumeToSession, stampLoginTimes, participantSessionDenied, sendParticipantSessionDenial, ipBudgetExceeded } = require("../lib/middleware");
const { recordCompetitionEvent, recordOrphanedAuditEvent, recordUserEvent, reqContext, runTxnWithMirrorBuffer, capabilityFingerprint } = require("../lib/audit");
const { swallowed } = require("../lib/best-effort");
const { getCompetition, competitionAdmission, listParticipantCompetitions } = require("../lib/competitions");
const { BASE_URL } = require("../lib/config");
const { enqueueCxOneProvision } = require("../lib/cxone");
const { getUserEmails, sendLockoutEmail, sendLoginCodeEmail, sendEmailProofEmail, sendVerificationEmail, sendPasswordChangedEmail, verifyUnsubscribeToken } = require("../lib/email");
const { emailIsTaken } = require("../lib/email-identity");
const { reconcileGroupBoundCompetitions, detectMemberAddClashes } = require("../lib/group-sync");
const { log } = require("../lib/log");
const { invalidateAdminParticipantsCache } = require("../lib/participants-cache");
const { invalidateLeaderboardCache } = require("../lib/leaderboard");
const { _invalidateMeCache } = require("../lib/me-cache");
const { escapeHtml, VALID_AVATARS } = require("../lib/sanitise");
const { _resolveJoinableComp, SELF_ENROLL_GRACE_MS, verificationGraceState, _consumeCodeBoundEnroll, codeBoundJoinWillEnrol, joinLinkTag, liveJoinLinkTag } = require("../lib/self-enroll");
const { impersonationActor, impersonationEndedDetails } = require("../lib/impersonation");
const { invalidateOtherSessions, kickerContext, setAppShellHintCookie, SESSION_END } = require("../lib/sessions");
const { getPlatformName, getRequireAccountApproval } = require("../lib/settings");
const { inviterMayApproveNow } = require("../lib/rbac"); // sweep #501 — an invitation approves only through an inviter who may approve
const { platformLookAttr } = require("../lib/platform-look"); // the platform look on every page theme-boot.js paints
const { isStaff } = require("../lib/user-tags");
const { claimInvitationsForAccount } = require("../lib/invitation-claim");
const { findUserByPrimary, findUserByAddress } = require("../lib/account-lookup");
const { certificatePrintedName } = require("../lib/badge"); // the name a certificate issued now would print
const { effectiveLoginMethod, hasUsablePassword, loginMethodWire, passwordLengthError, dummyPasswordHash, LOGIN_METHODS, BCRYPT_COST } = require("../lib/login-method");
const bcrypt = require("bcrypt");
const { now } = require("../lib/time");
const { registrationFieldStates, registrationFieldDefaultsForKind } = require("../lib/event-policy");
const { _capsOk, _firstNonStringField, _profileMissingFields, isFreeEmail, isValidEmailFormat, isValidTimezone, normaliseEmail, sameSlotEmails, validateUrl, _nicknameCharsOk, NICKNAME_CHARSET_ERROR, trackDetachedSend, PROFILE_GATE_COLUMNS, PROFILE_GATE_JOIN, NO_PASSWORD_HASH, _transliterateAscii, awaitDeliveryWithDeadline, profileTextControlField, profileTextControlBody } = require("../lib/util");
const crypto = require("crypto");

// Validity window for emailed verification and email-change codes (48h).
// The definition lives in lib/config, beside the other shared windows.
const { CODE_EXPIRY_MS, LOGIN_CODE_TTL_MS } = require("../lib/config");
const { isCodeEligible, codeBlockedReason, hasSignedIn, issueCode, resolveCodeAttempt, consumeCode, countCodeOutcome, codeProvesEmail, CODE_VIA_EMAIL, originKeyFor, codeOriginExhausted, codeRecentlySent, deskCodeLive, hashCode, codeDropTag, codeIsLive } = require("../lib/login-code"); // v7.29.0
// v8.1.x — the sign-in code shares the account's ONE failure budget; the
// threshold and its three columns have exactly one owner (v7.29.0).
const { isLockedNow, clearLockout, recordFailedLogin, shouldLock, armLockout } = require("../lib/lockout");
const { _consumePendingSelfEnroll: _consumeJoinForCode } = require("../lib/self-enroll");
const { issueProof, redeemProof, liveProofGrant, discardProof, dropProofEvent, EMAIL_PROOF_GRANT_MS } = require("../lib/email-proof");

module.exports = function register(app) {
app.post("/api/register", rateLimit(60_000, 10, "register"), csrfProtection, async (req, res) => {
  let { firstName, lastName, nickname, company, title, email, secondaryEmail, avatar, country, timezone, linkedinUrl, invitationId, jobFunction, city, joinToken, personalTitle, phone } = req.body;
  // ── NO ACCOUNT WITHOUT A PROVEN ADDRESS ────────────────────────────────────
  //
  // The form is reached only after the entry screen's emailed code: for an
  // address with no account that code is an ADDRESS PROOF, and redeeming it put
  // a single-use, ~15-minute grant for that one address in THIS session
  // (`req.session.emailProof`, written only by the redeem route). Without a live
  // grant nothing is created and nothing is disclosed, so this is asked before
  // every field check, the type guard included. The account's address IS the
  // grant's: the form shows it read-only, and a body `email` is not used for it
  // (as an invitation's forced primary always was).
  const grant = liveProofGrant(req.session);
  if (!grant) {
    return res.status(403).json({ error: "Confirm your email address first: enter it on the sign-in screen and type the code we email you.", code: "email_proof_required" });
  }
  // ext-audit batch 5 — reject any non-string text field up front (a non-string
  // would 500 at a later `.trim()` — e.g. linkedinUrl.trim() — or at the SQL bind).
  // Mirrors the PUT /api/me guard. Type only here; presence/format checks follow.
  {
    const _nonStr = _firstNonStringField(req.body, ["firstName", "lastName", "nickname", "company", "title", "email", "secondaryEmail", "avatar", "country", "timezone", "linkedinUrl", "invitationId", "jobFunction", "city", "joinToken", "personalTitle", "phone"]);
    if (_nonStr) return res.status(400).json({ error: `${_nonStr} must be text` });
  }
  // NO PHOTO AT SIGN-UP: the form sends no avatar, and the sign-up door takes a
  // preset picture or nothing (default1). Anything else is refused before any
  // row is written: a photo would need a body over the 16 KB sign-in cap, and an
  // `/api/images/` reference would point the new account at an image somebody
  // else stored. A picture is chosen in the profile after sign-up.
  if (avatar !== undefined && avatar !== null && avatar !== "" && !VALID_AVATARS.has(avatar)) {
    return res.status(400).json({ error: "Choose a picture in your profile after you sign up.", code: "avatar_not_accepted" });
  }
  // The grant's address was normalised when the proof was issued; a body
  // `email` is never read.
  email = grant.email;
  // An account took the address after the proof was redeemed (an import, an
  // admin's invite). The person has proven the inbox, so saying so is safe.
  if (_accountByAddress(email) || emailIsTaken(email)) {
    delete req.session.emailProof;
    discardProof(email);
    return res.status(409).json({ error: "This address already has an account. Sign in with an emailed code instead.", code: "email_taken" });
  }
  // THE GRANT'S EVENT, only while its link is the one this browser asked through
  // (`_joinableUnderGrant`). A link switched off or replaced, or an event no
  // longer taking joins, after the code was entered makes this a grant naming no
  // event, exactly as one the switch-off untied before: a live join token on the
  // form fills it, a live invitation to the address is the registration's,
  // approval holds the rest. Whether the organiser closed the link before or
  // after the person typed the code must not decide whether they wait. Resolved
  // once; every later question about the grant's event reads it.
  const grantComp = grant.joinCompId ? _joinableUnderGrant(grant) : null;
  // Whether the request named an event (the grant's, or a body token) that it can
  // no longer join: the answer says so, so the client forgets the dead link
  // rather than asking to join through it after the sign-up.
  const _bodyToken = typeof joinToken === "string" && joinToken ? joinToken : null;
  const joinLinkClosed = !!(grant.joinCompId || _bodyToken)
    && !grantComp && !(_bodyToken && _resolveJoinableComp(_bodyToken));
  const _closedMark = joinLinkClosed ? { join_link_closed: true } : {};
  // The event that closed link named (the grant's, else the one a body token still
  // names; a replaced token names none). An invitation that enrols the account in
  // that very event means it WAS added, so the answer does not say otherwise.
  const _closedCompId = !joinLinkClosed ? null
    : (grant.joinCompId || (_bodyToken && db.prepare("SELECT id FROM competitions WHERE self_enroll_token=?").get(_bodyToken)?.id) || null);
  const _closedMarkUnless = (enrolledIds) => (_closedCompId && enrolledIds.includes(_closedCompId)) ? {} : _closedMark;
  // The invitation and the event come from the GRANT (bound when the code was
  // requested); a body value only fills a gap, and an invitation must be for
  // this very address or it is no invitation for this registration.
  if (grant.invitationId) invitationId = grant.invitationId;
  // An id naming an invitation to ANOTHER address (the person changed the
  // address on the entry screen after opening an invitation) is no invitation
  // for this registration: dropped, never answered 409.
  if (invitationId) {
    const _named = db.prepare("SELECT email FROM invitations WHERE id=?").get(invitationId);
    if (_named && normaliseEmail(_named.email) !== grant.email) invitationId = undefined;
  }
  // A body token for a join link this browser asked through when it requested
  // the code, switched off or replaced since (sweep #391), is a link that closed
  // meanwhile, and that close untied the proof: the form only still carries it.
  // Dropped here, before the invitation lookup below, so the sign-up goes on as
  // one that carries no token, never refused for it (the "invalid link" 409
  // below is for a token this browser never asked with).
  if (_closedLinkAskedHere(grant, joinToken)) joinToken = undefined;
  // A grant that named an event whose link has closed since: any dead body token
  // is dropped too, whichever link it was (the person cannot do anything about a
  // link that closed meanwhile). The "invalid link" 409 below stays for a grant
  // that never named an event.
  if (grant.joinCompId && !grantComp && joinToken && !_resolveJoinableComp(joinToken)) joinToken = undefined;
  // With neither an invitation nor an event riding the request, a live
  // invitation addressed to this very address IS the registration's: an invitee
  // who typed their address on the plain sign-in screen registers exactly as
  // the invitation's link would have registered them (approved and enrolled, or
  // waiting with the invitation still live when its inviter may not approve:
  // sweep #501), never as a held sign-up whose invitation is spent while it waits.
  if (!invitationId && !grantComp && !joinToken) {
    const _live = db.prepare("SELECT id FROM invitations WHERE used_at IS NULL AND email=? COLLATE NOCASE").get(grant.email);
    if (_live) invitationId = _live.id;
  }
  // The grant's live event wins over a body token.
  if (grantComp) joinToken = undefined;
  // Single-line profile text carries no control character (lib/util.js
  // profileTextOk, one predicate for every door). Asked of the values AS SENT,
  // before the trims below: a trim strips an edge tab or line break, so checking
  // after it accepted here what every other door refuses.
  {
    const ctl = profileTextControlField({ first_name: firstName, last_name: lastName, company, title,
      personal_title: personalTitle, phone, job_function: jobFunction, city, country });
    if (ctl) return res.status(400).json(profileTextControlBody(ctl));
  }
  if (typeof secondaryEmail === "string" && secondaryEmail) secondaryEmail = normaliseEmail(secondaryEmail);
  if (typeof jobFunction === "string") jobFunction = jobFunction.trim();
  if (typeof city === "string") city = city.trim();
  // v7.3.0 — optional personal title + phone. Normalise to a stored value or NULL.
  if (typeof personalTitle === "string") personalTitle = personalTitle.trim() || null; else personalTitle = null;
  if (typeof phone === "string") phone = phone.trim() || null; else phone = null;
  // ext-audit A7 (v7.21.1) — TRIM the mandatory text fields before the presence
  // check below, and store the trimmed value.
  //
  // That check is a bare `!firstName || ...` and " " is TRUTHY, so a probe
  // persisted whitespace-only first_name, last_name, nickname, company, title,
  // country and timezone. Two consequences beyond untidy data:
  //   • GET /api/check-nickname TRIMS before its COLLATE NOCASE lookup, so the
  //     availability endpoint and registration disagreed about what a nickname
  //     IS — " bob " registered while check-nickname answered for "bob", and the
  //     ASCII-charset argument for uq_users_nickname_nocase being a COMPLETE
  //     uniqueness guarantee only holds if both sides normalise identically.
  //   • _profileMissingFields treated a whitespace country/timezone as PRESENT,
  //     so the account counted as profile-complete and skipped the completion
  //     gate while carrying a timezone no formatter can resolve.
  // jobFunction / city already trim above (and email is normalised); this is the
  // rest of the required set. Assigned back, so the INSERTs bind the trimmed
  // value — validating a trimmed copy while storing the raw one is the same bug
  // one layer down.
  if (typeof firstName === "string") firstName = firstName.trim();
  if (typeof lastName === "string")  lastName  = lastName.trim();
  if (typeof nickname === "string")  nickname  = nickname.trim();
  if (typeof company === "string")   company   = company.trim();
  if (typeof title === "string")     title     = title.trim();
  if (typeof country === "string")   country   = country.trim();
  if (typeof timezone === "string")  timezone  = timezone.trim();
  // The short form: the browser's detected zone, else UTC (a zone that could not
  // be detected must never block a sign-up; the profile editor changes it).
  if (!timezone) timezone = "UTC";
  if (!firstName || !lastName || !email || !company || !title || !country)
    return res.status(400).json({ error: "Missing required fields" });
  // The nickname is no longer asked at sign-up: one is suggested from the name,
  // under the rules GET /api/check-nickname applies (ASCII, 3+ characters,
  // unique ignoring case). A supplied one is still honoured and checked below.
  if (!nickname) nickname = _suggestNickname(firstName, lastName);
  // v8.1.0 (PR 31) — THE REORDER. The join competition has to be resolved BEFORE
  // these two checks, not eighty lines below them, because its kind decides
  // whether they apply at all: a Booth Event walk-up fills eight fields, not ten.
  //
  // Resolving early is safe and changes nothing for every other caller — the
  // helper is a pure read, and the invalid-token refusal stays exactly where it
  // was (below, beside the invitation logic it belongs with) so no existing
  // status code moves.
  //
  // `_relaxedAtSignup` is the SET this registration may omit; `_profilePolicy` is
  // what gets STAMPED on the row so the account keeps the same deal for life. The
  // two are separate on purpose: the policy is stored even when the visitor
  // happens to fill everything in, or an account created at a booth would silently
  // become a full-profile account and be gated later for a field it never lost.
  const _joinCompEarly = invitationId ? null
    : grantComp ? grantComp
    : (joinToken ? _resolveJoinableComp(joinToken) : null);
  const _profilePolicy = _joinCompEarly ? (_joinCompEarly.event_kind || null) : null;
  // v8.3.1 — "not required at sign-up" is relaxed ∪ optional. An optional field
  // is still ACCEPTED and stored when the visitor fills it in; it is only the
  // refusal that is dropped.
  // ── v8.4.0 — THE REQUIREMENT IS THIS EVENT'S, NOT ITS KIND'S ────────────────
  //
  // v8.1.0 (PR 31) asked the KIND (`eventPolicy(kind).relaxedProfile`), which was
  // the whole answer while a Booth Event's shortened form was a constant. A Booth
  // Event now configures its own form, so the question moves to the ROW — and it
  // is read from `_joinCompEarly`, the join token's OWN competition, never from
  // the request. A client is TOLD the answer (`policy.registration_fields`) so it
  // can render the form; the server re-derives it here, because a fabricated
  // relaxation must not buy an account that skipped a field this event demands.
  // That is the same rule PR 31 set for `relaxed_profile` and v8.3.2 set for the
  // password, applied to all six.
  const _signupStates = _joinCompEarly
    ? registrationFieldStates(_joinCompEarly)
    : registrationFieldDefaultsForKind(null);
  const _demanded = (f) => _signupStates[f] === "required";
  if (_demanded("job_function") && !jobFunction) return res.status(400).json({ error: "Job function is required." });
  if (_demanded("city") && !city) return res.status(400).json({ error: "City is required." });
  // v8.4.0 — the three fields that were optional for every kind and may now be
  // REQUIRED. One refusal each rather than a loop, because each names its own
  // field in the message an admin's walk-up will read, and the LinkedIn URL is
  // additionally shape-checked further down.
  if (_demanded("personal_title") && !personalTitle) return res.status(400).json({ error: "Salutation is required." });
  if (_demanded("phone") && !phone) return res.status(400).json({ error: "Phone is required." });
  if (_demanded("linkedin_url") && !linkedinUrl) return res.status(400).json({ error: "LinkedIn profile URL is required." });
  if (nickname.length < 3)
    return res.status(400).json({ error: "Nickname must be at least 3 characters" });
  if (!_nicknameCharsOk(nickname)) return res.status(400).json({ error: NICKNAME_CHARSET_ERROR });
  // Upper-bound length caps (v6.8.0) — keep malicious oversize payloads out
  // of the audit log + leaderboard JSON before any DB work happens.
  const capHit = _capsOk({
    first_name: firstName, last_name: lastName, nickname, company, title,
    personal_title: personalTitle, phone,
    job_function: jobFunction, city, secondary_email: secondaryEmail, linkedin_url: linkedinUrl,
    // ext-audit A7 — country was the one mandatory profile string with no upper
    // bound; unbounded text here reaches every admin list, export and CSV.
    country,
  });
  if (capHit) return res.status(400).json({ error: `${capHit.field} must be at most ${capHit.max} characters.` });
  // ext-audit A7 (v7.21.1) — the timezone is USED (competition windows, email
  // date lines), so an unresolvable value throws a RangeError far from the write
  // that accepted it. isValidTimezone asks the platform's own Intl rather than a
  // hard-coded zone list, which is what keeps "UTC" working — see the v7.15.23
  // note on the helper. `country` deliberately gets no vocabulary check: nothing
  // computes with it, the LinkedIn and import write paths are not constrained to
  // ISO-3166 either (the fixtures already carry "UK"), and a hard-coded country
  // table would go stale and lock people out.
  if (!isValidTimezone(timezone))
    return res.status(400).json({ error: "Please select a valid timezone." });
  // Reject malformed email strings before any uniqueness / free-email check —
  // isFreeEmail() is a domain denylist, not a format check, so without this
  // garbage like "not-an-email" would persist as a stored primary and break
  // every later mail-out (verification, approval, reset, reminder).
  if (!isValidEmailFormat(email))
    return res.status(400).json({ error: "Please enter a valid email address." });
  if (secondaryEmail && !isValidEmailFormat(secondaryEmail))
    return res.status(400).json({ error: "Please enter a valid secondary email address." });
  if (linkedinUrl && linkedinUrl.trim() && !validateUrl(linkedinUrl))
    return res.status(400).json({ error: "LinkedIn URL must be a valid http:// or https:// URL." });
  // Dual-email validation: at least one must be non-free
  const primaryFree = isFreeEmail(email);
  const secondaryFree = secondaryEmail ? isFreeEmail(secondaryEmail) : true;
  // If registering via invitation, skip free-email check on primary (admin already validated)
  const _invRow = invitationId ? db.prepare("SELECT * FROM invitations WHERE id=? AND used_at IS NULL").get(invitationId) : null;
  const invitation = _invRow && normaliseEmail(_invRow.email) === grant.email ? _invRow : null;
  // If the client provided an invitationId but the row is gone (already consumed
  // by a concurrent request, or simply invalid), do NOT silently fall through
  // to regular registration — the caller's intent is clear. Return 409 so the
  // race-loser half of a concurrent-double-use sees a consistent outcome.
  if (invitationId && !invitation)
    return res.status(409).json({ error: "This invitation has already been used or does not exist." });
  // v6.21.0 — self-enrollment link. Resolve the join token only when there is
  // no invitation (an explicit invitation is the stronger pre-authorisation
  // and wins). A join token blesses NOBODY's specific email, so — unlike the
  // invite path — it does NOT bypass the corporate-email rule below; it only
  // skips the admin APPROVAL step (approved=1) and auto-enrolls at first login.
  // v8.1.0 (PR 31) — resolved ABOVE (the field checks need its kind). Re-reading
  // here would be a second source of truth for one fact, and the two could
  // disagree if the link were disabled mid-request.
  const joinComp = invitation ? null : _joinCompEarly;
  // An explicit-but-invalid join token (disabled / ended / unknown) is a clear
  // caller error — don't silently fall through to a plain (pending) signup. One
  // this browser asked through when it requested the code, and which closed since,
  // never reaches here: it was dropped above (sweep #391), as was any dead token
  // beside a grant whose own event's link closed. So this refuses only a dead
  // token sent with a grant that never named an event.
  if (!invitation && !grantComp && joinToken && !joinComp)
    return res.status(409).json({ error: "This self-enrollment link is invalid or no longer active." });
  if (!invitation && primaryFree && secondaryFree)
    return res.status(400).json({ error: "At least one email address must be a company email, not a free email service." });
  // Case-insensitive match — the DB has a COLLATE NOCASE unique index on
  // nickname, so "alice_s" and "ALICE_S" collide at insert. Matching the
  // index here keeps the preflight aligned with the invariant and prevents
  // a case-only collision slipping past the 409 into a generic 500.
  if (db.prepare("SELECT id FROM users WHERE nickname=? COLLATE NOCASE").get(nickname))
    return res.status(409).json({ error: "This nickname is already taken. Please choose a different one." });
  // Only check the client-supplied primary when there's no invitation — the
  // invite branch forces the primary to invitation.email and re-checks it
  // there. Otherwise a tampered client email could incorrectly block a
  // legitimate invitation redemption.
  if (!invitation && emailIsTaken(email))
    return res.status(409).json({ error: "This email is already registered." });
  if (secondaryEmail && emailIsTaken(secondaryEmail))
    return res.status(409).json({ error: "This secondary email is already in use by another account." });
  // Same-account collision: primary and secondary must resolve to different
  // identities. Without this, getUserEmails would mail the same address
  // twice and the secondary slot becomes meaningless.
  // An invitation's primary is forced (it is the grant's address, which the form
  // shows read-only), so a secondary equal to it is CLEARED in the invite branch
  // below (ext-audit A8), never refused with an error naming a locked field.
  if (!invitation && sameSlotEmails(email, secondaryEmail))
    return res.status(400).json({ error: "Primary and secondary email must be different." });
  // A new account has no password (its holder may set one later, under
  // Profile). A fixed non-bcrypt placeholder is stored: no bcrypt cost on any
  // registration path, and `hasUsablePassword` never accepts it.
  const passwordHash = NO_PASSWORD_HASH;
  const createdAt = now().toISOString();

  if (invitation) {
    // Invited users: create verified (the grant proved the address), approved unless
    // held (below), and enrolled in the invitation's events.
    //
    // Two concurrent requests with the same invitation id used to race here: both would
    // pass the `used_at IS NULL` SELECT above, both INSERT a user row (often with
    // different emails — the registration form doesn't tie the email to the invite),
    // and only the first UPDATE would win — leaving the loser's user row + assignments
    // stranded even as the response returned 409.
    //
    // Fix: atomically CLAIM the invitation first inside a single better-sqlite3
    // transaction (which runs serialisable), then INSERT the user and assignments in
    // that same transaction. CxOne provisioning stays outside (async + best-effort)
    // because better-sqlite3 transactions are synchronous.
    //
    // Primary-email binding: the invitation pre-approved a SPECIFIC email
    // (invitation.email) that bypasses the free-email rule. The UI locks the
    // primary email field to that value, but a tampered client can still POST
    // any email it likes. We ignore the client-supplied primary here and force
    // it to invitation.email — without this, a tampered POST could register a
    // different free-email primary and defeat the dual-email rule that the
    // non-invite path enforces at the `primaryFree && secondaryFree` check.
    // The client-supplied `secondaryEmail` is still honoured (the UI lets the
    // user add a personal secondary on top of the pre-approved primary).
    const primaryEmail = invitation.email;
    // ext-audit A8 (v7.21.1) — RE-CHECK the two email slots against the FORCED
    // primary. The sameSlotEmails guard above ran against the CLIENT-supplied
    // primary, before this replacement, and was never re-run afterwards — so a
    // request carrying `email: <anything else>` plus `secondaryEmail:
    // <invitation.email>` stored the identical normalised address in both slots.
    // That is the exact state sameSlotEmails exists to prevent: getUserEmails
    // mails it twice, and `emailIsTaken(secondary, user.id)` excludes the same
    // user so nothing downstream ever notices.
    //
    // CLEARED rather than refused (400), deliberately. The user did not choose
    // this primary — the invitation did, and this branch already DISCARDS the
    // client's primary silently for the same reason. A 400 reading "primary and
    // secondary must be different" would name a field the form locks and the
    // registrant cannot change, i.e. an unactionable error on a redemption that
    // is otherwise valid. Nothing is lost by clearing: the address is on the
    // account, as the primary, and stays reachable.
    if (sameSlotEmails(primaryEmail, secondaryEmail)) {
      // v8.13.3 — the FINGERPRINT, never the id: this line is written before the
      // claim, so a registration refused below leaves the invitation live while
      // app.jsonl (read by any regular admin) would otherwise hold its bearer id.
      log.info({ invitation_fp: capabilityFingerprint(invitation.id, "if_") },
        "Invited registration: dropped a secondary email identical to the invitation's forced primary");
      secondaryEmail = null;
    }
    const userId = uuid();
    // v6.16.9 — filter compIds against the live competitions table.
    // Pre-fix the invitation envelope's `competition_ids` JSON wasn't
    // pruned when an admin deleted a referenced competition. The
    // `INSERT OR IGNORE INTO competition_users` below would then
    // throw `SQLITE_CONSTRAINT_FOREIGNKEY` (PRAGMA foreign_keys=ON,
    // db.js:12) — the catch block only handled
    // `SQLITE_CONSTRAINT_UNIQUE`, so FK errors bubbled as 500, the
    // txn rolled back, the invitation stayed unclaimed, and every
    // retry hit the same wall (invitee permanently stranded). Now
    // we resolve compIds → live rows up front and surface deleted
    // ones in `skippedCompetitions` so the redemption proceeds with
    // whatever's still valid, and the response tells the operator
    // what was lost.
    const _rawCompIds = JSON.parse(invitation.competition_ids || "[]");
    const compIds = [];
    const skippedCompetitions = [];
    if (_rawCompIds.length) {
      const _liveCompMap = new Map(
        db.prepare(
          `SELECT id, name FROM competitions WHERE id IN (SELECT value FROM json_each(?))`
        ).all(JSON.stringify(_rawCompIds)).map(r => [r.id, r.name])
      );
      for (const cid of _rawCompIds) {
        if (_liveCompMap.has(cid)) compIds.push(cid);
        else skippedCompetitions.push({ id: cid, reason: "competition_deleted" });
      }
    }
    // v6.20.0 — resolve the invitation's target groups to still-existing ids.
    const _rawGroupIds = (() => { try { return JSON.parse(invitation.group_ids || "[]"); } catch { return []; } })();
    const groupIdsToJoin = Array.isArray(_rawGroupIds) && _rawGroupIds.length
      ? db.prepare(`SELECT id FROM groups WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(_rawGroupIds)).map(r => r.id)
      : [];
    // audit v7.7.37 (C22) — re-validate the FORCED primary (invitation.email) against
    // the printable-ASCII format gate. The gate at the top of the handler only checks
    // the client-supplied email, which the invite branch discards. Invitations never
    // expire, so one created before the v7.7.12 ASCII restriction could still carry a
    // non-ASCII address; without this it would write a non-ASCII primary (re-opening
    // the NOCASE fold-ambiguity + bricking the account per the PUT /api/me rule). The
    // LinkedIn invite path already re-validates the same forced primary — this closes
    // the asymmetry.
    if (!isValidEmailFormat(primaryEmail))
      return res.status(400).json({ error: "This invitation's email address is no longer accepted (non-ASCII). Ask the organiser to re-issue it." });
    // Re-check uniqueness against the authoritative invitation email, not the
    // (potentially tampered) client value — ensures the race-between-check-
    // and-insert window also uses the forced primary.
    if (emailIsTaken(primaryEmail))
      return res.status(409).json({ error: "This email is already registered." });
    let claimFailed = false;
    let nicknameOrEmailTaken = false;
    // Sweep #501 (operator ruling, 23 Nov 2026): while new accounts wait for
    // approval, an invitation from a role that cannot approve accounts does not
    // approve either. The account is created waiting, like any held sign-up: it
    // claims nothing (the invitation stays live, claimed at its first sign-in once
    // an administrator approves it) and is enrolled nowhere, and meanwhile the
    // organisers of the events the invitation names see it waiting. Decided inside
    // the transaction, on the inviter's permissions as they are NOW.
    let held = false;
    const claimAndInsertTxn = db.transaction(() => {
      held = getRequireAccountApproval()
        && !inviterMayApproveNow(db.prepare("SELECT invited_by, invited_by_id FROM invitations WHERE id=?").get(invitation.id));
      if (held) {
        // Still the live invitation's: a registration that claimed it meanwhile wins.
        if (!db.prepare("SELECT 1 FROM invitations WHERE id=? AND used_at IS NULL").get(invitation.id)) { claimFailed = true; throw new Error("invitation_already_used"); }
      } else {
        // Claim first — exclusive gate. If another request already claimed it, we see 0 changes.
        const claimed = db.prepare("UPDATE invitations SET used_at=?, user_id=? WHERE id=? AND used_at IS NULL")
          .run(createdAt, userId, invitation.id);
        if (!claimed.changes) { claimFailed = true; throw new Error("invitation_already_used"); }
      }
      // audit v7.7.37 (C10) — re-check the secondary-email cross-slot uniqueness
      // INSIDE the writer-locked txn (mirrors the non-invite insertUserTxn). The
      // top-of-handler check ran outside this txn; a concurrent write
      // could claim that address as another account's PRIMARY in the gap (the UNIQUE
      // indexes only cover same-slot collisions, not cross-slot), so re-verify here.
      if (secondaryEmail && emailIsTaken(secondaryEmail)) { nicknameOrEmailTaken = true; throw new Error("secondary_taken"); }
      // Now safe to insert the user. If the email/nickname collides with an existing
      // account the UNIQUE constraint throws and the entire transaction (including
      // the UPDATE above) rolls back — invitation stays unused, exactly as the client expects.
      try {
        // job_function and city are collected at intake (required only when the
        // registration event's policy demands them, validated above) and by the
        // invited form too, so they are persisted here exactly as the non-invite
        // INSERT below persists them; omitting them left invited users with NULL
        // values the completion gate re-asked for.
        // password_set_at stays NULL: a new account has no password (its role
        // decides whether it is asked to set one at its next sign-in).
        db.prepare(`INSERT INTO users (id,first_name,last_name,nickname,company,title,personal_title,phone,email,secondary_email,avatar,verify_code,verify_code_at,verified,approved,approved_at,approved_by,password_hash,reset_code,reset_code_at,country,timezone,job_function,city,linkedin_url,invitation_id,invited_at,invited_by,created_at,password_set_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(userId, firstName, lastName, nickname, company, title, personalTitle, phone, primaryEmail, secondaryEmail||null, avatar || "default1",
               held ? 0 : 1, held ? null : createdAt, held ? null : "invitation", passwordHash, null, null,
               country||null, timezone||null, jobFunction||null, city||null, validateUrl(linkedinUrl)||null,
               invitation.id, invitation.created_at, invitation.invited_by, createdAt, null);
      } catch (e) {
        if (e.code === "SQLITE_CONSTRAINT_UNIQUE") { nicknameOrEmailTaken = true; throw e; }
        throw e;
      }
      recordUserEvent(userId, "created", invitation.invited_by, { ...reqContext(req), via: "invitation", email: primaryEmail, ...(held ? { held_for_approval: true } : {}) });
      // Held: nothing more is written. No approval, no enrolment, no group.
      if (held) return;
      recordUserEvent(userId, "approved", invitation.invited_by, { ...reqContext(req), via: "invitation_auto_approval" });
      const insertCU = db.prepare("INSERT OR IGNORE INTO competition_users (competition_id, user_id, assigned_by, assigned_at) VALUES (?,?,?,?)");
      for (const cid of compIds) {
        const r = insertCU.run(cid, userId, invitation.invited_by, createdAt);
        if (r.changes > 0) {
          const _c = getCompetition(cid);
          const compName = _c?.name;
          // v8.12.6 — a row written through an event's late-entry window says so,
          // as at every other admission door. Admission itself is deliberately not
          // re-asked here: a stored invitation keeps the tolerance it always had.
          const _lateMark = _c && competitionAdmission(_c) === "late" ? { late_entry: true } : {};
          recordUserEvent(userId, "added_to_competition", invitation.invited_by, { ...reqContext(req), competition_id: cid, competition_name: compName, via: "invitation", ..._lateMark });
          recordCompetitionEvent(cid, "user_added", invitation.invited_by, { ...reqContext(req), user_id: userId, nickname, via: "invitation", ..._lateMark });
        }
      }
      // v6.20.0 — join the invitation's target groups (reconcile after commit).
      const insertGM = db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, added_at, added_by) VALUES (?,?,?,?)");
      for (const gid of groupIdsToJoin) {
        // v7.11.2 — defensively skip a group whose binding would put this newly-registered
        // user in ≥2 groups bound to one competition. The invite-time guard checks bindings
        // AT INVITE TIME; a group could have been bound between invite and registration.
        // Add the non-conflicting groups; never brick a legitimate sign-up. (Reads see the
        // groups added earlier in this txn, so the greedy skip is order-consistent.)
        if (detectMemberAddClashes(gid, [userId]).length) continue;
        if (insertGM.run(gid, userId, createdAt, invitation.invited_by).changes > 0) {
          const gname = db.prepare("SELECT name FROM groups WHERE id=?").get(gid)?.name;
          recordUserEvent(userId, "group_added", invitation.invited_by, { ...reqContext(req), group_id: gid, name: gname, via: "invitation" });
        }
      }
    });
    // v6.16.9 — runTxnWithMirrorBuffer drops audit-log mirror lines if the txn rolls back.
    try { runTxnWithMirrorBuffer(() => claimAndInsertTxn()); invalidateAdminParticipantsCache(); }
    catch (e) {
      if (claimFailed) return res.status(409).json({ error: "This invitation has already been used." });
      if (nicknameOrEmailTaken) return res.status(409).json({ error: "Nickname or email is already taken." });
      throw e;
    }
    if (held) {
      // The address is proven, so the account is verified; it waits for approval,
      // not signed in, with nothing provisioned or claimed (the held sign-up's rule).
      db.prepare("UPDATE users SET first_verified_at=COALESCE(first_verified_at, ?) WHERE id=?").run(createdAt, userId);
      delete req.session.emailProof;
      return res.json({ ok: true, pendingApproval: true, email: primaryEmail, ..._closedMark });
    }
    // v8.3.20 (external audit) — HAND IT TO THE QUEUE, do not await it.
    //
    // The comment here used to say provisioning was "best-effort and async …
    // so a slow upstream can't block the invitation claim path", and the code
    // underneath it AWAITED every competition in series. The claim had already
    // committed, so a degraded Checkmarx One IDP could only ever turn a
    // succeeded registration into a reported failure: `cxOneProvisionUser`
    // makes 2-6 sequential upstream hops, each with its own
    // EXTERNAL_FETCH_TIMEOUT_MS (10 s) deadline that covers the body since
    // v7.15.12, and `invitation.competition_ids` carries no count cap — so ONE
    // merely-slow competition can outlast the SPA's own 30 s abort
    // (features/auth.js), and the invitee is told to try again on an account
    // that already exists.
    //
    // `enqueueCxOneProvision` is the bounded 5-in-flight / 5000-deep queue
    // every OTHER provisioning trigger already uses (assign, invite, group
    // sync, self-enroll). It is synchronous, cannot throw, and applies the same
    // swallow-and-sanitise catch this loop wrote by hand. It also makes the
    // work COUNTABLE at shutdown — an in-flight await inside a request is
    // invisible to the graceful-shutdown drain, which waits on
    // cxOneInflight() + cxOneQueueDepth().
    const user = { id: userId, nickname, first_name: firstName, last_name: lastName, email: primaryEmail };
    for (const cid of compIds) enqueueCxOneProvision(user, cid, "invite_register");
    // v6.20.0 — reconcile each joined group's bound competitions so the new
    // user lands in any live-synced competitions immediately.
    for (const gid of groupIdsToJoin) {
      try { await reconcileGroupBoundCompetitions(gid, { actor: invitation.invited_by }); } catch (e) { swallowed("auth:invite-group-reconcile", e); }
    }
    // The address was proven by the code that bought the grant: the account is
    // signed in at once, the grant spent.
    db.prepare("UPDATE users SET first_verified_at=COALESCE(first_verified_at, ?) WHERE id=?").run(createdAt, userId);
    delete req.session.emailProof;
    const _invUser = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
    stampLoginTimes(userId, now().toISOString());
    claimInvitationsForAccount(_invUser, primaryEmail, req);   // any other invitation to this address
    const _invClosed = _closedMarkUnless(compIds);
    return _signInAs(req, res, _invUser, "email_proof", (skippedCompetitions.length || _invClosed.join_link_closed) ? { ...(skippedCompetitions.length ? { skippedCompetitions } : {}), ..._invClosed } : null);
  }

  // Non-invited users: the grant proved the address, so the account is created
  // verified and, unless `require_account_approval` holds it (below), approved
  // and signed in at once (`_signInAs`).
  //
  // v6.13.20 — wrap the final emailIsTaken re-check + INSERT in a
  // db.transaction so the cross-slot uniqueness invariant (no address
  // appears as A.email AND B.secondary_email or vice versa) is
  // enforced atomically with the INSERT. Pre-fix, the early emailIsTaken
  // checks at the top of this handler ran outside any transaction, and
  // any await between those checks and the INSERT would open a window in
  // which two concurrent registrations
  // could both pass and both insert. SQLite's UNIQUE indexes cover
  // primary↔primary and secondary↔secondary collisions but NOT the
  // cross-slot case (the two per-column NOCASE indexes in db.js).
  // WHY the re-check inside this txn holds — v8.12.6 corrected the
  // mechanism this comment used to give ("better-sqlite3's transactions
  // use BEGIN IMMEDIATE", which they do not; `db.transaction()` is a
  // DEFERRED BEGIN and the write lock is taken at the INSERT, not at the
  // SELECT). The argument still holds, for two reasons that are true: the
  // txn body is synchronous, so in this single-process server no other
  // request can run between the SELECT and the INSERT; and an EXTERNAL
  // writer (an operator's sqlite3 session) cannot slip a row in between
  // either, because under WAL SQLite refuses to upgrade a read snapshot
  // another connection has since written past (SQLITE_BUSY_SNAPSHOT) —
  // so the worst an external writer can cause is an error, never a
  // duplicate.
  const newUserId = uuid();
  // THE ADDRESS IS PROVEN (the grant), so the account is created VERIFIED. It is
  // APPROVED unless `require_account_approval` is on — exactly what redeeming an
  // emailed code does for a pending account. A sign-up through a live event's
  // join link, QR or event code never waits, whatever the setting (operator
  // ruling, 3 Nov 2026): the organiser opened that event to walk-ups. The join
  // event is enrolled at the sign-in through the ordinary admission ladder
  // (`pending_self_enroll_comp_id`, consumed by `_consumeJoinForCode`).
  const _requireApproval = getRequireAccountApproval();
  const _approved   = (_requireApproval && !joinComp) ? 0 : 1;
  const _approvedAt = _approved ? createdAt : null;
  const _approvedBy = joinComp ? "self_enroll" : (_approved ? "email_proof" : null);
  const _joinPendingComp = joinComp ? joinComp.id : null;
  let crossSlotConflict = null;
  const insertUserTxn = db.transaction(() => {
    if (emailIsTaken(email)) { crossSlotConflict = "primary"; throw new Error("email_taken"); }
    if (secondaryEmail && emailIsTaken(secondaryEmail)) { crossSlotConflict = "secondary"; throw new Error("secondary_taken"); }
    // password_set_at stays NULL: a new account has no password (NO_PASSWORD_HASH);
    // one is set only through PUT /api/me/sign-in-method.
    // v8.1.0 (PR 31) — `profile_policy` is bound EXPLICITLY and is NULL for every
    // ordinary registration, so nothing changes for them. It is stamped even when
    // the visitor filled every field in: the policy records the DEAL they signed
    // up under, not what they happened to type, or a booth account that answered
    // everything would be gated later for a field it never actually lost.
    db.prepare(`INSERT INTO users (id,first_name,last_name,nickname,company,title,personal_title,phone,email,secondary_email,avatar,verify_code,verify_code_at,verified,first_verified_at,approved,approved_at,approved_by,password_hash,reset_code,reset_code_at,country,timezone,job_function,city,linkedin_url,pending_self_enroll_comp_id,self_enroll_grace_until,profile_policy,registration_competition_id,created_at,password_set_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,1,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)`)
      .run(newUserId, firstName, lastName, nickname, company, title, personalTitle, phone, email, secondaryEmail||null, avatar || "default1",
           createdAt, _approved, _approvedAt, _approvedBy, passwordHash, null, null,
           country||null, timezone||null, jobFunction||null, city||null, validateUrl(linkedinUrl)||null, _joinPendingComp, _profilePolicy,
           // v8.4.0 — WHICH EVENT THIS ACCOUNT WAS CREATED THROUGH, so the
           // completion gate can re-read that event's CURRENT requirements rather
           // than the deal as it stood today. NULL for every registration that did
           // not arrive through a join link, which is every existing behaviour.
           // `profile_policy` beside it is the fallback for when this event is
           // deleted — see the pair's reasoning in db.js and lib/util.js.
           _joinCompEarly ? _joinCompEarly.id : null,
           createdAt, null);
  });
  try { insertUserTxn(); }
  catch (e) {
    if (crossSlotConflict === "primary") return res.status(409).json({ error: "This email is already registered." });
    if (crossSlotConflict === "secondary") return res.status(409).json({ error: "This secondary email is already in use by another account." });
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "Nickname or email is already taken." });
    throw e;
  }
  recordUserEvent(newUserId, "self_registered", "system", { ...reqContext(req), email, ...(joinComp ? { via: "self_enroll" } : { via: "email_proof" }) });
  recordUserEvent(newUserId, "self_verified", "system", { ...reqContext(req), via: "email_proof" });
  // v6.21.0 — record the approval as its own audit event (parity with the
  // invitation path's "approved via invitation_auto_approval").
  if (joinComp && _approved) recordUserEvent(newUserId, "approved", "self_enroll", { ...reqContext(req), via: "self_enroll_auto_approval", competition_id: joinComp.id, competition_name: joinComp.name });
  else if (_approved) recordUserEvent(newUserId, "approved", "system", { ...reqContext(req), via: "email_proof_auto_approval" });
  invalidateAdminParticipantsCache();
  // The grant is spent whatever happens next.
  delete req.session.emailProof;
  const _newUser = db.prepare("SELECT * FROM users WHERE id=?").get(newUserId);
  if (!_approved) {
    // The approval queue holds it: created and verified, not signed in. Nothing
    // is claimed for a held account (the code redeem's own order): an invitation
    // is claimed at its first sign-in once approved.
    return res.json({ ok: true, pendingApproval: true, email, ...(joinComp ? { competition_name: joinComp.name } : {}), ..._closedMark });
  }
  // Invitations addressed to this address are claimed exactly as a redeemed
  // emailed code claims them for an existing account.
  claimInvitationsForAccount(_newUser, email, req);
  stampLoginTimes(newUserId, now().toISOString());
  _consumeJoinForCode(newUserId, req);
  return _signInAs(req, res, _newUser, "email_proof", joinLinkClosed ? _closedMark : null);
});

// A unique nickname from a name: first three + "_" + last three letters
// (transliterated to ASCII, as the SPA's suggestion always was) and a three-digit
// suffix, re-rolled until free. Falls back to "player" for a name with no ASCII
// letters, and to a longer random suffix if every short one is taken.
function _suggestNickname(first, last) {
  const f = _transliterateAscii(first).slice(0, 3);
  const l = _transliterateAscii(last).slice(0, 3);
  const base = (f && l) ? `${f}_${l}` : (f || l || "player");
  const taken = db.prepare("SELECT 1 FROM users WHERE nickname=? COLLATE NOCASE");
  for (let i = 0; i < 25; i++) {
    const c = `${base}${100 + crypto.randomInt(900)}`;
    if (!taken.get(c)) return c;
  }
  return `${base}${crypto.randomBytes(4).toString("hex")}`;
}

// A grant's event, resolved by id: joinable now (link on, event accepting), or
// null — the registration then proceeds without the event rather than failing a
// person who cannot do anything about a link that closed meanwhile.
function _joinableById(compId) {
  const comp = compId ? db.prepare("SELECT self_enroll_token FROM competitions WHERE id=?").get(compId) : null;
  if (!comp || !comp.self_enroll_token) return null;
  return _resolveJoinableComp(comp.self_enroll_token);
}

// THE SIGN-UP GRANT'S EVENT, ONLY THROUGH THE LINK IT WAS ASKED THROUGH (sweep
// #391, operator ruling, 24 Nov 2026). A grant is session state, beyond the
// database write that unties codes and proofs when a link is switched off or
// replaced, so the register asks itself: the event must be joinable now
// (`_joinableById`: its link switched on, the event taking joins) through the very
// link this browser asked through when it requested the code (the grant's
// `joinLinks`, `joinLinkTag`s). A link replaced by Regenerate since is another
// link; one switched off and on again is the same link. Null otherwise, and the
// register then reads the grant as one naming no event (`grantComp`): the account
// is made without the event, as `_joinableById` says. A grant with
// no links (one redeemed before links were kept) names no event: it fails closed.
function _grantLinks(grant) {
  return grant && Array.isArray(grant.joinLinks) ? grant.joinLinks.filter(t => typeof t === "string" && t) : [];
}
function _joinableUnderGrant(grant) {
  const comp = _joinableById(grant.joinCompId);
  const link = liveJoinLinkTag(comp);
  return link && _grantLinks(grant).includes(link) ? comp : null;
}
// A body join token whose link is no longer live but which this browser asked
// through when it requested the code: the link closed meanwhile.
function _closedLinkAskedHere(grant, joinToken) {
  if (typeof joinToken !== "string" || !joinToken || _resolveJoinableComp(joinToken)) return false;
  return _grantLinks(grant).includes(joinLinkTag(joinToken));
}

app.get("/api/check-nickname", rateLimit(60_000, 30, "nickname"), (req, res) => {
  // audit v7.7.38 (H1) — type-guard the query param before .trim(). Under Express 5
  // a repeated key (?nickname=a&nickname=b) yields an ARRAY, which is truthy, so
  // (arr || "").trim() → TypeError → 500 on this UNAUTHENTICATED endpoint.
  const nick = (typeof req.query.nickname === "string" ? req.query.nickname : "").trim();
  if (!nick) return res.json({ available: false });
  // v7.2.x (ext-audit F1) — a non-ASCII nickname is not registerable, so report
  // it as unavailable (the client also blocks it before submit).
  if (!_nicknameCharsOk(nick)) return res.json({ available: false });
  // ext-audit v7.21.1 (A7 residual) — this endpoint answers "can I have this
  // handle?", so it must apply EVERY rule registration applies, not just the
  // charset one. It was reporting a 2-character nickname as available while
  // POST /api/register 400s it — the user picks it, sees a green tick, and is
  // refused on submit. Same mirror-divergence class as the email validator.
  if (nick.length < 3) return res.json({ available: false });
  // Mirror the DB's COLLATE NOCASE unique index — a case-only variant is
  // NOT available even if the registration page shows it as free.
  const exists = db.prepare("SELECT id FROM users WHERE nickname=? COLLATE NOCASE").get(nick);
  res.json({ available: !exists });
});

// v6.16.31 — One-click HTTPS unsubscribe per RFC 8058.
//
// Two surfaces for one logical action:
//   POST /api/unsubscribe?token=<HMAC-signed>  — One-click flow per
//     RFC 8058. Mail clients (Gmail, Outlook 365) issue this when
//     the user clicks the X / "Unsubscribe" affordance attached to
//     `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. NO CSRF
//     gate — the request originates from a mail client outside any
//     browser session, has no cookies, and the HMAC token is the
//     only authoritative signal. NO body is required.
//   GET /api/unsubscribe?token=<HMAC-signed>  — Browser-friendly
//     variant for users who click the URL inside the email body.
//     Returns a tiny self-contained HTML confirmation page.
//
// Both surfaces share the same handler logic: verify the token,
// extract the normalised email, INSERT OR REPLACE into
// `unsubscribed_emails`, return 200. Invalid / expired token → 400.
// Per-IP rate limit prevents a leaked URL from being mass-replayed
// against a fleet of recipients (the token itself is per-recipient
// so a leaked one only opts out one address — the rate limit is
// belt-and-braces).
const _UNSUB_LIMIT = rateLimit(60_000, 30, "unsubscribe");
// ext-audit v7.15.12 — one shell for every unsubscribe page. These are the only
// user-facing HTML the server renders outside the SPA, and they were bare inline
// markup: no charset/viewport, no theme, none of the platform's typography, and
// no brand context — a recipient arriving from an email saw an unstyled document
// that gives no confidence it belongs to this platform. They cannot use the SPA
// shell (an unsubscribe click is unauthenticated and must work with JS disabled),
// so they get a small self-contained shell that follows the same design tokens:
// Inter, the dark/light surface pair via prefers-color-scheme, and a 44px
// touch-target button.
//
// audit v7.23.6 — the rules live in public/unsubscribe.css, NOT in an inline
// <style> block. They were inlined "so the page renders even if the static
// asset pipeline is unavailable", but the global CSP sets
// `style-src-elem 'self'`, so the browser dropped the block on every request
// and the page rendered as raw browser default (styleSheets 0, Times New
// Roman) for eight releases. Its server-rendered sibling _emailResultPage has
// always linked its stylesheets. Do not re-inline this.
function _unsubShell(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/fonts.css"/><link rel="stylesheet" href="/unsubscribe.css"/></head><body><main class="card">${bodyHtml}</main></body></html>`;
}


function _doUnsubscribe(req, res, format /* "json" | "html" */) {
  // typeof each half, never `.toString()`: the form-encoded body parser builds an
  // object from `token[toString]=x`, whose toString is not callable (a 500 on an
  // anonymous route). A non-string token is a missing one.
  const token = (typeof req.query?.token === "string" && req.query.token)
    || (typeof req.body?.token === "string" && req.body.token) || "";
  const email = verifyUnsubscribeToken(token);
  if (!email) {
    if (format === "html") {
      res.status(400).type("text/html; charset=utf-8").send(_unsubShell("Unsubscribe link expired",
        `<h1>This link is no longer valid</h1>
         <p>Unsubscribe links expire after a year, and each one can only be used from the email it came in.</p>
         <p class="fine">If you keep receiving emails you don't want, just reply to one and we'll remove you manually.</p>`));
    } else {
      res.status(400).json({ error: "Invalid or expired unsubscribe token." });
    }
    return;
  }
  const ctx = reqContext(req);
  db.prepare(
    "INSERT OR REPLACE INTO unsubscribed_emails (email, unsubscribed_at, reason, user_agent, ip) VALUES (?,?,?,?,?)"
  ).run(email, new Date().toISOString(), format === "html" ? "browser_link" : "one_click", ctx.user_agent || null, ctx.ip || null);
  // Forensic record. Look up the user_id (if any) so the row
  // surfaces in their per-user audit feed; otherwise the orphan-
  // scoped event captures the email + reason + ip.
  try {
    const user = findUserByAddress(db, email, "id");   // indexed (lib/account-lookup.js)
    if (user) {
      recordUserEvent(user.id, "email_unsubscribed", "self", { ...reqContext(req), ...ctx, via: format === "html" ? "browser_link" : "one_click" });
    } else {
      recordOrphanedAuditEvent("email", email, "unsubscribed", "self", { ...reqContext(req), ...ctx, via: format === "html" ? "browser_link" : "one_click" });
    }
  } catch (e) {
    // never let the audit write break the response
    swallowed("auth:unsubscribe-audit", e);
  }
  if (format === "html") {
    // v6.16.41 — escapeHtml, not the local-scoped `esc` alias used at
    // server.js:1401 / :4945. The unsubscribe handler doesn't have one
    // in scope, so the original `esc(email)` raised ReferenceError
    // AFTER the DB INSERT had already committed — recipient was
    // unsubscribed but saw an internal-error page.
    res.type("text/html; charset=utf-8").send(_unsubShell("Unsubscribed",
      `<h1>You've been unsubscribed</h1>
       <p class="addr">${escapeHtml(email)}</p>
       <p>This address will no longer receive invitations, reminders or event-assignment emails.</p>
       <p>Security-sensitive messages — verification, sign-in codes and account lockout — are still delivered, because they can't be opted out of.</p>
       <p class="fine">Unsubscribed by mistake? Contact your event organiser to be re-subscribed.</p>`));
  } else {
    res.json({ ok: true, email, message: "Unsubscribed successfully." });
  }
}
// One-click POST per RFC 8058 — no CSRF (mail clients have no cookies).
//
// v8.13.3 — there is NO route-level body parser here any more, and there never
// effectively was one. This route used to mount `express.urlencoded({ limit:
// "8kb" })`, but server.js's global urlencoded parser runs first and consumes the
// stream, and body-parser 2 then SKIPS a request whose stream has finished — so
// the 8 KB cap never applied (measured: a 200 KB form body was answered 200). A cap
// that appears to work is worse than none. The real cap is now server.js's
// `_PUBLIC_FORM_PATHS`, which gives this unauthenticated form the 16 KB auth-sized
// parser for BOTH JSON and form-encoded bodies, before any route runs.
app.post("/api/unsubscribe", _UNSUB_LIMIT, (req, res) => {
  // The confirmation form (below) posts form-encoded; RFC 8058 one-click posts
  // an empty body with the token in the query string. Both land here.
  _doUnsubscribe(req, res, req.is("application/x-www-form-urlencoded") ? "html" : "json");
});
// Browser-friendly GET — same contract, HTML response. Both methods
// are documented in swagger.yaml.
// ext-audit v7.15.11 — GET no longer MUTATES. The same URL is advertised for
// RFC 8058 one-click (POST) and for humans clicking the link in the mail body,
// and security scanners / link-prefetchers routinely GET every URL in an email —
// which silently opted the recipient out of invitations, reminders and
// assignment mail. A GET is a safe method: it now renders a confirmation form
// whose submit POSTs the token. One-click (POST) is unchanged, so the mail-client
// affordance still works in a single step.
app.get("/api/unsubscribe", _UNSUB_LIMIT, (req, res) => {
  const token = typeof req.query?.token === "string" ? req.query.token : "";
  const email = verifyUnsubscribeToken(token);
  if (!email) {
    return res.status(400).type("text/html; charset=utf-8").send(_unsubShell("Unsubscribe link expired",
      `<h1>This link is no longer valid</h1>
       <p>Unsubscribe links expire after a year, and each one can only be used from the email it came in.</p>
       <p class="fine">If you keep receiving emails you don't want, just reply to one and we'll remove you manually.</p>`));
  }
  res.type("text/html; charset=utf-8").send(_unsubShell("Confirm unsubscribe",
    `<h1>Unsubscribe this address?</h1>
     <p class="addr">${escapeHtml(email)}</p>
     <p>You'll stop receiving event invitations, reminders and assignment notifications.</p>
     <form method="POST" action="/api/unsubscribe">
       <input type="hidden" name="token" value="${escapeHtml(token)}"/>
       <button type="submit">Yes, unsubscribe me</button>
     </form>
     <p class="fine">Didn't mean to click this? Just close the page — nothing has changed yet.</p>`));
});

// ── Email verification — ONE CLICK from the email (v7.23.10) ───────────────
//
// The link in the verification email used to land on an interstitial ("Click
// the button below to verify your email address") whose only job was to turn
// the GET into a POST. That shape came from the v7.15.11 audit rule "a GET must
// never mutate", generalised from GET /api/unsubscribe where a link-scanner's
// prefetch silently opted recipients OUT of mail they wanted.
//
// THIS ROUTE IS A REASONED EXCEPTION TO THAT RULE, not an oversight — see the
// accepted-dispositions note in CLAUDE.md, which must stay in step with this
// comment. The unsubscribe harm was an outcome the recipient did not want,
// could not see, and could not undo. Verification is the outcome they asked for
// by registering; it grants no capability beyond itself; and it is presented
// idempotently. The real harm a mutating GET would cause here is narrower and
// entirely fixable: a scanner spends the single-use code, and the human who
// clicks afterwards is told "Verification Failed" for an account that IS
// verified. That is what the ordering below exists to prevent.
//
// THE MARKER MOVED. `verify_code=NULL` used to mean "consumed" — which is
// precisely why a second request could not tell "already done" from "never
// existed": the SELECT stopped finding the row. `verified` is the marker now,
// and the retained code acts as a 48h idempotency receipt. No new column.
function _completeVerification(req, res, code) {
  // A 302 with no Cache-Control is heuristically cacheable, and an intermediary
  // caching a FAILURE redirect would outlive the fix for that user. Same
  // reasoning as the maintenance response (server.js, v6.10.51).
  res.setHeader("Cache-Control", "no-store");
  if (!code) return res.redirect("/verify-failed.html");
  const user = db.prepare("SELECT * FROM users WHERE verify_code=?").get(code);
  if (!user) return res.redirect("/verify-failed.html");

  // ALREADY VERIFIED — and this MUST precede the expiry check. The code now
  // survives a successful verification, so at T+48h an already-verified user
  // clicking their own link would otherwise be told "Link Expired". Telling
  // someone their verification expired when they are verified is the wrong
  // answer twice over.
  if (user.verified) {
    // Opportunistic cleanup: past the window the receipt has no further job, so
    // drop it. The reaper does the same sweep on a timer for users who never
    // click again — see sweepStaleVerifyCodes.
    const ageMs = user.verify_code_at ? (Date.now() - new Date(user.verify_code_at).getTime()) : Infinity;
    if (ageMs > CODE_EXPIRY_MS) {
      try { db.prepare("UPDATE users SET verify_code=NULL, verify_code_at=NULL WHERE id=?").run(user.id); } catch (e) { swallowed("auth:verify-code-clear", e); }
    }
    return res.redirect("/verified.html");
  }

  // Fail-safe: missing timestamp ⇒ treat as expired (a buggy insert path that
  // forgot to stamp verify_code_at would otherwise leave the code valid for ever).
  const verifyAgeMs = user.verify_code_at ? (Date.now() - new Date(user.verify_code_at).getTime()) : Infinity;
  if (verifyAgeMs > CODE_EXPIRY_MS) {
    db.prepare("UPDATE users SET verify_code=NULL, verify_code_at=NULL WHERE id=?").run(user.id);
    try { recordUserEvent(user.id, "verify_code_expired", "system", { ...reqContext(req), age_ms: Number.isFinite(verifyAgeMs) ? verifyAgeMs : null }); } catch (e) { swallowed("auth:verify-expired-audit", e); }
    return res.redirect("/verify-expired.html");
  }

  // The atomic claim, with `AND verified=0` doing the work `verify_code=NULL`
  // used to: exactly one of two same-instant requests reports changes===1, so
  // the side effects below run once. The code is deliberately NOT cleared.
  const claim = db.prepare("UPDATE users SET verified=1, first_verified_at=COALESCE(first_verified_at, ?), self_enroll_grace_until=NULL WHERE id=? AND verify_code=? AND verified=0")
    .run(now().toISOString(), user.id, code);
  if (claim.changes === 0) {
    // Lost a race, or resend-verification replaced the code underneath us.
    // Report the TRUTH rather than a blanket failure.
    const fresh = db.prepare("SELECT verified FROM users WHERE id=?").get(user.id);
    return res.redirect(fresh && fresh.verified ? "/verified.html" : "/verify-failed.html");
  }
  invalidateAdminParticipantsCache();
  _invalidateMeCache(user.id);
  // audit v7.7.36 (C7) — verified=1 is a leaderboard membership predicate, so a
  // grace participant who scored while verified=0 becomes board-eligible; bust
  // every enrolled comp's board.
  try { db.prepare("SELECT competition_id FROM competition_users WHERE user_id=?").all(user.id).forEach(r => invalidateLeaderboardCache(r.competition_id)); } catch (e) { swallowed("auth:verify-board-bust", e); }
  try { recordUserEvent(user.id, "self_verified", "system", { ...reqContext(req), via: req.method === "GET" ? "one_click" : "form_post" }); } catch (e) { swallowed("auth:self-verified-audit", e); }
  // Post/redirect/get is PRESERVED: the browser ends on a static page, so a
  // refresh re-fetches that page and never re-enters this handler.
  return res.redirect("/verified.html");
}

app.get("/verify", rateLimit(60_000, 30, "verify"), (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : ""; // ext-audit batch 3 (F3): coerce a non-string to "" (else it binds into SQL → 500)
  if (!code) return res.redirect("/");
  return _completeVerification(req, res, code);
});

// POST /verify is KEPT as an alias, not removed: verification emails already in
// inboxes link to the GET, but a page cached in a browser from before this
// release can still submit the old form, and it must keep working. Same 30/min
// bucket, and CSRF stays on the POST because it still accepts a form body.
app.post("/verify", rateLimit(60_000, 30, "verify-post"), csrfProtection, (req, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  return _completeVerification(req, res, code);
});

// v7.23.11 — the three verification RESULT pages, served from the one builder.
//
// They were static files in public/, reached by res.redirect from the verify
// handler. THE REDIRECT IS KEPT DELIBERATELY, and the URLs are unchanged: it is
// what leaves the browser resting on a page whose address carries NO code, so
// the receipt stays out of the address bar, history and any Referer. Rendering
// inline at /verify?code=X would have killed the fork too, and thrown that away
// for nothing.
//
// So the fork dies without moving a URL: same paths, same redirect, one
// implementation. Every test that navigates to these URLs keeps working, which
// is the proof this changed nothing but the source of the markup (v7.17.1 — a
// refactor that forces unrelated tests to change hides whether it changed
// anything).
const _RESULT_PAGES = {
  "/verified.html":       [200, "Email Verified!", "Your account is active. You can now log in.", "ok"],
  "/verify-expired.html": [200, "Link Expired", "This verification link has expired. Sign in with an emailed code instead — entering a code we email you also confirms your address.", "warn"],
  "/verify-failed.html":  [200, "Verification Failed", "The link may be invalid or already used.", "err"],
};
for (const [path, [status, heading, message, tone]] of Object.entries(_RESULT_PAGES)) {
  app.get(path, (req, res) => _emailResultPage(res, status, heading, message, tone));
}

// ── Pending-email confirmation (v7.5.0) ──────────────────────────────────────
// A primary-email CHANGE (PUT /api/me) is staged in users.pending_email and
// confirmed here by a link sent to the NEW address — mirroring the /verify
// GET→POST shape so an email link-scanner's GET prefetch can't auto-consume the
// code. The current email + session stay live the whole time; the swap only
// happens on the explicit POST. See EMAIL_RULES.md.
// v7.23.11 — the ONE builder for every standalone result page.
//
// It used to render only the email-CHANGE outcomes, while /verified.html,
// /verify-expired.html and /verify-failed.html were three STATIC files carrying
// the same shell — a fork that cost the wrong platform name (v7.23.6) and left
// the server-rendered half unobserved (no axe scan until v7.23.10). Those three
// URLs are now served by routes below that call this, so there is one
// implementation and one place to fix.
//
// Converging meant this builder had to take on what the static pages did BETTER,
// not the other way round: a third tone (they distinguish expired from failed),
// role="main", role="status"/"alert" on the card, and the social footer. Losing
// any of those would have been a downgrade dressed as a cleanup.
//
// `tone`: "ok" | "warn" | "err".
const _RESULT_TONE = {
  ok:   { cls: "success", role: "status", stroke: "var(--green)" },
  warn: { cls: "warning", role: "status", stroke: "var(--yellow)" },
  err:  { cls: "error",   role: "alert",  stroke: "var(--red)" },
};

const _RESULT_ICON = {
  ok: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
  warn: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  err: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
};

const _RESULT_FOOTER = `<footer>
  <div class="footer-logo"><img class="logo-dark" src="/checkmarx-logo-white.svg" alt="Checkmarx"/><img class="logo-light" src="/checkmarx-logo-blue.svg" alt="Checkmarx"/></div>
  <div class="footer-copy">&copy; 2026 Checkmarx Ltd. All Rights Reserved.</div>
  <div class="footer-social">
    <a href="https://www.linkedin.com/company/checkmarx" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn" title="LinkedIn"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.37V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45zM22.23 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.46C23.21 24 24 23.23 24 22.28V1.72C24 .77 23.21 0 22.23 0z"/></svg></a>
    <a href="https://x.com/checkmarx" target="_blank" rel="noopener noreferrer" aria-label="X / Twitter" title="X / Twitter"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a>
    <a href="https://www.facebook.com/Checkmarx.Source.Code.Analysis/" target="_blank" rel="noopener noreferrer" aria-label="Facebook" title="Facebook"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg></a>
    <a href="https://www.youtube.com/checkmarx" target="_blank" rel="noopener noreferrer" aria-label="YouTube" title="YouTube"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></a>
  </div>
</footer>`;

function _emailResultPage(res, status, heading, message, tone) {
  const platformName = getPlatformName();
  const t = _RESULT_TONE[tone] || _RESULT_TONE.err;
  const icon = _RESULT_ICON[tone] || _RESULT_ICON.err;
  res.status(status).send(`<!DOCTYPE html><html lang="en"${platformLookAttr()}><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="color-scheme" content="light dark"/>
<title>${escapeHtml(heading)} | ${escapeHtml(platformName)}</title><link rel="icon" href="/favicon.webp"/>
<link rel="stylesheet" href="/fonts.css"/><link rel="stylesheet" href="/verify-pages.css"/>
<script src="/theme-boot.js"></script></head><body>
<header><h1><img class="logo-dark" src="/checkmarx-logo-white.svg" alt="Checkmarx"/><img class="logo-light" src="/checkmarx-logo-blue.svg" alt="Checkmarx"/><span>${escapeHtml(platformName)}</span></h1></header>
<main role="main"><div class="card ${t.cls}" role="${t.role}"><div class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="${t.stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></div>
<h2>${escapeHtml(heading)}</h2><p>${escapeHtml(message)}</p><a class="btn" href="/">Go to ${escapeHtml(platformName)}</a></div></main>
${_RESULT_FOOTER}</body></html>`);
}

app.get("/confirm-email", rateLimit(60_000, 30, "confirm-email"), (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : ""; // ext-audit batch 3 (F3): coerce non-string to "" (else a non-string binds into SQL → 500)
  if (!code) return res.redirect("/");
  const user = db.prepare("SELECT id, pending_email, pending_email_code_at FROM users WHERE pending_email_code=?").get(code);
  // Uniform failure — no oracle for a valid-but-stale vs. never-existed code.
  if (!user || !user.pending_email) return _emailResultPage(res, 400, "Link not valid", "This email-change link is invalid or has already been used. If you still want to change your email, request it again from your profile.", "err");
  const ageMs = user.pending_email_code_at ? (Date.now() - new Date(user.pending_email_code_at).getTime()) : Infinity;
  if (ageMs > CODE_EXPIRY_MS) {
    db.prepare("UPDATE users SET pending_email=NULL, pending_email_code=NULL, pending_email_code_at=NULL WHERE id=?").run(user.id);
    _invalidateMeCache(user.id);
    // audit-event-logging audit (v7.7.15) — parity with verify_code_expired.
    try { recordUserEvent(user.id, "email_change_expired", "system", { ...reqContext(req), age_ms: Number.isFinite(ageMs) ? ageMs : null, trigger: "get_confirm" }); } catch (e) { swallowed("auth:email-change-expired-audit", e); }
    return _emailResultPage(res, 400, "Link expired", "This email-change link has expired. Request the change again from your profile to get a fresh link.", "err");
  }
  const csrfToken = String(generateToken(req)).replace(/[^a-zA-Z0-9_\-]/g, "");
  const platformName = getPlatformName();
  res.send(`<!DOCTYPE html><html lang="en"${platformLookAttr()}><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="color-scheme" content="light dark"/>
<title>Confirm Email Change | ${escapeHtml(platformName)}</title><link rel="icon" href="/favicon.webp"/>
<link rel="stylesheet" href="/fonts.css"/><link rel="stylesheet" href="/verify-pages.css"/>
<script src="/theme-boot.js"></script></head><body>
<header><h1><img class="logo-dark" src="/checkmarx-logo-white.svg" alt="Checkmarx"/><img class="logo-light" src="/checkmarx-logo-blue.svg" alt="Checkmarx"/><span>${escapeHtml(platformName)}</span></h1></header>
<main><div class="card"><div class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg></div>
<h2>Confirm Your New Email</h2><p>Confirm changing your sign-in email to <strong>${escapeHtml(user.pending_email)}</strong>.</p>
<form method="POST" action="/confirm-email"><input type="hidden" name="code" value="${escapeHtml(code)}"/>
<input type="hidden" name="_csrf" value="${csrfToken}"/><button type="submit" class="btn">Confirm New Email</button></form></div></main>
<footer><div class="footer-logo"><img class="logo-dark" src="/checkmarx-logo-white.svg" alt="Checkmarx"/><img class="logo-light" src="/checkmarx-logo-blue.svg" alt="Checkmarx"/></div>
<div class="footer-copy">&copy; 2026 Checkmarx Ltd. All Rights Reserved.</div></footer></body></html>`);
});

app.post("/confirm-email", rateLimit(60_000, 30, "confirm-email-post"), csrfProtection, (req, res) => {
  const code = typeof req.body.code === "string" ? req.body.code : ""; // ext-audit batch 3 (F3): coerce non-string to "" (else a non-string binds into SQL → 500)
  if (!code) return _emailResultPage(res, 400, "Link not valid", "This email-change link is invalid or has already been used.", "err");
  const user = db.prepare("SELECT id, email, secondary_email, pending_email, pending_email_code_at FROM users WHERE pending_email_code=?").get(code);
  if (!user || !user.pending_email) return _emailResultPage(res, 400, "Link not valid", "This email-change link is invalid or has already been used.", "err");
  const ageMs = user.pending_email_code_at ? (Date.now() - new Date(user.pending_email_code_at).getTime()) : Infinity;
  if (ageMs > CODE_EXPIRY_MS) {
    db.prepare("UPDATE users SET pending_email=NULL, pending_email_code=NULL, pending_email_code_at=NULL WHERE id=?").run(user.id);
    _invalidateMeCache(user.id);
    // audit-event-logging audit (v7.7.15) — parity with verify_code_expired.
    try { recordUserEvent(user.id, "email_change_expired", "system", { ...reqContext(req), age_ms: Number.isFinite(ageMs) ? ageMs : null, trigger: "post_confirm" }); } catch (e) { swallowed("auth:email-change-expired-audit", e); }
    return _emailResultPage(res, 400, "Link expired", "This email-change link has expired. Request the change again from your profile.", "err");
  }
  // Confirm-time re-check: the address may have been claimed since the request —
  // by ANOTHER account (registered / its own pending confirmed; emailIsTaken
  // excludes our row) OR have become THIS user's own secondary slot (e.g. an
  // admin edit moved it there), which the swap would turn into a same-account
  // primary==secondary duplicate. Either way the pending is no longer valid.
  if (emailIsTaken(user.pending_email, user.id) || sameSlotEmails(user.pending_email, user.secondary_email)) {
    db.prepare("UPDATE users SET pending_email=NULL, pending_email_code=NULL, pending_email_code_at=NULL WHERE id=?").run(user.id);
    _invalidateMeCache(user.id);
    try { recordUserEvent(user.id, "email_change_conflict", user.email || "self", { ...reqContext(req), attempted_to: user.pending_email }); } catch (e) { swallowed("auth:email-change-conflict-audit", e); }
    return _emailResultPage(res, 409, "Email no longer available", "That email address is no longer available — it was claimed elsewhere before you confirmed. Your current email is unchanged — pick a different address from your profile.", "err");
  }
  const newEmail = user.pending_email;
  // Atomic claim: only one of two concurrent confirms with the same code lands.
  // Confirming proves ownership of the new address, so verified=1 + grace clears.
  // v7.23.10 — clear the verification receipt too. One-click verification
  // retains verify_code for its 48h window, and that code attests the address
  // that was on the row when it was minted. This statement REPLACES that
  // address, so the retained code would outlive the thing it vouches for.
  // It can only set verified=1 on this row, which is what this statement just
  // did — so nothing is lost by dropping it, and a stale attestation is not
  // left lying around.
  //
  // v8.3.20 (external audit) — AND THE OTHER TWO CREDENTIALS, for the identical
  // reason the paragraph above gives for `verify_code`. That reasoning was
  // applied to one attestation of three: a `reset_code` mailed to the OLD
  // address survives the swap and stays a full-takeover credential for up to
  // 48 h (CODE_EXPIRY_MS) against an address its holder never controlled, and
  // redeeming it also re-stamps `verified=1`. The sign-in code is narrower
  // (10-minute TTL) and is resolved against whatever the CURRENT primary is,
  // so it verifies the new address too. A code attests the address that was on
  // the row when it was minted; this statement REPLACES that address.
  const claim = db.prepare("UPDATE users SET email=?, verified=1, first_verified_at=COALESCE(first_verified_at, ?), self_enroll_grace_until=NULL, verify_code=NULL, verify_code_at=NULL, reset_code=NULL, reset_code_at=NULL, login_code_hash=NULL, login_code_at=NULL, login_code_via=NULL, login_code_sends=0, pending_email=NULL, pending_email_code=NULL, pending_email_code_at=NULL WHERE id=? AND pending_email_code=?")
    .run(newEmail, now().toISOString(), user.id, code);
  if (claim.changes === 0) return _emailResultPage(res, 400, "Link not valid", "This email-change link is invalid or has already been used.", "err");
  _invalidateMeCache(user.id);
  invalidateAdminParticipantsCache();
  try { db.prepare("SELECT competition_id FROM competition_users WHERE user_id=?").all(user.id).forEach(r => invalidateLeaderboardCache(r.competition_id)); } catch (e) { swallowed("auth:email-change-board-bust", e); }
  try { recordUserEvent(user.id, "email_change_confirmed", newEmail, { ...reqContext(req), from: user.email || null, to: newEmail }); } catch (e) { swallowed("auth:email-change-confirmed-audit", e); }
  return _emailResultPage(res, 200, "Email updated", `Your sign-in email is now ${newEmail}. Use it next time you sign in.`, "ok");
});

app.post("/api/logout", csrfProtection, (req, res) => {
  const uid = req.session.userId;
  // v7.14.0 — while impersonating, `userId` is the TARGET but the session is the
  // ADMIN's. Attributing the logout to the target would fabricate a sign-out the
  // participant never performed (indistinguishable from a real one in their
  // History), and destroying without a trace would leave the impersonation
  // window unclosed. Close the window on the target, attribute the logout to the
  // admin, then destroy — the admin clicked Logout, so they are signed out.
  const imp = req.session.impersonator;
  if (imp) {
    const actor = impersonationActor(req.session);
    if (uid) {
      try {
        recordUserEvent(uid, "impersonation_ended", actor,
          { ...impersonationEndedDetails(imp, "logout"), ...reqContext(req) });
      } catch (e) { swallowed("auth:logout-impersonation-ended-audit", e); }
    }
    // v8.13.4 (fix-delta review) — the row lands on the ACTING admin's own History,
    // so `impersonated_by` (which reqContext spreads into every emit in the window)
    // is dropped: on the owner's own row it would name them as their own
    // impersonator. `acting_as` stays, saying whose seat they signed out of — the
    // same shape as the refused-CSRF-token row in server.js.
    if (imp.userId) { try { recordUserEvent(imp.userId, "logout_manual", "system", { ...reqContext(req), impersonated_by: undefined }); } catch (e) { swallowed("auth:logout-acting-admin-audit", e); } }
  } else if (uid) {
    try { recordUserEvent(uid, "logout_manual", "system", reqContext(req)); } catch (e) { swallowed("auth:logout-audit", e); }
  }
  req.session.destroy(() => res.json({ ok: true }));
});

// ── Emailed sign-in codes — the door every account row always has ────────────
//
// Every account (participant, event admin, admin, user-backed superadmin) can
// sign in by requesting a code to its PRIMARY address and redeeming it; an
// account whose sign-in method is a password (lib/login-method.js) has the
// password door too (POST /api/auth/password, below), never instead. The
// built-in superadmin has no row and signs in only with its break-glass
// password (POST /api/login). AUTH_PATHS.md walks the paths.
//
// `_sendSignInCode` is the code request's mint path (POST /api/auth/code/request),
// and only that route calls it. The admin's Email sign-in code
// (routes/participants.js, POST /api/admin/participants/:id/login-code/email) is
// a second emailed mint: it asks the same eligibility, re-send suppression and
// account send cap itself, without the per-origin share (AUTH_PATHS.md), so a
// change to either belongs in both. `_sendSignInCode` never awaits SMTP: its
// route answers a uniform 200 whatever happened, so response time must not
// depend on the outcome (the admin route, by contrast, awaits the send up to
// EMAIL_FANOUT_DEADLINE_MS and reports delivery). Returns the outcome string
// (counted in the metrics).
function _sendSignInCode(req, user, typedEmail, comp, via, out) {
  if (!isCodeEligible(user)) {
    try { recordUserEvent(user.id, "login_code_refused", "system", { ...reqContext(req), reason: codeBlockedReason(user) || "not_eligible" }); } catch (e) { swallowed("auth:code-refused-audit", e); }
    return "ineligible";
  }
  // A live code mailed under two minutes ago is left alone: a double-submit or a
  // second request must not kill the code the holder is typing.
  // A live DESK code an organiser read out is never superseded by the entry
  // screen's Continue: the walk-up presses Continue and types the code they were
  // shown into the code step, at any point in its life (lib/login-code.js
  // `deskCodeLive`).
  if (deskCodeLive(user) || codeRecentlySent(user)) {
    try { recordUserEvent(user.id, "login_code_refused", "system", { ...reqContext(req), reason: "recently_sent" }); } catch (e) { swallowed("auth:code-recently-sent-audit", e); }
    return "recently_sent";
  }
  const origin = originKeyFor(req.ip);
  const issued = issueCode(user, CODE_VIA_EMAIL, null, { originKey: origin, competitionId: comp ? comp.id : null, mintedTo: typedEmail });
  if (!issued) {
    try {
      recordUserEvent(user.id, "login_code_refused", "system", {
        ...reqContext(req),
        reason: codeOriginExhausted(user.id, origin) ? "origin_cap_reached" : "send_cap_reached",
        sends: user.login_code_sends || 0,
      });
    } catch (e) { swallowed("auth:code-cap-audit", e); }
    return "throttled";
  }
  if (out) out.codeHash = hashCode(issued.code);
  try {
    recordUserEvent(user.id, "login_code_requested", "system", {
      ...reqContext(req), reissued: !!issued.reissued,
      ...(via ? { via } : {}),
      ...(comp ? { competition_id: comp.id, competition_name: comp.name } : {}),
    });
  } catch (e) { swallowed("auth:code-sent-audit", e); }
  const _codeReqCtx = reqContext(req);
  // To the TYPED address — always the account's PRIMARY (a secondary never
  // resolves here): requesting proves nothing, so only that inbox receives it.
  // The mail promises the join only to an account the redeem would enrol
  // (`codeBoundJoinWillEnrol`): an organiser checking their own join link, or
  // staff on an event where staff compete, are told nothing false.
  const _promisesJoin = !!comp && codeBoundJoinWillEnrol(user.id, comp);
  trackDetachedSend(sendLoginCodeEmail(user, issued, { to: typedEmail, eventName: _promisesJoin ? comp.name : null, eventId: comp ? comp.id : null }).catch(err => {
    log.error({ ..._codeReqCtx, err: err && err.message ? err.message : String(err) }, "sendLoginCodeEmail(request) rejected");
  }));
  return "sent";
}

function _accountByAddress(email) {
  // Indexed (lib/account-lookup.js), and the PRIMARY address only: a secondary is
  // an unconfirmed claim, so it never signs in. An address held only as somebody's
  // secondary is RESERVED (emailIsTaken): it gets neither a code nor a proof.
  return findUserByPrimary(db, email);
}

// The anonymous sign-in doors' limits (RATE_LIMIT_LOGIN_*): per (IP, address),
// with a coarse per-IP backstop so keying by address cannot be fanned out across
// any number of addresses from one source.
const _LOGIN_PER_MIN = parseInt(process.env.RATE_LIMIT_LOGIN_PER_MIN, 10) || 60;
const _LOGIN_IP_BACKSTOP_PER_MIN = parseInt(process.env.RATE_LIMIT_LOGIN_IP_BACKSTOP_PER_MIN, 10) || 600;
const _addressKey = (req) => normaliseEmail(typeof req.body?.email === "string" ? req.body.email : "");

// POST /api/auth/code/request — 200 `{ok:true}` for EVERY outcome (unknown
// address, ineligible, throttled, recently sent, sent): a non-429 4xx would feed
// scanner reputation, which blocks a whole venue NAT, and any distinguishable
// answer is an existence oracle. Metrics (`hack_arena_login_code_*`) are the
// only monitoring. An optional `joinToken` binds the code to that event (the
// sign-in form a join link, QR or join code opened); only redeeming enrols, and
// only in a browser that asked for that event, through its link while that link
// is still live (_sessionNamedEvent). Switching the link off or replacing it
// unties the code (lib/self-enroll.js `untieJoinLinkBindings`).
// Its per-IP backstop is the other sign-in doors' rate over its own 15-minute
// window: per (IP, address) alone, one source could make the platform write a
// sign-in record or a refusal for any number of addresses. Trusted networks and
// the allow-list bypass it, as every limiter.
app.post("/api/auth/code/request", rateLimit(15 * 60_000, 5, "login-code-req", { keyExtra: _addressKey, ipBackstopMax: _LOGIN_IP_BACKSTOP_PER_MIN * 15 }), csrfProtection, async (req, res) => {
  const email = normaliseEmail(typeof req.body?.email === "string" ? req.body.email : "");
  const joinToken = typeof req.body?.joinToken === "string" ? req.body.joinToken : "";
  const ok = () => res.json({ ok: true });
  const invitationId = typeof req.body?.invitationId === "string" ? req.body.invitationId : "";
  if (!email || !isValidEmailFormat(email)) { countCodeOutcome("request", "ineligible"); return ok(); }
  const user = _accountByAddress(email);
  const comp = joinToken ? _resolveJoinableComp(joinToken) : null;
  const out = {};
  countCodeOutcome("request", user ? _sendSignInCode(req, user, email, comp, null, out) : _sendEmailProof(req, email, comp, invitationId, out));
  // Written for EVERY outcome, so the session is saved (and the cookie re-sent)
  // the same way whatever happened: what it holds is never on the wire.
  _noteCodeRequest(req, email, comp, out.codeHash);
  return ok();
});

// THIS BROWSER'S CODE REQUESTS, for "Not your event? Continue without it" (POST
// /api/auth/code/drop-event) and for the redeem's question of whose event a code
// carries (_sessionNamedEvent, below): per address (a fingerprint, never the
// address), the event of the code this browser's request minted (`compId`) with
// that code's `codeDropTag`, and every event this browser asked about for the
// address while the note lives (`asked`, a held-back request's included), each
// with the join link it was asked through (`{id, link}`, `link` the link's
// `joinLinkTag`, never its token; sweep #391). A request that minted nothing
// (suppressed, throttled) keeps the earlier mint's event and tag: that code is
// still the one in the inbox. At most five notes, none older than a code lives;
// at most five events asked about in each, an event asked about again keeping
// the link it was last asked through. An entry naming no link (a note written
// before links were kept) names no event: it fails closed.
const _CODE_NOTES_MAX = 5;
const _ASKED_MAX = 5;
const _askedOf = (n) => (n && Array.isArray(n.asked)
  ? n.asked.filter(a => a && typeof a === "object" && a.id != null && typeof a.link === "string" && a.link)
  : []);
function _noteCodeRequest(req, email, comp, mintedHash) {
  const s = req.session;
  if (!s) return;
  const t = now().getTime();
  const fp = capabilityFingerprint(email, "cr_");
  const live = (Array.isArray(s.codeRequests) ? s.codeRequests : []).filter(n => n && typeof n === "object" && t - Number(n.at) < LOGIN_CODE_TTL_MS);
  const prev = live.find(n => n.fp === fp);
  const byEvent = new Map();
  for (const a of [..._askedOf(prev), ...(comp ? [{ id: comp.id, link: joinLinkTag(comp.self_enroll_token) }] : [])]) {
    byEvent.delete(String(a.id));
    byEvent.set(String(a.id), { id: a.id, link: a.link });
  }
  const asked = [...byEvent.values()].slice(-_ASKED_MAX);
  const note = mintedHash
    ? { fp, compId: comp ? comp.id : null, tag: codeDropTag(mintedHash), at: t, asked }
    : { fp, compId: prev ? prev.compId : (comp ? comp.id : null), tag: prev ? prev.tag : null, at: t, asked };
  s.codeRequests = [...live.filter(n => n.fp !== fp), note].slice(-_CODE_NOTES_MAX);
}

// WHOSE EVENT A CODE CARRIES (sweep #198). Anyone who holds an event's public join
// link can ask for a code for ANY address with that event named, so the code (or
// address proof) in a person's inbox may carry an event a stranger chose. Its
// event therefore counts only for a browser that asked for a code for this
// address naming that same event itself: this session's own note (above, its
// `asked`). Any other browser redeems it as a code with no event: it signs in (or
// proves the address) and enrols nobody, nor approves anybody through the join
// link. The note's events come only from this browser's own requests, and "Not
// your event?" clears them, so nobody else can put one there. A browser whose own
// request named the event but was held back (another browser's code came first)
// still counts: it asked for that event too.
// …and only when it asked THROUGH THE EVENT'S JOIN LINK AS IT IS NOW (sweep #391,
// operator ruling, 24 Nov 2026): a link switched off, or replaced by Regenerate,
// since this browser asked through it names no event here, so a code redeemed (or
// a proof redeemed) after the organiser closed the link signs in (or proves the
// address) without joining, as a sign-up through the closed link does. Switching
// the link off or replacing it also unties the codes and proofs themselves
// (lib/self-enroll.js `untieJoinLinkBindings`); this check covers what a database
// write cannot reach, this browser's own memory of the link: a code another
// browser re-bound through the new link does not join here.
function _sessionNamedEvent(req, email, compId) {
  if (!compId) return false;
  const link = liveJoinLinkTag(_joinableById(compId));
  if (!link) return false;
  const notes = Array.isArray(req.session?.codeRequests) ? req.session.codeRequests : [];
  const fp = capabilityFingerprint(email, "cr_");
  const t = now().getTime();
  return notes.some(n => n && n.fp === fp && t - Number(n.at) < LOGIN_CODE_TTL_MS
    && _askedOf(n).some(a => String(a.id) === String(compId) && a.link === link));
}

// The join links this browser asked through for the address, while its note
// lives: carried into the sign-up grant, against which the register checks its
// event's link (`_joinableUnderGrant`) and a body join token (`_closedLinkAskedHere`).
function _askedLinks(req, email) {
  const notes = Array.isArray(req.session?.codeRequests) ? req.session.codeRequests : [];
  const fp = capabilityFingerprint(email, "cr_");
  const t = now().getTime();
  const note = notes.find(n => n && n.fp === fp && t - Number(n.at) < LOGIN_CODE_TTL_MS);
  return [...new Set(_askedOf(note).map(a => a.link))];
}

// POST /api/auth/code/drop-event — "Not your event? Continue without it" on the
// sign-in card or the sign-up form (operator rulings, 18 and 20 Nov 2026). The
// browser forgets the event itself; this unties a code ALREADY EMAILED with it,
// so redeeming that code signs in (or proves the address) without joining. Only
// for the code or proof THIS session's request minted (`codeRequests`, its tag
// matched against the stored hash), or this session's own sign-up grant: an
// address alone unties nothing, so nobody can strip someone else's event. The
// code keeps working, its window, budget and re-send suppression stay, nothing
// is mailed, and an earlier join (the join marker, an event already joined) is
// untouched. 200 `{ok:true}` for every outcome, like every sign-in route.
app.post("/api/auth/code/drop-event", rateLimit(15 * 60_000, 5, "login-code-drop", { keyExtra: _addressKey }), csrfProtection, (req, res) => {
  const email = normaliseEmail(typeof req.body?.email === "string" ? req.body.email : "");
  const ok = (outcome) => { countCodeOutcome("drop", outcome); return res.json({ ok: true }); };
  if (!email || !isValidEmailFormat(email)) return ok("invalid");
  const domain = email.split("@")[1] || null;
  const t = now().getTime();
  // EVERY well-formed drop reads and writes alike, whatever this browser holds:
  // the session is saved (so the cookie is sent again) and the address's code or
  // proof is read and its tag computed. Otherwise the cookie or the work would
  // say whether this browser's request minted anything, which for a free-mail
  // address says whether an account holds it.
  req.session.codeDrops = (Number(req.session.codeDrops) || 0) + 1;
  const fp = capabilityFingerprint(email, "cr_");
  const notes = Array.isArray(req.session.codeRequests) ? req.session.codeRequests : [];
  const anyNote = notes.find(n => n && n.fp === fp && t - Number(n.at) < LOGIN_CODE_TTL_MS) || null;
  const note = anyNote && anyNote.compId && anyNote.tag ? anyNote : null;
  const user = _accountByAddress(email);
  const row = user ? db.prepare("SELECT id, login_code_hash, login_code_via, login_code_comp_id, login_code_at FROM users WHERE id=?").get(user.id) : null;
  const rowTag = codeDropTag(row ? row.login_code_hash : "");
  let dropped = false;
  // This session's sign-up grant (a proof already redeemed here, the form open).
  const grant = liveProofGrant(req.session, email);
  if (grant && grant.joinCompId) {
    const was = grant.joinCompId;
    grant.joinCompId = null;
    dropped = true;
    try {
      recordOrphanedAuditEvent("auth", capabilityFingerprint(email, "ep_"), "email_proof_event_dropped", "system",
        { ...reqContext(req), stage: "grant", domain, competition_id: was });
    } catch (e) { swallowed("auth:proof-event-dropped-audit", e); }
  }
  if (user) {
    // Only the code THIS browser's request minted: its tag must be the stored
    // hash's (a code re-minted since, by any browser, is not this one's).
    if (note && row && codeIsLive(row) && row.login_code_via === CODE_VIA_EMAIL && row.login_code_comp_id === note.compId && rowTag === note.tag) {
      const r = db.prepare("UPDATE users SET login_code_comp_id=NULL WHERE id=? AND login_code_hash=? AND login_code_via=? AND login_code_comp_id=?")
        .run(row.id, row.login_code_hash, CODE_VIA_EMAIL, note.compId);
      if (r.changes === 1) {
        dropped = true;
        const c = db.prepare("SELECT name FROM competitions WHERE id=?").get(note.compId);
        try {
          recordUserEvent(row.id, "login_code_event_dropped", "system",
            { ...reqContext(req), competition_id: note.compId, competition_name: c ? c.name : null });
        } catch (e) { swallowed("auth:code-event-dropped-audit", e); }
      }
    }
  } else if (dropProofEvent(email, { compId: note ? note.compId : null, tag: note ? note.tag : null, tagOf: codeDropTag })) {
    dropped = true;
    try {
      recordOrphanedAuditEvent("auth", capabilityFingerprint(email, "ep_"), "email_proof_event_dropped", "system",
        { ...reqContext(req), stage: "proof", domain, competition_id: note.compId });
    } catch (e) { swallowed("auth:proof-event-dropped-audit", e); }
  }
  // Single use: the session forgets the tag either way, and every event this
  // browser asked about for the address: "Not your event?" means none, so a code
  // carrying one (another browser's, which this one could not untie) enrols
  // nobody here either (_sessionNamedEvent).
  if (anyNote) { anyNote.tag = null; anyNote.compId = null; anyNote.asked = []; req.session.codeRequests = notes; }
  return ok(dropped ? "dropped" : (note ? "stale" : "no_note"));
});

// THE NEW-ADDRESS HALF OF THE ONE ENTRY SCREEN. An address no account holds gets
// an ADDRESS PROOF (lib/email-proof.js), never a user row: redeeming it lets the
// browser that redeemed it submit the sign-up form for that address. The caller
// answers the same `{ok:true}` whatever this returns, and nothing here awaits
// SMTP, so neither the body nor the timing says whether an address is
// registered. Refusals are audited as orphaned `email_proof_refused` events
// naming the address's DOMAIN and a fingerprint, never the address itself.
//   • a reserved address (someone's pending primary change): nothing sent;
//   • a free-mail address (isFreeEmail) with no live invitation for it: nothing
//     sent — a NEW account needs a work address (the corporate-email rule);
//   • the re-send suppression and the two budgets, exactly as for sign-in codes.
const _PROOF_IP_PER_15MIN = parseInt(process.env.RATE_LIMIT_PROOF_IP_PER_15MIN, 10) || 150;
function _sendEmailProof(req, email, comp, invitationId, out) {
  const refuse = (reason) => {
    // THE RECORD OF A REFUSAL IS CAPPED PER SOURCE, at the proof budget's own
    // rate: an anonymous caller chooses the address, so a refusal for every
    // personal or reserved address one IP sends would otherwise be an unbounded
    // stream of audit rows kept for two years, and of log lines. Past the
    // budget the refusal is counted by reason, not written
    // (`hack_arena_email_proof_refusals_unrecorded_total`); the answer is the
    // same `{ok:true}` either way. Trusted networks and the allow-list bypass it.
    if (ipBudgetExceeded(15 * 60_000, _PROOF_IP_PER_15MIN, "email-proof-refused-ip", req)) {
      countCodeOutcome("unrecorded", reason);
    } else {
      try {
        recordOrphanedAuditEvent("auth", capabilityFingerprint(email, "ep_"), "email_proof_refused", "system",
          { ...reqContext(req), reason, domain: email.split("@")[1] || null });
      } catch (e) { swallowed("auth:proof-refused-audit", e); }
    }
    return reason === "free_email" || reason === "reserved_address" ? "ineligible" : (reason === "recently_sent" ? "recently_sent" : "throttled");
  };
  if (emailIsTaken(email)) return refuse("reserved_address");
  const inv = invitationId
    ? db.prepare("SELECT id, email FROM invitations WHERE id=? AND used_at IS NULL").get(invitationId) : null;
  const invitation = inv && normaliseEmail(inv.email) === email ? inv : null;
  if (!invitation && isFreeEmail(email)) return refuse("free_email");
  // THE PER-IP PROOF BUDGET (operator ruling, 11 Nov 2026). The request limiter
  // is keyed per (IP, address) so a venue NAT does not share one bucket — which
  // alone let one source make the platform mail any number of DISTINCT new
  // addresses, through the SMTP pool that carries every sign-in code. A sign-in
  // code to an existing account is already capped per account; a proof is not,
  // so proofs from one IP are capped per 15 minutes (RATE_LIMIT_PROOF_IP_PER_15MIN,
  // default 150 — the rate a new account could register at before email first).
  // Refused SILENTLY (audited `ip_budget`): a 429 for new addresses alone would
  // say which addresses have no account. Trusted networks and the allow-list
  // bypass it, as they bypass every limiter: a booth rush belongs there.
  if (ipBudgetExceeded(15 * 60_000, _PROOF_IP_PER_15MIN, "email-proof-ip", req)) return refuse("ip_budget");
  const issued = issueProof(email, { originKey: originKeyFor(req.ip), joinCompId: comp ? comp.id : null, invitationId: invitation ? invitation.id : null });
  if (!issued.ok) return refuse(issued.reason);
  if (out) out.codeHash = hashCode(issued.code);
  try {
    recordOrphanedAuditEvent("auth", capabilityFingerprint(email, "ep_"), "email_proof_requested", "system", {
      ...reqContext(req), reissued: !!issued.reissued, domain: email.split("@")[1] || null,
      ...(comp ? { competition_id: comp.id, competition_name: comp.name } : {}),
      ...(invitation ? { invitation_fp: capabilityFingerprint(invitation.id, "if_") } : {}),
    });
  } catch (e) { swallowed("auth:proof-issued-audit", e); }
  const _ctx = reqContext(req);
  trackDetachedSend(sendEmailProofEmail(email, issued, { eventName: comp ? comp.name : null }).catch(err => {
    // The error's CODE only: an SMTP rejection's message can quote the address.
    log.error({ ..._ctx, err_code: (err && err.code) || "send_failed" }, "sendEmailProofEmail rejected");
  }));
  return "sent";
}

// A redeemed ADDRESS PROOF. Nothing is created: the session (regenerated, so a
// planted session id cannot inherit the grant) carries a single-use grant for
// THIS address for EMAIL_PROOF_GRANT_MS, and only POST /api/register spends it.
// A wrong or dead code answers exactly as a wrong sign-in code does.
async function _redeemEmailProof(req, res, email, fail, rawCode) {
  const r = redeemProof(email, rawCode);
  // The guess that burned the code is recorded (domain and fingerprint, never
  // the address): the newcomer's code stops working, and an operator asked why
  // must be able to see that it happened, when and from where.
  if (r.burned) {
    try {
      recordOrphanedAuditEvent("auth", capabilityFingerprint(email, "ep_"), "email_proof_burned", "system",
        { ...reqContext(req), domain: email.split("@")[1] || null });
    } catch (e) { swallowed("auth:proof-burned-audit", e); }
  }
  if (!r.matched) return fail("invalid");
  // An account may have taken the address since the proof was mailed (an import,
  // an admin invite): the proof is spent and nothing is granted.
  if (_accountByAddress(email) || emailIsTaken(email)) return fail("invalid");
  // The proof's event counts only for the browser that asked for it, through the
  // event's link as it is now (sweeps #198 and #391, _sessionNamedEvent); read,
  // with the links this browser asked through, before the regenerate below wipes
  // the notes. The grant keeps those links (`joinLinks`, tags, never tokens): the
  // register checks the event's link against them again, as the link can be
  // replaced while the form is open.
  const joinCompId = r.row.join_comp_id && _sessionNamedEvent(req, email, r.row.join_comp_id) ? r.row.join_comp_id : null;
  const joinLinks = _askedLinks(req, email);
  const regenErr = await new Promise(resolve => req.session.regenerate(resolve));
  if (regenErr) return res.status(500).json({ error: "Session error" });
  req.session.emailProof = {
    email,
    until: now().getTime() + EMAIL_PROOF_GRANT_MS,
    joinCompId,
    joinLinks,
    invitationId: r.row.invitation_id || null,
  };
  try {
    recordOrphanedAuditEvent("auth", capabilityFingerprint(email, "ep_"), "email_proof_redeemed", "system",
      { ...reqContext(req), domain: email.split("@")[1] || null });
  } catch (e) { swallowed("auth:proof-redeemed-audit", e); }
  countCodeOutcome("redeem", "proof");
  return res.json({ ok: true, needsProfile: true, email, ...(r.row.invitation_id ? { invited: true } : {}) });
}

// POST /api/auth/code/redeem — `{email, code}`. Answers 200 for every outcome
// and the client branches on `ok` (429 and 403 csrf_invalid excepted). On
// success it does everything the password login used to do: lockout cleared,
// login times stamped, the session regenerated with the account's tier flags,
// other sessions ended with the kicker's context, the open impersonation window
// closed, auto-resume applied — and answers the same login-shaped payload.
//
// An EMAILED code proves the inbox, so redeeming it verifies the account and,
// unless `require_account_approval` is on, approves a pending, not-denied one.
// It also enrols in the event the code was bound to (when this browser asked for
// that event: _sessionNamedEvent), the join marker a join-link registration left,
// and claims live invitations addressed to the redeemed address. A desk code proves nothing about the mailbox: it verifies nothing,
// approves nothing, enrols in nothing beyond the join marker, and an unapproved
// account is refused.
//
// What bounds guessing is this door's limits: 10 a minute per (IP, address), and
// the other sign-in doors' per-IP backstop (RATE_LIMIT_LOGIN_IP_BACKSTOP_PER_MIN a
// minute), so one source cannot spread guesses over any number of addresses. The
// account lock (lib/lockout.js) is an alarm, not a bound: it refuses no guess.
app.post("/api/auth/code/redeem", rateLimit(60_000, 10, "login-code-redeem", { keyExtra: _addressKey, ipBackstopMax: _LOGIN_IP_BACKSTOP_PER_MIN }), csrfProtection, async (req, res) => {
  const email = normaliseEmail(typeof req.body?.email === "string" ? req.body.email : "");
  const fail = (outcome, extra) => { countCodeOutcome("redeem", outcome); return res.json({ ok: false, ...(extra || {}) }); };
  if (!email) return fail("invalid");
  // Text only (sweep #193): a code of any other type is a typo, uncharged and
  // answered {ok:false}, never handed to a normaliser that would throw.
  const rawCode = typeof req.body?.code === "string" ? req.body.code : "";
  const attempt = resolveCodeAttempt(email, rawCode);
  const user = attempt.user;
  // No account holds the address: the code, if any, was an ADDRESS PROOF.
  if (!user) return _redeemEmailProof(req, res, email, fail, rawCode);
  const wasLocked = isLockedNow(user);

  if (!attempt.matched) {
    // A well-formed wrong code is a guess and charges the account's one failure
    // budget (lib/lockout.js); a malformed one is a typo and charges nothing.
    // While locked a guess is not counted again (the lock already holds).
    if (attempt.wellFormed && !wasLocked) {
      const n = now();
      const count = recordFailedLogin(user.id, n);
      try { recordUserEvent(user.id, "login_failed", "system", { ...reqContext(req), reason: "invalid_code", method: "login_code", attempt: count }); } catch (e) { swallowed("auth:login-failed-audit", e); }
      if (shouldLock(count)) {
        const lockedUntil = armLockout(user.id, n);
        try { recordUserEvent(user.id, "auto_locked", "system", { ...reqContext(req), method: "login_code", until: lockedUntil, failed_count: count }); } catch (e) { swallowed("auth:auto-locked-audit", e); }
        trackDetachedSend(sendLockoutEmail(user, lockedUntil, req).catch((e) => swallowed("auth:lockout-mail", e, { level: "warn" })));
      }
    }
    return fail("invalid");
  }

  // A correct code. Blocked and denied never sign in and never approve (their
  // code stays stored: the block, not the code, is what refuses them).
  if (!isCodeEligible(user)) return fail("ineligible");
  // THE CLAIM, before anything else this redeem writes: the code is spent only
  // while it is still the one matched above (lib/login-code.js `consumeCode`), so
  // of two redeems of one code exactly one goes on. Nothing is awaited between
  // the match and this claim, so a second redeem always arrives after it, finds
  // no code and is answered, and charged, as a wrong code; the refusal below is
  // for an await someone adds later. From here every outcome has spent it.
  if (consumeCode(user.id, user.login_code_hash) !== 1) return fail("invalid");
  // A DESK code is for participants only (the reveal refuses any other role): an
  // account promoted while its desk code was live does not sign in with it — an
  // admin's code read out at a desk is a sign-in as that admin.
  if (user.login_code_via === "desk" && (user.role || "participant") !== "participant") {
    return fail("ineligible");
  }
  // …and for an account that has never signed in (operator ruling, 14 Nov 2026;
  // the reveal asks the same `hasSignedIn`): one that signed in by another door
  // while its desk code was live does not sign in with that code.
  if (user.login_code_via === "desk" && hasSignedIn(user)) {
    return fail("ineligible");
  }
  const provenEmail = codeProvesEmail(user);
  // The code's event counts only for the browser that asked for it, through the
  // event's join link as it is now (sweeps #198 and #391, _sessionNamedEvent):
  // elsewhere, or once that link is switched off or replaced, it neither enrols
  // nor approves through the link.
  const boundCompId = user.login_code_comp_id && _sessionNamedEvent(req, email, user.login_code_comp_id) ? user.login_code_comp_id : null;
  const requireApproval = getRequireAccountApproval();

  // A correct code is honoured while locked and clears the lock: the lock is an
  // alarm (the holder was mailed when it locked), never a bar on the holder, who
  // cannot be locked out of the only door they have by ten guesses from anyone.
  // The rate limits bound the guessing.
  if (wasLocked) {
    clearLockout(user.id);
    try { recordUserEvent(user.id, "auto_unlocked", "system", { ...reqContext(req), reason: "correct_login_code" }); } catch (e) { swallowed("auth:auto-unlocked-audit", e); }
  }

  // A desk code cannot approve, and an approval-gated account waits for an admin
  // unless it arrives through a live event's join link, QR or event code (the
  // code's own event or the account's pending join): those never wait.
  const joinApproves = provenEmail && !user.approved
    && !!_joinableById(boundCompId || user.pending_self_enroll_comp_id || null);
  if (!user.approved && (!provenEmail || (requireApproval && !joinApproves))) {
    if (provenEmail) _verifyByCode(req, user);
    return fail("not_approved", { error: "pending_approval" });
  }

  if (provenEmail) _verifyByCode(req, user);
  else if (!user.verified) {
    // A desk code re-stamps the 48-hour grace (operator decision): the walk-up is
    // in, and still owes the platform a proven inbox.
    db.prepare("UPDATE users SET self_enroll_grace_until=? WHERE id=?")
      .run(new Date(now().getTime() + SELF_ENROLL_GRACE_MS).toISOString(), user.id);
    _invalidateMeCache(user.id);
  }
  if (!user.approved) {
    // Reached only for an emailed code, with approval off or through a join.
    const _byJoin = requireApproval && joinApproves;
    const ap = db.prepare("UPDATE users SET approved=1, approved_at=?, approved_by=? WHERE id=? AND approved=0 AND denied_at IS NULL AND COALESCE(blocked,0)=0")
      .run(now().toISOString(), _byJoin ? "self_enroll" : "login_code", user.id);
    if (ap.changes === 1) {
      try { recordUserEvent(user.id, "approved", "system", { ...reqContext(req), via: _byJoin ? "self_enroll_auto_approval" : "login_code_auto_approval" }); } catch (e) { swallowed("auth:auto-approval-audit", e); }
      invalidateAdminParticipantsCache();
      _invalidateMeCache(user.id);
    }
  }

  const loginNow = now().toISOString();
  clearLockout(user.id);
  stampLoginTimes(user.id, loginNow);
  _consumeJoinForCode(user.id, req);
  if (provenEmail) {
    _consumeCodeBoundEnroll(user.id, boundCompId, req);
    // The address the code proved: the account's PRIMARY (the only address a
    // code is mailed to and redeemed with), never a body-supplied one.
    claimInvitationsForAccount(user, user.email, req);
  }

  countCodeOutcome("redeem", "ok");
  return _signInAs(req, res, user, "login_code", null, { provenEmail });
});

// THE SIGN-IN BOOKKEEPING, shared by the code redeem and the sign-up that a
// redeemed address proof completes (POST /api/register): the open impersonation
// window closed, regenerate(), every other session of the account ended with the
// kicker's context, `login_success`, the tier flags, auto-resume, and the
// login-shaped answer the SPA routes on (`finishSignIn`). The caller has already
// stamped login times and done its own enrolment. `opts.stillValid`, when given,
// is asked after regenerate() and before anything is granted: the password door
// passes "the stored hash is still the one I verified" (a credential rewritten
// meanwhile must not mint a session on the old one).
async function _signInAs(req, res, user, method, extra, opts) {
  // Close an open impersonation window before regenerate() destroys the row that
  // carries the marker (the same rule server.js applies on the password door).
  const _imp = req.session && req.session.impersonator;
  if (_imp && req.session.userId) {
    try {
      recordUserEvent(req.session.userId, "impersonation_ended", impersonationActor(req.session),
        { ...impersonationEndedDetails(_imp, "login"), ...reqContext(req) });
    } catch (e) { swallowed("auth:login-impersonation-ended-audit", e); }
  }
  const regenErr = await new Promise(resolve => req.session.regenerate(resolve));
  if (regenErr) return res.status(500).json({ error: "Session error" });
  if (opts && typeof opts.stillValid === "function" && !opts.stillValid()) {
    try { recordUserEvent(user.id, "login_failed", "system", { ...reqContext(req), reason: "credential_changed", method }); } catch (e) { swallowed("auth:credential-changed-audit", e); }
    return res.json({ ok: false });
  }
  const { liveCount, purgedCount } = invalidateOtherSessions("userId", user.id, req.sessionID, kickerContext(req, user));
  const details = { ...reqContext(req), method };
  if (liveCount > 0) details.terminated_sessions = liveCount;
  if (purgedCount > liveCount) details.stale_sessions_purged = purgedCount - liveCount;
  try { recordUserEvent(user.id, "login_success", "system", details); } catch (e) { swallowed("auth:login-success-audit", e); }
  if (method === "login_code") { try { recordUserEvent(user.id, "login_code_redeemed", "system", reqContext(req)); } catch (e) { swallowed("auth:code-redeemed-audit", e); } }
  const fresh = db.prepare("SELECT * FROM users WHERE id=?").get(user.id) || user;
  const userRole = fresh.role || "participant";
  req.session.userId = fresh.id;
  // How and when THIS session signed in: a password change without the current
  // password is allowed only shortly after an emailed-code sign-in
  // (PUT /api/me/sign-in-method), the recovery for a forgotten password.
  req.session.signInMethod = method;
  req.session.signedInAt = Date.now();
  // Only an EMAILED code proves the inbox; a desk code was read out by an
  // organiser, so it does not open the forgotten-password window.
  req.session.signInViaEmail = method === "login_code" && !!(opts && opts.provenEmail);
  const autoResumeCompetitionId = applyAutoResumeToSession(req, fresh.id);
  req.session.userEmail = fresh.email || null;
  req.session.userFirstName = fresh.first_name || null;
  req.session.userLastName = fresh.last_name || null;
  req.session.userRole = userRole;
  // RBAC — every role whose class is not `none` signs into the admin panel (the
  // three built-in admin tiers and every custom admin role).
  const _rbac = require("../lib/rbac");
  const _cls = _rbac.roleClass(userRole, { live: true });
  const isAdminUser = _cls !== "none";
  if (isAdminUser) {
    req.session.isAdmin = true;
    req.session.isSuperAdmin = userRole === "superadmin";
  }
  const userIsStaff = isStaff(fresh.id);
  const grace = verificationGraceState(fresh);
  // A participant lands in the shell with the participant bar; the admin console has none.
  if (!isAdminUser) setAppShellHintCookie(req, res);
  return res.json({
    ok: true,
    ...(extra || {}),
    role: isAdminUser ? "admin" : "participant",
    userRole,
    isSuperAdmin: userRole === "superadmin",
    isEventAdmin: _cls === "granted",
    ...(isAdminUser ? { permissions: [..._rbac.rolePermissions(userRole)].sort() } : {}),
    // The role itself (GET /api/me and GET /api/admin/me carry the same block),
    // so the account menu names a custom role from the first paint.
    role_info: (() => {
      const _d = _rbac.roleDefinition(userRole, { live: true });
      return _d ? { id: _d.id, label: _d.label, scope_mode: _d.scope_mode, builtin: !!_d.builtin } : { id: userRole, label: null, scope_mode: "none", builtin: false };
    })(),
    id: fresh.id,
    isStaff: userIsStaff,
    nickname: fresh.nickname,
    // The names the account menu and the greeting read (the nickname is
    // generated at sign-up, so it is a fallback only, never what greets them).
    first_name: fresh.first_name || null,
    last_name: fresh.last_name || null,
    // The name a certificate issued now would print (GET /api/me carries it too).
    certificate_printed_name: certificatePrintedName(fresh, fresh.nickname).displayName || "",
    avatar: fresh.avatar,
    email: fresh.email,
    competitions: listParticipantCompetitions(fresh.id, { staff: userIsStaff, withTags: true }),
    autoResumeCompetitionId,
    // No admin tier is ever gated: the overlay would cover the Admin View button.
    missing_fields: isAdminUser ? [] : _profileMissingFields(
      db.prepare(`SELECT ${PROFILE_GATE_COLUMNS} FROM users u ${PROFILE_GATE_JOIN} WHERE u.id=?`).get(fresh.id)
    ),
    verified: !!fresh.verified,
    verification_grace_until: (!fresh.verified && grace.active) ? grace.graceUntil : null,
    // How this account signs in, and whether it owes a password (lib/login-method.js).
    ...loginMethodWire(fresh),
  });
}

// ── THE PASSWORD HALF OF THE ENTRY SCREEN ────────────────────────────────────
// Each account signs in with a password or with an emailed code
// (lib/login-method.js; operator ruling, 11 Nov 2026). The entry screen asks
// which before it decides what to show: a password account gets the password
// box plus "Email me a code instead" (a code always works, so a forgotten
// password is never a dead end); every other address goes straight to the code
// step. This answer DOES tell whether an address is a password account — by
// default every unscoped admin — which the operator accepted.

// POST /api/auth/sign-in-method — which step the entry screen shows next. 200 for
// every input; only the limiter's 429 and CSRF differ.
//   • not an address (no "@"): `{method:"password", code_offered:false}` — the
//     built-in superadmin's username is the only thing that signs in without an
//     address, so EVERY non-address gets this same answer and the name is never
//     confirmed here;
//   • an address whose account (by PRIMARY address, never a secondary) signs in
//     with a password and may sign in: `{method:"password", code_offered:true,
//     password_set}` — `password_set:false` is an account that has not set its
//     password yet (it signs in with a code, then sets one);
//   • anything else (no account, a code account, blocked or denied, malformed):
//     `{method:"code"}`.
app.post("/api/auth/sign-in-method", rateLimit(60_000, _LOGIN_PER_MIN, "sign-in-method", { keyExtra: _addressKey, ipBackstopMax: _LOGIN_IP_BACKSTOP_PER_MIN }), csrfProtection, (req, res) => {
  const raw = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (raw && !raw.includes("@")) return res.json({ ok: true, method: "password", code_offered: false });
  const email = normaliseEmail(raw);
  const user = (email && isValidEmailFormat(email)) ? _accountByAddress(email) : null;
  if (!user || !isCodeEligible(user) || effectiveLoginMethod(user) !== "password") return res.json({ ok: true, method: "code" });
  return res.json({ ok: true, method: "password", code_offered: true, password_set: hasUsablePassword(user) });
});

// POST /api/auth/password — AN ACCOUNT'S PASSWORD SIGN-IN. `{email, password}`.
// 200 for every outcome, like the code doors (a wrong password from a venue NAT
// must not feed scanner reputation); the client branches on `ok`. Refusals are
// `{ok:false}`, except two reasons disclosed only after a CORRECT password:
// `error:"pending_approval"` and `error:"verify_by_code"` (an unverified account
// proves its inbox with an emailed code first).
//   • The account is found by its PRIMARY address only.
//   • A password is accepted only from an account whose method is `password` and
//     that has set one (`hasUsablePassword`): a code account's old password
//     signs nobody in.
//   • Every outcome costs one bcrypt (a dummy hash when there is nothing to
//     check), so timing does not separate "no account" from "wrong password".
//   • A wrong password charges the account's ONE failure budget (lib/lockout.js,
//     shared with codes); a correct one is honoured while locked and clears it.
//   • Everything is re-read after the bcrypt await, and the stored hash must
//     still be the one verified — again after regenerate() (`stillValid`), so a
//     password changed meanwhile never mints a session on the old one.
app.post("/api/auth/password", rateLimit(60_000, _LOGIN_PER_MIN, "login-password", { keyExtra: _addressKey, ipBackstopMax: _LOGIN_IP_BACKSTOP_PER_MIN }), csrfProtection, async (req, res) => {
  const email = normaliseEmail(typeof req.body?.email === "string" ? req.body.email : "");
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const fail = (extra) => res.json({ ok: false, ...(extra || {}) });
  const user = (email && isValidEmailFormat(email)) ? _accountByAddress(email) : null;
  const usable = !!user && effectiveLoginMethod(user) === "password" && hasUsablePassword(user);
  const verifiedHash = usable ? user.password_hash : null;
  let match = false;
  try { match = await bcrypt.compare(password, verifiedHash || dummyPasswordHash()); } catch (_) { match = false; }
  match = match && !!verifiedHash && password.length > 0;
  if (!user) return fail();
  const fresh = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
  if (!fresh) return fail();
  const wasLocked = isLockedNow(fresh);
  if (!match) {
    if (usable && password && !wasLocked) {
      const n = now();
      const count = recordFailedLogin(fresh.id, n);
      try { recordUserEvent(fresh.id, "login_failed", "system", { ...reqContext(req), reason: "invalid_password", method: "password", attempt: count }); } catch (e) { swallowed("auth:password-failed-audit", e); }
      if (shouldLock(count)) {
        const lockedUntil = armLockout(fresh.id, n);
        try { recordUserEvent(fresh.id, "auto_locked", "system", { ...reqContext(req), method: "password", until: lockedUntil, failed_count: count }); } catch (e) { swallowed("auth:password-locked-audit", e); }
        trackDetachedSend(sendLockoutEmail(fresh, lockedUntil, req).catch((e) => swallowed("auth:lockout-mail", e, { level: "warn" })));
      }
    } else if (!usable) {
      try { recordUserEvent(fresh.id, "login_failed", "system", { ...reqContext(req), reason: hasUsablePassword(fresh) ? "password_not_in_use" : "no_password", method: "password" }); } catch (e) { swallowed("auth:password-unused-audit", e); }
    }
    return fail();
  }
  const refuse = (reason, extra) => {
    try { recordUserEvent(fresh.id, "login_failed", "system", { ...reqContext(req), reason, method: "password" }); } catch (e) { swallowed("auth:password-refused-audit", e); }
    return fail(extra);
  };
  if (fresh.password_hash !== verifiedHash || effectiveLoginMethod(fresh) !== "password" || !hasUsablePassword(fresh)) return refuse("credential_changed");
  if (fresh.blocked) return refuse("blocked");
  if (fresh.denied_at) return refuse("denied");
  if (wasLocked) {
    clearLockout(fresh.id);
    try { recordUserEvent(fresh.id, "auto_unlocked", "system", { ...reqContext(req), reason: "correct_password" }); } catch (e) { swallowed("auth:password-unlocked-audit", e); }
  }
  if (!fresh.approved) return refuse("pending_approval", { error: "pending_approval" });
  if (!fresh.verified && !verificationGraceState(fresh).active) return refuse("unverified", { error: "verify_by_code" });
  clearLockout(fresh.id);
  stampLoginTimes(fresh.id, now().toISOString());
  _consumeJoinForCode(fresh.id, req);
  return _signInAs(req, res, fresh, "password", null, {
    stillValid: () => (db.prepare("SELECT password_hash FROM users WHERE id=?").get(fresh.id) || {}).password_hash === verifiedHash,
  });
});

// PUT /api/me/sign-in-method — THE PROFILE'S "HOW YOU SIGN IN".
// `{method:"code"}` or `{method:"password", password?, currentPassword?}`.
//   • Choosing `password` with none set needs `password` (the new one): the
//     password is set at the moment the method is chosen.
//   • `password` with a method of `password` sets or changes it. CHANGING an
//     existing password needs `currentPassword`, or this session signed in with
//     an emailed code in the last 10 minutes (RECENT_CODE_SIGN_IN_MS) — the
//     recovery for a forgotten password. A wrong current password charges the
//     account's failure budget, like a wrong sign-in.
//   • `code` keeps any stored password (switching back to `password` reuses it)
//     but the password door refuses it while the method is `code`.
//   • Setting or changing a password mails a notice to the primary address; a
//     CHANGED one also ends the account's OTHER sessions (`SESSION_END.ended`).
// Refused under impersonation for every tier (`_IMPERSONATION_BLOCKED`): a
// credential is the account owner's alone. The built-in superadmin has no row.
const RECENT_CODE_SIGN_IN_MS = 10 * 60_000;
app.put("/api/me/sign-in-method", requireParticipant, rateLimit(15 * 60_000, 20, "sign-in-method-set", { keyExtra: (req) => req.session.userId || "" }), csrfProtection, async (req, res) => {
  const b = req.body || {};
  const _nonStr = _firstNonStringField(b, ["method", "password", "currentPassword"]);
  if (_nonStr) return res.status(400).json({ error: `${_nonStr} must be text`, code: "body_field_invalid" });
  if (req.session.impersonator) return res.status(403).json({ error: "A sign-in method is the account owner's to change.", code: "impersonation_blocked" });
  const method = typeof b.method === "string" ? b.method : "";
  if (!LOGIN_METHODS.includes(method)) return res.status(400).json({ error: "Choose how you sign in: a password or an emailed code.", code: "login_method_invalid" });
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.session.userId);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  const newPassword = typeof b.password === "string" && b.password !== "" ? b.password : null;
  if (method === "code" && newPassword) return res.status(400).json({ error: "A password is set only when you sign in with one.", code: "password_not_used" });
  const hadPassword = hasUsablePassword(user);
  let newHash = null;
  if (method === "password") {
    if (!hadPassword && !newPassword) return res.status(400).json({ error: "Set a password to sign in with one.", code: "password_required" });
    if (newPassword) {
      const lenErr = passwordLengthError(newPassword);
      if (lenErr) return res.status(400).json({ error: lenErr, code: "password_invalid" });
      if (hadPassword) {
        const recentCode = req.session.signInViaEmail === true && (Date.now() - (Number(req.session.signedInAt) || 0)) < RECENT_CODE_SIGN_IN_MS;
        if (!recentCode) {
          const cur = typeof b.currentPassword === "string" ? b.currentPassword : "";
          if (!cur) return res.status(400).json({ error: "Enter your current password. Forgotten it? Sign out, sign in with an emailed code, then set a new one within ten minutes.", code: "current_password_required" });
          let curOk = false;
          try { curOk = await bcrypt.compare(cur, user.password_hash); } catch (_) { curOk = false; }
          if (!curOk) {
            const n = now();
            const count = recordFailedLogin(user.id, n);
            try { recordUserEvent(user.id, "login_failed", "system", { ...reqContext(req), reason: "invalid_current_password", method: "password", attempt: count }); } catch (e) { swallowed("auth:current-password-audit", e); }
            if (shouldLock(count)) {
              const lockedUntil = armLockout(user.id, n);
              try { recordUserEvent(user.id, "auto_locked", "system", { ...reqContext(req), method: "password", until: lockedUntil, failed_count: count }); } catch (e) { swallowed("auth:current-password-locked-audit", e); }
              trackDetachedSend(sendLockoutEmail(user, lockedUntil, req).catch((e) => swallowed("auth:lockout-mail", e, { level: "warn" })));
            }
            return res.status(400).json({ error: "That is not your current password.", code: "current_password_wrong" });
          }
        }
      }
      newHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    }
  }
  // Commit against the row as it is NOW (the bcrypt awaits above): the session
  // must still be live and its account still qualify (a sign-in elsewhere, a
  // block or a logout during the hash ends it — nothing is written), and a
  // credential rewritten meanwhile is a conflict, never overwritten blind.
  const _sessionDenied = participantSessionDenied(req);
  if (_sessionDenied) return sendParticipantSessionDenial(req, res, _sessionDenied);
  let row = null;
  const txn = db.transaction(() => {
    const cur = db.prepare("SELECT password_hash, login_method FROM users WHERE id=?").get(user.id);
    if (!cur || cur.password_hash !== user.password_hash) { const e = new Error("conflict"); e.conflict = true; throw e; }
    const ctx = reqContext(req);
    if (newHash) {
      db.prepare("UPDATE users SET password_hash=?, password_set_at=?, login_method=? WHERE id=? AND password_hash=?")
        .run(newHash, now().toISOString(), method, user.id, user.password_hash);
      recordUserEvent(user.id, hadPassword ? "password_changed" : "password_set", user.email || "system", ctx);
    } else {
      db.prepare("UPDATE users SET login_method=? WHERE id=?").run(method, user.id);
    }
    if (cur.login_method !== method) {
      recordUserEvent(user.id, "login_method_changed", user.email || "system", { ...ctx, from: cur.login_method || null, to: method });
    }
    row = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
  });
  try { runTxnWithMirrorBuffer(() => txn.immediate()); }
  catch (e) {
    if (e.conflict) return res.status(409).json({ error: "Your password was changed somewhere else meanwhile. Reload and try again.", code: "credential_changed" });
    throw e;
  }
  if (newHash && hadPassword) {
    // A changed password is the remedy for a compromised one: every OTHER device
    // signs in again. This session stays.
    try {
      const { purgedCount } = invalidateOtherSessions("userId", user.id, req.sessionID, SESSION_END.ended);
      if (purgedCount > 0) recordUserEvent(user.id, "sessions_invalidated", user.email || "system", { ...reqContext(req), reason: "password_changed", purged: purgedCount });
    } catch (e) { swallowed("auth:password-change-session-purge", e); }
  }
  if (newHash) trackDetachedSend(sendPasswordChangedEmail(row, { first: !hadPassword }).catch((e) => swallowed("auth:password-changed-mail", e, { level: "warn" })));
  _invalidateMeCache(user.id);
  return res.json({ ok: true, ...loginMethodWire(row) });
});

// Mark an account verified by an emailed code (proof of the inbox). Leaves
// `verify_code` alone — an emailed link already in the inbox stays a harmless
// idempotency receipt.
function _verifyByCode(req, user) {
  const became = db.prepare(
    "UPDATE users SET verified=1, first_verified_at=COALESCE(first_verified_at, ?), self_enroll_grace_until=NULL WHERE id=? AND verified=0"
  ).run(now().toISOString(), user.id).changes === 1;
  _invalidateMeCache(user.id);
  if (became) {
    invalidateAdminParticipantsCache();
    try { db.prepare("SELECT competition_id FROM competition_users WHERE user_id=?").all(user.id).forEach(r => invalidateLeaderboardCache(r.competition_id)); } catch (e) { swallowed("auth:code-verify-board-bust", e); }
    try { recordUserEvent(user.id, "self_verified", "system", { ...reqContext(req), via: "login_code" }); } catch (e) { swallowed("auth:code-self-verified-audit", e); }
  }
}

// v7.2.0 — re-send the verification email for the LOGGED-IN, still-unverified
// participant (the in-app "unverified" indicator's "Resend verification email"
// action). Only reachable during the active grace window — requireParticipant
// admits a grace user but rejects one whose grace has lapsed, and a fully
// verified caller is short-circuited with 400. Re-mints the verify_code (fresh
// 48h link window); does NOT extend the login grace, which stays anchored to
// registration. Tightly rate-limited (5 / 15 min / IP) so it can't be used to
// spray verification mail. The expired-grace recovery path is an emailed
// sign-in code (redeeming one verifies) or an admin verify, not this.
app.post("/api/resend-verification", requireParticipant, rateLimit(15 * 60_000, 5, "resend-verify"), csrfProtection, async (req, res) => {
  const user = db.prepare("SELECT id, email, secondary_email, first_name, nickname, verified FROM users WHERE id=?").get(req.session.userId);
  if (!user) return res.status(404).json({ error: "Account not found" });
  if (user.verified) return res.status(400).json({ error: "Your email is already verified." });
  const verifyCode = uuid();
  db.prepare("UPDATE users SET verify_code=?, verify_code_at=? WHERE id=?").run(verifyCode, now().toISOString(), user.id);
  let emailDelivered = false;
  const _logSendError = (e) => { log.error({ ...reqContext(req), err: ((e && e.message) || "").replace(/[\r\n]/g, "") }, "Resend verification email error"); return false; };
  // PR B / F#7 — primary + secondary, like every other lifecycle email. Bounded
  // (awaitDeliveryWithDeadline): `null` is still queued at the deadline.
  try { emailDelivered = await awaitDeliveryWithDeadline(sendVerificationEmail(getUserEmails(user), verifyCode, BASE_URL, user.first_name, user.id).catch(_logSendError)); }
  catch (e) { _logSendError(e); }
  try { recordUserEvent(user.id, "verification_resent", user.email || "system", reqContext(req)); } catch (auditErr) { swallowed("auth:verification-resent-audit", auditErr); }
  res.json({ ok: true, emailDelivered, ...(emailDelivered === null ? { emailDeferred: true } : {}) });
});

app.post("/api/admin/logout", csrfProtection, (req, res) => {
  // v6.16.39 — audit the admin-side session destruction. Sibling to
  // login_success / login_failed so an operator can reconstruct the
  // full session lifecycle for an admin or built-in superadmin
  // session. Captured BEFORE req.session.destroy so we can still
  // resolve the actor identity off the live session.
  let actor = null;
  if (req.session?.builtinId === "superadmin") actor = "superadmin";
  else if (req.session?.userEmail) actor = req.session.userEmail;
  else if (req.session?.userId) actor = req.session.userId;
  // v7.15.2 (audit) — this route carries NO requireAdmin, so a superadmin-tier
  // impersonation session reaches it (the guard lets superadmins through) and
  // destroy() would drop the `impersonator` marker unseen, leaving the target's
  // History with an impersonation_started that never closes. Same treatment
  // /api/logout already gives it: close the window on the TARGET and attribute
  // the sign-out to the acting ADMIN, not to the participant being viewed.
  const imp = req.session?.impersonator;
  if (imp) {
    const impActor = impersonationActor(req.session);
    if (req.session.userId) {
      try {
        recordUserEvent(req.session.userId, "impersonation_ended", impActor,
          { ...impersonationEndedDetails(imp, "logout"), ...reqContext(req) });
      } catch (e) {
        // never block logout on audit
        swallowed("auth:session-logout-impersonation-audit", e);
      }
    }
    actor = impActor;
  }
  if (actor) {
    try {
      recordOrphanedAuditEvent("session", req.sessionID || "unknown", "admin_logout", actor, reqContext(req));
    } catch (e) {
      // never block logout on audit
      swallowed("auth:admin-logout-audit", e);
    }
  }
  req.session.destroy(() => res.json({ ok: true }));
});

};
