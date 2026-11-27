# Release notes

What changed in {{platformName}}, newest first, written for the people who run
events on it. Each entry is a short list of what is new, what now behaves
differently and what visible breakage was fixed. A version that changed nothing
you or a participant would notice is not listed, so the version in the header
is sometimes newer than the top entry.

## 9.2.18 — 26 November 2026

### New and changed

- **Deleted pictures stop showing within a day.** For everyone: a picture fetched from now on is kept by a browser for at most a day and by no shared cache, so a replaced or erased photo soon stops showing.
- **Picture clean-ups say which pictures went.** For operators: the Audit page record of each clean-up of unused pictures lists the pictures it removed, so one can be found and restored from a backup.
- **Back up before upgrading.** For operators: the first start removes every stored picture nothing uses that is over a week old, up to 500 a pass; links to them from outside pages then stop working.

### Fixed

- **A profile photo can no longer be borrowed.** For everyone: an account can no longer set its photo to a picture stored for someone else, so deleting that person or event can't leave a broken photo behind.
- **Pictures linked in capitals are kept.** For organisers: a challenge picture linked only by an address typed in capitals is no longer removed by the clean-up of unused pictures.
- **Importing people checks photo links.** For superadmins: a row linking to a missing picture or to another account's photo is not imported as that photo and is counted; the account keeps its own.

## 9.2.17 — 25 November 2026

### New and changed

- **Pasted colours stay readable.** For organisers: colour pasted into a challenge from Word or a web page takes the nearest named colour, and black or white is left off, so the text reads by day and at night.
- **Profile text refuses invisible control codes.** For everyone: names, company, job title and the other profile lines refuse line breaks, tabs and escape codes; an import skips such rows and says how many.
- **Pictures nothing uses any more are cleared away.** For operators: a stored picture nothing shows any more is deleted once it is over a week old, and Settings → Data & retention says how many went.
- **Log purge follows LOG_DIR.** For operators: give the purge script the server's LOG_DIR and it prunes the logs there; the backup script still copies only the data directory's logs.
- **Moving an event's end checks its late-entry deadline.** For organisers: a schedule change, Start now or turning late entries back on is refused if it would leave a pinned deadline out of range.

### Fixed

- **TRUST_PROXY accepts any case.** For operators: TRUE, False and LOOPBACK work like true, false and loopback; writing TRUE used to stop the server from starting.
- **Start reminders carry the event's current name.** For participants: renaming an event or session while its reminders go out no longer sends the later ones under the old name.
- **No jump when reloading on a phone.** For participants and organisers: the signed-in header keeps its shape from the first frame, so the page no longer jumps up as it settles.
- **Assign to Events keeps your choices on Back.** For organisers: going back from the confirmation step keeps the group filter, the narrowed list and the ticked events and groups.
- **The template editor without library access.** For custom roles: a role that may change templates but not view the challenge library can't add challenges there, and a line says why; it can still remove them.

## 9.2.16 — 25 November 2026

### New and changed

- **Locked fields stay readable.** For admins and organisers: a field you cannot change, such as a read-only profile, an ended event's name or a locked session time, shows a dashed outline instead of fading.
- **Formatting buttons switch off on a challenge you cannot edit.** For organisers: on a locked or sealed challenge, one you compete on or one you did not create, the editor's toolbars are off, with a line saying why.
- **The record of an unconfirmed account's removal counts its Checkmarx One accounts.** For administrators: the Audit page says how many were scheduled for removal, left in place, or need checking in the tenant.

### Fixed

- **A challenge you cannot edit opens read-only.** For organisers: one you did not create no longer offers a Save that would be refused, and neither it nor a locked one offers attachment changes.

## 9.2.15 — 24 November 2026

### New and changed

- **Start reminders wait during maintenance.** For operators: no "starts soon" email goes out while maintenance mode is on or the database failed its startup check; waiting ones go out afterwards.
- **A start reminder is never sent late.** For participants: one that could not go out before its event or session began is skipped instead, and one cannot be set in the last minute before the start.
- **The progress strip says when you have no attempts left.** On the events page, a run with nothing left to answer says No attempts left (or All solved), shows how many you solved, and its button reads View.
- **Deleting someone flags a Checkmarx One record that cannot be read.** For anyone who may delete people: the message after Delete asks for the tenant to be checked for an account of theirs.
- **The public certificate page matches the platform.** For anyone opening a shared certificate: it shows the certificate in a card and follows the platform's day or night mode; so does the page for a broken link.
- **Pages opened from emails and certificate links have the app's rounded corners.** For anyone verifying an address, unsubscribing, checking a certificate or sharing one: cards, buttons and boxes match the app.
- **The maintenance page is drawn like the app.** For anyone visiting while the platform is in maintenance: its card has the app's corners and a flat, soft shadow, by day and at night.
- **Page buttons that do not apply stay readable.** For admins and organisers: First, Prev, −10, +10, Next, Last and the Go to page box show a dashed outline instead of fading out when they do not apply.
- **Leaderboard medals read clearly in every look.** For participants: the gold, silver and bronze medals by the top three use the look's metal colours by day and at night, and show on your highlighted row.
- **Filter buttons keep a clear edge at night.** For everyone: the outlined buttons that filter a list now have the same firm edge at night as by day.
- **Hovering shows where you are, by day too.** For organisers: the challenge editor's toolbar, its menus and the code-language menu, the pickers and the Analytics rows now light up visibly in both day and night mode.

### Fixed

- **Ctrl+Z undoes code, links and table changes.** For organisers writing challenges: Inline Code, Code Block, a link, a code language and the Table menu's row and column changes now undo and redo like a colour.
- **Insert Link works from the keyboard.** For organisers writing challenges: pressing Enter on Insert Link now opens the link dialog instead of inserting an empty link at once.
- **Pasted text looks the same before and after you save.** For organisers writing challenges: text from Google Docs no longer turns bold when saved, and pasted bold, italics and underlining stay.
- **Challenges you have no attempts left on say so.** For participants in an event that limits attempts: such a challenge's card says No attempts left instead of reading as still open.
- **Invited newcomers no longer wait if a join link closes while they sign up.** Where new accounts need approval, your invitation now lets you in, as it does when the link closed before you typed your code.
- **Unreadable audit records no longer say Success.** On the Audit page, a record whose details could not be read now shows Unknown under Outcome, and the Outcome filter has an Unknown choice to list them.
- **The please-wait message reads clearly by day.** For organisers and people signing up: Sending invitations and Creating your account now show in dark text over the grey veil, not white.

## 9.2.14 — 24 November 2026

### Fixed

- **A look you pick for an event is the one Save look stores.** For organisers: in an event's Settings, a look or lock you have chosen but not saved stays on screen while the page updates the event's details.

## 9.2.13 — 24 November 2026

### New and changed

- **The venue's address in one press.** For organisers: at the venue, **Use my current address** beside Trusted network IPs adds the address the platform sees you at; a private one adds nothing and says why.
- **Coloured text in challenges reads clearly by day and at night.** For organisers writing challenges: colours and highlights follow the look; white, light grey and black are gone; existing colours stay as they were.
- **Default colour takes off only the colour.** For organisers writing challenges: it no longer clears bold, italics and the rest; Clear Formatting still does.
- **The colour menus work from the keyboard.** For organisers writing challenges: Enter on Text Color or Highlight moves straight to the colours, so the arrow keys pick one.
- **Undo takes back a colour.** For organisers writing challenges: Ctrl+Z (⌘Z on a Mac) undoes a Text Color or Highlight pick, the last one first, not the typing before it; Ctrl+Shift+Z or Ctrl+Y (⇧⌘Z) redoes it.
- **A colour picked before you type reaches every keyboard.** For organisers writing challenges: text entered with a phone keyboard or a Chinese, Japanese or Korean input method takes the colour too.
- **A table's header, body and footer keep only a background colour and alignment.** For organisers writing challenges: other styling there is dropped when you paste or save, so a table can never be drawn over the page.
- **Next challenge skips a challenge you have no attempts left on.** For participants in an event that limits attempts: the progress strip on the events page skips it too.
- **Event pickers list finished events last.** For admins and organisers: wherever you pick an event, live events come first, then upcoming ones soonest first, then finished ones, the most recent first.
- **Codes sent through a join link stop joining once you turn it off or replace it.** For organisers: after you clear Enable self-enrollment or press Regenerate link, such a code still signs in, without joining.
- **Sign-in emails say a join holds only while the link is open.** For participants: a code asked for through an event's join link says it joins the event as long as that link is still open.
- **History says when a certificate download may be a mail scanner's.** For organisers: a download through the certificate email's link reads "from the email link (may be a mail scanner)", as scanners open every link.
- **Removals wait for you when a set-up record cannot be read.** For superadmins: a Checkmarx One account named by a damaged set-up record of someone still on the platform is held for your decision.
- **Email also waits while the database needs repair.** For operators: on a damaged or not fully upgraded database, certificate emails and team reports wait until it is fixed and the server restarted.
- **Removing someone from an event's team takes their address out of its report records.** For organisers: only their email's domain is kept, earlier removals included, and adding them back never sends a report twice.
- **Certificates no longer keep a copy of their share image.** For operators: about 150 KB less database per certificate; a server that loses its image renderer reports the image unavailable, as it does the PDF.
- **Expired LinkedIn share links are cleared.** For participants: a share link from the certificate email is deleted 30 days after it expired; until then its page still says it has expired.
- **A large challenge import pauses the platform for less time.** For admins who import challenges: 10 000 challenges now pause it for about 3 seconds, where they took about 7.
- **Importing participants no longer slows down as the platform grows.** For admins who import participants: 5 000 people pause it for one to two seconds, even with 10 000 accounts already there, where it took about 9.

### Fixed

- **Opening an event on a phone held sideways keeps its header on screen.** For organisers: the page no longer scrolls past the event's name, status, join pill, Invite and ⋯ menu.
- **Opening another event from search takes you to its name.** For organisers using a keyboard or a screen reader: the event just opened is announced, as one opened from the Events list is.
- **The Challenges page no longer jumps as it loads.** For participants: the filters, search box and challenge cards stay where they first appear while the list loads.
- **Chips and highlights follow your look's colour.** For everyone in the Ambient look: the Solved chip, category ribbons, event-type chips and the chosen rows in pickers take the colour you picked instead of violet.
- **Search and menu icons are easier to see.** For everyone: the magnifier in every search box, and the warning and delete icons in row menus, are drawn at full strength instead of faded.
- **The look and Help buttons are easier to tap.** For visitors and anyone opening Help: on the sign-in screen and in the help panel, a tap just outside these round buttons still presses them.
- **Corners match across the Ambient look.** For everyone using the Ambient look: the leaderboard podium, search boxes and lists in dialogs, the rich-text editor and loading placeholders now round like the rest.
- **Pages opened from an email match the app.** For everyone opening the verification, email-change or LinkedIn share page: at night their header and footer take their card's colour, as the app's do.
- **Switching an event's section shows its first controls.** For organisers: a section opened from a scrolled page puts its heading and search box below the event's header strip, not behind it.
- **The event's header strip sits right under the top bar.** For organisers on a laptop or desktop: scrolled, the strip no longer leaves a gap that the page shows through.
- **A challenge's title shows below the play bar.** For participants: a challenge opened from a scrolled list no longer has its title hidden under the bar.
- **A History entry that cannot be read no longer breaks the list.** For admins and organisers: History, the Audit page and the person export still open, and that entry says its details could not be read.
- **Certificate entries in History read in words.** For organisers: issues, image downloads, shares, revocations with their reason, Issue again, each congratulations email and code look-ups say what happened.
- **The Assign to Events dialog's Save button no longer looks faded.** For organisers: until you tick or untick an event it shows as an unavailable button at full strength, so its label stays easy to read.
- **Red and amber in row menus and People statuses match your look by day.** For admins: Delete and warning items' hover tints, and the Locked and Denied statuses, take the look's own red and amber, as they did at night.

## 9.2.12 — 24 November 2026

### New and changed

- **Admin tables on a tablet get a Sort & filter button.** For admins on a tablet or a phone held sideways: it opens the same sort and filter as each column heading, as a bigger target to tap.
- **The certificate designer greys out the QR box while the certificate ID is hidden.** For organisers: the QR prints only beside the ID, and a note beside the box says so.
- **Exports name their columns as the screens do.** For organisers: the full event export says Salutation and Work Title, and a person's export labels each profile field as their profile does.
- **A revoked certificate's private link stays out of History and exports.** For admins: the revocation is still recorded with its reason, without the link.
- **Importing participants is faster.** For admins who import participants: a large import no longer spends time preparing a password nobody uses.

### Fixed

- **Wrong surnames at a certificate check count per network.** For anyone checking a certificate: guesses from the many addresses of one network now share one limit, over IPv6 too.
- **The certificate's QR code has a full white border.** For anyone checking a certificate: phones read it more reliably.
- **A test event's leaderboard promises no certificates.** For participants: the top three of a dry-run event no longer show a Gold, Silver or Bronze certificate.
- **Team reports count scores as the leaderboard does.** For event teams: a challenge since removed from the event, or one answered correctly twice, no longer adds to a lead's score.
- **The Rankings top three follows a revoked certificate.** For organisers: a place whose certificate was revoked offers the design preview again, not the revoked PDF.
- **Quick start refuses a start time that does not exist.** For organisers: a time inside the hour a clock change skips is refused with the reason, as the event form does.
- **Assign to Events lists the events in the usual order.** For organisers: live events first, then the others by start, as every other event picker does.
- **The organisation's default look is offered by permission.** For admins whose role may set the platform look: the Appearance page offers the organisation default, as Settings does.
- **Deleting a person says who removes an account nothing records.** For admins whose role can delete accounts: the message says a superadmin removes that Checkmarx One account by hand.

## 9.2.11 — 24 November 2026

### New and changed

- **Team report emails say how to stop them.** For event team members: every report ends by saying to ask the event's organiser to remove you from the team.
- **The LinkedIn post follows the certificate design.** For participants: the post includes the certificate's verification link only when the event's certificate shows its ID.
- **Everyone who can delete people sees the Checkmarx One warning.** For admins whose role can delete accounts: the delete confirmation says the person's Checkmarx One account is removed too, as superadmins already saw.
- **A personal address added through Add user is noted in History.** For superadmins: an account created under Users & roles with a Gmail-type address records that the work-address rule was skipped.

### Fixed

- **Wrong surnames at a certificate check block only the person typing them.** For anyone checking a certificate: someone else's failed attempts no longer lock that certificate's check for an hour.
- **Automatic certificates follow late tag and role changes.** For organisers: someone tagged staff or benchmark, or made an organiser, before the certificates go out gets none, and the people below them move up.
- **Small buttons are easier to tap on touch screens.** For everyone: the ? help tips answer across a finger-sized area. For admins: so does a column heading's sort and filter button, on a phone or a large touch screen.
- **Adding a team member waits out a brief database lock.** For organisers: adding someone to an event team, or saving its targets, waits a few seconds for server maintenance instead of failing at once.
- **A team report that cannot be built stops after three tries.** For organisers: the event's History says the report was given up, instead of it being retried for ever.

