"use strict";

// v8.7.0 — THE EVENT-ADMIN SCOPE. One module, one set of predicates, one answer
// to "may this actor touch this row".
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE, AND WHY IT IS TWO FACTS RATHER THAN ONE
//
// `users.role='event_admin'` is the TIER — it is what `requireAdmin` admits and
// what `requireSuperAdmin` refuses. `competition_admins` is the SCOPE — which
// events that tier may act on. Neither is derivable from the other:
//
//   role='event_admin', zero grants  → a coherent, FAIL-CLOSED state. Every list
//                                      is empty, every predicate refuses. This is
//                                      what removing somebody's last event leaves
//                                      behind, deliberately (see ROLES_AND_PERMISSIONS.md
//                                      §8): auto-demoting would let a regular admin
//                                      perform a superadmin action (a role change)
//                                      as a side effect of a scoped one.
//   role='admin', rows present       → inert. A global admin already sees
//                                      everything, so the rows grant nothing.
//
// Both drift directions are therefore safe, which is the property that lets the
// two writers (the grant route and the role route) be independent.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT A GLOBAL GUARD, AND WHY THERE IS A GLOBAL GUARD ANYWAY
//
// `impersonationGuard` (lib/impersonation.js) can be global because its question
// is answerable from the PATH alone: "may this session make a write at all?" It
// never resolves an entity.
//
// This is not that shape. The question is "is this actor entitled to the entity
// this request names", and the entity id lives in `req.params` on some routes,
// `req.query` on others (`?competitionId=`), and `req.body` on the bulk ones —
// and on a LIST route there is no entity at all, only a filter. A global guard
// would have to re-implement every route's parameter extraction, which is the
// "prose cannot enumerate" failure written in code.
//
// So the split is: `eventAdminGuard` (below) answers "may this actor call this
// ENDPOINT at all", from a DEFAULT-DENY allow-list keyed on the route; the
// handler answers "on which ROWS". The guard is what makes the rest safe to land
// incrementally — at every intermediate commit an unclassified admin route is
// REFUSED, not silently open — and it is what makes a route added next year, by
// someone who has never heard of this role, fail closed until somebody decides.
//
// Deps: `../db` (lazily — `lib/middleware.js` imports this module, and requiring
// db at module scope here would be fine today but the lazy shape is the
// `lib/impersonation.js` precedent and costs nothing). It deliberately does NOT
// import `lib/competitions.js`: the answers here are pure membership, and pulling
// in the competition helpers would close a cycle with `lib/middleware.js`.

// RBAC — "is this role scoped by competition_admins grants?" is its CLASS
// (`granted`), so a custom scoped role inherits every predicate in this module
// exactly as the built-in event admin does. Resolved lazily: lib/rbac.js
// requires this module back.
function _isGrantedClass(role) { return !!role && require("./rbac").roleClass(role) === "granted"; }

// The reserved task tag that makes a challenge visible to EVERY event admin.
// Declared ONCE, here. Hyphenated rather than spaced because task tags are
// lowercased but not re-trimmed on write, so a space is fragile to type and
// awkward as a filter chip.
//
// v8.8.3 — IT HAS A CLIENT MIRROR, and the comment here used to deny it. v8.8.2
// put PUBLIC_DOMAIN_TAG in public/js/ui/format.js so the Add Tag chip could apply
// the exact value, which made it a member of the client/server mirror family; the
// sentence claiming "no client mirror, so no mirror can drift" survived that
// release and read as a reason not to go looking for one.
const PUBLIC_DOMAIN_TAG = "public-domain";

// The confusable key: everything that is not a lowercase alphanumeric removed.
// `public-domain`, `public domain`, `public_domain`, an EN DASH, a SOFT HYPHEN
// and a bare `publicdomain` all collapse onto it.
const _PD_KEY = PUBLIC_DOMAIN_TAG.replace(/[^a-z0-9]/g, "");

/**
 * v8.8.3 — is this tag a NEAR MISS of the reserved one?
 *
 * True when the tag collapses onto `public-domain` without being byte-equal to
 * it. The visibility rule matches by exact equality in SQL, so every one of these
 * is stored, rendered on the challenge row as an ordinary tag chip, and grants
 * NOTHING — accept-and-ignore, which this codebase holds to be worse than no
 * control at all.
 *
 * MEASURED against a real server at v8.8.2: space, underscore, EN DASH, EM DASH,
 * NON-BREAKING HYPHEN, MINUS SIGN, FIGURE DASH, FULLWIDTH HYPHEN, NBSP, SOFT
 * HYPHEN and ZERO-WIDTH SPACE are every one accepted with 200 and inert. THE LAST
 * TWO RENDER PIXEL-IDENTICALLY TO THE RESERVED VALUE, so an operator can read
 * `public-domain` on the row and have it do nothing, with nothing on any screen
 * able to tell them otherwise. That is why the guard is at the WRITE rather than
 * a hint in one dialog: a client-side warning is invisible to the importer, and
 * can do nothing for a row that already carries one.
 *
 * NOT A NORMALISING FOLD, and the distinction is the whole decision. v8.8.2
 * refused to make `public domain` MEAN `public-domain`, because that silently
 * grants platform-wide visibility to a challenge somebody labelled descriptively
 * — a widening in the wrong direction. Refusing is the safe direction: nothing is
 * widened and nothing is ignored. The cost is stated rather than hidden —
 * `public domain` stops being available as an ordinary descriptive label, and the
 * refusal says so in words.
 */
function publicDomainNearMiss(tag) {
  if (typeof tag !== "string") return false;
  const t = tag.toLowerCase();
  if (t === PUBLIC_DOMAIN_TAG) return false;
  return t.replace(/[^a-z0-9]/g, "") === _PD_KEY;
}

// The refusal, worded ONCE and shared by all three write paths. It is rendered to
// an operator who has just typed something that looks right, so it names the
// reserved spelling AND the control that applies it — FROZEN_REMEDY: an
// instruction naming no reachable control is worse than none.
const PUBLIC_DOMAIN_NEAR_MISS_ERROR =
  `That is not the reserved "${PUBLIC_DOMAIN_TAG}" tag — it differs by a separator or an invisible ` +
  `character, so it would be stored as an ordinary label and would make the challenge visible to ` +
  `nobody. Use the "${PUBLIC_DOMAIN_TAG}" chip in the Add Tag dialog to apply the real one.`;

