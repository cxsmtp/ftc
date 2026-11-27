"use strict";

// Outbound HTTP with a hard abort timeout, used by the CxOne IDP calls
// (lib/cxone, lib/cxone-withdraw) so a slow/hung upstream can't pin a
// provisioning or withdrawal worker indefinitely. Default 10s, overridable via
// EXTERNAL_FETCH_TIMEOUT_MS.

const fs = require("fs");
const path = require("path");
const { UPLOADS_DIR } = require("./config");
// Only `./log` (which itself requires only `./config`). `lib/audit` — the home of
// reqContext — is deliberately NOT imported here: it requires `../db`, which opens
// SQLite at require time, and lib/http is a dependency-light leaf pulled in by
// lib/cxone and server.js. The two fields below are the ones that join this line
// to the access log; ip/user_agent are already on that line for the same req_id.
const { log } = require("./log");
const { swallowed } = require("./best-effort");

const EXTERNAL_FETCH_TIMEOUT_MS = parseInt(process.env.EXTERNAL_FETCH_TIMEOUT_MS || "10000", 10);

// Clean up a multer temp file if it exists on the request. Path-joined through
// UPLOADS_DIR + basename so a crafted req.file.path can't escape the dir.
// A req.file with no path is one multer already removed: when a limit aborts the
// request after a file was stored, its DiskStorage unlinks the file and deletes
// `path`, leaving req.file behind for the error handler.
function cleanupUpload(req) {
  if (!req.file || typeof req.file.path !== "string") return;
  try {
    const safePath = path.join(UPLOADS_DIR, path.basename(req.file.path));
    fs.unlinkSync(safePath);
  } catch (e) {
    // ENOENT is benign — multer may have removed it, or the txn-side
    // cleanup ran first. Anything else (EACCES, EBUSY, EROFS) is an
    // operator-visible problem worth a log line.
    if (e.code !== "ENOENT") log.error({ req_id: req?.id || null, ip: req?.ip || null, tag: "upload-cleanup", err: e.message }, "[upload-cleanup] unlink failed");
  }
}

// The most of a refused upload's body that is drained rather than cut: twice the
// largest body any upload route accepts (lib/attachments.js ATTACHMENT_MAX_BYTES,
// 64 MiB; not imported, because lib/attachments opens the database). It bounds
// what one refusal makes the server read; a larger body is cut, which Firefox
// and WebKit show as a network error.
const REFUSE_DRAIN_MAX_BYTES = 128 * 1024 * 1024;

// Refuse an upload BEFORE reading its body (the pre-multer gates). The rest of
// the body is read and discarded, never buffered or stored: a connection reset
// while the browser is still uploading is what Firefox and WebKit report as a
// network error, dropping the answer before it (Chromium shows it). The answer
// goes out at once and a kept-alive connection carries the next request. A
// client that asked to close (`Connection: close`, or HTTP/1.0, which nginx
// speaks upstream by default) is answered once its body has ended, because Node
// closes such a connection as soon as the answer is finished. Only a body over
// REFUSE_DRAIN_MAX_BYTES is cut, once answered: one declaring more (answered
// with `Connection: close`), or a chunked one once that many bytes have
// arrived. The server's requestTimeout bounds a slow drain.
function refuseBeforeBody(req, res, status, payload) {
  req.unpipe && req.unpipe();
  let answered = false;
  const answer = () => { if (answered) return; answered = true; res.status(status).json(payload); };
  const cut = () => { try { req.destroy(); } catch (e) { swallowed("http:refuse-cut", e); } };
  const cutOnceAnswered = () => { if (res.writableFinished) cut(); else res.once("finish", cut); };
  const declared = parseInt(req.headers["content-length"], 10);
  if (Number.isFinite(declared) && declared > REFUSE_DRAIN_MAX_BYTES) {
    res.set("Connection", "close");
    answer();
    cutOnceAnswered();
    req.resume();
    return;
  }
  // `readableEnded`: a body some caller already read emits no further "end".
  const afterBody = !res.shouldKeepAlive && !req.readableEnded;
  let seen = 0;
  const count = (chunk) => {
    seen += chunk.length;
    if (seen <= REFUSE_DRAIN_MAX_BYTES) return;
    req.removeListener("data", count);
    answer();
    cutOnceAnswered();
  };
  req.on("data", count);
  if (afterBody) req.once("end", answer);
  req.resume();
  if (!afterBody) answer();
}

// ext-audit v7.15.12 — the deadline must cover the BODY, not just the headers.
// The previous version cleared the abort timer in a `finally` that ran as soon
// as fetch() resolved — i.e. when response headers arrived — leaving the body
// read completely unbounded. An upstream that sends headers and then stalls held
// the request open indefinitely, and since CxOne provisioning runs through a
// 5-worker pool (lib/cxone.js) a stalling IDP could occupy every worker and wedge
// provisioning. Reproduced against a deliberately stalling local server.
//
// The timer now survives until the body settles: the body-reading methods are
// wrapped so they clear it, and an abort DURING the body read is reported as the
// same FETCH_TIMEOUT the header phase produces. If a caller never reads the body
// the timer simply fires and aborts an already-complete response (harmless), and
// it is unref'd so a pending timer can never hold the process open at shutdown.
async function fetchWithTimeout(url, init = {}, timeoutMs = EXTERNAL_FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const asTimeout = (e) => {
    if (e && (e.name === "AbortError" || e.code === "ABORT_ERR")) {
      const err = new Error(`Upstream timeout after ${timeoutMs}ms: ${url}`);
      err.code = "FETCH_TIMEOUT";
      return err;
    }
    return e;
  };
  let res;
  try {
    res = await fetch(url, { ...init, signal: init.signal || ctl.signal });
  } catch (e) {
    clear();
    throw asTimeout(e);
  }
  // Deliberately NOT clearing here — the body is still streaming under the same
  // deadline. Each reader clears on settle.
  for (const method of ["json", "text", "arrayBuffer", "blob", "formData", "bytes"]) {
    if (typeof res[method] !== "function") continue;
    const orig = res[method].bind(res);
    res[method] = async (...args) => {
      try { return await orig(...args); }
      catch (e) { throw asTimeout(e); }
      finally { clear(); }
    };
  }
  return res;
}

module.exports = { fetchWithTimeout, EXTERNAL_FETCH_TIMEOUT_MS, cleanupUpload, refuseBeforeBody, REFUSE_DRAIN_MAX_BYTES, UPLOADS_DIR };