## 9.2.10 — 23 November 2026

### Fixed

- **Light certificate designs print a QR code phones can read.** For organisers: a design with a light background draws its verification QR in dark squares on a light plate, as dark designs always have.

## 9.2.9 — 23 November 2026

### New and changed

- **Certificate wording the fonts cannot print is refused.** For organisers: a design with a script the certificate cannot draw, or a placeholder in a medal headline, is refused with the reason.
- **A redeploy that cannot build keeps the old version running.** For server operators: the documented redeploy builds first, and says how to update the pinned build tools when the base image moves.

### Fixed

- **A session chip opens another event as the event itself does.** For organisers: an earlier tick to list people beyond the event, or an old Challenges page, no longer carries over.
- **A held certificate's card no longer flashes Get my certificate.** For participants: the leaderboard reads your certificate before drawing its card, on first opening and after the certificate dialog.
- **A column sort can be cleared.** For organisers: the button above a list clears a sort too and restores the original order, and a list for one event starts unsorted in another.
- **The column that sorts a list shows its arrow.** For organisers: a heading sorted through its filter button shows its arrow, as other headings do.
- **Saving an older event adds no empty sign-up change to History.** For organisers: an event whose sign-up form was set long ago records nothing when the form did not change.
- **Top 3 certificate files are named after their holders.** For organisers: each file in the ZIP carries its place and the holder's name, in any script.
- **A challenge import no longer overwrites one event's qualifying question for another's.** For superadmins: rows that cannot say which copy they mean, or carry a malformed qualifying tag, are skipped and listed.
- **Moving an installation gives the restored data the right owner.** For server operators: unpacking as root uses the folder you prepared, or the owner the old server recorded, and says which.

## 9.2.8 — 23 November 2026

### New and changed

- **Invitations from roles that cannot approve wait for approval.** For superadmins: with **Require admin approval for new accounts** on, such invitees wait, listed in **People** for the event's organisers.
- **At the desk says why a role that cannot approve may not use it.** For superadmins: while new accounts wait for approval, a custom role without Approve and deny accounts is told why instead.
- **Templates leave out challenges of events you compete in.** For admins: such a challenge cannot go into a template, and an event made from a template or a clone leaves it out and says why.
- **Viewing as a participant hides their certificate code.** For admins: their certificate's code, link and downloads are hidden unless you may look certificates up by code.

### Fixed

- **Certificate emails are not retried to blocked or denied people.** For organisers: a failed email is not sent again to someone blocked, denied or no longer approved since, and **Re-send** refuses them.
- **Download top 3 certificates leaves out one revoked meanwhile.** For organisers: a certificate revoked while the file is prepared is left out and the message says so.
- **A reopened event's team gets no 48-hour reminder.** For organisers: the hot-leads reminder waits until the event ends again, and is sent once.
- **A Program certificate keeps the day you completed it.** For participants: answering a Quick question afterwards no longer changes the certificate's date.
- **Making a challenge a qualifying question re-scores its answers.** For organisers: points already earned on it, and the leaderboard, change at once in every event using it. A locked one must be unlocked first.
- **Names with & or an apostrophe read right in plain-text emails.** For everyone: the plain-text part of certificate and sign-up emails shows such names as typed.

## 9.2.7 — 22 November 2026

### New and changed

- **A sign-in code joins an event only where you asked for it.** For participants: a code asked for through an event's join link joins you when entered in the browser where you asked. Elsewhere it only signs you in.
- **Certificate codes are listed only for code lookups.** For organisers: **Certificates** shows codes only to superadmins and roles granted **Look up a certificate by its code**; each PDF still carries its code.
- **An invitation approves only people it brings into your events.** For event admins: inviting someone waiting for approval approves them if they join one of your events; if not, they wait, and the summary says so.
- **Managers are compared only with their appointer's events.** For event admins: a manager you add to an event team is compared with your own past events, never with other organisers'.
- **The Audit page keeps visitors' details to raw-log readers.** For event admins: the address and browser of whoever checked a certificate or asked for a code, and address-block alerts, are no longer shown to you.
- **Code sign-in has a limit per network.** For everyone: one network can try up to 600 sign-in codes a minute, across all addresses, as with passwords. An event's trusted networks have no such limit.

### Fixed

- **Approving a selection says why people stayed waiting.** For organisers: **Approve** on the selection bar skips anyone you compete against, as a person's own **Approve** does, and says whom it skipped and why.
- **Staff competing and qualifying questions: an accurate message.** For organisers: choosing both explains that a qualifying question can never be sealed, so an event where staff compete cannot ask any.
- **A challenge import never makes a sealed challenge an Any answer one.** For superadmins: such an overwrite is skipped and counted in the import summary.

## 9.2.5 — 22 November 2026

### Fixed

- **Presses on the Events list survive its refresh.** For organisers: **Open**, a session or ⋮ responds even when the list refreshes at that moment, unless that event itself just changed, and keyboard focus stays put.
- **Signing in again in one tab keeps your other tabs signed in.** For everyone: a tab that was loading something at that moment no longer says you were signed out.

## 9.2.3 — 21 November 2026

### Fixed

- **Sign-in codes promise a join only when they make one.** For organisers and staff: a code asked for through an event's join link says it will join you to the event only when signing in will.
- **The security page says what it covers.** For platform operators: the security page and the README say their scan and test figures date from 1 November, and three claims about logs, data files and SQL are corrected.

## 9.2.2 — 21 November 2026

### Fixed

- **Viewing as someone never joins an event for them.** For superadmins: join links and event codes are refused while you view as a participant, so nobody counts as joined unasked. Use **Add to event** instead.
- **Only pick-one questions can be qualifying questions.** For organisers: other challenges are refused as one, since the team reports read the option picked. Older ones warn of no penalty, and their hints are free.
- **A deleted event's workspace closes.** For event admins: when the only event you organise is deleted, or your access to it ends, its workspace closes and the Events list returns.
- **Certificates say why none were issued.** For organisers: when an event's congratulations email is off, or it ended before automatic certificates began, the Overview and the top-3 download say so, not "being issued".
- **New sign-ups in a rush do less work.** For walk-up events: each new sign-up and join takes less of the server's time, so a booth's rush of new people slows everyone else less.
- **Refused sign-up attempts are capped in the audit trail.** For administrators: personal or reserved addresses tried over and over from one network address add a limited number of records, and are counted beyond that.

## 9.2.0 — 21 November 2026

### New and changed

- **Not your event? Continue without it.** For participants: the sign-in card and sign-up form can drop an event a link, QR or code brought you to; a code already emailed still signs you in, without joining it.
- **Choose what a restored backup emails.** For whoever restores a backup: certificates and team reports for events that ended before the restore can count as already sent, so nobody is emailed again.
- **Issue a certificate again.** For superadmins: an event's Certificates list can revoke a certificate and then issue a new one from the event's current results, with a new code.
- **Reviving an event keeps its certificates.** For organisers: the save's confirmation says how many certificates the event has issued, and that they stay as issued when it comes back to life.
- **Team reports rank each session on its own.** For event teams: where sessions are ranked separately, the reports give a podium for each session, and each lead's place within their own session.
- **Raw logs' Audit log pages like the audit trail.** For administrators: its first page is counted, later pages hold still, and a search that stops short says how far back it looked; Next looks further.

## 9.1.19 — 17 November 2026

### Fixed

- **A room is not blocked when its sessions end.** Browsers finding out they were signed out, or waiting at the complete-your-profile form, no longer count against the venue's shared connection.

## 9.1.18 — 17 November 2026

### Fixed

- **Signed-out browsers stay quiet.** When a room's sessions end together, after a long break or a restart, browsers just say you were signed out and stop asking, so the venue's shared connection is not blocked.

## 9.1.17 — 17 November 2026

### Fixed

- **Admins can look through an ended event's sessions.** In Participant View, an admin can open each session of a multi-session event that has ended, to see its challenges and leaderboard.

## 9.1.16 — 17 November 2026

### New and changed

- **Quick questions are no longer cut off.** A Competition that ends early because everyone has solved everything now waits until everyone has also answered its quick questions.

## 9.1.15 — 17 November 2026

### New and changed

- **Organisers who sign in through a join link are not enrolled.** An event admin or administrator who signs in through an event's join link or QR code to check it is no longer added to the event as a participant.
- **Moving an ended event's end keeps its wrap-up report.** When a superadmin moves the end of an event that has already ended, the event team still gets its wrap-up.

## 9.1.14 — 17 November 2026

### New and changed

- **The certificate share page says what pressing does.** The page behind a congratulations email's LinkedIn button now says that copying the post and opening LinkedIn also publishes the certificate's page.
- **The audit trail's export says what it saves.** Its button now reads Export this page (CSV), as it saves only the page on screen.

## 9.1.13 — 17 November 2026

### New and changed

- **Joining tells people what the event's team receives.** Where an event has a report team, the card where people join says what the team gets and how to stay out of its follow-up lists.
- **A No to a follow-up is respected.** Anyone who answers No to "Would you like someone to follow up with you?" is left out of the event team's lead lists, files and cards.
- **Event admins no longer see other events' email subjects.** A participant's History and export leave out emails about events you do not run, and older emails show no subject.
- **Email waits during maintenance.** While maintenance mode is on, certificate emails and event team reports are held, and they go out once it is lifted.

## 9.1.9 — 16 November 2026

### New and changed

- **The audit trail pages like Raw logs.** For administrators: Audit now shows one page at a time with page numbers, a page size and Go to page instead of Load more; Export CSV saves the page shown.

## 9.1.7 — 15 November 2026

### Fixed

- **Deleting accounts follows roles.** For superadmins: a custom role allowed to delete accounts can no longer delete an administrator, a superadmin or anyone whose role can do more than its own.
- **The break-glass username stays out of exports.** For superadmins: the settings export no longer includes the break-glass account's username.
- **Organisers with no events cannot start one.** For administrators: an event admin whose events have all been taken away can no longer start a new event from a template.
- **Joining at sign-in names the person.** For organisers: when someone joins your event as they sign in or sign up through its link, QR code or event code, its History shows who joined and from where.
- **Cancelled sign-up codes are recorded.** For superadmins: when ten wrong guesses cancel a newcomer's sign-up code, the Audit page records it, and the limit on codes emailed to that address still holds.
- **Qualifying answers never end an event.** For organisers: answering a qualifying question can no longer end a Competition whose participants have all finished.
- **Exports list qualifying questions at 0 points.** For organisers: the full event export and the activity export show qualifying questions at the 0 points they score.
- **Restoring a version leaves ended events alone.** For organisers: restoring an older version of a challenge cannot add or remove its qualifying question tag once an event using it has ended a session.
- **No certificate lost to a passing error.** For organisers: if issuing a participant's certificate fails briefly, it is tried again a few minutes later instead of being skipped.
- **Copies keep their late entries.** For organisers: copying a Booth Event whose late entries you closed early gives the copy the usual late-entry time after its end, and the copy's message says so.
- **Program completions from your edits are emailed.** For organisers: a learner who completes a Program because you hid, removed or re-marked a challenge is now issued and emailed their certificate.
- **Late walk-ups after a second end are reported.** For organisers: when a Booth Event is extended and ended again, its event team is told about walk-ups who join in the new late-entry time once it closes.
- **The clone dialog says what stays behind.** For organisers: copying an event now says that its team, lead targets, look and certificate design are not copied.

## 9.1.5 — 15 November 2026

### Fixed

- **Custom roles stay inside their events.** For superadmins: a custom role limited to its own events can no longer delete, lock, verify or revoke outside them, nor hold a permission that covers the whole platform.
- **Custom roles never sit in an organiser's panel.** For superadmins: a custom role allowed to view people as participants can no longer switch from an event admin's participant view into their own panel.
- **Late entrants get their certificate when late entry closes.** For organisers: someone who joins or first answers in the late-entry window is issued and emailed a certificate once it closes by itself.
- **Team reports name only the events you can open.** For organisers: a lead's other events, and who invited them there, show only to readers, and email recipients, who may open those events.
- **Qualifying questions count as scoring.** For event admins: you can make a challenge a qualifying question, or undo it, only while no event you do not organise uses it.
- **Finished events keep their final boards.** For organisers: after an upgrade, people who joined a finished Booth Event in its last ten minutes stay among its late entrants, as when it ended.
- **Upgrading keeps the approval queue.** For superadmins: an installation upgraded from before emailed-code sign-in keeps holding new accounts for approval; turn Require admin approval off in Settings to stop it.

## 9.1.2 — 14 November 2026

### Fixed

- **Joined counts everyone who joined.** For organisers: the event Overview's Joined matches the Events list, shows at once and keeps up while you watch.

## 9.1.1 — 14 November 2026

### New and changed

