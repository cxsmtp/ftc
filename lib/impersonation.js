"use strict";

const { normaliseRoutePath } = require("./util");
const { swallowed } = require("./best-effort");

// Impersonation (v7.14.0; the event-admin VIEW since v8.12.1) — an
// admin/superadmin temporarily browses the platform AS a chosen account. The
// mechanics are a session swap (mirroring toggle-admin-view's regenerate
// pattern): the admin's identity is snapshotted into `req.session.impersonator`
// and `req.session.userId` (+ the cosmetic mirrors) is set to the TARGET's id, so
// every guard and every handler — each resolves the acting user from
// `req.session.userId` — uniformly serves the target's view.
//
// THE SESSION IS SHAPED LIKE THE TARGET'S OWN, IN WHICHEVER VIEW WAS CHOSEN.
//   • participant view — `isAdmin`/`isSuperAdmin` unset, so the admin surface
//     rejects the session outright. The only shape until v8.12.1, and still the
//     only shape a PARTICIPANT-role target can take.
//   • event-admin view (v8.12.1) — an `event_admin` target may be impersonated in
//     THEIR admin panel: `isAdmin=true`, `isSuperAdmin` NEVER set (the target is
//     not a superadmin, and the write tier below is decided from the ACTING
//     admin's row, not from a session flag). Every event-admin predicate
//     (`isEventAdmin`, `scopedCompetitionIds`, `eventAdminGuard`, ownership by
//     `actorId`) then answers about the TARGET, so the panel is theirs row for
//     row — the impersonator gains nothing the organiser does not have. The
//     `impersonator` marker rides `POST /api/toggle-admin-view`'s regenerate, so
//     the two views are one impersonation, switched from the header exactly as
//     the organiser switches their own.
//
// Enforcement tiers (per the product spec), the same in either view:
//   • regular admin  — READ-ONLY: every state-changing request (non-GET under
//     /api/, minus the navigation/telemetry allowlist below) is rejected by
//     impersonationGuard with 403 {error: IMPERSONATION_READONLY_ERROR}, with
//     ONE named durable carve-out — the certificate mint
//     (impersonationReadOnlyWriteAllowed, below). In the event-admin view that
//     means every admin write the organiser's panel offers.
//   • superadmin     — full access; the SPA shows an "are you sure?" confirm
//     before every state-changing request (client-side warning, by design —
//     the server does not block). Superadmin-ONLY routes stay refused in the
//     event-admin view (`requireSuperAdmin` reads the session flag, which is
//     never set): "full access" means everything the ORGANISER may do, never
//     everything a superadmin may do through an organiser's session.
// A small set of endpoints is blocked for BOTH tiers (_IMPERSONATION_BLOCKED),
// a NESTED entry is refused for both (`_IMPERSONATION_BLOCKED_RE`), and so is
// joining an event (`_IMPERSONATION_JOIN_PATHS`).
// Entry:  POST /api/admin/participants/:id/impersonate (routes/participants.js)
// Switch: POST /api/toggle-admin-view                  (routes/participant.js)
// Exit:   POST /api/impersonation/exit               (routes/participant.js)
// Deps: lib/time only (a pure leaf) — keep this module free of db/audit imports
// so lib/middleware.js and lib/sessions.js can import it without cycles.

const { now } = require("./time");

// Exact error string the client modal + toasts surface for a blocked write
// (requirement wording: "not allowed in impersonation mode").
const IMPERSONATION_READONLY_ERROR = "Not allowed in impersonation mode";
// Marker returned when the TARGET's lifecycle fails mid-impersonation and the
// session was force-restored to the admin (requireParticipant / keepalive).
// The SPA turns this into a toast + reload back into the admin view. Must NOT
// collide with the fetch-interceptor's forced-signout error strings
// (csrf_invalid / session_expired / "Not authenticated" / "Account is not
// verified") — see public/js/core/api.js.
const IMPERSONATION_ENDED_ERROR = "impersonation_ended";

function isImpersonating(req) {
  return !!(req.session && req.session.impersonator);
}

