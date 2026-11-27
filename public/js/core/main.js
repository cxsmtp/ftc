"use strict";

// Entry point (v7.0.0 ESM split). Imports every module so their exports are
// available for boot-time wiring, installs the fetch interceptor + delegated
// listeners, wires all data-action handlers, and runs the bootstrap — all
// inside boot(), invoked once at DOM-ready.

import { S } from "./state.js";
import { installFetchInterceptor, installSessionSync, loadCsrfToken } from "./api.js";
import { _actionHandlers, _changeHandlers, _inputHandlers, registerAction, registerChange, registerInput, _enableSortableA11y, _syncTogglePressed } from "./dispatcher.js";
import { setSafeHtml } from "./trusted-types.js";
import { COUNTRY_TZ, autoDetectCountryTz, updateTimezones, autoFillDialCode } from "./../data/country-tz.js";
import { _ackAdminAlert, _ackAdminAlertGlobal, startAdminAlertPoll } from "./../features/admin-alerts.js";
import { _analyticsClosePicker, _analyticsParseLocalDate, _analyticsRowCharts, _analyticsScheduleRefetch, _analyticsState, _anEffectiveSort, _anSyncSortHeaders, _tagClearHandler, _tagModeHandler, _tagToggleHandler, exportAnalyticsCsv, renderAnalyticsFilterBar, renderAnalyticsTable } from "./../features/analytics-admin.js";
import { _autoFillCityFromTz, leaveJoinedEvent, checkInvitation, confirmParticipantViewProfile, doLogin, doLogout, doRegister, openProfileCompletionGate, openProfileEditor, saveProfile, selectAvatar, toggleJobFunctionOther, updateProfileTimezones, signinCodeRedeem, signinCodeRestart, signinCodeResend, syncLoginEmailHint, loginCodeInstead, openSignInMethodDialog, saveSignInMethod, savePasswordPrompt, keepCodesPrompt, registerCancel, paintRegLocation, regLocationChange, paintCsrfBusy, _paintCodeCells } from "./../features/auth.js";
import { _renderTaskFormAttachments, tfAddChoice, tfRemoveChoice, tfSetChoiceText, tfSetChoiceCorrect, tfSyncAnswerType, tfAddExtraAnswer, tfRemoveExtraAnswer, tfSetExtraAnswer, _closeAttachPicker, _deleteSavedAttachment, _deleteStagingAttachment, _openAttachPicker, _renameSavedAttachment, _renameStagingAttachment, _uploadAttachmentNow,  assignPickedTasks, challengeBulkAssignExecute, challengesBulkAssign, toggleAllChallenges, toggleChallengeSelection, closeTaskForm, closeTaskPreview, deleteAllFeedback, deleteFeedback, deleteTask, editTask, loadAdminTasks, openAddTasksToCompetition, openAssignTaskToComps, openAttemptGrant, openTaskForm, openTaskPickerForCompetition, publishTask, recalculateTaskScores, revealSealedAnswer, removeTaskFromComp, renderAdminTasks, restoreTaskVersion, saveTask, saveTaskCompAssignments, sortAdminTasks, toggleTaskDiffFilter, toggleTaskLock, toggleTaskStateFilter, toggleTaskStatusFilter, toggleTaskVisibility, updateAssignSaveBtn, updateTaskPickerCount, viewTaskAsParticipant } from "./../features/challenges-admin.js";
import { chooseTimeslot, COMP_CATEGORY_LABEL, compDisplayCategory, handleCompetitionsNav, loadMyCompetitions, pickCompetition, renderCompetitionPicker, requestReminder, selectCompetition, setCompFilter, setCompOtherFilter, showCompetitionsPage, showPendingPageForCompetition, showTimeslotPicker, startCompDataPoll, leaveCompetition } from "./../features/competition-picker.js";
import { closeLateEntriesNow, compareCompsForPicker, compKindSelect, openNewEventPage, openCompetitionForm, compFormDeadlineChanged, toggleNoDeadline, toggleLateEntry, toggleLateAuto, compFormLateDeadlineChanged, addCompFormSession, addCompTag, compFormDurChanged, compFormUpdateEndTime, compRegFieldChanged, deleteCompetition, editCompetition, endNow, loadAdminCompetitions, removeCompCxOne, removeCompTag, renderAdminCompetitions, renderScopeBanner, saveCompCxOne, saveCompetition, saveCompetitionAndPickTasks, setAdminTimeslotScope, showCompetitionDelivery, showCompetitionOrganisers, sortCompetitions, startAdminCompPoll, startNow, toggleCompFilter, toggleCompKindFilter, toggleCompFormMode, toggleCxoneDisabled, updateSessionRemoveBtns } from "./../features/competitions-admin.js";
import { executeConflictImport, exportCompetitionActivityCsv, exportParticipants, exportParticipantsCSV, exportTasks, importParticipantsFile, importTasksFile, onConflictResChange, proceedToConflictCheck, renderImportParticipantRows, setAllConflictResolutions, toggleAllImportParticipants, toggleImportParticipant } from "./../features/export-import.js";
import { bulkAddToGroup, createGroupDialog, deleteGroup, loadAdminGroups, manageGroupCompetitions, manageGroupMembers, renameGroupDialog, renderAdminGroups } from "./../features/groups-admin.js";
import { _helpLoadDoc, closeHelpDrawer, openHelpDrawer } from "./../features/help-drawer.js";
import { openReleaseNotes } from "./../features/release-notes.js";
import { _histSort, closeHistoryDialog, loadMoreHistory, renderHistoryDialog, showCompetitionHistory, showTaskHistory, showUserHistory } from "./../features/history.js";
import { loadLeaderboard, sortLeaderboard, sortLeaderboardGroup, sortLeaderboardLate, forgetCertHeld } from "./../features/leaderboard.js";
import { openBadgeShare, copyBadgeLink, copyPostAndOpenLinkedIn } from "./../features/badge-share.js";
import { exitImpersonation, impersonateParticipant, renderImpersonationBanner } from "./../features/impersonation.js";
import { _endedPopupChannel, filterTasks, fireNavigatedAway, fitAnswerArea, handleStarKeydown, hoverStars, loadTasks, openTask, rearmOpenTask, refreshScore, renderTasks, resetStars, revealHint, setSolveFilter, submitAnswer, submitFeedback, tapChoice, tapChoiceToggled } from "./../features/participant-tasks.js";
import { addGroup, addTag, adminEditProfile, approveUser, grantEventAdmin, revokeEventAdmin, blockUser, bulkApproveUsers, closeKebab, deleteParticipant, denyUser, inviteParticipantsForCompetition, loadAdminParticipants, openInviteDialog, quickInviteToCompetition, removeGroup, removeTag, renderParticipants, emailSignInCodeForUser, saveAdminProfile, setPStatusFilter, setUserRole, sortParticipants, submitInvitations, toggleAllParticipants, toggleKebab, toggleParticipantSelection, uninviteFromCompetition, unlockUser, updateAdpTimezones, verifyUser, showParticipantCode, deskInvite } from "./../features/participants-admin.js";
import { loadAdminLeaderboard, loadAdminRankingsTab, selectAdminRankingsComp, sortRankings, rankingsCopy, exportRankingsCsv, setRankingsHideIdentity, _rkToggleExpanded, _rkRerenderFromCache } from "./../features/rankings-admin.js";
import { adminShowParticipant, adminShowChallenge, adminShowGroup } from "./../features/admin-crossnav.js";
import { _copySelfEnrollLink, _copySelfEnrollCode, joinWithCode, openEventCodeDialog, eventCodeApply, eventCodeSignin, _downloadSelfEnrollQr, _renderJoinBanner, clearStoredJoin, enterAfterJoin, joinViaPendingToken, openSelfEnrollOverlay, regenerateSelfEnroll, rehydratePendingJoin, storePendingJoin } from "./../features/self-enroll.js";
import { _sessionMon, _sessionWarnLogoutNow, _sessionWarnStayLoggedIn, startSessionMonitor } from "./../features/session-monitor.js";
import { endTimeslotNow, saveTimeslot, sessionFormDurChanged, sessionFormEndChanged, sessionFormUpdateEnd } from "./../features/sessions-admin.js";
import { loadAdminLogs, _logsFirstPage, logsPageStep, logsPageLast, logsPageSize, loadPlatformName, removeCxOneSettings, removeUnsubscribedEmail, saveCxOneSettings, savePlatformName, saveRequireApproval, setAdminLogsStream, showLogDetails, sortAdminLogs, loadUnsubscribeList, _logsGoToPage, loadAdminSettings, loadCxoneWithdrawals, openCxoneWithdrawalsReview, retryCxoneWithdrawal, dismissCxoneWithdrawal, saveBreakglassUsername} from "./../features/settings-admin.js";
import { _subKbSetActive, loadAdminSubmissions, onSubmissionsSearchInput, resetSubmissionsSnapshot, sortSubmissions } from "./../features/submissions-admin.js";
import { clearSearch, esc, fmtDt, toggleSearchClear, DRY_RUN_TAG, readEventVocabulary } from "./../ui/format.js";
import { ICO } from "./../ui/icons.js";
import { adminTab, buildAdminNav, buildParticipantNav, dropAppShellHint, enterCompetitionView, initPlatformNameFit, openVerifyDialog, publishHeaderHeight, routeVerdict, showMain, showPage, toggleAdminView, watchHeaderHeight, watchStickyStrips } from "./../ui/nav.js";
import { overlayDismiss } from "./../ui/modal.js";
import { _mountHeaderIcons, _themePreference, _resolveTheme } from "./../ui/theme.js";
import { showToast } from "./../ui/toast.js";
import * as _ns0 from "./api.js";
import * as _ns1 from "./dispatcher.js";
import * as _ns2 from "./state.js";
import * as _ns3 from "./trusted-types.js";
import * as _ns4 from "./../data/country-tz.js";
import * as _ns5 from "./../features/analytics-admin.js";
import * as _ns6 from "./../features/auth.js";
import * as _ns7 from "./../features/challenges-admin.js";
import * as _ns8 from "./../features/competition-picker.js";
import * as _ns9 from "./../features/competitions-admin.js";
import * as _ns10 from "./../features/export-import.js";
import * as _ns11 from "./../features/groups-admin.js";
import * as _ns12 from "./../features/help-drawer.js";
import * as _ns13 from "./../features/history.js";
import * as _ns14 from "./../features/leaderboard.js";
import * as _ns16 from "./../features/participant-tasks.js";
import * as _ns17 from "./../features/participants-admin.js";
import * as _ns18 from "./../features/rankings-admin.js";
import * as _ns19 from "./../features/self-enroll.js";
import * as _ns20 from "./../features/session-monitor.js";
import * as _ns21 from "./../features/sessions-admin.js";
import * as _ns22 from "./../features/settings-admin.js";
import * as _ns23 from "./../features/submissions-admin.js";
import * as _ns24 from "./../ui/format.js";
import * as _ns25 from "./../ui/icons.js";
import * as _ns26 from "./../ui/loading.js";
import * as _ns27 from "./../ui/modal.js";
import * as _ns28 from "./../ui/nav.js";
import * as _ns29 from "./../ui/richtext.js";
import * as _ns30 from "./../ui/theme.js";
import * as _ns31 from "./../ui/toast.js";
import * as _ns32 from "./../features/badge-share.js";
import * as _ns33 from "./../features/impersonation.js";
import * as _ns34 from "./../features/admin-alerts.js";
import * as _ns35 from "./../ui/list-controls.js";   // v7.17.1 — shared list chrome
import * as _ns36 from "./../features/admin-crossnav.js"; // v7.22.0 — cross-pane "show me this" navigation
import * as _ns37 from "./../ui/clipboard.js";       // v7.22.0 — copy-to-clipboard with an http:// fallback
import * as _ns38 from "./../ui/csv.js";             // v7.24.0 — the shared client-side CSV serialiser
import * as _ns39 from "./../features/release-notes.js"; // v8.5.0 — the admin-only release-notes button
import * as _ns40 from "./../ui/download.js";        // v8.8.15 — one revoke strategy for every generated download
import * as _ns42 from "./../features/look-picker.js"; // the Look & theme picker
import * as _ns50 from "./../features/event-workspace.js";   // the event workspace (organiser shell)
import * as _ns51 from "./../features/templates-admin.js";   // the templates gallery + quick spin
import * as _ns52 from "./../features/certificate-wizard.js"; // the certificate design wizard
import * as _ns53 from "./../ui/table-cards.js";          // admin tables -> label-gutter cards on phones
import * as _ns63 from "./../ui/table-columns.js";        // admin tables: Columns chooser + sort/filter on every heading
import * as _ns62 from "./../features/filters-panel.js";    // the Filters button + panel on admin lists
import * as _ns81 from "./../features/audit-admin.js";      // the Audit pane (GET /api/admin/audit)
import * as _ns60 from "./../features/appearance.js";      // app chrome: the Appearance page
import * as _ns61 from "./../ui/help-tips.js";             // app chrome: the "?" help tips
import * as _ns66 from "./../ui/task-search.js";           // the one challenge search matcher (title, difficulty, tags)
import * as _ns64 from "./../features/look-admin.js";      // the platform look card and the event look card
import * as _ns70 from "./../features/profile-card.js";    // the People row's compact read-only profile card
import * as _ns65 from "./../features/command-palette.js";  // app chrome: the header Search button + Ctrl/⌘+K palette
import * as _ns72 from "./../features/users-admin.js";     // RBAC — Users & roles
import * as _ns83 from "./../features/event-team.js";      // event team + persona reports (workspace Team & reports)
import * as _ns84 from "./../features/task-assign.js";     // the one add-challenges-to-an-event path
import * as _ns85 from "./../features/topics-admin.js";    // stage B — the Question bank's topics
import * as _ns41 from "./../features/choice-tap.js"; // v8.13.0 — the booth tap-to-answer view (CHOICE_TAP_MQ on window for tests)
import { wirePickerFilter } from "./../ui/list-controls.js"; // v7.20.11 — the analytics pickers filter through it (it mounts its own count node)

