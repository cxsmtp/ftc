// CxOne identity matching — WHICH Keycloak account is this participant?
//
// v8.3.17 (external audit) — extracted as a PURE module, with no `db` and no
// `http` edge, so the whole decision matrix can be unit-tested at module scope.
// That is the `lib/scanner-classify.js` precedent, and it matters here for a
// specific reason: the existing CxOne regression lock is SOURCE-only, because the
// outbound-host allowlist refuses a localhost IDP, so nothing behavioural could
// reach this decision at all.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS REPLACES
// ═══════════════════════════════════════════════════════════════════════════
//
// The search accepted a candidate on:
//
//   u.username?.toLowerCase() === preferredUsername.toLowerCase()
//     || u.email?.toLowerCase() === user.email.toLowerCase()
//
// — so a USERNAME match alone was enough, with no regard for the email. The
// username being matched is a Hack Arena NICKNAME, which is unique only inside
// this deployment and says nothing whatever about the customer's CxOne realm.
// The realm is the customer's live Checkmarx One tenant and already contains
// their employees.
//
// **IT IS PARTICIPANT-TRIGGERABLE, which is the part that decides the severity.**
// `PUT /api/me` lets a participant change their nickname freely (charset check,
// 409 if currently taken), and `uq_users_nickname_nocase` constrains only the
// CURRENT value. So a participant who knows any username in the customer's realm
// can adopt it, join any CxOne-enabled competition, and have THAT account added
// to the competition's group. No admin action and no race.
//
// It also happens by accident, which is the common case: `admin`, `security`,
// `test`, or an ordinary handle that collides with an employee's username. And it
// is reachable with no external tenant at all — participant A is provisioned as
// `alice`, renames, participant B registers as `alice`, and B binds to A's CxOne
// account.
//
// It is STICKY: the matched username is written back to
// `competition_users.cxone_username`, so every later provisioning re-derives the
// same wrong `preferredUsername` and re-finds the same wrong account.
//
// **WHAT IT IS NOT:** provisioning sets no credential and reads nothing back, so
// nobody is impersonated and nothing is disclosed to whoever triggered it. It is
// an integrity violation in the customer's tenant plus a false audit record —
// filed MEDIUM, not the privilege escalation "grant access" implies.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE RULE
// ═══════════════════════════════════════════════════════════════════════════
//
// An email match is proof: the address is the identity this platform verified.
// A username match is proof ONLY when this platform established that binding
// itself — which is exactly what `competition_users.cxone_username` records.
//
// ═══════════════════════════════════════════════════════════════════════════
// v8.3.34 (external audit) — "THE ADDRESS THIS PLATFORM VERIFIED" WAS TAKING
// AN UNVERIFIED ADDRESS AT ITS WORD
// ═══════════════════════════════════════════════════════════════════════════
//
// v8.3.17 fed this classifier EVERY address the participant owns, primary and
// secondary, and treated all of them as top-tier proof. But `secondary_email`
// is set by `PUT /api/me` and stored directly: nothing anywhere confirms it.
// The primary is staged in `pending_email` and only committed once the holder
// clicks the emailed link; the secondary has no such round trip.
//
// So F1's own attack survived its fix, at the cost of one extra input the
// attacker usually already has. Set nickname = the victim's realm username AND
// secondary_email = the victim's realm address, and the username query returns
// the victim's account, `owned` contains the asserted address, and the
// classifier calls it proof. Worse in a realm that uses email-as-username (the
// common Checkmarx One shape): `_nicknameCharsOk` is printable ASCII, which
// admits `@` and `.`, so the nickname CAN BE the address and one input does it.
//
// The fix is a proof STANDARD, not a longer address list. Callers now pass two
// buckets and the unproven one gets its own quality, deliberately OUTSIDE
// `CXONE_ACCEPTABLE_BASES`:
//
//   emails         — PROVEN. The verified primary, and nothing else.
//   assertedEmails — CLAIMED but unconfirmed: the secondary, plus the primary
//                    of an account that has not verified yet.
//
// THIS IS A STATED BEHAVIOUR CHANGE, not a free hardening. Where an admin
// pre-created the CxOne user under the participant's nickname carrying their
// CORPORATE (secondary) address, provisioning succeeded before and is refused
// now. That case is indistinguishable from the attack by construction — which
// is the honest reason to refuse it — so the refusal names the remedy instead
// of pretending nothing was lost.
//
// `unverified_email` exists rather than simply dropping the secondary from the
// list because a bare drop would make that candidate fall through to
// `conflict`, whose message ("that username belongs to a different identity")
// misdescribes what happened — the FROZEN_REMEDY class this repo already names.
//
// That second arm is not a concession, it is what keeps the v6.x username-
// stability feature working: a participant who changes their Hack Arena email
// after provisioning still has to resolve to the CxOne account we created for
// them, whose address is now the old one. Requiring an email match "full stop"
// would refuse them, and would refuse every realm user with no email at all.
//
// A username match with a DIFFERENT email and no prior binding is the collision.
// It is refused.

