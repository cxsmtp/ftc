"use strict";

// A QUALIFYING CHALLENGE, AS THE ORGANISER'S SCREENS READ ITS TAG.
//
// A qualifying challenge is an ordinary challenge tagged `qualifying:<key>`
// (lib/qualifying.js). Every organiser screen that tells one apart asks the one
// client test, public/js/ui/task-search.js `isQualifyingTag` / `isQualifyingTask`:
//   • the create form's Challenges section leaves it out of the list, and its
//     `qualifying:` tag out of the chips (an event gets its own copies);
//   • View as participant shows it as a Quick question, not a difficulty with
//     points;
//   • the Analytics filters offer neither it nor its tag (that arm is in
//     tests/analytics-sort-export.spec.js);
//   • and, by SOURCE, no screen tests the tag itself (the workspace Overview's
//     challenge list once did).
// Each arm has an ordinary challenge beside it as the control.

const { test, expect } = require("./isolated-test");
const { apiLogin, BASE } = require("./helpers");
const { adminLogin, clickTab, openCompCreateForm, narrowChallengesTable } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

const STAMP = `qov${Date.now().toString(36)}`;
const T = { qual: `${STAMP} qualifying question`, plain: `${STAMP} ordinary challenge` };
const QTAG = `qualifying:${STAMP}`;
const SHARED = `${STAMP}-shared`;

test.describe("a qualifying challenge on the organiser's screens", () => {
  test.beforeAll(async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const h = { "x-csrf-token": csrf, "content-type": "application/json" };
      for (const [title, tags] of [[T.qual, [QTAG, SHARED]], [T.plain, [SHARED]]]) {
        // A qualifying question is a pick-one question (lib/qualifying.js).
        const kind = title === T.qual
          ? { answer_type: "any", correct_answer: "", choices: [{ text: "Yes" }, { text: "No" }] }
          : { answer_type: "text", correct_answer: "x" };
        const r = await api.post("/api/admin/tasks", { headers: h, data: {
          title, description: "<p>d</p>", difficulty: "easy", ...kind, status: "published" } });
        expect(r.ok(), `create ${title}: ${r.status()} ${await r.text()}`).toBeTruthy();
        const id = (await r.json()).id;
        for (const tag of tags) {
          const t = await api.post(`/api/admin/tasks/${id}/tags`, { headers: h, data: { tag } });
          expect(t.ok(), `tag ${tag}: ${t.status()} ${await t.text()}`).toBeTruthy();
        }
      }
      // PRECONDITION: the library sends the qualifying challenge WITH its tag, so
      // what is under test is the screens' reading of it.
      const lib = await (await api.get("/api/admin/tasks")).json();
      const q = (Array.isArray(lib) ? lib : lib.tasks || []).find((t) => t.title === T.qual);
      expect(q && q.tags, "the library lists the qualifying challenge and its tag").toContain(QTAG);
    } finally { await api.dispose(); }
  });

  // Stage B (owner ruling, 27 Nov 2026) — the create form no longer lists
  // questions at all (the event's one door is + Add from bank), so it cannot
  // offer a qualifying one; the Question bank row is where both are read.
  test("the create form lists no questions, and the Question bank lists both with only the ordinary one's topic", async ({ page }) => {
    await adminLogin(page);
    await openCompCreateForm(page, "tournament", { advanced: false });
    const form = page.locator("#comp-form-overlay");
    await expect(form.locator("#comp-name"), "PRECONDITION: the form is open").toBeVisible();
    await expect(form.locator("#comp-ch"), "no Challenges section").toHaveCount(0);
    await expect(form, "the qualifying challenge is not offered").not.toContainText(T.qual);
    await expect(form, "nor the ordinary one: the form picks none").not.toContainText(T.plain);
  });

  test("View as participant shows it as a Quick question, with no difficulty or points", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    const overlay = page.locator("#task-preview-overlay");
    const preview = async (title) => {
      // Narrow first: the library paginates at 30.
      await narrowChallengesTable(page, title);
      await page.locator("#admin-task-body tr", { hasText: title }).first()
        .locator("[data-action='task-view']").first().click();
      await overlay.waitFor({ state: "visible", timeout: 10000 });
      await expect(overlay.locator("#task-preview-title")).toHaveText(title);
      return overlay.locator(".task-preview-meta");
    };
    // CONTROL: an ordinary challenge shows its difficulty and its points.
    let meta = await preview(T.plain);
    await expect(meta.locator(".badge.easy")).toHaveCount(1);
    await expect(meta.locator(".pts")).toHaveText("+50 pts");
    await overlay.locator("[data-action='task-preview-close']").first().click();
    await expect(overlay).toHaveCount(0);

    meta = await preview(T.qual);
    await expect(meta.locator(".pts")).toHaveText("Quick question");
    await expect(meta.locator(".badge"), "no difficulty for a question that scores nothing").toHaveCount(0);
  });
});

