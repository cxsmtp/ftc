"use strict";

// v8.13.0 — TAP TO ANSWER: a Booth Event's multiple-choice challenge on a phone.
//
// At a stand the visitor holds a phone in one hand, and the standard challenge
// card asked them to scroll past the header, the question and a list of small
// radios to a Submit button below the fold — measured at 390x664 (an iPhone 14
// viewport), one and a half options and no Submit were on screen. This module
// renders the same challenge as ONE screen: a compact bar, the question, a
// reserved status row and large answer tiles anchored where the thumb rests.
//
// PRESENTATION ONLY, and that is the whole contract. Nothing here grades,
// submits or decides who may answer: the tiles carry the same option ids the
// standard radios carry, the answer goes through submitAnswer() with the same
// grading hash, the same in-flight guard and the same outcome ladder, and the
// penalty confirm is the existing shared modal with the picked option named in
// it. The answer flow lives in participant-tasks.js; this module draws and
// measures.
//
// WHO GETS IT is the event's policy, never its kind. `choice_layout` rides the
// wire policy (lib/event-policy.js — "tap" for a Booth Event), and a payload that
// lacks it reads as "standard" through policyOrDefault, so a stale client keeps
// today's card. A scanner forbids deciding this from `event_kind`.
//
// The module body has no side effects (the v7.0.0 rule): every listener it
// installs is installed by enterTapChrome() and removed by releaseTapChrome().

import { S } from "../core/state.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { esc, policyOrDefault, answerCanBeWrong } from "../ui/format.js";
import { DIFF_PTS, ICO } from "../ui/icons.js";

// THE DEVICE QUERY, built only from breakpoints the stylesheet already uses
// (450 / 600 / 900). Phones in either orientation and portrait tablets match;
// a landscape iPad, a touch laptop and every desktop do not, and keep today's
// card. Exposed on `window` through main.js's namespace so a test derives its
// expectation from the same string instead of from a project name.
export const CHOICE_TAP_MQ='(max-width:600px), (pointer:coarse) and (max-width:900px), (pointer:coarse) and (max-height:450px)';

export function choiceTapDevice(){
  try{return !!(window.matchMedia&&window.matchMedia(CHOICE_TAP_MQ).matches);}catch(_){return false;}
}

// Every clause is a reason the standard card is the right one: a challenge that
// cannot be answered any more is REVIEWED (#choice-review), and a review is read,
// not tapped. Written positively, so a state invented later falls back.
// A PICK-ONE question (`any` with options) is a tap too: one tap answers it, with
// no confirm, since no option can be wrong (submitAnswer's `pickone` mode).
export function choiceTapApplies(t){
  if(!t||(t.answer_type!=='choice'&&!(t.answer_type==='any'&&t.pick_one)))return false;
  if(t.solved||t.hackathon_ended||t.attempts_left===0)return false;
  if(!Array.isArray(t.choices)||t.choices.length<2)return false;
  if(policyOrDefault(S.currentCompPolicy).choice_layout!=='tap')return false;
  return choiceTapDevice();
}

// Past these the content cannot fit one screen however small the text, so the
// ladder is skipped and the card starts in scroll mode — still with tiles.
const STATIC_MAX_OPTIONS=6;
const STATIC_MAX_CHARS=90;

const _letter=i=>String.fromCharCode(65+i);
const _cap=s=>s?s.charAt(0).toUpperCase()+s.slice(1):'';

function _attemptsLine(t){
  if(!Number.isInteger(t.attempts_left))return '';
  // A pick-one (an Any answer, as the built-in quick questions are) cannot be
  // answered wrongly: no attempts line, and no "Last attempt" over options that
  // are all accepted (ui/format.js).
  if(!answerCanBeWrong(t))return '';
  if(t.attempts_left===1)
    return `<div class="mcf-meta-2 mcf-last"><span class="mcf-ico" aria-hidden="true">${ICO.lock}</span>Last attempt</div>`;
  return `<div class="mcf-meta-2">${esc(String(t.attempts_left))} of ${esc(String(t.attempts_cap))} attempts left</div>`;
}

export function tapHowtoText(multi,last){
  return (multi
    ?'Select every answer that applies, then submit. A wrong answer costs 5 points.'
    :'Tap your answer. You confirm before it counts, and a wrong answer costs 5 points.')
    +(last?' This is your last attempt.':'');
}