- **No day/night switch on the sign-in screen.** For everyone: the old toggle is gone; the look picker beside Help sets the look and light or dark mode before you sign in.
- **Raw logs is part of the Audit page again.** For administrators: switch between the audit trail and Raw logs on Audit; Raw logs pages, jumps to a page and keeps refreshing its first page.
- **People lists participants and organisers.** For administrators: admin accounts are listed on Users & roles; tick Show admin accounts on People to list them there too.
- **Certificates print more names.** For participants: names in Arabic, Hebrew, Thai, Chinese, Japanese and Korean now print on certificates, Chinese, Japanese and Korean family name first.
- **A salutation that can't be printed is left off.** For participants: when your salutation can't print beside your name's script, the certificate leaves it off and its dialog says so.
- **One-word names verify whole.** For anyone checking a certificate: a name printed as one word, such as 张伟, verifies typed whole or by its family name.
- **Certificate files carry the name.** For organisers: issued certificates and their previews download named after the printed name, in any script.
- **Medals need points.** For everyone: a top-three place earns a Gold, Silver or Bronze certificate only with points above zero; a participant who attempted gets a participation certificate instead.
- **Start now keeps the scheduled end.** For organisers: starting a Booth Event or Competition early makes it run longer, to the end it was scheduled for.
- **Show sign-in code is for first sign-ins.** For organisers at the desk: once a person has signed in, the desk can only email them a code.
- **Quick questions can be changed.** For participants: you can change your answer to a quick question until the event ends.
- **Time left in a Program's challenge view.** For participants: the bar above a challenge says how long is left, or Late entry, on every screen size.
- **No fixed deadline, said plainly.** For everyone: a Program with no deadline says No fixed deadline on its cards, in its emails, in the challenge view and on organiser screens, never a date ten years out.
- **People's Export CSV follows the screen.** For organisers: the file holds everyone your search and filters show, across every page.
- **Lead questions can be shared.** For organisers: an event can use another event's lead question, but not one on a topic it already asks.
- **Answered lead questions keep their options.** For organisers: once someone answers a lead question, its options can be reworded but not moved or removed.
- **SDR reports carry contact details.** For event teams: each lead in an SDR's email shows its address, with that SDR's lead file attached; members without an account get the next step in words.
- **Reports count leads you can contact.** For event teams: the SDR reminder, the managers' scorecard and the SDR's tile leave out people who opted out of email.
- **Copies turn Checkmarx One accounts off.** For organisers: cloning, or saving as a template, an event with its own Checkmarx One key turns its accounts off, and says why.
- **Checkmarx One accounts on or off, before you create.** For organisers: the Advanced section's summary line and the Create confirmation say whether accounts will be created.
- **Template challenges in difficulty order.** For administrators: a template lists its challenges by difficulty then title, and New template asks for an event type before Create.
- **Allow instant join is gone.** For organisers: the Join Link dialog and templates no longer offer it.
- **No template from an event you play in.** For administrators competing in their own event: Save as template is withheld, as Clone already is.
- **Staff who compete count on the Overview.** For organisers: on an event where staff compete, their play counts in the live figures; elsewhere staff and event admins stay out.
- **Roles see the Settings and Audit they may use.** For people with a custom role: each Settings card and each kind of Audit record follows your permissions; administrators now see Retention and Alerts.
- **Checkmarx One settings stay with superadmins.** For superadmins: the Checkmarx One key and account removals can no longer be given to a custom role.
- **Help and email-link pages follow the platform look.** For everyone: the help page and the pages opened from email links use your organisation's look.
- **Users & roles sorts and filters.** For administrators: its table has Columns, and every heading sorts and filters, as on the other lists.
- **The person export lists removals.** For administrators: a person's ZIP export now includes each time they were taken out of an event.

### Fixed

- **The event workspace keeps up.** For organisers: the Overview, Settings and tab counts follow Start now, End now and the clock, without reopening the event.
- **Regenerate replaces the join link everywhere.** For organisers: after Regenerate, the join pill, Copy link and full-screen QR show the new link and code at once.
- **Links from a team report open the whole event.** For organisers: the link in a report email opens the event's workspace with its header and Overview.
- **Showing someone keeps you in the event.** For organisers: a player in Rankings or Activity opens in the event's own People section, with filters cleared so they are listed.
- **Download top 3 when there is something to download.** For organisers: the button appears once placement certificates exist, and says why when they cannot be issued.
- **Roles see only what they may use.** For people with a custom role: menus, the command palette and pages offer only what your role allows, with no repeating error messages.
- **Templates keep each event type's defaults.** For administrators: Booth and Program templates no longer turn Checkmarx One accounts on, and a template's one board across sessions stays.
- **Cloning after End now.** For organisers: a clone of an event ended early keeps its full length and sessions, and gets one set of qualifying questions.
- **Start now works for Programs.** For organisers: starting a Program early is no longer refused.
- **Editing pick-one questions.** For organisers: rewording or adding options no longer turns earlier answers wrong when scores are recalculated.
- **Profiles save without the optional fields.** For participants: Edit Profile no longer insists on City and Job function.
- **Quick questions read as questions.** For participants: an any-answer question says Answer accepted, shows no attempts line and does not count toward challenges solved.
- **Enter follows links in a challenge.** For participants: pressing Enter on a link in a challenge opens it instead of submitting your answer.
- **Certificates say the right thing.** For participants: a late entrant's certificate no longer says "You placed participant", and a revoked one offers no Share button.
- **Late walk-ups are let in.** For walk-ups during late entry: the join page no longer says the event has ended.
- **Dates and numbers sort correctly.** For organisers: column sorts put dates in time order, and Sort descending works on the rankings boards.
- **Exports match the screen.** For organisers: Analytics and Live rankings CSV files follow the column filters you set.
- **A secondary email change keeps your code.** For everyone: editing your secondary address no longer cancels a sign-in code you are about to type.
- **Phone filters and dialogs.** For organisers on phones: Filters opens as a sheet that Esc or Done closes, and the quick start shows Cancel before Create.
- **Clearer wording.** For everyone: the code step says when a code is on its way and that personal addresses need an invitation; event admins are told how they can create an event.
- **Reports read naturally.** For event teams: figures say 1 lead, 1 company and 1 person, and a Marketing report with no leads says so and attaches no file.
- **Opening an upcoming event after a live one.** For organisers: an upcoming event's workspace opens properly right after leaving a live one.
- **Programs keep their points.** For organisers: the Progress card no longer says a Program has no score.
- **Hyperscreen moves to Ambient at night.** For organisations upgrading from older versions: a Hyperscreen look becomes Ambient at night, however it was saved.

## 9.1.0 — 13 November 2026

### New and changed

- **Two looks: Ambient and Signature.** For everyone: Heritage, Command, Hyperscreen and Checkmarx are gone; an organisation or event that used one now shows Signature (Ambient for Hyperscreen), a browser its default.
- **Hyperscreen organisations are usually set to Dark.** For everyone: an organisation that used Hyperscreen now has Ambient, in most cases with Dark as its mode; superadmins see which in Settings, Platform look.
- **A flatter design.** For everyone: buttons, cards and menus lose their 3D shading, glows and gradients, medals are flat discs, and shadows are softer.
- **Light or dark follows your device.** For everyone: when neither you nor your organisation has picked a mode, the platform matches your device's light or dark setting instead of always opening light.
- **One typeface everywhere.** For everyone: the platform uses Inter on every computer, so text looks the same whatever fonts your machine has.

## 9.0.2 — 12 November 2026

### Fixed

- **Sort and filter on a phone.** For organisers: most lists shown as cards on a phone have Sort & filter above them, with the same sort and filter choices each column heading offers on a wider screen.

## 9.0.1 — 12 November 2026

### Fixed

- **Select all works on a phone.** For organisers: the Challenges and People lists show a Select all box above the cards, so a whole page can be picked for bulk actions.

## 9.0.0 — 11 November 2026

### New and changed

- **Sign in with a password or a code.** For everyone: choose under Profile, How you sign in. Administrators start with a password and everyone else with an emailed code.
- **The password box appears when you need it.** For everyone: type your email and press Continue; if your account uses a password, the box appears, with Email me a code instead below it.
- **Earlier passwords work again.** For anyone who had a password before codes, administrators above all: if your account signs in with a password, the one you had still works.
- **Set your password once.** For administrators without one: sign in with an emailed code, then set a password, or choose to keep using codes.
- **Break-glass sign-in on the normal page.** For platform operators: type the break-glass username in the email box and press Continue; the separate break-glass page is gone.
- **Sign in with your main email address.** For everyone: a secondary email address no longer signs you in, and sign-in codes are never sent to it.
- **Invitations and roles go to main addresses.** For organisers: inviting, or giving a role to, an address that is somebody's secondary email is refused, with the reason.
- **Desk codes stay valid.** For organisers: a code shown at the desk works until it expires, even if the person presses Continue or you press Email sign-in code.
- **Show sign-in code and competitors.** For organisers who compete: the item is not offered for the people you compete alongside.
- **A notice when your password changes.** For everyone: we email your main address whenever a password is set or changed on your account.
- **A cap on sign-ups from one venue.** For organisers: people signing up from one venue address get at most 150 codes every 15 minutes, then none, without being told; a running event's Trusted network IPs lift the cap.

## 8.17.0 — 2 November 2026

### New and changed

- **Event team and lead reports.** For organisers: under Team & reports, name each event's Marketing, Sales, SDR and SE people to be emailed their own report after the end, once a superadmin allows their email domains.
- **Qualifying questions and pick-one answers.** For organisers: Booth Events now ask four qualifying questions, and an Any answer challenge given Options, one per line, lets participants pick one.
- **Your account menu.** For everyone: the round button at the top right holds the view switch, Appearance, Profile, What's new and Sign out, in place of the loose header buttons.
- **An Appearance page.** For everyone: pick Auto, Light or Dark, one of six looks with live previews, and the light colour of Ambient and Hyperscreen; superadmins set the organisation's default look.
- **One typeface everywhere.** For everyone: every page uses Aptos where it is installed and Inter otherwise, on one type scale, in every look.
- **Help tips everywhere.** For everyone: a small "?" beside every non-obvious control, on every screen, explains it in a sentence or two; Show all tips on the Appearance page opens every one at once.
- **One bar for participants.** Events, Challenges and Leaderboard sit in one bar under the header on every device; before an event is chosen, Challenges and Leaderboard are inactive and say why.
- **Pick up where you left off.** For participants: the events page lists up to three live events you have played in this tab, with the challenge you are on, time left and score where the event has them, and Continue.
- **A clearer challenge view.** For participants: every challenge fills the screen, with a time ring except in a Program, keyed options you can pick with A to D and Enter, a Correct panel and Next challenge.
- **A podium that names certificates.** For participants: once an event ends, each podium place shows the certificate it earns, and the table starts at rank 4.
- **Events no longer asks before leaving.** For participants: pressing Events during a live event goes straight to your list; nothing is lost and the clock is unchanged.
- **A compact event header.** For organisers: name, status and dates on two lines, with Invite, the join pill and one ⋯ menu holding End now, Close late entries now, Clone and the rest.
- **An Overview that says what needs you.** For organisers: Ready to start? lists what is left before the start, and while the event runs the Overview flags people waiting for approval and challenges tried but unsolved.
- **The join QR carries its code.** For organisers: the join pill opens the event's QR with its code printed in the centre, plus Copy link and Full-screen QR.
- **Participants shows the event's people.** For organisers: inside an event the list holds only its members; tick Search everyone on the platform to find and add anybody else.
- **Choose your columns.** For organisers: the people list starts with six columns, Columns adds the rest, and Export gathers CSV, JSON and import in one menu.
- **Filters in one place.** For organisers: Events, People and the Challenge library keep their filter chips behind one Filters button, with the active ones shown beside it.
- **One place to start an event.** For administrators: New event offers a blank start for each type and every template; both open one form where the event type is a field you can change.
- **A simpler create form.** For organisers: the essentials come first, rarely used settings sit under Advanced settings, and every non-obvious field has a ? tip.
- **A template fills in the form.** For administrators: picking a template opens the create form already set up, and the event keeps the template's challenges.
- **Templates are hard to lose.** For administrators: built-in templates cannot be deleted, a protected one cannot be deleted until it is unprotected, and Recently deleted restores one in a click.
- **Edit templates on the New event page.** For administrators: New template, Edit, Duplicate, Protect and Delete, with a grouped editor that shows what each event type cannot use.
- **A one-screen challenge editor.** For organisers: the question on the left, settings on the right, hint, explanation and author in rows that open in place, and Save always in view.
- **A simpler Clone dialog.** For organisers: Clone asks for a name and a start, and says it copies the settings and challenges, never the people or scores.
- **Top three certificates in one download.** For organisers: an ended, ranked event offers its 1st, 2nd and 3rd place certificates as one ZIP, on the Events list and the Overview.
- **A thank-you email for each certificate.** For participants: it carries the PDF, the verification code and Copy my LinkedIn post, a one-time link valid for seven days.
- **Copy post & open LinkedIn.** For participants: the same ready-made post is one press away on your certificate, signed in, and LinkedIn opens ready for you to paste it.
- **Certificates need an attempt.** For participants: nobody gets a certificate, or a podium certificate, without attempting at least one challenge.
- **Join links never wait for approval.** For organisers: people who sign up or sign in through an open event's join link, QR code or event code get straight in, even with Require admin approval for new accounts on.
- **Late entrants join after the end.** For Booth Event organisers: only people who join after the event has ended are late entrants; anyone who joined while it ran is an ordinary participant.
- **Certificate designs are for administrators.** Administrators and superadmins change designs; event admins preview and download them, and certificates are now set in Inter.
- **The platform certificate design in Settings.** For administrators: Settings now opens for you with the Certificates design section, where you change the design every event starts from.
- **Every event chooses its sign-up fields.** For organisers: Competitions and Programs now set Salutation, Phone, City, LinkedIn and Job function to Required, Optional or Off, as Booth Events do.
- **Pick challenges while creating an event.** For administrators: the new-event form has a Challenges section to search the library and press tag chips; the ticked challenges are added when you create it.
- **Qualifying questions from a template.** For organisers: Add the qualifying questions is offered when you create an event from a template too.
- **Search challenges by tag.** For administrators: the challenge picker in the template editor finds challenges by tag or category as well as title, shows each one's tags, and adds all shown at once.
- **A reworked certificate designer.** For administrators: sections that open one at a time, a live preview, the email and LinkedIn post in their own section, and Save design always ready.
- **Search with Ctrl+K.** For everyone signed in: Search in the header, or Ctrl+K (⌘K on a Mac), jumps to pages, actions, events and help, showing only what your role can open.
- **A Checkmarx look.** For everyone: a sixth look, in the company's plum and violet, joins the five on the Appearance page, in day and night.
- **Ambient, in Light, is the new default look.** For everyone: a browser with no look of its own, where the organisers set none, gets Ambient in Light, the sign-in page included; choices already made stay.
- **A look for the platform and for each event.** For superadmins: set the platform look, apply it to everyone now or lock it for participants; organisers set an event's own look in its Settings.
- **Columns, sort and filter on admin tables.** For organisers: the Challenge library, People, Groups, rankings and most other admin tables choose columns and sort or filter on each heading, without sideways scrolling.
- **A compact Settings page.** For administrators: Settings lists its sections on the left and shows one at a time, with ? tips and new cards for email, retention and alerts.
- **A profile card.** For organisers: View on a person opens one compact card with their state, addresses, events, certificates and last sign-in.
- **One Audit page.** For organisers: every recorded act, from sign-ins to challenge versions, in one list with filters, plain-language activity names, details and CSV; sealed answers stay withheld.
- **Submissions and Logs moved.** For organisers: Submissions are now each event's Activity tab, and administrators open Logs as Raw logs on the Audit page.
- **Users & roles, and custom roles.** For administrators: one page lists everyone who runs the platform; superadmins add users, change roles and create roles from a permission list, scoped to every event or their own.
- **An answer box that fits the question.** For participants: a text answer is one line, a JSON answer grows to a limit, a file drop zone is compact, and Submit sits just below it, or in a bar at the bottom on a phone.
- **Measured: 3000 sign-ins in a minute.** For organisers: with the venue's address in a running event's Trusted network IPs, 3000 arriving over 60 seconds signed in, 95% in 0.42 s; over 10 seconds, 95% took up to 70 s.
- **A rush of 1000 in seconds.** For organisers: with the venue's address in a running event's Trusted network IPs, 1000 people arriving within 10 seconds were all signed in, 95% within 1.51 s.
- **List the venue for a big event.** For organisers: while a Booth Event or single-session Competition runs, its Trusted network IPs are not throttled; unlisted, 412 of 1000 got in within five minutes in our test.
- **Light on the server.** For platform operators: in our test 1000 signed-in people used about a tenth of one processor core and under 200 MB of memory, so we recommend 2 vCPUs and 2 GB for a 1000-person event.
- **Certificates for 3000 people in minutes.** For organisers: issuing starts five minutes after an event ends, and in our test 3000 certificates were then issued and emailed in 199 seconds.

