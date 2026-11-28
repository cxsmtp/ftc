"use strict";

// MARKETING ANALYTICS — how the platform is doing, across events.
//
// The owner asked for "marketing analytics which should say what is the overall
// success of the platform … smart and objective". So every figure here is a
// COUNT of something the platform recorded, with its denominator beside it:
// nothing is estimated, nothing is compared with an outside benchmark, and a
// figure that only some events can answer says how many could.
//
// ── WHICH EVENTS ─────────────────────────────────────────────────────────────
// The events whose START falls inside the range ([from, to), and no later than
// now: an event that has not started has nothing to report), less every event
// tagged `test/dry run` (DRY_RUN_TAG: rehearsals, counted only in
// `dry_run_excluded`), narrowed to the kinds asked for (`eventKind`, tolerant of
// a value this build does not know, as everywhere) and to the events asked for.
// One basis for every figure: an event's people, answers, certificates and leads
// belong to the range its start falls in, so the per-event table and the totals
// always add up. Activity dates are not used.
//
// ── WHO COUNTS ───────────────────────────────────────────────────────────────
// Per event, its MEMBERS (`competition_users`) less the people the boards leave
// out there: `staff`-tagged accounts (unless the event lets staff compete),
// `benchmark` accounts and every role the boards leave out — lib/user-tags.js
// `getStaffOrBenchmarkSet(ids, {staffCompete})`, the boards' own set, never a
// copy. Activity is read from `challenge_events` with `impersonated=0`, so
// nothing an administrator did while viewing as somebody counts. Certificates
// count only holders outside the same set.
//
// ── THE FIGURES (each says what it counts; definitions repeated in
// docs/user-guide/admin.md "Marketing" and the help tips) ────────────────────
//   joined          member rows that count (a person in two events counts twice)
//   people          distinct people among them
//   played          joined people who answered anything there (right or wrong,
//                   a Quick question included: the event team's "played")
//   answers         answers to scoring questions (right or wrong)
//   quick_answers   answers to Quick (qualifying) questions
//   solve rate      of the (event, person, scoring question) pairs answered at
//                   least once, the share with a correct answer
//   finished        played people who solved every scoring question the event
//                   shows now (published, active, Quick questions left out): the
//                   Overview's "solved every question"; asked only in events
//                   that show at least one scoring question
//   active time     net active time (lib/presence.js buckets) of the people
//                   seen, only in events that measure it; median, in minutes
//   returning       people in more than one of the selected events
//   countries       one row per country however the profile spells it
//                   (lib/countries.js `countryName`: code, name, USA, UK…), named
//                   as the profile select names it; anything else as typed
//   new accounts    people whose account was created inside the range, by how
//                   the records say it came (desk, invitation, join link, else
//                   "sign-up form, import or other": the records do not tell
//                   those apart)
//   certificates    unrevoked, by their stored basis; shared = the holder
//                   pressed Share (`shared_at`)
//   programs        Program learners' grades (lib/program-grade.js
//                   `programStandings`, the learners' own rule): finished,
//                   graded, passed (60% or more) and each band
//   pipeline        the event team's leads (lib/event-team.js `leadSignals`:
//                   their set, `classifyLead`, `followUpDeclined`), only in
//                   events that asked readable qualifying questions
//
// Pure of requests: the route (routes/marketing-analytics.js) validates and
// caches; this module reads the database and returns the body.

const db = require("../db");
const { DRY_RUN_TAG } = require("./competitions");
const { eventKind, EVENT_KINDS } = require("./event-policy");
const { getStaffOrBenchmarkSet } = require("./user-tags");
const { notQualifyingSql, qualifyingSql } = require("./qualifying");
const { presenceMsByUser } = require("./presence");
const { leadSignals, normaliseCompany } = require("./event-team");
const { countryName } = require("./countries");
const { programGraded, programStandings, GRADE_BANDS, GRADE_BAND_KEYS, TRY_AGAIN, PASS_PERCENT } = require("./program-grade");

const KIND_VALUES = Object.freeze(EVENT_KINDS.map(k => k.value));
const TOP_N = 8;
const CERT_BASES = Object.freeze(["placement", "participation", "completion"]);
// How an account came, in the order the records are asked (the first that holds).
const ACCOUNT_SOURCES = Object.freeze(["desk", "invitation", "join_link", "other"]);

// Constant SQL text: an optional id list is ONE bound JSON array, and "no list"
// is the bound flag 0 (db.prepare is memoised by text).
const EVENTS_SQL =
  `SELECT c.id, c.name, c.event_kind, c.start_time, c.staff_compete, c.measure_presence
     FROM competitions c
    WHERE julianday(c.start_time) >= julianday(?) AND julianday(c.start_time) < julianday(?)
      AND julianday(c.start_time) <= julianday(?)
      AND (? = 0 OR c.id IN (SELECT value FROM json_each(?)))
      AND c.id NOT IN (SELECT competition_id FROM competition_tags WHERE tag=?)
    ORDER BY c.start_time DESC, c.id`;
