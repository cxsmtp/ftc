"use strict";

// Scoring primitives (domain: Submission / Challenge). No db deps.
// Easy/Medium/Hard point values, the wrong-answer penalty, the answer/difficulty
// enum allowlists, the deep-equality check used by json-typed challenges, and the
// grading-revision token that detects mid-flight admin edits between load +
// submit. v7.20.9: that token is now keyed, so this module reads one file from
// DATA_DIR (lazily, on first use) — everything else here stays pure.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { swallowed } = require("./best-effort");
const { DATA_DIR } = require("./config");

const POINTS  = { easy: 50, medium: 100, hard: 150 };
const PENALTY = 5;
// v7.21.6 — revealing a hint costs 30% of the challenge's face value. This was
// open-coded at four sites with no shared constant, one of which is the price
// QUOTED TO THE PARTICIPANT before they spend it. The three server sites import
// it now; the client cannot (public/js is a browser-only ESM graph), so its copy
// stays a mirror and is pinned by the Docs-hygiene drift lock.
const HINT_DEDUCTION_RATE = 0.3;
// Enum allowlists for task scoring/answer fields. A bogus `difficulty` would make
// a correct submission compute POINTS[undefined] → better-sqlite3 rejects the
// undefined bind → the submit transaction throws for EVERY participant on that
// task (a per-task submit DoS), and the raw value is also reflected into the DOM.
const VALID_DIFFICULTIES = new Set(["easy", "medium", "hard"]);
// v8.9.0 — `any`: any NON-EMPTY answer is correct, accepted VERBATIM (no
// whitespace strip, no case fold), no hint is ever stored on it, and the client
// shows no wrong-answer warning because there is no wrong answer to warn about.
// The enum lives in FIVE places: this Set, the two route-guard messages in
// routes/challenges.js, the swagger enums, the tasks.answer_type CHECK
// constraint in db.js (with its rebuild migration), and the admin form's
// <select> in public/index.html.
const VALID_ANSWER_TYPES = new Set(["text", "json", "file", "choice", "any"]);

// v8.9.0 — does this answer type carry a CORRECT ANSWER at all? `any` stores
// "" in the NOT NULL column, so every site that treats a blank correct_answer as
// an error (POST/PUT/restore/import) asks this rather than re-spelling `=== "any"`.
// An absent type is `text` — the create INSERT and the import both default it so.
function answerTypeHasKey(answerType) { return (answerType || "text") !== "any"; }

// ── TEXT grading ─────────────────────────────────────────────────────────────
//
// v8.9.0 — the ONE definition of the text rule, which was spelled inline twice
// (the submit path in server.js and recalculate in routes/challenges.js): every
// whitespace character stripped, then case folded, on BOTH sides.
function normaliseTextAnswer(s) {
  return String(s == null ? "" : s).replace(/\s/g, "").toLowerCase();
}

// v8.9.0 — MULTIPLE ACCEPTED ANSWERS on `text`, stored NEWLINE-SEPARATED in the
// same `correct_answer` column. A newline can never be significant in a text
// answer (the rule above strips every whitespace character before comparing),
// so it is a delimiter no single answer can collide with, and a one-line value
// grades exactly as it always did. `file` is deliberately NOT routed through
// this: a file's expected content may legitimately span lines, so the file
// path keeps the single-string rule. Stated one-way consequence: a text row
// that already carried an embedded newline (reachable only through the API or
// an import — the admin box is a single-line input) accepts each line rather
// than the concatenation from this release on.
//
// SPLIT ONLY — the whole string is NOT added as an extra alternative. Doing so
// would make "42forty-two" an accepted answer on every new row that lists 42
// and forty-two, a permanent grading wart to preserve a corpus reachable only
// by hand.
function textAnswerAlternatives(stored) {
  return String(stored == null ? "" : stored).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

function gradeTextAnswer(answer, stored) {
  const key = normaliseTextAnswer(answer);
  return textAnswerAlternatives(stored).some(a => normaliseTextAnswer(a) === key);
}

// The stored form: trimmed lines, blank lines dropped, duplicates (under the
// grading rule) dropped keeping the first spelling, joined with "\n". Idempotent,
// so re-canonicalising a stored value changes nothing — which is what lets a
// writer compare canonical-to-canonical and leave an unchanged column alone.
// Returns "" for a value with no usable line, which the callers refuse.
function canonicaliseTextAnswers(raw) {
  const seen = new Set();
  const out = [];
  for (const line of textAnswerAlternatives(raw)) {
    const k = normaliseTextAnswer(line);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(line);
  }
  return out.join("\n");
}

function jsonExactMatch(a, b) {
  if (typeof a !== typeof b) return false;
  if (a === null || typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => jsonExactMatch(v, b[i]));
  }
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  if (ka.some((k, i) => k !== kb[i])) return false;
  return ka.every(k => jsonExactMatch(a[k], b[k]));
}

