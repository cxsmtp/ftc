"use strict";

// Auto-start / auto-end status scheduler + the status-observation table writers.
// Direction invariant: scheduler → { competitions, audit, time } (one-way,
// acyclic) — competitions/audit must NEVER require scheduler. startStatusScheduler
// is exported but its 60s interval is started from server.js's app.listen
// callback (a boot concern). (v7.0.0 refactor: extracted from server.js.)

const db = require("../db");
const { now } = require("./time");
const { scheduledEnd, competitionStatus, timeslotStatus } = require("./competitions");
const { recordCompetitionEvent, recordTimeslotEvent } = require("./audit");
// ext-audit v7.15.6 — lib/leaderboard requires db + lib/competitions only, so
// this adds no cycle (scheduler is not imported by either).
const { freezeGroupLeaderboardSnapshots } = require("./leaderboard");
// v8.15.1 — every end this tick notices queues the event's certificates (the
// dispatcher re-checks the end, the switch and the grandfather floor at run time,
// so a slot ending in a still-running event costs one dropped job row).
const { enqueueCertificateDispatch } = require("./certificate-dispatch");

// Update the scheduler's observation table. Use from places that cause known
// state transitions (manual end, all-solved auto-end) so the scheduler doesn't
// re-emit an auto_* event for the same transition.
function _updateStatusObservation(entityType, entityId, status) {
  db.prepare("INSERT OR REPLACE INTO entity_status_observations (entity_type, entity_id, last_status, observed_at) VALUES (?,?,?,?)")
    .run(entityType, entityId, status, now().toISOString());
}

// v6.20.x — after a REVIVE clears ended_at, re-point the scheduler's status
// observation at the entity's fresh (live/upcoming) status. The scheduler skips
// entities last observed 'ended' (an optimisation that assumes ended is
// terminal); without this reset a revived-then-re-ended comp/slot would never
// get its terminal auto_ended emitted, and no auto_started for the revived
// window. Call INSIDE the revive transaction (reads the just-updated row).
function _resyncStatusObservationAfterRevive(entityType, id) {
  if (entityType === "competition") {
    const c = db.prepare("SELECT * FROM competitions WHERE id=?").get(id);
    if (c) _updateStatusObservation("competition", id, competitionStatus(c));
  } else {
    const t = db.prepare("SELECT * FROM competition_timeslots WHERE id=?").get(id);
    if (t) _updateStatusObservation("timeslot", id, timeslotStatus(t));
  }
}

