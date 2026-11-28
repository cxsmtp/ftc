"use strict";

// Participant impersonation (v7.14.0) — client side. An admin enters via the
// Participants-row kebab ("Impersonate"), the server swaps the session onto the
// target (POST /api/admin/participants/:id/impersonate), and a full reload
// boots into the participant view with a fixed banner + Exit button. Exit
// (POST /api/impersonation/exit) restores the admin session and reloads.
// Full-page reloads on both transitions keep the SPA state clean — the
// participant/admin views share too much mutable S state to swap in place.
// The write tier (read-only for admins, confirm-first for superadmins) lives
// in core/api.js' fetch interceptor + the server's impersonationGuard.
//
// v8.12.1 — AN EVENT ADMIN TARGET HAS TWO VIEWS, and the admin picks one at
// entry: the organiser's Event Admin Panel (the default — it is the view a
// support question about an organiser is almost always about) or their
// participant view. The dialog carries the choice as `{view}`; the server
// answers with the same `impersonation` block `/api/me` carries, whose
// `view` / `target_role` the banner reads. Inside the session the ordinary
// Participant View / Admin View toggle switches between the two WITHOUT
// leaving impersonation (the server carries the marker through it), and
// `refreshImpersonationBanner` re-renders the bar so it names the view in
// force. The write tier is unchanged in both views: a regular admin reads the
// organiser's panel and changes nothing, a superadmin is asked before every
// write, and the seal and the competitor lock bind the HUMAN, not the seat.
// Module body is side-effect-free; wiring happens in main.js boot().

import { S } from "../core/state.js";
import { csrfHeaders, loadCsrfToken, sendReplacingSession, _origFetch } from "../core/api.js";
import { _stopAllPolls, _announceSignout } from "./session-monitor.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { showModal } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";
import { esc } from "../ui/format.js";
import { ICO } from "../ui/icons.js";

export async function impersonateParticipant(userId, nickname, role) {
  const label = nickname ? `<strong>${esc(nickname)}</strong>` : "this participant";
  const isOrganiser = role === "event_admin";
  const tierNote = S.isSuperAdmin
    ? "You will have full access — every state-changing action will ask for confirmation first."
    : (isOrganiser
      ? "Impersonation is read-only for admins — you can look at everything the organiser sees, and nothing you do there changes data."
      : "Impersonation is read-only for admins — actions that change data are disabled.");
  // v8.12.1 — an event admin has two views; the dialog asks which. The radios
  // are read back off the modal body AFTER the promise resolves, which is safe
  // because the shared overlay is hidden with a class, never emptied.
  const viewPick = isOrganiser
    ? `<fieldset class="imp-view-pick" role="radiogroup" aria-label="Which of their views to open">
         <legend>Open</legend>
         <label class="checkbox-row"><input type="radio" name="imp-view" value="admin" checked> <span><strong>Their Event Admin Panel</strong> — the events, questions and participants they organise, as they see them</span></label>
         <label class="checkbox-row"><input type="radio" name="imp-view" value="participant"> <span><strong>Their participant view</strong> — the events they are enrolled in as a player</span></label>
       </fieldset>`
    : "";
  const ok = await showModal({
    title: isOrganiser ? "Impersonate event admin" : "Impersonate participant",
    message: `View the platform as ${label}?${viewPick}<br>${tierNote}`,
    confirmText: "Impersonate",
    confirmClass: "",
  });
  if (!ok) return;
  const picked = isOrganiser ? document.querySelector('#modal-body input[name="imp-view"]:checked') : null;
  const view = isOrganiser ? (picked && picked.value === "participant" ? "participant" : "admin") : "participant";
  // v8.10.3 — the same door, the same reason: this POST regenerates the session,
  // so the interceptor must not be able to hang it or read its refusal as an
  // expiry. See _sessionTransitionPost.
  const r = await _sessionTransitionPost(`/api/admin/participants/${encodeURIComponent(userId)}/impersonate`, isOrganiser ? { view } : null);
  if (!r && S._sessionOutOfDate) return;
  const d = r ? await r.json().catch(() => ({})) : {};
  // v8.13.4 — A REFUSED TOKEN HAS ENDED THE ADMIN'S OWN SESSION, so say that.
  // The server destroys every session carrying an identity on `csrf_invalid` —
  // the built-in superadmin's too, since v8.13.4 — so the one retry meets a
  // fresh anonymous session and is refused 401 (or the refresh itself failed and
  // the original 403 comes back). Toasting that raw ("Not authenticated") left
  // the admin on a dead panel until a poll noticed; this is a sign-out, and it
  // is announced exactly as the interceptor announces one. It is the interceptor
  // this POST deliberately bypasses (see _sessionTransitionPost), which is why
  // the announcement has to be made here.
  if (r && (r.status === 401 || d.error === "csrf_invalid")) {
    S._sessionExpiredHandled = true;
    _stopAllPolls();
    await _announceSignout({ kind: "unknown" }, "csrf_invalid");
    return;
  }
  if (!r || !r.ok) {
    const msg = d.error === "impersonation_target_inactive"
      ? `Cannot impersonate: account is ${String(d.reason || "inactive").replace(/_/g, " ")}.`
      : (d.error || "Failed to start impersonation.");
    showToast(msg);
    return;
  }
  // Full reload — boot() reads /api/me, sees `impersonation`, renders the
  // participant view + banner. Mark the navigation as app-initiated so
  // theme-boot.js shows the spinner instead of flashing the login screen at an
  // already-signed-in user for the length of boot's request chain.
  _markAppTransition();
  location.href = "/";
}

