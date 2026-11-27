"use strict";

import { S } from "../core/state.js";
import { setListCount, renderLoadFailure } from "../ui/list-controls.js"; // v7.20.11 — shared match count
import { csrfHeaders } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { openProfileCompletionGate, _GATE_FIELD_LABELS } from "./auth.js";
import { ejectToCompetitionPicker, refreshScore, playStatsHtml, paintGauge, progressFor, runStanding } from "./participant-tasks.js";
import { esc, fmtDt, formatCountdown, formatDuration, DRY_RUN_TAG, eventKindChipHtml, eventKindLabel, policyOrDefault, staffSpectatorIn, currentCompetitionRow, NO_FIXED_DEADLINE, eventEndText } from "../ui/format.js";
import { ICO } from "../ui/icons.js";
import { showSkeletonCompCards } from "../ui/loading.js";
import { showModal } from "../ui/modal.js";
import { applyReveal, enterCompetitionView, routeVerdict, showMain, showPage, updateParticipantNav, accountIsAdminRole } from "../ui/nav.js";
import { showToast } from "../ui/toast.js";

export function clearCompTimers(){S.compPickerTimers.forEach(iv=>clearInterval(iv));S.compPickerTimers=[];}

export function startCompDataPoll(){
  stopCompDataPoll();
  if(S._pollsHalted)return;
  S.compDataPollInterval=setInterval(async()=>{
    const active=document.getElementById('competitions-page')?.classList.contains('active')
      ||document.getElementById('pending-page')?.classList.contains('active');
    if(!active){stopCompDataPoll();return;}
    // The profile-completion gate is open: every read would be refused 400
    // `profile_incomplete`, and each refusal counts toward the address's scanner
    // block. The gate's own save re-reads the list (loadMyCompetitions).
    if(S._profileGatePromise)return;
    // v8.1.4 — THE POLL CLAIMS THE SEQUENCE TOO.
    //
    // v7.22.1 gave `loadMyCompetitions` a claim/re-check pair and bumped the
    // same counter from `ejectToCompetitionPicker`, whose comment says the
    // bump stops "a poll that was ALREADY in flight". It did not: THIS is the
    // poll, and it wrote S.myCompetitions with no claim and no re-check, so
    // the counter it was being protected by was one it never read. The guard
    // was live on the loader and dead on the writer that actually polls.
    //
    // Reachable, on the pending page — where this poll always runs and the
    // v8.1.0 Leave button lives: a response carrying the PRE-leave list that
    // lands after leaveCompetition()'s eject overwrote the freshly-rebuilt
    // list and re-rendered the picker with the event the participant had just
    // been told they left; clicking it 403s. It does not self-heal either,
    // because the eject stopped the poll — nothing refetches until the user
    // acts. Same shape as the removal race v7.22.1 was written for.
    const mySeq=++S._myCompsFetchSeq;
    const r=await fetch('/api/my-competitions').catch(()=>null);
    if(!r||!r.ok)return;
    const fresh=await r.json();
    // Re-checked AFTER the body parse, not merely after the fetch: `fetch`
    // resolves at response HEADERS, so a newer write can land during the parse
    // (v7.15.15). It gates the comparison as well as the assign — a superseded
    // body must not be diffed against a list it predates, and must not drive
    // the routing below either.
    if(mySeq!==S._myCompsFetchSeq)return;   // superseded while in flight
    // Check if data changed
    if(JSON.stringify(fresh)===JSON.stringify(S.myCompetitions))return;
    S.myCompetitions=fresh;
    if(document.getElementById('competitions-page')?.classList.contains('active'))renderCompetitionPicker();
    if(document.getElementById('pending-page')?.classList.contains('active')&&S.currentCompetitionId){
      // v8.12.6 (sweep) — THE ROUTING BELOW IS DECIDED ABOUT THE PAGE THE
      // PARTICIPANT IS ON *NOW*, not the one this tick found. The pending-page
      // check above ran before the await; selectCompetition is a round trip, and
      // in it the countdown can move them to the list, or they can press Events
      // and pick another card. Acting on the stale answer afterwards yanked them:
      // `showMain('tasks-page')` over whatever they had opened (and, since
      // showMain bumps S._taskViewGen, silently dropped a challenge open still in
      // flight), or — the sharper half — ejecting them to the picker with "You
      // are no longer in this event": a SUPERSEDED selectCompetition returns
      // `false`, the same value as a real refusal, and a newer pick supersedes
      // exactly this call. So the tick captures the view generation, the
      // competition generation (selectCompetition bumps it once, for itself) and
      // the event, and does nothing at all if any of them moved.
      const _v=S._taskViewGen, _g=S._compGen, _c=S.currentCompetitionId;
      // Re-select competition to get fresh timeslot data, then check if it went live
      const result=await selectCompetition(_c);
      if(_v!==S._taskViewGen||S._compGen!==_g+1||S.currentCompetitionId!==_c
        ||!document.getElementById('pending-page')?.classList.contains('active'))return;
      if(result===false){
        // Participant was removed from the competition (or it was deleted)
        // while they were on the pending page. selectCompetition already
        // toasted the server's error; eject them back to the picker with
        // the same recovery helper used by the live tasks/leaderboard
        // flows so they don't sit on a stale pending screen for a
        // competition they no longer have.
        await ejectToCompetitionPicker();
        return;
      }
      if(result==='needsTimeslot')return;
      if(routeVerdict(result)==='enter'){
        stopCompDataPoll();showMain('tasks-page');enterCompetitionView();updateParticipantNav();
      }
    }
  },15000);
}

export function stopCompDataPoll(){if(S.compDataPollInterval){clearInterval(S.compDataPollInterval);S.compDataPollInterval=null;}}

