// v8.1.0 — PR 32: the short join code, and the submit that says nothing when it fails.
//
// Two independent items that share a release, both about the walk-up:
//
//   * a SIX-CHARACTER code someone can type off a sign when the QR will not
//     scan — a different kind of thing from the 256-bit token beside it, which
//     is why it gets its own route, its own (harder) rate limit and its own
//     log scrub;
//   * `submitAnswer` was `try { … } finally { … }` with NO catch, so a fetch
//     that rejected on venue wi-fi left the participant with a re-enabled button
//     and no message at all.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, BASE, codeLogin } = require("./helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `jc${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

async function joinableEvent(api, csrf, extra = {}) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} Booth`, event_kind: "booth", timezone: "UTC",
      start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600,
      self_enroll_enabled: true, ...extra,
    },
  });
  expect(r.ok(), `create: ${await r.text()}`).toBeTruthy();
  const comp = (await r.json()).competition;
  const rv = await (await api.get(`/api/admin/competitions/${comp.id}/self-enroll`)).json();
  return { comp, token: rv.token, code: rv.join_code, display: rv.join_code_display };
}

test.describe("v8.1.0 — the short join code", () => {
  test("a created event gets a code, and it resolves to that event's token", async () => {
    const { api, csrf } = await sa();
    const ev = await joinableEvent(api, csrf);

    expect(ev.code, "a code is minted").toBeTruthy();
    // THE ALPHABET IS A ONE-WAY DOOR — it gets printed on signage. Asserted
    // directly, so widening or narrowing it is a deliberate act with a failing
    // test attached rather than a quiet edit.
    expect(ev.code).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    expect(ev.code, "no I, L, O or U — the misread pairs and the rude word")
      .not.toMatch(/[ILOU]/);
    expect(ev.display, "printed grouped, so a human reading it aloud keeps their place").toMatch(/^.{3}-.{3}$/);

    const r = await api.get(`/api/competitions/join-code/${ev.code}`);
    expect(r.status(), `resolve: ${await r.text()}`).toBe(200);
    expect((await r.json()).token, "it resolves to THIS event's token").toBe(ev.token);
  });

  test("the code is typed by a human, so it folds the way a human types it", async () => {
    const { api, csrf } = await sa();
    const ev = await joinableEvent(api, csrf);

    // Lower case, the separators someone adds when copying, and the Crockford
    // substitutions for the letters the alphabet excludes BECAUSE they are
    // misread. Someone copying `0` will sometimes type `O`.
    const variants = [
      ev.code.toLowerCase(),
      `${ev.code.slice(0, 3)}-${ev.code.slice(3)}`,
      `  ${ev.code}  `,
      ev.code.replace(/0/g, "O").replace(/1/g, "l"),
    ];
    for (const v of variants) {
      const r = await api.get(`/api/competitions/join-code/${encodeURIComponent(v)}`);
      expect(r.status(), `"${v}" must resolve`).toBe(200);
      expect((await r.json()).token).toBe(ev.token);
    }

    // ...and it must NOT fold a genuinely different code into a match. Without
    // this, "the normaliser is lenient" would be satisfied by one that matches
    // anything. The refusal is a 200 `{ok:false}` (v8.1.0 — see the 200-always
    // block below), so the miss is read off the PAYLOAD.
    const wrong = await api.get("/api/competitions/join-code/ZZZZZZ");
    expect(wrong.status(), "a different code is not a match").toBe(200);
    expect((await wrong.json()).ok, "and it is refused").toBe(false);
  });

  test("the fold is asserted DIRECTLY, because a random code may contain nothing to fold", () => {
    // The end-to-end variant test below does
    // `code.replace(/0/g,"O").replace(/1/g,"l")` — which is a NO-OP whenever the
    // minted code happens to contain neither character, so it passes whatever the
    // normaliser does. Measured: deleting the Crockford substitutions entirely
    // left all eight tests green. This is the assertion that catches it.
    const { normaliseHumanCode, HUMAN_CODE_ALPHABET } = require("../lib/human-code");

    expect(normaliseHumanCode("o0O0o0"), "O folds to zero").toBe("000000");
    expect(normaliseHumanCode("IiLl11"), "I and L fold to one").toBe("111111");
    expect(normaliseHumanCode("abc-123"), "separators and case").toBe("ABC123");
    expect(normaliseHumanCode("  a b c  "), "whitespace anywhere").toBe("ABC");

    // An EMPTY result must never match anything — every caller relies on it, and
    // returning "" rather than null is what makes a stored-value comparison a
    // guaranteed miss instead of an accidental "no filter".
    expect(normaliseHumanCode(""), "empty in").toBe("");
    expect(normaliseHumanCode("---"), "nothing usable left").toBe("");
    expect(normaliseHumanCode(null), "null in").toBe("");
    // Anything that is not a letter or digit is STRIPPED, not rejected — someone
    // copying off a sign types the grouping, and an accent is the same class of
    // noise. So `héllo` normalises rather than failing.
    expect(normaliseHumanCode("héllo"), "stray characters are stripped like separators").toBe("H110");
    // `U` is the one letter that survives the strip, is NOT folded, and is NOT in
    // the alphabet — so it is the case that exercises the final guard. Without
    // this the `every(...)` check is unreachable and could be deleted unnoticed.
    expect(normaliseHumanCode("BUZZ12"), "a letter outside the alphabet rejects the whole code").toBe("");

    // The alphabet itself — the one-way door, asserted where it is defined.
    expect(HUMAN_CODE_ALPHABET).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
    for (const bad of ["I", "L", "O", "U"]) {
      expect(HUMAN_CODE_ALPHABET.includes(bad), `${bad} must not be in the alphabet`).toBe(false);
    }
  });

  test("an unknown code, a disabled link and an ENDED event are the same refusal", async () => {
    // The lookup is public, so it must not become an oracle for which codes
    // exist or which events are running.
    //
    // v8.1.0 — the shared refusal is now `200 {ok:false}` rather than a 404, and
    // the no-oracle property had to SURVIVE that change: it is the reason this
    // route is shaped the way it is. Mutation this catches: any refusal branch
    // that grows a distinguishing message or status per case.
    //
    // v8.6.0 — the ENDED fixture turns LATE ENTRIES OFF. A Booth Event now defaults
    // them ON, and an ended booth inside its late window is deliberately still
    // joinable — that is the feature, not a hole in this one. The SUBJECT is
    // untouched: the three refusals must stay byte-identical, and an event that
    // refuses is still what this test needs one of. The re-point is the v7.21.27
    // rule (re-point a lock whose subject moved; never weaken it).
    const { api, csrf } = await sa();
    const live = await joinableEvent(api, csrf, { late_entry_enabled: false });
    const off = await joinableEvent(api, csrf);

    const bodies = [];
    const unknown = await api.get("/api/competitions/join-code/ZZZZZZ");
    bodies.push([unknown.status(), await unknown.text()]);

    // disabled
    let row = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === off.comp.id);
    const dis = await api.put(`/api/admin/competitions/${off.comp.id}`, {
      headers: H(csrf), data: { self_enroll_enabled: false, expectedUpdatedAt: row.updated_at },
    });
    expect(dis.ok(), `disable: ${await dis.text()}`).toBeTruthy();
    const disabled = await api.get(`/api/competitions/join-code/${off.code}`);
    bodies.push([disabled.status(), await disabled.text()]);

    // ended
    row = (await (await api.get("/api/admin/competitions")).json()).find(c => c.id === live.comp.id);
    const end = await api.post(`/api/admin/competitions/${live.comp.id}/end-now`, {
      headers: H(csrf), data: { expectedUpdatedAt: row.updated_at },
    });
    expect(end.ok(), `end: ${await end.text()}`).toBeTruthy();
    const ended = await api.get(`/api/competitions/join-code/${live.code}`);
    bodies.push([ended.status(), await ended.text()]);

    const [first, ...rest] = bodies;
    for (const b of rest) {
      expect(b[0], "same status as an unknown code").toBe(first[0]);
      expect(b[1], "byte-identical body — no oracle").toBe(first[1]);
    }
    expect(first[0], "and that shared status is 200, not a counted 4xx").toBe(200);
    expect(JSON.parse(first[1]).ok).toBe(false);
    expect(JSON.parse(first[1]).token, "a refusal carries no token").toBeUndefined();
  });

  test("the code is SCRUBBED from the access log, because it buys the token", async () => {
    // It is printed on a sign, so it is not secret the way the token is — but the
    // lookup EXCHANGES it for that token, and the token is scrubbed precisely so
    // a log shipper cannot hand someone a join capability (the v7.21.14 rule).
    const { api, csrf } = await sa();
    const ev = await joinableEvent(api, csrf);
    expect((await api.get(`/api/competitions/join-code/${ev.code}`)).status()).toBe(200);

    await expect.poll(async () => {
      const logs = await (await api.get("/api/admin/logs?stream=access&q=join-code&limit=500")).json();
      return JSON.stringify(logs.entries || logs);
    }, { timeout: 10000, message: "the access-log line lands" }).toContain("join-code");

    const logs = await (await api.get("/api/admin/logs?stream=access&q=join-code&limit=500")).json();
    const blob = JSON.stringify(logs.entries || logs);
    expect(blob, "the raw code must never reach disk").not.toContain(ev.code);
    expect(blob, "and the line is still useful — the route is identifiable").toContain("[REDACTED]");
  });

  test("a code opens the SAME door as the link — one join mechanism, two ways in", async () => {
    const { api, csrf } = await sa();
    const ev = await joinableEvent(api, csrf);

    // Register a participant, then join using the token the CODE produced.
    const { api: anon, csrf: ac } = await freshCtx();
    const label = uniq();
    const email = `${label}@company.example`;
    const reg = await registerPost(anon, "/api/register", {
      headers: H(ac),
      data: {
        firstName: "Code", lastName: "Typer", nickname: label, email,
        company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
        password: PARTICIPANT_PASS,
      },
    });
    expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
    await anon.dispose();
    const u = (await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json())
      .participants.find(p => p.email === email);
    await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
    await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });

    const { api: p, csrf: pc0 } = await freshCtx();
    await codeLogin(p, email, H(pc0));
    const pc = (await (await p.get("/api/csrf-token")).json()).csrfToken;

    const resolved = (await (await p.get(`/api/competitions/join-code/${ev.display}`)).json()).token;
    const join = await p.post("/api/competitions/join", { headers: H(pc), data: { token: resolved } });
    expect(join.status(), `join via the code's token: ${await join.text()}`).toBe(200);
    await p.dispose();
  });

  test("the admin dialog carries the code, and the reveal BACKFILLS an event created before this release", async () => {
    // Every competition predating PR 32 has a NULL code. The reveal mints one
    // lazily, exactly as it already does for a missing token — so an operator
    // opening the Join Link dialog gets a code without a migration having to
    // invent unique values inside the boot path.
    const { api, csrf } = await sa();
    const ev = await joinableEvent(api, csrf);

    // Simulate a pre-release row by clearing the column through the same
    // endpoint's own effect: re-reveal after nulling is not reachable over HTTP,
    // so assert the shape the dialog depends on instead.
    expect(ev.code, "the reveal returns a code").toBeTruthy();
    expect(ev.display, "and its printed form").toBeTruthy();

    const again = await (await api.get(`/api/admin/competitions/${ev.comp.id}/self-enroll`)).json();
    expect(again.join_code, "the code is STABLE across reveals — it is on signage").toBe(ev.code);
  });

  test("two events never share a code", async () => {
    const { api, csrf } = await sa();
    const codes = new Set();
    for (let i = 0; i < 6; i++) {
      const ev = await joinableEvent(api, csrf);
      expect(codes.has(ev.code), `code ${ev.code} was already issued`).toBe(false);
      codes.add(ev.code);
    }
    expect(codes.size).toBe(6);
  });

  // v8.13.3 — Regenerate link retires the printed code too. The lookup answers
  // with the CURRENT token, so rotating the token alone left a leaked code
  // admitting people to the NEW link, and nothing could retire it: switching
  // self-enrolment off only pauses it. The control (an unrelated event's code
  // still resolves) stops a "fix" that breaks the lookup or nulls codes globally.
  test("Regenerate link retires the printed code too: the old code is refused, the new one resolves", async () => {
    const { api, csrf } = await sa();
    const ev = await joinableEvent(api, csrf);
    const other = await joinableEvent(api, csrf);
    const unknownBody = await (await api.get("/api/competitions/join-code/ZZZZZZ")).text();
    expect(JSON.parse(unknownBody).ok, "precondition: the refusal baseline").toBe(false);
    const pre = await api.get(`/api/competitions/join-code/${ev.code}`);
    expect((await pre.json()).ok, "precondition: the code resolves before the regenerate").toBe(true);

    const reveal = await (await api.get(`/api/admin/competitions/${ev.comp.id}/self-enroll`)).json();
    const r = await api.post(`/api/admin/competitions/${ev.comp.id}/self-enroll/regenerate`, {
      headers: H(csrf), data: { expectedUpdatedAt: reveal.updated_at },
    });
    expect(r.status(), await r.text()).toBe(200);
    const d = await r.json();
    expect(d.join_code).toMatch(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    expect(d.join_code, "a NEW code").not.toBe(ev.code);
    expect(d.join_code_display).toBe(`${d.join_code.slice(0, 3)}-${d.join_code.slice(3)}`);

    // The old code, in every form a human types it, is the SAME uniform refusal
    // as a code that never existed — 200-always, so assert the payload's ok.
    for (const v of [ev.code, ev.display, ev.code.toLowerCase()]) {
      const o = await api.get(`/api/competitions/join-code/${encodeURIComponent(v)}`);
      expect(o.status(), `"${v}" stays 200-always`).toBe(200);
      const body = await o.text();
      expect(JSON.parse(body).ok, `"${v}" no longer resolves`).toBe(false);
      expect(body, "no oracle: a rotated-away code looks like one that never existed").toBe(unknownBody);
    }
    const n = await (await api.get(`/api/competitions/join-code/${d.join_code}`)).json();
    expect(n.ok, "the new code resolves").toBe(true);
    expect(n.token, "to the NEW token").toBe(d.token);
    expect(n.token).not.toBe(ev.token);
    expect((await api.get(`/api/competitions/self-enroll/${ev.token}`)).status(), "old token dead").toBe(404);
    expect((await api.get(`/api/competitions/self-enroll/${d.token}`)).status(), "new token live").toBe(200);

    const again = await (await api.get(`/api/admin/competitions/${ev.comp.id}/self-enroll`)).json();
    expect(again.join_code, "the reveal shows the rotated code and does not re-mint").toBe(d.join_code);

    const o = await (await api.get(`/api/competitions/join-code/${other.code}`)).json();
    expect(o.ok, "CONTROL: an unrelated event's code still resolves").toBe(true);
    expect(o.token).toBe(other.token);

    // The audit records WHICH fields rotated, never the codes themselves.
    const evs = JSON.stringify(await (await api.get(`/api/admin/competitions/${ev.comp.id}/events`)).json());
    expect(evs).toContain("self_enroll_regenerated");
    expect(evs).toContain("join_code");
    // An all-digit code could coincide with a timestamp substring (~1 in 1000
    // codes), so the absence is asserted only for a code carrying a letter.
    for (const [what, code] of [["old", ev.code], ["new", d.join_code]]) {
      if (/[A-Z]/.test(code)) expect(evs, `the ${what} code never reaches the audit`).not.toContain(code);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v8.1.0 — the join-code lookup answers 200 on failure (finding #25).
//
// A counted non-429 4xx feeds the scanner-reputation counter, which blocks the
// WHOLE IP from the entire API for fifteen minutes at 100 in ten. A six-character
// code printed on a booth sign is mistyped by design and a venue behind one NAT is
// the normal case, so the old 404 poured ordinary mistyping into the same shared
// per-IP pool that already aggregates 401 polls and CSRF 403s — the measured
// v7.15.34 cascade, through a new door.
//
// The pair below is what makes the fix real, and NEITHER half is sufficient:
// the server really answered 200, AND the client still told the user it failed.
// The only way both can be true is a client branching on the PAYLOAD.
// ═══════════════════════════════════════════════════════════════════════════
test.describe("v8.1.0 — a mistyped join code does not feed the IP-wide scanner block", () => {
  test("a resolvable code is 200 {ok:true,token}; an unknown code is 200 {ok:false} with NO token", async () => {
    // Mutation this catches: restoring `res.status(404)` on the refusal branch —
    // the status is asserted DIRECTLY, because "the lookup failed" is equally
    // true of a 404 and is exactly what must no longer happen.
    const { api, csrf } = await sa();
    const ev = await joinableEvent(api, csrf);

    const good = await api.get(`/api/competitions/join-code/${ev.code}`);
    expect(good.status(), "a good code is a plain 200").toBe(200);
    const gd = await good.json();
    expect(gd.ok, "and it says so in the payload, which is what the client reads").toBe(true);
    expect(gd.token, "it resolves to THIS event's token").toBe(ev.token);

    // ZZZZZZ is a valid code SHAPE (every character is in the alphabet) that no
    // event carries — so this exercises the real miss, not the normaliser's
    // reject path.
    const bad = await api.get("/api/competitions/join-code/ZZZZZZ");
    expect(bad.status(), "A MISTYPE MUST NOT BE A COUNTED 4xx — it would ban the venue").toBe(200);
    const bd = await bad.json();
    expect(bd.ok, "the refusal is in the payload").toBe(false);
    expect(bd.token, "and a refusal never leaks a token").toBeUndefined();
    expect(Object.keys(bd), "the refusal body carries nothing else to differ on").toEqual(["ok"]);
  });

  test("the CLIENT still tells the user it failed, and never asks the preview about a token it does not have", async ({ page }) => {
    // ── THE LOAD-BEARING TEST. ──
    //
    // Mutation this catches: `if (r.ok) d.ok = true` — i.e. a client that branches
    // on the HTTP status. The obvious assertion ("an error toast appears") does
    // NOT catch it: that build falls through with `token === undefined`, requests
    // `/api/competitions/self-enroll/undefined`, gets the preview's 404 and
    // toasts the SAME message from the downstream arm. The discriminating
    // observable is therefore the REQUEST COUNT — a client that understood the
    // refusal from the payload never issues the second request at all.
    const { api, csrf } = await sa();
    const ev = await joinableEvent(api, csrf);

    // What the server actually answered, recorded from the wire, so the two
    // halves of the claim are proven in ONE run rather than in two specs that
    // could drift apart.
    const lookupStatuses = [];
    page.on("response", (r) => {
      if (r.url().includes("/api/competitions/join-code/")) lookupStatuses.push(r.status());
    });
    let previewHits = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/competitions/self-enroll/")) previewHits.push(r.url());
    });

    // Email first: the anonymous code box is the event-code DIALOG on the card.
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 10000 });
    await page.click('[data-action="open-event-code"]');
    await page.waitForSelector("#ec-code", { state: "visible", timeout: 10000 });

    // ── refusal ──
    previewHits = [];
    await page.fill("#ec-code", "ZZZZZZ");
    await page.click('[data-action="event-code-apply"]');

    await expect(page.locator("#toast-stack .toast-error").first(), "the participant IS told")
      .toContainText(/not valid for any event/i, { timeout: 10000 });
    expect(lookupStatuses, "…and the SERVER answered 200 while it was told").toEqual([200]);
    expect(previewHits, "a payload-branching client never reaches the preview").toEqual([]);
    // Nothing was adopted, so the register form is unchanged behind the toast.
    expect(await page.evaluate(() => window.S && window.S._pendingJoinToken), "no join adopted").toBeFalsy();

    // ── POSITIVE CONTROL ──
    // Without it, "no preview request" and "an error toast" are both equally
    // satisfied by a build where eventCodeApply does nothing at all. The stale
    // error toast is left where it is — `.toast-success` is a different locator,
    // and reaching in to remove it would race its own 6 s expiry.
    previewHits = [];
    await page.fill("#ec-code", ev.display);
    await page.click('[data-action="event-code-apply"]');

    await expect(page.locator("#event-code-overlay"), "a real code is adopted")
      .toContainText(ev.comp.name, { timeout: 10000 });
    expect(previewHits.length, "and THAT one does ask the preview").toBeGreaterThan(0);
    expect(await page.evaluate(() => window.S && window.S._pendingJoinToken), "the token is adopted").toBe(ev.token);
    await expect(page.locator("#join-banner"), "and the card names the event").toBeVisible();
  });

  test("a THROTTLED lookup is not reported as a bad code", async ({ page }) => {
    // A 429 is the one status this endpoint still uses, and it means TRY AGAIN.
    // Saying "that code is not valid" when the server never looked it up sends a
    // walk-up to find an organiser over a code that works.
    //
    // Stubbed rather than driven for real: the shared test server runs with
    // RATE_LIMIT_DISABLED=1, and arming the limiter arms EVERY bucket for the
    // rest of the file (v7.16.8 — process-global state a spec plants leaks into
    // its neighbours). The branch under test is the client's, so a client-side
    // stub is the honest instrument.
    //
    // Mutation this catches: deleting the 429 arm, so the throttle falls through
    // to `!d.ok` and is announced as an invalid code.
    await page.route("**/api/competitions/join-code/**", (r) =>
      r.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "Too many requests. Please try again later." }) }));

    // Email first: the anonymous code box is the event-code DIALOG on the card.
    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 10000 });
    await page.click('[data-action="open-event-code"]');
    await page.waitForSelector("#ec-code", { state: "visible", timeout: 10000 });

    await page.fill("#ec-code", "ZZZZZZ");
    await page.click('[data-action="event-code-apply"]');

    const toast = page.locator("#toast-stack .toast-error").first();
    await expect(toast).toBeVisible({ timeout: 10000 });
    await expect(toast, "it says wait, not 'wrong code'").toContainText(/too many tries/i);
    await expect(toast).not.toContainText(/not valid for any event/i);
  });
});