// NEVER A COPY, BY SOURCE. A screen's own test of the tag behaves as the shared
// one does on every tag the server stores (tags are stored lower-cased), so no
// browser arm can tell the two apart; the source can. What the pattern reads as
// a TEST: a string literal that is the bare prefix, or the prefix after a `^` (a
// RegExp's source), with no `+` after it; and a regex literal whose body starts
// with the prefix, anchored or not. A tag being BUILT is not matched (a template
// literal interpolates the key straight after the colon; a concatenation puts a
// `+` after the literal), nor is the participant's boolean `qualifying`. A
// constant holding the bare prefix is matched on purpose: a screen builds a tag
// in place, so a named prefix is where a copy starts. Not seen: a test that
// splits on the colon and compares the bare word, or that takes the prefix from
// a name defined elsewhere. IDIOMS pins each verdict. Comments are stripped
// first: a fix's comment may quote the old idiom.
test("no organiser screen tests the qualifying tag itself: every one asks ui/task-search.js (source scan)", () => {
  const fs = require("fs");
  const path = require("path");
  const { stripJsComments } = require("./doc-registry");
  const root = path.join(__dirname, "..", "public", "js");
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else if (e.name.endsWith(".js")) files.push(f);
    }
  };
  walk(root);
  const PREFIX_TEST = /(['"`])\^?qualifying:\1(?!\s*\+)|\/\^?qualifying\\?:/gi;
  // The pattern's verdicts, pinned (true: read as a test of the tag).
  const IDIOMS = [
    [true, "(t.tags || []).some(tg => String(tg).startsWith('qualifying:'))"], // the copy this lock was written for
    [true, 'tg.toLowerCase().indexOf("qualifying:") === 0'],
    [true, "const PREFIX = 'qualifying:';"],
    [true, "/^qualifying:/i.test(tg)"],
    [true, "/qualifying:/i.test(tg)"],
    [true, "/^qualifying\\:/.test(tg)"],
    [true, "new RegExp('^qualifying:', 'i').test(tg)"],
    [false, "const tag = `qualifying:${key}`;"],
    [false, "const tag = 'qualifying:' + key;"],
    [false, 'const tag = "qualifying:"+key;'],
    [false, "if (t.qualifying) return true;"],
  ];
  const misread = IDIOMS.filter(([isTest, src]) => !!src.match(PREFIX_TEST) !== isTest)
    .map(([isTest, src]) => `${isTest ? "missed" : "flagged"}: ${src}`);
  expect(misread, "each idiom is read as the comment above says").toEqual([]);
  const shared = path.join(root, "ui", "task-search.js");
  const hits = (f) => stripJsComments(fs.readFileSync(f, "utf8")).match(PREFIX_TEST) || [];
  // ANTI-VACUITY: the walk read the SPA, and the pattern finds the one test.
  expect(files.length, "PRECONDITION: the walk read the SPA's modules").toBeGreaterThan(50);
  expect(hits(shared), "CONTROL: the pattern finds the shared test's own literal").toHaveLength(1);
  const copies = files.filter((f) => f !== shared).flatMap((f) => hits(f).map((m) => `${path.relative(root, f)}: ${m}`));
  expect(copies, "a qualifying-tag test outside ui/task-search.js").toEqual([]);
  // The site this lock was written for asks the shared test.
  const ws = stripJsComments(fs.readFileSync(path.join(root, "features", "event-workspace.js"), "utf8"));
  expect(ws, "the workspace imports the one qualifying test").toMatch(/import\s*\{[^}]*\bisQualifyingTask\b[^}]*\}\s*from\s*["']\.\.\/ui\/task-search\.js["']/);
});

