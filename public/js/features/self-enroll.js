"use strict";

import { downloadBlob } from "../ui/download.js";
import { S } from "../core/state.js";
import { csrfHeaders } from "../core/api.js";
import { _ttVendorScriptPolicy, setSafeHtml } from "../core/trusted-types.js";
import { selectCompetition, showPendingPageForCompetition, showTimeslotPicker, computeCompStatus, isLateEntryOpen, compDisplayCategory, COMP_CATEGORY_LABEL } from "./competition-picker.js";
import { loadAdminCompetitions } from "./competitions-admin.js";
import { esc, fmtDt } from "../ui/format.js";
import { ICO } from "../ui/icons.js";   // v8.12.0 — the read-only Join Link note
import { overlayDismiss, showModal } from "../ui/modal.js";
import { adminCan, enterCompetitionView, routeVerdict, showMain, showPage } from "../ui/nav.js";
import { showToast } from "../ui/toast.js";
import { setEventLook } from "../ui/theme.js";

// ═══ Persisted pending join (v7.22.8) ═══════════════════════════════════════
// A /join/<token> visitor who abandons sign-up used to lose the token for good:
// the SPA deliberately strips it from the URL and history (secrecy), so coming
// back via the homepage meant registering as an ORDINARY signee — unapproved,
// unassociated with the event, and needing an admin to notice and repair all
// three steps by hand (reported from a live competition). The pending join is
// therefore persisted in localStorage and rehydrated at boot.
//
// localStorage, deliberately NOT a cookie: a cookie retransmits the 256-bit
// token on EVERY request for the life of the competition — including over the
// plain-http venue LANs this platform routinely runs on — while localStorage
// never touches the wire. It survives a browser restart the same way a
// persistent cookie would.
//
// Expiry is the competition's EFFECTIVE end (the preview's effective_end
// field), refreshed on every successful preview. It is a HINT about when the
// capability probably lapsed — never, since v8.1.4, the verdict that deletes
// it: extending a time-expired competition revives it purely by time
// arithmetic, so a stored deadline can be in the past while the event is
// still joinable, and only the server knows which. Boot revalidation against
// the preview endpoint is the authority — it also catches token ROTATION,
// self-enroll DISABLE and an early manual end, none of which a clock can see.
//
// Purge points: successful registration or join (the server then owns the
// pending state — pending_self_enroll_comp_id — so retaining the secret buys
// nothing), a full event (PR 30), a preview 404 (rotated / disabled / ended),
// and the far-horizon retention backstop below.
// Purge-on-success is load-bearing: it is what stops a lingering token from
// silently re-enrolling a participant an admin later removed.
const PENDING_JOIN_KEY='hck-pending-join';

// How long past the stored deadline we go on ASKING the server about a token.
// Deliberately generous: the extend / revive window this covers is hours, so a
// month is two orders of magnitude of headroom — but not unbounded, so a
// 256-bit secret does not live for ever in a browser that never regains
// network to be told otherwise. It is also what keeps `exp` load-bearing
// rather than a stored field nothing reads. If this bound is ever wrong it is
// wrong in the direction of today's ordinary sign-up, never in the direction
// of deleting a token for an event that is still joinable.
const PENDING_JOIN_KEEP_MS=30*24*3600_000;

export function storePendingJoin(token,comp){
  if(!token)return;
  // No effective_end (preview unreachable at store time) → 24h fallback, so an
  // abandoned visit still recovers even when the venue network flaked on the
  // link click. Refreshed from the real end on the next successful preview.
  const end=comp&&comp.effective_end?Date.parse(comp.effective_end):NaN;
  const exp=Number.isFinite(end)?end:Date.now()+24*3600_000;
  try{localStorage.setItem(PENDING_JOIN_KEY,JSON.stringify({t:token,exp}));}catch(_){/* storage unavailable → today's in-memory behaviour */}
}

export function clearStoredJoin(token){
  try{
    if(token){
      const raw=localStorage.getItem(PENDING_JOIN_KEY);
      if(raw&&JSON.parse(raw).t!==token)return; // a DIFFERENT stored token stays
    }
    localStorage.removeItem(PENDING_JOIN_KEY);
  }catch(_){/* ignore */}
}

function _readStoredJoin(){
  try{
    const raw=localStorage.getItem(PENDING_JOIN_KEY);
    if(!raw)return null;
    const p=JSON.parse(raw);
    if(!p||typeof p.t!=='string'||!p.t||typeof p.exp!=='number'){localStorage.removeItem(PENDING_JOIN_KEY);return null;}
    return p;
  }catch(_){try{localStorage.removeItem(PENDING_JOIN_KEY);}catch(__){/* ignore */}return null;}
}

// Boot-time recovery: no token in the URL, but one persisted from an earlier
// visit. Revalidates against the preview endpoint before trusting it, so the
// sign-up / sign-in / already-authenticated paths behave exactly as if the
// link had just been clicked. Returns true iff a token was rehydrated.
export async function rehydratePendingJoin(){
  const p=_readStoredJoin();
  if(!p)return false;
  // ── AN EXPIRED CLOCK IS NOT A VERDICT (v8.1.4) ────────────────────────────
  // This was `if(Date.now()>p.exp){clearStoredJoin();return false;}` — the
  // stored token destroyed BEFORE any network call, on the premise that the
  // capability is useless past its stored end because "the preview 404s an
  // ended competition". That premise is false. EXTENDING a time-expired
  // competition revives it purely by time arithmetic (the "two kinds of
  // ended" rule), and reviving a manually-ended one is an ordinary admin
  // action — so `exp` can be in the past while the event is still joinable.
  //
  // The walk-up this whole module exists for — abandoned the sign-up, comes
  // back after the original end while the EXTENDED event is still running —
  // therefore had the recovery silently deleted on a clock's say-so and
  // landed on the bannerless ordinary sign-up as a stray unapproved account:
  // the exact failure v7.22.8 was built to fix. It also contradicted this
  // function's own transient-keep rule below, where only a 404 may delete.
  //
  // THE TRADE-OFF taken here: an expired token now costs ONE preview request.
  // It is paid at most once — a genuinely finished event 404s, which purges —
  // and only by a visitor who abandoned a sign-up and never completed it. The
  // backstop keeps the zero-network purge for the one case where it is really
  // free: a deadline so far past that no revive could still be in play.
  if(Date.now()>p.exp+PENDING_JOIN_KEEP_MS){clearStoredJoin();return false;}
  try{
    const pr=await fetch('/api/competitions/self-enroll/'+encodeURIComponent(p.t));
    // A 404 is the server's VERDICT — rotated / disabled / ended — and purges.
    // Any OTHER non-OK is transient (the preview is rate-limited 30/min/IP, so
    // a venue-NAT cohort 429s it routinely; a 5xx arrives mid-deploy): keep
    // storage and skip rehydration this boot, exactly like the network-error
    // branch below. Purging on a transient would convert a blip into a
    // permanent loss of the recovery — the v7.16.4 rule.
    if(pr.status===404){clearStoredJoin();return false;}
    if(!pr.ok){return false;}
    S._pendingJoinComp=await pr.json();
    S._pendingJoinToken=p.t;
    storePendingJoin(p.t,S._pendingJoinComp); // refresh expiry — the schedule may have moved
    _renderJoinBanner();
    return true;
  }catch(_){return false;} // network error: keep storage, retry next boot — don't join on unvalidated state
}