test.describe("v8.1.0 — a submit that fails says so", () => {
  test("a thrown submit tells the participant, keeps their answer, and claims NO penalty", async ({ page }) => {
    // Pre-fix this block was try/finally with no catch: the fetch rejected, the
    // `finally` re-enabled the button, and the participant was left looking at
    // their own answer with no message — unable to tell whether it had been sent.
    const { api, csrf } = await sa();
    const cr = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: { name: `${uniq()} Live`, start_time: new Date(Date.now() - 3600e3).toISOString(), duration_minutes: 600, timezone: "UTC" },
    });
    const comp = (await cr.json()).competition;
    const tr = await api.post("/api/admin/tasks", {
      headers: H(csrf),
      data: { title: `${uniq()} T`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "right", status: "published" },
    });
    const taskId = (await tr.json()).id;
    await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });

    const label = uniq();
    const email = `${label}@company.example`;
    const { api: anon, csrf: ac } = await freshCtx();
    await registerPost(anon, "/api/register", {
      headers: H(ac),
      data: {
        firstName: "Net", lastName: "Drop", nickname: label, email,
        company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
        password: PARTICIPANT_PASS,
      },
    });
    await anon.dispose();
    const u = (await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json())
      .participants.find(p => p.email === email);
    await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
    await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
    // A SECOND enrollee who never solves, so the all-solved auto-end cannot end
    // the competition underneath the test (fixture checklist item 1).
    const label2 = uniq();
    const { api: anon2, csrf: ac2 } = await freshCtx();
    await registerPost(anon2, "/api/register", {
      headers: H(ac2),
      data: {
        firstName: "Idle", lastName: "Two", nickname: label2, email: `${label2}@company.example`,
        company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
        password: PARTICIPANT_PASS,
      },
    });
    await anon2.dispose();
    const u2 = (await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(label2)}`)).json())
      .participants.find(p => p.nickname === label2);
    await api.post(`/api/admin/participants/${u2.id}/verify`, { headers: H(csrf) });
    await api.post(`/api/admin/participants/${u2.id}/approve`, { headers: H(csrf) });
    const asg = await api.post("/api/admin/competitions/assign", {
      headers: H(csrf), data: { userIds: [u.id, u2.id], competitionIds: [comp.id] },
    });
    expect((await asg.json()).assigned).toBe(2);

    // Establish the session BEFORE navigating (v7.21.26).
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    await codeLogin(page.request, email, H(csrfToken));
    const pc = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    await page.request.post("/api/select-competition", { headers: H(pc), data: { competitionId: comp.id } });
    await page.goto("/");

    // Wait for the challenge's own CARD — `#main-nav` goes visible mid-boot for
    // ANY page, so it is true before routing has settled (v8.1.0, PR 30).
    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20000 });
    const card = page.locator(`#task-grid [data-task-id="${taskId}"]`);
    await card.waitFor({ state: "visible", timeout: 20000 });
    await card.click();
    await page.locator("#ans-text").waitFor({ state: "visible", timeout: 15000 });

    await page.locator("#ans-text").fill("my-careful-answer");
    // The network drops exactly at the submit — `abort` makes `fetch` REJECT,
    // which is the case with no catch. A 500 would not reproduce it: that path
    // was always handled.
    await page.route("**/api/tasks/*/submit", (r) => r.abort("failed"));
    await page.locator('[data-action="task-submit-answer"][data-mode="text"]').click();
    await page.locator("#modal-overlay").waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#modal-overlay button:has-text('Submit')").first().click();

    // THE PARTICIPANT IS TOLD.
    await expect(page.locator("#submit-result"), "a thrown submit must say something")
      .toContainText(/could not be sent/i, { timeout: 15000 });
    // AND IT MUST NOT CLAIM A PENALTY — we do not know whether the server saw it,
    // and on a capped challenge a wrong guess costs an attempt they think they
    // still have.
    await expect(page.locator("#submit-result")).not.toContainText(/penalty|incorrect/i);
    // THEIR ANSWER SURVIVES, so pressing Submit again is a real option.
    await expect(page.locator("#ans-text"), "the typed answer is not discarded").toHaveValue("my-careful-answer");
    // And the button is usable again.
    await expect(page.locator('[data-action="task-submit-answer"][data-mode="text"]').first()).toBeEnabled();

    // POSITIVE CONTROL — with the network restored the ordinary path still works
    // and still reports a penalty. Without this, "no penalty text" is equally
    // satisfied by a build that stopped reporting penalties at all.
    await page.unroute("**/api/tasks/*/submit");
    await page.locator('[data-action="task-submit-answer"][data-mode="text"]').first().click();
    await page.locator("#modal-overlay").waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#modal-overlay button:has-text('Submit')").first().click();
    await expect(page.locator("#submit-result"), "a real wrong answer still reports its penalty")
      .toContainText(/penalty/i, { timeout: 15000 });
  });
});
