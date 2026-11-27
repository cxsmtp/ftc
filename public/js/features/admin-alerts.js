"use strict";

// v7.16.0 — operator IP-ban alerts, client side.
//
// The scanner-reputation tracker blocks an address after 100 non-429 4xx in 10
// minutes. Against a scanner that is correct; against a hackathon venue — where
// the whole room shares one NAT egress address — it locks everyone out, and the
// only symptom an admin gets is a room of people saying "it's broken". This is
// the surface that says what happened and what to do about it, so the fix is a
// field in the admin panel rather than a shell on the server.
//
// The server decides WHERE the alert lands (in-app when an admin is signed in,
// email to superadmins when nobody is) — see lib/admin-alerts.js. This module
// is only the in-app half: poll, raise, acknowledge. The wording deliberately
// mirrors alertCopy() there, so the modal and the fallback email say the same
// thing in the same order.
//
// Module body is side-effect-free; wiring happens in main.js boot().

import { S } from "../core/state.js";
import { csrfHeaders } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { overlayDismiss, showModal } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";
import { esc, fmtDt } from "../ui/format.js";
import { ICO } from "../ui/icons.js";
import { adminCan } from "../ui/nav.js"; // RBAC — the one permission predicate (read inside functions only)

// 20 s. The block lasts 15 minutes, so this is fast enough that an admin who is
// already looking at the panel learns about it while it still matters, and slow
// enough to be invisible next to the 15 s admin-list polls.
export const ADMIN_ALERT_POLL_MS = 20_000;
// How many ticks the alert will wait for another dialog to close before raising
// anyway. Deferring is politeness; deferring FOREVER would let one leaked
// Escape-stack entry silently swallow the notice that a room is locked out, so
// the wait is bounded at ~1 minute. The overlay outranks every ordinary dialog
// visually (z-index 9550), so raising on top of one is untidy, never broken.
const ALERT_MAX_DEFERRALS = 3;

export const _alertMon = {
  pollHandle: null,
  openId: null,   // the alert currently on screen (one at a time)
  acking: false,  // an ack POST is in flight — see _ackAdminAlert
  confirming: false, // the superadmin "dismiss for everyone" confirm is open
  deferred: 0,    // consecutive ticks skipped because another dialog was open
};

// The interval's LIFETIME is bound to the signed-in session (started and
// stopped alongside the session monitor), while each TICK decides whether this
// session is currently an admin in the admin view. That split is deliberate:
// the Participant↔Admin toggle and the post-login routing live in nav.js /
// auth.js, so an admin arriving in the admin view cannot announce itself here.
// A tick that merely skips costs one property read; a tick that STOPPED would
// need a restart hook in modules this feature has no business reaching into,
// and the poll would stay dead for the rest of the session after one toggle.
export function startAdminAlertPoll(){
  if(_alertMon.pollHandle)clearInterval(_alertMon.pollHandle);
  _alertMon.pollHandle=null;
  if(S._pollsHalted)return;
  _alertMon.pollHandle=setInterval(_adminAlertTick,ADMIN_ALERT_POLL_MS);
  // Tick immediately: a ban raised before this admin signed in is already open
  // server-side, and waiting 20 s to mention a room-wide outage helps nobody.
  _adminAlertTick();
}

export function stopAdminAlertPoll(){
  if(_alertMon.pollHandle)clearInterval(_alertMon.pollHandle);
  _alertMon.pollHandle=null;
  // Tear the overlay down too. Every caller of this is the end of the session
  // (logout, forced sign-out), and an admin-only dialog left floating over a
  // dead session has nothing left to act on.
  _closeAdminAlert();
}

