// @ts-check
//
// v8.3.24 — THE EXTRACTOR BEHIND THE DOC-REGISTRY SCANNERS.
//
// WHY THIS EXISTS. `docs/user-guide/*.md`, `README.md` and `swagger.yaml` are held
// by ~100 Docs-hygiene scanners. `AUTH_PATHS.md`, `EMAIL_RULES.md` and
// `DEVELOPMENT.md` — 1700 lines of the densest behavioural prose in the tree —
// had none, and three releases running a fix's own documentation in them went
// stale ONE RELEASE LATER. The clearest case: v8.3.22 removed the recovery-link
// bundle from `POST /api/admin/participants/:id/verify`, touched eleven files,
// and never opened AUTH_PATHS.md; v8.3.23 then found ONE of the four sites that
// describe it, in a release whose own commit message reads "a release note in
// CLAUDE.md is not a doc update".
//
// WHY A REGISTRY AND NOT A SCANNER OVER THE PROSE. Both obvious designs were
// prototyped and MEASURED against the clean tree before this one was written,
// and both are the failure this repo names — "a scanner that is wrong about
// WORKING code gets silenced by whoever hits it next":
//
//   * INFERRED co-occurrence (a paragraph naming one route and one column ⇒ the
//     column must appear in that route's handler): 30 pairs checked, **19
//     flagged, essentially all false** — a paragraph routinely cites one route
//     while discussing a rule that belongs to another. Narrowing the unit to a
//     sentence drops it to 10 checked / 2 flagged: still crying wolf, and now
//     inspecting almost nothing, which is the anti-vacuity failure wearing a
//     better number.
//   * SYMBOL RESOLUTION over every backticked identifier: run against
//     `git show 518b2d8:AUTH_PATHS.md` — the actual stale state — it produced a
//     flag set byte-identical to the fixed tree's. It would have shipped green
//     through the very drift it was meant to catch, because the stale sentences
//     say `resetLink`, which is live on a DIFFERENT route. Resolution cannot
//     express "a symbol claimed of the wrong route".
//
// So nothing is INFERRED from prose. The doc DECLARES what it claims to
// enumerate, in a manifest, and only declared claims are checked — the
// decision-per-item shape of `scripts/backup.sh`'s BACKUP_COVERS/BACKUP_EXEMPT
// (v7.21.34) and the export drift guards. Silent about everything it was not
// told about, which is the whole reason it lands at zero false positives.
//
// WHAT THAT BUYS AND WHAT IT DOES NOT. Roughly half of AUTH_PATHS is reachable.
// Rationale, threat models, timing measurements, negative claims and deliberate
// historical narrative are not, and must not be guessed at — EMAIL_RULES §6
// contains a pre-emptive trap for a literal-minded guard, stating an absolute
// rule and then explaining that "a reader auditing against the absolute wording
// would flag it wrongly". State the claim narrowly: *every site, module, reason
// and symbol these docs declare they enumerate is decided about, and still
// exists.* NOT "the docs are true".
const fs = require("fs");
const pathMod = require("path");

const ROOT = pathMod.resolve(__dirname, "..");

/**
 * v7.21.24's stripper, hoisted so the doc-registry arms and the in-spec
 * scanners cannot drift apart. BOTH comment forms in ONE left-to-right
 * alternation: a `/*` inside a `//` line otherwise deletes everything to the
 * next `*\/`. The `(^|[^:])` guard keeps `https://` out of it.
 *
 * STRIPPING IS LOAD-BEARING HERE, not hygiene. A comment explaining a removal
 * quotes the removed symbol — `routes/participants.js` still says
 * "return it as `resetLink` + `resetBundled:true`" in the comment recording
 * that it no longer does — so an unstripped scan reports a symbol as live on
 * the strength of the sentence announcing its death.
 */
// ONE left-to-right pass. A quoted string ("…" or '…', one line) is kept
// whole, so a `/*` or `//` inside one (a route glob such as "**/api/x/*", a
// URL) opens no comment; a line or block comment is dropped. v9.2.5: the
// string-blind form took the `/*` of a spec's route glob for a comment and
// dropped everything up to the next `*/`, so every scanner over tests/ missed
// whole stretches of some specs (over 1,000 lines of one). Template literals
// are NOT tokenised (a regex literal or a nested `${`…`}` would flip the
// pairing for the rest of the file), so a `/*` inside one still hides code; a
// quote mis-read inside a regex literal is confined to its own line.
function stripJsComments(raw) {
  return raw.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g,
    (m, str, pre) => (str !== undefined ? str : pre === undefined ? "" : pre));
}

