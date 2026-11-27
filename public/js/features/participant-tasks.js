"use strict";

import { S } from "../core/state.js";
import { setListCount } from "../ui/list-controls.js"; // v7.20.11 — shared match count
import { csrfHeaders, fetchTransientRetry, readBody, isProfileIncomplete } from "../core/api.js";
import { html, raw, setSafeHtml } from "../core/trusted-types.js";
import { clearCompTimers, clearTsPickerTimers, NO_FIXED_DEADLINE, renderCompetitionPicker, showPendingPageForCompetition, showTimeslotPicker, stopCompDataPoll, timeLeftWords } from "./competition-picker.js";
import { _fmtBytes, esc, formatDuration, formatCorrectAnswer, dayOfSpan, staffSpectatorIn, currentCompetitionRow, policyOrDefault, answerCanBeWrong } from "../ui/format.js";
import { DIFF_PTS, ICO } from "../ui/icons.js";
import { hideLoading, showLoading, showSkeletonCards } from "../ui/loading.js";
import { showModal } from "../ui/modal.js";
import { applyReveal, showMain } from "../ui/nav.js";
import { highlightCodeElement, renderRich, stripHtml } from "../ui/richtext.js";
import { showCongrats, showThanks, showToast } from "../ui/toast.js";
import { renderCertificateCta } from "./badge-share.js";
import { buildTapConfirm, choiceTapApplies, enterTapChrome, markChosen, markTried, prepareTapCard, refitTapCardIfPending, releaseTapChrome, renderTapCard, resetTapCard, setTapBusy, syncTapMulti, updateTapAttempts } from "./choice-tap.js";

// Event team reports — a QUALIFYING question scores nothing (the server stores
// 0). `qualifying` rides the list rows and the detail. To the participant it is a
// quick question, not a challenge to win: no difficulty, attempt count, rating,
// points or "Correct", and the difficulty chips leave it out (All still shows it).
// The challenges the card opened that the server called quick questions: a
// card reached without the list (a link, a reload) still knows.
const _openedQuick=new Set();
function _isQualifying(t){
  if(!t)return false;
  if(t.qualifying||_openedQuick.has(t.id))return true;
  const row=(S.allTasks||[]).find(x=>x.id===t.id);
  return !!(row&&row.qualifying);
}
// The challenges that finish the participant's run: every one but the quick
// questions, which finish nothing (lib/qualifying.js). "N/M solved", the meter
// and the strip's "All solved" count these.
function _runTasks(list){return (Array.isArray(list)?list:[]).filter(t=>!_isQualifying(t));}
export function taskPts(t){return _isQualifying(t)?0:DIFF_PTS[t.difficulty];}
function _ptsLabel(t){return _isQualifying(t)?'Quick question':`+${DIFF_PTS[t.difficulty]} pts`;}
// The wrong-answer penalty sentence: none on a quick question, which loses nothing.
function _penaltyNote(taskId,d){return (d&&d.qualifying)||_isQualifying({id:taskId})?'':' −5 pts penalty.';}
// The difficulty chip: nothing for a quick question, whose difficulty means nothing.
function _diffChipHtml(t){
  if(_isQualifying(t))return '';
  return `<span class="badge ${esc(t.difficulty)}"><i class="qa-pips qa-pips-${esc(t.difficulty)}" aria-hidden="true"><b></b><b></b><b></b></i>${esc(t.difficulty)}</span>`;
}

export async function refreshScore(){
  // v7.2.x (audit) — guard the fire-and-forget /api/me (called after an answer
  // and from several nav paths) so a transient network error doesn't surface as
  // an unhandled rejection; the pulse repaints the score anyway.
  // /api/me's score is the score in the event the SESSION holds, and the paint
  // below records it as this tab's progress in that event (_paintPlayScore), so
  // an answer for an event the tab has since left is dropped: written under the
  // new event it would show the old event's score on the strip.
  const _gen=S._compGen;
  try{
    const r=await fetch('/api/me');if(!r.ok||_gen!==S._compGen)return;
    const d=await r.json();
    if(_gen!==S._compGen)return;
    const el=document.getElementById('header-score');if(el)el.textContent=d.score+' pts';
    _paintPlayScore(d.score);
  }catch(_){/* transient; next poll retries */}
}

// THE PLAY BAR'S SCORE. A copy of the header pill's number for the focus view,
// where the header steps aside on a phone; written from the same /api/me read,
// never computed here. A rise plays the bump (styles.css .qa-score.bump), which
// the global reduced-motion rule turns into nothing.
function _paintPlayScore(score){
  if(score!=null&&S.currentCompetitionId)recordProgress(S.currentCompetitionId,{score:Number(score)});
  const v=document.querySelector('#qa-stats .qa-score-val');
  if(!v||score==null)return;
  const next=String(score);
  const prev=v.textContent;
  const box=v.closest('.qa-score');
  if(box&&box.hidden&&policyOrDefault(S.currentCompPolicy).ranking_enabled)box.hidden=false;
  if(prev===next)return;
  v.textContent=next;
  if(box&&prev!==''&&Number(next)>Number(prev)){
    box.classList.remove('bump');void box.offsetWidth;box.classList.add('bump');
  }
}

export const _endedPopupChannel = ('BroadcastChannel' in window) ? new BroadcastChannel('hackarena-ended-popup') : null;

export async function ejectToCompetitionPicker(reason){
  if(S.timerInterval){clearInterval(S.timerInterval);S.timerInterval=null;}
  if(S.statusPollInterval){clearInterval(S.statusPollInterval);S.statusPollInterval=null;}
  if(S.lbInterval){clearInterval(S.lbInterval);S.lbInterval=null;}
  stopCompDataPoll();
  clearCompTimers();clearTsPickerTimers();
  // Clear in-memory competition state so a later picker click goes through
  // a full select-competition round-trip instead of reusing stale values.
  // v8.14.4 — and bump the generation, as every writer of the tab's event does:
  // a read or a refusal (409 competition_changed) for the event left is then
  // dropped by its caller rather than read as news about this tab. A pick still
  // in flight is superseded, or its answer would put the event back.
  S._compSelectSeq++;
  S._compGen++;
  S.currentCompetitionId=null;
  S.currentCompName=null;
  S.currentCompStatus=null;
  S.currentCompPolicy=null;   // v8.1.0 (PR 18) — cleared with the rest of the context
  S._currentTimeslots=[];
  S._currentChosenTimeslot=null;
  S._competitionFullyEnded=false;
  S.hackathonEnded=false;
  S.hackathonEndTime=null;
  S.hackathonOpenEnded=false;
  S.hackathonStartTime=null;   // v8.1.0 (PR 17) — the day chip's other end
  S._lateEntryActive=false;    // v8.6.0 — cleared with the rest of the context
  S._inLiveCompetition=false; // v7.2.x (CTF-0026, fix A) — left the event
  S.allTasks=[];
  const headerTimer=document.getElementById('header-timer');
  if(headerTimer){headerTimer.style.display='none';headerTimer.textContent='';}
  // Drop stale DOM content so a brief "back" press can't flash old data.
  const taskGrid=document.getElementById('task-grid');
  if(taskGrid)setSafeHtml(taskGrid,'');
  const lbBody=document.getElementById('lb-body');
  if(lbBody)setSafeHtml(lbBody,'');
  const podium=document.getElementById('podium-row');
  if(podium)setSafeHtml(podium,'');
  // Re-fetch /api/me — server-side defence-in-depth nulls out competitionId
  // when the user is no longer assigned, and we need the latest competitions
  // list to render the picker without the removed one.
  try{
    const me=await fetch('/api/me').then(r=>r.ok?r.json():null);
    // v7.22.1 — bump the same counter loadMyCompetitions() uses, so a poll that
    // was ALREADY in flight when the removal happened cannot land afterwards and
    // put the removed competition back into the picker. Writing the list without
    // claiming the sequence is exactly how that race stayed open.
    if(me){S._myCompsFetchSeq++;S.myCompetitions=me.competitions||[];}
  }catch{/* best-effort; if /api/me is also gone, the picker renders empty and the user can re-login */}
  if(reason)showToast(reason,'info');
  showMain('competitions-page');
  renderCompetitionPicker();
}

export async function _pollWaitingForAllSlots(){
  // ext-audit v7.15.13 — a transient failure (offline blip, 429, LB 5xx) must
  // NOT be reported as lost competition access. Retry, and on a total failure
  // leave the view alone; the next poll tick retries.
  // v7.15.17 — this poll was the one structural sibling with NO generation
  // guard. Its interval is cleared on a competition switch, but a fetch already
  // in flight still lands afterwards and would act on the competition the
  // participant just left. All four siblings capture before and re-check after
  // the body parse; so does this now.
  const _gen=S._compGen;
  const r=await fetchTransientRetry('/api/status');
  if(_gen!==S._compGen)return;
  if(!r)return;
  if(!r.ok){
    if(r.status===429||r.status>=500)return;   // transient after retries — keep the view
      // v8.8.23 — NOT a lost membership. The interceptor above normally opens the
      // gate and retries, so this is only reached when it could not (an admin in
      // participant view, or a gate that failed open). Ejecting with "You are no
      // longer in this event." would be FALSE — the participant is enrolled, and
      // the picker behind that toast lists the very same event as live. Leave the
      // view alone; the gate or the admin branch owns the recovery.
    if(await isProfileIncomplete(r))return;
    await ejectToCompetitionPicker("You are no longer in this event.");
    return;
  }
  const s=await readBody(r);
  if(_gen!==S._compGen)return;               // re-check post-parse (headers != settle)
  if(!s)return;
  // v8.6.0 — deliberately NOT guarded on the late-entry window, and the reason is
  // that such a guard would be DEAD CODE rather than defence in depth.
  //
  // This poll is installed by exactly one site: `handleCompetitionEnded`'s
  // multi-session branch, for a participant whose own slot has ended while the
  // competition has more to run. A late window is booth-only
  // (`eventPolicy.lateEntry`) and a Booth Event may hold no sessions at all
  // (`sessions: "forbidden"`, enforced from both ends), so no event can ever reach
  // this function AND have a late window. A guard here would read as protection
  // and be unreachable — which is the failure this codebase names repeatedly. The
  // late entrant's own teardown is prevented one function down, where
  // `/api/status` reports their window as live.
  if(s.competition_fully_ended||s.fully_ended){
    if(S.statusPollInterval){clearInterval(S.statusPollInterval);S.statusPollInterval=null;}
    S._competitionFullyEnded=true;
    const el=document.getElementById('header-timer');
    if(el)setSafeHtml(el, `<span style="display:inline-flex;align-items:center;gap:6px"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="var(--red)"/></svg>${esc(S.currentCompName)} Ended</span>`);
    loadTasks();
    // v6.16.2 — gate the "answers are now revealed" toast on the
    // per-comp reveal_answers_on_end flag. The server now echoes
    // it on /api/status; without this guard the toast lied to
    // participants in any competition where the flag is off (the
    // default), telling them solutions were now visible when the
    // server was correctly withholding them.
    if(s.reveal_answers_on_end){
      showToast('All sessions complete — answers are now revealed!','success');
    }else{
      showToast('All sessions complete — event has ended.','success');
    }
  }
}

export async function startHackathonTimer(){
  if(S.timerInterval){clearInterval(S.timerInterval);S.timerInterval=null;}
  if(S.statusPollInterval){clearInterval(S.statusPollInterval);S.statusPollInterval=null;}
  S.hackathonEnded=false;
  // Check r.ok — a 4xx body is JSON too ({error:"..."}) so the previous
  // `.then(r=>r.json())` would happily hand us an error payload and then
  // new Date(undefined) on st.end, leaving an "Invalid Date" timer running
  // against a non-existent competition.
  // ext-audit v7.15.13 — retry a transient failure; never report a blip as
  // lost competition access (see fetchTransientRetry in core/api.js).
  const _gen=S._compGen;                     // ext-audit v7.15.14 — see S._compGen
  const r=await fetchTransientRetry('/api/status');
  if(_gen!==S._compGen)return;               // the participant switched events mid-flight
  // ext-audit v7.15.14 — a transient failure on the FIRST status read used to
  // return before the 15 s poll was installed, so nothing ever retried and the
  // timer stayed blank until a manual reload. Schedule a single re-attempt so
  // the competition recovers on its own.
  if(!r||(!r.ok&&(r.status===429||r.status>=500))){
    if(!S._statusRetryTimer&&!S._pollsHalted){
      S._statusRetryTimer=setTimeout(()=>{S._statusRetryTimer=null;startHackathonTimer();},5000);
    }
    return;
  }
  if(!r.ok){
      // v8.8.23 — NOT a lost membership. The interceptor above normally opens the
      // gate and retries, so this is only reached when it could not (an admin in
      // participant view, or a gate that failed open). Ejecting with "You are no
      // longer in this event." would be FALSE — the participant is enrolled, and
      // the picker behind that toast lists the very same event as live. Leave the
      // view alone; the gate or the admin branch owns the recovery.
    if(await isProfileIncomplete(r))return;
    await ejectToCompetitionPicker("You are no longer in this event.");
    return;
  }
  const st=await readBody(r);
  if(_gen!==S._compGen)return;               // ext-audit v7.15.15 — re-check post-parse
  if(!st)return;
  S.hackathonEndTime=new Date(st.end);
  // The server's open-ended verdict for that end, written beside it here and on
  // every pulse, never re-derived (competition-picker.js NO_FIXED_DEADLINE).
  S.hackathonOpenEnded=st.open_ended===true;
  if(st.policy)S.currentCompPolicy=st.policy;   // v8.1.0 (PR 18)
  // v8.1.0 (PR 17) — /api/status already carries the ACTIVE window's start (the
  // participant's own session when there is one), which is exactly the span
  // "Day N of M" must count over.
  S.hackathonStartTime=st.start?new Date(st.start):null;
  // v7.20.5 — the SERVER's flag may only ever RAISE this, never lower it.
  //
  // Coming back to the tab re-runs startHackathonTimer() (main.js's
  // visibilitychange resume), which lands here again. Assigning the server
  // value unconditionally threw away the fact that this tab had already shown
  // the popup, so "<competition> has ended — view the leaderboard" reappeared on
  // every single tab focus. Reported for an admin, but the same for a
  // participant: POST /api/dismiss-ended is fire-and-forget, so a focus landing
  // before it commits re-read `false` too.
  //
  // Keyed on the competition so switching to a DIFFERENT ended competition
  // still announces itself once.
  S._endedPopupSeen=!!st.ended_popup_seen||S._endedPopupShownFor===S.currentCompetitionId;
  // v8.6.0 — remember whether THIS participant is playing on past the event's end,
  // so the countdown can label what it is counting down to. The server has already
  // reported `status:"live"` and `end:<late deadline>` for them — those two fields
  // have always described the caller's OWN window rather than the event's, which is
  // why a multi-session participant gets their timeslot's — so the timer, the
  // urgency classes and the keepalive arm all work with no further special case.
  S._lateEntryActive=!!(st.late_entry&&st.late_entry.is_late_entrant&&st.late_entry.window_open);
  _renderLateEntryChip();
  const el=document.getElementById('header-timer');
  if(!el)return;
  el.style.display='';
  if(st.status==='ended'){handleCompetitionEnded();return;}
  // v7.2.x (CTF-0026, fix A) — mark that the participant is in a LIVE
  // competition. The session monitor keeps the session alive while this is set
  // even with zero in-tab DOM activity, so a participant who backgrounds the
  // Arena tab to work in their IDE/terminal (the hackathon norm) doesn't have
  // their session expire mid-competition and get bounced into the synchronized
  // re-login wave that trips the shared-NAT login rate limit. Self-bounding:
  // cleared on competition end + on eject, and the monitor also gates on
  // hackathonEndTime so keepalive stops once the slot's end time passes even if
  // those clears were missed (e.g. the status poll was paused while hidden).
  S._inLiveCompetition=true;
  const tick=()=>{
    const diff=S.hackathonEndTime-Date.now();
    if(diff<=0){
      handleCompetitionEnded();
      return;
    }
    // v6.20.x — no icon here: #header-timer uses the brand text-gradient
    // (-webkit-background-clip:text), which would clip an inline SVG. The
    // numerals already read as a countdown; the clock emoji is dropped rather
    // than forced into a gradient-clipped context.
    // An open-ended Program (the server's `open_ended`) says "No fixed
    // deadline" here instead of counting ten years down (operator ruling,
    // 14 Nov 2026).
    const openEnded=S.hackathonOpenEnded===true;
    el.textContent=openEnded?NO_FIXED_DEADLINE:formatDuration(diff);
    // v8.1.0 (PR 17, Q3=b) — the day chip. Rendered from the SAME tick as the
    // countdown so the two can never disagree, and cleared rather than left stale
    // when the span is under two days, or when the countdown says "No fixed
    // deadline" ("Day 3 of 3653" would count the same ten years).
    const dayEl=document.getElementById('header-day');
    if(dayEl){
      const span=openEnded?null:dayOfSpan(S.hackathonStartTime?S.hackathonStartTime.getTime():NaN,
        S.hackathonEndTime?S.hackathonEndTime.getTime():NaN,Date.now());
      if(span){dayEl.textContent=`Day ${span.day} of ${span.total}`;dayEl.hidden=false;}
      else{dayEl.textContent='';dayEl.hidden=true;}
    }
    // v6.16.46 — design system §Interactions: countdown shifts to
    // --red when < 60 s remaining; pulses (1s ease-in-out alternate)
    // when < 10 s. The CSS rules live in styles.css under .countdown.
    // .urgent-warn / .countdown.urgent-final. Toggling classes here
    // keeps the visual logic in CSS where it belongs.
    el.classList.toggle('urgent-warn', diff < 60_000);
    el.classList.toggle('urgent-final', diff < 10_000);
  };
  tick();S.timerInterval=S._pollsHalted?null:setInterval(tick,1000);
  // THE PULSE: one poll for the status, the score pill, the board's
  // version and the session monitor — see _pulseTick below and GET
  // /api/participant/pulse. A self-rescheduling timer rather than an interval,
  // so each tab picks its own jittered delay and 3000 tabs never align.
  _schedulePulse();
}

