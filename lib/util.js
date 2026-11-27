"use strict";

// Small, dependency-free cross-cutting helpers shared across the codebase:
// email normalisation, URL validation, and base64url encode/decode. Pure
// functions (only Node globals + `net` for IP-shape checks) — safe for any
// module to import without creating a require cycle. (v7.0.0 refactor:
// extracted from server.js.)
const net = require("net");
const { swallowed } = require("./best-effort");
const { zoneFormatter } = require("./time");

// NFC-normalise + lowercase an email so encoding variants (NFC / NFD) of the
// same visual address compare equal against the normalised form stored at
// write time. Applied at every write AND comparison site. Non-strings pass
// through unchanged (callers guard their own types).
/**
 * The bucket key a rateLimit() limiter charges: `<prefix>:<ip>`, narrowed by
 * `keyExtra(req)` when it gives a non-empty string or a finite number (a
 * session's user id). NEVER throws, by construction: the key is built inside
 * the try, and an identity of any other type (an object from a crafted body,
 * whose toString may not be callable, or an array) shares ONE fixed per-IP
 * bucket, `~malformed`, rather than reaching a template literal (sweep #193).
 */
function rateBucketKey(prefix, ip, keyExtra, req) {
  const base = `${prefix}:${ip}`;
  if (!keyExtra) return base;
  try {
    const v = keyExtra(req);
    if (v === "" || v == null || v === false) return base;
    if (typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) return `${base}:${v}`;
    return `${base}:~malformed`;
  } catch (_) { return base; }
}

function normaliseEmail(addr) {
  if (typeof addr !== "string") return addr;
  return addr.trim().normalize("NFC").toLowerCase();
}

// Returns the URL unchanged if it parses as http(s); "" otherwise. Used to
// gate user-supplied URLs (LinkedIn profile, base-url style inputs) before
// they reach a response or an <a href>.
function validateUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return url;
  } catch { return ""; }
}

// ext-audit v7.15.16 — ONE path normaliser for every gate that matches a request
// path against a fixed set or pattern.
//
// Two gates were bypassable by a path variant that still routes:
//   • `/docs//user-guide/superadmin.md` — the docs gate tested the raw path while
//     `express.static` normalised the doubled slash away, so the superadmin guide
//     (which names the built-in account and its on-disk password path) was
//     readable ANONYMOUSLY.
//   • `POST /api/login/` — the exact-Set lookup that selects the 16 KB auth body
//     parser missed the trailing slash, so a 1 MiB body reached the 5 MB parser.
//
// lib/impersonation.js had already worked this out for its own gate and even
// documented it — but the reasoning was recorded as a comment rather than as a
// shared function, so neither of the gates above inherited it. That is the whole
// lesson: normalisation belongs in one callable place.
//
// **DECODES first**, then collapses runs of slashes, strips a trailing slash
// (never the bare root), and lowercases.
//
// v7.15.17 — the decode is the part v7.15.16 missed, and it was a live hole:
// `/docs/user-guide/%73uperadmin.md` and `/docs/user-guide%2Fsuperadmin.md`
// both served the gated superadmin guide ANONYMOUSLY, because `send`/
// `serve-static` percent-decode the path *after* the gate has already decided
// on the raw one. A gate must normalise the way its downstream consumer does,
// or the two disagree and the gap between them IS the bypass.
//
// Decoding ONCE matches serve-static exactly: it decodes once too, so a
// double-encoded `%2573` stays literal for both of us and simply 404s on disk.
// A malformed sequence throws here and 400s there, so neither serves a file.
//
// Over-normalising is the SAFE direction for every caller: it makes a gate
// match MORE paths, never fewer.
function normaliseRoutePath(p) {
  let s = String(p || "");
  try { s = decodeURIComponent(s); }
  catch (e) { /* malformed escape — serve-static 400s on it; leave it raw */ swallowed("util:route-path-decode", e); }
  s = s.replace(/\/{2,}/g, "/").toLowerCase();
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s || "/";
}


