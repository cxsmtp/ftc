"use strict";

// v8.4.0 — the registration-form matrix is owned by lib/registration-fields.js,
// which is a LEAF: it requires nothing at module scope, so the edge runs one way
// and this file keeps its dependency-free load order. The three registration keys
// below are DERIVED from that module's per-kind defaults rather than restated
// here — two hand-written copies of "which fields does a Booth Event ask for" is
// exactly the mirror this table exists to prevent, and the second copy would be
// the one an admin's per-event configuration silently disagreed with.
const {
  registrationFieldStates, registrationFieldDefaultsForKind, CONFIGURABLE_KINDS,
} = require("./registration-fields");

// The three event kinds, and every behaviour DERIVED from them.
//
// v7.29.0 — one module owns this because the alternative is the failure this
// codebase keeps paying for: a rule re-derived at each consumer, correct at all
// of them on the day it is written, and silently divergent afterwards. A caller
// asks `eventPolicy(row).sessions`, never `row.event_kind === "booth"`.
//
// STORED VALUES ARE OPAQUE ON PURPOSE. `booth` / `tournament` / `program` are not
// derivable from the labels ("Booth Event" / "Competition" / "Program"), so a
// future rename is a copy change here rather than a fatal migration over every
// row, every export file and every audit blob. Nothing maps a label back to a
// value, and a lock asserts the two sets stay disjoint.
//
// THE COLLECTIVE NOUN IS RESERVED. "Event / Events" names the container —
// the nav item, headings, list counts, kind-independent copy — and no KIND label
// may equal it, which is why kind 1 is "Booth Event" rather than "Event". Without
// that rule a chip reading "Event" inside a pane headed "Events" reads as
// uncategorised.

const EVENT_COLLECTIVE = {
  singular: "Event", plural: "Events", article: "an",
  countNoun: "event", countNounPlural: "events",
};

// `countNoun` is the lowercase form setListCount takes — countText's zero-match
// branch is a full sentence, so `label` would capitalise mid-sentence.
// `article` exists for the NEXT label, not these three: a first-letter rule
// ships "an University Program".
//
// v8.1.0 (PR 13) — `countNounPlural` is REQUIRED alongside it, and shipping only
// the singular was a real defect rather than an omission. setListCount builds
// countText({ noun, nounPlural, … }) from the element's dataset, so an override
// supplying only `noun` leaves the plural at the dataset value: "3 of 12 events
// match" on a pane filtered to Programs, and the zero branch — a full sentence in
// a role="status" aria-live region announced on a 15-second poll — reads "No
// events shown — every program is hidden by the current filter". Explicit plurals
// rather than a _plural(label) heuristic, because a label table that depends on a
// pluralisation helper in another module IS a mirror.
const EVENT_KINDS = [
  {
    value: "booth",
    label: "Booth Event", plural: "Booth Events", article: "a",
    countNoun: "booth event", countNounPlural: "booth events",
    blurb: "A few hours, in one room, one session. Phone-solvable challenges, no Checkmarx One tenant needed, walk-up sign-up.",
  },
  {
    value: "tournament",
    label: "Competition", plural: "Competitions", article: "a",
    countNoun: "competition", countNounPlural: "competitions",
    blurb: "Online or hybrid, from a few hours to several days. One session or many. Ranked, with certificates and LinkedIn sharing. This is how every existing competition behaves.",
  },
  {
    value: "program",
    label: "Program", plural: "Programs", article: "a",
    countNoun: "program", countNounPlural: "programs",
    blurb: "Self-paced learning or certification, with a deadline. No sessions, no leaderboard, no placings. Certificate on full completion only, with a public verification code.",
  },
];

const DEFAULT_KIND = "tournament";
const _BY_VALUE = new Map(EVENT_KINDS.map(k => [k.value, k]));

// TOLERANT on an unrecognised value, STRICT on a missing key — and the asymmetry
// is the mechanical guard. A value this build does not know means a rollback (the
// row was written by a newer image), so normalise to the default and keep
// serving. A missing key means the CALLER under-selected its columns, which is a
// programming error: several partial competition SELECTs feed policy checks, and
// a missed one would silently give Competition semantics to a Booth Event.
function eventKind(row) {
  if (row === null || row === undefined) throw new Error("eventKind: no row");
  if (typeof row === "string") return _BY_VALUE.has(row) ? row : DEFAULT_KIND;
  if (!("event_kind" in row)) {
    throw new Error("eventKind: row has no event_kind — the SELECT that produced it is missing the column");
  }
  const v = row.event_kind;
  return _BY_VALUE.has(v) ? v : DEFAULT_KIND;
}

