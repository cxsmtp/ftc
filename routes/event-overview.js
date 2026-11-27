"use strict";

// THE EVENT OVERVIEW PULSE — GET /api/admin/competitions/:id/overview-pulse.
//
// One read that feeds the event workspace's live Overview: the KPI figures, a
// bucketed time series (joins, answers, correct answers) over the event window,
// per-challenge solve counts and a short feed of recent joins and solves.
//
// Gates, in order: scope (competitionDenied, BEFORE existence so an
// out-of-scope id is no oracle), 404, the competitor lock (a competitor would
// otherwise watch which challenges their rivals have solved, live).
//
// What it counts shares the Analytics rules (server.js
// /api/admin/analytics/challenges): `challenge_events` only, impersonated rows
// never (`ce.impersonated=0`), and `staff`-tagged accounts never — except on an
// event where staff compete, whose staff MEMBERS count like anybody else, as its
// boards, certificates and exports count them (operator ruling, 14 Nov 2026); a
// staff account without a row there still does not. Benchmark accounts stay in.
// It differs from Analytics on ROLES: where staff do NOT compete, it also leaves
// out every account whose role the boards leave out (the event admin and any
// custom role of its class, by the boards' own list, lib/user-tags.js
// offBoardRolesJson), so an organiser playing such an event is in none of its
// figures, as they are on none of its boards (operator ruling, 14 Nov 2026).
// It differs on QUALIFYING questions (lib/qualifying.js),
// which Analytics leaves out entirely: here their answers count as answers
// (the KPI band, the chart), but they never count toward a solve or finishing
// (`solvers`, `finished`, `visible_tasks`, the feed's solves), and each task row
// says `qualifying` so the Overview can leave them out of solve rates and
// readiness. `solvers` and `finished` count the event's current members, the
// population `joined` counts (removing someone keeps their challenge events).
// `enrolled` counts every member row with nobody left out (the roster the
// Events list shows), read in the same snapshot as `joined`.
// `active_now` counts people who ANSWERED (right or wrong) in the last five
// minutes: a hint or leaving a challenge is not playing. Past the end, the
// chart's window runs as far as the last late answer or join.
// It carries NO answer text and no answer length: a sealed
// challenge's key reaches nobody through it. Titles are the challenges the
// event holds, which every actor allowed past the scope check may already see.
//
// Not cached: an organiser polls it on the workspace's 15 s events poll, and
// every query is an index range over one competition's rows; a read slower than
// PERF_SPAN_SLOW_MS logs a [perf-span] line, so its cost under load is measured
// before any cache trades the figures' freshness for it.
// Registered from server.js using an absolute, method-specific path.

const db = require("../db");
const { requireAdmin } = require("../lib/middleware");
const { getCompetition, getCompetitionTimeslots, competitionEffectiveEnd } = require("../lib/competitions");
const { qualifyingSql, notQualifyingSql } = require("../lib/qualifying");
const { lateEntryDeadline } = require("../lib/late-entry");
const { competitionDenied, competitorIds } = require("../lib/event-admin");
const { competitorEditDenied, refuseCompetitor, staffCompeteOn } = require("../lib/staff-compete");
const { offBoardRolesJson } = require("../lib/user-tags");
const { now } = require("../lib/time");
const { PERF_SPAN_SLOW_MS } = require("../lib/config");
const { log } = require("../lib/log");