let _db = null;
function db() { if (!_db) _db = require("../db"); return _db; }

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The acting user's id, or null for the built-in superadmin (which has no
 * `users` row). Ownership columns store THIS, never `getAdminIdentity(req)`'s
 * email — see the db.js migration comment for why.
 *
 * UNDER IMPERSONATION THIS IS THE TARGET, and that is the design: what the
 * session may SEE and what it OWNS follow the seat (v8.12.1 — an organiser
 * impersonated in their admin view owns what is created there, and every scope
 * predicate answers about them). The three questions that must be asked about
 * the HUMAN AT THE KEYBOARD instead — who may read a sealed answer, whose
 * competitor rows bind the write, who the audit names — go through
 * `actingAdminId` below, `competitorIds` below (the seat AND the hand), and
 * `getAdminIdentity` respectively. Do not "fix" this one to return the
 * impersonator: ~130 callers want the target, and re-pointing it would refuse
 * an organiser's own challenges in their own impersonated view.
 */
function actorId(req) {
  return (req && req.session && req.session.userId) || null;
}

/**
 * v8.12.1 — the id of the HUMAN making the request: the impersonating admin's
 * own id while impersonating (null for the built-in superadmin, which has no
 * row), else `actorId(req)`.
 *
 * Exists for exactly one family of consumers — the sealed-answer predicates
 * (`lib/answer-seal.js`), whose whole promise is "nobody but the author,
 * superadmins included". Keyed on `actorId` they would admit a superadmin who
 * impersonates the author, in either view — a fifth door into the seal that the
 * v8.10.0 lock never drives. Keyed here, the impersonated seat reads the key
 * only if the person AT the keyboard is the author, which is the rule.
 */
function actingAdminId(req) {
  const imp = req && req.session && req.session.impersonator;
  if (imp) return imp.userId || null;
  return actorId(req);
}

/**
 * v8.12.1 — THE IDS A COMPETITOR ROW MAY BIND, for every `lib/staff-compete.js`
 * predicate: the SEAT (`actorId` — under an impersonated admin view, the
 * organiser, who must be refused exactly as their own panel refuses them) AND
 * the HAND (`actingAdminId` — the admin at the keyboard, whose own compete
 * events must not become reachable through somebody else's seat). The v8.12.0
 * rival ruling binds the PERSON who competes, so a door that asked about the
 * seat alone let a superadmin who competes in event E block a rival, or edit a
 * challenge E holds, by opening the panel of an organiser who runs some OTHER
 * event the rival is also enrolled in — E was never consulted (found by the
 * v8.12.1 pre-release review; the guard's coarse re-ask covers only events the
 * TARGET organises). Off impersonation this is `[actorId]`; for the built-in
 * superadmin it is `[]`, which every predicate answers with "not a competitor".
 * A source scanner forbids `actorId(req)` as a competitor predicate's actor.
 */
function competitorIds(req) {
  const seat = actorId(req);
  const hand = actingAdminId(req);
  const out = [];
  if (seat) out.push(seat);
  if (hand && hand !== seat) out.push(hand);
  return out;
}

// The role is re-read per request, like every other lifecycle predicate in this
// codebase, and cached for 2s on the same terms as the scope below. A session
// flag would go stale across a demotion the way the pre-v6.13.18 admin flags did.
const _roleCache = new Map(); // userId → { ts, role }
const _ROLE_TTL_MS = 2_000;
const _ROLE_MAX = 5_000;

function _cachedRole(userId) {
  const hit = _roleCache.get(userId);
  if (hit && (Date.now() - hit.ts) < _ROLE_TTL_MS) return hit.role;
  const row = db().prepare("SELECT role FROM users WHERE id=?").get(userId);
  const role = row ? (row.role || "participant") : null;
  if (_roleCache.size >= _ROLE_MAX) {
    const oldest = _roleCache.keys().next().value;
    if (oldest !== undefined) _roleCache.delete(oldest);
  }
  _roleCache.set(userId, { ts: Date.now(), role });
  return role;
}

/**
 * v8.12.2 — is the HUMAN making the request a superadmin? The sealed-answer
 * reveal's whole authority, so it is answered from facts a demotion cannot
 * leave behind:
 *
 *   • under impersonation it is the acting admin on the marker — never the
 *     seat (`actorRole` answers `event_admin` through an organiser's panel and
 *     the target's role in the participant view), and never the marker's
 *     `isSuperAdmin` / `userRole` SNAPSHOT, frozen at entry and forbidden as an
 *     authority since v7.21.12;
 *   • the built-in account has no `users` row, so it is answered from
 *     `builtinId` on whichever object carries it (the marker under
 *     impersonation, the session otherwise) BEFORE any row lookup, or a role
 *     read on a null id would deny the operator's own account;
 *   • a user-backed account is answered by an UNCACHED `SELECT role` — the
 *     shape `impersonationGuard` and `requireGlobalAdmin` use, because
 *     `_cachedRole`'s 2 s window is exactly the window a demote-by-SQL test
 *     drives — so a superadmin demoted mid-session stops revealing at once;
 *   • `req.session.isSuperAdmin` is deliberately NOT consulted: it is cleared
 *     by the participant-view toggle and never set on an impersonation
 *     session, so a flag-based answer is false in three of the four shapes a
 *     superadmin can be in.
 */
function actingIsSuperAdmin(req) {
  return actingAdminLiveRole(req) === "superadmin";
}

/**
 * v8.12.6 (review fix) — the LIVE role of the HUMAN making the request, or null.
 *
 * `actingIsSuperAdmin` above is this answer compared with "superadmin"; the role
 * itself is exported because one caller needs more than yes/no. The participant
 * writes a superadmin can make through an impersonated seat re-ask the hand at
 * COMMIT (`impersonatingHandDenied`, lib/middleware.js), and must give the answer
 * `impersonationGuard` gives at the headers: a hand still a live ADMIN but no
 * longer a superadmin is the READ-ONLY tier (refused `impersonation_readonly`,
 * the session kept), which only the role can tell apart from a hand that lost
 * admin access altogether (the session ended). Same facts as the yes/no answer,
 * read once — so no seventh spelling of the admin lifecycle SELECT:
 *   • under impersonation the acting admin on the marker, never the seat;
 *   • the built-in account answered from `builtinId` before any row lookup;
 *   • a user-backed account by the UNCACHED lifecycle read below.
 * Returns the stored role string only when the row passes the lifecycle, so a
 * blocked / denied / unverified / unapproved / missing account is null.
 */
