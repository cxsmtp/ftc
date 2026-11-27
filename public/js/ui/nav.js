"use strict";

import { S } from "../core/state.js";
import { csrfHeaders, loadCsrfToken } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { loadAdminAnalytics } from "../features/analytics-admin.js";
import { loadAdminTasks, refreshAfterSessionRegenerate } from "../features/challenges-admin.js";
import { clearCompTimers, clearTsPickerTimers, computeCompStatus, loadMyCompetitions, selectCompetition, showPendingPageForCompetition, showTimeslotPicker } from "../features/competition-picker.js";
import { loadAdminCompetitions, startAdminCompPoll } from "../features/competitions-admin.js";
import { loadAdminGroups } from "../features/groups-admin.js";
import { loadLeaderboard, startLeaderboardPoll } from "../features/leaderboard.js";
import { fireNavigatedAway, loadTasks, startHackathonTimer } from "../features/participant-tasks.js";
import { releaseTapChrome } from "../features/choice-tap.js";
import { loadAdminParticipants } from "../features/participants-admin.js";
import { loadAdminRankingsTab } from "../features/rankings-admin.js";
import { renderReleaseNotesButton, releaseNotesVisible } from "../features/release-notes.js";
import { LOOKS, _lookPreference, _themePreference, _lookLockReason, setEventLook, setStaffBrowser } from "./theme.js";
import { loadAdminSettings, openAdminLogs, stopAdminLogsAutoRefresh } from "../features/settings-admin.js";
import { loadAdminSubmissions } from "../features/submissions-admin.js";
import { esc, policyOrDefault } from "./format.js";
import { colspanFor } from "./list-controls.js";
import { refreshRoleTips } from "./help-tips.js";
import { _actionHandlers } from "../core/dispatcher.js";
import { ICO } from "./icons.js";
import { installOverlayFocusTrap, overlayDismiss, showModal } from "./modal.js";
import { showToast } from "./toast.js";
// v8.12.1 — the view toggle is a session-regenerating door, and under
// impersonation it is the in-session view switch; both halves live in the
// impersonation module. ESM tolerates the cycle this closes (nav → impersonation
// → api → auth → nav) exactly as it tolerates nav → api → auth → nav today:
// every binding is read inside a function, none at module evaluation.
import { _sessionTransitionPost, refreshImpersonationBanner } from "../features/impersonation.js";
import { _stopAllPolls, _announceSignout, setAppShellHint } from "../features/session-monitor.js";

/* v7.15.5 — lift the pre-paint boot mask (html.booting-authed, set by
   theme-boot.js on an app-initiated reload) the moment we actually route
   somewhere. Putting it here rather than at the end of boot() means EVERY
   branch — register, join, admin, participant, the early returns — clears it
   for free, with no try/finally wrapped around boot's whole body. */
function _liftBootMask(){document.documentElement.classList.remove('booting-authed');}

/* THE PARTICIPANT BAR'S ROW, RESERVED FROM FIRST PAINT. A participant's header
   is two rows (the header row and the participant bar under it); signed out, and
   in the admin console, it is one. A reload of a participant's tab paints the
   static, signed-out header first and the bar fills after boot's round trips, so
   #main-content and everything in it moved down by the bar's height (CLS 0.31 on
   the challenge page). The `ha_shell` cookie (session-monitor.js setAppShellHint)
   says "this browser was last showing the participant bar"; theme-boot.js turns it
   into html.app-shell-hint before first paint and the CSS gives the still-EMPTY
   #main-nav the bar's box (`:empty`, so the filled bar takes over with no gap).
   LAYOUT only: the login page still paints (no spinner, the operator's ruling on a
   persisted auth hint) and nothing is hidden from focus routing. Set where the bar
   is built (buildParticipantNav, updateParticipantNav: `3` while the lock note
   shows, as on a phone it takes a line of its own); the admin console sets `2`
   (buildAdminNav), the signed-in header with no bar, as a phone's signed-out
   header has a row of its own for #user-info that the signed-in one dissolves
   (html.app-header-hint, CSS THE SIGNED-IN HEADER, RESERVED). Cleared, classes
   and cookie, wherever the header is the signed-out one (showPage), and by boot
   as soon as it learns nobody is signed in (core/main.js: the session check said
   so, or /api/me and /api/admin/me both answered 401; a failed or refused read of
   a signed-in session leaves the cookie alone): the static login page
   paints without a showPage, so a stale cookie (a session that ended while the
   browser was away) would otherwise keep the signed-in header's geometry, which
   hides the signed-out header's own controls ("?" and the look picker). */
export function dropAppShellHint(){
  document.documentElement.classList.remove('app-shell-hint','app-header-hint','app-note-hint');
  setAppShellHint(false);
}

// audit v7.23.7 (WCAG 2.4.3) — move focus to the destination on a route change.
//
// showPage/showMain/adminTab swap .page visibility and nothing else; focus stayed
// on whatever was clicked, or fell to <body> when that control was inside the
// page being hidden. A keyboard or screen-reader user was never told they had
// arrived anywhere.
//
// FOUR GUARDS, each closing a way this fix would otherwise cause a worse bug:
//
//  1. IDEMPOTENCE. Only a real change of page moves focus. That makes the entire
//     timer surface inert BY CONSTRUCTION rather than by enumeration — and it is
//     needed, because polls DO reach showMain (competition-picker.js's 15s poll
//     routes to tasks-page when a competition goes live, and four separate polls
//     can reach ejectToCompetitionPicker). Those are genuine relocations where
//     announcing is correct; a re-render of the page you are already on is not.
//  2. NEVER ON THE FIRST ROUTE. boot() routes on every page load. Focusing there
//     would jump past <header> and make the skip-link — whose entire purpose is
//     to be the first tab stop — unreachable by Tab: a NEW WCAG failure created
//     by a WCAG fix.
//  3. NEVER FOCUS A NON-RENDERED CANDIDATE. #admin-page has no heading of its
//     own, so a naive querySelector('h1,h2') finds the one inside
//     #admin-groups-tab, which is display:none unless Groups is the open tab.
//     .focus() on a non-rendered element is a SILENT no-op that leaves focus on
//     <body> — the bug wearing the fix's clothes. Hence the getClientRects check
//     and the fall back to the page container itself.
//  4. SEPARATE STATE PER SURFACE. adminTab keeps its own last-value: it always
//     runs inside #admin-page, so sharing showMain's would make guard 1 return
//     early for ever and silently disable admin-tab focus altogether. Its value
//     is the PLACE: the pane and the event it shows (a workspace section is that
//     event's; a sidebar page is every event's). Opening another event on the
//     section on screen (the palette, a report link, a session chip) or leaving
//     an event's Participants for the cross-event People page is a move, and is
//     announced; showing the same place again is not.
//
// WHERE FOCUS LANDS: the container's first rendered h1/h2, unless it names its
// target (`data-route-focus`, an element id) and that target is rendered. The
// workspace's Overview names the event's name, #ws-title: its own heading sits
// below the event's header, KPI band and section tabs, so on a short screen (a
// phone held sideways) focusing it scrolls the header off the top, name,
// status, join pill, Invite and ⋯ with it. The name heads the Overview, so the
// page keeps the header in view; the pane keeps its own heading for the outline.
//
// The skip-link's #main-content cannot be reused as the target: it is a single
// wrapper around EVERY .page, so focusing it announces nothing about where you
// landed.
let _lastRoutedPage = null;
let _lastRoutedPlace = null;   // guard 4: `${pane}@${open event id, or ''}`

function _rendered(el){ return !!el && el.getClientRects().length > 0; }

function _focusTarget(container){
  const named = container.dataset && container.dataset.routeFocus ? document.getElementById(container.dataset.routeFocus) : null;
  if (_rendered(named)) return named;
  const heading = [...container.querySelectorAll('h1,h2')].find(_rendered);
  return heading || container;
}

function _focusRoute(pageId){
  if (pageId === _lastRoutedPage) return;          // guard 1
  const first = _lastRoutedPage === null;
  _lastRoutedPage = pageId;
  if (first) return;                                // guard 2
  const page = document.getElementById(pageId);
  if (!page) return;
  const target = _focusTarget(page);                // guard 3
  target.setAttribute('tabindex','-1');
  publishStripBottoms();                            // the scroll margin reads it now
  try { target.focus({ preventScroll: false }); } catch (e) { console.warn('Could not move focus to the page heading', e); }
}

export function _focusAdminTab(tabId, opts){
  // Read after adminTab has closed or kept the workspace, so it is the event the
  // pane now shows.
  const place = `${tabId}@${S.adminSelectedCompetitionId || ''}`;
  if (place === _lastRoutedPlace) return;           // guard 4 (own state)
  _lastRoutedPlace = place;
  // NO first-route guard here, unlike _focusRoute. Guard 2 exists because boot()
  // routes on page load and focusing there would strand the skip-link. adminTab
  // runs at boot and at sign-in through the panel's landing (`openAdminLanding`,
  // from showMain, and `_relandIfPaneRefused`, from the GET /api/admin/me
  // answer), which nobody asked for: both pass `quiet`, which records the place
  // and moves no focus. Its other callers are navigations a person asked for, so
  // each is announced, the first included: the sidebar and workspace tabs,
  // admin-crossnav's links, the palette, a workspace open (its Overview's target
  // is the event's name) and a report email's link to an event section
  // (features/event-team.js, at sign-in).
  if (opts && opts.quiet) return;
  const pane = document.getElementById(tabId);
  if (!pane) return;
  const target = _focusTarget(pane);
  target.setAttribute('tabindex','-1');
  publishStripBottoms();                            // the scroll margin reads it now
  try { target.focus({ preventScroll: false }); } catch (e) { console.warn('Could not move focus to the page heading', e); }
}

// THE EVENT LOOK (ui/theme.js setEventLook; lib/platform-look.js). Every view
// change funnels through showMain/showPage, so this is the one door that puts
// an event's look on while a participant is inside it and takes it off when
// they leave (the list, the admin page). Sign-out and every session end reload
// the page instead, so they take it off themselves (features/session-monitor.js
// _forgetEventLook), as boot does for a page that loads signed out. The join landing sets its own
// from the token preview (features/self-enroll.js), so a signed-out page keeps
// it only while a join is pending.
function _syncEventLook(id){
  if(id==='admin-page'||id==='competitions-page'||!S.currentCompetitionId){setEventLook(null);return;}
  const c=(S.myCompetitions||[]).find(x=>x&&x.id===S.currentCompetitionId);
  setEventLook(c&&c.event_look?{look:c.event_look,locked:!!c.event_look_locked}:null);
}
export function showPage(id){
  _liftBootMask();
  if(!(S._pendingJoinToken||S._arrivedViaJoin))setEventLook(null);
  // v8.12.6 — a page change supersedes an in-flight challenge OPEN (S._taskViewGen,
  // core/state.js). Bumped at BOTH page-change doors: from the challenge list or
  // detail every participant route reaches showPage only after a showMain today,
  // but a rule held at one door of two is the v8.3.9 defect waiting to happen.
  S._taskViewGen++;
  // v8.12.6 — every exit from the admin page closes the phone drawer; see the
  // same line in showMain for why the page switch is the choke point. No admin
  // exit reaches showPage today (sign-out reloads the page), so this one is
  // defence in depth: every page it shows is a non-admin page.
  _closeAdminSidebarMobile();
  // v8.13.0 — every page here is a non-challenge page, so the booth tap view's
  // compact chrome goes back (see the same line in showMain).
  releaseTapChrome();
  document.querySelectorAll('.page').forEach(p=>{p.style.display='none';p.classList.remove('active');});
  const p=document.getElementById(id);
  if(p){p.style.display='';p.classList.add('active');}
  document.getElementById('main-nav').style.display='none';
  document.getElementById('user-info').style.display='none';
  // The signed-out header: logo, help and the look picker. `is-app`
  // (set by showMain) is what the app-chrome CSS keys the signed-in header on.
  document.getElementById('app-header')?.classList.remove('is-app');
  dropAppShellHint();
  closeProfileMenu();
  _focusRoute(id);
}