const MAX_BUCKETS = 24;
const RECENT_LIMIT = 12;
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
// THE ONE PARTICIPANT FILTER, shared by every query. `alias` is the table the
// row comes from (`ce` challenge_events, `cu` competition_users). Staff-tagged
// accounts are left out, except where the event's "Staff can compete" switch is
// on: there a staff account holding a row on this event counts (correlated on
// the row's own competition, so no extra parameter). Where the switch is off,
// the accounts whose ROLE the boards leave out are left out too: `@offBoard`,
// read once per pulse (`offBoardBind` below) and bound BY NAME, so every
// statement keeps its positional parameters — each call that uses `counted`
// where staff do not compete passes that bind object, or SQLite refuses the
// statement (missing named parameter) rather than counting anybody. Two fixed
// texts per alias, so each statement compiles at most twice (db.prepare is
// memoised by SQL text).
const STAFF_IDS = "(SELECT user_id FROM user_tags WHERE tag='staff')";
const OFF_BOARD_IDS = "(SELECT value FROM json_each(@offBoard))";
function counted(alias, staffCompete) {
  return staffCompete
    ? `(${alias}.user_id NOT IN ${STAFF_IDS} OR ${alias}.user_id IN (SELECT m.user_id FROM competition_users m WHERE m.competition_id=${alias}.competition_id))`
    : `(${alias}.user_id NOT IN ${STAFF_IDS} AND ${alias}.user_id NOT IN ${OFF_BOARD_IDS})`;
}
// The `@offBoard` bind for one pulse: the people this event's rows name (its
// members, and anyone with challenge activity in it) whose role the boards leave
// out, by the boards' own list of roles (lib/user-tags.js offBoardRolesJson). An
// index range over the event's rows and a key lookup per person, like the board
// builder's own read. Empty where staff compete: the boards lift the role half
// there too, and `counted` then names no `@offBoard`.
function offBoardBind(compId, staffCompete) {
  if (staffCompete) return [];
  const ids = db.prepare(
    `SELECT u.id FROM users u
      WHERE u.id IN (SELECT user_id FROM competition_users WHERE competition_id=?
                     UNION SELECT user_id FROM challenge_events WHERE competition_id=?)
        AND u.role IN (SELECT value FROM json_each(?))`
  ).all(compId, compId, offBoardRolesJson()).map(r => r.id);
  return [{ offBoard: JSON.stringify(ids) }];
}
// The event's current members (bound to the competition id parameter).
const MEMBER = "IN (SELECT user_id FROM competition_users WHERE competition_id=?)";

