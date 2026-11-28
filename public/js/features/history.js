"use strict";

import { S } from "../core/state.js";
import { fetchJsonList } from "../core/api.js"; // v8.3.17 — a failed fetch is not "no data"
import { countHtml, setListCount } from "../ui/list-controls.js"; // v7.20.11 — shared match count
import { raw, setSafeHtml } from "../core/trusted-types.js";
import { TASK_FIELDS } from "./challenges-admin.js";
import { esc, fmtDt, _syncSortAria, eventKindLabel, eventCollectiveNoun } from "../ui/format.js";
import { ICO } from "../ui/icons.js";
import { overlayDismiss, showModal } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";   // v8.3.20 — a failed "Load older" must say so

export function _fmtHistVal(v){
  if(v===null||v===undefined||v==='')return '<span style="color:var(--muted)">∅</span>';
  if(Array.isArray(v))return v.length?v.map(x=>esc(String(x))).join(', '):'<span style="color:var(--muted)">∅</span>';
  const s=String(v);
  const t=s.length>80?s.slice(0,80)+'…':s;
  return esc(t);
}

// v8.1.0 (PR 13) — History renders stored DETAIL values verbatim, so without a
// mapping `event_kind: tournament` would appear on screen beside a UI that calls
// that same thing a Competition. Two helpers, three call sites (this function plus
// the two inline maps below, only one of which routes through here).
//
// AN UNRECOGNISED KEY OR VALUE RENDERS RAW, exactly as today. That is the rule
// that keeps this safe: a `created` blob written by a future column must not
// vanish from History because this build did not recognise it. Precedent in this
// very file: TASK_FIELDS, and ANALYTICS_EVENT_LABELS in analytics-admin.js.
export function _histFieldLabel(key){
  return key === 'event_kind' ? 'Event type' : key;
}
export function _histFieldValue(key, v){
  // v8.9.0 — a text challenge's correct_answer is a newline-separated list of
  // accepted answers; a bare newline collapses to a space inside the diff line,
  // so join the alternatives visibly instead.
  if(key === 'correct_answer' && typeof v === 'string' && v.includes('\n')) return v.split(/\r?\n/).filter(Boolean).join(' | ');
  if(key !== 'event_kind') return v;
  const label = eventKindLabel(v);
  return label === null ? v : label;
}

// A role in a `role_changed` record: a built-in role as stored; a CUSTOM role by
// the label recorded with the change (`from_label` / `to_label`), since its id
// (`role_<hex>`) means nothing to a reader and nothing at all once it is
// deleted. An older record carries no label and says so.
const _BUILTIN_ROLE_IDS=new Set(['participant','event_admin','admin','superadmin']);
export function _roleHistValue(id,label){
  if(id===null||id===undefined||id===''||_BUILTIN_ROLE_IDS.has(id))return id;
  return label?`${label} (custom role)`:'a custom role';
}

export function _fmtDiffLine(field,before,after){
  return `<div><span style="color:var(--muted)">${esc(_histFieldLabel(field))}:</span> ${_fmtHistVal(_histFieldValue(field,before))} <span style="color:var(--muted)">→</span> ${_fmtHistVal(_histFieldValue(field,after))}</div>`;
}

// v8.12.6 — WHO CAME IN (OR WENT OUT) THROUGH THE LATE-ENTRY WINDOW. The server
// marks an add written while an ended Booth Event was taking late entries with
// `late_entry: true`, and a removal of a late entrant through the window with
// `late_entrant: true`. History renders only `via` for these rows, so without this
// the flag would sit in the record and never reach the organiser reading it — the
// counter-with-no-consumer shape (v7.21.2). `=== true`, so any other value (or an
// older row, which has no key) renders exactly as before.
function _lateEntrantSfx(flag){
  return flag===true?' <span class="hist-late-entrant">(late entrant)</span>':'';
}
// `bypassed_free_email_rule: true` on an account's record (Users & roles Add
// user, a superadmin's profile edit): a personal address the work-address rule
// would refuse was accepted. Said in words, as the flag alone would never reach
// the reader (the import's `created` row lists it among its fields).
function _freeMailSfx(flag){
  return flag===true?' <span style="color:var(--muted)">(a personal address: the work-address rule was skipped)</span>':'';
}
// Sweep #391 — switching a join link off, or replacing it, unties every sign-in
// code (an existing account's, or a newcomer's) already emailed through it: the
// record counts them (`join_link_untied: {codes, proofs}`), said here in words,
// or the count would sit in the record and never reach the organiser reading it.
// None, or an older row (no key), adds nothing.
function _joinUntiedLine(u,replaced){
  const n=u&&typeof u==='object'?(Number(u.codes)||0)+(Number(u.proofs)||0):0;
  if(!(n>0))return '';
  return `<div><span style="color:var(--muted)">${esc(String(n))} sign-in code${n===1?'':'s'} already emailed through ${replaced?'the old link':'the join link'} no longer join${n===1?'s':''} anyone to this event</span></div>`;
}

// Stored details that are not JSON reach the client as `{details_unreadable:
// true}` (lib/audit.js parseStoredDetails). Every renderer of a History row
// (formatEventChange, a challenge's reveal record in _fmtRevealRow) shows this
// one sentence in their place: the row keeps its type, time and actor and says
// so, rather than let a type's own sentence read the missing fields (an email as
// failed, an account as not set up, a reveal as of the answer and the hint).
const _DETAILS_UNREADABLE_HTML='<span style="color:var(--muted)">The details recorded for this entry could not be read</span>';

