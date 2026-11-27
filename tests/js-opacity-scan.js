"use strict";
// EVERY OPACITY THE SPA'S OWN JAVASCRIPT WRITES, AND WHAT IT CAN SET.
//
// The rule (CLAUDE.md *Recurring rules*; DESIGN_SYSTEM §7 and §10): never dim a
// text-bearing surface with `opacity`, and a disabled control never fades. A
// stylesheet scan cannot see a fade written from JavaScript, and a scan for a
// literal straight after the operator (`opacity:.5`, `opacity='0.5'`) cannot see
// one written through an expression: `btn.style.opacity=changed?'1':'0.5'` faded
// the Assign to Events dialog's disabled Save button past exactly such a scan.
//
// So this reads the VALUE of every opacity write, whatever expression supplies it:
//   * a property write: `x.opacity = v`, `x['opacity'] = v` (and `+=` …);
//   * a setter: `setProperty('opacity', v)`, `setAttribute('opacity', v)`;
//   * an object key: `{opacity: v}` (`Object.assign(el.style, …)`, `animate()`
//     keyframes, any options object), but not a destructuring read;
//   * a CSS declaration inside a string or template: `"…;opacity:.5"`,
//     `style="opacity:${v}"`, `'opacity:' + v`;
//   * a markup attribute: `<rect opacity="…">`.
// and judges it:
//   ok      — every value it can take is 0, 1 or a clear ('', null): a show, a
//             hide, or handing the element back to the stylesheet;
//   dim     — some value lies strictly between 0 and 1, anywhere in the value
//             (a conditional's branch, a call's argument, an interpolation);
//   unknown — a value the scanner cannot read (a variable, a call, var(), calc()):
//             make it a literal, or record a decision for the site.
// A conditional's CONDITION decides nothing about the value, so
// `progress > 0.5 ? '1' : '0'` is a show/hide. A name merely containing the word
// (`rowOpacity`, `fill-opacity`, `--x-opacity`) and a mention that writes nothing
// (`transition:opacity …`, `removeProperty('opacity')`, a read) are not writes.
//
// Input is comment-stripped source (tests/doc-registry.js `stripJsComments`).

const OK = "ok", DIM = "dim", UNKNOWN = "unknown";
const RANK = { [OK]: 0, [UNKNOWN]: 1, [DIM]: 2 };
const worst = (...vs) => vs.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), OK);
const frac = (v) => Number.isFinite(v) && v > 0 && v < 1;
const isPunct = (t, chars) => t && t.type === "punct" && chars.includes(t.value);

// ── a small lexer for one value ─────────────────────────────────────────────
function readQuoted(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== q && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
  return { value: src.slice(i + 1, Math.min(j, src.length)), end: src[j] === q ? j + 1 : j };
}
/** The index of the `}` that closes the brace-level `i` sits in (an interpolation, an object). */
function closingBrace(src, i) {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') { i = readQuoted(src, i).end; continue; }
    if (c === "`") { i = readTemplate(src, i).end; continue; }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "}") { if (depth === 0) return i; depth--; }
    i++;
  }
  return src.length;
}
function readTemplate(src, i) {
  const parts = [""], exprs = [];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "`") return { parts, exprs, end: j + 1 };
    if (c === "\\") { parts[parts.length - 1] += src.slice(j, j + 2); j += 2; continue; }
    if (c === "$" && src[j + 1] === "{") {
      const close = closingBrace(src, j + 2);
      exprs.push(src.slice(j + 2, close));
      parts.push("");
      j = close + 1;
      continue;
    }
    parts[parts.length - 1] += c;
    j++;
  }
  return { parts, exprs, end: j };
}
const OPERATOR = /^(?:\?\?=?|\?\.(?!\d)|\|\|=?|&&=?|===?|!==?|=>|<=|>=|\+\+|--|\*\*=?|[-+*/%]=|[-+*/%<>!=?:~^|&.])/;
/**
 * The tokens of the JS expression starting at `i`, up to a terminator at depth 0:
 * `;`, `,`, a closing bracket it did not open, a line break the expression does
 * not continue over, or (with `stopAtPlus`, one operand of a concatenation) `+`.
 */