// Auto-start/auto-end scheduler. Runs every 60s (configurable for tests).
// For each single-slot competition and each timeslot, observes current status;
// on transition (upcoming → live, * → ended), emits auto_started / auto_ended
// events. First observation never emits — it bootstraps the row in the
// observations table so subsequent ticks have a baseline.
let _statusSchedulerHandle = null;
function runStatusSchedulerTick() {
  try {
    // Single-slot competitions. v6.8.0: skip comps whose last observation is
    // already "ended" — once ended, a comp never transitions again, so there
    // is no point rescanning them on every 60-s tick. Over a long-running
    // deployment this keeps the scan bounded by active + never-observed
    // comps, rather than growing with total-comps-ever.
    const comps = db.prepare(`
      SELECT c.*,
             (SELECT COUNT(*) FROM competition_timeslots WHERE competition_id=c.id) as _slots
      FROM competitions c
      LEFT JOIN entity_status_observations obs
        ON obs.entity_type='competition' AND obs.entity_id=c.id
      WHERE obs.last_status IS NULL OR obs.last_status != 'ended'
    `).all();
    for (const c of comps) {
      if (c._slots > 0) continue; // tracked per-timeslot
      const currStatus = competitionStatus(c, []);
      const row = db.prepare("SELECT last_status FROM entity_status_observations WHERE entity_type='competition' AND entity_id=?").get(c.id);
      if (!row) {
        // ext-audit v7.15.11 — FIRST observation. v7.15.6 froze the team board
        // only on a status CHANGE, so an entity first seen already "ended" (a
        // fresh boot against an existing DB, or a comp created in the past) was
        // recorded as ended with NO snapshot, leaving membership edits able to
        // rewrite an official finished result until someone happened to open the
        // board. Freeze here too; the helper no-ops unless it is fully ended.
        if (currStatus === "ended") { freezeGroupLeaderboardSnapshots(c.id); enqueueCertificateDispatch(c.id, { reason: "ended" }); }
        _updateStatusObservation("competition", c.id, currStatus);
        continue;
      }
      if (row.last_status === currStatus) continue;
      // Status changed — emit appropriate event(s)
      if (currStatus === "live") {
        recordCompetitionEvent(c.id, "auto_started", "system", { scheduled_start: c.start_time });
      } else if (currStatus === "ended") {
        // v6.16.10 — re-fetch `ended_manually` immediately before the
        // emit (closes the manual-end / duration-shrink race).
        // v6.16.13 — also handle the "comp deleted between SELECT and
        // re-fetch" case. If `fresh === undefined` the comp is gone;
        // emitting `auto_ended` would land an orphan row in
        // competition_events (no FK to competitions.id) referencing a
        // deleted comp id, AND the observation update below would
        // resurrect a status row for a dead id. Skip both.
        const fresh = db.prepare("SELECT ended_manually FROM competitions WHERE id=?").get(c.id);
        if (!fresh) continue;
        if (!fresh.ended_manually) {
          recordCompetitionEvent(c.id, "auto_ended", "system", { scheduled_end: scheduledEnd(c).toISOString() });
        }
      }
      // ext-audit v7.15.6 — a TIME-EXPIRED comp has no end transaction at all
      // (status is time-derived; ended_at stays NULL), so this tick is the only
      // hook that can freeze its team board. Bounds the mutable window at one
      // tick instead of "until somebody happens to open Rankings".
      if (currStatus === "ended") { freezeGroupLeaderboardSnapshots(c.id); enqueueCertificateDispatch(c.id, { reason: "ended" }); }
      _updateStatusObservation("competition", c.id, currStatus);
    }
    // Timeslots — same filter: skip already-ended observations.
    const slots = db.prepare(`
      SELECT ts.*
      FROM competition_timeslots ts
      LEFT JOIN entity_status_observations obs
        ON obs.entity_type='timeslot' AND obs.entity_id=ts.id
      WHERE obs.last_status IS NULL OR obs.last_status != 'ended'
    `).all();
    for (const ts of slots) {
      const currStatus = timeslotStatus(ts);
      const row = db.prepare("SELECT last_status FROM entity_status_observations WHERE entity_type='timeslot' AND entity_id=?").get(ts.id);
      if (!row) {
        // Same first-observation gap as the competition branch above — a slot
        // first seen already ended can be what makes its comp fully ended.
        if (currStatus === "ended") { freezeGroupLeaderboardSnapshots(ts.competition_id); enqueueCertificateDispatch(ts.competition_id, { reason: "ended" }); }
        _updateStatusObservation("timeslot", ts.id, currStatus);
        continue;
      }
      if (row.last_status === currStatus) continue;
      if (currStatus === "live") {
        recordTimeslotEvent(ts.id, "auto_started", "system", { scheduled_start: ts.start_time });
      } else if (currStatus === "ended") {
        // v6.16.10 — race fix as the competition branch above.
        // v6.16.13 — handle slot deleted between SELECT and re-fetch.
        const freshTs = db.prepare("SELECT ended_manually FROM competition_timeslots WHERE id=?").get(ts.id);
        if (!freshTs) continue;
        if (!freshTs.ended_manually) {
          recordTimeslotEvent(ts.id, "auto_ended", "system", { scheduled_end: scheduledEnd(ts).toISOString() });
        }
      }
      // A slot ending can be what makes the COMPETITION fully ended; the helper
      // no-ops unless that is now true.
      if (currStatus === "ended") { freezeGroupLeaderboardSnapshots(ts.competition_id); enqueueCertificateDispatch(ts.competition_id, { reason: "ended" }); }
      _updateStatusObservation("timeslot", ts.id, currStatus);
    }
  } catch (e) {
    console.error("Status scheduler tick failed:", e.message);
  }
}
function startStatusScheduler() {
  if (_statusSchedulerHandle) return;
  // One tick immediately to bootstrap, then every 60s.
  runStatusSchedulerTick();
  _statusSchedulerHandle = setInterval(runStatusSchedulerTick, 60_000);
  _statusSchedulerHandle.unref(); // infra audit (#1): don't let the tick timer keep the event loop alive (the http server already does)
}

module.exports = {
  _updateStatusObservation, _resyncStatusObservationAfterRevive,
  runStatusSchedulerTick, startStatusScheduler,
};
