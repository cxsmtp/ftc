"use strict";
//
// v7.17.1 — the list chrome, extracted rather than invented.
//
// Six surfaces render a pagination bar, and they render the SAME bar: First /
// Prev / "Page X of Y (N total)" / Next / Last / a page-size select. Six copies
// of that template, and thirty near-identical `registerAction` calls in
// core/main.js to drive them. Nothing here is new behaviour — it is the shape
// those six already agree on, in one place, so that a surface which currently
// has NO controls (the Groups table, the unsubscribe list, the import picker)
// can be given real ones in a few lines instead of sixty.
//
// TWO DESIGN CONSTRAINTS, both forced by existing code rather than chosen:
//
// 1. THE ACTION NAMES STAY PER-SURFACE. `paginationHtml("comps", …)` emits
//    `data-action="comps-page-next"`, not a generic `list-page` with a
//    `data-list-id`. The generic scheme would save perhaps twenty more lines
//    and break real assertions — ui-participant.spec.js locates
//    `button[data-action='logs-page-next']` by name, and ui-admin.spec.js does
//    `selectOption` on `select[data-change-action='tasks-page-size']`. A
//    refactor that forces unrelated tests to change is a refactor that hides
//    whether it changed behaviour.
//
// 2. THE CHROME MOUNTS ONCE, AS A SIBLING OF THE ROW CONTAINER — never inside
//    it. That is not a style preference: it is why the polled surfaces do not
//    lose the operator's search term today. `#comp-search` and
//    `#comp-pagination` are static markup next to the `<tbody>`, so
//    `setSafeHtml(tbody, …)` on a 15-second poll never touches the input, and
//    its value, caret and focus survive for free. A helper that rendered search
//    and rows into one container would REGRESS three surfaces that are
//    currently correct.
import { esc } from "./format.js";
import { setSafeHtml } from "../core/trusted-types.js";

/** The page-size options a surface offers. Kept here so the six agree. */
export const DEFAULT_PAGE_SIZES = [30, 50, 100, 200];

/**
 * The pagination bar. Returns markup; the caller decides where it goes (and
 * must put it in a container that is NOT the one holding the rows — see 2).
 *
 *   id          — surface prefix, e.g. "comps" → data-action="comps-page-next"
 *   page        — 1-based current page
 *   totalPages  — clamped by the caller, minimum 1
 *   totalLabel  — free text for the count, e.g. "412 total" or "200+ total";
 *                 free text because Logs reports an approximate total and
 *                 renders "N+", which a plain number could not express
 *   pageSize / sizes — current size and the options to offer
 */
export function paginationHtml(id, {
  page, totalPages, totalLabel, pageSize, sizes = DEFAULT_PAGE_SIZES, extra = "",
  // Logs cannot derive its edges from page/totalPages: its `total` is
  // approximate (a reverse walk over rotated files with a scan budget), so it
  // renders "N+" and tracks hasPrev/hasNext itself. Overrides rather than a
  // second function — the bar is otherwise identical, and forking it would put
  // us back where this started.
  hasPrev = null, hasNext = null,
  // Pages are rendered as-is, so a surface with an approximate total can pass
  // "12+" for totalPages.
  pagesLabel = null,
  // v7.25.0 — Last is not always the same question as Next. Logs enables Next
  // whenever more rows may exist, but can only offer Last when it knows the
  // real total; without this override the bar would promise a last page it
  // cannot compute.
  lastEnabled = null,
  // v7.25.0 — ±10 page jumps, OPT-IN. Emitting them unconditionally would
  // silently change the bar on five other surfaces in a patch that is about
  // one, and `list-controls.spec.js` uses `toContain`, so it would stay green
  // and the change would ship unnoticed.
  jump10 = false,
} = {}) {

  const first = hasPrev === null ? page <= 1 : !hasPrev;
  const last = hasNext === null ? page >= totalPages : !hasNext;
  const lastOff = lastEnabled === null ? last : !lastEnabled;
  return `
    <button data-action="${esc(id)}-page-first" ${first ? "disabled" : ""}>First</button>
    ${jump10 ? `<button data-action="${esc(id)}-page-back10" ${first ? "disabled" : ""} aria-label="Back 10 pages">&minus;10</button>` : ""}
    <button data-action="${esc(id)}-page-prev" ${first ? "disabled" : ""}>Prev</button>
    <span class="page-info">Page ${esc(String(page))} of ${esc(String(pagesLabel ?? totalPages))} (${esc(String(totalLabel))})</span>
    ${extra}
    <button data-action="${esc(id)}-page-next" ${last ? "disabled" : ""}>Next</button>
    ${jump10 ? `<button data-action="${esc(id)}-page-fwd10" ${last ? "disabled" : ""} aria-label="Forward 10 pages">+10</button>` : ""}
    <button data-action="${esc(id)}-page-last" data-total-pages="${esc(String(totalPages))}" ${lastOff ? "disabled" : ""}>Last</button>
    <select data-change-action="${esc(id)}-page-size" aria-label="Results per page">
      ${sizes.map(n => `<option value="${Number(n)}" ${pageSize === n ? "selected" : ""}>${Number(n)} / page</option>`).join("")}
    </select>`;
}