// The pulse cadence. 15 s while the participant is acting or anything moved;
// after PULSE_IDLE_AFTER unchanged answers with no user intent for a minute it
// slows to 30 s. Every delay carries +/-PULSE_JITTER so tabs that entered the
// event together drift apart instead of polling in lock-step. A hidden tab
// does not pulse at all (the visibilitychange handler pauses it and the
// resume re-enters the view, which reads /api/status at once and arms the
// pulse again; a pulse that would be armed
// while the tab is already hidden records itself paused — _schedulePulse).
export const PULSE_BASE_MS=15000;
export const PULSE_IDLE_MS=30000;
export const PULSE_JITTER=0.2;
export const PULSE_IDLE_AFTER=4;
const PULSE_INTENT_WINDOW_MS=60000;
export function _pulseDelay(){
  const intentAgo=Date.now()-(S._lastIntentAt||0);
  const idle=intentAgo>PULSE_INTENT_WINDOW_MS&&(S._pulseUnchanged||0)>=PULSE_IDLE_AFTER;
  const base=idle?PULSE_IDLE_MS:PULSE_BASE_MS;
  return Math.round(base*(1+(Math.random()*2-1)*PULSE_JITTER));
}
// A pulse is never armed in a hidden tab. Armed at entry or by a tick that
// answered while the tab was already hidden, it is recorded as PAUSED instead,
// the way the visibilitychange handler records a poll it pauses (core/main.js),
// so the tab's return re-enters the view and the pulse with it. Without the
// record a pulse stopped after the hide event was never resumed: the tab missed
// an early end, an extension and a removal until the next hide and show.
function _schedulePulse(){
  if(S._pollsHalted){S.statusPollInterval=null;return;}
  if(document.hidden){
    S.statusPollInterval=null;
    if(!S._pausedIntervals.includes('statusPollInterval'))S._pausedIntervals.push('statusPollInterval');
    return;
  }
  S.statusPollInterval=setTimeout(_pulseTick,_pulseDelay());
}
// What the pulse carries beyond the /api/status body. The score pill (what the
// leaderboard poll's refreshScore used to fetch from /api/me, painted only where
// the event is ranked, as that poll only ran there), the board's version for
// startLeaderboardPoll, and the live session's state for the session monitor
// (_sessionMonTick reads S._lastPulse instead of asking while it is fresh).
function _applyPulseExtras(p){
  S._lastPulse={at:Date.now(),session:p.session||null};
  if(typeof p.lb_version==='string')S._lbVersionLatest=p.lb_version;
  if(typeof p.score==='number'&&policyOrDefault(S.currentCompPolicy).ranking_enabled){
    const el=document.getElementById('header-score');if(el)el.textContent=p.score+' pts';
    _paintPlayScore(p.score);
  }
  // Unchanged-answer count for the cadence: the session's expiry is left out
  // (a keepalive moves it without anything on screen changing).
  let sig='';
  try{sig=JSON.stringify([p.status,p.score,p.lb_version]);}catch(_){sig='';}
  if(sig&&sig===S._pulseSig)S._pulseUnchanged=(S._pulseUnchanged||0)+1;
  else{S._pulseUnchanged=0;S._pulseSig=sig;}
}
export async function _pulseTick(){
  // The id that fired. Anything that stops or restarts the pulse replaces or
  // nulls S.statusPollInterval, so an answer landing afterwards reschedules
  // nothing; a tab hidden meanwhile is recorded paused (_schedulePulse) and
  // resumed by the visibility handler.
  const handle=S.statusPollInterval;
  try{
    await (async()=>{
      const _pgen=S._compGen;
      const pr=await fetchTransientRetry('/api/participant/pulse');
      if(_pgen!==S._compGen)return;            // ext-audit v7.15.14 — stale event
      if(!pr)return;
      if(!pr.ok){
        // ext-audit v7.15.13 — a 429 / LB 5xx here is a blip, not a revocation.
        // This poll runs every 15 s for the whole event, so it is the single most
        // likely place for a network hiccup to have thrown a participant out.
        if(pr.status===429||pr.status>=500)return;
        // v8.8.23 — NOT a lost membership. The interceptor above normally opens the
        // gate and retries, so this is only reached when it could not (an admin in
        // participant view, or a gate that failed open). Ejecting with "You are no
        // longer in this event." would be FALSE — the participant is enrolled, and
        // the picker behind that toast lists the very same event as live. Leave the
        // view alone; the gate or the admin branch owns the recovery.
        if(await isProfileIncomplete(pr))return;
        // Competition revoked mid-session — same recovery as the initial
        // load path so the poll never leaves the tab in a stale state.
        await ejectToCompetitionPicker("You are no longer in this event.");
        return;
      }
      const p=await readBody(pr);
      if(_pgen!==S._compGen)return;            // ext-audit v7.15.15 — re-check post-parse
      if(!p||!p.status)return;
      _applyPulseExtras(p);
      const s=p.status;
      // The poll re-reads the late state every 15 s, so the chip disappears the moment
      // the window closes rather than at the next full page load.
      S._lateEntryActive=!!(s.late_entry&&s.late_entry.is_late_entrant&&s.late_entry.window_open);
      _renderLateEntryChip();
      if(s.status==='ended'){
        handleCompetitionEnded();
      }else{
        // Update end time in case it changed, and its open-ended verdict with it
        S.hackathonEndTime=new Date(s.end);
        S.hackathonOpenEnded=s.open_ended===true;
        if(s.start)S.hackathonStartTime=new Date(s.start);
      }
    })();
  }finally{
    if(S.statusPollInterval===handle&&handle!==null)_schedulePulse();
  }
}

// v8.6.0 — the chip beside the countdown that says WHAT it is counting down to.
//
// Without it a late entrant sees a live timer on an event the picker lists as
// finished and the leaderboard shows as over, with nothing to explain the
// contradiction — the affordance without its explanation (v7.14.2). The chip is
// mounted statically in the shell beside `#header-day` and only its text and
// hidden state move, so no poll-driven re-render can destroy it.
function _renderLateEntryChip(){
  const el=document.getElementById('header-late-entry');
  if(!el)return;
  if(S._lateEntryActive){el.textContent='Late entry';el.hidden=false;}
  else{el.textContent='';el.hidden=true;}
}

export function handleCompetitionEnded(){
  if(S.hackathonEnded)return;
  if(S.isAdminView)return; // don't show ended popup while in admin view
  S.hackathonEnded=true;
  S._inLiveCompetition=false; // v7.2.x (CTF-0026, fix A) — stop live-keepalive
  // v8.6.0 — the window that was being counted down is over too, whether it was the
  // event's or a late entrant's. Clearing it here rather than only on the next poll
  // means the chip goes at the same moment the countdown does.
  S._lateEntryActive=false;
  _renderLateEntryChip();
  if(S.timerInterval){clearInterval(S.timerInterval);S.timerInterval=null;}
  if(S.statusPollInterval){clearInterval(S.statusPollInterval);S.statusPollInterval=null;}
  const el=document.getElementById('header-timer');

  const showPopup=!S._endedPopupSeen;
  // v6.16.2 — gate the "answers will be revealed" copy on the
  // per-competition reveal_answers_on_end flag (added to
  // /api/me competitions array). Pre-fix the popup unconditionally
  // promised reveal-on-end, which lied to participants in any
  // competition where the flag is off.
  const _curCompForCopy = (S.currentUser?.competitions||[]).find(c => c.id === S.currentCompetitionId);
  const _willRevealOnEnd = !!_curCompForCopy?.reveal_answers_on_end;

  // For multi-slot: check if competition is fully ended or just this timeslot
  if(S._currentTimeslots.length>0&&!S._competitionFullyEnded){
    // Timeslot ended but competition has more slots — show waiting state
    // v7.2.x (audit, frontend #2) — inline filled pause SVG instead of the ⏸
    // (U+23F8) dingbat (icon convention: inline SVG only). Filled (not stroked)
    // so it renders inside #header-timer's text-gradient, matching the sibling
    // fully-ended renderer's filled <circle> above.
    if(el)setSafeHtml(el, '<span style="display:inline-flex;align-items:center;gap:6px"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1" width="2.5" height="8" fill="var(--yellow)"/><rect x="6" y="1" width="2.5" height="8" fill="var(--yellow)"/></svg>Your session ended — waiting for all sessions to complete</span>');
    loadTasks();
    if(showPopup){
      S._endedPopupSeen=true;
      S._endedPopupShownFor=S.currentCompetitionId;   // v7.20.5 — survives a tab-focus re-read
      _endedPopupChannel?.postMessage({compId:S.currentCompetitionId});
      // v7.14.0 — never dismiss the TARGET's ended-popup while impersonating:
      // it durably sets their `ended_popup_seen` + emits an event (so a
      // read-only peek would mutate their state), the server refuses it for the
      // read-only tier, and the resulting 403 modal would clobber the ended
      // dialog this function opens on the very next statement.
      if(!S.impersonation)fetch('/api/dismiss-ended',{method:'POST',headers:csrfHeaders()}).catch(e=>console.warn('Ended notice dismissal not recorded',e));
      const _sessionMsg = _willRevealOnEnd
        ? `<strong>Your session has ended.</strong><br><br>Answers and explanations will be revealed once all sessions of <strong>${esc(S.currentCompName)}</strong> are complete.<br><br>You can still view the leaderboard.`
        : `<strong>Your session has ended.</strong><br><br>Thank you for participating in <strong>${esc(S.currentCompName)}</strong>. You can still view the leaderboard.`;
      // v7.12.4 — the ended popup is a full-screen modal that covers the nav, so a bare
      // "OK" left the participant on the tasks page having to hunt for the (covered)
      // Leaderboard tab. Offer a primary "View Leaderboard" that routes straight there.
      showModal({
        title:'Session Ended',
        message:_sessionMsg,
        confirmText:'View Leaderboard',confirmClass:'',cancelText:'Close'
      }).then(go=>{ if(go) showMain('leaderboard-page'); });
    }
    // Poll for full competition end — extracted + named so the recovery
    // branch is testable (see window._pollWaitingForAllSlots exposure).
    if(!S._pollsHalted)S.statusPollInterval=setInterval(_pollWaitingForAllSlots,15000);
  }else{
    if(el)setSafeHtml(el, `<span style="display:inline-flex;align-items:center;gap:6px"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="var(--red)"/></svg>${esc(S.currentCompName)} Ended</span>`);
    loadTasks();
    if(showPopup){
      S._endedPopupSeen=true;
      S._endedPopupShownFor=S.currentCompetitionId;   // v7.20.5 — survives a tab-focus re-read
      _endedPopupChannel?.postMessage({compId:S.currentCompetitionId});
      // v7.14.0 — never dismiss the TARGET's ended-popup while impersonating:
      // it durably sets their `ended_popup_seen` + emits an event (so a
      // read-only peek would mutate their state), the server refuses it for the
      // read-only tier, and the resulting 403 modal would clobber the ended
      // dialog this function opens on the very next statement.
      if(!S.impersonation)fetch('/api/dismiss-ended',{method:'POST',headers:csrfHeaders()}).catch(e=>console.warn('Ended notice dismissal not recorded',e));
      // v7.12.4 — route the participant straight to the leaderboard (where the
      // LinkedIn share-badge CTA lives) instead of stranding them behind the
      // nav-covering modal on the tasks page.
      showModal({title:'Event Ended',message:`<strong>${esc(S.currentCompName)}</strong> has ended.<br><br>You can view the leaderboard and, if you took part, share a badge on LinkedIn.`,confirmText:'View Leaderboard',confirmClass:'',cancelText:'Close'}).then(go=>{ if(go) showMain('leaderboard-page'); });
    }
  }
}

// ext-audit v7.15.14 — replace the skeleton grid with an explicit error + Retry.
// Skeletons mean "loading"; leaving them up after a terminal failure tells the
// participant something is still coming when nothing is.
function _showTasksLoadError(){
  const grid=document.getElementById('task-grid');
  if(!grid)return;
  setSafeHtml(grid,
    '<div class="empty-state" role="status">'
    + '<p>Could not load the challenges — the connection to the server failed.</p>'
    + '<button class="btn" data-action="retry-load-tasks">Try again</button>'
    + '</div>');
  const sub=document.getElementById('tasks-subtitle');
  if(sub)sub.textContent='Connection problem';
}

export async function loadTasks(){
  // v6.10.78 — 12 skeletons covers typical tournament grid layouts
  // (3-col × 4 rows on desktop, 2-col × 6 rows on tablet) before
  // /api/tasks returns and the real cards swap in. Paired with the
  // task-shaped .skeleton-card in styles.css — the swap is a near-
  // zero-shift operation.
  showSkeletonCards('task-grid',12);
  showLoading();
  // ext-audit v7.15.13 — hideLoading() in a finally: a THROWN fetch (the tab
  // goes offline mid-request) skipped it entirely and left the full-screen
  // overlay up with no way out but a reload.
  const _gen=S._compGen;                     // ext-audit v7.15.14 — see S._compGen
  let r;
  try { r=await fetchTransientRetry('/api/tasks'); } finally { hideLoading(); }
  // A competition switch while this was in flight makes the response describe
  // the competition we just LEFT — rendering it would silently show the wrong
  // challenges under the new competition's heading.
  if(_gen!==S._compGen)return;
  if(!r){
    // ext-audit v7.15.14 — the copy used to promise "retrying", but nothing was
    // scheduled: /api/tasks has no poll of its own, so a failed FIRST load left
    // the grid skeletonised for ever with no way forward but a page reload.
    // Show a real, actionable retry state instead of a lie.
    _showTasksLoadError();
    return;
  }
  if(!r.ok){
    if(r.status===429||r.status>=500){ _showTasksLoadError(); return; }
    const d=await r.json().catch(()=>({}));
    // v7.7.26 (audit M16) — a not-started 403 means the participant IS still
    // a member but their window isn't live yet: another session of a multi-
    // slot comp is live while theirs is upcoming (the comp-level status shows
    // the Challenges tab), or the local clock runs ahead of the server so the
    // pending-page countdown navigated early. Pre-fix this fell through to
    // the eject below with a false "You are no longer in this competition."
    // Route back to the correct waiting view instead; the 10s retry guard
    // stops a fast clock from flash-looping pending→tasks→pending each tick.
    if(r.status===403&&d.not_started){
      S._notStartedRetryAt=Date.now()+10000;
      if(d.needsSlot)showTimeslotPicker();
      else showPendingPageForCompetition();
      return;
    }
    // v8.8.23 — see the sibling guards above: an incomplete profile is not a
    // lost membership, and the interceptor owns the recovery. `d` is already
    // parsed here, so this needs no clone.
    if(d&&d.error==='profile_incomplete')return;
    // Competition context went stale (removed from comp, comp deleted, or
    // server-side cleared session.competitionId). A silent return left a
    // skeleton grid on-screen forever; eject back to the picker instead.
    await ejectToCompetitionPicker("You are no longer in this event.");
    return;
  }
  // ext-audit v7.15.15 — re-check AFTER the body is parsed. The guard above ran
  // at response HEADERS; parsing is another await, so a competition switch can
  // land in between and the stale body would still overwrite S.allTasks.
  const _tasks=await readBody(r);
  if(_gen!==S._compGen)return;
  if(!_tasks){_showTasksLoadError();return;}
  S.allTasks=_tasks;
  // The participant's own count of what finishes the event — "N/M solved", the
  // meter, and the strip's "All solved" (from the `quick` mask recorded beside
  // `done`) — leaves quick questions out, exactly as the server's finish counts
  // do (lib/qualifying.js notQualifyingSql): with every challenge solved the
  // board says All solved, and so must these. The play bar's TRACK still shows
  // every challenge in list order, quick questions last (a position, not a count).
  const _run=_runTasks(S.allTasks);
  const solved=_run.filter(t=>t.solved).length;
  // `out` (#283): the challenges with no attempts left, which the strip's
  // position passes over as Next challenge does.
  if(S.currentCompetitionId)recordProgress(S.currentCompetitionId,{done:S.allTasks.map(t=>!!t.solved),quick:S.allTasks.map(t=>_isQualifying(t)),out:S.allTasks.map(t=>!!t.out_of_attempts)});
  document.getElementById('tasks-subtitle').textContent=`${solved}/${_run.length} solved`;
  // The meter beside it draws the same share; its box never changes size.
  const _meter=document.querySelector('#tasks-meter > i');
  if(_meter)_meter.style.width=_run.length?`${Math.round(solved/_run.length*100)}%`:'0%';
  // v8.1.0 (PR 34) — tell the participant, on the event that records. Read from
  // the competition they are IN, so a participant who moves between events sees
  // it exactly where it is true.
  const _pn=document.getElementById('presence-note');
  if(_pn){
    // `S.myCompetitions` is populated by the PICKER, and a participant who boots
    // straight into a selected competition never opens it — measured: the array
    // is empty on that path, which silently hid the disclosure for exactly the
    // people it is for. `S.currentUser.competitions` comes from /api/me and is
    // always present once signed in; the picker array is the fallback, not the
    // source.
    const _list=(S.currentUser&&S.currentUser.competitions)||S.myCompetitions||[];
    const _c=_list.find(c=>c.id===S.currentCompetitionId);
    _pn.hidden=!(_c&&_c.measure_presence);
  }
  // When the solve clock starts: said on an event that starts it at the first
  // challenge (the server's answer, `clock_starts_at_first_open`), from the same
  // row the presence note reads.
  const _cn=document.getElementById('clock-note');
  if(_cn){
    const _list=(S.currentUser&&S.currentUser.competitions)||S.myCompetitions||[];
    const _c=_list.find(c=>c.id===S.currentCompetitionId);
    _cn.hidden=!(_c&&_c.clock_starts_at_first_open===true);
  }
  // Show competition + session context
  const compLabel=document.getElementById('tasks-comp-label');
  if(compLabel){
    const tsName=S._currentChosenTimeslot?.name;
    // v8.12.0 — a competing staff member is pinned to their session like everybody else.
    const switchBtn=staffSpectatorIn(currentCompetitionRow())&&S._currentTimeslots.length>1?' <button class="btn sm secondary tasks-switch-session" data-action="show-timeslot-picker">Switch Session</button>':'';
    setSafeHtml(compLabel, (tsName?`${esc(S.currentCompName)} → ${esc(tsName)}`:esc(S.currentCompName))+switchBtn);
  }
  // v8.3.26 — A DELIBERATE CHOICE IS NOT OVERRIDDEN, WHICHEVER STATE THE EVENT IS IN.
  //
  // The live branch used to set `unsolved` UNCONDITIONALLY, ignoring
  // `solveFilterUserSet` — which `setSolveFilter` sets on every chip click and
  // which the ended branch below has always honoured. So during a LIVE
  // competition a participant who pressed **All** or **Solved** had it silently
  // reverted by the very next `loadTasks()`, i.e. within fifteen seconds, by the
  // status poll. A control that appears to work: the chip highlighted, the grid
  // changed, and then it changed back for no reason the participant could see —
  // and the empty state's own copy is what tells them to press All in the first
  // place.
  //
  // Both DEFAULTS are unchanged: with no explicit choice a live event still
  // opens on `unsolved` and a finished one on `all`. Only the override goes.
  // (It also removes a real flake: the poll reverting the filter mid-test is why
  // the participant-search lock intermittently sampled one card instead of two.)
  const ended=S.allTasks.length>0&&S.allTasks[0].hackathon_ended;
  if(!S.solveFilterUserSet){
    S.currentSolveFilter=ended?'all':'unsolved';
  }
  document.querySelectorAll('#solve-filters .filter-btn').forEach(b=>b.classList.toggle('active',b.dataset.filter===S.currentSolveFilter));
  renderTasks(S.currentDiffFilter);
  // v8.1.0 (PR 29) — the certificate CTA lives on THIS page, because the
  // Leaderboard tab is inactive for a kind with no ranking and the pre-existing
  // CTA is there. Fire-and-forget: a certificate banner must never delay or break the
  // challenge list, which is what the participant came for.
  renderCertificateCta().catch((e) => console.warn('Certificate offer failed to render', e));
}

