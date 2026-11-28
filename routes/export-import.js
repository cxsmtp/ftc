"use strict";

// Admin export routes (tasks / participants / competitions / settings → JSON|CSV).
// The import routes stay inline in server.js (test-pinned). (v7.0.0 route split.)

const fs = require("fs");
const path = require("path");
const db = require("../db");
const { _slugForDownload, fileNameSlug } = require("../lib/attachments");
const { getAdminIdentity, recordOrphanedAuditEvent, reqContext } = require("../lib/audit");
const { swallowed } = require("../lib/best-effort");
const { getCompetition, getCompetitionTimeslots, competitionStatus, competitionFullyEnded, ensureTaskNumbers, compareTaskNumbers } = require("../lib/competitions");
const { DATA_DIR } = require("../lib/config");
const { csvBuffer } = require("../lib/csv");
const { actorId, actingAdminId, sealRevealSet, competitorIds, competitionDenied, scopeFilterSql, scopedCompetitionIds, participantVisibilityScope, PUBLIC_DOMAIN_TAG } = require("../lib/event-admin"); // v8.7.0, v8.8.4, v8.12.1
// v8.10.0 — the sealed answer. The tasks export and the free-text response
// export are two of its four egress paths; see lib/answer-seal.js.
const { answerSealed, sealedAnswerReadable } = require("../lib/answer-seal");
const { competitorEventsForTask, competitorEditDenied, refuseCompetitor } = require("../lib/staff-compete"); // v8.12.0 — the hint is withheld from a competitor on the tasks export
const { participantDenied } = require("../lib/event-admin"); // v8.15.0 — the person export
const { buildEventExportData, buildPersonExportData, personExportFiles, filesToZip } = require("../lib/full-export"); // v8.15.0
const { _REDACT_KEYS, log } = require("../lib/log");
const { rateLimit, requireAdmin, requireSuperAdmin, csrfProtection, adminAuthzDenied, testAdminCommitPark } = require("../lib/middleware");
const { invalidateEventAdminScope } = require("../lib/event-admin"); // sweep #235 — the top-three ZIP's send-time scope, read fresh
const certificateDispatch = require("../lib/certificate-dispatch"); // top-three ZIP: the one PDF render, pending jobs
const { deflateZipEntries, assembleZip } = require("../lib/zip-writer");
const { encodeQr, qrSvg } = require("../lib/qr");
const { recordCompetitionEvent } = require("../lib/audit");
const { POINTS } = require("../lib/scoring");
const { qualifyingSql } = require("../lib/qualifying");
const { now } = require("../lib/time");

const exportLimiter = rateLimit(60_000, 10, "export");
// The join QR's label box, as fractions of the symbol's width (lib/qr.js
// `centre`). Read back at 120-1600 px by the suite's own QR reader
// (tests/qr-decode.spec.js).
const JOIN_QR_CENTRE = Object.freeze({ w: 0.44, h: 0.19 });
// Total raw attachment bytes across the whole export (base64 inflates ~33%, so
// the on-wire JSON stays under ~128 MB — matching the import body limit).
const EXPORT_MAX_ATTACHMENT_BYTES_TOTAL = 96 * 1024 * 1024;

// Inline /api/images/<id> refs (rich text) + avatar refs as data: URIs so an
// export is self-contained. Export-only helpers.
function inlineImageRefs(html) {
  if (!html) return html;
  return html.replace(/src\s*=\s*"(\/api\/images\/([^"]+))"/gi, (match, fullUrl, imgId) => {
    const img = db.prepare("SELECT data, mime_type FROM images WHERE id=?").get(imgId);
    if (!img) return match;
    const b64 = Buffer.from(img.data).toString("base64");
    return `src="data:${img.mime_type};base64,${b64}"`;
  });
}
function inlineAvatar(avatarStr) {
  if (!avatarStr || !avatarStr.startsWith("/api/images/")) return avatarStr || "default1";
  const imgId = avatarStr.replace("/api/images/", "");
  const img = db.prepare("SELECT data, mime_type FROM images WHERE id=?").get(imgId);
  if (!img) return "default1";
  return `data:${img.mime_type};base64,${Buffer.from(img.data).toString("base64")}`;
}

