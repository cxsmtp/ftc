"use strict";

// Self-enrollment routes: public link preview + authenticated join, and the
// admin reveal + token regenerate. The engine (token mint, enroll txn, side
// effects) lives in lib/self-enroll; these are the thin HTTP wrappers.
// (v7.0.0 refactor: route split extracted from server.js.)

const db = require("../db");
const { rateLimit, destructiveAdminLimit, requireParticipant, requireCompleteProfile, requireAdmin, csrfProtection } = require("../lib/middleware");
const { getCompetition, competitionStatus, competitionEffectiveEnd, _competitionAcceptsSelfEnroll, _invalidateCompetitionCache, competitionAdmission, lateWindowAdmissionDenied } = require("../lib/competitions");
const { eventPolicyForWire } = require("../lib/event-policy"); // v8.1.0 (PR 12)
const { _resolveJoinableComp, _selfEnrollEnrollTxn, _selfEnrollSideEffects, _genSelfEnrollToken, _genJoinCode, _resolveJoinCode, staffRowRefusal, untieJoinLinkBindings } = require("../lib/self-enroll");
const { formatHumanCode } = require("../lib/human-code");
const { removeUserFromCompetition } = require("../lib/group-sync");
const { recordCompetitionEvent, getAdminIdentity, reqContext, runTxnWithMirrorBuffer } = require("../lib/audit");
const { impersonationActor, isImpersonating, IMPERSONATION_JOIN_ERROR } = require("../lib/impersonation");
const { competitionDenied, competitorIds } = require("../lib/event-admin"); // v8.7.0
const { competitorEditDenied, refuseCompetitor, CODES: STAFF_COMPETE_CODES } = require("../lib/staff-compete"); // v8.12.0
const { BASE_URL } = require("../lib/config");
const { now } = require("../lib/time");