// Audit-actor label for the impersonating ADMIN, read off the MARKER (no db).
// Since v8.12.1 `getAdminIdentity(req)` (lib/audit.js) also resolves the acting
// admin under impersonation — live, by `imp.userId` — so admin-surface emits may
// keep calling it; this one is for the participant-surface convention, where
// the emit names the participant and spreads `impersonated_by` beside it, and
// for the marker-only paths (session purge / expiry) that hold no request.
function impersonationActor(sess) {
  const imp = sess && sess.impersonator;
  if (!imp) return null;
  if (imp.builtinId === "superadmin") return "superadmin";
  return imp.userEmail || imp.userId || "admin";
}

// State-changing requests that stay allowed for EVERY impersonating admin:
//   • /api/impersonation/exit — the escape hatch (must never be blockable).
//   • /api/session/keepalive  — keeps the ADMIN's session alive; no app state.
//   • /api/select-competition — pure navigation under impersonation: the
//     solve-clock stamp (competition_users.login_time) + active_competition_id
//     persistence are suppressed for impersonation sessions in the handler, so
//     nothing durable changes. Without this a read-only admin couldn't open the
//     target's challenge list at all (every competition-scoped GET requires a
//     selected competition).
//   • /api/deselect-competition — v8.3.8, the exact inverse and equally pure:
//     it only ever REMOVES a pointer, and its durable half (the target's
//     auto-resume marker) is suppressed under impersonation in the handler for
//     the same reason. Blocking it would meet a read-only admin with a "not
//     allowed" modal for clicking the Events nav item.
//   • navigated-away          — background SPA telemetry fired on tab/route
//     changes; blocking it would surface random error modals. The event row is
//     written with impersonated=1, so analytics never counts it.
//   • /api/login, /api/logout — session-replacing escape hatches: both destroy/
//     regenerate the whole session, impersonation marker included. `/api/logout`
//     DOES write one row for the target — the `impersonation_ended` event that
//     closes the window — and deliberately attributes the `logout_manual` to the
//     ADMIN, never to the target (routes/auth.js).
//   • /api/toggle-admin-view  — v8.12.1, THE VIEW SWITCH. It regenerates the
//     session and used to restore only a fixed field list, which dropped the
//     `impersonator` marker — the reason it sat in the BLOCKED set from v7.14.0.
//     The handler now carries the marker across its regenerate, skips the
//     participant landing rules for the target (their auto-resume marker is
//     theirs), and attributes the `admin_view_toggled` row to the ACTING admin.
//     Nothing durable changes for the target, so it belongs on THIS list rather
//     than merely off the blocked one: a read-only admin must be able to switch
//     an impersonated organiser between their two views, and a superadmin must
//     not be asked "are you sure?" for it. `mode:"admin"` on a PARTICIPANT
//     target is refused by the handler's own role read (403, marker intact).
//   • /api/test/*             — NODE_ENV=test-only harness endpoints.
//   • /api/admin/certificate-config/preview, /api/admin/join-qr — POSTs only
//     because they carry a body to RENDER (an unsaved certificate design, the
//     join link and code for the QR); both store, mint and audit nothing, so an
//     organiser's panel viewed through impersonation previews and shows its
//     join QR like the organiser does, without the "real data" confirm.
// `path` MUST already be lowercased by the caller — see impersonationGuard.
const _NAVAWAY_RE = /^\/api\/tasks\/[^/]+\/navigated-away$/;
function impersonationWriteAllowed(path) {
  return path === "/api/impersonation/exit"
    || path === "/api/session/keepalive"
    || path === "/api/select-competition"
    || path === "/api/deselect-competition"
    || path === "/api/toggle-admin-view"
    || path === "/api/login"
    || path === "/api/logout"
    || path === "/api/admin/certificate-config/preview"
    || path === "/api/admin/join-qr"
    || _NAVAWAY_RE.test(path)
    || path.startsWith("/api/test/");
}

