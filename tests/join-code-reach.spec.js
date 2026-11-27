// v8.2.3 — the short event code, and the walk-up deal it belongs to.
//
// Four reports from a live stand, and three of them are the same shape: the
// platform PRINTED something an organiser was expected to act on and then gave
// them nowhere to act.
//
//   * a Booth Event's join link must be live the moment it exists (a per-kind
//     seed, bound with the `=== undefined` rule so "absent" and "false" differ).
//     The "Allow instant join" switch that once rode with it is retired
//     (operator ruling, 14 Nov 2026): every walk-up confirms their email with a
//     code, and a create or edit naming the switch is refused by name;
//   * the dialog printed six characters with no address beside them, so the one
//     thing the sign needs was missing from the screen that issues it;
//   * the code could only be typed on the SIGN-UP form, so an attendee who
//     already had an account had no way in at all;
//   * and with self-enrollment OFF the code was the one part of the dialog
//     still rendering as fully live.
//
// The fourth fix could not be "add the code to the existing dim": that dim is
// `opacity`, i.e. an alpha COMPOSITE, and the numbers are asserted below.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, BASE, appearanceSettled } = require("./helpers");
const { adminLogin, loginViaApi, fillBreakGlass, submitLogin } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `jcr${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

// Deliberately sends NEITHER self-enroll flag unless a caller asks for one: the
// whole subject of the first two tests is what the server does when the create
// body says nothing.
async function makeEvent(api, csrf, kind, extra = {}) {
  const r = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} ${kind}`, event_kind: kind, timezone: "UTC",
      start_time: new Date(Date.now() - 3600e3).toISOString(),
      ...(kind === "program" ? { deadline_at: new Date(Date.now() + 30 * 864e5).toISOString() } : { duration_minutes: 600 }),
      ...extra,
    },
  });
  expect(r.ok(), `create ${kind}: ${await r.text()}`).toBeTruthy();
  return (await r.json()).competition;
}

async function reveal(api, id) {
  const r = await api.get(`/api/admin/competitions/${id}/self-enroll`);
  expect(r.ok(), `reveal: ${r.status()}`).toBeTruthy();
  return r.json();
}

// A participant who already has an account — the population the code could not
// serve. Verified + approved through the admin routes rather than a join link,
// because the point is an ORDINARY account that predates this event.
async function makeParticipant(api, csrf) {
  const label = uniq();
  const email = `${label}@company.example`;
  const { api: anon, csrf: ac } = await freshCtx();
  const reg = await registerPost(anon, "/api/register", {
    headers: H(ac),
    data: {
      firstName: "Returning", lastName: "Attendee", nickname: label, email,
      company: "Acme", title: "Engineer", country: "US", timezone: "America/New_York",
      password: PARTICIPANT_PASS,
    },
  });
  expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
  await anon.dispose();
  // `?search=` is a NO-OP on this endpoint — the handler never reads it — so this
  // is page 1 ordered created_at ASC, i.e. the N OLDEST users, and the account we
  // just made is the NEWEST. The limit is the endpoint's documented 5000 cap
  // rather than a number that happens to exceed today's pool (v8.2.3).
  const _list = await (await api.get(`/api/admin/participants?limit=5000`)).json();
  const u = (_list.participants || []).find(p => p.email === email);
  expect(u, `the new participant is findable: ${email} — scanned ${(_list.participants || []).length} of ${_list.total}`).toBeTruthy();
  const v = await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
  expect(v.ok(), `verify: ${await v.text()}`).toBeTruthy();
  const a = await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
  expect(a.ok(), `approve: ${await a.text()}`).toBeTruthy();
  return { email, id: u.id };
}

// Contrast, computed in the page against the tokens as they actually resolve —
// not against remembered hex values, and not against the token NAME. An
// `opacity` anywhere in the ancestry is what this is here to catch, so the
// composite has to be measured from the rendered colours.
const CONTRAST_FN = `(fg,bg)=>{const p=h=>h.match(/\\d+(\\.\\d+)?/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4));const l=c=>0.2126*c[0]+0.7152*c[1]+0.0722*c[2];const a=l(p(fg)),b=l(p(bg));const[x,y]=a>b?[a,b]:[b,a];return (x+0.05)/(y+0.05);}`;