module.exports = function register(app) {
  // v8.1.0 (PR 32) — resolve a TYPED short code to its join token.
  //
  // A separate route rather than teaching the preview to accept either, because
  // the two inputs are different kinds of thing and must stay so: the token is a
  // 256-bit secret scrubbed from logs, the code is printed on a sign. One route
  // taking both would put a secret and a public value in the same path segment,
  // and the access-log scrub would then have to redact the readable one too.
  //
  // It answers with the TOKEN, so every downstream path — preview, register,
  // join, the stored-token recovery — is exactly the one that already exists.
  // Nothing new has to learn what a code is.
  //
  // Rate-limited HARDER than the token preview (10/min vs 30): six characters is
  // walkable in a way 256 bits is not, so this is the only surface where the
  // limiter is load-bearing rather than incidental. Failures are opaque and
  // identical to each other, so the code is not an existence oracle either.
  //
  // **IT ANSWERS 200 ON FAILURE, AND THAT IS THE SIGN-IN-CODE POSTURE RATHER THAN
  // A MISSING STATUS CODE.** The scanner-reputation counter counts every non-429
  // 4xx per IP and blocks the WHOLE address from the entire API for fifteen
  // minutes at 100 in ten. A six-character code printed on a booth sign is
  // mistyped by design, and a venue behind one NAT is the normal case — so a
  // counted 404 here would pour ordinary mistyping into the same shared per-IP
  // pool that already aggregates 401 polls and CSRF 403s (the measured v7.15.34
  // cascade), and lock the room out of the platform at the moment the event
  // starts. A future refactor "fixing" the missing status code reopens exactly
  // that, silently, which is why this has a lock and not only this paragraph.
  //
  // The LIMITER is kept and is the right bound here precisely because its own
  // 429s are excluded from that counter: a walker is still stopped at 10/min
  // without ever contributing to an address-wide block.
  //
  // The SIBLING preview route below deliberately keeps its 404 — a 256-bit token
  // is not typed by a human, so it is not the mistype surface, and the client's
  // stored-token recovery treats that 404 as the server's authoritative verdict
  // and purges on it (v7.22.8). Do not "make the two consistent".
  app.get("/api/competitions/join-code/:code", rateLimit(60_000, 10, "join-code-lookup"), (req, res) => {
    const comp = _resolveJoinCode(req.params.code);
    // One refusal literal, so an unknown code, a disabled link and a finished
    // event are byte-identical by construction rather than by two sites happening
    // to agree. The copy lives on the client — a refusal that carried a message
    // would be one edit away from carrying a DIFFERENT message per case.
    if (!comp) return res.json({ ok: false });
    res.json({ ok: true, token: comp.self_enroll_token });
  });

  app.get("/api/competitions/self-enroll/:token", rateLimit(60_000, 30, "self-enroll-lookup"), (req, res) => {
    const comp = _resolveJoinableComp(req.params.token);
    if (!comp) return res.status(404).json({ error: "This link is invalid or no longer active." });
    res.json({
      id: comp.id,
      name: comp.name,
      status: competitionStatus(comp),
      // An ENDED event this link still opens is in its late-entry window (the
      // preview resolves only an event that admits someone), and the landing's
      // chip says "Late entry open", as the Events list does, rather than
      // "Ended". The admission question itself, so the two cannot disagree.
      late_entry_window_open: competitionAdmission(comp) === "late",
      start_time: comp.start_time,
      duration_minutes: comp.duration_minutes,
      // v7.22.8 — the client persists the pending join token until the moment
      // the token stops being usable, and that moment is the competition's
      // EFFECTIVE end (multi-session comps end at their latest session, not at
      // start_time + duration_minutes). Disclosure is accepted: for a
      // single-slot comp it is derivable from the two fields above; for a
      // multi-session comp it additionally reveals only WHEN the event ends —
      // to someone already holding the invite link, who sees the schedule the
      // moment they join.
      effective_end: competitionEffectiveEnd(comp)?.toISOString() || null,
      // v8.1.0 (PR 12) — the only policy attach point reachable BEFORE an account
      // exists, which is why it is one of the eight rather than an afterthought:
      // the registration form behind a join link has to know what kind of event it
      // is registering someone for. Nothing on this response is a secret — the
      // kind is one of three published values, and the policy is derived from it,
      // so a holder of the link learns nothing they will not see on the next page.
      event_kind: comp.event_kind,
      policy: eventPolicyForWire(comp),
      // v8.12.0 — whether staff compete here, so a staff member scanning the QR
      // is told BEFORE joining that the join enrols them as a competitor. Not a
      // secret: it is a property of the event every enrolled admin sees.
      staff_compete: !!comp.staff_compete,
      // The EVENT LOOK (lib/platform-look.js): the join landing paints it. A
      // look id, not a secret.
      event_look: comp.event_look || null,
      event_look_locked: !!(comp.event_look && comp.event_look_locked),
      // Whether the event's report team receives its participants' details: the
      // join card then says so, and how to stay out of the follow-up lists
      // (operator ruling, 17 Nov 2026). A property of the event, not a secret.
      shares_leads: require("../lib/event-team").sharesLeads(comp.id),
    });
  });

  // Authenticated join — an already-signed-in participant enrolls themselves into
  // the competition the token points to. Idempotent (re-posting an already-joined
  // token returns ok with alreadyMember:true). Does NOT select the competition or
  // pick a timeslot — the SPA calls /api/select-competition next, which still
  // enforces the profile-completion gate and the slot picker.
  app.post("/api/competitions/join", requireParticipant, rateLimit(60_000, 20, "self-enroll-join"), requireCompleteProfile, csrfProtection, (req, res) => {
    // Operator ruling, 21 Nov 2026 — nobody joins an event while viewing as
    // someone (lib/impersonation.js `_IMPERSONATION_JOIN_PATHS` answers first,
    // for every tier); repeated here in case that guard is ever unmounted.
    if (isImpersonating(req)) return res.status(403).json({ error: IMPERSONATION_JOIN_ERROR, code: "impersonation_join_refused" });
    const { token } = req.body;
    if (!token || typeof token !== "string") return res.status(400).json({ error: "Join token required" });
    // Resolve to a real, enabled competition first. A disabled/invalid token is
    // an opaque 404 (no oracle); once it resolves to an enabled comp, a
    // non-joinable status (ended — the only non-upcoming/live state) is a clear
    // 409 (useful to the authenticated user). Self-enroll is upcoming/live only.
    const comp = db.prepare("SELECT * FROM competitions WHERE self_enroll_token=?").get(token);
    if (!comp || !comp.self_enroll_enabled) return res.status(404).json({ error: "This link is invalid or no longer active." });
    if (!_competitionAcceptsSelfEnroll(comp)) return res.status(409).json({ error: "This event has ended." });
    const user = db.prepare("SELECT id, nickname, first_name, last_name, email FROM users WHERE id=?").get(req.session.userId);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    // v8.12.0 — THE STAFF ROW-WRITER RULE (lib/self-enroll.js staffRowRefusal).
    // A staff member scanning the QR of an event where staff do NOT compete is
    // let in as a spectator with no row written — the join "succeeds" because
    // entering is what they wanted, and `staffSpectator` says why nothing was
    // recorded. On an event where staff DO compete the row is written like
    // anybody's, unless they authored one of its challenges, which is refused
    // with the challenges named.
    // A staff-tagged user who ALREADY holds a row on this event — assigned before
    // the tag, or before this release — is a member, whatever the switch says:
    // the ordinary idempotent path answers `alreadyMember:true` for them, as it
    // does for anybody, rather than a spectator answer that claims they are not.
    const _hasRow = !!db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND user_id=?").get(comp.id, user.id);
    if (!_hasRow) {
      const _refusal = staffRowRefusal(user, comp);
      if (_refusal === "spectator") return res.json({ ok: true, competitionId: comp.id, alreadyMember: false, staffSpectator: true });
      if (_refusal) {
        return res.status(409).json({
          error: `You created ${_refusal.authored.length === 1 ? "a question" : `${_refusal.authored.length} questions`} assigned to “${comp.name}” (${_refusal.authored.map(t => `“${t.title}”`).join(", ")}), so you cannot compete in it — a question's answer is known to its author.`,
          code: STAFF_COMPETE_CODES.AUTHOR_COMPETES, tasks: _refusal.authored,
        });
      }
      // v8.12.6 — through the late-entry window, somebody who PLAYED this event
      // before it ended cannot come back in as a late entrant: their row would
      // move them onto the late-entrant section and let them play on past the end
      // of an event whose results are final. The same predicate every admission
      // door asks (`lateWindowAdmissionDenied`); a held row is not a new row, so
      // it takes the idempotent path below as before. A settled answer (it cannot
      // change while the window stays open), so a stored join is worth purging on
      // its code, as the client already purges one on the author refusal above.
      if (competitionAdmission(comp) === "late") {
        const _tp = lateWindowAdmissionDenied(comp, user.id, competitionEffectiveEnd(comp), { self: true });
        if (_tp) return res.status(409).json({ error: _tp.message, code: _tp.code });
      }
    }
    // v7.21.32 — the ACTOR is the participant, not the "self_enroll" mechanism,
    // and the event carries their address. This is a user-driven state change:
    // both halves of the standing rule apply. (No impersonation reaches here: it
    // is refused above, so the join is always the person's own.)
    const didInsert = _selfEnrollEnrollTxn(user, comp, reqContext(req), user.email || "self_enroll");
    if (didInsert) _selfEnrollSideEffects(user, comp);
    res.json({ ok: true, competitionId: comp.id, alreadyMember: !didInsert });
  });

  // v8.1.0 — LEAVE THIS EVENT (self-service un-enrolment).
  //
  // The walk-up case it exists for: someone scans the wrong QR at a busy stand,
  // or joins to look and then decides not to take part. Without this their only
  // remedy is to find an organiser, and at a full Booth Event they are also
  // holding a place somebody else wants.
  //
  // **SCOPED TO `assigned_by='self_enroll'`, AND THAT IS THE LOAD-BEARING
  // DECISION.** A participant an admin ASSIGNED must not be able to remove
  // themselves: that is not self-service, it is undoing someone else's decision,
  // silently, on a cohort the organiser believes is enrolled. If they should not
  // be there, an organiser removes them.
  //
  // **THE SCORE SURVIVES**, and it is worth being precise about WHY, because the
  // obvious explanation is wrong: it is not the absence row. The removal deletes
  // the `competition_users` row and nothing else — `submissions` and
  // `hint_reveals` are simply never touched — so the score is intact on re-join.
  // The absence row does something different and also valuable: it excludes the
  // no-access gap from solve TIME, which is the documented remove+re-add
  // invariant. (Measured: skipping the absence row leaves this route's score
  // assertions green, which is what says the two properties are independent.)
  //
  // Either way, reusing `removeUserFromCompetition` rather than re-implementing
  // the removal is what keeps one definition of it — the session eviction, the
  // pending-reminder purge and the four cache busts all live there.
  //
  // **NO EMAIL.** `sendEmail` is false: that template says access was "removed by
  // an organiser", which is untrue here and alarming to someone who just pressed
  // the button themselves.
  //
  // Refused on an ENDED event — leaving a finished one would mutate a settled
  // result set to no one's benefit — and that is the same predicate `can_leave`
  // is computed from, so the button and the outcome cannot disagree.
  app.post("/api/competitions/:id/leave", requireParticipant, csrfProtection, rateLimit(60_000, 20, "comp-leave"), async (req, res) => {
    const comp = getCompetition(req.params.id);
    if (!comp) return res.status(404).json({ error: "Event not found." });
    const membership = db.prepare("SELECT assigned_by FROM competition_users WHERE competition_id=? AND user_id=?")
      .get(comp.id, req.session.userId);
    if (!membership) return res.status(404).json({ error: "You are not in this event." });
    if (membership.assigned_by !== "self_enroll") {
      return res.status(403).json({
        error: "You were added to this event by an organiser, so only an organiser can remove you.",
        code: "not_self_enrolled",
      });
    }
    if (competitionStatus(comp) === "ended") {
      return res.status(409).json({ error: "This event has finished.", code: "ended" });
    }
    const actor = db.prepare("SELECT email FROM users WHERE id=?").get(req.session.userId)?.email || "self";
    const { removed } = await removeUserFromCompetition(comp, req.session.userId, {
      actor,
      sendEmail: false,
      // Recorded on BOTH events as `via:"self"`, so an organiser reading the
      // participant's History can tell a self-service departure from one they or
      // a colleague performed. Without it the two are indistinguishable.
      reason: isImpersonating(req) ? `self_impersonated_by:${impersonationActor(req.session)}` : "self",
      // v8.1.7 — standing rule 2: a user-driven event carries the actor AND
      // their source IP. This is the one event class a participant may later
      // dispute ("I never left"), and it was the only removal path recording no
      // ip/ua/req_id — the JOIN route above threads reqContext, and the ADMIN
      // removal emits these same two event types inline with it. The helper is
      // request-agnostic (the reconciler drives it too), so the context arrives
      // as a parameter.
      context: reqContext(req),
    });
    if (!removed) return res.status(404).json({ error: "You are not in this event." });
    // v8.1.7 — EVICT OUR OWN SESSION HERE, because the eviction inside
    // removeUserFromCompetition cannot survive this request.
    //
    // `clearCompetitionSessionForUser` updates the STORED session row — and on
    // this path that row is the CALLER'S OWN live session, which express-session
    // re-serialises from memory at end-of-response and overwrites. It is
    // deterministic rather than a race: leave is an authenticated POST and is not
    // on `_SESSION_SLIDE_SKIP`, so the slide middleware already wrote
    // `req.session.slidAt` at request entry, which guarantees the save. The store
    // write was therefore undone every single time — while
    // `competition_session_cleared {cleared:1}` was still recorded on the
    // participant's History, a forensic claim that was simply false — and
    // `/api/status`, which reads `req.session.competitionId` and is NOT
    // membership-gated, kept answering for the event they had just left until the
    // next `GET /api/me` repaired it (a repair whose failure the client swallows).
    //
    // Mutating the in-memory session is what makes the eviction stick, and it does
    // NOT depend on the slide: deleting a field marks the session modified, so
    // express-session saves it whether or not the slide ran. That also makes the
    // recorded `cleared` count true rather than aspirational.
    //
    // Guarded on the id, because the session may legitimately be pointing at a
    // DIFFERENT event — the Leave control sits on the pending page and the route
    // takes the competition in the path, so leaving A while selected into B must
    // not evict B.
    //
    // THIS IS THE ONLY CALLER WHERE THE EVICTED SESSION IS THE REQUEST'S OWN. For
    // the admin DELETE and the reconciler the target's session is a different row
    // that nothing in the request re-saves, so their behaviour is already correct
    // — do not "unify" this into the helper.
    if (req.session.competitionId === comp.id) {
      delete req.session.competitionId;
      delete req.session.timeslotId;
    }
    res.json({ ok: true, competitionId: comp.id });
  });

  app.get("/api/admin/competitions/:id/self-enroll", requireAdmin, rateLimit(60_000, 60, "self-enroll-reveal"), (req, res) => {
    const comp = getCompetition(req.params.id);
    if (!comp) return res.status(404).json({ error: "Event not found" });
    // v8.7.0 — this response SHIPS A SECRET (the 256-bit join token, plus the
    // printed code), which is why it is audited below: whoever holds it can enrol
    // themselves into the event and hand it to anyone else. So the check is here,
    // above everything.
    //
    // Above the LAZY MINTS in particular. Both branches below WRITE — a NULL token
    // or join code is minted on read — so a refusal placed after them would have
    // rotated nothing but would still have stamped a permanent code onto an event
    // this actor has no remit over, and audited a reveal that never happened.
    const denied = competitionDenied(req, req.params.id);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    // Defensive: a row predating the migration with a NULL token (shouldn't
    // happen — the migration back-fills and create mints) gets one minted now.
    let token = comp.self_enroll_token;
    if (!token) {
      token = _genSelfEnrollToken();
      _invalidateCompetitionCache(req.params.id);
      db.prepare("UPDATE competitions SET self_enroll_token=? WHERE id=?").run(token, req.params.id);
    }
    // v8.1.0 (PR 32) — the short code is minted LAZILY here, exactly as the token
    // above is, which is also what backfills every competition created before
    // this release: an operator who opens the Join Link dialog gets one. A
    // migration-time backfill would have to mint a unique value per row inside
    // the boot path and could not retry sensibly on clash.
    let joinCode = comp.join_code;
    if (!joinCode) {
      joinCode = _genJoinCode();
      if (joinCode) {
        _invalidateCompetitionCache(req.params.id);
        // Guarded on still-NULL so two admins opening the dialog at once cannot
        // overwrite each other's code — the loser keeps the winner's, which is
        // the only outcome that leaves the printed sign correct.
        db.prepare("UPDATE competitions SET join_code=? WHERE id=? AND join_code IS NULL").run(joinCode, req.params.id);
        joinCode = db.prepare("SELECT join_code FROM competitions WHERE id=?").get(req.params.id)?.join_code || joinCode;
      }
    }
    // Revealing ships a secret → audit it (stronger than the cxone GET, which
    // never ships the raw key).
    recordCompetitionEvent(req.params.id, "self_enroll_revealed", getAdminIdentity(req), reqContext(req));
    res.json({
      // The code is grouped for PRINTING (`XXX-XXX`), and the raw value ships
      // beside it so the client never has to un-group it to build a URL.
      join_code: joinCode || null,
      join_code_display: joinCode ? formatHumanCode(joinCode, 3) : null,
      enabled: !!comp.self_enroll_enabled,
      token,
      url: `${BASE_URL}/join/${token}`,
      // v8.2.3 — WHERE the code is typed, which the dialog could not say.
      //
      // It printed six characters and nothing else, so the one thing an
      // organiser has to put on the sign beside them — the address to go to —
      // was missing, and "how do I join with the code rather than the link?"
      // was a question the product could not answer from the screen that
      // issues it. This is the server's own BASE_URL rather than the client's
      // `location.origin`: the link beside it is built from BASE_URL too, so a
      // deployment reached through a second hostname would otherwise print an
      // address that disagrees with the QR immediately above it.
      site_url: BASE_URL,
      updated_at: comp.updated_at || null,
    });
  });

  app.post("/api/admin/competitions/:id/self-enroll/regenerate", requireAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
    const comp = getCompetition(req.params.id);
    if (!comp) return res.status(404).json({ error: "Event not found" });
    // v8.7.0 — before the concurrency check and before the transaction, so a
    // refusal rotates nothing. Rotating another organiser's token is destructive
    // in a way an admin refusal usually is not: every printed QR code, short join
    // code (v8.13.3) and pending stored join token for that event dies at once,
    // mid-event, with nothing on their screen to explain it.
    // v8.12.0 — a competitor may not rotate the join link of the event they compete in.
    { const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), comp.id)); if (_cmp) return _cmp; }
    const denied = competitionDenied(req, req.params.id);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    // Optimistic-concurrency — reuse the PUT contract so two admins rotating in
    // parallel don't silently clobber; the loser gets 409, reloads, retries.
    // v8.13.3 — `?.`: Express 5 leaves req.body undefined for a body-less POST,
    // which threw here as a 500. An absent body is "no expectation", as on the PUT.
    const _expected = req.body?.expectedUpdatedAt;
    if (_expected && comp.updated_at && _expected !== comp.updated_at) {
      return res.status(409).json({
        error: "This event was modified by another admin since you opened it. Reload to see the latest values, then retry.",
        conflict: true,
        currentUpdatedAt: comp.updated_at,
      });
    }
    const adminId = getAdminIdentity(req);
    const newToken = _genSelfEnrollToken();
    const _now = now().toISOString();
    // v8.13.3 — the printed short code is rotated WITH the token. It is a join
    // capability too (competitions-drift: "like self_enroll_token", never
    // exported, scrubbed from the access log), and the code lookup answers with
    // the CURRENT token — so rotating the token alone left a leaked code
    // admitting people, to the NEW link, with no way to retire it: switching
    // self-enrolment off only pauses it, and switching it back on revives the
    // same code. The QR printed beside the code dies on every regenerate anyway,
    // so the sign is reprinted regardless.
    //
    // Minted OUTSIDE the transaction, which stays WRITE-FIRST: the mint is a
    // SELECT, and a DEFERRED transaction that reads before it writes fails
    // SQLITE_BUSY at once under another process's write lock instead of waiting
    // busy_timeout (CLAUDE.md, "The driver" — measured 1 ms vs 404 ms). The
    // handler has no await, so the free-check and the write still cannot
    // interleave with another request in this single process; the partial
    // unique index is the backstop, and a clash fails closed (nothing rotates,
    // generic 500). A null mint (eight collisions — practically unreachable)
    // stores NULL: the OLD code still dies, and the reveal's lazy mint gives the
    // event a new one the next time the dialog opens.
    const newCode = _genJoinCode();
    const regenTxn = db.transaction(() => {
      _invalidateCompetitionCache(req.params.id);
      db.prepare("UPDATE competitions SET self_enroll_token=?, join_code=?, updated_at=? WHERE id=?").run(newToken, newCode, _now, req.params.id);
      // Sweep #391 — every sign-in code and new-address code already emailed
      // through the replaced link stops joining anyone (lib/self-enroll.js
      // `untieJoinLinkBindings`), in this write, counted on its record.
      const joinLinkUntied = untieJoinLinkBindings(req.params.id);
      // Field NAMES only, never the old or new code: both reach disk here and in
      // the app.jsonl mirror, which a regular admin reads through Logs.
      recordCompetitionEvent(req.params.id, "self_enroll_regenerated", adminId, { ...reqContext(req), rotated: ["link", "join_code"], join_link_untied: joinLinkUntied });
    });
    runTxnWithMirrorBuffer(() => regenTxn());
    res.json({
      ok: true,
      token: newToken,
      url: `${BASE_URL}/join/${newToken}`,
      join_code: newCode || null,
      join_code_display: newCode ? formatHumanCode(newCode, 3) : null,
      updated_at: _now,
    });
  });
};
