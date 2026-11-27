"use strict";

// v8.4.0 — WHICH FIELDS THE SIGN-UP FORM ASKS FOR, AND WHICH OF THEM IT DEMANDS.
//
// One module owns the whole question, for the reason lib/event-policy.js exists:
// the alternative is a rule re-derived at each of the surfaces that decide it
// (the sign-up form and its server-side validator, the profile-completion gate,
// and the admin forms that configure it), correct at all of them on the day it
// is written and silently divergent afterwards.
//
// THE SHAPE IS ONE ENUM PER FIELD, NOT TWO BOOLEANS, and that is deliberate.
// The operator asked for two controls per field — "is it optional?" and "if so,
// is it shown at all?" — which is a 2x2 with one unreachable corner: a MANDATORY
// field that is not shown cannot be filled in, so the account can never be
// completed. Storing two booleans makes that corner representable, which means
// every reader has to re-decide what to do about it. Storing the three reachable
// states makes it unrepresentable:
//
//   "required"  — shown, marked with its `*`, refused when blank.
//   "optional"  — shown WITHOUT a required marker, stored when given, never
//                 demanded afterwards.
//   "hidden"    — not rendered at all, and never demanded afterwards.
//
// The admin form renders one three-way control per field (Required · Optional
// · Off), mapped 1:1 onto this enum, so "required" forces "shown" by
// construction rather than by a validation rule somebody has to remember.
//
// STATE VALUES ARE OPAQUE, exactly as the event kinds are: nothing derives
// "required" from the label "Required", so renaming what an admin reads is a
// copy change here rather than a migration over every stored row and audit blob.

// ── The configurable fields ────────────────────────────────────────────────────
//
// FIVE, and the set is closed on purpose. `secondary_email` is deliberately NOT
// among them (the operator's exclusion): it is the escape hatch that makes the
// corporate-email rule satisfiable when a visitor's primary address is a personal
// one, so an event that hid it could refuse a walk-up with no way for them to
// comply. Every other currently-optional registrant attribute is here.
const REGISTRATION_FIELDS = Object.freeze([
  Object.freeze({ key: "personal_title", label: "Salutation",           profileColumn: "personal_title" }),
  // (`password` was a field here until the sign-up form stopped asking for one:
  // a password is set after sign-up (Profile → How you sign in, or the "Set your
  // password" prompt at sign-in), never on the sign-up form. A stored policy
  // JSON that still names it is read without it — parseRegistrationFieldPolicy
  // only reads known keys — and the key is dropped on the next save.)
  Object.freeze({ key: "phone",          label: "Phone",                profileColumn: "phone" }),
  Object.freeze({ key: "city",           label: "City",                 profileColumn: "city" }),
  Object.freeze({ key: "linkedin_url",   label: "LinkedIn Profile URL", profileColumn: "linkedin_url" }),
  Object.freeze({ key: "job_function",   label: "Job function",         profileColumn: "job_function" }),
]);

const REGISTRATION_FIELD_KEYS = Object.freeze(REGISTRATION_FIELDS.map(f => f.key));
const FIELD_STATES = Object.freeze(["required", "optional", "hidden"]);

// The configurable fields EVERY account is asked whatever the event says. None
// since the sign-up form became the short form (operator order, 29 Oct 2026;
// confirmed by operator ruling, 14 Nov 2026): the base set is first name, last
// name, company and job title (plus the detected country and timezone), and
// every field here is asked only when an event requires it.
const BASE_REQUIRED_FIELDS = Object.freeze(new Set([]));

// ── The per-kind defaults ─────────────────────────────────────────────────────
//
// THE SHORT FORM (operator order, 29 Oct 2026; confirmed by operator ruling,
// 14 Nov 2026): City and Job function shown but optional, Salutation, Phone and
// LinkedIn URL off. Every kind starts from it and its creator may change it. The
// change only SHRINKS what existing accounts are asked (a field that was required
// becomes optional), never the reverse.
const LEGACY_STATES = Object.freeze({
  personal_title: "hidden",
  phone: "hidden",
  city: "optional",
  linkedin_url: "hidden",
  job_function: "optional",
});

// A BOOTH EVENT'S DEFAULT IS THE SHORT FORM, the same states as every other kind
// (operator order, 29 Oct 2026; confirmed by operator ruling, 14 Nov 2026).
const BOOTH_DEFAULT_STATES = LEGACY_STATES;

// Keyed on the OPAQUE kind values, and a lock asserts this map's keys are exactly
// EVENT_KINDS' — a second list of kinds is a mirror, so it is diffed rather than
// trusted. Every kind starts from the short form.
const KIND_DEFAULT_STATES = Object.freeze({
  booth: BOOTH_DEFAULT_STATES,
  tournament: LEGACY_STATES,
  program: LEGACY_STATES,
});

// Which kinds honour a stored configuration. EVERY kind (operator ruling,
// 30 Oct 2026: the creator of any event chooses its sign-up fields). Derived from
// the defaults map rather than listed, so a kind added there is configurable by
// construction. A NULL column still resolves to the kind's defaults (the short
// form), so no existing event or account is asked anything new (the gate may
// only shrink).
const CONFIGURABLE_KINDS = Object.freeze(new Set(Object.keys(KIND_DEFAULT_STATES)));

// ── Parsing a stored value ────────────────────────────────────────────────────

