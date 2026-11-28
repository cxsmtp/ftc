"use strict";

import { S } from "../core/state.js";
import { fetchTransientRetry, readBody, isProfileIncomplete, _origFetch } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { ejectToCompetitionPicker } from "./participant-tasks.js";
import { avatarHtml, esc, fmtDt, solvedCell, _syncSortAria, earnsPlacement } from "../ui/format.js";
import { ICO, medalTinted } from "../ui/icons.js";
import { hideLoading, showLoading } from "../ui/loading.js";
import { heldCertificateFor, heldCertificatePlace } from "./badge-share.js";

// THE BOARD'S TIMES, said in words: "under 1 s" rather than "00s" (which read
// as a missing value), "0 m 03 s", "4 m 10 s", "1 h 02 m 33 s". A null — nobody
// has a clock yet — is a dash. The exports keep their own format (ui/format.js
// fmtSolveTime), which their readers parse.
export function lbSolveTime(ms){
  if(ms==null||!Number.isFinite(ms)||ms<0)return '—';
  if(ms<1000)return 'under 1 s';
  const s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor(s%3600/60),sec=s%60;
  const p=n=>String(n).padStart(2,'0');
  return h?`${h} h ${p(m)} m ${p(sec)} s`:`${m} m ${p(sec)} s`;
}

// v7.15.0 — client-side column sort for the PARTICIPANT board.
//
// FAIRNESS INVARIANT: this sorts ONLY the rows the server already sent (the
// top-20 cap, plus the viewer's own row which travels separately in `me`). It
// issues no request, asks for no extra rows, and derives no total. A participant
// still cannot learn who else is competing or how many — re-ordering 20 known
// rows reveals nothing that displaying them already didn't. Locked by
// functional-security "…does not leak total participant count anywhere in the
// payload" (which allow-lists the response keys, so no server field may be
// added) plus the UI tests that count rendered rows after sorting.
//
// `place` is the server's own ranking, so sorting by it ascending is exactly the
// default view; `S.lbSortCol === null` means "untouched" and renders server order.
const _LB_SORTERS = {
  place:  (a, b) => (a.rank ?? 0) - (b.rank ?? 0),
  player: (a, b) => String(a.nickname || a.name || '').localeCompare(String(b.nickname || b.name || ''), undefined, { sensitivity: 'base' }),
  // A board ranking by percentages (an overall board, per-session question sets)
  // carries `percent` on every row: its Score column is the percentage.
  score:  (a, b) => (a.percent ?? a.score ?? 0) - (b.percent ?? b.score ?? 0),
  // Unfinished entries have a null/undefined solveTimeMs; park them after every
  // real time in ascending order rather than letting them sort as 0 (fastest).
  time:   (a, b) => (a.solveTimeMs ?? Number.MAX_SAFE_INTEGER) - (b.solveTimeMs ?? Number.MAX_SAFE_INTEGER),
  solved: (a, b) => (a.allSolved ? 1 : 0) - (b.allSolved ? 1 : 0),
};

/** Sort a copy of `rows`; ties fall back to the server's ranking so the order is total + stable. */
export function _lbApplySort(rows, col, asc){
  const cmp = _LB_SORTERS[col];
  if (!cmp) return rows;
  return rows.slice().sort((a, b) => {
    const primary = cmp(a, b);
    if (primary !== 0) return asc ? primary : -primary;
    return (a.rank ?? 0) - (b.rank ?? 0);
  });
}

/** Header click / Enter / Space — toggles direction on the active column. */
export function sortLeaderboard(col){
  if (!_LB_SORTERS[col]) return;
  if (S.lbSortCol === col) S.lbSortAsc = !S.lbSortAsc;
  else { S.lbSortCol = col; S.lbSortAsc = true; }
  loadLeaderboard({ silent: true });
}

/**
 * Paint the ▲/▼ indicator + aria-sort for one of the leaderboard tables.
 * Scoped to the given thead on purpose: the admin tables clear indicators with a
 * global `[id^="sort-"][id$="-icon"]` sweep, so these ids deliberately use a
 * different prefix and this function must not use that global sweep either.
 */
// v7.15.2 (audit) — the Team Rankings sort rebuilds its whole <section>, so the
// <th> the user activated is destroyed and focus falls to <body>. Restore it
// after the rebuild. Set only by an explicit sort, so the 15s poll — which calls
// the same render path — never yanks focus out from under the user.
let _lbFocusAfterRender = null;
export function _lbPaintSortIcons(theadSel, idPrefix, col, asc){
  const thead = document.querySelector(theadSel);
  if (!thead) return;
  thead.querySelectorAll(`[id^="${idPrefix}"][id$="-icon"]`).forEach(el => { el.textContent = ''; });
  if (col) {
    const ic = document.getElementById(`${idPrefix}${col}-icon`);
    if (ic) { ic.textContent = asc ? ' ▲' : ' ▼'; _syncSortAria(ic, asc); }
  }
  if (_lbFocusAfterRender && _lbFocusAfterRender.prefix === idPrefix) {
    const th = document.getElementById(`${idPrefix}${_lbFocusAfterRender.col}-icon`)?.closest('th');
    _lbFocusAfterRender = null;
    if (th) th.focus();
  }
}

export const _lbLastScores = new Map();

export const _lbPrevRanks = new Map();

// v7.2.x (audit) — which competition the snapshots above belong to. Reset on a
// comp switch so the first render of a new board doesn't diff against the old
// competition's scores/ranks (spurious score-tick + rank-up animations).
let _lbSnapCompId = null;

