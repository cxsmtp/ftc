"use strict";

import { setSafeHtml } from "../core/trusted-types.js";
import { esc } from "./format.js";
import { overlayDismiss } from "./modal.js";

const _WIN_MARK=`<div class="ha-win-mark" aria-hidden="true">
          <i class="ha-win-ring"></i><i class="ha-win-ring r2"></i>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path class="ha-win-tick" d="m5 12.5 4.5 4.5L19 7.5"/></svg>
        </div>`;

export function showCongrats(title,pts,score,opts){
  // THE CELEBRATION: a drawn tick with two rings bursting off it, the points
  // rising into place and the new total. Every movement is a CSS animation the
  // global reduced-motion rule collapses to its end state (styles.css
  // "participant: celebration"). The heading text and the one Continue button
  // are what the flows and locks find. `opts.accepted`: an Any answer, which no
  // answer could have got wrong, is "Answer accepted", never "Correct".
  return _winDialog(`
        ${_WIN_MARK}
        <p class="eyebrow ha-win-eyebrow">${opts&&opts.accepted?'Answer accepted':'Correct'}</p>
        <h2 id="ha-win-h" class="display ha-win-h">Challenge Solved!</h2>
        <p class="ha-win-name">${esc(title)}</p>
        <div class="ha-win-plus"><span class="bignum">+${esc(String(pts))}</span> <span class="ha-win-unit">pts</span></div>
        <div class="ha-win-total">Total score: <strong>${esc(String(score))}</strong> pts</div>`);
}

// A qualifying question (lib/qualifying.js) has no right answer and scores
// nothing, so it is thanked, never congratulated: no "Correct", no points, no score.
export function showThanks(title){
  return _winDialog(`
        ${_WIN_MARK}
        <h2 id="ha-win-h" class="display ha-win-h">Thanks, noted</h2>
        <p class="ha-win-name">${esc(title)}</p>`);
}

function _winDialog(body){
  return new Promise(resolve=>{
    const overlay=document.createElement('div');
    overlay.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;background:var(--overlay);z-index:2000;display:flex;align-items:center;justify-content:center;padding:24px';
    setSafeHtml(overlay, `
      <div class="card ha-win" role="dialog" aria-modal="true" aria-labelledby="ha-win-h">${body}
        <button class="btn lg block">Continue</button>
      </div>`);
    document.body.appendChild(overlay);
    const dismiss=()=>{overlay.remove();resolve();};
    const _btn=overlay.querySelector('button');
    _btn.onclick=dismiss;
    // batch 3 (F4): overlayDismiss BEFORE moving focus in, so it snapshots the
    // opener (the solved challenge's control) and restores focus there on close.
    overlayDismiss(overlay,dismiss);
    _btn.focus(); // v7.2.x (audit, a11y) — move focus into the modal on open
    // audit v7.7.33 (AL7) — no auto-dismiss. Pre-fix the dialog force-closed
    // after 3s (WCAG 2.2.1: a focused modal carrying the earned points + new
    // total must not vanish on a fixed timer with no way to extend). It already
    // has a focused Continue button + Escape; the participant dismisses when ready.
  });
}

// v7.23.5 (audit Wave 5) — toasts live in a FLEX COLUMN, not on hand-computed
// offsets.
//
// The old placement was `bottom = 24 + offset*50` where `offset` was the
// SURVIVOR COUNT taken after evicting the oldest. With three toasts at
// bottom 24/74/124, evicting the one at 24 leaves survivors at 74 and 124, and
// offset then reads 2 — so the fourth toast was placed at 24+2*50 = 124, exactly
// on top of the survivor there, while the 24 slot sat empty. Two messages in one
// place, and toasts carry no dismiss control and no history, so the covered one
// is unrecoverable.
//
// It is NOT eviction-specific: any removal from the middle of the stack (ordinary
// expiry — error toasts live 6-15 s, info 4 s) desynchronises the survivors'
// positions from their count, so it fires in normal use.
//
// A flex column with a gap removes the arithmetic entirely: removal reflows for
// free and there is no index to get wrong. `column-reverse` keeps the newest
// nearest the anchor, which is what the old ascending offsets produced.
function _toastStack(){
  let st=document.getElementById('toast-stack');
  if(!st){
    st=document.createElement('div');
    st.id='toast-stack';
    document.body.appendChild(st);
  }
  return st;
}

