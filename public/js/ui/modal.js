"use strict";

import { setSafeHtml } from "../core/trusted-types.js";
import { esc } from "./format.js";

// v7.14.0 — the finisher of whichever modal currently owns the shared,
// persistent #modal-overlay. showModal/_countdownConfirm both repurpose that one
// element (rewriting its title/body and REBINDING confirm/cancel onclick), so a
// modal opened while another is still awaiting used to orphan the first one's
// promise forever: its `.finally()` never ran, its overlayDismiss cleanup never
// ran (leaking an Esc-stack entry + a capturing focus-trap keydown that then
// intercepted every Tab page-wide), and any caller awaiting it hung with no
// error. Reachable today via the impersonation confirm (core/api.js holds it in
// a module-level promise, so an orphan wedges EVERY later write) racing the
// competition-ended popup, which fires an unawaited POST then opens a modal on
// the next statement. Settling the incumbent as Cancel before taking the overlay
// fixes the whole class, not just that pair.
let _activeFinish=null;

// v8.13.0 — one opt-in option for a confirm raised by a TAP (the booth
// tap-to-answer tiles, features/choice-tap.js); every other dialog leaves it
// unset and behaves exactly as before.
//
//   armMs        the confirm button ignores activation for this long after the
//                dialog opens. A tile opens the dialog on the FIRST tap of a double
//                tap, and the second lands wherever the dialog has just appeared —
//                on a phone that can be the confirm button itself, which would
//                submit a penalised answer the participant never saw a question
//                about. Cancel and Escape work at once; nothing changes visually
//                (a dimmed button would be the opacity-on-text anti-pattern).
//                A held Enter is refused too: its auto-repeat would otherwise click
//                the freshly focused confirm button once the arm ran out.
// There is deliberately no separate accessible-name option: the confirm's VISIBLE
// text is its name, so it can never fail WCAG 2.5.3 (a voice-control user says
// what they see).
export function showModal({title,message,confirmText='Confirm',confirmClass='danger',cancelText='Cancel',wide=false,armMs=0}){
  return new Promise(resolve=>{
    if(_activeFinish){const f=_activeFinish;_activeFinish=null;f(false);}
    const overlay=document.getElementById('modal-overlay');
    const box=document.getElementById('modal-box');
    // min(target, viewport - margin) keeps the modal usable down to mobile widths.
    box.style.maxWidth=wide?'min(780px, calc(100vw - 32px))':'min(420px, calc(100vw - 32px))';
    document.getElementById('modal-title').textContent=title;
    setSafeHtml(document.getElementById('modal-body'),message);
    const confirmBtn=document.getElementById('modal-confirm-btn');
    confirmBtn.textContent=confirmText;
    confirmBtn.className=`btn${confirmClass?' '+confirmClass:''}`;
    const cancelBtn=document.getElementById('modal-cancel-btn');
    cancelBtn.textContent=cancelText||'';
    cancelBtn.style.display=cancelText?'':'none';
    overlay.classList.add('open');
    box.setAttribute('role','dialog');
    box.setAttribute('aria-modal','true');
    box.setAttribute('aria-labelledby','modal-title');
    // ext-audit batch 3 (F4): snapshot the opener BEFORE moving focus into the
    // dialog. Pre-fix document.activeElement was read AFTER confirmBtn.focus(),
    // so _prevFocus stored the confirm button itself — closing then restored
    // focus to the (now-hidden) modal control instead of the element that
    // invoked the modal. Capture first, then focus.
    const _prevFocus=document.activeElement;
    // The primary takes focus WITHOUT scrolling to it: on a message longer than
    // the box, scrolling to the foot hid the title and the start of the message.
    // The box is shared, so a scroll the last modal left is undone first.
    box.scrollTop=0;
    confirmBtn.focus({preventScroll:true});
    // v6.8.10: the confirm modal used to push its own Escape handler onto
    // `_modalEscStack`. `overlayDismiss` now owns that path universally —
    // it pushes the close callback on mount and the MutationObserver
    // below auto-pops when the overlay is removed. The confirm's
    // `finish(false)` callback is what we pass to overlayDismiss, so
    // Escape still resolves the promise with `false` (= Cancel).
    // ext-audit F3: #modal-overlay is the SHARED, persistent overlay — it is
    // toggled via `.open`, never removed from the DOM, so overlayDismiss's
    // DOM-removal MutationObserver never fires for it. Capture the cleanup it
    // returns and run it on close so the Escape-stack entry + the capturing
    // focus-trap keydown listener don't leak (and the stale trap can't hijack
    // Tab once the modal is closed-but-still-in-DOM).
    let cleanup=()=>{};
    let done=false;
    const finish=ok=>{
      if(done)return;   // a clobbered modal is settled once, by whoever got there first
      done=true;
      if(_activeFinish===finish)_activeFinish=null;
      cleanup();
      overlay.classList.remove('open');box.style.maxWidth='';cancelBtn.style.display='';
      confirmBtn.onkeydown=null;
      if(_prevFocus&&_prevFocus.focus)_prevFocus.focus();
      resolve(ok);
    };
    const _armedAt=armMs>0?performance.now()+armMs:0;
    confirmBtn.onclick=()=>{ if(_armedAt&&performance.now()<_armedAt)return; finish(true); };
    confirmBtn.onkeydown=armMs>0?(e=>{ if(e.repeat&&(e.key==='Enter'||e.key===' '))e.preventDefault(); }):null;
    cancelBtn.onclick=()=>finish(false);
    cleanup=overlayDismiss(overlay,()=>finish(false));
    _activeFinish=finish;
  });
}