// Blocked for EVERY impersonation tier, superadmin included — checked before
// the superadmin bypass.
//
// The two sign-in-code endpoints: without this entry an impersonating admin
// could request and redeem a code for the target (or reveal one) and sign in as
// that participant directly — with no `impersonated_by` on anything they did
// afterwards, which is the entire forensic value of the feature (v8.1.4).
//
// `/api/toggle-admin-view` LEFT this set in v8.12.1 — see the allowlist above.
// Its only recorded reason for being here was the marker loss across its
// regenerate, and the handler carries the marker now.
// The password door and the sign-in-method change join them (v9.0.0): a sign-in
// as the target, or a credential set on the target's account, is the same
// unattributed door.
const _IMPERSONATION_BLOCKED = new Set(["/api/auth/code/request", "/api/auth/code/redeem", "/api/auth/code/drop-event", "/api/auth/password", "/api/me/sign-in-method"]);

// v8.12.1 — A NESTED ENTRY IS REFUSED FOR EVERY TIER. In the event-admin view
// `requireAdmin` passes (the target's row is an admin tier) and the entry route
// is classified `'scoped'`, so a superadmin-origin session could reach it — and
// its snapshot would record `impersonator.userId = req.session.userId`, i.e. the
// EVENT ADMIN, overwriting the acting admin's identity: attribution lost, and
// exit restoring the wrong person. The path carries an `:id`, so the exact-match
// Set above cannot name it. THIS ARM ANSWERS FIRST — the guard is mounted
// before every route — so it carries the named code (`impersonation_nested`)
// itself; the route's inline 409 with the same code is defence in depth for a
// build that unmounts the guard, and is unreachable while it is mounted (the
// first draft put the named code on the route alone, where no client ever
// received it — found by the pre-release review).
const _IMPERSONATION_BLOCKED_RE = [/^\/api\/admin\/participants\/[^/]+\/impersonate$/];
const IMPERSONATION_NESTED_ERROR = "You are already impersonating somebody. Exit that impersonation first.";

// A JOIN IS REFUSED FOR EVERY TIER (operator ruling, 21 Nov 2026: a
// superadmin's join made while viewing as a participant must not count as that
// participant having joined). The join door (`POST /api/competitions/join`, the
// join link, QR and event code) enrols the TARGET, and every "joined" figure
// counts enrolments, so the superadmin's full write access would put a person
// in an event they never chose and count them there. Refused, not marked and
// subtracted: an organiser who means to add them uses Add to event, an
// organiser's act that counts like any other. Named, and asked ahead of the
// superadmin bypass like the blocked set above; the route repeats it in case
// this guard is ever unmounted.
const _IMPERSONATION_JOIN_PATHS = new Set(["/api/competitions/join"]);
const IMPERSONATION_JOIN_ERROR = "Joining an event is not available while you view as someone: it would enrol them. To add them to an event, use Add to event in that event's Participants section.";

