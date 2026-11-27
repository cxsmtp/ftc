// v8.13.0 — shared set-up for the booth tap-to-answer specs
// (booth-choice-tap.spec.js, booth-choice-tap-edges.spec.js).
//
// This module must NOT require ./isolated-test (it registers the per-file
// recycle at import time) and binds no database-backed lib/ module at module
// scope (v7.20.2). Participant and admin helpers come from late-entry-fixture.js,
// which follows the same rules, so the two cannot drift.
const { expect } = require("@playwright/test");
const { BASE, PARTICIPANT_PASS, gradingHashFor, codeLogin } = require("./helpers");
const { H, uniq, sa, makeParticipant, enrol } = require("./late-entry-fixture");

// Short, booth-typical options: what a stand would really ask.
const SHORT = [
  { text: "HTTPS", correct: true },
  { text: "Plain HTTP" },
  { text: "FTP" },
  { text: "Telnet" },
];
// The approved mockup's question: four ~45-character options.
const SQL_Q = {
  title: "Which query is safe from SQL injection?",
  description: "<p>A login form builds its database query from the username a visitor types. Which approach stops an attacker from changing what the query does?</p>",
  choices: [
    { text: "Concatenating the username into the SQL string" },
    { text: "Escaping quotes with a regular expression" },
    { text: "A parameterised query with a bound value", correct: true },
    { text: "Hiding the error message from the user" },
  ],
};

/**
 * An event (a LIVE Booth Event by default) holding the given multiple-choice
 * challenges. A Booth Event never auto-ends on all-solved (lib/event-policy.js),
 * so one participant solving a challenge cannot end the event under a test.
 */
async function eventWithChoices(api, csrf, { kind = "booth", cap = 3, tasks = [{}], minutes = 600, startMs = -3600e3 } = {}) {
  const create = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `BCT ${uniq()} ${kind}`, event_kind: kind,
      start_time: new Date(Date.now() + startMs).toISOString(),
      timezone: "UTC",
      ...(kind === "program"
        ? { deadline_at: new Date(Date.now() + 86400e3).toISOString() }
        : { duration_minutes: minutes }),
      ...(cap === null ? {} : { attempt_cap: cap }),
    },
  });
  expect(create.ok(), `create ${kind}: ${await create.text()}`).toBeTruthy();
  const comp = (await create.json()).competition;
  const ids = [];
  for (const t of tasks) {
    const r = await api.post("/api/admin/tasks", {
      headers: H(csrf),
      data: {
        title: t.title || `BCT task ${uniq()}`,
        description: t.description || "<p>Pick one.</p>",
        difficulty: t.difficulty || "medium",
        answer_type: "choice", status: "published",
        choices: t.choices || SHORT,
        ...(t.hint ? { hint: t.hint } : {}),
      },
    });
    expect(r.ok(), `create choice task: ${await r.text()}`).toBeTruthy();
    const id = (await r.json()).id;
    const a = await api.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } });
    expect(a.ok(), `assign: ${await a.text()}`).toBeTruthy();
    ids.push((await a.json()).copies[0].task_id);   // the event's own copy (lib/event-copies.js): what is opened and answered there
  }
  return { comp, ids };
}

/** One owned participant, enrolled. */
async function participantIn(api, csrf, compId, label = `bct${uniq()}`) {
  const p = await makeParticipant(api, csrf, label);
  await enrol(api, csrf, compId, p.id);
  return p;
}

/** A browser context shaped like a device. Touch unless told otherwise. */
async function deviceContext(browser, { width = 390, height = 664, touch = true, theme = "dark" } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height }, hasTouch: touch, isMobile: touch, baseURL: BASE,
  });
  await ctx.addInitScript((t) => { try { localStorage.setItem("hck-theme", t); } catch (_) {} }, theme);
  return ctx;
}

/**
 * Sign the participant in on THIS page's session (the page.request jar is the
 * browser's), put them in the event, and land on its challenge list. A browser
 * login and an API login as one user cannot both be live (single session), so
 * nothing else signs this user in for the rest of the test.
 */