// WHAT JOINING SHARES (operator ruling, 17 Nov 2026): an event with a report team
// sends its participants' details to that team (the token preview's
// `shares_leads`), so the join card says so, and how to stay out of the lists.
export const LEAD_NOTICE='This event\u2019s organisers and their sales and marketing team receive your name, work email, company, job title and your answers to its quick questions. Answer No to \u201cWould you like someone to follow up with you?\u201d and you are left out of their follow-up lists.';
function _paintLeadNotice(id,on){const el=document.getElementById(id);if(!el)return;el.textContent=on?LEAD_NOTICE:'';el.hidden=!on;}

export function _renderJoinBanner(){
  const name=S._pendingJoinComp&&S._pendingJoinComp.name?S._pendingJoinComp.name:null;
  // THE JOIN LANDING WEARS THE EVENT'S LOOK (the preview's event_look). Signed
  // out only: inside the app, ui/nav.js showMain owns the event look.
  if(!S.currentUser){
    const pc=S._pendingJoinComp;
    setEventLook(pc&&pc.event_look?{look:pc.event_look,locked:!!pc.event_look_locked}:null);
  }
  // The sign-in card shows the EVENT itself — its name and a status chip — as
  // the only context worth showing; the sign-up form keeps its sentence.
  {
    const b=document.getElementById('join-banner'),i=document.getElementById('join-banner-info'),chip=document.getElementById('join-banner-chip');
    if(b&&i){
      if(name&&S._pendingJoinToken){
        i.textContent=name;
        // The ONE status table, by the bucket a human is shown: an ended event
        // still taking late entries (the preview's late_entry_window_open)
        // reads "Late entry open", in the same colours as on the Events list.
        const pc=S._pendingJoinComp;
        const cat=pc&&pc.status?compDisplayCategory(pc):'';
        const label=COMP_CATEGORY_LABEL[cat]||'';
        if(chip){chip.textContent=label;chip.className=label?`badge comp-badge comp-${cat}`:'badge';chip.hidden=!label;}
        b.style.display='';
        b.closest('.auth-card')?.classList.add('has-event');
        _paintLeadNotice('join-banner-leads',!!(pc&&pc.shares_leads));
      }else{
        b.style.display='none';
        b.closest('.auth-card')?.classList.remove('has-event');
        _paintLeadNotice('join-banner-leads',false);
      }
    }
  }
  {
    const b=document.getElementById('reg-join-banner'),i=document.getElementById('reg-join-info');
    if(b&&i){
      if(name&&S._pendingJoinToken){ i.textContent=`You're joining: ${name}.`; b.style.display=''; _paintLeadNotice('reg-join-leads',!!(S._pendingJoinComp&&S._pendingJoinComp.shares_leads)); }
      else { b.style.display='none'; _paintLeadNotice('reg-join-leads',false); }
    }
  }
  _applyRelaxedProfileFields();
  // The ANONYMOUS event-code door (`#login-event-code-row`, "Have an event
  // code?" on the entry card) is for someone who has NOT arrived through a link.
  // Once a join is resolved it is noise at best and an invitation to type over a
  // working state at worst. `#comp-join-code-box` is deliberately left alone: it
  // belongs to a signed-in participant joining ANOTHER event, so a resolved
  // pending join says nothing about whether they still want it.
  const codeRow=document.getElementById('login-event-code-row');
  if(codeRow)codeRow.hidden=!!(name&&S._pendingJoinToken);
}

/**
 * v8.1.0 (PR 32) — resolve a typed event code and adopt it as the pending join.
 *
 * It exchanges the code for the TOKEN and then takes exactly the path a link
 * click takes (`storePendingJoin` + `_renderJoinBanner`), so nothing downstream
 * — registration, the deferred consume, the boot rehydration — has to learn what
 * a code is. One join mechanism, two ways in.
 *
 * ── THE RISKIEST LINE HERE IS `d.ok`, NOT `r.ok`. ──
 *
 * The lookup answers **200 for every outcome, including every refusal**, for the
 * sign-in-code reason (PR 33): a counted 4xx feeds the scanner-reputation counter,
 * and a code printed on a sign is mistyped by design, so at a venue behind one NAT
 * ordinary mistyping would block the whole address from the API. So the branch is
 * on the PAYLOAD; a client that reads the status instead would call every refusal
 * a success and hand `undefined` to the preview.
 *
 * A 429 is handled SEPARATELY and must stay that way: a throttled lookup is not
 * "that code is wrong". Telling someone their code is invalid when the server
 * never looked it up sends them to find an organiser over a code that works.
 */
async function _resolveJoinCode(raw,input){
  const bad=()=>{showToast('That code is not valid for any event running right now.','error');input?.focus();input?.select();};
  try{
    const r=await fetch(`/api/competitions/join-code/${encodeURIComponent(raw)}`);
    if(r.status===429){
      // The one status this endpoint still uses, and the only refusal that says
      // TRY AGAIN rather than THAT CODE IS WRONG.
      showToast('Too many tries just now — wait a moment and try the code again.','error');
      input?.focus();input?.select();
      return null;
    }
    const d=await r.json().catch(()=>({}));
    // ── THE LINE. `d.ok`, never `r.ok`. See the note above. ──
    // The refusal is deliberately the SAME for an unknown code, a disabled link
    // and a finished event — the lookup is public and must not become an oracle
    // for which codes exist — so the copy is ours, not the server's.
    if(!d.ok||!d.token){bad();return null;}
    const token=d.token;
    // The preview keeps its 404 (a token is not typed, so it is not the mistype
    // surface). Reaching it here means the event stopped being joinable between
    // the two calls, which is the same answer to the person holding the sign.
    const pv=await fetch(`/api/competitions/self-enroll/${encodeURIComponent(token)}`);
    if(!pv.ok){bad();return null;}
    return {token,comp:await pv.json()};
  }catch(_){
    showToast('Could not check that code — check your connection and try again.','error');
    return null;
  }
}

