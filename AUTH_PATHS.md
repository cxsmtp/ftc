# Authentication & Sign-up Paths

A step-by-step reference for **every** way an account is created and signed in on
Hack Arena, the emails sent and the resulting account state.

> Developer/operator reference — not a participant guide. The in-app help-drawer
> guides live in `docs/user-guide/`. This file documents the wiring.

**The model in one paragraph.** Every account row has a **sign-in method**
(`users.login_method`, `lib/login-method.js`; operator ruling, 11 Nov 2026): its
**password** (`POST /api/auth/password`) or an **emailed one-time code**
(`POST /api/auth/code/request` → `POST /api/auth/code/redeem`, `routes/auth.js`). Until
the person chooses, the ROLE decides: an unscoped admin role signs in with a password,
every other role with a code; anyone may choose either under Profile → **How you sign
in** (`PUT /api/me/sign-in-method`). **A password never closes the code door**: every
account can always ask for an emailed code ("Email me a code instead"), and that is how a
forgotten password is recovered. The one account with no code door is the **built-in
superadmin**, which has no row and no address: its password is regenerated at every boot
into `DATA_DIR/.superadmin-password`, and it signs in on the ordinary sign-in card by
typing its break-glass username (`POST /api/login`). There is no special sign-in address.
**Only the PRIMARY address signs in**: a secondary address never receives a code, never
redeems one and never takes a password sign-in (operator ruling, 11 Nov 2026). There is
no LinkedIn sign-in or sign-up; accounts it once created sign in like any other. A
registration form cannot be submitted for an address that already belongs to an account:
no address proof is ever minted for one, so `POST /api/register` answers
`403 email_proof_required`; the entry screen sends that account an ordinary sign-in code
instead (§2 A′). Redeeming an EMAILED code verifies the address and, unless
the `require_account_approval` setting is on, approves a pending account; a password
sign-in does neither.

---

## 1. The account model

Every account row (`users` table) carries the gates below. Every **admin request**
re-checks the full lifecycle (a user-backed admin whose `verified`/`approved` is cleared
out-of-band loses access immediately, not at session expiry). **An admin write that keeps
reading after its guard has answered asks once more AT COMMIT** — the challenge-attachment
uploads, the superadmin imports, the at-desk invite (§2 G) and the maintenance seeder. Grep
`adminAuthzDenied(` for the set rather than trusting a count here. It re-reads the account's
lifecycle AND role uncached and checks the session's own revocation tombstone,
synchronously with the first write: a revoked admin gets `403 admin_access_revoked`; a
session that ended mid-request gets `401 admin_session_ended`, whose sentence names no
cause. **A participant write made THROUGH impersonation asks the same questions of the
impersonating admin** (`impersonatingHandDenied`, §3). **A participant write that keeps
awaiting asks them of its own session** (`participantSessionDenied`; grep it — the file
answer's upload read, the certificate mint's render and the sign-in-method change's
bcrypt): the account's lifecycle first, then the tombstone (`401 session_ended`, nothing
stored). A tombstone that cannot be read refuses at commit (fail closed).

| Gate | Meaning | At sign-in |
|------|---------|------------|
| `blocked` | hard-disabled by an admin | no code is sent (`login_code_refused{reason:"account_inactive"}`), a correct code or password is refused; every answer is the uniform 200, and the sign-in-method lookup answers `code` |
| `denied_at` | approval explicitly denied | as `blocked`; an emailed code never approves a denied account |
| `verified` | an address proven | redeeming an EMAILED code sets it; a desk code re-stamps the 48 h grace instead (§6). A password proves no inbox: it never sets `verified`, and after a correct password an unverified account outside its grace is answered `{ok:false, error:"verify_by_code"}` |
| `approved` | admin-approved or auto-approved | redeeming an EMAILED code approves a pending, not-denied account **unless `require_account_approval` is on** (§3); with it on, with a desk code, or with a password, an unapproved account is refused with `{ok:false, error:"pending_approval"}` — disclosed only to someone holding a correct code or password |
| `locked_until` | 10 wrong codes or passwords / 5 min → 1 h lock (`lib/lockout.js`, one owner, account-keyed so guesses spread over many sources still raise the alarm: codes, passwords and a wrong current password at a change share ONE budget) | an alarm, not a bar: a sign-in guess while locked is still checked (a wrong one is not counted again), and a correct code or a correct password is honoured and clears it; the owner is mailed, and the mail says a correct emailed code (or password) still signs in. Each door's rate limits are what bound guessing |
| `failed_login_count` / `failed_login_first` | the sliding window behind `locked_until`; arming the lock leaves the counter standing | — |
| `login_method` | how the account signs in: NULL follows the ROLE (an unscoped admin role, class `all` — the built-in `admin` and `superadmin` and every custom unscoped role — gets `password`; every other role, `code`); `'password'` or `'code'` is the person's own choice (§5). No role change touches a stored choice: a promotion moves only a NULL default. Not exported, so an account the import creates starts at its role's default | `POST /api/auth/sign-in-method` reads it (`effectiveLoginMethod`) to choose the card's next step; the password door accepts only `password` |
| `password_hash` | the bcrypt hash of a password the owner set (§5), or one kept from an installation upgraded from v8.14.x, whose passwords are honoured (operator ruling, 11 Nov 2026). A row created without a password, an imported one included, stores the fixed non-bcrypt placeholder `NO_PASSWORD_HASH` (`lib/util.js`). Never exported, never on the wire | the password door compares against it (one bcrypt for every outcome) |
| `password_set_at` | stamped when a password is set or changed. A password is USABLE only when this is set AND `password_hash` is a bcrypt hash (`hasUsablePassword`), so neither placeholder ever signs anyone in. Never exported, never on the wire | — |
| `secondary_email` | an unconfirmed second address (EMAIL_RULES.md). It counts for the corporate-email rule on profile edits and receives the mails that go to both addresses | **never signs in**: every sign-in door finds the account by PRIMARY address only (`findUserByPrimary`, `lib/account-lookup.js`). An address held only as somebody's secondary is RESERVED: a code request for it sends nothing (no code, no proof) |
| `login_code_hash` / `login_code_at` / `login_code_sends` / `login_code_via` / `login_code_comp_id` | the live sign-in code: sha256 at rest, the window anchored to the FIRST mint, a 3-send cap, how it was DELIVERED (`'email'` verifies, `'desk'` or NULL does not), and the event it is BOUND to (only redeeming it in a browser whose own code request named that event enrols, §3). All five are cleared together, by `clearCode` or the redeem's claim `consumeCode` | — |
| `profile_policy` | the KIND of the event the account was created through (join link, or the desk shortcut with that event chosen); the fallback for the pointer below. **A missing KEY throws** in `_profileMissingFields` | — |
| `registration_competition_id` | the EVENT the account was created THROUGH; the completion gate re-reads that event's CURRENT sign-up form (§8). Written by a join-link sign-up (path C), the desk shortcut when an event is chosen (path G) and a one-shot boot backfill. **No foreign key**, deliberately | — |
| `role` | `participant` / `event_admin` / `admin` / `superadmin`, or a custom role. `event_admin` is an admin TIER; which events it may act on is `competition_admins`. The role's class also decides the default sign-in method (`login_method` above). Matrix: `ROLES_AND_PERMISSIONS.md` | every account sign-in (code or password, through `_signInAs`) sets the session's admin flags from the role; admin tiers get `missing_fields: []` |
| `self_enroll_grace_until` | the 48 h verification grace, stamped by a DESK-code redemption on an unverified account | §6 |
| `linkedin_sub` / `linkedin_last_callback_key` | **legacy, unused** — the removed LinkedIn sign-in's identity binding. Kept so no row changes; `registered_via='linkedin'` rows keep their reaper exemption | — |
| `first_verified_at` | stamped when an account first becomes verified, never cleared (`COALESCE`). Write sites include `/verify`, `/confirm-email`, admin force-verify, an EMAILED code redemption, the sign-up a redeemed proof completes (paths A and B), the participant import, desk-invite and Roles & permissions Add user | exempts the row from the unverified-account reaper (§4b) |

**Single source of truth for the grace classifier:** `verificationGraceState(user)`
(`lib/self-enroll.js`, pure) — consumed by `requireParticipant` (`lib/middleware.js`),
`GET /api/me`, `GET /api/session/status`, `POST /api/session/keepalive`
(`routes/participant.js`), the sign-in answer (`_signInAs`) and the password door's
unverified check, plus a SQL mirror of the
same predicate in `lib/competitions.js` (`ACTIVE_PARTICIPANT_SQL`). A count in prose is
not an enumeration — grep before trusting this line.