// ── v8.1.0 (PR 14) — the two decisions every "enter a competition" path shares ─
//
// TEN sites started the participant pollers, and five of them also re-derived the
// same routing fork. Both are hoisted here, with NO behavioural change: this PR is
// the structural half, and Phase 4 is what makes the two helpers earn their keep —
// a Program has no ranking (so startLeaderboardPoll must not run, and refreshScore
// must not write into an element the page hides) and no waiting screen (so the
// `pending` verdict becomes a picker bounce for that kind).
//
// Hoisting the DECISION rather than wrapping each caller's side effects is
// deliberate: the five forks differ in what they do around the decision — one
// deliberately does nothing when the competition is unavailable, another sets
// S.myCompetitions first, two also stopCompDataPoll() and repaint the nav — and
// collapsing those into one function with four callbacks would be less readable
// than the forks it replaced, not more. What they must NOT each own is the
// predicate, because that is the thing Phase 4 changes.
export function enterCompetitionView(){
  startHackathonTimer();
  // v8.1.0 (PR 18) — the poll is gated here, which is the whole reason the ten
  // sites were hoisted into one: a Program has no board to poll for, and no
  // score to show (the pulse paints the score only where the event is ranked).
  if(policyOrDefault(S.currentCompPolicy).ranking_enabled)startLeaderboardPoll();
}

// 'timeslot' | 'unavailable' | 'enter' | 'pending'
//
// `fallbackStatus` is the caller's own idea of the competition status, used only
// when no timeslot has been chosen — auth.js's single-competition path passes
// computeCompStatus(comp) because S.currentCompStatus is not yet populated there.
// Omit it and the shared S.currentCompStatus is read, which is what four of the
// five callers already did.
export function routeVerdict(result, fallbackStatus){
  if(result==='needsTimeslot')return 'timeslot';
  if(result===false)return 'unavailable';
  const navStatus=S._currentChosenTimeslot?S._currentChosenTimeslot.status
    :(fallbackStatus===undefined?S.currentCompStatus:fallbackStatus);
  return (navStatus==='live'||navStatus==='ended')?'enter':'pending';
}

export function showMain(id){
  _liftBootMask();
  // v8.12.6 — AN OPEN BELONGS TO THE LATEST ASK. Any page change supersedes an
  // openTask() still waiting on its response, so a slow challenge cannot land
  // over the page the participant went to instead (S._taskViewGen). openTask's
  // own showMain('task-detail-page') runs after its checks, so it never
  // invalidates itself.
  //
  // THE CONSTRAINT THIS PLACES ON EVERY FUTURE CALLER, and nothing but this note
  // holds it: a showMain fired by a TIMER while the list or a challenge is on
  // screen would silently drop an open the participant is waiting for. Today's
  // timers that navigate: the status and leaderboard polls do so only to EJECT
  // the participant to the event list (ejectToCompetitionPicker, on a lost
  // membership), where dropping an in-flight open is exactly right; the
  // picker's data poll and the pending countdown mean to navigate only from the
  // pending page — and the data poll re-asks that AFTER its awaits too (v8.12.6
  // sweep: it checked only at the start of its tick, so a participant who had
  // moved on in the meantime was yanked). Keep new timers off this path, or have
  // them leave an in-flight open alone.
  S._taskViewGen++;
  // v8.12.6 — LEAVING THE ADMIN PAGE CLOSES THE PHONE DRAWER. The drawer's
  // modality — the focus trap, the inert content, the Escape-stack entry — was
  // released only by adminTab, the scrim and Escape. The header's "Participant
  // View" is outside both the inert content and the drawer, so a screen reader's
  // virtual cursor reaches it while the drawer is open, and leaving that way
  // carried the trap into the participant app over a now-hidden drawer: Tab went
  // nowhere until Escape. Closing here, at the page switch every exit funnels
  // through, rather than at each exit, is the v8.3.9 "one rule, every door"
  // shape. _closeAdminSidebarMobile is idempotent, so a closed drawer costs
  // nothing.
  if(id!=='admin-page')_closeAdminSidebarMobile();
  // v8.13.0 — LEAVING THE CHALLENGE RESTORES THE CHROME. The booth tap view
  // (features/choice-tap.js) hides the header, nav and footer and moves the
  // countdown into its own bar; every way off the challenge funnels through
  // here — Back, a solve, an eject, a poll's relocation — so this is the one
  // door that puts them back (the v8.3.9 "one rule, every door" shape).
  // openTask decides afresh for the challenge page itself, after its render.
  if(id!=='task-detail-page')releaseTapChrome();
  _syncEventLook(id);
  clearCompTimers();clearTsPickerTimers(); // clean up picker timers when leaving
  // If we're leaving an open challenge detail for a different page, fire a
  // navigated_away challenge_event. openTask() pre-clears _openedTaskId on
  // task→task transitions, so its showMain('task-detail-page') is a no-op here.
  if(id!=='task-detail-page'&&typeof S._openedTaskId!=='undefined'&&S._openedTaskId)fireNavigatedAway('spa_nav');
  document.getElementById('main-nav').style.display='';
  document.getElementById('user-info').style.display='flex';
  document.getElementById('app-header')?.classList.add('is-app');
  document.getElementById('app-header')?.classList.toggle('is-admin-shell',id==='admin-page');
  document.querySelectorAll('.page').forEach(p=>{p.style.display='none';p.classList.remove('active');});
  // v6.9.13: don't force inline display:block — the CSS rule
  // `.page.active{display:flex;flex-direction:column;flex:1}` is the
  // source of truth for page layout. Before this, every page went
  // display:block via JS, overriding the flex rule and causing the
  // footer to float mid-page when content was shorter than the
  // viewport. Now the inline style is cleared and CSS wins.
  document.getElementById(id).style.display='';
  document.getElementById(id).classList.add('active');
  // Fallback for CSS :has(#admin-page.active) — browsers without :has()
  // (Firefox <121, Safari <15.4) need a class on <main> to trigger the
  // full-width admin layout. The :has() rule stays as progressive
  // enhancement for modern browsers.
  const mainEl=document.querySelector('main');
  if(mainEl)mainEl.classList.toggle('admin-active',id==='admin-page');
  // audit v7.7.33 (AL2) — mirror the visual active tab to aria-current="page"
  // (the admin sidebar already does this in adminTab; the participant nav never
  // did), so assistive tech knows which section is active.
  document.querySelectorAll('.nav-btn').forEach(b=>{
    const on=b.dataset.page===id;
    b.classList.toggle('active',on);
    if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');
  });
  if(id==='tasks-page')loadTasks();
  if(id==='leaderboard-page')loadLeaderboard();
  if(id==='competitions-page')loadMyCompetitions();
  // v6.20.x — only load the default-visible Competitions pane + Participants
  // (the latter populates the pending-approval badge). The other panes
  // (Tasks, Submissions, Rankings→leaderboard N+1, Settings) lazy-load on tab
  // click via adminTab(), so eager-loading all six on every admin open was
  // ~4 wasted fetches incl. a per-live-comp leaderboard fan-out.
  // RBAC — the panel opens on Events only for a role that may read events; any
  // other opens on its first page (openAdminLanding). Each loader also asks its
  // own permission, so a refused read is never sent (a refused read toasts and
  // feeds the address's scanner count).
  if(id==='admin-page')openAdminLanding();
  // AFTER the loaders: they are not awaited, but any heading that is part of the
  // page's static markup is already in the DOM, and the fall back to the page
  // container covers a heading a loader has yet to paint.
  _focusRoute(id);
}

/**
 * v8.6.5 — show the platform name beside the logo, or hide it; never a clipped
 * half of it.
 *
 * The CSS keeps it to one line, which is what stops the header growing (see
 * `header h1 .platform-name` in styles.css). What CSS cannot express is
 * "hide it if it does not fit", so this decides that — and it is only ever a
 * decision about TEXT: the h1 is `flex:1`, so its width comes from the flex
 * container rather than its content, and toggling this changes no geometry.
 * Hiding it therefore shifts nothing, which is why it is safe to do after
 * layout rather than having to be inlined into every writer.
 *
 * ONE ResizeObserver ON THE H1, NOT A CALL AT EVERY HEADER WRITER. The h1's
 * width changes whenever anything in the header does — the nav populating, the
 * countdown appearing, `#user-info` filling, the window resizing — so observing
 * it covers all of them, including the ones nobody has written yet. Enumerating
 * the writers instead is the "a rule implemented at one door of several" defect
 * this codebase keeps paying for.
 *
 * AND ONE MutationObserver ON THE NAME'S TEXT, which is a genuinely different
 * input rather than a second copy of the same one. `applyPlatformName`
 * (settings-admin.js) rewrites this span's textContent when an operator renames
 * the platform — that changes what has to fit while changing NO box the
 * ResizeObserver can see, so without this a rename leaves a stale verdict: a
 * shorter name stays hidden when it would now fit, and a longer one stays shown
 * and is then CLIPPED by `overflow:hidden`, which is the one thing this rule
 * promises never to do. Watching the text rather than calling out of
 * `applyPlatformName` avoids an import cycle (nav.js already imports
 * settings-admin.js) and covers any future writer of that text.
 *
 * It watches `childList`/`characterData` and NOT `attributes`, deliberately:
 * `fit()` sets `hidden`, so observing attributes is an infinite loop.
 *
 * No observer loop otherwise either: the h1's size does not depend on this
 * child, so toggling it cannot re-fire the callback that toggled it.
 */
let _nameFitObserver=null;
export function initPlatformNameFit(){
  const h1=document.querySelector('header h1');
  const el=h1&&h1.querySelector('.platform-name');
  if(!h1||!el||_nameFitObserver)return;
  const fit=()=>{
    // Measure in the SHOWN state: hidden, both widths read 0 and "it fits" would
    // be trivially true, which is a loop rather than an answer.
    el.hidden=false;
    el.hidden=el.scrollWidth>el.clientWidth+1;
  };
  fit();
  if(typeof ResizeObserver==='function'){
    _nameFitObserver=new ResizeObserver(fit);
    _nameFitObserver.observe(h1);
  }
  if(typeof MutationObserver==='function'){
    new MutationObserver(fit).observe(el,{childList:true,characterData:true,subtree:true});
  }
}

