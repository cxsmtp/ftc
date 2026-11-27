// @ts-check
//
// "NO FIXED DEADLINE" FOR AN OPEN-ENDED PROGRAM'S END DATE, AND ON THE
// ORGANISER'S SCREENS (operator rulings, 14 Nov 2026).
//
// A Program created with "No fixed deadline" stores a deadline ten years out.
// The participant's countdowns already said "No fixed deadline"
// (tests/open-ended-program.spec.js); two kinds of surface still printed the
// placeholder:
//   1. the END DATE: the participant's event card read "<start> → <a date in
//      2036>" (and the assignment and invitation mails "Ends: <2036>", locked in
//      tests/schedule-arithmetic-email.spec.js);
//   2. the ORGANISER's screens: the workspace status chip read "Live · 3651d
//      23:59:59 left", the Overview's time tile "Until the deadline · 3651
//      days", the Events list and the workspace's dates line the 2036 date, and
//      the Start now confirm "Deadline (preserved): <2036>".
// The ruling: each says "No fixed deadline" (a date range keeps its start; the
// time tile keeps its place and shape), and the participant's card says it
// once: its date line carries the words and its countdown line stays empty
// while it is live (a ruling of the same day). ONE definition: the server's
// isOpenEnded, per read, as `open_ended` on the participant rows AND the admin
// list rows; the client only reads it (ui/format.js NO_FIXED_DEADLINE,
// eventEndText). The flip arm, which inverts the field in flight, is the
// witness that each organiser surface reads the field and not a date rule.
//
// By value, at a phone and a desktop width, each beside its controls: a Program
// twelve days out shows its date and its countdown; a CLOSED Program whose
// stored deadline is still a decade out is not open-ended and shows its real
// close; a Booth Event is unchanged; an open-ended Program not started yet
// keeps its start (the words replace the END only).
const fs = require("fs");
const path = require("path");
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, BASE } = require("./helpers");
const { loginViaApi, adminLogin, clickTab, filterComps, viewComp, openKebab, showAllTableColumns, EVENT_ALL_COLUMNS, openCompCreateForm } = require("./ui-admin-helpers");
const { makeParticipant, makeCompetition, enrol, uniq } = require("./event-admin-helpers");
const { stripJsComments } = require("./doc-registry");

test.use({ baseURL: BASE });

const ROOT = path.resolve(__dirname, "..");
const DAY = 86400e3, HOUR = 3600e3;
const WIDTHS = [390, 1440];
const WORDS = "No fixed deadline";
const H = (csrf) => ({ "x-csrf-token": csrf, "content-type": "application/json" });
const iso = (ms) => new Date(ms).toISOString();
const viewport = (width) => ({ width, height: width >= 768 ? 900 : 800 });
// A decade-long countdown on any surface: "3651 days", "3651d 23:59:59",
// "Day 1 of 3653". A positive control on the pattern is the first test below.
const TEN_YEARS = /\b\d{3,} days\b|\b\d{3,}d \d\d:\d\d:\d\d\b|\bDay \d+ of \d{3,}\b/;
// A date in the placeholder's year, as any locale prints one ("Nov 13, 2036",
// "13.11.2036", "2036/11/13"), never the same digits inside a name: fixture
// names and nicknames carry Date.now() stamps (…1794612620363…) and the
// worker's pid as a hyphenated part (uniq()), so a bare substring test fails
// whenever their digits spell the year. Controls: the first test below, and
// each page's own fmtDt of the placeholder in the arms that use it.
const yearRe = (year) => new RegExp(`(?<![\\w-])${year}(?![\\w-])`);

let fx;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const t0 = Date.now();
    const program = (label, startMs, deadlineMs) => makeCompetition(sa, csrf, label, {
      event_kind: "program", start_time: iso(startMs), timezone: "UTC",
      deadline_at: iso(deadlineMs), duration_minutes: undefined,
    });
    // "No fixed deadline" in the event form fills a date ten years out.
    const open = await program("oed-open", t0 - HOUR, t0 + 3652 * DAY);
    // Not started yet: its START is real, and the words replace only the end.
    const soon = await program("oed-soon", t0 + 2 * DAY + 5 * HOUR, t0 + 3652 * DAY);
    // Not started yet either, with a real deadline: Start now's control.
    const soonDated = await program("oed-soon-dated", t0 + 2 * DAY + 5 * HOUR, t0 + 14 * DAY + 5 * HOUR);
    const dated = await program("oed-dated", t0 - HOUR, t0 + 12 * DAY + 5 * HOUR);
    // Closed with End Now below: its stored deadline stays a decade out.
    const closed = await program("oed-closed", t0 - HOUR, t0 + 3652 * DAY);
    // Moved in by the API test: the verdict is re-read, never stored.
    const moved = await program("oed-moved", t0 - HOUR, t0 + 3652 * DAY);
    const booth = await makeCompetition(sa, csrf, "oed-booth", { event_kind: "booth" });
    const tour = await makeCompetition(sa, csrf, "oed-tour");
    // The reopen lock's own pair: a live Competition, then one not started yet.
    const reLive = await makeCompetition(sa, csrf, "oed-re-live");
    const reSoon = await makeCompetition(sa, csrf, "oed-re-soon", { start_time: iso(t0 + DAY), duration_minutes: 120 });
    const P = (label) => makeParticipant(sa, csrf, label);
    const people = { narrow: await P("oed-390"), wide: await P("oed-1440") };
    const both = [people.narrow.id, people.wide.id];
    for (const ev of [open, soon, dated, closed, booth]) await enrol(sa, csrf, ev.id, both);
    // An ended event refuses assign, so it is closed after the enrolment.
    const end = await sa.post(`/api/admin/competitions/${closed.id}/end-now`, { headers: H(csrf) });
    expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();
    // The stored schedule of each, as the server holds it (the client prints it).
    const rows = await (await sa.get("/api/admin/competitions")).json();
    const events = { open, soon, soonDated, dated, closed, moved, booth, tour };
    for (const [k, ev] of Object.entries(events)) {
      const r = rows.find((c) => c.id === ev.id);
      expect(r, `${k}: listed`).toBeTruthy();
      Object.assign(ev, { start_time: r.start_time, duration_minutes: r.duration_minutes, deadline_at: r.deadline_at, ended_at: r.ended_at });
    }
    const placeholderYear = String(new Date(t0 + 3652 * DAY).getUTCFullYear());
    fx = { ...events, ...people, reLive, reSoon, placeholderYear, placeholderRe: yearRe(placeholderYear) };
  } finally { await sa.dispose(); }
});

/** The end of an event as the client computes it from its row (start + duration, or the close). */
const endIso = (ev) => ev.ended_at || iso(new Date(ev.start_time).getTime() + ev.duration_minutes * 60000);

/** fmtDt, the app's one date formatter, in the page's own locale and zone. */
const fmt = (page, at, shape) => page.evaluate(([v, s]) => window.fmtDt(new Date(v), s), [at, shape]);

/** Every word of `el`'s text sits on one line: wrapped at spaces, never mid-word. */
const WORDS_WHOLE = (el) => {
  const node = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
  if (!node) return false;
  const text = node.textContent;
  let at = 0;
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const i = text.indexOf(w, at); at = i + w.length;
    const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + w.length);
    const lines = new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)));
    if (lines.size !== 1) return false;
  }
  return true;
};