// ── THE SEGMENT PAGER ─────────────────────────────────────────────────────────
// ONE definition of how a list pages like the audit trail: the Audit page
// (features/audit-admin.js) and Raw logs (features/settings-admin.js; operator
// ruling, 17 Nov 2026, "Page like the trail"). Each surface keeps its own state
// object of this shape and its own requests; the rules are these functions.
//
// Page 1 is read from the top: it is the read the server counts, and it answers
// `anchor`, its newest row. The list is held as SEGMENTS, each the page it starts
// at and the position it is read from: the anchor (page 1 on), then a `cursor`
// for each page Next reached (the rows below the last row of the page before, or
// below how far a cut walk searched, so Next searches on past it). Page P is its
// segment's position plus `offset` (P - start) x size: one read for Prev, -10,
// +10, Last or Go to page, and `offset` never passes the server's `offset_max`.
// Last and Go to page need an exact count. A list whose server answers a count on
// every read and no cursor (Raw logs' Request log) pages by anchor and offset.
export function newSegmentPager(pageSize, offsetMax = 10000) {
  return { page: 1, pageSize, total: null, totalExact: false, anchor: null, segments: [],
    nextCursor: null, hasMore: false, searchedTo: null, cutAt: null, offsetMax };
}

/** The position params of page `P` (`{}` for page 1), or null when no segment reaches it. */
export function segmentParams(st, P) {
  if (P <= 1) return {};
  let seg = null;
  for (const sg of st.segments) if (sg.start <= P) seg = sg;
  if (!seg) return null;
  const off = (P - seg.start) * st.pageSize;
  if (off > st.offsetMax) return null;
  return off ? { ...seg.base, offset: String(off) } : { ...seg.base };
}

/** Pages in the count, null when there is no count. */
export function segmentCountedPages(st) {
  return st.total == null ? null : Math.max(1, Math.ceil(st.total / st.pageSize));
}

export function segmentExact(st) { return !!st.totalExact && st.total != null; }

/**
 * Take in one answered read of page `pageN`: `{total, totalExact, anchor,
 * nextCursor, hasMore, searchedTo, offsetMax}`, each surface naming its own
 * server's fields. Page 1 starts the list over; a later read that answers a count
 * (Raw logs' Request log counts every read) replaces the held one, and one that
 * answers none keeps page 1's.
 */
export function segmentAbsorb(st, pageN, d) {
  st.page = pageN;
  st.nextCursor = typeof d.nextCursor === "string" && d.nextCursor ? d.nextCursor : null;
  st.hasMore = !!d.hasMore;
  st.searchedTo = typeof d.searchedTo === "string" && d.searchedTo ? d.searchedTo : null;
  if (Number.isInteger(d.offsetMax) && d.offsetMax >= 0) st.offsetMax = d.offsetMax;
  if (pageN === 1) {
    st.total = d.total == null ? null : d.total; st.totalExact = !!d.totalExact;
    st.anchor = typeof d.anchor === "string" && d.anchor ? d.anchor : null;
    st.segments = st.anchor ? [{ start: 1, base: { anchor: st.anchor } }] : [];
    st.cutAt = null;
  } else if (d.total != null) {
    st.total = d.total; st.totalExact = !!d.totalExact;
  }
  if (st.searchedTo && (st.cutAt == null || pageN < st.cutAt)) st.cutAt = pageN;
}

