"use strict";

// ── The three BUILT-IN event templates ───────────────────────────────────────
//
// One definition, read by the boot seed (db.js), "Reset to default" and
// "Restore built-in templates" (routes/competitions.js). Each carries a stable
// `key`, stored in `event_templates.builtin_key`, so a built-in is recognised by
// what it IS rather than by a name an administrator may have edited.
//
// They carry NO challenges, deliberately: picking challenges on the operator's
// behalf would be a choice nobody made. The settings name only what differs from
// the kind's own create defaults. Pure: no requires, so db.js may load it at
// require time.

const BUILTIN_TEMPLATES = Object.freeze([
  Object.freeze({
    key: "booth-quick-spin", name: "Booth quick-spin", kind: "booth",
    description: "A walk-up stand: visitors join by QR code or short code, confirm their email with a code and play for an hour on their phone; multiple-choice challenges use the tap layout. Add challenges after spawning.",
    settings: Object.freeze({ duration_minutes: 60, self_enroll_enabled: true }),
  }),
  Object.freeze({
    key: "tournament-2h", name: "Tournament (2 h)", kind: "tournament",
    description: "A ranked two-hour competition for invited or assigned participants. Add challenges, and sessions if needed, after spawning.",
    settings: Object.freeze({ duration_minutes: 120 }),
  }),
  Object.freeze({
    key: "program-30d", name: "Learning Program (30 days)", kind: "program",
    description: "A self-paced programme whose deadline is 30 days after its start; participants earn a completion certificate. Add challenges after spawning.",
    settings: Object.freeze({ duration_minutes: 43200 }),
  }),
]);

const BUILTIN_BY_KEY = new Map(BUILTIN_TEMPLATES.map(b => [b.key, b]));

/** The built-in definition for a key, or null. */
function builtinTemplate(key) {
  return (typeof key === "string" && BUILTIN_BY_KEY.get(key)) || null;
}

// How long a deleted (unprotected, non-built-in) template stays restorable.
const TEMPLATE_RESTORE_DAYS = 30;

module.exports = { BUILTIN_TEMPLATES, builtinTemplate, TEMPLATE_RESTORE_DAYS };
