// @ts-check
//
// v8.13.3 — NO CATCH BLOCK HANDS THE CAUGHT ERROR'S TEXT TO THE CLIENT UNLESS A
// DELIBERATE-REFUSAL MARKER GUARDS IT.
//
// THE DEFECT THIS CLOSES, AND WHY IT IS A CLASS. `POST` / `PUT
// /api/admin/tasks/:id/competitions` answered every throw from their
// transactions as `400 {error: e.message, code: e.code, refused: []}`: a
// SQLITE_BUSY from an operator's sqlite3 session, a failed constraint, a strict
// predicate refusing an under-selected row (lib/staff-compete.js's
// `_requireKey`, written to fail LOUDLY) — each reached the admin as the
// driver's own text under a status saying their request was wrong, with no log
// line. `GET /api/admin/logs/files` echoed an fs error naming the absolute log
// path as `detail`. The cure is the same at both: a refusal meant for the caller
// is MARKED where it is thrown (`{userError: true, error}` — the codebase's
// existing deliberate-refusal object, routes/competitions.js and
// routes/admin-misc.js's CxOne key, server.js's participant import), and
// anything unmarked goes to the global error handler, which logs it with its
// stack and answers a generic 500. A sentence cannot enumerate the next catch
// block somebody writes, so this is a scanner.
//
// WHAT IT READS. server.js + routes/** + lib/**. For every `catch (v) { … }`
// body, every `res[.status(…)].json(` / `.send(` call whose argument reads
//   v.message, v.stack, String(v), `${v…}`, a bare `v`, or — ONE level of
//   by-name indirection — a name bound in the same body to such an expression
// must be GUARDED: either the statement is `if (v[ && ]v.<marker>) … res…`, or
// the call sits inside the block of such an `if`, where <marker> is
// `userError`, `conflict` or `forbidden` (the three sentinel shapes the
// codebase throws on purpose). A block-form guard is recognised as well as the
// one-line form; a scanner that flagged the correct block form would be the
// scanner the next person silences.
//
// HOW IT READS IT, and why a lexer rather than a regex. The reviewer's warning
// was concrete: a brace or `*/` inside a STRING (server.js carries
// `badge/*.ttf`) desynchronises a regex stripper and silently drops the tail of
// a file from the scan. So the source is MASKED by a small lexer — comments
// blanked, string / template / regex-literal CONTENTS blanked, length and
// newlines preserved — and every structural question (where a catch body ends,
// where a call's argument ends, which `if` encloses what) is asked of the mask,
// and so is the TAINT: the mask keeps every `${ … }` substitution as code, so
// `${v.message}` still reads as an echo while the WORDS of a string do not — a
// catch named `e` answering "The e-mail could not be sent", or one named `error`
// answering `{ error: "Failed to save." }`, is not an echo, and reading the taint
// from the unmasked text flagged both (the pre-release review). The comment-
// stripped text is read only where string CONTENTS are the point: locating the
// `NODE_ENV === "test"` blocks, and the marker-guard condition. A bare catch
// variable in object-KEY position (after `{` or `,`, before `:`) is a key, not a
// value; the shorthand `{ error }` is still an echo. The lexer is self-checked:
// every scanned file must come out brace- and paren-balanced, or the test fails
// naming the file rather than trusting a desynchronised read.
//
// TEST-ONLY CODE IS OUT OF SCOPE: every `if (process.env.NODE_ENV === "test")
// { … }` block is blanked first (server.js's test routes echo errors to the
// spec that called them, on purpose).
//
// EXEMPT — a decision per site, each with a reason over forty characters, and a
// stale exemption FAILS (the site must still exist and still be flagged).
//
// FLOORS, so a rename or a lexer regression cannot empty the match and pass in
// silence: a minimum number of catch clauses overall and in server.js alone,
// and the two assignment catches NAMED — found by the transaction each wraps,
// required to carry the marker guard AND to re-throw.
//
// STATED LIMITS (what this does NOT see): deeper indirection than one name; an
// error handed to a helper that writes the response; a callback-form handler
// `(err) => res.status(…).json({ error: err.message })` (no `catch` keyword —
// the only instance at the time of writing is test-only, server.js's
// NODE_ENV block); `res.end`, `res.type(…).send` and HTML renderers such as
// `_emailResultPage`; and the "silent wrong status" half (a catch that answers a
// fixed 4xx for an internal error without echoing it) — for the two assignment
// routes that half is pinned behaviourally by
// tests/challenge-assign-input-shapes.api.spec.js.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// Byte-identical to `_stripJsCommentsKeepLines` in functional-core-b's Docs
// hygiene describe, which is describe-local and exported from nowhere; this
// file may not edit that one to export it, so this is a deliberate, recorded
// copy (the session-slide-polls precedent). It is read ONLY where string
// CONTENTS matter: locating the `NODE_ENV === "test"` blocks, evaluating the
// marker-guard condition (block and one-line forms) and printing a finding's
// snippet. Every structural question and the taint read itself are asked of the
// lexer mask below.
function _stripJsCommentsKeepLines(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (m, pre) =>
    pre === undefined ? m.replace(/[^\n]/g, " ") : pre + " ".repeat(m.length - pre.length));
}