/**
 * v8.2.3 — the code, for someone who ALREADY has an account.
 *
 * The code entry shipped on one surface only: the sign-up form. That is the right
 * place for the walk-up who has never been here — and it is no place at all for the
 * attendee who was at last month's event, because they sign in and land on their
 * events list, where nothing on screen mentions a code and the sign-up form they
 * would need is behind a button that says they have no account. So "type this code"
 * was printed on signage for a population that could act on it and a population that
 * could not, with no way to tell which you were until you tried.
 *
 * It resolves through the SAME `_resolveJoinCode` and then hands the token to the
 * SAME `joinViaPendingToken` the link click uses — one join mechanism, now three
 * ways in, and none of them a second implementation of the enrolment call, its
 * refusals or its purge-on-success rule.
 *
 * `S._pendingJoinToken` is set rather than the token being passed as an argument,
 * because that is the field `joinViaPendingToken` clears and re-renders the banner
 * from; threading a parameter would leave the global set on the failure path.
 */
export async function joinWithCode(){
  if(S.impersonation){showToast(JOIN_WHILE_VIEWING_AS,'error');return;}
  const input=document.getElementById('comp-join-code');
  const raw=input?input.value.trim():'';
  if(!raw){showToast('Enter the code from the event signage.','error');input?.focus();return;}
  const res=await _resolveJoinCode(raw,input);
  if(!res)return;
  S._pendingJoinToken=res.token;S._pendingJoinComp=res.comp;
  // joinViaPendingToken owns the refusal copy and clears the pending state on
  // both paths, so a failure here leaves nothing behind to be re-submitted.
  const id=await joinViaPendingToken();
  if(!id)return;
  if(input)input.value='';
  // v8.12.0 — a spectator answer already said "you have not been enrolled";
  // a second toast saying "Joined" beside it is a contradiction on screen.
  if(!S._lastJoinSpectator)showToast(`Joined ${res.comp.name}.`,'success');
  await enterAfterJoin(id);
}

/**
 * v8.1.0 (PR 31) / v8.4.0 — RENDER THE SIGN-UP FORM THIS EVENT ACTUALLY ASKS FOR.
 *
 * Five fields are configurable per event (Salutation, Phone, City, LinkedIn URL,
 * Job function) and each has THREE states, which is why this
 * reads `policy.registration_fields` — one value per field — rather than the two
 * set memberships it read before. The old encoding could not express what is now
 * possible: `personal_title` / `phone` / `linkedin_url` were optional for every
 * kind and can now be REQUIRED, and "required" under the old rule was inferred
 * from being in NEITHER set, so those three would have had to appear in
 * `optional_profile` on every kind merely to stay as they were.
 *
 * The client never DECIDES any of this — the server re-derives the identical
 * states from the join token in `POST /api/register`, so a fabricated relaxation
 * is a 400 rather than a silently shorter form.
 *
 * Driven from `_renderJoinBanner` because that already runs on every path that
 * resolves or clears a pending join (URL click, boot rehydration, purge), so the
 * form and the banner can never disagree about which event is in play.
 *
 * **THE MARKUP DECLARES EACH FIELD'S DEFAULT, and that is what makes the resting
 * state correct.** `data-relax-default` carries what the field is when no policy
 * applies — an ordinary sign-up, an invitation, a cleared join. Deriving it from
 * "absent from both sets" is what the old code did and it worked only because
 * both relaxable fields happened to be required by default; with today's
 * defaults (City and Job function optional; Salutation, Phone and LinkedIn URL
 * hidden), the same inference would mark all five required for every visitor
 * who is not behind a join link. A docs-hygiene lock diffs these attributes
 * against the server's LEGACY_STATES, so the two cannot drift.
 *
 * REMOVING the `required` markers matters as much as hiding the row: the field
 * keeps `aria-required="true"` otherwise, so a screen reader announces a required
 * field that is not on screen, and `doRegister` would still refuse to submit
 * without it.
 */
export function _applyRelaxedProfileFields(){
  const _pol=(S._pendingJoinToken&&S._pendingJoinComp&&S._pendingJoinComp.policy)?S._pendingJoinComp.policy:null;
  const _states=(_pol&&_pol.registration_fields&&typeof _pol.registration_fields==='object')?_pol.registration_fields:null;
  for(const group of document.querySelectorAll('[data-relax-field]')){
    const field=group.getAttribute('data-relax-field');
    // The policy wins; the markup's own default is the fallback, never an
    // inference from absence. An unrecognised state falls back too, so a value a
    // newer server sends cannot leave a field in no state at all.
    const _d=group.getAttribute('data-relax-default');
    const dflt=(_d==='required'||_d==='hidden')?_d:'optional';
    const raw=_states?_states[field]:null;
    const state=(raw==='required'||raw==='optional'||raw==='hidden')?raw:dflt;
    const drop=state==='hidden';
    const opt=state==='optional';
    group.hidden=drop;
    // v8.4.0 — the RESOLVED state rides the group, so `doRegister` reads one
    // attribute instead of re-deriving the three cases from `[hidden]` +
    // `[data-relax-optional]` + an inline-style sniff. `data-relax-optional` is
    // KEPT beside it: the v8.3.1 lock and the CSS both key on it, and it is still
    // exactly "shown but not required".
    group.setAttribute('data-relax-state',state);
    group.toggleAttribute('data-relax-optional',opt);
    for(const el of group.querySelectorAll('input,select')){
      if(drop||opt)el.removeAttribute('aria-required'); else el.setAttribute('aria-required','true');
      // Only a DROPPED field is cleared — clearing an optional one would throw
      // away something the visitor chose to type.
      if(drop&&el.value)el.value='';
    }
    // THE MARKER IS CREATED AND DESTROYED, not merely shown and hidden — and the
    // asymmetry with the fields that carry one statically is the whole reason.
    // A default-OPTIONAL field has no `.req` in the markup: putting one there and
    // hiding it with CSS would mean a starred label carrying no `aria-required`
    // (a screen reader hears a demand the form does not make) and a star painted
    // for the first frames of every page load, before any policy has been
    // applied. A default-REQUIRED field keeps its static star and is merely
    // hidden, which is what every existing lock reads.
    let req=group.querySelector('.req');
    if(drop||opt){
      if(req&&group.getAttribute('data-relax-default')!=='required')req.remove();
      else if(req)req.style.display='none';
    }else{
      if(req)req.style.display='';
      else{
        const lbl=group.querySelector('label');
        if(lbl){lbl.appendChild(document.createTextNode(' '));req=document.createElement('span');req.className='req';req.textContent='*';lbl.appendChild(req);}
      }
    }
    // A field whose static label already says "(optional)" must stop saying it
    // when the event demands it — and must not be given a SECOND dynamic hint
    // while it stays optional, which is what "(optional) (optional)" would be.
    const staticHint=group.querySelector('.label-static-hint');
    if(staticHint)staticHint.style.display=(drop||opt)?'inline':'none';
    // v8.4.0 — a select whose blank option reads "Prefer not to say" must not
    // offer that choice on an event that demands the field: the control would
    // present an answer and then refuse it. `data-required-label` carries the
    // instruction form, and the swap is reversible so clearing a join token
    // restores the original copy.
    const ph=group.querySelector('option[data-required-label]');
    if(ph){
      if(!ph.dataset.optionalLabel)ph.dataset.optionalLabel=ph.textContent;
      ph.textContent=(drop||opt)?ph.dataset.optionalLabel:ph.getAttribute('data-required-label');
    }
    let hint=group.querySelector('.label-optional-hint');
    if(opt&&!hint&&!staticHint){
      const lbl=group.querySelector('label');
      if(lbl){hint=document.createElement('span');hint.className='label-hint label-optional-hint';hint.textContent=' (optional)';lbl.appendChild(hint);}
    }else if((!opt||staticHint)&&hint){hint.remove();}
  }
}

