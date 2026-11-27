// @ts-check
//
// "NO FIXED DEADLINE" FOR AN OPEN-ENDED PROGRAM (operator ruling, 14 Nov 2026).
//
// A Program created with "No fixed deadline" stores a deadline ten years out,
// so every participant surface that showed its time left read "3652 days left"
// (the events list, the play bar) or counted ten years down (the header, with a
// "Day 1 of 3653" chip). The ruling: once the Program is open-ended — its end at
// least OPEN_ENDED_THRESHOLD_DAYS away, the server's isOpenEnded — each of them
// says "No fixed deadline" instead; the events list's card says it once, as the
// end of its date line, and leaves its countdown line empty while it is live (a
// ruling of the same day). ONE definition: the server projects
// isOpenEnded per read as `open_ended` (the event rows and the /api/status body,
// so the pulse), and the client only reads it.
//
// Controls, by value: a Program twelve days out still counts down; a CLOSED
// Program whose stored deadline is still a decade out is not open-ended (keyed
// on the deadline column alone it would read "No fixed deadline" while refusing
// certificates); a Booth Event and a Competition keep their countdown and ring;
// an open-ended Program not started yet still counts down to its start (the
// words replace the time LEFT only). Browser locks run at a phone and a desktop
// width.
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, BASE } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const DAY = 86400e3, HOUR = 3600e3;
const WIDTHS = [390, 1440];
const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const WORDS = "No fixed deadline";
// What a decade-long countdown looks like on any of the surfaces: "3652 days
// left", "3652d 23:59:59", "Day 1 of 3653". Checked against the page's whole
// visible text, with a positive control on the pattern itself (below).
const TEN_YEARS = /\b\d{3,} days\b|\b\d{3,}d \d\d:\d\d:\d\d\b|\bDay \d+ of \d{3,}\b/;

const viewport = (width) => ({ width, height: width >= 768 ? 900 : 800 });

/** The header's countdown and day chip, by value. */
async function header(page) {
  return page.evaluate(() => {
    const t = document.getElementById("header-timer"), d = document.getElementById("header-day");
    const shown = (el) => !!(el && !el.hidden && getComputedStyle(el).display !== "none"
      && el.getClientRects().length && el.getBoundingClientRect().height > 0);
    return {
      timer: t.textContent, timerShown: shown(t),
      // The whole words, not an ellipsis: the phone header clips with one.
      timerWhole: t.scrollWidth <= t.clientWidth + 1,
      day: d.textContent, dayHidden: d.hidden,
    };
  });
}

/** The play bar's readout and ring, measured against the bar. */
async function playBar(page) {
  return page.evaluate(() => {
    const bar = document.getElementById("qa-playbar");
    const left = bar.querySelector(".qa-when-left");
    const shown = (el) => !!(el && !el.hidden && el.getClientRects().length && el.getBoundingClientRect().height > 0);
    const b = bar.getBoundingClientRect(), r = left && left.getBoundingClientRect();
    const back = bar.querySelector(".qa-close").getBoundingClientRect();
    return {
      left: shown(left) ? left.textContent : null,
      ring: shown(bar.querySelector(".qa-gauge")),
      insideBar: !!r && r.left >= b.left - 0.5 && r.right <= b.right + 0.5 && r.top >= b.top - 0.5 && r.bottom <= b.bottom + 0.5,
      sameRow: !!r && Math.abs((r.top + r.bottom) / 2 - (back.top + back.bottom) / 2) <= back.height / 2,
      whole: !!left && left.scrollWidth <= left.clientWidth + 1,
      sideways: document.documentElement.scrollWidth - innerWidth,
    };
  });
}

/** One event card's countdown line (`text`) and date line (`time`), by the event's id. */
async function cardLeft(page, compId) {
  return page.evaluate((id) => {
    const card = document.querySelector(`#comp-grid .comp-card[data-comp-id="${id}"]`);
    if (!card) return null;
    const cd = card.querySelector(".comp-countdown"), t = card.querySelector(".comp-time");
    const c = card.getBoundingClientRect(), rt = t && t.getBoundingClientRect();
    return {
      text: cd.textContent, time: t ? t.textContent : null, card: card.innerText, status: card.dataset.status,
      timeWhole: !!t && t.scrollWidth <= t.clientWidth + 1 && rt.right <= c.right + 0.5,
    };
  }, compId);
}

/** The open-ended card and the dated control's, read in ONE snapshot once the
 *  control's countdown is painted: every card's countdown is written by the
 *  same render pass, so an empty line read here is not an unpainted one. */
