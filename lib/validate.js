"use strict";

// Declarative request-body validation — the boundary layer (ext-audit batch 7).
//
// WHY: batches 1-6 were all the same family — a malformed/under-validated
// req.body field (a non-string reaching `.trim()` → 500; a numeric date stored
// raw → corrupt → 500 on read; a whitespace-only name stored blank; create-vs-
// edit validation drift). Each handler hand-rolled a partial subset of the
// checks, the subsets drifted, and the regex lock could only model the SHAPES it
// had seen. This layer makes the class impossible BY CONSTRUCTION for migrated
// routes: one declarative schema per entity, validated + NORMALIZED at the top of
// the handler, so the handler body never touches a raw, untyped req.body value.
//
// `validateBody(body, schema)` returns either:
//   { error: "<message>", field: "<name>" }   ← caller does `res.status(400).json({ error })`
//   { values: { ...normalized } }              ← trimmed strings, parsed ints, ISO dates
//
// Fields NOT in the schema are ignored (so a handler can still read other
// req.body fields during/after a partial migration). Absent optional fields are
// simply omitted from `values` (so a PUT handler's COALESCE logic — "undefined ⇒
// leave column unchanged" — keeps working).
//
// rule = {
//   type: "string" | "int" | "bool" | "date" | "enum" | "stringArray",
//   required?: boolean,     // POST: must be present. (PUT schemas omit it → optional.)
//   allowEmpty?: boolean,   // string: permit "" (after trim) — e.g. a clearable field. Default: non-empty when present.
//                           // date: permit "" and normalise it to null — "the caller said NONE",
//                           // which is distinct from an absent key ("the caller said nothing").
//   min?, max?: number,     // string ⇒ trimmed length; int ⇒ numeric range (inclusive).
//   values?: string[],      // enum: the allowed set.
//   itemMax?: number,       // stringArray: per-element max length.
//   label?: string,         // human field name for the error (defaults to the key).
// }
//
// Normalization on success: string → trimmed; date → new Date(x).toISOString();
// int → a STRICT whole number (Number.isInteger, or /^-?\d+$/ string — never a
// truncated parseInt, ext-audit F3); enum → the value unchanged; bool → a REAL
// boolean coerced from true/false/1/0/"true"/"false"/"1"/"0"/"yes"/"no" (the
// handler does `? 1 : 0` — so the string "false" can no longer enable a flag,
// ext-audit F2); stringArray → array of trimmed non-empty strings (a non-string
// element is an ERROR, not a silent skip).

function _label(field, rule) { return rule.label || field; }

function _checkString(field, rule, v, values) {
  if (typeof v !== "string") return { error: `${_label(field, rule)} must be text`, field };
  const t = v.trim();
  if (!t && !rule.allowEmpty) return { error: `${_label(field, rule)} must be non-empty text`, field };
  if (rule.max != null && t.length > rule.max) return { error: `${_label(field, rule)} must be at most ${rule.max} characters`, field };
  if (rule.min != null && t.length < rule.min) return { error: `${_label(field, rule)} must be at least ${rule.min} characters`, field };
  values[field] = t;
  return null;
}

function _checkInt(field, rule, v, values) {
  // Strict whole-number parse (ext-audit F3). parseInt is LENIENT: it truncates
  // "10abc"->10, "1.9"->1, "1e2"->1, numeric 1.9->1, and coerces "0x10"->0 at
  // radix 10 — all silently. We require a GENUINE integer: a number that
  // Number.isInteger, or a string that FULLY matches /^-?\d+$/ after trim.
  // Anything else is rejected (not truncated). Range checks apply AFTER the parse.
  let n;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) return { error: `${_label(field, rule)} must be a whole number`, field };
    n = v;
  } else if (typeof v === "string" && /^-?\d+$/.test(v.trim())) {
    n = parseInt(v.trim(), 10);
  } else {
    return { error: `${_label(field, rule)} must be a whole number`, field };
  }
  if (!Number.isFinite(n)) return { error: `${_label(field, rule)} must be a number`, field };
  if (rule.min != null && n < rule.min) return { error: `${_label(field, rule)} must be at least ${rule.min}`, field };
  if (rule.max != null && n > rule.max) return { error: `${_label(field, rule)} must be at most ${rule.max}`, field };
  values[field] = n;
  return null;
}