// v8.3.25 — THE READ-ONLY TIER'S ONE DURABLE CARVE-OUT: minting a certificate.
//
// Operator instruction: a regular admin must be able to GENERATE a participant's
// certificate while impersonating them. Until now only a superadmin could, so at
// an event the organiser standing beside the participant had to fetch somebody
// else to press a button on the participant's own screen — the v7.14.2 shape,
// where the control that answers the problem is real and out of reach.
//
// IT IS DELIBERATELY NOT `impersonationWriteAllowed`, AND MUST NOT BE FOLDED
// INTO IT. That list means "nothing durable changes": every member is navigation,
// telemetry or an escape hatch, and each one's entry above argues that the target
// sees no lasting effect. THIS path writes an `achievement_badges` row, an
// `images` blob and a `badge_minted` audit event, and for a placement badge it
// publishes a permanent public page in the participant's name. Two sets, two
// meanings — collapsing them is how the next reader comes to believe the
// read-only tier writes nothing at all, which is the sentence this release had to
// go and correct in six documents.
//
// WHAT MAKES IT SAFE IS THAT THE ARTEFACT IS THE PARTICIPANT'S OWN AND IS FULLY
// ATTRIBUTED. The mint is server-authoritative end to end — `_mintEligibility`
// re-derives the whole rule from the board, so an admin cannot mint a certificate
// the participant has not earned, cannot choose its rank, its score, its name or
// its date — and the `badge_minted` event carries `impersonated_by`, so the
// competition History records which admin generated it rather than recording that
// the participant published themselves.
//
// SHARING IS NOT INCLUDED, and that is the operator's decision rather than an
// oversight: `POST /badge/:token/shared` is what makes a COMPLETION certificate's
// page live, and the dialog's own copy promises the participant that "nothing is
// published until you press Share". Generating is not publishing, so the read-only
// tier generates and the participant (or a superadmin) publishes. The SPA
// withholds the Share affordance WITH its reason for this tier rather than
// offering a button the server will refuse (v7.14.2).
//
// Anchored at BOTH ends, so it cannot widen to a sibling under
// /api/competitions/:id/ (`reminder`, `leave`) or to /api/competitions/join-code/…
// `path` is already normalised — lowercased, percent-decoded, slash-collapsed —
// by impersonationGuard, so a case or trailing-slash variant matches identically.
const _CERT_MINT_RE = /^\/api\/competitions\/[^/]+\/badge$/;
function impersonationReadOnlyWriteAllowed(path) {
  return _CERT_MINT_RE.test(path);
}

// v8.3.25 — THE ONE ROUTE OUTSIDE /api/ THAT ACTS AS THE IMPERSONATED
// PARTICIPANT, and the reason this gate's scope needed an exception at all.
//
// `POST /badge/:token/shared` is mounted beside the PUBLIC badge page rather
// than under /api/, so it fell out of the gate's `startsWith("/api/")` scope and
// was reachable by EVERY impersonation tier — including the read-only one, for
// which nothing else durable was. It is not a read: the owner's call stamps
// `shared_at` (write-once) and, for a COMPLETION certificate, that stamp is the
// sole trigger that makes the participant's public page live. Under
// impersonation the session carries the TARGET's id, so `by_owner` is true and a
// read-only admin published on the participant's behalf — against the dialog's
// own promise that nothing is published until they press Share.
//
// Found by the v8.3.25 lock that asserts it IS refused, not by review: the
// certificate carve-out above is only coherent while publishing stays out of it.
const _BADGE_SHARED_RE = /^\/badge\/[^/]+\/shared$/;