async function openAndDatedCards(page, openId, datedId) {
  let snap = null;
  await expect.poll(async () => {
    snap = await page.evaluate(([a, b]) => {
      const read = (id) => {
        const card = document.querySelector(`#comp-grid .comp-card[data-comp-id="${id}"]`);
        if (!card) return null;
        const t = card.querySelector(".comp-time");
        return { text: card.querySelector(".comp-countdown").textContent, time: t ? t.textContent : null, card: card.innerText };
      };
      return { open: read(a), dated: read(b) };
    }, [openId, datedId]);
    return !!(snap.open && snap.dated && snap.dated.text && snap.open.time);
  }, { timeout: 10000, message: "both cards are painted, the dated one's countdown included" }).toBe(true);
  return snap;
}

const visibleText = (page) => page.evaluate(() => document.body.innerText);

/** Sign in, land in the participant's only event, and wait for its challenges. */
async function landInEvent(page, email) {
  await loginViaApi(page, email, PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator("#task-grid .task-card").first().waitFor({ state: "visible", timeout: 30000 });
}

async function openChallenge(page, taskId) {
  await page.evaluate((id) => window.openTask(id), taskId);
  await page.locator("#task-detail-page.active #qa-playbar").waitFor({ state: "visible", timeout: 15000 });
}

let fx;
test.beforeAll(async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const t0 = Date.now();
    const program = (label, deadlineMs) => makeCompetition(sa, csrf, label, {
      event_kind: "program", start_time: new Date(t0 - HOUR).toISOString(), timezone: "UTC",
      deadline_at: new Date(deadlineMs).toISOString(), duration_minutes: undefined,
    });
    // "No fixed deadline" in the event form fills a date ten years out.
    const open = await program("oe-open", t0 + 3652 * DAY);
    const dated = await program("oe-dated", t0 + 12 * DAY + 5 * HOUR);
    const closed = await program("oe-closed", t0 + 3652 * DAY);
    const moved = await program("oe-moved", t0 + 3652 * DAY);
    // Not started yet: what it counts down to is its START, which is real.
    const upcoming = await makeCompetition(sa, csrf, "oe-upcoming", {
      event_kind: "program", start_time: new Date(t0 + 2 * DAY + 5 * HOUR).toISOString(), timezone: "UTC",
      deadline_at: new Date(t0 + 3652 * DAY).toISOString(), duration_minutes: undefined,
    });
    const booth = await makeCompetition(sa, csrf, "oe-booth", { event_kind: "booth" });
    const tour = await makeCompetition(sa, csrf, "oe-tour");
    const events = { open, dated, closed, moved, upcoming, booth, tour };
    // Two challenges each, so the bar draws its track and one answer ends nothing.
    const tasks = {};
    for (const [k, ev] of Object.entries(events)) {
      tasks[k] = [];
      for (const n of ["a", "b"]) {
        const t = await makeTask(sa, csrf, `oe-${k}-${n}`);
        await assignTask(sa, csrf, t.id, [ev.id]);
        tasks[k].push(t);
      }
    }
    const P = (label) => makeParticipant(sa, csrf, label);
    const people = {
      apiP: await P("oe-api"), lister: await P("oe-list"),
      openNarrow: await P("oe-open-390"), openWide: await P("oe-open-1440"),
      datedP: await P("oe-dated-p"), boothP: await P("oe-booth-p"), tourP: await P("oe-tour-p"),
      movedP: await P("oe-moved-p"), upcomingP: await P("oe-upcoming-p"), idle: await P("oe-idle"),
    };
    const all = [people.apiP.id, people.lister.id, people.idle.id];
    await enrol(sa, csrf, open.id, [...all, people.openNarrow.id, people.openWide.id]);
    await enrol(sa, csrf, dated.id, [...all, people.datedP.id]);
    await enrol(sa, csrf, closed.id, all);
    await enrol(sa, csrf, moved.id, [people.movedP.id, people.idle.id]);
    await enrol(sa, csrf, upcoming.id, [people.apiP.id, people.lister.id, people.upcomingP.id, people.idle.id]);
    await enrol(sa, csrf, booth.id, [...all, people.boothP.id]);
    await enrol(sa, csrf, tour.id, [...all, people.tourP.id]);
    // Closed AFTER the enrolment: an ended event refuses assign. Its stored
    // deadline stays a decade out (End Now writes ended_at, not deadline_at).
    const end = await sa.post(`/api/admin/competitions/${closed.id}/end-now`, { headers: H(csrf) });
    expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();
    fx = { ...events, tasks, ...people };
  } finally { await sa.dispose(); }
});