/** Lower-case a value that may be null/undefined, returning "" so comparisons are total. */
const _lc = (v) => (typeof v === "string" ? v.toLowerCase() : "");

/**
 * Classify one Keycloak candidate against the participant we are provisioning.
 *
 * @param {{username?: string, email?: string}} candidate  a Keycloak user record
 * @param {object}   ctx
 * @param {string}   ctx.preferredUsername  the username we tried to create
 * @param {string[]} ctx.emails             PROVEN addresses only — the primary of
 *                                          a VERIFIED account. Scope, corrected
 *                                          in v8.3.35: `verified` attests that
 *                                          the account proved SOME address it
 *                                          holds (the verification mail goes to
 *                                          primary and secondary alike), not
 *                                          that this exact slot was confirmed.
 *                                          Strictly stronger than "any address
 *                                          they typed"; not per-address proof,
 *                                          which no column records.
 * @param {string[]} [ctx.assertedEmails]   CLAIMED but unconfirmed: the
 *                                          secondary slot, and the primary of an
 *                                          account that has not verified yet.
 *                                          Never a basis to bind on.
 * @param {boolean}  ctx.hasPriorBinding    this platform has previously bound
 *                                          THIS user to THAT username
 * @returns {"email"|"prior_binding"|"unverified_email"|"conflict"|"unverifiable"|null}
 *   The first two are ACCEPTABLE bases. The rest are candidates we found and
 *   refuse to use; `null` is "not this person at all".
 */
function cxOneMatchQuality(candidate, { preferredUsername, emails, assertedEmails, hasPriorBinding }) {
  if (!candidate) return null;
  const candEmail = _lc(candidate.email);
  const proven = new Set((emails || []).map(_lc).filter(Boolean));
  const asserted = new Set((assertedEmails || []).map(_lc).filter(Boolean));

  // 1. THE ADDRESS IS THE IDENTITY — when this platform verified it. Checked
  //    first and independently of the username, so the legitimate "same human,
  //    different CxOne username" case still resolves.
  if (candEmail && proven.has(candEmail)) return "email";

  const usernameEqual = !!candidate.username && _lc(candidate.username) === _lc(preferredUsername);
  const assertedMatch = !!candEmail && asserted.has(candEmail);

  // 2. AN ADDRESS THEY MERELY CLAIM. Reported precisely — the operator needs to
  //    know the account was FOUND and refused for want of proof, which is a
  //    different remedy from a username collision. Refused whether or not the
  //    username also matches, and checked before `prior_binding` only when the
  //    username does NOT match (a prior binding is proof in its own right).
  if (!usernameEqual) return assertedMatch ? "unverified_email" : null;

  // 3. OUR OWN PRIOR BINDING. `competition_users.cxone_username` was written by a
  //    previous successful provisioning of THIS participant, so the username is
  //    a key this platform issued rather than one it guessed from a nickname.
  if (hasPriorBinding) return "prior_binding";

  if (assertedMatch) return "unverified_email";

  // 4. The username matches, the candidate carries an address, and it is not one
  //    of ours. That is a different human.
  if (candEmail) return "conflict";

  // 5. The username matches and the candidate has NO address at all, so nothing
  //    can corroborate it. Refused, and named separately from `conflict` because
  //    the operator's remedy differs: a realm that legitimately stores emailless
  //    users needs the participant provisioned under a distinct username, not a
  //    collision investigated.
  return "unverifiable";
}