**Single source of truth for the sign-in method:** `lib/login-method.js` —
`effectiveLoginMethod(user)` (the stored choice, else `roleDefaultLoginMethod(role)`),
`hasUsablePassword(user)` and `loginMethodWire(user)`. Each throws on a row that lacks its
columns rather than guessing. The wire block is four fields — `login_method`,
`login_method_is_default` (nothing chosen yet), `has_password` and `password_required`
(method `password`, none set) — carried by every account sign-in answer (`_signInAs`: the
code redemption, the password door and the sign-up a redeemed proof completes),
`GET /api/me` and `GET /api/admin/me`. Neither carries it under impersonation (the seat's
credential is not the acting admin's business), so the impersonated profile shows no How
you sign in row. `password_hash` and `password_set_at` never reach a client.

---

## 2. Account-creation paths

Key columns abbreviated: `V`=verified, `A`=approved. **No creation path sets a
password**: every new row, the participant import's included, stores `password_hash =
NO_PASSWORD_HASH`, leaves `password_set_at` NULL and `login_method` NULL.
So no registration has a bcrypt cost, and every new account starts with no usable
password: one whose role defaults to `password` (an unscoped admin) signs in with an
emailed code until it sets one (§5).

**EMAIL FIRST (operator order, 29 Oct 2026, confirmed 17 Nov 2026).** There is one entry screen and no Sign Up
button: the visitor types an address and presses **Continue**. Continue first asks which
step comes next (`POST /api/auth/sign-in-method`, §3): an account that signs in with a
password gets the password box on the card; **every other address** — a code account, a
new work address, a new free-mail address, a reserved one — gets the code step, whose
request (`POST /api/auth/code/request`) answers `{ok:true}` byte-identically for all of
them, with nothing awaiting SMTP. Redeeming the code either signs the account in (§3) or,
for an address with no account, answers `{ok:true, needsProfile:true, email}` and the SPA
opens the sign-up form with the address shown, read-only.

### A. A NEW address — the address proof, then the form
`POST /api/auth/code/request` → `/redeem` → `POST /api/register` — `routes/auth.js`,
`lib/email-proof.js`.

1. **Request.** No account holds the address as its primary, so instead of a user row an
   **address proof** is minted: one `email_proofs` row (`email_norm` PK, the code's
   sha256, `expires_at`, `sends`, `attempts`, `join_comp_id`, `invitation_id`, `origin`,
   `last_sent_at`) and the `email_proof` mail (subject "<platform> — Your sign-in code"; the body says the
   address has no account yet). `issueProof` applies the sign-in code's budgets:
   `LOGIN_CODE_MAX_SENDS` per address per window (first mint + `LOGIN_CODE_TTL_MS`), two of
   them per origin (/24, /64), and the 120 s re-send suppression. **Refused, with nothing
   sent and the same answer** (orphaned `email_proof_refused`, the address's domain and a
   fingerprint, never the address; one IP's refusals are recorded up to the per-IP proof
   budget per 15 minutes and only counted beyond it,
   `hack_arena_email_proof_refusals_unrecorded_total`): a **free-mail** address (`isFreeEmail`) unless a live
   invitation for it rides the request (`invitationId`); an address **reserved** by another
   account (`emailIsTaken`: held as somebody's secondary, or as their pending primary);
   **the per-IP proof budget** spent — `RATE_LIMIT_PROOF_IP_PER_15MIN` proofs per IP per
   15 minutes (default 150; test servers pin 40), audited `reason:"ip_budget"` (operator
   ruling, 11 Nov 2026); a spent per-address budget or suppression. The per-IP budget
   exists because the request limiter is keyed per (IP, address), so a venue NAT does not
   share one bucket, which alone let one source make the platform mail any number of
   distinct new addresses through the SMTP pool every sign-in code shares. It refuses
   SILENTLY, with the same `{ok:true}`, because a 429 for new addresses alone would say
   which addresses have no account. The default is the rate a new account could register
   at before email first (10 a minute per IP). Sign-in codes to existing accounts are not
   charged (each account has its own cap). Trusted networks and `RATE_LIMIT_ALLOWLIST_IPS`
   bypass the budget, as they bypass every limiter, so a booth's walk-up rush from one NAT belongs in the
   event's trusted networks; `RATE_LIMIT_DISABLED` turns it off with the limiters.
   **The proof's send is recorded by fingerprint** (operator
   ruling, 11 Nov 2026): the orphaned `email_sent` row names the address's `to_domain` and
   its `ep_` fingerprint `to_fp` — never the address — and `error:"send_failed"` in place
   of SMTP text, which can quote it, so an anonymous caller cannot write strangers'
   addresses into the audit store.
2. **Redeem.** `redeemProof` compares in constant time; a well-formed wrong code charges an
   attempt and the `LOCKOUT_MAX`-th burns its code (the row, and with it the address's
   send budget, stays until it expires; recorded as `email_proof_burned`); the answer is the wrong-code
   `{ok:false}`. A match **deletes the proof** (single use), **regenerates the session** (a
   planted session id cannot inherit what follows) and puts a grant in it:
   `req.session.emailProof = {email, until: now + EMAIL_PROOF_GRANT_MS (15 min),
   joinCompId, joinLinks, invitationId}`, where `joinCompId` is the proof's event only when this
   browser's own code request for the address named that event, through the event's join
   link as it is now (the session note, §3, read before the regenerate; path C step 1c), and
   `joinLinks` the tags of the join links that request asked through; redeemed in any other
   browser the grant carries no event.
   **No user row is created.** Audited `email_proof_redeemed`.
3. **Register.** `POST /api/register` asks `liveProofGrant(req.session)` **before every
   field check**: no live grant → `403 {code:"email_proof_required"}`, nothing written. The
   account's address **is the grant's** (a body `email` is not used for it); an address an
   account took meanwhile → `409 {code:"email_taken"}`. The short form (operator order,
   29 Oct 2026, confirmed 14 Nov 2026): first and last name, company, job title (required),
   country and timezone (detected by the browser; an undetectable zone becomes `UTC`), City
   and Job function shown but optional, Salutation, Phone and LinkedIn off — unless the
   event's own form says otherwise, which is how an organiser requires more (§8). The
   nickname is not asked: `_suggestNickname` makes a unique `first3_last3NNN` (the rules of
   `GET /api/check-nickname`); a supplied one is still honoured. **No photo at sign-up:**
   `avatar` is a preset picture or absent (`default1`); any other value, a photo or an
   `/api/images/` reference included, is `400 {code:"avatar_not_accepted"}` with nothing
   written (a picture is chosen in the profile afterwards). The body takes the 16 KB
   credential cap, JSON and form-encoded alike (`server.js` `_AUTH_PATHS`).
4. Row inserted: **V=1** (`first_verified_at` = now), **A=1** unless
   `require_account_approval` is on and the sign-up did not come through a live event's join
   link, QR or event code (those are always approved) — then
   A=0 and the answer is `{ok:true, pendingApproval:true, email[, competition_name]}`. The
   grant is spent; an approved account then claims the live invitations to the address
   (`claimInvitationsForAccount`), a held one claims nothing (its first approved emailed-code
   sign-in does). **The invitation is the address's, however the person arrived:** with no
   invitation and no event riding the request (an event whose link closed since, or that
   stopped taking joins, rides nothing), a live invitation addressed to the proven
   address makes this registration path B (approved and enrolled, or waiting with the
   invitation still live, step 3b there — never held with the invitation spent); an invitation id naming ANOTHER address (the person changed the
   address after opening the link) is dropped, not refused.
5. **Signed in at once** (`_signInAs`, the bookkeeping the code redeem and the password
   door share): `stampLoginTimes`,
   the join marker consumed (enrolment through the admission ladder), `regenerate()`,
   `invalidateOtherSessions` with `kickerContext`, `login_success{method:"email_proof"}`,
   `applyAutoResumeToSession`, and the login-shaped answer (`missing_fields` included).

### A′. An EXISTING address
An address an account holds as its PRIMARY. A code account reaches the code step at once;
a password account reaches it through "Email me a code instead" (§3). The request mints an
ordinary **sign-in code** to that primary address (`_sendSignInCode`, which only the code
request calls; §3), bound to the event the request came from (which counts only in a
browser that asked for it, path C step 1). Nothing about the code request's
answer differs from path A. A registration form cannot be submitted for an existing
address at all (no grant is ever minted for one).

### B. Invitation (email) — admin pre-authorised
1. Admin bulk-invites by email (`POST /api/admin/invitations`) → an `invitations` row + an
   invitation email with a `/register?invitation=<id>` link. An **event admin** must name
   one of their own events that can still take people (`400 event_admin_competition_required`
   / `403 event_admin_out_of_scope`), refused before any row is created. An existing
   account is matched by its **PRIMARY** address only, the group-clash pre-check included;
   an address somebody holds as a **secondary** is refused by name in `errors[]` ("…that
   address is another account's secondary email — invite the person by their own sign-in
   (primary) address"; a 200, never a 409 clash), with nothing stored for it and nobody
   enrolled (operator ruling, 11 Nov 2026): the secondary is an
   unconfirmed claim, so the invitation must not enrol whoever made it, and a stored
   invitation to a held address could never be redeemed.
1b. **An EXISTING verified account waiting for approval** (not blocked, not locked) is
   approved by the invitation (`approved{via:"invitation_auto_approval"}`) only where the
   Approve button would approve it: the inviter holds `participants.approve`, does not
   compete against the account, and it is no privileged target for them. An inviter scoped
   to their events (an event admin, a scoped custom role) also needs the account to be a
   participant (an organiser's or administrator's waiting account stays waiting, counted in
   `skippedUnapproved`) that ends up in one of their events: the approval is written after
   the enrolment, in the same transaction, and when every enrolment was skipped (a staff
   spectator on an event where staff do not compete, a challenge author, a late entrant who
   took part) the account stays waiting and is listed in `leftPending`, which the Invite
   dialog reports and keeps in its box for an administrator to approve. A global admin's
   invitation approves before it enrols.
2. The link opens the **entry screen with the invited address pre-filled** and the
   invitation id held (`S._regInvitationId`); Continue sends it with the code request. A
   live invitation for that very address binds to the proof and **bypasses the
   corporate-email rule** (the only self-service bypass; §10).
3. The grant's invitation drives `POST /api/register`: claim-then-insert in one
   transaction, **V=1, A=1**, competitions/groups from the invitation applied (a clashing
   group skipped); a secondary equal to the forced primary is cleared. Signed in at once;
   `skippedCompetitions` names invited events that no longer exist.
3b. **An inviter who cannot approve** (operator ruling, 23 Nov 2026): while
   `require_account_approval` is on and the inviter may not approve accounts NOW
   (`inviterMayApproveNow`, `lib/rbac.js`, read live: the account `invited_by_id` names,
   whose permissions were checked when the invitation was made, or for an older invitation
   the `invited_by` address; an inviter gone, blocked, denied or unapproved, or an
   invitation naming nobody, cannot), the account is inserted **V=1, A=0** instead, decided
   inside the transaction. Every built-in role that may invite may also approve, so such an
   inviter is a custom role lacking `participants.approve` when it invites, or one that has
   lost the permission, or whose account is gone, blocked, denied or unapproved, since. An
   account that may approve inviting the same address again while the invitation is live
   makes it theirs (`invited_by`, `invited_by_id`; counted on the batch's `batch_sent`
   record as `inviter_replaced`), so the invitee is approved. Like any held sign-up it is not signed in, enrolled, grouped or given a
   Checkmarx One account; the answer is `{ok:true, pendingApproval:true, email}` and the
   invitation stays LIVE. Once an administrator approves the account, its first
   emailed-code sign-in claims the invitation (§3 Redeem step 5); before that a code
   answers `pending_approval` and claims nothing. Meanwhile People lists the account to the
   organisers of the events the invitation names (each sees only their own events), so
   they can ask an administrator to approve it.

### C. Join link, QR or join code (`joinToken`)
**Landing:** an anonymous visitor opening `/join/<token>` lands on the **entry screen**
with the event on the card (name and status chip). The pending join is persisted
client-side (`localStorage["hck-pending-join"]`) and rehydrated at boot; purged on a
successful registration or join and on the preview's 404, never on clock expiry alone. A
rehydrated token auto-joins **participants only**. A typed event code is entered in the
card's "Have an event code?" dialog, whose one button continues to the email step.

1. The code request carries `joinToken`; the resolved event (`_resolveJoinableComp`) binds
   to the sign-in code (existing account) or to the proof (`join_comp_id`, new address).
   **The binding counts only in the browser that asked** (`_sessionNamedEvent`): anyone
   holding the public join link can ask for a code for ANY address with the event named,
   so a code or proof carries its event only where this session's own code request for
   that address named that same event (its `codeRequests` note, §3), including a request
   that was held back because another browser's code came first. Typed in any other
   browser it signs in (or proves the address) as a code with no event: no enrolment, no
   approval through the join link, and the proof's event does not carry into the sign-up
   (the new account joins an event only through a join link opened in that browser).
1b. **"Not your event? Continue without it"** (operator rulings, 18 and 20 Nov 2026), on
   the card while it holds an event and on the sign-up form: the page forgets the event
   (`localStorage` included), and when this browser was emailed a code (or proved the
   address, or holds the sign-up grant) WITH it, `POST /api/auth/code/drop-event` unties
   that code first, so it still signs in, or proves the address, without joining. Only the
   browser whose request minted the code can untie it (the session's `codeRequests` note,
   below), so an address alone unties nobody's event. Untying also clears this browser's
   note of the event, so a code carrying it that another browser asked for (which this
   one cannot untie) joins nothing here either. An earlier join (the
   `pending_self_enroll_comp_id` marker, an event already joined) stays. For an account
   waiting for approval, an untied code no longer carries the join link's approval: it
   waits for an organiser like any other.
1c. **Switching the link off, or replacing it, unties what was asked for through it**
   (sweep #391; operator ruling, 24 Nov 2026). The event PUT that switches
   `self_enroll_enabled` off, and Regenerate, clear the event from every live sign-in code
   (`login_code_comp_id`) and address proof (`join_comp_id`) bound to it, in their own
   transaction (`untieJoinLinkBindings`, `lib/self-enroll.js`), and count them as
   `join_link_untied: {codes, proofs}` on that write's History record (`edited`,
   `self_enroll_regenerated`). Redeemed, such a code signs in, and such a proof makes an
   account, without joining or being approved through the link, as a sign-up through the
   closed link already did, for good: switching the link back on does not tie them again
   (while it is on, the link itself still joins as it joins anyone: the sign-up form's
   `joinToken`, the app's join after sign-in). What a database write cannot reach is
   checked when it is used: the session note records the link each event was asked
   through (`joinLinkTag`, a fingerprint of the token, never the token), the sign-up grant
   carries those tags (`joinLinks`), and an event counts at the redeem and at the sign-up
   only while its link is live (switched on, the event taking joins) and is still that
   link (`liveJoinLinkTag`). A link switched off and on again is the same link; a regenerated one
   is not. A sign-up form that still sends the closed link's token is read as sending none:
   the token is dropped before the live-invitation lookup (path A step 4), so a live
   invitation to the address makes the registration path B, else the account is in no event
   (the invalid-link 409 is kept for a token this browser never asked with, sent with a
   grant that named no event). A grant that still names the event, its link closed,
   replaced or the event no longer taking joins after the code was entered, is read the
   same way (`grantComp`, resolved once): the account is in no event, a live join token on
   the form fills it, a live invitation to the address makes it path B, any other dead
   token on the form is dropped, and `require_account_approval` (Require admin approval for new accounts) holds the rest, as for a
   link closed before the code was entered. The answer then carries `join_link_closed:
   true` (not when an invitation added the account to that very event), and the app
   forgets the link and says so rather than asking to join through it.
   The pending join marker an
   earlier registration through the link left is not untied: it is honoured after a
   switch-off, on purpose (§7).
2. The corporate-email rule is **NOT** bypassed (a join token blesses no address).
3. **The required-field set is this EVENT's** (`registrationFieldStates(<the grant's
   event>)`): five configurable fields (`personal_title`, `phone`, `city`, `linkedin_url`,
   `job_function`), each `required` / `optional` / `hidden`. Every kind configures them, and
   each starts from the short form (path A). The account records the event in
   `registration_competition_id` and its kind in `profile_policy`.
4. Row inserted per path A (approval per the setting), with
   `pending_self_enroll_comp_id=<comp>` consumed by the sign-in that follows (§7).

### F. Admin-created / import / bulk-seed (operator paths)
- **Participant import** (`POST /api/admin/import/participants`, `data.import`: a
  superadmin, or a custom role holding it). The
  corporate-email rule is not enforced (an audited bypass, `bypassed_free_email_rule`, on
  the CREATE branch). A CREATE defaults `verified`/`approved` to 1, stores
  `NO_PASSWORD_HASH` in `password_hash` and leaves `password_set_at` NULL, so it has no
  usable password. `profile_policy` and `registered_via` are
  carried verbatim; `registration_competition_id`, `password_set_at` and `login_method`
  are not (none is in the export), so a CREATED account signs in by its role's default
  method and an overwritten one keeps its own.
- **Add user** (Roles & permissions, `POST /api/admin/users`, `users.manage`) — creates a NEW
  account with an admin role: **V=1, A=1**, `registered_via='manual'`,
  `password_hash = NO_PASSWORD_HASH`, `login_method` NULL. With an unscoped admin role the
  method therefore defaults to `password` with none set: the first sign-in is by emailed
  code, then the Set your password prompt (§5); a scoped role signs in by code. The corporate-email rule is not asked (operator ruling,
  24 Nov 2026): a personal address is recorded `bypassed_free_email_rule: true` on the
  `user_added` event. Re-asked
  at commit (`adminAuthzDenied`). An address an account holds as its **primary** is
  `409 {code:"user_exists", id}` and the client offers to change that account's role
  instead; one held as somebody's **secondary** is `409 {code:"email_is_secondary"}` with
  NO account id (operator ruling, 11 Nov 2026), so nothing offers an admin role to
  whoever claimed the address.
- **Bulk-seed** (`/api/admin/perf/bulk-seed-*`, maintenance-mode, superadmin) — perf
  fixtures only. Email FORMAT is validated and nothing else; `sharedPassword` is accepted
  and ignored. It re-asks the acting superadmin at commit (`adminAuthzDenied`, §1).
- **Admin force-verify** (`POST /api/admin/participants/:id/verify`, superadmin) — sets
  V=1 and `first_verified_at` and clears the grace; refuses a denied user. Hands over no
  credential, leaves a sign-in code the account holds alone, and leaves `verify_code` alone
  (the §4 receipt).
- **Email sign-in code** (`POST /api/admin/participants/:id/login-code/email`, admin) —
  the row action that replaced Reset Password: mints an EMAILED code to the account's
  primary on its behalf, through the same eligibility and re-send suppression, and the
  account's send cap (not the per-origin share), as the public door. The admin sees
  nothing of it. A rival is refused
  `403 competitor_cannot_edit` (`competitorRivalDenied`); a regular admin may not send
  one to an admin or superadmin account. While a DESK code is live for the account it
  sends nothing and answers `{ok:true, sent:false, reason:"desk_code_live"}`, as it
  answers `reason:"recently_sent"` within two minutes of an emailed one (§3).

### G. At-desk invite — an account and a code, with no email at all
`POST /api/admin/participants/desk-invite` (**admin**) — `routes/participants.js`.

**Refused to a role that cannot approve accounts while `require_account_approval` is on**
(`participants.approve`, read live): `403 {code:"desk_approval_required"}` with the reason
and the remedy (Invite, or ask an administrator), since a desk code never approves and the
account could not sign in. Asked before the address is looked at (an address already in
use gets the same refusal), and again at commit (step 5).

1. **The corporate-email rule IS enforced.**
2. Duplicate email → **409** whose message names the remedy that works for THAT account
   (`_deskDuplicateRemedy`): Show sign-in code for an approved participant who has never
   signed in, Email sign-in code for one who has; Approve for an
   unapproved one (a superadmin's Verify first when it is unverified too); unblock or
   reverse the denial for an inactive one; "ask them to sign in on the sign-in screen
   themselves (with their password, or Email me a code instead)" for an admin account;
   for an address held only as another account's secondary, that it "never signs anyone
   in — ask the person for the address they sign in with"; and, for an address part-way
   through another account's change, to wait or use another. Re-taken inside the write
   transaction.
3. Row inserted: **V=1, A=1**, `first_verified_at=created_at`, `role='participant'`,
   `registered_via='desk'`, `registration_competition_id` / `profile_policy` from the
   event chosen (read AT COMMIT), `password_hash = NO_PASSWORD_HASH`. The account follows
   its event's LIVE sign-up form (§8). Desk accounts made before v8.12.8 are linked ONCE,
   at boot, where the event is beyond doubt (`settings.desk_registration_link_backfill_at`).
4. Optionally enrolled into a chosen competition (404 if missing, 409 when it is not
   taking people; a Booth Event inside its late-entry window admits a late entrant).
5. **Re-asked at commit**, in order: the acting admin (`adminAuthzDenied`), whether they
   may approve accounts (`desk_approval_required`, above), the event re-read, the competitor lock, the scope, the address, the admission. A refusal creates
   nothing.
6. **No email is sent.** The response carries a DESK code (`CODE_VIA_DESK`) and
   `expires_in_minutes`, for the organiser to read aloud.

---

## 3. Sign-in paths

### The entry card — which step Continue opens (`POST /api/auth/sign-in-method`)

The sign-in card (`public/index.html` `#login-page`, `public/js/features/auth.js`
`doLogin`) has one **Work email** box and **Continue**. What Continue does depends on what
was typed:

- **Anything that is not an address** (no `@`): the password box appears alone — no code
  button, subtitle "Enter your password.", Continue becomes **Sign in** — and the client
  asks the server nothing. The server would answer every non-address identically anyway:
  `{ok:true, method:"password", code_offered:false}`. This is how the built-in superadmin
  signs in (its break-glass username, below), and because every non-address gets the same
  step, the card never confirms whether a name is the break-glass username.
- **An address**: `POST /api/auth/sign-in-method {email}`, which answers 200 for every
  input (only the limiter's 429 and a CSRF refusal differ). The account is looked up by
  PRIMARY address only.
  - `{ok:true, method:"password", code_offered:true, password_set}` — an account whose
    method is `password` and which may sign in (not blocked, not denied). The password box
    appears **on the card**, Continue becomes **Sign in**, the subtitle becomes "Enter your
    password, or have a code emailed to you.", and an **Email me a code instead** button
    appears below; it opens the code step for that address (path A′). With
    `password_set:false` (the method is `password` but none is set — an admin before their
    first password) the card adds "This account has no password yet. Choose “Email me a
    code instead” to sign in, and you will be asked to set one." and focuses that button.
  - `{ok:true, method:"code"}` — everything else: no account, a code account, a blocked or
    denied account, a malformed address, an address held only as a secondary. The code
    step opens (the code dialog; a new address goes on to the proof and the sign-up form).
- **Editing the email box** returns the card to the address step (`resetLoginStep`).

**This answer is an enumeration, and that is accepted** (operator ruling, 11 Nov 2026): it
tells whether an address is a password account — by default every unscoped admin — and,
for one, whether it has set its password (`password_set`). Nothing else leaks through it:
unknown, code, blocked and denied all answer `code`, and the code doors stay uniform. Limits on both this lookup and the password door: per (IP, address)
`RATE_LIMIT_LOGIN_PER_MIN` (60 a minute) plus a per-IP backstop of
`RATE_LIMIT_LOGIN_IP_BACKSTOP_PER_MIN` (600 a minute); both carry the 16 KB credential
body cap (`server.js` `_AUTH_PATHS`).

### Password sign-in — `POST /api/auth/password` (`routes/auth.js`)

`{email, password}`. **200 for every outcome**, like the code doors — wrong passwords
from a venue NAT must not feed scanner reputation — and the client branches on `ok`.

1. **The account** is found by PRIMARY address only. A password is accepted only from an
   account whose method is `password` AND that has a usable password
   (`hasUsablePassword`): a code account's old password signs nobody in (audited
   `login_failed{reason:"password_not_in_use"}`; with no password at all,
   `reason:"no_password"`).
2. **One bcrypt for every outcome**: with nothing to check, the attempt is compared
   against a dummy hash (`dummyPasswordHash`), so timing does not separate "no account"
   from "wrong password".