export function _countdownConfirm(name,typeLabel){
  return new Promise(resolve=>{
    if(_activeFinish){const f=_activeFinish;_activeFinish=null;f(false);} // see showModal
    const overlay=document.getElementById('modal-overlay');
    const confirmBtn=document.getElementById('modal-confirm-btn');
    const cancelBtn=document.getElementById('modal-cancel-btn');
    document.getElementById('modal-title').textContent=`Ending ${typeLabel}...`;
    confirmBtn.style.display='none';
    cancelBtn.textContent='Cancel';
    overlay.classList.add('open');
    let secs=10;
    const update=()=>{
      setSafeHtml(document.getElementById('modal-body'), 
        `<strong>${esc(name)}</strong> is ending in <span style="font-size:var(--fs-40);font-weight:var(--fw-semibold);color:var(--red);display:block;margin:12px 0">${secs}</span>Click Cancel to abort.`);
    };
    update();
    // ext-audit F3 — see showModal: capture + run overlayDismiss's cleanup on
    // close so the shared #modal-overlay doesn't leak an Esc-stack entry + a
    // focus-trap listener every countdown.
    let cleanup=()=>{};
    let done=false;
    const finish=ok=>{
      if(done)return;
      done=true;
      if(_activeFinish===finish)_activeFinish=null;
      clearInterval(iv);cleanup();confirmBtn.style.display='';overlay.classList.remove('open');resolve(ok);
    };
    const iv=setInterval(()=>{secs--;if(secs<=0){finish(true);return;}update();},1000);
    cancelBtn.onclick=()=>finish(false);
    cleanup=overlayDismiss(overlay,()=>finish(false));
    _activeFinish=finish;
  });
}

