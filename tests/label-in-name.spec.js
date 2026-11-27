// @ts-check
//
// WCAG 2.5.3 LABEL IN NAME — a control that shows text is named WITH that text,
// and on this platform the name OPENS with it, then says what a press does:
// "Export CSV of this leaderboard", "Remove anyway — Checkmarx One account jdoe",
// "alice_s — show in the Participants tab". A speech-input user says what they
// read; a name that splits or omits the visible words is a button their voice
// cannot reach, and a screen-reader user hears something the screen does not say.
//
// axe-core 4.14 switched `label-content-name-mismatch` on, and it was broken on
// every picker and challenge card, the header's profile and verify chips, the
// rankings Export CSV buttons, the Join Link dialog's Copy code, the Checkmarx One
// removal buttons, the event badges, the scope switcher and three rich-text
// toolbar buttons. Only the six specs whose own scans happened to include one of
// those went red; the rest had never been scanned for it. So this file is the
// family's own guard, in two halves that each see what the other cannot:
//
//   1. SOURCE — every control written in public/index.html or public/js that names
//      itself with an aria-label must contain the words it shows, by axe's own
//      token rule. It reaches every site, including dialogs and states no browser
//      test builds, and it is TAUGHT the codebase's idioms (a same-file const,
//      ternary or one-line function supplying the name; `+`-joined literals;
//      attributes spliced in from a variable) so that it judges them instead of
//      skipping them. Containment, not "opens with": that is the WCAG requirement
//      and what axe measures, so the scanner cannot fail working code (the logs
//      pager's "−10", named "Back 10 pages", is a symbol for words it contains).
//   2. BROWSER — the screens a participant and an organiser meet, scanned WHOLE
//      with the rule on, plus the house rule axe does not check (the name OPENS
//      with the visible text), plus what no source scan can see: the rich-text
//      toolbar is built by DOM calls, and its glyphs must not be DOM text at all.
//
// Each half carries planted controls, so a checker that silently stopped looking
// — a renamed attribute, an axe release that drops the rule — fails here.

const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const fs = require("fs");
const path = require("path");
const { apiLogin, BASE, PARTICIPANT_PASS } = require("./helpers");
const { adminLogin, loginViaApi, clickTab, viewComp, AxeBuilder } = require("./ui-admin-helpers");
const { stripJsComments } = require("./doc-registry");

const ROOT = path.resolve(__dirname, "..");
const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const RULE = "label-content-name-mismatch";

test.use({ baseURL: BASE, viewport: { width: 1280, height: 900 } });

// ═══════════════════════════════════════════════════════════════════════════════
// 1. THE SOURCE SCANNER
// ═══════════════════════════════════════════════════════════════════════════════

