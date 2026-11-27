"use strict";

import { S } from "../core/state.js";
import { _origFetch, csrfHeaders, readyToWrite, trackInflightWrite, markSignedOutHere, clearSignedOutMark, signedOutInAnotherTab } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { fireNavigatedAway } from "./participant-tasks.js";
import { startAdminAlertPoll, stopAdminAlertPoll } from "./admin-alerts.js";
import { stopAdminLogsAutoRefresh } from "./settings-admin.js";
import { esc, fmtDt } from "../ui/format.js";
import { ICO } from "../ui/icons.js";
import { installOverlayFocusTrap, showModal } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";
import { setEventLook } from "../ui/theme.js";

// Each stop runs on its own, so one failing step never leaves the rest running.
function _stopStep(name, fn){
  try{ fn(); }catch(e){ console.warn('Could not stop '+name, e); }
}
function _clearHandle(key){
  _stopStep(key, ()=>{ if(S[key]){clearInterval(S[key]);S[key]=null;} });
}
// Every caller is a sign-out or a tab told to reload: the session this tab
// showed has ended (an idle expiry, a restart, a sign-out elsewhere, another
// tab's session), so the halt is for the rest of the document. A poll that a
// reply already on its way would re-arm, the tab's return from the background
// and every poll starter ask S._pollsHalted, and the fetch interceptor sends
// nothing more: each request would be refused, and a room of signed-out
// browsers behind one address would get that address blocked as a scanner.
export function _stopAllPolls(){
  S._pollsHalted=true;
  S._pausedIntervals=[];
  _clearHandle('_statusRetryTimer');
  // The browser's other tabs share this session: tell them (core/api.js asks
  // the session check before their next request instead of a refused poll).
  _stopStep('tell other tabs', ()=>{ localStorage.setItem('ha:session-ended', String(Date.now())); });
  _stopStep('session monitor', ()=>{ if(typeof stopSessionMonitor==='function')stopSessionMonitor(); });
  _stopStep('logs auto-refresh', ()=>{ if(typeof stopAdminLogsAutoRefresh==='function')stopAdminLogsAutoRefresh(); });
  _clearHandle('timerInterval');
  _clearHandle('statusPollInterval');
  _clearHandle('lbInterval');
  _clearHandle('compDataPollInterval');
  _clearHandle('adminCompPollInterval');
  _clearHandle('scopeBannerInterval');
  // v7.2.x (audit) — the verify-chip ticker (nav.js) survived the forced sign-out
  // it can itself trigger; clear its handle here too (direct, no import/cycle).
  _clearHandle('_verifyTicker');
}

export const _sessionMon={
  serverStartedAt:null,
  lastActivityAt:Date.now(),
  pollHandle:null,
  expiresAt:null,
  warningShown:false,
  endedShown:false,
  countdownHandle:null,
  pollIntervalMs:30_000,   // check every 30s
  activityWindowMs:60_000, // keepalive if user was active in the last 60s
  warnThresholdMs:5*60_000, // show warning popup 5min before expiry
  keepaliveSkipAboveMs:55*60_000, // no keepalive while more than this remains (of the 60 min)
  hiddenCheckMs:120_000,    // a hidden tab asks /api/session/status at most this often
  lastAskedAt:0,
};

export function startSessionMonitor(){
  if(_sessionMon.pollHandle||S._pollsHalted)return;
  _sessionMon.pollHandle=setInterval(_sessionMonTick,_sessionMon.pollIntervalMs);
  _sessionMonTick();
  // v7.16.0 — the operator IP-ban alert poll shares this lifecycle: every
  // authenticated entry starts it, every sign-out stops it. It is hung here
  // rather than off the admin-view transitions because those live in nav.js /
  // auth.js; its own tick decides whether this session is currently an admin
  // in the admin view and skips otherwise, so a participant issues no request.
  startAdminAlertPoll();
}