// Global write gate — mounted in server.js immediately after the session
// middleware, BEFORE any route, so the read-only invariant holds BY
// CONSTRUCTION for every current and future mutating endpoint (no per-route
// checks). Non-/api paths (/verify, /confirm-email, static assets) are out of
// scope: they never act as the impersonated participant — with the single
// audited exception above, which does.
function impersonationGuard(req, res, next) {
  const imp = req.session && req.session.impersonator;
  if (!imp) return next();
  const m = req.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
  // Express routes case-INSENSITIVELY and non-strictly by default (this app
  // sets neither `case sensitive routing` nor `strict routing`), so both
  // `PUT /API/me` and `POST /api/toggle-admin-view/` reach the handlers
  // registered at the exact lowercase, slash-free paths — while `req.path`
  // preserves the caller's spelling. Matching the raw path let a read-only
  // admin walk straight past this gate (the ONLY enforcement point for the
  // read-only tier) by upper-casing one letter.
  //
  // ext-audit v7.15.16 — the claim that "doubled-slash variants do NOT route at
  // all" was true for these `app.post("/api/…")` registrations but NOT for a
  // mounted handler: `/docs//user-guide/superadmin.md` served the superadmin
  // guide anonymously for exactly that reason. The reasoning is now a shared
  // function rather than a comment, so every gate normalises identically.
  const path = normaliseRoutePath(req.path);
  if (!path.startsWith("/api/") && !_BADGE_SHARED_RE.test(path)) return next();
  // The blocked set is an EXACT match that must fire ahead of the superadmin
  // bypass below; normaliseRoutePath handles the trailing slash that would
  // otherwise let `/api/toggle-admin-view/` miss the Set. The allowlist below
  // matches the same normalised path — a variant either misses the allowlist
  // (failing CLOSED, the safe direction) or is caught by the blocked set.
  if (_IMPERSONATION_BLOCKED_RE.some(re => re.test(path))) {
    return res.status(403).json({ error: IMPERSONATION_NESTED_ERROR, code: "impersonation_nested" });
  }
  if (_IMPERSONATION_BLOCKED.has(path)) {
    return res.status(403).json({ error: IMPERSONATION_READONLY_ERROR, code: "impersonation_readonly" });
  }
  if (_IMPERSONATION_JOIN_PATHS.has(path)) {
    return res.status(403).json({ error: IMPERSONATION_JOIN_ERROR, code: "impersonation_join_refused" });
  }
  if (impersonationWriteAllowed(path)) return next();
  // v7.21.12 — RE-READ THE ACTING ADMIN, and derive the write tier from that row.
  //
  // Every other authenticated surface re-reads its principal per request:
  // requireParticipant, requireAdmin, requireSuperAdmin, GET /api/admin/me, the
  // docs gate. Under impersonation the acting principal is the ADMIN, but the
  // session presents the participant surface, so every one of those checks reads
  // the TARGET — `req.session.userId` is the target's id. The admin's own row was
  // therefore read exactly ONCE, at entry, and the read-only-vs-full-write tier
  // came from `imp.isSuperAdmin`, a snapshot frozen at that moment.
  //
  // Route-driven revocations do purge the session (invalidateOtherSessions is
  // impersonation-aware), so the gap is the out-of-band class this repo already
  // treats as in scope: the participant-import overwrite writes verified /
  // blocked / approved / role and calls no session invalidation, and direct SQL
  // does the same. After one of those an ex-admin kept participant-level writes
  // against the chosen target — submissions that move a real score, a badge mint
  // that publishes a permanent public page in their name — for as long as the
  // client kept the session warm, because keepalive checks the target too.
  //
  // This runs only on a non-GET that is not on the allowlist, i.e. exactly when a
  // write tier is about to be decided, so it costs one indexed lookup on a path
  // that is already rare.
  let _isSuper = !!imp.isSuperAdmin;
  if (imp.builtinId !== "superadmin") {
    let adminRow = null;
    try {
      // Lazy require, deliberately. This module is documented as dependency-free
      // so middleware/sessions can import it without a cycle, and a top-level
      // `require("../db")` would change that property for every importer. The
      // same shape lib/middleware.js uses for lib/comp-allowlist.
      const _db = require("../db");
      adminRow = imp.userId
        ? _db.prepare("SELECT role, blocked, denied_at, verified, approved FROM users WHERE id=?").get(imp.userId)
        : null;
    } catch (_) { adminRow = null; }   // a read failure must not grant the write
    const role = adminRow && adminRow.role;
    // RBAC — any admin-class role (a class other than `none`; lazily, for the
    // same dependency-free reason as the db require above).
    if (!adminRow || require("./rbac").roleClass(role, { live: true }) === "none"
        || adminRow.blocked || adminRow.denied_at || !adminRow.verified || !adminRow.approved) {
      // Same predicate and same disposition as POST /api/impersonation/exit:
      // there is no admin identity left to hand back, so destroy rather than
      // restore. Matches toggle-admin-view's message.
      return destroyImpersonationSession(req, res);
    }
    _isSuper = role === "superadmin";
  }
  // v8.12.0 — THE RIVAL RE-ASKED AT THE WRITE. Entry refuses impersonating a
  // rival (routes/participants.js, competitorRivalDenied), but the pair can
  // BECOME rivals mid-session — the acting admin enrolled into the target's
  // compete event by a colleague while the impersonation runs — and every
  // write made as the target then moves the board the admin competes on. So
  // the question is asked again here, on every non-GET off the allowlist, for
  // BOTH tiers (a read-only admin's certificate mint is a board artefact too):
  // one indexed lookup on a path that is already rare. Reads continue; the
  // session is kept, because a refusal here is about the write, not the
  // session. Lazy require, as above; NO try/catch — a read failure here must
  // not grant the write, and a throw reaches the error handler as a 500, which
  // is the closed direction.
  if (imp.userId && req.session.userId) {
    const { competitorRivalDenied } = require("./staff-compete");
    const _rival = competitorRivalDenied(require("../db"), imp.userId, req.session.userId);
    if (_rival) return res.status(403).json({ error: _rival.message, code: _rival.code, competitionId: _rival.competitionId, competitionName: _rival.competitionName });
    // v8.12.1 — THE ACTING ADMIN'S OWN COMPETITOR LOCK, RE-ASKED FOR THE
    // EVENT-ADMIN VIEW. Every competitor door in the routes asks its predicate
    // about `competitorIds(req)` — the SEAT (the target: "act exactly as they
    // can") AND the HAND (the acting admin: whose own board must not become
    // reachable through somebody else's panel) — so a superadmin who competes
    // in event E is refused at every door E binds whichever organiser's seat
    // they hold. The first draft keyed those doors on the seat alone and
    // relied on THIS coarse re-ask, which covers only events the TARGET
    // organises; a rival enrolled in E and in some other event the target does
    // run was reachable through it (found by the pre-release review). Entry
    // refuses the admin VIEW outright while the acting admin competes in an
    // event the organiser runs (routes/participants.js, and the toggle asks
    // the same); this is that question asked again on every admin-shaped
    // write, because the pair can BECOME so mid-session exactly as the rival
    // pair can — DEFENCE IN DEPTH now, coarse and fail-closed: every write is
    // refused while it holds, and the copy says so rather than narrowing it.
    // Same lazy require, same no-try/catch, for the same reason.
    if (req.session.isAdmin) {
      const _c = actingAdminCompetesInTargetEvents(require("../db"), imp.userId, req.session.userId);
      if (_c) return res.status(403).json({ error: _c.message, code: _c.code, competitionId: _c.competitionId, competitionName: _c.competitionName });
    }
  }
  // Superadmin-origin impersonation: state changes allowed (the SPA fronts them
  // with an "are you sure?" confirm; a scripted client skips the warning — it
  // is a UX guard, not a security boundary, per the spec).
  if (_isSuper) return next();
  // v8.3.25 — the read-only tier's ONE durable carve-out (see the predicate's own
  // header for what it is and why sharing is not in it).
  //
  // IT SITS BELOW THE v7.21.12 RE-READ, and that placement is the whole of its
  // safety: an acting admin whose row is gone, blocked, denied, unverified,
  // unapproved or no longer admin has already had this session destroyed above,
  // so the carve-out can never be reached by somebody who has stopped being an
  // admin. Hoisting it above that block — which reads as a harmless "check the
  // cheap thing first" — would hand an ex-admin a live certificate mint.
  if (impersonationReadOnlyWriteAllowed(path)) return next();
  return res.status(403).json({ error: IMPERSONATION_READONLY_ERROR, code: "impersonation_readonly" });
}

