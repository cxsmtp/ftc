"use strict";

// Session (timeslot) routes: list / create / edit / delete / end-now.
// allParticipantsSolvedAll stays in server.js (test-pinned) and is injected via
// register(app, { allParticipantsSolvedAll }). (v7.0.0 refactor: route split.)

const { v4: uuid } = require("uuid");
const db = require("../db");
const { validateBody, allOptional } = require("../lib/validate");
const { BULK_ADMIN_MAX } = require("../lib/config");
const { destructiveAdminLimit, requireAdmin, csrfProtection } = require("../lib/middleware");
const { eventPolicy, eventKindPhrase, autoEndOnAllSolvedApplies } = require("../lib/event-policy"); // v7.29.0
const {
  scheduledEnd,
  getCompetition, getTimeslot, getCompetitionTimeslots, timeslotStatus, timeslotEffectiveEnd,
  competitionEffectiveEnd, competitionFullyEnded, _invalidateCompetitionCache, publishedTaskCount, scoringParticipantIds,
} = require("../lib/competitions");
const { competitionDenied, competitorIds } = require("../lib/event-admin"); // v8.7.0
const { competitorEditDenied, refuseCompetitor } = require("../lib/staff-compete"); // v8.12.0
const { recordTimeslotEvent, recordCompetitionEvent, getAdminIdentity, runTxnWithMirrorBuffer, reqContext } = require("../lib/audit");
const { swallowed } = require("../lib/best-effort");
const { _resyncStatusObservationAfterRevive } = require("../lib/scheduler");
const { invalidateLeaderboardCache, invalidateGroupLeaderboardSnapshot, freezeGroupLeaderboardSnapshots } = require("../lib/leaderboard");
const { enqueueCertificateDispatch } = require("../lib/certificate-dispatch"); // v8.15.1
const { reconcileCompetitionMembership } = require("../lib/group-sync");
const { sanitiseForLog, log } = require("../lib/log");
const { now } = require("../lib/time");
// batch 7 — boundary schema (lib/validate.js); one source of truth for the
// timeslot create + edit field-shape validation (create/edit can't drift).
const SESSION_FIELD_SCHEMA = {
  name: { type: "string", required: true, max: 120, label: "Session name" },
  start_time: { type: "date", required: true, label: "Start time" },
  duration_minutes: { type: "int", required: true, min: 1, max: 525600, label: "Duration" },
};

