"use strict";

import { S } from "../core/state.js";
import { html, setSafeHtml } from "../core/trusted-types.js";
import { esc } from "../ui/format.js";
import { ICO } from "../ui/icons.js";
import { installOverlayFocusTrap } from "../ui/modal.js";

export function _helpDefaultDocForRole(){
  if(typeof S.isSuperAdmin!=='undefined'&&S.isSuperAdmin)return 'admin.md';
  // v8.7.0 — an event admin reads its OWN guide. Tested BEFORE isAdmin, which is
  // also true for them: admin.md describes creating a blank event, platform
  // settings, logs and role changes, none of which they can reach, so opening on it would
  // hand them a manual for a panel they do not have.
  if(typeof S.isEventAdmin!=='undefined'&&S.isEventAdmin)return 'event-admin.md';
  if(typeof S.isAdmin!=='undefined'&&S.isAdmin)return 'admin.md';
  return 'participant.md';
}

export function _helpMemoryValidForRole(lastDoc){
  if(!lastDoc)return false;
  const file=lastDoc.split('/').pop();
  const adminish=(typeof S.isAdmin!=='undefined'&&S.isAdmin)||(typeof S.isSuperAdmin!=='undefined'&&S.isSuperAdmin);
  if(file==='participant.md')return !adminish;
  // v8.7.0 — an event admin may navigate INTO admin.md (the shared gated route
  // serves it) and back out again, so both files are valid memory for them.
  // event-admin.md is admin-ish only: a participant must never reopen it.
  if(file==='event-admin.md')return adminish;
  if(file==='admin.md')      return adminish;
  // v6.8.9: admins can access superadmin.md too (both see the same
  // access-gated route). Previously only superadmins could bring the
  // cached superadmin.md back after a close/reopen — admins would fall
  // back to admin.md even after they'd actively navigated there.
  if(file==='superadmin.md') return adminish;
  return false;
}



export function _helpRenderMarkdown(md, basePath){
  // Delegates to the shared renderer so the in-app drawer and the full-page
  // /help.html viewer cannot drift apart on image / link rendering. See
  // public/help-renderer.js for the implementation. linkMode:'drawer' makes
  // internal .md links emit data-help-nav so a click stays inside the drawer.
  if (window.HelpRenderer) return window.HelpRenderer.render(md, basePath, { linkMode: 'drawer' });
  // Defensive fallback if /help-renderer.js failed to load (rare — only on
  // CSP block or net failure). Show the raw markdown so the drawer isn't
  // empty.
  return `<pre style="white-space:pre-wrap">${esc(md)}</pre>`;
}

// v8.12.6 (sweep) — THE DRAWER SHOWS THE LAST DOCUMENT ASKED FOR. Every load
// awaits its fetch and then paints into the ONE drawer body, with nothing ordering
// the paints: two quick in-drawer link clicks (or the release-notes button while
// a guide is still loading) let whichever response landed LAST win, so a slower
// first document replaced the one the reader had clicked through to — and the
// "open in new tab" link and the drawer's doc memory followed the wrong one. The
// token is taken before the fetch and re-checked after the body is read (a
// response resolves at its headers, v7.15.15); a superseded load paints nothing.
let _helpLoadSeq=0;

// The ONE place `{{platformName}}` is filled in for the drawer — shared with
// helpDocHeadings below, because a heading's anchor (its slug) is derived from
// the SUBSTITUTED text: the palette must compute the id the drawer will render.
function _helpSubstitutePlatformName(md){
  return md.replace(/\{\{platformName\}\}/g, esc((typeof S.currentPlatformName !== 'undefined' && S.currentPlatformName) || 'Tournament'));
}

/**
 * The headings of one guide, as the drawer renders them: [{id, text, level}].
 * Used by the command palette's Help section (features/command-palette.js).
 * The markdown goes through the drawer's own pipeline (substitution, then the
 * shared renderer, which assigns the slug ids) into an INERT document, so no
 * image in the guide is fetched and nothing is painted. null when the guide
 * cannot be read (a 401 for a guide this role may not open, a network error).
 */