/** The bases on which a candidate may actually be used. */
const CXONE_ACCEPTABLE_BASES = new Set(["email", "prior_binding"]);

/**
 * v8.8.15 — WHICH REALM GROUP DID THE OPERATOR MEAN?
 *
 * Provisioning adds a participant to a named Keycloak group. Until now the
 * comparison was `g.name === groupName`, case-SENSITIVE — while the realm
 * search that produced `groups` is case-INSENSITIVE — so an operator who typed
 * `hackathon-2026` where the realm holds `Hackathon-2026` got a user account
 * with NO GROUP ACCESS. Silently, until v8.3.17 made the outcome truthful; a
 * case typo in an admin form is an ordinary event, not an exotic one.
 *
 * v8.3.17 recorded the fold as deferred rather than doing it, for one specific
 * reason: a realm holding TWO groups differing only in case would have the
 * platform pick one and give the operator no way to express the other. That is
 * what this shape answers, and it is why the answer is three-valued rather than
 * a `toLowerCase()` on both sides:
 *
 *   * an EXACT match always wins, so the realm above is fully addressable —
 *     type the name exactly and you get exactly it;
 *   * the fold is consulted ONLY when nothing matched exactly, so it can add a
 *     result and can never change one;
 *   * an AMBIGUOUS fold is REFUSED, not resolved. Two groups differing only in
 *     case are two different access grants, and guessing between them is how a
 *     participant ends up in the wrong customer's cohort. The caller reports it
 *     with the count so the operator knows to type one of them exactly.
 *
 * PURE, and it walks `subGroups` because Keycloak groups nest and the caller
 * always did. Returns `{group, matchedIgnoringCase, ambiguousCount}`; `group`
 * is null when there is no answer, and `ambiguousCount` says which kind of
 * "no answer" it was.
 */
function resolveCxOneGroup(groups, groupName) {
  const none = { group: null, matchedIgnoringCase: false, ambiguousCount: 0 };
  if (typeof groupName !== "string" || !groupName) return none;

  const walk = (list, pred, out) => {
    for (const g of Array.isArray(list) ? list : []) {
      if (g && pred(g)) out.push(g);
      if (g && Array.isArray(g.subGroups) && g.subGroups.length) walk(g.subGroups, pred, out);
    }
    return out;
  };

  const exact = walk(groups, g => g.name === groupName, []);
  if (exact.length) return { group: exact[0], matchedIgnoringCase: false, ambiguousCount: 0 };

  const lc = groupName.toLowerCase();
  const ci = walk(groups, g => typeof g.name === "string" && g.name.toLowerCase() === lc, []);
  if (ci.length === 1) return { group: ci[0], matchedIgnoringCase: true, ambiguousCount: 1 };
  if (ci.length > 1) return { group: null, matchedIgnoringCase: false, ambiguousCount: ci.length };
  return none;
}

