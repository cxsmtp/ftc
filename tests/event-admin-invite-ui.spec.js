"use strict";

// v8.13.7 — THE INVITE DIALOG CARRIES THE EVENT ADMIN'S "AT LEAST ONE EVENT" RULE.
//
// POST /api/admin/invitations refuses an event admin's invitation that names no
// event they manage (400 `event_admin_competition_required`), refuses one naming
// an event they compete in (403 `competitor_cannot_edit`), and lets a global admin
// send one naming none. That is the server half, locked elsewhere. This file locks
// what the DIALOG offers, which no wire-replay test can see:
//
//   * ONE tickable event   → it is ticked AND locked ("Always included"), with the
//                            reason under the list, and the locked tick is SENT;
//   * TWO OR MORE          → nothing is locked, a note says one must be ticked, and
//                            Send with none ticked is refused in the dialog with
//                            no request;
//   * NONE                 → Send is disabled and points at the reason, which
//                            names WHY (no open event / competes in every one) and
//                            is also the dialog's description; with rows listed it
//                            sits UNDER the 200px scroller, never inside it, so no
//                            number of rows can scroll it out of sight;
//   * a list holding no box a keyboard can reach (every row locked or competing)
//     is a tab stop of its own, so its rows can still be scrolled to;
//   * the event list is read FRESH for an event admin, never the cached admin
//     model; a failed read opens no dialog; a slow read SUPERSEDED by a later
//     open opens nothing, and a slow groups load from a replaced dialog leaves
//     the showing dialog's group picks alone.
//
// INACTIVE ROWS (v8.13.7, operator-approved): a row that cannot be picked is
// marked with a dashed edge and muted text AT FULL STRENGTH — never the global
// `.is-disabled{opacity:.5}`, which composited the name and its reason flag below
// AA. Only its checkbox stays faded, as any disabled control is. Measured with the
// shared `rowMarking` / `textContrast` helpers, in light AND dark.
//
// EVERY ARM HAS A CONTROL that a strictly worse build would fail:
//   * a GLOBAL ADMIN (role 'admin') put in the SAME one-event state (their cached
//     model narrowed to `mine`) sees it unlocked, unticked, with no note, makes no
//     fresh read, and may send with nothing ticked — so "the event is locked"
//     cannot be satisfied by a dialog that locks (or fetches) for every tier;
//   * an event the actor COMPETES in is listed beside the locked one: its box IS
//     faded (0.5), so the locked box's "1" is measured beside a box the fade
//     really reaches, and "only one" is proved to exclude competing events;
//   * the several-events state has enabled boxes, so its list is NO tab stop and
//     its dialog has no description — the attributes are not on every dialog;
//   * the two-or-more case's refusal is followed by a real send once an event is
//     ticked, and its focus pre-tick is shown to be untickable.
//
// FIXTURES: `buildWorld()` (world.ea organises exactly ONE live event, `mine`,
// and does not compete in it; world.zero holds the role with NO grants) plus five
// actors built here, every one asserted on its OWN `GET /api/admin/competitions`
// rows before any browser reads a DOM rendered from them, and one group world.ea
// created and may write.
//
// SESSIONS: every fixture write is in `beforeAll`, through `world.sa` (the
// built-in superadmin) or a fresh API login of the actor, which no test reuses.
// Each test signs ONE user-backed actor into its browser context via
// `page.request` before the first `page.goto`.
const { test, expect } = require("./isolated-test");
const { BASE, PARTICIPANT_PASS, apiLogin } = require("./helpers");
const {
  loginViaApi, clickTab, viewComp, awaitCompModel, AxeBuilder, AXE_GATED_IMPACTS,
  textContrast, rowMarking, inviteDoor,
} = require("./ui-admin-helpers");
const {
  H, uniq, buildWorld, makeParticipant, makeCompetition, enrol, grantEventAdmin,
} = require("./event-admin-helpers");
const { liveBooth, expireEvent } = require("./late-entry-fixture");

test.use({ baseURL: BASE });

const iso = ms => new Date(Date.now() + ms).toISOString();

// The dialog's copy, verbatim (public/js/features/participants-admin.js).
const LOCKED_NOTE = "This is the only one of your events you can invite people into right now, so everyone you invite is added to it.";
const REQUIRED_NOTE = "Tick at least one of your events: everyone you invite is added to the events you tick.";
const REQUIRED_ERR = "Tick at least one of your events. As an event admin you can only invite people into an event you manage.";
const NONE_NO_EVENTS = "None of your events is live, upcoming or taking late entries, so you cannot invite anybody right now: everyone you invite has to join one of your events.";
const NONE_COMPETES = "You compete in every one of your events that can take new participants, so you cannot invite anybody into them. Ask another organiser to send the invitations.";
const LOAD_FAIL = "Could not load your events. Check your connection and try again.";

const COMPS_PATH = "/api/admin/competitions";
const GROUPS_PATH = "/api/admin/groups";
/** The competitions list route, with or without a query string (never `/:id/...`). */
const COMPS_RE = /\/api\/admin\/competitions(\?.*)?$/;
const GROUPS_RE = /\/api\/admin\/groups(\?.*)?$/;

/** Sign a USER-BACKED admin into the browser and land on a settled admin panel; returns /api/admin/me. */
async function panel(page, email) {
  await loginViaApi(page, email, PARTICIPANT_PASS);
  const meR = await page.request.get("/api/admin/me");
  expect(meR.ok(), `${email} had no live admin session before goto("/"): ${meR.status()} ${await meR.text()}`).toBeTruthy();
  const me = await meR.json();
  await page.goto("/");
  // `#admin-page` is the readiness signal: the sidebar buttons are static markup.
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("[data-action='admin-tab'][data-tab-id='admin-competitions-tab']").first()
    .waitFor({ state: "visible", timeout: 30000 });
  return me;
}

/** Participants tab → Invite → the dialog. Inside an event's workspace the one
 *  Invite is the header's menu (owner's decision, 27 Nov 2026: the Participants
 *  toolbar keeps no Invite there); People keeps its toolbar's. */
async function openInvite(page, { tab = true } = {}) {
  if (tab) await clickTab(page, "Participants");
  const inWs = await page.locator("#admin-workspace:not([hidden]) #ws-record").isVisible().catch(() => false);
  if (!inWs) {
    const btn = page.locator("#invite-participants-btn");
    await expect(btn, "the Invite button is on the Participants tab").toBeVisible({ timeout: 10000 });
  }
  await inviteDoor(page, "invite");
  const overlay = page.locator("#invite-overlay");
  await expect(overlay, "the invite dialog opened").toBeVisible({ timeout: 15000 });
  await expect(overlay, "exactly one invite dialog").toHaveCount(1);
  return overlay;
}

/** The dialog row for one event, found by its id (never its position or name). */
const rowOf = (overlay, comp) => overlay.locator(`label.picker-row:has(input.invite-comp-cb[value="${comp.id}"])`);
const boxOf = (overlay, comp) => overlay.locator(`input.invite-comp-cb[value="${comp.id}"]`);
// The caption sits in a .help-label-row beside its "?" tip, so it is a grandchild of the group.
const assignLabel = overlay => overlay.locator(".form-group label#invite-comp-label", { hasText: "Assign to Events" });
const listOf = overlay => overlay.locator(".invite-comp-list");
const cardOf = overlay => overlay.locator('[role="dialog"]');

/** Every POST to the invitations route this page makes, as parsed bodies. */
function recordInvitePosts(page) {
  /** @type {any[]} */ const posts = [];
  page.on("request", req => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/admin/invitations") {
      posts.push(req.postDataJSON());
    }
  });
  return posts;
}

const isInviteResponse = r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/admin/invitations";

/** Settle every FINITE animation under a region, so axe and computed styles read the resting state. */
async function drainAnimations(page, sel) {
  await page.evaluate(async (s) => {
    const root = document.querySelector(s);
    const anims = root && root.getAnimations ? root.getAnimations({ subtree: true }) : [];
    await Promise.all(anims
      .filter(a => a.effect && Number.isFinite(a.effect.getComputedTiming().endTime))
      .map(a => a.finished.catch(() => {})));
  }, sel);
}