/**
 * The tap card's markup. `parts` are the SAME fragments openTask hands the
 * standard template (the hint, categories, author, description, attachments),
 * so neither renderer can drift from the other on what a challenge says — and
 * they come in the SAME ORDER, the hint after the question, so the reading order
 * (and a screen reader's) is the standard card's.
 *
 * The title is an h1 here, where the standard card's is an h2: the tap view hides
 * the app header, which carries the page's only other h1, so the question is the
 * screen's top heading.
 */
export function renderTapCard(t,parts){
  const multi=t.choice_mode==='multi';
  const last=t.attempts_left===1;
  const pickOne=!!t.pick_one;
  const opts=t.choices;
  const tid=esc(t.id);
  // Changing a Quick question's answer (operator ruling 395): the instruction
  // names the current pick; one tap still answers, and Back keeps it.
  const cur=pickOne&&t._changing&&Array.isArray(t.my_choice_ids)?opts.findIndex(c=>c.id===t.my_choice_ids[0]):-1;
  const howto=pickOne?(cur>=0?`Your answer now: ${_letter(cur)}. Tap another to change it, or go back to keep it.`:'Tap your answer.'):tapHowtoText(multi,last);
  const tiles=opts.map((c,i)=>{
    const L=_letter(i);
    // The state line ("Not correct") sits UNDER the option text, inside it, so
    // marking a tile never squeezes its text into a narrower column.
    const body=`<span class="mcf-letter" aria-hidden="true">${L}</span><span class="mcf-text"><span class="sr-only">${L}. </span><span class="mcf-text-body">${esc(c.text)}</span>${multi?'':'<span class="mcf-state"></span>'}</span>`;
    if(multi){
      // A real checkbox, visible, as the state cue — and the name the submit
      // path already reads (`.ans-choice:checked`), so the multi answer is
      // collected exactly as the standard card's is.
      return `<label class="mcf-tile mcf-check" data-letter="${L}">${body}<input type="checkbox" name="ans-choice" class="ans-choice" value="${esc(c.id)}" data-change-action="task-choice-toggle" data-task-id="${tid}" aria-describedby="mcf-howto"/></label>`;
    }
    // A BUTTON, never a radio: arrow keys move between radios and would raise a
    // penalty confirm on every keystroke.
    return `<button type="button" class="mcf-tile" data-action="task-choice-tap" data-task-id="${tid}" data-choice-id="${esc(c.id)}" data-letter="${L}"${pickOne?' data-mode="pickone"':''} aria-haspopup="dialog" aria-describedby="mcf-howto">${body}</button>`;
  }).join('');
  const submit=multi
    ?`<button type="button" class="btn mcf-submit" data-action="task-submit-answer" data-task-id="${tid}" data-mode="choice">Select your answers</button>`
    :'';
  return `
    <div class="mcf-bar">
      <button type="button" class="mcf-back" data-action="show-main" data-page="tasks-page" aria-label="Back to challenges"><span aria-hidden="true">${ICO.arrowLeft}</span></button>
      <div class="mcf-meta">
        <div class="mcf-meta-1">${t.task_number?`<span class="mcf-num">${esc(t.task_number)}</span>`:''}<span class="mcf-sub">${t.task_number?' · ':''}${t.qualifying?'Quick question':`${esc(_cap(t.difficulty))} · +${DIFF_PTS[t.difficulty]} pts`}</span></div>
        ${_attemptsLine(t)}
      </div>
      <div class="mcf-clock"></div>
    </div>
    <div class="mcf-q">
      <h1 id="mcf-q-title" class="mcf-q-title">${esc(t.title)}</h1>
      ${parts.categories}
      ${parts.author}
      <div class="task-desc mcf-desc">${parts.description}</div>
      ${parts.attachments}
      ${parts.legacyAttachment}
      ${parts.hint}
      <div class="mcf-more" aria-hidden="true" hidden>Scroll for more</div>
    </div>
    <div class="mcf-status">
      <div id="submit-result" role="status" aria-live="polite"></div>
      <p id="mcf-howto" class="mcf-howto">${esc(howto)}</p>
    </div>
    <div class="mcf-options" role="group" aria-labelledby="mcf-q-title">${tiles}${submit}</div>`;
}