// ── Grading-revision token ───────────────────────────────────────────────────
//
// ext-audit v7.20.9 (F1) — this value is HANDED TO THE PARTICIPANT, so it must
// disclose nothing about the answer it describes.
//
// It used to be `sha1(answer_type + ":" + correct_answer + ":" + choices)`,
// truncated to 16 hex, with no key. Every input except `correct_answer` is
// already known to the client, so the token was a published, offline-checkable
// oracle for the one field that is meant to be secret:
//
//   • TEXT / JSON — an unlimited, un-rate-limited dictionary attack. The
//     auditor recovered a real answer from a small word list.
//   • CHOICE — outright broken rather than merely weakened. The client is
//     already given every option's id and text, and `correct_answer` is a JSON
//     array of a SUBSET of those ids, so the candidate space for a four-option
//     question is a few hundred strings (orderings × subsets). Anyone could
//     compute the correct answer to every multiple-choice question before
//     answering it.
//
// The fix keys the digest with a server-side secret that is never sent
// anywhere, so the token stays a stable fingerprint of the grading basis while
// carrying no recoverable information about it.
//
// WHY A KEYED DIGEST RATHER THAN A STORED PER-TASK REVISION (which is what the
// finding proposed): both are opaque, but a stored revision has to be BUMPED by
// every writer that touches the grading basis — the PUT, restore, import (two
// branches), and whatever is added next — and a writer that forgets does not
// fail, it silently stops protecting participants. That is precisely the class
// of defect this codebase keeps rediscovering (see F3 and F4 in this same
// round, both "a second write path was missed"). Deriving the token means no
// writer can forget: change the answer by any route and the token changes by
// construction.
//
// The key lives in DATA_DIR/.grading-secret (0600, 32 random bytes), created on
// first boot and re-read afterwards — the same shape as .unsubscribe-secret,
// and it is backed up by scripts/backup.sh for the same reason. Losing it is
// benign: every in-flight token stops matching, so participants with a page
// already open get one "reload the challenge" notice and nothing is mis-scored.
const _GRADING_SECRET_PATH = path.join(DATA_DIR, ".grading-secret");
let _gradingSecret = null;
// ext-audit v7.21.1 — a TRUNCATED secret file used to become a KNOWN key.
//
// The v7.20.9 version wrote the replacement with `flag:"wx"` to make a
// create-race safe. But that conflated two situations that need opposite
// handling, and the short-file path hit the wrong one:
//
//   1. a short/corrupt file falls through to regeneration;
//   2. `wx` then fails EEXIST — *because the file exists*, which is the very
//      condition we are trying to repair, not a race;
//   3. the EEXIST branch re-read that same short file and returned it WITHOUT
//      re-validating the length.
//
// A zero-byte file therefore keyed every HMAC with the empty string, which is
// exactly the offline-recoverable oracle v7.20.9 existed to close — and it
// PERSISTED, because the 32 fresh bytes were never written, so every restart
// re-entered the same state. Reproduced with 0- and 5-byte files.
//
// The two cases are now distinguished explicitly:
//   • file MISSING  → `wx` create, so a genuine race is still safe.
//   • file PRESENT BUT INVALID → replace it. We know its content is unusable,
//     so there is nothing to lose by overwriting, and `rename` is used rather
//     than a plain write so the swap is atomic (a concurrent reader never sees
//     a half-written key) and replaces a symlink at the destination rather than
//     writing through it.
//   • EEXIST after the create → adopt the peer's key ONLY IF IT IS VALID.
//     Adopting an invalid one is what caused this.
//
// Note the donor this was modelled on, `.unsubscribe-secret` in lib/email.js,
// has always used a plain overwrite and is NOT affected — the `wx` "hardening"
// added here is what introduced the bug.
function _gradingKey() {
  if (_gradingSecret) return _gradingSecret;
  let existedButInvalid = false;
  try {
    const buf = fs.readFileSync(_GRADING_SECRET_PATH);
    if (buf.length >= 16) return (_gradingSecret = buf);
    existedButInvalid = true;                 // present, unusable → must be replaced
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[grading] failed to read persistent secret:", e.message);
      existedButInvalid = true;               // unreadable is not "missing"
    }
  }
  const fresh = crypto.randomBytes(32);
  try {
    if (existedButInvalid) {
      const tmp = `${_GRADING_SECRET_PATH}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, fresh, { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, _GRADING_SECRET_PATH);
    } else {
      fs.writeFileSync(_GRADING_SECRET_PATH, fresh, { mode: 0o600, flag: "wx" });
    }
    try { fs.chmodSync(_GRADING_SECRET_PATH, 0o600); } catch (e) { swallowed("scoring:grading-secret-chmod", e); }
  } catch (e) {
    if (e.code === "EEXIST" && !existedButInvalid) {
      // Another boot won the create race — adopt its key so both agree, but
      // only once it has passed the SAME length check as the read above.
      try {
        const peer = fs.readFileSync(_GRADING_SECRET_PATH);
        if (peer.length >= 16) return (_gradingSecret = peer);
      } catch (e) { /* fall through to the process-lifetime key */ swallowed("scoring:grading-secret-peer-read", e); }
    }
    // A read-only volume must not take the platform down: fall back to a
    // process-lifetime key. Tokens then stop matching across a restart, which
    // costs a reload, not correctness.
    console.error("[grading] could not persist the grading secret — using a process-lifetime key:", e.message);
  }
  return (_gradingSecret = fresh);
}

// Stable, OPAQUE token for a challenge's grading criteria (answer type +
// correct answer + choices). Issued to the client when a challenge loads and
// re-checked on submit — if the admin edits the grading criteria mid-flight the
// tokens diverge and the submit path refuses to score against criteria the
// participant never saw. Used by GET /api/tasks/:id (routes/participant.js) and
// POST /api/tasks/:id/submit (server.js).
function taskGradingHash(answerType, correctAnswer, choices) {
  // v7.19.0 — `choices` joins the basis. For a multiple-choice task the correct
  // SET lives in correctAnswer, so editing the correct answers already changes
  // the token; but editing or REMOVING an option leaves that set untouched while
  // changing what the participant was actually shown. Without choices in the
  // basis, a submission made against the old options would be graded against the
  // new ones and silently penalised.
  return crypto.createHmac("sha256", _gradingKey())
    .update(String(answerType || "")).update(":").update(String(correctAnswer || ""))
    .update(":").update(String(choices || ""))
    .digest("hex").slice(0, 16);
}

module.exports = { POINTS, PENALTY, HINT_DEDUCTION_RATE, VALID_DIFFICULTIES, VALID_ANSWER_TYPES, jsonExactMatch, taskGradingHash, _GRADING_SECRET_PATH, answerTypeHasKey, normaliseTextAnswer, gradeTextAnswer, canonicaliseTextAnswers };