// Real boolean coercion (ext-audit F2). The old "bool" rule was pass-through, so
// the JSON STRING "false" (truthy in JS) reached a handler's `X ? 1 : 0` and
// ENABLED a security-sensitive flag (reveal answers, self-enroll, instant-join).
// Accept actual booleans, 0/1, and the canonical string forms; store a real
// boolean (the handler does `? 1 : 0`). Reject anything ambiguous.
const _BOOL_TRUE = new Set(["true", "1", "yes", "on"]);
const _BOOL_FALSE = new Set(["false", "0", "no", "off"]);
function _checkBool(field, rule, v, values) {
  if (typeof v === "boolean") { values[field] = v; return null; }
  if (typeof v === "number" && (v === 0 || v === 1)) { values[field] = v === 1; return null; }
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (_BOOL_TRUE.has(t)) { values[field] = true; return null; }
    if (_BOOL_FALSE.has(t)) { values[field] = false; return null; }
  }
  return { error: `${_label(field, rule)} must be true or false`, field };
}

function _checkDate(field, rule, v, values) {
  // Must be a date STRING. A number like 1 is a "valid" Date (epoch+1ms) but is
  // NOT valid input — requiring a string rejects it. Stored value is normalized
  // ISO so a non-ISO string can never land in the DB and 500 the next read.
  if (typeof v !== "string") return { error: `${_label(field, rule)} must be a valid date`, field };
  // v8.6.0 — `allowEmpty` makes CLEARING the field expressible, which a nullable
  // date column needs and `deadline_at` (the only other date field, and never
  // nullable in practice) never did.
  //
  // The distinction it buys is the one this layer exists to keep: `undefined` is
  // "the caller said nothing" and reaches the handler's COALESCE untouched, while
  // `""` is "the caller said none" and arrives as an explicit `null`. Without it a
  // column whose NULL means something — `late_entry_deadline_at`, where NULL means
  // "follow the event's end" — could be set and never unset. Absent by default, so
  // every existing date field behaves exactly as before.
  const t = v.trim();
  if (!t) {
    if (!rule.allowEmpty) return { error: `${_label(field, rule)} must be a valid date`, field };
    values[field] = null;
    return null;
  }
  const d = new Date(t);
  if (isNaN(d.getTime())) return { error: `${_label(field, rule)} must be a valid date`, field };
  values[field] = d.toISOString();
  return null;
}

function _checkEnum(field, rule, v, values) {
  if (typeof v !== "string" || !(rule.values || []).includes(v))
    return { error: `${_label(field, rule)} must be one of: ${(rule.values || []).join(", ")}`, field };
  values[field] = v;
  return null;
}

function _checkStringArray(field, rule, v, values) {
  if (!Array.isArray(v)) return { error: `${_label(field, rule)} must be an array`, field };
  const out = [];
  for (const el of v) {
    if (typeof el !== "string") return { error: `${_label(field, rule)} must be an array of text`, field };
    const t = el.trim();
    if (rule.itemMax != null && t.length > rule.itemMax) return { error: `Each ${_label(field, rule)} entry must be at most ${rule.itemMax} characters`, field };
    if (t) out.push(t);
  }
  values[field] = out;
  return null;
}

