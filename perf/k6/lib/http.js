import http from "k6/http";
import { defaultHeaders } from "./csrf.js";
import { failedByStatus, failed403ByName } from "./metrics.js";

// v6.10.33 — drop-in replacements for http.get / http.post that:
//   1. Always include the maintenance-bypass header (defaultHeaders()).
//      Previously only csrf.js wired the header in, so every plain
//      http.get(...) in participant.js + admin.js was going out without
//      the bypass and receiving 503 from the maintenance gate. That
//      single omission accounts for the ~80% http_req_failed rate
//      observed in full-scale runs.
//   2. Tag any non-2xx/3xx response into `failed_by_status{status}`.
//      The aggregate http_req_failed threshold is too coarse — this
//      counter preserves the status-code breakdown so a diagnostic
//      pass can tell expected-4xx from real-5xx at a glance.
//
// Callers that need custom headers can pass { headers: {...} } as usual;
// defaults are merged underneath so explicit headers still win.

function mergeParams(params) {
  return {
    ...params,
    headers: { ...defaultHeaders(), ...(params && params.headers ? params.headers : {}) },
  };
}

// v6.10.56 — classify() now takes the request `name` (pulled from
// params.tags.name by the call-site wrappers) and:
//   1. Tags failed_by_status with {status, name} so the next run's
//      summary can break 401s down by endpoint.
//   2. Emits a console.warn on every 401 with the path. k6's default
//      summary only surfaces sub-metrics that have thresholds defined;
//      enumerating thresholds for every (status, name) pair is
//      impractical, so the warn log is the grep-able fallback. Post-
//      run: `grep session-401 k6.log | sort | uniq -c` gives the
//      per-endpoint count without needing threshold boilerplate.
//      Previous runs surfaced the AGGREGATE 401 count (230) but no
//      attribution — session_errors=34 counted one path (task-detail)
//      and the other ~196 × 401s landed silently.
function classify(res, name) {
  if (res.status < 200 || res.status >= 400) {
    const label = name || "unnamed";
    failedByStatus.add(1, { status: String(res.status), name: label });
    if (res.status === 401) {
      // v6.10.59 — include __VU + __ITER so a post-run `sort | uniq -c`
      // on vu=… tells us whether all 401s come from a single VU
      // (suggests that VU's participant is getting killed externally —
      // still a collision, just not the one we thought) or from many
      // distinct VUs (server-side issue: admin invalidation, session
      // store eviction, shared-state bug). __VU and __ITER are k6
      // globals available in every scenario-function execution.
      console.warn(`[session-401] vu=${__VU} iter=${__ITER} path=${label}`);
    }
    if (res.status === 403) {
      // v6.10.84 — per-endpoint 403 attribution. The v6.10.83 WAN run
      // measured 1829× 403 (7.78 % of all HTTP, 99.5 % of all failures)
      // with zero k6-summary attribution because `failed_by_status{status:403}`
      // aggregates across every `name` tag. Two mechanisms in parallel:
      //   1. console.warn per 403 with (vu, iter, path) so
      //      `grep endpoint-403 k6.log | awk '{print $NF}' | sort | uniq -c`
      //      gives per-route counts from the log file.
      //   2. `failed_403_by_name{name}` Counter mirrors the tag to
      //      k6's metrics stream; combined with the per-name thresholds
      //      declared in competition-live.js, the summary's default
      //      section renders each endpoint that produced any 403s. No
      //      log parsing required for the short-list view.
      console.warn(`[endpoint-403] vu=${__VU} iter=${__ITER} path=${label}`);
      failed403ByName.add(1, { name: label });
    }
  }
  return res;
}

function _nameOf(params) {
  return params && params.tags && params.tags.name;
}

export function get(url, params = {}) {
  return classify(http.get(url, mergeParams(params)), _nameOf(params));
}

export function post(url, body, params = {}) {
  return classify(http.post(url, body, mergeParams(params)), _nameOf(params));
}

// v6.10.73 — safe JSON parser for k6 http responses. On a transport
// failure (network timeout, DNS error, TLS handshake reject), k6
// returns a response object with body=null / status=0, and calling
// `res.json()` on it throws:
//   GoError: the body is null so we can't transform it to JSON
// That crash blew past callers' graceful-degrade paths — one
// iteration lost with a noisy stack trace instead of a quiet metric.
// v6.10.68 guarded `getCsrfToken` directly; v6.10.73 generalises the
// pattern for every other .json() callsite via this helper. Returns
// null on null body OR JSON-parse failure (e.g. a proxy error page
// that came back 200 but isn't JSON). Callers use
//   const body = safeJson(res) || {};
// so subsequent property access doesn't re-crash on null.
export function safeJson(res) {
  if (!res || !res.body) return null;
  try { return res.json(); } catch (_) { return null; }
}
