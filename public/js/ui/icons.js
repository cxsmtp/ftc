"use strict";


export const AVATARS=["🦊","🐺","🦁","🐯","🦅","🐉","🤖","👾","🦄","🐼","🦋","🎩","🐸","🦉","🐧","🦈","🐙","🦀","🎭","🧙","🦖","🐝","🦚","🔥"];

export const DIFF_PTS={easy:50,medium:100,hard:150};

export const _SVG=(p)=>`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

export const ICO={
  // v7.21.0 — the category ribbon's glyph. Feather's `tag`, per the house icon
  // convention (inline SVG, currentColor, never an emoji or a webfont).
  tag:_SVG('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
  layers:_SVG('<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>'),
  edit:_SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
  trash:_SVG('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'),
  eye:_SVG('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff:_SVG('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'),
  play:_SVG('<polygon points="5 3 19 12 5 21 5 3"/>'),
  stop:_SVG('<rect x="5" y="5" width="14" height="14" rx="1"/>'),
  send:_SVG('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
  clock:_SVG('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  medal:_SVG('<circle cx="12" cy="8" r="6"/><path d="M8.21 13.89 7 22l5-3 5 3-1.21-8.12"/>'),
  target:_SVG('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>'),
  clipboardCheck:_SVG('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="m9 14 2 2 4-4"/>'),
  // v7.22.0 — the copy-to-clipboard affordance on the admin rankings identity
  // cells. Feather's `copy`, per the house convention (inline SVG, currentColor,
  // never an emoji or a webfont glyph).
  copy:_SVG('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  users:_SVG('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  userPlus:_SVG('<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>'),
  userMinus:_SVG('<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="23" y1="11" x2="17" y2="11"/>'),
  userCheck:_SVG('<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/>'),
  mailCheck:_SVG('<path d="M4 4h16c1.1 0 2 .9 2 2v6"/><path d="M22 6 12 13 2 6"/><path d="M2 6v12c0 1.1.9 2 2 2h9"/><polyline points="16 19 18 21 22 17"/>'),
  shieldOff:_SVG('<path d="M19.69 14a6.9 6.9 0 0 0 .31-2V5l-8-3-3.16 1.18"/><path d="M4.73 4.73 4 5v7c0 6 8 10 8 10a20.29 20.29 0 0 0 5.62-4.38"/><line x1="1" y1="1" x2="23" y2="23"/>'),
  ban:_SVG('<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'),
  lock:_SVG('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  unlock:_SVG('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'),
  key:_SVG('<circle cx="8" cy="15" r="4"/><path d="M10.85 12.15 19 4"/><path d="m18 5 3 3"/><path d="m15 8 3 3"/>'),
  arrowUp:_SVG('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>'),
  arrowDown:_SVG('<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>'),
  star:_SVG('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
  // v6.10.1: new icons for the three-way-mix sweep. Replace the
  // HTML dingbats (`&#10003;`, `&#10007;`) and emoji (💡, 🔗) in
  // admin table cells + status rows with these inline SVGs for
  // consistent cross-OS rendering.
  check:_SVG('<polyline points="20 6 9 17 4 12"/>'),
  x:_SVG('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  sparkles:_SVG('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/>'),
  // v6.16.46 — design-system iconography vocabulary alignment.
  // arrowLeft replaces the `←` literal at app.js:1463 (and the
  // `&#8592;` HTML entity at index.html:270 inline-SVG'd statically).
  // chevronDown replaces the `▾` glyph at app.js:9221 / :9229 — those
  // were a residual icon-convention violation per CLAUDE.md
  // v6.10.6. chevronLeft / chevronRight / info / chat / message
  // are added for completeness with the design's documented
  // 16-icon Lucide vocabulary even if no callsite uses them yet.
  arrowLeft:_SVG('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  chevronDown:_SVG('<polyline points="6 9 12 15 18 9"/>'),
  chevronLeft:_SVG('<polyline points="15 18 9 12 15 6"/>'),
  chevronRight:_SVG('<polyline points="9 18 15 12 9 6"/>'),
  info:_SVG('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'),
  circle:_SVG('<circle cx="12" cy="12" r="10"/>'),
  // v7.19.0 — multiple-choice preview markers (Feather-style, per the
  // inline-SVG icon convention: no emoji, no dingbats).
  square:_SVG('<rect x="3" y="3" width="18" height="18" rx="2"/>'),
  checkSquare:_SVG('<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  radioChecked:_SVG('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4" fill="currentColor"/>'),
  lightbulb:_SVG('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 1 4 12.73c-.6.42-1 1.09-1 1.82V18H9v-1.45c0-.73-.4-1.4-1-1.82A7 7 0 0 1 12 2z"/>'),
  link:_SVG('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  // v7.18.0 — rich-text table toolbar button (Feather-style grid).
  table:_SVG('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/>'),
  trophy:_SVG('<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 4h3a2 2 0 0 1 0 4h-3"/><path d="M7 4H4a2 2 0 0 0 0 4h3"/>'),
  hourglass:_SVG('<path d="M6 2h12"/><path d="M6 22h12"/><path d="M6 2v6l6 4-6 4v6"/><path d="M18 2v6l-6 4 6 4v6"/>'),
  // v6.10.4: `ICO.refresh` was referenced from the admin-challenges
  // three-dot menu (`Recalculate Scores`) but never defined — the
  // `${ICO.refresh||'⟳'}` fallback was rendering the U+27F3 dingbat
  // in every kebab row. Added a Feather-style refresh icon to
  // match the rest of the registry.
  refresh:_SVG('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
  // v6.10.5: icon-sweep completeness. paperclip for "Download
  // Attachment"; solution for the "${ICO.solution} Solution" header on task
  // preview + detail.
  paperclip:_SVG('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
  solution:_SVG('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>'),
  // Feather-style arrow-into-tray for the Downloads heading + chip action.
  download:_SVG('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  // v6.10.6: final icon-sweep residuals. alertTriangle for the
  // LinkedIn-popup warning branch (email delivery failed). The
  // popup helper was taking an emoji as first arg and comparing it
  // to string literals — now it takes a status enum ('success' /
  // 'warning' / 'error') and builds the SVG internally.
  alertTriangle:_SVG('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  // Feather-style external-link arrow for "open in new tab" affordances.
  // Replaces the ↗ unicode dingbat (U+2197) on the help drawer header so
  // icon rendering stays consistent across operating systems.
  externalLink:_SVG('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
  // v6.17.0 — admin sidebar nav icons
  barChart:_SVG('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/>'),
  activity:_SVG('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
  fileText:_SVG('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>'),
  settings:_SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  // Event workspace (organiser shell): calendar facts, the join card, the
  // templates gallery and the certificate wizard.
  calendar:_SVG('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  grid:_SVG('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>'),
  maximize:_SVG('<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>'),
  zap:_SVG('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
  flag:_SVG('<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>'),
  award:_SVG('<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>'),
  code:_SVG('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
  more:_SVG('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
  save:_SVG('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
  // The app chrome: the header Search button and command palette, and the
  // account menu's rows.
  search:_SVG('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  helpCircle:_SVG('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  palette:_SVG('<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.6-.4-1.1 0-.9.7-1.6 1.6-1.6H16c3.3 0 6-2.7 6-6 0-4.9-4.5-8.6-10-8.6z"/>'),
  user:_SVG('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  logOut:_SVG('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
  swap:_SVG('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
};

export function medalTinted(rank, { srLabel = true, showOrdinal = false } = {}) {
  const cls = rank === 1 ? "gold" : rank === 2 ? "silver" : "bronze";
  const ord = rank === 1 ? "1st" : rank === 2 ? "2nd" : "3rd";
  // The medal SVG is aria-hidden, so for top-3 the rank would be invisible to
  // screen readers. Carry a visually-hidden ordinal alongside it. Callers whose
  // surrounding text already states the rank (the "You placed … 1st place"
  // banner) pass {srLabel:false} to avoid a double announcement.
  //
  // v7.23.0 — `showOrdinal` renders the rank VISIBLY beside the medal, for the
  // table rows. `.medal.gold/.silver/.bronze` differ ONLY in `color` (the
  // look's metal inks, --gold/--silver/--bronze), so on a leaderboard row the
  // top three places were distinguished by hue alone — WCAG 1.4.1 Use of
  // Color. Rank 4+ already renders a literal `#4`, so the medal rows were also the only ones a user
  // could not read a number off. Colour-blind users, greyscale printing and
  // forced-colors mode (where all three resolve to CanvasText) each lose the
  // distinction entirely; the sr-only label helped none of them.
  //
  // The PODIUM deliberately does not pass this: its stepped block heights
  // are already a non-colour cue, and it has its own type scale.
  //
  // When the ordinal is visible it IS the announcement, so the sr-only copy is
  // suppressed — otherwise a screen reader hears "1st place" twice per row.
  if (showOrdinal) {
    return `<span class="medal ${cls}" aria-hidden="true">${ICO.medal}</span><strong class="medal-ord">#${rank}</strong>`;
  }
  const label = srLabel ? `<span class="sr-only">${ord} place</span>` : "";
  return `<span class="medal ${cls}" aria-hidden="true">${ICO.medal}</span>${label}`;
}


export const EDITOR_FONTS=['Default','Arial','Georgia','Times New Roman','Courier New','Verdana','Trebuchet MS','Inter'];

export const EDITOR_SIZES=[{label:'Small',val:'2'},{label:'Normal',val:'3'},{label:'Large',val:'4'},{label:'XL',val:'5'},{label:'XXL',val:'6'}];

export const CODE_LANGUAGES=[
  {val:'',label:'Auto-detect'},
  {val:'javascript',label:'JavaScript'},
  {val:'typescript',label:'TypeScript'},
  {val:'python',label:'Python'},
  {val:'java',label:'Java'},
  {val:'csharp',label:'C#'},
  {val:'cpp',label:'C++'},
  {val:'c',label:'C'},
  {val:'go',label:'Go'},
  {val:'rust',label:'Rust'},
  {val:'ruby',label:'Ruby'},
  {val:'php',label:'PHP'},
  {val:'swift',label:'Swift'},
  {val:'kotlin',label:'Kotlin'},
  {val:'sql',label:'SQL'},
  {val:'html',label:'HTML'},
  {val:'css',label:'CSS'},
  {val:'xml',label:'XML'},
  {val:'json',label:'JSON'},
  {val:'yaml',label:'YAML'},
  {val:'bash',label:'Bash / Shell'},
  {val:'dockerfile',label:'Dockerfile'},
  {val:'powershell',label:'PowerShell'},
  {val:'markdown',label:'Markdown'},
  {val:'plaintext',label:'Plain Text'},
];
