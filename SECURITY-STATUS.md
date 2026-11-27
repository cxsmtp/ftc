# Security status

**A record of the 8.17.0 triage, as of 1 November 2026. It has not been redone
for any later release.** CI runs a Checkmarx One scan on every change (the
`checkmarx-scan` job), but the results of those later scans are not triaged here;
nothing on this page describes a release after 8.17.0.

What the Checkmarx One scans of 8.17.0 found, what was fixed in code, and why
every remaining result was judged not exploitable. The per-result decisions (one
row and one written reason per finding) were kept in working triage ledgers that
are **not part of this repository**; this page, which summarises them by engine
and by class, is the only record of them here. How the platform is built to be
secure is in the README, section *Secure and fast*; user-facing changes are in
[docs/release-notes.md](docs/release-notes.md).

## Summary

- **Every SAST, SCA, IaC and container result of that scan had a decision.** Each
  one was either fixed in code or reviewed and recorded as not exploitable, with
  the guard that makes it so. Two engines are not covered by this page: the
  API-security results were matched by class, not by result id, and no count of
  them is given here (see below); and the scan's secret detection (`scs`, which
  CI also runs) is not reported here at all.
- **In the final scan of 8.17.0:** 973 results; 971 reviewed as not exploitable,
  2 already fixed by a later commit than the one scanned (they leave with the next
  scan), 0 without a decision.
- **Not applied in Checkmarx One:** the not-exploitable decisions were recorded
  in the ledgers but not set as result states inside the Checkmarx One project
  (the connection was down during this pass). The exceptions the repository
  records are both the CI test image's: its operating-system packages
  ([ci/README.md](ci/README.md)) and its missing `USER` instruction
  ([ci/Dockerfile.cross-browser](ci/Dockerfile.cross-browser)), which those
  files say were set as not exploitable there.
- **Tests:** the full suite, 4753 tests, passed with 0 failures in the pinned CI
  image for 8.17.0. Every change since runs the full suite in CI; that figure is
  not repeated here.

## Fixed in code in 8.17.0

| Area | What was wrong | What it does now |
|---|---|---|
| CSV export | A phone number holding a spreadsheet formula went into the participants CSV unescaped (the Phone column was exempt from formula neutralisation) | The Phone column stays raw only when it looks like a plain phone number; anything else is neutralised like every other cell |
| Invitations | An invitation's automatic approval did not ask whether the inviting organiser was competing against the invitee | Auto-approval asks the same rival check as the approve button |
| Add user dialog | A custom role's name was written into the "existing account" confirmation as HTML (stored XSS) | The role name is escaped and shown as text |
| Guide renderer | Raw HTML inside a help guide, and link text, reached the page unescaped | Raw HTML is escaped; link text comes from the renderer's escaped tokens |
| Repository | Performance tooling carried a dead shared password | The shared performance password is gone, and the perf scripts generate their secrets at run time. Tests still set literal passwords for the accounts they create; each works only on the throwaway server its own test run starts |
| Dependencies (SCA) | Vulnerable versions of qs, debug, braces, picomatch and minimatch | Pinned to fixed versions by overrides (braces and picomatch 2 removed from the tree altogether) |
| Logs | An unsubscribed address reached the request log in a path; a duplicate-address warning named the addresses | The request log no longer carries the address (the path of `DELETE /api/admin/unsubscribed/:email` is logged as `[REDACTED]`); the warning names none. The audit record of a re-subscribe, and of an unsubscribe by an address no account holds, still names the address, and like every audit record it is copied into the application log |
| Data files | A new data directory and database file took the process's default permissions | A new database file is created owner-only (0600), as is a data folder the server creates itself (0700); an existing file's mode is left alone. Not covered: the shipped image creates the data folder itself, with default permissions; the log folder and files, uploaded files and attachment files take the process's default permissions (the attachment and upload folders are created 0750) |
| SQL | Lists of ids were spliced into queries as one placeholder per id | Every list is bound as ONE parameter (`JSON.stringify(list)`) and expanded by SQLite (`json_each`), so a statement's text never varies with the list's length. A source scanner (`tests/functional-core-b.api.spec.js`, Docs hygiene) fails any list built one `?` per id; two lists fixed at module load keep their placeholders, listed there with the reason (their text is constant) |
| API description | The OpenAPI document lacked shared refusal responses, integer bounds and explicit `additionalProperties`, and carried secret-shaped examples | All four added or removed for every operation |
| CI and container definitions (IaC) | Unpinned package versions; no health check on the CI image | Versions pinned; health check added |

