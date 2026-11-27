// @ts-check
//
// TRUST_PROXY KEYWORDS ARE CASE-INSENSITIVE.
//
// Express and proxy-addr match `true`, `false` and the preset names exactly and
// read any other spelling as an IP address, which throws: `TRUST_PROXY=TRUE`
// stopped boot. `lib/util.js` `parseTrustProxy` is the one reader. This spec
// holds it two ways: the parser's table in process, and two spawned servers,
// `TRUE` (boots, warns as `true` does, and takes req.ip from X-Forwarded-For)
// and `FALSE` (boots and ignores the header).
const { test, expect, guardFixedPortSpec, _waitPortFree } = require("./isolated-test");
const { PORT_BASE } = require("./helpers");
const { serverEnv } = require("./server-env");
const { readySpawnedServer } = require("./spawned-server");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const WARNING = "TRUST_PROXY=true trusts EVERY hop";

test.beforeEach(() => { guardFixedPortSpec(); });

test("parseTrustProxy reads keywords in any case and passes everything else on", () => {
  const { parseTrustProxy } = require("../lib/util");
  const table = [
    [undefined, false], ["", false], ["   ", false],
    ["true", true], ["TRUE", true], ["True", true], [" tRuE ", true],
    ["false", false], ["FALSE", false], ["False", false], ["0", false],
    ["1", 1], ["2", 2],
    ["loopback", "loopback"], ["LOOPBACK", "loopback"], ["LinkLocal", "linklocal"], ["UNIQUELOCAL", "uniquelocal"],
    ["Loopback, 10.0.0.0/8", "loopback,10.0.0.0/8"],
    // An address is not a keyword: it is passed on as written.
    ["2001:DB8::1", "2001:DB8::1"], ["10.0.0.1, 10.0.0.2", "10.0.0.1,10.0.0.2"],
  ];
  for (const [raw, want] of table) expect(parseTrustProxy(raw), `TRUST_PROXY=${JSON.stringify(raw)}`).toEqual(want);
  // Each value the parser hands on is one Express accepts: compile them all.
  const express = require("express");
  for (const [raw] of table) {
    const app = express();
    expect(() => app.set("trust proxy", parseTrustProxy(raw)), `Express takes TRUST_PROXY=${JSON.stringify(raw)}`).not.toThrow();
  }
});

async function bootWith(trustProxy) {
  const port = PORT_BASE + 117;
  const base = `http://localhost:${port}`;
  await _waitPortFree(port);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-kw-"));
  let out = "";
  const spawnedAt = Date.now();
  const child = spawn(process.execPath, [path.resolve(__dirname, "..", "server.js")], {
    env: {
      ...serverEnv(0),
      PORT: String(port), BASE_URL: base,
      DATA_DIR: dataDir, UPLOADS_DIR: path.join(dataDir, "uploads"),
      TRUST_PROXY: trustProxy, LOG_CONSOLE_MIRROR: "1", NODE_OPTIONS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((r) => child.once("close", r));
  child.stdout.on("data", (b) => { out += b.toString(); });
  child.stderr.on("data", (b) => { out += b.toString(); });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    await _waitPortFree(port);
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  let pass;
  try {
    pass = await readySpawnedServer({ base, child, dataDir, spawnedAt, output: () => out });
  } catch (e) { await stop(); throw e; }
  // A superadmin session, so the server can tell us the req.ip it resolved.
  let cookie = "";
  let csrf = "";
  const go = async (p, { method = "GET", body, xff } = {}) => {
    const headers = {};
    // Trust on forces Secure cookies, so the proxy says the hop was https.
    if (xff) { headers["x-forwarded-for"] = xff; headers["x-forwarded-proto"] = "https"; }
    if (cookie) headers.cookie = cookie;
    if (csrf) headers["x-csrf-token"] = csrf;
    if (body) headers["content-type"] = "application/json";
    const r = await fetch(`${base}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
    let json = null; try { json = await r.json(); } catch (_) { /* not JSON */ }
    return { status: r.status, json };
  };
  const signIn = async (xff) => {
    csrf = (await go("/api/csrf-token", { xff })).json?.csrfToken || "";
    const r = await go("/api/login", { method: "POST", body: { username: "superadmin", password: pass }, xff });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    csrf = (await go("/api/csrf-token", { xff })).json?.csrfToken || "";
  };
  return { go, signIn, stop, output: () => out };
}

test("TRUST_PROXY=TRUE boots, warns as true does, and takes req.ip from X-Forwarded-For", async () => {
  test.setTimeout(120_000);
  const s = await bootWith("TRUE");
  try {
    expect(s.output(), "the boot warning `true` earns").toContain(WARNING);
    const XFF = "203.0.113.77, 198.51.100.3";
    await s.signIn(XFF);
    const mine = await s.go("/api/admin/my-address", { xff: XFF });
    expect(mine.status, JSON.stringify(mine.json)).toBe(200);
    // Every hop trusted: req.ip is the LEFTMOST entry, exactly as `true` reads it.
    expect(mine.json).toEqual({ ip: "203.0.113.77", range: "public" });
  } finally { await s.stop(); }
});

test("CONTROL: TRUST_PROXY=FALSE boots, says nothing, and ignores X-Forwarded-For", async () => {
  test.setTimeout(120_000);
  const s = await bootWith("FALSE");
  try {
    expect(s.output()).not.toContain(WARNING);
    const XFF = "203.0.113.77";
    await s.signIn(XFF);
    const mine = await s.go("/api/admin/my-address", { xff: XFF });
    expect(mine.status, JSON.stringify(mine.json)).toBe(200);
    expect(mine.json.ip, "the socket's own address, never the header's").not.toBe("203.0.113.77");
    expect(mine.json.range).toBe("loopback");
  } finally { await s.stop(); }
});