function actingAdminLiveRole(req) {
  const sess = req && req.session;
  if (!sess) return null;
  const imp = sess.impersonator;
  if (imp) {
    if (imp.builtinId === "superadmin") return "superadmin";
    return imp.userId ? _liveRoleOf(imp.userId) : null;
  }
  if (sess.builtinId === "superadmin") return "superadmin";
  const id = actorId(req);
  return id ? _liveRoleOf(id) : null;
}
// The same four lifecycle columns `impersonationGuard` and `requireAdmin`
// re-read, because every predicate that decides what the acting admin MAY DO
// refuses a blocked / denied / unverified / unapproved row — and in an
// impersonated PARTICIPANT view nothing else re-reads the acting admin on a
// GET, so a role-only read here kept a superadmin blocked out-of-band (the
// v7.21.12 class: a participant-import overwrite, or direct SQL) reading sealed
// values through the target, and recording reveals in the name of an account
// the platform otherwise treats as revoked. Found by the pre-release review.
function _liveRoleOf(userId) {
  const row = db().prepare("SELECT role, blocked, denied_at, verified, approved FROM users WHERE id=?").get(userId);
  return (row && !row.blocked && !row.denied_at && !!row.verified && !!row.approved) ? (row.role || null) : null;
}

/**
 * v8.12.2 — the set of challenge ids this session's superadmin has REVEALED,
 * as an object keyed by task id (a plain object, because the SQLite session
 * store serialises JSON and a Set would come back as `{}`). Empty for anyone
 * who is not a superadmin RIGHT NOW: the marker is re-gated on the live role
 * at every read, so a demoted account's stale marker grants nothing.
 */
function sealRevealSet(req) {
  if (!actingIsSuperAdmin(req)) return {};
  const m = req.session.sealedReveals;
  return m && typeof m === "object" && !Array.isArray(m) ? m : {};
}

/** v8.12.2 — has THIS challenge been revealed in this session, by a live superadmin? */
function sealRevealedFor(req, taskId) {
  return !!taskId && sealRevealSet(req)[taskId] === true;
}

/** 'superadmin' | 'admin' | 'event_admin' | 'participant' | null. */
function actorRole(req) {
  if (req && req.session && req.session.builtinId === "superadmin") return "superadmin";
  const id = actorId(req);
  if (!id) return null;
  return _cachedRole(id);
}

/**
 * TRUE only for a genuine event-admin actor — or, since v8.12.1, for the SEAT
 * an impersonation session is sitting in when that seat is an organiser's ADMIN
 * view.
 *
 * THE CARVE-OUT IS KEYED ON THE SESSION'S SHAPE, NOT ON THE MARKER. A
 * participant-shaped impersonation (marker set, `isAdmin` unset) answers false:
 * `req.session.userId` is the TARGET, so a bare role read would answer about
 * the person being impersonated rather than the admin doing it, and the admin
 * surface is unreachable for that session anyway. What such a session may SEE is
 * answered by `impersonatorScopedCompetitionIds` below, which resolves the
 * ACTING admin (v8.8.6). That half must keep returning false, or a
 * participant-shaped session starts being scoped as an admin one and the
 * participant view repaints itself (v8.7.3).
 *
 * An admin-shaped impersonation (marker set, `isAdmin` true — reachable only
 * for an `event_admin` target, entered by a GLOBAL admin) answers about the
 * TARGET, deliberately: the panel on screen is the organiser's, and every
 * predicate that hangs off this one — `scopedCompetitionIds`, every `*Denied`
 * row rule, `eventAdminGuard`'s default-deny classification — must bind the
 * impersonator exactly as it binds the organiser. Keyed on the marker instead,
 * that session would be UNSCOPED and UNCLASSIFIED: a regular admin reading every
 * organiser's rows, a superadmin writing across every event under the event
 * admin's identity. The acting admin's own tier plays no part here — a global
 * admin gains nothing beyond what that organiser sees.
 */
function isEventAdmin(req) {
  if (!req || !req.session) return false;
  if (req.session.impersonator && !req.session.isAdmin) return false;
  return _isGrantedClass(actorRole(req));
}

/**
 * v8.8.6 — WHAT AN IMPERSONATION SESSION MAY SEE, as opposed to what it may DO.
 *
 * `isEventAdmin` above answers about the SEAT and correctly says "no" for a
 * participant-shaped impersonation. That is right for the route gate, whose
 * question is answerable from the path alone — and it is exactly why the
 * participant SURFACE needed a second predicate rather than a relaxation of the
 * first. Flipping the carve-out would re-scope every `/api/admin` read for a
 * participant-shaped session and repaint the participant view (v8.7.3), which
 * is a far larger blast radius than the leak being closed.
 *
 * So this one resolves the ACTING admin from `req.session.impersonator` and
 * answers a different question: which events may this session be shown?
 *
 * v8.12.1 — THE TWO PREDICATES ANSWER ABOUT DIFFERENT PEOPLE BY DESIGN. In an
 * organiser's impersonated ADMIN view `isEventAdmin` / `scopedCompetitionIds`
 * answer about the TARGET (their panel, their grants); this one still answers
 * about the ACTING admin, and for the only tiers admitted to that view — a
 * global admin or the built-in superadmin — that answer is `null`, unscoped. An
 * event admin can never reach another organiser's admin view (`participantDenied`
 * refuses a privileged target for that tier), so a session carrying two scopes
 * at once is unreachable; if that door is ever opened, this is where the
 * decision about which scope wins would otherwise be missed.
 *
 *   null    — not impersonating, or the impersonator is a global admin or the
 *             built-in superadmin. UNSCOPED: their view is unchanged, and every
 *             narrowing in the tree is gated on `!== null` so it stays that way.
 *   []      — an event admin with no grants. They must see NOTHING, and this is
 *             the documented likeliest fail-open in the whole feature: the naive
 *             `ids.length ? narrow : unchanged` shows that actor EVERYTHING.
 *   [ids]   — exactly these.
 *
 * THE ROLE IS RE-READ, NEVER TAKEN FROM THE SNAPSHOT (v7.21.12). `imp.userRole`
 * is frozen at entry, and both the participant-import overwrite and direct SQL
 * change a role with no session invalidation — so a demoted ex-admin would keep
 * an unscoped view for the life of the session. `_cachedRole` and
 * `eventAdminCompetitionIds` both carry short TTLs and `invalidateEventAdminScope`
 * is called by the grant and revoke routes, so a grant revoked mid-session
 * narrows the view on the next request rather than at the next sign-in.
 *
 * The built-in superadmin has no `users` row, so it is answered by the
 * `builtinId` arm before any lookup rather than falling through a null role.
 */