function lexExpr(src, i, { stopAtPlus = false } = {}) {
  const tokens = [];
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n" && depth === 0) {
      const last = tokens[tokens.length - 1];
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      const lastIsOp = !last || (last.type === "punct" && !")]}".includes(last.value));
      if (!lastIsOp && !/^(?:[?:.|&*/%]|\+(?!\+))/.test(src.slice(j, j + 2))) break;
      i++;
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') { const s = readQuoted(src, i); tokens.push({ type: "str", value: s.value }); i = s.end; continue; }
    if (c === "`") { const t = readTemplate(src, i); tokens.push({ type: "tpl", parts: t.parts, exprs: t.exprs }); i = t.end; continue; }
    const num = /^(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][-+]?\d+)?/.exec(src.slice(i, i + 40));
    if (num) { tokens.push({ type: "num", value: Number(num[0].replace(/_/g, "")) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 80));
    if (id) { tokens.push({ type: "ident", value: id[0] }); i += id[0].length; continue; }
    if ("([{".includes(c)) { depth++; tokens.push({ type: "punct", value: c }); i++; continue; }
    if (")]}".includes(c)) { if (depth === 0) break; depth--; tokens.push({ type: "punct", value: c }); i++; continue; }
    if ((c === ";" || c === ",") && depth === 0) break;
    if (stopAtPlus && depth === 0 && c === "+" && src[i + 1] !== "+" && src[i + 1] !== "=") break;
    const op = OPERATOR.exec(src.slice(i, i + 4));
    const v = op ? op[0] : c;
    tokens.push({ type: "punct", value: v });
    i += v.length;
  }
  return { tokens, end: i };
}

