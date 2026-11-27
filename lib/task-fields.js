// Per-field byte caps for a challenge row — ONE table, two writers.
//
// v8.3.17 (external audit) — hoisted out of `routes/challenges.js`, which was
// enforcing them on the create/PUT path while `POST /api/admin/import/tasks`
// enforced NONE of them. Measured: a `title` the normal path caps at 300
// characters was stored by the importer at **1 000 000**.
//
// WHY THAT MATTERS BEYOND storage: the platform's own edit form applies these
// caps, so an over-long imported row is one an admin can OPEN and cannot SAVE —
// the "a control they cannot reach" failure with the sides swapped. It also
// reaches every admin list payload and the participant challenge view.
//
// The import CLAMPS rather than rejects, which is that handler's own idiom for a
// well-typed-but-unusable value: `author_name` already slices to 200 and
// `attempt_cap` already falls back to NULL, both within a dozen lines. It is
// also the correct side of the v7.21.1 (A10) line — a wrong-TYPED element means
// the FILE is broken and 400s, whereas one field being too long means the file
// is fine and one value needs trimming. A 500-row migration must not die on it.
//
// The clamp is COUNTED and returned to the operator: CLAUDE.md *Import rules*
// is explicit that a skip/drop counter with no human consumer is itself the
// defect, and `frozen_skipped` and `invalid_timezones_dropped` were both filed
// for exactly that.
//
// Anything importing this must NOT re-declare the table — a Docs-hygiene scanner
// forbids it (the `DIFF_PTS` / `FROZEN_REMEDY` / `compareTaskNumbers` pattern).
const TASK_FIELD_CAPS = {
  title:          300,
  correct_answer: 65536,
  explanation:    65536,
  description:    65536,
  hint:           2000,
  author_name:    200,
  author_linkedin:500,
};

/**
 * Clamp one field to its cap. Returns the value unchanged when it fits (so the
 * common path allocates nothing) and reports whether it had to cut.
 *
 * @returns {{value: string, truncated: boolean}}
 */
function clampTaskField(field, value) {
  const cap = TASK_FIELD_CAPS[field];
  if (typeof value !== "string" || !cap || value.length <= cap) {
    return { value, truncated: false };
  }
  return { value: value.slice(0, cap), truncated: true };
}

module.exports = { TASK_FIELD_CAPS, clampTaskField };