/**
 * Prev, Next, -10 and +10: the page to load, or null. Next reads below this page
 * (a cursor: cheap at any depth), pushing its segment; with no cursor answered it
 * is the next page by position.
 */
export function segmentStepTarget(st, delta) {
  const from = st.page;
  if (delta === 1) {
    if (!st.hasMore) return null;
    if (st.nextCursor) {
      st.segments = st.segments.filter(sg => sg.start <= from).concat({ start: from + 1, base: { cursor: st.nextCursor } });
      return from + 1;
    }
    return segmentParams(st, from + 1) ? from + 1 : null;
  }
  let to = Math.max(1, from + delta);
  if (delta > 1) {
    if (!st.hasMore) return null;
    if (segmentExact(st)) to = Math.min(segmentCountedPages(st), to);
    while (to > from && !segmentParams(st, to)) to--;
  }
  return to !== from ? to : null;
}

/** Last: the counted last page, with an exact count only; else null. */
export function segmentLastTarget(st) {
  if (!segmentExact(st)) return null;
  const last = segmentCountedPages(st);
  return last !== st.page && segmentParams(st, last) ? last : null;
}

/**
 * Go to page: `{to, note, clear}`. An EMPTY box does nothing (Go blurs the box
 * first, whose `change` already jumped); the number is parsed strictly; an exact
 * count is needed; an over-range page is clamped and said. `clear`: empty the box.
 */
export function segmentGoTo(st, raw) {
  const v = String(raw == null ? "" : raw).trim();
  if (!v) return { to: null, note: "", clear: false };
  if (!/^\d+$/.test(v)) return { to: null, note: "Enter a page number.", clear: false };
  if (!segmentExact(st)) return { to: null, note: "Jumping to a page needs an exact count.", clear: false };
  const pages = segmentCountedPages(st);
  const wanted = Math.max(1, parseInt(v, 10));
  const to = Math.min(pages, wanted);
  return { to: to !== st.page && segmentParams(st, to) ? to : null,
    note: to !== wanted ? `Page ${wanted} does not exist — showing page ${to}.` : "", clear: true };
}

/** The pager bar's state (paginationHtml's options, less the surface's own). */
export function segmentBarOptions(st) {
  const exact = segmentExact(st);
  const counted = segmentCountedPages(st);
  const pages = exact ? counted : Math.max(counted || 1, st.page);
  const label = st.total == null ? "not counted" : exact ? `${st.total} total` : `${st.total}+ total`;
  return { page: st.page, totalPages: pages, pagesLabel: exact ? pages : `${pages}+`, totalLabel: label,
    hasPrev: st.page > 1, hasNext: st.hasMore, lastEnabled: exact && st.page < pages };
}

/**
 * The page box follows the newest answer: open with an exact count, else closed
 * with `closedNote` said beside it (a disabled box is not focusable, so a
 * description on it is never announced). It never writes the box's value: the
 * operator owns it. `ids`: the jump group, its input and its note.
 */
export function syncPageJump(ids, open, closedNote) {
  const jump = document.getElementById(ids.jump);
  const input = document.getElementById(ids.input);
  const note = document.getElementById(ids.note);
  if (!jump || !input) return;
  jump.hidden = false;
  input.disabled = !open;
  const btn = jump.querySelector("button[data-action]");
  if (btn) btn.disabled = !open;
  if (note && !open) note.textContent = closedNote || "";
  else if (note && note.textContent && !/does not exist/.test(note.textContent)) note.textContent = "";
}
//
// v7.25.0 — A RULE THIS HELPER MUST KEEP: paginationHtml emits STATELESS
// controls only. It returns a string that every caller writes into a container
// it re-renders — two of them on a 15-second poll — so anything holding
// operator input (a page-number box, a search field) would be destroyed
// mid-keystroke on five surfaces at once, which is the v7.20.10 swallowed-
// keystroke defect handed out wholesale. A control that holds input is mounted
// ONCE, in index.html, by the surface that owns it. Held by a Docs-hygiene lock.