export async function loadMyCompetitions(){
  // v8.6.4 — RESERVE THE GRID'S HEIGHT BEFORE THE FETCH, and only when it is
  // genuinely empty.
  //
  // Everything below `#comp-grid` moves by the full height of the card list when
  // this resolves; MEASURED at 12 events on the CLS gate's own 400 kbps / 500 ms
  // link, that was CLS 0.1029 with 0.0994 of it `#app-footer` alone.
  //
  // The EMPTINESS GUARD is not defensive tidiness: this function is also the 15 s
  // poll's body, and painting skeletons over rendered cards every 15 seconds would
  // be the v7.23.5 "whoever writes skeletons owns clearing them" defect turned
  // into a strobe. Only a grid with nothing in it gets them.
  //
  // The count comes from `/api/me`, which boot has already read and which carries
  // each competition's `status` — so this reserves exactly the cards that are
  // coming, at exactly the spans they will take, rather than a guessed number.
  // v8.12.0 — reserved PER SECTION: a staff member's list is split into the
  // events they were put in (`own`) and every other event, each with its own
  // grid and its own chip filter, so each grid reserves exactly its own cards.
  for(const sec of _pickerSections()){
    const _grid=document.getElementById(sec.gridId);
    if(!_grid||_grid.firstElementChild)continue;
    const seed0=(S.currentUser&&S.currentUser.competitions)||S.myCompetitions;
    const seed=Array.isArray(seed0)?seed0.filter(sec.pick):[];
    if(seed.length){
      // THROUGH THE RENDERER'S OWN RULES, not the raw payload. The picker derives
      // `_status` with `computeCompStatus` rather than trusting `c.status`, and its
      // default chip filter HIDES ended events unless a late-entry window is open —
      // so reserving one card per row of the payload would over-reserve for anyone
      // with a finished event, and the grid would SHRINK on the swap. A shrink is a
      // layout shift exactly like a grow; this is the detail that decides whether
      // the reservation is right or merely large.
      const _seedStatuses=seed
        .map(c=>({c,st:computeCompStatus(c)}))
        .filter(x=>sec.mode()!=='active'||x.st!=='ended'||x.c.late_entry_window_open)
        .map(x=>x.st);
      if(_seedStatuses.length)showSkeletonCompCards(sec.gridId,_seedStatuses);
      // The progress strip sits ABOVE the grid, so it is drawn from the same seed
      // now, at the height it will keep: drawn only once the list arrives, it
      // would push the reserved cards down by its own height.
      if(sec.key==='own')_renderProgressStrip(seed.map(c=>({...c,_status:computeCompStatus(c)})));
    }
  }
  // v7.22.1 — STALE-RESPONSE GUARD. This was the one list-loader the three
  // previous sweeps never reached: v7.15.13 covered the admin tables, v7.21.15
  // Rankings and Logs, v7.21.19 (F3) Analytics — and this is the PARTICIPANT's
  // own competition list, which is polled AND written by a second path.
  //
  // It assigned unconditionally, so an older in-flight response could land after
  // a newer write and win. The reachable case is not theoretical: when an admin
  // removes a participant mid-competition, `ejectToCompetitionPicker()` re-reads
  // /api/me and rebuilds the list without that competition — and a poll issued
  // BEFORE the removal, landing after, put it straight back. The participant is
  // then told they were removed and still offered the competition they were
  // removed from; clicking it 403s. Found by the ejection regression lock once
  // it was made to print what the picker actually held.
  //
  // The counter is re-checked AFTER the body parse as well: `fetch` resolves at
  // response HEADERS, so a newer write can land during the parse (v7.15.15).
  const mySeq=++S._myCompsFetchSeq;
  // v7.23.5 (audit Wave 5) — a failed load must SAY so, and must still start the
  // poll. This was a bare `if(!r.ok)return;`. MEASURED on a 500: #comp-grid
  // rendered completely blank — 0 characters, no toast, no spinner — and because
  // startCompDataPoll() sits AFTER this return, no poll was ever installed, so
  // there was zero auto-recovery. A participant's landing view, permanently
  // empty, with nothing on screen saying why. Clicking a filter chip then
  // rendered "No competitions found." to someone who has competitions.
  let r=null;
  try{ r=await fetch('/api/my-competitions'); }catch(e){ console.warn('Could not load your events',e); r=null; }
  if(!r||!r.ok){
    if(mySeq!==S._myCompsFetchSeq)return;
    // v8.7.3 — A 400 THAT NAMED ITS REASON IS AN ANSWER, NOT A MALFUNCTION.
    //
    // This endpoint carries `requireCompleteProfile`, so an INCOMPLETE PROFILE
    // arrives here as 400 {error:"profile_incomplete", missing:[…]} — and the
    // branch below reported it as "the server did not respond correctly",
    // offering a Try again button that re-issues the identical request. That is
    // the sentence an operator reported. Reachable by an admin of ANY tier
    // (the completion gate is admin-exempt at both proactive sites), and by a
    // participant whose organiser made a field mandatory mid-session, which
    // v8.4.0 resolves LIVE.
    const _d=r?await r.json().catch(()=>null):null;
    if(_d&&_d.error==='profile_incomplete'){
      const _missing=Array.isArray(_d.missing)?_d.missing:[];
      // A PARTICIPANT gets the gate — the established remedy, and the same
      // branch `selectCompetition` has taken since v7.6.x. Guarded against
      // re-entry rather than recursing freely: the gate resolves as complete if
      // its own re-verify GET fails, and an unbounded retry would then spin.
      if(S.userRole==='participant'&&!S._compsProfileRetry){
        S._compsProfileRetry=true;
        try{ await openProfileCompletionGate(_missing); return await loadMyCompetitions(); }
        finally{ S._compsProfileRetry=false; }
      }
      // Otherwise the honest sentence and NO gate — which for an ADMIN TIER is
      // the whole point. That gate is non-dismissible and covers the header, so
      // opening it here would hide the Admin View button that is their way out.
      // They keep the entire page, and the toggle is one click away.
      const _names=_missing.map(f=>_GATE_FIELD_LABELS[f]||f).join(', ');
      const _isAdminTier=accountIsAdminRole();   // the three built-in admin roles and a custom admin role
      // No poll: until the profile is completed every read is refused 400, and
      // each refusal counts toward the address's scanner block. Try again reads
      // once, after the profile is saved.
      renderLoadFailure('comp-grid',{
        message:`Your profile is incomplete, so your events cannot be shown. Missing: ${esc(_names||'required profile fields')}. `
          +(_isAdminTier?'Complete it from your profile, or use Admin View to go back.':'Please complete your profile to continue.'),
        retryAction:'retry-load-my-competitions',
      });
      showToast('Your profile is incomplete — complete it to take part in events.','error');
      stopCompDataPoll();
      return;
    }
    renderLoadFailure('comp-grid',{noun:'your events',retryAction:'retry-load-my-competitions'});
    showToast('Could not load your events.','error');
    // The poll is the auto-recovery, so it MUST start even on the failure path.
    startCompDataPoll();
    return;
  }
  const data=await r.json();
  if(mySeq!==S._myCompsFetchSeq)return;   // superseded while in flight
  S.myCompetitions=data;
  renderCompetitionPicker();
  startCompDataPoll();
}

export function setCompFilter(btn,mode){
  S.compFilterMode=mode;
  document.querySelectorAll('#comp-filters .filter-btn').forEach(b=>b.classList.toggle('active',b.dataset.filter===mode));
  renderCompetitionPicker();
}
// v8.12.0 — the second section's chips. Per-section state, deliberately: a staff
// member filtering their OWN events to "All" to find a finished one they competed
// in has said nothing about whether the platform-wide list should show every
// finished event on the platform.
export function setCompOtherFilter(btn,mode){
  S.compOtherFilterMode=mode;
  document.querySelectorAll('#comp-other-filters .filter-btn').forEach(b=>b.classList.toggle('active',b.dataset.filter===mode));
  renderCompetitionPicker();
}

// v8.12.0 — THE TWO SECTIONS OF A STAFF MEMBER'S PICKER, and the one section of
// everybody else's. "Your Events" holds the events the user was PUT IN (they hold
// a row — `own` on the wire); "All other events" holds the rest of the platform,
// which a staff member may enter as a spectator without a row. An ordinary
// participant holds a row on everything they can see, so their picker is one
// section as it always was, and the second section's markup stays hidden.
//
// Each section owns its grid, its count, its chip state and its empty-state copy;
// the search box is shared, because a name is a name in either list.
function _pickerSections(){
  const own={key:'own',gridId:'comp-grid',filtersId:'comp-filters',mode:()=>S.compFilterMode,pick:c=>!S.isUserStaff||c.own!==false};
  if(!S.isUserStaff)return [own];
  return [own,{key:'other',gridId:'comp-other-grid',filtersId:'comp-other-filters',mode:()=>S.compOtherFilterMode,pick:c=>c.own===false}];
}

export function computeCompStatus(c){
  if(c.status)return c.status; // prefer server-computed timeslot-aware status
  const now=Date.now(),start=new Date(c.start_time).getTime();
  const end=c.ended_at?new Date(c.ended_at).getTime():(start+c.duration_minutes*60000);
  if(now>=end||c.ended_at)return'ended';
  if(now>=start)return'live';
  return'upcoming';
}

// v8.8.0 — AN EVENT IN ITS LATE-ENTRY WINDOW IS SHOWN APART FROM OTHER ENDED
// EVENTS, AND THAT IS A PRESENTATION CATEGORY, NEVER A FOURTH STATUS.
//
// `computeCompStatus` above KEEPS its three values and must: ten modules import
// it, and it gates the scoring freeze, the assignment freeze, the kind-change
// lock, the start-time lock, Start Now and the certificate CTA. A fourth value
// would silently change every one of those — which is the same trap
// lib/late-entry.js refuses on the server, where its header states the rule the
// whole feature rests on: THE WINDOW EXTENDS PLAY, IT DOES NOT EXTEND THE EVENT.
//
// So the split lives in a SEPARATE derivation used only where a human is being
// shown which bucket an event is in — a badge, or a status filter chip.
//
// It reads the server's own answer (`late_entry_window_open`, computed by
// `lateEntryWindowOpen`) and never re-derives it. The client cannot: the rule is
// a per-KIND prohibition plus a per-event column plus a deadline that may be
// pinned or derived from the effective end, and `public/js` is a browser-only
// graph that cannot import the module owning it. A second copy here would be one
// edit from disagreeing with the gate that actually admits a late entrant.
//
// The `=== 'ended'` clause is not decoration: the flag is only meaningful once
// the event is over, and pinning the category to BOTH facts means a stale
// payload cannot paint a live event as a late-entry one.
export function isLateEntryOpen(c){
  return !!c&&computeCompStatus(c)==='ended'&&!!c.late_entry_window_open;
}

/** live | upcoming | late-entry | ended — the bucket a HUMAN is shown. */
export function compDisplayCategory(c){
  return isLateEntryOpen(c)?'late-entry':computeCompStatus(c);
}