// v8.4.0 — an object whose KEYS come from a closed set and whose VALUES come
// from a closed enum. The one shape this layer could not express, and the reason
// it has to be here rather than in the handler: the Booth Event sign-up matrix is
// six field names against three states, and a handler-local check would be the
// only request field on the competition surface not policed by the boundary.
//
// STRICT ON THE KEYS, deliberately unlike `parseRegistrationFieldPolicy`, which
// is tolerant. The two are not in tension — they answer different questions. A
// STORED blob may have been written by a newer image, so reading one has to
// degrade rather than fail; a REQUEST is a caller telling us something now, and
// silently dropping a key it sent is how a control comes to appear to work. An
// unknown field name or state is therefore a named 400.
//
// Absent keys are ALLOWED and simply not returned, so a caller may send a partial
// map; the reader fills the rest from the kind's defaults. That is what lets the
// admin form send only the fields its own kind renders.
function _checkEnumMap(field, rule, v, values) {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return { error: `${_label(field, rule)} must be an object`, field };
  }
  const keys = rule.keys || [];
  const allowed = rule.values || [];
  const out = {};
  for (const [k, raw] of Object.entries(v)) {
    if (!keys.includes(k)) {
      return { error: `${_label(field, rule)} has an unknown entry: ${k}`, field };
    }
    if (typeof raw !== "string" || !allowed.includes(raw)) {
      return { error: `${_label(field, rule)} entry "${k}" must be one of: ${allowed.join(", ")}`, field };
    }
    out[k] = raw;
  }
  values[field] = out;
  return null;
}

function validateBody(body, schema) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { error: "Request body must be an object", field: null };
  const values = {};
  for (const [field, rule] of Object.entries(schema)) {
    const raw = body[field];
    if (raw === undefined || raw === null) {
      if (rule.required) return { error: `${_label(field, rule)} is required`, field };
      continue; // optional + absent → omit from values (PUT COALESCE-friendly)
    }
    let res;
    switch (rule.type) {
      case "string":      res = _checkString(field, rule, raw, values); break;
      case "int":         res = _checkInt(field, rule, raw, values); break;
      case "date":        res = _checkDate(field, rule, raw, values); break;
      case "enum":        res = _checkEnum(field, rule, raw, values); break;
      case "stringArray": res = _checkStringArray(field, rule, raw, values); break;
      case "bool":        res = _checkBool(field, rule, raw, values); break; // coerces -> real boolean (handler does ? 1 : 0)
      case "enumMap":     res = _checkEnumMap(field, rule, raw, values); break;
      default:            res = { error: `Unknown rule type for ${field}`, field };
    }
    if (res) return res;
  }
  return { values };
}

// Derive a PUT (edit) schema from a create schema: every field becomes optional
// (drops `required`), keeping all other constraints. Guarantees create/edit can
// never drift in type/range/format — the parity class that caused batch 4.
function allOptional(schema) {
  const out = {};
  for (const [k, rule] of Object.entries(schema)) {
    const { required, ...rest } = rule;
    out[k] = rest;
  }
  return out;
}

// v8.13.3 — the QUERY-string boundary. A query value is a string or absent.
// Express 5's default 'simple' parser turns a REPEATED key (?a=1&a=2, and also
// ?a=1&a=) into a string[]; better-sqlite3 spreads an array into positional binds
// (RangeError "Too many parameter values" → a generic 500), and includes() /
// String() on one silently changes the answer (an export scoped to nothing, an
// analytics window read as "a,b"). Refuse, never coerce — and note Express 5
// re-parses req.query on EVERY access, so a middleware cannot "fix up" req.query.
// Never a nested object either: the 'simple' parser does not build one, so
// `typeof v === "string"` is a complete test.
function firstNonScalarQueryParam(query) {
  if (!query || typeof query !== "object") return null;
  for (const k of Object.keys(query)) {
    const v = query[k];
    if (v !== undefined && typeof v !== "string") return k;
  }
  return null;
}

const QUERY_REPEATED_ERROR = "A query parameter was given more than once. Send each one once.";

// Express middleware form. 400 with a code the client can branch on, naming the
// parameter so a caller can see which one it duplicated.
function refuseRepeatedQuery(req, res, next) {
  const bad = firstNonScalarQueryParam(req.query);
  // `!== null`, not truthiness: an EMPTY key (`?=a&=b`) is still a repeated
  // parameter, and "" is falsy.
  if (bad !== null) return res.status(400).json({ error: QUERY_REPEATED_ERROR, code: "query_param_repeated", param: bad });
  next();
}

module.exports = { validateBody, allOptional, firstNonScalarQueryParam, refuseRepeatedQuery };