test.describe("v8.2.3 — the walk-up deal, and where the code is typed", () => {
  test("a Booth Event opens with its join link ON; the other two kinds do not", async () => {
    // THE CONTROL IS THE TEST: "a booth's link is on" is equally satisfied by a
    // build that turned it on for every kind.
    const { api, csrf } = await sa();
    const booth = await makeEvent(api, csrf, "booth");
    expect(booth.self_enroll_enabled, "a Booth Event: the link is live").toBe(1);
    expect(booth, "the retired instant-join switch is not on the wire").not.toHaveProperty("self_enroll_allow_instant");
    for (const kind of ["tournament", "program"]) {
      const other = await makeEvent(api, csrf, kind);
      expect(other.self_enroll_enabled, `a ${kind}: link OFF`).toBe(0);
    }
    await api.dispose();
  });

  test("\"Allow instant join\" is retired: a create or edit naming it is refused by name, in BOTH directions, and changes nothing", async () => {
    // Operator ruling, 14 Nov 2026. Accept-and-ignore would be a control that
    // appears to work, so the switch is refused rather than dropped.
    const { api, csrf } = await sa();
    const name = `${uniq()} refused`;
    for (const v of [true, false]) {
      const r = await api.post("/api/admin/competitions", {
        headers: H(csrf),
        data: { name, event_kind: "booth", timezone: "UTC", start_time: new Date(Date.now() + 3600e3).toISOString(), duration_minutes: 60, self_enroll_allow_instant: v },
      });
      expect(r.status(), `create with the switch ${v}: ${await r.text()}`).toBe(400);
      expect((await r.json()).code).toBe("self_enroll_instant_removed");
    }
    const all = await (await api.get("/api/admin/competitions")).json();
    expect(all.some((c) => c.name === name), "the refused creates made nothing").toBe(false);

    // The edit: refused by name, the row untouched (its version did not move).
    const ev = await makeEvent(api, csrf, "booth");   // CONTROL: the same create without the switch succeeds
    const before = (await (await api.get(`/api/admin/competitions/${ev.id}/self-enroll`)).json()).updated_at;
    for (const v of [true, false]) {
      const p = await api.put(`/api/admin/competitions/${ev.id}`, { headers: H(csrf), data: { self_enroll_allow_instant: v, expectedUpdatedAt: before } });
      expect(p.status(), `edit with the switch ${v}: ${await p.text()}`).toBe(400);
      expect((await p.json()).code).toBe("self_enroll_instant_removed");
    }
    const after = (await (await api.get(`/api/admin/competitions/${ev.id}/self-enroll`)).json()).updated_at;
    expect(after, "the refused edits changed nothing").toBe(before);
    // CONTROL: the same edit without the switch is accepted.
    const ok = await api.put(`/api/admin/competitions/${ev.id}`, { headers: H(csrf), data: { self_enroll_enabled: false, expectedUpdatedAt: before } });
    expect(ok.status(), `edit without the switch: ${await ok.text()}`).toBe(200);
    await api.dispose();
  });

  test("the dialog says WHERE the code is typed, and the address comes from the SERVER", async () => {
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf, "booth");
    const rv = await reveal(api, ev.id);

    expect(rv.join_code_display, "a code is minted").toBeTruthy();
    // The link beside it is built from BASE_URL, so the printed address must be
    // too — a deployment reached through a second hostname would otherwise put
    // an address on the sign that disagrees with the QR above it.
    expect(rv.site_url, "the reveal carries the site address").toBeTruthy();
    expect(rv.url.startsWith(rv.site_url), "…and it is the same origin the /join link is built from").toBeTruthy();
    await api.dispose();
  });

  test("the rendered dialog carries the address AND the code, and the inactive state covers BOTH", async ({ page }) => {
    const { api, csrf } = await sa();
    // Created OFF explicitly, so the dialog opens in the inactive state without
    // the test having to drive a toggle it is not testing.
    const ev = await makeEvent(api, csrf, "booth", { self_enroll_enabled: false });
    const rv = await reveal(api, ev.id);
    const host = rv.site_url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");

    // The overlay opens on `modal-in`, which animates OPACITY — so a measurement
    // taken on arrival samples the dialog mid-fade and reports an ancestor alpha
    // of 0.75 that has nothing to do with the inactive state. Caught by this very
    // assertion on its first run, which is the v7.23.0 `.reveal` hazard in a new
    // dialog: `waitFor({state:"visible"})` is satisfied at opacity 0.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await adminLogin(page);
    await page.evaluate((id) => window.openSelfEnrollOverlay(id, "Reach Booth"), ev.id);
    await page.locator("#self-enroll-overlay").waitFor({ state: "visible", timeout: 10000 });
    await page.locator("#self-enroll-code-box").waitFor({ state: "visible", timeout: 10000 });
    // Belt and braces: reduced motion shortens the animation, it does not prove
    // it has finished. Wait for the element's own animation set to drain.
    await page.waitForFunction(() => {
      const o = document.getElementById("self-enroll-overlay");
      return o && o.getAnimations({ subtree: true }).every(a => a.playState !== "running");
    }, null, { timeout: 10000 });

    await expect(page.locator(".self-enroll-code-label"), "the address is on screen beside the code")
      .toContainText(host);
    await expect(page.locator("#self-enroll-code")).toHaveText(rv.join_code_display);
    // The note has to NAME the code, or the one part of the dialog an organiser
    // is about to print is the part the explanation does not mention.
    await expect(page.locator("#self-enroll-inactive-note")).toBeVisible();
    await expect(page.locator("#self-enroll-inactive-note")).toContainText(/short code/i);

    await appearanceSettled(page);   // the app's own look read is done repainting <html>
    const read = async (theme) => page.evaluate(([t, fn]) => {
      document.documentElement.setAttribute("data-theme", t);
      const contrast = eval(fn);
      const seen = (el) => {                       // the colour a human actually sees
        const cs = getComputedStyle(el);
        let n = el, bg = "rgb(255, 255, 255)";
        while (n) { const b = getComputedStyle(n).backgroundColor; if (b && b !== "rgba(0, 0, 0, 0)" && b !== "transparent") { bg = b; break; } n = n.parentElement; }
        // Every opacity in the ancestry composites the text, which is the whole
        // failure mode being locked out here.
        let a = 1; for (let m = el; m; m = m.parentElement) a *= parseFloat(getComputedStyle(m).opacity || "1");
        const mix = (f, b) => { const p = s => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number); const F = p(f), B = p(b); return `rgb(${F.map((v, i) => Math.round(a * v + (1 - a) * B[i])).join(", ")})`; };
        return { ratio: +contrast(mix(cs.color, bg), bg).toFixed(2), alpha: +a.toFixed(2) };
      };
      const box = document.getElementById("self-enroll-code-box");
      return {
        codeBoxBorder: getComputedStyle(box).borderTopStyle,
        linkBorder: getComputedStyle(document.getElementById("self-enroll-input")).borderTopStyle,
        label: seen(document.querySelector(".self-enroll-code-label")),
        value: seen(document.querySelector(".self-enroll-code-value")),
        hint: seen(document.querySelector(".self-enroll-code-hint")),
        qrHint: seen(document.querySelector(".self-enroll-qr-hint")),
      };
    }, [theme, CONTRAST_FN]);

    for (const theme of ["dark", "light"]) {
      const m = await read(theme);
      expect(m.codeBoxBorder, `${theme}: the code block reads as inactive`).toBe("dashed");
      expect(m.linkBorder, `${theme}: and so does the link it sits under`).toBe("dashed");
      // THE HALF THAT MATTERS. Adding `.self-enroll-code` to the old opacity list
      // was the obvious fix and measures 2.25:1 dark / 2.13:1 light on --muted —
      // and axe cannot see it, because this state is reachable only behind a
      // toggle and axe samples the resting one.
      for (const k of ["label", "value", "hint", "qrHint"]) {
        expect(m[k].alpha, `${theme}: ${k} is not composited by an ancestor opacity`).toBe(1);
        expect(m[k].ratio, `${theme}: ${k} clears AA while inactive`).toBeGreaterThanOrEqual(4.5);
      }
    }

    // POSITIVE CONTROL — without it, "dashed" is equally satisfied by a build
    // that renders the code block dashed all the time, which says nothing.
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const live = await page.evaluate(() => {
      document.querySelector(".self-enroll-card").classList.remove("se-inactive");
      const box = document.getElementById("self-enroll-code-box");
      return {
        border: getComputedStyle(box).borderTopStyle,
        value: getComputedStyle(document.querySelector(".self-enroll-code-value")).color,
        muted: getComputedStyle(document.documentElement).getPropertyValue("--muted").trim(),
      };
    });
    expect(live.border, "an ENABLED link renders the code block as live").toBe("solid");
    expect(live.value, "…with the code in full-strength text, not the muted token").not.toBe(live.muted);
    await api.dispose();
  });

  test("a participant who ALREADY has an account joins by typing the code", async ({ page }) => {
    // The reported gap: the code entry shipped on the sign-up form only, so this
    // person signed in, landed on their events list, and had nowhere to type it.
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf, "booth");
    const rv = await reveal(api, ev.id);
    const p = await makeParticipant(api, csrf);

    await page.goto("/");
    await loginViaApi(page, p.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.waitForSelector("#competitions-page.active", { timeout: 20000 });

    // Not a member yet — this is what makes the join below evidence of anything.
    const before = await (await page.request.get("/api/my-competitions")).json();
    expect(Array.isArray(before), "my-competitions answers a list").toBe(true);
    expect(before.some(c => c.id === ev.id),
      "the participant is NOT in this event before typing the code").toBe(false);

    await page.fill("#comp-join-code", rv.join_code_display);
    await page.click('[data-action="join-with-code"]');

    await expect(page.locator("#toast-stack .toast-success").first(), "they are told they are in")
      .toContainText(/joined/i, { timeout: 15000 });

    // The durable half — a toast is not membership.
    await expect.poll(async () => {
      const me = await (await page.request.get("/api/me")).json();
      return (me.competitions || []).some(c => c.id === ev.id);
    }, { timeout: 15000, message: "the membership is real" }).toBe(true);
    await api.dispose();
  });

  test("the code can be entered on the LOGIN screen — the page the address on the sign lands on", async ({ page }) => {
    // The reported gap, and the one that made the code undiscoverable: an
    // anonymous visitor who types the address off a booth sign arrives HERE, and
    // this card said nothing about a code. The entry existed only on the sign-up
    // form, behind a button labelled "Sign Up" — a guess for someone new and the
    // wrong door for the attendee who already has an account.
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf, "booth");
    const rv = await reveal(api, ev.id);

    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    // v8.3.1 — reachable WITHOUT opening the sign-up form, which is the whole
    // point; the entry moved from an inline box into its own dialog so the login
    // card stopped growing. The guarantee below is unchanged.
    await expect(page.locator("#login-event-code-link")).toBeVisible();
    await page.click('[data-action="open-event-code"]');
    await page.fill("#ec-code", rv.join_code_display);
    await page.click('[data-action="event-code-apply"]');

    // Adopted, and the banner names the event so the visitor can see they are in
    // the right place before typing a password.
    await expect(page.locator("#join-banner"), "the login card names the event").toBeVisible({ timeout: 15000 });
    await expect(page.locator("#join-banner-info")).toContainText(ev.name);
    expect(await page.evaluate(() => window.S && window.S._pendingJoinToken), "the token is adopted").toBe(rv.token);
    // Once a join is resolved the dialog stops offering the entry and shows the
    // event instead — a live code box under a banner naming the event invites
    // typing over a working state.
    await expect(page.locator("#ec-code"), "…and the entry stands down").toHaveCount(0);
    await api.dispose();
  });

  test("a code entered on the LOGIN screen carries an EXISTING account into the event", async ({ page }) => {
    // The end-to-end that the two halves only imply: adopting is worth nothing
    // unless signing in afterwards actually enrols them.
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf, "booth");
    const rv = await reveal(api, ev.id);
    const p = await makeParticipant(api, csrf);

    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    await page.click('[data-action="open-event-code"]');
    await page.fill("#ec-code", rv.join_code_display);
    await page.click('[data-action="event-code-apply"]');
    await expect(page.locator('[data-action="event-code-signin"]')).toBeVisible({ timeout: 15000 });
    await page.click('[data-action="event-code-signin"]');
    await expect(page.locator("#join-banner")).toBeVisible({ timeout: 15000 });

    await page.fill("#login-email", p.email);
    await fillBreakGlass(page, PARTICIPANT_PASS);
    await submitLogin(page);

    await expect.poll(async () => {
      const me = await (await page.request.get("/api/me")).json();
      return (me.competitions || []).some(c => c.id === ev.id);
    }, { timeout: 25000, message: "signing in after the code enrols them into that event" }).toBe(true);
    await api.dispose();
  });

  test("both code boxes are ONE shape, so the walk-up recognises it wherever they meet it", async ({ page }) => {
    // v8.2.3 consolidated three page-scoped copies onto `.join-code-box`. The ids
    // stayed per-surface, which is what let every pre-existing lock keep locating
    // its own input — this pins the shared styling so a future page-scoped copy
    // fails here rather than drifting silently (the v7.21.26 parity-lock shape).
    const { api, csrf } = await sa();
    const p = await makeParticipant(api, csrf);

    const shapeOf = (sel) => page.evaluate((s) => {
      const box = document.querySelector(s);
      if (!box) return null;
      const cs = getComputedStyle(box);
      const row = box.querySelector(".join-code-row");
      const input = box.querySelector("input");
      return {
        padding: cs.padding, border: cs.borderTopWidth + " " + cs.borderTopStyle,
        radius: cs.borderTopLeftRadius, bg: cs.backgroundColor,
        rowDisplay: row ? getComputedStyle(row).display : null,
        inputTransform: input ? getComputedStyle(input).textTransform : null,
      };
    }, sel);

    await page.goto("/");
    await page.waitForSelector("#login-page.active", { timeout: 20000 });
    // v8.3.1 — the login entry lives in a dialog; open it to measure the box.
    await page.click('[data-action="open-event-code"]');
    await page.locator("#ec-code").waitFor({ state: "visible", timeout: 10000 });
    const login = await shapeOf("#event-code-overlay .join-code-box");
    await page.click('[data-action="overlay-close"]');
    // Email first: the sign-up form has no code box of its own any more (an event
    // code is entered on the card's dialog), so two surfaces remain.

    await page.goto("/");
    await loginViaApi(page, p.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.waitForSelector("#competitions-page.active", { timeout: 20000 });
    const picker = await shapeOf("#comp-join-code-box");

    for (const [name, got] of [["login", login], ["picker", picker]]) {
      expect(got, `${name}: the box exists`).toBeTruthy();
      // Not `null`/`""` — a box with no rule at all would report those and pass a
      // naive equality against two other boxes that also had none.
      expect(got.rowDisplay, `${name}: the row is laid out`).toBe("flex");
      expect(got.inputTransform, `${name}: the code reads as a code`).toBe("uppercase");
    }
    expect(picker, "the picker matches them too").toMatchObject({ padding: login.padding, border: login.border, radius: login.radius, bg: login.bg });
    await api.dispose();
  });

  test("the picker code box survives the 15-second re-render, because it is a SIBLING of the grid", async ({ page }) => {
    // v7.20.10: renderCompetitionPicker() replaces #comp-grid's contents on a
    // poll. A code box INSIDE it would be destroyed mid-type — and at a stand
    // that is not a caret nuisance, it is a code the person has to read off the
    // sign and enter again. `pressSequentially`, because `.fill()` sets the value
    // atomically and cannot reproduce the defect at all.
    const { api, csrf } = await sa();
    const p = await makeParticipant(api, csrf);

    await page.goto("/");
    await loginViaApi(page, p.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.waitForSelector("#competitions-page.active", { timeout: 20000 });

    expect(await page.evaluate(() => !!document.getElementById("comp-grid").querySelector("#comp-join-code")),
      "the input is NOT inside the container the poll rebuilds").toBe(false);

    await page.locator("#comp-join-code").pressSequentially("ABC1", { delay: 40 });
    await page.evaluate(() => { window.renderCompetitionPicker(); });
    await page.locator("#comp-join-code").pressSequentially("23", { delay: 40 });
    await page.evaluate(() => { window.renderCompetitionPicker(); });

    expect(await page.inputValue("#comp-join-code"), "every keystroke survived the re-render").toBe("ABC123");
    await api.dispose();
  });

  test("on a phone the dialog does not overflow, and the code's button is a full-width 44px target", async ({ page }) => {
    // The reported symptom: on a phone the code label, the code and the button
    // wrapped against each other at three different left edges, because the block
    // had no rule of its own anywhere in the stylesheet and laid out as a run of
    // inline text with a button dropped into the middle of it.
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf, "booth");
    await reveal(api, ev.id);

    await adminLogin(page);
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 780 });
      await page.evaluate(() => document.getElementById("self-enroll-overlay")?.remove());
      await page.evaluate((id) => window.openSelfEnrollOverlay(id, "Phone Booth"), ev.id);
      await page.locator("#self-enroll-code-box").waitFor({ state: "visible", timeout: 10000 });

      const g = await page.evaluate(() => {
        const card = document.querySelector(".self-enroll-card");
        const box = document.getElementById("self-enroll-code-box");
        const btn = box.querySelector(".btn");
        const val = document.getElementById("self-enroll-code");
        const b = (e) => e.getBoundingClientRect();
        return {
          cardScrollW: card.scrollWidth, cardClientW: card.clientWidth,
          docScrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
          btnW: Math.round(b(btn).width), valW: Math.round(b(val).width),
          btnH: Math.round(b(btn).height),
          boxL: Math.round(b(box).left), boxR: Math.round(b(box).right),
          cardL: Math.round(b(card).left), cardR: Math.round(b(card).right),
        };
      });
      expect(g.cardScrollW, `${width}px: the dialog does not scroll sideways`).toBeLessThanOrEqual(g.cardClientW + 1);
      expect(g.docScrollW, `${width}px: and neither does the page`).toBeLessThanOrEqual(g.innerW + 1);
      expect(g.boxL, `${width}px: the code block starts inside the card`).toBeGreaterThanOrEqual(g.cardL);
      expect(g.boxR, `${width}px: …and ends inside it`).toBeLessThanOrEqual(g.cardR);
      // Stacked, not sharing a line with 1.15rem monospace at .14em tracking.
      expect(g.btnW, `${width}px: the button is the full width of the block`).toBe(g.valW);
      expect(g.btnH, `${width}px: at the touch standard`).toBeGreaterThanOrEqual(44);
    }
    await api.dispose();
  });
});