function boot() {
  // v8.1.0 (PR 13) — read the event-kind vocabulary FIRST, before anything routes
  // or paints. It is a synchronous dataset read off <body> with no network behind
  // it, so there is no ordering risk and no state in which a surface renders
  // before the labels exist. Everything downstream (chips, the create chooser, the
  // kind filter row, the History label map) reads S.eventKinds.
  readEventVocabulary();
  // v7.23.3 (Wave 4 #17) — measure once before anything routes, so the two
  // header-anchored controls are never positioned from the :root fallback.
  publishHeaderHeight();
  watchHeaderHeight();
  // The strip a page keeps stuck under the header (data-sticky-strip): the
  // route-focus scroll margins read its bottom edge (ui/nav.js).
  watchStickyStrips();
  // v8.6.5 — decide whether the platform name fits beside the logo. Installed
  // once here rather than called from each header writer: it watches the h1, so
  // it covers the nav populating, the countdown appearing and a window resize
  // alike. The CSS already stops the header growing; this only chooses between
  // showing the name and hiding it.
  initPlatformNameFit();
  // Restore the classic-script global namespace (tests + window.* handoffs).
  Object.assign(window, _ns0, _ns1, _ns2, _ns3, _ns4, _ns5, _ns6, _ns7, _ns8, _ns9, _ns10, _ns11, _ns12, _ns13, _ns14, _ns16, _ns17, _ns18, _ns19, _ns20, _ns21, _ns22, _ns23, _ns24, _ns25, _ns26, _ns27, _ns28, _ns29, _ns30, _ns31, _ns32, _ns33, _ns35, _ns34, _ns36, _ns37, _ns38, _ns39, _ns40, _ns41, _ns42, _ns50, _ns51, _ns52, _ns53, _ns60, _ns61, _ns62, _ns63, _ns64, _ns65, _ns70, _ns72, _ns81, _ns66, _ns83, _ns84, _ns85);
  // Live getters/setters mirroring the S state object onto window.
  for (const _k of Object.keys(S)) {
    if (!(_k in window)) { try { Object.defineProperty(window, _k, { get: () => S[_k], set: (v) => { S[_k] = v; }, configurable: true }); } catch (e) { console.warn('Could not expose state key on window', _k, e); } }
  }
  // Install the session-expiry fetch interceptor BEFORE any authenticated
  // fetch (the bootstrap below calls loadCsrfToken / /api/me through it).
  installFetchInterceptor();
  // …and the cross-tab half of its token check (core/api.js `ensureFreshCsrf`).
  installSessionSync();

  if(window.hljs)hljs.configure({ignoreUnescapedHTML:true});

  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){
      // Fire navigated_away for any open challenge before pausing pollers.
      // Guarded because fireNavigatedAway is declared later in this module.
      try{if(typeof fireNavigatedAway==='function')fireNavigatedAway('visibilitychange');}catch(e){console.warn('navigated-away on hide failed',e);}
      // Pause all active polling intervals (none once the session has ended:
      // _stopAllPolls halts them for good).
      S._pausedIntervals=[];
      for(const key of ['compDataPollInterval','lbInterval','adminCompPollInterval','statusPollInterval','scopeBannerInterval']){
        let id=null;
        switch(key){
          case 'compDataPollInterval':id=S.compDataPollInterval;break;
          case 'lbInterval':id=S.lbInterval;break;
          case 'adminCompPollInterval':id=S.adminCompPollInterval;break;
          case 'statusPollInterval':id=S.statusPollInterval;break;
          case 'scopeBannerInterval':id=S.scopeBannerInterval;break;
          default:break;
        }
        if(id){try{clearInterval(id);S._pausedIntervals.push(key);}catch(e){console.warn('Could not pause poll',key,e);}}
      }
    }else{
      // v7.27.0 — the tab is back. If the participant is still looking at the
      // same challenge detail, re-arm it so their EVENTUAL departure is recorded.
      // Deliberately OUTSIDE the `_pausedIntervals.length` guard below: that
      // array is only populated when a poller happened to be running, and the
      // re-arm must not depend on which timers were live when the tab was hidden.
      try{if(typeof rearmOpenTask==='function')rearmOpenTask();}catch(e){console.warn('Could not re-arm the open challenge',e);}
      // Resume paused intervals — trigger a data refresh instead of resuming stale timers
      if(S._pausedIntervals.length&&!S._pollsHalted){
        const page=document.querySelector('.page.active');
        if(page){
          const id=page.id;
          if(id==='competitions-page')loadMyCompetitions();
          else if(id==='admin-page'){loadAdminCompetitions();loadAdminTasks();loadAdminParticipants();startAdminCompPoll();if(S.adminSelectedCompetitionId)renderScopeBanner();} // v7.2.x (audit) — restart the comp poll + scope-banner countdown (paused on tab-hide, never resumed)
          // audit v7.7.32 (RM7) — task-detail-page (the open-challenge view) must
          // resume the same pollers as tasks-page. Pre-fix it matched no branch,
          // so after a tab-hide while a challenge was open the /api/status poll
          // (refreshes hackathonEndTime, detects early/extended end + removal) and
          // the leaderboard poll stayed dead — the 1s local tick then fired a
          // FALSE "Competition Ended" at the ORIGINAL end time even after an admin
          // extended it, and admin end-now/removal was never detected on that tab.
          else if(id==='tasks-page'||id==='leaderboard-page'||id==='task-detail-page'){enterCompetitionView();}
          else if(id==='pending-page'){startCompDataPoll();}
        }
        S._pausedIntervals=[];
      }
    }
  });

  window.addEventListener('pagehide',()=>{
    try{if(typeof fireNavigatedAway==='function')fireNavigatedAway('pagehide');}catch(e){console.warn('navigated-away on pagehide failed',e);}
  });

  //
  // v8.3.20 (external audit) — RUN A DELEGATED HANDLER AND REPORT A FAILURE,
  // SYNCHRONOUS OR NOT.
  //
  // All three dispatchers wrapped their call in a SYNCHRONOUS try/catch, and
  // almost every handler is `async` — so a throw inside one arrived as a
  // REJECTED PROMISE the try could not see. The SPA registers no
  // `unhandledrejection` listener either, so the failure was completely silent:
  // the dialog simply never opened, the row never changed, and an admin on venue
  // wi-fi had nothing to report but "it doesn't work". That is the v7.14.2
  // defect ("a silently-shrinking menu is reported as a broken feature") for
  // every handler at once, and `console.error` is not an operator surface.
  //
  // ONE runner rather than three copies of the tail: a first draft wrapped only
  // the click dispatcher, leaving the change and input channels — which carry
  // the two file IMPORTS, the logs pager, the unsubscribe search and all five
  // analytics filters — exactly as silent as before.
  //
  // DEFENCE IN DEPTH, not a substitute for a loader saying what went wrong where
  // it went wrong: the per-site messages in this release still carry the reason.
  // THE TOAST IS SCOPED TO THE CLICK CHANNEL, and that is not a detail.
  //
  // A toast is `pointer-events:auto` at z-index 9700 in the bottom-right corner,
  // so a burst of them physically covers the controls underneath. `input` fires
  // on every KEYSTROKE and `change` on every filter flip, poll-driven re-render
  // and select — none of them a moment the user is waiting on a result.
  // MEASURED: toasting all three channels turned a 0-1-flaky suite into 6 failed
  // / 16 flaky, almost all of them clicks landing on a toast.
  //
  // A click is different: it is a discrete, deliberate act whose whole point is
  // that something should happen, and it is where every one of the silent
  // crashes this release fixes actually lived. The other two channels keep the
  // console record — which is strictly more than they had, since the
  // synchronous catch could not see a rejected promise at all.
  const _runHandler = (fn, ev, el, kind, name, toast = true) => {
    const _report = (e) => {
      console.error(kind, name, 'failed:', e);
      if (toast) { try { showToast('Something went wrong. Please try again.', 'error'); } catch (e) { console.warn('Could not show the error toast', e); } }
    };
    try {
      const _p = fn(ev, el);
      if (_p && typeof _p.then === 'function') _p.catch(_report);
    } catch (e) { _report(e); }
  };

  document.addEventListener('click', (ev) => {
    if (!ev.target?.closest) return;
    const el = ev.target.closest('[data-action]');
    if (!el) return;
    const fn = _actionHandlers[el.dataset.action];
    if (!fn) return; // unregistered — ignore silently (inline handlers still work while migration is in flight)
    // audit v7.7.30 (M20) — if this action fires from a row's kebab menu, move
    // focus to the kebab TRIGGER before running the handler (the menu stays in
    // the DOM so the handler can still read `el`). A dialog the handler opens
    // then captures the trigger as its opener (showModal/overlayDismiss snapshot
    // document.activeElement) and returns focus there on close. Pre-fix the
    // handler ran with the menuitem focused, then closeKebab() detached it → the
    // dialog's captured opener was a dead node and focus fell to <body>.
    const _kebab = el.closest('.kebab-menu');
    if (_kebab && _kebab._srcBtn) { try { _kebab._srcBtn.focus(); } catch (e) { console.warn('Could not return focus to the menu button', e); } }
    _runHandler(fn, ev, el, 'action handler', el.dataset.action);   // v8.3.20 — see _runHandler above
    // Auto-close any open kebab when a kebab-menu item is activated. Individual
    // handlers no longer need ";closeKebab()" — the dispatcher handles it.
    if (el.closest('.kebab-menu')) closeKebab();
    // audit v7.7.30 (M24) — after a toggle-filter handler flipped the .active
    // classes in place, mirror them to aria-pressed for the whole group.
    if (el.classList && (el.classList.contains('filter-btn') || el.classList.contains('seg') || el.classList.contains('chip'))) _syncTogglePressed(el);
  });

  document.addEventListener('change', (ev) => {
    if (!ev.target?.closest) return;
    const el = ev.target.closest('[data-change-action]');
    if (!el) return;
    const fn = _changeHandlers[el.dataset.changeAction];
    if (!fn) return;
    _runHandler(fn, ev, el, 'change handler', el.dataset.changeAction, false);   // no toast — see _runHandler
  });

  document.addEventListener('input', (ev) => {
    if (!ev.target?.closest) return;
    const el = ev.target.closest('[data-input-action]');
    if (!el) return;
    const fn = _inputHandlers[el.dataset.inputAction];
    if (!fn) return;
    _runHandler(fn, ev, el, 'input handler', el.dataset.inputAction, false);   // no toast — see _runHandler
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    // v6.9.14: same delegator pattern now covers non-button elements
    // that carry a `data-action` AND render as role=button (the event
    // and session chips, the header chips). Pre-v6.9.14 such elements
    // were Tab-stops with no Enter/Space handler (WCAG 2.1.1 failure).
    // The picker and challenge cards no longer need it: their control is
    // a real <button class="card-open"> in the title. `.sortable` stays
    // in the list for admin table header sorting.
    const el = ev.target?.closest?.('.sortable, [role="button"][data-action]:not(button)');
    if (!el) return;
    ev.preventDefault();
    el.click();
  });

  // Star-rating radiogroup: arrow/Home/End/Enter/Space roving-tabindex nav.
  document.addEventListener('keydown', handleStarKeydown);

  // (DOMContentLoaded handler unwrapped — boot() runs at DOM-ready)
  (() => {
    _enableSortableA11y(document);
    new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) _enableSortableA11y(n);
    }).observe(document.body, {childList:true, subtree:true});
  })();

  registerAction('kebab-toggle', (e, el) => toggleKebab({ stopPropagation: () => e.stopPropagation?.(), currentTarget: el }));

  // An event chip on a Challenges or People row opens that event's workspace on
  // the SAME kind of section (its Challenges / its Participants); the status
  // strip's "All sessions" re-opens the event already open and keeps the section.
  registerAction('comp-focus',               (e, el) => {
    const pane = el.closest('[id^="admin-"][id$="-tab"]');
    const tab = pane && (pane.id === 'admin-tasks-tab' || pane.id === 'admin-participants-tab') && S.adminSelectedCompetitionId !== el.dataset.compId ? pane.id : undefined;
    _ns50.openEventWorkspace(el.dataset.compId, el.dataset.compName, tab ? { tab } : {});
  });

  // A session chip (the status strip's, a People row's) opens that session's
  // workspace like `comp-focus` (a People or Challenges row lands on that kind of
  // section); in the open event it narrows to the session and keeps the section.
  registerAction('comp-focus-ts',            (e, el) => {
    const pane = el.closest('[id^="admin-"][id$="-tab"]');
    const tab = pane && (pane.id === 'admin-tasks-tab' || pane.id === 'admin-participants-tab') && S.adminSelectedCompetitionId !== el.dataset.compId ? pane.id : undefined;
    _ns50.openEventWorkspaceSession(el.dataset.compId, el.dataset.compName, el.dataset.tsId, el.dataset.tsName, tab ? { tab } : {});
  });

  registerAction('comp-edit',                (e, el) => editCompetition(el.dataset.compId));

  registerAction('comp-history',             (e, el) => showCompetitionHistory(el.dataset.compId));

  registerAction('comp-assign-challenges',   (e, el) => openTaskPickerForCompetition(el.dataset.compId));

  registerAction('comp-manage-participants', (e, el) => inviteParticipantsForCompetition(el.dataset.compId, el.dataset.compName));

  registerAction('comp-self-enroll',         (e, el) => openSelfEnrollOverlay(el.dataset.compId, el.dataset.compName));

  registerAction('self-enroll-copy',         (e, el) => _copySelfEnrollLink(el.closest('#self-enroll-overlay')));
  registerAction('self-enroll-copy-code',    (e, el) => _copySelfEnrollCode(el.closest('#self-enroll-overlay')));
  registerAction('join-with-code',           ()      => joinWithCode());
  // v8.3.1 — the event-code dialog (replaces the inline login-card box).
  registerAction('open-event-code',          ()      => openEventCodeDialog());
  registerAction('event-code-apply',         ()      => eventCodeApply());
  registerAction('event-code-signin',        ()      => eventCodeSignin());
  registerAction('event-code-discard',       ()      => leaveJoinedEvent());
  registerAction('leave-competition',        ()      => leaveCompetition());
  // Email first: there is no separate "Already have a code?" door — Continue
  // reopens the code step for an address whose code is still live.
  registerAction('signin-code-resend',       ()      => signinCodeResend());
  registerInput('login-email-input',         ()      => syncLoginEmailHint());
  window.addEventListener('ha:csrf-busy',     (e)     => paintCsrfBusy(!!(e.detail && e.detail.on)));
  registerAction('login-code-instead',       ()      => loginCodeInstead());
  registerAction('open-sign-in-method',      ()      => openSignInMethodDialog());
  registerAction('save-sign-in-method',      ()      => saveSignInMethod());
  registerAction('set-password-save',        ()      => savePasswordPrompt());
  registerAction('set-password-codes',       ()      => keepCodesPrompt());
  registerAction('register-cancel',          ()      => registerCancel());
  registerAction('signin-code-redeem',       ()      => signinCodeRedeem());
  registerAction('signin-code-restart',      ()      => signinCodeRestart());
  registerInput('signin-code-input',         ()      => _paintCodeCells());

  registerAction('self-enroll-regenerate',   (e, el) => regenerateSelfEnroll(el.closest('#self-enroll-overlay')));

  registerAction('self-enroll-download-qr',  (e, el) => _downloadSelfEnrollQr(el.closest('#self-enroll-overlay')));

  registerAction('self-enroll-close',        (e, el) => el.closest('#self-enroll-overlay')?.remove());

  registerAction('comp-start-now',           (e, el) => startNow(el.dataset.compId));

  registerAction('comp-end-now',             (e, el) => endNow(el.dataset.compId));
  // v8.12.8 — the Events row menu AND the scope banner both carry it.
  registerAction('comp-close-late-entries',  (e, el) => closeLateEntriesNow(el.dataset.compId));

  registerAction('comp-delete',              (e, el) => deleteCompetition(el.dataset.compId));

  registerAction('comp-tag-add',             (e, el) => addCompTag(el.dataset.compId));

  registerAction('comp-tag-remove',          (e, el) => removeCompTag(el.dataset.compId, el.dataset.tag));

  registerAction('comp-export-activity',     (e, el) => exportCompetitionActivityCsv(el.dataset.compId, el.dataset.compName));

  registerAction('comp-delivery',            (e, el) => showCompetitionDelivery(el.dataset.compId, el.dataset.compName));
  registerAction('comp-organisers',          (e, el) => showCompetitionOrganisers(el.dataset.compId, el.dataset.compName)); // v8.7.0

  registerAction('task-view',                  (e, el) => viewTaskAsParticipant(el.dataset.taskId));

  registerAction('task-publish',               (e, el) => publishTask(el.dataset.taskId));

  registerAction('task-toggle-visibility',     (e, el) => toggleTaskVisibility(el.dataset.taskId));

  registerAction('task-assign-to-comps',       (e, el) => openAssignTaskToComps(el.dataset.taskId));

  registerAction('task-remove-from-comp',      (e, el) => removeTaskFromComp(el.dataset.taskId, el.dataset.compId));

  registerAction('task-attempt-grant',         (e, el) => openAttemptGrant(el.dataset.taskId));

  registerAction('task-history',               (e, el) => showTaskHistory(el.dataset.taskId));

  registerAction('task-edit',                  (e, el) => editTask(el.dataset.taskId));

  registerAction('task-toggle-lock',           (e, el) => toggleTaskLock(el.dataset.taskId));

  registerAction('task-recalculate',           (e, el) => recalculateTaskScores(el.dataset.taskId));
  registerAction('task-reveal-sealed',         (e, el) => revealSealedAnswer(el.dataset.taskId)); // v8.12.2

  registerAction('task-delete',                (e, el) => deleteTask(el.dataset.taskId));
  // Stage B — topics, the editor's topic-and-sharing row, Save to bank.
  registerAction('open-topics-dialog',         () => _ns85.openTopicsDialog());
  registerAction('task-topic-new',             async () => { await _ns85.newTopicFromEditor(); _ns7.tfOrgSync(); });
  registerChange('task-topic-filter',          (e, el) => { S.tTopicFilter = el.value || ''; S.tPage = 1; _ns7.renderAdminTasks(); });
  registerChange('task-org-sync',              () => _ns7.tfOrgSync());
  registerAction('task-save-to-bank',          (e, el) => _ns7.saveTaskToBank(el.dataset.taskId));



  // v7.12.0 — bulk assign challenges to competitions (mirrors participant-select-*).
  registerChange('challenge-select-toggle',    (e, el) => toggleChallengeSelection(el.value, el.checked));
  registerChange('toggle-all-challenges',      (e, el) => toggleAllChallenges(el.checked));
  registerAction('challenges-bulk-assign',        () => challengesBulkAssign());
  registerAction('challenge-bulk-assign-execute', () => challengeBulkAssignExecute());

  registerAction('tasks-page-first',           () => { S.tPage = 1; renderAdminTasks(); });

  registerAction('tasks-page-prev',            () => { S.tPage--; renderAdminTasks(); });

  registerAction('tasks-page-next',            () => { S.tPage++; renderAdminTasks(); });

  registerAction('tasks-page-last',            (e, el) => { S.tPage = parseInt(el.dataset.totalPages, 10); renderAdminTasks(); });

  registerChange('tasks-page-size',            (e, el) => { S.tPageSize = parseInt(el.value, 10); S.tPage = 1; renderAdminTasks(); });

  registerAction('participant-tag-remove',     (e, el) => removeTag(el.dataset.userId, el.dataset.tag));

  registerAction('participant-tag-add',        (e, el) => addTag(el.dataset.userId));

  registerAction('participant-group-remove',   (e, el) => removeGroup(el.dataset.userId, el.dataset.groupId));

  registerAction('participant-group-add',      (e, el) => addGroup(el.dataset.userId));

  registerAction('participant-block',          (e, el) => blockUser(el.dataset.userId, el.dataset.blocked === 'true'));

  registerAction('participant-unlock',         (e, el) => unlockUser(el.dataset.userId));

  registerAction('participant-verify',         (e, el) => verifyUser(el.dataset.userId));

  registerAction('participant-approve',        (e, el) => approveUser(el.dataset.userId));

  registerAction('participant-deny',            (e, el) => denyUser(el.dataset.userId));

  registerAction('participant-role',           (e, el) => setUserRole(el.dataset.userId, el.dataset.newRole, el.dataset.prevRole));
  // v8.7.0 — the per-event organiser grant. Both carry the competition on the
  // element, because the grant is per EVENT and the focused one is what the
  // kebab item named.
  registerAction('participant-event-admin-grant',  (e, el) => grantEventAdmin(el.dataset.userId, el.dataset.compId, el.dataset.compName, el.dataset.nickname));
  registerAction('participant-event-admin-revoke', (e, el) => revokeEventAdmin(el.dataset.userId, el.dataset.compId, el.dataset.compName, el.dataset.nickname));

  registerAction('participant-edit-profile',   (e, el) => adminEditProfile(el.dataset.userId));

  registerAction('participant-history',        (e, el) => showUserHistory(el.dataset.userId));
  registerAction('participant-view-profile',   (e, el) => _ns70.openProfileCard(el.dataset.id || el.dataset.userId));

  registerAction('participant-impersonate',    (e, el) => impersonateParticipant(el.dataset.userId, el.dataset.nickname, el.dataset.role));
  registerAction('participant-show-code',      (e, el) => showParticipantCode(el.dataset.userId, el.dataset.nickname));
  registerAction('desk-invite',                ()      => deskInvite());

  registerAction('impersonation-exit',         () => exitImpersonation());

  registerAction('participant-email-code',     (e, el) => emailSignInCodeForUser(el.dataset.userId));

  registerAction('participant-delete',         (e, el) => deleteParticipant(el.dataset.userId));

  registerAction('participant-invite',         (e, el) => quickInviteToCompetition(el.dataset.userId));

  registerAction('participant-uninvite',       (e, el) => uninviteFromCompetition(el.dataset.userId));

  registerChange('participant-select-toggle',  (e, el) => toggleParticipantSelection(el.value, el.checked));

  registerAction('participants-page-first',    () => { S.pPage = 1; renderParticipants(); });

  registerAction('participants-page-prev',     () => { S.pPage--; renderParticipants(); });

  registerAction('participants-page-next',     () => { S.pPage++; renderParticipants(); });

  registerAction('participants-page-last',     (e, el) => { S.pPage = parseInt(el.dataset.totalPages, 10); renderParticipants(); });

  registerChange('participants-page-size',     (e, el) => { S.pPageSize = parseInt(el.value, 10); S.pPage = 1; renderParticipants(); });

  registerAction('overlay-close',              (e, el) => document.getElementById(el.dataset.overlayId)?.remove());

  registerAction('show-page',                  (e, el) => {
    showPage(el.dataset.page);
    // v6.9.10: keep the URL in sync when toggling between the login and
    // register pages so refresh / bookmarks / browser-back all land on
    // the right screen. Only these two pages have dedicated URLs; every
    // other `show-page` call stays a pure in-app state transition.
    if (el.dataset.page === 'register-page' && location.pathname !== '/register') history.pushState({}, '', '/register');
    else if (el.dataset.page === 'login-page' && location.pathname !== '/') history.pushState({}, '', '/');
  });

  registerAction('show-main',                  (e, el) => showMain(el.dataset.page));

  registerAction('nav-competitions',           () => handleCompetitionsNav());

  registerAction('nav-show-competitions-page', () => showCompetitionsPage());

  // v8.7.3 — the completeness check is wired HERE, at the one DOM control that
  // switches view, rather than inside `toggleAdminView`. `ui/nav.js` must not
  // import `features/auth.js` (auth.js already imports nav.js, so it would close
  // a cycle in the SPA's routing hub — the edge v8.6.5 deliberately routed
  // around), and main.js is where boot wiring belongs anyway.
  registerAction('toggle-admin-view',          async (e, el) => {
    const toAdmin = el.dataset.on === 'true';
    // Only the way DOWN is checked: going back UP is the escape, and gating the
    // escape on the very profile the admin cannot fill in from the admin view
    // would be the trap this whole change exists to prevent.
    // v8.12.1 — and never under impersonation: the profile in question is the
    // TARGET's, which the acting admin is not going to fill in, and the gate the
    // note explains cannot open for an admin-tier target anyway.
    if (!toAdmin && !S.impersonation && !(await confirmParticipantViewProfile())) return;
    return toggleAdminView(toAdmin);
  });

  registerAction('do-logout',                  () => doLogout());

  registerAction('open-profile-editor',        () => openProfileEditor());
  registerAction('open-verify-dialog',         () => openVerifyDialog());
  // After the dialog the leaderboard's certificate card asks again what is held,
  // so a certificate minted there turns the card's gold action into its download.
  registerAction('open-badge-share',           () => openBadgeShare(S.currentCompetitionId).finally(() => {
    forgetCertHeld();
    if (document.getElementById('leaderboard-page')?.classList.contains('active')) loadLeaderboard({ silent: true });
  }));
  registerAction('badge-copy-link',            () => copyBadgeLink());
  registerAction('badge-copy-post',            () => copyPostAndOpenLinkedIn());

  registerAction('save-profile',               () => saveProfile());



  registerAction('ts-start-now',               (e, el) => startNow(el.dataset.compId, el.dataset.tsId));

  registerAction('ts-end-now',                 (e, el) => endTimeslotNow(el.dataset.compId, el.dataset.tsId));

  registerAction('scope-clear',                () => _ns50.closeEventWorkspace());



  registerAction('show-timeslot-picker',       () => showTimeslotPicker());
  registerAction('retry-load-tasks',           () => loadTasks());   // ext-audit v7.15.14 — failed-load recovery
  registerAction('retry-load-leaderboard',     () => loadLeaderboard());  // v8.11.11 — same, for the board
  // v7.23.5 (Wave 5) — the participant picker has no poll of its own until
  // startCompDataPoll() runs, so a failed first load needs an explicit way back.
  registerAction('retry-load-my-competitions', () => loadMyCompetitions());
  registerAction('retry-load-settings',        () => loadAdminSettings());   // v8.3.33 — one caller, no poll
  // v8.11.11 — the five admin panes that MEASURABLY do not poll. There is one
  // admin poll (startAdminCompPoll → loadAdminCompetitions) and Logs has its
  // own refresh; these five re-requested nothing in 20 s with their endpoint
  // failing, so the operator's only route out was to switch tabs and back.
  registerAction('retry-load-admin-tasks',        () => loadAdminTasks());
  registerAction('retry-load-admin-participants', () => loadAdminParticipants());
  registerAction('retry-load-admin-groups',       () => loadAdminGroups());
  registerAction('retry-load-admin-submissions',  () => loadAdminSubmissions());
  registerAction('retry-load-admin-rankings',     () => loadAdminRankingsTab());
  registerAction('retry-load-attachments',        () => _renderTaskFormAttachments());

  registerAction('comps-page-first',           () => { S.cPage = 1; renderAdminCompetitions(); });

  registerAction('comps-page-prev',            () => { S.cPage--; renderAdminCompetitions(); });

  registerAction('comps-page-next',            () => { S.cPage++; renderAdminCompetitions(); });

  registerAction('comps-page-last',            (e, el) => { S.cPage = parseInt(el.dataset.totalPages, 10); renderAdminCompetitions(); });

  registerChange('comps-page-size',            (e, el) => { S.cPageSize = parseInt(el.value, 10); S.cPage = 1; renderAdminCompetitions(); });

  // v7.17.2 — Groups tab list controls. Same shape as the three tables above.
  registerAction('groups-page-first',          () => { S.gPage = 1; renderAdminGroups(); });

  registerAction('groups-page-prev',           () => { S.gPage--; renderAdminGroups(); });

  registerAction('groups-page-next',           () => { S.gPage++; renderAdminGroups(); });

  registerAction('groups-page-last',           (e, el) => { S.gPage = parseInt(el.dataset.totalPages, 10); renderAdminGroups(); });

  registerChange('groups-page-size',           (e, el) => { S.gPageSize = parseInt(el.value, 10); S.gPage = 1; renderAdminGroups(); });

  registerAction('groups-sort',                (e, el) => {
    const col = el.dataset.col;
    if (S.gSortCol === col) S.gSortAsc = !S.gSortAsc; else { S.gSortCol = col; S.gSortAsc = true; }
    S.gPage = 1;
    // No focus restore needed: unlike rankings/leaderboard, this <thead> is
    // static markup and the re-render replaces only the tbody, so the header the
    // admin just activated is still the same element and keeps focus.
    renderAdminGroups();
  });

  registerAction('pick-competition',           (e, el) => pickCompetition(el.dataset.compId, el.dataset.status));

  registerAction('choose-timeslot',            (e, el) => chooseTimeslot(el.dataset.tsId, el.dataset.status));

  registerAction('comp-save',                  () => saveCompetition());

  registerAction('comp-save-and-pick-tasks',   () => saveCompetitionAndPickTasks());

  registerAction('comp-add-form-session',      () => addCompFormSession());

  registerAction('comp-trusted-ips-mine',      () => _ns9.useMyAddressForTrustedIps());

  registerAction('comp-save-cxone',            (e, el) => saveCompCxOne(el.dataset.compId));

  registerAction('comp-remove-cxone',          (e, el) => removeCompCxOne(el.dataset.compId));

  registerAction('session-form-row-remove',    (e, el) => { const row=el.closest('.session-form-row'); if(row?.dataset.tsId)S._pendingSlotDeletes.push(row.dataset.tsId); row?.remove(); updateSessionRemoveBtns(); });

  registerAction('ts-save',                    (e, el) => saveTimeslot(el.dataset.compId, el.dataset.tsId || undefined));

  registerAction('task-open',                  (e, el) => openTask(el.dataset.taskId));

  registerAction('task-reveal-hint',           (e, el) => revealHint(el.dataset.taskId, parseInt(el.dataset.cost, 10)));

  registerAction('task-submit-answer',         (e, el) => submitAnswer(el.dataset.taskId, el.dataset.mode));
  // v8.13.0 — the booth tap-to-answer tiles (features/choice-tap.js)
  registerAction('task-choice-tap',            (e, el) => tapChoice(el));
  registerChange('task-choice-toggle',         (e, el) => tapChoiceToggled(el));
  // Operator ruling 395 — change an answered Quick question's answer, or keep it
  registerAction('task-change-answer',         (e, el) => openTask(el.dataset.taskId, { change: true }));
  registerAction('task-keep-answer',           (e, el) => openTask(el.dataset.taskId));

  registerAction('task-star',                  (e, el) => submitFeedback(el.dataset.taskId, parseInt(el.dataset.value, 10)));

  registerAction('task-assign-save',           (e, el) => saveTaskCompAssignments(el.dataset.taskId));

  registerAction('task-restore-version',       (e, el) => restoreTaskVersion(el.dataset.taskId, el.dataset.versionId, parseInt(el.dataset.versionNum, 10)));

  // v7.20.10 — these act on the SHOWN rows, and the buttons now say so
  // ("Select All Shown"). That was always true — #task-picker-list only ever
  // contains the filtered subset — but while the dialog was add-only the worst
  // case was assigning fewer challenges than you meant. Now that Save also
  // REMOVES, an unlabelled "Unselect All" under a "Hard" filter would unassign
  // every hard challenge in the competition. Same shape as the v7.17.2
  // toggleAllImportParticipants defect, and the same resolution: act on the
  // filtered set, never touch a hidden row, and name the scope on the control.
  // Disabled rows (locked, or a frozen competition) are skipped — `:not(:disabled)`
  // is what stops a bulk click doing what an individual click is refused.
  registerAction('task-picker-select-all',     () => { document.querySelectorAll('#task-picker-list input[type=checkbox]:not(:disabled)').forEach(c => { c.checked=true; S._pickerCheckedIds?.add(c.value); }); updateTaskPickerCount(); });

  registerAction('task-picker-unselect-all',   () => { document.querySelectorAll('#task-picker-list input[type=checkbox]:not(:disabled)').forEach(c => { c.checked=false; S._pickerCheckedIds?.delete(c.value); }); updateTaskPickerCount(); });

  registerAction('task-picker-assign',         (e, el) => assignPickedTasks(el.dataset.compId, el.closest('#task-picker-overlay')));

  registerAction('task-feedback-delete',       (e, el) => deleteFeedback(el.dataset.taskId, el.dataset.userId));

  registerAction('task-feedback-delete-all',   (e, el) => deleteAllFeedback(el.dataset.taskId));

  registerAction('task-preview-close',         () => closeTaskPreview());

  registerAction('history-close',              () => closeHistoryDialog());

  registerAction('history-sort',               (e, el) => _histSort(el.dataset.col));

  registerAction('history-load-more',          () => loadMoreHistory());

  registerAction('history-page-first',         () => { S._histState.page = 1; renderHistoryDialog(); });

  registerAction('history-page-prev',          () => { S._histState.page--; renderHistoryDialog(); });

  registerAction('history-page-next',          () => { S._histState.page++; renderHistoryDialog(); });

  registerAction('history-page-last',          (e, el) => { S._histState.page = parseInt(el.dataset.totalPages, 10); renderHistoryDialog(); });

  registerChange('history-page-size',          (e, el) => { S._histState.pageSize = parseInt(el.value, 10); S._histState.page = 1; renderHistoryDialog(); });

  // v7.21.16 (long-list phase 6) — the two participant-facing searches. No
  // debounce and no network: both filter an array already in hand, so a
  // keystroke is a synchronous re-render of one container. Both inputs are
  // SIBLINGS of the container their handler rewrites (see index.html), which is
  // what keeps the caret and the typed text intact (v7.20.10).
  registerInput('participant-task-search',     (e, el) => { toggleSearchClear(el); renderTasks(S.currentDiffFilter || 'all'); });
  registerAction('participant-task-search-clear', () => clearSearch('participant-task-search', () => renderTasks(S.currentDiffFilter || 'all')));
  // The JSON answer area grows with what is typed, up to its ceiling
  // (participant-tasks.js fitAnswerArea).
  registerInput('task-answer-fit',             (e, el) => fitAnswerArea(el));
  registerInput('participant-comp-search',     (e, el) => { toggleSearchClear(el); renderCompetitionPicker(); });
  registerAction('participant-comp-search-clear', () => clearSearch('participant-comp-search', () => renderCompetitionPicker()));
  registerInput('history-search',              (e) => { S._histState.page = 1; renderHistoryDialog(); toggleSearchClear(e.target); });

  registerAction('history-search-clear',       () => clearSearch('hist-search', () => { S._histState.page = 1; renderHistoryDialog(); }));

  registerAction('subs-page-first',            () => { S.subPage = 1; loadAdminSubmissions(); });

  registerAction('subs-page-prev',             () => { S.subPage = Math.max(1, S.subPage - 1); loadAdminSubmissions(); });

  registerAction('subs-page-next',             () => { S.subPage++; loadAdminSubmissions(); });

  registerAction('subs-page-last',             (e, el) => { S.subPage = parseInt(el.dataset.totalPages, 10); loadAdminSubmissions(); });

  registerChange('subs-page-size',             (e, el) => { S.subPageSize = parseInt(el.value, 10); S.subPage = 1; loadAdminSubmissions(); });

  document.addEventListener('keydown',(e)=>{
    // Only respond when the submissions tab is showing.
    const tab=document.getElementById('admin-submissions-tab');
    if(!tab || tab.style.display==='none')return;
    // Don't hijack typing in inputs / textareas / contenteditable.
    const focused=document.activeElement;
    if(focused && (focused.tagName==='INPUT'||focused.tagName==='TEXTAREA'||focused.isContentEditable))return;
    // Plain `j` / `k` only; no modifier combos.
    if(e.ctrlKey||e.metaKey||e.altKey||e.shiftKey)return;
    if(e.key==='j'){e.preventDefault();_subKbSetActive(S._subKbActiveRow+1);}
    else if(e.key==='k'){e.preventDefault();_subKbSetActive(S._subKbActiveRow-1);}
  });

  registerAction('submissions-reset-snapshot', () => resetSubmissionsSnapshot());

  // v7.22.2 — from a submission row into the pane that owns each side of it.
  registerAction('submissions-open-participant', (e, el) => adminShowParticipant(el.dataset.nickname));
  registerAction('submissions-open-challenge',   (e, el) => adminShowChallenge(el.dataset.title));
  // v7.22.6 — same click-through from the analytics per-challenge table.
  registerAction('analytics-open-challenge',     (e, el) => adminShowChallenge(el.dataset.title));

  registerAction('rankings-refresh',           () => loadAdminRankingsTab());

  registerAction('rankings-select-comp',       (e, el) => selectAdminRankingsComp(el.dataset.compId, el.dataset.compName));

  // v7.22.0 — rankings identity columns: search, copy, and click-through into
  // the pane that owns each kind of row.
  registerInput('rankings-search',             () => {
    const el = document.getElementById('rankings-search');
    if (el) toggleSearchClear(el);
    // Re-render from S._rkCache rather than the network — a keystroke is a pure
    // display change over data already in hand, exactly like a column sort, and
    // the all-live view would otherwise re-issue one request per competition per
    // timeslot on every character (the v7.17.0 lesson).
    clearTimeout(S._rkSearchDebounce);
    S._rkSearchDebounce = setTimeout(() => _rkRerenderFromCache(), 160);
  });
  registerAction('rankings-search-clear',      () => clearSearch('rankings-search', () => _rkRerenderFromCache()));
  registerAction('rankings-copy',              (e, el) => rankingsCopy(el));
  // v8.11.0 — the presenter's view. A CHANGE, not an action: it is a checkbox,
  // so the browser owns the state and the handler reads it rather than tracking
  // a parallel one.
  registerChange('rankings-hide-identity',     (e, el) => setRankingsHideIdentity(el.checked));
  // v7.28.0 — one handler for every board's Export CSV; the board key says which.
  registerAction('rankings-export-csv',        (e, el) => exportRankingsCsv(el.dataset.boardKey));
  registerAction('rankings-open-participant',  (e, el) => adminShowParticipant(el.dataset.nickname));
  registerAction('rankings-open-group',        (e, el) => adminShowGroup(el.dataset.groupName));

  registerAction('leaderboard-refresh',        () => loadAdminLeaderboard());

  registerAction('logs-set-stream',            (e, el) => setAdminLogsStream(el.dataset.stream));
  registerAction('log-details',                (e, el) => showLogDetails(e, el)); // audit v7.7.33 (AL14)

  registerInput('logs-search',                 (e, el) => { S._logsQuery = el.value || ''; toggleSearchClear(el); clearTimeout(S._logsSearchDebounce); S._logsSearchDebounce = setTimeout(() => { _logsFirstPage(); }, 250); });

  registerAction('logs-search-clear',          () => { clearSearch('logs-search'); S._logsQuery = ''; _logsFirstPage(); });

  registerChange('logs-set-group',             (e, el) => { S._logsGroupFilter = el.value || ''; _logsFirstPage(); });

  registerChange('logs-page-size',             (e, el) => logsPageSize(el));

  registerAction('logs-page-first',            () => _logsFirstPage());

  registerAction('logs-page-prev',             () => logsPageStep(-1));

  registerAction('logs-page-next',             () => logsPageStep(1));

  registerAction('logs-page-last',             () => logsPageLast());

  registerAction('logs-sort',                  (e, el) => sortAdminLogs(el.dataset.col));

  // v7.25.0 — ±10 and jump-to-page. The ±10 pair clamps against the pager's own
  // count (features/settings-admin.js, the shared segment pager), never against
  // a DOM attribute: a silent poll can land a newer body without re-rendering
  // the bar.
  registerAction('logs-page-back10',            () => logsPageStep(-10));

  registerAction('logs-page-fwd10',             () => logsPageStep(10));

  // Registered in BOTH registries: the Go button fires an action, and the
  // input's native `change` (Enter, or blur) fires a change. They are separate
  // maps, and _logsGoToPage is a no-op on an empty box so the two cannot
  // double-fire into a spurious error.
  registerAction('logs-page-goto',              () => _logsGoToPage());
  registerChange('logs-page-goto',              () => _logsGoToPage());

  registerAction('invite-submit',              () => submitInvitations());

  registerAction('bulk-assign-next',           () => bulkAssignNext());

  registerAction('bulk-assign-back',           () => { S.bulkAssignStep = 1; renderBulkAssign(); });

  registerAction('bulk-assign-execute',        () => executeBulkAssign());

  registerAction('import-conflict-check',      () => proceedToConflictCheck());

  registerAction('import-conflict-execute',    (e, el) => executeConflictImport(el.dataset.importType));

  registerAction('import-conflict-set-all',    (e, el) => setAllConflictResolutions(el.dataset.resolution));




  registerAction('session-warn-logout',        () => _sessionWarnLogoutNow());

  registerAction('session-warn-stay',          () => _sessionWarnStayLoggedIn());

  // v7.16.0 — operator IP-ban alert. "Dismiss" clears it for this admin only;
  // the global variant is superadmin-only and the server enforces that (403),
  // so the button is merely the affordance for a decision the server owns.
  registerAction('admin-alert-dismiss',        (e, el) => _ackAdminAlert(el.dataset.alertId, 'self'));

  registerAction('admin-alert-dismiss-global', (e, el) => _ackAdminAlertGlobal(el.dataset.alertId));

  registerAction('avatar-select',              (e, el) => selectAvatar(el.dataset.avatar, el));

  registerAction('request-reminder',           (e, el) => requestReminder(el.dataset.compId));

  registerAction('admin-profile-save',         (e, el) => saveAdminProfile(el.dataset.userId));

  registerAction('admin-tab',                  (e, el) => adminTab(el, el.dataset.tabId));

  registerAction('bulk-approve-users',         () => bulkApproveUsers());

  registerAction('bulk-add-to-group',          () => bulkAddToGroup());

  registerAction('group-create',               () => createGroupDialog());

  registerAction('group-manage-members',       (e, el) => manageGroupMembers(el.dataset.groupId, el.dataset.groupName));

  registerAction('group-bind-comps',           (e, el) => manageGroupCompetitions(el.dataset.groupId, el.dataset.groupName));

  registerAction('group-rename',               (e, el) => renameGroupDialog(el.dataset.groupId, el.dataset.groupName));

  registerAction('group-delete',               (e, el) => deleteGroup(el.dataset.groupId, el.dataset.groupName));

  registerAction('close-task-form',            () => closeTaskForm());


  registerAction('do-login',                   () => doLogin());

  registerAction('do-register',                () => doRegister());

  registerAction('export-participants',        () => exportParticipants());

  registerAction('export-participants-csv',    () => exportParticipantsCSV());

  registerAction('export-tasks',               () => exportTasks());

  registerAction('filter-tasks',               (e, el) => filterTasks(el, el.dataset.filter));


  registerAction('open-add-tasks-to-competition', () => openAddTasksToCompetition());

  // + New Event opens the New event page (blank starters and templates); a
  // starter opens the one create form with its kind selected.
  registerAction('open-competition-form',      () => openNewEventPage());
  registerAction('new-event-start',            (e, el) => openCompetitionForm(null, { kind: el.dataset.kind }));
  registerChange('comp-kind-select',           (e, el) => compKindSelect(el));

  registerAction('open-invite-dialog',         () => openInviteDialog());

  registerAction('open-task-form',             () => openTaskForm());

  registerAction('remove-cxone-settings',      () => removeCxOneSettings());

  registerAction('save-cxone-settings',        () => saveCxOneSettings());

  registerAction('save-platform-name',         () => savePlatformName());
  registerAction('save-breakglass-username',   () => saveBreakglassUsername());
  registerChange('save-require-approval',     () => saveRequireApproval());

  registerAction('unsub-remove',               (e, el) => removeUnsubscribedEmail(el.dataset.email));
  // v8.12.7 — Checkmarx One account removals (superadmin card + header banner).
  registerAction('cxone-withdrawals-review',   () => openCxoneWithdrawalsReview());
  registerAction('cxone-withdrawals-reload',   () => loadCxoneWithdrawals());   // one caller, no poll
  registerAction('cxone-withdrawal-retry',     (e, el) => retryCxoneWithdrawal(el.dataset.id, false));
  registerAction('cxone-withdrawal-override',  (e, el) => retryCxoneWithdrawal(el.dataset.id, true));
  registerAction('cxone-withdrawal-dismiss',   (e, el) => dismissCxoneWithdrawal(el.dataset.id));
  // The Settings two-pane shell: the section list, its phone picker, and the
  // sections' own controls (Email, retention, alerts, link items, health).
  registerAction('settings-section',           (e, el) => _ns22.selectSettingsSection(el.dataset.section, { focus: true }));
  registerChange('settings-section-pick',      (e, el) => _ns22.settingsPick(el.value));
  registerAction('settings-link',              (e, el) => _ns22.openSettingsLink(el.dataset.settingsLink));
  registerAction('settings-open-cxone-audit',  () => _ns22.openCxoneAudit());
  registerAction('settings-health-retry',      () => _ns22.loadSystemHealthCard());
  registerAction('send-test-email',            () => _ns22.sendTestEmail());
  registerAction('settings-retention-reload',  () => _ns22.loadRetentionCard());   // one caller, no poll
  registerAction('settings-alerts-reload',     () => _ns22.loadAlertsCard());      // one caller, no poll
  registerAction('settings-alert-open',        (e, el) => _ns22.openSettingsAlert(el.dataset.id));

  registerAction('save-task',                  (e, el) => saveTask(el.dataset.status || undefined));

  registerAction('set-comp-filter',            (e, el) => setCompFilter(el, el.dataset.value));
  registerAction('set-comp-other-filter',      (e, el) => setCompOtherFilter(el, el.dataset.value)); // v8.12.0 — a staff member's second picker section

  registerAction('set-p-status-filter',        (e, el) => setPStatusFilter(el, el.dataset.value));

  registerAction('set-solve-filter',           (e, el) => setSolveFilter(el, el.dataset.value));

  registerAction('sort-admin-tasks',           (e, el) => sortAdminTasks(el.dataset.col));

  registerAction('sort-competitions',          (e, el) => sortCompetitions(el.dataset.col));

  registerAction('sort-participants',          (e, el) => sortParticipants(el.dataset.col));

  registerAction('sort-submissions',           (e, el) => sortSubmissions(el.dataset.col));

  registerAction('sort-leaderboard',           (e, el) => sortLeaderboard(el.dataset.col));

  registerAction('sort-leaderboard-group',     (e, el) => sortLeaderboardGroup(el.dataset.col));
  registerAction('sort-leaderboard-late',      (e, el) => sortLeaderboardLate(el.dataset.col));

  registerAction('sort-rankings',              (e, el) => sortRankings(el.dataset.key, el.dataset.col));


  registerAction('toggle-comp-filter',         (e, el) => toggleCompFilter(el));
  registerAction('toggle-comp-kind-filter',    (e, el) => toggleCompKindFilter(el));

  registerAction('toggle-task-diff-filter',    (e, el) => toggleTaskDiffFilter(el));

  registerAction('toggle-task-state-filter',   (e, el) => toggleTaskStateFilter(el));

  registerAction('toggle-task-status-filter',  (e, el) => toggleTaskStatusFilter(el));

  registerAction('click-hidden-input',         (e, el) => document.getElementById(el.dataset.targetId)?.click());

  registerInput('comp-search',                 () => { const el = document.getElementById('comp-search'); if (el) toggleSearchClear(el); clearTimeout(S._compSearchDebounce); S._compSearchDebounce = setTimeout(() => { S.cPage = 1; renderAdminCompetitions(); }, 160); });

  registerInput('groups-search',               () => { const el = document.getElementById('groups-search'); if (el) toggleSearchClear(el); clearTimeout(S._groupsSearchDebounce); S._groupsSearchDebounce = setTimeout(() => { S.gPage = 1; renderAdminGroups(); }, 160); });

  registerInput('task-search',                 () => { const el = document.getElementById('task-search'); if (el) toggleSearchClear(el); clearTimeout(S._taskSearchDebounce); S._taskSearchDebounce = setTimeout(() => { S.tPage = 1; renderAdminTasks(); }, 160); });

  registerInput('participants-search',         () => {
    const el = document.getElementById('participants-search');
    if (el) toggleSearchClear(el);
    // v8.8.11 — ONE branch. The other one existed because a focused pane fetched
    // the picker and got the oldest 500 non-members, so the client-side filter
    // could not see anyone past the cap and a server-side LIKE refetch was the
    // only way to find them. The model is complete for both tiers now, and the
    // client filter is STRICTLY WIDER than that refetch ever was — 17 sources
    // here against the server's six-column LIKE — so the refetch would find
    // strictly less. It also removed a membership asymmetry nobody chose:
    // non-members were searchable by six fields and members by everything.
    clearTimeout(S._partSearchDebounce);
    S._partSearchDebounce = setTimeout(() => { S.pPage = 1; renderParticipants(); }, 160);
  });

  registerInput('submissions-search',          () => { onSubmissionsSearchInput(); const el = document.getElementById('submissions-search'); if (el) toggleSearchClear(el); });

  registerAction('comp-search-clear',          () => clearSearch('comp-search', () => { S.cPage = 1; renderAdminCompetitions(); }));

  registerAction('groups-search-clear',        () => clearSearch('groups-search', () => { S.gPage = 1; renderAdminGroups(); }));

  // v7.20.7 — analytics per-challenge table: search + paging. renderAnalytics()
  // re-reads the cached response, so no refetch is needed for either.
  // The last response is already cached on _analyticsState, so search and paging
  // re-render from it — no refetch, and no round trip per click.
  const _anRerender = () => { const d = _analyticsState.lastResponse; if (d) renderAnalyticsTable(d); };

  registerInput('analytics-search',            () => { const el = document.getElementById('analytics-search'); if (el) toggleSearchClear(el); clearTimeout(S._anSearchDebounce); S._anSearchDebounce = setTimeout(() => { S._anPage = 1; _anRerender(); }, 160); });

  registerAction('analytics-search-clear',     () => clearSearch('analytics-search', () => { S._anPage = 1; _anRerender(); }));

  // v7.24.0 — exports the whole FILTERED set from the cached response, in the
  // order the table is showing. Purely synchronous, so it needs no error path
  // of its own beyond the two toasts inside it (the dispatcher's try/catch is
  // synchronous-only and would not cover an async handler).
  registerAction('analytics-export-csv',       () => exportAnalyticsCsv());

  // v7.20.7 — unsubscribed-address search. loadUnsubscribeList() re-fetches,
  // which is fine here: the list is small, admin-only, and rarely opened.
  registerInput('unsub-search',                () => { const el = document.getElementById('unsub-search'); if (el) toggleSearchClear(el); clearTimeout(S._unsubSearchDebounce); S._unsubSearchDebounce = setTimeout(() => loadUnsubscribeList(), 160); });

  registerAction('unsub-search-clear',         () => clearSearch('unsub-search', () => loadUnsubscribeList()));

  // v7.20.8 — expand/collapse a rankings board. Re-renders from the cache.
  registerAction('rankings-toggle-more',       (e, el) => _rkToggleExpanded(el.dataset.boardKey));

  registerAction('analytics-page-first',       () => { S._anPage = 1; _anRerender(); });

  registerAction('analytics-page-prev',        () => { S._anPage--; _anRerender(); });

  registerAction('analytics-page-next',        () => { S._anPage++; _anRerender(); });

  registerAction('analytics-page-last',        (e, el) => { S._anPage = parseInt(el.dataset.totalPages, 10); _anRerender(); });

  registerChange('analytics-page-size',        (e, el) => { S._anPageSize = parseInt(el.value, 10); S._anPage = 1; _anRerender(); });

  // v7.19.0 — multiple-choice editor.
  registerAction('task-add-choice',            () => tfAddChoice());

  registerAction('task-choice-remove',         (e, el) => tfRemoveChoice(parseInt(el.dataset.idx, 10)));

  registerInput('task-choice-text',            (e, el) => tfSetChoiceText(parseInt(el.dataset.idx, 10), el.value));

  registerChange('task-choice-correct',        (e, el) => tfSetChoiceCorrect(parseInt(el.dataset.idx, 10), el.checked));

  registerChange('task-answer-type',           () => tfSyncAnswerType());
  // v8.10.1 — ticking the seal takes the free-response answer type away, so the
  // checkbox has to announce its own change; without this the gate is
  // one-directional and the author reaches a save the server refuses.
  registerChange('task-seal-toggle',            () => tfSyncAnswerType());
  // v8.17.0 — the compact editor: segmented difficulty and its collapsible rows.
  registerChange('task-diff-seg',               (e, el) => _ns7.tfSetDifficulty(el.value));
  registerAction('task-sec-toggle',             (e, el) => _ns7.tfToggleSection(el));

  // v8.9.0 — additional accepted answers (text challenges).
  registerAction('task-add-answer',            () => tfAddExtraAnswer());

  registerAction('task-extra-answer-remove',   (e, el) => tfRemoveExtraAnswer(parseInt(el.dataset.idx, 10)));

  registerInput('task-extra-answer-text',      (e, el) => tfSetExtraAnswer(parseInt(el.dataset.idx, 10), el.value));

  // v7.17.2 — import "Select Participants" picker paging. A real import file
  // runs to thousands of rows; it rendered every one on every keystroke.
  registerAction('import-p-page-first',        () => { S._importPPage = 1; renderImportParticipantRows(); });

  registerAction('import-p-page-prev',         () => { S._importPPage--; renderImportParticipantRows(); });

  registerAction('import-p-page-next',         () => { S._importPPage++; renderImportParticipantRows(); });

  registerAction('import-p-page-last',         (e, el) => { S._importPPage = parseInt(el.dataset.totalPages, 10); renderImportParticipantRows(); });

  registerAction('task-search-clear',          () => clearSearch('task-search', () => { S.tPage = 1; renderAdminTasks(); }));

  registerAction('participants-search-clear',  () => clearSearch('participants-search', () => {
    S.pPage = 1;
    // v8.8.11 — nothing to re-fetch: the model was never server-side-filtered.
    renderParticipants();
  }));

  registerAction('submissions-search-clear',   () => clearSearch('submissions-search', () => { S.subPage = 1; loadAdminSubmissions(); }));

  registerChange('update-assign-save-btn',     () => updateAssignSaveBtn());

  registerChange('comp-form-dur-changed',      () => compFormDurChanged());

  registerChange('comp-form-deadline-changed', () => compFormDeadlineChanged());
  registerChange('toggle-no-deadline',         () => toggleNoDeadline());
  // v8.6.0 — late entries: the feature toggle shows/hides the deadline block, and
  // the Automatic toggle fills-and-disables the pair rather than blanking it.
  registerChange('toggle-late-entry',          () => toggleLateEntry());
  registerChange('toggle-late-auto',           () => toggleLateAuto());
  // v8.6.3 — the manual deadline pair had NO handler, so typing a date left the
  // sentence beneath it describing the previous one.
  registerChange('comp-form-late-deadline-changed', () => compFormLateDeadlineChanged());

  registerChange('comp-form-update-end-time',  () => compFormUpdateEndTime());

  registerChange('session-form-dur-changed',   (e, el) => sessionFormDurChanged(el));

  registerChange('session-form-end-changed',   (e, el) => sessionFormEndChanged(el));

  registerChange('session-form-update-end',    (e, el) => sessionFormUpdateEnd(el));

  registerChange('toggle-comp-form-mode',      () => toggleCompFormMode());
  registerChange('toggle-cxone-disabled',      () => toggleCxoneDisabled());
  registerChange('comp-reg-field-changed',     (e, el) => compRegFieldChanged(el));

  registerChange('update-adp-timezones',       () => updateAdpTimezones());

  registerChange('update-profile-timezones',   () => updateProfileTimezones());

  registerChange('update-timezones',           () => { updateTimezones(); autoFillDialCode('reg-country', 'reg-phone'); paintRegLocation(); });

  registerChange('update-reg-city',            () => { _autoFillCityFromTz(); paintRegLocation(); });
  registerAction('reg-location-change',        () => regLocationChange());

  // The sign-up name fields still name this input action, and nothing derives
  // from them in the browser: the nickname is not asked at sign-up (the server
  // suggests one). A no-op, so the delegated listener finds a handler.
  registerInput('reg-name-input',              () => {});

  registerChange('update-task-picker-count',   () => updateTaskPickerCount());

  registerChange('on-conflict-res-change',     (e, el) => onConflictResChange(parseInt(el.dataset.index, 10)));

  registerChange('toggle-all-import-participants', (e, el) => toggleAllImportParticipants(el.checked));

  registerChange('toggle-import-participant',  (e, el) => toggleImportParticipant(parseInt(el.dataset.index, 10), el.checked));

  registerChange('toggle-all-participants',    (e, el) => toggleAllParticipants(el.checked));

  registerChange('import-participants-file',   (e, el) => importParticipantsFile(el));

  registerChange('import-tasks-file',          (e, el) => importTasksFile(el));

  registerInput('render-import-participants-rows', () => { S._importPPage = 1; renderImportParticipantRows(); });  // v7.17.2 — a new query starts at page 1


  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const el = ev.target?.closest && ev.target.closest('[data-enter-click-id]');
    if (!el) return;
    document.getElementById(el.dataset.enterClickId)?.click();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const el = ev.target?.closest && ev.target.closest('[data-enter-action]');
    if (!el) return;
    const fn = _actionHandlers[el.dataset.enterAction];
    if (fn) fn(ev, el);
  });

  document.addEventListener('mouseenter', (ev) => {
    const el = ev.target?.closest && ev.target.closest('[data-mouseenter-action]');
    if (!el) return;
    const fn = _actionHandlers[el.dataset.mouseenterAction];
    if (fn) fn(ev, el);
  }, true);

  document.addEventListener('mouseleave', (ev) => {
    const el = ev.target?.closest && ev.target.closest('[data-mouseleave-action]');
    if (!el) return;
    const fn = _actionHandlers[el.dataset.mouseleaveAction];
    if (fn) fn(ev, el);
  }, true);

  registerAction('stars-hover',                (e, el) => hoverStars(el.parentNode, parseInt(el.dataset.value, 10)));

  registerAction('stars-reset',                (e, el) => resetStars(el));

  document.addEventListener('copy', (ev) => { if (ev.target?.closest?.('[data-block-clipboard]')) ev.preventDefault(); });

  document.addEventListener('cut',  (ev) => { if (ev.target?.closest?.('[data-block-clipboard]')) ev.preventDefault(); });

  // v7.2.x (audit) — duplicate registerChange('subs-page-size') removed (already registered ~line 420).

  _endedPopupChannel?.addEventListener('message', e => {
    if (e.data && e.data.compId && e.data.compId === S.currentCompetitionId) { S._endedPopupSeen = true; S._endedPopupShownFor = e.data.compId; }
  });

  if(!window._modalEscStack){
    window._modalEscStack=[];
    document.addEventListener('keydown',(e)=>{
      if(e.key!=='Escape'||!window._modalEscStack.length)return;
      // Don't steal Escape from nested input widgets (datepicker, select
      // popovers). If the focused element is inside the overlay but has
      // its own open-popover state, the widget will have handled Escape
      // already via stopPropagation. We fire the close callback only if
      // no preceding handler called preventDefault.
      if(e.defaultPrevented)return;
      const top=window._modalEscStack[window._modalEscStack.length-1];
      if(top)top();
    });
  }

  registerAction('open-attach-picker',     ()=>_openAttachPicker());

  registerAction('cancel-attach-upload',   ()=>_closeAttachPicker());

  registerAction('confirm-attach-upload',  ()=>_uploadAttachmentNow());

  registerAction('attach-rename',          (_e,el)=>_renameSavedAttachment(el.dataset.taskId,el.dataset.aid,el.dataset.current));

  registerAction('attach-delete',          (_e,el)=>_deleteSavedAttachment(el.dataset.taskId,el.dataset.aid,el.dataset.name));

  registerAction('staging-attach-rename',  (_e,el)=>_renameStagingAttachment(el.dataset.stagingId,el.dataset.current));

  registerAction('staging-attach-delete',  (_e,el)=>_deleteStagingAttachment(el.dataset.stagingId,el.dataset.name));

  ['mousedown','mousemove','keydown','scroll','click','touchstart','wheel'].forEach(evt=>{
    window.addEventListener(evt,()=>{_sessionMon.lastActivityAt=Date.now();},{passive:true});
  });

  // v8.1.0 (PR 34) — INTENT, which is a stricter signal than ACTIVITY.
  //
  // `lastActivityAt` above answers "is this tab alive?" and is what keeps a
  // session from expiring while someone reads. Net active time needs a harder
  // question — "is a human DOING something?" — because the number it feeds
  // breaks score ties, and a measurement that a stationary trackpad can inflate
  // is not a measurement.
  //
  // THE 40 px DISPLACEMENT GATE is the whole difference. A `mousemove` fires for
  // a one-pixel jitter, a scroll-wheel nudge under a resting hand, or a cursor
  // drifting as a laptop is carried — none of which is someone taking part. Real
  // interaction moves the pointer a long way. Every other event in the list is
  // unambiguous intent and needs no gate: you cannot accidentally type or tap.
  (function trackIntent(){
    const MIN_MOVE_PX=40;
    let lx=null,ly=null,moved=0;
    const intent=()=>{S._lastIntentAt=Date.now();};
    ['keydown','click','touchstart','wheel','scroll'].forEach(evt=>{
      window.addEventListener(evt,intent,{passive:true});
    });
    window.addEventListener('mousemove',(e)=>{
      if(lx!==null){
        moved+=Math.abs(e.clientX-lx)+Math.abs(e.clientY-ly);
        // Cumulative, not per-event: a slow deliberate drag across the screen is
        // intent even though no single event clears the bar.
        if(moved>=MIN_MOVE_PX){moved=0;intent();}
      }
      lx=e.clientX;ly=e.clientY;
    },{passive:true});
  })();

  (function populateCountries(){
    const sel=document.getElementById('reg-country');
    if(!sel)return;
    Object.keys(COUNTRY_TZ).sort((a,b)=>COUNTRY_TZ[a].n.localeCompare(COUNTRY_TZ[b].n)).forEach(code=>{
      const o=document.createElement('option');o.value=code;o.textContent=COUNTRY_TZ[code].n;sel.appendChild(o);
    });
    autoDetectCountryTz('reg-country','reg-tz',updateTimezones);
  })();

  registerChange('toggle-job-function-other',()=>toggleJobFunctionOther());

  (async()=>{
    // v7.15.5 — theme-boot.js may have set html.booting-authed before first
    // paint (an app-initiated reload: impersonation enter/exit, role change) so
    // the spinner shows instead of a login screen the user is not actually
    // looking at. Clear it once routing has settled, whichever branch we take.
    // The watchdog is the important half: a throw anywhere below would otherwise
    // leave the class on and the app permanently blank behind a spinner, which
    // is far worse than the flash it replaces. Fail open, always.
    // The mask is lifted by showPage()/showMain() — i.e. the moment the app
    // actually routes somewhere — so every branch below clears it without a
    // try/finally around 150 lines. This watchdog is the fail-open backstop: if
    // boot throws before routing, an 8 s spinner is bad but a permanently blank
    // app behind a stuck spinner is far worse than the flash this replaces.
    setTimeout(()=>{try{document.documentElement.classList.remove('booting-authed');}catch(e){console.warn('Could not lift the boot mask',e);}},8000);
    await Promise.all([loadCsrfToken(),loadPlatformName()]);
    // v6.9.10: popstate keeps the screen in sync with the URL when the
    // user hits browser back/forward between /register and /. Only
    // honoured while the user is anonymous — once they've authenticated
    // we hand control back to the SPA's own navigation. Gate on a real
    // pathname change: Chrome fires popstate for same-document fragment
    // navigations too (e.g. clicking `<a href="#">` on the login page
    // flips location.hash), so without the gate the handler would
    // override the intended in-SPA transition (v6.9.11 — "Forgot
    // password?" was reverting back to the login page because of this).
    let _lastPathname = location.pathname;
    window.addEventListener('popstate', () => {
      const newPath = location.pathname;
      if (newPath === _lastPathname) return;
      _lastPathname = newPath;
      if (S.currentUser) return;
      // /register is the email step too: the form needs a proven address.
      if (newPath === '/register' || newPath === '/') showPage('login-page');
    });
    // v6.21.0 — self-enrollment link: /join/<token> (canonical) or ?join=<token>.
    // Stash the token, immediately strip it from the URL (keeps the secret out of
    // browser history + the Referer header), and fetch a preview so the login /
    // register screens can show which competition the user is joining. Actual
    // enrollment happens after authentication (existing user) or first login
    // (new registrant). Runs before the invitation check.
    {
      const _jm=location.pathname.match(/^\/join\/([^/?#]+)/);
      const _jq=new URLSearchParams(location.search).get('join');
      const _jt=(_jm&&_jm[1])||_jq||'';
      if(_jt){
        S._pendingJoinToken=_jt;
        // Remember we arrived via a /join event link so an anonymous visitor lands
        // on the SIGN-UP form (the expected destination for a live event) even if
        // the preview can't resolve the competition — independent of the token.
        S._arrivedViaJoin=true;
        // v7.22.8 — provenance: this token came from a URL CLICK on this load
        // (an explicit intent signal), as opposed to a rehydrated stored token.
        // The authenticated-boot auto-join below is gated on it for non-
        // participant roles.
        S._joinFromUrl=true;
        if(location.pathname!=='/'||location.search)history.replaceState({},'','/');
        try{
          const pr=await fetch('/api/competitions/self-enroll/'+encodeURIComponent(_jt));
          if(pr.ok){
            S._pendingJoinComp=await pr.json();
            // v7.22.8 — persist the pending join so a visitor who abandons
            // sign-up and later returns via the HOMEPAGE (the reported
            // live-event failure) is still recognised. Expires at the
            // competition's effective end; see features/self-enroll.js.
            storePendingJoin(_jt,S._pendingJoinComp);
          }
          else{
            // The link can't be previewed — self-enrollment isn't enabled yet, or
            // the competition ended. Drop the token so registration doesn't submit
            // a dead joinToken, but DON'T show a scary "invalid" toast or fall
            // through to the sign-in page: an event visitor still lands on sign-up
            // (S._arrivedViaJoin), they just won't be auto-enrolled.
            // v7.22.8 — a 404 is the server's VERDICT (rotated / disabled /
            // ended): purge a stored copy of THIS token (a different stored
            // token stays — clicking a dead link B must not cost a valid A).
            // Any other non-OK (429 on the shared venue-NAT preview bucket, a
            // 5xx mid-deploy) is TRANSIENT: keep storage, or a blip would
            // convert into a permanent loss of the recovery (the v7.16.4 rule).
            S._pendingJoinToken='';S._pendingJoinComp=null;
            if(pr.status===404)clearStoredJoin(_jt);
          }
        }catch(_){
          // preview is best-effort; keep the token and try to join after auth.
          // v7.22.8 — store it too (24h fallback expiry, since the preview never
          // supplied the real end): a venue-wifi flake on the link click must
          // not cost the returning-visitor recovery.
          storePendingJoin(_jt,null);
        }
        _renderJoinBanner();
      }
    }
    // Handle invitation link (?invitation=...) — supported on both `/`
    // (legacy shape) and `/register` (v6.9.10).
    // Email first: the invited address is pre-filled on the entry screen, and the
    // code (bound to the invitation) opens the sign-up form.
    if(new URLSearchParams(location.search).get('invitation')){
      showPage('login-page');
      await checkInvitation();
      history.replaceState({},'','/');
      return;
    }
    // v7.22.8 — a RETURNING /join visitor: no token in this URL, but one may be
    // persisted from an earlier visit (they opened the event link, abandoned
    // sign-up, and came back via the homepage — previously that registered them
    // as a stray unapproved account with no competition). Rehydrate it,
    // revalidated against the preview endpoint, so every branch below — the
    // anonymous sign-up landing, doLogin's join, the authenticated boot join —
    // behaves as if the link had just been clicked.
    // Skipped when THIS load arrived via a join URL (handled above — and a DEAD
    // link must keep today's bannerless sign-up landing rather than surfacing a
    // different stored competition the visitor did not click) and on invitation
    // links (the block above returns early; an invitation blesses its own
    // competitions and must not be overlaid with a join banner).
    if(!S._pendingJoinToken&&!S._arrivedViaJoin)await rehydratePendingJoin();
    {
      // ANONYMOUS LOADS ASK FIRST. `GET /api/session/status` answers 200 for
      // everybody (active or not), so a signed-out visitor no longer pays two
      // 401s (`/api/me`, then `/api/admin/me`) in the console on every load. Only
      // an explicit `active:false` short-cuts; a failed or odd probe falls back
      // to the identity reads exactly as before.
      const _st=await fetch('/api/session/status').then(x=>x.ok?x.json():null).catch(()=>null);
      const _anon=!!(_st&&_st.active===false);
      const r=_anon?{ok:false,status:401,json:async()=>({})}:await fetch('/api/me');
      // Dedicated /register route (v6.9.10) — when anonymous, land on
      // the signup form directly. An authenticated caller who types
      // /register by hand falls through to their resumed-session flow
      // and the URL is rewritten to / so refresh stays on the app.
      // /register is the email step (email first): the sign-up form opens only
      // after a code proves an address that has no account.
      if(!r.ok && location.pathname==='/register'){
        history.replaceState({},'','/');
        showPage('login-page');
        return;
      }
      // An anonymous visitor arriving via a /join event link lands on the email
      // step with the join banner; the event rides the code they request.
      if(!r.ok && (S._pendingJoinToken || S._arrivedViaJoin)){
        _renderJoinBanner();
        showPage('login-page');
        return;
      }
      if(r.ok && location.pathname==='/register'){
        history.replaceState({},'','/');
      }
      if(r.ok){
        S.currentUser=await r.json();
        S.userRole=S.currentUser.userRole||'participant';
        // RBAC — the role and what it may do, known before either nav is built.
        S.roleInfo=S.currentUser.role_info||null;
        S.permissions=Array.isArray(S.currentUser.permissions)?S.currentUser.permissions:null;
        S.isUserStaff=!!S.currentUser.isStaff;
        startSessionMonitor();
        if(S.currentUser.isAdminView){
          S.isAdmin=true;S.isSuperAdmin=!!S.currentUser.isSuperAdmin;S.isEventAdmin=!!S.currentUser.isEventAdmin;S.isAdminView=true;
          // v8.12.1 — an ADMIN-SHAPED impersonation (an event admin's panel
          // opened through their seat) boots here. The banner goes up BEFORE
          // the nav is built, as on the participant branch: the Exit button
          // must exist before anything an admin might click (the v7.14.0
          // ordering). What the seat cannot do is withheld by the SERVER's
          // scoped rows and by the row menus; of the nav builders only the
          // Settings item (`settingsOffered`, ui/nav.js) reads `S.impersonation`.
          S.impersonation=S.currentUser.impersonation||null;
          if(S.impersonation)renderImpersonationBanner();
          buildAdminNav();showMain('admin-page');startAdminCompPoll();
          // v7.16.0 — re-arm the IP-ban alert poll now the admin flags are set.
          // startSessionMonitor() above already started it, but its first tick
          // ran before those flags existed and therefore skipped; this makes an
          // open ban visible on arrival rather than up to 20 s later.
          startAdminAlertPoll();
        }else{
          // v7.14.0 — impersonation mode: render the banner BEFORE the profile
          // gate can await (the Exit button must stay reachable above a
          // non-dismissible gate on an incomplete-profile target). The gate
          // itself still fires — seeing exactly what the participant sees is
          // the point of impersonation.
          S.impersonation=S.currentUser.impersonation||null;
          if(S.impersonation)renderImpersonationBanner();
          // v8.7.3 — `isEventAdmin` is a TIER, not a view, so it is carried on
          // this branch too. `isAdmin`/`isSuperAdmin` stay false here because
          // they describe the CURRENT VIEW (`/api/me` spells the view
          // `isAdminView`), but the tier flag must read the same whether an
          // event admin reached participant view by toggling down or by
          // reloading in it — otherwise one refresh silently changes what the
          // admin panel offers them on the way back up.
          S.isEventAdmin=!!S.currentUser.isEventAdmin;
          // PR B / F#5 — fire the profile-completion gate on EVERY authenticated
          // entry (a plain page refresh included), mirroring the sign-in path
          // (finishSignIn), so an account whose profile became incomplete while its
          // session lived (an organiser made a field required for the event it
          // registered through) is prompted on a reload, not only at its next
          // sign-in. select-competition's 400 stays the server-side backstop.
          if(S.currentUser.missing_fields?.length&&S.userRole==='participant'){
            await openProfileCompletionGate(S.currentUser.missing_fields);
            const freshMe=await fetch('/api/me').then(r=>r.ok?r.json():S.currentUser).catch(()=>S.currentUser);
            S.currentUser=freshMe;
            S.userRole=S.currentUser.userRole||'participant';
          }
          buildParticipantNav();
          refreshScore();
          // v6.21.0 — already-authenticated participant who arrived via a /join
          // link: enroll + route straight into that competition.
          // v7.22.8 — a REHYDRATED token (no URL click this load) auto-joins
          // PARTICIPANTS only: an admin who once opened the event link while
          // signed out must not be silently enrolled the next time they toggle
          // into participant view. A URL-clicked token keeps today's behaviour
          // for every role — the click is the intent.
          if(S._pendingJoinToken&&(S._joinFromUrl||S.userRole==='participant')){
            const _jid=await joinViaPendingToken();
            if(_jid){await enterAfterJoin(_jid);return;}
          }
          if(S.currentUser.competitionId){
            // Re-select competition to get fresh status, timeslots, etc.
            const result=await selectCompetition(S.currentUser.competitionId);
            if(result==='needsTimeslot'){
              S.myCompetitions=S.currentUser.competitions||[];
              showTimeslotPicker();
            }else if(result!==false){
              const _verdict=routeVerdict(result);
              // v8.12.0 — the list is set on EVERY branch, not only the two that
              // render from it: `currentCompetitionRow()` and the dry-run session
              // badge read it, and an auto-resume that lands straight in the event
              // used to leave it empty.
              S.myCompetitions=S.currentUser.competitions||[];
              if(_verdict==='enter'){
                showMain('tasks-page');enterCompetitionView();
              }else if(_verdict==='pending'){
                S.myCompetitions=S.currentUser.competitions||[];
                showPendingPageForCompetition();
              }else{
                S.myCompetitions=S.currentUser.competitions||[];
                showMain('competitions-page');
              }
            }else{
              showMain('competitions-page');
            }
          }else{
            showMain('competitions-page');
          }
        }
      }else{
        // Check if this is a built-in admin session (no userId)
        const ar=_anon?{ok:false,status:401}:await fetch('/api/admin/me');
        // Signed out with no join pending (the join returned above): no event's
        // look stays on.
        if(!ar.ok)_ns30.setEventLook(null);
        // Nor the signed-in header's first-paint hint (a stale `ha_shell` cookie,
        // ui/nav.js dropAppShellHint), but only on EVIDENCE that nobody is signed
        // in: the session check said so, or both identity reads answered 401. The
        // static login page is already showing, so no showPage drops it; when the
        // session check said nobody, nothing is awaited between its answer and
        // here. A signed-in session whose /api/me failed for a moment (5xx, the
        // address block's 429) also reaches this branch, as /api/admin/me answers
        // 401 to every session that is not an admin's: only /api/me's own 401
        // says nobody, so this one keeps the cookie, or the next good reload
        // would shift the page again. The other anonymous outcomes
        // (/register, a join, an invitation) go through showPage.
        if(!ar.ok&&(_anon||(r.status===401&&ar.status===401)))dropAppShellHint();
        if(ar.ok){
          const ad=await ar.json();
          S.isAdmin=true;S.isSuperAdmin=!!ad.isSuperAdmin;S.isEventAdmin=!!ad.isEventAdmin;S.isAdminView=true;
          S.isBreakglass=ad.isBreakglass===true;
          S.permissions=Array.isArray(ad.permissions)?ad.permissions:null;S.roleInfo=ad.role_info||null;
          // v8.12.1 — defensive twin of the /api/me branch: an impersonation
          // session always carries a userId (the target's), so it never lands
          // here, but the payload carries the block and the banner is cheap.
          S.impersonation=ad.impersonation||null;
          if(S.impersonation)renderImpersonationBanner();
          startSessionMonitor();
          buildAdminNav();showMain('admin-page');startAdminCompPoll();startAdminAlertPoll();
        }
      }
    }
  })();

  (function(){
    // Mouse drag-to-scroll
    document.addEventListener('mousedown',function(e){
      const card=e.target.closest('#admin-page .table-card');
      if(!card||e.button!==0)return;
      if(e.target.closest('a,button,input,select,textarea,[contenteditable]'))return;
      e.preventDefault();
      card.classList.add('dragging');
      const startX=e.clientX,startY=e.clientY;
      const scrollL=card.scrollLeft,scrollT=card.scrollTop;
      function onMove(ev){
        card.scrollLeft=scrollL-(ev.clientX-startX);
        card.scrollTop=scrollT-(ev.clientY-startY);
      }
      function onUp(){
        card.classList.remove('dragging');
        document.removeEventListener('mousemove',onMove);
        document.removeEventListener('mouseup',onUp);
      }
      document.addEventListener('mousemove',onMove);
      document.addEventListener('mouseup',onUp);
    });
    // Touch drag-to-scroll
    document.addEventListener('touchstart',function(e){
      const card=e.target.closest('#admin-page .table-card');
      if(!card)return;
      if(e.target.closest('a,button,input,select,textarea,[contenteditable]'))return;
      const touch=e.touches[0];
      const startX=touch.clientX,startY=touch.clientY;
      const scrollL=card.scrollLeft,scrollT=card.scrollTop;
      let moved=false;
      function onMove(ev){
        const t=ev.touches[0];
        card.scrollLeft=scrollL-(t.clientX-startX);
        card.scrollTop=scrollT-(t.clientY-startY);
        moved=true;
      }
      function onEnd(){
        document.removeEventListener('touchmove',onMove);
        document.removeEventListener('touchend',onEnd);
      }
      document.addEventListener('touchmove',onMove,{passive:true});
      document.addEventListener('touchend',onEnd);
    },{passive:true});
  })();

  registerAction('analytics-open-comp-picker', () => {
    // The shared order of every admin event picker: live first, then upcoming by
    // soonest start, then ended by latest start.
    const comps = (S._analyticsCompCache || []).slice().sort(compareCompsForPicker);
    _analyticsClosePicker();
    const ov = document.createElement('div');
    ov.id = 'analytics-picker-overlay';
    ov.className = 'picker-overlay';
    const cards = comps.map(c => {
      const cat = compDisplayCategory(c);
      const cls = 'comp-' + cat;
      const label = COMP_CATEGORY_LABEL[cat] || 'Ended';
      const start = new Date(c.start_time);
      const isCur = _analyticsState.competitionId === c.id;
      const isInt = (c.tags||[]).includes(DRY_RUN_TAG);
      const intBadge = isInt ? `<span class="badge draft" style="font-size:var(--fs-12);margin-left:4px" title="Marked as a test / dry run — excluded from analytics by default">${DRY_RUN_TAG}</span>` : '';
      // v7.20.11 — competitions carry TAGS, and an operator searching this
      // picker by tag found nothing: the card rendered none of them (bar the
      // `internal` badge, which matched only by accident) and the filter read
      // the card's text. Show the first few, and put the FULL set in
      // `data-search` so a tag that did not fit is still findable.
      const allTags = c.tags || [];
      const tagHtml = allTags.slice(0, 3).map(tg => `<span class="tag">${esc(tg)}</span>`).join('');
      return `<button type="button" class="picker-card ${isCur ? 'picker-card-active' : ''}" data-action="analytics-pick-comp" data-comp-id="${esc(c.id)}" data-search="${esc(allTags.join(' '))}" ${isInt?'data-dry-run="1"':''}>
        <div class="picker-card-head">
          <span class="picker-card-name">${esc(c.name)}</span>
          <span class="badge comp-badge ${esc(cls)}">${esc(label)}</span>${intBadge}
        </div>
        <div class="picker-card-meta">${esc(fmtDt(start,'short'))} · ${c.duration_minutes} min</div>
        ${tagHtml ? `<div class="picker-card-meta">${tagHtml}</div>` : ''}
      </button>`;
    }).join('');
    setSafeHtml(ov, `
      <div class="picker-modal">
        <div class="picker-modal-head">
          <h3>Pick an event</h3>
          <input type="search" placeholder="Search by name or tag…" aria-label="Search events by name or tag" id="analytics-comp-search" class="filter-select" style="max-width:240px"/>
          <button type="button" class="link-btn" data-action="analytics-close-picker">Close</button>
        </div>
        <div class="picker-grid" id="analytics-comp-grid">
          ${cards || '<p style="color:var(--muted)">No events exist yet.</p>'}
        </div>
      </div>`);
    document.body.appendChild(ov);
    // Escape closes (topmost-overlay stack) + focus trap + dialog ARIA.
    overlayDismiss(ov, () => _analyticsClosePicker());
    // v7.17.2 — the same live filter the CHALLENGE picker has had. This grid is
    // every competition ever run, at any status, so on a mature instance it is
    // the longest picker in the admin panel and was the only one with no way to
    // narrow it. Filtering hides cards rather than re-rendering them, so the
    // selected-card state and the focus ring survive keystrokes for free.
    // v7.20.11 — the shared filter, replacing a hand-rolled near-copy of it.
    // That copy reported no match count (the operator could not tell a narrow
    // search from a short list) and, because `wirePickerFilter` also reads
    // `data-search`, routing through it is what makes TAGS findable here.
    wirePickerFilter(ov, 'analytics-comp-search', '.picker-card', {
      emptyText: 'No events match that search.',
      noun: 'event',
    });
    const compSearch = document.getElementById('analytics-comp-search');
    if (compSearch) compSearch.focus();
    else (ov.querySelector('.picker-card') || ov.querySelector('[data-action="analytics-close-picker"]'))?.focus();
  });

  registerAction('analytics-pick-comp', (e, el) => {
    _analyticsState.competitionId = el.dataset.compId;
    _analyticsState.timeslotId = null;
    const comp = (S._analyticsCompCache||[]).find(c => c.id === el.dataset.compId);
    if ((comp?.tags||[]).includes(DRY_RUN_TAG)) {
      const cf = _analyticsState.compTagFilter;
      if (cf.mode === 'exclude' && cf.tags.includes(DRY_RUN_TAG)) {
        cf.mode = 'none'; cf.tags = [];
      }
    }
    _analyticsClosePicker();
    renderAnalyticsFilterBar();
    _analyticsScheduleRefetch();
  });

  registerAction('analytics-close-picker', () => _analyticsClosePicker());

  registerAction('analytics-open-task-picker', () => {
    const tasks = (S._analyticsTaskCache || []).slice();
    // Sort: alphabetical by title for predictability; show selected first.
    const sel = new Set(_analyticsState.taskIds);
    tasks.sort((a, b) => {
      const sa = sel.has(a.id) ? 0 : 1, sb = sel.has(b.id) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return (a.title || '').localeCompare(b.title || '');
    });
    _analyticsClosePicker();
    const ov = document.createElement('div');
    ov.id = 'analytics-picker-overlay';
    ov.className = 'picker-overlay';
    const cards = tasks.map(t => {
      const isCur = sel.has(t.id);
      // v7.20.11 — `task_number` is a property of the (task, competition) PAIR and
      // lives on `competitions[].task_number`; GET /api/admin/tasks never puts one
      // at the top level, so this span never rendered. A challenge in three
      // competitions has three numbers and this picker spans all of them, so there
      // is no single number to show — the search copy no longer claims otherwise.
      const num = '';
      // v7.20.11 — the card shows only the first three tags, so the rest go in
      // `data-search` alongside the difficulty: a challenge you can see a tag on
      // must be findable by it, and one whose fourth tag did not fit must be too.
      const allTags = t.tags || [];
      const tags = allTags.slice(0, 3).map(tg => `<span class="tag">${esc(tg)}</span>`).join('');
      return `<button type="button" class="picker-card ${isCur ? 'picker-card-active' : ''}" data-action="analytics-toggle-task" data-task-id="${esc(t.id)}" data-search="${esc([...allTags, t.difficulty || ''].join(' '))}">
        <div class="picker-card-head">
          ${num}<span class="picker-card-name">${esc(t.title)}</span>
          ${t.difficulty ? `<span class="badge ${esc(t.difficulty)}">${esc(t.difficulty)}</span>` : ''}
        </div>
        ${tags ? `<div class="picker-card-meta">${tags}</div>` : ''}
        <div class="picker-card-checkmark">${isCur ? ICO.check : ''}</div>
      </button>`;
    }).join('');
    setSafeHtml(ov, `
      <div class="picker-modal picker-modal-wide">
        <div class="picker-modal-head">
          <h3>Pick challenges</h3>
          <input type="search" placeholder="Search by title, difficulty or tag…" aria-label="Search challenges by title, difficulty or tag" id="analytics-task-search" class="filter-select" style="max-width:240px"/>
          <div style="display:flex;gap:8px">
            ${_analyticsState.taskIds.length ? `<button type="button" class="btn sm secondary" data-action="analytics-clear-tasks-and-close">Clear (${_analyticsState.taskIds.length})</button>` : ''}
            <button type="button" class="btn sm" data-action="analytics-close-picker">Done</button>
          </div>
        </div>
        <div class="picker-grid picker-grid-narrow" id="analytics-task-grid">
          ${cards || '<p style="color:var(--muted)">No challenges exist yet.</p>'}
        </div>
      </div>`);
    document.body.appendChild(ov);
    // Escape closes (topmost-overlay stack) + focus trap + dialog ARIA.
    overlayDismiss(ov, () => _analyticsClosePicker());
    // v7.20.11 — the shared filter. The hand-rolled one it replaces matched only
    // `.picker-card-name`, i.e. the TITLE — so the challenge NUMBER and the TAGS
    // that the card renders right there were both unsearchable, and it reported
    // no count and showed nothing at all when a query matched none.
    wirePickerFilter(ov, 'analytics-task-search', '#analytics-task-grid .picker-card', {
      emptyText: 'No challenges match that search.',
      noun: 'challenge',
    });
    document.getElementById('analytics-task-search')?.focus();
  });

  registerAction('analytics-toggle-task', (e, el) => {
    const id = el.dataset.taskId;
    const i = _analyticsState.taskIds.indexOf(id);
    if (i >= 0) _analyticsState.taskIds.splice(i, 1);
    else _analyticsState.taskIds.push(id);
    // Toggle the visual state inline so the user sees feedback without re-rendering the whole grid
    el.classList.toggle('picker-card-active');
    const cm = el.querySelector('.picker-card-checkmark');
    if (cm) setSafeHtml(cm, i >= 0 ? '' : ICO.check);
    renderAnalyticsFilterBar();
    _analyticsScheduleRefetch();
  });

  registerAction('analytics-clear-tasks-and-close', () => {
    _analyticsState.taskIds = [];
    _analyticsClosePicker();
    renderAnalyticsFilterBar();
    _analyticsScheduleRefetch();
  });

  registerAction('analytics-set-scope', (e, el) => {
    _analyticsState.scope = el.dataset.value;
    // Reset comp/slot picks when leaving scopes that need them.
    if (_analyticsState.scope === 'global') {
      _analyticsState.competitionId = null;
      _analyticsState.timeslotId = null;
      _analyticsState.compTagFilter = { mode: 'exclude', tags: [DRY_RUN_TAG] };
    } else if (_analyticsState.scope === 'competition') {
      _analyticsState.timeslotId = null;
    }
    renderAnalyticsFilterBar();
    _analyticsScheduleRefetch();
  });

  registerChange('analytics-set-period', (e, el) => {
    _analyticsState.periodPreset = el.value;
    if (_analyticsState.periodPreset !== 'custom') { _analyticsState.from = ''; _analyticsState.to = ''; }
    renderAnalyticsFilterBar();
    _analyticsScheduleRefetch();
  });

  registerChange('analytics-set-from', (e, el) => {
    const d = _analyticsParseLocalDate(el.value);
    _analyticsState.from = d ? d.toISOString() : '';
    _analyticsScheduleRefetch();
  });

  registerChange('analytics-set-to', (e, el) => {
    // Inclusive end-of-day in the admin's LOCAL timezone so "to=2026-04-15"
    // covers the whole of April 15 as the admin sees it, not 23:59 UTC.
    const d = _analyticsParseLocalDate(el.value);
    if (d) { d.setHours(23, 59, 59, 999); _analyticsState.to = d.toISOString(); }
    else _analyticsState.to = '';
    _analyticsScheduleRefetch();
  });

  registerChange('analytics-set-timeslot', (e, el) => {
    _analyticsState.timeslotId = el.value || null;
    _analyticsScheduleRefetch();
  });

  registerAction('analytics-toggle-difficulty', (e, el) => {
    const d = el.dataset.value;
    const i = _analyticsState.difficulties.indexOf(d);
    if (i >= 0) _analyticsState.difficulties.splice(i, 1);
    else _analyticsState.difficulties.push(d);
    renderAnalyticsFilterBar();
    _analyticsScheduleRefetch();
  });

  registerAction('analytics-clear-tasks', () => { _analyticsState.taskIds = []; renderAnalyticsFilterBar(); _analyticsScheduleRefetch(); });

  registerAction('analytics-comp-tag-mode', _tagModeHandler('compTagFilter'));

  registerAction('analytics-challenge-tag-mode', _tagModeHandler('challengeTagFilter'));

  registerAction('analytics-participant-tag-mode', _tagModeHandler('participantTagFilter'));

  registerAction('analytics-comp-tag-toggle', _tagToggleHandler('compTagFilter'));

  registerAction('analytics-challenge-tag-toggle', _tagToggleHandler('challengeTagFilter'));

  registerAction('analytics-participant-tag-toggle', _tagToggleHandler('participantTagFilter'));

  registerAction('analytics-comp-tag-clear', _tagClearHandler('compTagFilter'));

  registerAction('analytics-challenge-tag-clear', _tagClearHandler('challengeTagFilter'));

  registerAction('analytics-participant-tag-clear', _tagClearHandler('participantTagFilter'));

  registerAction('analytics-participant-mode', (e, el) => { _analyticsState.participantMode = el.dataset.value==='groups'?'groups':'tags'; renderAnalyticsFilterBar(); _analyticsScheduleRefetch(); });

  registerAction('analytics-group-mode', (e, el) => { _analyticsState.groupFilter.mode = el.dataset.value; renderAnalyticsFilterBar(); _analyticsScheduleRefetch(); });

  registerAction('analytics-group-toggle', (e, el) => { const id=el.dataset.value,f=_analyticsState.groupFilter; const i=f.groups.indexOf(id); if(i>=0)f.groups.splice(i,1); else f.groups.push(id); renderAnalyticsFilterBar(); _analyticsScheduleRefetch(); });

  registerAction('analytics-group-clear', () => { _analyticsState.groupFilter.groups=[]; renderAnalyticsFilterBar(); _analyticsScheduleRefetch(); });

  document.addEventListener('click', (e) => {
    const th = e.target.closest('#analytics-table thead th[data-sort]');
    if (!th) return;
    const k = th.dataset.sort;
    // v7.24.0 — compare against the EFFECTIVE sort, not the raw state. Since
    // `sortKey` starts null (the scope-derived default), `sortKey === k` was
    // false for every column on the first click — so clicking the column the
    // table was ALREADY sorted by re-pinned the same key in the same direction
    // and nothing moved. A header that does nothing when clicked reads as
    // broken, and it is the default column that gets clicked first.
    const eff = _anEffectiveSort();
    _analyticsState.sortKey = k;
    _analyticsState.sortAsc = eff.key === k ? !eff.asc : (k === 'title' || k === 'task_number');
    // audit v7.7.30 (M23) — reflect the active sort column + direction in
    // aria-sort so screen readers convey it (row order alone conveyed nothing).
    //
    // v7.24.0 — that loop MOVED into renderAnalyticsTable (_anSyncSortHeaders),
    // because the default order is now scope-derived rather than "whatever the
    // payload arrived in": a freshly-opened table is sorted before anyone has
    // clicked a header, and a sort nobody announces is conveyed by row order
    // alone — which is the thing M23 exists to prevent. Doing it here as well
    // would be two definitions of the same attribute.
    if (_analyticsState.lastResponse) renderAnalyticsTable(_analyticsState.lastResponse);
    else _anSyncSortHeaders();
  });

  window.addEventListener('resize', () => {
    if (S._analyticsDonut) try { S._analyticsDonut.resize(); } catch(e){ console.warn('Chart resize failed', e); }
    for (const c of _analyticsRowCharts.values()) try { c.resize(); } catch(e){ console.warn('Chart resize failed', e); }
    // v7.23.3 (Wave 4 #17) — the header WRAPS, so its height is a function of
    // the viewport width, not a constant. Re-publish --header-bottom on resize (and
    // therefore on orientation change, which is the case that matters: a phone
    // rotated to landscape is where the old hard-coded 70px was worst).
    publishHeaderHeight();
  });

  // The Look & theme picker (features/look-picker.js): two looks, the mode and
  // the ambient light colour, each applied at once and kept per browser.
  registerAction("open-look-picker",    () => _ns42.openLookPicker());
  registerAction("look-picker-look",    (e, el) => _ns42.lookPickerLook(el.dataset.lookId));
  registerAction("look-picker-mode",    (e, el) => _ns42.lookPickerMode(el.dataset.mode));
  registerAction("look-picker-ambient", (e, el) => _ns42.lookPickerAmbient(el.dataset.ambientId));
  // App chrome: the account menu (ui/nav.js), the Appearance page
  // (features/appearance.js), the inactive participant tabs and the "?"
  // help tips (ui/help-tips.js). The org default look is read once, best effort.
  registerAction("open-profile-menu",      () => _ns28.openProfileMenu());
  registerAction("nav-locked",             () => _ns28.navLockedPressed());
  registerAction("open-builtin-account",   () => {
    _ns22.selectSettingsSection('signin');   // Sign-in holds the break-glass card, shown as soon as it loads
    _ns28.adminTab(document.querySelector('.admin-nav-item[data-tab-id="admin-settings-tab"]'), 'admin-settings-tab');
  });
  registerAction("open-appearance",        () => _ns60.openAppearancePage());
  // The platform look (Settings, superadmin) and the event look (workspace Settings).
  registerAction("platform-look-save",     () => _ns64.savePlatformLook(false));
  registerAction("platform-look-apply",    () => _ns64.savePlatformLook(true));
  registerAction("event-look-save",        (e, el) => _ns64.saveEventLook(el.dataset.compId));
  registerAction("appearance-mode",        (e, el) => _ns60.appearanceMode(el.dataset.mode));
  registerAction("appearance-look",        (e, el) => _ns60.appearanceLook(el.dataset.lookId));
  registerAction("appearance-ambient",     (e, el) => _ns60.appearanceAmbient(el.dataset.ambientId));
  registerAction("appearance-clear-look",  () => _ns60.appearanceClearLook());
  registerAction("appearance-org-save",    () => _ns60.appearanceOrgSave());
  registerChange("appearance-tips",        (e, el) => _ns60.appearanceTips(el.checked));
  registerAction("help-tip",               (e, el) => _ns61.toggleHelpTip(el));
  // The header's Search button and Ctrl/⌘+K: the command palette.
  registerAction("open-command-palette",   () => _ns65.openCommandPalette());
  _ns65.installCommandPaletteKeys();
  _ns61.registerHelpTips(_ns7.CHALLENGE_EDITOR_TIPS);   // v8.17.0 — before the static placeholders are wired
  _ns61.registerHelpTips(_ns72.USERS_HELP_TIPS);   // RBAC — Users & roles (a static placeholder sits in the pane)
  _ns81.registerAuditHelpTips();                        // the Audit pane's "?" tips, same reason
  _ns61.registerHelpTips(_ns52.CERT_HELP_TIPS);          // the certificate wizard's, so every key is known from boot
  _ns22.installSettingsShell();                          // the Settings section list + its "?" texts, before the wiring too
  _ns61.installHelpTips();
  // The org default look, read once and never awaited: it repaints the look
  // when it answers, so S._appearanceSettled marks when it has (specs painting
  // the look in place wait on it: tests/helpers.js appearanceSettled).
  _ns60.loadOrgDefaultLook().finally(() => { S._appearanceSettled = true; });

  // ── The event workspace (features/event-workspace.js) and the templates
  // gallery (features/templates-admin.js). Registered here, once, like every
  // other handler; the panes' loaders are registered with nav.js so adminTab
  // reaches them without nav importing either module.
  _ns50.initEventWorkspace();
  _ns83.initEventTeam({ registerAction, registerChange });   // after the workspace: wraps its adminNavBuilt hook
  _ns62.initFiltersPanels();
  registerAction("filters-toggle",          (e, el) => _ns62.toggleFiltersPanel(el.dataset.panel));
  registerAction("filters-clear",           (e, el) => _ns62.clearFiltersPanel(el.dataset.panel));
  registerAction("filters-chip-remove",     (e, el) => _ns62.removeFilterChip(el));
  _ns53.installTableCards();
  _ns63.defineTable("challenges", _ns7.CHALLENGE_TABLE_COLUMNS);
  _ns63.defineTable("participants", _ns17.PARTICIPANT_TABLE_COLUMNS);
  _ns63.defineTable("events", _ns9.EVENT_TABLE_COLUMNS);
  _ns63.defineTable("submissions", _ns23.SUBMISSIONS_TABLE_COLUMNS);
  _ns63.defineTable("logs", _ns22.LOGS_TABLE_COLUMNS);
  _ns63.defineTable("rankings", _ns18.RANKINGS_TABLE_COLUMNS);
  _ns63.defineTable("rankings-group", _ns18.RANKINGS_GROUP_TABLE_COLUMNS);
  _ns63.defineTable("analytics", _ns5.ANALYTICS_TABLE_COLUMNS);
  for (const [k, c] of Object.entries(_ns63.PLAIN_TABLES)) _ns63.defineTable(k, c);
  _ns63.installTableColumns();
  _ns28.adminPaneLoaders.set('admin-templates-tab', () => _ns51.loadTemplatesPane());
  _ns28.adminPaneLoaders.set('admin-users-tab', () => _ns72.loadUsersPane());   // RBAC — Users & roles
  _ns72.initUsersAdmin(registerAction);
  // The Audit pane (features/audit-admin.js): its loader and its controls.
  _ns28.adminPaneLoaders.set('admin-audit-tab', () => _ns81.openAdminAudit());
  registerAction("audit-type",              (e, el) => _ns81.auditToggleType(el));
  registerChange("audit-filter",            () => _ns81.auditFiltersChanged());
  registerInput("audit-search",             (e, el) => _ns81.auditSearchInput(el));
  registerAction("audit-search-clear",      () => _ns81.auditSearchClear());
  registerAction("audit-clear-filters",     () => _ns81.auditClearFilters());
  registerAction("audit-page-first",        () => _ns81.loadAdminAudit(1));
  registerAction("audit-page-prev",         () => _ns81.auditPageStep(-1));
  registerAction("audit-page-next",         () => _ns81.auditPageStep(1));
  registerAction("audit-page-back10",       () => _ns81.auditPageStep(-10));
  registerAction("audit-page-fwd10",        () => _ns81.auditPageStep(10));
  registerAction("audit-page-last",         () => _ns81.auditPageLast());
  registerChange("audit-page-size",         (e, el) => _ns81.auditPageSize(el));
  // Both registries, as Raw logs' box: Go fires an action, Enter or blur a change.
  registerAction("audit-page-goto",         () => _ns81.auditGoToPage());
  registerChange("audit-page-goto",         () => _ns81.auditGoToPage());
  registerAction("audit-retry",             () => _ns81.loadAdminAudit(1));
  registerAction("audit-export",            () => _ns81.auditExportCsv());
  registerAction("audit-view",              (e, el) => _ns81.auditSetView(el.dataset.view));
  registerAction("audit-row-details",       (e, el) => _ns81.auditShowDetails(el));
  registerAction("audit-detail-close",      () => _ns81.auditCloseDetails());
  registerAction("comp-open",               (e, el) => _ns50.openEventWorkspace(el.dataset.compId, el.dataset.compName));
  registerAction("comp-open-ts",            (e, el) => _ns50.openEventWorkspaceSession(el.dataset.compId, el.dataset.compName, el.dataset.tsId, el.dataset.tsName));
  registerAction("ws-tab",                  (e, el) => _ns50.wsTab(el.dataset.section));
  registerAction("ws-section-pick",         () => _ns50.openSectionSheet());
  registerAction("ws-section-sheet-close",  () => _ns50.closeSectionSheet());
  registerAction("ws-join-reveal",          () => _ns50.wsJoinReveal());
  registerAction("ws-organisers-retry",     () => _ns50.wsOrganisersRetry());
  // The Overview's live command centre: in-place expanders, a challenge row's
  // facts, the organiser picker (add / remove) and the live parts' Try again.
  registerAction("ws-ov-expand",            (e, el) => _ns50.wsOverviewExpand(el.dataset.part));
  registerAction("ws-task-facts",           (e, el) => _ns50.wsTaskFacts(el));
  registerAction("ws-org-add",              (e, el) => _ns50.wsOrgAdd(el));
  registerAction("ws-org-remove",           (e, el) => _ns50.wsOrgRemove(el));
  registerAction("ws-pulse-retry",          () => _ns50.wsPulseRetry());
  registerAction("ws-certs-retry",          () => _ns50.wsCertsRetry());
  // "Show me" points at a header control (Invite, the join pill) rather than
  // repeating it; the walk-up card's Full-screen QR reveals the code first.
  registerAction("ws-point",                (e, el) => _ns50.wsPoint(el));
  registerAction("ws-ov-qr",                () => _ns50.wsOverviewQr());
  registerInput("ws-org-search",            (e, el) => _ns50.wsOrgSearch(el));
  registerAction("ws-join-copy",            () => _ns50.wsJoinCopy());
  registerAction("ws-join-toggle",          () => _ns50.wsJoinToggle());
  registerAction("p-columns",               (e, el) => _ns17.openParticipantColumns(el));
  registerChange("p-include-admins",        (e, el) => { S.pIncludeAdmins = !!el.checked; _ns17.loadAdminParticipants(); });   // RBAC — People: show admin accounts too
  registerChange("p-ws-everyone",          (e, el) => _ns50.setParticipantWsScope(el.checked ? 'all' : 'event'));
  registerAction("comp-top3",               (e, el) => _ns50.downloadTop3(el.dataset.compId, el));
  registerAction("ws-join-full",            () => _ns50.wsJoinFull());
  registerAction("ws-join-full-close",      () => document.getElementById('ws-qr-full')?.remove());
  registerAction("ws-invite",               () => _ns50.wsInvite());
  registerAction("ws-review-pending",       () => _ns50.wsReviewPending());
  registerAction("ws-clone",                () => _ns50.wsClone());
  registerAction("ws-save-template",        () => _ns50.wsSaveTemplate());
  registerAction("ws-export-zip",           () => _ns10.exportEventFullZip(S.adminSelectedCompetitionId, S.adminSelectedCompetitionName));
  registerAction("p-ws-scope",              (e, el) => _ns50.setParticipantWsScope(el.dataset.scope));
  registerAction("tpl-pick",                (e, el) => _ns51.pickTemplate(el.dataset.tplId));
  registerAction("tpl-delete",              (e, el) => _ns51.deleteTemplate(el.dataset.tplId));
  registerAction("tpl-new",                 () => _ns51.newTemplate());
  registerAction("tpl-edit",                (e, el) => _ns51.editTemplate(el.dataset.tplId));
  registerAction("tpl-duplicate",           (e, el) => _ns51.duplicateTemplate(el.dataset.tplId));
  registerAction("tpl-reload",              () => _ns51.loadTemplatesPane());
  registerAction("tpl-restore",             (e, el) => _ns51.restoreTemplate(el.dataset.tplId));
  registerAction("tpl-restore-builtins",    () => _ns51.restoreBuiltinTemplates());
  registerAction("tpl-protect",             (e, el) => _ns51.protectTemplate(el.dataset.tplId, el.dataset.protect === "1"));
  registerAction("tpl-reset",               (e, el) => _ns51.resetTemplate(el.dataset.tplId));
  registerAction("tpl-spin-close",          () => _ns51.closeTemplateSpin());
  registerAction("rk-cert-preview",         (e, el) => _ns18.rkCertPreview(el.dataset.rank));
  registerAction("rk-cert-download",        (e, el) => _ns18.rkCertDownload(el.dataset.rank));
  registerAction("cell-chips-toggle",       (e, el) => _ns7.toggleCellChips(el));
  registerAction("ws-ts-add",               (e, el) => _ns21.addTimeslotForm(el.dataset.compId));
  registerAction("ws-ts-edit",              (e, el) => _ns21.editTimeslot(el.dataset.compId, el.dataset.tsId));
  registerAction("ws-ts-delete",            (e, el) => _ns21.deleteTimeslot(el.dataset.compId, el.dataset.tsId));

  if (window.matchMedia) {
    try {
      window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", (e) => {
        // Only follow the OS while the preference IS "system" — a pinned
        // light/dark must not be overridden by an OS change.
        if (_themePreference() !== "system") return;
        document.documentElement.setAttribute("data-theme", _resolveTheme("system"));
      });
    } catch (_) { /* older Safari: addListener deprecated; skip */ }
  }

  registerAction('help-open',  () => openHelpDrawer());

  registerAction('help-close', () => closeHelpDrawer());

  // v8.5.0 — the release notes open in the SAME drawer, under their own title.
  // No separate close action: the drawer is one element with one close path.
  registerAction('release-notes-open', () => openReleaseNotes());

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-help-nav]');
    if (!a) return;
    e.preventDefault();
    _helpLoadDoc(a.dataset.helpNav, a.dataset.helpFrag || '');
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _mountHeaderIcons);
  } else {
    _mountHeaderIcons();
  }

  (function(){
    let timerHandle = null;
    let activeTarget = null;
    let tooltipEl = null;
    function removeTooltip() {
      if (tooltipEl && tooltipEl.parentNode) tooltipEl.parentNode.removeChild(tooltipEl);
      tooltipEl = null;
      activeTarget = null;
    }
    document.addEventListener("touchstart", (e) => {
      if (timerHandle) { clearTimeout(timerHandle); timerHandle = null; }
      removeTooltip();
      const target = e.target && e.target.closest ? e.target.closest("[title]") : null;
      if (!target) return;
      const title = target.getAttribute("title");
      if (!title) return;
      const touch = e.touches && e.touches[0];
      if (!touch) return;
      activeTarget = target;
      const x = touch.clientX, y = touch.clientY;
      timerHandle = setTimeout(() => {
        if (!activeTarget) return;
        tooltipEl = document.createElement("div");
        tooltipEl.className = "touch-tooltip";
        tooltipEl.textContent = title;
        tooltipEl.setAttribute("role", "tooltip");
        document.body.appendChild(tooltipEl);
        const rect = tooltipEl.getBoundingClientRect();
        const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, x - rect.width / 2));
        const top = Math.max(8, y - rect.height - 12);
        tooltipEl.style.left = left + "px";
        tooltipEl.style.top = top + "px";
      }, 500);
    }, { passive: true });
    document.addEventListener("touchmove", () => {
      if (timerHandle) { clearTimeout(timerHandle); timerHandle = null; }
      setTimeout(removeTooltip, 150);
    }, { passive: true });
    document.addEventListener("touchend", () => {
      if (timerHandle) { clearTimeout(timerHandle); timerHandle = null; }
      setTimeout(removeTooltip, 1200);
    });
    document.addEventListener("touchcancel", () => {
      if (timerHandle) { clearTimeout(timerHandle); timerHandle = null; }
      removeTooltip();
    });
  })();

  // THE BOOT SIGNAL, and the LAST statement of boot(): every delegated handler
  // above is registered and the OS-theme listener installed. The sign-in page is
  // static markup that paints without the app, so tests read this attribute as
  // "boot() has run" (tests/ui-admin-helpers.js expectSpaBooted; source-locked
  // as last by tests/signed-out-header.spec.js).
  document.documentElement.dataset.booted = "1";
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