export function stopSessionMonitor(){
  if(_sessionMon.pollHandle)clearInterval(_sessionMon.pollHandle);
  _sessionMon.pollHandle=null;
  stopAdminAlertPoll();
  if(_sessionMon.countdownHandle)clearInterval(_sessionMon.countdownHandle);
  _sessionMon.countdownHandle=null;
  _sessionMon.warningShown=false;
  _sessionMon.endedShown=false;
  // batch 4: was a raw `…warn-overlay')?.remove()` that tore down the overlay but
  // left warnOpenerEl dangling (a stale DOM ref) and restored no focus on a forced
  // / session-expiry teardown. Route through _closeSessionWarning so the opener
  // focus is restored and the ref cleared — same as a normal close.
  _closeSessionWarning();
}

/**
 * Why was this session ended? THE single decision point (v7.15.4).
 *
 * Two independent code paths discover a dead session — this poll, and the fetch
 * interceptor in core/api.js when any OTHER request 401s — and they MUST reach
 * the same verdict. They did not: the interceptor already fetched
 * /api/session/status (for `kicked_by`) but never compared `server_started_at`,
 * so it always reported "inactivity".
 *
 * That made restart detection almost dead in practice. After a restart the
 * regenerated SESSION_SECRET invalidates the cookie, so EVERY request 401s, and
 * the SPA's other polls are faster than this 30 s one (leaderboard 15 s, admin
 * lists 15 s). Whichever fired first hit the interceptor, which announced
 * "signed out due to inactivity" and set S._sessionExpiredHandled — so this
 * tick's correct check never ran. A user who had just been working was told
 * they had been idle.
 *
 * `d` is the parsed /api/session/status body (null/undefined when that probe
 * itself failed). `httpError` is the `error` field of the response that
 * triggered this, when the caller knows it.
 *
 * "inactivity" is the only verdict that makes a positive, unfalsifiable claim
 * about the user, so it is the LAST resort — anything we cannot actually
 * establish returns `unknown` and gets neutral copy. Announcing "you were idle"
 * to someone who was working is the whole bug being fixed here; guessing it
 * again from a failed probe would just relocate the bug.
 */
export function _classifySignout(d,httpError){
  // Probe failed (network error, 502 from a still-warming upstream mid-deploy,
  // maintenance 503, non-JSON body). Claim nothing — unless this browser signed
  // this very session out in another tab (below), which needs no probe.
  if(!d)return signedOutInAnotherTab()?{kind:'signed_out_other_tab'}:{kind:'unknown'};
  // A cause the SERVER recorded comes first: a signed-out session is destroyed,
  // so it can never be kicked or reset afterwards — a reason proves any sign-out
  // note naming it is stale. (A restart empties the server's record of them, so
  // the restart test below loses nothing by coming after.) A purge that recorded
  // WHY: a sign-in elsewhere, or any other reason — `ended`
  // (an organiser's act, a password change, a role change), which names no cause
  // on purpose, or one this client does not know — gets the neutral copy. None
  // is idleness, and saying so to somebody who was working is the bug.
  if(d.active!==true&&d.reason==='kicked'&&d.kicked_by)return {kind:'kicked',kickedBy:d.kicked_by};
  if(d.active!==true&&d.reason)return {kind:'unknown'};
  // This browser signed this very session out, in another tab: the note
  // carries the fingerprint of the token the session issued, which is this
  // tab's own (core/api.js `markSignedOutHere`; withdrawn when that sign-out's
  // request failed, or once a token is issued for the session again).
  if(d.active!==true&&signedOutInAnotherTab())return {kind:'signed_out_other_tab'};
  // A restart only ENDS a session if the session is in fact dead. The
  // regenerated secret invalidates pre-restart cookies, so a genuine
  // restart-signout always reports active:false. active===true with a NEW
  // timestamp means the opposite — the user signed in AFTER the restart (a tab
  // left on the login page keeps the pre-restart snapshot), and telling them
  // "your session is no longer valid" would throw them out of a session created
  // seconds earlier.
  if(d.active!==true&&_sessionMon.serverStartedAt&&d.server_started_at&&d.server_started_at!==_sessionMon.serverStartedAt){
    return {kind:'restart'};
  }
  // The 48h verification grace lapsing is NOT idleness, and "sign in again"
  // would fail with email_verification_required — say what actually happened.
  if(httpError==='Account is not verified')return {kind:'unverified'};
  // csrf_invalid is a stale token, not idleness: the refusal itself ended the
  // session (every session carrying an identity since v8.13.4 — the built-in
  // superadmin's survived it before, so for that account "Signed out" was false
  // and the reload put it back in the admin panel), and a cause we can name
  // only vaguely gets the neutral copy. An active:true body likewise
  // contradicts an expiry claim.
  if(httpError==='csrf_invalid'||d.active===true)return {kind:'unknown'};
  // No baseline snapshot (e.g. /api/config failed or was rate-limited at boot)
  // means a restart is indistinguishable from an expiry — don't assert idleness.
  if(!_sessionMon.serverStartedAt)return {kind:'unknown'};
  return {kind:'inactivity'};
}