function eventKindLabel(row) { return _BY_VALUE.get(eventKind(row)).label; }

// v8.1.0 (PR 13) — the phrase every kind-derived refusal must use.
//
// §2.9's rule is "never the value, always {article} {label}", and the ARTICLE is
// the half that gets hard-coded and then quietly goes wrong. It is not decoration:
// a first-letter vowel rule is correct for all three current labels, which is
// exactly the shape of a heuristic that stays right until it is silently wrong
// ("an University Program", "a Hour-long Sprint"). Three characters per row buys
// the guarantee, and composing the phrase HERE means a refusal cannot pair the
// wrong article with a renamed label.
function eventKindArticle(row) { return _BY_VALUE.get(eventKind(row)).article; }
function eventKindPhrase(row) { return `${eventKindArticle(row)} ${eventKindLabel(row)}`; }

// The derived table. Everything a kind decides, in one place, so a consumer never
// switches on the value itself.
//
//   sessions           "forbidden" | "many"   — forbidden is enforced from BOTH
//                      ends (the create route refuses, and a kind change refuses
//                      while slots exist), which turns "zero sessions" into a
//                      theorem and lets the existing single-slot paths serve two
//                      of the three kinds with no new code.
//   schedule           "window" | "deadline"
//   ranked             whether score/rank/placing exist ANYWHERE for this kind
//   certificate        "attempt" | "completion"
//   trustedNetworks    "eligible" | "never" — a Program is single-session by the
//                      implemented rule, so it would satisfy today's eligibility
//                      check; a decade-long rate-limit bypass is exactly what the
//                      time-bounding exists to prevent, hence an explicit never.
//   (the registration form) v8.4.0 — WHICH FIELDS THE SIGN-UP FORM ASKS FOR IS NO
//                      LONGER A PROPERTY OF THE KIND. It is a per-EVENT
//                      configuration owned by lib/registration-fields.js, whose
//                      per-kind DEFAULTS are what this table used to carry as
//                      `relaxedProfile` / `optionalProfile` /
//                      `allowSimplifiedRegistration`. Ask
//                      `registrationFieldStates(comp)` for an event, or
//                      `registrationFieldDefaultsForKind(kind)` for a kind with no
//                      row. corporate_email is still computed OUTSIDE that matrix
//                      precisely so it cannot drop out silently alongside the
//                      fields that are configurable.
//   (the password)     v8.3.2 gave a Booth Event walk-up permission to DECLINE a
//                      password, which leaves `password_set_at` NULL — the one
//                      discriminator `isCodeEligible` keys on — so the account
//                      signs in with an emailed code instead. That is the same
//                      deal the desk shortcut has always given, and until v8.3.2
//                      the two doors at one stand produced opposite outcomes.
//
//                      v8.4.0 — the password is now the sixth field of the
//                      per-event matrix, with THREE states rather than a boolean
//                      permission: required, offered-and-declinable, or not
//                      offered at all (a Booth Event's new default, so the QR and
//                      the desk produce the same passwordless account). It lives
//                      with the other five in lib/registration-fields.js.
//   revealAnswers      "allowed" | "forbidden" — v8.1.0 (PR 18). Forbidden for a
//                      Program, and the reveal-then-revive farm is why: the
//                      deadline passes, answers are published to EVERY enrollee
//                      (the gate is fullyEnded && flag, not "solvers only"), an
//                      admin moves the deadline forward, everyone solves from the
//                      published key and mints a verifiable certificate. For a
//                      Competition that is an accepted low-stakes risk; for a
//                      certification it is an integrity break in an artifact shown
//                      to employers. The legitimate need — a learner should see the
//                      teaching — is met by a different mechanism already in the
//                      design: the EXPLANATION is shown on a challenge they have
//                      solved, whatever the flag says. The explanation is the
//                      teaching; the answer key is the key.
//   groupLeaderboard   "allowed" | "forbidden" — forbidden where nothing is ranked,
//                      which also makes the "every end transition must freeze the
//                      team board" invariant UNREACHABLE for that kind rather than
//                      raced.
//   startReminder      "allowed" | "forbidden" — a Program is not an appointment,
//                      so a "starts in 1 hour" mail is the wrong model. A DEADLINE
//                      reminder is a different mechanism and out of scope:
//                      email_reminders has PK (user_id, competition_id), so a row
//                      could carry a start reminder or a deadline reminder but
//                      never both, and re-meaning the column per kind puts two
//                      semantics on one value the v7.21.5 dispatcher binds into
//                      its claim.
// v8.1.0 (PR 34) — `measurePresence` decides whether an event MAY record net
// active time at all. It is a per-kind rule, not a per-event free-for-all:
//
//   * a **Booth Event** is FORBIDDEN. Over a 45-minute window there are nine
//     five-minute buckets, so two attendees present throughout both score nine
//     and fall through to `userId` lex order — quantisation noise dressed up as
//     a measurement. The number would be worse than not having it.
//   * a **Program** is allowed but still defaults OFF, because it can run to
//     `start + 10 years` and unconditional recording would be a decade-long
//     presence record nobody asked for.
//
// There is no instant-join seed: the "Allow instant join" switch was retired
// (operator ruling, 14 Nov 2026) — every sign-up proves its address with an
// emailed code first, so a walk-up's round trip is the same on every kind.
// `choiceLayout` — v8.13.0. HOW A MULTIPLE-CHOICE CHALLENGE IS ANSWERED ON A
// PHONE: "tap" = the whole screen holds the question and its answers as large
// tiles, and tapping one opens the existing penalty confirm; "standard" = the
// radios-and-Submit card every other answer type uses.
//
// A Booth Event is "tap" because its whole shape is a walk-up on their own phone
// at a stand for two minutes. A Competition and a Program are "standard" —
// signed up for in advance and worked through over hours, from a laptop as often
// as a phone — and the operator asked for the booth case alone.
//
// PRESENTATION ONLY. Nothing on the server reads it: the choice ids, the grading
// hash, the submit route and every refusal are identical in both layouts. It is a
// KEY rather than a client test of the kind because `public/js` may not derive
// behaviour from a stored kind (event-kind-form-scope's rule): the first time a
// second kind wants the layout, the change is one word here.
// `autoResume` — v8.3.8. On sign-in, does the platform re-enter the event the
// participant last chose, instead of asking them to choose again?
//
// The rule the operator asked for is "a participant is asked to choose ONCE".
// Choosing an event is a decision, not a per-session chore: someone who picked
// tomorrow's Competition last night, or scanned a Booth Event's QR at a stand
// and stepped away, should land back where they were. The marker
// (`users.active_competition_id`) is written when they choose and cleared when
// they deliberately go back to the event list — that exit is the whole of the
// opt-out, and it is why this can be ON by default without trapping anybody.
//
// v8.3.15 — THE PROGRAM CARVE-OUT IS REMOVED, ON THE OPERATOR'S INSTRUCTION, and
// this key is now `true` for EVERY kind. v8.3.8 set a Program `false` on the
// grounds that its enrolment is rolling and its deadline can be years out, so a
// learner is routinely in SEVERAL at once and pinning them into whichever they
// opened last would make the others progressively harder to reach.
//
// THAT ARGUMENT WAS MADE BEFORE `users.left_event_at` EXISTED. The opt-out is now
// DURABLE across a sign-out — pressing Events is REMEMBERED rather than merely
// applied to the session in hand — so "the others are hard to reach" costs one
// click, once. Against that, a carve-out the participant cannot see means the
// platform behaves differently for one kind for reasons nothing on screen
// explains, which is the shape v7.14.2 is about.
//
// THE KEY IS KEPT RATHER THAN DELETED even though all three kinds now agree. It
// is still READ (`autoResumeAllows`), so it is not dead config that merely reads
// as a control; and this table is where per-kind decisions are recorded, so
// re-introducing an exclusion is a one-line change in the place a future reader
// would look for it.
//
// It is deliberately NOT projected onto the wire. No client renders or branches
// on it — the resume happens server-side at sign-in and the exit clears the
// marker unconditionally (a no-op for a kind that never set one) — and shipping
// a key nothing honours is the control-that-appears-to-work failure. Adding it
// later is additive.
const POLICY = {
  booth: {
    revealAnswers: "allowed", groupLeaderboard: "allowed", startReminder: "allowed",
    sessions: "forbidden", schedule: "window", ranked: true, certificate: "attempt",
    trustedNetworks: "eligible", autoEndOnAllSolvedDefault: 0,
    // v8.3.11 — a PROHIBITION, not a default, and the two are different things.
    // `autoEndOnAllSolvedDefault` seeds the column at create; `autoEndOnAllSolved`
    // says whether the rule may fire AT ALL. Until now the booth guarantee rested
    // on three cooperating writers all agreeing to store 0 — one writer away from
    // being false, and there was a one-day window at v8.0.0 where the create
    // INSERT did not name the column and a booth took the schema DEFAULT 1.
    // Reading the prohibition at the gate makes it a theorem: whatever the column
    // holds, a Booth Event does not auto-end because everyone finished. See
    // "A Booth Event never auto-ends on all-solved" in CLAUDE.md.
    autoEndOnAllSolved: "never",
    cxoneDisabledDefault: 1, selfEnrollDefault: 1,
    // Event team reports — the create-form tick "Add the qualifying questions"
    // (lib/qualifying.js). ON for a stand, where qualifying the walk-up is the
    // point; available to every kind, seeded OFF for the other two.
    qualifyingQuestionsDefault: 1,
    refusesFileAnswers: true, refusesToolRequiringChallenges: true,
    autoResume: true,
    measurePresence: "forbidden",
    // v8.6.0 — MAY THIS KIND KEEP ITS DOOR OPEN AFTER IT ENDS? A stand in a hall
    // has a walk-up who arrives at 16:55 for a 17:00 close, and by the time they
    // have registered and signed in the event is over. The other two kinds are
    // signed up for in advance, from a desk, so neither has that person to catch —
    // hence a PROHIBITION rather than a default, read at the gate
    // (`lateEntryAllowed`) so no Competition can run one whatever its column holds.
    // The rule itself is lib/late-entry.js's.
    lateEntry: "allowed",
    // v8.13.0 — see the block comment above `POLICY`.
    choiceLayout: "tap",
    // WHEN A PARTICIPANT'S SOLVE CLOCK STARTS — see `clockStartsAtFirstOpen`.
    clockStart: "allowed", clockStartDefault: "first_open",
  },
  tournament: {
    revealAnswers: "allowed", groupLeaderboard: "allowed", startReminder: "allowed",
    sessions: "many", schedule: "window", ranked: true, certificate: "attempt",
    trustedNetworks: "if-single-session", autoEndOnAllSolvedDefault: 1,
    autoEndOnAllSolved: "allowed",
    cxoneDisabledDefault: 0, selfEnrollDefault: 0,
    qualifyingQuestionsDefault: 0,
    refusesFileAnswers: false, refusesToolRequiringChallenges: false,
    autoResume: true,
    measurePresence: "allowed",
    // NEVER, and the asymmetry with booth is the whole point of the key. A
    // Competition is signed up for in advance and runs to a published end; keeping
    // it joinable and playable for two days afterwards would leave its board
    // provisional long after the result was announced.
    lateEntry: "never",
    choiceLayout: "standard",
    clockStart: "allowed", clockStartDefault: "first_open",
  },
  program: {
    revealAnswers: "forbidden", groupLeaderboard: "forbidden", startReminder: "forbidden",
    sessions: "forbidden", schedule: "deadline", ranked: false, certificate: "completion",
    trustedNetworks: "never", autoEndOnAllSolvedDefault: 0,
    // ALLOWED, not "never", and the asymmetry with booth is the operator's
    // instruction rather than an oversight. A Program defaults the column OFF, so
    // the rule is inert in practice — but nothing about a self-paced kind makes
    // "everyone finished, so close it" wrong, whereas a Booth Event is a stand
    // that stays open for the next walk-up whatever the people already at it have
    // done. Only booth was asked for; inventing a second prohibition would be a
    // decision nobody took.
    autoEndOnAllSolved: "allowed",
    cxoneDisabledDefault: 1, selfEnrollDefault: 0,
    qualifyingQuestionsDefault: 0,
    refusesFileAnswers: false, refusesToolRequiringChallenges: false,
    // v8.3.15 — was `false`. See the block comment above `POLICY`.
    autoResume: true,
    measurePresence: "allowed",
    // NEVER. A Program already runs to a deadline that can be a year out; "the
    // event stays open a little longer" is what its own deadline is for, and a
    // second, later deadline on top would be two answers to one question.
    lateEntry: "never",
    choiceLayout: "standard",
    // NEVER: a Program is unranked, so no tie is broken on its clock, and its
    // learners keep the entry anchor they always had (owner decision, 27 Nov
    // 2026: "leave Programs alone"). Whatever its column holds, it reads `entry`.
    clockStart: "never", clockStartDefault: "entry",
  },
};