export async function helpDocHeadings(path){
  let md='';
  try{
    const r=await fetch(path);
    if(!r.ok)return null;
    md=await r.text();
  }catch(_){ return null; }
  const doc=document.implementation.createHTMLDocument('');
  const box=doc.createElement('div');
  setSafeHtml(box,_helpRenderMarkdown(_helpSubstitutePlatformName(md),path));
  return [...box.querySelectorAll('h1[id],h2[id],h3[id]')].map(h=>({id:h.id,text:(h.textContent||'').trim(),level:Number(h.tagName.slice(1))})).filter(h=>h.text);
}

/** The guide (or guides) a role's Help covers: the drawer's default, plus the
 *  superadmin guide for a superadmin (the shared gated route serves it). */
export function helpDocsForRole(){
  const docs=[`/docs/user-guide/${_helpDefaultDocForRole()}`];
  if(typeof S.isSuperAdmin!=='undefined'&&S.isSuperAdmin)docs.push('/docs/user-guide/superadmin.md');
  return docs;
}

export async function _helpLoadDoc(path, frag){
  // path is an absolute /docs/... URL. `frag` is an optional heading id to
  // scroll to — a cross-guide link like `admin.md#alerts` is useless if it
  // dumps the reader at the top of a 900-line document (v7.16.2).
  const seq=++_helpLoadSeq;
  const body=document.getElementById('help-drawer-body');
  setSafeHtml(body, '<p style="color:var(--muted);padding:24px">Loading…</p>');
  let md='';
  try{
    const r=await fetch(path);
    if(r.ok) md=await r.text();
    else if(r.status===401) md=`# Sign in required\n\nThis guide is only available to admins. [Back to the participant guide](/docs/user-guide/participant.md).`;
    else md=`Failed to load ${path} (${r.status}).`;
  }catch(e){md=`Failed to load ${path}: ${e.message}`;}
  if(seq!==_helpLoadSeq)return;   // superseded by a later load — it owns the body now
  // Substitute the platform-name placeholder BEFORE markdown parse so the
  // rendered output carries the currently-configured name from Settings
  // (loadPlatformName() → applyPlatformName() at boot). Fallback to
  // 'Tournament' matches the server-side default in getPlatformName().
  // v6.3.4: HTML-escape the platform name before it lands in a markdown
  // body — marked.js preserves inline HTML by default, so an admin-set
  // platform_name containing markup (e.g. `<img onerror=…>`) would
  // otherwise reach innerHTML as live markup. Escaping keeps the value
  // a string identity regardless of what the admin typed. See help.js
  // for the same fix on the /help.html viewer.
  md = _helpSubstitutePlatformName(md);
  const html=_helpRenderMarkdown(md, path);
  setSafeHtml(body, html);
  S._helpLastDoc=path;
  // Scroll to top for new doc…
  body.scrollTop=0;
  // …unless the link named a section, in which case go there. The drawer is a
  // scroll CONTAINER, so location.hash would do nothing here — the element has
  // to be scrolled into view explicitly.
  if(frag){
    const target=body.querySelector('#'+(window.CSS&&CSS.escape?CSS.escape(frag):frag));
    if(target){
      const align=()=>{ if(target.isConnected&&seq===_helpLoadSeq)target.scrollIntoView({block:'start'}); };
      align();
      // Screenshots ABOVE the heading decode after this and push it down the
      // page, so re-align as each one loads — until the reader moves the drawer
      // themselves (then their scroll is theirs).
      let moved=false;
      const stop=()=>{moved=true;};
      for(const ev of ['wheel','touchstart','keydown','pointerdown'])body.addEventListener(ev,stop,{once:true,passive:true});
      body.querySelectorAll('img').forEach(img=>{
        if(img.complete||!(img.compareDocumentPosition(target)&Node.DOCUMENT_POSITION_FOLLOWING))return;
        img.addEventListener('load',()=>{ if(!moved)align(); },{once:true});
      });
    }
  }
  // Update the "Open in new tab" link target. Point at the full-page
  // rendered viewer (/help.html) rather than the raw markdown file, so
  // clicking ↗ shows the same HTML + {{platformName}} substitution the
  // drawer shows — /docs/*.md served by express.static would otherwise
  // render as raw markdown text with unresolved placeholders.
  const open=document.getElementById('help-open-ext');
  if(open)open.setAttribute('href', '/help.html?doc='+encodeURIComponent(path));
}