// Mark the card element itself (it is static markup, reused by every open), or
// clear the marks on the way back to the standard card.
export function prepareTapCard(cardEl,t){
  cardEl.classList.add('mcf-card');
  cardEl.dataset.mcfMode=t.choice_mode==='multi'?'multi':'single';
  if(Number.isInteger(t.attempts_left))cardEl.dataset.attemptsLeft=String(t.attempts_left);
  else delete cardEl.dataset.attemptsLeft;
  delete cardEl.dataset.mcfStep;
  delete cardEl.dataset.mcfFit;
  cardEl.classList.remove('mcf-2col');
}
export function resetTapCard(cardEl){
  if(!cardEl)return;
  cardEl.classList.remove('mcf-card','mcf-2col');
  for(const k of ['mcfMode','attemptsLeft','mcfStep','mcfFit'])delete cardEl.dataset[k];
}

// ── The confirm ────────────────────────────────────────────────────────────

// The options for the shared confirm modal, naming what was picked. Read from
// the tiles, so the letter is the one this participant saw (the options are
// shuffled per participant). Returns null when a picked id has no tile — the
// caller then falls back to the ordinary confirm rather than naming nothing.
export function buildTapConfirm(card,picked){
  if(!card||!Array.isArray(picked)||!picked.length)return null;
  const multi=card.dataset.mcfMode==='multi';
  const last=card.dataset.attemptsLeft==='1';
  const byId=new Map();
  for(const el of card.querySelectorAll('.mcf-options .mcf-tile')){
    const id=el.dataset.choiceId||el.querySelector('.ans-choice')?.value;
    if(id)byId.set(id,el);
  }
  const tiles=picked.map(id=>byId.get(id));
  if(tiles.some(x=>!x))return null;
  // textContent is RAW text, so it is escaped again here — an option is authored
  // content, and this string is HTML.
  const pick=el=>`<div class="mcf-pick"><span class="mcf-letter" aria-hidden="true">${esc(el.dataset.letter||'')}</span><span class="mcf-pick-text">${esc(el.querySelector('.mcf-text-body')?.textContent||'')}</span></div>`;
  const message=
    `<div class="mcf-picks">${tiles.map(pick).join('')}</div>`
    +(multi?'<p class="mcf-confirm-p">Every correct option, and only those, must be selected.</p>':'')
    +`<p class="mcf-confirm-p">If ${multi?'this selection':'it'} is incorrect, <strong style="color:var(--red)">5 points</strong> will be deducted from your score immediately. This penalty is permanent.</p>`
    +(last?'<p class="mcf-confirm-p mcf-confirm-last"><strong>This is your last attempt</strong> — a wrong answer locks this challenge.</p>':'');
  if(multi){
    return {title:tiles.length===1?'Submit this answer?':`Submit these ${tiles.length} answers?`,
      message,confirmText:'Submit answers',confirmClass:'',cancelText:'Change selection',armMs:400};
  }
  const L=tiles[0].dataset.letter||'';
  // The visible text IS the accessible name ("Submit answer B"): a terser label
  // with a longer aria-label fails WCAG 2.5.3, since a voice-control user says
  // what they can see.
  return {title:'Submit this answer?',message,confirmText:`Submit answer ${L}`,
    confirmClass:'',cancelText:'Choose again',armMs:400};
}

// After a wrong answer the server says how many attempts are left; the bar, the
// instruction and the next confirm all read it, so the card is updated rather
// than left saying "3 of 3" beside a message saying 2 are left. The LAST attempt
// is what matters most: the confirm warns about it from `data-attempts-left`.
export function updateTapAttempts(card,left,cap){
  if(!card||!Number.isInteger(left))return;
  card.dataset.attemptsLeft=String(left);
  const meta=card.querySelector('.mcf-meta');
  if(meta){
    meta.querySelector('.mcf-meta-2')?.remove();
    const t={attempts_left:left,attempts_cap:Number.isInteger(cap)?cap:left};
    const tmp=document.createElement('div');
    setSafeHtml(tmp,_attemptsLine(t));
    if(tmp.firstElementChild)meta.appendChild(tmp.firstElementChild);
  }
  const how=card.querySelector('#mcf-howto');
  if(how)how.textContent=tapHowtoText(card.dataset.mcfMode==='multi',left===1);
}

// ── Tile states ────────────────────────────────────────────────────────────