// v8.12.6 — MAY AN ADMIN ADD PEOPLE TO THIS EVENT? The client mirror of the
// server's `competitionAdmission` (lib/competitions.js), which every admin door —
// assign, the selection bar, invitations, the desk and a group bind — now asks:
// an upcoming or live event takes new members, and so does an ENDED Booth Event
// whose late-entry window is still open, where everyone added becomes a late
// entrant. Before v8.12.6 every one of those doors refused a window-open event,
// so the client gated them on `status !== 'ended'`; that literal is what this
// replaces, at every door at once, so the offer and the server's answer cannot
// disagree about which events are open.
//
// It reads the window ONLY through `isLateEntryOpen` — the server's own
// `late_entry_window_open` flag — and never re-derives it, for the reason
// `isLateEntryOpen`'s comment gives: the rule is a per-kind prohibition plus a
// per-event column plus a deadline this browser-only graph cannot compute. A
// status invented later is not live or upcoming and carries no window flag, so it
// answers false: fail closed (the positive allow-list rule).
export function compAcceptsNewMembers(c){
  if(!c)return false;
  const st=computeCompStatus(c);
  return st==='live'||st==='upcoming'||isLateEntryOpen(c);
}

// One label per category, so the events table, the challenge row, the
// participant row, the analytics chip and the picker cannot disagree about what
// this state is called. Four ternaries already spelled the first three out
// separately; a fifth variant per site is how they drift.
export const COMP_CATEGORY_LABEL={
  live:'Live',upcoming:'Upcoming','late-entry':'Late entry open',ended:'Ended',
};

export function renderCompetitionPicker(){
  clearCompTimers();
  // v7.21.16 (long-list phase 6) — search by NAME only.
  //
  // A returning participant accumulates competitions across events, and the two
  // chips only split live/upcoming from ended. Name is deliberately the whole
  // haystack: a competition also carries admin-authored TAGS (`internal` and
  // whatever else an organiser typed), and those are organiser labels, not
  // something to expose to a participant as a searchable field.
  const q=(document.getElementById('participant-comp-search')?.value||'').toLowerCase().trim();
  // The welcome greets the person by the name they chose; textContent, so a
  // nickname is never markup. Left as the static line when there is no name.
  // Greeted by FIRST name, as a person would be; the nickname is a handle for
  // the board, and a handle in tracked capitals read as a shout ("HI PRIYAR").
  const greet=document.getElementById('ev-hero-greet');
  const who=S.currentUser&&(String(S.currentUser.first_name||'').trim()||S.currentUser.nickname);
  if(greet&&who)greet.textContent=`Hi ${who} — ready to play?`;
  const all=S.myCompetitions.map(c=>({...c,_status:computeCompStatus(c)}));
  _renderProgressStrip(all);
  const sections=_pickerSections();
  const otherSection=document.getElementById('comp-other-section');
  if(otherSection)otherSection.hidden=sections.length<2;
  for(const sec of sections)_renderCompSection(sec,all.filter(sec.pick),q);
}

function _renderCompSection(sec,rows,q){
  let list=rows;
  // v8.6.0 — an event in its LATE-ENTRY window is still joinable, so the ACTIVE
  // filter keeps it. Filed under "Ended" and hidden by the default filter, a card
  // the participant can still play is indistinguishable from a broken feature and
  // gets reported as one (v7.14.2) — and the join link they just used pointed them
  // straight at it.
  const mode=sec.mode();
  if(mode==='active')list=list.filter(c=>c._status!=='ended'||c.late_entry_window_open);
  if(q)list=list.filter(c=>String(c.name||'').toLowerCase().includes(q));
  const grid=document.getElementById(sec.gridId);
  if(!grid)return;
  // v7.20.11 — the default filter HIDES ended competitions, so a participant
  // whose events have all finished used to land on a bare "No competitions
  // found." while S.myCompetitions held three of them. The All button was right
  // there and nothing said it would reveal anything. State the real total, and
  // when the filter is what emptied the list, say so.
  // v8.12.0 — an EMPTY section is not a FILTERED one: with nothing to hide the
  // count line must not blame the filter ("every event is hidden by the current
  // filter") over the empty state that says the real thing. Pre-existing for
  // any zero-enrolment participant; the staff-tagged user's own section made it
  // the default state of every admin toggling into participant view.
  setListCount(sec.gridId,{matched:list.length,total:rows.length,filtered:(mode==='active'||!!q)&&rows.length>0,queried:!!q});
  if(!list.length){
    const _hidden=rows.length;
    // v8.8.6 — UNDER A SCOPED IMPERSONATION, "No events found." IS A LIE. An event
    // admin looking at somebody's screen sees only the events they themselves
    // organise, so a participant enrolled entirely elsewhere renders an empty grid
    // — and the ordinary copy would tell the organiser this person is in nothing,
    // which is exactly the wrong conclusion to hand somebody who is diagnosing.
    //
    // The SERVER says which of the two states this is (`impersonation.scoped_to_my_events`
    // on /api/me, which is never cached), because the client cannot tell an empty
    // enrolment from a narrowed one by looking at an empty array. Follows the
    // v7.20.11 rule that an emptied list states the real situation rather than a
    // bare negative.
    const _impSc=S.impersonation&&S.impersonation.scoped_to_my_events;
    const _withheld=(S.impersonation&&S.impersonation.withheld_event_count)||0;
    // v8.12.0 — a staff member's OWN section can genuinely be empty: they have
    // been put in nothing. Say that, rather than "No events found" under a
    // heading that reads "Your Events" while the section beneath lists the whole
    // platform.
    const _staffOwnEmpty=sec.key==='own'&&S.isUserStaff;
    setSafeHtml(grid, _hidden
      ? (q
        ? `<p class="grid-empty">No events match <strong>${esc(q)}</strong>${mode==='active'?' among the active ones — choose <strong>All</strong> above to search the ended ones too':''}.</p>`
        : `<p class="grid-empty">No active events — ${esc(String(_hidden))} ${_hidden===1?'has':'have'} already ended. Choose <strong>All</strong> above to see ${_hidden===1?'it':'them'}.</p>`)
      : (_impSc
        ? `<p class="grid-empty">You organise none of this participant's events, so none are shown here.${_withheld?` They are enrolled in ${esc(String(_withheld))} event${_withheld===1?'':'s'} outside your remit.`:''}</p>`
        : (_staffOwnEmpty
          ? '<p class="grid-empty">You have not been added to any event. Every event you can enter as staff is listed below.</p>'
          : '<p class="grid-empty">No events found.</p>')));
    return;
  }
  // What is playable leads: live, then late entry, then upcoming, then ended —
  // the server's order kept within each band (a stable sort on a copy).
  const _band=c=>c._status==='live'?0:(c._status==='ended'&&c.late_entry_window_open)?1:c._status==='upcoming'?2:3;
  list=list.slice().sort((a,b)=>_band(a)-_band(b));
  setSafeHtml(grid, list.map(c=>_compCardHtml(c)).join(''));
  _wireCompCountdowns(list);
  applyReveal(grid);
}

