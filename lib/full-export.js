"use strict";

// v8.15.0 — THE FULL EVENT EXPORT AND THE PERSON EXPORT.
//
// Builders only: the routes (routes/export-import.js) own the gates, the audit
// emit and the response. Every builder here is SYNCHRONOUS and reads inside one
// BEGIN … COMMIT snapshot, the analytics / activity-export shape, so a write
// landing mid-export cannot split the files; the leaderboard builders run
// after the snapshot with `fresh:true` (they write nothing but the frozen team
// board, which they own).
//
// THREE RULES. The second and third bind every section; the first decides whom
// the per-person files list:
//
//   * PARTICIPANT SET — wider than the activity export's (which lists only the
//     enrolled): everyone enrolled, plus anyone with a submission or a hint
//     in the event (removal keeps both), MINUS the `staff` tag unless the
//     event lets staff compete. `benchmark` is kept and
//     labelled. It decides who is in participants.csv, submissions.csv,
//     hints.csv, time.csv, feedback.csv and navigation.csv (feedback.csv only
//     for those still enrolled: a rating names no event, so it is read through
//     the membership). Two kinds of file are not drawn from it: the rankings
//     files are the leaderboard builders' own output, so they are consistent
//     with the boards by construction; and certificates.csv lists every
//     certificate issued in the event, whoever holds it now (an issued
//     certificate is a fact), so a holder who has left the set since (tagged
//     `staff`, say) keeps their row there, under the nickname frozen at issue.
//   * SEALED ANSWERS — a submitted answer to a sealed challenge IS its key, so
//     it is withheld from everyone but the challenge's author and a superadmin
//     who revealed it (and never to a competitor) — the admin Submissions rule,
//     asked through `answerVisibleFor`. Every other answer is participant data
//     and is included verbatim. No file carries an answer KEY.
//   * NO CAPABILITIES — no badge token, credential code, join token or code,
//     invitation id, password or code column, LinkedIn subject. CSV cells pass
//     through lib/csv.js, which neutralises formula triggers.

const db = require("../db");
const { swallowed } = require("./best-effort");
const { csvBuffer } = require("./csv");
const { buildZip } = require("./zip-writer");
const { getCompetitionTimeslots, competitionStatus, competitionEffectiveEnd, lateEntryStateFor, compareTaskNumbers } = require("./competitions");
const { eventKindLabel, eventPolicyForWire } = require("./event-policy");
const { buildAdminLeaderboard, buildGroupLeaderboard, rankingChoice, rankBasis } = require("./leaderboard");
const { taskSessionsMap } = require("./session-tasks");   // per-session question sets
const { staffCompeteOn } = require("./staff-compete");
const { submissionAnswerProjection } = require("./answer-seal");
const { scopedCompetitionIds, userEventCompetitionScopeSql, userEventDetailsSql, groupViewDenied } = require("./event-admin");
const { parseStoredDetails } = require("./audit");
const { POINTS } = require("./scoring");
const { qualifyingSql } = require("./qualifying");
const { BUCKET_MS } = require("./presence");
const { programGraded, programStanding, closedAttemptGrades, gradeLabel } = require("./program-grade");

const _yn = (v) => (v ? "Yes" : "No");
const _iso = (v) => (v ? String(v) : "");

/** (task row with answer_sealed, created_by_id, id) → may this request read its submitted answers?
 *  A thin adapter over lib/answer-seal.js `submissionAnswerProjection(req).visible`,
 *  the one definition the Submissions and Audit streams ask too. */
function answerVisibleFor(req) {
  const projection = submissionAnswerProjection(req);
  return (t) => !t || projection.visible({ _sealed: t.answer_sealed, _author: t.created_by_id, _task_id: t.id });
}

const SEALED_ANSWER_CELL = "(sealed — visible to the challenge's author only)";

// A person's invitations: those they claimed (user_id) and those sent to their
// address (any case, used or not, whoever claimed it), each once. A UNION of
// the two index searches (db.js idx_invitations_user, idx_invitations_email_nocase):
// the planner reads `user_id=? OR email=? COLLATE NOCASE` as a scan of every
// invitation. The rowid tie-break keeps one order for equal times.
const PERSON_INVITATIONS_SQL =
  "SELECT competition_ids, group_ids, invited_by, created_at, used_at, user_id, last_send_success FROM invitations "
  + "WHERE rowid IN (SELECT rowid FROM invitations WHERE user_id=? UNION SELECT rowid FROM invitations WHERE email=? COLLATE NOCASE) "
  + "ORDER BY created_at, rowid";