### Fixed

- **Starting a Booth Event early keeps its length.** For organisers: Start now on a one-hour Booth Event, or a Competition without sessions, runs it for one hour from now, instead of until its original end.
- **A code read out at the desk keeps working.** For organisers: a code shown in the last two minutes is no longer replaced when the participant presses Continue.
- **Signing in on a busy venue network waits its turn.** For everyone: when many sign in at once from one venue, Continue shows Busy and retries for about 45 seconds, then asks you to try again; the venue is not blocked.
- **Phone numbers are spreadsheet-safe.** For organisers: in the participants export, a phone field written like a spreadsheet formula is saved as plain text, so opening the file never runs it.
- **Inviting a rival no longer approves them.** For organisers competing in an event: an invitation cannot approve the account of someone competing against you.
- **Role names are shown as typed.** For superadmins: the Add user dialog shows a custom role's name exactly as it was typed, symbols such as < and > included, and never runs it.
- **Tighter data handling.** For platform operators: Raw logs no longer show who unsubscribes, a new database file is readable by the server alone, and libraries with known security flaws were updated.

## 8.16.0 — 29 October 2026

### New and changed

- **A new look, and five to choose from.** For everyone: Signature, Heritage, Command and Ambient by day and night, and Hyperscreen by night; pick yours under Look & theme.
- **Each event has its own workspace.** For organisers: open an event from Events to run it from one place, with Overview, Participants, Challenges, Rankings, Activity, Analytics, Certificates and Settings.
- **Export a whole event.** For organisers: Export everything, in the event's ⋯ menu, downloads its people, challenges, answers, rankings and certificates as one ZIP of spreadsheets.
- **Templates and Clone.** For organisers: start an event from a template or Quick spin and copy one with Clone; administrators keep a setup with Save as template.
- **Design your certificates.** For organisers: set wording, colours and what a certificate shows, with a live preview, for the platform or for one event under Certificates.
- **Certificates are listed and resent from the event.** For organisers: the Certificates section lists every certificate issued, with its PDF, and resends the congratulations email.
- **Playing a challenge fills the screen.** For participants: the question, a progress track, the time left and your score sit together, and a correct answer gets a celebration.
- **Rankings open on a podium.** For participants: the top three stand on a podium and your own row stays in view; your certificate card offers the PDF and Share on LinkedIn.
- **Built for phones.** For everyone: participants get a one-screen question, and organisers get tables as cards and a section menu.
- **One card to sign in or sign up.** For everyone: type your work email and press Continue; the emailed code signs you in, or confirms your address and opens a short sign-up form.
- **A shorter sign-up.** For participants: name, company and job title, with the location detected; city and job function are optional unless an event requires them.
- **Simpler sign-up settings.** For organisers of a Booth Event: one Required, Optional or Off switch per field, with a live preview of the card.
- **Approval applies to every new account.** For superadmins: with Require admin approval on, sign-ups through join links, QR codes and event codes wait for approval too.
- **A break-glass username you choose.** For the built-in superadmin: change its username under Settings, Break-glass account; the new name is needed from the next sign-in.

## 8.15.1 — 29 October 2026

### New and changed

- **Certificates are emailed when an event ends.** Everyone who earned a certificate gets it as a PDF in a congratulations email written for their placing; Program participants get theirs when they finish.
- **Unsubscribing stops the certificate email, not the certificate.** For participants: if you opted out of event emails, your certificate is still on the event's Challenges page.

## 8.15.0 — 29 October 2026

### New and changed

- **Everyone can sign in with an emailed code.** For everyone: type your address and press Email me a sign-in code; there are no passwords any more, for participants or organisers.
- **Signing up again with a registered address just signs you in.** For everyone: nobody gets a second account; we email that address a code, and the event the form came from is joined.
- **New accounts no longer wait for approval.** Entering the first emailed code approves a sign-up; superadmins can turn on Require admin approval for new accounts in Settings.
- **Email sign-in code replaces Reset Password.** For organisers: it sends a fresh code to the participant's inbox without you seeing it.
- **LinkedIn sign-in is gone.** Accounts made with LinkedIn sign in with an emailed code; sharing a certificate on LinkedIn is unchanged.
- **The built-in superadmin still signs in with a password.** For superadmins: it signs in without email, so it still works when email is down.

## 8.14.5 — 24 October 2026

### Fixed

- **Saving no longer overwrites another organiser's change.** If someone edits a challenge or an event while your form is open, Save now tells you, instead of replacing their edit, even after you switch tabs.
- **Changing the correct options no longer shows the new answer early.** Participants who solved a multiple-choice challenge before the change see a short note instead of the new answer while the event runs.

## 8.14.4 — 22 October 2026

### Fixed

- **An answer can no longer land in the wrong event.** If a second tab opens another event or the event list, a tab still showing the first says it is out of date, and nothing you do there is recorded or penalised.
- **An import can no longer change an account you were refused.** For superadmins: a participant import skips overwriting anybody you compete alongside, and says how many it skipped.
- **A challenge you lock during an import stays as it was.** For superadmins: one locked while a challenge import is being checked is skipped instead of overwritten, and one deleted meanwhile no longer fails the import.
- **The logo no longer sits under the menu on narrower screens.** On tablets and small laptops the header moves to a second row instead, and on phones and tablets the logo is now the smaller size it was meant to be.

## 8.14.3 — 21 October 2026

### Fixed

- **Code shows exactly the characters you type.** In challenge code, `=>`, `==`, `!=` and `--` are no longer drawn as one symbol, and Safari or an iPad no longer turns `--` or quotes into typographic ones.

## 8.14.2 — 21 October 2026

### Fixed

- **Signing out in one tab no longer makes the others say you were idle.** Your other tabs now say you signed out in another tab of this browser.
- **"Signed in elsewhere" gives advice you can follow.** If your account has no password, it says to tell an organiser and secure your email or LinkedIn, instead of asking you to change a password you don't have.
- **Switching view or changing your password no longer signs you out now and then.** A request still on its way from the same tab used to end the session you had just switched to.

## 8.14.1 — 21 October 2026

### New and changed

- **Removal confirmations say an account may go to its owner instead.** For superadmins: **Schedule removal** and **Remove anyway** say that an account whose owner is still on the platform passes to them.
- **A sign-in added just before a deletion now holds the Checkmarx One account too.** For superadmins: one added in the 15 minutes before counts, because the tenant's clock can differ from the platform's.

### Fixed

- **Working in a second tab no longer signs you out.** Signing in again, switching view or impersonating in one tab leaves the others working; a tab that cannot follow says it is out of date and offers **Reload**.
- **A Checkmarx One account goes to its owner even if the tenant has used it.** For superadmins: one whose owner is still on the platform passes to them instead of waiting for your decision.

## 8.14.0 — 21 October 2026

### New and changed

- **Checkmarx One account removals stay listed until they are resolved.** For superadmins: an entry no longer drops off the list after the data-retention period, and says when it has been kept past it.
- **The sign-out message no longer says "inactivity" when a password reset or an organiser ended the session.** A reset is named; a block, denial or deletion just says the participant was signed out.
- **Removals wait for you when the Checkmarx One key cannot see an account's roles.** For superadmins: let the key view the tenant's clients, then press **Retry**, or use **Remove anyway**.

### Fixed

- **An answer, password change or certificate still on its way when a participant is signed out is no longer saved.** Nothing is scored or spent, and the message says to sign in and try again.
- **Someone signing up with a deleted participant's address is no longer linked to a Checkmarx One account being removed.** Their set-up waits and then gets its own account; History shows the wait.
- **A Checkmarx One account the tenant has put to use is held, not removed.** For superadmins: a role given to it, a detail only the tenant sets or a sign-in added after the deletion holds it, and the entry says which.
- **Screen readers and voice control call buttons by what they show.** Event, session and challenge cards, the header's name and verify chips, Export CSV, Copy code and the editor toolbar lead with their visible words.
- **The built-in superadmin's "signed in elsewhere" message gives advice that works.** If that wasn't you, it says to restart the platform, which gives the account a new password, instead of asking you to change it.
- **Firefox and Safari say why an attachment upload was refused.** When there is no room for it, or you have too many uploads pending, you now see the reason instead of "Network error."
- **A page that opens half-loaded recovers by itself.** On unsteady Wi-Fi it reloads once, and if that fails too it says so and shows a **Reload** button instead of buttons that do nothing.

## 8.13.9 — 19 October 2026

### Fixed

- **Buttons no longer fade when you point at them.** They lift slightly with a shadow instead, so their labels stay as readable as at rest.
- **Links in a challenge's text stay readable when you point at them.** They change colour instead of fading.
- **The countdown's last ten seconds pulse without fading.** The time changes shade instead, and in the light theme it now turns red for the final minute, as it already did in the dark theme.
- **Download buttons on a challenge look like buttons again.** They were purple and underlined like a link, and now match the other buttons, including when you point at them.

## 8.13.8 — 19 October 2026

### Fixed

- **Tick boxes and pick lists line up with their text.** The event and challenge forms no longer grey the words beside a box, and Grant Attempts shows each participant beside their button instead of below it.
- **Green and red status words are easier to read in the light theme.** This covers **Assigned**, sent and failed in History, Submissions points, the **Correct** choice badge and the password-reset messages.

## 8.13.7 — 19 October 2026

### New and changed

- **Event admins must tick one of their events to invite people.** **Send Invitations** needs one ticked, and when only one can be ticked it is ticked for you and stays ticked.
- **The Invite dialog tells an event admin when nobody can be invited.** If you cannot invite into any of your events, it says why and **Send Invitations** stays off.

### Fixed

- **Rows you cannot pick in selection lists are easier to read.** They are edged with a dashed line instead of being faded, so the reason beside them stays legible.
- **The Invite dialog's events line up like every other event picker.** Each tick box sits beside its event instead of above it, and events you can pick are no longer greyed.

## 8.13.4 — 10 October 2026

### Fixed

- **A superadmin is really signed out when a page's security check fails.** The built-in superadmin was told they had been signed out, but reloading put them straight back into the admin panel.
- **Uploading an attachment or switching to Participant View after your session has ended now says you were signed out.** Before, it showed an unreadable error code over a page that still looked usable.
- **A participant's history says how many sessions a block, role change or password change signed out.** Before, these entries showed only an internal event name.

## 8.13.3 — 10 October 2026

### New and changed

- **Regenerating an event's join link replaces its short code too.** The old link, QR code and six-character code all stop working, so put the new ones on your signage.

### Fixed

- **Organisers only see sign-up links they may share.** If an invitation also covers events or groups you do not manage, its link is not shown to you, and the invite result says why.
- **A certificate page that does not open no longer blames its owner.** It used to suggest the holder had removed it, which nobody can do.
- **An event another organiser deletes no longer leaves your screens stuck on it.** Within a few seconds the view returns to all events and tells you why.

## 8.13.2 — 8 October 2026

### Fixed

- **The attempts count updates after every answer, on every challenge.** A challenge without an attempt limit kept showing the count from when it was opened until you opened it again.

## 8.13.1 — 6 October 2026

### Fixed

- **Remove anyway only overrules the reason you read.** If a colleague's approval left a Checkmarx One account held for a different reason, your confirmation is refused and the list shows the new reason.
- **A Checkmarx One account in the customer's own group stays held for your decision.** An event set up for a different tenant with a group of the same name no longer lets it be removed.
- **A Checkmarx One account that passed to a new participant is no longer removed.** If someone with the same address is linked to it while a deleted participant's account is still being set up, it stays theirs.
- **The attempts count stays right after an answer is sent twice.** When the reply to a wrong answer is lost and it goes again, the challenge says so, shows how many attempts are left and warns before the last one.
- **The attempts count updates after each wrong answer.** The ordinary challenge card kept the count from when it was opened, so its last-attempt warning did not appear until the challenge was opened again.

## 8.13.0 — 3 October 2026

### New and changed

- **Booth Event multiple choice fills a phone screen.** On a phone or an upright tablet, the question and large answer tiles fill the screen, and the header, menu and footer step aside while it is open.
- **Tap your answer, then confirm it.** The confirmation names the option you tapped, and a double-tap cannot submit by accident.
- **A wrong option is marked.** On the phone layout, the tile you tried says Not correct and cannot be picked again while the question is open; when attempts are limited, the bar shows how many are left.
- **The challenge editor stops at 20 choices.** It says that is the most a challenge can have, instead of offering one more that cannot be saved.

### Fixed

- **A repeated answer is no longer reported as a penalty.** Sending the same answer twice within a few seconds now says it was already counted, instead of announcing a deduction that was never taken.
- **The wrong-answer message is easier to read in the dark theme.**
- **Choices no longer stay highlighted on touch screens.** The option you moved away from kept its highlighted edge until you tapped somewhere else.
- **The score after a wrong answer reads clearly.** The score and the attempts left no longer run together into one number.

## 8.12.8 — 2 October 2026

### New and changed

- **Close late entries now.** Admins, superadmins and an event's organisers can stop a finished Booth Event taking late entries at once, from the event's menu or its banner.
- **People added at the desk follow the event's sign-up form.** A field you make required for an event is asked of everyone you added at its desk too, but they are never asked for a password.

### Fixed

- **The event banner updates as soon as you act from it.** After End Now or Start Now on the banner, it kept its old status and buttons until you clicked somewhere else.
- **Keyboard focus is no longer lost on the event banner.** Closing a confirmation or the event switcher returns you to the control you were on.

## 8.12.7 — 27 September 2026

### New and changed

- **Deleting a participant also removes the Checkmarx One account the platform created for them.** Accounts that already existed are left alone, and ones made before this version wait for a superadmin to confirm.
- **Superadmins see which Checkmarx One removals need their decision.** A banner leads to a list in Settings, where each one can be retried, removed anyway where that is allowed, or marked as done.
- **End Now says when late entries stay open.** On an event taking late entries, its confirmation names the late-entry window instead of saying that nothing more will be accepted.

### Fixed