// v7.29.0 — the SMTP-degraded banner.
//
// Rendered from the alerts tick because it is the same kind of thing: a standing
// operational condition an admin must see, on a channel that already polls. It is
// a BANNER rather than a modal — a modal would interrupt work every 20 s for a
// condition the admin may already be dealing with.
//
// `null` means the probe has not run yet and must NOT read as a failure; only an
// explicit `false` shows anything. The element is mounted statically in
// index.html so no pane loader can destroy it.
export function _renderSmtpBanner(healthy){
  const el=document.getElementById('smtp-banner');
  if(!el)return;
  if(healthy!==false){el.hidden=true;setSafeHtml(el,'');return;}
  // v8.12.7 (review) — already saying it: leave it alone. The element is
  // role="status", and this runs on every 20 s tick, so rewriting identical
  // text made a screen reader announce the same outage three times a minute.
  // The copy is constant, so "shown and non-empty" is "shown with this text".
  if(!el.hidden&&el.childNodes.length)return;
  setSafeHtml(el,`${ICO.alertTriangle}<div><strong>Email delivery is failing.</strong> The last check of the mail server did not succeed, so verification, invitation and sign-in messages may not be arriving. Participants who are waiting for an email will need another way in — check the mail server settings, or, for someone signing in for the first time, use <em>Show sign-in code</em> on their row.</div>`);
  el.hidden=false;
}

// v8.12.7 — Checkmarx One account removals that need a superadmin's decision.
// The count rides the alerts poll (`cxone_withdrawals_attention`), which the
// server sends to a SUPERADMIN only — so for everyone else the key is absent and
// the banner stays hidden, with no client-side tier test to drift from the
// route's. Mounted statically beside #smtp-banner for the same reason that one
// is: no pane refresh can destroy it. The count is the server's own
// (held + needs attention + given up + unmarked); the client never re-derives
// it from the list, or the banner and the card could disagree about the same
// rows. The button takes the admin to the card rather than being the card.
export function _renderCxoneWithdrawalBanner(count){
  const el=document.getElementById('cxone-withdrawal-banner');
  if(!el)return;
  const n=Number(count);
  if(!Number.isInteger(n)||n<=0){el.hidden=true;setSafeHtml(el,'');delete el.dataset.count;return;}
  // (review) — UNCHANGED MEANS UNTOUCHED. This runs on every 20 s alerts tick,
  // and rebuilding the banner destroyed the "Review removals" button under a
  // keyboard user's focus (it fell to <body>) and re-announced the role=status
  // text each time. So the count the banner is showing is recorded on it, and
  // the same count on a shown banner is a no-op; a changed count still repaints.
  if(!el.hidden&&el.dataset.count===String(n))return;
  const what=n===1
    ? '1 Checkmarx One account needs your decision.'
    : `${n} Checkmarx One accounts need your decision.`;
  setSafeHtml(el,`${ICO.alertTriangle}<div class="cxone-withdrawal-banner-text"><strong>${esc(what)}</strong> The platform created ${n===1?'it':'them'} for participants who have since been deleted, and could not remove ${n===1?'it':'them'} from the customer's tenant — or will not without your say-so.</div><button type="button" class="btn sm secondary" data-action="cxone-withdrawals-review">Review removals</button>`);
  el.dataset.count=String(n);
  el.hidden=false;
}

// One alerts read that repaints ONLY the two standing banners, for a caller that
// has just changed what the count would say (a Retry or Mark removed on the
// card). It never opens an alert dialog — that is the poll's job, on its own
// cadence — and a failed read leaves the banners as they were.
export async function refreshAdminBanners(){
  // RBAC — a role that may not read alerts (`ops.alerts`) sends no read.
  if(!S.isAdmin||!S.isAdminView||S.impersonation||!adminCan('ops.alerts'))return;
  let d;
  try{
    const r=await fetch('/api/admin/alerts');
    if(!r.ok)return;
    d=await r.json();
  }catch(_){return;}
  if(!d||typeof d!=='object')return;
  _renderSmtpBanner(d.smtp_healthy);
  _renderCxoneWithdrawalBanner(d.cxone_withdrawals_attention);
}