function _snapshot(fn) {
  db.exec("BEGIN");
  try { return fn(); }
  finally { try { db.exec("COMMIT"); } catch (e) { /* already rolled back */ swallowed("full-export:snapshot-commit", e); } }
}

// ─────────────────────────────────────────────────────────────────────────────
// Full event export
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_FILE_HEADERS = Object.freeze({
  "participants.csv": ["User ID", "Nickname", "First Name", "Last Name", "Salutation", "Email", "Secondary Email",
    "Company", "Work Title", "Job Function", "Country", "City", "Timezone", "Phone", "LinkedIn URL", "Registration Source",
    "Registered Through This Event", "Account Created", "Enrolled", "Assigned At", "Assigned By", "Added Directly",
    "Session", "Solve Clock Start", "Late Entrant", "Tags"],
  "challenges.csv": ["Challenge Ref", "Challenge ID", "Challenge", "Difficulty", "Points", "Answer Type", "Status", "Active", "Sealed", "Sessions"],
  "submissions.csv": ["User ID", "Nickname", "Challenge Ref", "Challenge ID", "Challenge", "Attempt Number", "Answer",
    "Correct", "Points Delta", "Submitted At", "Session"],
  "hints.csv": ["User ID", "Nickname", "Challenge Ref", "Challenge ID", "Challenge", "Points Deducted", "Revealed At", "Session"],
  "time.csv": ["User ID", "Nickname", "Solve Clock Start", "Time to Solve (ms)", "Finished At", "Time on Platform (ms)",
    "Presence First Seen", "Presence Last Seen"],
  "rankings-main.csv": ["Session", "Section", "Rank", "User ID", "Nickname", "First Name", "Last Name", "Company", "Email",
    "Score", "Solved All", "Time to Solve (ms)", "Time on Platform (ms)", "Incorrect Submissions", "Points Lost to Incorrect",
    "Hints Taken", "Points Lost to Hints", "Percent", "Max Points"],
  "rankings-late.csv": ["Session", "Rank", "User ID", "Nickname", "First Name", "Last Name", "Company", "Email",
    "Score", "Solved All", "Time to Solve (ms)", "Time on Platform (ms)", "Incorrect Submissions", "Points Lost to Incorrect",
    "Hints Taken", "Points Lost to Hints"],
  "rankings-groups.csv": ["Session", "Rank", "Row Type", "Group or Nickname", "Members", "Avg Score", "Avg Time to Solve (ms)",
    "Solved All", "Incorrect Submissions (team total)", "Points Lost (team total)"],
  "certificates.csv": ["User ID", "Nickname", "Basis", "Rank", "Score", "Date", "Late Entrant", "Shared", "Issued At", "Revoked At", "Session", "Board"],
  "feedback.csv": ["User ID", "Nickname", "Challenge Ref", "Challenge ID", "Challenge", "Rating", "Updated At"],
  "navigation.csv": ["User ID", "Nickname", "Challenge Ref", "Challenge ID", "Challenge", "Navigated Away"],
  // Program grades (27 Nov 2026): a Program's file only. One row per attempt:
  // each closed one (Try again) and the current one, which counts once Finished.
  "grades.csv": ["User ID", "Nickname", "Attempt", "Current", "Finished", "Points", "Maximum", "Grade %", "Grade", "Passed", "Closed At"],
  "event.csv": ["Field", "Value"],
});

/**
 * Every section of one event's export as `{ files: {name: {headers, rows}}, counts }`.
 * The caller has already checked scope, the competitor lock and existence.
 */