export function formatEventChange(ev){
  const d=ev.details||{};
  if(d.details_unreadable===true)return _DETAILS_UNREADABLE_HTML;
  switch(ev.event_type){
    case 'edited':
      // v8.10.0 — a STRING value in `changes` is a NOTE, not a from/to pair, and
      // must be rendered as itself. Two writers use that shape: the long-standing
      // rich-text convention ("(body changed — see task_versions)") and the sealed
      // answer ("(sealed answer changed — …)"). Reading `v.from` / `v.to` off a
      // string yields `undefined` twice, so both rendered as "field: ∅ → ∅" — the
      // rich-text case has always done so, and the sealed case cannot be allowed
      // to, because the note IS the information the admin is meant to receive.
      if(d.changes)return Object.entries(d.changes).map(([k,v])=>
        (typeof v==='string')
          ? `<div><span style="color:var(--muted)">${esc(_histFieldLabel(k))}:</span> <span style="color:var(--muted)">${esc(v)}</span></div>`
          : _fmtDiffLine(k,v.from,v.to)).join('')+(d.bypassed_free_email_rule===true?`<div>${_freeMailSfx(true).trim()}</div>`:'')
          +_joinUntiedLine(d.join_link_untied,false);
      return '<span style="color:var(--muted)">—</span>';
    case 'created':{
      const fields=Object.entries(d).filter(([k])=>k!=='via');
      const prefix=d.via?`via <strong>${esc(d.via)}</strong>`:'';
      if(!fields.length)return prefix||`${ICO.sparkles} Created`;
      // This branch does NOT call _fmtDiffLine — it is its own inline map, which is
      // why the helpers are installed at three sites rather than one.
      return (prefix?prefix+'<br>':'')+fields.map(([k,v])=>`<div><span style="color:var(--muted)">${esc(_histFieldLabel(k))}:</span> ${_fmtHistVal(_histFieldValue(k,v))}</div>`).join('');
    }
    case 'ended_manually':return d.via?`Ended manually (<strong>${esc(d.via)}</strong>)`:'Ended manually';
    // v8.12.8 — "Close late entries now". Rendered from `closed_at` (the press
    // instant) at SECOND precision, because exactness is what was asked for — and
    // not from `to`, the stored pin, which is one millisecond EARLIER and would
    // read a second early for a press on a whole second. `from_pinned` null means
    // the deadline it replaced was the automatic one (48 hours after the end).
    case 'late_entry_closed':{
      const at=(d.closed_at||d.to)?esc(fmtDt(d.closed_at||d.to,'full')):'—';
      const from=d.from?esc(fmtDt(d.from,'long')):'—';
      return `Late entries closed early at <strong>${at}</strong>`
        +`<br><span style="color:var(--muted)">the deadline was ${from}${d.from_pinned?'':' (automatic)'}</span>`;
    }
    case 'revived':return d.via?`Revived (${esc(d.via)})`:'Revived';
    case 'cxone_config_changed':return d.cleared?'CxOne config cleared':'CxOne config updated';
    case 'certificate_config_changed':return d.cleared?'Certificate design reset to the platform design'
      :`Certificate design updated${Array.isArray(d.fields)&&d.fields.length?`: <span style="color:var(--muted)">${esc(d.fields.join(', '))}</span>`:''}`;
    case 'look_changed':{
      const to=d.to||{};
      return to.look?`Event look set to <strong>${esc(to.look)}</strong>${to.locked?' (locked for participants)':''}`:'Event look removed';
    }
    case 'team_member_added':return `+ team member: <strong>${esc(d.name||'')}</strong> (${esc(d.role||'')})`;
    case 'team_member_removed':return `− team member: <strong>${esc(d.name||'')}</strong> (${esc(d.role||'')})`;
    case 'team_targets_changed':return `Lead targets: ${esc(String((d.to||{}).lead_target??'none'))} leads, ${esc(String((d.to||{}).hot_lead_target??'none'))} hot`;
    case 'team_report_sent':return `Team report (${esc(d.kind||'')}): ${esc(String(d.sent??0))} sent${d.failed?`, ${esc(String(d.failed))} failed`:''}${d.refused?`, ${esc(String(d.refused))} refused`:''}`;
    case 'team_report_given_up':return `Team report (${esc(d.kind||'')}) given up: it failed ${esc(String(d.passes??0))} times and will not be tried again`;
    case 'lead_contacted':return d.contacted?'Lead marked contacted':'Lead no longer marked contacted';
    // A certificate's PDF fetched (`by_owner`: the holder's own signed-in session).
    // `via:"email_link"` came through the congratulations email's link, which a
    // mail scanner or link prefetcher opens as the holder's own signed-out click
    // would, so such a row says it may be a scanner's rather than claim the holder
    // took it (sweep #402); the holder's own session is never a scanner.
    case 'badge_certificate_downloaded':{
      const who=d.nickname?`: <strong>${esc(d.nickname)}</strong>`:'';
      const how=d.via==='email_link'
        ?(d.by_owner===true?' — from the email link, by its holder':' — from the email link (may be a mail scanner)')
        :d.via==='top3_zip'?' — in the top 3 certificates download'
        :d.via?` (via ${esc(d.via)})`:'';
      return `Certificate PDF downloaded${who}${how?`<span class="hist-via" style="color:var(--muted)">${how}</span>`:''}`;
    }
    // The other certificate records, in the Audit page's words
    // (AUDIT_ACTIVITY_LABELS): the event's History names the holder, a person's
    // History the event. An issue's `via` is "automatic" (the platform's own, as
    // the event ends) or "reissue" (Issue again after a revocation); none is the
    // holder's own collection.
    case 'badge_minted':{
      const who=d.nickname?`: <strong>${esc(d.nickname)}</strong>`:'';
      const how=d.via==='automatic'?' — automatically, by the platform':d.via==='reissue'?' — again, after a revocation':'';
      return `Certificate issued${who}${how?`<span class="hist-via" style="color:var(--muted)">${how}</span>`:''}`;
    }
    case 'badge_image_downloaded':return `Certificate image downloaded${d.nickname?`: <strong>${esc(d.nickname)}</strong>`:''}`;
    // Share pressed (LinkedIn's composer opens). `via:"share_link"` is the
    // congratulations email's one-time link; `by_owner:false` someone holding the
    // certificate's link who is not its holder (only the holder's share publishes
    // its page).
    case 'badge_shared':{
      const who=d.nickname?`: <strong>${esc(d.nickname)}</strong>`:'';
      const how=d.via==='share_link'?' — from the link in the congratulations email':d.by_owner===false?' — not by its holder':'';
      return `Certificate shared${who}${how?`<span class="hist-via" style="color:var(--muted)">${how}</span>`:''}`;
    }
    case 'badge_revoked':{
      const on=(d.competition_name||d.competition_id)?`: <strong>${esc(d.competition_name||d.competition_id)}</strong>`:'';
      const why=(typeof d.reason==='string'&&d.reason.trim())?`<br><span style="color:var(--muted)">Reason: ${esc(d.reason)}</span>`:'';
      return `Certificate revoked${on}${why}`;
    }
    case 'badge_reissued':return `Certificate issued again${(d.competition_name||d.competition_id)?`: <strong>${esc(d.competition_name||d.competition_id)}</strong>`:''}`;
    // Each attempt at the congratulations email (lib/certificate-dispatch.js):
    // `status` sent | failed | suppressed | skipped (with `skipped` its reason),
    // `via` automatic | retry | resend (an organiser's) | reissue.
    case 'certificate_emailed':{
      const on=(d.competition_name||d.competition_id)?`: <strong>${esc(d.competition_name||d.competition_id)}</strong>`:'';
      const how=d.via==='retry'?' — a retry':d.via==='resend'?' — sent again by an organiser':d.via==='reissue'?' — with a certificate issued again':'';
      const sfx=how?`<span class="hist-via" style="color:var(--muted)">${how}</span>`:'';
      if(d.status==='sent')return `Certificate emailed${on}${sfx}`;
      if(d.status==='failed')return `Certificate email failed${on}${sfx}${d.next_attempt_at?`<br><span style="color:var(--muted)">it is tried again at ${esc(fmtDt(d.next_attempt_at,'long'))}</span>`:''}`;
      if(d.status==='suppressed')return `Certificate email not sent${on}${sfx}<br><span style="color:var(--muted)">the address unsubscribed from these emails</span>`;
      if(d.status==='skipped'){
        const why=d.skipped==='revoked'?'the certificate had been revoked':d.skipped==='account_inactive'?'the account is blocked, denied or not approved':d.skipped==='not_member'?'they were no longer in the event':'';
        return `Certificate email not sent${on}${sfx}${why?`<br><span style="color:var(--muted)">${why}</span>`:''}`;
      }
      return `Certificate email${on}${sfx}`;
    }
    // An administrator's Look up a certificate by its code (the holder's History).
    case 'credential_resolved':return `Certificate checked — its code was looked up to find its holder${d.revoked===true?' (the certificate had been revoked)':''}`;
    case 'task_added':return `+ question: <strong>${esc(d.task_title||d.task_id||'')}</strong>`;
    case 'task_removed':return `− question: <strong>${esc(d.task_title||d.task_id||'')}</strong>`;
    case 'scores_recalculated':return `Scores recalculated: <strong>${esc(d.task_title||d.task_id||'')}</strong>${d.reason==='qualifying_tag_added'?' (now a qualifying question)':d.reason==='qualifying_tag_removed'?' (no longer a qualifying question)':d.reason==='restore'?' (a restored version)':d.reason==='import'?' (an import changed whether it is a qualifying question)':''}`;
    case 'user_added':{const via=d.via?` (via <em>${esc(d.via)}</em>)`:'';return `+ participant: <strong>${esc(d.nickname||d.user_id||'')}</strong>${via}${_lateEntrantSfx(d.late_entry)}${_freeMailSfx(d.bypassed_free_email_rule)}`;}
    case 'user_removed':return `− participant: <strong>${esc(d.nickname||d.user_id||'')}</strong>${_lateEntrantSfx(d.late_entrant)}`;
    case 'timeslot_added':return `+ session: <strong>${esc(d.name||d.timeslot_id||'')}</strong>`;
    case 'timeslot_deleted':return `− session: <strong>${esc(d.name||d.timeslot_id||'')}</strong>`;
    case 'verified':return 'Email verified';
    case 'approved':return d.via?`User approved (${esc(d.via)})`:'User approved';
    case 'blocked':return 'User blocked';
    case 'unblocked':return 'User unblocked';
    case 'unlocked':return 'Account lockout cleared';
    case 'password_reset':return 'Password reset link issued';
    case 'role_changed':return _fmtDiffLine('role',_roleHistValue(d.from,d.from_label),_roleHistValue(d.to,d.to_label));
    case 'tag_added':return `+ tag: <strong>${esc(d.tag||'')}</strong>`;
    case 'tag_removed':return `− tag: <strong>${esc(d.tag||'')}</strong>`;
    // v8.1.0 (PR 13) — the CONTAINER noun follows the collective, or L4 passes
    // while the dialog is visibly wrong: a Booth Event added to a participant
    // would read "+ competition: Friday Booth". The `+ session:` / `− session:`
    // pair above deliberately does NOT move — only Competitions have sessions.
    case 'added_to_competition':{const via=d.via?` (via <em>${esc(d.via)}</em>)`:'';return `+ ${esc(eventCollectiveNoun())}: <strong>${esc(d.competition_name||d.competition_id||'')}</strong>${via}${_lateEntrantSfx(d.late_entry)}`;}
    case 'removed_from_competition':return `− ${esc(eventCollectiveNoun())}: <strong>${esc(d.competition_name||d.competition_id||'')}</strong>${_lateEntrantSfx(d.late_entrant)}`;
    // v8.12.6 — the join-link enrolment had no line of its own and rendered as its
    // raw event type; it gains one so a late arrival through the QR can say so.
    // v8.13.3 — a regenerate replaces the short join code too; `rotated` names the
    // fields (never their values). An older row carries no list, and rotated the
    // link alone, so it says so rather than claiming a code it did not replace.
    case 'self_enroll_regenerated':return ((Array.isArray(d.rotated)&&d.rotated.includes('join_code'))?'Join link and short code regenerated':'Join link regenerated')
      +_joinUntiedLine(d.join_link_untied,true);
    case 'self_enrolled':return `Joined <strong>${esc(d.competition_name||d.competition_id||'')}</strong> through its join link${_lateEntrantSfx(d.late_entry)}`;
    case 'updated':{
      if(d.from!==undefined||d.to!==undefined)return _fmtDiffLine('value',d.from,d.to);
      const fields=Object.entries(d);
      // The second inline copy (defensive — `updated` carries no kind today).
      return fields.map(([k,v])=>`<div><span style="color:var(--muted)">${esc(_histFieldLabel(k))}:</span> ${_fmtHistVal(_histFieldValue(k,v))}</div>`).join('');
    }
    case 'cleared':return 'Cleared';
    // ── Auto-start/end by scheduler ──
    case 'auto_started':return d.scheduled_start?`Started automatically at scheduled time (${esc(fmtDt(d.scheduled_start,'long'))})`:'Started automatically';
    // The backend records reason:'all_participants_solved' (live submit auto-end,
    // server.js) or 'all_participants_solved_all' (perf-seed); the old check for the
    // never-emitted 'all_solved' literal meant this detail line never rendered.
    // v8.3.11 — `exhausted_participants` is the discriminator. Since v8.1.0 the
    // predicate behind this event means "solved OR out of attempts", so on a
    // capped event the old unconditional sentence was a false claim in the one
    // record an admin opens to find out what happened. The key is emitted ONLY
    // when non-zero, so every historical row and every uncapped event renders
    // byte-identically to before — absence is the existing shape, not a new one.
    case 'auto_ended':{
      if(d.scheduled_end)return `Ended automatically at scheduled time (${esc(fmtDt(d.scheduled_end,'long'))})`;
      if(d.reason!=='all_participants_solved'&&d.reason!=='all_participants_solved_all')return 'Ended automatically';
      const ex=Number(d.exhausted_participants)||0;
      return ex>0
        ? `Ended automatically: every participant finished — ${ex} ran out of attempts rather than solving everything`
        : 'Ended automatically: all participants solved all questions';
    }
    // ── Login / logout ──
    case 'login_success':{
      const m=d.method?` (${esc(d.method)})`:'';
      const ip=d.ip?`<br><span style="color:var(--muted)">from ${esc(d.ip)}</span>`:'';
      const term=d.terminated_sessions?`<br><span style="color:var(--muted)">previous concurrent session${d.terminated_sessions>1?'s':''} ended: ${Number(d.terminated_sessions)}</span>`:'';
      return `Login successful${m}${ip}${term}`;
    }
    case 'login_failed':{const reason=d.reason?esc(d.reason):'unknown';const ip=d.ip?`<br><span style="color:var(--muted)">from ${esc(d.ip)}</span>`:'';return `Login failed: <strong>${reason}</strong>${ip}`;}
    case 'logout_manual':return d.ip?`Logged out<br><span style="color:var(--muted)">from ${esc(d.ip)}</span>`:'Logged out';
    // ── Impersonation (v7.14.0; the VIEW since v8.12.1) ──
    // These land on the TARGET's history, attributed to the acting admin. An
    // event admin target can be looked at through two views, so the row says
    // which one was opened / switched to / in force at the close; a participant
    // target has one, and the wording stays as it was for them.
    case 'impersonation_started':{
      const tier=d.read_only?'read-only':'full access';
      const view=d.target_role==='event_admin'?(d.view==='admin'?' — their Event Admin Panel':' — their participant view'):'';
      const ip=d.ip?`<br><span style="color:var(--muted)">from ${esc(d.ip)}</span>`:'';
      return `Impersonation started (${tier})${esc(view)}${ip}`;
    }
    case 'impersonation_ended':{
      // v8.13.4 — words for EVERY reason the server records. `login`,
      // `linkedin_callback` and `password_reset` had none and rendered a raw
      // `ended (<code>)`; csrf-session-end.api.spec.js now fails on the next
      // reason added without a key here.
      const why={
        manual:'exited',
        target_inactive:'ended — this account became inactive',
        logout:'ended by the admin signing out',
        session_purged:'ended — the admin\'s session was replaced',
        session_expired:'ended — the admin\'s session expired',
        actor_inactive:'ended — the admin lost admin access',
        login:'ended — the admin signed in again in the same browser',
        linkedin_callback:'ended — the admin signed in with LinkedIn in the same browser',
        password_reset:'ended — the admin completed a password reset in the same browser',
        csrf_invalid:'ended — a request carried an out-of-date security token, which signs the admin out',
      }[d.reason]||`ended (${esc(d.reason||'')})`;
      const dur=Number.isFinite(Number(d.duration_ms))&&d.duration_ms!=null?` after ${Math.max(1,Math.round(Number(d.duration_ms)/60000))} min`:'';
      const view=d.view==='admin'?' — last in their Event Admin Panel':'';
      return `Impersonation ${why}${dur}${esc(view)}`;
    }
    case 'admin_view_toggled':{
      const to=d.mode==='admin'?'the Admin View':'the Participant View';
      const imp=d.impersonated_by?` <span style="color:var(--muted)">(while impersonated by ${esc(d.impersonated_by)})</span>`:'';
      return `Switched to ${to}${imp}`;
    }
    case 'logout_single_session':return 'Session ended (logged in elsewhere)';
    // v8.13.4 — the type had no case at all, so every row (a role change, a
    // block, a password change…) rendered as a bare muted `sessions_invalidated`
    // with its reason hidden. The count means different things per reason:
    // an admin's role change, block or deny ends EVERY session the account
    // holds (the purge excludes no session — the admin's request is not one of
    // the target's), and so did a password RESET (older rows; fix-delta review:
    // it was completed from the emailed link's page, whose session was not one of
    // the account's, and the route regenerated anyway — "a fresh login on every
    // device, including the one that completed the flow"); a password change
    // or set ends the OTHER sessions and keeps the one that asked;
    // `csrf_invalid` records the end of the one session that presented an
    // out-of-date token. Each is worded so.
    case 'sessions_invalidated':{
      const ip=d.ip?`<br><span style="color:var(--muted)">from ${esc(d.ip)}</span>`:'';
      if(d.reason==='csrf_invalid'){
        const seat=d.acting_as?` while impersonating ${esc(d.acting_as)}`:'';
        return `Signed out — a request carried an out-of-date security token${seat}${ip}`;
      }
      const why={role_change:'role changed',blocked:'account blocked',denied:'approval denied',password_changed:'password changed',password_set:'password set',password_reset:'password reset'}[d.reason];
      const n=Number(d.purged)||0;
      const all=d.reason==='role_change'||d.reason==='blocked'||d.reason==='denied'||d.reason==='password_reset';
      const what=all?(n===1?'Signed out of 1 session':`Signed out of all ${n} sessions`):(n===1?'1 other session signed out':`${n} other sessions signed out`);
      return `${what}${why?` — ${why}`:(d.reason?` (${esc(d.reason)})`:'')}${ip}`;
    }
    case 'auto_locked':return d.until?`Account locked after ${esc(String(d.failed_count||''))} failed attempts<br><span style="color:var(--muted)">until ${esc(fmtDt(d.until,'long'))}</span>`:'Account locked';
    case 'auto_unlocked':return 'Lockout expired';
    // ── Self-initiated ──
    case 'self_registered':{const via=d.via?` (${esc(d.via)})`:'';return `Self-registered${via}`;}
    case 'self_verified':return d.via?`Email verified (${esc(d.via)})`:'Email verified';
    case 'profile_updated_self':
      if(d.changes)return '<span style="color:var(--muted)">self-edit</span><br>'+Object.entries(d.changes).map(([k,v])=>_fmtDiffLine(k,v.from,v.to)).join('');
      return 'Profile updated';
    case 'password_changed':return 'Password changed';
    // Program grades (27 Nov 2026): the learner closed an attempt under the pass
    // mark and started again; the closed attempt's grade is in the details.
    case 'program_retake_started':{
      const pct=Number.isFinite(Number(d.grade_permille))?`${(Number(d.grade_permille)/10).toFixed(1).replace(/\.0$/,'')}%`:'';
      return `Started the program again (attempt ${esc(String(d.attempt||''))})${pct?`<br><span style="color:var(--muted)">attempt ${esc(String(d.closed_attempt||''))} ended on ${esc(pct)}: ${esc(String(d.points??''))} of ${esc(String(d.max_points??''))} points</span>`:''}`;
    }
    case 'password_reset_requested':return 'Password reset requested';
    case 'password_reset_completed':return 'Password reset completed';
    case 'session_chosen':{const prev=d.previous_timeslot_id?' (switched)':'';return `Session chosen: <strong>${esc(d.timeslot_name||'')}</strong> in ${esc(d.competition_name||'')}${prev}`;}
    case 'first_joined':{const tsName=d.timeslot_name?` → ${esc(d.timeslot_name)}`:'';const who=d.nickname?`<strong>${esc(d.nickname)}</strong> `:'';return `${who}joined ${esc(d.competition_name||'')}${tsName} for the first time`;}
    case 'reminder_requested':{const tsName=d.timeslot_id?` → ${esc(d.timeslot_id)}`:'';return `Start reminder requested for ${esc(d.competition_name||'')}${tsName}`;}
    case 'reminder_skipped':return `Start reminder for <strong>${esc(d.competition_name||'')}</strong> not sent: it had already started`;
    // ── Email sent ──
    case 'email_sent':{const statusStr=d.success?`<span class="hist-ok">${ICO.check} sent</span>`:`<span class="hist-bad">${ICO.x} failed</span>${d.error?'<br><span style="color:var(--muted)">'+esc(d.error)+'</span>':''}`;return `${statusStr} • <strong>${esc(d.reason||'')}</strong>${d.subject?'<br><span style="color:var(--muted)">'+esc(d.subject)+'</span>':''}`;}
    // ── CxOne ──
    // v8.3.17 — A CONFIGURED GROUP THAT WAS NOT GRANTED IS NOT A GREEN TICK.
    // This rendered `success:true` as "✓ provisioned" for a participant who had
    // an account and no access, because lib/cxone.js recorded success
    // unconditionally. The server now rides `group_assigned` alongside `success`
    // and this is its consumer — a field with no human consumer is itself the
    // defect (v7.21.2). Absent on every historical row and every deployment with
    // no group configured, which render exactly as before.
    case 'cxone_provisioned':{
      // NOT LINKED, NOT FAILED: the account this participant's set-up reached was
      // being removed by the platform (it had been made for someone deleted since),
      // so the set-up waited. Which participant is never said.
      if(d.deferred){
        const next=d.stopped==='shutdown'
          ?'the platform restarted before it tried again, and tries again once it is back in service'
          :d.retry_scheduled
            ?'the platform will try again shortly'
            :'it was not retried automatically — to try again, assign them to this event again while it still accepts participants';
        return `CxOne: <span style="color:var(--yellow)">${ICO.alertTriangle}</span> not set up yet — the Checkmarx One account with this address was being removed by the platform; ${next}`;
      }
      const groupMissing=d.group_name&&d.group_assigned===false;
      const statusStr=!d.success
        ?`<span style="color:var(--red)">${ICO.x}</span> failed${d.error?': '+esc(d.error):''}`
        :groupMissing
          ?`<span style="color:var(--yellow)">${ICO.alertTriangle}</span> account created, but group <strong>${esc(d.group_name)}</strong> was NOT found — this participant has no access`
          :`<span style="color:var(--green)">${ICO.check}</span> provisioned`;
      const uname=d.username?` as <strong>${esc(d.username)}</strong>`:'';
      const existed=d.already_existed?' (already existed)':'';
      // How the account was identified. Only present since v8.3.17, and only
      // when the account was found by SEARCH rather than created outright.
      const basis=d.matched_by?` <span style="color:var(--muted)">[matched by ${esc(d.matched_by==='prior_binding'?'a previous binding':d.matched_by)}]</span>`:'';
      return `CxOne${uname}: ${statusStr}${existed}${basis}`;
    }
    // The platform removed the Checkmarx One account this participant was linked
    // to (it had been made for someone deleted since); the link went with it.
    case 'cxone_binding_cleared':{
      const why={cxone_disabled:'Checkmarx One accounts are off for this event',membership_removed:'they are no longer in the event',event_deleted:'the event was deleted'};
      const next=d.reprovision?'a new one is being set up':`no new one is set up — ${why[d.reprovision_skipped]||esc(d.reprovision_skipped||'')}`;
      return `CxOne: link to a Checkmarx One account cleared — the platform removed that account; ${next}`;
    }
    // "Not your event? Continue without it": the code this browser was emailed
    // with an event still signs in, without joining it.
    case 'login_code_event_dropped':
      return `Sign-in code no longer joins ${d.competition_name?`<strong>${esc(d.competition_name)}</strong>`:'its event'} (they chose to continue without it)`;
    case 'login_code_refused':{
      // v8.7.6 — the whole point of recording it is the REASON, so the row says
      // it in words rather than leaving an operator to read a raw enum. Reported
      // as "the code never arrives and the log shows nothing". Three reasons are
      // no longer recorded (`already_has_password`, `not_participant`,
      // `not_approved`) and keep their words for older rows.
      const why={
        already_has_password:'this account signs in with a password, so codes do not apply',
        not_participant:'codes are for participant accounts only',
        account_inactive:'the account is blocked or denied',
        not_approved:'the account is not approved yet',
        send_cap_reached:'the send limit for the code it already holds was reached',
        // v8.8.25 — the SUB-budget, and it reads differently on purpose: the
        // account can still be sent a code, just not from where this request
        // came from, so the remedy is not only the desk reveal.
        origin_cap_reached:'this network had already been sent its share of codes for this account — the account itself can still be sent one',
        not_eligible:'the account is not eligible',
        recently_sent:'a code sent under two minutes ago, or a desk code still in use, was left for the holder to type',
      }[d.reason]||esc(d.reason||'refused');
      return `Sign-in code NOT sent — ${why}`;
    }
    default:return `<span style="color:var(--muted)">${esc(ev.event_type)}</span>`;
  }
}