function _compCardHtml(c){
    const slots=c.timeslots||[];
    const isMulti=slots.length>0;
    const start=new Date(c.start_time);
    const end=c.ended_at?new Date(c.ended_at):new Date(start.getTime()+c.duration_minutes*60000);
    // v6.16.46 — pulsing dot on LIVE badges per design system. The
    // .live-dot class carries the green-glow + scale-pulse animation
    // (defined in styles.css). Reduced-motion disables the pulse.
    // v8.6.0 — an ended event whose late window is open says BOTH: it has ended,
    // and late entries are still open. Replacing the Ended badge would be the
    // wrong answer — the event really is over for everybody who was in it — so the
    // late chip rides alongside rather than instead.
    const lateOpen=c._status==='ended'&&!!c.late_entry_window_open;
    const statusBadge=(c._status==='live'?'<span class="status-badge live"><span class="live-dot"></span>Live</span>'
      :c._status==='upcoming'?'<span class="status-badge upcoming">Upcoming</span>'
      :'<span class="status-badge ended">Ended</span>')
      +(lateOpen?'<span class="status-badge late-entry">Late entry open</span>':'');
    const sessionCount=isMulti?`<span class="comp-session-count">${slots.length} sessions</span>`:'';
    // An open-ended Program's end reads "No fixed deadline" (the server's
    // `open_ended`; operator ruling, 14 Nov 2026), its start kept. The card's one
    // place for the words: its countdown line stays empty while it is live, and
    // counts down to the start before then (_wireCompCountdowns).
    const timeLabel=isMulti?'':`<div class="comp-time">${fmtDt(start,'long')} &rarr; ${esc(eventEndText(c,end,'long'))}</div>`;
    const isInternal=(c.tags||[]).includes(DRY_RUN_TAG);
    const internalBadge=isInternal?`<span class="badge draft" title="A test / dry run — it works like any other event">${DRY_RUN_TAG}</span>`:'';
    // v8.12.0 — a staff member COMPETING in this event is told so on the card:
    // it is the one fact that decides whether the confirmations apply to them
    // and whether they are on the board, and the two sections alone cannot say
    // it (an own event can be one they merely spectate, on an event where staff
    // do not compete). Never rendered for an ordinary participant, for whom
    // competing is not news.
    const competingBadge=S.isUserStaff&&c.competing?'<span class="status-badge competing" title="Staff compete in this event and you are enrolled in it — you are on the board">Competing</span>':'';
    const statusLabel=(c._status==='live'?'live':c._status==='upcoming'?'upcoming':'ended')+(lateOpen?', late entry open':'')+(competingBadge?', competing':'');
    // v7.21.19 (audit F8) — the ACCESSIBLE name must say what the badge says.
    // The v7.21.18 rename swept the visible text and left this behind, so a
    // screen-reader user heard "internal" while the screen said "test/dry run".
    // v8.1.0 (PR 13) — the kind chip, and its label joins the ACCESSIBLE name for
    // the same reason the dry-run marker did in v7.21.19 (F8): a screen-reader
    // user must hear what the card says. eventKindLabel returns null when the
    // vocabulary is absent, and both the chip and this clause then render
    // nothing — the card keeps its name, status and dates and loses only the kind.
    const kindLabel=eventKindLabel(c.event_kind);
    const srLabel=`${esc(c.name)}, ${statusLabel}${kindLabel?`, ${esc(kindLabel)}`:''}${isInternal?`, ${DRY_RUN_TAG}`:''}`;
    // v6.16.46 — bento span. LIVE comps get featured at span-8 (2/3
     // of a 12-col bento on desktop); upcoming/ended pack into span-4
     // (1/3). At ≤900px the bento collapses to 6-col and span-4 → span-6
     // (becomes full-width); at ≤600px to 4-col and everything is full-
     // width. Pure layout opt-in — no visual change to .comp-card itself.
    const bentoSpan = c._status === 'live' ? 'bento-span-8' : 'bento-span-4';
    // THE CONTROL IS THE EVENT'S NAME, NOT THE CARD — the task grid's rule
    // (renderTasks in participant-tasks.js says why): the name a control carries
    // must open with the text it shows (WCAG 2.5.3), and a whole card shows its
    // badges, dates and countdown as well. The card keeps data-action, so a click
    // anywhere on it still picks the event.
    // WHAT IS WAITING, in one line, and the word the card's arrow says. Both are
    // decoration around the title button (aria-hidden on the arrow; the line is
    // ordinary text): the control and its name are unchanged.
    const _cat=lateOpen?'late':c._status;
    const waiting=_cat==='live'
      ?(isMulti?`${slots.length} sessions — pick yours and start solving.`:'Challenges are open. Your clock starts when you enter.')
      :_cat==='late'?'Late entries are still open — you can still play.'
      :_cat==='upcoming'?(isMulti?`${slots.length} sessions to choose from. Pick one now and be ready.`:'Challenges unlock the moment it starts. Get ready.')
      :'Finished. Look back over the challenges and how it went.';
    const enterWord=_cat==='live'||_cat==='late'?'Enter':_cat==='upcoming'?'Get ready':'Review';
    return`<div class="comp-card ev-card ev-${esc(_cat)} ${bentoSpan}${isInternal?' internal':''}" data-action="pick-competition" data-comp-id="${esc(c.id)}" data-status="${esc(c._status)}">
      <div class="comp-card-meta">
        ${statusBadge}${competingBadge}${internalBadge}${eventKindChipHtml(c.event_kind)}${sessionCount}
      </div>
      <div class="comp-name"><button type="button" class="card-open" aria-label="${srLabel}">${esc(c.name)}</button></div>
      <p class="ev-waiting">${esc(waiting)}</p>
      ${timeLabel}
      <div class="ev-foot">
        <div class="comp-countdown" id="comp-cd-${c.id}"></div>
        <span class="ev-enter" aria-hidden="true">${enterWord}${ICO.chevronRight}</span>
      </div>
    </div>`;
}

function _wireCompCountdowns(list){
  // Start ticking countdowns
  list.forEach(c=>{
    const el=document.getElementById('comp-cd-'+c.id);
    if(!el)return;
    const slots=c.timeslots||[];
    const isMulti=slots.length>0;
    let cdStart,cdEnd;
    if(isMulti){
      // Upcoming: earliest slot start. Live: latest slot end.
      const slotStarts=slots.map(s=>new Date(s.start_time).getTime());
      const slotEnds=slots.map(s=>{const st=new Date(s.start_time).getTime();return s.ended_at?new Date(s.ended_at).getTime():(st+s.duration_minutes*60000);});
      cdStart=Math.min(...slotStarts);
      cdEnd=Math.max(...slotEnds);
    }else{
      cdStart=new Date(c.start_time).getTime();
      cdEnd=c.ended_at?new Date(c.ended_at).getTime():(cdStart+c.duration_minutes*60000);
    }
    // SAID ONCE ON THE CARD (operator ruling, 14 Nov 2026): an open-ended
    // Program's date line ends "No fixed deadline" (_compCardHtml), so its
    // countdown line stays empty while it is live. A card with no date line
    // (sessions) keeps the words here.
    const endOnDateLine=!isMulti&&c.open_ended===true;
    const tick=()=>{
      const now=Date.now();
      if(c._status==='live'){
        const rem=cdEnd-now;
        setSafeHtml(el, rem>0&&!endOnDateLine?`<span class="ev-cd ev-cd-live">${esc(timeLeftWords(rem,c.open_ended))}</span>`:'');
      }else if(c._status==='upcoming'){
        const rem=cdStart-now;
        setSafeHtml(el, rem>0?`<span class="ev-cd ev-cd-soon">Starts in ${esc(humanSpan(rem))}</span>`:'');
        if(rem<=0){
          // v7.7.26 (audit M15) — the start just passed. Pre-fix this set
          // _status on the PER-RENDER COPY and recursed synchronously:
          // renderCompetitionPicker() rebuilds from S.myCompetitions, whose
          // server-computed c.status still said 'upcoming', and calls tick()
          // synchronously per card — so the recursion re-entered with rem<=0
          // immediately → 'Maximum call stack size exceeded' once per second
          // until the 15s data poll healed the snapshot. Fix: flip the SOURCE
          // row by time arithmetic (earliest-slot-start passed ⇒ live; past
          // the latest end ⇒ ended — matches competitionStatus semantics) and
          // defer the re-render out of the synchronous tick chain. The 15s
          // poll still delivers the server truth afterwards.
          const src=S.myCompetitions.find(x=>x.id===c.id);
          if(src)src.status=now>=cdEnd?'ended':'live';
          setTimeout(()=>{renderCompetitionPicker();},0);
          return;
        }
      }
    };
    tick();
    const iv=setInterval(tick,1000);
    S.compPickerTimers.push(iv);
  });
}

// THE WORDS FOR A PROGRAM WITH NO FIXED DEADLINE: every participant surface
// that shows the time left says them instead while the server's `open_ended` is
// true, never "3652 days left" or a ten-year countdown (an event card says them
// once, on its date line). Their one definition is ui/format.js's, re-exported
// here for the modules that import it from here.
export { NO_FIXED_DEADLINE };
// The time left in words, as the events list and the play bar say it.
export function timeLeftWords(ms,openEnded){
  return openEnded===true?NO_FIXED_DEADLINE:`${humanSpan(ms)} left`;
}

// A span said the way a person reads it on a card: "50 days", "1 day 4 h",
// "3 h 1 min", "12 min", "42 s". The exact clock is the play bar's job.
export function humanSpan(ms){
  const s=Math.max(0,Math.floor(ms/1000));
  const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
  if(d>=2)return `${d} days`;
  if(d===1)return h?`1 day ${h} h`:'1 day';
  if(h>=1)return m?`${h} h ${m} min`:`${h} h`;
  if(m>=1)return `${m} min`;
  return `${s} s`;
}

