# Hack Arena — Design System

Single source of truth for UI tokens and primitives. The `frontend-design` skill and the `ui-polisher` subagent apply this file; they do not invent their own palette.

**The direction is Flat Design 3.0 with two flat looks, Signature and Ambient (operator ruling, 13 Nov 2026).** It replaced a six-look direction whose looks differed by construction; four of those looks were retired. Its principles:

1. **One brand object leads: the certificate.** Deep violet-navy, gold double hairlines, a diamond ornament, tracked caps. Signature is the certificate's own palette by day and at night; every screen inherits its grammar (hairline rules, facts split by hairlines, one gold action).
2. **One gold thing per screen** (`.btn.gold`): the certificate download, the first place, the hours-left figure. Everything else is ink and the look's accent.
3. **Calm density.** Hairline dividers instead of boxes inside boxes, labels in tracked caps (`.eyebrow`), numbers in the display face with tabular figures (`.bignum`). One family (Inter), one scale (§2).
4. **Flat Design 3.0 governs construction.** Depth comes only from three soft shadow tiers (§5). No skeuomorphism: no bezels, brushed metal, LCD wells, glass, inset key lighting, `backdrop-filter`, blurred glows or blur filters, and no smooth gradient on a surface, control, rule or text except the ones main kept (§10). **A look differs only by colour and corner radii**, never by construction or type. The motif is a single corner-anchored line-art mask at 7–16 % ink.
5. **Phone first for players; nothing ever scrolls sideways at 390 px.**
6. **Every text pair measured.** The palette lives in one data file and the generator fails on any pair below WCAG AA (§1).

---

## 1. Colour tokens

### Where they live