// v8.7.0 — THE TWO NARROWING FRAGMENTS THIS FILE NEEDS, as SQL rather than a
// post-filter in JS: an export reads the whole table and the attachment scan
// below is driven by the rows this query returns, so filtering afterwards would
// still have read (and byte-capped) files for challenges the actor may not see.
// Both open with " AND " so they splice into an existing WHERE — the
// `scopeFilterSql` shape, and the reason the callers below carry `WHERE 1=1`.
//
// Challenge visibility is the SAME three-way rule as the challenges list and
// `taskViewDenied`: they created it, it is used by one of their events, or it
// carries the public-domain tag. The public-domain arm is unconditional, so the
// clause is never empty and the actor with NO grants still gets their own work
// and the shared pool — exactly what `taskViewDenied` answers for them.
function _taskVisibilityScope(req) {
  const ids = scopedCompetitionIds(req);
  if (ids === null) return { clause: "", params: [] };
  const me = actorId(req);
  const parts = [];
  const params = [];
  if (me) { parts.push("t.created_by_id = ?"); params.push(me); }
  parts.push("EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = t.id AND tt.tag = ?)");
  params.push(PUBLIC_DOMAIN_TAG);
  if (ids.length) {
    parts.push(`EXISTS (SELECT 1 FROM competition_tasks ct2 WHERE ct2.task_id = t.id AND ct2.competition_id IN (SELECT value FROM json_each(?)))`);
    params.push(JSON.stringify(ids));
    // An event's own question, and a bank question one of the events holds a
    // copy of (lib/event-copies.js), as lib/event-admin.js taskVisibilitySql.
    parts.push(`t.owner_competition_id IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(ids));
    parts.push(`EXISTS (SELECT 1 FROM tasks tcp JOIN competition_tasks tca ON tca.task_id = tcp.id AND tca.competition_id = tcp.owner_competition_id WHERE tcp.copied_from_task_id = t.id AND tcp.owner_competition_id IN (SELECT value FROM json_each(?)))`);
    params.push(JSON.stringify(ids));
  }
  return { clause: ` AND (${parts.join(" OR ")})`, params };
}

// A participant is visible when they are enrolled in at least one scoped event —
// `participantDenied`, expressed for a set rather than for one id. The empty-scope
// branch must be ` AND 1=0` and not an empty clause — an empty clause is the
// syntax error, so the naive "only filter when there are ids" yields the UNFILTERED
// export for precisely the actor who must see nobody.
// v8.8.4 — HOISTED to lib/event-admin.js, which owns every other scope
// predicate. The challenge-feedback route needed this exact fragment, and a
// second copy of a security predicate is the drift class this codebase keeps
// paying for. The local name stays so no call site here had to move.
const _participantVisibilityScope = (req) => participantVisibilityScope(req, "u");

module.exports = function register(app) {
app.get("/api/admin/export/tasks", requireAdmin, exportLimiter, async (req, res) => {
  const compId = typeof req.query.competitionId === "string" ? req.query.competitionId : null; // audit v7.7.38 (H3) — array param would bind into SQL → 500
  // include_attachment_content=0 → metadata-only attachments (smaller export
  // for the common case where the admin just wants the task definitions).
  // Default true so a round-trip import recreates the full state.
  const includeContent = !(req.query.include_attachment_content === "0" || req.query.include_attachment_content === "false");
  // v8.7.0 — `?competitionId=` NAMES an event, so an out-of-scope one is REFUSED
  // rather than narrowed to nothing. Filtering alone would hand back a file
  // holding this actor's own and public-domain challenges that happen to be used
  // by somebody else's event — an oblique disclosure about that event — and an
  // empty one would read as "that event has no challenges" (contract rule 2).
  if (compId) {
    const denied = competitionDenied(req, compId);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  // v8.7.0 — and the UNFILTERED export is narrowed to what this actor may SEE,
  // which is the whole point: before this it was every challenge on the platform,
  // correct answers included, for anyone who could reach the endpoint. The clause
  // is applied on BOTH branches: it is a no-op inside a scoped competition (rule
  // (b) matches every row there), and applying it uniformly means one filter to
  // keep true rather than a branch that is only right today.
  const _vis = _taskVisibilityScope(req);
  let tasks;
  if (compId) {
    tasks = db.prepare(
      "SELECT t.* FROM tasks t JOIN competition_tasks ct ON ct.task_id=t.id WHERE ct.competition_id=?" + _vis.clause + " ORDER BY t.difficulty, t.title"
    ).all(compId, ..._vis.params);
  } else {
    // The LIBRARY: bank questions only. An event's own questions (lib/event-copies.js)
    // leave with that event (`?competitionId=`, or the full event export).
    tasks = db.prepare("SELECT t.* FROM tasks t WHERE t.owner_competition_id IS NULL" + _vis.clause + " ORDER BY t.difficulty, t.title").all(..._vis.params);
  }
  const allTaskTags = db.prepare("SELECT task_id, tag FROM task_tags").all();
  const tagMap = {};
  for (const r of allTaskTags) (tagMap[r.task_id] = tagMap[r.task_id] || []).push(r.tag);

  // audit v7.7.29 (M6) — scope the attachment scan to the EXPORTED tasks when a
  // competition filter is given. Pre-fix this loaded + base64-read + byte-capped
  // EVERY attachment platform-wide regardless of ?competitionId, so a scoped
  // export of a small comp could 413 on the platform's total attachment size
  // (the error even told the admin to "scope by competition" — which they had),
  // and needlessly read up to the 96 MB cap of unrelated files first. attMap is
  // only consulted for the exported tasks anyway, so the extra rows were pure waste.
  //
  // v8.7.0 — and the SAME argument now applies with no `?competitionId` at all,
  // because the task list above is narrowed for an event admin: without this the
  // platform-wide branch would base64-read every attachment on the platform to
  // build a map consulted for three tasks, and could 413 a two-challenge export on
  // somebody else's files. Nothing leaked either way (attMap is only projected for
  // the exported tasks) — this is the waste and the false 413. An UNSCOPED actor
  // still takes the platform-wide branch exactly as before (the scoped read
  // binds its id list as one JSON value, so no list length is a limit).
  const _exportedTaskIds = tasks.map(t => t.id);
  const _attScoped = compId || scopedCompetitionIds(req) !== null;
  let attRows;
  if (_attScoped) {
    attRows = _exportedTaskIds.length
      ? db.prepare(
          "SELECT id, task_id, display_name, original_name, size_bytes, sha256, storage_path, order_idx " +
          `FROM task_attachments WHERE detached_at IS NULL AND task_id IN (SELECT value FROM json_each(?)) ORDER BY task_id, order_idx, created_at`
        ).all(JSON.stringify(_exportedTaskIds))
      : [];
  } else {
    attRows = db.prepare(
      "SELECT id, task_id, display_name, original_name, size_bytes, sha256, storage_path, order_idx " +
      "FROM task_attachments WHERE detached_at IS NULL ORDER BY task_id, order_idx, created_at"
    ).all();
  }
  const attMap = {};
  let runningBytes = 0;
  for (const a of attRows) {
    if (includeContent) {
      if (runningBytes + a.size_bytes > EXPORT_MAX_ATTACHMENT_BYTES_TOTAL) {
        return res.status(413).json({
          error: `Export exceeds ${EXPORT_MAX_ATTACHMENT_BYTES_TOTAL / (1024 * 1024)} MB attachment total. Scope by event or re-export with include_attachment_content=0.`,
        });
      }
      runningBytes += a.size_bytes;
    }
    const entry = {
      display_name: a.display_name,
      original_name: a.original_name,
      size_bytes: a.size_bytes,
      sha256: a.sha256,
      order_idx: a.order_idx,
    };
    if (includeContent) {
      try {
        // ext-audit v7.15.14 — ASYNC read + base64. This used to be
        // fs.readFileSync, so an export ran up to the 96 MB attachment cap of
        // synchronous disk reads plus the base64 encode on the single event
        // loop — every live request (a participant submitting, a leaderboard
        // poll) stalled behind it, and on slower storage that is seconds. The
        // read now goes to the libuv threadpool; the encode is unavoidably
        // main-thread but is a fraction of the cost.
        //
        // Inline path-containment guard (Checkmarx-recognized sanitizer) — see
        // the note in lib/attachments.js. The server-generated storage_path must
        // resolve strictly under DATA_DIR before we read it.
        const _base = path.resolve(DATA_DIR);
        const abs = path.resolve(path.join(DATA_DIR, String(a.storage_path || "")));
        if (!abs.startsWith(_base + path.sep)) throw new Error("attachment path escapes DATA_DIR");
        entry.content_b64 = (await fs.promises.readFile(abs)).toString("base64");
      } catch (e) {
        log.error({ ...reqContext(req), tag: "attachments", task_id: a.task_id, err: e && e.message }, "[attachments] export read failed");
        entry.content_b64 = null;
        entry.read_error = true;
      }
    }
    (attMap[a.task_id] = attMap[a.task_id] || []).push(entry);
  }

  // v8.10.0 — a sealed challenge exports WITHOUT its answer for anyone but its
  // author, and the flag itself is EXPORTED so an import cannot silently unseal it.
  //
  // The export is the cheapest bypass of every other redaction — one click, a JSON
  // file, and the key is off the platform and out of the audit trail's reach — and
  // it is `requireAdmin`, so a ZERO-GRANT event admin reaches it through the
  // public-domain arm of the visibility scope.
  //
  // `correct_answer: null` rather than an omitted key, deliberately: the tasks
  // drift guard requires every EXPORTED column to REACH the file, and the importer
  // must be able to tell "this row carried no answer" (skip it) from "this key was
  // absent from the format" (an older file). The `answer_sealed: 1` beside it is
  // what says which. `explanation` travels with it for the reason lib/answer-seal.js
  // gives.
  // v8.12.1 — the seal is asked about the HUMAN (`actingAdminId`), the
  // competitor lock about the SEAT (`actorId`); see routes/challenges.js.
  const _expActor = actingAdminId(req);
  // v8.12.2 — the SEAT AND THE HAND (`competitorIds`), the v8.12.1 rule every
  // other competitor door already follows: this line read `actorId(req)` alone
  // through a variable the source scanner cannot see, so a superadmin in an
  // organiser's seat who competes in event E exported E's hints (found by the
  // v8.12.2 read phase). And the superadmin's reveals, resolved once.
  const _expCompetes = competitorIds(req);
  const _expReveals = sealRevealSet(req);
  // v8.12.0 — THE HINT IS WITHHELD FROM A COMPETITOR HERE TOO, and since
  // v8.12.2 from a non-author of a SEALED challenge as well (the hint joined
  // SEALED_FIELDS): `null` plus `hint_withheld: 1`, the list's own shape, so
  // the importer can tell "no hint" from "withheld" (it must not overwrite a
  // real hint with an empty one on the way back in — the sealed-answer rule
  // one field over). The marker is emitted only when there WAS a hint.
  //
  // A COMPETITOR'S FILE WITHHOLDS THE ANSWER AND THE EXPLANATION TOO, WHATEVER
  // THE REVEAL MARKER SAYS — and the marker is the reason. The reveal route
  // refuses a competitor, so the only way into "revealed AND competing" is to
  // enrol AFTER the reveal (the assign door admits a staff member onto a compete
  // event, and neither enrolment path regenerates the session). Every other
  // admin projection already withholds on the competitor branch regardless of
  // the marker — the list, the versions, the PUT, the Submissions stream ("a row
  // that appeared later must not widen it") — and this file was the one that
  // did not, handing a superadmin the key of a challenge they now compete on in
  // one click: the back door the v8.12.0 seal invariant exists to close. Found
  // by the pre-release review.
  //
  // THE COMPETITOR RULE IS "THE REVEAL DOES NOT COUNT", NOT "HIDE EVERY ANSWER".
  // The first fix hid the key and explanation of EVERY challenge a competitor's
  // event holds — including an UNSEALED one — so a competitor's file carried
  // `correct_answer: null` on an unsealed row and the importer skipped it on the
  // way back in (found by the staff-compete-writers round trip, which PLANTS
  // that state: no door reaches it, an event where staff compete admitting
  // sealed challenges only). The admin LIST withholds that key from a
  // competitor; the file deliberately does not, being a round-trip artefact in
  // which a null key makes the row unimportable, for a state that exists only
  // when somebody wrote it into SQLite by hand. The seal's own answer, with the reveal
  // switched off for a competitor, is the whole rule: an unsealed key travels, a
  // sealed one travels only to its author. The HINT is withheld from a
  // competitor whatever the seal (v8.12.0), and from a non-reader of a sealed one.
  const _topicName = require("../lib/topics").topicNamesFor(db, _exportedTaskIds);
  const exported = tasks.map(t0 => {
    const _competes = competitorEventsForTask(db, _expCompetes, t0.id).length > 0;
    const _hide = !sealedAnswerReadable(t0, _expActor, _expReveals[t0.id] === true && !_competes);
    const _hintHidden = !!t0.hint && (_hide || _competes);
    const t = t0;
    return {
    title: t.title,
    description: inlineImageRefs(t.description || ""),
    difficulty: t.difficulty,
    answer_type: t.answer_type,
    correct_answer: _hide ? null : t.correct_answer,
    answer_sealed: answerSealed(t) ? 1 : 0,
    // v7.19.0 — multiple-choice options. Exported as the raw JSON string so an
    // export/import round-trip preserves choice IDs; correct_answer references
    // those IDs, so re-minting them on import would sever the link and leave a
    // question with no correct answer.
    choices: t.choices || null,
    // v8.1.0 — the challenge-level attempt ceiling. EXPORTED because the importer
    // honours it (see the two import branches), which is the bar the tasks drift
    // guard sets: a column reaches the file only when the target can act on it.
    attempt_cap: (Number.isInteger(t.attempt_cap) && t.attempt_cap > 0) ? t.attempt_cap : null,
    explanation: _hide ? null : inlineImageRefs(t.explanation || ""),
    hint: _hintHidden ? null : inlineImageRefs(t.hint || ""),
    ...(_hintHidden ? { hint_withheld: 1 } : {}),
    attachment_url: t.attachment_url || "",
    // v6.13.20 — author attribution. The UI renders these (public/app.js
    // task-detail "Author" line) and Swagger documents them on the
    // create/update routes, but the export projection used to drop them
    // — making export/import unsafe as a backup or migration path. The
    // SELECT * above already pulls them off the tasks table; the
    // projection just has to forward them.
    author_name: t.author_name || "",
    author_linkedin: t.author_linkedin || "",
    active: t.active,
    status: t.status || "published",
    tags: tagMap[t.id] || [],
    // Stage B — the question's topic by NAME (lib/topics.js): a topic id means
    // nothing on another server, so the import files the question under the
    // topic of this name, made there if missing. null for no topic.
    topic: _topicName.get(t.id) || null,
    attachments: attMap[t.id] || [],
  };
  });
  const data = { type: "hackarena-tasks", version: 1, exported_at: now().toISOString(), tasks: exported };
  const dateStr = now().toISOString().slice(0, 10);
  res.set("Content-Disposition", `attachment; filename="tasks-export-${dateStr}.json"`);
  // v6.16.29 — audit-trail completeness: every data export emits a
  // forensic event so an investigator can reconstruct who pulled what
  // and when. Closes the compliance gap where admins could exfiltrate
  // task definitions / participant PII / competition state with no
  // record. The orphan-scope ("export") avoids polluting the four
  // table-backed *_events streams; events surface in app.jsonl and
  // are retrievable via /api/admin/logs.
  try {
    recordOrphanedAuditEvent("export", "tasks", "data_exported", getAdminIdentity(req), {
      ...reqContext(req),
      task_count: exported.length,
      competition_id: compId || null,
      include_attachment_content: includeContent,
    });
  } catch (e) { swallowed("export-import:tasks-export-audit", e); }
  res.json(data);
});

app.get("/api/admin/export/participants", requireAdmin, exportLimiter, (req, res) => {
  const compId = typeof req.query.competitionId === "string" ? req.query.competitionId : null; // audit v7.7.38 (H3) — array param would bind into SQL → 500
  // v6.15.0 — full audit envelope. Pre-fix the SELECT picked up only
  // the editable subset, dropping every audit + provenance + role
  // field on the floor. Now we pull the columns the export needs
  // (the per-row projection below decides what actually ships).
  // Sensitive columns (password_hash, verify_code*, reset_code*,
  // failed_login_*) are intentionally omitted — see the schema-drift
  // EXCLUDED list in tests/functional-security.api.spec.js.
  const _USERS_SELECT = `
    u.id, u.first_name, u.last_name, u.nickname, u.company, u.title, u.personal_title, u.phone, u.certificate_given_name, u.certificate_family_name, u.email, u.secondary_email,
    u.avatar, u.verified, u.first_verified_at, u.blocked, u.approved, u.approved_at, u.approved_by,
    u.denied_at, u.denied_by, u.denied_reason,
    u.locked_until, u.login_time, u.last_login_time, u.created_at,
    u.country, u.timezone, u.job_function, u.city, u.linkedin_url, u.registered_via, u.role,
    u.profile_policy,
    u.invitation_id, u.invited_at, u.invited_by`;
  // v8.7.0 — a NAMED event is refused, exactly as on the tasks export above.
  if (compId) {
    const denied = competitionDenied(req, compId);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  }
  // v8.7.0 — and the unfiltered export is narrowed to participants enrolled in
  // one of the actor's events. This file carries the platform's densest PII
  // (every address, phone, employer and lifecycle timestamp), so an unscoped
  // export was the single largest disclosure reachable from this tier.
  //
  // BOTH branches now alias the table as `u`, which lets one clause serve them
  // both; the `.replace(/u\./g, "")` it replaces existed only because the
  // unfiltered branch had no join to alias. The projection below is unchanged —
  // SQLite names a bare column reference after the COLUMN, not the alias, which
  // is why the compId branch has always read `u.first_name` and produced
  // `first_name`.
  const _uvis = _participantVisibilityScope(req);
  let users;
  if (compId) {
    users = db.prepare(
      `SELECT ${_USERS_SELECT}
       FROM users u JOIN competition_users cu ON cu.user_id=u.id WHERE cu.competition_id=?${_uvis.clause} ORDER BY u.created_at`
    ).all(compId, ..._uvis.params);
  } else {
    users = db.prepare(
      `SELECT ${_USERS_SELECT} FROM users u WHERE 1=1${_uvis.clause} ORDER BY u.created_at`
    ).all(..._uvis.params);
  }
  const allTags = db.prepare("SELECT user_id, tag FROM user_tags").all();
  const tagMap = {};
  for (const t of allTags) (tagMap[t.user_id] = tagMap[t.user_id] || []).push(t.tag);
  // v6.20.0 — group membership, resolved by NAME for portability (the import
  // side re-creates groups by name). Mirrors the tag export shape.
  // v8.7.0 — narrowed to the groups this actor may SEE (`groupViewDenied`: they
  // created it, or it is bound to one of their events). Without it a single
  // export named every group on the platform — including groups that exist only
  // inside somebody else's event — for any participant who happens to be in one.
  // The file is correspondingly lossy for an event admin, which is the right
  // trade: they cannot manage those groups either.
  const _gScopeIds = scopedCompetitionIds(req);
  let _groupRows;
  if (_gScopeIds === null) {
    _groupRows = db.prepare("SELECT gm.user_id, gr.name FROM group_members gm JOIN groups gr ON gr.id=gm.group_id").all();
  } else {
    const _gPh = _gScopeIds.length ? "SELECT value FROM json_each(?)" : null;
    _groupRows = db.prepare(
      `SELECT gm.user_id, gr.name FROM group_members gm JOIN groups gr ON gr.id=gm.group_id
        WHERE gr.created_by_id = ?` +
      (_gPh ? ` OR EXISTS (SELECT 1 FROM competition_groups cg WHERE cg.group_id = gr.id AND cg.competition_id IN (${_gPh}))` : "")
    ).all(actorId(req), ...(_gPh ? [JSON.stringify(_gScopeIds)] : []));
  }
  const groupMap = {};
  for (const g of _groupRows)
    (groupMap[g.user_id] = groupMap[g.user_id] || []).push(g.name);

  // v6.15.0 — competition memberships, resolved by NAME so the export
  // is portable across server identities (UUIDs are local). The
  // import side will re-resolve competition_name back to a local
  // competition row at insert time. timeslot_name is null for
  // single-slot comps. assigned_at + login_time preserved verbatim.
  // v8.7.0 — the membership rows carry a competition NAME per participant, so
  // left unscoped this list is a directory of every event on the platform for
  // anyone who can reach the endpoint. Narrowed to the actor's own events; the
  // `1=0` branch inside `scopeFilterSql` is what makes an actor with no grants
  // export no memberships rather than all of them.
  const _mScope = scopeFilterSql(req, "cu.competition_id");
  const allMemberships = compId
    ? db.prepare(
        `SELECT cu.user_id, c.name AS competition_name, ts.name AS timeslot_name,
                cu.assigned_at, cu.login_time
         FROM competition_users cu
         JOIN competitions c ON c.id = cu.competition_id
         LEFT JOIN competition_timeslots ts ON ts.id = cu.timeslot_id
         WHERE cu.competition_id = ?${_mScope.clause}`
      ).all(compId, ..._mScope.params)
    : db.prepare(
        `SELECT cu.user_id, c.name AS competition_name, ts.name AS timeslot_name,
                cu.assigned_at, cu.login_time
         FROM competition_users cu
         JOIN competitions c ON c.id = cu.competition_id
         LEFT JOIN competition_timeslots ts ON ts.id = cu.timeslot_id
         WHERE 1=1${_mScope.clause}`
      ).all(..._mScope.params);
  const compMap = {};
  for (const m of allMemberships) {
    (compMap[m.user_id] = compMap[m.user_id] || []).push({
      competition_name: m.competition_name,
      timeslot_name: m.timeslot_name || null,
      assigned_at: m.assigned_at || null,
      login_time: m.login_time || null,
    });
  }

  // v6.16.6 — competition_user_absences carry the no-access gap
  // accounting added in v6.12.0 (remove → re-add subtracts the gap
  // from solveTimeMs). Pre-fix the v6.15.0 envelope dropped these
  // rows on the floor; an export → delete → re-import lost the gap
  // accounting and the leaderboard's solveTimeMs after re-import was
  // inflated by the no-access window. Resolved by name (competition
  // + optional timeslot) for portability across server identities.
  // v8.7.0 — same narrowing, same reason: an absence row names the event it was
  // an absence FROM.
  const _aScope = scopeFilterSql(req, "cua.competition_id");
  const allAbsences = compId
    ? db.prepare(
        `SELECT cua.user_id, c.name AS competition_name, ts.name AS timeslot_name,
                cua.removed_at, cua.returned_at, cua.login_time, cua.assigned_at
         FROM competition_user_absences cua
         JOIN competitions c ON c.id = cua.competition_id
         LEFT JOIN competition_timeslots ts ON ts.id = cua.timeslot_id
         WHERE cua.competition_id = ?${_aScope.clause}`
      ).all(compId, ..._aScope.params)
    : db.prepare(
        `SELECT cua.user_id, c.name AS competition_name, ts.name AS timeslot_name,
                cua.removed_at, cua.returned_at, cua.login_time, cua.assigned_at
         FROM competition_user_absences cua
         JOIN competitions c ON c.id = cua.competition_id
         LEFT JOIN competition_timeslots ts ON ts.id = cua.timeslot_id
         WHERE 1=1${_aScope.clause}`
      ).all(..._aScope.params);
  const absMap = {};
  for (const a of allAbsences) {
    (absMap[a.user_id] = absMap[a.user_id] || []).push({
      competition_name: a.competition_name,
      timeslot_name: a.timeslot_name || null,
      removed_at: a.removed_at,
      returned_at: a.returned_at || null,
      // v8.3.34 (external audit) — the SOLVE-CLOCK ANCHOR. v8.1.1 added
      // `competition_user_absences.login_time` so a remove-then-re-add restores
      // the participant's ORIGINAL anchor rather than re-anchoring to the rejoin
      // moment (which clamps a finisher's solveTimeMs and can hand them a tie
      // they did not win). Neither the export SELECT nor the import INSERT ever
      // named the column, so an export → import silently dropped the very thing
      // that release added — recorded as open in CLAUDE.md and closed here.
      // Mirrors the memberships projection above, which already carries
      // `cu.login_time`.
      login_time: a.login_time || null,
      // v8.12.6 — the ORIGINAL JOIN TIME, beside the anchor and for the same reason:
      // a late entrant is classified by when they joined, and a remove-then-re-add
      // restores it from here. NULL (a pre-v8.12.6 row) restores nothing.
      assigned_at: a.assigned_at || null,
    });
  }

  const exported = users.map(u => ({
    // Identity + profile
    first_name: u.first_name,
    last_name: u.last_name,
    nickname: u.nickname,
    email: u.email,
    secondary_email: u.secondary_email || "",
    company: u.company || "",
    title: u.title || "",
    personal_title: u.personal_title || "",
    // v8.1.0 (PR 24) — the certificate name, so a migration preserves how a
    // participant asked to be named on a formal record.
    certificate_given_name: u.certificate_given_name || "",
    certificate_family_name: u.certificate_family_name || "",
    phone: u.phone || "",
    country: u.country || "",
    timezone: u.timezone || "",
    job_function: u.job_function || "",
    city: u.city || "",
    linkedin_url: u.linkedin_url || "",
    registered_via: u.registered_via || "manual",
    // v8.1.1 — the registration policy the account was created under, and
    // losing it is a LOCKOUT rather than a lossy field: a Booth Event walk-up
    // filled EIGHT fields, so a re-imported account carrying NULL here is asked
    // for job_function and city by the NON-DISMISSIBLE completion gate — two
    // fields nobody ever collected from them, on a platform migration that is
    // exactly what this file exists for. The value is a stored DEAL, never a
    // reference or a derived value, so it ships verbatim.
    profile_policy: u.profile_policy || null,
    avatar: inlineAvatar(u.avatar),
    // Lifecycle flags
    verified: u.verified,
    // v7.6.0 — carry first_verified_at so a re-import preserves a once-verified
    // account's reaper exemption (without it, a round-trip would NULL it and the
    // unverified-account sweep could later delete a genuinely-verified user).
    first_verified_at: u.first_verified_at || null,
    blocked: u.blocked,
    approved: u.approved,
    role: u.role || "participant",
    // Approval / denial / lockout audit (v6.15.0)
    approved_at: u.approved_at || null,
    approved_by: u.approved_by || null,
    denied_at: u.denied_at || null,
    denied_by: u.denied_by || null,
    denied_reason: u.denied_reason || null,
    locked_until: u.locked_until || null,
    // Activity timestamps
    login_time: u.login_time || null,
    last_login_time: u.last_login_time || null,
    created_at: u.created_at || null,
    // Invitation provenance
    invitation_id: u.invitation_id || null,
    invited_at: u.invited_at || null,
    invited_by: u.invited_by || null,
    // Tags + groups + competition memberships
    tags: tagMap[u.id] || [],
    groups: groupMap[u.id] || [],
    competitions: compMap[u.id] || [],
    // v6.16.6 — absence rows for solveTimeMs gap accounting.
    absences: absMap[u.id] || [],
  }));
  // v6.15.0 — bumped envelope version 1 → 2. Old v1 imports continue
  // to work (the import side accepts both).
  const data = { type: "hackarena-participants", version: 2, exported_at: now().toISOString(), participants: exported };
  const dateStr = now().toISOString().slice(0, 10);
  res.set("Content-Disposition", `attachment; filename="participants-export-${dateStr}.json"`);
  // v6.16.29 — audit-trail: see /api/admin/export/tasks above.
  try {
    recordOrphanedAuditEvent("export", "participants", "data_exported", getAdminIdentity(req), {
      ...reqContext(req),
      participant_count: exported.length,
    });
  } catch (e) { swallowed("export-import:participants-export-audit", e); }
  res.json(data);
});

// v6.16.6 — competition + timeslot + tag + task-assignment export.
// Pre-fix the platform shipped tasks + participants exports but no
// way to migrate the competitions themselves. Without this, an
// operator moving from one server identity to another could move
// challenges (titles preserved) and participants (memberships
// resolved by competition NAME), but the comps had to be hand-
// rebuilt — and any name typo silently dropped the membership on
// import. This endpoint closes the round-trip. Output is a single
// JSON envelope (`hackarena-competitions`, version 1) so a future
// import can resolve everything by name.
//
// Sensitive fields excluded by design: `cxone_api_key` is never
// exported (per-comp credential). `cxone_group_name` IS exported
// (it's a public-by-design override). Settings are NOT included
// in this envelope — see /api/admin/settings GET for those.
//
// No corresponding import handler ships in this version. The
// envelope is documented + stable so a future import can be added
// without breaking existing exports.
app.get("/api/admin/export/competitions", requireAdmin, exportLimiter, (req, res) => {
  const compRows = db.prepare(
    // v7.29.0 — four columns were silently absent from this export. The one that
    // matters most is cxone_disabled: it is an opt-OUT, so losing it means the
    // TARGET starts creating external CxOne identities for an event whose
    // operator had turned that off — an active failure, not merely a lossy one.
    // Deliberately still absent: cxone_api_key and self_enroll_token (secrets),
    // updated_at (a concurrency token scoped to this database),
    // trusted_network_ips and the retired self_enroll_allow_instant (see
    // tests/competitions-drift.spec.js for the reasons).
    `SELECT id, name, start_time, duration_minutes, ended_at, ended_manually,
            leaderboard_mode, leaderboard_overall, leaderboard_percent, reveal_answers_on_end, cxone_group_name,
            self_enroll_enabled,
            group_leaderboard_enabled, cxone_disabled, staff_compete,
            created_at
       FROM competitions ORDER BY created_at`
  ).all();
  const allTags = db.prepare("SELECT competition_id, tag FROM competition_tags").all();
  const tagsByComp = {};
  for (const t of allTags) (tagsByComp[t.competition_id] = tagsByComp[t.competition_id] || []).push(t.tag);
  const allSlots = db.prepare(
    "SELECT id, competition_id, name, start_time, duration_minutes, ended_at, ended_manually FROM competition_timeslots ORDER BY competition_id, start_time"
  ).all();
  const slotsByComp = {};
  for (const s of allSlots) {
    (slotsByComp[s.competition_id] = slotsByComp[s.competition_id] || []).push({
      name: s.name,
      start_time: s.start_time,
      duration_minutes: s.duration_minutes,
      ended_at: s.ended_at || null,
      ended_manually: !!s.ended_manually,
    });
  }
  // Task assignments — resolve task_id → task title for portability.
  const allCT = db.prepare(
    `SELECT ct.competition_id, ct.task_id, t.title AS task_title, ct.assigned_at
       FROM competition_tasks ct
       JOIN tasks t ON t.id = ct.task_id`
  ).all();
  // Per-session question sets: a question narrowed to chosen sessions carries
  // their NAMES (the file's timeslots are named, never by id); absent, every session.
  const slotNameById = new Map(allSlots.map(s => [s.id, s.name]));
  const sessionsOf = new Map();
  for (const r of db.prepare("SELECT competition_id, task_id, timeslot_id FROM competition_task_sessions").all()) {
    const k = `${r.competition_id}|${r.task_id}`;
    if (!sessionsOf.has(k)) sessionsOf.set(k, []);
    sessionsOf.get(k).push(slotNameById.get(r.timeslot_id) || r.timeslot_id);
  }
  const tasksByComp = {};
  for (const ct of allCT) {
    const _sess = sessionsOf.get(`${ct.competition_id}|${ct.task_id}`);
    (tasksByComp[ct.competition_id] = tasksByComp[ct.competition_id] || []).push({
      task_title: ct.task_title,
      assigned_at: ct.assigned_at || null,
      ...(_sess ? { sessions: _sess.sort() } : {}),
    });
  }
  const competitions = compRows.map(c => ({
    name: c.name,
    start_time: c.start_time,
    duration_minutes: c.duration_minutes,
    ended_at: c.ended_at || null,
    ended_manually: !!c.ended_manually,
    leaderboard_mode: c.leaderboard_mode || "per_slot",
    // Per-session question sets: the rest of the ranking choice (an overall
    // board beside the sessions; percentages on the overall board).
    leaderboard_overall: !!c.leaderboard_overall,
    leaderboard_percent: !!c.leaderboard_percent,
    reveal_answers_on_end: !!c.reveal_answers_on_end,
    cxone_group_name: c.cxone_group_name || null,
    self_enroll_enabled: !!c.self_enroll_enabled,
    group_leaderboard_enabled: !!c.group_leaderboard_enabled,
    cxone_disabled: !!c.cxone_disabled,
    // v8.12.0 — EXPORTED on the cxone_disabled reasoning: a re-created event
    // that silently lost it would keep its staff off a board they were meant to
    // be on, and the seal invariant it implies is visible in the file's tasks.
    staff_compete: !!c.staff_compete,
    created_at: c.created_at || null,
    tags: tagsByComp[c.id] || [],
    timeslots: slotsByComp[c.id] || [],
    tasks: tasksByComp[c.id] || [],
  }));
  const data = {
    type: "hackarena-competitions",
    version: 1,
    exported_at: now().toISOString(),
    competitions,
  };
  const dateStr = now().toISOString().slice(0, 10);
  res.set("Content-Disposition", `attachment; filename="competitions-export-${dateStr}.json"`);
  // v6.16.29 — audit-trail: see /api/admin/export/tasks above.
  try {
    recordOrphanedAuditEvent("export", "competitions", "data_exported", getAdminIdentity(req), {
      ...reqContext(req),
      competition_count: competitions.length,
    });
  } catch (e) { swallowed("export-import:competitions-export-audit", e); }
  res.json(data);
});

// v6.16.17 — settings export. Closes the migration-completeness gap
// flagged in v6.16.6 ("Settings are NOT included in [the competitions
// export] envelope"). Returns the full settings table EXCEPT keys in
// the redact list (CxOne API key + anything else flagged sensitive).
// Superadmin-only because settings can carry tenant-specific config
// that a regular admin shouldn't be able to round-trip out of the
// platform. No corresponding import handler ships in this version —
// settings is the canonical key-value store and re-importing requires
// careful key-by-key reconciliation; the export is for migration
// audit / replay-by-hand by the operator.
app.get("/api/admin/export/settings", requireAdmin, requireSuperAdmin, exportLimiter, (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings ORDER BY key").all();
  const settings = {};
  let redactedCount = 0;
  for (const r of rows) {
    if (_REDACT_KEYS.has(r.key.toLowerCase())) {
      settings[r.key] = "[REDACTED]";
      redactedCount++;
    } else {
      settings[r.key] = r.value;
    }
  }
  const data = {
    type: "hackarena-settings",
    version: 1,
    exported_at: now().toISOString(),
    redacted_count: redactedCount,
    settings,
  };
  const dateStr = now().toISOString().slice(0, 10);
  res.set("Content-Disposition", `attachment; filename="settings-export-${dateStr}.json"`);
  // v6.16.29 — audit-trail: see /api/admin/export/tasks above.
  try {
    recordOrphanedAuditEvent("export", "settings", "data_exported", getAdminIdentity(req), {
      ...reqContext(req),
      key_count: Object.keys(settings).length,
      redacted_count: redactedCount,
    });
  } catch (e) { swallowed("export-import:settings-export-audit", e); }
  res.json(data);
});

// ── Per-competition challenge activity (CSV) ────────────────────────────────
// v7.23.0 — one row per (enrolled participant x assigned challenge) for a LIVE
// or ENDED competition, carrying the four signals an organiser asks for after
// an event: did they solve it, did they take the hint, how many wrong answers,
// and how many times did they navigate away from it.
//
// WHY THIS IS A SERVER-RENDERED CSV, unlike every other export in this file
// (which ships JSON that the SPA turns into a file): no admin payload carries
// a competition's participant list OR its challenge list — `GET
// /api/admin/competitions` returns counts, not members — so the cross product
// genuinely cannot be built in the browser. Emitting the bytes here also makes
// the CSV itself assertable in a test rather than only the JSON feeding it,
// which is the v7.15.8 lesson: a client-built CSV silently shipped blank
// columns for releases because the payload it read had drifted.
//
// v7.24.0 — the challenge is now identified by its per-competition NUMBER
// first, and that number is also the sort key (see the challenges SELECT
// below). Three columns joined the identity block: `Challenge ID` is
// competition_tasks.task_number — the "1.02" a participant sees on their own
// screen, so an organiser reading this file and an organiser reading the
// Analytics pane are naming challenges the same way; `Difficulty` and `Points`
// describe the CHALLENGE, not the participant's result, so `Points` is what the
// challenge was worth (POINTS[difficulty], the ONE ladder from lib/scoring —
// never re-typed here, per the v7.21.6 mirror lock) regardless of what this
// participant actually scored on it after wrong answers and hint deductions.
const ACTIVITY_HEADERS = [
  "Nickname", "First Name", "Last Name", "Company",
  "Challenge ID", "Challenge", "Difficulty", "Points",
  "Solved", "Hint Revealed", "Incorrect Submissions", "Navigated Away",
];

// THE MIDDLEWARE ORDER IS A RULE, NOT A PREFERENCE: every gated route puts its
// AUTH guards ahead of its rate limiter, so a 401/403 never increments a bucket.
// v7.23.0 got this route right and deferred its four siblings; v8.3.11 closed all
// eleven sites and added a source scanner, so a twelfth registered the other way
// round fails immediately rather than shipping. See "A 401 must not spend
// somebody else's rate-limit budget" in CLAUDE.md.
app.get("/api/admin/export/competition-activity", requireAdmin, exportLimiter, (req, res) => {
  // audit v7.7.38 (H3) — a repeated ?competitionId=a&competitionId=b arrives as
  // an ARRAY under Express 5 and better-sqlite3 refuses to bind one → 500.
  // Unlike the sibling exports this parameter is REQUIRED, so a missing or
  // non-string value is an explicit 400 rather than a fall-through to null.
  const compId = typeof req.query.competitionId === "string" ? req.query.competitionId : null;
  if (!compId) return res.status(400).json({ error: "competitionId is required" });
  const comp = getCompetition(compId);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // v8.7.0 — REFUSED BEFORE ANY SIDE EFFECT, and on this route that ordering is
  // load-bearing rather than tidy: `ensureTaskNumbers` below WRITES (it is a
  // db.transaction that assigns the per-competition challenge numbers lazily), so
  // a check placed after it would let a refused request permanently number
  // somebody else's event. The status gate is left below it for the same reason —
  // "not your event" is the more accurate answer, and it costs no read.
  const denied = competitionDenied(req, compId);
  if (denied) return res.status(403).json({ error: denied.message, code: denied.code });

  // Gate: live or ended, never upcoming. `competitionStatus` is the SAME value
  // GET /api/admin/competitions returns and the row kebab renders from, so the
  // menu item and this refusal are one definition rather than a mirror. It is
  // timeslot-aware: a competition with one ended and one live session reads
  // "live"; "upcoming" means every session is still ahead. Do NOT substitute
  // competitionFullyEnded (that is "ended" only, and would reject every live
  // competition) or hand-derive from start_time + duration_minutes (wrong for
  // any multi-session competition — the defect v7.22.1 fixed in the sort).
  const slots = getCompetitionTimeslots(compId);
  if (competitionStatus(comp, slots) === "upcoming") {
    return res.status(400).json({
      error: "This event has not started yet, so there is no question activity to export.",
      code: "competition_not_started",
    });
  }

  // v7.24.0 — fill in any missing challenge NUMBERS before reading, because the
  // file is now sorted and identified by them. `ensureTaskNumbers` is a no-op
  // for an upcoming competition, which is precisely the status the gate above
  // has already excluded — but the numbers are assigned LAZILY, by the three
  // assign paths and the participant's GET /api/tasks, and none of those has
  // necessarily run: set an event up the night before (upcoming, so the assign
  // no-ops), let it go live purely by the clock (nothing fires on a time-derived
  // transition), and export before the first participant signs in, and every
  // Challenge ID cell would be blank. It short-circuits on _taskNumbersAssignedCache
  // so the usual cost is one Set lookup.
  //
  // It must run BEFORE the BEGIN below: _assignTaskNumbers is a db.transaction
  // that WRITES, and the block below is deliberately a consistent READ snapshot.
  ensureTaskNumbers(compId, comp);

  // Read-snapshot isolation, same shape as GET /api/admin/analytics/challenges:
  // the five reads see one consistent view, so an admin assigning a challenge
  // or removing a participant mid-export cannot split the file. COMMIT sits in
  // the `finally` so a throw still closes the implicit lock.
  let participants, challenges, subRows, hintRows, navRows, taskSessions;
  db.exec("BEGIN");
  try {
    // Every ENROLLED participant, minus `staff`.
    //
    // Deliberately NOT scoringParticipantIds / ACTIVE_PARTICIPANT_SQL, however
    // much they look like the helper you want: those encode the LEADERBOARD's
    // notion of who counts (approved AND verified, minus staff AND benchmark),
    // and reusing them here would silently drop unapproved, unverified and
    // benchmark enrollees from the file with no error — missing rows being the
    // worst failure mode an export has. An export encodes the ENROLMENT's
    // notion instead. `staff` is excluded because admins are auto-tagged with
    // it and are not participants of the event, matching the Analytics pane's
    // default so the two admin screens agree; `benchmark` is KEPT, because a
    // reference score is exactly what an organiser reads this file to compare
    // against.
    //
    // v8.12.0 — on an event where STAFF COMPETE the staff exclusion is lifted
    // here as it is on the board: a competing admin's row is a competitor's row,
    // and a file that dropped it would be missing a real result. The event-admin
    // ROLE was never excluded from this file (only the tag), so nothing changes
    // for that tier either way.
    const _staffCompete = require("../lib/staff-compete").staffCompeteOn(comp);
    participants = db.prepare(
      `SELECT u.id AS id, u.nickname AS nickname, u.first_name AS first_name,
              u.last_name AS last_name, u.company AS company, cu.timeslot_id AS timeslot_id
         FROM competition_users cu
         JOIN users u ON u.id = cu.user_id
        WHERE cu.competition_id = ?
          ${_staffCompete ? "" : "AND u.id NOT IN (SELECT user_id FROM user_tags WHERE tag = 'staff')"}
        ORDER BY u.nickname COLLATE NOCASE, u.id`
    ).all(compId);
    // Per-session question sets: the questions narrowed to chosen sessions.
    taskSessions = require("../lib/session-tasks").taskSessionsMap(db, compId);

    // Every challenge ASSIGNED to the competition, including any since hidden
    // (active=0) or unpublished (restoring an old version leaves the assignment
    // rows behind). Excluding those would lose real solve data for a challenge
    // that WAS answerable while the competition ran — a wrong answer — whereas
    // keeping them costs at worst some all-No rows.
    //
    // v7.24.0 — ordered by the per-competition NUMBER rather than the title, so
    // the file reads in the competition's own challenge order (which is the
    // order participants met them in) instead of alphabetically.
    //
    // The ORDER BY here is only for a deterministic read; the real ordering is
    // applied in JS below with `compareTaskNumbers`, because `task_number` is
    // TEXT of the form "<level>.<NN>" and SQLite would sort "1.100" before
    // "1.99" once a difficulty bucket passes 99 challenges, and would put a
    // NULL number FIRST rather than last.
    //
    // `t.title` then `t.id` remain the tiebreaks. `t.id` is load-bearing
    // because tasks.title is NOT unique and (competition_id, task_number) has
    // no unique index either: without it two challenges sharing a number — or
    // two unnumbered ones — swap places between two downloads of the same
    // competition (v6.10.54 — a sort key that is not total is not a sort).
    challenges = db.prepare(
      `SELECT t.id AS id, t.title AS title, t.difficulty AS difficulty,
              ct.task_number AS task_number, ${qualifyingSql("t")} AS is_qualifying
         FROM competition_tasks ct
         JOIN tasks t ON t.id = ct.task_id
        WHERE ct.competition_id = ?
        ORDER BY t.title COLLATE NOCASE, t.id`
    ).all(compId);
    challenges.sort((a, b) =>
      compareTaskNumbers(a.task_number, b.task_number) ||
      String(a.title || "").localeCompare(String(b.title || ""), undefined, { sensitivity: "base" }) ||
      String(a.id).localeCompare(String(b.id)));

    // Solved / Incorrect. `solved` is SUM(is_correct=1) > 0 rather than a count,
    // and that is load-bearing: POST /api/admin/tasks/:id/recalculate re-grades
    // every submission row individually, so one (user, task) can legitimately
    // hold SEVERAL is_correct=1 rows — exactly the case buildLeaderboardEntries
    // de-dupes with MAX(points_delta). Incorrect stays a plain COUNT because
    // each wrong row is a real -5 penalty the participant took. Note that a
    // recalculate flips rows, so this column means CURRENTLY-incorrect, which is
    // the same basis the leaderboard scored on.
    subRows = db.prepare(
      `SELECT user_id, task_id,
              SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct_n,
              SUM(CASE WHEN is_correct = 1 THEN 0 ELSE 1 END) AS incorrect_n
         FROM submissions
        WHERE competition_id = ?
        GROUP BY user_id, task_id`
    ).all(compId);

    // hint_reveals' PRIMARY KEY is (competition_id, user_id, task_id), so there
    // is at most ONE row per cell and it carries no timeslot — "Hint Revealed"
    // is inherently a boolean, never a count.
    hintRows = db.prepare(
      "SELECT user_id, task_id FROM hint_reveals WHERE competition_id = ?"
    ).all(compId);

    // Navigated away — the ONLY column that reads challenge_events, and the
    // only one that filters `impersonated`. That asymmetry is deliberate
    // platform doctrine (v7.14.0), not an oversight: a solve or a hint taken by
    // a superadmin while impersonating is a REAL change to that participant's
    // score and stays in, whereas an admin clicking away from a challenge is
    // the ADMIN navigating, not the participant. `impersonated` is the 5th
    // column of idx_chev_comp_task_user_type, so the predicate is index-covered.
    navRows = db.prepare(
      `SELECT user_id, task_id, COUNT(*) AS n
         FROM challenge_events
        WHERE competition_id = ? AND event_type = 'navigated_away' AND impersonated = 0
        GROUP BY user_id, task_id`
    ).all(compId);
  } finally {
    // Guarded, matching the analytics precedent this shape is copied from.
    // SQLite rolls the transaction back implicitly on SQLITE_IOERR / NOMEM /
    // FULL, and a bare COMMIT then throws "cannot commit - no transaction is
    // active" — from a `finally`, which REPLACES the disk error already in
    // flight, so the log would name transaction bookkeeping instead of the
    // hardware. (Note SQLITE_CORRUPT does NOT auto-roll-back, so the common
    // corruption case propagates either way; this covers the I/O one.)
    try { db.exec("COMMIT"); } catch (e) { /* no-op if already rolled back */ swallowed("export-import:activity-export-commit", e); }
  }

  // Assemble the cross product in JS from three Maps rather than asking SQLite
  // for it. A correlated-subquery cross product is prettier and measurably
  // worse: at the plausible ceiling (1000 participants x 60 challenges) it runs
  // ~350 ms against ~110 ms for this shape, because its cost scales with the
  // CROSS PRODUCT while this one scales with actual ACTIVITY. 300 ms is
  // PERF_SPAN_SLOW_MS, and better-sqlite3 is synchronous in a single-process
  // server, so the elegant version is an event-loop stall for every live
  // participant (the thing hack_arena_event_loop_blocked_ms_total tracks).
  // A missing key IS the all-No row — which is how the file gets its full
  // cross product without the database ever producing one.
  const cell = (u, t) => u + " " + t;
  const subMap = new Map(subRows.map(r => [cell(r.user_id, r.task_id), r]));
  const hintSet = new Set(hintRows.map(r => cell(r.user_id, r.task_id)));
  const navMap = new Map(navRows.map(r => [cell(r.user_id, r.task_id), r.n]));

  const rows = [];
  for (const p of participants) {
    for (const t of challenges) {
      // PER-SESSION QUESTION SETS — a question outside the participant's own
      // session was never theirs to answer, so it has no row for them (rather
      // than an all-No row reading as a question they skipped). One with no
      // session yet keeps every question, as the participant routes do.
      const _in = taskSessions.get(t.id);
      if (_in && p.timeslot_id && !_in.includes(p.timeslot_id)) continue;
      const k = cell(p.id, t.id);
      const s = subMap.get(k);
      rows.push([
        // `|| ""` throughout: company, first_name and last_name are nullable
        // for some import paths, and String(null) would put the literal "null"
        // in the cell.
        p.nickname || "", p.first_name || "", p.last_name || "", p.company || "",
        // Blank rather than "null" when a challenge somehow has no number — the
        // empty cell says "unnumbered", which is true, where a literal would not.
        t.task_number || "", t.title || "", t.difficulty || "",
        // The challenge's OWN worth. `difficulty` is CHECK-constrained on the
        // tasks table, so the lookup cannot miss for a stored row; the `?? ""`
        // covers a future difficulty added to the CHECK and not to the ladder,
        // where a blank beats the string "undefined". A qualifying (Quick)
        // question is worth 0, as it scores 0 (server.js submit).
        t.is_qualifying ? 0 : (POINTS[t.difficulty] ?? ""),
        s && s.correct_n > 0 ? "Yes" : "No",
        hintSet.has(k) ? "Yes" : "No",
        s ? s.incorrect_n : 0,
        navMap.get(k) || 0,
      ]);
    }
  }

  const body = csvBuffer(ACTIVITY_HEADERS, rows);
  const dateStr = now().toISOString().slice(0, 10);
  // The filename carries the competition name, so it MUST be slugged: names are
  // validated as {string, max 120} and trimmed but NOT newline-stripped, and
  // Node throws ERR_INVALID_CHAR on a header value containing CR/LF — a raw
  // interpolation is a 500, not merely untidy. `_slugForDownload` is the
  // existing exported helper (lib/attachments.js), already used by the
  // attachment downloads; writing a third filename sanitiser would be the
  // duplication class this repo locks.
  const slug = _slugForDownload(comp.name || "competition");
  // Content-Type is set EXPLICITLY. `res.send(<string>)` with none set defaults
  // to text/html, and this body carries participant-authored names and company
  // strings — shipping those as HTML on an authenticated same-origin URL is
  // stored XSS by construction. `nosniff` does not help (it stops sniffing, not
  // an explicit declaration); Content-Disposition: attachment is the second,
  // independent guard.
  res.set("Content-Disposition", `attachment; filename="${slug}-activity-${dateStr}.csv"`);
  res.type("text/csv; charset=utf-8");
  // v6.16.29 — audit-trail: see /api/admin/export/tasks above. This export is
  // participant PII (name + company) plus per-challenge performance, i.e.
  // precisely what that comment was written about, so it emits like its
  // siblings even though it is a read-only GET.
  try {
    recordOrphanedAuditEvent("export", "competition-activity", "data_exported", getAdminIdentity(req), {
      ...reqContext(req),
      competition_id: compId,
      participant_count: participants.length,
      challenge_count: challenges.length,
      row_count: rows.length,
    });
  } catch (e) { swallowed("export-import:activity-export-audit", e); }
  res.send(body);
});

// ── Per-competition free-text responses (JSON) ──────────────────────────────
// v8.9.0 — every `any`-type challenge assigned to one event, plus the LATEST
// correct submission each participant made to each of them. The FOCUSED
// participants CSV (public/js/features/export-import.js) reads this and appends
// one `Response: …` column per challenge; the answer text is what an organiser
// opens that file to read, and it lives nowhere else on the admin wire.
//
// WHY THIS IS JSON, unlike the activity export beside it: the CSV it feeds is
// the EXISTING client-built participants file, whose header, `Phone` exemption
// and revoke strategy are all locked from the browser side. Shipping the
// responses as data and letting that one builder add its columns keeps ONE
// participants CSV rather than a second server-rendered one that would drift.
//
// Same middleware order as every gated route — AUTH before the LIMITER, so a
// 401/403 never spends the shared per-IP export bucket (v8.3.11 scanner).
app.get("/api/admin/competitions/:id/free-text-responses", requireAdmin, exportLimiter, (req, res) => {
  const compId = req.params.id;
  const comp = getCompetition(compId);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // v8.7.0 — refused BEFORE `ensureTaskNumbers`, which WRITES: the sibling
  // export's reasoning applies verbatim (a check placed after it would let a
  // refused request permanently number somebody else's event).
  const denied = competitionDenied(req, compId);
  if (denied) return res.status(403).json({ error: denied.message, code: denied.code });

  // DELIBERATELY NO `upcoming` STATUS GATE — the one place this route differs
  // from its sibling, and it is a decision rather than an omission. The
  // activity CSV refuses an upcoming event because nothing has happened in it;
  // this endpoint feeds the FOCUSED PARTICIPANTS CSV, and an organiser exports
  // the roster before the doors open as a matter of course, so refusing here
  // would break that export for exactly the state it is most used in. An
  // upcoming event simply yields zero responses. The cost is stated: for an
  // upcoming event `ensureTaskNumbers` is a documented no-op, so `task_number`
  // may be NULL on every challenge here, and the client falls back to a
  // title-only column header rather than printing "null".
  //
  // `ensureTaskNumbers` still runs BEFORE the BEGIN below for the same reason
  // the sibling gives: it is a db.transaction that writes, and the block below
  // is deliberately a consistent READ snapshot.
  ensureTaskNumbers(compId, comp);

  // Read-snapshot isolation (the analytics / activity-export shape): the two
  // reads see one consistent view, so a challenge assigned mid-export cannot
  // appear in `responses` while missing from `challenges`. COMMIT sits in the
  // `finally` so a throw still closes the implicit lock.
  let challenges, responseRows = [];
  db.exec("BEGIN");
  try {
    // Only the `any` challenges — the answer type whose whole point is that
    // the text is the deliverable. A `text` challenge's answers are graded
    // against a key and are already summarised by the activity export.
    //
    // The ORDER BY is only a deterministic read; the real ordering is applied
    // in JS with `compareTaskNumbers`, because `task_number` is TEXT of the
    // form "<level>.<NN>" and SQLite would sort "1.100" before "1.99" and put
    // a NULL number FIRST rather than last. `t.title` then `t.id` are the
    // tiebreaks, and `t.id` is load-bearing: neither `tasks.title` nor
    // (competition_id, task_number) is unique, so without it two challenges
    // sharing a number swap columns between two downloads (v6.10.54).
    // v8.10.0 — a SEALED any-answer challenge is excluded from this export for
    // anyone but its author, and it is excluded ENTIRELY rather than exported with
    // blank cells.
    //
    // For `answer_type='any'` there is no key at all: every non-empty answer is
    // correct, so the participants' RESPONSES are the only secret the seal can be
    // about — and they are exactly what this CSV exists to deliver. A column of
    // empty cells under the challenge's title would be worse than its absence: it
    // reads as "nobody responded", which is a wrong answer about real
    // participants. Dropping the column and saying so in the guide is the honest
    // form.
    //
    // `answer_sealed` and `created_by_id` join the projection so the filter can be
    // applied per row against the caller.
    const _ftActor = actingAdminId(req); // v8.12.1 — the seal reads the human, not the seat
    const _ftReveals = sealRevealSet(req); // v8.12.2 — a revealed superadmin reads as the author
    challenges = db.prepare(
      `SELECT t.id AS id, t.title AS title, ct.task_number AS task_number,
              t.answer_sealed AS answer_sealed, t.created_by_id AS created_by_id
         FROM competition_tasks ct
         JOIN tasks t ON t.id = ct.task_id
        WHERE ct.competition_id = ? AND t.answer_type = 'any'
        ORDER BY t.title COLLATE NOCASE, t.id`
    ).all(compId).filter(c => sealedAnswerReadable(c, _ftActor,
      // A reveal never widens what a COMPETITOR reads (the tasks export above
      // gives the reason). Defence in depth here — a sealed `any` challenge is
      // refused at every write since v8.10.1, and a compete event holds sealed
      // challenges only — so the reveal is honoured for a challenge the acting
      // human does not compete in, and never otherwise.
      _ftReveals[c.id] === true && competitorEventsForTask(db, competitorIds(req), c.id).length === 0));
    challenges.sort((a, b) =>
      compareTaskNumbers(a.task_number, b.task_number) ||
      String(a.title || "").localeCompare(String(b.title || ""), undefined, { sensitivity: "base" }) ||
      String(a.id).localeCompare(String(b.id)));

    if (challenges.length) {
      // `is_correct = 1` is load-bearing, not a tidy-up: an admin may switch a
      // challenge from `text` to `any` after participants have already answered
      // it, and the WRONG rows they left under the old grading survive that
      // switch (a recalculate flips them, but nothing forces one). Without the
      // predicate a participant who never answered the free-text version would
      // export their old rejected guess as their response.
      //
      // ASC order is what makes the reduction below "latest wins": one
      // (user, task) can legitimately hold several correct rows — a recalculate
      // after the switch flips the old wrong row to correct beside the real
      // free-text answer — and the later row overwrites the earlier in the Map.
      // `rowid` breaks a same-millisecond tie, so the answer is a total order
      // rather than whichever row SQLite happened to yield first.
      const ids = challenges.map(c => c.id);
      responseRows = db.prepare(
        `SELECT user_id, task_id, answer, submitted_at
           FROM submissions
          WHERE competition_id = ? AND is_correct = 1
            AND task_id IN (SELECT value FROM json_each(?))
          ORDER BY submitted_at ASC, rowid ASC`
      ).all(compId, JSON.stringify(ids));
    }
  } finally {
    // Guarded, matching the analytics / activity-export precedent: SQLite
    // rolls back implicitly on SQLITE_IOERR / NOMEM / FULL, and a bare COMMIT
    // then throws from a `finally`, REPLACING the disk error in flight.
    try { db.exec("COMMIT"); } catch (e) { /* no-op if already rolled back */ swallowed("export-import:free-text-export-commit", e); }
  }

  // Latest row per (user, task). A missing key IS the blank cell — the client
  // renders "" for a participant who never responded, and this endpoint never
  // manufactures a row for them.
  const latest = new Map();
  for (const r of responseRows) latest.set(r.user_id + " " + r.task_id, r);
  // `answer` is returned VERBATIM — never trimmed, never coerced. The `any`
  // type stores exactly what the participant typed (leading and trailing
  // whitespace included), and the CSV builder's formula neutralisation is the
  // ONE place a cell is altered, so a trim here would be a second, silent
  // rewrite of a value the organiser asked to see as it was written.
  const responses = [...latest.values()].map(r => ({ user_id: r.user_id, task_id: r.task_id, answer: r.answer }));
  const out = challenges.map(c => ({ id: c.id, title: c.title, task_number: c.task_number }));

  // v6.16.29 — audit-trail: see /api/admin/export/tasks above. This is
  // participant-authored free text keyed to participant ids, i.e. the data an
  // egress record exists for, so it emits like its siblings although it is a
  // read-only GET. Orphan scope `export`, never `recordCompetitionEvent`, which
  // would put read-only export lines in the event's History dialog.
  try {
    recordOrphanedAuditEvent("export", "free-text-responses", "data_exported", getAdminIdentity(req), {
      ...reqContext(req),
      competition_id: compId,
      challenge_count: out.length,
      response_count: responses.length,
    });
  } catch (e) { swallowed("export-import:free-text-export-audit", e); }
  res.json({ challenges: out, responses });
});

// ── v8.15.0 — the FULL EVENT export and the PERSON export ───────────────────
// Builders: lib/full-export.js (participant set, seal redaction, no
// capabilities — read its header). Both are read-only GETs behind the shared
// export limiter, AUTH first (the v8.3.11 placement scanner), and both emit an
// orphaned `data_exported` with the requester's context, like their siblings.
//
// FORMAT. A ZIP of CSV files (`zip-csv`), written by lib/zip-writer.js with no
// new dependency. `xlsx` is refused by name rather than quietly answered with
// a ZIP: a caller asking for a workbook must learn it did not get one.
app.get("/api/admin/competitions/:id/export/full", requireAdmin, exportLimiter, async (req, res) => {
  const format = typeof req.query.format === "string" ? req.query.format : "zip-csv";
  if (format !== "zip-csv") {
    return res.status(400).json({ error: "The full event export is available as a ZIP of CSV files only (format=zip-csv).", code: "export_format_unsupported" });
  }
  const comp = getCompetition(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  // A competitor may not export the event they compete in: the file holds
  // every rival's answers and standing.
  { const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), comp.id)); if (_cmp) return _cmp; }
  // Refused BEFORE `ensureTaskNumbers`, which writes (the activity export's rule).
  const denied = competitionDenied(req, comp.id);
  if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  ensureTaskNumbers(comp.id, comp);
  const data = buildEventExportData(req, comp);
  const readme =
    `Full export of "${String(comp.name).replace(/[\r\n]+/g, " ")}" (${comp.id}), generated ${now().toISOString()}.\r\n` +
    "Every file is UTF-8 CSV; cells beginning = + - @ TAB or CR carry a leading apostrophe so a spreadsheet shows them as text.\r\n" +
    "User ID and Challenge Ref join the files. Answers to sealed challenges are withheld unless you authored the challenge.\r\n" +
    "Staff are left out unless the event lets staff compete; benchmark accounts are included and labelled.\r\n" +
    "certificates.csv lists every certificate issued in the event, whoever holds it now.\r\n" +
    (data.files["grades.csv"] ? "grades.csv (a Program) lists each learner's attempts: every closed one (Try again) and the current one, which counts once Finished; 60% or more passes.\r\n" : "");
  const zip = await filesToZip(data.files, readme);
  // RE-ASK AFTER THE LAST AWAIT (the top-three ZIP's shape): the deflate is the
  // only await, so nothing is awaited from here to the send. The downloading
  // admin read live (`{read:true}` admits a regular admin's read-only view of an
  // organiser, whose GET this is), the event still theirs (scope read fresh)
  // and still not one they compete in. A refused file is not recorded.
  await testAdminCommitPark();
  invalidateEventAdminScope(actorId(req));
  {
    const authz = adminAuthzDenied(req, { perm: "export.data", read: true });
    if (authz) return res.status(authz.status).json({ error: authz.error, code: authz.code, ...(authz.reason ? { reason: authz.reason } : {}) });
  }
  { const late = competitionDenied(req, comp.id); if (late) return res.status(403).json({ error: late.message, code: late.code }); }
  { const _cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), comp.id)); if (_cmp) return _cmp; }
  try {
    recordOrphanedAuditEvent("export", "competition-full", "data_exported", getAdminIdentity(req), {
      ...reqContext(req), competition_id: comp.id, format, ...data.counts,
    });
  } catch (e) { swallowed("export-import:event-full-export-audit", e); }
  const slug = _slugForDownload(comp.name || "event");
  res.set("Content-Disposition", `attachment; filename="${slug}-full-export-${now().toISOString().slice(0, 10)}.zip"`);
  res.type("application/zip");
  res.send(zip);
});