- **Adding someone at the desk stops if your access changes meanwhile.** If you are blocked, lose your role, stop organising that event or start competing in it, no account is created and no sign-in code is shown.
- **Late entries can be closed straight after End Now.** For about a minute after an event was ended early, no late-entry deadline could be set; the next minute is now accepted, and the message says so.
- **Saving an event just closed with End Now no longer warns that it will reopen.** Changing an unrelated setting in that first minute brought up a warning that the event would become live again.
- **Saving an event keeps the late-entry deadline you set.** The form no longer rounds a set deadline down to the minute, which could make saving an unrelated change fail.
- **Closing late entries early no longer gives a late entrant the fastest time.** Their time now runs to their last correct answer, so a tie is not decided in their favour by accident.

## 8.12.6 — 26 September 2026

### New and changed

- **Add people to a Booth Event while it is taking late entries.** Invite them, assign them, add them at the desk or bind a group, and they join as late entrants until the late-entry deadline.
- **Remove late entrants while late entries are open.** Only people who joined late and had not started playing before the event ended can be taken out, so its final results cannot change.
- **Late entries can no longer be switched on or off once an event has ended.** A superadmin can still close them early by setting the late-entry deadline to now.
- **Emails about an event taking late entries say how long it stays open.** They name the late-entry deadline instead of a start and end that have already passed.
- **Join Link and Manage Participants stay in an event's menu while it is taking late entries.** Before, both disappeared as soon as the event ended, even though its join link still worked.

### Fixed

- **Removing an administrator's access stops what they had in progress.** An upload, an import or an answer given as a participant is not saved, nor is one still running when they sign in elsewhere.
- **Deleting a participant now stops their Checkmarx One setup.** If it was still running, the account is not given access, and an account created for them in that moment is removed.
- **A superadmin is never shown a sealed answer or hint without it being recorded.** If the challenge's History cannot be updated at that moment, they stay hidden, the screen says why, and no points are deducted.
- **A slow challenge no longer replaces the one you opened next or wipes what you typed.** A result that arrives after you move on is reported with the challenge's name instead.
- **The Join Link and History dialogs always show the event you opened.** A slow response no longer shows, or changes, a different event from the one on screen.
- **Row menus no longer start closing themselves the moment they open.** This could happen after a menu was closed very quickly, and lasted until the page was reloaded.
- **Password-reset emails show when the link really stops working.** Asking again while a link still works sends the same link, and the superadmin's reset-link window now shows its real expiry too.
- **On phones, the admin menu button no longer hides page titles or items in the open menu.** Tapping it twice, switching view or turning the device with the menu open no longer leaves the keyboard stuck.
- **Leaving an event and rejoining after it ends no longer changes its results.** Anyone who played before the end cannot come back as a late entrant, through the join link or an organiser.
- **The Assign button no longer offers an event just closed with End Now.** For about a minute afterwards it offered an event that then refused everyone you picked.
- **Challenge dialogs always show the challenge you picked.** Opening Assign to Events, Grant Attempts or an event's challenge list twice quickly no longer shows or saves the wrong one.
- **Leaving an event's waiting page no longer throws you out of the next one.** A late update about the first event no longer moves you or says you were removed.
- **Reminders say how long is really left.** A reminder that goes out less than an hour before the start, for example after the start moved earlier, now says how many minutes remain.
- **Emails are no longer sent to an account deleted moments earlier.** Messages still waiting to go out are dropped once the account is gone.
- **A solved multiple-choice challenge says why its answer is hidden.** While the event is running, a challenge whose answer is sealed now explains why its options are not marked.

## 8.12.4 — 25 September 2026

### Fixed

- **Ending an event's last session now always shows the event's end in its History.** It was occasionally missing, whether you ended the session or it closed because everyone had solved everything.

## 8.12.2 — 24 September 2026

### New and changed

- **A sealed challenge's hint is now hidden along with its answer.** Only its author sees it on admin screens, in exports and in answers shown after an event; a participant who paid for it keeps it.
- **Superadmins can reveal a sealed challenge's answer.** Choose Reveal sealed answer from the challenge's menu or editor to see its answer, explanation and hint, and to edit or unseal it.
- **Every reveal appears in the challenge's History and in Logs, with the superadmin's name.** In History it shows as a Record entry, which cannot be restored.
- **A reveal lasts until you sign out, switch between Admin View and Participant View, change your password, or start or stop impersonating.** Revealing again after that adds a new entry.
- **Revealing while impersonating an event admin also records whose screens you were using.** Other organisers see that name only if they share an event with that person.
- **A superadmin competing in an event cannot reveal the answers of that event's challenges.**
- **On the participant screens, a superadmin sees sealed answers wherever the author would, and each time is recorded.** Never for a challenge in an event they compete in; other admins see neither.
- **Admins who are not competing in an event cannot buy the hint of a sealed challenge.** When impersonating someone who bought it, they see Hint withheld instead.

### Fixed

- **Recalculate Scores no longer appears on a sealed challenge whose answer you cannot see.** It used to appear and then fail.
- **Exporting challenges while impersonating an event admin no longer includes the hints of an event you are competing in.**

## 8.12.1 — 19 September 2026

### New and changed

- **An event admin can be impersonated in their own admin panel, not only in their participant view.** Choosing Impersonate on their row asks which view to open; the panel is the default.
- **Through their panel you see exactly what they see and nothing more.** Only their events, challenges and participants, with no Logs, Settings or New Event, even for a superadmin.
- **Admin View and Participant View switch between an impersonated event admin's two views without ending the impersonation.** The banner names the view you are in, and Exit is always there.
- **Admins can only look around an organiser's panel; superadmins can make changes after the usual confirmation.** History shows every change as made by the superadmin, never by the organiser.
- **Sealed answers are never shown through somebody else's panel, and you cannot seal a challenge on their behalf.**
- **If you compete in an event an organiser runs, you cannot open their panel.** Their participant view still opens.
- **History dialogs now show when something was done while impersonating someone, and through whose view.** The By column names both people.

### Fixed

- **Switching between Admin View and Participant View is no longer refused while impersonating an event admin.** The impersonation continues; while impersonating a participant it is still refused.
- **The competitor rules now apply in somebody else's panel too.** Changes to an event you compete in, its challenges or anyone competing against you are refused there, just as in your own.

## 8.12.0 — 19 September 2026

### New and changed

- **Every event has a "Staff can compete" switch.** On, enrolled staff and event admins score, rank, earn certificates and count towards everyone finishing; off, they stay off the leaderboard.
- **Competing staff appear in the Export Activity file too.** Analytics still leaves staff out by default, so its figures and the export can differ on an event where staff compete.
- **Anyone tagged staff can only be enrolled in events that let staff compete.** Assigning, inviting, adding through a group, the join link and importing participants all skip them anywhere else.
- **An event admin can still be enrolled in any event.**
- **An event where staff compete holds sealed challenges only.** An unsealed one cannot be assigned, the switch cannot go on while one is assigned, and an assigned sealed one cannot be unsealed.
- **Authors cannot compete in an event where staff compete if it includes their challenge.** Enrolling them, assigning it or turning the switch on while they are enrolled is refused or skipped.
- **Anyone competing in an event cannot change it, superadmins included.** Editing it, its sessions or challenges, adding, inviting or removing participants and changing its groups are all refused.
- **Until an event you compete in ends, you can leave it by removing yourself from your own row on the Participants tab.** Once it has ended nobody can leave, and another organiser makes any changes.
- **An event admin can remove themselves only from an event they organise.** For any other event they compete in, another organiser makes the change.
- **Anyone enrolled beside you in an event you compete in is off limits too.** You cannot block, approve, deny, verify, impersonate or delete them, or change their password, role or benchmark tag.
- **You cannot revoke a certificate from an event you compete in.** You can still unlock a fellow competitor's locked account, edit their profile and read their history.
- **The Join Link dialog still opens, read-only, for an event you compete in.** You can copy the link, QR code and short code; the toggles and Regenerate are unavailable, with the reason shown.
- **An import by someone competing in an event leaves that event untouched.** Other people's enrolments, past removals and group links reaching it, and challenge changes, are skipped and counted.
- **On a challenge in an event you compete in, admin screens and the challenge export hide the hint as well as the answer.** The editor and preview say why it is not shown.
- **The switch locks once the event starts, and cannot be turned off while anyone tagged staff is enrolled.** The message names them for removal first; enrolled event admins don't block it.
- **Staff see two sections on their Events page.** "Your Events" lists events they were added to, with a Competing badge where staff compete; "All other events" lists what they may enter as staff.
- **Each section of that page keeps its own filter chips and count.** Narrowing one never empties the other.
- **Competing staff get every confirmation a participant gets.** Entering or switching an event, choosing a live session and leaving an event all ask first; staff only spectating are still not asked.
- **A staff member enrolled in exactly one event now goes straight into it at sign-in.** So does an admin switching to Participant View, as participants already did.
- **A join link to an event where staff compete asks a staff member "Compete in this event?" first.** On any other event the link lets them in as staff, with a note that they were not enrolled.
- **Signing in with LinkedIn through such a link enrols a staff member without asking that question.**

### Fixed

- **Adding staff to an event no longer says "0 newly invited" with no reason, and inviting blocked or unapproved people is no longer silent.** The result says how many were skipped and why.
- **Every reason for skipping someone is spelled out.** Staff where staff do not compete, admins only a superadmin may enrol or add to a group, challenge authors, and blocked or unapproved accounts.

## 8.11.12 — 14 September 2026

### New and changed

- **Column headings you click to sort a table are now easier to tap on phones and tablets.** Nothing changes when you use a mouse.
- **When the admin sidebar is collapsed, hovering over an icon now shows its name**, so each icon is easy to identify again.

### Fixed

- **The password-reset page no longer scrolls sideways on a small phone.** The platform name beside the logo no longer overlaps the version label either.
- **On the Rankings tab, a live event's card no longer shows a pointing hand over its whole area.** Only the event name was ever clickable.
- **Screen-reader users now hear the page header once, not twice, while the help panel is open.** Both navigation menus are now announced by name too.

## 8.11.11 — 14 September 2026

### New and changed

- **An answer that was not marked now shows in amber, not red.** Answering too quickly, or just after a challenge was edited, looked like a wrong answer though no points were lost.
- **Six small links and buttons in the admin tables are now bigger**, so they are easier to tap on a touch screen.

### Fixed

- **A leaderboard that cannot load now says so and offers a retry.** It used to show an empty board, which looked exactly like nobody having scored yet.
- **An answer that could not be submitted no longer shows an empty red box.** Some failures showed a box with no message in it at all.
- **If a challenge's attachments cannot be loaded, the challenge no longer claims it has none.** An organiser could otherwise save the form believing the files were gone.
- **The Challenges, Participants, Groups, Submissions and Rankings tabs now offer a Try again button when they fail to load.** Before, only reloading the page got you back.
- **The page controls at the bottom of a long admin table no longer drop below the edge of the screen.**

## 8.11.10 — 14 September 2026

### Fixed

- **The End Date/Time boxes on the event form now fit a narrow phone screen.** Before, they could push the form so it scrolled sideways.

## 8.11.9 — 14 September 2026

### Fixed

- **The event form no longer scrolls sideways on a phone.** The Duration and End Date/Time columns pushed the dialog past the edge of a small phone's screen.

## 8.11.8 — 14 September 2026

### Fixed

- **The Rankings screen no longer scrolls the whole page sideways on a phone.** A wide table pushed the layout off the edge of the screen.
- **Filters, search boxes and the jump-to-page box no longer zoom the page on an iPhone.** Tapping one used to zoom in, and the page never zoomed back out.
- **Event badges on a participant row are now large enough to tap.** They were tiny and packed close together, so a mis-tap opened the wrong event.

## 8.11.7 — 13 September 2026

### New and changed

- **Every admin screen now carries its own title.** Events, Challenges, Participants, Submissions, Rankings, Analytics, Logs and Settings each show one, matching the Groups screen.

### Fixed

- **Switching admin screens moves the keyboard to that screen's title.** It used to land on an unnamed part of the page.
- **The mobile admin menu behaves like a menu.** The Tab key stays inside it, and Escape closes a dialog opened over it without closing the menu too.
- **The row actions menu responds to the arrow keys, and says which row it belongs to.** The Tab key no longer escapes it and leaves it open over the table.
- **"Skip to content" now moves the keyboard, not just the page.** It used to scroll without moving the keyboard, so the header was still being read out.

## 8.11.6 — 13 September 2026

### Fixed

- **Hovering a link or a sortable column no longer makes it harder to read.** In the dark theme, eleven controls turned a purple that was too dark when you pointed at them.
- **The Back control and the hint price on a challenge are easier to read in the dark theme.** Both were too faint, including the line warning you what a hint will cost.
- **The "public domain" warning chip keeps its colours in the light theme.** Its **Fix** link was the same colour as its background, so it could not be seen.
- **Several faded labels are easier to read.** The hint text in an empty text editor, the verification countdown and the remove-× on a tag were too faint.

## 8.11.5 — 13 September 2026

### Fixed

- **A Booth Event's sign-up settings now work with a screen reader.** The six Optional/Mandatory choices had no spoken name, so they were read out as an unlabelled list.
- **The empty attachments box on a challenge form no longer confuses screen readers.** While empty, it was announced as a broken list.
- **Screen-reader users jumping between headings now reach the New Challenge heading in the right order.** It looks exactly as it did before.

## 8.11.4 — 13 September 2026

### Fixed

- **Taking someone out of a group now asks first, naming the person and the group.** It can end their access to every event linked to that group, and it used to happen in one click.
- **Removing someone from a group now tells you whether it worked.** A refused removal used to show nothing, so the chip just stayed and it looked broken.
- **Tag and group controls are hidden on admin accounts, with the reason shown.** Only a superadmin can change those, and the controls used to appear for everyone and then fail.

## 8.11.1 — 13 September 2026

### Fixed

- **Signing out is final again.** If something was still loading when you signed out, your sign-in could come back and keep working until it expired on its own.
- **Blocking or removing someone mid-upload now stops their submission.** A file answer already on its way was still graded and scored; it is now refused, and nothing is saved or used up.
- **An organiser can no longer reach outside their events by creating a group.** Starting a group with people they do not organise is refused, just as adding them later always was.
- **Deleting a shared group no longer changes another organiser's event.** It is refused, as renaming it already was, because deleting it removes members from every event it is linked to.
- **Copying a certificate link before sharing now says the link is not live yet.** Share also waits for the page to go live before opening the post window, for every certificate.

## 8.11.0 — 12 September 2026

### New and changed

- **The admin Rankings board can hide company and email.** Tick **Hide company & email** above it before showing the standings on a projector, in a screen share or on a shared laptop.
- **Everything else on the board stays.** Place, player, first name, last name, score, time to solve and all solved are unchanged, so it still reads as standings.
- **Search and sorting follow it.** Searching for a company finds nobody while the columns are hidden, and a board sorted by one of them goes back to its usual order.
- **The CSV export still contains both columns.** The download is always the full board, and the note beside the tick box says so.
- **It lasts only while the tab is open.** Reload and the board is complete again; it is a way to present the board, not a limit on who can see what.