// ── THE PROGRESS STRIP — the runs this participant has under way ─────────────
//
// Above the event cards, one row per LIVE event this tab has seen the
// participant play (participant-tasks.js progressFor: the challenge list and the
// score reads write it), most recent first and at most three: the same
// position track, time ring and score as the challenge play bar — the SAME
// renderer, playStatsHtml — and a Continue button. Nothing here asks the
// server: it is drawn from what the tab already read, and re-drawn with the
// cards on the list's existing 15 s poll. Where the run stands is one judge,
// participant-tasks.js runStanding, and what the row says about it is
// stripWords below. A run with NOTHING LEFT TO ANSWER (every challenge solved or
// out of attempts, quick questions answered) says All solved or No attempts
// left, shows how many are solved with no current segment, and offers View
// rather than Continue — the same door into the event. It stays on the strip:
// the event is live (its ring and score still move), an organiser's grant can
// reopen a challenge, and a row that vanished with no reason would read as
// broken. It shows the tab's last reading of the challenge list, which only
// entering the event reads again: View is that refresh. An event the tab has never played
// has no position to show, so it is not here; its card is below. A Program has
// no clock worth a ring and is not ranked, so it shows no score readout either:
// its row is the track and Continue.
// On a multi-session event the run is the participant's OWN session (the row's
// `my_session`, as the play bar counts /api/status's window): the ring counts
// it down, and once it has ended the run is over and leaves the strip, though
// the event stays live for the later sessions.
const _STRIP_MAX=3;
/**
 * The row's words for a runStanding: its eyebrow and its button. "No attempts
 * left" only once nothing is left to answer (a quick question still to answer
 * keeps the run In progress, with Continue); never a word claiming completion,
 * which a Program's certificate needs every challenge SOLVED for.
 */
export function stripWords(st){
  const over=!!st&&st.idx<0;
  const eyebrow=st&&st.state==='solved'?'All solved':st&&st.state==='spent'&&over?'No attempts left':st&&st.state==='answered'?'All answered':'In progress';
  return {eyebrow,button:over?'View':'Continue'};
}
function _ownWindow(c){
  const s=c.my_session;
  if(s&&s.start&&s.end)return{status:s.status,start:new Date(s.start).getTime(),end:new Date(s.end).getTime()};
  const start=new Date(c.start_time).getTime();
  const end=c.effective_end?new Date(c.effective_end).getTime()
    :(c.ended_at?new Date(c.ended_at).getTime():start+c.duration_minutes*60000);
  return{status:c._status,start,end};
}
function _renderProgressStrip(all){
  const box=document.getElementById('ev-progress');
  if(!box)return;
  const rows=(Array.isArray(all)?all:[])
    .filter(c=>_ownWindow(c).status==='live'&&c.own!==false&&!staffSpectatorIn(c))
    .map(c=>({c,p:progressFor(c.id)}))
    .filter(x=>x.p&&Array.isArray(x.p.done)&&x.p.done.length)
    .sort((a,b)=>(b.p.at||0)-(a.p.at||0))
    .slice(0,_STRIP_MAX);
  if(!rows.length){box.hidden=true;setSafeHtml(box,'');return;}
  setSafeHtml(box,`<h2 class="sr-only">Picking up where you left off</h2>`+rows.map(({c,p})=>{
    const pol=policyOrDefault(c.policy);
    const ranked=!!pol.ranking_enabled;
    const deadline=pol.schedule==='deadline';
    // The run is AT the first challenge still to play: neither solved nor out
    // of attempts (recorded in `out`, #283), as Next challenge passes over one;
    // with none left it is over (runStanding idx -1).
    const st=runStanding(p);
    const w=stripWords(st);
    const quick=Array.isArray(p.quick)?p.quick:[];
    const out=Array.isArray(p.out)?p.out:[];
    return `<div class="ev-prog${deadline?' ev-prog-program':''}" data-comp-id="${esc(c.id)}">
      <div class="ev-prog-name"><span class="eyebrow ink">${esc(w.eyebrow)}</span><strong>${esc(c.name)}</strong></div>
      <div class="ev-prog-stats">${playStatsHtml({done:p.done,quick,out,idx:st.idx,over:st.idx<0,gauge:!deadline,score:ranked&&typeof p.score==='number'?p.score:null})}</div>
      <button type="button" class="btn ev-prog-go" data-action="pick-competition" data-comp-id="${esc(c.id)}" data-status="live" aria-label="${esc(w.button)} — ${esc(c.name)}">${esc(w.button)}${ICO.chevronRight}</button>
    </div>`;
  }).join(''));
  box.hidden=false;
  const ticks=rows.filter(x=>policyOrDefault(x.c.policy).schedule!=='deadline').map(({c})=>{
    const g=box.querySelector(`.ev-prog[data-comp-id="${CSS.escape(c.id)}"] .qa-gauge`);
    const w=_ownWindow(c);
    return ()=>paintGauge(g,w.end,w.start,false);
  });
  if(!ticks.length)return;
  const tick=()=>{for(const f of ticks)f();};
  // After layout, so the first paint can measure the ring it fits its words to.
  requestAnimationFrame(tick);
  S.compPickerTimers.push(setInterval(tick,1000));
}

export async function pickCompetition(compId,status){
  if(status==='live'){
    const comp=S.myCompetitions.find(c=>c.id===compId);
    const name=comp?.name||'this event';

    if(staffSpectatorIn(comp)){
      // Staff SPECTATING skip all enter/switch confirmations (v8.12.0: a staff
      // member who COMPETES in this event is asked like any participant).
      S.lastLiveCompetitionId=null;
    }else if(S.lastLiveCompetitionId===compId){
      S.lastLiveCompetitionId=null;
      // Re-entering the same live competition the user just left — no warning needed
    }else if(S.lastLiveCompetitionId){
      // Switching from one live competition to another
      const prevComp=S.myCompetitions.find(c=>c.id===S.lastLiveCompetitionId);
      const prevName=prevComp?.name||'your previous event';
      const prevStillLive=prevComp&&computeCompStatus(prevComp)==='live';
      if(prevStillLive){
        const ok=await showModal({
          title:'Switch Event?',
          message:`You were in <strong>${esc(prevName)}</strong> (still live).<br><br>You are about to switch to <strong>${esc(name)}</strong>. From this point on, you will be taken directly to this new event each time you log in, until it ends.<br><br>Are you sure?`,
          confirmText:'Switch',
          confirmClass:'',
          cancelText:'Go Back'
        });
        if(!ok)return;
      }
      S.lastLiveCompetitionId=null;
    }else{
      // Entering a live competition fresh (no previous live competition)
      const ok=await showModal({
        title:'Enter Live Event',
        message:`You are about to enter <strong>${esc(name)}</strong>.<br><br>From this point on, you will be taken directly to this event each time you log in, until it ends.<br><br>Are you sure you want to proceed?`,
        confirmText:'Enter Event',
        confirmClass:'',
        cancelText:'Go Back'
      });
      if(!ok)return;
    }
  }
  const ok=await selectCompetition(compId);
  if(ok===false)return;
  if(ok==='needsTimeslot'){
    showTimeslotPicker();
    return;
  }
  // If multi-slot with chosen timeslot, use the timeslot's status for navigation
  // routeVerdict is handed the already-resolved `status` as the fallback; the
  // needsTimeslot / false arms were taken above, so only enter|pending remain.
  if(routeVerdict(true,status)==='enter'){
    showMain('tasks-page');
    enterCompetitionView();
  }else{
    showPendingPageForCompetition();
  }
}

export async function selectCompetition(compId){
  // ext-audit v7.15.14 — invalidate every in-flight participant read for the
  // competition we are leaving (see S._compGen).
  S._compGen++;
  // ext-audit v7.15.15 — LATEST INTENT WINS.
  //
  // Bumping _compGen invalidated in-flight READS, but the selection itself had
  // no ordering: pick A then B, let B's response arrive first, and A's late
  // response still committed — leaving the UI on A while the SERVER session was
  // on B, i.e. the app showing a competition the participant is not in. The
  // sequence token here is the same pattern as the admin list loaders, applied
  // to the write that establishes context.
  const _sel=++S._compSelectSeq;
  // v8.14.4 — no X-Competition-Id while the session moves (S._compSelecting).
  // The count drops only once the tab's own record names the new event, so
  // nothing in between is sent naming the old one.
  S._compSelecting++;
  let d;
  try{
    const r=await fetch('/api/select-competition',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({competitionId:compId})});
    if(_sel!==S._compSelectSeq)return false;              // superseded by a newer pick
    if(!r.ok){
      const e=await r.json().catch(()=>({}));
      if(e.error==='profile_incomplete'){
        // Participants only: the gate is non-dismissible and would cover an
        // admin tier's way back to the panel (see loadMyCompetitions above).
        if(S.userRole==='participant'){await openProfileCompletionGate(e.missing||[]);return selectCompetition(compId);}
        showToast('Your profile is incomplete — complete it from your profile, or use Admin View to go back.','error');return false;
      }
      showToast(e.error||'Failed to select event.','error');return false;
    }
    d=await r.json().catch(()=>null);
    if(_sel!==S._compSelectSeq)return false;              // re-check after the body parse
    if(!d){showToast('Failed to select event.','error');return false;}
    S.currentCompetitionId=compId;
  }finally{S._compSelecting--;}
  const comp=d.competition||{};
  S.currentCompName=comp.name||'Tournament';
  S.currentCompStatus=comp.status||null;
  // v8.1.0 (PR 18) — the suppression layer's input, written where the status is.
  S.currentCompPolicy=comp.policy||null;
  S._currentTimeslots=d.timeslots||[];
  S._currentChosenTimeslot=d.chosenTimeslot||null;
  S._competitionFullyEnded=comp.fully_ended||false;
  if(comp.status==='live')S.lastLiveCompetitionId=compId;
  document.querySelectorAll('.current-comp-name').forEach(el=>el.textContent=S.currentCompName);
  updateParticipantNav();
  refreshScore();
  // If multi-slot and needs choice, return 'needsTimeslot' so caller can show picker
  if(d.needsTimeslotChoice) return 'needsTimeslot';
  return true;
}