const DRY_RUN_SQL =
  `SELECT COUNT(*) AS n FROM competitions c
    WHERE julianday(c.start_time) >= julianday(?) AND julianday(c.start_time) < julianday(?)
      AND julianday(c.start_time) <= julianday(?)
      AND (? = 0 OR c.id IN (SELECT value FROM json_each(?)))
      AND c.id IN (SELECT competition_id FROM competition_tags WHERE tag=?)`;

function _median(list) {
  if (!list.length) return null;
  const a = [...list].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Top `n` values of a Map name -> count, the rest as `other`. Ties by name. */
function _top(counts, n, unknown) {
  const all = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = all.slice(0, n).map(([name, count]) => ({ name, count }));
  const other = all.slice(n).reduce((s, [, c]) => s + c, 0);
  return { top, other, other_kinds: Math.max(0, all.length - n), not_given: unknown };
}

/** How the records say an account came (the first of ACCOUNT_SOURCES that holds). */
function accountSource(u) {
  if (u.registered_via === "desk") return "desk";
  if (u.invitation_id) return "invitation";
  if (u.registration_competition_id) return "join_link";
  return "other";
}

/** One event's figures over its counted people. */
function _eventFigures(ev) {
  const staffCompete = !!ev.staff_compete;
  const members = db.prepare("SELECT user_id FROM competition_users WHERE competition_id=?").all(ev.id).map(r => r.user_id);
  const off = getStaffOrBenchmarkSet(members, { staffCompete });
  const counted = members.filter(id => !off.has(id));
  const cj = JSON.stringify(counted);

  const played = new Set(db.prepare(
    `SELECT DISTINCT ce.user_id FROM challenge_events ce
      WHERE ce.competition_id=? AND ce.impersonated=0 AND ce.event_type IN ('solved','incorrect')
        AND ce.user_id IN (SELECT value FROM json_each(?))`
  ).all(ev.id, cj).map(r => r.user_id));

  const ans = db.prepare(
    `SELECT SUM(CASE WHEN ${notQualifyingSql("t")} THEN 1 ELSE 0 END) AS scoring,
            SUM(CASE WHEN ${qualifyingSql("t")} THEN 1 ELSE 0 END) AS quick
       FROM challenge_events ce JOIN tasks t ON t.id=ce.task_id
      WHERE ce.competition_id=? AND ce.impersonated=0 AND ce.event_type IN ('solved','incorrect')
        AND ce.user_id IN (SELECT value FROM json_each(?))`
  ).get(ev.id, cj);

  const pairs = db.prepare(
    `SELECT COUNT(*) AS answered, SUM(solved) AS solved FROM (
       SELECT ce.user_id, ce.task_id, MAX(CASE WHEN ce.event_type='solved' THEN 1 ELSE 0 END) AS solved
         FROM challenge_events ce JOIN tasks t ON t.id=ce.task_id
        WHERE ce.competition_id=? AND ce.impersonated=0 AND ce.event_type IN ('solved','incorrect')
          AND ${notQualifyingSql("t")} AND ce.user_id IN (SELECT value FROM json_each(?))
        GROUP BY ce.user_id, ce.task_id)`
  ).get(ev.id, cj);

  // Solved every scoring question the event shows now (the Overview's
  // "finished"): published, active, assigned, Quick questions left out.
  const visible = db.prepare(
    `SELECT COUNT(*) AS n FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id
      WHERE ct.competition_id=? AND t.status='published' AND t.active=1 AND ${notQualifyingSql("t")}`
  ).get(ev.id).n;
  const finished = visible ? db.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT ce.user_id FROM challenge_events ce
         JOIN tasks t ON t.id=ce.task_id
         JOIN competition_tasks ct ON ct.competition_id=ce.competition_id AND ct.task_id=ce.task_id
        WHERE ce.competition_id=? AND ce.event_type='solved' AND ce.impersonated=0
          AND t.status='published' AND t.active=1 AND ${notQualifyingSql("t")}
          AND ce.user_id IN (SELECT value FROM json_each(?))
        GROUP BY ce.user_id HAVING COUNT(DISTINCT ce.task_id) >= ?)`
  ).get(ev.id, cj, visible).n : 0;

  // Net active time, only where the event measures it, of the people seen.
  let presence = null;
  if (ev.measure_presence) {
    const ms = presenceMsByUser(ev.id);
    presence = counted.map(id => ms.get(id) || 0).filter(v => v > 0).map(v => v / 60000);
  }

  // Certificates: unrevoked, holders outside the boards' exclusion set.
  const badges = db.prepare(
    "SELECT user_id, basis, shared_at FROM achievement_badges WHERE competition_id=? AND revoked_at IS NULL"
  ).all(ev.id);
  const offHolders = getStaffOrBenchmarkSet([...new Set(badges.map(b => b.user_id))], { staffCompete });
  const certs = { placement: 0, participation: 0, completion: 0, not_recorded: 0, total: 0, shared: 0 };
  for (const b of badges) {
    if (offHolders.has(b.user_id)) continue;
    certs.total++;
    if (CERT_BASES.includes(b.basis)) certs[b.basis]++; else certs.not_recorded++;
    if (b.shared_at) certs.shared++;
  }

  // Program grades: the learners' own standing, for the people who count.
  let program = null;
  if (programGraded(ev)) {
    program = { learners: counted.length, finished: 0, graded: 0, passed: 0, bands: {} };
    for (const k of [...GRADE_BAND_KEYS, TRY_AGAIN.key]) program.bands[k] = 0;
    for (const s of programStandings(ev, counted).values()) {
      if (!s.finished) continue;
      program.finished++;
      if (!s.grade) continue;
      program.graded++;
      program.bands[s.grade.band]++;
      if (s.grade.passed) program.passed++;
    }
  }

  // The event team's leads, by the reports' own rules.
  const ls = leadSignals(ev.id);
  const pipeline = ls.asked ? {
    leads: ls.leads.length,
    hot: ls.leads.filter(l => l.signal === "hot").length,
    warm: ls.leads.filter(l => l.signal === "warm").length,
    cold: ls.leads.filter(l => l.signal === "cold").length,
    follow_up_yes: ls.leads.filter(l => l.positions.follow_up === 0).length,
    follow_up_no: ls.declined.length,
    contacted: ls.leads.filter(l => l.contacted).length,
  } : null;

  return {
    counted, played, visible, finished, presence, certs, program, pipeline,
    answers: ans.scoring || 0, quick_answers: ans.quick || 0,
    answered_pairs: pairs.answered || 0, solved_pairs: pairs.solved || 0,
  };
}

/**
 * The whole report. `from`/`to`/`nowIso` are ISO instants (`from` may be null:
 * no lower bound); `kinds` and `eventIds` are arrays or null (no filter).
 */
function buildMarketingReport({ from, to, nowIso, kinds = null, eventIds = null }) {
  const lower = from || "0001-01-01T00:00:00.000Z";
  const hasIds = Array.isArray(eventIds) ? 1 : 0;
  const idsJson = JSON.stringify(eventIds || []);
  const kindSet = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null;

  const out = {
    ok: true,
    generated_at: nowIso,
    range: { from: from || null, to, basis: "event_start" },
    filters: { kinds: kindSet ? [...kindSet] : [], event_ids: eventIds || [] },
    dry_run_excluded: 0,
    reach: null, engagement: null, outcomes: null, pipeline: null, events: [],
  };

  db.exec("BEGIN");
  try {
    out.dry_run_excluded = db.prepare(DRY_RUN_SQL).get(lower, to, nowIso, hasIds, idsJson, DRY_RUN_TAG).n;
    const events = db.prepare(EVENTS_SQL).all(lower, to, nowIso, hasIds, idsJson, DRY_RUN_TAG)
      .filter(ev => !kindSet || kindSet.has(eventKind(ev)));

    const byKind = Object.fromEntries(KIND_VALUES.map(k => [k, 0]));
    const eventsOf = new Map();      // person -> number of selected events
    let joined = 0, played = 0, answers = 0, quick = 0, answeredPairs = 0, solvedPairs = 0;
    let finished = 0, finishBase = 0, finishEvents = 0;
    const presence = { events_measured: 0, people_seen: 0, minutes: [] };
    const certificates = { placement: 0, participation: 0, completion: 0, not_recorded: 0, total: 0, shared: 0 };
    const programs = { events: 0, learners: 0, finished: 0, graded: 0, passed: 0, bands: {} };
    for (const k of [...GRADE_BAND_KEYS, TRY_AGAIN.key]) programs.bands[k] = 0;
    const pipeline = { events_asked: 0, leads: 0, hot: 0, warm: 0, cold: 0, follow_up_yes: 0, follow_up_no: 0, contacted: 0 };

    for (const ev of events) {
      const kind = eventKind(ev);
      byKind[kind]++;
      const f = _eventFigures(ev);
      for (const id of f.counted) eventsOf.set(id, (eventsOf.get(id) || 0) + 1);
      joined += f.counted.length;
      played += f.played.size;
      answers += f.answers; quick += f.quick_answers;
      answeredPairs += f.answered_pairs; solvedPairs += f.solved_pairs;
      if (f.visible) { finishEvents++; finishBase += f.played.size; finished += f.finished; }
      if (f.presence) { presence.events_measured++; presence.people_seen += f.presence.length; presence.minutes.push(...f.presence); }
      for (const k of Object.keys(certificates)) certificates[k] += f.certs[k];
      if (f.program) {
        programs.events++;
        for (const k of ["learners", "finished", "graded", "passed"]) programs[k] += f.program[k];
        for (const k of Object.keys(programs.bands)) programs.bands[k] += f.program.bands[k];
      }
      if (f.pipeline) {
        pipeline.events_asked++;
        for (const k of Object.keys(f.pipeline)) pipeline[k] += f.pipeline[k];
      }
      out.events.push({
        id: ev.id, name: ev.name, kind, start_time: ev.start_time,
        joined: f.counted.length, played: f.played.size,
        answers: f.answers,
        answered_pairs: f.answered_pairs, solved_pairs: f.solved_pairs,
        solve_rate: f.answered_pairs ? f.solved_pairs / f.answered_pairs : null,
        scoring_questions: f.visible,
        finished: f.visible ? f.finished : null,
        completion: f.visible && f.played.size ? f.finished / f.played.size : null,
        certificates: f.certs.total,
        asked_qualifying: !!f.pipeline,
        hot_leads: f.pipeline ? f.pipeline.hot : null,
      });
    }

    // Reach: the people, once each.
    const people = [...eventsOf.keys()];
    const users = people.length ? db.prepare(
      `SELECT id, created_at, registered_via, invitation_id, registration_competition_id, country, company
         FROM users WHERE id IN (SELECT value FROM json_each(?))`
    ).all(JSON.stringify(people)) : [];
    const fromMs = from ? Date.parse(from) : -Infinity, toMs = Date.parse(to);
    const newBy = Object.fromEntries(ACCOUNT_SOURCES.map(k => [k, 0]));
    let newTotal = 0;
    const countries = new Map(), countryLabel = new Map(), companies = new Map(), companySpell = new Map();
    let noCountry = 0, noCompany = 0;
    for (const u of users) {
      const c = Date.parse(u.created_at);
      if (Number.isFinite(c) && c >= fromMs && c < toMs) { newTotal++; newBy[accountSource(u)]++; }
      // One row per country whatever spelling the profile holds (lib/countries.js:
      // a code, a select name, USA, UK...); an unrecognised value as typed.
      const country = countryName(u.country);
      if (country) {
        countries.set(country.key, (countries.get(country.key) || 0) + 1);
        if (!countryLabel.has(country.key)) countryLabel.set(country.key, country.name);
      } else noCountry++;
      const raw = String(u.company || "").trim();
      const key = normaliseCompany(raw);
      if (!key) { noCompany++; continue; }
      companies.set(key, (companies.get(key) || 0) + 1);
      // Shown as its most common spelling (ties: the first in code-point order).
      const sp = companySpell.get(key) || new Map();
      sp.set(raw, (sp.get(raw) || 0) + 1);
      companySpell.set(key, sp);
    }
    // Ranked by count, ties by the name shown (never by the code behind it).
    const countryTop = _top(new Map([...countries].map(([k, n]) => [countryLabel.get(k), n])), TOP_N, noCountry);
    const companyTop = _top(companies, TOP_N, noCompany);
    for (const row of companyTop.top) {
      const sp = [...companySpell.get(row.name).entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      row.name = sp[0][0];
    }

    out.reach = {
      events: events.length, events_by_kind: byKind,
      joined, people: people.length,
      returning: people.filter(id => eventsOf.get(id) > 1).length,
      new_accounts: { total: newTotal, by_source: newBy },
      countries: countryTop,
      companies: companyTop,
    };
    out.engagement = {
      joined, played, answers, quick_answers: quick,
      answered_pairs: answeredPairs, solved_pairs: solvedPairs,
      finished, finish_base: finishBase, finish_events: finishEvents,
      presence: {
        events_measured: presence.events_measured, people_seen: presence.people_seen,
        median_minutes: _median(presence.minutes),
      },
    };
    // The bands' words, from the grade rule itself (the page names no band).
    programs.band_labels = [...GRADE_BANDS.map(b => ({ key: b.key, label: b.label })),
      { key: TRY_AGAIN.key, label: `Under ${PASS_PERCENT}% (${TRY_AGAIN.label.toLowerCase()})` }];
    out.outcomes = { certificates, programs };
    out.pipeline = pipeline;
  } finally {
    db.exec("COMMIT");
  }
  return out;
}

module.exports = { buildMarketingReport, accountSource, KIND_VALUES, ACCOUNT_SOURCES, TOP_N };
