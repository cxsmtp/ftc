# Hack Arena

A self-contained hackathon and event platform for running timed challenges. Participants register, solve challenges, and compete on a live leaderboard. Administrators manage events, challenges, and participants through a built-in admin panel.

## Secure and fast

The figures below were measured on version 8.17.0, on 29 October and 1 November
2026, and its scan results were triaged on 1 November 2026; neither has been
redone for a later release. Every
figure below is either **measured** or marked as a **recommendation**; nothing is
extrapolated without saying so. Full method and raw tables:
[perf/RESULTS.md](perf/RESULTS.md); what changed in this release:
[docs/release-notes.md](docs/release-notes.md). Scan results are kept outside this
repository.

### Fast: measured

| Scenario (one server process) | Result |
|---|---|
| 1000 people arrive within **60 s** and sign in with emailed codes | **1000/1000** signed in, p95 arrival → signed in **0.29 s** (mail delivery included), 0 server errors, no restart |
| 1000 people arrive within **10 s** (the spike) | **1000/1000** signed in, p95 **1.51 s**, 0 server errors, no request slower than 106 ms |
| 1000 signed-in sessions polling (steady state) | about 84–88 requests/s at **≈ 10 % of one core** (≈ 1.2 ms CPU per request), **< 200 MB** resident, poll p95 2.4 ms |
| 1000 people behind **one** venue address that is *not* on the event's trusted networks | 412 signed in within the 5-minute window, the rest still trying (each attempt waits for a token, about 45 s in the app, which shows "Busy — retrying…" meanwhile, then asks them to try again; the load test this was measured with waited about a minute per attempt); the address was **never blocked**. The remedy is to list the venue on the event's trusted networks |
| 3000 people arrive within **60 s** and sign in with emailed codes (measured 1 November 2026) | **3000/3000** signed in, p95 arrival → signed in **0.35–0.42 s** (two runs, mail delivery included), 0 server errors, no restart; all 3000 still signed in at the end |
| 3000 signed-in sessions polling (steady state) | about 256 requests/s at **≈ 22 % of one core** (≈ 0.85 ms CPU per request), **≈ 393 MB** resident, poll p95 2 ms |
| 3000 people arrive within **10 s** (the spike) | **3000/3000** signed in, 0 server errors, but **p95 70 s** with the default mail pool and **28 s** with `SMTP_POOL_MAX_CONNECTIONS=64`: the 10 s target is **not met** at this size |
| 3000 certificates issued and emailed after an event ends | issuing starts five minutes after the end; all 3000 then in **199 s** (≈ 66 ms each: render + SMTP), in the pinned CI image |

**3000 simultaneous sign-ins: met for 3000 people arriving within a minute; not
within 10 seconds.** One server process signed in all 3000 arriving over 60 s,
each in under half a second at p95, and then held 3000 live sessions with room to
spare. When all 3000 press "Send code" in the same 10 seconds, the one Node.js
thread needs about 22–30 s to do that work, so people wait up to about half a
minute (a mail relay that accepts 64 connections) or a minute (the default 16).
Details: perf/RESULTS.md, "3000-user sign-in storm — FINAL (2026-11-01)", measured before the entry screen began asking which sign-in method an address uses.

**These runs signed in people who already had accounts and were already in the
event.** A walk-up rush of NEW sign-ups (a booth's join QR) was not measured. Its
per-person work is now of the same kind (every check of whether an address is
taken is an index search, and a newcomer's join no longer rebuilds the
leaderboard), but there is no measured figure for it; behind one venue address,
list the venue on the event's trusted networks, as the per-address limits on new
sign-ups otherwise apply.

### Server requirements

- **Measured on:** the app container capped at **4 vCPU / 4 GB** on an otherwise
  idle 22 vCPU / 49 GB VM, with the load generator listed as the event's trusted
  network.
- **Recommended for a 1000-person event: 2 vCPU / 2 GB RAM.** This is an inference
  from the runs above (≈ 10 % of one core and < 200 MB at steady state; the app is
  one Node.js thread), not a run at that size. No smaller minimum has been measured.
- **For a 3000-person event:** the measured 4 vCPU / 4 GB cap used about a fifth of one
  core and ≈ 400 MB with 3000 sessions live; the app's one thread is the limit only in a
  sign-in rush (see above). For a rush, use a relay that accepts more connections and
  raise `SMTP_POOL_MAX_CONNECTIONS` (up to 64).
- **Required:** Node.js 20 or newer (production image `node:26-alpine`), an SMTP
  relay sized for about 1000 messages in 10 s (the mail pool opens at most 16
  connections by default), a persistent `DATA_DIR` volume and a separate `UPLOADS_DIR`.
- **One process per data volume, always.** Caches, rate limits and work queues
  live in process memory: never run replicas, cluster mode or a round-robin load
  balancer (see [Run as a single process](#run-as-a-single-process--do-not-horizontally-scale)).

### Secure: how it is built

- **A password or an emailed code, per account.** Admins and superadmins (and
  any custom role not scoped to events) sign in with a password by default;
  everyone else with a single-use code mailed to the account's primary address:
  8 characters (about 40 bits), valid 10 minutes, stored only as a sha256, at most
  3 mails per account per window. Anyone can choose either under **Profile → How
  you sign in**, and a password account can always ask for a code instead, so a
  forgotten password is never a dead end. Passwords are bcrypt-hashed. Ten wrong
  codes or passwords inside 5 minutes lock the account for an hour. A secondary
  address never signs anyone in. The entry screen tells whether an address
  signs in with a password (by default, an admin's), an accepted trade-off
  (operator ruling, 11 Nov 2026); it answers every other address the same way,
  so it does not reveal whether that address has an account.
- **One break-glass account.** The built-in superadmin, for when mail is down,
  is the one account with no emailed-code door: its password is regenerated at
  every start, written to the data volume and rotated after 10 failed sign-ins in
  15 minutes, and it signs in on the ordinary sign-in card with a username only
  that account can change. The card answers every name that is not an email
  address the same way, so it never confirms that username.
- **Browser hardening.** A strict Content-Security-Policy that names no
  third-party origin (fonts and libraries are self-hosted) and runs scripts only
  from the platform's own files, **Trusted Types enforced** so a script can be
  loaded at run time only from the two self-hosted libraries' addresses, every
  value escaped before it reaches an HTML sink (a source scanner checks every
  sink), CSRF tokens on every write, HSTS, frame denial and one session per
  person.
- **Scanner-reputation blocking.** An address that collects 100 refused requests
  within 10 minutes is blocked for 15 minutes, and superadmins are emailed unless
  the traffic is plainly an automated probe;
  signed-in admins are exempt, so an organiser on the venue network can always
  reach the switch that lifts it.
- **Least privilege.** Four built-in roles plus custom roles from a permission
  list; event-scoped organisers see only their own events' rows; nobody can grant
  more than their own role holds; every state change is recorded with its source.
- **A lean container.** The shipped image has no npm, compiler or build tools,
  its code is read-only to the user it runs as, and a new database file and the
  server's secret files are readable by the server only. The data folder the image
  creates, the logs and uploaded files take default permissions, and the access
  log names the signed-in person (address and name) on every request, so keep
  `DATA_DIR` private.
- **Checkmarx One, as triaged for 8.17.0** (1 November 2026, not redone since;
  CI scans every change). Every SAST, SCA, IaC and container result of that scan
  was either **fixed in code** or **reviewed and recorded as not exploitable**,
  each with the guard that makes it so; the API-security results were matched by
  class, and secret detection is not reported. Fixed in 8.17.0: CSV formula
  injection through the Phone column, an invitation that could approve a rival
  competitor's account, stored XSS through a role name in the Add user dialog,
  a dead shared performance password in the repository, vulnerable dependency versions (qs, debug,
  braces, picomatch, minimatch), an unsubscribed address reaching the request
  log, a new database file (and a data folder the server creates) with default permissions, SQL
  id lists (each now bound as one parameter; a test fails any list built one
  placeholder per id), and a hardened API
  description. The per-engine table, the reasons and the per-result ledgers are kept outside
  this repository.
- **Held by tests, not by memory.** The full suite runs on every change in the
  pinned CI image (4753 tests passed with 0 failures for 8.17.0). Security rules that can be
  enumerated (route permissions, CSRF and body checks, log scrubbing, rate-limit
  placement, the CSP) are held by source scanners that fail the build when a new
  route or file breaks them, and each lock has been seen failing with its fix
  removed.

---

## Key Features

- **Multi-competition support** — run multiple events simultaneously, each with its own challenges, participants, and leaderboard
- **Multi-session (timeslot) events** — schedule the same event at different times for participants in different timezones; answers are revealed only after all sessions end
- **Challenge system** — five answer types: free **text** (case-insensitive, optionally several accepted answers), **JSON** (deep equality), uploaded **file**, **multiple choice** (options shuffled per participant, graded all-or-nothing on the selected set), and **any answer** (every non-empty response is accepted exactly as typed — no hint, no wrong-answer penalty; given two or more options it is a pick-one question instead, its options shown in the author's order, never shuffled, where any one of them is accepted and anything else is refused — and, with an event open, the participants CSV carries one **Response:** column per such challenge holding each participant's response); rich descriptions with images, tables and syntax-highlighted code; optional author attribution with LinkedIn profile links; downloadable attachments
- **Topics** — the Question bank is organised by topic (one per question, many questions per topic); participants see a question's topic as its category. Tags are no longer shown or edited
- **Live leaderboard** — real-time scoring with automatic ranking by points and finish time; sortable columns and an all-solved marker
- **Team rankings** — tick **Enable group (team) leaderboard** on the event (it is off by default) and bind two or more participant groups; an additional board then ranks team averages alongside solo entrants, frozen at the moment the event ends so a published result can't be rewritten by a later membership edit. Not available on a Program, which is unranked
- **Staff can compete, per event** — organisers and helpers are kept off every board by default; tick **Staff can compete** on an event and the staff members *enrolled* in it compete like anybody else — on the board, in the all-solved rule, eligible for a certificate — and lose the ability to edit that event or any challenge in it for as long as they are enrolled, whatever their admin tier. Such an event may hold only **sealed** challenges, and never one written by somebody competing in it, so a colleague competing against the room cannot read the answer key off the admin screen
- **Achievement badges + certificates** — three kinds, decided by the event type: **placement** (top three, with points above zero) and **participation** (anyone else who attempted) on a Booth Event or Competition, both once the event has fully ended; and a **completion certificate** on a Program, issued as soon as the participant has solved every assigned challenge, with no wait for the deadline. Each carries a public OpenGraph page for sharing to LinkedIn, a downloadable PNG, an A4-landscape certificate PDF, and a 12-character certificate ID printed at the foot of the certificate PDF beside a QR code and the address to check it at, which an employer verifies at `/credential` against the holder's surname (the QR opens that page with the ID filled in; the oldest certificates, minted before the code existed, carry neither). Gold, silver and bronze certificates strike a medal in their metal; participation and completion certificates carry an award seal. Every word, colour and decorative element of the certificate is configurable — a platform-wide design (superadmin) with an optional per-event override (any admin with scope), through `/api/admin/certificate-config` — while the facts it states stay frozen at minting. A placement or participation page is live from minting; a Program certificate's page stays unresolvable until its holder presses Share
- **Certificates emailed at the end of an event** — when an event fully ends (End Now, its scheduled end, the last session ending, or the all-solved auto-end) every eligible participant is issued their certificate, if they have not collected it, and sent ONE thank-you email written for their tier (gold, silver, bronze, participation, completion) with the certificate PDF attached, a link to it, its verification code and a **Copy my LinkedIn post** button — a one-time, seven-day link to a page with the post ready to copy (**Copy post & open LinkedIn**), no sign-in needed; a Program participant gets theirs when they complete. Driven by a durable queue (`lib/certificate-dispatch.js`) that a restart resumes, about five minutes after the end so an End Now undone at once mails nobody; a ledger keyed on the certificate means no re-run, revive or second end path mails one twice. Late entrants wait for late entry to close; opted-out addresses get the certificate but no mail (the email carries List-Unsubscribe); a failed delivery is retried twice. On by default, switchable and rewordable per event or platform-wide in the certificate design's `email` section. Organisers list an event's certificates with their email status, download any of them and re-send one from the event workspace's **Certificates** section, and download the issued top three as one ZIP (**Top 3** on the Events row, **Download top 3 certificates** on the Overview). No certificate without at least one attempt, and no Gold, Silver or Bronze one without points above zero. The design is edited by administrators and superadmins; event admins preview and download
- **Hints system** — optional hints that deduct 30% of the challenge's point value when revealed
- **Challenge locking** — superadmins can lock challenges to prevent further edits or version restores
- **Feedback** — participants rate challenges (1-5 stars); admins see per-user feedback; superadmins can delete individual or all feedback
- **Challenge analytics** — admin pane (powered by Apache ECharts) aggregates per-event signals (`solved` / `incorrect` / `hint_revealed` / `navigated_away`) per scope (global / event / session) with time-window, difficulty, tag, and staff/benchmark filters. Includes a per-challenge breakdown table with stacked-bar mini-charts.
- **Participant management** — registration with email verification, approval workflows, invitations, role-based access (participant, admin, superadmin)
- **Self-enrollment links** — each event has a secret, persistent join link (with QR code) **and a short six-character event code** for printing on signage; a visitor can scan the QR, follow the link, or type the code on the sign-in card (**Have an event code?**) or the event picker to reach the same event, sign in or register, and be auto-enrolled without going through the approval queue for that event. The enable toggle defaults to the event type: a **Booth Event** ships with it ON, while a **Competition** and a **Program** ship with it OFF. Every walk-up confirms their email with a code and then joins at once (the old "Allow instant join" switch is retired and refused by name). The link and its code are rotatable on demand (one action replaces both)
- **Participant groups** — many-to-many groups for bulk operations; bind a group to an event for **live-synced** membership (members join/leave the event as the group changes); filterable in the Participants table, Logs, and Analytics
- **Sign-in with a password or an emailed code** — the entry screen is one email box and **Continue**. An account that signs in with a password (by default every admin and superadmin, and any custom role not scoped to events) gets the password box on the same card, with **Email me a code instead** under it; every other address gets a short single-use code mailed to it (participants and event admins by default). Each person chooses under **Profile → How you sign in**; an admin who has not set a password yet signs in with a code and is then asked to set one, or to keep using codes. Only the account's primary address signs in, never its secondary. An address with no account gets an address proof instead of a sign-in code, and redeeming it opens a short, pre-verified sign-up form; the account is created verified and (unless a superadmin turns on **Require admin approval for new accounts**, which then holds every new account that did not come through a join link, QR code or event code, or through an invitation from a role that may approve accounts) approved, so a walk-up needs nobody. The break-glass built-in superadmin signs in on the same card by typing its username (a setting only that account can change) and the password regenerated at every start, for when mail is down
- **Every event decides its own sign-up form** — five fields (salutation, phone, city, LinkedIn URL, job function), each set with one **Required · Optional · Off** switch beside a live preview of the card. It defaults to the short form every account gets: city and job function optional, the rest off. Making a field mandatory later **also asks for it from people who already registered through that event**, in the non-dismissible completion dialog, immediately and even once the event has ended — the requirement is re-read from the event each time. An account an organiser creates **At the desk** with the event open follows the same form. Relaxing a field never demands anything, and deleting the event drops the requirement. Every event type can be configured (a Booth Event, a Competition and a Program alike)
- **Late entries on a Booth Event** — a stand keeps its join link working for a while after it ends, so the walk-up who scans the QR at 16:55 for a 17:00 close is not left with an account and nothing to do. **On by default** for a Booth Event and available for no other kind; the window closes **48 hours after the event finishes**, and that deadline **follows the end time automatically** unless an organiser pins one. Anyone who joins during the window, after the event has ended, plays on until the deadline and is ranked in a separate **Late entrants** section of the leaderboard by the same rules as the main one — which stays final at the official end, because everybody else's event ends on time. Anyone who joined while the event was live is an ordinary participant, on the main board and podium. Their certificates say **"late entrant"** on the image, the PDF, the public page and the verification page, and the rankings CSV carries a **Late Entrant** column so the two sections can be told apart in one sheet. While the window is open the event is its own status in the admin lists — **Late entry open**, in its own colour, with its own filter chip shown by default beside live and upcoming, and the same badge on every challenge and participant assigned to it — so a stand still taking walk-ups never reads as finished. **Organisers can add people during the window too**: every admin door that adds somebody — **Invite**, **Assign**, **At the desk** and a group bound to the event — admits them as late entrants until the deadline, and says so before you confirm, for an event admin on their own events exactly as for any other admin; a finished event that is not taking late entries is still turned away at every one of them. **Only late entrants can be removed** from a finished event (ones who had not started playing before it ended), and only while its window is open — everybody who joined before the end stays, so its final results cannot change (a removable late entrant holding a placing certificate needs it revoked first). With the event open, its Participants section badges every late entrant and offers **Remove** only on the removable ones, and the delete confirmation says when removal from the event is not open for someone. The reverse holds at every door, the join link included: somebody who took part before the end — a submission, a hint, or having entered and then left or been removed — cannot come back as a late entrant, and removing and re-adding somebody who had entered the event keeps their original join time, so it cannot turn them into one. **Allow late entries** cannot be switched on or off once the event has ended, whoever asks, because either direction would move people between the final board and the late-entrant section; to close the door early, anyone who runs the event — an administrator, a superadmin, or an event admin who organises it — presses **Close late entries now** on the event's menu on the Events list or in its workspace's **⋯** menu, which closes the window at once, to the second, and is withheld from anyone competing in the event. A superadmin can still pin the late-entry deadline in the event's editor — to close the window at a particular time, extend it, or reopen one somebody closed — and extending an event whose late entries were closed early needs that deadline set back to **Automatic**, or to a time after the new end, in the same save. The **Join Link** stays on the event's menu while the window is open and, while **Enable self-enrollment** is on, the link, QR and code keep working until the deadline; with it off the dialog says they will admit late entrants only once it is turned on. Its switch is an edit of that finished event too, so the dialog leaves it to a superadmin. The assignment and group-sync emails for an event joined through its window name the late-entry deadline, in the recipient's timezone, instead of a start and end that have already passed — and only to somebody who can still play there, while an event the request skipped the recipient from is not listed at all; the invitation email does the same in UTC, its invitee having no account and so no timezone yet
- **Tap to answer at a Booth Event** — a multiple-choice challenge opened at a Booth Event on a phone (either orientation), on most tablets held upright, or in a browser window 600px wide or less fills the screen: the question above (beside, on a phone held sideways) and each option a large lettered tile, with the header, menu and footer set aside while it is open and the countdown moved into a bar beside **Back**. A tap opens the usual penalty confirmation, which now names the option picked and ignores a press for its first moment so a double-tap cannot submit; nothing is sent until it is confirmed. A wrong single answer marks its tile **Not correct**, and it cannot be picked again while the question is open; when attempts are limited the bar shows how many are left and says **Last attempt**, and a question with several correct options is answered by ticking tiles and pressing **Submit answers**. A short question with a few short options fits one screen; a long question scrolls inside its own area, and more than six options, or any longer than 90 characters, always scroll the page. It is decided by the event type's policy (`choice_layout`, `tap` for a Booth Event only) and the device — every other event type, a full-width laptop or desktop window, a tablet held sideways and the largest tablets even upright keep the ordinary layout, and a challenge already solved or no longer answerable is shown on the ordinary card, read-only. The challenge editor stops at the platform's 20-option ceiling and says so
- **Codes at the desk** — an admin can reveal a single-use code on their own screen for a participant standing at the desk who has **never signed in** (a walk-up just added at the desk, or one whose first emailed code never arrived), or use **Email sign-in code** on their row to send one; after a first sign-in the desk can only email a code. Neither is offered to an organiser competing in an event alongside that participant. A code shown at the desk is never replaced while it is live — not by the participant pressing **Continue** on the sign-in card, and not by **Email sign-in code**; only showing another code at the desk replaces it — so the code being typed always works. It lives for the rest of the account's ten-minute code window, so one shown while an emailed code is still live has less than ten minutes (the dialog shows the time left); a desk code works only for an account that is still a participant and has not signed in by another door since it was shown. Emailed codes are capped at `LOGIN_CODE_MAX_SENDS` sends per `LOGIN_CODE_TTL_MS` window, and a code mailed less than two minutes ago is never replaced, so a double-submitted form cannot cancel the one in the inbox
- **Impersonation** — an admin can browse the platform as a chosen participant to reproduce a support report. Read-only for regular admins (enforced by a single global gate, so it holds for endpoints added later too) apart from one named carve-out — generating that participant's certificate, which is what an organiser at a desk actually needs; publishing it to LinkedIn stays superadmin-only. An **event admin** additionally sees only the events they themselves organise while impersonating; every other admin tier sees the participant's whole list. An event admin can also be impersonated in **their own admin panel**: a global admin sees exactly the organiser's scoped panel (read-only for a regular admin, full for a superadmin, every change attributed to the superadmin through the organiser's seat), switches between the two views from the header without leaving the impersonation, and reads a sealed answer the organiser wrote only by revealing it on the record — the reveal naming the superadmin and the organiser's view they were in. Audited on the participant's own history, and excluded from analytics
- **Per-competition trusted networks** — allowlist the venue's egress IP for the life of one event so a roomful of participants behind a single NAT address can't rate-limit each other. Available on a Booth Event, and on a Competition only while it is single-session (an event that already has timeslots is refused), never on a Program, whose deadline can run for years. Time-bounded to the event's window plus two hours, ten entries at most, /16 at widest, and the platform raises an alert to admins when an address does get blocked. An organiser standing in the venue fills the field with **Use my current address**, which adds the address the platform sees them at only when it is a public one; a private or loopback address adds nothing and says that `TRUST_PROXY` is probably wrong
- **Email notifications** — sign-in codes, a notice whenever a password is set or changed, event reminders, approval notices; RFC 8058 one-click unsubscribe on bulk mail
- **Import/Export** — JSON import and export for challenges and participants
- **Full event and person exports** — one ZIP of CSV files with everything about an event (participants with every profile field, every submitted answer with its attempt number, hints, time spent, the main / late-entrant / team rankings, certificates, ratings, navigation), and a person's data as JSON or a ZIP (profile, events joined and left, each time they were taken out of an event, answers, hints, ratings, certificates, emails, sign-ins, History, invitations, groups; not the event team's lead record, time on the platform or navigation). Sealed answers stay withheld from anyone but the challenge's author; no password, code or capability link is ever included; every cell is spreadsheet-formula-safe; event admins get only their own events. The event export is **⋯ → Export everything** in an event's workspace, and `GET /api/admin/competitions/{id}/export/full`; the person export is API only, `GET /api/admin/participants/{id}/export/full`
- **Clone event and event templates** — copy an event's settings, tags, challenges and re-based sessions into a new upcoming event (never its participants, answers, trusted IPs or join link — a fresh link and code are minted — nor its own Checkmarx One key, so a copy of an event that creates accounts with one has them off), or save a reusable **template** and spawn events from it. Three built-in templates ship, one per type as its **recommended setup** on the New event page: **Booth day (8 hours)**, **Competition (several sessions)** and **Learning program (30 days)**. A challenge the new event cannot hold is skipped with a named reason; an event admin may clone their own events and spawn templates, and becomes the new event's organiser; templates are managed by administrators. In the UI: **⋯ → Clone** and **⋯ → Save as template** in an event's workspace, and the **New event** page in the sidebar (an administrator starts from a type's recommended setup, blank or from a template, an event admin from a recommended setup or a template in its quick spin; administrators also have **New template** and each template's **Edit**, **Duplicate**, **Protect** (a recommended setup's are on its type card, with **Reset to default**) and **Delete**, with a grouped template editor). API: `POST /api/admin/competitions/{id}/clone`, `/api/admin/event-templates`
- **Two flat looks, day and night** — Ambient (the house default, following each device's light or dark setting, with six accent colours) and Signature (Checkmarx violet, ivory by day), in Flat Design 3.0, each chosen per browser on the Appearance page (the account menu's Appearance row), with Auto / Light / Dark; a superadmin (or a custom role allowed to change the platform look) sets the organisation's default look. One typeface throughout: Inter
- **Account menu, Search and help tips** — the signed-in header holds only **Search** (Ctrl/⌘+K: pages, actions, events and help headings, each role seeing only its own doors) and one account button, whose short menu carries the view switch, an Appearance row that opens the Appearance page, Profile, Help, What's new and Sign out; small **?** tips explain non-obvious controls, and **Show all tips** opens them all
- **Mobile responsive** — full functionality on mobile devices with touch-friendly controls

## Tech Stack

- **Backend**: Node.js / Express 5
- **Database**: SQLite (better-sqlite3, WAL mode)
- **Frontend**: Vanilla-JavaScript single-page application, split into ES modules (`public/js/**`) — dev serves them raw (browser resolves the import graph; 1:1 breakpoints), prod esbuild-bundles the entry into one content-hashed file
- **Auth**: per account, a password (bcrypt) or emailed one-time sign-in codes (sha256 at rest); express-session with SQLite store
- **Email**: Nodemailer (any SMTP server)

---

## Quick Start

### Prerequisites