// v8.4.0 — `relaxedProfile` / `optionalProfile` / `allowSimplifiedRegistration`
// ARE GONE FROM THIS TABLE, and the removal is deliberate rather than a tidy-up.
//
// Those three keys answered "which fields does this KIND ask for", which was the
// whole question while a Booth Event's shortened form was a constant. It is not
// any more: a Booth Event configures its own form per event, so a caller holding
// only a kind cannot know the answer — and a key that returns a plausible,
// authoritative-looking value which is simply not what the event does is worse
// than no key at all. Every consumer now asks `registrationFieldStates(comp)`,
// which takes the ROW; `registrationFieldDefaultsForKind(kind)` is the explicit
// way to ask for a kind's default, which is what the create wizard wants because
// it has no row yet.
//
// Both live in lib/registration-fields.js and are re-exported at the bottom of
// this file, so a consumer that already imports `eventPolicy` has one import site
// for the whole kind-and-registration question.
function eventPolicy(row) { return POLICY[eventKind(row)]; }

/**
 * v8.3.11 — MAY THIS EVENT END BECAUSE EVERYONE FINISHED? Asked at three sites.
 *
 * Two clauses, and they answer different questions. The POLICY clause is a
 * prohibition on the kind: a Booth Event is a stand that stays open for the next
 * walk-up, so it never closes itself because the people already at it are done.
 * The COLUMN clause is the per-event opt-out an admin's kind seeded at create.
 *
 * ONE DEFINITION, because there are three consumers and until now only one of
 * them asked the question at all. The submit-path scan honoured the column; the
 * two REVIVE gates — which refuse to reopen an event while everyone is still
 * finished — did not, so an event that could never have auto-ended in the first
 * place was still refused a revive by the predicate that would have ended it.
 * That is not hypothetical: a Booth Event created in the one-day v8.0.0 window
 * took the schema DEFAULT 1, really did auto-end, and after the prohibition
 * lands would have been unreopenable for exactly that reason.
 *
 * Takes a ROW, so both clauses are read from the same object — a caller holding
 * a partial SELECT gets `eventKind`'s explicit throw rather than a silent
 * Competition-semantics answer for a Booth Event (v7.29.0).
 */
