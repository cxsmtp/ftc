// @ts-check
//
// HTML-SINK ESCAPE SCANNER — the source half of tests/html-sink-escape.spec.js.
//
// Starts at every HTML sink in public/js — showModal({message}),
// _countdownConfirm(name), setSafeHtml(el, x), `.innerHTML =`, `.outerHTML =`
// (dotted or bracketed), insertAdjacentHTML(pos, x), document.write(ln),
// setHTMLUnsafe, createContextualFragment and parseHTMLUnsafe — and asks, for the value written there, whether
// every dynamic piece of it is escaped. It FOLLOWS the value instead of judging
// only the literal at the sink: a variable is judged by every assignment to it in
// its scope, a call to a first-party function by every value that function
// returns, and a parameter by the argument at every call site. So a renderer that
// builds a row three helpers away from the setSafeHtml that paints it is judged
// the same as one written inline. A helper's callers are found only by direct
// and aliased calls, so a helper also passed on as a value (a callback, a
// `.call`/`.apply`/`.bind`, an object property) is reported, as is an expression
// nested too deep to follow: neither is ever assumed safe.
//
// It is TAUGHT the codebase's idioms rather than exempting sites (CLAUDE.md,
// "Writing a source scanner"): esc()/escAttr()/encodeURIComponent()/CSS.escape(),
// numbers (Number(), Math.*, .toFixed, .length, arithmetic on numbers, numeric
// literals), static string literals, ICO.* icon constants, fmtDt() output, the
// `.map(esc).join()` and `.map(x=>`…`)` shapes, ternaries and `||`/`&&` whose
// every result is safe, and a short list of server-numeric / server-minted
// property names (NUMERIC_PROPS). Anything else that cannot be proven safe is a
// finding, unless it is on the reviewed ALLOW list in the spec (one reason each).
//
// Comments are stripped FIRST, by a string-, template- and regex-aware
// left-to-right pass that blanks comment characters and keeps newlines, so a
// comment quoting a forbidden shape cannot satisfy or trip the scan, and line
// numbers stay true. (tests/doc-registry.js stripJsComments is a regex stripper:
// a `//` inside an HTML template — `href="//host"` — would cut the template in
// half and derail the lexer, so this scanner uses its own lexical pass.)

const fs = require("fs");
const path = require("path");

