import { getCsrfToken, mutate } from "./csrf.js";
import { loginFlow, sessionErrors } from "./metrics.js";
import { readCode } from "./mailbox.js";

/**
 * v8.15.0 — every account but the built-in superadmin signs in with an EMAILED
 * CODE (POST /api/auth/code/request, then POST /api/auth/code/redeem); there is
 * no password to post. The code is read back from the Mailpit relay the target
 * mails through (MAILPIT_URL, see ./mailbox.js), so the measured login flow now
 * includes the mail round trip, as a participant's does.
 *
 * Both doors answer 200 for every outcome and put the verdict in `ok` (a 4xx
 * would feed scanner reputation), so success is `body.ok`, never the status.
 */
function codeSignIn(baseUrl, email, tagPrefix) {
  const start = Date.now();
  const csrf1 = getCsrfToken(baseUrl);
  const rq = mutate("post", `${baseUrl}/api/auth/code/request`, { email }, csrf1, { name: `${tagPrefix}code-request` });
  const rqBody = rq.status === 200 ? (() => { try { return rq.json(); } catch (_) { return null; } })() : null;
  if (!rqBody || !rqBody.ok) { sessionErrors.add(1); return { csrfToken: csrf1, loginData: null, ok: false }; }
  const got = readCode(email, start - 1000, parseFloat(__ENV.MAIL_TIMEOUT_S || "120"));
  if (!got) { sessionErrors.add(1); return { csrfToken: csrf1, loginData: null, ok: false }; }
  const rd = mutate("post", `${baseUrl}/api/auth/code/redeem`, { email, code: got.code }, csrf1, { name: `${tagPrefix}login` });
  let body = null;
  try { body = rd.status === 200 ? rd.json() : null; } catch (_) { body = null; }
  if (!body || !body.ok) { sessionErrors.add(1); return { csrfToken: csrf1, loginData: null, ok: false }; }
  // Session regenerated — must re-fetch CSRF.
  const csrf2 = getCsrfToken(baseUrl);
  loginFlow.add(Date.now() - start);
  return { csrfToken: csrf2, loginData: body, ok: true };
}

/**
 * Sign in as a participant. Returns { csrfToken, loginData, ok }. The third
 * argument (a password) is accepted and ignored so older call sites keep working.
 */
export function loginParticipant(baseUrl, email, _passwordIgnored) {
  return codeSignIn(baseUrl, email, "");
}

/**
 * Sign in as an admin account. v6.10.85 — each admin-capable VU gets its own
 * `perf-admin-NN` account (getAdminParticipant in data.js) so single-session
 * enforcement cannot kill a sibling VU's session. Those accounts sign in with
 * codes; only the built-in superadmin (no participant given) still posts its
 * boot-generated password to /api/login.
 */
export function loginAdmin(baseUrl, participant) {
  if (participant && participant.email && participant.email !== "superadmin") {
    return codeSignIn(baseUrl, participant.email, "admin-");
  }
  const start = Date.now();
  const password = participant && participant.password ? participant.password : "";
  const csrf1 = getCsrfToken(baseUrl);
  const loginRes = mutate("post", `${baseUrl}/api/login`, { email: "superadmin", password }, csrf1, { name: "admin-login" });
  if (loginRes.status !== 200) {
    sessionErrors.add(1);
    return { csrfToken: csrf1, loginData: null, ok: false };
  }
  const csrf2 = getCsrfToken(baseUrl);
  loginFlow.add(Date.now() - start);
  return { csrfToken: csrf2, loginData: loginRes.json(), ok: true };
}