// Operator ruling, 21 Nov 2026 — nobody joins an event while viewing as
// someone: the join would enrol the person being viewed, and count them as
// joined. The server refuses it for every tier (`impersonation_join_refused`,
// lib/impersonation.js); the page does not offer it, and says why.
export const JOIN_WHILE_VIEWING_AS='Joining an event is not available while you view as someone: it would enrol them. To add them to an event, use Add to event in that event\'s Participants section.';
// (The events page's "Have an event code?" box shows the same sentence in place
// of its input while `body.impersonating` is set: public/styles.css.)

export async function joinViaPendingToken(){
  if(!S._pendingJoinToken)return null;
  // A join link clicked while viewing as someone is told why nothing happens;
  // a join this browser stored earlier waits, untouched, for its own account.
  if(S.impersonation){
    const told=!!S._joinFromUrl;
    S._pendingJoinToken='';S._pendingJoinComp=null;_renderJoinBanner();
    if(told)showToast(JOIN_WHILE_VIEWING_AS,'error');
    return null;
  }
  const tok=S._pendingJoinToken;
  const shares=!!(S._pendingJoinComp&&S._pendingJoinComp.shares_leads);
  // v8.12.0 — A STAFF MEMBER JOINING AN EVENT WHERE STAFF COMPETE IS ENROLLING AS
  // A COMPETITOR, and that is not what scanning a QR usually means for them (on
  // every other event it is a spectator's shortcut). Said before it happens: the
  // row puts them on the board AND locks them out of editing the event and every
  // challenge in it until they remove themselves. Declining is a deliberate
  // departure, so the stored token goes too — otherwise the next boot asks again.
  if(S.isUserStaff&&S._pendingJoinComp&&S._pendingJoinComp.staff_compete){
    const nm=S._pendingJoinComp.name||'this event';
    const ok=await showModal({
      title:'Compete in this event?',
      message:`<strong>${esc(nm)}</strong> lets staff compete. Joining enrols you as a <strong>competitor</strong>: you will be on its leaderboard, and you will not be able to edit the event or any challenge assigned to it until you remove yourself from it.`,
      confirmText:'Join and compete',confirmClass:'',cancelText:'Not now'
    });
    if(!ok){
      S._pendingJoinToken='';S._pendingJoinComp=null;_renderJoinBanner();
      clearStoredJoin(tok);
      return null;
    }
  }
  try{
    const r=await fetch('/api/competitions/join',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({token:tok})});
    const d=await r.json().catch(()=>({}));
    S._pendingJoinToken='';S._pendingJoinComp=null;_renderJoinBanner();
    if(!r.ok){
      // v8.12.0 — the AUTHOR refusal is permanent for as long as the challenge
      // is assigned, so the stored join is purged like a 404's: kept, it would
      // re-ask "Compete in this event?" at every boot for a question the server
      // is certain to refuse. Every other refusal keeps the stored copy (a 429
      // mid-event must not cost the recovery, v7.16.4).
      // v8.12.6 — `late_entry_took_part` is the same kind of answer: somebody
      // who took part in the event before it ended cannot rejoin it as a late
      // entrant, and that cannot change while the window stays open (the event
      // is over, and so is their part in it). Kept, the stored join would retry
      // the same refusal at every boot. The server's sentence is shown verbatim
      // below — it is worded to the person.
      if(d.code==='staff_compete_author_competes'||d.code==='late_entry_took_part')clearStoredJoin(tok);
      showToast(d.error||'Could not join the event.','error');return null;
    }
    // v8.12.0 — a staff member let into an event where staff do NOT compete was
    // not enrolled (the server wrote no row); they can still enter it. Say so,
    // or "joined" reads as "on the board". The outcome is exposed to the caller
    // (`S._lastJoinSpectator`) so the typed-code path does not ALSO announce a
    // join the same answer says did not happen.
    S._lastJoinSpectator=!!d.staffSpectator;
    if(d.staffSpectator)showToast('You can enter this event as staff. Staff do not compete in it, so you have not been enrolled.','info');
    // A signed-in participant joins with no card in between, so the notice comes with the join.
    else if(shares)showToast(LEAD_NOTICE,'info');
    // v7.22.8 — the join SUCCEEDED (or was already a member): the persisted
    // token has served its purpose. Purging here — and only on success — is
    // what keeps a later admin REMOVAL from being silently undone by a
    // lingering stored token on the participant's next visit. A refusal keeps
    // the stored copy: a 429 mid-event must not cost the recovery, and a
    // genuinely dead token is purged by the next boot's preview 404 anyway.
    clearStoredJoin(tok);
    return d.competitionId||null;
  }catch(_){S._pendingJoinToken='';S._pendingJoinComp=null;_renderJoinBanner();showToast('Could not join the event.','error');return null;}
}

export async function enterAfterJoin(compId){
  try{const me=await fetch('/api/me');if(me.ok)S.currentUser=await me.json();}catch(e){console.warn('Could not refresh your account',e);}
  S.myCompetitions=S.currentUser&&S.currentUser.competitions?S.currentUser.competitions:[];
  const result=await selectCompetition(compId);
  if(result==='needsTimeslot'){showTimeslotPicker();return;}
  if(result===false){showMain('competitions-page');return;}
  // v8.1.0 (PR 14) — this fork had a THIRD arm falling through to the picker for
  // a status that was neither live/ended nor upcoming/pending. It is unreachable
  // and is stated rather than silently dropped: the only producers of this value
  // are timeslotStatus and competitionStatus, and both return exactly
  // upcoming | live | ended. Anything outside that set now lands on the pending
  // page instead of the picker.
  const verdict=routeVerdict(result);
  if(verdict==='enter'){showMain('tasks-page');enterCompetitionView();}
  else{showPendingPageForCompetition();}
}

export function _ensureQrLib(){
  if(window.qrcode)return Promise.resolve();
  if(S._qrLibPromise)return S._qrLibPromise;
  S._qrLibPromise=new Promise((resolve,reject)=>{
    const s=document.createElement('script');
    const rawUrl=window.__assetUrlWithVersion?window.__assetUrlWithVersion('/vendor/qrcode.min.js'):'/vendor/qrcode.min.js';
    // TT-safe: under `require-trusted-types-for 'script'` a plain string
    // assigned to script.src throws (it's a TrustedScriptURL sink). The
    // vendor-script-src policy allowlists this exact path; on browsers
    // without Trusted Types the raw string works directly.
    s.src=_ttVendorScriptPolicy?_ttVendorScriptPolicy.createScriptURL(rawUrl):rawUrl;
    s.onload=()=>resolve();
    s.onerror=()=>{S._qrLibPromise=null;reject(new Error('qr load failed'));};
    document.head.appendChild(s);
  });
  return S._qrLibPromise;
}