// ── THE ACCOUNT BUTTON AND MENU ─────────────────────────────────────────────
//
// The signed-in header holds two controls at its far right: Search (the command
// palette, features/command-palette.js) and ONE round account button (initials
// or picture). Everything else that used to sit loose in the header — the role
// pill, Participant/Admin View, Logout, the look and theme icons, the
// release-notes sparkle, the version — lives in its menu, a compact popover
// under the button on a wide screen and a bottom sheet on a phone.
//
// THE MENU IS A SHORT LIST, NOT A SETTINGS PAGE. Appearance is ONE row that
// opens the Appearance page (features/appearance.js, its `open-appearance`
// action); the row names the current look and mode, so the state shows without
// the controls.
//
// ITEMS BY CAPABILITY, each from the same predicate the old control used:
//   • the view switch — an admin tier, user-backed (S.currentUser.id: the
//     built-in superadmin has no participant view); the label names the view a
//     press goes TO, and the control keeps `data-action="toggle-admin-view"`
//     with `data-on` exactly as the old header buttons did;
//   • Appearance — everyone;
//   • Profile — a user-backed account (the profile editor needs a row);
//   • Account — the built-in superadmin only, once boot() has registered its
//     `open-builtin-account` action (Settings' Break-glass card);
//   • Help — everyone (the role's guide; the palette searches it too);
//   • What's new — releaseNotesVisible(), the old sparkle's predicate;
//   • Sign out — always, last.
// Every item is a delegated data-action. The menu closes itself SYNCHRONOUSLY
// in its own click listener, before the document dispatcher runs the item, so
// focus is already back on the account button when the item opens a dialog —
// which then captures a live opener and returns focus to it.
const PMENU_ID='profile-menu-overlay';

function _initials(u){
  if(!(u&&u.id)&&S.isSuperAdmin)return 'SA';
  const parts=[u&&u.first_name,u&&u.last_name].filter(Boolean);
  const src=parts.length?parts:String((u&&(u.nickname||u.email))||'').split(/[\s._@-]+/).filter(Boolean);
  const s=src.slice(0,2).map(w=>String(w).trim().charAt(0)).join('').toUpperCase();
  return s||'?';
}
// The account's role as the server describes it (`role_info` on the sign-in
// answer, GET /api/me and GET /api/admin/me), but only while it describes the
// role this tab holds: a stale block never names somebody else's role.
function _roleInfo(){
  const ri=S.roleInfo;
  return ri&&typeof ri==='object'&&ri.id&&ri.id===S.userRole?ri:null;
}
function _roleLabel(){
  if(S.isSuperAdmin||S.userRole==='superadmin')return 'Superadmin';
  // A CUSTOM role is named by its own label ("Support desk"), never by the
  // built-in tier its scope resembles.
  const ri=_roleInfo();
  if(ri&&ri.builtin===false&&ri.label)return ri.label;
  if(S.isEventAdmin||S.userRole==='event_admin')return 'Event Admin';
  if(S.isAdmin||S.userRole==='admin')return 'Admin';
  return 'Participant';
}
/**
 * Does the ACCOUNT hold an admin-class role, whatever view it is in? The three
 * built-in admin roles by name, and a custom role by the scope mode the server
 * sends (`granted` or `all`). Enumerated POSITIVELY (v8.7.3): an unknown role,
 * or one the server has not described, inherits no admin door.
 */
export function accountIsAdminRole(){
  if(S.userRole==='admin'||S.userRole==='superadmin'||S.userRole==='event_admin')return true;
  const ri=_roleInfo();
  return !!(ri&&(ri.scope_mode==='granted'||ri.scope_mode==='all'));
}
export function _isAdminTier(){return accountIsAdminRole()||!!S.isAdmin;}
function _displayName(){
  const u=S.currentUser||{};
  if(!u.id&&S.isSuperAdmin)return 'Superadmin';
  const full=[u.first_name,u.last_name].filter(Boolean).join(' ');
  return full||u.nickname||u.email||'Signed in';
}
// The avatar's face: an uploaded picture, an emoji avatar, or initials. Initials
// are painted from data-glyph (CSS), never DOM text, so the button's accessible
// name is not the letters; the picture and the emoji are decorative.
function _avatarFace(){
  const u=S.currentUser||{};
  const a=u.avatar;
  if(a&&(a.startsWith('/api/images/')||a.startsWith('data:image/')))return `<img class="acct-img" src="${esc(a)}" alt="">`;
  if(a&&a!=='default1'&&a.length<=8)return `<span class="acct-emoji" aria-hidden="true">${esc(a)}</span>`;
  return `<span class="acct-initials" data-glyph="${esc(_initials(u))}" aria-hidden="true"></span>`;
}
export function accountButtonHtml(){
  // Named by its own (visually hidden) text: the face is decorative, so the name
  // is the only words the button carries.
  return `<button type="button" id="profile-menu-btn" class="acct-btn" data-action="open-profile-menu" aria-haspopup="dialog" aria-expanded="false" data-role="${esc(_roleLabel())}">${_avatarFace()}<span class="sr-only">Account menu for ${esc(_displayName())}</span></button>`;
}

// One row: a decorative icon, the label, an optional quiet detail and an
// optional chevron for a row that opens a further page. The accessible name
// opens with the label (WCAG 2.5.3). `tip` puts a "?" help tip
// (ui/help-tips.js) BESIDE the row, never inside the button.
// `icon` (an ICO.* constant) and `extra` (attribute markup) are HTML by contract:
// every caller passes a literal, which tests/html-sink-scan.js checks.
function _menuItem(action,label,{icon='',detail='',chevron=false,cls='',extra='',tip='',tipLabel=''}={}){
  const ico=icon?`<span class="pm-ico" aria-hidden="true">${icon}</span>`:'';
  const det=detail?` <span class="pm-detail">${esc(detail)}</span>`:'';
  const chev=chevron?`<span class="pm-chev" aria-hidden="true">${ICO.chevronRight}</span>`:'';
  const btn=`<button type="button" class="pm-item${cls?' '+esc(cls):''}" data-action="${esc(action)}"${extra}>${ico}<span class="pm-label">${esc(label)}${det}</span>${chev}</button>`;
  return tip?`<div class="pm-row">${btn}<span data-help="${esc(tip)}" data-help-label="${esc(tipLabel||label)}"></span></div>`:btn;
}
// The built-in superadmin's Account item opens Settings' Break-glass card, so it
// appears only once boot() has registered that door with the dispatcher.
function _actionRegistered(name){ return typeof _actionHandlers[name]==='function'; }
/** The view switch's predicate, shared with the command palette. */
export function viewSwitchOffered(){ return !!(_isAdminTier()&&S.currentUser&&S.currentUser.id); }
/** The built-in superadmin's Account door, shared with the command palette. */
export function builtinAccountOffered(){ return !(S.currentUser&&S.currentUser.id)&&!!S.isSuperAdmin&&_actionRegistered('open-builtin-account'); }
function _viewItem(){
  if(!viewSwitchOffered())return '';
  return S.isAdmin
    ?_menuItem('toggle-admin-view','Switch to Participant View',{icon:ICO.swap,extra:' data-on="false"',tip:'menu.view',tipLabel:'Switching views'})
    :_menuItem('toggle-admin-view','Switch to Admin View',{icon:ICO.swap,extra:' data-on="true"',tip:'menu.view',tipLabel:'Switching views'});
}
// "Ambient · Light": what this browser's Appearance is set to.
function _appearanceDetail(){
  const look=(LOOKS.find(l=>l.id===_lookPreference())||{}).label||'';
  const mode={system:'Auto',light:'Light',dark:'Dark'}[_themePreference()]||'';
  // A look the platform or the event has locked is the organisers' choice.
  return _lookLockReason()?[look,'set by organisers'].filter(Boolean).join(' · '):[look,mode].filter(Boolean).join(' · ');
}
function _accountItems(){
  const userBacked=!!(S.currentUser&&S.currentUser.id);
  // The built-in (break-glass) account has no profile; its "Account" item opens
  // Settings' Break-glass card, where its username is set (main.js wires
  // `open-builtin-account`).
  return _menuItem('open-appearance','Appearance',{icon:ICO.palette,detail:_appearanceDetail(),chevron:true,extra:' aria-haspopup="dialog"',tip:'menu.appearance'})
    +(userBacked?_menuItem('open-profile-editor','Profile',{icon:ICO.user}):'')
    +(builtinAccountOffered()?_menuItem('open-builtin-account','Account',{icon:ICO.key}):'');
}
function _helpItems(){
  return _menuItem('help-open','Help',{icon:ICO.helpCircle,tip:'menu.help'})
    +(releaseNotesVisible()?_menuItem('release-notes-open',"What's new",{icon:ICO.sparkles}):'');
}
function _profileMenuBody(){
  const u=S.currentUser||{};
  const ver=(document.getElementById('platform-version')?.textContent||'').trim();
  return `<div class="pm-panel" role="dialog" aria-modal="true" aria-labelledby="pm-name">
    <div class="pm-head">
      <span class="pm-avatar" aria-hidden="true">${_avatarFace()}</span>
      <div class="pm-who"><p id="pm-name" class="pm-name">${esc(_displayName())}</p>${u.email?`<p class="pm-email">${esc(u.email)}</p>`:''}<span class="pm-role">${esc(_roleLabel())}</span></div>
    </div>
    <div class="pm-group">${_viewItem()}</div>
    <div class="pm-group">${_accountItems()}</div>
    <div class="pm-group">${_helpItems()}</div>
    <div class="pm-group pm-foot">${ver?`<p class="pm-ver">${esc(ver)}</p>`:''}${_menuItem('do-logout','Sign out',{icon:ICO.logOut,cls:'pm-out'})}</div>
  </div>`;
}

export function closeProfileMenu(){
  const o=document.getElementById(PMENU_ID);
  if(o)o.remove();
  document.getElementById('profile-menu-btn')?.setAttribute('aria-expanded','false');
}
export function openProfileMenu(){
  if(document.getElementById(PMENU_ID)){closeProfileMenu();return;}
  const overlay=document.createElement('div');
  overlay.id=PMENU_ID;
  overlay.className='pm-overlay';
  document.body.appendChild(overlay);
  // Before focus moves in, so the opener is captured and focus returns to it.
  overlayDismiss(overlay,()=>closeProfileMenu());
  setSafeHtml(overlay,_profileMenuBody());
  document.getElementById('profile-menu-btn')?.setAttribute('aria-expanded','true');
  overlay.addEventListener('click',e=>{
    // A menu, not a dialog: a press on the scrim closes it, as the row kebabs do.
    // A named exception to the dialogs' "a backdrop click never closes" (ui/modal.js
    // overlayDismiss), with the command palette: an outside press loses nothing
    // here (operator ruling, 14 Nov 2026).
    if(e.target===overlay){closeProfileMenu();return;}
    // An item: close NOW, so the document dispatcher (which runs the item after
    // this listener) finds focus back on the account button.
    const it=e.target.closest&&e.target.closest('.pm-item');
    if(it)closeProfileMenu();
  });
  (overlay.querySelector('.pm-item')||overlay.querySelector('button'))?.focus();
}

/** After the signed-in account's own row changed (its profile was saved),
 *  repaint the header for the view on screen. The participant bar belongs to
 *  participant view alone; in Admin View only the account button is repainted. */
export function refreshAccountHeader(){
  if(S.isAdmin){setSafeHtml(document.getElementById('user-info'), accountButtonHtml());return;}
  buildParticipantNav();updateParticipantNav();
}