/**
 * The structural mask: comments and the CONTENTS of strings, templates and
 * regex literals become spaces (delimiters kept, newlines kept, length kept).
 * Template `${ … }` substitutions are CODE and are scanned as such.
 */
function maskJs(src) {
  const out = src.split("");
  const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  const KW_BEFORE_REGEX = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|instanceof|yield|await|else|do)$/;
  // A stack of open template literals: each entry is the brace depth at which
  // its current `${` substitution closes.
  const tpl = [];
  let depth = 0;
  let i = 0;
  const prevSignificant = (k) => { let j = k - 1; while (j >= 0 && /\s/.test(out[j])) j--; return j; };
  // Scan a template literal's text from `i` (just past the opening backtick or
  // a closing `}` of a substitution). Returns the index after the closing
  // backtick, or the index just past a `${` (pushing the substitution).
  const scanTemplateText = (k) => {
    const start = k;
    while (k < n) {
      const c = src[k];
      if (c === "\\") { k += 2; continue; }
      if (c === "`") { blank(start, k); return { next: k + 1, opened: false }; }
      if (c === "$" && src[k + 1] === "{") { blank(start, k); return { next: k + 2, opened: true }; }
      k++;
    }
    blank(start, n);
    return { next: n, opened: false };
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { const e = src.indexOf("\n", i); const end = e === -1 ? n : e; blank(i, end); i = end; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const end = e === -1 ? n : e + 2; blank(i, end); i = end; continue; }
    if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
      blank(i + 1, k); i = k + 1; continue;
    }
    if (c === "`") {
      const r = scanTemplateText(i + 1);
      if (r.opened) { tpl.push(depth); depth++; }
      i = r.next; continue;
    }
    if (c === "/") {
      const j = prevSignificant(i);
      const prev = j < 0 ? "" : out[j];
      const before = src.slice(Math.max(0, j - 12), j + 1);
      if (j < 0 || "(,=:[!&|?{};+-*%<>~^".includes(prev) || KW_BEFORE_REGEX.test(before)) {
        let k = i + 1, inClass = false;
        while (k < n && src[k] !== "\n") {
          const ch = src[k];
          if (ch === "\\") { k += 2; continue; }
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) break;
          k++;
        }
        blank(i + 1, k); i = k + 1; continue;
      }
    }
    if (c === "{") { depth++; i++; continue; }
    if (c === "}") {
      depth--;
      if (tpl.length && tpl[tpl.length - 1] === depth) {
        tpl.pop();
        const r = scanTemplateText(i + 1);
        if (r.opened) { tpl.push(depth); depth++; }
        i = r.next; continue;
      }
      i++; continue;
    }
    i++;
  }
  return out.join("");
}

/** Index of the bracket closing the one at `open`, read on the MASK. */
function closeOf(mask, open) {
  const o = mask[open], cl = { "{": "}", "(": ")", "[": "]" }[o];
  let dep = 0;
  for (let k = open; k < mask.length; k++) {
    if (mask[k] === o) dep++;
    else if (mask[k] === cl && --dep === 0) return k;
  }
  return -1;
}