/** Tell the next boot that this navigation came from the app, not the address
 *  bar — see theme-boot.js. Best-effort: storage may be unavailable. */
export function _markAppTransition() {
  try { sessionStorage.setItem("ha:transition", "1"); } catch (_) { /* no-op */ }
}

/**
 * v8.10.3 — POST a request whose JOB is to change the session, WITHOUT the
 * session-expiry interceptor in the way, and refresh a stale CSRF token once.
 *
 * `_origFetch`, NOT `window.fetch`, and that is the whole point. The interceptor
 * answers a 401/403 it recognises with `new Promise(() => {})` — a promise that
 * never settles — so an `await` on the intercepted fetch never returns and the
 * `location.href` after it never runs. For an ordinary request that is correct:
 * the caller is being taken to the login page anyway. For these two it is not,
 * because they ARE the session transition, so the interceptor's verdict is about
 * a session that is on its way out either way, and hanging here disables the
 * escape hatch. The paths are on the interceptor's own skip list too; this is
 * the structural half, so a future branch cannot re-wedge the one control an
 * admin has for getting out of somebody else's account.
 *
 * ONE retry on `csrf_invalid`, the `postWithCsrfRetry` rule — and since v8.13.4
 * it RESCUES NOTHING, stated rather than left to be rediscovered. The server
 * ends every session carrying an identity on a refused token (the built-in
 * superadmin's too — it used to survive, which is what this retry once rescued
 * on an Impersonate click), so the retry always meets a fresh anonymous session:
 * the exit answers 400 "Not impersonating" and the caller navigates anyway; the
 * entry answers 401 and the caller announces the sign-out. Kept because it is
 * harmless and never a loop. What DOES keep an admin signed in is the pre-flight
 * below: refreshing a token known to be EMPTY before the first send.
 *
 * Returns the Response, or null if the network failed. Callers must treat BOTH
 * as "navigate anyway" — the reload re-resolves whatever the session now is,
 * which is a better answer than anything this function could infer.
 *
 * BELT AND BRACES, DECLARED AS SUCH: the two paths are ALSO on the interceptor's
 * skip list, and either measure alone prevents the bug — so no behavioural test
 * can hold this line. The source arm in `impersonation-exit-navaway.spec.js` is
 * what keeps both in place.
 */