- **Data:** `scripts/theme/looks.js` — each look × mode (and Ambient's six ambient light colours) as hex. Hex lives nowhere else.
- **Generator:** `scripts/build-theme-tokens.js` (`npm run theme:tokens`; `--check` exits 1 when the block is stale) writes the block between `/* BEGIN GENERATED LOOK TOKENS` and `/* END GENERATED LOOK TOKENS */` at the top of `public/styles.css`, and **exits 1 if any text pair drops below AA**. It measures body, secondary and muted text on canvas, card, inner well and hover well; accent ink on card, well, canvas, hover well and its tint; every button label on its fill and hover fill; gold, silver and bronze on the card and (≥ 3:1) on the accent tint of your own leaderboard row, and each medal's label on its fill; each status ink on card, well and tint; the label on a filled status button and on the bright warning fill; control boundaries ≥ 3:1; the focus ring ≥ 3:1; every rich-text ink on canvas, card, inner well and hover well, and body, muted, link and every ink on every rich-text highlight — in every look, mode and ambient colour (it prints the count). `tests/theme-tokens.spec.js` holds the block to the data.
- **Never hand-edit the generated block, never `@import` it** (a failed import voids every `var()`), never use `color-mix()` (older WebKit drops it: write literal `rgba()` / `rgb(r g b / a)`). There are **no `oklch()` declarations** in the stylesheet.

### Selection contract

`public/theme-boot.js` (a classic script, before first paint) sets on `<html>`:

| Attribute | Values | Stored in (per browser) |
|---|---|---|
| `data-look` | `ambient` (the house default), `signature` | `localStorage["hck-look"]`; a stored look that is not offered reads as no choice |
| `data-theme` | `light` / `dark`, always resolved. The preference `system` follows the device, and nothing stored is `system` (the house mode) | `localStorage["hck-theme"]` = `system`/`light`/`dark` |
| `data-ambient` | `violet`, `cyan` (Glacier), `amber`, `rose`, `emerald`, `ice` — only Ambient shows it; absent = Ice | `localStorage["hck-ambient"]` |

Any element can carry the attributes (the look picker's mini previews nest that way). **An element marked `[data-stage]` takes the page's look but always renders its night mode** (the full-screen join QR). `:root` with no look falls back to Signature's tokens (a page theme-boot never ran on); theme-boot itself defaults to Ambient following the device (`HOUSE_LOOK` / `HOUSE_MODE`). The precedence (event lock, platform lock, own choice, event look, platform look, house) is in CLAUDE.md § Appearance.

Because every look × mode is a selector on any element, **a per-look rule for a nested preview must key on the preview itself** (`.lp-mini[data-look="x"] …`), never on an ancestor (`[data-look="x"] …` also matches the page's own look), and **a per-look night rule never keys on a bare `:root[data-theme="dark"]`** (it out-ranks every look).

### Token set (per look × mode)

| Token | Role |
|---|---|
| `--bg --bg-2` | canvas, sunken canvas |
| `--surface --surface-2 --surface-3` | card; inner well / table head; hover |
| `--border --border-strong` | decorative hairlines (not held to 3:1) |
| `--control` | input / tile boundary (≥ 3:1, WCAG 1.4.11) |
| `--text --text-2 --muted` | body, secondary, captions (≥ 4.5:1) |
| `--accent` | accent as a graphic (ring, bar, step mark) — **not** text |
| `--accent-ink` | accent as text (links, eyebrows) |
| `--accent-strong --accent-hover --on-accent` | primary fill, its hover, its label |
| `--accent-soft` | selected tile / chip tint |
| `--focus` | focus ring |
| `--glow` | RGB triplet of the accent, for flat translucent rings and tints: `rgb(var(--glow) / .18)` — never a blurred glow. **Every accent tint is written this way**, never as a literal violet, so it follows the look and the ambient colour (lock: `tests/css-token-sites.spec.js`) |
| `--gold --gold-deco --gold-strong --on-gold` | gold ink, ornament, gold fill (the CTA and the gold medal), its label |
| `--silver --bronze` | medal inks (with `--gold`): the podium's numerals and every leaderboard row's medal |
| `--silver-strong --on-silver --bronze-strong --on-bronze` | the silver and bronze medal fills and their labels |
| `--ok --warn --danger` (+ `-soft`) | status ink and tint |
| `--brand-ink --brand-soft` | the brand violet pair for state chips that keep their own hue (late entry open, the shared pool, "you compete here"): fixed per look and mode, never the accent, so no ambient colour turns late entry into Upcoming's amber or Live's green (≥ 4.5:1, measured) |
| `--on-status` | label on a filled status colour (`#fff` by day, `--bg` at night) |
| `--warn-strong --on-warn` | the bright warning fill (the Pending chip) and its label (≥ 4.5:1, measured): the one status fill not labelled `--on-status` |
| `--ok-rgb` | RGB triplet of `--ok`, for a ring that fades it (the workspace's live pulse): `rgb(var(--ok-rgb) / .45)` |
| `--rt-<name> --rt-hl-<name>` | the rich-text colours: the ink and the highlight tint of each name the challenge editor's Text colour and Highlight menus store (`rtInk`/`rtHighlight`; grey, red, orange, yellow, green, cyan, blue, violet, pink). Fixed per look and mode, never the accent; every ink ≥ 4.5:1 on canvas, card, well and hover well, and body, muted, link and every ink ≥ 4.5:1 on every tint (measured). Content names them inline (`color:var(--rt-red)`), never by a class or attribute a rule draws: the browser's editing inlines a rule's computed colour as a literal |
| `--sh-1 --sh-2 --sh-3` | the three soft shadow tiers (§5), tinted by `--shadow-rgb` |
| `--r-s --r-m --r-l --r-xl --control-h` | shape per look |

Type is **not** per look (§2): the type tokens live once, in the hand-written `:root` block above the generated one.

Hand-written look character (beside the generated block): the motif (`--motif --motif-pos --motif-size --motif-ink`), `--panel-edge`, `--ribbon(-2)` (token-derived).

### Legacy names (every pre-look rule keeps working)

One alias rule (`:root,[data-look],[data-stage]{…}`, generated from `LEGACY_ALIASES`) maps each old name onto its token, so `var(--surface2)` is the look's `--surface-2`:

`--surface2` → `--surface-2` · `--accent2` → `--accent-ink` · `--green` / `--easy` / `--badge-green-fg` → `--ok` · `--yellow` / `--medium` / `--badge-yellow-fg` → `--warn` · `--red` / `--hard` / `--badge-red-fg` → `--danger` · `--badge-draft-fg` → `--muted` · `--badge-purple-fg` → `--brand-ink` · `--green-soft` / `--green-pill` → `--ok-soft` (and yellow, red alike) · `--purple-pill` → `--brand-soft` · `--font-sans` / `--font-body` / `--font-label` → `--font-text` and `--font-num` → `--font-display` (new code names the new tokens) · `--radius` → `--r-m` · `--radius-md` → `--r-s` · `--radius-xl` → `--r-l` · shadows (§5).

`--accent` keeps its name but is the *graphic* accent: a fill that carries text uses `--accent-strong` with `--on-accent`, accent text uses `--accent-ink`. Not aliased (look-independent, in the hand-written `:root`): `--overlay`, `--code-bg/--code-fg`, `--role-*`, `--pill-radius`, `--radius-sm`, `--linkedin-brand`, and `--header-bottom` (the header's bottom edge, measured at runtime by `publishHeaderHeight()` in `ui/nav.js`; its 64px value is only the fallback before the first measurement; every height reservation under the header reads it, never a constant). Not on `:root` at all: `--strip-bottom`, the bottom edge of a strip a page keeps stuck under the header (`data-sticky-strip`), set on that page by `publishStripBottoms()` in `ui/nav.js` and read by the route-focus scroll margins.

Chips that carry no status colour paint from tokens too: the solved chip is `--accent-ink` on `--accent-soft`, the dry-run (and late-entrant, benchmark) chip `--muted` on `--surface-3`, the ended chips (`.comp-ended`, `.status-badge.ended`) `--muted` on `--surface-2` with a `--border` hairline by day, all measured pairs (lock: `tests/css-token-sites.spec.js`).

### Key values

| | bg | surface | text | muted | accent-ink | accent-strong / on | gold |
|---|---|---|---|---|---|---|---|
| Signature day | #f6f3ee | #fffdf9 | #1c1430 | #5f5770 | #5427c9 | #5a2fd4 / #fff | #8a5e0c |
| Signature night | #0d0b1c | #15122a | #efeaf9 | #a49dc2 | #ad96ff | #6b40ec / #fff | #e3bf66 |
| Ambient day | #eceef2 | #fbfbfc | #101217 | #535a66 | per ambient | per ambient | #835a0a |
| Ambient night | #0d0e11 | #15171c | #eef0f4 | #9ba2ae | per ambient | per ambient | #e6c26f |

---

## 2. Typography

**One family for every look: Inter (part of the flat-design plan the operator approved, 13 Nov 2026).** Looks never differ by font.

| Token | Stack |
|---|---|
| `--font-display` | `"Inter Text Display",system-ui,` emoji, `sans-serif` |
| `--font-text` | `"Inter Text",system-ui,` emoji, `sans-serif` |
| `--font-mono` | `"JetBrains Mono",ui-monospace,monospace` |

- **"Inter Text" and "Inter Text Display" are the vendored Inter** (`public/vendor/fonts/inter-latin*.woff2`, variable 100–900, latin + latin-ext) at `size-adjust: 87.1%`, declared in `public/fonts.css`: the size every machine without Aptos drew before 9.1.0, so no line length or wrap moved when Aptos went. Code is the vendored JetBrains Mono. Plain `'Inter'` (full size) stays declared for rich text authored in the editor's Inter.
- `lib/fonts/badge/` is the server-side certificate set (not the SPA's; outside `public/`, so it is never served).
- **The emoji fonts close each stack** (`"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Segoe UI Symbol"`): user content falls back per glyph, and naming them keeps ✅ and ❌ alike (Docs-hygiene lock).
- Every rule using `var(--font-mono)` sets `font-variant-ligatures:none` (lock: `tests/code-blocks.spec.js`).

**Type scale.** The root stays the browser's 16 px (no body clamp). Components read a ROLE token; roles read the primitive steps `--fs-12 13 14 15 16 17 18 22 28 36 40 64`.

| Role | Size / line | Weight, face | Tokens |
|---|---|---|---|
| Hero | 64/68 (phone 40/44) | 600 display, −0.02em | `--fs-hero --lh-hero` (`--fs-d1`) |
| Page title (incl. `.admin-pane-title`) | 40/44 (phone 30/34) | 600 display | `--fs-page --lh-page`, `--fs-page-phone` (`--fs-d2`, `--fs-d3`) |
| Card / dialog title (`.modal-title`) | 22/28 | 600 display | `--fs-title --lh-title` |
| Section | 17/24 | 600 text | `--fs-section --lh-section` |
| Body | 16/24 | 400 | `--fs-body --lh-body` |
| Small | 14/20 | 400 | `--fs-small --lh-small` |
| Caption | 13/18 | 400 | `--fs-caption --lh-caption` |
| Eyebrow, field label, **every `th`** | 12/16, `.12em` caps | 600 | `--fs-label --lh-label --tr-label` |
| Button (never uppercase) | 15/20 (`.sm` 14/18) | 600 | `--fs-btn --lh-btn --fs-btn-sm --lh-btn-sm` |
| Chip (`.chip`, `.status-badge`, filter chips) | 12/16 | 600 | `--fs-chip --lh-chip` |
| Input | 16 | 400 | `--fs-input` |
| Figures (`tabular-nums`, display) | 36/40 · 28/32 · 18/24 | 600 | `--fs-fig-l/-m/-s`, `--lh-fig-*` |
| Code (ligatures off) | 14/22 | 400 mono | `--fs-code --lh-code`; inline `--fs-code-em`; join-code cells `--fs-code-cell` |
| Knobs (look-independent, once in the block) | the label 12 px, `.12em`, caps | display, heading, label and figure weights 600; display tracking −0.02em, optical size `normal` | `--display-wght --display-opsz --display-track --heading-wght --num-wght --label-size --label-track --label-wght --label-case` |

The sign-in screens' size aliases `--type-xs/-sm/-md/-lg/-h3/-h2` are `--fs-12/13/15/17/28/36` (their own small block after the generated one); new code names the role tokens.

**A `<button>` with no class draws its container's family and size** (the bare `button` rule inherits both), never the engine's control default (13.33 px in Chromium and Firefox, 16 px in WebKit); a button meant to look like one is a `.btn` (lock: `tests/type-scale-scanner.spec.js`).

**Weights are 400 and 600** (`--fw-regular`, `--fw-semibold`); 700 (`--fw-score`) only on the live score figure.

**No literal family, size or weight outside the token block** — not in `styles.css`, not in `public/js/**` inline styles. `tests/type-scale-scanner.spec.js` refuses them; the standalone unsubscribe and verify pages, which cannot load `styles.css`, are its only exemption.

Primitives: `.display` (display face), `.eyebrow` (tracked caps, `.ink` / `.gold`), `.lede` (17 px intro, 44ch), `.bignum` (display figures, tabular lining).

**No `font-size` below 16px may apply to `input`, `select` or `textarea` on a touch screen.** The base rule declares 16px at every width (scanner *v7.23.3*), and a `@media (pointer: coarse)` block re-asserts it on the denser controls (`tests/interactive-contrast.spec.js`).

---

## 3. Spacing scale

Tokens are `--s-N` (never `--space-N`, which does not exist): `--s-1:4px --s-2:8px --s-3:12px --s-4:16px --s-5:20px --s-6:24px --s-8:32px --s-10:40px --s-12:48px --s-16:64px`. Page gutter 24 desktop / 16 phone.

---

## 4. Radii

Per look (`--r-s / --r-m / --r-l / --r-xl`): Signature 8/12/18/26, Ambient 10/14/20/28. `--pill-radius:999px` and `--radius-sm:4px` are look-independent. Control height `--control-h` 44 (Ambient 46); every target ≥ 44 px (the accepted exceptions are in CLAUDE.md).

**Every corner is a token, so it follows the look** (principle 4; a literal 8px drew Signature's corner in Ambient too). By role: `--r-s` small parts (segment options, nav items, inline notes, small panels), `--r-m` controls (buttons, inputs) and answer blocks, `--r-l` cards and dialogs, `--r-xl` hero cards and sheets; `--radius-sm` for 4 px marks that stay the same in every look; `--pill-radius` for every pill (chips, badges, tracks, switches). The aliases `--radius` (`--r-m`), `--radius-md` (`--r-s`) and `--radius-xl` (`--r-l`) still resolve. Not literals: `0`, a percentage (`50%` is a circle), `inherit`/`revert`, and a `calc()` that offsets a token. **No literal on the ladder** (a rung of either look, 4 px or a pill) in `styles.css`, in `public/js/**` inline styles or in the shell's markup, and any other literal is a recorded decision with its reason: 1–3 px marks (bars, pips, dashes and rules round by their own size) and the grandfathered 6 px. `tests/radius-tokens.spec.js` derives the ladder from `scripts/theme/looks.js` and refuses the rest; the standalone verify and unsubscribe sheets and mail markup take no look and are outside it.

The standalone shells (`public/verify-pages.css`, `public/unsubscribe.css`), which cannot load `styles.css`, declare the radius tokens they use under the same names at Signature's values (`--r-s:8px`, `--r-m:12px`, `--r-l:18px`), each by the role above (cards `--r-l`, buttons and inputs `--r-m`, small parts `--r-s`), never a `--radius*` name, and round nothing with a literal (`tests/theme-tokens.spec.js`). They serve the pages opened from an email, `/credential`, the LinkedIn share page, and the public certificate page with its not-found page; the maintenance page's own `<style>` block follows the same rules (its card `--r-l`).

---

## 5. Shadows

Generated per look and mode as Flat Design 3.0's three soft tiers, tinted by the look's `--shadow-rgb` (neutral black at night):

| Tier | Use | Day | Night |
|---|---|---|---|
| `--sh-1` | resting (cards, buttons) | `0 1px 2px` at 6 % | `0 1px 3px` at 12 % |
| `--sh-2` | raised (hover, a lifted card) | `0 4px 12px` 8 % + `0 1px 2px` 6 % | `0 4px 12px` 24 % + `0 1px 2px` 18 % |
| `--sh-3` | dialogs, sheets | `0 12px 32px` 14 % + `0 2px 6px` 8 % | `0 12px 32px` 40 % + `0 2px 6px` 22 % |

The legacy names are aliases: `--shadow-1` → `--sh-1`, `--shadow-2` → `--sh-2`, `--shadow-3` → `--sh-3`, `--shadow` → `--sh-1`. The standalone shells (`public/unsubscribe.css`, `public/verify-pages.css`, and the maintenance page's own `<style>` block) declare their own `--shadow-1` (and `--shadow-2` where used) for each mode at the tier values above, tinted `15 13 26` by day and black at night, and every shadow they draw is one of them (`tests/theme-tokens.spec.js`; the values per mode, the v6.10.7 arm of `tests/functional-core-b.api.spec.js`).

---

## 6. Motion

`--ease-out`, `--ease-spring`, `--ease-rise`, `--duration-fast/normal/slow` (150/250/400 ms). **Every transition takes its duration from a `--duration-*` token and its easing from an `--ease-*` token**, each item of a `transition` naming both (left out, they would be 0 s and the browser's `ease`), in `styles.css` and in the inline styles `public/js` writes (a hover change is `--duration-fast`, a 200 ms move `--duration-normal`); the rise curve is always `var(--ease-rise)`, never written out. The fixed timings outside the duration tokens, each on a token easing: the solved meter's fill 600 ms, the workspace's bar fills 700 ms (rise), the leaderboard row slide 360 ms (spring, inside the 400 ms timer that clears it). Keyframe animations name their own durations: entrance rise 600 ms (the ticker's new line, on the rise curve), the chart entrance 900 ms (rise), code cell pop 280 ms. Lock: `tests/css-token-sites.spec.js`. Buttons lift 1 px on hover (`--sh-1` → `--sh-2`) and settle flat on `:active` (never fade). `@media(prefers-reduced-motion:reduce)` kills every animation globally.

---

## 7. Components (shipped primitives)

- **Buttons** (`.btn`, the look's primary): a flat `--accent-strong` fill with `--sh-1`, lifting 1 px to `--sh-2` on hover and settling flat on `:active`. `.secondary` (surface + `--control` edge), `.danger/.warning/.success` (status fills with `--on-status`), `.gold` (a flat `--gold-strong` fill: the screen's one gold action), `.quiet`, `.lg` (54 px), `.block`, `.sm`.
- **Inputs**: `--surface` fill, `--control` boundary, `--r-m`, a flat 4 px focus halo (`rgb(var(--glow) / .18)`, no blur); disabled, the same fill with a dashed `--border-strong` edge and a `--muted` value and placeholder at full opacity.
- **Cards / dialogs**: `--r-l`, `--sh-1` (cards; Ambient raises them to `--sh-2`) / `--sh-3` (dialogs). On phones (≤ 600 px) every `.picker-overlay` dialog is a bottom sheet (top `--r-xl`, `92dvh`, safe-area padding). `#modal-overlay`, `overlayDismiss`, the focus trap and the z-index ladder are unchanged.
- **Header**: `--surface` bar; Ambient draws one solid 1 px accent hairline under it. The standalone pages opened from an email paint their header and footer `--surface` too, never a surface of their own. **No `backdrop-filter` or `transform` on the header or cards**: it would make them the containing block of the fixed phone nav and selection bar inside them. Its 32 px icon buttons (`.help-icon-btn`: the look picker, "?", What's new, and the help drawer's two) are 44 px targets through their own `::after`, 6 px beyond the border, and two side by side keep 12 px between them (lock: `tests/signed-out-header.spec.js`).
- **Tables**: every `th` is the eyebrow (12/16 600 tracked caps), sticky solid heads where a table scrolls. At ≤ 768 px every admin data table in a `.table-card` is one card per row with a label gutter (`td[data-label]`, `ui/table-cards.js`); its headings are hidden, not merely clipped (no tab stop), and Sort & filter reaches their menus. A table outside a `.table-card` (any `.table-wrap`, as Groups and the Event team section use; Live rankings, Analytics, the account-removals list) keeps its headings and scrolls inside its own box.
- **`.ha-steps`** step marks · **`.ha-ring`** countdown ring (`--p` 0..1) · **`.ha-seg`** segmented control (`aria-pressed`).
- **`.ha-code`** segmented code entry: ONE real input laid over eight painted cells (4 – 4), so paste, autofill, screen readers and tests see an ordinary text box; the cells mirror its value.
- **The sign-in card** (`.auth-solo .auth-card`): one card over the look's motif, the same for every entry point; Signature draws a solid violet bar across its top with the certificate's gold diamond, Ambient one solid line of its accent colour. It carries a tagline, a headline and one line — never invented numbers, and not the platform name (the header has it).
- **Medals** (podium, certificate cards, certificate wizard tiers, rankings): flat discs, `--gold-strong` / `--silver-strong` / `--bronze-strong` with their measured labels. A leaderboard row's medal icon is the metal ink (`--gold` / `--silver` / `--bronze`), with the place's number beside it.
- **Filter chips** (`.filter-btn`): an unselected chip is a `--surface` pill with a `--border` edge and `--muted` text. A selected one is filled with `--accent-strong` and has `--on-accent` text and a matching edge (`--accent-hover` on hover), so it reads as pressed. An applied-filter chip beside the Filters button (`.filter-chip`) is the calm one: an `--accent-soft` tint with an `--accent-strong` edge. An empty table row says why it is empty and, when a filter hides everything, offers the way out ("Show all events").
- **Disabled controls never fade**: `.btn:disabled` is a `--surface-3` well with `--muted` text at full opacity (AA), overriding the global `:disabled{opacity:.5}`. A script sets only the `disabled` property: an inline opacity would out-rank the rule (lock: `tests/assign-dialog-save-state.spec.js`). A page bar's buttons and its Go to page box keep their own fill and show that they do not apply with a dashed `--border-strong` edge and `--muted` text (lock: `tests/css-token-sites.spec.js` 1l). Every disabled field (text-like input, select, textarea, file and colour inputs) and the locked Schedule switch do the same (the switch's chosen option on `--surface-3` with `--text-2`); a native checkbox's or radio's box alone keeps the browser-and-global fade, its label at full strength (lock: `tests/css-token-sites.spec.js` 2d).
- **A read-only rich text editor's toolbar is off, not faded**: every control `disabled` at full opacity with a `--muted` glyph (the inline-coloured Text colour, Highlight and link glyphs too), the editor's and the toolbar's edges dashed, the reason on its own `--muted` line under the buttons, the body's text `--muted` with no placeholder (lock: `tests/richtext-readonly-toolbar.spec.js`).
- **The look picker** (`features/look-picker.js`) and the Appearance page (`features/appearance.js`): two look cards with live day/night mini previews, the mode, Ambient's colour swatches.

### 7a. Per-look rules

A per-look rule changes colour and corner-radius tokens only, and keys on the element that carries the look (`[data-look="ambient"] .x`, `.lp-mini[data-look="x"] …`). The section is "LOOK CONSTRUCTION" in `public/styles.css`. What each look adds:

- **Signature** — the sign-in card's violet bar with a gold diamond; a gold ring on the account button.
- **Ambient** — a solid accent hairline under the header and the challenge play bar; raised cards (`--sh-2`); an accent ring on the account button; the active participant tab in accent ink.

---

## 8. Breakpoints

| px | purpose |
|---|---|
| 480 | narrow phone portrait |
| 520 / 560 | compact rows and pickers |
| 600 | "small" — form reflow, single column, dialogs become sheets |
| 640 | two-column panels fold |
| 760 / 768 | "medium" — header compaction; admin tables become cards; the section bar and the workspace's section sheet |
| 900 (and `min-width: 900px`) | analytics reflow; the sign-in split stacks |
| 1100 / 1280 / 1400 | wide workspace and dashboard grids |
| `max-height: 450px` | short-viewport footer collapse |

---

## 9. Accessibility invariants

1. Every text pair hits **WCAG AA 4.5:1** (3:1 for large text and control boundaries) **in both looks, day and night, with every Ambient colour**: the generator measures the palette; `tests/interactive-contrast.spec.js` measures every hover/focus colour rule in every combination; `tests/dark-theme-a11y.spec.js` runs axe on the app at night and on the sign-in screen in every look.
2. Every interactive control has a `:focus-visible` outline (`2px solid var(--focus)`, offset 2–3 px).
3. Every dialog closes through `overlayDismiss(overlay, fn)`, and a press on its backdrop never closes it. Two named exceptions close on a press outside them, because a menu and a search lose nothing: the account menu and the command palette (operator ruling, 14 Nov 2026).
4. Every form input has a `<label for>` or `aria-label`; error text via `aria-describedby`.
5. Every icon-only button has an `aria-label`; a control that shows words is named starting with those words (WCAG 2.5.3).
6. Every `<table>` header cell has `scope`.
7. Respect `prefers-reduced-motion`.
8. Forced colours: no `background-clip:text` without a solid fallback.

---

## 10. Anti-patterns (do not introduce)

- **Skeuomorphic construction**: a bezel, brushed metal, an LCD well, glass, inset key lighting, a blurred glow, a hand-written blurred shadow (every blurred `box-shadow` layer is `--sh-1/2/3`, or in a standalone shell its own `--shadow-1/2`; a flat ring or edge with no blur is fine), `backdrop-filter`, or a `filter` blur or drop-shadow. **A smooth gradient** anywhere except the ones main kept — the countdown text and the loading shimmer — and data graphics (the time ring, progress rings, the gauge); none in a standalone shell. `tests/theme-tokens.spec.js` ("Flat Design 3.0", over `styles.css` and the standalone shells) scans for all of these against a reasoned allow-list.
- **`opacity` on any surface that contains TEXT** — it composites the text below AA, and axe misses it. Dim with a dashed edge and a muted token. A control's glyph is dimmed the same way, by its colour token: the search glyph and a menu item's icon idle as solid `--muted` (a danger or warning item's icon keeps its status ink). No `svg` or `::before`/`::after` takes an opacity between 0 and 1, nor does any other rule in the stylesheets (keyframe stops aside) or style attribute in the shell's markup unless it is a recorded decision with its reason (lock: `tests/css-token-sites.spec.js` 2b, 2c), and no script writes one, through any expression (lock: `tests/js-opacity-scan.js`, run by `tests/functional-core-b.api.spec.js`).
- **`color-mix()`**, `@import`, `oklch()`-only colours, a hex colour outside `scripts/theme/looks.js`, a literal colour standing in for the accent (an accent tint is `rgb(var(--glow) / a)`), or a hand-edited generated token block.
- **A colour tuned to one mode**: a colour literal in a `[data-theme]` rule, or a translucent white or black overlay (invisible on the other mode's surfaces), in the stylesheet or an inline style. A hover is the `--surface-3` well, an edge `--border`/`--border-strong`, a ring a token (lock: `tests/css-token-sites.spec.js` 5, with its reviewed exceptions).
- **A literal transition duration or easing** (`.2s`, `ease`, a `cubic-bezier()`): §6.
- **A per-look descendant rule that can reach a nested preview** (`[data-look="x"] .y` inside a different preview), or a per-look night rule on a bare `:root[data-theme="dark"]`.
- **`backdrop-filter` / `transform` on an ancestor of a phone-fixed element.**
- **Undefined custom properties** — a `var()` naming nothing voids the declaration silently. Check the token exists.
- **Hardcoded hex in inline styles emitted from `public/js/**`** (a canvas or generated SVG that must not flip is the exception; say so).
- **A search input as a CHILD of the container its own handler re-renders.**
- **A `100vh` with no `100dvh` beside it.**
- **Backdrop-click-to-close on dialogs.**
- **A second family, a served proprietary face, or a literal font-family / font-size / font-weight** outside the type-token block (§2). A new open face needs an operator decision, its licence and its latin-ext subset.
- **A look that differs by construction or font.** Looks differ by colour and corner radii (§7a).
- **A literal corner radius on the ladder** (8px, 4px, 999px and every other rung), in `styles.css` or a `public/js/**` inline style: it does not follow the look (§4, `tests/radius-tokens.spec.js`).
- **Adding a build step for the app.** The token generator is a dev-time script whose output is committed; CSS minification runs at server boot.