export function _renderQrInto(el,text){
  if(!el)return;
  el.textContent='';
  try{
    const qr=window.qrcode(0,'M');qr.addData(text);qr.make();
    const n=qr.getModuleCount();
    const cell=4,margin=4*cell,size=n*cell+margin*2;
    const NS='http://www.w3.org/2000/svg';
    const svg=document.createElementNS(NS,'svg');
    svg.setAttribute('viewBox',`0 0 ${size} ${size}`);
    svg.setAttribute('width',String(size));svg.setAttribute('height',String(size));
    svg.setAttribute('role','img');svg.setAttribute('aria-label','Self-enrollment QR code');
    const bg=document.createElementNS(NS,'rect');
    bg.setAttribute('x','0');bg.setAttribute('y','0');bg.setAttribute('width',String(size));bg.setAttribute('height',String(size));bg.setAttribute('fill','#ffffff');
    svg.appendChild(bg);
    let d='';
    for(let r=0;r<n;r++)for(let c=0;c<n;c++){if(qr.isDark(r,c)){const x=margin+c*cell,y=margin+r*cell;d+=`M${x},${y}h${cell}v${cell}h${-cell}z`;}}
    const path=document.createElementNS(NS,'path');
    path.setAttribute('d',d);path.setAttribute('fill','#000000');
    svg.appendChild(path);
    el.appendChild(svg);
  }catch(_){el.textContent='QR unavailable';}
}

// ── THE EVENT JOIN QR — the event code ALWAYS in its centre ─────────────────
//
// Operator rule: every join QR the organiser is shown or downloads carries the
// event's short code in its middle. There is ONE encoder for that (lib/qr.js,
// level H with a reserved centre), reached through POST /api/admin/join-qr; the
// Join Link dialog, its download, the workspace join pill and its full-screen
// view all ask it here. The vendored level-M library above stays only as the
// preview's fallback when that request fails (a scanner block, a 429): a plain
// QR still admits people, and a blank box would not.
const _JOIN_QR_LABEL_RE=/^[A-Z0-9][A-Z0-9-]{0,15}$/;

/** The join QR (event code in the centre) as an SVG data URI, or null. */
export async function joinQrDataUri(text,label){
  if(typeof text!=='string'||!text)return null;
  const body={text};
  const l=String(label||'').toUpperCase();
  if(_JOIN_QR_LABEL_RE.test(l))body.label=l;
  let r=null;
  try{r=await fetch('/api/admin/join-qr',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(body)});}catch(_){r=null;}
  if(!r||!r.ok)return null;
  const svg=await r.text().catch(()=>'');
  if(!svg.startsWith('<svg'))return null;
  // SVG text -> base64 (UTF-8 safe); `img-src` admits data: URIs.
  const b64=btoa(Array.from(new TextEncoder().encode(svg),(x)=>String.fromCharCode(x)).join(''));
  return `data:image/svg+xml;base64,${b64}`;
}

/**
 * Paint the join QR into `el`. Each call takes a ticket on the element, so a
 * slower answer for an older link (open, then Regenerate) never paints over a
 * newer one. Resolves true when the centred-code QR was drawn.
 */
export async function _renderJoinQrInto(el,text,label){
  if(!el)return false;
  const tok=el._joinQrTok=(el._joinQrTok||0)+1;
  const src=await joinQrDataUri(text,label);
  if(el._joinQrTok!==tok)return false;
  if(src){
    const img=document.createElement('img');
    img.src=src;img.decoding='async';img.className='se-qr-img';
    const l=String(label||'').toUpperCase();
    img.alt=_JOIN_QR_LABEL_RE.test(l)?`QR code for the join link, with the code ${l} in its centre`:'QR code for the join link';
    el.replaceChildren(img);
    return true;
  }
  try{await _ensureQrLib();if(el._joinQrTok===tok)_renderQrInto(el,text);}catch(_){if(el._joinQrTok===tok)el.textContent='QR unavailable';}
  return false;
}

// High-res QR download. The SAME centred-code SVG the dialog shows, drawn onto
// a 1200 px canvas and saved as a PNG for print (an SVG data URI draws to a
// canvas without tainting it). No fallback to the plain QR here: a printed sign
// must carry the code (operator rule), so a failed request says so instead.
const _QR_PNG_PX=1200;
async function _buildJoinQrPng(text,label){
  const src=await joinQrDataUri(text,label);
  if(!src)return null;
  const img=new Image();
  img.src=src;
  await img.decode();
  const canvas=document.createElement('canvas');
  canvas.width=_QR_PNG_PX;canvas.height=_QR_PNG_PX;
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,_QR_PNG_PX,_QR_PNG_PX);
  ctx.drawImage(img,0,0,_QR_PNG_PX,_QR_PNG_PX);
  return new Promise((resolve)=>{if(canvas.toBlob)canvas.toBlob(resolve,'image/png');else resolve(null);});
}

function _seQrFilename(name){
  const slug=String(name||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);
  return `join-qr-${slug||'event'}.png`;
}

export async function _downloadSelfEnrollQr(overlay){
  const st=overlay&&overlay._seState;
  const text=st&&st.url;
  if(!text){showToast('Nothing to download yet.','error');return;}
  try{
    const blob=await _buildJoinQrPng(text,st.joinCode);
    if(!blob){showToast('Could not generate the QR image.','error');return;}
    downloadBlob(blob,_seQrFilename(st.name));
    showToast('QR code ready.','success');
  }catch(_){showToast('Could not generate the QR image.','error');}
}

/**
 * Copy the short join code.
 *
 * A separate action from the link copy rather than a shared one taking an id:
 * the two carry different things (a URL and six characters), the toast has to
 * say which, and `_copySelfEnrollLink`'s `input.select()` fallback needs a real
 * `<input>` — the code is rendered as text, so the fallback path differs too.
 */
export function _copySelfEnrollCode(overlay){
  // v8.12.6 — read from the dialog the button is IN (see openSelfEnrollOverlay).
  const el=(overlay||document).querySelector('#self-enroll-code');
  const text=el?el.textContent.trim():'';
  if(!text)return showToast('No code to copy.','error');
  const clip=(window.isSecureContext!==false)&&navigator.clipboard&&typeof navigator.clipboard.writeText==='function'
    ?navigator.clipboard.writeText(text):Promise.reject(new Error('clipboard unavailable'));
  clip.then(()=>showToast('Code copied to clipboard.','success'))
      .catch(()=>showToast(`Could not copy — the code is ${text}`,'error'));
}