// ═══════════════════════════════════════════════════════════════════════════
// HAS THE TENANT TAKEN AN ACCOUNT THIS PLATFORM CREATED INTO USE?
// ═══════════════════════════════════════════════════════════════════════════
//
// The withdrawal runner (lib/cxone-withdraw.js, step 8) removes an account the
// platform created for a participant since deleted — unless the tenant has put
// it to use outside this platform, when it holds it (`adopted_by_tenant`) for a
// superadmin's decision. The sign-in link, address and group signals are read
// there; the rules for the account's ROLES, DETAILS and CREDENTIALS are here,
// pure, so the whole table is unit-tested at module scope.
//
// THE TABLE (operator rulings, 19 Oct 2026). HOLDS, each a `signal`:
//   role_mapping           a direct REALM role that is neither the realm's
//                          default role (by the id the baseline recorded, else
//                          by name) nor in the creation baseline; any direct
//                          CLIENT role not in the baseline
//   default_role_removed   the realm's default role taken off the account, and
//                          the baseline does not say it lacked one at creation.
//                          An empty `realmMappings` is THIS, never "unreadable":
//                          a key that can remove users sees every ordinary role
//   attribute              a user attribute key only an administrator can set
//   credential_after_deletion  a credential created after the deletion was
//                          scheduled (`pending_since`)
// DOES NOT HOLD — ordinary self-use: a password, one-time code, passkey or
// recovery codes the account already had; required actions; `enabled=false`
// (Keycloak's own permanent lockout sets it); `emailVerified`; `totp`; consents
// and offline sessions (a Checkmarx One API key is the user's own).
// NOT READ: composite and group roles (groups are judged as groups), and
// Checkmarx One's own Access Management assignments (CLAUDE.md, F2 residuals).
//
// Every reader answers `malformed` for a body it cannot vouch for: a failed or
// partial read is never "nothing there".

const _isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** Keycloak names a realm's default role `default-roles-<realm, lowercased>`; a
 *  realm imported over a clash gets `-<digits>` on the end. */
const REALM_DEFAULT_ROLE_PREFIX = "default-roles-";
function isRealmDefaultRoleName(name, tenant) {
  if (typeof name !== "string" || !name || typeof tenant !== "string" || !tenant) return false;
  const base = REALM_DEFAULT_ROLE_PREFIX + tenant.toLowerCase();
  return name === base || (name.startsWith(base + "-") && /^\d+$/.test(name.slice(base.length + 1)));
}

// The shape check shared by the classifier and the baseline: the direct realm
// mappings and the flattened direct client mappings, or null when malformed.
function _roleLists(body) {
  if (!_isObj(body)) return null;
  const { realmMappings, clientMappings } = body;
  if (realmMappings !== undefined && !Array.isArray(realmMappings)) return null;
  if (clientMappings !== undefined && !_isObj(clientMappings)) return null;
  const realm = realmMappings || [];
  if (!realm.every(_isObj)) return null;
  const client = [];
  for (const entry of Object.values(clientMappings || {})) {
    if (!_isObj(entry)) return null;
    if (entry.mappings !== undefined && !Array.isArray(entry.mappings)) return null;
    for (const m of entry.mappings || []) { if (!_isObj(m)) return null; client.push(m); }
  }
  return { realm, client };
}

/**
 * GET /users/{id}/role-mappings, judged against the creation baseline
 * (`parseCreationBaseline`, or null). Answers `{verdict}`:
 *   "malformed" | "role_mapping" | "default_role_removed" | "clean".
 * A role with no string id is never explained.
 */
function classifyRoleMappings(body, { tenant, baseline } = {}) {
  const lists = _roleLists(body);
  if (!lists) return { verdict: "malformed" };
  const b = baseline || null;
  // The default role is the id the baseline recorded, when it knows one — a role
  // that merely carries the name is then an ordinary role; else Keycloak's name.
  const knownId = b && typeof b.defaultRoleId === "string" ? b.defaultRoleId : null;
  const isDefault = (r) => (knownId ? r.id === knownId : isRealmDefaultRoleName(r.name, tenant));
  // A part of the baseline that is unknown (null) explains nothing.
  const inBase = (part, r) => typeof r.id === "string" && !!part && part.has(r.id);
  const realmForeign = lists.realm.some((r) => !(isDefault(r) || inBase(b && b.realm, r)));
  const clientForeign = lists.client.some((r) => !inBase(b && b.client, r));
  if (realmForeign || clientForeign) return { verdict: "role_mapping" };
  // Does it still hold the default role? Found as above; or explained by a
  // baseline that read the account at creation and found no realm role at all;
  // or — the baseline read its realm roles but none bore the default's name (a
  // realm renamed since its default role was made; Keycloak gives every new
  // account that role) — it still holds EVERY realm role it had then. Anything
  // else, an unknown baseline included, is the default role taken away.
  const ids = new Set(lists.realm.map((r) => r.id));
  const present = lists.realm.some(isDefault) || (!!b && b.hadDefaultRole === false)
    || (!knownId && !!b && b.hadDefaultRole === null && !!b.realm && b.realm.size > 0 && [...b.realm].every((id) => ids.has(id)));
  return { verdict: present ? "clean" : "default_role_removed" };
}

