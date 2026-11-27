"use strict";

// Release notes — the admin-only door (the account menu's What's new; the
// header slot's button is still rendered, but the signed-in header hides it),
// and the one predicate that decides whether it exists (v8.5.0).
//
// WHAT IT IS. `docs/release-notes.md` records, per released version, what an
// organiser or participant can now do that they could not, what behaves
// differently, and which visible breakage was fixed. It is written for the person
// running events on this platform, not for whoever builds it — the engineering
// narrative lives in CLAUDE.md and never reaches this document.
//
// WHY IT REUSES THE HELP DRAWER RATHER THAN GETTING ITS OWN. That drawer already
// owns the focus trap, the shared modal Escape stack, the markdown pipeline, the
// theme-aware screenshot swap and the "open in new tab" hand-off to /help.html.
// A second drawer would be a second copy of all five, and a copy is correct on
// the day it is written and silently divergent afterwards. All this module adds
// is a title.
//
// WHY THE DOOR IS ADMIN-ONLY AND THE DOCUMENT IS GATED TOO. They are ONE
// decision expressed on both sides: the SPA offers the door only when
// `S.isAdmin || S.isSuperAdmin`, and the server refuses `/docs/release-notes.md`
// to anyone who is not a live admin. Offering a control the server is certain to
// refuse is the v7.14.2 defect; withholding it while the server would have served
// it is the same defect with the sides swapped. Reading the same fact on both
// sides is what keeps them from drifting apart.
//
// THE FLAG, NOT THE ROLE, and the difference is deliberate. `S.isAdmin` is FALSE
// for an admin who has toggled into participant view and for a superadmin who is
// impersonating somebody — in both cases the point is to see exactly what that
// participant sees, and in both cases the server's own docs gate answers the same
// way, so an admin-only button on those screens would be wrong twice over.

import { S } from "../core/state.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { ICO } from "../ui/icons.js";
import { openHelpDrawer } from "./help-drawer.js";

export const RELEASE_NOTES_DOC = "/docs/release-notes.md";
export const RELEASE_NOTES_TITLE = "Release notes";

// The single predicate. Both the render below and any future consumer must ask
// it rather than re-deriving the rule — this is the shape that drifted for
// nineteen releases when a client list mirrored a server one by hand.
export function releaseNotesVisible() {
  return !!(S.isAdmin || S.isSuperAdmin);
}

// Idempotent, and called from every place the admin flags can move: boot's
// header mount (anonymous → empty), `buildAdminNav()` and `buildParticipantNav()`.
// Those two builders run on every role transition the SPA can make — sign-in
// (both tiers), the admin/participant view toggle in both directions, a forced
// sign-out (which navigates to `/` and re-boots), and impersonation enter/exit
// (a full reload). Writing the slot rather than toggling a class means a build
// that stops calling this leaves NO button at all, which is the safe direction.
export function renderReleaseNotesButton() {
  const slot = document.getElementById("release-notes-slot");
  if (!slot) return;
  if (!releaseNotesVisible()) { setSafeHtml(slot, ""); return; }
  setSafeHtml(slot, `<button type="button" id="release-notes-btn" class="help-icon-btn"`
    + ` data-action="release-notes-open" title="${RELEASE_NOTES_TITLE} — what changed in each version"`
    + ` aria-label="${RELEASE_NOTES_TITLE}">${ICO.sparkles}</button>`);
}

export function openReleaseNotes() {
  return openHelpDrawer(RELEASE_NOTES_DOC, { title: RELEASE_NOTES_TITLE });
}