app.get("/api/admin/participants/:id/export/full", requireAdmin, exportLimiter, async (req, res) => {
  const format = typeof req.query.format === "string" ? req.query.format : "json";
  if (format !== "json" && format !== "zip-csv") {
    return res.status(400).json({ error: "The person export is available as json or zip-csv.", code: "export_format_unsupported" });
  }
  // Scope before existence: an event admin learns nothing about an id outside
  // their events (participantDenied answers 403 for an unknown one too).
  // No competitor lock, unlike the event export above (sweep #233; operator
  // ruling, 24 Nov 2026): a competing admin may export a rival's file. It is a
  // read, as Export Activity is, and an event where staff compete holds sealed
  // challenges only, so the rival's answers there stay withheld
  // (`answerVisibleFor`: never to a competitor).
  const denied = participantDenied(req, req.params.id);
  if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  // The scope the file is built under (buildPersonExportData reads the same
  // value, synchronously): re-asked against a fresh read after the deflate.
  const builtScope = scopedCompetitionIds(req);
  const data = buildPersonExportData(req, req.params.id);
  if (!data) return res.status(404).json({ error: "User not found" });
  const record = () => {
    try {
      recordOrphanedAuditEvent("export", "person-full", "data_exported", getAdminIdentity(req), {
        ...reqContext(req), user_id: req.params.id, format, scoped: data.scoped_to_your_events,
        memberships: data.memberships.length, submissions: data.submissions.length, events: data.events.length,
      });
    } catch (e) { swallowed("export-import:person-full-export-audit", e); }
  };
  const slug = _slugForDownload(data.profile.nickname || "participant");
  const date = now().toISOString().slice(0, 10);
  if (format === "json") {
    // No await between the gate above and this send.
    record();
    res.set("Content-Disposition", `attachment; filename="${slug}-person-export-${date}.json"`);
    return res.json({ exported_at: now().toISOString(), ...data });
  }
  const zip = await filesToZip(personExportFiles(data),
    `Person export for ${String(data.profile.nickname || "").replace(/[\r\n]+/g, " ")} (${data.profile.id}), generated ${now().toISOString()}.\r\n` +
    (data.scoped_to_your_events ? "Narrowed to the events you organise.\r\n" : ""));
  // RE-ASK AFTER THE LAST AWAIT, as the event export does: the admin read live,
  // the person still inside their scope and the scope the file was built under
  // still whole (both read fresh). Recorded only once the file may go.
  await testAdminCommitPark();
  invalidateEventAdminScope(actorId(req));
  {
    const authz = adminAuthzDenied(req, { perm: "export.data", read: true });
    if (authz) return res.status(authz.status).json({ error: authz.error, code: authz.code, ...(authz.reason ? { reason: authz.reason } : {}) });
  }
  { const late = participantDenied(req, req.params.id); if (late) return res.status(403).json({ error: late.message, code: late.code }); }
  // ...and every event of the scope the file was BUILT under is still the
  // actor's: an organiser who lost one of their events meanwhile, but still
  // shares another with the person (so the check above passes), would otherwise
  // be sent the lost event's rows. An unscoped actor who became scoped likewise.
  {
    const fresh = scopedCompetitionIds(req);
    const narrowed = builtScope === null ? fresh !== null : (fresh !== null && builtScope.some(id => !fresh.includes(id)));
    if (narrowed) return res.status(403).json({ error: "Your events changed while the file was being prepared. Ask for it again.", code: "event_admin_out_of_scope" });
  }
  record();
  res.set("Content-Disposition", `attachment; filename="${slug}-person-export-${date}.zip"`);
  res.type("application/zip");
  res.send(zip);
});

