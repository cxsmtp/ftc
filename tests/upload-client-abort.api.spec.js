// @ts-check
//
// AN UPLOAD THE CLIENT ABANDONS IS NOT A SERVER FAULT.
//
// A browser that closes mid-upload (a tab shut, a dropped venue Wi-Fi) makes
// multer fail the request with "Request aborted" / "Request closed". That used to
// reach the error handler as an unknown error: an error-level "Unhandled error"
// line with a stack, a 500 written at a socket that was gone. Now the handler
// records it once in app.jsonl at warn with the request's context and a fixed
// sentence naming neither party (Node's requestTimeout closes a request the same
// way), writes nothing, and the abandoned upload leaves no temp file and
// holds no attachment budget. A genuine refusal (a file over the limit) keeps
// its 4xx.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, TEST_DATA_DIR, findLogLine } = require("./helpers");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const UPLOADS = path.join(TEST_DATA_DIR, "uploads");
const LOGS = path.join(TEST_DATA_DIR, "logs");
const SENTENCE = "the connection closed before the request finished";

function uploadsNow() {
  try { return new Set(fs.readdirSync(UPLOADS)); } catch (_) { return new Set(); }
}

async function waitFor(fn, what, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`never saw ${what} within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function adminHeaders() {
  const { api, csrf } = await apiLogin("superadmin");
  const state = await api.storageState();
  const cookie = state.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  return { api, csrf, cookie };
}

// Sends the multipart head and part of a file declared far longer, waits until
// the server has started writing it to a temp file, then destroys the socket.
async function abortMidUpload(pathWithQuery, { cookie, csrf }, declaredBytes) {
  const boundary = `----abort${crypto.randomBytes(6).toString("hex")}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.zip"\r\n` +
    "Content-Type: application/zip\r\n\r\n");
  const before = uploadsNow();
  const u = new URL(pathWithQuery, BASE);
  const req = http.request({
    host: u.hostname, port: u.port, path: u.pathname + u.search, method: "POST",
    headers: {
      cookie, "x-csrf-token": csrf,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(declaredBytes),
    },
  });
  let answered = null;
  req.on("response", (res) => { answered = res.statusCode; res.resume(); });
  req.on("error", () => { /* the socket we destroy */ });
  req.write(head);
  req.write(Buffer.alloc(256 * 1024, 0x41));
  // PRECONDITION: the abort lands mid-file, after multer opened its temp file.
  const temp = await waitFor(() => [...uploadsNow()].find((f) => !before.has(f)), "multer's temp file");
  req.destroy();
  return { temp, answered: () => answered };
}

test.describe("an upload the client abandons", () => {
  test("is recorded once at warn, answers nothing, and leaves no file or budget behind", async () => {
    test.setTimeout(90_000);
    const h = await adminHeaders();
    try {
      // Enough aborts that, were each 60 MB preflight reservation kept, the
      // admin's 512 MB staging quota would refuse the upload that follows.
      const DECLARED = 60 * 1024 * 1024;
      for (let i = 0; i < 9; i++) {
        const nonce = crypto.randomBytes(8).toString("hex");
        const { temp, answered } = await abortMidUpload(`/api/admin/attachment-staging?abort=${nonce}`, h, DECLARED);
        const line = await findLogLine(LOGS, (j) => typeof j.path === "string" && j.path.includes(nonce),
          { what: `the abort's line (${nonce})` });
        expect(line.level, JSON.stringify(line)).toBe("warn");
        // The handler's own branch, not the generic 4xx one writing at a dead socket.
        expect(line.msg).toBe(`Request abandoned: ${SENTENCE}`);
        expect(line.status, "recorded as a closed connection (nginx's 499), never a 5xx").toBe(499);
        expect(line.err_type, "the record names neither party").toBe("connection.closed");
        expect(line.stack, "no stack: nothing broke").toBeUndefined();
        expect(line.req_id, "the request's context").toBeTruthy();
        expect(line.ip).toBeTruthy();
        // No other line for this request: no error, no "Unhandled", no second record.
        await new Promise((r) => setTimeout(r, 300));
        const all = fs.readdirSync(LOGS).filter((f) => f.startsWith("app-")).sort();
        const mine = fs.readFileSync(path.join(LOGS, all[all.length - 1]), "utf8").split("\n")
          .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return {}; } })
          .filter((j) => j.req_id === line.req_id);
        expect(mine.map((j) => `${j.level}: ${j.msg || j.message}`), "exactly one line for the abort").toHaveLength(1);
        // No access line either: nothing was answered, so nothing was a 500 or
        // counted against the address.
        const acc = fs.readdirSync(LOGS).filter((f) => f.startsWith("access-")).sort();
        const accText = acc.length ? fs.readFileSync(path.join(LOGS, acc[acc.length - 1]), "utf8") : "";
        expect(accText.includes(nonce), "no access line for an unanswered request").toBe(false);
        expect(answered(), "nothing written at the closed socket").toBeNull();
        await waitFor(() => !uploadsNow().has(temp), `the temp file ${temp} removed`);
      }
      // The budget was released: a full upload goes through.
      const ok = await h.api.post("/api/admin/attachment-staging", {
        headers: { "x-csrf-token": h.csrf },
        multipart: { file: { name: "ok.zip", mimeType: "application/zip", buffer: emptyZip() } },
      });
      expect(ok.status(), await ok.text()).toBe(200);
    } finally { await h.api.dispose(); }
  });

  test("CONTROL: a file over the limit is still refused with its 413", async () => {
    test.setTimeout(60_000);
    const h = await adminHeaders();
    try {
      const big = Buffer.alloc(64 * 1024 * 1024 + 1024, 0x41);
      const r = await h.api.post("/api/admin/attachment-staging?over=1", {
        headers: { "x-csrf-token": h.csrf },
        multipart: { file: { name: "big.zip", mimeType: "application/zip", buffer: big } },
      });
      expect(r.status()).toBe(413);
      const line = await findLogLine(LOGS, (j) => typeof j.path === "string" && j.path.includes("attachment-staging?over=1"),
        { what: "the refusal's line" });
      expect(line.level).toBe("warn");
      expect(line.status).toBe(413);
      expect(line.msg).not.toContain(SENTENCE);
    } finally { await h.api.dispose(); }
  });
});

// The smallest valid ZIP: an end-of-central-directory record alone.
function emptyZip() {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  return b;
}
