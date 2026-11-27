// @ts-check
//
// THE SIZE BUDGET (operator ruling, 14 Nov 2026, #357). The stylesheet, the
// app's page and the production script may each grow at most 5% past their size
// at the ruling, measured as a browser receives them: minified, then compressed
// with gzip and with brotli exactly as server.js sends them (_assetEntry: gzip
// level 6, brotli quality 5), so a comment costs nothing. A change that goes
// over raises the figure HERE, in the same change, so growth is a visible
// decision rather than an accident.
//
//   stylesheet  GET /styles.css (the server's _minifyCss output), the response
//               bytes themselves, per encoding;
//   page        GET / (the app's page as served: asset hashes, platform name
//               and look filled in, at the default settings), likewise;
//   script      /js/core/main.js as production serves it: the esbuild bundle
//               built with server.js's own options, compressed with
//               server.js's own _assetEntry (both read from server.js, so the
//               measure follows any change to them). A test server runs with
//               MINIFY_JS off and serves the raw modules, so the bundle is
//               built here; the stylesheet arm proves the borrowed compressor
//               is byte for byte the server's.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { BASE } = require("./helpers");

const ROOT = path.join(__dirname, "..");

// Bytes on the wire at the ruling (the 9.1.1 tree, 14 Nov 2026), and the
// ceilings: +5%, rounded up. A change that needs more raises the figure here
// and says why in its commit. Raised: script brotli 303226 -> 303363 (9.2.16,
// +137 B: the read-only challenge editor's toolbar and its reasons); script gzip
// 347865 -> 348400 and brotli 303363 -> 304600 (9.2.17: about +1.4 KB gzip and
// +1.3 KB brotli on the bundle, plus a few bytes of rounding headroom: a pasted
// colour mapped to its nearest name, the signed-in header's first-paint hint, the
// template editor's library door and refusal note, the bulk wizard's kept filter,
// the retention card's picture count); then gzip 348400 -> 348460 and brotli
// 304600 -> 304700 (9.2.18: the import summary's dropped-photo-link line); then
// gzip 348460 -> 348720 and brotli 304700 -> 304960 (event-owned questions: the
// library/workspace/picker row filters in ui/task-search.js and the bulk toast's
// "belonging to another event" skip line, about +250 B either way).
const AT_RULING = {
  stylesheet: { gzip: 56241, br: 52368 },
  page: { gzip: 33262, br: 31062 },
  script: { gzip: 348720, br: 304960 },
};
const BUDGET = Object.fromEntries(Object.entries(AT_RULING).map(([k, v]) =>
  [k, { gzip: Math.ceil(v.gzip * 1.05), br: Math.ceil(v.br * 1.05) }]));

/** The response body's bytes as sent (no decompression), and its Content-Encoding. */
function wire(urlPath, encoding) {
  const u = new URL(urlPath, BASE);
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { "accept-encoding": encoding } }, (res) => {
      const parts = [];
      res.on("data", (d) => parts.push(d));
      res.on("end", () => resolve({ status: res.statusCode, encoding: res.headers["content-encoding"] || "identity", bytes: Buffer.concat(parts) }));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

/** server.js's own _assetEntry (the encode-and-compress-once function), with stubs for its globals. */
function serverCompressor() {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const at = src.indexOf("function _assetEntry(key, body) {");
  expect(at, "anti-vacuity: _assetEntry is found in server.js").toBeGreaterThan(-1);
  const fn = src.slice(at, src.indexOf("\n}\n", at) + 2);
  const make = new Function("app", "_assetEntries", "_ASSET_ENTRIES_MAX", "require", `${fn}\nreturn _assetEntry;`);
  const entry = make({ get: () => () => "etag" }, new Map(), 64, require);
  return (text) => { const e = entry(`k${Math.random()}`, text); return { raw: e.raw.length, gzip: e.gzip.length, br: e.br.length }; };
}

/** The production bundle, built with the options server.js passes esbuild. */
function productionBundle() {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const m = /const bundled = _esbuild\.buildSync\((\{[^{}]*\})\)\.outputFiles\[0\]\.text;/.exec(src);
  expect(m, "anti-vacuity: server.js's bundle build is found").toBeTruthy();
  const opts = new Function("full", `return (${m[1]});`)(path.join(ROOT, "public", "js", "core", "main.js"));
  expect(opts.bundle && opts.minify, "PRECONDITION: production bundles and minifies").toBe(true);
  return require("esbuild").buildSync({ ...opts, logLevel: "silent" }).outputFiles[0].text;
}

function report(name, got) {
  const b = BUDGET[name], r = AT_RULING[name];
  return `${name}: gzip ${got.gzip} B (at the ruling ${r.gzip}, ceiling ${b.gzip}), brotli ${got.br} B (at the ruling ${r.br}, ceiling ${b.br})`;
}

test.describe("size budget: today's size + 5%, as the browser receives it", () => {
  test("the stylesheet", async () => {
    const got = {};
    for (const enc of ["gzip", "br"]) {
      const r = await wire("/styles.css", enc);
      expect(r.status).toBe(200);
      expect(r.encoding, `PRECONDITION: the stylesheet is sent ${enc}-encoded`).toBe(enc);
      got[enc] = r.bytes.length;
    }
    const plain = await wire("/styles.css", "identity");
    expect(plain.bytes.length, "anti-vacuity: the real stylesheet (minified)").toBeGreaterThan(100_000);
    // The borrowed compressor is the server's, byte for byte (the script arm uses it).
    const mine = serverCompressor()(plain.bytes.toString("utf8"));
    expect([mine.gzip, mine.br], "server.js's _assetEntry, run here, gives the bytes the server sent").toEqual([got.gzip, got.br]);
    expect(got.gzip, report("stylesheet", got)).toBeLessThanOrEqual(BUDGET.stylesheet.gzip);
    expect(got.br, report("stylesheet", got)).toBeLessThanOrEqual(BUDGET.stylesheet.br);
  });

  test("the app's page", async () => {
    const got = {};
    for (const enc of ["gzip", "br"]) {
      const r = await wire("/", enc);
      expect(r.status).toBe(200);
      expect(r.encoding, `PRECONDITION: the page is sent ${enc}-encoded`).toBe(enc);
      got[enc] = r.bytes.length;
    }
    const plain = (await wire("/", "identity")).bytes.toString("utf8");
    expect(plain, "anti-vacuity: the app's page, its placeholders filled").toContain('id="app-header"');
    expect(plain).not.toContain("{{platformName}}");
    expect(got.gzip, report("page", got)).toBeLessThanOrEqual(BUDGET.page.gzip);
    expect(got.br, report("page", got)).toBeLessThanOrEqual(BUDGET.page.br);
  });

  test("the production script", () => {
    const bundle = productionBundle();
    expect(bundle.length, "anti-vacuity: the whole app, bundled").toBeGreaterThan(500_000);
    const got = serverCompressor()(bundle);
    expect(got.gzip, report("script", got)).toBeLessThanOrEqual(BUDGET.script.gzip);
    expect(got.br, report("script", got)).toBeLessThanOrEqual(BUDGET.script.br);
  });
});