export function _isCurrentCompInternal(){
  if(!S.currentCompetitionId||!S.myCompetitions)return false;
  const c=S.myCompetitions.find(c=>c.id===S.currentCompetitionId);
  return c&&(c.tags||[]).includes(DRY_RUN_TAG);
}

export function showTimeslotPicker(){
  // Ensure the page element exists before showing
  if(!document.getElementById('timeslot-picker-page')){
    const page=document.createElement('div');
    page.id='timeslot-picker-page';
    page.className='page';
    page.style.display='none';
    setSafeHtml(page, `<div class="ts-picker-wrap">
      <h2 id="ts-picker-title"></h2>
      <p class="ts-picker-subtitle">Choose a session to participate in. You can change your choice until your session goes live.</p>
      <div id="timeslot-picker-content" class="ts-picker-list"></div>
      <button class="btn secondary ts-picker-back-btn" data-action="nav-show-competitions-page">${ICO.arrowLeft} Back to Events</button>
    </div>`);
    document.getElementById('main-content').appendChild(page);
  }
  document.getElementById('ts-picker-title').textContent=S.currentCompName;
  renderTimeslotPicker();
  showPage('timeslot-picker-page');
  document.getElementById('main-nav').style.display='';
  document.getElementById('user-info').style.display='flex';
  // The signed-in header, as showMain gives it: showPage strips `is-app` (the
  // signed-out header), which drew the nav inside the header with the active
  // Events tab's label unreadable and the loose signed-out buttons back.
  document.getElementById('app-header')?.classList.add('is-app');
}

export function clearTsPickerTimers(){S._tsPickerTimers.forEach(clearInterval);S._tsPickerTimers=[];}

export function renderTimeslotPicker(){
  clearTsPickerTimers();
  const content=document.getElementById('timeslot-picker-content');
  if(!content)return;
  // Defensive: an admin may have deleted the timeslot the user already chose.
  // Drop the stale reference so the "Your Session" badge doesn't appear next to
  // nothing and so the live-session warning logic doesn't compare to a ghost.
  if(S._currentChosenTimeslot && !S._currentTimeslots.find(t=>t.id===S._currentChosenTimeslot.id)){
    S._currentChosenTimeslot=null;
  }

  // Check if all sessions have ended — show read-only state
  const allEnded=S._currentTimeslots.length>0&&S._currentTimeslots.every(ts=>computeCompStatus(ts)==='ended');
  // Staff looking at an event they do not compete in can still open any
  // session, ended ones included, to read its challenges and board.
  const viewer=staffSpectatorIn(currentCompetitionRow());
  if(allEnded&&!viewer){
    setSafeHtml(content, `<div class="ts-all-ended-note">
      <p>All sessions for this event have ended.</p>
    </div>`+S._currentTimeslots.map(ts=>{
      const tsStart=new Date(ts.start_time);
      const tsEnd=new Date(tsStart.getTime()+ts.duration_minutes*60000);
      return`<div class="comp-card ended-readonly">
        <div class="ts-row">
          <span class="status-badge ended">Ended</span>
        </div>
        <div class="comp-name">${esc(ts.name)}</div>
        <div class="comp-time">${fmtDt(tsStart,'long')} &rarr; ${fmtDt(tsEnd,'long')}</div>
      </div>`;
    }).join(''));
    return;
  }

  const chosen=S._currentChosenTimeslot;
  setSafeHtml(content, S._currentTimeslots.map(ts=>{
    const isChosen=chosen&&chosen.id===ts.id;
    const tsStatus=computeCompStatus(ts);
    const tsStart=new Date(ts.start_time);
    const tsEnd=new Date(tsStart.getTime()+ts.duration_minutes*60000);
    const statusBadge=tsStatus==='live'?'<span class="status-badge live"><span class="live-dot"></span>Live</span>':tsStatus==='ended'?'<span class="status-badge ended">Ended</span>':'<span class="status-badge upcoming">Upcoming</span>';
    const isDisabled=tsStatus==='ended'&&!viewer;
    const chosenBadge=isChosen?`<span class="ts-chosen-badge">${ICO.check} Your Session</span>`:'';
    const liveWarning=tsStatus==='live'&&!isChosen&&!staffSpectatorIn(currentCompetitionRow())?`<div class="ts-live-warning">${ICO.alertTriangle} This session is live — your choice will be final</div>`:'';
    const _tsInt=_isCurrentCompInternal();
    const _tsIntBadge=_tsInt?`<span class="badge draft ts-internal-badge" title="Session of a test / dry run event">${DRY_RUN_TAG}</span>`:'';
    const classes=['comp-card'];
    if(isDisabled)classes.push('disabled');
    if(isChosen)classes.push('selected');
    if(_tsInt)classes.push('internal-ts');
    // The session's NAME is the control, as on the event cards above; its name
    // opens with the session name it shows, then the state and the action.
    const tsName=`${esc(ts.name)}, ${esc(tsStatus)}${isChosen?', your session':''} — choose this session`;
    return`<div class="${classes.join(' ')}" ${_tsInt?'title="Session of a test / dry run event"':''} ${isDisabled?'':`data-action="choose-timeslot" data-ts-id="${esc(ts.id)}" data-status="${esc(tsStatus)}"`} data-ts-id="${ts.id}">
      <div class="ts-row">
        ${statusBadge}${_tsIntBadge}${chosenBadge}
      </div>
      <div class="comp-name">${isDisabled?esc(ts.name):`<button type="button" class="card-open" aria-label="${tsName}">${esc(ts.name)}</button>`}</div>
      <div class="comp-time">${fmtDt(tsStart,'long')} &rarr; ${fmtDt(tsEnd,'long')}</div>
      <div class="comp-countdown" id="ts-cd-${ts.id}"></div>
      ${liveWarning}
    </div>`;
  }).join(''));

  // Start ticking countdowns for sessions
  S._currentTimeslots.forEach(ts=>{
    const el=document.getElementById('ts-cd-'+ts.id);
    if(!el)return;
    const tsStatus=computeCompStatus(ts);
    if(tsStatus==='ended')return;
    const tsStart=new Date(ts.start_time).getTime();
    const tsEnd=ts.ended_at?new Date(ts.ended_at).getTime():(tsStart+ts.duration_minutes*60000);
    const tick=()=>{
      const now=Date.now();
      if(tsStatus==='live'){
        const rem=tsEnd-now;
        setSafeHtml(el, rem>0?'<span style="color:var(--green)">Time remaining: '+formatDuration(rem)+'</span>':'');
      }else if(tsStatus==='upcoming'){
        const rem=tsStart-now;
        setSafeHtml(el, rem>0?'<span style="color:var(--yellow)">Starts in: '+formatCountdown(rem)+'</span>':'');
        if(rem<=0){
          // v7.7.26 (audit M14) — same recursion as the competition picker:
          // renderTimeslotPicker() recomputes each card's status from the
          // stale server snapshot on the ts row (still 'upcoming') and calls
          // tick() synchronously, so a synchronous re-render from inside a
          // tick recursed until stack overflow, once per second, and the
          // card never flipped to Live. Flip the source row's status by time
          // arithmetic and defer the re-render.
          ts.status=now>=tsEnd?'ended':'live';
          setTimeout(()=>{renderTimeslotPicker();},0);
          return;
        }
      }
    };
    tick();
    const iv=setInterval(tick,1000);
    S._tsPickerTimers.push(iv);
  });
}

