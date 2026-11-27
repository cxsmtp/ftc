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
// the kind's own create defaults (a Booth Event's qualifying questions are the
// kind's create seed, `qualifyingQuestionsDefault`, ticked on both create doors).
// Pure: no requires, so db.js may load it at require time.

// Each is a kind's RECOMMENDED SETUP on the New event page: one card per event
// type offers it beside "Start blank". The keys are stable whatever the names
// say (the booth key still reads "quick-spin" from its first name).
//
// `previous` is the definition this one replaced, exactly as it was stored: the
// one-shot migration in db.js (marker `event_templates_renamed_at`) moves a
// stored built-in to the current definition only while the row still equals
// `previous` field for field, so an administrator's edit is never overwritten.
// The builtin_key backfill (marker `event_templates_builtin_key_at`) matches
// rows seeded before that column existed by these first names too.
const BUILTIN_TEMPLATES = Object.freeze([
  Object.freeze({
    key: "booth-quick-spin", name: "Booth day (8 hours)", kind: "booth",
    description: "A stand for a full conference day, where visitors join by QR code or a short code and play on their phones.",
    settings: Object.freeze({ duration_minutes: 480, self_enroll_enabled: true }),
    previous: Object.freeze({
      name: "Booth quick-spin",
      description: "A walk-up stand: visitors join by QR code or short code, confirm their email with a code and play for an hour on their phone; multiple-choice challenges use the tap layout. Add challenges after spawning.",
      settings: Object.freeze({ duration_minutes: 60, self_enroll_enabled: true }),
    }),
  }),
  Object.freeze({
    key: "tournament-2h", name: "Competition (several sessions)", kind: "tournament",
    description: "A ranked two-hour competition that you can run once or in several sessions.",
    settings: Object.freeze({ duration_minutes: 120 }),
    previous: Object.freeze({
      name: "Tournament (2 h)",
      description: "A ranked two-hour competition for invited or assigned participants. Add challenges, and sessions if needed, after spawning.",
      settings: Object.freeze({ duration_minutes: 120 }),
    }),
  }),
  Object.freeze({
    key: "program-30d", name: "Learning program (30 days)", kind: "program",
    description: "A self-paced program open for 30 days, where everyone who finishes every challenge earns a completion certificate.",
    settings: Object.freeze({ duration_minutes: 43200 }),
    previous: Object.freeze({
      name: "Learning Program (30 days)",
      description: "A self-paced programme whose deadline is 30 days after its start; participants earn a completion certificate. Add challenges after spawning.",
      settings: Object.freeze({ duration_minutes: 43200 }),
    }),
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