/**
 * Shell comments stripped, LINE NUMBERS PRESERVED, so an ordering check cannot
 * be satisfied by a comment that quotes the anchor (v8.11.2 — the comment above
 * a guard quoted `mkdir -p "$OUT_DIR"` and an ordering mutation survived). A `#`
 * starts a comment only at a word boundary outside quotes; `${#x}` and `$#` are
 * not comments. Quote state is per line: neither script carries a multi-line
 * string, and resetting keeps an apostrophe in a heredoc from skewing the rest.
 */
function stripShellComments(src) {
  return src.split("\n").map((line) => {
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === "\\" && q === '"') { i++; continue; } if (c === q) q = null; continue; }
      if (c === "\\") { i++; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
    }
    return line;
  }).join("\n");
}

/** Every first-party JS file — the corpus a declared symbol must exist in. */
function firstPartySources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = pathMod.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) out.push(p);
    }
  };
  for (const d of ["lib", "routes", "public/js", "scripts", "tests"]) {
    const full = pathMod.join(ROOT, d);
    if (fs.existsSync(full)) walk(full);
  }
  for (const f of ["server.js", "db.js", "playwright.config.js"]) {
    const full = pathMod.join(ROOT, f);
    if (fs.existsSync(full)) out.push(full);
  }
  return out;
}

let _corpus = null;
/** The whole first-party corpus, comment-stripped, concatenated once. */
function corpus() {
  if (_corpus === null) {
    _corpus = firstPartySources().map(f => stripJsComments(fs.readFileSync(f, "utf8"))).join("\n");
  }
  return _corpus;
}

/**
 * Route handler REGIONS: `app.<method>("<path>", …` up to the next such
 * declaration in the same file.
 *
 * Deliberately NOT a brace scan. CLAUDE.md records the brace-counting scanners
 * being thrown off by a string literal holding unmatched braces — a `"{{"` in
 * the SPA shell shifted one scanner's idea of where functions begin and
 * produced three false positives 2,600 lines away. Declaration-to-declaration
 * needs no such reasoning: it over-reads at worst, and over-reading makes this
 * arm MISS a claim rather than invent one, which is the safe direction for a
 * guard whose whole viability is its false-positive rate.
 */
