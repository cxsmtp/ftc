"use strict";

import { ICO } from "./icons.js";
// state.js is a dependency-free leaf, so this edge cannot cycle. v8.1.0 (PR 13)
// parks the shell-injected event vocabulary on S rather than in a module local so
// boot()'s window mirror exposes it to the test hooks like every other state key.
import { S } from "../core/state.js";

// audit v7.7.33 (AL10) — reflect an admin table's sort column + direction in
// aria-sort on the <th>. Batch 5 kept sortable <th> as native columnheader
// (which supports aria-sort); the ▲/▼ glyph alone is opaque to screen readers.
// Given the shared "set the active column's ▲/▼ icon span" pattern, pass the
// active icon element (its span sits inside the th) + the ascending flag; this
// clears aria-sort on the sibling sortable headers in the same thead and marks
// the active one. No-op when nothing is sorted (activeIconEl null).
export function _syncSortAria(activeIconEl, asc){
  if(!activeIconEl||!activeIconEl.closest)return;
  const th=activeIconEl.closest('th');
  const thead=th&&th.closest('thead');
  if(thead)thead.querySelectorAll('th.sortable, th[data-sort], th[data-col]').forEach(x=>x.setAttribute('aria-sort','none'));
  if(th)th.setAttribute('aria-sort',asc?'ascending':'descending');
}

// v8.1.0 (PR 17) — CARRIES DAYS once the span reaches one, and is byte-identical
// below that.
//
// This is a change to a SHIPPING surface, not a Program feature, which is why it
// is its own PR: a five-day Competition's header read `119:44:12` and the admin
// Duration column read the same — technically correct and useless, and a ten-year
// Program would have rendered `87672:00:00`. Hours stay unbounded inside a day,
// so every existing sub-24h rendering (the live countdown, the urgency classes at
// 60 s and 10 s, the session duration cells) is unchanged to the character.
export function formatDuration(ms){
  const pad=n=>String(n).padStart(2,'0');
  const d=Math.floor(ms/86400000);
  const h=Math.floor((ms%86400000)/3600000),m=Math.floor((ms%3600000)/60000),s=Math.floor((ms%60000)/1000);
  return d>0?`${d}d ${pad(h)}:${pad(m)}:${pad(s)}`:`${pad(h)}:${pad(m)}:${pad(s)}`;
}

// v8.1.0 (PR 17, Q3=b) — "Day 2 of 5" for a multi-day event.
//
// The duration change alone leaves a five-day Competition reading `3d 07:14:03`,
// which is accurate and still does not answer the question a participant actually
// has on the third morning. This does.
//
// Returns null — so callers render NOTHING — for anything under two days. A
// single-day event has no "day N of M" to report, and printing "Day 1 of 1" over
// an afternoon would be noise on the one surface that must stay scannable.
//
// Days are counted from the START, not from midnight: an event beginning at 14:00
// on Monday is on its day 2 at 14:00 on Tuesday, which is what a participant
// counting sessions means. A calendar-day rule would flip at midnight, mid-evening,
// while everyone is still working on what they call day one.
export function dayOfSpan(startMs, endMs, nowMs){
  // Guard on FINITENESS, not truthiness: `!startMs` rejects a legitimate epoch-0
  // timestamp, which is exactly the kind of falsiness bug that survives because
  // real data never trips it.
  if(!Number.isFinite(startMs)||!Number.isFinite(endMs))return null;
  const span=endMs-startMs;
  if(!(span>=2*86400000))return null;
  const total=Math.ceil(span/86400000);
  const elapsed=Math.max(0,(nowMs===undefined?Date.now():nowMs)-startMs);
  const day=Math.min(total,Math.floor(elapsed/86400000)+1);
  return {day,total};
}

