"use strict";

// Leaderboard routes — participant (top-N + my-rank) and admin (uncapped).
// (v7.0.0 refactor: route split extracted from server.js.)

const db = require("../db");
const { requireParticipant, requireCompetitionContext, requireParticipantInCompetition, requireAdmin, rateLimit } = require("../lib/middleware");
const { buildLeaderboard, buildAdminLeaderboard, buildGroupLeaderboard, buildLateLeaderboard, ADMIN_PENALTY_FIELDS } = require("../lib/leaderboard");
const { getCompetition, getTimeslot, competitionFullyEnded, isDryRunCompetition, participantAttempted } = require("../lib/competitions");
const { eventPolicyForWire } = require("../lib/event-policy"); // v8.1.0 (PR 18)
const { competitionDenied } = require("../lib/event-admin"); // v8.7.0

// v7.11.0 — mark the viewer's own row(s) in the group board (their solo row and/or
// the group they belong to) + resolve their "me" entry (solo preferred) from the
// FULL list so an out-of-cap caller still sees their team's placement.
function _participantGroupBoard(fullBoard, compId, viewerId, cap) {
  if (!fullBoard || !fullBoard.length) return null;
  const myGroupIds = new Set(db.prepare(
    "SELECT cg.group_id FROM competition_groups cg JOIN group_members gm ON gm.group_id=cg.group_id WHERE cg.competition_id=? AND gm.user_id=?"
  ).all(compId, viewerId).map(r => r.group_id));
  // Strip `memberCount` from the PARTICIPANT board: summing group sizes across a
  // non-truncated board would reveal the total participant count, breaking the
  // competition-fairness invariant (v6.14.2). The admin board keeps it. (The key
  // name would also trip the /count/ leak-scan guard.)
  //
  // v7.28.0 — and strip the ADMIN-ONLY penalty columns for the same reason. They
  // live on the group row under public names because they are FROZEN into
  // `group_leaderboard_snapshots` alongside the score, so this route is the one
  // place they are withheld — hence reading `ADMIN_PENALTY_FIELDS` rather than
  // re-listing them. How many wrong answers a rival team made is not something
  // to hand a competitor mid-competition.
  const marked = fullBoard.map(({ memberCount, ...e }) => {
    for (const f of ADMIN_PENALTY_FIELDS) delete e[f];
    return {
      ...e,
      mine: (e.type === "individual" && e.userId === viewerId) || (e.type === "group" && myGroupIds.has(e.groupId)),
    };
  });
  const me = marked.find(e => e.mine && e.type === "individual") || marked.find(e => e.mine) || null;
  return { board: marked.slice(0, cap), me, board_limit: cap };
}

const PARTICIPANT_LEADERBOARD_BOARD_LIMIT = 20;