/**
 * Paint the sort arrows + aria-sort for one surface, and restore keyboard focus
 * to the header that was activated.
 *
 * The focus restore is the part worth keeping: a re-render destroys the
 * `<thead>`, so a keyboard user who pressed Enter on a header lands back at the
 * top of the document with no indication of what happened. The rankings and
 * leaderboard views already did this; the admin panes did not, and inherit it
 * here.
 */
export function paintSortIcons(id, state, { focusCol = null } = {}) {
  document.querySelectorAll(`[id^="${id}sort-"][id$="-icon"]`).forEach(el => {
    el.textContent = "";
    const th = el.closest("th");
    if (th) th.setAttribute("aria-sort", "none");
  });
  if (state && state.col) {
    const icon = document.getElementById(`${id}sort-${state.col}-icon`);
    if (icon) {
      icon.textContent = state.asc ? " ▲" : " ▼";
      const th = icon.closest("th");
      if (th) th.setAttribute("aria-sort", state.asc ? "ascending" : "descending");
    }
  }
  if (focusCol) {
    const th = document.getElementById(`${id}sort-${focusCol}-icon`)?.closest("th");
    if (th) th.focus();
  }
}

/**
 * Clamp a page against a row count and return everything a render needs.
 * Pure — it does not write the caller's state, so the caller stays the owner of
 * `page` and there is exactly one place that decides what a valid page is.
 * (There are 39 hand-written `page = 1` resets across the SPA today.)
 */
export function paginate(rows, { page = 1, pageSize = 30 } = {}) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, page), totalPages);
  const start = (clamped - 1) * pageSize;
  return { visible: rows.slice(start, start + pageSize), total, totalPages, page: clamped, start };
}

/**
 * Case-insensitive substring match over the fields a row exposes for search.
 * `haystack(row)` returns the raw values; lowercasing happens here, which is
 * what all three donor panes already do by hand.
 */
export function matchesQuery(row, q, haystack) {
  if (!q) return true;
  const needle = String(q).trim().toLowerCase();
  if (!needle) return true;
  return (haystack(row) || []).some(v => v != null && String(v).toLowerCase().includes(needle));
}

/**
 * v7.20.8 — the shared shape for a "pick several from a list" dialog.
 *
 * Four dialogs render the same thing — a flat list of chips or checkboxes with
 * no way to narrow it: the invite dialog's Add to Groups, bulk Add to Group,
 * the group→competitions bind dialog, and the challenge picker. On an instance
 * with 200 groups every one of them is a scroll-and-squint.
 *
 * The filter HIDES non-matching items rather than re-rendering the list. That
 * is the load-bearing detail: these are MULTISELECTS, and a re-render would
 * destroy the ticks the operator has already made — the single most annoying
 * way to lose work in a dialog. Hiding also keeps the focus ring alive across
 * keystrokes for free.
 */
export function pickerFilterHtml(id, { placeholder = "Filter…", label = "Filter list" } = {}) {
  return `<input type="search" id="${esc(id)}" class="picker-filter" placeholder="${esc(placeholder)}"
    aria-label="${esc(label)}" autocomplete="off"/>`;
}

/**
 * Wire a filter input to a list of items inside `root`.
 *
 * `itemSelector` picks the elements to show/hide; the match runs against each
 * item's own textContent, which is what the operator can actually read. Returns
 * a function that re-applies the current filter — call it after the list is
 * re-rendered for a reason of its own, or the filter silently stops applying.
 */
