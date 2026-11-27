"use strict";

import { S } from "../core/state.js";
import { csrfHeaders, loadCsrfToken, adoptNewSessionToken, postWithCsrfRetry, fetchJsonObject } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { COUNTRY_TZ, autoDetectCountryTz, updateTimezones, autoFillDialCode, _preserveUnlistedOption } from "../data/country-tz.js";
import { computeCompStatus, selectCompetition, showPendingApprovalPage, showPendingPageForCompetition, showTimeslotPicker } from "./competition-picker.js";
import { startAdminCompPoll } from "./competitions-admin.js";
import { refreshScore } from "./participant-tasks.js";
import { clearStoredJoin, enterAfterJoin, joinViaPendingToken, eventCodeDiscard } from "./self-enroll.js";
import { signOutThisBrowser, startSessionMonitor } from "./session-monitor.js";
import { esc } from "../ui/format.js";
import {
  avatarPickerHtml, wireAvatarPicker, selectAvatarIn,
  profileFieldsHtml, profileFieldIds, profileChangedFields,
  jobFunctionSelectHtml, personalTitleSelectHtml,
  JOB_FUNCTION_PRESETS as _JFP, PERSONAL_TITLE_PRESETS as _PTP,
  toBase64 as _toBase64, downscaleImageFile as _downscale, AVATAR_UPLOAD_MAX_PX as _AVMAX, markFieldError, REQUIRED_FIELDS} from "../ui/profile-form.js";
import { installOverlayFocusTrap, overlayDismiss, showModal } from "../ui/modal.js";
import { buildAdminNav, buildParticipantNav, enterCompetitionView, refreshAccountHeader, routeVerdict, showMain, showPage } from "../ui/nav.js";
import { showToast } from "../ui/toast.js";

// v7.2.x (ext-audit F1) — nicknames are printable-ASCII only (mirrors the
// server's _nicknameCharsOk), so the COLLATE NOCASE uniqueness index is a
// complete case-insensitive guarantee (NOCASE folds ASCII only). Names stay
// Unicode; the nickname is a leaderboard handle.
export const NICKNAME_RE = /^[\x20-\x7E]+$/;
export const NICKNAME_CHARSET_MSG = "Nickname may only contain standard (ASCII) letters, numbers, and symbols — no accented or non-Latin characters.";

// ── Sign-in ──────────────────────────────────────────────────────────────────
//
// ONE ENTRY SCREEN, EMAIL FIRST. The card asks for an address and Continue then
// asks the server which step it gets (POST /api/auth/sign-in-method):
//   • an account that signs in with a PASSWORD (by default every unscoped admin;
//     anyone may choose it in their profile) — the password box appears on the
//     card, Continue becomes "Sign in", and "Email me a code instead" sits below
//     it (a code always works, so a forgotten password is never a dead end);
//   • every other address — the code step: redeeming the code either signs the
//     account in or, for an address with no account, answers `needsProfile` and
//     the sign-up form opens with that (now proven) address.
// Anything typed that is NOT an address gets the password box alone, with no
// code button: the built-in superadmin's username is the only such name, and
// every non-address gets the same step, so the card never confirms the name.

/** The free-mail reminder under the email box, from the TYPED text. Not for the
 *  address an open invitation names: the invitation rides the code request, and
 *  the server lets it start an account whatever its domain. */
export function syncLoginEmailHint(){
  const v=(document.getElementById('login-email')?.value||'').trim();
  const hint=document.getElementById('login-email-hint');
  const invited=!!(S._regInvitationId&&S._regInvitation&&typeof S._regInvitation.email==='string'
    &&S._regInvitation.email.trim().toLowerCase()===v.toLowerCase());
  if(hint)hint.hidden=invited||!(v.includes('@')&&isFreeEmailClient(v));
  // The password step belongs to the name it was opened for: editing the box
  // goes back to the address step.
  if(S._loginPwFor!=null&&v!==S._loginPwFor)resetLoginStep();
}

/**
 * "Busy — retrying…" while a door waits for a sign-in token the server is
 * rate-limiting (core/api.js `_ensureToken`, the `ha:csrf-busy` event). Shown in
 * whichever sign-in surface is open; cleared when the wait ends.
 */
export function paintCsrfBusy(on){
  const box=document.getElementById('sc-error')||document.getElementById('sp-error')
    ||(document.getElementById('register-page')?.classList.contains('active')?document.getElementById('reg-error'):null)
    ||document.getElementById('login-error');
  if(!box)return;
  if(on){box.textContent='Busy — retrying…';box.dataset.busy='1';box.style.display='block';}
  else if(box.dataset.busy){delete box.dataset.busy;box.textContent='';box.style.display='none';}
}

const _LOGIN_SUB_DEFAULT="We'll email you a one-time code. No password.";
function _loginErr(msg){
  const err=document.getElementById('login-error');
  if(err){err.textContent=msg;err.style.display='block';}
}

/** Back to the address step: no password box, Continue, the card's own subtitle. */
export function resetLoginStep(){
  S._loginPwFor=null;
  const g=document.getElementById('login-password-group');
  if(g)g.hidden=true;
  const pw=document.getElementById('login-password');
  if(pw)pw.value='';
  const note=document.getElementById('login-password-note');
  if(note){note.hidden=true;note.textContent='';}
  const alt=document.getElementById('login-code-instead');
  if(alt)alt.hidden=true;
  const btn=document.getElementById('login-submit');
  if(btn)btn.textContent='Continue';
  const sub=document.getElementById('login-sub');
  if(sub)sub.textContent=_LOGIN_SUB_DEFAULT;
}

/**
 * The password step for `name`. `codeOffered` shows "Email me a code instead"
 * (never for a non-address); `passwordSet:false` is an account that has not set
 * its password yet, which is told to sign in with a code (it is then asked to
 * set one, or to keep using codes).
 */
function _showPasswordStep(name, opts){
  const o=opts||{};
  S._loginPwFor=name;
  const g=document.getElementById('login-password-group');
  if(g)g.hidden=false;
  const pw=document.getElementById('login-password');
  if(pw)pw.value='';
  const alt=document.getElementById('login-code-instead');
  if(alt)alt.hidden=!o.codeOffered;
  const btn=document.getElementById('login-submit');
  if(btn)btn.textContent='Sign in';
  const sub=document.getElementById('login-sub');
  if(sub)sub.textContent=o.codeOffered?'Enter your password, or have a code emailed to you.':'Enter your password.';
  const note=document.getElementById('login-password-note');
  if(note){
    const none=o.codeOffered&&o.passwordSet===false;
    note.hidden=!none;
    note.textContent=none?'This account has no password yet. Choose “Email me a code instead” to sign in, and you will be asked to set one.':'';
  }
  setTimeout(()=>{
    if(o.codeOffered&&o.passwordSet===false)alt?.focus();
    else pw?.focus();
  },0);
}

export async function doLogin(){
  const email=document.getElementById('login-email').value.trim();
  const err=document.getElementById('login-error');
  err.style.display='none';
  if(!email){
    _loginErr('Enter your email address.');
    document.getElementById('login-email')?.focus();
    return;
  }
  // The password step is open for THIS name: Continue is "Sign in".
  if(S._loginPwFor!=null&&S._loginPwFor===email){await passwordSignIn();return;}
  // Not an address: the password step, nothing asked (see the note above).
  if(!email.includes('@')){_showPasswordStep(email,{codeOffered:false});return;}
  if(!isValidEmailFormat(email)){
    _loginErr('Enter your email address.');
    document.getElementById('login-email')?.focus();
    return;
  }
  let r,d;
  try{
    r=await postWithCsrfRetry('/api/auth/sign-in-method',t=>({method:'POST',headers:{'X-CSRF-Token':t,'Content-Type':'application/json'},body:JSON.stringify({email})}));
    d=await r.json().catch(()=>({}));
  }catch(_){showToast('Could not reach the server — check your connection.','error');return;}
  if(!r.ok){
    _loginErr(r.status===429
      ? 'Too many requests from here just now. Wait a minute, then try again.'
      : r.status===503
        ? 'The site is busy right now. Wait a moment, then press Continue again.'
        : 'That did not go through — this page has been open a while. Try again.');
    if(r.status!==429)loadCsrfToken().catch(e=>console.warn('CSRF token refresh failed',e));
    return;
  }
  if(d&&d.ok&&d.method==='password'){
    _showPasswordStep(email,{codeOffered:d.code_offered!==false,passwordSet:d.password_set!==false});
    return;
  }
  await sendSignInCode(email);
}

/** "Email me a code instead": the code step for the address the password step is for. */
export async function loginCodeInstead(){
  const name=S._loginPwFor;
  if(!name||!name.includes('@'))return;
  await sendSignInCode(name);
}

/**
 * Sign in with the password step's password: an address through the account
 * door (POST /api/auth/password, 200 for every outcome — branch on `ok`), any
 * other name through the break-glass door (POST /api/login, 401 when refused).
 */
export async function passwordSignIn(){
  const name=S._loginPwFor;
  const pwEl=document.getElementById('login-password');
  const password=pwEl?.value||'';
  if(!name)return;
  if(!password){_loginErr('Enter your password.');pwEl?.focus();return;}
  const isAddress=name.includes('@');
  const url=isAddress?'/api/auth/password':'/api/login';
  const body=isAddress?{email:name,password}:{username:name,password};
  let r,d;
  try{
    r=await postWithCsrfRetry(url,t=>({method:'POST',headers:{'X-CSRF-Token':t,'Content-Type':'application/json'},body:JSON.stringify(body)}));
    d=await r.json().catch(()=>({}));
  }catch(_){_loginErr('Could not reach the server — check your connection.');return;}
  const tryAgain=()=>{if(pwEl){pwEl.value='';pwEl.focus();}};
  if(!r.ok){
    // v8.3.13 — name the real condition rather than a raw token.
    if(d.error==='csrf_invalid'||d.error==='session_cookie_blocked'){
      const err=document.getElementById('login-error');
      if(err){
        setSafeHtml(err,S._csrfBlocked
          ? `<strong>This site cannot start a session on this connection.</strong><br>${esc(S._csrfBlocked)}`
          : `<strong>Your sign-in session could not be established.</strong><br>Reload the page and try again. If it keeps happening, the site is being reached over a connection that cannot carry a secure cookie — tell your administrator.`);
        err.style.display='block';
      }
      return;
    }
    _loginErr(r.status===429?'Too many attempts just now. Wait a minute, then try again.':'Those details did not sign you in.');
    tryAgain();
    return;
  }
  if(!d.ok){
    if(d.error==='pending_approval'){resetLoginStep();showPendingApprovalPage();return;}
    if(d.error==='verify_by_code'){
      _loginErr('Confirm your email address first: choose “Email me a code instead” and enter the code we send. After that your password works.');
      return;
    }
    _loginErr('That password did not sign you in. Try again, or choose “Email me a code instead”.');
    tryAgain();
    return;
  }
  resetLoginStep();
  await finishSignIn(d);
}

/**
 * Everything a successful sign-in does, for every door: the account password,
 * the break-glass password, the code redemption and the sign-up form all answer
 * the same login-shaped payload (role, competitions, autoResumeCompetitionId,
 * missing_fields, and the account's sign-in method).
 */