module.exports = function register(app) {
  app.get("/api/admin/competitions/:id/overview-pulse", requireAdmin, (req, res) => {
    const tHandler = process.hrtime.bigint();
    const id = String(req.params.id);
    const denied = competitionDenied(req, id);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    const comp = getCompetition(id);
    if (!comp) return res.status(404).json({ error: "Event not found" });
    const cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), comp.id));
    if (cmp) return cmp;

    const nowMs = now().getTime();
    // Who counts (`counted`): staff members too, where staff compete; where they
    // do not, neither staff nor the roles the boards leave out.
    const sc = staffCompeteOn(comp);
    const CE = counted("ce", sc), CU = counted("cu", sc);
    const slots = getCompetitionTimeslots(comp.id);
    const startMs = slots.length
      ? Math.min(...slots.map(s => new Date(s.start_time).getTime()))
      : new Date(comp.start_time).getTime();
    const endDate = competitionEffectiveEnd(comp, slots);
    const endMs = endDate ? endDate.getTime() : nowMs;
    // Late entrants play after the end until the late-entry deadline: past the
    // end the chart runs as far as the last answer or join recorded there (read
    // below), so its window holds every answer the totals count without drawing
    // an empty window that runs on to a deadline days away.
    const lateDl = endDate ? lateEntryDeadline(comp, endDate) : null;
    let toMs = Math.min(nowMs, endMs);

    let body;
    db.exec("BEGIN");
    try {
      // Read inside the snapshot, before any statement that names it.
      const B = offBoardBind(comp.id, sc);
      if (lateDl && lateDl.getTime() > endMs && nowMs > endMs) {
        const endIso = new Date(endMs).toISOString();
        const capIso = new Date(Math.min(nowMs, lateDl.getTime())).toISOString();
        const last = db.prepare(
          `SELECT MAX(at) AS at FROM (
             SELECT MAX(ce.occurred_at) AS at FROM challenge_events ce
              WHERE ce.competition_id=? AND ce.impersonated=0 AND ${CE} AND ce.occurred_at > ? AND ce.occurred_at <= ?
             UNION ALL
             SELECT MAX(cu.assigned_at) FROM competition_users cu
              WHERE cu.competition_id=? AND ${CU} AND cu.assigned_at > ? AND cu.assigned_at <= ?)`
        ).get(comp.id, endIso, capIso, comp.id, endIso, capIso, ...B);
        const lastMs = last && last.at ? new Date(last.at).getTime() : NaN;
        if (Number.isFinite(lastMs) && lastMs > toMs) toMs = lastMs;
      }
      const joined = db.prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN cu.assigned_at IS NOT NULL AND cu.assigned_at < ? THEN 1 ELSE 0 END) AS pre
           FROM competition_users cu WHERE cu.competition_id=? AND ${CU}`
      ).get(new Date(startMs).toISOString(), comp.id, ...B);
      // The Overview tells "nobody has joined" from "only people these figures
      // leave out have joined" by this, never by a roster read at another time.
      const enrolled = db.prepare("SELECT COUNT(*) AS n FROM competition_users WHERE competition_id=?").get(comp.id);

      const tot = db.prepare(
        `SELECT SUM(CASE WHEN ce.event_type IN ('solved','incorrect') THEN 1 ELSE 0 END) AS answers,
                SUM(CASE WHEN ce.event_type='solved' THEN 1 ELSE 0 END) AS correct,
                COUNT(DISTINCT CASE WHEN ce.event_type='solved' AND ${notQualifyingSql("t")} AND ce.user_id ${MEMBER} THEN ce.user_id END) AS solvers,
                COUNT(DISTINCT CASE WHEN ce.event_type IN ('solved','incorrect') AND ce.occurred_at >= ? THEN ce.user_id END) AS active
           FROM challenge_events ce LEFT JOIN tasks t ON t.id=ce.task_id
          WHERE ce.competition_id=? AND ce.impersonated=0 AND ${CE}`
      ).get(comp.id, new Date(nowMs - ACTIVE_WINDOW_MS).toISOString(), comp.id, ...B);

      // ── The time series ─────────────────────────────────────────────────
      let buckets = [];
      let bucketMs = 0;
      if (Number.isFinite(startMs) && toMs > startMs) {
        const span = toMs - startMs;
        bucketMs = Math.max(60_000, Math.ceil(span / MAX_BUCKETS / 60_000) * 60_000);
        const n = Math.min(MAX_BUCKETS, Math.ceil(span / bucketMs));
        buckets = Array.from({ length: n }, (_, i) => ({ t: new Date(startMs + i * bucketMs).toISOString(), joins: 0, answers: 0, correct: 0 }));
        const fromIso = new Date(startMs).toISOString();
        const toIso = new Date(toMs).toISOString();
        const idx = (b) => Math.max(0, Math.min(n - 1, Number(b) || 0));
        const evRows = db.prepare(
          `SELECT CAST((julianday(ce.occurred_at) - julianday(?)) * 86400000.0 / ? AS INTEGER) AS b,
                  SUM(CASE WHEN ce.event_type IN ('solved','incorrect') THEN 1 ELSE 0 END) AS answers,
                  SUM(CASE WHEN ce.event_type='solved' THEN 1 ELSE 0 END) AS correct
             FROM challenge_events ce
            WHERE ce.competition_id=? AND ce.impersonated=0 AND ${CE}
              AND ce.occurred_at >= ? AND ce.occurred_at <= ?
            GROUP BY b`
        ).all(fromIso, bucketMs, comp.id, fromIso, toIso, ...B);
        for (const r of evRows) { const k = idx(r.b); buckets[k].answers += r.answers || 0; buckets[k].correct += r.correct || 0; }
        const joinRows = db.prepare(
          `SELECT CAST((julianday(cu.assigned_at) - julianday(?)) * 86400000.0 / ? AS INTEGER) AS b, COUNT(*) AS joins
             FROM competition_users cu
            WHERE cu.competition_id=? AND ${CU}
              AND cu.assigned_at >= ? AND cu.assigned_at <= ?
            GROUP BY b`
        ).all(fromIso, bucketMs, comp.id, fromIso, toIso, ...B);
        for (const r of joinRows) buckets[idx(r.b)].joins += r.joins || 0;
      }

      // ── Per challenge ───────────────────────────────────────────────────
      const taskRows = db.prepare(
        `SELECT t.id, t.title, t.difficulty, t.status, t.active, ct.task_number, ${qualifyingSql("t")} AS qualifying
           FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id
          WHERE ct.competition_id=?`
      ).all(comp.id);
      const stats = new Map(db.prepare(
        `SELECT ce.task_id AS task_id, COUNT(DISTINCT ce.user_id) AS attempters,
                COUNT(DISTINCT CASE WHEN ce.event_type='solved' THEN ce.user_id END) AS solvers,
                COUNT(DISTINCT CASE WHEN ce.event_type IN ('solved','incorrect') THEN ce.user_id END) AS answerers,
                SUM(CASE WHEN ce.event_type IN ('solved','incorrect') THEN 1 ELSE 0 END) AS answers
           FROM challenge_events ce
          WHERE ce.competition_id=? AND ce.impersonated=0 AND ${CE}
          GROUP BY ce.task_id`
      ).all(comp.id, ...B).map(r => [r.task_id, r]));
      // Finished: members who have SOLVED every scoring challenge participants can
      // see (published and active, qualifying questions left out on both sides,
      // as every count of finishing leaves them out) — the Program's "how many
      // completed", and the organiser's "is anyone done" everywhere else.
      const visible = taskRows.filter(t => t.status === "published" && (t.active === 1 || t.active === true) && !t.qualifying).length;
      const finished = visible ? (db.prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT ce.user_id FROM challenge_events ce
             JOIN tasks t ON t.id=ce.task_id
             JOIN competition_tasks ct ON ct.competition_id=ce.competition_id AND ct.task_id=ce.task_id
            WHERE ce.competition_id=? AND ce.event_type='solved' AND ce.impersonated=0 AND ${CE}
              AND ce.user_id ${MEMBER}
              AND t.status='published' AND t.active=1 AND ${notQualifyingSql("t")}
            GROUP BY ce.user_id HAVING COUNT(DISTINCT ce.task_id) >= ?)`
      ).get(comp.id, comp.id, visible, ...B).n || 0) : 0;
      const tasks = taskRows.map(t => {
        const s = stats.get(t.id) || {};
        return {
          id: t.id, title: t.title, difficulty: t.difficulty, status: t.status,
          active: t.active === 1 || t.active === true, task_number: t.task_number || null,
          qualifying: !!t.qualifying,
          attempters: s.attempters || 0, solvers: s.solvers || 0, answerers: s.answerers || 0, answers: s.answers || 0,
        };
      });

      // ── Recent activity (nicknames only; the client escapes them) ───────
      const recentJoins = db.prepare(
        `SELECT cu.assigned_at AS at, u.nickname
           FROM competition_users cu JOIN users u ON u.id=cu.user_id
          WHERE cu.competition_id=? AND cu.assigned_at IS NOT NULL AND ${CU}
          ORDER BY cu.assigned_at DESC LIMIT ?`
      ).all(comp.id, RECENT_LIMIT, ...B).map(r => ({ type: "joined", at: r.at, nickname: r.nickname || null }));
      const recentSolves = db.prepare(
        `SELECT ce.occurred_at AS at, u.nickname, t.title, ct.task_number
           FROM challenge_events ce
           JOIN users u ON u.id=ce.user_id
           JOIN tasks t ON t.id=ce.task_id
           LEFT JOIN competition_tasks ct ON ct.competition_id=ce.competition_id AND ct.task_id=ce.task_id
          WHERE ce.competition_id=? AND ce.event_type='solved' AND ce.impersonated=0 AND ${CE}
            AND ${notQualifyingSql("t")}
          ORDER BY ce.occurred_at DESC LIMIT ?`
      ).all(comp.id, RECENT_LIMIT, ...B).map(r => ({ type: "solved", at: r.at, nickname: r.nickname || null, task_title: r.title, task_number: r.task_number || null }));
      const recent = [...recentJoins, ...recentSolves]
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
        .slice(0, RECENT_LIMIT);

      body = {
        ok: true,
        competition_id: comp.id,
        generated_at: new Date(nowMs).toISOString(),
        window: bucketMs ? { from: new Date(startMs).toISOString(), to: new Date(toMs).toISOString(), bucket_ms: bucketMs } : null,
        totals: {
          joined: joined.n || 0, joined_before_start: joined.pre || 0, enrolled: enrolled.n || 0,
          answers: tot.answers || 0, correct: tot.correct || 0, solvers: tot.solvers || 0, active_now: tot.active || 0,
          finished, visible_tasks: visible,
        },
        buckets, tasks, recent,
      };
    } finally {
      db.exec("COMMIT");
    }
    const tDb = process.hrtime.bigint();
    res.json(body);
    const tRespond = process.hrtime.bigint();
    const preludeMs = req._perfT0 ? Number(tHandler - req._perfT0) / 1e6 : 0;
    const dbMs = Number(tDb - tHandler) / 1e6;
    const respMs = Number(tRespond - tDb) / 1e6;
    const totalMs = preludeMs + dbMs + respMs;
    if (totalMs > PERF_SPAN_SLOW_MS) {
      log.warn({
        req_id: req.id,
        endpoint: "/api/admin/competitions/:id/overview-pulse",
        competition_id: comp.id,
        total_ms: totalMs.toFixed(1),
        prelude_ms: preludeMs.toFixed(1),
        db_ms: dbMs.toFixed(2),
        respond_ms: respMs.toFixed(2),
      }, "[perf-span] slow /api/admin/competitions/:id/overview-pulse");
    }
  });
};