function impersonatorScopedCompetitionIds(req) {
  const imp = req && req.session && req.session.impersonator;
  if (!imp) return null;
  if (imp.builtinId) return null;
  if (!imp.userId) return null;
  if (!_isGrantedClass(_cachedRole(imp.userId))) return null;
  return eventAdminCompetitionIds(imp.userId);
}

/**
 * v8.8.6 — the refusal an impersonation session gets for an event outside the
 * acting organiser's remit. Shares the `{message, code}` shape and the
 * `event_admin_out_of_scope` code with every other refusal in this module, so a
 * client has ONE shape to recognise, and names the organiser rather than the
 * participant — it is the admin who is being refused, not the person whose
 * screen they are looking at.
 */
function impersonationScopeDenied(req, competitionId) {
  const ids = impersonatorScopedCompetitionIds(req);
  if (ids === null) return null;
  if (competitionId && ids.includes(competitionId)) return null;
  return {
    code: "event_admin_out_of_scope",
    message: "You are viewing this participant as an organiser, so you can only open events you organise. This one belongs to somebody else.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scope
// ─────────────────────────────────────────────────────────────────────────────

// Keyed on userId, NEVER on session id: sessions regenerate on login, on
// toggle-admin-view and on impersonation entry, so a session-keyed entry would be
// abandoned at exactly the moments the scope matters. Same 2s/5000 shape as
// lib/user-tags.js — the TTL is the safety net that bounds a missed writer.
const _scopeCache = new Map(); // userId → { ts, ids }
const _SCOPE_TTL_MS = 2_000;
const _SCOPE_MAX = 5_000;

function invalidateEventAdminScope(userId) {
  if (userId) { _scopeCache.delete(userId); _roleCache.delete(userId); }
  else { _scopeCache.clear(); _roleCache.clear(); }
}

/** Every competition id this user is an event admin OF. Order is stable (by id). */
function eventAdminCompetitionIds(userId) {
  if (!userId) return [];
  const hit = _scopeCache.get(userId);
  if (hit && (Date.now() - hit.ts) < _SCOPE_TTL_MS) return hit.ids;
  const ids = db()
    .prepare("SELECT competition_id FROM competition_admins WHERE user_id=? ORDER BY competition_id")
    .all(userId)
    .map(r => r.competition_id);
  if (_scopeCache.size >= _SCOPE_MAX) {
    const oldest = _scopeCache.keys().next().value;
    if (oldest !== undefined) _scopeCache.delete(oldest);
  }
  _scopeCache.set(userId, { ts: Date.now(), ids });
  return ids;
}

/**
 * The actor's competition scope.
 *
 *   null  → UNSCOPED (admin, superadmin, or not an admin actor at all)
 *   []    → an event admin with no grants: sees nothing
 *   [...] → exactly these competitions
 *
 * `null` and `[]` are DIFFERENT ANSWERS and every caller must keep them apart.
 * Collapsing them is the single most likely fail-open in this feature.
 */
function scopedCompetitionIds(req) {
  if (!isEventAdmin(req)) return null;
  return eventAdminCompetitionIds(actorId(req));
}

/**
 * A SQL fragment narrowing `column` to the actor's scope, for splicing into an
 * existing WHERE.
 *
 * THE `1=0` BRANCH IS REQUIRED, NOT DEFENSIVE — but not for the reason it is
 * tempting to give. MEASURED on the shipped SQLite (3.53.4): `IN ()` is ACCEPTED
 * and evaluates FALSE, so an emitted-empty `IN` would in fact be safe here. The
 * hazard is the OTHER shape: the naive `ids.length ? clause : ""` drops the
 * clause entirely and yields an UNFILTERED query for exactly the actor with no
 * grants — the one who must see nothing. `1=0` is chosen over `IN ()` because it
 * is explicit and PORTABLE: standard SQL forbids `IN ()`, so another engine
 * would reject it, and `IN (?)` with no binding throws outright. It has its own
 * test.
 */
function scopeFilterSql(req, column) {
  const ids = scopedCompetitionIds(req);
  if (ids === null) return { clause: "", params: [] };
  if (ids.length === 0) return { clause: " AND 1=0", params: [] };
  return { clause: ` AND ${column} IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(ids)] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Predicates
//
// Every one returns `null` when the action is ALLOWED, or `{ code, message }`
// when it is refused — the `startTimeChangeLock` shape (lib/competitions.js).
// Chosen because the SAME predicate then drives the route's 403 AND the wire flag
// the client renders its offer from, so a control is never offered where the
// server is certain to refuse (v7.14.2).
// ─────────────────────────────────────────────────────────────────────────────

function _deny(code, message) { return { code, message }; }

/** May this actor act on this competition at all? */
function competitionDenied(req, competitionId) {
  const ids = scopedCompetitionIds(req);
  if (ids === null) return null;
  if (competitionId && ids.includes(competitionId)) return null;
  return _deny("event_admin_out_of_scope",
    "You are not an organiser of this event. Ask an administrator to add you to it.");
}

/**
 * Challenge visibility — the three-way rule.
 *   (a) they created it, (b) it is assigned to an event in their scope, or
 *   (c) it carries the public-domain tag.
 * `tags` is optional; when omitted it is read.
 */
function taskViewDenied(req, task, tags) {
  const ids = scopedCompetitionIds(req);
  if (ids === null) return null;
  if (!task) return _deny("event_admin_out_of_scope", "Challenge not found.");
  const me = actorId(req);
  if (me && task.created_by_id === me) return null;
  const tagList = Array.isArray(tags)
    ? tags
    : db().prepare("SELECT tag FROM task_tags WHERE task_id=?").all(task.id).map(r => r.tag);
  if (tagList.includes(PUBLIC_DOMAIN_TAG)) return null;
  if (ids.length && _ownedInScope(task, ids)) return null;
  // A bank question one of their events holds a copy of is "used by an event I run".
  if (ids.length && db().prepare("SELECT 1 FROM tasks WHERE copied_from_task_id=? AND owner_competition_id IN (SELECT value FROM json_each(?)) LIMIT 1").get(task.id, JSON.stringify(ids))) return null;
  if (ids.length) {
    const hit = db()
      .prepare(`SELECT 1 FROM competition_tasks WHERE task_id=? AND competition_id IN (SELECT value FROM json_each(?)) LIMIT 1`)
      .get(task.id, JSON.stringify(ids));
    if (hit) return null;
  }
  return _deny("event_admin_out_of_scope",
    "You can only work with challenges you created, challenges used by one of your events, or public-domain challenges.");
}

/**
 * Is `task` an event-owned question (lib/event-copies.js) of an event in `ids`?
 * Reads the owner when the caller's row did not select it.
 */
function _ownedInScope(task, ids) {
  let owner = task.owner_competition_id;
  if (owner === undefined) owner = (db().prepare("SELECT owner_competition_id FROM tasks WHERE id=?").get(task.id) || {}).owner_competition_id;
  return !!owner && ids.includes(owner);
}

/** Editing is OWNER-ONLY (the author, or an organiser of the event owning it). Global admins bypass ownership entirely. */
function taskEditDenied(req, task) {
  if (scopedCompetitionIds(req) === null) return null;
  if (!task) return _deny("event_admin_not_owner", "Challenge not found.");
  const me = actorId(req);
  if (me && task.created_by_id === me) return null;
  // An EVENT'S OWN question (lib/event-copies.js) is the organisers' of that
  // event: owning the event grants what authorship grants. It is in no other
  // event, so the scoring gate below finds no event outside the scope.
  const ids = scopedCompetitionIds(req);
  if (ids.length && _ownedInScope(task, ids)) return null;
  return _deny("event_admin_not_owner",
    "You can only edit challenges you created. Ask an administrator to change this one.");
}

/**
 * A stricter edit gate for the scoring-relevant fields (correct_answer,
 * answer_type, difficulty, choices, attempt_cap, status, active: the set the
 * ended-session freeze protects, taskFrozenByEndedCompetition).
 *
 * THE HOLE THIS CLOSES: an event admin owns challenge T; a global admin assigns T
 * to competition D, outside their scope. Under a bare owner rule they could then
 * change T's correct answer and re-grade an event they have no remit over.
 *
 * So the scoring fields additionally require that EVERY event holding this
 * challenge is in the actor's scope. Cosmetic fields (title, description,
 * explanation, hint, author, attachments, tags) stay open to the owner, which is
 * the operator's stated rule.
 */
function taskScoringEditDenied(req, task) {
  const owner = taskEditDenied(req, task);
  if (owner) return owner;
  const ids = scopedCompetitionIds(req);
  if (ids === null) return null;
  const holders = db()
    .prepare(`SELECT ct.competition_id AS id, c.name AS name
                FROM competition_tasks ct JOIN competitions c ON c.id = ct.competition_id
               WHERE ct.task_id = ?`)
    .all(task.id);
  const outside = holders.filter(h => !ids.includes(h.id));
  if (!outside.length) return null;
  return _deny("event_admin_scoring_locked",
    `This challenge is also used by "${outside[0].name}", which you do not manage, so its answer and scoring cannot be changed here. Ask an administrator.`);
}

/** Unassigning is limited to assignments THIS actor made. */
function taskUnassignDenied(req, taskId, competitionId) {
  const ids = scopedCompetitionIds(req);
  if (ids === null) return null;
  const scoped = competitionDenied(req, competitionId);
  if (scoped) return scoped;
  const row = db()
    .prepare("SELECT assigned_by_id FROM competition_tasks WHERE competition_id=? AND task_id=?")
    .get(competitionId, taskId);
  if (!row) return _deny("event_admin_not_assigner", "That challenge is not assigned to this event.");
  const me = actorId(req);
  if (me && row.assigned_by_id === me) return null;
  return _deny("event_admin_not_assigner",
    "You can only remove challenges you added to this event. Ask an administrator to remove this one.");
}

/**
 * A participant is visible when they are enrolled in at least one scoped event —
 * AND is not themselves privileged.
 *
 * THE SECOND CLAUSE IS THE PEER-TAMPERING GUARD FOR THIS TIER, and it is not
 * covered by the existing one. Every per-participant route already refuses an
 * `admin` / `superadmin` target for a non-superadmin actor, so those are closed.
 * `event_admin` is a NEW role that guard has never heard of — and two organisers
 * sharing an event is the ordinary case the role was built for, so an event
 * admin could otherwise block, deny, reset the password of, or impersonate a
 * FELLOW organiser merely because that colleague is also enrolled in their
 * event. That is exactly the operational interference the peer-admin doctrine
 * exists to prevent (v7.14.2), reached through a door it does not cover.
 *
 * A GLOBAL admin is unaffected: `ids === null` returns above, so they keep the
 * ability to demote an event admin, which the operator requires.
 *
 * Folded in here rather than added at each call site because this predicate is
 * ALREADY called at every one of them, after the 404 and before the write — a
 * second guard beside it is a second thing to remember at route number eleven.
 */
function participantDenied(req, userId) {
  const ids = scopedCompetitionIds(req);
  if (ids === null) return null;
  if (!userId || !ids.length) {
    return _deny("event_admin_out_of_scope", "That participant is not in any of your events.");
  }
  const hit = db()
    .prepare(`SELECT 1 FROM competition_users WHERE user_id=? AND competition_id IN (SELECT value FROM json_each(?)) LIMIT 1`)
    .get(userId, JSON.stringify(ids));
  if (!hit) return _deny("event_admin_out_of_scope", "That participant is not in any of your events.");
  const role = db().prepare("SELECT role FROM users WHERE id=?").get(userId)?.role || "participant";
  if (role !== "participant") {
    return _deny("event_admin_target_privileged",
      "That account is an organiser or an administrator. Only an administrator can manage it.");
  }
  return null;
}

/** Batch form of participantDenied — the `_privilegedGroupTargets` shape. */
function memberTargetsDenied(req, userIds) {
  const ids = scopedCompetitionIds(req);
  if (ids === null) return null;
  const targets = [...new Set((userIds || []).filter(Boolean))];
  if (!targets.length) return null;
  if (!ids.length) {
    return _deny("event_admin_out_of_scope", "Those participants are not in any of your events.");
  }
  const seen = new Set(db()
    .prepare(`SELECT DISTINCT user_id FROM competition_users
               WHERE competition_id IN (SELECT value FROM json_each(?)) AND user_id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids), JSON.stringify(targets))
    .map(r => r.user_id));
  const outside = targets.filter(u => !seen.has(u));
  if (outside.length) {
    return _deny("event_admin_out_of_scope",
      `${outside.length} of the selected participants are not in any of your events.`);
  }
  // The batch half of participantDenied's peer-tampering clause — see there.
  const privileged = db()
    .prepare(`SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?)) AND role <> 'participant'`)
    .all(JSON.stringify(targets));
  if (privileged.length) {
    return _deny("event_admin_target_privileged",
      `${privileged.length} of the selected accounts are organisers or administrators. Only an administrator can manage them.`);
  }
  return null;
}