3. **A wrong password** charges the account's ONE failure budget (`lib/lockout.js`, shared
   with codes; audited `login_failed{reason:"invalid_password"}`): ten in five minutes
   lock it for an hour (`auto_locked{method:"password"}`) and mail the lockout notice; a
   guess while locked is still checked but not counted again (the lock is an alarm, not a
   bar; the door's rate limits above bound guessing).
4. **After a correct password** the row is re-read (the bcrypt was an await) and the stored
   hash must still be the one verified (`credential_changed` otherwise). Then, each refusal
   audited as `login_failed` with its reason: blocked or denied → plain `{ok:false}`;
   an active lock is cleared (`auto_unlocked{reason:"correct_password"}`); unapproved →
   `{ok:false, error:"pending_approval"}`; unverified with no live grace →
   `{ok:false, error:"verify_by_code"}` (sign in with an emailed code first, which
   verifies). These two reasons are disclosed only to someone who knows the password.
5. **Success** runs the same bookkeeping as a code redemption (`_signInAs`): lockout
   cleared, `stampLoginTimes`, the pending join marker consumed (`_consumePendingSelfEnroll`),
   the open impersonation window closed, the session regenerated, other sessions ended with
   the kicker's context, `login_success{method:"password"}`, the tier flags, auto-resume and
   the login-shaped answer. After the regenerate it asks once more that the stored hash is
   still the one it verified (`opts.stillValid`), so a password changed meanwhile never
   mints a session on the old one. **It does NOT verify, approve, enrol in a code-bound
   event or claim invitations**: only an EMAILED code proves the inbox.

Blocked under impersonation for every tier (`_IMPERSONATION_BLOCKED`, below).

### Emailed sign-in code — `POST /api/auth/code/request` + `/redeem` (`routes/auth.js`)

**Request** (`{email, joinToken?, invitationId?}`) answers **200 `{ok:true}` for EVERY outcome** —
unknown address, ineligible, throttled, recently sent, sent — because a non-429 4xx feeds
scanner reputation (which blocks a venue NAT) and any distinguishable answer is an
existence oracle. Metrics (`hack_arena_login_code_*`) are the only monitoring. The client
branches only on a response that never reached the handler (429, a stale token). The
address is resolved by PRIMARY only: an address held only as somebody's secondary is
reserved, so it gets neither a code nor a proof (path A). Limits: five requests per
(IP, address) per 15 minutes, with a per-IP backstop across addresses of
`RATE_LIMIT_LOGIN_IP_BACKSTOP_PER_MIN` × 15 per 15 minutes (the limiter's 429); a sign-in code is further capped per account (step 3 below) and an
address proof per IP (path A, `RATE_LIMIT_PROOF_IP_PER_15MIN`).

**The session note.** Every request with a well-formed address writes, in the requesting
session, `codeRequests` (at most five, none older than a code lives): per address a
fingerprint (never the address), the event the request carried with a tag of the join link
it came through (`joinLinkTag`, path C step 1c) and, when it minted a code or proof, a tag
of it (`codeDropTag`, an HMAC of the stored hash under the per-boot session secret, so a
session row cannot be searched for the code). It is written for every
outcome, so the answer and its cookie are the same whatever happened; a request that
minted nothing keeps the earlier mint's tag. **The redeem reads it too**
(`_sessionNamedEvent`): a code's or proof's event counts only when this session's note
for the address names that same event, through the event's join link as it is now (path C
steps 1 and 1c). **Untie** (`POST /api/auth/code/drop-event`,
`{email}`, 200 `{ok:true}` for every outcome, five per (IP, address) per 15 minutes,
refused under impersonation): this session's own sign-up grant loses its event; otherwise
the note for that address must hold an event and a tag, and the account's live EMAILED code
(or the address's live proof) must still be that event's and that tag's — a compare-and-set
then clears `login_code_comp_id` (or `email_proofs.join_comp_id`). The code, its window, its
budget and its re-send suppression are untouched, nothing is mailed, and the note's tag is
spent and its event cleared (whether or not anything was untied), so no code carrying that
event enrols through this browser afterwards. Every well-formed untie saves the session and reads the address's code or proof
whatever this browser holds, so its cookie and work say nothing either (for a free-mail
address, "this browser was mailed something" would say an account holds it). Recorded as `login_code_event_dropped` (the account's History) or an orphaned
`email_proof_event_dropped` (stage `proof` or `grant`; the domain and fingerprint, never the
address); counted in `hack_arena_login_code_event_drops_total`. The client keeps its
"already on its way" marker (`ha:last-code`, which records the event a send carried and is
never reused for another) for a live send, now with no event, so Continue reopens the code
step instead of asking for a new code, which two minutes on would replace the untied one.

`_sendSignInCode` is the ONE emailed-mint path behind the code request, and only that route
calls it (the admin's Email sign-in code asks the same eligibility, suppression and
account send cap itself, without the per-origin share, §2 F):

1. **Eligibility** — `isCodeEligible` (`lib/login-code.js`): not blocked, not denied. Every
   role qualifies. `codeBlockedReason` is its explaining inverse.
2. **Re-send suppression** — `codeRecentlySent`: a live code mailed under
   `LOGIN_CODE_RESEND_MIN_MS` (120 s) ago is left alone (audited
   `login_code_refused{reason:"recently_sent"}`), so a double-submit, a second tab or
   someone else typing the address cannot kill the code being typed. In-process; a restart
   forgets it (fails open to the account cap). The SPA enables "Send a new code" after the
   same two minutes. **A live DESK code is never superseded either** (`deskCodeLive`;
   operator ruling, 11 Nov 2026): for as long as it is live (its window: at most
   `LOGIN_CODE_TTL_MS`, by default ten minutes, and less when it was shown while an emailed
   code was live, whose start time it keeps) the walk-up who was shown it is typing it into
   this same code step, so Continue sends nothing (audited the same way). It is decided from the
   stored code's provenance and liveness, so a restart forgets nothing.
3. **Budgets** — `LOGIN_CODE_MAX_SENDS` (3) emailed sends per account per window, at most
   `LOGIN_CODE_MAX_SENDS_PER_ORIGIN` (2) of them from one origin (/24 or /64). A
   redemption (`consumeCode`) closes the window and clears both, so signing in three times
   in ten minutes from one desk is never refused.
4. **Mint** — `issueCode(user, 'email', …, {competitionId, mintedTo})`: an 8-character
   Crockford code, sha256 at rest, the window anchored to the FIRST mint, the event binding
   overwritten by every mint (a desk mint always clears it), so the binding is always the
   one the newest mail names.
5. **Send** — `sendLoginCodeEmail` to the address the request named — always the
   account's PRIMARY, since nothing else resolves — detached (`trackDetachedSend`), naming
   the bound event when redeeming would add the account to it ("Signing in with it in the
   browser where you asked for it also joins you to …, as long as its join link is still
   open": switching the link off or replacing it unties the code, path C step 1c).

**Redeem** (`{email, code}`) answers **200 for every outcome; the client branches on
`d.ok`**. Limits: 10 a minute per (IP, address), with the per-IP backstop of
`RATE_LIMIT_LOGIN_IP_BACKSTOP_PER_MIN` a minute across addresses (the limiter's 429; trusted
networks and `RATE_LIMIT_ALLOWLIST_IPS` bypass both). They are what bounds guessing: the
account lock below refuses no guess.

1. `resolveCodeAttempt` resolves the (PRIMARY address, code) PAIR — never the code alone —
   and hashes unconditionally. A well-formed wrong code charges the account's ONE failure
   budget (`lib/lockout.js`, shared with passwords; 10 / 5 min → 1 h lock, lockout mail); a
   malformed one, or one that is not text at all, charges nothing; a guess while locked is still checked but not counted
   again, and a correct code signs in and lifts the lock (the lock is an alarm, not a bar).
   A code typed with a secondary address resolves no account and fails as a wrong code.
2. A correct code: blocked or denied → `{ok:false}`, the code kept. Any other correct code
   is then CLAIMED (`consumeCode`: cleared only while the stored hash is still the one
   matched), before anything else the redeem writes, so of two concurrent redeems of one
   code exactly one goes on; the other, arriving after the claim, is answered (and charged) as a wrong code. A **DESK** code redeemed by an
   account that is no longer a participant (promoted while the code was live) is refused
   and spent (operator ruling, 11 Nov 2026): an admin's code read out at a desk would be a
   sign-in as that admin. So is a DESK code redeemed by an account that has signed in by
   another door since it was shown (operator ruling, 14 Nov 2026: a code is shown at the
   desk only before a first sign-in). A correct code clears an active lock.
3. **Approval.** An unapproved account is approved by an EMAILED code
   (`approved_by='login_code'`, audited `approved{via:"login_code_auto_approval"}`) unless
   `require_account_approval` is on and the code came through no live join link (neither
   its own event, which counts only in the browser that asked for it, path C step 1, nor
   the account's pending join); otherwise — or with a DESK code — the code is
   consumed and the answer is `{ok:false, error:"pending_approval"}` (an emailed code still
   verifies the address first, which the approval queue needs).
4. **Verification.** An emailed code verifies (`self_verified{via:"login_code"}`); a desk
   code re-stamps the 48 h grace on an unverified account.
5. **Enrolment.** The join marker (`_consumePendingSelfEnroll`), then — emailed codes only
   — the code-bound event (`_consumeCodeBoundEnroll`), only when this browser's own code
   request named it through the event's join link as it is now (`_sessionNamedEvent`; any
   other browser, or a link switched off or replaced since, enrols in nothing through the
   binding, path C step 1c), and live invitations for the
   account's PRIMARY address (`claimInvitationsForAccount(user, user.email)`, never a
   body-supplied address). Neither enrolment ever takes an admin-tier account
   (`_enrolAtSignIn`; operator ruling, 17 Nov 2026).
6. **Session** (`_signInAs`, shared with the password door and the proof sign-up). The
   open impersonation window is closed (`impersonation_ended{reason:"login"}`), the session
   regenerated, other sessions ended with the kicker's context, `login_success{method:"login_code"}`
   recorded, `applyAutoResumeToSession` run, and the session's tier flags set (`isAdmin`,
   `isSuperAdmin` from the role). The session also records how and when it signed in
   (`signInMethod`, `signedInAt`), which the forgotten-password recovery reads (§5).
   **The kicked browser's advice follows the method** (`kickerContext`, whose
   `passwordless` is `effectiveLoginMethod(user) !== "password"`): a code account is told
   to tell an organiser and guard its inbox; a password account to sign in with an emailed
   code ("Email me a code instead"), change its password under Profile → How you sign in,
   and tell an organiser; the built-in account (`builtin`), to restart the platform.
7. **Answer** — the login-shaped payload the SPA routes on: `role`, `userRole`,
   `isSuperAdmin`, `isEventAdmin`, `id`, `isStaff`, `competitions`,
   `autoResumeCompetitionId`, `missing_fields` (`[]` for every admin tier), `verified`,
   `verification_grace_until`, and the sign-in-method block (§1). With
   `password_required: true` the SPA opens **Set your password** before it routes (§5).

**Desk reveal** — `POST /api/admin/participants/:id/login-code/reveal` (admin): mints a
`CODE_VIA_DESK` code into the admin's response (no mail, no budget). The answer is a
working credential for the account, so it is asked in this order: **the rival door** — an
actor who competes alongside the participant is refused `403 competitor_cannot_edit`
(`competitorRivalDenied`, the 19 Sep 2026 rival ruling applied here by operator ruling,
11 Nov 2026), and the People row menu withholds **Show sign-in code** on rival rows — then
the actor's scope, then the ladder. Participants only (an admin's code on another admin's
screen would be a sign-in as them), approved accounts only, and **accounts that have never
signed in only** (operator ruling, 14 Nov 2026: `hasSignedIn`, `lib/login-code.js` —
`login_time` and `last_login_time` both unset; every sign-in door stamps them through
`stampLoginTimes`, and a failed stamp fails that sign-in, so a signed-in account never
reads as never signed in): a shown code is a full session as the
person, covering all of their events, so it is for the walk-up just added at the desk or
whose first code never arrived; after a first sign-in the desk can only **email** a code
(409 `signed_in_before`, naming Email sign-in code). The ladder (`_codeBlockedReason`,
`routes/participants.js`) also drives the row's `can_use_code` / `code_blocked_reason`
(the menu's note names Email sign-in code) and the desk duplicate remedy, so the three
cannot disagree. The
answer's `expires_in_minutes` is the time actually left: a desk code shown while an emailed
code is live keeps that code's start time, so it can have less than ten minutes. **A live
desk code is replaced only by showing another one at the desk** — never by the entry
screen's Continue, nor by an admin's Email sign-in code (`desk_code_live`) — for as long as
it is live (`deskCodeLive`), and one redeemed by an account promoted meanwhile, or by one
that has signed in by another door since it was shown, is spent and refused (Redeem, step 2).

**Mail outage.** A password account that has set its password signs in without mail; a
code account, and an unscoped admin who has not yet set one, cannot. The fallbacks are the
desk reveal (for a participant who has never signed in), a password (any account may set
one while mail works), and the built-in superadmin's break-glass password below.

### The break-glass account — `POST /api/login` (`server.js`)

Exactly ONE account has no code door: the built-in superadmin, which has no row and no
address. Its **username** is the setting `breakglass_username` (`lib/settings.js`
`getBreakglassUsername`, default `superadmin`, compared case-insensitively); its password
is in `DATA_DIR/.superadmin-password` — regenerated every boot, written from the
`portCheck` listening handler, rotated after 10 server-wide failures in 15 minutes
(10-minute cooldown), never settable from the UI. The startup banner prints the password
and says to sign in on the sign-in page with the break-glass username.

**It signs in on the ordinary card**: type the username into the email box, press
Continue, and the password box appears alone (a non-address, above); **Sign in** posts
`POST /api/login {username, password}`. `POST /api/login` (`username`, or the legacy
`email` field) signs in only the CURRENT username with that password, and only while no
account holds the name as an address (`breakglassNameHeldByAccount`, re-checked at every
sign-in). **Every other pair — an old name after a rename, any address, a wrong password
for the right name — gets one generic `401 {error:"Those details did not sign you in.",
code:"use_sign_in_code"}` with no lookup**, so the door is no oracle for the name and an
account's password is no good here (nor the break-glass password at the account door);
only an attempt naming the current username does more than compare: two indexed point
lookups for an account holding the name as an address, then the rotation counter, a
small fixed difference that does not grow with the number of accounts. Its limiter keys on (IP, `username` or the legacy `email`) with the per-IP
login backstop, so one IP's attempts at different names do not share a bucket.

**There is no special sign-in address** (operator ruling, 11 Nov 2026): `/break-glass`
answers 404. Besides `/`, the SPA shell is served at `/register` (where invitation emails
land) and `/join/<token>`, and neither has a sign-in of its own. **The SPA never learns
the username**: nothing in the shell, the bundle or any anonymous answer carries the
name, and the card treats every non-address the same way. **Only the break-glass session
itself** (`builtinId`, not impersonating) reads or changes it: `GET|PATCH /api/admin/breakglass-username`
(403 `breakglass_session_required` for every other session, user-backed superadmins
included; `EVENT_ADMIN_FORBIDDEN` too). Validation (`validateBreakglassUsername`): 3–64
printable characters, no whitespace or control characters, no `@` (so the card can never
read it as an address), never an account's primary or secondary address. The change is
audited as a `breakglass_username` settings event with `reqContext` (the names themselves
are not recorded — half a credential, and app.jsonl is readable by every regular admin);
the current session stays signed in; the new name is needed from the next sign-in. Its
sign-in passes `kickerContext(req, { email: "superadmin", builtin: true })`, whose popup
advises a restart. Every user-backed account — superadmins included — signs in through
the account doors above, by password or emailed code.

### Impersonation — an admin session ACTING AS another account (v7.14.0; the event-admin view since v8.12.1)

Not a login path: no credential is presented for the target and no session is created
*for* them. An existing **admin** session is re-pointed at a participant — or, since v8.12.1,
at an event admin, in whichever of THEIR two views was chosen.

`POST /api/admin/participants/:id/impersonate` (`routes/participants.js`, body
`{view: "participant" | "admin"}`, default `participant`) → snapshot the admin identity into
**`req.session.impersonator`** (which also records the `view`) → `regenerate()` (privilege
change; CSRF token must be re-fetched) → `req.session.userId = <target>` (+ the
`userEmail`/`userFirstName`/`userLastName` mirrors, `userRole` = the target's real role). The
session is then SHAPED LIKE THE TARGET'S OWN, in that view:

- **participant view** — `isAdmin` / `isSuperAdmin` are **not** set, so the session cannot
  reach admin endpoints. The only shape until v8.12.1, and still the only shape a
  participant-role target can take.
- **event-admin view** (`view:"admin"`, an `event_admin` target only) — `isAdmin=true` and
  `isSuperAdmin` **never** set, whatever the acting admin's tier: the target is not a
  superadmin, and the write tier is decided per request from the ACTING admin's row by
  `impersonationGuard`, never from a session flag. `POST /api/toggle-admin-view` carries the
  marker (and the target's identity mirrors) across its regenerate, so the two views are one
  impersonation switched from the header exactly as the organiser switches their own;
  `mode:"admin"` on a participant-role target answers the participant's own refusal
  ("You do not have admin access") BEFORE the regenerate, so a refused switch changes nothing.

| Question | Answer |
|---|---|
| Who may enter? | Any admin — but an **event admin** only for a participant enrolled in an event they organise (`participantDenied`, which also refuses them a fellow organiser: `event_admin_target_privileged`, ROLES §9.6). Target must be a **participant or an event admin** (`admin`/`superadmin` targets 403 for everyone, superadmins included) and able to pass the participant lifecycle (else 409 `impersonation_target_inactive` + reason). **The admin view is a global admin's door and an event-admin target's alone**: `view:"admin"` on a participant-role target is `400 impersonation_view_unavailable`, any other value `400 impersonation_view_invalid`, an event-admin ACTOR asking for it `403 event_admin_forbidden`, and an acting admin who holds a row on an event the organiser runs where staff compete is refused `403 competitor_cannot_edit` naming it (`actingAdminCompetesInTargetEvents`) — the participant view of the same organiser still opens, and `POST /api/toggle-admin-view {mode:"admin"}` from inside it asks the same predicate and is refused the same way, before its regenerate. A **nested** entry from inside any impersonation is refused for every tier by the GUARD, which answers first with `403 impersonation_nested` (`_IMPERSONATION_BLOCKED_RE`); the route's inline 409 with the same code is defence in depth and unreachable while the guard is mounted. |
| What may it **SEE**? | v8.8.6 — for an **event-admin** impersonator in the participant view, only the events THEY organise: both list surfaces are narrowed, `select-competition` and `requireCompetitionContext` refuse an out-of-scope event with `event_admin_out_of_scope`, and the certificate mint and list are narrowed with them. Resolved by `impersonatorScopedCompetitionIds` from `req.session.impersonator`, with the acting admin's role re-read per request. Every other tier's participant view is unscoped and unchanged. See ROLES §9.5b. **In the event-admin view (v8.12.1) the `/api/admin/*` surface answers about the TARGET**: `isEventAdmin`, `scopedCompetitionIds`, `actorId` and `eventAdminGuard` all read the impersonated organiser (the two carve-outs that used to answer about the seat — `isEventAdmin` and `eventAdminGuard` — key on the session SHAPE, `impersonator && !isAdmin`; `impersonatorScopedCompetitionIds` deliberately still resolves the ACTING admin from the marker, being about the participant surface), so the panel is theirs row for row, forbidden routes stay forbidden, and a zero-grant organiser's seat lists nothing. The acting admin's own scope plays no part; a superadmin gains nothing beyond what that organiser sees. **Three rules bind the HUMAN rather than the seat.** The SEAL: every `lib/answer-seal.js` predicate is asked with `actingAdminId(req)` — the acting admin's own id under impersonation — across the admin task list, the version history, the two exports, the import overwrite, the participant task detail AND the inline Submissions stream (server.js — the site the first draft missed, found by the pre-release review), so an organiser's sealed key is withheld from whoever looks through their seat, in either view, the acting admin's OWN sealed challenges stay readable through it, and a seal cannot be SET through somebody else's seat (`answer_seal_not_by_proxy`) — and since v8.12.2 every one of those predicates also takes a `revealed` flag (`sealRevealedFor(req, taskId)`), true only for a superadmin, by LIVE role of the acting human (`actingIsSuperAdmin`), who has REVEALED that challenge in this session through `POST /api/admin/tasks/:id/sealed-reveal`; the reveal is recorded in `task_versions` (`sealed_reveal`, carrying `impersonated_by` and the seat as an id, `acting_as_id`, which the versions route resolves per reader to `acting_as` / `acting_as_withheld` / `acting_as_deleted`) and in the event log (which carries the seat's email as `acting_as`, being rotated), and `req.session.sealedReveals` dies with the session shape (every regenerate and the forced exit drop it). The COMPETITOR LOCK: every `lib/staff-compete.js` predicate is asked about `competitorIds(req)` — the seat AND the hand — so an event the acting admin competes in, a challenge it holds and a rival on its board are refused through anybody's seat, whichever event that organiser runs (the first draft keyed those doors on the seat alone and relied on the guard's coarse re-ask, which covers only events the TARGET organises). The CERTIFICATE CODE (operator ruling, 23 Nov 2026), in the participant view of every tier: `GET /api/me/certificates`, every answer of the certificate mint (held or new) and the LinkedIn post (`GET /api/me/certificates/:token/linkedin-post`) carry a certificate's credential code and token, and every link built from the token, only when the acting admin, read live, holds `certificates.lookup` (among built-in roles, the superadmin alone); otherwise they carry `withheld: true` and the post answers its unknown-token 404. See ROLES §9.5d. |
| What may it do? | Regular admin: **read-only** — every non-GET `/api` request 403s `{error:"Not allowed in impersonation mode", code:"impersonation_readonly"}` via the global `impersonationGuard` (`lib/impersonation.js`), except the navigation/telemetry allowlist and **one named durable carve-out, the certificate mint** (`impersonationReadOnlyWriteAllowed` — v8.3.25: `POST /api/competitions/:id/badge` only, anchored at both ends, and checked BELOW the v7.21.12 re-read so an ex-admin cannot reach it; `POST /badge/:token/shared` is deliberately NOT in it, so a read-only admin generates a certificate and never publishes one). Superadmin: everything (the SPA confirms each write). The guard matches a **lowercased** path — Express routes case-insensitively, so a raw-path match let `PUT /API/me` bypass the read-only tier. **Four endpoints are blocked for EVERY tier, superadmin included** (`_IMPERSONATION_BLOCKED`, answered `403 impersonation_readonly`): `/api/auth/code/request`, `/api/auth/code/redeem` and `/api/auth/password` — each a sign-in as the target that would carry no `impersonated_by` — `/api/auth/code/drop-event`, which changes what a code mailed to the target does, and `/api/me/sign-in-method`, because a credential set on the target's account is the account owner's alone (the route also refuses an impersonation session itself, `403 impersonation_blocked`, unreachable while the guard is mounted). `/api/toggle-admin-view` LEFT the set in v8.12.1: its only recorded reason for being there was that it dropped the marker across its regenerate, and it carries the marker now — it is the in-session view switch, on the navigation allowlist for both tiers. **The same tiers hold in the event-admin view**: a regular admin's non-GET `/api/admin/*` request 403s `impersonation_readonly` (the organiser's panel, read-only), a superadmin's goes through behind the SPA confirm — whose copy names the organiser's panel — and lands attributed to the SUPERADMIN (`getAdminIdentity` resolves the acting admin under impersonation since v8.12.1) with `impersonated_by` and `acting_as` on the row. Superadmin-only routes stay refused there (`requireSuperAdmin` reads a flag the session never carries): "full access" means everything the ORGANISER may do. **The tier is re-decided per request (v7.21.12)**, not frozen at entry: on any non-GET that is not allowlisted the guard re-reads the ACTING admin's row and destroys the session with a 403 if that row is gone, blocked, denied, unverified, unapproved or no longer admin. The built-in superadmin is carved out. **An admin write already in flight is re-asked AT COMMIT about both people (v8.12.6)** — `adminAuthzDenied` on the routes that keep reading after their guard: the HAND through `actingIsSuperAdmin` (only a superadmin's write goes through a seat), and the SEAT, which must still be a live `event_admin` or the write answers `requireAdmin`'s own forced-exit shape, `403 impersonation_ended {reason:"target_inactive", code:"admin_access_revoked"}`, with nothing written (the in-place restore is left to the next request). Only the attachment uploads can meet this under impersonation: the imports are `requireSuperAdmin`, which an impersonation session never passes. **A PARTICIPANT write made through the seat re-asks the HAND at commit too (v8.12.6)** — `impersonatingHandDenied` (`lib/middleware.js`), because the guard read the acting admin when the headers arrived and three participant writes keep awaiting afterwards: the answer submit (the file read; asked first inside the grading transaction, ahead of the seat's own `participantAuthzDenied`) and the certificate mint (after its render, first in the persist transaction). In order: the session's revocation TOMBSTONE — asked first, because every path that purges a session has already closed the impersonation window (the CSRF refusal too, since v8.13.4 — before it, that destroy left the window open), and asking the hand first would record a second close — answers `403 {error:"impersonation_ended", reason:"session_ended", code:"admin_session_ended"}` and changes nothing else; a hand that is no longer a live admin, superadmin or event admin (blocked, denied, deleted or demoted out of band) answers `403 {error:"impersonation_ended", reason:"actor_inactive", code:"admin_access_revoked"}` and the session is destroyed with the target's window closed `actor_inactive` — the guard's own disposition; a hand still an admin but no longer a superadmin answers the guard's `403 impersonation_readonly`, the session kept — except on the mint, which the read-only tier may make. Nothing is stored, no score moves, no attempt is spent, and the SPA's forced-exit toast names which of the two ended it. The built-in superadmin passes the hand arm by construction. self-leave, `PUT /api/me` and `resend-verification` write before they await. A session acting as its own account is re-asked by `participantSessionDenied` instead (§1). **The SEAT's lifecycle is re-asked there too**: a target blocked, denied or deleted while the submit or the mint was in flight gets `requireParticipant`'s own forced exit, `403 {error:"impersonation_ended", reason:"target_inactive"}`, the admin restored in place and the window closed once; a membership refusal keeps its own sentence, and the mint re-asks the membership as well. **And the competitor lock is re-asked there too (v8.12.0)**: if the acting admin and the target both hold rows on an event where staff compete — a pair that can BECOME so mid-session when a colleague enrols the admin — the write is refused `403 competitor_cannot_edit` naming the event, for both tiers, the session kept and the exit still allowlisted; entry (`POST /api/admin/participants/:id/impersonate`) refuses such a rival outright. |
| Whose session is it? | The **admin's**. `invalidateOtherSessions` matches it on the `impersonator` snapshot, so the participant's own login never kicks it — and the admin's re-login/block/demotion does. |
| How does it end? | **Several distinct reasons**, every emit site recording `impersonation_ended` on the target so the window is never left open. The six below, plus `"login"` (a session-replacing sign-in — `_closeImpersonationWindowOnSessionReplace` on the break-glass door, and the same close in `_signInAs`, which every account sign-in shares), `"csrf_invalid"` (v8.13.4 — the `EBADCSRFTOKEN` handler destroys an impersonation session like any signed-in one and closes the window first through that same closer, the session owner's `sessions_invalidated` landing on the ACTING admin, never the target; from v7.14.0 it destroyed the session with no emit at all). (The removed LinkedIn callback and password reset emitted `"linkedin_callback"` and `"password_reset"`; History keeps their labels for old rows.) Grep `"impersonation_ended"` before trusting a count here. (1) `POST /api/impersonation/exit` (`reason:"manual"` — re-validates the admin's lifecycle, regenerates, restores identity + flags + prior comp context); (2) a **forced exit** when the target's lifecycle fails mid-session (`"target_inactive"`) — `requireParticipant` / `keepalive` in the participant view, `requireAdmin` / `GET /api/admin/me` in the event-admin view (v8.12.1), and at commit the answer submit and the certificate mint, all through one helper (`restoreImpersonationTargetInactive`), restore the admin **in place** (never `destroy()`, it is the admin's session) and return `403 {error:"impersonation_ended", reason:"target_inactive"}`; (2b) the **acting admin** losing admin access mid-session (`"actor_inactive"`, v8.12.1) — the guard, `requireAdmin`, `GET /api/admin/me`, the toggle, the exit route and — at commit, through `impersonatingHandDenied` (v8.12.6) — the answer submit and the certificate mint all go through `destroyImpersonationSession`, which closes the window on the target's row and THEN destroys, there being no identity left to hand back (the first draft destroyed with no emit at all five); (3) **logout** (`"logout"`) — the admin is signed out, and the `logout_manual` event is attributed to the ADMIN, never to the target whose id the session happens to carry; (4) **session purge** (`"session_purged"`) — the admin re-logs in elsewhere, or is blocked / demoted / deleted, so `invalidateOtherSessions` drops the session; (5) **expiry** (`"session_expired"`) — the 60-minute cookie lapses or the admin closed the browser, and the 5-minute session GC sweeps the row. Paths 4 and 5 have no request in hand, so they carry no `reqContext` and emit best-effort post-commit. |
| What is written for the target? | No participant STATE on entry — only the `impersonation_started` audit row (see Trail). `select-competition`/`select-timeslot` suppress `login_time` (the solve clock), `last_login_time`, `active_competition_id` and the `first_joined` events; the view toggle skips the auto-resume landing. A superadmin's deliberate actions (submission, hint, feedback, profile edit) DO write — they are real — and carry `impersonated_by` in the audit detail; **a REGULAR admin writes exactly one thing (v8.3.25)**, the certificate mint, whose `badge_minted` event carries `impersonated_by` for the same reason — without it the competition History would record that the participant published themselves; `challenge_events` rows are flagged `impersonated=1` and excluded from analytics. **In the event-admin view (v8.12.1) a superadmin's ADMIN actions are real too** — an event edit, a challenge assignment, a block — and land on the entity's History attributed to the acting superadmin (never to the organiser) with `impersonated_by` + `acting_as` from `reqContext`, which carries both on EVERY emit made under impersonation; a regular admin writes nothing there. Ownership columns (`created_by_id`, `assigned_by_id`) still record the SEAT: the organiser's panel owns what was made through it, the history says whose hand. |
| Trail | `user_events.impersonation_started` (with `target_role` and `view`) / `impersonation_ended` (with the `view` in force at the close) on the **target**, actor = the admin, with `reqContext`; `admin_view_toggled` on the target attributed to the acting admin for every in-session switch; every access-log line in the window carries `impersonated_by`, and every audit row carries `impersonated_by` + `acting_as` — except the two rows that land on the ACTING admin's own History: `logout_manual` from **Logout**, and the `sessions_invalidated {reason:"csrf_invalid"}` row a refused CSRF token writes when it ends the session (after the window is closed with `impersonation_ended {reason:"csrf_invalid"}` on the target). Both carry `acting_as` but not `impersonated_by`, which on the owner's own row would name them as their own impersonator. |

`GET /api/me` for such a session bypasses the me-cache and carries
`impersonation:{active,superadmin,admin_label,view,target_role,scoped_to_my_events,withheld_event_count,certificate_codes}`;
`isAdminView` reads the VIEW (false in the participant view, true in an event admin's admin
view), `isEventAdmin` is the target's TIER in both. `GET /api/admin/me` answers about the
target in the admin view (role `event_admin`, their grant count) and carries a shorter
block (`active`, `superadmin`, `admin_label`, `view`, `target_role`) — and, like `requireAdmin`, forces the exit (restore, never destroy) with
`403 impersonation_ended {reason:"target_inactive"}` when the organiser is blocked, denied,
unapproved, demoted OR promoted to a global tier mid-session, and re-reads the ACTING admin
on every read so a blocked ex-admin does not keep an organiser's read surface. Full detail in
CLAUDE.md → *Participant impersonation* and *An event admin can be looked at in their own
panel*.

---

## 4. Email verification — one-click `GET /verify` (`routes/auth.js`)

- **`GET /verify?code=` verifies in ONE click** (v7.23.10). The interstitial confirmation
  form is gone. This is a scoped exception to the "a GET must never mutate" rule: the
  mutation is what the recipient asked for by registering, it grants no capability, and it
  **presents idempotently** — see the disposition note in CLAUDE.md.
- `verified` is the "consumed" marker now, **not** `verify_code`, which is retained as a
  48h idempotency receipt. That is what lets a human who clicks *after* a mail scanner
  already spent the link be told the truth instead of "Verification Failed". The
  already-verified check runs **before** the expiry check, or an already-verified user
  clicking at T+48h would be told their link expired.
- The claim carries `AND verified=0`, so exactly one of two same-instant requests runs the
  side effects; the loser re-reads and reports success. Redirects to **`/verified.html`**
  with `Cache-Control: no-store`, preserving post/redirect/get.
- `POST /verify` is kept as an alias for a form cached from before the release.
- The spent receipt is swept hourly (`sweepStaleVerifyCodes`), and the participant-import
  overwrite clears it when setting `verified=0` so an operator forcing re-verification
  cannot be silently undone.
- It mints no credential. A bad code → `/verify-failed.html`; an expired,
  still-unverified one → `/verify-expired.html`. A **USED** code inside its 48 h receipt
  window lands on **`/verified.html`** — which is the whole point of retaining it, and what
  makes a mail-scanner's prefetch harmless. Since v7.23.11 those
three result URLs are **server-rendered from the one `_emailResultPage` builder** (the static
files are gone); the redirect and the paths are unchanged, so the code stays out of the
address bar.
- A logged-in unverified participant (in grace) can re-send via **`POST /api/resend-verification`**
  (rate-limited 5/15 min), surfaced by the amber `#verify-indicator` countdown chip.

### Primary-email **change** — pending confirmation (`GET` + `POST /confirm-email`, v7.5.0)

BOTH doors stage. A participant changing their own primary email (`PUT /api/me`,
v7.5.0) and — since v8.3.36 — an admin changing it (`PUT /api/admin/participants/{id}`)
do **not** swap it immediately, and neither logs anybody out. The new address is **staged** in `pending_email`
(+ a single-use 48 h `pending_email_code`); the live email / `verified` / session stay
active. A link to the **new** address (`/confirm-email?code=`) confirms it via a
scanner-safe GET→POST shape — which `/verify` no longer uses, and the difference is
deliberate: a prefetch here would silently swap the user's **sign-in address**, an outcome
they did not ask for at the moment the scanner acts, so it fails the first of the three
tests that let verification become one-click (CLAUDE.md *Unsubscribe*).
`POST /confirm-email` re-checks the address (uniqueness **and** that it does not collide
with the row's own secondary — 409 after purging the pending columns) and the 48 h expiry,
then atomically swaps `email`, sets `verified=1` and `first_verified_at`, clears the
pending columns and the grace, and — v7.23.10 — clears `verify_code`/`verify_code_at`,
because the retained receipt attests the address this statement is replacing.
Full rules (uniqueness incl. in-flight, the admin matrix, enumeration resistance) live in
**[EMAIL_RULES.md](EMAIL_RULES.md)**.

---

## 4b. Unverified-account lifecycle — 48h auto-delete (v7.6.0)

The **account reaper** (`lib/account-reaper.js`) deletes an account that was never verified
within **48 hours** of its creation. Since email first, a self-registration creates its
account already verified (the redeemed proof proved the inbox, path A), so what the gate
below still reaches is of two kinds: a manual sign-up from before then that was never
verified or approved, and an account a participant import creates marked both unverified
and unapproved. The import writes `registered_via='manual'` unless the file says otherwise
and keeps the file's `created_at`, so such a row dated before the grandfather floor is
spared; and it approves a row unless the file says otherwise, so an account it marks only
unverified is never reaped.

**Who the verification machinery still serves (operator ruling, 14 Nov 2026).** Every door
that creates an account today — a sign-up with an emailed code, an invitation, the desk,
Roles & permissions — creates it verified. So the verification link (`/verify`), the 48 h grace
(§6) and the "Verify email" chip with its resend act on two kinds of account only: ones
still unverified from before email first, and ones a participant import marks unverified
(`verified: 0`, kept so an operator can force re-verification); the reaper acts on those of
them its gate admits (above). They are kept for those accounts. Owner: the operator; revisit when no such account remains. Retiring
them is a release of its own: a one-off migration settling every unverified account, the
import no longer writing `verified: 0`, and the test helper that puts new accounts back
into the unverified state reworked.

- **`users.first_verified_at`** is stamped the first time an account becomes verified —
  including these 0→1 transitions: `POST /verify`, admin
  verify, `POST /confirm-email`, and an **EMAILED sign-in-code redemption**; plus the
  participant-import overwrite. Four more paths stamp it at **creation** rather than on a
  transition (the sign-up a redeemed proof completes, the import INSERT of a row marked
  verified or carrying the stamp, desk-invite and Roles & permissions Add user). See §1 for the full write-site list. It is
  **never cleared**. The reaper only deletes rows where it is
  **NULL**, so a once-verified account (even one later set `verified=0` by a participant import
  overwrite forcing re-verification)
  is never swept.
- **The reaper gate** (`sweepUnverifiedAccounts`) deletes only accounts that are
  `first_verified_at IS NULL` **and** `verified=0` **and** `approved=0` **and**
  `registered_via='manual'` **and** `invitation_id IS NULL` **and** `pending_self_enroll_comp_id
  IS NULL` **and** `self_enroll_grace_until IS NULL` **and** not blocked/denied **and**
  `role='participant' OR role IS NULL` (a NULL role IS reapable — the column is nullable and
  both import paths bind it explicitly) **and** `created_at` older than 48 h. So
  **event-link (`/join`)**
  registrations (they carry a self-enroll marker), **invited**, **admin-approved**, **LinkedIn**
  and **operator** accounts are all preserved, and so is an **import** unless its file marks the
  row both unverified and unapproved — only abandoned manual sign-ups, and such an import, are
  reaped.
- **Grandfather floor:** `settings.account_reaper_floor_at` is stamped once at the deploy of this
  feature; the reaper ignores accounts created before it, so the upgrade never mass-deletes
  pre-existing (incl. abandoned) accounts. Only accounts created after the deploy (an import's
  by the `created_at` it keeps) are subject to the rule.
- The sweep runs **hourly** (and once at boot), deletes at most **500/run** (the overflow waits
  for the next tick), uses the **same cascade** as `DELETE /api/admin/participants/:id`
  (`deleteUserCascade`, shared — which also busts the me, user-tags, admin-participants and,
  since v8.12.6, the event-admin role/scope caches), and emits an `account_reaped` audit event
  per deletion. Full
  rules + the preservation matrix live in the reaper module header + CLAUDE.md.
- **One gate (v8.12.6).** The WHERE clause above, grandfather floor included, is
  `REAP_GATE_SQL`; the sweep adds its own age cutoff, and any other reader interpolates it
  rather than a copy.

---

## 5. Passwords — set, changed and recovered by their owner

**Who has one.** A password is usable only when its owner set it (`hasUsablePassword`:
`password_set_at` stamped and a bcrypt hash stored). No creation path sets one (§2), no
admin can set, read or reset anyone's password, and there is no reset link: the recovery
is an emailed code. An account upgraded from v8.14.x keeps the password it had there, and
it works again once the account's method is `password` (operator ruling, 11 Nov 2026).
Exception: when `password_set_at` was added, a one-time back-fill stamped it on every
existing non-LinkedIn row, including rows that held only a random bcrypt placeholder (an
account imported, or signed up and never verified, before then). The later repair cleared
LinkedIn rows only, because the others cannot be told from real passwords. Such a row reads
as having a password nobody knows (`has_password: true`); its owner signs in with an
emailed code and, within ten minutes, sets a new one (below).

**Choosing and changing — `PUT /api/me/sign-in-method`** (`routes/auth.js`; Profile →
**How you sign in**). `{method, password?, currentPassword?}`. `requireParticipant` (any
signed-in account row, admins included; the built-in superadmin has none), 20 requests
per 15 minutes per (IP, account), CSRF.

- **`method:"code"`** stores `code`. A stored password is KEPT (switching back reuses it),
  but the password door refuses it while the method is `code`. Sending `password` with
  `code` is `400 password_not_used`.
- **`method:"password"`** with no usable password needs `password`, which is set there and
  then (`400 password_required` without it). With one set, switching needs nothing new. To
  CHANGE it, send `password` plus `currentPassword` — or only `password` when THIS session
  signed in with an EMAILED sign-in code within the last ten minutes
  (`RECENT_CODE_SIGN_IN_MS`, read from the session's `signInViaEmail` / `signedInAt`, which
  `_signInAs` stamps): that is the forgotten-password recovery — sign in with "Email me a
  code instead", then set a new one. Only an emailed code proves the inbox: a desk code an
  organiser read out does not open the window. Switching between Admin View and Participant
  View is not a new sign-in, so `POST /api/toggle-admin-view` carries those stamps across
  its regenerate. A missing current
  password is `400 current_password_required`; a wrong one is `400 current_password_wrong`
  and charges the account's lockout budget like a wrong sign-in.
- **Policy**: at least 8 characters and at most 72 UTF-8 bytes (bcrypt reads only the
  first 72), `400 password_invalid`; an unknown method is `400 login_method_invalid`; a
  non-text field `400 body_field_invalid`.
- **Commit.** After the bcrypt awaits the session is re-asked (`participantSessionDenied`:
  a sign-in elsewhere, a block or a logout meanwhile writes nothing), and the write is a
  compare-and-swap on the hash it read: a password rewritten meanwhile is
  `409 credential_changed`, never overwritten blind.
- **After.** A CHANGED password ends the account's other sessions (`SESSION_END.ended`,
  audited `sessions_invalidated{reason:"password_changed"}`); this session stays. Setting
  or changing one mails `password_changed_notification` (`sendPasswordChangedEmail`) to
  the PRIMARY address (§9). A first password ends no session. Audited with `reqContext`:
  `password_set`, `password_changed`, and `login_method_changed{from,to}` whenever the
  stored method moves (the Audit page shows them as "Password set", "Password changed"
  and "Sign-in method changed").
- **Answer**: `{ok:true, login_method, login_method_is_default, has_password,
  password_required}`.
- Blocked under impersonation for every tier (`_IMPERSONATION_BLOCKED`).

**The Set your password prompt.** When a sign-in answer carries `password_required: true`
(method `password`, none set — an admin's default until their first password),
`finishSignIn` opens **Set your password** before it routes: New password, Type it again,
and two buttons — **Keep using emailed codes** (stores `code`) and **Set password**. It has
no X and Escape does not close it; the two buttons are the way out. It is asked at every
interactive sign-in until resolved, never when an existing session reloads.

**The profile row.** The account's own Profile dialog has a **How you sign in** row: a
one-line summary (ending "(The default for your role.)" while nothing is chosen) and
**Change how you sign in**, a dialog offering "A code emailed to me" or "My password", with
Current password (only when one is set; "Not needed if you signed in with an emailed code
in the last 10 minutes"), New password and Type it again. An admin's view of somebody
else's profile has no such control, and neither has an impersonated profile (`GET /api/me`
withholds the sign-in-method block there, §1).

**LinkedIn sign-in stays removed.** There is no LinkedIn OAuth route, mock or per-event
"LinkedIn sign-up" switch, and no password reset route or `/reset-password.html` page:
`POST /api/admin/participants/:id/reset-password` became **Email sign-in code** (§2 F).
The unused columns (`reset_code`, `linkedin_sub`, `linkedin_last_callback_key`,
`competitions.linkedin_signup_enabled`) are kept so no row changes; a stored
registration-field policy that still names `password` is read without it and the key is
dropped on its next save. A client that still sends `linkedin_signup_enabled` is refused
by name (`400 linkedin_signup_removed`). `users.linkedin_url` stays an ordinary optional
profile field; the certificate's "Share on LinkedIn" is a share link and unaffected.

---

## 6. The 48h verification grace

`self_enroll_grace_until` holds an unverified account's grace. It is stamped only by a
**DESK** code's redemption (below); a `/join` registrant is verified by the emailed code
that created the account, whatever the event's settings — the event's "Allow instant join"
switch is retired (operator ruling, 14 Nov 2026), and a create, an edit or a template
naming it is refused `400 self_enroll_instant_removed`. Redeeming an EMAILED code sets
`verified=1` and clears the grace outright, so the grace is a backstop for pre-upgrade and
imported unverified accounts (§4b).

- **`requireParticipant`:** admits an active grace, rejects once it lapses mid-session
  (destroys the session; the SPA treats the 403 as a forced sign-out) — **unless the
  session is an impersonation**, where it neither rejects nor destroys.
- **Cleared** on every `verified=1` transition: the verify link, `/confirm-email`, admin
  force-verify, an EMAILED sign-in-code redemption and the participant-import overwrite.
  `verified=1 ⇒ grace NULL` is the invariant a new verification path must preserve.
- **A second writer:** redeeming a **DESK-revealed** (or NULL-provenance) code stamps a
  fresh `now + 48h` grace on an unverified account, re-stamped on every desk redemption.
- **The password door neither clears nor stamps it.** An unverified account inside an
  active grace may sign in with its password; outside one, a correct password is answered
  `{ok:false, error:"verify_by_code"}` and the way in is an emailed code, which verifies.

---

## 7. Self-enroll enrolment timing — one model

**Enrolment fires at the FIRST AUTHENTICATED entry.** All paths converge on
`_selfEnrollEnrollTxn` (idempotent `INSERT OR IGNORE`); the shared ladder before it is
`_enrolAtSignIn` (`lib/self-enroll.js`): the event still exists and accepts entries
(`_competitionAcceptsSelfEnroll`), `staffRowRefusal`, and the late-window took-part rule.

| Path | When enrolment happens |
|------|------------------------|
| Already signed-in participant follows a link (`POST /api/competitions/join`) | **immediately** |
| Register + `joinToken` (a NEW address, path C) | at the account's first successful sign-in — the one the registration makes, or, while it waits for approval, the first later one (`_consumePendingSelfEnroll` drains `pending_self_enroll_comp_id`: the registration, the code redemption on both the emailed and the desk branch, and the password door). The marker is honoured even after the link is switched off or replaced: the registration already passed the link (path C step 1c) |
| An EXISTING address on a join form, or a code requested from the login card opened by a join link (`joinToken`) | at the code redemption, emailed codes only (`_consumeCodeBoundEnroll` with the code's `login_code_comp_id`), and only in a browser whose own code request named that event through its join link as it is now (`_sessionNamedEvent`, path C steps 1 and 1c: elsewhere, or once the link is switched off or replaced, the code signs in and joins nothing); never an admin-tier account (operator ruling, 17 Nov 2026), nor staff on a `staff_compete` event, whom the SPA asks first, nor a code its browser untied ("Not your event?", path C step 1b). A password sign-in carries no event binding and enrols in nothing beyond the join marker |

`assigned_by='self_enroll'`, `direct_assigned=1` on the membership row.

**The late-entry window admits NEWCOMERS only.** When the event has ended and is admitting
through its window (`competitionAdmission` answers `"late"`), a NEW row is refused to
anybody who took part in it before it ended (`lateWindowAdmissionDenied`): at
`POST /api/competitions/join` that is `409 {code:"late_entry_took_part"}`; at a deferred
consume the marker is cleared and a `log.warn` written. A late entrant's held row takes the
ordinary promotion (`lateEntryStateFor(...).isLate`).

---

## 8. Profile-completion gate

`_profileMissingFields(user)` (**`lib/util.js`**) returns the unset/free-email subset of
`company`, `title`, `country`, `timezone` (always demanded), `corporate_email`, and each of
the five configurable sign-up fields — `personal_title`, `phone`, `city`, `linkedin_url`,
`job_function` (`lib/registration-fields.js`) — whose resolved state is `required`. Since the short form (29 Oct 2026) no kind's DEFAULT requires any of the five, so an ordinary account owes only the base set; only an event whose own form requires a field asks for it.
**`corporate_email` is computed OUTSIDE the configurable set by design**, so it can never
drop out silently with them. The states are resolved from ONE event, the one the account
was created through — never the event the participant is currently in:

- **While `registration_competition_id` resolves** (path C, or path G with an event
  chosen), the gate reads that event's CURRENT form (`registrationFieldStates`).
- **Once that event is deleted, or when there is no pointer**, it answers from the kind
  defaults of the stored `profile_policy` (`registrationFieldDefaultsForKind`).

A legacy `registered_via='linkedin'` account is asked like any other (operator ruling,
14 Nov 2026): it edits its names and LinkedIn URL itself, so a required `linkedin_url` is
demanded of it too.

**It THROWS on an under-selecting row** — an absent `profile_policy` or
`registration_competition_id` KEY, or a non-NULL pointer with no joined `_reg_event_kind` /
`_reg_field_policy`. Use `PROFILE_GATE_COLUMNS` / `PROFILE_GATE_JOIN` (`lib/util.js`). The
non-dismissible `openProfileCompletionGate` overlay fires from **four** client entry points:

1. `finishSignIn()` — after every sign-in door (the code redemption, the account password,
   the break-glass password and the sign-up a redeemed proof completes), after the Set your
   password prompt when the answer carries `password_required` (§5).
2. `selectCompetition()` — on a `profile_incomplete` 400.
3. The **`boot()` path in `main.js`** — on every authenticated page load. Guarded to participants.
4. `loadMyCompetitions()` — on the same `profile_incomplete` 400, reached when an organiser
   makes a field mandatory mid-session. An admin tier gets an explanatory panel there, never
   the gate.

**AN ADMIN TIER IS NEVER PUT BEHIND THIS GATE.** What suppresses it at sign-in is the SERVER
sending `missing_fields: []` for every admin tier on every account sign-in answer (`_signInAs`, `routes/auth.js`).
`GET /api/me` reports the real set for every role. An admin who chooses **Switch to Participant View**
with an incomplete profile is stopped by a DISMISSIBLE modal (`confirmParticipantViewProfile`).

All four triggers **`await` the gate before building the participant nav / routing**, and
after each save the gate re-reads `GET /api/me` and **re-opens itself** if anything is still
missing.

**Server-side enforcement.** Two endpoints are genuinely ungated:
`POST /api/competitions/:id/leave` and `GET /api/me/certificates`. Otherwise
`requireCompleteProfile` (`lib/middleware.js`) returns `400 {error:"profile_incomplete",
missing:[…]}` and gates every no-competition-context action endpoint:

| Gated | Endpoints |
|-------|-----------|
| `requireCompleteProfile` (no-context actions) | `GET /api/my-competitions`, `POST /api/select-timeslot`, `POST /api/deselect-competition`, `GET\|POST /api/competitions/:id/reminder`, `POST /api/competitions/join`, `POST /api/competitions/:id/badge` |
| baked into `requireCompetitionContext` (every competition-scoped endpoint) | `/api/status`, `/api/tasks`(+`/:id`), submit / hint / navigated-away / feedback, `/api/leaderboard`, `dismiss-ended` |
| inline check (kept) | `POST /api/select-competition` |

**Deliberately exempt** — the endpoints an incomplete user needs to FIX or manage their
account: `GET`/`PUT /api/me`, `PUT /api/me/sign-in-method` (the Set your password prompt runs
before the gate), `logout`, `resend-verification`, `csrf` / `config` /
`session-status` / `keepalive`.

---

## 9. Email inventory

| Email | Trigger | Recipients |
|-------|---------|-----------|
| **Sign-in code** (`login_code`) | `POST /api/auth/code/request` for an address an account holds as its PRIMARY (a code account's Continue, or a password account's "Email me a code instead"), and the admin **Email sign-in code** action | the account's PRIMARY address only — a secondary never receives a code. Names the bound event only when redeeming would add the account to it, saying that signing in in the browser where the code was asked for joins it, as long as its join link is still open (path C step 1c). Redeeming an EMAILED code verifies (and normally approves) the account; a desk-revealed one does not |
| **Address proof** (`email_proof`) | `POST /api/auth/code/request` for a work address no account holds (never a free-mail one without a live invitation for it, never one reserved as somebody's secondary or pending primary) | the typed address. Subject "<platform> — Your sign-in code"; says the address has no account yet; redeeming it opens the sign-up form. With an event bound, it says an account created in the browser where the code was asked for will join it, as long as its join link is still open. Its `email_sent` record (orphaned) names `to_domain` and the `ep_` fingerprint `to_fp`, never the address, and `error:"send_failed"` in place of SMTP text |
| **Password set / changed** (`password_changed_notification`) | `PUT /api/me/sign-in-method` sets a first password or changes one | the PRIMARY address only. Transactional. Subject "<platform> — Your password was set" or "…was changed" (the second adds that other browsers were signed out). No action link (only a plain Sign In link to the platform): if it was not the owner, the remedy it gives is an emailed code ("Email me a code instead"), a new password under Profile → How you sign in, and telling an administrator |
| Verification | `POST /api/resend-verification` only (the proof or a code verifies) | primary + secondary |
| Invitation | `POST /api/admin/invitations` | invited address |
| Approval | admin approves a pending account | primary + secondary |
| Lockout | 10 wrong sign-in codes, passwords or current passwords (one budget) within 5 min → 1 h lock | primary + secondary. An alarm: says the account has been marked as locked until the stated time (it never says the lock keeps guesses out, as it refuses none). No reset link: says a correct password or emailed code still signs in and lifts the lock |
| Unlock | lock expiry (background poller; held, the lock kept, while maintenance mode is on or the database failed its boot integrity or schema check), admin unlock | primary + secondary |
| Account denied | `POST /api/admin/participants/:id/deny` | primary + secondary |
| Reminders / bulk | scheduler / bulk send | primary + secondary; carry one-click unsubscribe |

`_BULK_EMAIL_REASONS` is exactly `{invitation, competition_assignment, reminder,
removed_from_competition, certificate_awarded}` — those five are SUPPRESSED for an opted-out recipient and carry
List-Unsubscribe headers; everything else (sign-in codes and the password notice included)
bypasses, because unsubscribing must not remove somebody's way in or a security notice
about their account. EMAIL_RULES.md §7 lists every reason.

---

## 10. Deliberate dispositions (do not re-flag)

- **Corporate-email rule:** enforced on every registration write path that creates an
  account from a submitted form via `isFreeEmail`, with **five** exceptions: an admin
  `invitationId` (and the profile gate re-imposes `corporate_email`), the participant
  import, a superadmin's participant edit, Roles & permissions Add user (an admin account may
  use a personal address: operator ruling, 24 Nov 2026; §2 F), the last three audited
  `bypassed_free_email_rule`, and `POST /api/admin/perf/bulk-seed-users` (perf tooling).
  An EXISTING address on a registration form skips it because nothing is created.
- **The sign-in-method lookup is an enumeration** (operator ruling, 11 Nov 2026):
  `POST /api/auth/sign-in-method` tells whether an address is a password account — by
  default every unscoped admin — and whether that account has set its password. Accepted;
  every other outcome answers `code`, and the code request and redeem stay uniform.
- **A secondary address never signs in** (operator ruling, 11 Nov 2026): no sign-in door,
  invitation or Add user resolves one, so a squatter who records someone else's address as
  their own secondary can sign nobody in through it, receive no code for it, and take no
  invitation or role addressed to it. **The residual**: the claim still reserves the
  address, so its real owner cannot register it (or move a primary to it) until the
  squatter's secondary changes — by the squatter, or by an admin editing that profile.
- **Duplicate people are not merged:** one person with two accounts under two addresses
  keeps both; no ids change.
- **Mail outage:** a password account that has set its password signs in without mail; a
  code account, and an unscoped admin who has not yet set one, cannot, and the desk reveal
  covers a participant who has never signed in. The built-in superadmin's break-glass
  password covers the platform.
- **A password is never the only door:** every account row can always ask for an emailed
  code (operator ruling, 11 Nov 2026), so a forgotten password costs a code and a new
  password (§5), never an admin's intervention.
- **`reset_code_emailed`:** the column was dropped long ago; it survives in `db.js` only
  inside its own DROP migration.

---

## Source map

| Concern | Files |
|---------|-------|
| register / verify / resend / logout / `confirm-email` / unsubscribe, **the emailed sign-in code (`/api/auth/code/{request,redeem}`), the entry card's method lookup (`POST /api/auth/sign-in-method`), the password door (`POST /api/auth/password`), the sign-in-method change (`PUT /api/me/sign-in-method`) and the shared sign-in bookkeeping (`_signInAs`)** | `routes/auth.js` |
| the sign-in method: role default, the usable-password rule, the wire block, the password policy, the dummy hash | `lib/login-method.js` |
| which account holds an address — `findUserByPrimary` (every sign-in door) and `findUserByAddress` (both slots; the audit actor enrichment) | `lib/account-lookup.js` |
| the built-in superadmin's `POST /api/login`, the SPA-shell paths, the credential body cap (`_AUTH_PATHS`) | `server.js` |
| the break-glass username (`getBreakglassUsername`, `validateBreakglassUsername`, `breakglassNameHeldByAccount`) | `lib/settings.js` |
| admin lifecycle (verify / approve / deny / block / unlock / role), **Email sign-in code, the desk reveal and the at-desk invite** | `routes/participants.js` |
| Roles & permissions: Add user (primary only; a secondary refused `email_is_secondary`) | `routes/users.js` |
| invitations (an existing account by primary; a secondary refused by name) | `routes/invitations.js` |
| the kicker's context and its method-dependent advice (`kickerContext`) | `lib/sessions.js`, `public/js/features/session-monitor.js` |
| `/api/me`, `PUT /api/me`, `select-competition`, `session-status` / `keepalive`, impersonation exit | `routes/participant.js` |
| self-enroll engine + grace classifier, **the staff row-writer rule** (`staffRowRefusal`) and the sign-in enrolment ladder | `lib/self-enroll.js` |
| claiming a live invitation for an existing account at redemption | `lib/invitation-claim.js` |
| whether an enrolled staff member COMPETES (`staffCompeteOn`) and the competitor lock (`competitorGroupDenied` for groups) | `lib/staff-compete.js` |
| the sign-in code object (mint / normalise / verify / eligibility / provenance / binding / re-send suppression) | `lib/login-code.js` |
| the lockout threshold and its three columns — ONE owner | `lib/lockout.js` |
| the per-event sign-up form — five fields × three states and the per-kind defaults (`registrationFieldStates`, `registrationFieldDefaultsForKind`) | `lib/registration-fields.js` |
| `NO_PASSWORD_HASH`, email format, IP allowlist matching, **the profile-completion gate** (`_profileMissingFields`, `PROFILE_GATE_COLUMNS` / `PROFILE_GATE_JOIN`) | `lib/util.js` |
| `require_account_approval` | `lib/settings.js`, `routes/settings.js` |
| unverified-account reaper (§4b) + `sweepStaleVerifyCodes` | `lib/account-reaper.js` |
| impersonation write gate + session restore | `lib/impersonation.js`, `routes/participants.js` (enter), `routes/participant.js` (exit), `lib/middleware.js`, `public/js/features/impersonation.js`, `public/js/ui/nav.js` |
| email senders + recipients | `lib/email.js` |
| schema + migrations | `db.js` |
| SPA: login card (the password step and "Email me a code instead") / register / code dialog / Set your password / How you sign in / gate / boot | `public/js/features/auth.js`, `public/js/core/main.js`, `public/index.html` |

<!-- DOC-REGISTRY
# What THIS document claims to enumerate. Checked by
# `functional-core-b.api.spec.js > Docs hygiene`. Only the claims declared below
# are verified. Add a line when you add a claimed enumeration; an exemption
# needs a reason after `--`.
DOC-SYMBOL: requireCompleteProfile
DOC-SYMBOL: requireCompetitionContext
DOC-SYMBOL: requireParticipant
DOC-SYMBOL: impersonationGuard
DOC-SYMBOL: impersonationReadOnlyWriteAllowed
DOC-SYMBOL: actingAdminCompetesInTargetEvents
DOC-SYMBOL: impersonatorScopedCompetitionIds
DOC-SYMBOL: actingAdminId
DOC-SYMBOL: verificationGraceState
DOC-SYMBOL: isCodeEligible
DOC-SYMBOL: codeRecentlySent
DOC-SYMBOL: claimInvitationsForAccount
DOC-SYMBOL: _consumeCodeBoundEnroll
DOC-SYMBOL: untieJoinLinkBindings
DOC-SYMBOL: liveJoinLinkTag
DOC-SYMBOL: joinLinkTag
DOC-SYMBOL: NO_PASSWORD_HASH
DOC-SYMBOL: liveProofGrant
DOC-SYMBOL: issueProof
DOC-SYMBOL: redeemProof
DOC-SYMBOL: email_proofs
DOC-SYMBOL: getBreakglassUsername
DOC-SYMBOL: validateBreakglassUsername
DOC-SYMBOL: deleteUserCascade
DOC-SYMBOL: normaliseRoutePath
DOC-SYMBOL: first_verified_at
DOC-SYMBOL: self_enroll_grace_until
DOC-SYMBOL: password_set_at
DOC-SYMBOL: login_code_via
DOC-SYMBOL: login_code_comp_id
DOC-SYMBOL: pending_self_enroll_comp_id
DOC-SYMBOL: profile_policy
DOC-SYMBOL: registration_competition_id
DOC-SYMBOL: linkedin_signup_enabled
DOC-SYMBOL: linkedin_sub
DOC-SYMBOL: verify_code
DOC-SYMBOL: reset_code
DOC-SYMBOL: staff_compete
DOC-SYMBOL: staffCompeteOn
DOC-SYMBOL: staffRowRefusal
DOC-SYMBOL: competitorGroupDenied
DOC-SYMBOL: staffSpectatorIn
DOC-SYMBOL: skippedPrivileged
DOC-SYMBOL: skippedPrivilegedGroups
DOC-SYMBOL: skippedAuthors
DOC-SYMBOL: skippedStaff
DOC-SYMBOL: anchorLoginTime
DOC-SYMBOL: _stampLoginTimeIfLive
DOC-SYMBOL: competitionDenied
DOC-SYMBOL: alreadyAssigned
DOC-SYMBOL: skipped_memberships
DOC-SYMBOL: staff_not_competing
DOC-SYMBOL: author_competes
DOC-SYMBOL: actor_competes
DOC-SYMBOL: competitor_skipped
DOC-SYMBOL: competitor_cannot_edit
DOC-SYMBOL: adminAuthzDenied
DOC-SYMBOL: impersonatingHandDenied
DOC-SYMBOL: participantSessionDenied
DOC-SYMBOL: restoreImpersonationTargetInactive
DOC-SYMBOL: session_ended
DOC-SYMBOL: admin_access_revoked
DOC-SYMBOL: admin_session_ended
DOC-SYMBOL: REAP_GATE_SQL
DOC-SYMBOL: competitionAdmission
DOC-SYMBOL: lateWindowAdmissionDenied
DOC-SYMBOL: late_entry_took_part
DOC-SYMBOL: registrationFieldStates
DOC-SYMBOL: registrationFieldDefaultsForKind
DOC-SYMBOL: PROFILE_GATE_COLUMNS
DOC-SYMBOL: PROFILE_GATE_JOIN
DOC-SYMBOL: desk_registration_link_backfill_at
DOC-SYMBOL: login_method
DOC-SYMBOL: effectiveLoginMethod
DOC-SYMBOL: roleDefaultLoginMethod
DOC-SYMBOL: hasUsablePassword
DOC-SYMBOL: loginMethodWire
DOC-SYMBOL: dummyPasswordHash
DOC-SYMBOL: password_required
DOC-SYMBOL: login_method_is_default
DOC-SYMBOL: findUserByPrimary
DOC-SYMBOL: findUserByAddress
DOC-SYMBOL: deskCodeLive
DOC-SYMBOL: desk_code_live
DOC-SYMBOL: competitorRivalDenied
DOC-SYMBOL: breakglassNameHeldByAccount
DOC-SYMBOL: kickerContext
DOC-SYMBOL: sendPasswordChangedEmail
DOC-SYMBOL: password_changed_notification
DOC-SYMBOL: RECENT_CODE_SIGN_IN_MS
DOC-SYMBOL: verify_by_code
DOC-SYMBOL: email_is_secondary
DOC-SYMBOL: credential_changed
DOC-SYMBOL: RATE_LIMIT_PROOF_IP_PER_15MIN
DOC-SYMBOL: ipBudgetExceeded
DOC-SYMBOL: _signInAs
DOC-SYMBOL: _sendSignInCode
DOC-SYMBOL: _deskDuplicateRemedy
# §8's profile-completion gate table, in BOTH directions.
DOC-COVERS: requireCompleteProfile @ GET /api/my-competitions
DOC-COVERS: requireCompleteProfile @ POST /api/select-timeslot
DOC-COVERS: requireCompleteProfile @ POST /api/deselect-competition
DOC-COVERS: requireCompleteProfile @ GET /api/competitions/:id/reminder
DOC-COVERS: requireCompleteProfile @ POST /api/competitions/:id/reminder
DOC-COVERS: requireCompleteProfile @ POST /api/competitions/join
DOC-COVERS: requireCompleteProfile @ POST /api/competitions/:id/badge
DOC-SET: _IMPERSONATION_BLOCKED @ lib/impersonation.js = /api/auth/code/request,/api/auth/code/redeem,/api/auth/code/drop-event,/api/auth/password,/api/me/sign-in-method
DOC-SET: _BULK_EMAIL_REASONS @ lib/email.js = invitation,competition_assignment,reminder,removed_from_competition,certificate_awarded
DOC-EXEMPT: reset_code_emailed -- dropped long ago; §10 names it as removed, and it survives in db.js only inside its own DROP migration.
DOC-EXEMPT: first3_last3 -- an illustrative nickname example in §2, not a symbol.
DOC-EXEMPT: PUT /API/me -- a deliberate case variant, quoted because it names the bypass impersonationGuard closed. It must NOT resolve.
-->