export function wirePickerFilter(root, inputId, itemSelector, { emptyText = "Nothing matches that filter.", noun = "item" } = {}) {
  const input = root.querySelector(`#${CSS.escape(inputId)}`) || document.getElementById(inputId);
  if (!input) return () => {};
  const emptyId = `${inputId}-empty`;
  const countId = `${inputId}-count`;
  const apply = () => {
    const q = (input.value || "").toLowerCase().trim();
    let shown = 0, total = 0;
    root.querySelectorAll(itemSelector).forEach(el => {
      total++;
      // v7.20.11 — match the item's own text PLUS an optional `data-search`.
      //
      // The visible text is the right default: it is what the operator can read
      // and therefore what they expect to be able to type. But a card often
      // knows more than it shows — a competition carries tags that are not
      // rendered, a challenge shows only its first three — and searching for
      // something the record genuinely has must not fail merely because the
      // layout had no room for it. `data-search` is where a caller puts those.
      const hay = `${el.textContent || ""} ${el.dataset ? (el.dataset.search || "") : ""}`.toLowerCase();
      const hit = !q || hay.includes(q);
      el.style.display = hit ? "" : "none";
      if (hit) shown++;
    });
    let note = root.querySelector(`#${CSS.escape(emptyId)}`);
    if (!shown && !note) {
      note = document.createElement("p");
      note.id = emptyId;
      note.className = "settings-help";
      note.style.margin = "8px 0";
      note.textContent = emptyText;
      const first = root.querySelector(itemSelector);
      (first?.parentNode || root).appendChild(note);
    } else if (shown && note) { note.remove(); }
    // v7.20.10 — say how many matched. The filter HIDES rows, so without a count
    // the only way to know what a query did is to eyeball a list that has just
    // become shorter — and a list that is short because it was already short
    // looks identical to one narrowed to nothing in particular.
    let cnt = root.querySelector(`#${CSS.escape(countId)}`);
    if (!cnt) {
      cnt = document.createElement("p");
      cnt.id = countId;
      cnt.className = "settings-help list-count";
      cnt.setAttribute("role", "status");
      cnt.setAttribute("aria-live", "polite");
      cnt.setAttribute("aria-atomic", "true");
      cnt.style.margin = "4px 0";
      input.insertAdjacentElement("afterend", cnt);
    }
    cnt.textContent = countText({ filtered: !!q, matched: shown, total, noun });
  };
  input.addEventListener("input", apply);
  // v7.20.10 — paint once at wire time so the count is there BEFORE the first
  // keystroke. A count that materialises only once you type reads as something
  // having gone wrong, and "22 groups" is useful on its own. With an empty query
  // every item matches, so this is visually a no-op for the list itself.
  apply();
  return apply;
}

// ── v7.20.10 — "how many match what you typed", said once ────────────────────
//
// Every filtering surface has to answer that question and, before this, they
// answered it in five different ways or not at all: the analytics table said
// "N of M challenges match", the group pagers said "Showing X of Y matches",
// the multiselect dialogs said nothing, and a filter that matched nothing was
// distinguishable from a list that was simply short only by reading it. One
// emitter + one pure decision + one painter, so the wording cannot drift and a
// new surface costs a line.

/**
 * The count node. Mount ONCE, as a SIBLING of the search input.
 *
 * Never inside the container the rows render into — that is v7.17.1 constraint
 * 2, and it has a second edge here: a live region that is REPLACED re-announces
 * itself, while one whose textContent is updated does not.
 */
export function countHtml(id, { noun = "result", nounPlural = null, cls = "" } = {}) {
  return `<span id="${esc(id)}-count" class="list-count ${esc(cls)}" role="status" aria-live="polite"
    aria-atomic="true" data-noun="${esc(noun)}" data-noun-plural="${esc(nounPlural || noun + "s")}"></span>`;
}

/**
 * PURE — the single decision about what a count says. Unit-testable like
 * paginate() and matchesQuery().
 *
 *   • NOT FILTERED — state the size of the list rather than going blank. "12
 *     participants" is useful on its own, and a control that materialises only
 *     once you type reads as something having gone wrong.
 *   • MATCHES — "3 of 12 participants match". Both numbers: "3 match" leaves
 *     you wondering three of how many.
 *   • ZERO — say so in words. This is the case an operator most needs, and an
 *     empty list with no message is the one shape that looks like a bug.
 *   • `total: null` — the caller genuinely does not know the unfiltered size. A
 *     server-side paginated search knows how many MATCHED but not how many
 *     exist, so it says "3 participants match" and invents no denominator.
 *   • `loadedOf` — the count describes only a server-capped slice, and MUST
 *     admit it. A number that silently reports a truncated subset as the whole
 *     answer is exactly the wrong-answer class v7.16.7 fixed on the unsubscribed
 *     list; smuggling it back in through a count would be worse than no count.
 *   • `approximate` — the total is a floor (the logs' scan budget), so render
 *     "N+" rather than a figure that reads as exact.
 */