// v8.5.0 — `title` is the ONE thing a second consumer of this drawer needs, and
// the release-notes button is that consumer. The drawer already owns the focus
// trap, the shared Escape stack, the markdown pipeline, the theme-aware
// screenshot swap and the "open in new tab" hand-off; a second drawer would be a
// second copy of all five, and this codebase's recurring lesson is that a copy is
// correct on the day it is written and silently divergent afterwards.
//
// The drawer's own doc MEMORY needs no new guard: `_helpMemoryValidForRole`
// answers false for any file it does not recognise, so release-notes.md can never
// become the sticky default the `?` button reopens.
export async function openHelpDrawer(docPath, opts){
  const overlay=document.getElementById('help-drawer-overlay');
  if(!overlay)return;
  const title=(opts&&opts.title)||'Help';
  // Build the drawer shell on first open (or re-open after close — harmless
  // re-render keeps the event listeners wired to current state). No version
  // subtitle: the screenshots manifest is an ops artifact, not something
  // end-users of the help drawer need to see.
  // v6.9.22: backdrop no longer carries data-action="help-close" — this
  // aligns the help drawer with the v6.8.10 "backdrop click never
  // closes a modal" contract. Users still close the drawer via the
  // explicit × button or Escape.
  setSafeHtml(overlay, `
    <div class="help-backdrop"></div>
    <!-- v8.11.12 — A <div>, NOT AN <aside>, AND A <div> HEAD RATHER THAN A <header>.
         Both halves are one defect. role="dialog" on an <aside> overrides its
         native complementary semantics, and that promotes the nested <header>
         to a DOCUMENT-LEVEL banner: with the drawer open the page carried TWO
         banners (#app-header and this one), neither labelled — axe
         landmark-no-duplicate-banner + landmark-unique, both moderate. It
         also raised aria-allowed-role (minor): ARIA in HTML does not permit
         dialog on <aside>.
         A <header> is only a banner when it has no sectioning ancestor — and
         axe resolves that against sectioning elements WITHOUT a role, plus an
         explicit short list of landmark roles (article, complementary,
         navigation, region). role=dialog is on neither list, so it was the ROLE
         that removed this header's sectioning ancestor, not the element. Hence
         both move together: <div role=dialog> leaves the header exposed just as
         <aside role=dialog> did, and <aside role=complementary> would not have
         been a defect at all.
         aria-modal, aria-label and the focus trap are untouched and
         LOAD-BEARING (v6.9.22, v8.11.7). Every selector for these two is
         class-based and aside appears nowhere in the stylesheet, so nothing
         moves visually. -->
    <div class="help-drawer" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="help-drawer-head">
        <div class="help-drawer-title">${esc(title)}</div>
        <div class="help-drawer-actions">
          <a id="help-open-ext" href="#" target="_blank" rel="noopener noreferrer" title="Open in new tab" aria-label="Open in new tab" class="help-icon-btn">${ICO.externalLink}</a>
          <button type="button" class="help-icon-btn" data-action="help-close" title="Close (Esc)" aria-label="Close ${esc(title.toLowerCase())}">${ICO.x}</button>
        </div>
      </div>
      <!-- v6.8.2 — tabindex=0 makes the scrollable markdown region keyboard-
           reachable (axe scrollable-region-focusable rule). v6.8.5 — adds
           role=region + aria-label so screen readers announce the drawer
           body as a navigable landmark rather than unnamed scroll area. -->
      <div id="help-drawer-body" class="help-drawer-body" tabindex="0" role="region" aria-label="Help content"></div>
    </div>`);
  overlay.hidden=false;
  overlay.classList.add('help-open');
  // v6.8.2 — focus trap. Keep Tab/Shift+Tab inside the drawer until it
  // closes. Without this, Tab from the last focusable element fell
  // through to the page underneath — which breaks the "modal =
  // exclusive focus context" expectation keyboard users have.
  // v6.8.3 — now uses the generic installOverlayFocusTrap helper that
  // every overlay in the app goes through. The helper returns a
  // cleanup callback we invoke in closeHelpDrawer() since the drawer
  // overlay is hidden (not removed) on close — without the explicit
  // removal, repeated open→close cycles would leak listeners.
  S._helpOpenerEl = document.activeElement;
  if (S._helpRemoveTrap) { try { S._helpRemoveTrap(); } catch (e) { console.warn('Help: could not release the focus trap', e); } S._helpRemoveTrap = null; }
  S._helpRemoveTrap = installOverlayFocusTrap(overlay);
  // v6.9.22: push onto the shared modal Escape stack so the drawer
  // participates in the same LIFO order as every other modal. A
  // confirm opened from inside the drawer now pops the confirm
  // first, not the drawer. Pre-v6.9.22 the drawer had its own
  // document-level keydown listener that could double-fire with
  // overlayDismiss's listener.
  if (window._modalEscStack && !window._modalEscStack.includes(closeHelpDrawer)) {
    window._modalEscStack.push(closeHelpDrawer);
  }
  // Move initial focus into the drawer so the next Tab lands on the
  // close button instead of somewhere in the underlying page.
  setTimeout(() => {
    const first = overlay.querySelector("[data-action=help-close]");
    if (first) first.focus();
  }, 0);
  // Priority: explicit docPath (internal link click) > valid-for-role
  // cached doc > role-default. The role-guard prevents an anonymous-era
  // participant.md from sticking around when the user is now an admin.
  const cached=_helpMemoryValidForRole(S._helpLastDoc)?S._helpLastDoc:null;
  const doc=docPath||cached||`/docs/user-guide/${_helpDefaultDocForRole()}`;
  // `opts.frag` — a heading id to land on (the command palette's Help results).
  await _helpLoadDoc(doc, (opts&&opts.frag)||'');
}

