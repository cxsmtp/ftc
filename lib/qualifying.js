"use strict";

// QUALIFYING QUESTIONS (event team reports).
//
// A qualifying question is an ORDINARY CHALLENGE carrying the task tag
// `qualifying:<key>` (e.g. `qualifying:developers`). Parsed server-side only, like
// `category:` (lib/categories.js): participants are sent `categories`, never
// `tags`, so the tag is never shown to them. The four built-in questions are
// pick-one questions — an `any` challenge with options (lib/choices.js
// `validateSurveyChoices`): the participant picks one, every option is accepted.
//
// WHAT A QUALIFYING CHALLENGE DOES NOT DO (decided once; each lock is named):
//   • it scores NO points, right or wrong: the submit path and Recalculate store
//     0 for it, so no penalty either. (A pick-one answer is never wrong at the
//     submit, which refuses an empty pick; Recalculate grades an older row's
//     empty stored selection wrong, and prices it 0 all the same.) Locks: a
//     right answer at the submit, tests/event-team-reports.spec.js; Recalculate,
//     a right and a wrong row, tests/qualifying-exclusions.api.spec.js. No test
//     reads the stored price of a wrong answer at the submit (possible only on
//     an older qualifying challenge of another type);
//   • it is NOT a challenge that counts toward finishing: it is left out of the
//     denominator and numerator of "finished every challenge" (the all-solved
//     early end's test, a Program's completion), the leaderboard's finish time
//     (so the tie-break is not moved by when someone answered a marketing
//     question), a completion certificate's date and the participation
//     "attempted" test (neither an answer to it nor a hint revealed on it is
//     taking part). Excluded, not "trivially satisfied": a learner who
//     declines to answer still completes the Program (the tie-break and
//     "attempted": tests/qualifying-exclusions.api.spec.js; the date:
//     tests/completion-credential.spec.js; completion:
//     tests/event-team-reports.spec.js);
//   • answers are stored as ordinary submissions, so nothing new captures them.
//
// THE ONE PLACE THEY ARE WAITED FOR (operator ruling, 17 Nov 2026): the
// all-solved early end fires only once every scoring participant has also
// answered every published qualifying question (`qualifyingAnsweredAll` below),
// and only a FIRST answer to one may run that scan, so a changed answer ends
// nothing (tests/event-team-reports.spec.js). The wait sits beside the
// "finished" test, never inside it: a quick answer still finishes nothing.
//
// The SQL fragment `notQualifyingSql(alias)` is the one definition of "not a
// qualifying challenge"; every counting site uses it.
// tests/qualifying-counting-sites.spec.js holds the named sites, and finds any
// other query of two shapes that leaves it out without a recorded reason: a
// count of an event's challenges (`active=1` beside `status='published'` on a
// `tasks` read, aliased or bare, not pinned to one challenge by its id) and a
// participant's solves (correct `submissions` under `COUNT(DISTINCT` or
// `MAX(submitted_at)`). A count of any other shape, such as solves read from
// `challenge_events` (the Overview's), is held only once it is named there.

const crypto = require("crypto");

const QUALIFYING_PREFIX = "qualifying:";
const KEY_RE = /^[a-z0-9_-]{1,40}$/;

/** The key of one tag, or null when it is not a qualifying tag. */
function qualifyingKeyOfTag(tag) {
  if (typeof tag !== "string") return null;
  const t = tag.trim().toLowerCase();
  if (!t.startsWith(QUALIFYING_PREFIX)) return null;
  const k = t.slice(QUALIFYING_PREFIX.length).trim();
  return KEY_RE.test(k) ? k : null;
}

/** The first qualifying key among a task's tags, or null. */
function qualifyingKeyFromTags(tags) {
  for (const t of tags || []) { const k = qualifyingKeyOfTag(t); if (k) return k; }
  return null;
}