/** Axe over the dialog, gated on the suite's impact threshold, naming the rules. */
async function axeClean(page, what) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).include("#invite-overlay").analyze();
  const bad = r.violations.filter(v => AXE_GATED_IMPACTS.has(v.impact || ""));
  expect(bad.map(v => `${v.id} (${v.impact}): ${v.nodes.map(n => n.target.join(" ")).join(", ")}`),
    `${what}: no moderate+ axe violations`).toEqual([]);
}

/** axe's scrollable-region-focusable rule alone, over the dialog. */
const scrollRule = page => new AxeBuilder({ page }).include("#invite-overlay").withRules(["scrollable-region-focusable"]).analyze();
const namesList = res => (res || []).some(r => r.id === "scrollable-region-focusable"
  && r.nodes.some(n => n.target.join(" ").includes("invite-comp-list")));

/** The theme the page RESOLVED, from the attribute theme-boot writes. */
const themeOf = page => page.evaluate(() => document.documentElement.dataset.theme);

/** Follow the OS into `scheme` and settle. Nothing stored is the house mode, which follows the OS too (HOUSE_MODE "system"); "system" is stored first so the helper holds whatever that default becomes. */
async function toTheme(page, scheme) {
  await page.evaluate(() => { try { localStorage.setItem("hck-theme", "system"); } catch (_) { /* no storage */ } });
  await page.emulateMedia({ colorScheme: scheme });
  await expect.poll(() => themeOf(page), { message: `the page followed the OS preference into ${scheme}`, timeout: 5000 })
    .toBe(scheme);
  await drainAnimations(page, "#invite-overlay");
}

/**
 * Count, per URL path, the JSON bodies the PAGE has finished parsing. The app
 * reads every list through `fetchJsonList` → `r.json()`, and its continuation is
 * microtask-chained after this wrapper's, so once a later `page.evaluate` (a new
 * task) reads the count up, the app's own code for that response has run. This
 * is the positive witness that a held response really LANDED in the client, and
 * not merely on the wire.
 */
async function countJsonParses(page) {
  await page.addInitScript(() => {
    const orig = Response.prototype.json;
    window.__jsonParsed = {};
    Response.prototype.json = function () {
      let p = "";
      try { p = new URL(this.url).pathname; } catch (_) { p = ""; }
      return orig.call(this).then(v => { window.__jsonParsed[p] = (window.__jsonParsed[p] || 0) + 1; return v; });
    };
  });
}
const parsedCount = (page, path) => page.evaluate(p => (window.__jsonParsed || {})[p] || 0, path);

/** Stop the 15 s admin competitions poll, so every GET of the list in the test is one the test caused. */
async function stopCompPoll(page) {
  const stopped = await page.evaluate(() => {
    const had = !!window.S.adminCompPollInterval;
    clearInterval(window.S.adminCompPollInterval);
    window.S.adminCompPollInterval = null;
    return had;
  });
  expect(stopped, "precondition: the admin competitions poll was running, and is now stopped").toBe(true);
}

/** A route handler that HOLDS the first matching GET and passes every other request through. */
function holdFirstGet() {
  /** @type {(r: import('@playwright/test').Route) => void} */ let resolveHeld = () => {};
  const held = new Promise(res => { resolveHeld = res; });
  let gets = 0;
  const handler = route => {
    if (route.request().method() !== "GET") return route.continue();
    gets++;
    if (gets === 1) { resolveHeld(route); return undefined; }   // held: neither continued nor fulfilled
    return route.continue();
  };
  return { held, handler, gets: () => gets };
}