export function filterTasks(btn,diff){
  S.currentDiffFilter=diff;
  document.querySelectorAll('#diff-filters .filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');renderTasks(diff);
}

export function setSolveFilter(btn,filter){
  S.currentSolveFilter=filter;
  S.solveFilterUserSet=true;
  document.querySelectorAll('#solve-filters .filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');renderTasks(S.currentDiffFilter);
}

// v7.21.0 — the category ribbons.
//
// ONE renderer for both surfaces (the card grid and the challenge detail) so
// they cannot drift — the same reason formatCorrectAnswer exists (v7.19.1,
// where three renderers of one value had gone three ways).
//
// The server sends parsed NAMES; this never sees the `category:` prefix and does
// not know it exists, so there is no client/server mirror to keep in step.
//
// A11Y: the requirement was that the visible chrome need not say "Category", but
// a screen reader must not be left to infer it from a coloured pill. The group
// carries an .sr-only "Category:" / "Categories:" prefix and a role=list, so the
// names are announced as a labelled set rather than as loose words after the
// title. The glyph is aria-hidden — it is decoration, the name is the content.
export function renderCategories(cats,{cls=''}={}){
  const list=(cats||[]).filter(c=>typeof c==='string'&&c.trim());
  if(!list.length)return '';
  return `<div class="cat-ribbons ${cls}" role="list">`
    +`<span class="sr-only">${list.length===1?'Category':'Categories'}: </span>`
    +list.map(c=>`<span class="cat-ribbon" role="listitem"><span class="cat-ribbon-ico" aria-hidden="true">${ICO.tag}</span>${esc(c)}</span>`).join('')
    +`</div>`;
}

// v7.21.16 (long-list phase 6) — the participant's own search.
//
// The chips narrow by difficulty and solved-state; neither helps someone who
// remembers a challenge by NAME or by the category ribbon on its card. At a
// live event with a 40-challenge bank that is the common way to look for one.
//
// The haystack is deliberately title + CATEGORY and nothing else. Categories
// are the only task tag a participant is ever shown (v7.21.0), and the raw tag
// list is never on the participant wire at all — so searching the description
// would be a wider reach than the payload is meant to give, and searching tags
// is not possible even if it were wanted.
function _taskMatchesQuery(t,q){
  if(!q)return true;
  const hay=`${t.title||''} ${(t.categories||[]).filter(Boolean).join(' ')}`.toLowerCase();
  return hay.includes(q);
}

// A card's excerpt is the question's PROSE: a code block is the challenge's
// evidence, not its summary, and stripped to text it read as a run of
// punctuation ("app.get('/orders', async (req, res) => {…"). Inline code stays,
// as it is part of a sentence.
export function _cardExcerpt(desc){
  const prose=String(desc||'').replace(/<pre\b[\s\S]*?<\/pre>/gi,' ');
  return stripHtml(prose).replace(/\s+/g,' ').trim();
}

export function renderTasks(diff){
  const q=(document.getElementById('participant-task-search')?.value||'').toLowerCase().trim();
  let list=diff==='all'?S.allTasks:S.allTasks.filter(t=>t.difficulty===diff&&!_isQualifying(t));
  if(S.currentSolveFilter==='solved')list=list.filter(t=>t.solved);
  else if(S.currentSolveFilter==='unsolved')list=list.filter(t=>!t.solved);
  if(q)list=list.filter(t=>_taskMatchesQuery(t,q));
  const grid=document.getElementById('task-grid');
  setSafeHtml(grid, list.map(t=>{
    const num=t.task_number?`<span class="tc-num">${esc(t.task_number)}</span>`:'';
    // v6.8.5: the accessible name carries the solved/unsolved state — the CSS
    // ::after pseudo-element that renders the SOLVED/UNSOLVED badge is
    // visual-only and not guaranteed to be read out.
    // A challenge with no attempts left is not "still open": the list's own
    // `out_of_attempts` says so (as the strip's No attempts left and the card's
    // exhausted panel do), on the card and in its name.
    const _spent=!t.solved&&!!t.out_of_attempts;
    const srState = t.solved ? 'solved' : (_spent ? 'unsolved, no attempts left' : (t.hackathon_ended ? 'unsolved' : 'unsolved, still open'));
    const _cats=(t.categories||[]).filter(Boolean);
    // The accessible NAME carries the categories too — a screen-reader user
    // scanning the grid gets the same grouping a sighted user gets from the
    // ribbons, without having to enter each card.
    const _quick=_isQualifying(t);
    const srLabel = `${esc(t.title)}, ${_quick?'quick question':esc(t.difficulty)}, ${_quick&&t.solved?'answered':srState}${_cats.length?`, ${_cats.length===1?'category':'categories'} ${esc(_cats.join(', '))}`:''}`;
    // THE CONTROL IS THE TITLE, NOT THE CARD. The card used to be role=button
    // with srLabel as its aria-label. A name has to contain the text its
    // control SHOWS (WCAG 2.5.3 Label in Name), and a whole card shows its
    // number, difficulty, points and description too — none of which a name
    // that opens with the title can hold, so axe's label-content-name-mismatch
    // refused every card. A button's children are presentational as well, so
    // the heading and the ribbon list inside it were flattened for screen
    // readers. Now the title is a real <button> whose name opens with the title
    // it shows; the rest of the card is ordinary content around it. The card
    // keeps data-action, so a click or tap anywhere on it still opens the
    // challenge (the button's own click bubbles to it), and every locator that
    // targets the card is unchanged. Same move as the rankings picker card's
    // title button (v7.7.33 AL11).
    return`<div class="task-card ${t.solved?'solved':t.hackathon_ended?'unsolved':_spent?'spent':''}${_quick?' quick':''}" data-action="task-open" data-task-id="${esc(t.id)}">
      <div class="tc-top">
        ${num}
        ${_diffChipHtml(t)}
        <span class="pts">${esc(_ptsLabel(t))}</span>
        ${_spent?`<span class="tc-spent">${ICO.lock}No attempts left</span>`:''}
      </div>
      <h3><button type="button" class="card-open" aria-label="${srLabel}">${esc(t.title)}</button></h3>
      ${renderCategories(_cats,{cls:'on-card'})}
      <p>${esc(_cardExcerpt(t.description))}</p>
    </div>`;}).join(''));
  // v7.20.11 — say how many, and say WHY the list is short.
  //
  // The Unsolved filter is FORCED on every load while the competition is live
  // (see loadTasks), so a participant who has solved everything used to be shown
  // "No challenges found." — indistinguishable from a competition with nothing
  // assigned, or from a load failure, on the screen they look at most. The count
  // states the real total, and the empty copy now names the filter that is
  // hiding things rather than implying there is nothing there.
  const _filtered=diff!=='all'||S.currentSolveFilter!=='all'||!!q;
  // `queried` distinguishes "2 of 3 challenges MATCH" (the participant typed
  // something) from "2 of 3 shown" (a chip is narrowing it). Without it a list
  // that arrives pre-filtered reads as though a search term were responsible,
  // and invites the reader to hunt for one (v7.20.11).
  setListCount('task-grid',{matched:list.length,total:S.allTasks.length,filtered:_filtered,queried:!!q});
  if(!list.length){
    setSafeHtml(grid, S.allTasks.length
      ? (q
        ? `<p class="grid-empty">No challenges match <strong>${esc(q)}</strong>. Searching looks at the title and the category.</p>`
        : `<p class="grid-empty">No challenges match the current filter — ${esc(String(S.allTasks.length))} ${S.allTasks.length===1?'challenge is':'challenges are'} hidden by it. Choose <strong>All</strong> above to see everything.</p>`)
      : '<p class="grid-empty">No challenges found.</p>');
  }
  applyReveal(grid);
}

// v7.27.0 — forget the open challenge WITHOUT reporting a departure. Used on the
// solve path: the participant did not leave, they finished, and the app moved
// them. Clears the re-arm id too, so a later tab-return cannot resurrect it.
export function clearOpenTask(){
  S._openedTaskId=null;
  S._navAwayResumeId=null;
}

export function fireNavigatedAway(via){
  const id=S._openedTaskId;
  if(!id)return Promise.resolve();
  S._openedTaskId=null;
  // v7.27.0 — remember WHICH challenge this fired for, so returning to a tab
  // whose detail view is still on screen can re-arm it (rearmOpenTask below).
  // Pre-fix the first tab-switch nulled _openedTaskId for good: every later
  // switch reported nothing, and the eventual REAL departure was never recorded
  // at all. One Alt-Tab silenced the challenge for the rest of its life.
  S._navAwayResumeId=id;
  try{
    return fetch(`/api/tasks/${encodeURIComponent(id)}/navigated-away`,{
      method:'POST',
      headers:csrfHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({via}),
      keepalive:true,
    }).catch(e=>console.warn('navigated-away beacon failed',e));
  }catch(_){return Promise.resolve();/* unload-context errors swallowed */}
}

// v7.27.0 — the tab came back and the challenge detail is STILL on screen, so
// the participant has not left it: put it back under observation.
//
// Guarded on the active page rather than on a timer or a flag, because that is
// the only thing that actually distinguishes "still reading this challenge" from
// "hid the tab, came back, and is now somewhere else". A stale resume id can
// therefore never re-arm the wrong view.
export function rearmOpenTask(){
  if(S._openedTaskId||!S._navAwayResumeId)return;
  if(document.querySelector('.page.active')?.id!=='task-detail-page')return;
  S._openedTaskId=S._navAwayResumeId;
  S._navAwayResumeId=null;
}

export const _taskGradingHashes = new Map();

// v8.12.6 — TWO QUESTIONS, TWO PREDICATES. Every function below awaits the
// network and then writes into the ONE shared #task-detail-card (or navigates),
// and nothing ordered those writes against what the participant did meanwhile:
// open A on venue wi-fi, open B, start typing — and A's late response replaced B
// and took the draft with it; ask for A's hint, go to B — and the priced "this
// penalty is permanent" confirm, which names no challenge, appeared over B.
//
// AN OPEN BELONGS TO THE LATEST ASK. `_taskViewStale()` answers "has the
// participant moved on since this was asked?" — another open, any page change
// (S._taskViewGen, bumped by openTask and by showMain/showPage), or an event /
// session switch (S._compGen, which openTask never read although GET
// /api/tasks/:id is competition-scoped — the v7.15.14 rule, finally kept).
function _taskViewStale(){
  const v=S._taskViewGen, g=S._compGen;
  return ()=>v!==S._taskViewGen||g!==S._compGen;
}
// AN OUTCOME BELONGS TO ITS CARD. A submit, a hint or a rating is an answer the
// participant is waiting to hear, so the question is "is THAT challenge's card
// the one on screen now?", not "has anything happened since?". Going Back and
// re-opening the SAME challenge means they are looking at it again, and its
// outcome goes in its card exactly as before — asking the view generation here
// instead left a live answer box on a challenge just solved, and a priced "Show
// Hint" button over a hint already paid for (measured, the design review).
//
// A MODULE VARIABLE, NOT A data-task-id ON THE CARD: the dispatcher and the
// submit-button selectors already key on data-task-id, and openTask is the only
// writer of #task-detail-card, so it is the one place that can say which
// challenge the card holds.
let _shownTaskId=null;
function _taskStillShown(taskId,g){
  return g===S._compGen&&_shownTaskId===taskId
    &&document.querySelector('.page.active')?.id==='task-detail-page';
}
// Off-card outcomes NAME the challenge — "Incorrect answer" is meaningless when
// another challenge is on screen.
const _taskTitle=(id)=>{const t=S.allTasks.find(x=>x.id===id);return t?t.title:'that challenge';};

// v8.13.1 — THE STANDARD CARD'S ATTEMPT LINE, said in ONE place. The render
// draws it, and after an answer the server's count re-draws it in place: the line
// used to keep the count from when the challenge was opened, so after a wrong
// answer it read "3 of 3 attempts left" beside a message saying 2 were, and the
// "Last attempt" warning never appeared before the answer that locks the card.
// The booth tap card has its own copy of this job (choice-tap.js updateTapAttempts).
// The header's count of answers sent so far, said as a person would.
export function attemptsCountText(n){
  const k=Number.isInteger(n)&&n>0?n:0;
  return k===0?'No attempts yet':k===1?'1 attempt':`${k} attempts`;
}

// THE CORRECT PANEL — the solved state's message, its points and the way on.
// The praise is short and varies with the challenge's weight; the way on is the
// next challenge the participant can still answer in their own list (after this
// one, then from the top), or the list itself when nothing is left. "Can still
// answer": not solved, not ended, and not out of attempts (the list's
// `out_of_attempts`, #283) — a challenge with no attempts left is finished, as
// the board and the auto-end count it, and would open as "No attempts left".
const _PRAISE={easy:'clean and quick.',medium:'nicely reasoned.',hard:'sharp work.'};
function _nextPlayable(id){
  const list=Array.isArray(S.allTasks)?S.allTasks:[];
  const i=list.findIndex(x=>x.id===id);
  const order=i<0?list:list.slice(i+1).concat(list.slice(0,i));
  return order.find(x=>!x.solved&&!x.out_of_attempts&&x.id!==id&&!x.hackathon_ended)||null;
}
export function solvedPanelHtml(t,{fresh=false}={}){
  const quick=_isQualifying(t);
  // An Any answer challenge (a pick-one included) has no right answer to be
  // correct about: every non-empty answer is accepted, so it is never "Correct".
  const accepted=!quick&&t.answer_type==='any';
  const pts=taskPts(t);
  const next=_nextPlayable(t.id);
  const cta=fresh?''
    // Not data-action="task-open": the card stays in the DOM under the list, and
    // a second task-open node for the same id would make "the card for this
    // challenge" ambiguous. openTask wires the press itself (_wireNextChallenge).
    :next?`<button type="button" class="btn lg block qa-next" data-next-task-id="${esc(next.id)}">Next challenge ${ICO.chevronRight}</button>`
    :`<button type="button" class="btn lg block qa-next" data-action="show-main" data-page="tasks-page">Back to challenges</button>`;
  // Operator ruling 395 — an answered Quick question can be changed while the
  // person can still play: the server's offer (`answer_changeable`), said and
  // offered together.
  const change=!fresh&&quick&&t.answer_changeable;
  return `<div class="qa-done qa-done-ok">
      <span class="qa-done-ico" aria-hidden="true">${ICO.check}</span>
      <div class="qa-done-text"><strong>${quick?'Thanks, noted':accepted?'Answer accepted':`Correct — ${esc(_PRAISE[t.difficulty]||'well done.')}`}</strong><span>${fresh?'Your answer is in.':quick?(change?'You have answered this question. You can change your answer until the event ends.':'You have answered this question.'):accepted?'You have answered this challenge.':'You have solved this challenge.'}</span></div>
      ${!quick&&Number.isFinite(pts)?`<b class="bignum qa-done-pts">+${esc(String(pts))}</b>`:''}
    </div>${change?`<button type="button" class="btn secondary block qa-change" data-action="task-change-answer" data-task-id="${esc(t.id)}">Change answer</button>`:''}${cta}`;
}

