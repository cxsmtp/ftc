// @ts-check
//
// v8.12.6 — THE ADMIN DOORS OFFER AN EVENT THAT IS STILL TAKING LATE ENTRIES, AND
// SAY WHAT ADDING SOMEBODY TO IT MEANS.
//
// The server half (late-entry-assignment.api.spec.js) admits a new member into an
// ended Booth Event whose late-entry window is open — as a LATE ENTRANT — at every
// admin door, and lets only a late entrant be removed during the window. None of
// that is reachable from a screen unless the client OFFERS it: every admin door
// used to filter to live/upcoming, so an organiser at a stand after the event's
// official end had no button to press. This file is the lock on the client half,
// and a server-only suite stays green with every line of it reverted — the v8.7.7
// lesson (a client defect is invisible to a test that replays the wire).
//
// EVERY POSITIVE ASSERTION HAS A CONTROL, because each is otherwise satisfied by a
// strictly worse build:
//   * "the late-entry event is offered" — satisfied by a build that offers every
//     ENDED event, so a CLOSED-window event must still be withheld;
//   * "a late entrant can be removed" — satisfied by a build that offers Remove to
//     everybody, so an ordinary member of the same event must NOT be offered it;
//   * "the switch is locked" — satisfied by a build that disabled it everywhere, so
//     a LIVE booth's switch must still be live;
//   * "the stored join is purged" — satisfied by a build that purges on every
//     refusal, so a refusal with another code must keep it.
//
// THE FIXTURE TRAP (tests/late-entry-fixture.js header): an ended event is built
// BACKWARDS — created live, populated, then its start moved into the past — which
// re-times everything done "while live" to AFTER the new end. The ordinary member
// and the participant who took part are back-dated here for exactly that reason;
// without it both would read as late entrants and every control below would
// measure the wrong person.
//
// SESSIONS: the whole fixture is built through ONE superadmin API session in
// `beforeAll`. The browser tests sign the built-in superadmin in again, which
// invalidates that session (single session per user), so nothing after
// `beforeAll` uses it — every later API read goes through `page.request`.

const { test, expect } = require("./isolated-test");
// Rows are read and clicked across every Participants column; the default is six.
test.beforeEach(async ({ page }) => { await require("./ui-admin-helpers").showAllParticipantColumns(page); });
const { BASE, PARTICIPANT_PASS } = require("./helpers");
const {
  adminLogin, loginViaApi, clickTab, openKebab, viewComp, filterComps, awaitCompModel, showEveryoneInWorkspace,
  narrowGroupsTable, AxeBuilder, AXE_GATED_IMPACTS, narrowPeopleTable } = require("./ui-admin-helpers");
const {
  H, uniq, MIN, sa, makeParticipant, liveBooth, enrol, expireEvent, rawSetAssignedAt,
  participantCtx, submit, rawBackdate, rawGetComp, rawUpdateComp, outliveCompCache,
} = require("./late-entry-fixture");

test.use({ baseURL: BASE });

const JOIN_KEY = "hck-pending-join";

/** Label for a participant — the trailing letters stop one label being a prefix of another. */
const lbl = (tag) => `${uniq()}${tag}`;

/**
 * The Participants tab narrowed by the search box to ONE participant (v7.17.2 —
 * the table paginates). Waits for the FILTERED render, not merely a visible
 * match: the search is debounced, and a row found before the debounce lands is
 * replaced under the click that follows (the v8.12.4 findSeededTaskRow lesson).
 */
async function pRow(page, text) {
  await showEveryoneInWorkspace(page);   // members AND non-members (Invite rows)
  await narrowPeopleTable(page, text);
  const row = page.locator("#admin-participants-body tr", { hasText: text });
  await expect.poll(() => page.locator("#admin-participants-body tr").evaluateAll(
    (rs, t) => rs.length > 0 && rs.every((r) => (r.textContent || "").includes(t)), text),
  { timeout: 15000, message: `the participants table narrowed to ${text}` }).toBe(true);
  await expect(row.first()).toBeVisible();
  return row.first();
}

/** Close a participants-row kebab with a neutral click (Escape can leave a click-outside listener armed). */
async function closeKebab(page) {
  await page.locator("#admin-participants-tab h2, #admin-participants-tab").first()
    .click({ position: { x: 2, y: 2 }, timeout: 3000 }).catch(() => {});
  await page.locator("#kebab-portal").waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
}

/** Focus a named event (the scope banner is viewComp's readiness signal). */
async function focus(page, name) {
  await clickTab(page, "Events");
  await viewComp(page, name);
}

/** Focus, then the Participants tab with the focused model loaded. */
async function focusParticipants(page, name) {
  await focus(page, name);
  await clickTab(page, "Participants");
  await expect.poll(() => page.evaluate(() => (window.S?.adminParticipantsData || []).length),
    { timeout: 20000, message: "the participants model loaded" }).toBeGreaterThan(0);
}

/** The Events tab narrowed to one named event, and that row. */
async function eventRow(page, name) {
  await clickTab(page, "Events");
  await filterComps(page, name);
  const row = page.locator(`#admin-comp-body tr:has-text('${name}')`).first();
  await expect(row, `the events table narrowed to "${name}"`).toBeVisible({ timeout: 15000 });
  return row;
}