function buildEventExportData(req, comp) {
  const compId = comp.id;
  const slots = getCompetitionTimeslots(compId);
  const slotName = new Map(slots.map(s => [s.id, s.name]));
  const visible = answerVisibleFor(req);
  const staffOk = staffCompeteOn(comp);
  const snap = _snapshot(() => {
    const staff = staffOk ? new Set() : new Set(db.prepare("SELECT user_id FROM user_tags WHERE tag='staff'").all().map(r => r.user_id));
    const enrolled = db.prepare("SELECT * FROM competition_users WHERE competition_id=?").all(compId);
    const actorIds = new Set(enrolled.map(r => r.user_id));
    for (const r of db.prepare("SELECT DISTINCT user_id FROM submissions WHERE competition_id=? UNION SELECT DISTINCT user_id FROM hint_reveals WHERE competition_id=?").all(compId, compId)) actorIds.add(r.user_id);
    const ids = [...actorIds].filter(id => !staff.has(id));
    const users = ids.length
      ? db.prepare(`SELECT id, nickname, first_name, last_name, personal_title, email, secondary_email, company, title, job_function,
                           country, city, timezone, phone, linkedin_url, registered_via, registration_competition_id, created_at
                      FROM users WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids))
      : [];
    users.sort((a, b) => String(a.nickname || "").localeCompare(String(b.nickname || ""), undefined, { sensitivity: "base" }) || String(a.id).localeCompare(String(b.id)));
    const keep = new Set(users.map(u => u.id));
    const tagRows = keep.size ? db.prepare(`SELECT user_id, tag FROM user_tags WHERE user_id IN (SELECT value FROM json_each(?)) ORDER BY tag`).all(JSON.stringify([...keep])) : [];
    const challenges = db.prepare(
      `SELECT t.id, t.title, t.difficulty, t.answer_type, t.status, t.active, t.answer_sealed, t.created_by_id, ct.task_number,
              ${qualifyingSql("t")} AS is_qualifying
         FROM competition_tasks ct JOIN tasks t ON t.id = ct.task_id WHERE ct.competition_id=? ORDER BY t.title COLLATE NOCASE, t.id`
    ).all(compId);
    const subs = db.prepare(
      `SELECT s.user_id, s.task_id, s.answer, s.is_correct, s.points_delta, s.submitted_at, s.timeslot_id,
              t.title, t.answer_sealed, t.created_by_id
         FROM submissions s LEFT JOIN tasks t ON t.id = s.task_id
        WHERE s.competition_id=? ORDER BY s.submitted_at ASC, s.rowid ASC`
    ).all(compId).filter(r => keep.has(r.user_id));
    const hints = db.prepare(
      `SELECT h.user_id, h.task_id, h.points_deducted, h.revealed_at, h.timeslot_id, t.title
         FROM hint_reveals h LEFT JOIN tasks t ON t.id = h.task_id WHERE h.competition_id=? ORDER BY h.revealed_at, h.user_id`
    ).all(compId).filter(r => keep.has(r.user_id));
    const presence = db.prepare("SELECT user_id, buckets, first_seen_at, last_seen_at FROM competition_presence WHERE competition_id=?").all(compId);
    const badges = db.prepare(
      "SELECT user_id, nickname_snapshot, basis, rank, score_snapshot, date_snapshot, late_entrant, shared_at, created_at, revoked_at, timeslot_id, board_kind, board_name FROM achievement_badges WHERE competition_id=? ORDER BY created_at"
    ).all(compId);
    const feedback = db.prepare(
      `SELECT f.user_id, f.task_id, f.rating, f.updated_at, t.title
         FROM task_feedback f
         JOIN competition_users cu ON cu.user_id = f.user_id AND cu.competition_id = ?
         JOIN competition_tasks ct ON ct.task_id = f.task_id AND ct.competition_id = ?
         JOIN tasks t ON t.id = f.task_id ORDER BY f.updated_at`
    ).all(compId, compId).filter(r => keep.has(r.user_id));
    const nav = db.prepare(
      `SELECT user_id, task_id, COUNT(*) AS n FROM challenge_events
        WHERE competition_id=? AND event_type='navigated_away' AND impersonated=0 GROUP BY user_id, task_id`
    ).all(compId).filter(r => keep.has(r.user_id));
    // Program grades: each enrolled learner's attempts, closed and current, read
    // in the same snapshot as their answers.
    const grades = [];
    if (programGraded(comp)) {
      for (const u of users) {
        if (!enrolled.some(r => r.user_id === u.id)) continue;
        for (const a of closedAttemptGrades(compId, u.id)) grades.push({ user_id: u.id, attempt: a.attempt_no, current: false, finished: true,
          points: a.points, max: a.max_points, permille: a.grade_permille, band: a.grade_band, closed_at: a.closed_at });
        const st = programStanding(u.id, comp);
        if (st.grade) grades.push({ user_id: u.id, attempt: st.attempt, current: true, finished: st.finished,
          points: st.grade.points, max: st.grade.max, permille: st.grade.permille, band: st.grade.band, closed_at: null });
      }
    }
    return { enrolled, users, tagRows, challenges, subs, hints, presence, badges, feedback, nav, grades };
  });

  const enrolMap = new Map(snap.enrolled.map(r => [r.user_id, r]));
  const userMap = new Map(snap.users.map(u => [u.id, u]));
  const nick = (id) => (userMap.get(id) || {}).nickname || "";
  const tagsOf = new Map();
  for (const r of snap.tagRows) { if (!tagsOf.has(r.user_id)) tagsOf.set(r.user_id, []); tagsOf.get(r.user_id).push(r.tag); }
  snap.challenges.sort((a, b) => compareTaskNumbers(a.task_number, b.task_number) || String(a.title || "").localeCompare(String(b.title || ""), undefined, { sensitivity: "base" }) || String(a.id).localeCompare(String(b.id)));
  const chMap = new Map(snap.challenges.map(c => [c.id, c]));
  const num = (tid) => (chMap.get(tid) || {}).task_number || "";

  const files = {};
  const put = (name, rows) => { files[name] = { headers: EVENT_FILE_HEADERS[name], rows }; };

  const effEnd = competitionEffectiveEnd(comp, slots);
  put("event.csv", [
    ["Event ID", comp.id], ["Name", comp.name], ["Event Type", eventKindLabel(comp)],
    ["Start", comp.start_time], ["Effective End", effEnd ? effEnd.toISOString() : ""],
    ["Status", competitionStatus(comp, slots)], ["Leaderboard Mode", comp.leaderboard_mode || ""],
    // Per-session question sets: which boards it ranks on, and how the overall one ranks.
    ["Ranking", ({ per_session: "A winner per session", overall: "One overall winner", both: "Per session and overall" })[rankingChoice(comp)] || ""],
    ["Overall Board Ranks by Percentages", rankBasis(comp, null) === "percent" ? "Yes" : "No"],
    ["Sessions", String(slots.length)], ["Staff Compete", _yn(comp.staff_compete)],
    ["Measures Time on Platform", _yn(comp.measure_presence)],
    ["Exported At", new Date().toISOString()],
  ]);

  put("participants.csv", snap.users.map(u => {
    const cu = enrolMap.get(u.id);
    let late = "";
    if (cu) { const le = lateEntryStateFor(comp, u.id, slots); if (le.allowed) late = _yn(le.isLate); }
    return [u.id, u.nickname, u.first_name, u.last_name, u.personal_title, u.email, u.secondary_email, u.company, u.title,
      u.job_function, u.country, u.city, u.timezone, u.phone, u.linkedin_url, u.registered_via,
      _yn(u.registration_competition_id === compId), _iso(u.created_at), _yn(!!cu),
      cu ? _iso(cu.assigned_at) : "", cu ? (cu.assigned_by || "") : "", cu ? _yn(cu.direct_assigned) : "",
      cu && cu.timeslot_id ? (slotName.get(cu.timeslot_id) || "") : "", cu ? _iso(cu.login_time) : "",
      late, (tagsOf.get(u.id) || []).join("; ")];
  }));

  // Sessions: the sessions a question is in (per-session question sets), by
  // name; "All sessions" where it is in every one; blank with fewer than two.
  const _taskSess = taskSessionsMap(db, compId);
  const _sessCell = (tid) => (slots.length < 2 ? "" : (_taskSess.has(tid) ? _taskSess.get(tid).map(id => slotName.get(id) || id).join("; ") : "All sessions"));
  put("challenges.csv", snap.challenges.map(c => [c.id, c.task_number || "", c.title, c.difficulty, c.is_qualifying ? 0 : (POINTS[c.difficulty] ?? ""),
    c.answer_type, c.status, _yn(c.active), _yn(c.answer_sealed), _sessCell(c.id)]));

  const attempt = new Map();
  let sealedWithheld = 0;
  put("submissions.csv", snap.subs.map(s => {
    const k = s.user_id + " " + s.task_id;
    const n = (attempt.get(k) || 0) + 1;
    attempt.set(k, n);
    const shown = visible({ id: s.task_id, answer_sealed: s.answer_sealed, created_by_id: s.created_by_id });
    if (!shown) sealedWithheld++;
    return [s.user_id, nick(s.user_id), s.task_id, num(s.task_id), s.title || "", n,
      shown ? (s.answer ?? "") : SEALED_ANSWER_CELL, _yn(s.is_correct === 1), s.points_delta,
      _iso(s.submitted_at), s.timeslot_id ? (slotName.get(s.timeslot_id) || "") : ""];
  }));

  put("hints.csv", snap.hints.map(h => [h.user_id, nick(h.user_id), h.task_id, num(h.task_id), h.title || "",
    h.points_deducted, _iso(h.revealed_at), h.timeslot_id ? (slotName.get(h.timeslot_id) || "") : ""]));

  // Boards: one per session in per-slot mode, else the one event board; and on
  // an event ranking per session AND overall, the overall board too (Session
  // "Overall").
  const _both = slots.length >= 2 && rankingChoice(comp) === "both";
  const tsList = comp.leaderboard_mode === "per_slot" && slots.length ? [...(_both ? [null] : []), ...slots.map(s => s.id)] : [null];
  const boards = tsList.map(ts => ({ ts, rows: buildAdminLeaderboard(compId, ts, { fresh: true }) }));
  const ranked = !!eventPolicyForWire(comp).ranking_enabled;
  const presMeasured = !!comp.measure_presence;
  const presMap = new Map(snap.presence.map(p => [p.user_id, p]));
  const timeRow = new Map();
  for (const b of boards) for (const e of b.rows) if (!timeRow.has(e.userId)) timeRow.set(e.userId, e);
  put("time.csv", snap.users.map(u => {
    const e = timeRow.get(u.id);
    const p = presMap.get(u.id);
    const cu = enrolMap.get(u.id);
    return [u.id, u.nickname, cu ? _iso(cu.login_time) : "", e ? e.solveTimeMs : "", e && e.finishTime ? e.finishTime : "",
      presMeasured ? (p ? p.buckets * BUCKET_MS : 0) : "", p ? _iso(p.first_seen_at) : "", p ? _iso(p.last_seen_at) : ""];
  }));

  const sess = (ts) => (ts ? (slotName.get(ts) || ts) : (_both ? "Overall" : "All"));
  const boardCells = (e) => [e.userId, e.nickname, e.firstName, e.lastName, e.company, e.email, e.score, _yn(e.allSolved),
    e.solveTimeMs, e.presenceMs === null || e.presenceMs === undefined ? "" : e.presenceMs,
    e.incorrectCount, e.pointsLostIncorrect, e.hintCount, e.pointsLostHints];
  const mainRows = [], lateRows = [], groupRows = [];
  if (ranked) {
    for (const b of boards) {
      for (const e of b.rows) {
        if (e.isLateEntrant) lateRows.push([sess(b.ts), e.rank, ...boardCells(e)]);
        else mainRows.push([sess(b.ts), e.isBenchmark ? "benchmark" : "main", e.rank === null ? "" : e.rank, ...boardCells(e),
          e.percent === undefined ? "" : e.percent, e.maxPoints === undefined ? "" : e.maxPoints]);
      }
      const g = buildGroupLeaderboard(compId, b.ts, { fresh: true });
      if (Array.isArray(g)) {
        g.forEach((r, i) => groupRows.push([sess(b.ts), r.rank ?? (i + 1), r.type, r.type === "group" ? r.name : r.nickname,
          r.type === "group" ? r.memberCount : 1, r.score, r.solveTimeMs, _yn(r.allSolved), r.incorrectCount ?? "", r.pointsLostTotal ?? ""]));
      }
    }
  }
  put("rankings-main.csv", mainRows);
  put("rankings-late.csv", lateRows);
  put("rankings-groups.csv", groupRows);

  put("certificates.csv", snap.badges.map(b => [b.user_id, nick(b.user_id) || b.nickname_snapshot || "", b.basis || "",
    b.rank ?? "", b.score_snapshot ?? "", _iso(b.date_snapshot), _yn(b.late_entrant), _yn(b.shared_at), _iso(b.created_at),
    _iso(b.revoked_at), b.timeslot_id ? (slotName.get(b.timeslot_id) || "") : "",
    b.board_kind === "overall" ? "Overall" : (b.board_kind === "session" ? (b.board_name || "") : "")]));

  put("feedback.csv", snap.feedback.map(f => [f.user_id, nick(f.user_id), f.task_id, num(f.task_id), f.title || "", f.rating, _iso(f.updated_at)]));
  put("navigation.csv", snap.nav.map(n => [n.user_id, nick(n.user_id), n.task_id, num(n.task_id), (chMap.get(n.task_id) || {}).title || "", n.n]));
  if (programGraded(comp)) {
    put("grades.csv", snap.grades.map(g => [g.user_id, nick(g.user_id), g.attempt, _yn(g.current), _yn(g.finished), g.points, g.max,
      (g.permille / 10).toFixed(1), gradeLabel(g.band) || g.band, _yn(g.band !== "try_again"), _iso(g.closed_at)]));
  }

  return {
    files,
    counts: {
      participants: snap.users.length, challenges: snap.challenges.length, submissions: snap.subs.length,
      hints: snap.hints.length, certificates: snap.badges.length, feedback: snap.feedback.length,
      sealed_answers_withheld: sealedWithheld, ranked,
    },
  };
}

/** Render `{files}` as a ZIP of CSVs (formula-neutralised, BOM-prefixed). */
async function filesToZip(files, readme) {
  const entries = [];
  if (readme) entries.push({ name: "README.txt", data: readme });
  for (const [name, f] of Object.entries(files)) entries.push({ name, data: csvBuffer(f.headers, f.rows) });
  return buildZip(entries);
}

// ─────────────────────────────────────────────────────────────────────────────
// Person export
// ─────────────────────────────────────────────────────────────────────────────

// An ALLOW-LIST, never `SELECT *` minus a deny-list: the next credential column
// added to `users` must not ship here because nobody remembered this file.
const PERSON_PROFILE_FIELDS = Object.freeze([
  "id", "nickname", "first_name", "last_name", "personal_title", "email", "secondary_email", "pending_email",
  "company", "title", "job_function", "country", "city", "timezone", "phone", "linkedin_url", "avatar",
  "registered_via", "role", "verified", "approved", "approved_at", "approved_by", "blocked", "denied_at",
  "denied_reason", "created_at", "first_verified_at", "last_login_time", "invited_at", "invited_by",
  "certificate_given_name", "certificate_family_name", "registration_competition_id", "updated_at",
]);

// profile.csv's Field column: the UI's own labels, never schema names (a header
// is the contract with the person reading the file; the People CSV and
// participants.csv use the same words). The JSON keeps the schema keys, its
// contract. Every PERSON_PROFILE_FIELDS entry, plus `tags`, needs one.
const PERSON_PROFILE_LABELS = Object.freeze({
  id: "User ID", nickname: "Nickname", first_name: "First Name", last_name: "Last Name", personal_title: "Salutation",
  email: "Email", secondary_email: "Secondary Email", pending_email: "Pending Email", company: "Company",
  title: "Work Title", job_function: "Job Function", country: "Country", city: "City", timezone: "Timezone",
  phone: "Phone", linkedin_url: "LinkedIn URL", avatar: "Avatar", registered_via: "Registration Source", role: "Role",
  verified: "Verified", approved: "Approved", approved_at: "Approved At", approved_by: "Approved By", blocked: "Blocked",
  denied_at: "Denied Date", denied_reason: "Denial Reason", created_at: "Registered", first_verified_at: "First Verified",
  last_login_time: "Last Login", invited_at: "Invited", invited_by: "Invited By",
  certificate_given_name: "Certificate Given Name", certificate_family_name: "Certificate Family Name",
  registration_competition_id: "Registration Event ID", updated_at: "Updated At", tags: "Tags",
});

// History rows are narrowed by `userEventCompetitionScopeSql` alone — the one
// definition the History dialog uses too. It withholds a row naming ANY event
// outside the actor's scope (`competition_id`, `active_competition_changed`'s
// `from`/`to`, or any existing event or session id anywhere in the details);
// never add a second, JS-side filter here.

const _SIGN_IN_EVENT =/^(login_|logout|superadmin_login|linkedin_login|sessions_invalidated)/;

/**
 * One person's profile and history (the sections personExportFiles writes),
 * narrowed for a scoped actor to rows about the events they organise. The
 * caller has already run `participantDenied`; returns null for an unknown user.
 * Not read here: `event_leads` (the event team's lead record),
 * `competition_presence` (time on the platform) and `challenge_events`
 * (navigation); the event export carries the last two per event.
 */
function buildPersonExportData(req, userId) {
  const scope = scopedCompetitionIds(req);             // null = unscoped, [] = nothing
  const inScope = (cid) => scope === null || (!!cid && scope.includes(cid));
  const visible = answerVisibleFor(req);
  const evScope = userEventCompetitionScopeSql(req);
  const out = _snapshot(() => {
    const u = db.prepare(`SELECT ${PERSON_PROFILE_FIELDS.join(", ")} FROM users WHERE id=?`).get(userId);
    if (!u) return null;
    if (!inScope(u.registration_competition_id)) u.registration_competition_id = null;
    if (typeof u.avatar === "string" && u.avatar.startsWith("data:")) u.avatar = "(uploaded image)";
    const compName = new Map(db.prepare("SELECT id, name, event_kind FROM competitions").all().map(c => [c.id, c]));
    const cname = (cid) => (compName.get(cid) || {}).name || null;
    const memberships = db.prepare(
      `SELECT cu.competition_id, cu.timeslot_id, cu.assigned_at, cu.assigned_by, cu.direct_assigned, cu.login_time, cu.last_login_time, ts.name AS session
         FROM competition_users cu LEFT JOIN competition_timeslots ts ON ts.id = cu.timeslot_id WHERE cu.user_id=? ORDER BY cu.assigned_at`
    ).all(userId).filter(r => inScope(r.competition_id)).map(r => ({ ...r, competition_name: cname(r.competition_id), event_kind: (compName.get(r.competition_id) || {}).event_kind || null }));
    const absences = db.prepare(
      `SELECT a.*, ts.name AS session FROM competition_user_absences a LEFT JOIN competition_timeslots ts ON ts.id = a.timeslot_id
        WHERE a.user_id=? ORDER BY a.removed_at`
    ).all(userId).filter(r => inScope(r.competition_id)).map(r => ({ ...r, competition_name: cname(r.competition_id) }));
    const submissions = db.prepare(
      `SELECT s.competition_id, s.task_id, s.timeslot_id, s.answer, s.is_correct, s.points_delta, s.submitted_at,
              t.title, t.answer_sealed, t.created_by_id
         FROM submissions s LEFT JOIN tasks t ON t.id = s.task_id WHERE s.user_id=? ORDER BY s.submitted_at, s.rowid`
    ).all(userId).filter(r => inScope(r.competition_id));
    const attempt = new Map();
    const subsOut = submissions.map(s => {
      const k = s.competition_id + " " + s.task_id;
      const n = (attempt.get(k) || 0) + 1;
      attempt.set(k, n);
      const shown = visible({ id: s.task_id, answer_sealed: s.answer_sealed, created_by_id: s.created_by_id });
      return {
        competition_id: s.competition_id, competition_name: cname(s.competition_id), task_id: s.task_id, challenge: s.title || null,
        attempt_number: n, answer: shown ? s.answer : null, answer_sealed: !!s.answer_sealed, answer_visible: shown,
        correct: s.is_correct === 1, points_delta: s.points_delta, submitted_at: s.submitted_at, timeslot_id: s.timeslot_id || null,
      };
    });
    const hints = db.prepare(
      `SELECT h.competition_id, h.task_id, h.timeslot_id, h.points_deducted, h.revealed_at, t.title AS challenge
         FROM hint_reveals h LEFT JOIN tasks t ON t.id = h.task_id WHERE h.user_id=? ORDER BY h.revealed_at`
    ).all(userId).filter(r => inScope(r.competition_id)).map(r => ({ ...r, competition_name: cname(r.competition_id) }));
    // Feedback carries no event: a scoped actor sees a rating only on a
    // challenge one of their events holds.
    let feedback = db.prepare(
      "SELECT f.task_id, f.rating, f.updated_at, t.title AS challenge FROM task_feedback f LEFT JOIN tasks t ON t.id = f.task_id WHERE f.user_id=? ORDER BY f.updated_at"
    ).all(userId);
    if (scope !== null) {
      const held = new Set(scope.length
        ? db.prepare(`SELECT DISTINCT task_id FROM competition_tasks WHERE competition_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(scope)).map(r => r.task_id)
        : []);
      feedback = feedback.filter(f => held.has(f.task_id));
    }
    const certificates = db.prepare(
      "SELECT competition_id, timeslot_id, basis, rank, score_snapshot, date_snapshot, late_entrant, shared_at, created_at, revoked_at FROM achievement_badges WHERE user_id=? ORDER BY created_at"
    ).all(userId).filter(r => inScope(r.competition_id)).map(r => ({ ...r, competition_name: cname(r.competition_id) }));
    const events = db.prepare(
      `SELECT event_type, changed_by, changed_at, ${userEventDetailsSql(req)} AS details FROM user_events WHERE user_id=?${evScope.clause} ORDER BY changed_at, rowid`
    ).all(userId, ...evScope.params).map(e => (
      // The one parser: text that is not JSON is `{ details_unreadable: true }`.
      { event_type: e.event_type, changed_by: e.changed_by, changed_at: e.changed_at, details: parseStoredDetails(e.details) }
    ));
    // Invitations: matched on the account or its address. The invitation id is
    // a registration capability and never ships; a scoped actor sees an
    // invitation only when it names one of their events, trimmed to those.
    const invRows = db.prepare(PERSON_INVITATIONS_SQL).all(userId, u.email || "");
    const invitations = [];
    for (const inv of invRows) {
      let cids = [];
      try { const v = JSON.parse(inv.competition_ids || "[]"); if (Array.isArray(v)) cids = v.filter(x => typeof x === "string"); } catch (_) { cids = []; }
      const shown = cids.filter(inScope);
      if (scope !== null && !shown.length) continue;
      invitations.push({
        competitions: shown.map(cid => ({ competition_id: cid, competition_name: cname(cid) })),
        invited_by: inv.invited_by, created_at: inv.created_at, used_at: inv.used_at,
        claimed_by_this_account: inv.user_id === userId, last_send_success: inv.last_send_success,
      });
    }
    const groups = db.prepare(
      "SELECT g.id AS group_id, g.name, gm.added_at, gm.added_by FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id=? ORDER BY g.name"
    ).all(userId).filter(g => !groupViewDenied(req, g.group_id));
    const tags = db.prepare("SELECT tag FROM user_tags WHERE user_id=? ORDER BY tag").all(userId).map(r => r.tag);
    return { profile: { ...u, tags }, memberships, absences, submissions: subsOut, hints, feedback, certificates,
      events, invitations, groups };
  });
  if (!out) return null;
  out.emails = out.events.filter(e => e.event_type === "email_sent" || e.event_type === "email_suppressed");
  out.sign_ins = out.events.filter(e => _SIGN_IN_EVENT.test(e.event_type));
  out.scoped_to_your_events = scope !== null;
  return out;
}