export function _stripHtml(s){return String(s||'').replace(/<[^>]+>/g,' ');}

// v8.12.1 — WHOSE HAND, when it was not the seat's. `reqContext` spreads
// `impersonated_by` (the acting admin) and `acting_as` (the seat) onto every
// audit row written under impersonation, on top of the participant-surface
// convention that names the participant in `changed_by` and the admin beside
// it. The By cell renders both shapes from one helper: the participant's row
// reads "alice (impersonated by carol)", an organiser-panel row reads
// "carol (through bob's admin view)" — so an operator can tell an
// organiser's own act from an administrator's act through their seat.
export function _histByHtml(ev){
  const by=esc(ev.changed_by||'');
  const d=ev.details||{};
  if(!d.impersonated_by)return by;
  if(ev.changed_by&&ev.changed_by!==d.impersonated_by)return `${by} <span class="hist-by-imp" style="color:var(--muted)">(impersonated by ${esc(d.impersonated_by)})</span>`;
  if(d.acting_as)return `${by} <span class="hist-by-imp" style="color:var(--muted)">(through ${esc(d.acting_as)}'s view)</span>`;
  return `${by} <span class="hist-by-imp" style="color:var(--muted)">(impersonating)</span>`;
}

export function _fmtAttachmentsList(arr){
  if(!Array.isArray(arr)||!arr.length)return '<span style="color:var(--muted)">∅</span>';
  return arr.map(a=>esc(String(a&&a.display_name||'attachment'))).join(', ');
}