export async function chooseTimeslot(tsId,tsStatus){
  const confirmLive=tsStatus==='live'&&!staffSpectatorIn(currentCompetitionRow()); // v8.12.0 — a competing staff member's choice is as final as anybody's
  if(confirmLive){
    const ok=await showModal({title:'Join Live Session',message:'This session is currently live. Once you join, you cannot change your choice.<br><br>Are you sure?',confirmText:'Join Now',confirmClass:'warning'});
    if(!ok)return;
  }
  S._compGen++;   // ext-audit v7.15.14 — a slot switch invalidates in-flight reads too
  const _sel=++S._compSelectSeq;   // ext-audit v7.15.15 — latest intent wins (see selectCompetition)
  const r=await fetch('/api/select-timeslot',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({timeslotId:tsId,confirmLive})});
  if(_sel!==S._compSelectSeq)return;                   // superseded by a newer pick
  const d=await r.json().catch(()=>null);
  if(_sel!==S._compSelectSeq)return;                   // re-check after the body parse
  if(!d){showToast('Failed.','error');return;}
  if(d.requireConfirmation){
    const ok=await showModal({title:'Join Live Session',message:esc(d.message||''),confirmText:'Yes, Join',confirmClass:'danger'});
    if(!ok)return;
    return chooseTimeslot(tsId,'live'); // Re-call with confirmation
  }
  if(!r.ok){showToast(d.error||'Failed.','error');return;}
  S._currentChosenTimeslot=d.timeslot;
  showToast(`Joined session: ${d.timeslot.name}`,'success');
  const navStatus=d.timeslot.status;
  if(navStatus==='live'||navStatus==='ended'){   // ended: staff opening a finished session to look
    showMain('tasks-page');
    enterCompetitionView();
  }else{
    showPendingPageForCompetition();
  }
}

export function showCompetitionsPage(){
  clearCompTimers();clearTsPickerTimers();
  if(S.timerInterval){clearInterval(S.timerInterval);S.timerInterval=null;}
  // audit v7.7.36 (P4) — leaving a live competition for the picker must also stop
  // the 15s status + leaderboard polls (started by startHackathonTimer/
  // startLeaderboardPoll). Pre-fix they leaked: the status poll kept hitting
  // /api/status for the LEFT comp and, when it ended, fired a stale "Competition
  // Ended" modal (with dismiss-ended side effects) over the picker; the lb poll
  // kept calling /api/me every 15s. Mirror ejectToCompetitionPicker's teardown.
  if(S.statusPollInterval){clearInterval(S.statusPollInterval);S.statusPollInterval=null;}
  if(S.lbInterval){clearInterval(S.lbInterval);S.lbInterval=null;}
  S._inLiveCompetition=false;
  document.getElementById('header-timer').style.display='none';
  // The day chip belongs to the countdown beside it: on the list there is no
  // event, so "Day 11 of 50" would describe the one just left.
  const _day=document.getElementById('header-day');
  if(_day){_day.hidden=true;_day.textContent='';}
  // v8.3.8 — arriving at the event list MEANS the participant is not in an
  // event, so the server is told: it drops the session pointer and the durable
  // auto-resume marker, which is the whole opt-out from being taken straight
  // back in on the next sign-in.
  //
  // BOTH deliberate routes to this page funnel through here — the Events nav
  // item (via handleCompetitionsNav) and the session picker's "Back to
  // Competitions" — which is why the call lives at this one site rather than at
  // each of them. The forced eject (removed from an event) does NOT come this
  // way and does not need to: the server clears the marker in the removal.
  //
  // Fire-and-forget on purpose. This page is about to render regardless, and a
  // navigation that could fail on a flaky network because a bookkeeping write
  // did not land would be a worse answer than one stale resume — which itself
  // costs a single click on Events to undo.
  //
  // v8.14.4 — AND THE TAB LEAVES TOO, before the server is told. Every way here
  // (the Events item, the session picker's Back) clears the tab's event and
  // bumps the generation, or the tab would sit on the list still naming the
  // event the server has just forgotten, and its own next request would be
  // announced as another tab's move (see ejectToCompetitionPicker). A pick still
  // in flight (the pending page's poll re-selects) is superseded, or its answer
  // would put the event back after this.
  S._compSelectSeq++;S._compGen++;S.currentCompetitionId=null;S.currentCompStatus=null;S.currentCompPolicy=null;updateParticipantNav();
  S._leaveInFlight=fetch('/api/deselect-competition',{method:'POST',headers:csrfHeaders()}).then(()=>{},e=>console.warn('Leaving the event was not recorded',e));
  showMain('competitions-page');
}

/**
 * v8.1.0 — leave the event the participant is currently looking at.
 *
 * Confirmed first, and the copy says what is and is not lost: the score is
 * preserved by the absence-row path the server reuses, so re-joining is
 * lossless — but a Booth Event with a full ceiling may not have a place left,
 * which is the one consequence they cannot undo alone.
 */
export async function leaveCompetition(){
  const comp=S.myCompetitions.find(c=>c.id===S.currentCompetitionId);
  if(!comp)return;
  const ok=await showModal({
    title:'Leave this event?',
    message:`You'll be removed from <strong>${esc(comp.name)}</strong>. Anything you've already solved is kept, so you can re-join later — but if the event has a limit on how many people can join themselves, your place may be taken by then.`,
    confirmText:'Leave event',
    confirmClass:'danger',
    cancelText:'Stay',
  });
  if(!ok)return;
  try{
    const r=await fetch(`/api/competitions/${encodeURIComponent(comp.id)}/leave`,{method:'POST',headers:csrfHeaders()});
    const d=await r.json().catch(()=>({}));
    if(!r.ok){showToast(d.error||'Could not leave the event.','error');return;}
    showToast(`You have left ${comp.name}.`,'success');
    // Re-read rather than patching the local list: leaving clears the active
    // competition server-side, and the picker must render from the same answer
    // everything else does.
    try{const me=await fetch('/api/me');if(me.ok)S.currentUser=await me.json();}catch(e){console.warn('Could not refresh your account',e);}
    S.myCompetitions=(S.currentUser&&S.currentUser.competitions)||[];
    S._compGen++;   // v8.14.4 — every writer of the tab's event bumps it (see ejectToCompetitionPicker)
    S.currentCompetitionId=null;
    ejectToCompetitionPicker();
  }catch(_){showToast('Could not leave the event — check your connection.','error');}
}

export async function showPendingPageForCompetition(){
  const comp=S.myCompetitions.find(c=>c.id===S.currentCompetitionId);
  if(!comp)return;
  const ts=S._currentChosenTimeslot;
  const startISO=ts?ts.start_time:comp.start_time;

  // Title: "CompName → SessionName" or just "CompName"
  const titleText=ts?`${comp.name} → ${ts.name}`:comp.name;
  document.getElementById('pending-title').textContent=titleText;
  // Internal visual cue on pending page — stripe the card (not the page
   // container) so the cue sits on the actual visual surface.
  const pendEl=document.getElementById('pending-page');
  const pendCard=pendEl.querySelector('.pending-card');
  if((comp.tags||[]).includes(DRY_RUN_TAG)){
    if(pendCard)pendCard.style.borderLeft='3px solid var(--yellow)';
    pendEl.title='Test / dry run event';
  }else{
    if(pendCard)pendCard.style.borderLeft='';
    pendEl.title='';
  }
  document.querySelectorAll('.current-comp-name').forEach(el=>el.textContent=comp.name);
  // v8.1.0 — the server decides. `can_leave` is false for a membership an
  // organiser created and for a finished event, and the route re-checks the
  // identical predicate — so the control is never offered for something that
  // would be refused (v7.14.2: gate the affordance and the explanation together).
  const leaveBox=document.getElementById('pending-leave');
  if(leaveBox)leaveBox.hidden=!comp.can_leave;

  document.getElementById('main-nav').style.display='';
  document.getElementById('user-info').style.display='flex';
  document.querySelectorAll('.page').forEach(p=>{p.style.display='none';p.classList.remove('active');});
  document.getElementById('pending-page').style.display='block';
  document.getElementById('pending-page').classList.add('active');
  document.getElementById('pending-back-btn').style.display='';
  document.getElementById('pending-start-label').textContent=fmtDt(startISO,'long');

  // Show "Change Session" button for multi-slot competitions
  const changeSessionEl=document.getElementById('pending-change-session');
  if(changeSessionEl){
    if(S._currentTimeslots.length>0&&ts){
      setSafeHtml(changeSessionEl, `<button class="btn secondary" data-action="show-timeslot-picker">Change Session</button>`);
      changeSessionEl.style.display='';
    }else{
      changeSessionEl.style.display='none';
    }
  }
  const tick=()=>{
    const liveComp=S.myCompetitions.find(c=>c.id===S.currentCompetitionId);
    // audit v7.7.37 (C18) — re-read the chosen timeslot FRESH each tick. The 15s
    // compDataPoll updates S._currentChosenTimeslot when an admin postpones the
    // session; pre-fix the tick used the closure-captured `ts`, so the countdown
    // kept targeting the OLD start and, on hitting zero, navigated to the tasks page
    // → /api/tasks 403 (not started) → ejected to the picker with a scary toast
    // instead of showing the updated start time.
    const liveTs=S._currentChosenTimeslot||null;
    const liveStart=liveTs?liveTs.start_time:(liveComp?liveComp.start_time:startISO);
    const diff=new Date(liveStart)-Date.now();
    if(diff<=0){
      // v7.7.26 (audit M16) — if the server just told us the window hasn't
      // started (the local clock runs ahead), hold here instead of
      // re-navigating to the tasks page every second (loadTasks would 403
      // and bounce straight back — a visible flash loop). Retry in ~10s.
      if(Date.now()<(S._notStartedRetryAt||0)){
        document.getElementById('pending-countdown').textContent='Starting soon…';
        return;
      }
      stopCompDataPoll();showMain('tasks-page');enterCompetitionView();updateParticipantNav();return;
    }
    document.getElementById('pending-countdown').textContent=formatCountdown(diff);
    document.getElementById('pending-start-label').textContent=fmtDt(liveStart,'long');
  };
  tick();if(S.timerInterval)clearInterval(S.timerInterval);S.timerInterval=S._pollsHalted?null:setInterval(tick,1000);
  startCompDataPoll();
  loadReminderStatus(S.currentCompetitionId);
}