function autoEndOnAllSolvedApplies(comp) {
  if (eventPolicy(comp).autoEndOnAllSolved === "never") return false;
  return !!comp.auto_end_on_all_solved;
}

// v8.1.0 (PR 12) — the CLIENT projection of the policy, and it is deliberately
// NOT the whole table.
//
// `ranking_enabled`, NOT `ranked`, and the rename is forced rather than stylistic.
// tests/functional-security-c.api.spec.js defines
// `leakyNamePattern = /total|count|num_participants|ranked(?!_)/i` and applies it
// RECURSIVELY to the participant leaderboard payload, so a nested `policy.ranked`
// trips the participant-count leak scanner. Teaching that scanner an exception for
// a key matching its own pattern is one edit from disabling what it was written
// for, so the wire key moves instead. "ranking" does not contain "ranked".
//
// WHAT IS DELIBERATELY WITHHELD, because everything shipped becomes a contract:
//   *Default (autoEndOnAllSolved / cxoneDisabled / selfEnroll) — CREATE-time
//     seeds for the admin form, not properties of an event that already exists.
//     An existing event's real values are its own columns, which already ship.
//   refuses* — server-side admin validation (the file-answer and tool-requiring
//     refusals). A client that mirrored them would be a second implementation of
//     a rule the server owns.
//   trustedNetworks — an admin-form concern; it reaches the client with the
//     control it governs, not before.
//   (relaxedProfile joined the wire in v8.1.0 (PR 31), optionalProfile in v8.3.1
//     and allowSimplifiedRegistration in v8.3.2 — each when the form that reads
//     it landed, which is exactly the "with the control it governs, not before"
//     rule rather than an exception to it. Nothing is withheld from the
//     registration group any more.)
//
// Adding a key here later is additive and safe. Shipping one nothing honours is
// the "control that appears to work" failure, one layer down.
function eventPolicyForWire(row) {
  const p = eventPolicy(row);
  return {
    sessions: p.sessions,
    schedule: p.schedule,
    ranking_enabled: p.ranked,
    certificate: p.certificate,
    // v8.4.0 — ONE KEY REPLACES THE THREE REGISTRATION KEYS THAT WERE HERE, and
    // the replacement is forced rather than tidy.
    //
    // `relaxed_profile` (v8.1.0 PR 31), `optional_profile` (v8.3.1) and
    // `allow_simplified_registration` (v8.3.2) each arrived with the control it
    // governed, and between them they encoded a TWO-state answer for two fields
    // plus a boolean for the password. That shape cannot carry what a Booth Event
    // may now configure:
    //
    //   * the password (a sign-up field then) had THREE states, and
    //     `allow_simplified_registration` was a boolean — it could not express
    //     "do not show the field at all", the default a walk-up needed.
    //   * `personal_title` / `phone` / `linkedin_url` were optional for every kind
    //     and can now be REQUIRED. Under the old pair a field's state was read as
    //     "hidden if relaxed, optional if optional, else required", so those three
    //     would have to be listed in `optional_profile` on every kind merely to
    //     stay as they are — and a client that had not been taught that would
    //     start demanding a salutation from everybody.
    //
    // So the wire carries the states themselves, one value per field, and the
    // client's three branches read the value rather than inferring it from two
    // set memberships. There is exactly one representation of this on the wire,
    // which is what makes it impossible for two of them to disagree.
    //
    // PER COMPETITION, NOT PER KIND. This is the key that made `eventPolicyForWire`
    // require a real row: `registrationFieldStates` throws on a row that does not
    // carry `registration_field_policy`, so a hand-written SELECT that forgets the
    // column fails loudly instead of serving the kind's defaults for an event an
    // admin has configured. `eventKindsForWire` passes an explicit "no
    // configuration" row for the create wizard, which genuinely wants the default.
    registration_fields: { ...registrationFieldStates(row) },
    // v8.4.0 — WHETHER THIS KIND CONFIGURES THE FORM AT ALL, which is a different
    // question from what it currently asks for. Every kind carries a full
    // `registration_fields` map (its resolved answer), so the states alone cannot
    // tell the admin form whether to render the controls — and the alternative was
    // `kind === "booth"` in client source, which is precisely the re-derived rule
    // this module exists to prevent: correct today, silently wrong the first time
    // a second kind becomes configurable, and invisible because the section would
    // simply not render. `public/js` is a browser-only graph and cannot import the
    // module that owns the answer, so the answer ships instead.
    registration_fields_configurable: CONFIGURABLE_KINDS.has(eventKind(row)),

    // v8.2.0 — the four keys the competition FORM needs to decide which controls
    // to render, and they arrive now for the reason PR 12 reserved: a key reaches
    // the client "with the control it governs, not before". The control is the
    // create wizard's second step, which renders only what the chosen kind can
    // use, so each of these now has a consumer.
    //
    // They are the SAME four the server already refuses on (`reveal_answers_forbidden`,
    // `group_leaderboard_forbidden`, `measure_presence_forbidden` /
    // `time_basis_forbidden`, `trusted_networks_forbidden`) — which is the point:
    // the surface that decides what to OFFER now reads the same rule as the surface
    // that decides what to ALLOW, so the form cannot present a control the save
    // would reject. Values are the policy's own vocabulary, never booleans: a
    // boolean would collapse trustedNetworks' three states into two.
    //
    // None matches functional-security-c's `leakyNamePattern`
    // (/total|count|num_participants|ranked(?!_)/i), which is why they can be
    // spelled plainly rather than renamed the way `ranked` had to be.
    reveal_answers: p.revealAnswers,
    group_leaderboard: p.groupLeaderboard,
    measure_presence: p.measurePresence,
    trusted_networks: p.trustedNetworks,

    // v8.6.0 — MAY THIS KIND RUN A LATE-ENTRY WINDOW? It arrives with the control
    // it governs (the competition form's Late entries section), which is the "not
    // before" half of the rule PR 12 set rather than an exception to it.
    //
    // The POLICY vocabulary, never a boolean, matching the four keys above: a
    // boolean here would be indistinguishable from the per-EVENT toggle, which is
    // a different question with a different answer (`late_entry_enabled` rides the
    // competition row, and every kind carries one whether or not it may act on it).
    // The form needs both — whether to render the section at all, and how to seed
    // it — and conflating them is how a section comes to render for a kind the
    // save then refuses.
    //
    // Does not match functional-security-c's `leakyNamePattern`
    // (/total|count|num_participants|ranked(?!_)/i), so it can be spelled plainly.
    late_entry: p.lateEntry,

    // v8.13.0 — HOW THE PARTICIPANT ANSWERS A MULTIPLE-CHOICE CHALLENGE ON A PHONE
    // ("tap" | "standard"). It arrives with the control it governs — the
    // tap-to-answer screen in public/js/features/choice-tap.js — and the client
    // tests it POSITIVELY (=== "tap"), so a stale payload, an older server or a
    // value invented later keeps today's screen rather than a half-built one.
    // Does not match `leakyNamePattern`, so it is spelled plainly.
    choice_layout: p.choiceLayout,

    // MAY THIS KIND START THE SOLVE CLOCK AT THE FIRST OPEN? ("allowed" | "never").
    // It arrives with the control it governs (the event form's "Start each
    // participant's clock" choice), which renders only where this is "allowed".
    clock_start: p.clockStart,
  };
}