// ── judging a value ──────────────────────────────────────────────────────────
const NUMBER_TEXT = /(?<![\w.$-])(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(%?)/gi;
function anyFractionText(s) {
  for (const m of String(s).matchAll(NUMBER_TEXT)) {
    if (frac(parseFloat(m[0]) / (m[1] ? 100 : 1))) return true;
  }
  return false;
}
function anyFraction(tokens) {
  return tokens.some((t) => (t.type === "num" ? frac(t.value)
    : t.type === "str" ? anyFractionText(t.value)
      : t.type === "tpl" ? t.parts.some(anyFractionText) || t.exprs.some((e) => anyFraction(lexExpr(e, 0).tokens))
        : false));
}
/** A CSS opacity value as text: '' clears it; a number or a percentage is read. */
function judgeCssText(text) {
  const t = String(text).replace(/!\s*important/i, "").trim();
  if (t === "") return OK;
  const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(%)?$/i.exec(t);
  if (m) return frac(parseFloat(t) / (m[1] ? 100 : 1)) ? DIM : OK;
  return anyFractionText(t) ? DIM : UNKNOWN;
}
/** `( … )` around the whole value, removed (repeatedly). */
function stripParens(t) {
  while (t.length >= 2 && isPunct(t[0], "(") && isPunct(t[t.length - 1], ")")) {
    let depth = 0, wraps = true;
    for (let k = 0; k < t.length; k++) {
      if (isPunct(t[k], "([{")) depth++;
      else if (isPunct(t[k], ")]}")) { depth--; if (depth === 0 && k < t.length - 1) { wraps = false; break; } }
    }
    if (!wraps) break;
    t = t.slice(1, -1);
  }
  return t;
}
function judgeTokens(tokens) {
  const t = stripParens(tokens);
  if (!t.length) return UNKNOWN;
  // The conditional operator: only its two branches can be the value.
  let depth = 0, q = -1;
  for (let k = 0; k < t.length && q < 0; k++) {
    if (isPunct(t[k], "([{")) depth++;
    else if (isPunct(t[k], ")]}")) depth--;
    else if (depth === 0 && isPunct(t[k], "?")) q = k;
  }
  if (q >= 0) {
    let d = 0, nested = 0;
    for (let k = q + 1; k < t.length; k++) {
      const x = t[k];
      if (isPunct(x, "([{")) d++;
      else if (isPunct(x, ")]}")) d--;
      else if (d === 0 && x.type === "punct" && x.value === "?") nested++;
      else if (d === 0 && x.type === "punct" && x.value === ":") {
        if (nested) { nested--; continue; }
        return worst(judgeTokens(t.slice(q + 1, k)), judgeTokens(t.slice(k + 1)));
      }
    }
    return anyFraction(t.slice(q + 1)) ? DIM : UNKNOWN;
  }
  if (t.length === 1) {
    const x = t[0];
    if (x.type === "num") return frac(x.value) ? DIM : OK;
    if (x.type === "str") return judgeCssText(x.value);
    if (x.type === "tpl") {
      if (!x.exprs.length) return judgeCssText(x.parts.join(""));
      if (x.exprs.length === 1 && x.parts.every((p) => p.trim() === "")) return judgeTokens(lexExpr(x.exprs[0], 0).tokens);
      return anyFraction(t) ? DIM : UNKNOWN;
    }
    if (x.type === "ident" && (x.value === "null" || x.value === "undefined")) return OK;
    return UNKNOWN;
  }
  // `String(v)` / `Number(v)` hand on their argument.
  if (t[0].type === "ident" && (t[0].value === "String" || t[0].value === "Number")
    && isPunct(t[1], "(") && isPunct(t[t.length - 1], ")") && stripParens(t.slice(1)).length < t.length - 1) {
    return judgeTokens(t.slice(1));
  }
  // Anything else — a call, a member, arithmetic, `a || b`: a fraction written
  // inside it is still a fade; otherwise the scanner cannot read it.
  return anyFraction(t) ? DIM : UNKNOWN;
}

/** A CSS declaration's value, from `i` (just after its colon) to the declaration's end. */
function readCssValue(src, i) {
  let text = "";
  const exprs = [];
  while (i < src.length) {
    const c = src[i];
    if (c === "$" && src[i + 1] === "{") {
      const close = closingBrace(src, i + 2);
      exprs.push(src.slice(i + 2, close));
      i = close + 1;
      continue;
    }
    if (";\"'`}\n".includes(c)) break;
    text += c;
    i++;
  }
  return { text, exprs, end: i };
}
function judgeCssValue(src, i) {
  const v = readCssValue(src, i);
  let verdict;
  if (!v.exprs.length && v.text.trim() === "" && /["'`]/.test(src[v.end] || "")) {
    // `'opacity:' + v`: the value is the operand concatenated after the string.
    const plus = /^\s*\+(?![+=])/.exec(src.slice(v.end + 1, v.end + 40));
    if (!plus) return { verdict: UNKNOWN, end: v.end };
    const e = lexExpr(src, v.end + 1 + plus[0].length, { stopAtPlus: true });
    return { verdict: judgeTokens(e.tokens), end: e.end };
  } else if (!v.exprs.length) verdict = judgeCssText(v.text);
  else if (v.exprs.length === 1 && v.text.replace(/!\s*important/i, "").trim() === "") verdict = judgeTokens(lexExpr(v.exprs[0], 0).tokens);
  else verdict = anyFractionText(v.text) || v.exprs.some((e) => anyFraction(lexExpr(e, 0).tokens)) ? DIM : UNKNOWN;
  return { verdict, end: v.end };
}

// ── finding the writes ───────────────────────────────────────────────────────
const NAME = /(?<![\w$-])opacity(?![\w$-])/g;
const prevNonSpace = (src, i) => { let k = i - 1; while (k >= 0 && /\s/.test(src[k])) k--; return k >= 0 ? src[k] : ""; };
/** `{ opacity: o } = …` — a destructuring READ, not an object being written. */
const destructured = (src, after) => { const close = closingBrace(src, after); return /^\s*=(?![=>])/.test(src.slice(close + 1, close + 8)); };

/**
 * Every opacity write in comment-stripped source:
 * [{ at, shape, verdict, text }], `text` running from the name to the value's end.
 */
function opacityWrites(src) {
  const out = [];
  for (const m of src.matchAll(NAME)) {
    const at = m.index, after = at + m[0].length;
    const rest = src.slice(after, after + 200);
    const before = src.slice(Math.max(0, at - 60), at);
    let shape = null, verdict = UNKNOWN, end = after;
    if (/^["']/.test(rest) && /["']$/.test(before)) {
      // A quoted NAME: a bracket write, a quoted key, or a setter's first argument.
      const pre = before.slice(0, -1);
      const bracket = /^["']\s*\]\s*(?:[-+*/]?=)(?![=>])/.exec(rest);
      const key = /^["']\s*:/.exec(rest);
      const arg = /^["']\s*,/.exec(rest);
      let from = -1;
      if (bracket && /\[\s*$/.test(pre)) { shape = "property"; from = after + bracket[0].length; }
      else if (key && /[{,]\s*$/.test(pre) && !destructured(src, after + 1)) { shape = "key"; from = after + key[0].length; }
      else if (arg && /\.(?:setProperty|setAttribute)\(\s*$|\.setAttributeNS\([^,()]*,\s*$/.test(pre)) { shape = "call"; from = after + arg[0].length; }
      if (!shape) continue;
      const e = lexExpr(src, from);
      verdict = judgeTokens(e.tokens); end = e.end;
    } else {
      const assign = /^\s*(?:[-+*/]?=)(?![=>])/.exec(rest);
      const colon = /^\s*:/.exec(rest);
      const prev = prevNonSpace(src, at);
      if (assign && prev === ".") {
        shape = "property";
        const e = lexExpr(src, after + assign[0].length);
        verdict = judgeTokens(e.tokens); end = e.end;
      } else if (/^=["']/.test(rest) && /\s/.test(src[at - 1] || "") && !/(?:\b(?:let|const|var)\s+|,\s*)$/.test(before)) {
        shape = "attribute";
        const r = judgeCssValue(src, after + 2);
        verdict = r.verdict; end = r.end;
      } else if (colon && (prev === "{" || prev === ",") && !destructured(src, after)) {
        shape = "key";
        const e = lexExpr(src, after + colon[0].length);
        verdict = judgeTokens(e.tokens); end = e.end;
      } else if (colon && prev !== "" && ";\"'`}".includes(prev)) {
        shape = "css";
        const r = judgeCssValue(src, after + colon[0].length);
        verdict = r.verdict; end = r.end;
      } else continue;
    }
    out.push({ at, shape, verdict, text: src.slice(at, Math.max(end, after)).replace(/\s+/g, " ").trim() });
  }
  return out;
}

module.exports = { opacityWrites, OK, DIM, UNKNOWN };