// ── THE TOP-THREE CERTIFICATES, ONE CLICK ────────────────────────────────────
//
// After an event ends, a ZIP of the ISSUED 1st/2nd/3rd place certificates of
// EVERY BOARD the event ranks on: one podium per session in per_slot mode, and
// the late entrants' own podium beside the main one (ranks are unique on a
// board — two people tied on score are told apart by the tie-break, and only
// the one ranked 3rd holds the placement — so each board gives at most three).
// A session's files sit in a folder named after it, the late entrants' in
// `late-entrants/`, the main board's at the top; each file is
// `<place>-<holder>-certificate.pdf`, the holder as the certificate prints the
// name. Nothing is minted here: the
// files are exactly the certificates already issued (by the dispatcher or
// collected by their holders), rendered through the one PDF render
// (`renderIssuedCertificatePdf`). Scoped like the admin certificate routes
// (404, then `competitionDenied`); each file is recorded on the event's History
// as `badge_certificate_downloaded` with `by_owner: false`, as the single admin
// download records it.
//
// WHAT IS MISSING is measured against the podium the mint awards
// (`placementPodium`, routes/badge.js `_placementPodium`): the places, board by
// board, that no certificate fills yet. A late entrant still inside their
// window is not on it (their placing is not final), a dispatcher job held only
// for them is therefore not "issuing" anything missing, and a place filled by a
// participation or revoked certificate is settled.
//
// Refusals the client renders as state, not as errors:
//   409 event_not_ended          — the board is not final yet.
//   409 certificates_being_issued — none issued yet, places are missing, and the
//                                  dispatcher still holds a job for this event
//                                  that it will issue for.
//   409 certificates_not_issued_automatically — none issued, places are missing,
//                                  and the dispatcher does not issue this
//                                  event's certificates (`reason`:
//                                  ended_before_floor, email_disabled, dry_run,
//                                  no_floor), even while a job for it still
//                                  waits: only
//                                  certificates the winners collect themselves
//                                  would be in it.
//   409 no_placement_certificates — none issued and none missing: nobody placed;
//                                  or every one was revoked while the file was
//                                  being prepared.
// A certificate revoked while the file was prepared is left out and counted in
// `X-Top3-Revoked` (a revoked place is settled, so it is not "missing"); the
// re-check after the last await also refuses an admin whose access or session
// ended meanwhile (403 admin_access_revoked / 401 admin_session_ended).
// A ZIP sent while places are missing says so: `X-Top3-Missing` (how many) and
// `X-Top3-Missing-Reason` (`being_issued`, `email_disabled`,
// `ended_before_floor`, `dry_run`, `no_floor` or `not_collected`), beside
// `X-Top3-Count`, so the client
// never calls part of a podium the top three.
// Why nothing was issued automatically, per `automaticIssueRefusal` reason.
const _TOP3_NOT_AUTOMATIC = {
  email_disabled: "No 1st, 2nd or 3rd place certificate has been issued: this event's certificates are not issued automatically while its congratulations email is off, and none of its top three has collected theirs.",
  ended_before_floor: "No 1st, 2nd or 3rd place certificate has been issued: this event ended before certificates were issued automatically, and none of its top three has collected theirs.",
  dry_run: "No 1st, 2nd or 3rd place certificate has been issued: a test event issues no certificates.",
  no_floor: "No 1st, 2nd or 3rd place certificate has been issued: certificates are not issued automatically on this installation, and none of its top three has collected theirs.",
};
// What a download refused at its send-time re-check says: the shared sentences
// say "nothing was saved", which is not what a download did.
const TOP3_ACCESS_ENDED = "Your administrator access has ended, so nothing was downloaded.";
const TOP3_SESSION_ENDED = "Your session ended before the file was ready, so nothing was downloaded. Try again — if you are asked to sign in, do that first.";
const _TOP3_SQL =
  `SELECT * FROM achievement_badges
    WHERE competition_id = ? AND revoked_at IS NULL AND rank BETWEEN 1 AND 3
      AND (basis = 'placement' OR basis IS NULL)
    ORDER BY late_entrant, IFNULL(timeslot_id, ''), rank, created_at, token`;