// OPERATOR RULING N7 (14 Nov 2026): AN EVENT ASKS EACH QUALIFYING QUESTION ONCE.
// The organiser's two assign dialogs and the bulk toast, read from the server's
// own parse of the tag (`qualifying_keys` on the library row):
//   • Add challenges does not list another event's question on a topic this
//     event already asks (and says how many it left out), lists one on a new
//     topic, and lets only one per topic be ticked;
//   • the Assign dialog offers an event that already asks the topic disabled,
//     with the reason;
//   • the bulk door's skip is said in its toast.
test.describe("an event asks each qualifying question once (ruling N7)", () => {
  const W = {};
  const KEY = `t${STAMP}`.slice(0, 40);
  test.beforeAll(async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const h = { "x-csrf-token": csrf, "content-type": "application/json" };
      const ev = async (kind) => {
        const r = await api.post("/api/admin/competitions", { headers: h, data: { name: `${STAMP} ${kind} ${Math.random().toString(36).slice(2, 7)}`, event_kind: kind, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120, timezone: "UTC" } });
        expect(r.ok(), `create ${kind}: ${await r.text()}`).toBeTruthy();
        return (await r.json()).competition;
      };
      W.A = await ev("booth"); W.B = await ev("booth"); W.C = await ev("tournament");
      // D asks no topic, and only the sharing test below touches it.
      W.D = await ev("tournament");
      // Two questions of the organiser's own on one NEW topic, in no event yet.
      W.own = [];
      for (const n of [1, 2]) {
        const r = await api.post("/api/admin/tasks", { headers: h, data: { title: `${STAMP} own topic ${n}`, description: "<p>d</p>", difficulty: "easy", answer_type: "any", choices: [{ text: "Small" }, { text: "Large" }], status: "published" } });
        expect(r.ok(), await r.text()).toBeTruthy();
        const id = (await r.json()).id;
        const t = await api.post(`/api/admin/tasks/${id}/tags`, { headers: h, data: { tag: `qualifying:${KEY}` } });
        expect(t.ok(), await t.text()).toBeTruthy();
        W.own.push(id);
      }
      const lib = await (await api.get("/api/admin/tasks")).json();
      const qOf = (compId) => Object.fromEntries(lib.filter(t => (t.competitions || []).some(c => c.id === compId) && (t.qualifying_keys || []).length).map(t => [t.qualifying_keys[0], t]));
      W.qa = qOf(W.A.id); W.qb = qOf(W.B.id);
      expect(Object.keys(W.qa).sort(), "PRECONDITION: each Booth Event asks the four").toEqual(["developers", "evaluating", "follow_up", "scanner"]);
      expect(Object.keys(qOf(W.C.id)), "PRECONDITION: the Competition asks none").toEqual([]);
      expect(Object.keys(qOf(W.D.id)), "PRECONDITION: nor does the other").toEqual([]);
    } finally { await api.dispose(); }
  });

  test("Add challenges leaves out another event's question on a topic the event already asks, lists one on a new topic, and lets only one per topic be ticked", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await page.evaluate((id) => window.openTaskPickerForCompetition(id), W.B.id);
    const overlay = page.locator("#task-picker-overlay");
    await expect(overlay.locator("#task-picker-list")).toBeVisible({ timeout: 15000 });
    const row = (id) => overlay.locator(`#task-picker-list input[value="${id}"]`);
    // B's own four are listed (ticked: in the event); A's four are not.
    for (const k of Object.keys(W.qb)) await expect(row(W.qb[k].id), `B's own ${k}`).toBeChecked();
    for (const k of Object.keys(W.qa)) await expect(row(W.qa[k].id), `A's ${k}: B already asks it`).toHaveCount(0);
    await expect(overlay.locator("#task-picker-note")).toContainText(/\d+ quick question\(s\) are not listed: this event already asks each of them\./);
    // A NEW topic is listed — both questions on it — and only one may be ticked.
    const [o1, o2] = W.own;
    await expect(row(o1)).toBeEnabled();
    await expect(row(o2)).toBeEnabled();
    await row(o1).check();
    await expect(row(o2), "a second question on the topic is not offered").toBeDisabled();
    await expect(overlay.locator(".picker-row", { has: page.locator(`input[value="${o2}"]`) }).locator(".picker-row-flag.is-topic")).toHaveText("Same quick question as a ticked one");
    await expect(row(o1), "the tick keeps its focus").toBeFocused();
    await row(o1).uncheck();
    await expect(row(o2), "free again").toBeEnabled();
    await expect(overlay.locator(".picker-row-flag.is-topic")).toHaveCount(0);
    // Select All keeps one per topic.
    await overlay.locator("#task-picker-search").fill(`${STAMP} own topic`);
    await overlay.locator('[data-action="task-picker-select-all"]').click();
    const ticked = await Promise.all([row(o1).isChecked(), row(o2).isChecked()]);
    expect(ticked.filter(Boolean).length, "one of the two").toBe(1);
    await expect(overlay.locator("#task-picker-count")).toContainText("1 to add");
    // Save: the one lands.
    await overlay.locator("#task-picker-save").click();
    await page.locator("#modal-overlay.open #modal-confirm-btn").click();
    await expect(page.locator("#toast-stack .toast", { hasText: "1 added." })).toBeVisible({ timeout: 15000 });
  });

  // The half of the ruling that ALLOWS sharing (what separates it from refusing
  // every other event's question): an event that asks none of the topics is
  // offered every event's questions, and the one it takes is shared.
  test("Add challenges for an event that asks no topic lists another event's question and shares it; once in, the topic's other questions leave the list and a new topic's stay", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    const overlay = page.locator("#task-picker-overlay");
    const row = (id) => overlay.locator(`#task-picker-list input[value="${id}"]`);
    const open = async () => {
      await page.evaluate((id) => window.openTaskPickerForCompetition(id), W.D.id);
      await expect(overlay.locator("#task-picker-list")).toBeVisible({ timeout: 15000 });
    };
    await open();
    // Both Booth Events' developers questions: listed, offered, not in D.
    for (const q of [W.qa.developers, W.qb.developers]) {
      await expect(row(q.id), "another event's question, on a topic D does not ask").toHaveCount(1);
      await expect(row(q.id)).toBeEnabled();
      await expect(row(q.id)).not.toBeChecked();
    }
    await expect(overlay.locator("#task-picker-note"), "nothing left out").not.toContainText("quick question");
    await row(W.qa.developers.id).check();
    await expect(overlay.locator("#task-picker-count")).toContainText("1 to add");
    await overlay.locator("#task-picker-save").click();
    await page.locator("#modal-overlay.open #modal-confirm-btn").click();
    await expect(page.locator("#toast-stack .toast", { hasText: "1 added." })).toBeVisible({ timeout: 15000 });
    // One question, two events: A's own, now D's too.
    await expect.poll(async () => {
      const lib = await (await page.request.get("/api/admin/tasks")).json();
      return ((lib.find(t => t.id === W.qa.developers.id) || {}).competitions || []).map(c => c.id).filter(id => id === W.A.id || id === W.D.id).sort();
    }, { timeout: 10000 }).toEqual([W.A.id, W.D.id].sort());
    // Reopened: D asks developers now, so B's developers question is not listed;
    // B's scanner question (a topic D does not ask) still is.
    await open();
    await expect(row(W.qa.developers.id), "the shared one is in D").toBeChecked();
    await expect(row(W.qb.developers.id), "the same topic's other question is left out").toHaveCount(0);
    await expect(row(W.qb.scanner.id), "CONTROL: a topic D does not ask").toBeEnabled();
    await expect(overlay.locator("#task-picker-note")).toContainText("quick question(s)");
  });

  test("the Assign dialog offers an event that already asks the topic disabled, with the reason; the bulk door's skip is in its toast", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await expect.poll(() => page.evaluate((id) => (window.S.adminTasksData || []).some(t => t.id === id), W.qa.developers.id), { timeout: 15000 }).toBe(true);
    await page.evaluate((id) => window.openAssignTaskToComps(id), W.qa.developers.id);
    const overlay = page.locator("#assign-task-overlay");
    const box = (compId) => overlay.locator(`#assign-task-comp-list input[value="${compId}"]`);
    await expect(box(W.B.id), "B asks developers already").toBeDisabled();
    const label = overlay.locator("#assign-task-comp-list label", { has: page.locator(`input[value="${W.B.id}"]`) });
    await expect(label.locator(".picker-row-flag")).toHaveText("Topic already asked");
    await expect(label).toHaveAttribute("title", /already has a qualifying question on this topic/);
    await expect(box(W.C.id), "CONTROL: C asks none").toBeEnabled();
    await expect(box(W.A.id), "and A holds it, so it stays removable").toBeChecked();
    await box(W.C.id).check();
    const put = page.waitForResponse(r => r.request().method() === "PUT" && r.url().endsWith(`/api/admin/tasks/${W.qa.developers.id}/competitions`));
    await overlay.locator("#assign-task-save-btn").click();
    expect((await put).ok(), "shared with the event that does not ask it").toBeTruthy();
    // Now C asks developers: B's own copy offers C disabled.
    await expect.poll(() => page.evaluate(([id, c]) => ((window.S.adminTasksData || []).find(t => t.id === id)?.competitions || []).some(x => x.id === c), [W.qa.developers.id, W.C.id]), { timeout: 15000 }).toBe(true);
    await page.evaluate((id) => window.openAssignTaskToComps(id), W.qb.developers.id);
    await expect(page.locator(`#assign-task-overlay #assign-task-comp-list input[value="${W.C.id}"]`)).toBeDisabled();
    await page.locator('#assign-task-overlay [data-action="overlay-close"]').click();

    // The bulk door: B's evaluating to C lands, A's then is skipped — and said.
    await page.evaluate((ids) => { window.S.selectedChallenges = new Set(ids); }, [W.qb.evaluating.id, W.qa.evaluating.id]);
    await page.evaluate(() => window.openBulkAssignChallengesModal());
    const bulk = page.locator("#challenge-bulk-assign-overlay");
    await bulk.locator(`#challenge-bulk-comp-list input[value="${W.C.id}"]`).check();
    const post = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/api/admin/tasks/assign-competitions"));
    await bulk.locator('[data-action="challenge-bulk-assign-execute"]').click();
    const body = await (await post).json();
    expect([body.assigned, body.skipped.qualifyingHeld], "one lands, one is skipped").toEqual([1, 1]);
    await expect(page.locator("#toast-stack .toast", { hasText: "1 qualifying question(s) on a topic the event already asks" })).toBeVisible();
  });
});