export function _fmtAttachmentsDiff(before,after){
  const bArr=Array.isArray(before)?before:[];
  const aArr=Array.isArray(after)?after:[];
  const bById=new Map(bArr.map(x=>[x&&x.id,x]));
  const aById=new Map(aArr.map(x=>[x&&x.id,x]));
  const added=[],removed=[],renamed=[];
  for(const [id,x] of aById){if(!bById.has(id))added.push(x&&x.display_name||'attachment');}
  for(const [id,x] of bById){if(!aById.has(id))removed.push(x&&x.display_name||'attachment');}
  for(const [id,x] of aById){const b=bById.get(id);if(b&&b.display_name!==x.display_name)renamed.push(`${b.display_name} → ${x.display_name}`);}
  const parts=[];
  if(added.length)parts.push(`<span class="hist-ok">+${added.length}</span> ${added.map(esc).join(', ')}`);
  if(removed.length)parts.push(`<span class="hist-bad">−${removed.length}</span> ${removed.map(esc).join(', ')}`);
  if(renamed.length)parts.push(`renamed: ${renamed.map(esc).join(', ')}`);
  return parts.length?parts.join(' · '):'<span style="color:var(--muted)">∅</span>';
}

// v8.10.0 — the fields a sealed snapshot arrives WITHOUT. The server strips them
// at the READ (routes/challenges.js), retroactively over every version, so the
// client never holds them for a challenge it may not read — which is why there is
// no client-side gate here and must not be one: a renderer that decided this would
// be a second copy of the rule, and the value would already be in the browser.
// What the client owes is a SENTENCE, so a version diff with no answer line reads
// as "sealed" rather than "nothing changed".
// v8.12.2 — the hint joined the sealed set (lib/answer-seal.js SEALED_FIELDS,
// mirrored here because public/js cannot import lib/).
const _SEALED_TASK_FIELDS=['correct_answer','explanation','hint'];
function _sealedFieldNote(curr,prev){
  const gone=_SEALED_TASK_FIELDS.some(f=>!(f in curr)||(prev&&!(f in prev)));
  return gone
    ? `<div><span style="color:var(--muted)">answer:</span> <span style="color:var(--muted)">sealed — only the question's author, or a superadmin who reveals it on the record, can see it</span></div>`
    : '';
}