- **Node.js 20 LTS or newer** (the server uses `better-sqlite3` which ships prebuilt binaries for Node 20+; the `engines` field in `package.json` enforces `>=20`). `node --version` should print `v20.x` or higher. **Production runs `node:26-alpine`** (see the `Dockerfile`), and CI is held in lockstep with it, so prefer 26 locally too.
- **A local SMTP sink for development** — the server refuses to start without `SMTP_HOST` set. Point it at [`mailpit`](https://github.com/axllent/mailpit), [`smtp4dev`](https://github.com/rnwood/smtp4dev), or [`maildev`](https://github.com/maildev/maildev) so sign-in code, sign-up code, password-notice and approval emails have somewhere to land. In production, point it at your real SMTP relay (see SMTP Setup below).
- **Docker + docker-compose** (optional — only if you run the bundled container build). Otherwise just `node server.js`.
- **Playwright browsers** (only if you plan to run the test suite). `npm install` pulls in `@playwright/test` but NOT the browser binaries; install Chromium with `npx playwright install chromium`. For the opt-in cross-browser smoke (`npm run test:cross`) also install Firefox + WebKit: `npx playwright install firefox webkit` plus `sudo npx playwright install-deps firefox webkit`. **Not once, though: re-run the install after every Playwright version change** (a `package-lock.json` that moves `@playwright/test`). Each Playwright release pins its own browser builds and does not reuse the previous ones, so skipping it fails every test with *"Executable doesn't exist"* — and on a no-root host re-run `npm run test:cross:setup` as well (see *Cross-browser testing*).
- **`@axe-core/playwright`** is already pulled by `npm install` — no separate step. The axe a11y tests run as part of `npm test` via the same `npx playwright test` invocation.

### Run locally

```bash
# Install dependencies (also compiles better-sqlite3 against the local Node)
npm install

# Start the server (BASE_URL, SMTP_HOST, DATA_DIR and UPLOADS_DIR are required)
DATA_DIR=./data UPLOADS_DIR=./uploads BASE_URL=http://localhost:3000 SMTP_HOST=localhost node server.js

# ...or `npm start` / `npm run dev`, which supply DATA_DIR=./data and UPLOADS_DIR=./uploads for you
# (export your own to point somewhere else — the scripts honour it).

# ...or run tests (requires `npx playwright install chromium`, again after each Playwright version change)
npm test
```

On startup, the server logs the auto-generated **superadmin password**:

```
═══════════════════════════════════════════════════
  Superadmin password: aBcDeFgHiJkLmNoPqRsT
  Sign in on the sign-in page with the break-glass username (default: superadmin)
═══════════════════════════════════════════════════
```

Open `http://localhost:3000` in your browser, type `superadmin` (the built-in account's break-glass username) into the **Work email** box and press **Continue**. A password box appears, with no code button: enter the password from the console and press **Sign in**. There is no separate sign-in address for this account.

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | **required** | Public URL of the server (e.g. `https://hack.example.com`) |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | **required** | Directory for the SQLite database, attachments, logs and the password file. **There is deliberately no default (v8.8.26.)** `db.js` opens the database at require time, so a process that guessed this path would attach to whichever data directory happened to sit beside the code — in practice a live deployment's, silently. The image sets `/app/data`, and `npm start` / `npm run dev` default to `./data` unless you export your own, so nothing about an ordinary deployment changes; what changes is that a script or a one-off `node -e` now refuses rather than guessing. That includes the two operator scripts: since v8.13.4 `scripts/backup.sh` and `scripts/purge.sh` exit non-zero without it, where they used to fall back to `<repo>/data` — so a cron line or `sudo` invocation must set it (see *Backup & disaster recovery*). |
| `UPLOADS_DIR` | **required** | Directory for in-flight submission uploads — a **separate filesystem** from `DATA_DIR` (the upload capacity check measures free space on both). **No default since v8.8.27**, for a sharper reason than `DATA_DIR`'s: the server *sweeps* this directory at every boot, so a guessed path is one it DELETES from. The image sets `/app/uploads`; `npm start` / `npm run dev` default to `./uploads` unless you export your own. |
| `NODE_ENV` | — | Set to `production` for secure cookies and the minified JS bundle. Secure cookies are **also** enabled on their own by an `https://` `BASE_URL` or by any non-false `TRUST_PROXY`, so a plain-HTTP deployment must leave all three off — otherwise express-session drops every session cookie and `GET /api/csrf-token` answers `503 session_cookie_blocked`. |
| `SMTP_HOST` | **required for the first start** | SMTP server hostname. The server refuses to start when neither this nor a mail server saved in **Settings → Email (SMTP)** names a relay. A mail server saved there replaces `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `EMAIL_FROM` as a whole (see **SMTP Setup**). |
| `SMTP_PORT` | `587` | SMTP server port. `465` is TLS from the first byte; any other port requires STARTTLS. |
| `SMTP_USER` | — | SMTP authentication username |
| `SMTP_PASS` | — | SMTP authentication password. It can instead be entered once in **Settings → Email (SMTP)**, where it is stored encrypted, after which this variable (or the secret it comes from) can be removed. |
| `SMTP_POOL_MAX_CONNECTIONS` | `16` | Relay connections the pooled transport keeps open (1–64; keep it at 8 or more, the bulk mail fan-out runs eight sends at once). A burst of sign-in mail queues behind them instead of opening a connection per message. |
| `SMTP_POOL_MAX_MESSAGES` | `100` | Messages sent over one pooled connection before it is replaced (1–10000). |
| `SMTP_ALLOW_PLAINTEXT` | — | **Development only.** Set `1` to allow sending over an unencrypted connection. The transport otherwise **requires** STARTTLS (or implicit TLS on port 465) and fails the send — see **SMTP Setup**. It applies to a mail server saved in Settings too, and only this variable can turn it on. |
| `EMAIL_FROM` | `no-reply@hackathon.local` | **Sender ADDRESS** for outbound email, unless a mail server saved in **Settings → Email (SMTP)** names its own. Only the address half is used — the *sender name* recipients see comes from **Settings → Branding → Platform name** (see `COMPETITION_NAME` below). A display name written here (`Acme <no-reply@acme.com>`) is accepted and ignored, so a bare address is the clearer form. If the value contains no address at all the server warns at boot and falls back to `no-reply@hackathon.local` — a domain you almost certainly do not own, so your mail will fail SPF. |
| `EXTERNAL_FETCH_TIMEOUT_MS` | `10000` | Abort deadline for outbound CxOne calls. The deadline covers the **response body**, not just the headers — an upstream that sends headers and then stalls would otherwise hold a request open indefinitely. |
| `TRUST_PROXY` | `false` | Must match the deployment shape. Accepts Express's formats: `false`/`0` (default — trust nothing), `true` (trust EVERY hop: `req.ip` becomes the leftmost `X-Forwarded-For` entry, which the client writes itself unless the proxy in front overwrites that header — nginx's `$proxy_add_x_forwarded_for`, an AWS ALB and Cloudflare all append to it, so prefer a hop count), integer hop count (`1`, `2`, …), presets (`loopback`, `linklocal`, `uniquelocal`), or comma-separated IP/CIDR list. The keywords (`true`, `false` and the preset names) are case-insensitive: `TRUE` is `true`. See **Reverse-proxy configuration** below before deploying. |
| `HSTS` | `1` (on) | Sets the `Strict-Transport-Security` header (`max-age=31536000; includeSubDomains`) on every response. Default is on — safe for the common HTTPS-only deployment. Set to `0`/`false`/`off`/`no` to disable, e.g. when serving over plain HTTP during development or when the deployment mixes HTTP and HTTPS origins. |
| `SUPERADMIN_PASSWORD_QUIET` | unset | Set to `1` to suppress the auto-generated superadmin password banner on stdout. The password is still written to `DATA_DIR/.superadmin-password` (mode 0o600). Useful in container environments where stdout is permanently archived by a log shipper. |
| `EVENT_RETENTION_DAYS` | `730` | Retention window (whole days, ≥1) for the audit/event tables (`*_events`). A daily background job deletes rows older than this; default 730 = 2 years. Set larger (e.g. `36500`) to retain effectively forever. See **Data retention & privacy → Audit-event retention**. Also the age past which a Checkmarx One account removal still unresolved is flagged *kept past the retention period*; those records are never deleted for their age (step 4 of the GDPR procedure). |
| `LOG_SKIP_IPS` | — | Comma-separated IP addresses or CIDR blocks (e.g. `192.168.1.0/24,10.0.0.1`). Requests from these IPs are excluded from the HTTP access log. Addresses are **canonicalised** before comparison (RFC 5952), so `2001:db8::1` and `2001:0DB8:0000:…:0001` are the same host however it is written, and an IPv4-mapped `::ffff:192.0.2.1` matches a listed `192.0.2.1`. |
| `BACKUP_DIR` | — | A read-only mount of the host's backups folder. **Settings → About & health** then shows how many backups there are and when the newest finished (a superadmin also its size); unset, it says the backups are not visible to the app. `deploy/podman/install.sh` mounts `/srv/<app>/backups` at `/app/backups` and sets it. Never written to. |
| `BUILD_COMMIT`, `BUILD_TIME`, `RELEASE_CHANNEL` | — | Baked into the release image by `.github/workflows/release-image.yml` (the commit, the build time, and `stable` for `main` and `v*` tags, else `dev`); shown under **Settings → About & health**. A local build leaves them unset, and the page says unknown. |
| `LOG_DIR` | `DATA_DIR/logs` | Directory for the JSONL access + app log streams. In the container it must be writable by the `node` user — under `DATA_DIR` or another mounted volume, since the code tree under `/app` is read-only to the app. Give `scripts/purge.sh` the same value so it purges these files; `scripts/backup.sh` copies only `DATA_DIR/logs`, so a `LOG_DIR` outside `DATA_DIR` is not backed up. |
| `LOG_LEVEL` | `info` | Minimum app-log level (`debug` / `info` / `warn` / `error`). |
| `LOG_SCAN_BUDGET` | `200000` | Maximum log lines `GET /api/admin/logs` walks per request (floor 1000). It decides whether a filtered read can report an EXACT total — and therefore whether the Logs pager's page count, **Last** and jump-to-page are live. On the Audit log a walk it cuts says how far back it searched, and **Next** continues from there. Raise it for a very large log on fast storage; the cost is CPU per request in a single-process server. |
| `LOG_SORT_MAX_WINDOW` | `25000` | Deepest `offset + limit` for which a filtered Logs read is ranked across every match (floor 100). Beyond it the read falls back to ordering the page in hand and says so. Peak retention is 2x this many parsed rows (~28 MB at the default). |
| `LOG_CONSOLE_MIRROR` | on in dev/test, off in production | Also emit each structured log line to stdout. Set `0`/`1` to force. When it is off, a process that exits on a failure still writes its last minute of error lines to stderr, so a refused start-up (a missing `SMTP_HOST`, say) shows in `docker logs`. |
| `LOG_DISABLE_ACCESS` | off | Set `1` to skip the per-request access log entirely. |
| `LOG_MIN_FREE_MB` / `LOG_MIN_FREE_PCT` | `500` / `5` | When free disk falls below the larger floor, delete the oldest rotated log files (never today's) until it is back above. |
| `PERF_SPAN_SLOW_MS` | `300` | Threshold for the `[perf-span]` slow-request line. On the submit span this is the **server** share: time spent waiting for a participant to finish sending their request body is reported separately as a slow *client* upload at `info` level, so a weak venue connection is not mistaken for a slow endpoint. |
| `LOGIN_CODE_TTL_MS` | `600000` (10 min) | Lifetime of a sign-in code. The safe knob if more margin is wanted — the code LENGTH is not, once it is in email templates. |
| `LOGIN_CODE_MAX_SENDS` | `3` | Total sign-in codes that may be sent to one account inside a single `LOGIN_CODE_TTL_MS` window, counting the first. Each send mints a fresh code that supersedes the previous one — only a hash is stored, so a code can never be re-sent. |
| `RATE_LIMIT_DISABLED` | off | Set to `1` or `true` to disable all rate limiters. Only for local development; never in production. |
| `RATE_LIMIT_LOGIN_PER_MIN` | `60` | Per-minute limit on the password doors, per `(IP, name)`: an account's password sign-in (`POST /api/auth/password`) and the entry screen's sign-in-method lookup (`POST /api/auth/sign-in-method`), each keyed by the address, and the break-glass sign-in (`POST /api/login`), keyed by the username. Keyed by name so a cohort of distinct accounts behind one venue NAT doesn't share a bucket. |
| `RATE_LIMIT_LOGIN_IP_BACKSTOP_PER_MIN` | `600` | Coarse per-IP per-minute ceiling on each of the same three doors and on sign-in code redemption (`POST /api/auth/code/redeem`; each door counts on its own), enforced alongside the per-name limits, capping guessing spread across many names from one address. The sign-in code request (`POST /api/auth/code/request`) has the same backstop at this rate over its own 15-minute window (600 a minute is 9000 per 15 minutes). |
| `RATE_LIMIT_PROOF_IP_PER_15MIN` | `150` | Per-IP budget on **address proofs** — the code mailed to an address no account holds, so it can sign up — per 15-minute window (the rate a new account could register at before sign-up started from the email box). Beyond it, a new address typed from that IP is mailed nothing, but the entry screen still answers exactly as it does for every address (the refusal is audited as `email_proof_refused`, reason `ip_budget`, naming the domain, never the address; refusals from one IP are recorded up to this same budget per 15 minutes and counted beyond it, in `hack_arena_email_proof_refusals_unrecorded_total`), because a refusal shown only for new addresses would say which addresses have no account. Sign-in codes to existing accounts are not counted; each account has its own send cap. It stops one source making the platform mail any number of new addresses through the SMTP pool every event's sign-in codes share. A walk-up rush of new sign-ups from one venue NAT belongs on the event's **trusted networks** (or `RATE_LIMIT_ALLOWLIST_IPS`), which bypass it; `RATE_LIMIT_DISABLED` turns it off with the other limiters. |
| `RATE_LIMIT_CSRF_PER_MIN` | `120` | `/api/csrf-token` limit per IP. **Raise this for a NAT'd venue** — every login needs a token first, so this cap binds a large cohort one step before the login limiter does. |
| `RATE_LIMIT_CONFIG_PER_MIN` | `120` | Per-IP limit on the public reads `/api/config` and `/api/settings/appearance` (each counted separately). |
| `RATE_LIMIT_ALLOWLIST_IPS` | — | Comma-separated exact IPs + IPv4 CIDRs that bypass **every** limiter and the scanner-reputation tracker. **Allowlisting a venue's egress IP is not optional for a NAT'd event** — see *Rate limiting* under Security. For a single event, the per-competition **trusted networks** field does the same thing without a restart. |
| `MINIFY_JS` | off (auto-on in production) | esbuild-**bundle** the SPA entry (`public/js/core/main.js`) at startup — its whole `public/js/**` import graph inlined into one minified, content-hashed file (zero extra module requests). Standalone classic scripts (`theme-boot`/`help`/etc.) are per-file minified. Automatically enabled when `NODE_ENV=production`. In dev/test the modules are served raw from the working tree, so edits are live on refresh and breakpoints map 1:1 to source. Set to `1` to force-enable locally for a production-parity check (`MINIFY_JS=1 npm test`). |
| `COMPETITION_NAME` | `Checkmarx Enablement Platform` | **Deprecated fallback** — the platform name is configured at runtime via **Settings → Branding → Platform name** (persisted in the DB as `settings.platform_name`). The env var is consulted only if the DB value is absent (fresh install, first boot before an admin has logged in). Prefer setting the name from the admin UI so help-drawer markdown, emails, and the header all pick it up without a restart. The name is also the **sender name on every outbound email** (the address comes from `EMAIL_FROM`, or the mail server saved in Settings), so a rename reaches recipients' inboxes on the next send with no redeploy. Changing it is **superadmin-only**. |

**Auto-generated (not configurable):**

- **Session secret** — a random 48-byte key generated on every startup. All existing sessions are invalidated on restart.
- **Superadmin password** — a random 22-character password generated on every startup, printed to the server log, and written to `DATA_DIR/.superadmin-password`. After **10 consecutive failed sign-ins to the break-glass account, counted globally within a 15-minute sliding window,** the password is regenerated and re-logged (global rather than per-IP, so a distributed brute force can't sit below a per-IP threshold and never trip rotation). A successful superadmin login resets the counter. **Rotation cooldown**: a 10-minute global cooldown caps rotations at 6/hour regardless of attacker pattern — during the cooldown, threshold-breaching attempts are logged as `rotation_suppressed` but no new password is issued.

### SMTP Setup

> **TLS is required.** Port 587 negotiates STARTTLS *opportunistically*: without an explicit requirement, a server that simply omits STARTTLS from its EHLO causes a silent downgrade to plaintext — and an audit reproduced a fake relay collecting the `AUTH` credentials, along with every sign-in code and verification link it relayed, in the clear. The transport sets `requireTLS` (port 465 uses implicit TLS instead) and **fails the send** rather than downgrading.
>
> If mail stops working after upgrading, your relay is not offering STARTTLS. Point `SMTP_HOST` at a TLS-capable relay, use port 465, or — for a local capture server only — set `SMTP_ALLOW_PLAINTEXT=1`. The startup SMTP health probe names this explicitly when TLS is the cause. Local capture servers (`mailpit`, `smtp4dev`, `maildev`) generally have no TLS, so development setups will want that flag.

SMTP configuration is **mandatory**: the server exits at startup with a fatal error when no relay is configured, neither `SMTP_HOST` nor a mail server saved in Settings. Registration, sign-in codes, and all email-driven flows require a working SMTP transport. For local development, point `SMTP_HOST` at a local capture server (e.g. `mailpit`, `smtp4dev`, or `maildev`) — you do not need a real outbound MTA, just something that accepts on the configured host/port. Example:

```bash
SMTP_HOST=smtp.example.com \
SMTP_PORT=587 \
SMTP_USER=you@example.com \
SMTP_PASS=your-password \
EMAIL_FROM="no-reply@example.com" \
BASE_URL=https://hack.example.com \
DATA_DIR=/opt/hackarena/data \
UPLOADS_DIR=/opt/hackarena/uploads \
node server.js
```

#### Changing the mail server from the app

A superadmin can save the mail server in **Settings → Email (SMTP)**: host, port, security (STARTTLS required, or TLS from the start), username, password and sender address. Every reader of Settings sees the server in use and whether each value was set in the app or comes from the environment; only a superadmin can change it (the permission behind it, `ops.smtp`, cannot be given to a custom role).

- **Saved settings replace the environment's as a whole** (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`), never field by field, and take effect at once with no restart: mail already being sent finishes on the old server. **Remove saved settings** goes back to the environment, and is refused while the environment names no relay. `SMTP_ALLOW_PLAINTEXT` and the pool sizes stay environment-only.
- **Test with these values** sends one message through the values in the form before they are saved.
- **The password is stored encrypted** (AES-256-GCM) under a key in `DATA_DIR/.smtp-key` (mode 0600), and never shown or logged. Leaving the password box empty keeps the password in force only for the same host and username, so a saved password is never sent to another server. The first save with the box empty copies the environment's `SMTP_PASS` into the app (encrypted), after which the variable, or the Podman secret it comes from, can be removed.
- **The key is not in backups** (a backup holding both the key and the database would hold the password). After a restore, or a move to another server, the saved password cannot be read: mail goes through the environment's relay meanwhile if `SMTP_HOST` is set, the Settings card says so, and a superadmin enters the password again and saves.
- With a mail server saved, the server starts even with no `SMTP_HOST`; keep `SMTP_HOST` set anyway, as the fallback for a restore.

#### SMTP authentication: SPF, DKIM, DMARC, and unsubscribe (production)

For any deployment that mails real participants (registration, sign-in codes, invitation, reminder, lockout), DNS-side sender authentication is **strongly recommended**. Without it Gmail / Outlook / Apple Mail are increasingly likely to silently spam-classify the platform's outgoing mail, and from 2024 onwards Gmail flat-out rejects unauthenticated bulk senders.

| Record | Where it lives | Why it matters | Minimum setup |
|---|---|---|---|
| **SPF** | TXT record on the `EMAIL_FROM` domain | Tells receivers which IPs are allowed to send "From: @yourdomain". Without it, anyone can spoof your domain — and Gmail rejects unsigned senders. | `v=spf1 include:<your-smtp-relay-spf-include> -all` (the SMTP relay's docs name the include). |
| **DKIM** | TXT record on `<selector>._domainkey.<domain>` | Cryptographic signature on each outgoing email. Receivers verify the signature against the published public key. The relay (SES, SendGrid, Postmark, Mailgun, etc.) typically configures DKIM for you — you just paste the relay's DNS records. | Two CNAMEs / TXT records published by your relay; one selector per relay. |
| **DMARC** | TXT record on `_dmarc.<domain>` | Tells receivers what to do with mail that fails SPF / DKIM (`p=none`, `p=quarantine`, `p=reject`). Also the only mechanism receivers use to send you aggregate reports of who's claiming to be you. | `v=DMARC1; p=none; rua=mailto:dmarc-reports@<domain>` to start. After 2-4 weeks of clean reports, ratchet to `p=quarantine`, then `p=reject`. |

The platform emits `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers on bulk-style emails (invitations, reminders, event assignment, removal-from-comp) per RFC 2369 / 8058 + Gmail's bulk-sender policy. Approval notices — individual and batched alike — are treated as **transactional**: they carry no unsubscribe header and are delivered even to an address on the unsubscribe list, alongside sign-in code, verification, password-notice and lockout mail. Two opt-out surfaces are advertised on every bulk email:

1. **HTTPS one-click endpoint** (`POST /api/unsubscribe?token=<HMAC-signed>`). Mail clients (Gmail, Outlook 365, Apple Mail) hit this when the user clicks the inline X / Unsubscribe affordance. The token is HMAC-signed and per-recipient — a leaked URL only opts out the address it was issued to. Tokens expire after 365 days. The signing secret is persisted to `DATA_DIR/.unsubscribe-secret` (mode 0o600, 32 random bytes generated on first boot, re-read on every subsequent boot) so already-sent unsubscribe URLs keep working across server restarts and deployments — back up this file alongside the SQLite databases. The endpoint inserts a row into `unsubscribed_emails` and the email pipeline short-circuits future bulk-reason sends to that address (auth-flow emails — sign-in codes, verification, password notices, lockout — bypass the check entirely; recipients can't usefully opt out of one-off security mail).
2. **Mailto alias** (`mailto:unsubscribe@<EMAIL_FROM-domain>`). Legacy clients that don't support RFC 8058 fall back here. Operators who want to honour these manually should route `unsubscribe@` on their MTA to a human queue.

Admins can review the unsubscribed list via `GET /api/admin/unsubscribed` and re-subscribe an address (after an out-of-band confirmation from the recipient) via superadmin `DELETE /api/admin/unsubscribed/:email`.

### Backup & disaster recovery

The platform stores **everything** in `DATA_DIR` (required; the image sets `/app/data` and `npm start` uses `./data`; `scripts/backup.sh` and `scripts/purge.sh` must be given it in their own environment — on the bundled docker-compose host that is `DATA_DIR=/opt/hackarena/data`):
- `hackathon.db` — users, competitions, tasks, submissions, all `*_events` audit tables, **and** the session store (the `express_session` table lives inside this same DB — there is **no** separate `sessions.db` file)
- `attachments/` — admin-uploaded ZIPs (UUID-keyed, immutable once committed)
- `attachments-staging/` — uploads not yet committed to a challenge. Backed up because the rows describing them live in `hackathon.db` (`task_attachments_staging`), so a DB restored without these files carries rows pointing at nothing — unrecoverable uploads, and phantom rows consuming the per-admin and global staging quotas, which are summed from the **table**, not from disk. That state self-heals (the hourly sweep reaps staging rows older than an hour), so it is a completeness matter rather than an emergency.
- `logs/` — JSONL audit + access streams (rotated daily; a sweep cleans orphans)
- `.superadmin-password` — **deliberately NOT backed up**; a fresh password is generated on every boot, so a restored one would be stale and misleading.
- `.maintenance` — **deliberately NOT backed up**; restoring a maintenance gate would 503 your users on the way back up.
- `.smtp-key` — **deliberately NOT backed up**: the 32-byte key (mode 0o600) the mail-server password saved in Settings → Email (SMTP) is encrypted under. A backup holding both it and the database would hold that password. After a restore the saved password cannot be read; mail goes through the environment's relay (`SMTP_HOST`) meanwhile, and a superadmin enters the password again (`RESTORE.txt` step 7).
- `.unsubscribe-secret` — 32-byte HMAC signing secret for unsubscribe URLs (mode 0o600). Persisted so already-sent unsubscribe links keep working across restarts; back this up alongside the SQLite databases. Loss → all in-flight unsubscribe URLs become invalid (recipients must use the mailto fallback or be re-subscribed manually).
- `.grading-secret` — 32-byte HMAC key for the grading-revision token (mode 0o600). The token is issued with each challenge and echoed back on submit so the server can refuse to grade an answer against criteria the participant never saw; keying it is what stops the token being an offline oracle for the answer itself. Loss is benign — in-flight tokens stop matching, so anyone with a challenge already open gets one "reload the challenge" notice — but `scripts/backup.sh` copies it anyway so a restored volume behaves identically.

`uploads/` (`UPLOADS_DIR`) is a **separate** docker volume and is deliberately outside this list: files there are read and deleted as each submission is processed, so there is nothing durable to preserve.

A naive `cp data/hackathon.db /backup/` while the server is writing produces a torn copy. Use `scripts/backup.sh` instead — it uses SQLite's online-backup mechanism (`sqlite3 .backup` command) which holds a read lock for the duration, producing a bit-consistent snapshot even on a live server. Attachments and staging are copied both before and after that snapshot, and the script then checks that every attachment file the snapshot names is in the backup at its recorded size. A file neither copy caught (uploaded and then deleted again while the backup ran) makes it take a new snapshot, a bounded number of times (`BACKUP_MAX_ATTEMPTS` in the script), after which it refuses. Logs are copied once, and the two HMAC secrets are copied with their `0600` mode intact.

**Prerequisite: the `sqlite3` CLI must be on `PATH`.** The script checks and exits with a clear message if it is missing. Note the shipped container does **not** contain it — the runtime stage is a bare `node:*-alpine`, and the platform talks to SQLite through `better-sqlite3` (a Node addon, not the CLI). So run the script on the **host**, against the mounted data volume; `docker exec`ing it into the app container will not work. On Debian/Ubuntu: `apt-get install -y sqlite3`.

**`DATA_DIR` is required too, and nothing is guessed (v8.13.4).** Both `scripts/backup.sh` and `scripts/purge.sh` exit non-zero, naming the variable, when it is unset or empty — before they create, read or delete anything — and refuse a value that is not a directory. They used to fall back to `<repo>/data`, the directory beside the checkout, which on a host whose checkout holds or links the live data directory *is* the live volume; the server has refused the same guess since v8.8.26. The value is resolved to an absolute path, so a relative `DATA_DIR=./data` is fine and `RESTORE.txt` still names the real directory. **Put the assignment after `sudo`**: `sudo` resets the environment, so an exported `DATA_DIR`, or `DATA_DIR=… sudo scripts/backup.sh`, never reaches the script and it refuses. The same goes for cron, which does not read your shell profile: the variable belongs on the crontab line.

```bash
# Take a backup. Default output dir: <repo>/backups/<UTC-timestamp>/ — beside the
# checkout the script lives in, whatever the current directory.
sudo DATA_DIR=/opt/hackarena/data scripts/backup.sh

# Or specify a target directory (e.g. mounted backup volume)
sudo DATA_DIR=/opt/hackarena/data scripts/backup.sh /mnt/backups/hackarena/2026-04-30

# A bare-metal install whose data sits in ./data beside the checkout says so explicitly
DATA_DIR=./data scripts/backup.sh
```

The default output sits **inside the checkout**, and on a docker-compose host that checkout is the image's build context. `.dockerignore` is an allow-list (it re-admits only what the app runs), so a backup never rides into the next image — but it holds the live database and both HMAC secrets, so ship it off the host, or pass an output directory outside the checkout as above.

**A backup directory is written ONCE, and it says when it finished.**

- The script **refuses a destination that already holds a backup**, because a second run into the same directory is not an overwrite: it resurrects log files the retention purge had removed and accretes attachments deleted since. The default path is a per-second UTC timestamp, so this never fires on the workflow above; it only stops a hand-supplied destination being reused. Pass `--reuse` as the second argument if overwriting in place is genuinely what you want.
- The script **refuses to start when `$DATA_DIR/hackathon.db` is absent or empty**, before it creates the destination directory — so a run against an unmounted volume, a mistyped `DATA_DIR` or a half-provisioned host exits non-zero with nothing written (an unset or empty `DATA_DIR` is refused even earlier, above; there is no `<repo>/data` default), rather than producing a directory of logs and secrets with no database in it. It also **verifies the snapshot it just took** (a `sqlite3` read of the schema) and fails if that read does not succeed, and a failed database copy is now an error rather than a warning. Before v8.11.1 all three of those merely printed `WARN` and carried on to write `BACKUP_COMPLETE`, which is the one file the restore procedure below tells you to trust.
- Every completed run writes **`BACKUP_COMPLETE`** as its very last act, after every copy step. **Do not restore a directory without it.** An interrupted or refused run — a copy fails, a disk fills, someone presses Ctrl-C, the attachment check below refuses — leaves a fresh database beside a previous run's logs and metadata, which is otherwise indistinguishable from a good backup. Such a directory is incomplete and safe to delete.
- **`BACKUP_COMPLETE` also vouches for the attachment files.** Its `attachments_verified` line counts the attachment files the snapshot names that are in the backup at their recorded size. The script exits 1 with no marker when it cannot vouch for them: a storage path it does not recognise, or attachments still being uploaded and deleted after its last snapshot (run it again). A file the live volume itself has lost (its row still in the database, the file missing or the wrong size) is not something a retry can fix, so it is not refused: it is counted on the `attachments_lost_on_live_volume` line, listed with its size in `BACKUP_METADATA.txt`, printed as a `WARNING` and written to syslog under the tag `hackarena-backup`, and a restore brings back that same gap. A file the live volume has lost that this backup does hold (a `--reuse` directory keeps every file an earlier run copied) is reported the same way, marked `this backup holds a copy`; it still counts in `attachments_verified`, and a restore puts it back. **An earlier backup may still hold such a file:** copy it back into `DATA_DIR/attachments/` from the newest backup that has it at the listed size (then `chown` it to the data directory's owner), before retention deletes that backup. `BACKUP_METADATA.txt` also records `snapshot_attempts`, `attachments_referenced` and `staging_rows_without_file` (unfinished uploads with no file in the backup; they expire within an hour of a restore).

```bash
test -f <backup-dir>/BACKUP_COMPLETE && echo OK || echo "INCOMPLETE — do not restore"
```

Each backup is a self-contained directory, and every one ships a `RESTORE.txt` carrying the procedure below — whoever restores under pressure is often not whoever read this README. Restore is:

1. Check `BACKUP_COMPLETE` exists (above), then stop the server (`docker-compose stop` or `kill -INT <pid>` for the graceful 20-s drain).
2. `rm -f <DATA_DIR>/hackathon.db-wal <DATA_DIR>/hackathon.db-shm` — **do not skip this** (see the warning under *Backup & Restore* below; `--delete` in step 3 also removes them, and the explicit `rm` is what makes a `cp`-based restore safe too).
3. `rsync -a --delete <backup-dir>/ <DATA_DIR>/`.
4. **Choose what happens to email about everything that ended before the restore** (it needs `sqlite3` on the host, as the backup does). Events that were still running when the backup was taken look newly ended to the restored database: left alone, everyone who took part is issued a new certificate (a new code) and emailed, and those events' teams get their wrap-ups, lead files and 48-hour reminders again. Run one of:
   - `sudo DATA_DIR=<DATA_DIR> scripts/restore-mail.sh mark-sent` — treat it as already sent. Nobody is emailed again. The certificate codes emailed after the backup was taken stay dead; their holders can collect a new certificate (a new code) from the event's Challenges page. Also not sent automatically: Program completions queued before the restore; late entrants of an event that ended before it (they can collect their certificate themselves), with that event's late leads and 48-hour reminder for its team (Send now reports them); certificate emails still failing at backup time; and start reminders already past due and this week's Monday digest count as sent.
   - `sudo DATA_DIR=<DATA_DIR> scripts/restore-mail.sh resend` — send it again. Everyone in those events is issued a new certificate and emailed, which replaces the dead codes, but their teams get duplicate wrap-ups, lead files and reminders. Start reminders already due go out once maintenance is lifted, except for events or sessions that have started by then, which are not sent.

   Either way, events still running at the restore, and any later end (a revive and re-end included), are mailed as usual, and an admin's Resend, Issue again and Send now work as always. The script refuses a database with a write-ahead log beside it (a running server, or a skipped step 2) and changes nothing then; `resend` only records the choice, and to undo a `mark-sent` before the first start, run step 3 again.
5. `chown -R <owner> <DATA_DIR>`, where `<owner>` is the `data_dir_owner` recorded in the backup's `BACKUP_METADATA.txt` (uid 1000 for the shipped image). **Do not skip the `chown` when the backup or the restore ran as root:** `rsync -a` copies ownership, so a data directory restored from a root-owned backup is root's, and the server's own user can then no longer write its database — the platform does not come back up. `RESTORE.txt` carries the line with the real owner and path filled in.
6. Put the platform in maintenance mode (`printf '%s' '<a bypass token>' > <DATA_DIR>/.maintenance`), then start the server: certificate, event-team and start-reminder email waits while it is on, so nothing is mailed from the restored database until you have checked it and removed the file; then it goes out as you chose in step 4. Boot-time `PRAGMA integrity_check` runs on the restored DB; if it reports anything other than `ok`, investigate before letting users back in. While it fails, or the boot finds the schema incomplete (`/readyz` answers `db_integrity` or `db_schema`), that email keeps waiting even with the file removed, until the database is fixed and the server restarted. **A fresh superadmin password is generated on this boot** — read it from the startup log or `DATA_DIR/.superadmin-password`. This first start also removes attachment files the restored database does not name.
7. If a mail server was saved in **Settings → Email (SMTP)**, enter its password again there: its key file is never in a backup, so the restored password cannot be read (mail goes through the environment's `SMTP_HOST` meanwhile, if set).

`RESTORE.txt` and `BACKUP_METADATA.txt` land in `DATA_DIR` as a side effect of step 3; the server ignores them.

**Recommended cadence:**
- **Production tournament**: full backup at start-of-day, every 30 min during the live window, again at end-of-day. The backup script is fast enough (~1 s for ≤500 MB DBs) to run on a cron without affecting live traffic.
- **Pre-deploy**: always before `docker-compose up --build` lands a new image — the boot-time schema migration is forward-compatible but rolling back is cleanest from a backup (`sudo DATA_DIR=/opt/hackarena/data scripts/backup.sh`). **Take one before deploying 9.2.17 or later over an older version in particular:** its first start deletes every stored picture nothing in the app uses that is older than a week (up to 500 a pass, the rest on the following days; see *Data retention & privacy*), including pictures only an outside page or email still links to, and the backup is the only way to get one back.

A cron line carries `DATA_DIR` itself, because cron does not read your shell profile and the script refuses without it. Cron does not report a job's exit code, and without a local mail transport its output goes nowhere, so a refusing or failing backup leaves no trace unless the line sends one — the `|| logger` below writes it to syslog. Each run is a FULL copy (database, logs, attachments), so give it an output directory **outside the checkout**, ideally on another volume, and prune old ones: the default `<repo>/backups/` sits on the same disk as the live data volume on the compose host, and filling that disk takes the platform down. **Prune only after a run that succeeded** (the `&&` below): a retention job of its own, on its own schedule, keeps deleting the oldest backups every night while the backups themselves are failing, until the last good one is gone. A run that finds attachment files missing from the live volume itself still succeeds, so the prune runs after it too: act on its syslog `WARNING` within the retention window, while an earlier backup still holds those files.

```cron
# root's crontab (a % must be written \% in a crontab line).
# Nightly at 02:00 UTC to a backup volume, keeping 14 days — pruned only after a good run.
0 2 * * *    DATA_DIR=/opt/hackarena/data /opt/hackarena/scripts/backup.sh /mnt/backups/hackarena/$(date -u +\%Y-\%m-\%dT\%H\%M\%SZ) && find /mnt/backups/hackarena -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf -- {} + || logger -t hackarena-backup "backup or prune FAILED (exit $?)"
```

For the live window of an event, add a second, temporary line with a tighter schedule (e.g. `*/30 9-18 * * *`) and remove it afterwards.

The backup directory is plain SQLite + rsync'd files — `tar czvf backup.tar.gz <dir>` for off-host shipping. To inspect a backup without restoring, point `sqlite3 <backup-dir>/hackathon.db` at it directly.

### Data retention & privacy

By default the platform retains most data **indefinitely**, with these exceptions: the audit/event tables (a 2-year window, see *Audit-event retention* below), the certificate email's expired LinkedIn share links, stored images nothing uses any more and expired session rows, which are swept automatically:

- **Audit-event tables** (`user_events`, `competition_events`, `timeslot_events`, `settings_events`, `challenge_events`, and `orphan_events`, the copies of the audit events whose subject has no history of its own, which the **Audit** page lists; each also keeps its line in `app-*.jsonl`) — every admin action, every participant submission, every login. These rows also carry per-request PII (the acting admin's IP + user-agent), so **they are auto-purged after a 2-year retention window** (`EVENT_RETENTION_DAYS`, default 730) by a daily background job — see *Audit-event retention* below. Everything else in this list is kept indefinitely unless you act.
- **Checkmarx One accounts awaiting removal** (`cxone_realm_accounts`) — for every account the platform created: its realm account id, tenant and username, a fingerprint of the address it was created with, the ids of the roles and the names (never the values) of the details it carried when created, the event, and the participant's local id — and, while it is held as taken into use, which sign held it. Kept while the participant is on the platform and, once they are deleted, until the account is removed from the tenant, passes to a participant still on the platform, or a superadmin marks it removed, however long that takes. It is never deleted for its age, because it is the only way left to finish the erasure in the tenant; one whose removal was scheduled more than `EVENT_RETENTION_DAYS` ago is flagged instead. See *GDPR-style "right to be forgotten"*, step 4.
- **LinkedIn share links from the certificate email** (`certificate_share_links`: a sha256 of each one-time link, the certificate it belongs to, and when it was made, expires and was used) — a link expires seven days after its email was sent, and the same daily job deletes it **30 days after it expired**, used or not. Until then an old link's page says it has expired (or was used); after, it shows the page's ordinary not-found message. A link also goes with its certificate (a revoke or an erasure).
- **Stored images nothing uses any more** (`images`: avatars and pictures pasted into challenges) — **a stored picture stays only while something in the app uses it**: a challenge or one of its saved versions, an account's photo, a frozen team board, an older certificate (or a template, setting or certificate design). The same daily job deletes an image once nothing names it, and only once it is **more than seven days old**, so a save still in progress never loses its pictures. An image a challenge's earlier version still shows is kept, so restoring that version brings it back. At most 500 go per run, oldest first; the rest follow on the next day. **A link to a picture from outside the app** (an external page, a hand-written email, a slide deck, a chat) is not something the platform can see: it stops working once nothing inside the app uses the picture (deleting the challenge that showed it, say), at the next daily pass, and never within a week of the picture being stored. The week counts from when the picture was stored, not from when it stopped being used, so an older picture goes at the first pass after its last use. Pictures are served `Cache-Control: private, max-age=86400` with the image id as their ETag, so **a browser keeps a copy for at most a day** (then asks again, and a deleted picture answers 404) and no shared proxy or CDN may keep one, so a replaced or erased photo stops showing within a day. A copy a browser or shared cache fetched under an earlier version (served cacheable for a year) may still show for up to a year; nothing the server does reaches it. Each pass that deleted pictures records their ids in its `events_purged` record (Audit page, and `app-*.jsonl`), so one deleted by mistake can be found and restored from a backup taken before that pass.
- **Denied-but-not-deleted users** — admins use the **Deny** action instead of **Delete** for self-registered applicants who shouldn't be admitted; the row stays in `users` so a re-register attempt with the same email collides loudly.
- **Used invitations** (`invitations.used_at IS NOT NULL`) — kept for audit (who invited whom + when claimed).
- **Sent email reminders** (`email_reminders.sent=1`) — kept for audit.
- **JSONL log files** under `DATA_DIR/logs/` (`app-YYYY-MM-DD.jsonl`, `access-YYYY-MM-DD.jsonl`) — a new file per UTC day, kept indefinitely with disk to spare. The platform deletes log files on its own only under disk pressure: when free space falls below `LOG_MIN_FREE_MB` / `LOG_MIN_FREE_PCT`, it removes the oldest files first (never today's). With `LOG_DIR` set, the files are there instead. `scripts/purge.sh` purges the directory the server writes to: give it the server's `LOG_DIR` (after `sudo`, like `DATA_DIR`) and it purges that one, else `DATA_DIR/logs/`; set but empty, or not a directory, it stops with an error before deleting anything. `scripts/backup.sh` copies `DATA_DIR/logs/` only, so logs kept in a `LOG_DIR` outside `DATA_DIR` are not in the backup: copy them yourself if you need them.
- **Express session rows** in the `express_session` table (inside `hackathon.db` — there is no separate `sessions.db` file) — an in-process sweep runs every five minutes and deletes every row whose cookie has already expired (closing any impersonation window that expired with it), so this category needs no operator action — the `sessions` category of `scripts/purge.sh` is only a manual backstop.

That default suits compliance / audit needs but means a multi-year tenant accumulates data without bound. **Operators with retention policies must apply them explicitly.** The platform ships two helpers:

```bash
# DRY-RUN: shows what would be deleted, deletes nothing. DATA_DIR is required.
sudo DATA_DIR=/opt/hackarena/data scripts/purge.sh --days 365

# APPLY: actually deletes. --days threshold is operator policy.
# Categories default to `all`; pass specific categories to scope.
sudo DATA_DIR=/opt/hackarena/data scripts/purge.sh --apply --days 365 logs invitations email_reminders sessions
```

The script touches **only** rotation-friendly tables: the JSONL log files (in `LOG_DIR` when it is set, else `DATA_DIR/logs/`), `invitations` (used + old), `email_reminders` (sent + old), and expired `express_session` rows. It deliberately does NOT touch `users`, `submissions`, `hint_reveals`, `*_events`, or `attachments/` — those are the platform state and the audit trail. Use the existing admin endpoints (`DELETE /api/admin/participants/:id`, `DELETE /api/admin/competitions/:id`, `DELETE /api/admin/tasks/:id`) for a controlled cascade with audit attribution. Direct SQL `DELETE FROM users` bypasses the orphan-cascade handling and corrupts the audit chain.

**Audit-event retention (automatic).** Separately from `scripts/purge.sh`, the platform enforces a retention window on six tables: the five `*_events` tables (`competition_events`, `timeslot_events`, `user_events`, `settings_events`, `challenge_events`) and `orphan_events`, the copy of every orphaned audit event (deletions, exports, sign-in and sign-up records, whose subject has no history of its own) that the **Audit** page lists. A daily background job (`lib/event-retention.js`, started at boot, `unref`'d) deletes rows older than `EVENT_RETENTION_DAYS` (**default 730 = 2 years**), capped per run so a backlog drains over several days without holding the SQLite write lock. This is *why* those tables sit outside the `purge.sh` scope above — they self-expire. The motivation is the per-request PII (admin IP / user-agent) those rows carry. Inspect the configured window + the last purge at `GET /api/admin/retention` (any admin); a superadmin can force a pass immediately with `POST /api/admin/retention/purge` (e.g. after lowering the window). Set `EVENT_RETENTION_DAYS` to a larger value (e.g. `1825` for 5 years, or `36500` to retain effectively forever) or smaller per your policy; values below 1 (or unset/invalid) fall back to the 730 default — there is no "disable" sentinel, so use a large value to keep events long-term. Lowering it does not shorten how long a Checkmarx One account removal is tracked: those records are kept until the removal is resolved (step 4 of *GDPR-style "right to be forgotten"*). The same job, on windows of its own that `EVENT_RETENTION_DAYS` does not change, deletes soft-deleted event templates 30 days after their deletion, the certificate email's LinkedIn share links 30 days after they expired (capped per run like the tables) and stored images nothing references once they are seven days old (at most 500 per run; not while the database has failed its integrity or schema check or is in maintenance mode, when the summary says `images_held`), counted in the purge summary as `templates_purged`, `share_links_purged` and `images_purged`, apart from its `total`.

**Disk-quota log rotation (recommended cron).** For long-lived tenants where time-based retention isn't strict enough, `--max-mb N` deletes the oldest log files first until the logs directory (`LOG_DIR` when set, else `DATA_DIR/logs/`) drops under N megabytes. It never deletes a file carrying today's UTC date — the two files the server is writing to, so their in-flight lines are never lost — but on a day with no file for today the most recent file is deletable like any other. Cron pattern that's worked well in practice — `DATA_DIR` on the line, as for the backup cron above:

```cron
# Every 6 hours: cap DATA_DIR/logs/ at 2 GB by deleting oldest files first.
0 */6 * * *   DATA_DIR=/opt/hackarena/data /opt/hackarena/scripts/purge.sh --apply --max-mb 2048 logs
```

The age and size modes are mutually exclusive for the `logs` category — pick one based on operator policy:
- `--days N` if "we keep last N days, period" (compliance-shaped).
- `--max-mb N` if "we keep as much as fits in N MB, oldest gone first" (operator-quota-shaped).

**GDPR-style "right to be forgotten"**: there is no automated workflow today. Manual procedure:
1. Identify the user's UUID via `/api/admin/participants` search.
2. Trigger superadmin `DELETE /api/admin/participants/:id` — the cascade removes the user from `users` and, in the same transaction, from `user_events`, `user_tags`, `task_feedback`, `challenge_events`, `competition_user_absences`, `competition_users`, `submissions` and `hint_reveals`, removes their primary address from every staff team (`staff_team_members`, matched ignoring case; each removal recorded as a `staff_team_member_removed` with the team, the member row and the domain, never the address, and counted as `staff_team_memberships_removed` on the deletion record), and reclaims their uploaded avatar (also an older one a frozen team board still showed: the board's copy is struck and draws the default avatar, while the board keeps their nickname, see step 3; a picture another account or a challenge also uses is kept; a browser that already showed the photo may keep its copy for up to a day, and no shared proxy or CDN keeps one; a copy fetched before 9.2.18, when pictures were cacheable for a year, may last that long) and any badge image blob a certificate issued before the share image stopped being stored still names (no newer certificate stores one). The user's own history is therefore gone.
3. What survives is the user as the **actor** of somebody else's record: rows in `user_events`, `competition_events`, `timeslot_events`, `settings_events` and `task_versions` name whoever performed the action in `changed_by` (by email), and those stay, because the audit log records who did what. Step 2 clears `user_events` only where the deleted user is the *subject* — the rows recording what they did to somebody **else's** account hang off that other user and survive with the deleted user's email in `changed_by`, so `user_events` is in this list too. If the operator's policy requires removing those references too, purge them with SQL against those five tables — this is destructive and irreversible. Document the request and the timestamp before running. Two more traces sit in `task_versions.details` on a sealed-answer reveal (`change_type='sealed_reveal'`). If the deleted user was the **superadmin** who revealed while impersonating somebody, their email is in `details.impersonated_by` as well as in `changed_by` — purge both. If they were the account being **impersonated**, the row holds their **id** only (`acting_as_id`), which resolves to nothing once the account is gone (every reader's History then reads *an account that has since been deleted*); the matching `sealed_answer_revealed` line in `app-*.jsonl` carries their email until the application logs are rotated or purged. **A team board frozen at an event's end keeps the person's row**: the deletion strikes their picture from it (the row draws the default avatar), but their nickname and account id stay on it, and the event's participants still see the nickname on its team rankings. Whether the deletion should remove those too awaits an operator decision; until then, removing them means editing the `board` JSON in `group_leaderboard_snapshots` by hand (destructive; document it as above).

   **The record of the deletion itself keeps the person's address and nickname** (operator ruling, 15 Nov 2026). The `deleted` line, and the reaper's `account_reaped` for an unverified account it removes, are written after the cascade, so they survive it: in `orphan_events` (the store behind the **Audit** page, which every global admin reads) and in `app-*.jsonl`. They go when `EVENT_RETENTION_DAYS` passes (730 days by default), and every backup taken meanwhile holds them. To remove them at once, run `sqlite3 "$DATA_DIR/hackathon.db" "DELETE FROM orphan_events WHERE scope='user' AND scope_id='<the id from step 1>'"` (it also removes any other record of that account left there), then delete or purge the rotated log files (`scripts/purge.sh`).
4. **Checkmarx One: deleting a participant schedules removal of every account the platform CREATED for them; an account it found already there is the tenant administrator's.** The platform keeps a ledger of the realm accounts it made — recorded off its own create response, never an account it matched by name or address — and that ledger is deliberately outside the cascade: the delete stamps the participant's rows in the same transaction, and a background runner (right after the delete, then hourly) removes each account from the customer's realm once it has re-proved the account is the one the platform made. The realm's own creation time and username must match the record, and that check can never be overridden. A transient failure backs off (1 h, 2 h, 4 h … up to 24 h; a removal the tenant did not answer, or answered with a server error, is read again after one minute first) and stops only after 30 days **and** five attempts; the runner does nothing while the database has failed its integrity or schema check, or is in maintenance mode. Anything it will not remove on its own waits for a superadmin under **Settings → Checkmarx One account removals**, and a header banner says how many need a decision: an account the tenant has taken into use itself — linked to one of its own sign-in providers (a federation link or a federated identity; normal on a single-sign-on tenant), carrying an email address other than the one the platform created it with (compared by a sha256 fingerprint, the only form in which the ledger keeps that address; a row with no fingerprint, such as one recovered from history, skips only this check), a member of a group the platform could not have granted **in that tenant** (anything but the global default Checkmarx One group, when the global default key reaches that tenant, and each event's own group — or the default group, for an event with none — when the key the event provisions with reaches it; a group name configured for an event in a different tenant does not count, since in this tenant it is the customer's own group; the realm's own default groups ignored; a full page of groups holds too), given a role directly — a realm or client role set on the account itself in the tenant's sign-in (identity) settings, not through a group — beyond the one every new account gets and any it carried when the platform created it, or with that default role taken away (Checkmarx One Access Management assignments are not read), carrying a detail (a user attribute) only the tenant's administrator can set, or one the tenant will not say whether only its administrator can set (its language choice, details the tenant lets people fill in themselves, and anything it carried when created do not count), or given a password or sign-in method after the participant was deleted (or in the 15 minutes before, since the tenant's clock is compared with the platform's); the list row says which of these held it. An account whose owner is still on the platform passes to them before any of these signs is weighed, because a hand-over removes nothing and that participant's own deletion asks every question again. The participant's own use is not adoption: a password, sign-in factor or pending action the account already had, a disabled or locked account, a verified address. Also waiting: one whose address a participant still on the platform holds as a primary, secondary or pending address (re-checked weekly; the account is handed to that participant instead only when it is their verified primary address, their first and last names match the realm's record, and nobody else holds it — anything else holds, because a secondary or pending address is confirmed by nothing and names are free text), one found in the history rather than recorded when made or recorded by another installation (a restored or copied database), one whose realm record does not match, one the platform has no working key for (or whose key may not read or remove users, or may read the account but not its roles or sign-in credentials), one about to be removed whose roles the platform's key cannot prove it sees in full (a key that cannot view the tenant's clients; overridable, and never asked of an account handed to a participant instead), one named by a Checkmarx One set-up record of a participant still on the platform that cannot be read (it may be theirs, so it is neither removed nor handed to them on that record; overridable, and a readable record or link naming someone still hands it to them), and one whose participant is gone with nothing recording the deletion (never acted on). Each can be retried (on a row that was never scheduled the button is **Schedule removal**, behind a confirmation that the account will be removed from the tenant), removed anyway where the hold allows it (both confirmations say the account passes to its owner instead if one is still on the platform), or marked removed once it is gone in the tenant. **Remove anyway** overrules only the reason it was confirmed against (on the taken-into-use hold that means every sign of the tenant's use, the check that the key sees every role included): if the account has moved on to a different hold meanwhile (two superadmins on the list, the first approval sending it back to the runner, which then holds it for another reason), the stale confirmation is refused and the list shows the new reason, to be decided on afresh. The delete's toast, its response and the `deleted` audit line report four counts (the last three are counted from the person's set-up records, so one older than the retention period is no longer counted), each only when non-zero and never as ids: `cxone_withdrawals_scheduled` — the removals it scheduled; `cxone_accounts_left_in_place` — accounts that **already existed**, matched rather than created, which are never removed (that account and any group granted to it are the tenant administrator's); and `cxone_accounts_unrecorded` — accounts the platform **created but holds no record of** (made before the ledger existed, or by a create that never said which account it made), which it cannot identify in the realm and so cannot remove automatically: the toast says to remove them in the tenant by hand (to anyone else who may delete people, that a superadmin does); and `cxone_records_unreadable` — set-up records of theirs the platform cannot read (counted per record), so it cannot tell which account, if any, each names: the toast asks for the tenant to be checked for an account of theirs (to anyone else who may delete people, that a superadmin checks), and the `deleted` record keeps their address. A damaged record of an account the platform removed is not counted, so a damaged record makes the counts over-state rather than under-state. **The automatic removal of unverified accounts** (the hourly unverified-account reaper) removes a person's Checkmarx One accounts exactly as a delete does, through the same cascade and ledger stamp, and its `account_reaped` record (the **Audit** page) carries the same four counts; as no one reads a toast there, an account to remove by hand or a record that cannot be read also writes one warning line to the app log (counts and the account's local id only). **A set-up record older than `EVENT_RETENTION_DAYS`** (730 days by default) has been deleted by the daily event-retention purge (it is a `user_events` row), so a later delete can no longer count the matched or pre-ledger account it named; the ledger is never purged, so an account it holds is still removed. Projects and scans in the tenant are never touched. **What the ledger keeps**, until the account is removed, passes to a participant still on the platform, or a superadmin marks it removed, however long that takes: the realm account id, tenant and username (the tenant's own identifiers for the account), the deleted participant's local id and the event (local links), the ids of the roles and the names of the details the account carried when it was created (never a value, a name or an address), which sign held it while it is held as taken into use, and an unsalted sha256 fingerprint of the address the account was created with, which a dictionary can reverse and which, once the tenant has changed that account's address, is the only copy of the original left. None of it is deleted or stripped for its age: the record is the only way left to finish the erasure in the tenant, and each of those values guards a removal that cannot be undone. An entry whose removal was scheduled more than `EVENT_RETENTION_DAYS` ago says *kept past the retention period* under **Since**, is counted by the `hack_arena_cxone_withdrawals_past_retention` gauge, and is noted in the app log as `cxone_realm_withdrawal_past_retention` when it crosses the window; each process's first pass writes one `cxone_realm_withdrawals_past_retention` line with the count of those already past it instead. A provisioning job still **in flight** when the participant is deleted stops before its next remote call (so it grants no group from then on) and withdraws the account it had just created — unless that account has meanwhile passed to a participant still on the platform (typically someone who registered with the same address while the job was waiting on the tenant, whose own provisioning matched it), in which case it is left in place and the line says `realm_account_withdrawal_skipped` with the reason (`binding_unreadable` when a participant's set-up record naming it cannot be read: it then waits for a superadmin under **Checkmarx One account removals**); the check runs immediately before the removal, as the runner's does. Once a removal (the runner's or the job's) has started, a participant whose own set-up reaches that account is not linked to it: the set-up waits and tries again by itself (History: *not set up yet*), then gets a new account, or the old one if the tenant refused the removal. If its retries run out, History says so and assigning them to the event again tries once more. A link something else made to an account the platform then removed is cleared and that participant set up again (`cxone_binding_cleared`; the removal line then says `bindings_cleared`, and `taken_over_during_withdrawal` when the account's record had passed to them). If the realm refuses, the account is handed to the runner and retried, and its `cxone_provision_abandoned` line (an orphaned event: the app log and the **Audit** page, never the participant's History) says `withdrawal_retry_scheduled: true`. `realm_account_withdrawn: false` **without** that key means the platform could not record the account, and it must be removed in the tenant by hand. Accounts created from v8.8.15 on for participants still on the platform when this ledger arrived are recovered from their history at boot; each waits for one confirmation (**Remove anyway**), because the platform cannot prove this installation made it.

   **Participants deleted before the ledger existed (v8.12.7)** were never recorded, and their History went with them, so the realm account id survives only on their `cxone_provisioned` line in `app-*.jsonl` — until log retention purges it. The accounts the platform created for one such participant (not those it matched) are:

   ```bash
   jq -c 'select(.scope_id=="<user-id>" and .event_type=="cxone_provisioned" and .details.success == true and .details.already_existed == false and (.details | has("matched_by") | not)) | {ts, competition_id: .details.competition_id, cxone_user_id: .details.cxone_user_id, username: .details.username}' app-*.jsonl
   ```

   Remove those in the tenant by hand. An account created before v8.8.15 carries no id at all, and a `cxone_provision_abandoned` line from before v8.12.7 with `realm_account_withdrawn: false` names one the realm refused to withdraw.

### Dependency hygiene

`npm audit --omit=dev` should run clean against the lockfile — that is the set a production image installs (`npm ci --omit=dev`). Where a parent package pins a vulnerable dependency, `package.json` `overrides` moves it to a fixed release (`debug` under compression and express-session, `qs` under express and body-parser, and nodemon's `minimatch` ^11.0.3 for GHSA-g3hv-75wg-m249, a development-only dependency) or to a version without the vulnerable subtree (nodemon's file watcher `chokidar` 4, which does not pull in `braces` or `picomatch` 2, neither of which has a fixed release). The full `npm audit` can still report a development-only advisory with no patched release; `npm audit --omit=dev` is the check that matters for a deployment.

**Scanning the container image.** A container scanner (Trivy, Grype, Docker Scout) reports two populations an `npm audit` never sees: the base image's Alpine packages, and anything else the base bundles. The first is why every build pulls the base afresh and then applies Alpine's published fixes (see **Docker** under Deployment, below) — a stale cached base is the usual source of OS-package findings. The second used to be npm's own dependencies inside the image; the runtime stage now deletes npm. **Applying Alpine's fixes is itself a cached build step**, though: Docker re-runs it only when the base image's digest moves or the build cache is cleared, so an image rebuilt from a warm cache carries the Alpine packages of whichever build first ran that step — `docker image prune -a` removes images, not build cache, and `build.pull` only re-checks the base. A scan reports neither population for an image built WITHOUT the cache (the redeploy recipe under **Docker** clears it), except for a vulnerability Alpine has not yet shipped a fix for, which no rebuild can remove. If a scan shows an OS-package finding that has a fixed version, check what the image was built with (`docker run --rm --entrypoint sh hackarena:<version> -c 'node -v; cat /etc/alpine-release; apk info -v'`) and redeploy with the recipe under **Docker**, which rebuilds without the build cache (`--no-cache`). The platform pins all production deps in `package-lock.json`. Cadence:

- **At every patch bump**: `npm audit --omit=dev` should be part of the operator's pre-commit / pre-deploy check (the full `npm audit` can carry a development-only advisory, as above). The repo's CI doesn't currently gate on `npm audit` failures (low-noise enough not to break the merge gate); operators with their own deployment pipeline should add it.
- **Quarterly**: `npm outdated` + targeted `npm update` for non-major bumps. Major-version bumps (`better-sqlite3`, `express`, `express-session`, `bcrypt`) require a code review against breaking-change notes.

The runtime stack is intentionally narrow — these are the actual production dependencies, each with a distinct security-sensitive role; ship CVE notifications for them directly to your ops channel:

`better-sqlite3`, `express`, `express-session`, `express-session-better-sqlite3`, `csrf-sync`, `nodemailer`, `bcrypt`, `multer`, `sanitize-html`, `compression`, `uuid`, `yauzl`, `@resvg/resvg-js`, `esbuild`.

Three of them need an entry in `package.json` `allowScripts`: `bcrypt` and `better-sqlite3` load native binaries (each ships prebuilds and compiles only when none matches the platform), and `esbuild` fetches a platform binary via `postinstall`. Each entry's version must match the `package-lock.json` resolved version — a stale pin leaves that script uncovered and the Docker build warns; CI enforces the match. (`@resvg/resvg-js` also ships native code but declares **no** install hook — it resolves a prebuilt platform package — so it needs no entry. `better-sqlite3` is the opposite trap: reading its `scripts` field says "no install hook", but it ships a `binding.gyp` and npm *synthesises* an implicit `install: node-gyp rebuild` for any such package. **Verify against a real `npm ci`**, not against the package manifest.)

Note that some third-party code ships **vendored** under `public/vendor/` (e.g. `marked`, `highlight.js`, `qrcode`, ECharts) rather than as npm dependencies. Those are browser assets pinned by content hash and will **not** appear in `npm audit` / `npm outdated`; track their upstream advisories separately.

### Reverse-proxy configuration (`TRUST_PROXY`)

The `TRUST_PROXY` env var **must** match your deployment shape. It controls whether Express (and with it the rate limiter and every IP recorded in the audit event log) trusts the `X-Forwarded-For` header.

| Deployment | Set `TRUST_PROXY` to |
|---|---|
| App exposed directly to the internet (no proxy) | `false` (default) — otherwise any client can spoof `X-Forwarded-For` to bypass rate limits and poison audit-log IP attribution |
| Behind a single reverse proxy (nginx, Traefik, AWS ALB, one k8s ingress) | `1` |
| Behind multiple chained proxies (e.g. CDN → load balancer → ingress) | integer hop count matching the chain length |
| Behind Cloudflare or another trusted fleet with known egress IPs | comma-separated IP/CIDR list of those egress IPs |
| Only Docker host networking / localhost-only proxy | `loopback` |

Deploying the app behind a proxy with `TRUST_PROXY=false` makes every `req.ip` resolve to the proxy's IP — all rate limits become a shared bucket and every audit event reports the same IP. `TRUST_PROXY=true` is not "trust my proxy": it trusts **every** hop, so `req.ip` becomes the **leftmost** `X-Forwarded-For` entry, a value the client writes itself — whether the app is exposed directly OR sits behind a proxy that *appends* to that header, which nginx's `$proxy_add_x_forwarded_for`, an AWS ALB in its default mode and Cloudflare all do. A client that sends its own `X-Forwarded-For` then chooses its `req.ip`: the rate limits, the scanner block, `RATE_LIMIT_ALLOWLIST_IPS` and an event's **Trusted network IPs** (a spoofed venue address bypasses every limiter), and every audit IP. Use `true` only behind a proxy that *overwrites* the header; otherwise set the hop count. The server prints a warning at boot whenever `TRUST_PROXY` is `true` (in any case), saying exactly this. Pick explicitly; there is no safe default that works for every topology.

**Every ingress path must also send `X-Forwarded-Proto: https`.** Whenever secure cookies are on — which `NODE_ENV=production`, an `https://` `BASE_URL` or any non-false `TRUST_PROXY` each does on its own — express-session refuses to emit `Set-Cookie` for a request it does not consider secure. The app listens on `0.0.0.0`, so a direct hit on the port, a second ingress, or a proxy hop that drops the header all arrive as insecure: the browser then holds a CSRF token for a session it can never present, and every login fails with `csrf_invalid` until the tab is reloaded. `GET /api/csrf-token` answers `503 session_cookie_blocked`, naming the condition instead of handing out a token that cannot work.

**Count the hops.** `TRUST_PROXY=1` trusts exactly one, so `req.ip` comes from the last entry of `X-Forwarded-For`. Put a CDN or WAF in front of an existing nginx without raising the count and that entry becomes the *inner proxy's* address for every visitor — the whole population then shares one rate-limit bucket and one scanner-reputation counter, and a brand-new visitor can be refused on their first request. When `TRUST_PROXY` is a hop count, the server logs a warning (capped at one line a minute) when `X-Forwarded-For` carries more hops than it trusts, naming the resolved `req.ip` — it needs a number to count against, so `true`, a preset or an address list gets no such warning; `grep '"ip"' data/logs/access-*.jsonl` confirms it — if every request shows the same private address, the count is wrong. An organiser meets the same symptom in the app: **Use my current address**, beside an event's Trusted network IPs, then answers with a private or loopback address, adds nothing and says that `TRUST_PROXY` is probably wrong.

**Spell an IPv4 subnet in IPv4.** The app listens on IPv4, so every proxy it sees is an IPv4 address. An IPv4-mapped IPv6 subnet with a short prefix — `::ffff:10.0.0.0/8`, meant as "10/8", or `::/1` — trusts **no IPv4 peer at all**: every request then resolves to the proxy's own address and, with an `https://` `BASE_URL`, `GET /api/csrf-token` answers `503 session_cookie_blocked` because `X-Forwarded-Proto` is no longer believed. (Older builds read such a value as trusting *every* client, which let any direct caller choose its own `req.ip`.) Write the subnet as `10.0.0.0/8`, or as the full mapped form `::ffff:10.0.0.0/104`.

---

## Deployment

### Docker

```bash
docker-compose up --build
```

The included `docker-compose.yml` runs the app with:
- Persistent volumes for databases (`/opt/hackarena/data`) and uploads (`/opt/hackarena/uploads`)
- Dropped Linux capabilities and `no-new-privileges` for security
- Health check on `/readyz` every 30 seconds (see **Health vs readiness** below)
- Automatic restart (`unless-stopped`)
- **A fresh base image on every build** (`build.pull: true`). Each build fetches the current `node:<major>-alpine` rather than reusing whatever copy the host cached last time, so a rebuild picks up whatever Node and Alpine updates the official image has been rebuilt with, without anyone remembering `--pull`. A build therefore needs to reach Docker Hub.
- **Alpine's pending fixes applied at build time** (`apk upgrade` in the runtime stage). The official image is rebuilt periodically, and Alpine publishes package fixes in between; upgrading inside the base's own Alpine release picks those up too — **when the step runs**. It is an ordinary cached build layer, re-run only when the base image's digest moves or the build cache is cleared, which is why the redeploy below clears the cache.
- **A code tree the app cannot write.** `/app` and everything the app runs (`server.js`, `lib/`, `routes/`, `public/`, `docs/`, `node_modules/`) belong to root; the `node` user the container runs as owns only `/app/data` (`DATA_DIR`) and `/app/uploads` (`UPLOADS_DIR`), the only paths the app writes. A compromised process cannot rewrite a route or a served script, and a hand-applied hot-patch through `docker exec` no longer works either. File modes are set in the build stage, so a checkout made under a restrictive umask still builds a readable image.

**The runtime image carries no npm.** npm, npx (and corepack or Yarn, should a future base bundle them) are deleted from the final stage: the app starts with `node server.js`, the health check uses `node`, and every dependency was installed in the build stage. A container scanner otherwise reports advisories in npm's own bundled dependencies against the image even though nothing runs them. The consequence for an operator: `docker exec hackarena npm …` does not work — run maintenance scripts from a checkout on the host, as the backup and purge scripts already are.

**Nor what its native modules were built from.** The build stage keeps its toolchain (`python3`, `make`, `g++`), because npm's install scripts may need it, and only the result is copied across. Before the copy, `scripts/prune-runtime-deps.cjs` loads each native module the way the app does (`better-sqlite3`, `bcrypt`, `@resvg/resvg-js`, `esbuild`), keeps exactly the binaries that load, and deletes what was only ever input to a build: SQLite's C amalgamation, the C++ sources, `binding.gyp` files and Makefiles, the compile-only `node-addon-api`, gyp's intermediate output and the prebuilt binaries for other platforms. That is about 25 MB, nearly half of `node_modules`. Node's own C headers (`/usr/local/include/node`) go with npm. The final stage then refuses to finish if a compiler, `make`, Python, `node-gyp` or npm is on its PATH, if a C or C++ source, header, gyp file or Makefile is left under `node_modules`, or if `/app/scripts` or those headers are present. The script belongs to the build: without `--apply` it only reports, and with it it refuses a `node_modules` that is a symlink or sits beside a `.git` — so it cannot be pointed at a checkout by mistake.

**Point `DATA_DIR`, `UPLOADS_DIR` and `LOG_DIR` at the volumes.** Because the code tree is root's, a path elsewhere under `/app` is not writable by the container's user: a `DATA_DIR` there, or an `UPLOADS_DIR` that does not already exist, stops the boot with `EACCES` (the upload handler creates its directory while the server loads); an `UPLOADS_DIR` that already exists but is root's fails each upload; and a `LOG_DIR` there loses file logging, with one warning per log file (app, access) on stderr at its first write and again after each UTC-day rotation, and nothing in between. The defaults — `/app/data`, `/app/uploads` and `DATA_DIR/logs` — are all fine, as is any other mount the `node` user (uid 1000) can write. A fresh named volume inherits `node:node` from the image's directory; a bind mount keeps the host's ownership, as before.

A typical redeploy. It builds the new image while the old container keeps serving, then swaps:

```bash
git pull
sudo docker compose build --pull --no-cache   # a fresh base, every step re-run (apk upgrade included); a failure here stops nothing
sudo docker compose up -d --no-build          # replaces the running container with the image just built
sudo docker image prune -f -a                 # LAST: before `up` it would delete the image just built
sudo docker builder prune -f                  # optional: reclaims the old image's build layers
```

**Back up first when the new image is 9.2.17 or later and the running one is older:** its first start deletes every stored picture nothing in the app uses that is older than a week, up to 500 a pass (see *Data retention & privacy*).

`build.pull: true` re-checks the base on every build, but **neither it nor `image prune -a` touches the build cache**, and that is what `--no-cache` is for: the runtime stage's `apk upgrade` is an ordinary cached layer whose key is the base image's digest plus the instruction, so on an unchanged `node:<major>-alpine` digest every rebuild would reuse the FIRST build's upgrade and ship its Alpine packages for as long as the base stays put. `--no-cache` re-runs it and every other step, without touching other projects' cache on a shared host. The trailing `builder prune` only reclaims disk: a plain prune skips any layer an existing image still uses, so it reaches the old image's layers only after `image prune` has removed that image. `up -d --no-build` starts the image just built (a Compose whose `up --help` says `--no-build` applies "even if it's policy"; an older one rebuilds under `pull_policy: build`, from the cache the build just wrote).

**A failed build stops nothing.** A build without the cache re-runs the build stage too (the toolchain and `npm ci`, about half a minute) and needs Docker Hub, Alpine's package mirror and the npm registry reachable. An outage of any of them fails the `build` line while the old container keeps serving; run the recipe again once it ends. Building first costs a short restart gap at `up` (the old container's shutdown, normally well under a second and at most Compose's 10-second stop timeout, then the new one's boot) and disk for two images at once.

**The build also fails closed.** If a dependency update changes which binary a native module loads, or a package ships a native binary or a C source the prune has no rule for, the build stops and names the package rather than ship an image that cannot start or still carries build residue. That refusal is the point, and with the build first it leaves the old version serving. The redeploy does not, by itself, boot the new image before the swap, so when `package-lock.json`, the `Dockerfile` or `scripts/prune-runtime-deps.cjs` changes, build the image and boot a check container from it — scratch `DATA_DIR`/`UPLOADS_DIR` volumes and `BASE_URL`/`SMTP_HOST` set, waiting for `/readyz` (the release-image workflow's boot step is the recipe) — before swapping. No CI job builds the image.

**When the build stops at `apk add`.** `node:<major>-alpine` follows the newest Alpine branch, and the build stage pins its toolchain (python3, make and g++) to one branch's versions with `~=`, which keeps a scanner's "unpinned package" finding closed. When the base moves to a branch with a new python3, make or g++, the build fails at that line (`unable to select packages: … breaks: world[python3~3.14]`) and the old container keeps serving. Read the new versions with `sudo docker run --rm node:<major>-alpine sh -c 'cat /etc/alpine-release; apk update -q && apk policy python3 make g++'`, set the `~=` versions on the Dockerfile's `apk add` line (and in its comment) to the new major.minor, and redeploy. Do not drop the pin.

Create a `.env` file. The minimum the server actually requires to start is `BASE_URL` AND `SMTP_HOST` (the process exits at startup without `SMTP_HOST`). For a real deployment behind a reverse proxy, add `TRUST_PROXY=1` so rate-limit and audit-log IPs aren't all the proxy's address. SMTP credentials and `EMAIL_FROM` are technically optional (an unauthenticated SMTP capture server will accept the connection without them) but a real outbound transport will need them — and `EMAIL_FROM` should name an address on a domain you control, since it is the identity SPF is checked against and the address bounces return to:

```env
BASE_URL=https://hack.example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=...
EMAIL_FROM=no-reply@hack.example.com
TRUST_PROXY=1
```

### Health vs readiness — wire your load balancer to `/readyz`

Two probes, deliberately different:

| Endpoint | Meaning | Use it for |
|---|---|---|
| `GET /healthz` | **Liveness** — the process is up. Returns 200 even when the database fails its boot integrity check, on purpose, so an operator can still reach the box and triage. | Container restart policies, "is the process wedged" checks. |
| `GET /readyz` | **Readiness** — this instance should receive user traffic. Returns **503** when the boot `PRAGMA integrity_check` failed (`db_integrity`), a migration did not apply so the schema is incomplete (`db_schema`), maintenance mode is engaged (`maintenance`), or the database is unreadable (`db_unavailable`). | **Load-balancer / target-group health checks**, k8s `readinessProbe`. |

Both the image's `HEALTHCHECK` and `docker-compose.yml` probe `/readyz`.

**`db_schema` — an upgrade that half-applied.** Most schema migrations log their failure and let the process continue, which is right when the loss costs one feature and wrong when a write path names the column: a swallowed `ALTER` can leave submissions or sign-in returning 500 on every request while the instance looks perfectly healthy. At boot the server now checks the live schema against the manifest in `lib/schema-required.js` — every column an `ALTER` adds, and every unique index — and drains the instance if anything is missing. The process deliberately keeps running so you can still log in and triage. **The boot log names every missing column and index**; the probe response does not, because it is unauthenticated. Look for the earlier `migration failed` line, fix the cause, and restart.

**If you terminate traffic at a load balancer, point ITS health check at `/readyz` too.** Docker/compose health status is local to the host — an AWS ALB, GCP backend service or k8s Service does **not** read it, so an instance can be marked unhealthy by Docker while the load balancer keeps sending it users. Concretely, for an AWS target group:

```
Health check protocol : HTTP
Health check path     : /readyz
Success codes         : 200
```

k8s equivalent:

```yaml
livenessProbe:  { httpGet: { path: /healthz, port: 3000 } }
readinessProbe: { httpGet: { path: /readyz,  port: 3000 } }
```

Using `/healthz` (or the SPA shell) for the load balancer is the failure this table exists to prevent: it keeps a known-corrupt database in rotation.

### Manual Deployment

The app **does not auto-load `.env`** — every variable below has to be on the process environment when `node server.js` starts, or the process will exit (`BASE_URL`, `SMTP_HOST`, `DATA_DIR` and `UPLOADS_DIR` are all required at startup; the container image sets `DATA_DIR` and `UPLOADS_DIR` itself) or run with insecure defaults (`TRUST_PROXY=false` behind a proxy = spoofable rate limits + audit IPs). The `docker-compose.yml` shipped in this repo loads them through `env_file:`; for a manual deploy the equivalent is exporting them explicitly:

```bash
npm ci --omit=dev
export NODE_ENV=production
export BASE_URL=https://hack.example.com
export SMTP_HOST=smtp.example.com
export SMTP_PORT=587 SMTP_USER=apikey SMTP_PASS='…'
export EMAIL_FROM='no-reply@hack.example.com'
export TRUST_PROXY=1            # see "Reverse-proxy configuration" above
export DATA_DIR=/opt/hackarena/data   # REQUIRED — no default (v8.8.26)
export UPLOADS_DIR=/opt/hackarena/uploads   # REQUIRED — no default (v8.8.27)
node server.js
```

Place behind a reverse proxy (nginx, Caddy) for HTTPS termination. The app listens on `0.0.0.0:3000` by default. Docker Compose is the recommended deployment mode — it loads `.env` for you and applies the security capabilities the manual command does not.

### Production Checklist

- [ ] Set `BASE_URL` to your public HTTPS URL
- [ ] Set `NODE_ENV=production` (enables secure cookies)
- [ ] Configure SMTP for email delivery
- [ ] Set up HTTPS via reverse proxy
- [ ] Note the superadmin password from the startup log

### Run as a single process — do not horizontally scale

Hack Arena is designed to run as **exactly one Node.js process** per data
volume. Do not put it behind a round-robin load balancer, do not run it
under `pm2 -i N` cluster mode, do not deploy two replicas of the same
Docker image pointing at the same `./data`. One process, one volume.

Why: the server keeps several pieces of state in process memory instead of
shared storage, because a single process serving a few hundred participants
is vastly simpler than the alternative. Splitting traffic across processes
would produce subtle-but-wrong behaviour in every one of these:

| In-memory state | What breaks if it's split across processes |
|---|---|
| Leaderboard cache (5 s TTL, per competition/timeslot) | Stale rows on one replica while another replica already sees the new submission |
| Rate-limit token buckets (`_rateLimitBuckets`) | Attacker sees N× the allowed rate by hashing across replicas; the 10-failed-logins superadmin-password regeneration threshold never trips |
| "Logged in elsewhere" kick context (`_kickedSessions`, `lib/sessions.js`) | A user kicked by a login on replica A gets no explanation for it on replica B. (Single-session enforcement itself is durable — sessions live in the `express_session` table and revocation tombstones in `revoked_sessions` — so that one guarantee would survive.) |
| Scanner reputation map (`_scannerIpRep`) | Probe-detection signal spreads thin; scanners are never classified |
| Analytics response cache (`_analyticsCache`) | Different tabs of the admin dashboard return contradictory numbers |
| Content-hash maps (`_assetVersions`, `_htmlCache`, `_mdCache`) | Each process computes its own hashes at startup — URLs written by replica A won't 200 on replica B, breaking every cached browser tab |
| `_competitionCache` | Admin edits to an event invalidate one replica's cache, not the other |
| Focus-trap / overlay handlers | (Client-side only — unaffected by server replication.) |
| `_testRateLimitForceEnabled` runtime flag | Tests toggling this flag via `POST /api/test/rate-limit-toggle` toggle only one replica. |

SQLite itself (WAL mode) can technically tolerate multiple readers and a
single writer, so the DB layer wouldn't catastrophically corrupt — but
every one of the caches above would go stale-inconsistent, which is worse
than a crash because participants and admins silently see wrong data.

**What to do instead of scaling horizontally:**

- **Vertical scaling works well.** One process on a 4–8 core VM easily
  serves 500+ concurrent participants. The hot-path work (bcrypt, SQLite
  writes) is parallel-friendly, native bcrypt running off the event loop.
- **High availability** is a failover pattern, not an active-active
  pattern — one process at a time, switch to a hot standby on failure,
  replicate the `./data` volume with block-level replication (e.g. DRBD)
  or just use a scheduled `sqlite3 .backup` to a sibling host.
- **If you outgrow one process**, the externalisations are: move the
  session store off the `express_session` table to Redis (drop-in via
  `connect-redis`), move rate-limit and session-tracking state to the
  same Redis, move the cache layer to memcached/Redis, and re-issue
  asset hashes from a shared source (or bake them into the build). That
  work is not done and would land outside `server.js`; treat it as a
  deliberate rewrite rather than a config toggle.

---

## Operations

### First-Time Setup

After the server starts for the first time, walk through this sequence:

1. **Sign in as the built-in superadmin.** The password is printed to the startup log (see the banner in Quick Start above) and is also at `DATA_DIR/.superadmin-password` (mode `0o600`). On the ordinary sign-in card, type the break-glass username `superadmin` (until it is changed in Settings → Sign-in → Break-glass account) into the email box, press **Continue**, and enter that password in the box that appears. This account has no emailed-code door, so it is the way in while mail does not work. Forgotten a changed username? Whoever runs the server can read it from the database with any SQLite client: `SELECT value FROM settings WHERE key='breakglass_username';` on `DATA_DIR/hackathon.db`. Deleting that row (`DELETE FROM settings WHERE key='breakglass_username';`) puts it back to `superadmin`. The name is read at every sign-in, so no restart is needed.
2. **Name the platform.** Open **Settings → Branding → Platform name** (superadmin only) and set the public-facing event name. It appears in the header, in-app help, every email subject line, and as the **sender name** on all outbound email — the address itself is the mail server's sender address (`EMAIL_FROM`, or the one saved in **Settings → Email (SMTP)**). A rename takes effect on the next send; no restart.
3. **Verify SMTP.** In another browser, type a throwaway **work** address (a free-mail address is sent nothing) into the sign-in card, press **Continue**, and confirm the emailed code actually arrives. If SMTP is misconfigured, the server log shows the `nodemailer` error; the platform keeps running (all email flows become best-effort) until you fix the config.
4. **Create the first event.** **Events → + New Event**. The **New event** page offers a blank start per **event type** — *Booth Event*, *Competition* or *Program* — or a template; the type decides how it runs, is the form's first field and **can be changed until the event starts**, after which it is fixed. The form shows only the settings that type uses. For a *Competition*, pick a start time, duration and leaderboard mode (*Global* or *Per Session*); for multi-timezone events, toggle to **Multiple Sessions** and add one timeslot per region.
5. **Create challenges.** **Question bank → + New question** for each task (or **+ New question** inside an event, for a question that belongs to that event). Start them as `draft` if you want to review before participants can see them.
6. **Add questions to events.** Inside the event, **Questions → + Add from bank**; or on the **Question bank**, tick questions and press **Add to events** on the selection bar.
7. **Invite participants.** **Participants → Invite** (email addresses, one per line or comma-separated). Invitees receive a registration link pre-associated with the event and are auto-approved on registration (unless **Require admin approval for new accounts** is on and whoever made the invitation cannot approve accounts when it is used, a custom role without that permission or an inviter who has since lost it or whose account is gone, blocked or denied: they then wait for an administrator's approval; an invitation sent again to the same address by someone who may approve becomes theirs). Alternatively, let participants self-register and bulk-approve them.
8. **Run a dry-run.** Tag one event with `test/dry run` (a boot migration rewrites the older `internal` spelling on databases that still carry it) so it's visually dimmed, excluded from analytics by default, and cannot mint achievement badges. Do a full login → solve-one-challenge → leaderboard pass through a test account before opening registration to the real audience.

### Moving to a new server

`scripts/migrate.sh` runs the whole move with its checks built in. Keep the same public address if you can: issued certificates, sent unsubscribe links and the Checkmarx One account clean-up all name it. Everyone signs in again afterwards, and `uploads/` is not copied, because it only holds files in transit.

```bash
# On the old server, with the app stopped (needs sqlite3 and rsync).
sudo DATA_DIR=/opt/hackarena/data scripts/migrate.sh pack /tmp/arena-move.tar.gz

# Copy the archive and its .sha256 to the new server, then, before the app's first boot:
sudo DATA_DIR=/opt/hackarena/data scripts/migrate.sh unpack /tmp/arena-move.tar.gz

docker compose up -d --build
scripts/migrate.sh check http://127.0.0.1:3000
```

A copy made only to try something (a staging or restore drill) must not mail real people: give its data directory a `.maintenance` file before its first boot, and no certificate, event-team report or start reminder is sent from it while the file is there (and run `scripts/restore-mail.sh mark-sent` on it before lifting maintenance, so nothing that ended before the copy is mailed from it then).

`unpack` refuses a directory holding anything, a damaged copy and an unfinished backup, and deletes nothing. Run as root, it hands the restored data to the owner it can name, and prints which: `MIGRATE_OWNER=<uid>:<gid>` (or `<user>:<group>`) if you set it after `sudo`, refused before anything is written when it is malformed or names a user or group this server does not have; else the owner of a data directory you created, empty, before the unpack (not root); else the owner the backup recorded on the old server; else `1000:1000`, the shipped image's user. The archive holds the database and both HMAC secrets, so treat it like the live data and delete it when you are done. The first boot upgrades the database and that only moves forward, so the old server's copy is your way back. Never start it while the new server runs: both would send certificates, event-team reports and start reminders. To go back to it, give its data directory a `.maintenance` file before starting it, and run `sudo DATA_DIR=<old data dir> scripts/restore-mail.sh mark-sent` with it stopped. Otherwise every event that ended since the pack ends again there, and its participants and teams are mailed again, with new certificate codes.

### Backup & Restore

The platform stores all state in a single host volume (`./data/` for a bare-metal install, `/opt/hackarena/data/` for the bundled docker-compose). **Do not `cp` the DB files while the server is running** — you'll catch an in-flight write and get a torn copy.

> **Prefer `scripts/backup.sh`** (see *Backup & disaster recovery* above). It takes the online snapshot, copies the attachments, staging, logs and both HMAC secrets, checks the attachment files against the snapshot, and writes a `RESTORE.txt` next to them. Of the two manual procedures below, only Option A (server stopped) is a complete backup; Option B is the database alone.

**Option A — offline (simplest).** Stop the container/process, copy the directory, start it back up. Downtime equals copy time.

```bash
# With docker-compose. Write the tarball OUTSIDE the checkout (here /backup, as in
# Option B): it holds the live database and both HMAC secrets, and the checkout is
# what gets built and committed.
docker compose down
tar czf /backup/hackarena-backup-$(date -u +%Y%m%dT%H%M%SZ).tgz -C /opt/hackarena data uploads
docker compose up -d
```

Stopping first is what makes this safe: a clean shutdown checkpoints the WAL and removes `hackathon.db-wal` / `hackathon.db-shm`, so the tar holds a self-contained database. **Untarring it back over a directory that still has those files does not** — clear them first, exactly as in the restore block below.

**Option B — online, database only (`sqlite3 .backup`).** Use the SQLite online-backup API to snapshot the DB without stopping the server. The snapshot is fully checkpointed, so it carries no WAL of its own. It does **not** capture the attachment files: a copy of `attachments/` made by hand while the server runs can miss files the snapshot names (a challenge deleted between the two), and nothing checks it. For a backup that includes the attachments, the staging uploads and the HMAC secrets, use `scripts/backup.sh` or Option A.

```bash
# Run from the host (outside the container), against the live DB file.
# hackathon.db contains the session store (the express_session table), so this
# single snapshot covers sessions too — there is no separate sessions.db file.
sqlite3 /opt/hackarena/data/hackathon.db ".backup '/backup/hackathon-$(date -u +%Y%m%dT%H%M%SZ).db'"
```

The daily JSONL log files under `DATA_DIR/logs/` are already rotated and content-complete — back them up on your normal log-retention schedule; they're not required for platform state.

**Restore** — stop the server, **delete any stale `hackathon.db-wal` / `hackathon.db-shm`**, drop the snapshot back into `DATA_DIR/`, put the platform in maintenance mode (certificate, event-team and start-reminder email waits while it is on), then start the server, check it, and remove `.maintenance`. Attachment files the snapshot names that were deleted since it was taken stay missing, and the first start deletes every attachment file the snapshot does not name (those uploaded after it). The superadmin password and session secret are regenerated on the next startup — everyone (including the operator) needs to log in again.

```bash
docker compose down
printf '%s' 'choose-a-bypass-token' > /opt/hackarena/data/.maintenance   # certificate, team-report and start-reminder mail waits until you remove it
# STEP THAT IS NOT OPTIONAL — see the warning below.
rm -f /opt/hackarena/data/hackathon.db-wal /opt/hackarena/data/hackathon.db-shm
cp /backup/hackathon-<timestamp>.db /opt/hackarena/data/hackathon.db
sudo DATA_DIR=/opt/hackarena/data scripts/restore-mail.sh mark-sent   # or: resend (see the restore steps above)
docker compose up -d
```

> **Why the `rm -f` of the WAL files is load-bearing.** A `.backup` snapshot is fully checkpointed and carries no write-ahead log of its own. Copy it over a data directory that still holds the **old** `-wal` / `-shm` and SQLite replays those stale frames on top of the database you just restored: the writes you were rolling back come straight back, and `PRAGMA integrity_check` still reports `ok`, so nothing tells you the restore did not take. Measured on this schema — a snapshot containing **1** row restored to **201** rows, integrity `ok`.
>
> A clean shutdown checkpoints and removes both files, so this never shows up in a rehearsal that stops the server politely. It shows up after a `kill -9`, an OOM, a power loss, or the 20-second shutdown watchdog firing — which is precisely the situation you restore from. The `scripts/backup.sh` path below is safer by construction (`rsync --delete` removes them for you) and every backup it writes ships a `RESTORE.txt` with this sequence.

**Drill cadence.** Backups that have never been test-restored are aspirational. A lightweight schedule we recommend:

- **Daily automated** — `scripts/backup.sh` from whatever cron / systemd-timer / Kubernetes CronJob your host platform uses, into a rolling retention directory (the cron line under *Backup & disaster recovery*). Check syslog for `hackarena-backup` lines every day: a failed run logs there, and so does a run that found attachment files missing from the live volume itself, which only an earlier backup still holds, until retention deletes it.
- **Monthly restore drill** — pick the latest nightly snapshot, check its `BACKUP_COMPLETE` reads `attachments_lost_on_live_volume: 0`, restore into a throwaway staging volume held in maintenance and marked sent (see *Moving to a new server*: a drill copy must not mail real people), log in, sample-read a few competitions/participants, run `npm test` against the restored DB. ~15 minutes of operator time; catches silent backup corruption before a real incident does.
- **Pre-event** — run one restore drill the week before every live event. Even if the monthly drill is green, a freshly-populated event DB is when corruption-via-write-pattern would first manifest.
- **Post-event** — snapshot before `DELETE FROM competitions` or participant purges. Recovering an event after accidental deletion is only possible if that snapshot exists.

### Upgrading

Version bumps rewrite `version.json`, `package.json`, `docker-compose.yml`'s `image:` tag, and `swagger.yaml`'s `info.version` together via `npm run bump` (one after another, not atomically — `npm run check-version` catches a run that stopped half way). After the bump, rebuild and restart — the in-process scheduler, session store, and leaderboard cache all reinitialise cleanly. Take a backup first (`scripts/backup.sh`), and always when upgrading to 9.2.17 or later from an older version: its first start deletes every stored picture nothing in the app uses that is older than a week (up to 500 a pass).

```bash
npm run bump patch           # or minor / major / X.Y.Z
docker compose up -d --build # pulls the current base image too (build.pull: true)
```

That rebuild reuses Docker's build cache, including the runtime stage's `apk upgrade` layer while the base image's digest has not moved. When the point of the rebuild is to pick up Alpine's fixes, build without the cache instead: `sudo docker compose build --no-cache && sudo docker compose up -d --no-build`. A `docker builder prune -f` does NOT do it here — the running container's image still uses that layer, and a plain prune skips any layer an image still uses. The redeploy recipe under **Docker** builds with `--no-cache` for the same reason.

**v9.1.5: what an upgrade keeps.** Nothing needs doing by hand; the first boot decides each of these once.

- **The approval queue survives an upgrade from 8.14 or earlier** (operator ruling, 15 Nov 2026). 8.14 held every plain sign-up for approval; since 9.1.1 an emailed code approves an account unless **Require admin approval for new accounts** is on. A database coming straight from 8.14 or earlier boots with that switch on (recorded in the settings history as changed by `system`), so nobody already waiting gets in and new sign-ups still wait; a superadmin turns it off in Settings. A site that came from 8.14 to 9.1.1–9.1.4 started with the switch off: anyone then waiting was approved by their next emailed code. Check the switch, and the accounts approved by an emailed code since that upgrade.
- **Finished Booth Events keep their late entrants.** An event that ended before the installation took the current late-entry rule (a late entrant joined strictly after the end; before, joining in the last ten minutes counted too) keeps the old rule when its board is read, so an upgrade never changes a final board. The moment is recorded once, as `late_entry_rule_floor_at`: an installation already on 9.1.1+ takes the date it first ran 9.1.1, one coming from 8.14 its first boot of this release.
- **A custom role scoped to its events loses the permissions that reach beyond them.** Creating events from scratch, adding and removing organisers, event templates, certificate designs, platform settings, metrics, data retention, test email and the unsubscribe list, the settings export, imports, deleting accounts and Users & roles now need a role that acts on every event, as the raw logs, the every-event export and the alerts already did. The first boot removes those grants from such roles, recording each change in the settings history as a `role_updated` by `system`; give them to a role of every event instead. Everything else such a role holds now works on its own events only.

**v9.0.0: every account signs in with a password or an emailed code.** Nothing needs migrating by hand; the database gains one column at the first boot. Check that mail works before the upgrade reaches an event (Settings → Email (SMTP) → **Send test email**): participants and event admins sign in only with an emailed code. What changes for the people who sign in:

- **Admins and superadmins sign in with a password by default** (so does any custom role not scoped to events); participants and event admins keep emailed codes. Each person can change theirs under **Profile → How you sign in** (operator ruling, 11 Nov 2026).
- **A password set on 8.14.x or earlier works again** for an account whose method is password, which by default is every such admin. A participant who set one then keeps it too, and can use it again by choosing **My password** there; nothing new is needed.
- **An admin with no password yet** gets the password box with a note on the sign-in card: they choose **Email me a code instead**, and after signing in are asked to set a password or to keep using emailed codes. Every account can always choose **Email me a code instead**, so a forgotten password never shuts anybody out.
- **`/break-glass` is gone** (it answers 404), and there is no other special sign-in address. The built-in superadmin signs in on the ordinary card: type its break-glass username (default `superadmin`) into the email box, press **Continue**, enter the password. Update any bookmark or runbook that names `/break-glass`.
- **LinkedIn sign-in and sign-up are gone.** Accounts it created sign in with an emailed code like any other. No `LINKEDIN_*` variable is read any more: remove them from the environment and retire the LinkedIn app's sign-in redirect. Sharing a certificate to LinkedIn is unaffected.
- **The old password routes are gone** and answer 404: `/api/forgot-password`, `/api/reset-password`, `/api/change-password`, `/api/set-password`, `/api/auth/linkedin` and its `/callback`. A forgotten password is recovered with **Email me a code instead**, and a password is set or changed under **Profile → How you sign in**. Update any script or runbook that calls them.
- **A secondary address no longer signs in.** Codes and passwords work only with the account's primary address; an invitation or an **Add user** for an address that someone holds only as a secondary is refused. Anyone who signed in with their second address uses their primary one.
- **Require admin approval for new accounts**: a database coming from 8.14 or earlier keeps its approval queue from 9.1.5 on (see **v9.1.5** above); 9.1.1–9.1.4 started with the switch off.
- **Address proofs have a per-IP budget**, `RATE_LIMIT_PROOF_IP_PER_15MIN` (default 150 per 15 minutes): past it, an address no account holds is sent no sign-up code from that IP until the window passes, while the screen answers as usual. Sign-in codes to existing accounts are unaffected. Put a venue whose walk-ups sign up from one address on the event's trusted networks, which bypass it.

**v8.14.0: `scripts/backup.sh` checks the attachment files against the database it snapshots.** Exit 1 now also means attachments were still being uploaded and deleted after its last snapshot: run it again. If the live volume has already lost attachment files its database still names, every run now prints a `WARNING`, writes it to syslog under `hackarena-backup` and records `attachments_lost_on_live_volume: N` in `BACKUP_COMPLETE`, with the files listed in `BACKUP_METADATA.txt`; the backup still completes, because a restore brings back the same gap rather than a new one. Copy those files back from a backup that still holds them (`BACKUP_METADATA.txt` marks the ones this backup holds; see *Backup & disaster recovery*).

**v8.14.0: `scripts/purge.sh` stops with exit 1 when it cannot count a category's rows.** It now ignores `~/.sqliterc` (root's, under `sudo`), which could make `--apply` delete nothing and still print `Purge complete.`, and a count it cannot read, which for `sessions` used to pass as zero rows, ends the run with an `ERROR`.

**v8.13.4: `scripts/backup.sh` and `scripts/purge.sh` refuse to run without `DATA_DIR`.** Before it they guessed `<repo>/data`, so a bare `/opt/hackarena/scripts/backup.sh` used to work and now exits 1. Add `DATA_DIR=/opt/hackarena/data` to every crontab line, systemd timer and wrapper that runs either script (after `sudo`, not before) — cron gives no other sign that the backups stopped.

Clients see a "Server restarted" dialog — the session secret is regenerated, so old cookies are invalid — and are redirected to the login page. It fires on whichever comes first: the next `/api/session/status` poll, or the first request of any kind that 401s (in practice the latter, since the SPA's other polls are faster than the 30-second session poll). Schedule upgrades during a maintenance window if an event is live.

### SMTP Outage Handling

A mail server is required at startup (the process exits if neither `SMTP_HOST` nor a mail server saved in Settings names one), but once the server is up, SMTP failures are handled gracefully:

- Sign-in-code / verification / approval / invitation / reminder emails go through `nodemailer` with delivery-failure logged at `error` level.
- Failed email deliveries never roll back the underlying state change (account created, code minted, reminder scheduled). Where a single message was attempted the response carries an `emailDelivered` boolean; the bulk assign / approve / invite paths report `emailsSent` / `emailFailures` / `undeliveredInvites`, plus `emailsDeferred` when the fan-out was still sending as the response went out.
- **A primary-email change is staged, never applied on save — from either door.** Whoever asks for it (the participant via their profile, or an admin via Edit Profile), the new address goes into a pending slot with a single-use 48-hour link sent to it; the live address, the verified state and the session stay active until the link is opened. So an undeliverable confirmation costs nothing and simply expires. Before v8.3.36 the *admin* door instead wrote the address immediately, cleared `verified`, and compensated with a 503 if the mail failed — which could sign the participant out and drop them off the leaderboard in a window the compensation could not undo.
- **While mail is down nobody can sign in with an emailed code.** An account that signs in with a password it has set — by default every admin and superadmin who has set one — is unaffected; an admin who has not set a password yet still needs a code. For a participant at a desk who has never signed in use **Show sign-in code** on their row (it hands you the code on your own screen, no email); after a first sign-in the desk can only email a code. For the platform itself, sign in as the built-in superadmin: its break-glass username and the password from `DATA_DIR/.superadmin-password`, typed on the ordinary sign-in card. When SMTP is back, people simply ask for a new code.

### Rotating the Superadmin Password

The built-in superadmin password is auto-generated on every startup and logged to `DATA_DIR/.superadmin-password` (mode `0o600`). It is also regenerated automatically after **10 consecutive failed sign-ins to the break-glass account, counted globally,** within a 15-minute sliding window (global rather than per-IP, so a distributed brute force can't stay under a per-IP threshold and never trip rotation). A 10-minute global cooldown caps rotations at six per hour — during the cooldown, threshold-breaching attempts are logged as `rotation_suppressed` but no new password is issued. Manual rotation = restart the process (`docker compose restart hackarena`); the new password appears in the startup log and the file. There is no in-app "change superadmin password" action by design — the built-in account is an operator recovery credential, not a user account.

### Maintenance Mode

Drop a file named `.maintenance` into `DATA_DIR/` with a bypass token as its content. Visitors see a static 503 "Scheduled Maintenance" page; requests carrying `X-Maintenance-Bypass: <token>` pass through. Used during performance tests — see `perf/README.md` for the full workflow.

```bash
openssl rand -hex 16 | sudo tee /opt/hackarena/data/.maintenance   # enable
sudo rm /opt/hackarena/data/.maintenance                           # disable
```

**The file's EXISTENCE is the mode; its CONTENT is the bypass token.** An
**empty** `.maintenance` — `touch`, or a redirect that truncated before the
token was written — therefore means *maintenance is on and nothing can bypass
it*, and the only way out is `rm`. That is deliberate: before v8.3.34 an empty
sentinel put the platform in a contradictory state, where the traffic gate and
`/readyz` said "not in maintenance" (so the site kept serving the public and a
load balancer kept sending traffic) while the boot banner said `maintenance=ON`
and the `bulk-seed-*` endpoints — which write thousands of rows — treated it as
engaged. A file that exists but cannot be READ (`chmod 000`, wrong owner, a
directory of that name) is treated the same way: an operator who engaged
maintenance and whose token we cannot read gets the gate, not a silent bypass.
Always write the token in one step, as above.

No restart needed to toggle.

### Observability

- **`GET /metrics`** — Prometheus text-exposition format, **admin-only**. Scrape it from an authenticated admin session behind the reverse proxy. Exposes a rolling 1024-sample request-latency reservoir, status-family counters, cache sizes, Node process memory, SMTP health, the CxOne queue depth, **`hack_arena_cxone_withdrawals{state}`** (accounts of deleted participants awaiting removal: `retrying`, `held`, `needs_attention`, `given_up`, `unmarked`), **`hack_arena_cxone_withdrawals_past_retention`** (removals still unresolved although scheduled longer ago than `EVENT_RETENTION_DAYS`; kept, never dropped), **`hack_arena_cxone_withdrawals_total{result}`** (removal outcomes since boot) and **`hack_arena_cxone_create_unconfirmed_total{reason}`** (account creations the platform could not confirm or record, so could never withdraw), **`hack_arena_cxone_provision_retries_pending`** and **`hack_arena_cxone_provision_deferred_total{reason}`** (Checkmarx One set-ups not linked to an account the platform was removing, waiting to retry and since boot), the detached-email and reconcile drain gauges, **`hack_arena_csp_reports_total{origin}`** (`app` vs `browser_extension`; the app series rising is worth acting on, the extension series rising is just more visitors with add-ons), and **`hack_arena_event_loop_blocked_ms_total`** — a cumulative counter of milliseconds the event loop could not run. `rate()` that last one: in a single-process server a rising rate is *the* health signal, and it is what stops a server stall being excused as a slow participant connection. Regression-locked at `tests/functional-security-a.api.spec.js` (shape + auth gate).
- **`POST /api/admin/test-email`** — **superadmin-only** diagnostic. Sends a test SMTP message and returns `{ok, deliveryTookMs, error?}` inline so you can verify credentials after a rotation or while an event is live without bouncing the process.
- **Structured access log** — every request is written as one JSON line (`ts, level, req_id, method, path, status, ms, bytes, ip, user_agent, user_id, email, first_name, last_name, session_id`, plus `impersonated_by` when the request was made by an admin impersonating a participant) to `LOG_DIR/access-YYYY-MM-DD.jsonl` (`LOG_DIR` defaults to `DATA_DIR/logs`; the separate `app-YYYY-MM-DD.jsonl` stream holds the application + audit-mirror lines) and Raw logs, the admin Audit page's second view. Capability-bearing URL secrets — verification / reset / confirm-email / OAuth `?code=`, join links and event codes, badge and credential codes, the unsubscribe token, invitation ids — are scrubbed *before* the line is written, so they never reach `access-*.jsonl` at all and no reader, superadmin included, can recover one from the log. The superadmin password banner in the application log is additionally redacted at read time for regular admins.

### Graceful shutdown

`SIGTERM` (e.g. `docker stop`, `kubectl delete pod`) and `SIGINT` (Ctrl-C) trigger a 20-second connection drain: `_httpServer.close()` → wait on the deferred-work gauges (the post-commit audit-mirror queue, in-flight detached email fan-outs, and queued group-sync reconcile passes) → `db.close()` → `process.exit(0)`. A 20-second watchdog force-exits on hang so a stuck connection can't block the drain indefinitely. In-flight submissions complete durably before shutdown; the detached-email gauge is what stops a rolling deployment dropping mail the API has already reported as sending. Pending Checkmarx One set-up retries are not run into the drain (an exit could cut a create half-way): each is stopped, recorded in the participant's History, and resumed when the server next starts — once it is out of maintenance mode, if it starts in it. Only the installation that recorded a retry resumes it, so a copy of the database started elsewhere sends nothing to the tenant. Skipped under `NODE_ENV=test` so Playwright's SIGKILLs don't spam the warning handlers.

### Boot-time sanity checks

Five independent checks run before `app.listen()`:

1. **Cluster-mode detection** — exits with FATAL if `cluster.isPrimary === false`, so a misconfigured pm2 `-i N` or Node `cluster.fork()` deploy can't silently produce stale per-process caches against one data volume.
2. **`PRAGMA integrity_check`, then the required-schema check** — SQLite's self-test, then every column and unique index a migration adds (`lib/schema-required.js`). A failure logs LOUDLY (the schema check names what is missing) but lets the process stay up so an operator can still log in and triage. Until the database is fixed and the server restarted, `/readyz` answers 503 (`db_integrity` or `db_schema`) and certificate, event-team and start-reminder email waits, as it does in maintenance mode (so does the "your account is unlocked" email): its jobs stay queued and go out then (an admin's own Resend, Issue again and Send now still send). So do the Checkmarx One account removals and the set-up retries a previous stop left waiting.
3. **Platform-version tracking** — stores the booting version in `settings.last_platform_version`; logs a transition entry if it changed since the last boot. Catches accidental rollback / wrong-container deployments.
4. **Reverse-proxy sanity** — if `TRUST_PROXY` is set but `BASE_URL` is `http://`, **warns** that Secure-flagged session cookies won't flow back to the browser; conversely, if `BASE_URL` is `https://` but `TRUST_PROXY` is **off**, it exits **FATAL** (sessions would be invisible to the browser, bricking every login).
5. **Achievement-badge rendering** — **non-fatal**: warns if `@resvg/resvg-js` or the badge fonts (`lib/fonts/badge/*.ttf`) are missing. The LinkedIn share-badge endpoint then returns 503, but nothing else is affected.

Watch the startup log on every restart for these — they're silent on a healthy deploy, loud when something's wrong.

---

## User Guide

The full user guide with screenshots lives under [`docs/`](docs/), split by role:

- 📘 **[Participant guide](docs/user-guide/participant.md)** — register, log in, pick an event, solve challenges, climb the leaderboard
- 🛠️ **[Admin guide](docs/user-guide/admin.md)** — every admin tab walked through (Events, Challenges, Participants, Groups, Submissions, Rankings, Analytics, Logs, Settings)
- 👑 **[Superadmin guide](docs/user-guide/superadmin.md)** — the superadmin's own features (role promotion, deletion, manual verify, import, CxOne)

**In-app help** — the same guides are reachable from every page: the **?** icon in the header before sign-in, and once signed in the account menu's **Help** item and the **Search** box (Ctrl/⌘+K), whose Help results open the drawer at the chosen heading. The drawer that opens renders the role-appropriate markdown (participant for participants, admin for admins/superadmins) with all images resolving against `/docs/screenshots/`. Internal cross-links between the guides navigate within the drawer; an ↗ icon opens the full rendered page at `/help.html?doc=<path>` in a new tab — same markdown pipeline, same `{{platformName}}` substitution, bookmarkable URL, back/forward and middle-click work as expected. Powered by a self-hosted [marked](https://marked.js.org/) build at `/vendor/marked.min.js` — CSP-friendly, no CDN, no eval.

Screenshots are captured by an opt-in Playwright spec (`tests/_screenshots.spec.js`); regenerate them with `npm run docs:shots` after any UI change. Light theme is pinned at capture time. See [`DEVELOPMENT.md`](DEVELOPMENT.md) for the full regen workflow (`docs:shots:participant` / `:admin` / `:superadmin` targets).

The condensed in-README quick reference below is kept for grep-ability; the screenshot-illustrated guides are the source of truth.

### Registration — the same card as sign-in

1. Navigate to the app, type your **work email** and press **Continue** (there is no separate Sign Up button)
2. Enter the code we email you. For an address with no account the code confirms the address and opens the short sign-up form: first name, last name, company and job title, plus your detected location (one line, **change** to correct it), a city and job function you may leave blank, and whatever else the event asks for
3. Press **Create account and continue** — you are signed in. A leaderboard nickname is suggested from your name; change it, add a photo or a second address in your profile (a second address receives mail; it never signs you in)

> **Note:** A new account needs a work email (not Gmail, Outlook, etc.); a personal address can start one only through the link in an invitation sent to it. The entry screen reminds you as you type. It answers the same way for every address that signs in with a code, registered or not, so it does not say whether such an address has an account; only an account that signs in with a password (by default an admin's) is shown the password box.

A new account is approved at once, unless a superadmin has turned on **Require admin approval for new accounts** — then every new account shows a "Pending Approval" message until an administrator approves it, except one made through a live join link, QR code or event code (its code typed in the browser where it was asked for), which is approved whatever the setting, and one made through an invitation from a role that may approve accounts (read when the invitation is used). Someone already waiting who signs in through a join link, QR code or event code, in that same browser, is approved then too.

### Logging In

Type your email address — your **primary** one; a second address on your profile never signs you in — and press **Continue**. What happens next depends on how your account signs in (participants and event admins use emailed codes by default; admins and superadmins a password):

- **An emailed code.** A short single-use code (it looks like `XXXX-XXXX`) arrives in your inbox; type it into the box that opens and press **Sign in**. If it has not arrived after two minutes you can ask for a new one; pressing **Continue** again for the same address within the code's ten minutes reopens the code box without sending another.
- **A password.** A password box appears on the same card and the button becomes **Sign in**. Under it, **Email me a code instead** sends you a code, which always works: a forgotten password is never a dead end — sign in with the code, then set a new password. Ten wrong passwords or codes in five minutes lock the account for an hour, and the correct password or code still signs you in. An account that has not set its password yet says so on the card: choose **Email me a code instead**, and after signing in you are asked to set one (or to keep using codes).

**Profile → How you sign in** switches between the two. Choosing a password when none is set sets one there and then (at least 8 characters, at most 72 bytes); switching back to codes keeps it, and choosing your password again later reuses it. Changing a password needs the current one, unless you signed in with an emailed sign-in code in the last ten minutes — the way back from a forgotten one. Setting or changing a password emails a notice to your primary address, and a change signs your other browsers out.

**Have an event code?** takes the printed six-character event code and resolves it first. The built-in superadmin signs in on the same card by typing its break-glass username instead of an address (see *Accessing the Admin Panel*). If no email arrives for your first sign-in, an organiser can show you a code at the desk; after that they can only have one emailed to you.

### Events

After logging in, you'll see a **event picker** listing all events you're assigned to. Click an event to enter it.

**Multi-session events:** If an event has multiple sessions (timeslots for different timezones), you'll be asked to choose a session. Your choice becomes final once the session starts — until then, you can switch freely.

**Event states:**
- **Upcoming** — not yet started; a countdown shows the time remaining. You can set a **reminder** to receive an email 1 hour before it starts (if an organiser later moves the start to less than an hour away, the email comes straight away and says how many minutes are left).
- **Live** — in progress; you can solve challenges and submit answers
- **Ended** — completed; your results are final

### Solving Challenges

The **Challenges** tab shows all challenges assigned to the event. Each challenge displays its difficulty (Easy, Medium, Hard) and point value. If the challenge has an author, their name and LinkedIn profile link are shown.

Click a challenge to see its full description. Most challenges take a typed answer — enter it and click **Submit**; text answers are matched ignoring case and spacing, and some challenges accept more than one answer, any of which counts. A **multiple-choice** challenge instead shows the options (radio buttons when exactly one is correct, checkboxes when several are — at a Booth Event on a phone, large lettered tiles instead); the order is shuffled per participant and stays stable across refreshes, and grading is all-or-nothing on the set you select. Some challenges ask for JSON or a file upload instead. An **any-answer** challenge accepts whatever you write, exactly as typed, and never asks you to confirm a penalty — it has none; one that lists options under **Choose one** takes one of them instead, and every option is accepted.

Correct answers award points immediately. Wrong answers incur a **-5 point penalty**. You cannot re-submit a challenge you've already solved.

After solving a challenge (or after the event ends), you can rate it from 1 to 5 stars.

### Hints

If a challenge has a hint available, click **Reveal Hint** to see it. Revealing a hint deducts **30% of the challenge's point value** from your score. You can only reveal each hint once.

### Leaderboard

The **Leaderboard** tab shows real-time rankings for your event. Rankings are sorted by:
1. **Score** (descending) — higher scores rank first
2. **Finish time** (ascending) — among tied scores, the participant who took less time to solve challenges ranks higher

If the organiser turned on **Break score ties on time spent**, a score tie is settled differently: anyone who finished every challenge ranks above anyone who did not, and between two finishers the one with less net active time on the platform ranks higher. Elapsed finish time then only decides the ties those two rules leave.

Your own row is highlighted. If the event uses per-session leaderboards, you'll see rankings only for your session.

### Profile

Open **Profile** from the account menu (the round button at the top right) to edit your profile. You can update your name, company, title, location, avatar, and email addresses, and under **How you sign in** choose between a code emailed to you and your password (see *Logging In*).

### Email Reminders

For upcoming events, you can click **Remind me 1 hour before start** to receive an email notification 1 hour before the event starts. The email states the time really left when it is sent, rounded to the nearest minute, so a reminder that goes out late — the start moved earlier, or it was set inside the last hour — does not claim an hour. There are three wordings (subject / body): 55 minutes or more, "starts in 1 hour" / "starts in about 1 hour"; 2 to 54 minutes, "starts in N minutes" / "starts in about N minutes"; 1 minute or less, "starts in a minute" / "starts in about a minute". A reminder is not sent once the start has passed: if the event (or the participant's session) begins before the email can go out — the server down across the start, or the email held while the platform was in maintenance or failed its startup check — it is not sent at all, and the participant's History says so (*Start reminder for … not sent: it had already started*; the Audit page lists it as *Reminder not sent (already started)*). For the same reason a reminder cannot be set in the last minute before the start (the button stays clickable on a waiting page left open, and the answer then says there is no time left to send one); the dispatcher runs every 30 seconds.

Dispatcher design (for operators): reminders are delivered by a 30-second poller that holds while the instance is out of service (maintenance mode, or a database that failed its boot integrity or schema check: asked before each tick and again before each claim, so a held tick touches no row and the reminders go out once service resumes). A reminder whose start has passed when it is claimed is settled without a mail (`sent` = 1, a `reminder_skipped` History entry). The poller uses a three-flag state machine on each row — `claimed_at` (lease marker set just before the SMTP await), `claim_token` (uuid identity of the specific claim attempt), and `sent` (flipped to 1 only after delivery is confirmed). Crash-safe: if a process dies after claiming a row but before finishing delivery, the next tick reaps any `claimed_at` older than the 2-minute lease timeout and re-queues the reminder. Race-safe against reminder replacement: if the user changes their timeslot or resets the reminder while a send is in flight, the old row gets deleted and a new one inserted — the dispatcher completes/releases by `claim_token`, not by `(user_id, competition_id)`, so the old tick cannot mark the new (un-dispatched) row as sent. **Race-safe against RESCHEDULING too:** an admin moving a session's (or a single-slot event's) start time updates every pending reminder's `send_at` **in place**, leaving `sent`/`claimed_at`/`claim_token` untouched — the one mutation `claim_token` cannot see. Both the claim and the completion are therefore bound to the row's full **schedule identity** (`claim_token` + `send_at` + `timeslot_id`), so a reminder whose session moved mid-dispatch is skipped or released rather than announced at the old time or silently consumed. It re-fires at the new time (at most one 30-second tick later). One residual, stated rather than hidden: only the SCHEDULE is bound, so an admin who merely RENAMES a session or event mid-batch can still produce a mail carrying the old label at the correct time — binding the label would mean re-reading the dispatcher's five-table join at a second site, and a rename does not change *when* the mail is right. The participant's screen shows only whether a reminder is currently *set*, and the panel disappears once the start is less than an hour away — nothing on that screen reports delivery. Confirmed delivery is visible to an admin in the participant's History, as an `email_sent` entry with reason `reminder`.

### After the Event

When your session ends, you'll see a summary of your results. Correct answers and explanations are published only if the organiser turned on **Reveal correct answers and explanations** for the event — it is off unless they chose it, and it can never be turned on for a Program. Where it is on, the answers stay hidden until **all sessions end**, so nothing can be shared between timezones while anyone is still competing; once every session has finished you can review the answer and explanation for each challenge (an **any-answer** challenge has no answer key to show, so only its explanation appears).

---

## User Guide — Administration

### Accessing the Admin Panel

There are two ways to get admin access:

1. **Built-in superadmin** — on the ordinary sign-in card, type the break-glass username (default `superadmin`; changed only from that account's own session, in **Settings → Sign-in → Break-glass account**) into the email box, press **Continue**, and enter the password from the server startup log. Anything typed that is not an email address gets the same password box, so the card never confirms the username, and this account has no emailed-code door. This gives full superadmin access.
2. **Database admin users** — sign in with their address like everyone else: an `admin` or `superadmin` with a password by default (with **Email me a code instead** always offered), an `event_admin` with an emailed code by default (see *Logging In*). An admin who has not set a password yet signs in with a code and is then asked to set one, or to keep using codes. Any user promoted to `admin`, `superadmin` or `event_admin` role can switch between participant and admin views using **Switch to Participant View** / **Switch to Admin View** in their account menu (the round button at the top right). Participant view uses your own profile, so if a required detail on it is missing you are asked to complete it before the switch.

The admin panel's sidebar has three groups: **Manage** (**Events**, **New event**, **Question bank**, **Live rankings**, **Analytics**, **Marketing** and **Audit**, whose **Raw logs** view holds the server's logs), **Participants** (**People**, **Groups**) and **Admin** (**Roles & permissions**, and **Settings**, whose cards each show to a role holding the permissions their routes check — operator ruling, 14 Nov 2026: a regular admin sees the platform certificate design, the event team report domains (read-only), data retention and the blocked-address alerts; every other card is a superadmin's, or a custom role's given its permissions). An event's submissions are on its workspace's **Activity** tab.

### Event Management

#### Creating an Event

Click **+ New Event** (or **New event** in the sidebar). Every event starts on the **New event** page: one card per type, each offering its **Recommended setup** (a built-in template) and **Start blank** — **Booth Event** (a few hours, one room, walk-up sign-up), **Competition** (ranked, one session or many, certificates and LinkedIn sharing — the default and most common), **Program** (self-paced, runs to a deadline, no ranking, certificate on full completion) — and below them the **templates** your organisers saved. Each opens **one create form**; a recommended setup or a template fills it in and brings its challenges. **Event type** is the form's first field and **can be changed until the event starts**; it is fixed once the event is under way, or while it has sessions. Templates are protected: built-ins cannot be deleted, a **Protected** template cannot be deleted by anyone, and a deleted template waits in **Recently deleted** for one-click **Restore**.

**The form is scoped to the type.** Essentials first, the rarely changed settings folded into **Advanced settings**, a **?** tip beside every non-obvious field. It renders *only* the settings the chosen type can use, so you never meet a control the platform would refuse:

| Setting | Booth Event | Competition | Program |
|---|:---:|:---:|:---:|
| Name, start date/time, timezone | ● | ● | ● |
| Schedule toggle (single / multiple sessions) | — | ● | — |
| Duration (the end is shown beneath) | ● | ● | — |
| Deadline | — | — | ● |
| Leaderboard mode | — | ● | — |
| Reveal answers on end | ● | ● | — |
| Group (team) leaderboard | ● | ● | — |
| Record time on platform | — | ● | ● |
| Break score ties on time spent | — | ● | — |
| Attempt limit / test-run marker | ● | ● | ● |
| Staff can compete | ● | ● | ● |
| Trusted network IPs | ● | ● | — |
| CxOne integration | ● | ● | ● |

Every gap is a rule the server enforces, not a UI preference — a Program has no sessions, so it has no leaderboard mode; a Booth Event's window is too short for a five-minute presence bucket to mean anything. The CxOne opt-out also arrives pre-set from the type's own default. See [`docs/user-guide/admin.md`](docs/user-guide/admin.md) for the reasoning behind each row.

For **multi-session events**, switch to the "Multiple Sessions" toggle and add sessions with individual names, start times, and durations (e.g., "APAC Morning", "EU Afternoon").

A confirmation dialog shows a summary before saving. **Editing** an existing event opens the same form — **Event type** stays changeable (with a confirmation naming what the new type turns off) while the event has not started and has no sessions — and scopes it the same way.

#### Managing Events

- **Edit** — modify event details. Once the whole event has ended — every session finished, or an organiser ended it manually — only a superadmin may edit it, and its name is frozen for everyone. A superadmin can also correct the **start time** of an event that is already running, but only while nobody has taken part in it yet.
- **End Now** — manually end an event or a specific session
- **Delete** — remove an event entirely (superadmin only)
- **View** — scope the admin panel to a specific event; all tabs filter to show only data for that event

#### Automatic Ending

An event session auto-ends when every participant in that session has **finished** every challenge — solved it, or run out of attempts on it where an attempt limit applies. Without that second clause a single exhausted participant would hold a capped event open indefinitely. When all sessions end, the event itself is marked as ended, and the recorded reason names how many participants finished by running out of attempts rather than by solving. Granting an exhausted participant more attempts un-finishes them, which is what lets a superadmin reopen such an event by extending it.

**The all-solved auto-end is suppressed while self-enrollment is enabled** — a new participant can follow the join link at any moment, so ending the instant the *current* enrollees finish would freeze the event and break the live link. Time-based ending and manual **End Now** are unaffected. Disabling self-enrollment re-arms the rule for the *next* completing solve, but it does **not** close the event retroactively: if everyone has already finished there is no submission left to re-check, so use **End Now**.

**A Booth Event never auto-ends on all-solved**, with self-enrollment on or off — it is a stand that stays open for the next walk-up. A Program does not either, by default. Both run to their window or deadline, or until an admin presses **End Now**.

Ending an event — by any route — also **freezes the team leaderboard**, because groups are reusable across events and a later membership edit would otherwise silently rewrite a finished event's standings. A group bound to a Booth Event during its late-entry window (the way a cohort is admitted late) never joins that final team board, however late the board is first computed: it is the teams bound when the event ended.

### Challenge Management

#### Creating Challenges

Click **+ New question** on the **Question bank** to create one. Configure:
- **Title** and **description** (rich text editor with code block support)
- **Difficulty** — Easy, Medium, or Hard
- **Answer type** — **Text** (one or more accepted answers), **File Upload**, **JSON** (deep equality), **Multiple Choice** (tick the correct options; the list is shuffled per participant) or **Any answer (free response)** (every non-empty answer is accepted exactly as typed; there is no Correct answer box, the Hint field is hidden, and the platform refuses to store a hint on such a challenge; two or more **Options** make it a pick-one question, where any one of them is accepted and anything else is refused)
- **Correct answer** — one or more accepted text answers, each matched ignoring case and whitespace (**+ Accepted answer** adds an alternative). Not asked for on an **Any answer (free response)** challenge
- **Hint** (optional) — a clue for participants; revealing it costs 30% of the challenge's points
- **Explanation** (optional) — shown to participants after the event ends
- **Author name** (optional) — displayed to participants on the challenge detail page
- **Author LinkedIn** (optional) — shown as a clickable link alongside the author name
- **Tags** (optional) — comma-separated admin-only labels for organization (e.g. "web, crypto, beginner")
- **Status** — Draft (hidden) or Published (visible to participants)
- **Attempt limit** (optional) — how many times each participant may submit an answer to this challenge within one event. Blank means unlimited, and any value here overrides the event's own attempt limit. Revealing a hint costs no attempt.
- **Seal the answer** (optional, **create only**) — tick *Seal the answer — only I will be able to see or change it* and the correct answer, the explanation and the hint become visible to your account alone, plus a superadmin who reveals them on the record. See *Sealed answers* below. The checkbox is on the create form and nowhere else: sealing cannot be turned on later.

#### Sealed answers

A challenge can be created with its answer **sealed**, which makes the correct
answer, the explanation and the hint visible to exactly one person by default: the
account that created the challenge (`tasks.created_by_id`). Not other event
admins, not administrators, not participants — and a **superadmin** only after an
explicit, recorded **reveal** (below). It is for the ordinary case where the
author's own colleagues may compete in, coach at, or help run the event.

The switch is `tasks.answer_sealed`, and the whole rule lives in
[`lib/answer-seal.js`](lib/answer-seal.js) — a pure module whose predicates take the
row, the actor's user id and a `revealed` flag as arguments. It is **orthogonal to
the event-admin scope**: the scope predicates in `lib/event-admin.js` exempt
administrators and superadmins by design, and this one binds every tier. See §9.7
of [`ROLES_AND_PERMISSIONS.md`](ROLES_AND_PERMISSIONS.md).

**What is sealed** — `correct_answer`, `explanation` and `hint` (the `SEALED_FIELDS`
list). The explanation is included because in this threat model it is the answer
wearing prose; the **hint joined the set in v8.12.2** and is withheld wherever the
key is — admin list, editor, history, export, participant preview and the
end-of-event reveal — with ONE exemption: the hint a participant **paid** for
(their own `hint_reveals` row) stays theirs, since the paid reveal is the hint's
whole purpose. On a multiple-choice challenge the correct *options* are withheld
while the option **text** still shows, because the options are the question.

**A superadmin may reveal it, on the record (v8.12.2).** `POST
/api/admin/tasks/:id/sealed-reveal` — offered on the admin row as
`can_reveal_answer: true` (computed from the ACTING human's live tier, so a
superadmin inside an impersonated event-admin panel gets it) and rendered as the
row-menu item **Reveal sealed answer** and the editor button **Reveal sealed answer
and hint**, behind a confirm whose button reads **Reveal and record** — marks the
challenge revealed for the rest of that session (`req.session.sealedReveals`),
after which the row carries `answer_revealed: true`, `can_see_answer` is true,
`can_edit` is true (except through an organiser's panel, where editing still
follows that organiser's own-challenges rule, so a co-organiser's challenge stays
`can_edit: false` and its PUT answers `event_admin_not_owner`), and every seal
predicate treats the superadmin as the author:
read, edit, publish/hide, tag, restore, recalculate, the Submissions stream and
its search, the export, the import overwrite, and the unseal. Each reveal writes a
`task_versions` row of `change_type: 'sealed_reveal'` (a **record**, rendered in
History as a sentence with a *Record* cell in place of Restore, skipped as a diff
baseline, never the current version, refused by the restore route) with
`details: {via, fields, impersonated_by?, acting_as_id?}` — `via` is `admin_panel`,
`impersonated_admin_view`, `participant_view` or `participant_hint`; `fields` names
only what the challenge has; the seat of an impersonated reveal is stored as a user
ID and resolved per reader, so an organiser who shares no event with that person
reads `acting_as_withheld` rather than their email (and no `via` beside it, since
`impersonated_admin_view` would say the hidden account is an organiser), while a
deleted seat reads `acting_as_deleted` for every reader — plus an
`app.jsonl` audit event `sealed_answer_revealed` carrying the request context. A
reveal lasts for the session SHAPE it was made in: sign-out, the view toggle, a
sign-in elsewhere, and impersonation entry/exit all end it. A regular admin and an event admin
are refused with `answer_seal_reveal_superadmin_only` (403) — a participant never
reaches the route, the admin gate answering a plain `Forbidden` — and a
superadmin **competing** in an event that holds the challenge is refused with
`competitor_cannot_edit` — the seal invariant's back door. In a superadmin's
PARTICIPANT view (own, or impersonating anybody) there is no control: a sealed
value is shown wherever the author would see it and each such open is recorded
with the same row (`participant_view` / `participant_hint`) — never for a
superadmin who COMPETES in an event holding the challenge, who is shown nothing
sealed there either. **The record gates the disclosure (v8.12.6)**: if that row
cannot be written, nothing sealed is shown. The challenge still opens (200) with
exactly the fields the record would have named withheld and the reason
`unrecorded` beside them, and a hint request answers
`503 answer_seal_reveal_unrecorded` before any `hint_reveals` row is written, so
no points are deducted — from an impersonated participant either. Reopening, or
asking again, simply tries the record again. The record takes the write lock up
front, so a brief lock held by another process is waited out rather than
failing at once. A regular admin impersonating the author sees neither key nor
hint, and in their own participant view an admin who is not competing is refused a
sealed hint outright (`answer_sealed_not_author`) rather than sold one.

**Where the answer is withheld** — every screen and every file the platform
produces:

| Surface | For a non-author |
|---|---|
| Challenges list and everything the admin SPA draws from it | the answer is not **sent**, not merely not drawn — the row carries `can_see_answer: false`, `hint_withheld: true` (when there was a hint) and no `correct_answer`, `explanation` or `hint` key; a superadmin who may reveal gets `can_reveal_answer: true` instead |
| Challenge editor | the answer box is empty, the hint editor is hidden and the form is **read-only**; Save is not offered (a superadmin sees the reveal button) |
| **View as Participant** | the Solution box is replaced by an explanation of the seal, and the hint block says it is withheld |
| Version history / challenge History | **retroactively** — snapshots taken *before* the seal are redacted too, on the live row's flag; hint included |
| Challenges JSON export | `correct_answer: null` beside `answer_sealed: 1`, and `hint: null` + `hint_withheld: 1` |
| Submissions | a submitted answer reads *sealed*, and the search box cannot match it either |
| Event log / History | an edit records `(sealed answer changed…)` instead of the values, so the answer never reaches `app.jsonl` on disk |
| End-of-event answer reveal | **Answer not shown**, with the reason, even with *Reveal answers when the event ends* on. The explanation and the hint are withheld with it — a hint the participant paid for is still returned |
| Participants CSV with an event open | a sealed *Any answer* challenge contributes **no column at all** — that export's whole content is the participants' free-text responses, and a column of blanks under the challenge's title would read as "nobody responded", which is a wrong answer about real people |

An **absent** `correct_answer` means withheld, never empty — `answer_type='any'`
legitimately stores an empty answer, and the admin form posts the field
unconditionally, so a reader who saw a blank and saved would wipe a key it was
never allowed to read.

**Only the author may** edit the challenge (the whole `PUT` is refused for anybody
else), restore one of its earlier versions, or recalculate its scores — the author,
or a superadmin who has **revealed** it (above). The seal only ever **narrows** what
a tier already allowed, never widens it: recalculate is still a superadmin action,
so on a sealed challenge it needs a superadmin who is the author or has revealed
it, and a restore still has to clear the ordinary scoping gate as well.
**Publishing, hiding and tagging are the author's alone too** —
`status` and `active` are scoring fields, so moving them changes what every event
holding the challenge counts as solved — and attachments follow, being managed
inside the editor. What stays open to everyone who can see the row is the *use*
of it: assigning it to their own events, unassigning it again, granting attempts,
History, lock/unlock, and a superadmin's hard delete — so a sealed challenge can
always be got out of an event without its author. A **Sealed** badge appears in
the Status column of the challenges table for everyone who can see the row, the
author included.

**A seal needs a key, so `answer_type: any` cannot be sealed.** That type stores
no `correct_answer` at all (v8.9.0), so the seal would protect nothing while still
hiding the free responses from everyone but the author — the opposite of what the
type collects them for. Refused at create (400 `answer_seal_needs_a_key`), on the
PUT against the prospective state (so switching a sealed challenge to it is
refused even when the request carries no `answer_sealed`), and on version restore
(409 — `answer_sealed` is not restored while `answer_type` is, so a snapshot could
otherwise assemble the pair across two points in time). The admin form gates both
directions and says why in each case. Written over `answerTypeHasKey` rather than
`=== "any"`, so a future keyless answer type is refused with no edit.

**Sealing is a one-way door.** It can be chosen only at creation. The author can
**unseal** later — *Unseal this answer when I save*, a checkbox offered in the
editor to the author and to a superadmin who has revealed the answer — unless the
challenge sits in an event that lets
staff compete, at any status of that event, because a finished event revives:
there the unseal is refused naming the events (*Tags*, below) — take it out of
the event first, or leave it sealed. And after an
unseal **nobody can seal it again**, author included: between creation and now
the answer has been on every administrator's screen, in the version history, in
the export and in the log files, and a column flip cannot retrieve any of that.
The refusal says so rather than ignoring the request.

**The built-in `superadmin` account cannot seal.** It has no `users` row, so there
would be no author and the challenge would be readable and editable by nobody at
all, for ever. The create is refused with that explanation; sign in as a named
admin account instead.

**Sealed challenges do not migrate.** The challenge import **refuses** a row marked
sealed, because an imported challenge has no author on the destination platform —
create it fresh there instead. An import also cannot **overwrite** somebody else's
sealed challenge. Both are skips rather than a hard failure, so one sealed row
cannot sink a large migration, and the import response counts them in
`sealed_skipped`, apart from its ordinary `skipped` tally, because the remedy is a
different one. The same posture covers the competitor lock (*Tags*, below): an
import cannot overwrite a challenge held by an event the importer
competes in — for anyone but its author the seal already skips it (`sealed_skipped`,
since such an event holds sealed challenges only), and for the author, whom the seal
admits, the row is skipped and counted as `competitor_skipped` — and the import
summary renders both. That second count is defence in depth: an author enrolled in
an event that holds their challenge is a state every door refuses to create
(assigning the author, assigning their challenge, and turning the switch on with
them enrolled are all refused), so it can only describe a row written by hand.

**What it does not do**, stated plainly because a control that is believed to do
more than it does is worse than none:

- it does not hide the challenge, its title or its description, nor the hint a
  participant pays for during the event;
- it does not hide who solved the challenge, or any score;
- it is **not encryption at rest** — anyone with direct access to the database or
  its backups can still read the answer. This is a control over the platform's own
  screens and exports.

Sealing is a property of the **challenge**, not of the event, so it appears in no
per-event-type row of the table under *Creating an Event*: any challenge of any
answer type, in any kind of event, may be sealed.

#### Managing Challenges

- **Edit** — modify any field; version history is maintained
- **Publish** — make a draft challenge visible to participants
- **Assign to events** — link challenges to one or more events (an event that lets staff compete accepts sealed challenges only, and never one whose author competes in it — *Tags*, below)
- **Lock / Unlock** — superadmin can lock a challenge to prevent further edits or version restores by regular admins
- **Delete** — permanent removal with confirmation (superadmin only). It is refused if the challenge has any submission or any hint reveal, if it is used in a live event, or if it is assigned to any event where a session has ended, because a finished event's standings are frozen — so in practice a challenge that has been used in a past event stays in the bank
- **Import / Export** — JSON format for bulk operations. Exporting takes the export permission, which every built-in admin role holds (an event admin's file holds only the challenges they may see); importing takes the import permission, which a superadmin holds and only a superadmin can give
- **Feedback** — the edit form shows individual user ratings; superadmin can delete individual or all feedback

The challenges table is paginated (30/50/100/200 per page) and supports sorting by title, difficulty, type, status, attachments, feedback, last changed, changed by, and author. The Author column shows the challenge author's name and is both sortable and searchable.

#### Topics, sharing and the old tags

The Question bank is organised by **topic**: a topic holds many questions and a question belongs to at most one. Filter the bank with its **Topic** box; manage topics (add, rename, delete — a topic still holding questions asks where they go) with **Topics** beside **Export**; file a question under one in its editor's **Topic and sharing** row. Participants see a question's topic as its category label (the participant payload carries only that name). An administrator manages every topic; an event admin the topics they made.

The same row holds **Shared with all organisers** (the reserved `public-domain` marker, which lets every event admin use a bank question) and **This question needs** (the `needs:` markers a Booth Event refuses). **Free-form tags are no longer shown or edited.** They stay stored: when the platform was updated, each question's first `category:<name>` tag became its topic, and a question with no topic still shows its old category tags to participants. The tag API routes still work. Exports carry each question's topic by name, and an import files it under the topic of that name, making the topic when missing.

Inside an event, **Save to bank** on one of the event's own questions copies it into the bank as a new, unlinked bank question.

Challenge assignments are frozen once any session of an event has ended.

### Participant Management

#### Inviting Participants

1. Open the event from the **Events** list (its name, or **Open**)
2. Press **Invite** in the event's header: the invitation dialog opens with the event ticked — enter email addresses (one per line or comma-separated)
3. Invitees receive an email with a registration link pre-associated with the event

Alternatively, tick people who already have an account and use **Assign to Events** on the selection bar (inside an event it reads **Assign to "…"**, naming the event).

A Booth Event that has ended but is still inside its **late-entry window** stays open to both, to the **At the desk** shortcut and to a group bound to it: whoever is added joins as a late entrant, and the dialog says so before you confirm. Somebody who took part before the end is skipped rather than re-added (the Invite and Assign results say how many), and while the window is open only late entrants can be removed (see *Late entries on a Booth Event*, above).

#### Approval Workflow

A new account is approved automatically when it is created, because its owner has just proven the address with an emailed code. Turn on **Require admin approval for new accounts** in Settings (superadmin) to keep every new account in the queue instead — except one made through a live join link, QR code or event code (its code typed in the browser where it was asked for), which is approved whatever the setting, and one made through an invitation from a role that may approve accounts (read when the invitation is used). Someone whose invitation came from a role that cannot approve accounts (or from an inviter who has since lost that permission, or whose account is gone, blocked or denied) waits, and the organisers of the events the invitation names see them waiting in People; an invitation sent again to the same address by someone who may approve becomes theirs, and its newcomer is approved. Someone already waiting who signs in through a join link, QR code or event code, in that same browser, is approved then too.

1. Unverified users show an "Unconfirmed" badge. Entering an emailed sign-in code verifies an account, so this is rare. **Manual verify is superadmin-only** — a recovery tool for users who cannot receive email (bounced MX, corporate spam filter, etc.); for someone standing at a desk who has never signed in, **Show sign-in code** is usually quicker.
2. Verified but unapproved users show a "Pending" badge — click the approve icon (checkmark) to approve
3. **Approve** on the selection bar — select multiple pending users and approve them all at once

#### Blocking and Unlocking

- **Block** — immediately prevents login and destroys all active sessions
- **Unlock** — clears an account lockout caused by too many failed login attempts

#### Roles and Permissions

Four roles are available:
- **Participant** — can solve challenges and view the leaderboard
- **Event admin** — an organiser of *specific events*. Everything they see and do is narrowed to the events they have been granted: only those events, only participants enrolled in them, and only challenges they created, challenges used by one of their events, or challenges tagged `public-domain`. Within one of their events their powers equal a normal admin's. They cannot create a blank event (they start one from a template or by cloning one of theirs, and become its organiser), change roles, or reach the platform's own logs, settings, metrics or alerts.
- **Admin** — full admin panel access across every event, except destructive operations
- **Superadmin** — all admin capabilities plus: delete competitions/challenges/users, edit ended events, import data, manage CxOne integration and the removal of Checkmarx One accounts left by deleted participants, change user roles

**`ROLES_AND_PERMISSIONS.md` is the source of truth** for who may do what, including the full per-route matrix. It is generated from the same classification the server enforces and is kept in step by a scanner, so it cannot drift from the code.

An event admin is granted per event from the participant's row (**Make event admin**) or from the event's own organiser list — admin and superadmin only, which is what stops the role self-propagating. Removing their last event leaves the role in place with nothing in scope; **Demote to participant** on the role control is what removes the role and clears every grant. Event admins never appear on a leaderboard, exactly as other admin tiers do not — unless the event's **Staff can compete** switch is on and they are enrolled in it (*Tags*, below), which lifts both exclusions together.

Regular admins cannot mutate peer-admin state. Against an admin / superadmin target, `PUT /api/admin/participants/:id` is a **blanket 403 on the whole profile** — not merely on the email fields — and **block / unblock**, **unlock**, **Email sign-in code**, **role change**, **delete**, **group membership** and **impersonation** are likewise refused (an event-admin target is impersonatable by a global admin, in either of their views). Only superadmins can perform these actions against admin / superadmin targets.

**The restriction announces itself.** Hiding those row actions would otherwise collapse the kebab menu to two entries with no reason given, which is indistinguishable from a broken feature. The menu carries a non-interactive note ("Admin/Superadmin account — only superadmins can manage it") and relabels Edit Profile as **View Profile**, because the dialog it opens is read-only. When adding any future permission-gated row action, gate the affordance and the explanation together. This closes both the account-takeover vector (attacker points a peer admin's address at an inbox they control, then has a sign-in code mailed to it) and the operational-interference vectors (blocking a peer admin, kicking their sessions, spamming sign-in mail).

For **non-privileged (participant) targets**, regular admins can edit both primary and secondary email — this is the routine "please change my address" support case. The privileged-target guard above only fires when the target carries `role=admin` or `role=superadmin`.

#### Case-insensitive identity

Email addresses and nicknames are treated as case-insensitive identities across the entire platform:
- Uniqueness is enforced at the DB level via `COLLATE NOCASE` unique indexes on `users.email`, `users.secondary_email`, `users.nickname`, and a partial `COLLATE NOCASE` index on unredeemed `invitations.email`.
- Preflight checks (registration, `/api/check-nickname`, self-edit, admin-edit, import conflict detection) use the `COLLATE NOCASE` unique indexes (`email = ? COLLATE NOCASE`) on emails and nicknames so a case-only variant surfaces as a clean 409 rather than falling through to a generic 500 at the UNIQUE constraint.
- Every sign-in door (a code request, a code, a password, the entry screen's sign-in-method lookup) accepts the email field case-insensitively (`ALICE@ACME.COM` resolves to `alice@acme.com`), and matches it against the account's **primary** address only: a secondary address is an unconfirmed claim, so it never signs anyone in, never receives a sign-in code and never claims an invitation (operator ruling, 11 Nov 2026). The break-glass username is also matched case-insensitively.

The original case of emails and nicknames is preserved at storage and display time; only comparison is case-insensitive.

**Startup hard-fail:** if the DB already contains case-collision rows on any of these identity columns (e.g. legacy `Alice@x.com` and `alice@x.com`), the unique-index creation aborts the process at boot with a diagnostic listing the offending row IDs. The operator must merge or rename them before the platform will start. Failing soft (log-and-continue) would leave the server running with the case-insensitive lookups returning ambiguous rows.

**Same-account email collision:** primary and secondary email must resolve to different identities (case-insensitive). Setting both to the same address is rejected with 400 at registration, self-edit, admin-edit, and import. `getUserEmails()` additionally dedupes case-insensitively at mailout time as defence-in-depth.

Promote or demote users by clicking the star icons in the **Participants** tab (superadmin only).

#### Tags

Tags are free-form labels for organizing participants. Two special tags have system behavior:
- **staff** — excluded from leaderboard rankings, can join any event without assignment, and skip the entry / session / leave confirmations. On an event whose **Staff can compete** switch is on, the exclusion and the skipped confirmations are both lifted for the staff enrolled in it (below); a staff member who is not enrolled still enters such an event without a row, as a spectator off its board — and if they are enrolled later, their clock starts at the earlier of their first request after being enrolled and their first submission or hint there, so play as a spectator counts from the moment it began and cannot buy a zero clock
- **benchmark** — shown separately in admin leaderboard (useful for reference scores)

**Staff can compete** is a per-event switch (`competitions.staff_compete`, off by default, available on all three event types) that lifts the staff exclusion for that one event. "Staff" here means the `staff` tag **and** the event-admin role — the two sources every board already excludes by, lifted together. With it on, a staff member who is **enrolled** in the event (holds a row, exactly like a participant) is on the leaderboard and the team board, counts toward the all-solved rule, accrues time on platform, can mint a certificate, and appears in the rankings CSV and the activity CSV; the analytics default (*Exclude `staff`*) is deliberately unchanged. Four rules make that safe. Three of them live in [`lib/staff-compete.js`](lib/staff-compete.js) — a module that requires nothing at module scope, whose helpers take the database, the rows and the actor's user id as arguments and bind every tier including superadmin, which is why it is not folded into the tier-exempting scope predicates of `lib/event-admin.js` — and the fourth, which events a staff row may be written into at all, is `staffRowRefusal` (`lib/self-enroll.js`), the one predicate every non-admin row-writer shares, with the Participants tab's assign asking the same two questions inline:
- **Sealed challenges only.** A competing admin can open the Challenges pane, where an unsealed challenge's answer key is visible to every admin tier, so an event that lets staff compete may hold only challenges whose answer is **sealed** (*Sealed answers*, above; an *Any answer* challenge can never be sealed, so it can never be assigned there), and never one whose author competes in it — the author reads a sealed key by definition. Enforced from every direction: assigning the challenge (from a challenge's own **Assign to events** dialog every refused challenge-to-event pair is named and nothing in that request is assigned; the bulk assign skips the refused pairs, assigns the rest and lists what it skipped), assigning the author, turning the switch on while unsealed challenges are assigned or while somebody enrolled wrote one of the assigned challenges (both refused — the first naming the challenges, the second naming the people and their challenges), and unsealing a challenge while it is assigned to an event that lets staff compete — at any status of that event, because a finished event revives (extending it, adding a session or assigning a participant all bring it back, and none re-asks the seal) — refused, naming the events (an event admin is named only their own events and told how many others there are). The cost is stated: a challenge in a finished compete event stays sealed for as long as it stays assigned, since a finished event's challenge list cannot be changed either; its author still reads and edits it, and leaving the answer sealed is always an option. The challenge editor withholds the Unseal control while any of the challenge's events lets staff compete — the ones it can name, named; for an event admin, the events outside their scope counted (the row says whether any of those competes) — and says which.
- **A competitor cannot edit.** Anyone who holds a row on such an event — event admin, admin or superadmin alike — is refused every state-changing admin action on that event, on every challenge it holds (purging a challenge's feedback included) and on every participant group bound to it, because group membership live-syncs into the event (`403 competitor_cannot_edit`, one shape from every door; a group bound to no event is untouched, and renaming a group changes no membership so is never refused). The admin challenge list, the version history and the tasks export all withhold the answer, the explanation **and the hint** from them, since a participant pays 30% of the points for a hint (the export marks a withheld hint so that a re-import keeps the stored one rather than wiping it). The row is the fact, not the tag, so an admin created without the tag is bound too, and the lock reads the row at any status. Removing *yourself* from the event is the one write the lock never refuses — it is the way out while the event has not ended, for every tier: the competitor lock and the event-admin scope check both step aside for it, so an event admin enrolled in a compete event they do not organise can still remove themselves there. A finished event refuses every removal — the one exception being a late entrant of a Booth Event who had not started playing before it ended, while its late-entry window is open (*Late entries on a Booth Event*, above), who may take themselves out then — so a competitor in an event that has ended stays a competitor and another organiser edits it. The lock covers the event, its sessions, its challenges and the groups bound to it — and reaches a fellow competitor's *account* too: anyone who shares a compete event with you is a **rival**, and blocking or unblocking, denying, approving, verifying or impersonating them, emailing them a sign-in code or showing one at the desk, moving either of their email addresses, changing their role, deleting them, giving or removing the `benchmark` tag (the one tag that moves the board; the `staff` tag is inert where staff compete) or revoking one of that event's certificates is refused with the same message naming the event, whatever your tier. Impersonation is refused at entry and re-checked on every write made as the target, so a pair who become rivals mid-session cannot move the board either. Unlocking a login lockout, editing the rest of their profile, reading their History and exporting their data (the person export, a read: their answers to that event's challenges, all sealed, stay withheld) stay open. The Participants tab withholds those row actions with the reason. The two superadmin imports take the skip-and-report posture instead: the participant import skips a membership row into an event the importer competes in (their own row excepted) and the challenge import skips overwriting a challenge held by such an event, and both say so in the import summary. The refusal is asked ahead of the event-admin scope check on the event's own doors and on every challenge door, so every tier hears the same reason there — while the participant assign, the invitation and the attempt grant, and every group door (the Groups page's membership routes, the participant row's group chips and the groups an invitation applies), answer the scope question first, so only an event admin competing in an event they do not organise hears the scope reason at those. The admin screens withhold the controls with the reason ("You are competing in this event — you can view it, not change it"). The **Join Link** dialog stays open to a competitor, read-only: the link, the QR and the short code are shown for copying, while the enable toggle is disabled and **Regenerate** is withheld, with the reason beside them.
- **Staff-tagged accounts are added only to events that let staff compete.** Every path that enrols somebody — the Participants tab's assign and invitation dialogs, the join link and event code, group sync, LinkedIn invitation claims and the participant import — writes a `staff`-tagged account's row only into such an event, and never for the author of a challenge assigned to it; elsewhere they enter without a row and off the board (group sync skips such a row silently, exactly as it skips a blocked or unapproved member). A row they already hold on an event where staff do not compete — one written before the tag, or before the switch existed — is a membership all the same: every door reads it first and treats them as the member they are rather than reporting a staff skip. An event admin without the tag holds an ordinary row on any event — that is how they enter it at all — and is kept off the board by role until the switch lifts it. Every admin door says what it skipped and why: the assign and invitation dialogs report staff, peer-admin and author skips (the assign path names the author's challenges in a modal) beside blocked and unapproved accounts, which are reported as such rather than as staff and never also as already assigned, and the participant import counts each skipped enrolment by reason. On an event that lets staff compete, the assign and invitation dialogs let a regular admin enrol an admin or superadmin account only when it is their own — enrolling a peer admin as a competitor is managing that account, which is a superadmin's act — and the **Invite to …** row action is withheld from them for such a row; group sync asks no such question, so a peer admin who is a member of a group bound to such an event is enrolled with the rest of the group, whoever bound it — and through every admin door, only a superadmin can put an admin or superadmin account into a group in the first place: the Groups page and the participant row's group chips refuse it, and the invitation dialog withholds the group adds from such a target and reports them. Two paths ask no tier question and are stated as-is: a participant grouped by a regular admin and promoted afterwards keeps the group (a promotion removes no membership), and an existing admin-role account claiming an invitation by signing in with LinkedIn is written into the invitation's events (subject only to the spectator and author rules — never the peer-admin skip) and into its groups as-is. The second is DECIDED (19 September 2026): the claim is the account enrolling itself, which the peer rule exempts at every door.
- **Fixed once the event has started, and refused while it would strand anybody.** The switch cannot be changed once the event has started (or after it has ended, when whether staff competed is part of the result); turning it off while `staff`-tagged users are enrolled is refused, naming them, because they would otherwise drop off a board they are on (an enrolled event admin does not block it — they are excluded by role, not by row, and hold rows on non-compete events legitimately); turning it on is refused while the event holds an unsealed challenge, or a challenge written by somebody enrolled in it (*Sealed challenges only*, above).

A competing staff member gets every confirmation a participant gets (entering a live event, choosing a session). A staff-tagged user's event picker shows two sections — the events they are enrolled in first, each one whose switch is on carrying a **Competing** badge, then every other event they may enter as staff — while an event admin without the tag keeps the single list of events they are enrolled in, with no badge. A staff member following a join link into an event that lets staff compete is asked **Compete in this event?** before the row is written; a code requested from the link's own page signs a staff member in without enrolling them, so the question is still asked, and an untagged event admin never sees it. The self-service **Leave** control lives on the waiting page for everybody, so somebody who joins a live compete event through the link has no exit from the participant side — an admin-tier competitor removes themselves from the event workspace's Participants section (**Remove** stays on their own row; the **Manage Participants** shortcut is withheld from a competitor), and anybody else asks an organiser. Switching to participant view lands an admin enrolled in exactly one event straight in it, as a sign-in does.

#### Import / Export

- **Export** — download all participants or challenges as JSON
- **Import** — upload a JSON file to create or update participants/challenges in bulk (it takes the import permission, which a superadmin holds and only a superadmin can give)

### Submissions

An event's **Activity** section (the Submissions list) shows every scoring event across that event — answer submissions and hint reveals in one stream, each tagged with an event pill — including: participant, challenge, the answer (or the fact that a hint was revealed), correctness, points awarded/deducted, and timestamp. Across events, answers and hint reveals are on the **Audit** page.

**A submitted answer to a sealed challenge reads *sealed*** for everyone but the challenge's author, or a superadmin who has revealed it on the record (*Sealed answers* above): a correct submission to a text, JSON, file or multiple-choice challenge **is** the answer key, and on an *Any answer* challenge the response is the only thing there is to protect. The **search box** is redacted on the same per-row rule, so a guessed answer cannot be confirmed by typing it and reading the match count. Ordinary challenges stay fully searchable.

### Rankings

The **Rankings** tab shows the leaderboard for the selected event:
- **Global mode** — single leaderboard for all participants regardless of session
- **Per-session mode** — separate leaderboards displayed side by side for each session

Staff users are excluded from rankings, except on an event whose **Staff can compete** switch is on, where the staff enrolled in it rank like anybody else. Benchmark users are shown in a separate section in the admin view.

Each row carries the participant's **first name, last name, company and email** alongside the nickname (admin-only — the participant board still shows the public handle and nothing else), with a copy button on the three you would paste into an email, and a click-through from the player name into the Participants tab filtered to that person. Every column is sortable, blanks always sorting last in both directions, and a search box above the boards matches nickname / name / company / email across *every* board on screen at once.

**Export CSV** sits on every board — each all-live card, each per-session card, the open event's table, and the Group Rankings table. The file carries what the board shows plus columns that exist **only in the file**: incorrect submissions, points lost to them, hints revealed, points lost to those, the total, the raw millisecond time-to-solve, and **Time on Platform** in both a readable and a millisecond form. Those last two are unconditional and go blank on an event that does not record net active time — a blank cell is not the same claim as a measured zero, and a header whose shape varied by event would make two exports incomparable. On a participant's row `score + total points lost` is the points they earned from solving, so the file explains a net score the board can only state. It writes the whole board rather than the 50 rows on screen, follows the current search, column filters and sort, includes benchmark participants (flagged, with an empty place) and never staff — unless the event lets staff compete, in which case the staff enrolled in it are on the board and in the file like anybody else. Built in the browser from the payload already loaded — like the participants and analytics downloads, and unlike the server-rendered exports, which are reached from the Challenges tab, the Participants tab and the Events row kebab rather than from Settings, it is not audited. The Group Rankings file heads its penalty columns **(team total)**, because those are sums over a team whose score column is a mean.

### Analytics

The **Analytics** tab aggregates per-event signals from the `challenge_events` table into a polished overview of how participants fared with challenges. Powered by [Apache ECharts](https://echarts.apache.org/) (self-hosted at `/vendor/echarts.min.js` — no CDN; loads under the strict CSP via `script-src 'self'`).

**Filter axes** (all combine with AND, refetch is debounced 250 ms on any change):
- **Scope** — segmented control: Global (all events, optionally bounded by a time window), Event, or Session (a specific timeslot of a multi-session event).
- **Time window** (Global scope only) — dropdown: Last month / 3 months / 6 months / year / All time / Custom date range.
- **Event / Session** — picker buttons that open a modal with one card per event (or session) showing name + status badge + start date. Live events sort first, then upcoming (soonest start first), then ended (latest start first), the order every admin event picker uses.
- **Challenges** — picker button that opens a searchable card-grid modal (one card per challenge with #, title, difficulty badge, and tags). Selected challenges are highlighted and sort to the top. Live search filters by title.
- **Difficulty** — Easy / Medium / Hard chips, multi-select.
- **Challenge tags** — a three-mode control (All / Exclude / Only) over the union of all admin-assigned task tags, with the selected tags shown as chips beneath it. Any-match: in Only mode a challenge is included if at least one of its tags is in the selection, in Exclude mode it is dropped if any of them is. Defaults to All.
- **Event tags** (Global scope only) — the same three-mode control over event tags, defaulting to **Exclude `test/dry run`** so rehearsals stay out of the platform-wide numbers.
- **Participants** — a Tags / Groups segmented control. In **Tags** mode, the same three-mode control over participant tags, defaulting to **Exclude `staff`** so organisers are not counted (the per-event **Staff can compete** switch does not change this default — a competing staff-tagged member's activity is still hidden until you include the tag); `benchmark` is simply one of the tags on offer, so including or excluding reference scores is a deliberate choice rather than a default. In **Groups** mode the same three modes apply to participant groups instead.

**Display**:
- **Donut + stat cards** — distribution of the four event types (`solved` / `incorrect` / `hint_revealed` / `navigated_away`), with the centre showing the total event count. The four event-type stat cards on the right serve as the colour key, plus two context cards for unique participants and challenges with activity.
- **Per-question table** — sortable rows with a horizontal stacked-bar mini-chart, total events, per-event-type counts, **unique attempters** and a solve rate (`solved / unique_attempters`). Unique attempters sits immediately before the rate it is the denominator of — a 43% rate over 7 attempters is a different claim from one over 70. It counts PEOPLE rather than events, so it is deliberately excluded from `Total`. Searchable (number / title / difficulty / tag) and paginated at 25 rows, which also bounds the ECharts instances on screen: each row draws its own mini-chart, so an unpaginated 200-challenge bank meant 200 chart instances on one page. **Default order is scope-derived**: per-competition challenge number in an event or session scope, challenge name globally — `task_number` belongs to a (challenge, event) pair and is null outside one. **Export CSV** writes the whole filtered set (not the page) in that same order, client-side from the payload already in hand — there is no server-rendered analytics CSV.

**Impersonation is excluded.** Events produced while an admin was impersonating a participant carry a flag and are filtered out of every one of these aggregates — both successful and unsuccessful actions — so a support investigation never shows up as participant activity. The submissions and leaderboard are deliberately *not* filtered: a superadmin-made solve is a real score change for a real participant, and hiding it from the board would be worse than showing it.

**Event capture**:
- `solved` / `incorrect` rows are written server-side by the existing `/api/tasks/:id/submit` route (alongside the existing `submissions` row).
- `hint_revealed` rows are written by `/api/tasks/:id/hint` on the first reveal.
- `navigated_away` rows are written by the participant client when leaving an opened challenge — `POST /api/tasks/:id/navigated-away` with `via` ∈ `{spa_nav, pagehide, visibilitychange, logout}`. SPA-nav covers in-app transitions; `pagehide` / `visibilitychange` cover tab-close and backgrounding (via `fetch(..., {keepalive:true})` so the request survives unload); `logout` is fired by the explicit Logout button while a challenge is open, **awaited before** the `/api/logout` call so the analytics row lands while the session is still valid. Server-side dedupes back-to-back `navigated_away` events within 2 seconds for the same `(user, task, competition)` tuple. **A SOLVED challenge records none at all**: the route answers `200 {skipped:"already_solved"}` when the caller already has a correct submission for that `(user, task, competition)`, because the signal measures challenges people BOUNCE OFF — solving one, or re-opening it afterwards to review it, is not a departure. The gate is server-side so it holds for a second tab or a stale page; the client additionally stops firing on the solve path. Older rows that fail the rule are removed by a one-time boot migration, so historical counts are on the same basis. **Returning to a still-open challenge re-arms it**, so a tab switch does not permanently retire the signal for that view and lose the participant's eventual real departure.

Data is read live from the indexed `challenge_events` table via `GET /api/admin/analytics/challenges` (admin or superadmin). No pre-aggregation; queries stay under ~50 ms for typical hackathon volumes thanks to compound indexes on `(competition_id, task_id, occurred_at DESC)`, `(user_id, competition_id, occurred_at DESC)`, and `(event_type, occurred_at DESC)`.

### Marketing analytics

The **Marketing** page answers "how is the platform doing overall?" with counts of what it recorded, each beside its denominator — no estimates, no outside benchmarks. It reads `GET /api/admin/analytics/marketing` (`routes/marketing-analytics.js`, every definition in `lib/marketing-analytics.js`): the events whose **start** falls in a chosen range (optionally narrowed by type or to chosen events; dry runs never counted), and in each event the people its boards count (no staff unless the event lets staff compete, no benchmark accounts, no event admins, nothing done while viewing as somebody). Four sections — **Reach** (events, people, new accounts by how they came, countries and companies), **Engagement** (played, answers, solve rate, completion, median active time where measured, returning people), **Outcomes** (certificates by what they record, shares, the Program pass rate and grade bands) and **Pipeline** (the event team reports' leads, only from events that asked the qualifying questions) — and a per-event table whose **Export CSV** writes exactly the filtered rows. It needs the platform-wide permission `analytics.marketing`, which the built-in admin and superadmin hold and an event admin never does.

### Settings

- **Require admin approval for new accounts** — off by default: a new self-registered account is approved when its owner enters their first emailed sign-in code. On, such accounts wait in the approval queue, except one made through a live join link, QR code or event code, or through an invitation from a role that may approve accounts (superadmin only)
- **Break-glass account** — the built-in superadmin's sign-in username (default `superadmin`), typed into the sign-in card's email box. Shown and changed only in that account's own session; the new name is needed from the next sign-in
- **Platform Name** — customize the app name shown in the header, in-app help, email subject lines, and as the **sender name** on outbound email (superadmin only)
- **Unsubscribe List** — review addresses that have opted out of bulk mail, and re-subscribe one after an out-of-band confirmation (superadmin only). Searchable; the list caps at 1000 loaded addresses and says so rather than implying the search covered everything
- **Global Default CxOne Integration** — Checkmarx One API credentials for automatic user provisioning (superadmin only). Removing a deleted participant's account automatically also needs the key to be able to view the tenant's clients; otherwise each removal waits under **Checkmarx One account removals**. Per-**event** CxOne overrides, and the per-competition opt-out that disables provisioning entirely for one event, live on the event form and are **admin-level**; only these global defaults are superadmin-gated. The raw API key is never returned by any endpoint — the admin list exposes `cxone_configured` / `cxone_has_api_key` booleans instead. Provisioning is queued, and a job re-checks its premises while it runs (v8.12.6) — that the participant still exists after every upstream call, and that the event, its opt-out and the membership still hold before the account is created and again before the group is granted: ticking the opt-out, removing the participant from the event or deleting the event stops a job still in flight, so no group is granted afterwards, but never withdraws an account already created; only deleting the participant withdraws (and not even then once the account has passed to another participant still on the platform), and deleting them schedules removal of every account the platform created for them (*GDPR-style "right to be forgotten"*, step 4)
- **Checkmarx One account removals** — the Checkmarx One accounts the platform created for participants who have since been deleted, and could not remove from the customer's tenant, or will not without a decision (superadmin only; a header banner says how many need one). Each row names the tenant, the account, the event, when it was scheduled, the attempts, the last error and what to do; **Retry** (**Schedule removal** on a row that was never scheduled, behind a confirmation that the account will be removed from the tenant), **Remove anyway** (only on a hold a superadmin may overrule — never on an account whose realm record does not match the platform's — and only for the reason its confirmation quoted: if the account has been held for a different reason since, it is refused and the list shows the new one) and **Mark removed** (once it is gone in the tenant). An entry stays until it is resolved, however old; one kept past the retention period says so under **Since**. Hidden on a deployment that has never configured Checkmarx One and holds no such accounts. See *GDPR-style "right to be forgotten"*, step 4

---

## Scoring

| Difficulty | Points |
|---|---|
| Easy | +50 |
| Medium | +100 |
| Hard | +150 |

- **Wrong answer penalty**: -5 points per incorrect submission — except on an **any-answer** challenge, which has no wrong answers: every non-empty answer is accepted (on a pick-one question, any one of its options) and scores the challenge's points on the first submission, an empty answer or anything else a pick-one question does not offer is refused without penalty, and there is no hint to reveal
- **Hint reveal**: deducts 30% of the challenge's point value (e.g. -15 for Easy, -30 for Medium, -45 for Hard)
- **Attempt caps** (optional): a challenge or a whole event can carry a maximum number of submissions per participant — the challenge's cap wins where both are set, and leaving both blank means unlimited. Only a stored submission spends one, so a de-duplicated re-send or a throttled request costs nothing, and revealing a hint never consumes an attempt either. The challenge's own attempts line updates after every wrong answer — including after a re-send folded into an earlier one, which reports the count the earlier answer left (it is usually a retry after that answer's reply was lost), so the **Last attempt** warning appears before the answer that would use it. Once a participant is out of attempts the challenge refuses further submissions with no further penalty, and the locked panel says so rather than leaving an input that can only be refused; **Next challenge** on a solved challenge passes it over. An admin can grant extra attempts to named participants from **Grant Attempts** in the challenge's row menu, which is also permitted on an event that has already ended — that grant is what un-finishes an exhausted participant so the event can be reopened.
- **Leaderboard ranking**: sorted by score (descending), then by finish time (ascending). Among tied scores, the participant who took less time to solve challenges ranks higher.
- **Net active time as the tie-break** (optional, per event): an event that records time on platform can break score ties on that instead. Every participant who finished everything then ranks above every participant who did not, finishers are separated by the time they actually spent on the platform (less is better), and every other pair falls back to elapsed time. It is off unless the event opts in, and a Booth Event cannot opt in at all — over a 45-minute stand there are only nine five-minute blocks, so everyone who stayed the course would tie and the number would separate nobody.

---

## Security

- **Auto-generated secrets** — session secret and superadmin password are randomly generated on every startup; no hardcoded credentials
- **Single session per user** — logging in from a new browser/device invalidates all previous sessions. Since v8.12.6 that includes an admin's attachment upload or import still arriving in the old session, and since v8.12.7 an **At the desk** sign-up or a maintenance seed still preparing its rows: if the session ends before the write — the admin signs in elsewhere, signs out, or switches view or enters/leaves impersonation in another tab; a colleague moves the account to another admin tier (a role change signs every session out); or the session idles out — the write is refused (`401 admin_session_ended`, "Your session ended before this finished, so nothing was saved. Try again — if you are asked to sign in, do that first.") rather than letting a session that no longer exists finish it. The sentence names no cause, because the platform only knows that the session ended, not whose act ended it — so an admin who starts a large upload on a laptop and signs in on a phone has to upload it again. A participant's own write that keeps awaiting after its guard — a file answer, a password change or first password, a certificate — is held to the same rule: a session ended before the write (signed in elsewhere, the password changed in another browser, signed out) is refused `401 session_ended` with the same sentence, nothing stored. Its late response never re-sends the ended session's cookie, so it cannot sign out a session that has since replaced it in the same browser, and a tab whose session another tab replaced for the same account fetches a token for the live one, so trying again works. Nor does such a tab's next write (its 30-second keepalive included) sign both tabs out with its stale token any more: every tab publishes a fingerprint of each token it is issued (localStorage `ha:csrf-fp`, never the token), and a tab whose own token no longer matches asks `GET /api/session/status` before it writes — the same account acting as itself in the same view (`admin_view`) gets a token for the live session; anything else is told *This tab is out of date* and sends nothing, Reload opening the session now in force. Within one tab, a request that replaces the session (the view switch, impersonation in or out) waits for the tab's writes already on their way, and the tab's other writes wait for the new session's token, so none of them is refused with the old token (a refusal that would end the new session). If the other tab signed in as somebody else or entered impersonation, no token is fetched, so the retry can never be saved under that account
- **A revoked admin cannot finish a write already in flight** — every admin request re-reads the account, but the challenge-attachment uploads and the superadmin imports keep reading and awaiting after their guard has answered (the body, the ZIP walk and move, the import's hashing pool), and the **At the desk** shortcut and the maintenance seeder prepare rows before they write. They re-ask the acting admin's lifecycle and role once more at commit (`adminAuthzDenied` — grep it for the set rather than trusting a list here), synchronously with the first write, so an admin blocked, denied, demoted or deleted mid-request is refused `403 admin_access_revoked` ("Your administrator access has ended, so nothing was saved.") with nothing written and any moved file reclaimed; under impersonation both the superadmin's hand and the organiser's seat are re-asked. At the desk the commit also re-reads the event and re-asks the competitor lock, the scope (on a freshly read role and grant set), the address and the admission, so an organiser whose grant on the event is revoked, or who starts competing in it, while the account is being prepared creates nothing and is shown no sign-in code. **The same holds for a participant write made through impersonation**: the two that keep awaiting after their guard — a file answer (the upload) and a certificate mint (its render) — re-ask the impersonating admin at commit (`impersonatingHandDenied`), so an admin revoked mid-request is refused `403 impersonation_ended` with nothing stored: `reason:"session_ended"` if their session was ended meanwhile, `reason:"actor_inactive"` (and the impersonation session ended) if they are no longer an admin at all, and `403 impersonation_readonly` if they are still an admin but no longer a superadmin — except on the mint, which the read-only tier may make. A password or sign-in method is never set through impersonation, by any tier, and an account's emailed-code and password sign-ins are refused from inside one. The participant's own account is re-asked at commit too (`participantSessionDenied`): a blocked, denied or deleted account is refused with the participant gate's sentence, and under impersonation an account that stops qualifying gets the gate's forced exit (the admin's own session restored, the window closed `target_inactive`); the mint also re-asks the membership. Before this, a superadmin blocked mid-import could still mint accounts — including a verified superadmin — from the file. Behind a reverse proxy that buffers request bodies (nginx's default) the upload half of the window is small; the participant import's hashing pool is a window inside the server that no proxy closes
- **CSRF protection** — every state-changing request requires a CSRF token except three that carry no session authority and are built to be posted from outside the SPA: `POST /api/unsubscribe` (an HMAC-signed one-click link from an email), `POST /credential` (the JavaScript-free verification form) and `POST /api/csp-report` (sent by the browser itself). An invalid token from a signed-in caller destroys that session and forces re-login — the built-in superadmin's included (until v8.13.4 it survived, so the app said "Signed out" and a reload put the operator back in the admin panel), and an impersonation session closes its window on the participant's History first. An anonymous session — the one that exists only to carry a token for the login card — is kept, because destroying it takes away the very session the retry needs and turns one stale token into a login card that can never recover
- **A password or an emailed code, per account** (operator ruling, 11 Nov 2026) — `users.login_method` is the person's own choice (**Profile → How you sign in**); while they have not chosen, the role decides: an unscoped admin role (built-in `admin` and `superadmin`, and every custom role not scoped to events) signs in with a password, every other role with a code. A role change never overrides a choice. **Codes:** an emailed 8-character single-use code (sha256 at rest, ten-minute window, three sends per window, at most two of them from one network origin, and never re-sent within two minutes, so a double-submit cannot cancel the code in the inbox). **Passwords:** bcrypt, at least 8 characters and at most 72 bytes (bcrypt reads no further); a password counts only once its owner has set one, so an account created without one, or imported, has none (except an account that already existed without one when v6.20 added the marker — an imported one, say — which that upgrade marked as having one: it signs in with **Email me a code instead** and then sets a new password). Choosing a password when none is stored sets it there and then (a stored one is reused); changing an existing one needs the current password, unless the session signed in with a sign-in code (an emailed one) in the last ten minutes (the recovery for a forgotten one). Setting or changing a password emails a notice to the primary address, and a change signs the account's other sessions out. **A password never closes the code door:** every account row can still ask for a code (**Email me a code instead**), so a forgotten password is never a dead end; switching to codes keeps the stored password but the password door refuses it while the method is code. The password door (`POST /api/auth/password`) answers 200 for every outcome and costs one bcrypt whatever the outcome; it names a reason (`pending_approval`, `verify_by_code`) only after a correct password, and, unlike an emailed code, it never verifies or approves an account, claims invitations or enrols through the event a code request named: only an emailed code proves the inbox. **Every sign-in door resolves the primary address only**: a secondary address never signs in, never receives a code, and an invitation or an **Add user** for an address held only as a secondary is refused. **An accepted trade-off** (operator ruling, 11 Nov 2026): the entry screen's lookup (`POST /api/auth/sign-in-method`) tells whether an address belongs to a password account (by default every unscoped admin); unknown, code, blocked and denied addresses all answer "code". **The break-glass account:** `POST /api/login` accepts only the break-glass username (a setting, default `superadmin`), typed on the ordinary sign-in card, with the boot-generated password, and answers every other pair — an old name, any address, a wrong password — with one byte-identical 401; the card gives every non-address the same password box and asks the server nothing, so it never confirms the name. It is the only account with no code door.
- **Account lockout** — one failure budget per account, shared by codes and passwords: 10 wrong sign-in codes, wrong passwords or wrong current passwords (in **How you sign in**) within 5 minutes lock the account for an hour, and the account holder is emailed when it locks. A lock is an alarm, not a barrier: a **correct** code or password still signs the holder in while locked and clears the lock at once, so nobody can lock a participant out of their own account by guessing. A wrong code or password at sign-in while the account is locked is refused and not counted again (a wrong current password under **How you sign in** still counts, and re-locks the account). What limits guessing is the rate limits below
- **Rate limiting** — registration (10/min per IP), sign-in code requests (5 per 15 min per `(IP, email)`, with a per-IP backstop of `RATE_LIMIT_LOGIN_IP_BACKSTOP_PER_MIN` × 15), address proofs for addresses no account holds (**150 per 15 min per IP**, `RATE_LIMIT_PROOF_IP_PER_15MIN`, refused silently: the answer stays `{ok:true}` and the refusal is audited, so the budget reveals nothing about which addresses have accounts, and one source cannot make the platform mail any number of new addresses), code redemption (10/min per `(IP, email)`, with the same **600/min per-IP backstop** as the password doors, `RATE_LIMIT_LOGIN_IP_BACKSTOP_PER_MIN`), nickname check (30/min), the password doors — an account's password sign-in, the entry screen's sign-in-method lookup and the break-glass `/api/login` (**60/min per `(IP, name)`**, the address or the break-glass username, so a roomful of distinct accounts behind one venue/NAT IP don't share a bucket, with a coarse **600/min per-IP backstop** on each door, `RATE_LIMIT_LOGIN_IP_BACKSTOP_PER_MIN`; both ceilings are env-tunable, and `RATE_LIMIT_ALLOWLIST_IPS` and an event's trusted networks bypass them for known egress IPs — the per-account lockout after 10 failed attempts in 5 min raises an alarm beside them and refuses no guess), setting or changing a password or the sign-in method (20 per 15 min per `(IP, account)`), `/verify` (30/min — slows enumeration of verify_code values), `/api/admin/logs` (60/min — slows scripted log exfiltration from a compromised admin token), `/api/admin/audit` (60/min — each read walks the audit tables on the one thread; its count is also taken on the first page only and stops at 10,000 matches, and a walk no index serves, such as a free-text search, examines at most the newest 20,000 records of each type per read, saying how far back it searched and continuing on **Load more**). `RATE_LIMIT_DISABLED=1` turns every limiter off (set by the Playwright harness).
- **Scanner / abuse-scan protection** — a global IP-reputation tracker watches the aggregate 4xx response rate per source IP. When a single IP trips `_SCANNER_4XX_THRESHOLD` (100) across the rolling `_SCANNER_WINDOW_MS` (10 minutes), subsequent requests from that IP get `429 Too Many Requests` with a `Retry-After` header for the full `_SCANNER_BLOCK_MS` (15 minutes). The per-endpoint limiter above covers a small set of hot routes; this global tracker catches the *other* scanner pattern — one source hammering dozens of distinct URLs looking for `/wp-admin`, `/.env`, `/phpmyadmin`, etc., all 404s from the static fallthrough that no single per-endpoint limit would see. Legitimate polling (`/api/me` + `/api/admin/me` at 15-second intervals, CSRF typos, etc.) stays well under the threshold even on multi-tab sessions. **The traffic is CLASSIFIED, and only an ambiguous block is announced.** `lib/scanner-classify.js` splits the window's countable 4xx into probes (unrouted 404s, using Express's own `req.route` as the signal rather than a path list that goes stale as the app grows), routed 4xx (a real endpoint of this platform answered — the adversarial guard, capped at 5) and everything else. A block is silenced on either of two arms, both sharing the routed-4xx guard. The **signature** arm: probe ratio >= 0.80, >= 8 distinct probe paths, <= 5 routed 4xx, and >= 3 distinct known-bad signature paths. The **scale** arm: probe ratio >= 0.90, >= 40 distinct probe paths, >= 80 probe hits, and the same <= 5 routed 4xx. The second exists because whole modern scanner families — Tomcat, Fortinet, CouchDB, Liferay, every random-junk fuzzer — match none of the hand-written signature list, and extending that list is a blocklist over an adversary-chosen space that its own header concedes will go stale. The routed-4xx ceiling is the same constant on both arms rather than a copy, because it is what stops an attacker padding credential stuffing with junk 404s to buy silence. Which arm decided rides the log line, the `scanner_blocked` audit event and the block state as `silence_basis`, so a silent block says why it was silent. Silence therefore requires positive evidence of malice, and anything ambiguous still raises the operator alert (email + in-app modal) — the failure directions are not symmetric, and staying quiet about a venue is far worse than an email nobody needed. An address meeting the **signature** arm is also blocked EARLIER, at `PROBE_EARLY_THRESHOLD` (25 probe hits) rather than 100; the scale arm's own 80-hit floor dominates that threshold, so a walk carrying no known-bad signature blocks at 80 — less evidence, more volume. Well-known browser paths (`/favicon.ico`, `/robots.txt`, `/.well-known/**`, ...) are excluded from the probe count entirely, so a roomful of freshly-opened browsers cannot be mistaken for a scan. **Silent is not invisible:** every block, silenced or not, still emits the `warn`-level entry ("Scanner detected — IP blocked") visible in the Audit-log stream of Raw logs (the admin Audit page), and a `source:"audit"` row tagged `scope:"security"`, `event_type:"scanner_blocked"`, `scope_id:<ip>` carrying the verdict, the probe statistics and a few sample paths (scrubbed of any capability-bearing token). `/metrics` carries `hack_arena_scanner_tracked_ips`, `_scanner_blocked_ips`, `_scanner_blocks_total{verdict=...}` and `_scanner_blocks_silent_total`. 429 responses themselves do NOT re-enter the counter, so a blocked IP can't indefinitely prolong its own block, and a live block survives the counting window rolling over. Bypassed by the same `RATE_LIMIT_DISABLED=1` knob the per-endpoint limiter uses.
- **Security headers** — HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy. The CSP has **no third-party origin** — all assets (fonts, highlight.js) are self-hosted, so `script-src`/`style-src*` are `'self'` only — plus `base-uri 'self'` + `form-action 'self'` to block `<base>` and `<form>` injection. The obsolete `X-XSS-Protection` header has been dropped (modern browsers ignore it; some old values actively enabled exploits).
- **Trusted Types enforced, three policies** — CSP declares `require-trusted-types-for 'script'` and allows three policies (`trusted-types app-html vendor-script-src default`):
  - **`app-html`** — the application policy, a pass-through that sanitises nothing. `setSafeHtml(el, html)` routes every HTML write in the SPA through it (and `setSafeSrcdoc` the sandboxed frame of the event team's email preview). App code must always go through them; bypassing them is a bug, and `tests/html-sink-escape.spec.js` fails on any `innerHTML`/`outerHTML` write or `insertAdjacentHTML` call in `public/js` outside `core/trusted-types.js`.
  - **`vendor-script-src`** — a named policy whose `createScriptURL` admits exactly the two self-hosted bundles loaded at run time (`/vendor/echarts.min.js` for Analytics, `/vendor/qrcode.min.js` for the join QR's fallback) and throws on any other URL; the two lazy loaders set `<script>.src` through it.
  - **`default`** — a tightly-scoped vendor-compatibility policy. Required because the self-hosted ECharts build (`/vendor/echarts.min.js`) writes `innerHTML` internally for tooltip / hidden-DOM scaffolding and has no hook to adopt a named policy. The default policy's `createHTML` is a passthrough so ECharts works; but `createScript` and `createScriptURL` **throw TypeError**, so app code (or a future vendor lib) that accidentally assigns to a script sink or dynamic script-src still fails closed at the browser layer. The guarantee is deliberately narrow: raw HTML writes from app code are not rejected at the TT boundary (the default policy wraps them), but script-level code injection is, and `app-html` is the only legitimate route the application itself should use. Combined with the absence of `script-src 'unsafe-inline'`, the SPA's DOM-script-injection surface is essentially closed. Trusted Types guards no HTML write, since both HTML policies pass HTML through unchanged: HTML safety rests on escaping every value before it reaches a sink (`esc()`, checked at every sink by `tests/html-sink-escape.spec.js`) and, for rich text, on the server-side sanitiser.
- **No `script-src 'unsafe-inline'`** — every `onclick="…"`, `onchange="…"`, `onkeydown="…"`, `onmouseenter="…"`, `oncopy/oncut="…"` etc. across the SPA (~390 sites under `public/js/**`) and `public/index.html` (~213 sites) is replaced by a `data-action` / `data-change-action` / `data-input-action` / `data-enter-action` / `data-mouseenter-action` / `data-block-clipboard` attribute, dispatched from a single document-level listener wired in `public/js/core/main.js`. Handlers register themselves via `registerAction('name', fn)` (`public/js/core/dispatcher.js`) and read their arguments from the clicked element's `data-*` attributes, so no `'${esc(c.name).replace(/'/g,"\\'")}'` triple-escape pattern is needed in a template string. With no inline event handlers anywhere in the codebase, `script-src 'unsafe-inline'` is removed from the CSP: an attacker who manages to inject `<button onclick=…>` or `<img onerror=…>` through a missed escape **cannot execute the handler at all** — the browser blocks it at the CSP layer. The dispatcher also auto-closes an open kebab when a kebab-menu item fires, so individual handlers don't need to chain `closeKebab()`.
- **`style-src` split into `style-src-elem` / `style-src-attr`** — `'unsafe-inline'` is **dropped from `style-src-elem`** (which controls `<style>` blocks and external stylesheets), so an injected `<style>` block — even if it ever slipped past the server's tag whitelist — cannot apply CSS at all. The SPA's own CSS lives in `public/styles.css`, and the app ships no inline `<style>` block at all. `'unsafe-inline'` is **retained on `style-src-attr`** (which controls inline `style="…"` attributes only) because the SPA still uses ~650 inline style attributes in template strings and DOM-level `el.style.x = …` assignments. Inline-attribute CSS is much lower-impact than `<style>`-block CSS (no attribute selectors for keystroke logging, no global rule injection), and the main exfiltration vector — `background-image: url(attacker.com)` — is already blocked by `img-src 'self' data:`. The legacy `style-src` directive is retained as a fallback for the very few user agents that don't yet honour the split directives.
- **CSP violation reporting** — browsers POST any CSP violation (blocked inline script, Trusted Types misuse, disallowed form action, etc.) to `/api/csp-report`, which logs the directive, blocked URL, source file, and line number in the app log. A report whose `source-file` or `blocked-uri` carries a browser-extension scheme (`chrome-extension:`, `moz-extension:`, `safari-web-extension:`, `safari-extension:`, `ms-browser-extension:`, `webkit-masked-url:`) is a third party's add-on injecting into whatever page the visitor happens to be on rather than anything this platform served, so it is re-attributed to `debug` with `attributed_to: "browser_extension"` — not discarded, and fully recoverable by lowering `LOG_LEVEL`. In practice that is the bulk of real-world reports. Everything else stays at `warn`, so admins can see real-world XSS attempts via `GET /api/admin/logs?stream=app&level=warn`, and both classes are counted separately on `/metrics` as `hack_arena_csp_reports_total{origin="app"|"browser_extension"}` — which is what stops the filter becoming a hiding place.
- **Docker hardening** — dropped capabilities, no-new-privileges
- **SQLite busy timeout** — 5 seconds (`busy_timeout`). It governs a writer in ANOTHER process holding the database — an operator's `sqlite3` shell, `scripts/purge.sh --apply` — which the server waits for instead of failing at once. It plays no part between two requests: `better-sqlite3` is synchronous and the platform is a single process, so a request never meets another request's lock — it waits for the event loop. Nor does it cover every case: a transaction that reads before it writes opens as a DEFERRED `BEGIN` and, under WAL, gets `SQLITE_BUSY` at once when another process holds the write lock (the busy handler is not consulted for that upgrade), which is why a write whose spurious failure would refuse a user takes the lock up front instead (`.immediate` — the sealed-answer reveal record, v8.12.6)
- **Rich text sanitization** — participant-facing HTML content (challenge descriptions, hints, explanations) is sanitized twice: once on write (`lib/sanitise.js` — drops disallowed tags and attributes, accepts only `https?:` for `<a>` href and `data:image/` or `/api/images/` for `<img>` src, forces `target="_blank" rel="noopener noreferrer"` on every hyperlink), and once on read in the browser (`public/js/ui/richtext.js: renderRich` — same whitelist, re-validates URL protocols, strips any `on*` event-handler attribute that slipped through, and keeps only a tint and alignment on a table's header, body or footer, which older content may carry unfiltered). Tables are supported on both sides from **one shared allowlist**, with `colspan`/`rowspan` clamped (sanitize-html validates attribute *names*, never their *values*, so an unclamped `colspan="100000"` would reach every participant's browser as a layout bomb) and styles restricted to a regex-validated set with no `url()`: every tag that may carry a style has its own rule (a table's header, body and footer take only a tint and alignment), and a tag without one keeps no style at all. A colour picked in the editor is stored as a **name**, the custom property that draws it (`color:var(--rt-red)`, `background-color:var(--rt-hl-yellow)`, from one list both sides share): the server admits a literal colour or exactly a listed name's `var()` and drops every other `var()`, and each look draws a name in its own measured shade, so coloured text stays readable by day and at night, while colours already stored as literals are kept as they are. Image width is bounded by **CSS**, not by an inline style — the server's `<img>` transform emits only `src`, and the client renderer deliberately drops an image's `style` rather than validate it. Authors who paste images into the editor get the data URI extracted to the `images` table on submit; the stored description carries `<img src="/api/images/<uuid>">` instead of the data URI, and `GET /api/images/{id}` serves the bytes back with the original Content-Type, `Cache-Control: private, max-age=86400` and the image id as a strong ETag (a browser revalidates after a day: 304 while the picture exists, 404 once it is deleted).
- **Import atomicity** — the **challenge** import is wrapped in a single database transaction: a failure in any row rolls back the entire import. Its rich-text sanitising (each row's description, explanation and hint) runs first, outside that transaction, in slices of about 20 ms that let other requests through, so the server is held only for the transaction itself (measured on a developer machine: about 3 s for 10 000 challenges); storing the images embedded in that text stays inside the transaction, so an import that fails, or is refused at its commit-time re-check, stores none of them. The **participant** import deliberately is not: it commits in **100-row chunks**. The reason once given here — that one transaction held `BEGIN IMMEDIATE` and starved live `/submit`, `/hint` and admin edits on the 5-second busy timeout — was never the mechanism: `better-sqlite3`'s `db.transaction` opens a DEFERRED `BEGIN`, not `BEGIN IMMEDIATE`, and the whole chunk loop runs synchronously inside the one server process, so a live `/submit` waits on the blocked event loop for the length of the import either way and meets no lock at all (measured on a developer machine: one to two seconds for 5 000 rows; the conflict check before the chunks finds each address with two index searches, so it does not grow with the number of accounts already on the platform). What the chunks do buy is that the write lock is released every 100 rows, so a writer in another process (an operator's `sqlite3` shell) is held off for one chunk rather than for the whole file — and the partial-commit behaviour that follows. A failure in chunk K therefore leaves chunks 0..K-1 **persisted**, and the 400 response carries `partial: {imported, overwritten, skipped, …}` saying exactly how far it got; the admin UI renders those counters and reloads the table rather than reporting a flat failure (before that, both client paths discarded them). Re-running the corrected file is safe: rows that already landed come back as conflicts on the next dry run. Every field the importer binds is shape-checked BEFORE the first chunk commits — including the lifecycle and audit columns (`role`, `created_at`, `login_time`, `locked_until`, the approval / denial / invitation ladders) — so a value SQLite cannot bind refuses the file with the row named rather than throwing out of chunk K and leaving 0..K-1 committed under a message that says nothing. An unrecognised `role` is a separate case: it is well-typed but not a role the platform knows, so it is DROPPED and counted (`invalid_roles_dropped`) rather than refused — a new account imports as a participant and an existing one keeps its current role, so a malformed file cannot demote an admin.
- **Invitation claim atomicity** — `POST /api/register` with an `invitationId` runs the `UPDATE invitations SET used_at=…` claim step *first* inside a `better-sqlite3` transaction, and only then inserts the user row and event assignments. Two concurrent requests for the same invitation cannot both create users: the loser sees `changes=0` on the `UPDATE`, the entire transaction (including any pending `INSERT` statements it already ran) rolls back, and the response is a clean `409`. CxOne provisioning remains async/best-effort but runs *after* the DB transaction commits, so upstream latency can't widen the race window.
- **Guard rails on destructive admin actions** — a live event can only be deleted while nothing has happened in it, and only by a superadmin; once anyone has joined, submitted, revealed a hint or been marked absent it must be ended first. A participant actively competing in a live event is refused by default, with the refusal naming the event; a superadmin can confirm the deletion anyway in one step rather than hunting for the event to remove them from first, and the override is stamped on the audit event so it is never indistinguishable from an ordinary deletion
- **Inactivity-based session expiry with sliding keepalive** — session cookies are issued with a 1-hour maxAge. Two things slide it, both requiring evidence of a real person. (1) Every 30 seconds the client checks the session *without* extending expiry — with `GET /api/session/status`, or, while a participant is in an event, from the session half of the pulse (`GET /api/participant/pulse`) when the last pulse is fresher than that; a hidden tab asks at most every two minutes — and calls `POST /api/session/keepalive` on either of two conditions — it detected real user activity (mousemove, keydown, click, scroll, touch) within the previous 60 seconds, **or** the participant is inside an event that is still running — but only once less than 55 of the session's 60 minutes remain, so an active session's row is written about once every five minutes rather than on every check (the cost: an active user who then goes idle is signed out up to five minutes early, after the usual warning). The second arm is not redundant: at a hackathon people background the tab to work in their IDE, so the activity gate starves and a 60-minute session expired mid-competition. It self-bounds, because the poll that refreshes the event's end time stops when the event does. Together these are what keep a read-only browsing session alive. (2) An authenticated **state-changing** request (POST/PUT/PATCH/DELETE under `/api/`) slides it server-side too, as a backstop for when the client's activity monitor can't be trusted; a write is unambiguous evidence someone acted. GET requests deliberately never slide it — a parked tab polls GETs forever, so sliding on those would mean nobody with the app open is ever signed out for inactivity. Five minutes before expiry the client shows a countdown dialog with **Stay logged in** / **Logout now** buttons. When the session eventually expires, the next poll surfaces a "signed out due to inactivity" dialog that redirects to the login page after acknowledgement. A session the platform ended says so instead: any purge (a password changed in another browser, an organiser's block, deny or delete, a role change) gets a neutral "You were signed out" that names no cause — never "inactivity". A sign-out in another tab of the same browser is named too: the tab that signs out leaves the fingerprint of the session's CSRF token in localStorage (`ha:signed-out-fp`; no identity), and a tab holding that very session says "You signed out in another tab of this browser" (unless the server recorded another cause; the note is withdrawn if the sign-out request fails or a token is issued for that session again). "Signed in elsewhere" gives the advice the account can follow, from its sign-in method (`kicked_by.passwordless`): an account that signs in with codes is told to tell an organiser and make sure nobody else can get into its email; an account that signs in with a password, to sign in with an emailed code (**Email me a code instead**), change its password under **Profile → How you sign in** and tell an organiser; the built-in superadmin, to restart the platform, which gives it a new password.
- **Server-restart detection** — `SESSION_SECRET` is regenerated on every startup, so existing cookies become invalid after a restart. The client snapshots `server_started_at` from `/api/config` at boot and compares it against `/api/session/status` on **both** sign-out discovery paths: the 30-second session poll, and the fetch interceptor that handles a 401 from any other request. When the value has changed the client shows a "server restarted" dialog rather than the generic inactivity one, and redirects to the login page. (Both paths share one classifier, so whichever fires first cannot misreport a restart as an inactivity timeout.)

### Audit Trail

Every admin action on events, timeslots, challenges, participants, and settings is recorded. Events / timeslots / users / settings land in dedicated audit tables (`competition_events`, `timeslot_events`, `user_events`, `settings_events`); challenges land in `task_versions` (below). Each event stores the `changed_by` identity (admin email or `"superadmin"`), an ISO 8601 timestamp, a structured `details` payload, and a machine-readable `event_type`. For state-change events (`edited`, `visibility_toggled`, `locked`, `published`, `effective_end_shifted`, etc.) the `details` object carries a `changes: {field: {from, to}}` diff so a reviewer can see *what* moved, not just that something moved.

Challenge history is tracked via snapshot-based versioning in `task_versions`. Every save creates a new version snapshot that includes the full challenge state (title, description, answer, tags, etc.), and superadmins can restore any previous version in one click. Each version also generates an `audit:task:<event>` row in `app.jsonl` — semantic `event_type` names: `created`, `edited`, `published`, `visibility_toggled`, `locked`, `unlocked`, `restored`, `tag_added`, `tag_removed`. The original `change_type` column value (matching the `task_versions.change_type` enum) is preserved in `details.change_type` for history-dialog compatibility.

Read-only admin API endpoints expose the event history per entity:

| Endpoint | Events covered |
|---|---|
| `GET /api/admin/competitions/{id}/events` | Event lifecycle (create, edit, manual/auto start/end, revive), participant assignments (add/remove, first-join), task assignments, CxOne config, timeslot add/delete. **Participant scoring activity**: every `submission_correct` / `submission_wrong` (with task_id, user_id, nickname, points_delta), every `hint_revealed` (with task_id, user_id, nickname, points_deducted), every `feedback_submitted` (with task_id, user_id, nickname, rating, is_update, previous_rating). The `auto_ended` event's `details.reason` disambiguates timeout-based ending (`scheduled_end` set) from last-participant-solved ending (`reason: "all_participants_solved"` or `reason: "last_timeslot_ended"`). |
| `GET /api/admin/competitions/{id}/timeslots/{tsId}/events` | Timeslot lifecycle (create, edit, manual/auto start/end, revive, first-join). Also mirrors scoring activity (`submission_correct` / `submission_wrong` / `hint_revealed`) when the submitting participant is in this timeslot. |
| `GET /api/admin/participants/{id}/events` | Admin actions (verify/approve/role changes/block/unblock/unlock/sign-in codes emailed or shown at the desk/tag changes/profile edits/competition add-remove) PLUS user-initiated activity: self-registration, self email-verification, logins (with IP, user-agent, and count of terminated concurrent sessions), manual logouts, auto-lock/unlock, self profile updates, a password set or changed and sign-in method changes, session selections, first-join of a live event, reminder requests + reminder sent/cleared, every email sent (with reason & success/failure), CxOne provisioning, **scoring activity** (`submission_correct`, `submission_wrong`, `hint_revealed`, `feedback_submitted`, `feedback_removed`). Session-lifecycle: single-session enforcement inline on `login_success.details.terminated_sessions`; separate `sessions_invalidated` events record every other end of the account's sessions, with `purged` the number ended — `role_change`, `blocked` and `denied` end ALL of them; `password_changed` (a changed password under **How you sign in**) ends the OTHER sessions and keeps the one that asked, and setting a first password ends none; and `csrf_invalid` records the end of the one session that presented an out-of-date security token — on the account's own row, on the ACTING admin's row when it was an impersonation session (whose window is closed first, `impersonation_ended` landing on the target), or as an orphaned `session`-scope line with `principal:"superadmin"` for the built-in superadmin. (Corrected in v8.3.36: `self_email_change` never existed in the code, and `email_change` went with the admin route's immediate write — an admin email change is staged now, so nothing is signed out.) An admin's **Email sign-in code** or **Show sign-in code** ends no session. For immediate session eviction, use the Block action. Competition-context: `competition_session_cleared` when an admin removes the user from a comp they were inside. Email-change staging: `email_change_requested{pending_email:<addr>, via:"admin_edit"}` when an admin stages a primary correction (the participant's own request carries no `via`). There is no rollback event — nothing is committed to roll back. Navigation: `active_competition_changed`, `joined_competition_session`, `ended_popup_dismissed`. Admin-view toggle: `admin_view_toggled` with `details.mode` ("admin"/"participant"), `details.is_admin.from/to`, `details.is_superadmin.from/to` — captures when an admin, superadmin or event admin drops into participant-view for testing or returns to admin-view; while an event admin is impersonated, the toggle is recorded on the TARGET's row attributed to the acting admin, with `details.impersonated_by` and `details.acting_as`. Impersonation: `impersonation_started` (with `target_role`, `view`, `read_only`) and `impersonation_ended` (with `reason`, `duration_ms` and the `view` in force at the close), both on the target's row attributed to the acting admin; every audit row written under impersonation carries `details.impersonated_by` and `details.acting_as` — except the two rows that land on the acting admin's OWN History, `logout_manual` (from Logout) and the `csrf_invalid` `sessions_invalidated` row, which carry `acting_as` but not `impersonated_by` (it would name them as their own impersonator). Verify-code cleanup: `verify_code_expired`. |
| `GET /api/admin/settings/events` | Platform name and CxOne settings changes |

All four endpoints support pagination via `?offset=<n>&limit=<n>` query parameters (default 500, explicit opt-in cap 5000). When pagination params are supplied, the response is `{events, total, offset, limit}`. Without params, a plain array is returned (capped at 500) for backward compatibility.

**Scheduler.** An in-process 60-second scheduler observes events and timeslots and emits `auto_started`/`auto_ended` events whenever a status transition occurs (upcoming → live, live → ended). The first observation after deployment only bootstraps baseline state and never emits events retroactively.

**A sealed answer never reaches the trail.** When a sealed challenge's answer is edited, the `changes` diff records `(sealed answer changed — visible to its author, or to a superadmin who has revealed it, in the challenge editor)` in place of the before/after values; its explanation and hint, being rich text, record `(body changed — see task_versions)` as every rich-text field does, sealed or not. It is written that way rather than redacted on read, so the value is absent from the audit row and from its `app.jsonl` mirror **on disk** — for backups and log shippers as well as for readers, superadmin included. The `task_versions` **snapshot** still stores it and is redacted per reader instead, which is what makes the seal retroactive over versions taken before it. A superadmin's **reveal** of a sealed answer (v8.12.2) is on the trail as `sealed_answer_revealed` — the act, the field NAMES, the request context and, under impersonation, `impersonated_by` / `acting_as` — never the values.

**Bulk-operation correlation.** Bulk actions (bulk-approve, bulk-assign, invitation send, imports) emit a shared `details.batch_id` (UUID) on every event they produce so a bulk action can be identified as a single operation in audit trails.

**PII note.** Login events include the client `ip` and `user_agent`. Retention is **bounded** — the `*_events` tables auto-purge rows older than `EVENT_RETENTION_DAYS` (default 730 = 2 years) via the daily job described under *Audit-event retention* above; adjust the window to your policy, and use `scripts/purge.sh` for the log files + other rotation-friendly tables. If the server runs behind a reverse proxy, ensure the proxy sets `X-Forwarded-For` **and** set the `TRUST_PROXY` env var to match your proxy chain (see the "Reverse-proxy configuration" table earlier in this README). Without that, `ip` resolves to the proxy's address rather than the client's. `TRUST_PROXY` defaults to `false` so a direct-to-app deployment isn't spoofable.

The admin UI surfaces these events through a **History** action in the kebab menus of the Events, Participants, and Challenges panes. The dialog displays **Type**, **When**, **By**, and **Change** columns (with an additional **Action** column for challenges that surfaces the **Restore** button per version). The **Change** column renders a before→after diff for edits and a human-readable description for other event types (e.g. `+ participant: Alice`, `role: participant → admin`, `Login successful from 10.0.0.5`). The dialog is sortable, searchable, and paginated at 30/50/100/200 rows per page, with default sort on the timestamp column descending — matching the UI conventions of all other admin panes. When the entity has more events than the initial 500-event fetch, a **Load older** button appears at the bottom of the dialog.

**Deletion audit.** Entity deletions can't be recorded in that entity's event table (the entity and its event history are gone). Instead they emit an **orphan audit row** to the app log (`app-YYYY-MM-DD.jsonl` — see Server Logs below), and a copy of it to the `orphan_events` table that the **Audit** page lists (purged after `EVENT_RETENTION_DAYS`), via `recordOrphanedAuditEvent()` — same shape as every other `source:"audit"` row (`scope`, `scope_id`, `event_type`, `changed_by`, `details`), discoverable with the same `jq 'select(.source=="audit")'` filter. The emitters: `scope:"competition" event_type:"deleted"`, `scope:"task" event_type:"deleted"` / `"feedback_purged"`, `scope:"user" event_type:"deleted"`, `scope:"image" event_type:"purged"`. The `details.cascaded` object counts the child rows removed in the same transaction. Single-user feedback removal additionally emits a `user_events.feedback_removed` row against the affected participant; bulk purge emits one per user plus the task-scope summary. To keep the DB tidy, the delete transactions also wipe the child rows in `competition_events`, `timeslot_events`, and `user_events` that would otherwise be unreachable from the UI; a one-time startup migration cleans up any pre-existing orphans from legacy databases.

### Server Logs

Beyond the audit-trail event tables above, the server writes two JSONL log streams to `DATA_DIR/logs/`:

- `access-YYYY-MM-DD.jsonl` — one line per HTTP request (method, path, status, ms, ip, user-agent, user_id, req_id)
- `app-YYYY-MM-DD.jsonl` — info/warn/error/debug messages from the application (captures all `console.*` calls as well, tagged `legacy:true`)

Files rotate daily (UTC) and also rotate mid-day if a single file exceeds 500 MB. Every request gets a UUID `X-Request-ID` response header that appears as `req_id` in both the access log and any app log emitted during the request — so correlating a failed user action with its server-side trace is a single grep.

**Retention is storage-driven**: an in-process job every 5 minutes checks free disk space and deletes the oldest rotated files when free space drops below `max(LOG_MIN_FREE_MB, LOG_MIN_FREE_PCT% of volume)` — defaults 500 MB / 5%. Today's active file is never deleted. A loud warning is logged when free space is still below 2× the threshold after cleanup, so operators notice before the disk fills. If disk I/O fails (e.g. disk is already full), log writes are silently dropped (with one "log write failed" warning to stdout per minute) so request handling is never blocked.

**Redaction**: logger context is walked and the keys `password`, `password_hash`, `reset_code`, `verify_code`, `cxone_api_key`, `default_cxone_api_key`, `self_enroll_token` (the 256-bit join-link capability), `secondary_email` / `secondaryEmail`, `_csrf`, `csrf_token` are redacted to `[REDACTED]` wherever they appear (including nested). In logged request objects, the headers `Authorization`, `Cookie`, `Set-Cookie`, and `X-CSRF-Token` are also redacted. No raw request bodies are logged.

A **sealed** challenge's answer needs no entry on this list because it never reaches a log line at all: the audit diff substitutes a fixed placeholder for the value at write time (*Audit Trail* above), so there is nothing on disk for either the key walk here or the read-time role redaction below to catch.

**Role-based read redaction**: one class of account-compromise material still reaches a log stream by legitimate means — the superadmin password is printed to the app log at startup (console mirror) and on every auto-rotation. `/api/admin/logs` scrubs it for non-superadmin callers via a **stateless** regex: the boot-time `Superadmin password: <value>` banner pattern is rewritten to `Superadmin password: [REDACTED]`. Verification tokens are not in this class: the access logger rewrites every `?code=<token>` *before* the line is written (see *Observability* above), so a live code never reaches `access-*.jsonl` for any reader, superadmin included — the read-time `?code=…` / `&code=…` regex is retained as defence in depth for older log files. Stateless matters: the redaction works on **old log files** read by a fresh process — a server restart wipes the in-memory password set, but the regex still scrubs prior-session banners. As a defence-in-depth fallback, the in-process `_superadminPasswordHistory` set also redacts the live process's current and rotated passwords if they ever leak into a log line via a non-banner channel (current session only). Everything else — emails, first/last names, IP addresses, user agents, audit-event details — is visible to regular admins, because incident response (contacting a user, correlating brute-force attempts, triaging an abuse ticket) is an explicit use case for this endpoint. Superadmins read the streams unredacted, which for the app log means the boot-time password banner in cleartext. The response's `redacted: true|false` field reports which mode was applied — `true` for a regular admin, `false` for a superadmin.

**Audit-event mirroring**: every `recordUserEvent` / `recordCompetitionEvent` / `recordTimeslotEvent` / `recordSettingsEvent` call (logins, approvals, role changes, session invalidations, submissions, etc.) writes both to the structured DB table *and* to `app.jsonl` as a row tagged `source:"audit"` with `scope`, `scope_id`, `event_type`, `changed_by`, and the original `details` object. The mirror auto-enriches the details for the three non-user scopes at log-write time so the line is human-readable without a second DB hop: `scope="timeslot"` gets `{timeslot_name, competition_id, competition_name}`, `scope="competition"` gets `{competition_name}`, `scope="task"` gets `{task_title, difficulty}`. This makes the log file self-contained for forensics — everything visible in the admin History dialogs can be reconstructed from `grep '"source":"audit"' app-*.jsonl` without DB access.

**Admin Logs pane** (admin UI, `Admin → Audit → Raw logs`: the Audit page's second view, whose switch also sits on the pane and keeps the Audit item current; **Audit** itself always opens on the trail, never on the view used last — operator ruling, 14 Nov 2026):

- Toggle between **Audit log** (`app.jsonl` — audit events, warnings, errors) and **Request log** (`access.jsonl`).
- Sortable columns: Time, Level/Method, Path/Message, Status, ms, First, Last, Email, **Actor** (`changed_by` for admin-audit rows), IP.
- Search box matches the raw JSON substring *and* pre-resolves the query against `users.first_name / last_name / email / nickname / secondary_email` so searching by name matches rows that only reference a GUID in the raw file.
- Hover the **Message** column to see the full `details` object as a tooltip — task_title, competition_name, changes diff, cascade counts, etc. — without needing to grep the raw JSONL.
- Page sizes 50 / 100 / 200 / 500, default 50, newest-first.
- **The Audit log pages like the audit trail** (operator ruling, 17 Nov 2026): the first page is counted (up to 10,000 entries; past that the total is a floor), **Last** and **Go to page** need an exact count, **Next** goes by position (`next_cursor`), the same cost at any depth, and a search the scan budget cuts says how far back it searched (`searched_to`) while **Next** searches on. The Request log keeps a count on every page.
- **Cross-day pagination** — pagination spans every rotated log file on disk, newest-first. Clicking Next past the end of today's file transparently advances into yesterday's, then the day before, etc. A small header hint shows which date(s) contributed rows to the current page (e.g. "Showing entries from 2026-03-12 to 2026-04-15 (35 days)"). The underlying endpoint still accepts an explicit `date=YYYY-MM-DD` for single-day queries via API.
- Auto-refresh every 15 s while viewing page 1. There is no manual toggle; it suspends itself whenever a non-default sort is active — a ranked view is not a live feed, since a new `info` line has no position in a severity ranking — and the pane says **Live updates paused while sorted** rather than silently stopping.
- Names/email/IP enriched from the current `users` row at read time (GUIDs stay in the file for stability; resolution happens server-side in one batch query per response).

**Admin read API**:

| Endpoint | Description |
|---|---|
| `GET /api/admin/logs?stream=<app\|access>&date=<YYYY-MM-DD>&level=<lvl>&since=<iso>&q=<text>&limit=<n>&offset=<n>&anchor=<ts>&cursor=<c>&sort=<col>&dir=<asc\|desc>` | Returns a paginated window of entries (most-recent-first, default limit 50, max 500). `q` also matches users by first/last/email/nickname. Response enriches rows with `user_email`, `user_first_name`, `user_last_name` where a user GUID is present. Paging: `anchor_ts` pins later pages; on the Audit log only the first read is counted and `next_cursor`, `has_more` and `searched_to` carry Next (swagger has the contract). |
| `GET /api/admin/logs/files` | Lists all rotated log files on disk with size and mtime so callers can choose a `date` parameter |

**Configuration**:

| Env var | Default | Meaning |
|---|---|---|
| `LOG_LEVEL` | `info` | Minimum level: `debug`, `info`, `warn`, `error` |
| `LOG_DIR` | `DATA_DIR/logs` | Directory for JSONL files (in the container: under `DATA_DIR` or another volume the `node` user can write) |
| `LOG_MIN_FREE_MB` | `500` | Trigger cleanup when free disk drops below this |
| `LOG_MIN_FREE_PCT` | `5` | Or below this percentage of the volume (whichever is larger) |
| `LOG_DISABLE_ACCESS` | `false` | If `true`, skip HTTP access logging entirely |
| `LOG_CONSOLE_MIRROR` | `true` in dev, `false` in prod | Also emit each log line to stdout (off: a failed exit still writes its recent error lines to stderr) |

**Log integrity**: log files rely on OS filesystem permissions for tamper resistance. Production deployments wanting cryptographic tamper-evidence should add a separate hash-chain layer.

---

## Performance

Designed to handle a full-scale live event (target: 200–1000 concurrent participants, 5000 total users, 300 challenges, 8-hour duration) on a single Node.js process backed by SQLite/WAL.

### Hot-path optimisations

- **Paginated `/api/admin/submissions`** — `{ events, total, limit, offset }`, default limit 100, max 500. The underlying `submissions ∪ hint_reveals` UNION runs to hundreds of thousands of rows on a busy event, so paging is what keeps admins polling every 15–30 s from each pulling a 50+ MB JSON payload.
- **Scoped `user_tags` fetch in `/api/admin/participants`** — the pre-fix `SELECT … FROM user_tags` with no WHERE was a full table scan on every admin dashboard poll. Now restricted to the page's user IDs.
- **Expired-session GC** — a 5-minute background sweep drops expired rows from `express_session`, keeping `invalidateOtherSessions()` (runs on every login) bounded in the face of hours of session churn.
- **Competition-metadata cache** — `getCompetition(id)` (hot on every `requireCompetitionContext` gate, leaderboard build, event recorder) reads through a 1-second TTL cache. Explicitly invalidated at the edit / delete / end-now mutation sites; bounded staleness on scheduler-driven auto-end paths.
- **Additional indexes** — `submissions(competition_id, user_id, timeslot_id)` for leaderboard batch lookups; `submissions(user_id, task_id, competition_id, submitted_at DESC)` so the dedup check on submit can satisfy the ORDER BY from the index; `submissions(competition_id, submitted_at DESC)` + `hint_reveals(competition_id, revealed_at DESC)` so the paginated admin submissions UNION's ORDER BY is index-backed.

### Content-hashed static assets

- At startup the server walks `public/` AND `docs/`, computes a 12-char SHA-256 prefix for every non-HTML / non-MD file, and rewrites every self-hosted `href="/foo"` / `src="/foo"` reference inside `public/*.html` to `href="/foo?v=<hash>"`. Markdown files under `docs/` get the same treatment: `![alt](../screenshots/foo.png)` becomes `![alt](../screenshots/foo.png?v=<hash>)` on read. HTML + markdown are served from an in-memory cache with `Cache-Control: no-cache` so fresh hashes propagate on the first request after restart. Assets whose URL carries the `?v=...` query get `Cache-Control: public, max-age=31536000, immutable` — browsers cache them forever; on the next deploy the hash changes, the URL changes, and the browser re-fetches. Direct hits without the query fall back to `max-age=300` so an unhashed link still revalidates within minutes.
- `/asset-versions.js` exposes `window.__assetUrlWithVersion(url)` to the client so the help-drawer renderer can construct correctly-hashed URLs for BOTH the light and dark variants of each screenshot. The dark `.dark.png` file has a different hash from the light variant, and the renderer derives one from the other at render time, which a `<picture>`-based approach could not do once the two hashes diverged.
- `nodemon.json` watches every source root the running process holds: `server.js`, `db.js`, `version.json`, `lib/`, `routes/`, `public/` and `docs/`. So a `npm run bump`, a route or lib edit, a stylesheet change or a guide edit all restart the dev server and recompute the hash map. `data/` and `uploads/` are ignored (they are symlinks to the runtime volume, and the access log would otherwise restart the server forever); `docs/screenshots/` is ignored because `npm run docs:shots` rewrites `MANIFEST.json`; `tests/`, `perf/`, `ci/` and `scripts/` are outside the allow-list, so a spec edit does not bounce the server. `swagger.yaml` is deliberately absent — nothing serves it. Every restart regenerates `SESSION_SECRET` and `.superadmin-password`, so it signs you out and changes the password you sign back in with.
- No build step. The hashing runs in-process at module init; a deploy is still just "bump version → restart".

### Auto-end pre-filter

- On every correct submission the auto-end check first asks "has the SUBMITTING user now solved every task?" via a single-user `COUNT(DISTINCT task_id)` against the `idx_submissions_user_comp` index. If the answer is below the total, the scan short-circuits and the N-user `allParticipantsSolvedAll` aggregate is skipped. At final-minute submission bursts this collapses a per-submit N-user scan to a single indexed COUNT — critical during the last-challenge scramble on a 30-challenge event with 200 participants.

### Submit event-insert decoupling

- The `submitAndAutoEnd` transaction keeps only the correctness-critical work inside it: the status re-check and the idempotency dedup check, the `submissions` INSERT, and the auto-end `UPDATE competition_timeslots` / `UPDATE competitions`. (The re-checks are reads, and `db.transaction()` is a DEFERRED `BEGIN`, so they run BEFORE the write lock is taken at the INSERT; they are authoritative because the transaction body is synchronous in one process, so no other request can run in between.) The ~5 audit inserts into `user_events` / `competition_events` / `timeslot_events` / `challenge_events` are queued during the transaction and flushed via `setImmediate` AFTER commit — the transaction commits, and releases the write lock, as soon as the submission row is durable. At 100 submits/s during a final-minute burst, this removes ~5 synchronous inserts from every submit's turn on the event loop, which was visibly slowing the write path. Ordering invariant: the submission row is always durable before any event row references it; a server crash between commit and the audit drain loses the events for that single submission but the submission itself persists.

### Select-timeslot event decoupling + full-path TOCTOU

- `/api/select-timeslot` wraps EVERY write that depends on the timeslot being non-ended inside the same transaction as the status recheck — including the subsequent `UPDATE competition_users SET login_time` and `UPDATE users SET active_competition_id`. Leaving those later writes outside the transaction opens a narrow race: a slot that ended between the tx commit and the login_time write would still mark the participant as "joined a live slot" and auto-resume them into an ended event on next login. All writes commit or roll back together, and the audit events are likewise deferred to `setImmediate` after commit to keep the transaction short.

### /asset-versions.js self-hashed

- The helper script that exposes `window.__assetUrlWithVersion()` gets its own content hash, registered in the same asset-versions map. HTML rewrites emit `<script src="/asset-versions.js?v=<hash>">`, and the file is served with `Cache-Control: public, max-age=31536000, immutable`, saving a ~2 KB round trip on every page load.

### Maintenance mode

Create `DATA_DIR/.maintenance` with a random token to show a static "Scheduled Maintenance" page to all visitors. Requests carrying `X-Maintenance-Bypass: <token>` pass through normally — the perf test tooling sends this header automatically when `MAINTENANCE_BYPASS` is set.

```bash
openssl rand -hex 16 > data/.maintenance   # enable
rm data/.maintenance                        # disable
```

The file's existence is what engages the mode and its content is the bypass
token, so an **empty** file means maintenance with **no** bypass (see
[Maintenance Mode](#maintenance-mode)). Write the token in one step.

### Continuous load testing

Load tests live under `perf/`. See `perf/README.md` for hardware sizing, scenario configuration, and safety checklist.

- `k6/scenarios/competition-live.js` — full hybrid simulation (protocol VUs + browser probes + admin polling).
- `k6/scenarios/leaderboard-stress.js` — isolates the leaderboard query under concurrent load.
- `k6/scenarios/submission-burst.js` — concurrent write contention + auto-end cascade. Every submit echoes the `grading_hash` read from `GET /api/tasks/:id` (the server refuses to grade without it — a 409 `task_changed`, no row, no penalty), so the scenario is measuring the write path only while its `stale_submissions` counter reads zero.
- `k6/scenarios/login-wave.js` — the synchronised sign-in at an event start, from **one** NAT'd address. This is the scenario that measures rate limiting rather than capacity, so it is the one the load generator is deliberately **not** allowlisted for; it carries its own control run, and reports INVALID rather than PASS if that control shows the limiter was off.

`perf/run-local.sh` (also `npm run perf:local`) drives any of them against a throw-away containerised target: seed, restart for cold caches, then measure with production's limiters **on**.

The admin polling loop (`perf/k6/lib/admin.js`) represents a realistic operator dashboard session: every cycle hits the Participants / Leaderboard / paginated Submissions reads; every 2nd cycle additionally pulls the Analytics (event scope) and Logs reads; every 3rd cycle adds the History dialogs + global-scope analytics (the heaviest single admin read — walks `challenge_events` without an event filter).

---

## Development

> **Contributor workflow reference**: [`DEVELOPMENT.md`](DEVELOPMENT.md)
> covers the full dev loop — versioning (`npm run bump` + version-sync),
> screenshot regeneration for docs (`docs:shots:*` targets), the UI-polish
> subagent protocol under `.claude/`, and how to run subsets of the
> Playwright suite when iterating on a specific tab.

```bash
# Development server with auto-restart
npm run dev

# Run all tests (parallel; default WORKERS=24)
npm test

# Sequential / debug mode
WORKERS=1 npm test

# Interactive test UI
npm run test:ui

# Cross-browser + cross-device matrix (engines, operating systems, devices, orientations, input modes)
npm run test:cross

# How evenly the workers finished; --write refreshes tests/file-timings.json
npm run test:balance

# Which functions and lines no test executes (.coverage/report.md)
npm run test:coverage
```

#### Cross-browser testing

`npm test` runs the full ~5,600-test regression suite on **Chromium only** (the fastest engine, sufficient for API + behavioural coverage). Engine-specific regressions — CSP / Trusted Types enforcement differences, mobile viewport quirks (`100dvh`, `env(safe-area-inset-bottom)`), `fetch` / cookies / CSRF edge cases, **navigation-control reachability** (each "next-step" affordance is on-screen + clickable, not merely attached), and **kebab-menu on-screen positioning** (the portalled `⋮` row-action menu — the only path to row actions at ≤768px, where the inline buttons are hidden — must open fully within the viewport on every device) — are caught by `tests/cross-browser.spec.js`, a reachability smoke, and `tests/cross-device.spec.js`, which takes a participant through real work (open a challenge, answer it wrongly then correctly, read the leaderboard, edit the profile, rotate the device, pan a wide table) using the input each device actually has: taps on touch projects, the mouse elsewhere, and both a trackpad-style and a mouse-style wheel on the laptops and desktops. Both run across the matrix below:

| Project                            | Engine   | Device                              | Purpose                                                 |
| ---------------------------------- | -------- | ----------------------------------- | ------------------------------------------------------- |
| `chromium`                         | Chromium | Desktop (1280×800)                  | Baseline — also runs the full regression suite.         |
| `firefox`                          | Gecko    | Desktop (1280×800)                  | Catches Firefox-specific layout / fetch regressions.    |
| `webkit`                           | WebKitGTK | Desktop Safari UA (1280×800)       | Catches WebKit-specific regressions. **Not Apple WebKit — see the caveat below.** |
| `mobile-chrome`                    | Chromium | Pixel 7 (Android UA, 412×839 viewport on a 412×915 screen) | Regression lock for the Android Chrome bottom cutoff (`100dvh` + safe-area inset). |
| `mobile-webkit`                    | WebKit   | iPhone 14 (iOS UA, 390×664 viewport on a 390×844 screen) | Regression lock for iOS Safari URL-bar collapse.        |
| `tablet-webkit-landscape`          | WebKit   | iPad Pro 11 landscape (1194×834)    | iPad-class form factor — catches the 768/900 px breakpoint regressions that neither phone-portrait nor desktop hits. |
| `mobile-chrome-samsung`            | Chromium | Galaxy S24 (Samsung UA, Android 14)  | Modern Samsung-phone form factor — closest bundled profile to S25-class deployments. |
| `tablet-chrome-samsung-landscape`  | Chromium | Galaxy Tab S9 landscape (Samsung UA, Android 14) | Modern Samsung tablet — pairs with iPad-landscape so each engine covers both phone-portrait and tablet-landscape. |
| `mobile-webkit-landscape`          | WebKitGTK | iPhone 14 landscape (750×340)      | Phone LANDSCAPE. Shortest viewport in the matrix; the only projects that exercise `@media(max-height:450px)`. |
| `mobile-chrome-samsung-landscape`  | Chromium | Galaxy S24 landscape (780×360)      | Blink sibling of the above. |
| `tablet-webkit-portrait`           | WebKitGTK | iPad Pro 11 portrait (834×1194)    | Tablet PORTRAIT. iPadOS is WebKit-only, so this is the closest available proxy for it. |
| `tablet-chrome-samsung-portrait`   | Chromium | Galaxy Tab S9 portrait (640×1024)   | Narrowest tablet; 640 px is above the 600 px breakpoint, so the phone rules do not apply. |
| `windows-chrome-laptop`            | Chromium | Windows laptop, 1536×864 at 125% scaling, classic scrollbars | Fractional scaling and a scrollbar that takes layout width — the Windows differences the app can feel. |
| `windows-edge-laptop`              | Chromium | Edge UA, 1366×768, classic scrollbars | The most common small Windows laptop screen. |
| `windows-firefox-laptop`           | Gecko    | Windows Firefox UA, 1536×864 at 125% | Firefox at fractional scaling. Headless Firefox keeps overlay scrollbars, so the scrollbar half is Chromium-only. |
| `windows-chrome-touch-laptop`      | Chromium | Touchscreen laptop, 1366×768 | A 2-in-1 in tablet mode: `pointer: coarse` on a laptop-sized screen, the only way to reach the coarse-pointer rules above 600 px. |
| `windows-chrome-desktop`           | Chromium | 1920×1080 monitor                   | Full-HD desktop. |
| `windows-chrome-desktop-portrait`  | Chromium | 1080×1920 rotated monitor           | A monitor turned on its side. |
| `macos-safari-laptop`              | WebKitGTK | MacBook, 1440×900 at 2x            | Retina, overlay scrollbars. The same WebKitGTK caveat applies as `webkit`. |
| `macos-chrome-laptop`              | Chromium | Mac Chrome UA, 1512×982 at 2x       | Retina Chrome. |
| `macos-firefox-laptop`             | Gecko    | Mac Firefox UA, 1440×900 at 2x      | Retina Firefox. |
| `macos-safari-desktop`             | WebKitGTK | 1920×1080 at 2x                    | Large retina display. |
| `google-chrome`                    | Chrome   | Branded Google Chrome, 1280×800     | Added automatically where `/opt/google/chrome` (or `CHROME_PATH`) exists; `NO_BRANDED_CHROME=1` omits it. The CI image does not ship it. |

**What an operating-system project can and cannot be.** Playwright does not emulate `navigator.platform`, so a Windows or macOS project is its user agent, viewport, device-pixel-ratio and scrollbars. Those are the operating-system differences this app can feel: Windows draws classic scrollbars that take about 15 px of layout width (headless Chromium hides them by default; these projects turn that off), Windows laptops ship at fractional scaling, and Macs are 2x with overlay scrollbars. iOS and Android are the phone and tablet projects. **Mouse versus trackpad** cannot be told apart in CSS — both are `pointer: fine` and `hover: hover` — so the difference that can be tested is the scrolling each produces, which `tests/cross-device.spec.js` drives on every laptop and desktop project.

**The sizes in the table are viewports, and `window.screen` is not what they say.** Since Playwright 1.64 each project reports its device *descriptor's* screen rather than one matching the laptop it models: 1920×1080 for every project built on Desktop Chrome, Edge or Firefox (the `chromium` regression suite included), 1792×1120 for the Safari ones, the phones' own portrait screens — an iPhone in landscape keeps a portrait screen, as the real one does — and the viewport for the Galaxy and iPad projects, whose descriptors carry none. So `windows-chrome-desktop-portrait` is a rotated viewport on a landscape screen. This is deliberate and harmless *because the app never reads the screen*: layout, `(orientation: …)` and every width/height/pointer media query resolve against the viewport, and `tests/screen-inert.spec.js` fails the build if client code starts reading `window.screen`, `window.orientation` or a `device-width` / `device-height` media feature. That is the moment to give the projects coherent screens.

Non-Chromium projects only run `tests/cross-browser.spec.js` and `tests/cross-device.spec.js` (via `testMatch` in `playwright.config.js`) — the full suite is NOT triplicated, because the engine-coverage value is in the smoke, not in re-running every CRUD test on Firefox.

**Phone-landscape and tablet-portrait are covered deliberately.** With only portrait phones and landscape tablets, two whole form factors would have *zero* coverage — and that is not a cosmetic gap, because `@media(max-height:450px)` is a landscape-phone rule that no other project exercises.

> **`webkit` is WebKitGTK, NOT Apple WebKit — and the difference is load-bearing.**
>
> Playwright ships a Linux WebKit build (WebKitGTK), not Safari. It is a genuine WebKit and it does catch real WebKit-engine regressions, which is why the projects are worth running. But it is *not* the browser any customer uses, and its platform defaults differ. **Measured on this codebase: WebKitGTK reports a 16 px UA default for form controls where Blink and Gecko report 13.33 px.**
>
> The practical consequence: iOS Safari zooms the page when a focused `input` / `select` / `textarea` computes below 16 px, and does not zoom back out on blur — but WebKitGTK's default is *already* 16 px, so **the emulated matrix cannot reproduce that class of bug at all**, and a behavioural assertion there would pass vacuously. The same applies to anything genuinely iOS-specific: `env(safe-area-inset-*)` (Playwright cannot inject insets), the real dynamic-viewport/URL-bar behaviour, and momentum scrolling.
>
> Where a behavioural test cannot discriminate, the invariant is pinned as a **source** assertion instead, and the test says so. See `functional-core-b.api.spec.js > Docs hygiene > "v7.23.0: every vh height declaration has a dvh sibling"` and the `test.fail`-annotated `"…form controls declare a >=16px font-size at every width"`.
>
> Note the asymmetry this fixes: the *Samsung* projects have always carried an honest proxy caveat (below) while `webkit` was described as a "macOS Safari proxy" with none.
>
> **If real-Safari coverage is ever required**, the options, closest to real first:
>
> - **A Mac.** Safari ships with `safaridriver`; `safaridriver --enable` once, then drive real Safari over WebDriver (Selenium or WebdriverIO). Xcode's iOS Simulator runs real Mobile Safari, drivable through Appium's XCUITest driver. Safari does not speak the Chrome DevTools Protocol, so this is a second, small WebDriver harness rather than Playwright.
> - **Playwright on macOS** (a Mac, or a macOS CI runner). Playwright's `webkit` on macOS is built from WebKit's Mac port, the engine port Safari uses, so the WebKitGTK-specific differences above (form-control defaults, font rendering) go away. It is still not the Safari application: no Safari-only features, and no iOS.
> - **A device cloud** (BrowserStack, Sauce Labs, LambdaTest — roughly $100–250 a month). Real iOS Safari on real hardware, driven over WebDriver/Appium. Their Playwright support covers Chromium and Firefox, and real Chrome on Android; it does not reach real Safari, which needs their WebDriver route.
> - **A scripted manual pass** on one iPhone, one iPad and one Android device before an event.
>
> For an events-based deployment the manual pass is usually the better value — this is recorded as an operator decision, not an oversight.
>
> **When to revisit:** the decision turns on the deployment model, not on the price. Hack Arena ships per-event, so a scripted pass before an event covers the same ground as a subscription. **If it ever moves to continuous deployment, the device cloud becomes the right answer** — there is no pre-event moment to hang a manual pass on, and the engine gap above is exactly the class that would then reach production unobserved.

**Concurrency — the matrix defaults to 2 workers, not 12.** Unlike the Chromium suite (mostly API request-contexts, which parallelise well at 24), *every* cross-browser test drives a real, heavy browser. Running a dozen engines at once oversubscribes a typical box (load ≫ cores); Firefox is the most sensitive — when CPU-starved its Juggler agent stalls and operations like `boundingBox`/`waitForSelector` hang the full test timeout *even after* the element already "resolved to visible". The matrix is browser-startup-bound (≈the same ~55 s wall-clock at 2 workers as at 8, measured before the Chromium default rose to 18, and later 24), so `CROSS_BROWSER=1` lowers the default to **2 workers** — deterministic, no contention flakes. The `firefox` project also ships `firefoxUserPrefs` (single content process, no fission, software rendering, no animations) to shrink its footprint further. Override either with `WORKERS=N` if your host has the headroom.

**Samsung Internet browser** — note that Playwright bundles only Chromium / Firefox / WebKit. Samsung Internet is a Chromium fork (Blink-based) with Samsung-specific UI quirks; the `mobile-chrome-samsung` and `tablet-chrome-samsung-landscape` projects above are Chromium-engine proxies that catch ~95% of Samsung-flavour bugs (anything Blink-side: CSP, Trusted Types, layout, fetch). The residual 5% — default-font fallbacks, scroll-behavior differences, dark-mode auto-tinting, Samsung's PWA install-bar quirks — requires a real Samsung device or a paid device cloud:

| Service       | Real Samsung Internet | Auth method | Notes |
| ------------- | --------------------- | ----------- | ----- |
| BrowserStack  | ✓                     | `BROWSERSTACK_USERNAME` + `_ACCESS_KEY` env vars | Works with Playwright via `browserstack-node-sdk`. ~$30/mo for parallel. |
| Sauce Labs    | ✓                     | `SAUCE_USERNAME` + `_ACCESS_KEY`                 | Similar Playwright plugin; comparable pricing.       |
| LambdaTest    | ✓                     | `LT_USERNAME` + `_ACCESS_KEY`                    | Cheapest of the three; same plugin shape.            |

Hack Arena does not bake any of these in — the platform's CI gate runs the local proxies only. Operators who run sustained Samsung-specific volumes can wire one of the above as an additional CI job; the npm-script shape stays compatible.

First-time setup — the default `npm install` only pulls Chromium:

```bash
npx playwright install firefox webkit
sudo npx playwright install-deps firefox webkit  # missing system libs (libavif, libgav1, …)
npm run test:cross
```

**No-root / non-Ubuntu hosts** (e.g. Linux Mint, or any box where you can't `sudo install-deps`): use the side-load path instead of step 2. `npm run test:cross:setup` downloads exactly the missing libraries (WebKit's image codecs + a newer libnss3 for Firefox) via `apt-get download` — **no install, no root** — into `/tmp/pw-libs`, the path `playwright.config.js`'s `LD_LIBRARY_PATH` shim already points at, and copies the codec libs into WebKit's headless `sys/lib`. `test:cross` then sets `LD_LIBRARY_PATH` + `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` for you:

```bash
npx playwright install firefox webkit   # binaries only (no deps)
npm run test:cross:setup                # side-load the missing libs (no sudo)
npm run test:cross                       # → about 500 tests across 22-23 engine/OS/device projects
```

`/tmp` is volatile — re-run `test:cross:setup` after a reboot, **and after every Playwright version change**: a new Playwright brings new Firefox and WebKit builds, and each can need something the shim does not hold yet. Firefox 157 (Playwright 1.64) needs `NSS_3.126`, which the previously pinned libnss3 3.114 does not export, and a new WebKit revision starts without the codec libs in its `sys/lib`. Re-running is safe — idempotent for an unchanged pin, and across a pin change it fetches the new libnss3 first, deletes the superseded one only once the new one has arrived, and re-extracts every library into `/tmp/pw-libs` from scratch, so nothing needs clearing by hand. Offline, it keeps what was cached and never wipes a working shim, and it rebuilds into a staging directory first, so a `.deb` that will not unpack leaves the working shim untouched and the run fails saying which one. It finds the browsers where Playwright does — `PLAYWRIGHT_BROWSERS_PATH` (or npm's `npm_config_playwright_browsers_path`), a relative value meaning the directory `npm run` was started from, `0` meaning inside `node_modules`, and otherwise `${XDG_CACHE_HOME:-~/.cache}/ms-playwright` — copies the codecs into every installed WebKit revision, and ends by asking `ldd` whether each installed Firefox resolves its NSS against the shim, naming any missing symbol version (and saying so when it finds no Firefox to ask about). The script lives at `scripts/setup-cross-browser.sh`; when that check names one, bump `NSS_DEB` there (currently libnss3 3.127, which exports `NSS_3.126`).

The matrix is opt-in via the `CROSS_BROWSER=1` env var, which `test:cross` sets for you. Setting it manually (`CROSS_BROWSER=1 npx playwright test`) runs the full suite on Chromium AND the two cross-browser files on every other project.

CI note: the cross-browser matrix runs on every PR + push (alongside the Checkmarx scan) — see `.github/workflows/checkmarx.yml`. It runs on every PR rather than nightly because engine-specific drift in Trusted Types and CSP behaviour is a real cost — but it is not a REQUIRED check: branch protection on `main` requires `checkmarx-scan` alone, so a red cross-browser (or full-suite) job does not by itself stop a merge, and has to be read.

#### Parallel test architecture — per-FILE isolation

The Playwright suite runs ~5,600 tests across more than 400 spec files, 24 worker processes by default. **The isolation boundary is the spec file, not the worker.**

- Each worker owns a port (`4567 + workerIndex`) and a data directory, and **`TEST_PORT_BASE` moves both**: at the default base the directory is `data-test-<workerIndex>/`, at any other base it is `data-test-<base>-<workerIndex>/`. One knob moving both is what lets two suites — and the port-sharded independence sweep — run at once without wiping each other's database, so derive the path from `TEST_DATA_DIR` / `dataDirFor()` rather than hand-rolling it.
- `tests/isolated-test.js` **replaces** that worker's server before **every spec file** — SIGKILL the old process, wipe the data directory, spawn a fresh one on the same port, re-seed. Because the port is the stable identity, no test needed changing when this landed: specs swapped `require("@playwright/test")` for `require("./isolated-test")` and nothing else.
- A fresh process is what makes it airtight: every in-process cache (leaderboard, me-cache, `_competitionCache`, scanner reputation, rate-limit buckets, operator alerts, sessions) is gone *by construction*, rather than by a reset list somebody has to keep complete.
- Readiness is a **positive identity check** — the harness requires `/api/config`'s `server_started_at` to postdate the spawn. `/healthz` is answered identically by the previous file's server, so a status-code probe can silently hand a whole file the wrong database.
- `tests/global-setup.js` does not seed and does not wipe; it refuses to start if anything is already listening on a worker port **or on any spawned-server port** (v8.3.26 — the wipe was redundant with the per-file reset and, running before the port check, destroyed a concurrent run's databases).

Why it exists: seeding one server per *worker* leaves files A → B → C on one worker sharing a single never-reset database and inheriting each other's mutations, and which files land together depends on the worker count — so the same suite can pass at `WORKERS=8` locally and fail at CI's 4. Per-file isolation is also **faster**: the per-file boot+seed (~1.7 s) replaces a per-worker upfront cost, and the suite runs in about 2m28 at `WORKERS=8`. The result is identical at `WORKERS=8`, `4` and `2`.

Tests within a single spec file stay serial (`fullyParallel:false`), so the deliberately sequential specs can still share state via the `S.*` pattern.

`RETRIES=1` (default) absorbs CPU-contention flakes in UI tests on machines with limited cores. Set `RETRIES=0` for strict mode. `npm run test:changed` re-runs only the specs your branch touched, twice, with retries on — aimed at exactly the code most likely to carry a fresh isolation bug.

### Project Structure

```
server.js                            Backend bootstrap + the deliberately-inline routes (submit, imports, /metrics, the superadmin login, SPA shell, test-only endpoints)
routes/                              One module per entity/domain — competitions, sessions, challenges, participant, participants, groups, invitations, users, self-enroll, leaderboard, settings, events, export-import, auth, admin-misc, badge, audit, certificate-config, event-look, event-overview, event-team (each `require(...)(app)`d in registration order by server.js)
lib/                                 76 shared backend modules require'd by server.js + the route modules — regenerate this list from `ls lib/` rather than appending by memory: account-lookup, account-reaper, admin-alerts, answer-seal, attachments, attempts, audit, badge, best-effort, categories, certificate-config, certificate-dispatch, certificate-share, challenge-fit, choices, comp-allowlist, competitions, config, csv, cxone, cxone-identity, cxone-ledger, cxone-withdraw, data-dir, email, email-identity, email-proof, event-admin, event-policy, event-retention, event-team, event-template-builtins, full-export, group-sync, http, human-code, impersonation, invitation-claim, late-entry, leaderboard, lockout, log, log-sort, login-code, login-method, me-cache, middleware, multipart, participants-cache, platform-look, presence, qr, qualifying, qualifying-rescore, query-plan, rbac, registration-fields, sanitise, scanner-classify, scheduler, schema-required, scoring, self-enroll, session-index, sessions, settings, staff-compete, task-fields, team-recipient, team-report-mail, team-reports, time, user-tags, util, validate, zip-writer; and `fonts/badge/`, the certificate renderer's static faces (Inter subsets; Noto for Arabic, Hebrew, Thai and CJK), read by the server only
db.js                                SQLite schema and initialization
package.json / package-lock.json
version.json                         Single source of truth for the version (see Versioning below)
nodemon.json                         Dev-server watch config — restarts on any change the server caches
playwright.config.js                 Test runner config (projects, parallelism) — deliberately NO webServer block; tests/isolated-test.js owns the server lifecycle
swagger.yaml                         OpenAPI spec for every public endpoint
docker-compose.yml / Dockerfile      Container build + runtime
CLAUDE.md                            Project guidance for AI assistants
public/
  index.html                         SPA shell (HTML; styles in styles.css; loads /js/core/main.js as a module)
  js/                                Frontend as ES modules: core/{state,trusted-types,dispatcher,api,main}, ui/*, data/*, features/<entity>. Dev serves raw; prod esbuild-bundles the entry.
  help.html / help.js                Full-page rendered doc viewer — the ↗ icon in the in-app Help drawer opens /help.html?doc=<path>. Same marked pipeline + {{platformName}} substitution as the drawer; bookmarkable URL.
  styles.css                         SPA stylesheet
  verify-pages.css                   Shared stylesheet for the standalone server-rendered pages:
                                     the verification and email-change results, the
                                     email-change confirm, /credential, the LinkedIn
                                     share page, and the public certificate page and its
                                     not-found page. There are no static verified/verify-failed/
                                     verify-expired HTML files — one builder renders every
                                     result page, so do not go looking for them on disk.
  checkmarx-logo-*.svg, favicon.webp Branding assets
  vendor/                            All third-party browser assets are SELF-HOSTED — the CSP has no third-party origin
    echarts.min.js                   Apache ECharts (Apache-2.0, ~1 MB) — the Analytics admin pane
    marked.min.js                    Markdown renderer for the help drawer + /help.html
    highlight/                       highlight.js 11.11.1 + atom-one-dark, plus locally-registered extra languages
    qrcode.min.js                    Self-enroll join-link QR (lazy-loaded, admin-only)
    fonts/                           Inter + JetBrains Mono (variable woff2)
scripts/
  bump-version.js                    Bumps version.json + package.json + docker-compose.yml + swagger.yaml together
  check-version.js                   Pre-commit / CI gate that fails if the four drift
  smoke.cjs                          Real-server SPA smoke in both serving modes (npm run smoke)
  test-changed.cjs                   Re-runs only this branch's specs, twice, with retries
  test-balance.cjs                   Worker finish spread + per-file budget; --write refreshes tests/file-timings.json
  test-independence.cjs              Runs each test alone in a pristine database (manual diagnostic)
  coverage-report.cjs                Turns a test:coverage run into .coverage/report.md
  backup.sh / purge.sh               Online SQLite backup; log + rotation-friendly-table retention purge (both require DATA_DIR)
  prune-runtime-deps.cjs             Image build stage only: strips the native addons' build residue (--check by default)
  setup-cross-browser.sh             No-root side-load of the Firefox/WebKit system libs
tests/
  helpers.js                         Test utilities (createClient factory, apiLogin, freshCtx, etc.)
  isolated-test.js                   THE harness — every spec requires this, not @playwright/test
  server-env.js                      The one definition of the server's hermetic test environment
  global-setup.js                    Refuses to start on a squatted worker or spawner port
  file-timings.json                  Per-file run times the scheduler reads to start the longest files first
  functional-core-{a,b,c}.api.spec.js  Auth, profile, session, scoring, leaderboard, docs-hygiene locks
  functional-security-{a,b,c}.api.spec.js  CSP, rate limiting, redaction, dual-email, session invalidation
  mutations-core.api.spec.js         Participant CRUD + tag/feedback/competition mutations
  mutations-admin.api.spec.js        Admin-only mutation flows (delete, role change, import)
  mutations-attachments.api.spec.js  Challenge-attachment upload/promote/import + file-move rollback
  audit-cache-invariants.api.spec.js In-process cache invalidation invariants
  badge.api.spec.js / badge-ui.spec.js  LinkedIn achievement-badge mint + share UI
  timeslots-core.api.spec.js         Multi-session timeslot CRUD + selection
  timeslots-lifecycle.api.spec.js    Auto-end / fully-ended / leaderboard-mode transitions
  impersonation.api.spec.js / impersonation-ui.spec.js  Participant impersonation tiers + banner
  event-log-attribution.api.spec.js  Every mutating route emits an attributed event
  trusted-networks*.api.spec.js      Per-competition rate-limit bypass + its end-to-end proof
  solve-clock.api.spec.js            login_time anchoring + solveTimeMs clamping
  perf-span-attribution.api.spec.js  Slow-server vs slow-client vs blocked-loop attribution
  ui-admin-*.spec.js                 Admin Playwright flows — a11y, competitions, misc, rankings, tasks (shared helpers in ui-admin-helpers.js)
  ui-participant-{a,b,c}.spec.js     Participant Playwright flows
  ui-*-journeys.spec.js              Each admin/participant control pressed in a real browser, stored result read back
  audit-a11y.spec.js                 Accessibility (axe-core) regression scans
  layout-integrity.spec.js           No-overflow / on-screen / modal-within-viewport structural gate
  visual-regression.spec.js          Pixel-diff (toHaveScreenshot) over stable anonymous screens (chromium only)
  verify-indicator-ui.spec.js        Verify-grace header chip
  cross-browser.spec.js              Opt-in engine/mobile-viewport smoke (see "Cross-browser testing")
  cross-device.spec.js               Participant journeys on every device, with the device's own input
  _screenshots.spec.js / _ui-polish.spec.js
                                     Underscore-prefixed helper specs — opt-in (docs:shots / polish); ignored by `npm test`
```

### Versioning

`version.json` is the single source of truth. It must stay in lock-step with the `version` field in `package.json`, the `image: hackarena:<version>` line in `docker-compose.yml`, and `info.version` in `swagger.yaml`. Use the bundled scripts rather than hand-editing:

```bash
npm run bump patch          # 5.5.11 → 5.5.12 (also: minor / major / explicit X.Y.Z)
npm run check-version       # Fails if the four files disagree — suitable for pre-commit / CI
```

---

## License

See [LICENSE](LICENSE) for details.
#   f t c 
 
 