## Final scan, by engine and severity

| Engine | Critical | High | Medium | Low | Info | Decision |
|---|---|---|---|---|---|---|
| SAST (code) | 233 | 33 | 19 | 10 | — | not exploitable; 2 more critical fixed after the scanned commit |
| Containers | 33 | 246 | 304 | 71 | 21 | not exploitable |
| IaC (KICS) | — | 1 | — | — | — | not exploitable |
| SCA (dependencies) | — | — | — | — | — | none open: every earlier result fixed (see above) |

## Why the remaining results are not exploitable

**SAST**

| Query | Count | Reason |
|---|---|---|
| Stored XSS, Reflected XSS | 242 | The value leaves through Express `res.json()` (JSON-encoded, `application/json`), or as a CSV or ZIP buffer with its own content type and `Content-Disposition: attachment`; the few server-rendered pages (the public certificate and share pages, the credential check, and the unsubscribe and email pages) pass every value through `escapeHtml`. In the browser, every value placed in HTML is escaped with `esc()` first (or is one of the reviewed idioms a source scanner, `tests/html-sink-escape.spec.js`, checks at every sink), and the CSP runs scripts only from the platform's own files (`script-src 'self'`, no inline script or event-handler attributes); every response carries `nosniff`. Trusted Types is not part of this reason: its HTML policies pass HTML through unchanged |
| SQL injection, second-order SQL injection | 19 | Values are always bound parameters. Where statement text is assembled, it is assembled only from constant fragments chosen in code (some through an allow-list) and from `?` placeholders, one per id where an id list is spliced; no value is ever written into it |
| Client-side XSS (innerHTML) | 3 | The application writes HTML through `setSafeHtml`, which sanitises nothing: what protects the page is that every value placed in that HTML is escaped with `esc()` before the write, or is one of the reviewed idioms, which `tests/html-sink-escape.spec.js` checks at every sink; one result is in an offline report tool whose inputs are escaped at the sink |
| Missing authorization | 1 | Fixed: the invitation auto-approval asks the rival check (above) |
| Path traversal, loop bounds | 4 | An offline operator tool, run by hand and never by the server; its inputs are capped and clamped |
| Cleartext storage | 7 | The Checkmarx One API key must be presented by the server, so it is stored usable in the database file, which is owner-only (0600); the other values are single-use expiring email codes, or performance tooling that never ships |
| Privacy, data exposure, error messages | 13 | Values returned only to an authenticated admin within their event scope and audited; application-authored refusal sentences, not driver text; a superadmin-only mail diagnostic whose purpose is to show the relay's refusal; synthetic performance fixtures |
| Cookie and storage flags, secret-shaped names | 4 | A layout-hint cookie that carries no identity; a join-link token that is printed on the event's own QR poster and signs nobody in; a boolean named "passwordless"; a public nickname |
| Protection mechanism failure | 2 | The help page renders only same-origin guides through an escaping renderer; the default Trusted Types policy passes every HTML write through unchanged (it exists because the self-hosted charting library writes HTML itself; it refuses script text and script URLs), so it guards no HTML write: the page relies on every value being escaped before it reaches an HTML sink (checked by `tests/html-sink-escape.spec.js`) and on the CSP's `script-src 'self'` |
| Hard-coded credentials | 2 | Fixed after the scanned commit (the shared performance password removed; test fixtures keep throwaway passwords) |