// v8.12.2 — A REVEAL ROW IS A RECORD, NOT A VERSION. `sealed_reveal` rows carry
// a snapshot only because every row must; what they SAY is who was shown the
// sealed answer and hint, and under impersonation whose seat they sat in. They
// render as that sentence, are skipped as a diff baseline (or the NEXT edit
// would diff against a copy of the state it started from and hide attachment
// changes made in between), never take the "current" badge, and offer no
// Restore (the route refuses one too).
export function _isRevealRow(v){return !!v&&v.change_type==='sealed_reveal';}
export function _fmtRevealRow(v){
  // A record whose details cannot be read says so (the type column still says
  // sealed_reveal), never which fields, view or seat its sentence would default to.
  if(v&&v.details&&v.details.details_unreadable===true)return _DETAILS_UNREADABLE_HTML;
  const d=(v&&v.details&&typeof v.details==='object')?v.details:{};
  const fields=Array.isArray(d.fields)&&d.fields.length?d.fields.map(f=>f==='correct_answer'?'answer':f).join(', '):'answer and hint';
  // A withheld seat names no view either (the server drops `via` for it too):
  // "an impersonated organiser's panel" beside "an account outside your events"
  // would say which KIND of account was withheld (second review).
  const where=d.acting_as_withheld?''
    :d.via==='participant_view'?' in the participant view'
    :d.via==='participant_hint'?' by revealing the hint as a participant'
    :d.via==='impersonated_admin_view'?' in an impersonated organiser\'s panel':'';
  // v8.12.2 — the seat is resolved per reader on the server: named when this
  // reader could see that person anyway, withheld when they are enrolled only in
  // somebody else's event, and never an address once the account is deleted.
  const seat=!d.impersonated_by?''
    :d.acting_as?` while impersonating <strong>${esc(d.acting_as)}</strong>`
    :d.acting_as_withheld?' while impersonating an account outside your events'
    :d.acting_as_deleted?' while impersonating an account that has since been deleted'
    :' while impersonating another account';
  return `<div>${ICO.unlock} Sealed ${esc(fields)} <strong>revealed to a superadmin</strong>${where}${seat}.</div>`;
}

