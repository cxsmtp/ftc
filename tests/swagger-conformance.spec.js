// v8.13.3 — swagger.yaml conforms to OpenAPI 3.0.3, and its security claims are TRUE.
//
// An external review found six classes of defect in the published spec, each
// invisible to every lock that existed, because every lock read swagger as
// PROSE (does a sentence mention a field?) and none read it as a DOCUMENT a
// generator or a gateway consumes:
//
//   SW-1  An unquoted flow-mapping value containing a comma. `{ description: A,
//         B }` is two entries to YAML — `description: A` and a stray key `B`
//         with a null value — so the published description was cut at the
//         first comma and a junk key appeared beside it. Fourteen sites.
//   SW-2  Response Objects with no `description`, which OpenAPI 3.0 REQUIRES.
//   SW-3  A parameter declared twice on one operation (`snapshot_tie`).
//   SW-4/5 Every operation inherited the GLOBAL security requirement (a signed-in
//         session AND a CSRF token), so the spec claimed the public sign-in
//         surface needed a session, every GET needed a CSRF token, and three
//         public POSTs needed a token they do not take.
//   SW-6  Status-code keys left unquoted. OpenAPI requires them to be strings,
//         and an unquoted `200` is an INTEGER key to YAML.
//
// The OpenAPI checks read the file the way the v8.8.19 duplicate-key scanner
// does (tests/functional-core-b.api.spec.js) — line by line, tracking
// INDENTATION, with the three rules that make that correct (a list item opens a
// fresh namespace; a scalar swallows every deeper line; the key regex excludes
// `{` and `[`) — and parse each FLOW collection with a small tokenizer, which is
// where SW-1 lives and where a line scanner cannot see: they report the line of
// each finding and model the OpenAPI roles of every mapping. That reader is not
// a YAML parser: it accepts a plain scalar holding `: `, which strict parsers
// (PyYAML, the `yaml` package) refuse outright. So one arm parses the whole file
// with the strict YAML 1.2 parser playwright-core already bundles and exports
// (`playwright-core/lib/utilsBundle`'s `yaml`): no new dependency, no lockfile change.
//
// YAML COMMENTS ARE STRIPPED FIRST: a full-line `#` comment is not structure,
// and a trailing ` # …` after a value is not part of it. The file carries a
// comment that quotes `required:` as the thing it deliberately omits — read as
// structure, a comment is exactly where a scanner meets the pattern it forbids.
//
// Every structural arm carries an anti-vacuity floor: a shape drift that stopped
// the reader finding operations would otherwise pass in silence, which is the
// failure this whole class is about. And one arm is BEHAVIOURAL — the security
// requirements are checked against the running server, anonymously, with a
// control in both directions.
const { test, expect, request } = require("./isolated-test");
const { BASE } = require("./helpers");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SWAGGER_PATH = path.join(ROOT, "swagger.yaml");

// ─── The OpenAPI 3.0.3 vocabulary ────────────────────────────────────────────
// Every fixed field of every object the specification defines. A key in a
// KEYWORD position (a schema, a parameter, a response, an operation …) must be
// one of these or an `x-` extension; a key in a NAME position (a property name,
// a media type, a status code, a path, a component name, a security scheme in a
// requirement) is free. That split is what lets a planted `{ description: "A",
// see: B }` fail while `properties: { see: { type: string } }` passes.
const VOCAB = new Set([
  // root, info, contact, license, server, server variable, tag, external docs
  "openapi", "info", "servers", "paths", "components", "security", "tags", "externalDocs",
  "title", "description", "termsOfService", "contact", "license", "version",
  "name", "url", "email", "variables", "enum", "default",
  // path item + operation
  "$ref", "summary", "get", "put", "post", "delete", "options", "head", "patch", "trace",
  "parameters", "operationId", "requestBody", "responses", "callbacks", "deprecated",
  // parameter + header
  "in", "required", "allowEmptyValue", "style", "explode", "allowReserved", "schema",
  "example", "examples", "content",
  // request body, media type, encoding, response, link, example
  "encoding", "contentType", "headers", "links", "value", "externalValue",
  "operationRef", "server",
  // components
  "schemas", "requestBodies", "securitySchemes",
  // schema
  "type", "format", "items", "properties", "additionalProperties", "nullable",
  "allOf", "oneOf", "anyOf", "not", "discriminator", "readOnly", "writeOnly", "xml",
  "multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum",
  "maxLength", "minLength", "pattern", "maxItems", "minItems", "uniqueItems",
  "maxProperties", "minProperties", "propertyName", "mapping",
  "namespace", "prefix", "attribute", "wrapped",
  // security scheme + OAuth flows
  "scheme", "bearerFormat", "flows", "openIdConnectUrl", "implicit", "password",
  "clientCredentials", "authorizationCode", "authorizationUrl", "tokenUrl",
  "refreshUrl", "scopes",
]);
// A keyword whose value is a MAP OF NAMES (its direct keys are free; each value
// is again an object of the specification). `parameters` only when its value is
// a map — under an operation it is a list, whose items are Parameter Objects.
const NAME_MAP_OWNERS = new Set([
  "properties", "content", "responses", "headers", "examples", "encoding",
  "variables", "scopes", "mapping", "links", "callbacks", "paths", "schemas",
  "securitySchemes", "requestBodies", "parameters",
]);
// A keyword whose value is DATA, not structure: nothing beneath it is checked.
const DATA_KEYS = new Set(["example", "default", "enum", "value"]);
const VERBS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

// ─── Comments, scalars, keys ─────────────────────────────────────────────────
const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#{[][^:]*?)\s*:(?:\s+(.*)|\s*)$/;

