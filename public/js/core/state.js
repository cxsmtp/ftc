"use strict";

// Shared mutable application state for the Hack Arena SPA (v7.0.0 ESM split).
//
// This single object replaces the ~124 top-level `let` globals the monolithic
// app.js used to carry. ESM imported bindings are read-only for the importer,
// so a plain `export let currentUser` could not be reassigned from another
// module. Exporting ONE mutable container and mutating its properties in place
// (`S.currentUser = ...`) preserves the cross-module aliasing the old globals
// had: every module that does `import { S } from "../core/state.js"` sees live
// values.
//
// INVARIANTS:
//  - This module is a strict dependency-free LEAF (imports nothing). Keep it so.
//  - Writers MUST mutate in place (`S.x = v`) and never re-bind `S` itself.
//  - The two Trusted-Types policy handles (_ttAppPolicy / _ttVendorScriptPolicy)
//    are module-private to core/trusted-types.js and deliberately NOT here.
//  - The dispatcher's handler registries live in core/dispatcher.js, not here.
//
// (Initial values mirror the original public/app.js top-level declarations.)

export const S = {
  _pausedIntervals: [],
  currentUser: null,
  isAdmin: false,
  isSuperAdmin: false,
  // The break-glass (built-in superadmin) session: only it sees the Account card.
  isBreakglass: false,
  // v8.7.0 — the event-admin tier. Set from /api/me and /api/admin/me at every
  // one of the five identity write sites, so a role transition can never leave a
  // stale value behind. Gates the Logs + Settings nav items and the analytics
  // Global scope; every LIST is scoped by the server, so the client never holds
  // a copy of WHICH events — a second source of truth nothing keeps in step.
  isEventAdmin: false,
  // RBAC — the admin role's permissions (the sign-in answer, GET /api/me,
  // GET /api/admin/me), or null until read.
  permissions: null,
  // RBAC — the account's role as the server describes it ({id, label,
  // scope_mode, builtin}; `role_info` on the same three answers), or null.
  roleInfo: null,
  userRole: 'participant',
  isAdminView: false,
  isUserStaff: false,
  // v8.1.0 (PR 13) — the event-kind label table + the collective noun, read once
  // from the SPA shell's data- attributes in boot() (see ui/format.js
  // readEventVocabulary). NOT a mirror of the server table: the server substitutes
  // it per request, so these are the only copy the client has, and an empty array
  // means "the vocabulary did not arrive" — which every consumer must treat as
  // "render no label", never as "assume Competition".
  eventKinds: [],
  eventCollective: null,
  // v7.14.0 — non-null while an admin impersonates a participant: the
  // /api/me `impersonation` block ({active, superadmin, admin_label}). Drives
  // the banner + the fetch-interceptor write tier. Always re-derived at boot
  // (enter/exit are full page reloads).
  impersonation: null,
  _impReadonlyModalOpen: false,
  allTasks: [],
  // v7.7.26 (audit M16) — epoch-ms until which the pending-page countdown
  // holds off re-navigating to the tasks page after a not-started 403
  // (local clock ahead of the server). Set by loadTasks' bounce branch.
  _notStartedRetryAt: 0,
  timerInterval: null,
  // v7.15.0 — participant leaderboard column sort. null = untouched, i.e. render
  // in the server's ranking order. The sort only ever re-orders rows already on
  // screen (top-20 + your own), never fetches more — see leaderboard.js.
  lbSortCol: null,
  lbSortAsc: true,
  lbGroupSortCol: null,
  lbGroupSortAsc: true,
  // v8.6.0 — the late-entrant board's own sort state, so the three tables on this
  // page sort independently of one another.
  lbLateSortCol: null,
  lbLateSortAsc: true,
  lbInterval: null,
  // v8.6.0 — is THIS participant playing on past the event's end, inside the
  // late-entry window? Read by the header chip; refreshed by every /api/status
  // poll, so it clears itself the moment the window closes.
  _lateEntryActive: false,
  csrfToken: '',
  currentDiffFilter: 'all',
  currentSolveFilter: null,
  solveFilterUserSet: false,
  currentCompetitionId: null,
  currentCompStatus: null,
  // v8.1.0 (PR 18) — the resolved policy of the competition the participant is
  // currently in. Written from select-competition and refreshed by every
  // /api/status poll, so a kind change (only reachable by re-entering a different
  // event) cannot leave a stale suppression decision on screen. Read through
  // policyOrDefault, never directly.
  currentCompPolicy: null,
  lastLiveCompetitionId: null,
  currentCompName: 'Tournament',
  currentPlatformName: 'Tournament',
  // The OPEN EVENT WORKSPACE (features/event-workspace.js): which event, and
  // which of its sessions. Every admin loader narrows on these two keys; only
  // the workspace's open/close writes them.
  adminSelectedCompetitionId: null,
  adminSelectedCompetitionName: null,
  // Workspace Participants: false = the event's own people, true = everyone (to add).
  pWsShowEveryone: false,
  // People lists admin accounts only after a link to one (admin-crossnav.js
  // widenPeopleToAdmins), until People is next entered.
  pIncludeAdmins: false,
  _pWidenOnce: false,
  // The platform's "Require admin approval for new accounts" switch, from
  // /api/admin/me. Approval UI (badges, Approve actions) is shown only while on.
  requireAccountApproval: false,
  adminSelectedTimeslotId: null,
  adminSelectedTimeslotName: null,
  adminCompetitionsData: [],
  _adminCompsLoaded: false,   // true once the server answered the events list (an empty one included)
  // v9.2.5 — how many times renderAdminCompetitions has run, and the search
  // text the last run filtered by. The table keeps every row unchanged at its
  // place (ui/list-controls.js patchTableRows), so a render that changes no row
  // replaces no row; specs witness the render their typing caused by these
  // instead (tests/ui-admin-helpers.js narrowEventsTable).
  _compRenders: 0,
  _compRenderedQuery: null,
  // v9.2.14 — true once boot's own look read (features/appearance.js
  // loadOrgDefaultLook: GET /api/settings/appearance, never awaited) has
  // answered and repainted <html>'s look, or failed; nothing it started writes
  // the look again. A spec that paints the look in place waits on it first
  // (tests/helpers.js appearanceSettled), or that late repaint lands on its paint.
  _appearanceSettled: false,
  // v8.8.0 — 'late-entry' is an ended event whose late-entry window is still
  // open, and it is ON by default beside live and upcoming: it is still joinable
  // and still taking submissions, so it belongs with what an organiser is
  // currently running rather than with finished events. Held in memory only —
  // nothing persists this Set — so an existing operator receives the new default
  // on their next load rather than keeping a stored two-chip preference.
  compStatusFilters: new Set(['live','upcoming','late-entry']),
  // v8.1.0 (PR 13) — kind filter for the admin Competitions pane. Empty = all
  // types, matching compStatusFilters' 'none selected means no narrowing' rule.
  compKindFilters: new Set(),
  cPage: 1,
  cPageSize: 30,
  cSortCol: null,
  cSortAsc: true,
  compPickerTimers: [],
  compFilterMode: 'active',
  // v8.12.0 — the chip state of a staff member's SECOND picker section ("All other
  // events"). Separate from compFilterMode on purpose: the two lists are filtered
  // independently (see competition-picker.js setCompOtherFilter).
  compOtherFilterMode: 'active',
  // v7.17.2 — Groups tab list state. Held here rather than in the module so a
  // re-render (which the tab does after every group mutation) keeps the
  // operator's page and sort instead of silently jumping back to page 1.
  adminGroupsData: [],
  gPage: 1,
  gPageSize: 30,
  gSortCol: null,
  gSortAsc: true,
  _sessionExpiredHandled: false,
  // v7.15.4 — set once a sign-out has been ANNOUNCED to the user, so two 401s
  // racing through the interceptor can't stack two modals (the second settles
  // the first as Cancel, which fires the first's redirect on the spot and makes
  // the message flash past). Distinct from _sessionMon.endedShown, which
  // stopSessionMonitor() resets.
  _signoutAnnounced: false,
  // Set once by _stopAllPolls (features/session-monitor.js), whose every caller
  // ends this tab's session: from then on no poll is armed and the fetch
  // interceptor sends no /api/ request (a reload starts afresh).
  _pollsHalted: false,
  // When the scanner block's Retry-After ends (ms; 0: not blocked), and whether
  // the next /api/ request asks the session check first (core/api.js).
  _addressBlockedUntil: 0,
  _sessionCheckDue: false,
  // A fingerprint of this tab's CSRF token, compared with the one the tab most
  // recently issued one published (core/api.js `ensureFreshCsrf`); and whether
  // this tab has found that another tab's session replaced the one it shows.
  _csrfFp: null,
  _sessionOutOfDate: false,
  _echartsLoading: null,
  // v7.20.7 — analytics per-challenge table paging
  _anPage: 1,
  _anPageSize: 25,
  _anSearchDebounce: undefined,
  _unsubSearchDebounce: undefined,
  _subKbActiveRow: -1,
  _compSearchDebounce: undefined,
  _taskSearchDebounce: undefined,
  _partSearchDebounce: undefined,
  _groupsSearchDebounce: undefined,
  _loadingCount: 0,
  adminTasksData: [],
  // v7.19.0 — the multiple-choice editor's model. The DOM is a rendering of
  // this, so adding/removing a row cannot lose what was typed into the others.
  _tfChoices: [],
  // v8.9.0 — the additional-accepted-answers list for a TEXT challenge (answer
  // #1 lives in #tf-answer). Same model-is-authoritative rule as _tfChoices.
  _tfExtraAnswers: [],
  // v8.14.5 — the edited challenge's updated_at AS THE EDITOR WAS FILLED, sent
  // as expectedUpdatedAt. Never re-read from adminTasksData at Save: the list
  // reloads under an open editor (tab return, focus change), and a token taken
  // from the reload passes the 409 for a change the form never showed.
  _tfEditUpdatedAt: null,
  myCompetitions: [],
  compDataPollInterval: null,
  _currentTimeslots: [],
  _currentChosenTimeslot: null,
  _competitionFullyEnded: false,
  _tsPickerTimers: [],
  hackathonEndTime: null,
  // The server's `open_ended` for that end (/api/status and every pulse): the
  // header and the play bar say "No fixed deadline" instead of the time left.
  hackathonOpenEnded: false,
  // v8.1.0 (PR 17) — the ACTIVE window's start, for the "Day N of M" chip.
  hackathonStartTime: null,
  hackathonEnded: false,
  statusPollInterval: null,
  _endedPopupSeen: false,
  // v7.20.5 — the competition whose ended-popup this TAB has already shown.
  // The server flag alone is not enough: POST /api/dismiss-ended is
  // fire-and-forget, and an admin viewing an ended competition never sets it at
  // all, so a re-read could keep answering "not seen" for ever.
  _endedPopupShownFor: null,
  // CTF-0026 (fix A) — true while the participant is in a LIVE competition;
  // the session monitor keepalives on this even with no in-tab DOM activity.
  _inLiveCompetition: false,
  _openedTaskId: null,
  // v7.27.0 — the challenge a navigated_away was just fired for. A tab-hide
  // reports the departure and nulls _openedTaskId; if the tab comes BACK and the
  // detail view is still on screen, rearmOpenTask() restores it from here so the
  // eventual real departure is still recorded. Consumed (nulled) on re-arm, on
  // opening another challenge, and on the solve path.
  _navAwayResumeId: null,
  _regInvitationId: null,
  _regInvitation: null,   // the invitation preview (address, events) for the banners
  _pendingJoinToken: '',
  _lastJoinSpectator: false, // v8.12.0 — the last join answered staffSpectator (no row written)
  _pendingJoinComp: null,
  scopeBannerInterval: null,
  adminCompPollInterval: null,
  lastBannerStatus: null,
  _compFormSessionCounter: 0,
  _compFormCompStatus: null,
  _pendingSlotDeletes: [],
  _tzListCache: null,
  _sharedTzDatalistId: null,
  _pickerCheckedIds: null,
  tSortCol: 'title',
  tSortAsc: true,
  tDiffFilters: new Set(),
  tStatusFilters: new Set(),
  tStateFilters: new Set(),
  tTopicFilter: "",          // stage B — the Question bank's Topic filter ("" all, "__none__" none, else a topic id)
  adminTopics: null,         // stage B — GET /api/admin/topics (features/topics-admin.js); null until read
  tPage: 1,
  tPageSize: 30,
  _histState: null,
  _pendingStagingAttachments: [],
  adminParticipantsData: [],
  pSortCol: 'name',
  pSortAsc: true,
  pPage: 1,
  pPageSize: 30,
  selectedParticipants: new Set(),
  selectedChallenges: new Set(), // v7.12.0 — bulk-assign challenges to events
  pStatusFilter: new Set(),
  _importParticipantsData: null,
  _importParticipantsSelected: new Set(),
  _importPPage: 1,
  _qrLibPromise: null,
  bulkAssignStep: 1,
  bulkSelectedComps: [],
  bulkSelectedGroups: [],
  // v7.21.16 (long-list phase 4) — the invitation dialog's group picks. It used
  // to read them back out of the DOM at submit time, so they existed only as
  // long as the markup did; anything that re-rendered that box would have
  // dropped every tick silently. A Set here is the authority, the chips are a
  // projection of it. (The bulk sibling above stays an ARRAY because the
  // request body and other callers read it as one.)
  _inviteSelectedGroups: null,
  adminSubmissionsData: [],
  subSortCol: 'time',
  subSortAsc: false,
  subPage: 1,
  subPageSize: 30,
  adminSubmissionsTotal: 0,
  adminSubmissionsLastQ: '',
  _subFetchSeq: 0,
  // v7.21.16 — true when the last /api/admin/submissions reply was ordered by
  // the SERVER across the whole filtered stream, so the client must neither
  // re-sort the page nor claim the sort was page-scoped.
  _subSortedGlobally: false,
  // ext-audit v7.15.13 — the same stale-response guard _subFetchSeq has always
  // given Submissions, for the loaders that lacked one. Every scope switch and
  // every debounced search fires a fresh request while the previous is still in
  // flight; without a sequence, whichever the network happens to deliver last
  // wins and the table can end up showing a competition the admin has already
  // navigated away from.
  _partFetchSeq: 0,
  _taskFetchSeq: 0,
  _compFetchSeq: 0,
  // v7.21.15 — the two loaders v7.15.13 did not reach. Both are re-fired while
  // a previous request is still in flight, and both write their result
  // unconditionally, so the network decides which one the admin sees.
  //
  // RANKINGS is the worse of the two: every scope change calls
  // loadAdminRankingsTab(), and a board is nicknames and scores under a heading
  // naming the competition — there is no per-row identifier that would let an
  // admin notice they are reading the previous competition's standings. A wrong
  // answer here is silent AND plausible.
  //
  // LOGS is fired by a 250 ms debounced search, a group filter, a page-size
  // change, four pager buttons and a 15 s silent poll, so several in flight at
  // once is the normal case rather than a race. A stale response also re-pins
  // the pager's anchor when it happens to be a page-1 reply, which is the drift
  // protection the anchor exists to provide.
  _rkFetchSeq: 0,
  _logsFetchSeq: 0,
  _auditFetchSeq: 0,   // the Audit pane's loader (features/audit-admin.js)
  // ext-audit v7.15.14 — competition GENERATION. Bumped on every competition /
  // timeslot selection; the participant loaders capture it before their fetch
  // and discard the response if it moved. Without it, reordered WAN responses
  // let competition A's tasks, timer and leaderboard overwrite competition B's
  // after the participant had already switched to B.
  _compGen: 0,
  // ext-audit v7.15.15 — monotonic token for competition/timeslot SELECTION, so
  // a slow earlier pick cannot commit UI state after a newer one. _compGen
  // invalidates in-flight READS; this orders the WRITE that establishes context.
  _compSelectSeq: 0,
  // v8.14.4 — how many event selections this tab has in flight. While one is,
  // the tab sends no X-Competition-Id (core/api.js): the session is moving to
  // the event being picked, and naming the old one would refuse the tab's own
  // requests as if another tab had moved it. And whether this tab has been told
  // that another tab moved the session to a different event.
  _compSelecting: 0,
  _eventOutOfDate: false,
  // The deselect the tab sent on arriving at the event list (showCompetitionsPage),
  // as a promise that settles when it is answered (null before the first). A
  // pick made straight after (the command palette's jump) waits for it, so the
  // server never applies the deselect after the new event's select.
  _leaveInFlight: null,
  // v8.12.6 — the challenge-VIEW generation. Bumped by every openTask() and by
  // every page change (showMain AND showPage, ui/nav.js). openTask captures it
  // before its fetch and drops a response that lands after it moved: an OPEN
  // belongs to the latest thing the participant asked for. _compGen alone cannot
  // see a move WITHIN one competition (challenge A -> challenge B, or -> the
  // Leaderboard). Outcomes (submit / hint / rating) do NOT read it — they ask
  // whether their own challenge is still the one on screen (participant-tasks.js
  // `_taskStillShown`), because "has anything happened since?" is too broad a
  // question for an answer the participant is waiting to see.
  _taskViewGen: 0,
  // ext-audit v7.15.14 — one pending re-attempt of the first /api/status read,
  // so a competition whose initial load hit a network blip recovers on its own
  // instead of sitting with a blank timer and no poll installed.
  _statusRetryTimer: null,
  _subSearchTimer: null,
  _subSnapshotBefore: null,
  _subExpectedTotal: null,
  _subExpectedMaxMutation: null,
  _subSnapshotStale: false,
  // v7.17.0 — the last-fetched rankings boards, so a column-header click can
  // re-render without re-issuing one request per competition per timeslot.
  // Populated by the two load paths and read ONLY during a sort re-render.
  // v7.22.1 — stale-response guard for the PARTICIPANT's competition list.
  // Claimed by loadMyCompetitions() and by ejectToCompetitionPicker(), which
  // both write S.myCompetitions; without it an older poll could overwrite the
  // eject's fresh list and re-offer a competition the participant was just
  // removed from.
  _myCompsFetchSeq: 0,
  // v8.7.3 — re-entry guard for the picker's profile_incomplete branch. The
  // completion gate resolves AS IF COMPLETE when its own re-verify GET fails,
  // so a bare `return loadMyCompetitions()` after it could spin gate→400→gate.
  // One retry, then the honest failure panel.
  _compsProfileRetry: false,
  _rkCache: null,
  // v8.11.0 — the rankings presenter's view: company and email off the screen
  // while an organiser shares it. Per TAB and deliberately not persisted (see
  // setRankingsHideIdentity), so it starts off on every load — a board that came
  // back with two columns missing and no memory of asking reads as broken.
  _rkHideIdentity: false,
  // v7.22.0 — debounce for the rankings search box. Like every other admin
  // search it re-renders from the cache rather than the network.
  _rkSearchDebounce: undefined,
  adminRankingsCompId: null,
  _logsStream: 'app',
  _logsQuery: '',
  _logsGroupFilter: '',
  // Raw logs' pager: ui/list-controls.js's segment pager (`newSegmentPager`'s
  // fields; a leaf cannot import it, so the shape is written out here). The
  // Audit log pages like the audit trail (operator ruling, 17 Nov 2026).
  _logsPager: { page: 1, pageSize: 50, total: null, totalExact: false, anchor: null, segments: [],
    nextCursor: null, hasMore: false, searchedTo: null, cutAt: null, offsetMax: 1000000000 },
  _logsSortCol: 'ts',
  _logsSortDir: 'desc',
  _logsAutoRefreshHandle: null,
  _logsSearchDebounce: null,
  _logsLastResponse: null,
  _logsMove: null,            // a Raw logs load the operator asked for, in flight (the refresh waits)
  // v7.25.0 — both are the SERVER's echo, never re-derived here. `sorted` says
  // the rows in hand were ranked against every match (so the client must not
  // re-sort them); `sortable` says a header click should refetch rather than
  // reorder what is already on screen. Absent ⇒ false ⇒ the pre-v7.25.0
  // behaviour, so an older server cannot produce a claim the client then makes
  // on screen.
  _logsSortedGlobally: false,
  _logsSortableGlobally: false,
  _analyticsDonut: null,
  _analyticsDebounce: null,
  _availableCompTags: [],
  _availableParticipantTags: [],
  _availableGroups: [],
  // v7.21.19 (audit F3) — analytics stale-response guard. The 250 ms debounce
  // only stops requests that have not been SENT; once two are in flight the
  // network decides which the admin reads.
  _analyticsFetchSeq: 0,
  _analyticsCompCache: null,
  _analyticsTaskCache: null,
  _helpLastDoc: null,
  _helpOpenerEl: null,
  _helpRemoveTrap: null,
};