export function _diffTaskVersion(v,prev){
  let curr;
  try{curr=JSON.parse(v.snapshot||'{}');}catch{return '<span style="color:var(--muted)">—</span>';}
  if(!prev){
    const lines=TASK_FIELDS.map(f=>{const val=curr[f];if(val==null||val===''||(Array.isArray(val)&&!val.length))return null;
      const rendered=f==='attachments'?_fmtAttachmentsList(val):_fmtHistVal(val);
      return `<div><span style="color:var(--muted)">${f}:</span> ${rendered}</div>`;}).filter(Boolean);
    const _sn=_sealedFieldNote(curr,null);
    return `${ICO.sparkles} Created`+((lines.length||_sn)?'<br>'+lines.join('')+_sn:'');
  }
  let before;
  try{before=JSON.parse(prev.snapshot||'{}');}catch{return '<span style="color:var(--muted)">—</span>';}
  const lines=[];
  for(const f of TASK_FIELDS){
    const bv=before[f],cv=curr[f];
    if(f==='attachments'){
      if(JSON.stringify(bv||[])!==JSON.stringify(cv||[])){
        lines.push(`<div><span style="color:var(--muted)">${f}:</span> ${_fmtAttachmentsDiff(bv,cv)}</div>`);
      }
    }else if(Array.isArray(bv)||Array.isArray(cv)){
      if(JSON.stringify(bv||[])!==JSON.stringify(cv||[]))lines.push(_fmtDiffLine(f,bv,cv));
    }else if((bv||null)!==(cv||null)){
      lines.push(_fmtDiffLine(f,bv,cv));
    }
  }
  const _sn=_sealedFieldNote(curr,before);
  if(_sn)lines.push(_sn);
  return lines.length?lines.join(''):'<span style="color:var(--muted)">No field changes</span>';
}

// v8.12.6 — A HISTORY DIALOG SHOWS WHAT YOU OPENED IT FOR. The three openers
// below await their first page and only then build the dialog, so opening A's
// history and then B's (A slow) stacked TWO #hist-overlay elements: S._histState
// became A's, and renderHistoryDialog — which paints by id, i.e. into the FIRST
// dialog — wrote A's rows into the one titled B. The LATEST open wins: each
// opener takes a token before its await and drops a superseded open after it,
// saying nothing (an error for a dialog the admin moved on from is its own wrong
// answer, the v7.21.15 rule). openHistoryDialog bumps the token too, so an
// opener still in flight cannot land over a dialog opened after it, and it
// replaces any dialog already showing rather than stacking a second one.
let _histOpenSeq=0;

export function openHistoryDialog({title,events,isTaskHistory=false,task=null,taskId=null}){
  _histOpenSeq++;
  document.querySelectorAll('#hist-overlay').forEach(o=>o.remove());
  // Precompute diffs (for task history) and normalise rows for display/sort/search
  let currentVersionId=null;
  if(isTaskHistory&&events.length){
    const verSorted=[...events].filter(v=>!_isRevealRow(v)).sort((a,b)=>a.version_num-b.version_num);
    currentVersionId=verSorted[verSorted.length-1]?.id||null;
  }
  const items=events.map((ev,idx)=>{
    const type=ev.event_type||ev.change_type||'';
    let changeHtml;
    if(isTaskHistory&&_isRevealRow(ev)){
      changeHtml=_fmtRevealRow(ev);
    }else if(isTaskHistory){
      // For tasks, "prev" by version_num is the next higher index in DESC-ordered
      // list — skipping reveal records, which are not versions (v8.12.2).
      let prev=events[idx+1];
      let k=idx+1;
      while(prev&&_isRevealRow(prev)){k++;prev=events[k];}
      changeHtml=_diffTaskVersion(ev,prev);
    }else{
      changeHtml=formatEventChange(ev);
    }
    const details=ev.details||{};
    const searchText=`${type} ${ev.changed_by||''} ${_stripHtml(changeHtml)} ${JSON.stringify(details)}`.toLowerCase();
    return{type,when:ev.changed_at,by:ev.changed_by||'',changeHtml,searchText,raw:ev};
  });
  S._histState={items,sortCol:'when',sortAsc:false,page:1,pageSize:30,title,isTaskHistory,task,taskId,currentVersionId,total:arguments[0].total||events.length,fetchUrl:arguments[0].fetchUrl||null,snapshotBefore:arguments[0].snapshotBefore??null,snapshotTie:arguments[0].snapshotTie??null};
  // Build DOM
  const overlay=document.createElement('div');
  overlay.id='hist-overlay';
  const actionCol=isTaskHistory?'<th scope="col" style="text-align:center">Action</th>':'';
  setSafeHtml(overlay, `<div class="card history-card" role="dialog" aria-modal="true" aria-labelledby="hist-title">
    <div class="history-header">
      <h3 id="hist-title">${esc(title)}</h3>
      <button class="btn sm secondary" data-action="history-close">Close</button>
    </div>
    <div class="history-toolbar">
      <div class="search-wrap"><input id="hist-search" placeholder="Search history..." aria-label="Search history" data-input-action="history-search"/><button class="search-clear hidden" id="hist-search-clear" data-action="history-search-clear" aria-label="Clear history search"><span aria-hidden="true">×</span> Clear</button></div>
      ${countHtml('hist-search',{noun:'entry',nounPlural:'entries'})}
    </div>
    <div class="card table-card history-table-card"><table>
      <thead><tr>
        <th scope="col" class="sortable" data-action="history-sort" data-col="type">Type<span id="sort-hist-type-icon"></span></th>
        <th scope="col" class="sortable" data-action="history-sort" data-col="when">When<span id="sort-hist-when-icon"></span></th>
        <th scope="col" class="sortable" data-action="history-sort" data-col="by">By<span id="sort-hist-by-icon"></span></th>
        <th scope="col">Change</th>
        ${actionCol}
      </tr></thead>
      <tbody id="hist-body"></tbody>
    </table></div>
    <div id="hist-pagination" class="pagination"></div>
  </div>`);
  document.body.appendChild(overlay);
  overlayDismiss(overlay,()=>closeHistoryDialog());
  setTimeout(()=>document.getElementById('hist-search')?.focus(),0);
  renderHistoryDialog();
}