// base64url (RFC 4648 §5): standard base64 with +/ → -_ and no padding.
// Shared by the unsubscribe HMAC token and the self-enroll token mint.
function _b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function _b64urlDecode(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

// ── Email-shape predicates (pure; no db) ─────────────────────────────────────
const FREE_EMAIL_PROVIDERS = ["gmail.com","googlemail.com","hotmail.com","outlook.com","live.com","msn.com","yahoo.com","yahoo.co.uk","ymail.com","aol.com","protonmail.com","proton.me","icloud.com","me.com","mac.com","mail.com","zoho.com","yandex.com","gmx.com","gmx.net","tutanota.com","tuta.com","fastmail.com"];

function isFreeEmail(email) {
  return FREE_EMAIL_PROVIDERS.includes((email.split("@")[1] || "").toLowerCase());
}

// Pragmatic email-format check applied at every account-flow entry point
// (registration, self profile edit, admin profile edit, participant import).
// Without this, isFreeEmail() — a domain denylist — happily accepts
// "not-an-email" as non-free and stores it as a primary address. Those
// strings later become recipient lists for verification / approval /
// reset / reminder mail and silently break delivery.
//
// The pattern requires a single canonical addr-spec — local@domain.tld with no
// whitespace and no second "@". Not RFC-perfect (RFC 5322 is impractical and
// would over-reject real addresses); the goal is to reject obvious garbage and
// let the SMTP layer be the final arbiter for borderline cases. The SAME regex
// literal is shipped client-side in public/js/features/auth.js (kept in sync by
// a CI test) so the dialog and the server agree.
//
// ext-audit v7.15.6 — the old `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` accepted MAILBOX
// syntax: `Alias<audit-bypass@gmail.com>` has exactly one "@" and no whitespace,
// so it matched, and the printable-ASCII guard below does not help because "<"
// and ">" are 0x3C/0x3E. That defeated two business rules at once, because both
// read the domain by splitting on "@":
//   • isFreeEmail() saw the domain as "gmail.com>", which is not in the
//     provider list, so a free-mail address sailed through the corporate-email
//     requirement (the auditor got HTTP 200 from a real registration); and
//   • the NOCASE uniqueness indexes saw a distinct string, so many stored
//     identities could target ONE real mailbox once an MTA parsed them back.
// So the domain side is now an explicit label grammar (alphanumeric labels,
// internal hyphens, ≥2 labels) — that alone kills the bypass — and the local
// side additionally bans the display-name/group punctuation `<>,;:"()[]\` that
// lets one string carry a second address. Ordinary local-part symbols
// (+ . - _ ' ! # $ % & * / = ? ^ ` { | } ~) are deliberately still accepted.
const _EMAIL_RE = /^[^\s@<>,;:"()\[\]\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
function isValidEmailFormat(email) {
  if (typeof email !== "string") return false;
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  // ext-audit (F1) — restrict emails to PRINTABLE ASCII, exactly like nicknames
  // (_nicknameCharsOk below). The users email UNIQUE indexes
  // (uq_users_email_nocase / uq_users_secondary_email_nocase) use SQLite COLLATE
  // NOCASE, which case-folds ASCII ONLY — so a non-ASCII address (case@(long-s).com
  // vs case@s.com, or Äbc@x vs äbc@x) would BYPASS the case-insensitive uniqueness
  // invariant. NFC-normalising at intake (normaliseEmail) collapses encoding
  // variants but NOT case variants of non-ASCII letters, so ASCII-only is the
  // complete guarantee. This single gate covers every write path that calls it
  // (register, PUT /api/me, admin edit, import, LinkedIn self-signup — both
  // primary and secondary email). Kept in sync with the client (public/js).
  if (!/^[\x20-\x7E]+$/.test(trimmed)) return false;
  return _EMAIL_RE.test(trimmed);
}

// ── No password yet (pure) ───────────────────────────────────────────────────
// A new account has no password: every create path stores this fixed placeholder
// (one shape for "no password" on every row), and PUT /api/me/sign-in-method replaces it
// with a real hash when the person sets one. It is not a bcrypt string (no cost
// on any write path, so a new and an existing registration take the same time)
// and `hasUsablePassword` (lib/login-method.js) never accepts it. Existing rows
// keep whatever hash they held: one with `password_set_at` stamped is a usable
// password, which the password door accepts only while the account's sign-in
// method is `password` (stored, or its role's default; lib/login-method.js).
const NO_PASSWORD_HASH = "!no-password";

// Reject saving an account where primary email and secondary email resolve
// to the same identity (case-insensitive). Without this, getUserEmails
// would mail the same address twice and `emailIsTaken(secondary, user.id)`
// — which excludes the SAME user — would silently allow it. Used at every
// write site: registration, self-edit, admin-edit, import-rename.
function sameSlotEmails(primary, secondary) {
  if (!primary || !secondary) return false;
  return normaliseEmail(primary) === normaliseEmail(secondary);
}

// ── Profile-field length caps + completeness gate (pure) ─────────────────────
const USER_FIELD_CAPS = {
  first_name:      80,
  last_name:       80,
  nickname:        40,
  company:         120,
  title:           150,
  personal_title:  20,
  phone:           32,
  job_function:    120,
  city:            120,
  // ext-audit A7 (v7.21.1) — `country` was absent from this table while being
  // a REQUIRED registration field, so it was the one mandatory profile string
  // with no upper bound at all: a megabyte of text sailed past _capsOk into the
  // users row and from there into every admin list, export and CSV. 80 matches
  // first_name/last_name; the real vocabulary is a 2-letter ISO-3166 code.
  // (`timezone` deliberately has no entry — it is bounded by isValidTimezone(),
  // which is a stronger check than a length cap.)
  country:         80,
  secondary_email: 254,
  linkedin_url:    500,
};
function _capsOk(fields) {
  for (const [k, max] of Object.entries(USER_FIELD_CAPS)) {
    const v = fields[k];
    if (v != null && typeof v === "string" && v.length > max) {
      return { field: k, max };
    }
  }
  return null;
}

// ext-audit batch 4 — returns the first field name in `fields` that is PRESENT
// in `obj` but is not a string (and not null/undefined), else null. Used to 400
// a malformed body before a later `.trim()` (or SQL bind) would 500 on a
// non-string (`["x"].trim` is undefined → TypeError; `{}.trim` likewise). The
// auditor found this 500 class on the comp/session edit name fields; the same
// `.trim()`-without-typeof pattern recurs across the profile + settings writes.
function _firstNonStringField(obj, fields) {
  if (!obj || typeof obj !== "object") return null;
  for (const f of fields) {
    const v = obj[f];
    if (v !== undefined && v !== null && typeof v !== "string") return f;
  }
  return null;
}

// v7.2.x (ext-audit F1) — nicknames are restricted to PRINTABLE ASCII
// (U+0020..U+007E). The nickname-uniqueness index `uq_users_nickname_nocase`
// uses SQLite `COLLATE NOCASE`, which case-folds ASCII only — so if non-ASCII
// nicknames were allowed, case variants it can't fold (e.g. "Äbc" vs "äbc")
// could both register. Constraining the charset to ASCII makes that index a
// COMPLETE case-insensitive uniqueness guarantee (no migration / canonical
// column needed). First/last NAME fields stay Unicode; the nickname is only a
// leaderboard handle. Also excludes control chars (log-injection / display
// hygiene). The auto-generator `generateNickname` already strips to [a-z0-9_].
const _NICKNAME_RE = /^[\x20-\x7E]+$/;
function _nicknameCharsOk(nickname) {
  return typeof nickname === "string" && _NICKNAME_RE.test(nickname);
}
const NICKNAME_CHARSET_ERROR = "Nickname may only contain standard (ASCII) letters, numbers, and symbols — no accented or non-Latin characters.";

// SINGLE-LINE PROFILE TEXT carries no control character: C0 (U+0000-U+001F),
// DEL (U+007F) or C1 (U+0080-U+009F). Names, company, title and the like reach
// mail headers and bodies, CSV exports, certificates and logs as stored, where a
// line break or an escape sequence splits a header, forges a log line or draws
// nothing. Letters of every script stay legal (Müller, 张伟, محمد). The one
// predicate for every write door of every field in PROFILE_TEXT_FIELDS; stored
// values are not rewritten.
const _PROFILE_TEXT_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;
const PROFILE_TEXT_FIELDS = Object.freeze(["first_name", "last_name", "certificate_given_name", "certificate_family_name",
  "company", "title", "city", "country", "job_function", "personal_title", "phone"]);
// Each field's name in words, so a refusal says WHICH field holds a character
// the person cannot see (the forms show only the message).
const PROFILE_TEXT_LABELS = Object.freeze({
  first_name: "First name", last_name: "Last name",
  certificate_given_name: "Certificate given name", certificate_family_name: "Certificate family name",
  company: "Company", title: "Job title", city: "City", country: "Country",
  job_function: "Job function", personal_title: "Salutation", phone: "Phone",
});
function profileTextControlError(field) {
  return `${PROFILE_TEXT_LABELS[field] || field} cannot contain control characters (line breaks, tabs or other invisible codes).`;
}
function profileTextOk(v) {
  return typeof v !== "string" || !_PROFILE_TEXT_CONTROL_RE.test(v);
}
// The first field of `PROFILE_TEXT_FIELDS` in `body` holding a control
// character, or null. Non-strings are the type guards' business, not this one's.
function profileTextControlField(body) {
  if (!body || typeof body !== "object") return null;
  for (const f of PROFILE_TEXT_FIELDS) if (!profileTextOk(body[f])) return f;
  return null;
}
// The one 400 body a door answers with.
function profileTextControlBody(field) {
  return { error: profileTextControlError(field), code: "profile_text_control_chars", field };
}

// v7.4.0 — transliterate a name to a lowercase [a-z0-9] ASCII slug. Used to
// derive nickname suggestions (client + `generateNickname`) so an accented or
// non-ASCII name (José, Müller, Łukasz) maps to a sensible ASCII analogue
// (jose, muller, lukasz) instead of being stripped to gibberish. NFKD decomposes
// the accented forms; the leading map covers letters that do NOT decompose
// (ß, ø, ł, …). Anything still non-[a-z0-9] (Cyrillic/Greek/CJK, punctuation,
// spaces) is dropped — the caller falls back to a generic base if the result is
// empty. The client carries an identical copy (public/js/features/auth.js).
// THE STROKED AND LIGATURE LETTERS, which NFKD cannot reach.
//
// NFKD decomposes a letter into base + combining mark, so stripping marks folds
// é->e and ü->u for free. It does NOTHING for a letter whose glyph is a stroke
// through the base rather than a mark beside it: ø, ł, đ, þ, ð, ħ, ŧ, ĸ, ı have
// no canonical decomposition at all, and the ligatures æ/œ/ß decompose to
// themselves. Those are exactly the ones this table names.
//
// v8.8.14 — TWO CONSUMERS NOW, with deliberately different tails. Nickname
// generation (`_transliterateAscii` below) finishes by stripping to [a-z0-9],
// because a nickname must be ASCII by platform rule. `credentialNameKey`
// (lib/badge.js) applies this same table and then keeps every Unicode letter,
// because a Greek or Cyrillic surname must still fold to ITSELF rather than to
// nothing. Share the TABLE, never the function: routing the credential fold
// through `_transliterateAscii` would fold every non-Latin name to the empty
// string and make those certificates match nothing at all.
const _XLIT_MAP = { "ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "ð": "d", "þ": "th", "đ": "d", "ł": "l", "ħ": "h", "ı": "i", "ŧ": "t", "ĸ": "k", "ŉ": "n", "ƒ": "f", "ə": "e" };
function _transliterateAscii(s) {
  if (!s || typeof s !== "string") return "";
  let out = "";
  for (const ch of s.toLowerCase()) out += (_XLIT_MAP[ch] || ch);
  return out.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

// ext-audit A7 (v7.21.1) — is `tz` a timezone this platform's Intl can resolve?
//
// A stored timezone is USED, not merely displayed: fmtDt, formatEmailDate and
// the competition/session window arithmetic all feed it to Intl, so a value
// that does not resolve throws a RangeError a long way from the write that
// accepted it. POST /api/register accepted any non-empty string.
//
// Validate against the platform's OWN Intl rather than a hard-coded zone list.
// v7.15.23 was a live bug of exactly that kind: the competition form validated
// against `Intl.supportedValuesOf('timeZone')`, which enumerates canonical
// zones and OMITS "UTC", while `resolvedOptions().timeZone` RETURNS "UTC" on a
// UTC host — so on any container or CI runner an admin could not create a
// competition at all. The client's `_isValidTz` (public/js/data/country-tz.js)
// already settled it this way; the server had no equivalent until now.
// A stale allowlist is a lockout, not a hardening.
//
// The check is whether lib/time.js `zoneFormatter` can build the formatter
// formatEmailDate uses, memoised once per zone per process: building one costs
// about 55 µs and the participant import asks once per row.
function isValidTimezone(tz) {
  if (typeof tz !== "string" || !tz.trim()) return false;
  return zoneFormatter(tz) !== null;
}

// Returns the subset of required profile fields that are unset / free-email.
// Drives GET /api/me's missing_fields + the profile-completion gate.
//
// ── v8.4.0 — THE REQUIREMENT IS READ LIVE FROM THE REGISTRATION EVENT ─────────
//
// v8.1.0 (PR 31) made the relaxed set the ACCOUNT'S OWN, FOR LIFE, and its
// reasoning was right about the danger it was avoiding: the gate is
// non-dismissible, so reading the relaxation from the competition a participant
// is CURRENTLY in would corner a Booth Event walk-up the moment they entered
// anything else, demanding fields nobody ever asked them for with no way past it.
//
// The operator has now asked for something a stamped snapshot structurally cannot
// express: an admin who makes a field mandatory must have it demanded of people
// who ALREADY registered — immediately, and even once the event has ended. A
// snapshot answers with the deal as it WAS; only a pointer can answer with the
// deal as it IS.
//
// So the answer comes from `users.registration_competition_id` — the ONE event
// this account was created through, which is a stable, single answer and
// therefore keeps PR 31's protection intact: entering a second event still
// changes nothing about what this account owes. What changed is that the answer
// is re-read rather than remembered.
//
// **THE PAIR IS THE DESIGN, AND THE FALLBACK IS NOT OPTIONAL.** The pointer
// carries no foreign key, so deleting the event leaves it DANGLING — and a
// dangling pointer read as "no relaxation" is exactly PR 31's trap arriving by a
// different route. `profile_policy` therefore stays as the denormalised fallback:
//
//   joined row present → that event's CURRENT states (an admin's live answer)
//   joined row absent  → `profile_policy`'s KIND defaults
//   no pointer at all  → `profile_policy`'s KIND defaults (today's behaviour)
//
// **WHAT THE FALLBACK GUARANTEES, STATED PRECISELY RATHER THAN OPTIMISTICALLY.**
// It is the answer an UNCONFIGURED event of that kind would give — not "the least
// this account could owe". An admin who had RELAXED a field the kind requires by
// default, and whose event is then deleted, leaves an account asked for it once.
// That is deliberate rather than tolerated: it is the same answer the account
// would get if the event still existed and had never been configured, so deleting
// an event does not FLIP what somebody owes — and the residual error is asking
// for a field rather than silently dropping a requirement an organiser did set.
//
// **THE JOINED COLUMNS RIDE THE ROW, and every caller's SELECT must carry them.**
// The alternative is a database read inside this function, and `lib/util.js` is
// imported almost everywhere and deliberately never reaches `db.js`. The keys are
// underscore-prefixed because they are not `users` columns; the strictness below
// is what stops a caller quietly getting the wrong answer.
function _profileMissingFields(user) {
  const missing = [];
  // Lazy require: lib/registration-fields is a leaf, but util is imported almost
  // everywhere and this keeps the edge out of module load order.
  const { registrationFieldStates, registrationFieldDefaultsForKind, REGISTRATION_FIELDS } = require("./registration-fields");
  // A MISSING KEY IS A PROGRAMMING ERROR, exactly as it is in `resolveAttemptCap`
  // and `eventKind`. Several callers read the user row with a hand-written column
  // list, and a list that does not name `profile_policy` silently un-relaxes the
  // account — which puts a Booth Event walk-up behind the NON-DISMISSIBLE
  // completion gate, asking for fields nobody ever collected from them. That is
  // unrecoverable from their side and invisible from ours.
  //
  // This cost three separate diagnoses while building v8.1.0 (`attempt_cap`,
  // `deadline_at`, and this column), so it fails loudly at the one place that can
  // tell. A NULL value is fine and is the normal case; only an absent KEY throws.
  if (!("profile_policy" in user)) {
    throw new Error("_profileMissingFields: the user row has no profile_policy column — the caller under-selected");
  }
  // v8.4.0 — and the same rule for the pointer and its join, in the direction
  // that matters: an under-selecting caller must not silently fall back to the
  // stamped kind defaults, because that is the answer that stops demanding a
  // field an admin has just made mandatory. Failing loudly is the only way a
  // forgotten JOIN is ever noticed — nothing about the response would look wrong.
  if (!("registration_competition_id" in user)) {
    throw new Error("_profileMissingFields: the user row has no registration_competition_id column — the caller under-selected");
  }
  // BOTH joined keys: a SELECT that brings the kind but not the matrix would read
  // every configured event as its kind's defaults, which is the same silent fallback.
  if (user.registration_competition_id && (!("_reg_event_kind" in user) || !("_reg_field_policy" in user))) {
    throw new Error("_profileMissingFields: the user row carries a registration_competition_id but no joined _reg_event_kind / _reg_field_policy — the caller's SELECT is missing the LEFT JOIN on competitions");
  }
  // The live answer when the event still exists, the stamped fallback when it
  // does not. `_reg_event_kind` is NULL (present, unmatched) for a deleted event
  // and ABSENT (thrown above) for a caller that forgot the join, which is exactly
  // why the two cases have to be distinguishable.
  const _live = !!(user.registration_competition_id && user._reg_event_kind);
  const _states = _live
    ? registrationFieldStates({ event_kind: user._reg_event_kind, registration_field_policy: user._reg_field_policy })
    : registrationFieldDefaultsForKind(user.profile_policy || null);
  const _st = (f) => _states[f];
  // "Not demanded" is `hidden` OR `optional`. The gate must honour both, or a
  // field left blank at a stand would put that account behind the
  // non-dismissible gate asking for something it was explicitly told it need not
  // give — the exact trap the relaxed set exists to prevent, one set over.
  const need = (f) => _st(f) === "required";
  if (!user.company?.trim())       missing.push("company");
  if (!user.title?.trim())         missing.push("title");
  // ext-audit A7 (v7.21.1) — these two tested raw truthiness while every other
  // field here trims. " " is truthy, so an account carrying a whitespace-only
  // country/timezone counted as profile-COMPLETE and walked past the
  // non-dismissible completion gate with a timezone no formatter can resolve.
  // Trimming here also makes the gate retroactive for rows already written by
  // the pre-fix registration path.
  if (!user.country?.trim())       missing.push("country");
  if (!user.timezone?.trim())      missing.push("timezone");
  // v8.4.0 — ONE LOOP OVER THE CONFIGURABLE FIELDS, replacing the two hand-written
  // `job_function` / `city` lines. Those two were the only relaxable fields when
  // the set was fixed; three more can now be REQUIRED, and a hand-written line per
  // field is how the next one gets forgotten. Every account is asked alike: a legacy
  // LinkedIn-registered account (`registered_via='linkedin'`) edits its names and
  // LinkedIn URL like anyone else, so it is asked for a required URL like anyone
  // else (operator ruling, 14 Nov 2026).
  for (const f of REGISTRATION_FIELDS) {
    if (!need(f.key)) continue;
    if (!user[f.profileColumn]?.trim()) missing.push(f.key);
  }
  // `corporate_email` IS DELIBERATELY NOT RELAXABLE, for any policy. It is
  // computed outside the relaxable set precisely so it cannot drop out silently
  // alongside the fields that are — write a policy as four field names, omit two
  // correctly, and the corporate-mailbox requirement disappears with them, taking
  // the only barrier on a leaked join link. Nothing errors and no other test
  // fails (v7.29.0). It stays outside the configurable fields for the same
  // reason, which is also why `secondary_email` is not configurable: it is the
  // escape hatch that makes this requirement satisfiable.
  const hasCorp = !isFreeEmail(user.email) ||
    (user.secondary_email && !isFreeEmail(user.secondary_email));
  if (!hasCorp) missing.push("corporate_email");
  return missing;
}

// v8.4.0 — the SELECT fragment every caller of `_profileMissingFields` needs.
//
// ONE definition, because there are five callers and the function throws on an
// under-selecting row: five hand-written copies of a join is the drift this
// codebase pays for repeatedly (`_PARTICIPANT_ROW_COLUMNS` is the same fix on the
// admin surface). The alias prefix is `_reg_` and the keys are stripped from every
// response by the `_`-prefix rules that already exist.
//
// `u` and `_regc` are the table aliases it assumes; a caller that uses different
// ones must adapt the string rather than re-derive the join.
const PROFILE_GATE_JOIN = "LEFT JOIN competitions _regc ON _regc.id = u.registration_competition_id";

// ── the optimistic-concurrency fingerprint for a `users` row ─────────────────
//
// ONE expression, because it is compared in an UPDATE's WHERE and projected onto
// two wires, and those three must agree by construction — a fingerprint the
// client is handed but the swap does not compare against is a control that
// appears to work.
//
// COALESCE, NOT THE BARE COLUMN, and that is the load-bearing half. `updated_at`
// is an ALTER-added column, so db.js backfills it from `created_at` at boot for
// every row that exists — but the six production `INSERT INTO users` statements
// (registration, both LinkedIn paths, the import, desk-invite, bulk-seed) do not
// name it, so every account created AFTER that boot carries NULL. A NULL row
// matches nothing the client can send, which silently disables the 409 for
// exactly that row: the documented failure the backfill exists to prevent,
// reappearing one account at a time and invisible from every screen. Stamping it
// at each INSERT would spread the rule across six sites in three files with
// nothing diffing them; deriving the fallback here keeps it at one.
//
// `created_at` is `TEXT NOT NULL` on this table and is WRITTEN NOWHERE — every
// occurrence in an `UPDATE users SET` is on the right-hand side — so it is a
// stable seed, and `updated_at` (from `now()`) always sorts after it, so the
// fingerprint only ever moves forward.
const _PROFILE_VERSION_COLS = ["updated_at", "created_at"];
/**
 * @param {string} [alias] table alias to qualify the columns with (`"u"`), or
 *   omitted inside `UPDATE users SET … WHERE`, where no alias is in scope.
 */
function profileVersionSql(alias) {
  return `COALESCE(${_PROFILE_VERSION_COLS.map(c => (alias ? `${alias}.${c}` : c)).join(", ")})`;
}
const PROFILE_GATE_COLUMNS = [
  "u.email", "u.secondary_email", "u.company", "u.title", "u.country", "u.timezone",
  "u.job_function", "u.city", "u.personal_title", "u.phone", "u.linkedin_url",
  "u.registered_via", "u.profile_policy",
  "u.registration_competition_id",
  "_regc.event_kind AS _reg_event_kind",
  "_regc.registration_field_policy AS _reg_field_policy",
].join(",");

// Participant-group name validation — shared by the groups routes and the
// invitation bulk-create's newGroups path. Pure (length + non-empty).
const GROUP_NAME_MAX = 80;
function _groupNameOk(name) {
  return typeof name === "string" && name.trim().length > 0 && name.trim().length <= GROUP_NAME_MAX;
}

// Canonical key for group-name UNIQUENESS (ext-audit v7.15.6, hardened v7.15.7).
//
// The dedup checks and uq_groups_name_nocase both relied on SQLite COLLATE
// NOCASE, which folds ASCII ONLY — so "Äudit Team" and "äudit Team" were both
// accepted, defeating the case-insensitive uniqueness db.js promises. That bites
// hardest on the name-keyed INGEST paths (participant import, invitations),
// where a case variant silently creates a SECOND group and splits a cohort.
//
// Nicknames and emails solved the same NOCASE problem by restricting to ASCII;
// that is the wrong trade here, because group names are admin-authored labels
// and the import path would DROP legitimate international names rather than
// merely rename them. So the comparison is Unicode-aware in JS instead.
//
// v7.15.7 — NFKC + toLowerCase alone is NOT case folding: it leaves Σ vs ς and
// Straße vs STRASSE distinct, so those still coexisted. Upper-casing FIRST is a
// close, dependency-free approximation of full case folding — toUpperCase maps
// ς→Σ and ß→SS, which the subsequent toLowerCase then normalises — and it
// handles every case the auditor cited. The trailing NFKC re-normalises what the
// case mapping produced. Not a substitute for a full CaseFolding.txt table
// (Turkish dotted-I remains locale-dependent, by design: we fold locale-
// independently so the same name compares equal everywhere).
function _groupNameKey(name) {
  return String(name == null ? "" : name).trim().normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC");
}

// v7.2.x (audit, perf) — bounded-concurrency worker pool. Runs `tasks` (array of
// () => Promise thunks) at most `limit` at a time, so a large fan-out (SMTP
// sends, bcrypt hashes) is ~ceil(N/limit) hops instead of N sequential, without
// opening N simultaneous connections / starving the libuv threadpool. Each task
// owns its error handling; a throwing task is swallowed so one failure can't
// abort the pool. Extracted from routes/invitations.js so participants/import
// can share it.
async function _runBounded(tasks, limit) {
  let i = 0;
  const worker = async () => {
    while (i < tasks.length) {
      const idx = i++;
      try { await tasks[idx](); } catch (e) { /* each task contains its own error handling */ swallowed("util:bounded-task", e); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), tasks.length) }, worker));
}

// ext-audit v7.15.14 — run a bounded fan-out but never hold the HTTP response
// hostage to it.
//
// The bulk assign / approve / invite routes commit their database work and then
// awaited a bounded SMTP fan-out. The browser aborts at 30 s (fetchWithLoading),
// so on a large batch or a degraded relay the client reported a timeout for an
// operation that had ALREADY committed — the operator could not tell whether it
// had worked, and a retry would re-send every email.
//
// This waits up to `deadlineMs` and then RETURNS, leaving the remaining tasks
// running detached. Nothing is cancelled: every email is still attempted, and
// each task keeps its own error handling. The caller reports `deferred` so the
// UI can say "still sending" instead of implying a count it cannot yet know.
// ext-audit v7.15.15 — detached work must be COUNTABLE, so graceful shutdown can
// wait for it. Without this a rolling deployment silently dropped whatever the
// deadline had detached: invitation and approval emails that the API had already
// reported as sent-or-sending. Mirrors the _deferredAuditPending / cxOneInflight
// gauges the shutdown drain already consults.
let _detachedFanoutPending = 0;
function detachedFanoutPending() { return _detachedFanoutPending; }
// ext-audit v7.20.9 (F8) — the same gauge, opened up to the OTHER kind of
// detached mail.
//
// v7.15.15 counted only what `_runBoundedWithDeadline` detached, so the drain
// covered the bulk fan-outs and nothing else — while `sendEmailBackground`, the
// ordinary fire-and-forget sender behind verification, lockout, unlock, group
// add/remove and reconciliation mail, was completely invisible to it. A SIGTERM
// during a rolling deployment closed the database out from under those sends,
// and the loss was silent because the caller had already discarded the promise.
// One counter rather than two: it is the same question ("is there mail still in
// flight?") and the metric already carries that name.
//
// The promise handed here must never reject — pass one whose `.catch` is
// already attached, or the `.finally` decrements while the rejection escapes as
// a process-level unhandled-rejection warning.
function trackDetachedSend(p) {
  _detachedFanoutPending++;
  return Promise.resolve(p).finally(() => { _detachedFanoutPending--; });
}

async function _runBoundedWithDeadline(tasks, limit, deadlineMs) {
  if (!tasks.length) return { deferred: false };
  let done = 0;
  _detachedFanoutPending += tasks.length;
  const all = _runBounded(tasks.map(t => async () => {
    try { await t(); } finally { done++; _detachedFanoutPending--; }
  }), limit);
  // Swallow rejections on the detached path — an unhandled rejection here would
  // be a process-level warning for something each task already handles.
  all.catch((e) => swallowed("util:fanout-detached", e));
  let timer;
  const deadline = new Promise(res => { timer = setTimeout(() => res("deadline"), deadlineMs); if (timer.unref) timer.unref(); });
  const outcome = await Promise.race([all.then(() => "done"), deadline]);
  clearTimeout(timer);
  return { deferred: outcome === "deadline", completed: done, total: tasks.length };
}

/**
 * Wait for ONE send — a promise resolving to the delivery boolean — for at most
 * `deadlineMs`, then answer what is known: `true` delivered, `false` refused or
 * failed, `null` still sending. A send still running at the deadline carries on
 * detached and counted (the shutdown drain waits for it), exactly as
 * `_runBoundedWithDeadline` leaves a fan-out's tail. A request handler that
 * reports one mail uses it, so the pooled relay's queue (lib/email.js) can never
 * hold the request past the browser's own abort. `deadlineMs` defaults to the
 * bulk fan-out's 10 s (EMAIL_FANOUT_DEADLINE_MS).
 *
 * A REJECTION is not the relay's answer — sendEmailLogged records every SMTP
 * outcome itself and returns false; it rejects only when its own lookups throw
 * before a send. It still counts as not delivered, and is logged at warn under
 * `where` (the caller's label), so "could not be delivered" has a trace that
 * says the mail never reached the relay.
 */
const MAIL_REPORT_DEADLINE_MS = 10_000;
async function awaitDeliveryWithDeadline(sendPromise, deadlineMs = MAIL_REPORT_DEADLINE_MS, where = "util:mail-report") {
  let delivered = false;
  const r = await _runBoundedWithDeadline([async () => {
    try { delivered = !!(await sendPromise); } catch (e) { delivered = false; swallowed(where, e, { level: "warn" }); }
  }], 1, deadlineMs);
  return r.deferred ? null : delivered;
}

// ── IP allowlist matching (v7.2.x, CTF-0026) ────────────────────────────────
// Pure exact-IP + IPv4-CIDR matcher, shared by the rate-limit allowlist
// (lib/middleware.js, RATE_LIMIT_ALLOWLIST_IPS). Mirrors the LOG_SKIP_IPS
// parsing in server.js. IPv6 CIDR is not supported (exact-match only); an
// IPv4-mapped IPv6 (::ffff:a.b.c.d) is normalised to its v4 form for CIDR tests.
// Kept here (dependency-free) so it is unit-testable without pulling in db.js.
function _ipv4ToInt(ip) {
  const v4 = String(ip || "").replace(/^::ffff:/i, "");
  const parts = v4.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) { const v = parseInt(p, 10); if (v !== v || v < 0 || v > 255) return null; n = (n << 8) | v; }
  return n >>> 0;
}
// ext-audit v7.20.9 (F11) — CANONICALISE an address before comparing it.
//
// Exact matching compared raw strings, so `2001:db8::1` (what the admin typed)
// and `2001:0DB8:0000:0000:0000:0000:0000:0001` (what a client presented, or
// what a proxy wrote into X-Forwarded-For) were different allowlist entries for
// the SAME host. The failure is silent and in the unhelpful direction: the
// operator believes the venue is allowlisted and it simply never matches.
//
// The WHATWG URL parser is the canonicaliser — it applies RFC 5952 (lowercase,
// maximal `::` compression) and folds IPv4-mapped forms, and it is a Node
// built-in, so this needs no dependency and no hand-written IPv6 parser. It
// also REJECTS malformed input (`::::`), which is what makes it safe to use on
// the untrusted side: an address we cannot parse falls back to its raw string
// and can therefore only match an identical raw entry, never more.
//
// An IPv4-mapped IPv6 address is unwrapped to its plain IPv4 form so
// `::ffff:192.0.2.1` matches an allowlisted `192.0.2.1` — the same host, and
// the form Express reports on a dual-stack socket without TRUST_PROXY.
function canonicaliseIp(ip) {
  const s = String(ip || "").trim();
  if (!s) return "";
  if (net.isIPv4(s)) return s;
  if (!net.isIPv6(s)) return s;                       // not an IP — compare verbatim
  let host;
  try { host = new URL(`http://[${s}]`).hostname; } catch (_) { return s.toLowerCase(); }
  host = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  // ::ffff:a.b.c.d — the URL parser renders it as ::ffff:hhhh:hhhh, so unwrap
  // from the canonical form rather than from whatever the caller typed.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return host;
}
// WHICH RANGE AN ADDRESS IS IN, for GET /api/admin/my-address ("Use my current
// address" beside an event's Trusted network IPs). Only a "public" address can
// be the venue's egress address as the server sees it. Every other range is one
// the internet never routes, so seeing one means the server is reading a hop it
// should look past (a proxy on its own machine: loopback; a proxy or a network
// in between: private, link_local, shared), which is TRUST_PROXY set wrongly, or
// the platform runs on the venue's own network, where nothing is NATed and the
// field is not needed. "unspecified" and "unknown" (not an address) say nothing
// usable either. Read as canonicaliseIp writes it, a zone index (`%eth0`)
// ignored; net.BlockList judges an IPv4-mapped address (in any spelling) as the
// IPv4 one it is. Documentation ranges (192.0.2.0/24, 198.51.100.0/24,
// 203.0.113.0/24, 2001:db8::/32) are left public on purpose: no client presents
// one, and they are what the examples and the tests use.
const _IP_RANGES = [
  ["loopback", [["127.0.0.0", 8, "ipv4"], ["::1", 128, "ipv6"]]],
  ["private", [["10.0.0.0", 8, "ipv4"], ["172.16.0.0", 12, "ipv4"], ["192.168.0.0", 16, "ipv4"], ["fc00::", 7, "ipv6"]]],
  ["link_local", [["169.254.0.0", 16, "ipv4"], ["fe80::", 10, "ipv6"]]],
  // RFC 6598, carrier-grade NAT's side of the ISP, and the range overlay VPNs
  // (Tailscale) hand out: never what the internet sees.
  ["shared", [["100.64.0.0", 10, "ipv4"]]],
  ["unspecified", [["0.0.0.0", 8, "ipv4"], ["::", 128, "ipv6"]]],
].map(([name, subnets]) => {
  const list = new net.BlockList();
  for (const [addr, prefix, type] of subnets) list.addSubnet(addr, prefix, type);
  return [name, list];
});
// The names `ipAddressRange` answers besides "public" and "unknown", in order.
// The event form words each one (public/js/features/competitions-admin.js
// `_MY_ADDRESS_RANGE_WORDS`, held to this list: tests/my-address.api.spec.js).
const IP_RANGE_NAMES = Object.freeze(_IP_RANGES.map(([name]) => name));
function ipAddressRange(ip) {
  const s = canonicaliseIp(ip).split("%")[0];
  const type = net.isIPv4(s) ? "ipv4" : net.isIPv6(s) ? "ipv6" : null;
  if (!type) return "unknown";
  for (const [name, list] of _IP_RANGES) if (list.check(s, type)) return name;
  return "public";
}
// Parse a comma-separated "exact-ip,cidr,…" string into { exact:Set, cidrs:[] }.
function parseIpAllowlist(str) {
  const exact = new Set();
  const cidrs = [];
  for (const entry of String(str || "").split(",").map(s => s.trim()).filter(Boolean)) {
    const m = entry.match(/^(.+)\/(\d+)$/);
    if (m) {
      const addr = _ipv4ToInt(m[1]); const bits = parseInt(m[2], 10);
      if (addr !== null && bits >= 0 && bits <= 32) {
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        cidrs.push({ addr: addr & mask, mask });
        continue;
      }
    }
    exact.add(canonicaliseIp(entry)); // bare IP, or unparseable CIDR treated as exact
  }
  return { exact, cidrs };
}
// Does `ip` match a parsed allowlist? Exact first, then IPv4 CIDR ranges.
function ipAllowlistMatch(parsed, ip) {
  if (!parsed || !ip) return false;
  if (parsed.exact.has(canonicaliseIp(ip))) return true;
  if (!parsed.cidrs.length) return false;
  const n = _ipv4ToInt(canonicaliseIp(ip));
  if (n === null) return false; // IPv6 (non-mapped) — exact-match only
  for (const c of parsed.cidrs) { if ((n & c.mask) === c.addr) return true; }
  return false;
}

// v8.13.3 — a paging index read off the query string: an OFFSET (floor 0) or a
// 1-based PAGE (floor 1). LENIENT, per the ext-audit F3 disposition — a non-number
// or a value under the floor becomes the floor, never a 400 — and now bounded ABOVE
// too: better-sqlite3 binds an integral number as an INTEGER only inside int64, so
// past ~9.22e18 (or at Infinity, which parseInt returns for a ~309-digit string)
// SQLite refuses LIMIT/OFFSET with SQLITE_MISMATCH and the request was a generic 500.
// The cap is 1e9, not MAX_SAFE_INTEGER, so every DERIVED bind stays an exact
// integer: (page-1)*limit with limit <= 5000 peaks at ~5e12. No table here
// approaches 1e9 rows, so an index at the cap is simply the empty past-the-end page.
// Radix 10 explicitly: '0x10' reads 0, not 16 (no client sends hex).
const PAGING_INDEX_MAX = 1_000_000_000;
function clampPagingIndex(raw, floor = 0) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < floor) return floor;
  return Math.min(n, PAGING_INDEX_MAX);
}