## 8.10.3 — 11 September 2026

### Fixed

- **Leaving impersonation no longer freezes the page.** Pressing **Exit** could hang instead of taking you back to your own account, and then sign you out.
- **Exit still works after a long time spent reading a challenge.** It no longer turns into a forced sign-out.

## 8.10.2 — 10 September 2026

### Fixed

- **Exiting impersonation while a challenge was open could freeze the page and sign you out.** That no longer happens.

## 8.10.1 — 10 September 2026

### New and changed

- **An "Any answer (free response)" challenge cannot have its answer sealed.** It accepts every response, so there is nothing to seal, and sealing it would hide the responses from all but its author.
- **The challenge editor blocks this from both sides, and says why.** Choose that answer type and **Seal the answer** is disabled; tick **Seal the answer** and that answer type is not offered.
- **The menu on a sealed challenge now says the seal is why it cannot be changed.** It used to blame authorship, which was the wrong reason to give an admin or a superadmin.

### Fixed

- **A sealed challenge could be switched to the free-response answer type afterwards.** Saving that change, or restoring an older version that used it, is now refused.

## 8.10.0 — 10 September 2026

### New and changed

- **A challenge's answer can be sealed so only its author can see it.** Tick **Seal the answer** when you create it, and no other organiser, admin or superadmin will see it.
- **Only its author can change a sealed challenge.** They alone can edit, publish, hide, tag, rescore it or restore a version; anyone who can see it can still add it to their events.
- **A sealed answer stays hidden wherever answers are usually shown.** The challenge list, the editor, the participant preview, the version history, the export and the Logs tab all leave it out.
- **Participants' submissions to a sealed challenge are hidden too, and cannot be searched for.** Usually a correct submission is the answer itself, so the Submissions search will not find it.
- **Participants are never shown a sealed challenge's answer.** At the end-of-event reveal, or in a solved multiple-choice challenge's marked options, they are told the author kept it private.
- **A seal can be removed once and never put back.** The author can unseal an answer at any time, but nobody can seal it again, because admins have already been able to read it.
- **A "Sealed" badge marks sealed challenges in the challenge list.** You can tell at a glance whether an answer is yours to read.
- **The built-in superadmin account cannot seal an answer.** It is not tied to a named person, so nobody would own the seal; sign in as a named admin instead.
- **Sealed challenges cannot be moved to another platform.** Importing challenges skips any sealed ones and tells you how many were skipped.

## 8.9.1 — 9 September 2026

### New and changed

- **Switching an existing challenge to Any answer removes its hint and its accepted answers when you save.** The editor now says so beside the answer type, before you press Save.
- **The help guides now show the new answer types.** Pictures of the accepted-answers editor, the Any answer editor and its preview, and a participant's Any answer challenge, plus missing details.

## 8.9.0 — 9 September 2026

### New and changed

- **A text challenge can accept several answers.** In the challenge editor, press **+ Add another accepted answer**; each is matched as a single answer always was, ignoring case and spacing.
- **A new answer type, "Any answer (free response)".** Every non-empty answer is accepted exactly as typed, for reflections, feedback and open questions, with no hint and no wrong-answer warning.
- **Free-text responses export with the participants.** With an event focused, **Export CSV** on the Participants tab adds a column per Any answer challenge showing each participant's response.
- **An Any answer challenge counts as solved on the first answer, and can be answered only once.** It counts towards the **All Solved** mark and a completion certificate like any other.

## 8.8.25 — 8 September 2026

### New and changed

- **Saving an event now checks everything before removing any of its sessions.** A refused save, such as a name already in use or an unacceptable schedule, no longer deletes them first.

### Fixed

- **One network can no longer use up all of an account's sign-in codes.** A shared venue connection gets its share, and someone asking from elsewhere can still be sent one.
- **The sign-in code screen now says what to do when a second code has not arrived.** It no longer suggests pressing the button again when nothing more will be sent.
- **A participant's History now says why a sign-in code was not sent.** Either the account has had all its codes, or the network it was asked from has.
- **Repeated uploads of files that are too large no longer lock a whole venue out of the platform.** Signing up with a large photograph is the usual way to upload one.
- **Two people editing one profile at the same time no longer overwrite each other without warning.** The second save is refused and asks you to reload.
- **Leaving the event tab in the background no longer counts as using the platform.** Someone who really has stopped using it is now signed out when they should be.

## 8.8.23 — 8 September 2026

### Fixed

- **A participant is no longer told they left an event they are still in.** Making a sign-up field mandatory during an event used to throw them out; now they are simply asked for it.
- **An answer caught up in this is now submitted for them once they fill the field in.** It used to be shown as incorrect and lost.
- **Revealing a hint or opening a challenge no longer shows a raw error code.**
- **The "complete your profile" box now asks for a company email in the field that can take one.** It used to insist on the one that only changes once you confirm it by email.

## 8.8.20 — 7 September 2026

### New and changed

- **The verification code is now printed on the certificate itself.** It sits at the foot beside the address to check it at, so whoever is handed the certificate can confirm it.
- **Certificates already issued carry the code too.** Download one again and the code is on it.
- **The share image is deliberately unchanged.** It is the small picture shown in social feeds, where a twelve-character code could not be read.
- **The oldest certificates show no verification line.** They were issued without a code and cannot be checked this way.

## 8.8.18 — 7 September 2026

### Fixed

- **A certificate whose holder's name uses ä, ö, ü, å or ø now verifies from either spelling.** Müller is found by typing Mueller, Ågård by Aagaard, and plain Muller still works.
- **This works for every certificate already issued.** The holder has nothing to collect again.
- **The verification page no longer says the holder's name has changed when the only difference is that spelling.**
- **A genuinely different surname is still refused.** Miller does not verify a certificate issued to Müller.

## 8.8.15 — 7 September 2026

### Fixed

- **A capitalisation slip in an event's Checkmarx One group name no longer leaves participants with an account but no group access.** Typing "hackathon-2026" now finds "Hackathon-2026".
- **The participant's History now shows when the group name's capitalisation had to be corrected.** You can then change the event's group name so it matches exactly.
- **Two groups whose names differ only in capitalisation are never guessed between.** Type the name exactly, or the History shows that no group was assigned.

## 8.8.14 — 7 September 2026

### Fixed

- **A certificate whose holder's name uses ø, ł, đ, þ or a similar letter now verifies when an employer types the plain spelling.** Løvland is found by typing Lovland, Þorsteinn by Thorsteinn.
- **This works for every certificate already issued.** The holder has nothing to claim again.
- **A surname written in another alphabet is still matched by its own spelling, and a genuinely different surname is still refused.**

## 8.8.12 — 7 September 2026

### Fixed

- **The Submissions pager no longer says "Sorted within this page" before you have sorted anything.** The newest-first order already covers the whole event, and the note wrongly suggested otherwise.
- **Once you sort a column, the pager now says "Sorted across all matches".** You can tell a sorted view from an untouched one at a glance.
- **The "Sorted within this page" note still appears when a sort really covers only the page in view.**

## 8.8.11 — 5 September 2026

### Fixed

- **Focusing an event no longer hides most of your participants.** The Participants tab showed the event's members plus only the 500 oldest accounts, so newer participants were missing.
- **Everyone can be reached again through the pager and the search box.** You can find someone who has not joined the event yet and add them without clearing the focus.
- **An event admin's view is unchanged.** They still see only the people enrolled in the events they organise.

## 8.8.10 — 5 September 2026

### New and changed

- **An event admin's row no longer shows a label when they have no current events.** It shows badges for the events they are running, or just their role, with no count of finished events.

## 8.8.9 — 5 September 2026

### Fixed

- **Showing an attendee their sign-in code at the desk now always works.** It used to be refused once they had asked for the code by email three times — exactly when help at the desk is needed.
- **Reading a code out at the desk no longer uses up one of their emailed codes**, so somebody you help in person can still be sent one later.
- **A participant's history now records where each submission came from**, as it already did for every other action.

## 8.8.8 — 5 September 2026

### Fixed

- **A challenge's events column now shows only the events you organise.** It used to name other organisers' events holding a shared challenge too — and clicking one of those led nowhere.
- **You are still told when something is held back**, as a count rather than a name, so a challenge in use never looks unused.
- **The "this challenge is in a live event" warning still appears** before you edit one another organiser is running, even though that event is not named.
- **Saving the Assign to Events dialog works as before** — events you cannot see keep their assignments, so a shared challenge saves normally.

## 8.8.7 — 5 September 2026

### New and changed

- **An event admin's row now badges the events they organise.** The badges use the same colours as the Events column beside it, instead of naming one event or counting the rest.
- **Only current events get a badge: live, upcoming and any still taking late entries.** Finished events are left out so they do not crowd out the ones you can act on.
- **Clicking a badge focuses that event.** It works exactly as it does in the Events column.
- **An organiser whose events have all finished now says so, with how many.** It no longer looks like an organiser with no events at all.

## 8.8.6 — 5 September 2026

### Fixed

- **Impersonating a participant now shows only the events you organise.** Their other events, whether finished, running or still to come, are hidden, so it no longer shows another organiser's work.
- **Everything behind that list is covered too.** Opening one of those events, its challenges, its rankings or its certificates is refused, instead of being one link away.
- **A participant whose events you do not organise shows an empty list that says so.** It no longer suggests they are enrolled in nothing.
- **Losing an event while impersonating someone takes effect at once.** It no longer waits until your next sign-in.
- **Full administrators are unchanged.** They still see the participant's whole event list.

## 8.8.5 — 4 September 2026

### Fixed

- **Controls that would always be refused are no longer offered.** On a challenge another organiser is scoring on, Publish, Hide and version Restore disappear and say why.
- **The challenge editor greys out the fields you cannot change on a shared challenge, and says why.** The title and text stay editable, instead of the edit being refused when you save.
- **The Add Challenges dialog no longer lets you untick a challenge somebody else added.** Those stay ticked and greyed out, and hovering one says who can remove it.
- **The message after a bulk assignment now names every reason something was skipped.** That includes events you do not organise, which used to show as a zero with no explanation.
- **Grant Attempts no longer claims that nothing limits attempts on a challenge when it can only see the events you organise.**

## 8.8.4 — 4 September 2026

### Fixed

- **An organiser no longer sees the names and email addresses of people from events they do not run.** A challenge's feedback listed everyone who had rated it once it was in the shared pool.
- **A participant's History now shows only the events you organise.** It showed their whole history, naming challenges and events that belong to other organisers.
- **Challenges in the shared pool now carry a Shared badge in the Status column.** You can spot one without scrolling the table sideways to find its tag.
- **The tag controls are hidden on a challenge you did not create.** They used to be offered and then refused; hovering over the Tags cell explains why.
- **An empty challenge list no longer blames a filter you have not set.** Focusing an event never hid anything, so it now says there is nothing to show.

## 8.8.3 — 4 September 2026

### Fixed

- **A tag that looks like the shared-pool tag but is not is now refused.** A space, an underscore or a pasted dash was accepted and shared nothing; you are now shown the exact spelling.
- **Two kinds of look-alike tag could not be spotted.** Pasted from a document, they looked identical to the real tag on the challenge row but shared nothing, with no way to tell.
- **A challenge already carrying a look-alike tag is marked, with a Fix link.** Fix asks first, then adds the real tag and removes the one that did nothing, with no retyping.
- **The Add Tag dialog now stays open when it refuses a tag.** The chip it points you to is still on screen, instead of the dialog closing before you can use it.
- **The organiser guide no longer says focusing an event hides the shared pool.** It never did; those challenges move below the event's own, which can push them onto the next page.
- **Focusing or clearing an event now takes the challenge list back to page one.** Every other filter already did, so you are no longer left on a page whose contents have changed.

## 8.8.2 — 4 September 2026

### Fixed

- **Sharing a challenge with every organiser is one click.** The Add Tag dialog now offers a public-domain chip and explains what it does, so you no longer need to type the exact words from memory.
- **Typing "public domain" with a space shared nothing.** It was accepted and shown on the challenge but did nothing; the dialog and the guides now say the spelling must be exact.
- **The admin guide now explains the shared pool.** It is covered where the guide describes applying the tag, not only in the organiser's own guide.

## 8.8.0 — 4 September 2026

### New and changed

- **An event still taking late entries is no longer shown as finished.** It has its own **Late entry open** badge, in its own colour, instead of reading Ended.
- **A new Late entry filter in the events list, switched on by default beside Live and Upcoming.** The list now opens showing everything still running, including stands still taking walk-ups.
- **Late entry and Ended are now separate filters.** An event still taking late entries appears under Late entry, not under Ended.
- **The Challenges and Participants tabs show the Late entry open badge too.** Their events columns hide finished events, which used to hide a stand that was still open along with them.

## 8.7.7 — 4 September 2026

### Fixed

- **Event organisers can use Assign to Events again on a challenge another organiser's event also uses.** Saving was refused, with a message naming the other organiser's event.
- **The same refusal also stopped them adding a shared challenge to one of their own events.** It was not only removing it that failed.
- **No challenge assignments were lost while this was broken.** The refused save changed nothing.

## 8.7.6 — 3 September 2026

### Fixed

- **Emailed sign-in codes work again for accounts that never had a password.** Some of these accounts could not be sent a code at all.
- **A sign-in code that is not sent now says why, in the participant's History.** It reads as a plain sentence naming the reason, where before nothing appeared there at all.
- **Invitation emails and security alerts now leave an entry when they are sent.** Before, there was no way to confirm an invitation had actually gone out.

## 8.7.5 — 3 September 2026

### New and changed

- **A Booth Event, a Competition and a Program are collectively called events everywhere you read them.** The **Competitions** tab is now the **Events** tab.
- **The same word is used in emails, dialogs, on-screen counts and the guides.**
- **Each event type keeps its own name.** A **Competition** is still a Competition, alongside **Booth Event** and **Program**.
- **Nothing you have set up changes.** Names, links, join codes and bookmarks all keep working.
- **The participants export now calls its last column Events.** This matches the heading on screen.

## 8.7.4 — 3 September 2026

### Fixed

- **Superadmins can change an event admin's role again.** Their row now offers a role control, so the role can be removed, which also removes them as organiser of every event.
- **The confirmation for demoting an event admin now says how many events they will lose.** The message afterwards says how many were removed; giving them back has to be done by hand.
- **An event admin opening a fellow organiser's profile now sees the read-only view the menu promised.** Previously it opened an editable form that could not be saved.

## 8.7.3 — 3 September 2026

### Fixed

