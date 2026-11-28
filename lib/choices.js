"use strict";
//
// v7.19.0 — multiple-choice challenges.
//
// STORAGE
// ───────
//   tasks.choices        JSON: [{ id, text }, …]   — the options, in author order
//   tasks.correct_answer JSON: ["id", …]           — which of them are correct
//
// Reusing `correct_answer` for the correct SET rather than adding a second
// column is deliberate: `taskGradingHash()` already hashes `correct_answer`, so
// the existing "the admin changed the answer between page-load and submit"
// guard covers a change to the correct set for free. The hash also takes
// `choices` (see lib/scoring.js) so that editing or removing an OPTION — which
// leaves the correct set untouched — still invalidates an in-flight submission.
//
// IDENTITY, NOT POSITION
// ──────────────────────
// Choices are shuffled per participant, so nothing may key on position: the
// participant submits choice IDs and the server grades IDs. An id is minted
// once when the author adds the choice and never changes, so renaming a choice
// does not invalidate anyone's in-flight selection (the grading hash decides
// whether it should, which is a separate question from identity).
const crypto = require("crypto");

const MAX_CHOICES = 20;
const MIN_CHOICES = 2;
const MAX_CHOICE_LEN = 300;

function newChoiceId() { return crypto.randomBytes(4).toString("hex"); }

/** Parse the stored `choices` column. Never throws — a bad row yields []. */
function parseChoices(raw) {
  if (!raw) return [];
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(v)) return [];
    return v
      .filter(c => c && typeof c === "object" && typeof c.id === "string" && typeof c.text === "string")
      .map(c => ({ id: c.id, text: c.text }));
  } catch (_) { return []; }
}

/** Parse the stored correct-id set (`correct_answer` for a choice task). */
function parseCorrectIds(raw) {
  if (!raw) return [];
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(v)) return [];
    return [...new Set(v.filter(x => typeof x === "string"))];
  } catch (_) { return []; }
}

/**
 * Validate + normalise an author-supplied choice set.
 * Returns { error } or { choices, correctAnswer } ready to store.
 *
 * `incoming` is the client shape: [{ id?, text, correct }] — the id is optional
 * so a brand-new choice can be minted here rather than trusting the client to
 * generate one.
 */
function validateChoices(incoming) {
  if (!Array.isArray(incoming)) return { error: "Multiple-choice questions need a list of choices." };
  const rows = incoming.filter(c => c && typeof c === "object");
  if (rows.length < MIN_CHOICES) return { error: `A multiple-choice question needs at least ${MIN_CHOICES} choices.` };
  if (rows.length > MAX_CHOICES) return { error: `A multiple-choice question can have at most ${MAX_CHOICES} choices.` };

  const choices = [];
  const seenText = new Set();
  const seenId = new Set();
  const correct = [];
  for (const r of rows) {
    if (typeof r.text !== "string") return { error: "Each choice must be text." };
    const text = r.text.trim();
    if (!text) return { error: "A choice cannot be empty." };
    if (text.length > MAX_CHOICE_LEN) return { error: `A choice must be ${MAX_CHOICE_LEN} characters or fewer.` };
    // Duplicate options are always an authoring mistake, and they make the
    // rendered question unanswerable — two identical rows, one of them wrong.
    const key = text.toLowerCase();
    if (seenText.has(key)) return { error: `Two choices have the same text: "${text}".` };
    seenText.add(key);

    // Accept an existing id so edits keep identity (and therefore keep any
    // in-flight selection meaningful); mint one otherwise.
    let id = typeof r.id === "string" && /^[a-f0-9]{8}$/.test(r.id) ? r.id : newChoiceId();
    while (seenId.has(id)) id = newChoiceId();
    seenId.add(id);

    choices.push({ id, text });
    if (r.correct === true || r.correct === 1 || r.correct === "1" || r.correct === "true") correct.push(id);
  }
  if (!correct.length) return { error: "Tick at least one choice as correct." };
  if (correct.length === choices.length) {
    // Every option correct means the question cannot be got wrong; that is
    // always an authoring slip rather than an intent.
    return { error: "At least one choice must be incorrect, or the question cannot be answered wrongly." };
  }
  return { choices, correctAnswer: JSON.stringify(correct) };
}

/**
 * ext-audit v7.20.9 (F10) — the IMPORT's canonical gate.
 *
 * Same rule set as `validateChoices`, but it REJECTS what that function
 * REPAIRS, and it takes the STORED shape (the `choices` JSON column plus the
 * `correct_answer` JSON) rather than the authoring shape. Both differences are
 * required, which is why this is a twin rather than a call into it:
 *
 *   • Import must preserve choice ids VERBATIM — re-minting them would sever
 *     `correct_answer` from the options it names — so a duplicate or
 *     non-canonical id has to be a refusal here, where `validateChoices`
 *     legitimately mints a replacement for an author typing in the editor.
 *   • `validateChoices` consumes `[{text, correct}]`; a stored row is
 *     `[{id, text}]` plus a separate id list.
 *
 * What the import used to check was only "≥2 options, ≥1 correct, not all
 * correct, every correct id names an option". That let through, silently:
 *   • duplicate IDS — two visually distinct options sharing one id, so ticking
 *     either grades as the same answer and `describeSelection` renders whichever
 *     text happened to land last in the map;
 *   • duplicate TEXT — two identical rows, one right and one wrong, which is
 *     unanswerable by inspection;
 *   • non-canonical ids — harmless to grading (ids are opaque strings
 *     everywhere), but `validateChoices` re-mints anything that fails
 *     /^[a-f0-9]{8}$/, so the FIRST time an admin opened and saved such a task
 *     the editor silently changed every id on a task whose whole doctrine is
 *     that ids never change.
 *
 * Returns null when the row is importable, else a reason string.
 */
