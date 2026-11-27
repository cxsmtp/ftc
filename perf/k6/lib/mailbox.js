import http from "k6/http";
import { sleep } from "k6";

/**
 * Read an emailed sign-in code back out of a Mailpit relay (SMTP_HOST on the
 * target must point at it). Since v8.15.0 every account but the built-in
 * superadmin signs in with a code minted PER REQUEST (POST /api/auth/code/request),
 * so a scenario cannot pre-fetch codes in setup(): each sign-in waits for its own
 * mail, and that wait is part of what a participant experiences.
 *
 * Polls Mailpit's search API for the newest message to `email` received no
 * earlier than `notBeforeMs` (minus 2 s of clock skew; Mailpit and k6 share the
 * host clock in perf/storm-podman.sh), backing off 250 ms → 1 s. Returns
 * `{ code, createdMs }` or null after `timeoutS`.
 *
 *   MAILPIT_URL   http://mailpit:8025 (the relay's HTTP API)
 */
export const MAILPIT_URL = (__ENV.MAILPIT_URL || "http://mailpit:8025").replace(/\/+$/, "");
// The code alphabet is Crockford base32 minus I/L/O/U, printed 4-4 (lib/login-code.js).
const CODE_RE = /\b([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})\b/;

function jsonOf(res) { try { return res.json(); } catch (_) { return null; } }

export function readCode(email, notBeforeMs, timeoutS = 120) {
  const q = encodeURIComponent(`to:"${email}"`);
  const deadline = Date.now() + timeoutS * 1000;
  let delay = 0.25;
  while (Date.now() < deadline) {
    const r = http.get(`${MAILPIT_URL}/api/v1/search?query=${q}&limit=5`, { tags: { name: "mailpit-search", phase: "inbox" }, timeout: "30s" });
    const d = r.status === 200 ? jsonOf(r) : null;
    for (const m of (d && d.messages) || []) {
      const created = Date.parse(m.Created);
      if (!(created >= notBeforeMs - 2000)) continue;
      let mm = CODE_RE.exec(m.Snippet || "");
      if (!mm) {
        const full = http.get(`${MAILPIT_URL}/api/v1/message/${m.ID}`, { tags: { name: "mailpit-message", phase: "inbox" }, timeout: "30s" });
        const fd = full.status === 200 ? jsonOf(full) : null;
        mm = fd ? CODE_RE.exec(fd.Text || "") : null;
      }
      if (mm) return { code: mm[1], createdMs: created };
    }
    sleep(delay);
    delay = Math.min(1, delay * 2);
  }
  return null;
}

/** Empty the relay, so a code found later was minted by THIS run. */
export function clearMailbox() {
  http.del(`${MAILPIT_URL}/api/v1/messages`, null, { tags: { name: "mailpit-reset" } });
}