// THE ANSWER KEYS. A–D (as many letters as there are options) pick an option
// on the standard card's lettered options (multiple choice, or a pick-one) and
// Enter submits the picked answer —
// the same input and the same Submit button a click reaches, so nothing here
// grades or decides. Off while typing anywhere else, under a dialog, and on
// the booth tap card (its tiles are buttons and confirm on press).
let _qaKeysOn=false;
// What has an Enter action of its own (a control, or something drawn as one).
const _OWN_ENTER='a[href],area[href],button,summary,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="option"]';
function _qaKeydown(e){
  if(e.defaultPrevented||e.altKey||e.ctrlKey||e.metaKey||e.isComposing)return;
  if(document.querySelector('.page.active')?.id!=='task-detail-page')return;
  if(document.getElementById('modal-overlay')?.classList.contains('open'))return;
  const card=document.querySelector('#task-detail-card.qa-card');
  if(!card)return;
  const tg=e.target;
  if(tg&&tg.closest&&tg.closest('[role="dialog"]'))return;
  const inChoice=!!(tg&&tg.classList&&tg.classList.contains('ans-choice'));
  if(tg&&!inChoice&&(tg.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName||'')))return;
  const inputs=[...card.querySelectorAll('.choice-fieldset .ans-choice')];
  if(!inputs.length)return;
  if(e.key&&e.key.length===1&&/[a-z]/i.test(e.key)){
    const inp=inputs[e.key.toUpperCase().charCodeAt(0)-65];
    if(!inp||inp.disabled)return;
    e.preventDefault();
    inp.checked=inp.type==='radio'?true:!inp.checked;
    inp.dispatchEvent(new Event('change',{bubbles:true}));
    _focusQuietly(inp);
    return;
  }
  if(e.key==='Enter'){
    // Enter submits only from an option, or where focus is merely PARKED: the
    // page itself, or an element focused by script (tabindex="-1": the route's
    // heading, the result line), which has no Enter action of its own. Anywhere
    // else it does that control's own job (WCAG 2.1.1): the attachment link
    // downloads, a link in the question opens, a button presses.
    const parked=!tg||tg===document.body||tg===document.documentElement
      ||(tg.getAttribute&&tg.getAttribute('tabindex')==='-1'&&!tg.closest(_OWN_ENTER));
    if(!inChoice&&!parked)return;
    if(!card.querySelector('.choice-fieldset .ans-choice:checked'))return;
    // The card's own Submit: a multiple-choice card's opens the penalty confirm,
    // a pick-one's (an Any answer with lettered options) sends at once, exactly
    // as a click on it does.
    const b=card.querySelector('[data-action="task-submit-answer"][data-mode="choice"],[data-action="task-submit-answer"][data-mode="pickone"]');
    if(b&&!b.disabled){e.preventDefault();b.click();}
  }
}
function _installQaKeys(){
  if(_qaKeysOn)return;
  _qaKeysOn=true;
  document.addEventListener('keydown',_qaKeydown);
  _installKeyboardLift();
}

// THE SUBMIT BAR RIDES ABOVE THE ON-SCREEN KEYBOARD. On a phone the Submit
// button sits on a bar fixed to the bottom of the LAYOUT viewport; an open
// keyboard shrinks only the VISUAL viewport (iOS always, Android by default), so
// the bar ended up under the keys while the participant typed their answer.
// `--qa-kb` is how far the visual viewport's bottom sits above the layout
// viewport's; the phone stylesheet lifts the bar by it. Only while the answer
// field has focus — a pinch-zoom also shrinks the visual viewport and must not
// float the bar mid-screen. Installed on the first open, never at module load.
function _keyboardLift(){
  const vv=window.visualViewport;
  const root=document.documentElement;
  if(!vv)return;
  const typing=!!(document.activeElement&&document.activeElement.closest&&document.activeElement.closest('#task-detail-card.qa-card #ans-text'));
  const gap=typing?Math.max(0,Math.round(window.innerHeight-(vv.offsetTop+vv.height))):0;
  const next=gap>40?`${gap}px`:'0px';
  if(root.style.getPropertyValue('--qa-kb')!==next)root.style.setProperty('--qa-kb',next);
}
function _installKeyboardLift(){
  const vv=window.visualViewport;
  if(!vv)return;
  vv.addEventListener('resize',_keyboardLift);
  vv.addEventListener('scroll',_keyboardLift);
  document.addEventListener('focusin',_keyboardLift);
  document.addEventListener('focusout',()=>setTimeout(_keyboardLift,0));
}

// THE JSON ANSWER GROWS WITH WHAT IS TYPED: it opens as a moderate area (its
// rows) and gets taller line by line up to the stylesheet's max-height, where
// the rest scrolls inside it. Cleared, it shrinks back to its rows. A delegated
// input handler (core/main.js `task-answer-fit`).
export function fitAnswerArea(el){
  if(!el||el.tagName!=='TEXTAREA')return;
  el.style.height='';
  const cs=getComputedStyle(el);
  const max=parseFloat(cs.maxHeight);
  const edge=el.offsetHeight-el.clientHeight;
  const want=el.scrollHeight+edge;
  if(want<=el.offsetHeight)return;   // its rows still hold it: leave it at rest
  el.style.height=`${Number.isFinite(max)?Math.min(want,max):want}px`;
}

function _attemptsLineInner(left,cap){
  return left===1
    ? `${ICO.lock} <strong>Last attempt.</strong> If this one is wrong you will not be able to try again.`
    : `${esc(String(left))} of ${esc(String(cap))} attempts left on this challenge.`;
}
function _syncStandardAttempts(left,cap,used){
  // v8.13.1 (pre-release review) — the header's "N attempt(s)", the count of
  // submissions so far, or the card shows two numbers that disagree: "0 attempt(s)"
  // beside "Last attempt". Same count (lib/attempts.js `attemptsUsed`), so the
  // server's own value, never a client increment.
  //
  // v8.13.2 (external audit) — FIRST, and for EVERY challenge. It sat below the
  // cap gate, so on an uncapped challenge — the ordinary case — the header kept
  // the count from when the challenge was opened after every wrong answer, while
  // the score beside it moved. Every card prints the header; only a capped one
  // draws the line, so only the line waits for `left`.
  const head=document.querySelector('#task-detail-card .attempts-count');
  if(head&&Number.isInteger(used))head.textContent=attemptsCountText(used);
  if(!Number.isInteger(left)||left<1)return;
  const line=document.querySelector('#task-detail-card .attempts-left');
  if(!line)return;   // an uncapped challenge never drew one
  line.classList.toggle('attempts-last',left===1);
  setSafeHtml(line,_attemptsLineInner(left,Number.isInteger(cap)?cap:left));
}

// ── The play stats: one component, two homes ─────────────────────────────────
//
// The focus view's play bar (#qa-playbar, static in index.html) and the events
// page's progress strip (competition-picker.js) show the SAME three readouts,
// drawn by ONE renderer, so the two can never describe a participant's run
// differently: where they are among the event's challenges, the time left (a
// ring that empties as the window runs) and the score. Each readout is [hidden]
// unless it has something to say — a Program is not ranked, so no score readout
// (as the header shows none), and has no clock worth a ring; a list the tab has
// never loaded has no position.
const _TRACK_MAX=40;   // past this many challenges the track is one bar, not segments

/**
 * @param m.done   one boolean per challenge, in list order (solved or not)
 * @param m.quick  optional, one boolean per challenge: a quick question, which
 *                 the solved count leaves out (it finishes nothing)
 * @param m.out    optional, one boolean per challenge: no attempts left on it
 *                 (the list's `out_of_attempts`), drawn as a hollow segment.
 *                 Both homes pass it, so they describe a spent challenge alike;
 *                 absent or all false, the output is what it was without it
 * @param m.idx    the challenge this run is AT (0-based), -1 when none
 * @param m.over   optional, true when nothing is left to answer (the strip's
 *                 runStanding idx -1): no segment is current, and the top line
 *                 says how many are solved ("1 / 3 solved", scoring challenges
 *                 only) rather than where the run is. The play bar never passes it
 * @param m.gauge  true to draw the time ring (painted afterwards by paintGauge)
 * @param m.when   the play bar's text readout (painted afterwards by paintWhen):
 *                 `{left:true}` says the time left in words where no ring is
 *                 drawn (a Program: "12 days left"); either way it says "Late
 *                 entry" while a late entrant's window is open. The same at every
 *                 width (operator ruling, 14 Nov 2026). Absent: no readout.
 * @param m.score  a number to show, or null for none (an unranked kind)
 */
export function playStatsHtml(m){
  const done=Array.isArray(m.done)?m.done:[];
  const quick=Array.isArray(m.quick)?m.quick:[];
  const out=Array.isArray(m.out)?m.out:[];
  const total=done.length;
  const over=!!m.over;
  const idx=over?-1:(Number.isInteger(m.idx)?m.idx:-1);
  let prog='<div class="qa-prog" hidden></div>';
  if(total>1&&idx>=0||over&&total>=1){
    const solved=done.filter((d,i)=>d&&!quick[i]).length;
    const track=total<=_TRACK_MAX
      ?`<div class="qa-track" aria-hidden="true" style="--cols:${total}">${done.map((d,i)=>`<i class="${i===idx?'now':d?'done':out[i]?'out':''}"></i>`).join('')}</div>`
      :`<div class="qa-track qa-track-bar" aria-hidden="true"><i class="done" style="width:${Math.round(done.filter(Boolean).length/total*100)}%"></i></div>`;
    // Nothing left to answer: no challenge is current, so the line says how the
    // run ended — the solved count over the challenges that finish it, the word
    // "solved" in visible text (a phone hides the eyebrow).
    const scoringTotal=done.filter((d,i)=>!quick[i]).length;
    // Over with no scoring challenge (quick questions only): count the answers, not solves.
    const top=over&&!scoringTotal
      ?`<span class="eyebrow">Questions</span><b class="qa-prog-n">${esc(String(done.filter(Boolean).length))}<span class="qa-prog-of"> / ${esc(String(total))} answered</span></b>`
      :over
      ?`<span class="eyebrow">Challenges</span><b class="qa-prog-n">${esc(String(solved))}<span class="qa-prog-of"> / ${esc(String(scoringTotal))} solved</span></b>`
      :`<span class="eyebrow">Challenge</span><b class="qa-prog-n">${esc(String(idx+1))}<span class="qa-prog-of"> / ${esc(String(total))}</span><span class="sr-only">, ${esc(String(solved))} solved</span></b>`;
    prog=`<div class="qa-prog"><div class="qa-prog-top">${top}</div>${track}</div>`;
  }
  const gauge=`<div class="qa-gauge" role="timer" aria-live="off" hidden><span class="qa-gauge-val"></span><span class="qa-gauge-unit">left</span></div>`;
  const when=m.when?`<div class="qa-when" data-left="${m.when.left?'1':'0'}" hidden><span class="qa-when-left" hidden></span><span class="qa-when-late" hidden>Late entry</span></div>`:'';
  const score=(typeof m.score==='number'&&Number.isFinite(m.score))
    ?`<div class="qa-score"><span class="eyebrow">Score</span><b class="bignum qa-score-val">${esc(String(m.score))}</b></div>`
    :'<div class="qa-score" hidden><span class="eyebrow">Score</span><b class="bignum qa-score-val"></b></div>';
  return prog+(m.gauge?gauge:'')+when+score;
}

/**
 * Paint the play bar's text readout: the time left in words ("12 days left",
 * the events list's own wording, timeLeftWords; "No fixed deadline" while the
 * server's `open_ended` holds) where the bar draws no ring, and "Late entry"
 * while the participant's late window is open. Hidden when it has nothing to
 * say. Returns whether it shows.
 */
export function paintWhen(w,endMs,ended,late,openEnded){
  if(!w)return false;
  const left=w.querySelector('.qa-when-left'),lateEl=w.querySelector('.qa-when-late');
  const rem=endMs-Date.now();
  const txt=(w.dataset.left==='1'&&!ended&&Number.isFinite(rem)&&rem>0)?timeLeftWords(rem,openEnded):'';
  if(left){if(left.textContent!==txt)left.textContent=txt;left.hidden=!txt;}
  if(lateEl)lateEl.hidden=!late;
  w.hidden=!txt&&!late;
  return !w.hidden;
}

/**
 * The ring's words, adapted to what is left: more than a day reads "3d" with
 * "18h" beneath; under a day a clock, "2:14:07" (or "9:59" inside the last
 * hour); the final minute "42 s". The ring is what shows how much of the window
 * is gone; the words say how long is left.
 */
export function gaugeParts(ms){
  const s=Math.max(0,Math.floor(ms/1000));
  const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),mi=Math.floor(s%3600/60),sec=s%60;
  const pad=n=>String(n).padStart(2,'0');
  if(d>=1)return{fmt:'days',val:`${d}d`,unit:`${h}h`};
  if(s>=60)return{fmt:'clock',val:h>0?`${h}:${pad(mi)}:${pad(sec)}`:`${mi}:${pad(sec)}`,unit:'left'};
  return{fmt:'secs',val:`${sec} s`,unit:'left'};
}

// THE WORDS FIT THE RING at every width and in every look. A ring look sets
// --qa-inner, the inner disc as a share of the ring (styles.css); the text block
// (value over unit) must sit inside that disc, so the widest the value may be is
// the chord at the block's half height. Re-measured only when the text length,
// the ring's size or the format changes, never every second.
function _fitGauge(g,val,unit){
  const inner=parseFloat(getComputedStyle(g).getPropertyValue('--qa-inner'));
  const key=`${val.textContent.length}|${g.clientWidth}|${g.dataset.fmt}|${inner}`;
  if(g._fitKey===key)return;
  g._fitKey=key;
  val.style.fontSize='';
  val.style.removeProperty('--gauge-fit-fs');
  if(!(inner>0))return;   // an LCD well (Command) grows with its text instead
  const r=g.clientWidth*inner/2-2;
  if(!(r>0))return;
  for(let i=0;i<3;i++){
    const vb=val.getBoundingClientRect(),ub=unit?unit.getBoundingClientRect():{width:0,height:0};
    const half=(vb.height+ub.height)/2;
    const chord=2*Math.sqrt(Math.max(0,r*r-half*half));
    const w=Math.max(vb.width,ub.width);
    if(!w||w<=chord)return;
    const cur=parseFloat(getComputedStyle(val).fontSize)||12;
    // A measured fit, not a type choice: the shrink rides a custom property so
    // the declaration itself stays a token reference (type-scale scanner).
    val.style.setProperty('--gauge-fit-fs',`${Math.max(8,Math.floor(cur*chord/w*10)/10)}px`);
    val.style.fontSize='var(--gauge-fit-fs)';
  }
}

/** Paint one ring for a window ending at endMs; false when there is nothing left to count. */
export function paintGauge(g,endMs,startMs,ended){
  if(!g)return false;
  const rem=endMs-Date.now();
  if(ended||!Number.isFinite(rem)||rem<=0){g.hidden=true;return false;}
  const span=endMs-startMs;
  const p=Number.isFinite(span)&&span>0?Math.max(0,Math.min(1,rem/span)):1;
  g.style.setProperty('--p',p.toFixed(4));
  const parts=gaugeParts(rem);
  const val=g.querySelector('.qa-gauge-val'),unit=g.querySelector('.qa-gauge-unit');
  if(val&&val.textContent!==parts.val)val.textContent=parts.val;
  if(unit&&unit.textContent!==parts.unit)unit.textContent=parts.unit;
  g.dataset.fmt=parts.fmt;
  // A long clock ("2:14:07") takes the ring's whole face: the ring grows a
  // little and drops "left" (styles.css .qa-gauge[data-long]).
  g.toggleAttribute('data-long',parts.val.length>5);
  g.setAttribute('aria-label',`${formatDuration(rem)} left`);
  g.classList.toggle('qa-gauge-warn',rem<60_000);
  const wasHidden=g.hidden;
  g.hidden=false;
  if(val){if(wasHidden)g._fitKey='';_fitGauge(g,val,unit&&unit.offsetParent?unit:null);}
  return true;
}

// THE PROGRESS A TAB HAS SEEN, per participant and event, so the events page
// can show a run the participant left without asking the server again: written
// by the challenge list (which challenges are solved) and by every score read
// (the pulse, /api/me). sessionStorage so a reload keeps it; where storage is
// refused (a private window, blocked site data) the strip simply shows less,
// and the store stops trying.
const _PROG_KEY='ha:progress';
let _prog=null;
let _progPersist=true;
function _progStore(){
  if(_prog)return _prog;
  _prog={};
  try{const raw=sessionStorage.getItem(_PROG_KEY);if(raw){const o=JSON.parse(raw);if(o&&typeof o==='object')_prog=o;}}
  catch(e){_progPersist=false;_prog={};}
  return _prog;
}
const _progKey=compId=>`${(S.currentUser&&S.currentUser.id)||''}|${compId}`;
export function recordProgress(compId,patch){
  if(!compId)return;
  const st=_progStore();const k=_progKey(compId);
  st[k]={...(st[k]||{}),...patch,at:Date.now()};
  if(!_progPersist)return;
  try{sessionStorage.setItem(_PROG_KEY,JSON.stringify(st));}
  catch(e){_progPersist=false;}
}
export function progressFor(compId){
  return compId?(_progStore()[_progKey(compId)]||null):null;
}

/**
 * WHERE A RECORDED RUN STANDS — the one judge, for the events page's progress
 * strip (competition-picker.js). Pure: it reads a progressFor record only.
 *   idx    the first challenge neither solved nor out of attempts, as Next
 *          challenge passes over one (a quick question still to answer counts);
 *          -1 when nothing is left to answer
 *   solved, total  over the challenges that finish the run (quick questions
 *          left out, as "N/M solved" counts them)
 *   state  'solved' — every one of those solved (the board's All solved);
 *          'spent' — every one solved or out of attempts, not all solved (the
 *          server's finished: lib/attempts.js participantsFinishedAll);
 *          'playing' — anything else.
 * A record written before `out` was (stale sessionStorage) reads as not out.
 */
export function runStanding(p){
  const done=Array.isArray(p&&p.done)?p.done:[];
  const out=Array.isArray(p&&p.out)?p.out:[];
  const quick=Array.isArray(p&&p.quick)?p.quick:[];
  const scoring=done.map((d,i)=>i).filter(i=>!quick[i]);
  const solved=scoring.filter(i=>done[i]).length;
  const idx=done.findIndex((d,i)=>!d&&!out[i]);
  const allSolved=scoring.length>0&&solved===scoring.length;
  const finished=scoring.length>0&&scoring.every(i=>done[i]||out[i]);
  // An event of quick questions only has nothing to solve: answered all, it is done.
  const answered=scoring.length===0&&done.length>0&&idx<0;
  return {idx,solved,total:scoring.length,state:allSolved?'solved':finished?'spent':answered?'answered':'playing'};
}