export async function _adminAlertTick(){
  // Not an admin, or an admin looking at the participant view — no request at
  // all, so a participant session never touches an admin endpoint.
  // v8.12.1 — nor while impersonating: the seat is an organiser's, an operator
  // alert is addressed to the acting admin's OWN panel, and a "dismiss for
  // myself" from here would be recorded against the target. The bar says whose
  // panel this is; the alert waits for the admin's own session. THE SMTP
  // BANNER STANDS DOWN WITH IT, and that is not a side effect but the route:
  // GET /api/admin/alerts is FORBIDDEN to the event-admin tier (lib/event-admin.js),
  // so an organiser's own panel never carries the banner and a request from
  // their seat would 403 and stop this poll for the life of the tab. The seat
  // sees what the organiser sees; a relay outage reaches the acting admin on
  // their own panel, where the desk fallback it points at also lives.
  // RBAC — nor for a role that may not read alerts (`ops.alerts`: the event
  // admin, a custom role without it): its refusal would count towards the
  // address's scanner block on every page load.
  if(!S.isAdmin||!S.isAdminView||S.impersonation||!adminCan('ops.alerts')){_closeAdminAlert();_renderCxoneWithdrawalBanner(0);return;}
  const open=_alertMon.openId;
  // Don't shove a NEW alert in front of a dialog the admin is already working
  // in — nothing is lost by waiting, because the alert stays open server-side
  // until the block lapses. Bounded: see ALERT_MAX_DEFERRALS. An alert already
  // on screen still polls, so that it can close itself (below).
  if(!open&&window._modalEscStack&&window._modalEscStack.length&&_alertMon.deferred<ALERT_MAX_DEFERRALS){
    _alertMon.deferred++;
    return;
  }
  if(!open)_alertMon.deferred=0;
  let d;
  try{
    const r=await fetch('/api/admin/alerts');
    // 401/403 — the session ended, or admin rights were dropped, between ticks.
    // Stop rather than spend the rest of the tab's life logging a 403 every 20 s.
    if(r.status===401||r.status===403){stopAdminAlertPoll();return;}
    if(!r.ok)return;                     // transient (5xx / maintenance); retry next tick
    d=await r.json();
  }catch(_){return;}                     // network blip; retry next tick
  _renderSmtpBanner(d.smtp_healthy);
  _renderCxoneWithdrawalBanner(d.cxone_withdrawals_attention);
  const list=Array.isArray(d.alerts)?d.alerts:[];
  if(open){
    // The modal says it clears itself when the block lapses, so it has to. The
    // server stops listing an alert once `now >= blocked_until` — and also when
    // a superadmin dismisses it for everyone, which is how that decision
    // reaches the other admins' screens. Either way: gone from the list, gone
    // from the screen. It is no longer actionable, so it closes silently.
    // Not while the admin is mid-decision, though: yanking the card out from
    // behind its own confirmation dialog just looks broken, and the ack still
    // lands (the server keeps the row for an hour after it stops listing it).
    if(!list.some(a=>a.id===open)&&!_alertMon.acking&&!_alertMon.confirming)_closeAdminAlert();
    return;
  }
  // Server-sorted oldest-first. Raise one at a time: two stacked modals about
  // two blocked addresses is noise, and acknowledging the first reveals the next.
  const alert=list[0];
  if(!alert)return;
  _showIpBanAlert(alert,!!d.isSuperAdmin);
}

/**
 * The alert modal. Mirrors lib/admin-alerts.js alertCopy() branch for branch —
 * the two must not drift, because an admin may well be reading the email on
 * their phone and the modal on the laptop at the same moment.
 *
 * `isSuperAdmin` comes from the ALERT PAYLOAD, not from S: the global-dismiss
 * button must reflect what the server will actually authorise, so a stale
 * client flag cannot offer a control that then 403s.
 */