test.describe("v8.13.7 — the invite dialog carries the event admin's 'at least one event' rule", () => {
  /** @type {any} */ let world;
  /** @type {any} */ let ga, multi, oneOfTwo, competesOnly, many;
  /** @type {any} */ let live2, up, late, ended, comp, solo, comp2, comp3, ended3, many1, many2, many3, many4;
  /** @type {any} */ let eaGroup;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    world = await buildWorld();
    const { sa, saCsrf } = world;

    // ── the GLOBAL control: a regular admin, competing nowhere ───────────────
    ga = await makeParticipant(sa, saCsrf, "invga");
    {
      const r = await sa.post(`/api/admin/participants/${ga.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
      expect(r.ok(), `promote the global control to admin: ${r.status()} ${await r.text()}`).toBeTruthy();
    }

    // ── MULTI: several tickable events of every open kind, an ended one, and one
    //    they compete in ───────────────────────────────────────────────────────
    multi = await makeParticipant(sa, saCsrf, "invmulti");
    live2 = await makeCompetition(sa, saCsrf, "invlive2");
    up = await makeCompetition(sa, saCsrf, "invup", { start_time: iso(2 * 3600e3) });
    ended = await makeCompetition(sa, saCsrf, "invended", { start_time: iso(-2 * 3600e3), duration_minutes: 60 });
    comp = await makeCompetition(sa, saCsrf, "invcomp", { staff_compete: true });
    {
      const { comp: lb } = await liveBooth(sa, saCsrf);
      late = { id: lb.id, name: lb.name };
    }
    for (const c of [live2, up, late, ended, comp]) await grantEventAdmin(sa, saCsrf, c.id, multi.id);
    await enrol(sa, saCsrf, comp.id, [multi.id]);          // grant first, then enrol: they now COMPETE in `comp`
    await expireEvent(late.id, { agoMinutes: 30 });        // ended 30 min ago, its late-entry window open

    // ── ONE-OF-TWO: one tickable event beside one they compete in ────────────
    oneOfTwo = await makeParticipant(sa, saCsrf, "invoneoftwo");
    solo = await makeCompetition(sa, saCsrf, "invsolo");
    comp2 = await makeCompetition(sa, saCsrf, "invcomp2", { staff_compete: true });
    await grantEventAdmin(sa, saCsrf, solo.id, oneOfTwo.id);
    await grantEventAdmin(sa, saCsrf, comp2.id, oneOfTwo.id);
    await enrol(sa, saCsrf, comp2.id, [oneOfTwo.id]);

    // ── COMPETES-ONLY: their only open event is one they compete in ──────────
    competesOnly = await makeParticipant(sa, saCsrf, "invcompetesonly");
    comp3 = await makeCompetition(sa, saCsrf, "invcomp3", { staff_compete: true });
    ended3 = await makeCompetition(sa, saCsrf, "invended3", { start_time: iso(-2 * 3600e3), duration_minutes: 60 });
    await grantEventAdmin(sa, saCsrf, comp3.id, competesOnly.id);
    await grantEventAdmin(sa, saCsrf, ended3.id, competesOnly.id);
    await enrol(sa, saCsrf, comp3.id, [competesOnly.id]);

    // ── MANY: they compete in FOUR open events they organise, and nothing else
    many = await makeParticipant(sa, saCsrf, "invmany");
    many1 = await makeCompetition(sa, saCsrf, "invmany1", { staff_compete: true });
    many2 = await makeCompetition(sa, saCsrf, "invmany2", { staff_compete: true });
    many3 = await makeCompetition(sa, saCsrf, "invmany3", { staff_compete: true });
    many4 = await makeCompetition(sa, saCsrf, "invmany4", { staff_compete: true });
    for (const c of [many1, many2, many3, many4]) {
      await grantEventAdmin(sa, saCsrf, c.id, many.id);    // grant first…
      await enrol(sa, saCsrf, c.id, [many.id]);           // …then enrol: they COMPETE in it
    }

    // ── preconditions, each on the ACTOR's own list (the dialog's source) ────
    const ownRows = async (email) => {
      const l = await apiLogin(email, PARTICIPANT_PASS);
      try {
        const me = await (await l.api.get("/api/admin/me")).json();
        const r = await l.api.get(COMPS_PATH);
        expect(r.ok(), `${email}'s competitions list answers: ${r.status()}`).toBeTruthy();
        const rows = await r.json();
        expect(Array.isArray(rows), `${email}'s list is an array`).toBe(true);
        return { me, rows, by: id => rows.find(x => x.id === id) };
      } finally { await l.api.dispose(); }
    };
    const sortIds = a => [...a].sort();

    {
      const { me, rows, by } = await ownRows(world.ea.email);
      expect(me.isEventAdmin, "world.ea holds the event-admin tier").toBe(true);
      expect(rows.map(r => r.id), "world.ea sees exactly `mine`").toEqual([world.mine.id]);
      expect(by(world.mine.id).status, "…which is live").toBe("live");
      expect(by(world.mine.id).competing, "…and which they do not compete in").toBe(false);
    }
    {
      const { me, rows } = await ownRows(world.zero.email);
      expect(me.isEventAdmin, "world.zero holds the tier").toBe(true);
      expect(rows, "…and sees no event at all").toEqual([]);
    }
    {
      const { me, rows, by } = await ownRows(multi.email);
      expect(me.isEventAdmin, "multi holds the tier").toBe(true);
      expect(sortIds(rows.map(r => r.id)), "multi sees exactly its five events")
        .toEqual(sortIds([live2.id, up.id, late.id, ended.id, comp.id]));
      expect(by(live2.id).status).toBe("live");
      expect(by(up.id).status, "`up` is upcoming").toBe("upcoming");
      expect(by(late.id).status, "`late` has ended…").toBe("ended");
      expect(by(late.id).late_entry_window_open, "…with its late-entry window OPEN").toBe(true);
      expect(by(ended.id).status, "`ended` has ended…").toBe("ended");
      expect(by(ended.id).late_entry_window_open, "…with no late-entry window").toBeFalsy();
      expect(by(comp.id).status, "`comp` is live").toBe("live");
      expect(by(comp.id).competing, "multi COMPETES in `comp`").toBe(true);
      for (const c of [live2, up, late, ended]) expect(by(c.id).competing, `…and not in ${c.name}`).toBe(false);
    }
    {
      const { rows, by } = await ownRows(oneOfTwo.email);
      expect(sortIds(rows.map(r => r.id)), "oneOfTwo sees solo and comp2").toEqual(sortIds([solo.id, comp2.id]));
      expect(by(solo.id).status).toBe("live");
      expect(by(solo.id).competing, "oneOfTwo does not compete in `solo`").toBe(false);
      expect(by(comp2.id).status).toBe("live");
      expect(by(comp2.id).competing, "…and COMPETES in `comp2`").toBe(true);
    }
    {
      const { rows, by } = await ownRows(competesOnly.email);
      expect(sortIds(rows.map(r => r.id)), "competesOnly sees comp3 and ended3").toEqual(sortIds([comp3.id, ended3.id]));
      expect(by(comp3.id).status).toBe("live");
      expect(by(comp3.id).competing, "competesOnly COMPETES in `comp3`").toBe(true);
      expect(by(ended3.id).status, "`ended3` has ended").toBe("ended");
      expect(by(ended3.id).late_entry_window_open).toBeFalsy();
    }
    {
      const { me, rows, by } = await ownRows(many.email);
      expect(me.isEventAdmin, "many holds the tier").toBe(true);
      expect(sortIds(rows.map(r => r.id)), "many sees exactly its four events")
        .toEqual(sortIds([many1.id, many2.id, many3.id, many4.id]));
      for (const c of [many1, many2, many3, many4]) {
        expect(by(c.id).status, `${c.name} is live`).toBe("live");
        expect(by(c.id).competing, `many COMPETES in ${c.name}`).toBe(true);
      }
    }
    {
      const { me, rows } = await ownRows(ga.email);
      expect(me.isEventAdmin, "the global control is NOT an event admin").toBeFalsy();
      expect(rows.some(r => r.id === world.mine.id), "…and sees `mine` among every event").toBe(true);
      expect(rows.length, "…among SEVERAL events, so the one-event control below is built, not found").toBeGreaterThan(1);
      expect(rows.some(r => r.competing), "…and competes nowhere").toBe(false);
    }

    // ── a group world.ea created, and so may write (offered by the dialog) ───
    {
      const l = await apiLogin(world.ea.email, PARTICIPANT_PASS);
      try {
        const name = `Inv Group ${uniq("g")}`;
        const r = await l.api.post(GROUPS_PATH, { headers: H(l.csrf), data: { name } });
        expect(r.ok(), `world.ea creates a group: ${r.status()} ${await r.text()}`).toBeTruthy();
        const d = await r.json();
        eaGroup = { id: d.id || d.group?.id, name: d.name || d.group?.name || name };
        expect(eaGroup.id, "the group create returned an id").toBeTruthy();
        const list = await (await l.api.get(GROUPS_PATH)).json();
        const row = (Array.isArray(list) ? list : []).find(g => g.id === eaGroup.id);
        expect(row, "world.ea sees the group it created").toBeTruthy();
        expect(row.can_write, "…and may write it, so the invite dialog offers it").toBe(true);
      } finally { await l.api.dispose(); }
    }
  });

  test.afterAll(async () => {
    for (const ctx of [world?.eaApi, world?.zeroApi, world?.sa]) await ctx?.dispose?.().catch(() => {});
  });

  // ── ONE tickable event ──────────────────────────────────────────────────────

  test("U1 — an event admin with ONE event: it is ticked and LOCKED, says why, cannot be unticked, is not dimmed, and IS sent", async ({ page }) => {
    const me = await panel(page, world.ea.email);
    expect(me.isEventAdmin, "precondition: the event-admin tier").toBe(true);
    expect(await page.evaluate(() => window.S.adminSelectedCompetitionId), "precondition: no event is focused").toBeNull();
    const posts = recordInvitePosts(page);
    const overlay = await openInvite(page);

    await expect(overlay, "the dialog is marked as requiring an event").toHaveAttribute("data-require-event", "1");
    await expect(assignLabel(overlay), "the field is marked required").toHaveText("Assign to Events *");
    const list = listOf(overlay);
    await expect(list, "the event list is a labelled group").toHaveAttribute("role", "group");
    await expect(list, "U1: …named by the field's label").toHaveAccessibleName("Assign to Events *");
    await expect(list, "U1: its only box is locked, so the list is a tab stop of its own").toHaveAttribute("tabindex", "0");
    await expect(cardOf(overlay), "U1: a sendable dialog is not described by a refusal").not.toHaveAttribute("aria-describedby", /.*/);
    const row = rowOf(overlay, world.mine), box = boxOf(overlay, world.mine);
    await expect(row, "`mine` is listed").toHaveCount(1);
    await expect(row, "U1: the only event's row is LOCKED").toHaveClass(/\bis-locked\b/);
    await expect(row, "LOCKED is not DISABLED (an inactive row)").not.toHaveClass(/\bis-disabled\b/);
    await expect(box, "the only event is ticked…").toBeChecked();
    await expect(box, "…and cannot be unticked").toBeDisabled();
    await expect(box).toHaveAttribute("aria-describedby", "invite-comp-locked-note");
    await expect(row.locator(".picker-row-flag.is-on"), "the row says it is always included").toHaveText("Always included");
    await expect(overlay.locator("#invite-comp-locked-note"), "the reason is under the list").toBeVisible();
    await expect(overlay.locator("#invite-comp-locked-note"), "U1: the locked note says why").toHaveText(LOCKED_NOTE);
    await expect(overlay.locator("#invite-comp-required-note"), "not the several-events note").toHaveCount(0);
    await expect(overlay.locator("#invite-comp-none"), "U1: no 'cannot invite' refusal").toHaveCount(0);
    await expect(boxOf(overlay, world.theirs), "the decoy event is not offered").toHaveCount(0);
    await expect(overlay.locator("input.invite-comp-cb"), "exactly one event is offered").toHaveCount(1);
    await expect(overlay.locator("#invite-submit-btn"), "Send is enabled").toBeEnabled();

    // Try to untick it, both ways a user could: the box itself, and the label text.
    await box.evaluate(el => /** @type {HTMLInputElement} */ (el).click());
    expect(await box.evaluate(el => /** @type {HTMLInputElement} */ (el).checked), "a click on the box does not untick it").toBe(true);
    await row.locator("strong").click({ force: true });
    expect(await box.evaluate(el => /** @type {HTMLInputElement} */ (el).checked), "a click on the label does not untick it").toBe(true);

    // Not dimmed, and not marked inactive: the locked row and its box at full
    // strength, with a solid edge (U3 measures this beside a faded box).
    await drainAnimations(page, "#invite-overlay");
    const m = await rowMarking(row);
    expect({ row: m.opacity, box: m.boxOpacity }, "the locked row and its box are at full strength").toEqual({ row: "1", box: "1" });
    expect(m.borderTopStyle, "U1: the locked row's edge is solid, not the inactive dash").toBe("solid");

    // The locked (disabled) tick is SENT: `:checked` matches a disabled box.
    const email = `inv-${uniq("u1")}@acme.com`.toLowerCase();
    await overlay.locator("#invite-emails").fill(email);
    const respP = page.waitForResponse(isInviteResponse, { timeout: 20000 });
    await overlay.locator("#invite-submit-btn").click();
    const resp = await respP;
    const body = await resp.json();
    expect(resp.status(), `the invitation was accepted: ${JSON.stringify(body)}`).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.invited, "one invitation was created").toBe(1);
    expect(posts.length, "exactly one request").toBe(1);
    expect(posts[0].competitionIds, "it names the locked event").toEqual([world.mine.id]);
    expect(posts[0].emails).toEqual([email]);
  });

  test("U1 CONTROL — a GLOBAL admin in the SAME one-event state sees it unlocked and unticked, makes no fresh read, and may send with nothing ticked", async ({ page }) => {
    const me = await panel(page, ga.email);
    expect(me.isEventAdmin, "precondition: NOT an event admin").toBeFalsy();
    await awaitCompModel(page);   // the global tier's dialog reads the cached model
    await clickTab(page, "Participants");
    expect(await page.evaluate(() => window.S.adminSelectedCompetitionId), "precondition: no event is focused").toBeNull();
    // Every GET of the list from here on is one the open caused: the poll is
    // stopped, and the route refuses the read, so a dialog that DID fetch would
    // also fail to open.
    await stopCompPoll(page);
    /** @type {string[]} */ const compGets = [];
    const onReq = req => {
      if (req.method() === "GET" && new URL(req.url()).pathname === COMPS_PATH) compGets.push(req.url());
    };
    page.on("request", onReq);
    const abortComps = route => route.abort();
    await page.route(COMPS_RE, abortComps);

    // ONE evaluate: narrow the cached model to `mine` through the namespace setter,
    // read it back, and click Invite. The global path renders synchronously, so
    // nothing can refill the model between the narrowing and the render.
    const opened = await page.evaluate((mineId) => {
      window.adminCompetitionsData = window.adminCompetitionsData.filter(c => c.id === mineId);
      const ids = window.S.adminCompetitionsData.map(c => c.id);
      document.getElementById("invite-participants-btn").click();
      return { ids, renderedSynchronously: !!document.getElementById("invite-overlay") };
    }, world.mine.id);
    expect(opened.ids, "precondition: the cached model holds exactly `mine`").toEqual([world.mine.id]);
    const overlay = page.locator("#invite-overlay");
    await expect(overlay, "GA: the dialog opened").toBeVisible({ timeout: 15000 });
    await expect(overlay).toHaveCount(1);
    expect(opened.renderedSynchronously, "GA: the global tier renders from the cached model, awaiting nothing").toBe(true);
    expect(compGets, "GA: the open made ZERO reads of the competitions list").toEqual([]);
    await page.unroute(COMPS_RE, abortComps);
    page.off("request", onReq);

    await expect(overlay, "the dialog is NOT marked as requiring an event").not.toHaveAttribute("data-require-event", /.*/);
    await expect(assignLabel(overlay), "the field is not marked required").toHaveText("Assign to Events");
    const row = rowOf(overlay, world.mine), box = boxOf(overlay, world.mine);
    await expect(overlay.locator("input.invite-comp-cb"), "GA: exactly one event is offered, as for U1").toHaveCount(1);
    await expect(row, "`mine` is listed for the global admin too").toHaveCount(1);
    await expect(row, "GA: `mine` is NOT locked for a global admin").not.toHaveClass(/\bis-locked\b/);
    await expect(row, "GA: …nor inactive").not.toHaveClass(/\bis-disabled\b/);
    await expect(box, "GA: …enabled").toBeEnabled();
    await expect(box, "GA: …and not ticked").not.toBeChecked();
    await expect(row.locator(".picker-row-flag"), "GA: …with no flag").toHaveCount(0);
    await expect(overlay.locator(".is-locked"), "nothing is locked anywhere").toHaveCount(0);
    await expect(overlay.locator("#invite-comp-locked-note"), "GA: no locked note").toHaveCount(0);
    await expect(overlay.locator("#invite-comp-required-note"), "GA: no required note").toHaveCount(0);
    await expect(overlay.locator("#invite-comp-none"), "GA: no none note").toHaveCount(0);
    await expect(listOf(overlay), "GA: its box is enabled, so the list is no tab stop").not.toHaveAttribute("tabindex", /.*/);
    await expect(cardOf(overlay), "GA: the dialog has no refusal for a description").not.toHaveAttribute("aria-describedby", /.*/);
    expect(await overlay.locator("input.invite-comp-cb:checked").count(), "nothing is ticked").toBe(0);

    /** @type {any[]} */ const posts = [];
    const fulfilInvite = route => {
      if (route.request().method() !== "POST") return route.continue();
      posts.push(route.request().postDataJSON());
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          ok: true, invited: 1, assigned: 0, emailsSent: 1, resent: 0, errors: [], existingEmails: [],
          alreadyInvited: [], alreadyAssigned: [], undeliveredInvites: [], unsubscribedInvites: [],
        }),
      });
    };
    await page.route("**/api/admin/invitations", fulfilInvite);
    await overlay.locator("#invite-emails").fill(`inv-${uniq("ga")}@acme.com`.toLowerCase());
    const reqP = page.waitForRequest(r => r.method() === "POST" && new URL(r.url()).pathname === "/api/admin/invitations", { timeout: 15000 });
    await overlay.locator("#invite-submit-btn").click();
    await reqP;
    await expect(overlay.locator("#invite-error"), "no refusal for the global tier").toBeHidden();
    expect(posts.length, "the global admin's send with no event DID post").toBe(1);
    expect(posts[0].competitionIds, "…naming no event").toEqual([]);
    await page.unroute("**/api/admin/invitations", fulfilInvite);
  });

  // ── TWO OR MORE tickable events ─────────────────────────────────────────────

  test("U2 — an event admin with SEVERAL events: nothing locked, a note asks for one, an empty Send is refused in the dialog, a ticked one is sent", async ({ page }) => {
    const me = await panel(page, multi.email);
    expect(me.isEventAdmin).toBe(true);
    expect(await page.evaluate(() => window.S.adminSelectedCompetitionId), "precondition: no event is focused").toBeNull();
    const posts = recordInvitePosts(page);
    const overlay = await openInvite(page);

    await expect(overlay).toHaveAttribute("data-require-event", "1");
    await expect(assignLabel(overlay)).toHaveText("Assign to Events *");
    const offered = await overlay.locator("input.invite-comp-cb").evaluateAll(els => els.map(e => /** @type {HTMLInputElement} */ (e).value));
    expect([...offered].sort(), "live, upcoming, late-entry and the competing event are listed; the ended one is not")
      .toEqual([live2.id, up.id, late.id, comp.id].sort());
    await expect(boxOf(overlay, ended), "the ended event is NOT listed").toHaveCount(0);
    await expect(rowOf(overlay, late).locator(".status-badge"), "the late-entry event says so").toHaveText("Late entry open");
    await expect(boxOf(overlay, late)).toHaveAttribute("data-late-entry", "1");
    await expect(boxOf(overlay, live2), "CONTROL: a live one is not marked late").toHaveAttribute("data-late-entry", "");

    const cRow = rowOf(overlay, comp), cBox = boxOf(overlay, comp);
    await expect(cRow, "U2: the competing row is INACTIVE").toHaveClass(/\bis-disabled\b/);
    await expect(cRow, "U2: …not locked").not.toHaveClass(/\bis-locked\b/);
    await expect(cBox, "the competing event is disabled…").toBeDisabled();
    await expect(cBox, "…and unticked").not.toBeChecked();
    await expect(cRow.locator(".picker-row-flag"), "…with its reason").toHaveText("You compete here");

    await expect(overlay.locator(".is-locked"), "with several to choose from nothing is locked").toHaveCount(0);
    for (const c of [live2, up, late]) {
      await expect(boxOf(overlay, c), `${c.name} is offered`).toBeEnabled();
      await expect(boxOf(overlay, c), `${c.name} is not pre-ticked`).not.toBeChecked();
    }
    await expect(overlay.locator("#invite-comp-required-note"), "the note says one must be ticked").toBeVisible();
    await expect(overlay.locator("#invite-comp-required-note"), "U2: the required note's text").toHaveText(REQUIRED_NOTE);
    await expect(overlay.locator("#invite-comp-locked-note"), "U2: no locked note").toHaveCount(0);
    await expect(overlay.locator("#invite-comp-none"), "U2: no none note").toHaveCount(0);
    await expect(overlay.locator("#invite-submit-btn"), "Send is enabled").toBeEnabled();
    // CONTROL for U1/U4's attributes: enabled boxes are reachable, so the list is
    // no tab stop of its own, and a sendable dialog has no refusal to describe it.
    await expect(listOf(overlay), "U2 CONTROL: with enabled boxes the list is NO tab stop").not.toHaveAttribute("tabindex", /.*/);
    await expect(cardOf(overlay), "U2 CONTROL: …and the dialog is not described by a refusal").not.toHaveAttribute("aria-describedby", /.*/);

    // The rows are picker rows, not form labels: the `.form-group label` rule
    // used to stack every box ABOVE its name (same left edge) and mute every
    // row, so muted text marked nothing. Geometry, not markup: the box sits to
    // the LEFT of the name, centred within the row's text block (name line plus
    // date line, as in the bulk Assign dialog); and an enabled row's text is not
    // the muted token while the competing row's is (one cascade each).
    for (const c of [live2, comp]) {
      const geo = await rowOf(overlay, c).evaluate(el => {
        const b = /** @type {Element} */ (el.querySelector("input.invite-comp-cb")).getBoundingClientRect();
        const n = /** @type {Element} */ (el.querySelector("strong")).getBoundingClientRect();
        const t = /** @type {Element} */ (el.querySelector(".picker-row-body")).getBoundingClientRect();
        return { boxRight: b.right, boxMid: (b.top + b.bottom) / 2, nameLeft: n.left, bodyTop: t.top, bodyBottom: t.bottom };
      });
      const seen = JSON.stringify(geo);
      expect(geo.boxRight, `U2: ${c.name}'s box sits to the LEFT of its name, not above it (${seen})`).toBeLessThanOrEqual(geo.nameLeft);
      expect(geo.boxMid, `U2: …beside the row's text, not above it (${seen})`).toBeGreaterThanOrEqual(geo.bodyTop);
      expect(geo.boxMid, `U2: …nor below it (${seen})`).toBeLessThanOrEqual(geo.bodyBottom);
    }
    const enabledMark = await rowMarking(rowOf(overlay, live2));
    expect(enabledMark.color, `U2: an ENABLED row's text is not muted (${JSON.stringify(enabledMark)})`).not.toBe(enabledMark.muted);
    const inactiveMark = await rowMarking(cRow);
    expect(inactiveMark.color, `U2 CONTROL: the competing row's text IS muted (${JSON.stringify(inactiveMark)})`).toBe(inactiveMark.muted);

    // Send with nothing ticked: refused in the dialog, with no request.
    const email = `inv-${uniq("u2")}@acme.com`.toLowerCase();
    await overlay.locator("#invite-emails").fill(email);
    await overlay.locator("#invite-submit-btn").click();
    const err = overlay.locator("#invite-error");
    await expect(err, "the refusal is shown").toBeVisible();
    await expect(err, "U2: the empty-pick refusal names the rule").toHaveText(REQUIRED_ERR);
    await expect(err).toHaveAttribute("role", "alert");
    expect(posts.length, "an empty pick sent NO request").toBe(0);

    // POSITIVE CONTROL: tick one, and it is sent.
    await boxOf(overlay, up).check();
    const respP = page.waitForResponse(isInviteResponse, { timeout: 20000 });
    await overlay.locator("#invite-submit-btn").click();
    const resp = await respP;
    const body = await resp.json();
    expect(resp.status(), `the invitation was accepted: ${JSON.stringify(body)}`).toBe(200);
    expect(body.invited).toBe(1);
    expect(posts.length, "exactly one request, the ticked one").toBe(1);
    expect(posts[0].competitionIds, "naming only the ticked event").toEqual([up.id]);
  });

  test("U2 FOCUS — with several events the FOCUSED one is pre-ticked but stays untickable: a pre-tick is not a lock", async ({ page }) => {
    await panel(page, multi.email);
    await clickTab(page, "Events");
    await viewComp(page, live2.name);
    expect(await page.evaluate(() => window.S.adminSelectedCompetitionId), "precondition: live2 is focused").toBe(live2.id);
    const overlay = await openInvite(page);
    const box = boxOf(overlay, live2);
    await expect(box, "the focused event is pre-ticked…").toBeChecked();
    await expect(box, "…and still enabled").toBeEnabled();
    await expect(rowOf(overlay, live2), "U2 FOCUS: the focused row is not locked").not.toHaveClass(/\bis-locked\b/);
    await expect(overlay.locator(".is-locked"), "U2 FOCUS: nothing is locked").toHaveCount(0);
    await expect(boxOf(overlay, up), "CONTROL: an unfocused event is not pre-ticked").not.toBeChecked();
    await expect(overlay.locator("#invite-comp-required-note")).toBeVisible();
    await box.uncheck();
    await expect(box, "it can be unticked").not.toBeChecked();
    await box.check();
    await expect(box, "…and ticked again").toBeChecked();
  });

  // ── ONE tickable beside a competing one ─────────────────────────────────────

  test("U3 — an event the actor COMPETES in does not count toward 'only one': the other is locked, the competing one inactive (dashed, muted, readable) and unsent", async ({ page }) => {
    await panel(page, oneOfTwo.email);
    const posts = recordInvitePosts(page);
    const overlay = await openInvite(page);

    await expect(overlay).toHaveAttribute("data-require-event", "1");
    const sRow = rowOf(overlay, solo), sBox = boxOf(overlay, solo);
    await expect(sRow, "U3: `solo` is LOCKED though a competing event is listed beside it").toHaveClass(/\bis-locked\b/);
    await expect(sRow, "U3: …and not inactive").not.toHaveClass(/\bis-disabled\b/);
    await expect(sBox, "the only tickable event is ticked…").toBeChecked();
    await expect(sBox, "…and locked").toBeDisabled();
    await expect(sRow.locator(".picker-row-flag.is-on")).toHaveText("Always included");
    await expect(overlay.locator("#invite-comp-locked-note"), "U3: the locked note").toHaveText(LOCKED_NOTE);
    await expect(overlay.locator("#invite-comp-required-note"), "U3: no required note").toHaveCount(0);
    await expect(listOf(overlay), "U3: no box is reachable (one locked, one competing), so the list is a tab stop")
      .toHaveAttribute("tabindex", "0");

    const cRow = rowOf(overlay, comp2), cBox = boxOf(overlay, comp2);
    await expect(cRow, "U3: the competing row is INACTIVE").toHaveClass(/\bis-disabled\b/);
    await expect(cRow, "U3: …and not locked").not.toHaveClass(/\bis-locked\b/);
    await expect(cBox, "U3: its box is disabled").toBeDisabled();
    await expect(cBox, "the competing event is never ticked").not.toBeChecked();
    await expect(cRow.locator(".picker-row-flag")).toHaveText("You compete here");

    const send = overlay.locator("#invite-submit-btn");
    await expect(send, "Send is enabled").toBeEnabled();
    expect(await send.getAttribute("aria-describedby"), "…and points at no refusal").toBeNull();
    await expect(overlay.locator("#invite-comp-none"), "U3: no none note").toHaveCount(0);

    // HOW the two rows are marked, in each theme. The competing row is INACTIVE:
    // full strength, muted text, dashed edge — and its BOX is faded, which is the
    // control that makes the locked box's "1" mean something. The locked row is
    // neither faded, dashed nor muted: colour tells the two rows apart too.
    await drainAnimations(page, "#invite-overlay");
    expect(await themeOf(page), "precondition: the test default is the light theme").toBe("light");
    const cName = cRow.locator("strong");
    const cFlag = cRow.locator(".picker-row-flag");
    const sFlag = sRow.locator(".picker-row-flag.is-on");
    /** @type {Record<string, string>} */ const mutedBy = {};
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") await toTheme(page, "dark");
      const cm = await rowMarking(cRow), sm = await rowMarking(sRow);
      mutedBy[theme] = cm.muted;
      expect(cm.opacity, `U3 ${theme}: the competing row is at FULL strength, not the global .5 fade`).toBe("1");
      expect(cm.color, `U3 ${theme}: …its text is the muted token`).toBe(cm.muted);
      expect(cm.borderTopStyle, `U3 ${theme}: …its edge is dashed (top)`).toBe("dashed");
      expect(cm.borderLeftStyle, `U3 ${theme}: …and dashed (left)`).toBe("dashed");
      expect(cm.boxOpacity, `CONTROL ${theme}: the competing row's BOX is faded, as a disabled control is`).toBe("0.5");
      expect(sm.opacity, `U3 ${theme}: the locked row is at full strength`).toBe("1");
      expect(sm.boxOpacity, `U3 ${theme}: …and its box is lifted out of the fade`).toBe("1");
      expect(sm.borderTopStyle, `U3 ${theme}: the locked row is NOT marked inactive: a solid edge`).toBe("solid");
      expect(sm.borderLeftStyle, `U3 ${theme}: …solid on every side`).toBe("solid");
      expect(sm.color, `U3 ${theme}: …and its text is NOT the muted token (${JSON.stringify(sm)})`).not.toBe(sm.muted);
      for (const [what, loc] of [["the competing row's name", cName], ["its 'You compete here' flag", cFlag], ["the locked row's 'Always included' flag", sFlag]]) {
        const c = await textContrast(/** @type {any} */ (loc));
        expect(c.ratio, `U3 ${theme}: ${what} reads at AA (4.5:1) against what is really behind it: ${JSON.stringify(c)}`)
          .toBeGreaterThanOrEqual(4.5);
      }
      if (theme === "light") {
        // CONTROL for the instrument: the old 50% fade, put back on the row by
        // hand, IS seen — so a passing ratio above is about the marking, not a
        // helper that ignores opacity.
        const full = await textContrast(cName);
        await cRow.evaluate(el => { /** @type {HTMLElement} */ (el).style.opacity = "0.5"; });
        const faded = await textContrast(cName);
        await cRow.evaluate(el => { /** @type {HTMLElement} */ (el).style.opacity = ""; });
        expect(faded.opacity, "CONTROL: the helper folds the row's opacity into its text").toBe(0.5);
        expect(faded.ratio, `CONTROL: …so the old fade WOULD read below AA (${JSON.stringify({ full, faded })})`).toBeLessThan(4.5);
        // …and a fade on a container ABOVE the row's opaque background (the
        // dialog card) is counted too, not only one at or below it.
        const card = overlay.locator(".invite-card");
        await card.evaluate(el => { /** @type {HTMLElement} */ (el).style.opacity = "0.5"; });
        const cardFaded = await textContrast(cName);
        await card.evaluate(el => { /** @type {HTMLElement} */ (el).style.opacity = ""; });
        expect(cardFaded.opacity, `CONTROL: the helper counts a fade above the opaque row background (${JSON.stringify(cardFaded)})`).toBe(0.5);
      }
    }
    expect(mutedBy.dark, "CONTROL: the dark reading is a different palette (the theme really flipped)").not.toBe(mutedBy.light);

    const email = `inv-${uniq("u3")}@acme.com`.toLowerCase();
    await overlay.locator("#invite-emails").fill(email);
    const respP = page.waitForResponse(isInviteResponse, { timeout: 20000 });
    await send.click();
    const resp = await respP;
    const body = await resp.json();
    expect(resp.status(), `accepted: ${JSON.stringify(body)}`).toBe(200);
    expect(body.invited).toBe(1);
    expect(posts.length).toBe(1);
    expect(posts[0].competitionIds, "only the locked event is sent, never the competing one").toEqual([solo.id]);
  });

  // ── NONE tickable ───────────────────────────────────────────────────────────

  test("U4 — an event admin with NO open event: no boxes, the reason where the choice would be, Send disabled and pointing at it, and a stray submit refused", async ({ page }) => {
    const me = await panel(page, world.zero.email);
    expect(me.isEventAdmin).toBe(true);
    expect(me.eventAdminCompetitionCount, "precondition: no events").toBe(0);
    const posts = recordInvitePosts(page);
    const overlay = await openInvite(page);

    await expect(overlay).toHaveAttribute("data-require-event", "1");
    await expect(overlay.locator(".invite-comp-cb"), "no event to tick").toHaveCount(0);
    const none = overlay.locator(".invite-comp-list #invite-comp-none");
    await expect(none, "U4: with no event listed, the reason is INSIDE the event list").toBeVisible();
    await expect(none, "U4: the none note says there is no open event").toHaveText(NONE_NO_EVENTS);
    await expect(overlay.locator("#invite-comp-none"), "…and only there").toHaveCount(1);
    await expect(overlay.locator("#invite-comp-locked-note"), "U4: no locked note").toHaveCount(0);
    await expect(overlay.locator("#invite-comp-required-note"), "U4: no required note").toHaveCount(0);
    await expect(cardOf(overlay), "U4: the reason is also the dialog's description").toHaveAttribute("aria-describedby", "invite-comp-none");
    const send = overlay.locator("#invite-submit-btn");
    await expect(send, "Send is disabled").toBeDisabled();
    await expect(send, "…and points at the reason").toHaveAttribute("aria-describedby", "invite-comp-none");

    // A stray dispatch. Chromium DOES deliver a synthetic click on a disabled
    // button to the document-level dispatcher (measured), so `disabled` alone is
    // not the guard: the refusal in submitInvitations is. Then the handler itself
    // (boot() exposes it on window). Neither may send. An address is filled first,
    // so the refusal seen is the event one and not "enter an email".
    await overlay.locator("#invite-emails").fill(`inv-${uniq("u4")}@acme.com`.toLowerCase());
    const err = overlay.locator("#invite-error");
    await page.evaluate(() => document.querySelector("#invite-submit-btn").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await expect(err, "the dispatched click is refused, visibly").toBeVisible();
    await expect(err, "…naming the reason").toHaveText(NONE_NO_EVENTS);
    expect(posts.length, "the dispatched click sent no request").toBe(0);
    await page.evaluate(() => { const e = document.getElementById("invite-error"); e.textContent = ""; e.style.display = "none"; });
    await expect(err, "precondition: the refusal was cleared").toBeHidden();
    expect(await page.evaluate(() => typeof window.submitInvitations), "precondition: the handler is reachable").toBe("function");
    await page.evaluate(() => window.submitInvitations());
    await expect(err, "the handler called directly refuses too").toBeVisible();
    await expect(err, "U4: the direct call's refusal names the reason").toHaveText(NONE_NO_EVENTS);
    expect(posts.length, "no request left the browser").toBe(0);
  });

  test("U4 COMPETES-ONLY — when every open event is one they compete in, it is listed inactive and the reason, UNDER the list, says THAT", async ({ page }) => {
    await panel(page, competesOnly.email);
    const posts = recordInvitePosts(page);
    const overlay = await openInvite(page);

    const cRow = rowOf(overlay, comp3), cBox = boxOf(overlay, comp3);
    await expect(cRow, "the competing event is listed").toHaveCount(1);
    await expect(cRow, "U4c: the competing row is INACTIVE").toHaveClass(/\bis-disabled\b/);
    await expect(cRow, "U4c: …and NOT locked (a competing event is never the 'only one')").not.toHaveClass(/\bis-locked\b/);
    await expect(cBox, "U4c: its box is disabled").toBeDisabled();
    await expect(cBox, "U4c: …and unticked").not.toBeChecked();
    await expect(cRow.locator(".picker-row-flag")).toHaveText("You compete here");
    await expect(boxOf(overlay, ended3), "the ended event is not listed").toHaveCount(0);
    await expect(overlay.locator("input.invite-comp-cb"), "only the competing event").toHaveCount(1);
    await expect(overlay.locator(".invite-comp-list:has(label.picker-row) + #invite-comp-none"),
      "U4c: the reason is the next sibling of the list holding the row it explains").toHaveCount(1);
    await expect(overlay.locator(".invite-comp-list #invite-comp-none"),
      "U4c: …and NOT inside the scroller, where rows could push it out of sight").toHaveCount(0);
    await expect(overlay.locator("#invite-comp-none"), "U4c: the none note says they compete in every one").toHaveText(NONE_COMPETES);
    await expect(cardOf(overlay), "U4c: the reason is also the dialog's description").toHaveAttribute("aria-describedby", "invite-comp-none");
    await expect(listOf(overlay), "U4c: the list holds no enabled box, so it is a tab stop").toHaveAttribute("tabindex", "0");
    const send = overlay.locator("#invite-submit-btn");
    await expect(send, "U4c: Send is disabled").toBeDisabled();
    await expect(send, "U4c: …pointing at the reason").toHaveAttribute("aria-describedby", "invite-comp-none");

    await overlay.locator("#invite-emails").fill(`inv-${uniq("u4c")}@acme.com`.toLowerCase());
    await page.evaluate(() => window.submitInvitations());
    await expect(overlay.locator("#invite-error"), "U4c: the direct call is refused with the reason").toHaveText(NONE_COMPETES);
    expect(posts.length, "no request left the browser").toBe(0);
  });

  test("U4 MANY — competing in FOUR open events: at desktop and phone width the reason stays in sight below the scroller, the list is a keyboard stop, axe is clean", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await panel(page, many.email);
    const posts = recordInvitePosts(page);
    let first = true;
    for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const at = `${vp.width}x${vp.height}`;
      await page.setViewportSize(vp);
      const overlay = await openInvite(page, { tab: first });
      first = false;
      await drainAnimations(page, "#invite-overlay");

      for (const c of [many1, many2, many3, many4]) {
        await expect(rowOf(overlay, c), `${at}: ${c.name} is listed INACTIVE`).toHaveClass(/\bis-disabled\b/);
        await expect(boxOf(overlay, c), `${at}: …its box disabled`).toBeDisabled();
      }
      await expect(overlay.locator("input.invite-comp-cb"), `${at}: the four competing events, and nothing else`).toHaveCount(4);
      await expect(overlay.locator("input.invite-comp-cb:enabled"), `${at}: no box can be ticked`).toHaveCount(0);
      const none = overlay.locator("#invite-comp-none");
      await expect(none, `${at}: the reason says they compete in every one`).toHaveText(NONE_COMPETES);
      await expect(overlay.locator(".invite-comp-list #invite-comp-none"), `U4 MANY ${at}: the reason is NOT inside the scroller`).toHaveCount(0);
      await expect(overlay.locator(".invite-comp-list + #invite-comp-none"), `${at}: …it is the list's next sibling`).toHaveCount(1);
      const send = overlay.locator("#invite-submit-btn");
      await expect(send, `${at}: Send is disabled`).toBeDisabled();
      await expect(send, `${at}: …pointing at the reason`).toHaveAttribute("aria-describedby", "invite-comp-none");
      await expect(cardOf(overlay), `${at}: the dialog is described by the reason`).toHaveAttribute("aria-describedby", "invite-comp-none");
      const list = listOf(overlay);
      await expect(list, `U4 MANY ${at}: the list is a tab stop`).toHaveAttribute("tabindex", "0");

      // GEOMETRY, in one read: the reason lies wholly inside the viewport and
      // wholly below the scroller's box.
      const geo = await page.evaluate(() => {
        const r = el => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
        const l = /** @type {HTMLElement} */ (document.querySelector("#invite-overlay .invite-comp-list"));
        return {
          none: r(document.getElementById("invite-comp-none")), list: r(l),
          scrollH: l.scrollHeight, clientH: l.clientHeight,
          vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight,
        };
      });
      const inView = geo.none.top >= 0 && geo.none.left >= 0 && geo.none.bottom <= geo.vh && geo.none.right <= geo.vw;
      expect(inView, `U4 MANY ${at}: the reason lies fully inside the viewport: ${JSON.stringify(geo)}`).toBe(true);
      expect(geo.none.bottom - geo.none.top, `${at}: …and has a real box`).toBeGreaterThan(10);
      expect(geo.none.top, `U4 MANY ${at}: …below the scroller's box, not under it`).toBeGreaterThanOrEqual(geo.list.bottom - 0.5);

      // KEYBOARD: from the address box, Tab reaches the list (its boxes are all
      // disabled, so without its own tab stop nothing in it is reachable). The
      // field's "?" tip is the one stop in between, and it must be exactly that.
      await overlay.locator("#invite-emails").focus();
      expect(await page.evaluate(() => document.activeElement?.id), `precondition ${at}: focus is in the address box`).toBe("invite-emails");
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("#invite-overlay .help-label-row .help-tip, #invite-overlay .help-label-row [data-action='help-tip']")),
        `U4 MANY ${at}: the first stop after the address box is the field's ? tip`).toBe(true);
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.matches("#invite-overlay .invite-comp-list")),
        `U4 MANY ${at}: Tab from the address box reaches the event list`).toBe(true);

      // AXE. Four rows overflow the 200px scroller at both widths by more than
      // the 13px axe ignores as rounding (its `getScroll` buffer) — asserted, so
      // scrollable-region-focusable really applies to the list: it was EVALUATED
      // and passed, and without its tab stop it IS flagged (the control that the
      // pass is not vacuous).
      expect(geo.scrollH - geo.clientH, `precondition ${at}: four rows overflow the scroller by more than axe's 13px buffer (${JSON.stringify(geo)})`)
        .toBeGreaterThan(13);
      await axeClean(page, `invite dialog, competes in four, ${at}`);
      const sr = await scrollRule(page);
      expect(sr.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`),
        `U4 MANY ${at}: no scrollable-region-focusable violation`).toEqual([]);
      expect(namesList(sr.passes), `${at}: the rule evaluated the scrolling list and it passed`).toBe(true);
      await list.evaluate(el => el.removeAttribute("tabindex"));
      const bare = await scrollRule(page);
      await list.evaluate(el => el.setAttribute("tabindex", "0"));
      expect(namesList(bare.violations), `CONTROL ${at}: without its tab stop the scrolling list IS flagged`).toBe(true);

      await overlay.locator('[data-action="overlay-close"]').click();
      await expect(page.locator("#invite-overlay"), `${at}: the dialog closed`).toHaveCount(0);
    }
    expect(posts.length, "no request left the browser").toBe(0);
  });

  // ── the list is read FRESH ──────────────────────────────────────────────────

  test("U5 — an event admin's list is read fresh: an EMPTY cached model still offers (and locks) their event", async ({ page }) => {
    await panel(page, world.ea.email);
    await awaitCompModel(page);
    await clickTab(page, "Participants");
    await page.evaluate(() => { window.adminCompetitionsData = []; });
    expect(await page.evaluate(() => window.S.adminCompetitionsData.length),
      "precondition: the cached model really is empty (through the namespace setter)").toBe(0);
    const reqP = page.waitForRequest(r => r.method() === "GET" && new URL(r.url()).pathname === COMPS_PATH, { timeout: 15000 });
    const overlay = await openInvite(page, { tab: false });
    await reqP;
    await expect(rowOf(overlay, world.mine), "`mine` is still listed").toHaveCount(1);
    await expect(rowOf(overlay, world.mine), "U5: …and locked").toHaveClass(/\bis-locked\b/);
    await expect(boxOf(overlay, world.mine), "U5: …and ticked").toBeChecked();
    await expect(overlay.locator("#invite-comp-none"), "not the 'cannot invite anybody' refusal").toHaveCount(0);
  });

  test("U5 FAILURE — a failed read of the list opens NO dialog and says so; once it loads, the dialog opens (CONTROL)", async ({ page }) => {
    await panel(page, world.ea.email);
    await clickTab(page, "Participants");
    await page.route("**/api/admin/competitions", r => r.abort());
    await page.locator("#invite-participants-btn").click();
    await expect(page.locator("#toast-stack"), "the failure is spoken").toContainText(LOAD_FAIL, { timeout: 15000 });
    await expect(page.locator("#invite-overlay"), "…and no dialog opened").toHaveCount(0);
    await page.unroute("**/api/admin/competitions");
    const overlay = await openInvite(page, { tab: false });
    await expect(rowOf(overlay, world.mine), "U5 FAILURE CONTROL: once the list loads, the dialog shows the locked event").toHaveClass(/\bis-locked\b/);
  });

  // ── a superseded open ───────────────────────────────────────────────────────

  test("U7 SUPERSEDED OPEN — a slow first read that lands after a second open has rendered opens nothing: one dialog, the typed text kept", async ({ page }) => {
    await countJsonParses(page);
    await panel(page, world.ea.email);
    await clickTab(page, "Participants");
    await stopCompPoll(page);
    const base = await parsedCount(page, COMPS_PATH);
    const hold = holdFirstGet();
    await page.route(COMPS_RE, hold.handler);

    const btn = page.locator("#invite-participants-btn");
    await expect(btn).toBeVisible();
    await btn.click();
    const first = await hold.held;   // the first open is waiting on its read
    await expect(page.locator("#invite-overlay"), "precondition: the first open rendered nothing while its read is held").toHaveCount(0);
    await btn.click();
    const overlay = page.locator("#invite-overlay");
    await expect(overlay, "the second open rendered").toBeVisible({ timeout: 15000 });
    await expect(overlay).toHaveCount(1);
    await expect.poll(() => parsedCount(page, COMPS_PATH), { message: "the second open's read was parsed" }).toBe(base + 1);
    expect(hold.gets(), "two reads were made, one per open").toBe(2);
    await overlay.evaluate(el => { el.dataset.u7 = "second"; });
    await expect(rowOf(overlay, world.mine), "precondition: the second dialog shows the locked event").toHaveClass(/\bis-locked\b/);
    const typed = `typed-${uniq("u7")}@acme.com`.toLowerCase();
    await overlay.locator("#invite-emails").fill(typed);

    // Release the first read and wait until it has LANDED in the client.
    await first.continue();
    const resp = await first.request().response();
    expect(resp && resp.status(), "the first read answered").toBe(200);
    await resp.finished();
    await expect.poll(() => parsedCount(page, COMPS_PATH), { message: "POSITIVE: the first read was parsed by the page" }).toBe(base + 2);

    await expect(page.locator("#invite-overlay"), "U7: still exactly ONE dialog").toHaveCount(1);
    expect(await page.locator("#invite-overlay").evaluate(el => el.dataset.u7 || null),
      "U7: it is the SAME dialog, not one re-rendered over it").toBe("second");
    await expect(page.locator("#invite-overlay #invite-emails"), "U7: the typed text survived the late read").toHaveValue(typed);
    await expect(rowOf(page.locator("#invite-overlay"), world.mine), "U7: …and the locked row is still there").toHaveClass(/\bis-locked\b/);
    await expect(boxOf(page.locator("#invite-overlay"), world.mine)).toBeChecked();
    await page.unroute(COMPS_RE, hold.handler);
  });

  test("U7 GROUPS — a slow groups load from a REPLACED dialog leaves the showing dialog's group pick alone, and the pick is sent", async ({ page }) => {
    await countJsonParses(page);
    await panel(page, world.ea.email);
    await clickTab(page, "Participants");
    const base = await parsedCount(page, GROUPS_PATH);
    const hold = holdFirstGet();
    await page.route(GROUPS_RE, hold.handler);
    const posts = recordInvitePosts(page);

    const first = await openInvite(page, { tab: false });
    const firstGroups = await hold.held;   // the FIRST dialog's groups read is held
    await first.evaluate(el => { el.dataset.u7 = "first"; });
    await expect(first.locator("#invite-group-list"), "precondition: the first dialog's groups are still loading").toHaveText("Loading groups…");

    // Replace it with a second open (the handler, as boot() exposes it): the
    // existing dialog is removed before the new one is appended.
    expect(await page.evaluate(() => typeof window.openInviteDialog), "precondition: the opener is reachable").toBe("function");
    await page.evaluate(() => window.openInviteDialog());
    const overlay = page.locator("#invite-overlay");
    await expect(overlay, "one dialog after the second open").toHaveCount(1);
    expect(await overlay.evaluate(el => el.dataset.u7 || null), "precondition: it is the SECOND dialog").toBeNull();
    const chip = overlay.locator(`.invite-group-pick[data-group-id="${eaGroup.id}"]`);
    await expect(chip, "the second dialog's groups loaded").toBeVisible({ timeout: 15000 });
    expect(hold.gets(), "two groups reads, one per dialog").toBe(2);
    await expect.poll(() => parsedCount(page, GROUPS_PATH), { message: "the second dialog's groups were parsed" }).toBe(base + 1);
    await chip.click();
    await expect(chip, "the group is picked").toHaveAttribute("aria-pressed", "true");
    const email = `inv-${uniq("u7g")}@acme.com`.toLowerCase();
    await overlay.locator("#invite-emails").fill(email);

    // Release the replaced dialog's groups read, and wait until it LANDED.
    await firstGroups.continue();
    const gResp = await firstGroups.request().response();
    expect(gResp && gResp.status(), "the first groups read answered").toBe(200);
    await gResp.finished();
    await expect.poll(() => parsedCount(page, GROUPS_PATH), { message: "POSITIVE: the replaced dialog's groups were parsed by the page" }).toBe(base + 2);
    await expect(chip, "U7 GROUPS: the pick is still shown").toHaveAttribute("aria-pressed", "true");

    const respP = page.waitForResponse(isInviteResponse, { timeout: 20000 });
    await overlay.locator("#invite-submit-btn").click();
    const resp = await respP;
    const body = await resp.json();
    expect(resp.status(), `the invitation was accepted: ${JSON.stringify(body)}`).toBe(200);
    expect(posts.length, "exactly one request").toBe(1);
    expect(posts[0].groupIds, "U7 GROUPS: the POST still names the group picked in the showing dialog").toEqual([eaGroup.id]);
    expect(posts[0].competitionIds, "…and the locked event").toEqual([world.mine.id]);
    await page.unroute(GROUPS_RE, hold.handler);
  });

  // ── accessibility ───────────────────────────────────────────────────────────

  test("U6 — axe: the LOCKED state has no moderate+ violations", async ({ page }) => {
    await panel(page, world.ea.email);
    const overlay = await openInvite(page);
    await expect(rowOf(overlay, world.mine), "precondition: the locked row rendered").toHaveClass(/\bis-locked\b/);
    await expect(overlay.locator("#invite-comp-locked-note")).toBeVisible();
    await drainAnimations(page, "#invite-overlay");
    await axeClean(page, "invite dialog, locked");
  });

  test("U6 — axe: the NONE state has no moderate+ violations", async ({ page }) => {
    await panel(page, world.zero.email);
    const overlay = await openInvite(page);
    await expect(overlay.locator("#invite-comp-none"), "precondition: the none note rendered").toBeVisible();
    await expect(overlay.locator("#invite-submit-btn"), "precondition: Send is disabled").toBeDisabled();
    await drainAnimations(page, "#invite-overlay");
    await axeClean(page, "invite dialog, none");
  });
});
