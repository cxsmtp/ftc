"use strict";

// LinkedIn achievement-badge share flow (v7.1.0). Mints (or fetches) the
// caller's top-3 badge, then shows a preview modal with Share / Copy / Download.
// Sharing is link-intent: we open LinkedIn's composer with the public
// /badge/<token> URL; LinkedIn scrapes its OpenGraph tags to render the card.

import { S } from "../core/state.js";
import { csrfHeaders, readyToWrite, trackInflightWrite, _origFetch } from "../core/api.js";
import { showModal } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";
import { esc } from "../ui/format.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { ICO } from "../ui/icons.js";
import { copyText } from "../ui/clipboard.js";

/**
 * v8.3.25 — WHAT A READ-ONLY IMPERSONATING ADMIN MAY DO ON THIS DIALOG.
 *
 * The server's `impersonationReadOnlyWriteAllowed` (lib/impersonation.js) is the
 * authority; this is the client half of the same decision. Everything on this
 * dialog except two POSTs is a GET, and the mint is now allowed for both tiers —
 * so exactly ONE affordance here would still be refused, the LinkedIn share, and
 * it is withheld WITH its reason rather than offered and refused (v7.14.2).
 *
 * BOTH halves of the test are load-bearing. `S.impersonation` is null when the
 * session is not impersonating at all — which is every ordinary participant, the
 * overwhelming majority of the people this dialog serves — so the outer check is
 * what keeps the note and the withheld Share off their screen; the inner one is
 * the tier.
 */
function _readOnlyImpersonation(){ return !!(S.impersonation && !S.impersonation.superadmin); }
function _impersonatedName(){
  return esc((S.currentUser && (S.currentUser.nickname || S.currentUser.email)) || 'this participant');
}