let _gaugeIv=null;
function _tickGauge(){
  const g=document.querySelector('#qa-stats .qa-gauge');
  const w=document.querySelector('#qa-stats .qa-when');
  if((!g&&!w)||document.querySelector('.page.active')?.id!=='task-detail-page'){
    if(_gaugeIv){clearInterval(_gaugeIv);_gaugeIv=null;}
    return;
  }
  _paintBarClock(g,w);
}
function _paintBarClock(g,w){
  const end=S.hackathonEndTime instanceof Date?S.hackathonEndTime.getTime():NaN;
  const start=S.hackathonStartTime instanceof Date?S.hackathonStartTime.getTime():NaN;
  if(g)paintGauge(g,end,start,S.hackathonEnded);
  // The late flag follows /api/status and every pulse (S._lateEntryActive).
  if(w)paintWhen(w,end,S.hackathonEnded,!!S._lateEntryActive&&!S.hackathonEnded,S.hackathonOpenEnded);
}
function _paintPlaybar(t){
  const box=document.getElementById('qa-stats');
  if(box){
    const list=Array.isArray(S.allTasks)?S.allTasks:[];
    const pol=policyOrDefault(S.currentCompPolicy);
    const ranked=pol.ranking_enabled;
    const pill=document.getElementById('header-score');
    const m=pill&&/^(-?\d+)/.exec(pill.textContent||'');
    setSafeHtml(box,playStatsHtml({
      done:list.map(x=>!!x.solved),
      quick:list.map(x=>_isQualifying(x)),
      out:list.map(x=>!!x.out_of_attempts),
      idx:list.findIndex(x=>x.id===t.id),
      // A Program runs to a deadline weeks out: a ring that barely moves says
      // nothing, so its bar says the time left in words instead ("12 days
      // left"); its progress strip shows the track alone.
      gauge:pol.schedule!=='deadline',
      when:{left:pol.schedule==='deadline'},
      score:ranked&&m?Number(m[1]):null,
    }));
  }
  if(_gaugeIv){clearInterval(_gaugeIv);_gaugeIv=null;}
  // The ring and the time readout are drawn [hidden]; show them NOW, before
  // openTask's showMain, so the bar already has its height when the route focus
  // scrolls the title clear of it (it reads the bar's bottom edge: ui/nav.js
  // publishStripBottoms). Shown by the first tick instead, they grew the bar
  // after that scroll, over the title. The ticks then run after showMain (the
  // page check above reads it); the first one also fits the ring's text, which
  // needs the page on screen.
  _paintBarClock(box&&box.querySelector('.qa-gauge'),box&&box.querySelector('.qa-when'));
  setTimeout(()=>{_tickGauge();if(!_gaugeIv)_gaugeIv=setInterval(_tickGauge,1000);},0);
}

// Operator ruling 395 (14 Nov 2026) — `opts.change` opens an answered Quick
// question to CHANGE its answer: the answerable card (or the booth tap card on a
// phone) with the current pick shown, offered only where the server says the
// new pick will be taken (`answer_changeable`, the submit's own rule). Any other
// open, or a challenge that is no longer changeable, renders as usual.
export async function openTask(id,opts){
  // If another task detail is already open, record the SPA-nav-away first.
  if(S._openedTaskId&&S._openedTaskId!==id)fireNavigatedAway('spa_nav');
  // A new challenge supersedes any pending re-arm from an earlier tab switch.
  S._navAwayResumeId=null;
  // v8.12.6 — this open supersedes every earlier one still in flight: the LAST
  // click wins whatever order the responses arrive in (a page-change bump alone
  // lets the FIRST of two pending opens win when it answers first).
  S._taskViewGen++;
  const stale=_taskViewStale();
  // v7.23.0 — a failed open must SAY so. This was `if(!r.ok)return;`, so tapping
  // a challenge did literally nothing when the request failed: no message, no
  // spinner, no state change, on the participant's most-used control. It is
  // reachable without any server fault at all — the per-IP limiters 429 a whole
  // venue behind one NAT address (v7.15.34), which is exactly when a roomful of
  // people are tapping challenges at once.
  //
  // fetchTransientRetry rides out the transient case (429 / 5xx / dropped
  // connection) the way every other participant read does; anything that
  // survives it is a considered answer and is reported with the server's own
  // wording where there is one.
  const r=await fetchTransientRetry(`/api/tasks/${id}`);
  // v8.12.6 — superseded: the participant opened something else, changed page or
  // switched event while this was in flight (the transient retry included). Drop
  // it SILENTLY — an error for an open they abandoned is its own wrong answer
  // (the v7.21.15 rule), and painting it would replace what they are looking at.
  if(stale())return;
  if(!r||!r.ok){
    const d=await readBody(r);
    if(stale())return;
    showToast(
      (d&&d.error) ||
      (r?`Could not open this challenge (${r.status}). Please try again.`
        :'Network problem opening this challenge. Please try again.'),
      'error');
    return;
  }
  let t=await readBody(r);
  // Re-checked post-parse: `fetch` resolves at response HEADERS (v7.15.15).
  if(stale())return;
  if(!t){ showToast('Could not read this challenge. Please try again.','error'); return; }
  // Changing a Quick question's answer: drawn answerable, with no attempts line
  // (a change spends none), carrying the current pick (`my_choice_ids`).
  if(opts&&opts.change&&t.answer_changeable){
    t={...t,solved:false,_changing:true};
    delete t.attempts_left;delete t.attempts_cap;
  }
  // BELOW the guard, deliberately: a dropped read must not overwrite a newer
  // read's grading token, or a double-click that straddled an admin edit is
  // refused `task_changed` on a challenge the participant is looking at.
  if(t.grading_hash) _taskGradingHashes.set(id, t.grading_hash);
  if(t.qualifying)_openedQuick.add(id);else _openedQuick.delete(id);
  const revealSolution=t.competition_fully_ended;
  // v8.12.6 (review) — THE SEALED-ANSWER PANEL RENDERS WHEREVER THE SERVER SAYS
  // THE SEAL TOOK SOMETHING, not only at the end. `answer_sealed_withheld` also
  // rides the v7.20.1 CHOICE-SOLVER concession mid-event (a solver of a sealed
  // multiple-choice challenge is not sent the correct ids), and the panel was
  // reachable only through `revealSolution` — so the solved card showed unmarked
  // options with no reason at all: indistinguishable from the platform having
  // lost the answer, and, for a superadmin whose reveal could not be recorded
  // (`unrecorded`), no "open it again to retry" either. The server emits the
  // flag only on the reveal and on that concession, so this adds the panel
  // exactly there — under the option list, with the same sentence per reason.
  let answerAreaHtml;
  if(t.solved){
    // v7.20.1 — the options are part of the QUESTION. Keep showing them (marked
    // where the answer is known) instead of leaving the challenge looking blank.
    answerAreaHtml=(t.answer_type==='choice'||t.pick_one)?renderChoiceReview(t):'';
  }else if(t.hackathon_ended){
    answerAreaHtml=(t.answer_type==='choice'||t.pick_one)?renderChoiceReview(t):'';
  }else if(t.attempts_left===0){
    // v8.1.0 — EXHAUSTED. The input is REPLACED, not merely disabled: a live box
    // in front of a submission that can only be refused is an affordance that
    // lies, and this is the same rule as the ended branch above. The options stay
    // visible for a choice challenge because they are part of the question.
    //
    // v8.1.4 — REPORT WHAT THEY SPENT, NOT THE CEILING, or the card contradicts
    // itself. Lowering a cap below a participant's existing spend is permitted
    // (cap edits validate only the 1..1000 range), and `attemptState` leaves
    // `used` raw while clamping `left` to 0 — so the header's "5 attempt(s)" sat
    // beside "you have used all 3 attempts" on the same screen. Enforcement was
    // always right; only the two numbers disagreed, and disagreeing numbers read
    // as a broken feature. `Math.max` is byte-identical in every ordinary case
    // (exhaustion means used === effective) and honest in the lowered-cap one.
    const _spent=Number.isInteger(t.attempts)?Math.max(t.attempts,t.attempts_cap):t.attempts_cap;
    answerAreaHtml=((t.answer_type==='choice'||t.pick_one)?renderChoiceReview(t):'')+`
      <div class="attempts-exhausted">
        <div class="attempts-exhausted-title">${ICO.lock} No attempts left</div>
        <div class="attempts-exhausted-body">You have used all ${esc(String(_spent))} attempts on this challenge. Ask an organiser if you need another try.</div>
      </div>`;
  }else{
    answerAreaHtml=renderAnswerInput(t);
  }
  // v8.13.0 — THE FRAGMENTS BOTH RENDERERS SHARE. The standard card and the
  // booth tap card (features/choice-tap.js) say the same things about a
  // challenge — its hint, categories, author, description and attachments — so
  // they are built ONCE here and handed to whichever renders. A second copy in
  // the tap renderer would agree on the day it was written and drift after.
  // Interpolating a value computed above is byte-identical to computing it
  // inline, so the standard card's markup has not moved.
  const _parts={
    hint:buildHintHtml(t),
    categories:renderCategories(t.categories),
    author:t.author_name?`<div class="qa-author">By <strong>${esc(t.author_name)}</strong>${t.author_linkedin?` &middot; <a href="${esc(t.author_linkedin)}" target="_blank" rel="noopener noreferrer">LinkedIn</a>`:''}</div>`:'',
    description:renderRich(t.description||''),
    attachments:(Array.isArray(t.attachments)&&t.attachments.length)?`<div class="task-detail-attachments">
      <div class="task-detail-attachments-label">${ICO.download}Downloads</div>
      <div class="task-detail-attachments-list">
        ${t.attachments.map(a=>`<a href="/api/tasks/${esc(t.id)}/attachments/${esc(a.id)}" class="btn secondary sm task-detail-attachment-link" download="${esc(a.display_name)}.zip" rel="noopener">${ICO.paperclip}<span class="task-detail-attach-name">${esc(a.display_name)}</span><span class="task-detail-attach-size">(${esc(_fmtBytes(a.size_bytes))})</span></a>`).join('')}
      </div>
    </div>`:'',
    legacyAttachment:t.attachment_url&&/^https?:\/\//i.test(t.attachment_url)?`<div style="margin-top:14px"><a href="${esc(t.attachment_url)}" target="_blank" rel="noopener noreferrer" class="btn secondary sm">${ICO.paperclip} Download Attachment</a></div>`:'',
  };
  const cardEl=document.getElementById('task-detail-card');
  // v8.13.0 — a Booth Event's answerable multiple-choice challenge, on a phone,
  // is ONE screen of large tiles. Decided once per open from the event's wire
  // policy and the device, never from the kind; see choice-tap.js.
  const tap=choiceTapApplies(t);
  if(tap){prepareTapCard(cardEl,t);setSafeHtml(cardEl,renderTapCard(t,_parts));}
  else resetTapCard(cardEl);
  // THE FOCUS VIEW. Two columns on a wide screen — the question on the left,
  // the answer (hint, attempts, input, result) on the right where the eye
  // lands after reading — and one column on a phone, where the Submit button
  // rides a fixed bar at the thumb (styles.css "participant: challenge").
  // Every id, class and data-action the flows read is unchanged: #submit-result,
  // #ans-text, .ans-choice, .attempts-count, .attempts-left, #hint-area,
  // .answer-area, #choice-review.
  // THE SOLVED STATE is the moment, not a banner: the options stay (correct
  // marked, the rest drawn dashed and muted), and the answer column carries the
  // inline "Correct" panel with the points and the way on — the next unsolved
  // challenge. The rating lives in the answer column too, small, where the
  // participant is already looking once they have answered.
  if(!tap)setSafeHtml(cardEl, `
    ${t.solved?''
      :t.hackathon_ended?`<div class="qa-state qa-state-ended">${ICO.lock}${esc(S.currentCompName)} has ended. Submissions are closed.</div>`:''}
    <div class="qa">
      <article class="qa-question">
        <div class="qa-meta">
          ${t.task_number?`<span class="qa-num">${esc(t.task_number)}</span>`:''}
          ${_diffChipHtml(t)}
          <span class="pts">${esc(_ptsLabel(t))}</span>
          ${t.solved?`<span class="badge solved qa-solved-chip">${ICO.check}${_isQualifying(t)?'Answered':'Solved'}</span>`:''}
          ${t.hackathon_ended&&!t.solved?`<span class="qa-ended-chip"><svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="currentColor"/></svg>Ended</span>`:''}
          ${_isQualifying(t)?'':`<span class="attempts-count">${esc(attemptsCountText(t.attempts))}</span>`}
        </div>
        <h1 class="qa-title display">${esc(t.title)}</h1>
        ${_parts.categories}
        ${_parts.author}
        <div class="task-desc">${_parts.description}</div>
        ${_parts.attachments}
        ${_parts.legacyAttachment}
      </article>
      <section class="qa-answer" aria-label="Your answer">
        ${_parts.hint}
        ${(!t.solved && !t.hackathon_ended && answerCanBeWrong(t) && Number.isInteger(t.attempts_left) && t.attempts_left > 0)
          ? `<div class="attempts-left${t.attempts_left===1?' attempts-last':''}">${_attemptsLineInner(t.attempts_left,t.attempts_cap)}</div>`
          : ''}
        <div class="answer-area">${answerAreaHtml}</div>
        ${t.solved?solvedPanelHtml(t):''}
        ${_isQualifying(t)?'':buildStarRating(t.id,t.my_rating)}
      </section>
    </div>
    ${(revealSolution||t.answer_sealed_withheld||t.answer_changed_since_solve)?buildSolutionHtml(t):''}`);
  _shownTaskId=t.id;   // v8.12.6 — which challenge the card now holds (_taskStillShown)
  cardEl.classList.toggle('qa-card',!tap);
  _paintPlaybar(t);
  showMain('task-detail-page');
  // AFTER showMain, so the measured fit sees the page it is fitting. A standard
  // card releases any tap chrome left by the previous open (a re-render after a
  // last wrong answer lands here with the tap card still on screen).
  if(tap)enterTapChrome(cardEl,{isBusy:()=>_submitInFlight.has(t.id)});
  else{
    releaseTapChrome();_installQaKeys();
    const nx=cardEl.querySelector('.qa-next[data-next-task-id]');
    if(nx)nx.addEventListener('click',()=>openTask(nx.dataset.nextTaskId));
  }
  S._openedTaskId=t.id;
  // Syntax-highlight code blocks: convert editor <br>/<div> to newlines, then apply hljs
  setTimeout(()=>{
    document.querySelectorAll('#task-detail-card pre code').forEach(el=>{
      setSafeHtml(el, el.innerHTML.replace(/<br\s*\/?>/gi,'\n').replace(/<div>/gi,'\n').replace(/<\/div>/gi,''));
      el.removeAttribute('data-highlighted');
      highlightCodeElement(el);
    });
  },0);
  // Focus answer input
  setTimeout(()=>{const el=document.getElementById('ans-text');if(el)el.focus();},100);
}

// v8.12.2 — why a sealed hint is withheld from THIS reader, one sentence per
// reason the server can give (`hint_withheld_reason`, lib/answer-seal.js
// SEALED_HINT_WITHHELD_REASONS). The server's refusal of the paid route carries
// the longer version of the same sentence.
// v8.12.6 — plus `unrecorded` (lib/answer-seal.js SEAL_UNRECORDED_REASON): a
// superadmin the seal ADMITS, whose reveal could not be written into the
// challenge's history, so nothing was shown. A spec diffs these keys against
// the server's reason set.
const _HINT_WITHHELD_COPY=Object.freeze({
  competing_elsewhere:"This challenge's author sealed its hint. You are competing in an event that also holds this challenge, so it is not shown to you here either.",
  impersonating:"This challenge's author sealed its hint. It is not shown to an admin looking through someone else's account.",
  not_competing:"This challenge's author sealed its hint. You are here as staff and are not competing in this event, so it is not shown to you.",
  unrecorded:"This challenge's author sealed its hint. Showing it to you has to be recorded in the challenge's history, and that could not be done just now, so it is not shown. Open the challenge again to retry.",
});
export function hintWithheldCopy(reason){
  return _HINT_WITHHELD_COPY[reason]||"This challenge's author sealed its hint, so it is not shown here.";
}

export function buildHintHtml(t){
  if(t.answer_type==='any')return'';   // v8.9.0 — an any-answer challenge has no hint, ever
  // v8.12.2 — A SEALED HINT THIS READER CAN NEVER BE GIVEN is withheld WITH its
  // reason, never silently (v7.14.2). The server sends `hint_withheld` only when
  // the seal is what withholds — an admin in their own participant view who is
  // not competing, or an admin impersonating somebody who paid for it (the paid
  // row is the TARGET's; the reader is an admin). Before this branch existed the
  // hint section simply vanished, and one release earlier the reader was offered
  // the priced "Show Hint" button over a hint they could not buy — a control the
  // server was certain to refuse. Found by the pre-release review.
  //
  // THE SENTENCE IS THE SERVER'S REASON, NOT ONE GUESS FOR EVERY READER. One
  // fixed sentence told a superadmin competing elsewhere that "a superadmin" is
  // shown the hint, and told an admin looking through a paying participant's
  // account that competing participants see it — both true of somebody else and
  // false as an explanation to the reader (the second review). The server says
  // which in `hint_withheld_reason`; an unknown value takes the neutral sentence,
  // which is true whatever the reason.
  if(t.hint_withheld){
    return`<div style="margin-top:16px;padding:12px 16px;background:var(--surface2);border-radius:var(--radius-md)" class="hint-box" id="hint-area" data-hint-withheld="1" data-hint-withheld-reason="${esc(t.hint_withheld_reason||'')}">
      <div class="hint-box-head">${ICO.lock} Hint withheld</div>
      <div style="color:var(--muted)">${esc(hintWithheldCopy(t.hint_withheld_reason))}</div>
    </div>`;
  }
  if(!t.hint_available)return'';
  // v6.16.2 — only render the "Hint" panel when the server actually
  // shipped t.hint. Pre-fix the panel rendered an empty body any
  // time t.competition_fully_ended was true, even when the comp had
  // reveal_answers_on_end=false (the default) and the server
  // correctly withheld the hint text from the response. The
  // resulting empty grey box was a confusing UX. The "Show Hint"
  // button below is the right rendering for an unrevealed hint
  // when the comp isn't revealing.
  if((t.hint_revealed||t.solved||t.competition_fully_ended)&&t.hint){
    return`<div style="margin-top:16px;padding:12px 16px;background:var(--surface2);border-radius:var(--radius-md)" class="hint-box" id="hint-area">
      <div class="hint-heading">${ICO.lightbulb} Hint</div>
      <div style="color:var(--muted)">${renderRich(t.hint)}</div>
    </div>`;
  }
  // v6.16.2 — once the comp has fully ended, hide the "Show Hint"
  // button entirely (no submit window left, no point penalising
  // for a hint reveal). Pre-v6.16.2 the button rendered after end,
  // but clicking it would 403 from the new hint-endpoint
  // lifecycle gate (server.js:5538) — better to not render.
  if(t.competition_fully_ended)return'';
  // v8.1.0 — NO ATTEMPTS LEFT: the priced button is REMOVED, and the reason
  // takes its place. Pre-fix the yellow "Show Hint −N pts" row rendered directly
  // ABOVE the "No attempts left" panel, so one screen offered a permanent 30%
  // deduction on a challenge the next paragraph said could never be attempted
  // again — and the server took the deduction. Gate the affordance and the
  // explanation together (v7.14.2).
  //
  // NOT disabled-in-place, for the same reason the answer input is replaced
  // rather than greyed: a live-looking control that can only be refused is an
  // affordance that lies.
  //
  // `!t.solved` is load-bearing — a participant whose LAST attempt was the
  // correct one has `attempts_left === 0`, and the server hands a solver the hint
  // free (it can cost them nothing). Withholding it here would take away
  // something they are entitled to. An already-revealed hint never reaches this
  // line at all: it was paid for, and the branch above has already rendered it.
  if(!t.solved&&t.attempts_left===0){
    return`<div style="margin-top:16px;padding:12px 16px;background:var(--surface2);border-radius:var(--radius-md)" class="hint-box" id="hint-area">
      <div class="hint-box-head">${ICO.lightbulb} Hint unavailable</div>
      <div style="color:var(--muted)">A hint costs points, and you have no attempts left on this challenge — so it cannot help you here. If an organiser grants you another attempt, the hint becomes available again.</div>
    </div>`;
  }
  // A quick question scores nothing, so its hint costs nothing (the server
  // charges 0: routes/participant.js).
  const cost=_isQualifying(t)?0:Math.round(DIFF_PTS[t.difficulty]*0.3);
  // Cautionary affordance: the "Show Hint" row sits inside a soft yellow
  // tint with a yellow left border so the participant's eye registers
  // "you're about to spend points" before they click. Tokens only —
  // var(--yellow-soft) and var(--yellow) adapt to dark/light theme.
  return`<div style="margin-top:16px;padding:12px 16px;background:var(--yellow-soft);border-left:3px solid var(--yellow);border-radius:var(--radius-md);display:flex;align-items:center;gap:12px;flex-wrap:wrap" id="hint-area" role="status" aria-live="polite">
    <button class="btn sm secondary" data-action="task-reveal-hint" data-task-id="${esc(t.id)}" data-cost="${cost}" style="display:inline-flex;align-items:center;gap:6px">${ICO.lightbulb}Show Hint</button>
    <span class="hint-price">${cost?`−<strong style="color:var(--badge-red-fg)">${cost} pts</strong> (30% deduction, once only)`:'Free: a quick question scores nothing'}</span>
  </div>`;
}