export function _lbAnimateCountUp(el, from, to){
  if (from === to || from == null) { el.textContent = to; return; }
  const dur = 320;
  const start = performance.now();
  function tick(now){
    const t = Math.min(1, (now - start) / dur);
    // ease-out cubic — matches the --ease-out token's curvature shape.
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// v8.11.11 — the board had THREE states and rendered TWO of them identically.
// A transient 5xx, a 429, an abort after retries and a genuinely empty board all
// left `#lb-body` untouched — so on a first load the participant got an empty
// table with no heading row filled, no message and no toast, and no way to tell
// "nobody has scored yet" from "we could not reach the server". The three
// `return`s above are still correct about the BOARD (keeping a populated one
// beats blanking it on a blip), so this only paints when there is nothing to
// keep: `#lb-body` empty means this poll tick is the only thing the participant
// has. `loadTasks` has rendered exactly this shape since v7.15.14; the
// leaderboard is the surface a participant stares at for the whole event and
// was the one that never learnt it.
function _lbShowLoadError(){
  const body=document.getElementById('lb-body');
  if(!body||body.children.length)return;            // a real board is better than an error
  setSafeHtml(body,
    '<tr><td colspan="5"><div class="empty-state" role="status">'
    + '<p>Could not load the leaderboard — the connection to the server failed.</p>'
    + '<button class="btn" data-action="retry-load-leaderboard">Try again</button>'
    + '</div></td></tr>');
}

// THE HELD CERTIFICATE, per event, for the certificate card's download. Read
// from GET /api/me/certificates (the participant's own list; the route the
// tasks-page CTA reads) and re-read at most once a minute, so the poll does not
// ask every time. Until a re-read answers, the card keeps showing what was last
// read — an aged entry is stale, not absent, so the card never flips to "Get my
// certificate" for the length of a round trip. A read that fails keeps it too.
// And when nothing has been read for this event yet (its first paint, or after
// the dialog asked to forget), loadLeaderboard waits for the read before it draws
// the card (sweep #289), so a held certificate is never drawn as not held.
const _certCache = { compId: null, held: null, at: 0 };
const _CERT_REREAD_MS = 60_000;
function _certHeldFor(compId){
  return _certCache.compId === compId ? _certCache.held : null;
}
// What the card draws from a held certificate: a change in any of it repaints.
const _certSig = h => h ? JSON.stringify([h.revoked, h.pdfUrl, h.imageUrl, h.code, h.emailedAt, h.label, h.score, h.scoreLabel, h.dateLabel, h.name, h.withheld]) : '';
// One read of the participant's own list into the cache; true when it answered.
async function _readCertHeld(compId){
  try {
    const r = await _origFetch('/api/me/certificates', { headers: { 'accept': 'application/json' } });
    if (!r.ok) return false;
    const d = await r.json();
    _certCache.compId = compId; _certCache.held = heldCertificateFor(d.certificates, compId); _certCache.at = Date.now();
    return true;
  } catch (_) { return false; }
}
async function _refreshCertHeld(compId){
  if (!compId) return;
  if (_certCache.compId === compId && Date.now() - _certCache.at < _CERT_REREAD_MS) return;
  const before = _certSig(_certHeldFor(compId));
  if (!(await _readCertHeld(compId))) return;
  const held = _certHeldFor(compId);
  // The card shows something the re-read contradicts (a certificate found, lost
  // or revoked): paint it now rather than at the next poll — only while this
  // event's board is still on screen.
  if (_certSig(held) !== before && S.currentCompetitionId === compId
      && document.getElementById('leaderboard-page')?.classList.contains('active')
      && !document.getElementById('modal-overlay')?.classList.contains('open')) {
    loadLeaderboard({ silent: true });
  }
}
/** Forget the held certificate, so the next render asks again before it draws the card (after a mint). */
export function forgetCertHeld(){ _certCache.compId = null; _certCache.held = null; _certCache.at = 0; }
// The re-read the last card render started. It settles once the answer is in
// and the repaint, if the answer changed what the card draws, has been asked
// for: whoever must know what a re-read did awaits it (certRereadSettled).
let _certReread = Promise.resolve();
export function certRereadSettled(){ return _certReread; }
// THE CARD'S TIME FIGURE wraps, where its column is too narrow for it, only
// BETWEEN its parts ("8759 h" / "59 m 59 s"), never between a number and its
// unit: the space before each unit is a no-break space (styles.css .lb-cert-kpis).
const _keepUnits = s => String(s).replace(/ (?=[a-z])/g, '\u00a0');

export async function loadLeaderboard(opts){
  // audit v7.7.36 (P6) — only show the centre-screen spinner on the initial /
  // user-initiated load, not on the 15s poll tick. Pre-fix the spinner blinked
  // over the board every 15s for the whole event (worse on a slow venue network).
  const silent=opts&&opts.silent;
  if(!silent)showLoading();
  // ext-audit v7.15.13 — same as loadTasks: hideLoading in a finally so a thrown
  // fetch can't strand the overlay, retry transient failures, and never report a
  // network blip as lost competition access. This runs on a 15 s poll for the
  // whole event, so it is the most exposed of the three.
  const _gen=S._compGen;                            // ext-audit v7.15.14 — see S._compGen
  // Every load, polled or not, records the version it fetched against
  // (see _lbPollDue), so opening the page does not trigger a second fetch, and
  // how far the run had ended by then (_lbEndStage). A load that FAILS records
  // nothing (_lbLoadFailed), so the next tick tries again.
  S._lbVersionLoaded=S._lbVersionLatest;S._lbLoadedAt=Date.now();S._lbLoadedStage=_lbEndStage();
  let r;
  try { r=await fetchTransientRetry('/api/leaderboard'); } finally { if(!silent)hideLoading(); }
  if(_gen!==S._compGen) return;                     // switched events mid-flight
  if(!r){ _lbLoadFailed(); _lbShowLoadError(); return; }   // offline after retries — keep any board we have
  if(!r.ok){
    if(r.status===429||r.status>=500){ _lbLoadFailed(); _lbShowLoadError(); return; }  // transient — the next tick retries
      // v8.8.23 — NOT a lost membership. The interceptor above normally opens the
      // gate and retries, so this is only reached when it could not (an admin in
      // participant view, or a gate that failed open). Ejecting with "You are no
      // longer in this event." would be FALSE — the participant is enrolled, and
      // the picker behind that toast lists the very same event as live. Leave the
      // view alone; the gate or the admin branch owns the recovery.
    if(await isProfileIncomplete(r)){ _lbLoadFailed(); return; }
    // Stale competition context must not leave the leaderboard page showing an
    // empty or frozen board.
    await ejectToCompetitionPicker("You are no longer in this event.");
    return;
  }
  // v6.14.1 / v6.14.2 — board is server-capped to the top N (20).
  // `me` is computed by the server from the FULL ranked list, so it
  // carries the participant's true rank even when they're outside
  // the top N. `board_limit` is echoed so the UI can decide whether
  // to show the "your placement" banner without guessing. The total
  // ranked count is intentionally NOT exposed — competition fairness
  // requires participants not see how many people they're up against.
  // ext-audit v7.15.15 — parse under the same deadline, then re-check the
  // generation: the guard above ran at headers, and parsing is another await.
  const _lb=await readBody(r);
  if(_gen!==S._compGen)return;
  if(!_lb){ _lbLoadFailed(); _lbShowLoadError(); return; }
  const{top3,board,me,groupBoard,board_limit,ended,canShareBadge,lateEntrantMe,lateWindowOpen,lateDeadline,placementCertificates}=_lb;
  // PER-SESSION QUESTION SETS — which board this is, said above it: the
  // participant's own session's (an event ranking per session, or both), or the
  // one overall board (and that it ranks by percentages where it does).
  _paintBoardCaption(_lb);
  // v6.16.46 — populate the design-aligned page header. Subtitle:
  // "<Comp name> · Updates automatically" — the dot-separator shape of the
  // design's preview. It names no interval: the board is re-read when it moves
  // and at least once a minute (_lbPollDue), not on a fixed beat.
  // Once the event has ended the board is final: the title says so and the
  // sub line names the event only — no "Updates automatically" over a board
  // that will not change.
  const _lbSub = document.getElementById('lb-subtitle');
  if (_lbSub) _lbSub.textContent = ended ? (S.currentCompName || '') : `${S.currentCompName || ''} · Updates automatically`.replace(/^ · /, '');
  const _lbTitle = document.getElementById('lb-page-title');
  if (_lbTitle) _lbTitle.textContent = ended ? 'Final standings' : 'Live Rankings';
  // v7.1.1 — gate the LIVE pill on the real competition state. The earlier
  // assumption that a participant is always auto-popped off the leaderboard the
  // instant the competition ends is false: they can view an ENDED competition's
  // leaderboard (e.g. to use the top-3 share-badge CTA), where a green "Live"
  // mark is plainly wrong. `ended` comes from /api/leaderboard (v7.1.0).
  const _lbEye = document.getElementById('lb-eyebrow');
  if (_lbEye) _lbEye.textContent = ended ? 'Event ended' : 'Standings';
  const _lbLive = document.getElementById('lb-live-badge');
  if (_lbLive) _lbLive.style.display = ended ? 'none' : 'inline-flex';
  // v7.2.x (audit) — clear stale snapshots when the scoped competition changed,
  // before the score-tick / rank-up diffs below run against them.
  if (_lbSnapCompId !== S.currentCompetitionId) { _lbLastScores.clear(); _lbPrevRanks.clear(); _lbSnapCompId = S.currentCompetitionId; }
  const order=[top3[1],top3[0],top3[2]].filter(Boolean);
  const podiumClass=r=>r===1?'p1':r===2?'p2':'p3';
  const medal=r=>medalTinted(r);
  // THE PODIUM: 2-1-3, a struck metal medal over each name, the score in the
  // display face, and a base engraved I / II / III whose three heights are the
  // cue that does not depend on colour. `.podium-num` keeps the medal span and
  // its sr-only "1st place" (the rank-cue lock reads it); the numeral on the
  // disc is decoration. Solved count and time come from the same entries the
  // rows below use — nothing here says how many people are on the board.
  const roman=r=>r===1?'I':r===2?'II':'III';
  // The certificate each podium place earns, named on its card once the board
  // is final — the place IS the certificate's tier (lib/certificate-config.js
  // certificateTier), for a place with points above zero (`earnsPlacement`,
  // operator ruling, 14 Nov 2026): a place on zero or less shows its medal and
  // no certificate. The chip shows only when the server says the event issues
  // placement certificates (`placementCertificates` true), so a dry run, which
  // issues none, or a payload without the key names none (fail closed). While
  // the event runs the places can still move, so the chip waits for the end.
  const certTier=r=>r===1?'Gold':r===2?'Silver':'Bronze';
  setSafeHtml(document.getElementById('podium-row'), order.map(u=>`
    <div class="podium-slot ps${u.rank}${me&&u.userId===me.userId?' is-me':''}">
      <div class="podium-num m${u.rank}">${medal(u.rank)}<b class="podium-n" aria-hidden="true">${u.rank}</b></div>
      <div class="podium-who">${avatarHtml(u.avatar,28)}<span class="podium-name">${esc(u.nickname)}</span></div>
      <div class="podium-pts">${_lb.percent?`<span class="bignum">${esc(_pctText(u.percent))}</span> <span class="podium-pts-sub">${esc(String(u.score))} pts</span>`:`<span class="bignum">${esc(String(u.score))}</span> pts`}</div>
      <div class="podium-sub">${u.allSolved?'All solved':''}${u.allSolved&&u.solveTimeMs!=null?' · ':''}${u.solveTimeMs!=null?esc(lbSolveTime(u.solveTimeMs)):''}</div>
      ${ended&&placementCertificates===true&&earnsPlacement(u)?`<span class="podium-cert podium-cert-${u.rank}">${ICO.medal}${certTier(u.rank)}<span class="podium-cert-word"> certificate</span></span>`:''}
      <div class="podium-block ${podiumClass(u.rank)}" aria-hidden="true"><span class="podium-roman">${roman(u.rank)}</span></div>
    </div>`).join(''));
  const _pr=document.getElementById('podium-row');
  if(_pr)_pr.classList.toggle('podium-empty',!order.length);
  const rankIcon=r=>(r===1||r===2||r===3)?medalTinted(r,{showOrdinal:true}):`<strong>#${r}</strong>`;
  // v6.16.46 — score-tick: detect rows whose score went up since the
  // previous render and queue an animation. data-uid + data-score
  // anchor the lookup; the count-up + flash run AFTER the new HTML
  // is in the DOM.
  const _scoreIncreased = [];
  for (const u of board) {
    const prev = _lbLastScores.get(u.userId);
    if (prev != null && u.score > prev) _scoreIncreased.push({uid: u.userId, from: prev, to: u.score});
  }
  // v6.16.46 — FLIP step 1 (First). Capture each existing row's top
  // coordinate before we wipe the tbody. Map<userId, top-px>.
  // Rank-improvement detection: any user whose rank decreased
  // (smaller number) since the previous render goes into rankImproved.
  const oldTops = new Map();
  const rankImproved = new Set();
  for (const [uid] of _lbPrevRanks) {
    const tr = document.querySelector(`#lb-body tr[data-uid="${CSS.escape(uid)}"]`);
    if (tr) oldTops.set(uid, tr.getBoundingClientRect().top);
  }
  for (const u of board) {
    const prevRank = _lbPrevRanks.get(u.userId);
    if (prevRank != null && prevRank > u.rank) rankImproved.add(u.userId);
  }
  // v7.15.0 — apply the viewer's chosen column sort. Re-orders the rows already
  // in hand; `board` itself (what the server sent) is never mutated or extended.
  _lbPaintSortIcons('#leaderboard-page .lb-table thead', 'lbsort-', S.lbSortCol, S.lbSortAsc);
  const boardView = S.lbSortCol ? _lbApplySort(board, S.lbSortCol, S.lbSortAsc) : board;
  // THE TABLE STARTS BELOW THE PODIUM. In the board's own order the three cards
  // above already show places 1-3, so their rows are kept (every count and the
  // row-diffing below still see them) but [hidden]; a column sort is a
  // different question — "everyone, by time" — and shows them all. A board of
  // three or fewer is the podium alone, so it keeps its rows.
  const _onPodium=new Set(!S.lbSortCol&&order.length&&board.length>3?order.map(u=>u.userId):[]);
  setSafeHtml(document.getElementById('lb-body'), boardView.map(u=>{
    const meCls = me && u.userId === me.userId ? 'me' : '';
    // THE RANK-UP CUE: a row that climbed since the last poll says by how much,
    // for one poll (the next render forgets it). A small arrow and a figure,
    // with the words for a screen reader.
    const _prev=_lbPrevRanks.get(u.userId);
    const _up=(_prev!=null&&_prev>u.rank)?(_prev-u.rank):0;
    const delta=_up?`<span class="lb-delta"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 2 9 8H1z" fill="currentColor"/></svg>${_up}<span class="sr-only"> place${_up===1?'':'s'} up</span></span>`:'';
    return `
    <tr class="${meCls}" data-uid="${esc(u.userId)}" data-score="${u.score}"${_onPodium.has(u.userId)?' hidden':''}>
      <td><span class="lb-rank">${rankIcon(u.rank)}</span>${delta}</td>
      <td><div class="lb-who">${avatarHtml(u.avatar,28)} ${esc(u.nickname)}</div></td>
      ${_scoreCell(u,_lb.percent)}
      <td class="lb-time-cell">${lbSolveTime(u.solveTimeMs)}</td>
      ${solvedCell(u.allSolved)}
    </tr>`;
  }).join('')
    // A board with no entries is a real answer ("nobody has scored yet"), and it
    // must not look like the failure above. Rendered from the same write, so the
    // two states cannot both be on screen.
    || '<tr><td colspan="5"><div class="empty-state" role="status">'
       + '<p>No scores yet — the board fills up as people solve challenges.</p>'
       + '</div></td></tr>');
  // v6.16.46 — fire score-tick animations for rows that bumped score.
  // Reduced-motion preference disables both the count-up and the
  // flash; static text update only.
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const {uid, from, to} of _scoreIncreased) {
    const row = document.querySelector(`#lb-body tr[data-uid="${CSS.escape(uid)}"]`);
    if (!row) continue;
    const scoreEl = row.querySelector('.lb-score');
    if (scoreEl && !reducedMotion) _lbAnimateCountUp(scoreEl, from, to);
    if (!reducedMotion) {
      row.classList.add('score-tick');
      setTimeout(() => row.classList.remove('score-tick'), 800);
    }
  }
  // Update the snapshot for the next poll.
  _lbLastScores.clear();
  for (const u of board) _lbLastScores.set(u.userId, u.score);
  // v6.16.46 — FLIP steps 2-4 (Last, Invert, Play). For each row that
  // existed in the previous render at a different DOM position, set
  // transform to its old offset, then transition to translateY(0).
  // The browser paints the row at its old position on the next frame
  // and then animates back to the layout position over 360 ms. Rows
  // that gained rank also get .rank-up for the bg highlight.
  if (!reducedMotion) {
    // v6.20.x — two-pass FLIP to avoid layout thrash. Pre-fix this loop
    // interleaved a getBoundingClientRect() read, a transform write, and a
    // forced `void offsetHeight` reflow PER ROW — i.e. one full document
    // reflow per row (~20 on the capped board). Pass 1 does all the rect
    // reads + inverted-transform writes; a SINGLE forced reflow then commits
    // them; pass 2 enables the transitions. One reflow total instead of N.
    const _flip = [];
    for (const u of board) {
      const oldTop = oldTops.get(u.userId);
      if (oldTop == null) continue;   // new arrival — no slide
      const tr = document.querySelector(`#lb-body tr[data-uid="${CSS.escape(u.userId)}"]`);
      if (!tr) continue;
      const newTop = tr.getBoundingClientRect().top;   // READ
      const dy = oldTop - newTop;
      if (Math.abs(dy) < 1) {
        // Position unchanged (just a score update at the same rank).
        // Still apply the rank-up highlight if applicable.
        if (rankImproved.has(u.userId)) {
          tr.classList.add('rank-up');
          setTimeout(() => tr.classList.remove('rank-up'), 800);
        }
        continue;
      }
      // Invert: paint at old position immediately (no transition). WRITE only —
      // no per-row reflow here.
      tr.style.transition = 'none';
      tr.style.transform = `translateY(${dy}px)`;
      _flip.push({ uid: u.userId, tr });
    }
    // ONE forced reflow commits every inverted position at once.
    if (_flip.length) void document.getElementById('lb-body').offsetHeight;
    // Pass 2 — Play: transition each row back to its layout-natural position.
    for (const { uid, tr } of _flip) {
      tr.style.transition = 'transform 360ms var(--ease-spring)';
      tr.style.transform = 'translateY(0)';
      // Clear the inline styles after the animation so they don't
      // pollute future renders.
      setTimeout(() => {
        tr.style.transition = '';
        tr.style.transform = '';
      }, 400);
      if (rankImproved.has(uid)) {
        tr.classList.add('rank-up');
        setTimeout(() => tr.classList.remove('rank-up'), 800);
      }
    }
  }
  // Update the rank snapshot for the next poll.
  _lbPrevRanks.clear();
  for (const u of board) _lbPrevRanks.set(u.userId, u.rank);
  // "Your placement" banner — only visible when the participant exists
  // on the ranked list AND is below the cap (otherwise the highlighted
  // row in the table above already shows them). The banner mirrors the
  // table row layout so a participant at rank 50 sees a familiar shape.
  // No total-participants count is rendered (v6.14.2 — competition
  // fairness invariant: the server doesn't ship total_ranked, the UI
  // doesn't compute it from board.length either).
  const cap = typeof board_limit === 'number' ? board_limit : board.length;
  const meOutside = me && typeof me.rank === 'number' && me.rank > cap;
  if (meOutside) {
    setSafeHtml(document.getElementById('lb-me-banner'), `
      <div class="lb-me-card">
        <div class="lb-me-label">Your placement</div>
        <table class="lb-table"><tbody>
          <tr class="me">
            <td>${rankIcon(me.rank)}</td>
            <td><div class="lb-who">${avatarHtml(me.avatar,28)} ${esc(me.nickname)}</div></td>
            ${_scoreCell(me,_lb.percent,{plain:true})}
            <td class="lb-time-cell">${lbSolveTime(me.solveTimeMs)}</td>
            ${solvedCell(me.allSolved)}
          </tr>
        </tbody></table>
      </div>`);
  } else {
    setSafeHtml(document.getElementById('lb-me-banner'), '');
  }
  // v7.11.0 — team / group rankings (present only when the competition has groups).
  _renderParticipantOverallBoard(_lb.overallBoard);
  _renderParticipantGroupBoard(groupBoard);
  _renderParticipantLateBoard(_lb.lateBoard);
  // v7.1.0 / v7.6.x — LinkedIn share-badge CTA. The server's `canShareBadge`
  // flag is authoritative (comp fully ended + non-internal + eligible viewer);
  // the mint endpoint re-checks it. Top-3 get a placement badge; everyone else
  // who attempted gets a generic participation badge (no rank, no score).
  const _cta = document.getElementById('lb-badge-cta');
  if (_cta) {
    // v8.6.0 — a LATE ENTRANT is not on `me` (the main board excludes them), so
    // their row comes from the late board. Without this the CTA is withheld from
    // the one participant who is still playing.
    const _lateMe = (_lb.lateBoard && _lb.lateBoard.me) || null;
    const _ctaMe = me || _lateMe;
    const _lateOpenCta = !!(lateEntrantMe && lateWindowOpen);
    if (canShareBadge && _ctaMe && typeof _ctaMe.rank === 'number') {
      // NOTHING READ YET for this event (its first paint, or after the dialog
      // asked to forget): ask before painting, so a held certificate's card is
      // never drawn as "Get my certificate" for a round trip (sweep #289). A read
      // that fails leaves it unread, and the card is drawn as before.
      if (_certCache.compId !== S.currentCompetitionId) {
        // A card left from ANOTHER event (the cache is that event's) must not
        // stand beside this board while the read is out: hidden until it answers.
        // After the dialog (nothing cached) the card on screen is this event's.
        if (_certCache.compId !== null) {
          _cta.style.display = 'none';
          document.getElementById('leaderboard-page')?.classList.remove('lb-has-cert');
        }
        await _readCertHeld(S.currentCompetitionId);
        if (_gen !== S._compGen) return;   // switched events while it was read
      }
      // a11y: don't rebuild the CTA while a modal is open — the badge-share modal
      // captured the Share button as its focus-return target, and rebuilding here
      // (the 15s poll) would detach that node so Escape/Close lands focus at the
      // document top. The CTA is frozen on an ended comp, so skipping is safe.
      const _modalOpen = document.getElementById('modal-overlay')?.classList.contains('open');
      const _alreadyShown = _cta.style.display !== 'none' && _cta.querySelector('[data-action="open-badge-share"]');
      if (!(_modalOpen && _alreadyShown)) {
        // v8.6.0 — while a late entrant's window is OPEN their board is still
        // moving, so a placement is not knowable and the mint issues a
        // PARTICIPATION certificate whatever their current rank. The CTA must say
        // that rather than promise a placing the server will not give: the
        // affordance and its explanation move together (v7.14.2).
        // ONCE ONE IS HELD, the card says what THAT certificate attests: its tier
        // (the server's certificateTier, from the frozen basis), never the board's
        // rank. A late entrant's participation certificate keeps its podium rank
        // beside it and is still no placing.
        // Before one is held, the card names the certificate the mint will
        // issue: a placing only for the top three with points above zero
        // (`earnsPlacement`, the mint's own rule).
        const _heldPlace = heldCertificatePlace(_certHeldFor(S.currentCompetitionId));
        const _isTop3 = _heldPlace !== null ? _heldPlace > 0 : (!_lateOpenCta && earnsPlacement(_ctaMe));
        const _place = _heldPlace || _ctaMe.rank;
        const _compName = esc(S.currentCompName || 'this event');
        const _heading = _isTop3
          ? `<strong>You placed ${medalTinted(_place, { srLabel: false })} ${(_place === 1 ? '1st' : _place === 2 ? '2nd' : '3rd')} place${lateEntrantMe ? ' among the late entrants' : ''}.</strong>`
          : (lateEntrantMe
            ? `<strong>You took part in ${_compName} as a late entrant.</strong>`
            : `<strong>You took part in ${_compName}.</strong>`);
        // v7.15.0 — the button opens a preview from which you can BOTH share to
        // LinkedIn AND download the certificate (image or PDF). The old label
        // said only "Share on LinkedIn", so the download was undiscoverable —
        // people who wanted the certificate never opened the dialog.
        // v8.3.25 — a READ-ONLY impersonation session may generate and download
        // this certificate but never share it, so the entry point must not name
        // the one outcome its dialog withholds: the v7.14.2 rule that turned a
        // read-only "Edit Profile" kebab item into "View Profile", applied one
        // screen upstream of the dialog that carries the full explanation.
        const _roImp = !!(S.impersonation && !S.impersonation.superadmin);
        // Operator ruling, 23 Nov 2026 — viewing as the participant, an admin who
        // may not look certificates up by code sees no code and no download: the
        // server withholds them (`withheld`), and this says so before the dialog.
        const _codesHidden = !!(S.impersonation && S.impersonation.certificate_codes === false);
        const _sub = _codesHidden
          ? `<span>Generate this certificate for them. Its code and downloads are hidden while you view as this participant; organisers can download it from the event's Certificates section.</span>`
          : _roImp
          ? `<span>Generate or download this certificate. Sharing to LinkedIn is not available in a read-only impersonation session.</span>`
          : (_lateOpenCta
            // STATED BEFORE THE CLICK, because the mint is idempotent per
            // (participant, event): collecting now means keeping the participation
            // certificate, and a placement one afterwards needs an organiser to
            // revoke the first. A cost the participant cannot see is one they
            // cannot weigh.
            ? `<span>Your certificate says &ldquo;late entrant&rdquo;. Late entries close ${esc(lateDeadline ? fmtDt(new Date(lateDeadline), 'long') : 'soon')} — if you place in the top three with a score above zero, that certificate is issued after then. Collecting now keeps this participation one.</span>`
            : (_isTop3
              ? `<span>Share your certificate for ${_compName} on LinkedIn, or download it as an image or PDF.</span>`
              : `<span>Share your participation certificate on LinkedIn, or download it as an image or PDF.</span>`));
        // THE CERTIFICATE CARD. A rendition of the certificate (the brand
        // object: night stage, double gold frame, diamond rule), the line that
        // says why, and the actions. ONE `open-badge-share` control, always —
        // it mints when nothing is held yet and opens the dialog that shares to
        // LinkedIn; once a certificate is HELD the card's gold action becomes
        // the participant's own PDF, straight from GET /api/me/certificates.
        const _held = _certHeldFor(S.currentCompetitionId);
        // A REVOKED certificate is not one to collect, share or download: the
        // mint refuses it, so the card says so and offers nothing — no rendition
        // of it, no line about sharing and no button (the tasks page's card,
        // badge-share.js renderCertificateCta, withholds its button the same way).
        const _revoked = !!(_held && _held.revoked);
        const _ord = _isTop3 ? (_ctaMe.rank === 1 ? '1st' : _ctaMe.rank === 2 ? '2nd' : '3rd') : '';
        // The name the certificate prints, by the server's rule (lib/badge.js
        // `certificatePrintedName`): a held one's own, else the account's
        // `certificate_printed_name`. Never composed here: the certificate puts
        // a Chinese, Japanese or Korean family name first and prints the
        // nickname for a name its fonts cannot draw.
        const _cu = S.currentUser || {};
        const _who = (_held && _held.name) || _cu.certificate_printed_name || _cu.nickname || '';
        // A BOARD RANKED BY PERCENTAGES (owner decision, 28 Nov 2026: "just show
        // level"): before a certificate is held the card names only the level
        // the mint would issue ("1st Place — Overall", "Participant"), with no
        // score figure at all: neither the live points, which the board did not
        // rank on, nor a percentage. Once one is held the card shows what that
        // certificate holds (its frozen scoreLabel). A points board is unchanged.
        const _levelOnly = !_held && _lb.percent === true;
        const _levelWords = _isTop3 ? `${_ord} Place${_lb.ranking === 'overall' ? ' — Overall' : ''}` : 'Participant';
        const _thumb = `<div class="lb-cert-thumb${_isTop3 ? ` is-p${_place}` : ''}" data-look="signature" data-theme="dark" aria-hidden="true">
            <span class="lb-cert-t">${_held && _held.label ? esc(_held.label) : _levelOnly ? esc(_levelWords) : (_isTop3 ? `Certificate of achievement · ${_ord} place` : 'Certificate of participation')}</span>
            <span class="lb-cert-rule"><i></i></span>
            <span class="lb-cert-n">${esc(_who)}</span>
            <span class="lb-cert-e">${_compName}</span>
            ${_levelOnly ? '' : `<span class="lb-cert-g">${_held && _held.scoreLabel ? esc(_held.scoreLabel) : `${esc(String(_held && _held.score != null ? _held.score : _ctaMe.score))} pts`}${_held && _held.dateLabel ? ` · ${esc(_held.dateLabel)}` : ''}</span>`}
            <span class="lb-cert-med"></span>
          </div>`;
        const _shareLabel = _codesHidden ? (_held ? 'View certificate' : 'Generate certificate')
          : _roImp ? (_held ? 'View certificate' : 'Generate or download certificate')
          : (_held ? 'Share on LinkedIn' : 'Get my certificate');
        const _main = (_held && !_held.revoked && _held.pdfUrl)
          ? `<a class="btn gold lg block lb-cert-dl" href="${esc(_held.pdfUrl)}" download>${ICO.download} Download certificate</a>
             <div class="lb-cert-row">
               <button class="btn secondary lb-cert-share" data-action="open-badge-share">${_shareLabel}</button>
               ${_held.imageUrl ? `<a class="btn secondary lb-cert-png" href="${esc(_held.imageUrl)}?dl=1" download="hack-arena-certificate.png">Image (PNG)</a>` : ''}
             </div>`
          : `<button class="btn gold lg block" data-action="open-badge-share">${ICO.medal} ${_shareLabel}</button>`;
        setSafeHtml(_cta, `
          <div class="lb-badge-cta-inner lb-cert">
            <p class="eyebrow gold">Your certificate</p>
            <div class="lb-badge-cta-text">
              ${_heading}
              ${_revoked ? '' : _sub}
            </div>
            ${_revoked ? '' : _thumb}
            ${_revoked ? '' : _main}
            ${_held ? `<p class="lb-cert-meta">${_held.revoked ? 'This certificate has been revoked. Please contact the organisers.'
              : [_held.code ? `Code <span class="lb-cert-code">${esc(_held.code)}</span>` : '',
                 _held.withheld ? 'Its code and downloads are hidden while you view as this participant' : '',
                 _held.emailedAt ? `Emailed to you on ${esc(fmtDt(new Date(_held.emailedAt), 'short'))}` : ''].filter(Boolean).join(' · ')}</p>` : ''}
            <div class="lb-cert-kpis">
              ${(!_lateOpenCta && !lateEntrantMe) ? `<div><span class="eyebrow">Rank</span><b class="bignum">${esc(String(_ctaMe.rank))}</b></div>` : ''}
              ${_levelOnly ? '' : `<div><span class="eyebrow">Points</span><b class="bignum">${esc(String(_ctaMe.score))}</b></div>`}
              ${_ctaMe.solveTimeMs != null ? `<div><span class="eyebrow">Time</span><b class="bignum">${esc(_keepUnits(lbSolveTime(_ctaMe.solveTimeMs)))}</b></div>` : ''}
            </div>
          </div>`);
        _certReread = _refreshCertHeld(S.currentCompetitionId);
        _cta.style.display = '';
      }
    } else {
      setSafeHtml(_cta, '');
      _cta.style.display = 'none';
    }
    document.getElementById('leaderboard-page')?.classList.toggle('lb-has-cert', _cta.style.display !== 'none');
  }
}

// PER-SESSION QUESTION SETS (owner decision, 27 Nov 2026) — the score cell of
// a row: points, or on a board ranking by percentages the percentage first with
// the points beside it. `.lb-score` stays the POINTS figure (the score-tick
// count-up reads it), so on a percentage board the count-up moves the small one.
function _pctText(p){return typeof p==='number'&&Number.isFinite(p)?`${p.toFixed(1).replace(/\.0$/,'')}%`:'—';}
function _scoreCell(u,percent,{plain=false}={}){
  if(!percent)return plain?`<td><strong>${u.score}</strong> pts</td>`:`<td><strong class="lb-score">${u.score}</strong> pts</td>`;
  return `<td><strong class="lb-pct">${esc(_pctText(u.percent))}</strong> <span class="lb-pts-sub">${plain?'':'<span class="lb-score">'}${u.score}${plain?'':'</span>'} pts</span></td>`;
}
// The line above the board naming it: "Session B" where the event ranks per
// session (and the overall board then follows below), "Overall" where its one
// board ranks everyone; and how the overall board ranks.
function _paintBoardCaption(lb){
  const el=document.getElementById('lb-board-caption');
  if(!el)return;
  let text='';
  if(lb.ranking==='both'||lb.ranking==='per_session'){
    if(lb.sessionName)text=`Your session: ${lb.sessionName}${lb.ranking==='both'?'. The overall board, with every session, is below.':''}`;
  }else if(lb.ranking==='overall'){
    text=lb.percent?'Overall: everyone, every session, ranked by the percentage of their own session’s points; time breaks a tie.':'Overall: everyone, every session, on one board.';
  }
  el.textContent=text;
  el.hidden=!text;
}
// The OVERALL board beside the session's (an event ranking per session AND
// overall): the main board's viewing rules (capped, the viewer's own place
// resolved before the cap, no count), a card like the late board's. Renders
// nothing without one.
function _renderParticipantOverallBoard(ob){
  const section=document.getElementById('lb-overall-section');
  if(!section)return;
  if(!ob||!Array.isArray(ob.board)||!ob.board.length){
    setSafeHtml(section, ''); section.style.display='none'; return;
  }
  const rankIcon=r=>(r===1||r===2||r===3)?medalTinted(r,{showOrdinal:true}):`<strong>#${r}</strong>`;
  const meId=ob.me&&ob.me.userId;
  const rowFor=e=>`<tr class="${e.userId===meId?'me':''}">
      <td>${rankIcon(e.rank)}</td>
      <td><div class="lb-who">${avatarHtml(e.avatar,28)} ${esc(e.nickname)}</div></td>
      ${_scoreCell(e,ob.percent,{plain:true})}
      <td class="lb-time-cell">${lbSolveTime(e.solveTimeMs)}</td>
      ${solvedCell(e.allSolved)}
    </tr>`;
  const view=S.lbOverallSortCol?_lbApplySort(ob.board,S.lbOverallSortCol,S.lbOverallSortAsc):ob.board;
  const cap=typeof ob.board_limit==='number'?ob.board_limit:ob.board.length;
  const meOutside=ob.me&&typeof ob.me.rank==='number'&&ob.me.rank>cap;
  const meRow=meOutside?`<div class="lb-me-card" style="margin-top:12px"><div class="lb-me-label">Your overall placement</div><table class="lb-table"><tbody>${rowFor(ob.me)}</tbody></table></div>`:'';
  setSafeHtml(section, `<div class="card">
    <h3 class="lb-group-title">Overall</h3>
    <p class="lb-group-hint">${ob.percent
      ?'Everyone, from every session, ranked by the percentage of their own session’s points, so sessions with different questions compare fairly. Time breaks a tie.'
      :'Everyone, from every session, ranked by points. Time breaks a tie.'}</p>
    <table class="lb-table">
      <thead><tr>
        <th scope="col" class="sortable" data-action="sort-leaderboard-overall" data-col="place">#<span id="lbosort-place-icon"></span></th>
        <th scope="col" class="sortable" data-action="sort-leaderboard-overall" data-col="player">Player<span id="lbosort-player-icon"></span></th>
        <th scope="col" class="sortable" data-action="sort-leaderboard-overall" data-col="score">${ob.percent?'Score (%)':'Score'}<span id="lbosort-score-icon"></span></th>
        <th scope="col" class="sortable" data-action="sort-leaderboard-overall" data-col="time">Time to Solve<span id="lbosort-time-icon"></span></th>
        <th scope="col" class="sortable lb-solved-col" data-action="sort-leaderboard-overall" data-col="solved">All Solved<span id="lbosort-solved-icon"></span></th>
      </tr></thead>
      <tbody>${view.map(rowFor).join('')}</tbody>
    </table>
  </div>${meRow}`);
  section.style.display='';
  _lbPaintSortIcons('#lb-overall-section .lb-table thead','lbosort-',S.lbOverallSortCol,S.lbOverallSortAsc);
}

/** Overall-board header click — mirrors sortLeaderboard for the overall table. */
export function sortLeaderboardOverall(col){
  if(S.lbOverallSortCol===col)S.lbOverallSortAsc=!S.lbOverallSortAsc;
  else{S.lbOverallSortCol=col;S.lbOverallSortAsc=(col==='place'||col==='time');}
  loadLeaderboard();
}

// v8.6.0 — the LATE-ENTRANT section.
//
// The people who joined after the event had ended, ranked among themselves by the
// same rules — the SERVER shares the comparator, so this renderer only has to
// present what it is given. Its own sort state (`S.lbLateSortCol`) and its own icon
// prefix (`lblsort-`), because `renderParticipants()` clears sort indicators with a
// global `[id^="sort-"][id$="-icon"]` sweep and every board on this page has had to
// pick a distinct prefix for that reason.
//
// Renders NOTHING when there is no late board — an empty section headed "Late
// entrants" is a question an organiser then has to answer. The section is a card
// like Team Rankings rather than a dimmed variant of the main table: never dim a
// text-bearing surface with `opacity`, which is an alpha composite and drags the
// text down with the chrome (measured at 2.25:1 for `--muted` at .5).
function _renderParticipantLateBoard(lateBoard){
  const section=document.getElementById('lb-late-section');
  if(!section)return;
  if(!lateBoard||!Array.isArray(lateBoard.board)||!lateBoard.board.length){
    setSafeHtml(section, ''); section.style.display='none'; return;
  }
  const rankIcon=r=>(r===1||r===2||r===3)?medalTinted(r,{showOrdinal:true}):`<strong>#${r}</strong>`;
  const rowFor=e=>`<tr class="${e.mine?'me':''}">
      <td>${rankIcon(e.rank)}</td>
      <td><div class="lb-who">${avatarHtml(e.avatar,28)} ${esc(e.nickname)}</div></td>
      <td><strong>${e.score}</strong> pts</td>
      <td class="lb-time-cell">${lbSolveTime(e.solveTimeMs)}</td>
      ${solvedCell(e.allSolved)}
    </tr>`;
  const view=S.lbLateSortCol?_lbApplySort(lateBoard.board,S.lbLateSortCol,S.lbLateSortAsc):lateBoard.board;
  const cap=typeof lateBoard.board_limit==='number'?lateBoard.board_limit:lateBoard.board.length;
  // `me` resolved BEFORE truncation on the server, so an out-of-cap late entrant
  // still sees their true rank without learning the size of the field — the same
  // fairness rule the main board follows.
  const meOutside=lateBoard.me&&typeof lateBoard.me.rank==='number'&&lateBoard.me.rank>cap;
  const meRow=meOutside?`<div class="lb-me-card" style="margin-top:12px"><div class="lb-me-label">Your placement</div><table class="lb-table"><tbody>${rowFor({...lateBoard.me,mine:true})}</tbody></table></div>`:'';
  setSafeHtml(section, `<div class="card">
    <h3 class="lb-group-title">Late entrants</h3>
    <p class="lb-group-hint">People who joined after the event had ended, during its late-entry window. Ranked among themselves by the same rules as the main leaderboard.</p>
    <table class="lb-table">
      <thead><tr>
        <th scope="col" class="sortable" data-action="sort-leaderboard-late" data-col="place">#<span id="lblsort-place-icon"></span></th>
        <th scope="col" class="sortable" data-action="sort-leaderboard-late" data-col="player">Player<span id="lblsort-player-icon"></span></th>
        <th scope="col" class="sortable" data-action="sort-leaderboard-late" data-col="score">Score<span id="lblsort-score-icon"></span></th>
        <th scope="col" class="sortable" data-action="sort-leaderboard-late" data-col="time">Time to Solve<span id="lblsort-time-icon"></span></th>
        <th scope="col" class="sortable lb-solved-col" data-action="sort-leaderboard-late" data-col="solved">All Solved<span id="lblsort-solved-icon"></span></th>
      </tr></thead>
      <tbody>${view.map(rowFor).join('')}</tbody>
    </table>
  </div>${meRow}`);
  section.style.display='';
  _lbPaintSortIcons('#lb-late-section .lb-table thead','lblsort-',S.lbLateSortCol,S.lbLateSortAsc);
}

/** Late-board header click — mirrors sortLeaderboard for the late table. */
export function sortLeaderboardLate(col){
  if(S.lbLateSortCol===col)S.lbLateSortAsc=!S.lbLateSortAsc;
  else{S.lbLateSortCol=col;S.lbLateSortAsc=(col==='place'||col==='time');}
  loadLeaderboard();
}

// v7.11.0 — participant-facing team/group board. A static table (no FLIP/score-tick
// animations — those are for the primary individual board): GROUP aggregates (avg
// score + avg time-to-solve, member count) mixed with SOLO individuals. The
// viewer's own team / solo row(s) are highlighted (`.me`), and an out-of-cap team
// gets a "your team's placement" mini-row, mirroring the individual board.
function _renderParticipantGroupBoard(groupBoard){
  const section=document.getElementById('lb-group-section');
  if(!section)return;
  if(!groupBoard||!Array.isArray(groupBoard.board)||!groupBoard.board.length){
    setSafeHtml(section, ''); section.style.display='none'; return;
  }
  const rankIcon=r=>(r===1||r===2||r===3)?medalTinted(r,{showOrdinal:true}):`<strong>#${r}</strong>`;
  const rowFor=e=>{
    const isGroup=e.type==='group';
    // Participant board omits member count (fairness — see routes/leaderboard.js).
    const label=isGroup
      ?`<div class="lb-who"><span class="group-board-icon">${ICO.users}</span> <strong>${esc(e.name)}</strong> <span class="group-board-meta">team</span></div>`
      :`<div class="lb-who">${avatarHtml(e.avatar,28)} ${esc(e.nickname)} <span class="group-board-meta">individual</span></div>`;
    return `<tr class="${e.mine?'me':''}">
      <td>${rankIcon(e.rank)}</td>
      <td>${label}</td>
      <td><strong>${isGroup?e.score.toFixed(1):e.score}</strong> pts</td>
      <td class="lb-time-cell">${lbSolveTime(e.solveTimeMs)}</td>
      ${solvedCell(e.allSolved)}
    </tr>`;
  };
  // Same client-side, already-visible-rows-only sort as the individual board,
  // with its own state so the two tables sort independently.
  const groupView=S.lbGroupSortCol?_lbApplySort(groupBoard.board,S.lbGroupSortCol,S.lbGroupSortAsc):groupBoard.board;
  const cap=typeof groupBoard.board_limit==='number'?groupBoard.board_limit:groupBoard.board.length;
  const meOutside=groupBoard.me&&typeof groupBoard.me.rank==='number'&&groupBoard.me.rank>cap;
  const meRow=meOutside?`<div class="lb-me-card" style="margin-top:12px"><div class="lb-me-label">Your team's placement</div><table class="lb-table"><tbody>${rowFor({...groupBoard.me,mine:true})}</tbody></table></div>`:'';
  setSafeHtml(section, `<div class="card">
    <h3 class="lb-group-title">Team Rankings</h3>
    <p class="lb-group-hint">Groups are ranked by their members' average score, then average time-to-solve. People entered on their own also appear individually.</p>
    <table class="lb-table">
      <thead><tr>
        <th scope="col" class="sortable" data-action="sort-leaderboard-group" data-col="place">#<span id="lbgsort-place-icon"></span></th>
        <th scope="col" class="sortable" data-action="sort-leaderboard-group" data-col="player">Group / Player<span id="lbgsort-player-icon"></span></th>
        <th scope="col" class="sortable" data-action="sort-leaderboard-group" data-col="score">Avg Score<span id="lbgsort-score-icon"></span></th>
        <th scope="col" class="sortable" data-action="sort-leaderboard-group" data-col="time">Avg Time to Solve<span id="lbgsort-time-icon"></span></th>
        <th scope="col" class="sortable lb-solved-col" data-action="sort-leaderboard-group" data-col="solved">All Solved<span id="lbgsort-solved-icon"></span></th>
      </tr></thead>
      <tbody>${groupView.map(rowFor).join('')}</tbody>
    </table>
  </div>${meRow}`);
  section.style.display='';
  // Painted after the table exists (this thead is built here, not in index.html).
  _lbPaintSortIcons('#lb-group-section .lb-table thead','lbgsort-',S.lbGroupSortCol,S.lbGroupSortAsc);
}

/** Team-board header click — mirrors sortLeaderboard for the group table. */
export function sortLeaderboardGroup(col){
  if(S.lbGroupSortCol===col)S.lbGroupSortAsc=!S.lbGroupSortAsc;
  else{S.lbGroupSortCol=col;S.lbGroupSortAsc=true;}
  _lbFocusAfterRender={prefix:'lbgsort-',col};
  loadLeaderboard({silent:true});
}

// THE BOARD IS RE-FETCHED ONLY WHEN IT MOVED. The pulse
// (participant-tasks.js _pulseTick, GET /api/participant/pulse) carries the
// board's version and paints the score pill, so this poll no longer asks
// /api/me and no longer fetches an unchanged board every 15 s. It fetches when
// the version differs from the one it last loaded, when no pulse has answered yet
// (an unknown version is treated as changed), once each time the run has ended
// further since the board on screen was loaded (_lbEndStage: an end on the clock
// bumps no version, and the board must turn final rather than keep saying "Live
// Rankings" until the floor), and at least every LB_FLOOR_MS regardless: the
// board also moves with time (unfinished solve clocks, presence, a session
// ending), none of which bump the version.
export const LB_FLOOR_MS=60000;
// How far over the participant's run is, as this tab knows it: 0 running, 1 their
// own session over while later sessions still run (handleCompetitionEnded's
// waiting state), 2 the whole event over — the board's "Final standings".
function _lbEndStage(){
  if(!S.hackathonEnded)return 0;
  return (S._currentTimeslots.length>0&&!S._competitionFullyEnded)?1:2;
}
export function _lbPollDue(nowMs){
  if(_lbEndStage()>(S._lbLoadedStage||0))return true;
  const v=S._lbVersionLatest;
  if(typeof v!=='string')return true;
  if(v!==S._lbVersionLoaded)return true;
  return (nowMs-(S._lbLoadedAt||0))>=LB_FLOOR_MS;
}
// A load that failed fetched nothing, so it must not count as loaded: without
// this the version it asked about read as shown, and the next fetch waited for
// the version to move again or for the one-minute floor.
function _lbLoadFailed(){
  S._lbVersionLoaded=undefined;S._lbLoadedAt=0;S._lbLoadedStage=0;
}
// One tick of the board poll: only on the board page, only when due.
export function _lbPollTick(){
  if(!document.getElementById('leaderboard-page').classList.contains('active'))return;
  if(!_lbPollDue(Date.now()))return;
  loadLeaderboard({silent:true}); // audit v7.7.36 (P6) — no spinner on poll ticks
}
export function startLeaderboardPoll(){
  if(S.lbInterval)clearInterval(S.lbInterval);
  S.lbInterval=S._pollsHalted?null:setInterval(_lbPollTick,15000);
}