export async function _sessionTransitionPost(url, body = null) {
  // v8.12.1 — exported, and it takes an optional JSON body: the entry carries
  // `{view}` for an event admin target, and `toggleAdminView` (ui/nav.js) —
  // itself a session-regenerating door, and under impersonation the one that
  // switches views — goes through here rather than the intercepted fetch.
  const send = () => _origFetch(url, body
    ? { method: "POST", headers: csrfHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body) }
    : { method: "POST", headers: csrfHeaders() });
  // NEVER SPEND THE ONE ESCAPE HATCH ON A TOKEN WE KNOW IS UNUSABLE. Sending an
  // empty token is not merely futile: the server's EBADCSRFTOKEN handler
  // DESTROYS an authenticated session, so a page whose boot-time
  // `/api/csrf-token` failed (a 429 from the 120/min per-IP cap, a blip) would
  // sign the admin out by pressing Exit — the "refreshing logs me out" half of
  // the report. Every read in an impersonated browse is a GET, so nothing before
  // this click would have revealed the missing token.
  if (!S.csrfToken) { try { await loadCsrfToken(); } catch (_) { /* send anyway */ } }
  // It replaces this tab's own session, so it goes through
  // `sendReplacingSession` (core/api.js): this tab's writes in flight settle
  // first, later ones wait for the new token (the caller's `loadCsrfToken`
  // releases them), and the token is checked against another tab's session
  // after that wait. Not sent means null, which every caller already handles;
  // out of date, the tab has been told.
  let r = null;
  try { r = await sendReplacingSession(send); } catch (_) { return null; }
  if (!r) return null;
  if (r.status !== 403) return r;
  let d = null;
  try { d = await r.clone().json(); } catch (_) { return r; }
  if (!d || d.error !== "csrf_invalid") return r;
  try {
    if (!(await loadCsrfToken())) return r;
    return (await sendReplacingSession(send)) || r;
  } catch (_) { return r; }
}

export async function exitImpersonation() {
  // The response is deliberately not inspected: whatever it said, the only
  // useful next step is a reload, which re-resolves the session for real.
  await _sessionTransitionPost("/api/impersonation/exit");
  if (S._sessionOutOfDate) return;
  _markAppTransition();
  location.href = "/";
}

// Fixed top banner + Exit button, rendered by boot() whenever /api/me carries
// `impersonation`. Attached to <body> (NOT #user-info — the nav containers are
// rebuilt wholesale by buildParticipantNav) and stacked ABOVE the profile-
// completion gate (z-index 9100 > 4000) so the Exit escape hatch stays
// clickable even when the gate traps a read-only admin on an incomplete-profile
// target; the shared confirm modal (9600) + session-warn (9200) still stack
// above it. body.impersonating compensates the fixed bar's height (styles.css).
export function renderImpersonationBanner() {
  if (!S.impersonation) return;
  if (document.getElementById("impersonation-banner")) return;
  const bar = document.createElement("div");
  bar.id = "impersonation-banner";
  bar.className = "impersonation-banner";
  bar.setAttribute("role", "status");
  setSafeHtml(bar, _impersonationBannerHtml());
  document.body.prepend(bar);
  document.body.classList.add("impersonating");
}

// v8.12.1 — the bar names the VIEW when the target is an event admin, because
// that is the one case where the same person has two and the admin can switch
// between them without leaving the session. A participant target's bar is
// byte-identical to the v7.14.0 one: naming a view they do not have is noise.
function _impersonationBannerHtml() {
  const nickname = S.currentUser?.nickname || S.currentUser?.email || "participant";
  const tier = S.impersonation.superadmin ? "full access" : "read-only";
  const organiser = S.impersonation.target_role === "event_admin";
  // The view clause carries its own leading space, so a participant target's
  // bar is byte-identical to v7.14.0's markup (one space between the name and
  // the tier), not merely rendered alike — the section says so, and a lock
  // reads the markup.
  const view = organiser
    ? ` <span class="imp-banner-view">— ${S.impersonation.view === "admin" ? "their Event Admin Panel" : "their participant view"}</span>`
    : "";
  return `
    <span class="imp-banner-icon">${ICO.eye}</span>
    <span class="imp-banner-text">Impersonating <strong>${esc(nickname)}</strong>${view} <span class="imp-banner-tier">(${tier})</span></span>
    <button class="btn sm imp-banner-exit" data-action="impersonation-exit">${ICO.eyeOff} Exit impersonation</button>
  `;
}

/**
 * v8.12.1 — re-render the bar in place after an in-session view switch. The
 * idempotency guard on `renderImpersonationBanner` is what keeps a re-boot
 * from stacking two bars, so a CHANGE has to go through here. Removes the bar
 * when the session is no longer impersonating (defensive — every exit path
 * reloads the page).
 */
export function refreshImpersonationBanner() {
  const bar = document.getElementById("impersonation-banner");
  if (!S.impersonation) {
    if (bar) bar.remove();
    document.body.classList.remove("impersonating");
    return;
  }
  if (!bar) { renderImpersonationBanner(); return; }
  setSafeHtml(bar, _impersonationBannerHtml());
}