// In-place restore of the admin identity onto the CURRENT session (no
// regenerate — used by the forced-exit paths inside requireParticipant /
// keepalive, where the target's lifecycle failed mid-impersonation and the
// session must NOT be destroyed: it is the ADMIN's session). Granting the
// isAdmin/isSuperAdmin flags without a DB re-check here is safe because every
// admin endpoint (requireAdmin / requireSuperAdmin) re-reads the user row per
// request and demotes stale flags — the restore hands back nothing a stale
// admin session could not already claim. The explicit exit endpoint
// (POST /api/impersonation/exit) DOES regenerate + re-check, matching
// toggle-admin-view.
// Returns the impersonator snapshot that was in force (so the caller can emit
// the `impersonation_ended` audit row — this module stays dependency-free, it
// does not import lib/audit), or null when the session wasn't impersonating.
function restoreImpersonatorSession(req) {
  const imp = req.session && req.session.impersonator;
  if (!imp) return null;
  delete req.session.impersonator;
  delete req.session.competitionId;
  delete req.session.timeslotId;
  // v8.12.2 — a sealed-answer reveal lasts for the session SHAPE it was made
  // in: every regenerate (entry, explicit exit, the view toggle) already drops
  // `sealedReveals` by restoring a fixed field list, and
  // this in-place forced exit must agree with the explicit one, or a reveal
  // made inside a seat would outlive the seat on this path alone.
  delete req.session.sealedReveals;
  if (imp.builtinId === "superadmin") {
    delete req.session.userId;
    delete req.session.userEmail;
    delete req.session.userFirstName;
    delete req.session.userLastName;
    delete req.session.userRole;
    req.session.builtinId = "superadmin";
  } else {
    req.session.userId = imp.userId;
    req.session.userEmail = imp.userEmail || null;
    req.session.userFirstName = imp.userFirstName || null;
    req.session.userLastName = imp.userLastName || null;
    req.session.userRole = imp.userRole || null;
  }
  req.session.isAdmin = true;
  req.session.isSuperAdmin = !!imp.isSuperAdmin;
  if (imp.competitionId) req.session.competitionId = imp.competitionId;
  if (imp.timeslotId) req.session.timeslotId = imp.timeslotId;
  return imp;
}