- **Event admins can get back to the admin panel.** The **Admin View** button now appears for them in participant view, so returning no longer needs a page reload.
- **Switching to participant view no longer shows a misleading error.** An admin missing a required profile detail is asked to complete it, instead of being told their events could not load.
- **An event admin stays an event admin after visiting participant view.** Going back to the panel previously showed controls their role does not have, such as creating events and opening Logs.
- **An event admin is no longer locked out when a venue network is blocked for suspicious traffic.** Other administrators on the same network were already exempt.

## 8.7.0 — 3 September 2026

### New and changed

- **A new role: event admin.** An organiser who sees and manages only the events they have been given, and nothing else on the platform.
- **Event admins are given one event at a time.** Focus an event and use **Make event admin** on a participant's row, which only administrators can do; the same menu removes them.
- **Inside their events they can do what you can.** They manage challenges, participants, sessions, rankings and exports, but cannot create events, change roles, or open Logs, Settings or alerts.
- **Their challenges are their own.** They create freely, can use any challenge their events hold or that is tagged **public-domain**, and can edit, publish or hide only their own.
- **They see only participants enrolled in their events.** The events column on each row lists only their events, even for someone who is also in other events.
- **They see only groups they created or that one of their events uses.** They can delete only their own, and cannot change the members of a group also used by an event they do not run.
- **Removing an event admin's last event does not remove the role.** They keep it with no events; a superadmin changing their role back to Participant removes all their events at once.
- **Event admins never appear on a leaderboard.** The same is true of other administrators.
- **Every event's menu now has Organisers.** It lists who runs the event and when each person was added.
- **Event admins get a new Event Admin guide from the help button.** The admin and superadmin guides explain how to give and remove the role.

## 8.6.7 — 2 September 2026

### New and changed

- **Release notes are shorter.** Each entry is a headline and at most one sentence, and releases with nothing you or a participant would notice are no longer listed.

## 8.6.5 — 2 September 2026

### Fixed

- **The page no longer jumps when you open a challenge.** The platform name in the header stays on one line and is hidden when there is no room, but still shows in full on the events list.

## 8.6.4 — 2 September 2026

### Fixed

- **The events list stops jumping as it loads.** It now holds space with a placeholder for each event it is about to show.

## 8.6.3 — 2 September 2026

### New and changed

- **The late-entry deadline follows the schedule.** With an automatic deadline, changing the start, duration or end updates it and its sentence as you type; one you set yourself stays put.
- **The deadline names its timezone.** The deadline and its sentence use the timezone box at the top of the dialog, like your start and end times, and follow it if you change it.
- **The deadline sentence reflects what you chose, in bold.** It now updates when you type a date of your own, which it previously did not.

## 8.6.2 — 2 September 2026

### New and changed

- **A certificate is published only when you press Share.** This now applies to every event type, the participant is told so before sharing, and certificates created earlier keep their page.
- **The Time on Platform setting says what it measures.** The form and the admin guide now explain that only activity on the platform itself counts, and not to judge someone on it alone.

## 8.6.0 — 2 September 2026

### New and changed

- **Late entries arrive on Booth Events only, switched on by default.** The join link keeps working for late arrivals after the event ends on time, and you can switch it off per event.
- **Late entry closes 48 hours after the event ends and follows the end time.** Untick **Automatic** on the event form to pick a date up to 30 days after the end; the form always shows the date used.
- **Late entrants get their own section on the leaderboard, ranked the same way.** It covers anyone who joined from 10 minutes before the end and had not finished, and participants see it too.
- **Late entrants' certificates say "late entrant".** A participation certificate can be collected while late entry is open, a placement one once it closes, and the button says which.
- **The rankings spreadsheet gains a Late Entrant column.** Both sections share one sheet, so rank 1 appears twice and the column tells them apart.
- **An event open for late entry stays in participants' event lists.** It is labelled **Late entry open**, and a late entrant inside it sees a countdown to the deadline and a **Late entry** label.

## 8.5.0 — 2 September 2026

### New and changed

- **Release notes are now in the app.** The sparkle button beside the **?** help button opens them; only admins see the button and the notes, and neither shows in participant view.

## 8.4.1 — 2 September 2026

### New and changed

- **Sign-up with LinkedIn now starts switched off on Booth Events, including existing ones.** Once you switch it on for an event it stays on, and Competitions and Programs are unchanged.
- **The LinkedIn sign-up switch can still be changed on an ended Booth Event.** A note says the setting only takes effect if you run the event again.

### Fixed

- **A Booth Event's sign-up settings no longer disappear from its form.** The LinkedIn sign-up switch was one of the settings that could go missing.

## 8.4.0 — 2 September 2026

### New and changed

- **A Booth Event decides its own sign-up form.** Salutation, password, phone, city, LinkedIn URL and professional role are each Optional or Mandatory; **Show on form** stays ticked if Mandatory.
- **Making a field mandatory asks it of anyone who signed up through that event.** They see a prompt they cannot dismiss, even after it ends; making it optional keeps their answers and asks nobody.
- **Existing Booth Events adopt the new defaults.** Professional role becomes mandatory, and salutation, phone, city, LinkedIn URL and the password boxes are hidden.
- **Allow sign-up with LinkedIn is a switch on a Booth Event.** When off, the sign-up page points to email sign-up instead of showing the LinkedIn button; existing LinkedIn accounts still sign in.

## 8.3.39 — 1 September 2026

### New and changed

- **Importing participants is much faster.** A large import no longer slows sign-ins for everyone else while it runs.
- **A faulty import file cannot demote an admin.** An unrecognised role is skipped and reported: new accounts arrive as participants and existing accounts keep their role.

### Fixed

- **A sign-in already under way can no longer finish with the old password after a password reset.**
- **An import with a value that cannot be saved is refused before any account is created.** The faulty entry is named, instead of the import stopping part-way with some accounts already added.

## 8.3.37 — 1 September 2026

### New and changed

- **Saving a profile only changes the details you edited.** This applies to your own profile and the admin **Edit Profile** dialog, so fixing one detail no longer undoes changes made in the meantime.

### Fixed

- **The certificate name on a participant's profile is now saved.** The dialog reported success but kept the old name, so certificates kept printing the profile name.

## 8.3.36 — 1 September 2026

### New and changed

- **Changing a participant's primary email now asks them to confirm it.** A 48-hour link goes to the new address; until they open it, their current address and verified account stay as they are.
- **The Edit Profile dialog now shows when an email change is waiting.** It says so when you save, and saving a different address replaces the waiting one.
- **Changing an email is a correction, not an emergency measure.** Use **Block** or **Reset Password** to act at once; a secondary email applies on save and cancels any reset link or sign-in code.

### Fixed

- **Correcting a primary email no longer signs a participant out of a live event.** It also no longer leaves them out of the scores, which could end a Competition early.

## 8.3.35 — 31 August 2026

### Fixed

- **When a participant's CxOne account can't be set up, their History now shows the full reason.** Long messages used to stop mid-sentence, hiding what to do next.
- **Importing participants no longer fails outright over one unusual session name.** That entry is skipped and the rest of the file is imported.

## 8.3.34 — 31 August 2026

### New and changed

- **CxOne accounts are matched only by a confirmed email or a username the platform created.** One set up in advance under a nickname with an unconfirmed email is refused, naming it and what to do.
- **The profile editor now says that saving cancels a pending email change.** Saving is the only way to cancel one.

### Fixed

- **Saving a profile dialog left open a long time no longer removes the participant's picture.**

## 8.3.33 — 31 August 2026

### Fixed

- **The Settings tab tells you when it fails to load and offers a retry.** The old forms no longer stay on screen behind a brief error message.
- **Saving the Global Default CheckmarxOne Integration after a failed load keeps its group name.** Before, it could quietly clear the saved group name.

## 8.3.27 — 30 August 2026

### Fixed

- **Superadmins using Impersonate are no longer asked to confirm when pressing Competitions.** Going back to the event list asks nothing; real changes still ask first.

## 8.3.26 — 30 August 2026

### Fixed

- **The challenge list keeps the filter a participant picks during a live event.** Pressing **All** or **Solved** no longer jumps back to **Unsolved**; the starting filter is unchanged.

## 8.3.25 — 30 August 2026

### New and changed

- **Admins can get a participant's certificate for them while impersonating.** The dialog offers the download and says why LinkedIn sharing is off, and the event's History shows which admin did it.

### Fixed

- **Only the participant or a superadmin can publish a certificate page.** Previously any admin impersonating the participant could publish it.
- **A Program completion certificate dialog no longer announces a placing.** It was headed "You placed completed!" and now describes a completion.

## 8.3.23 — 23 August 2026

### Fixed

- **A verification link clicked after the account is already verified now confirms it.** Participants verified by an organiser or a password reset saw "Verification Failed" on a working account.

## 8.3.22 — 23 August 2026

### New and changed

- **Verify now only confirms the email address.** To give someone a link to set a new password, use **Reset Password**; a participant's History no longer shows a password reset nobody did.
- **The help guides describe how things work today.** They no longer recount past changes, and add pictures of the attempt counter, out-of-attempts panel, certificate prompt and **Grant Attempts**.

### Fixed

- **Verifying an account no longer cancels a sign-in code.** A code already read out to someone at the desk keeps working.

## 8.3.21 — 23 August 2026

### New and changed

- **The help guides now say a superadmin can correct the start time of an untouched live event.** It then shows as upcoming again, and settings that lock at the start can be changed again.
- **The help guides now cover attempt limits, Grant Attempts, Start Now, the email delivery panel and completion certificates.** This includes the code used to check a certificate.
- **The participant guide now covers all three event kinds.** It no longer promises someone taking part in a Program a leaderboard, a score or a placement badge.

### Fixed

- **Out-of-date instructions in the help guides are corrected.** Superadmins cannot step down by changing their own role, Verify gives no reset link, and the self-enrolment place limit is gone.

## 8.3.20 — 22 August 2026

### New and changed

- **Alerts about a blocked address are quieter and easier to act on.** Addresses only seeking pages that never existed are blocked with no alert, and alerts say when a block ends, in your time zone.

### Fixed

- **A password reset made while someone signs in elsewhere no longer leaves the old password working.** The reset now takes effect and ends that other sign-in.
- **A password reset link stops working once the password or email address is changed.** That includes an admin correcting the email address.
- **Admin lists that fail to load now say so.** They no longer look empty, and the Analytics filters no longer show tag names when loading them failed.
- **Assigning challenges shows its progress, and says how far it got if the connection drops.**
- **If saving an event is refused after its sessions were already deleted, you are now told the sessions are gone.**

## 8.3.17 — 20 August 2026

### New and changed

- **CxOne accounts are now matched to participants by email address, not by nickname alone.** Taking a nickname used in your CxOne can no longer get that person's account added to the event group.
- **If the CxOne group you set up cannot be found, the participant's History now says so.** Before, it showed as a clean success.
- **The participants CSV export stops text such as nicknames, companies, titles and tags from running as spreadsheet formulas.** Phone numbers export exactly as before.
- **Importing challenges now shortens text longer than the challenge editor allows, and says how many were shortened.** It no longer creates challenges that open but cannot be saved.

### Fixed

- **Removing a tag with a percent sign in its name now works.** It could remove a different tag while reporting success, or fail and leave the tag impossible to delete.
- **A participant import that fails part-way now says how many were imported and refreshes the list.** Before, it only reported a failure.

## 8.3.16 — 19 August 2026

### New and changed

- **An invitation meant for another account is now refused at LinkedIn sign-in.** It stays unused, and the person is asked to sign in with LinkedIn as usual and have you re-send it to their email.

### Fixed

- **Signing in with LinkedIn now only ever opens your own account.** An unused invitation meant for someone else could sign a person in as them, even with an organiser's admin access.
- **Invitation links no longer show up in the Logs tab.** An invitation that has not been used yet can no longer be found there.
- **The join-code box now sits above a participant's list of events.** The page no longer jumps about while the events load.

## 8.3.15 — 19 August 2026

### New and changed

- **Signing in takes participants back to the event they last entered, even a finished one.** This includes Programs, applies even if another event is live, and keeps the session they chose.

### Fixed

- **Opening a finished event no longer makes a participant lose their place.** Their next sign-in takes them back to the event they had chosen.

## 8.3.14 — 19 August 2026

### Fixed

- **Warnings caused by a visitor's own browser add-on no longer flood the Logs tab.** A genuine warning is still shown there.

## 8.3.13 — 19 August 2026

### New and changed

- **The Logs tab warns when visitors' real addresses are hidden from {{platformName}}.** That can quietly make everyone at an event share a single limit on attempts.

### Fixed

- **Signing in, signing up and entering a code now work on a page left open for a while.** A page left open for an hour used to refuse every attempt until it was reloaded.
- **The sign-in screen explains a setup problem instead of showing a bare error.** When {{platformName}} is set up in a way that stops signing in, the screen says what needs fixing.
- **A room opening an event link together no longer gets locked out.** People sharing one venue connection could be blocked for fifteen minutes just by opening the page.

## 8.3.12 — 19 August 2026

### New and changed

- **Signing in with LinkedIn or a sign-in code takes a participant straight into their only event.** That matches what signing in with a password already did.
- **Going back to the events list is remembered after signing out.** Someone who left an event is shown the events list again the next time they sign in.

### Fixed

- **Last Login now updates however a participant signs in.** It used to change only for password sign-ins, so it stayed blank for LinkedIn accounts.

## 8.3.11 — 19 August 2026

### New and changed

- **A Booth Event no longer closes itself when everyone has finished every challenge.** The stand stays open for the next walk-up, and one that had closed itself this way can be reopened.
- **Grant Attempts is offered on ended events.** Giving another try to a participant who ran out is the step that lets a superadmin reopen the event for them.
- **History says participants finished by solving or by running out of attempts.** The reopen warnings say the same where an event closed itself.

### Fixed

- **Visitors who are not signed in can no longer lock out a venue.** At a venue sharing one connection, a few dozen of them could stop walk-ups joining and participants submitting.
- **Some networks no longer make a participant look inactive in time-on-platform ranking.** Looking inactive wrongly placed them ahead of others on a tied score.
- **Participants tied on score in time-ranked events are ordered consistently.** The order could differ between boards, and one who finished everything now always places ahead of one who did not.

## 8.3.10 — 19 August 2026

### New and changed

- **Superadmins can correct the start time of a running event nobody has joined.** Moving the start into the future makes it upcoming again, so settings that lock at the start can be changed.
- **Superadmins can delete a running event nobody has joined.**
- **The event form says why the start time is locked.** It says whether the event already has activity, its sessions set the times, it has ended, or only a superadmin can change it.

## 8.3.9 — 19 August 2026

### Fixed

- **Signing in with LinkedIn or a sign-in code returns a participant to the event they last chose.** In a Competition with sessions they land in the right one, not on the events list every time.

## 8.3.8 — 19 August 2026

### New and changed

- **Participants go straight back into the event they last chose when they sign in.** They land in its challenges if it is running, or its countdown if not.
- **Going back to the events list is remembered.** Pressing **Competitions** in the menu or **Back to Competitions** when choosing a session means the next sign-in starts on the list.