// The fill says it; forced-colours mode draws a Highlight edge instead.
export function markChosen(tile,on){
  if(tile)tile.classList.toggle('is-chosen',!!on);
}

// A wrong single answer. The label is VISIBLE text inside the button, so it is
// part of the tile's name — "B. Paris, Not correct" — and a screen-reader user
// hears why the tile no longer responds.
export function markTried(tile){
  if(!tile)return;
  tile.classList.remove('is-chosen');
  tile.classList.add('is-tried');
  tile.setAttribute('aria-disabled','true');
  delete tile.dataset.mcfBusy;
  const st=tile.querySelector('.mcf-state');
  if(st)setSafeHtml(st,`<span class="mcf-ico" aria-hidden="true">${ICO.x}</span><span class="mcf-state-label">Not correct</span>`);
}

// While an answer is being sent, the other tiles say so (and refuse a tap).
// `data-mcf-busy` records which aria-disabled marks this set, so clearing them
// never re-enables a tile already marked Not correct.
export function setTapBusy(card,on){
  const grp=card&&card.querySelector('.mcf-options');
  if(!grp)return;
  if(on)grp.setAttribute('aria-busy','true');else grp.removeAttribute('aria-busy');
  for(const el of grp.querySelectorAll('.mcf-tile')){
    if(on){
      if(el.classList.contains('is-chosen')||el.getAttribute('aria-disabled')==='true')continue;
      el.setAttribute('aria-disabled','true');el.dataset.mcfBusy='1';
    }else if(el.dataset.mcfBusy){
      el.removeAttribute('aria-disabled');delete el.dataset.mcfBusy;
    }
  }
}

// Multiple answer: the tile mirrors its checkbox (no `:has()`), and the pinned
// button says how many are selected.
export function syncTapMulti(card){
  if(!card)return;
  let n=0;
  for(const lab of card.querySelectorAll('.mcf-check')){
    const on=!!lab.querySelector('.ans-choice')?.checked;
    lab.classList.toggle('is-checked',on);
    if(on)n++;
  }
  const btn=card.querySelector('.mcf-submit');
  if(btn)btn.textContent=n?`Submit answers (${n} selected)`:'Select your answers';
}

// ── The chrome ─────────────────────────────────────────────────────────────
//
// body.mcf hides the app header (the participant bar with it), the footer and
// the outer Back button; the countdown, the day chip and the late-entry chip are
// MOVED (the real nodes, not copies) into the bar, so every writer — they all
// look them up by id — keeps working with nothing mirrored. body.mcf-fixed is
// the fixed-height chain that makes the card exactly one screen tall; the fit
// below removes it when the content cannot fit, and the page then scrolls
// normally.

let _c=null;   // the live tap view, or null

const _HEADER_NODES=['header-timer','header-day','header-late-entry'];

function _moveNodesIn(){
  if(!_c||_c.moved.length)return;
  const clock=_c.card.querySelector('.mcf-clock');
  if(!clock)return;
  for(const id of _HEADER_NODES){
    const el=document.getElementById(id);
    if(!el||!el.parentNode)continue;
    _c.moved.push({el,parent:el.parentNode,next:el.nextSibling});
    clock.appendChild(el);
  }
}
function _moveNodesBack(){
  if(!_c)return;
  // In REVERSE, so each node's recorded neighbour is back in place first.
  for(let i=_c.moved.length-1;i>=0;i--){
    const {el,parent,next}=_c.moved[i];
    try{
      if(next&&next.parentNode===parent)parent.insertBefore(el,next);
      else parent.appendChild(el);
    }catch(e){console.warn('Tap view: could not restore a moved node',e);}
  }
  _c.moved=[];
}

function _applyChrome(on){
  const b=document.body.classList;
  if(on){b.add('mcf');_moveNodesIn();}
  else{b.remove('mcf','mcf-fixed');_moveNodesBack();}
}