export function _histSort(col){
  if(!S._histState)return;
  if(S._histState.sortCol===col)S._histState.sortAsc=!S._histState.sortAsc;
  else{S._histState.sortCol=col;S._histState.sortAsc=col!=='when';} // default DESC only for timestamp
  S._histState.page=1;
  renderHistoryDialog();
}

export function renderHistoryDialog(){
  if(!S._histState)return;
  const {items,sortCol,sortAsc,page,pageSize,isTaskHistory,task,taskId,currentVersionId}=S._histState;
  let data=[...items];
  // Search
  const q=(document.getElementById('hist-search')?.value||'').toLowerCase().trim();
  if(q)data=data.filter(i=>i.searchText.includes(q));
  // Sort
  data.sort((a,b)=>{
    let va,vb;
    if(sortCol==='when'){va=new Date(a.when||0).getTime();vb=new Date(b.when||0).getTime();return sortAsc?va-vb:vb-va;}
    va=(a[sortCol]||'').toLowerCase();vb=(b[sortCol]||'').toLowerCase();
    return sortAsc?String(va).localeCompare(String(vb)):String(vb).localeCompare(String(va));
  });
  // Sort icons
  document.querySelectorAll('[id^="sort-hist-"][id$="-icon"]').forEach(el=>el.textContent='');
  const ic=document.getElementById(`sort-hist-${sortCol}-icon`);
  if(ic)ic.textContent=sortAsc?' ▲':' ▼';
  _syncSortAria(ic,sortAsc); // audit v7.7.33 (AL10) — aria-sort on the active th
  // Paginate
  const totalFiltered=data.length;
  // v7.20.11 — say how many entries the search matched. The toolbar is static
  // markup and only #hist-body / #hist-pagination are re-rendered, so painting
  // by id here never disturbs what the operator is typing.
  // `loadedOf` when there is more on the server than has been fetched: this
  // dialog loads incrementally ("Load older (N more)"), so a search covers only
  // what is in hand and a bare count would describe a slice as the whole. Same
  // reasoning as the unsubscribed list's 1000-row cap (v7.16.7).
  const _histMore=!!(S._histState.fetchUrl&&items.length<(S._histState.total||items.length));
  setListCount('hist-search',{matched:totalFiltered,total:items.length,filtered:!!q,
    ...(_histMore?{loadedOf:items.length}:{})});
  const totalPages=Math.max(1,Math.ceil(totalFiltered/pageSize));
  if(S._histState.page>totalPages)S._histState.page=totalPages;
  const startIdx=(S._histState.page-1)*pageSize;
  const pageData=data.slice(startIdx,startIdx+pageSize);
  // Render rows
  const body=document.getElementById('hist-body');
  if(!body)return;
  setSafeHtml(body, pageData.length?pageData.map(i=>{
    const actionCell=isTaskHistory?`<td style="text-align:center">${i.raw.id===currentVersionId
      ?'<span class="badge history-current-badge">current</span>'
      :_isRevealRow(i.raw)
      ?'<span class="cell-empty" style="font-size:var(--fs-12)" title="This entry records a sealed answer being revealed; it is not a version of the question.">Record</span>'
      :(task?.locked
        ?`<span class="history-locked-icon" title="Locked">${ICO.lock}</span>`
        // v8.8.5 — RESTORE IS ALWAYS A SCORING EDIT, and this dialog offered it
        // on any challenge the actor could merely VIEW. `POST /tasks/:id/restore`
        // takes `taskScoringEditDenied` UNCONDITIONALLY — a restore rewrites the
        // whole row from a snapshot, so it can move the correct answer, the
        // difficulty and the published/active flags of a challenge another
        // organiser's event is scoring on. Every button on such a row was certain
        // to 403, one line from a kebab note already saying "you can use it, not
        // change it". Withheld WITH its reason, per v7.14.2.
        :(task&&Array.isArray(task.competing_in)&&task.competing_in.length
          // v8.12.0 — a competitor's reason comes first, or a superadmin is told a
          // rule that does not bind them (the v8.10.1 wrong-reason lesson).
          ?`<span class="cell-empty" style="font-size:var(--fs-12)" title="You are competing in an event that holds this question, so you cannot change it.">Not while competing</span>`
          :task&&task.can_edit_scoring===false
          ?`<span class="cell-empty" style="font-size:var(--fs-12)" title="Restoring a version rewrites the question's answer and difficulty, which another organiser's event is scoring on.">Not yours to restore</span>`
          :`<button class="btn sm secondary history-restore-btn" data-action="task-restore-version" data-task-id="${esc(taskId)}" data-version-id="${esc(i.raw.id)}" data-version-num="${Number(i.raw.version_num)}">Restore</button>`))}</td>`:'';
    return `<tr>
      <td><span class="badge history-type-badge">${esc(i.type)}</span></td>
      <td class="cell-ts">${fmtDt(i.when)}</td>
      <td class="cell-ts">${_histByHtml(i.raw)}</td>
      <td class="history-change-cell">${i.changeHtml}</td>
      ${actionCell}
    </tr>`;
  }).join(''):`<tr><td colspan="${isTaskHistory?5:4}" class="table-empty-row">No history entries match.</td></tr>`);
  // Pagination
  const pagDiv=document.getElementById('hist-pagination');
  const totalLoaded=S._histState.items.length;
  const totalAvailable=S._histState.total||totalLoaded;
  const hasMore=S._histState.fetchUrl&&totalLoaded<totalAvailable;
  const loadMoreBtn=hasMore?`<button class="history-load-more" data-action="history-load-more">Load older (${totalAvailable-totalLoaded} more)</button>`:'';
  if(pagDiv)setSafeHtml(pagDiv, `
    <button data-action="history-page-first" ${S._histState.page<=1?'disabled':''}>First</button>
    <button data-action="history-page-prev" ${S._histState.page<=1?'disabled':''}>Prev</button>
    <span class="page-info">Page ${S._histState.page} of ${totalPages} (${totalFiltered} total${hasMore?`, ${totalAvailable} on server`:''})</span>
    <button data-action="history-page-next" ${S._histState.page>=totalPages?'disabled':''}>Next</button>
    <button data-action="history-page-last" data-total-pages="${totalPages}" ${S._histState.page>=totalPages?'disabled':''}>Last</button>
    <select data-change-action="history-page-size" aria-label="Results per page">
      ${[30,50,100,200].map(n=>`<option value="${n}" ${pageSize===n?'selected':''}>${n} / page</option>`).join('')}
    </select>${loadMoreBtn}`);
}