/** A group is visible when the actor created it, or it is bound to a scoped event. */
function groupViewDenied(req, groupId) {
  const ids = scopedCompetitionIds(req);
  if (ids === null) return null;
  if (!groupId) return _deny("event_admin_out_of_scope", "Group not found.");
  const me = actorId(req);
  const g = db().prepare("SELECT created_by_id FROM groups WHERE id=?").get(groupId);
  if (!g) return _deny("event_admin_out_of_scope", "Group not found.");
  if (me && g.created_by_id === me) return null;
  if (ids.length) {
    const hit = db()
      .prepare(`SELECT 1 FROM competition_groups WHERE group_id=? AND competition_id IN (SELECT value FROM json_each(?)) LIMIT 1`)
      .get(groupId, JSON.stringify(ids));
    if (hit) return null;
  }
  return _deny("event_admin_out_of_scope", "That group is not used by any of your events.");
}

/**
 * Writing to a group requires EVERY event it is bound to be in scope.
 *
 * THE TRANSITIVE HOLE: groups live-sync into competition membership across every
 * bound competition (`reconcileCompetitionMembership`), so editing a group bound
 * both to your event and to somebody else's would move membership in theirs. This
 * is `_privilegedGroupTargets`' transitive-effect argument one level up. The
 * alternative — scoping the reconciler — would put an authorization concept
 * inside a background fan-out where nothing could hold it.
 */