function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }

function sourceFiles() {
  const out = ["server.js"];
  for (const dir of ["routes", "lib"]) {
    (function walk(rel) {
      for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const r = path.join(rel, e.name);
        if (e.isDirectory()) walk(r);
        else if (e.name.endsWith(".js")) out.push(r);
      }
    })(dir);
  }
  return out;
}

const MARKER_GUARD = v => new RegExp(`^if\\s*\\(\\s*(?:${v}\\s*&&\\s*)?${v}\\??\\.(?:userError|conflict|forbidden)\\b`);
const TAINT = v => new RegExp(
  `\\b${v}\\s*\\??\\.\\s*(?:message|stack)\\b|String\\(\\s*${v}\\s*\\)|\\$\\{\\s*${v}\\b|(?<![\\w$.])${v}(?![\\w$])(?!\\s*\\??\\.)(?!\\s*\\()(?!(?<=[{,]\\s*${v})\\s*:)`);

/**
 * Scan one file. Returns { catches, findings[] } where each finding is
 * { file, line, catchVar, call } for an UNGUARDED echo.
 */
function scanFile(rel) {
  return scanSource(rel, fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

/** The scan proper, over a source string (`scanFile` reads it from disk). */
function scanSource(rel, raw) {
  let text = _stripJsCommentsKeepLines(raw);
  let mask = maskJs(raw);
  // Self-check: a desynchronised lexer would make every structural answer
  // below wrong while still finding SOMETHING, so balance is asserted per file.
  const count = (s, ch) => s.split(ch).length - 1;
  const balanced = count(mask, "{") === count(mask, "}") && count(mask, "(") === count(mask, ")");
  // Blank every test-only block in BOTH views (same offsets).
  const testBlock = /if\s*\(\s*process\.env\.NODE_ENV\s*===\s*["']test["']\s*\)\s*\{/g;
  for (let m; (m = testBlock.exec(text));) {
    const open = m.index + m[0].length - 1;
    if (mask[open] !== "{") continue;
    const close = closeOf(mask, open);
    if (close < 0) continue;
    const span = s => s.slice(0, open + 1) + s.slice(open + 1, close).replace(/[^\n]/g, " ") + s.slice(close);
    text = span(text); mask = span(mask);
  }
  const findings = [];
  let catches = 0;
  const catchRe = /\bcatch\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*\))?\s*\{/g;
  for (let m; (m = catchRe.exec(mask));) {
    catches++;
    const v = m[1];
    if (!v) continue;
    const open = m.index + m[0].length - 1;
    const close = closeOf(mask, open);
    if (close < 0) continue;
    const bodyMask = mask.slice(open + 1, close);
    const bodyText = text.slice(open + 1, close);
    const taint = TAINT(v);
    // One level of by-name indirection: `const x = …v.message…;`
    const tainted = new Set();
    const bind = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
    for (let b; (b = bind.exec(bodyMask));) {
      const from = b.index + b[0].length;
      let to = bodyMask.indexOf(";", from);
      if (to < 0) to = bodyMask.length;
      if (taint.test(bodyMask.slice(from, to))) tainted.add(b[1]);
    }
    const reads = s => taint.test(s) || [...tainted].some(x => new RegExp(`(?<![\\w$.])${x}(?![\\w$])(?!(?<=[{,]\\s*${x})\\s*:)`).test(s));
    // Every `if (<guard>) {` block in this body: calls inside it are guarded.
    const guardBlocks = [];
    const ifRe = /\bif\s*\(/g;
    for (let g; (g = ifRe.exec(bodyMask));) {
      const pOpen = g.index + g[0].length - 1;
      const pClose = closeOf(bodyMask, pOpen);
      if (pClose < 0) continue;
      const cond = bodyText.slice(g.index, pClose + 1);
      if (!MARKER_GUARD(v).test(cond)) continue;
      const after = bodyMask.slice(pClose + 1).match(/^\s*\{/);
      if (after) {
        const bOpen = pClose + 1 + after[0].length - 1;
        guardBlocks.push([bOpen, closeOf(bodyMask, bOpen)]);
      }
    }
    const callRe = /\bres\s*(?:\.\s*status\s*\([^)]*\))?\s*\.\s*(?:json|send)\s*\(/g;
    for (let c; (c = callRe.exec(bodyMask));) {
      const aOpen = c.index + c[0].length - 1;
      const aClose = closeOf(bodyMask, aOpen);
      const arg = bodyMask.slice(aOpen + 1, aClose < 0 ? bodyMask.length : aClose);
      if (!reads(arg)) continue;
      if (guardBlocks.some(([a, b]) => c.index > a && c.index < b)) continue;
      // The one-statement form: from the statement's start to the call.
      let s = c.index - 1;
      while (s >= 0 && !";{}".includes(bodyMask[s])) s--;
      const stmt = bodyText.slice(s + 1, c.index).trim();
      if (MARKER_GUARD(v).test(stmt)) continue;
      findings.push({ file: rel, line: lineOf(raw, open + 1 + c.index), catchVar: v, call: bodyText.slice(c.index, Math.min(bodyText.length, (aClose < 0 ? c.index + 120 : aClose + 1))).replace(/\s+/g, " ").slice(0, 160) });
    }
  }
  return { catches, findings, balanced, raw, text, mask };
}

// A decision per site. `route` locates the handler by its registration; a
// finding inside that handler is exempt.
const EXEMPT = [
  {
    file: "routes/admin-misc.js",
    route: "/api/admin/test-email",
    reason: "A superadmin-only SMTP diagnostic: the try wraps the send, and echoing the relay's refusal (capped at 300 characters, answered 502, audited) is the endpoint's whole purpose.",
  },
];

function handlerSpan(raw, mask, route) {
  const at = raw.indexOf(`"${route}"`);
  if (at < 0) return null;
  const next = mask.slice(at + route.length + 2).search(/\bapp\.(?:get|post|put|patch|delete)\s*\(/);
  return [at, next < 0 ? raw.length : at + route.length + 2 + next];
}

test.describe("v8.13.3 — a caught error's text reaches the client only behind a deliberate-refusal marker", () => {
  test("the lexer reads every scanned file balanced, and the scan covers what it claims", () => {
    let total = 0, serverCatches = 0;
    const unbalanced = [];
    for (const rel of sourceFiles()) {
      const r = scanFile(rel);
      total += r.catches;
      if (rel === "server.js") serverCatches = r.catches;
      if (!r.balanced) unbalanced.push(rel);
    }
    expect(unbalanced, "the lexer desynchronised on these files — its structural reads cannot be trusted").toEqual([]);
    // Floors: measured at 470+ overall and 130+ in server.js when written. A
    // regression that drops a file's tail (the string-`*/` hazard) or a rename
    // of the keyword match would fall below these rather than pass in silence.
    expect(total, "catch clauses scanned across server.js + routes/** + lib/**").toBeGreaterThanOrEqual(400);
    expect(serverCatches, "catch clauses scanned in server.js alone").toBeGreaterThanOrEqual(100);
  });

  test("no unguarded echo anywhere, and every exemption is still live", () => {
    const all = [];
    const scans = new Map();
    for (const rel of sourceFiles()) {
      const r = scanFile(rel);
      scans.set(rel, r);
      all.push(...r.findings);
    }
    const exemptHits = new Map(EXEMPT.map(e => [e, 0]));
    const unguarded = [];
    for (const f of all) {
      const ex = EXEMPT.find(e => {
        if (e.file !== f.file) return false;
        const r = scans.get(f.file);
        const span = handlerSpan(r.raw, r.mask, e.route);
        if (!span) return false;
        const lineStart = r.raw.split("\n").slice(0, f.line - 1).join("\n").length;
        return lineStart >= span[0] && lineStart < span[1];
      });
      if (ex) exemptHits.set(ex, exemptHits.get(ex) + 1);
      else unguarded.push(`${f.file}:${f.line}  catch (${f.catchVar})  ${f.call}`);
    }
    expect(unguarded, "a catch block hands the caught error's text to the client with no deliberate-refusal marker guarding it — mark the refusal where it is thrown ({ userError: true, error }) and re-throw everything else to the global handler").toEqual([]);
    for (const e of EXEMPT) {
      expect(e.reason.length, `the exemption for ${e.file} ${e.route} states a reason`).toBeGreaterThan(40);
      expect(exemptHits.get(e), `STALE exemption: ${e.file} ${e.route} no longer echoes — remove the entry`).toBeGreaterThan(0);
    }
  });

  test("planted shapes: a catch variable that is only a KEY or a WORD is not an echo, and every real echo still is", () => {
    // NEGATIVE controls — the pre-release review's two false positives. A scanner
    // that is wrong about working code is the scanner the next person silences.
    const clean = [
      ["catch (error) + an `error` KEY", 'app.post("/x", (req, res) => { try { go(); } catch (error) { return res.status(500).json({ error: "Failed to save." }); } });'],
      ["catch (e) + the word e-mail", 'app.post("/x", (req, res) => { try { go(); } catch (e) { res.status(502).json({ error: "The e-mail could not be sent." }); } });'],
      ["catch (err) + a string bound to a name", 'app.post("/x", (req, res) => { try { go(); } catch (err) { const msg = "err: retry later"; res.status(500).json({ error: msg }); } });'],
      ["catch (e) + the marker guard", 'app.post("/x", (req, res) => { try { go(); } catch (e) { if (e && e.userError) return res.status(400).json({ error: e.message }); throw e; } });'],
    ];
    for (const [label, src] of clean) {
      expect(scanSource("plant.js", src).findings, `NOT an echo: ${label}`).toEqual([]);
    }
    // POSITIVE controls — the narrowing above must not have blinded the scanner.
    const echoes = [
      ["e.message", 'app.post("/x", (req, res) => { try { go(); } catch (e) { res.status(400).json({ error: e.message }); } });'],
      ["a template substitution", 'app.post("/x", (req, res) => { try { go(); } catch (e) { res.status(400).json({ error: `failed: ${e.message}` }); } });'],
      ["the shorthand { error }", 'app.post("/x", (req, res) => { try { go(); } catch (error) { res.status(400).json({ error }); } });'],
      ["the catch variable as a VALUE beside a key", 'app.post("/x", (req, res) => { try { go(); } catch (error) { res.status(400).json({ error: error }); } });'],
      ["one level of indirection", 'app.post("/x", (req, res) => { try { go(); } catch (e) { const m = String(e); res.status(400).json({ error: m }); } });'],
    ];
    for (const [label, src] of echoes) {
      expect(scanSource("plant.js", src).findings.length, `still an echo: ${label}`).toBe(1);
    }
  });

  test("the two assignment catches are FOUND, guarded by the marker, and re-throw the rest", () => {
    const r = scanFile("routes/challenges.js");
    for (const [txn, label] of [["addTasks()", "POST :id/competitions"], ["applyDiffs()", "PUT :id/competitions"]]) {
      const at = r.mask.indexOf(`runTxnWithMirrorBuffer(() => ${txn})`);
      expect(at, `${label}: its transaction call is found (a rename must fail loudly, not empty the check)`).toBeGreaterThan(0);
      const m = /\bcatch\s*\(\s*(\w+)\s*\)\s*\{/.exec(r.mask.slice(at));
      expect(m, `${label}: the catch after its transaction`).toBeTruthy();
      if (!m) continue;
      const open = at + m.index + m[0].length - 1;
      const body = r.text.slice(open + 1, closeOf(r.mask, open));
      const v = m[1];
      expect(body, `${label}: a refusal is answered only behind the marker`).toMatch(new RegExp(`if \\(${v} && ${v}\\.userError\\) return res\\.status\\(400\\)`));
      expect(body, `${label}: anything unmarked is re-thrown to the global handler`).toMatch(new RegExp(`\\bthrow ${v};`));
      expect(body, `${label}: the catch no longer answers e.message unconditionally`).not.toMatch(/^\s*res\.status\(400\)\.json\(\{ error: \w+\.message/m);
    }
  });
});