// Widget roles whose name can come from content — the roles axe's rule applies to.
const WIDGET_ROLES = new Set(["button", "link", "tab", "checkbox", "radio", "switch", "menuitem",
  "menuitemcheckbox", "menuitemradio", "option", "treeitem"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", minus: "−", rarr: "→",
  times: "×", bull: "•", nbsp: " ", hellip: "…", middot: "·", mdash: "—" };
const decode = (s) => s.replace(/&(#\d+|[a-z]+);/gi, (_, e) =>
  e[0] === "#" ? String.fromCodePoint(+e.slice(1)) : (ENTITIES[e.toLowerCase()] ?? " "));
// axe-core 4.14 `curateTokens`: NFKD, parentheticals dropped, anything that is not
// a letter or a digit is a separator.
function words(s) {
  let t = decode(s).normalize("NFKD"), prev;
  do { prev = t; t = t.replace(/\([^()]*\)/g, ""); } while (t !== prev);
  return t.replace(/[^\p{L}\p{N}]+/gu, " ").toLowerCase().trim().split(/\s+/).filter(Boolean);
}
// axe `isHumanInterpretable`: a lone non-digit character, "aa"/"abc", or text with
// no letter or digit is a SYMBOL (⋮, ×, ?, ☆), and the rule does not apply to it.
function interpretable(s) {
  const v = decode(s).replace(/\s+/g, " ").trim();
  return !!v && !(v.length === 1 && /\D/.test(v)) && !/^(aa|abc)$/i.test(v) && /[\p{L}\p{N}]/u.test(v);
}
// Expressions that render markup with no text: the icon registry and the avatar.
const NON_TEXT_EXPR = /^(ICO(\.|\[)|\w*_SVG$|avatarHtml\()/;
const HOLE = "⟦";   // marks an expression the scanner cannot read through
const normExpr = (e) => e.replace(/\s+/g, "").replace(/^esc\((.*)\)$/, "$1")
  .replace(/^String\((.*?)(\|\|''|\|\|"")?\)$/, "$1");

// The end of an opening tag, skipping quoted values and ${…} (either may hold `>`).
function tagEnd(src, i) {
  let depth = 0, q = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (depth) { if (c === "{") depth++; else if (c === "}") depth--; continue; }
    if (q) { if (c === q) q = null; else if (c === "$" && src[j + 1] === "{") { depth++; j++; } continue; }
    if (c === "\"" || c === "'") q = c;
    else if (c === "$" && src[j + 1] === "{") { depth++; j++; }
    else if (c === ">") return j;
  }
  return -1;
}
// Markup out, text in: each tag — whose attributes may hold ${…} — becomes a space.
function stripTags(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "<" && /[A-Za-z/!]/.test(s[i + 1] || "")) {
      const e = tagEnd(s, i + 1);
      if (e > 0) { out += " "; i = e; continue; }
    }
    out += s[i];
  }
  return out;
}
// A template body as literal and ${hole} parts, braces balanced.
function parts(s) {
  const out = []; let lit = "", depth = 0, start = -1;
  for (let i = 0; i < s.length; i++) {
    if (!depth && s[i] === "$" && s[i + 1] === "{") { out.push({ lit }); lit = ""; depth = 1; start = i + 2; i++; continue; }
    if (depth) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}" && !--depth) out.push({ expr: s.slice(start, i).trim() });
      continue;
    }
    lit += s[i];
  }
  out.push({ lit });
  return out;
}
// The top-level `c ? a : b` of an expression, or null.
function splitTernary(e) {
  let depth = 0, q = null, qi = -1, ci = -1;
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === "'" || c === "\"" || c === "`") { q = c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (!depth && c === "?" && qi < 0 && e[i + 1] !== "." && e[i + 1] !== "?") qi = i;
    else if (!depth && c === ":" && qi >= 0) { ci = i; break; }
  }
  return qi > 0 && ci > qi ? [e.slice(qi + 1, ci).trim(), e.slice(ci + 1).trim()] : null;
}
// Every text an expression can produce, as template bodies; null when opaque.
// Resolves the idioms the SPA builds names with: a string or template literal, a
// ternary of them, `esc(…)`/`String(…)` (no change to the words), and a same-file
// `const x = …;` or `function f(…){ return …; }`.
function variants(expr, src, seen = new Set()) {
  const e = expr.trim();
  if (NON_TEXT_EXPR.test(e)) return [""];
  const wrapped = /^(?:esc|String)\(([\s\S]*)\)$/.exec(e);
  if (wrapped) return variants(wrapped[1].replace(/\|\|(''|"")$/, ""), src, seen);
  const lit = /^(['"])([\s\S]*)\1$/.exec(e);
  if (lit) return [lit[2].replace(/\$\{/g, "$​{")];
  const tpl = /^`([\s\S]*)`$/.exec(e);
  if (tpl) return [tpl[1]];
  const t = splitTernary(e);
  if (t) return [t[0], t[1]].flatMap((x) => variants(x, src, seen) || [`\${${x}}`]);
  const id = /^([A-Za-z_$][\w$]*)(\(.*\))?$/.exec(e);
  if (id && !seen.has(id[1])) {
    seen.add(id[1]);
    const name = id[1].replace(/\$/g, "\\$");
    const def = id[2]
      ? new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{\\s*return\\s+([^;]+);\\s*\\}`).exec(src)
      : new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*([^;]+);`).exec(src);
    if (def) return variants(def[1], src, seen);
  }
  return null;
}
// Every word sequence a template body can produce (capped); an opaque hole is one
// word of its own, ⟦expr⟧, which only the SAME expression in the name can match.
function sequences(body, src, depth = 0) {
  let seqs = [[]];
  for (const p of parts(stripTags(body))) {
    let add;
    if (p.lit !== undefined) add = [words(p.lit)];
    else {
      const v = depth < 4 ? variants(p.expr, src) : null;
      add = v ? v.flatMap((b) => sequences(b, src, depth + 1)) : [[`${HOLE}${normExpr(p.expr)}`]];
    }
    seqs = seqs.flatMap((s) => add.map((a) => [...s, ...a])).slice(0, 64);
  }
  return seqs;
}
function contains(hay, needle) {
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((w, j) => w === hay[i + j])) return true;
  return false;
}
/** Markup built by `+`-joining literals reads as one literal. */
const joinLiterals = (src) => src.replace(/`\s*\+\s*`/g, "").replace(/'\s*\+\s*'/g, "").replace(/"\s*\+\s*"/g, "");
/** Every control in `src` that names itself with an aria-label, with its content. */
function labelledControls(src) {
  const out = []; const re = /<([a-zA-Z][\w-]*)\b/g; let m;
  while ((m = re.exec(src))) {
    const end = tagEnd(src, m.index + 1);
    if (end < 0) continue;
    let opens = [src.slice(m.index, end + 1)];
    // Attributes spliced in from a variable (`<span … ${clickAttrs}>`): one control
    // per value the variable can take.
    if (!/\saria-label=/.test(opens[0])) {
      const spliced = [...opens[0].matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)]
        .map((h) => ({ h, vs: variants(h[1], src) }))
        .find(({ vs }) => vs && vs.some((v) => /aria-label=/.test(v)));
      if (!spliced) continue;
      opens = spliced.vs.map((v) => opens[0].replace(spliced.h[0], v));
    }
    const tag = m[1].toLowerCase();
    for (const open of opens) {
      const lab = /\saria-label=(?:"([^"]*)"|'([^']*)')/.exec(open);
      if (!lab) continue;
      const role = (/\srole="([\w-]+)"/.exec(open) || [])[1]
        || (tag === "button" ? "button" : tag === "a" && /\shref=/.test(open) ? "link" : "");
      if (!WIDGET_ROLES.has(role)) continue;
      const close = src.indexOf(`</${tag}>`, end);
      if (close < 0) continue;
      out.push({ open: open.replace(/\s+/g, " ").slice(0, 140), label: lab[1] ?? lab[2], inner: src.slice(end + 1, close) });
    }
  }
  return out;
}
/** "ok", "symbol" (it shows no words — an icon or a glyph) or "mismatch". */
function judge(ctl, src) {
  const shown = sequences(ctl.inner, src).filter((s) => s.length);
  const hasHole = (s) => s.some((w) => w.startsWith(HOLE));
  const wordy = shown.filter((s) => hasHole(s) || interpretable(s.join(" ")));
  if (!wordy.length) return "symbol";
  const names = sequences(ctl.label, src);
  return wordy.every((v) => names.some((n) => contains(n, v))) ? "ok" : "mismatch";
}
/** Scan the SPA's markup; returns every control with its verdict. */
function scanSources() {
  const files = [path.join(ROOT, "public", "index.html")];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) files.push(p);
    }
  })(path.join(ROOT, "public", "js"));
  const out = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, "utf8");
    const src = joinLiterals(f.endsWith(".html") ? raw.replace(/<!--[\s\S]*?-->/g, " ") : stripJsComments(raw));
    for (const c of labelledControls(src)) out.push({ file: path.relative(ROOT, f), ...c, verdict: judge(c, src) });
  }
  return out;
}