// Shared `impersonation_ended` audit detail. Every exit path (explicit exit,
// forced exit on target-lifecycle failure, logout, and — v8.13.4 — a refused
// CSRF token, which destroys the session) must record the same shape so the
// window is always closed in the target's history — an unclosed
// `impersonation_started` loses the duration and reads as still-open. Every
// reason passed here needs words in public/js/features/history.js, and
// csrf-session-end.api.spec.js fails on one that has none.
// v8.12.1 — `view` is the view in force when the window closed (the marker's
// `view` tracks every switch), so History can tell an organiser's panel being
// looked at from their participant view being looked at. Absent on a marker
// written before the field existed, which the rendering treats as participant.
/**
 * v8.12.1 — THE ACTING ADMIN LOST ADMIN ACCESS MID-IMPERSONATION: no identity
 * to hand back, so the session is destroyed — but the target's window is
 * CLOSED FIRST. Five sites reach this disposition (the guard, requireAdmin,
 * GET /api/admin/me, the toggle and the exit route), and every one used to
 * `destroy()` with no emit, so the target's History kept an unclosed
 * `impersonation_started` — the one exit path the "every exit closes the
 * window" contract below did not cover (found by the pre-release review).
 * `reason: "actor_inactive"` is the ninth reason (`csrf_invalid`, v8.13.4, the
 * tenth); best-effort, because the destroy must happen whether or not the audit
 * write does. Lazy require of lib/audit, for the reason the guard gives above.
 */
function destroyImpersonationSession(req, res, status = 403, body = { error: "You do not have admin access" }) {
  const imp = req.session && req.session.impersonator;
  const targetId = req.session && req.session.userId;
  if (imp && targetId) {
    try {
      const { recordUserEvent, reqContext } = require("./audit");
      recordUserEvent(targetId, "impersonation_ended", impersonationActor(req.session),
        { ...impersonationEndedDetails(imp, "actor_inactive"), ...reqContext(req) });
    } catch (e) { /* non-fatal — the destroy below is the point */ swallowed("impersonation:actor-inactive-emit", e); }
  }
  return req.session.destroy(() => res.status(status).json(body));
}

/**
 * THE TARGET STOPPED QUALIFYING MID-IMPERSONATION: the session is the ADMIN's,
 * so it is restored in place — never destroyed — the target's window is closed
 * (`target_inactive`), and the request is answered with the marker the SPA turns
 * into a toast and a reload. The ONE copy of that answer: requireParticipant,
 * requireAdmin, GET /api/admin/me and the keepalive give it at the headers, and
 * the participant writes that re-ask the seat at commit (the submit and the
 * certificate mint; the sign-in method change re-asks the same way, but the
 * guard refuses it to every impersonated session) give the same answer, after
 * their transaction. The restore hands back nothing a stale admin session could not
 * already claim: the admin guards re-read the admin's own row on the next
 * request. Lazy require of lib/audit, for the reason the guard gives above.
 */