export function buildSolutionHtml(t){
  // For a choice task the answer is shown with the options, so the Solution box
  // exists only for the explanation — with no explanation there is nothing left
  // to say and the box would render as an empty shell.
  // v8.9.0 — and an any-answer challenge has no key at all, so the same rule.
  const showsAnswer=!!t.correct_answer&&t.answer_type!=='choice'&&t.answer_type!=='any';
  // v8.10.0 — A SEALED CHALLENGE CONTRIBUTES NOTHING TO THE REVEAL, AND SAYS SO.
  //
  // The server withholds `correct_answer` and `explanation` for a sealed challenge
  // even when the event reveals answers, so this box would otherwise be skipped
  // entirely — indistinguishable from a challenge whose author simply wrote no
  // explanation, on the one screen a participant opens expecting an answer. It
  // renders the reason instead: withhold the thing WITH its explanation (v7.14.2).
  //
  // `answer_sealed_withheld` is emitted by the server ONLY where the seal really
  // TOOK something this participant would otherwise have had — the reveal, and the
  // v7.20.1 solver concession that marks the correct options on a multiple-choice
  // challenge you solved even in an event that reveals nothing. So mid-event it
  // fires only on a SOLVED CHOICE challenge (openTask renders the panel there too,
  // v8.12.6 review — this comment used to say it never fires mid-event, which the
  // server has contradicted since v8.10.0), and never on a challenge whose answer
  // was never coming anyway.
  //
  // THE COPY MUST BE TRUE OF BOTH, which is why it does not mention the reveal:
  // in the solver case the event publishes no answers at all, so "it is not
  // published when the event ends" would name a mechanism that was never going to
  // run and read as though the seal had cost them something it did not.
  //
  // AND IT SAYS NOTHING ABOUT THE HINT (v8.12.2 second review). It used to add
  // "(and its hint), so nobody but them can see it" — false on the very card
  // where a participant's PAID hint renders a few lines above, and contradicting
  // the Hint withheld panel beside it for an admin. The hint has its own panel.
  //
  // …BUT A HINT THAT IS NOT ON THE CARD STILL NEEDS ITS REASON (final review).
  // For an ordinary participant who never bought it, the reveal ships every
  // unsealed hint and not this one, and the hint panel renders nothing at the
  // end (`competition_fully_ended`), so without a clause here the sealed hint
  // simply vanished. The clause appears exactly when there WAS a hint
  // (`hint_available`) that is not on the card and has no withheld panel of its
  // own — never beside a paid hint, which is on the card.
  //
  // And the tier sentence is not said to the one superadmin who meets this box:
  // one competing in an event that holds the challenge (every other superadmin
  // is shown the answer here, on the record) — the server names that reason.
  if(t.answer_sealed_withheld){
    // Only on the END-OF-EVENT card: mid-event an unpaid sealed hint is off the
    // card legitimately, with its priced Show Hint button beside it (buildHintHtml
    // removes that button on exactly `competition_fully_ended`), so "not shown
    // either" would contradict the control a few lines above it.
    const _hintGone=!!t.competition_fully_ended&&!t.hint&&t.hint_available&&!t.hint_withheld;
    const _why=t.answer_withheld_reason==='competing_elsewhere'
      ?'The author of this challenge sealed its answer, and you are competing in an event that also holds this challenge, so it is not shown to you here.'
      // v8.12.6 — a superadmin whose reveal could not be recorded: the tier
      // sentence below would name the reader themselves as the remedy.
      :t.answer_withheld_reason==='unrecorded'
      ?'The author of this challenge sealed its answer. Showing it to you has to be recorded in the challenge\'s history, and that could not be done just now, so it is not shown. Open the challenge again to retry.'
      :'The author of this challenge sealed its answer, so it is not shown here — organisers do not see it either; only a superadmin can reveal it, and every reveal is recorded.';
    return '<div style="margin-top:24px;padding:20px;background:var(--surface2);border:1px solid var(--border);border-left:3px solid var(--yellow);border-radius:var(--radius)" data-answer-withheld="1">'
      +`<h3 class="sol-head sol-warn">${ICO.lock} Answer not shown</h3>`
      +`<p class="sol-body">${_why}${_hintGone?' Its hint is sealed with it, so it is not shown either.':''} Everything else about your attempt is unaffected: your score, your place and whether you solved it are all counted as normal.</p>`
      +'</div>';
  }
  // v8.14.5 — A SOLVE THE KEY NO LONGER MATCHES. The server stops marking the
  // options for a solver once an organiser has changed the correct answer since
  // their solve (sending the new key would hand it out mid-event), and says so
  // with this flag, so the card states the reason instead of showing unmarked
  // options. Nothing re-grades the solve, so it still counts while this shows.
  if(t.answer_changed_since_solve){
    return '<div style="margin-top:24px;padding:20px;background:var(--surface2);border:1px solid var(--border);border-left:3px solid var(--yellow);border-radius:var(--radius)" data-answer-changed="1">'
      +`<h3 class="sol-head sol-warn">${ICO.info} Answer changed</h3>`
      +'<p class="sol-body">An organiser edited this challenge after you solved it, so the options are not marked here. Your solve and its points still count.</p>'
      +'</div>';
  }
  if(!showsAnswer&&!t.explanation)return'';
  let html='<div style="margin-top:24px;padding:20px;background:var(--surface2);border:1px solid var(--border);border-left:3px solid var(--accent2);border-radius:var(--radius)">';
  html+=`<h3 class="sol-head">${ICO.solution} Solution</h3>`;
  // v7.20.3 — a multiple-choice challenge states its answer ABOVE the options
  // (renderChoiceReview), and marks it on them. Repeating it here as a bare
  // "Correct Answer" line said the same thing a third time, in the least
  // useful form — detached from the options it refers to.
  if(t.correct_answer && t.answer_type!=='choice' && t.answer_type!=='any'){
    html+='<div style="margin-bottom:12px"><div class="sol-label">Correct Answer</div>';
    html+=`<div style="background:var(--surface);border:1px solid var(--border);padding:10px 14px;border-radius:var(--radius-md);color:var(--green);word-break:break-all" class="sol-answer">${esc(formatCorrectAnswer(t))}</div></div>`;
  }
  if(t.explanation){
    html+='<div><div class="sol-label">Explanation</div>';
    html+=`<div class="sol-body">${renderRich(t.explanation)}</div></div>`;
  }
  html+='</div>';
  return html;
}

export function buildStarRating(taskId,rating){
  // 1-5 from the server, or none; a number is all that is ever rendered.
  const currentRating=Number(rating)||0;
  const roving=currentRating||1; // the single tab-stop in the roving-tabindex radiogroup
  const stars=Array.from({length:5},(_,i)=>{
    const n=i+1;const filled=currentRating&&n<=currentRating;
    // audit v7.7.33 (AL9) — 44×44 hit target (house standard). The glyph stays
    // 1.5rem; padding + inline-flex centring grow the tappable area on this
    // mobile-likely participant surface (was ~24×29px, on no exception list).
    return`<span class="qa-star" data-value="${n}" role="radio" aria-checked="${n===currentRating?'true':'false'}" aria-label="${n} star${n>1?'s':''}" tabindex="${n===roving?'0':'-1'}"
      style="color:${filled?'var(--yellow)':'var(--muted)'};min-width:44px;min-height:44px"
      data-mouseenter-action="stars-hover" data-action="task-star" data-task-id="${esc(taskId)}">${filled?'&#9733;':'&#9734;'}</span>`;
  }).join('');
  // One quiet row at the foot of the answer column, not a card of its own.
  return`<div class="qa-rate">
    <div id="star-rating-label" class="qa-rate-label">Rate this challenge</div>
    <div id="star-rating" class="qa-rate-stars" role="radiogroup" aria-labelledby="star-rating-label" data-current="${currentRating||0}" data-mouseleave-action="stars-reset">${stars}</div>
    <span id="star-label" class="qa-rate-note">${currentRating?'Your rating: '+currentRating+'/5':''}</span>
  </div>`;
}

export function hoverStars(container,n){
  container.querySelectorAll('span[data-value]').forEach(s=>{
    const v=+s.dataset.value;
    s.style.color=v<=n?'var(--yellow)':'var(--muted)';
    setSafeHtml(s, v<=n?'&#9733;':'&#9734;');
  });
}

export function resetStars(container){
  const cur=+container.dataset.current;
  const roving=cur||1;
  container.querySelectorAll('span[data-value]').forEach(s=>{
    const v=+s.dataset.value;
    s.style.color=cur&&v<=cur?'var(--yellow)':'var(--muted)';
    setSafeHtml(s, cur&&v<=cur?'&#9733;':'&#9734;');
    s.setAttribute('aria-checked',v===cur?'true':'false');
    s.setAttribute('tabindex',v===roving?'0':'-1');
  });
}

// Roving-tabindex keyboard nav for the star-rating radiogroup (delegated; the
// container is rebuilt per task so a one-shot listener can't bind to it).
export function handleStarKeydown(ev){
  const grid=ev.target?.closest?.('#star-rating');
  if(!grid)return;
  const opts=[...grid.querySelectorAll('span[data-value]')];
  if(!opts.length)return;
  const cur=ev.target.closest('span[data-value]');
  let idx=opts.indexOf(cur);if(idx<0)idx=0;
  if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();cur?.click();return;}
  let next=null;
  if(ev.key==='ArrowRight'||ev.key==='ArrowUp')next=opts[(idx+1)%opts.length];
  else if(ev.key==='ArrowLeft'||ev.key==='ArrowDown')next=opts[(idx-1+opts.length)%opts.length];
  else if(ev.key==='Home')next=opts[0];
  else if(ev.key==='End')next=opts[opts.length-1];
  else return;
  ev.preventDefault();
  if(next){next.focus();submitFeedback(next.dataset.taskId,parseInt(next.dataset.value,10));}
}

export async function submitFeedback(taskId,rating){
  const g=S._compGen;   // v8.12.6 — the rating's outcome belongs to ITS card
  // v8.12.6 (review) — EVERY OFF-CARD OUTCOME NAMES ITS CHALLENGE, the rule the
  // answer outcomes already follow: once another challenge is on screen, "Thanks
  // for your feedback!" or "Failed to save feedback." says nothing about WHICH
  // rating it was. A dropped connection is an outcome too — it used to escape
  // as an unhandled rejection, silent when the rating came from the keyboard.
  const r=await fetch(`/api/tasks/${taskId}/feedback`,{method:'PUT',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({rating})}).catch(()=>null);
  if(!r){
    showToast(_taskStillShown(taskId,g)?'Could not save your rating — check your connection and try again.'
      :`Could not save your rating for “${_taskTitle(taskId)}” — check your connection and try again.`,'error');
    return;
  }
  if(!r.ok){
    const d=await r.json().catch(()=>({}));
    showToast(_taskStillShown(taskId,g)?(d.error||'Failed to save feedback.')
      :`“${_taskTitle(taskId)}”: ${d.error||'your rating could not be saved.'}`,'error');
    return;
  }
  // v8.12.6 — the stars on screen now belong to another challenge (or none): the
  // rating was saved, so say so, and leave that challenge's stars alone.
  if(!_taskStillShown(taskId,g)){showToast(`Thanks for your feedback on “${_taskTitle(taskId)}”!`);return;}
  const container=document.getElementById('star-rating');
  if(container){container.dataset.current=rating;resetStars(container);}
  const label=document.getElementById('star-label');
  if(label)label.textContent='Your rating: '+rating+'/5';
  showToast('Thanks for your feedback!');
}

export async function revealHint(taskId,cost){
  // v8.12.6 — every await below can land after the participant has left this
  // challenge, and the confirm names no challenge at all. `gone()` asks whether
  // THIS challenge's card is still the one on screen (reopening it counts).
  const g=S._compGen;
  const gone=()=>!_taskStillShown(taskId,g);
  // v8.12.6 (review) — the fresh read said this hint is ALREADY PAID FOR. From
  // then on nothing below may put it behind the priced confirm: it costs
  // nothing, and a failed re-fetch says it could not be loaded instead.
  let alreadyPaid=false;
  // Cross-tab race: another tab may already have revealed this hint, in which
  // case we should NOT show the cost-confirmation modal again. Re-check the
  // latest state before prompting. The server endpoint is itself idempotent
  // (INSERT OR IGNORE + change-count gate), so calling it twice is safe — the
  // re-check is a UX guard, not a correctness one.
  try{
    const fresh=await fetch(`/api/tasks/${taskId}`).then(r=>r.json()).catch(()=>null);
    // v8.12.6 — THE PARTICIPANT LEFT WHILE THE RE-CHECK WAS IN FLIGHT. The priced
    // confirm below names no challenge, so showing it now would put a permanent
    // deduction for THIS challenge in front of whichever one they are reading —
    // and confirming it used to charge this one and paint its hint into that
    // one. Drop the click; they can ask again from the challenge itself. Checked
    // BEFORE the hint_withheld re-open too, which would yank them back here.
    if(gone())return;
    // v8.12.2 (second review) — the fresh read can now say the hint can NEVER be
    // given to this reader (`hint_withheld`: they started competing elsewhere, or
    // stopped scoring here, since the card rendered). Offering the priced "this
    // penalty is permanent" confirm for a hint the server has just said it will
    // refuse is the v7.14.2 defect, so the card is re-rendered from the server
    // instead and the withheld panel says why. `hint_available===false` is the
    // same answer without the seal (the hint was removed under us).
    // v8.12.6 — ANY `hint_withheld` re-renders, a paid row included: a paid
    // hint can be withheld too now (`unrecorded`, when a superadmin's reveal
    // could not be written down), and the re-fetch below would only meet the
    // same refusal as a 503 — which it used to swallow, leaving a live
    // "Show Hint" button that did nothing and said nothing.
    if(fresh&&(fresh.hint_withheld||(fresh.hint_available===false&&!fresh.hint_revealed))){
      openTask(taskId);
      return;
    }
    if(fresh&&fresh.hint_revealed){
      alreadyPaid=true;
      const r2=await fetch(`/api/tasks/${taskId}/hint`,{method:'POST',headers:csrfHeaders()});
      // A 503 is the status a reverse proxy most often answers with a page of
      // its own, so the body may not be JSON (the v8.11.11 submitAnswer lesson).
      const d2=await r2.json().catch(()=>({}));
      // v8.12.6 (review) — a refusal is spoken wherever the participant is now,
      // NAMING the challenge once they have left it (it used to return silently
      // off-card, and on-card named nothing it did not have to).
      if(!r2.ok){
        showToast(gone()?`“${_taskTitle(taskId)}”: ${d2.error||'the hint could not be loaded.'}`
          :(d2.error||'Failed to reveal hint.'),'error');
        return;
      }
      // v8.12.6 — already paid for; it renders when the challenge is reopened.
      if(gone())return;
      if(d2.hint){
        const area=document.getElementById('hint-area');
        if(area){
          area.setAttribute('style','margin-top:16px;padding:12px 16px;background:var(--surface2);border-radius:var(--radius-md)');area.classList.add('hint-box');
          setSafeHtml(area,`<div class="hint-heading">${ICO.lightbulb} Hint</div><div style="color:var(--muted)">${renderRich(d2.hint)}</div>`);
        }
      }
      return;
    }
  }catch(_){
    // v8.12.6 (review) — THE RE-FETCH OF A HINT ALREADY PAID FOR FAILED (a
    // dropped connection rejects the fetch; nothing else in the try can throw).
    // This used to fall through to the priced "this penalty is permanent"
    // confirm — for a hint that costs nothing, and, when the participant had
    // moved on meanwhile, raised over ANOTHER challenge's card, since the
    // confirm names none. Say it could not be loaded instead, naming the
    // challenge once they have left it.
    if(alreadyPaid){
      showToast(gone()?`Could not load the hint for “${_taskTitle(taskId)}” — check your connection, then reopen that challenge.`
        :'Could not load the hint — check your connection and try again.','error');
      return;
    }
    // Any other throw falls through to the confirmation modal, as it always did.
  }
  // A free hint (a quick question's) needs no priced confirm.
  if(Number(cost)!==0){
    // v8.12.6 (review) — never raise the priced confirm over another challenge's
    // card, whatever route reached this line.
    if(gone())return;
    const ok=await showModal({
      title:'Reveal Hint',
      message:`Revealing this hint will immediately deduct <strong style="color:var(--red)">${cost} points</strong> from your score.<br><br>This penalty is permanent — it applies even if you don\'t solve the challenge later.`,
      confirmText:`Reveal hint (−${cost} pts)`,
      confirmClass:'danger',
      cancelText:'Keep my points'
    });
    if(!ok)return;
  }
  // v8.12.6 — defence in depth: the modal blocks every click, so only a forced
  // navigation underneath it (an eject) reaches this. Never charge for a
  // challenge that is no longer on screen.
  if(gone())return;
  // v8.12.6 (review) — a dropped connection here is an outcome the participant
  // is waiting to hear, like the answer's (v8.1.0 PR 32): it may or may not
  // have been charged, so the copy claims neither, and names the challenge
  // once they have left it. It used to escape to the dispatcher's catch-all.
  const r=await fetch(`/api/tasks/${taskId}/hint`,{method:'POST',headers:csrfHeaders()}).catch(()=>null);
  if(!r){
    showToast(gone()?`Could not reveal the hint for “${_taskTitle(taskId)}” — check your connection, then reopen that challenge to see whether it was revealed.`
      :'Could not reveal the hint — check your connection, then reopen the challenge to see whether it was revealed.','error');
    return;
  }
  const d=await r.json().catch(()=>({}));
  if(!r.ok){
    showToast(gone()?`“${_taskTitle(taskId)}”: ${d.error||'the hint could not be revealed.'}`
      :(d.error||'Failed to reveal hint.'),'error');
    return;
  }
  // v8.12.6 — paid for while the participant was elsewhere. The deduction is
  // real, so the score moves and the toast NAMES the challenge; the hint itself
  // is painted by the next open of that challenge, never into another one's card.
  if(gone()){
    refreshScore();
    showToast(`Hint revealed for “${_taskTitle(taskId)}”. It is shown when you open that challenge again.`);
    return;
  }
  // Route through setSafeHtml (Trusted Types 'app-html' policy) instead of a raw
  // outerHTML assignment — with require-trusted-types-for 'script' enforced,
  // outerHTML = string throws TypeError in modern browsers. Replace the existing
  // flex wrapper's inline style + innerHTML rather than swapping the element so
  // the single TT sink stays load-bearing.
  const area=document.getElementById('hint-area');
  area.setAttribute('style','margin-top:16px;padding:12px 16px;background:var(--surface2);border-radius:var(--radius-md)');area.classList.add('hint-box');
  setSafeHtml(area,`<div class="hint-heading">${ICO.lightbulb} Hint</div><div style="color:var(--muted)">${renderRich(d.hint)}</div>`);
  refreshScore();
}