// TRUST_PROXY as Express's `trust proxy` value. Keywords are case-insensitive
// (`TRUE`, `False`, `LOOPBACK`): Express and proxy-addr match them exactly and
// read any other spelling as an IP address, which throws and stops boot.
// unset/"" → false; true; false or 0 → false; a hop count → that number; else a
// comma list of addresses, CIDRs and the presets loopback, linklocal,
// uniquelocal, each preset name lower-cased and every other entry passed on as
// written.
const _TRUST_PROXY_PRESETS = new Set(["loopback", "linklocal", "uniquelocal"]);
function parseTrustProxy(raw) {
  if (raw === undefined || raw === null || raw === "") return false;
  const v = String(raw).trim();
  if (v === "") return false;
  const lower = v.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false" || v === "0") return false;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return v.split(",").map((t) => t.trim()).filter(Boolean)
    .map((t) => (_TRUST_PROXY_PRESETS.has(t.toLowerCase()) ? t.toLowerCase() : t)).join(",");
}

module.exports = { normaliseRoutePath, rateBucketKey, _runBoundedWithDeadline, awaitDeliveryWithDeadline, MAIL_REPORT_DEADLINE_MS, detachedFanoutPending, trackDetachedSend,
  normaliseEmail, validateUrl, _b64url, _b64urlDecode,
  isFreeEmail, _EMAIL_RE, isValidEmailFormat, sameSlotEmails,
  _capsOk, _firstNonStringField, _profileMissingFields, isValidTimezone,
  PROFILE_GATE_JOIN, PROFILE_GATE_COLUMNS, profileVersionSql,
  _nicknameCharsOk, NICKNAME_CHARSET_ERROR, _transliterateAscii, _XLIT_MAP,
  PROFILE_TEXT_FIELDS, PROFILE_TEXT_LABELS, profileTextControlError, profileTextOk, profileTextControlField, profileTextControlBody,
  parseTrustProxy,
  GROUP_NAME_MAX, _groupNameOk, _groupNameKey, _runBounded,
  NO_PASSWORD_HASH,
  _ipv4ToInt, canonicaliseIp, ipAddressRange, IP_RANGE_NAMES, parseIpAllowlist, ipAllowlistMatch,
  PAGING_INDEX_MAX, clampPagingIndex,
};