/**
 * GET /clients?clientId=realm-management, the proof that the key sees every
 * role an account can carry (on Keycloak builds that hide role mappings a key
 * may not view, the realm-management admin roles are what it would miss).
 * POSITIVE: true only for that client with `access.view === true`; a missing
 * `access` is not visible. null for a body that is not an array.
 */
function realmManagementVisible(body) {
  if (!Array.isArray(body)) return null;
  return body.some((c) => _isObj(c) && c.clientId === "realm-management" && _isObj(c.access) && c.access.view === true);
}

// Attribute keys that are not the tenant administrator's doing: the root fields,
// and what Keycloak itself writes from the user's own use (a language choice, a
// lockout's reason, a SAML persistent id, accepting the terms).
const ROOT_ATTRIBUTES = new Set(["username", "email", "firstName", "lastName"]);
const KC_WRITTEN_ATTRIBUTES = new Set(["locale", "disabledReason", "terms_and_conditions"]);
const KC_WRITTEN_ATTRIBUTE_PREFIXES = Object.freeze(["saml.persistent.name.id.for."]);

/** The attribute KEYS (values are never read) that nothing above and nothing in
 *  the baseline explains, sorted: `{keys}`, or `{malformed: true}`. */
function unexplainedAttributeKeys(attributes, baseline) {
  if (attributes === undefined || attributes === null) return { keys: [] };
  if (!_isObj(attributes)) return { malformed: true };
  const attrs = baseline && baseline.attrs;
  const keys = Object.keys(attributes).filter((k) => !ROOT_ATTRIBUTES.has(k) && !KC_WRITTEN_ATTRIBUTES.has(k)
    && !KC_WRITTEN_ATTRIBUTE_PREFIXES.some((p) => k.startsWith(p)) && !(attrs && attrs.has(k)));
  return { keys: keys.sort() };
}

/**
 * Which of `keys` only an administrator can set, by the realm's user profile
 * (GET /users/profile; `null` when it could not be read — then every key
 * stands). Answers `{keys}`, or `{malformed: true}` for a profile this cannot
 * vouch for (FAIL CLOSED, never "all editable"):
 *   • a declared attribute is the user's to edit only with "user" in its
 *     `permissions.edit`;
 *   • an undeclared one follows `unmanagedAttributePolicy`: ENABLED — the user
 *     edits it; ADMIN_VIEW — nobody writes it through the API, so not a hold;
 *     ADMIN_EDIT — the administrator's; absent or anything else — held.
 */
function adminOnlyAttributeKeys(keys, upConfig) {
  const list = Array.isArray(keys) ? keys : [];
  if (upConfig === null) return { keys: [...list] };
  if (!_isObj(upConfig)) return { malformed: true };
  const { attributes, unmanagedAttributePolicy: policy } = upConfig;
  if (attributes !== undefined && !Array.isArray(attributes)) return { malformed: true };
  if (policy !== undefined && policy !== null && typeof policy !== "string") return { malformed: true };
  const managed = new Set(), userEditable = new Set();
  for (const a of attributes || []) {
    if (!_isObj(a) || typeof a.name !== "string" || !a.name) return { malformed: true };
    managed.add(a.name);
    if (_isObj(a.permissions) && Array.isArray(a.permissions.edit) && a.permissions.edit.includes("user")) userEditable.add(a.name);
  }
  return { keys: list.filter((k) => managed.has(k) ? !userEditable.has(k) : !(policy === "ENABLED" || policy === "ADMIN_VIEW")) };
}