export function closeHistoryDialog(){document.getElementById('hist-overlay')?.remove();S._histState=null;}

export async function _fetchEventsPaged(url, offset=0, limit=500, snapshotBefore=null, snapshotTie=null){
  try{
    const qs=[`offset=${offset}`,`limit=${limit}`];
    if(snapshotBefore)qs.push(`snapshot_before=${encodeURIComponent(snapshotBefore)}`);
    // v7.21.19 (audit F4) — the TIE token travels with the anchor. Without it the
    // server falls back to the millisecond-only filter and same-ms rows can shift
    // page boundaries under bursty writes. See submissions-admin.js.
    if(snapshotTie)qs.push(`snapshot_tie=${encodeURIComponent(snapshotTie)}`);
    const r=await fetch(`${url}?${qs.join('&')}`);
    // v8.3.20 — a 500's error body PARSES, so without this the object below fell
    // through to `d.events||[]` and rendered "No history available yet." for a
    // failed read. `failed:true` lets the caller say so instead of asserting
    // that a participant has no history.
    if(!r.ok)return{failed:true,events:[],total:0,snapshotBefore:null,snapshotTie:null};
    const d=await r.json();
    if(Array.isArray(d))return{events:d,total:d.length,snapshotBefore:null,snapshotTie:null};
    return{events:d.events||[],total:d.total||0,
      snapshotBefore:typeof d.snapshot_before==='string'?d.snapshot_before:null,
      snapshotTie:typeof d.snapshot_tie==='string'?d.snapshot_tie:null};
  }catch{return{failed:true,events:[],total:0,snapshotBefore:null,snapshotTie:null};}
}

export async function showCompetitionHistory(compId){
  const seq=++_histOpenSeq;
  const comp=S.adminCompetitionsData.find(c=>c.id===compId);
  const {events,total,snapshotBefore,snapshotTie,failed}=await _fetchEventsPaged(`/api/admin/competitions/${compId}/events`);
  if(seq!==_histOpenSeq)return;   // v8.12.6 — superseded by a later open
  // v8.3.20 — a FAILED read is not "no history". Same rule showTaskHistory below
  // has carried since v8.3.17; these two siblings still asserted the confident
  // wrong answer.
  if(failed){await showModal({title:'History',message:'Could not load history. Check your connection and try again.',confirmText:'OK',cancelText:null});return;}
  if(!events.length){await showModal({title:'History',message:'No history available yet.',confirmText:'OK',cancelText:null});return;}
  openHistoryDialog({title:`History: ${comp?.name||''}`,events,total,fetchUrl:`/api/admin/competitions/${compId}/events`,snapshotBefore,snapshotTie});
}

export async function showUserHistory(userId){
  // People's row, else the admin account a Roles & permissions row names.
  const user=(S.adminParticipantsData||[]).find(p=>p.id===userId)||(S.adminUserRows||[]).find(p=>p.id===userId);
  const name=user?`${user.first_name||''} ${user.last_name||''}`.trim()||user.nickname||user.email:'';
  const seq=++_histOpenSeq;
  const {events,total,snapshotBefore,snapshotTie,failed}=await _fetchEventsPaged(`/api/admin/participants/${userId}/events`);
  if(seq!==_histOpenSeq)return;   // v8.12.6 — superseded by a later open
  if(failed){await showModal({title:'History',message:'Could not load history. Check your connection and try again.',confirmText:'OK',cancelText:null});return;}
  if(!events.length){await showModal({title:'History',message:'No history available yet.',confirmText:'OK',cancelText:null});return;}
  openHistoryDialog({title:`History: ${name}`,events,total,fetchUrl:`/api/admin/participants/${userId}/events`,snapshotBefore,snapshotTie});
}

export async function showTaskHistory(taskId){
  const task=S.adminTasksData.find(t=>t.id===taskId);
  // v8.3.17 — a FAILED fetch is not "no history". This was
  // `.then(r=>r.json()).catch(()=>[])`, so a 500 or a 403 rendered as the
  // confident "No version history available for this challenge." — the v7.23.5
  // rule in the one shape that looks like success.
  const seq=++_histOpenSeq;
  const versions=await fetchJsonList(`/api/admin/tasks/${taskId}/versions`);
  if(seq!==_histOpenSeq)return;   // v8.12.6 — superseded by a later open
  if(versions===null){await showModal({title:'Version History',message:'Could not load the version history for this question. The request failed — try again, and check the admin Logs if it keeps happening.',confirmText:'OK',cancelText:null});return;}
  if(!versions.length){await showModal({title:'Version History',message:'No version history available for this question.',confirmText:'OK',cancelText:null});return;}
  openHistoryDialog({title:`History: ${task?.title||''}`,events:versions,isTaskHistory:true,task,taskId});
}

export async function loadMoreHistory(){
  // v8.12.6 — the page is appended to the dialog it was ASKED for. After the
  // await it used to push into whatever S._histState was current, so "Load
  // older" on A's history, then Close, then B's history put A's older events
  // into B's dialog (measured: 100 of A's rows under B's title). Captured here
  // and compared after; a second click on the same button (which fetches the
  // same offset) is dropped by the length half.
  const st=S._histState;
  if(!st||!st.fetchUrl)return;
  const loaded=st.items.length;
  if(loaded>=st.total)return;
  // v6.10.64 — echo the stored snapshot so page 2+ sees the same
  // insert-free view as page 1.
  const {events,failed}=await _fetchEventsPaged(st.fetchUrl,loaded,500,st.snapshotBefore??null,st.snapshotTie??null);
  if(S._histState!==st||st.items.length!==loaded)return;
  // v8.3.20 — the THIRD caller, and the one a failure is least visible in: the
  // dialog is already open, so a bare `return` leaves the "Load older" button
  // exactly as it was and the click reads as a dead control. A toast rather than
  // a modal, which would stack over the dialog the admin is reading.
  if(failed){showToast('Could not load older history. Check your connection and try again.','error');return;}
  if(!events.length)return;
  // Build items from fetched events and append to state.items (keep search/sort working)
  const newItems=events.map(ev=>{
    const type=ev.event_type||ev.change_type||'';
    const changeHtml=formatEventChange(ev);
    const details=ev.details||{};
    const searchText=`${type} ${ev.changed_by||''} ${_stripHtml(changeHtml)} ${JSON.stringify(details)}`.toLowerCase();
    return{type,when:ev.changed_at,by:ev.changed_by||'',changeHtml,searchText,raw:ev};
  });
  st.items.push(...newItems);
  renderHistoryDialog();
}