// v8.13.3 — Regenerate link replaces the short code too, and the dialog the admin
// is looking at must show the NEW one (it is about to be reprinted). The link
// field moving is the control: it proves the regenerate really answered, so a
// code that did not move is the defect rather than a click that never landed.
test.describe("v8.13.3 — Regenerate link rotates the short code in the dialog", () => {
  test("the confirm names the code, and the dialog shows the new code after a regenerate", async ({ page }) => {
    const { api, csrf } = await sa();
    const ev = await makeEvent(api, csrf, "booth", { self_enroll_enabled: true });
    const before = await reveal(api, ev.id);
    expect(before.join_code_display, "precondition: the event has a code").toBeTruthy();
    await api.dispose();

    await page.emulateMedia({ reducedMotion: "reduce" });
    await adminLogin(page);
    await page.evaluate((id) => window.openSelfEnrollOverlay(id, "Rotate Booth"), ev.id);
    await expect(page.locator("#self-enroll-code")).toHaveText(before.join_code_display);
    const oldLink = await page.locator("#self-enroll-input").inputValue();

    await page.locator("#self-enroll-overlay [data-action='self-enroll-regenerate']").click();
    await expect(page.locator("#modal-overlay.open #modal-title")).toHaveText("Regenerate link");
    await expect(page.locator("#modal-overlay.open #modal-body"), "the confirm says the code goes too").toContainText(/short code/i);
    await page.locator("#modal-overlay.open #modal-confirm-btn").click();
    await expect(page.locator("#toast-stack .toast", { hasText: "Link regenerated" })).toBeVisible();

    const after = await (await page.request.get(`/api/admin/competitions/${ev.id}/self-enroll`)).json();
    expect(after.join_code_display, "the server rotated the code").not.toBe(before.join_code_display);
    await expect(page.locator("#self-enroll-input"), "CONTROL: the link moved").not.toHaveValue(oldLink);
    await expect(page.locator("#self-enroll-code"), "the dialog shows the NEW code").toHaveText(after.join_code_display);
    await expect(page.locator("[data-action='self-enroll-copy-code']"), "its copy control names the new code")
      .toHaveAttribute("aria-label", `Copy code — the short join code ${after.join_code_display}`);

    // The event's History says the CODE went too — `rotated` names the fields. An
    // older row with no list rotated the link alone, so the renderer must not claim
    // a code for it: that is the CONTROL, driven through the same renderer the
    // dialog uses, on the pre-v8.13.3 shape of the event.
    await page.locator("#self-enroll-overlay [data-action='self-enroll-close']").click();
    await expect(page.locator("#self-enroll-overlay")).toHaveCount(0);
    await page.evaluate((id) => window.showCompetitionHistory(id), ev.id);
    const ov = page.locator("#hist-overlay");
    await expect(ov).toBeVisible({ timeout: 15000 });
    await expect(ov.locator("#hist-body tr", { hasText: "Join link and short code regenerated" }),
      "the regenerate names the code it replaced").toHaveCount(1);
    expect(await page.evaluate(() => typeof window.formatEventChange), "PRECONDITION: the renderer is on window").toBe("function");
    const legacy = await page.evaluate(() => window.formatEventChange({ event_type: "self_enroll_regenerated", details: {} }));
    expect(legacy, "CONTROL: an older row (no `rotated`) says the link alone").toBe("Join link regenerated");
  });
});