function restoreImpersonationTargetInactive(req, res) {
  const targetId = req.session.userId;
  const actor = impersonationActor(req.session);
  const imp = restoreImpersonatorSession(req);
  // Close the window in the TARGET's history — a forced exit is a first-class
  // exit path, so it must leave the same trail as the explicit one (an unclosed
  // impersonation_started loses the duration).
  try {
    const { recordUserEvent, reqContext } = require("./audit");
    recordUserEvent(targetId, "impersonation_ended", actor,
      { ...impersonationEndedDetails(imp, "target_inactive"), ...reqContext(req) });
  } catch (e) { /* non-fatal — the restore already happened */ swallowed("impersonation:target-inactive-emit", e); }
  return req.session.save(() =>
    res.status(403).json({ error: IMPERSONATION_ENDED_ERROR, reason: "target_inactive" }));
}

function impersonationEndedDetails(imp, reason) {
  return {
    admin_user_id: (imp && imp.userId) || null,
    duration_ms: imp && imp.started_at ? Math.max(0, now().getTime() - new Date(imp.started_at).getTime()) : null,
    reason,
    ...(imp && imp.view ? { view: imp.view } : {}),
  };
}

/**
 * v8.12.1 — does the ACTING admin hold a competitor row on any event the TARGET
 * organises? The refusal both the entry (event-admin view) and the guard's
 * per-write re-ask answer with; see the guard for why it is coarse.
 *
 * `db` is an ARGUMENT, the `lib/staff-compete.js` shape, so this module stays
 * dependency-free at module scope. The built-in superadmin has no `users` row
 * and no `competition_users` row, so it is structurally exempt — `actingId` is
 * null for it and the query is never run. Uses the staff-compete CODES table
 * rather than spelling the code, which a scanner forbids outside that module.
 */
function actingAdminCompetesInTargetEvents(db, actingId, targetId) {
  if (!actingId || !targetId || actingId === targetId) return null;
  const hit = db.prepare(
    `SELECT c.id, c.name FROM competition_admins ca
       JOIN competition_users cu ON cu.competition_id = ca.competition_id AND cu.user_id = ?
       JOIN competitions c ON c.id = ca.competition_id
      WHERE ca.user_id = ? AND c.staff_compete = 1
      ORDER BY c.name LIMIT 1`
  ).get(actingId, targetId);
  if (!hit) return null;
  const { CODES } = require("./staff-compete");
  return {
    code: CODES.COMPETITOR_EDIT,
    competitionId: hit.id,
    competitionName: hit.name,
    message: `You are competing in “${hit.name}”, which this organiser runs, so you cannot make changes through their admin view. Remove yourself from that event first, or ask another administrator.`,
  };
}

// WHO MAY SIT IN AN ORGANISER'S OWN PANEL (an impersonation with the admin view,
// `impersonator && isAdmin`): the two built-in global roles, and the built-in
// superadmin account (no row; each caller handles it by `builtinId`). A custom
// role, even one of every event holding View as a participant, may view a
// participant as them, but never takes an organiser's seat: the panel reads and
// acts with the SEAT's grants, which are not the custom role's own permissions,
// and the seat's carve-outs exist for the built-in event admin only. One
// predicate for the entry (routes/participants.js), the view switch
// (routes/participant.js) and the panel's two live re-checks (requireAdmin,
// GET /api/admin/me), so the switch cannot open what the entry refuses.
function organiserPanelOpensTo(role) {
  return role === "admin" || role === "superadmin";
}

module.exports = {
  organiserPanelOpensTo,
  IMPERSONATION_READONLY_ERROR, IMPERSONATION_ENDED_ERROR, IMPERSONATION_JOIN_ERROR,
  isImpersonating, impersonationActor, impersonationWriteAllowed,
  impersonationReadOnlyWriteAllowed, actingAdminCompetesInTargetEvents,
  impersonationGuard, restoreImpersonatorSession, impersonationEndedDetails,
  destroyImpersonationSession, restoreImpersonationTargetInactive,
};
