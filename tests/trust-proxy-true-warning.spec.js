// @ts-check
//
// v8.13.3 (TP-1) — TRUST_PROXY=true is warned about at boot.
//
// `TRUST_PROXY=true` trusts EVERY hop, so `req.ip` becomes the LEFTMOST
// X-Forwarded-For entry — a value the client writes itself behind any proxy that
// APPENDS to the header (nginx `$proxy_add_x_forwarded_for`, an AWS ALB in its
// default mode, Cloudflare). Every per-IP limiter, the scanner block, the
// allowlists — a competition's Trusted network IPs included, which bypass every
// limiter — and every audit IP then come from the client. It is legitimate only
// behind a proxy that OVERWRITES the header, which the server cannot see; so the
// boot sanity block WARNS, once, and names the fix (the hop count).
//
// HOW THIS RUNS WITHOUT A NEW PORT. The sanity block runs BEFORE the boot-time
// port check, so a child pointed at the worker's OWN port (which the live worker
// server already holds) prints every warning and then exits "already in use".
// That needs no spawner offset, binds nothing, and cannot disturb the worker's
// server. The child gets its OWN data and uploads directories, so nothing about
// the live server's files is touched either.
const { test, expect } = require("./isolated-test");
const { BASE } = require("./helpers");
const { serverEnv } = require("./server-env");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const WARNING = "TRUST_PROXY=true trusts EVERY hop";

function bootOnce(trustProxy, baseUrl) {
  const slot = parseInt(process.env.TEST_PARALLEL_INDEX || "0", 10);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tp1-"));
  try {
    const env = {
      ...serverEnv(slot),
      // The worker's own port, deliberately: the child must FAIL to bind it.
      PORT: new URL(BASE).port,
      BASE_URL: baseUrl,
      TRUST_PROXY: trustProxy,
      DATA_DIR: path.join(tmp, "data"),
      UPLOADS_DIR: path.join(tmp, "uploads"),
      LOG_CONSOLE_MIRROR: "1",
      NODE_OPTIONS: "",
    };
    const r = spawnSync(process.execPath, ["server.js"], {
      cwd: path.resolve(__dirname, ".."), env, encoding: "utf8", timeout: 60_000,
    });
    return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test.describe("v8.13.3 (TP-1) — TRUST_PROXY=true is warned about at boot", () => {
  test("TRUST_PROXY=true prints the warning and names the hop-count fix", async ({}, info) => {
    info.setTimeout(90_000);
    const r = bootOnce("true", "https://tp.test");
    // PRECONDITION: the child really got as far as the port check, so the
    // sanity block ran in full — or "the warning is absent" in the controls is
    // satisfied by a child that died early.
    expect(r.out, "the child reached the port check").toMatch(/already in use/i);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(WARNING);
    expect(r.out).toContain("Set TRUST_PROXY to the hop count instead");
  });

  for (const [label, tp, base] of [["a hop count (1)", "1", "https://tp.test"], ["TRUST_PROXY unset", "", "http://localhost"]]) {
    test(`CONTROL: ${label} prints no such warning`, async ({}, info) => {
      info.setTimeout(90_000);
      const r = bootOnce(tp, base);
      expect(r.out, "the child reached the port check").toMatch(/already in use/i);
      expect(r.out).not.toContain(WARNING);
    });
  }
});
