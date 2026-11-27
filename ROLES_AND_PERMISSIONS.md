# Roles and permissions

**The source of truth for who may do what in {{platformName}}.** Four roles, one
tier ladder, and one scope. When a permission changes, this file changes in the
same commit. The route matrix in §5 is written by hand from `lib/rbac.js`
`ADMIN_ROUTE_PERMISSIONS`, the enforced source: nothing generates it or checks
it against the code, so a route added later must be added here too.

---

## 1. The four roles

| Role | `users.role` | What it IS |
|---|---|---|
| **Participant** | `participant` | Competes. No admin surface at all. The default for every new account. |
| **Event admin** | `event_admin` | An organiser of **specific events**. Everything they can see and do is narrowed to the events they have been granted. Cannot create events from scratch (they may clone an event they organise, or spawn a template, and become the new event's organiser — v8.15.0), cannot change roles, cannot see the platform's own settings, logs or metrics. |
| **Admin** | `admin` | An organiser of the **whole platform**. Every event, every participant, every challenge. |
| **Superadmin** | `superadmin` | Admin, plus the irreversible and platform-wide controls: role changes, hard deletes, imports, retention, the global CxOne credential, the removal of Checkmarx One accounts left by deleted participants, the unsubscribe list, metrics. |

**How each role signs in** (AUTH_PATHS.md walks every path). Every account row
has a sign-in method — its password, or a one-time code emailed to its primary
address (`users.login_method`, `lib/login-method.js`; operator ruling, 11 Nov
2026). Until the person chooses one under Profile → **How you sign in**, the
ROLE decides (`roleDefaultLoginMethod`): an unscoped admin role — class `all`,
which is the built-in `admin` and `superadmin` and every custom role created
unscoped — signs in with a password; every other role (`participant`,
`event_admin` and every custom `granted` role) with an emailed code. A role
change moves only that default: a method the person chose stays theirs through
any promotion or demotion. An account whose method is a password but which has
none yet (an account created with, or promoted into, an unscoped role while it
has no method of its own chosen) signs in with
an emailed code and is then asked, at each sign-in until it answers, to set a
password or to keep using codes. A password never closes the code door: every
account row that may sign in at all (not blocked or denied) can still have a
code emailed from the sign-in card, so a forgotten password is recovered by
signing in with a code and setting a new one.

The built-in `superadmin` account (no `users` row) is the one account with no
code door. It signs in only with its password, regenerated at every boot into
`DATA_DIR/.superadmin-password`, on the ordinary sign-in card: its break-glass
username (the setting `breakglass_username`, default `superadmin`) goes in the
email box, and anything that is not an address shows the password box alone. It
is how an operator gets in when mail is down, and it has no sign-in page of its
own. It is a superadmin and is exempt from every per-row scope, having no id to
scope by.

### 1a. Permissions

Every admin route needs exactly ONE permission (`lib/rbac.js`
`ADMIN_ROUTE_PERMISSIONS`). The four built-in roles' permission sets are frozen
in code (`BUILTIN_ROLE_PERMISSIONS`), never stored, and reproduce the tiers below
exactly. "Grantable" says whether a custom role may hold it; a superadmin-only
one may be granted only by a superadmin, and "no" means only built-in roles hold
it (the role form refuses it by name, and a grant stored before it became
non-grantable gives nothing and was removed at boot).

| Permission | What it allows | Event admin | Admin | Superadmin | Grantable |
|---|---|---|---|---|---|
| `panel.access` | Open the admin panel | ✓ | ✓ | ✓ | yes |
| `events.view` | See events, their sessions, organisers and history | ✓ | ✓ | ✓ | yes |
| `events.edit` | Edit event settings, tags and sessions, and read the address the server sees you at (**Use my current address**, beside an event's Trusted network IPs; a role that may only create events types the address instead) | ✓ | ✓ | ✓ | yes |
| `events.run` | End events and sessions, close late entry | ✓ | ✓ | ✓ | yes |
| `events.join_link` | Reveal and regenerate join links | ✓ | ✓ | ✓ | yes |
| `events.clone` | Clone an event or start one from a template | ✓ | ✓ | ✓ | yes |
| `events.create` | Create events |  | ✓ | ✓ | yes |
| `events.organisers` | Add and remove event organisers |  | ✓ | ✓ | yes |
| `events.delete` | Delete events |  |  | ✓ | superadmin only |
| `templates.view` | See event templates | ✓ | ✓ | ✓ | yes |
| `templates.manage` | Create, edit and delete event templates |  | ✓ | ✓ | yes |
| `challenges.view` | See challenges, versions, attachments and feedback | ✓ | ✓ | ✓ | yes |
| `challenges.edit` | Create and edit challenges | ✓ | ✓ | ✓ | yes |
| `challenges.assign` | Assign challenges to events | ✓ | ✓ | ✓ | yes |
| `challenges.delete` | Delete challenges and feedback |  |  | ✓ | superadmin only |
| `challenges.lock` | Lock challenges and recalculate scores |  |  | ✓ | superadmin only |
| `challenges.sealed_reveal` | Reveal a sealed answer |  |  | ✓ | no |
| `participants.view` | See participants and their history | ✓ | ✓ | ✓ | yes |
| `participants.edit` | Edit participant profiles, tags and group membership | ✓ | ✓ | ✓ | yes |
| `participants.approve` | Approve and deny accounts: the row's **Approve**, the selection bar's **Approve** for several, and the approval an invitation gives an existing account waiting for approval (for a role scoped to its events, only a participant the invitation puts into one of its events). While **Require admin approval for new accounts** is off, an invitation to a new address and **At the desk** create approved accounts without it. While it is on, a role without it (only a custom role can lack it) is refused **At the desk** (403 `desk_approval_required`), and a new account made through its invitation waits for an administrator's approval, joining the invitation's events at its first emailed-code sign-in once approved; the inviter's permission is read when the invitation is used, and an inviter whose account is gone, blocked, denied or unapproved counts as unable to approve (operator ruling, 23 Nov 2026); an account that may approve inviting the same address again while the invitation is live makes the invitation theirs, so its newcomer is approved | ✓ | ✓ | ✓ | yes |
| `participants.block` | Block and unblock accounts | ✓ | ✓ | ✓ | yes |
| `participants.signin_codes` | Email or reveal sign-in codes | ✓ | ✓ | ✓ | yes |
| `participants.impersonate` | View as a participant | ✓ | ✓ | ✓ | yes |
| `participants.enrol` | Enrol, remove and invite participants | ✓ | ✓ | ✓ | yes |
| `participants.verify` | Mark accounts verified |  |  | ✓ | superadmin only |
| `participants.delete` | Delete accounts. Deleting a person also removes the Checkmarx One account the platform created for them; the delete confirmation says so to anyone holding this (operator ruling, 24 Nov 2026), and the message afterwards tells a holder without `ops.cxone` that a superadmin follows the removal up under **Checkmarx One account removals**, removes by hand an account the platform created but holds no record of, and checks the tenant for an account of theirs when a Checkmarx One set-up record of theirs could not be read |  |  | ✓ | superadmin only |
| `groups.view` | See groups | ✓ | ✓ | ✓ | yes |
| `groups.manage` | Create, edit and delete groups | ✓ | ✓ | ✓ | yes |
| `certificates.view` | See and download certificates, preview designs | ✓ | ✓ | ✓ | yes |
| `certificates.send` | Resend certificate emails | ✓ | ✓ | ✓ | yes |
| `certificates.design` | Edit certificate designs |  | ✓ | ✓ | yes |
| `certificates.revoke` | Revoke certificates and issue them again |  |  | ✓ | superadmin only |
| `certificates.lookup` | Look up a certificate by its code, see each certificate's code in an event's certificate list, and see a participant's certificate code, link and downloads while viewing as them |  |  | ✓ | superadmin only |
| `leaderboard.view` | See live rankings | ✓ | ✓ | ✓ | yes |
| `analytics.view` | See analytics | ✓ | ✓ | ✓ | yes |
| `audit.view` | See the audit trail (each kind of row also needs the permission that guards it elsewhere: see §1b) | ✓ | ✓ | ✓ | yes |
| `audit.raw_logs` | See the raw request and application logs |  | ✓ | ✓ | yes |
| `export.data` | Export event, participant and challenge data | ✓ | ✓ | ✓ | yes |
| `export.platform` | Export every event on the platform |  | ✓ | ✓ | yes |
| `export.settings` | Export platform settings |  |  | ✓ | superadmin only |
| `data.import` | Import challenges and participants |  |  | ✓ | superadmin only |
| `settings.view` | See platform settings |  | ✓ | ✓ | yes |
| `settings.edit` | Change platform settings |  |  | ✓ | superadmin only |
| `ops.alerts` | See and acknowledge operational alerts |  | ✓ | ✓ | yes |
| `ops.metrics` | Read platform metrics |  | ✓ | ✓ | yes |
| `ops.retention_view` | See data retention |  | ✓ | ✓ | yes |
| `ops.retention_purge` | Purge old event data |  |  | ✓ | superadmin only |
| `ops.cxone` | Manage Checkmarx One defaults and account removals |  |  | ✓ | no (operator ruling, 14 Nov 2026: the platform's key is a tenant credential covering every event) |
| `ops.email` | Send test email, manage unsubscribed addresses |  |  | ✓ | superadmin only |
| `ops.smtp` | Change the mail server (SMTP) the platform sends through |  |  | ✓ | no (owner decision, 27 Nov 2026: its password sends as the platform). Reading the mail server in use needs only `settings.view` |
| `ops.perf_seed` | Seed performance data |  |  | ✓ | no |
| `breakglass.self` | Manage the break-glass account (the built-in account only) |  |  |  | no |
| `users.view` | See platform users and roles |  | ✓ | ✓ | yes |
| `users.manage` | Add platform users and change roles |  |  | ✓ | superadmin only |
| `roles.manage` | Create, edit and delete custom roles |  |  | ✓ | superadmin only |

### 1b. Custom roles and Roles & permissions

A superadmin (or a custom role holding `roles.manage`) creates CUSTOM roles on
**Roles & permissions** (`routes/users.js`; `roles` / `role_permissions` tables). A
custom role has a label, a description, a scope mode — `granted` (acts on the
events its holders have `competition_admins` rows for, bound by every §4
predicate exactly as an event admin) or `all` (unscoped) — fixed at creation,
and a set of grantable permissions (`panel.access` implicit). The scope mode also
sets its holders' default sign-in method (§1): `all` a password, `granted` an
emailed code. A role edit is an
optimistic-concurrency PUT on `version`; holders see it within the role caches'
2 s. A role somebody holds cannot be deleted (409 `role_in_use`). Every role
write is a settings event keyed `role:<id>` (`role_created` / `role_updated`
with `permissions_added` / `permissions_removed` / `role_deleted`) with
`reqContext`.

**The escalation rule** (`lib/rbac.js` `roleAssignDenied`, `_validatePermissions`):
nobody gives, or takes away, a permission their own role does not hold; a
superadmin-only permission, or the built-in `superadmin` role, needs a
superadmin; the account's CURRENT role must also lie within the actor's set.
Self-demotion stays refused. The participant import holds to it too, since any
role holding `data.import` reaches it: an importer who is not a superadmin has a
row skipped and counted (`privileged_skipped`) when it would give a role beyond
their own, or overwrite an account that is a privileged target for them (§9.6). The role change itself is ONE handler behind two
doors: `POST /api/admin/participants/:id/role` (superadmin tier, unchanged) and
`PATCH /api/admin/users/:id/role` (`users.manage`). `POST /api/admin/users` creates
a new account holding a role (verified, approved, no password: it signs in by its
role's default method, §1, so an account given an unscoped role signs in first
with an emailed code and is asked to set a password) and re-asks `users.manage`
at commit. An address an account holds as its PRIMARY is answered 409
`user_exists` with that account's id, and the client offers to change its role
instead. An address someone holds only as a SECONDARY is answered 409
`email_is_secondary` with no id, so nothing is offered: a secondary address is an
unconfirmed claim, never a sign-in, and a role given through it would go to
whoever made the claim (operator ruling, 11 Nov 2026). The role dialogs offer only
the roles this session may give, and **Change role** only where it may move the
account off its role: `GET /api/admin/roles` carries both answers per role
(`can_give`, `can_take`), computed by `roleAssignDenied` itself. They never offer
the built-in Event admin (its scope is granted per event), and before a change
that leaves a role scoped to its events they say that every organiser grant goes
with it, and afterwards how many did.

**A platform-wide permission needs a role that acts on every event.** Its routes
reach beyond any one event, so nothing narrows them to a role's events: some read
about EVERY event (`audit.raw_logs`, `ops.alerts`, `export.platform`,
`export.settings`, `settings.view`, `ops.metrics`, `ops.retention_view`,
`ops.email`), some change what every event shares (`settings.edit`,
`templates.manage`, `certificates.design` — both design layers are global admins'
by operator ruling — `data.import`, `ops.retention_purge`), some act on a person
or a role no event bounds (`participants.delete`, `users.view`, `users.manage`,
`roles.manage`), and two put an event in someone's hands (`events.organisers`, the
organiser grant, which stays a global admin's; `events.create`, whose blank event
would sit outside the creator's scope: a scoped role creates by clone or
template, as an event admin does). A `granted` role is bound exactly as an event
admin, who holds none of them, so the role form refuses one on a `granted` role by
name (400 `role_permission_needs_every_event`; `lib/rbac.js`
`PLATFORM_WIDE_PERMISSIONS`) and the editor offers it only while **Every event** is
chosen. A grant stored before the rule grants nothing (`_readRoleDef` drops it), so
the gate, the routes' own guards, `GET /api/admin/me`'s `permissions` and the roles
list agree; a one-shot boot migration deleted those stored grants (re-run when the
set grew, `every_event_grants_pruned_at`), recording each role it changed as a
`role_updated` settings event by `system`. **Every other permission a `granted`
role holds narrows to its events on every route, the superadmin-tier ones
included**: requireSuperAdmin and requireGlobalAdmin admit such a role by its
permission (`customRoleAllows`), so each of those handlers asks the §4 predicate
an event admin meets — deleting an event (`competitionDenied`), verifying a person
(`participantDenied`, before the lookup), revoking or looking up a certificate
(`competitionDenied`; the lookup answers another event's code as an unknown one),
and deleting, locking or recalculating a challenge or purging its feedback
(`taskScoringEditDenied`). The scoped-handler scanner in
`tests/functional-core-b.api.spec.js` holds every such route to a row predicate
(lock: `tests/rbac-scoped-role-reach.api.spec.js`).
Roles & permissions also marks a RIVAL (`rival_in`, as the People rows do) and
withholds **Change role** on that row with the reason: the role change is a rival
door (§9.8).

**People and the sidebar.** `GET /api/admin/participants` (no `competitionId`)
leaves out the unscoped (class `all`) admin accounts unless `?kind=all` (People's
**Show admin accounts**, and every event workspace); participants and
grant-scoped organisers stay. For an event admin `?kind=all` is still narrowed to
their events, and the box shows only while a "show me this person" link has
ticked it (an administrator competing in one of their events). The admin sidebar shows an item only when the
role holds the permission its pane reads (`public/js/ui/nav.js`
`ADMIN_NAV_PERMISSIONS`), so a custom role sees exactly the pages it may use.
The panel opens on Events only for a role holding `events.view`, any other on
the first page it may use (New event opens for `templates.view` or for
`events.create`, which needs no template), and every pane loader and poll asks
its own permission before it reads (each refusal would count towards blocking
the address). Inside an event only the sections the role may read are offered
(`public/js/features/event-workspace.js` `SECTION_PERMISSIONS`). Every door
(row menus, the workspace header and ⋯ menu, the command palette) asks the
permission of the route it ends at and of each list its dialog reads: a list
the role may not read is left out and the dialog says so (Invite's events and
groups, the create form's and the template editor's challenge library, New
event's templates, the Logs Group filter, People's Score column), and a dialog whose writes the role lacks
opens read-only with the reason (a group's Members and Events, the join-link
toggles, a template the role may not start an event from, Add user when the
role may give no role). While **Require admin approval for new accounts** is on,
a role that may invite but not approve keeps People's **At the desk** in its
place, its tooltip and press giving the reason, sees the reason in place of the
event ⋯ menu's **Sign up at the desk**, finds no desk action in the command
palette, and is told in the **Invite** dialog that someone new it invites waits
for an administrator's approval. A name on a board or in a list links into another page
only when the role may open that page. These are held door by door
(`tests/rbac-custom-role-ui.spec.js`), not by a scanner: a new dialog that
reads a list or offers a write needs its own gate and its own arm. A
custom role is named by its label: on its holders' People rows (`role_label`,
`role_scope`), in their own account menu and in History (`role_changed` records
the label). Its holders switch to Participant View and back like any admin, and
the server tells the SPA the role in either view (`role_info` on the sign-in
answer, `GET /api/me` and `GET /api/admin/me`).
**Settings** opens for any of its cards' permissions (`settingsOffered`), and
**each card shows to a role holding every permission its routes check**
(`SETTINGS_CARD_PERMISSIONS`, `ui/nav.js`; operator ruling, 14 Nov 2026): the
platform name, sign-in and platform look cards need `settings.view` and
`settings.edit`, the mail server in use `settings.view` (its form `ops.smtp`,
superadmin only; everyone else reads "Only a superadmin can change this."),
outbound email and the unsubscribe list `ops.email`, the
Checkmarx One cards `ops.cxone` (superadmin only), retention
`ops.retention_view`, alerts `ops.alerts`, the team-report domains
`settings.view` (its Save `settings.edit`), and the break-glass card its own
session. So a built-in admin sees the certificate designer, the team-report
domains, retention and alerts, and a custom role sees the cards for the
permissions it holds. The Appearance page's Organisation default section,
which writes the same platform look, follows the platform look card's
permissions. The designer's Save is offered on `certificates.design`
(`certificateDesignOffered`), the predicate its routes enforce; an event admin
holds none of these permissions and sees no Settings item.

**The Audit page shows each kind of row only to a reader holding the permission
that guards the same rows elsewhere** (operator ruling, 14 Nov 2026):
`audit.view` opens it; event and session rows need `events.view`, people's
histories `participants.view`, platform settings changes `settings.view`,
challenge versions `challenges.view`, and submissions and hints are the page's
own. A logged event naming an event needs `events.view`; one naming none needs
`audit.raw_logs`, the Raw logs view of the same lines. A reader without
`audit.raw_logs` sees a logged event without what only the raw logs should show:
its request context (address, browser, request and session ids: a public
visitor checking a certificate, a newcomer asking for a code through the event's
join link), a deleted participant's Checkmarx One account id and an erased
recipient's address; the row names what was withheld (`withheld_fields`). An
address-block alert is not listed to them at all, as its subject is the blocked
address and the event it names is only whichever was live. Naming a kind the role
may not see is refused `audit_type_forbidden`, and the page hides that record
type's chip. The built-in roles see what they always did.

A custom role holding **View as a participant** (`participants.impersonate`) may
view a participant as them, an event admin's participant view included, but never
sits in an organiser's own panel: the entry (`{view:"admin"}`), the view switch
from their participant view and the panel's two live re-checks (`requireAdmin`,
`GET /api/admin/me`) all admit only the built-in admin and superadmin, through one
predicate (`lib/impersonation.js` `organiserPanelOpensTo`; lock:
`tests/impersonation-custom-role-panel.api.spec.js`). Not reachable for a custom
role: being impersonated (an account holding one is refused
`impersonation_target_custom_role`; the organiser-seat carve-outs exist for the
built-in event admin only), the sealed reveal, the perf seeder, the break-glass
username and the Checkmarx One defaults and removals (non-grantable). While any
admin views as a participant, that participant's certificate list, every answer of
the mint and the LinkedIn post carry the certificate's code and token (and every
link built from it) only when the acting admin, read live, holds **Look up a
certificate by its code** (`certificates.lookup`); otherwise they carry
`withheld: true` and the post answers as for an unknown certificate (operator
ruling, 23 Nov 2026; lock: `tests/impersonation-certificate-codes.api.spec.js`).