// v8.12.7 — `opts.life` lets ONE caller keep a long informational toast up for
// reading time (AL15's reason, which it applied to errors only). Opt-in per call,
// deliberately not length-scaled for every toast: a long-lived toast sits over
// the bottom-right controls, and a global change would do that everywhere.
export function showToast(msg,type,opts){
  const stack=_toastStack();
  // Allow up to 3 toasts, remove oldest if exceeded. With the flex column the
  // survivors reflow, so nothing has to be repositioned.
  const existing=stack.querySelectorAll('.toast');
  if(existing.length>=3)existing[0].remove();
  const t=document.createElement('div');
  t.className='toast'+(type?' toast-'+type:'');
  // v6.9.23: pick role by toast type instead of setting both
  // role=alert AND aria-live=polite (they conflict — role=alert
  // implies aria-live=assertive). Error toasts are urgent → alert;
  // everything else is informational → status (polite).
  if (type === 'error' || type === 'danger') {
    t.setAttribute('role','alert');
  } else {
    t.setAttribute('role','status');
  }
  t.textContent=msg;
  stack.appendChild(t);
  // audit v7.7.33 (AL15) — error/danger toasts carry long, actionable, one-shot
  // diagnostics (e.g. "Approved 12. 3 skipped … 2 emails failed — check SMTP");
  // 4s is below reading time for those. Scale the lifetime with length for
  // errors, and pause the countdown while the pointer is over the toast (WCAG
  // 2.2.1 — user control over timing). Info toasts keep the 4s default.
  const isErr = type === 'error' || type === 'danger';
  const life = isErr ? Math.min(15000, Math.max(6000, msg.length * 90))
    : Math.min(15000, Math.max(4000, Number(opts && opts.life) || 0));
  let remaining = life, startedAt = Date.now(), timer = null;
  const arm = () => { startedAt = Date.now(); timer = setTimeout(() => t.remove(), remaining); };
  t.addEventListener('mouseenter', () => { if (timer) { clearTimeout(timer); remaining -= Date.now() - startedAt; } });
  t.addEventListener('mouseleave', () => { if (remaining > 0) arm(); });
  arm();
}

export function showPrompt({title,label,value='',placeholder='',confirmText='OK'}){
  return new Promise(resolve=>{
    const overlay=document.createElement('div');
    overlay.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;background:var(--overlay);z-index:3100;display:flex;align-items:center;justify-content:center;padding:24px';
    setSafeHtml(overlay,`<div class="card" style="max-width:min(400px, calc(100vw - 32px));width:100%;border-top-color:var(--accent)">
      <h3 style="margin-bottom:12px">${esc(title)}</h3>
      ${label?`<label style="font-size:var(--fs-13);font-weight:var(--fw-semibold);display:block;margin-bottom:6px">${esc(label)}</label>`:''}
      <input id="prompt-input" style="width:100%" placeholder="${esc(placeholder)}" data-enter-click-id="prompt-ok"/>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
        <button class="btn sm secondary" id="prompt-cancel">Cancel</button>
        <button class="btn sm" id="prompt-ok">${esc(confirmText)}</button>
      </div>
    </div>`);
    document.body.appendChild(overlay);
    const input=overlay.querySelector('#prompt-input');
    input.value=value;
    let settled=false;
    const done=(v)=>{if(settled)return;settled=true;overlay.remove();resolve(v);};
    overlay.querySelector('#prompt-cancel').onclick=()=>done(null);
    overlay.querySelector('#prompt-ok').onclick=()=>done(input.value);
    overlayDismiss(overlay,()=>done(null));
    input.focus();input.select();
  });
}