function routeRegions() {
  // The leading slash is not decoration: `app.get("trust proxy")` is Express's
  // SETTINGS getter, not a route, and without this it enters the index as a
  // site — which is a false positive in the one arm whose whole viability is
  // its false-positive rate.
  const DECL = /app\.(get|post|put|patch|delete)\(\s*"(\/[^"]*)"/;
  const byKey = new Map();
  const files = ["server.js", ...fs.readdirSync(pathMod.join(ROOT, "routes")).filter(f => f.endsWith(".js")).map(f => `routes/${f}`)];
  for (const rel of files) {
    const lines = stripJsComments(fs.readFileSync(pathMod.join(ROOT, rel), "utf8")).split("\n");
    const decls = [];
    lines.forEach((l, i) => { const m = DECL.exec(l); if (m) decls.push({ i, method: m[1].toUpperCase(), path: m[2] }); });
    decls.forEach((d, n) => {
      const end = n + 1 < decls.length ? decls[n + 1].i : lines.length;
      const key = routeKey(d.method, d.path);
      const body = lines.slice(d.i, end).join("\n");
      // The SIGNATURE — the declaration up to whatever opens the handler — is
      // where per-route middleware is named. The distinction is load-bearing for
      // the code→doc direction: a GLOBAL `app.use(impersonationGuard)` sitting a
      // few lines below an `app.get("/readyz")` falls inside that route's region
      // under the declaration-to-declaration rule, and matching on the body
      // would report it as a mount of /readyz. Matching the signature cannot:
      // a global mount is never inside one.
      const openIdx = body.search(/\(\s*req\s*,\s*res|=>\s*\{|async\s*\(/);
      byKey.get(key) || byKey.set(key, []);
      byKey.get(key).push({ file: rel, line: d.i + 1, body, signature: openIdx > 0 ? body.slice(0, openIdx) : body });
    });
  }
  return byKey;
}

/** `POST /api/x/:id` and `POST /api/x/{id}` and a trailing slash are one key. */
function routeKey(method, path) {
  return `${String(method).toUpperCase()} ${String(path).replace(/[:{][A-Za-z_]+\}?/g, ":P").replace(/\/$/, "")}`;
}

/**
 * Parse a doc's `<!-- DOC-REGISTRY … -->` block.
 *
 * One directive per line, `KEY: value`, with `--` introducing the REASON on an
 * exemption. A reason is REQUIRED on every exemption: v7.21.34's rule is that a
 * manifest demands a DECISION per item, and an unreasoned exemption is a silent
 * blanket carve-out wearing a decision's clothes.
 */
function readRegistry(relDoc) {
  const raw = fs.readFileSync(pathMod.join(ROOT, relDoc), "utf8");
  const m = raw.match(/<!--\s*DOC-REGISTRY\s*\n([\s\S]*?)-->/);
  const reg = { doc: relDoc, raw, symbols: [], covers: [], exempt: [], modules: [], sets: [], paths: [], reasons: [] };
  if (!m) return reg;
  for (const line of m[1].split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const d = t.match(/^([A-Z-]+):\s*(.+)$/);
    if (!d) continue;
    const [, key, valRaw] = d;
    const [value, reason] = valRaw.split(/\s+--\s+/, 2).map(s => (s || "").trim());
    switch (key) {
      case "DOC-SYMBOL": reg.symbols.push({ value, reason }); break;
      case "DOC-COVERS": {
        const c = value.match(/^(\S+)\s*@\s*(.+)$/);
        if (c) reg.covers.push({ symbol: c[1], site: c[2].trim(), reason });
        break;
      }
      case "DOC-EXEMPT": reg.exempt.push({ value, reason }); break;
      case "DOC-MODULE": reg.modules.push({ value, reason }); break;
      case "DOC-SET": {
        // `NAME @ file` or `NAME @ file = a,b,c` — the optional member list is
        // the doc's own CLAIM, checked for exact equality.
        const s = value.match(/^(\S+)\s*@\s*([^=]+?)(?:\s*=\s*(.+))?$/);
        if (s) reg.sets.push({ name: s[1], file: s[2].trim(), claimed: s[3], reason });
        break;
      }
      case "DOC-PATH": reg.paths.push({ value, reason }); break;
      case "DOC-REASON": reg.reasons.push({ value, reason }); break;
      default: break;
    }
  }
  return reg;
}

/** Members of a `const NAME = new Set([...])` literal, in source order. */
function setLiteral(relFile, name) {
  const src = stripJsComments(fs.readFileSync(pathMod.join(ROOT, relFile), "utf8"));
  const m = src.match(new RegExp(`${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) return null;
  return [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map(x => x[1]);
}

/**
 * The third argument of every `sendEmailLogged(` / `sendEmailBackground(` call —
 * the send REASON, which is what EMAIL_RULES §7 inventories.
 *
 * Paren-matched FORWARD from the call name rather than matched by a closing
 * shape: the tempting `\}, *"[a-z_]+"\)` also matches
 * `hasOwnProperty.call(req.body || {}, "attempt_cap")` and invents a reason
 * that is not one.
 */
function emailReasons() {
  const out = new Set();
  for (const f of firstPartySources()) {
    if (!/(lib|routes)\//.test(f) && !f.endsWith("server.js")) continue;
    const s = stripJsComments(fs.readFileSync(f, "utf8"));
    for (const name of ["sendEmailLogged", "sendEmailBackground"]) {
      let i = 0;
      while ((i = s.indexOf(name + "(", i)) !== -1) {
        let depth = 0, j = i + name.length;
        for (; j < s.length; j++) {
          const c = s[j];
          if (c === "(") depth++;
          else if (c === ")") { depth--; if (depth === 0) break; }
        }
        const inner = s.slice(i + name.length + 1, j);
        const parts = []; let dep = 0, cur = "", q = null;
        for (const c of inner) {
          if (q) { cur += c; if (c === q) q = null; continue; }
          if (c === '"' || c === "'" || c === "`") { q = c; cur += c; continue; }
          if ("([{".includes(c)) dep++;
          if (")]}".includes(c)) dep--;
          if (c === "," && dep === 0) { parts.push(cur); cur = ""; continue; }
          cur += c;
        }
        parts.push(cur);
        const third = (parts[2] || "").trim().match(/^["'`]([a-z0-9_]+)["'`]$/);
        if (third) out.add(third[1]);
        i = j;
      }
    }
  }
  return out;
}

module.exports = {
  ROOT, stripJsComments, stripShellComments, corpus,
  routeRegions, routeKey, readRegistry, setLiteral, emailReasons,
};
