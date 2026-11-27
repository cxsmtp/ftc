"use strict";

// v8.13.9 — A HOVER OR A PULSE NEVER FADES TEXT.
//
// Three rules dimmed a text-bearing surface with `opacity`, which composites the
// label into whatever sits behind it (CLAUDE.md, *Recurring rules*: "Never dim a
// text-bearing surface with `opacity`"). axe cannot see any of them: it samples
// the RESTING state, and all three live behind a hover or a running animation.
//
//   1. `.btn:hover{opacity:0.9}` — every filled button faded on hover (white on
//      the light `--green` fell from 5.01:1 to 4.23:1). The cue is a lift: the
//      look's buttons rise 1px (`translateY(-1px)`) and a filled button changes
//      its FILL (the primary to --accent-hover, a secondary to --surface-3). The
//      text-link style button `.btn.danger-link` raises no shadow.
//   2. `.rich-body a:hover,#task-detail-card a:hover{opacity:.8}` — a challenge
//      description's link faded on hover. It now moves from `--accent2` to
//      `--text`. The card's author byline link ("By … · LinkedIn") is held to the
//      same rule: it carried an inline `style="color:var(--accent2)"`, which
//      out-ranks `#task-detail-card a:hover`, so once the fade went it had NO
//      hover cue at all. The inline colour is gone; `#task-detail-card a` gives
//      it the same resting `--accent2`.
//   3. `@keyframes countdownPulse{to{opacity:0.55}}` — the header timer's
//      last-ten-seconds pulse faded the digits. It now pulses COLOUR, `--red` to
//      `--text` (the looks made every status ink AA, so the old `--badge-red-fg`
//      end would not move). A light-theme defect is fixed with it:
//      `html[data-theme="light"] .countdown` (0,2,1) out-ranked
//      `.countdown.urgent-warn` (0,2,0), so the light timer kept its transparent
//      gradient fill and never turned red at all.
//   4. A challenge's DOWNLOAD BUTTONS are `<a class="btn secondary sm">` (an
//      uploaded attachment, and the legacy `attachment_url` "Download
//      Attachment"), on the participant card and in the admin "View as
//      Participant" preview. The global `a{…text-decoration:underline}` reached
//      every `a.btn`, and on the card `#task-detail-card a` / `…a:hover` (1,0,1 /
//      1,1,1) out-ranked `.btn.secondary` (0,2,0) and the light
//      `html[data-theme="light"] .btn.secondary:hover` (0,4,1), so a download
//      button rested purple and underlined like a link and hovered to `--text`.
//      Now `.btn` sets `text-decoration:none` and the card's link rules are
//      `#task-detail-card a:not(.btn)`. A download button rests exactly like the
//      card's own `.btn.sm.secondary` (Show Hint, the CONTROL twin: same colour,
//      fill, border, no underline) and hovers like one; the card's real links
//      (description, byline) are still underlined `--accent2` (CONTROL: the
//      `:not(.btn)` stripped no link).
//
// HOW EACH SITE IS MEASURED. On a real screen with the real stylesheet, in BOTH
// themes (the OS preference is emulated and `data-theme` asserted), with every
// finite transition drained first. At rest, then hovered:
//   * PRECONDITION — the browser reports `(hover:hover)` (the rule is gated on
//     it), the element matches `:hover` only once hovered, the theme is the one
//     named;
//   * NO FADE — computed opacity is '1' and `textContrast` (the shared helper in
//     tests/ui-admin-helpers.js) folds no opacity in from any ancestor;
//   * COLOUR — a hover that keeps its label colour must not LOSE contrast
//     (hovered >= resting - 0.01); a hover that changes it by design (light
//     `.btn.secondary` to `--accent-ink`, `.btn.danger-link` to the red, the rich
//     link to `--text`) must land exactly on that token, which differs from the
//     resting colour (CONTROL);
//   * AA — the hovered label measures >= 4.5:1;
//   * HOVER CUE — the hover really applied: lifted 1px (`matrix(1, 0, 0, 1, 0, -1)`,
//     `none` at rest) and, for a filled button, its fill or its shadow changed; the text link
//     raises no shadow.
// The countdown is an INFINITE animation, so it is never drained: it is paused
// and set to the start and the end of one iteration, and measured at each.
//
// WHERE EACH VARIANT IS FOUND. Real screens wherever one renders the variant:
//   .btn            the login page's Sign In
//   .btn.secondary  the login page's Sign Up; the hint confirm's "Keep my points";
//                   the Verify confirm's Cancel
//   .btn.sm         the admin Participants toolbar's Invite
//   .btn.sm.secondary  a challenge's "Show Hint"
//   .btn.sm.warning the Participants row's "Verify" (unverified user, superadmin)
//   .btn.danger     the hint confirm's "Reveal hint (−N pts)"
//   .btn.warning    the Verify confirm's "Verify"
//   .btn.danger-link  the pending page's "Leave this event" (self-enrolled)
//   .btn.sm.success the admin scope banner's "Start Now" for a focused session
//                   that has not started (competitions-admin.js renders it from
//                   the session's own status) — hovered, NEVER clicked
// Every variant is measured on a screen that renders it; no stand-in is built.
// The two links: a challenge description's link, and the same card's author
// byline "LinkedIn" link.
//
// FIXTURES (beforeAll, through the built-in superadmin's API session): P1 in a
// live 10-hour tournament holding one challenge (a description link, a hint, and
// an author with a LinkedIn URL; P1 never answers, so the all-solved auto-end
// cannot fire); P2 self-enrolled in an UPCOMING tournament (its only event); an
// upcoming tournament with one session three hours out (no members, so nothing
// about it is a competitor's); U, a registered but unverified, unapproved
// account; SA2, a user-backed superadmin whose browser session is the one the
// admin tests open (the built-in superadmin's API session survives it — one
// session per principal). The download buttons get their own second beforeAll:
// P3 in a live tournament of its own holding one challenge with an uploaded ZIP
// attachment, a legacy https `attachment_url`, a description link, a hint and an
// author LinkedIn link (P3 never answers). No setting is written.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { BASE, PARTICIPANT_PASS, apiLogin, freshCtx, zipOf } = require("./helpers");
const { loginViaApi, clickTab, viewComp, findSeededTaskRow, textContrast, rowMarking, expectSpaBooted, narrowPeopleTable } = require("./ui-admin-helpers");
const { H, uniq, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

/** Every ratio measured, printed once at the end (the run's evidence). */
const MEASURED = [];

const TRANSPARENT = "rgba(0, 0, 0, 0)";
const LIFTED = "matrix(1, 0, 0, 1, 0, -1)";

const themeOf = page => page.evaluate(() => document.documentElement.dataset.theme);

/**
 * Wait out every FINITE animation and transition on the page (hover lifts,
 * theme flips, dialog entrances). Looped, because a finished transition can
 * start another; infinite ones (the countdown pulse) are left alone.
 */
async function settle(page) {
  await page.evaluate(async () => {
    for (let i = 0; i < 6; i++) {
      const finite = (document.getAnimations ? document.getAnimations() : []).filter(a =>
        a.playState === "running" && a.effect && Number.isFinite(a.effect.getComputedTiming().endTime));
      if (!finite.length) break;
      await Promise.all(finite.map(a => a.finished.catch(() => {})));
    }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/** A token resolved in the element's own cascade (a probe span in its parent). */
function tokenAt(locator, prop, value) {
  return locator.evaluate((el, [p, v]) => {
    const s = document.createElement("span");
    s.style[p] = v;
    (el.parentElement || el).appendChild(s);
    const c = getComputedStyle(s)[p];
    s.remove();
    return c;
  }, [prop, value]);
}

/** What the hover rules touch, read in one pass. */
function stateOf(locator) {
  return locator.evaluate(el => {
    const cs = getComputedStyle(el);
    return {
      hover: el.matches(":hover"),
      opacity: cs.opacity,
      color: cs.color,
      transform: cs.transform,
      boxShadow: cs.boxShadow,
      background: cs.backgroundColor + " " + cs.backgroundImage,
      classes: el.className,
    };
  });
}

/**
 * Follow the OS into `theme` and assert it did. Nothing stored is the house
 * mode, which follows the OS too (HOUSE_MODE "system"); the helper stores "system"
 * first so the page follows the OS live whatever that default becomes.
 */
async function toTheme(page, theme) {
  const was = await page.evaluate(() => { try { const v = localStorage.getItem("hck-theme"); localStorage.setItem("hck-theme", "system"); return v; } catch (_) { return "unreadable"; } });
  expect([null, "system"], "PRECONDITION: no stored theme pin (nothing, or \"system\")").toContain(was);
  await page.emulateMedia({ colorScheme: theme });
  await expect.poll(() => themeOf(page), { message: `the page followed the OS into the ${theme} theme`, timeout: 5000 }).toBe(theme);
  await settle(page);
}

/** Move the pointer off every control and let the un-hover transition finish. */
async function rest(page) {
  await page.mouse.move(0, 0);
  await settle(page);
}

/**
 * Hover `loc` and hold it to the contract in the header. `hoverColor` names the
 * token a hover is DESIGNED to change the label to (null: the label keeps its
 * colour); `link` marks the unfilled text-link button, which raises no shadow.
 */
async function hoverCheck(page, loc, what, theme, { hoverColor = null, link = false } = {}) {
  await expect(loc, `${what}: on screen`).toBeVisible();
  expect(await themeOf(page), `PRECONDITION ${what}: the page is in the ${theme} theme`).toBe(theme);
  expect(await page.evaluate(() => matchMedia("(hover:hover)").matches),
    "PRECONDITION: the browser reports (hover:hover), so the gated .btn:hover rule applies").toBe(true);

  // ── at rest ──
  await rest(page);
  const r = await stateOf(loc);
  expect(r.hover, `CONTROL ${what}: not hovered at rest`).toBe(false);
  const rc = await textContrast(loc);
  expect(rc.ratio, `${what} (${theme}) at rest: textContrast could not parse a colour: ${JSON.stringify(rc)}`).not.toBeNull();
  expect(r.transform, `CONTROL ${what} (${theme}): unmoved at rest, so the lift is the hover's`).toBe("none");

  // ── hovered (a table re-render can replace the node under the pointer: retry) ──
  let h = null, hc = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await loc.hover();
    await expect.poll(() => loc.evaluate(el => el.matches(":hover")),
      { message: `PRECONDITION ${what}: the element matches :hover`, timeout: 5000 }).toBe(true);
    await settle(page);
    h = await stateOf(loc);
    hc = await textContrast(loc);
    if (h.hover && await loc.evaluate(el => el.matches(":hover"))) break;
  }
  expect(h.hover, `PRECONDITION ${what} (${theme}): still hovered when measured`).toBe(true);
  expect(hc.ratio, `${what} (${theme}) hovered: textContrast could not parse a colour: ${JSON.stringify(hc)}`).not.toBeNull();

  expect(h.opacity, `NO FADE ${what} (${theme}): the hovered control is at computed opacity 1`).toBe("1");
  expect(hc.opacity, `NO FADE ${what} (${theme}): nothing above the hovered label fades it`).toBe(1);
  if (hoverColor) {
    const want = await tokenAt(loc, "color", `var(${hoverColor})`);
    expect(want, `CONTROL ${what} (${theme}): ${hoverColor} differs from the resting label colour`).not.toBe(r.color);
    expect(h.color, `${what} (${theme}): the hovered label is ${hoverColor}`).toBe(want);
  } else {
    expect(h.color, `${what} (${theme}): the hover keeps the label colour`).toBe(r.color);
    expect(hc.ratio, `NO FADE ${what} (${theme}): hovered ${hc.ratio}:1 is no lower than resting ${rc.ratio}:1`)
      .toBeGreaterThanOrEqual(rc.ratio - 0.01);
  }
  expect(hc.ratio, `AA ${what} (${theme}): the hovered label (${h.color}) measures >= 4.5:1 on ${JSON.stringify(hc.bg)}`)
    .toBeGreaterThanOrEqual(4.5);
  expect(h.transform, `HOVER CUE ${what} (${theme}): the hovered control is lifted`).toBe(LIFTED);
  if (link) {
    expect(h.boxShadow, `TEXT LINK ${what} (${theme}): an unfilled link button raises no shadow`).toBe("none");
  } else {
    expect(h.background !== r.background || h.boxShadow !== r.boxShadow,
      `HOVER CUE ${what} (${theme}): the hovered control changes its fill or raises its shadow`).toBe(true);
  }
  MEASURED.push({ what, theme, rest: rc.ratio, hover: hc.ratio, color: h.color });
  await rest(page);
}

/** The button carries exactly the classes its variant names (`btn` plus `want`). */
async function expectClasses(loc, want, what) {
  const cls = await loc.evaluate(el => [...el.classList]);
  for (const c of ["btn", ...want]) expect(cls, `PRECONDITION ${what}: carries .${c}`).toContain(c);
}

/** What a control LOOKS like, read in one pass: the properties a link style and a button style disagree on. */
function lookOf(locator) {
  return locator.evaluate(el => {
    const cs = getComputedStyle(el);
    return {
      hover: el.matches(":hover"),
      opacity: cs.opacity,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      textDecorationLine: cs.textDecorationLine,
      borderTopStyle: cs.borderTopStyle,
      borderTopWidth: cs.borderTopWidth,
      borderTopColor: cs.borderTopColor,
    };
  });
}

/**
 * v8.13.9 — an `<a class="btn secondary sm">` download button held to "a button,
 * not a link", in the page's current theme: at rest it is not underlined, its
 * label is `--text` (never the link's `--accent2`), its fill is the
 * `.btn.secondary` fill (`--surface` in light, where
 * the looks fill it with `--surface` in both modes),
 * and it looks exactly like `twin`, a real `.btn.secondary` on the same surface;
 * hovered it is held to `hoverCheck` (light: label and border `--accent`; dark:
 * label kept) and is still not underlined. Returns nothing; every check is named.
 */
async function downloadButtonCheck(page, loc, twin, what, theme) {
  await expect(loc, `${what}: on screen`).toBeVisible();
  expect(await themeOf(page), `PRECONDITION ${what}: the page is in the ${theme} theme`).toBe(theme);
  expect(await loc.evaluate(el => el.tagName), `PRECONDITION ${what}: it is an <a>, which the global a{} rule reaches`).toBe("A");
  await expectClasses(loc, ["secondary", "sm"], what);

  // ── at rest ──
  await rest(page);
  const r = await lookOf(loc);
  const t = await lookOf(twin);
  const text = await tokenAt(loc, "color", "var(--text)");
  const accent2 = await tokenAt(loc, "color", "var(--accent2)");
  // The looks fill a secondary button with the card surface in both modes.
  const fill = await tokenAt(loc, "backgroundColor", "var(--surface)");
  expect(r.hover, `CONTROL ${what} (${theme}): not hovered at rest`).toBe(false);
  expect(accent2, `CONTROL ${what} (${theme}): --accent2 (the link colour) differs from --text, so a link-coloured label is caught`).not.toBe(text);
  expect(r.opacity, `${what} (${theme}): at full strength at rest`).toBe("1");
  expect(r.textDecorationLine, `REST UNDERLINE ${what} (${theme}): a download button is not underlined like a link`).toBe("none");
  expect(r.color, `REST COLOUR ${what} (${theme}): the resting label is --text, not the link's --accent2`).toBe(text);
  expect(r.backgroundColor, `REST FILL ${what} (${theme}): the .btn.secondary fill (--surface)`).toBe(fill);
  for (const k of ["color", "backgroundColor", "textDecorationLine", "borderTopStyle", "borderTopWidth", "borderTopColor"]) {
    expect(r[k], `LIKE ITS TWIN ${what} (${theme}): resting ${k} equals the same surface's own .btn.secondary`).toBe(t[k]);
  }
  const rc = await textContrast(loc);
  expect(rc.ratio, `${what} (${theme}) at rest: textContrast parsed: ${JSON.stringify(rc)}`).not.toBeNull();
  expect(rc.ratio, `AA ${what} (${theme}): the resting label (${r.color}) measures >= 4.5:1 on ${JSON.stringify(rc.bg)}`)
    .toBeGreaterThanOrEqual(4.5);

  // ── hovered: the shared contract (no fade, the designed colour, AA, the lift) ──
  await hoverCheck(page, loc, what, theme, { hoverColor: theme === "light" ? "--accent-ink" : null });

  // ── hovered: what a link hover would have changed (underline, border) ──
  await loc.hover();
  await expect.poll(() => loc.evaluate(el => el.matches(":hover")),
    { message: `PRECONDITION ${what} (${theme}): the button matches :hover`, timeout: 5000 }).toBe(true);
  await settle(page);
  const h = await lookOf(loc);
  expect(h.hover, `PRECONDITION ${what} (${theme}): still hovered when measured`).toBe(true);
  expect(h.textDecorationLine, `HOVER UNDERLINE ${what} (${theme}): still not underlined when hovered`).toBe("none");
  // The looks' .btn.secondary hover draws the accent edge by day and at night.
  const accent = await tokenAt(loc, "color", "var(--accent)");
  expect(r.borderTopColor, `CONTROL ${what} (${theme}): the resting border is not --accent, so the hover's border is visible`).not.toBe(accent);
  expect(h.borderTopColor, `HOVER BORDER ${what} (${theme}): the hovered border is --accent, as on every .btn.secondary`).toBe(accent);
  await rest(page);
}

/**
 * Click the participant's Challenges nav once it renders. A wait that ends in
 * nothing names the BUTTON, never the reason (the wrong view, not a slow one:
 * the button shows only inside a live or ended event), so on a timeout the
 * page's state is read and put in the error: which page shows, the entered
 * event and its status, the signed-in user, any open gate or modal.
 */
async function clickChallengesNav(page) {
  const nav = page.locator("#nav-challenges:not([aria-disabled=true])");
  await nav.waitFor({ state: "visible", timeout: 20000 }).catch(async e => {
    const st = await page.evaluate(() => {
      const S = window.S || {};
      const navEl = document.getElementById("nav-challenges");
      const modal = document.getElementById("modal-overlay");
      return {
        url: location.href,
        pages: [...document.querySelectorAll(".page.active, .main-page.active")].map(n => n.id),
        competitionId: S.currentCompetitionId || null, status: S.currentCompStatus || null,
        myCompetitions: (S.myCompetitions || []).map(c => ({ id: c.id, status: c.status, start: c.start_time })),
        user: S.currentUser ? S.currentUser.email : null,
        navInline: navEl ? navEl.style.display : "absent",
        modal: modal ? modal.className : "absent",
        profileGate: !!document.getElementById("profile-gate-overlay"),
        text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 400),
      };
    }).catch(x => `page state unreadable: ${x.message}`);
    throw new Error(`#nav-challenges:not([aria-disabled=true]) never became visible; page state: ${JSON.stringify(st)}\n${e.message}`);
  });
  await nav.click();
}

/** A link held to "still a link" at rest: underlined and --accent2, at full strength. */
async function linkAtRest(page, loc, what, theme) {
  await expect(loc, `${what}: on screen`).toBeVisible();
  await rest(page);
  const r = await lookOf(loc);
  expect(r.hover, `CONTROL ${what} (${theme}): not hovered at rest`).toBe(false);
  expect(r.opacity, `CONTROL ${what} (${theme}): at full strength`).toBe("1");
  expect(r.textDecorationLine, `CONTROL ${what} (${theme}): a real link is still underlined`).toBe("underline");
  expect(r.color, `CONTROL ${what} (${theme}): a real link is still --accent2`).toBe(await tokenAt(loc, "color", "var(--accent2)"));
}

let sa, saCsrf;
let p1, p2, u, sa2;
let comp, pend, task, sessComp, slot;
let p3, dlComp, dlTask, dlAttach;
const LINK_HREF = "https://example.com/x";
const AUTHOR_NAME = "Ada Hover";
const AUTHOR_LINKEDIN = "https://www.linkedin.com/in/example";
const LEGACY_URL = "https://example.com/files/legacy-pack.zip";
const DL_NAME = "Starter pack";

test.describe("v8.13.9 — a hover or a pulse never fades text", () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));

    // ── people ──
    p1 = await makeParticipant(sa, saCsrf, "hpp1");
    p2 = await makeParticipant(sa, saCsrf, "hpp2");
    sa2 = await makeParticipant(sa, saCsrf, "hpsa");
    {
      const r = await sa.post(`/api/admin/participants/${sa2.id}/role`, { headers: H(saCsrf), data: { role: "superadmin" } });
      expect(r.ok(), `promote SA2 to superadmin: ${r.status()} ${await r.text()}`).toBeTruthy();
    }
    // U: registered and nothing else — unverified and unapproved.
    {
      const tag = uniq("hpu");
      const email = `hp-${tag}@acme.com`;
      const { api: anon, csrf } = await freshCtx();
      try {
        const reg = await registerPost(anon, "/api/register", {
          headers: H(csrf),
          data: {
            email, password: PARTICIPANT_PASS,
            nickname: `hp_${tag}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40),
            firstName: "Hover", lastName: "Unverified", company: "Acme", title: "Engineer",
            country: "GB", timezone: "Europe/London",
          },
        });
        expect(reg.ok(), `register U: ${reg.status()} ${await reg.text()}`).toBeTruthy();
      } finally { await anon.dispose(); }
      const row = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.email === email);
      expect(row, "U is in the admin list").toBeTruthy();
      expect(!!row.verified, "PRECONDITION: U is unverified, so its row's primary is Verify").toBe(false);
      u = { id: row.id, email };
    }

    // ── the live tournament and its challenge ──
    comp = await makeCompetition(sa, saCsrf, "hplive");
    task = await makeTask(sa, saCsrf, "hplink", {
      description: `<p>Read the <a href="${LINK_HREF}">docs</a> before you answer.</p>`,
      hint: "<p>Look closer at the docs.</p>",
      author_name: AUTHOR_NAME, author_linkedin: AUTHOR_LINKEDIN,
    });
    {
      // The byline renders from these two fields; the create route drops an
      // author_linkedin that is not http(s) (validateUrl), so read them back.
      const list = await (await sa.get("/api/admin/tasks")).json();
      const t = (Array.isArray(list) ? list : list.tasks || []).find(x => x.id === task.id);
      expect(t && t.author_name, "PRECONDITION: the challenge stored its author").toBe(AUTHOR_NAME);
      expect(t && t.author_linkedin, "PRECONDITION: the challenge stored its author's LinkedIn URL").toBe(AUTHOR_LINKEDIN);
    }
    await assignTask(sa, saCsrf, task.id, [comp.id]);
    await enrol(sa, saCsrf, comp.id, [p1.id]);

    // ── the upcoming tournament whose session the scope banner offers to Start Now ──
    {
      const at = new Date(Date.now() + 3 * 3600e3).toISOString();
      sessComp = await makeCompetition(sa, saCsrf, "hpsess", { start_time: at });
      const r = await sa.post(`/api/admin/competitions/${sessComp.id}/timeslots`, {
        headers: H(saCsrf), data: { name: `Later ${uniq("s")}`, start_time: at, duration_minutes: 60 },
      });
      expect(r.ok(), `create the session: ${r.status()} ${await r.text()}`).toBeTruthy();
      slot = (await r.json()).timeslot;
      expect(slot && slot.status, "PRECONDITION: the session has not started, so the banner offers Start Now").toBe("upcoming");
    }

    // ── the upcoming self-enrolment event P2 joins ──
    pend = await makeCompetition(sa, saCsrf, "hppend", {
      start_time: new Date(Date.now() + 3 * 3600e3).toISOString(), self_enroll_enabled: true,
    });
    const rv = await sa.get(`/api/admin/competitions/${pend.id}/self-enroll`);
    expect(rv.ok(), `reveal the join token: ${rv.status()}`).toBeTruthy();
    const token = (await rv.json()).token;
    expect(token, "the join token").toBeTruthy();
    const { api, csrf } = await apiLogin(p2.email, PARTICIPANT_PASS);
    try {
      const j = await api.post("/api/competitions/join", { headers: H(csrf), data: { token } });
      expect(j.ok(), `P2 joins: ${j.status()} ${await j.text()}`).toBeTruthy();
      const mine = await (await api.get("/api/my-competitions")).json();
      const list = Array.isArray(mine) ? mine : mine.competitions || [];
      const row = list.find(c => c.id === pend.id);
      expect(row, "PRECONDITION: P2 is a member of the upcoming event").toBeTruthy();
      expect(row.can_leave, "PRECONDITION: P2's self-enrolled row can be left, so the pending page offers Leave").toBe(true);
      expect(list.length, "PRECONDITION: it is P2's only event").toBe(1);
    } finally { await api.dispose(); }

    // The live event really is live, and did not auto-end.
    const all = await (await sa.get("/api/admin/competitions")).json();
    const live = (Array.isArray(all) ? all : all.competitions || []).find(c => c.id === comp.id);
    expect(live && (live.ended_at || null), "PRECONDITION: the live event has not ended").toBeNull();
  });

  // ── the download buttons' challenge: P3's own live tournament, P3 never answers ──
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    p3 = await makeParticipant(sa, saCsrf, "hpp3");
    dlComp = await makeCompetition(sa, saCsrf, "hpdl");
    dlTask = await makeTask(sa, saCsrf, "hpdl", {
      description: `<p>Read the <a href="${LINK_HREF}">docs</a>, then open the pack.</p>`,
      hint: "<p>Unzip it first.</p>",
      author_name: AUTHOR_NAME, author_linkedin: AUTHOR_LINKEDIN,
      attachment_url: LEGACY_URL,
    });
    {
      // The legacy button renders only for an http(s) attachment_url, which the
      // create route keeps only when validateUrl accepts it: read it back.
      const list = await (await sa.get("/api/admin/tasks")).json();
      const t = (Array.isArray(list) ? list : list.tasks || []).find(x => x.id === dlTask.id);
      expect(t && t.attachment_url, "PRECONDITION: the challenge stored its legacy attachment URL").toBe(LEGACY_URL);
      expect(t && t.author_linkedin, "PRECONDITION: the challenge stored its author's LinkedIn URL").toBe(AUTHOR_LINKEDIN);
    }
    {
      const r = await sa.post(`/api/admin/tasks/${dlTask.id}/attachments`, {
        headers: { "x-csrf-token": saCsrf },
        multipart: { display_name: DL_NAME, file: { name: "starter.zip", mimeType: "application/zip", buffer: zipOf("README.txt", "hover pack") } },
      });
      expect(r.ok(), `upload the attachment: ${r.status()} ${await r.text()}`).toBeTruthy();
      dlAttach = await r.json();
      expect(dlAttach && dlAttach.id, "the upload returned an attachment id").toBeTruthy();
      expect(dlAttach.display_name, "the upload kept its display name").toBe(DL_NAME);
      const listed = await (await sa.get(`/api/admin/tasks/${dlTask.id}/attachments`)).json();
      expect((Array.isArray(listed) ? listed : []).map(a => a.id), "PRECONDITION: the challenge holds exactly that one attachment")
        .toEqual([dlAttach.id]);
    }
    await assignTask(sa, saCsrf, dlTask.id, [dlComp.id]);
    await enrol(sa, saCsrf, dlComp.id, [p3.id]);
    const all = await (await sa.get("/api/admin/competitions")).json();
    const live = (Array.isArray(all) ? all : all.competitions || []).find(c => c.id === dlComp.id);
    expect(live && (live.ended_at || null), "PRECONDITION: the download event has not ended").toBeNull();
  });

  test.afterAll(async () => {
    console.log("[hover-pulse-no-fade] measured:\n" + MEASURED
      .map(m => m.what === "countdown"
        ? `  ${m.theme.padEnd(5)} countdown ${m.at.padEnd(5)} ${m.ratio.toFixed(2)}:1  ${m.color}`
        : `  ${m.theme.padEnd(5)} rest ${m.rest.toFixed(2)}:1 hover ${m.hover.toFixed(2)}:1  ${m.what}  ${m.color}`)
      .join("\n"));
    MEASURED.length = 0;   // a --repeat-each pass prints its own
    if (sa) await sa.dispose();
  });

  /** P1 signed in, in the live event, on a booted page in the light theme. */
  async function enterAsP1(page) {
    await loginViaApi(page, p1.email, PARTICIPANT_PASS);
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const sel = await page.request.post("/api/select-competition", { headers: H(csrfToken), data: { competitionId: comp.id } });
    expect(sel.ok(), `P1 selects the event: ${sel.status()} ${await sel.text()}`).toBeTruthy();
    await page.goto("/");
    expect(await themeOf(page), "PRECONDITION: the default theme is light").toBe("light");
  }

  /** …and on the challenge's own card. */
  async function openChallenge(page) {
    await enterAsP1(page);
    await clickChallengesNav(page);
    const open = page.locator(`[data-action="task-open"][data-task-id="${task.id}"]`);
    await open.waitFor({ state: "visible", timeout: 20000 });
    await open.click();
    await expect(page.locator("#task-detail-card .qa-title"), "the challenge's card is open").toHaveText(task.title, { timeout: 15000 });
  }

  test("the login page: Continue (.btn)", async ({ page }) => {
    await page.goto("/");
    const signIn = page.locator('#login-page [data-action="do-login"]');
    await expect(signIn, "the login page is up").toBeVisible({ timeout: 20000 });
    // v8.14.0 — the login page and its hover styles need no JS, but following
    // the OS into dark (toTheme) needs boot()'s matchMedia listener.
    await expectSpaBooted(page, "the login page");
    expect(await themeOf(page), "PRECONDITION: the default theme is light").toBe("light");
    await expectClasses(signIn, [], "Sign In");

    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await toTheme(page, "dark");
      await hoverCheck(page, signIn, "login Sign In (.btn)", theme);
    }
  });

  test("a challenge: Show Hint (.btn.sm.secondary) and its confirm's Reveal (.btn.danger) and Keep my points (.btn.secondary)", async ({ page }) => {
    await openChallenge(page);
    const show = page.locator(`#task-detail-card [data-action="task-reveal-hint"][data-task-id="${task.id}"]`);
    await expect(show, "the challenge offers its hint").toBeVisible();
    await expectClasses(show, ["sm", "secondary"], "Show Hint");
    const overlay = page.locator("#modal-overlay");
    const confirm = page.locator("#modal-confirm-btn");
    const cancel = page.locator("#modal-cancel-btn");

    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await toTheme(page, "dark");
      await hoverCheck(page, show, "challenge Show Hint (.btn.sm.secondary)", theme, { hoverColor: theme === "light" ? "--accent-ink" : null });
      await show.click();
      await expect(overlay, "the hint's priced confirm opened").toHaveClass(/\bopen\b/, { timeout: 10000 });
      await expect(page.locator("#modal-title"), "it is the hint confirm").toHaveText("Reveal Hint");
      await expectClasses(confirm, ["danger"], "Reveal hint");
      await expectClasses(cancel, ["secondary"], "Keep my points");
      await expect(cancel).toHaveText("Keep my points");
      await hoverCheck(page, confirm, "hint confirm Reveal (.btn.danger)", theme);
      await hoverCheck(page, cancel, "hint confirm Keep my points (.btn.secondary)", theme, { hoverColor: theme === "light" ? "--accent-ink" : null });
      await cancel.click();
      await expect(overlay, "Keep my points closed the confirm").not.toHaveClass(/\bopen\b/);
    }
    // CONTROL: nothing was bought — the hint is still offered, not shown.
    await expect(show, "the hint was never revealed (Keep my points spent nothing)").toBeVisible();
  });

  test("a challenge card's links (the description's and the author byline's LinkedIn) hover from --accent2 to --text, never a fade", async ({ page }) => {
    await openChallenge(page);
    const desc = page.locator(`#task-detail-card .task-desc a[href="${LINK_HREF}"]`);
    await expect(desc, "the sanitised description kept its link").toHaveText("docs");
    const byline = page.locator(`#task-detail-card a[href="${AUTHOR_LINKEDIN}"]`);
    await expect(byline, "the card's author byline offers the author's LinkedIn").toHaveText("LinkedIn");
    {
      const b = await byline.evaluate(el => ({
        inDesc: !!el.closest(".task-desc, .rich-body"),
        line: (el.parentElement && el.parentElement.textContent || "").replace(/\s+/g, " ").trim(),
      }));
      expect(b.inDesc, "PRECONDITION: the byline link is the card's own markup, not description rich text").toBe(false);
      expect(b.line, "PRECONDITION: it is the author byline").toBe(`By ${AUTHOR_NAME} · LinkedIn`);
    }

    /** One link held to the rule, in the page's current theme. */
    async function linkCheck(link, what, theme) {
      expect(await themeOf(page), `PRECONDITION ${what}: the page is in the ${theme} theme`).toBe(theme);
      await rest(page);
      const r = await stateOf(link);
      const accent2 = await tokenAt(link, "color", "var(--accent2)");
      const text = await tokenAt(link, "color", "var(--text)");
      expect(r.hover, `CONTROL ${what} (${theme}): not hovered at rest`).toBe(false);
      expect(r.opacity, `${what} (${theme}): at full strength at rest`).toBe("1");
      expect(r.color, `${what} (${theme}): the resting link is --accent2`).toBe(accent2);
      expect(text, `CONTROL ${what} (${theme}): --text differs from --accent2, so the hover's change is visible`).not.toBe(accent2);
      const rc = await textContrast(link);
      expect(rc.ratio, `${what} (${theme}) at rest: textContrast parsed: ${JSON.stringify(rc)}`).not.toBeNull();

      await link.hover();
      await expect.poll(() => link.evaluate(el => el.matches(":hover")),
        { message: `PRECONDITION ${what} (${theme}): the link matches :hover`, timeout: 5000 }).toBe(true);
      await settle(page);
      const h = await stateOf(link);
      const hc = await textContrast(link);
      expect(h.hover, `PRECONDITION ${what} (${theme}): still hovered when measured`).toBe(true);
      expect(hc.ratio, `${what} (${theme}) hovered: textContrast parsed: ${JSON.stringify(hc)}`).not.toBeNull();
      expect(h.opacity, `NO FADE ${what} (${theme}): the hovered link is at computed opacity 1`).toBe("1");
      expect(hc.opacity, `NO FADE ${what} (${theme}): nothing above the hovered link fades it`).toBe(1);
      expect(h.color, `HOVER CUE ${what} (${theme}): the hovered link is --text`).toBe(text);
      expect(hc.ratio, `AA ${what} (${theme}): the hovered link (${h.color}) measures >= 4.5:1 on ${JSON.stringify(hc.bg)}`)
        .toBeGreaterThanOrEqual(4.5);
      MEASURED.push({ what, theme, rest: rc.ratio, hover: hc.ratio, color: h.color });
      await rest(page);
    }

    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await toTheme(page, "dark");
      await linkCheck(desc, "description link", theme);
      await linkCheck(byline, "author byline LinkedIn link", theme);
    }
  });

  test("a challenge's download buttons (<a class=\"btn secondary sm\">) rest and hover like the card's Show Hint, not like its links", async ({ page }) => {
    await loginViaApi(page, p3.email, PARTICIPANT_PASS);
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const sel = await page.request.post("/api/select-competition", { headers: H(csrfToken), data: { competitionId: dlComp.id } });
    expect(sel.ok(), `P3 selects the event: ${sel.status()} ${await sel.text()}`).toBeTruthy();
    await page.goto("/");
    expect(await themeOf(page), "PRECONDITION: the default theme is light").toBe("light");
    await clickChallengesNav(page);
    const open = page.locator(`[data-action="task-open"][data-task-id="${dlTask.id}"]`);
    await open.waitFor({ state: "visible", timeout: 20000 });
    await open.click();
    await expect(page.locator("#task-detail-card .qa-title"), "the challenge's card is open").toHaveText(dlTask.title, { timeout: 15000 });

    const card = page.locator("#task-detail-card");
    const uploaded = card.locator(`a.task-detail-attachment-link[href="/api/tasks/${dlTask.id}/attachments/${dlAttach.id}"]`);
    const legacy = card.locator(`a[href="${LEGACY_URL}"]`);
    const twin = card.locator(`[data-action="task-reveal-hint"][data-task-id="${dlTask.id}"]`);
    const desc = card.locator(`.task-desc a[href="${LINK_HREF}"]`);
    const byline = card.locator(`a[href="${AUTHOR_LINKEDIN}"]`);
    await expect(uploaded, "the card offers the uploaded attachment").toContainText(DL_NAME);
    await expect(legacy, "the card offers the legacy attachment URL").toHaveText(/Download Attachment/);
    await expect(twin, "the card offers its hint (the .btn.secondary twin)").toBeVisible();
    await expectClasses(twin, ["secondary", "sm"], "Show Hint (the twin)");
    await expect(desc, "the sanitised description kept its link").toHaveText("docs");
    await expect(byline, "the byline offers the author's LinkedIn").toHaveText("LinkedIn");
    {
      const where = await Promise.all([uploaded, legacy].map(l => l.evaluate(el => ({
        inRich: !!el.closest(".task-desc, .rich-body"), download: el.hasAttribute("download"), target: el.getAttribute("target"),
      }))));
      expect(where.map(w => w.inRich), "PRECONDITION: both buttons are the card's own markup, not description rich text").toEqual([false, false]);
      expect(where[0].download, "PRECONDITION: the uploaded attachment is a download link").toBe(true);
      expect(where[1].target, "PRECONDITION: the legacy attachment opens in a new tab").toBe("_blank");
    }

    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await toTheme(page, "dark");
      await downloadButtonCheck(page, uploaded, twin, "card download: uploaded attachment (a.btn.sm.secondary)", theme);
      await downloadButtonCheck(page, legacy, twin, "card download: legacy Download Attachment (a.btn.sm.secondary)", theme);
      await linkAtRest(page, desc, "card description link", theme);
      await linkAtRest(page, byline, "card author byline LinkedIn link", theme);
    }
    // CONTROL: the buttons were only hovered — nothing was revealed or bought.
    await expect(twin, "the hint is still offered, never revealed").toBeVisible();
  });

  test("View as Participant: the preview's download buttons rest and hover like its Dismiss (.btn.sm.secondary), not like its links", async ({ page }) => {
    await loginViaApi(page, sa2.email, PARTICIPANT_PASS);
    const me = await page.request.get("/api/admin/me");
    expect(me.ok(), `SA2 has a live admin session: ${me.status()}`).toBeTruthy();
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    expect(await themeOf(page), "PRECONDITION: the default theme is light").toBe("light");
    await clickTab(page, "Challenges");
    const row = await findSeededTaskRow(page, dlTask.title);
    await row.first().locator("[data-action='task-view']").first().click();
    const overlay = page.locator("#task-preview-overlay");
    await overlay.waitFor({ state: "visible", timeout: 10000 });
    await expect(overlay.locator("#task-preview-title"), "it is the download challenge's preview").toHaveText(dlTask.title);

    const uploaded = overlay.locator(`a.task-preview-attachment-link[href="/api/admin/tasks/${dlTask.id}/attachments/${dlAttach.id}"]`);
    const legacy = overlay.locator(`.task-preview-attach a[href="${LEGACY_URL}"]`);
    const twin = overlay.locator('.task-preview-head [data-action="task-preview-close"]');
    const desc = overlay.locator(`.task-preview-desc a[href="${LINK_HREF}"]`);
    const byline = overlay.locator(`.task-preview-author a[href="${AUTHOR_LINKEDIN}"]`);
    await expect(uploaded, "the preview offers the uploaded attachment").toContainText(DL_NAME);
    await expect(legacy, "the preview offers the legacy attachment URL").toHaveText(/Download Attachment/);
    await expect(twin, "the preview's head offers Dismiss (the .btn.secondary twin)").toHaveText("Dismiss");
    await expectClasses(twin, ["secondary", "sm"], "preview Dismiss (the twin)");
    await expect(desc, "the preview's description kept its link").toHaveText("docs");
    await expect(byline, "the preview's byline offers the author's LinkedIn").toHaveText("LinkedIn");

    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await toTheme(page, "dark");
      await downloadButtonCheck(page, uploaded, twin, "preview download: uploaded attachment (a.btn.sm.secondary)", theme);
      await downloadButtonCheck(page, legacy, twin, "preview download: legacy Download Attachment (a.btn.sm.secondary)", theme);
      await linkAtRest(page, desc, "preview description link", theme);
      await linkAtRest(page, byline, "preview author byline LinkedIn link", theme);
    }
    await expect(overlay, "CONTROL: hovering never dismissed the preview").toBeVisible();
  });

  test("admin Participants: Invite (.btn.sm), a row's Verify (.btn.sm.warning), and its confirm (.btn.warning, .btn.secondary)", async ({ page }) => {
    await loginViaApi(page, sa2.email, PARTICIPANT_PASS);
    const me = await page.request.get("/api/admin/me");
    expect(me.ok(), `SA2 has a live admin session: ${me.status()}`).toBeTruthy();
    expect((await me.json()).isSuperAdmin, "PRECONDITION: SA2 is a superadmin, so unverified rows offer Verify").toBe(true);
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    expect(await themeOf(page), "PRECONDITION: the default theme is light").toBe("light");
    await clickTab(page, "Participants");
    await narrowPeopleTable(page, u.email);
    const row = page.locator("#admin-participants-body tr", { hasText: u.email });
    await expect(row, "U's row is the one listed").toHaveCount(1, { timeout: 15000 });
    const invite = page.locator("#invite-participants-btn");
    const verify = row.locator(`[data-action="participant-verify"][data-user-id="${u.id}"]`).first();
    await expect(verify, "U's row offers Verify").toBeVisible();
    await expectClasses(invite, ["sm"], "Invite");
    await expectClasses(verify, ["sm", "warning"], "row Verify");
    const overlay = page.locator("#modal-overlay");
    const confirm = page.locator("#modal-confirm-btn");
    const cancel = page.locator("#modal-cancel-btn");

    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await toTheme(page, "dark");
      await hoverCheck(page, invite, "Participants Invite (.btn.sm)", theme);
      await hoverCheck(page, verify, "Participants row Verify (.btn.sm.warning)", theme);
      await verify.click();
      await expect(overlay, "the Verify confirm opened").toHaveClass(/\bopen\b/, { timeout: 10000 });
      await expect(page.locator("#modal-title"), "it is the Verify confirm").toHaveText("Verify User");
      await expectClasses(confirm, ["warning"], "Verify confirm");
      await expectClasses(cancel, ["secondary"], "Verify Cancel");
      await hoverCheck(page, confirm, "Verify confirm (.btn.warning)", theme);
      await hoverCheck(page, cancel, "Verify confirm Cancel (.btn.secondary)", theme, { hoverColor: theme === "light" ? "--accent-ink" : null });
      await cancel.click();
      await expect(overlay, "Cancel closed the confirm").not.toHaveClass(/\bopen\b/);
    }
    // CONTROL: Cancel verified nobody.
    const back = (await (await sa.get("/api/admin/participants?limit=5000")).json()).participants.find(p => p.id === u.id);
    expect(!!(back && back.verified), "U is still unverified — the dialogs were only hovered and cancelled").toBe(false);
  });

  test("event workspace: an upcoming session's Start now (.btn.sm) on the Overview, hovered and never clicked", async ({ page }) => {
    await loginViaApi(page, sa2.email, PARTICIPANT_PASS);
    const me = await page.request.get("/api/admin/me");
    expect(me.ok(), `SA2 has a live admin session: ${me.status()}`).toBeTruthy();
    await page.goto("/");
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
    expect(await themeOf(page), "PRECONDITION: the default theme is light").toBe("light");
    await clickTab(page, "Events");
    await viewComp(page, sessComp.name);
    // The workspace's Overview lists the event's sessions, each with its own
    // controls; an upcoming one offers Start now, the control an admin uses.
    const overview = page.locator("#ws-overview");
    const startNow = overview.locator(`[data-action="ts-start-now"][data-ts-id="${slot.id}"]`);
    await expect(startNow, "the upcoming session's row offers Start now").toBeVisible({ timeout: 10000 });
    await expect(startNow).toHaveText("Start now");
    await expectClasses(startNow, ["sm"], "Start now");
    // The node is tagged, and the CONTROL after the checks proves no repaint
    // swapped it out under the pointer mid-measure.
    await startNow.evaluate(el => { el.__hpMeasured = true; });

    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await toTheme(page, "dark");
      await hoverCheck(page, startNow, "workspace Start now (.btn.sm)", theme);
    }
    expect(await startNow.evaluate(el => el.__hpMeasured === true),
      "CONTROL: the Start now measured in both themes is the one node the Overview showed throughout").toBe(true);
    // CONTROL: it was only hovered — the session has still not started.
    const slots = await (await sa.get(`/api/admin/competitions/${sessComp.id}/timeslots`)).json();
    const after = (Array.isArray(slots) ? slots : []).find(s => s.id === slot.id);
    expect(after && after.status, "the session is still upcoming — Start now was never pressed").toBe("upcoming");
    expect(after && after.start_time, "its start time is unchanged").toBe(slot.start_time);
  });

  test("the pending page: Leave this event (.btn.danger-link) turns red and raises no shadow", async ({ page }) => {
    await loginViaApi(page, p2.email, PARTICIPANT_PASS);
    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    const sel = await page.request.post("/api/select-competition", { headers: H(csrfToken), data: { competitionId: pend.id } });
    expect(sel.ok(), `P2 selects the upcoming event: ${sel.status()} ${await sel.text()}`).toBeTruthy();
    await page.goto("/");
    await expect(page.locator("#pending-page"), "the upcoming event lands on its pending page").toBeVisible({ timeout: 20000 });
    expect(await themeOf(page), "PRECONDITION: the default theme is light").toBe("light");
    const leave = page.locator('#pending-leave [data-action="leave-competition"]');
    await expect(leave, "the pending page offers Leave this event").toBeVisible();
    await expectClasses(leave, ["danger-link"], "Leave this event");

    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await toTheme(page, "dark");
      await rest(page);
      const m = await rowMarking(leave);
      expect(m.opacity, `Leave (${theme}): at full strength at rest`).toBe("1");
      expect(m.color, `Leave (${theme}): QUIET at rest — the resting link is --muted`).toBe(m.muted);
      await hoverCheck(page, leave, "pending Leave this event (.btn.danger-link)", theme,
        { link: true, hoverColor: theme === "light" ? "--badge-red-fg" : "--red" });
    }
  });

  test("the header countdown's last ten seconds pulse colour, never opacity, and turn red in light too", async ({ page }) => {
    await enterAsP1(page);
    const timer = page.locator("#header-timer");
    await expect(timer, "the header timer is running").toBeVisible({ timeout: 20000 });
    await expect(timer, "the header timer shows the time left").toHaveText(/\d+:\d\d/, { timeout: 20000 });

    const read = () => timer.evaluate(el => {
      const cs = getComputedStyle(el);
      return {
        warn: el.classList.contains("urgent-warn"), final: el.classList.contains("urgent-final"),
        fill: cs.webkitTextFillColor, color: cs.color, opacity: cs.opacity,
        anims: el.getAnimations().map(a => a.animationName || a.constructor.name),
      };
    });

    // CONTROL (light, > 60 s away): the gradient's transparent fill — so the
    // urgent assertion below is about a rule that has something to beat.
    {
      const c = await read();
      expect(c.warn || c.final, "CONTROL: ten hours out, the timer carries no urgent class").toBe(false);
      expect(c.fill, "CONTROL (light): at rest the timer is the gradient, its text fill transparent").toBe(TRANSPARENT);
      expect(c.anims, "CONTROL: no pulse runs at rest").not.toContain("countdownPulse");
    }

    // Drive the REAL 1 s tick into its last ten seconds through the window
    // namespace's live S setter, then freeze it once it has applied the class
    // (so it never reaches zero and ends the event, and the 15 s status poll
    // cannot restore the server's end time). A poll landing first is retried.
    const driven = await page.evaluate(async () => {
      const el = document.getElementById("header-timer");
      for (let attempt = 1; attempt <= 3; attempt++) {
        const at = new Date(Date.now() + 8500);
        window.hackathonEndTime = at;
        const wrote = window.S.hackathonEndTime instanceof Date && window.S.hackathonEndTime.getTime() === at.getTime();
        const t0 = Date.now();
        while (Date.now() - t0 < 2500) {
          if (el.classList.contains("urgent-final")) {
            clearInterval(window.S.timerInterval);
            clearInterval(window.S.statusPollInterval);
            return { ok: true, attempt, wrote, text: el.textContent, ended: !!window.S.hackathonEnded };
          }
          await new Promise(r => setTimeout(r, 50));
        }
      }
      return { ok: false, cls: el.className, end: String(window.S.hackathonEndTime) };
    });
    expect(driven.ok, `the tick applied .urgent-final: ${JSON.stringify(driven)}`).toBe(true);
    expect(driven.wrote, "PRECONDITION: window.hackathonEndTime wrote through to S").toBe(true);
    expect(driven.ended, "PRECONDITION: the event did not end under the test").toBe(false);
    expect(driven.text, "the timer reads under ten seconds").toMatch(/^00:00:0\d$/);
    {
      const c = await read();
      expect(c.warn && c.final, "both urgent classes are on the timer").toBe(true);
    }

    /** Pause the pulse at `t` ms and read what it paints there. */
    const at = t => timer.evaluate((el, t) => {
      const a = el.getAnimations().find(x => x.animationName === "countdownPulse");
      if (!a) return { found: false, anims: el.getAnimations().map(x => x.animationName) };
      a.pause();
      a.currentTime = t;
      const cs = getComputedStyle(el);
      const probe = n => {
        const s = document.createElement("span");
        s.style.color = `var(${n})`;
        el.parentElement.appendChild(s);
        const c = getComputedStyle(s).color;
        s.remove();
        return c;
      };
      return {
        found: true, paused: a.playState === "paused", progress: a.effect.getComputedTiming().progress,
        opacity: cs.opacity, color: cs.color, fill: cs.webkitTextFillColor,
        red: probe("--red"), pulseTo: probe("--text"),
      };
    }, t);

    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await toTheme(page, "dark");
      expect(await themeOf(page), `PRECONDITION: the page is in the ${theme} theme`).toBe(theme);
      for (const [label, t, token] of [["start", 0, "red"], ["end", 1000, "pulseTo"]]) {
        const s = await at(t);
        expect(s.found, `countdown (${theme}): the countdownPulse animation runs on the timer: ${JSON.stringify(s)}`).toBe(true);
        expect(s.paused, `PRECONDITION countdown (${theme}): the pulse is paused for the read`).toBe(true);
        expect(s.progress, `PRECONDITION countdown (${theme}): the ${label} of one iteration`).toBe(t === 0 ? 0 : 1);
        expect(s.red, `CONTROL countdown (${theme}): --red differs from --text, so the pulse moves`).not.toBe(s.pulseTo);
        expect(s.opacity, `NO FADE countdown (${theme}, ${label} of the pulse): computed opacity 1`).toBe("1");
        expect(s.color, `countdown (${theme}, ${label}): the digits are --${token === "red" ? "red" : "text"}`)
          .toBe(s[token]);
        if (theme === "light") {
          expect(s.fill, `LIGHT URGENT RED countdown (${label}): the gradient's transparent fill is gone, so the red paints`)
            .not.toBe(TRANSPARENT);
        }
        expect(s.fill, `countdown (${theme}, ${label}): the text fill is the pulsing colour`).toBe(s.color);
        const c = await textContrast(timer);
        expect(c.ratio, `countdown (${theme}, ${label}): textContrast parsed: ${JSON.stringify(c)}`).not.toBeNull();
        expect(c.opacity, `NO FADE countdown (${theme}, ${label}): nothing above the timer fades it`).toBe(1);
        expect(c.ratio, `AA countdown (${theme}, ${label}): ${s.color} measures >= 4.5:1 on ${JSON.stringify(c.bg)}`)
          .toBeGreaterThanOrEqual(4.5);
        MEASURED.push({ what: "countdown", theme, at: label, ratio: c.ratio, color: s.color });
      }
    }

    // CONTROL: take the urgent classes away and the gradient's transparent fill
    // returns, in both themes — the red above is the urgent rule's doing.
    await timer.evaluate(el => el.classList.remove("urgent-warn", "urgent-final"));
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await toTheme(page, "light");
      const c = await read();
      expect(c.anims, `CONTROL (${theme}): no pulse without .urgent-final`).not.toContain("countdownPulse");
      expect(c.fill, `CONTROL (${theme}): without the urgent classes the timer is the gradient again`).toBe(TRANSPARENT);
    }
  });
});