**Containers**

| Image | Count | Reason |
|---|---|---|
| The CI test image (Playwright base) | 657 | Used only as the container of the test jobs; never built into or deployed with the application |
| The application base image (`node:26-alpine`) | 18 | Each package is one of npm's own bundled dependencies; the shipped image deletes npm, npx, corepack and Yarn, so none of them is present at runtime |

**IaC**

| Query | Count | Reason |
|---|---|---|
| Missing `USER` instruction | 1 | The CI test image, whose job containers must run as root; the application image runs as the unprivileged `node` user |

**API security (the OpenAPI document)**

The final scan's export carried no API-security rows, so these are matched by
class from the API-security listing and a local KICS run on the fixed document,
not by result id.

| Rule | Reason |
|---|---|
| Unknown property, object without required property, required property undefined | `additionalProperties` is a valid OpenAPI 3.0.3 field; the flagged "objects" are ordinary schema properties or tag lists; every required property is defined |
| Response code missing | The status is never produced by that operation (no entity in the path, a public operation that never answers 401, or no CSRF check to answer 403) |
| Empty array, empty security on an operation | `security: []` is how OpenAPI 3.0 marks the deliberately public operations (sign-in, sign-up, CSRF token, health probes, public certificate pages) |
| No success code on verification | One-click email verification answers every outcome with a redirect to a result page by design, so no 2xx exists |
| Enum, additional properties too permissive | Nullable fields the server accepts as null; a boolean-or-integer alternative where the rule does not apply |

## How it stays this way

Security rules that can be enumerated — route permissions, CSRF and body-shape
checks, log scrubbing, rate-limit placement, the CSP, dependency pins — are held
by source scanners in the test suite that fail the build when a new route or file
breaks them, and each lock has been seen failing with its fix removed. The rules
themselves are documented in `CLAUDE.md`, `AUTH_PATHS.md` and
`ROLES_AND_PERMISSIONS.md`.

## Later changes to rows above (addendum, 22 November 2026)

This addendum does not redo the triage; it marks two rows that no longer
describe the whole of today's code. The **Invitations** row ("Auto-approval asks
the same rival check as the approve button") and the **Missing authorization**
row ("the invitation auto-approval asks the rival check") are incomplete for
today's code: since 9.1.1 an invitation's automatic approval of an existing
account waiting for approval also asks for the approval permission and the
privileged-account rule, and since 9.2.7 an invitation from an organiser scoped
to their events also asks the **Approve** button's event-scope question (the
account must end up a participant in one of their events, else it stays
waiting). Still open, a question for the operator: an invitation to a new
address and **At the desk** create approved accounts for a role that may invite
but not approve.

## Later changes to rows above (addendum, 23 November 2026)

The question the addendum above leaves open was answered by the operator on
23 November 2026, and the new-address invitation and the desk sign-up follow the
ruling. Every built-in role that may invite may also approve, so only a custom
role can invite without that permission; an invitation whose inviter has since lost
it, or whose account is gone, blocked or denied, is held the same way. While
**Require admin approval for new accounts** is on, a role that may invite but not
approve accounts creates no approved account:

- someone new who signs up through its invitation is created verified but waiting
  for an administrator's approval. They are not signed in and join no event or
  group; the invitation stays live, and their first emailed-code sign-in after an
  administrator approves them joins its events and groups. The inviter's
  permission is read when the invitation is used, and an inviter whose account is
  gone, blocked, denied or unapproved counts as unable to approve;
- **At the desk** is refused with the reason, asked before the address is looked
  at and again when the account would be written;
- the organisers of the events such an invitation names see the waiting account
  in People, for their own events only, so they can ask an administrator to
  approve it; they cannot approve it themselves.

With the switch off nothing changes, and join links, QR codes and event codes
still approve whatever the setting, by the operator's earlier ruling.