export async function loadReminderStatus(compId){
  const el=document.getElementById('pending-reminder');
  if(!el)return;
  // Use the chosen timeslot's start time if available, otherwise competition start
  const ts=S._currentChosenTimeslot;
  const startTime=ts?ts.start_time:(S.myCompetitions.find(c=>c.id===compId)?.start_time);
  const msUntilStart=startTime?new Date(startTime).getTime()-Date.now():0;
  if(msUntilStart<3600000){setSafeHtml(el, '');return;}
  try{
    const r=await fetch(`/api/competitions/${compId}/reminder`);
    const d=await r.json();
    if(d.requested){
      setSafeHtml(el, `<p class="pending-reminder-set">\u2713 Email reminder set \u2014 you'll be notified 1 hour before start</p>`);
    }else{
      setSafeHtml(el, `<button class="btn secondary" data-action="request-reminder" data-comp-id="${esc(compId)}">\ud83d\udd14 Remind me 1 hour before start</button>`);
    }
  }catch{setSafeHtml(el, '');}
}

export async function requestReminder(compId){
  const r=await fetch(`/api/competitions/${compId}/reminder`,{method:'POST',headers:csrfHeaders()});
  if(r.ok){
    // v8.12.6 (sweep) — the button is offered while the start is an hour or more
    // away and stays clickable as the clock runs (or after an admin moves the
    // start earlier), and a reminder whose hour has already begun is sent at
    // once. The SERVER says which (`immediate`); `=== true`, so a response that
    // predates the field keeps the original sentence rather than a guess.
    const d=await r.json().catch(()=>({}));
    showToast(d.immediate===true
      ?'Reminder set! The event starts in under an hour, so the reminder email is on its way now.'
      :'Reminder set! You\'ll receive an email 1 hour before the event starts.');
    loadReminderStatus(compId);
  }else{
    const d=await r.json().catch(()=>({}));
    showToast(d.error||'Failed to set reminder.','error');
  }
}

export function showPendingPage(startISO){
  showPage('pending-page');
  // Show the back-to-competitions button so a participant who lands here from a
  // bookmark / direct URL is not trapped — they can always navigate back to
  // their competition list (or the login screen if they have none).
  document.getElementById('pending-back-btn').style.display='';
  document.getElementById('pending-start-label').textContent='Starts at: '+fmtDt(startISO,'long');
  const tick=()=>{
    const diff=new Date(startISO)-Date.now();
    if(diff<=0){location.reload();return;}
    document.getElementById('pending-countdown').textContent=formatCountdown(diff);
  };
  tick();setInterval(tick,1000);
}

export function showPendingApprovalPage(eventName){
  document.querySelectorAll('.page').forEach(p=>{p.style.display='none';p.classList.remove('active');});
  document.getElementById('main-nav').style.display='none';
  document.getElementById('user-info').style.display='none';
  // audit v7.7.33 (AL1) — render into a DEDICATED page element, never the shared
  // #pending-page. Pre-fix this setSafeHtml'd over #pending-page, destroying its
  // static children (pending-title / -countdown / -start-label / -reminder / …)
  // that showPendingPage + showPendingPageForCompetition dereference UNGUARDED —
  // so any later upcoming-competition flow in the same SPA session threw
  // "Cannot set properties of null". A separate page leaves #pending-page intact.
  let container=document.getElementById('pending-approval-page');
  if(!container){
    container=document.createElement('div');
    container.id='pending-approval-page';
    container.className='page';
    (document.getElementById('pending-page')?.parentElement||document.body).appendChild(container);
  }
  {
    container.style.display='';
    container.classList.add('active');
    setSafeHtml(container, `<div style="display:flex;align-items:center;justify-content:center;flex:1;padding:24px">
      <div class="card" style="max-width:min(480px, calc(100vw - 32px));width:100%;text-align:center">
        <div style="margin-bottom:12px;display:flex;justify-content:center;color:var(--accent2)"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2h12"/><path d="M6 22h12"/><path d="M6 2v6l6 4-6 4v6"/><path d="M18 2v6l-6 4 6 4v6"/></svg></div>
        <h2 style="margin-bottom:8px">Account Pending Approval</h2>
        <p style="color:var(--muted);margin-bottom:16px">Your registration is complete. An administrator will review your account shortly.${eventName?` Once it is approved you join <strong>${esc(eventName)}</strong> at your next sign-in.`:''}</p>
        <p class="pending-approval-note">Try logging in again later — once your account is approved, you'll be able to access the platform. An approval notification email may also be sent (best-effort), but login is the authoritative signal.</p>
        <button class="btn secondary" style="margin-top:20px" data-action="show-page" data-page="login-page">Back to Login</button>
      </div>
    </div>`);
  }
}

export async function handleCompetitionsNav(){
  // If currently in a live competition, warn before leaving
  if(S.currentCompetitionId){
    // v8.12.6 — an Events click is a NAVIGATION that waits on the network before
    // it navigates. If the participant opened a challenge or changed page while
    // it waited, that later ask wins: the "Leave Event?" confirm used to appear
    // over the challenge they had moved on to (with their draft under it), and
    // the no-confirm branch would have yanked them off it silently. Same rule as
    // an open (S._taskViewGen), re-checked after the body parse (v7.15.15).
    //
    // v8.12.6 (review) — AND THE CLICK TAKES ITS OWN TURN FIRST. It used to read
    // the generation without bumping it, so it never became the latest ask: a
    // challenge opened BEFORE it (still loading) landed first, its own showMain
    // bumped the generation, and this read it as "the participant moved on" —
    // the later Events click was silently dropped and the earlier open won. The
    // bump makes that still-pending open stale (it is dropped when it lands),
    // while an open started AFTER this click bumps again and still makes the
    // Events click stand down.
    S._taskViewGen++;
    const _view=S._taskViewGen;
    // Refresh myCompetitions to get latest status
    const r=await fetch('/api/my-competitions').catch(()=>null);
    if(r&&r.ok)S.myCompetitions=await r.json();
    if(S._taskViewGen!==_view)return;
    const comp=S.myCompetitions.find(c=>c.id===S.currentCompetitionId);
    const status=comp?computeCompStatus(comp):null;
    // v8.1.0 (PR 18) — the confirmation is suppressed for an unranked, self-paced
    // kind. It fires on status==='live', which an OPEN Program is for its whole
    // life, so without this a learner is asked "are you sure you want to leave?"
    // every time they go back to the event list — and leaving costs nothing when
    // there is no clock running and no standings to fall out of.
    //
    // v8.16.x — AND NOW FOR EVERY KIND: Events is plain navigation. Going back
    // to the list loses nothing — the clock keeps running either way, the
    // progress strip offers Continue at the top of the list, and the
    // deselect below still records the opt-out from auto-resume — so a
    // confirm here only asked a question with one sensible answer. What the
    // confirm also did is kept: the event is remembered as the last live one,
    // so entering a DIFFERENT live event next still meets "Switch Event?".
    if(status==='live'&&policyOrDefault(comp&&comp.policy).ranking_enabled){
      S.lastLiveCompetitionId=S.currentCompetitionId;
    }
  }
  S._compGen++;   // v8.14.4 — every writer of the tab's event bumps it (see ejectToCompetitionPicker)
  S.currentCompetitionId=null;
  S.currentCompStatus=null;
  S.currentCompPolicy=null;
  updateParticipantNav();
  showCompetitionsPage();
}