/**
 * v7.20.1 — the multiple-choice options, READ-ONLY, for a challenge that can no
 * longer be answered (already solved, or the competition has ended).
 *
 * Before this, `answerAreaHtml` was set to '' in both of those cases, so the
 * options simply vanished: a participant reviewing an ended challenge saw the
 * question and no sign of what they had been choosing between. The options are
 * part of the QUESTION, not part of the input.
 *
 * The correct ones are marked only when the client actually has them — the
 * server sends the correct ids to a SOLVER (who already knows: grading is
 * all-or-nothing, so their submitted set was the correct set) and to everyone
 * once a competition with answer-reveal has fully ended. In every other case
 * this renders the options with nothing marked, which is the honest view.
 */
export function renderChoiceReview(t){
  const opts=Array.isArray(t.choices)?t.choices:[];
  if(!opts.length)return '';
  let correctIds=[];
  try{correctIds=JSON.parse(t.correct_answer||'[]');}catch(_){correctIds=[];}
  if(!Array.isArray(correctIds))correctIds=[];
  const known=correctIds.length>0;
  const correct=new Set(correctIds);
  const multi=t.choice_mode==='multi';
  // Event team reports — a pick-one question has no right option to mark, so a
  // later view shows THEIR choice (`my_choice_ids`), in a neutral colour.
  const mine=new Set(t.pick_one&&Array.isArray(t.my_choice_ids)?t.my_choice_ids:[]);
  // v7.20.4 — the answer is marked ON the options and stated nowhere else.
  //
  // v7.20.1 also rendered a separate "Correct answer: X" banner above the list.
  // With the correct row tinted and badged CORRECT, that banner said the same
  // thing a second time, a few pixels away — and the marked row is the better
  // of the two because it says it IN CONTEXT, against the options it refers to.
  // (v7.20.3 had already removed the third copy from the Solution box.)
  const header='';
  return `<div class="choice-review" id="choice-review">
    ${header}
    <div class="choice-review-label">${mine.size?'Your answer':multi?'Choose all that apply':'Choose one'}</div>
    ${opts.map((c,i)=>{
      // The option keeps its key (A, B, C…) in review, as it had while
      // answerable; where the answer is known the right ones are ticked and the
      // rest drawn dashed and muted — never faded, which would sink the text
      // below AA.
      const ok=known&&correct.has(c.id);
      const picked=mine.has(c.id);
      return `<div class="choice-review-row${ok?' is-correct':picked?' is-picked':known||mine.size?' is-dim':''}">
      <span class="choice-key" aria-hidden="true">${String.fromCharCode(65+(i%26))}</span>
      <span class="tpc-text">${esc(c.text)}</span>
      ${ok?`<span class="tpc-badge">${ICO.check}<span class="sr-only">correct</span></span>`:picked?`<span class="tpc-badge">${ICO.check}<span class="sr-only">your answer</span></span>`:''}
    </div>`;}).join('')}
  </div>`;
}

export function renderAnswerInput(t){
  // v6.16.46 — every label has `for=` so screen readers + click-to-focus connect
  // the label to its input; the JSON field uses var(--font-mono).
  //
  // THE SUBMIT ROW (.qa-submit-row) is the one control a phone pins to the
  // bottom of the screen, at the thumb; the result line (#submit-result) stays
  // in the flow above it, so an outcome is never under the bar.
  const tid=esc(t.id);
  const submitRow=(mode,label)=>`<div class="qa-submit-row"><button class="btn lg qa-submit" data-action="task-submit-answer" data-task-id="${tid}" data-mode="${mode}">${label}</button></div>`;
  // The file answer is a compact drop zone: the native input itself, drawn as a
  // dashed box (a file dropped on it is taken), with its button styled to match.
  if(t.answer_type==='file')return`
    <label for="ans-file" class="qa-ans-label">Upload answer file:</label>
    <input type="file" id="ans-file" class="qa-file" accept=".txt,.json,.csv,text/plain,application/json,text/csv" aria-describedby="ans-file-hint"/>
    <p class="qa-ans-hint" id="ans-file-hint">A .txt, .json or .csv file. You can drop it on the box.</p>
    <div id="submit-result" role="status" aria-live="polite"></div>
    ${submitRow('file','Submit File')}`;
  // v7.19.0 — multiple choice. The server sends {id,text} only, already
  // shuffled per participant; it never says which are correct. `choice_mode`
  // decides radios vs checkboxes — a single-answer question rendered as radios
  // is the conventional affordance and stops a participant ticking two.
  //
  // THE TILE. Each option is a large label whose REAL input is drawn as the
  // key (A, B, C…): the letter is an <i> laid over it with pointer-events off,
  // so a click anywhere on the tile still ticks the input, the input keeps its
  // own focus ring, and the option text stays the label's first <span> (a lock
  // reads it there). The letter is aria-hidden: the option is named by its text.
  if(t.answer_type==='choice'){
    const opts=Array.isArray(t.choices)?t.choices:[];
    const multi=t.choice_mode==='multi';
    const inputType=multi?'checkbox':'radio';
    return`
    <fieldset class="choice-fieldset${multi?' is-multi':''}">
      <legend class="qa-ans-label">${multi?'Choose all that apply':'Choose one'}</legend>
      ${opts.length>1&&opts.length<=26?`<p class="qa-keys-hint" aria-hidden="true">Press <kbd>A</kbd>–<kbd>${String.fromCharCode(64+opts.length)}</kbd> to ${multi?'toggle':'pick'}, <kbd>Enter</kbd> to submit</p>`:''}
      ${opts.map((c,i)=>`<label class="choice-option">
        <input type="${inputType}" name="ans-choice" class="ans-choice" value="${esc(c.id)}"/>
        <i class="choice-key" aria-hidden="true">${String.fromCharCode(65+(i%26))}</i>
        <span>${esc(c.text)}</span>
      </label>`).join('')}
    </fieldset>
    <div id="submit-result" role="status" aria-live="polite"></div>
    ${submitRow('choice','Submit Answer')}`;
  }
  if(t.answer_type==='json')return`
    <label for="ans-text" class="qa-ans-label">Your answer <span class="qa-ans-note">(valid JSON)</span>:</label>
    <textarea id="ans-text" class="qa-ans-json" rows="5" spellcheck="false" autocomplete="off" data-input-action="task-answer-fit" placeholder='{\n  "key": "value"\n}'></textarea>
    <div id="json-parse-err" class="qa-json-err"></div>
    <div id="submit-result" role="status" aria-live="polite"></div>
    ${submitRow('json','Submit JSON')}`;
  // v8.9.0 — an any-answer challenge: every non-empty answer is accepted, and
  // stored exactly as typed. The label says so, the button is a plain Submit,
  // and submitAnswer skips the wrong-answer penalty modal for this mode.
  // Event team reports — a PICK-ONE question (`any` with options): radios, every
  // option accepted, submitted as the picked id with no penalty warning.
  if(t.answer_type==='any'&&t.pick_one&&Array.isArray(t.choices)&&t.choices.length>1){
    // Changing a Quick question's answer (operator ruling 395): the current pick
    // starts ticked, and Keep my answer goes back to the answered view.
    const mine=new Set(t._changing&&Array.isArray(t.my_choice_ids)?t.my_choice_ids:[]);
    return`
    <fieldset class="choice-fieldset">
      <legend class="qa-ans-label">${t._changing?'Change your answer':'Choose one'}${_isQualifying(t)?'':' <span class="qa-ans-note">(every answer is accepted)</span>'}</legend>
      ${t.choices.map((c,i)=>`<label class="choice-option">
        <input type="radio" name="ans-choice" class="ans-choice" value="${esc(c.id)}"${mine.has(c.id)?' checked':''}/>
        <i class="choice-key" aria-hidden="true">${String.fromCharCode(65+(i%26))}</i>
        <span>${esc(c.text)}</span>
      </label>`).join('')}
    </fieldset>
    <div id="submit-result" role="status" aria-live="polite"></div>
    ${t._changing
      ?`<div class="qa-submit-row"><button type="button" class="btn lg secondary qa-keep" data-action="task-keep-answer" data-task-id="${tid}">Keep my answer</button><button class="btn lg qa-submit" data-action="task-submit-answer" data-task-id="${tid}" data-mode="pickone">Submit Answer</button></div>`
      :submitRow('pickone','Submit Answer')}`;
  }
  if(t.answer_type==='any')return`
    <label for="ans-text" class="qa-ans-label">Your answer <span class="qa-ans-note">(any non-empty answer is accepted)</span>:</label>
    <input id="ans-text" class="qa-ans-input" placeholder="Type your answer here..." autocomplete="off" data-enter-action="task-submit-answer" data-task-id="${tid}" data-mode="any"/>
    <div id="submit-result" role="status" aria-live="polite"></div>
    ${submitRow('any','Submit Answer')}`;
  return`
    <label for="ans-text" class="qa-ans-label">Your answer:</label>
    <input id="ans-text" class="qa-ans-input" placeholder="Type your answer here..." autocomplete="off" spellcheck="false" data-enter-action="task-submit-answer" data-task-id="${tid}" data-mode="text"/>
    <p class="qa-ans-hint">Not case-sensitive. Press Enter to submit.</p>
    <div id="submit-result" role="status" aria-live="polite"></div>
    ${submitRow('text','Submit Answer')}`;
}

export const _submitInFlight = new Set();

function _markCorrectInCard(neutral){
  const card=document.querySelector('#task-detail-card.qa-card');
  if(!card)return;
  // A quick question or an Any answer (a pick-one included) has no right answer:
  // the pick is marked in a neutral colour, never .is-correct — what a later
  // view of it shows too (renderChoiceReview, `my_choice_ids`).
  if(neutral){
    card.querySelectorAll('.choice-option').forEach(l=>{if(l.querySelector('.ans-choice:checked'))l.classList.add('is-picked');});
    return;
  }
  card.classList.add('qa-solved-now');
  const tick='<svg class="qa-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  card.querySelectorAll('.choice-option').forEach(l=>{
    const on=!!l.querySelector('.ans-choice:checked');
    l.classList.add(on?'is-correct':'is-dim');
    if(on&&!l.querySelector('.qa-tick')){
      const m=document.createElement('span');m.className='qa-mark';setSafeHtml(m,tick+'<i class="qa-spark"></i>');l.appendChild(m);
    }
  });
  const inp=card.querySelector('#ans-text');
  if(inp)inp.classList.add('is-correct');
}

// audit v7.7.30 (M19) — after a wrong/error submit, focus fell to <body>
// (the in-flight guard disabled the focused submit button). Return focus to the
// answer input so a keyboard user can immediately retry; if there's no input
// (file answers), focus the now-announced result message.
// Focus that may be refused (a node detached mid-answer) reports whether it
// landed, so a caller can fall back to the next target instead of guessing.
function _focusQuietly(el,opts){
  if(!el)return false;
  try{el.focus(opts);return document.activeElement===el;}
  catch(e){return false;}
}
function _restoreSubmitFocus(){
  if(document.activeElement&&document.activeElement!==document.body)return;
  const inp=document.getElementById('ans-text')||document.getElementById('ans-file');
  if(_focusQuietly(inp))return;
  const res=document.getElementById('submit-result');
  if(res){res.setAttribute('tabindex','-1');_focusQuietly(res);}
}

// THE SOLVE, ANNOUNCED — one decision for every path that announces one. A
// quick question is thanked (no points, no "Correct"); an Any answer, a pick-one
// included, is "accepted" rather than "Correct", because there was no wrong
// answer to give; anything else is congratulated.
function _announceSolve(d,mode,title,pts){
  if(d.qualifying)return showThanks(title);
  return showCongrats(title,pts,d.score,{accepted:mode==='any'||mode==='pickone'});
}

// v8.13.0 — the booth tap card for THIS challenge, if that is what is on screen.
// openTask is the only writer of #task-detail-card and of _shownTaskId, so the
// pair says which challenge the tap card holds.
function _tapCardFor(taskId){
  const c=document.querySelector('#task-detail-card.mcf-card');
  return c&&_shownTaskId===taskId?c:null;
}