app.get("/api/admin/competitions/:id/certificates/top3.zip", requireAdmin, exportLimiter, async (req, res) => {
  const comp = getCompetition(req.params.id);
  if (!comp) return res.status(404).json({ error: "Event not found" });
  const denied = competitionDenied(req, comp.id);
  if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
  if (!competitionFullyEnded(comp)) {
    return res.status(409).json({ error: "The top three are known once the event has ended.", code: "event_not_ended" });
  }
  const rows = db.prepare(_TOP3_SQL).all(comp.id);
  const podium = certificateDispatch.placementPodium(comp);
  const missing = podium.reduce((n, b) => n + b.places.filter(p => !p.held).length, 0);
  // The dispatcher decides at RUN time (lib/certificate-dispatch.js), so a job
  // still waiting for an event it will not issue for (its congratulations email
  // off, or ended before automatic issue began) is no promise: the refusal is
  // asked whether or not a job waits, and answers first. An organiser who turns
  // the email on before the job runs gets "being issued" on the next ask.
  const pending = certificateDispatch.pendingDispatchFor(comp.id).length > 0;
  // A test event awards no places at all (the mint's own rule), so nothing reads
  // as missing there; its refusal is the answer all the same, never "nobody
  // placed".
  const _refusalNow = certificateDispatch.automaticIssueRefusal(comp);
  const refusal = (missing || _refusalNow === "dry_run") ? _refusalNow : null;
  const notAutomatic = !!refusal;
  if (!rows.length) {
    if (missing && pending && !notAutomatic) return res.status(409).json({ error: "The certificates are being issued. Try again in a few minutes.", code: "certificates_being_issued", pending: true });
    if (notAutomatic) {
      return res.status(409).json({
        error: _TOP3_NOT_AUTOMATIC[refusal] || _TOP3_NOT_AUTOMATIC.no_floor,
        code: "certificates_not_issued_automatically", reason: refusal, pending: false,
      });
    }
    return res.status(409).json({ error: "Nobody holds a 1st, 2nd or 3rd place certificate for this event.", code: "no_placement_certificates", pending: false });
  }
  // Which board each certificate is on: a session's folder, the late entrants'
  // folder, or the top of the ZIP for the main board.
  const slotNames = new Map(db.prepare("SELECT id, name FROM competition_timeslots WHERE competition_id=?").all(comp.id).map(t => [t.id, t.name]));
  const folders = new Map();
  const usedFolders = new Set(["late-entrants", "overall"]);
  const folderFor = (row) => {
    if (row.late_entrant) return "late-entrants/";
    // Per-session question sets: an event ranking per session AND overall puts
    // the overall board's certificates in `overall/` beside the sessions' folders.
    if (row.board_kind === "overall" && slotNames.size >= 2 && rows.some(r => r.timeslot_id)) return "overall/";
    if (!row.timeslot_id) return "";
    if (!folders.has(row.timeslot_id)) {
      const base = _slugForDownload(slotNames.get(row.timeslot_id) || `session-${String(row.timeslot_id).slice(0, 8)}`).replace(/^\.+/, "") || "session";
      let f = base;
      for (let n = 2; usedFolders.has(f); n++) f = `${base}-${n}`;
      usedFolders.add(f);
      folders.set(row.timeslot_id, `${f}/`);
    }
    return folders.get(row.timeslot_id);
  };
  const entries = [];
  const used = new Set();
  for (const row of rows) {
    let out;
    try {
      out = await certificateDispatch.renderIssuedCertificatePdf(row, comp);
    } catch (e) {
      if (e instanceof require("../lib/badge").BadgeRenderUnavailable) return res.status(503).json({ error: "Certificate rendering is unavailable." });
      throw e;
    }
    // Named after its place and its holder, as the certificate prints the name
    // (sweep #72): letters of any script, the one rule the single download names
    // its file by. The ZIP's own name carries the event.
    const base = `${folderFor(row)}${row.rank}-${fileNameSlug(out.holder, { max: 40, fallback: "finisher" })}-certificate`;
    let name = `${base}.pdf`;
    for (let n = 2; used.has(name); n++) name = `${base}-${n}.pdf`;
    used.add(name);
    entries.push({ name, data: out.pdf });
  }
  // Sweep #235 — RE-ASK AFTER THE LAST AWAIT. The renders and the deflate are
  // every await this download makes, so both come first; nothing is awaited
  // from the re-check to the send. Asked: the downloading admin (role, account
  // and session, read live: `{read:true}` admits a regular admin's read-only
  // view of an organiser, whose GET this is), the event still theirs (scope read
  // fresh, not from the 2 s cache), and each certificate still unrevoked: one
  // revoked while the file was prepared is left out and counted in
  // X-Top3-Revoked. Only the files actually sent are recorded.
  const prepared = await deflateZipEntries(entries);
  await testAdminCommitPark();
  invalidateEventAdminScope(actorId(req));
  const authz = adminAuthzDenied(req, { perm: "certificates.view", read: true });
  if (authz) {
    const error = authz.reason ? authz.error : (authz.status === 401 ? TOP3_SESSION_ENDED : TOP3_ACCESS_ENDED);
    return res.status(authz.status).json({ error, code: authz.code, ...(authz.reason ? { reason: authz.reason } : {}) });
  }
  const late = competitionDenied(req, comp.id);
  if (late) return res.status(403).json({ error: late.message, code: late.code });
  const live = new Set(db.prepare(
    "SELECT token FROM achievement_badges WHERE competition_id=? AND revoked_at IS NULL AND token IN (SELECT value FROM json_each(?))"
  ).all(comp.id, JSON.stringify(rows.map(r => r.token))).map(r => r.token));
  const keep = rows.map((r, i) => i).filter(i => live.has(rows[i].token));
  const revokedNow = rows.length - keep.length;
  if (!keep.length) {
    return res.status(409).json({ error: "Every top-three certificate was revoked while the file was being prepared.", code: "no_placement_certificates", pending: false });
  }
  const zip = assembleZip(keep.map(i => prepared[i]));
  const actor = getAdminIdentity(req);
  for (const row of keep.map(i => rows[i])) {
    try {
      const owner = db.prepare("SELECT nickname FROM users WHERE id=?").get(row.user_id);
      recordCompetitionEvent(comp.id, "badge_certificate_downloaded", actor, {
        user_id: row.user_id, nickname: owner && owner.nickname, rank: row.rank,
        by_owner: false, via: "top3_zip", ...reqContext(req),
      });
    } catch (e) {
      // audit is best-effort, as for the single download
      swallowed("export-import:top3-certificate-audit", e);
    }
  }
  const slug = _slugForDownload(comp.name || "event");
  // Places on a podium no certificate fills yet: say how many, and why.
  res.set("X-Top3-Count", String(keep.length));
  if (revokedNow) res.set("X-Top3-Revoked", String(revokedNow));
  if (missing) {
    res.set("X-Top3-Missing", String(missing));
    res.set("X-Top3-Missing-Reason", notAutomatic ? refusal : (pending ? "being_issued" : "not_collected"));
  }
  res.set("Content-Disposition", `attachment; filename="${slug}-top-3-certificates.zip"`);
  res.set("Cache-Control", "private, no-store");
  res.type("application/zip");
  res.send(zip);
});