export function overlayDismiss(overlay,fn){
  // v6.8.10: no backdrop-click-close. Callers still pass `fn` — it's
  // wired to Escape below and (externally) to explicit Cancel / X
  // buttons. Two overlays on this path close on a press outside their panel
  // by their own listener, named exceptions because an outside press loses
  // nothing there: the account menu (a menu, ui/nav.js openProfileMenu) and
  // the command palette (a search, features/command-palette.js); operator
  // ruling, 14 Nov 2026.
  const entry={overlay,fn};
  window._modalEscStack.push(entry.fn);
  // ext-audit batch 3 (F4): systemic focus restoration. Snapshot the element
  // that had focus when the overlay mounted — but ONLY if it's a real control
  // OUTSIDE this overlay (the opener). Overlays that call overlayDismiss BEFORE
  // moving focus into themselves (the common pattern: overlayDismiss(); then a
  // setTimeout focus) get their opener captured here for free. Overlays that
  // focus an inner control FIRST leave activeElement inside the overlay → _opener
  // stays null and they own restoration themselves (e.g. showModal). On cleanup
  // we restore focus to the opener, but only if focus is still trapped inside the
  // (closing) overlay or has fallen to <body> — never stealing focus the app
  // deliberately moved elsewhere.
  const _opener=(document.activeElement&&document.activeElement!==document.body&&!overlay.contains(document.activeElement))?document.activeElement:null;
  // ext-audit F3: return an idempotent cleanup() so a SHARED, persistent
  // overlay (e.g. #modal-overlay, toggled via `.open` and never removed) can
  // be torn down on close. Pre-fix overlayDismiss discarded
  // installOverlayFocusTrap's removeTrap and relied SOLELY on the DOM-removal
  // MutationObserver below — which never fires for a persistent overlay, so
  // each open leaked an Esc-stack entry + a capturing keydown focus-trap
  // listener (and the stale trap kept hijacking Tab after the modal closed).
  // Dynamic overlays that are .remove()d still auto-clean via the observer.
  let removeTrap=()=>{};
  let mo=null;
  let cleaned=false;
  // `cleanup({restoreFocus:false})` drops the contract from an overlay that stays
  // on screen as something else (a phone sheet widened into an inline panel):
  // focus stays where it is.
  const cleanup=(opts)=>{
    if(cleaned)return;
    cleaned=true;
    const i=window._modalEscStack.indexOf(entry.fn);
    if(i>=0)window._modalEscStack.splice(i,1);
    try{removeTrap();}catch(_){/* no-op */}
    if(mo){try{mo.disconnect();}catch(_){/* no-op */}}
    // Restore focus to the opener (ext-audit batch 3 F4) — only if focus is
    // still inside the closing overlay or has dropped to <body>, so a dialog
    // that programmatically handed focus to a NEW control on close keeps it.
    if(_opener&&typeof _opener.focus==='function'&&!(opts&&opts.restoreFocus===false)){
      const ae=document.activeElement;
      if(!ae||ae===document.body||overlay.contains(ae)){try{_opener.focus();}catch(_){/* no-op */}}
    }
  };
  // Auto-pop the Escape binding when the overlay is removed from the
  // DOM (matches the installOverlayFocusTrap lifecycle).
  try{
    mo=new MutationObserver(()=>{
      if(!document.body.contains(overlay))cleanup();
    });
    mo.observe(document.body,{childList:true,subtree:true});
  }catch(_){/* older browsers: the stack grows until navigation */}
  removeTrap=installOverlayFocusTrap(overlay)||removeTrap;
  applyDialogAria(overlay);
  return cleanup;
}

// v6.20.x — auto-apply dialog ARIA to the overlay's card so screen readers
// announce it as a modal dialog and read its heading as the accessible name.
// Called from overlayDismiss (the single mount path) so call sites don't each
// have to remember role/aria-modal/aria-labelledby — AND exported so dialogs
// that re-render their card (which wipes these attributes) can re-apply it on
// every render. Skips cards that already declare a role (ts-form / task-preview
// / session-warn set their own).
export function applyDialogAria(overlay){
  try{
    const card=overlay.querySelector('.card, #modal-box, .picker-modal');
    if(card && !card.getAttribute('role')){
      card.setAttribute('role','dialog');
      card.setAttribute('aria-modal','true');
      if(!card.getAttribute('aria-labelledby')){
        const heading=card.querySelector('h1, h2, h3, .modal-title');
        if(heading){
          if(!heading.id)heading.id='dlg-title-'+(window._dlgTitleSeq=(window._dlgTitleSeq||0)+1);
          card.setAttribute('aria-labelledby',heading.id);
        }
      }
    }
  }catch(_){/* non-fatal: dialog still works without the ARIA label */}
}