function storedChoiceRowError(choicesRaw, correctRaw) {
  const opts = parseChoices(choicesRaw);
  if (opts.length < MIN_CHOICES) return `needs at least ${MIN_CHOICES} choices`;
  if (opts.length > MAX_CHOICES) return `has more than ${MAX_CHOICES} choices`;
  const seenText = new Set(), seenId = new Set();
  for (const c of opts) {
    const text = String(c.text || "").trim();
    if (!text) return "has an empty choice";
    if (text.length > MAX_CHOICE_LEN) return `has a choice longer than ${MAX_CHOICE_LEN} characters`;
    const tk = text.toLowerCase();
    if (seenText.has(tk)) return `has two choices with the same text: "${text}"`;
    seenText.add(tk);
    if (!/^[a-f0-9]{8}$/.test(c.id)) return `has a choice id that is not 8 hex characters: "${c.id}"`;
    if (seenId.has(c.id)) return `has two choices sharing the id "${c.id}"`;
    seenId.add(c.id);
  }
  const correct = parseCorrectIds(correctRaw);
  if (!correct.length) return "marks no choice as correct";
  // Counted against the DE-DUPLICATED id set — this is the check duplicate ids
  // used to defeat, because the old comparison used the raw option count.
  if (correct.length >= seenId.size) return "marks every choice correct, so it cannot be answered wrongly";
  for (const id of correct) if (!seenId.has(id)) return `marks a correct id ("${id}") that names no choice`;
  return null;
}

/**
 * Deterministic per-participant shuffle.
 *
 * Deterministic matters twice over: a refresh must not reorder the options
 * under someone mid-read, and two page-loads must agree so a participant can
 * refer to what they saw. Keyed on (user, task) so two participants get
 * different orders and "it's the third one" carries no information.
 */
function shuffleChoicesFor(choices, userId, taskId) {
  const out = [...choices];
  if (out.length < 2) return out;
  // A Fisher-Yates driven by a hash chain: deterministic, uniform enough for
  // this purpose, and needs no seeded-PRNG dependency.
  let digest = crypto.createHash("sha256").update(`${userId}:${taskId}`).digest();
  let p = 0;
  const nextByte = () => {
    if (p >= digest.length) { digest = crypto.createHash("sha256").update(digest).digest(); p = 0; }
    return digest[p++];
  };
  for (let i = out.length - 1; i > 0; i--) {
    // Rejection-free enough: 2 bytes over a range ≤20 has negligible bias.
    const r = (nextByte() << 8 | nextByte()) % (i + 1);
    [out[i], out[r]] = [out[r], out[i]];
  }
  return out;
}

/** Set equality of submitted ids against the correct ids. */
function gradeChoice(submittedIds, correctIds) {
  const a = new Set((submittedIds || []).filter(x => typeof x === "string"));
  const b = new Set(correctIds || []);
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Parse what a participant submitted: a JSON array of ids, or a single id.
 * v8.14.6 — an array holding anything but strings yields [], as unparseable
 * input does, so submit refuses it rather than grading the strings left over.
 */
function parseSubmittedIds(answer) {
  const ids = (v) => (Array.isArray(v) && v.every(x => typeof x === "string") ? v : []);
  if (Array.isArray(answer)) return ids(answer);
  if (typeof answer !== "string") return [];
  const s = answer.trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try { return ids(JSON.parse(s)); } catch (_) { return []; }
  }
  return [s];
}

/**
 * Human-readable rendering of a selection, for `submissions.answer`.
 * The admin Submissions view shows that column verbatim, and a list of opaque
 * 8-hex ids there would be useless to the person reading it.
 */
function describeSelection(submittedIds, choices) {
  const byId = new Map(choices.map(c => [c.id, c.text]));
  const picked = (submittedIds || []).map(id => byId.get(id)).filter(Boolean);
  return picked.length ? picked.join(" | ") : "(nothing selected)";
}

/**
 * v8.14.6 — a stored multiple-choice answer whose selection is an empty list
 * (`answer_canonical` is written only for choice answers). Submit refuses such
 * an answer now; older rows remain. The "(nothing selected)" text proves
 * nothing on its own, as an option may carry it, and once a challenge leaves
 * multiple choice its options are gone, so the empty list is the only proof.
 */
function storedChoicePickedNothing(row) {
  if (row.answer_canonical == null) return false;
  try {
    const v = JSON.parse(row.answer_canonical);
    return Array.isArray(v) && v.length === 0;
  } catch (_) { return false; }
}