// v8.13.0 — `opts.choiceIds` lets a booth tap tile submit the option it IS,
// rather than whatever a checked radio says; everything after the answer is
// collected — the grading hash, the in-flight guard, the outcome ladder — is the
// same path the standard card takes. It RETURNS what happened, so the tile can
// tidy itself up afterwards (its own `finally` cannot: on a Cancel this function
// returns before reaching one):
//   cancelled | busy | invalid | wrong | deduped | locked | refused | stale
//   | error | correct | gone
export async function submitAnswer(taskId,type,opts){
  if(_submitInFlight.has(taskId))return 'busy';
  const tapCard=(type==='choice'||type==='pickone')?_tapCardFor(taskId):null;
  const body=new FormData();
  let picked=null;
  if(type==='file'){
    const file=document.getElementById('ans-file').files[0];
    if(!file){showToast('Please select a file.');return 'invalid';}
    body.append('file',file);
  }else if(type==='choice'||type==='pickone'){
    picked=(opts&&Array.isArray(opts.choiceIds))?opts.choiceIds.slice()
      :[...document.querySelectorAll('.ans-choice:checked')].map(el=>el.value);
    if(!picked.length){showToast('Please select an answer.');return 'invalid';}
    // IDs, not positions — the options are shuffled per participant, so a
    // position would mean nothing to the server.
    body.append('answer',JSON.stringify(picked));
  }else if(type==='json'){
    const raw=document.getElementById('ans-text').value.trim();
    const errEl=document.getElementById('json-parse-err');
    if(!raw){showToast('Please enter a JSON answer.');return 'invalid';}
    try{JSON.parse(raw);errEl.textContent='';}catch(e){errEl.textContent='Invalid JSON: '+e.message;return 'invalid';}
    body.append('answer',raw);
  }else if(type==='any'){
    // v8.9.0 — sent VERBATIM (no trim): the server stores and grades it as
    // typed. Only the emptiness check trims, mirroring the server's own refusal
    // of a whitespace-only answer.
    const raw=document.getElementById('ans-text').value;
    if(!raw.trim()){showToast('Please enter an answer.');return 'invalid';}
    body.append('answer',raw);
  }else{
    const ans=document.getElementById('ans-text').value.trim();
    if(!ans){showToast('Please enter an answer.');return 'invalid';}
    body.append('answer',ans);
  }
  // Echo the grading_hash captured at openTask() time so the server can
  // reject the submission with task_changed:true (no -5 penalty) if an
  // admin edited the correct_answer between fetch and this submit.
  const gh=_taskGradingHashes.get(taskId);
  if(gh) body.append('gradingHash', gh);
  // v8.9.0 — an any-answer challenge cannot be answered wrongly, so the penalty
  // warning would be a false claim; it is skipped for that mode alone.
  // A quick question (qualifying) scores nothing, so it has no penalty to warn
  // of either (the server takes none: lib/qualifying.js).
  if(type!=='any'&&type!=='pickone'&&!_isQualifying({id:taskId})){
    // v8.13.0 — on the booth tap card the confirm NAMES what was picked (a tap
    // is easier to land on the wrong tile than a radio is), arms 400 ms after it
    // opens so the second tap of a double tap cannot be the confirmation, and
    // repeats the last-attempt warning. Every other card keeps the dialog it had.
    const ok=await showModal((tapCard&&buildTapConfirm(tapCard,picked))||{
      title:'Submit Answer',
      message:'If your answer is incorrect, <strong style="color:var(--red)">5 points</strong> will be deducted from your score immediately.<br><br>This penalty is permanent — it applies even if you don\'t solve the challenge later.',
      confirmText:'Submit',
      confirmClass:'',
      cancelText:'Cancel'
    });
    if(!ok)return 'cancelled';
  }
  if(_submitInFlight.has(taskId))return 'busy';
  _submitInFlight.add(taskId);
  if(tapCard)setTapBusy(tapCard,true);
  // Disable any visible submit buttons for this task while the request is in
  // flight so the affordance matches the guard.
  const submitBtns=document.querySelectorAll(`[data-action="task-submit-answer"][data-task-id="${CSS.escape(taskId)}"]`);
  submitBtns.forEach(b=>{b.disabled=true;});
  const g=S._compGen;   // v8.12.6 — the answer's outcome belongs to ITS card
  let _outcome='error';
  try{
    const r=await fetch(`/api/tasks/${taskId}/submit`,{method:'POST',headers:{'x-csrf-token':S.csrfToken},body});
    // v8.11.11 — `await r.json()` THREW on any non-JSON body (a proxy's 502 page,
    // a 500 that never reached the handler), which fell to the catch below and
    // told the participant their answer "may or may not have reached us" about a
    // request the server had definitively refused. Parse defensively instead.
    const d=await r.json().catch(()=>({}));
    // v8.12.6 — THE PARTICIPANT LEFT THIS CHALLENGE WHILE IT WAS BEING GRADED (a
    // file upload on venue wi-fi is the realistic slow case). The outcome is real
    // and they must hear it, but #submit-result and the re-open below belong to
    // whatever is on screen NOW: this used to paint "Incorrect. −5 pts penalty"
    // into another challenge's card, re-open this one over it, or — on a correct
    // answer — clear the other challenge's telemetry id and navigate them off it.
    // So every outcome is reported where it cannot land on the wrong card, and
    // NAMES the challenge. Nothing here touches _openedTaskId: that belongs to
    // the challenge on screen (v7.27.0).
    //
    // Reopening the SAME challenge counts as still shown, and takes the ordinary
    // in-card path below unchanged.
    if(!_taskStillShown(taskId,g)){
      const _title=_taskTitle(taskId);
      _outcome='gone';
      if(!r.ok){
        const _why=(typeof d.error==='string'&&d.error.trim())?d.error
          :r.status===429?'you are submitting too quickly. Wait a moment and try again.'
          :'your answer could not be graded — the server refused the request. Nothing was scored; please try again.';
        showToast(`“${_title}”: ${_why}`,'error');
        // The list would otherwise go on offering the old input for it.
        if(d.task_changed&&document.querySelector('.page.active')?.id==='tasks-page')loadTasks();
      }else if(d.refused==='attempts_exhausted'){
        showToast(`No attempts left on “${_title}”. Ask an organiser if you need another try.`,'error');
      }else if(d.correct){
        refreshScore();
        // THE SOLVE DIALOG, NOT A TOAST. It names the challenge, so it is not the
        // wrong result on the wrong screen, and it keeps audit v7.7.33 (AL7): the
        // solve is announced by a focused dialog the participant dismisses, never
        // by a 4-second toast with no history. No clearOpenTask and no showMain —
        // they stay where they are — but a list already on screen is reloaded
        // after it, because loadTasks is never polled and would otherwise go on
        // showing this challenge as unsolved.
        const _t=S.allTasks.find(x=>x.id===taskId);
        _announceSolve(d,type,_t?_t.title:'',_t?taskPts(_t):'?').then(()=>{
          if(document.querySelector('.page.active')?.id==='tasks-page'&&S._compGen===g)loadTasks();
        });
      }else if(d.deduped){
        // v8.13.0 — a repeat of an answer sent seconds ago is folded into it by
        // the server and costs nothing; saying "−5 pts penalty" claimed a
        // deduction it did not take. v8.13.1 — the FIRST copy was charged, and
        // its lost response is what would have refreshed the score.
        refreshScore();
        showToast(`Your answer to “${_title}” was already submitted a moment ago and was not correct — it wasn't counted twice.${d.attempts_left===0?' That was your last attempt.':''}`);
      }else{
        refreshScore();
        showToast(`Incorrect answer on “${_title}”.${_penaltyNote(taskId,d)}${d.attempts_left===0?' That was your last attempt.':''}`,'error');
      }
      return _outcome;
    }
    const el=document.getElementById('submit-result');
    if(!r.ok){
      // v8.11.11 — `.result-msg wrong` is the class that means YOUR ANSWER WAS
      // INCORRECT: red, and the only other thing that paints it says "−5 pts
      // penalty". Every non-2xx wore it, so a 429 (too fast), a 409 (the admin
      // edited the challenge under you) and a 500 all read as a graded wrong
      // answer with a penalty — on the one screen where a participant is counting
      // their remaining attempts. None of those was graded and none cost a point.
      // `.notice` is the third tone, and the fallback is what stops a 500 with no
      // `error` key rendering an EMPTY red panel — the shape of the bug reported
      // as "it just flashes red and says nothing".
      const msg=(typeof d.error==='string'&&d.error.trim())?d.error
        :r.status===429?'You are submitting too quickly. Wait a moment and try again.'
        :'Your answer could not be graded — the server refused the request. Nothing was scored; please try again.';
      // v8.13.0 — ON THE TAP CARD, A CHANGED CHALLENGE IS RE-OPENED. Its options
      // carry ids, and an admin edit can replace them: leaving the old tiles up
      // with the old grading token refuses every later tap the same way. The
      // re-open fetches a fresh token and the current options, and the toast
      // outlives the card it replaces. The standard card keeps its message in
      // place, where the participant's typed answer is still worth keeping.
      if(tapCard&&d.task_changed){
        showToast('This challenge was just updated — showing the latest version.');
        openTask(taskId);
        return _outcome='stale';
      }
      setSafeHtml(el, `<div class="result-msg notice">${esc(msg)}</div>`);
      if(!tapCard)_restoreSubmitFocus();  // audit v7.7.30 (M19) — disabling the button dropped focus to <body>
      // Server flagged a task-shape mismatch (admin changed answer_type); refresh
      // the task list so the user sees the new input UI on the next click.
      if(d.task_changed)loadTasks();
      return _outcome='error';
    }
    const task=S.allTasks.find(t=>t.id===taskId);
    const pts=task?taskPts(task):'?';
    // v8.1.0 — THE `refused` BRANCH MUST BE TESTED BEFORE `!d.correct`, and this
    // is the single most dangerous line in the attempt-cap client.
    //
    // The refusal is a 200 (a non-429 4xx would feed the scanner-reputation
    // counter and can ban a whole venue), so without this it falls into the
    // branch below and renders "Incorrect. −5 pts penalty." — announcing a
    // penalty that was NOT taken, on a submission the server never stored.
    if(d.refused==='attempts_exhausted'){
      // A TOAST, not `#submit-result`. The re-render below replaces the whole
      // card — including that element — so a message written into it would flash
      // and vanish, which is worse than saying nothing. The toast carries the
      // outcome and the locked panel carries the state.
      showToast('No attempts left on this challenge. Ask an organiser if you need another try.','error');
      // Re-fetch rather than patching in place: the server owns the count, an
      // admin may have granted more while this request was in flight, and the
      // locked panel has to come from the same answer everything else renders
      // from.
      openTask(taskId);
      return _outcome='refused';
    }
    // v8.13.0 — A REPEAT IS NOT A WRONG ANSWER. The server folds an identical
    // answer sent within three seconds into the first (no row, no penalty —
    // `pointsDelta: 0, deduped: true`), and this used to fall into the branch
    // below and announce "Incorrect. −5 pts penalty." for a deduction never
    // taken. `.notice`, the tone that means nothing was graded. A deduped
    // CORRECT answer is a Quick question's unchanged pick (ruling 395: nothing
    // stored, `qualifying` set) and takes the ordinary path: it is their answer.
    //
    // v8.13.1 (external audit) — AND IT CARRIES THE ATTEMPT STANDING. The repeat
    // that gets folded is usually a retry after the first response was lost, so
    // the count on the card is from before that first answer — "2 left" when 1
    // is, with no last-attempt warning on the next confirm. The card takes the
    // server's count; if the lost answer was the last one, the card locks exactly
    // as it does after any last wrong answer. "Was not correct" is the first
    // submission's own grade, which the server returns verbatim (the only correct
    // one folded is a Quick question's unchanged pick, above).
    if(d.deduped&&!d.correct){
      const left=d.attempts_left;
      if(left===0){
        showToast('That answer was already submitted a moment ago and was not correct. It was your last attempt, so this challenge is now locked.','error');
        refreshScore();
        openTask(taskId);
        return _outcome='locked';
      }
      const leftMsg=Number.isInteger(left)?` ${left} attempt${left===1?'':'s'} left.`:'';
      setSafeHtml(el,`<div class="result-msg notice">That answer was already submitted a moment ago and was not correct — it wasn't counted twice.${esc(leftMsg)}</div>`);
      if(tapCard)updateTapAttempts(tapCard,left,d.attempts_cap);
      else _syncStandardAttempts(left,d.attempts_cap,d.attempts);
      // The folded answer's FIRST copy was graded and charged, and its response
      // is the one that was lost — so the score pill is from before the −5 too.
      refreshScore();
      if(!tapCard)_restoreSubmitFocus();
      return _outcome='deduped';
    }
    if(!d.correct){
      // v8.1.0 — say how many are left, and re-open the view on the last one so
      // the input is replaced by the locked panel rather than staying live for a
      // click that can only be refused.
      const left = d.attempts_left;
      const leftMsg = Number.isInteger(left)
        ? (left === 0 ? ' No attempts left.' : ` ${left} attempt${left === 1 ? '' : 's'} left.`)
        : '';
      if(left === 0){
        // Same reason as the refusal above: the card is about to be replaced by
        // the locked panel, so the outcome goes to a toast that outlives it.
        showToast(`Incorrect.${_penaltyNote(taskId,d)} That was your last attempt.`,'error');
        refreshScore();
        openTask(taskId);
        return _outcome='locked';
      }
      // v8.13.0 — a full stop after the score: "Score: -5 2 attempts left." ran
      // two numbers together.
      setSafeHtml(el, `<div class="result-msg wrong">Incorrect.${esc(_penaltyNote(taskId,d))} Score: ${esc(String(d.score))}.${esc(leftMsg)}</div>`);
      if(tapCard)updateTapAttempts(tapCard,left,d.attempts_cap);
      else _syncStandardAttempts(left,d.attempts_cap,d.attempts);
      refreshScore();
      // On the tap card the TILE takes focus back (tapChoice), so a keyboard user
      // lands on the option they just tried rather than on the message.
      if(!tapCard)_restoreSubmitFocus();  // audit v7.7.30 (M19) — return focus to the answer field, not <body>
      return _outcome='wrong';
    }
    refreshScore();
    // v7.27.0 — SOLVING IS NOT LEAVING. The trailing showMain('tasks-page') below
    // reaches nav.js's departure hook, and `_openedTaskId` is still set at that
    // point (fireNavigatedAway is its only other writer), so every solve used to
    // record a navigated_away for the challenge it had just solved — measured at
    // ~285 ms after the `solved` row, same user, same task.
    //
    // Cleared HERE, before the congrats dialog rather than after, so the rule
    // holds however the participant leaves during it (Escape, a tab switch, or
    // closing the tab mid-celebration) — every one of those paths would
    // otherwise still fire. The server refuses a solved challenge independently
    // (routes/participant.js); this is what stops the pointless request.
    clearOpenTask();
    _outcome='correct';
    // THE ANSWER LIGHTS UP FIRST: the chosen tile (or the typed answer) turns to
    // the correct state and draws its tick, the other options step back with a
    // dashed edge (never opacity), and the play bar's score bumps — then the
    // dialog. The pause is the length of the tick's draw and is skipped when the
    // participant asked for reduced motion; the card is this challenge's (the
    // still-shown check above), and the dialog follows either way.
    _markCorrectInCard(!!d.qualifying||type==='any'||type==='pickone');
    if(!tapCard&&task&&el){setSafeHtml(el,solvedPanelHtml(task,{fresh:true}));el.classList.add('qa-result-ok');}
    _paintPlayScore(d.score);
    if(!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches))
      await new Promise(res=>setTimeout(res,520));
    await _announceSolve(d,type,task?.title||'',pts);
    // THE PAUSE PUTS NOTHING OVER THE PAGE, so the participant may have left this
    // challenge during it (Events, the board). The dialog above still names the
    // solve, but nobody is dragged back: they go to the list only from this
    // challenge's card, and a list already on screen is just reloaded — the
    // off-card path above, decided after the wait rather than before it. Asked
    // after the dialog, which is modal, so it covers both.
    if(_taskStillShown(taskId,g)){
      loadTasks();
      showMain('tasks-page');
    }else if(S._compGen===g&&document.querySelector('.page.active')?.id==='tasks-page'){
      loadTasks();
    }
    return _outcome;
  }catch(err){
    // v8.1.0 (PR 32) — A THROWN SUBMIT USED TO SAY NOTHING AT ALL.
    //
    // This block was `try { … } finally { … }` with no catch, so a `fetch` that
    // rejects (venue wi-fi drops mid-answer, which is the ordinary case this
    // platform is built for) or a `r.json()` that throws on a proxy's HTML error
    // page escaped as an unhandled rejection. The `finally` re-enabled the
    // button, so the participant was left looking at their own answer, a live
    // Submit button and no message — unable to tell whether it had been sent.
    //
    // THE COPY MUST NOT CLAIM EITHER OUTCOME. We genuinely do not know: the
    // request may have reached the server and been graded, or never left. Saying
    // "not submitted" would be a guess, and on a capped challenge a wrong guess
    // costs the participant an attempt they think they still have.
    //
    // The view is deliberately NOT re-rendered. Re-opening would replace the card
    // and discard the answer they just typed, on the one path where they will
    // want to press Submit again — and if the network really is down, the
    // re-fetch fails too and they lose the text for nothing.
    // v8.12.6 — the in-card message and the focus return belong to this
    // challenge's card; once the participant has left it, "your answer is still
    // here" is false and the card on screen is somebody else's.
    const _here=_taskStillShown(taskId,g);
    const el=_here?document.getElementById('submit-result'):null;
    // v8.11.11 — not a wrong answer either: nothing was graded and no penalty was
    // taken, so this must not wear the class that says one was.
    if(el)setSafeHtml(el,'<div class="result-msg notice">Your answer could not be sent — check your connection. It may or may not have reached us, so reopen the challenge before trying again.</div>');
    showToast(_here?'Could not send your answer. Your answer is still here — check your connection and try again.'
      :`Could not send your answer to “${_taskTitle(taskId)}” — check your connection, then reopen that challenge before trying again.`,'error');
    if(_here&&!tapCard)_restoreSubmitFocus();
    return _outcome='error';
  }finally{
    _submitInFlight.delete(taskId);
    submitBtns.forEach(b=>{b.disabled=false;});
    if(tapCard){
      // The card element is static and reused by every open, so an answer that
      // lands after the participant moved on to ANOTHER challenge must not clear
      // that challenge's busy marks while its own answer is still in flight.
      if(_tapCardFor(taskId)===tapCard)setTapBusy(tapCard,false);
      refitTapCardIfPending();
      // A multiple-answer tap card has one Submit button, disabled while the
      // answer was in flight — so focus fell to <body>. Hand it back.
      if(tapCard.isConnected&&tapCard.dataset.mcfMode==='multi'&&_taskStillShown(taskId,g)
        &&(!document.activeElement||document.activeElement===document.body)){
        _focusQuietly(tapCard.querySelector('.mcf-submit'),{preventScroll:true});
      }
    }
  }
}

// v8.13.0 — ONE TAP ON A BOOTH TILE. It opens the same penalty confirm the
// standard Submit button does, naming the option, and nothing is sent until the
// participant confirms. `_tapPending` holds a second tile tap (or the second tap
// of a double tap) while the confirm is coming up; submitAnswer's own in-flight
// guard covers the request. It is PER CHALLENGE: it stays set until the answer's
// response arrives, and a participant who leaves a challenge while its answer is
// in flight (venue wi-fi) must be able to answer the next one meanwhile — a
// single flag silently swallowed every tap on it.
const _tapPending=new Set();
export async function tapChoice(el){
  if(!el)return;
  const taskId=el.dataset.taskId, choiceId=el.dataset.choiceId;
  if(!taskId||!choiceId)return;
  if(_tapPending.has(taskId)||el.getAttribute('aria-disabled')==='true'||_submitInFlight.has(taskId))return;
  const g=S._compGen;
  if(!_taskStillShown(taskId,g))return;
  _tapPending.add(taskId);
  markChosen(el,true);
  let outcome='error';
  try{
    outcome=await submitAnswer(taskId,el.dataset.mode==='pickone'?'pickone':'choice',{choiceIds:[choiceId]});
  }finally{
    _tapPending.delete(taskId);
    // The card may have been replaced (a re-open after a last wrong answer, a
    // changed challenge) or left (a solve); only THIS card's tile is touched.
    if(el.isConnected&&_taskStillShown(taskId,g)){
      if(outcome==='wrong'||outcome==='deduped')markTried(el);
      else markChosen(el,false);
      // iOS does not focus a tapped button, so the confirm's focus return lands
      // on <body>. Never while a dialog is up: it would pull focus out of it.
      if(!document.getElementById('modal-overlay')?.classList.contains('open')){
        _focusQuietly(el,{preventScroll:true});
      }
    }
  }
}

// v8.13.0 — a checkbox tile on a multiple-answer booth question was toggled.
export function tapChoiceToggled(el){
  syncTapMulti(el&&el.closest('#task-detail-card'));
}