// Also the bracketed property write (`el["innerHTML"] =`) and every other DOM
// call that parses its argument as HTML, so an aliased spelling of a sink is
// judged like the dotted one.
const SINK_RE = /\b(showModal|_countdownConfirm|setSafeHtml|setSafeSrcdoc)\s*\(|\.(innerHTML|outerHTML)\s*\+?=(?!=)|\[\s*['"](innerHTML|outerHTML)['"]\s*\]\s*\+?=(?!=)|\b(insertAdjacentHTML|document\.write(?:ln)?|setHTMLUnsafe|createContextualFragment|parseHTMLUnsafe)\s*\(/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const KW_BEFORE_REGEX = /^(return|typeof|case|in|of|delete|void|throw|new|else|do|instanceof|yield|await)$/;

/**
 * Blank every comment (keep newlines); lexically aware of strings, templates and
 * regexes. With `literals`, also blank the text of every string, template quasi
 * and regex literal (a template's `${…}` code is kept), so a name search over the
 * result sees code only.
 */
function stripComments(src, literals = false) {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  let prev = "";
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  const regexOk = () => prev === "" || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || KW_BEFORE_REGEX.test(prev);
  const lit = (a, b) => { if (literals) blank(a, b); };
  const str = (q) => { const s0 = ++i; while (i < n && src[i] !== q && src[i] !== "\n") { if (src[i] === "\\") i++; i++; } lit(s0, Math.min(i, n)); i++; };
  const re = () => { const s0 = i; i++; let cls = false; while (i < n) { const c = src[i]; if (c === "\\") { i += 2; continue; } if (c === "[") cls = true; else if (c === "]") cls = false; else if ((c === "/" && !cls) || c === "\n") break; i++; } i++; while (/[a-z]/i.test(src[i] || "")) i++; lit(s0, i); };
  function code(inExpr) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") { const s = i; while (i < n && src[i] !== "\n") i++; blank(s, i); continue; }
      if (c === "/" && src[i + 1] === "*") { const s = i; const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; blank(s, i); continue; }
      if (c === "'" || c === '"') { str(c); prev = "v"; continue; }
      if (c === "`") { tpl(); prev = "v"; continue; }
      if (c === "/") { if (regexOk()) { re(); prev = "v"; } else { i++; prev = "/"; } continue; }
      if (c === "{") depth++;
      if (c === "}") { if (inExpr && depth === 0) return; depth--; }
      if (/\s/.test(c)) { i++; continue; }
      if (/[A-Za-z_$0-9]/.test(c)) { const s = i; while (i < n && /[A-Za-z_$0-9]/.test(src[i])) i++; const w = src.slice(s, i); prev = KW_BEFORE_REGEX.test(w) ? w : "v"; continue; }
      prev = c === ")" || c === "]" ? "v" : c;
      i++;
    }
  }
  function tpl() {
    i++;
    while (i < n) {
      const c = src[i];
      if (c === "\\") { lit(i, Math.min(i + 2, n)); i += 2; continue; }
      if (c === "`") { i++; return; }
      if (c === "$" && src[i + 1] === "{") { i += 2; prev = "("; code(true); i++; continue; }
      lit(i, i + 1);
      i++;
    }
  }
  code(false);
  return out.join("");
}

// ---- small expression utilities (operate on comment-free text) ----

/** Index just past the bracket/quote-balanced region opened at `open`. */
function matchClose(s, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const stack = [pairs[s[open]]];
  let i = open + 1;
  while (i < s.length && stack.length) {
    const c = s[i];
    if (c === "'" || c === '"') { i++; while (i < s.length && s[i] !== c) { if (s[i] === "\\") i++; i++; } i++; continue; }
    if (c === "`") { i = skipTemplate(s, i); continue; }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) stack.pop();
    i++;
  }
  return i;
}
function skipTemplate(s, i) {
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return i + 1;
    if (c === "$" && s[i + 1] === "{") { i = matchClose(s, i + 1); continue; }
    i++;
  }
  return i;
}
/** Walk s at bracket depth 0, calling fn(i) for each top-level index; fn returns a skip count or false. */
function topLevel(s, fn) {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') { i++; while (i < s.length && s[i] !== c) { if (s[i] === "\\") i++; i++; } i++; continue; }
    if (c === "`") { i = skipTemplate(s, i); continue; }
    if (c === "(" || c === "[" || c === "{") { i = matchClose(s, i); continue; }
    const r = fn(i);
    if (r === true) return;
    i++;
  }
}
function splitTop(s, seps) {
  const parts = []; let start = 0;
  topLevel(s, (i) => {
    for (const sp of seps) {
      if (s.startsWith(sp, i) && !(sp === "+" && (s[i + 1] === "+" || s[i - 1] === "+" || s[i + 1] === "=")) && !(sp === "," && false)) {
        parts.push(s.slice(start, i)); start = i + sp.length; return false;
      }
    }
    return false;
  });
  parts.push(s.slice(start));
  return parts;
}
function ternary(s) {
  let q = -1, nest = 0, res = null;
  topLevel(s, (i) => {
    const c = s[i];
    if (c === "?" && s[i + 1] !== "." && s[i + 1] !== "?" && s[i - 1] !== "?") { if (q < 0) q = i; else nest++; }
    else if (c === ":" && q >= 0) { if (nest === 0) { res = [s.slice(0, q), s.slice(q + 1, i), s.slice(i + 1)]; return true; } nest--; }
    return false;
  });
  return res;
}
/** If s is exactly `callee(args)` return {callee, args:[...]}; callee may be dotted. */
function asCall(s) {
  const m = s.match(/^([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\s*\(/);
  if (!m) return null;
  const open = m[0].length - 1;
  const close = matchClose(s, open);
  if (close !== s.length) return null;
  const inner = s.slice(open + 1, close - 1);
  return { callee: m[1].replace(/\?\./g, "."), args: inner.trim() === "" ? [] : splitTop(inner, [","]).map(x => x.trim()) };
}
/** Template literal → {quasis, exprs} (exprs are raw text). */
function parseTemplate(s) {
  const quasis = [], exprs = []; let q = ""; let i = 1;
  while (i < s.length - 1) {
    const c = s[i];
    if (c === "\\") { q += s.slice(i, i + 2); i += 2; continue; }
    if (c === "$" && s[i + 1] === "{") { const e = matchClose(s, i + 1); quasis.push(q); q = ""; exprs.push({ text: s.slice(i + 2, e - 1), off: i + 2 }); i = e; continue; }
    q += c; i++;
  }
  quasis.push(q);
  return { quasis, exprs };
}
function stripParens(s) {
  s = s.trim();
  while (s.startsWith("(") && matchClose(s, 0) === s.length) s = s.slice(1, -1).trim();
  return s;
}

// ---- the analysis ----

/**
 * Values that are never attacker-shaped: an id the server minted, a count, a
 * rank, a score, a page number. A reviewed list, not a pattern — a property
 * named like text never joins it.
 */
const NUMERIC_PROPS = new Set([
  "id", "rank", "score", "points", "count", "total", "page", "totalPages", "pages", "index",
  "solved", "solvedCount", "attempts", "attempts_used", "attempt_cap", "remaining", "cap",
  "member_count", "competition_count", "attachment_count", "length", "size", "limit", "offset",
  "pct", "percent", "rate", "minutes", "seconds", "hours", "days", "duration_minutes",
]);
/** Counter-shaped names the server only ever fills with an integer (`skippedStaff`, `user_count`, `candidatesTotal`). */
const NUMERIC_PROP_RE = /^(skipped[A-Z][A-Za-z]*|[a-z][A-Za-z]*_count|[a-z][A-Za-z]*Count|[a-z][A-Za-z]*Total)$/;
/** Calls whose result is safe whatever their input (they escape, encode or format a number/date). */
const SAFE_CALLEES = new Set([
  "esc", "escAttr", "encodeURIComponent", "CSS.escape", "Number", "parseInt", "parseFloat",
  "Math.round", "Math.floor", "Math.ceil", "Math.max", "Math.min", "Math.abs",
  "fmtDt", "String.fromCharCode", "html",
  // the rich-text sanitiser (ui/richtext.js): parses in an inert document and keeps
  // only allow-listed tags and attributes; plain text is esc()-ed
  "renderRich",
]);

class Scanner {
  constructor(root, opts = {}) {
    this.root = root;
    this.files = {};
    this.findings = [];
    this.memo = new Map();
    this.funcIndex = new Map(); // name -> [{file, params:[...], bodyStart, bodyEnd, exprBody}]
    this.extraSafe = new Set(opts.safeCallees || []);
    this.trusted = [];
    this.inertCount = 0;
    for (const f of walk(path.join(root, "public/js"))) {
      const rel = path.relative(root, f).split(path.sep).join("/");
      const src = stripComments(fs.readFileSync(f, "utf8"));
      this.files[rel] = { src, code: stripComments(src, true), lineStarts: lineStarts(src) };
      this.indexFunctions(rel);
    }
    this.sinkCount = 0;
  }
  line(file, pos) { const ls = this.files[file].lineStarts; let lo = 0, hi = ls.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ls[m] <= pos) lo = m; else hi = m - 1; } return lo + 1; }

  indexFunctions(file) {
    const src = this.files[file].src;
    const add = (name, params, bodyStart, bodyEnd, exprBody, defAt) => {
      if (!this.funcIndex.has(name)) this.funcIndex.set(name, []);
      const exported = /\bexport\s+(?:async\s+)?$/.test(src.slice(Math.max(0, defAt - 20), defAt));
      this.funcIndex.get(name).push({ file, params, bodyStart, bodyEnd, exprBody, defAt, exported });
    };
    const paramList = (p) => splitTop(p, [","]).map(x => x.trim().replace(/=.*$/s, "").replace(/^\.\.\./, "").trim());
    let m;
    const fdecl = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
    while ((m = fdecl.exec(src))) {
      const po = m.index + m[0].length - 1, pc = matchClose(src, po);
      const bo = src.indexOf("{", pc); if (bo < 0) continue;
      add(m[1], paramList(src.slice(po + 1, pc - 1)), bo, matchClose(src, bo), null, m.index);
    }
    const arrow = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(\(|[A-Za-z_$][\w$]*\s*=>)/g;
    while ((m = arrow.exec(src))) {
      let params, after;
      if (m[2] === "(") {
        const po = m.index + m[0].length - 1, pc = matchClose(src, po);
        const rest = src.slice(pc).match(/^\s*=>\s*/); if (!rest) continue;
        params = paramList(src.slice(po + 1, pc - 1)); after = pc + rest[0].length;
      } else {
        params = [m[2].replace(/\s*=>$/, "").trim()]; after = m.index + m[0].length; while (/\s/.test(src[after])) after++;
      }
      if (src[after] === "{") add(m[1], params, after, matchClose(src, after), null, m.index);
      else add(m[1], params, after, exprEnd(src, after), true, m.index);
    }
  }

  report(file, pos, text, why) {
    this.findings.push({ file, line: this.line(file, pos), expr: text.replace(/\s+/g, " ").trim().slice(0, 140), why, sink: this.currentSink });
  }

  /** Is the expression text (at absolute pos in file) HTML-safe? Reports unsafe leaves. */
  safe(file, pos, text, stack = []) {
    const raw = text;
    let s = stripParens(text);
    const lead = raw.indexOf(s.slice(0, 8)); const at = pos + Math.max(0, lead);
    if (s === "") return true;
    // Too deep to follow is a finding, never a pass: failing open here would let
    // any value through behind enough nesting.
    if (stack.length > 40) { this.report(file, at, s, "expression nested too deep to follow"); return false; }
    const t = ternary(s);
    if (t) { const a = this.safe(file, at + s.indexOf(t[1]), t[1], stack); const b = this.safe(file, at + s.lastIndexOf(t[2]), t[2], stack); return a && b; }
    for (const ops of [["||", "??"], ["&&"]]) {
      const parts = splitTop(s, ops);
      if (parts.length > 1) {
        // `a && b` yields a falsy a (renders as text) or b; `a || b` may yield either.
        const judged = ops[0] === "&&" ? [parts[parts.length - 1]] : parts;
        let ok = true, off = 0;
        for (const p of parts) { if (judged.includes(p)) ok = this.safe(file, at + s.indexOf(p, off), p, stack) && ok; off = s.indexOf(p, off) + p.length; }
        return ok;
      }
    }
    // comparison / unary / typeof results are booleans or strings of keywords
    if (/^!/.test(s) || /^typeof\b/.test(s)) return true;
    let cmp = false; topLevel(s, (i) => { if (/^(===|!==|==|!=|<=|>=)/.test(s.slice(i)) || ((s[i] === "<" || s[i] === ">") && s[i + 1] === " ")) { cmp = true; return true; } return false; });
    if (cmp) return true;
    const plus = splitTop(s, ["+"]);
    if (plus.length > 1) { let ok = true, off = 0; for (const p of plus) { const ix = s.indexOf(p, off); ok = this.safe(file, at + ix, p, stack) && ok; off = ix + p.length; } return ok; }
    const arith = splitTop(s, ["-", "*", "/", "%"]);
    if (arith.length > 1 && arith.every(p => p.trim() !== "")) return true; // arithmetic yields a number (or NaN)
    if (/^-?\d[\d_.e]*$/i.test(s) || /^(true|false|null|undefined|NaN|Infinity)$/.test(s)) return true;
    if (/^'(?:[^'\\]|\\.)*'$|^"(?:[^"\\]|\\.)*"$/s.test(s)) return true; // static string literal
    if (s[0] === "`" && skipTemplate(s, 0) === s.length) {
      const tp = parseTemplate(s); let ok = true;
      for (const e of tp.exprs) ok = this.safe(file, at + e.off, e.text, stack) && ok;
      return ok;
    }
    if (/^ICO\.[A-Za-z_$][\w$]*$/.test(s) || (/^ICO\[/.test(s) && matchClose(s, 3) === s.length)) return true; // the static icon table, whatever the key
    if (s[0] === "[" && matchClose(s, 0) === s.length) return splitTop(s.slice(1, -1), [","]).every(x => this.safe(file, at + 1, x.trim().replace(/^\.\.\./, ""), stack)); // an array renders its items joined by ","
    // Rewriting part of a safe string with safe text that brings no `<` of its own
    // (`html.replace(/<option…>/, "")`, `chip.replace('class="tag', 'class="tag'+cls)`)
    // cannot add markup. A replacement that writes `<` (un-escaping) is never taught.
    const rm = s.match(/^([\s\S]+)\.replace\((\/(?:[^\/\\\n]|\\.)+\/[a-z]*|'[^'\n]*'|"[^"\n]*")\s*,\s*([^,]+)\)$/);
    if (rm && matchClose(s, rm[1].length + 8) === s.length && !/[<>]|&(?:lt|gt|#)/.test(rm[3])) return this.safe(file, at, rm[1], stack) && this.safe(file, at, rm[3], stack);
    // Array.from({length: n}, (_, i) => …).join(sep): the callback is judged with its index trusted
    const af = s.match(/^Array\.from\(\{\s*length\s*:[^}]*\}\s*,\s*([\s\S]*)\)\s*\.join\(([^()]*)\)$/);
    if (af) {
      const cb = af[1]; const ar = cb.match(/^(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*/);
      if (ar) {
        const body = cb.slice(ar[0].length); const bpos = at + s.indexOf(cb) + ar[0].length;
        const names = (ar[1] || ar[2] || "").split(",").map(x => x.trim()).filter(x => /^[A-Za-z_$][\w$]*$/.test(x));
        const pushed = names.map(nm => { const t = { name: nm, from: bpos, to: bpos + body.length, file }; this.trusted.push(t); return t; });
        try { return body.trim().startsWith("{") ? this.returnsSafe(file, bpos, body, stack) : this.safe(file, bpos, body, stack); }
        finally { for (const t of pushed) this.trusted.splice(this.trusted.indexOf(t), 1); }
      }
    }
    if (/\.(toFixed|toPrecision)\([^()]*\)$/.test(s)) return true;
    if (/\.length$/.test(s)) return true;
    // String methods that keep (or only cut/pad) their receiver: safe iff the receiver is.
    const sm = s.match(/^([\s\S]+)\.(trim|trimStart|trimEnd|toLowerCase|toUpperCase|padStart|padEnd|repeat)\(([^()]*)\)$/);
    if (sm && matchClose(s, sm[1].length + sm[2].length + 1) === s.length) {
      // repeat(n) only copies its receiver; pad*(n, fill) also writes `fill`
      const padFill = /^pad/.test(sm[2]) ? splitTop(sm[3], [","]).slice(1) : [];
      return this.safe(file, at, sm[1], stack) && padFill.every(a => this.safe(file, at, a, stack));
    }
    // Number / Date formatting. String.prototype.toLocaleString returns the string
    // itself, so only a receiver that is a number or a date counts.
    const ls = s.match(/^([\s\S]+)\.(toLocaleString|toLocaleDateString|toLocaleTimeString|getFullYear|getMonth|getDate|getDay|getHours|getMinutes|getSeconds|getTime)\(([^()]*)\)$/);
    if (ls && matchClose(s, ls[1].length + ls[2].length + 1) === s.length) {
      const recv = stripParens(ls[1]);
      if (/^new Date\b/.test(recv) || /^Number\(/.test(recv) || /\|\|\s*0$/.test(recv) || /^-?\d/.test(recv) || /^(d|dt|date|now|start|end|[a-z]*Date)$/.test(recv) || this.safeNumber(recv)) return true;
      if (/^(get|toLocaleDate|toLocaleTime)/.test(ls[2])) return true;
    }
    // a.map(cb).join(sep) — safe when cb's result is safe for every element
    let mapAt = -1;
    // (an array without .join renders through Array#toString, i.e. joined by ",")
    topLevel(s, (i) => { if (s.startsWith(".map(", i)) { const c = matchClose(s, i + 4); if (/^(\s*\.join\([^()]*\))?\s*$/.test(s.slice(c))) { mapAt = i; return true; } } return false; });
    const mj = mapAt >= 0 ? [null, s.slice(0, mapAt), s.slice(mapAt + 5, matchClose(s, mapAt + 4) - 1), s.slice(matchClose(s, mapAt + 4)).trim().replace(/^\.join\(|\)$/g, "")] : null;
    if (mj) {
      const cbStart = mapAt + 5;
      const cb = mj[2].trim();
      if (!this.safe(file, at, mj[3], stack)) return false;
      if (SAFE_CALLEES.has(cb) || this.extraSafe.has(cb)) return true;
      const arrow = cb.match(/^(?:async\s*)?(\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/);
      if (arrow) {
        const body = cb.slice(arrow[0].length);
        const bpos = at + cbStart + (s.slice(cbStart).indexOf(body));
        // Elements of a static table (a const array of literals) are not data: trust
        // the callback's parameters inside its own body. Array.from({length}) hands
        // the callback an index.
        const recv = stripParens(mj[1]);
        const recvBase = recv.replace(/(\.(slice|filter|sort|reverse|concat)\((?:[^()]|\([^()]*\))*\))+$/, "");
        const trust = /^Array\.from\(\{\s*length\s*:/.test(recv) ? true
          : this.isStatic(file, at, recvBase, [])
          || (/^[A-Za-z_$][\w$]*$/.test(recvBase) && this.quietly(() => this.arraySafe(file, at, recvBase, stack)));
        const pushed = [];
        // the second parameter of a map callback is the element's index: a number
        const plist = splitTop(arrow[1].replace(/^\(|\)$/g, ""), [","]).map(x => x.trim());
        const trustName = (nm) => { const t = { name: nm, from: bpos, to: bpos + body.length, file }; this.trusted.push(t); pushed.push(t); };
        if (/^[A-Za-z_$][\w$]*$/.test(plist[1] || "")) trustName(plist[1]);
        // a static table's element, destructured or not: every name bound from it
        if (trust && plist[0]) for (const nm of (plist[0].replace(/=[^,}\]]*/g, "").match(/[A-Za-z_$][\w$]*/g) || [])) trustName(nm);
        try {
          if (body.trim().startsWith("{")) return this.returnsSafe(file, bpos, body, stack);
          return this.safe(file, bpos, body, stack);
        } finally { for (const t of pushed) this.trusted.splice(this.trusted.indexOf(t), 1); }
      }
      if (/^[A-Za-z_$][\w$]*$/.test(cb)) return this.funcSafe(file, at, cb, stack);
      this.report(file, at, s, "map callback not understood"); return false;
    }
    if (/\.join\([^()]*\)$/.test(s)) {
      // arr.join(sep): safe only when arr resolves to an array literal / filter of safe items
      const base = s.slice(0, s.lastIndexOf(".join("));
      if (/^[A-Za-z_$][\w$]*$/.test(base)) return this.arraySafe(file, at, base, stack);
      if (base.startsWith("[") && matchClose(base, 0) === base.length) return splitTop(base.slice(1, -1), [","]).every(x => this.safe(file, at + 1, x, stack));
      const fb = base.match(/^\[([\s\S]*)\]\.filter\(Boolean\)$/);
      if (fb) return splitTop(fb[1], [","]).every(x => this.safe(file, at + 1, x, stack));
      this.report(file, at, s, "joined array not proven safe"); return false;
    }
    // an inline static lookup table: `{started:'…', has_sessions:'…'}[reason]`
    if (s[0] === "{") { const c = matchClose(s, 0); if (/^\[[^\]]*\]$/.test(s.slice(c)) && this.isStatic(file, at, s.slice(0, c), [])) return true; }
    const call = asCall(s);
    if (call) {
      if (SAFE_CALLEES.has(call.callee) || this.extraSafe.has(call.callee)) return true;
      // predicates return a boolean, which renders as "true"/"false"
      if (/\.(has|includes|some|every|startsWith|endsWith|test|isArray|isFinite|isInteger)$/.test(call.callee)) return true;
      if (/^String$/.test(call.callee)) return call.args.length === 1 && this.safe(file, at + 7, call.args[0], stack);
      if (/^[A-Za-z_$][\w$]*$/.test(call.callee) && this.defsFor(file, at, call.callee).length) return this.funcSafe(file, at, call.callee, stack);
      this.report(file, at, s, `call to ${call.callee}() not proven safe`); return false;
    }
    const baseName = (s.match(/^[A-Za-z_$][\w$]*/) || [""])[0];
    if (baseName && this.isTrusted(file, at, baseName)) return true;
    if (/^[A-Za-z_$][\w$]*$/.test(s)) return this.identSafe(file, at, s, stack);
    const prop = s.match(/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[[^\]]+\])*\??\.([A-Za-z_$][\w$]*)$/);
    if (prop && (NUMERIC_PROPS.has(prop[1]) || NUMERIC_PROP_RE.test(prop[1]))) return true;
    // a member of a static table (const object/array of literals): `LABELS[k]`, `palette.x`
    const mem = s.match(/^([A-Za-z_$][\w$]*)((?:\??\.[A-Za-z_$][\w$]*|\[[^\]]+\])+)$/);
    if (mem && this.isStatic(file, at, mem[1], [])) return true;
    // `parts.hint` where `parts` is a const object literal of safe values, or a
    // parameter every caller fills with one. Reported here, not at the caller, when not.
    const one = s.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
    if (one && this.quietly(() => this.objPropSafe(file, at, one[1], one[2], stack))) return true;
    if (/^[A-Za-z_$][\w$]*\+\+$|^\+\+/.test(s)) return true;
    this.report(file, at, s, "not proven escaped");
    return false;
  }

  /** Run a judgement without recording its findings (used to ask "is this array safe?"). */
  quietly(fn) { const n = this.findings.length; const memo = new Map(this.memo); try { return fn(); } finally { this.findings.length = n; this.memo = memo; } }

  isTrusted(file, pos, name) { return this.trusted.some(t => t.file === file && t.name === name && pos >= t.from && pos <= t.to); }

  /** Is expr a compile-time constant built only from literals (a static table)? */
  isStatic(file, pos, expr, seen) {
    const s = stripParens(expr);
    if (s === "") return true;
    if (seen.length > 20) return false;
    if (/^-?\d[\d_.e]*$/i.test(s) || /^(true|false|null|undefined)$/.test(s)) return true;
    if (/^'(?:[^'\\]|\\.)*'$|^"(?:[^"\\]|\\.)*"$/s.test(s)) return true;
    if (s[0] === "`" && skipTemplate(s, 0) === s.length) return parseTemplate(s).exprs.every(e => this.isStatic(file, pos, e.text, seen));
    if (/^ICO(\.[A-Za-z_$][\w$]*|\[[^\]]*\])?$/.test(s)) return true;
    if (/^(?:async\s*)?(\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(s) || /^function\b/.test(s)) return true; // code, not data
    const fr = s.match(/^Object\.freeze\(([\s\S]*)\)$/); if (fr) return this.isStatic(file, pos, fr[1], seen);
    if ((s[0] === "[" || s[0] === "{") && matchClose(s, 0) === s.length) {
      const items = splitTop(s.slice(1, -1), [","]).map(x => x.trim()).filter(Boolean);
      return items.every(it => {
        if (s[0] === "[") return this.isStatic(file, pos, it.replace(/^\.\.\./, ""), seen);
        if (/^\.\.\./.test(it)) return this.isStatic(file, pos, it.slice(3), seen);
        const kv = splitTop(it, [":"]);
        if (kv.length === 1) return /^[A-Za-z_$][\w$]*\s*\(/.test(it) || this.isStatic(file, pos, it, seen); // method shorthand or shorthand prop
        return this.isStatic(file, pos, kv.slice(1).join(":"), seen);
      });
    }
    const mem = s.match(/^([A-Za-z_$][\w$]*)((?:\??\.[A-Za-z_$][\w$]*|\[[^\]]+\])*)$/);
    if (!mem) return false;
    const name = mem[1];
    if (seen.includes(name)) return false;
    // a single `const NAME = <static>` in scope (or exported from another module)
    const src = this.files[file].src;
    const sc = this.scopeOf(file, pos, name);
    const look = (f, text, base) => {
      const decl = new RegExp(`\\bconst\\s+${name}\\s*=\\s*`, "g"); const m = decl.exec(text);
      if (!m) return null;
      if (new RegExp(`(?<![.\\w$])${name}\\s*(\\[[^\\]]*\\]|\\.[\\w$]+)*\\s*\\+?=(?![=>])`).test(text.slice(m.index + m[0].length))) return false;
      if (new RegExp(`(?<![.\\w$])${name}\\s*\\.(push|unshift|splice|fill|set)\\(`).test(text)) return false; // mutated later: not a static table
      const st = m.index + m[0].length;
      return this.isStatic(f, base + st, text.slice(st, exprEnd(text, st)), [...seen, name]);
    };
    if (sc && !sc.param && !sc.loop) { const r = look(file, src.slice(sc.start, sc.end), sc.start); if (r !== null) return r; }
    if (!sc) for (const [f, rec] of Object.entries(this.files)) { if (new RegExp(`\\bexport\\s+const\\s+${name}\\s*=`).test(rec.src)) { const r = look(f, rec.src, 0); if (r !== null) return r; } }
    return false;
  }

  safeNumber(s) {
    const prop = s.match(/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\??\.([A-Za-z_$][\w$]*)$/);
    return !!(prop && (NUMERIC_PROPS.has(prop[1]) || NUMERIC_PROP_RE.test(prop[1])));
  }

  /** Every `return X` in a block body (and nested blocks) is safe. */
  returnsSafe(file, pos, body, stack) {
    const re = /\breturn\b/g; let m; let ok = true; let any = false;
    // a `return` inside a nested function (a callback) is that function's, not this one's
    const nested = innerBlocks(body, 1, body.length - 1).filter(([a]) => isFunctionBlock(body, a));
    while ((m = re.exec(body))) {
      if (nested.some(([a, b]) => m.index > a && m.index < b)) continue;
      const st = m.index + 6; const end = exprEnd(body, st);
      const e = body.slice(st, end);
      if (e.trim() === "") continue;
      any = true;
      ok = this.safe(file, pos + st, e, stack) && ok;
    }
    return ok || !any;
  }

  /** The definitions a call to `name` at file:pos can reach: same-file ones, else exported ones. */
  defsFor(file, pos, name) {
    const all = this.funcIndex.get(name) || [];
    const local = all.filter(d => d.file === file);
    if (!local.length) {
      // an alias: `export const _x = x;` (x imported or defined elsewhere)
      const al = new RegExp(`\\bconst\\s+${name}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*;`).exec(this.files[file].src);
      if (al && al[1] !== name) return this.defsFor(file, pos, al[1]);
    }
    if (local.length) {
      // a nested helper is visible only inside its own block
      const vis = local.filter(d => { const b = this.enclosingBlock(file, d.defAt); return !b || (b[0] < pos && pos < b[1]); });
      return vis.length ? vis : local;
    }
    return all.filter(d => d.exported);
  }
  enclosingBlock(file, p) {
    let best = null;
    for (const b of this.blocks(file)) if (b[0] < p && p < b[1] && (!best || b[1] - b[0] < best[1] - best[0])) best = b;
    return best;
  }

  funcSafe(file, pos, name, stack) {
    const defs = this.defsFor(file, pos, name);
    if (!defs.length) { this.report(file, pos, name + "()", `call to ${name}() not proven safe`); return false; }
    const key = `f:${defs[0].file}:${defs[0].defAt}:${name}`;
    if (stack.includes(key)) return true;
    if (this.memo.has(key)) return this.memo.get(key);
    this.memo.set(key, true); // provisional (recursion)
    let ok = true;
    for (const d of defs) {
      const src = this.files[d.file].src;
      const body = src.slice(d.bodyStart, d.bodyEnd);
      ok = (d.exprBody ? this.safe(d.file, d.bodyStart, body, [...stack, key]) : this.returnsSafe(d.file, d.bodyStart, body, [...stack, key])) && ok;
    }
    this.memo.set(key, ok);
    return ok;
  }

  /** Every element pushed/assigned into array `name` (in scope) is safe. */
  arraySafe(file, pos, name, stack) {
    const src = this.files[file].src;
    const scope = this.scopeOf(file, pos, name);
    if (!scope) { this.report(file, pos, name + ".join()", "joined array not proven safe"); return false; }
    const body = src.slice(scope.start, scope.end);
    let ok = true; let any = false; let m;
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*`, "g");
    while ((m = decl.exec(body))) {
      const st = m.index + m[0].length; const end = exprEnd(body, st); const e = body.slice(st, end).trim();
      any = true;
      if (e.startsWith("[")) ok = splitTop(e.slice(1, matchClose(e, 0) - 1), [","]).every(x => this.safe(file, scope.start + st, x, stack)) && ok;
      else ok = this.safe(file, scope.start + st, e.replace(/\.filter\(Boolean\)$/, ""), stack) && ok;
    }
    const push = new RegExp(`\\b${name}\\.(?:push|unshift)\\(`, "g");
    while ((m = push.exec(body))) {
      const o = m.index + m[0].length - 1; const c = matchClose(body, o);
      for (const a of splitTop(body.slice(o + 1, c - 1), [","])) ok = this.safe(file, scope.start + o + 1, a.trim().replace(/^\.\.\./, ""), stack) && ok;
    }
    if (!any) { this.report(file, pos, name + ".join()", "joined array not proven safe"); return false; }
    return ok;
  }

  /** Smallest enclosing {block} of pos that declares `name` (const/let/var or params). */
  scopeOf(file, pos, name) {
    const src = this.files[file].src;
    const blocks = this.blocks(file).filter(([a, b]) => a < pos && pos < b).sort((x, y) => (x[1] - x[0]) - (y[1] - y[0]));
    // `const NAME`, and a later name in one statement: `const s=f(x), h=…, NAME=…` / `let a, NAME;`
    const declRe = new RegExp(`\\b(?:const|let|var)\\s+(?:(?:[^;{}()\\n]|\\((?:[^()\\n]|\\([^()\\n]*\\))*\\))*?,\\s*)?(?:${name}\\b(?=\\s*(?:=|,|;|\\n|$))|\\{[^}]*\\b${name}\\b[^}]*\\}|\\[[^\\]]*\\b${name}\\b[^\\]]*\\])`);
    for (const [a, b] of blocks) {
      const header = src.slice(Math.max(0, a - 3000), a); // long enough for a commented options list
      let pm = header.match(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?:=>\s*)?$/);
      if (pm && /\b(if|for|while|switch|with)\s*$/.test(header.slice(0, header.length - pm[0].length))) pm = null; // a condition, not a parameter list
      if (pm && new RegExp(`(^|[,({\\s])\\.{0,3}${name}\\s*(=[^,]*)?($|[,)}\\s])`).test(pm[1])) return { start: a, end: b, param: true, header: pm[1], headerEnd: a };
      const forOf = header.match(new RegExp(`for\\s*\\(\\s*(?:const|let|var)\\s+[^;]*\\b${name}\\b[^;]*\\s+(of|in)\\s+([^)]*)\\)\\s*$`));
      if (forOf) return { start: a, end: b, loop: true, iterKind: forOf[1], iter: forOf[2].trim(), headerAt: a };
      if (declRe.test(src.slice(a, b))) return { start: a, end: b };
    }
    // module scope only when the declaration itself sits outside every block
    const all = new RegExp(declRe.source, "g"); let dm;
    const allBlocks = this.blocks(file);
    while ((dm = all.exec(src))) { const p = dm.index; if (!allBlocks.some(([a, b]) => a < p && p < b)) return { start: 0, end: src.length }; }
    return null;
  }

  blocks(file) {
    const f = this.files[file];
    if (f.blocks) return f.blocks;
    const src = f.src; const out = []; const st = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "'" || c === '"') { i++; while (i < src.length && src[i] !== c && src[i] !== "\n") { if (src[i] === "\\") i++; i++; } i++; continue; }
      if (c === "`") { // record blocks inside ${} too
        let j = i + 1;
        while (j < src.length && src[j] !== "`") { if (src[j] === "\\") { j += 2; continue; } if (src[j] === "$" && src[j + 1] === "{") { const e = matchClose(src, j + 1); for (const b of innerBlocks(src, j + 2, e - 1)) out.push(b); j = e; continue; } j++; }
        i = j + 1; continue;
      }
      if (c === "/" && /[(,=:[!&|?{};]\s*$/.test(src.slice(Math.max(0, i - 20), i))) { i++; while (i < src.length && src[i] !== "/" && src[i] !== "\n") { if (src[i] === "\\") i++; i++; } i++; continue; }
      if (c === "{") st.push(i); else if (c === "}") { const a = st.pop(); if (a !== undefined) out.push([a, i + 1]); }
      i++;
    }
    f.blocks = out;
    return out;
  }

  identSafe(file, pos, name, stack) {
    const key = `v:${file}:${name}:`;
    const scope = this.scopeOf(file, pos, name);
    // An arrow parameter with an EXPRESSION body (`r => `#${r}``) has no block, so
    // it shadows whatever block scopeOf found when the arrow sits inside it.
    const src = this.files[file].src;
    const before = src.slice(Math.max(0, pos - 600), pos);
    const arrows = [...before.matchAll(new RegExp(`(?:\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s*)?)?(?:\\(([^()]*\\b${name}\\b[^()]*)\\)|(?<![\\w$.])(${name}))\\s*=>\\s*`, "g"))]
      .map(a => ({ a, defAt: pos - before.length + a.index, bodyAt: pos - before.length + a.index + a[0].length }))
      .filter(x => src[x.bodyAt] !== "{" && exprEnd(src, x.bodyAt) >= pos && new RegExp(`(^|[\\s,({])\\.{0,3}${name}\\s*(=|,|}|$)`).test((x.a[2] || x.a[3] || "").trim().replace(/^/, " ")));
    const arrow = arrows.pop();
    if (arrow && (!scope || arrow.defAt > scope.start)) {
      if (arrow.a[1]) { // a NAMED arrow `const f = (a, b) => `…${a}`` — judge every call site's argument
        const k = `p:${file}:${arrow.defAt}:${name}`; if (stack.includes(k)) return true;
        return this.paramSafe(file, pos, name, { header: arrow.a[2] || arrow.a[3], headerEnd: arrow.bodyAt, fname: arrow.a[1] }, [...stack, k]);
      }
      this.report(file, pos, name, "callback parameter not proven escaped"); return false;
    }
    if (!scope) {
      if (this.funcIndex.has(name)) return true; // a function reference rendered — never data
      // an imported constant: judge its exported value in the defining module
      for (const [f, rec] of Object.entries(this.files)) {
        const em = new RegExp(`\\bexport\\s+const\\s+${name}\\s*=\\s*`).exec(rec.src);
        if (em) {
          const gk = `g:${name}`; if (stack.includes(gk)) return true;
          const st = em.index + em[0].length;
          return this.safe(f, st, rec.src.slice(st, exprEnd(rec.src, st)), [...stack, gk]);
        }
      }
      this.report(file, pos, name, "undeclared identifier"); return false;
    }
    const skey = key + scope.start;
    if (stack.includes(skey)) return true;
    if (this.memo.has(skey)) return this.memo.get(skey);
    this.memo.set(skey, true);
    let ok;
    // `for (const f of STATIC_TABLE)`: each element is a literal
    if (scope.loop && scope.iterKind === "of" && /^[A-Za-z_$][\w$]*$/.test(scope.iter) && this.isStatic(file, scope.headerAt, scope.iter, [])) ok = true;
    else if (scope.loop) { this.report(file, pos, name, "loop variable not proven escaped"); ok = false; }
    else if (scope.param) ok = this.paramSafe(file, pos, name, scope, [...stack, skey]);
    else ok = this.assignmentsSafe(file, pos, name, scope, [...stack, skey]);
    this.memo.set(skey, ok);
    return ok;
  }

  assignmentsSafe(file, pos, name, scope, stack) {
    const src = this.files[file].src; const body = src.slice(scope.start, scope.end);
    const re = new RegExp(`(?:\\b(?:const|let|var)\\s+)?(?<![.\\w$])${name}\\s*(\\+?=)(?![=>])`, "g");
    let m; let ok = true; let any = false;
    while ((m = re.exec(body))) {
      const st = m.index + m[0].length; const end = exprEnd(body, st);
      any = true;
      ok = this.safe(file, scope.start + st, body.slice(st, end), stack) && ok;
    }
    // an array filled later: every pushed item counts as a value it holds
    const pre = new RegExp(`(?<![.\\w$])${name}\\.(?:push|unshift)\\(`, "g"); let pm;
    while ((pm = pre.exec(body))) {
      const o = pm.index + pm[0].length - 1; const c = matchClose(body, o);
      for (const a of splitTop(body.slice(o + 1, c - 1), [","])) ok = this.safe(file, scope.start + o + 1, a.trim().replace(/^\.\.\./, ""), stack) && ok;
    }
    // destructured declaration: const {a, b} = obj  → value comes from data
    if (new RegExp(`\\b(?:const|let|var)\\s+[{\\[][^=]*\\b${name}\\b[^=]*[}\\]]\\s*=`).test(body)) { this.report(file, pos, name, "destructured value not proven escaped"); return false; }
    if (!any) { this.report(file, pos, name, "declared without a value"); return false; }
    return ok;
  }

  paramSafe(file, pos, name, scope, stack, member = null) {
    // which function owns this parameter list? judge the argument at every call site
    const src = this.files[file].src;
    const head = src.slice(Math.max(0, scope.headerEnd - 3000), scope.headerEnd);
    const m = head.match(/(?:\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)|\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?)\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*(?:=>\s*)?$/);
    const fname = scope.fname || (m && (m[1] || m[2]));
    const params = splitTop(scope.header, [","]).map(x => x.trim());
    let idx = params.findIndex(p => new RegExp(`^(\\.\\.\\.)?${name}\\b`).test(p));
    // an options object destructured in the parameter list: `fn(id, { message, noun = 'x' })`
    let prop = null;
    if (idx < 0) {
      idx = params.findIndex(p => p.startsWith("{") && splitTop(p.replace(/^\{|\}\s*(=[\s\S]*)?$/g, ""), [","]).some(x => new RegExp(`^${name}\\b`).test(x.trim())));
      if (idx >= 0) prop = splitTop(params[idx].replace(/^\{|\}\s*(=[\s\S]*)?$/g, ""), [","]).map(x => x.trim()).find(x => new RegExp(`^${name}\\b`).test(x));
    }
    if (!fname || idx < 0 || /^\.\.\./.test(params[idx]) || (prop && /^[\w$]+\s*:/.test(prop))) { this.report(file, pos, name, "parameter not proven escaped"); return false; }
    const dflt = member ? null : (prop || params[idx]).match(/=\s*([\s\S]+)$/);
    let ok = dflt ? this.safe(file, pos, dflt[1], stack) : true;
    let sites = 0;
    // Which definition is this? A local helper is called only inside the block
    // that defines it; only an exported one is reachable from other modules.
    const def = (this.funcIndex.get(fname) || []).filter(d => d.file === file && d.defAt <= pos && pos <= d.bodyEnd).sort((a, b) => b.defAt - a.defAt)[0];
    const lim = def && !def.exported ? (this.enclosingBlock(file, def.defAt) || [0, src.length]) : null;
    const where = def && def.exported ? Object.entries(this.files) : [[file, this.files[file]]];
    // calls through an alias (`export const _f = f;`) are call sites too
    const aliases = [fname];
    for (const rec of Object.values(this.files)) for (const am of rec.src.matchAll(new RegExp(`\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${fname}\\s*;`, "g"))) aliases.push(am[1]);
    for (const [f, rec] of (aliases.length > 1 ? Object.entries(this.files) : where)) {
      const cre = new RegExp(`(?<![\\w$.])(?:${aliases.join("|")})\\s*\\(`, "g"); let c;
      while ((c = cre.exec(rec.src))) {
        if (lim && f === file && (c.index < lim[0] || c.index > lim[1])) continue;
        const before = rec.src.slice(Math.max(0, c.index - 12), c.index);
        if (/function\s*$/.test(before)) continue;
        const o = c.index + c[0].length - 1; const cl = matchClose(rec.src, o);
        const args = splitTop(rec.src.slice(o + 1, cl - 1), [","]);
        sites++;
        const a = args[idx];
        if (a === undefined || a.trim() === "") continue;
        const apos = o + 1 + rec.src.slice(o + 1, cl).indexOf(a);
        // judge the caller's property of that name (absent: the default applies)
        if (prop) { ok = this.objPropSafe(f, apos, a, name, stack) && ok; continue; }
        if (member) { ok = this.objPropSafe(f, apos, a, member, stack) && ok; continue; }
        ok = this.safe(f, apos, a, stack) && ok;
      }
    }
    if (!sites) { this.report(file, pos, name, `parameter of ${fname}() with no call site`); return false; }
    // Call sites are found only by `name(`. A helper also handed on as a value
    // (`.then(fn)`, `xs.map(fn)`, `fn.call(...)`, `{ render: fn }`) has callers
    // this search never sees, so that use is reported, never assumed safe.
    for (const [f, rec] of (aliases.length > 1 ? Object.entries(this.files) : where)) {
      // searched with every string, template text and regex blanked: a class
      // name like "seg-control" is not a use of seg()
      const code = rec.code || stripComments(rec.src, true);
      const skipRegions = [...code.matchAll(/\b(?:import|export)\s*\{[^}]*\}/g)].map(x => [x.index, x.index + x[0].length]);
      const vre = new RegExp(`(?<![\\w$.])(?:${aliases.join("|")})\\b(?![\\w$])(?!\\s*\\()`, "g"); let v;
      while ((v = vre.exec(code))) {
        if (lim && f === file && (v.index < lim[0] || v.index > lim[1])) continue;
        if (skipRegions.some(([a, b]) => v.index >= a && v.index < b)) continue;
        const before = code.slice(Math.max(0, v.index - 40), v.index);
        const after = code.slice(v.index + v[0].length, v.index + v[0].length + 40);
        if (/(?:\bfunction\s*\*?|\b(?:const|let|var))\s*$/.test(before)) continue; // its definition
        if (/^\s*=(?![=>])/.test(after)) continue;                                // assigned, not read
        if (/=\s*$/.test(before) && /^\s*;/.test(after) && /\bconst\s+[A-Za-z_$][\w$]*\s*=\s*$/.test(before)) continue; // an alias, followed above
        if (/[{,]\s*$/.test(before) && /^\s*:/.test(after)) continue;             // an object key of that name
        this.report(f, v.index, v[0], `${fname}() is also used as a value; its callers cannot be followed`);
        ok = false;
      }
    }
    return ok;
  }

  /** Property `key` of an object expression: an object literal, or a const bound to one. */
  objPropSafe(file, pos, expr, key, stack) {
    const obj = stripParens(expr);
    if (obj.startsWith("{") && matchClose(obj, 0) === obj.length) {
      let ok = true;
      for (const kv of splitTop(obj.slice(1, -1), [","])) {
        if (/^\s*\.\.\./.test(kv)) { this.report(file, pos, kv, `spread object: property ${key} not proven escaped`); ok = false; continue; }
        const km = kv.match(/^\s*([A-Za-z_$][\w$]*)\s*(:|$)/);
        if (!km || km[1] !== key) continue;
        const val = km[2] === ":" ? kv.slice(kv.indexOf(":") + 1) : key;
        ok = this.safe(file, pos + 1 + obj.indexOf(kv), val, stack) && ok;
      }
      return ok;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(obj)) {
      const sc = this.scopeOf(file, pos, obj);
      if (sc && !sc.param && !sc.loop) {
        const body = this.files[file].src.slice(sc.start, sc.end);
        const dm = new RegExp(`\\bconst\\s+${obj}\\s*=\\s*\\{`).exec(body);
        if (dm && !new RegExp(`(?<![.\\w$])${obj}\\s*(\\.[\\w$]+|\\[[^\\]]*\\])\\s*=(?![=>])`).test(body)) {
          const st = dm.index + dm[0].length - 1;
          return this.objPropSafe(file, sc.start + st, body.slice(st, matchClose(body, st)), key, stack);
        }
        // `const x = build(...)`: the property of every object the builder returns
        const cm = new RegExp(`\\bconst\\s+${obj}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*\\(`).exec(body);
        if (cm && this.defsFor(file, sc.start + cm.index, cm[1]).length) {
          const k = `or:${cm[1]}.${key}`; if (stack.includes(k)) return true;
          let ok = true, any = false;
          for (const d of this.defsFor(file, sc.start + cm.index, cm[1])) {
            const fb = this.files[d.file].src.slice(d.bodyStart, d.bodyEnd);
            const nested = innerBlocks(fb, 1, fb.length - 1).filter(([a]) => isFunctionBlock(fb, a));
            const rets = d.exprBody ? [[0, fb]] : [...fb.matchAll(/\breturn\b/g)].filter(r => !nested.some(([a, b]) => r.index > a && r.index < b)).map(r => [r.index + 6, fb.slice(r.index + 6, exprEnd(fb, r.index + 6))]);
            for (const [o, e] of rets) { if (!e.trim()) continue; any = true; ok = this.objPropSafe(d.file, d.bodyStart + o, e, key, [...stack, k]) && ok; }
          }
          if (any) return ok;
        }
      }
      if (sc && sc.param) { const k = `pm:${file}:${sc.start}:${obj}.${key}`; if (stack.includes(k)) return true; return this.paramSafe(file, pos, obj, sc, [...stack, k], key); }
    }
    this.report(file, pos, `${obj}.${key}`, "property of an object not proven escaped");
    return false;
  }

  /**
   * showModal's argument: only `message` is HTML (the title is set as text). The
   * argument may be an object literal, a ternary or `||` of them, or a call to a
   * first-party builder whose every return is one.
   */
  modalArg(file, pos, expr, stack) {
    const s = stripParens(expr);
    const at = pos + Math.max(0, expr.indexOf(s.slice(0, 8)));
    const t = ternary(s);
    if (t) { this.modalArg(file, at + s.indexOf(t[1]), t[1], stack); this.modalArg(file, at + s.lastIndexOf(t[2]), t[2], stack); return; }
    const or = splitTop(s, ["||", "??"]);
    if (or.length > 1) { let off = 0; for (const p of or) { const ix = s.indexOf(p, off); this.modalArg(file, at + ix, p, stack); off = ix + p.length; } return; }
    const and = splitTop(s, ["&&"]);
    if (and.length > 1) { const last = and[and.length - 1]; this.modalArg(file, at + s.lastIndexOf(last), last, stack); return; }
    if (s.startsWith("{") && matchClose(s, 0) === s.length) {
      let off = at + 1;
      for (const p of splitTop(s.slice(1, -1), [","])) {
        const pm = p.match(/^\s*message\s*:\s*/);
        if (pm) this.safe(file, off + pm[0].length, p.slice(pm[0].length), stack);
        else if (/^\s*message\s*$/.test(p)) this.safe(file, off, "message", stack);
        else if (/^\s*\.\.\./.test(p)) this.report(file, off, p, "spread into showModal options not proven safe");
        off += p.length + 1;
      }
      return;
    }
    const call = asCall(s);
    if (call && /^[A-Za-z_$][\w$]*$/.test(call.callee) && this.defsFor(file, at, call.callee).length) {
      const k = "m:" + call.callee; if (stack.includes(k)) return;
      for (const d of this.defsFor(file, at, call.callee)) {
        const body = this.files[d.file].src.slice(d.bodyStart, d.bodyEnd);
        if (d.exprBody) { this.modalArg(d.file, d.bodyStart, body, [...stack, k]); continue; }
        const re = /\breturn\b/g; let m;
        while ((m = re.exec(body))) { const st = m.index + 6; const e = body.slice(st, exprEnd(body, st)); if (e.trim() && !/^\s*(null|undefined|false)\s*$/.test(e)) this.modalArg(d.file, d.bodyStart + st, e, [...stack, k]); }
      }
      return;
    }
    if (/^(null|undefined|false)$/.test(s)) return;
    this.report(file, at, s, "showModal argument not understood");
  }

  /**
   * A write into an element of an INERT document (`document.implementation.
   * createHTMLDocument(...)`) is a parse, not a render: nothing in it loads, runs
   * or is shown. The sanitiser and the paste normaliser parse raw HTML that way
   * on purpose, then serialise only what they keep.
   */
  isInertTarget(file, pos, target) {
    const t = stripParens(target || "").replace(/\.body$/, "");
    if (!/^[A-Za-z_$][\w$]*$/.test(t)) return false;
    const sc = this.scopeOf(file, pos, t);
    if (!sc || sc.param || sc.loop) return false;
    const body = this.files[file].src.slice(sc.start, sc.end);
    const dm = new RegExp(`\\bconst\\s+${t}\\s*=\\s*`).exec(body);
    if (!dm) return false;
    const rhs = body.slice(dm.index + dm[0].length, exprEnd(body, dm.index + dm[0].length));
    return /^document\.implementation\.createHTMLDocument\([^()]*\)(\.createElement\([^()]*\))?$/.test(rhs.trim());
  }

  /** Scan every sink. */
  run() {
    for (const [file, rec] of Object.entries(this.files)) {
      if (file === "public/js/core/trusted-types.js") continue; // the sink's own definition
      const src = rec.src; let m; SINK_RE.lastIndex = 0;
      while ((m = SINK_RE.exec(src))) {
        const kind = m[1] || m[2] || m[3] || m[4];
        let arg = null, apos = 0;
        if (m[0].endsWith("(")) {
          const o = m.index + m[0].length - 1; const c = matchClose(src, o);
          const inner = src.slice(o + 1, c - 1); const args = splitTop(inner, [","]);
          if (/function\s*$/.test(src.slice(Math.max(0, m.index - 10), m.index)) || /export\s+function\s*$/.test(src.slice(Math.max(0, m.index - 20), m.index + 1))) continue;
          this.currentSink = `${file}:${this.line(file, m.index)}`;
          if (kind === "showModal") { this.sinkCount++; this.modalArg(file, o + 1, inner, []); continue; }
          if (kind === "_countdownConfirm") continue; // escapes its own `name` (ui/modal.js) and renders typeLabel as text
          const ix = kind === "setSafeHtml" || kind === "setSafeSrcdoc" || kind === "insertAdjacentHTML" ? 1 : 0;
          arg = args[ix]; if (arg === undefined) continue;
          // showModal's own body: its `message` is judged at every call site (modalArg)
          if (file === "public/js/ui/modal.js" && arg.trim() === "message") continue;
          if (kind === "setSafeHtml" && this.isInertTarget(file, m.index, args[0])) { this.inertCount++; continue; }
          apos = o + 1 + args.slice(0, ix).reduce((n, a) => n + a.length + 1, 0);
        } else {
          const recv = (src.slice(Math.max(0, m.index - 80), m.index).match(/[A-Za-z_$][\w$.]*$/) || [""])[0];
          if (this.isInertTarget(file, m.index, recv)) { this.inertCount++; continue; }
          apos = m.index + m[0].length; const e = exprEnd(src, apos); arg = src.slice(apos, e);
        }
        this.sinkCount++;
        this.currentSink = `${file}:${this.line(file, m.index)}`;
        this.safe(file, apos, arg);
      }
    }
    // de-duplicate
    const seen = new Set();
    this.findings = this.findings.filter(f => { const k = `${f.file}:${f.line}:${f.expr}`; if (seen.has(k)) return false; seen.add(k); return true; });
    return this.findings;
  }
}