test("the pattern that finds a ten-year countdown matches each surface's old wording", () => {
  // The negative assertions below are only as good as this pattern.
  for (const s of ["Live · 3651d 23:59:59 left", "3651 days", "Day 1 of 3653"]) expect(s, s).toMatch(TEN_YEARS);
  for (const s of ["Live · 12d 04:59:59 left", "12 days", "Day 1 of 13", "9 h 58 min", WORDS]) expect(s, s).not.toMatch(TEN_YEARS);
  // The year probe: a printed date in any common shape, never a name's digits.
  const y = yearRe("2036");
  for (const s of ["Nov 13, 2036, 10:06 AM", "13/11/2036, 10:06", "13.11.2036 10:06", "2036/11/13", "Deadline (preserved): Nov 13, 2036"]) expect(s, s).toMatch(y);
  for (const s of ["ea_oed_390_1794612620363_5045_11 joined", "EA oed-open-1794612036305-5045-1", "EA oed-open-1794612620305-2036-1", "Nov 13, 2035", WORDS]) expect(s, s).not.toMatch(y);
});

test("SOURCE: the mails and the screens say the same words, each defined once", () => {
  const read = (p) => stripJsComments(fs.readFileSync(path.join(ROOT, p), "utf8"));
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith(".js") ? [`${dir}/${e.name}`] : []);
  const DEF = /\bNO_FIXED_DEADLINE\s*=\s*(['"])([^'"]*)\1/g;
  const defs = (files) => files.flatMap((f) => [...read(f).matchAll(DEF)].map((m) => ({ f, words: m[2] })));
  const client = defs(walk("public/js"));
  const server = defs(["server.js", ...walk("lib"), ...walk("routes")]);
  expect(client.map((d) => d.f), "the screens' words are defined once, in ui/format.js").toEqual(["public/js/ui/format.js"]);
  expect(server.map((d) => d.f), "the mails' words are defined once, in lib/competitions.js").toEqual(["lib/competitions.js"]);
  expect(client[0].words, "the words themselves").toBe(WORDS);
  expect(server[0].words, "a mail says what the screen says").toBe(client[0].words);
  // ONE definition of open-ended: the server's. The event form keeps the one
  // registered client copy of the threshold (it judges a deadline being typed),
  // and no other client module names it. This cannot see a second definition
  // inside that module (the Events list and the workspace's status chip live
  // there too): the flip arm below is the witness for those.
  const thresholdUsers = walk("public/js").filter((f) => /\bOPEN_ENDED_THRESHOLD_DAYS\b|\b1826\b/.test(read(f)));
  expect(thresholdUsers, "no other client module names the threshold").toEqual(["public/js/features/competitions-admin.js"]);
});

test("GET /api/admin/competitions carries the server's open_ended: true only for an open-ended Program that has not closed", async () => {
  const { api: sa } = await apiLogin("superadmin");
  try {
    const rows = await (await sa.get("/api/admin/competitions")).json();
    const row = (k) => rows.find((c) => c.id === fx[k].id);
    // The closed Program is the case a deadline-keyed rule gets wrong.
    expect(row("closed").ended_at, "the closed Program is closed").toBeTruthy();
    expect(new Date(row("closed").deadline_at).getTime() - Date.now(), "and its stored deadline is still a decade out")
      .toBeGreaterThan(1826 * DAY);
    const want = { open: true, soon: true, soonDated: false, dated: false, closed: false, moved: true, booth: false, tour: false };
    for (const [k, v] of Object.entries(want)) expect(row(k).open_ended, `${k}: open_ended`).toBe(v);
    // On every row, as a boolean: `false` is said, never left out.
    for (const r of rows) expect(typeof r.open_ended, `${r.name}: open_ended is a boolean`).toBe("boolean");
  } finally { await sa.dispose(); }
});

test("a deadline moved in reads open_ended false at the next admin list read: the verdict is never stored", async () => {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const read = async () => (await (await sa.get("/api/admin/competitions")).json()).find((c) => c.id === fx.moved.id);
    expect((await read()).open_ended, "precondition: open-ended").toBe(true);
    const put = await sa.put(`/api/admin/competitions/${fx.moved.id}`, {
      headers: H(csrf), data: { deadline_at: iso(Date.now() + 12 * DAY + 5 * HOUR) },
    });
    expect(put.ok(), `move the deadline in: ${put.status()} ${await put.text()}`).toBeTruthy();
    const after = await read();
    expect(after.open_ended, "twelve days out is a real deadline").toBe(false);
    expect(after.status, "and the event is still live").toBe("live");
  } finally { await sa.dispose(); }
});

/** One participant card's date line (`time`) and countdown line (`left`), by the event's id. */
async function cardTime(page, compId) {
  return page.evaluate((id) => {
    const card = document.querySelector(`#comp-grid .comp-card[data-comp-id="${id}"]`);
    if (!card) return null;
    const t = card.querySelector(".comp-time");
    const left = card.querySelector(".comp-countdown").textContent;
    if (!t) return { time: null, left, card: card.innerText };
    const r = t.getBoundingClientRect(), c = card.getBoundingClientRect();
    return {
      time: t.textContent, left, card: card.innerText, status: card.dataset.status,
      shown: r.height > 0 && getComputedStyle(t).display !== "none",
      fits: t.scrollWidth <= t.clientWidth + 1 && r.right <= c.right + 0.5 && r.left >= c.left - 0.5,
    };
  }, compId);
}