export async function openBadgeShare(compId){
  if(!compId){ showToast('No event selected.','error'); return; }
  const _roImp=_readOnlyImpersonation();
  // A SUPERADMIN already meets a confirm here — the fetch interceptor fronts every
  // state-changing /api request in a superadmin impersonation session — so this
  // one is scoped to the tier that has none, rather than double-confirming.
  //
  // It is worth a click: minting is irreversible from this seat (revoking is
  // superadmin-only). (It used to add "and a PLACEMENT badge's page is public
  // from the moment it exists" — false since v8.6.2 made the withhold
  // platform-wide; corrected in v8.11.1.) The wording covers BOTH branches on purpose — this endpoint is
  // idempotent, so the same button re-opens a certificate that already exists,
  // and the client cannot tell the two apart before it asks.
  if(_roImp){
    const go=await showModal({
      title:'Generate this certificate?',
      message:`<p>You are impersonating <strong>${_impersonatedName()}</strong>.</p>
        <p>If they do not already have a certificate for this event, this creates one: a permanent
        record in their name carrying their credential code, which only a superadmin can revoke.
        If they already have one, this just opens it.</p>`,
      confirmText:'Generate certificate', confirmClass:'', cancelText:'Cancel',
    });
    if(!go)return;
  }
  let data;
  try{
    const r=await fetch(`/api/competitions/${compId}/badge`,{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'})});
    data=await r.json().catch(()=>({}));
    if(!r.ok){ showToast(data.error||'Could not create your badge.','error'); return; }
  }catch{ showToast('Network error creating your badge.','error'); return; }
  S._badgeShare=data;
  // Operator ruling, 29 Oct 2026 — the holder's ready-made LinkedIn post (the same
  // text the emailed share page shows), fetched NOW so the copy can run inside the
  // click that asks for it. A failure only withholds the button.
  data.post=null;
  if(!_roImp&&data.token){
    try{
      const pr=await _origFetch(`/api/me/certificates/${encodeURIComponent(data.token)}/linkedin-post`,{headers:{accept:'application/json'}});
      if(pr.ok){ const pj=await pr.json().catch(()=>null); if(pj&&typeof pj.text==='string'&&pj.composerUrl)data.post=pj; }
    }catch(_){ data.post=null; }
  }
  // BRANCH ON `basis` FIRST. The wire's `placement` comes from the frozen basis
  // too (lib/badge.js `isPlacementBasis`, the certificate tier's rule), so it is
  // false for a completion certificate and for a late entrant's participation
  // one whatever rank is stored beside them; it once followed the rank alone,
  // and this dialog titled a Program completer at board rank 1 "You placed
  // completed!" and a late entrant "You placed participant among the late
  // entrants!". The completion test is kept here as well: a title has to be
  // true of the certificate it is over. A legacy badge (no basis) derives both
  // from the rank.
  const _completion=data.basis==='completion';
  const _placement=!_completion&&!!data.placement; // top-3 placement vs generic participation
  const label=esc(data.rankLabel||(_placement?'Top 3':'Participant'));
  // v7.15.0 — the download options were undiscoverable: the entry button said
  // only "Share on LinkedIn", so people who wanted the certificate never opened
  // this dialog. The copy now names both outcomes, and the PDF sits alongside
  // the image (a PDF is what gets emailed or filed with a training record).
  // `pdfUrl` is derived from the badge page URL rather than sent by the server,
  // so no new response field is needed.
  const _pdfUrl=data.badgeUrl?`${data.badgeUrl}/certificate.pdf`:null;
  // Operator ruling, 23 Nov 2026 — viewed as the holder by an admin who may not
  // look certificates up by code, the answer carries no code and no token
  // (`withheld`): no picture, no download, no link, and the dialog says why.
  const _wh=!!data.withheld;
  const body=`
    <div class="badge-share">
      ${data.imageUrl?`<img class="badge-share-img" src="${esc(data.imageUrl)}" alt="${label} achievement certificate" width="1200" height="627" decoding="async" fetchpriority="low"/>`:''}
      ${_wh?`<p class="badge-imp-note badge-withheld-note">While you view as ${_impersonatedName()}, this certificate's code and downloads are hidden. Organisers can download it from the event's <strong>Certificates</strong> section.</p>`:''}
      <p class="badge-share-help">${_wh
        ? 'The certificate is issued: it is on their list, and they can download or share it themselves.'
        : _roImp
        // A read-only impersonation session cannot share, so the lead paragraph must
        // not open by offering it — otherwise this dialog promises LinkedIn two
        // paragraphs above the note explaining that LinkedIn is unavailable.
        ? 'Download this certificate below to keep — as an image, or as a PDF to email or file with a training record.'
        // LinkedIn sharing is LINK-ONLY: nothing is attached. "Share on LinkedIn"
        // posts a link to your certificate page (LinkedIn shows its preview image);
        // "Copy post & open LinkedIn" copies a ready-made post to paste.
        : 'Copy a ready-made post and paste it into LinkedIn, or share a link to your certificate page — LinkedIn shows its preview image; nothing is attached. Or download it below to keep.'}</p>
      ${/* v8.6.2 — SHOWN FOR EVERY KIND, because it is now true for every kind.
            Until v8.6.2 a Booth Event's and an Event's page went live at
            MINT, so this note was rendered only for a completion certificate —
            which is to say it was withheld from exactly the participants whose
            page had already been published without their being told. The server
            now withholds every unshared page, so the sentence describes the
            whole platform and belongs in front of everyone. */''}
      ${_wh?'':`<p class="badge-claim-note">
        <strong>Downloading is private.</strong> Your certificate page becomes public only if you
        choose to share it — and it then names you and is built to be found by search engines
        and link previews. Nothing is published until you press Share or Copy post &amp; open LinkedIn.
      </p>`}
      ${data.lateEntrant?`<p class="badge-claim-note">
        <strong>This certificate says &ldquo;late entrant&rdquo;.</strong> You joined after the
        event had ended, during its late-entry window, so you are ranked among the other
        late entrants rather than on the main leaderboard. The certificate says so on its face
        and on its verification page.
      </p>`:''}
      ${/* ONE note about the printed name, never two: the server's flags say
            what the artwork prints, and a nickname has no salutation to leave
            off (operator ruling, 14 Nov 2026). */''}
      ${data.name_fallback?`<p class="badge-name-note">This certificate shows your <strong>nickname</strong>, because the certificate typeface cannot draw your name. To use a different spelling, set a <strong>Certificate name</strong> in your profile.</p>`
        :(data.salutation_dropped?`<p class="badge-name-note">Your salutation is left off: the certificate typeface cannot print it with your name.</p>`:'')}
      ${_roImp&&!_wh?`<p class="badge-imp-note">
        <strong>You are impersonating ${_impersonatedName()}.</strong> You can generate this
        certificate for them and download it as an image or a PDF.
        <strong>Sharing to LinkedIn is not available</strong> in a read-only impersonation
        session, so nothing is published from here &mdash; ${_impersonatedName()} can share it
        themselves, and a superadmin can share it on their behalf.
      </p>`:''}
      <div class="badge-share-secondary">
        ${data.post?`<button type="button" class="btn sm badge-copy-post" data-action="badge-copy-post">${ICO.copy||''} Copy post &amp; open LinkedIn</button>`:''}
        ${_pdfUrl?`<a class="btn sm secondary" role="button" href="${esc(_pdfUrl)}" download>${ICO.download||''} Download certificate (PDF)</a>`:''}
        ${data.imageUrl?`<a class="btn sm secondary" role="button" href="${esc(data.imageUrl)}?dl=1" download="hack-arena-certificate.png">${ICO.download||''} Download image (PNG)</a>`:''}
        ${data.badgeUrl?`<button type="button" class="btn sm secondary" data-action="badge-copy-link">Copy badge link</button>`:''}
      </div>
      ${data.post?`<p class="badge-share-tip">To tag <strong>Checkmarx</strong> and the organisers, type <strong>@</strong> in LinkedIn and pick them from its suggestions &mdash; a link cannot create real tags.</p>`:''}
    </div>`;
  const ok=await showModal({
    // v8.6.0 — a late entrant's placement is among the LATE entrants, so the title
    // says so rather than claiming the event. Same class as the v8.3.25 fix that
    // stopped a Program's completion certificate reading "You placed completed!":
    // a title has to be true of the certificate it is over.
    title:_completion?'Your certificate is ready'
      :(_placement
        ? (data.lateEntrant
          ? `You placed ${(data.rankLabel||'top 3').toLowerCase()} among the late entrants!`
          : `You placed ${(data.rankLabel||'top 3').toLowerCase()}!`)
        : 'Share your participation!'),
    message:body,
    // The share is the modal's PRIMARY button, so withholding it means collapsing
    // to a single dismiss control rather than hiding one: showModal hides Cancel
    // on a null `cancelText` and has no such path for the confirm, and teaching it
    // one would move focus handling for every dialog in the app (the primary holds
    // focus on open) for one caller.
    confirmText:_roImp||_wh?'Close':'Share on LinkedIn',
    confirmClass:'',
    cancelText:_roImp||_wh?null:'Close',
    wide:true,
  });
  // `_roImp` is re-tested rather than relying on the button label: with the
  // confirm relabelled to Close, `ok` is TRUE on the ordinary way out of this
  // dialog, so a bare `if(ok)` would share on every dismissal.
  if(!_roImp&&!_wh&&ok&&S._badgeShare&&S._badgeShare.shareUrl){ await shareBadgeToLinkedIn(S._badgeShare); }
}

/**
 * v8.1.4 — the LinkedIn hand-off, and WHEN it is allowed to proceed.
 *
 * `POST /badge/<token>/shared` was written at v7.21.31 as pure telemetry, so it
 * was fire-and-forget with `.catch(()=>{})` and the composer opened regardless.
 * PR 26 then made that same call the SOLE trigger that stamps `shared_at` and
 * publishes a completion certificate's page — and left the client unchanged. So
 * a dropped connection, a 429 from the 30/min bucket or a stale-CSRF 403 was
 * swallowed, LinkedIn's composer opened anyway, and the participant publicly
 * posted a link that permanently returns the withheld 404 — while this dialog's
 * own copy promises "Nothing is published until you press Share".
 *
 * THE GATE IS PER PAGE, NOT PER KIND (v8.11.1, external audit F7). It was per
 * kind, keyed on `basis`, and that was right when v8.1.6 wrote it: only a
 * COMPLETION certificate's page waited on the Share, so for every other kind the
 * POST really was telemetry and the v7.21.31 rule held — a failed audit must
 * never cost the participant their share. v8.6.2 then made the withhold
 * PLATFORM-WIDE and this branch was not moved, so a placement share opened the
 * composer at a page that 404s and a failed publish said nothing at all.
 *
 * The discriminator is now the server's own `published` flag
 * (`!_badgePageWithheld`, shipped on the mint payload), which is the same
 * predicate the page and the certificates list read — so there is one answer
 * rather than a client-side restatement of a rule that has already moved once.
 * A GRANDFATHERED pre-gate badge reports `published:true` and keeps the
 * fire-and-forget path, because its page is genuinely live.
 */
export async function shareBadgeToLinkedIn(badge){
  let sharedPath=null;
  try{ sharedPath=`${new URL(badge.badgeUrl,window.location.origin).pathname}/shared`; }
  catch(_){ sharedPath=null; }

  // v8.11.1 (external audit F7) — BRANCH ON WHETHER THE PAGE IS ALREADY LIVE,
  // NOT ON THE KIND.
  //
  // This read `badge.basis!=='completion'`, which was right when v8.1.6 wrote it:
  // a placement page was public from the moment it was minted, so recording the
  // share was pure telemetry and must never block it. v8.6.2 then made the
  // withhold PLATFORM-WIDE — every unshared page 404s — and this branch was not
  // moved, so a placement share opened the LinkedIn composer pointing at a page
  // that did not exist yet, and a failed publish left the holder posting a dead
  // link with no error shown. MEASURED: a freshly minted placement badge answers
  // 404 to its own OWNER until the POST lands.
  //
  // `=== true` STRICTLY, never truthiness: a stale client or an older payload
  // with no field must fall to the SAFE await path below. And do not simply
  // delete the condition — a pre-gate badge is genuinely live (it is
  // grandfathered by the share-gate floor), so routing it through the await
  // would tell its holder "nothing was shared" on a transient failure and close
  // a composer for a page that works.
  if(!sharedPath||badge.published===true){
    // Already public: record the share, never block on it (v7.21.31).
    // These POSTs bypass the interceptor, so they ask for themselves whether the
    // token in hand is the live session's (core/api.js `readyToWrite`: this
    // tab's own session change, then another tab's) — here after the popup,
    // which must open first.
    if(sharedPath){ readyToWrite().then(ok=>{ if(ok)trackInflightWrite(_origFetch(sharedPath,{method:'POST',headers:csrfHeaders(),keepalive:true})).catch(e=>console.warn('Share record failed',e)); }).catch(e=>console.warn('Share record not sent',e)); }
    window.open(badge.shareUrl,'_blank','noopener,noreferrer');
    return;
  }

  // THE POPUP IS OPENED SYNCHRONOUSLY — still inside the task the confirm click
  // started — and only NAVIGATED once the server confirms the page is live.
  //
  // The alternative shape (await, then open) is simpler and wrong for exactly the
  // people this fixes: a popup blocker requires transient user activation, which
  // Chrome expires ~5s after the gesture, so a slow-but-successful publish on
  // venue wi-fi would publish the page and then have the composer blocked. The
  // cost of opening first is that `noopener` cannot be passed — with it
  // `window.open` returns null and there would be nothing left to navigate — so
  // the opener is severed by hand while the popup is still a same-origin
  // about:blank. That severing survives the later cross-origin navigation.
  const win=window.open('','_blank');
  try{ if(win)win.opener=null; }catch(_){ /* a browser may refuse the write; the handle is still ours */ }

  let published=false;
  try{
    if(!(await readyToWrite()))throw new Error('session changed');
    const r=await trackInflightWrite(_origFetch(sharedPath,{method:'POST',headers:csrfHeaders()}));
    const d=await r.json().catch(()=>({}));
    published=!!(r.ok&&d.published);
  }catch(_){ published=false; }

  if(!published){
    try{ if(win)win.close(); }catch(e){ console.warn('Could not close the share window',e); }
    // Names what did NOT happen, because the participant is about to decide
    // whether to try again — and a retry is safe: nothing was published.
    showToast('Could not publish your certificate page — nothing was shared. Please try again.','error');
    return;
  }
  // Guarded: the participant may have closed the placeholder while the POST was
  // in flight, and an exception here would escape as an unhandled rejection from
  // a delegated action nobody awaits.
  if(win){ try{ win.location.replace(badge.shareUrl); return; }catch(_){ /* fall through to a fresh window */ } }
  // The popup never opened at all (a blocker, or an embedded browser). The page
  // IS published now, so the share is still available — say so rather than
  // silently doing nothing.
  if(!window.open(badge.shareUrl,'_blank','noopener,noreferrer')){
    showToast('Your certificate page is published. Allow pop-ups, or use "Copy badge link" to share it.','success');
  }
}

/**
 * Operator ruling, 29 Oct 2026 — "Copy post & open LinkedIn" on a signed-in
 * certificate card: copies the holder's two-line post (ui/clipboard.js, with the
 * execCommand fallback for a plain-http venue LAN), opens LinkedIn's feed
 * composer, and publishes the certificate page exactly as Share does (the
 * holder's publish-on-share).
 *
 * The copy STARTS first, while this page still has focus, and the composer
 * opens in the same task as the click, before anything is awaited: the clipboard
 * answers in a later task, and `shareBadgeToLinkedIn` must open its window
 * synchronously (see there), which an await in front of it would undo. The
 * outcome of the copy is read once the window is open.
 */
export async function copyPostAndOpenLinkedIn(){
  const b=S._badgeShare;
  const post=b&&b.post;
  if(!post){ showToast('The post is not available. Use Share on LinkedIn instead.','error'); return; }
  const copying=copyText(post.text);
  const sharing=shareBadgeToLinkedIn({ ...b, shareUrl: post.composerUrl });
  const [copied]=await Promise.all([copying,sharing]);
  showToast(copied?'Post copied — paste it into LinkedIn.':'Could not copy the post automatically. Please try again.', copied?'success':'error');
}

export function copyBadgeLink(){
  const url=S._badgeShare&&S._badgeShare.badgeUrl;
  if(!url){ return; }
  // v8.11.1 (F7) — SAY SO WHEN THE LINK IS NOT LIVE YET.
  //
  // Since v8.6.2 an unshared page 404s, so "Badge link copied to clipboard."
  // reported success for a URL that answers nothing — and the holder finds out
  // by sending it to somebody. The copy still happens (it is the right link, and
  // it works the moment they press Share); only the sentence changes.
  //
  // Publishing ON COPY was considered and NOT taken: the dialog's own note three
  // lines above this button promises "Nothing is published until you press
  // Share", so making a copy publish would make that sentence false. Changing
  // which act publishes is a product decision and must not be made silently.
  const live=S._badgeShare&&S._badgeShare.published===true;
  const ok=live
    ? 'Badge link copied to clipboard.'
    : 'Link copied. It only opens once you press Share — that is what publishes the page.';
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(
      ()=>showToast(ok,'success'),
      ()=>showToast('Could not copy the link.','error'),
    );
  }else{
    showToast('Clipboard is not available in this browser.','error');
  }
}

/**
 * v8.1.0 (PR 29) — render the certificate CTA on the participant's Challenges
 * page, which for a Program is the ONLY place it can live: the Leaderboard tab
 * is inactive for a kind with no ranking, and the pre-existing CTA is on that
 * page. Before this a Program participant could earn a certificate and have no
 * route to it at all.
 *
 * Driven by GET /api/me/certificates, which computes `claimable` with the same
 * predicates the mint enforces — so the button never offers what the server will
 * refuse (v7.14.2: gate the affordance and its outcome together).
 */
export async function renderCertificateCta(){
  const el=document.getElementById('cert-cta');
  if(!el)return;
  let data;
  try{
    const r=await _origFetch('/api/me/certificates',{headers:{'accept':'application/json'}});
    if(!r.ok){_hideCta(el);return;}
    data=await r.json();
  }catch{ _hideCta(el); return; }

  const comp=S.currentCompetitionId;
  // Scoped to the competition the participant is actually looking at: a CTA for
  // some other event on this page would be noise, and the claim button posts to
  // one competition.
  const claim=(data.claimable||[]).find(c=>c.competitionId===comp);
  // v8.1.4 — BY ID, matching `claim` right above it. This matched on
  // `competitionName`, and `competitions.name` has no uniqueness constraint — so
  // a participant viewing one of two identically-named events (a recurring
  // programme) was shown the OTHER event's issue date and credential code under
  // this event's heading, and "View certificate" then POSTed the mint for the
  // event they were actually on and was correctly refused, contradicting the card
  // immediately above the button.
  const held=heldCertificateFor(data.certificates,comp);

  if(claim){
    setSafeHtml(el,`
      <div class="cert-cta-text">
        <p class="cert-cta-title">${ICO.medal||''} Your certificate is ready</p>
        <p class="cert-cta-sub">You have completed ${esc(claim.competitionName)}. Downloading is private &mdash; nothing is published unless you choose to share it.${
          // v8.6.0 — a late entrant whose window is still open takes a PARTICIPATION
          // certificate whatever their current rank, because their board is not
          // final yet. The mint is idempotent, so collecting now means KEEPING that
          // one — a cost the participant must be able to weigh before the click
          // rather than discover afterwards (v7.14.2).
          claim.latePlacementPending
            ? ' <strong>You are currently in the top three of the late entrants.</strong> That placement certificate is issued once late entries close; collecting now keeps this participation one instead.'
            : (claim.lateEntrant ? ' Your certificate will say &ldquo;late entrant&rdquo;.' : '')
        }</p>
      </div>
      <button type="button" class="btn" data-action="open-badge-share">Get my certificate</button>`);
    el._ctaHtml=null;
    el.hidden=false;
    return;
  }
  if(held){
    const html=`
      <div class="cert-cta-text">
        <p class="cert-cta-title">${ICO.medal||''} Your certificate</p>
        <p class="cert-cta-sub">${held.revoked?'This certificate has been revoked. Please contact the organisers.'
          :`Issued ${esc(held.dateLabel||'')}${held.code?` &middot; code ${esc(held.code)}`:''}.${held.lateEntrant?' Late entrant.':''}${held.withheld?' While you view as this participant, its code and downloads are hidden.':''}`}${held.revoked||!held.code?'':' <span data-help="cert.held" data-help-label="Certificate code"></span>'}</p>
      </div>
      ${held.revoked?'':'<button type="button" class="btn secondary" data-action="open-badge-share">View certificate</button>'}`;
    // The challenge list's poll calls this every tick: an unchanged card is left
    // as it is, so an open "?" note is not closed under the reader.
    if(el._ctaHtml!==html||el.hidden){ setSafeHtml(el,html); el._ctaHtml=html; }
    el.hidden=false;
    return;
  }
  _hideCta(el);
}

/**
 * The certificate this participant holds for one event, from the
 * GET /api/me/certificates list: an unrevoked one first, else a revoked one, so
 * a revoked certificate is shown as revoked rather than as nothing at all (a
 * revoked row carries no download links, and the mint refuses a replacement).
 * Matched by event ID, never by name. Shared by this page's card and the
 * Leaderboard's.
 */
export function heldCertificateFor(certificates,compId){
  if(!compId||!Array.isArray(certificates))return null;
  const mine=certificates.filter(c=>c&&c.competitionId===compId);
  return mine.find(c=>!c.revoked)||mine.find(c=>c.revoked)||null;
}

/**
 * The podium place a HELD certificate attests: 1-3 for a placement, 0 for one
 * that attests no placing, null when none is held or it was revoked. From its
 * `tier` (the server's certificateTier: the frozen basis first, the rank
 * second), never from the board's rank, so a late entrant's participation
 * certificate, which keeps its podium rank beside it, is no placing.
 */
export function heldCertificatePlace(held){
  if(!held||held.revoked)return null;
  return {gold:1,silver:2,bronze:3}[held.tier]||0;
}

// Hiding CLEARS, because this node is re-rendered per competition: leaving the
// previous event's issue date and credential code inside a hidden element means
// anything that later reveals it without re-rendering shows a certificate that
// belongs to a different event. The empty state is empty (v7.23.5).
function _hideCta(el){ if(!el)return; el.hidden=true; setSafeHtml(el,''); el._ctaHtml=null; }