module.exports = function register(app, { allParticipantsSolvedAll }) {
  app.get("/api/admin/competitions/:id/timeslots", requireAdmin, (req, res) => {
    const comp = getCompetition(req.params.id);
    if (!comp) return res.status(404).json({ error: "Event not found" });
    // v8.7.0 — every route in this file hangs off a competition, so the parent IS
    // the named entity and an out-of-scope one is refused rather than answered.
    // It sits ABOVE the timeslot lookup deliberately: refusing first means an
    // actor cannot probe which session ids exist inside somebody else's event.
    const denied = competitionDenied(req, comp.id);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    const slots = getCompetitionTimeslots(comp.id).map(ts => ({
      ...ts, status: timeslotStatus(ts), effective_end: timeslotEffectiveEnd(ts)?.toISOString() || null,
    }));
    res.json(slots);
  });

  app.post("/api/admin/competitions/:id/timeslots", requireAdmin, csrfProtection, (req, res) => {
    const comp = getCompetition(req.params.id);
    if (!comp) return res.status(404).json({ error: "Event not found" });
    // v8.7.0 — the parent event decides; refused above the timeslot lookup and
    // every write below it.
    // v8.12.0 — a competitor may not touch the event they compete in (see routes/competitions.js PUT).
    { const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), comp.id)); if (_cmp) return _cmp; }
    const denied = competitionDenied(req, comp.id);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    // v7.16.0 — trusted network IPs are a SINGLE-SESSION-only setting, so adding
    // a session to a competition that carries them would leave a rate-limit
    // bypass attached to a shape it was never validated for. Refuse, and name
    // the remedy — silently dropping a security setting is worse than an error.
    if (comp.trusted_network_ips && String(comp.trusted_network_ips).trim()) {
      return res.status(400).json({
        error: "This event has trusted network IPs set, which is only supported for a single-session event. Clear the trusted networks first, then add sessions.",
      });
    }
    // v7.29.0 — a kind whose policy forbids sessions has NONE, and that is
    // enforced from BOTH ends: here, and by the kind being immutable after
    // create. Guarding one side only would let an admin reach the forbidden
    // state by reordering — create as a tournament, add a session, change kind.
    //
    // This is what makes "zero sessions" a THEOREM rather than a convention, and
    // it is the single largest piece of work the redesign avoids: eleven existing
    // single-slot code paths then serve two of the three kinds with no new code.
    if (eventPolicy(comp).sessions === "forbidden") {
      return res.status(400).json({
        error: `Sessions cannot be added to ${eventKindPhrase(comp)} — it always runs as a single session.`,
        code: "sessions_forbidden",
      });
    }
    // v6.16.17 — block adding timeslots to an explicitly-ended competition. The
    // check uses comp.ended_at directly (not competitionStatus) so a multi-slot
    // comp under construction can still add sessions even when an earlier slot
    // is already time-arithmetic-ended — the legitimate "build out the sessions
    // list" workflow.
    if (comp.ended_at) {
      return res.status(400).json({ error: "Cannot add a session to an ended event. Edit the event's start time / duration to revive it first." });
    }
    // batch 7 — boundary validation: `name` trimmed, `start_time` normalized ISO,
    // `duration_minutes` int [1,525600]. Replaces the hand-rolled batch-3/4/5 checks.
    const _v = validateBody(req.body, SESSION_FIELD_SCHEMA);
    if (_v.error) return res.status(400).json({ error: _v.error });
    const { name, start_time, duration_minutes } = _v.values;
    const dur = duration_minutes;
    // Enforce unique session name within this competition (name is trimmed)
    if (db.prepare("SELECT 1 FROM competition_timeslots WHERE competition_id=? AND LOWER(name)=LOWER(?)").get(comp.id, name)) {
      return res.status(409).json({ error: "A session with this name already exists in this event." });
    }
    // Block adding timeslots if any submissions already exist (race condition #3)
    const hasSubs = db.prepare("SELECT 1 FROM submissions WHERE competition_id=? LIMIT 1").get(comp.id);
    if (hasSubs) return res.status(400).json({ error: "Cannot add sessions after submissions have been made. Create a new event instead." });
    const id = uuid();
    const adminId = getAdminIdentity(req);
    const tsCreateTxn = db.transaction(() => {
      const tsNow = now().toISOString();
      db.prepare("INSERT INTO competition_timeslots (id, competition_id, name, start_time, duration_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(id, comp.id, name, start_time, dur, tsNow, tsNow);
      db.prepare("UPDATE competitions SET updated_at=? WHERE id=?").run(tsNow, comp.id);
      // audit v7.7.37 (C7) — once this comp has a timeslot, its competition-level
      // start time is no longer the participant-facing start, so purge pending
      // comp-level reminders (timeslot_id NULL/'') that would otherwise fire an
      // "starts in ~1 hour" mail at the now-meaningless single-slot start. Idempotent
      // on later adds; slot-scoped reminders are untouched.
      db.prepare("DELETE FROM email_reminders WHERE competition_id=? AND (timeslot_id IS NULL OR timeslot_id='') AND sent=0").run(comp.id);
      recordTimeslotEvent(id, "created", adminId, { name, start_time, duration_minutes: dur, ...reqContext(req) });
      recordCompetitionEvent(comp.id, "timeslot_added", adminId, { timeslot_id: id, name, ...reqContext(req) });
    });
    runTxnWithMirrorBuffer(() => tsCreateTxn());
    // The txn bumped competitions.updated_at; bust the 1s comp-cache so a
    // concurrent stale PUT /competitions/:id is correctly rejected (409)
    // instead of passing the expectedUpdatedAt check against a cached old value.
    _invalidateCompetitionCache(comp.id);
    const ts = getTimeslot(id);
    res.json({ ok: true, timeslot: { ...ts, status: timeslotStatus(ts), effective_end: timeslotEffectiveEnd(ts)?.toISOString() || null } });
  });

  app.put("/api/admin/competitions/:id/timeslots/:tsId", requireAdmin, csrfProtection, (req, res) => {
    const comp = getCompetition(req.params.id);
    if (!comp) return res.status(404).json({ error: "Event not found" });
    // v8.7.0 — the parent event decides; refused above the timeslot lookup and
    // every write below it.
    // v8.12.0 — a competitor may not touch the event they compete in (see routes/competitions.js PUT).
    { const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), comp.id)); if (_cmp) return _cmp; }
    const denied = competitionDenied(req, comp.id);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    const ts = getTimeslot(req.params.tsId);
    if (!ts || ts.competition_id !== comp.id) return res.status(404).json({ error: "Session not found" });
    // Capture the competition's effective end BEFORE this edit so we can emit a
    // roll-up event afterward when the overall end shifts (v6.2.7).
    const _prevEffectiveEnd = competitionEffectiveEnd(comp);
    const status = timeslotStatus(ts);
    // batch 7 — boundary validation (edit = create schema, all fields optional).
    // `name` trimmed, `start_time` normalized ISO, `duration_minutes` int
    // [1,525600]; absent fields omitted (COALESCE leaves the column unchanged).
    const _v = validateBody(req.body, allOptional(SESSION_FIELD_SCHEMA));
    if (_v.error) return res.status(400).json({ error: _v.error });
    const { name, start_time, duration_minutes } = _v.values;
    // Start time locked once started (rule #1 — applies even for superadmin)
    if ((status === "live" || status === "ended") && start_time != null) {
      return res.status(400).json({ error: "Cannot change the start time of a started session" });
    }
    if (status === "ended") {
      // Ended sessions with end time in the past: only superadmin can edit
      const effEnd = timeslotEffectiveEnd(ts);
      if (effEnd && effEnd <= now() && !req.session.isSuperAdmin) {
        return res.status(403).json({ error: "Only superadmin can edit ended sessions whose end time has passed" });
      }
      if (name != null && name !== ts.name) return res.status(400).json({ error: "Cannot change the name of an ended session" });
    }
    // Enforce unique session name within this competition (name is trimmed)
    if (name != null && name.toLowerCase() !== ts.name.toLowerCase()) {
      if (db.prepare("SELECT 1 FROM competition_timeslots WHERE competition_id=? AND LOWER(name)=LOWER(?) AND id!=?").get(comp.id, name, ts.id)) {
        return res.status(409).json({ error: "A session with this name already exists in this event." });
      }
    }
    if (req.body.expectedUpdatedAt && ts.updated_at && req.body.expectedUpdatedAt !== ts.updated_at) {
      return res.status(409).json({
        error: "This session was modified by another admin since you opened it. Reload to see the latest values, then retry.",
        conflict: true,
        currentUpdatedAt: ts.updated_at,
      });
    }
    const adminId = getAdminIdentity(req);
    const nowIso = now().toISOString();
    const tsChanges = {};
    if (name != null && name !== ts.name) tsChanges.name = { from: ts.name, to: name };
    if (start_time != null && start_time !== ts.start_time) tsChanges.start_time = { from: ts.start_time, to: start_time };
    if (duration_minutes != null && duration_minutes !== ts.duration_minutes) tsChanges.duration_minutes = { from: ts.duration_minutes, to: duration_minutes };
    const tsEditTxn = db.transaction(() => {
      db.prepare("UPDATE competition_timeslots SET name=COALESCE(?,name), start_time=COALESCE(?,start_time), duration_minutes=COALESCE(?,duration_minutes), updated_at=? WHERE id=?")
        // batch 7 — all three are validated + normalized by validateBody (name
        // trimmed, start_time ISO, duration int); null ⇒ COALESCE keeps the value.
        .run(name ?? null, start_time ?? null, duration_minutes ?? null, nowIso, ts.id);
      // v6.8.2 — when a multi-slot timeslot's start_time moves, move the pending
      // reminder rows for that timeslot with it.
      if (tsChanges.start_time) {
        const newSendAt = new Date(new Date(tsChanges.start_time.to).getTime() - 60 * 60 * 1000).toISOString();
        db.prepare("UPDATE email_reminders SET send_at=? WHERE competition_id=? AND timeslot_id=? AND sent=0")
          .run(newSendAt, comp.id, ts.id);
      }
      if (Object.keys(tsChanges).length) {
        recordTimeslotEvent(ts.id, "edited", adminId, { changes: tsChanges, ...reqContext(req) });
        // v6.20.x — bump the PARENT competition's updated_at too (a timeslot
        // duration/start edit shifts competitionEffectiveEnd → optimistic-
        // concurrency invariant requires a concurrent stale comp-PUT to 409).
        db.prepare("UPDATE competitions SET updated_at=? WHERE id=?").run(nowIso, comp.id);
      }
      // v8.1.7 — duration-shrink-to-past detector: the SESSION twin of the
      // competition-level one (routes/competitions.js, v6.16.6).
      //
      // Shrinking a LIVE session's duration so `start + duration < now()` ends
      // it by time arithmetic alone. Pre-fix `ended_at` stayed NULL and
      // `ended_manually` stayed 0, so the scheduler's next tick (≤60 s) saw a
      // live→ended transition and emitted a SYSTEM-attributed `auto_ended`
      // carrying a `scheduled_end` — and the edit form then described the
      // session as having ended when its scheduled time elapsed. The operator's
      // deliberate decision survived only as an `edited` event, so an
      // investigator reconstructing why the session ended was told the clock had
      // done it, while the identical action on a single-session competition was
      // correctly recorded as a manual end. The scheduler re-reads
      // `ended_manually` immediately before that emit (v6.16.10), so stamping it
      // here is precisely what withdraws the false claim.
      //
      // Emitted IN THIS TXN so the duration UPDATE, the `ended_at` stamp and the
      // audit row commit atomically — same reason as the competition twin.
      //
      // Unlike that twin there is no start_time term: a started session's start
      // is immutable (refused ~60 lines above), so on the only branch this runs
      // for, `ts.start_time` IS the stored value.
      if (tsChanges.duration_minutes && status === "live") {
        const _newEnd = scheduledEnd({ start_time: ts.start_time, duration_minutes: tsChanges.duration_minutes.to });
        if (_newEnd <= now()) {
          // `AND ended_at IS NULL` and the `r.changes` gate mirror the end-now
          // route below rather than the competition twin, which emits
          // unconditionally. This is the local idiom — and it is DEFENCE IN
          // DEPTH, not something the tests exercise: no path writes a FUTURE
          // `ended_at`, so a session reading `live` never carries one, and
          // removing the guard changes nothing observable today.
          const r = db.prepare("UPDATE competition_timeslots SET ended_at=?, ended_manually=1 WHERE id=? AND ended_at IS NULL")
            .run(nowIso, ts.id);
          if (r.changes > 0) {
            recordTimeslotEvent(ts.id, "ended_manually", adminId, {
              via: "duration_shrink", duration_minutes: tsChanges.duration_minutes.to, ...reqContext(req),
            });
          }
        }
      }
    });
    // runTxnWithMirrorBuffer (ext-audit F4): the recordTimeslotEvent("edited")
    // emit is followed by further writes inside the same txn — the parent-comp
    // updated_at bump, and now the shrink detector's own ended_at UPDATE and its
    // "ended_manually" emit — so a rollback past either emit would strand a
    // ghost app.jsonl mirror line.
    runTxnWithMirrorBuffer(() => tsEditTxn());
    _invalidateCompetitionCache(comp.id); // bumped comp.updated_at → bust cache (concurrency invariant)
    // If duration was extended and new end is in the future, attempt to revive the session
    const updated = getTimeslot(ts.id);
    let revived = false, allSolved = false;
    // v8.1.9 — the same rule as the single-slot twin: this comment has always said
    // "if duration was extended", and the gate never checked that it had been.
    // `end-now` stores `Math.ceil(elapsed / 60_000)`, so for up to a minute after
    // a session is closed its derived end sits in the future and ANY save of the
    // session form reopened it — a rename, a timezone correction, or Save with
    // nothing changed. An unchanged schedule is not a deliberate extension.
    const _tsScheduleMoved = !!(tsChanges.start_time || tsChanges.duration_minutes);
    if (status === "ended" && updated) {
      const newEnd = scheduledEnd(updated);
      if (_tsScheduleMoved && newEnd > now() && updated.ended_at) {
        // Exception: don't revive auto-ended sessions where all participants solved all tasks
        // v7.7.18 — but DO revive (skip the all-solved gate) when the parent
        // competition has self-enrollment open: a self-enroll comp/slot must never
        // be stuck in an all-solved-ended state (more participants can still join).
        // v8.3.11 — and skip it when the parent event cannot auto-end on
        // all-solved at all (the kind forbids it, or the column is off). Same rule
        // as the single-slot twin, same reason: a gate that refuses to reopen an
        // AUTO-ended entity has nothing to protect where the auto-end could never
        // have fired. Read from `comp`, because the column and the kind are both
        // the competition's; a slot inherits the decision.
        if (!updated.ended_manually && !comp.self_enroll_enabled && autoEndOnAllSolvedApplies(comp)) {
          // v7.21.13 — shared with the single-slot revive gate and the auto-end
          // scan (see lib/competitions.js). The ONLY difference between this
          // gate and its competition-level twin is the timeslot scoping, which
          // is now the one argument rather than a second copy of the SQL.
          const totalTasks = publishedTaskCount(comp.id);
          const participants = scoringParticipantIds(comp.id, ts.id);
          if (totalTasks > 0 && participants.length > 0) {
            allSolved = allParticipantsSolvedAll(participants, comp.id, totalTasks);
          }
        }
        if (!allSolved) {
          _invalidateCompetitionCache(comp.id);
          const tsReviveTxn = db.transaction(() => {
            db.prepare("UPDATE competition_timeslots SET ended_at=NULL, ended_manually=0, updated_at=? WHERE id=?").run(nowIso, ts.id);
            recordTimeslotEvent(ts.id, "revived", adminId, { via: "duration_edit", ...reqContext(req) });
            _resyncStatusObservationAfterRevive("timeslot", ts.id);
            if (comp.ended_at) {
              db.prepare("UPDATE competitions SET ended_at=NULL, ended_manually=0, updated_at=? WHERE id=?").run(nowIso, comp.id);
              recordCompetitionEvent(comp.id, "revived", adminId, { via: "timeslot_revival", timeslot_id: ts.id, ...reqContext(req) });
              _resyncStatusObservationAfterRevive("competition", comp.id);
            } else {
              db.prepare("UPDATE competitions SET updated_at=? WHERE id=?").run(nowIso, comp.id);
            }
          });
          // Buffer the audit mirror — the emit is followed by further DB writes
          // (resync / parent-comp UPDATE), so a rollback after the emit must not
          // leak a ghost `revived` line into app.jsonl (CLAUDE.md invariant).
          runTxnWithMirrorBuffer(() => tsReviveTxn());
          revived = true;
          // v6.11.0: drop the leaderboard cache so the next read rebuilds under
          // the live branch (nowMs - login) instead of the stale frozen branch.
          invalidateLeaderboardCache(comp.id);
          // v7.12.3 (audit M4) — a revived slot means the comp is no longer fully
          // ended, so drop any frozen group-leaderboard snapshot (recomputes on re-end).
          invalidateGroupLeaderboardSnapshot(comp.id);
          // concurrency-cache audit (#8): reconcileCompetitionMembership early-
          // returns on ended comps, so bound-group membership changes made while
          // this session/comp was ended were skipped. Now that it's revived,
          // re-converge it to its bound groups. Fire-and-forget — the revive
          // response doesn't depend on the membership sync; getCompetition() is
          // read post-txn (cache was busted at line ~158) so it sees live state.
          reconcileCompetitionMembership(getCompetition(comp.id), { actor: adminId, context: reqContext(req) }).catch((e) => swallowed("sessions:group-reconcile", e, { level: "warn" }));
          log.info({ ...reqContext(req), competition_id: comp.id, competition_name: sanitiseForLog(comp.name), timeslot_id: ts.id, timeslot_name: sanitiseForLog(ts.name), actor: sanitiseForLog(adminId), via: "duration_edit" }, "Session revived");
        }
      } else if (newEnd > now() && !updated.ended_at) {
        // audit v7.7.37 (C11) — a TIME-EXPIRED timeslot (ended_at NULL) revived by
        // extending its duration flips ended→live via time arithmetic but leaves its
        // scheduler observation 'ended' forever (no auto_started for the revived
        // window, no auto_ended next time). Re-arm it — nothing to clear, no event.
        try { _resyncStatusObservationAfterRevive("timeslot", ts.id); } catch (e) { swallowed("sessions:revive-status-resync", e); }
        // v7.12.3 (audit M4) — the slot flipped ended→live, so the comp is no longer
        // fully ended; drop any frozen group-leaderboard snapshot.
        invalidateGroupLeaderboardSnapshot(comp.id);
      }
    }
    const final = revived ? getTimeslot(ts.id) : updated;
    // Competition-level roll-up (v6.2.7): if this timeslot edit shifted the
    // competition's effective end, record a competition-scope event with
    // from/to timestamps + the via_timeslot context.
    try {
      const _nextEffectiveEnd = competitionEffectiveEnd(getCompetition(comp.id));
      const prevMs = _prevEffectiveEnd ? _prevEffectiveEnd.getTime() : null;
      const nextMs = _nextEffectiveEnd ? _nextEffectiveEnd.getTime() : null;
      if (prevMs !== nextMs && Object.keys(tsChanges).length) {
        recordCompetitionEvent(comp.id, "effective_end_shifted", adminId, {
          from: _prevEffectiveEnd ? _prevEffectiveEnd.toISOString() : null,
          to:   _nextEffectiveEnd ? _nextEffectiveEnd.toISOString() : null,
          via_timeslot_id:   ts.id,
          via_timeslot_name: ts.name,
          timeslot_changes:  tsChanges,
          ...reqContext(req),
        });
      }
    } catch (e) {
      // best-effort — primary edit already succeeded
      swallowed("sessions:edit-audit", e);
    }
    // ext-audit v7.15.7 — a slot edit (duration shrink / start move) can be what
    // makes the COMPETITION fully ended; freeze the team board here as well as
    // on the explicit slot end-now. No-op unless the comp is now fully ended,
    // and INSERT-OR-IGNORE, so the revive path above (which deletes snapshots)
    // still wins when this edit revived rather than ended it.
    if (!revived) { freezeGroupLeaderboardSnapshots(comp.id); enqueueCertificateDispatch(comp.id, { reason: "ended" }); }   // v8.15.1
    res.json({ ok: true, timeslot: { ...final, status: timeslotStatus(final), effective_end: timeslotEffectiveEnd(final)?.toISOString() || null }, revived, allSolved });
  });

  app.delete("/api/admin/competitions/:id/timeslots/:tsId", requireAdmin, csrfProtection, (req, res) => {
    const comp = getCompetition(req.params.id);
    if (!comp) return res.status(404).json({ error: "Event not found" });
    // v8.7.0 — the parent event decides; refused above the timeslot lookup and
    // every write below it.
    // v8.12.0 — a competitor may not touch the event they compete in (see routes/competitions.js PUT).
    { const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), comp.id)); if (_cmp) return _cmp; }
    const denied = competitionDenied(req, comp.id);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    const ts = getTimeslot(req.params.tsId);
    if (!ts || ts.competition_id !== comp.id) return res.status(404).json({ error: "Session not found" });
    // Block deletion if session has started (rule #1)
    if (timeslotStatus(ts) !== "upcoming") return res.status(400).json({ error: "Cannot delete a session that has already started." });
    // Block deletion if participants are assigned or submissions exist (edge case #4)
    const hasParticipants = db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND timeslot_id=? LIMIT 1").get(comp.id, ts.id);
    if (hasParticipants) return res.status(400).json({ error: "Cannot delete a session with assigned participants. Reassign them first." });
    const hasSubs = db.prepare("SELECT 1 FROM submissions WHERE competition_id=? AND timeslot_id=? LIMIT 1").get(comp.id, ts.id);
    if (hasSubs) return res.status(400).json({ error: "Cannot delete a session with existing submissions." });
    const hasHints = db.prepare("SELECT 1 FROM hint_reveals WHERE competition_id=? AND timeslot_id=? LIMIT 1").get(comp.id, ts.id);
    if (hasHints) return res.status(400).json({ error: "Cannot delete a session with existing hint reveals." });
    const adminId = getAdminIdentity(req);
    const tsDeleteTxn = db.transaction(() => {
      db.prepare("DELETE FROM email_reminders WHERE competition_id=? AND timeslot_id=?").run(comp.id, ts.id);
      db.prepare("DELETE FROM competition_timeslots WHERE id=?").run(ts.id);
      db.prepare("UPDATE competitions SET updated_at=? WHERE id=?").run(now().toISOString(), comp.id);
      // Record deletion in competition history (timeslot_events cascades with the row)
      recordCompetitionEvent(comp.id, "timeslot_deleted", adminId, { timeslot_id: ts.id, name: ts.name, ...reqContext(req) });
    });
    runTxnWithMirrorBuffer(() => tsDeleteTxn());
    _invalidateCompetitionCache(comp.id); // bumped comp.updated_at → bust cache (concurrency invariant)
    // v7.21.9 — REMOVING the last non-ended session is itself an end transition:
    // competitionStatus for a multi-slot comp is `every(s => ended)`, so deleting
    // the only upcoming slot makes the competition fully ended. This path froze
    // nothing, and nothing else would catch it — the scheduler's competition loop
    // skips multi-slot comps entirely, its slot loop only reconsiders slots whose
    // last observation is not already 'ended', and the deleted slot has no row at
    // all. So the only remaining freeze was the LAZY one on first read, which is
    // precisely the window v7.15.6 introduced the eager freeze to close: a
    // group-membership edit made before anyone opened Rankings silently rewrote a
    // finished competition's official standings, and the wrong figures were then
    // frozen for ever. `freezeGroupLeaderboardSnapshots` no-ops unless the comp
    // is now fully ended, so this is safe on every other delete.
    freezeGroupLeaderboardSnapshots(comp.id);
    enqueueCertificateDispatch(comp.id, { reason: "ended" });   // v8.15.1 — the dispatcher re-checks the full end
    res.json({ ok: true });
  });

  // v7.21.19 (audit F1) — delete a SET of sessions ALL-OR-NOTHING.
  //
  // The admin form queues the sessions an admin removed and deleted them one at
  // a time. Each is independently refusable (started / has participants / has
  // submissions / has hints), so a queue of two where the SECOND is protected
  // left the first permanently deleted and reported the save as failed. The
  // admin was told nothing happened while a session had in fact been destroyed,
  // and the only record of which one was gone was the list itself.
  //
  // Checking every id BEFORE deleting any, inside ONE transaction, is what makes
  // that impossible: better-sqlite3 is synchronous and the process is
  // single-threaded by hard invariant, so nothing can interleave between the
  // checks and the writes — this is real mutual exclusion, not an approximation
  // (the same argument as reserveAttachmentBudget, v7.15.11).
  //
  // It also fixes the concurrency half of the finding. The per-delete loop had
  // to re-read the competition afterwards to refresh `expectedUpdatedAt`,
  // because its own DELETEs had bumped it — and that blind re-read equally
  // swallowed ANOTHER admin's edit landing in the same window. This returns the
  // updated_at produced BY THIS TRANSACTION, so the client can carry a token it
  // knows is its own.
  app.post("/api/admin/competitions/:id/timeslots/bulk-delete", requireAdmin, csrfProtection, (req, res) => {
    const comp = getCompetition(req.params.id);
    if (!comp) return res.status(404).json({ error: "Event not found" });
    // v8.7.0 — the parent event decides; refused above the timeslot lookup and
    // every write below it.
    // v8.12.0 — a competitor may not touch the event they compete in (see routes/competitions.js PUT).
    { const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), comp.id)); if (_cmp) return _cmp; }
    const denied = competitionDenied(req, comp.id);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    const _v = validateBody(req.body, {
      timeslotIds: { type: "stringArray", required: true, label: "timeslotIds" },
      expectedUpdatedAt: { type: "string", label: "expectedUpdatedAt" },
    });
    if (_v.error) return res.status(400).json({ error: _v.error });
    const ids = [...new Set(_v.values.timeslotIds)];
    if (!ids.length) return res.status(400).json({ error: "timeslotIds must not be empty." });
    if (ids.length > BULK_ADMIN_MAX) return res.status(400).json({ error: `Cannot delete more than ${BULK_ADMIN_MAX} sessions in a single request.` });

    // Optimistic concurrency, same contract as every other lifecycle write: if
    // the competition moved under the admin since the form opened, refuse rather
    // than delete against a stale view.
    const expected = _v.values.expectedUpdatedAt;
    if (expected && comp.updated_at && expected !== comp.updated_at) {
      return res.status(409).json({ error: "This event was changed by someone else. Reload and try again.", conflict: true });
    }

    // CHECK EVERYTHING FIRST. One refusal fails the whole request and nothing is
    // written — that is the point of the endpoint.
    const rows = [];
    for (const tsId of ids) {
      const ts = getTimeslot(tsId);
      if (!ts || ts.competition_id !== comp.id) return res.status(404).json({ error: "Session not found", timeslotId: tsId });
      if (timeslotStatus(ts) !== "upcoming") {
        return res.status(400).json({ error: `Cannot delete session "${ts.name}" — it has already started.`, timeslotId: tsId });
      }
      if (db.prepare("SELECT 1 FROM competition_users WHERE competition_id=? AND timeslot_id=? LIMIT 1").get(comp.id, ts.id)) {
        return res.status(400).json({ error: `Cannot delete session "${ts.name}" — participants are assigned to it. Reassign them first.`, timeslotId: tsId });
      }
      if (db.prepare("SELECT 1 FROM submissions WHERE competition_id=? AND timeslot_id=? LIMIT 1").get(comp.id, ts.id)) {
        return res.status(400).json({ error: `Cannot delete session "${ts.name}" — it has submissions.`, timeslotId: tsId });
      }
      if (db.prepare("SELECT 1 FROM hint_reveals WHERE competition_id=? AND timeslot_id=? LIMIT 1").get(comp.id, ts.id)) {
        return res.status(400).json({ error: `Cannot delete session "${ts.name}" — it has revealed hints.`, timeslotId: tsId });
      }
      rows.push(ts);
    }

    const adminId = getAdminIdentity(req);
    const stamp = now().toISOString();
    const bulkDeleteTxn = db.transaction(() => {
      for (const ts of rows) {
        db.prepare("DELETE FROM email_reminders WHERE competition_id=? AND timeslot_id=?").run(comp.id, ts.id);
        db.prepare("DELETE FROM competition_timeslots WHERE id=?").run(ts.id);
        recordCompetitionEvent(comp.id, "timeslot_deleted", adminId, { timeslot_id: ts.id, name: ts.name, via: "bulk", ...reqContext(req) });
      }
      db.prepare("UPDATE competitions SET updated_at=? WHERE id=?").run(stamp, comp.id);
    });
    runTxnWithMirrorBuffer(() => bulkDeleteTxn());
    _invalidateCompetitionCache(comp.id);
    // Removing the last non-ended session is itself an end transition — see the
    // single-delete route above for why this must freeze the team board.
    freezeGroupLeaderboardSnapshots(comp.id);
    enqueueCertificateDispatch(comp.id, { reason: "ended" });   // v8.15.1 — the dispatcher re-checks the full end
    res.json({ ok: true, deleted: rows.length, updated_at: stamp });
  });

  app.post("/api/admin/competitions/:id/timeslots/:tsId/end-now", requireAdmin, destructiveAdminLimit, csrfProtection, (req, res) => {
    const comp = getCompetition(req.params.id);
    if (!comp) return res.status(404).json({ error: "Event not found" });
    // v8.7.0 — the parent event decides; refused above the timeslot lookup and
    // every write below it.
    // v8.12.0 — a competitor may not touch the event they compete in (see routes/competitions.js PUT).
    { const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), comp.id)); if (_cmp) return _cmp; }
    const denied = competitionDenied(req, comp.id);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    const ts = getTimeslot(req.params.tsId);
    if (!ts || ts.competition_id !== comp.id) return res.status(404).json({ error: "Session not found" });
    const tsStatus = timeslotStatus(ts);
    if (tsStatus === "ended") return res.status(400).json({ error: "Session has already ended" });
    const endedAt = now().toISOString();
    const adminId = getAdminIdentity(req);
    const endNowTxn = db.transaction(() => {
      let actualDur, r;
      if (tsStatus === "live") {
        actualDur = Math.max(1, Math.ceil((new Date(endedAt).getTime() - new Date(ts.start_time).getTime()) / 60_000));
        r = db.prepare("UPDATE competition_timeslots SET ended_at=?, ended_manually=1, duration_minutes=?, updated_at=? WHERE id=? AND ended_at IS NULL").run(endedAt, actualDur, endedAt, ts.id);
      } else {
        actualDur = 0;
        r = db.prepare("UPDATE competition_timeslots SET start_time=?, duration_minutes=0, ended_at=?, ended_manually=1, updated_at=? WHERE id=? AND ended_at IS NULL").run(endedAt, endedAt, endedAt, ts.id);
      }
      if (r.changes > 0) {
        // Ended before it started, it will never start: its unsent start reminders go
        // with it (the dispatcher would otherwise skip them later as "already started").
        const _cancelled = tsStatus === "live" ? 0
          : db.prepare("DELETE FROM email_reminders WHERE competition_id=? AND timeslot_id=? AND sent=0").run(comp.id, ts.id).changes;
        recordTimeslotEvent(ts.id, "ended_manually", adminId, { duration_minutes: actualDur, ...(_cancelled ? { reminders_cancelled: _cancelled } : {}), ...reqContext(req) });
        if (competitionFullyEnded(comp)) {
          _invalidateCompetitionCache(comp.id);
          const cr = db.prepare("UPDATE competitions SET ended_at=?, updated_at=? WHERE id=? AND ended_at IS NULL").run(endedAt, endedAt, comp.id);
          if (cr.changes > 0) recordCompetitionEvent(comp.id, "ended_manually", adminId, { via: "last_timeslot_ended", ...reqContext(req) });
        } else {
          db.prepare("UPDATE competitions SET updated_at=? WHERE id=?").run(endedAt, comp.id);
        }
      }
    });
    // runTxnWithMirrorBuffer (ext-audit F4): the recordTimeslotEvent emit is
    // followed by the parent-comp UPDATE (+ a cascade recordCompetitionEvent
    // when this was the last live slot) in the same txn, so a rollback past the
    // emit would strand a ghost app.jsonl mirror line. Mirrors tsEditTxn above.
    runTxnWithMirrorBuffer(() => endNowTxn());
    _invalidateCompetitionCache(comp.id); // bumped comp.updated_at → bust cache (concurrency invariant)
    // Cache bust: rankings + solve times must reflect the just-ended slot.
    invalidateLeaderboardCache(comp.id);
    // ext-audit v7.15.6 — ending the LAST slot is what makes the competition
    // fully ended, so freeze the team board(s) here rather than waiting for the
    // first post-end read (no-op unless the comp is now fully ended).
    freezeGroupLeaderboardSnapshots(comp.id);
    enqueueCertificateDispatch(comp.id, { reason: "ended" });   // v8.15.1 — the dispatcher re-checks the full end
    const updated = getTimeslot(ts.id);
    res.json({ ok: true, timeslot: { ...updated, status: timeslotStatus(updated), effective_end: timeslotEffectiveEnd(updated)?.toISOString() || null } });
  });
};