module.exports = function register(app) {
  app.get("/api/leaderboard", requireParticipant, requireCompetitionContext, requireParticipantInCompetition, rateLimit(60_000, 120, "leaderboard"), (req, res) => {
    const compId = req.session.competitionId;
    const comp = req.competition;
    // v8.1.0 (PR 18) — an unranked kind answers 200 WITH AN EMPTY BOARD, never a
    // 4xx, and that is a correctness requirement rather than politeness.
    // features/leaderboard.js treats a considered non-ok as lost access and calls
    // ejectToCompetitionPicker("You are no longer in this competition.") — so a
    // 403 here would throw a participant out of an OPEN Program with a false
    // explanation. `ranking_enabled` is the key the client branches on; the
    // envelope keeps every key it already had so nothing downstream reads
    // undefined.
    if (!eventPolicyForWire(comp).ranking_enabled) {
      return res.json({
        ranking_enabled: false,
        top3: [], board: [], me: null, groupBoard: null, lateBoard: null,
        leaderboard_mode: comp.leaderboard_mode || "per_slot",
        timeslot_id: null,
        board_limit: PARTICIPANT_LEADERBOARD_BOARD_LIMIT,
        ended: competitionFullyEnded(comp),
        canShareBadge: false,
        placementCertificates: false,
      });
    }
    // For per-slot leaderboard mode, use the participant's chosen timeslot
    const tsId = (comp.leaderboard_mode === "per_slot") ? (req.session.timeslotId || null) : null;
    const fullBoard = buildLeaderboard(compId, tsId);
    // Resolve `me` BEFORE truncation so an out-of-top-20 caller still sees
    // their real rank. fullBoard is sorted with a userId tie-break so the
    // rank is byte-stable across requests.
    const me = fullBoard.find(u => u.userId === req.session.userId) || null;
    const board = fullBoard.slice(0, PARTICIPANT_LEADERBOARD_BOARD_LIMIT);
    const ended = competitionFullyEnded(comp);
    // v7.6.x — authoritative badge-share eligibility for THIS viewer so the SPA
    // shows the CTA only when the mint endpoint would actually succeed: the comp
    // must be fully ended + non-internal, the caller must be on the leaderboard
    // (excludes staff/benchmark), and a non-top-3 caller must have ATTEMPTED
    // (≥1 submission/hint). Top-3 skip the attempt query. The mint route re-checks
    // all of this server-side; this flag is purely to gate the UI affordance.
    // v8.6.0 — the LATE-ENTRANT section, under exactly the viewing rules the main
    // board has: the same 20-row cap, `me` resolved BEFORE truncation so an
    // out-of-cap late entrant still sees their true rank without learning the size
    // of the field, and no count of any kind on the wire. `null` when the event
    // runs no late window or nobody arrived late, which the client reads as "render
    // nothing" — the shape `groupBoard` already uses.
    const _lateFull = buildLateLeaderboard(compId, tsId);
    const lateBoard = _lateFull.length ? {
      board: _lateFull.slice(0, PARTICIPANT_LEADERBOARD_BOARD_LIMIT).map(u => ({ ...u, mine: u.userId === req.session.userId })),
      me: _lateFull.find(u => u.userId === req.session.userId) || null,
      board_limit: PARTICIPANT_LEADERBOARD_BOARD_LIMIT,
    } : null;
    let canShareBadge = false;
    // v8.6.0 — A LATE ENTRANT IS NOT ON `fullBoard`, so `me` is null for them and
    // the CTA would be withheld from the one participant still playing. Their rank
    // comes from the late board, which is also the rank their certificate is issued
    // against.
    //
    // WHILE THE WINDOW IS OPEN they may mint a PARTICIPATION certificate only — a
    // placement is not knowable until their board is final, which is exactly the
    // rule `_mintEligibility` has always enforced for everybody, applied to the
    // board that is still moving. So the placement short-circuit is skipped for
    // them and eligibility rests on having attempted, which is what a participation
    // certificate attests. Once the window closes they take the ordinary path.
    const _lateMe = lateBoard ? lateBoard.me : null;
    const _meAnyBoard = me || _lateMe;
    if (ended && _meAnyBoard && !isDryRunCompetition(compId)) {
      // Mirrors `_mintEligibility`: an attempt is required for every basis. A
      // placement also needs points above zero (operator ruling, 14 Nov 2026),
      // which decides the certificate's KIND, not whether one is offered.
      canShareBadge = participantAttempted(req.session.userId, compId);
    }
    // v7.11.0 — group-level board (present only when ≥1 group is bound to the comp).
    // Same timeslot scoping + top-N cap + me-resolution as the individual board.
    const groupBoard = _participantGroupBoard(
      buildGroupLeaderboard(compId, tsId), compId, req.session.userId, PARTICIPANT_LEADERBOARD_BOARD_LIMIT
    );
    res.json({
      // v8.1.0 (PR 18) — present on BOTH branches, so a client never has to treat
      // an absent key as "probably ranked".
      ranking_enabled: true,
      top3: fullBoard.slice(0, 3),
      board,
      me,
      groupBoard,
      lateBoard,
      // v8.6.0 — WHY the CTA reads the way it does, so the client can say it rather
      // than infer it. A late entrant inside an open window is offered a
      // participation certificate and told when the placement one is issued; the
      // affordance and its explanation move together (v7.14.2).
      lateEntrantMe: !!(req.lateEntry && req.lateEntry.isLate),
      lateWindowOpen: !!(req.lateEntry && req.lateEntry.open),
      lateDeadline: (req.lateEntry && req.lateEntry.deadline) ? req.lateEntry.deadline.toISOString() : null,
      leaderboard_mode: comp.leaderboard_mode || "per_slot",
      timeslot_id: tsId || null,
      board_limit: PARTICIPANT_LEADERBOARD_BOARD_LIMIT,
      // v7.1.0 — authoritative "is this competition fully ended" flag so the
      // SPA can show the LinkedIn share-badge CTA (which the mint endpoint
      // also re-checks server-side).
      ended,
      // v7.6.x — is THIS viewer eligible to mint a share badge (placement or
      // participation)? Drives whether the CTA renders at all.
      canShareBadge,
      // Whether this event issues certificates at all: a dry run never mints
      // (`isDryRunCompetition`), so the podium names no certificate tier there.
      placementCertificates: !isDryRunCompetition(compId),
    });
  });

  app.get("/api/admin/leaderboard", requireAdmin, (req, res) => {
    const competitionId = req.query.competitionId;
    const timeslotId = req.query.timeslotId || null;
    if (!competitionId) return res.status(400).json({ error: "competitionId query parameter is required" });
    const comp = getCompetition(competitionId);
    if (!comp) return res.status(404).json({ error: "Event not found" });
    // v8.7.0 — a NAMED event is REFUSED, never narrowed. This route takes a single
    // REQUIRED competitionId and has no platform-wide mode to filter, so an
    // out-of-scope id has no honest empty answer: `[]` here would read as "nobody
    // has scored yet" for an event this actor has no remit over.
    //
    // The Rankings pane's no-focus view ("every live event I can see") is one
    // request PER competition, and the list it iterates comes from
    // GET /api/admin/competitions, which is already narrowed to the actor's
    // scope — so that view is scoped by this check plus that list, and there is
    // deliberately no second definition of "which events" here.
    const denied = competitionDenied(req, competitionId);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    // For per-slot mode, use the requested timeslotId
    const tsId = (comp.leaderboard_mode === "per_slot") ? timeslotId : null;
    // v8.13.3 — THE SLOT MUST BE THIS EVENT'S. This route used to say the timeslot
    // "needs no check of its own" because an out-of-scope slot is unreachable once
    // the parent is — true of SCOPE, and the premise a caller-named slot broke: any
    // string reached the builders, and with ?groups=1 on a fully-ended event the
    // lazy freeze PERSISTED an empty board under that spelling — under the official
    // GLOBAL key for `__global__` (lib/leaderboard.js buildGroupLeaderboard, which
    // now refuses such a slot itself as defence in depth). A slot that is not this
    // competition's is a 404, the analytics route's answer to the same question,
    // asked after the scope check so an event admin learns nothing about a
    // competition outside their events. Only consulted where the slot is USED
    // (per_slot); a global-mode board ignores it, exactly as before.
    if (tsId != null) {
      const _ts = getTimeslot(tsId);
      if (!_ts || _ts.competition_id !== comp.id) return res.status(404).json({ error: "Session not found in this event" });
    }
    // v8.1.0 (PR 18) — the ADMIN board gets the same gate, and it had none at all.
    // It is the surface most likely to grow a new consumer (four identity columns
    // in v7.22.0, five penalty columns in v7.28.0), so an unranked kind must answer
    // an empty board here too rather than computing standings nothing may render.
    // The shape is preserved exactly — a bare array — because every existing
    // consumer indexes it.
    if (!eventPolicyForWire(comp).ranking_enabled) return res.json([]);
    // v7.11.0 — `?groups=1` returns the UNCAPPED group-level board (group averages +
    // solo individuals) instead of the individual board. Default (no param) keeps
    // the original individual-board array shape, so existing consumers are unchanged.
    if (req.query.groups === "1") {
      return res.json(buildGroupLeaderboard(competitionId, tsId) || []);
    }
    res.json(buildAdminLeaderboard(competitionId, tsId));
  });
};