/** A regular admin (or any account) signed into the admin panel. */
async function adminPanelAs(page, email) {
  await loginViaApi(page, email, PARTICIPANT_PASS);
  const me = await page.request.get("/api/admin/me");
  expect(me.ok(), `${email} had no live admin session: ${me.status()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#admin-page").waitFor({ state: "visible", timeout: 30000 });
}

/** One participant's `competitions[]` entry for an event, read through the page's session. */
async function entryOf(page, userId, compId) {
  const body = await (await page.request.get("/api/admin/participants?limit=5000")).json();
  const p = (body.participants || []).find((x) => x.id === userId);
  expect(p, `participant ${userId} is in the admin list`).toBeTruthy();
  return (p.competitions || []).find((c) => c.id === compId) || null;
}

/** Axe over one region, gated on the suite's impact threshold. */
async function axeClean(page, sel, what) {
  const r = await new AxeBuilder({ page }).include(sel).analyze();
  const bad = r.violations.filter((v) => AXE_GATED_IMPACTS.has(v.impact || ""));
  expect(bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    `${what}: no moderate+ axe violations`).toEqual([]);
}

test.describe("v8.12.6 — the admin doors offer a late-entry event, and say what it means", () => {
  /** @type {any} */ let OPEN, CLOSED, LOCKB, LIVEB, GROUP, OPENOFF, OPENTOG;
  /** @type {any} */ let N1, N1b, N2, N3, O, L, LR, HX, J, F, FC, C1, R, W;
  let openToken = "";

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const S = await sa();
    const mk = (tag) => makeParticipant(S.api, S.csrf, lbl(tag));
    N1 = await mk("nia"); N1b = await mk("nib"); N2 = await mk("nic"); N3 = await mk("nid");
    O = await mk("ord"); L = await mk("lat"); LR = await mk("lrm"); HX = await mk("his");
    J = await mk("jnr"); F = await mk("fpt"); FC = await mk("fct"); C1 = await mk("cls");
    R = await mk("adm"); W = await mk("wlk");

    // OPEN — built live, populated while live, then ended with its window open.
    ({ comp: OPEN } = await liveBooth(S.api, S.csrf, { tasks: 1 }));
    const openTask = (await (await S.api.get("/api/admin/tasks")).json())
      .find((t) => (t.competitions || []).some((c) => c.id === OPEN.id));
    expect(openTask, "OPEN holds its challenge").toBeTruthy();
    await enrol(S.api, S.csrf, OPEN.id, O.id);
    await enrol(S.api, S.csrf, OPEN.id, F.id);
    // W — joined in OPEN's last minutes and OPENED it before it ended. Under the
    // old ten-minute pre-window W was a late entrant; since the operator ruling of
    // 29 Oct 2026 W joined the LIVE event and is an ordinary member.
    await enrol(S.api, S.csrf, OPEN.id, W.id);
    { const pc = await participantCtx(W.email, OPEN.id); await pc.api.dispose(); }
    // F TAKES PART while the event is live (a wrong answer is still taking part),
    // and is then removed — the shape the join refusal exists for.
    {
      const pc = await participantCtx(F.email, OPEN.id);
      const s = await submit(pc.api, pc.csrf, openTask.id, "not-the-answer");
      expect(s.ok(), `F's submission while live: ${await s.text()}`).toBeTruthy();
      await pc.api.dispose();
      const rm = await S.api.delete(`/api/admin/competitions/${OPEN.id}/users/${F.id}`, { headers: H(S.csrf) });
      expect(rm.ok(), `F removed while live: ${await rm.text()}`).toBeTruthy();
    }

    ({ comp: CLOSED } = await liveBooth(S.api, S.csrf));
    await enrol(S.api, S.csrf, CLOSED.id, C1.id);
    ({ comp: LOCKB } = await liveBooth(S.api, S.csrf));
    ({ comp: LIVEB } = await liveBooth(S.api, S.csrf));
    // (review) — two events taking late entries whose join link is OFF: one a
    // regular admin looks at, one a superadmin switches on and off in the dialog.
    ({ comp: OPENOFF } = await liveBooth(S.api, S.csrf, { create: { self_enroll_enabled: false } }));
    ({ comp: OPENTOG } = await liveBooth(S.api, S.csrf, { create: { self_enroll_enabled: false } }));

    const openEnd = await expireEvent(OPEN.id, { agoMinutes: 30 });
    await expireEvent(OPENOFF.id, { agoMinutes: 30 });
    await expireEvent(OPENTOG.id, { agoMinutes: 30 });
    await expireEvent(CLOSED.id, { agoMinutes: 49 * 60 });   // past the 48 h default window
    await expireEvent(LOCKB.id, { agoMinutes: 30 });

    // THE FIXTURE TRAP: back-date what happened "while live".
    rawSetAssignedAt(OPEN.id, O.id, new Date(openEnd.getTime() - 40 * MIN).toISOString());
    rawBackdate("submissions", "submitted_at", OPEN.id, F.id, new Date(openEnd.getTime() - 30 * MIN).toISOString());
    rawSetAssignedAt(OPEN.id, W.id, new Date(openEnd.getTime() - 5 * MIN).toISOString());
    rawBackdate("competition_users", "login_time", OPEN.id, W.id, new Date(openEnd.getTime() - 4 * MIN).toISOString());

    // Preconditions, asserted: the window really is open on OPEN and closed on CLOSED.
    const list = await (await S.api.get("/api/admin/competitions")).json();
    const row = (id) => list.find((c) => c.id === id);
    expect(row(OPEN.id).status, "OPEN has ended").toBe("ended");
    expect(row(OPEN.id).late_entry_window_open, "OPEN is still taking late entries").toBe(true);
    expect(row(CLOSED.id).status).toBe("ended");
    expect(row(CLOSED.id).late_entry_window_open, "CLOSED is not").toBeFalsy();
    expect(row(LOCKB.id).late_entry_locked, "the server locks LOCKB's switch").toBe("ended");
    expect(row(LIVEB.id).late_entry_locked || null, "…and not LIVEB's").toBeNull();
    for (const ev of [OPENOFF, OPENTOG]) {
      expect(row(ev.id).late_entry_window_open, `${ev.name} is taking late entries`).toBe(true);
      expect(row(ev.id).self_enroll_enabled, `…with its join link OFF`).toBeFalsy();
    }

    // LATE entrants, admitted through the window by the real assign door.
    const asg = await S.api.post("/api/admin/competitions/assign", {
      headers: H(S.csrf), data: { userIds: [L.id, LR.id, HX.id], competitionIds: [OPEN.id] },
    });
    const asgBody = await asg.json();
    expect(asgBody.assigned, `the late assign landed: ${JSON.stringify(asgBody)}`).toBe(3);
    expect(asgBody.lateEntryCompetitionIds, "…through the window").toEqual([OPEN.id]);

    // J joins through the link during the window (a late self-enrolment).
    openToken = (await (await S.api.get(`/api/admin/competitions/${OPEN.id}/self-enroll`)).json()).token;
    expect(openToken, "OPEN's join token").toBeTruthy();
    {
      const pc = await participantCtx(J.email, null);
      const j = await pc.api.post("/api/competitions/join", { headers: H(pc.csrf), data: { token: openToken } });
      expect(j.ok(), `J joins late: ${await j.text()}`).toBeTruthy();
      await pc.api.dispose();
    }

    // HX is removed again during the window — a late entrant may be.
    const rmH = await S.api.delete(`/api/admin/competitions/${OPEN.id}/users/${HX.id}`, { headers: H(S.csrf) });
    expect(rmH.ok(), `HX removed through the window: ${await rmH.text()}`).toBeTruthy();

    const g = await S.api.post("/api/admin/groups", { headers: H(S.csrf), data: { name: `LEG ${uniq()}`, userIds: [] } });
    expect(g.ok(), `create group: ${await g.text()}`).toBeTruthy();
    GROUP = (await g.json()).group;

    const promote = await S.api.post(`/api/admin/participants/${R.id}/role`, { headers: H(S.csrf), data: { role: "admin" } });
    expect(promote.ok(), `promote R: ${await promote.text()}`).toBeTruthy();
    await S.api.dispose();
  });

  // ── The Participants row kebab ─────────────────────────────────────────────

  test("U1 — a non-member's row offers Invite on the late-entry event; the confirm says late entrant and names the deadline", async ({ page }) => {
    await adminLogin(page);
    await focusParticipants(page, OPEN.name);
    const row = await pRow(page, N1.nickname);
    await openKebab(page, row);
    const invite = page.locator('#kebab-portal [data-action="participant-invite"]');
    await expect(invite, "Invite is offered on an event taking late entries").toHaveCount(1);
    await expect(invite).toContainText(OPEN.name);
    await invite.click();

    const modal = page.locator("#modal-overlay");
    await expect(modal).toHaveClass(/open/, { timeout: 10000 });
    await expect(page.locator("#modal-title")).toHaveText(`Add a late entrant to ${OPEN.name}`);
    const body = page.locator("#modal-body");
    await expect(body, "the confirm says what adding means").toContainText("joins as a late entrant");
    await expect(body, "…and until when").toContainText("able to play until");
    await expect(body.locator(".modal-late-note")).toBeVisible();
    await axeClean(page, "#modal-overlay", "the late-entrant confirm");
    await page.locator("#modal-confirm-btn").click();

    await expect(page.locator("#toast-stack"), "the toast says what happened").toContainText("invited as a late entrant", { timeout: 15000 });
    await expect.poll(async () => (await entryOf(page, N1.id, OPEN.id))?.late_entrant ?? null,
      { timeout: 15000, message: "N1 is in OPEN as a late entrant" }).toBe(true);
    const badge = (await pRow(page, N1.nickname)).locator(`.comp-badge[data-comp-id="${OPEN.id}"]`);
    await expect(badge, "the row's event badge marks the late entrant").toContainText("late entrant", { timeout: 15000 });
  });

  test("U1 CONTROL — a CLOSED event offers neither Invite nor Remove, and says nothing about late entries", async ({ page }) => {
    await adminLogin(page);
    await focusParticipants(page, CLOSED.name);
    await openKebab(page, await pRow(page, N1b.nickname));
    await expect(page.locator('#kebab-portal [data-action="participant-invite"]'),
      "no Invite into a finished event that is not taking late entries").toHaveCount(0);
    await closeKebab(page);
    await openKebab(page, await pRow(page, C1.nickname));
    await expect(page.locator('#kebab-portal [data-action="participant-uninvite"]'), "no Remove from it either").toHaveCount(0);
    await expect(page.locator("#kebab-portal .kebab-note", { hasText: "since before it ended" }),
      "the late-entry note is not shown where there is no window").toHaveCount(0);
  });

  test("U2 — a late entrant is badged and offered Remove; an ordinary member is not, and the menu says why", async ({ page }) => {
    await adminLogin(page);
    await focusParticipants(page, OPEN.name);

    const lrow = await pRow(page, L.nickname);
    const lbadge = lrow.locator(`.comp-badge[data-comp-id="${OPEN.id}"]`);
    await expect(lbadge).toContainText("late entrant");
    await expect(lbadge).toHaveAttribute("title", /joined as a late entrant/);
    await openKebab(page, lrow);
    const rm = page.locator('#kebab-portal [data-action="participant-uninvite"]');
    await expect(rm, "a late entrant can be removed during the window").toHaveCount(1);
    await expect(rm).toHaveClass(/km-danger/);
    await expect(page.locator("#kebab-portal .kebab-note", { hasText: "since before it ended" })).toHaveCount(0);
    await axeClean(page, "#kebab-portal", "the late entrant's row menu");
    await closeKebab(page);

    // CONTROL — without this, "Remove is offered" is satisfied by a build that
    // offers it to everybody, which the server then refuses for this member.
    expect((await entryOf(page, O.id, OPEN.id))?.late_entrant, "the server says O is NOT a late entrant").toBeUndefined();
    const orow = await pRow(page, O.nickname);
    const obadge = orow.locator(`.comp-badge[data-comp-id="${OPEN.id}"]`);
    await expect(obadge, "O is in the event").toHaveCount(1);
    await expect(obadge).not.toContainText("late entrant");
    await openKebab(page, orow);
    await expect(page.locator('#kebab-portal [data-action="participant-uninvite"]'),
      "an ordinary member of a finished event is NOT offered Remove").toHaveCount(0);
    await expect(page.locator("#kebab-portal .kebab-note", { hasText: "since before it ended" }),
      "…and the menu says why").toHaveCount(1);
    await expect(page.locator('#kebab-portal [data-action="participant-invite"]')).toHaveCount(0);
  });

  test("U2b — removing a late entrant through the UI works", async ({ page }) => {
    await adminLogin(page);
    await focusParticipants(page, OPEN.name);
    await openKebab(page, await pRow(page, LR.nickname));
    await page.locator('#kebab-portal [data-action="participant-uninvite"]').click();
    await expect(page.locator("#modal-overlay")).toHaveClass(/open/, { timeout: 10000 });
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#toast-stack")).toContainText(/removed/i, { timeout: 15000 });
    await expect.poll(() => entryOf(page, LR.id, OPEN.id), { timeout: 15000, message: "LR left OPEN" }).toBeNull();
  });

  // v8.12.6 (review) — `late_entrant` marks the REMOVABLE late entrants, and the
  // badge and the delete warning had keyed on it, so the commonest late entrant —
  // joined in the last ten minutes, opened the event before it ended, plays on —
  // was shown as an ordinary member, told "only people who joined late can be
  // removed" (they did), and got no warning in the first delete confirmation. The
  // badge and the warning key on `late_entry_playing` now; Remove stays on
  // `late_entrant`. CONTROLS: a removable late entrant is still offered the removal
  // in the delete confirmation, and the ordinary member is not warned at all.
  test("U2c — a member who joined minutes before the end is ordinary (no pre-window): no late badge, no Remove, the menu says why", async ({ page }) => {
    await adminLogin(page);
    await expect.poll(async () => {
      const e = await entryOf(page, W.id, OPEN.id);
      return e ? `playing=${!!e.late_entry_playing} removable=${!!e.late_entrant}` : null;
    }, { timeout: 15000, message: "the server's two answers for W" }).toBe("playing=false removable=false");
    await focusParticipants(page, OPEN.name);
    const wrow = await pRow(page, W.nickname);
    const wbadge = wrow.locator(`.comp-badge[data-comp-id="${OPEN.id}"]`);
    await expect(wbadge, "PRECONDITION: W's event badge renders").toHaveCount(1);
    await expect(wbadge, "not badged as a late entrant").not.toContainText("late entrant");
    await openKebab(page, wrow);
    await expect(page.locator('#kebab-portal [data-action="participant-uninvite"]'),
      "not removable — in the event before it ended").toHaveCount(0);
    await expect(page.locator("#kebab-portal .kebab-note", { hasText: "since before it ended" }),
      "the note gives the ordinary member's reason").toHaveCount(1);
    await expect(page.locator("#kebab-portal .kebab-note", { hasText: "started playing before it ended" }),
      "…not the old late-entrant one").toHaveCount(0);

    const deleteDialog = async (row) => {
      await openKebab(page, row);
      await page.locator('#kebab-portal [data-action="participant-delete"]').click();
      await expect(page.locator("#modal-overlay")).toHaveClass(/open/, { timeout: 10000 });
      const text = await page.locator("#modal-body").innerText();
      await page.locator("#modal-cancel-btn").click();
      await expect(page.locator("#modal-overlay")).not.toHaveClass(/open/, { timeout: 10000 });
      return text;
    };
    await closeKebab(page);
    const wd = await deleteDialog(await pRow(page, W.nickname));
    expect(wd, "W is in a finished event they cannot play: no 'competing right now' warning").not.toContain("competing right now");
    expect(wd).not.toContain("(as a late entrant)");

    // CONTROL — a removable late entrant: warned, and offered the gentler option.
    const ld = await deleteDialog(await pRow(page, L.nickname));
    expect(ld).toContain("(as a late entrant)");
    expect(ld).toContain("Removing them from the event instead");
    // CONTROL — the ordinary member is in a finished event they cannot play: no warning.
    const od = await deleteDialog(await pRow(page, O.nickname));
    expect(od, "an ordinary member of the finished event is not 'competing right now'").not.toContain("competing right now");
    expect(od).not.toContain(OPEN.name);
  });

  // The account-delete refusal names WHICH late-entry rule keeps the person
  // (`removalRefused`, the removal door's own code), and the dialog after it says
  // that reason in its own words: a placing certificate can be revoked, having
  // started before the end cannot be undone. The server's half (each code, each
  // `error`) is held in late-entry-assignment.api.spec.js; this is the client's,
  // driven with the refusal the server sends (so nothing is deleted).
  test("U2d — the delete refusal's dialog gives each late-entry rule its own reason", async ({ page }) => {
    await adminLogin(page);
    await focusParticipants(page, OPEN.name);
    const CERT = /hold a placing certificate for it, so they can be removed from it only once that certificate is revoked/;
    const STARTED = /had started playing it before it ended, so they cannot be removed from it instead/;
    const cases = [["late_entrant_has_certificate", CERT, STARTED], ["not_late_entrant", STARTED, CERT]];
    for (const [code, says, never] of cases) {
      const deletes = [];
      const url = `**/api/admin/participants/${O.id}`;
      await page.route(url, (route) => {
        if (route.request().method() !== "DELETE") return route.continue();
        deletes.push(route.request().url());
        return route.fulfill({ status: 400, json: { error: "refused", code: "participant_in_live_competition",
          competitionId: OPEN.id, competitionName: OPEN.name, lateEntrant: true, removable: false, removalRefused: code } });
      });
      await openKebab(page, await pRow(page, O.nickname));
      await page.locator('#kebab-portal [data-action="participant-delete"]').click();
      await expect(page.locator("#modal-overlay")).toHaveClass(/open/, { timeout: 10000 });
      await page.locator("#modal-confirm-btn").click();
      await expect(page.locator("#modal-title"), `${code}: the refusal's dialog`).toHaveText("Participant is competing right now", { timeout: 10000 });
      const text = await page.locator("#modal-body").innerText();
      expect(deletes.length, `PRECONDITION (${code}): the delete was sent, and answered with the refusal`).toBe(1);
      expect(text, `${code}: its own reason`).toMatch(says);
      expect(text, `${code}: never the other rule's`).not.toMatch(never);
      expect(text, `${code}: no gentler option offered`).not.toContain("gentler option");
      await page.locator("#modal-cancel-btn").click();
      await expect(page.locator("#modal-overlay")).not.toHaveClass(/open/, { timeout: 10000 });
      await page.unroute(url);
    }
    expect(await entryOf(page, O.id, OPEN.id), "nothing was deleted").not.toBeNull();
  });

  // ── The selection bar and the bulk picker ──────────────────────────────────

  test("U3 — the selection bar assigns straight into the late-entry event, with the late-entrant note", async ({ page }) => {
    await adminLogin(page);
    await focusParticipants(page, OPEN.name);
    await (await pRow(page, N2.nickname)).locator(".cb-cell input[type=checkbox]").check();
    const barBtn = page.locator("#selection-bar-assign-btn");
    await expect(barBtn, "a direct assign into the focused event").toHaveText(`Assign to "${OPEN.name}"`);
    await barBtn.click();
    await expect(page.locator("#modal-overlay")).toHaveClass(/open/, { timeout: 10000 });
    await expect(page.locator("#modal-body")).toContainText("joins as a late entrant");
    await page.locator("#modal-confirm-btn").click();
    await expect(page.locator("#toast-stack")).toContainText("newly invited as late entrants", { timeout: 15000 });
    await expect.poll(async () => (await entryOf(page, N2.id, OPEN.id))?.late_entrant ?? null,
      { timeout: 15000, message: "N2 joined OPEN as a late entrant" }).toBe(true);
  });

  test("U3b — somebody who took part before the end is skipped, and the toast says why rather than calling them enrolled", async ({ page }) => {
    // The assign route skips (user, event) pairs whose user took part before the
    // end and counts them in `skippedTookPart`. The toast derives "already
    // enrolled" by SUBTRACTION, so a reasoned skip missing from that sum is
    // reported twice — once with its reason and once as "already enrolled", which
    // F is not.
    await adminLogin(page);
    await focusParticipants(page, OPEN.name);
    await (await pRow(page, F.nickname)).locator(".cb-cell input[type=checkbox]").check();
    await page.locator("#selection-bar-assign-btn").click();
    await expect(page.locator("#modal-overlay")).toHaveClass(/open/, { timeout: 10000 });
    await page.locator("#modal-confirm-btn").click();
    const toast = page.locator("#toast-stack");
    await expect(toast).toContainText("they took part before the event ended", { timeout: 15000 });
    // Read ONCE and assert on that snapshot: a retrying `not.toContainText` on a
    // toast passes as soon as the toast fades — measured, it passed with the
    // defect present.
    const said = await toast.innerText();
    expect(said, "F is not 'already enrolled' — F is not enrolled at all").not.toContain("already enrolled");
    expect(await entryOf(page, F.id, OPEN.id), "and nothing was written").toBeNull();
  });

  test("U3 CONTROL — an event closed with End Now is NOT offered a direct assign, though its scheduled end is still ahead", async ({ page }) => {
    // End Now stores the elapsed minutes ROUNDED UP, so for up to a minute the
    // scheduled end is still in the future (v8.1.9). The selection bar asked only
    // "is the scheduled end ahead?" and offered `Assign to "<event>"` for an event
    // the assign route then refuses outright. Started 61 s ago, so `ceil` stores
    // two minutes and leaves ~59 s in which the old rule is wrong — the window the
    // precondition below asserts is still open when the label is read.
    await adminLogin(page);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const mk = await page.request.post("/api/admin/competitions", {
      headers: H(csrf),
      data: { name: `LE end-now ${uniq()}`, start_time: new Date(Date.now() - 61_000).toISOString(), duration_minutes: 600 },
    });
    expect(mk.ok(), `create: ${await mk.text()}`).toBeTruthy();
    const endNow = (await mk.json()).competition;
    const en = await page.request.post(`/api/admin/competitions/${endNow.id}/end-now`, { headers: H(csrf) });
    expect(en.ok(), `end-now: ${await en.text()}`).toBeTruthy();
    await page.reload();
    await page.locator("#admin-page").waitFor({ state: "visible", timeout: 20000 });

    await focusParticipants(page, endNow.name);
    await (await pRow(page, N3.nickname)).locator(".cb-cell input[type=checkbox]").check();
    await expect(page.locator("#selection-bar-assign-btn"), "no direct assign into an event closed with End Now")
      .toHaveText("Assign to Events");
    const row = rawGetComp(endNow.id);
    expect(row.ended_manually, "precondition: it was ended by hand").toBe(1);
    expect(new Date(row.start_time).getTime() + row.duration_minutes * MIN,
      "precondition: its scheduled end is STILL AHEAD, or this control asserts nothing").toBeGreaterThan(Date.now());

    // The revivable clause the label keeps: an AUTO-ended event whose scheduled
    // end is still ahead is revived by the assign route, so it IS offered. Driven
    // on the predicate, because that state takes an all-solved auto-end to reach.
    const verdicts = await page.evaluate(() => {
      const now = Date.now();
      const base = { status: "ended", start_time: new Date(now - 60_000).toISOString(), duration_minutes: 2 };
      return {
        endNow: window.isCompEffectivelyActive({ ...base, ended_manually: 1 }),
        autoEnded: window.isCompEffectivelyActive({ ...base, ended_manually: 0 }),
        lateOpen: window.isCompEffectivelyActive({ ...base, ended_manually: 1, late_entry_window_open: true }),
      };
    });
    expect(verdicts).toEqual({ endNow: false, autoEnded: true, lateOpen: true });
  });

  test("U4 — the bulk Assign-to-Events picker lists the late-entry event with its badge, and omits a closed one", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Participants");
    await (await pRow(page, N3.nickname)).locator(".cb-cell input[type=checkbox]").check();
    const barBtn = page.locator("#selection-bar-assign-btn");
    await expect(barBtn).toHaveText("Assign to Events");
    await barBtn.click();
    const list = page.locator("#bulk-comp-list");
    await expect(list).toBeVisible({ timeout: 15000 });
    const open = list.locator("label", { hasText: OPEN.name });
    await expect(open, "the late-entry event is offered").toHaveCount(1);
    await expect(open.locator(".status-badge")).toHaveClass(/late-entry/);
    await expect(open.locator(".status-badge")).toHaveText("Late entry open");
    await expect(open, "with its late-entry deadline").toContainText("Late entry open until");
    await expect(list.locator("label", { hasText: CLOSED.name }), "CONTROL: a closed event is not").toHaveCount(0);
    await expect(list.locator("label", { hasText: LIVEB.name }).locator(".status-badge"), "a live one still reads Live").toHaveText("Live");
  });

  // ── The invitation dialog ──────────────────────────────────────────────────

  test("U5 — the invitation dialog pre-ticks the focused late-entry event and says what that means", async ({ page }) => {
    await adminLogin(page);
    await focusParticipants(page, OPEN.name);
    await page.locator("#invite-participants-btn").click();
    const overlay = page.locator("#invite-overlay");
    await expect(overlay).toBeVisible({ timeout: 15000 });
    const open = overlay.locator("label.picker-row", { hasText: OPEN.name });
    await expect(open.locator("input.invite-comp-cb"), "the focused late-entry event is offered, pre-ticked").toBeChecked();
    await expect(open.locator(".status-badge")).toHaveText("Late entry open");
    const note = overlay.locator("#invite-late-note");
    await expect(note, "the dialog says what ticking it means").toBeVisible();
    await expect(note).toContainText("late entrants");
    // CONTROL — the note follows the tick, or "it is shown" is satisfied by a
    // note that is always there.
    await open.locator("input.invite-comp-cb").uncheck();
    await expect(note).toBeHidden();
    await expect(overlay.locator("label.picker-row", { hasText: CLOSED.name }), "a closed event is not offered").toHaveCount(0);
  });

  // ── The group → Events dialog ──────────────────────────────────────────────

  test("U6 — a group's Events dialog lists the late-entry event with its badge, and says so", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Groups");
    await narrowGroupsTable(page, GROUP.name);   // v9.2.4 — waits out the re-render a press could straddle
    const grow = page.locator(`#groups-tbody tr:has-text("${GROUP.name}")`).first();
    await expect(grow).toBeVisible({ timeout: 15000 });
    await grow.locator('[data-action="group-bind-comps"]').click();
    const list = page.locator("#gc-list");
    await expect(list).toBeVisible({ timeout: 15000 });
    const open = list.locator("label", { hasText: OPEN.name });
    await expect(open, "the late-entry event can be bound").toHaveCount(1);
    await expect(open.locator(".status-badge")).toHaveText("Late entry open");
    await expect(list.locator("label", { hasText: CLOSED.name }), "CONTROL: a closed one cannot").toHaveCount(0);
    await expect(page.getByText("an event still taking late entries is")).toBeVisible();
    await page.locator("#gc-close").click();
  });

  // ── The desk shortcut ──────────────────────────────────────────────────────

  test("U7 — the desk shortcut on a late-entry event says the person joins as a late entrant", async ({ page }) => {
    await adminLogin(page);
    await focusParticipants(page, OPEN.name);
    await awaitCompModel(page);
    await page.locator("#desk-invite-btn").click();
    const input = page.locator("#prompt-input");
    await expect(input).toBeVisible({ timeout: 10000 });
    await expect(page.locator("label", { hasText: "as a late entrant" }), "the prompt says so before asking").toBeVisible();
    const email = `${lbl("dsk")}@company.example`;
    await input.fill(email);
    await page.locator("#prompt-ok").click();
    await expect(page.locator("#modal-title")).toHaveText("Sign-in code", { timeout: 15000 });
    await expect(page.locator("#modal-body"), "…and the code dialog repeats it").toContainText("as a late entrant");
    await page.locator("#modal-confirm-btn").click();
    const body = await (await page.request.get("/api/admin/participants?limit=5000")).json();
    const u = (body.participants || []).find((p) => p.email === email);
    expect(u, "the desk account exists").toBeTruthy();
    expect((u.competitions || []).find((c) => c.id === OPEN.id)?.late_entrant, "…as a late entrant of OPEN").toBe(true);
  });

  test("U7 CONTROL — the desk shortcut on a CLOSED event refuses with the reason, before asking for an address", async ({ page }) => {
    await adminLogin(page);
    await focusParticipants(page, CLOSED.name);
    await awaitCompModel(page);
    /** @type {string[]} */ const posts = [];
    await page.route("**/api/admin/participants/desk-invite", async (route, req) => {
      if (req.method() === "POST") posts.push(req.postData() || "");
      await route.continue();
    });
    await page.locator("#desk-invite-btn").click();
    await expect(page.locator("#toast-stack"), "refused WITH the reason").toContainText("not taking late entries", { timeout: 10000 });
    await expect(page.locator("#toast-stack")).toContainText(CLOSED.name);
    await expect(page.locator("#prompt-input"), "no address prompt opens").toHaveCount(0);
    expect(posts, "nothing left the browser").toEqual([]);
  });

  // ── The Events surfaces: kebab, scope banner, switcher ─────────────────────

  test("U9 — the Events row menu offers Manage Participants and Join Link during the window, and never Assign Challenges", async ({ page }) => {
    await adminLogin(page);
    await openKebab(page, await eventRow(page, OPEN.name));
    const portal = page.locator("#kebab-portal");
    await expect(portal.locator('[data-action="comp-manage-participants"]')).toHaveCount(1);
    await expect(portal.locator('[data-action="comp-self-enroll"]'), "the join link still works, so it is still offered").toHaveCount(1);
    await expect(portal.locator('[data-action="comp-assign-challenges"]'),
      "a finished event's challenge list is frozen whatever the window says").toHaveCount(0);
    // v8.12.8 — and the window can be closed early from here. NOT clicked: later
    // arms in this file use OPEN's open window.
    await expect(portal.locator('[data-action="comp-close-late-entries"]'),
      "Close late entries now is offered while the window is open").toHaveCount(1);

    await openKebab(page, await eventRow(page, CLOSED.name));
    await expect(portal.locator('[data-action="comp-manage-participants"]'), "CONTROL: a closed event offers none of them").toHaveCount(0);
    await expect(portal.locator('[data-action="comp-self-enroll"]')).toHaveCount(0);
    await expect(portal.locator('[data-action="comp-assign-challenges"]')).toHaveCount(0);
    await expect(portal.locator('[data-action="comp-close-late-entries"]'), "…nor a close, with no window left to close").toHaveCount(0);
    await page.keyboard.press("Escape");

    await openKebab(page, await eventRow(page, OPEN.name));
    await portal.locator('[data-action="comp-manage-participants"]').click();
    await expect(page.locator("#admin-participants-tab")).toBeVisible({ timeout: 15000 });
    await expect(page.locator("#admin-scope-banner")).toContainText(OPEN.name);
  });

  test("U10 — the status strip says the event is still taking late entries, and the workspace header names its bucket", async ({ page }) => {
    await adminLogin(page);
    await focus(page, OPEN.name);
    const banner = page.locator("#admin-scope-banner");
    await expect(banner).toContainText("Ended · late entry open until");

    // CONTROL — a closed window reads plain Ended.
    await focus(page, CLOSED.name);
    await expect(banner).toContainText(CLOSED.name);
    await expect(banner).toContainText("Ended");
    expect(await banner.innerText(), "a lapsed window says nothing about late entries").not.toContain("late entry");

    // The workspace header's status chip (the strip's, in the compact header)
    // labels the event by its BUCKET: a closed window reads Ended, an open one
    // says late entry is open.
    await expect(banner.locator(".ws-status-chip.ws-chip-ended"), "the closed event's header says Ended").toHaveText("Ended");
    await focus(page, OPEN.name);
    const chip = banner.locator(".ws-status-chip.ws-chip-late-entry");
    await expect(chip, "the late-entry event's header names its bucket").toContainText("late entry open");
    await expect(banner.locator(".ws-status-chip.ws-chip-ended"), "…and not Ended").toHaveCount(0);
  });

  // ── The competition form: the late-entry switch lock ───────────────────────

  test("the late-entry switch is locked on an ended event WITH the reason, live on a live one, and a save of another field still works", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Events");
    await awaitCompModel(page);
    const openEditor = async (id) => {
      await page.waitForFunction((cid) => (window.S?.adminCompetitionsData || []).some((c) => c.id === cid), id, { timeout: 20000 });
      await page.evaluate((cid) => window.editCompetition(cid), id);
      await expect(page.locator("#comp-form-overlay")).toBeVisible({ timeout: 15000 });
    };
    const closeForm = async () => {
      await page.locator('[data-action="overlay-close"][data-overlay-id="comp-form-overlay"]').first().click();
      await expect(page.locator("#comp-form-overlay")).toHaveCount(0, { timeout: 10000 });
    };

    // CONTROL first — a live booth's switch is live.
    await openEditor(LIVEB.id);
    await expect(page.locator("#comp-late-entry")).toBeEnabled();
    await expect(page.locator("#comp-late-entry-lock-note")).toHaveCount(0);
    await closeForm();

    await openEditor(LOCKB.id);
    const sw = page.locator("#comp-late-entry");
    await expect(sw, "the server refuses the change, so the form does not offer it").toBeDisabled();
    await expect(sw, "…and still shows the stored value").toBeChecked();
    const note = page.locator("#comp-late-entry-lock-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText("the event has ended");
    // v8.12.8 — the remedy is the "Close late entries now" control every organiser
    // has, named because LOCKB's window is still OPEN (it ended half an hour ago);
    // the superadmin-only "set the deadline to now" advice it replaced is gone.
    await expect(note, "the remedy is named").toContainText("Close late entries now");
    expect(await note.innerText(), "the old superadmin-only remedy is gone").not.toContain("deadline below to now");
    await expect(sw).toHaveAttribute("aria-describedby", "comp-late-entry-lock-note");

    // A save of ANOTHER field still works — the disabled box still ECHOES its
    // stored value, which the server reads as no change.
    await page.locator("#comp-attempt-cap").fill("4");
    /** @type {string[]} */ const sent = [];
    const onReq = (rq) => { if (rq.method() === "PUT" && rq.url().includes(`/api/admin/competitions/${LOCKB.id}`)) sent.push(rq.postData() || ""); };
    page.on("request", onReq);
    const put = page.waitForResponse((rs) => rs.request().method() === "PUT" && rs.url().includes(`/api/admin/competitions/${LOCKB.id}`), { timeout: 15000 });
    await page.locator('[data-action="comp-save"]').click();
    await expect(page.locator("#modal-overlay")).toBeVisible({ timeout: 10000 });
    await page.locator("#modal-overlay #modal-confirm-btn").click();
    const resp = await put;
    page.off("request", onReq);
    expect(resp.status(), `the save succeeded: ${await resp.text()}`).toBe(200);
    expect(JSON.parse(sent[0] || "{}").late_entry_enabled, "the locked box echoed its stored value").toBe(true);
    const row = rawGetComp(LOCKB.id);
    expect(row.attempt_cap, "the other field was written").toBe(4);
    expect(row.late_entry_enabled, "the switch did not move").toBe(1);
  });

  // ── History ────────────────────────────────────────────────────────────────

  test("History marks the adds and removals that went through the window — and only those", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Participants");
    const histOf = async (nick) => {
      await openKebab(page, await pRow(page, nick));
      await page.locator('#kebab-portal [data-action="participant-history"]').click();
      const body = page.locator("#hist-body");
      await expect(body.locator("tr").first()).toBeVisible({ timeout: 15000 });
      return body;
    };
    const closeHist = async () => {
      await page.keyboard.press("Escape");
      await expect(page.locator("#hist-overlay")).toHaveCount(0, { timeout: 10000 });
    };

    let body = await histOf(HX.nickname);
    const lateRows = body.locator("tr", { hasText: OPEN.name }).filter({ has: page.locator(".hist-late-entrant") });
    await expect(lateRows, "HX was added AND removed through the window — both say so").toHaveCount(2);
    await closeHist();

    body = await histOf(J.nickname);
    await expect(body.locator("tr", { hasText: "through its join link" }), "the join-link enrolment has a line of its own")
      .toContainText(`Joined ${OPEN.name} through its join link (late entrant)`);
    await closeHist();

    // CONTROL — O joined while the event was live; nothing about it was late.
    body = await histOf(O.nickname);
    await expect(body.locator("tr", { hasText: OPEN.name }).first()).toBeVisible();
    await expect(body.locator(".hist-late-entrant"), "an ordinary add is not marked").toHaveCount(0);
    await closeHist();
  });

  // ── The join link ──────────────────────────────────────────────────────────

  test("someone who took part before the end is refused the join link, told why, and the stored join is purged", async ({ page }) => {
    // Proves the key was STORED first (the link visit writes it before the join
    // fires), or "it is gone" is satisfied by a build that never stored it.
    await page.addInitScript((k) => {
      const orig = Storage.prototype.setItem;
      // @ts-ignore
      window.__joinStored = false;
      Storage.prototype.setItem = function (key, val) {
        // @ts-ignore
        if (key === k) window.__joinStored = true;
        return orig.call(this, key, val);
      };
    }, JOIN_KEY);
    await loginViaApi(page, F.email, PARTICIPANT_PASS);
    await page.goto(`/join/${openToken}`);
    await expect(page.locator("#toast-stack"), "the server's own sentence, verbatim").toContainText("You took part in", { timeout: 30000 });
    expect(await page.evaluate(() => /** @type {any} */ (window).__joinStored), "the visit stored the pending join").toBe(true);
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), JOIN_KEY),
      { message: "a settled refusal purges the stored join" }).toBeNull();
  });

  test("CONTROL — a refusal with any OTHER code keeps the stored join", async ({ page }) => {
    await page.route("**/api/competitions/join", (route) => route.fulfill({
      status: 409, contentType: "application/json",
      body: JSON.stringify({ error: "Something transient went wrong.", code: "some_other_code" }),
    }));
    await loginViaApi(page, FC.email, PARTICIPANT_PASS);
    await page.goto(`/join/${openToken}`);
    await expect(page.locator("#toast-stack")).toContainText("Something transient went wrong.", { timeout: 30000 });
    expect(await page.evaluate((k) => localStorage.getItem(k), JOIN_KEY), "the stored join survives an ordinary refusal").toBeTruthy();
  });

  // ── The Join Link dialog ───────────────────────────────────────────────────

  test("the Join Link dialog during the window: the link keeps working, and a regular admin is told why its settings are locked", async ({ page }) => {
    await adminPanelAs(page, R.email);
    await openKebab(page, await eventRow(page, OPEN.name));
    await page.locator('#kebab-portal [data-action="comp-self-enroll"]').click();
    const ov = page.locator("#self-enroll-overlay");
    await expect(ov).toBeVisible({ timeout: 15000 });
    await expect(ov.locator("#self-enroll-late-note"), "the dialog says the link still works").toContainText("late entries");
    await expect(ov.locator("#self-enroll-enabled"), "the PUT refuses a regular admin on an ended event").toBeDisabled();
    await expect(ov.locator("#self-enroll-ended-note"), "…WITH the reason").toContainText("only a superadmin");
    await expect(ov.locator("#self-enroll-enabled")).toHaveAttribute("aria-describedby", "self-enroll-ended-note");
    await expect(ov.locator('[data-action="self-enroll-regenerate"]'), "regenerating is still allowed").toHaveCount(1);
    await axeClean(page, "#self-enroll-overlay", "the Join Link dialog");
  });

  test("CONTROL — the superadmin's Join Link dialog on the same event keeps its settings live", async ({ page }) => {
    await adminLogin(page);
    await openKebab(page, await eventRow(page, OPEN.name));
    await page.locator('#kebab-portal [data-action="comp-self-enroll"]').click();
    const ov = page.locator("#self-enroll-overlay");
    await expect(ov).toBeVisible({ timeout: 15000 });
    await expect(ov.locator("#self-enroll-late-note")).toBeVisible();
    await expect(ov.locator("#self-enroll-enabled")).toBeEnabled();
    await expect(ov.locator("#self-enroll-ended-note")).toHaveCount(0);
  });

  // v8.12.6 (review) — the late-entry window does not depend on the join link's
  // switch, but every join door refuses a disabled link — so "the link, QR code and
  // short code keep working until …" was false on an event whose link is off, and
  // it sat beside the note saying the link was inactive. The two enabled-link arms
  // above are the CONTROL that the claim is still made where it is true.
  test("a DISABLED link on an event taking late entries: the Join Link dialog does not say it works, and says what would", async ({ page }) => {
    await adminPanelAs(page, R.email);
    await openKebab(page, await eventRow(page, OPENOFF.name));
    await page.locator('#kebab-portal [data-action="comp-self-enroll"]').click();
    const ov = page.locator("#self-enroll-overlay");
    await expect(ov).toBeVisible({ timeout: 15000 });
    await expect(ov.locator("#self-enroll-enabled"), "PRECONDITION: the link is off").not.toBeChecked();
    const note = ov.locator("#self-enroll-late-note");
    await expect(note, "the dialog still says the event is taking late entries").toBeVisible();
    // innerText honours display:none, so this is the sentence on SCREEN.
    const said = await note.innerText();
    expect(said, "no claim that a disabled link works").not.toContain("keep working");
    expect(said, "…what would make it work").toContain("only once Enable self-enrollment is on");
    expect(said, "…and, with the switches locked for this admin, who can").toContain("only a superadmin");
    await expect(ov.locator("#self-enroll-inactive-note"), "the inactive note stands").toBeVisible();
    await expect(ov.locator("#self-enroll-code-box"), "PRECONDITION: the short code is shown").toBeVisible();
    expect(await ov.locator(".self-enroll-code-hint").innerText(), "no 'stops working' about a code that is not working").not.toContain("stops working");
    await axeClean(page, "#self-enroll-overlay", "the disabled Join Link dialog");
  });

  test("…and a superadmin who switches the link ON in the dialog is told it now works; switching it OFF takes the claim back", async ({ page }) => {
    await adminLogin(page);
    await openKebab(page, await eventRow(page, OPENTOG.name));
    await page.locator('#kebab-portal [data-action="comp-self-enroll"]').click();
    const ov = page.locator("#self-enroll-overlay");
    await expect(ov).toBeVisible({ timeout: 15000 });
    const note = ov.locator("#self-enroll-late-note");
    const box = ov.locator("#self-enroll-enabled");
    await expect(box, "PRECONDITION: off").not.toBeChecked();
    expect(await note.innerText()).not.toContain("keep working");
    await box.check();
    await expect(page.locator("#toast-stack"), "the save landed").toContainText("Self-enrollment enabled", { timeout: 15000 });
    await expect(box, "…and stuck").toBeChecked();
    await expect.poll(() => note.innerText(), { message: "the note now says the link works" }).toContain("keep working");
    expect(await ov.locator(".self-enroll-code-hint").innerText()).toContain("It stops working when late entry closes.");
    await expect(ov.locator("#self-enroll-inactive-note")).toBeHidden();
    await box.uncheck();
    await expect(page.locator("#toast-stack")).toContainText("Self-enrollment disabled", { timeout: 15000 });
    await expect.poll(() => note.innerText(), { message: "switching it off takes the claim back" }).not.toContain("keep working");
    expect(await ov.locator(".self-enroll-code-hint").innerText()).not.toContain("stops working");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v8.12.6 (review) — the rows follow the focused event across its end
// ═══════════════════════════════════════════════════════════════════════════
//
// Each Participants row's Remove item and notes are decided by the focused
// event's state AT RENDER, and nothing re-rendered them when that state moved:
// the 15 s poll compared the list before and after ITS OWN reload, but the scope
// banner's 1 s tick reloads the list on the live→ended edge first, so the poll saw
// no change. An organiser working the stand at closing time kept being offered
// Remove on every member, the confirm promising they would lose access, and the
// server then refused it. Crossed WITH THE PAGE OPEN, because every other arm in
// this file builds the ended event before the page loads, which can never see it.
//
// The CONTROL is the late entrant, and it is the half that decides the shape of the
// fix: the rows were FETCHED while the event was live, when no entry carries the
// server's late-entrant verdict — so merely re-rendering them would withhold Remove
// from the one member who may be removed. The data has to be fetched again.
test.describe("v8.12.6 (review) — the Participants rows follow the focused event across its end", () => {
  test("an event that ends WHILE the tab is open: the ordinary member's Remove goes with its note, a late entrant's stays", async ({ page }) => {
    test.setTimeout(240_000);
    const S2 = await sa();
    /** @type {any} */ let E, O2, L2;
    try {
      ({ comp: E } = await liveBooth(S2.api, S2.csrf));
      O2 = await makeParticipant(S2.api, S2.csrf, lbl("eor"));
      L2 = await makeParticipant(S2.api, S2.csrf, lbl("elt"));
      await enrol(S2.api, S2.csrf, E.id, O2.id);
      await enrol(S2.api, S2.csrf, E.id, L2.id);
    } finally { await S2.api.dispose(); }
    // E ends a minute from now. O2 joined long before the end. L2's join is stamped
    // just AFTER the end (a late entrant is only somebody who joins after it,
    // operator ruling 29 Oct 2026); the row is already in the table while the event
    // is live, so only a fresh fetch can give L2 the late-entrant Remove.
    const endMs = Date.now() + 60_000;
    rawUpdateComp(E.id, "start_time=?, duration_minutes=?", [new Date(endMs - 60 * MIN).toISOString(), 60]);
    rawSetAssignedAt(E.id, O2.id, new Date(endMs - 50 * MIN).toISOString());
    rawSetAssignedAt(E.id, L2.id, new Date(endMs + 1_000).toISOString());
    await outliveCompCache();

    await adminLogin(page);
    await focusParticipants(page, E.name);
    const orow = await pRow(page, O2.nickname);
    const oRemove = orow.locator('.kebab-menu [data-action="participant-uninvite"]');
    expect(Date.now(), "PRECONDITION: the page is up before the event ends").toBeLessThan(endMs - 5_000);
    await expect(oRemove, "PRECONDITION: while it is live, a member can be removed").toHaveCount(1);

    // The boundary, crossed through the banner — nothing here re-renders the table.
    await expect(page.locator("#admin-scope-banner"), "the banner saw the end")
      .toContainText("late entry open", { timeout: (endMs - Date.now()) + 20_000 });
    await expect(oRemove, "after the end the ordinary member's Remove is withdrawn without a manual re-render")
      .toHaveCount(0, { timeout: 45_000 });
    await expect(orow.locator(".kebab-menu .kebab-note", { hasText: "since before it ended" }), "…with its reason").toHaveCount(1);

    // CONTROL — the late entrant keeps Remove, which only fresh data can give them.
    const lrow = await pRow(page, L2.nickname);
    await expect(lrow.locator('.kebab-menu [data-action="participant-uninvite"]'),
      "the late entrant can still be removed").toHaveCount(1, { timeout: 30_000 });
    await expect(lrow.locator(`.comp-badge[data-comp-id="${E.id}"]`)).toContainText("late entrant");
  });
});