test("the pattern that finds a ten-year countdown matches each surface's old wording", () => {
  // The negative assertions below are only as good as this pattern.
  for (const s of ["3652 days left", "3653d 23:59:59", "Day 1 of 3653"]) expect(s, s).toMatch(TEN_YEARS);
  for (const s of ["12 days left", "12d 04:59:59", "Day 1 of 13", "9 h 58 min left", WORDS]) expect(s, s).not.toMatch(TEN_YEARS);
});

test("the participant wire carries the server's open_ended: true only for an open-ended Program that has not closed", async () => {
  // The closed Program is the case a deadline-keyed rule gets wrong: its stored
  // deadline is still a decade out.
  const { api: sa } = await apiLogin("superadmin");
  try {
    const rows = await (await sa.get("/api/admin/competitions")).json();
    const closed = rows.find((c) => c.id === fx.closed.id);
    expect(closed && closed.ended_at, "the closed Program is closed").toBeTruthy();
    expect(new Date(closed.deadline_at).getTime() - Date.now(), "and its stored deadline is still a decade out")
      .toBeGreaterThan(1826 * DAY);
  } finally { await sa.dispose(); }

  const want = { open: true, dated: false, closed: false, booth: false, tour: false };
  const { api, csrf } = await apiLogin(fx.apiP.email, PARTICIPANT_PASS);
  try {
    // The event rows: GET /api/my-competitions and GET /api/me (the login answer
    // is built by the same list builder).
    const mine = await (await api.get("/api/my-competitions")).json();
    const me = await (await api.get("/api/me")).json();
    for (const [k, v] of Object.entries(want)) {
      const row = mine.find((c) => c.id === fx[k].id), meRow = (me.competitions || []).find((c) => c.id === fx[k].id);
      expect(row && row.open_ended, `${k}: /api/my-competitions open_ended`).toBe(v);
      expect(meRow && meRow.open_ended, `${k}: /api/me competitions[].open_ended`).toBe(v);
    }
    // Open-ended describes the deadline, not the status: one not started yet is too.
    expect(mine.find((c) => c.id === fx.upcoming.id).open_ended, "the upcoming open-ended Program").toBe(true);
    // The status body and the pulse that carries it, per event.
    for (const [k, v] of Object.entries(want)) {
      const sel = await api.post("/api/select-competition", { headers: H(csrf), data: { competitionId: fx[k].id } });
      expect(sel.ok(), `${k}: select ${sel.status()} ${await sel.text()}`).toBeTruthy();
      const st = await (await api.get("/api/status")).json();
      expect(st.open_ended, `${k}: GET /api/status open_ended (${JSON.stringify(st)})`).toBe(v);
      const pulse = await (await api.get("/api/participant/pulse")).json();
      expect(pulse.status && pulse.status.open_ended, `${k}: the pulse's status.open_ended`).toBe(v);
    }
  } finally { await api.dispose(); }
});