async function signInTo(page, email, compId) {
  const t0 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const li = await codeLogin(page.request, email, H(t0));
  expect(li.ok(), `login ${email}: ${await li.text()}`).toBeTruthy();
  const t1 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const sel = await page.request.post("/api/select-competition", { headers: H(t1), data: { competitionId: compId } });
  expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
  await page.goto("/");
  await page.locator("#nav-challenges:not([aria-disabled=true])").waitFor({ state: "visible", timeout: 30000 });
}

/** Open a challenge the way a participant does: from its card. */
async function openChallenge(page, taskId) {
  if (!(await page.locator("#tasks-page.active").count())) await page.locator("#nav-challenges:not([aria-disabled=true])").click();
  // The Unsolved filter is forced while live, so a SOLVED challenge needs "All".
  const card = page.locator(`[data-action="task-open"][data-task-id="${taskId}"]`);
  if (!(await card.count())) await page.locator('#solve-filters [data-value="all"]').click();
  await card.waitFor({ state: "visible", timeout: 20000 });
  await card.click();
  // The tap card's title is an h1 (the app header, with the page's other h1, is
  // hidden there); the standard card's is an h2.
  await page.locator("#task-detail-card :is(h1, h2)").first().waitFor({ state: "visible", timeout: 15000 });
}

/** Everything a geometry assertion needs, read in ONE evaluate (one frame). */
function tapState(page) {
  return page.evaluate(() => {
    const se = document.scrollingElement;
    const card = document.getElementById("task-detail-card");
    const tiles = [...document.querySelectorAll(".mcf-options .mcf-tile")];
    const last = [...document.querySelectorAll(".mcf-options > *")].pop();
    const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    return {
      mq: window.matchMedia(window.CHOICE_TAP_MQ).matches,
      body: document.body.className,
      tap: !!card && card.classList.contains("mcf-card"),
      fit: card && card.dataset.mcfFit,
      scrollH: se.scrollHeight, scrollW: se.scrollWidth, clientW: se.clientWidth, innerH: innerHeight,
      lastBottom: last ? last.getBoundingClientRect().bottom : null,
      tileHeights: tiles.map((t) => Math.round(t.getBoundingClientRect().height)),
      tileCount: tiles.length,
      headerShown: vis(document.getElementById("app-header")),
      // The standard card's focus view: on a phone its play bar replaces the app header.
      playbarShown: vis(document.getElementById("qa-playbar")),
      navShown: vis(document.getElementById("main-nav")),
      footerShown: vis(document.getElementById("app-footer")),
      timerInBar: !!document.querySelector(".mcf-clock #header-timer"),
      timerInHeader: !!document.querySelector("#app-header #header-timer"),
      radios: document.querySelectorAll(".choice-fieldset input[type=radio]").length,
      review: !!document.getElementById("choice-review"),
    };
  });
}

/** Count answer POSTs on a page. */
function countSubmits(page) {
  const box = { n: 0, bodies: [] };
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/api\/tasks\/[^/]+\/submit$/.test(r.url())) { box.n++; box.bodies.push(r.postData() || ""); }
  });
  return box;
}

/** A submit through the page's OWN session (so the browser stays signed in). */
async function pageSubmit(page, taskId, choiceIds) {
  const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
  const gh = await gradingHashFor(page.request, taskId);
  return page.request.post(`/api/tasks/${taskId}/submit`, {
    headers: { "x-csrf-token": csrf },
    multipart: { answer: JSON.stringify(choiceIds), gradingHash: gh || "" },
  });
}

/** The option ids of a challenge, as THIS participant is shown them. */
async function choiceIdsFor(page, taskId) {
  const t = await (await page.request.get(`/api/tasks/${taskId}`)).json();
  return t.choices.map((c) => ({ id: c.id, text: c.text }));
}

module.exports = {
  H, uniq, sa, SHORT, SQL_Q, eventWithChoices, participantIn, deviceContext, signInTo,
  openChallenge, tapState, countSubmits, pageSubmit, choiceIdsFor,
};