// RULING N7, THE CLIENT HALF, THROUGH A DRAFT OR A HIDDEN QUESTION. An event
// holds a topic through ANY question it holds (the server's
// `heldQualifyingKeys`; refused at every assign door, tests/event-team-reports.spec.js):
// a draft (never listed, so never ticked) or a hidden one too. The two dialogs
// read it off the library: Add challenges (`topicHeld`) leaves another event's
// question on such a topic out, and Assign to Events (`topicHeldIn`) offers the
// event disabled. Each with a question on a topic the event does not ask as the
// CONTROL.
test.describe("an event asks each qualifying question once, through a draft or a hidden question too (ruling N7)", () => {
  const V = {};
  const KEY = { draft: `dr${STAMP}`, hidden: `hd${STAMP}`, fresh: `nw${STAMP}` };
  test.beforeAll(async () => {
    const { api, csrf } = await apiLogin("superadmin");
    try {
      const h = { "x-csrf-token": csrf, "content-type": "application/json" };
      const ok = async (r, what) => { expect(r.ok(), `${what}: ${r.status()} ${await r.text()}`).toBeTruthy(); return r.json(); };
      const ev = async (tag) => (await ok(await api.post("/api/admin/competitions", { headers: h, data: { name: `${STAMP} ${tag} ${Math.random().toString(36).slice(2, 7)}`, event_kind: "tournament", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 120, timezone: "UTC" } }), `create ${tag}`)).competition;
      const question = async (title, key, status = "published") => {
        const { id } = await ok(await api.post("/api/admin/tasks", { headers: h, data: { title, description: "<p>d</p>", difficulty: "easy", answer_type: "any", choices: [{ text: "Small" }, { text: "Large" }], status } }), `create ${title}`);
        await ok(await api.post(`/api/admin/tasks/${id}/tags`, { headers: h, data: { tag: `qualifying:${key}` } }), `tag ${title}`);
        return id;
      };
      const into = async (taskId, compId) => ok(await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: h, data: { competitionIds: [compId] } }), `assign ${taskId}`);
      V.E = await ev("holds a draft and a hidden"); V.F = await ev("another event");
      // E's DRAFT question: made, published, put in E, then restored to its draft
      // version (the one way a held challenge becomes a draft).
      V.eDraft = await question(`${STAMP} E draft question`, KEY.draft, "draft");
      await ok(await api.post(`/api/admin/tasks/${V.eDraft}/publish`, { headers: h }), "publish E's draft");
      await into(V.eDraft, V.E.id);
      const snap = (v) => (typeof v.snapshot === "string" ? JSON.parse(v.snapshot) : (v.snapshot || {}));
      const draftV = (await ok(await api.get(`/api/admin/tasks/${V.eDraft}/versions`), "versions")).find(v => snap(v).status === "draft" && (snap(v).tags || []).includes(`qualifying:${KEY.draft}`));
      expect(draftV, "PRECONDITION: a draft version carrying the tag").toBeTruthy();
      await ok(await api.post(`/api/admin/tasks/${V.eDraft}/restore`, { headers: h, data: { versionId: draftV.id } }), "restore the draft");
      // E's HIDDEN question: published, in E, hidden.
      V.eHidden = await question(`${STAMP} E hidden question`, KEY.hidden);
      await into(V.eHidden, V.E.id);
      await ok(await api.patch(`/api/admin/tasks/${V.eHidden}/visibility`, { headers: h }), "hide E's question");
      // F's three: on E's two topics, and on one E does not ask (the control).
      V.f = {};
      for (const k of ["draft", "hidden", "fresh"]) {
        V.f[k] = await question(`${STAMP} F ${k}-topic question`, KEY[k]);
        await into(V.f[k], V.F.id);
      }
      // PRECONDITIONS, as the library the dialogs read says them.
      const lib = await ok(await api.get("/api/admin/tasks"), "library");
      const row = (id) => lib.find(t => t.id === id) || {};
      const inE = (id) => (row(id).competitions || []).some(c => c.id === V.E.id);
      expect([row(V.eDraft).status, inE(V.eDraft), row(V.eDraft).qualifying_keys], "E holds a DRAFT question on the first topic").toEqual(["draft", true, [KEY.draft]]);
      expect([row(V.eHidden).status, !!row(V.eHidden).active, inE(V.eHidden), row(V.eHidden).qualifying_keys], "and a HIDDEN one on the second").toEqual(["published", false, true, [KEY.hidden]]);
      for (const k of ["draft", "hidden", "fresh"]) {
        expect([row(V.f[k]).status, !!row(V.f[k]).active, inE(V.f[k]), row(V.f[k]).qualifying_keys], `F's ${k}-topic question: published, shown, not in E`).toEqual(["published", true, false, [KEY[k]]]);
      }
    } finally { await api.dispose(); }
  });

  test("Add challenges leaves out another event's question on a topic the event asks through a draft or a hidden question, and lists one on a topic it does not ask; Assign to Events agrees", async ({ page }) => {
    await adminLogin(page);
    await clickTab(page, "Challenges");
    await page.evaluate((id) => window.openTaskPickerForCompetition(id), V.E.id);
    const overlay = page.locator("#task-picker-overlay");
    await expect(overlay.locator("#task-picker-list")).toBeVisible({ timeout: 15000 });
    const row = (id) => overlay.locator(`#task-picker-list input[value="${id}"]`);
    // PRECONDITION, on screen: the hidden question is E's, listed and ticked with
    // its flag; the draft is E's too, never listed ("unaffected").
    await expect(row(V.eHidden)).toBeChecked();
    await expect(overlay.locator(".picker-row", { has: page.locator(`input[value="${V.eHidden}"]`) }).locator(".picker-row-flag", { hasText: "Hidden" })).toHaveCount(1);
    await expect(row(V.eDraft)).toHaveCount(0);
    // Each count is anchored on the dash the note writes before it, so "11" is no match.
    await expect(overlay.locator("#task-picker-note"), "the one draft, counted").toContainText(" — 1 assigned draft question(s) are not listed and are unaffected.");
    // CONTROL: a topic E does not ask is listed, offered, not ticked.
    await expect(row(V.f.fresh), "F's question on a topic E does not ask").toHaveCount(1);
    await expect(row(V.f.fresh)).toBeEnabled();
    await expect(row(V.f.fresh)).not.toBeChecked();
    // E asks the other two topics, through its draft and its hidden question.
    await expect(row(V.f.draft), "F's question on the topic E's DRAFT asks: not listed").toHaveCount(0);
    await expect(row(V.f.hidden), "F's question on the topic E's HIDDEN question asks: not listed").toHaveCount(0);
    // The whole note: the listing's count, then exactly these two parts, by value.
    await expect(overlay.locator("#task-picker-note"), "the draft and F's two questions, counted").toHaveText(
      /^[^—]+ — 1 assigned draft question\(s\) are not listed and are unaffected\. — 2 quick question\(s\) are not listed: this event already asks each of them\.$/);
    await overlay.locator('[data-action="overlay-close"]').click();
    await expect(overlay).toHaveCount(0);

    // Assign to Events, opened from each of F's questions: E disabled where its
    // draft or hidden question asks the topic, offered where it does not.
    await expect.poll(() => page.evaluate((ids) => ids.every(id => (window.S.adminTasksData || []).some(t => t.id === id)), [V.eDraft, V.eHidden, V.f.draft, V.f.hidden, V.f.fresh]), { timeout: 15000 }).toBe(true);
    const assign = page.locator("#assign-task-overlay");
    const eBox = assign.locator(`#assign-task-comp-list input[value="${V.E.id}"]`);
    for (const [k, held] of [["fresh", false], ["draft", true], ["hidden", true]]) {
      await page.evaluate((id) => window.openAssignTaskToComps(id), V.f[k]);
      await expect(assign.locator(`#assign-task-comp-list input[value="${V.F.id}"]`), `PRECONDITION: F's ${k}-topic question is F's`).toBeChecked();
      if (held) {
        await expect(eBox, `${k}: E already asks the topic`).toBeDisabled();
        await expect(assign.locator("#assign-task-comp-list label", { has: page.locator(`input[value="${V.E.id}"]`) }).locator(".picker-row-flag")).toHaveText("Topic already asked");
      } else {
        await expect(eBox, "CONTROL: a topic E does not ask").toBeEnabled();
        await expect(eBox).not.toBeChecked();
      }
      await assign.locator('[data-action="overlay-close"]').click();
      await expect(assign).toHaveCount(0);
    }
  });
});