// A default plural that is right for the nouns this app actually uses
// (address→addresses, entry→entries, match→matches). `nounPlural` still wins
// for anything irregular — but a naive `noun + "s"` shipped "addresss" the first
// time a caller forgot it, and a caller who forgets should not produce a typo.
function _plural(noun) {
  const w = String(noun);
  if (/(s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
  return `${w}s`;
}
export function countText({
  matched = 0, total = null, filtered = false,
  noun = "result", nounPlural = null, loadedOf = null, approximate = false,
  // v7.20.11 — WHICH verb. A list narrowed by a typed query "matches"; one
  // narrowed only by a chip or a default filter is "shown". Several surfaces
  // arrive filtered before the operator has typed anything — the Competitions
  // table defaults to live+upcoming, the participant task list forces Unsolved —
  // and "2 of 3 competitions match" on a screen nobody has typed into invites
  // the reader to go looking for the search term that did it. Defaults to
  // `filtered`, so every existing caller keeps saying "match".
  queried = null,
} = {}) {
  const didQuery = queried == null ? filtered : !!queried;
  const many = nounPlural || _plural(noun);
  const n = c => `${c}${approximate ? "+" : ""}`;
  const plural = c => `${n(c)} ${c === 1 && !approximate ? noun : many}`;
  const cap = loadedOf != null ? ` (of ${loadedOf} loaded)` : "";
  // "1 address matches", "5 addresses match" — the verb agrees with the count,
  // not with the noun. "shown" is invariant.
  const verb = didQuery ? (matched === 1 && !approximate ? "matches" : "match") : "shown";
  if (!filtered) return `${plural(total == null ? matched : total)}${cap}`;
  if (!matched) return didQuery
    ? `No ${many} match${loadedOf != null ? " the " + loadedOf + " loaded" : ""}`
    : `No ${many} shown — every ${noun} is hidden by the current filter`;
  if (total == null) return `${plural(matched)} ${verb}${cap}`;
  return `${n(matched)} of ${plural(total)} ${verb}${cap}`;
}

/**
 * v9.2.5 — put the rows of `fresh` (a detached `<tbody>` the caller has just
 * rendered with setSafeHtml) into `tbody`, KEEPING every row of `tbody` whose
 * markup did not change.
 *
 * A render used to replace every row, changed or not, and a press that goes
 * down on a row and comes up on that row's replacement gets no click (Chromium
 * sends pointer and mouse events but no click across a replaced node). The
 * Events list renders on its 15-second poll whether or not anything changed,
 * so an organiser's press on Open, a session chip or ⋮ that happened to
 * straddle a tick did nothing, and focus on a row control was dropped. Now a
 * row whose markup at its place is unchanged keeps its node (and focus); a row
 * that changed or moved is replaced (the pointer is over another event by
 * then anyway); a different row count replaces them all.
 *
 * Each row put here carries the markup it was rendered as (`_patchHtml`, its
 * outerHTML before anything decorated it: the column chooser's classes, the
 * card labels), a JS property, so nothing observes it. A row any other writer
 * put there (a load failure, a skeleton) carries none, so the next call
 * replaces them all. The caller's setSafeHtml stays the one HTML sink, judged
 * where the markup is built. Returns true when anything changed.
 */
export function patchTableRows(tbody, fresh) {
  if (!tbody || !fresh) return false;
  const next = [...fresh.rows], keys = next.map(tr => tr.outerHTML);
  const cur = [...tbody.rows];
  if (cur.length !== next.length || cur.some(tr => typeof tr._patchHtml !== 'string')) {
    tbody.replaceChildren(...next);
    next.forEach((tr, i) => { tr._patchHtml = keys[i]; });
    return true;
  }
  let changed = false;
  next.forEach((tr, i) => {
    if (cur[i]._patchHtml === keys[i]) return;
    cur[i].replaceWith(tr);
    tr._patchHtml = keys[i];
    changed = true;
  });
  return changed;
}

/**
 * v9.2.5 — `setSafeHtml`, skipped when `el` still holds exactly what the last
 * call here wrote (a pager the Events poll re-renders: replacing it mid-press
 * loses the press, and closes an open page-size list). Another writer's content
 * (a different first node) is always replaced.
 */
export function setHtmlIfChanged(el, html) {
  if (!el) return false;
  if (el._patchHtml === html && el._patchFirst === el.firstChild) return false;
  setSafeHtml(el, html);
  el._patchHtml = html;
  el._patchFirst = el.firstChild;
  return true;
}

/** Paint it. Returns the string written (or that would have been written). */
export function setListCount(id, opts) {
  const el = document.getElementById(`${id}-count`);
  if (!el) return "";
  const next = countText({ noun: el.dataset.noun, nounPlural: el.dataset.nounPlural, ...opts });
  // Never rewrite identical text into a live region. renderAdminCompetitions()
  // runs on the Events list's 15-second poll (and renderParticipants() after it
  // whenever the open event's state changes), so an unguarded write would have
  // a screen reader announce the same sentence four times a minute.
  if (el.textContent !== next) el.textContent = next;
  return next;
}

/**
 * A chip multiselect, MODEL-BACKED — v7.21.16 (long-list phase 4).
 *
 * Two dialogs rendered this by hand: the invitation dialog's "Add to Groups"
 * and the bulk assign-to-competitions dialog's group binder. Identical markup,
 * identical keyboard wiring, and — the reason this exists rather than being a
 * tidy-up — they disagreed about where the SELECTION lives.
 *
 * The bulk one keeps a model (`S.bulkSelectedGroups`), which is why its Step 2
 * → Back path can restore the picks. The invitation one read the selection back
 * out of the DOM at submit time (`querySelectorAll('[aria-pressed="true"]')`),
 * so the picks existed only as long as the markup did. That is the same class
 * v7.17.0 called a HARD PREREQUISITE before the import-conflict modal could be
 * paginated: any future re-render of that box — a filter that rebuilds instead
 * of hiding, pagination, a refetch — would silently drop every tick, with no
 * error and nothing on screen to show it happened.
 *
 * So the selection is a `Set` owned by the caller, and the DOM is a projection
 * of it. `render()` is safe to call again; the ticks come back.
 *
 * `idAttr` exists so the migration preserved each dialog's EXISTING attribute
 * (`data-group-id`) rather than renaming it. Two regression tests locate chips
 * by that attribute, and v7.17.1's rule applies: a refactor that forces
 * unrelated tests to change hides whether it changed behaviour.
 *
 * The chips are 24px by the documented WCAG 2.2 AA exception (SC 2.5.8) rather
 * than the 44px house standard — a dense multiselect would treble in height
 * otherwise, and they are admin-only and keyboard-operable. See CLAUDE.md's
 * accepted touch-target exceptions before changing the size.
 */
export function chipMultiselectHtml(items, { cls, idKey = "id", labelKey = "name", countKey = null, selected = null, idAttr = "chip-id" } = {}) {
  const sel = selected || new Set();
  return items.map(it => {
    const on = sel.has(String(it[idKey]));
    const count = countKey != null && it[countKey] != null ? ` <span class="chip-count">(${esc(String(it[countKey]))})</span>` : "";
    return `<span class="group-tag ${esc(cls)}${on ? "" : " chip-off"}" style="cursor:pointer" role="button" tabindex="0"`
      + ` aria-pressed="${on ? "true" : "false"}" data-${esc(idAttr)}="${esc(String(it[idKey]))}">${esc(String(it[labelKey]))}${count}</span>`;
  }).join("");
}

/**
 * Wire the chips inside `root` to `selected` (a Set of string ids).
 *
 * Mutates the Set in place so the caller keeps one authoritative object, and
 * calls `onChange` after every toggle. Returns a `sync()` that re-projects the
 * Set onto the DOM — call it after re-rendering the chips for any reason.
 */
export function wireChipMultiselect(root, cls, selected, { onChange = null, idProp = "chipId" } = {}) {
  const chips = () => root.querySelectorAll(`.${cls}`);
  const paint = el => {
    const on = selected.has(el.dataset[idProp]);
    el.setAttribute("aria-pressed", on ? "true" : "false");
    el.classList.toggle("chip-off", !on);
  };
  const sync = () => chips().forEach(paint);
  chips().forEach(el => {
    const toggle = () => {
      const id = el.dataset[idProp];
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      paint(el);
      if (onChange) onChange(selected);
    };
    el.onclick = toggle;
    el.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
    paint(el);
  });
  return sync;
}

// v7.23.5 (audit Wave 5) — ONE way to report a failed load.
//
// A harness that drove all 11 list surfaces with their data request forced to
// 500 found that 8 of them mishandled it, in four distinct ways:
//
//   • FALSE CLAIM — admin/participants said "No participants yet." and
//     admin/submissions said "No submissions yet." for a request that FAILED.
//     That is the worst category: not a missing answer but a wrong one.
//   • THREW — admin/competitions ("rows.slice is not a function") and
//     admin/rankings ("board.filter is not a function"), because a 500's JSON
//     error body is an OBJECT and it was assigned straight into a slot the
//     renderer iterates. Blank surface, no message.
//   • STUCK — admin/logs left 5 skeleton rows shimmering for ever.
//   • SILENT — participant/comp-picker rendered completely blank: no text, no
//     toast, no spinner, and (worse) its poll starts AFTER the early return, so
//     there was no auto-recovery either.
//
// The audit's prose named about four of these. The source has 21 loaders across
// 12 files and 8 of those files had no failure branch at all, which is why the
// worklist had to be measured.
//
// TWO RULES, both learned the hard way:
//
//  1. THE MODEL SLOT KEEPS ITS TYPE. Reporting the failure is not enough — if
//     `S.adminCompetitionsData` is left holding `{error:"Boom"}` then the next
//     `.find`/`.slice`/spread still throws and the surface is still blank. Pass
//     `resetModel` and it is set to an empty array of the right shape.
//  2. RETRY ONLY WHERE THERE IS NO POLL — and v8.11.11 MEASURED which panes
//     actually poll, because this sentence used to say "the admin tables refresh
//     on a 15 s timer, so they self-heal and a button would be noise" and that
//     was false for five of the eight. There is exactly ONE admin poll
//     (`startAdminCompPoll`, competitions-admin.js) and its body calls
//     `loadAdminCompetitions` alone; Logs has its own auto-refresh. Measured by
//     forcing each pane's endpoint to 500 and counting requests over 20 s:
//     events and logs re-request, **challenges / participants / groups /
//     submissions / rankings do not**. So a failed load there was terminal — the
//     operator's only route out was to switch tabs and back, which nothing on
//     screen suggested. All five carry `retryAction` now; events and logs still
//     do not, and that remains correct.
// v8.7.3 — `message` overrides the default sentence for a failure the server
// EXPLAINED. "The server did not respond correctly" is right for a 500 and a
// lie for a 400 that named its reason; the caller that can read the reason is
// the only one that can say it. `retryAction` is then usually wrong too — a
// button that re-issues the identical request cannot help — so callers passing
// `message` normally omit it. The default path is byte-identical.
export function renderLoadFailure(containerId, {
  colspan = null,
  noun = "data",
  retryAction = null,
  resetModel = null,
  message = null,
} = {}) {
  if (typeof resetModel === "function") { try { resetModel(); } catch (e) { console.warn('Retry: could not reset the list model', e); } }
  const el = document.getElementById(containerId);
  if (!el) return;
  const retry = retryAction
    ? ` <button class="btn sm secondary" data-action="${retryAction}">Try again</button>`
    : "";
  const msg = message
    ? `${message}${retry}`
    : `Could not load ${noun}. The server did not respond correctly.${retry}`;
  // A <tbody> needs a row; anything else takes the message directly. The
  // colspan MUST come from the caller's real <thead> — a hand-guessed one is
  // how v7.20.9 F12 shipped a colspan=10 on an 11-column table. Written through
  // setSafeHtml, the app's one HTML door (README, Trusted Types).
  setSafeHtml(el, colspan != null
    ? `<tr><td colspan="${colspan}" class="table-empty-row load-failed">${msg}</td></tr>`
    : `<div class="table-empty-row load-failed">${msg}</div>`);
}

// Derive a <tbody>'s colspan from its own table's header, so it cannot drift
// when a column is added (v7.20.9 F12, and the Participants row that spanned 22
// columns of a 21-column table).
export function colspanFor(tbodyId) {
  const tb = document.getElementById(tbodyId);
  const table = tb && tb.closest("table");
  const n = table ? table.querySelectorAll("thead th").length : 0;
  return n || 1;
}