export function _copySelfEnrollLink(overlay){
  const input=(overlay||document).querySelector('#self-enroll-input');
  const text=input?input.value:'';
  const clip=(window.isSecureContext!==false)&&navigator.clipboard&&typeof navigator.clipboard.writeText==='function'
    ?navigator.clipboard.writeText(text):Promise.reject(new Error('clipboard unavailable'));
  clip.then(()=>showToast('Link copied to clipboard.','success'))
      .catch(()=>{try{if(input){input.select();document.execCommand('copy');}showToast('Link copied.','success');}catch(_){showToast('Could not copy — please select and copy manually.','error');}});
}

// v8.2.3 — the address a human is asked to TYPE off a sign, so the scheme goes.
// The value is the server's BASE_URL (see the reveal route); `location.origin` is
// the fallback for the one case where an older response reaches a newer client.
// A path is kept if there is one — a deployment mounted under a sub-path is
// reachable only WITH it, so dropping it would print an address that 404s.
function _siteHost(url){
  return String(url||window.location.origin).replace(/^https?:\/\//i,'').replace(/\/+$/,'');
}

// Reflect the enabled/inactive state in the dialog: show the "inactive" note +
// mark the link, the QR and the code as inactive when self-enrollment is OFF, so
// an admin never puts a link or a code on signage that silently won't work.
// Called on open and after every enabled-toggle.
//
// v8.12.6 (review) — AND EVERY SENTENCE THAT IS TRUE ONLY IN ONE OF THE TWO STATES
// is toggled with it (`.se-on-only` / `.se-off-only`). The late-entry note said the
// link "keeps working until <deadline>" whatever the switch said — the late-entry
// window does not depend on it, but every join door refuses a disabled link — so a
// disabled link on an event taking late entries was described as working, beside
// the note saying it was inactive: the dead-link-on-signage defect v7.7.8 added the
// inactive note to prevent, reintroduced by a positive claim next to it.
function _seRenderEnabledState(overlay,enabled){
  if(!overlay)return;
  const card=overlay.querySelector('.self-enroll-card');
  if(card)card.classList.toggle('se-inactive',!enabled);
  const note=overlay.querySelector('#self-enroll-inactive-note');
  if(note)note.style.display=enabled?'none':'';
  overlay.querySelectorAll('.se-on-only').forEach(el=>{el.style.display=enabled?'':'none';});
  overlay.querySelectorAll('.se-off-only').forEach(el=>{el.style.display=enabled?'none':'';});
}

// v8.12.6 — THE DIALOG SHOWS THE EVENT YOU OPENED IT FOR. The opener awaits the
// reveal and only then builds the dialog, so opening the Join Link for event A
// and then B (A's reveal slow) used to stack TWO #self-enroll-overlay elements —
// and every control was bound with document.getElementById, which returns the
// FIRST one. Measured: the dialog titled B showed A's QR, and ticking "Enable
// self-enrollment" in it sent a PUT to B AND to A, so the server enabled a join
// link on an event nobody had touched. Three rules, one per part of that:
//   * the LATEST open wins (`_seOpenSeq`, taken before the await, re-checked
//     after it and after the parse — a superseded open says nothing at all);
//   * any dialog already showing is removed AFTER the await, never before, so a
//     slow reveal cannot leave the admin looking at nothing;
//   * every control, listener and the QR is found through THIS overlay
//     (`overlay.querySelector`), never the document, so even two dialogs could
//     not reach into each other.
let _seOpenSeq=0;

export async function openSelfEnrollOverlay(compId,compName){
  const seq=++_seOpenSeq;
  let data;
  try{
    const r=await fetch(`/api/admin/competitions/${encodeURIComponent(compId)}/self-enroll`);
    if(seq!==_seOpenSeq)return;
    if(!r.ok){showToast('Could not load the self-enrollment link.','error');return;}
    data=await r.json();
  }catch(_){if(seq===_seOpenSeq)showToast('Could not load the self-enrollment link.','error');return;}
  if(seq!==_seOpenSeq)return;   // re-checked post-parse (headers != settle, v7.15.15)
  document.querySelectorAll('#self-enroll-overlay').forEach(o=>o.remove());
  // v8.12.0 — READ-ONLY FOR A COMPETITOR. The reveal is a read, so a competitor
  // may open this dialog and copy the link, the QR and the code for their own
  // event; the toggle and Regenerate are WRITES the server refuses
  // (`competitor_cannot_edit`), so they are withheld with the reason rather than
  // offered where the save is certain to fail (v7.14.2). `competing` comes off
  // the admin list row the kebab rendered from — the server's own flag.
  const _row=(S.adminCompetitionsData||[]).find(c=>c.id===compId)||{};
  const _competing=!!_row.competing;
  // v8.12.6 — THE DIALOG IS OFFERED THROUGH A LATE-ENTRY WINDOW (the link keeps
  // working until the late-entry deadline, and the organiser needs it on the
  // signage), and the event has ENDED by then. Its toggle saves through the
  // competition edit, which refuses anybody but a superadmin on an ended event
  // whose end has passed ("Only superadmin can edit ended events…") — so for
  // everybody else it is rendered DISABLED with that reason rather than
  // offered and refused (v7.14.2). Regenerate is a separate route that does not
  // refuse an ended event, so it stays. `endedButFuture` mirrors the Events-row
  // Edit gate, which mirrors the server's: all three compare the EFFECTIVE end,
  // and for an event closed early that is its `ended_at`, not the original
  // schedule — so on an ended event the clause is in practice false, and inside
  // a late-entry window (which opens only after the end) always. It is kept so
  // the dialog and the Events row can never disagree about who may edit.
  const _late=isLateEntryOpen(_row);
  const _endedButFuture=computeCompStatus(_row)==='ended'&&_row.effective_end&&new Date(_row.effective_end)>new Date();
  const _endedLocked=!_competing&&!!_row.id&&computeCompStatus(_row)==='ended'&&!S.isSuperAdmin&&!_endedButFuture;
  const _lateDeadline=_late&&_row.late_entry_deadline_effective?fmtDt(_row.late_entry_deadline_effective,'long'):'';
  // v8.12.8 — the late note names the way to close the window early, OUTSIDE
  // both the enabled-only and the disabled-only spans (it is true either way),
  // and only from the server's `can_close_late_entries`: a competitor opens this
  // dialog read-only and is exactly the reader that control is withheld from.
  // RBAC — the toggle saves through the event edit (PUT …/competitions/:id,
  // `events.edit`); the dialog itself, its copies and Regenerate are
  // `events.join_link`. A role without the edit gets it disabled, with why.
  const _noEdit=!_competing&&!adminCan('events.edit');
  const _toggleDisabled=_competing
    ?'disabled aria-describedby="self-enroll-competing-note"'
    :_noEdit?'disabled aria-describedby="self-enroll-perm-note"'
    :_endedLocked?'disabled aria-describedby="self-enroll-ended-note"':'';
  const overlay=document.createElement('div');
  overlay.id='self-enroll-overlay';
  overlay._seState={compId,updatedAt:data.updated_at||null,url:data.url,name:compName||'',joinCode:data.join_code_display||'',competing:_competing};
  setSafeHtml(overlay,`<div class="card self-enroll-card" role="dialog" aria-modal="true" aria-labelledby="self-enroll-title">
    <h3 id="self-enroll-title" class="modal-title">Self-enrollment link${compName?` — ${esc(compName)}`:''}</h3>
    <p class="self-enroll-hint">Anyone with this link can join this event. New people who register through it <strong>skip the approval queue</strong>. Disable it when your event is over, and regenerate it if the link or its short code leaks — that replaces both.</p>
    ${_competing?`<p class="self-enroll-competing-note" id="self-enroll-competing-note" role="status">${ICO.lock} You are competing in this event, so its settings cannot be changed from here — the link, QR code and short code are shown for copying only. Ask another organiser to change the self-enrollment settings or regenerate the link.</p>`:''}
    ${_noEdit?`<p class="self-enroll-competing-note" id="self-enroll-perm-note" role="status">${ICO.lock} Your role can show, copy and regenerate this link, not turn self-enrollment on or off.</p>`:''}
    ${_late?`<p class="self-enroll-late-note" id="self-enroll-late-note" role="status"><span class="se-on-only">This event has ended, but it is still taking <strong>late entries</strong>: the link, QR code and short code keep working${_lateDeadline?` until <strong>${esc(_lateDeadline)}</strong>`:' until the late-entry deadline'}, and anyone who joins through them now is a late entrant.</span><span class="se-off-only">This event has ended, but it is still taking <strong>late entries</strong>${_lateDeadline?` until <strong>${esc(_lateDeadline)}</strong>`:''}. The link, QR code and short code will admit late entrants only once <strong>Enable self-enrollment</strong> is on${_endedLocked?', which only a superadmin can turn on now':''}.</span>${_row.can_close_late_entries?' To stop taking late entries sooner, use <strong>Close late entries now</strong> on the event’s menu.':''}</p>`:''}
    ${_endedLocked?`<p class="self-enroll-competing-note" id="self-enroll-ended-note" role="status">${ICO.lock} The event has ended, so only a superadmin can change this setting now.</p>`:''}
    <div class="self-enroll-toggles">
      <label class="checkbox-row"><input type="checkbox" id="self-enroll-enabled" ${data.enabled?'checked':''} ${_toggleDisabled}/> <span>Enable self-enrollment</span></label>
    </div>
    <p class="self-enroll-inactive-note" id="self-enroll-inactive-note" role="status">This link, its QR code <strong>and the short code below</strong> are <strong>inactive</strong> until <strong>Enable self-enrollment</strong> above is turned on — people who use them now are sent to the sign-up page but <strong>won't be enrolled</strong> in this event.</p>
    <div class="reset-link-field self-enroll-field">
      <input id="self-enroll-input" type="text" value="${esc(data.url)}" readonly aria-label="Self-enrollment link"/>
      <div class="reset-link-actions-inline">
        <button class="btn sm" data-action="self-enroll-copy" aria-label="Copy self-enrollment link">Copy</button>
      </div>
    </div>
    <div class="self-enroll-qr" id="self-enroll-qr"></div>
    <p class="self-enroll-qr-hint">Scan to join from a phone.</p>
    ${data.join_code_display ? `<div class="self-enroll-code" id="self-enroll-code-box">
      <p class="self-enroll-code-label">Or go to <strong>${esc(_siteHost(data.site_url))}</strong> and enter this code:</p>
      <div class="self-enroll-code-row">
        <span class="self-enroll-code-value" id="self-enroll-code">${esc(data.join_code_display)}</span>
        <button class="btn sm secondary" data-action="self-enroll-copy-code" aria-label="Copy code — the short join code ${esc(data.join_code_display)}">Copy code</button>
      </div>
      <p class="self-enroll-code-hint">Put the address and the code on your signage, for anyone whose camera will not focus. Someone new enters it on the sign-up page; someone who already has an account enters it on their events list.<span class="se-on-only"> ${_late?'It stops working when late entry closes.':'It stops working when the event does.'}</span> Regenerating the link replaces it.</p>
    </div>` : ''}
    <div class="self-enroll-qr-actions">
      <button class="btn sm secondary" data-action="self-enroll-download-qr" aria-label="Download QR (PNG) — high-resolution image of the join link">Download QR (PNG)</button>
    </div>
    <div class="self-enroll-footer">
      ${_competing?'':`<button class="btn secondary" data-action="self-enroll-regenerate">Regenerate link</button>`}
      <button class="btn" data-action="self-enroll-close">Close</button>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  overlayDismiss(overlay,()=>overlay.remove());
  _seRenderEnabledState(overlay,!!data.enabled);
  overlay.querySelector('#self-enroll-enabled')?.addEventListener('change',e=>_selfEnrollToggle(overlay,'self_enroll_enabled',e.target));
  _renderJoinQrInto(overlay.querySelector('#self-enroll-qr'),overlay._seState.url,overlay._seState.joinCode);
  setTimeout(()=>overlay.querySelector('#self-enroll-input')?.focus(),0);
}

export async function _selfEnrollToggle(overlay,field,cbEl){
  const st=overlay&&overlay._seState;if(!st)return;
  const desired=cbEl.checked;
  try{
    const r=await fetch(`/api/admin/competitions/${encodeURIComponent(st.compId)}`,{method:'PUT',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({[field]:desired,expectedUpdatedAt:st.updatedAt})});
    const d=await r.json().catch(()=>({}));
    if(r.status===409){cbEl.checked=!desired;showToast('This event changed in another tab. Close and reopen the link dialog.','error');return;}
    if(!r.ok){cbEl.checked=!desired;showToast(d.error||'Could not update setting.','error');return;}
    if(d.competition&&d.competition.updated_at)st.updatedAt=d.competition.updated_at;
    if(field==='self_enroll_enabled')_seRenderEnabledState(overlay,desired);
    const msg=desired?'Self-enrollment enabled — the link is now live.':'Self-enrollment disabled — the link is now inactive, and sign-in codes already emailed through it no longer join anyone to this event.';
    showToast(msg,'success');
    if(typeof loadAdminCompetitions==='function')loadAdminCompetitions();
  }catch(_){cbEl.checked=!desired;showToast('Could not update setting.','error');}
}

export async function regenerateSelfEnroll(overlay){
  const st=overlay&&overlay._seState;if(!st)return;
  const ok=await showModal({title:'Regenerate link',message:'Regenerate the self-enrollment link and its short code? The current link, QR code and short code will all stop working immediately — reprint any signage that shows them. Sign-in codes already emailed through the current link still sign people in, but no longer join them to this event.',confirmText:'Regenerate',confirmClass:'danger'});
  if(!ok)return;
  try{
    const r=await fetch(`/api/admin/competitions/${encodeURIComponent(st.compId)}/self-enroll/regenerate`,{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({expectedUpdatedAt:st.updatedAt})});
    const d=await r.json().catch(()=>({}));
    if(r.status===409){showToast('This event changed in another tab. Close and reopen the link dialog.','error');return;}
    if(!r.ok){showToast(d.error||'Could not regenerate the link.','error');return;}
    st.url=d.url;st.updatedAt=d.updated_at||st.updatedAt;
    // v8.12.6 — THIS dialog's field and QR. By the time the regenerate answers,
    // the admin may have closed it and opened another event's Join Link; the
    // document's first #self-enroll-input is then that event's, and it used to
    // receive this event's new link and QR.
    const input=overlay.querySelector('#self-enroll-input');if(input)input.value=d.url;
    // v8.13.3 — the short code is rotated with the link, so the code printed in
    // THIS dialog (and its copy control's name) must move with it.
    const codeEl=overlay.querySelector('#self-enroll-code');
    if(d.join_code_display){
      st.joinCode=d.join_code_display;
      if(codeEl)codeEl.textContent=d.join_code_display;
      overlay.querySelector('[data-action="self-enroll-copy-code"]')?.setAttribute('aria-label',`Copy code — the short join code ${d.join_code_display}`);
      showToast('Link regenerated, with a new short code. The old link, QR code and code no longer work.','success');
    }else{
      // No code could be minted (practically unreachable): HIDE the box rather
      // than leave the old, now-dead code on screen with a working Copy button.
      st.joinCode='';
      if(codeEl)codeEl.textContent='';
      const box=overlay.querySelector('#self-enroll-code-box');if(box)box.hidden=true;
      showToast('Link regenerated. The old link, QR code and code no longer work — reopen this dialog for a new short code.','success');
    }
    // The QR carries the code in its centre, so it is redrawn once the code moved.
    _renderJoinQrInto(overlay.querySelector('#self-enroll-qr'),d.url,st.joinCode);
    // Every other copy of the old link on screen stopped working too: the event
    // workspace's join pill, popover, walk-up card and full-screen QR take the
    // new one from this.
    document.dispatchEvent(new CustomEvent('admin:join-link-rotated',{detail:{compId:st.compId,url:d.url,join_code_display:st.joinCode}}));
  }catch(_){showToast('Could not regenerate the link.','error');}
}

// ── v8.3.1 — THE EVENT-CODE DIALOG ──────────────────────────────────────────
//
// v8.2.3 put the entry inline on the login card, which was the right screen and
// the wrong shape: it grew the busiest surface for the minority carrying a code,
// and left the flow with nowhere to explain itself. A dialog gives it three
// things an inline box could not have — room to say WHICH event was matched
// before anyone types a password, a deliberate order (sign UP first, because the
// walk-up this exists for has no account), and a way OUT of a code that was
// scanned or typed by mistake.
function _eventCodeBody(comp){
  if(!comp){
    return `<p class="picker-note">Six characters from the event signage — letters and digits, and it is not fussy about case or about <code>O</code>/<code>0</code>.</p>
      <div class="join-code-box" style="margin:0">
        <label for="ec-code">Event code</label>
        <div class="join-code-row">
          <input id="ec-code" type="text" inputmode="latin" autocapitalize="characters" autocomplete="off"
                 spellcheck="false" maxlength="12" placeholder="ABC-123" data-enter-action="event-code-apply"/>
          <button type="button" class="btn" data-action="event-code-apply">Find event</button>
        </div>
      </div>`;
  }
  // Resolved: name the event, then ONE door — the email step, which signs in an
  // account or starts a new one, and carries the event either way.
  return `<p class="picker-note">You are joining <strong>${esc(comp.name)}</strong>.</p>
    <div class="event-code-actions">
      <button class="btn" data-action="event-code-signin">Continue with my email</button>
    </div>
    <p class="picker-note event-code-discard-note">Not the right event?
      <a href="#" data-action="event-code-discard">Forget this code and continue without it</a>.</p>`;
}

function _renderEventCodeDialog(){
  const overlay=document.getElementById('event-code-overlay');
  if(!overlay)return;
  const comp=S._pendingJoinToken?S._pendingJoinComp:null;
  setSafeHtml(overlay,`<div class="picker-modal picker-modal-flow" role="dialog" aria-modal="true" aria-labelledby="ec-title">
    <div class="picker-modal-head"><h3 id="ec-title">${comp?'Joining an event':'Have an event code?'}</h3></div>
    ${_eventCodeBody(comp)}
    <div class="picker-modal-foot">
      <button class="btn secondary" data-action="overlay-close" data-overlay-id="event-code-overlay">${comp?'Close':'Cancel'}</button>
    </div>
  </div>`);
  setTimeout(()=>{ (document.getElementById('ec-code')||overlay.querySelector('.btn'))?.focus(); },0);
}

export function openEventCodeDialog(){
  if(document.getElementById('event-code-overlay'))return;
  const overlay=document.createElement('div');
  overlay.id='event-code-overlay';
  overlay.className='picker-overlay';
  document.body.appendChild(overlay);
  overlayDismiss(overlay,()=>overlay.remove());
  _renderEventCodeDialog();
}

export async function eventCodeApply(){
  const input=document.getElementById('ec-code');
  const raw=input?input.value.trim():'';
  if(!raw){showToast('Enter the code from the event signage.','error');input?.focus();return;}
  const res=await _resolveJoinCode(raw,input);
  if(!res)return;                       // _resolveJoinCode owns every refusal's copy
  S._pendingJoinToken=res.token;S._pendingJoinComp=res.comp;
  storePendingJoin(res.token,res.comp);
  _renderJoinBanner();
  _renderEventCodeDialog();             // same dialog, second state — no second overlay
}

export function eventCodeSignin(){
  document.getElementById('event-code-overlay')?.remove();
  showPage('login-page');
  document.getElementById('login-email')?.focus();
}

// "Clear it and stay, as a normal sign-up" (operator's choice). The stored token
// is purged as well as the in-memory one, or the boot rehydration would hand it
// straight back on the next load and the discard would read as broken.
// The page forgets the event (features/auth.js `leaveJoinedEvent` unties a code
// already emailed with it first). `codeSent`: a code went out with the event,
// so the toast says it still signs in, now without joining.
export function eventCodeDiscard({ codeSent = false } = {}){
  const tok=S._pendingJoinToken;
  S._pendingJoinToken='';S._pendingJoinComp=null;
  clearStoredJoin(tok);
  S._arrivedViaJoin=false;
  _renderJoinBanner();
  document.getElementById('event-code-overlay')?.remove();
  // Stays on the page it was opened from (the email step, or a sign-up form
  // whose typed details must survive).
  showToast(codeSent
    ? 'Event cleared — you are continuing without an event. The code we already emailed you still signs you in, without joining it.'
    : 'Event cleared — you are continuing without an event.','success');
}