/** End of an expression starting at st: top-level `;`, or a newline that does not continue it, or a closing bracket. */
function exprEnd(s, st) {
  let i = st;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') { i++; while (i < s.length && s[i] !== c && s[i] !== "\n") { if (s[i] === "\\") i++; i++; } i++; continue; }
    if (c === "`") { i = skipTemplate(s, i); continue; }
    if (c === "(" || c === "[" || c === "{") { i = matchClose(s, i); continue; }
    if (c === ")" || c === "]" || c === "}" || c === ";" || c === ",") return i;
    if (c === "\n") {
      const prevTxt = s.slice(st, i).trimEnd(); const nextTxt = s.slice(i + 1).trimStart();
      if (prevTxt === "" || /[+\-*/%?:&|=<>,(\[{.!]$/.test(prevTxt) || /^([?:+\-*/%&|.]|\?\?)/.test(nextTxt)) { i++; continue; }
      return i;
    }
    i++;
  }
  return i;
}
/** Does the `{` at `open` start a function body (`=> {`, `function f(…) {`, a method), not a statement block? */
function isFunctionBlock(src, open) {
  const before = src.slice(Math.max(0, open - 400), open).replace(/\s+$/, "");
  if (/=>$/.test(before)) return true;
  if (!before.endsWith(")")) return false;
  // find the matching "(" and look at the word in front of it
  let d = 0, i = before.length - 1;
  for (; i >= 0; i--) { if (before[i] === ")") d++; else if (before[i] === "(") { d--; if (d === 0) break; } }
  const word = (before.slice(0, Math.max(0, i)).match(/([A-Za-z_$][\w$]*)\s*$/) || [])[1];
  return !/^(if|for|while|switch|catch|with)$/.test(word || "");
}
function innerBlocks(src, a, b) {
  const out = []; const st = [];
  for (let i = a; i < b; i++) { if (src[i] === "{") st.push(i); else if (src[i] === "}") { const x = st.pop(); if (x !== undefined) out.push([x, i + 1]); } }
  return out;
}
function lineStarts(src) { const o = [0]; for (let i = 0; i < src.length; i++) if (src[i] === "\n") o.push(i + 1); return o; }

function scan(root, opts) { const s = new Scanner(root, opts); const findings = s.run(); return { findings, sinkCount: s.sinkCount, scanner: s }; }
module.exports = { scan, stripComments, Scanner, NUMERIC_PROPS, SAFE_CALLEES };

if (require.main === module) {
  const r = scan(process.argv[2] || path.join(__dirname, ".."));
  for (const f of r.findings) console.log(`${f.file}:${f.line}: ${f.expr}   [${f.why}]  <- ${f.sink}`);
  console.error(`sinks=${r.sinkCount} findings=${r.findings.length}`);
}