export async function finishSignIn(d){
  await adoptNewSessionToken();
  S.userRole=d.userRole||'participant';
  S.roleInfo=d.role_info||null; // RBAC — the role itself (the account menu names a custom role)
  S.isUserStaff=!!d.isStaff;
  S.currentUser=d;
  // Clear any Help-drawer session memory carried over from an anonymous
  // view so the next `?` click opens the newly-logged-in role's guide.
  if(typeof S._helpLastDoc!=='undefined')S._helpLastDoc=null;
  startSessionMonitor();
  // An account that signs in with a password and has not set one (an admin's
  // default, before their first password) sets it now — or keeps using codes.
  if(d.password_required)await openPasswordRequiredPrompt(d);
  if(d.missing_fields?.length&&d.role!=='admin'){
    await openProfileCompletionGate(d.missing_fields);
    const freshMe=await fetch('/api/me').then(r=>r.ok?r.json():d).catch(()=>d);
    S.currentUser=freshMe;
  }
  if(d.role==='admin'){
    S.isAdmin=true;S.isSuperAdmin=!!d.isSuperAdmin;S.isEventAdmin=!!d.isEventAdmin;S.isAdminView=true;
    S.isBreakglass=d.isBreakglass===true;
    S.permissions=Array.isArray(d.permissions)?d.permissions:null; // RBAC — what the panel offers
    buildAdminNav();showMain('admin-page');startAdminCompPoll();
    return;
  }
  buildParticipantNav();
  refreshScore();
  // A participant signed in from a /join link: enrol + route into that
  // competition before the normal multi-competition flow. (A code bound to the
  // event has usually enrolled them already; the join is idempotent.)
  if(S._pendingJoinToken){
    const _jid=await joinViaPendingToken();
    if(_jid){await enterAfterJoin(_jid);return;}
  }
  const comps=d.competitions||[];
  // THE SERVER DECIDES WHERE A SIGN-IN LANDS (`applyAutoResumeToSession`,
  // lib/middleware.js, called at both doors) and arrives here as one answer.
  const autoId=d.autoResumeCompetitionId;
  if(autoId){
    S.myCompetitions=comps;
    const known=comps.find(c=>c.id===autoId);
    const result=await selectCompetition(autoId);
    if(result==='needsTimeslot'){
      showTimeslotPicker();
    }else if(result!==false){
      if(routeVerdict(result,known?computeCompStatus(known):undefined)==='enter'){
        showMain('tasks-page');enterCompetitionView();
      }else{
        showPendingPageForCompetition();
      }
    }else{
      // A resume the server then refuses lands on the event list, never nothing.
      showMain('competitions-page');
    }
  }else{
    S.myCompetitions=comps;
    showMain('competitions-page');
  }
}

export async function doLogout(){
  // One sign-out for both doors (session-monitor.js `signOutThisBrowser`).
  if(!(await signOutThisBrowser()))return;
  location.reload();
}

// The delegated `avatar-select` action. Registered once in main.js and serving
// both profile editors — see selectAvatarIn for why the deselect sweep is
// scoped to the grid that was clicked.
export const selectAvatar=selectAvatarIn;

export function resetRegForm(){
  // audit v7.7.33 (AL5) — reg-password/-password2 (v7.2.13), reg-city + reg-job-
  // function/-other (v7.x) were added after this list and never cleared, so a
  // second registration in the same tab kept the previous entry's password/city/
  // role prefilled. Clear them too.
  ['reg-first','reg-last','reg-email','reg-company','reg-title','reg-phone','reg-linkedin','reg-city'].forEach(id=>{
    const el=document.getElementById(id);if(el){el.value='';}
  });
  const city=document.getElementById('reg-city');if(city)delete city.dataset.auto; // re-enable timezone→city autofill
  const jf=document.getElementById('reg-job-function');if(jf)jf.value='';
  const jfOther=document.getElementById('reg-job-function-other');if(jfOther){jfOther.value='';jfOther.style.display='none';}
  const pt=document.getElementById('reg-personal-title');if(pt)pt.value='';
  const country=document.getElementById('reg-country');if(country)country.value='';
  const tz=document.getElementById('reg-tz');if(tz)setSafeHtml(tz, '<option value="">Select timezone...</option>');
  autoDetectCountryTz('reg-country','reg-tz',updateTimezones);
  autoFillDialCode('reg-country','reg-phone');
  // Detected location is ONE line; the pickers open only on "change", or when
  // nothing could be detected (then there is nothing to show but the question).
  const pick=document.getElementById('reg-location-pick');
  const chg=document.getElementById('reg-location-change');
  if(pick)pick.hidden=!!(country&&country.value);
  if(chg)chg.setAttribute('aria-expanded',String(!(pick&&pick.hidden)));
  paintRegLocation();
  document.getElementById('reg-error').style.display='none';
  document.getElementById('reg-form-actions').style.display='';
  const banner=document.getElementById('reg-invitation-banner');if(banner)banner.style.display='none';
  const titleEl=document.querySelector('#register-page h2');if(titleEl)titleEl.textContent='Create your account';
  // The invitation (if any) survives a reset: it rides the proof, and the
  // entry screen set it from the link.
}

/** The one-line location: "Mumbai time (Asia/Kolkata) · India". */
export function paintRegLocation(){
  const text=document.getElementById('reg-location-text');
  if(!text)return;
  const cc=document.getElementById('reg-country')?.value||'';
  const tz=document.getElementById('reg-tz')?.value||'';
  const cname=cc&&COUNTRY_TZ[cc]?(COUNTRY_TZ[cc].n||cc):'';
  if(!cc||!tz){text.textContent='Choose your country and timezone';return;}
  const place=(tz.split('/').pop()||tz).replace(/_/g,' ');
  text.textContent=`${place} time (${tz}) · ${cname}`;
}

export function regLocationChange(){
  const pick=document.getElementById('reg-location-pick');
  const chg=document.getElementById('reg-location-change');
  if(!pick)return;
  pick.hidden=!pick.hidden;
  if(chg)chg.setAttribute('aria-expanded',String(!pick.hidden));
  if(!pick.hidden)document.getElementById('reg-country')?.focus();
}

export const FREE_PROVIDERS=['gmail.com','googlemail.com','hotmail.com','outlook.com','live.com','msn.com','yahoo.com','yahoo.co.uk','ymail.com','aol.com','protonmail.com','proton.me','icloud.com','me.com','mac.com','mail.com','zoho.com','yandex.com','gmx.com','gmx.net','tutanota.com','tuta.com','fastmail.com'];

export function isFreeEmailClient(e){return FREE_PROVIDERS.includes((e.split('@')[1]||'').toLowerCase());}

export function isValidHttpUrl(v){
  if(!v)return false;
  try{const u=new URL(String(v));return u.protocol==='http:'||u.protocol==='https:';}catch(_){return false;}
}

// Kept string-identical to lib/util.js's _EMAIL_RE (CI-enforced). See the long
// note there: ext-audit v7.15.6 tightened this because mailbox syntax such as
// `Alias<audit-bypass@gmail.com>` matched the old pattern and made isFreeEmail
// read the domain as "gmail.com>", bypassing the corporate-email rule.
export const _EMAIL_RE = /^[^\s@<>,;:"()\[\]\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isValidEmailFormat(v){
  if(typeof v!=='string')return false;
  const trimmed=v.trim();
  if(trimmed.length===0||trimmed.length>254)return false;
  // ext-audit (F1) — printable-ASCII only, mirroring the server (lib/util.js).
  // The email NOCASE uniqueness indexes case-fold ASCII only, so non-ASCII
  // addresses would bypass case-insensitive uniqueness. Reject them client-side
  // too so the dialog gives immediate feedback instead of a server round-trip.
  if(!/^[\x20-\x7E]+$/.test(trimmed))return false;
  return _EMAIL_RE.test(trimmed);
}

export async function checkInvitation(){
  const params=new URLSearchParams(location.search);
  const invId=params.get('invitation');
  if(!invId)return;
  try{
    const r=await fetch(`/api/invitations/${invId}`);
    if(!r.ok)return;
    const d=await r.json();
    S._regInvitationId=invId;
    S._regInvitation=d;
    // EMAIL FIRST, INVITATION TOO: the entry screen is pre-filled with the
    // invited address; its code (bound to the invitation) opens the sign-up form.
    const loginEmail=document.getElementById('login-email');
    if(loginEmail&&!loginEmail.value)loginEmail.value=d.email;
    syncLoginEmailHint();
    _paintInvitationBanner();
  }catch(e){console.warn('[checkInvitation] failed:',e&&e.message||e);}
}

/** The invitation's events, on the entry screen and on the sign-up form. */
function _paintInvitationBanner(){
  const d=S._regInvitation;
  if(!d)return;
  const names=(d.competitions||[]).map(c=>c.name).join(', ');
  const jb=document.getElementById('join-banner');const ji=document.getElementById('join-banner-info');
  if(jb&&ji){
    ji.textContent=names||'Your invitation';
    const chip=document.getElementById('join-banner-chip');if(chip){chip.textContent='Invited';chip.className='badge';chip.hidden=false;}
    jb.style.display='';jb.closest('.auth-card')?.classList.add('has-event');
  }
  const banner=document.getElementById('reg-invitation-banner');
  const info=document.getElementById('reg-invitation-info');
  if(banner&&info&&names){info.textContent='Event(s): '+names;banner.style.display='';}
}

/**
 * The redeemed code proved an address that has no account: open the sign-up
 * form for it. The server holds the grant; the address here is display only.
 */
export function openVerifiedSignup(email){
  resetRegForm();
  const emailEl=document.getElementById('reg-email');
  if(emailEl){emailEl.value=email;emailEl.readOnly=true;}
  const note=document.getElementById('reg-verified-note');
  if(note)note.textContent=`${email} is confirmed. A few details and you are in.`;
  if(S._regInvitationId){
    const titleEl=document.querySelector('#register-page h2');
    if(titleEl)titleEl.textContent="You've been invited — create your account";
    _paintInvitationBanner();
  }
  showPage('register-page');
  setTimeout(()=>document.getElementById('reg-first')?.focus(),0);
}

export function registerCancel(){
  resetRegForm();
  showPage('login-page');
  if(location.pathname!=='/')history.replaceState({},'','/');
  setTimeout(()=>document.getElementById('login-email')?.focus(),0);
}