/**
 * Normalise a stored `competitions.registration_field_policy` blob against a set
 * of defaults.
 *
 * TOLERANT ON THE VALUE, exactly as `eventKind` is: malformed JSON, a
 * non-object, an unknown field key or an unrecognised state all mean the row was
 * written by a newer image or hand-edited, so the default is used and the
 * platform keeps serving. There is no shape here a caller could get wrong that
 * should take an event's sign-up form offline.
 *
 * It fails to the KIND'S DEFAULT rather than to "nothing is required", and the
 * distinction is worth stating: a blob this build cannot read yields the answer
 * an unconfigured event of that kind gives (the short form, for every kind
 * today). What it can never do is invent a requirement an
 * organiser did not set, so an unreadable value cannot strand an account behind
 * the non-dismissible gate asking for something nobody ever collected.
 */
function parseRegistrationFieldPolicy(stored, defaults) {
  const base = defaults || LEGACY_STATES;
  let parsed = null;
  if (typeof stored === "string" && stored.trim()) {
    try { parsed = JSON.parse(stored); } catch (_) { parsed = null; }
  } else if (stored && typeof stored === "object") {
    parsed = stored;
  }
  const out = {};
  for (const key of REGISTRATION_FIELD_KEYS) {
    const v = (parsed && !Array.isArray(parsed) && typeof parsed === "object") ? parsed[key] : undefined;
    out[key] = (typeof v === "string" && FIELD_STATES.includes(v)) ? v : base[key];
  }
  return Object.freeze(out);
}

/**
 * The canonical stored form. Sorted by the field order above so the audit ladder
 * diffs a stable string rather than whatever key order a client happened to send,
 * and so an identical configuration re-saved is not recorded as a change.
 *
 * Returns null when the states equal the defaults, which keeps "the admin has not
 * configured this" as an ABSENT value rather than a blob that happens to match —
 * so the defaults can move in a later release without every previously-saved
 * event being pinned to today's.
 */
function serialiseRegistrationFieldPolicy(states, defaults) {
  const base = defaults || LEGACY_STATES;
  const norm = parseRegistrationFieldPolicy(states, base);
  let differs = false;
  for (const key of REGISTRATION_FIELD_KEYS) if (norm[key] !== base[key]) { differs = true; break; }
  if (!differs) return null;
  const ordered = {};
  for (const key of REGISTRATION_FIELD_KEYS) ordered[key] = norm[key];
  return JSON.stringify(ordered);
}

// ── Resolving one event's answer ──────────────────────────────────────────────

// Lazy require: lib/event-policy.js is a dependency-free leaf and this module is
// reached from lib/util.js, so keeping the edge inside the function keeps it out
// of module load order (the `_profileMissingFields` precedent).
function _kindOf(row) {
  const { eventKind } = require("./event-policy");
  return eventKind(row);
}

/**
 * The three-state answer for one competition, for every configurable field.
 *
 * Takes a ROW so both inputs — the kind and the stored column — come from the
 * same object; a caller holding a partial SELECT gets `eventKind`'s explicit
 * throw rather than a silent answer derived from a default kind.
 *
 * STRICT ON A MISSING COLUMN, for the reason `_profileMissingFields` is strict
 * about `profile_policy`: several competition SELECTs are hand-written column
 * lists, and one that omits `registration_field_policy` would silently serve the
 * kind's defaults for an event an admin has configured — which on a Booth Event
 * whose admin made a field mandatory means the field stops being demanded, and
 * on one who relaxed a field means it starts being demanded of walk-ups who were
 * told it was optional. Both are invisible from every screen.
 */
function registrationFieldStates(comp) {
  const kind = _kindOf(comp);
  const defaults = KIND_DEFAULT_STATES[kind] || LEGACY_STATES;
  if (!CONFIGURABLE_KINDS.has(kind)) return defaults;
  if (comp && typeof comp === "object" && !("registration_field_policy" in comp)) {
    throw new Error("registrationFieldStates: the competition row has no registration_field_policy column — the SELECT that produced it is missing the column");
  }
  return parseRegistrationFieldPolicy(comp ? comp.registration_field_policy : null, defaults);
}

/** The default states for a KIND, with no row — what the create wizard renders. */
function registrationFieldDefaultsForKind(kind) {
  return KIND_DEFAULT_STATES[kind] || LEGACY_STATES;
}

// ── The derived sets ──────────────────────────────────────────────────────────

/**
 * Turn the state map into three sets: `relaxed` (hidden), `optional` (shown,
 * never demanded) and `required`. The two not-demanded sets are DISJOINT by
 * construction. `required` is the ADDITIONS only: a field that is required and
 * already in the base set needs no entry, because the gate demands it anyway, so
 * a caller need not know which fields the base set holds.
 *
 * Only tests/event-policy.spec.js calls it: the wire carries the states
 * themselves (`registration_fields`, lib/event-policy.js), and
 * `_profileMissingFields` (lib/util.js) reads them through
 * `registrationFieldStates`.
 */
function deriveProfileSets(states) {
  const relaxed = [];
  const optional = [];
  const required = [];
  for (const f of REGISTRATION_FIELDS) {
    if (!f.profileColumn) continue;
    const st = states[f.key];
    if (st === "hidden") relaxed.push(f.key);
    else if (st === "optional") optional.push(f.key);
    else if (!BASE_REQUIRED_FIELDS.has(f.key)) required.push(f.key);
  }
  return { relaxed, optional, required };
}

module.exports = {
  REGISTRATION_FIELDS, REGISTRATION_FIELD_KEYS, FIELD_STATES,
  LEGACY_STATES, BOOTH_DEFAULT_STATES,
  KIND_DEFAULT_STATES, CONFIGURABLE_KINDS,
  parseRegistrationFieldPolicy, serialiseRegistrationFieldPolicy,
  registrationFieldStates, registrationFieldDefaultsForKind,
  deriveProfileSets,
};