// The wire shape for GET /api/config. The client keeps NO fallback copy of the
// labels: a chip reading "Competition" on a Booth Event is a WRONG answer, not a
// degraded one, so a surface that cannot load these refuses to render rather than
// captioning three cards with their stored values.
function eventKindsForWire() {
  return EVENT_KINDS.map(k => ({
    value: k.value, label: k.label, plural: k.plural, article: k.article,
    countNoun: k.countNoun, countNounPlural: k.countNounPlural, blurb: k.blurb,
    // v8.1.0 (PR 13) — which card the create chooser pre-selects. Derived from
    // DEFAULT_KIND rather than left to the client, so no stored value ("tournament")
    // has to be written into client source to express "this is the usual one".
    isDefault: k.value === DEFAULT_KIND,

    // v8.2.0 — THE SAME PROJECTION AN EXISTING EVENT CARRIES, keyed by kind.
    //
    // A create has no row, so `eventPolicyForWire(comp)` has nothing to read —
    // and the wizard's second step has to know what to render BEFORE the event
    // exists. The alternative is a client-side kind→fields map, which is the one
    // thing this module exists to prevent: it would be correct on the day it was
    // written and silently divergent the first time a policy moved. One function,
    // two carriers — a row's `policy` and a kind's `policy` are byte-identical
    // for the same kind, and a lock asserts it.
    // v8.4.0 — the two registration columns are named EXPLICITLY as "not
    // configured" rather than omitted. `eventPolicyForWire` is strict about them
    // (a missing column throws), and a create has no row to read them from, so
    // this is the one caller that legitimately means "give me the kind's
    // defaults" — saying so in the argument is what keeps the strictness useful
    // everywhere else instead of forcing it to guess.
    policy: eventPolicyForWire({ event_kind: k.value, registration_field_policy: null }),

    // The CREATE-time seeds, which is why they ride the KIND rather than the row:
    // PR 12 withheld the `*Default` values from the row projection on the grounds
    // that they are "create-time seeds for the admin form, not properties of an
    // event that already exists" — and that reasoning is exactly why they belong
    // here instead. An existing event's real value is its own column.
    //
    // ONLY `cxone_disabled`, because only that one has a consumer. It is also the
    // one the UI silently defeated: the form has always SENT `cxone_disabled`
    // unconditionally, so `cxoneDisabledDefault` was dead for every competition
    // created through the browser — a Booth Event, whose policy says do not mint
    // external identities for two-minute walk-ups, arrived with provisioning ON.
    // The form seeds the checkbox from this, so the admin SEES the kind's default
    // and can still overrule it. `autoEndOnAllSolvedDefault` is NOT here: no form
    // control sends it, so the server's `=== undefined` branch already applies
    // it, and shipping a key nothing honours is the failure this file keeps naming.
    // v8.6.0 — `late_entry_enabled` joins it for the identical reason: the form
    // seeds a checkbox from this, so the server's `=== undefined` branch stays
    // REACHABLE. Seed it from a client literal instead and that branch is dead
    // code — which is exactly how `cxone_disabled` (pre-v8.2.0) arrived on every
    // browser-created Booth Event against its own default.
    // The seed is ON for booth, which is the operator's instruction.
    // The join-link seed joins them for the TEMPLATE EDITOR, the one form that
    // offers this switch before an event exists: it shows a setting a template
    // leaves out as the kind's seed and keeps it out of the save, so the
    // server's `=== undefined` branch (`_bpResolve`) still decides it.
    defaults: {
      cxone_disabled: !!POLICY[k.value].cxoneDisabledDefault,
      self_enroll_enabled: !!POLICY[k.value].selfEnrollDefault,
      late_entry_enabled: lateEntryDefaultForKind(k.value),
      // Event team reports — seeds the create form's "Add the qualifying
      // questions" tick, keeping the server's `=== undefined` branch reachable.
      add_qualifying: !!POLICY[k.value].qualifyingQuestionsDefault,
      // Seeds the form's clock-start choice, keeping the server's
      // `=== undefined` branch reachable.
      clock_start: POLICY[k.value].clockStartDefault,
    },
  }));
}