export function enterTapChrome(card,{isBusy}={}){
  releaseTapChrome();
  if(!card)return;
  const opts=card.querySelectorAll('.mcf-options .mcf-tile');
  const texts=[...card.querySelectorAll('.mcf-text-body')].map(e=>e.textContent||'');
  const staticScroll=opts.length>STATIC_MAX_OPTIONS||texts.some(s=>s.length>STATIC_MAX_CHARS);
  _c={card,moved:[],isBusy:typeof isBusy==='function'?isBusy:()=>false,
    scroll:staticScroll,staticScroll,scrollW:0,touched:false,
    pending:false,raf:0,cleanups:[]};
  const sched=()=>{
    if(!_c||_c.raf)return;
    _c.raf=requestAnimationFrame(()=>{if(_c){_c.raf=0;fitTapCard();}});
  };
  const on=(tgt,ev,fn,o)=>{tgt.addEventListener(ev,fn,o);_c.cleanups.push(()=>tgt.removeEventListener(ev,fn,o));};
  // The scroll latch protects a THUMB, so it engages only once there is one: a
  // touch, a click or a key in the card. Before that a "does not fit" is
  // provisional and the next measurement may still find one screen — the first
  // measurement is taken in the frame the chrome changes, and a stylesheet
  // transition (or a font, or the header's published height) can still be
  // settling then.
  // A card ALREADY scrolling latches at the touch, not at the next failed fit:
  // that fit re-adds the fixed-height chain to measure, which clamps the page's
  // scroll position — so the first resize after a thumb lands (the address bar
  // collapsing during the very first scroll) threw the participant back up.
  const touch=()=>{
    const c=_c;if(!c)return;
    c.touched=true;
    if(!c.scroll&&!c.staticScroll&&c.card.dataset.mcfFit==='scroll'){c.scroll=true;c.scrollW=window.innerWidth;}
  };
  on(card,'pointerdown',touch,true);
  on(card,'keydown',touch,true);
  on(window,'resize',sched);
  try{
    const mq=window.matchMedia(CHOICE_TAP_MQ);
    on(mq,'change',sched);
  }catch(e){console.warn('Tap view: media-query listener unavailable',e);}
  const q=card.querySelector('.mcf-q');
  if(q){
    // `load` does not bubble, so an image that grows the question is caught in
    // the capture phase.
    on(q,'load',sched,true);
    on(q,'scroll',_syncMore,{passive:true});
  }
  // A fit postponed under an open dialog must run when the dialog closes, and a
  // Cancel returns from submitAnswer before its `finally` (which refits after an
  // answer). So the shared modal's closing is watched directly: a rotation made
  // while the confirm — or the hint confirm, or any dialog — was open is applied
  // the moment it goes, not at the next unrelated resize.
  const ov=document.getElementById('modal-overlay');
  if(ov&&typeof MutationObserver==='function'){
    const mo=new MutationObserver(()=>{if(_c&&_c.pending&&!ov.classList.contains('open'))sched();});
    mo.observe(ov,{attributes:true,attributeFilter:['class']});
    _c.cleanups.push(()=>mo.disconnect());
  }
  if(typeof ResizeObserver==='function'){
    // The bar grows a line when a chip appears; the status row grows with a
    // two-line result. Both change what is left for the tiles.
    const ro=new ResizeObserver(sched);
    for(const el of card.querySelectorAll('.mcf-bar,.mcf-status'))ro.observe(el);
    _c.cleanups.push(()=>ro.disconnect());
  }
  try{document.fonts&&document.fonts.ready.then(()=>{if(_c&&_c.card===card)fitTapCard();});}catch(e){console.warn('Tap view: font-load refit unavailable',e);}
  fitTapCard();
}

export function releaseTapChrome(){
  const c=_c;
  if(!c){document.body.classList.remove('mcf','mcf-fixed');return;}
  _applyChrome(false);
  if(c.raf)cancelAnimationFrame(c.raf);
  for(const f of c.cleanups){try{f();}catch(e){console.warn('Tap view: cleanup failed',e);}}
  _c=null;
}

// ── The fit ────────────────────────────────────────────────────────────────

// Text steps use sizes the stylesheet already has (the 41-size ceiling is
// full). Two columns only when every option is one line at half width.
const STEPS=['s0','s1','s2'];

function _fits(card){
  const ih=window.innerHeight;
  const se=document.scrollingElement||document.documentElement;
  if(se.scrollHeight>ih+1)return false;
  if(se.scrollWidth>se.clientWidth+1)return false;
  const ends=card.querySelectorAll('.mcf-options > *');
  const lastEl=ends[ends.length-1];
  if(lastEl&&lastEl.getBoundingClientRect().bottom>ih+1)return false;
  const q=card.querySelector('.mcf-q');
  if(q&&q.clientHeight<Math.min(120,q.scrollHeight))return false;
  return true;
}