/** 'single' when exactly one choice is correct, else 'multi'. */
function choiceMode(correctIds) { return (correctIds || []).length === 1 ? "single" : "multi"; }

/**
 * A row submitted before `answer_canonical` existed (v7.20.9) holds only its
 * human rendering ("Paris | Rome"). Its ids are re-derived by matching option
 * TEXT, trimmed and case-folded, which is exact while the options have not been
 * renamed. `choiceIdsByText` maps each label to its id, or to null when two
 * options share it; `legacySelectionIds` returns null when any label is
 * ambiguous or names no option, because guessing would grade a row on options
 * it never picked. Recalculate and the participant solver concession share them.
 */
function choiceIdsByText(choices) {
  const byText = new Map();
  for (const c of choices) {
    const k = String(c.text).trim().toLowerCase();
    byText.set(k, byText.has(k) ? null : c.id);   // null ⇒ ambiguous label
  }
  return byText;
}
function legacySelectionIds(answer, byText) {
  const labels = String(answer || "").split("|").map(x => x.trim()).filter(Boolean);
  const mapped = labels.map(l => byText.get(l.toLowerCase()));
  return (!labels.length || mapped.some(id => !id)) ? null : mapped;
}

/**
 * EVENT TEAM REPORTS — THE PICK-ONE QUESTION ("every option accepted").
 *
 * An `any` challenge may carry `choices`: the participant picks exactly ONE
 * option and every option is accepted (graded correct). This is how a
 * qualifying question is asked (lib/qualifying.js). No new answer type, so the
 * `tasks` CHECK needs no rebuild: `correct_answer` stays "" (an `any` has no
 * key) and the options live in the same `choices` column multiple choice uses.
 *
 * Same option rules as `validateChoices` (2..MAX_CHOICES, unique non-empty
 * text, ids kept when canonical, minted otherwise); a `correct` flag is
 * IGNORED, since every option is accepted. Returns { error } or { choices }.
 * `null`, `undefined` or an empty list means "no options" (a free response).
 */
function validateSurveyChoices(incoming) {
  if (incoming == null || (Array.isArray(incoming) && incoming.length === 0)) return { choices: null };
  if (!Array.isArray(incoming)) return { error: "Options must be a list." };
  const rows = incoming.filter(c => c && typeof c === "object");
  if (rows.length < MIN_CHOICES) return { error: `A pick-one question needs at least ${MIN_CHOICES} options.` };
  if (rows.length > MAX_CHOICES) return { error: `A pick-one question can have at most ${MAX_CHOICES} options.` };
  const choices = [];
  const seenText = new Set(), seenId = new Set();
  for (const r of rows) {
    if (typeof r.text !== "string") return { error: "Each option must be text." };
    const text = r.text.trim();
    if (!text) return { error: "An option cannot be empty." };
    if (text.length > MAX_CHOICE_LEN) return { error: `An option must be ${MAX_CHOICE_LEN} characters or fewer.` };
    const key = text.toLowerCase();
    if (seenText.has(key)) return { error: `Two options have the same text: "${text}".` };
    seenText.add(key);
    let id = typeof r.id === "string" && /^[a-f0-9]{8}$/.test(r.id) ? r.id : newChoiceId();
    while (seenId.has(id)) id = newChoiceId();
    seenId.add(id);
    choices.push({ id, text });
  }
  return { choices };
}

/** The import's twin for a stored pick-one row: null when importable, else a reason. */
function storedSurveyRowError(choicesRaw) {
  if (choicesRaw == null || choicesRaw === "") return null;
  const opts = parseChoices(choicesRaw);
  if (opts.length < MIN_CHOICES) return `needs at least ${MIN_CHOICES} options`;
  if (opts.length > MAX_CHOICES) return `has more than ${MAX_CHOICES} options`;
  const seenText = new Set(), seenId = new Set();
  for (const c of opts) {
    const text = String(c.text || "").trim();
    if (!text) return "has an empty option";
    if (text.length > MAX_CHOICE_LEN) return `has an option longer than ${MAX_CHOICE_LEN} characters`;
    if (seenText.has(text.toLowerCase())) return `has two options with the same text: "${text}"`;
    seenText.add(text.toLowerCase());
    if (!/^[a-f0-9]{8}$/.test(c.id)) return `has an option id that is not 8 hex characters: "${c.id}"`;
    if (seenId.has(c.id)) return `has two options sharing the id "${c.id}"`;
    seenId.add(c.id);
  }
  return null;
}

/** True when this row is a pick-one question (`any` with at least two options). */
function isSurveyTask(row) {
  return !!row && row.answer_type === "any" && parseChoices(row.choices).length >= MIN_CHOICES;
}

module.exports = {
  MAX_CHOICES,
  parseChoices, parseCorrectIds, validateChoices, storedChoiceRowError,
  shuffleChoicesFor, gradeChoice, parseSubmittedIds, describeSelection, choiceMode,
  choiceIdsByText, legacySelectionIds, storedChoicePickedNothing,
  validateSurveyChoices, storedSurveyRowError, isSurveyTask,
};
