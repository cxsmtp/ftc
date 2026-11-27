# Email identity & modification rules

This document is the single reference for how email addresses are validated,
kept unique, and changed in Hack Arena. It complements [AUTH_PATHS.md](AUTH_PATHS.md)
(account lifecycle) and the inline notes in `routes/participant.js`,
`routes/participants.js`, `routes/auth.js`, `lib/email-identity.js`,
`lib/account-lookup.js` and **`lib/email.js`** — which owns the transport, the sender, the opt-out machinery
and every template, i.e. everything §6 and §7 describe.

> **Scope.** §§1-6 are about the ADDRESS: how it is validated, kept unique, and
> changed. §7 is about the MESSAGES — which mail each action sends, to which
> slots, and which of them an unsubscribe can stop. The two used to be separate
> documents' worth of subject with only the first written down.

Every account has up to two email slots:

| Slot | Column | Required? | Purpose |
|---|---|---|---|
| Primary | `users.email` | yes | The address the account is identified by, and **the only address it signs in with**. Every sign-in door — the code request, the code redemption, the password sign-in and the sign-in-method lookup — resolves the primary only (`findUserByPrimary`, `lib/account-lookup.js`). Sign-in codes and the password notice go to it alone (§7). |
| Secondary | `users.secondary_email` | no | Additional notification recipient; can satisfy the corporate-email rule. **Never a sign-in identity** (operator ruling, 11 Nov 2026): it never receives a sign-in code, never signs in and never claims an invitation (§3 *Secondary email*). `getUserEmails` returns `"primary, secondary"`, the `to` of most account mail — lockout, unlock, approval, verification (§7). |
| *(in-flight)* | `users.pending_email` | — | A staged primary change awaiting confirmation (see below). Never a sign-in identity until confirmed. |

## 1. Format gate + canonicalisation

**Printable-ASCII only (v7.7.12).** `isValidEmailFormat` (`lib/util.js`) — the
single shared validator every email write path calls (register, `PUT /api/me`,
admin edit, import, Roles & permissions → Add user (`POST /api/admin/users`), and **`POST /api/admin/participants/desk-invite`** — the v8.1.0 at-desk shortcut,
which creates a `users` row with an email and is the entry most easily forgotten
in a list like this; both the primary and secondary slots) — **rejects any address containing a
non-printable-ASCII character** (`/^[\x20-\x7E]+$/`). A Unicode address is
refused outright, not stored. This closed the NOCASE-folding uniqueness gap the
`COLLATE NOCASE` indexes had for non-ASCII case variants (see the CLAUDE.md
disposition). Legacy rows written before v7.7.12 may still carry a Unicode
address; `PUT /api/me` / admin edit only re-validate the email **when it
changes**, so those accounts aren't bricked.

**A single canonical addr-spec (v7.15.6).** The ASCII gate alone was not enough.
The old shape (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) accepted **mailbox syntax**:
`Alias<audit-bypass@gmail.com>` has one `@`, no whitespace, and `<`/`>` are
printable ASCII (0x3C/0x3E), so it sailed through both checks. Both business
rules then read the domain by splitting on `@`, so `isFreeEmail` saw
`gmail.com>` — not in the provider list — and a free-mail address **passed the
corporate-email requirement**; the NOCASE uniqueness indexes likewise saw a
distinct string, letting many stored identities target one real mailbox. The
domain side is now an explicit label grammar and the local side bans
``<>,;:"()[]\``. **The client mirror must stay string-identical** — its CI lock
*extracts* the server literal and also asserts behaviour, so tightening it again
cannot fail for the wrong reason.

**Canonicalisation.** On top of the ASCII gate, every email is **NFC-normalised
+ lowercased** (`normaliseEmail`, `lib/util.js`) at every write **and** at every
lookup (code request and redemption, the password sign-in, the sign-in-method
lookup, uniqueness checks). On the now-ASCII-only set
`normaliseEmail` is effectively a lowercase (NFC is a no-op on ASCII), retained
as defence-in-depth. Two case variants of the same address therefore always
compare equal — they can never both be stored.

## 2. System-wide uniqueness (cross-slot, including in-flight)

`emailIsTaken(addr, excludeUserId)` (`lib/email-identity.js`) is the single
predicate. An address is "taken" if **any** other account holds it in **any** of:

- its primary `email`, **or**
- its `secondary_email`, **or**
- its non-expired `pending_email` (a staged change still inside its 48 h window).