/**
 * Act on a verdict: show the matching popup (each navigates to / itself).
 * Idempotent — two 401s landing in the same event-loop batch both clear the
 * interceptor's guard (it is set after an `await`), and a second showModal
 * settles the first as Cancel, which would resolve the incumbent popup's await
 * and fire its `location.href='/'` immediately: the dialog would flash and
 * vanish before it could be read. `S._signoutAnnounced` is deliberately NOT the
 * `_sessionMon.endedShown` flag, which `stopSessionMonitor()` resets.
 */
export async function _announceSignout(verdict,httpError){
  if(S._signoutAnnounced)return;
  S._signoutAnnounced=true;
  const kind=verdict&&verdict.kind;
  if(kind==='restart')return _showServerRestartPopup();
  if(kind==='kicked')return _showSessionExpiredPopup(verdict.kickedBy);
  if(kind==='unverified'){
    return _showPlainSignoutPopup('Verification required',
      'Your account is not verified, so your session was ended. Check your inbox for the verification email — you will need to verify before signing in again.');
  }
  if(kind==='signed_out_other_tab'){
    return _showPlainSignoutPopup('Signed out','You signed out in another tab of this browser. Sign in again to continue.');
  }
  if(kind==='unknown'){
    return _showPlainSignoutPopup('Signed out','You were signed out. Please sign in again to continue.');
  }
  return _showSessionExpiredPopup(null);
}

/** Neutral sign-out dialog for causes we cannot positively identify. */
export async function _showPlainSignoutPopup(title,message){
  _sessionMon.endedShown=true;
  _forgetEventLook();
  await showModal({title,message,confirmText:'OK',confirmClass:'',cancelText:null});
  location.href='/';
}