// ── THE EVENT JOIN QR (level H, the event code in a reserved centre) ─────────
//
// Renders the join link the admin ALREADY holds (the audited reveal,
// GET /api/admin/competitions/:id/self-enroll, hands it over) as an SVG with the
// short event code in the middle (lib/qr.js `centre`). It reads nothing and
// stores nothing: the input is the text and label in the body, so it needs no
// entity check and is classified `open`. Bounded inputs; refused, not clipped.
const _QR_LABEL_RE = /^[A-Z0-9][A-Z0-9-]{0,15}$/;
app.post("/api/admin/join-qr", requireAdmin, rateLimit(60_000, 60, "join-qr"), csrfProtection, (req, res) => {
  const text = req.body?.text;
  const label = req.body?.label;
  if (typeof text !== "string" || !text || text.length > 256) {
    return res.status(400).json({ error: "text must be a string of 1 to 256 characters.", code: "qr_text_invalid" });
  }
  if (label !== undefined && label !== null && (typeof label !== "string" || !_QR_LABEL_RE.test(label))) {
    return res.status(400).json({ error: "label must be up to 16 capital letters, digits or hyphens.", code: "qr_label_invalid" });
  }
  let q;
  try {
    q = label ? encodeQr(text, { level: "H", centre: JOIN_QR_CENTRE }) : encodeQr(text, { level: "H" });
  } catch (_) {
    return res.status(400).json({ error: "That link is too long for a QR code.", code: "qr_text_too_long" });
  }
  res.set("Cache-Control", "private, no-store");
  res.type("image/svg+xml");
  res.send(qrSvg(q, { label: label || "", px: 512, title: label ? `Join code ${label}` : "Join QR code" }));
});
};