function groupWriteDenied(req, groupId) {
  const view = groupViewDenied(req, groupId);
  if (view) return view;
  const ids = scopedCompetitionIds(req);
  if (ids === null) return null;
  const bound = db()
    .prepare(`SELECT cg.competition_id AS id, c.name AS name
                FROM competition_groups cg JOIN competitions c ON c.id = cg.competition_id
               WHERE cg.group_id = ?`)
    .all(groupId);
  const outside = bound.filter(b => !ids.includes(b.id));
  if (!outside.length) return null;
  return _deny("event_admin_group_shared",
    `This group is also used by "${outside[0].name}", which you do not manage. Ask an administrator, or create a separate group.`);
}

/**
 * Deleting a group is CREATOR-ONLY **and** subject to the transitive arm above.
 *
 * v8.11.1 (external audit F5) — ownership alone was not enough, and the route's
 * own comment had the ordering backwards. It called creator-only "a stricter
 * rule than groupWriteDenied's", which is true for a NON-owner and false for the
 * owner: a delete cascades `competition_groups` and then runs
 * `reconcileCompetitionMembership` over every competition the group was bound
 * to, so the creator of a SHARED group could drop its members out of an event
 * they do not manage — while a mere RENAME of that same group was correctly
 * refused `event_admin_group_shared`. The louder, irreversible act had the
 * weaker gate.
 *
 * MEASURED: an event admin created a group, a superadmin bound it to a second
 * organiser's event, the rename answered 403 naming that event, and the DELETE
 * answered 200 and removed the victim from it — leaving a `user_removed`
 * `{via:"group_sync"}` row on an event the actor cannot see.
 *
 * Ownership is asked FIRST so a non-owner still gets `event_admin_not_owner`
 * (the cell the event-admin matrix pins); only then does the shared-binding arm
 * apply, which is the same predicate — not a second copy of it — so the two
 * gates cannot drift.
 */
function groupDeleteDenied(req, groupId) {
  const ids = scopedCompetitionIds(req);
  if (ids === null) return null;
  const me = actorId(req);
  const g = db().prepare("SELECT created_by_id FROM groups WHERE id=?").get(groupId);
  if (!g) return _deny("event_admin_not_owner", "Group not found.");
  if (!me || g.created_by_id !== me) {
    return _deny("event_admin_not_owner",
      "You can only delete groups you created. Ask an administrator to delete this one.");
  }
  return groupWriteDenied(req, groupId);
}

/**
 * Which of these competition ids are OUT of scope. Returns [] for an unscoped
 * actor. For the bulk routes, which report a skip ledger rather than refusing.
 */
function outOfScopeCompetitionIds(req, competitionIds) {
  const ids = scopedCompetitionIds(req);
  if (ids === null) return [];
  return [...new Set((competitionIds || []).filter(Boolean))].filter(c => !ids.includes(c));
}


// ─────────────────────────────────────────────────────────────────────────────
// v8.8.4 — SCOPING THE ROWS, NOT ONLY THE ENTITY
//
// Two routes were gated on ONE of the two questions their response asks, and the
// sibling-surface sweep measured both leaking. A gate that answers "may you open
// this challenge?" says nothing about "may you see WHO rated it"; a gate that
// answers "may you see this participant?" says nothing about "may you see WHICH
// EVENTS they appear in". Each fragment below closes the second question.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rows about a USER are visible only when that user shares an event with the
 * actor. `alias` names the `users` row in the caller's query.
 *
 * HOISTED HERE FROM routes/export-import.js, where it was written for the
 * participants export. The challenge-feedback route needed exactly the same
 * fragment, and a second copy is how these drift — the class this codebase keeps
 * paying for. The export keeps its local name and delegates.
 */
function participantVisibilityScope(req, alias = "u") {
  const ids = scopedCompetitionIds(req);
  if (ids === null) return { clause: "", params: [] };
  // `[]` is NOT `null`: an event admin with no grants must match nothing, where
  // an emitted-empty clause would match everything. Same arm as scopeFilterSql.
  if (!ids.length) return { clause: " AND 1=0", params: [] };
  return {
    clause: ` AND EXISTS (SELECT 1 FROM competition_users cu2 WHERE cu2.user_id = ${alias}.id AND cu2.competition_id IN (SELECT value FROM json_each(?)))`,
    params: [JSON.stringify(ids)],
  };
}