/**
 * v8.6.0 — the CREATE-time seed for `competitions.late_entry_enabled`.
 *
 * Derived from the prohibition rather than stored beside it, so the two cannot
 * disagree: a kind that may not run a late window is seeded OFF, and a kind that
 * may is seeded ON — the operator's "the default should be on". Adding a fourth
 * kind therefore needs no edit here.
 */
function lateEntryDefaultForKind(kind) {
  return POLICY[eventKind(kind)].lateEntry === "allowed";
}

/**
 * DOES THIS EVENT START EACH PARTICIPANT'S SOLVE CLOCK AT THEIR FIRST OPEN OF A
 * SCORING CHALLENGE (owner decision, 27 Nov 2026), rather than when they enter?
 *
 * The one predicate every reader asks: the entry doors (select-competition,
 * select-timeslot, the lazy stamp) stamp `competition_users.login_time` only when
 * this is false, the first-touch stamp (lib/middleware.js
 * `stampClockOnFirstTouch`) only when it is true, and the board's fallback
 * anchor, the session lock and presence follow it. Positive on the stored value
 * (`=== "first_open"`), so an unknown value keeps the entry rule every event
 * before the column ran on; a kind whose policy says "never" (a Program) reads
 * `entry` whatever its column holds. Strict on a missing key: a partial SELECT
 * must not silently pick a clock.
 */
function clockStartsAtFirstOpen(row) {
  if (!row || typeof row !== "object" || !("clock_start" in row)) {
    throw new Error("clockStartsAtFirstOpen: the row carries no clock_start");
  }
  return eventPolicy(row).clockStart === "allowed" && row.clock_start === "first_open";
}

/** The create seed for `competitions.clock_start`, from the kind's policy. */
function clockStartDefaultForKind(kind) {
  return POLICY[eventKind(kind)].clockStartDefault;
}

module.exports = {
  // v8.4.0 — re-exported so a consumer that already imports eventPolicy has one
  // import site for the whole kind-and-registration question rather than two.
  registrationFieldStates, registrationFieldDefaultsForKind,
  EVENT_COLLECTIVE, EVENT_KINDS, DEFAULT_KIND,
  eventKind, eventKindLabel, eventKindPhrase,
  eventPolicy, eventPolicyForWire, eventKindsForWire,
  autoEndOnAllSolvedApplies,
  lateEntryDefaultForKind,
  clockStartsAtFirstOpen, clockStartDefaultForKind,
};