export function _showIpBanAlert(alert,isSuperAdmin){
  if(!alert||!alert.id)return;
  if(document.getElementById('admin-alert-overlay'))return;
  _alertMon.openId=alert.id;

  const ip=esc(alert.ip||'this address');
  const comp=alert.competition_name?esc(alert.competition_name):null;
  // v8.3.20 — NAME THE ZONE. The modal has always rendered this instant in the
  // BROWSER's timezone (correct — the reader is at that browser) while the
  // emailed twin forced UTC, so the two channels showed different clock times
  // for the same deadline and neither said which. The email now renders in the
  // recipient's stored timezone and names it; this names the browser's, so both
  // read the same shape. The v7.21.14 mirror lock compares BRANCHES, not the
  // shared values inside them, which is why that drift shipped under a lock
  // nominally guarding exactly this pair.
  const lifts=esc(fmtDt(alert.blocked_until,'long',{withZone:true}));
  const where=comp?`during the live event <strong>${comp}</strong>`:'while no Booth Event or Competition was live';

  let guidance;
  if(alert.already_trusted){
    // The bypass should have prevented this block, so the venue advice below
    // would send the admin round a loop adding an entry that is already there.
    guidance=`<div class="admin-alert-guidance admin-alert-guidance-warn">
      <p><strong>This address is already listed as a trusted network for that event, so it should not have been blocked.</strong></p>
      <p>That points at a configuration problem rather than a busy venue. Check that the event is <strong>live</strong> — trusted networks are inert before it starts and expire 2 hours after it ends — and that the address matches exactly.</p>
    </div>`;
  }else if(comp&&alert.accepts_trusted_ips===false){
    // v7.21.14 — the competition has SESSIONS, so "Trusted network IPs" is not
    // available for it (single-session only, v7.16.0 — the competition PUT
    // refuses that field with a 400 when any session exists). Telling the admin
    // to use it anyway would send them to a control that rejects them, in the
    // one moment they are standing in the room with the venue locked out.
    guidance=`<div class="admin-alert-guidance">
      <p><strong>If this is your venue's Wi-Fi, this is expected:</strong> everyone in the room shares one public address, so their combined traffic looks like a single very busy client.</p>
      <p><strong>${comp}</strong> runs as multiple sessions, and the per-competition <strong>Trusted network IPs</strong> setting is only available on a single-session event — so it cannot be used to unblock this address. What you can do:</p>
      <ul class="admin-alert-steps">
        <li><strong>Wait it out</strong> — the block lifts by itself at <strong>${lifts}</strong>, and participants can retry then.</li>
        <li>For a lasting fix, add <code class="admin-alert-ip">${ip}</code> to the <code>RATE_LIMIT_ALLOWLIST_IPS</code> environment variable and restart the platform. That needs server access, and it applies to the whole platform rather than to one event.</li>
        <li>If you have decided this really is a scanner and not your venue, a superadmin can dismiss this notice for everyone.</li>
      </ul>
      <p>If you do <strong>not</strong> recognise this address, leave it blocked — the block is doing its job.</p>
    </div>`;
  }else if(comp&&alert.can_set_trusted_ips===false){
    // The READER cannot change that event (their role, their scope, or they
    // compete in it — decided per reader by the alerts route). Mirrors
    // alertCopy's branch: say who can take the advice, never "save" into a refusal.
    guidance=`<div class="admin-alert-guidance">
      <p><strong>If this is your venue's Wi-Fi, this is expected:</strong> everyone in the room shares one public address, so their combined traffic looks like a single very busy client.</p>
      <p>You cannot change the event <strong>${comp}</strong> yourself, so ask an administrator who can to put <code class="admin-alert-ip">${ip}</code> in its <strong>Trusted network IPs</strong> and save — the block is lifted immediately on save. Otherwise it lifts by itself at <strong>${lifts}</strong>.</p>
      <p>If you do <strong>not</strong> recognise this address, leave it blocked — the block is doing its job.</p>
    </div>`;
  }else if(comp){
    guidance=`<div class="admin-alert-guidance">
      <p><strong>If this is your venue's Wi-Fi, this is expected:</strong> everyone in the room shares one public address, so their combined traffic looks like a single very busy client.</p>
      <p class="admin-alert-steps-head">To unblock them now:</p>
      <ol class="admin-alert-steps">
        <li>Open the event <strong>${comp}</strong> in the admin panel.</li>
        <li>Put <code class="admin-alert-ip">${ip}</code> in <strong>Trusted network IPs</strong> and save.</li>
        <li>The block is lifted <strong>immediately on save</strong> — participants can retry straight away.</li>
      </ol>
      <p>The entry only applies while that event is running, and stops working <strong>2 hours after it ends</strong>, so there is nothing to remember to undo.</p>
      <p>If you do <strong>not</strong> recognise this address, leave it blocked — the block is doing its job.</p>
    </div>`;
  }else{
    guidance=`<div class="admin-alert-guidance">
      <!-- v8.1.0 (PR 20) — mirrors lib/admin-alerts.js branch for branch (the
           v7.21.14 lock enumerates both sides). The "unlikely to be a venue"
           inference is gone: anyCompetitionLive now excludes Programs, so a
           room working through one lands in THIS branch. -->
      <p>No Booth Event or Competition is currently live. If you do not recognise the address, no action is needed — the block is doing its job. If a room IS working through a self-paced Program right now, that does not appear here and cannot use per-event trusted networks: wait out the block, or add the address to RATE_LIMIT_ALLOWLIST_IPS and restart.</p>
    </div>`;
  }

  // v7.25.0 — mirrors alertCopy()'s verdict branch. The old flat claim ("which
  // is the pattern of a scanner") was wrong for precisely the traffic this
  // notice exists to explain, and an unmistakable scanner no longer raises a
  // notice at all — so whatever reaches here is genuinely ambiguous and the
  // copy says which way it leans.
  // v8.3.20 — the `mixed` branch SPLITS on routed_4xx, mirroring alertCopy. The
  // verdict label is derived from the probe RATIO alone, so a walk that asked
  // only for things this platform does not have — but matched no known-bad
  // signature — lands in "mixed" with routed_4xx of zero, and the old sentence
  // told that admin some of it "reached real pages of the platform" when none of
  // it had.
  const verdictLine = alert.verdict === 'cohort'
    ? `<p class="admin-alert-facts">Those requests were answered by real pages of the platform, rather than being probes for files that do not exist. That is what a busy shared network looks like, so this may well be your venue.</p>`
    : (alert.verdict === 'mixed' && alert.routed_4xx === 0)
      ? `<p class="admin-alert-facts">All of that traffic was asking for things this platform does not have, but not enough of it matched a known attack pattern, or came from enough different paths, to call it a scanner outright — so it could be a scanner this notice does not recognise, or a client on your network repeatedly requesting something that no longer exists.</p>`
      : alert.verdict === 'mixed'
        ? `<p class="admin-alert-facts">Some of that traffic was probing for files that do not exist, and some of it reached real pages of the platform — so it could be a scanner, a busy shared network, or both.</p>`
        : '';

  const overlay=document.createElement('div');
  overlay.id='admin-alert-overlay';
  setSafeHtml(overlay,`<div class="card admin-alert-card" role="alertdialog" aria-modal="true" aria-labelledby="admin-alert-title" aria-describedby="admin-alert-lede">
    <h3 id="admin-alert-title" class="modal-title admin-alert-title">${ICO.alertTriangle} Network address blocked</h3>
    <p id="admin-alert-lede" class="admin-alert-lede">The address <code class="admin-alert-ip">${ip}</code> has been temporarily blocked ${where}.</p>
    <p class="admin-alert-facts">It sent <strong>${esc(String(alert.count_4xx ?? 0))} rejected requests</strong> within 10 minutes. The block lifts automatically at <strong>${lifts}</strong>.</p>
    ${verdictLine}
    ${guidance}
    <p class="admin-alert-footnote">This notice clears itself when the block lapses at ${lifts}. If the traffic has stopped by then it will not return; if it continues, the address is blocked again and you will be told again. To silence it for everyone straight away — because you have decided this really is a scanner and not your venue — a superadmin can dismiss it permanently.</p>
    <div class="admin-alert-actions">
      ${isSuperAdmin?`<button class="btn secondary" data-action="admin-alert-dismiss-global" data-alert-id="${esc(alert.id)}">Not our venue — dismiss for everyone</button>`:''}
      <button class="btn" data-action="admin-alert-dismiss" data-alert-id="${esc(alert.id)}">Dismiss</button>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  // Escape performs the SELF dismissal rather than a bare close. A bare close
  // would leave the alert open server-side and the next tick would raise it
  // again 20 s later, which reads as a broken dialog. Self-dismissal is the
  // safe direction: it hides the notice for this admin only, a colleague in the
  // same room still sees it, and a fresh block raises a fresh alert. The
  // irreversible, everyone-affecting option is never on Escape.
  overlayDismiss(overlay,()=>_ackAdminAlert(alert.id,'self'));
  // Primary action holds focus on open (modal button-order contract) — without
  // scrolling to it: on a phone the card scrolls, and moving to the button at
  // its foot opened the notice mid-message, past its title and the address.
  setTimeout(()=>overlay.querySelector('[data-action="admin-alert-dismiss"]')?.focus({preventScroll:true}),0);
}

/**
 * Acknowledge and close. `scope` is "self" (any admin — hides it for them only)
 * or "global" (superadmin — hides it for everyone AND suppresses further alerts
 * for that address).
 */
export async function _ackAdminAlert(id,scope){
  // Escape and the Dismiss button are two doors onto the same action, so they
  // can both fire — the click, then the Esc-stack entry as the dialog tears
  // down. One ack per alert.
  if(!id||_alertMon.acking)return;
  _alertMon.acking=true;
  // Disable while the POST is in flight so the dialog visibly acknowledges the
  // click on a slow link rather than looking inert.
  document.getElementById('admin-alert-overlay')
    ?.querySelectorAll('.admin-alert-actions .btn').forEach(b=>{b.disabled=true;});
  let ok=false;
  try{
    const r=await fetch(`/api/admin/alerts/${encodeURIComponent(id)}/ack`,{
      method:'POST',
      headers:csrfHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({scope:scope==='global'?'global':'self'}),
    });
    ok=r.ok;
    if(!ok){
      const d=await r.json().catch(()=>({}));
      showToast(d.error||'Could not dismiss the alert.','error');
    }
  }catch(_){showToast('Could not dismiss the alert.','error');}
  finally{_alertMon.acking=false;}
  // Close either way: an admin who asked for it to go should not be trapped by
  // a failed request. A failed ack means the next poll raises it again, which
  // is the honest outcome — nothing was recorded.
  _closeAdminAlert();
  if(ok&&scope==='global')showToast('Alert dismissed for everyone. This address will not raise another for about an hour.','success');
  // A recorded dismissal changes the open list: a list on screen (the Settings
  // Alerts card) reads it again rather than keep a row that is gone.
  if(ok)document.dispatchEvent(new CustomEvent('admin:alerts-changed'));
}

/** Superadmin path — confirm first: it is permanent for every admin. */
export async function _ackAdminAlertGlobal(id){
  _alertMon.confirming=true;
  try{
    if(!await _confirmGlobalDismiss())return;
  }finally{_alertMon.confirming=false;}
  await _ackAdminAlert(id,'global');
}

function _confirmGlobalDismiss(){
  return showModal({
    title:'Dismiss for everyone?',
    message:'This hides the alert for <strong>every</strong> admin and stops this address raising another for about an hour. Only do it once you are sure the traffic is a scanner and not your venue — otherwise the people who could unblock the room never hear about it.',
    confirmText:'Dismiss for everyone',
    confirmClass:'danger',
  });
}

export function _closeAdminAlert(){
  _alertMon.openId=null;
  // overlayDismiss's MutationObserver pops the Escape entry + releases the
  // focus trap when the node leaves the DOM, so removal is the whole teardown.
  document.getElementById('admin-alert-overlay')?.remove();
}
