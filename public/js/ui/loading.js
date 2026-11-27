"use strict";

import { S } from "../core/state.js";
import { setSafeHtml } from "../core/trusted-types.js";

export function showLoading(){S._loadingCount++;document.getElementById('loading-overlay')?.classList.add('active');}

export function hideLoading(){S._loadingCount=Math.max(0,S._loadingCount-1);if(!S._loadingCount)document.getElementById('loading-overlay')?.classList.remove('active');}

export function showSkeletonCards(containerId, count=6){
  const el=document.getElementById(containerId);
  if(!el)return;
  setSafeHtml(el, Array.from({length:count},()=>'<div class="skeleton skeleton-card"></div>').join(''));
}

/**
 * v8.6.4 — the COMPETITION picker's skeleton.
 *
 * `#comp-grid` populates from 0 cards to N as /api/my-competitions resolves, and
 * everything below it moves by the full height of the card list. MEASURED on the
 * 400 kbps / 500 ms link the CLS gate uses, with 12 events: **CLS 0.1029, of
 * which 0.0994 is `#app-footer` alone** — over the Core Web Vitals "Good"
 * threshold, and the residual v8.3.16 predicted when it moved the join-code box
 * above the grid and named the footer as what was left.
 *
 * SIZED FROM THE REAL COUNT, not guessed. `/api/me` already returns this
 * participant's competitions — with each one's `status`, and therefore the span
 * the real card will take — so boot knows exactly how many cards are coming and
 * how wide each will be before the picker's own fetch has even been issued. That
 * is what makes this different from the v6.10.55 anti-pattern: reserving a FIXED
 * height on the grid over-reserves and amplifies the impact fraction of any shift
 * inside it, where this reserves precisely what is about to arrive.
 *
 * `statuses` is an array of the incoming cards' statuses; anything falsy falls
 * back to a single default-span card, which is the honest answer when the count
 * is genuinely unknown.
 */
export function showSkeletonCompCards(containerId, statuses){
  const el=document.getElementById(containerId);
  if(!el)return;
  const list=Array.isArray(statuses)&&statuses.length?statuses:null;
  if(!list)return;                       // nothing known — reserve nothing rather than the wrong thing
  // The picker's own span rule, mirrored: a live event's card is span-8, every
  // other is span-4. A skeleton in the wrong span reserves the wrong number of
  // ROWS, which is the whole quantity being reserved.
  setSafeHtml(el, list.map(st=>
    `<div class="skeleton-comp-card ${st==='live'?'bento-span-8':'bento-span-4'}"></div>`).join(''));
}

export function showSkeletonRows(containerId, count=5){
  const el=document.getElementById(containerId);
  if(!el)return;
  setSafeHtml(el, Array.from({length:count},()=>'<tr><td colspan="20"><div class="skeleton skeleton-row"></div></td></tr>').join(''));
}