/**
 * A `user_events` row is visible to a scoped actor only when every event it
 * names is one they organise — or it names no event at all.
 *
 * ONE definition for every reader of a participant's history: the History
 * dialog (`GET /api/admin/participants/:id/events`) and the person export
 * (`lib/full-export.js`). Both pass the SAME clause; do not filter again in JS.
 *
 * THREE ARMS, because an event is named in more than one way:
 *
 * 1. `details.competition_id` IS NULL or in scope — the original arm. Every
 *    audit blob that names a challenge also names its event here
 *    (`hint_revealed`, `feedback_submitted`, `attempt_grant` carry it beside
 *    `task_title`), so filtering on the event covers challenge titles too.
 *
 * 2. KEYS THAT HOLD AN EVENT ID, decided per key, compared STRICTLY (any
 *    non-null text value outside scope withholds the row, whether or not the
 *    event still exists — a deleted event's id still names it):
 *      - `competition_id` at any depth;
 *      - `cloned_from`, `from_competition_id`, `to_competition_id`, and every
 *        element of a `competition_ids` array (no user event writes these today;
 *        held so a future emit is covered the day it lands);
 *      - `from` / `to` ON `active_competition_changed` ONLY — the pin move's
 *        two ends. On other types `from`/`to` hold roles, addresses or booleans
 *        (`role_changed`, `email_change_confirmed`, `admin_view_toggled`), so a
 *        strict compare there would withhold every one of them.
 *
 * 3. ANY TEXT VALUE ANYWHERE that is the id of an EXISTING event, or of a
 *    session of one, outside scope — the backstop for a key nobody listed.
 *    It cannot see a deleted event's id (arm 2 does, for the listed keys).
 *
 * Over-withholding is the safe direction: a row is withheld, never rewritten.
 *
 * ADMITTING A ROW THAT NAMES NO EVENT IS DELIBERATE, not a fallthrough: those
 * are the account-lifecycle events (created, verified, approved, login_*,
 * password_*, email_change_*) that an organiser legitimately needs about a
 * participant enrolled with them — which is the whole reason this dialog is open
 * to the tier at all. Withholding them would trade a leak for a blind spot.
 *
 * An event NAMED only in free text with no id beside it is not seen here: the
 * one such text, an `email_sent` row's `subject`, is answered by the row
 * recording its event (lib/email.js `sendEmailLogged`'s `about`) and, for a row
 * recorded without one, by `userEventDetailsSql` below.
 *
 * A ROW WHOSE DETAILS CANNOT BE READ (stored text that is not JSON) cannot be
 * judged, as whatever event it names is unknown, so it is withheld (the safe
 * direction); a reader acting on every event still gets it, marked unreadable
 * (lib/audit.js `parseStoredDetails`). The clause is ONE `CASE`, and the arms
 * run only in its `json_valid` branch: a JSON function handed text that is not
 * JSON throws, which failed the whole read, and only a CASE's branches are sure
 * to run one at a time (SQLite evaluates both sides of an AND in a value, and a
 * WHERE's terms in whatever order it plans). No details at all (NULL or "")
 * names no event.
 *
 * It filters in SQL rather than after pagination, so `total` and the page share
 * one scope — filtering the returned array would leave the count describing rows
 * the caller never receives. The clause correlates on the table name
 * `user_events`, so the caller's FROM must not alias it.
 */
const _USER_EVENT_ID_KEYS = Object.freeze(["competition_id", "cloned_from", "from_competition_id", "to_competition_id"]);
function userEventCompetitionScopeSql(req) {
  const ids = scopedCompetitionIds(req);
  if (ids === null) return { clause: "", params: [] };
  const ph = "SELECT value FROM json_each(?)";
  // `[]` (zero grants) is not `null`: every event is out of scope, and an empty
  // `NOT IN ()` is not SQL, so each arm states the empty case itself.
  const outside = ids.length ? (expr) => `${expr} NOT IN (${ph})` : () => "1=1";
  const keyPh = _USER_EVENT_ID_KEYS.map(() => "?").join(",");
  const named = ` AND NOT EXISTS (SELECT 1 FROM json_tree(user_events.details) jt WHERE jt.type = 'text' AND (`
    + `((jt.key IN (${keyPh}) OR jt.path GLOB '*.competition_ids' OR jt.path GLOB '*.\"competition_ids\"'`
    + ` OR (user_events.event_type = 'active_competition_changed' AND jt.path = '$' AND jt.key IN ('from','to'))) AND ${outside("jt.value")})`
    + ` OR jt.value IN (SELECT c.id FROM competitions c WHERE ${outside("c.id")})`
    + ` OR jt.value IN (SELECT t.id FROM competition_timeslots t WHERE ${outside("t.competition_id")})`
    + `))`;
  const first = ids.length
    ? `(json_extract(user_events.details,'$.competition_id') IS NULL OR json_extract(user_events.details,'$.competition_id') IN (${ph}))`
    : "json_extract(user_events.details,'$.competition_id') IS NULL";
  const p = ids.length ? [JSON.stringify(ids)] : [];
  return {
    clause: ` AND (CASE WHEN json_valid(user_events.details) THEN (${first}${named})`
      + " WHEN NULLIF(user_events.details, '') IS NULL THEN 1 ELSE 0 END)",
    params: [...p, ..._USER_EVENT_ID_KEYS, ...p, ...p, ...p],
  };
}

/**
 * THE DETAILS a History reader is shown for a user event (operator ruling,
 * 17 Nov 2026). An `email_sent` row records the event(s) its mail concerns
 * (`competition_id`, null for a mail about none; `competition_ids` for one
 * listing several), so the clause above withholds a mail about another
 * organiser's event. A row recorded without the key (every one before that
 * ruling, or a send that passed nothing) cannot be judged, and its subject can
 * name an event (a certificate, a reminder), so a scoped reader gets it without
 * the subject, marked `subject_withheld`. One SQL expression for every reader
 * (the History dialog, the person export, the Audit page), correlating on the
 * bare table name `user_events` like the clause. Every reader also loses an
 * older certificate revocation's `token` (a certificate's capability).
 *
 * A row whose stored text is not JSON passes through as stored: every rewrite
 * sits in the `json_valid` branch of one CASE (a JSON function would throw on
 * such text and fail the whole read), and the one parser reads the row as
 * unreadable, never showing its text.
 */