/**
 * The person export as CSV files, one per section. (The emails and sign-ins
 * sections are subsets of the history, which history.csv holds whole.)
 */
function personExportFiles(data) {
  const f = {};
  const add = (name, headers, rows) => { f[name] = { headers, rows }; };
  const p = data.profile;
  add("profile.csv", ["Field", "Value"], Object.entries(p).map(([k, v]) => [PERSON_PROFILE_LABELS[k] || k, Array.isArray(v) ? v.join("; ") : (v ?? "")]));
  add("memberships.csv", ["Event ID", "Event", "Event Type", "Session", "Assigned At", "Assigned By", "Added Directly", "Solve Clock Start", "Last Entered"],
    data.memberships.map(m => [m.competition_id, m.competition_name, m.event_kind, m.session || "", _iso(m.assigned_at), m.assigned_by || "", _yn(m.direct_assigned), _iso(m.login_time), _iso(m.last_login_time)]));
  // Each time they were taken out of an event, and whether they came back; a
  // re-add restores the solve-clock start and join time recorded here.
  add("absences.csv", ["Event ID", "Event", "Session", "Removed At", "Returned At", "Solve Clock Start", "Assigned At"],
    data.absences.map(a => [a.competition_id, a.competition_name || "", a.session || "", _iso(a.removed_at), _iso(a.returned_at), _iso(a.login_time), _iso(a.assigned_at)]));
  add("submissions.csv", ["Event ID", "Event", "Challenge Ref", "Challenge", "Attempt Number", "Answer", "Correct", "Points Delta", "Submitted At"],
    data.submissions.map(s => [s.competition_id, s.competition_name, s.task_id, s.challenge, s.attempt_number, s.answer_visible ? (s.answer ?? "") : SEALED_ANSWER_CELL, _yn(s.correct), s.points_delta, s.submitted_at]));
  add("hints.csv", ["Event ID", "Event", "Challenge Ref", "Challenge", "Points Deducted", "Revealed At"],
    data.hints.map(h => [h.competition_id, h.competition_name, h.task_id, h.challenge, h.points_deducted, _iso(h.revealed_at)]));
  add("feedback.csv", ["Challenge Ref", "Challenge", "Rating", "Updated At"], data.feedback.map(x => [x.task_id, x.challenge, x.rating, _iso(x.updated_at)]));
  add("certificates.csv", ["Event ID", "Event", "Basis", "Rank", "Score", "Date", "Late Entrant", "Shared", "Issued At", "Revoked At"],
    data.certificates.map(c => [c.competition_id, c.competition_name, c.basis || "", c.rank ?? "", c.score_snapshot ?? "", _iso(c.date_snapshot), _yn(c.late_entrant), _yn(c.shared_at), _iso(c.created_at), _iso(c.revoked_at)]));
  add("history.csv", ["Event Type", "Changed By", "Changed At", "Details"], data.events.map(e => [e.event_type, e.changed_by, e.changed_at, e.details ? JSON.stringify(e.details) : ""]));
  add("invitations.csv", ["Events", "Invited By", "Created At", "Used At", "Claimed By This Account", "Last Send Succeeded"],
    data.invitations.map(i => [i.competitions.map(c => c.competition_name || c.competition_id).join("; "), i.invited_by || "", _iso(i.created_at), _iso(i.used_at), _yn(i.claimed_by_this_account), i.last_send_success === null || i.last_send_success === undefined ? "" : _yn(i.last_send_success)]));
  add("groups.csv", ["Group", "Added At", "Added By"], data.groups.map(g => [g.name, _iso(g.added_at), g.added_by || ""]));
  return f;
}

module.exports = {
  PERSON_PROFILE_FIELDS, PERSON_PROFILE_LABELS, PERSON_INVITATIONS_SQL,
  answerVisibleFor, buildEventExportData, buildPersonExportData, personExportFiles, filesToZip,
};