The check is **symmetric**: it does not matter which slot the caller is filling —
a value can never collide with any other account's primary, secondary, or pending
slot, so one address can never live as both `A.email` and `B.secondary_email`,
and a lookup that matches either column (`findUserByAddress`, which the audit
mirror's actor enrichment uses) cannot resolve to the wrong row.

**A taken address that is no account's primary is RESERVED.** Somebody's
secondary, or somebody's pending primary change, names no account that can sign
in with it, yet nobody else may register it. The entry screen therefore sends
such an address nothing — no sign-in code and no address proof (recorded as an
orphaned `email_proof_refused` with reason `reserved_address`, naming the domain
and a fingerprint, never the address). Invite and Add user refuse an address held
as a secondary by name (§3 *Secondary email*).

`emailIsTaken` is enforced at **every** email write path:

- `POST /api/register` (primary + secondary)
- `PUT /api/me` (the staged new primary + the secondary)
- `PUT /api/admin/participants/:id` (admin edit)
- `POST /api/admin/import/participants` (overwrite re-validates the secondary)
- `POST /api/admin/participants/desk-invite` — **twice**: a pre-check, and an
  in-transaction re-check, because two desks can process one queue (v8.1.7)
- `POST /api/admin/users` (Roles & permissions → Add user), inside its write
  transaction; an address held as a secondary is refused as `email_is_secondary`
  (§3)
- `POST /confirm-email` re-checks **at confirm time** (see §3)

Primary and secondary on the **same** account must also differ
(`sameSlotEmails`) — at **every** write site, and note that neither uniqueness
index catches a violation: `uq_users_email_nocase` and
`uq_users_secondary_email_nocase` are per-COLUMN, so primary == secondary on one
ROW breaks neither. `getUserEmails` dedups defensively, so nothing looked wrong
until the account's next `PUT /api/me` re-submitted its own two equal addresses
and was refused 400. An expired `pending_email` no longer reserves its address —
abandoned changes can't lock an address out forever, and the confirm step's
re-check is the backstop for that window.

## 3. Changing the **primary** email — pending confirmation (v7.5.0)

**BOTH doors run this flow.** A participant changing their own primary via
`PUT /api/me` (v7.5.0), and — since v8.3.36 — an admin changing it via
`PUT /api/admin/participants/{id}` (§4). Neither swaps the address immediately
and neither logs anybody out. Instead:

1. The new address is validated (format, the corporate-email rule for both the
   live and the post-confirm state, `emailIsTaken`, and ≠ the secondary slot).
2. It is **staged** in `pending_email` with a single-use `pending_email_code`
   (UUID) + `pending_email_code_at` timestamp. The live `email`, `verified`
   state, and session are untouched.
3. A confirmation link (`/confirm-email?code=…`) is emailed to the **new**
   address. The response is `{ ok:true, emailChangePending:true, pendingEmail,
   emailDelivered }`. (Staging happens regardless of SMTP outcome — there is no
   lockout risk because the live account never changed; a non-delivered pending
   simply expires or is replaced on the next edit. `emailDelivered:false` tells
   the SPA to offer a retry.) **This is exactly why the admin route's old 503 +
   compensating-update contract was retired in v8.3.36: with nothing committed
   there is nothing to roll back.**
4. The user opens the link. **`GET /confirm-email`** renders a confirm button;
   **`POST /confirm-email`** (CSRF-protected) performs the swap.

   > **This no longer "mirrors `/verify`" — `/verify` is a one-click mutating GET
   > since v7.23.10, and `/confirm-email` is now the only one of the pair that
   > keeps the split.** That is deliberate, and §6 states the test it passes:
   > a prefetch here would silently swap the user's SIGN-IN ADDRESS, which is not
   > an outcome the recipient asked for at the moment the scanner acts. Verifying
   > an address is; swapping one is not.
5. At confirm time the server re-checks **two** address conditions —
   `emailIsTaken(pending_email, user.id)` (it may have been claimed since the
   request) **and** `sameSlotEmails(pending_email, secondary_email)` (the
   SECONDARY may have been changed to it in the meantime) — plus the 48 h expiry.
   Either failure answers **409 "Email no longer available"** and purges the
   pending columns, so there are **three** distinct outcomes, not two: invalid /
   already-used, expired, and no-longer-available.

   The claim then atomically swaps `email = pending_email`, sets `verified = 1`
   (the click proves ownership of the new address) and `first_verified_at`,
   clears any verification grace, clears all three pending columns, **and clears
   `verify_code` / `verify_code_at`** — because since v7.23.10 a retained
   verify_code is an idempotency RECEIPT attesting the address this statement is
   replacing, and leaving it would have it vouch for an address the account no
   longer has. Caches (`/api/me`, admin participants, leaderboard) are busted.

Cancelling: re-submitting the **current** email (or any non-changing `PUT
/api/me`) clears a prior pending change. `GET /api/me` exposes `pending_email`
(value only, never the code) so the profile editor can show
"Pending change to …".

**The parenthetical is doing more work than it looks.** The profile editor
pre-fills the email field with the CURRENT address and submits the whole form,
so *every* save from that dialog is a non-changing `PUT /api/me` for this
purpose — a save that only touched a timezone cancels a staged email change.
That is not a stale-tab race; it is the ordinary single-tab flow, and it is
also the ONLY way a participant can cancel, since no cancel control exists.
v8.3.34 made the dialog's pending-change note say so, rather than changing the
rule: removing the behaviour would remove the only remedy with nothing to
replace it (the FROZEN_REMEDY class). Give the editor an explicit cancel
affordance before narrowing this.

The confirmation code is a single-use, 48 h-expiry token (same TTL as the
`/verify` link's code). Since v7.7.38 it is **not** admin-only-log material: `?code=` is
scrubbed at WRITE time by `_scrubLogPath`, so it never reaches `access-*.jsonl`
at all — the read-time redaction for non-superadmins survives only as
defence-in-depth and for pre-v7.7.38 lines. It is not an enumeration oracle. Failure pages **never disclose an address**, and an invalid
or already-used code is indistinguishable ("Link not valid"). An *expired* code
shows a distinct "Link expired" page — matching the established `/verify`
precedent (`/verify-expired.html` vs `/verify-failed.html`) — which is not an
oracle, since reaching it requires already holding a real, >48 h-old code that
was only ever delivered to the target inbox.

### Secondary email

`secondary_email` changes apply **immediately** (no confirmation step), from the
profile and from an admin edit alike; it is the only email an admin edit writes
at save time (a primary change is staged, §4). It is subject to format +
`emailIsTaken` + ≠-primary validation. A **change of the primary** never moves
the secondary. A change of the secondary leaves a live sign-in code alone: codes
are mailed to the primary and redeemed against it only, so clearing one here
would only destroy the code its holder may be typing.

**It is UNVERIFIED, so it is never a sign-in identity** (operator ruling,
11 Nov 2026). Unlike a primary change — staged in `pending_email` and committed
only when the holder clicks the emailed link — nothing confirms that the person
who typed a secondary address controls it. Anyone can claim, as their secondary,
any address no account holds. So:

- **Every sign-in door asks the primary only** (`findUserByPrimary`,
  `lib/account-lookup.js`): `POST /api/auth/code/request`, the redemption
  (`resolveCodeAttempt`, `lib/login-code.js`), the password sign-in
  (`POST /api/auth/password`) and the sign-in-method lookup
  (`POST /api/auth/sign-in-method`). A code request for an address held only as
  somebody's secondary is reserved (§2): nothing is mailed, neither a code nor an
  address proof. A code or a password typed with a secondary address signs
  nobody in.
- **Invitations are claimed for the PRIMARY only.** Redeeming an emailed code
  claims the live invitations addressed to the account's primary, never to an
  address the request supplied.
- **`POST /api/admin/invitations` refuses an address someone holds as a
  secondary**: the address gets an `errors[]` line telling the admin to invite the
  person by their own sign-in (primary) address; nothing is stored, nobody is
  enrolled and nothing is mailed. An invitation stored for it could never be
  redeemed (sign-up refuses a taken address), and enrolling the secondary's holder
  would hand the event to whoever claimed the address.
- **Roles & permissions → Add user (`POST /api/admin/users`) refuses it** with 409
  `email_is_secondary` and no account id, so the client offers no "give that
  account the role": that would hand an admin role to whoever claimed the address.

What the secondary still does: it receives the mail addressed to both slots
(§7), it counts toward the corporate-email rule (§5), and an opt-out recorded for
it suppresses bulk mail to both (§6). The squatting residual is therefore only
that a person who stores someone else's address as their secondary stops its
real owner registering it, being signed up at a desk with it, being invited with
it or being added with it (the address is taken: sign-up and the desk refuse it,
and Invite and Add user refuse a secondary by name); they cannot sign in with it,
receive a code for it, or take its invitations or roles.

Anything else that treats an address as evidence of identity must ask which
slot it came from. CxOne provisioning is the precedent: matching a realm account
on any address the participant "owned", secondary included, let a participant
claim an address they had never proved and bind that account.
`lib/cxone-identity.js` takes proven and asserted addresses in separate buckets
and will not bind on an asserted one. Add a consumer of `secondary_email` and
make the same distinction.

## 4. Who may edit which email (admin matrix)

`PUT /api/admin/participants/:id` enforces a two-tier policy (see CLAUDE.md
"Admin edit-profile permissions"):

| Actor | Target | Email edit allowed? |
|---|---|---|
| Regular admin | normal participant | Yes — may fill a **blank** primary/secondary, and may change them on non-privileged targets. |
| Regular admin | admin / superadmin | **No** — blanket 403 on the whole profile (closes the email-hijack escalation vector). |
| Superadmin | anyone | Yes — every field, including both emails. |

"Allowed" means allowed to **request**: a primary change is staged (see below);
a secondary applies at once.

**Since v8.3.36 an admin primary-email change is STAGED, exactly as a
participant's own is** — the two doors finally run the same mechanism. The
transaction writes `pending_email` + a fresh single-use `pending_email_code`
(48 h) and nothing else; the live `email`, the `verified` state and the
participant's session are all untouched, and a *"Confirm Your New Email
Address"* mail goes to the NEW address only. `POST /confirm-email` performs the
swap. **The admin action is not the authorisation, and the participant must
still prove ownership** — that was always the rule; what changed is that the
proof now comes *before* the address moves rather than after.

Three consequences worth stating, because each was a real behaviour before:

- **A failed send costs nothing.** There is no 503, no compensating update and
  no rollback: nothing was committed, so nothing can be undone. The pending stays
  staged and expires in 48 h. (See §3 — this is the self path's own argument, and
  it is why the admin route's old rollback contract is retired.)
- **The participant is not signed out and does not lose verified status.**
  Before v8.3.36 the transaction set `verified=0`, which `requireParticipant`
  answers by DESTROYING the session and `ACTIVE_PARTICIPANT_SQL` answers by
  dropping them from the scoring set — both during an SMTP await a rollback
  could not undo.
- **An admin edit is a correction, not a compromise response.** The old address
  stays the account's until the participant confirms, so this control does not
  take an account away from whoever holds that mailbox. **Block** is the
  control that acts immediately.

**One pending slot, two writers.** An admin stage OVERWRITES a participant's own
staged change — the newer instruction wins — and mints a fresh code with it, so
the participant's already-mailed link stops resolving rather than committing the
admin's address under a mail describing a different one. The reverse case is the
cancellation rule in §3: a participant's ordinary profile save cancels a pending,
including one an admin staged. Deliberately, the admin route does **not** carry
that cancel rule: its dialog pre-fills the current address, so every unrelated
admin save would otherwise cancel a correction already in flight. An admin
cancels by staging a different address, or by letting the code expire.

## 5. The corporate-email rule

At least one of (primary, secondary) must be a **company** email (`isFreeEmail`
denylist, `lib/util.js`). On a primary change this is validated for **both** the
immediately-active state (current primary + new secondary) and the post-confirm
state (new primary + new secondary), so neither the live nor the future account
can end up free-email-only.

**There are five exceptions**, each intentional; the superadmin edit, the
import and Add user record `bypassed_free_email_rule` when they let a personal
address through:

1. an explicit admin **`invitationId`** at registration — the invitation blesses
   one specific, admin-validated address;
2. a **SUPERADMIN** admin-edit, which may save a two-free-email account; the
   refusal is `if (violatesCompanyRule && !isSuperAdmin)`, and the save is
   recorded as `bypassed_free_email_rule`;
3. the **participant import**, which does not enforce the rule at all —
   `isFreeEmail` runs *after* the INSERT on the create branch purely to stamp
   that same audit flag, and not at all on an overwrite;
4. **Roles & permissions → Add user** (`POST /api/admin/users`), which creates an
   account with an admin role (any role but participant) for any valid address,
   stores no secondary, and records `bypassed_free_email_rule: true` on its
   `user_added` when the address is a personal one (operator ruling, 24 Nov
   2026: a platform user may sign in with, say, a contractor's own address);
5. **`POST /api/admin/perf/bulk-seed-users`**, maintenance-mode perf tooling
   rather than a participant-facing path, which asks nothing and records nothing.

**The rule is never relaxed by an event's sign-up-form configuration.**
`corporate_email` is computed OUTSIDE the configurable set precisely so that
writing a Booth Event's sign-up form as a list of field names cannot silently
drop it — which would take the only barrier on a leaked join link with nothing
erroring. `secondary_email` is outside that set for the mirror-image reason: it
is the escape hatch that makes the rule satisfiable when a walk-up's primary
address is a personal one, so an event able to hide it could refuse a visitor
with no way for them to comply.

## 6. Enumeration / abuse resistance

- **Sign-in code request, redemption and registration** stay uniform (no "no such user") — see AUTH_PATHS.md.
- **The sign-in-method lookup is a deliberate, accepted exception** (operator
  ruling, 11 Nov 2026). `POST /api/auth/sign-in-method` tells the entry screen
  whether to show the password box, so it does say whether an address belongs to
  a password account — by default every unscoped admin. An unknown address, a
  code account, and a blocked or denied account all answer `method:"code"`; every
  non-empty input with no `@` gets the same password-only answer
  (`code_offered:false`), so the break-glass username is never confirmed.
- **The password sign-in** (`POST /api/auth/password`) answers 200 `{ok:false}`
  for every refusal and costs one bcrypt whatever the outcome (a dummy hash when
  there is nothing to check). Only a CORRECT password is told why it did not sign
  in (`pending_approval`, `verify_by_code`).
- **`POST /api/login`** serves only the built-in superadmin's break-glass
  username; any other name or address gets one generic 401
  (`use_sign_in_code`) with no lookup.
- **One source cannot have unlimited new addresses mailed.** Each address proof
  goes to a work address no account holds, at an anonymous caller's request, and
  no account's send budget caps it. `POST /api/auth/code/request` is limited to
  5 per (IP, address) per 15 minutes; on top of that, address proofs requested
  from one IP are capped at `RATE_LIMIT_PROOF_IP_PER_15MIN` (default 150 per
  15 minutes, the rate one IP could register new accounts at before sign-up
  began with the address proof), charged in the handler by `ipBudgetExceeded`
  (`lib/middleware.js`). The proof cap refuses SILENTLY: the request still
  answers `{ok:true}`, and the refusal is an orphaned `email_proof_refused` with
  reason `ip_budget`, naming the domain and a fingerprint, never the address (one
  IP's refusals of any reason are recorded up to that same budget per 15 minutes,
  and only counted beyond it) — a
  429 for new addresses alone would say which addresses have no account. Sign-in
  codes to existing accounts are not charged to it; they are capped per account.
  It is off when rate limiting is disabled. A walk-up rush from one venue NAT
  belongs in the event's trusted networks (or `RATE_LIMIT_ALLOWLIST_IPS`), which
  bypass both.
- **Confirm-email** failures never echo an address; invalid and already-used
  codes are indistinguishable, and an expired code shows a separate "Link
  expired" page (matching the `/verify` precedent — not an oracle, see §3).
- **Pending reservation** can hold at most **one** unclaimed address per account
  for ≤48 h, and only an address that passes the corporate-email + uniqueness
  rules — not a meaningful reservation-DoS surface.
- The confirm code lives in the query string like the verify code — but
  **it never reaches disk**. Since v7.7.38 `_scrubLogPath` rewrites every
  `?code=<token>` to `[REDACTED]` at **write** time, before the access-log line
  is persisted, so the raw code is not in the file for a log shipper, a backup,
  or a superadmin to read. (The older read-time redaction in
  `redactLogEntryForRegularAdmin` is retained as defence in depth and to scrub
  legacy pre-v7.7.38 lines.) The token is also single-use + short-lived.
- **The unsubscribe token is scrubbed too, and it is the one that matters most**
  (v7.21.14). `?token=` is stripped from the access-log path at write time
  because that token is valid for **365 days** — every other URL secret is 48 h
  or tied to a live competition — and its payload is
  `base64url(JSON.stringify({e:<email>,…}))`, **signed rather than encrypted**.
  A logged line would therefore not merely leak a capability, it would leak the
  recipient's address in a form anyone can decode. It reaches the log for exactly
  the reason it must be scrubbed: `GET /api/unsubscribe` exists *because*
  scanners and link-prefetchers follow every URL in an email (§ below), so those
  hits land in `access-*.jsonl` verbatim.
- **`GET /api/unsubscribe` is SAFE** (v7.15.11). The URL is advertised for RFC
  8058 one-click — in the `List-Unsubscribe` HEADER only; `buildEmail` appends no
  footer and no caller passes one, so it is not "inside the mail body" as this
  file used to claim. Scanners GET every URL in an email regardless, which would
  silently opt recipients out of invitations, reminders and assignment mail. The GET renders a **confirmation form**; only the POST mutates, so the
  mail-client one-click affordance is unchanged. **A GET must never mutate** — if
  another emailed action link is ever added, give it the same shape, **unless it
  passes all three tests recorded for one-click verification** (CLAUDE.md,
  v7.23.10): the mutation is the outcome the recipient requested, it grants no
  capability, and it presents idempotently. `GET /verify` passes all three and
  is one-click since v7.23.10; unsubscribe fails all three and keeps its form.
  - **The invariant is "no UNREQUESTED mutation", not literally "no write".**
    `GET /confirm-email` writes on its EXPIRED branch — it purges the pending
    columns, busts the me-cache and records `email_change_expired`. That is
    housekeeping on a dead code, visible to nobody and reversible by re-staging,
    so it does not fail the test; a reader auditing against the absolute wording
    would flag it wrongly.
  - `POST /api/unsubscribe` carries **no CSRF gate**, deliberately: a mail client
    has no cookies, so the HMAC token is the only authoritative signal. The route
    accepts it from the query string or the body (RFC 8058 posts the latter).
- **The signing key is `DATA_DIR/.unsubscribe-secret`** — 32 random bytes at mode
  0600, created on first boot. It is NOT derived from `SESSION_SECRET`, so a
  restart does not invalidate in-flight links; losing the file does, and costs
  nothing else. `scripts/backup.sh` covers it for that reason.
- **An unsubscribe is keyed on ONE ADDRESS, and suppression is wider than the
  opt-out.** `List-Unsubscribe` mints the token for the FIRST recipient only, so
  clicking it opts out the primary — but `_isUnsubscribed` tests EVERY address in
  the `to` field, so **one opted-out slot suppresses bulk mail addressed to both**.
  A participant who unsubscribes an old secondary therefore stops receiving
  reminders at their primary, and nothing on either screen says so.
- **Reversal is superadmin-only.** The unsubscribe page says *"Contact your event
  organiser to be re-subscribed"*, and the remedy (`DELETE
  /api/admin/unsubscribed/:email`) requires a SUPERADMIN — a regular admin at a
  desk cannot perform the action the page sends the recipient to ask for.

---

## 7. What the platform SENDS (v8.3.6)

§§1-6 are about the address. This is about the messages — and it was missing
entirely, which is how "the corporate-email rule has one exception" and "the
unsubscribe URL is in the mail body" both survived in this file.

**One pipeline.** Every mail goes through `sendEmailLogged` (`lib/email.js`),
which resolves the sender, waits for a free relay connection, asks whether the
recipient still exists, applies the opt-out gate, sends, and records
`email_sent`. The single exception is `POST /api/admin/test-email`, the SMTP
diagnostic, which skips the recipient checks and the `email_sent` record on
purpose (it reports the relay's own answer), but still waits for a free relay
connection like every send.

**EVERY SEND IS RECORDED, WITH OR WITHOUT A USER ROW (v8.7.6).** The record went
to `user_events.email_sent` **only `if (userId)`** — and at the time exactly two
call sites passed null (today the address proof and the event-team report do
too): `POST /api/admin/invitations` (the invitee has no account yet) and the
IP-ban alert. Both sent real mail and recorded **nothing anywhere**: no row, no
mirror line, so "did the invitation go out?" was answerable only from the relay's
own logs, which are not ours to read. v8.3.7 made this exact correction to the
SUPPRESSION branch — its own words, *"the `if (userId)` guard was right about
WHERE to write and wrong about WHETHER to"* — and made it only there. A send with
no user row is now an ORPHANED `email_sent` event (app.jsonl plus its
`orphan_events` copy, the established shape), carrying the address, which is the
only identifier such a send has — with one exception: the address proof, mailed
at an anonymous caller's request, is recorded by the address's domain and a
fingerprint, never the address (`email_proof` in the inventory below).
**And a caller that HAS a user but never passes its id is the same defect wearing
a different shape (v8.12.6):** the assign route's mail fan-out
(`POST /api/admin/competitions/assign`) SELECTed the recipient without `id`, so
every `competition_assignment` mail that route sent landed as an orphaned line and
never on the participant's own History (group sync's send of the same reason
always passed the id). It selects `id` now. An `email_sent` row missing
from somebody's History is therefore a question about the CALL SITE before it is
one about the relay.

**AND A REFUSAL TO SEND IS RECORDED TOO, on the one endpoint that had none.**
`POST /api/auth/code/request` refuses an ineligible account or a spent send cap
with the uniform `{ok:true}` and, until v8.7.6, no trace at all — reported as
*"emails don't arrive and the log shows no event of sending, or of refusing to
send."* `login_code_refused` now lands on the participant's own history with the
reason; the HTTP answer is unchanged, because the anti-enumeration contract is
about the RESPONSE and the audit trail is admin-only. Mechanism, and the v6.20.x
back-fill that had shut that door system-wide, in `AUTH_PATHS.md` §*Emailed
sign-in code*.

**EVERY REASON BELOW IS DRIVEN END TO END, and the message is read off the wire**
— `tests/email-scenarios.spec.js` spawns a server against a real capturing relay,
because the shared test server points at a dead SMTP port and an `email_sent`
assertion only proves what we COMPOSED (it cannot tell a mail that is no longer
sent from one that is no longer logged). Its manifest is cross-checked against the
reasons the code really passes, in BOTH directions, so a new mail must be
exercised or exempted with a reason: seven of these had no spec naming them at
all before it, and it is what found the missing record above.

**The sender is two halves from two places (v7.26.0):** the **address** from
`EMAIL_FROM`, resolved once at boot — it is what SPF authenticates and where
bounces return; the **display name** from Settings → Platform Name, read per
send, so a rebrand needs no redeploy. Never compose this header by
concatenation: nodemailer re-parses a string and an embedded angle-addr wins,
which made an admin-settable field able to take over the visible From *and* the
SMTP envelope.

### The inventory

`to` is `getUserEmails(user)` — **primary + secondary** — unless stated. A ✉ in
the *Opt-out* column means the reason is in `_BULK_EMAIL_REASONS` and is
therefore **suppressible** and carries `List-Unsubscribe` headers.

| Trigger | `reason` | To | Opt-out |
|---|---|---|---|
| `POST /api/auth/code/request` for a work address NO account holds — the **address proof** (`lib/email-proof.js`); never for a free-mail address without a live invitation for it, nor a reserved one (somebody's secondary or pending primary change, §2), nor once the requesting IP's proof budget (`RATE_LIMIT_PROOF_IP_PER_15MIN`, §6) is spent. `POST /api/register` itself sends nothing (it signs the new account in, or leaves it in the approval queue) | `email_proof` | **the typed address only**. No user row exists, so the attempt is an orphaned `email_sent` naming the address's domain (`to_domain`) and its `ep_` fingerprint (`to_fp`, the scheme the proof's own audit events use) — **never the address** — and a failure as `error:"send_failed"`, never the SMTP text, which can quote it. An anonymous caller must not be able to write strangers' addresses into the audit store | — |
| `POST /api/resend-verification` | `verification` | both | — |
| `POST /api/auth/code/request` for an address that is an account's PRIMARY — not while a code it mailed under two minutes ago, or a desk code, is still live (both answer the usual `{ok:true}` and record `login_code_refused{reason:"recently_sent"}`) | `login_code` | **the primary only**: the typed address, which the lookup matched as a primary. An address held only as somebody's secondary is reserved and gets nothing | — |
| 10 wrong attempts within 5 minutes → a one-hour lock. One budget (`lib/lockout.js`) counts a wrong emailed code, a wrong password at the password sign-in (only for an account that signs in with a password it has set) and a wrong current password under Profile → How you sign in. The lock is an alarm, not a bar (it refuses no guess; each sign-in door's rate limits bound guessing), so the mail says the account "has been marked as locked until" the stated time and that a correct password or emailed code signs in and lifts the lock | `lockout` | both | — |
| lock expiry poller (held, the lock kept, while maintenance mode is on or the database failed its boot integrity or schema check) **/** admin unlock | `unlock` | both | — |
| `POST /api/admin/participants/:id/approve` | `account_approved` | both | — |
| `POST /api/admin/participants/bulk-approve` | `account_approved_bulk` | both | — |
| `POST /api/admin/participants/:id/deny` | `account_denied` | both | — |
| `POST /api/admin/participants/:id/login-code/email` (Email sign-in code; on an admin or superadmin account, superadmins only; refused 403 `competitor_cannot_edit` to an organiser competing alongside the participant). Sends nothing, answering `{ok:true, sent:false}`, when a code was mailed under two minutes ago (`reason:"recently_sent"`), while a desk code (shown by Show sign-in code or the desk sign-up) is still live (`reason:"desk_code_live"`), or when the send cap is spent (`reason:"send_cap_reached"`) | `login_code` | primary only | — |
| `PUT /api/me/sign-in-method` sets an account's first password (subject "… — Your password was set"; the "Set your password" prompt after sign-in uses the same route) or changes it ("… — Your password was changed", saying the account's other browsers were signed out). Choosing a method without a new password sends nothing | `password_changed_notification` | **primary only** | — |
| admin edit STAGES a primary change | `admin_email_change_verification` | **new address only** | — |
| `PUT /api/me` stages a primary change | `email_change_confirmation` | **new address only** | — |
| `POST /api/admin/invitations` (an event in its late-entry window: names the deadline, in UTC). An address held as somebody's secondary is refused in `errors[]` and not mailed (§3) | `invitation` | invited address only | ✉ |
| competition assign / group-sync add (an event in its late-entry window: names the deadline) | `competition_assignment` | both | ✉ |
| competition removal / group-sync remove | `removed_from_competition` | both | ✉ |
| the 30-second reminder dispatcher (held, rows untouched, while maintenance mode is on or the database failed its boot integrity or schema check; a reminder already due when a restore's step 4 chose mark-sent counts as sent; the lead time is computed at SEND time, rounded to the nearest minute, in three bands, subject / body: 55 minutes or more "starts in 1 hour" / "starts in about 1 hour"; 2–54 minutes "starts in N minutes" / "starts in about N minutes"; 1 minute or less "starts in a minute" / "starts in about a minute". A reminder is not sent once the start has passed: one whose event or session has started by the time it is claimed is settled without a mail (History `reminder_skipped`), and one cannot be set in the last minute before the start, 400 `start_reminder_too_late`) | `reminder` | both | ✉ |
| IP-ban alert | `ip_ban_alert` | one superadmin per call | — |
| an event fully ends (End Now, the scheduler's time expiry, the all-solved auto-end, the last session ending, Close late entries now), about five minutes later; a Program participant's completing answer, about a minute later; an admin's Resend (`POST /api/admin/competitions/:id/certificates/resend`; refused for a holder whose account is blocked, denied or not approved); a superadmin's Issue again of a revoked certificate (`POST /api/admin/competitions/:id/certificates/reissue`, at once, with the event's email switch on). After a restore whose step 4 chose mark-sent (`scripts/restore-mail.sh`), nothing about an end before the restore is sent automatically — the congratulations email: a warm thank-you paragraph per tier (1st, 2nd, 3rd, participation, completion; editable as `email.message_<tier>`), **the certificate PDF attached**, a download link, the verification code, and a **Copy my LinkedIn post** button to a one-time, seven-day share page that needs no sign-in | `certificate_awarded` | both | ✉ |
| an event with a team fully ends, 15 minutes later (revived meanwhile: nothing; after a restore whose step 4 chose mark-sent, nothing about an end before the restore, nor that week's Monday digest); Close late entries now, the late window lapsing or a re-end after an extension (only the new leads); a running Program, weekly on Monday, then at its deadline; 48 hours after a wrap-up (nothing while the event is open again; once it ends again, 48 hours after that end's report, unless a reminder has already reached somebody for the event: one that ran with nobody waiting does not count), only to owners of hot leads not marked contacted who have not opted out (nothing when only opted-out ones wait), with a count to Marketing; an admin's Send now (`POST /api/admin/competitions/:id/team-report/send`; answered within 10 s, the rest carrying on, and refused while one is still going out) — one report per role, each opening with one call to action, a button only for a recipient whose address is an account able to open the event (anyone else is told the next step in words they can act on without the page, with no link); Marketing's carries the CRM CSV (none while nobody has taken part), and each SDR's lists every lead's address and carries a CSV of their own leads (not the 48-hour reminder). A failed send of an automatic report is tried again for that recipient (after 5 and 30 minutes, three passes in all) and never to anyone already sent it; a pass that fails before it can send (the report cannot be built) is tried after 30 minutes and given up after the third, recorded as `team_report_given_up` on the event's History | `event_team_report` | **the team member's address only** (no user row: an orphaned email event that records the address's domain and a `tm_` fingerprint, never the address; once the member is removed from the event's team, the event's send ledger keeps only that domain and fingerprint too, and the same address added back is never sent a report it already received). Internal staff mail, so transactional: no unsubscribe link or header, and no suppression; every report's footer (both parts, not a link) says "To stop receiving these, ask the event's organiser to remove you." (operator ruling, 24 Nov 2026). The address must be on the allowed-domain list at send time | — |

**v8.3.20 — the IP-ban alert BODY is rendered PER RECIPIENT.** It was the only outbound mail on the platform still hand-rolling a UTC date format; `git grep` for a hand-rolled date across `lib/`, `routes/` and `server.js` returned exactly that one line, while all eight other mail sites already used `formatEmailDate(d, user.timezone)`. The block deadline now lands in each superadmin's own profile timezone and NAMES it (`22 Aug 2026 17:45:00 (Europe/London)`), falling back to a UTC string that also names its zone when the profile timezone is NULL, empty or unrecognised — so a recipient is never skipped over a formatting input. The fan-out was already one message per recipient, so this costs no extra messages; `deliverAlert` now owns that loop so `alertCopy` stays the single source of the words. It also means `emailed` counts REAL deliveries: `sendEmailLogged` catches its own SMTP error and returns false rather than throwing, so the old shape recorded N deliveries into the `ip_ban_alert_raised` audit event whenever the relay was down.

**Sends NOTHING at all:** `POST /api/admin/participants/desk-invite` and Show
sign-in code (`POST /api/admin/participants/:id/login-code/reveal`), whose whole
point is to be immune to the greylisting that makes the desk fallback necessary:
the code appears on the organiser's screen. Nor do `POST /api/auth/sign-in-method`
and `POST /api/auth/password`, except the lockout notice when a wrong password
locks the account, and nor does the built-in superadmin's `POST /api/login` (it
has no address).

### Rules worth knowing before changing any of it

- **The certificate email (`certificate_awarded`, v8.15.1) is sent once per
  certificate, and is opt-out-able.** `lib/certificate-dispatch.js` is the only
  sender: the end paths queue a durable job, the worker issues each eligible
  participant's certificate (the mint's own eligibility) and mails it, and the
  ledger `certificate_emails` — keyed on the certificate — is written before the
  send, so no re-run mails one twice; a send cut by a crash is `unknown` and is not
  retried. It is in `_BULK_EMAIL_REASONS`: it announces something the holder can
  always collect from the event's Challenges page, so an opted-out address gets no mail
  (`suppressed`) and still gets its certificate. A failed send is retried twice
  (after 5 and 30 minutes). Every send (the first, its retry and Issue again's)
  re-asks the holder once the certificate is rendered: for a certificate revoked
  meanwhile, an account blocked, denied or no longer approved, or (the automatic
  send and its retry) a holder no longer in the event, nothing is mailed and no
  share link minted, and the ledger row is settled `skipped` and never retried. An
  admin's Resend is refused instead (409 `account_inactive` or
  `certificate_revoked`), leaving the ledger as it was. Per-event switch and wording: the certificate
  design's `email` section. Each attempt is also recorded as
  `user_events.certificate_emailed` (status, attempt, `via`). A restore chooses
  what happens to the mail about events that ended before it
  (`scripts/restore-mail.sh mark-sent|resend`, step 4 of RESTORE.txt). This mail,
  the event team's reports and the start reminders wait, their jobs queued, while maintenance mode is
  on or while the database has failed its boot integrity or schema check (until it
  is fixed and the server restarted); the hold only delays mail, it decides
  nothing, and an admin's Resend, Issue again and Send now are not held. The share link in
  it is minted only for a mail that goes out, is stored only as a hash, is bound
  to the certificate and works once (opening the page uses nothing; its
  "Copy post & open LinkedIn" press does, and publishes the certificate page); it
  expires after seven days, and the daily retention pass deletes it 30 days after
  that, after which its page is the ordinary not-found. Its download link to the
  PDF carries `?from=email`: mail scanners and link prefetchers open every link in a
  mail, signed out, as the holder's own click would, so a download through that link
  is recorded `via: "email_link"`, and the event's History and the Audit page say it
  may be a mail scanner (unless the holder's own signed-in session made it). The
  marker changes nothing else; the PDF is attached to the mail anyway.
- **No sign-up mails a verification link.** A new address is proved by the
  address proof before any account exists, so `POST /api/register` creates the
  account verified and sends nothing. It signs the account in, except when account
  approval is required and neither a live join link, QR or event code nor an
  invitation from someone who may approve accounts made the account:
  then it waits in the approval queue, not signed in (`pendingApproval:true`).
  Redeeming an EMAILED sign-in code also sets `verified=1` and establishes a
  session. It approves a pending account unless account approval is required (a
  code requested through a live event's join link, QR or event code, or an
  account's pending join to one, still approves it then); an account still waiting
  for approval is verified but answered `pending_approval`, with no session. A
  password sign-in verifies and approves nothing: only an emailed code proves the
  inbox, so an unverified account past its grace is told to sign in with a code
  first (`verify_by_code`). The `/verify` link is mailed only by
  `POST /api/resend-verification`, which mints the `verify_code` it carries.
- **A sign-in code goes to the account's PRIMARY address only** (operator ruling,
  11 Nov 2026): the request door mails the typed address, which its lookup matched as
  a primary, and an admin's Email sign-in code mails `users.email`. Requesting proves
  nothing, so the code goes nowhere but that inbox, and a secondary — an unconfirmed
  claim — never receives one. A code bound to an event (a join link, QR or join code)
  says so in its mail ("Signing in with it in the browser where you asked for it also
  joins you to …, as long as its join link is still open") only when redeeming it would
  add the account to that event
  (`codeBoundJoinWillEnrol`, a
  copy of the redeem's rules): an organiser checking their own join link, staff on
  an event where staff compete, somebody already in it, or anyone else the redeem
  would not add is told nothing about the event. (A sign-in can also enrol through
  a pending join marker or a claimed invitation; the mail promises neither.) The mail
  names the browser because the event counts only there: anyone holding the join link
  can ask for a code for any address, so a code redeemed in a browser that did not
  itself ask for one naming that event signs in and joins nothing (AUTH_PATHS.md path C).
  An address proof bound to an event says the same in its own words ("If you create
  your account in the browser where you asked for this code, it will join …, as long as
  its join link is still open"). The join holds only while the link stays open because
  switching it off or replacing it unties every code and proof already emailed through it
  (AUTH_PATHS.md path C step 1c).
- **A live code is never replaced while somebody may be typing it.** One mailed under
  two minutes ago (`codeRecentlySent`, `lib/login-code.js`): a double-submitted form,
  a second tab or somebody else typing the address answers the usual 200 and sends
  nothing, so the code in the inbox stays the one that works. A DESK code (shown by
  Show sign-in code — for an account that has never signed in, operator ruling,
  14 Nov 2026 — or the desk sign-up), for as long as it is live (`deskCodeLive`;
  operator ruling, 11 Nov 2026): the walk-up was told it works for its whole life,
  so neither the entry screen's Continue nor an admin's Email sign-in code
  (`sent:false`, `reason:"desk_code_live"`) mails a replacement. The desk rule is decided from the
  stored code's provenance and liveness, so a restart does not forget it; the
  two-minute rule is held in process memory, and after a restart only the
  account's send cap applies.
- **The lockout mail carries no reset or capability link** — only a Sign In button to
  the platform. Wrong codes and wrong passwords charge the same budget. The lock refuses
  no guess (it is an alarm; the sign-in doors' rate limits bound guessing), so the mail
  says the account "has been marked as locked" and never that the lock keeps guesses out,
  and its advice is the door that always works for an account row: a correct code from a
  fresh email signs the holder in and lifts the lock. (A correct password does too,
  on a password account.)
- **The password notice (`password_changed_notification`) goes to the PRIMARY only
  and cannot be turned off.** It is sent when an account sets its first password or
  changes one (`PUT /api/me/sign-in-method`); choosing a method without a new
  password sends nothing. It is a security notice, so it is transactional (not in
  `_BULK_EMAIL_REASONS`), and it goes to the address that signs in. It carries no
  capability link, only a Sign In button: the owner's remedy, if they did not make
  the change, is to sign in with an emailed code ("Email me a code instead"), set a
  new password under Profile → How you sign in, and tell an administrator. A changed
  password has already signed out the account's other browsers, and the mail says
  so. Sent detached (`trackDetachedSend`), so the save never waits on SMTP.
- **Anti-enumeration is a property of the SEND, not only of the response.**
  `code/request` answers `{ok:true}` for every outcome — which is worth nothing if
  the handler awaits SMTP, because response time then becomes the oracle. It
  dispatches the code or the address proof in the background (`trackDetachedSend`)
  for that reason. The password sign-in keeps the same property for its check (one
  bcrypt for every outcome), and the lockout notice it may trigger is sent detached
  too.
- **`user_events.email_sent` records `to`, `subject`, `reason`, `success` — and
  NOT the body or the From** (the address proof's orphaned record carries
  `to_domain` and `to_fp` in place of `to`). So a test can assert what was composed and never
  what was sent; anything about the bytes on the wire needs the capturing SMTP
  server (`tests/smtp-capture.js`). Grep `startSmtpCapture` for the specs that
  use it rather than trusting a list here — the two this line used to name had long
  stopped being all of them.
- **EVERY suppressed send is recorded (v8.3.7).** With a user row it writes
  `email_sent {success:false, skipped:"unsubscribed"}`; **without one** — the
  invitation path, whose invitee has no row yet — it writes an ORPHANED
  `email_suppressed` audit event carrying the address. Until v8.3.7 that second
  case wrote nothing at all, so an invitation withheld for an opt-out vanished
  with no record anywhere.
- **A mail is never sent to, or recorded against, an account that no longer exists
  (v8.12.6).** `sendEmailLogged` asks whether the user row still exists BEFORE the send,
  once the send holds a relay connection (so a mail waiting behind a backlog is asked when
  it leaves), and again AFTER it. Gone before: nothing is sent, and an ORPHANED `email_suppressed`
  (`skipped:"recipient_deleted"`, the user id and reason, **no address**) records why —
  every queued fan-out calls `sendEmailLogged` at run time, so a mail queued for somebody
  deleted a moment later is dropped. Gone after (deleted while the mail was in flight): the
  line is an ORPHANED `email_sent` with `recipient_deleted:true`, never a `user_events` row
  written back into the history the deletion erased. On the Audit page a reader without
  the Raw logs permission sees such a row (any orphaned `email_sent` naming an event)
  without its `to`, the erased address, and the row lists it in `withheld_fields`; the raw
  logs keep it for those who may read them. A dropped mail counts as a failure in
  the bulk assign / approve toasts, which is true — nothing was delivered.
- **An opt-out is not a delivery failure, and is no longer reported as one
  (v8.3.7).** `sendEmailLogged` answers `false` for both, which is the right
  single shape for the send path and the wrong one for the only caller that
  reports non-delivery to a human. The invitation route classifies with
  `isUnsubscribedAddress` and returns **`unsubscribedInvites`** separately from
  `undeliveredInvites` — **deliberately with no registration link**. The
  undelivered branch hands one over to "share manually", which is right when a
  relay is down and exactly wrong here: it would be the platform showing an
  operator how to route around the recipient's own choice while telling them SMTP
  had failed. The remedy named is re-subscribing the address (superadmin).
- **An event joined through its late-entry window is mailed its DEADLINE, not
  its dates (v8.12.6).** A Booth Event that has ended but is still taking late
  entries admits people through the assignment, group-sync and invitation doors,
  and "You have been invited to participate" above a start and an end that have
  both passed is misleading. All three builders use one line,
  `lateEntryMailLine` (`lib/competitions.js`), in place of the Starts/Ends pair
  (or, on group sync, the session list):
  it says the event has finished, that the recipient can still take part as a
  late entrant until the late-entry deadline, and that late entrants are ranked
  in their own section. The deadline is in the recipient's profile timezone on
  the two `competition_assignment` builders (the assign route and the group-sync
  add); the invitation has no user row yet, so it falls back to a UTC string that
  names its zone. The reason strings
  are unchanged — this is copy, not a new send. The same builder answers `null`
  for an event that is live or upcoming, whose mail is exactly as before.
- **An open-ended Program's mail says "Ends: No fixed deadline"** (operator
  ruling, 14 Nov 2026). The event form's **No fixed deadline** stores a deadline
  ten years out, and the assignment, group-sync and invitation mails printed it.
  All three take the Ends line from one helper, `eventEndMailText`
  (`lib/competitions.js`): for a Program whose deadline is five years or more
  away (`isOpenEnded`, asked when the mail is built, never stored) it reads
  "No fixed deadline", the start kept; a closed or dated Program and every other
  kind print the end as before. Copy only: the reason strings are unchanged.
- **Both approval paths now behave the same (v8.3.7).** `account_approved` and
  `account_approved_bulk` are byte-identical mail that differed only in whether an
  opted-out recipient received them — so one button had two behaviours depending
  on whether an admin approved one person or a batch. Equalised **towards
  delivery**: an approval is transactional, and belongs with verification and
  sign-in codes rather than with reminders. Equalising the other way would mean
  someone who once unsubscribed from reminders never learns their account was
  approved. The reason STRINGS stay distinct so the audit still distinguishes an
  individual approval from a batch.

<!-- DOC-REGISTRY
# v8.3.24 — see AUTH_PATHS.md's registry for the design. §7's inventory is the
# claimed enumeration here: every reason the code passes to sendEmailLogged /
# sendEmailBackground must be named in this document.
DOC-REASON: sendEmailLogged,sendEmailBackground
DOC-SYMBOL: sendEmailLogged
DOC-SYMBOL: sendEmailBackground
DOC-SYMBOL: isUnsubscribedAddress
DOC-SYMBOL: getUserEmails
DOC-SYMBOL: resolveSender
DOC-SYMBOL: trackDetachedSend
# v8.12.6 — the late-entry mail line, and the
# capturing-server entry point the prose now points at instead of a spec count.
DOC-SYMBOL: lateEntryMailLine
DOC-SYMBOL: startSmtpCapture
# The one Ends line of the assignment, group-sync and invitation mails.
DOC-SYMBOL: eventEndMailText
# The sign-in doors' primary-only lookup, the two live-code rules and the
# password notice's sender, each named in the prose above.
DOC-SYMBOL: findUserByPrimary
DOC-SYMBOL: codeRecentlySent
DOC-SYMBOL: deskCodeLive
DOC-SYMBOL: sendPasswordChangedEmail
# The per-IP address-proof budget §6 and the email_proof row describe.
DOC-SYMBOL: ipBudgetExceeded
DOC-SYMBOL: RATE_LIMIT_PROOF_IP_PER_15MIN
DOC-SET: _BULK_EMAIL_REASONS @ lib/email.js = invitation,competition_assignment,reminder,removed_from_competition,certificate_awarded
-->