test.describe("WCAG 2.5.3 — SOURCE: a control's aria-label contains the words it shows", () => {
  test("every labelled control in public/index.html and public/js passes axe's token rule", () => {
    const all = scanSources();
    const bad = all.filter((c) => c.verdict === "mismatch")
      .map((c) => `${c.file}: ${c.open}\n      name:  ${c.label}\n      shows: ${c.inner.replace(/\s+/g, " ").trim().slice(0, 120)}`);
    expect(bad, "a control's name must CONTAIN the words it shows (and, house rule, open with them):\n  "
      + bad.join("\n  ")).toEqual([]);
    // ANTI-VACUITY — the scanner still finds and decides the controls it was
    // written against (counted at authoring: 56 decided, 21 icon/symbol). A
    // renamed attribute or a broken tag walker drops these to zero and passes
    // the empty assertion above.
    const decided = all.filter((c) => c.verdict === "ok").length;
    const symbols = all.filter((c) => c.verdict === "symbol").length;
    expect(decided, "labelled controls with visible words that the scanner judged").toBeGreaterThanOrEqual(50);
    expect(symbols, "icon-only and glyph controls the scanner recognised as such").toBeGreaterThanOrEqual(15);
    // …and the hard cases are among them, so the idioms stay taught: a name from
    // a same-file const (the cards), from a ternary const (Export CSV), from a
    // one-line function (the verify chip), and attributes spliced from a variable
    // (the participants list's event badge).
    const decidedOn = (file, re) => all.some((c) => c.file === file && c.verdict === "ok" && re.test(c.open));
    expect(decidedOn("public/js/features/participant-tasks.js", /class="card-open"/), "task card").toBe(true);
    expect(decidedOn("public/js/features/rankings-admin.js", /rk-export-btn/), "Export CSV").toBe(true);
    expect(decidedOn("public/js/ui/nav.js", /verify-indicator/), "verify chip").toBe(true);
    expect(decidedOn("public/js/features/participants-admin.js", /comp-focus/), "spliced badge").toBe(true);
  });

  test("the scanner's own controls: it fails what axe fails and passes what axe passes", () => {
    const verdict = (snippet) => {
      const src = joinLiterals(snippet);
      const ctl = labelledControls(src);
      expect(ctl.length, `the planted control was found: ${snippet}`).toBe(1);
      return judge(ctl[0], src);
    };
    // The shapes v8.13.x shipped, each one refused by axe 4.14.
    expect(verdict(`<button aria-label="Export this leaderboard to CSV">Export CSV</button>`)).toBe("mismatch");
    expect(verdict("const x=`<button aria-label=\"Remove Checkmarx One account ${esc(a)} anyway\">Remove anyway</button>`;")).toBe("mismatch");
    expect(verdict("const x=`<span role=\"button\" aria-label=\"Edit profile\">${avatarHtml(u,32)} <span>${esc(u.nickname)}</span></span>`;")).toBe("mismatch");
    expect(verdict("const name=label?`Export ${esc(label)} to CSV`:'Export this leaderboard to CSV';\n"
      + "const b=`<button aria-label=\"${name}\">Export CSV</button>`;")).toBe("mismatch");
    // …and their fixes, plus what must never be flagged.
    expect(verdict(`<button aria-label="Export CSV of this leaderboard">Export CSV</button>`)).toBe("ok");
    expect(verdict("const name=label?`Export CSV of ${esc(label)}`:'Export CSV of this leaderboard';\n"
      + "const b=`<button aria-label=\"${name}\">Export CSV</button>`;")).toBe("ok");
    expect(verdict("const x=`<span role=\"button\" aria-label=\"${esc(u.nickname)} — edit profile\">${avatarHtml(u,32)} <span>${esc(u.nickname)}</span></span>`;")).toBe("ok");
    expect(verdict(`<button aria-label="Download QR (PNG) — high-resolution image">Download QR (PNG)</button>`)).toBe("ok");
    expect(verdict(`<button aria-label="Back 10 pages">&minus;10</button>`)).toBe("ok");
    expect(verdict("const x=`<button aria-label=\"More actions\">⋮</button>`;")).toBe("symbol");
    expect(verdict("const x=`<button aria-label=\"Show password\">${ICO.eye}</button>`;")).toBe("symbol");
    // A plain <span> is no control, so its label is not this rule's business.
    expect(labelledControls(`<span aria-label="not set">—</span>`)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. THE BROWSER ARMS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * In the page: every widget-role element with an explicit name and visible words,
 * and whether the name OPENS with those words (axe only asks that it contain
 * them). Visible = rendered text nodes, not sr-only, joined the way axe joins them.
 */
function auditInPage(rootSel) {
  const root = rootSel ? document.querySelector(rootSel) : document.body;
  if (!root) return { error: `no ${rootSel}` };
  const ROLES = /^(button|link|tab|checkbox|radio|switch|menuitem|menuitemcheckbox|menuitemradio|option|treeitem)$/;
  const implicit = (el) => {
    const t = el.tagName;
    if (t === "BUTTON" || t === "SUMMARY") return "button";
    if (t === "A" && el.hasAttribute("href")) return "link";
    return "";
  };
  const toks = (s) => {
    let t = (s || "").normalize("NFKD"), prev;
    do { prev = t; t = t.replace(/\([^()]*\)/g, ""); } while (t !== prev);
    return t.replace(/[^\p{L}\p{N}]+/gu, " ").toLowerCase().trim().split(/\s+/).filter(Boolean);
  };
  const symbolic = (v) => (v.length === 1 && /\D/.test(v)) || /^(aa|abc)$/i.test(v) || !/[\p{L}\p{N}]/u.test(v)
    // a signed page jump ("−10", "+10") is a symbol for the words its name spells
    || /^[−+-]\d+$/.test(v);
  const shown = (el) => {
    let out = "";
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) {
          const p = c.parentElement;
          if (p.closest(".sr-only")) continue;
          const r = p.getBoundingClientRect();
          if (r.width <= 1 || r.height <= 1 || getComputedStyle(p).visibility === "hidden") continue;
          out += c.nodeValue;
        } else if (c.nodeType === 1 && getComputedStyle(c).display !== "none") walk(c);
      }
    })(el);
    return out.replace(/\s+/g, " ").trim();
  };
  const nameOf = (el) => el.hasAttribute("aria-labelledby")
    ? el.getAttribute("aria-labelledby").split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ")
    : el.getAttribute("aria-label") || "";
  const checked = [], bad = [];
  for (const el of root.querySelectorAll("[aria-label],[aria-labelledby]")) {
    const role = (el.getAttribute("role") || "").split(/\s+/)[0] || implicit(el);
    if (!ROLES.test(role)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const vis = shown(el);
    if (!vis || symbolic(vis)) continue;
    const v = toks(vis), n = toks(nameOf(el));
    const opens = v.length > 0 && v.every((w, i) => w === n[i]);
    const desc = `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className || "").trim().split(/\s+/).join(".")}`;
    checked.push(desc);
    if (!opens) bad.push(`${desc}  shows "${vis}"  named "${nameOf(el)}"`);
  }
  return { checked, bad };
}

/** Both checks over `rootSel` (whole page when omitted); returns what was checked. */
async function expectLabelInName(page, where, rootSel) {
  const a = await page.evaluate(auditInPage, rootSel || null);
  expect(a.error, `${where}: audit root`).toBeUndefined();
  expect(a.bad, `${where}: a control's accessible name must OPEN with the words it shows (WCAG 2.5.3):\n  `
    + a.bad.join("\n  ")).toEqual([]);
  let axe = new AxeBuilder({ page }).withRules([RULE]);
  if (rootSel) axe = axe.include(rootSel);
  const res = await axe.analyze();
  const nodes = res.violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(" ")}  ${n.html.slice(0, 160)}`));
  expect(nodes, `${where}: axe ${RULE}:\n  ${nodes.join("\n  ")}`).toEqual([]);
  return a.checked;
}

/**
 * The PLANTED control, on a real page: a button whose name drops the words it
 * shows must be caught by BOTH checkers. Without it, an axe release that turns the
 * rule off by default, or an audit that stopped matching anything, would leave
 * every assertion in this file green.
 */
async function expectCheckersBite(page) {
  await page.evaluate(() => {
    const b = document.createElement("button");
    b.id = "lin-planted"; b.type = "button"; b.textContent = "Pick me"; b.setAttribute("aria-label", "Open the event");
    document.body.appendChild(b);
  });
  try {
    const a = await page.evaluate(auditInPage, null);
    expect(a.bad.some((s) => s.startsWith("button#lin-planted")), "the in-page audit flags the planted button").toBe(true);
    const res = await new AxeBuilder({ page }).withRules([RULE]).include("#lin-planted").analyze();
    expect(res.violations.map((v) => v.id), `axe still runs ${RULE} and flags the planted button`).toEqual([RULE]);
  } finally {
    await page.evaluate(() => document.getElementById("lin-planted")?.remove());
  }
}

test.describe("WCAG 2.5.3 — BROWSER: the screens people meet name their controls by what they show", () => {
  const TAG = `lin${Date.now().toString(36)}`;
  const F = {};

  test.beforeAll(async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const now = Date.now();
      const comp = async (name, startMs, extra = {}) => {
        const r = await api.post("/api/admin/competitions", { headers: H(csrf),
          data: { name, start_time: new Date(startMs).toISOString(), duration_minutes: 240, ...extra } });
        expect(r.ok(), `create ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
        return (await r.json()).competition;
      };
      // A — live, with two challenges, one carrying two categories (the ribbons
      //     that used to sit inside a role=button card) and a dry-run tag (its
      //     badge is one of the card's visible words).
      // B — upcoming, so the participant has a choice and the picker renders
      //     (one event would land them inside it — checklist item 10).
      // C — two upcoming SESSIONS, for the session picker and the scope banner's
      //     session chips and switcher.
      F.A = await comp(`LinA ${TAG}`, now - 30 * 60_000);
      F.B = await comp(`LinB ${TAG}`, now + 3 * 3600_000);
      F.C = await comp(`LinC ${TAG}`, now + 2 * 3600_000);
      for (const [name, offH] of [["Morning", 2], ["Evening", 6]]) {
        const r = await api.post(`/api/admin/competitions/${F.C.id}/timeslots`, { headers: H(csrf),
          data: { name: `${name} ${TAG}`, start_time: new Date(now + offH * 3600_000).toISOString(), duration_minutes: 60 } });
        expect(r.ok(), `session ${name}: ${r.status()} ${await r.text()}`).toBeTruthy();
      }
      F.tasks = [];
      for (const [title, tags] of [[`LinTask web ${TAG}`, ["category:web", "category:crypto"]], [`LinTask plain ${TAG}`, []]]) {
        const r = await api.post("/api/admin/tasks", { headers: H(csrf), data: {
          title, description: `<p>About ${title}</p>`, difficulty: "easy", answer_type: "text",
          correct_answer: "x", status: "published" } });
        expect(r.ok(), `task ${title}: ${r.status()}`).toBeTruthy();
        const id = (await r.json()).id;
        for (const tag of tags) {
          expect((await api.post(`/api/admin/tasks/${id}/tags`, { headers: H(csrf), data: { tag } })).ok(), `tag ${tag}`).toBeTruthy();
        }
        const a = await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [F.A.id] } });
        expect(a.ok(), `assign ${title}: ${a.status()}`).toBeTruthy();
        F.tasks.push({ id, title });
      }
      // The participant — owned, complete, verified and approved (items 3, 7, 13).
      F.email = `${TAG}@company.example`;
      const reg = await registerPost(api, "/api/register", { headers: H(csrf), data: {
        firstName: "Lin", lastName: "Probe", nickname: TAG, email: F.email, company: "Acme", title: "Engineer",
        country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS,
        jobFunction: "Software Developer / Engineer", city: "Testville" } });
      expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
      const u = ((await (await api.get("/api/admin/participants?limit=5000")).json()).participants || [])
        .find((p) => p.email === F.email);
      expect(u, "participant findable").toBeTruthy();
      expect((await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) })).ok()).toBeTruthy();
      expect((await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) })).ok()).toBeTruthy();
      const asg = await api.post("/api/admin/competitions/assign", { headers: H(csrf),
        data: { userIds: [u.id], competitionIds: [F.A.id, F.B.id, F.C.id] } });
      expect((await asg.json()).assigned, "enrolled in all three events").toBe(3);
    } finally { await api.dispose(); }
  });

  async function select(page, compId) {
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const r = await page.request.post("/api/select-competition", { headers: H(csrfToken), data: { competitionId: compId } });
    expect(r.ok(), `select-competition: ${r.status()} ${await r.text()}`).toBeTruthy();
  }

  test("participant: the picker, the session picker, the challenge grid and the header", async ({ page }) => {
    await loginViaApi(page, F.email, PARTICIPANT_PASS);
    await page.goto("/");
    // THE PICKER. Each card's control is its event name, named "<name>, <status>…".
    const pick = page.locator(`#comp-grid .comp-card[data-comp-id="${F.A.id}"] .card-open`);
    await expect(pick).toBeVisible({ timeout: 20000 });
    await expect(page.locator(`#comp-grid .comp-card[data-comp-id="${F.B.id}"] .card-open`)).toBeVisible();
    expect(await page.locator("#comp-grid .comp-card[role]").count(), "a card is no longer a role=button wrapper").toBe(0);
    await expect(pick).toHaveAttribute("aria-label", new RegExp(`^LinA ${TAG}, live`));
    await expectCheckersBite(page);
    const onPicker = await expectLabelInName(page, "event picker");
    // The header's account button is on this page — its face is decorative and
    // it is named by its own text — and so are the cards.
    expect(onPicker.filter((d) => d.includes("card-open")).length, "the picker's card controls were checked").toBeGreaterThanOrEqual(3);
    await expect(page.locator("#profile-menu-btn")).toHaveAccessibleName(/^Account menu for /);

    // THE SESSION PICKER.
    await select(page, F.C.id);
    await page.goto("/");
    const slot = page.locator("#timeslot-picker-content .comp-card .card-open").first();
    await expect(slot).toBeVisible({ timeout: 20000 });
    await expect(slot).toHaveAttribute("aria-label", new RegExp(`^(Morning|Evening) ${TAG}, upcoming — choose this session$`));
    const onSessions = await expectLabelInName(page, "session picker");
    expect(onSessions.filter((d) => d.includes("card-open")).length, "both session controls were checked").toBe(2);

    // THE CHALLENGE GRID.
    await select(page, F.A.id);
    await page.goto("/");
    await page.locator(".nav-btn:not([aria-disabled=true]):has-text('Challenges')").first().click({ timeout: 20000 });
    const card = page.locator("#task-grid .task-card", { hasText: F.tasks[0].title });
    await expect(card).toBeVisible({ timeout: 20000 });
    const open = card.locator(".card-open");
    await expect(open).toHaveAttribute("aria-label",
      `${F.tasks[0].title}, easy, unsolved, still open, categories crypto, web`);
    // The ribbon list is real list semantics now — no longer the presentational
    // child of a button.
    expect(await card.locator(".cat-ribbons").evaluate((el) => !el.closest("[role='button'],button")),
      "the category list is outside every button").toBe(true);
    const onGrid = await expectLabelInName(page, "challenge grid");
    expect(onGrid.filter((d) => d.includes("card-open")).length, "both challenge controls were checked").toBe(2);
    // Keyboard: Tab reaches the title button and Enter opens the challenge.
    await open.focus();
    await page.keyboard.press("Enter");
    await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 15000 });
    await expect(page.locator("#task-detail-card .qa-title")).toHaveText(F.tasks[0].title);
  });

  test("organiser: rankings, the scope banner and switcher, the challenge list and the editor toolbar", async ({ page }) => {
    await adminLogin(page);
    // RANKINGS — all-live view: each live event's card title button, and the
    // Export CSV buttons.
    await clickTab(page, "Rankings");
    const view = page.locator(`#admin-rankings-tab .rankings-card-view[data-comp-id="${F.A.id}"]`);
    await expect(view).toBeVisible({ timeout: 20000 });
    await expect(view).toHaveAttribute("aria-label", `LinA ${TAG} — view these rankings`);
    await expectCheckersBite(page);
    await expectLabelInName(page, "rankings (all live)");
    const exp = page.locator("#admin-rankings-tab .rk-export-btn").first();
    await expect(exp, "an Export CSV button is on the page").toBeAttached();
    expect(await exp.getAttribute("aria-label"), "Export CSV is named by what it says").toMatch(/^Export CSV of /);

    // THE WORKSPACE (the two-session event): its status strip, record header
    // and section tabs.
    await clickTab(page, "Events");
    await viewComp(page, F.C.name);
    const banner = page.locator("#admin-scope-banner");
    await expect(banner.locator('[data-action="comp-focus-ts"]')).toHaveCount(2, { timeout: 15000 });
    const chips = await expectLabelInName(page, "workspace status strip", "#admin-scope-banner");
    expect(chips.length, "the strip's session chips and All events were checked").toBeGreaterThanOrEqual(3);
    const head = await expectLabelInName(page, "workspace header", "#admin-workspace");
    expect(head.length, "the workspace's record header, join card and section tabs were checked").toBeGreaterThanOrEqual(4);
    // The session rows and cards live on the Overview section, below the header
    // (#ws-overview), once its body has painted.
    await page.locator('#ws-tabs [data-section="admin-event-overview-tab"]').first().evaluate((el) => el.click());
    await expect(page.locator('#ws-overview .ws-grid.ws-cc-face'), "the Overview's cards painted").toBeVisible({ timeout: 15000 });
    // What it checks is that no labelled control on the Overview (session rows,
    // cards) drops the words it shows. The precondition above keeps it from
    // auditing an empty pane.
    await expectLabelInName(page, "workspace overview", "#ws-overview");

    // THE CHALLENGE LIST — the event badges show "<event> #<number>".
    await clickTab(page, "Challenges");
    const badge = page.locator(`#admin-tasks-tab [data-action="comp-focus"][data-comp-id="${F.A.id}"]`).first();
    await expect(badge).toBeVisible({ timeout: 20000 });
    await expectLabelInName(page, "challenge list");

    // THE EDITOR TOOLBAR — built by DOM calls, so no source scan sees it. Its
    // glyphs are icons, painted from data-glyph: no button may hold DOM text,
    // every one has a name, and the glyphs really are painted (a CSS rule that
    // lost `.rt-glyph::before` would leave a row of blank buttons).
    await page.locator('#admin-tasks-tab [data-action="open-task-form"]').first().click();
    const bar = page.locator("#tf-desc .rich-toolbar");
    await expect(bar).toBeVisible({ timeout: 15000 });
    // v8.17.0 — the rarely used commands sit in the bar's "More" group; open it
    // so every button is rendered, and read every button at any depth.
    await bar.locator(".rt-more-btn").click();
    await expect(bar.locator("button[aria-label='Highlight']")).toBeVisible();
    const tb = await bar.evaluate((el) => [...el.querySelectorAll("button")].map((b) => ({
      name: b.getAttribute("aria-label"),
      text: b.textContent.trim(),
      painted: [...b.querySelectorAll(".rt-glyph")].map((g) => getComputedStyle(g, "::before").content).join(""),
      icon: !!b.querySelector("svg"),
    })));
    expect(tb.length, "the toolbar's buttons were found").toBeGreaterThanOrEqual(15);
    for (const b of tb) {
      expect(b.name, "every toolbar button is named").toBeTruthy();
      expect(b.text, `${b.name}: a glyph is an icon, not DOM text the name would have to contain`).toBe("");
      expect(b.icon || /[^"\s]/.test(b.painted.replace(/^"|"$/g, "")), `${b.name}: its glyph is painted`).toBe(true);
    }
    expect(tb.find((b) => b.name === "Highlight")?.painted, "the Highlight glyph").toContain("ab");
    await expectLabelInName(page, "challenge editor", "#tf-desc");
  });
});