for (const width of WIDTHS) {
  test(`participant: the open-ended Program's card says "<start> → ${WORDS}", beside its controls, at ${width} px`, async ({ page }) => {
    await page.setViewportSize(viewport(width));
    const who = width < 768 ? fx.narrow : fx.wide;
    await loginViaApi(page, who.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.locator(`#comp-grid .comp-card[data-comp-id="${fx.open.id}"]`).waitFor({ state: "visible", timeout: 30000 });
    let open = null;
    await expect.poll(async () => { open = await cardTime(page, fx.open.id); return open && open.time; },
      { timeout: 10000, message: "the open-ended Program's card is painted" })
      .toBe(`${await fmt(page, fx.open.start_time, "long")} → ${WORDS}`);
    expect(open.shown, "the date line is on the card").toBe(true);
    expect(open.fits, `the line fits its card: ${JSON.stringify(open)}`).toBe(true);
    expect(await page.locator(`#comp-grid .comp-card[data-comp-id="${fx.open.id}"] .comp-time`).evaluate(WORDS_WHOLE),
      `the words wrap at spaces, never mid-word: ${JSON.stringify(open)}`).toBe(true);
    expect(open.card, "no placeholder date anywhere on the card").not.toMatch(fx.placeholderRe);
    expect(await fmt(page, endIso(fx.open), "long"), "CONTROL: the year probe finds the placeholder as this page prints it").toMatch(fx.placeholderRe);
    expect(open.card, "and no ten-year countdown").not.toMatch(TEN_YEARS);
    // SAID ONCE on the card (operator ruling, 14 Nov 2026): the date line carries
    // the words and the countdown line stays empty.
    expect(open.left, `the countdown line stays empty: ${open.card}`).toBe("");
    expect(open.card.split(WORDS).length - 1, `the words once, on the date line: ${open.card}`).toBe(1);

    // Not started yet: the START is kept, the end is the words.
    const soon = await cardTime(page, fx.soon.id);
    expect(soon.time, "the upcoming open-ended Program").toBe(`${await fmt(page, fx.soon.start_time, "long")} → ${WORDS}`);
    expect(soon.card).not.toMatch(fx.placeholderRe);

    // CONTROLS: the dated Program and the Booth Event print their real end.
    const dated = await cardTime(page, fx.dated.id);
    expect(dated.time, "a Program twelve days out prints its deadline")
      .toBe(`${await fmt(page, fx.dated.start_time, "long")} → ${await fmt(page, endIso(fx.dated), "long")}`);
    expect(dated.left, "and its countdown line still counts down").toBe("12 days left");
    expect(dated.card).not.toContain(WORDS);
    const booth = await cardTime(page, fx.booth.id);
    expect(booth.time, "a Booth Event is unchanged")
      .toBe(`${await fmt(page, fx.booth.start_time, "long")} → ${await fmt(page, endIso(fx.booth), "long")}`);
    expect(booth.card).not.toContain(WORDS);
    expect(await page.evaluate(() => document.body.innerText), "nothing on the list prints the placeholder date")
      .not.toMatch(fx.placeholderRe);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no sideways scroll").toBeLessThanOrEqual(0);

    // CONTROL: the CLOSED Program (under All) prints when it really closed —
    // never the words, never its stored decade-out deadline.
    expect(await cardTime(page, fx.closed.id), "an ended event is filtered out by default").toBeNull();
    await page.locator('#comp-filters [data-action="set-comp-filter"][data-value="all"]').click();
    let closed = null;
    await expect.poll(async () => { closed = await cardTime(page, fx.closed.id); return closed && closed.status; },
      { timeout: 10000 }).toBe("ended");
    expect(closed.time, "an ended Program is unchanged: start → its close")
      .toBe(`${await fmt(page, fx.closed.start_time, "long")} → ${await fmt(page, fx.closed.ended_at, "long")}`);
    expect(closed.card).not.toContain(WORDS);
    expect(closed.card).not.toMatch(fx.placeholderRe);
  });
}

// THE ONE DEFINITION, participant side: the card reads the server's
// `open_ended`, never a date rule (one that names neither the threshold nor
// 1826 escapes the SOURCE arm). The field is flipped in flight on every read
// that fills the list: the decade-out Program arrives `false`, the dated one
// `true`, and the card must follow the field.
test("participant: the event card follows the server's open_ended, never the date", async ({ page }) => {
  const FLIP = { [fx.open.id]: false, [fx.dated.id]: true };
  const served = {};
  const flip = (rows) => { for (const r of rows || []) if (Object.prototype.hasOwnProperty.call(FLIP, r.id)) { if (!(r.id in served)) served[r.id] = r.open_ended; r.open_ended = FLIP[r.id]; } };
  await page.route(/\/api\/(?:me|my-competitions)(?:\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    if (!res.ok()) return route.fulfill({ response: res });
    const body = await res.json();
    flip(Array.isArray(body) ? body : body.competitions);
    await route.fulfill({ response: res, json: body });
  });
  await page.setViewportSize(viewport(1440));
  await loginViaApi(page, fx.wide.email, PARTICIPANT_PASS);
  await page.goto("/");
  await page.locator(`#comp-grid .comp-card[data-comp-id="${fx.dated.id}"]`).waitFor({ state: "visible", timeout: 30000 });
  // PRECONDITIONS: the server said the opposite of each flip, and the page holds the flip.
  expect(served, "the server's own verdicts").toEqual({ [fx.open.id]: true, [fx.dated.id]: false });
  expect(await page.evaluate((ids) => ids.map((id) => ((window.S && window.S.myCompetitions) || []).find((c) => c.id === id)?.open_ended),
    [fx.open.id, fx.dated.id]), "the model holds the flipped field").toEqual([false, true]);
  // The decade-out Program, arriving `false`: its stored end and its countdown.
  let open = null;
  await expect.poll(async () => { open = await cardTime(page, fx.open.id); return open && open.time; }, { timeout: 10000 })
    .toBe(`${await fmt(page, fx.open.start_time, "long")} → ${await fmt(page, endIso(fx.open), "long")}`);
  expect(open.time, "CONTROL: the year probe finds it").toMatch(fx.placeholderRe);
  expect(open.left, "its countdown line counts ten years down").toMatch(/^\d{3,} days left$/);
  expect(open.card, "its ten-year countdown").toMatch(TEN_YEARS);
  expect(open.card).not.toContain(WORDS);
  // The Program twelve days out, arriving `true`: the words once, as the end;
  // its countdown line empty.
  const dated = await cardTime(page, fx.dated.id);
  expect(dated.time).toBe(`${await fmt(page, fx.dated.start_time, "long")} → ${WORDS}`);
  expect(dated.left, `the countdown line follows the field and stays empty: ${dated.card}`).toBe("");
  expect(dated.card.split(WORDS).length - 1, `the words once, on the date line: ${dated.card}`).toBe(1);
});

/** One Events-list row's cells, found by the column's heading (never by position). */
async function eventCells(page, compId) {
  return page.evaluate((id) => {
    const tr = document.querySelector(`#admin-comp-body td.ev-name-cell[data-comp-id="${CSS.escape(id)}"]`)?.closest("tr");
    if (!tr) return null;
    const ths = [...document.querySelectorAll("#admin-comp-table thead tr:first-child th")];
    const cell = (col) => { const i = ths.findIndex((th) => th.dataset.col === col); return i < 0 ? null : tr.cells[i]; };
    const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none";
    const end = cell("end"), dur = cell("duration");
    return { end: end && end.textContent.trim(), endShown: shown(end), duration: dur && dur.textContent.trim(), row: tr.innerText };
  }, compId);
}

/** The open workspace's status chip, time tile and dates line, by value. */
async function workspace(page) {
  return page.evaluate(() => {
    const shown = (el) => !!el && el.getClientRects().length > 0 && el.getBoundingClientRect().height > 0;
    const chip = document.querySelector("#admin-scope-banner .ws-status-chip");
    const tiles = [...document.querySelectorAll("#ws-kpis .ws-kpi")];
    const hero = document.querySelector("#ws-kpis .ws-kpi-hero");
    const num = hero && hero.querySelector(".ws-kpi-num");
    const fig = num && num.querySelector(".ws-kpi-text, .ws-count");
    const sub = hero && hero.querySelector(".ws-kpi-sub");
    const facts = document.querySelector("#ws-record .ws-fact");
    const band = document.getElementById("ws-kpis");
    return {
      chip: chip && chip.textContent.trim(), chipShown: shown(chip),
      heroFirst: !!hero && tiles[0] === hero, heroKey: hero && hero.dataset.kpiTile,
      label: hero && hero.querySelector(".eyebrow").textContent.trim(),
      figure: fig && fig.textContent.trim(), figureShown: shown(fig),
      figureSize: fig ? parseFloat(getComputedStyle(fig).fontSize) : 0,
      figureFits: !!num && num.scrollWidth <= num.clientWidth + 1 && !!band
        && num.getBoundingClientRect().right <= band.getBoundingClientRect().right + 0.5,
      sub: sub ? sub.textContent.trim() : null,
      bar: !!(hero && hero.querySelector(".ws-kpi-bar")),
      dates: facts && facts.textContent.trim(), datesShown: shown(facts),
      text: ["admin-scope-banner", "ws-record", "ws-kpis"].map((i) => document.getElementById(i)?.innerText || "").join("\n"),
      sideways: document.documentElement.scrollWidth - innerWidth,
    };
  });
}

/** Leave any open workspace for the Events list, then open `ev`'s. */
async function openWorkspace(page, ev) {
  await clickTab(page, "Events");
  await viewComp(page, ev.name);
  await expect(page.locator("#ws-overview"), "the Overview is on screen").toBeVisible({ timeout: 20000 });
}

for (const width of WIDTHS) {
  test(`organiser: the Events list's End and Duration say "${WORDS}" for the open-ended Program, beside its controls, at ${width} px`, async ({ page }) => {
    await page.setViewportSize(viewport(width));
    await adminLogin(page);
    await clickTab(page, "Events");
    await filterComps(page, fx.open.name);
    let open = null;
    await expect.poll(async () => { open = await eventCells(page, fx.open.id); return open && open.end; },
      { timeout: 10000, message: "the open-ended Program's row is painted" }).toBe(WORDS);
    expect(open.endShown, "the End column is a default column").toBe(true);
    expect(open.duration, "its Duration is not a ten-year figure either").toBe(WORDS);
    expect(open.row, "no placeholder date on the row").not.toMatch(fx.placeholderRe);
    expect(await fmt(page, endIso(fx.open), "long"), "CONTROL: the year probe finds the placeholder as this page prints it").toMatch(fx.placeholderRe);
    expect(open.row).not.toMatch(TEN_YEARS);

    await filterComps(page, fx.soon.name);
    const soon = await eventCells(page, fx.soon.id);
    expect(soon.end, "an upcoming open-ended Program").toBe(WORDS);
    expect(soon.row).not.toMatch(fx.placeholderRe);

    // CONTROLS: a dated Program, a closed one and a Booth Event print their dates.
    await filterComps(page, fx.dated.name);
    const dated = await eventCells(page, fx.dated.id);
    expect(dated.end, "a Program twelve days out prints its deadline").toBe(await fmt(page, endIso(fx.dated), "long"));
    expect(dated.duration).toMatch(/^12d \d\d:\d\d:\d\d$/);
    await filterComps(page, fx.closed.name);
    const closed = await eventCells(page, fx.closed.id);
    expect(closed.end, "an ended Program prints its close").toBe(await fmt(page, fx.closed.ended_at, "long"));
    expect(closed.row).not.toContain(WORDS);
    await filterComps(page, fx.booth.name);
    const booth = await eventCells(page, fx.booth.id);
    expect(booth.end, "a Booth Event is unchanged").toBe(await fmt(page, endIso(fx.booth), "long"));
    expect(booth.duration).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no sideways scroll").toBeLessThanOrEqual(0);
  });

  test(`organiser: the open-ended Program's status chip, time tile and dates line say "${WORDS}" at ${width} px`, async ({ page }) => {
    await page.setViewportSize(viewport(width));
    await adminLogin(page);
    await openWorkspace(page, fx.open);
    let w = null;
    await expect.poll(async () => { w = await workspace(page); return w.chip; },
      { timeout: 10000, message: "the status chip is painted" }).toBe(`Live · ${WORDS}`);
    expect(w.chipShown, "the chip is on screen").toBe(true);
    // The time tile keeps its place and shape: first, the hero, a display figure.
    expect(w.heroFirst && w.heroKey, `the time tile leads the band: ${JSON.stringify(w)}`).toBe("time");
    expect(w.label, "its label names what it is about").toBe("Deadline");
    expect(w.figure, "its figure").toBe(WORDS);
    expect(w.figureShown).toBe(true);
    expect(w.figureSize, "a display figure, as every KPI is").toBeGreaterThanOrEqual(28);
    expect(w.figureFits, `the figure fits the band: ${JSON.stringify(w)}`).toBe(true);
    expect(await page.locator("#ws-kpis .ws-kpi-hero .ws-kpi-num .ws-kpi-text").evaluate(WORDS_WHOLE),
      `wrapped at spaces, never mid-word: ${JSON.stringify(w)}`).toBe(true);
    expect(w.sub, "its sub-line says when it started").toBe(`started ${await fmt(page, fx.open.start_time, "long")}`);
    expect(w.bar, "no bar of how much of a placeholder decade has gone").toBe(false);
    expect(w.dates, "the dates line keeps the start").toBe(`${await fmt(page, fx.open.start_time, "long")} – ${WORDS}`);
    expect(w.datesShown).toBe(true);
    expect(w.text, "no placeholder date in the header or the band").not.toMatch(fx.placeholderRe);
    expect(await fmt(page, endIso(fx.open), "long"), "CONTROL: the year probe finds the placeholder as this page prints it").toMatch(fx.placeholderRe);
    expect(w.text, "and no ten-year countdown").not.toMatch(TEN_YEARS);
    expect(w.text).not.toMatch(/\b365[0-3]\b/);
    expect(await page.evaluate(() => document.getElementById("admin-page").innerText), "nowhere on the Overview")
      .not.toMatch(fx.placeholderRe);
    expect(w.sideways, "no sideways scroll").toBeLessThanOrEqual(0);

    // The Settings section's Schedule reads the same dates line.
    await page.locator('#ws-tabs .ws-tab[data-section="admin-event-settings-tab"]').evaluate((el) => el.click());
    const schedule = page.locator("#ws-settings .ws-kv", { has: page.locator("dt", { hasText: "Schedule" }) }).locator("dd");
    await expect(schedule).toHaveText(`${await fmt(page, fx.open.start_time, "long")} – ${WORDS}`, { timeout: 10000 });

    // Not started yet: the tile counts down to the real start; the end is the words.
    await openWorkspace(page, fx.soon);
    await expect.poll(async () => (await workspace(page)).label, { timeout: 10000 }).toBe("Starts in");
    w = await workspace(page);
    expect(w.figure, "the time until the start").toBe("2 days");
    expect(w.chip).toMatch(/^Upcoming · starts in /);
    expect(w.dates).toBe(`${await fmt(page, fx.soon.start_time, "long")} – ${WORDS}`);
    expect(w.text).not.toMatch(fx.placeholderRe);
  });

  test(`CONTROL organiser: a Program twelve days out, an ended Program and a Booth Event keep their countdowns and dates at ${width} px`, async ({ page }) => {
    await page.setViewportSize(viewport(width));
    await adminLogin(page);

    await openWorkspace(page, fx.dated);
    let w = null;
    await expect.poll(async () => { w = await workspace(page); return w.chip; }, { timeout: 10000 })
      .toMatch(/^Live · 12d \d\d:\d\d:\d\d left$/);
    expect(w.label).toBe("Until the deadline");
    expect(w.figure, "the days to its deadline").toBe("12 days");
    expect(w.sub).toBe(`closes ${await fmt(page, endIso(fx.dated), "long")}`);
    expect(w.bar, "with the bar of how much has gone").toBe(true);
    expect(w.dates).toBe(`${await fmt(page, fx.dated.start_time, "long")} – ${await fmt(page, endIso(fx.dated), "long")}`);
    expect(w.text).not.toContain(WORDS);

    await openWorkspace(page, fx.closed);
    await expect.poll(async () => { w = await workspace(page); return w.chip; }, { timeout: 10000 }).toBe("Ended");
    expect(w.label, "an ended Program is unchanged").toBe("Ended");
    expect(w.figure).toBe(await fmt(page, fx.closed.ended_at, "short"));
    expect(w.dates).toBe(`${await fmt(page, fx.closed.start_time, "long")} – ${await fmt(page, fx.closed.ended_at, "long")}`);
    expect(w.text).not.toContain(WORDS);
    expect(w.text, "never its stored decade-out deadline").not.toMatch(fx.placeholderRe);

    await openWorkspace(page, fx.booth);
    await expect.poll(async () => { w = await workspace(page); return w.chip; }, { timeout: 10000 })
      .toMatch(/^Live · \d\d:\d\d:\d\d left$/);
    expect(w.label, "a Booth Event is unchanged").toBe("Time left");
    expect(w.figure).toMatch(/^\d+ h( \d+ min)?$/);
    expect(w.bar).toBe(true);
    expect(w.dates).toBe(`${await fmt(page, fx.booth.start_time, "long")} – ${await fmt(page, endIso(fx.booth), "long")}`);
    expect(w.text).not.toContain(WORDS);
    expect(w.sideways, "no sideways scroll").toBeLessThanOrEqual(0);
  });
}

/** Open `ev`'s Start now confirm through one of its doors (the workspace
 *  header's ⋯ menu, or the Events-row menu), read it, then Cancel: nothing is
 *  sent, so the event is still upcoming for the next arm. The command palette's
 *  Actions reuse the ⋯ menu's items (wsMenuItemsHtml). */
async function startNowConfirm(page, ev, via) {
  const sent = [];
  const onReq = (r) => { if (r.method() === "PUT" && new URL(r.url()).pathname === `/api/admin/competitions/${ev.id}`) sent.push(r.url()); };
  page.on("request", onReq);
  try {
    if (via === "workspace") {
      await openWorkspace(page, ev);
      const more = page.locator("#ws-quick .ws-more-btn");
      await expect(more, "the workspace header's ⋯").toBeVisible({ timeout: 10000 });
      await more.click();
    } else {
      await clickTab(page, "Events");
      await filterComps(page, ev.name);
      await openKebab(page, page.locator("#admin-comp-body tr").filter({ has: page.locator(`td.ev-name-cell[data-comp-id="${ev.id}"]`) }));
    }
    const item = page.locator('#kebab-portal.open [data-action="comp-start-now"]');
    await expect(item, `${via}: the menu offers Start now`).toBeVisible({ timeout: 5000 });
    await item.click();
    const ov = page.locator("#modal-overlay.open");
    await expect(ov.locator("#modal-title"), `${via}: the confirm is open`).toHaveText("Start Event Now?", { timeout: 10000 });
    const body = await ov.locator("#modal-body").innerText();
    await ov.locator("#modal-cancel-btn").click();
    await expect(page.locator("#modal-overlay.open"), "cancelled").toHaveCount(0);
    const line = (body.match(/^Deadline \(preserved\): (.*)$/m) || [])[1];
    return { body, line: line == null ? null : line.trim(), sent };
  } finally { page.off("request", onReq); }
}

for (const width of WIDTHS) {
  test(`organiser: Start now on the upcoming open-ended Program says "Deadline (preserved): ${WORDS}" through both doors, beside a dated control, at ${width} px`, async ({ page }) => {
    await page.setViewportSize(viewport(width));
    await adminLogin(page);
    for (const via of ["workspace", "row"]) {
      const open = await startNowConfirm(page, fx.soon, via);
      expect(open.line, `${via}: the kept deadline is the words: ${open.body}`).toBe(WORDS);
      expect(open.body, `${via}: no placeholder date in the confirm`).not.toMatch(fx.placeholderRe);
      expect(await fmt(page, fx.soon.deadline_at, "long"), "CONTROL: the year probe finds the placeholder as this page prints it").toMatch(fx.placeholderRe);
      expect(open.body, `${via}: the start is still printed`).toContain(`Original start: ${await fmt(page, fx.soon.start_time, "long")}`);
      expect(open.sent, `${via}: cancelled, nothing was sent`).toEqual([]);
      // CONTROL: an upcoming Program with a real deadline prints it.
      const dated = await startNowConfirm(page, fx.soonDated, via);
      expect(dated.line, `${via}: a Program due in 14 days keeps its date: ${dated.body}`).toBe(await fmt(page, fx.soonDated.deadline_at, "long"));
      expect(dated.body).not.toContain(WORDS);
      expect(dated.sent).toEqual([]);
    }
  });
}

/** The events the Events list shows now, as a membership map by fixture key. */
async function listed(page, keys) {
  const ids = await page.evaluate(() => [...document.querySelectorAll("#admin-comp-body td.ev-name-cell[data-comp-id]")].map((td) => td.dataset.compId));
  return Object.fromEntries(keys.map((k) => [k, ids.includes(fx[k].id)]));
}

/** Set the Duration heading's "Contains" filter (its own menu) to `text`. */
async function filterDuration(page, text) {
  await page.locator("#admin-comp-table thead th[data-col='duration'] .tcol-hbtn").click();
  const pop = page.locator(".tcol-pop");
  const input = pop.locator("input[data-tcol-input]");
  await expect(input, "the Duration heading's text filter").toBeVisible({ timeout: 5000 });
  await pop.locator("[data-tcol-fclear]").click();
  await input.pressSequentially(text, { delay: 20 });
  await pop.locator("[data-tcol-done]").click();
  await expect(pop, "the menu closed").toHaveCount(0);
}

const LISTED = ["open", "soon", "dated", "soonDated", "booth"];

test(`organiser: the Events list's Duration filter matches what the cell says, "${WORDS}" for an open-ended Program`, async ({ page }) => {
  await showAllTableColumns(page, "events", EVENT_ALL_COLUMNS);
  await page.setViewportSize(viewport(1440));
  await adminLogin(page);
  await clickTab(page, "Events");
  await filterComps(page, "EA oed-");
  await expect(page.locator("#admin-comp-table thead th[data-col='duration']"), "PRECONDITION: the Duration column is shown").toBeVisible();
  await expect.poll(() => listed(page, LISTED), { timeout: 10000, message: "PRECONDITION: every one is listed" })
    .toEqual({ open: true, soon: true, dated: true, soonDated: true, booth: true });
  await filterDuration(page, "No fixed");
  await expect.poll(() => listed(page, LISTED), { timeout: 10000, message: "the open-ended Programs stay; the dated ones and the Booth Event go" })
    .toEqual({ open: true, soon: true, dated: false, soonDated: false, booth: false });
  // CONTROL: the dated Programs' own figure (12 days) finds them, and not the open-ended ones.
  await filterDuration(page, "12d");
  await expect.poll(() => listed(page, LISTED), { timeout: 10000 })
    .toEqual({ open: false, soon: false, dated: true, soonDated: true, booth: false });
});

// THE ONE DEFINITION: every organiser surface reads the server's `open_ended`,
// never a date rule of its own. A client rule keyed on the date (the event
// form's threshold, which lives in the same module as the Events list and the
// status chip) agrees with the server on every real event, so the field is
// flipped in flight: the decade-out Programs arrive `false`, the dated ones
// `true`, and each surface must follow the field.
test("organiser: the Events list, the Start now confirm and the workspace follow the server's open_ended, never the date", async ({ page }) => {
  const FLIP = { [fx.open.id]: false, [fx.soon.id]: false, [fx.dated.id]: true, [fx.soonDated.id]: true };
  const served = {};
  await page.route("**/api/admin/competitions", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const rows = await res.json();
    for (const r of rows) if (Object.prototype.hasOwnProperty.call(FLIP, r.id)) { if (!(r.id in served)) served[r.id] = r.open_ended; r.open_ended = FLIP[r.id]; }
    await route.fulfill({ response: res, json: rows });
  });
  await showAllTableColumns(page, "events", EVENT_ALL_COLUMNS);
  await page.setViewportSize(viewport(1440));
  await adminLogin(page);
  await clickTab(page, "Events");
  await filterComps(page, "EA oed-");
  // PRECONDITIONS: the server said the opposite of every flip, and the page holds the flip.
  expect(served, "the server's own verdicts")
    .toEqual({ [fx.open.id]: true, [fx.soon.id]: true, [fx.dated.id]: false, [fx.soonDated.id]: false });
  expect(await page.evaluate((ids) => ids.map((id) => ((window.S && window.S.adminCompetitionsData) || []).find((c) => c.id === id)?.open_ended),
    [fx.open.id, fx.soon.id, fx.dated.id, fx.soonDated.id]), "the model holds the flipped field").toEqual([false, false, true, true]);

  // The Events list's End and Duration.
  for (const k of ["open", "soon"]) {
    const row = await eventCells(page, fx[k].id);
    expect(row.end, `${k} (arrives false): its stored end`).toBe(await fmt(page, endIso(fx[k]), "long"));
    expect(row.end, "CONTROL: the year probe finds it").toMatch(fx.placeholderRe);
    expect(row.duration, `${k}: its ten-year length`).toMatch(/^\d{4}d \d\d:\d\d:\d\d$/);
  }
  for (const k of ["dated", "soonDated"]) {
    const row = await eventCells(page, fx[k].id);
    expect(row.end, `${k} (arrives true): the words`).toBe(WORDS);
    expect(row.duration, `${k}: the words`).toBe(WORDS);
  }

  // The Start now confirm.
  const soon = await startNowConfirm(page, fx.soon, "row");
  expect(soon.line, `soon (arrives false): its stored deadline: ${soon.body}`).toBe(await fmt(page, fx.soon.deadline_at, "long"));
  const soonDated = await startNowConfirm(page, fx.soonDated, "row");
  expect(soonDated.line, `soonDated (arrives true): the words: ${soonDated.body}`).toBe(WORDS);
  expect([...soon.sent, ...soonDated.sent], "cancelled, nothing was sent").toEqual([]);

  // The workspace: status chip, time tile and dates line.
  await openWorkspace(page, fx.open);
  let w = null;
  await expect.poll(async () => { w = await workspace(page); return w.chip; }, { timeout: 10000, message: "open (arrives false): a countdown" })
    .toMatch(/^Live · \d{3,}d \d\d:\d\d:\d\d left$/);
  expect(w.label).toBe("Until the deadline");
  expect(w.figure).toMatch(/^\d{3,} days$/);
  expect(w.bar).toBe(true);
  expect(w.dates).toBe(`${await fmt(page, fx.open.start_time, "long")} – ${await fmt(page, endIso(fx.open), "long")}`);
  await openWorkspace(page, fx.dated);
  await expect.poll(async () => { w = await workspace(page); return w.chip; }, { timeout: 10000, message: "dated (arrives true): the words" })
    .toBe(`Live · ${WORDS}`);
  expect(w.label).toBe("Deadline");
  expect(w.figure).toBe(WORDS);
  expect(w.bar).toBe(false);
  expect(w.dates).toBe(`${await fmt(page, fx.dated.start_time, "long")} – ${WORDS}`);

  // The Duration filter reads the same field.
  await clickTab(page, "Events");
  await filterComps(page, "EA oed-");
  await filterDuration(page, "No fixed");
  await expect.poll(() => listed(page, LISTED), { timeout: 10000 })
    .toEqual({ open: false, soon: false, dated: true, soonDated: true, booth: false });
});