/** GET /users/{id}/credentials: how many were created after `sinceMs` (the
 *  deletion), or `{malformed: true}` — including a credential with no creation
 *  time, which cannot be shown to predate it. */
function credentialsCreatedAfter(body, sinceMs) {
  if (!Array.isArray(body) || !Number.isFinite(sinceMs)) return { malformed: true };
  let count = 0;
  for (const c of body) {
    if (!_isObj(c) || !Number.isFinite(c.createdDate)) return { malformed: true };
    if (c.createdDate > sinceMs) count++;
  }
  return { count };
}

// THE CREATION BASELINE — what the account carried when the job that created it
// finished, so the runner does not mistake the realm's own creation-time
// defaults for the tenant's later doing. Role IDS and attribute NAMES only, and
// whether (and as which id) it held the realm's default role: no value, name or
// address. Each part is null when it could not be read or breaks a cap; then the
// runner judges that part by the rules alone, which can only hold more.
const BASELINE_MAX_ENTRIES = 64;
const BASELINE_MAX_STRING = 128;
const _capped = (xs) => (Array.isArray(xs) && xs.length <= BASELINE_MAX_ENTRIES
  && xs.every((x) => typeof x === "string" && x.length >= 1 && x.length <= BASELINE_MAX_STRING) ? xs : null);

function buildCreationBaseline({ userRep, roleMappings, tenant } = {}) {
  const lists = roleMappings === undefined ? null : _roleLists(roleMappings);
  const realm = lists ? _capped(lists.realm.map((r) => r.id)) : null;
  const client = lists ? _capped(lists.client.map((r) => r.id)) : null;
  let defaultRole = null;
  if (realm) {
    // None bearing the default's name: `false` ("had none") only when it carried
    // no realm role at all; otherwise the default is one of them, unknown which.
    const d = lists.realm.find((r) => isRealmDefaultRoleName(r.name, tenant));
    defaultRole = d ? d.id : (realm.length ? null : false);
  }
  const attrs = _isObj(userRep) && (userRep.attributes === undefined || userRep.attributes === null || _isObj(userRep.attributes))
    ? _capped(Object.keys(userRep.attributes || {})) : null;
  if (!realm && !client && !attrs) return null;
  return JSON.stringify({ v: 1, realm, client, attrs, default_role: defaultRole });
}

/** The stored baseline, as Sets (`realm`, `client`, `attrs`, each null when
 *  unknown) plus `defaultRoleId` and `hadDefaultRole` (true / false / null).
 *  null for anything it cannot vouch for. Never throws. */
function parseCreationBaseline(text) {
  if (typeof text !== "string") return null;
  let o;
  try { o = JSON.parse(text); } catch (_) { return null; }
  if (!_isObj(o) || o.v !== 1) return null;
  const set = (xs) => { const c = _capped(xs); return c ? new Set(c) : null; };
  const realm = set(o.realm);
  const dr = o.default_role;
  const known = !!realm && (dr === false || (typeof dr === "string" && realm.has(dr)));
  return { realm, client: set(o.client), attrs: set(o.attrs),
    defaultRoleId: known && typeof dr === "string" ? dr : null, hadDefaultRole: known ? dr !== false : null };
}

module.exports = {
  cxOneMatchQuality, CXONE_ACCEPTABLE_BASES, resolveCxOneGroup,
  // has the tenant taken an account we created into use?
  isRealmDefaultRoleName, classifyRoleMappings, realmManagementVisible,
  unexplainedAttributeKeys, adminOnlyAttributeKeys,
  credentialsCreatedAfter, BASELINE_MAX_ENTRIES, BASELINE_MAX_STRING, buildCreationBaseline, parseCreationBaseline,
};