### The tier is not the scope

`users.role = 'event_admin'` is the **tier** — it is what `requireAdmin` admits
and `requireSuperAdmin` refuses. The `competition_admins` table is the **scope** —
which events that tier may act on. Neither is derivable from the other, and both
drift directions are safe:

- `role='event_admin'` with **zero** grants is a coherent, fail-closed state:
  every list comes back empty and every predicate refuses. This is what removing
  somebody's last event leaves behind, deliberately (§8).
- a `competition_admins` row for a user whose role is `admin` is **inert**: a
  global admin already sees everything, so the row grants nothing.

---

## 2. The tier gates

| Gate | Where | Admits |
|---|---|---|
| `requireParticipant` | `lib/middleware.js` | any live account — it checks the lifecycle, never the role |
| `requireAdmin` | `lib/middleware.js` | `admin`, `superadmin`, `event_admin` — and every custom role: any role whose class (`lib/rbac.js` `roleClass`) is not `none`. An unknown role key is `none` and refused. |
| `requireGlobalAdmin` | `lib/middleware.js` | `admin`, `superadmin` — **not** `event_admin`. One of the two independent gates on the grant/revoke pair (§8). A custom role passes only by holding, live, the route's permission, and a role scoped to its events then meets the handler's §4 predicate (§1). |
| `requireSuperAdmin` | `lib/middleware.js` | `superadmin` only — or a custom role holding, live, the route's permission (only a superadmin can grant one); a role scoped to its events then meets the handler's §4 predicate (§1) |
| `requirePermission(perm)` | `lib/middleware.js` | any role holding `perm`, read live (the Roles & permissions routes); never through an impersonation seat |
| `eventAdminGuard` | `lib/rbac.js` `permissionGuard` (exported under its historical name by `lib/event-admin.js`), mounted globally in `server.js` | see §3 |

Every one of them **re-reads the user row per request**, so a demotion, a block or
an out-of-band lifecycle change takes effect on the very next request rather than
at session expiry.

**…and a request already in flight is asked again at commit (v8.12.6).** A guard
answers when the request HEADERS arrive, and a few admin writes keep reading and
awaiting after that — the challenge-attachment uploads (body, ZIP walk, hash,
move) and the superadmin imports (body, and the participant import's
hashing pool), and since v8.12.7 the at-desk invite and the maintenance
seeder. They re-ask with `adminAuthzDenied` (`lib/middleware.js`;
grep `adminAuthzDenied(` for the set rather than trusting a count here),
synchronously with their first write: the account's lifecycle and role, read
uncached (superadmin only for the seeder; a superadmin, or a custom role still
holding `data.import`, for an import), and the session's own
revocation tombstone. A refusal writes nothing —
`403 admin_access_revoked` for a revoked account, `401 admin_session_ended` for a
session that ended mid-request (signed out, signed in elsewhere, the view switched or impersonation entered or left in another tab, a
colleague moving the account to another admin tier, or the idle sweep) — a
sentence that names no cause, because the tombstone says the session ended and not
whose act ended it, and no action either ("Your session ended before this finished,
so nothing was saved. Try again — if you are asked to sign in, do that first.").
**At the desk the commit asks more than the account:** whether the role may approve
accounts, while **Require admin approval for new accounts** is on, is asked again
(read live: the setting switched on or the permission removed meanwhile refuses
`desk_approval_required` and creates nothing), the event is re-read, and the
competitor lock and the scope are re-asked on a freshly read role and grant set, so
an organiser whose grant on the event is revoked while the account is being prepared
creates nothing and is shown no sign-in code. **A participant write made through
impersonation re-asks the impersonating admin at commit in the same way** (`impersonatingHandDenied`): the
answer submit and the certificate mint, which keep awaiting
after the impersonation guard has read the acting admin. A purged session answers
`403 impersonation_ended` with `reason:"session_ended"`; an acting admin who is no
longer an admin at all, `reason:"actor_inactive"` with the session destroyed and the
window closed; one still an admin but no longer a superadmin, the guard's own
`403 impersonation_readonly` — except on the mint, which that read-only tier may
make. Nothing is stored. **The participant tier re-asks its own session at commit
too** (`participantSessionDenied`, on the same writes, for every
session acting as its own account, whatever its role): an account blocked, denied
or deleted meanwhile gets the participant gate's own sentence, and a session that
ended meanwhile (signed in elsewhere, signed out) gets
`401 session_ended` with the sentence above; under impersonation a target that
stopped qualifying gets the participant gate's forced exit, the admin's own session
restored. The consequence for the event-admin tier is the
one that mattered: the scope predicates read any role that is not `event_admin` —
and a missing row — as UNSCOPED, trusting the guard to have vouched for the tier,
so an event admin demoted or deleted mid-upload used to write an attachment to a
challenge they did not own. They are refused now, and the direct upload also
re-asks the competitor lock and the owner question (with the role read fresh)
inside the same transaction, which is what catches an out-of-band narrowing that
the tier check admits.

---

## 3. `eventAdminGuard` — the default-deny route gate

Mounted immediately after `impersonationGuard`, before any route. It looks up
`METHOD /pattern` in `lib/rbac.js` `ADMIN_ROUTE_PERMISSIONS`, which gives every
admin route exactly ONE permission from the catalogue (§1a), and asks whether the
actor's role holds it (`guardDecision`). The two built-in global roles (`admin`,
`superadmin`) are never refused here — their routes' own guards answer, as before.
For the built-in event admin the answer is expressed in the historical
dispositions, which `lib/event-admin.js` still exports DERIVED from that map
(`EVENT_ADMIN_ROUTES` / `EVENT_ADMIN_FORBIDDEN`; the refusal sentences live in
`EVENT_ADMIN_DENY_COPY`). A custom role lacking the permission is refused
**403 `permission_denied`** (with `permission` naming it). The lock
`tests/rbac-builtin-equivalence.api.spec.js` compares every route frozen before RBAC
× built-in role against a frozen copy of the pre-RBAC maps
(`tests/fixtures/rbac-legacy-routes.json`; one entry, the create refusal's sentence,
hand-amended by operator ruling, 14 Nov 2026), and checks every later route's
permission against its own guard.

| Disposition | Meaning |
|---|---|
| `'scoped'` | reachable — and the **handler** must narrow rows or check the named entity |
| `'open'` | reachable, no entity to check (identity probes, logout, the per-admin attachment staging rows) |
| `'superadmin'` | passed through so the route's own `requireSuperAdmin` answers with its accurate message |
| `EVENT_ADMIN_FORBIDDEN` | refused **403 `event_admin_forbidden`**, with a reason that names who can do it instead, or the door this tier has instead (a blank event: a template or a clone) |
| *unclassified* | refused **403 `event_admin_unclassified`** and logged at error level |

**The last row is the point.** An `/api/admin/*` route added next year, by
somebody who has never heard of this role, fails **closed** until a human
classifies it. That is "a decision per item, never blanket coverage" applied to
route registration, and a scanner makes the omission go red rather than merely
fail at runtime.

**Under impersonation the two carve-outs that answer about the seat key on the
session SHAPE, not on the marker alone (v8.12.1)** — `isEventAdmin` and the
guard; `impersonatorScopedCompetitionIds` is about the participant surface and
deliberately still resolves the ACTING admin from the marker. An impersonation
session takes the target's own shape in whichever view was chosen:

- **Participant view** (marker set, `isAdmin` unset): the guard returns early and
  `isEventAdmin` answers false — `req.session.userId` is the target, not the
  acting admin, so a role read would answer about the wrong person, and no
  `/api/admin` route is reachable from that shape anyway. What such a session may
  SEE is asked separately, on the participant surface, through
  `impersonatorScopedCompetitionIds`, which resolves the ACTING admin from
  `req.session.impersonator` (§9.5b).
- **Event-admin view** (marker set, `isAdmin` true, an `event_admin` target): the
  guard RUNS, and `isEventAdmin`, `scopedCompetitionIds`, `actorId` and every row
  predicate answer about the TARGET — the impersonated organiser's grants, their
  ownership, their forbidden routes. The panel is theirs row for row, and the
  acting admin's own scope plays no part (§9.5d).

**The gate asks a question answerable from the path; it cannot ask *which events
may this session be shown* (v8.8.6)** — which is why the participant surface has
its own predicate. Do not collapse the two, and never let a participant-shaped
session be scoped as an admin one: making `isEventAdmin` true for the participant
view would re-scope every `/api/admin` read for it and repaint the participant
view (v8.7.3). The view — `req.session.isAdmin` — is what separates them.

---

## 4. The scope primitive — `lib/event-admin.js`

One module, one set of predicates. Every one returns **`null` when allowed**, or
`{ code, message }` when refused — the same shape drives the route's 403 and the
wire flag the client renders its offer from, so a control is never offered where
the server is certain to refuse.

| Predicate | Rule |
|---|---|
| `competitionDenied(req, id)` | the event is in the actor's scope |
| `taskViewDenied(req, task, tags?)` | **(a)** they created it, **or (b)** it is assigned to a scoped event, **or (c)** it carries the `public-domain` tag |
| `taskEditDenied(req, task)` | they created it — **owner only** |
| `taskScoringEditDenied(req, task)` | owner **and** every event holding it is in scope (§9.1) |
| `taskUnassignDenied(req, taskId, compId)` | the event is in scope **and** `competition_tasks.assigned_by_id` is this actor |
| `participantDenied(req, userId)` | enrolled in at least one scoped event **and not themselves privileged** (§9.6) |
| `memberTargetsDenied(req, userIds[])` | the batch form of the above |
| `groupViewDenied(req, groupId)` | they created it, or it is bound to a scoped event |
| `groupWriteDenied(req, groupId)` | **every** event the group is bound to is in scope (§9.2) |
| `groupDeleteDenied(req, groupId)` | they created it — **creator only** |

`scopedCompetitionIds(req)` returns `null` for an unscoped actor and an **array**
for an event admin. **`null` and `[]` are different answers** and every caller
must keep them apart: `[]` is an event admin with no grants, who must see
nothing. `scopeFilterSql` emits `AND 1=0` for that case. The hazard is the naive
`ids.length ? clause : ""`, which drops the clause and leaves the query
**unfiltered** for exactly that actor — measured, `IN ()` itself is accepted by
SQLite and evaluates false, so `1=0` is chosen for being explicit and portable
(standard SQL forbids `IN ()`, and `IN (?)` with no binding throws).

**This module is the SCOPE, and the scope is not the only rule over a challenge.**
Every predicate above returns early for an unscoped actor, so an administrator and
a superadmin pass all of them by design. A **sealed answer** is an orthogonal
OWNERSHIP rule that binds every tier — a superadmin included, until they REVEAL
it on the record (v8.12.2) — and it lives in its own pure module,
`lib/answer-seal.js`. It is checked alongside these, never folded into them — see
§9.7. The **competitor lock** (v8.12.0) is the third such rule and lives
in `lib/staff-compete.js` for the same reason: whoever holds a row on an event
whose **Staff can compete** switch is on may not change that event or its
challenges, superadmin included — see §9.8.

---

## 5. The route matrix

Written by hand from `EVENT_ADMIN_ROUTES` / `EVENT_ADMIN_FORBIDDEN` in
`lib/event-admin.js`, themselves derived from `lib/rbac.js`
`ADMIN_ROUTE_PERMISSIONS` and the built-in event admin's frozen permission set,
which are the enforced source of truth; nothing checks this table against them. `superadmin` rows are refused by the
route's own tier guard.