function unquote(s) {
  if (s == null) return s;
  const t = String(s).trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

// The value with any trailing YAML comment removed. A comment starts at a `#`
// preceded by whitespace OUTSIDE quotes; inside a quoted scalar it is text.
function stripTrailingComment(value) {
  if (!value) return value;
  const v = value.trim();
  if (v[0] === '"' || v[0] === "'") {
    const q = v[0];
    let i = 1;
    while (i < v.length) {
      if (q === '"' && v[i] === "\\") { i += 2; continue; }
      if (v[i] === q) {
        if (q === "'" && v[i + 1] === "'") { i += 2; continue; }
        break;
      }
      i++;
    }
    const after = v.slice(i + 1);
    const hash = after.search(/\s#/);
    return hash >= 0 ? v.slice(0, i + 1 + hash).trim() : v;
  }
  const hash = v.search(/\s#/);
  return hash >= 0 ? v.slice(0, hash).trim() : v;
}

// ─── The flow-collection tokenizer ───────────────────────────────────────────
// `{ … }` and `[ … ]` on one line, nested to any depth. It FAILS rather than
// guesses: an entry in a flow MAPPING with no `:` is a stray key (YAML reads it
// as a key with a null value — SW-1's exact symptom), a `: ` or a ` #` inside a
// plain scalar is a value YAML will cut or reject, and a collection that does
// not close on its own line is reported rather than read as text.
class FlowError extends Error {}
const PLAIN_START_FORBIDDEN = new Set(["@", "`", "*", "&", "!", "%", "|", ">"]);

function parseFlow(src) {
  let i = 0;
  const ws = () => { while (i < src.length && (src[i] === " " || src[i] === "\t")) i++; };
  const quoted = () => {
    const q = src[i];
    const start = i;
    i++;
    while (i < src.length) {
      if (q === '"' && src[i] === "\\") { i += 2; continue; }
      if (src[i] === q) {
        if (q === "'" && src[i + 1] === "'") { i += 2; continue; }
        i++;
        return { type: "scalar", quoted: true, text: unquote(src.slice(start, i)) };
      }
      i++;
    }
    throw new FlowError("unterminated quoted scalar");
  };
  const plain = (asKey) => {
    const start = i;
    if (PLAIN_START_FORBIDDEN.has(src[i])) throw new FlowError(`a plain scalar may not begin with '${src[i]}' (quote it)`);
    while (i < src.length) {
      const c = src[i];
      if (c === "," || c === "]" || c === "}") break;
      if (c === "{" || c === "[") throw new FlowError(`'${c}' inside a plain scalar (quote it)`);
      if (c === "#" && i > start && /\s/.test(src[i - 1])) throw new FlowError("' #' inside a flow collection starts a comment (quote the value)");
      if (c === ":" && (i + 1 >= src.length || /[\s,\]}]/.test(src[i + 1]))) {
        if (asKey) break;
        throw new FlowError("': ' inside a plain flow value (quote it)");
      }
      i++;
    }
    return { type: "scalar", quoted: false, text: src.slice(start, i).trim() };
  };
  const node = (asKey) => {
    ws();
    if (i >= src.length) throw new FlowError("unexpected end of line");
    const c = src[i];
    if (c === "{") return map();
    if (c === "[") return seq();
    if (c === '"' || c === "'") return quoted();
    return plain(asKey);
  };
  const map = () => {
    i++;
    const entries = [];
    for (;;) {
      ws();
      if (i >= src.length) throw new FlowError("flow mapping not closed on this line");
      if (src[i] === "}") { i++; break; }
      const k = (src[i] === '"' || src[i] === "'") ? quoted() : plain(true);
      if (k.type !== "scalar" || k.text === "") throw new FlowError("empty key in a flow mapping");
      ws();
      if (src[i] !== ":") {
        throw new FlowError(`stray key "${k.text}" — an entry with no ':' (an unquoted comma split the value before it?)`);
      }
      i++;
      ws();
      let value = null;
      if (src[i] !== "," && src[i] !== "}") value = node(false);
      entries.push({ key: k.text, rawKey: k, value });
      ws();
      if (src[i] === ",") { i++; continue; }
      if (src[i] === "}") continue;
      throw new FlowError(`expected ',' or '}' after "${k.text}"`);
    }
    return { type: "map", entries };
  };
  const seq = () => {
    i++;
    const items = [];
    for (;;) {
      ws();
      if (i >= src.length) throw new FlowError("flow sequence not closed on this line");
      if (src[i] === "]") { i++; break; }
      items.push(node(false));
      ws();
      if (src[i] === ",") { i++; continue; }
      if (src[i] === "]") continue;
      throw new FlowError("expected ',' or ']' in a flow sequence");
    }
    return { type: "seq", items };
  };
  const root = node(false);
  ws();
  const rest = src.slice(i);
  if (rest && !/^#/.test(rest)) throw new FlowError(`text after the flow collection closes: "${rest.slice(0, 40)}"`);
  return root;
}

// ─── The document model ──────────────────────────────────────────────────────
// Every mapping — block or flow — becomes { role, ownerKey, parent, seqItem,
// line, flow, entries: [{ key, rawKey, line, scalar?, child?, items? }] } where
// role is "keywords" (keys must be in VOCAB), "names" (keys are free) or "data"
// (an example / default / enum subtree: nothing is checked).
function childRole(parentMap, key, seqItem) {
  if (!parentMap) return "keywords";
  if (parentMap.role === "data") return "data";
  if (parentMap.role === "names") return "keywords";
  if (DATA_KEYS.has(key) || key.startsWith("x-")) return "data";
  if (key === "security") return "names";
  if (!seqItem && NAME_MAP_OWNERS.has(key)) return "names";
  return "keywords";
}

function readDocument(text) {
  const lines = text.split("\n");
  const mappings = [];
  const flowErrors = [];
  const unreadable = [];
  let flowCollections = 0;
  const newMap = (role, ownerKey, parent, seqItem, line, flow) => {
    const m = { role, ownerKey, parent, seqItem, line, flow, entries: [] };
    mappings.push(m);
    return m;
  };
  const fromFlow = (node, role, ownerKey, parent, seqItem, line) => {
    if (node.type === "map") {
      const m = newMap(role, ownerKey, parent, seqItem, line, true);
      for (const e of node.entries) {
        const rec = { key: e.key, rawKey: e.rawKey.quoted ? JSON.stringify(e.key) : e.key, line, map: m };
        m.entries.push(rec);
        attachFlowValue(rec, e.value, m, line);
      }
      return m;
    }
    return null;
  };
  const attachFlowValue = (rec, v, m, line) => {
    if (v == null) { rec.scalar = null; return; }
    if (v.type === "scalar") { rec.scalar = v.text; rec.quoted = v.quoted; return; }
    if (v.type === "map") { rec.child = fromFlow(v, childRole(m, rec.key, false), rec.key, m, false, line); return; }
    rec.items = v.items.map((it) => it.type === "map"
      ? fromFlow(it, childRole(m, rec.key, true), rec.key, m, true, line)
      : { scalar: it.type === "scalar" ? it.text : null });
  };
  const parseFlowAt = (raw, lineNo) => {
    flowCollections++;
    try { return parseFlow(raw); } catch (e) {
      if (!(e instanceof FlowError)) throw e;
      flowErrors.push(`swagger.yaml:${lineNo}: ${e.message}\n    ${raw.trim().slice(0, 160)}`);
      return null;
    }
  };

  const rootMap = newMap("keywords", null, null, false, 0, false);
  const stack = [{ col: -1, type: "root", map: rootMap }];
  let textIndent = null;
  let textRec = null;                                     // the scalar the skipped lines continue
  const pop = (col) => { while (stack.length > 1 && stack[stack.length - 1].col >= col) stack.pop(); };
  const containerFor = (frame) => {
    if (frame.type === "root" || frame.type === "item") return frame.map;
    const rec = frame.rec;
    if (!rec.child) rec.child = newMap(childRole(rec.map, rec.key, false), rec.key, rec.map, false, rec.line, false);
    return rec.child;
  };
  const addKey = (map, key, rawKey, value, lineNo, col) => {
    const rec = { key, rawKey, line: lineNo, map };
    map.entries.push(rec);
    stack.push({ col, type: "key", rec });
    const v = stripTrailingComment(value || "");
    if (v && (v[0] === "{" || v[0] === "[")) {
      const node = parseFlowAt(v, lineNo);
      if (node) attachFlowValue(rec, node, map, lineNo);
    } else if (v) {
      rec.scalar = /^[>|]/.test(v) ? "" : unquote(v);
      rec.quoted = v[0] === '"' || v[0] === "'";
      textIndent = col;
      textRec = rec;
    }
    return rec;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    if (!raw.trim()) continue;
    const indent = raw.match(/^\s*/)[0].length;
    if (textIndent !== null) {
      // Deeper lines belong to the scalar (block or multi-line plain/quoted):
      // they are its TEXT, never structure — kept so a check can read it.
      if (indent > textIndent) { if (textRec) textRec.scalar = `${textRec.scalar} ${raw.trim()}`.trim(); continue; }
      textIndent = null;
      textRec = null;
    }
    if (/^\s*#/.test(raw)) continue;                       // comments are not structure
    let rest = raw.slice(indent);
    const dash = /^-(\s+|$)/.exec(rest);
    if (dash) {
      pop(indent);
      const ownerFrame = stack[stack.length - 1];
      if (ownerFrame.type !== "key") { unreadable.push(`swagger.yaml:${lineNo}: a list item with no owning key`); continue; }
      const ownerRec = ownerFrame.rec;
      ownerRec.items = ownerRec.items || [];
      const itemCol = indent + 1 + (dash[1] === "" ? 0 : dash[1].length);
      rest = stripTrailingComment(rest.slice(dash[0].length));
      if (!rest) { unreadable.push(`swagger.yaml:${lineNo}: a bare '-' (keys on the next line are not modelled)`); continue; }
      if (rest[0] === "{" || rest[0] === "[") {
        const node = parseFlowAt(rest, lineNo);
        if (node && node.type === "map") ownerRec.items.push(fromFlow(node, childRole(ownerRec.map, ownerRec.key, true), ownerRec.key, ownerRec.map, true, lineNo));
        else ownerRec.items.push({ scalar: null });
        continue;
      }
      const km = KEY.exec(rest);
      if (!km) { ownerRec.items.push({ scalar: unquote(rest) }); textIndent = indent; textRec = null; continue; }
      const item = newMap(childRole(ownerRec.map, ownerRec.key, true), ownerRec.key, ownerRec.map, true, lineNo, false);
      ownerRec.items.push(item);
      stack.push({ col: indent, type: "item", map: item });
      addKey(item, unquote(km[1]), km[1].trim(), km[2], lineNo, itemCol);
      continue;
    }
    const m = KEY.exec(rest);
    if (!m) { unreadable.push(`swagger.yaml:${lineNo}: not a key, a list item or a comment: ${rest.slice(0, 80)}`); continue; }
    pop(indent);
    const container = containerFor(stack[stack.length - 1]);
    addKey(container, unquote(m[1]), m[1].trim(), m[2], lineNo, indent);
  }
  return { mappings, rootMap, flowErrors, unreadable, flowCollections };
}

// Operations: a mapping owned by a verb, inside a path item, inside `paths`.
function operationsOf(doc) {
  const ops = [];
  for (const m of doc.mappings) {
    if (!VERBS.has(m.ownerKey) || m.role !== "keywords") continue;
    const pathItem = m.parent;
    if (!pathItem || !pathItem.parent || pathItem.parent.ownerKey !== "paths" || pathItem.parent.parent !== doc.rootMap) continue;
    ops.push({ method: m.ownerKey.toUpperCase(), path: pathItem.ownerKey, map: m, line: m.line, get: (k) => m.entries.find((e) => e.key === k) });
  }
  return ops;
}

function securityAlternatives(rec) {
  if (!rec) return null;
  if (!rec.items) return [];
  return rec.items.map((it) => (it && it.entries ? it.entries.map((e) => e.key) : []));
}

let _doc = null;
function doc() {
  if (!_doc) _doc = readDocument(fs.readFileSync(SWAGGER_PATH, "utf8"));
  return _doc;
}

function effectiveSecurity(op, d) {
  const own = securityAlternatives(op.get("security"));
  if (own) return { alternatives: own, explicit: true };
  const g = d.rootMap.entries.find((e) => e.key === "security");
  return { alternatives: securityAlternatives(g) || [], explicit: false };
}
const namesScheme = (sec, scheme) => sec.alternatives.some((alt) => alt.includes(scheme));
const isPublic = (sec) => sec.alternatives.length === 0 || sec.alternatives.some((alt) => !alt.includes("sessionAuth"));

test.describe("swagger.yaml is a valid OpenAPI 3.0.3 document", () => {
  test("the reader models the whole file — no unreadable structural line", () => {
    const d = doc();
    expect(d.unreadable, `structural lines the reader could not model:\n${d.unreadable.join("\n")}`).toEqual([]);
    const ops = operationsOf(d);
    // Anti-vacuity: a shape drift that stopped the walk finding operations would
    // make every arm below pass on nothing.
    expect(ops.length, "the reader found almost no operations — its shape assumption has drifted").toBeGreaterThanOrEqual(180);
    expect(d.mappings.length).toBeGreaterThanOrEqual(3000);
  });

  // SW-1. YAML accepts `{ description: A, see B }` without complaint — it is a
  // mapping with TWO keys, `description: A` and `see B: null` — so the published
  // text is cut at the comma and a junk key sits beside it. A keyword check is
  // the half that catches `{ description: A, see: B }`, where the cut-off text
  // happened to contain a colon and so reads as a well-formed but unknown key.
  test("SW-1: every flow collection parses, with no stray key and no unknown keyword", () => {
    const d = doc();
    expect(d.flowErrors, `flow collections YAML reads differently from what was written:\n${d.flowErrors.join("\n")}`).toEqual([]);
    const unknown = [];
    for (const m of d.mappings) {
      if (m.role !== "keywords") continue;
      for (const e of m.entries) {
        if (VOCAB.has(e.key) || e.key.startsWith("x-")) continue;
        unknown.push(`swagger.yaml:${e.line}: "${e.key}" is not an OpenAPI 3.0.3 keyword here (owner "${m.ownerKey}")`);
      }
    }
    expect(unknown, `keys in a keyword position that the specification does not define:\n${unknown.join("\n")}`).toEqual([]);
    expect(d.flowCollections, "the flow tokenizer saw almost no collections — its line detection has drifted").toBeGreaterThanOrEqual(2000);
    expect(d.mappings.filter((m) => m.flow).length).toBeGreaterThanOrEqual(1500);
  });

  // The tokenizer is the whole of SW-1's lock, so it is asserted directly too —
  // with a CONTROL for each refusal, or "it refused" is satisfied by a parser that
  // refuses everything.
  test("SW-1: the flow tokenizer refuses exactly the shapes YAML misreads", () => {
    const refuses = (s) => { try { parseFlow(s); return false; } catch (e) { return e instanceof FlowError; } };
    expect(refuses("{ description: Fraction of (participant, task) pairs }")).toBe(true);
    expect(refuses('{ description: "Fraction of (participant, task) pairs" }')).toBe(false);
    expect(refuses("{ description: see note #3 }")).toBe(true);
    expect(refuses("{ description: 'see note #3' }")).toBe(false);
    expect(refuses("{ description: Redirect to: here }")).toBe(true);
    expect(refuses("{ description: The admin's email }")).toBe(false);
    expect(refuses("[ { name: a }, { name: b, in: query } ]")).toBe(false);
    expect(refuses("[ { name: a, b } ]")).toBe(true);
    expect(refuses("{ type: string")).toBe(true);
    expect(refuses("{ description: `code` }")).toBe(true);
  });

  // SW-6. An unquoted `200:` is an INTEGER key to YAML; OpenAPI requires a
  // string. And once quoting is normalised, `"200"` and `200` are the same key —
  // the v8.8.19 scanner compares RAW keys and so cannot see that duplicate.
  test("SW-6: every status-code key is quoted, and no mapping repeats a key once quotes are normalised", () => {
    const d = doc();
    const ops = operationsOf(d);
    const bad = [];
    let codes = 0;
    for (const op of ops) {
      const r = op.get("responses");
      if (!r || !r.child) { bad.push(`${op.method} ${op.path} (swagger.yaml:${op.line}) has no responses map`); continue; }
      for (const e of r.child.entries) {
        codes++;
        if (e.key === "default") continue;
        if (!/^[1-5](\d\d|XX)$/.test(e.key)) bad.push(`swagger.yaml:${e.line}: "${e.key}" under ${op.method} ${op.path} is not a status code`);
        else if (!/^"[^"]+"$|^'[^']+'$/.test(e.rawKey)) bad.push(`swagger.yaml:${e.line}: status code ${e.rawKey} under ${op.method} ${op.path} is not quoted`);
      }
    }
    const dups = [];
    for (const m of d.mappings) {
      const seen = new Map();
      for (const e of m.entries) {
        if (seen.has(e.key)) dups.push(`swagger.yaml:${e.line}: "${e.key}" repeats the key at line ${seen.get(e.key)}`);
        else seen.set(e.key, e.line);
      }
    }
    expect(codes, "the reader found almost no response codes").toBeGreaterThanOrEqual(600);
    expect(bad, bad.join("\n")).toEqual([]);
    expect(dups, `duplicate keys (YAML keeps only the last):\n${dups.join("\n")}`).toEqual([]);
  });

  // SW-2. A Response Object's `description` is REQUIRED. The responses map is
  // found by POSITION (an operation's `responses` keyword, and the named entries
  // of components.responses) — never by the word `responses`, because a schema
  // PROPERTY of that name exists (the free-text-responses export) and is not a
  // responses map. That property is asserted present as the control: without it
  // the anchoring is untested.
  test("SW-2: every Response Object has a description (or is a $ref)", () => {
    const d = doc();
    const missing = [];
    let checked = 0;
    const checkResponse = (where, rec) => {
      checked++;
      const m = rec.child;
      if (!m) { missing.push(`${where}: the response is not an object`); return; }
      const keys = new Set(m.entries.map((e) => e.key));
      if (!keys.has("description") && !keys.has("$ref")) missing.push(`${where} (swagger.yaml:${rec.line})`);
    };
    for (const op of operationsOf(d)) {
      const r = op.get("responses");
      if (!r || !r.child) continue;
      for (const e of r.child.entries) checkResponse(`${op.method} ${op.path} ${e.key}`, e);
    }
    const comps = d.rootMap.entries.find((e) => e.key === "components");
    const compResponses = comps && comps.child && comps.child.entries.find((e) => e.key === "responses");
    expect(compResponses && compResponses.child, "components.responses exists").toBeTruthy();
    for (const e of compResponses.child.entries) checkResponse(`components.responses.${e.key}`, e);

    // CONTROL: a mapping KEYED `responses` that is NOT a responses map is present
    // (a schema property), and its keys would fail the status-code shape — so an
    // anchor by name rather than by position would misread it.
    const lookalikes = d.mappings.filter((m) => m.ownerKey === "responses" && m.parent && m.parent.role === "names");
    expect(lookalikes.length, "the free-text-responses schema property named `responses` is still in the spec (the anchoring control)").toBeGreaterThanOrEqual(1);
    expect(lookalikes.some((m) => m.entries.some((e) => !/^[1-5]\d\d$/.test(e.key)))).toBe(true);

    expect(checked, "the reader found almost no responses").toBeGreaterThanOrEqual(600);
    expect(missing, `Response Objects without the REQUIRED description:\n${missing.join("\n")}`).toEqual([]);
  });

  // SW-3. A parameter declared twice: OpenAPI forbids a repeated (name, in) on
  // one operation, and a generator keeps one at random. Items are read in BOTH
  // block orders (`- name:` then `in:`, and `- in:` then `name:`) and in flow
  // form; a `$ref` item is resolved against components.parameters, and one that
  // does not resolve FAILS rather than being skipped.
  test("SW-3: no operation declares the same (name, in) parameter twice", () => {
    const d = doc();
    const comps = d.rootMap.entries.find((e) => e.key === "components");
    const compParams = comps && comps.child && comps.child.entries.find((e) => e.key === "parameters");
    const resolve = (ref) => {
      const m = /^#\/components\/parameters\/(.+)$/.exec(ref || "");
      const hit = m && compParams && compParams.child && compParams.child.entries.find((e) => e.key === m[1]);
      return hit && hit.child ? hit.child : null;
    };
    const dups = [];
    let lists = 0;
    let params = 0;
    for (const op of operationsOf(d)) {
      const lists0 = [op.get("parameters"), op.map.parent.entries.find((e) => e.key === "parameters")].filter(Boolean);
      for (const p of lists0) {
        if (!p.items) continue;
        lists++;
        const seen = new Map();
        for (const it of p.items) {
          let m = it && it.entries ? it : null;
          const ref = m && m.entries.find((e) => e.key === "$ref");
          if (ref) {
            m = resolve(ref.scalar);
            if (!m) { dups.push(`${op.method} ${op.path}: parameter $ref ${ref.scalar} does not resolve`); continue; }
          }
          if (!m) { dups.push(`${op.method} ${op.path} (swagger.yaml:${p.line}): a parameter item that is not an object`); continue; }
          const name = (m.entries.find((e) => e.key === "name") || {}).scalar;
          const where = (m.entries.find((e) => e.key === "in") || {}).scalar;
          if (!name || !where) { dups.push(`${op.method} ${op.path} (swagger.yaml:${m.line}): a parameter without name/in`); continue; }
          params++;
          const k = `${name}|${where}`;
          if (seen.has(k)) dups.push(`${op.method} ${op.path}: (${name}, ${where}) at swagger.yaml:${m.line}, first at line ${seen.get(k)}`);
          else seen.set(k, m.line);
        }
      }
    }
    expect(lists, "the reader found almost no parameter lists").toBeGreaterThanOrEqual(100);
    expect(params, "the reader found almost no parameters").toBeGreaterThanOrEqual(190);
    expect(dups, dups.join("\n")).toEqual([]);
  });

  // The schema rules a generator trips on, each a defect that shipped:
  // `type: 'null'` is not a 3.0 type (nullable is); an array with no `items` is
  // invalid; a `$ref` with siblings has those siblings IGNORED (so a description
  // written beside one is never published); and a `Content-Type` response header
  // is ignored by the specification (the media type is the content key).
  test("schemas: no null type, every array has items, no $ref siblings, no Content-Type header", () => {
    const d = doc();
    const bad = [];
    let arrays = 0;
    let refs = 0;
    for (const m of d.mappings) {
      if (m.role === "names" && m.ownerKey === "headers") {
        for (const e of m.entries) if (/^content-type$/i.test(e.key)) bad.push(`swagger.yaml:${e.line}: a Content-Type response header (ignored by OpenAPI)`);
      }
      if (m.role !== "keywords") continue;
      const keys = m.entries.map((e) => e.key);
      const type = m.entries.find((e) => e.key === "type");
      if (type) {
        if (type.scalar == null || /^(null|~)$/i.test(type.scalar)) bad.push(`swagger.yaml:${type.line}: type ${type.rawKey}: null is not an OpenAPI 3.0 type — use nullable`);
        if (type.scalar === "array") { arrays++; if (!keys.includes("items")) bad.push(`swagger.yaml:${type.line}: an array schema with no items`); }
      }
      if (keys.includes("$ref")) {
        refs++;
        if (keys.length > 1) bad.push(`swagger.yaml:${m.line}: $ref beside ${keys.filter((k) => k !== "$ref").join(", ")} (siblings of a Reference Object are ignored)`);
      }
    }
    expect(arrays).toBeGreaterThanOrEqual(150);
    expect(refs).toBeGreaterThanOrEqual(250);
    expect(bad, bad.join("\n")).toEqual([]);
  });

  // ONE OPERATION TAKES A NEW PASSWORD: Profile → How you sign in
  // (`PUT /api/me/sign-in-method`), whose `password` is the one a person chooses,
  // 8 characters to 72 UTF-8 bytes (lib/login-method.js `passwordLengthError`,
  // the one validator: bcrypt reads no further). Every other password property
  // is COMPARED at a sign-in door (the break-glass `/api/login`, the account
  // password door), never chosen there, so it carries no bounds: a bound on a
  // compared password would document a rule the server does not apply.
  // `maxLength` counts characters while the server's cap is bytes, so the spec
  // states the character bound (72 bytes is never more than 72 characters) and
  // says bytes in words.
  test("exactly one operation takes a NEW password, bounded as the server bounds it", () => {
    const { PASSWORD_MIN_CHARS, PASSWORD_MAX_BYTES, passwordLengthError } = require(path.join(ROOT, "lib", "login-method.js"));
    // The validator really is the bound the spec states (both edges, both ways).
    expect(PASSWORD_MIN_CHARS, "the server's minimum").toBe(8);
    expect(PASSWORD_MAX_BYTES, "the server's maximum, in bytes").toBe(72);
    expect(passwordLengthError("a".repeat(PASSWORD_MIN_CHARS - 1)), "one character short is refused").toBeTruthy();
    expect(passwordLengthError("a".repeat(PASSWORD_MIN_CHARS)), "CONTROL: the minimum is accepted").toBeNull();
    expect(passwordLengthError("a".repeat(PASSWORD_MAX_BYTES)), "CONTROL: 72 bytes is accepted").toBeNull();
    expect(passwordLengthError("é".repeat(37)), "37 two-byte characters (74 bytes) are refused").toBeTruthy();

    const maps = newPasswordMaps(doc());
    // CONTROL: the walk reaches the compared passwords as well as the new one, so
    // "one bounded property" is not a walk that found one map.
    expect(maps.length, "the walk finds every password property").toBeGreaterThanOrEqual(3);
    const owners = maps.map((m) => ({ m, op: operationOwning(m) }));
    const bounded = owners.filter(({ m }) => m.entries.some((e) => e.key === "minLength" || e.key === "maxLength"));
    expect(bounded.map(({ m, op }) => `${op ? `${op.method} ${op.path}` : "(no operation)"} ${m.ownerKey} (swagger.yaml:${m.line})`),
      "only the sign-in method's new password is bounded")
      .toEqual([expect.stringMatching(/^PUT \/api\/me\/sign-in-method password /)]);
    const pw = bounded[0].m;
    const num = (k) => { const e = pw.entries.find((x) => x.key === k); return e ? Number(e.scalar) : NaN; };
    expect(num("minLength"), "minLength is the server's minimum").toBe(PASSWORD_MIN_CHARS);
    expect(num("maxLength"), "maxLength is the byte cap's character bound").toBe(PASSWORD_MAX_BYTES);
    const desc = (pw.entries.find((e) => e.key === "description") || {}).scalar || "";
    expect(desc, "the description says the cap is in bytes").toMatch(/72 bytes/);
    // The compared doors are found, and stay unbounded (the line above).
    const compared = owners.filter(({ op }) => op && /^(POST \/api\/login|POST \/api\/auth\/password)$/.test(`${op.method} ${op.path}`));
    expect(compared.length, "CONTROL: both compared sign-in passwords were walked").toBeGreaterThanOrEqual(2);
    // One validator: lib/util.js keeps no copy of it.
    const util = fs.readFileSync(path.join(ROOT, "lib", "util.js"), "utf8");
    expect(/\bpasswordLengthError\b/.test(util), "lib/util.js keeps no second new-password validator").toBe(false);
  });

  // SW-7. Secret scanners (Checkmarx KICS "Passwords And Secrets - Generic
  // Token / Generic Password") read any line where a word ending in token,
  // password or secret is followed by `:` or `=` and a value as a hard-coded
  // credential — the old CSRF scheme's empty-scope security requirement and
  // prose saying an account "has no password" before a colon were twenty
  // findings in one scan. The
  // spec holds no credential, so no line may take that shape: a property
  // whose value is a flow mapping or a block (a bare key, `>-`, `|`) is fine;
  // anything else is reworded. The control strings below are built from parts
  // so this file does not itself take the shape it forbids.
  test("SW-7: no line reads to a secret scanner as a hard-coded token or password", () => {
    const shape = /\b[A-Za-z_]*(token|password|passwd|secret)["']?\s*[:=]\s*(?![{\s>|]|$)/i;
    const tok = "csrf" + "Token", pw = "pass" + "word";
    // CONTROLS: the shapes that were flagged match, the legitimate ones do not.
    for (const bad of [`      security: [{ ${tok}: [] }]`, `        Like every account it has no ${pw}: it signs in`, `    ${tok}: []`]) {
      expect(shape.test(bad), `the SW-7 shape still recognises: ${bad}`).toBe(true);
    }
    for (const good of [`                join${"Token"}: { type: string }`, `                  ${tok}:`, "    csrfHeader: []", "        description: >-"]) {
      expect(shape.test(good), `the SW-7 shape must not flag: ${good}`).toBe(false);
    }
    const lines = fs.readFileSync(SWAGGER_PATH, "utf8").split("\n");
    expect(lines.length, "swagger.yaml was read").toBeGreaterThan(10000);
    const hits = [];
    lines.forEach((l, i) => { if (shape.test(l)) hits.push(`swagger.yaml:${i + 1}: ${l.trim().slice(0, 120)}`); });
    expect(hits, hits.join("\n")).toEqual([]);
  });

  // A plain (unquoted) block scalar holding `: ` is a nested mapping to YAML,
  // which a compact mapping may not hold: PyYAML stops at it ("mapping values are
  // not allowed here") and so does every strict parser, while the line reader
  // above takes it as text. The file must parse as ONE document with no error and
  // no warning (duplicate keys are errors), under the strict YAML 1.2 parser
  // playwright-core bundles. CONTROLS: the parser refuses that shape and a
  // duplicate key, and reads the quoted form whole.
  test("strict YAML: the whole file parses as one document, with no error and no warning", () => {
    const { yaml } = require("playwright-core/lib/utilsBundle");
    const parse = (src) => yaml.parseAllDocuments(src, { strict: true, uniqueKeys: true, prettyErrors: true });
    const problems = (docs) => docs.flatMap((d) => [...d.errors, ...d.warnings])
      .map((e) => `swagger.yaml:${(e.linePos && e.linePos[0] && e.linePos[0].line) || "?"}: ${e.code} ${String(e.message).split("\n")[0]}`);
    const sentence = "Counts of sent, failed and refused, or `deferred: true` when the sends outlast the 10 s deadline.";
    expect(problems(parse(`a:\n  description: ${sentence}\n`)), "CONTROL: a plain scalar holding ': ' is refused").not.toEqual([]);
    expect(problems(parse("a: 1\nb: 2\na: 3\n")), "CONTROL: a duplicate key is refused").not.toEqual([]);
    const quoted = parse(`a:\n  description: "${sentence}"\n`);
    expect(problems(quoted), "CONTROL: the quoted form parses").toEqual([]);
    expect(quoted[0].toJS().a.description).toBe(sentence);

    const docs = parse(fs.readFileSync(SWAGGER_PATH, "utf8"));
    expect(docs.length, "one YAML document").toBe(1);
    expect(problems(docs), `what a strict YAML parser refuses:\n${problems(docs).join("\n")}`).toEqual([]);
    const spec = docs[0].toJS();
    // Anti-vacuity: the parse produced the API, not an empty or truncated map.
    expect(spec.openapi).toBe("3.0.3");
    expect(Object.keys(spec.paths).length, "the parsed document holds the paths").toBeGreaterThanOrEqual(150);
    // By value: the scalar strict parsers refuse when unquoted reads whole.
    expect(spec.paths["/api/admin/competitions/{id}/team-report/send"].post.responses["200"].description).toBe(sentence);
  });
});

function newPasswordMaps(d) {
  return d.mappings.filter((m) => m.role === "keywords" && /^(password|newPassword|sharedPassword)$/.test(m.ownerKey || "")
    && m.parent && m.parent.role === "names" && !m.entries.some((e) => e.key === "enum"));
}

// The operation a mapping sits inside (a verb's mapping inside a path item inside
// `paths`), or null for one under components.
function operationOwning(m) {
  for (let cur = m; cur; cur = cur.parent) {
    const pathItem = cur.parent;
    if (VERBS.has(cur.ownerKey) && cur.role === "keywords" && pathItem && pathItem.parent && pathItem.parent.ownerKey === "paths") {
      return { method: cur.ownerKey.toUpperCase(), path: pathItem.ownerKey };
    }
  }
  return null;
}

// ─── Route parity: what the server registers and what swagger documents ─────
// Registered routes are the `app.<verb>("/…")` declarations doc-registry
// indexes (server.js and routes/*.js); a path parameter and its `{name}`
// spelling are one key. Test-only routes (`/api/test/*`, registered only under
// NODE_ENV=test) are never documented, by rule (CLAUDE.md, *Test-only
// endpoints*). Each other difference is a reviewed decision with its reason.
const UNDOCUMENTED_ROUTES = new Map([
]);
const DOCUMENTED_UNREGISTERED = new Map([
  ["GET /register", "served by server.js's SPA-shell middleware (the `/register` entry beside `/` and `/join/`), not an app.get route doc-registry can see"],
]);
function routeParity(live, documented) {
  const undocumented = [...live].filter((k) => !documented.has(k) && !UNDOCUMENTED_ROUTES.has(k) && !/^[A-Z]+ \/api\/test\//.test(k));
  const unregistered = [...documented].filter((k) => !live.has(k) && !DOCUMENTED_UNREGISTERED.has(k));
  return { undocumented, unregistered };
}

test.describe("swagger.yaml documents every route the server registers", () => {
  test("every registered route is documented, and every documented operation is registered", () => {
    const DR = require("./doc-registry");
    const live = new Set(DR.routeRegions().keys());
    const documented = new Set(operationsOf(doc()).map((op) => DR.routeKey(op.method, op.path)));
    // Anti-vacuity: both sides were actually read.
    expect(live.size, "the route extraction found almost nothing").toBeGreaterThanOrEqual(250);
    expect(documented.size, "the swagger reader found almost no operations").toBeGreaterThanOrEqual(220);
    expect([...live].filter((k) => / \/api\/test\//.test(k)).length, "the test-only routes are seen, and left out by rule").toBeGreaterThanOrEqual(20);

    const { undocumented, unregistered } = routeParity(live, documented);
    expect(undocumented, "registered routes missing from swagger.yaml: document each, or record why in UNDOCUMENTED_ROUTES").toEqual([]);
    expect(unregistered, "swagger.yaml documents operations no route registers: remove them, or record why in DOCUMENTED_UNREGISTERED").toEqual([]);

    // Both exemption lists checked both ways: an entry whose reason is gone is deleted.
    for (const [k, why] of UNDOCUMENTED_ROUTES) {
      expect(live.has(k) && !documented.has(k), `UNDOCUMENTED_ROUTES names ${k}, which is no longer an undocumented route: delete it`).toBe(true);
      expect(why.length, `the exemption for ${k} says why`).toBeGreaterThan(40);
    }
    for (const [k, why] of DOCUMENTED_UNREGISTERED) {
      expect(documented.has(k) && !live.has(k), `DOCUMENTED_UNREGISTERED names ${k}, which is no longer documented-only: delete it`).toBe(true);
      expect(why.length, `the exemption for ${k} says why`).toBeGreaterThan(40);
    }

    // Planted controls: one extra route on each side is found, and only it.
    const plantedLive = new Set([...live, "GET /api/zz-planted"]);
    expect(routeParity(plantedLive, documented).undocumented, "a planted undocumented route is found").toEqual(["GET /api/zz-planted"]);
    const plantedDoc = new Set([...documented, "DELETE /api/zz-planted/:P"]);
    expect(routeParity(live, plantedDoc).unregistered, "a planted unregistered operation is found").toEqual(["DELETE /api/zz-planted/:P"]);
  });
});

test.describe("swagger.yaml security requirements", () => {
  // SW-5. csrf-sync ignores GET, HEAD and OPTIONS, so a GET that names
  // csrfHeader (the X-CSRF-Token scheme; not called "csrfToken", because a
  // requirement line naming a "...Token" scheme reads to secret scanners as a hard-coded
  // token) claims a requirement the server does not have — and a client
  // generator then sends a token on every read.
  test("SW-5: no GET names csrfHeader; every operation that does documents the 415", () => {
    const d = doc();
    const bad = [];
    let gets = 0;
    let csrfOps = 0;
    const schemes = new Set();
    const comps = d.rootMap.entries.find((e) => e.key === "components");
    const ss = comps.child.entries.find((e) => e.key === "securitySchemes");
    for (const e of ss.child.entries) schemes.add(e.key);
    for (const op of operationsOf(d)) {
      const sec = effectiveSecurity(op, d);
      for (const alt of sec.alternatives) for (const s of alt) if (!schemes.has(s)) bad.push(`${op.method} ${op.path}: names an undefined scheme ${s}`);
      if (op.method === "GET") {
        gets++;
        if (namesScheme(sec, "csrfHeader")) bad.push(`${op.method} ${op.path} (swagger.yaml:${op.line}) names csrfHeader — no GET checks a CSRF token`);
      }
      if (namesScheme(sec, "csrfHeader")) {
        csrfOps++;
        const r = op.get("responses");
        if (!r.child.entries.some((e) => e.key === "415")) bad.push(`${op.method} ${op.path} (swagger.yaml:${op.line}) names csrfHeader and does not document the 415 for an unsupported body`);
      }
    }
    expect(gets).toBeGreaterThanOrEqual(70);
    expect(csrfOps).toBeGreaterThanOrEqual(100);
    expect(bad, bad.join("\n")).toEqual([]);
  });

  // v8.13.3 — an admin-session GET under /api/admin answers 400
  // query_param_repeated for a repeated query key. Every such GET documents it,
  // by the shared response or by naming the code in its own 400.
  test("every /api/admin GET documents query_param_repeated", () => {
    const d = doc();
    const bad = [];
    let n = 0;
    for (const op of operationsOf(d)) {
      if (op.method !== "GET" || !op.path.startsWith("/api/admin/")) continue;
      n++;
      const r = op.get("responses");
      const four = r.child.entries.find((e) => e.key === "400");
      const m = four && four.child;
      const ok = m && m.entries.some((e) => (e.key === "$ref" && /QueryParamRepeated$/.test(e.scalar || "")) || (e.key === "description" && /query_param_repeated/.test(e.scalar || "")));
      if (!ok) bad.push(`GET ${op.path} (swagger.yaml:${op.line})`);
    }
    expect(n).toBeGreaterThanOrEqual(40);
    expect(bad, `admin GETs that do not document query_param_repeated:\n${bad.join("\n")}`).toEqual([]);
  });
});

// ─── The behavioural arm ─────────────────────────────────────────────────────
// SW-4 was a documentation defect, but its consequence is a TRUTH claim about the
// server: an operation the spec calls public must answer an anonymous caller,
// and one it says needs a session must refuse one. So every operation is probed
// anonymously against the running server.
//
//   * An anonymous REFUSAL is recognised by its SHAPE — 401 with error
//     "Not authenticated", the one body every auth guard returns to a caller with
//     no session — never by a bare 401: a public sign-in legitimately answers
//     401 "Invalid email or password".
//   * Two session-only routes refuse an anonymous caller with their own shape
//     (they test the session inline rather than through a guard); they are named
//     here, and the stale-exemption arm fails if either stops being a documented
//     session-only operation.
//   * A public operation that names csrfHeader must refuse a TOKENLESS request with
//     403 csrf_invalid, and one that does not must not — both halves of SW-5.
//   * maxRedirects: 0 on every probe (a 302 is an answer, not something to
//     follow), and no probe may 5xx or be throttled.
const ANON_REFUSAL = {
  "POST /api/toggle-admin-view": { status: 403, error: "Not a user session" },
  "POST /api/impersonation/exit": { status: 400, error: "Not impersonating" },
};
const DUMMY = {
  token: "swaggerprobetoken0000", code: "ZZZZZZ", id: "00000000-0000-4000-8000-0000000000aa",
  email: "nobody@example.invalid", tag: "swaggerprobe", filename: "nothing.zip",
};
const fill = (p) => p.replace(/\{([^}]+)\}/g, (_, n) => encodeURIComponent(DUMMY[n] || DUMMY.id));

async function probe(op, { token } = {}) {
  const ctx = await request.newContext({ baseURL: BASE });
  try {
    let headers = {};
    if (token) {
      const t = await ctx.get("/api/csrf-token", { maxRedirects: 0 });
      headers = { "x-csrf-token": (await t.json()).csrfToken };
    }
    const unsafe = op.method !== "GET" && op.method !== "HEAD";
    const r = await ctx.fetch(fill(op.path), {
      method: op.method,
      headers: unsafe ? { ...headers, "content-type": "application/json" } : headers,
      data: unsafe ? "{}" : undefined,
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* HTML, PNG, CSV … */ }
    return { status: r.status(), body, text: text.slice(0, 160) };
  } finally {
    await ctx.dispose();
  }
}
const isAuthRefusal = (res) => res.status === 401 && res.body && res.body.error === "Not authenticated";

test.describe("swagger.yaml security claims hold against the server", () => {
  test("the anonymous-refusal exemptions name documented session-only operations", () => {
    const d = doc();
    const byKey = new Map(operationsOf(d).map((op) => [`${op.method} ${op.path}`, op]));
    for (const k of Object.keys(ANON_REFUSAL)) {
      const op = byKey.get(k);
      expect(op, `ANON_REFUSAL names ${k}, which swagger no longer documents — a stale exemption`).toBeTruthy();
      expect(isPublic(effectiveSecurity(op, d)), `${k} is documented public — its exemption is stale`).toBe(false);
    }
  });

  test("every documented-public operation answers an anonymous caller; every session operation refuses one", async () => {
    test.setTimeout(180_000);
    const d = doc();
    const mismatches = [];
    let publicProbed = 0;
    let sessionProbed = 0;
    let csrfChecked = 0;
    for (const op of operationsOf(d)) {
      const key = `${op.method} ${op.path}`;
      const sec = effectiveSecurity(op, d);
      const csrf = namesScheme(sec, "csrfHeader");
      const unsafe = op.method !== "GET" && op.method !== "HEAD";
      const res = await probe(op, { token: unsafe });
      if (res.status >= 500) mismatches.push(`${key}: ${res.status} for an anonymous probe — ${res.text}`);
      if (res.status === 429) mismatches.push(`${key}: throttled (429) — the probe measured the limiter, not the route`);
      if (isPublic(sec)) {
        publicProbed++;
        if (isAuthRefusal(res)) mismatches.push(`${key} is documented public and refused an anonymous caller: ${res.status} ${res.text}`);
        if (unsafe) {
          // The CSRF half of the claim, checked without a token.
          const bare = await probe(op, { token: false });
          csrfChecked++;
          const refused = bare.status === 403 && bare.body && bare.body.error === "csrf_invalid";
          if (csrf && !refused) mismatches.push(`${key} documents csrfHeader, and a tokenless request was not refused csrf_invalid: ${bare.status} ${bare.text}`);
          if (!csrf && refused) mismatches.push(`${key} documents no csrfHeader, and a tokenless request was refused csrf_invalid`);
        }
      } else {
        sessionProbed++;
        const exempt = ANON_REFUSAL[key];
        const ok = exempt
          ? res.status === exempt.status && res.body && res.body.error === exempt.error
          : isAuthRefusal(res);
        if (!ok) mismatches.push(`${key} is documented session-only and answered an anonymous caller ${res.status} ${res.text}`);
      }
    }
    expect(publicProbed, "the probe found the documented-public operations").toBeGreaterThanOrEqual(30);
    expect(sessionProbed, "the probe found the documented session operations (the CONTROL)").toBeGreaterThanOrEqual(140);
    expect(csrfChecked, "the tokenless CSRF half ran").toBeGreaterThanOrEqual(12);   // forgot/reset-password and the LinkedIn doors left with passwords and LinkedIn
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });
});