// FOUND WHILE LOCKING THE ABOVE (not part of the ruling): leaving a live event's
// workspace shows the Live rankings grid behind the Events list, and that view
// (like an unranked event's Progress card and the per-session boards) replaces
// the Rankings board's table. Opening an event not started yet then wrote its
// "has not started" row into the missing table body: the throw aborted the open
// (setAdminCompetitionScope), so the new event's header sat over the Events list
// with no section, until a reload. rankings-admin.js _rkEnsureBoardCard restores
// the card before any write into it.
test("opening an upcoming event's workspace after a live one's lands on its Overview", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && /handler .* failed/.test(m.text())) errors.push(m.text().split("\n")[0]); });
  await page.setViewportSize(viewport(1440));
  await adminLogin(page);
  await openWorkspace(page, fx.reLive);
  await expect(page.locator("#ws-overview"), "the live event's Overview").toHaveAttribute("data-ov-state", "live");
  // Back on the Events list, the board behind it is the all-live grid: the
  // precondition the defect needs, asserted rather than assumed.
  await clickTab(page, "Events");
  await expect.poll(() => page.evaluate(() => !!document.getElementById("admin-rankings-body")),
    { timeout: 10000, message: "the Live rankings grid replaced the single board" }).toBe(false);
  await viewComp(page, fx.reSoon.name);
  await expect(page.locator("#ws-overview"), "the upcoming event's Overview is on screen")
    .toHaveAttribute("data-ov-state", "upcoming", { timeout: 15000 });
  await expect(page.locator("#ws-overview")).toBeVisible();
  // Its Rankings section has its board back, saying it has not started.
  await clickTab(page, "Rankings");
  await expect(page.locator("#admin-rankings-body"), "the board is restored").toContainText("Event has not started yet.", { timeout: 10000 });
  expect(errors, "no handler failed on the way").toEqual([]);
});