| Route | Event admin | Note |
|---|---|---|
| `GET /api/admin/alerts` | **forbidden** | Operational alerts cover the whole platform. To allow a venue's network, edit Trusted network IPs on your own event. |
| `POST /api/admin/alerts/:id/ack` | **forbidden** | Operational alerts cover the whole platform, so they are not available to event admins. |
| `GET /api/admin/analytics/challenges` | **scoped** |  |
| `POST /api/admin/attachment-staging` | open |  |
| `DELETE /api/admin/attachment-staging/:id` | open |  |
| `PATCH /api/admin/attachment-staging/:id` | open |  |
| `GET /api/admin/audit` | **scoped** | rows from their events only (people by the History dialog's rule, challenge versions by the three-way rule); platform settings rows are withheld, and naming that type is refused |
| `POST /api/admin/badges/:token/revoke` | superadmin |  |
| `GET /api/admin/breakglass-username` | **forbidden** | Only the break-glass account itself can see its username. |
| `PATCH /api/admin/breakglass-username` | **forbidden** | Only the break-glass account itself can change its username. |
| `DELETE /api/admin/certificate-config` | **forbidden** | Only an administrator can reset the platform certificate design. Ask one to make this change. |
| `GET /api/admin/certificate-config` | **forbidden** | Only an administrator can open the platform certificate design. You can preview your event's certificate. |
| `PUT /api/admin/certificate-config` | **forbidden** | Only an administrator can change the platform certificate design. Ask one to make this change. |
| `POST /api/admin/certificate-config/preview` | **scoped** | Renders sample data; with `competition_id` only for their own events. |
| `GET /api/admin/competition-tags` | **scoped** |  |
| `GET /api/admin/competitions` | **scoped** |  |
| `POST /api/admin/competitions` | **forbidden** | Event admins cannot create a blank event. Start one from a template, or clone one of your events. |
| `DELETE /api/admin/competitions/:id` | superadmin |  |
| `PUT /api/admin/competitions/:id` | **scoped** |  |
| `GET /api/admin/competitions/:id/admins` | **scoped** |  |
| `GET /api/admin/competitions/:id/team` | **scoped** | The event team (report recipients), targets and scheduled reports, for their own events. |
| `POST /api/admin/competitions/:id/team` | **scoped** | Their own events; refused to a competitor in the event. The address must be at a domain a superadmin allowed. A member is mailed what reading the reports takes, so the actor also needs `participants.view` (and `export.data` for the Marketing and SDR roles, whose reports attach a lead file: the CRM file, each SDR's own leads); a custom role without them is refused `permission_denied`. |
| `DELETE /api/admin/competitions/:id/team/:memberId` | **scoped** | Their own events; refused to a competitor in the event. |
| `PUT /api/admin/competitions/:id/team-targets` | **scoped** | The lead and hot-lead targets (a save over somebody else's newer targets is refused); refused to a competitor in the event. |
| `GET /api/admin/competitions/:id/team-report` | **scoped** | The persona views and lead list; refused to anyone competing in the event. |
| `GET /api/admin/competitions/:id/team-report/preview` | **scoped** | One role's report email as it would be sent (HTML and text, and whether its call to action is a button: only for a recipient whose address is an account able to open the event); refused to anyone competing in the event. A managers' preview's comparison with other events covers only those the sent report would (see Send now below) that the reader may also see. |
| `GET /api/admin/competitions/:id/team-report/leads.csv` | **scoped** | The CRM file, audited `data_exported`; refused to anyone competing in the event. |
| `POST /api/admin/competitions/:id/team-report/send` | **scoped** | Send now, for their own events (answered within 10 s; refused while the event's reports are still going out); refused to a competitor in the event. Needs `participants.view`, and `export.data` for a send to the Marketing or SDR role, asked by role even when no lead makes a file (those reports carry the CRM file and each SDR's own leads). A managers' report compares the event with recent ended events of its type; each manager's comparison covers only the events whoever added that manager may open now (and, when the manager's own address is an account scoped to its events, only those too), so an organiser who adds their own address as a manager is mailed nothing about other organisers' events. The scheduled reports follow the same rule. |
| `POST /api/admin/competitions/:id/leads/:userId/contacted` | **scoped** | Marks a lead contacted (SDRs have no login); refused to a competitor in the event. Its answer says whether the lead may still be reached (`contactable`) only to an actor holding `participants.view`, since it tells whether the person opted out of email. |
| `GET /api/admin/team-report-domains` | **forbidden** | Only an administrator can open the list of email domains in Settings. The domains your event's team may use are shown under its Team & reports. |
| `PUT /api/admin/team-report-domains` | superadmin | The allowed-domain list. |
| `GET /api/admin/competitions/:id/overview-pulse` | **scoped** | The workspace Overview's live figures; refused to anyone competing in the event, whose Overview then says the live figures are kept off the page while they compete and still shows **Joined** (the roster, never read from this route) and the certificate counts (their other reads stay open: operator ruling, 14 Nov 2026). |
| `POST /api/admin/competitions/:id/clone` | **scoped** | v8.15.0 — an event they organise; the copy grants them its organiser row. |
| `GET /api/admin/competitions/:id/export/full` | **scoped** | v8.15.0 — refused to anyone competing in the event. |
| `POST /api/admin/competitions/:id/save-as-template` | **forbidden** | Only an administrator can save an event as a template. You can clone your own event instead. |
| `POST /api/admin/competitions/:id/admins` | **forbidden** | Only an administrator can add an event organiser. Ask one to make this change. |
| `DELETE /api/admin/competitions/:id/admins/:uid` | **forbidden** | Only an administrator can remove an event organiser. Ask one to make this change. |
| `DELETE /api/admin/competitions/:id/certificate-config` | **forbidden** | Only an administrator can reset an event's certificate design. You can preview and download certificates. |
| `GET /api/admin/competitions/:id/certificate-config` | **scoped** |  |
| `PUT /api/admin/competitions/:id/certificate-config` | **forbidden** | Only an administrator can change an event's certificate design. You can preview and download certificates. (For admins: competitor lock first; once the event has ended and its end has passed, superadmin only.) |
| `GET /api/admin/competitions/:id/certificates` | **scoped** | The certificates an event of theirs has issued, with each one's email state; the badge token only for a superadmin, each certificate's code only for whoever may look certificates up by code (`certificates.lookup`), as joining codes to holders is what that audited lookup keeps restricted, and the Issue again answer for whoever may revoke (`certificates.revoke`). |
| `GET /api/admin/competitions/:id/certificates/:userId/certificate.pdf` | **scoped** | An issued certificate's PDF, which prints its code, recorded on the event's History as an organiser's download (`by_owner: false`): one holder per download, each one recorded. |
| `GET /api/admin/competitions/:id/certificates/:userId/badge.png` | **scoped** | Its share image, recorded the same way. |
| `GET /api/admin/competitions/:id/certificates/top3.zip` | **scoped** | The issued 1st, 2nd and 3rd place certificates of an ended event as one ZIP (**Download top 3 certificates**, **Top 3**); each file is recorded on the event's History. |
| `POST /api/admin/competitions/:id/certificates/resend` | **scoped** | Re-sends one holder's congratulations email; refused to a competitor in the event, for a holder whose account is blocked, denied or not approved (409 `account_inactive`), and for a certificate revoked while the email was prepared (409 `certificate_revoked`), nothing sent. |
| `POST /api/admin/competitions/:id/certificates/reissue` | superadmin | Issues a revoked certificate's holder a new one from the event's current results; refused to a competitor in the event. Its answer carries the new code only for `certificates.lookup`. |
| `PUT /api/admin/competitions/:id/look` | **scoped** | The event look, for their own events; refused to a competitor in the event, and, once the event's effective end has passed, to everyone but a superadmin (`event_look_ended_locked`). |
| `DELETE /api/admin/competitions/:id/cxone` | **scoped** |  |
| `PUT /api/admin/competitions/:id/cxone` | **scoped** |  |
| `GET /api/admin/competitions/:id/delivery` | **scoped** |  |
| `POST /api/admin/competitions/:id/end-now` | **scoped** |  |
| `POST /api/admin/competitions/:id/late-entry/close` | **scoped** |  |
| `GET /api/admin/competitions/:id/events` | **scoped** |  |
| `GET /api/admin/competitions/:id/free-text-responses` | **scoped** | The Any answer responses the participants CSV adds as columns with the event open; an Any answer challenge somebody else sealed is left out. |
| `GET /api/admin/competitions/:id/groups` | **scoped** |  |
| `DELETE /api/admin/competitions/:id/groups/:groupId` | **scoped** |  |
| `GET /api/admin/competitions/:id/self-enroll` | **scoped** |  |
| `POST /api/admin/competitions/:id/self-enroll/regenerate` | **scoped** |  |
| `POST /api/admin/competitions/:id/tags` | **scoped** |  |
| `DELETE /api/admin/competitions/:id/tags/:tag` | **scoped** |  |
| `GET /api/admin/competitions/:id/timeslots` | **scoped** |  |
| `POST /api/admin/competitions/:id/timeslots` | **scoped** |  |
| `DELETE /api/admin/competitions/:id/timeslots/:tsId` | **scoped** |  |
| `PUT /api/admin/competitions/:id/timeslots/:tsId` | **scoped** |  |
| `POST /api/admin/competitions/:id/timeslots/:tsId/end-now` | **scoped** |  |
| `GET /api/admin/competitions/:id/timeslots/:tsId/events` | **scoped** |  |
| `POST /api/admin/competitions/:id/timeslots/bulk-delete` | **scoped** |  |
| `DELETE /api/admin/competitions/:id/users/:uid` | **scoped** |  |
| `POST /api/admin/competitions/assign` | **scoped** |  |
| `GET /api/admin/credential/:code` | superadmin |  |
| `GET /api/admin/cxone/withdrawals` | **forbidden** | Only a superadmin can see the Checkmarx One accounts waiting to be removed for deleted participants. |
| `POST /api/admin/cxone/withdrawals/dismiss` | **forbidden** | Only a superadmin can manage the removal of Checkmarx One accounts belonging to deleted participants. |
| `POST /api/admin/cxone/withdrawals/retry` | **forbidden** | Only a superadmin can manage the removal of Checkmarx One accounts belonging to deleted participants. |
| `DELETE /api/admin/default-cxone` | superadmin |  |
| `GET /api/admin/default-cxone` | superadmin |  |
| `PUT /api/admin/default-cxone` | superadmin |  |
| `GET /api/admin/event-templates` | **scoped** | v8.15.0 — challenge ids they may not view are withheld. |
| `POST /api/admin/event-templates` | **forbidden** | Only an administrator can create event templates. You can spawn an existing template or clone your own event. |
| `GET /api/admin/event-templates/deleted` | **forbidden** | Only an administrator can see deleted event templates. Ask one to restore a template. |
| `POST /api/admin/event-templates/restore-builtins` | **forbidden** | Only an administrator can restore the built-in event templates. Ask one to make this change. |
| `DELETE /api/admin/event-templates/:id` | **forbidden** | Only an administrator can delete an event template. Ask one to make this change. |
| `GET /api/admin/event-templates/:id` | **scoped** |  |
| `PUT /api/admin/event-templates/:id` | **forbidden** | Only an administrator can change an event template. Ask one to make this change. |
| `POST /api/admin/event-templates/:id/protect` | **forbidden** | Only an administrator can protect or unprotect an event template. Ask one to make this change. |
| `POST /api/admin/event-templates/:id/reset` | **forbidden** | Only an administrator can reset a built-in event template. Ask one to make this change. |
| `POST /api/admin/event-templates/:id/restore` | **forbidden** | Only an administrator can restore a deleted event template. Ask one to make this change. |
| `POST /api/admin/event-templates/:id/spawn` | **scoped** | v8.15.0 — the new event grants them its organiser row; challenges they may not view are skipped and counted, never named (no id or title in the answer). |
| `GET /api/admin/export/competition-activity` | **scoped** |  |
| `GET /api/admin/export/competitions` | **forbidden** | That export covers every event on the platform. Use Export Activity on one of your own events instead. |
| `GET /api/admin/export/participants` | **scoped** |  |
| `GET /api/admin/export/settings` | superadmin |  |
| `GET /api/admin/export/tasks` | **scoped** |  |
| `GET /api/admin/groups` | **scoped** |  |
| `POST /api/admin/groups` | **scoped** |  |
| `DELETE /api/admin/groups/:id` | **scoped** |  |
| `PUT /api/admin/groups/:id` | **scoped** |  |
| `GET /api/admin/groups/:id/competitions` | **scoped** |  |
| `GET /api/admin/groups/:id/members` | **scoped** |  |
| `POST /api/admin/groups/:id/members` | **scoped** |  |
| `DELETE /api/admin/groups/:id/members/:userId` | **scoped** |  |
| `GET /api/admin/groups/:id/picker` | **scoped** |  |
| `POST /api/admin/import/participants` | superadmin |  |
| `POST /api/admin/import/tasks` | superadmin |  |
| `POST /api/admin/invitations` | **scoped** | must name at least one of their own events that can still take people (live, upcoming or inside its late-entry window): naming none, or only events that cannot, is 400 `event_admin_competition_required`, and naming one outside their scope is 403 `event_admin_out_of_scope`, both before anything is created; the Invite Participants dialog offers only events that qualify and will not send with none ticked (§6). For every tier, an existing account is found by its primary address only, and an address someone holds only as a secondary is refused by name in `errors[]` with nothing stored and nobody enrolled — a secondary is an unconfirmed claim (operator ruling, 11 Nov 2026) |
| `POST /api/admin/join-qr` | open | Draws a join QR, the event code in its centre, from a link and code the caller already holds; it reads and stores nothing. |
| `GET /api/admin/leaderboard` | **scoped** |  |
| `POST /api/admin/logout` | open |  |
| `GET /api/admin/logs` | **forbidden** | The request log covers the whole platform, so it is not available to event admins. |
| `GET /api/admin/logs/files` | **forbidden** | The request log covers the whole platform, so it is not available to event admins. |
| `GET /api/admin/me` | open |  |
| `GET /api/admin/my-address` | open | The address the server sees the caller at, for **Use my current address** beside Trusted network IPs (`events.edit`); it names no event. |
| `GET /api/admin/participants` | **scoped** |  |
| `DELETE /api/admin/participants/:id` | superadmin |  |
| `PUT /api/admin/participants/:id` | **scoped** | A privileged target (§9.6) is a superadmin's to edit; moving a rival's address is a rival door (§9.8) |
| `POST /api/admin/participants/:id/approve` | **scoped** |  |
| `POST /api/admin/participants/:id/block` | **scoped** |  |
| `POST /api/admin/participants/:id/deny` | **scoped** |  |
| `GET /api/admin/participants/:id/events` | **scoped** | rows narrowed too (v8.8.4) |
| `GET /api/admin/participants/:id/export/full` | **scoped** | v8.15.0 — `participantDenied`, then every section narrowed to their events (a History row naming another event is dropped). Not refused to a competitor: a rival's export is a read, and their answers to a compete event's challenges, all sealed, stay withheld (operator ruling, 24 Nov 2026; §9.8). |
| `POST /api/admin/participants/:id/groups` | **scoped** |  |
| `DELETE /api/admin/participants/:id/groups/:groupId` | **scoped** |  |
| `POST /api/admin/participants/:id/impersonate` | **scoped** | the participant view of a participant-role target only — an event admin never impersonates a fellow organiser (§9.6), so the admin-view door (§9.5d) is a global admin's; refused outright from inside any impersonation |
| `POST /api/admin/participants/:id/login-code/reveal` | **scoped** | Show sign-in code (a desk code): participant-role targets that have **never signed in** only (operator ruling, 14 Nov 2026; after a first sign-in, 409 `signed_in_before` and the desk can only email a code), and a desk code redeemed after the account left that role, or signed in by another door, is refused. A rival door for every tier (§9.8): the answer is a working credential for the account |
| `POST /api/admin/participants/:id/login-code/email` | **scoped** | Email sign-in code; a regular admin may not send one to an admin or superadmin account. A rival door (§9.8). While a desk code shown for the account is still live it is not replaced: `{ok:true, sent:false, reason:"desk_code_live"}` |
| `POST /api/admin/participants/:id/role` | superadmin |  |
| `POST /api/admin/participants/:id/tags` | **scoped** |  |
| `DELETE /api/admin/participants/:id/tags/:tag` | **scoped** |  |
| `POST /api/admin/participants/:id/unlock` | **scoped** |  |
| `POST /api/admin/participants/:id/verify` | superadmin |  |
| `POST /api/admin/participants/bulk-approve` | **scoped** | Skips, and counts, anyone outside their events, a privileged account (§9.6) and a rival (§9.8). |
| `POST /api/admin/participants/desk-invite` | **scoped** | the scope and the competitor lock are asked again at commit, on a freshly read role and grant set (v8.12.7, §2). While **Require admin approval for new accounts** is on, a role that cannot approve accounts is refused 403 `desk_approval_required` (asked before the address is looked at, and again at commit) |
| `GET /api/admin/participants/picker` | **scoped** |  |
| `POST /api/admin/perf/bulk-seed-history` | superadmin |  |
| `POST /api/admin/perf/bulk-seed-users` | superadmin |  |
| `GET /api/admin/retention` | **forbidden** | Data retention applies to every event, so it is not available to event admins. |
| `POST /api/admin/retention/purge` | superadmin |  |
| `GET /api/admin/roles` | **forbidden** | Your role does not allow you to see platform users and roles. Ask an administrator to change your role. |
| `POST /api/admin/roles` | superadmin |  |
| `PUT /api/admin/roles/:id` | superadmin |  |
| `DELETE /api/admin/roles/:id` | superadmin |  |
| `GET /api/admin/settings` | **forbidden** | Platform settings apply to every event, so they are not available to event admins. |
| `PATCH /api/admin/settings` | superadmin |  |
| `PUT /api/admin/platform-look` | superadmin |  |
| `GET /api/admin/settings/events` | **forbidden** | Platform settings apply to every event, so they are not available to event admins. |
| `GET /api/admin/submissions` | **scoped** |  |
| `GET /api/admin/system-health` | **forbidden** | The platform's health covers every event, so it is not available to event admins. |
| `GET /api/admin/tags` | **scoped** |  |
| `GET /api/admin/task-tags` | **scoped** |  |
| `GET /api/admin/tasks` | **scoped** |  |
| `POST /api/admin/tasks` | **scoped** |  |
| `DELETE /api/admin/tasks/:id` | superadmin |  |
| `PUT /api/admin/tasks/:id` | **scoped** | **author only** on a sealed challenge, whatever the tier — or a superadmin who has revealed it (§9.7) |
| `GET /api/admin/tasks/:id/attachments` | **scoped** |  |
| `POST /api/admin/tasks/:id/attachments` | **scoped** |  |
| `DELETE /api/admin/tasks/:id/attachments/:aid` | **scoped** |  |
| `PATCH /api/admin/tasks/:id/attachments/:aid` | **scoped** |  |
| `POST /api/admin/tasks/:id/attempt-grant` | **scoped** |  |
| `POST /api/admin/tasks/:id/competitions` | **scoped** |  |
| `PUT /api/admin/tasks/:id/competitions` | **scoped** |  |
| `DELETE /api/admin/tasks/:id/competitions/:cid` | **scoped** |  |
| `DELETE /api/admin/tasks/:id/feedback` | superadmin |  |
| `GET /api/admin/tasks/:id/feedback` | **scoped** | raters narrowed too (v8.8.4) |
| `DELETE /api/admin/tasks/:id/feedback/:userId` | superadmin |  |
| `POST /api/admin/tasks/:id/lock` | superadmin |  |
| `POST /api/admin/tasks/:id/publish` | **scoped** |  |
| `POST /api/admin/tasks/:id/recalculate` | superadmin | **author only** on a sealed challenge — a superadmin who neither created it nor revealed it is refused (§9.7) |
| `POST /api/admin/tasks/:id/restore` | **scoped** | **author only** on a sealed challenge, whatever the tier — or a superadmin who has revealed it (§9.7) |
| `POST /api/admin/tasks/:id/sealed-reveal` | **scoped** | v8.12.2 — `requireAdmin` plus an inline live-tier refusal (`answer_seal_reveal_superadmin_only`), NOT `requireSuperAdmin`, so a superadmin inside an impersonated organiser's panel can reveal; the seat's scope binds through `taskViewDenied`, the competitor lock first (§9.7) |
| `POST /api/admin/tasks/:id/tags` | **scoped** | owner-only (`taskEditDenied`); a `qualifying:` tag is a scoring change, so it takes `taskScoringEditDenied` too |
| `DELETE /api/admin/tasks/:id/tags/:tag` | **scoped** | as the add, removing a `qualifying:` tag included |
| `GET /api/admin/tasks/:id/versions` | **scoped** |  |
| `PATCH /api/admin/tasks/:id/visibility` | **scoped** |  |
| `GET /api/admin/tasks/:taskId/attachments/:aid` | **scoped** |  |
| `POST /api/admin/tasks/assign-competitions` | **scoped** |  |
| `POST /api/admin/test-email` | superadmin |  |
| `GET /api/admin/unsubscribed` | superadmin |  |
| `DELETE /api/admin/unsubscribed/:email` | superadmin |  |
| `GET /api/admin/users` | **forbidden** | Your role does not allow you to see platform users and roles. Ask an administrator to change your role. |
| `POST /api/admin/users` | superadmin |  |
| `PATCH /api/admin/users/:id/role` | superadmin |  |
| `GET /metrics` | **forbidden** | Platform metrics cover every event, so they are not available to event admins. |

---

## 6. What an event admin may do, by surface

| Surface | Event admin |
|---|---|
| **Events** | Sees only granted events, at any status. Full per-event control equal to a normal admin: edit, sessions, tags, CxOne override, join link, end now, **close late entries now** (a Booth Event whose late-entry window is open — §9.9), export activity — **unless they compete in it** (v8.12.0): an organiser enrolled in an event whose **Staff can compete** switch is on can view that event and not change it, whatever their tier — the reads stay (Open, History, Organisers, Email Delivery, Export Activity, a rival's person export, and the **Join Link** dialog, which opens read-only: link, QR and code shown, the toggle and Regenerate withheld), only the mutating controls go — until they remove themselves, which they can do while the event has not ended (§9.8). **Cannot create an event from scratch**, and cannot delete one (superadmin). Since v8.15.0 they can **clone** an event they organise and **spawn** an event template; either makes them the new event's organiser, and neither copies participants, answers or the join link. Templates themselves are managed by administrators only. The **full event export** and the **person export** are scoped like every other read: their own events only, and a person's export narrowed to rows about those events. |
| **Challenges** | **Creates** freely. **Sees** challenges they created, challenges used by one of their events, and `public-domain` ones. The per-row events column shows only their events (v8.8.8), with a count of any others holding it. **Edits / publishes / hides / tags** only their own — and on a **sealed** challenge those four are its author's alone whatever the tier (a superadmin who has revealed it aside), because the seal names an account rather than a tier (§9.7). **Assigns** any challenge they can see to any event they manage — but an event where staff compete admits only a **sealed** challenge, and never one its author competes in (§9.8). **Unassigns** only what they themselves assigned. Cannot hard-delete (superadmin), lock, or recalculate. A challenge held by an event they compete in is read-only for them, hint included (§9.8). |
| **Participants** | Sees only people enrolled in one of their events, plus an account waiting for an administrator's approval whose live invitation names one of their events (signed up through an invitation whose inviter cannot approve accounts, §1): its row names only those of their events it was invited to, so they can ask an administrator to approve it, and they can view it but neither approve it nor take any other row action on it, as it is in none of their events (operator ruling, 23 Nov 2026; their pending count still counts members only). The per-row events column shows only their events, and so does a participant's History (v8.8.4). Invites (including at the desk) only into their events, and an invitation must name at least one of them that is live, upcoming or taking late entries — one naming none is refused. The **Invite Participants** dialog lists exactly those events (one they compete in is listed, marked **You compete here**, and cannot be ticked) and will not send with none ticked; when only one can be ticked it is ticked for them, marked **Always included**, and cannot be unticked; when none can be, the dialog says why — in place of the list when it has no events to show, under the events they compete in otherwise — and **Send Invitations** is disabled. CSV export covers only what they can see. A Booth Event of theirs that has ended but is still inside its **late-entry window** stays open to every door that adds people — invite, assign, **At the desk**, a bound group — and whoever is added joins as a late entrant; only late entrants can then be removed from it (§9.9). Per-participant actions as a normal admin — approve, deny, block, unlock, email or show a sign-in code, tags, impersonate (participants only, in their participant view — read-only, narrowed to your events — §9.5b; viewing a fellow organiser's panel is an administrator's door, §9.5d). An invitation of theirs approves an existing account waiting for approval only as **Approve** would: when the invitation puts it into one of their events as a participant (an organiser's or administrator's waiting account never). One whose every enrolment was skipped stays waiting, and the **Invite Participants** dialog says so and keeps those addresses in the box. **Cannot** change a role, verify or delete. |
| **Groups** | Creates freely. Sees groups they created or that are bound to one of their events. **Deletes only groups they created.** Cannot edit a group that is also bound to somebody else's event (§9.2), nor change the membership of one bound to an event they **compete in** — a group change reconciles onto that board (§9.8; any tier, and a rename stays open). |
| **Submissions** | An event's **Activity** section: that event's. Across all their events, the **Audit** page (its submission and hint rows). |
| **Rankings** | An event's **Rankings** section: that event, or the session picked. **Live rankings**: the live events they can see. |
| **Analytics** | Their events and sessions, their challenges, their groups, their participants. **No platform-wide scope.** Tag vocabularies list only tags on participants they can see. |
| **Logs** | Hidden. |
| **Settings** | Hidden. |
| **Participant view** | The events they are **enrolled** in — which is unrelated to the events they administer. Being an event admin grants no participant membership anywhere. The switch is **two-way**, as it is for every other admin tier: **Admin View** returns them to the panel, and the admin session is unaffected. **One section, not two (v8.12.0).** A `staff`-**tagged** user's picker is split into *Your Events* — the events they hold a row on — and *All other events*, everything they may merely enter as staff, because the tag admits them to every event without a row and the two lists mean different things (§9.8). An event admin is not tagged and is admitted nowhere without a row, so their picker keeps a **single enrolment-only section**. When they are enrolled in an event whose **Staff can compete** switch is on, they compete on it like anybody else — but the **Competing** badge is rendered only on a `staff`-**tagged** user's own rows (the picker keys it on the tag, `S.isUserStaff`), so an event admin's card carries no marker: the row is on the board and the wire says `competing: true`, and the picker does not say so. The same tag gate covers the *Compete in this event?* confirmation the join link shows a staff member before enrolling them — an untagged event admin never sees it. |

### Excluded from every leaderboard

Where staff do not compete, an event admin never appears on a leaderboard,
never counts toward the all-solved denominator and is counted in none of the
live figures the workspace Overview reads from `overview-pulse` (the activity
chart's joins included), exactly as a normal admin is not; on an event with
**Staff can compete** switched on, an enrolled event admin counts in all of
them like anybody else. The Overview's **Joined** figure, and its other lines
saying how many people have joined, count them either way: like the Events list
and the **Participants** tab, they count everyone enrolled (operator rulings,
14 Nov 2026).

**This is done by ROLE, not by the `staff` tag**, and the distinction is
load-bearing rather than stylistic. The `staff` tag carries two further powers,
each of which would break a stated rule of this role:

- `isStaff(userId)` short-circuits membership entirely
  (`requireParticipantInCompetition` returns `next()`), so a tagged event admin
  could enter **every** event on the platform as a participant; and
- `listParticipantCompetitions(…, {staff:true})` is an unfiltered
  `SELECT … FROM competitions`, so their participant picker would list the whole
  platform.

Both contradict "their participant view is restricted to their own events".
Excluding by role gives the intended outcome with neither side effect, and cannot
be undone by removing a tag. The exclusion lives in
`getStaffOrBenchmarkSet` (`lib/user-tags.js`) and `buildLeaderboardEntries`
(`lib/leaderboard.js`), which read one list of the roles it covers
(`offBoardRolesJson`: every role of the event admin's class, custom roles
included); the Overview's pulse (`routes/event-overview.js`) reads the same
list, so it leaves out exactly the roles the boards leave out.

**Lifted per event by the Staff-can-compete switch, and lifted for the tag and
the role TOGETHER (v8.12.0).** On an event whose `staff_compete` switch is on, an
event admin who holds a row is on both boards, counts toward the all-solved
denominator and can mint a certificate — exactly as a `staff`-tagged admin with a
row is. The lift is keyed on the same two sources as the exclusion:
`getStaffOrBenchmarkSet` **takes** the event's switch (`{staffCompete}`,
passed in by `scoringParticipantIds`, which reads the event's own row) and
`buildLeaderboardEntries` **reads** it off the competition row itself, and both
stop excluding **both** the tag and the role at once, so a global admin and the
event admin beside them are never on opposite sides of the board. `benchmark` is
untouched, and so is Analytics. The whole rule, and the lock that comes with the
row, is §9.8.

---

## 7. What an event admin may NEVER do

| Refused | Why |
|---|---|
| Create a blank event, or delete one | The operator's rule. An event admin starts an event only from a template or as a clone of one of their own events, and becomes its organiser; one with no events left (every grant revoked) can do neither. |
| Grant or revoke the event-admin role | Two independent gates, either sufficient — see §8. This is what stops the role self-propagating. |
| Change anybody's role | Superadmin, unchanged. |
| Hard-delete a challenge or a participant | Superadmin, unchanged — a **normal** admin cannot do this either, and the operator's rule is that an event admin's per-event powers equal a normal admin's. They unpublish or hide instead. |
| Lock or recalculate a challenge | Superadmin, unchanged. |
| Import challenges or participants | Superadmin, unchanged. Both write platform-wide. |
| See platform logs, settings, retention, metrics, alerts | Each covers every event. |
| See or act on the Checkmarx One account removals | Removing an account from a customer's tenant is a decision about the customer's system, not about one event — superadmin only, like the global CxOne credential. |
| Export every event, or the settings | Whole-table exports with no scope. Export Activity on one of their own events is the scoped equivalent. |
| Verify an account | Superadmin, unchanged. |
| Change an event they **compete in**, or a challenge it holds | Not a tier rule at all — the competitor lock (§9.8) binds every tier, superadmin included, and refuses 403 `competitor_cannot_edit` at every locked door §9.8 lists: the event's own routes, its challenges, the group writers that reconcile into it, and (as a skip rather than a refusal) the two superadmin imports. The escape hatch is removing **themselves** from the event, allowed **while the event has not ended** — a finished event's roster is settled for everybody (a late entrant of a Booth Event who had not started playing before the end, still inside its late-entry window, aside, §9.9), so a competitor in a finished compete event stays locked out of it and another organiser edits it. The remedy otherwise is another organiser. |
| Enrol an admin or superadmin as a competitor | The peer-admin doctrine, applied at both enrolment doors an admin drives (§9.8): only a superadmin may enrol a privileged account into an event where staff compete; anybody else's request skips that target and reports it as `skippedPrivileged` — on `POST /api/admin/competitions/assign` and on the existing-user path of `POST /api/admin/invitations` alike, and the participant row withholds **Invite to …** for such a target. Enrolling **themselves** is always allowed. |

---

## 8. Grant, revoke, and "demote altogether"

Three writers of the role and its grants, and only three (an event admin who
clones one of their events, or starts one from a template, is also made organiser
of the new event):

| Action | Route | Tier | Effect |
|---|---|---|---|
| **Grant** | `POST /api/admin/competitions/:id/admins` | `EVENT_ADMIN_FORBIDDEN` **+** `requireGlobalAdmin` | Promotes a `participant` to `event_admin` (compare-and-swap on the role that was read) and inserts one `competition_admins` row. Refuses an existing admin or superadmin target — narrowing a full admin is a demotion and belongs on the role route. |
| **Revoke one event** | `DELETE /api/admin/competitions/:id/admins/:uid` | `EVENT_ADMIN_FORBIDDEN` **+** `requireGlobalAdmin` | Deletes the row. **Does not change the role**, even when it was the last one. |
| **Demote altogether** | `POST /api/admin/participants/:id/role` `{role:'participant'}` | `requireSuperAdmin` | Sets the role and **cascades every `competition_admins` row away in the same transaction**, reporting the count on the `role_changed` event. |

**THE SELF-PROPAGATION BAR IS HELD TWICE, AND NEITHER HALF IS UNIQUELY PINNED —
measured, not assumed.** Both writers sit in `EVENT_ADMIN_FORBIDDEN`, so
`eventAdminGuard` refuses an event admin before any handler middleware runs, AND
both carry `requireGlobalAdmin`. Each is independently sufficient, so **removing
either one alone leaves the whole suite green** (both mutations verified against
`tests/event-admin-matrix.spec.js`); the matrix cell goes red only when both go.
The behavioural lock therefore holds the PROPERTY — an event admin cannot make
another event admin — and not either mechanism. Do not read a green run as
covering the gate you are about to delete, and do not "simplify" the pair to one
on the evidence of a passing suite.

**Why removing the last grant does not demote.** The role route is
superadmin-only; auto-demoting from a revoke would let a *regular* admin perform
a superadmin action — with its staff-tag write, its group reconcile and its
session purge — as a side effect of a scoped one. A zero-grant `event_admin` is
well defined and fails closed (it cannot start an event from a template either:
403 `event_admin_no_events`), and the participants table renders it plainly.

Both the grant and the revoke are recorded on **two** histories — the
participant's and the event's — because an organiser reading the event's History
and an admin reading the participant's must each see it.

**Enrolment is a separate fact, and the two do not interact (v8.12.0).** An event
admin can be **enrolled as a competitor** — in any event whose **Staff can
compete** switch is on, including one they organise — through the ordinary
assign door, an invitation, the join link or a bound group; nothing about the
grant or the revoke consults their `competition_users` row, and nothing about
enrolment consults `competition_admins`. What the row does is **lock**: while it
exists, that organiser cannot change the event or its challenges (§9.8), and the
escape hatch is removing themselves while the event has not ended. The only touch
point with this section is that the
grant and revoke routes are themselves among the competitor lock's doors — so a
global admin who competes in an event cannot grant or revoke its organisers
either, which is a third gate on the pair rather than a change to the two above.

### How the row renders it (v8.7.0, badges since v8.8.7)

`event_admin_for` rides the participants payload — **and the picker's**, from one
shared builder, because a field present on one and absent on the other is a column
that empties itself depending on which of the two lists served the row. It is
narrowed by `scopeFilterSql`, so one organiser never learns the names of events
another runs.

The Role cell badges those events with the same `comp-<category>` classes the
Events column beside it uses, and **shows only the current ones** — live, upcoming
and still inside a late-entry window. Finished events are the bulk of any
long-running platform and would crowd out the two an operator can act on. That
filter needs `status` **and** `late_entry_window_open` on the wire: a projection
carrying only id and name renders every event as ended with nothing erroring, and
`lateEntryWindowOpen` throws on a row with no `event_kind` rather than guessing
one.

**Nothing is rendered when nothing is current (v8.8.10).** v8.8.7 gave the two
empty states their own copy, so that an organiser of three finished events would
not read as one who organises nothing. The operator reversed it: neither is
actionable, the role badge already says what the person is, and a grey sentence
where the badges go is noise on a dense table. The cell shows the badges or the
role badge alone.

**The states still DIFFER in the payload** — `event_admin_for` is empty for a
zero-grant organiser and non-empty for one whose events have all finished — so
nothing is lost, only unrendered. A reader who wants that difference on screen
should reach for the participant's History or the event's Organisers list, not
for a label in this cell. Locked, with each empty state as the other's control
and a badged row as the anti-vacuity control, in
`tests/event-admin-role-badges.spec.js`.

---

## 9. Known asymmetries and accepted trades

### 9.1 The cross-scope challenge edit

An event admin owns challenge T; an administrator assigns T to event D, which
they do not manage. Under a bare owner rule they could then change T's correct
answer and re-grade an event they have no remit over.

So the **scoring-relevant** fields — `correct_answer`, `answer_type`,
`difficulty`, `choices`, `attempt_cap`, `status`, `active`, the exact set the
ended-session freeze already protects — additionally require that **every** event
holding the challenge is in scope. Cosmetic fields (title, description,
explanation, hint, author, attachments, tags) stay open to the owner, which is
the operator's stated rule.

### 9.2 The group transitive effect

Group membership live-syncs into **every** bound event. Editing a group
bound both to your event and to somebody else's would move membership in theirs,
so `groupWriteDenied` requires every binding to be in scope and names the
offending event in its refusal. Scoping the reconciler instead would put an
authorization concept inside a background fan-out where nothing could hold it.
The competitor lock (§9.8) takes the same shape one rule over:
`competitorGroupDenied` asks `competitorEditDenied` of every bound event, so a
group membership change cannot reach a board the actor competes on through the
reconciler either.

### 9.3 Two event admins on one event

A can see B's LIBRARY challenge (rule b) but cannot edit it, and cannot unassign
B's assignment. Accepted: the remedy is to ask an administrator.

**An event's own question is its organisers'** (owner decision, Nov 2026;
`lib/event-copies.js`). A challenge added to an event is the event's own copy
(`tasks.owner_competition_id`), so A and B may both edit the copy their event
holds, scoring fields included (it is in no other event, so
`taskScoringEditDenied` finds no event outside their scope). `taskEditDenied`
and `taskViewDenied` grant on an owning event in scope what authorship grants;
nothing else widens. A bank challenge is "used by one of their events" (rule b)
while an event in scope holds an assigned copy of it. The unassign rule (only
what they added) is unchanged.

### 9.4 Ownership is a user id, never an email

`tasks.created_by_id`, `competition_tasks.assigned_by_id` and
`groups.created_by_id` store a **user id**. `getAdminIdentity(req)` returns an
email, which is right for the audit trail and wrong for authorization: an email
genuinely moves, so an event admin who corrected their own address would silently
lose edit rights over everything they had created. The existing `assigned_by` /
`created_by` columns keep their emails and their meaning. Two columns, two jobs.

**No backfill.** NULL means "created before this feature, or by an actor we did
not record", which resolves to *no event admin owns this* — accurate, since every
pre-existing row was written by a globally scoped admin, and fail-closed.

**The challenge import leaves it NULL too**, on both branches. The superadmin
running an import is not the author of what they imported, and stamping them
would be inert until the day that account is narrowed to `event_admin` — at which
point they would silently own the entire imported bank. A version RESTORE must
likewise never write the column: that UPDATE carries a hand-written column list,
and v7.20.9 F4 is the record of exactly that list rotting.

### 9.5 The `public-domain` tag

`public-domain` on a challenge makes it visible to **every** event admin. It is an
ordinary task tag with a reserved meaning, declared once in `lib/event-admin.js`.
Anyone who may edit the challenge may apply it, which for an event admin means
their own challenges only.

**It HAS a client mirror** (`public/js/ui/format.js`), and this section used to say
it did not — v8.8.2 added one so the Add Tag dialog could apply the exact value
without anybody typing it, and the sentence denying a mirror survived that release.
Both the constant and the near-miss predicate beside it are diffed against the
server by a Docs-hygiene scanner.

**A NEAR MISS IS REFUSED, NOT STORED (v8.8.3).** The visibility rule matches by
exact equality in SQL, so `public domain`, `public_domain`, any dash variant, an
NBSP, a SOFT HYPHEN or a ZERO-WIDTH SPACE would each be stored as an ordinary label
granting nothing — and the last two render *pixel-identically* to the reserved
value. `POST /api/admin/tasks/:id/tags` answers **400 `public_domain_near_miss`**
naming the reserved spelling and the chip that applies it. It is a REFUSAL, never a
fold: making `public domain` *mean* `public-domain` would silently grant
platform-wide visibility to a challenge somebody labelled descriptively. The cost
is stated rather than hidden — `public domain` is no longer available as an
ordinary descriptive label. The importer and version restore are deliberately NOT
guarded (a migration must not be sunk, and a snapshot must stay restorable); the
challenge row marks any near-miss that arrives that way and offers a one-click fix.

### 9.5a Scoping the ENTITY is not scoping the ROWS (v8.8.4)

Two routes were gated on one of the two questions their response asks, and a
sibling-surface sweep measured both leaking. The pattern is worth recognising
before adding a third: **a gate that admits an actor to an ENTITY says nothing
about which ROWS of that entity's response they may read.**

- `GET /api/admin/tasks/:id/feedback` — `taskViewDenied` answers *may you open
  this challenge*. The rows carry each rater's name, nickname and **email**, and
  `task_feedback` has no `competition_id`, so the join ran over the whole users
  table. Reachable through the shared pool with no special state: a
  `public-domain` challenge is visible to **every** event admin by design, so a
  ZERO-GRANT organiser — the actor who must see least — reached every rater on
  the platform. The route now also applies `participantVisibilityScope`.
- `GET /api/admin/participants/:id/events` — `participantDenied` answers *may
  you see this participant*. Once it passed, their whole cross-event history came
  back: `hint_revealed` / `feedback_submitted` / `attempt_grant` carry
  `task_title` and `task_id`; `first_joined` and `added_to_competition` carry
  `competition_name`. It is the DEFAULT primary button on a participant row, and
  it contradicted §6 above, whose sibling `competitions` column IS narrowed. The
  route now also applies `userEventCompetitionScopeSql`, which withholds a row
  naming ANY event outside the organiser's scope, under whatever key: not only
  `competition_id` but `active_competition_changed`'s `from`/`to` (a pin move
  from their event to another one), and any other value that is the id of an
  event or session they do not organise. The person export uses the same clause.
  **An email row names its event** (operator ruling, 17 Nov 2026): each
  `email_sent` records the event(s) its mail concerns, so a mail about another
  organiser's event is withheld like any other row, and one recorded before then
  (it names no event) reaches the organiser without its `subject`
  (`subject_withheld: true`), since a subject can name an event. The Audit page
  shows the same row (`userEventDetailsSql`).

**A row naming no event is ADMITTED, deliberately.** Those are the
account-lifecycle events an organiser legitimately needs about somebody enrolled
with them — which is why the dialog is open to the tier at all. Withholding them
would trade a leak for a blind spot, and it has its own test.

**A row whose details cannot be read is WITHHELD.** A row whose stored details
are not JSON (a hand edit, a write cut short) cannot be judged, as whichever
event it names is unknown, so an event admin, or a role scoped to its events, is
not given it in a person's History, the person export or the Audit page. A
reader acting on every event sees it with its type, time and actor, its details
marked `details_unreadable: true`, and History says its details could not be
read. Either way the list holding it answers.

**The filter is in SQL, not applied to the returned array**, so `total` and the
page share one scope; filtering after pagination leaves the count describing rows
the caller never receives.

**`participantVisibilityScope` is declared once**, in `lib/event-admin.js`
beside every other scope predicate. It was written in `routes/export-import.js`
for the participants export; the feedback route needed the same fragment, and a
second copy of a security predicate is the drift class this codebase keeps paying
for. The export delegates to it.

### 9.5b An impersonated view is scoped to the organiser (v8.8.6)

`docs/user-guide/event-admin.md` has promised since v8.7.0 that "every list you
open is already narrowed to your events". Impersonation was the one place that
was false, which makes this a **repair of a stated promise**, not a new
restriction.

**The bypass was structural.** `isEventAdmin(req)` returns false whenever
`req.session.impersonator` is set — correctly, since `req.session.userId` is then
the TARGET — so `scopedCompetitionIds` returned `null` and every predicate in the
module answered "unscoped". Measured in one session before the fix: the picker
listed the other organiser's event, `select-competition` accepted it, `/api/tasks`
served its challenges, `/api/tasks/:id` on an ended event with reveal-on returned
the **answer key**, `/api/leaderboard` named a third participant's nickname and
score, and the certificate mint **wrote a real badge row** on that event.

**The predicate is separate, and that is the decision.**
`impersonatorScopedCompetitionIds(req)` resolves the acting admin from
`req.session.impersonator` and returns `null` (unscoped — not impersonating, or a
global admin or superadmin), `[]` (an event admin with no grants: nothing), or the
grant list. The acting admin's **role is re-read per request**, never taken from
the entry snapshot (v7.21.12) — a demoted ex-admin would otherwise keep an
unscoped view for the life of the session.

**Where it is applied, and why the list is not enough.**

| Site | Why |
|---|---|
| `listParticipantCompetitions` (the result, not the query) | Both list surfaces. Applied to the RESULT because the **staff branch** has no membership join to filter — and it is the worst case, not a corner: a staff-tagged target returned every competition on the platform. |
| `POST /api/select-competition` | The **boundary**. The list is an affordance; boot re-selects from the session pointer and a hand-made POST needs no picker. |
| `requireCompetitionContext` | Re-asserted, so a grant revoked mid-session stops an already-selected event serving. Closes `/api/tasks`, `/api/tasks/:id` and `/api/leaderboard` without filtering any of them — a partially redacted leaderboard is a wrong answer. |
| `POST /api/competitions/:id/badge` | The one durable write, above the idempotent return so the token is not disclosed either. |
| `GET /api/me/certificates` | Ships with the mint: the payload carries the badge token, a live capability. Here, in every mint answer and in the LinkedIn post, the token and the credential code go only to an acting admin holding `certificates.lookup`, whatever their tier (§1). |
| `GET`/`POST /api/competitions/:id/reminder` | Symmetry. Discloses no name, but an undecided gap in a scope feature reads as coverage. |

**Two traps worth not re-discovering.** The scope refusal in
`requireCompetitionContext` has its **own branch**: the not-found branch beside it
durably NULLs the TARGET's `active_competition_id` and audits it against them, so
routing a scope refusal through it would have an admin's idle GET silently clear a
real participant's auto-resume marker. And `[]` is not `null` — the naive
`ids.length ? narrow : unchanged` shows the empty-grant organiser everything.

**Deliberately NOT narrowed**, so each is a decision rather than an oversight: the
public credential and badge routes (session-blind by design — a verifier holds a
token, not a session); the participant's own record and their own session; the
sole-event landing and auto-resume, neither of which runs on impersonation entry
(nor on the view switch, v8.12.1); and every other admin tier, whose
PARTICIPANT-view impersonation is unchanged — their event-admin view is §9.5d.

### 9.5d An impersonated ORGANISER is viewed in their own panel (v8.12.1)

Operator instruction: an admin or superadmin impersonating an event admin gets
that organiser's ADMIN view as well as their participant view.

**Who.** The acting tier is `admin` or `superadmin` (the built-in included);
the target is an `event_admin`. An event admin never reaches this door — a
fellow organiser is a privileged target for them (§9.6) — and the entry route
says so again (`event_admin_forbidden`) as belt and braces. A participant-role
target has no admin view to open: `view:"admin"` on one is refused
`impersonation_view_unavailable`, and `mode:"admin"` on the toggle answers the
participant's own "You do not have admin access". Nesting is refused for every
tier from inside any impersonation.

**How.** `POST /api/admin/participants/:id/impersonate {view:"admin"}` at entry
(the client's dialog offers the two views for an organiser and defaults to the
panel), or `POST /api/toggle-admin-view` inside the session — the ordinary
header switch, which now carries `req.session.impersonator` through its
regenerate so the two views are ONE impersonation. The session is then
admin-shaped: `isAdmin=true`, `isSuperAdmin` **never**, `userRole` the target's
real role, and the marker records the `view` in force.

**Which predicates answer about whom.** Every predicate in `lib/event-admin.js`
reads the SEAT: `isEventAdmin`, `scopedCompetitionIds`, `actorId`, the row
predicates and `eventAdminGuard` all answer about the impersonated organiser,
because the two carve-outs in §3 that answer about the seat key on the session
shape (`impersonator && !isAdmin`), not on the marker. So the panel is theirs row for row: their events
and nothing else (a zero-grant organiser's seat lists `[]`), their forbidden
routes still forbidden (Logs, Settings, event creation, granting a colleague),
and `requireSuperAdmin` routes refused because the flag is never set. A
superadmin gains NOTHING beyond what the organiser has — "full access" means
everything the organiser may do. **Two rules bind the HUMAN rather than the
seat.** The seal (§9.7): every seal predicate is asked with `actingAdminId(req)`,
the acting admin's own id under impersonation, so an organiser's sealed key is
withheld from whoever looks through their seat in either view — the challenge
list, its version history, both exports, the import overwrite, the participant
detail and the Submissions stream — the acting admin's OWN sealed challenges
stay readable through it, and a seal cannot be SET through somebody else's seat
(`answer_seal_not_by_proxy` at create; the client disables the tick with that
sentence beside it). **v8.12.2 — a superadmin may REVEAL it through the seat**,
the reveal being keyed on the ACTING human's live tier (`actingIsSuperAdmin`)
rather than the seat's, and the record then carries `impersonated_by` and the
seat as an id (`acting_as_id`, resolved per reader in History — named to every
global admin and superadmin, to the organiser themselves, and to another event
admin only when they share an event with that organiser; withheld from any other
event admin, and reported as deleted once the account is gone); the reveal dies
with the seat (every regenerate and the forced exit
drop `sealedReveals`). And the competitor lock (the v8.12.0 ruling binds the
PERSON): every `lib/staff-compete.js` predicate is asked about
`competitorIds(req)` — the seat AND the hand — so an event the acting admin
competes in, a challenge it holds and a rival on its board are refused through
anybody's seat, whichever event that organiser runs; the entry refusal
(`actingAdminCompetesInTargetEvents`, asked again by the toggle into the admin
view) and the guard's coarse per-write re-ask are defence in depth over it.
Ownership columns still record the seat (`created_by_id` is the organiser's),
and the history says whose hand.

**The write tier is `impersonationGuard`'s, unchanged.** A regular admin's
non-GET `/api/admin/*` request is refused `impersonation_readonly` — the
organiser's panel, read-only, every control it offers meeting the modal —
except the two POSTs that only render (the certificate preview and the join QR,
which store, mint and audit nothing), so the panel still previews its
certificates and shows its join QR, and neither asks a superadmin to confirm. A
superadmin's write goes through behind the SPA confirm, whose copy names the
organiser's panel, and lands attributed to the SUPERADMIN: `getAdminIdentity`
resolves the acting admin under impersonation, and `reqContext` spreads
`impersonated_by` + `acting_as` on every audit row written in the window, so an
organiser's History can tell their own act from an administrator's through their
seat. The view switch itself is recorded on the target's row as
`admin_view_toggled`, attributed to the acting admin.

**Lifecycle, re-read both ways.** `requireAdmin` and `GET /api/admin/me` force
the exit — restore the acting admin, never destroy their session — with
`403 impersonation_ended {reason:"target_inactive"}` when the organiser is
blocked, denied, unapproved, DEMOTED or PROMOTED to a global tier mid-session
(a promoted seat would otherwise silently widen to a global admin's, past what
entry ever granted); the target's `verified` is deliberately not asked
(v7.15.8) — by the docs gate too, which reads the seat's tier for the gated
guides and never clears the flags on an impersonation session. And the ACTING
admin is re-read on every admin request, GETs included — the organiser's read
surface is on the table there, and a blocked ex-admin must not keep it for the
life of a cookie; when THEY are the one who stopped qualifying there is no
identity to hand back, so the session is destroyed — but the target's window is
closed first (`impersonation_ended {reason:"actor_inactive"}`,
`destroyImpersonationSession`, the same helper at every one of the five sites).
A nested entry is refused by the guard with `403 impersonation_nested`.

**No impersonation, at any tier, joins an event for the person** (operator ruling,
21 Nov 2026). The join door (`POST /api/competitions/join`: the join link, QR and
event code) enrols the person being viewed, and every "joined" figure counts
enrolments, so a superadmin's join would count somebody as joined who never chose
to. The guard refuses `403 impersonation_join_refused` on the paths in
`_IMPERSONATION_JOIN_PATHS` (`lib/impersonation.js`), for everyone and before the
superadmin's write bypass, and the route repeats it. An organiser who means to add
the person uses **Add to event**.

**No impersonation, in either view and at any tier, signs in as an account or sets its credential.**
The guard refuses `403 impersonation_readonly` to everyone, superadmin included
and before the superadmin's write bypass, on the paths in `_IMPERSONATION_BLOCKED`
(`lib/impersonation.js`): the sign-in code request and redeem
(`/api/auth/code/request`, `/api/auth/code/redeem`), the untie of a code's event
(`/api/auth/code/drop-event`), the password sign-in
(`/api/auth/password`) and the sign-in method change, which sets or changes a
password (`/api/me/sign-in-method`). A sign-in as the target, or a credential set
on the target's account, would let the acting admin act as that person later with
nothing carrying `impersonated_by` — the record the whole feature exists to keep.
A credential is the account owner's alone, so it is not shown either: under
impersonation `GET /api/me` and `GET /api/admin/me` leave out `login_method`,
`login_method_is_default`, `has_password` and `password_required`, and the
profile's **How you sign in** row does not appear. (`/api/login` stays on the guard's
allowlist: it signs in only the built-in superadmin, and replaces the whole
session after closing the impersonation window.)

**Not changed, each a decision.** The participant view of an event-admin
target is exactly what it was, `isEventAdmin` reporting the TIER so the
participant nav offers the way up; the auto-resume landing never runs under
impersonation; `_analyticsCache` and the participants cache key on the actor
id, which is the seat, so the organiser's own cached bodies are what the seat
reads; operator alerts are not polled in the seat (an alert is addressed to the
acting admin's own panel, and a dismissal from here would be recorded against
the organiser).

### 9.6 An event admin cannot act on a fellow organiser

Every per-participant route already refuses a PRIVILEGED target for a
non-superadmin actor (`lib/rbac.js` `privilegedTargetFor`): an unscoped role —
`admin`, `superadmin` or a custom unscoped role — or any role holding a
permission the actor's own role lacks, so a custom role scoped to its events
that holds, say, `settings.edit` is out of a regular admin's reach too. Those are
closed: the profile and both addresses (every sign-in is an emailed code to the
primary address, so moving it is taking the account over), approve (and an
invitation's auto-approve, which leaves the account pending and counted; for an
actor scoped to its events it also asks approve's scope question, `participantDenied`, §4), deny,
bulk approve, block, unlock, the emailed sign-in code, tags, group membership,
the compete-event enrolment skips, attempt grants on such an event, and deleting
the account (a custom role holding **Delete accounts** deletes only accounts that
are not privileged for it). The participant rows carry the answer for the
asking admin (`privileged_target`, beside the role's `role_class`), and the
menu withholds those doors with the reason. `event_admin` is a role that guard has
never heard of — and two organisers sharing an event is the ordinary case this
role was built for, so without a second clause an event admin could block, deny,
email a sign-in code to, or impersonate a fellow organiser merely because that
colleague is also *enrolled* in their event.

`participantDenied` therefore refuses any target whose role is not
`participant`. A global admin is unaffected — the predicate returns early for an
unscoped actor — so they keep the ability to demote an event admin, which the
operator requires, and to impersonate one in either of their views (§9.5d).

---

### 9.5c A narrowed projection that a DESIRED-STATE endpoint reads is a three-part change (v8.8.8)

`task.competitions` is scoped per viewer. Narrowing it alone re-creates the
defect v8.7.7 cured, so three things move together and must keep moving together:

1. **The projection** — an event admin sees only their own events on a challenge
   row, plus `withheld_competition_count` and `withheld_live` when something was
   held back.
2. **The removal diff** — `PUT /api/admin/tasks/:id/competitions` reads
   `competitionIds` as a complete desired state, so `toRemoveIds` is computed
   from the set the server **showed**, never from the whole set. Otherwise every
   out-of-scope assignment is a removal nobody requested: a total lockout of the
   dialog, refusing a pure ADD and an unchanged NO-OP alike.
3. **The concurrency comparison** — `expectedAssignments` is compared against
   that same narrowed set. Otherwise every save on a shared challenge is a
   spurious 409 blaming a colleague for a conflict that does not exist, with a
   "reopen the dialog" remedy that can never succeed.

A scoped actor may not NAME an out-of-scope event in either array, and that guard
runs **before** the concurrency check — a permission answer must not be preceded
by an answer about an event the actor cannot see.

**The counts are not decoration.** An event admin may legally edit the cosmetic
fields of a challenge another organiser is running (§9.1 freezes the scoring ones
and deliberately leaves the rest), and the client's "this challenge is in live
event(s)" confirmation is built from this array. Narrowing it to nothing would
delete that warning exactly when it matters most. The server therefore says WHICH
SITUATION this is, the shape §9.5b uses one feature over: a count and a liveness
flag are a far smaller disclosure than a name, and unlike the name they are
operationally necessary.

### 9.7 A sealed answer — an OWNERSHIP rule that binds every tier (v8.10.0; superadmin reveal v8.12.2)

**The shape is new to this document, and that is the thing to read first.** Every
other rule here is a **tier** (which role) or a **scope** (which events). A sealed
answer is neither. It names **one account** — `tasks.created_by_id`, the person who
created the challenge — and it binds **every** tier, superadmin included. An
administrator does not pass it, and a superadmin does not pass it silently: since
v8.12.2 a superadmin passes it only by an explicit, RECORDED **reveal** (below),
after which the seal treats them as the author for the rest of that session.

A challenge may be created with its answer sealed. While `tasks.answer_sealed` is
set, the **correct answer**, the **explanation** and the **hint** reach exactly that
one person by default. Not a fellow event admin, not an administrator, not a
participant — including after the event's own answer reveal — and a superadmin
only on the record. It exists for the ordinary case where the author's colleagues
may compete in, coach at, or help run the same event.

**It is its own module, and that is deliberate.** The rule lives in
`lib/answer-seal.js`, which requires nothing at module scope, so its whole matrix
is unit-testable without a server (the `lib/scanner-classify` and
`lib/cxone-identity` precedent). It is **not** in `lib/event-admin.js`, where the
sibling task gates live: `taskEditDenied` and its neighbours open by returning
`null` for an unscoped actor — global admins and superadmins bypass ownership
entirely, which is correct there and is the exact opposite of what a seal means.
Folding a rule that binds every tier in beside predicates whose first line exempts
two of them is how the next reader "simplifies" it into inertness.

| Predicate | Rule |
|---|---|
| `answerSealed(task)` | is this row sealed? |
| `sealedAnswerReadable(task, actorUserId, revealed)` | **the whole read rule**: unsealed, or the actor is the author, or `revealed === true` |
| `redactSealedAnswer(row, actorUserId, revealed)` | drop the sealed keys from a task-shaped object for one reader |
| `redactSealedSnapshot(snapshot, liveTask, actorUserId, revealed)` | the same for a `task_versions` snapshot, decided on the **live** row's flag |
| `sealedEditDenied(task, actorUserId, revealed)` | refuse a write that would rewrite or re-grade against the key |
| `sealAtCreateDenied(actorUserId)` | refuse a seal with no resolvable author |
| `sealChangeDenied(existing, incoming, actorUserId, revealed)` | police the flag itself |
| `sealRevealDenied(task, isSuperadmin)` | v8.12.2 — may this actor reveal? sealed, and the live tier is superadmin; else `answer_seal_reveal_superadmin_only` |

Every one returns **`null` when allowed**, or `{ code, message }` when refused —
the `lib/event-admin.js` shape, so a caller hands either to the same responder.
The write gates answer **403**; `sealAtCreateDenied` answers **400** at create,
where the refusal is about the request rather than about a permission.
A **NULL actor is never the author**, and neither is a NULL `created_by_id`, so the
built-in superadmin and every authorless row fail closed — the built-in account
reaches a sealed key only through the reveal, like any superadmin.

**`revealed` is a FACT PASSED IN, never read by the module** — the
`sealTypeDenied(answerType, typeHasKey)` shape, which keeps the module pure. The
routes resolve it with `sealRevealedFor(req, taskId)` / `sealRevealSet(req)`
(`lib/event-admin.js`): true only when `actingIsSuperAdmin(req)` — a LIVE role
read of the acting human, the marker's admin under impersonation, never
`req.session.isSuperAdmin` (cleared in participant view, never set on an
impersonation session) — AND `req.session.sealedReveals[taskId] === true`, written
by `POST /api/admin/tasks/:id/sealed-reveal`. A demoted account's stale marker
therefore grants nothing, and a caller that passes nothing gets the author-only
rule, the safe default every participant-facing caller wants.

**What is sealed is `correct_answer`, `explanation` and `hint` (`SEALED_FIELDS`).**
The explanation travels with the key because in this threat model it is the key
wearing prose. The **hint joined in v8.12.2** (operator decision, reversing
v8.10.0's "authored to be read"): it is withheld wherever the key is — the admin
list (`hint_withheld: true` beside `can_see_answer: false`, the competitor
branch's own marker so the editor, preview and importer key one state), the
editor (hidden, and OMITTED from the save so an empty box cannot wipe it), the
history, the export (`hint: null` + `hint_withheld: 1`), the participant preview
and the end-of-event free reveal. The ONE exemption is the hint a participant
**paid** for — their own `hint_reveals` row — which `routes/participant.js` applies
by hand (`hintRevealed`), because it is a per-(participant, task) fact the redact
helpers cannot see; under impersonation that arm is gated on the acting human
being entitled, so an admin impersonating the author does not read the author's
own paid hint. On a multiple-choice challenge the correct **options** are withheld
while the option **text** stays on the wire, because the options are the question.

**THE REVEAL (v8.12.2).** `POST /api/admin/tasks/:id/sealed-reveal` is
`requireAdmin` + `csrfProtection` + the destructive-admin limiter, with the tier
asked INLINE (`sealRevealDenied(task, actingIsSuperAdmin(req))`) rather than by
`requireSuperAdmin`, because that middleware reads a session flag an impersonated
organiser's panel never carries and the ACTING human is who may reveal. Order:
404, the competitor lock (`competitorTaskEditDenied` over `competitorIds(req)` —
a superadmin competing in an event holding the challenge would be reading its key
for free, the §9.8 invariant's back door), the seat's scope (`taskViewDenied`),
then the tier. The author's own reveal is a 200 no-op (`author: true`); a second
reveal in one session is idempotent (`already: true`). A successful reveal writes
`req.session.sealedReveals[taskId] = true` and, ONCE per session per challenge,
`recordSealedReveal` (`lib/audit.js`): a `task_versions` row of `change_type
'sealed_reveal'` with `details: {via, fields, impersonated_by?, acting_as_id?}` —
`via` ∈ `admin_panel | impersonated_admin_view | participant_view |
participant_hint`, field NAMES only, never values, and never the request's ip /
agent, because `task_versions` is exempt from event retention — plus the
`sealed_answer_revealed` task audit event with the full `reqContext`. The History
dialog renders that row as a sentence with a *Record* cell in place of Restore,
skips it as a diff baseline and never marks it current; `POST …/restore` refuses it
by `change_type`; the admin list's `last_changed` ignores it. **The offer is the
server's**: the row carries `can_reveal_answer: true` (sealed, not the author's,
not yet revealed, acting human a superadmin, not held by an event they compete in)
or `answer_revealed: true` once revealed, and the client never re-derives either.
**The reveal lasts for the session SHAPE it was made in**: every regenerate (login,
the view toggle, impersonation entry and explicit exit) already
drops `sealedReveals` by restoring a fixed field list, and
`restoreImpersonatorSession` deletes it on the in-place forced exit so a reveal
made inside a seat cannot outlive the seat. **The participant surface has no
control**: there the open IS the reveal — a superadmin (own participant view, or
impersonating anybody) is shown a sealed value wherever the author would be, and
`GET /api/tasks/:id` / `POST /api/tasks/:id/hint` record each such disclosure
(`participant_view` / `participant_hint`) without touching the session (a session
write on a GET emits a cookie — the v7.14.5 slide rule). **The record GATES the
disclosure (v8.12.6)**, as the explicit route's record-before-marker always did:
v8.12.2 swallowed a failed record on this surface and shipped the values anyway. Now a record
that cannot be written withholds exactly the fields it would have named — the GET
stays 200, carrying `answer_sealed_withheld` / `hint_withheld` with
`answer_withheld_reason` / `hint_withheld_reason` set to `unrecorded` (a value
deliberately outside `SEALED_HINT_WITHHELD_REASONS`, which
names readers the seal BINDS, where this one is a reader it admits) — and the hint
POST records BEFORE its `hint_reveals` INSERT and answers
`503 answer_seal_reveal_unrecorded` with nothing written and nothing charged,
the impersonated target included. The record takes the write lock up front
(`.immediate`), so a brief lock held by another process is waited out rather than
failing at once — which is also what makes recording first safe. The severity was
accountability, not confidentiality: the reader is always a superadmin the seal
admits. A regular admin impersonating the author sees neither key nor hint.

**Reads.** One predicate, applied at every egress: the admin challenges list (the
only admin read of a task row, and therefore the widest redaction site on the
platform — the key stops being **sent**, not merely drawn), the version history
**retroactively** (snapshots taken before the seal are redacted too, on the live
row's flag), the challenges JSON export, the participant answer reveal, and the
admin Submissions stream — where the **search box** is redacted on the same per-row
predicate, since a match count over a guessed answer confirms the key without ever
painting it — and the participants CSV exported with an event open, which drops a sealed *any-answer*
challenge's column outright rather than exporting it blank, since on that type the
participants' responses are the only secret there is. Every one takes the
`revealed` argument, so a revealed superadmin reads each of them as the author
does — the Submissions stream NARROWS the revealed set to challenges the acting
human does not compete in, because a row that appeared after the reveal must not
widen it onto a rival's answers.

An **absent** key means withheld, never empty: `answer_type='any'` legitimately
stores an empty answer, and a reader who saw a blank and saved would wipe a value
it was never allowed to read.

**Writes — seven routes take `sealedEditDenied`, and the SEVENTH is the reason
for the other four.** `PUT /api/admin/tasks/:id` (the whole request, not just the
answer fields — the admin form posts `correct_answer` unconditionally, so a
permitted title-only save by a non-author would arrive carrying an absent key),
`POST …/restore`, `POST …/recalculate`, `POST …/publish`, `PATCH …/visibility`,
and both tag routes — each passing `sealRevealedFor(req, task.id)` since v8.12.2,
so a revealed superadmin passes every one. The challenge import is an eighth write
path that consults the seal, and the one exception to the shape: it **skips** the
row rather than refusing the request, for the reason given below.

The seal decides `can_edit` **outright** rather than narrowing the event-admin
answer of §9.1, and `can_edit` and `can_edit_scoring` collapse together on a
sealed row. **That is what forced the last four**: the challenge row derives
**Publish**, **Hide/Show**, `+ tag` and the per-tag `×` from those same two flags,
so it already withheld all four from a non-author — and a screen that hides a
control the route would accept is v7.14.2 with the sides swapped, because the next
reader restores the button on the evidence that the route works. Both ends move
together. It is also the operator's own requirement read literally: `status` and
`active` are scoring fields (`taskScoringEditDenied`), so publishing or hiding somebody's sealed challenge
is editing it.

**What is deliberately NOT seal-gated**, so a sealed challenge is never stranded:
**assigning** it to an event, **unassigning** it again, granting attempts, reading
its History, lock/unlock, and a superadmin's hard **delete**. So an organiser who
needs a sealed challenge out of their event has two un-sealed ways to do it
without its author, and a superadmin has a third.

**A SEAL REQUIRES A KEY, so `answer_type='any'` may never be sealed (v8.10.1).**
`answerTypeHasKey` already owns which types carry one, and `any` does not — v8.9.0
stores `correct_answer=""` for it by construction. `sealTypeDenied` refuses the
pair at three doors, and each assembles it differently: **create** from one
request, the **PUT** from the STORED flag plus the INCOMING type, and **restore**
from the live flag plus a SNAPSHOT's type (`answer_sealed` is not restored while
`answer_type` is). Result-based rather than delta-based, so the two escapes —
unseal, or leave the type alone — are ordinary saves that pass and a row holding
the pair is never bricked.

The predicate takes `typeHasKey` as an ARGUMENT rather than deriving it, because
`lib/answer-seal.js` must not require `lib/scoring.js`: that reaches `lib/config`,
which exits without `BASE_URL`, and would destroy the purity the module's
column-0 spec depends on (the `lib/late-entry.js` shape).

**Sealing is a one-way door.** It is chosen at create and nowhere else. The author
may **unseal** later — and so may a superadmin who has revealed it (`sealChangeDenied`
takes `revealed`; a superadmin who has NOT revealed cannot clear the flag, because
that would put the key on every admin's screen with no reveal on record) — unless
the challenge is assigned to an event where staff compete, which refuses it at any
status of that event (§9.8, door 3); **nobody may seal again**, the author
included. Between
creation and now the key has been on every admin's screen, in `task_versions`, in
the tasks export and in `app.jsonl`, and a column flip retrieves none of that — a
platform that accepted the re-seal would be promising a secrecy it had already
lost. `sealChangeDenied` refuses it **with its reason** rather than ignoring it,
and treats an **echo** of the stored value as no change at all, so a client that
round-trips the whole row keeps working (the `event_kind` rule).

**A seal requires a resolvable author, so three populations cannot have one.**
`tasks.created_by_id` is not backfilled (§9.4), the challenge import never writes
it, and the built-in `superadmin` account has no `users` row. A seal on such a row
would be **unowned** — unreadable and uneditable by every human alive, with no
remedy short of hand-written SQL — so `sealAtCreateDenied` refuses at create and
names the remedy (sign in as a named admin account). That is not a limitation
bolted on afterwards: the feature is defined as "the author, and a superadmin on
the record", so a challenge with no author cannot express it. (Since v8.12.2 an
authorless seal would no longer be unrecoverable — a superadmin could reveal it —
but it would still be a key with no owner, and the create refusal is kept.)

**Sealed challenges do not migrate.** The import **refuses** a file row marked
sealed and counts it as `sealed_skipped`, separately from its other skips, because
the imported row would have no author on the destination platform — and importing
it *unsealed* would silently break the promise the source platform made. It equally
refuses to **overwrite** a sealed challenge the importer does not author (or has
not revealed). Both are
skips rather than a hard failure, so one sealed row cannot sink a 500-row
migration, and the guides say to create the challenge fresh instead.

**What it is not, stated because a control believed to do more than it does is
worse than none.** It does not hide the challenge, its title or its description,
nor the hint a participant pays for; it does not hide who solved it or any score;
and it is **not encryption
at rest** — anyone with direct access to the database or its backups still reads
the answer. It is a control over the platform's own screens and exports.

**Two accepted costs.** A sealed challenge contributes **no explanation** to the
end-of-event answer reveal — participants are shown that the answer was sealed and
why, rather than nothing at all — and a **solver** is not exempt from the read
rule, although their submitted answer was the key by construction: the rule is that
the value never reaches a client, and a build that echoes it back for one class of
reader is a build whose promise depends on who is asking.

### 9.8 Staff can compete — a per-event switch, and a tier-blind lock (v8.12.0)

**The shape, read first, because it is the third kind this document holds.**
Every rule above is a **tier** (which role), a **scope** (which events), or — §9.7
— **one account**. This one is a **per-event switch** and, once it is on, a lock
keyed on a **row**. `competitions.staff_compete` (label **Staff can compete**,
`INTEGER NOT NULL DEFAULT 0`, every kind, no per-kind seed) is off by default,
and the default is the backfill — every event created before the column existed
is off — so nothing about the platform moves until an organiser turns it on. While it is on, a staff member
who holds a `competition_users` row on that event competes exactly like anybody
else — board, all-solved denominator, presence, certificates, exports — and, in
return, **cannot change that event or any challenge it holds, whatever their
tier**. An administrator does not pass that lock, and a superadmin does not pass
it. The built-in `superadmin` account has no `users` row, so it can never hold a
`competition_users` row and is structurally exempt — stated rather than
discovered. The lock is keyed on the row at **any** status: it does not lapse
when the event ends, and since a finished event's roster is settled for everybody
(the ended-event membership rule refuses every removal, self included — with the
one v8.12.6 exception of a LATE ENTRANT while a Booth Event's late-entry window is
open, §9.9), a competitor in a finished compete event stays locked out of it and
its challenges — another organiser edits them. The escape hatch below is
therefore available **while the event has not ended**, never "always".

**Three words, deliberately distinct, because each is keyed on a different fact.**

- **staff** (for *scoring*) is the `staff` tag **or** the `event_admin` role —
  the two sources every board and the denominator already exclude by (§6). The
  switch lifts **both together**: lifting one would put a global admin on the
  board while the event admin beside them stayed off it, for no reason anybody
  could read off a screen. Every admin and superadmin is auto-tagged `staff` on
  promotion; an event admin is never tagged and is excluded by role alone.
- **competitor** (for the *edit lock*) is **any** actor holding a
  `competition_users` row on an event whose switch is on — all tiers, superadmin
  included. Not "a staff-tagged actor with a row": an admin created by the
  maintenance seeder, or one whose tag was hand-edited away, holds admin rights
  without the tag, and a lock keyed on the tag would let exactly that account
  edit the event it is enrolled in. The row is the fact that cannot be argued
  with.
- **own** (for the *picker*) is simply "holds a row", switch or no switch. For an
  ordinary participant every row is own; for a staff member it is what separates
  the events they were put in from the ones they may merely enter. On the
  participant wire **`competing`** is `own && staff_compete`. A **spectator** is
  a staff-tagged user entering an event where staff do *not* compete: admitted
  without a row.

**It is its own module, and the reason is §9.7's.** The rule lives in
`lib/staff-compete.js`, pure at module scope — it requires nothing, so a spec
can `require` it at column 0 and drive the whole predicate matrix with no server;
the helpers that need the database take `db` as an argument (the
`lib/challenge-fit.js` shape), and every row predicate **throws** on a row that
lacks the column it reads rather than falling through to "not set" (the v8.4.0
`_profileMissingFields` posture: an under-selected competition row that read as
*switch off* would admit the very unsealed challenge the rule exists to keep out,
with every test green). It is **not** in `lib/event-admin.js`, and it must not be moved there:
that module's predicates open with `if (scopedCompetitionIds(req) === null)
return null` — global admins and superadmins bypass ownership by their first
line, which is right for that tier system and the exact opposite of what this
lock means. `lib/answer-seal.js` is the precedent, and its header says why
folding a tier-blind rule in beside tier-exempting ones is how the next reader
"simplifies" it into inertness.

| Predicate | Rule |
|---|---|
| `staffCompeteOn(comp)` | is the switch on? **Throws** on a row that never selected the column |
| `competitorIn(db, actorId, compId)` | the one fact every competitor predicate wraps: the actor holds a row on this event **and** its switch is on. It is also what `competing` is computed from on the admin list, every `_compWire` response (`staffCompeteFlags`, `lib/competitions.js`) and the group→events rows of `GET /api/admin/groups/:id/competitions`, and what the participant import's `actor_competes` skip asks |
| `competitorEditDenied(db, actorId, compId)` | the competitor lock at a **competition** door: `competitorIn`, answered as a refusal |
| `competitorTaskEditDenied(db, actorId, taskId)` | the competitor lock at a **challenge** door: the first compete event the actor competes in that holds this challenge |
| `competitorGroupDenied(db, actorId, groupId)` | the competitor lock at a **group** door — the first `competitorEditDenied` over every event the group is bound to, because group membership live-syncs into every bound event (§9.2's transitive rule, applied to the lock); a group bound to no event answers `null` |
| `competitorRivalDenied(db, actorId, targetUserId)` | the competitor lock at an **account** door — the first compete event, by name, that BOTH the actor and the target hold a row on (a RIVAL: somebody on the board the actor competes on); `null` for self, for the built-in superadmin and for a pair that share no compete event. `rivalsOf(db, actorId, userIds)` is the same question over a page of rows, one query, riding each admin participant row as `rival_in` so the pane withholds the doors with their reason |
| `unsealedAssignmentDenied(task, comp)` | seal door 1 — a compete event admits only a sealed challenge |
| `authorCompetesDenied(db, task, comp)` | seal door 4, from the challenge side — the author holds a row on this compete event |
| `unsealDenied(db, taskId, scope)` | seal door 3 — the challenge is assigned to a compete event, at **any** status of that event, so it may not be unsealed (`sealedTaskCompeteEvents` carries no status term); `scope` — the actor's `scopedCompetitionIds`, `null` for an unscoped tier — decides which of those events the refusal **names**, the rest being a count |
| `switchLock({fullyEnded, anySlotStarted})` | the lock on the switch itself; ended is asked first, because ended implies started and the started reason would otherwise answer with the wrong words |
| `staffRowRefusal(user, comp)` | in `lib/self-enroll.js`: **the one predicate every non-admin row-writer shares** — `'spectator'`, `{authored:[…]}` or `null`. Grep `staffRowRefusal(` for the set rather than trusting a count: today the join link, the deferred pending-join consume, group sync, the invitation route's existing-user path and the invitation claim at sign-in (`lib/invitation-claim.js`) |

Every one returns **`null` when allowed** — the `lib/event-admin.js` and
`lib/answer-seal.js` shape — and the competitor refusals are written from one
denial shape and, on every door, by one responder, `refuseCompetitor` — the
desired-state `PUT /api/admin/tasks/:id/competitions` additionally re-asks
**both** directions — every event that changes, added or removed — inside its
transaction as the race guard, throwing the
denial out and hand-composing the same body in its catch — so every door
answers **403** with one body:
`{error, code:'competitor_cannot_edit', competitionId, competitionName}`. The
refusals about the *switch* and about *assignment* are **400**, being about the
request rather than about a permission; the unseal refusal is **409**, being
about the challenge's own state; and the two superadmin **imports** neither
refuse nor 403 — they keep their skip-and-report posture (below).

**The switch has five refusals, all above `validate_only` so the client's dry
run meets every one of them, and an echo of the stored value is never a change.**
They are asked in the order of the table: the lock first (ended, then started),
and then — on the way **on** — unsealed challenges before enrolled authors, so a
request that trips both hears the unsealed reason.

| Refusal | Code | When |
|---|---|---|
| **Locked, ended** | `staff_compete_locked_ended` | changing it once the event has fully ended — the standings are final and any certificates already issued assert them |
| **Locked, started** | `staff_compete_locked` | changing it once any session, or the event, has started; **re-checked inside the write transaction**, because status is time-derived and can cross the start boundary under the request — it is a ranking-shape setting, exactly like `leaderboard_mode` and `time_basis`, and flipping it mid-event adds people to or removes them from the board |
| **On, with unsealed challenges assigned** | `staff_compete_unsealed_challenges` | 0→1 while any assigned challenge is unsealed; the body names them (`challenges:[{id,title}]`). The switch is the *second* door into the "compete event holding an unsealed challenge" state and is refused like the first |
| **On, with an enrolled author** | `staff_compete_enrolled_authors` | 0→1 while any row-holder **authored** a challenge the event holds — any tier, tagged or not, because the row is what will compete; the body names them with their challenges (`participants:[{id, nickname, tasks:[{id,title}]}]`, from `enrolledAuthors`). The switch is the *third* side of seal door 4: the moment it lands, that person competes against their own key, which every other row-writer already refuses |
| **Off, with staff enrolled** | `staff_compete_enrolled_staff` | 1→0 while a staff-**tagged** user holds a row; the body names them (`participants:[{id,nickname}]`). The tag, not the role: an event admin may legitimately be enrolled in a non-compete event, so their row is not evidence of anything, while a tagged row is a row that **scores while the switch is on and would stop scoring the moment it went off** — so the operator removes the competitors deliberately first. (Not "a tagged row can only have been written while the switch was on": a participant enrolled while it was off who is later promoted to admin is auto-tagged and keeps their row, and the refusal is right about them for the same reason.) |

The switch rides the admin list and every `_compWire` response as
`staff_compete`, beside `staff_compete_locked` (`null | 'started' | 'ended'`,
from which the form withholds the control with its reason) and `competing`
(this actor holds a row and the switch is on). It is **exported** with the
competition, and the public join-link preview carries it, so the join flow can
ask a staff member whether they mean to compete **before** a row is written. A
change busts the leaderboard cache and every member's `/api/me` entry
post-commit, and turning it **on** re-converges every group bound to the event
(`reconcileCompetitionMembership`, fire-and-forget), so a bound group's
staff-tagged members are enrolled the moment the save lands rather than at the
next unrelated membership change; the sync's own `staffRowRefusal` still skips
an author.

**The seal invariant has FOUR doors, and it is a theorem only if it holds from
every one of them.** A competing admin can open the admin Challenges pane, where
the answer key of an *unsealed* challenge is on screen for every admin tier. So
an event whose switch is on admits **only sealed challenges** (`answer_type='any'`
can never be sealed, §9.7, so it can never be assigned to one), and never a
challenge whose **author** holds a row on it:

1. **Assignment** — every path that writes a `competition_tasks` row. The single
   `POST /api/admin/tasks/:id/competitions` answers 400 with
   `code:'staff_compete_unsealed' | 'staff_compete_author_competes'` and a
   `refused:[{task_id, title, competition_id, competition_name, reason, message}]`
   ledger, **all-or-nothing** — nothing is assigned. The ledger is **complete
   in its count**: a pre-pass collects every refused (challenge, event) pair
   over the whole request before the insert loop, so a request naming two
   compete events reports both pairs and `refused_total` is the true count,
   while the `refused` list itself is capped at 50 entries on every assignment
   door (`capRefused` — a modal listing a thousand rows helps nobody); an
   **ended** event is skipped by that pre-pass and keeps its own older "session
   has already ended" refusal. The desired-state `PUT` asks the question of **additions
   only**, with the same complete pre-pass over them: taking an unsealed
   challenge *out* of a compete event is never refused on seal grounds (the
   ended-session freeze and the competitor lock still apply to a removal), or
   the state could never be repaired. The bulk `POST /api/admin/tasks/assign-competitions`
   keeps its best-effort posture and counts `skipped.unsealed` and
   `skipped.authorCompetes`, with the same capped `refused` ledger and honest
   `refused_total`.
2. **The switch** — turning it on with unsealed challenges assigned, the third
   row of the table above; and, for door 4, turning it on with an enrolled
   author, the fourth row. The switch is a door into **both** seal rules,
   because it is the one write that turns an ordinary roster into a set of
   competitors without touching a single row.
3. **The unseal** — a task `PUT` taking `answer_sealed` 1→0 while the challenge
   is assigned to a compete event, at **any** status of that event, answers 409
   `{code:'answer_seal_in_compete_event', competitions:[{id,name}]}`.
   `sealedTaskCompeteEvents` asks one question — *is it assigned to an event
   whose switch is on* — and carries **no status term**, deliberately: an
   ended event is not a safe one, because every kind of end **revives**. A
   manual end plus a deliberate extend always revives (v7.7.x); a time-expired
   event revives by pure arithmetic the moment its duration is extended, with
   no handler running at all; a new session or a participant assign revives
   too; and **no revive path re-asks the seal question** (the arithmetic one
   cannot). So a rule that released the seal on a fully ended event let the
   author unseal, then have the event revived — a live compete event holding
   an unsealed challenge, its key on the tasks export and its rivals' answers
   on the Submissions stream — and a rule that released it on "any session has
   ended" (`lib/challenge-fit.js`'s assignment rule) let the author unseal
   after the first session of a multi-session event while a later one was
   still live. Neither transfers here, because this refusal names a second
   remedy that is always available: **leave the answer sealed**. The **cost is
   stated rather than hidden** — a challenge assigned to an ended compete event
   cannot be unsealed for as long as it stays assigned, and taking it out of a
   finished event is itself refused by the ended-session freeze; it costs the
   author nothing they hold, since the author reads and edits a sealed
   challenge. The refusal's message names both remedies (*take it out first,
   or leave the answer sealed*) whatever the event's status; the client's note,
   below, is what says which still applies. The events it **names** are scoped
   the way the challenge row's own
   event list is (§9.5c): an event-admin author is named only the events in
   their own scope, and the rest ride as `withheld_competition_count` (present
   only when non-zero) with the message naming them as a count — *"…and N
   more outside your events"* beside the named ones, or *"(N outside your
   events)"* when none of the holding events is in scope and `competitions`
   is `[]`. The client asks the same question of the row's own
   `competitions[]` entries, which carry `staff_compete` for this reason —
   and, because that array is scope-narrowed for an event admin, of the row's
   `withheld_compete` flag (present, and `true`, only when a withheld event
   lets staff compete) — and **withholds** the *Unseal this answer* row from
   the editor when any named or withheld holding event is a compete event,
   naming the events it can name and counting the rest in its place; the
   remedy it offers is *take it out of that event first, or leave it sealed*
   only while every holding event is in scope and has not ended, otherwise
   that event's organiser where one is out of scope, and otherwise says the
   finished event's challenge list cannot be changed, so it stays sealed for
   as long as it stays assigned. This is the reorder door: without it an
   organiser reaches the forbidden state by assigning sealed, then unsealing.
4. **The author** — `sealedAnswerReadable` admits the author by definition, so a
   challenge whose author competes is a challenge whose key one competitor can
   read. Refused from **three** sides: assigning the challenge to an event its
   author competes in (`authorCompetesDenied`); enrolling the author into an
   event that holds their challenge (`skippedAuthors` at the admin assign door,
   `staffRowRefusal` at every other row-writer, below); and turning the switch
   **on** while an enrolled row-holder authored an assigned challenge
   (`staff_compete_enrolled_authors`, the fourth row of the switch table — the
   one side that needs no row written, since the switch is what makes the
   existing rows compete). A NULL author — an
   imported, pre-v8.7.0 or built-in-superadmin row (§9.4) — competes nowhere and
   blocks nothing.

**The competitor lock — the door list, and what holds it.** Every door listed
below refuses 403 `competitor_cannot_edit` for every tier when the actor
competes in the event named, or in an event that holds the challenge named.
**The lock is applied per door and there is no default-deny guard** — unlike
§3's `eventAdminGuard`, nothing refuses a mutating route that forgot to ask —
so the list is held behaviourally by `tests/staff-compete-lock.api.spec.js` (the
late-entry close door by `tests/late-entry-close.api.spec.js`, clone,
save-as-template and the template doors below by
`tests/event-clone-templates.api.spec.js`), and
a mutating route added later must take `competitorEditDenied`,
`competitorTaskEditDenied` or `competitorGroupDenied` itself, or it is open.

**Where the refusal sits decides which reason a competitor hears, and it is
not one placement.** On the event's own routes, the session routes, the group
unbind, the join-link rotate, the desk invite and the participant removal of
anybody but the actor (the self-removal carve-out below skips both gates) it is
asked **after the 404 and before `competitionDenied`**; on every challenge door
it is asked after the challenge's 404 and ahead of the locked-task gate, the
seal and the event-admin scope gate (a route's own `requireSuperAdmin`
middleware still runs before the handler, so a regular admin at a
superadmin-only door hears that and never reaches the lock); and on the three
assignment doors it is asked first too (the `POST` over every named event, and
the `PUT` over both its **additions** and its prospective **removals**, right
after the challenge's 404 and ahead of `taskViewDenied` and the locked-task
gate — the removals diffed from the full current set against the desired set
and narrowed to the actor's scope, so an event admin is never refused over an
event they cannot see, and re-asked inside the transaction beside the real
diff as the race guard; the unassign `DELETE …/competitions/:cid` has no
challenge 404 at all and asks the lock **first of all** — ahead of the
locked-task gate, `taskUnassignDenied` and even the event's own 404, so a
competitor naming a challenge that does not exist hears the lock rather than a
404) — so on all of those every tier hears the same reason: a competing regular
admin dropping a **locked** challenge from the event they compete in hears
`competitor_cannot_edit`, not "locked" with no code. The doors that answer the
event-admin **scope** refusal first are the three body-keyed roster doors —
`POST /api/admin/competitions/assign`, `POST /api/admin/invitations` and
`POST /api/admin/tasks/:id/attempt-grant` — **and every group door**: the five
group-membership routes answer their own scope predicates (`groupWriteDenied`,
`groupDeleteDenied`, `participantDenied`) before `competitorGroupDenied`, and so
do the invitation's `groupIds` and `newGroups` pre-passes (`groupWriteDenied`
first); only the group **unbind** asks the lock ahead of `competitionDenied`.
The only actor who can meet a scope answer at any of those instead of this one
is an event admin competing in an event they do not organise.

*Competition doors* (`competitorEditDenied`): `PUT /api/admin/competitions/:id`,
`DELETE /:id`, `POST /:id/end-now`, `POST /:id/late-entry/close`, `POST|DELETE /:id/tags[/:tag]`,
`PUT|DELETE /:id/cxone`, `POST|DELETE /:id/admins[/:uid]`,
`POST /:id/clone` and `POST /:id/save-as-template` (a copy, or an event made
from the template, carries the event's challenges into an event the competitor
would organise; operator ruling, 14 Nov 2026, for the template),
`POST /:id/self-enroll/regenerate`, `POST|PUT|DELETE /:id/timeslots[/:tsId]`,
`POST /:id/timeslots/bulk-delete`, `POST /:id/timeslots/:tsId/end-now`,
`DELETE /:id/groups/:groupId` (unbind), `POST /api/admin/competitions/assign`
(any named target event), `POST /api/admin/participants/desk-invite` (with a
`competitionId`; asked again at commit — v8.12.7),
`POST /api/admin/invitations` (any named event that can still take people — one
that cannot is dropped before the lock is asked),
`POST /api/admin/tasks/:id/attempt-grant` (the `competitionId` in the body), and
`DELETE /api/admin/competitions/:id/users/:uid` — **except** when `:uid` is the
actor's own id.

*Group doors* (`competitorGroupDenied` — the group is bound to an event the
actor competes in, so a membership change would reconcile onto their own
board): `POST /api/admin/groups/:id/members`,
`DELETE /api/admin/groups/:id/members/:userId`, `DELETE /api/admin/groups/:id`
(it unbinds and reconciles every bound event),
`POST|DELETE /api/admin/participants/:id/groups[/:groupId]`, and the groups an
invitation would apply (`groupIds` / `newGroups` on
`POST /api/admin/invitations`) — asked for every existing group id beside
`groupWriteDenied`, and for every `newGroups` name that resolves to an
**existing** group, in a pre-pass **before any group is created**, so a
refusal leaves nothing behind; a name that would create a new group is bound
nowhere and is not asked. Deliberately NOT gated: the rename
`PUT /api/admin/groups/:id`, which moves no membership, and
`POST /api/admin/groups` (a group created with a `userIds` seed is bound to
nothing).

*Challenge doors* (`competitorTaskEditDenied` — the challenge is held by an
event the actor competes in): `PUT /api/admin/tasks/:id`, `POST …/publish`,
`PATCH …/visibility`, `DELETE …/:id`, `POST …/restore`, `POST …/lock`,
`POST …/recalculate`, `POST|PATCH|DELETE …/attachments[/:aid]`,
`POST|DELETE …/tags[/:tag]`, and the two superadmin feedback purges
`DELETE …/:id/feedback[/:userId]` — a superadmin competing in an event that
holds the challenge may not purge the feedback left on it.

*Template doors* (`competitorEventsForTask` — a challenge is held by an event the
actor, the seat or the hand, competes in, at any status; operator ruling, 23 Nov
2026, extending 14 Nov's): such a challenge cannot go into a template, so
`POST /api/admin/event-templates`, `PUT /api/admin/event-templates/:id` (which
re-judges the whole stored list, so such an actor cannot even rename a template
holding one) and `POST /api/admin/competitions/:id/save-as-template` refuse 403
`template_task_competing`, naming the challenge and, only to an actor who may see
it, the event; and an event made from a template
(`POST /api/admin/event-templates/:id/spawn`) or by `POST /:id/clone` leaves it
out, reported in `skipped_challenges` with reason `competing`. Deliberately NOT
gated: the assignment doors, which still let a competitor add such a challenge to
an event they do not compete in.

*Account doors* (`competitorRivalDenied` — the target is a RIVAL; the
operator's ruling of 19 Sep 2026, after the first draft asked the lock at every
event- and challenge-keyed door and at none keyed on a USER, through which a
competitor could take a rival off the board they compete on without touching
the event row): `POST /api/admin/participants/:id/verify`, `…/approve`,
`…/deny`, `…/block` (unblock included), `…/impersonate`, `…/login-code/email`,
`…/login-code/reveal` (Show sign-in code, added by operator ruling, 11 Nov 2026:
its answer is a working credential for the rival's account, which a competing
organiser could read out and sign in with; the participant row's menu withholds
it on a rival row with the rest),
`…/role`, the superadmin `DELETE /api/admin/participants/:id`, an ADDRESS move
through `PUT /api/admin/participants/:id` (the primary or the secondary email:
a primary staged to a mailbox the competitor reads is confirmed by its own code
and then signs in as the rival; every other profile field stays editable, an
echo of the stored addresses is no move, and the edit dialog locks both address
fields on a rival row with the reason), the `benchmark`
tag alone on `POST|DELETE …/:id/tags[/:tag]` (it takes a rival off the ranked
board; no other tag is a board input where staff compete, the `staff` tag being
inert there), and `POST /api/admin/badges/:token/revoke` — that last one
through `competitorEditDenied` on the badge's own event, a certificate being a
fact about one board. Asked right after the 404 and ABOVE the peer-admin rule
(`participantDenied`, the v7.14.2 tier rule), so every tier hears the same
reason; never on the actor's OWN account. `impersonationGuard` re-asks it on
every non-GET off the allowlist for BOTH tiers, in either view, while an
impersonation runs, so a pair that become rivals mid-session — the acting admin
enrolled into the target's compete event by a colleague — cannot move the board
as the target; the exit is allowlisted and stays reachable. The participant
import's **overwrite** is an account door too, in the import's skip-and-report
posture: it rewrites `blocked`, `verified`, `approved`, the denial, the role and
the whole tag set, so an overwrite of a rival's account is skipped whole and
counted as `rival_skipped` (below). Two approvals are account doors in the
same posture: an invitation's automatic approval of an existing waiting account
(a rival's stays waiting, counted as `skippedUnapproved`) and bulk approve
(`POST /api/admin/participants/bulk-approve`, the selection bar's **Approve**),
which skips a rival's account and counts it as `skippedRival`. **The event-admin
view asks a second question of the same shape (v8.12.1)**: does the ACTING admin
hold a row on an event the ORGANISER runs where staff compete? Entry refuses the
admin view outright (`actingAdminCompetesInTargetEvents`, `competitor_cannot_edit`
naming the event — the participant view still opens) and the guard re-asks it on
every write in that view, because through the organiser's panel a competing
admin could edit the board they compete on with the organiser's hands. Deliberately NOT gated: `…/unlock`
(a login-lockout release moves no board), the profile edit, History, the
person export (`GET /api/admin/participants/:id/export/full`: a read, like Export
Activity, which already gives every rival's activity; a compete event holds
sealed challenges only, so the rival's answers there stay withheld — operator
ruling, 24 Nov 2026) and every other tag.

*Assignment doors*: `POST …/:id/competitions` (any named target event),
`POST /api/admin/tasks/assign-competitions` (any named target event — refused
before any write), `PUT …/:id/competitions` (only the events that **change**,
added or removed, are asked — an event that stays as it was cannot make a
competitor of the caller; additions are asked against the FULL current set, so
no narrowing can hide one, and removals against the set this actor was shown,
in the pre-pass above the locked-task gate and again inside the transaction),
`DELETE …/:id/competitions/:cid`.

*The two imports* are competitor doors in their own **skip-and-report**
posture rather than a 403, because one row must not sink a migration file:
the participant import (`_rehydrateMemberships`) skips a membership row into
an event the acting superadmin competes in with
`skipped_memberships[].reason === "actor_competes"` — never their **own** row,
which is written but never with a file-supplied `login_time` (NULL, so the lazy
stamp anchors it) — drops a group association whose group is bound to an event
the importer competes in (`_rehydrateGroups`, counted as
`group_actor_competes_dropped`, the group door in the import's own posture),
and skips an absence row into such an event, or the importer's **own** absence
on any compete event, as `skipped_absences[].reason === "actor_competes"`
(beside that ledger's `competition_not_found` and `timeslot_not_found`); and
the challenge import skips an **overwrite** of a challenge held by an
event the importer competes in, counted as `competitor_skipped`. A compete
event holds only sealed challenges, so for a non-author that overwrite is
already the seal's own skip; the one this catches is the **author**, whom the
seal admits and the lock does not. The participant import also skips an
**overwrite** of a rival's account (the account door above), counted as
`rival_skipped`. The client renders every one of those
counts, the absence ledger included.

**The escape hatch is self-removal, and it is the ONE carve-out.**
`DELETE /api/admin/competitions/:id/users/:uid` is refused for every `uid` but the
actor's own. The lock refuses every other change to the event on the strength of
the competitor's row, so the row must be theirs to drop — or a sole superadmin
who joined their own event would be locked out of it with no way back but
hand-written SQL. The carve-out skips the event-admin **scope** gate
(`competitionDenied`) as well as the lock, for the carve-out's own reason: an
event admin enrolled by a global admin into a compete event they do **not**
organise is bound by the lock on every challenge it holds, and the refusal's
remedy names self-removal — a door the scope gate would otherwise shut on them,
with the participant-side **Leave** scoped to self-enrolment. Their own row is
the one thing on that event that is theirs; anybody else's still takes both
gates. Removing anybody *else* from the board they compete on is
refused like every other door. It is open **while the event has not ended**: the
ended-event membership rule (400, pre-existing) refuses every removal from a
finished event, self included, so a competitor in a finished compete event stays
locked out of it and its challenges, and another organiser edits them. The one
exception (v8.12.6, §9.9) is a competitor who is a **late entrant** of a Booth Event
still inside its late-entry window and had not started playing before it ended: the
self carve-out is asked first, as ever, and the late-entry removal rule then admits
their own row. The remedy clause below is
deliberately unchanged for that case — it still reads *"Ask another organiser to
make the change."* once the event has ended — so the wire under-offers a door that
exists for that narrow cohort rather than offering one that does not. The
refusal's remedy clause says which of the two applies: while the event has not
ended it ends *"Ask another organiser to make the change, or remove yourself
from the event first."*, and once the event has fully ended the self-removal
clause is dropped and it reads *"Ask another organiser to make the change."*
— an instruction that is not true is worse than none (the `FROZEN_REMEDY`
rule), and self-removal is exactly what the ended-event rule refuses. The
client's own toast and kebab note are shorter and branch the same way on the
event's status: the edit-form toast offers *"remove yourself from the event
first"* only while the event has not ended and reads *"Ask another organiser to
make the change."* once it has, and the Participants row's competing note reads
*"its participants cannot be changed from here"* while it has not ended and
*"it cannot be changed from here"* once it has.

**What a competitor's admin projection withholds.** `GET /api/admin/tasks` is
the only admin read of a task row (§9.7). It resolves the set of compete events
this actor holds a row on **once per page** (`_competingSet`, its own
`c.staff_compete = 1` SQL) and intersects each row's events with it, so a
competitor's row carries `competing_in:[{id,name,status}]`, `can_edit:false`,
`can_edit_scoring:false`, `can_see_answer:false`, and `can_unassign:false` on
every competing event in its `competitions` array (whose entries also carry
`staff_compete`, so the editor can withhold the *Unseal* row — door 3);
`correct_answer` and `explanation` are **deleted**; and the **`hint`** is deleted
too, with `hint_withheld` in its place — `true` only when there was a hint to
withhold, so the editor never announces a withheld hint over a box that was
always empty. The hint needed its own line because until v8.12.2 it was
deliberately **not** a sealed field — a participant pays 30% of the challenge's
points to read it — so the seal's redaction never touched it, and a competing
admin reading it off this pane would be reading it for free; the seal withholds
it too now (§9.7) and emits the SAME `hint_withheld` marker, the client telling
the two reasons apart by `competing_in` versus `can_see_answer === false`. The per-challenge question — *which compete
events does this actor compete in that hold this challenge* — is
`competitorEventsForTask`, and its three callers withhold the same way: the
version history (`GET …/:id/versions`) removes all three fields from every
snapshot for a competitor; the tasks **export** ships `hint: null` plus
`hint_withheld: 1` for such a challenge (the marker only when the challenge has
a hint), and the challenge import honours it — an overwrite of a row carrying
`hint_withheld` keeps the stored hint rather than wiping it with an empty one,
while a create from such a row lands with no hint; and the challenge import's
`competitor_skipped` asks it before an overwrite (above). The key *should*
already be sealed and not theirs to read — that is the invariant — but the
invariant is enforced at doors, and a projection must not rest on it: belt and
braces, stated.

**Staff row-writers — "staff assignable ONLY to compete events" (operator
decision 1).** A `staff`-tagged user is admitted to every event without a row,
so a row for them means *they compete
here*, and every writer of one applies the same rule:

- **The admin assign door** (`POST /api/admin/competitions/assign`) decides per
  (user, event) pair, blocked and unapproved checks first, and reads the
  **existing row before the staff rule**: a staff-tagged target who already
  holds a row on a non-compete event — assigned before the tag, or before the
  switch existed — is a member whatever the switch says and takes the
  idempotent path like anybody's (the direct-assign promotion), never a staff
  skip. A staff-tagged target with no row on a non-compete event is skipped and
  counted in `skippedStaff` — **per pair, not per user**, because one request
  naming two events may legitimately enrol them in one and skip the other; on
  a compete event the peer-admin rule
  (below) is asked next, and then a target who authored a challenge assigned
  to it is skipped and named in
  `skippedAuthors:[{userId, nickname, competitionId, competitionName, tasks}]`
  (seal door 4 from this side). Only the peer-admin skip exempts the actor's
  own id: an actor self-assigning onto a non-compete event with no row is
  skipped as staff, and an author self-assigning onto an event that holds their
  challenge is skipped as an author, like anybody else.
- **Every non-admin writer shares `staffRowRefusal(user, comp)`** (grep
  `staffRowRefusal(` for the set), which answers `'spectator'` (staff on a
  non-compete event: no row, but still free to enter), `{authored:[…]}` (the
  author of an assigned challenge on a compete event: refused, whoever they
  are) or `null`. The self-enroll join answers a spectator **200
  `{ok:true, staffSpectator:true}`** with no row written, and an author
  **409 `staff_compete_author_competes`** naming the challenges; the deferred
  `pending_self_enroll_comp_id` consume at first sign-in clears the marker and
  writes no row for either; group sync (`lib/group-sync.js`) writes a
  staff-tagged member of a bound group a row only on a compete event and never
  as author — and skips them with a bare `continue`, **silently**, exactly as it
  skips a blocked or unapproved member; the invitation claim at sign-in (an
  existing account redeeming an emailed code, `lib/invitation-claim.js`) applies
  the same rule, likewise silently — and, DECIDED (19 Sep 2026), no privileged
  rule at all: an admin-role account claiming an invitation into a
  compete event is enrolling itself, which the peer rule below exempts at every
  door, so it is enrolled where a regular admin's direct assign of the same
  pair would skip it as `skippedPrivileged`; and the existing-user path of
  `POST /api/admin/invitations` applies it **and reports it**, in the assign
  door's order — a held row first (a member takes the ordinary `alreadyAssigned`
  path, and on both doors none of the three skips is asked of one), then
  spectator, then the peer-admin rule below, then author: `skippedStaff` counts
  spectator skips only, `skippedAuthors` (a number on this route) counts
  authors, and a row skipped for any of the three is **not** pushed onto
  `alreadyAssigned`, so the dialog does not report "nothing to do" beside a
  skip. The invitation route also asks `competitorGroupDenied` of every group
  the invitation would apply.
- **The participant import** (`_rehydrateMemberships`) reads the existing row
  before the staff rule too (a held row on a non-compete event is an
  idempotent no-op, not a `staff_not_competing` entry), and pushes
  `staff_not_competing` and `author_competes` onto `skipped_memberships` rather
  than sinking the file — beside `actor_competes` (the import's own competitor
  door, above).

**The peer-admin rule holds at both enrolment doors an admin drives.** On a
compete event a **regular admin may not enrol an admin or superadmin** as a
competitor — the v7.14.2 doctrine that a regular admin does not manage a
privileged account, and enrolling one is managing it. Such a target is skipped
and counted as `skippedPrivileged`, never written — on
`POST /api/admin/competitions/assign` and on the existing-user path of
`POST /api/admin/invitations` alike, keyed on the target's `admin` /
`superadmin` **role** (never `event_admin`). A **superadmin may**, and
**anybody may enrol themselves**, which is the ordinary way an organiser joins
the event they intend to compete in. An event admin is not a superadmin, so the
same skip binds them — and it is the **only** thing that does: the assign door
deliberately applies no `memberTargetsDenied` to its targets (enrolling a
walk-up who is in no event yet is the role's main job), so §9.6's
privileged-target refusal never runs here. **The same rule holds at the group
door, through every admin door onto it.** Only a superadmin may put an `admin` /
`superadmin` account into a group, because a group live-syncs into every event
it is bound to — compete events included, where the sync asks no tier question:
the five membership-writing group routes refuse a non-superadmin such a target
outright — three through `_privilegedGroupTargets` (`POST /api/admin/groups`
with a `userIds` seed, `POST …/groups/:id/members`,
`DELETE …/groups/:id/members/:userId`) and the two participant-row chip routes
(`POST|DELETE /api/admin/participants/:id/groups[/:groupId]`) through an inline
copy of the same role check — 403, exempting nobody; and the invitation's
existing-user path — the one admin door a regular admin could otherwise reach it
through, by inviting the address with a group ticked — withholds the group adds
from such a target and counts them as `skippedPrivilegedGroups`, never silently
(the invitation exempts the actor's own account). So a peer admin a bound group
enrols into a compete event was put into that group by a superadmin, whoever
bound the group — or was grouped as a participant and promoted afterwards (a
promotion adds the `staff` tag and removes no `group_members` row; the role
check runs at add time only) — or arrived through the **invitation claim at
sign-in**, the one door that applies no tier rule: an existing `admin` /
`superadmin`-role account redeeming an emailed code is written into every live
invitation addressed to its primary address, the only address a code signs in
with (subject only to `staffRowRefusal` —
spectator or author — never the peer-admin skip the two admin doors count as
`skippedPrivileged`) AND into its groups with only the clash guard asked
(`lib/invitation-claim.js`, `claimInvitationsForAccount`). That door is narrow — the
invited address must have been nobody's address, primary or secondary, when the
invitation was created, since the invitation route creates no row for an
existing account and refuses an address held as somebody's secondary, and the
account must hold an `admin` / `superadmin` role by claim time — and
it is DECIDED (19 Sep 2026): the claim is the account enrolling itself, which
the peer rule exempts at every door. The client withholds the affordance
with the rule: the participant row's **Invite to …** is not offered for such a
target on a compete event unless the actor is a superadmin or the target is
themselves, and the participants-side bulk **Assign to Events** picker disables
an event the actor competes in ("You compete here"), as the challenge-side
picker does.

**Scoring lifts the tag and the role together; benchmark is untouched; analytics
is unchanged.** `getStaffOrBenchmarkSet(userIds, {staffCompete})` excludes only
`benchmark` when the flag is set; `scoringParticipantIds` reads the event's own
switch; and `buildLeaderboardEntries` computes `_staff` as
`!staff_compete && (tag || event_admin)` — so on a compete event staff are on
both boards, count toward the all-solved denominator, and can mint a certificate
(`_mintEligibility` inherits the board). The activity CSV includes their rows on
such an event. **Analytics is deliberately unchanged** — it still excludes the
`staff` tag by default, and the guides say so. Attempt grants on a compete event
admit an enrolled admin or event admin as a target (they have the same cap and
the same need for a grant when it runs out), while a regular-admin actor is still
refused an admin or superadmin target, and a non-enrolled **participant** still
answers 409 (a non-enrolled admin or event admin is refused as a non-participant
first — the 403 "participant accounts only" runs before the enrolment check).

**The participant side reads the same facts.** Every row on `/api/me`,
`/api/my-competitions` and the login payload carries `own` and `competing`
(booleans) and `staff_compete` — **as the raw column, `0`/`1`**, like every
sibling flag on that payload (the self-enroll preview and the export coerce it to
a boolean; the participant rows do not); `competing` is `own && staff_compete`
with no staff or role term, and the client consults it only for a staff-tagged
user. `can_leave` is computed for staff too, on the same rule as for a
participant: their **own** self-enrolled row, while the event has not ended — and the
self-service Leave control is rendered on the waiting page only, for everybody,
so a staff member who joins a **live** compete event through the link has no
self-service exit from the participant side (an admin-tier competitor — an
event admin included, whether or not they organise the event, since the
carve-out skips the scope gate — removes themselves through the admin door
above; a staff-tagged non-admin in a live compete event has no exit but another
organiser). A
competing staff member takes the
**participant path** through `POST /api/select-timeslot` — the slot lock, the
history pin and the live-session confirmation all apply — while a spectator
keeps the exemptions. The sole-event landing at sign-in counts **own** rows for
everybody, staff included (operator decision 7: exactly one own event, of any
status, lands the session in it). On the client every confirmation a spectator
skips is keyed on `staffSpectatorIn(comp)` (`public/js/ui/format.js`),
which is `S.isUserStaff && !comp.competing` — so a competing staff member gets
every confirmation a participant gets, and an absent row still reads as
spectator, the safe direction. The join link's *Compete in this event?*
confirmation is **client-only** and tag-gated, so it is met by a staff-tagged
user scanning the QR and by nobody else. Signing in with an emailed code **from
the link** (the code is bound to the event, `login_code_comp_id`, which counts
only in the browser that asked for a code naming that event: typed anywhere else
the code signs in as one with no event, as anyone holding the link may ask for a
code for any address) never answers it
for them: on a staff-compete event the redemption enrols nobody who is staff — the
`staff` tag or any admin-class role (`lib/self-enroll.js` `_consumeCodeBoundEnroll`)
— and the SPA's join through the ordinary join door decides; anyone else is
enrolled through the same admission ladder as the deferred consume, which asks
`staffRowRefusal` and — through a late-entry window — the took-part rule of §9.9,
and nothing else. Claiming an invitation at sign-in still enrols an existing staff
account server-side before the SPA loads with no question asked, and an untagged
event admin never sees the confirm.

**What is deliberately not changed.** The analytics default exclusion of the
`staff` tag; CxOne provisioning and the assignment mail, which reach a competing
admin exactly as they reach a participant; and the bulk-seed performance tool.

### 9.9 A Booth Event's late-entry window — admission and removal per tier (v8.12.6)

A Booth Event can stay open for walk-ups for a while after it ends (the late-entry
window, v8.6.0). Until v8.12.6 only its join link honoured the window: every admin
door refused an ended event outright, and the invitation route silently DROPPED one
from the invitation it went on to send. Every door now asks ONE predicate,
`competitionAdmission` (`lib/competitions.js`) — `"open"` for upcoming or live,
`"late"` for an ended event inside its window, `null` otherwise, written as a
positive allow-list so a status invented later fails closed — and the join link's
own predicate delegates to it, so no two doors can disagree about one event.

| | Global admin, superadmin | Event admin |
|---|---|---|
| **Add** someone through the window — invite, assign, **At the desk**, bind a group (live sync adds its members) | Yes, on any event; the person joins as a late entrant (their row is written after the end) | Yes, on events **they organise** — the scope gates are asked exactly as on a live event, and an out-of-scope event is refused on scope first |
| **Remove** someone from the ended event while the window is open | Late entrants only | Late entrants only, on their own events |
| Change **Allow late entries** once the event has ended | No — superadmin included | No |
| **Close late entries now** (v8.12.8 — a server-resolved instant, to the millisecond; `POST /api/admin/competitions/:id/late-entry/close`) | Yes, on any event whose window is open | Yes, on events **they organise**; refused `event_admin_out_of_scope` elsewhere. And `competitor_cannot_edit` for anybody who competes in the event, every tier, asked first. Offered from the one predicate the route refuses with (`lateEntryCloseState`), published per row as `can_close_late_entries` |
| Set the late-entry **deadline** in the event's editor (a specific time, extending the window, or reopening one somebody closed) | **Superadmin only.** While the window is open the event's end time has always passed, and the competition PUT refuses every edit of such an event from anybody else (`403` "Only superadmin can edit ended events whose end time has passed"), so this and anything else in the event's form is a superadmin's act. Closing the window early does not need it (the row above) | No — the same refusal |
| The **Join Link** dialog's self-enrolment switch during the window | Superadmin only, for the same reason: it is an edit of a finished event. The item stays on the event's menu; while self-enrolment is on the link, QR and code keep working until the deadline (with it off the dialog says they admit late entrants only once it is turned on — and, to anyone but a superadmin, that only a superadmin can turn it on now); **Regenerate** stays available (its route does not refuse an ended event) | The dialog opens with the switch disabled and the reason beside it |

The competitor lock (§9.8) and every staff, peer-admin and author skip apply at
these doors exactly as they do on a live event. The Participants tab asks one
mirror of the admission predicate at each of its add-people doors
(`compAcceptsNewMembers`, reading the server's `late_entry_window_open` rather than
re-deriving the window; the group→Events dialog lists what the server returns) and
offers **Remove** on an ended event only where the server marked the row
`late_entrant`, so no screen offers what the route refuses; it badges a member as a
late entrant, and warns before deleting their account, from the separate
`late_entry_playing` (every late entrant still able to play, removable or not). Four rules sit underneath, each
tier-blind:

- **Nobody who took part before the end can come back as a late entrant**
  (`lateWindowAdmissionDenied`) — a submission or a hint at or before the effective
  end, or an absence row anchored at or before it (entered, then left or was
  removed). Asked only for a NEW row: a row somebody already holds is a membership.
  An ORIGINAL member's takes the idempotent path (no promotion to a direct row, no
  tombstone cleared), so the final board is untouched; a LATE entrant's takes the
  ordinary promotion (`direct_assigned=1`, tombstone cleared, `membership_promoted`
  with `late_entry: true`), exactly as it would while the event ran. The assign and invitation doors skip such a person and count them
  (`skippedTookPart`); group sync skips silently, as it skips a blocked member; the
  join link answers `409 late_entry_took_part` to the person themselves. Without it a
  finisher removed while the event ran could rescan the QR after the end and land
  back on the FINAL board at rank 1.
- **Only a late entrant who had not started playing before the end can be
  removed, and only while the window is open** (`lateWindowRemovalDenied`, the same
  predicate the participants list publishes as `late_entrant` on each event entry,
  so the Remove it offers cannot disagree with the refusal). Everyone else stays —
  anybody who joined before the effective end (`400 not_late_entrant`)
  — so its final results cannot change; the account-delete
  speed bump for such a late entrant carries `removable: false`, so neither delete
  dialog offers the removal as the gentler choice; with no window, or
  once it has closed, `400 event_ended` as before. A late entrant holding an
  unrevoked **placing** certificate is `409 late_entrant_has_certificate` until it is
  revoked (a superadmin act), or a second person could be issued the same placing.
  The self-removal carve-out (§9.8) is still asked first, so a competitor who is a
  late entrant may take themselves out during the window. Removable and
  re-admittable are the same set, so a removal is never a one-way door for anybody
  who played.
- **The switch locks once the event has ended, in both directions**
  (`lateEntrySwitchLock`, published as `late_entry_locked` on the admin list and
  every `_compWire` response so the form never offers a switch the save would
  refuse). Turning it off would fold every late entrant into the FINAL main board;
  turning it on would move nobody who played the live event, but would
  re-label every post-end joiner — and certificates already issued assert that order. The deadline reclassifies
  nobody, which is why CLOSING THE WINDOW is the remedy the refusal names: "use Close
  late entries now on the event's menu", the control in the table above, which any
  admin, superadmin or the event's organiser may use (v8.12.8). It is named only while
  the window is open; once the window has lapsed or been closed there is no door left
  to close and the refusal names no remedy at all. An echo of the stored value is not
  a change, and the dry run meets the refusal.
- **Removing and re-adding somebody keeps their original join time.** The absence
  row written when somebody who had ENTERED the event is removed now records
  `assigned_at` beside the solve-clock anchor, and every re-add restores it (the
  invitation's re-add, and the old LinkedIn invitation claim, were the two that did not
  even restore the anchor), so a remove-and-re-add after the end cannot
  turn an ordinary member into a late entrant. Somebody assigned early who never
  entered leaves no absence row, so re-added after the end they classify
  late exactly as a brand-new joiner would — they never played, and that is a
  recorded decision rather than a gap.

## 10. Deliberate dispositions — do not re-flag

- **An event admin is not offered hard delete.** The operator's brief lists
  "publish/unpublish/delete"; a normal admin cannot hard-delete a challenge, and
  the same brief says an event admin's powers equal a normal admin's. They
  unpublish and hide. Granting hard delete would make them *more* powerful than a
  regular admin in that one respect.
- **IP-ban alerts are withheld.** They concern the platform's abuse posture. The
  remedy an organiser actually needs — Trusted network IPs — is a field on their
  own event, which they can already edit.
- **A grant may be made over an ENDED event.** Post-event work (exports,
  certificates, rankings) is the common case, and the write paths are gated by
  event status anyway.
- **`_leaderboardCache` is deliberately NOT keyed per actor.** Its content is
  actor-independent; only *which* event may be requested is gated, above
  the cache. Re-keying it would multiply a 5 000-entry LRU by the admin count for
  no benefit. `_analyticsCache` and the admin-participants page cache **are**
  keyed per actor, because their bodies genuinely differ by tier.

<!-- DOC-REGISTRY
# v8.7.0 — what THIS document claims to enumerate. Checked by
# `functional-core-b.api.spec.js > Docs hygiene`. Nothing is inferred from the
# prose: only the claims declared below are verified. Add a line when you add a
# claimed enumeration; an exemption needs a reason after `--`.
DOC-MODULE: lib/event-admin.js
DOC-SYMBOL: requireGlobalAdmin
DOC-SYMBOL: eventAdminGuard
DOC-SYMBOL: scopedCompetitionIds
DOC-SYMBOL: scopeFilterSql
DOC-SYMBOL: competitionDenied
DOC-SYMBOL: taskViewDenied
DOC-SYMBOL: taskEditDenied
DOC-SYMBOL: taskScoringEditDenied
DOC-SYMBOL: taskUnassignDenied
DOC-SYMBOL: participantDenied
DOC-SYMBOL: memberTargetsDenied
DOC-SYMBOL: groupViewDenied
DOC-SYMBOL: groupWriteDenied
DOC-SYMBOL: groupDeleteDenied
DOC-SYMBOL: getStaffOrBenchmarkSet
DOC-SYMBOL: offBoardRolesJson
DOC-SYMBOL: buildLeaderboardEntries
DOC-SYMBOL: isStaff
DOC-SYMBOL: listParticipantCompetitions
DOC-SYMBOL: created_by_id
DOC-SYMBOL: assigned_by_id
DOC-SYMBOL: competition_admins
# v8.8.6 / v8.12.1 — impersonation: the participant surface's scope predicate,
# the event-admin view's "which human" resolver, and the entry's competitor door.
DOC-SYMBOL: impersonatorScopedCompetitionIds
DOC-SYMBOL: impersonationScopeDenied
DOC-SYMBOL: actingAdminId
DOC-SYMBOL: actingAdminCompetesInTargetEvents
# v8.10.0 — the sealed answer (§9.7). Its own module, because the rule binds every
# tier and the event-admin predicates deliberately exempt two of them.
DOC-MODULE: lib/answer-seal.js
DOC-SYMBOL: answer_sealed
DOC-SYMBOL: answerSealed
DOC-SYMBOL: sealedAnswerReadable
DOC-SYMBOL: redactSealedAnswer
DOC-SYMBOL: redactSealedSnapshot
DOC-SYMBOL: sealedEditDenied
DOC-SYMBOL: sealAtCreateDenied
DOC-SYMBOL: sealChangeDenied
DOC-SYMBOL: sealed_skipped
# v8.12.0 — staff can compete (§9.8). A per-event switch plus a competitor lock
# keyed on a ROW, not a role; its own module for the §9.7 reason, and the one
# row-writer predicate every non-admin enrolment path shares (grep
# `staffRowRefusal(` for the set) lives in lib/self-enroll.js beside the join
# engine that calls it. The lock is per door with no default-deny guard, so the
# door list is held behaviourally (tests/staff-compete-lock.api.spec.js) and
# only the symbols the prose leans on are declared here.
DOC-MODULE: lib/staff-compete.js
DOC-SYMBOL: staff_compete
DOC-SYMBOL: staffCompeteOn
DOC-SYMBOL: competitorEditDenied
DOC-SYMBOL: competitorTaskEditDenied
DOC-SYMBOL: competitorGroupDenied
DOC-SYMBOL: competitorRivalDenied
DOC-SYMBOL: rivalsOf
DOC-SYMBOL: rival_in
DOC-SYMBOL: unsealedAssignmentDenied
DOC-SYMBOL: authorCompetesDenied
DOC-SYMBOL: staffRowRefusal
DOC-SYMBOL: competitorIn
DOC-SYMBOL: competitorEventsForTask
DOC-SYMBOL: enrolledAuthors
DOC-SYMBOL: capRefused
DOC-SYMBOL: staff_compete_enrolled_authors
DOC-SYMBOL: unsealDenied
DOC-SYMBOL: sealedTaskCompeteEvents
DOC-SYMBOL: withheld_competition_count
DOC-SYMBOL: withheld_compete
DOC-SYMBOL: _competingSet
DOC-SYMBOL: _privilegedGroupTargets
DOC-SYMBOL: skippedPrivilegedGroups
DOC-SYMBOL: switchLock
DOC-SYMBOL: refuseCompetitor
DOC-SYMBOL: staffSpectatorIn
DOC-SYMBOL: scoringParticipantIds
DOC-SYMBOL: _mintEligibility
DOC-SYMBOL: staff_compete_locked
DOC-SYMBOL: competing_in
DOC-SYMBOL: hint_withheld
DOC-SYMBOL: skippedPrivileged
DOC-SYMBOL: skippedAuthors
DOC-SYMBOL: competitor_skipped
DOC-SYMBOL: rival_skipped
DOC-SYMBOL: actor_competes
DOC-SYMBOL: group_actor_competes_dropped
DOC-SYMBOL: skipped_absences
# v8.12.6 — the commit-time admin re-check (§2), the sealed reveal that gates its
# own disclosure (§9.7), and the late-entry window's per-tier doors (§9.9).
DOC-SYMBOL: adminAuthzDenied
DOC-SYMBOL: participantSessionDenied
DOC-SYMBOL: competitionAdmission
DOC-SYMBOL: lateWindowAdmissionDenied
DOC-SYMBOL: lateWindowRemovalDenied
DOC-SYMBOL: lateEntrySwitchLock
DOC-SYMBOL: late_entry_locked
DOC-SYMBOL: skippedTookPart
DOC-SYMBOL: late_entrant_has_certificate
DOC-SYMBOL: SEALED_HINT_WITHHELD_REASONS
DOC-SYMBOL: compAcceptsNewMembers
DOC-SYMBOL: late_entry_window_open
# v8.12.8 — "Close late entries now" (§9.9): the one predicate, its wire flag and
# its history entry.
DOC-SYMBOL: lateEntryCloseState
DOC-SYMBOL: can_close_late_entries
DOC-SYMBOL: late_entry_closed
# v9.0.0 — the default sign-in method per role class (§1), the sign-in and
# credential doors every impersonation is refused (§9.5d), the secondary address that names no account
# (§1b, §5) and the desk code's rival door (§5, §9.8).
DOC-MODULE: lib/login-method.js
DOC-SYMBOL: roleDefaultLoginMethod
DOC-SYMBOL: login_method
DOC-SYMBOL: breakglass_username
DOC-SYMBOL: email_is_secondary
DOC-SYMBOL: desk_code_live
DOC-SET: _IMPERSONATION_BLOCKED @ lib/impersonation.js = /api/auth/code/request,/api/auth/code/redeem,/api/auth/code/drop-event,/api/auth/password,/api/me/sign-in-method
DOC-SET: _IMPERSONATION_JOIN_PATHS @ lib/impersonation.js = /api/competitions/join
# EVENT_ADMIN_ROUTES / EVENT_ADMIN_FORBIDDEN are Maps, not Set literals, so the
# DOC-SET arm cannot read them. A scanner in functional-core-b ("v8.7.0: every
# admin route is classified...") compares those MAPS with the real route
# registrations in both directions; nothing reads the §5 table of this document,
# which is written by hand (see the note at the top).
-->