// The challenge import skips an overwrite the qualifying-question rules refuse
// (tests/event-team-reports.spec.js holds the server), and the summary the
// importer reads says which rule and what to change in the file.
test("the challenge import's summary names each qualifying skip and what to change", async ({ page }) => {
  await adminLogin(page);
  const note = (d) => page.evaluate((x) => window._importDropNote(x), d);
  expect(await note({ qualifying_key_held_skipped: 1 })).toContain("1 challenge was not overwritten because the file would make it a qualifying question on a topic an event holding it already asks (an event asks each one once)");
  expect(await note({ qualifying_key_held_skipped: 2 })).toContain("2 challenges were not overwritten because the file would make them qualifying questions on a topic an event holding them already asks");
  expect(await note({ qualifying_options_fixed_skipped: 1 })).toContain("1 qualifying question was not overwritten because people have answered it and the file moves or removes options (reword an option where it stands, or add one at the end)");
  expect(await note({ qualifying_options_fixed_skipped: 3 })).toContain("3 qualifying questions were not overwritten because people have answered them");
  expect(await note({ qualifying_copy_skipped: 1 })).toContain("1 challenge was not overwritten because its row could mean more than one challenge: several share the title (each event's own copy of a qualifying question) or several rows of the file overwrite it (edit the question in its event, or choose Add New)");
  expect(await note({ qualifying_copy_skipped: 2 })).toContain("2 challenges were not overwritten because their rows could mean more than one challenge");
  expect(await note({ qualifying_tag_invalid_skipped: 1 })).toContain("1 challenge was not imported because its qualifying tag is not qualifying:<key>");
  expect(await note({ qualifying_tag_invalid_skipped: 2 })).toContain("2 challenges were not imported because their qualifying tag is not qualifying:<key>");
  expect(await note({ qualifying_key_held_skipped: 0, qualifying_options_fixed_skipped: 0, qualifying_copy_skipped: 0, qualifying_tag_invalid_skipped: 0 }), "CONTROL: nothing skipped, nothing said").toBe("");
});