// THE EVENT FORM WITH "No fixed deadline" TICKED (operator ruling, 14 Nov 2026).
//
// The box fills in a deadline ten years out and the form shows that date,
// because it is the one recorded. The platform chose it, so Save asks no
// two-year typo question about it ("Confirm the deadline … more than two years
// from now"); the create summary names it "Deadline: No fixed deadline (stored
// as <date>)" with no ten-year "Open for" line; and reviving an ended Program
// that way says it reopens with no fixed deadline, the stored date in brackets.
// Each by value beside its control: the same far date TYPED BY HAND (the box
// unticked) is still asked about and still summarised as a date and a span; a
// typed date still says where the deadline moves. Nothing is ever sent: every
// confirmation here is cancelled.
test.describe("organiser: the event form with No fixed deadline ticked", () => {
  let ff;
  test.beforeAll(async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const t0 = Date.now();
      const program = (label, startMs, deadlineMs) => makeCompetition(sa, csrf, label, {
        event_kind: "program", start_time: iso(startMs), timezone: "UTC",
        deadline_at: iso(deadlineMs), duration_minutes: undefined,
      });
      // Closed early by End Now, its real deadline a month out.
      const endedEarly = await program("oed-f-early", t0 - HOUR, t0 + 30 * DAY);
      // Ended when its deadline passed: no stamp, the clock alone.
      const lapsed = await program("oed-f-lapsed", t0 - 10 * DAY, t0 - DAY);
      // Closed by End Now, then served as an all-solved auto-end (below).
      const autoEnded = await program("oed-f-auto", t0 - HOUR, t0 + 30 * DAY);
      for (const ev of [endedEarly, autoEnded]) {
        const end = await sa.post(`/api/admin/competitions/${ev.id}/end-now`, { headers: H(csrf) });
        expect(end.ok(), `end-now: ${end.status()} ${await end.text()}`).toBeTruthy();
      }
      const rows = await (await sa.get("/api/admin/competitions")).json();
      const row = (ev) => rows.find((c) => c.id === ev.id);
      expect(row(endedEarly).ended_manually, "PRECONDITION: closed early").toBe(1);
      expect(row(lapsed).status, "PRECONDITION: its deadline has passed").toBe("ended");
      expect(row(lapsed).ended_at, "PRECONDITION: with no stamp").toBeNull();
      ff = { endedEarly, lapsed, autoEnded };
    } finally { await sa.dispose(); }
  });

  /** Every create and save the form could send, recorded so each arm can say none was. */
  const recordSaves = (page) => {
    const sent = [];
    page.on("request", (r) => {
      const p = new URL(r.url()).pathname;
      if ((r.method() === "POST" && p === "/api/admin/competitions") || (r.method() === "PUT" && /^\/api\/admin\/competitions\/[^/]+$/.test(p))) sent.push(`${r.method()} ${p}`);
    });
    return sent;
  };

  /** The open confirmation, by value: title, body, the summary's rows and the
   *  revival warnings. showModal writes the title and body before it adds
   *  `.open`, so what is read once it is open is this confirmation's. */
  async function readConfirm(page) {
    await expect(page.locator("#modal-overlay.open"), "a confirmation is open").toBeVisible({ timeout: 10000 });
    return page.evaluate(() => {
      const body = document.getElementById("modal-body");
      const rows = {};
      for (const tr of body.querySelectorAll("table tr")) {
        const td = tr.querySelectorAll("td");
        if (td.length === 2) rows[td[0].textContent.trim()] = td[1].textContent.trim();
      }
      return {
        title: document.getElementById("modal-title").textContent.trim(), body: body.innerText, rows,
        warnings: [...body.querySelectorAll("li")].map((li) => li.textContent.trim()),
      };
    });
  }

  /** Press Save and read the FIRST confirmation it opens. */
  async function saveAndRead(page) {
    await expect(page.locator("#modal-overlay.open"), "no confirmation is open yet").toHaveCount(0);
    await page.locator('#comp-form-overlay [data-action="comp-save"]').first().click();
    return readConfirm(page);
  }

  async function cancelConfirm(page) {
    await page.locator("#modal-overlay.open #modal-cancel-btn").click();
    await expect(page.locator("#modal-overlay.open"), "cancelled").toHaveCount(0);
  }

  /** The deadline the form holds, as the page reads it, and the box's state. */
  const formDeadline = (page) => page.evaluate(() => {
    const d = window._compFormGetDeadline();
    const box = document.getElementById("comp-no-deadline");
    return {
      iso: d ? d.toISOString() : null, ticked: !!(box && box.checked),
      date: document.getElementById("comp-deadline-date").value, time: document.getElementById("comp-deadline-time").value,
      fieldsDisabled: document.getElementById("comp-deadline-date").disabled && document.getElementById("comp-deadline-time").disabled,
      tz: document.getElementById("comp-tz").value,
    };
  });

  /** Type a deadline by hand: `ms` from now, as wall-clock text in the form. */
  async function typeDeadline(page, ms) {
    const at = new Date(Date.now() + ms);
    const pad = (n) => String(n).padStart(2, "0");
    await page.locator("#comp-deadline-date").fill(`${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`);
    await page.locator("#comp-deadline-time").fill("12:00");
  }

  /** Open `ev`'s edit form once the admin list holds it. */
  async function editForm(page, ev) {
    await expect.poll(() => page.evaluate((id) => !!((window.S && window.S.adminCompetitionsData) || []).find((c) => c.id === id), ev.id),
      { timeout: 20000, message: "the admin list holds the event" }).toBe(true);
    await page.evaluate((id) => window.editCompetition(id), ev.id);
    await expect(page.locator("#comp-form-overlay #comp-edit-id"), "its edit form is open").toHaveValue(ev.id, { timeout: 10000 });
    await page.locator("#comp-deadline-date").waitFor({ state: "visible", timeout: 10000 });
  }

  async function closeForm(page) {
    await page.locator('#comp-form-overlay [data-action="overlay-close"]').first().click();
    await expect(page.locator("#comp-form-overlay")).toHaveCount(0);
  }

  // THE SUMMARY'S ZONE. The create summary prints its rows in the FORM's
  // timezone (#comp-tz, named beside its start), and #comp-tz starts as the
  // browser's, so read in one zone the lock could not tell the two apart. The
  // browser runs in Tokyo and the form is set to Honolulu: their clocks are
  // 19 hours apart, so the stored date prints differently in each, and neither
  // keeps summer time, so no wall clock the form reads back falls in a gap.
  test.describe("with the form set to a timezone other than the browser's", () => {
    const BROWSER_TZ = "Asia/Tokyo", FORM_TZ = "Pacific/Honolulu";
    test.use({ timezoneId: BROWSER_TZ });

    test("creating a Program: no deadline question with the box ticked, and the summary says 'No fixed deadline (stored as <date>)' in the form's zone; the same date typed by hand is asked about and summarised as a date", async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize(viewport(1440));
      const sent = recordSaves(page);
      await adminLogin(page);
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), "PRECONDITION: the browser runs in Tokyo").toBe(BROWSER_TZ);
      await openCompCreateForm(page, "program", { advanced: false });
      await page.locator("#comp-name").fill(`EA ${uniq("oed-f-create")}`);
      const tzBox = page.locator("#comp-tz");
      await expect(tzBox, "PRECONDITION: the form starts in the browser's zone").toHaveValue(BROWSER_TZ);
      await tzBox.fill(FORM_TZ);
      await tzBox.dispatchEvent("change");
      await page.locator("#comp-no-deadline").check();
      const box = await formDeadline(page);
      expect(box.ticked && box.fieldsDisabled, `PRECONDITION: ticked, the date filled in and locked: ${JSON.stringify(box)}`).toBe(true);
      expect(box.tz, "PRECONDITION: the form is set to Honolulu").toBe(FORM_TZ);
      expect(new Date(box.iso).getTime() - Date.now(), "PRECONDITION: the date it fills in is years out").toBeGreaterThan(1826 * DAY);
      const [stored, storedYear] = await page.evaluate(([v, tz]) => [window.fmtDt(new Date(v), "long", { timeZone: tz }),
        new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric" }).format(new Date(v))], [box.iso, FORM_TZ]);
      // Its year from the instant itself: the box adds ten CALENDAR years, which
      // the fixture's 3652 days miss around 1 January.
      expect(stored, `CONTROL: the year probe finds that date (${storedYear}) as the summary prints it`).toMatch(yearRe(storedYear));
      const inBrowserZone = await fmt(page, box.iso, "long");
      expect(inBrowserZone, `CONTROL: the browser's zone prints the same instant differently (${stored}), so the summary's zone is told apart`).not.toBe(stored);

      // The box ticked: the first confirmation is the summary, not the typo question.
      let c = await saveAndRead(page);
      expect(c.title, `no deadline question with the box ticked: ${c.body}`).toMatch(/^Create Program/);
      expect(c.body).not.toContain("more than two years");
      expect(c.rows["Deadline:"], `the deadline named as no fixed deadline, its date in the form's zone: ${JSON.stringify(c.rows)}`).toBe(`${WORDS} (stored as ${stored})`);
      expect(c.rows["Start:"], "the summary's rows are in the form's zone, and it says so").toMatch(/ \(Pacific\/Honolulu\)$/);
      expect(Object.keys(c.rows), "no ten-year span line").not.toContain("Open for:");
      expect(c.body, "nowhere a ten-year span").not.toMatch(/\b\d{4}d\b/);
      await cancelConfirm(page);

      // CONTROL: the box unticked and the SAME date typed by hand. The typo
      // question is asked about it (it prints the browser's clock), and the
      // summary prints the date, in the form's zone, and its span.
      await page.locator("#comp-no-deadline").uncheck();
      await page.locator("#comp-deadline-date").fill(box.date);
      await page.locator("#comp-deadline-time").fill(box.time);
      const typed = await formDeadline(page);
      expect(typed.ticked, "PRECONDITION: unticked").toBe(false);
      expect(typed.iso, "PRECONDITION: the same deadline, typed").toBe(box.iso);
      c = await saveAndRead(page);
      expect(c.title, "a far date typed by hand is asked about").toBe("Confirm the deadline");
      expect(c.body).toContain(`This event's deadline is ${inBrowserZone} — more than two years from now.`);
      await page.locator("#modal-overlay.open #modal-confirm-btn").click();
      await expect(page.locator("#modal-overlay.open #modal-title")).toHaveText(/^Create Program/, { timeout: 10000 });
      c = await readConfirm(page);
      expect(c.rows["Deadline:"], "a typed deadline is printed as its date, in the form's zone").toBe(stored);
      expect(c.rows["Open for:"], "with how long it is open").toMatch(/^\d{4}d\b/);
      expect(c.body).not.toContain(WORDS);
      await cancelConfirm(page);
      await closeForm(page);
      expect(sent, "every confirmation was cancelled: nothing was sent").toEqual([]);
    });
  });

  test("editing an open-ended Program: no deadline question with the box ticked; unticked, the same date is asked about", async ({ page }) => {
    await page.setViewportSize(viewport(1440));
    const sent = recordSaves(page);
    await adminLogin(page);
    await clickTab(page, "Events");
    await editForm(page, fx.open);
    const seeded = await formDeadline(page);
    expect(seeded.ticked && seeded.fieldsDisabled, `PRECONDITION: the box is ticked from the stored deadline: ${JSON.stringify(seeded)}`).toBe(true);
    let c = await saveAndRead(page);
    expect(c.title, `no deadline question: ${c.body}`).toBe("Update Program");
    expect(c.body).not.toContain("more than two years");
    await cancelConfirm(page);
    // CONTROL: unticked, the same stored date is a deadline the organiser keeps
    // by hand, and the question is asked.
    await page.locator("#comp-no-deadline").uncheck();
    const kept = await formDeadline(page);
    expect(kept.ticked === false && kept.iso === seeded.iso, `PRECONDITION: unticked, the same date: ${JSON.stringify(kept)}`).toBe(true);
    c = await saveAndRead(page);
    expect(c.title).toBe("Confirm the deadline");
    expect(c.body).toContain(`This event's deadline is ${await fmt(page, kept.iso, "long")} — more than two years from now.`);
    await cancelConfirm(page);
    await closeForm(page);
    expect(sent, "nothing was sent").toEqual([]);
  });

  test("reviving an ended Program with the box ticked says it reopens with no fixed deadline (stored as <date>); a typed date says where the deadline moves", async ({ page }) => {
    test.setTimeout(120_000);
    // The all-solved auto-end, on a row the server closed with End Now: its
    // stamp kept, served as not manual and with the auto-end off, which is the
    // branch that revives (an auto-end that still holds keeps it ended).
    await page.route("**/api/admin/competitions", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const res = await route.fetch();
      const rows = await res.json();
      for (const r of rows) if (r.id === ff.autoEnded.id) { r.ended_manually = 0; r.auto_end_on_all_solved = 0; }
      await route.fulfill({ response: res, json: rows });
    });
    await page.setViewportSize(viewport(1440));
    const sent = recordSaves(page);
    await adminLogin(page);
    await clickTab(page, "Events");
    let served = null;
    await expect.poll(async () => {
      served = await page.evaluate((id) => ((window.S && window.S.adminCompetitionsData) || []).find((c) => c.id === id) || null, ff.autoEnded.id);
      return !!served;
    }, { timeout: 20000, message: "the admin list holds the auto-ended Program" }).toBe(true);
    expect(!!served.ended_at && served.ended_manually === 0 && !served.auto_end_on_all_solved,
      `PRECONDITION: served as an auto-end that revives: ${JSON.stringify({ ended_at: served.ended_at, ended_manually: served.ended_manually, auto_end_on_all_solved: served.auto_end_on_all_solved })}`).toBe(true);

    const cases = [
      { ev: ff.endedEarly,
        ticked: (n, w) => `${n} was closed early and will become live again, with ${w}.`,
        typed: (n, d) => `${n} was closed early and will become live again — its deadline is being moved to ${d}.` },
      { ev: ff.autoEnded,
        ticked: (n, w) => `${n} auto-ended before its deadline and will become live again, with ${w}.`,
        typed: (n, d) => `${n} auto-ended before its deadline and will become live again — its deadline is being moved to ${d}.` },
      { ev: ff.lapsed,
        ticked: (n, w) => `${n} ended when its deadline passed. Saving it with ${w} will make it live again.`,
        typed: (n, d) => `${n} ended when its deadline passed. Moving the deadline to ${d} will make it live again.` },
    ];
    const lower = WORDS.charAt(0).toLowerCase() + WORDS.slice(1);
    for (const { ev, ticked, typed } of cases) {
      await editForm(page, ev);
      const before = await formDeadline(page);
      expect(before.ticked, `${ev.name} PRECONDITION: a real deadline, the box unticked`).toBe(false);
      await page.locator("#comp-no-deadline").check();
      const box = await formDeadline(page);
      expect(box.ticked && new Date(box.iso).getTime() - Date.now() > 1826 * DAY, `${ev.name} PRECONDITION: ticked, ten years out`).toBe(true);
      let c = await saveAndRead(page);
      expect(c.title, `${ev.name}: no deadline question, straight to the save: ${c.body}`).toBe("Update Program");
      expect(c.warnings, `${ev.name}: it reopens with no fixed deadline, the stored date in brackets`)
        .toEqual([ticked(ev.name, `${lower} (stored as ${await fmt(page, box.iso, "long")})`)]);
      expect(c.body).not.toMatch(/being moved to|Moving the deadline to/);
      await cancelConfirm(page);
      // CONTROL: a date typed by hand (two months out, so no typo question)
      // says where the deadline moves, and not the words.
      await page.locator("#comp-no-deadline").uncheck();
      await typeDeadline(page, 60 * DAY);
      const hand = await formDeadline(page);
      expect(hand.ticked, "PRECONDITION: unticked").toBe(false);
      c = await saveAndRead(page);
      expect(c.title, `${ev.name}: a near date asks no deadline question`).toBe("Update Program");
      expect(c.warnings, `${ev.name}: a typed date says where the deadline moves`).toEqual([typed(ev.name, await fmt(page, hand.iso, "long"))]);
      expect(c.body).not.toContain(lower);
      await cancelConfirm(page);
      await closeForm(page);
    }
    expect(sent, "every confirmation was cancelled: nothing was sent").toEqual([]);
  });
});