export async function _sessionMonTick(){
  let d;
  // A FRESH PULSE ANSWERS FOR THE SESSION. While a participant is in an
  // event the pulse (GET /api/participant/pulse) carries the live session's half
  // of /api/session/status, so asking again every 30 s was a second request per
  // tab saying the same thing. A dead session never reaches here through the
  // pulse: it 401s and goes through the interceptor's one sign-out classifier,
  // and once pulses stop the next tick asks /api/session/status as before.
  //
  // A HIDDEN tab backs off: it asks at most every HIDDEN_CHECK_MS (the warning
  // is shown five minutes ahead, the keepalive throttle below keeps a live
  // event's session alive), and the tab's return asks at once.
  const nowTick=Date.now();
  const pulse=S._lastPulse;
  if(pulse&&pulse.session&&pulse.session.active===true&&(nowTick-pulse.at)<_sessionMon.pollIntervalMs){
    d=pulse.session;
  }else{
    if(document.hidden&&(nowTick-(_sessionMon.lastAskedAt||0))<_sessionMon.hiddenCheckMs)return;
    _sessionMon.lastAskedAt=nowTick;
    try{
      const r=await fetch('/api/session/status');
      // An error answer (maintenance's 503, a scanner block's 429) says nothing
      // about the session — read as a dead one, it announced "inactivity" to
      // people whose sessions were untouched. Treated like the network error.
      if(!r.ok)return;
      d=await r.json();
    }catch(e){return;/* transient network error; try again next tick */}
  }
  // Server restart detection: startup timestamp drift.
  // Mirror the !d.active branch below — stop EVERY poll and disarm the fetch
  // interceptor. Stopping only this monitor left the 15 s polls running, and the
  // next one to 401 re-entered the interceptor (its guard was still false) and
  // opened a second modal, which settles this one as Cancel and fires its
  // location.href immediately: the correct message would flash and vanish.
  if(_classifySignout(d).kind==='restart'){
    stopSessionMonitor();
    _stopAllPolls();
    S._sessionExpiredHandled=true;
    _announceSignout({kind:'restart'});
    return;
  }
  if(d.server_started_at)_sessionMon.serverStartedAt=d.server_started_at;
  // Server says we're no longer authenticated → inactivity OR kicked.
  // v6.16.24: when reason==="kicked" the response carries `kicked_by`
  // with the new login's IP / first/last/email so the popup can name
  // who took over the session.
  if(!d.active){
    stopSessionMonitor();
    _stopAllPolls();
    if(!_sessionMon.endedShown)_announceSignout(_classifySignout(d));
    return;
  }
  // Detect role transitions while the session is alive (admin promotion or
  // demotion by another superadmin). Without this the nav still reflects the
  // role from when the user originally logged in. Force a hard reload so every
  // cached UI flag (isAdmin / isSuperAdmin / isStaff) re-derives from /api/me.
  if(d.role && _sessionMon.lastRole && d.role !== _sessionMon.lastRole){
    showToast('Your access level changed. Reloading…','success');
    setTimeout(()=>location.reload(),1200);
    return;
  }
  if(d.role)_sessionMon.lastRole=d.role;
  _sessionMon.expiresAt=d.expires_at?new Date(d.expires_at):null;
  const nowMs=Date.now();
  const msUntilExpiry=_sessionMon.expiresAt?_sessionMon.expiresAt.getTime()-nowMs:null;
  // The shared session was extended elsewhere (another tab's writes slide it):
  // a warning already open here no longer applies, whichever branch runs below.
  // The keepalive skip returns before its own close, so this is the one place
  // that sees it for both an active and an idle tab.
  if(_sessionMon.warningShown&&msUntilExpiry!==null&&msUntilExpiry>_sessionMon.warnThresholdMs)_closeSessionWarning();
  const wasRecentlyActive=(nowMs-_sessionMon.lastActivityAt)<_sessionMon.activityWindowMs;
  // v7.2.x (CTF-0026, fix A) — treat "in a live competition" as activity, so a
  // participant whose Arena tab is backgrounded (working in their IDE) keeps
  // their session alive instead of expiring mid-competition. Self-bounding
  // (best-effort): the hackathonEndTime guard stops keepalive once the
  // SCHEDULED slot-end time passes. Caveat: if the competition is ended EARLY
  // (admin end-now / auto-end) while the tab is hidden, the /api/status poll
  // that refreshes hackathonEndTime + clears _inLiveCompetition is paused (see
  // the visibilitychange handler in main.js), so keepalive can persist past the
  // early end — but only up to the originally-scheduled slot duration. Not a
  // privilege/leak issue: keepalive only slides session EXPIRY and still
  // re-checks the full account lifecycle server-side (requireParticipant +
  // the keepalive route), and competition end is independent of session life.
  const inLiveCompetition=!!S._inLiveCompetition && !S.hackathonEnded
    && !!S.hackathonEndTime && new Date(S.hackathonEndTime).getTime()>nowMs;
  if(wasRecentlyActive||inLiveCompetition){
    // SLIDE ONLY WHEN IT BUYS SOMETHING. A keepalive every 30 s was a
    // session-row write per tab per tick (6000 writes a minute at 3000 tabs) to
    // move an expiry an hour away by thirty seconds. Skipping while more than
    // keepaliveSkipAboveMs remains keeps both arms of the gate (an active user and
    // a live event still slide) and caps the loss to that margin: an active user
    // who then goes idle is signed out at most five minutes early, and the
    // warning still opens before that.
    if(msUntilExpiry!==null&&msUntilExpiry>_sessionMon.keepaliveSkipAboveMs)return;
    // Extend session via keepalive. Closes an open warning popup if any.
    try{
      const r=await fetch('/api/session/keepalive',{method:'POST',headers:csrfHeaders()});
      if(r.ok){
        const d2=await r.json();
        if(d2.expires_at)_sessionMon.expiresAt=new Date(d2.expires_at);
        _closeSessionWarning();
      }
    }catch(_){/* ignore */}
    return;
  }
  // User idle — warn if within threshold and popup not already shown
  if(msUntilExpiry!==null&&msUntilExpiry<=_sessionMon.warnThresholdMs&&msUntilExpiry>0&&!_sessionMon.warningShown){
    _showSessionWarning();
  }
}