export function formatCountdown(ms){
  const pad=n=>String(n).padStart(2,'0');
  const d=Math.floor(ms/86400000);
  const h=Math.floor((ms%86400000)/3600000);
  const m=Math.floor((ms%3600000)/60000);
  const s=Math.floor((ms%60000)/1000);
  return `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
}

export function esc(str){return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');}

/** An email address as HTML that may break only where an address reads well:
 *  after a "." or "-" and before the "@" (`<wbr>`), never inside a word. Every
 *  piece is escaped; the text, and so a search or copy, is the address as typed. */
export function addrBreakHtml(addr){return String(addr||'').split(/(?<=[.-])|(?=@)/).map(p=>esc(p)).join('<wbr>');}

export function toggleSearchClear(input){const btn=document.getElementById(input.id+'-clear');if(btn)btn.classList.toggle('hidden',!input.value);const wrap=input.closest&&input.closest('.search-wrap');if(wrap)wrap.classList.toggle('has-value',!!input.value);}

export function clearSearch(inputId,cb){const el=document.getElementById(inputId);if(el){el.value='';const wrap=el.closest&&el.closest('.search-wrap');if(wrap)wrap.classList.remove('has-value');}const btn=document.getElementById(inputId+'-clear');if(btn)btn.classList.add('hidden');if(cb)cb();}

export function fmtSolveTime(ms){
  if(ms==null||ms<0)return'-';
  const s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;
  const parts=[];
  if(h)parts.push(h+'h');
  if(m||h)parts.push(String(m).padStart(h?2:'1','0')+'m');
  parts.push(String(sec).padStart(2,'0')+'s');
  return parts.join(' ');
}

export function avatarHtml(avatar,size=28){
  // The emoji glyph is sized to the avatar's box (geometry, not a type step), so
  // the derived size rides --av-fs and the declaration stays a token reference.
  const glyph=`--av-fs:${Math.round(size*.7)}px;font-size:var(--av-fs);line-height:1`;
  const dflt=`<span style="${glyph}">👤</span>`;
  if(!avatar||avatar==='default1')return dflt;
  const imgStyle=`width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;vertical-align:middle;flex-shrink:0`;
  // audit v7.7.33 (AL4) — alt="" marks the avatar decorative (the nickname is
  // always adjacent text), so screen readers skip it instead of announcing a
  // URL / "unlabeled image" (axe image-alt is critical when the <img> branch
  // renders — only uploaded/data-URI avatars hit it, never the default emoji).
  if(avatar.startsWith('/api/images/'))return`<img src="${esc(avatar)}" alt="" style="${imgStyle}">`;
  if(avatar.startsWith('data:image/'))return`<img src="${esc(avatar)}" alt="" style="${imgStyle}">`;
  // Only render short strings as emoji text; fall back to default for anything else
  if(avatar.length<=8)return`<span style="${glyph}">${esc(avatar)}</span>`;
  return dflt;
}

export function fmtDt(v, shape, opts) {
  if (v == null || v === '') return '—';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  const s = shape || 'full';
  let fmtOpts;
  if (s === 'short')      fmtOpts = { dateStyle: 'medium' };
  else if (s === 'long')  fmtOpts = { dateStyle: 'medium', timeStyle: 'short' };
  else                    fmtOpts = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
  if (opts && opts.timeZone) fmtOpts = Object.assign({}, fmtOpts, { timeZone: opts.timeZone });
  // v8.3.20 — `withZone` appends the resolved IANA zone in parentheses, the same
  // shape formatEmailDate has printed on every outbound mail for releases
  // ("22 Aug 2026, 17:45 (Europe/London)").
  //
  // Only for a timestamp a reader must ACT against a deadline on, where "which
  // clock is this?" is the question — the IP-ban alert modal is the first
  // caller, so it and its emailed twin finally agree. Everywhere else a bare
  // local time is right and this must stay off: labelling every cell would be
  // noise on surfaces whose reader is plainly in their own timezone.
  //
  // IANA rather than an abbreviation, for the reason lib/admin-alerts.js gives:
  // "IST" is India, Ireland and Israel, and an ambiguous abbreviation on an
  // operational deadline is worse than none.
  //
  // The implementation line below must stay spelled `return d.toLocaleString(undefined, fmtOpts)` —
  // it is the one exemption the "public/app.js routes all date formatting
  // through fmtDt" scanner grants, so a bespoke toLocaleString here (or in any
  // caller) turns that scanner red. Clear it by routing through this function,
  // never by adding an exemption.
  //
  // ONE `toLocaleString` call, and it must stay spelled exactly
  // `return d.toLocaleString(undefined, fmtOpts)` — that literal is the single
  // exemption the "public/app.js routes all date formatting through fmtDt"
  // scanner grants, so a second call (or a different spelling) turns it red.
  // The suffix is computed first and concatenated onto that one return: clear
  // the scanner by fixing the SITE, never by widening its exemption.
  let zoneSuffix = '';
  if (opts && opts.withZone) {
    let zone = '';
    try { zone = (opts.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone) || ''; } catch (_) { zone = ''; }
    if (zone) zoneSuffix = ` (${zone})`;
  }
  return d.toLocaleString(undefined, fmtOpts) + zoneSuffix;
}

// THE WORDS FOR A PROGRAM WITH NO FIXED DEADLINE (operator rulings, 14 Nov
// 2026). Its stored deadline is a placeholder ten years out, so every surface
// that would print its end or count down to it says this instead while the
// server's `open_ended` is true (lib/competitions.js isOpenEnded, per read on
// the participant rows, the /api/status body and the admin list rows): the
// participant's cards, header and play bar, and the organiser's Events list and
// workspace. The client never re-derives it from a threshold. The mails' copy of
// the words is lib/competitions.js NO_FIXED_DEADLINE.
export const NO_FIXED_DEADLINE='No fixed deadline';
/** An event's END as a surface prints it: the words while the server's
 *  `open_ended` holds, else the date in fmtDt's `shape`. A closed or ended event
 *  is never open-ended, so it prints its real end. */
export function eventEndText(c,end,shape){
  return c&&c.open_ended===true?NO_FIXED_DEADLINE:fmtDt(end,shape);
}

export function _fmtBytes(n){
  if(n==null||isNaN(n))return '';
  if(n<1024)return `${n} B`;
  if(n<1024*1024)return `${(n/1024).toFixed(1)} KB`;
  return `${(n/(1024*1024)).toFixed(2)} MB`;
}

// v7.15.0 — the "all challenges solved" mark, as its own cell.
// Previously this was an unlabelled tick crammed into the Time-to-Solve cell,
// coloured with an inline `color:var(--green)`. Two problems: at light-theme
// contrast `--green` on the `.me` row is 4.55:1 (AA by a hair, and that is the
// one row a participant actually looks at), and the tick was conveyed by colour
// alone with no accessible name. Now it is a filled pill using the SAME token
// pair the live-badge already proves (`--green-soft`/`--green` dark,
// `--green-pill`/`--badge-green-fg` light => 6.11:1 and 5.32:1 on the me-row),
// with the glyph aria-hidden and a visually-hidden label carrying the meaning —
// the medalTinted() pattern. Shared by the individual board, the "your
// placement" banner and the team board so all three can never drift apart.
export function solvedCell(allSolved){
  return allSolved
    ? `<td class="lb-solved-col"><span class="lb-solved-pill"><span aria-hidden="true">${ICO.check}</span><span class="sr-only">All challenges solved</span></span></td>`
    : `<td class="lb-solved-col"><span class="lb-unsolved" aria-hidden="true">—</span><span class="sr-only">Not all challenges solved</span></td>`;
}

// Does this board entry earn a Gold, Silver or Bronze certificate? A place in the
// top three with points above zero (operator ruling, 14 Nov 2026); anyone else who
// attempted is issued participation. The browser's copy of lib/badge.js
// `earnsPlacement`, body for body (tests/placement-points.spec.js): the podium's
// certificate chip, the holder's certificate card and the organiser's Top three
// panel read it, so none offers a medal the mint will not issue.
export function earnsPlacement(e) {
  return !!e && (e.rank === 1 || e.rank === 2 || e.rank === 3) && typeof e.score === "number" && e.score > 0;
}

/**
 * v7.19.1 — the DISPLAY form of a challenge's correct answer.
 *
 * For a multiple-choice challenge `correct_answer` stores a JSON array of
 * choice IDs — the right thing to store (the options are shuffled per
 * participant, so grading keys on identity) and the wrong thing to show. Every
 * renderer that printed it verbatim put `["6bc9f335"]` in front of a human
 * under the heading "Correct Answer".
 *
 * There are THREE such renderers — the admin's participant preview, the
 * participant's own post-competition solution box, and the challenge editor —
 * and v7.19.0 fixed only the first, which is how the participant one shipped
 * broken. So the mapping lives here, in a dependency-free leaf both feature
 * modules already import, and `Docs hygiene > "every correct_answer renderer
 * goes through formatCorrectAnswer"` fails the build if a fourth appears.
 *
 * `task` needs `answer_type`, `correct_answer` and `choices` — the same shape
 * the admin list and the participant task payload both already carry.
 */
export function formatCorrectAnswer(task){
  if(!task)return '';
  // v8.9.0 — an any-answer challenge has no key; nothing to show.
  if(task.answer_type==='any')return '';
  // v8.9.0 — a text key is a newline-separated LIST of accepted answers, joined
  // here with ' | ' (alternatives — deliberately NOT the ' + ' a choice SET
  // uses below, which means "all of these"). One line renders as before.
  if(task.answer_type==='text'||!task.answer_type){
    return String(task.correct_answer||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean).join(' | ');
  }
  if(task.answer_type!=='choice')return task.correct_answer||'';
  // `choices` arrives in TWO shapes and both must work: the admin surfaces read
  // the raw DB column (a JSON string), while the participant payload has
  // already parsed it into an array of {id,text}. Handling only the string form
  // fails silently on the participant's own solution box — which is exactly the
  // surface this helper was written to fix.
  const _arr=v=>{
    if(Array.isArray(v))return v;
    if(typeof v!=='string'||!v)return [];
    try{const p=JSON.parse(v);return Array.isArray(p)?p:[];}catch(_){return [];}
  };
  const opts=_arr(task.choices);
  const ids=_arr(task.correct_answer);
  const byId=new Map(opts.map(c=>[c.id,c.text]));
  // Order by the AUTHOR's option order rather than the order the ids happen to
  // sit in, so the answer reads the same way the question does.
  const texts=opts.filter(c=>ids.includes(c.id)).map(c=>c.text);
  // An id with no matching option can only come from hand-edited data; show
  // what is knowable rather than dropping the answer entirely.
  for(const id of ids)if(!byId.has(id))texts.push(id);
  return texts.length?texts.join(' + '):'(none set)';
}

// v7.21.18 — the dry-run competition marker, CLIENT side.
//
// This is a mirror of DRY_RUN_TAG in lib/competitions.js and, like DIFF_PTS,
// it has to be a copy: public/js is a browser-only ESM graph and cannot import
// server code. It lives here rather than in a feature module because all four
// consumers (core/main, competitions-admin, challenges-admin, analytics-admin)
// already import from this leaf, and a constant owned by one feature that three
// others reach into is how the two chip-multiselect copies happened.
//
// The string is the STORED TAG VALUE, so it is also what the tag chip renders —
// which is deliberate: using a prettier label for the badge and the raw value on
// the chip would put two spellings of one thing on the same screen.
//
// Kept in step with the server by
// `functional-core.api.spec.js > Docs hygiene > "the dry-run tag is one string"`.
export const DRY_RUN_TAG = 'test/dry run';

// v8.8.2 — the PUBLIC-DOMAIN challenge marker, CLIENT side.
//
// A mirror of PUBLIC_DOMAIN_TAG in lib/event-admin.js, a copy for the same
// browser-only-ESM reason as DRY_RUN_TAG above.
//
// IT IS HERE BECAUSE THE STRING IS LOAD-BEARING AND WAS UNTYPEABLE. This tag is
// the third arm of the event-admin challenge-visibility rule: tag a challenge
// with it and every event admin on the platform can use it. But it was reachable
// only by typing it exactly, into a free-text box that accepts anything — so
// "public domain", the natural English spelling, was stored verbatim, rendered as
// a tag, and did nothing. That is accept-and-ignore: a control that appears to
// work, which this codebase treats as worse than no control. The Add Tag dialog
// now offers it as a one-click chip built from THIS constant, so the exact value
// is never typed.
//
// Casing is not the hazard — tag writes lowercase, so "Public-Domain" round-trips
// correctly. The separator is: a space or a missing hyphen produces a different,
// inert tag.
//
// Kept in step with the server by
// `functional-core-b.api.spec.js > Docs hygiene > "the public-domain tag is one string"`.
export const PUBLIC_DOMAIN_TAG = 'public-domain';

// The confusable key, and the near-miss predicate — a MIRROR of
// publicDomainNearMiss in lib/event-admin.js, diffed by the same Docs-hygiene
// scanner that holds the constant above.
//
// v8.8.3 — the server REFUSES a near miss at the one write path a human types
// into, so this copy is not the enforcement. It is what lets the challenge row
// say WHY a tag that looks right is inert, and lets the Add Tag dialog stop the
// operator before the refusal — including for the variants nobody can see: a
// SOFT HYPHEN or a ZERO-WIDTH SPACE renders PIXEL-IDENTICALLY to the reserved
// value, so on the row the two are indistinguishable and only this predicate can
// tell them apart.
const _PD_KEY = PUBLIC_DOMAIN_TAG.replace(/[^a-z0-9]/g, '');

export function publicDomainNearMiss(tag) {
  if (typeof tag !== 'string') return false;
  const t = tag.toLowerCase();
  if (t === PUBLIC_DOMAIN_TAG) return false;
  return t.replace(/[^a-z0-9]/g, '') === _PD_KEY;
}

// ── v8.1.0 (PR 13) — the event-kind vocabulary ──────────────────────────────
//
// The label table is NOT mirrored here. It is read once from the SPA shell's
// data- attributes, which the server substitutes from lib/event-policy.js at send
// time — so a rename is a server copy change that reaches the client on the next
// page load with no redeploy, and there is no second declaration to drift.
//
// THE CLIENT KEEPS NO FALLBACK LABEL, and that is the load-bearing rule. A chip
// reading "Competition" on a Booth Event is a WRONG answer, not a degraded one,
// and `tournament` as the stored value hardens this rather than softening it: a
// degraded chip would literally read "tournament" beside a UI saying Competition.
// So every helper here returns null/'' when the vocabulary is absent or the kind
// is unrecognised, and the callers render NOTHING — the card keeps its name and
// dates and loses only the chip. Surfaces whose whole job is to teach the three
// words (the create chooser, the kind filter row) refuse to open instead.
export function readEventVocabulary(root) {
  const el = root || document.body;
  const parse = (raw, fallback) => {
    if (!raw) return fallback;
    try { const v = JSON.parse(raw); return v || fallback; } catch (_) { return fallback; }
  };
  S.eventKinds = parse(el && el.dataset ? el.dataset.eventKinds : null, []);
  S.eventCollective = parse(el && el.dataset ? el.dataset.eventCollective : null, null);
  return S.eventKinds;
}

// The one lookup. Returns the whole row so a caller can reach label / plural /
// article / countNoun without a second accessor per field.
export function eventKindMeta(kind) {
  if (!kind) return null;
  const t = S.eventKinds;
  if (!Array.isArray(t) || !t.length) return null;
  return t.find(k => k.value === kind) || null;
}

export function eventKindLabel(kind) {
  const m = eventKindMeta(kind);
  return m ? m.label : null;
}

// v8.1.0 (PR 18) — "a Program": the article comes from the table, exactly as the
// server's eventKindPhrase does, so explanatory copy cannot pair a hard-coded
// article with a renamed label. Returns null when the kind cannot be named, and
// callers fall back to the collective rather than inventing one.
export function eventKindPhraseClient(kind){
  const m=eventKindMeta(kind);
  return m?`${m.article} ${m.label}`:null;
}

// The COLLECTIVE noun, and it deliberately DOES carry a fallback where the kind
// labels must not. The two cases are not alike: a missing kind label would make a
// chip assert the wrong kind, whereas the collective is one invariant word naming
// the container — falling back to it degrades to today's copy rather than lying,
// and the alternative is a History line reading "+ :" with the noun missing.
export function eventCollectiveNoun() {
  return (S.eventCollective && S.eventCollective.countNoun) || 'event';
}

// The capitalised singular, for a heading. Same fallback rule as the noun above
// and for the same reason: a dialog titled "Edit" with the noun missing is worse
// than one that says "Event" while the vocabulary is still loading.
export function eventCollectiveSingular() {
  return (S.eventCollective && S.eventCollective.singular) || 'Event';
}

// v8.1.0 (PR 18) — THE ABSENT-VALUE DEFAULT, in one place.
//
// The client's whole suppression layer reads this object, and `undefined` is
// falsy — so a payload that predates the policy (a stale client, a surface not
// yet migrated, a cached response) would make `policy.ranking_enabled` read false
// and a COMPETITION participant would silently find the Leaderboard button
// inactive and lose the header score pill. Defaulting to the ranked shape means the failure mode of
// a missing policy is "behaves exactly as it did before v8.1.0", which is the only
// safe direction.
// v8.2.0 — the four form keys join it, and they must all point at the PERMISSIVE
// value for the same reason the four above point at the ranked one: before this
// release every one of these controls rendered for every kind, so a payload that
// predates the policy has to keep rendering them. Defaulting the other way would
// make a stale client silently hide an admin's trusted-network field or its
// reveal-answers checkbox, which is the quieter and worse failure.
// v8.4.0 — the two registration keys join it:
//
//   `registration_fields` — `lib/registration-fields.js` LEGACY_STATES, field
//     for field: the form every kind asks for when its event stores no policy,
//     so a stale payload renders what the server would ask. It is a mirror (a
//     lock diffs the two), exported because the template editor's per-field
//     default is the same map.
export const DEFAULT_REGISTRATION_FIELDS = Object.freeze({ personal_title: "hidden",
  phone: "hidden", city: "optional", linkedin_url: "hidden", job_function: "optional" });
const _DEFAULT_POLICY = { sessions: "many", schedule: "window", ranking_enabled: true, certificate: "attempt",
  reveal_answers: "allowed", group_leaderboard: "allowed", measure_presence: "allowed", trusted_networks: "if-single-session",
  registration_fields: DEFAULT_REGISTRATION_FIELDS,
  // FALSE, and this is the one default that points at the RESTRICTIVE value
  // rather than the permissive one — deliberately, because the two directions are
  // not symmetric here. A stale payload that wrongly showed the controls would let
  // an admin configure a form the server then refuses with
  // `registration_fields_forbidden`: a control that appears to work. Hiding it on a
  // stale payload costs a reload.
  registration_fields_configurable: false,
  // v8.6.0 — "never" is the restrictive value, and it points the same way as the
  // key above it for the same reason: a stale payload that wrongly showed the Late
  // entries section would let an admin set a window the server refuses with
  // `late_entry_forbidden`. The form does NOT read this merged value for the
  // section's visibility — it consults the RAW key and falls back to the KIND
  // vocabulary, which is v8.4.1's "absent is not false" lesson — so this default
  // only ever governs a client that knows nothing at all.
  late_entry: "never",
  // v8.13.0 — "standard" is today's screen, and both directions point the same
  // way: a payload that predates the key keeps the radios-and-Submit card every
  // event has always had, and the tap layout (public/js/features/choice-tap.js)
  // appears only where the server SAYS "tap". The reader tests `=== "tap"`, so an
  // unknown value lands here too.
  choice_layout: "standard",
  // "never" is the restrictive value: a stale payload hides the clock-start choice
  // rather than offer one the save refuses (`clock_start_forbidden`).
  clock_start: "never",
  // "allowed" is what every kind did before the key existed, so a payload that
  // predates it keeps the event form's Checkmarx One section (the server refuses
  // a Booth Event's accounts either way).
  cxone_provisioning: "allowed" };
// v8.12.0 — STAFF CAN COMPETE, and the one predicate the participant surfaces
// read. A staff-tagged user is a SPECTATOR of an event unless they hold a row on
// it and its "Staff can compete" switch is on — the server puts that answer on
// each row as `competing` (lib/competitions.js listParticipantCompetitions), so
// this never re-derives it. Every place that used to skip a confirmation or
// offer "Switch Session" because `S.isUserStaff` was true now asks this instead:
// a competitor's choice of session is as final as anybody's, and their leaving a
// live event costs them exactly what it costs a participant.
//
// `comp` may be a row from `S.myCompetitions` or null/undefined (a competition
// the client has not loaded yet) — the absent case reads as spectator ONLY when
// the user is staff, which is the pre-v8.12.0 behaviour and the safe direction:
// a confirmation withheld from a competitor costs a click; one shown to a
// spectator costs nothing.
export function staffSpectatorIn(comp){
  return !!S.isUserStaff&&!(comp&&comp.competing);
}
/**
 * The row for the competition the participant is in, or null.
 *
 * `S.myCompetitions` is written by the picker and the eject paths and NOT by
 * boot's `enter` branch — a sign-in that auto-resumes straight into the event
 * (the ordinary path for a competitor: the sole-event landing plus the slot pin)
 * leaves it empty, so a read of that list alone answered null and
 * `staffSpectatorIn(null)` read every competitor as a spectator, offering them
 * "Switch Session" the server then refused (caught by the v8.12.0 browser lock).
 * `S.currentUser.competitions` comes from /api/me and holds the same rows, so it
 * is the fallback here exactly as it is for the presence note.
 */
export function currentCompetitionRow(){
  const id=S.currentCompetitionId;
  return (S.myCompetitions||[]).find(c=>c.id===id)
    ||((S.currentUser&&S.currentUser.competitions)||[]).find(c=>c.id===id)
    ||null;
}

/**
 * Can an answer to this challenge be WRONG? Not on an Any answer challenge, a
 * pick-one included (every option is accepted) — which is what the built-in
 * quick questions are. A quick question of another type is graded like any
 * challenge (it only scores nothing, lib/qualifying.js), so a wrong answer to it
 * spends an attempt: being a quick question settles nothing here. Where no
 * answer can be wrong, no attempts line warns "If this one is wrong…": the
 * standard card and the booth tap card both ask this.
 */
export function answerCanBeWrong(t){
  return !!t&&t.answer_type!=='any';
}

export function policyOrDefault(p) {
  if (!p || typeof p !== "object") return _DEFAULT_POLICY;
  // Per FIELD, not per object: a payload carrying a partial policy must not lose
  // the keys it does not mention.
  //
  // v8.4.0 — and per field INSIDE `registration_fields`, for the same reason one
  // level down: the server sends all six, but a partial map (a hand-built payload,
  // a future server that adds a seventh) must not blank the five it did mention's
  // neighbours. A plain spread would replace the whole nested object.
  const merged = { ..._DEFAULT_POLICY, ...p };
  merged.registration_fields = { ...DEFAULT_REGISTRATION_FIELDS,
    ...((p.registration_fields && typeof p.registration_fields === "object") ? p.registration_fields : {}) };
  return merged;
}

// The chip. Empty string — not a placeholder — when the kind cannot be named.
export function eventKindChipHtml(kind) {
  const m = eventKindMeta(kind);
  if (!m) return '';
  return `<span class="kind-chip" data-kind="${esc(m.value)}">${esc(m.label)}</span>`;
}

// v7.24.0 — ordering for a per-competition challenge number, CLIENT side.
//
// A task_number is TEXT of the form "<level>.<NN>" (lib/competitions.js
// _assignTaskNumbers): level is the difficulty bucket 1/2/3 and NN is
// zero-padded to two digits. A plain string sort therefore looks right and is
// wrong twice:
//
//   • past 99 challenges in ONE difficulty bucket the padding runs out, so
//     "1.100" sorts BEFORE "1.99";
//   • a BLANK number sorts FIRST, and blanks are reachable — a challenge that
//     was unassigned from the competition keeps its challenge_events but loses
//     its competition_tasks row, so analytics can hold a row whose number is
//     null. A screenful of numberless rows above the numbered ones is not what
//     someone who sorted by number asked for.
//
// Blanks last, then segment-by-segment numeric comparison. NOTE the blanks-last
// rule only survives an ASCENDING pass: a caller offering a descending sort must
// hold blanks out of the flip (the v7.22.0 _RK_BLANK_FIELD rule), which is what
// _anSortRows does.
//
// This is a mirror of compareTaskNumbers in lib/competitions.js for the same
// browser-only-ESM reason as DRY_RUN_TAG above, and the two BODIES are kept
// byte-identical so a source diff can prove it. Kept in step by
// `functional-core.api.spec.js > Docs hygiene >
//  "v7.24.0: the task-number comparator is mirrored, not re-invented"`.
export function compareTaskNumbers(a, b) {
  const sa = a === null || a === undefined ? "" : String(a).trim();
  const sb = b === null || b === undefined ? "" : String(b).trim();
  if (!sa || !sb) return sa ? -1 : sb ? 1 : 0;
  const pa = sa.split("."), pb = sb.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const xa = pa[i] === undefined ? "" : pa[i], xb = pb[i] === undefined ? "" : pb[i];
    const na = Number(xa), nb = Number(xb);
    if (xa !== "" && xb !== "" && Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (xa !== xb) return xa < xb ? -1 : 1;
  }
  return 0;
}