for (const width of WIDTHS) {
  test(`the events list says "${WORDS}" for the open-ended Program, beside its controls, at ${width} px`, async ({ page }) => {
    await page.setViewportSize(viewport(width));
    await loginViaApi(page, fx.lister.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.locator(`#comp-grid .comp-card[data-comp-id="${fx.open.id}"]`).waitFor({ state: "visible", timeout: 30000 });
    // SAID ONCE on the card (operator ruling, 14 Nov 2026): as the end of its
    // date line (tests/open-ended-dates.spec.js), and its countdown line stays
    // empty. Read beside the dated control's painted countdown (one snapshot).
    const snap = await openAndDatedCards(page, fx.open.id, fx.dated.id);
    expect(snap.open.time, `the date line ends with the words: ${snap.open.card}`).toMatch(new RegExp(` → ${WORDS}$`));
    expect(snap.open.text, `the countdown line stays empty: ${snap.open.card}`).toBe("");
    expect(snap.open.card.split(WORDS).length - 1, `the words once on the card: ${snap.open.card}`).toBe(1);
    expect(snap.open.card, "and no ten-year countdown").not.toMatch(TEN_YEARS);
    const open = await cardLeft(page, fx.open.id);
    expect(open.timeWhole, "the date line fits the card").toBe(true);
    // CONTROLS: the dated Program, the Booth Event and the Competition count down.
    expect(snap.dated.text, "a Program twelve days out: its countdown line counts down").toBe("12 days left");
    expect(snap.dated.card, "and does not say the words").not.toContain(WORDS);
    // The words replace the time LEFT only: an open-ended Program not started yet
    // still counts down to its start.
    const soon = await cardLeft(page, fx.upcoming.id);
    expect(soon.text, "the upcoming open-ended Program").toBe("Starts in 2 days");
    for (const k of ["booth", "tour"]) {
      const c = await cardLeft(page, fx[k].id);
      expect(c.text, `${k}: its window's time left`).toMatch(/^\d+ h( \d+ min)? left$/);
    }
    expect(await visibleText(page), "nothing on the list counts ten years down").not.toMatch(TEN_YEARS);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no sideways scroll").toBeLessThanOrEqual(0);

    // The closed Program, under All, shows what an ended event always showed:
    // its Ended badge and no time at all.
    expect(await cardLeft(page, fx.closed.id), "an ended event is filtered out by default").toBeNull();
    await page.locator('#comp-filters [data-action="set-comp-filter"][data-value="all"]').click();
    let closed = null;
    await expect.poll(async () => { closed = await cardLeft(page, fx.closed.id); return closed && closed.status; },
      { timeout: 10000 }).toBe("ended");
    expect(closed.text, "no countdown on an ended event").toBe("");
    expect(closed.card, "and not the open-ended words").not.toContain(WORDS);
  });

  test(`the open-ended Program's header and play bar say "${WORDS}", with no day chip, at ${width} px`, async ({ page }) => {
    await page.setViewportSize(viewport(width));
    const who = width < 768 ? fx.openNarrow : fx.openWide;
    await landInEvent(page, who.email);
    let h = null;
    await expect.poll(async () => { h = await header(page); return h.timer; },
      { timeout: 10000, message: "the header countdown is painted" }).toBe(WORDS);
    expect(h.timerShown, "the header shows it on the challenges list").toBe(true);
    expect(h.timerWhole, `the whole words, not an ellipsis: ${JSON.stringify(h)}`).toBe(true);
    expect(h.dayHidden, `no "Day N of 3653" chip: ${JSON.stringify(h)}`).toBe(true);
    expect(h.day).toBe("");

    await openChallenge(page, fx.tasks.open[0].id);
    let m = null;
    await expect.poll(async () => { m = await playBar(page); return m.left; },
      { timeout: 10000, message: "the play bar readout is painted" }).toBe(WORDS);
    expect(m.ring, "a Program's bar draws no ring").toBe(false);
    expect(m.insideBar, `inside the play bar: ${JSON.stringify(m)}`).toBe(true);
    expect(m.sameRow, `in the bar's row: ${JSON.stringify(m)}`).toBe(true);
    expect(m.whole, `the whole words: ${JSON.stringify(m)}`).toBe(true);
    expect(m.sideways, "no sideways scroll").toBeLessThanOrEqual(0);
    // A laptop keeps the header countdown beside the bar; a phone hides the header.
    h = await header(page);
    expect(h.timer, "the header says the same words").toBe(WORDS);
    if (width >= 768) expect(h.timerShown, "the header stays on a wide screen").toBe(true);
    expect(await visibleText(page), "nothing in the challenge view counts ten years down").not.toMatch(TEN_YEARS);

    // Back to the list: the card says the words once, on its date line (its
    // countdown line empty), and the progress strip (a Program's row is the
    // track and Continue) shows no time either.
    await page.locator("#task-detail-page.active .qa-close").click();
    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#nav-competitions").click();
    await page.locator(`#comp-grid .comp-card[data-comp-id="${fx.open.id}"]`).waitFor({ state: "visible", timeout: 15000 });
    let card = null;
    await expect.poll(async () => { card = await cardLeft(page, fx.open.id); return card && card.time; }, { timeout: 10000 })
      .toMatch(new RegExp(` → ${WORDS}$`));
    expect(card.text, "the countdown line stays empty").toBe("");
    expect(card.card.split(WORDS).length - 1, `the words once on the card: ${card.card}`).toBe(1);
    const strip = page.locator(`#ev-progress .ev-prog[data-comp-id="${fx.open.id}"]`);
    await expect(strip, "the run is on the progress strip").toBeVisible({ timeout: 10000 });
    const stripText = await strip.innerText();
    expect(stripText, "the strip row shows no time").not.toMatch(/\bleft\b|\d+d\b|No fixed deadline/);
    expect(await visibleText(page), "nothing on the list counts ten years down").not.toMatch(TEN_YEARS);
  });

  test(`CONTROL: a Program twelve days out still counts down in the header and the play bar at ${width} px`, async ({ page }) => {
    await page.setViewportSize(viewport(width));
    await landInEvent(page, fx.datedP.email);
    let h = null;
    await expect.poll(async () => { h = await header(page); return h.timer; }, { timeout: 10000 })
      .toMatch(/^12d \d\d:\d\d:\d\d$/);
    // Written by the same tick as the countdown; a phone hides it with CSS.
    expect(h.day, "the day chip counts the real span").toBe("Day 1 of 13");
    expect(h.dayHidden).toBe(false);
    await openChallenge(page, fx.tasks.dated[0].id);
    let m = null;
    await expect.poll(async () => { m = await playBar(page); return m.left; }, { timeout: 10000 }).toBe("12 days left");
    expect(m.ring).toBe(false);
    expect(await visibleText(page), "the open-ended words are not used").not.toContain(WORDS);
  });

  for (const kind of ["booth", "tour"]) {
    test(`CONTROL: a ${kind === "booth" ? "Booth Event" : "Competition"} keeps its countdown and ring at ${width} px`, async ({ page }) => {
      await page.setViewportSize(viewport(width));
      await landInEvent(page, fx[`${kind}P`].email);
      let h = null;
      await expect.poll(async () => { h = await header(page); return h.timer; }, { timeout: 10000 })
        .toMatch(/^\d\d:\d\d:\d\d$/);
      await openChallenge(page, fx.tasks[kind][0].id);
      let m = null;
      await expect.poll(async () => { m = await playBar(page); return m.ring; }, { timeout: 10000 }).toBe(true);
      expect(m.left, "no words beside the ring").toBeNull();
      expect(await visibleText(page), "the open-ended words are not used").not.toContain(WORDS);
    });
  }

  test(`CONTROL: an open-ended Program not started yet counts down to its start on the waiting page at ${width} px`, async ({ page }) => {
    await page.setViewportSize(viewport(width));
    await loginViaApi(page, fx.upcomingP.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.locator("#pending-page.active").waitFor({ state: "visible", timeout: 30000 });
    await expect.poll(() => page.locator("#pending-countdown").textContent(), { timeout: 10000 })
      .toMatch(/^2d \d\dh \d\dm \d\ds$/);
    const text = await visibleText(page);
    expect(text, "no open-ended words on the waiting page").not.toContain(WORDS);
    expect(text, "and no ten-year countdown").not.toMatch(TEN_YEARS);
  });
}

test(`a deadline moved in reads as a countdown at the next pulse, in the header and the play bar`, async ({ page }) => {
  // The failure a stored flag would have: "No fixed deadline" announced over an
  // event that now closes in twelve days. The verdict is re-read with the end.
  await page.setViewportSize(viewport(1440));
  await landInEvent(page, fx.movedP.email);
  await openChallenge(page, fx.tasks.moved[0].id);
  await expect.poll(async () => (await playBar(page)).left, { timeout: 10000 }).toBe(WORDS);
  expect((await header(page)).timer).toBe(WORDS);

  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const put = await sa.put(`/api/admin/competitions/${fx.moved.id}`, {
      headers: H(csrf), data: { deadline_at: new Date(Date.now() + 12 * DAY + 5 * HOUR).toISOString() },
    });
    expect(put.ok(), `move the deadline in: ${put.status()} ${await put.text()}`).toBeTruthy();
  } finally { await sa.dispose(); }

  // The pulse the open challenge runs anyway, now rather than in fifteen seconds.
  // It only writes the state: the bar and the header each repaint from it on
  // their own one-second tick, in either order, so each is polled (one read of
  // the second can land between the two ticks and see the old words).
  await page.evaluate(() => window._pulseTick());
  await expect.poll(async () => (await playBar(page)).left, { timeout: 10000, message: "the bar follows the pulse" })
    .toBe("12 days left");
  let h = null;
  await expect.poll(async () => { h = await header(page); return h.timer; },
    { timeout: 10000, message: "the header follows the pulse and counts down again" }).toMatch(/^12d \d\d:\d\d:\d\d$/);
  // The same tick writes the day chip: read from that one snapshot.
  expect(h.day, "and its day chip is back").toBe("Day 1 of 13");
  expect(h.dayHidden).toBe(false);
  expect(await visibleText(page)).not.toContain(WORDS);
});