/** Every qualifying key among a task's tags, deduped, in tag order. */
function qualifyingKeysFromTags(tags) {
  const out = [];
  for (const t of tags || []) { const k = qualifyingKeyOfTag(t); if (k && !out.includes(k)) out.push(k); }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// AN EVENT ASKS EACH QUALIFYING QUESTION ONCE (operator ruling N7, 14 Nov 2026)
// ─────────────────────────────────────────────────────────────────────────────
// Another event's qualifying question may be put into an event (the two events
// then share that one question's wording), but never one whose KEY the event
// already holds: the reports keep one challenge per key (lib/event-team.js
// `qualifyingChallenges`, the first by id), so the answers given to the second
// copy would be lost and the event would ask the same thing twice. Every
// challenge the event holds counts, a draft or hidden one included (publishing
// or showing it later would make the duplicate). The assign doors (one, bulk and
// the Assign dialog's desired set), the tag route and restore ask this.

/** The qualifying keys event `compId` holds, other than through challenge `exceptTaskId`: Map key → {task_id, title}. */
function heldQualifyingKeys(db, compId, exceptTaskId = null) {
  const rows = db.prepare(
    `SELECT t.id, t.title, tt.tag FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id
       JOIN task_tags tt ON tt.task_id=t.id AND tt.tag LIKE 'qualifying:%'
      WHERE ct.competition_id=? AND ct.task_id IS NOT ? ORDER BY t.id`
  ).all(compId, exceptTaskId);
  const held = new Map();
  for (const r of rows) {
    const k = qualifyingKeyOfTag(r.tag);
    if (k && !held.has(k)) held.set(k, { task_id: r.id, title: r.title });
  }
  return held;
}

/**
 * Would putting a challenge carrying `keys` into event `comp` ({id, name}) make
 * it ask one qualifying question twice? null, or the refusal
 * `{ code: "qualifying_key_held", message, key, held_task_id, held_title }`.
 * `taskId` is the challenge itself, which never duplicates itself.
 */
function qualifyingKeyHeldDenied(db, comp, taskId, keys) {
  if (!comp || !Array.isArray(keys) || !keys.length) return null;
  const held = heldQualifyingKeys(db, comp.id, taskId);
  for (const key of keys) {
    const h = held.get(key);
    if (!h) continue;
    return {
      code: "qualifying_key_held", key, held_task_id: h.task_id, held_title: h.title,
      message: `“${comp.name}” already has a qualifying question on this topic (“${h.title}”). An event asks each one once, so its answers are not split between two copies. To use this one instead, remove that question from the event first.`,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ONCE ANSWERED, A QUALIFYING QUESTION'S OPTIONS KEEP THEIR PLACES
// (operator ruling 84, 14 Nov 2026)
// ─────────────────────────────────────────────────────────────────────────────
// The hot rule and the opener read an answer by the POSITION of the option
// picked (`classifyLead`, `suggestedOpener`), and an answer is stored as the
// option's id. So once anyone has answered, every stored option must stay where
// it is: a reworded option keeps its id and its place (allowed, and the editor
// keeps the id of a line edited in place); moving one, removing one, or adding
// one anywhere but at the end shifts what earlier answers mean, and is refused.
// Dropping every option (a switch to a free answer or another type) removes
// them all. Only a QUALIFYING question is bound: an ordinary pick-one question's
// answers are never read by position.

/** Does `next` keep every `stored` option at its place? null, or the refusal. Pure. */
function answeredOptionsChangeDenied(stored, next) {
  const s = Array.isArray(stored) ? stored : [];
  const n = Array.isArray(next) ? next : [];
  for (let i = 0; i < s.length; i++) {
    if (n[i] && n[i].id === s[i].id) continue;
    return {
      code: "qualifying_options_fixed",
      message: "People have answered this qualifying question, and each answer is read by the place of the option picked, so the options must stay where they are. You can reword an option or add one at the end, but not move or remove one.",
    };
  }
  return null;
}

// A pick-one question: an `any` challenge with two or more options (lib/choices.js `isSurveyTask`).
function _isPickOneRow(task) {
  return !!task && require("./choices").isSurveyTask(task);
}
const _isQualifyingTagName = (t) => typeof t === "string" && t.trim().toLowerCase().startsWith(QUALIFYING_PREFIX);

// WHY AN EVENT WHERE STAFF COMPETE ASKS NO QUALIFYING QUESTION (sweep #87). It
// admits sealed challenges only (lib/staff-compete.js), and a qualifying question
// is a pick-one Any answer question (below), which can never be sealed
// (lib/answer-seal.js `sealTypeDenied`): so it can ask none, built-in or an
// organiser's own. The create route and the clone/spawn writer refuse an explicit
// "Add the qualifying questions" with this one sentence; the old one told
// organisers to add their own sealed qualifying challenges, which every door
// refuses.
const QUALIFYING_IN_COMPETE_EVENT_ERROR = "An event where staff compete holds sealed questions only, and a qualifying question (an Any answer question) can never be sealed, so such an event cannot ask qualifying questions. Leave out the qualifying questions, or turn off staff competing.";

/**
 * ONLY A PICK-ONE QUESTION CAN BE A QUALIFYING QUESTION (9.2.2). The reports,
 * the lead file and the hot-lead rule read an answer as the PLACE of the one
 * option picked (`classifyLead`, lib/event-team.js), so a text, free-answer or
 * file question tagged `qualifying:` was accepted and then ignored (its answers
 * reached no report, and everyone read as unanswered), and a multiple-choice
 * one was read only when exactly one option was picked.
 * Refused instead (accept-and-ignore is worse than no control) wherever a tag
 * is added or a tagged challenge's type or options change: the tag route, the
 * task PUT, restore and the task import. `row` is the prospective
 * {answer_type, choices}; null when it is a pick-one question.
 */
const QUALIFYING_NEEDS_PICK_ONE_ERROR = "Only a pick-one question (Any answer, with two or more options) can be a qualifying question: the event team's reports read which option each person picked. Give it options, or tag another challenge.";
function qualifyingNeedsPickOneDenied(row) {
  return _isPickOneRow(row) ? null : { code: "qualifying_needs_pick_one", message: QUALIFYING_NEEDS_PICK_ONE_ERROR };
}
/** Does this tag list make a challenge a qualifying one (any `qualifying:` tag, as scoring reads them)? */
function tagsMakeQualifying(tags) {
  return (tags || []).some(_isQualifyingTagName);
}
/**
 * A QUICK QUESTION WHOSE ANSWER CAN BE CHANGED (operator ruling 395, 14 Nov
 * 2026): a qualifying pick-one question takes a new pick as another row while
 * the person can still play, past "already solved" and past the attempt cap, so
 * it is never out of attempts. Never a scoring challenge, nor an older
 * qualifying question of another type, which keeps "already solved" and spends
 * attempts. `row` is {answer_type, choices}; `qualifying` whether the challenge
 * is a qualifying one (`isQualifyingTask`). The one definition the submit, the
 * challenge read (its `answer_changeable` offer and its attempt keys) and the
 * list's `out_of_attempts` (lib/attempts.js) ask.
 */
function changeableQuickQuestion(row, qualifying) {
  return !!qualifying && _isPickOneRow(row);
}
/**
 * The `qualifying:` tags in this list whose key the tag route refuses
 * (`qualifying_tag_invalid`), as they would be stored (trimmed, lower-case):
 * scoring reads such a tag (the challenge scores nothing) while the reports,
 * the numbering and the one-per-event rule cannot (sweep #413).
 */
function malformedQualifyingTags(tags) {
  return (tags || []).filter(_isQualifyingTagName).map(t => t.trim().toLowerCase()).filter(t => !qualifyingKeyOfTag(t));
}

/**
 * Are `task`'s options fixed — a qualifying pick-one question ({id, answer_type,
 * choices}) somebody has answered? `extraTags` (a restore's prospective tags)
 * count as qualifying too: options moved in the same act that makes a pick-one
 * question a qualifying one would be read by their new places.
 */
function qualifyingOptionsFixed(db, task, extraTags = null) {
  if (!_isPickOneRow(task)) return false;
  if (!isQualifyingTask(db, task.id) && !(extraTags || []).some(_isQualifyingTagName)) return false;
  return !!db.prepare("SELECT 1 FROM submissions WHERE task_id=? LIMIT 1").get(task.id);
}

/** The same question for many rows at once (the admin library): a Set of ids. `tagsOf(id)` gives a row's tags. */
function qualifyingOptionsFixedSet(db, tasks, tagsOf) {
  const cand = (tasks || []).filter(t => _isPickOneRow(t) && (tagsOf(t.id) || []).some(_isQualifyingTagName)).map(t => t.id);
  if (!cand.length) return new Set();
  return new Set(db.prepare("SELECT DISTINCT task_id FROM submissions WHERE task_id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(cand)).map(r => r.task_id));
}

/** SQL: true for a qualifying challenge (alias = the tasks alias). */
function qualifyingSql(alias) {
  return `EXISTS (SELECT 1 FROM task_tags qtg WHERE qtg.task_id=${alias}.id AND qtg.tag LIKE 'qualifying:%')`;
}
/** SQL: true for a challenge that is NOT qualifying. */
function notQualifyingSql(alias) { return `NOT ${qualifyingSql(alias)}`; }

/**
 * Have these participants answered every published qualifying question of the
 * event? The all-solved early end waits for it (operator ruling, 17 Nov 2026):
 * ending on the last scoring answer cut the quick questions off for anyone yet
 * to answer them, and those leads were reported with no answers. True when the
 * event asks none.
 */
function qualifyingAnsweredAll(db, participantIds, competitionId) {
  if (!participantIds.length) return true;
  const asked = db.prepare(
    `SELECT COUNT(*) AS c FROM competition_tasks ct JOIN tasks t ON t.id=ct.task_id
      WHERE ct.competition_id=? AND t.active=1 AND t.status='published' AND ${qualifyingSql("t")}`
  ).get(competitionId).c;
  if (!asked) return true;
  const done = db.prepare(
    `SELECT COUNT(*) AS c FROM (SELECT s.user_id FROM submissions s
       JOIN competition_tasks ct ON ct.task_id=s.task_id AND ct.competition_id=s.competition_id
       JOIN tasks t ON t.id=s.task_id
      WHERE s.competition_id=? AND s.user_id IN (SELECT value FROM json_each(?))
        AND t.active=1 AND t.status='published' AND ${qualifyingSql("t")}
      GROUP BY s.user_id HAVING COUNT(DISTINCT s.task_id) >= ?)`
  ).get(competitionId, JSON.stringify(participantIds), asked).c;
  return done >= participantIds.length;
}

/** Is this task a qualifying challenge? */
function isQualifyingTask(db, taskId) {
  return !!db.prepare("SELECT 1 FROM task_tags WHERE task_id=? AND tag LIKE 'qualifying:%' LIMIT 1").get(taskId);
}

// The four built-in questions. The ORDER of `options` is load-bearing: the hot
// rule (`classifyLead`) reads an answer by its POSITION in the author's order,
// so an organiser may reword an option but, once anyone has answered, not move
// or remove one (`answeredOptionsChangeDenied` above).
const DEFAULT_QUALIFYING = Object.freeze([
  { key: "developers", title: "How many developers are in your organisation?",
    options: ["1–49", "50–249", "250–999", "1000+"] },
  { key: "scanner", title: "Are you using a code security scanner today?",
    options: ["None", "Open source", "Commercial", "Not sure"] },
  { key: "evaluating", title: "Are you evaluating an AppSec solution?",
    options: ["No", "Yes, within 3 months", "Yes, in 3–6 months", "Yes, in 6–12 months"] },
  { key: "follow_up", title: "Would you like someone to follow up with you?",
    options: ["Yes", "No"] },
]);

// A qualifying challenge is numbered in its OWN level, after the three difficulty
// levels (lib/competitions.js _assignTaskNumbers), so it comes last in the list,
// in the play bar and in Back/Next: "your final challenges", and the numbers say
// so. Its difficulty is a stored formality (the column is NOT NULL) and never
// reaches a participant's screen.
const QUALIFYING_NUMBER_LEVEL = 4;

/** The fixed order: the built-in keys as defined, an organiser's own after, by key. */
function compareQualifyingKeys(a, b) {
  const order = DEFAULT_QUALIFYING.map(q => q.key);
  const ia = order.indexOf(a), ib = order.indexOf(b);
  return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib) || String(a).localeCompare(String(b));
}

/**
 * Create the four built-in qualifying challenges FOR ONE EVENT and assign them.
 * Per-event copies, so an organiser edits or removes them for this event only.
 * Runs inside the caller's transaction; returns the new task ids. Easy, 0 points
 * (the submit path scores a qualifying challenge 0 whatever its difficulty).
 */
function seedQualifyingChallenges(db, competitionId, { actorEmail, actorUserId, nowIso }) {
  const ids = [];
  const insTask = db.prepare(
    "INSERT INTO tasks (id,title,description,difficulty,answer_type,correct_answer,choices,explanation,hint,attachment_url,active,status,author_name,author_linkedin,attempt_cap,updated_at,created_by_id,answer_sealed) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)"
  );
  const insTag = db.prepare("INSERT OR IGNORE INTO task_tags (task_id, tag) VALUES (?,?)");
  const insCt = db.prepare("INSERT OR IGNORE INTO competition_tasks (competition_id, task_id, assigned_by, assigned_at, assigned_by_id) VALUES (?,?,?,?,?)");
  for (const q of DEFAULT_QUALIFYING) {
    const id = crypto.randomUUID();
    const choices = q.options.map(text => ({ id: crypto.randomBytes(4).toString("hex"), text }));
    insTask.run(id, q.title, "<p>Pick the answer that fits best. Every answer is accepted and scores no points.</p>",
      "easy", "any", "", JSON.stringify(choices), "", null, null, "published", null, null, null, nowIso, actorUserId || null, 0);
    insTag.run(id, QUALIFYING_PREFIX + q.key);
    insCt.run(competitionId, id, actorEmail || "system", nowIso, actorUserId || null);
    ids.push(id);
  }
  return ids;
}

/**
 * THE HOT RULE (default). `pos` maps a qualifying key to the 0-based position
 * of the option the person picked (author order), or undefined.
 *   big   = developers at "250–999" or "1000+" (position >= 2)
 *   soon  = evaluating "within 3 months" or "in 3–6 months" (position 1 or 2)
 *   ask   = follow_up "Yes" (position 0)
 * Hot = (big AND soon) OR ask. Warm = exactly one of big, soon. Cold = neither.
 */
function classifyLead(pos) {
  const p = pos || {};
  const big = Number.isInteger(p.developers) && p.developers >= 2;
  const soon = p.evaluating === 1 || p.evaluating === 2;
  const ask = p.follow_up === 0;
  if ((big && soon) || ask) return "hot";
  if (big !== soon) return "warm";
  return "cold";
}

/**
 * THE SDR's SUGGESTED OPENER: a template over what the person told us, no AI. It
 * names evaluating or team size only when that says something (a "No", a small
 * team or no answer is left out), says so when they asked for a follow-up, and
 * does not press for a call when they said no to one. Reads answers by POSITION,
 * like `classifyLead`, so a reworded option changes nothing. Pure.
 */
function suggestedOpener(lead, eventName) {
  const l = lead || {};
  const pos = l.positions || {}, text = l.answers || {};
  const first = String(l.first_name || "").trim();
  const solved = Number.isInteger(l.solved) && l.solved > 0 ? ` and solving ${l.solved} challenge${l.solved === 1 ? "" : "s"}` : "";
  const open = `Hi${first ? ` ${first}` : ""}, thanks for joining ${eventName}${solved}.`;
  const big = Number.isInteger(pos.developers) && pos.developers >= 2 && text.developers;
  const evaluating = Number.isInteger(pos.evaluating) && pos.evaluating >= 1 && text.evaluating
    ? String(text.evaluating).replace(/^\s*yes\s*,?\s*/i, "").trim() : "";
  const teamBit = big ? `your team has ${text.developers} developers` : "";
  const evalBit = evaluating ? `you are evaluating an AppSec solution (${evaluating})` : "";
  const said = [evalBit, teamBit].filter(Boolean).join(" and ");
  if (pos.follow_up === 0) {
    return `${open} You asked us to follow up${said ? `, and you mentioned ${said}` : ""}. What time suits you for 20 minutes this week?`;
  }
  if (pos.follow_up === 1) {
    return `${open}${said ? ` You mentioned ${said}.` : ""} You said no follow-up is needed for now, so there is no rush: if securing your code comes up, we are glad to help.`;
  }
  if (said) return `${open} You mentioned ${said}. Would a 20-minute call on how teams like yours secure their code be useful?`;
  return `${open} Would a 20-minute call on how teams like yours secure their code be useful?`;
}

module.exports = {
  QUALIFYING_PREFIX, DEFAULT_QUALIFYING, QUALIFYING_NUMBER_LEVEL, compareQualifyingKeys, suggestedOpener,
  qualifyingKeyOfTag, qualifyingKeyFromTags, qualifyingKeysFromTags, qualifyingSql, notQualifyingSql, isQualifyingTask, qualifyingAnsweredAll, malformedQualifyingTags,
  heldQualifyingKeys, qualifyingKeyHeldDenied, answeredOptionsChangeDenied, qualifyingOptionsFixed, qualifyingOptionsFixedSet,
  qualifyingNeedsPickOneDenied, tagsMakeQualifying, changeableQuickQuestion, QUALIFYING_NEEDS_PICK_ONE_ERROR, QUALIFYING_IN_COMPETE_EVENT_ERROR,
  seedQualifyingChallenges, classifyLead,
};