export async function doRegister(){
  const jfSel=document.getElementById('reg-job-function');
  const jfOther=document.getElementById('reg-job-function-other');
  const jobFunctionRaw=jfSel?.value||'';
  const jobFunction=jobFunctionRaw==='other'?(jfOther?.value.trim()||''):jobFunctionRaw;
  // The short form: the nickname is not asked (the server suggests a unique one
  // from the name; the profile editor changes it), nor an avatar or a second
  // address (both in the profile editor).
  const fields={firstName:document.getElementById('reg-first').value.trim(),lastName:document.getElementById('reg-last').value.trim(),
    email:document.getElementById('reg-email').value.trim(),
    company:document.getElementById('reg-company').value.trim(),title:document.getElementById('reg-title').value.trim(),
    personalTitle:document.getElementById('reg-personal-title')?.value||undefined,
    phone:document.getElementById('reg-phone')?.value.trim()||undefined,
    linkedinUrl:document.getElementById('reg-linkedin')?.value.trim()||'',
    country:document.getElementById('reg-country').value,timezone:document.getElementById('reg-tz').value,
    jobFunction,city:document.getElementById('reg-city')?.value.trim()||'',
    invitationId:S._regInvitationId||undefined,
    joinToken:S._pendingJoinToken||undefined};
  const err=document.getElementById('reg-error');err.style.display='none';
  // Inline, field by field, in form order: the first gap is named and focused.
  for(const [id,val,label] of [['reg-first',fields.firstName,'your first name'],['reg-last',fields.lastName,'your last name'],
      ['reg-company',fields.company,'your company'],['reg-title',fields.title,'your job title']]){
    const el=document.getElementById(id);
    markFieldError(el,!val);
    if(!val){err.textContent=`Please enter ${label}.`;err.style.display='block';el?.focus();return;}
  }
  if(!fields.country||!fields.timezone){
    const pick=document.getElementById('reg-location-pick');if(pick)pick.hidden=false;
    err.textContent='Please choose your country and timezone.';err.style.display='block';document.getElementById('reg-country')?.focus();return;
  }
  // v8.1.0 (PR 31) — these two are skipped when the event's registration policy
  // relaxes them (a Booth Event walk-up fills eight fields, not ten). Keyed on
  // the RENDERED form rather than on the policy object: `_applyRelaxedProfileFields`
  // is the single place that decides, so reading its result here means the check
  // and the visible form cannot disagree — and a field the visitor cannot see can
  // never produce an error message pointing at it.
  //
  // v8.3.2 — …and NOT-REQUIRED is `[hidden] OR [data-relax-optional]`. Testing
  // only for `[hidden]` was correct while there was one relaxed set; v8.3.1 added
  // a second state — SHOWN but not required — and an optional field is never
  // hidden, so this refusal still fired for it. The result was a Booth Event
  // walk-up reading "Job function (optional)" and being told "Please select
  // your professional role." The server accepted it throughout (`relaxed ∪
  // optional`), so the field was optional on every surface except the only one
  // that could stop them.
  // v8.4.0 — ONE ATTRIBUTE, THREE STATES, five fields. `data-relax-state` is
  // written by `_applyRelaxedProfileFields`, which is still the single place that
  // decides — so the check and the visible form cannot disagree, and a field the
  // visitor cannot see can never produce an error message pointing at it.
  //
  // It replaces `[hidden] OR [data-relax-optional]`, which was correct for two
  // states and is not enough for three: Salutation, Phone and LinkedIn URL are
  // OPTIONAL by default, so "not hidden and not marked optional" would have read
  // them as required on every ordinary sign-up. The attribute states the answer
  // rather than leaving it to be inferred from two absences.
  const _fieldState=(f)=>document.querySelector(`[data-relax-field="${f}"]`)?.getAttribute('data-relax-state')||null;
  const _demanded=(f)=>{
    const st=_fieldState(f);
    // A field with no group in the DOM, or no state yet applied, falls back to the
    // markup's own default — the same ladder the renderer uses, so a submit that
    // somehow beats the first render behaves as the resting form does.
    if(st)return st==='required';
    return document.querySelector(`[data-relax-field="${f}"]`)?.getAttribute('data-relax-default')==='required';
  };
  if(_demanded('job_function')&&!fields.jobFunction){err.textContent='Please select your job function.';err.style.display='block';jfSel?.focus();return;}
  if(_demanded('city')&&!fields.city){err.textContent='Please enter your city.';err.style.display='block';document.getElementById('reg-city')?.focus();return;}
  // v8.4.0 — the three that were optional for every kind and may now be required.
  // Each names its own field, because the visitor reading it is standing at a
  // stand with a phone.
  if(_demanded('personal_title')&&!fields.personalTitle){err.textContent='Please choose a salutation.';err.style.display='block';document.getElementById('reg-personal-title')?.focus();return;}
  if(_demanded('phone')&&!fields.phone){err.textContent='Please enter your phone number.';err.style.display='block';document.getElementById('reg-phone')?.focus();return;}
  if(_demanded('linkedin_url')&&!fields.linkedinUrl){err.textContent='Please enter your LinkedIn profile URL.';err.style.display='block';document.getElementById('reg-linkedin')?.focus();return;}
  if(fields.linkedinUrl&&!isValidHttpUrl(fields.linkedinUrl)){err.textContent='LinkedIn URL must be a valid http:// or https:// URL.';err.style.display='block';document.getElementById('reg-linkedin').focus();return;}
  // Block UI during registration
  const regBtn=document.querySelector('#register-page button.btn[data-action="do-register"]');
  if(regBtn){regBtn.disabled=true;regBtn.textContent='Creating your account...';}
  const regPage=document.getElementById('register-page');
  const regBlocker=document.createElement('div');
  regBlocker.style.cssText='position:absolute;top:0;right:0;bottom:0;left:0;background:var(--overlay);display:flex;align-items:center;justify-content:center;z-index:10;border-radius:var(--radius)';
  setSafeHtml(regBlocker, '<div style="text-align:center;color:var(--text)"><div class="spinner" style="margin:0 auto 12px"></div><div style="font-weight:var(--fw-semibold)">Creating your account...</div></div>');
  if(regPage){regPage.style.position='relative';regPage.appendChild(regBlocker);}
  let r,d;
  try{
    const ctrl=new AbortController();
    const timeout=setTimeout(()=>ctrl.abort(),30000);
    r=await postWithCsrfRetry('/api/register',t=>({method:'POST',headers:{'X-CSRF-Token':t,'Content-Type':'application/json'},body:JSON.stringify(fields),signal:ctrl.signal}));
    // ext-audit v7.15.15 — the deadline must survive the BODY read. `fetch`
    // resolves at response HEADERS, so clearing here left a stalled body
    // unbounded and this await open for ever. Same defect the auditor reported
    // in core/api.js; fixed at every site that arms a deadline, not just the
    // one that was reported.
    d=await r.json();
    clearTimeout(timeout);
  }catch(e){
    regBlocker.remove();
    if(regBtn){regBtn.disabled=false;regBtn.textContent='Create account and continue';}
    err.textContent=e.name==='AbortError'?'Request timed out. Please try again.':'Network error. Please try again.';
    err.style.display='block';return;
  }
  regBlocker.remove();
  if(regBtn){regBtn.disabled=false;regBtn.textContent='Create account and continue';}
  if(!r.ok){
    // The grant expired (15 minutes) or this tab never had one: the way on is
    // the entry screen, which mails a fresh code.
    if(d.code==='email_proof_required'||d.code==='email_taken'){
      setSafeHtml(err,`${esc(d.error||'Confirm your email address first.')} <a href="#" data-action="register-cancel">Back to the email step</a>`);
      err.style.display='block';return;
    }
    err.textContent=d.error||'Registration failed.';err.style.display='block';return;
  }
  // v7.22.8 — registration with a join token SUCCEEDED: the server enrolled
  // the event at the sign-in, so the persisted client copy is spent.
  // S._pendingJoinToken is deliberately LEFT in memory — finishSignIn still
  // routes into the event through it (the join is idempotent).
  if(fields.joinToken)clearStoredJoin(fields.joinToken);
  S._regInvitationId=null;S._regInvitation=null;
  // The event this sign-up named can no longer be joined (its link was switched
  // off or replaced, or it stopped taking joins, before the form was sent): the
  // account was made without it. Forget the dead link, so nothing asks to join
  // through it after the sign-in, and say so in plain words.
  if(d.join_link_closed){
    // An invitation can still have added the account to that very event: say
    // "not added" only when the answer's own list of events lacks it.
    const pc=S._pendingJoinComp;
    const added=!!(pc&&pc.id&&Array.isArray(d.competitions)&&d.competitions.some(c=>c&&c.id===pc.id));
    S._pendingJoinToken=null;S._pendingJoinComp=null;
    if(!added)showToast("That event's join link was closed, so you were not added to it.",'info',{life:8000});
  }
  if(d.pendingApproval){showPendingApprovalPage(d.competition_name||null);return;}
  // The registration signed the new account in: route exactly as a sign-in does.
  await finishSignIn(d);
}

export function _cityFromTimezone(tz){
  if(!tz)return'';
  return tz.split('/').pop().replace(/_/g,' ');
}

export function _autoFillCityFromTz(){
  const cityEl=document.getElementById('reg-city');
  if(!cityEl)return;
  const tz=document.getElementById('reg-tz')?.value||'';
  // Only auto-fill if field is empty or was previously auto-filled (data-auto flag)
  if(!cityEl.value||cityEl.dataset.auto==='1'){
    const suggestion=_cityFromTimezone(tz);
    cityEl.value=suggestion;
    cityEl.dataset.auto=suggestion?'1':'';
  }
}

export function toggleJobFunctionOther(){
  const sel=document.getElementById('reg-job-function');
  const other=document.getElementById('reg-job-function-other');
  if(!sel||!other)return;
  const show=sel.value==='other';
  other.style.display=show?'':'none';
  if(!show)other.value='';
}

// v7.21.26 — these now live in ui/profile-form.js, shared with the admin editor.
// Re-exported under their existing names so main.js / linkedin.js /
// participants-admin.js need no edit: a refactor that forces unrelated files to
// change hides whether it changed anything (v7.17.1).
export const JOB_FUNCTION_PRESETS=_JFP;
export const PERSONAL_TITLE_PRESETS=_PTP;
export const _jobFunctionSelectHtml=jobFunctionSelectHtml;
export const _personalTitleSelectHtml=personalTitleSelectHtml;
export const toBase64=_toBase64;
export const downscaleImageFile=_downscale;
export const AVATAR_UPLOAD_MAX_PX=_AVMAX;

// ── HOW YOU SIGN IN ──────────────────────────────────────────────────────────
// Each account signs in with a password or with a code emailed to it
// (PUT /api/me/sign-in-method; lib/login-method.js). Choosing a password with
// none set sets it there and then. A password never closes the code door: the
// sign-in card always offers "Email me a code instead" to an account.

/** The profile's one-line summary of the account's sign-in method. */
function _signInSummary(me){
  const base=me.login_method==='password'
    ? (me.has_password
      ? 'With your password. You can still ask for an emailed code at any time.'
      : 'With a password, but none is set yet: until you set one, sign in with an emailed code.')
    : 'With a one-time code emailed to you each time.';
  return base+(me.login_method_is_default?' (The default for your role.)':'');
}