export function _showSessionWarning(){
  if(_sessionMon.warningShown)return;
  _sessionMon.warningShown=true;
  const overlay=document.createElement('div');
  overlay.id='session-warn-overlay';
  overlay.style.cssText='position:fixed;inset:0;background:var(--overlay);z-index:9200;display:flex;align-items:center;justify-content:center;padding:24px';
  setSafeHtml(overlay, `<div class="card" role="dialog" aria-modal="true" aria-labelledby="session-warn-title" style="max-width:min(420px, calc(100vw - 32px));width:100%;border-top:2px solid var(--yellow);box-shadow:var(--shadow-3)">
    <h3 id="session-warn-title" style="margin-bottom:8px;color:var(--yellow)">${ICO.alertTriangle} Session expiring soon</h3>
    <p style="margin-bottom:16px;color:var(--muted);font-size:var(--fs-14)">You'll be signed out in <strong id="session-warn-countdown">—</strong> due to inactivity.</p>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button class="btn sm secondary" data-action="session-warn-logout">Logout now</button>
      <button class="btn sm warning" data-action="session-warn-stay">Stay logged in</button>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  // v6.20.x — dialog ARIA + focus trap (was a bare interactive overlay outside
  // the modal contract). No Escape wiring: dismissal here is an explicit choice
  // (Logout now / Stay), not a generic cancel. Trap auto-releases on removal.
  // batch 3 (F4): snapshot the opener BEFORE the trap moves focus in, so
  // _closeSessionWarning can restore focus there (this overlay uses
  // installOverlayFocusTrap directly, not overlayDismiss, so it doesn't get the
  // systemic restore for free).
  _sessionMon.warnOpenerEl=(document.activeElement&&document.activeElement!==document.body)?document.activeElement:null;
  installOverlayFocusTrap(overlay);
  setTimeout(()=>{overlay.querySelector('button[data-action="session-warn-stay"]')?.focus();},0);
  _sessionMon.countdownHandle=setInterval(_sessionMonRenderCountdown,1000);
  _sessionMonRenderCountdown();
}

export function _sessionMonRenderCountdown(){
  const el=document.getElementById('session-warn-countdown');
  if(!el)return;
  if(!_sessionMon.expiresAt){el.textContent='—';return;}
  const ms=_sessionMon.expiresAt.getTime()-Date.now();
  if(ms<=0){
    el.textContent='0:00';
    // Countdown ended; close the popup — the next poll within 30s will show "session expired"
    _closeSessionWarning();
    return;
  }
  const total=Math.ceil(ms/1000);
  const m=Math.floor(total/60),s=total%60;
  el.textContent=`${m}:${String(s).padStart(2,'0')}`;
}

export function _closeSessionWarning(){
  document.getElementById('session-warn-overlay')?.remove();
  if(_sessionMon.countdownHandle)clearInterval(_sessionMon.countdownHandle);
  _sessionMon.countdownHandle=null;
  _sessionMon.warningShown=false;
  // batch 3 (F4): restore focus to the control that had it before the warning.
  const _op=_sessionMon.warnOpenerEl;_sessionMon.warnOpenerEl=null;
  if(_op&&typeof _op.focus==='function'){try{_op.focus();}catch(_){/* no-op */}}
}

export async function _sessionWarnStayLoggedIn(){
  // Count this as activity so the keepalive call actually fires AND the user won't re-show warning immediately.
  _sessionMon.lastActivityAt=Date.now();
  try{
    const r=await fetch('/api/session/keepalive',{method:'POST',headers:csrfHeaders()});
    if(r.ok){
      const d=await r.json();
      if(d.expires_at)_sessionMon.expiresAt=new Date(d.expires_at);
    }
  }catch(_){/* ignore */}
  _closeSessionWarning();
}

export async function _sessionWarnLogoutNow(){
  _closeSessionWarning();
  if(!(await signOutThisBrowser()))return;
  location.href='/';
}

/**
 * THE USER'S OWN SIGN-OUT — one definition for both doors (the header's Sign
 * out, `doLogout`; the expiry warning's Logout now). Resolves false, having
 * done nothing, when the tab is out of date.
 *
 *  - The token is re-synced first, and again immediately before the POST
 *    (`readyToWrite`): a token another tab's session replaced would be
 *    refused, and the refusal, not this sign-out, would end the session. A
 *    tab that turns out to be out of date signs nothing out (it has said why,
 *    and Reload shows whose session is open); nor does one whose re-sync
 *    could not finish, and it says so.
 *  - The marker is left BEFORE the POST, so another tab whose poll lands
 *    between the server ending the session and this tab's next step still
 *    reads it (`markSignedOutHere`), and withdrawn only if the session is
 *    seen alive afterwards (`clearSignedOutMark`).
 *  - Single-flight: a double click is one sign-out.
 *  - `_origFetch`, so the interceptor does not answer an explicit sign-out with
 *    a "signed out" popup of its own; `S._sessionExpiredHandled` disarms any
 *    poll racing it; the open challenge's navigated-away row lands first, while
 *    the session is still valid.
 */
// THE SIGNED-IN HEADER, RESERVED FROM FIRST PAINT (see ui/nav.js
// dropAppShellHint). `ha_shell` says what this browser was last showing: `1`
// the signed-in header with the participant bar under it, `3` the same with the
// bar's lock note on its own line (a phone), `2` the signed-in header alone (the
// admin console). A participant's code sign-in sets `1` (lib/sessions.js
// setAppShellHintCookie, so a sign-in made outside the SPA counts too), the
// participant bar sets `1` or `3` (updateParticipantNav), the admin console `2`;
// the signed-out header (showPage), a boot that finds nobody signed in, a
// sign-out and a session this tab sees end clear it. It carries no identity and
// grants nothing. A stale one (a session that ended while the browser was away)
// costs the sign-in screen its own header layout until boot's session check
// answers, then clears. No
// Expires: it lasts the browser session.
// AN EVENT'S LOOK ENDS WITH THE SESSION. It is kept per tab (sessionStorage
// `hck-event-look`, ui/theme.js setEventLook) so a reload inside the event
// paints it first; every way a session ends here (sign-out, a kick, expiry, a
// restart) takes it off before the page goes back to the sign-in screen, or
// the next visitor at a shared booth tablet meets the last event's look. Boot
// takes it off too for a page that loads signed out (core/main.js).
function _forgetEventLook(){ try{ setEventLook(null); }catch(_){ /* the look stays: cosmetic */ } }

// `mode`: 'bar' (or true), 'note', 'header', or false to clear.
const _SHELL_HINT_VALUE={bar:'1',header:'2',note:'3'};
export function setAppShellHint(mode){
  const secure=location.protocol==='https:'?'; Secure':'';
  const v=mode===true?'1':(_SHELL_HINT_VALUE[mode]||'');
  document.cookie=v?`ha_shell=${v}; Path=/; SameSite=Lax${secure}`:`ha_shell=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

export function signOutThisBrowser(){
  // One at a time: a second press (a double click) shares the first, rather
  // than sending a second POST whose refusal would withdraw the first's note.
  if(!_signingOut)_signingOut=_signOutThisBrowser().then(ok=>{if(!ok)_signingOut=null;return ok;},e=>{_signingOut=null;throw e;});
  return _signingOut;
}
let _signingOut=null;
async function _signOutThisBrowser(){
  // The token is another tab's session's, and who holds that session could not
  // be learnt: a sign-out sent now would be refused, and the refusal, not a
  // sign-out, would end the session. Nothing is signed out; say so.
  const ready=async()=>{
    let fresh=false;
    try{fresh=await readyToWrite();}catch(_){fresh=false;}
    if(S._sessionOutOfDate)return false;
    if(!fresh){showToast("Could not check this tab's session with the server, so you are still signed in. Please try again.",'error');return false;}
    return true;
  };
  if(!(await ready()))return false;
  // Bounded: nothing the interceptor does with this telemetry may keep the
  // sign-out from happening.
  try{await Promise.race([fireNavigatedAway('logout'),new Promise(r=>setTimeout(r,3000))]);}catch(_){/* ignore */}
  // …and again after that await, immediately before the sign-out leaves.
  if(!(await ready()))return false;
  stopSessionMonitor();
  S._sessionExpiredHandled=true;
  // The browser's other tabs ask the session check before their next request.
  _stopStep('tell other tabs', ()=>{ localStorage.setItem('ha:session-ended', String(Date.now())); });
  setAppShellHint(false);
  _forgetEventLook();
  markSignedOutHere();
  let ended=false;
  try{ended=(await trackInflightWrite(_origFetch('/api/logout',{method:'POST',headers:csrfHeaders()}))).ok;}catch(_){ended=false;}
  // A sign-out the server did not carry out leaves the session alive, and then
  // its note must not name the session's later end. A refusal or a lost answer
  // proves nothing either way (the server may have acted), so only a session
  // seen alive withdraws it.
  if(!ended){
    try{
      const sr=await _origFetch('/api/session/status');
      const sd=sr.ok?await sr.json():null;
      if(sd&&sd.active===true)clearSignedOutMark();
    }catch(_){/* unknown: keep the note */}
  }
  return true;
}

export async function _showSessionExpiredPopup(kickedBy){
  _sessionMon.endedShown=true;
  setAppShellHint(false);
  _forgetEventLook();
  // v6.16.24 — distinguish "signed in elsewhere" from "idled out". The
  // session-monitor's tick passes the kick context (server-resolved IP
  // + name + UA) when the session ended due to single-session
  // enforcement at another browser's login. The message names the
  // forensic detail so the user can recognise either themselves
  // re-logging-in from a different device, or unauthorized access.
  let title,message;
  if(kickedBy){
    title='Signed in elsewhere';
    const who=[kickedBy.first_name,kickedBy.last_name].filter(Boolean).join(' ').trim()
            ||kickedBy.email||'Another browser';
    const ip=kickedBy.ip||'an unknown address';
    // v6.16.25 — route through the canonical fmtDt() helper so the
    // displayed time uses the same browser-locale + browser-timezone
    // resolution as every other timestamp in the SPA. Pre-fix this
    // popup was the only date in the UI that bypassed fmtDt — drift
    // from the v6.8.1 invariant that's enforced for every other
    // visible timestamp.
    const at=kickedBy.at?` at ${fmtDt(kickedBy.at,'long')}`:'';
    // The built-in superadmin has no password to change: a restart issues a
    // new one (server-set `builtin`, never guessed from the email).
    // A code account's remedy is an organiser and the inbox its sign-in rests
    // on; a password account's (server-set `passwordless:false`) is a new
    // password too, set after signing in with an emailed code.
    message=kickedBy.builtin===true
      ?`You were signed out because the built-in superadmin account was signed in from another browser (IP ${esc(ip)}${at}). If this wasn't you, restart the platform, or ask whoever runs it to: that gives the account a new password and signs everyone out. Then check who can read the password file in the data folder.`
      :kickedBy.passwordless===true
        ?`You were signed out because your account was signed in from another browser (${esc(who)} at IP ${esc(ip)}${at}). If this wasn't you, tell an organiser straight away. Your account signs in with codes sent to your email, so also make sure nobody else can get into your email.`
        :`You were signed out because your account was signed in from another browser (${esc(who)} at IP ${esc(ip)}${at}). If this wasn't you, sign in with an emailed code (Email me a code instead), change your password under Profile \u2192 How you sign in, and tell an organiser straight away.`;
  }else{
    title='Signed out';
    message='You were signed out due to inactivity. Please sign in again to continue.';
  }
  await showModal({title,message,confirmText:'OK',confirmClass:'',cancelText:null});
  location.href='/';
}

export async function _showServerRestartPopup(){
  _forgetEventLook();
  await showModal({title:'Server restarted',message:'The server has been restarted and your session is no longer valid. Please sign in again.',confirmText:'OK',confirmClass:'',cancelText:null});
  location.href='/';
}