function _oneLine(card){
  for(const el of card.querySelectorAll('.mcf-text-body')){
    const cs=getComputedStyle(el);
    const fs=parseFloat(cs.fontSize)||16;
    if(el.getBoundingClientRect().height>fs*1.35*1.5)return false;
  }
  return true;
}

function _syncMore(){
  const c=_c;if(!c)return;
  const q=c.card.querySelector('.mcf-q');
  if(!q)return;
  const fixed=document.body.classList.contains('mcf-fixed');
  const scrolls=fixed&&q.scrollHeight>q.clientHeight+2;
  // A question that scrolls inside its own box must be reachable by keyboard, or
  // WebKit's Tab order skips straight past it and the rest of the question
  // cannot be read (WCAG 2.1.1). It is a named region only while it scrolls;
  // focus already inside it is never taken away.
  if(scrolls){
    if(q.getAttribute('tabindex')!=='0'){
      q.setAttribute('tabindex','0');q.setAttribute('role','region');q.setAttribute('aria-labelledby','mcf-q-title');
    }
  }else if(q.hasAttribute('tabindex')&&document.activeElement!==q){
    q.removeAttribute('tabindex');q.removeAttribute('role');q.removeAttribute('aria-labelledby');
  }
  const more=q.querySelector('.mcf-more');
  if(!more)return;
  const hidden=!scrolls||q.scrollTop+q.clientHeight>=q.scrollHeight-2;
  if(more.hidden!==hidden)more.hidden=hidden;
}

export function fitTapCard(){
  const c=_c;
  if(!c)return;
  const card=c.card;
  if(!card.isConnected){releaseTapChrome();return;}
  // Never re-lay the screen out under an open confirm or an answer in flight;
  // the caller runs this again once both have cleared.
  if(c.isBusy()||document.getElementById('modal-overlay')?.classList.contains('open')){c.pending=true;return;}
  c.pending=false;
  // Rotated or resized out of the device query: the full chrome comes back and
  // the tiles stay, so an answer in progress is never swapped for another view.
  if(!choiceTapDevice()){_applyChrome(false);card.dataset.mcfFit='chrome';_syncMore();return;}
  _applyChrome(true);
  // A measured scroll is re-tried when the WIDTH changes (a rotation, a split
  // screen): the content reflows, so the old verdict says nothing. A height-only
  // change is the browser's address bar coming and going while the page scrolls,
  // which is exactly the flapping the latch exists to stop.
  if(c.scroll&&!c.staticScroll&&window.innerWidth!==c.scrollW)c.scroll=false;
  if(c.scroll){
    document.body.classList.remove('mcf-fixed');
    card.dataset.mcfStep='s0';
    card.dataset.mcfFit='scroll';
    _syncMore();
    return;
  }
  // The ladder measures inside the fixed-height chain, which clamps the page's
  // scroll position to one screen; a verdict of "scroll" puts it back, so a
  // re-try (a width change, a card nobody has touched) never jumps the page.
  const se=document.scrollingElement||document.documentElement;
  const y0=se.scrollTop;
  document.body.classList.add('mcf-fixed');
  const many=card.querySelectorAll('.mcf-options .mcf-tile').length>=4;
  for(const step of STEPS){
    card.dataset.mcfStep=step;
    card.classList.remove('mcf-2col');
    if(_fits(card)){card.dataset.mcfFit='fixed';_syncMore();return;}
    if(many){
      card.classList.add('mcf-2col');
      if(_oneLine(card)&&_fits(card)){card.dataset.mcfFit='fixed';_syncMore();return;}
      card.classList.remove('mcf-2col');
    }
  }
  // Nothing fits: scroll — and once the participant has touched the card, stay
  // scrolling until the width changes or the challenge is reopened: flipping back
  // and forth on every resize would move the tile under a thumb.
  if(c.touched){c.scroll=true;c.scrollW=window.innerWidth;}
  card.dataset.mcfStep='s0';
  card.dataset.mcfFit='scroll';
  document.body.classList.remove('mcf-fixed');
  if(y0&&se.scrollTop!==y0)se.scrollTop=y0;
  _syncMore();
}

// Run a fit that was postponed while a confirm was open or an answer was in
// flight.
export function refitTapCardIfPending(){
  if(_c&&_c.pending)fitTapCard();
}