async function _putSignInMethod(body){
  try{
    const r=await fetch('/api/me/sign-in-method',{method:'PUT',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({}));
    return {r,d};
  }catch(e){
    console.warn('[sign-in method] request failed:',e&&e.message||e);
    return {r:null,d:{}};
  }
}

/** Fold the server's sign-in-method answer into the signed-in user. */
function _adoptSignInWire(d){
  const keys=['login_method','login_method_is_default','has_password','password_required'];
  if(S.currentUser)for(const k of keys)if(k in d)S.currentUser[k]=d[k];
  const sum=document.getElementById('signin-method-summary');
  if(sum&&S.currentUser)sum.textContent=_signInSummary(S.currentUser);
}

/**
 * Asked at sign-in of an account whose method is `password` with none set (an
 * admin's default until their first password): set one now, or keep using
 * emailed codes (which stores that choice). Not dismissable otherwise — the two
 * buttons are the way out. Resolves when either has been saved.
 */
export function openPasswordRequiredPrompt(){
  document.getElementById('set-password-overlay')?.remove();
  const overlay=document.createElement('div');
  overlay.id='set-password-overlay';
  overlay.className='picker-overlay';
  setSafeHtml(overlay,`<div class="picker-modal picker-modal-flow" role="dialog" aria-modal="true" aria-labelledby="sp-title" aria-describedby="sp-intro">
    <div class="picker-modal-head"><div><p class="eyebrow ink">Your account</p><h3 id="sp-title" class="display">Set your password</h3></div></div>
    <p class="picker-note" id="sp-intro">Your account signs in with a password, and none is set yet. Set one now, or keep signing in with a code emailed to you each time. You can change this later under Profile, How you sign in.</p>
    <div class="form-group"><label for="sp-new">New password</label>
      <input id="sp-new" type="password" autocomplete="new-password" aria-describedby="sp-rule" data-enter-action="set-password-save"/></div>
    <div class="form-group"><label for="sp-confirm">Type it again</label>
      <input id="sp-confirm" type="password" autocomplete="new-password" data-enter-action="set-password-save"/></div>
    <p class="picker-note" id="sp-rule">At least 8 characters.</p>
    <div id="sp-error" class="login-error" style="display:none" role="alert"></div>
    <div class="picker-modal-foot">
      <button class="btn secondary" data-action="set-password-codes">Keep using emailed codes</button>
      <button class="btn" data-action="set-password-save">Set password</button>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  overlay._release=installOverlayFocusTrap(overlay);
  setTimeout(()=>document.getElementById('sp-new')?.focus(),0);
  return new Promise(resolve=>{overlay._resolve=resolve;});
}

function _closePasswordPrompt(){
  const overlay=document.getElementById('set-password-overlay');
  if(!overlay)return;
  try{overlay._release&&overlay._release();}catch(e){console.warn('[set password] focus trap release failed:',e&&e.message||e);}
  const done=overlay._resolve;
  overlay.remove();
  if(done)done();
}

function _spErr(msg){
  const e=document.getElementById('sp-error');
  if(e){e.textContent=msg;e.style.display='block';}
}

export async function savePasswordPrompt(){
  const neu=document.getElementById('sp-new')?.value||'';
  const conf=document.getElementById('sp-confirm')?.value||'';
  if(!neu){_spErr('Enter a password.');document.getElementById('sp-new')?.focus();return;}
  if(neu!==conf){_spErr('The two passwords are not the same.');document.getElementById('sp-confirm')?.focus();return;}
  const {r,d}=await _putSignInMethod({method:'password',password:neu});
  if(!r){_spErr('Could not reach the server — check your connection.');return;}
  if(!r.ok||!d.ok){_spErr(d.error||'The password was not set.');return;}
  _adoptSignInWire(d);
  _closePasswordPrompt();
  showToast('Password set. From now on you sign in with it.','success');
}

export async function keepCodesPrompt(){
  const {r,d}=await _putSignInMethod({method:'code'});
  if(!r){_spErr('Could not reach the server — check your connection.');return;}
  if(!r.ok||!d.ok){_spErr(d.error||'That was not saved.');return;}
  _adoptSignInWire(d);
  _closePasswordPrompt();
  showToast('You will keep signing in with emailed codes.','success');
}

/** The profile's "Change how you sign in" dialog. */
export async function openSignInMethodDialog(){
  const me=await fetchJsonObject('/api/me');
  if(!me){showToast('Could not load your account — try again.','error');return;}
  document.getElementById('sign-in-method-overlay')?.remove();
  const overlay=document.createElement('div');
  overlay.id='sign-in-method-overlay';
  overlay.className='picker-overlay';
  overlay._hasPassword=!!me.has_password;
  const method=me.login_method==='password'?'password':'code';
  const has=!!me.has_password;
  setSafeHtml(overlay,`<div class="picker-modal picker-modal-flow" role="dialog" aria-modal="true" aria-labelledby="sim-title">
    <div class="picker-modal-head"><div><p class="eyebrow ink">Profile</p><h3 id="sim-title" class="display">How you sign in</h3></div></div>
    <fieldset class="sim-choices">
      <legend class="sr-only">Sign in with</legend>
      <label class="checkbox-row"><input type="radio" name="sim-method" value="code"${method==='code'?' checked':''}/> <span><strong>A code emailed to me</strong>. Each time you sign in, we email you a one-time code.</span></label>
      <label class="checkbox-row"><input type="radio" name="sim-method" value="password"${method==='password'?' checked':''}/> <span><strong>My password</strong>. You can still ask for an emailed code whenever you need one.</span></label>
    </fieldset>
    <div id="sim-pw"${method==='password'?'':' hidden'}>
      ${has?`<p class="picker-note">Your password is set. To change it, fill in the boxes below; leave them empty to keep it.</p>
      <div class="form-group"><label for="sim-current">Current password</label>
        <input id="sim-current" type="password" autocomplete="current-password" aria-describedby="sim-current-note"/>
        <p class="picker-note" id="sim-current-note">Not needed if you signed in with an emailed code in the last 10 minutes.</p></div>`
      :`<p class="picker-note">Set the password you will sign in with.</p>`}
      <div class="form-group"><label for="sim-new">${has?'New password':'Password'}</label>
        <input id="sim-new" type="password" autocomplete="new-password" aria-describedby="sim-rule"/></div>
      <div class="form-group"><label for="sim-confirm">Type it again</label>
        <input id="sim-confirm" type="password" autocomplete="new-password"/></div>
      <p class="picker-note" id="sim-rule">At least 8 characters.</p>
    </div>
    <div id="sim-error" class="login-error" style="display:none" role="alert"></div>
    <div class="picker-modal-foot">
      <button class="btn secondary" data-action="overlay-close" data-overlay-id="sign-in-method-overlay">Cancel</button>
      <button class="btn" data-action="save-sign-in-method">Save</button>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  overlayDismiss(overlay,()=>overlay.remove());
  overlay.addEventListener('change',(e)=>{
    if(e.target&&e.target.name==='sim-method'){
      const box=overlay.querySelector('#sim-pw');
      if(box)box.hidden=e.target.value!=='password';
    }
  });
  setTimeout(()=>overlay.querySelector('input[name="sim-method"]:checked')?.focus(),0);
}

export async function saveSignInMethod(){
  const overlay=document.getElementById('sign-in-method-overlay');
  if(!overlay)return;
  const show=(m)=>{const e=overlay.querySelector('#sim-error');if(e){e.textContent=m;e.style.display='block';}};
  const method=overlay.querySelector('input[name="sim-method"]:checked')?.value;
  if(method!=='password'&&method!=='code'){show('Choose how you sign in.');return;}
  const body={method};
  if(method==='password'){
    const has=!!overlay._hasPassword;
    const neu=overlay.querySelector('#sim-new')?.value||'';
    const conf=overlay.querySelector('#sim-confirm')?.value||'';
    const cur=overlay.querySelector('#sim-current')?.value||'';
    if(!has&&!neu){show('Set a password to sign in with one.');overlay.querySelector('#sim-new')?.focus();return;}
    if(neu||conf){
      if(neu!==conf){show('The two passwords are not the same.');overlay.querySelector('#sim-confirm')?.focus();return;}
      body.password=neu;
      if(has&&cur)body.currentPassword=cur;
    }
  }
  const {r,d}=await _putSignInMethod(body);
  if(!r){show('Could not reach the server — check your connection.');return;}
  if(!r.ok||!d.ok){show(d.error||'That was not saved.');return;}
  _adoptSignInWire(d);
  overlay.remove();
  showToast(d.login_method==='password'
    ? (body.password?'Saved. You now sign in with your new password.':'Saved. You now sign in with your password.')
    : 'Saved. You now sign in with a code emailed to you.','success');
}

export async function openProfileEditor(){
  const r=await fetch('/api/me');
  if(!r.ok)return;
  const me=await r.json();

  const overlay=document.createElement('div');
  overlay.id='profile-overlay';
  // v8.3.37 — the row the dialog was rendered from IS the diff baseline. See
  // profileChangedFields for why the baseline is the server row rather than the
  // dialog-open DOM (auto-detected country/timezone, _preserveUnlistedOption,
  // and the trim asymmetry all get it wrong).
  overlay._row=me;
  setSafeHtml(overlay, `<div class="card profile-card" role="dialog" aria-modal="true" aria-labelledby="profile-title">
    <h3 class="modal-title" id="profile-title">Edit Profile</h3>
    ${profileFieldsHtml({
      prefix: 'prof',
      user: me,
      // audit v7.23.7 — this dialog edits the signed-in user's OWN details, so
      // it is the one that owes WCAG 1.3.5 autocomplete tokens. The admin's
      // Edit Profile dialog deliberately does NOT set this: see the note beside
      // AUTOCOMPLETE in ui/profile-form.js for why autofilling someone else's
      // record is harmful rather than merely unnecessary.
      selfEditing: true,
      // Nothing is locked: every field is the user's own to change.
      locked: () => false,
      tzChangeAction: 'update-profile-timezones',
      // v8.3.34 (external audit) — THE NOTE TELLS THE WHOLE TRUTH.
      //
      // `PUT /api/me` cancels a staged change on any save that does not move
      // the address (EMAIL_RULES.md: "re-submitting the current email — or any
      // non-changing PUT /api/me — clears a prior pending change"). This field
      // is pre-filled with the CURRENT address and the form is submitted whole,
      // so EVERY save from this dialog cancels the pending change — including
      // one that only touched a timezone. That is not a stale-tab race; it is
      // the ordinary single-tab flow.
      //
      // The behaviour is deliberate and documented, and it is also the only way
      // a participant can cancel: there is no cancel control anywhere. So the
      // note stops promising the change is safe and states the rule instead —
      // which simultaneously surfaces the cancel affordance. Changing the
      // semantics would remove the only remedy (FROZEN_REMEDY, v7.29.0) and
      // needs its own affordance; saying what actually happens does not.
      emailsExtraHtml: me.pending_email
        ? `<p class="profile-pending-email" role="status">Pending change to <strong>${esc(me.pending_email)}</strong> — open the confirmation link we emailed there to finish. Your current email stays active until then. <strong>Saving this form cancels the pending change</strong>, so finish it from your inbox first — or save now if you have changed your mind.</p>`
        : '',
    })}
    ${me.login_method?`<div class="form-group signin-method-row">
      <span class="signin-row-label">How you sign in</span>
      <p class="picker-note" id="signin-method-summary">${esc(_signInSummary(me))}</p>
      <button type="button" class="btn secondary" data-action="open-sign-in-method" aria-describedby="signin-method-summary">Change how you sign in</button>
    </div>`:''}
    ${avatarPickerHtml({ prefix: 'prof', current: me.avatar, disabled: false })}
    <div id="prof-error" class="profile-error" role="alert" aria-live="assertive"></div>
    <div class="profile-actions">
      <button class="btn secondary" data-action="overlay-close" data-overlay-id="profile-overlay">Cancel</button>
      <button class="btn" data-action="save-profile">Save Changes</button>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  // v7.21.25/26 — the avatar control, from the shared module. The value lives on
  // the overlay rather than in module state because it is per-dialog: opening the
  // editor twice must not inherit the first attempt's unsaved pick.
  const _avatarPicker=wireAvatarPicker({
    prefix:'prof', current:me.avatar, disabled:false,
    errorEl:document.getElementById('prof-error'),
    onChange:v=>{ overlay._avatar=v; },
  });
  overlay._avatar=_avatarPicker.get();
  // Wire "Other" reveal for job function select in this overlay
  document.getElementById('prof-job-function')?.addEventListener('change',()=>{
    const jfs=document.getElementById('prof-job-function');
    const jfo=document.getElementById('prof-job-function-other');
    if(!jfs||!jfo)return;
    const show=jfs.value==='other';
    jfo.style.display=show?'block':'none';
    if(!show)jfo.value='';
  });
  // Populate country/timezone dropdowns using COUNTRY_TZ
  const countrySelect=document.getElementById('prof-country');
  const tzSelect=document.getElementById('prof-tz');
  Object.keys(COUNTRY_TZ).sort((a,b)=>COUNTRY_TZ[a].n.localeCompare(COUNTRY_TZ[b].n)).forEach(code=>{
    const opt=document.createElement('option');opt.value=code;opt.textContent=COUNTRY_TZ[code].n;
    if(code===me.country)opt.selected=true;
    countrySelect.appendChild(opt);
  });
  if(me.country&&COUNTRY_TZ[me.country]){
    setSafeHtml(tzSelect, '');
    COUNTRY_TZ[me.country].tz.forEach(([val,label])=>{
      const opt=document.createElement('option');opt.value=val;opt.textContent=label;
      if(val===me.timezone)opt.selected=true;
      tzSelect.appendChild(opt);
    });
  }
  // v7.21.11 — a stored country/timezone the vocabulary does not contain must
  // survive. Country is free text on the server but a closed <select> here, so
  // an imported or LinkedIn-captured value rendered blank and — country being
  // required client-side — the participant could not save their own profile
  // without overwriting it. The timezone went the same way, because its list is
  // rebuilt from the country and an unknown country left it empty.
  _preserveUnlistedOption(countrySelect, me.country, 'not in the list');
  _preserveUnlistedOption(tzSelect, me.timezone, 'not in the list');
  // Auto-detect if country/timezone are blank
  if(!me.country)autoDetectCountryTz('prof-country','prof-tz',updateProfileTimezones);
  // Snapshot initial values AFTER all selects are populated so an unchanged
  // form is actually recognised as clean. Pre-v6.9.2 the snapshot ran before
  // country/tz options appeared and every Cancel triggered the "Discard
  // changes?" prompt even when the user had typed nothing.
  // v8.1.0 (PR 24) — was a hand-maintained copy of profileFieldIds('prof'),
  // byte-identical to it, while the ADMIN dialog already used the shared helper.
  // So a field added to the shared form reached one dirty-snapshot and not the
  // other — the v7.21.26 'two hand-maintained copies of one form' class, in the
  // one place that release did not collapse. One list now.
  const _profFieldIds=profileFieldIds('prof');
  // Clear field-error highlight as soon as the user fills the field in
  _profFieldIds.forEach(id=>{
    const el=document.getElementById(id);
    if(el)el.addEventListener('input',()=>markFieldError(el,false));
    if(el)el.addEventListener('change',()=>markFieldError(el,false));
  });
  // v7.21.25 — the avatar is part of the snapshot. Without it an avatar-only
  // change reads as a CLEAN form, so Save closes silently (the v6.9.2
  // short-circuit) and Cancel skips the discard prompt — the change would be
  // dropped with a dialog that behaved as though nothing had been edited.
  const snapshotProfile=()=>_profFieldIds.map(id=>document.getElementById(id)?.value??'').join('\u0001')+'\u0001'+(overlay._avatar??'');
  const initialSnap=snapshotProfile();
  overlay._isDirty=()=>snapshotProfile()!==initialSnap;
  const closeWithGuard=async()=>{
    if(overlay._isDirty()){
      const ok=await showModal({title:'Discard changes?',message:'You have unsaved changes. Close the editor anyway?',confirmText:'Discard',confirmClass:'danger',cancelText:'Keep editing'});
      if(!ok)return;
    }
    overlay.remove();
  };
  overlayDismiss(overlay,closeWithGuard);
  setTimeout(()=>{const f=overlay.querySelector('input:not([disabled]),select:not([disabled]),textarea:not([disabled])');if(f)f.focus();},0);
  // Hijack the cancel button so it goes through the dirty-check too.
  overlay.querySelector('[data-action="overlay-close"][data-overlay-id="profile-overlay"]')?.addEventListener('click',(e)=>{
    e.preventDefault();e.stopImmediatePropagation();closeWithGuard();
  },true);
}

export function updateProfileTimezones(){
  const cc=document.getElementById('prof-country').value;
  const tzSelect=document.getElementById('prof-tz');
  if(!cc||!COUNTRY_TZ[cc]){
    setSafeHtml(tzSelect, '<option value="">Select timezone...</option>');
    return;
  }
  setSafeHtml(tzSelect, '');
  const c=COUNTRY_TZ[cc];
  c.tz.forEach(([val,label])=>{
    const opt=document.createElement('option');opt.value=val;opt.textContent=label;
    if(val===c.d)opt.selected=true;
    tzSelect.appendChild(opt);
  });
}

export async function saveProfile(){
  const err=document.getElementById('prof-error');err.style.display='none';
  const jfSel=document.getElementById('prof-job-function');
  const jfOther=document.getElementById('prof-job-function-other');
  const jfRaw=jfSel?.value||'';
  const jobFunction=jfRaw==='other'?(jfOther?.value.trim()||''):jfRaw;
  const fields={
    firstName:document.getElementById('prof-first').value.trim(),
    lastName:document.getElementById('prof-last').value.trim(),
    nickname:document.getElementById('prof-nick').value.trim(),
    email:document.getElementById('prof-email').value.trim(),
    secondaryEmail:document.getElementById('prof-email2').value.trim(),
    company:document.getElementById('prof-company').value.trim(),
    title:document.getElementById('prof-title').value.trim(),
    personalTitle:document.getElementById('prof-personal-title')?.value||'',
    phone:document.getElementById('prof-phone')?.value.trim()||'',
    linkedinUrl:document.getElementById('prof-linkedin').value.trim(),
    country:document.getElementById('prof-country').value,
    timezone:document.getElementById('prof-tz').value,
    jobFunction,
    city:document.getElementById('prof-city')?.value.trim()||'',
    // v8.1.0 (PR 24) — the certificate name. Always sent, including as an empty
    // string: clearing them has to mean "use my profile name again", and omitting
    // the key would mean "leave unchanged" instead.
    certificateGivenName:document.getElementById('prof-cert-given')?.value.trim()||'',
    certificateFamilyName:document.getElementById('prof-cert-family')?.value.trim()||'',
    // v7.21.25 — a preset name, an existing /api/images/<id> ref, or a freshly
    // downscaled data: URI. The server treats an unchanged value as a no-op and
    // reclaims the previous image blob when it really changed.
    avatar:document.getElementById('profile-overlay')?._avatar||undefined,
  };
  // What the save demands is REQUIRED_FIELDS, the set the form's red stars and
  // aria-required come from, so the dialog never refuses a field it does not mark.
  // Job function and City are not in it: PUT /api/me stores either one blank, and
  // an event that requires one asks for it through the completion gate.
  const _reqFields=[
    {key:'firstName',id:'prof-first',val:fields.firstName,label:'First name'},
    {key:'lastName',id:'prof-last',val:fields.lastName,label:'Last name'},
    {key:'nickname',id:'prof-nick',val:fields.nickname,label:'Nickname'},
    {key:'email',id:'prof-email',val:fields.email,label:'Email'},
    {key:'company',id:'prof-company',val:fields.company,label:'Company'},
    {key:'title',id:'prof-title',val:fields.title,label:'Work title'},
    {key:'country',id:'prof-country',val:fields.country,label:'Country'},
    {key:'timezone',id:'prof-tz',val:fields.timezone,label:'Timezone'},
    {key:'jobFunction',id:'prof-job-function',val:jobFunction,label:'Job function'},
    {key:'city',id:'prof-city',val:fields.city,label:'City'},
  ].filter(f=>REQUIRED_FIELDS.has(f.key));
  // Clear any previous field-error highlights
  _reqFields.forEach(({id})=>markFieldError(document.getElementById(id),false));
  const _missing=_reqFields.filter(f=>!f.val);
  if(_missing.length){
    _missing.forEach(({id})=>markFieldError(document.getElementById(id),true));
    err.textContent='Required: '+_missing.map(f=>f.label).join(', ')+'.';
    err.style.display='block';
    document.getElementById(_missing[0].id)?.focus();
    return;
  }
  if(fields.nickname.length<3){err.textContent='Nickname must be at least 3 characters.';err.style.display='block';return;}
  if(!NICKNAME_RE.test(fields.nickname)){err.textContent=NICKNAME_CHARSET_MSG;err.style.display='block';document.getElementById('prof-nick')?.focus();return;}
  // v6.9.2: LinkedIn field client-side validation — when non-empty the
  // value must parse as an http:// or https:// URL. The server's
  // validateUrl silently coerces invalid values to empty; validating here
  // surfaces the issue to the user instead of letting the field vanish
  // after save.
  if(fields.linkedinUrl&&!isValidHttpUrl(fields.linkedinUrl)){
    err.textContent='LinkedIn URL must be a valid http:// or https:// URL.';err.style.display='block';
    document.getElementById('prof-linkedin').focus();return;
  }
  // Dual-email validation: at least one non-free
  const pFree=isFreeEmailClient(fields.email);
  const sFree=fields.secondaryEmail?isFreeEmailClient(fields.secondaryEmail):true;
  if(pFree&&sFree){err.textContent='At least one email address must be a company email, not a free email service.';err.style.display='block';return;}

  // v6.9.2: short-circuit when nothing changed — close silently so Save
  // on an untouched form doesn't fire a no-op API call + toast.
  //
  // v8.3.37 — the DIFF is now the test, and it is strictly more accurate than
  // the snapshot: `_isDirty()` compares RAW input values, so a whitespace-only
  // edit reads as dirty while producing an identical stored value. Firing that
  // PUT would be harmless server-side but would raise a false "Profile updated"
  // toast AND still cancel a staged email change (the cancel is gated on the
  // email not moving, not on the key being present). `_isDirty()` is left alone
  // for the Cancel/discard prompt, where prompting on a whitespace edit is the
  // conservative answer.
  const overlay=document.getElementById('profile-overlay');
  const _changed=profileChangedFields(fields, overlay?._row||{});
  if(!Object.keys(_changed).length){overlay?.remove();return;}
  // Optimistic concurrency: echo the fingerprint of the row this dialog was
  // rendered from (the same `_row` the diff is taken against, so the two can
  // never disagree about which read is being claimed). Guarded, because an
  // absent value must send NOTHING rather than a literal undefined — the server
  // reads absence as "unchecked", which is the back-compat arm.
  if(overlay?._row?.updated_at)_changed.expectedUpdatedAt=overlay._row.updated_at;

  // v6.9.2: confirm save when dirty — mirrors the Cancel guard so both
  // exit paths require an explicit decision once the form has changes.
  const saveOk=await showModal({
    title:'Save changes?',
    message:'Update your profile with the changes you made?',
    confirmText:'Save',
    cancelText:'Keep editing'
  });
  if(!saveOk)return;

  // v7.5.0 — a primary-email change is now CONFIRMED via a link to the new
  // address; the current email + session stay active until then (no logout).
  const origEmail=document.getElementById('prof-email').defaultValue;
  if(fields.email.toLowerCase()!==origEmail.toLowerCase()){
    const ok=await showModal({
      title:'Change Email Address?',
      message:'We\'ll send a confirmation link to <strong>'+esc(fields.email)+'</strong>.<br><br>Your <strong>current email stays active</strong> and you stay signed in — the change only takes effect once you open that link. (Any other profile changes are saved right away.)',
      confirmText:'Send Confirmation',
    });
    if(!ok)return;
  }

  const r=await fetch('/api/me',{method:'PUT',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(_changed)});
  const d=await r.json();
  if(!r.ok){err.textContent=d.error||'Failed to save.';err.style.display='block';return;}
  document.getElementById('profile-overlay')?.remove();
  if(d.emailChangePending){
    // The server waits at most a few seconds for the relay: a mail still queued
    // (emailDeferred) or refused is reported as what it is.
    showToast(d.message||('Confirmation sent to '+d.pendingEmail+'. Your current email stays active until you confirm.'),
      d.emailDelivered===false?'error':d.emailDeferred?'warning':'success');
  }else{
    showToast('Profile updated.','success');
  }
  // Refresh current user info (no reload, no logout).
  // v8.3.20 — a 500's error body is truthy, so the guard below would have
  // assigned `{error:"…"}` to S.currentUser and rebuilt the nav from it. The
  // helper returns null on any non-ok, so a failed refresh simply leaves the
  // previous (correct) user in place.
  const me=await fetchJsonObject('/api/me');
  if(me){S.currentUser=me;refreshAccountHeader();}
}

export const _GATE_FIELD_LABELS={
  company:'Company',
  title:'Title',
  country:'Country',
  timezone:'Timezone',
  job_function:'Job function',
  city:'City',
  // v8.4.0 — the four fields a Booth Event may turn from optional into mandatory
  // after somebody has already registered. They appear here because the gate
  // renders straight from the server's `missing_fields` list, so a field with no
  // label would be announced to the participant by its column name.
  personal_title:'Salutation',
  phone:'Phone',
  linkedin_url:'LinkedIn Profile URL',
  corporate_email:'A company email address (your primary or secondary email must not be a free email service)',
};

/**
 * v8.7.3 — THE DOOR INTO PARTICIPANT VIEW, for an admin whose profile is
 * incomplete. Returns true when the caller may go ahead with the switch.
 *
 * THE DEFECT THIS CLOSES: every participant surface is gated by
 * `requireCompleteProfile` (18 endpoints), while the completion gate is
 * ADMIN-EXEMPT at both of its proactive sites — `doLogin` skips it on
 * `d.role!=='admin'` and `boot()` on `S.userRole==='participant'`. So an admin
 * can hold an incomplete profile for ever, and the moment they pressed
 * Participant View they landed in a view where NOTHING works and were told
 * "Could not load your competitions. The server did not respond correctly." —
 * a 400 that names the real reason, reported as a server malfunction.
 *
 * WHY THIS IS A MODAL AND NOT THE COMPLETION GATE. That gate is deliberately
 * NON-DISMISSIBLE and covers the header (`position:fixed`, z-index 4000, over a
 * z-index 100 header), and its focus trap admits only its own card. Opening it
 * for an admin would therefore hide the very Admin View button that is their
 * way out, and an admin whose toggle back is REFUSED — an unverified account
 * still inside its verification grace can hold an admin tier, and
 * `mode:"admin"` checks `verified` while `mode:"participant"` does not — would
 * be sealed in across reloads. A dismissible modal that leaves them where they
 * already are cannot strand anybody.
 *
 * IT NEEDS NO ROLE TEST, which is what keeps it honest: the only control that
 * calls it is the Admin View / Participant View toggle, which `buildParticipantNav`
 * and `buildAdminNav` render for admin tiers alone. A plain participant is
 * unreachable here by construction rather than by a client-side role guess.
 */
export async function confirmParticipantViewProfile(){
  // Re-read rather than trust `S.currentUser`: that snapshot is taken at login
  // or boot, and since v8.4.0 an organiser can make a field mandatory LIVE for
  // accounts that were complete when they signed in.
  const me=await fetchJsonObject('/api/me');
  // FAIL OPEN. This is the proactive explanation, not the enforcement — the
  // server still refuses every participant action either way — so a blip on
  // /api/me must not cost an admin the switch. If the platform really is
  // unreachable the picker's own failure branch is the honest reporter.
  if(!me||!Array.isArray(me.missing_fields)||!me.missing_fields.length)return true;
  const rows=me.missing_fields.map(f=>`<li>${esc(_GATE_FIELD_LABELS[f]||f)}</li>`).join('');
  const ok=await showModal({
    title:'Participant view needs a complete profile',
    message:`Taking part in an event needs the same profile every participant fills in, and yours is still missing:<ul style="margin:10px 0 0 18px">${rows}</ul>
      <p style="margin-top:12px">Until it is complete the events list and everything inside an event will be refused, so you would land on an empty screen.</p>`,
    confirmText:'Complete profile',
    confirmClass:'',
    cancelText:'Stay in admin view',
  });
  // Deliberately NOT chained into a retry: `openProfileEditor` resolves when the
  // dialog is BUILT, not when it is saved, so awaiting it would report success
  // for a form the admin never filled in. They press Participant View again.
  if(ok)openProfileEditor();
  return false;
}

export function openProfileCompletionGate(missingFields){
  // v8.8.23 — ONE GATE AT A TIME, and this belongs here rather than at each
  // caller. There are now four: `doLogin`, `selectCompetition`,
  // `loadMyCompetitions`, boot — plus the fetch interceptor, which can fire from
  // several concurrent requests at once (the status poll, the leaderboard poll
  // and a tasks load all tick together). Without this they would stack overlays.
  // Sharing the promise is also correct rather than merely tidy: the gate
  // re-verifies against the server after every save and re-opens itself for
  // whatever is still missing, so a second caller with a longer list is served by
  // the same dialog rather than needing its own.
  if(S._profileGatePromise)return S._profileGatePromise;
  S._profileGatePromise=_openProfileCompletionGate(missingFields)
    .finally(()=>{S._profileGatePromise=null;});
  return S._profileGatePromise;
}

function _openProfileCompletionGate(missingFields){
  return new Promise(async resolve=>{
    let me={};
    try{const r=await fetch('/api/me');if(r.ok)me=await r.json();}catch(e){console.warn('Profile gate: could not read the profile; the form opens blank',e);}
    const mf=new Set(missingFields||[]);
    const hasCompany=mf.has('company');
    const hasTitle=mf.has('title');
    const showCountryTz=mf.has('country')||mf.has('timezone');
    const hasJobFunction=mf.has('job_function');
    const hasCity=mf.has('city');
    // v8.4.0 — each row is emitted only when the SERVER says it is missing, which
    // is the existing contract here: the gate never decides what to ask for, so a
    // field an admin has just made mandatory appears without this dialog knowing
    // anything about event kinds or configurations.
    const hasPersonalTitle=mf.has('personal_title');
    const hasPhone=mf.has('phone');
    const hasLinkedinUrl=mf.has('linkedin_url');
    const hasCorporateEmail=mf.has('corporate_email');
    const missingLabels=(missingFields||[]).map(f=>_GATE_FIELD_LABELS[f]||f);

    const overlay=document.createElement('div');
    overlay.id='profile-gate-overlay';
    overlay.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;background:var(--overlay);z-index:4000;display:flex;align-items:center;justify-content:center;padding:24px;overflow-y:auto';
    const listHtml=missingLabels.map(l=>`<li>${esc(l)}</li>`).join('');
    const companyRow=hasCompany?`<div class="form-group"><label for="gate-company">Company <span class="req">*</span></label><input aria-required="true" id="gate-company" type="text" value="${esc(me.company||'')}"/></div>`:'';
    // v7.23.0 — the input is `gate-work-title`, NOT `gate-title`. The dialog's
    // <h3> below already owns `gate-title` (the modal's aria-labelledby target),
    // and it precedes ${titleRow} in the assembled markup — so with both sharing
    // the id, getElementById returned the HEADING. An <h3> has no `.value`, so
    // the required-field filter saw `undefined`, reported "Required: Title."
    // for ever, and the gate is non-dismissible with every participant endpoint
    // server-gated behind requireCompleteProfile: the account was unusable with
    // no self-service escape. The duplicate also left this required input with
    // no accessible name, since `label[for]` resolved to a non-labelable <h3>.
    const titleRow=hasTitle?`<div class="form-group"><label for="gate-work-title">Work Title <span class="req">*</span></label><input aria-required="true" id="gate-work-title" type="text" value="${esc(me.title||'')}"/></div>`:'';
    const countryTzRows=showCountryTz?`<div class="form-row">
      <div class="form-group"><label for="gate-country">Country <span class="req">*</span></label><select aria-required="true" id="gate-country"><option value="">Select country...</option></select></div>
      <div class="form-group"><label for="gate-tz">Timezone <span class="req">*</span></label><select aria-required="true" id="gate-tz"><option value="">Select timezone...</option></select></div>
    </div>`:'';
    const roleRow=hasJobFunction?`<div class="form-group"><label for="gate-job-function">Job function <span class="req">*</span></label>${_jobFunctionSelectHtml('gate-job-function',me.job_function||'',false)}</div>`:'';
    const cityRow=hasCity?`<div class="form-group"><label for="gate-city">City <span class="req">*</span></label><input aria-required="true" id="gate-city" type="text" maxlength="120" value="${esc(me.city||'')}" placeholder="Your city"/></div>`:'';
    // v8.4.0 — the four new rows. Salutation reuses the shared preset select so
    // the vocabulary cannot drift from the one the sign-up form and both profile
    // editors offer.
    const personalTitleRow=hasPersonalTitle?`<div class="form-group"><label for="gate-personal-title">Salutation <span class="req">*</span></label>${_personalTitleSelectHtml('gate-personal-title',me.personal_title||'',false,'',true)}</div>`:'';
    const phoneRow=hasPhone?`<div class="form-group"><label for="gate-phone">Phone <span class="req">*</span></label><input aria-required="true" id="gate-phone" type="tel" maxlength="32" value="${esc(me.phone||'')}" placeholder="+1 555 0100"/></div>`:'';
    const linkedinRow=hasLinkedinUrl?`<div class="form-group"><label for="gate-linkedin">LinkedIn Profile URL <span class="req">*</span></label><input aria-required="true" id="gate-linkedin" type="url" value="${esc(me.linkedin_url||'')}" placeholder="https://www.linkedin.com/in/yourprofile"/></div>`:'';
    // v8.8.23 — THE GATE USED TO MARK THE ONE CONTROL THAT CANNOT SATISFY THIS
    // REQUIREMENT. `corporate_email` is missing when NEITHER address is a company
    // one, and the primary box cannot fix it: since v8.3.36 a primary change is
    // STAGED in `pending_email` and confirmed by a link, so `PUT /api/me` still
    // tests the OLD free address (`activePrimary = emailChanged ? user.email :
    // newEmail`, routes/participant.js) and refuses. So typing a work address
    // into the box the gate marked REQUIRED returned a 400, while the only box
    // that works was the one labelled "(optional)" — a non-dismissible dialog
    // pointing at a dead end. The SECONDARY is the required control now, because
    // it applies immediately; the primary stays editable, and says why it will
    // not help today.
    const emailRows=hasCorporateEmail?`
      <div class="form-group"><label for="gate-email2">Company Email <span class="req">*</span></label><input aria-required="true" id="gate-email2" type="email" value="${esc(me.secondary_email||'')}" placeholder="you@yourcompany.com"/>
        <div class="profile-label-hint" style="margin-top:6px">Added as your secondary address and applied straight away.</div></div>
      <div class="form-group"><label for="gate-email">Primary Email <span class="profile-label-hint">(optional — needs email confirmation, so it will not lift this requirement now)</span></label><input id="gate-email" type="text" value="${esc(me.email||'')}"/></div>`:'';
    setSafeHtml(overlay,`<div class="card profile-card" role="dialog" aria-modal="true" aria-labelledby="gate-title" style="max-width:520px;width:100%">
      <h3 class="modal-title" id="gate-title">Complete Your Profile</h3>
      <div class="result-msg" style="background:var(--accent-soft);color:var(--text);border-radius:var(--radius);padding:12px 16px;margin-bottom:16px;font-size:var(--fs-14)">
        <strong>Action required.</strong> Your profile is missing some required details. Please fill them in to continue — you can't proceed until they're complete:
        <ul style="margin:8px 0 0 16px">${listHtml}</ul>
      </div>
      ${emailRows}${countryTzRows}${cityRow}${companyRow}${titleRow}${roleRow}${personalTitleRow}${phoneRow}${linkedinRow}
      <div id="gate-error" class="profile-error" role="alert" aria-live="assertive"></div>
      <div class="profile-actions"><button class="btn" id="gate-save-btn">Save &amp; Continue</button></div>
    </div>`);
    // Singleton: never let two gates coexist (the re-verify path re-opens the gate;
    // a stray prior overlay would duplicate the `profile-gate-overlay` id + inputs).
    document.getElementById('profile-gate-overlay')?.remove();
    document.body.appendChild(overlay);
    // v6.20.x — the gate deliberately skips overlayDismiss (it's non-dismissible
    // by design), but that also skipped the focus trap, so Tab could walk out to
    // the header/nav behind the gate. Install the trap directly; it auto-releases
    // when the overlay leaves the DOM (MutationObserver in installOverlayFocusTrap).
    installOverlayFocusTrap(overlay);

    if(showCountryTz){
      const cSel=document.getElementById('gate-country');
      const tSel=document.getElementById('gate-tz');
      Object.keys(COUNTRY_TZ).sort((a,b)=>COUNTRY_TZ[a].n.localeCompare(COUNTRY_TZ[b].n)).forEach(code=>{
        const opt=document.createElement('option');opt.value=code;opt.textContent=COUNTRY_TZ[code].n;
        if(code===me.country)opt.selected=true;
        cSel.appendChild(opt);
      });
      function updateGateTimezones(){
        const cc=cSel.value;
        setSafeHtml(tSel,'<option value="">Select timezone...</option>');
        if(!cc||!COUNTRY_TZ[cc])return;
        COUNTRY_TZ[cc].tz.forEach(([val,label])=>{
          const opt=document.createElement('option');opt.value=val;opt.textContent=label;
          if(val===me.timezone)opt.selected=true;
          tSel.appendChild(opt);
        });
      }
      if(me.country)updateGateTimezones();
      // v7.21.11 — same preservation as the profile editor. This surface matters
      // MORE: the gate is non-dismissible, so a participant whose country is not
      // in COUNTRY_TZ would otherwise be trapped behind a required field they
      // cannot satisfy without destroying their real value.
      _preserveUnlistedOption(cSel, me.country, 'not in the list');
      _preserveUnlistedOption(tSel, me.timezone, 'not in the list');
      cSel.addEventListener('change',updateGateTimezones);
      if(!me.country)autoDetectCountryTz('gate-country','gate-tz',updateGateTimezones);
    }

    document.getElementById('gate-job-function')?.addEventListener('change',()=>{
      const jfs=document.getElementById('gate-job-function');
      const jfo=document.getElementById('gate-job-function-other');
      if(!jfs||!jfo)return;
      const show=jfs.value==='other';
      jfo.style.display=show?'block':'none';
      if(!show)jfo.value='';
    });
    setTimeout(()=>{const f=overlay.querySelector('select:not([disabled]),input:not([disabled])');if(f)f.focus();},0);

    document.getElementById('gate-save-btn').addEventListener('click',async()=>{
      // Re-entrancy guard: the handler awaits PUT + GET and the re-verify path
      // tears this overlay down and re-opens a fresh one, so a rapid double-click
      // must not run twice (which could stack two #profile-gate-overlay elements).
      const _btn=document.getElementById('gate-save-btn');
      if(_btn.disabled)return;
      _btn.disabled=true;
      const err=document.getElementById('gate-error');err.style.display='none';
      // Build list of fields to validate (only the ones in missingFields)
      const gateReqs=[];
      if(hasCompany)gateReqs.push({id:'gate-company',label:'Company'});
      if(hasTitle)gateReqs.push({id:'gate-work-title',label:'Work Title'});
      if(mf.has('country'))gateReqs.push({id:'gate-country',label:'Country'});
      if(mf.has('timezone'))gateReqs.push({id:'gate-tz',label:'Timezone'});
      if(hasCity)gateReqs.push({id:'gate-city',label:'City'});
      if(hasCorporateEmail)gateReqs.push({id:'gate-email2',label:'Company Email'});   // v8.8.23 — the box that WORKS, see emailRows above
      // v8.4.0 — the three new text/select rows join the ordinary presence check.
      if(hasPersonalTitle)gateReqs.push({id:'gate-personal-title',label:'Salutation'});
      if(hasPhone)gateReqs.push({id:'gate-phone',label:'Phone'});
      if(hasLinkedinUrl)gateReqs.push({id:'gate-linkedin',label:'LinkedIn Profile URL'});
      // Clear previous highlights
      gateReqs.forEach(({id})=>markFieldError(document.getElementById(id),false));
      markFieldError(document.getElementById('gate-job-function'),false);
      // Validate job function separately (select can have valid value)
      let jfVal='';
      if(hasJobFunction){
        const jfSel=document.getElementById('gate-job-function');
        const jfOther=document.getElementById('gate-job-function-other');
        const jfRaw=jfSel?.value||'';
        jfVal=jfRaw==='other'?(jfOther?.value.trim()||''):jfRaw;
      }
      const missingReqs=gateReqs.filter(({id})=>!document.getElementById(id)?.value);
      if(hasJobFunction&&!jfVal)missingReqs.push({id:'gate-job-function',label:'Job function'});
      if(missingReqs.length){
        missingReqs.forEach(({id})=>markFieldError(document.getElementById(id),true));
        err.textContent='Required: '+missingReqs.map(f=>f.label).join(', ')+'.';
        err.style.display='block';
        document.getElementById(missingReqs[0].id)?.focus();
        _btn.disabled=false; // gate stays open — allow another attempt
        return;
      }
      const body={};
      if(hasCompany)body.company=document.getElementById('gate-company')?.value.trim()||'';
      if(hasTitle)body.title=document.getElementById('gate-work-title')?.value.trim()||'';
      if(showCountryTz){
        body.country=document.getElementById('gate-country')?.value||'';
        body.timezone=document.getElementById('gate-tz')?.value||'';
      }
      if(hasJobFunction)body.jobFunction=jfVal;
      if(hasCity)body.city=document.getElementById('gate-city')?.value.trim()||'';
      // v8.4.0 — the three new profile fields ride the same PUT.
      if(hasPersonalTitle)body.personalTitle=document.getElementById('gate-personal-title')?.value||'';
      if(hasPhone)body.phone=document.getElementById('gate-phone')?.value.trim()||'';
      if(hasLinkedinUrl)body.linkedinUrl=document.getElementById('gate-linkedin')?.value.trim()||'';
      if(hasCorporateEmail){
        body.email=document.getElementById('gate-email')?.value.trim()||me.email||'';
        const s=document.getElementById('gate-email2')?.value.trim();
        if(s)body.secondaryEmail=s;
      }
      // audit v7.7.37 (C17) — the gate is non-dismissible (no X/Escape/Cancel) and
      // never resolves its Promise, so a thrown fetch (transient wifi drop, sleep/
      // resume) that escaped this handler left Save disabled forever with the whole
      // app unreachable behind the overlay. Wrap the network call so any failure
      // re-enables the button + shows an inline retry message.
      let r,d;
      try{
        r=await fetch('/api/me',{method:'PUT',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(body)});
        d=await r.json();
      }catch(_){
        err.textContent='Failed to save — check your connection and try again.';err.style.display='block';_btn.disabled=false;return;
      }
      if(!r.ok){err.textContent=d.error||'Failed to save.';err.style.display='block';_btn.disabled=false;return;}
      // Re-verify completeness from the SERVER before letting the user through —
      // the gate must not resolve while ANY mandatory field is still missing.
      // Normally the fields shown here are the whole missing set, so this passes
      // first time; but if the server still reports something unfilled (a field
      // that wasn't in the original set, or one the save couldn't satisfy), we
      // re-open the gate for the remaining fields instead of proceeding.
      const freshMe=await fetch('/api/me').then(r=>r.ok?r.json():null).catch(()=>null);
      if(freshMe&&Array.isArray(freshMe.missing_fields)&&freshMe.missing_fields.length){
        S.currentUser=freshMe;
        overlay.remove();
        // v8.8.23 — the INNER function, deliberately. This is the gate re-opening
        // ITSELF for what a save could not satisfy, so it must bypass the
        // single-flight guard: the outer promise is still pending (it is waiting
        // on THIS call), so going through the public entry point would hand back
        // the promise we are inside and the gate would never re-open. Caught by
        // the two v6.18.x re-verify locks on the first full-suite run, which is
        // exactly what they are for.
        await _openProfileCompletionGate(freshMe.missing_fields); // resolves only once truly complete
        resolve();
        return;
      }
      overlay.remove();
      if(freshMe){S.currentUser=freshMe;refreshAccountHeader();}
      resolve();
    });
  });
}

// ── v8.3.1 — THE EMAILED SIGN-IN CODE, IN ITS OWN DIALOG ────────────────────
//
// Inline, this flow revealed a bare "Sign-in code" field after a link click and
// never named the mailbox it had used. The code arrives somewhere the login card
// does not state, so the one fact the person needs to go and look was the one
// missing — and if the email box happened to be empty the link simply refused
// with an error on a field they had not been told mattered.
//
// The dialog asks for the address, STATES IT BACK on the way to the code, and
// keeps both steps in one place. It is seeded from the login form when that has
// something in it, so the common case is still one click and one paste.
// Email first: the dialog is ONLY the code step — the address is the one the
// card's Continue sent to (there is no second "type your email" step).
// The code step's words (operator ruling, 14 Nov 2026). The request's answer is
// the same for every address (it must not say which have an account), so the
// step never claims a code was sent: it says when one is on its way, and names
// the addresses that get nothing (a personal address with no invitation).
const SC_ON_ITS_WAY='If this address can sign in or sign up, a code is on its way.';
const SC_PERSONAL="Personal addresses (Gmail, Outlook…) can't open an account without an invitation.";
function _signinCodeBody(sentTo, already){
  // `already`: Continue for an address whose code is still live sends nothing
  // new (a new request would supersede the code in the inbox) and says so.
  const lead=already
    ? `<strong>${esc(sentTo)}</strong><br>If this address can sign in or sign up, a code is already on its way: enter it below, or request a new one when the timer runs out. ${SC_PERSONAL}`
    : `<strong>${esc(sentTo)}</strong><br>${SC_ON_ITS_WAY} ${SC_PERSONAL} It looks like <code>XXXX-XXXX</code> and is good for a few minutes.`;
  // THE SEGMENTED ENTRY is ONE real input (#sc-code) laid over eight painted
  // cells, so paste, autofill (autocomplete=one-time-code), a screen reader and
  // every caller that fills #sc-code see an ordinary text box; the cells only
  // mirror its value (_paintCodeCells). The input's own text is transparent,
  // never faded: the cells are what is read.
  const cell='<span class="ha-code-cell"></span>';
  return `<p class="picker-note sc-sent">${lead} <a href="#" data-action="signin-code-restart">Use a different address</a></p>
      <div class="form-group">
        <label for="sc-code">Sign-in code</label>
        <div class="ha-code">
          <input id="sc-code" class="ha-code-input" type="text" inputmode="latin" autocapitalize="characters" autocomplete="one-time-code"
                 spellcheck="false" maxlength="12" placeholder="XXXX-XXXX" data-enter-action="signin-code-redeem" data-input-action="signin-code-input"/>
          <div class="ha-code-cells" aria-hidden="true"><span class="ha-code-grp">${cell.repeat(4)}</span><span class="ha-code-dash"></span><span class="ha-code-grp">${cell.repeat(4)}</span></div>
        </div>
      </div>
      <div id="sc-error" class="login-error" style="display:none" role="alert"></div>
      <div class="sc-resend-row"><span class="ha-ring" id="sc-resend-ring" aria-hidden="true"></span>
        <span><button type="button" class="link-btn-inline" id="sc-resend" data-action="signin-code-resend" disabled>Send a new code</button> <span id="sc-resend-wait">(available in 2 minutes)</span></span><span data-help="signin.code" data-help-label="Send a new code"></span></div>
      <p class="picker-note">Not arrived? Check spam, and check the address. First time here, and no email at all? An organiser can show you a code at the desk.</p>
      <div class="picker-modal-foot">
        <button class="btn secondary" data-action="overlay-close" data-overlay-id="signin-code-overlay">Cancel</button>
        <button class="btn" data-action="signin-code-redeem">Sign in</button>
      </div>`;
}

/** Mirror #sc-code's value into the eight cells (Crockford characters only). */
export function _paintCodeCells(){
  const input=document.getElementById('sc-code');
  const cells=input?.parentElement?.querySelectorAll('.ha-code-cell');
  if(!cells)return;
  const chars=(input.value||'').toUpperCase().replace(/[^0-9A-Z]/g,'').slice(0,cells.length);
  const focused=document.activeElement===input;
  cells.forEach((c,i)=>{
    c.textContent=chars[i]||'';
    c.classList.toggle('is-filled',i<chars.length);
    c.classList.toggle('is-active',focused&&i===chars.length);
  });
}

function _renderSigninCodeDialog(sentTo, already){
  const overlay=document.getElementById('signin-code-overlay');
  if(!overlay)return;
  overlay.dataset.sentTo=sentTo||'';
  setSafeHtml(overlay,`<div class="picker-modal picker-modal-flow signin-code-dialog" role="dialog" aria-modal="true" aria-labelledby="sc-title">
    <div class="ha-steps" aria-hidden="true"><i class="on"></i><i class="on"></i></div>
    <div class="picker-modal-head"><div><p class="eyebrow ink">Step 2 of 2</p><h3 id="sc-title" class="display">Check your inbox</h3></div></div>
    ${_signinCodeBody(sentTo, already)}
  </div>`);
  const _el=document.getElementById('sc-code');
  if(_el){
    // The cells follow focus as well as the value (the active cell's caret).
    _el.addEventListener('focus',_paintCodeCells);
    _el.addEventListener('blur',_paintCodeCells);
    _paintCodeCells();
  }
  setTimeout(()=>{_el?.focus();},0);
  _armResend(_lastSend(sentTo));
}

// The last code this browser asked for: {email, at}. Kept in sessionStorage so a
// reload inside the code's life still lands on the code step, not a second send.
// The code's life is the SERVER's (LOGIN_CODE_TTL_MS, which the operator may
// override), never a copy of its default: with a copy, Continue would reopen the
// step for a dead code or send again while the old one lives. The shell carries
// it (`<body data-login-code-ttl>`), so a throttled GET /api/config cannot hide
// it; that answer's `login_code_ttl_ms` is the same value. Unknown to both,
// nothing is reused, and Continue asks for a code as a first visit does.
function _codeLife(){
  if(Number.isFinite(S.loginCodeTtlMs)&&S.loginCodeTtlMs>0)return S.loginCodeTtlMs;
  const v=Number(document.body?.dataset?.loginCodeTtl);
  return Number.isFinite(v)&&v>0?v:null;
}
// The event a code request carries (the join link, QR or event code this page
// holds), as the marker records it: a code sent with one event is never reopened
// as "already on its way" for another, or after "Not your event?" dropped it.
function _sendEvent(){ return S._pendingJoinToken?((S._pendingJoinComp&&S._pendingJoinComp.id)||'join'):null; }
function _readSend(){
  let v=S._lastCodeSend||null;
  if(!v){try{v=JSON.parse(sessionStorage.getItem('ha:last-code')||'null');}catch(e){v=null;}}
  return v&&typeof v.email==='string'?v:null;
}
function _lastSend(email){
  const life=_codeLife();
  if(life===null)return null;
  const v=_readSend();
  return v&&v.email===String(email||'').toLowerCase()&&(v.comp||null)===_sendEvent()&&Date.now()-v.at<life?v.at:null;
}
function _noteSend(email){
  S._lastCodeSend={email:String(email).toLowerCase(),at:Date.now(),comp:_sendEvent()};
  try{sessionStorage.setItem('ha:last-code',JSON.stringify(S._lastCodeSend));}catch(e){console.warn('[sign-in] the code send was not remembered:',e&&e.message);}
}
function _forgetSend(){
  S._lastCodeSend=null;
  try{sessionStorage.removeItem('ha:last-code');}catch(e){console.warn('[sign-in] could not forget the code send:',e&&e.message);}
}

// "NOT YOUR EVENT? CONTINUE WITHOUT IT" (operator rulings, 18 and 20 Nov 2026):
// the sign-in card's and sign-up form's banners, and the event-code dialog's
// "Forget this code". The page forgets the event; and when this browser was
// emailed a code (or proved the address) WITH it, POST /api/auth/code/drop-event
// unties that code first, so it still signs in without joining. Asked before the
// event is forgotten: when the server cannot be reached the event stays, with
// the link, so pressing it again finishes the job.
export async function leaveJoinedEvent(){
  const sent=_readSend();
  // A code sent WITH the event, still alive: the one in the inbox after this.
  const life=_codeLife();
  const sentLive=!!(sent&&sent.comp&&life!==null&&Date.now()-sent.at<life);
  const onRegister=!!document.getElementById('register-page')?.classList.contains('active');
  const email=sent&&sent.comp?sent.email:(onRegister?String(document.getElementById('reg-email')?.value||'').trim():'');
  if(email){
    let r=null;
    try{r=await postWithCsrfRetry('/api/auth/code/drop-event',t=>({method:'POST',headers:{'X-CSRF-Token':t,'Content-Type':'application/json'},body:JSON.stringify({email})}));}catch(_){r=null;}
    if(!r||!r.ok){
      showToast(r&&r.status===429?'Too many requests from here just now. Wait a minute, then try again.':'Could not reach the server — check your connection, then try again.','error');
      return false;
    }
  }
  // The code already in the inbox is still the one to type: its send stays
  // remembered, now with no event, so Continue reopens the code step rather than
  // asking for a new code (which, two minutes on, would replace it).
  if(sentLive){
    S._lastCodeSend={email:sent.email,at:sent.at,comp:null};
    try{sessionStorage.setItem('ha:last-code',JSON.stringify(S._lastCodeSend));}catch(e){console.warn('[sign-in] the code send was not remembered:',e&&e.message);}
  }else _forgetSend();
  S._joinFromUrl=false;
  eventCodeDiscard({codeSent:sentLive});
  return true;
}

// "Send a new code" is enabled LOGIN_CODE_RESEND_MIN_MS after the last send —
// two minutes, the server's re-send suppression (lib/login-code.js). Offering it
// sooner would be a control that does nothing: inside that window the server
// keeps the live code rather than superseding the one in the inbox.
const RESEND_AFTER_MS=120_000;
function _armResend(sentAt){
  clearTimeout(S._scResendTimer);clearInterval(S._scResendTick);
  const until=(sentAt||Date.now())+RESEND_AFTER_MS;
  const paint=()=>{
    const b=document.getElementById('sc-resend');const w=document.getElementById('sc-resend-wait');
    if(!b){clearInterval(S._scResendTick);return;}
    const left=Math.max(0,until-Date.now());
    // The ring drains as the wait runs out: a full ring is the whole wait.
    document.getElementById('sc-resend-ring')?.style.setProperty('--p',String(left/RESEND_AFTER_MS));
    if(left<=0){b.disabled=false;if(w)w.textContent='';clearInterval(S._scResendTick);return;}
    const s=Math.ceil(left/1000);
    if(w)w.textContent=`(available in ${Math.floor(s/60)}:${String(s%60).padStart(2,'0')})`;
  };
  paint();
  S._scResendTick=setInterval(paint,1000);
}

/**
 * Request a code for `email` (bound to the event this page came from, when a
 * join link, QR or join code opened it) and open the code step. The request's
 * answer is uniform for every outcome, so it is never branched on — only a
 * response that never reached the handler (429, a stale token) is reported.
 */
export async function sendSignInCode(email, opts){
  // Continue for an address this browser was mailed a code for, still live:
  // straight to the code step, nothing sent (a resend says so explicitly).
  if(!(opts&&opts.resend)&&_lastSend(email)){
    if(document.getElementById('signin-code-overlay'))_renderSigninCodeDialog(email,true);
    else openSigninCodeDialog(email,true);
    return true;
  }
  let rq;
  try{
    rq=await postWithCsrfRetry('/api/auth/code/request',t=>({method:'POST',headers:{'X-CSRF-Token':t,'Content-Type':'application/json'},body:JSON.stringify({email,...(S._pendingJoinToken?{joinToken:S._pendingJoinToken}:{}),...(S._regInvitationId?{invitationId:S._regInvitationId}:{})})}));
  }catch(_){showToast('Could not reach the server — check your connection.','error');return false;}
  if(!rq.ok){
    const err=document.getElementById('login-error');
    const msg=rq.status===429
      ? 'Too many requests from here just now. Wait a minute, then try again.'
      : rq.status===503
        ? 'The site is busy right now. Wait a moment, then press Continue again.'
        : 'That did not go through — this page has been open a while. Try again.';
    if(document.getElementById('signin-code-overlay'))_scErr(msg);
    else if(err){err.textContent=msg;err.style.display='block';}
    if(rq.status!==429)loadCsrfToken().catch(e=>console.warn('CSRF token refresh failed',e));
    return false;
  }
  _noteSend(email);
  if(document.getElementById('signin-code-overlay'))_renderSigninCodeDialog(email);
  else openSigninCodeDialog(email);
  return true;
}

export async function signinCodeResend(){
  const overlay=document.getElementById('signin-code-overlay');
  const email=(overlay?.dataset?.sentTo||'').trim();
  if(!email)return;
  await sendSignInCode(email,{resend:true});
}

/**
 * `sentTo` opens the dialog at STEP TWO — the code box — for a caller that has
 * already had a code sent to a known address.
 *
 * v8.3.6: registration is that caller. A passwordless walk-up is emailed a code
 * by `POST /api/register` itself, so sending them back to step one to type the
 * address they typed thirty seconds ago — and to press a button that would mint a
 * SECOND code, superseding the one already in their inbox and spending one of
 * three capped sends — would be worse than useless. Default '' keeps every other
 * entry point on step one.
 */
export function openSigninCodeDialog(sentTo, already){
  // Only the code step exists: with no address there is nothing to open, and the
  // card's email box is where an address is typed.
  if(typeof sentTo!=='string'||!sentTo){document.getElementById('login-email')?.focus();return;}
  if(document.getElementById('signin-code-overlay'))return;
  const overlay=document.createElement('div');
  overlay.id='signin-code-overlay';
  overlay.className='picker-overlay';
  document.body.appendChild(overlay);
  overlayDismiss(overlay,()=>overlay.remove());
  _renderSigninCodeDialog(sentTo, !!already);
}

/** "Use a different address": back to the card's email box (the one email step). */
export function signinCodeRestart(){
  document.getElementById('signin-code-overlay')?.remove();
  clearTimeout(S._scResendTimer);clearInterval(S._scResendTick);
  const le=document.getElementById('login-email');
  if(le){le.focus();le.select();}
}

const _scErr=(msg)=>{
  const e=document.getElementById('sc-error');
  if(e){e.textContent=msg;e.style.display='block';}
};


export async function signinCodeRedeem(){
  const overlay=document.getElementById('signin-code-overlay');
  const email=(overlay?.dataset?.sentTo||'').trim();
  const code=(document.getElementById('sc-code')?.value||'').trim();
  if(!code){_scErr('Enter the code from the email.');document.getElementById('sc-code')?.focus();return;}
  let r,d;
  try{
    r=await postWithCsrfRetry('/api/auth/code/redeem',t=>({method:'POST',headers:{'X-CSRF-Token':t,'Content-Type':'application/json'},body:JSON.stringify({email,code})}));
    d=await r.json().catch(()=>({}));
  }catch(_){_scErr('Could not reach the server — check your connection.');return;}
  if(!r.ok){
    // The copy here is load-bearing and is inherited verbatim from the inline
    // flow this dialog replaces. A 429 is the LIMITER, not a verdict on the
    // code: saying "expired" would be a claim the server never made, and
    // "ask for a new one" would tell the holder of a WORKING code to supersede
    // it — the one-credential rule cancels the old one on the next mint, and it
    // spends one of three capped sends.
    _scErr(r.status===429
      ? 'Too many attempts from here just now. Wait a minute, then try the same code again.'
      : 'Could not check that code — try again.');
    return;
  }
  // ── `d.ok`, NEVER `r.ok`. ── This endpoint answers 200 for every outcome,
  // including every failure, so that a mistyped code cannot feed the per-IP
  // scanner counter and lock a whole venue out of the API. A client that
  // branched on the status would call every refusal a success.
  if(!d.ok){
    if(d.error==='pending_approval'){
      _forgetSend();   // the code was spent on the way to the queue
      overlay?.remove();
      showPendingApprovalPage();
      return;
    }
    _scErr('That code was not accepted. Check it against the newest email — it may have expired or already been used.');
    document.getElementById('sc-code')?.select();
    return;
  }
  overlay?.remove();
  clearTimeout(S._scResendTimer);clearInterval(S._scResendTick);
  // The code is spent: the next Continue for this address must ask for a new one.
  _forgetSend();
  // An address with no account: the code proved it, and the server regenerated
  // the session to hold the sign-up grant. Fresh token, then the form.
  if(d.needsProfile){
    await adoptNewSessionToken();
    openVerifiedSignup(d.email||email);
    return;
  }
  // The redeem answered the same login-shaped payload the password door did, so
  // route in place, exactly as a sign-in always has.
  await finishSignIn(d);
}