### Fixed

- **Refreshing the events list no longer puts a participant back into the event they just left.**
- **Signing in to an event that is no longer open to a participant now shows the events list with an explanation.** It used to show a blank screen.

## 8.3.7 — 18 August 2026

### New and changed

- **Approving several participants at once now emails each one, even if they opted out of mass email.** Approving one at a time already did, so nobody waits unaware their account is ready.
- **An invitation not sent because the address had unsubscribed now appears in the audit log.**

### Fixed

- **An invitation to an unsubscribed address shows as unsubscribed, not as a failed delivery.** No registration link is offered; superadmins are pointed to the **Unsubscribe List** in **Settings**.

## 8.3.6 — 18 August 2026

### New and changed

- **Signing up at a Booth Event without a password now sends just one email.** Its sign-in code confirms your account and signs you in, instead of a verification link plus a separate code.
- **After signing up without a password, the sign-in dialog opens straight at the code box.** It no longer asks again for the address you just entered, so the code already sent still works.

## 8.3.5 — 18 August 2026

### Fixed

- **Set a Password now opens as a proper centred dialog.** It had appeared as a full-width bar at the bottom of the page for every participant without a password.
- **The Hint heading on a revealed hint is now easy to read in the light theme.**

## 8.3.4 — 18 August 2026

### Fixed

- **Password and Confirm Password now line up on the sign-up form a Booth Event's join link opens.** The note saying visitors may leave both blank now spans the full width of the form.

## 8.3.2 — 18 August 2026

### New and changed

- **A Booth Event's sign-up form now marks the password as optional.** Visitors can leave both boxes empty and sign in with an emailed code instead; Competitions and Programs still need one.
- **Participants without a password see a Set a password reminder beside their name.** Once they set one, they sign in with email and password, and emailed sign-in codes stop working for them.

### Fixed

- **Booth Event sign-up no longer insists on a professional role.** The box was marked optional but still stopped visitors from finishing.

## 8.3.1 — 18 August 2026

### New and changed

- **Professional role is now optional on a Booth Event's sign-up form.** City is still not asked, and neither is ever asked of that person later.
- **A printed join code now opens its own dialog from the sign-in screen.** It names the event the code belongs to, puts sign-up first, and lets a visitor drop the code and carry on.
- **Emailed sign-in codes now have their own dialog.** It asks for your email address and shows which inbox the code was sent to.

### Fixed

- **LinkedIn sign-in no longer turns some older LinkedIn accounts away for good.** Different forms of the same LinkedIn profile link now match, and a real refusal tells organisers how to fix it.

## 8.3.0 — 18 August 2026

### New and changed

- **The event type can be changed until the event starts.** Press **Change type** beside the event type in the **Edit** dialog and pick Booth Event, Competition or Program.
- **A type change is never silent.** Before the form re-opens you are told which settings the new type switches off, and each change is listed in the event's **History**.
- **The schedule changes with the type.** Switching to a Program asks for a deadline, and switching away from one asks for a duration and removes the deadline.
- **Change type is hidden, with the reason shown, once an event has started or has sessions.** It is also refused, naming the challenge, if one of its challenges cannot be answered in the new type.

## 8.2.3 — 18 August 2026

### New and changed

- **New Booth Events allow instant join from creation.** Competitions and Programs have it off, you can change it in the **Join Link** dialog, and email must still be verified within 48 hours.
- **The Join Link dialog shows the web address to print beside the event code.** Attendees can type the code on the sign-in page, the sign-up form or under their events list.

### Fixed

- **With self-enrolment off, the join link, QR code and event code show as inactive.** A note explains why, and the **Copy** buttons still work so you can prepare signage anyway.
- **The event code displays properly on a phone.**

## 8.2.2 — 18 August 2026

### New and changed

- **Self-enrolment limits are gone from the event form.** A join link or printed code keeps accepting walk-ups however many have joined, and any existing limit no longer applies.

### Fixed

- **Checkboxes look like ordinary checkboxes in the dark theme.** An unticked box used to appear as a solid square that looked ticked and broken.
- **The Program create and edit dialog fits on a phone screen.**

## 8.2.1 — 17 August 2026

### Fixed

- **Event type cards no longer dim their text on hover.** The card highlights with a border and a subtle lift instead.

## 8.2.0 — 17 August 2026

### New and changed

- **Creating an event is a two-step wizard.** Choose Booth Event, Competition or Program first, then set only the options that kind supports; editing shows only those options too.

### Fixed

- **Record time on platform, the ranking time basis and the self-enrolment limit now save.** Before, they were lost on save and showed as unset when you reopened the event.
- **Booth Events can no longer be given sessions.** The event used to be created anyway, with a schedule taken from sessions that were then refused.
- **Booth Events and Programs no longer start with CxOne accounts turned on.** The form starts from the default for that kind of event, which you can still change.

## 8.1.9 — 17 August 2026

### Fixed

- **An event or session ended with End Now stays ended.** For about a minute afterwards, any save could silently reopen it; now it reopens only if you change the start, duration or deadline.

## 8.1.8 — 17 August 2026

### New and changed

- **History now shows when joining with the join link makes someone a member of an event in their own right.** That is why removing them from a group then leaves them in the event.

### Fixed

- **Leaving an event takes effect immediately.**
- **Both leaderboards of a Competition ranked by time now list participants with equal scores in the same order.**
- **A participant taken off staff is added to their groups' events straight away.**
- **The Rankings export leaves Time on Platform blank for events that do not record it.** It no longer reads as though participants spent no time.
- **Shortening an event session so that it ends straight away is now shown as ended by an admin.** It used to be shown as having ended automatically.

## 8.1.7 — 17 August 2026

### Fixed

- **A join link opened earlier is still remembered after the event is extended or reopened past its end.** Someone who leaves sign-up and returns is added to the event, not left awaiting approval.
- **An event a participant leaves no longer reappears in their list of events.** It could come back a moment later, and clicking it then failed.

## 8.1.6 — 17 August 2026

### Fixed

- **Participants tagged staff or benchmark are no longer offered a certificate.** They were told a certificate was ready and then that they had not taken part.
- **Sharing a Program certificate no longer posts a link to a page nobody can open yet.** If the page cannot be made public, the share is cancelled and the participant is told to try again.
- **View certificate keeps working for a certificate already issued.** Reopening a Competition or marking it as a test / dry run no longer stops holders seeing their own certificate.

## 8.1.5 — 17 August 2026

### New and changed

- **Grant Attempts appears in a challenge's row menu.** When a participant runs out of tries, you can give them another on the spot.
- **Recalculate asks you to confirm on a challenge in a live event.** It also names participants left with no correct answer and no attempts, pointing you at **Grant Attempts**.

### Fixed

- **Restoring an old challenge version cannot break a live Booth Event.** A restored version needing a file upload or a specific tool is refused.
- **Lowering an attempt limit below what a participant has used no longer shows attempts left.** The card had said so beside a notice that every attempt was used.

## 8.1.4 — 17 August 2026

### New and changed

- **An emailed sign-in code confirms the participant's email address when used.** A code shown at the desk gives the usual 48 hours to confirm the address instead.
- **Wrong sign-in codes count towards the same failed-attempt limit as wrong passwords.** The account holder gets the usual warning email, and their own correct code still signs them in.

### Fixed

- **Participants who have not yet confirmed their email are no longer signed straight back out after using a sign-in code.**
- **Participants awaiting approval are no longer emailed codes that cannot sign them in.**
- **Show sign-in code appears only when a code will genuinely work.** The menu names **Approve** where that is the missing step.
- **The Show sign-in code dialog shows how long a code really has left.** It had always claimed about ten minutes.
- **The sign-in screen's messages about codes are accurate.** It no longer says a code is on its way when none was sent, calls a good code expired, or says someone never signed in was signed out.

## 8.1.3 — 17 August 2026

### Fixed

- **Signing up for a Booth Event with LinkedIn asks the same shorter questions.** It no longer asks for professional role and city where the password sign-up does not.
- **Participant exports now include which sign-up form each account used.** Imported Booth Event walk-ups are no longer stuck behind a profile dialog asking for details their event never asked for.
- **Certificate verification no longer treats a salutation such as "Dr." as a name change.** A genuine change of name is still shown.

## 8.1.2 — 17 August 2026

### New and changed

- **Moving an ended Program's deadline asks you to confirm.** It names the new deadline and says whether the event will go live again.

### Fixed

- **A Program ends on its stated deadline after you move its start date.** It used to keep accepting submissions and issuing certificates for weeks past the deadline.
- **Saving a Program you closed early no longer reopens it.** An unrelated change, or pressing **Save** with nothing edited, used to put it back into a live state.

## 8.1.1 — 17 August 2026

### New and changed

- **A delivery panel on every event.** It shows how many participants are enrolled, verified and unreachable, and you can check it at any time, including before the event starts.

### Fixed

- **A participant removed from an event and added back keeps their original time-to-solve start.** Their clock used to restart on rejoining, which could hand them first place on a tied score.
- **Mistyping a join code no longer counts against the venue's network.** A run of typos from one venue used to lock everyone there out for fifteen minutes.
- **A participant out of attempts is no longer offered a paid hint.** The challenge says to ask an organiser, and any hint already revealed stays free.
- **Certificate verification accepts the name printed on the certificate.** That includes the nickname printed in place of a name the certificate cannot display, as with many non-Latin scripts.
- **Waiting for an event to start no longer counts as time on platform.** Arriving early no longer pushes a participant below a punctual one on a tied score.

## 8.1.0 — 17 August 2026

### New and changed

- **Guide screenshots are refreshed.** Pictures in the admin, superadmin and participant guides match today's screens.

## 8.0.9 — 17 August 2026

### New and changed

- **At the desk, on the Participants tab, signs up a walk-up and shows their sign-in code.** It is verified, approved and in the event in focus, sends no email, and needs a work email.
- **Show sign-in code, in a participant's row menu, gives you a code to read out to them.** It only appears for participants who have never set a password.
- **A participant can only have one working sign-in code or password reset link at a time.** Sending a code cancels an unused reset link, and the reverse, so the latest one always works.
- **The banner showing the event in focus now counts who is active, on events that record time on platform.** Events that don't record time show no count, so it never looks as if nobody is active.

## 8.0.8 — 17 August 2026

### New and changed

- **Time on platform.** A Competition or Program can record the time each participant spends working, counting typing, clicking and scrolling rather than a tab left open.
- **Recording time on platform is off by default and chosen per event.** It is not offered on a Booth Event, which is too short for the number to mean anything.
- **The Rankings export now shows Time on Platform beside Time to Solve.** Either number on its own can mislead on an event that runs over several days.
- **Score ties can be settled on time on platform instead of Time to Solve.** This only separates participants who finished every challenge.
- **Time stops counting when a participant finishes or runs out of attempts.** Nobody gains an edge in a tie by leaving the leaderboard open, and participants see a note on any event that records it.

## 8.0.7 — 16 August 2026

### New and changed

- **An Email me a sign-in code option appears on the sign-in screen.** A participant whose account has no password can ask for a short-lived code and sign straight in with it.

## 8.0.6 — 16 August 2026

### New and changed

- **Leave this event.** A participant who joined through a join link, QR code or join code can leave from the event's waiting screen, keeping solved challenges and revealed hints if they rejoin.
- **Only participants who joined themselves can leave, and only before the event finishes.** Someone an organiser added is told to ask an organiser, and **History** shows leaving apart from removal.

## 8.0.5 — 16 August 2026

### New and changed

- **Every join link has a six-character event code for signs.** It is in the **Join Link** dialog, ignores case and look-alike letters, and stops working when the event ends or self-enrolment is off.

### Fixed

- **A dropped connection while submitting now says the answer may not have arrived.** What the participant typed stays on screen; before, **Submit** just became clickable again with no message.

## 8.0.4 — 16 August 2026

### New and changed

- **A Booth Event only holds challenges a walk-up visitor can answer.** One needing a file upload or a tool is refused by name on assign, edit, tag or import; bulk assigning skips and names it.
- **A new Booth Event's join link and QR code work straight away.** You no longer have to switch self-enrolment on first.
- **A Booth Event's sign-up form asks for eight fields instead of ten.** Professional role and city are dropped and never asked of that account later.
- **The sign-up form states the work-email requirement above the email field.**

## 8.0.3 — 16 August 2026

### New and changed

- **A certificate panel on the participant's challenge list.** It appears when a certificate is ready, then shows the issue date and its code, and says nothing is published unless shared.
- **Program certificates are issued as soon as a participant finishes every challenge.** They are dated the day of finishing, while Competition certificates still wait for the event to end.

### Fixed

- **Program participants can reach a certificate they earned.** The only link had been on the leaderboard, which a Program does not have.

## 8.0.2 — 16 August 2026

### New and changed

- **Anyone can check a certificate.** A certificate's code plus the holder's surname confirms the holder, event and issue date, and says if it was revoked; a code alone gives nothing away.

### Fixed

- **Certificate issue dates are fixed when the certificate is issued.** Extending a Program's deadline no longer rewrites dates on certificates already downloaded or printed.
- **Revoking a certificate always takes effect.** A revocation made while the holder was generating theirs could be missed.

## 8.0.1 — 16 August 2026

### New and changed

- **Every event now has a type.** A Booth Event is a walk-up stand joined by QR code, a Competition is ranked with optional sessions, and a Program is self-paced to a deadline.
- **Programs run to a deadline.** Set a closing date and time or tick *No fixed deadline*, and a Program stays open as individuals finish so people can keep enrolling.
- **Programs are unranked throughout.** Participants see no leaderboard or score, and the **Rankings** tab explains why and points to **Analytics**.
- **Attempt limits.** Cap answers per challenge or per event; participants see how many remain, are warned on their last one and told when they run out, and a hint never uses an attempt.
- **Completion certificates for Programs.** Collected once every assigned challenge is solved, private until the holder shares, revocable by superadmins, with certificate name fields on the profile.

### Fixed

- **Certificate headings look as designed, and Cyrillic and Greek names now appear.** Certificates issued earlier look right the next time they are opened.

## 8.0.0 — 15 August 2026

### New and changed

- **A banner now stays across the admin area while the platform cannot send email.** You can see the problem before participants report missing messages.

### Fixed

- **Reminder emails now show the "&" sign correctly in event and session names.**
- **Participants who signed up with LinkedIn now see Set a Password in their profile.** Before, trying to change their password always said the current one was incorrect.
- **Exporting an event now keeps its self-enrolment, team leaderboard and CxOne settings.** Before, importing it elsewhere could create CxOne accounts the original had switched off.
- **A challenge locked because its event has finished now says who can reopen the event.** It no longer tells you to remove it from the event, which is refused too.