export function installOverlayFocusTrap(overlay){
  const handler=(e)=>{
    if(e.key!=='Tab')return;
    if(!document.body.contains(overlay))return;
    // Skip when the overlay is hidden (help drawer pattern — closed
    // drawers stay in the DOM but toggle `hidden` / `.help-open`).
    if(overlay.hidden===true)return;
    if(overlay.classList&&(overlay.classList.contains('hidden')))return;
    // Pick the inner card when present — the overlay element itself is
    // non-focusable. Falls back to the overlay if no `.card` match.
    const root=overlay.querySelector('#modal-box, .card, .help-drawer, .picker-modal')||overlay;
    // Convert to Array for indexOf() — querySelectorAll returns a live NodeList
    // which doesn't support indexOf. We need indexOf to always intercept Tab
    // (not just at boundaries) so focus can never escape the overlay regardless
    // of how many fields are disabled or what browser ARIA-modal scoping does.
    // v8.12.6 — only RENDERED, non-inert candidates. `.focus()` on an element
    // with no box (display:none) or inside an inert subtree is a SILENT no-op, so
    // an unfiltered list made the trap's own re-entry target dead: the mobile
    // drawer's fs[0] is #admin-sidebar-toggle, display:none at <=768px, so once
    // focus was outside the OPEN drawer (a click on its brand drops it to
    // #main-content) forward Tab went nowhere and stayed there. The same dead stop
    // sat in the ring of every dialog whose Cancel is hidden (showModal with a
    // null cancelText): harmless while the confirm is the only other stop, but
    // under impersonation Tab from the Exit button wrapped onto it and stayed on
    // Exit (derived from the ring, not measured). getClientRects, not offsetParent
    // — offsetParent is null for a position:fixed element, which would drop
    // legitimate fixed controls.
    const fs=Array.from(root.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(el=>el.getClientRects().length&&!el.closest('[inert]'));
    // Nothing of the overlay's own is reachable — a drawer that is closed, or
    // one whose trap outlived it — so the trap has nothing to hold and stands
    // aside. Checked BEFORE the impersonation Exit is added below, or such a trap
    // would pin every Tab to Exit for the rest of the session.
    if(!fs.length)return;
    // v7.14.0 — the impersonation Exit control is appended to <body>, OUTSIDE
    // every overlay, but it is the only way out of impersonation and must stay
    // keyboard-operable. Without this it is unreachable behind any trap — most
    // sharply behind the non-dismissible profile-completion gate, which a
    // READ-ONLY impersonating admin can never satisfy (PUT /api/me is refused),
    // leaving a keyboard-only admin with no operable escape at all.
    const _impExit=document.querySelector('#impersonation-banner [data-action="impersonation-exit"]');
    if(_impExit)fs.push(_impExit);
    // v6.10.30: if focus isn't inside the overlay yet — the initial-focus
    // setTimeout(0) during drawer open hasn't fired under CPU contention,
    // or an external widget stole focus between keypresses — redirect Tab
    // to land inside. The focus trap must be inviolate regardless of
    // transient race windows; without this guard, the browser's default
    // Tab behaviour moves focus to the next focusable in page order, which
    // is outside the modal.
    // (The impersonation Exit button counts as "inside" here — it was just
    // added to the ring above, so focus resting on it must cycle onward rather
    // than be yanked back to the first field.)
    if(!overlay.contains(document.activeElement)&&document.activeElement!==_impExit){
      e.preventDefault();
      (e.shiftKey?fs[fs.length-1]:fs[0]).focus();
      return;
    }
    // Always intercept Tab within the overlay — never fall through to browser
    // default navigation. Browser default Tab follows document order and can
    // escape the overlay in Chrome when role="dialog" aria-modal="true" is on
    // a child element (not the overlay root) and many fields are disabled.
    const idx=fs.indexOf(document.activeElement);
    e.preventDefault();
    if(e.shiftKey){(idx<=0?fs[fs.length-1]:fs[idx-1]).focus();}
    else{(idx>=fs.length-1?fs[0]:fs[idx+1]).focus();}
  };
  document.addEventListener('keydown',handler,true);
  let mo=null;
  try{
    mo=new MutationObserver(()=>{
      if(!document.body.contains(overlay)){
        document.removeEventListener('keydown',handler,true);
        if(mo)mo.disconnect();
      }
    });
    mo.observe(document.body,{childList:true,subtree:true});
  }catch(_){/* older browsers: trap stays attached until page unload */}
  return function removeTrap(){
    document.removeEventListener('keydown',handler,true);
    if(mo)mo.disconnect();
  };
}