function userEventDetailsSql(req) {
  let json = scopedCompetitionIds(req) === null ? "user_events.details"
    : "(CASE WHEN user_events.event_type = 'email_sent' AND json_type(user_events.details, '$.competition_id') IS NULL"
      + " THEN json_set(json_remove(user_events.details, '$.subject'), '$.subject_withheld', json('true'))"
      + " ELSE user_events.details END)";
  // A `badge_revoked` row written before it stopped recording the certificate's
  // token still holds one; no reader is ever shown it, whatever their scope.
  json = `(CASE WHEN user_events.event_type = 'badge_revoked' THEN json_remove(${json}, '$.token') ELSE ${json} END)`;
  return `(CASE WHEN json_valid(user_events.details) THEN ${json} ELSE user_events.details END)`;
}

/**
 * THE SQL FORM of `taskViewDenied`'s three-way rule, for surfaces that LIST
 * challenges (the challenge list and its tag vocabulary in routes/challenges.js,
 * and the challenge-version rows of the Audit page, routes/audit.js). Hoisted
 * here from routes/challenges.js, unchanged, when the second route module needed
 * it: a helper shared by two route modules lives in lib/, and a second copy is
 * how these drift.
 *
 * It has to be SQL rather than a per-row filter because those surfaces
 * AGGREGATE or PAGE over what they select, so narrowing afterwards would leave
 * counts and batch reads computed over rows the actor may not see.
 *
 * It is a deliberate MIRROR of the predicate, one arm per fact (I created it /
 * it is used by an event I run / it is public-domain). The predicate stays the
 * authority for every NAMED entity, which bounds a drift in the safe direction:
 * a wrong arm here HIDES a row the actor could still open directly, never the
 * reverse.
 *
 * EXISTS rather than a JOIN so the query cannot multiply rows: no DISTINCT is
 * needed and the caller's ORDER BY keeps its meaning.
 */
function taskVisibilitySql(req, alias) {
  const ids = scopedCompetitionIds(req);
  if (ids === null) return { clause: "", params: [] };   // unscoped: the old query, unchanged
  const arms = [
    `${alias}.created_by_id = ?`,
    `EXISTS (SELECT 1 FROM task_tags _vt WHERE _vt.task_id = ${alias}.id AND _vt.tag = ?)`,
  ];
  const params = [actorId(req), PUBLIC_DOMAIN_TAG];
  // `[]` is NOT `null`. An event admin with no grants keeps the first two arms
  // and gets no event arm at all; the naive `ids.length ? clause : ""` would drop
  // the WHOLE predicate and show that actor every challenge on the platform,
  // which is the one actor who must see least. (`1=0` is the portable spelling —
  // error, so the arm cannot simply be emitted empty — scopeFilterSql's `1=0`
  // note, one predicate over.)
  if (ids.length) {
    arms.push(`EXISTS (SELECT 1 FROM competition_tasks _vct WHERE _vct.task_id = ${alias}.id AND _vct.competition_id IN (SELECT value FROM json_each(?)))`);
    params.push(JSON.stringify(ids));
    // An event's own question, assigned or not, and a bank question one of the
    // events holds a copy of (lib/event-copies.js).
    arms.push(`${alias}.owner_competition_id IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(ids));
    arms.push(`EXISTS (SELECT 1 FROM tasks _vcp WHERE _vcp.copied_from_task_id = ${alias}.id AND _vcp.owner_competition_id IN (SELECT value FROM json_each(?)))`);
    params.push(JSON.stringify(ids));
  }
  return { clause: ` AND (${arms.join(" OR ")})`, params };
}

module.exports = {
  PUBLIC_DOMAIN_TAG,
  publicDomainNearMiss, PUBLIC_DOMAIN_NEAR_MISS_ERROR,
  participantVisibilityScope, userEventCompetitionScopeSql, userEventDetailsSql, taskVisibilitySql,
  impersonatorScopedCompetitionIds, impersonationScopeDenied,
  actorId, actingAdminId, actingIsSuperAdmin, actingAdminLiveRole, sealRevealSet, sealRevealedFor, competitorIds, isEventAdmin,
  scopedCompetitionIds, scopeFilterSql, eventAdminCompetitionIds, invalidateEventAdminScope,
  competitionDenied, taskViewDenied, taskEditDenied, taskScoringEditDenied, taskUnassignDenied,
  participantDenied, memberTargetsDenied,
  groupViewDenied, groupWriteDenied, groupDeleteDenied,
  outOfScopeCompetitionIds,
};

// ═════════════════════════════════════════════════════════════════════════════
// THE ROUTE GATE NOW LIVES IN lib/rbac.js
//
// `ADMIN_ROUTE_PERMISSIONS` there decides every `/api/admin/*` route with ONE
// permission, and the built-in event admin's answer follows from its frozen
// permission set. The two maps below are DERIVED from it, for the readers that
// still speak the old dispositions (the classification scanner and
// ROLES_AND_PERMISSIONS.md §3): 'scoped' / 'open' — the role holds the route's
// permission; 'superadmin' — it does not and the route's own guard answers;
// FORBIDDEN — it does not and the gate refuses with the route's reason.
// ═════════════════════════════════════════════════════════════════════════════

const _rbac = require("./rbac");
const EVENT_ADMIN_ROUTES = new Map();
const EVENT_ADMIN_FORBIDDEN = new Map();
for (const [key, { perm, rows }] of _rbac.ADMIN_ROUTE_PERMISSIONS) {
  // A route that refuses inline AFTER its own scope check (the sealed reveal)
  // is reachable for this tier and scoped, whatever the permission says.
  if (_rbac.BUILTIN_ROLE_PERMISSIONS.event_admin.has(perm) || _rbac.INLINE_REFUSAL_ROUTES.has(key)) EVENT_ADMIN_ROUTES.set(key, rows);
  else if (_rbac.EVENT_ADMIN_DENY_COPY.has(key)) EVENT_ADMIN_FORBIDDEN.set(key, _rbac.EVENT_ADMIN_DENY_COPY.get(key));
  else if (_rbac.isSuperOnlyPermission(perm)) EVENT_ADMIN_ROUTES.set(key, "superadmin");
  else EVENT_ADMIN_FORBIDDEN.set(key, _rbac.permissionDeniedCopy(perm));
}
const routeKeyFor = _rbac.routeKeyFor;
const eventAdminGuard = _rbac.permissionGuard;

module.exports.actorRole = actorRole;
module.exports.EVENT_ADMIN_ROUTES = EVENT_ADMIN_ROUTES;
module.exports.EVENT_ADMIN_FORBIDDEN = EVENT_ADMIN_FORBIDDEN;
module.exports.routeKeyFor = routeKeyFor;
module.exports.eventAdminGuard = eventAdminGuard;
