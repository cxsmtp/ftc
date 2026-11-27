import http from "k6/http";
import { csrfFetch, csrfFailures, failedByStatus } from "./metrics.js";

const MAINTENANCE_BYPASS = __ENV.MAINTENANCE_BYPASS || "";

/**
 * Default headers applied to every request. Includes the maintenance-bypass
 * token when the env var is set, so perf tests pass through the gate.
 */
export function defaultHeaders() {
  return MAINTENANCE_BYPASS ? { "x-maintenance-bypass": MAINTENANCE_BYPASS } : {};
}

/**
 * Fetch a CSRF token from the server.
 * The session cookie is handled automatically by k6's cookie jar.
 *
 * v6.10.68 — harden against transport-level failures. On a network
 * timeout / DNS error / TLS handshake failure, k6's http.get returns
 * a response object with `body: null` and `status: 0`, and the
 * previous shape (`res.json("csrfToken")` unconditionally) then
 * crashed the iteration with:
 *   GoError: the body is null so we can't transform it to JSON -
 *   this likely was because of a request error getting the response
 * The v6.10.67 perf run surfaced one such crash at T+177 s
 * (i/o-timeout on /api/csrf-token) — one iteration lost, not a
 * systemic problem, but the crash blows past the scenario's
 * graceful-degrade paths (sessionErrors counter, login retry).
 * Check status / body before calling .json(); on any transport
 * issue, bump `csrf_failures` and return an empty token so the
 * caller's existing empty-token-path (login will 403 → sessionErrors
 * bumped → VU sleeps 10 s and retries next iter) picks it up.
 */
export function getCsrfToken(baseUrl) {
  const res = http.get(`${baseUrl}/api/csrf-token`, { headers: defaultHeaders(), tags: { name: "csrf-token" } });
  csrfFetch.add(res.timings.duration);
  if (!res || !res.body || res.status < 200 || res.status >= 400) {
    csrfFailures.add(1);
    return "";
  }
  try {
    const token = res.json("csrfToken");
    if (!token) csrfFailures.add(1);
    return token || "";
  } catch (_) {
    // Defensive: body is non-null but not JSON (proxy error page,
    // truncated response, etc.). Same fallback — empty token, bump
    // failures, let the caller's retry path handle it.
    csrfFailures.add(1);
    return "";
  }
}

// v6.10.56 — mutations that fail are now tagged into failed_by_status
// with the same {status, name} pair that the GET wrapper uses. Before,
// mutate() went straight through `http[method]` and any POST 401 /
// 500 was invisible in the breakdown. Keeps 401 attribution symmetric
// between GET and POST paths.
function _classifyMutation(res, name) {
  if (res.status < 200 || res.status >= 400) {
    const label = name || "unnamed";
    failedByStatus.add(1, { status: String(res.status), name: label });
    if (res.status === 401) {
      // v6.10.59 — mirror the http.js classifier's VU+ITER identity.
      console.warn(`[session-401] vu=${__VU} iter=${__ITER} path=${label}`);
    }
  }
  return res;
}

/**
 * Make a mutating request with CSRF token.
 * Returns the http response.
 */
export function mutate(method, url, body, csrfToken, extraTags = {}) {
  const params = {
    headers: {
      ...defaultHeaders(),
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    },
    tags: extraTags,
  };
  const res = http[method](url, JSON.stringify(body), params);
  return _classifyMutation(res, extraTags && extraTags.name);
}

// v6.10.39 — k6 HTTP responses are host objects (Go structs through goja).
// Recent k6/browser versions reject arbitrary property assignment with
// `TypeError: Cannot assign to property _newCsrfToken of a host object`.
// Wrap the response in a plain object that carries the side-channel
// _newCsrfToken token + proxies the minimum API surface every caller
// uses (status, timings, headers, body, json()). json() is a method —
// bind it so `this` still refers to the original response when invoked.
//
// v6.10.73 — wrapped json() now returns null instead of throwing on a
// transport-null body or a non-JSON body. Pre-fix `res.json.bind(res)`
// re-threw the same GoError v6.10.68 caught in getCsrfToken, on the
// mutation path — killed an iteration with a stack trace (v6.10.72
// run surfaced exactly this at submitCorrect/participant.js:157 after
// an i/o-timeout on POST /submit). Callers that already treat a null-
// bodied response gracefully now pick the null body up via `body`,
// and those that do `res.json().foo` can switch to
// `(res.json() || {}).foo` without any other shape change.
function _wrap(res, newCsrfToken) {
  return {
    status: res.status,
    timings: res.timings,
    headers: res.headers,
    body: res.body,
    json: (...args) => {
      if (!res.body) return null;
      try { return res.json(...args); } catch (_) { return null; }
    },
    _newCsrfToken: newCsrfToken,
  };
}

/**
 * Retry a mutation once if it fails with CSRF error.
 *
 * The retry can only rescue an ANONYMOUS session. The server ends every session
 * carrying an identity on a refused token — a user account's since v8.3.13, the
 * built-in superadmin's too since v8.13.4 — so a signed-in VU's retry meets a
 * fresh anonymous session and is refused again (401/403), and the caller's
 * re-login path is what recovers it.
 */
export function mutateWithRetry(method, url, body, csrfToken, baseUrl, tags = {}) {
  let res = mutate(method, url, body, csrfToken, tags);
  if (res.status === 403) {
    const errBody = res.json();
    if (errBody && String(errBody.error || "").toLowerCase().includes("csrf")) {
      csrfFailures.add(1);
      const newToken = getCsrfToken(baseUrl);
      res = mutate(method, url, body, newToken, tags);
      return _wrap(res, newToken);
    }
  }
  return _wrap(res, null);
}