export function buildParticipantNav(){
  // Staff in participant view keep their own look under a platform lock; the
  // admin roles are named positively (a custom role by its scope mode), so an
  // unknown role inherits nothing.
  setStaffBrowser(accountIsAdminRole());
  // ONE bar, the same three items on every device (the app-chrome CSS pins it under
  // the header). Challenges and Leaderboard are never hidden: before an event is
  // entered they are INACTIVE (aria-disabled, a dashed edge and the visible note
  // beside the bar), set by updateParticipantNav.
  const _ni=d=>`<svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  setSafeHtml(document.getElementById('main-nav'), `
    <button class="nav-btn" id="nav-competitions" data-page="competitions-page" data-action="nav-competitions">${_ni('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>')}<span class="nav-label">Events</span></button>
    <button class="nav-btn nav-btn-locked" id="nav-challenges" data-page="tasks-page" data-action="nav-locked" aria-disabled="true" aria-describedby="nav-lock-note">${_ni('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>')}<span class="nav-label">Challenges</span></button>
    <button class="nav-btn nav-btn-locked" id="nav-leaderboard" data-page="leaderboard-page" data-action="nav-locked" aria-disabled="true" aria-describedby="nav-lock-note">${_ni('<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 4h3a2 2 0 0 1 0 4h-3"/><path d="M7 4H4a2 2 0 0 0 0 4h3"/>')}<span class="nav-label">Leaderboard</span></button>
    <span id="nav-lock-note" class="nav-lock-note">Choose an event first</span>`);
  setAppShellHint('note');   // the bar as built shows its lock note (updateParticipantNav decides it next)
  // v7.2.0 — the verification grace: a still-unverified participant gets a clickable
  // amber chip with a live "verify by" countdown next to their nickname.
  const verifyChip=(S.currentUser&&S.currentUser.verified===false)
    ?`<span id="verify-indicator" class="verify-chip" data-action="open-verify-dialog" role="button" tabindex="0" aria-label="${_verifyChipName('')}" title="Email not verified — click for details">${ICO.alertTriangle}<span class="verify-chip-label">Verify email</span> <span class="verify-countdown" id="verify-countdown"></span></span>`
    :'';
  // The view switch, Sign out and Appearance live in the account menu; an event
  // admin in participant view still reaches Admin View there (the v8.7.3
  // one-way-door rule: the switch is offered by tier, enumerated positively).
  setSafeHtml(document.getElementById('user-info'), `
    ${verifyChip}
    <span class="score-pill" id="header-score" style="display:none">0 pts</span>
    ${accountButtonHtml()}`);
  renderVerifyIndicator();
  startVerifyIndicatorTicker();
  // v8.5.0 — clears the release-notes button on the way DOWN to participant view.
  // The predicate reads S.isAdmin, which toggleAdminView has already set false by
  // the time this runs, so the same call serves both directions.
  renderReleaseNotesButton();
  // A "?" tip worded per role was wired at boot, before the role was known: the
  // two builders run on every role and view change, so the words follow them.
  refreshRoleTips();
  // v7.23.3 — the participant builder changes the header too (score pill,
  // verify chip, nav buttons appearing); it was the one builder missing this.
  publishHeaderHeight();
}

// ── Unverified-email indicator (v7.2.0) ─────────────────────────────────────
// An unverified account (one from before email first, or one an import marks
// unverified) signed in with a code shown at the desk may sign in for a 48h grace
// window (server-stamped self_enroll_grace_until, surfaced as
// currentUser.verification_grace_until). While unverified we show a clickable
// amber chip with a live countdown; clicking it offers "Resend verification
// email". The chip + ticker clear the instant the account verifies (detected by
// a periodic /api/me refresh, an admin force-verify, or a verify-link click in
// another tab) or on logout / switch to admin view.
function _verifyRemainingMs(){
  const until=S.currentUser&&S.currentUser.verification_grace_until;
  if(!until)return null;
  const t=new Date(until).getTime();
  if(!Number.isFinite(t))return null;
  return t-Date.now();
}
function _fmtVerifyRemaining(ms){
  if(ms==null)return '';
  if(ms<=0)return 'verification required';
  const totalMin=Math.floor(ms/60000);
  const h=Math.floor(totalMin/60),m=totalMin%60;
  if(h>0)return `${h}h ${m}m left`;
  if(totalMin>0)return `${totalMin}m left`;
  return '<1m left';
}
// The verify chip's accessible name: its visible words first ("Verify email",
// then the countdown when there is one), then what a press does. One definition
// for the first paint and every tick, so the two cannot disagree.
function _verifyChipName(left){
  return `Verify email${left?`, ${left}`:''} — open verification help`;
}
export function renderVerifyIndicator(){
  const chip=document.getElementById('verify-indicator');
  if(!chip)return;
  const cd=document.getElementById('verify-countdown');
  const ms=_verifyRemainingMs();
  const left=_fmtVerifyRemaining(ms);
  if(cd)cd.textContent=left;
  // The countdown is VISIBLE text inside the chip, so the chip's name carries it
  // too, in the order it is shown (WCAG 2.5.3) — and moves with every tick.
  chip.setAttribute('aria-label',_verifyChipName(left));
  // Past the deadline the next protected request bounces them to login; flag
  // the chip urgent until then.
  chip.classList.toggle('expired',ms!=null&&ms<=0);
}
export function startVerifyIndicatorTicker(){
  stopVerifyIndicatorTicker();
  if(S._pollsHalted||!(S.currentUser&&S.currentUser.verified===false))return;
  let ticks=0;
  S._verifyTicker=setInterval(async()=>{
    renderVerifyIndicator();
    ticks++;
    // Every ~2 min refresh /api/me so verification completed elsewhere (the
    // emailed link in another tab, or an admin force-verify) clears the chip
    // without a manual reload.
    if(ticks%4===0){
      try{
        const me=await fetch('/api/me').then(r=>r.ok?r.json():null).catch(()=>null);
        if(me){
          const wasUnverified=S.currentUser&&S.currentUser.verified===false;
          S.currentUser=me;
          S.isUserStaff=!!me.isStaff;S.userRole=me.userRole||'participant'; // v7.2.x (audit) — keep derived flags in sync with the wholesale S.currentUser swap (mirror doLogin)
          S.roleInfo=me.role_info||null;
          if(me.verified&&wasUnverified){
            buildParticipantNav();updateParticipantNav(); // rebuild drops the chip + (won't) restart the ticker
            showToast('Email verified — thank you!','success');
          }
        }
      }catch(_){/* best-effort */}
    }
  },30000);
}
export function stopVerifyIndicatorTicker(){
  if(S._verifyTicker){clearInterval(S._verifyTicker);S._verifyTicker=null;}
}
export async function openVerifyDialog(){
  const ms=_verifyRemainingMs();
  const expired=ms!=null&&ms<=0;
  const left=_fmtVerifyRemaining(ms).replace(' left','');
  const email=esc((S.currentUser&&S.currentUser.email)||'your email');
  const body=expired
    ? `<p>Your sign-in grace period has ended. To keep using your account you now need to <strong>verify your email</strong>.</p>`
      +`<p>Open the verification link we sent to <strong>${email}</strong>, resend it below, or sign out and sign in with a code emailed to that address — an emailed code verifies it too.</p>`
    : `<p>Your email isn’t verified yet. You can keep going for now, but you have <strong>${esc(left)}</strong> to verify — after that you’ll be asked to verify before your next sign-in.</p>`
      +`<p>Open the verification link we sent to <strong>${email}</strong>, or resend it below.</p>`;
  const ok=await showModal({title:'Verify your email',message:body,confirmText:'Resend verification email',confirmClass:'',cancelText:'Close'});
  if(!ok)return;
  try{
    const r=await fetch('/api/resend-verification',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'})});
    const d=await r.json().catch(()=>({}));
    if(r.ok&&d.emailDeferred)showToast('The verification email is still being sent — check your inbox in a minute.','warning');
    else if(r.ok&&d.emailDelivered!==false)showToast('Verification email sent — check your inbox.','success');
    else if(r.ok)showToast('Request received, but the email could not be sent right now. Please try again later.','error');
    else showToast(d.error||'Could not resend verification email.','error');
  }catch(_){showToast('Could not resend verification email.','error');}
}

// v7.23.3 (audit Wave 4 #17) — publish where the header's BOTTOM EDGE sits, as
// --header-bottom.
//
// Two fixed/sticky controls were anchored to hard-coded guesses at the header
// height — #admin-mobile-menu-btn at top:70px and .back-btn at top:72px. The
// header is `flex-wrap:wrap` by design (v7.2.x), and on a phone it measures
// 105-138px, so both guesses were short by 30-70px: the hamburger sat ON TOP of
// the header's own controls (measured covering Logout, which is then
// unclickable) and "Back to Challenges" stuck underneath the header.
//
// THE VALUE IS THE BOTTOM EDGE, NOT THE HEIGHT, and the difference is not
// pedantic. The header is `position:sticky;top:0` — but under impersonation
// `body.impersonating header{top:var(--imp-bar-h)}` (54px since v8.12.1; 52px
// when this was written) sticks it that much lower to clear the fixed banner.
// Publishing the HEIGHT (the first cut) left both controls a bar's height too
// high in that state, which put .back-btn completely behind the header: the
// exact defect #17 exists to fix, reintroduced in the one state I had not
// considered. `sticky top + height` is scroll-independent and picks up any
// future displacement for free.
let _lastHeaderBottom = null;
export function publishHeaderHeight(){
  const h = document.getElementById('app-header');
  if (!h) return;
  const rect = h.getBoundingClientRect();
  // Not `rect.bottom`: that is scroll-dependent until the header actually
  // sticks. The resting position is its own sticky offset plus its height.
  const stickyTop = parseFloat(getComputedStyle(h).top) || 0;
  const px = Math.round(stickyTop + rect.height);
  // 0 while the header has no box yet; keeping the previous value beats
  // publishing a 0 that would tuck both controls under the top edge.
  if (!px || px === _lastHeaderBottom) return;
  _lastHeaderBottom = px;
  document.documentElement.style.setProperty('--header-bottom', px + 'px');
  // A strip stuck under the header hangs from this edge, so its own moves too.
  publishStripBottoms();
}

// THE STRIP A PAGE KEEPS STUCK UNDER THE HEADER (`data-sticky-strip` in the
// markup: the event workspace's record header on every section but the
// Overview, the challenge view's play bar). A heading the route focus scrolls
// into view must land below the strip as well as the header, or it and the
// controls under it park behind the strip, so the route-focus scroll margins
// (styles.css) read `--strip-bottom`: the strip's bottom edge while it sticks,
// published on its page, and unset otherwise (the margin then falls back to
// --header-bottom). Published right before every route focus, which reads it in
// the same task (a ResizeObserver answers only after layout, too late for the
// first section after the Overview, or a challenge opened from the list), and
// kept current by an observer of each strip's border box and by every new
// --header-bottom.
export function publishStripBottoms(){
  for (const strip of document.querySelectorAll('[data-sticky-strip]')) {
    const page = strip.closest('.page');
    if (!page) continue;
    const cs = strip.getClientRects().length > 0 ? getComputedStyle(strip) : null;
    const v = cs && cs.position === 'sticky'
      ? `${Math.ceil((parseFloat(cs.top) || 0) + strip.getBoundingClientRect().height)}px` : '';
    if (page.style.getPropertyValue('--strip-bottom') === v) continue;
    if (v) page.style.setProperty('--strip-bottom', v);
    else page.style.removeProperty('--strip-bottom');
  }
}
let _stripRO = null;
export function watchStickyStrips(){
  if (_stripRO || typeof ResizeObserver === 'undefined') return;
  _stripRO = new ResizeObserver(() => publishStripBottoms());
  document.querySelectorAll('[data-sticky-strip]').forEach(s => _stripRO.observe(s, { box: 'border-box' }));
}

// The header's height changes for more reasons than there are call sites, which
// is the enumeration trap this codebase keeps rediscovering: the verify-email
// chip appearing, the score pill appearing, the live-timer row being revealed,
// a competition-ended banner being written into it, a long platform name
// wrapping, and the self-hosted Inter finishing loading (font-display:swap, so
// the header reflows AFTER first paint). Rather than name them, observe the box.
//
// The BORDER box, which is what the published bottom edge is made of, not the
// CONTENT box a ResizeObserver watches by default: the signed-in header
// (`#app-header.is-app`, set by showMain) trims only its padding (69 -> 61 px
// at desktop widths) and leaves its content box as it was, so a content-box
// observer never republishes, and every reader of --header-bottom (the
// workspace strip's sticky top, the scroll margins, the drawer, the account
// menu) sits that much below the header.
let _headerRO = null;
export function watchHeaderHeight(){
  const h = document.getElementById('app-header');
  if (!h || _headerRO || typeof ResizeObserver === 'undefined') return;
  _headerRO = new ResizeObserver(() => publishHeaderHeight());
  _headerRO.observe(h, { box: 'border-box' });
}

function _setNavLocked(btn,locked){
  if(!btn)return;
  btn.classList.toggle('nav-btn-locked',locked);
  btn.dataset.action=locked?'nav-locked':'show-main';
  if(locked){btn.setAttribute('aria-disabled','true');btn.setAttribute('aria-describedby','nav-lock-note');}
  else{btn.removeAttribute('aria-disabled');btn.removeAttribute('aria-describedby');}
}
/** A press on an inactive event tab: say why, move nowhere. */
export function navLockedPressed(){
  const note=document.getElementById('nav-lock-note');
  showToast((note&&note.textContent)||'Choose an event first','info');
}

export function updateParticipantNav(){
  const el=id=>document.getElementById(id);
  // Only show challenges/leaderboard/score for live or ended competitions, not upcoming
  const status=S.currentCompStatus||(S.currentCompetitionId?(() => {const c=S.myCompetitions.find(c=>c.id===S.currentCompetitionId);return c?computeCompStatus(c):null;})():null);
  const showCompTabs=status==='live'||status==='ended';
  // v8.1.0 (PR 14) — the nav SPLIT, structural only: three controls were gated by
  // one boolean, and they answer two different questions.
  //
  //   showChallenges  — "has this event started?"        (a STATUS question)
  //   showRanking     — "does this event have a score?"  (a KIND question)
  //
  // Both read the same value today, so nothing moves: every existing event is a
  // Competition and every Competition is ranked. Phase 4 changes one line — the
  // right-hand side of showRanking becomes `showCompTabs && policy.ranking_enabled`
  // — and for a Program the Leaderboard button goes inactive and the header score
  // pill hides with it, while the Challenges button stays. Splitting it here, in
  // a PR with no behavioural change, is what keeps that a one-line diff instead of a
  // three-control hunt through a function that also owns the muting rule below.
  const showChallenges=showCompTabs;
  // v8.1.0 (PR 18) — the split now DOES something. A Program has no rank or
  // placing (its points still accrue and show on each challenge), so the
  // Leaderboard button goes inactive ("This event has no leaderboard") and the
  // header score pill hides with it, while Challenges stays active.
  // Read through policyOrDefault, so a payload that predates the policy behaves
  // exactly as it did before v8.1.0 rather than silently making the Leaderboard
  // button inactive and hiding the score pill.
  const showRanking=showCompTabs&&policyOrDefault(S.currentCompPolicy).ranking_enabled;
  // The bar keeps its three items for good; what changes is whether the two
  // event tabs are ACTIVE. An inactive tab is aria-disabled (a click does
  // nothing but say why), drawn with a dashed edge, never dimmed, and the note
  // beside the bar names the reason.
  const reason=!S.currentCompetitionId?'Choose an event first'
    :!showCompTabs?'Opens when the event starts'
    :!showRanking?'This event has no leaderboard':'';
  _setNavLocked(el('nav-challenges'),!showChallenges);
  _setNavLocked(el('nav-leaderboard'),!showRanking);
  const note=el('nav-lock-note');
  if(note){note.textContent=reason;note.hidden=!reason;}
  // The next load reserves the bar as it is now: with the note's own line on a
  // phone, or without it (ha_shell=3 / 1; see dropAppShellHint).
  if(el('nav-competitions'))setAppShellHint(reason?'note':'bar');
  if(el('header-score'))el('header-score').style.display=showRanking?'':'none';
  // v7.23.1 (audit Wave 3) — de-emphasise the Competitions button with a CLASS,
  // never `style.opacity`.
  //
  // This was `style.opacity = '0.5'`, applied whenever the participant is inside
  // a competition — i.e. for the whole event — and it measured 2.03:1 in light /
  // 2.21:1 in dark against 4.85:1 un-dimmed. It was the single largest contrast
  // group in the v7.23.0 audit sweep (66 axe instances) and CI could never see
  // it: #main-nav lives in <header>, outside every participant include() scope.
  //
  // A class also keeps the rule themeable, which an inline literal is not.
  if(el('nav-competitions'))el('nav-competitions').classList.toggle('nav-btn-muted',!!S.currentCompetitionId);
  // v7.23.3 — the header's height changes with its contents.
  publishHeaderHeight();
}

export const _ADMIN_NAV_ICONS={
  'admin-competitions-tab':ICO.calendar,
  'admin-templates-tab':ICO.layers,
  'admin-tasks-tab':ICO.code,
  'admin-participants-tab':ICO.users,
  'admin-groups-tab':ICO.grid,
  'admin-submissions-tab':ICO.activity,
  'admin-audit-tab':ICO.clipboardCheck,
  'admin-rankings-tab':ICO.trophy,
  'admin-analytics-tab':ICO.barChart,
  'admin-logs-tab':ICO.fileText,
  'admin-settings-tab':ICO.settings,
  'admin-users-tab':ICO.users,
};

// RBAC — the permission each sidebar item needs to be worth opening (the
// permission its pane's first read asks for). Mirrors lib/rbac.js
// ADMIN_ROUTE_PERMISSIONS for those reads; an item whose permission the session
// lacks is hidden (its <li>, both ways, as the Settings/Logs rules above).
// `S.permissions` comes from the sign-in answer and GET /api/admin/me; until it
// is known only the Users & roles item is decided, from the built-in tiers
// (every global admin may see it, an event admin may not).
export const ADMIN_NAV_PERMISSIONS={
  'admin-competitions-tab':'events.view','admin-tasks-tab':'challenges.view',
  // New event opens for EITHER of its uses: its templates (GET
  // /api/admin/event-templates, templates.view) or its blank starters, which read
  // nothing and open the create form (events.create, the route Events' + New
  // Event also leads here by). Each part of the page asks its own permission
  // (features/templates-admin.js), so a role holding one sees only that part.
  'admin-templates-tab':['templates.view','events.create'],
  'admin-participants-tab':'participants.view','admin-groups-tab':'groups.view','admin-rankings-tab':'leaderboard.view',
  'admin-submissions-tab':'audit.view','admin-analytics-tab':'analytics.view','admin-logs-tab':'audit.raw_logs',
  // Settings opens for ANY of its cards' first reads (operator ruling,
  // 14 Nov 2026): GET /api/admin/settings (settings.view), the platform
  // certificate design (certificates.design), the alerts (ops.alerts), retention
  // (ops.retention_view), the unsubscribed list (ops.email) and the Checkmarx One
  // removals (ops.cxone). Each card inside shows only to a role holding what its
  // own routes check (SETTINGS_CARD_PERMISSIONS below), so a regular admin sees
  // the certificate designer, the read-only team-domains list, Retention and
  // Alerts.
  'admin-settings-tab':['settings.view','certificates.design','ops.alerts','ops.retention_view','ops.email','ops.cxone'],'admin-users-tab':'users.view','admin-audit-tab':'audit.view',
};
// THE SETTINGS CARDS: each shows to a role holding EVERY permission its routes
// check (operator ruling, 14 Nov 2026) — a card that edits a value also reads
// it, so it needs the read's permission too. The certificate design
// (certificateDesignOffered), the team-report domains (features/event-team.js)
// and the break-glass account (its own session) gate themselves.
export const SETTINGS_CARD_PERMISSIONS={
  'platform-name-card':['settings.view','settings.edit'],    // GET + PATCH /api/admin/settings
  'account-approval-card':['settings.view','settings.edit'], // GET + PATCH /api/admin/settings
  'platform-look-card':['settings.view','settings.edit'],    // GET /api/admin/settings, PUT /api/admin/platform-look
  'smtp-settings-card':['settings.view'],                    // GET /api/admin/smtp-settings (the form: ops.smtp, superadmin only)
  'email-test-card':['ops.email'],                           // POST /api/admin/test-email
  'unsubscribe-card':['ops.email'],                          // GET, DELETE /api/admin/unsubscribed
  'cxone-card':['settings.view','ops.cxone'],                // GET /api/admin/settings, PUT/DELETE /api/admin/default-cxone
  'cxone-withdrawals-card':['ops.cxone'],                    // /api/admin/cxone/withdrawals
  'retention-card':['ops.retention_view'],                   // GET /api/admin/retention
  'alerts-card':['ops.alerts'],                              // GET /api/admin/alerts
  'system-health-card':['settings.view'],                    // GET /api/admin/system-health
  'cxone-audit-card':['audit.view'],                         // GET /api/admin/audit (the page it opens)
};
// Is this Settings card offered to the signed-in role? Fails closed until
// /api/admin/me has said what the role holds (a superadmin holds every card),
// and an organiser's impersonated seat gets none.
export function settingsCardOffered(id){
  const need=SETTINGS_CARD_PERMISSIONS[id];
  if(!need)return false;
  // As adminCan: a card's routes answer only an admin-shaped session, so in
  // participant view (the Appearance page's Organisation default) it is no.
  if(!S.isAdmin)return false;
  if(S.impersonation&&S.impersonation.view==='admin')return false;
  if(Array.isArray(S.permissions))return need.every(p=>S.permissions.includes(p));
  return !!S.isSuperAdmin;
}
// Sweep #501 (operator ruling, 23 Nov 2026): while "Require account approval" is
// on, a role that may add people but not approve accounts cannot sign anyone up
// at the desk (a desk code never approves, so the account could not sign in).
// The server refuses it with the same words (routes/participants.js
// DESK_APPROVAL_REQUIRED); the doors withhold it with them.
export const DESK_APPROVAL_REASON='New accounts wait for approval on this platform, and your role cannot approve them, so an account made at the desk could not sign in. Use Invite instead (they then wait for approval), or ask an administrator.';
export function deskApprovalWithheld(){ return !!S.requireAccountApproval&&adminCan('participants.enrol')&&!adminCan('participants.approve'); }

export function adminCan(perm){
  // A permission is used only from an ADMIN-shaped session (requirePermission
  // and requireAdmin refuse any other), so in participant view the answer is no
  // whatever the role holds.
  if(!S.isAdmin)return false;
  // A list (a page that opens for either of its uses) is any one of them.
  if(Array.isArray(perm))return perm.some(p=>adminCan(p));
  if(Array.isArray(S.permissions))return S.permissions.includes(perm);
  if(perm==='users.view')return !S.isEventAdmin;
  return true;
}
// Decided before `S.permissions` is known from the built-in tiers (a global
// admin holds some of the Settings permissions listed above, an event admin
// none), so the item never flashes into an event admin's sidebar while
// /api/admin/me loads.
export function settingsOffered(){
  if(S.impersonation&&S.impersonation.view==='admin')return false; // the seat is an event admin
  if(S.isSuperAdmin)return true;
  if(Array.isArray(S.permissions))return ADMIN_NAV_PERMISSIONS['admin-settings-tab'].some(p=>S.permissions.includes(p));
  return !!S.isAdmin&&!S.isEventAdmin;
}
// The platform (and per-event) certificate designer may SAVE: the route
// predicate (`certificates.design`; requireGlobalAdmin refuses an organiser's
// impersonated seat, whose /api/admin/me permissions lack it). Same tier
// fallback as settingsOffered while the permissions are unknown.
export function certificateDesignOffered(){
  if(S.impersonation&&S.impersonation.view==='admin')return false; // an organiser's seat never designs
  if(Array.isArray(S.permissions))return S.permissions.includes('certificates.design');
  if(S.isSuperAdmin)return true;
  return !!S.isAdmin&&!S.isEventAdmin;
}
let _navPermSeq=0;
function _applyNavPermissions(){
  _paintNavPermissions();
  // Every nav build re-reads the role's permissions (a role edit or a role
  // change lands on the next build), then repaints. A failed read keeps what is shown.
  const seq=++_navPermSeq;
  fetch('/api/admin/me').then(r=>r.ok?r.json():null).then(d=>{
    if(seq!==_navPermSeq||!d||!Array.isArray(d.permissions))return;
    S.permissions=d.permissions;
    if(d.role_info&&typeof d.role_info==='object')S.roleInfo=d.role_info;
    _paintNavPermissions();
    // A pane the fresh permissions no longer open (a role edited meanwhile, or
    // permissions that were not known at the first paint) gives way to the
    // first page the role may use.
    _relandIfPaneRefused();
  }).catch(()=>{});
}

/**
 * Is this admin page one the role may open? Its sidebar item as the nav builder
 * left it (shown only for a role holding the permission its pane first reads),
 * or, inside an event workspace, its section tab (SECTION_PERMISSIONS). The ONE
 * answer for every door that opens another page: the command palette's Go to and
 * its actions, and the cross-pane name links (features/admin-crossnav.js), which
 * render a plain name for a page that is not offered.
 */
export function adminPageOffered(tabId){
  const shown=(el)=>!!el&&!el.hidden&&el.style.display!=='none';
  const btn=document.querySelector(`#admin-sidebar .admin-nav-item[data-tab-id="${tabId}"]`);
  const li=btn&&btn.closest('li');
  if(shown(btn)&&(!li||(!li.hidden&&li.style.display!=='none')))return true;
  return !!S.adminSelectedCompetitionId&&shown(document.querySelector(`#ws-tabs [data-section="${tabId}"]`));
}

/** The first sidebar item the nav builder left showing, in sidebar order. */
function _firstOfferedNavItem(){
  for(const btn of document.querySelectorAll('#admin-sidebar .admin-nav-item[data-tab-id]')){
    const li=btn.closest('li');
    if(btn.hidden||(li&&(li.hidden||li.style.display==='none')))continue;
    return btn;
  }
  return null;
}

/**
 * Where the admin panel opens: on Events for a role that may read events (the
 * pane the markup shows first); otherwise on the first sidebar page the role
 * may use. A role that may read no events must never land on that pane: its
 * reads are refused, every refusal toasts, and every refused request counts
 * towards the scanner block of the address (a venue NAT shares one). A role
 * with no page at all is told so, in the pane, and nothing is requested.
 */
export function openAdminLanding(){
  if(adminCan('events.view')){loadAdminCompetitions();loadAdminParticipants();return;}
  const btn=_firstOfferedNavItem();
  if(btn){
    // The landing is not a navigation the person made: the pane's heading does
    // not take focus (the first-route rule `_focusRoute` keeps for pages).
    adminTab(btn,btn.dataset.tabId,{quiet:true});
    return;
  }
  const body=document.getElementById('admin-comp-body');
  if(body)setSafeHtml(body,`<tr><td colspan="${colspanFor('admin-comp-body')}" class="table-empty-row">Your role does not include any page of the admin panel yet. Ask an administrator to change your role.</td></tr>`);
}

function _relandIfPaneRefused(){
  if(S.adminSelectedCompetitionId)return;          // a workspace's sections gate themselves
  const page=document.getElementById('admin-page');
  if(!page||!page.classList.contains('active'))return;
  const shown=ADMIN_PANES.find(id=>{const el=document.getElementById(id);return el&&el.style.display!=='none'&&(el.style.display==='block'||id==='admin-competitions-tab');});
  const btn=shown&&document.querySelector(`#admin-sidebar .admin-nav-item[data-tab-id="${shown}"]`);
  const li=btn&&btn.closest('li');
  if(!li||!(li.hidden||li.style.display==='none'))return;
  const next=_firstOfferedNavItem();
  if(next)adminTab(next,next.dataset.tabId,{quiet:true});
  else openAdminLanding();
}
function _paintNavPermissions(){
  document.querySelectorAll('.admin-nav-item[data-tab-id]').forEach(btn=>{
    const perm=ADMIN_NAV_PERMISSIONS[btn.dataset.tabId];
    const li=btn.closest('li');
    if(!perm||!li)return;
    if(btn.dataset.tabId==='admin-settings-tab'){li.style.display=settingsOffered()?'':'none';return;}
    if(!adminCan(perm))li.style.display='none';
    else if(btn.dataset.tabId==='admin-users-tab'||Array.isArray(S.permissions)&&!['admin-settings-tab','admin-logs-tab'].includes(btn.dataset.tabId))li.style.display='';
  });
  // A group whose items are all hidden loses its caption too.
  document.querySelectorAll('#admin-sidebar ul.admin-nav-list[data-nav-group]').forEach(ul=>{
    const any=[...ul.querySelectorAll(':scope>li')].some(li=>li.style.display!=='none'&&!li.hidden);
    const cap=document.querySelector(`#admin-sidebar .admin-nav-section[data-nav-group="${ul.dataset.navGroup}"]`);
    ul.style.display=any?'':'none';
    if(cap)cap.style.display=any?'':'none';
  });
}

export function buildAdminNav(){
  stopVerifyIndicatorTicker(); // admins are never in a verification grace window
  setStaffBrowser(true);   // a locked platform look binds participants, not staff
  const label=_roleLabel();
  // No role pill in the header any more: the role is the chip in the account
  // menu (and the sidebar's panel title). The organiser shell has no top nav.
  setSafeHtml(document.getElementById('main-nav'), '');
  // One header row: no bar to reserve, but the signed-in header itself is (the
  // next load paints it from the first frame, ha_shell=2).
  document.documentElement.classList.remove('app-shell-hint','app-note-hint');
  setAppShellHint('header');
  // v8.13.4 (fix-delta review) — the Participant View item (account menu,
  // _viewItem) is offered only to a USER-BACKED account, which is what
  // `S.currentUser.id` identifies: the built-in superadmin has no `users` row and
  // so no participant view.
  setSafeHtml(document.getElementById('user-info'), accountButtonHtml());
  document.getElementById('admin-panel-title').textContent=label+' Panel';
  if(workspaceHooks.adminNavBuilt)workspaceHooks.adminNavBuilt();
  // Populate nav icons
  document.querySelectorAll('.admin-nav-item[data-tab-id]').forEach(btn=>{
    const icon=btn.querySelector('.admin-nav-icon');
    if(icon)setSafeHtml(icon,_ADMIN_NAV_ICONS[btn.dataset.tabId]||'');
  });
  // Settings is offered to a role holding any of its cards' permissions
  // (settingsOffered); each card shows only to a role holding what its routes
  // check (SETTINGS_CARD_PERMISSIONS), so the pane is never empty. An event
  // admin holds none of them: the item stays hidden (an empty tab reads as a
  // broken feature, the v7.14.2 lesson).
  //
  // The <li> is hidden, not the <button>, so the item leaves layout AND the tab
  // order — a translated-but-present control is still a tab stop (v7.23.7).
  // Set BOTH ways: the participant-view toggle rebuilds this nav in place, so a
  // one-way hide would never come back for a superadmin.
  const settingsNav=document.querySelector('.admin-nav-item[data-tab-id="admin-settings-tab"]');
  const settingsLi=settingsNav&&settingsNav.closest('li');
  if(settingsLi)settingsLi.style.display=settingsOffered()?'':'none';
  _applyNavPermissions();
  initAdminSidebar();
  _syncSectionBar(document.querySelector('.admin-nav-item.active'));
  // v8.5.0 — the release-notes button is admin-only, so it is (re)rendered from
  // the two nav builders: they are the two functions that run on EVERY role
  // transition the SPA can make, which is the property that matters here. A rule
  // implemented at one door of several is this codebase's most-repeated defect.
  renderReleaseNotesButton();
  // A "?" tip worded per role was wired at boot, before the role was known: the
  // two builders run on every role and view change, so the words follow them.
  refreshRoleTips();
  // v7.23.3 — the header's height changes with its contents.
  publishHeaderHeight();
}

export function _updateSidebarToggleIcon(collapsed){
  const btn=document.getElementById('admin-sidebar-toggle');
  if(!btn)return;
  setSafeHtml(btn,collapsed?ICO.chevronRight:ICO.chevronLeft);
  btn.setAttribute('aria-label',collapsed?'Expand sidebar':'Collapse sidebar');
  _syncCollapsedNavTitles(collapsed);
}

// v8.11.12 — A COLLAPSED RAIL OF NINE UNLABELLED ICONS.
//
// `.admin-sidebar.collapsed .admin-nav-label{opacity:0;width:0;overflow:hidden}`
// keeps the text in the ACCESSIBILITY TREE — measured, `ariaSnapshot()` still
// returns `button "Events"`, `button "Challenges"`, … — so a screen-reader user
// was never affected. A sighted MOUSE user got nine 55x44 icons with no visible
// label, no tooltip and no way to learn which was which, and the state PERSISTS
// in localStorage, so it is not transient.
//
// WHY `title` AND NOT A CSS TOOLTIP. `.admin-nav-item` is `position:relative`
// INSIDE `.admin-sidebar{overflow:hidden}`, so an absolutely-positioned label
// beside the rail has its containing block inside the clipper and is clipped —
// the v8.11.8 rule read the other way round. `position:fixed` would escape but
// cannot be placed relative to the item in CSS alone. `title` also feeds the
// app's OWN `.touch-tooltip` (core/main.js, driven by `[title]` on
// `touchstart`), so one attribute serves mouse and touch rather than inventing a
// second tooltip mechanism.
//
// THE COST, STATED: on an element that already has an accessible name, `title`
// becomes the accessible DESCRIPTION, so a screen reader may announce the label
// twice while the rail is collapsed. That is why it is applied ONLY while
// collapsed and REMOVED on expand — in the expanded state the visible label is
// there and a description would be pure noise.
function _syncCollapsedNavTitles(collapsed){
  for(const item of document.querySelectorAll('.admin-nav-item')){
    if(!collapsed){ item.removeAttribute('title'); continue; }
    const lab=item.querySelector('.admin-nav-label');
    const text=(lab&&lab.textContent||'').trim();
    if(text)item.setAttribute('title',text);
  }
}

// audit v7.23.7 — the CLOSED mobile drawer must hold no tab stops.
//
// At <=768px the sidebar is position:fixed;transform:translateX(-100%). A
// TRANSLATED element is still in the tab order: measured at 390x844, 9 of its 10
// focusable descendants were tabbable while sitting at x=-220, so a keyboard
// user on a phone tabbed through nine invisible admin nav buttons before
// reaching any content (WCAG 2.4.3, 2.4.7).
//
// `inert` rather than CSS, and the reason is not a preference. `visibility:hidden`
// removes the tab stops correctly, but Playwright defines visible as "has a box
// and is not visibility:hidden" — so it also makes #admin-sidebar not-visible,
// and cross-browser.spec.js legitimately waits for exactly that as its proxy for
// "the admin shell rendered". Five mobile/tablet projects went red on it. Any
// CSS that takes an element out of the tab order takes it out of Playwright's
// visibility too, so CSS alone cannot satisfy both. `inert` maps to no CSS
// property: layout, paint and the slide transition are untouched.
//
// matchMedia is the authority on the breakpoint, NOT a viewport number — the
// same call cross-browser.spec.js settled on, because under device emulation the
// reported viewport can differ from the width the media query evaluates against.
const _drawerMq = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(max-width:768px)') : null;

export function _syncAdminSidebarInert(){
  const sidebar=document.getElementById('admin-sidebar');
  if(!sidebar)return;
  const isDrawer=_drawerMq?_drawerMq.matches:false;
  sidebar.inert=isDrawer&&!sidebar.classList.contains('mobile-open');
}

// THE PHONE SECTION BAR. At <=768px the organiser's section navigation is a
// full-width bar IN FLOW at the top of the admin page (#admin-mobile-menu-btn,
// right under the header, not sticky), never a button floating over the content. It names
// the section on screen; a press opens the sections drawer.
function _syncSectionBar(navBtn){
  const lab=document.getElementById('admin-section-label');
  if(!lab)return;
  const t=(navBtn&&navBtn.querySelector('.admin-nav-label')?.textContent||'').trim();
  lab.textContent=t||'Sections';
}

export function _closeAdminSidebarMobile(){
  const sidebar=document.getElementById('admin-sidebar');
  const overlay=document.getElementById('admin-sidebar-overlay');
  // audit v7.23.7 — hand focus back to the opener if it was inside the drawer.
  //
  // Now that the closed drawer is visibility:hidden (styles.css, @media
  // max-width:768px), closing it while a nav item holds focus drops focus to
  // <body> — a focus-order defect in the other direction from the one that
  // change fixes. This is the same contract overlayDismiss keeps for modals:
  // return focus to the control that opened the thing.
  //
  // Deliberately NOT gated on viewport width: `contains(activeElement)` is only
  // true when focus really is in the drawer, which on desktop it can legitimately
  // be — but there the hamburger is display:none, so .focus() is a no-op and
  // focus stays put. The condition is therefore self-limiting.
  // adminTab() calls this and THEN _focusAdminTab(tabId), which moves focus into
  // the pane; that is the better destination and it wins by running last.
  const hadFocus = !!(sidebar && sidebar.contains(document.activeElement));
  if(sidebar)sidebar.classList.remove('mobile-open');
  if(overlay){overlay.classList.remove('visible');overlay.setAttribute('aria-hidden','true');}
  // v8.11.7 — release the modality the open path took. The trap's own
  // MutationObserver fires on DOM REMOVAL and the drawer is only unclassed, so
  // this cleanup is manual — the help drawer keeps the same contract for the
  // same reason.
  const contentEl2=document.querySelector('.admin-content');
  if(contentEl2)contentEl2.inert=false;
  // The section bar sits outside .admin-content, so the open path inerts it
  // separately; released here, before the focus hand-back below targets it.
  const barEl=document.getElementById('admin-mobile-menu-btn');
  if(barEl)barEl.inert=false;
  if(S._sidebarRemoveTrap){try{S._sidebarRemoveTrap();}catch(e){console.warn('Could not release the drawer focus trap',e);}S._sidebarRemoveTrap=null;}
  if(window._modalEscStack){
    const i=window._modalEscStack.indexOf(_closeAdminSidebarMobile);
    if(i>=0)window._modalEscStack.splice(i,1);
  }
  _syncAdminSidebarInert();
  // Setting inert on an ancestor of the focused element drops focus to <body>,
  // so hand it back to the opener — the contract overlayDismiss keeps for
  // modals. Self-limiting rather than viewport-gated: on desktop the hamburger
  // is display:none, so .focus() is a no-op and focus stays where it was.
  if(hadFocus) document.getElementById('admin-mobile-menu-btn')?.focus();
}

// The first RENDERED focusable in the drawer, not the first in document order:
// the sidebar opens with #admin-sidebar-toggle, which is display:none at this
// breakpoint, and a display:none element cannot take focus — so a naive
// querySelector moves focus nowhere and the trap has nothing to hold.
function _focusDrawerFirstItem(sidebar){
  const cand=sidebar.querySelectorAll('.admin-nav-item,button,a,[tabindex]:not([tabindex="-1"])');
  for(const el of cand){
    if(_rendered(el)&&!el.disabled){el.focus();break;}
  }
}

export function initAdminSidebar(){
  const sidebar=document.getElementById('admin-sidebar');
  const toggleBtn=document.getElementById('admin-sidebar-toggle');
  const overlay=document.getElementById('admin-sidebar-overlay');
  const mobileBtn=document.getElementById('admin-mobile-menu-btn');
  if(!sidebar||!toggleBtn)return;
  // Restore collapsed state from localStorage
  const collapsed=localStorage.getItem('adminSidebarCollapsed')==='1';
  sidebar.classList.toggle('collapsed',collapsed);
  _updateSidebarToggleIcon(collapsed);
  // Clone and replace toggle button to remove old listeners
  const newToggle=toggleBtn.cloneNode(true);
  toggleBtn.parentNode.replaceChild(newToggle,toggleBtn);
  _updateSidebarToggleIcon(sidebar.classList.contains('collapsed'));
  newToggle.addEventListener('click',()=>{
    const isNowCollapsed=sidebar.classList.toggle('collapsed');
    localStorage.setItem('adminSidebarCollapsed',isNowCollapsed?'1':'0');
    _updateSidebarToggleIcon(isNowCollapsed);
  });
  // Mobile hamburger
  if(mobileBtn){
    const newMobile=mobileBtn.cloneNode(true);
    mobileBtn.parentNode.replaceChild(newMobile,mobileBtn);
    newMobile.addEventListener('click',()=>{
      // v8.12.6 — OPENING IS IDEMPOTENT. A second activation while the drawer is
      // already open reassigned S._sidebarRemoveTrap without releasing the first
      // trap, so closing released one and orphaned the other for the life of the
      // tab. Reachable three ordinary ways: a double-tap or a mouse double-click
      // (the second one landed on the button, which painted above the drawer),
      // and a screen reader's virtual cursor, which reaches the button because it
      // is outside the inert content. On a phone the orphan pinned Tab to the
      // button; widen the window past 768px and it confined Tab to the sidebar —
      // a full keyboard trap on desktop. The help drawer's `if (S._helpRemoveTrap)`
      // is the same rule for the same reason. Focus is handed back INTO the drawer
      // rather than left where the activation found it: a bare return would leave
      // it on the button, outside the open modal it belongs to.
      if(sidebar.classList.contains('mobile-open')){_focusDrawerFirstItem(sidebar);return;}
      sidebar.classList.add('mobile-open');
      S._sidebarOpenedAt=Date.now();
      _syncAdminSidebarInert();
      const liveOverlay=document.getElementById('admin-sidebar-overlay');
      if(liveOverlay){liveOverlay.classList.add('visible');liveOverlay.setAttribute('aria-hidden','false');}
      // v8.11.7 — THE DRAWER IS MODAL, SO IT MUST BEHAVE LIKE ONE. Measured at
      // 390x844: focus stayed on the hamburger and never entered the drawer, and
      // 7 of 16 Tab stops landed in the page BEHIND its 45%-black scrim while
      // `mobile-open` was still true. Three things fix it, and they are the same
      // three every other modal in this app already does:
      //   • mark the content behind it INERT, so Tab cannot reach it at all
      //     (`inert` also removes it from the a11y tree, which the scrim did not);
      //   • install the shared focus trap, so Tab cycles inside the drawer;
      //   • move focus INTO it, or the first Tab lands outside by construction.
      const contentEl=document.querySelector('.admin-content');
      if(contentEl)contentEl.inert=true;
      // The section bar is the drawer's opener but lies outside .admin-content;
      // under the drawer it is page behind a modal, so it leaves the a11y tree
      // and the tab order too. Looked up by id: initAdminSidebar clones it.
      const barEl=document.getElementById('admin-mobile-menu-btn');
      if(barEl)barEl.inert=true;
      S._sidebarRemoveTrap=installOverlayFocusTrap(sidebar);
      // The shared LIFO Escape stack, not a private listener — see the pop in
      // _closeAdminSidebarMobile for why that distinction is load-bearing.
      if(window._modalEscStack&&!window._modalEscStack.includes(_closeAdminSidebarMobile)){
        window._modalEscStack.push(_closeAdminSidebarMobile);
      }
      setTimeout(()=>_focusDrawerFirstItem(sidebar),0);
    });
  }
  // Overlay click closes mobile sidebar
  if(overlay){
    const newOverlay=overlay.cloneNode(true);
    overlay.parentNode.replaceChild(newOverlay,overlay);
    // The phone section bar is full width, so the second tap of a double-tap on
    // it lands on the scrim beside the drawer, not on the drawer's brand strip:
    // a scrim press inside the opening gesture's window does not close it.
    newOverlay.addEventListener('click',()=>{
      if(Date.now()-(S._sidebarOpenedAt||0)<500)return;
      _closeAdminSidebarMobile();
    });
  }
  // Escape closes mobile sidebar. audit v7.7.36 (P8) — register the document-level
  // keydown listener ONCE. initAdminSidebar runs on every login into admin view
  // AND every Participant↔Admin toggle; pre-fix each added a fresh never-removed
  // handler, so listeners piled up (one per admin-view entry) and ran on every
  // keystroke for the tab's lifetime. The guard is idempotent across re-inits.
  // Crossing the breakpoint (rotation, a desktop resize) changes whether the
  // sidebar is a drawer at all, and nothing else would re-evaluate it.
  // v8.12.6 — and crossing OUT of it with the drawer open must CLOSE it, not only
  // re-sync the sidebar's inert: the scrim's `.visible` rule is not media-scoped,
  // so a phone rotated past 768px with the drawer open kept the scrim over the
  // desktop layout and the content inert — the first tap on the sidebar hit the
  // scrim and navigated nowhere. Closing is idempotent, so a closed drawer costs
  // nothing; crossing INTO the drawer range closes nothing.
  if(_drawerMq&&!document._sidebarMqWired){
    document._sidebarMqWired=true;
    _drawerMq.addEventListener('change',(e)=>{
      if(!e.matches)_closeAdminSidebarMobile();
      _syncAdminSidebarInert();
    });
  }
  // v8.11.7 — the private document-level Escape listener is GONE. It was gated
  // only on `mobile-open`, so with a modal open ON TOP of the drawer one Escape
  // keypress closed BOTH on the same event (measured: escStack 1 → 0, drawer and
  // modal both closed, the modal resolving as cancelled). The drawer now pushes
  // onto `window._modalEscStack` at open and pops at close, so it takes its turn
  // in the same LIFO order as every other overlay — the fix v6.9.22 made for the
  // help drawer, which had exactly this listener.
  _syncAdminSidebarInert();
}

export async function toggleAdminView(toAdmin){
  const mode=toAdmin?'admin':'participant';
  // v8.12.1 — through `_sessionTransitionPost`, not the intercepted fetch: the
  // toggle REGENERATES the session, so the interceptor's reading of a refusal
  // does not apply to it (the v8.10.3 argument, one door over), and the helper's
  // pre-flight refreshes an EMPTY token before the send. A network failure is
  // reported, never navigated past — unlike enter/exit there is no reload to
  // re-resolve into.
  const r=await _sessionTransitionPost('/api/toggle-admin-view',{mode});
  if(!r){if(!S._sessionOutOfDate)showToast('Could not switch view — check your connection and try again.','error');return;}
  const d=await r.json().catch(()=>({}));
  // v8.13.4 (pre-release review) — a STALE token refused here has already ENDED
  // the session (every session carrying an identity, the built-in superadmin's
  // and an impersonating admin's included), so the helper's one retry meets a
  // fresh anonymous session. This route answers THAT with 403 "Not a user
  // session" (it is a user-account door — `buildAdminNav` offers the toggle only
  // to an account with a `users` row, `S.currentUser.id`, so for THAT account the
  // refusal means its session is gone, never that it lacked the right). That is a
  // sign-out, announced as the interceptor would; the raw refusal over a dead
  // panel was not (the impersonateParticipant fix, one door over). The arm keys on
  // the same `id`: for an account without one the refusal is an honest refusal of
  // a LIVE session and stays a toast.
  const _userBacked=!!(S.currentUser&&S.currentUser.id);
  if(r.status===401||d.error==='csrf_invalid'||(d.error==='Not a user session'&&_userBacked)){
    if(!S._sessionExpiredHandled){S._sessionExpiredHandled=true;_stopAllPolls();await _announceSignout({kind:'unknown'},'csrf_invalid');}
    return;
  }
  if(!r.ok){showToast(d.error||'Failed to switch view','error');return;}
  // Session regenerated on toggle — re-fetch CSRF token
  await loadCsrfToken();
  S.isAdmin=d.isAdmin;S.isSuperAdmin=d.isSuperAdmin;S.isEventAdmin=!!d.isEventAdmin;S.isAdminView=d.isAdmin;
  // v8.12.1 — under impersonation the toggle answers with the impersonation
  // block (the marker rode through the regenerate), and the banner names the
  // view in force, so it is re-rendered from the fresh answer BEFORE either nav
  // is built — the Exit button must be there before anything clickable, and
  // the admin nav's Settings offer (`settingsOffered`) reads `S.impersonation`.
  if(d.impersonation){S.impersonation=d.impersonation;}
  refreshImpersonationBanner();
  // Role has changed — clear Help-drawer session memory so the next `?`
  // click resolves to the correct role-default instead of reopening the
  // doc that matched the previous view.
  if(typeof S._helpLastDoc!=='undefined')S._helpLastDoc=null;
  if(toAdmin){
    buildAdminNav();showMain('admin-page');startAdminCompPoll();
    // v8.12.2 — the regenerate dropped every sealed-answer reveal.
    refreshAfterSessionRegenerate();
  }else{
    // Stop every admin-only background loop on the way down to participant view.
    // The Logs pane's poll would otherwise keep firing /api/admin/logs under a
    // no-longer-admin session and log 403s. Compounds with the guard inside
    // startAdminLogsAutoRefresh, but belt + braces.
    stopAdminLogsAutoRefresh();
    // audit v7.7.36 (P5) — also stop the scope-banner + admin-comp poll + admin
    // countdown intervals. Pre-fix they kept running under the now-participant
    // session: the 1s scope-banner re-parsed the hidden banner 3600×/hour AND,
    // on a scoped-comp status transition, fired loadAdminCompetitions() which now
    // 403s (privileges dropped) — flashing the spinner + wiping the cached admin
    // list. They restart on the way back up (startAdminCompPoll / renderScopeBanner).
    if(S.scopeBannerInterval){clearInterval(S.scopeBannerInterval);S.scopeBannerInterval=null;}
    if(S.adminCompPollInterval){clearInterval(S.adminCompPollInterval);S.adminCompPollInterval=null;}
    buildParticipantNav();updateParticipantNav();
    // v8.12.0 — THE SERVER MAY HAVE LANDED US SOMEWHERE. Switching to participant
    // view is a door into the participant app, so `POST /api/toggle-admin-view`
    // now applies the two sign-in landing rules (the auto-resume marker, then the
    // sole-event landing) when the session carried no event, and answers with the
    // `competitionId` it settled on. The client routes off it exactly as it routes
    // off its own remembered id — so an admin enrolled in exactly one event lands
    // in it rather than on a one-card list. A carried id still wins, as before.
    if(!S.currentCompetitionId&&d.competitionId){
      S._compGen++;   // v8.14.4 — every writer of the tab's event bumps it (see ejectToCompetitionPicker)
      S.currentCompetitionId=d.competitionId;
      // The picker's confirm logic and the row's `competing` flag both read this
      // list, and boot has not necessarily loaded it for an admin session.
      try{const mr=await fetch('/api/my-competitions');if(mr.ok)S.myCompetitions=await mr.json();}
      catch(e){console.warn('Could not refresh the event list after the view switch; the picker reloads it.',e);}
    }
    if(S.currentCompetitionId){
      // Re-select to get fresh status — don't assume tasks page is appropriate
      const result=await selectCompetition(S.currentCompetitionId);
      if(result==='needsTimeslot'){
        showTimeslotPicker();
      }else if(result!==false){
        if(routeVerdict(result)==='enter'){
          showMain('tasks-page');enterCompetitionView();
        }else{
          showPendingPageForCompetition();
        }
      }else{showMain('competitions-page');}
    }else{showMain('competitions-page');}
  }
}

// The organiser shell's pane list. The four event-only panes are reached from
// the EVENT WORKSPACE's own section tabs; Templates from the sidebar.
export const ADMIN_PANES=['admin-competitions-tab','admin-templates-tab','admin-event-overview-tab','admin-tasks-tab','admin-participants-tab','admin-groups-tab','admin-submissions-tab','admin-audit-tab','admin-rankings-tab','admin-analytics-tab','admin-event-certs-tab','admin-event-team-tab','admin-event-settings-tab','admin-logs-tab','admin-settings-tab','admin-users-tab'];
// Panes that exist only inside an event workspace: shown with an event open, never
// from the sidebar (the workspace's own tab strip is their only door).
export const WORKSPACE_ONLY_PANES=new Set(['admin-event-overview-tab','admin-event-certs-tab','admin-event-team-tab','admin-event-settings-tab']);
// Loaders for the panes that live in feature modules this one does not import
// (the workspace and the templates gallery import nav.js; registering keeps the
// graph acyclic at evaluation time). Filled by core/main.js boot().
export const adminPaneLoaders=new Map();
// The workspace's own hooks, registered by features/event-workspace.js:
// `close()` leaves the workspace (clears the event) before a cross-event page
// opens, and `sync(tabId)` marks which of its sections is showing.
export const workspaceHooks={close:null,sync:null,adminNavBuilt:null};

/**
 * Show one admin pane.
 *
 * TWO KINDS OF DOOR. The SIDEBAR is the cross-event shell: an item there opens a
 * page about every event the actor may see, so it LEAVES any open event
 * workspace first (the event is cleared, and the pane loads unscoped). The
 * WORKSPACE's section tabs (`#ws-tabs`, the phone section sheet) keep the event:
 * the same Participants / Challenges / Rankings panes then load scoped to it.
 * `opts.keepEvent` is the programmatic form of the second door. `opts.quiet`
 * (the panel's own landing) shows the pane without announcing it.
 */
export function adminTab(btn,tabId,opts){
  const fromWorkspace=!!(opts&&opts.keepEvent)||!!(btn&&btn.closest&&btn.closest('#ws-tabs,#ws-section-sheet,#admin-workspace,#ws-overview'));
  if(!fromWorkspace&&S.adminSelectedCompetitionId&&workspaceHooks.close)workspaceHooks.close({silent:true});
  // A workspace-only pane has no meaning without an event: fall back to Events.
  if(WORKSPACE_ONLY_PANES.has(tabId)&&!S.adminSelectedCompetitionId)tabId='admin-competitions-tab';
  document.querySelectorAll('.admin-nav-item').forEach(b=>{b.classList.remove('active');b.removeAttribute('aria-current');});
  // In a workspace the sidebar says where you are: inside Events.
  const navBtn=S.adminSelectedCompetitionId
    ?document.querySelector('.admin-nav-item[data-tab-id="admin-competitions-tab"]')
    :(btn&&btn.classList&&btn.classList.contains('admin-nav-item')?btn:document.querySelector(`.admin-nav-item[data-tab-id="${tabId}"]`));
  if(navBtn){navBtn.classList.add('active');navBtn.setAttribute('aria-current','page');}
  _syncSectionBar(navBtn);
  ADMIN_PANES.forEach(id=>{
    // Null-guard: a stale cached index.html (missing a newer pane like
    // admin-groups-tab) must not throw mid-loop and break every tab after it.
    const _pane=document.getElementById(id);if(_pane)_pane.style.display=id===tabId?'block':'none';});
  // The Events list is the workspace's way out, so it never shows beside one.
  if(tabId==='admin-competitions-tab'&&S.adminSelectedCompetitionId&&workspaceHooks.close)workspaceHooks.close({silent:true});
  if(workspaceHooks.sync)workspaceHooks.sync(tabId);
  // audit v7.12.3 (#12) — drop any stale fixed-selection-bar page padding when leaving a
  // pane; the target pane's loader re-adds it via its updater if it has a live selection.
  document.body.classList.remove('selection-bar-open');
  if(tabId==='admin-competitions-tab')loadAdminCompetitions();
  if(tabId==='admin-submissions-tab')loadAdminSubmissions();
  if(tabId==='admin-rankings-tab')loadAdminRankingsTab();
  if(tabId==='admin-participants-tab')loadAdminParticipants();
  if(tabId==='admin-groups-tab')loadAdminGroups();
  if(tabId==='admin-tasks-tab')loadAdminTasks();
  if(tabId==='admin-analytics-tab')loadAdminAnalytics();
  if(tabId==='admin-logs-tab')openAdminLogs();
  if(tabId==='admin-settings-tab')loadAdminSettings();
  const _extra=adminPaneLoaders.get(tabId);if(_extra)_extra();
  // Kill the logs auto-refresh if the user navigated off the Logs pane, so we
  // don't keep hammering /api/admin/logs in the background.
  if(tabId!=='admin-logs-tab')stopAdminLogsAutoRefresh();
  _closeAdminSidebarMobile();
  // Announced (focus to the pane's route target: its heading, or the event's
  // name on a workspace's Overview) unless this place is already the one shown,
  // or the caller is the panel's landing (`quiet`), at boot and sign-in from
  // showMain and from the GET /api/admin/me answer (`openAdminLanding`,
  // `_relandIfPaneRefused`), because nobody asked for that move. Every other
  // caller is a navigation a person asked for (a sidebar or workspace tab,
  // admin-crossnav's links, the palette, the workspace's own open, a report
  // email's link to an event section), so it is announced.
  _focusAdminTab(tabId,opts);
}

export const _prefersReducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const _revealObserver=_prefersReducedMotion?null:new IntersectionObserver(entries=>{
  entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');_revealObserver.unobserve(e.target);}});
},{threshold:0.1});

export function applyReveal(container){
  if(_prefersReducedMotion||!_revealObserver)return;
  container.querySelectorAll('.task-card,.comp-card,.card:not(.table-card)').forEach(el=>{
    el.classList.add('reveal');
    _revealObserver.observe(el);
  });
}