export function closeHelpDrawer(){
  const overlay=document.getElementById('help-drawer-overlay');
  if(!overlay)return;
  overlay.classList.remove('help-open');
  overlay.hidden=true;
  // v6.9.22: pop our callback from the shared Escape stack. The
  // MutationObserver auto-cleanup inside overlayDismiss only fires
  // on DOM removal; the help drawer is hidden rather than removed,
  // so we clean up manually here.
  if (window._modalEscStack) {
    const i = window._modalEscStack.indexOf(closeHelpDrawer);
    if (i >= 0) window._modalEscStack.splice(i, 1);
  }
  // Explicit cleanup for the focus trap (MutationObserver inside the
  // helper only fires on DOM removal, and we just hide the overlay).
  if (S._helpRemoveTrap) { try { S._helpRemoveTrap(); } catch (e) { console.warn('Help: could not release the focus trap', e); } S._helpRemoveTrap = null; }
  // Restore focus to whatever opened the drawer (Help button on the
  // header) so keyboard users don't land back at the document root.
  if (S._helpOpenerEl && typeof S._helpOpenerEl.focus === "function") {
    try { S._helpOpenerEl.focus(); } catch (e) { console.warn('Help: could not return focus', e); }
  }
  S._helpOpenerEl = null;
}

// THE HEADER'S HELP SLOT holds two buttons and CSS shows one:
//   • signed out, "?" (#help-icon-btn) opens the participant guide — there is no
//     account menu or palette before sign-in;
//   • signed in (#app-header.is-app), Search (#app-search-btn) opens the command
//     palette (features/command-palette.js, also Ctrl/⌘+K), whose Help section
//     searches the role's guide; Help itself is also in the account menu.
// The shortcut hint is painted from data-glyph (CSS), never DOM text, so the
// button's accessible name is just "Search" (label-in-name).
export function _helpMountIcon(){
  const slot=document.getElementById('help-slot');
  if(!slot)return;
  const mac=/Mac|iPhone|iPad/.test((navigator.userAgentData&&navigator.userAgentData.platform)||navigator.platform||'');
  const keys=mac?"Meta+K":"Control+K";
  const hint=mac?"⌘K":"Ctrl K";
  setSafeHtml(slot, `<button type="button" id="help-icon-btn" class="help-icon-btn help-trigger" data-action="help-open" title="Help" aria-label="Help">?</button>`
    +`<button type="button" id="app-search-btn" class="app-search-btn" data-action="open-command-palette" aria-haspopup="dialog" aria-keyshortcuts="${keys}"><span class="app-search-ico" aria-hidden="true">${ICO.search}</span><span class="app-search-label">Search</span><span class="app-search-kbd" data-glyph="${hint}" aria-hidden="true"></span></button>`);
}
