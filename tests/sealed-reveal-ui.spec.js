// @ts-check
//
// v8.12.2 — THE SUPERADMIN'S RECORDED REVEAL, in a real browser.
//
// `answer-seal.api.spec.js` and `impersonation-event-admin-view.api.spec.js`
// pin what the SERVER does with a reveal: the row carries `can_reveal_answer`
// for a superadmin who may reveal and `answer_revealed` once they have, the
// key and the hint are withheld until then, and the reveal writes a
// `sealed_reveal` History row plus an event-log line. This file locks what a
// human MEETS on the way — the half nothing else can see, and the half that
// could ship broken with every API arm green:
//
//  1. THE OFFER. A kebab item and an editor button that exist exactly where the
//     server would accept the reveal, and nowhere else: a regular admin gets
//     neither, and an UNSEALED twin gets neither for anybody. A control that is
//     not rendered is not shipped (v8.1.5); one rendered where the server is
//     certain to refuse it is the v7.14.2 defect.
//  2. THE CONFIRM. The reveal is a RECORDED act, so the platform says so before
//     the click — title "Reveal sealed answer", primary "Reveal and record".
//  3. THE CONSEQUENCE. After the reveal the same screens show the key and the
//     hint, the editor is editable, and the History dialog carries a row that
//     reads as a record rather than as a version.
//  4. THE HINT IS SEALED WITH THE ANSWER. New in v8.12.2: the editor hides the
//     hint group and the participant preview says the hint is withheld WITH the
//     seal as its reason — not the competitor sentence, which would tell a
//     superadmin they are competing.
//
// EVERY ARM CARRIES A CONTROL, for the reason the sibling seal spec states:
// "the item is absent" is equally satisfied by a build that renders no kebab
// items at all, and "the hint is withheld" by a build that shows nobody any
// hint — each a worse product than the defect being locked against.
//
// FIXTURES. Every test creates its OWN sealed challenge (with a hint) and its
// own unsealed twin through `makePair`, as the AUTHOR — a user-backed admin
// minted in `beforeAll`. Nothing seeded is touched. The built-in `superadmin`
// (`adminLogin(page)`) has no `users` row and can never be an author, so it is
// offered the reveal on any sealed challenge — which is what makes it the right
// actor for the reveal arms and the wrong one for the "not offered" control,
// which uses a REGULAR admin instead. A reveal lasts for the session it was
// made in, and each test gets a fresh browser context, so no test can inherit
// another's reveal; the History RECORD is durable, which is why (c) checks a
// row it made itself rather than one some earlier test may have left.
const { test, expect } = require("./isolated-test");
// `freshCtx` rather than a direct `@playwright/test` import — see the v7.20.0
// harness scanner: a direct import opts the whole file out of per-file isolation.
const { BASE, apiLogin, freshCtx, PARTICIPANT_PASS, codeLogin } = require("./helpers");
const { H, uniq, makeParticipant, makeCompetition, assignTask, enrol } = require("./event-admin-helpers");
const { loginViaApi, adminLogin, clickTab, openKebab, findSeededTaskRow } = require("./ui-admin-helpers");

test.use({ baseURL: BASE });

let sa, saCsrf, author, other, boss, boss2;

/** A user-backed global admin (`role: admin`). The browser signs in through loginViaApi. */
async function makeAdmin(label) {
  const p = await makeParticipant(sa, saCsrf, label);
  const r = await sa.post(`/api/admin/participants/${p.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
  expect(r.ok(), `promote ${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return p;
}

// Every fixture that needs the built-in superadmin's API session lives HERE:
// `adminLogin(page)` in the tests below signs the BROWSER in as that account,
// which purges `sa` (single session per user), so nothing after the first test
// may rely on it.
test.beforeAll(async () => {
  ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin"));
  author = await makeAdmin("uirvauthor");
  other  = await makeAdmin("uirvother");
  // v8.12.2 review — a USER-BACKED superadmin: the view toggle round trip needs
  // an account whose participant view is an ordinary one.
  boss = await makeAdmin("uirvboss");
  const rb = await sa.post(`/api/admin/participants/${boss.id}/role`, { headers: H(saCsrf), data: { role: "superadmin" } });
  expect(rb.ok(), `promote boss: ${rb.status()} ${await rb.text()}`).toBeTruthy();
  // …and a second one whose password (f2) changes, so no other arm depends on it.
  boss2 = await makeAdmin("uirvboss2");
  const rb2 = await sa.post(`/api/admin/participants/${boss2.id}/role`, { headers: H(saCsrf), data: { role: "superadmin" } });
  expect(rb2.ok(), `promote boss2: ${rb2.status()} ${await rb2.text()}`).toBeTruthy();
});

test.afterAll(async () => { await sa?.dispose(); });

/**
 * A sealed challenge WITH a hint and an unsealed twin, both created through the
 * API as the AUTHOR. Distinct key / hint strings per challenge, so a by-value
 * "the hint is nowhere in the page" assertion can tell the sealed one from the
 * control. Preconditions are asserted on the way out, never assumed.
 */
async function makePair(label) {
  const tag = uniq(label).replace(/[^a-zA-Z0-9]/g, "");
  const out = {
    tag,
    sealedTitle: `UISealedRv ${tag}`, plainTitle: `UIPlainRv ${tag}`,
    key: `UIKEY_${tag}`, hint: `UIHINT_${tag}`, why: `UIWHY_${tag}`,
    plainKey: `UIPLAINKEY_${tag}`, plainHint: `UIPLAINHINT_${tag}`,
    sealedId: null, plainId: null,
  };
  const { api: ctx, csrf: c1 } = await freshCtx();
  try {
    const li = await codeLogin(ctx, author.email, H(c1));
    expect(li.ok(), `author login: ${li.status()} ${await li.text()}`).toBeTruthy();
    const csrf = (await (await ctx.get("/api/csrf-token")).json()).csrfToken;
    const mk = async (title, sealed, key, hint, why) => {
      const r = await ctx.post("/api/admin/tasks", {
        headers: H(csrf),
        data: { title, description: "<p>d</p>", difficulty: "easy", answer_type: "text",
                correct_answer: key, explanation: `<p>${why}</p>`, hint: `<p>${hint}</p>`, status: "published",
                ...(sealed ? { answer_sealed: true } : {}) },
      });
      expect(r.ok(), `create ${title}: ${r.status()} ${await r.text()}`).toBeTruthy();
      return (await r.json()).id;
    };
    out.sealedId = await mk(out.sealedTitle, true,  out.key,      out.hint,      out.why);
    out.plainId  = await mk(out.plainTitle,  false, out.plainKey, out.plainHint, `PLAINWHY_${tag}`);
    // PRECONDITIONS, asserted rather than assumed: the seal took, the hint is
    // stored, and the author reads both — or every "withheld" assertion below
    // is satisfied by a challenge that never had a hint to withhold.
    const rows = await (await ctx.get("/api/admin/tasks")).json();
    const s = rows.find(t => t.id === out.sealedId);
    expect(s && s.answer_sealed, "the sealed fixture really is sealed").toBeTruthy();
    expect(s.hint, "…and carries its hint for the author").toContain(out.hint);
    expect(s.correct_answer).toBe(out.key);
    const p = rows.find(t => t.id === out.plainId);
    expect(p && !p.answer_sealed, "the twin really is unsealed").toBeTruthy();
    expect(p.hint).toContain(out.plainHint);
  } finally { await ctx.dispose(); }
  return out;
}

/** Open the Challenges tab on an already-signed-in admin page and wait for the model. */
async function openChallengesTab(page) {
  await clickTab(page, "Challenges");
  // The search input re-renders FROM the model, so a fill that lands before it
  // arrives filters an empty array (v8.10.0's own note).
  await expect.poll(() => page.evaluate(() => (window.adminTasksData || []).length), {
    message: "the challenge model loaded", timeout: 20_000,
  }).toBeGreaterThan(0);
}

/** Narrow the paginated table to ONE title and return its row. */
async function rowFor(page, title) {
  // `findSeededTaskRow` fills #task-search first — the v7.15.29 rule, and the
  // helper the v7.17.2 scanner credits for this table.
  const row = await findSeededTaskRow(page, title);
  await expect(row.first(), `the table narrowed to "${title}"`).toBeVisible({ timeout: 15_000 });
  return row.first();
}

/** Which of the sealed/reveal facts the browser's list model holds for a row — presence, not value. */
async function modelKeys(page, taskId) {
  return page.evaluate(id => {
    const t = (window.adminTasksData || []).find(x => x.id === id) || {};
    return {
      correct_answer: typeof t.correct_answer === "string",
      hint: typeof t.hint === "string",
      hint_withheld: t.hint_withheld === true,
      can_reveal_answer: t.can_reveal_answer === true,
      answer_revealed: t.answer_revealed === true,
    };
  }, taskId);
}

const portal = page => page.locator("#kebab-portal");
const revealItem = page => portal(page).locator("button[data-action='task-reveal-sealed']");
const editItem = page => portal(page).locator("button[data-action='task-edit']");

/**
 * Drive the "Reveal sealed answer" confirm to its primary button, wait for the
 * POST, and assert the toast. The toast is RECORDED by an observer installed
 * BEFORE the click rather than asserted off the live DOM afterwards: a toast
 * removes itself after four seconds, so an assertion that only starts once the
 * response and the list reload have settled would race the toast's own
 * lifetime under load — and fail naming a missing toast rather than a slow box.
 */
async function confirmReveal(page, taskId) {
  const overlay = page.locator("#modal-overlay.open");
  await overlay.waitFor({ state: "visible", timeout: 10_000 });
  await expect(page.locator("#modal-title"), "the confirm says what it is").toHaveText("Reveal sealed answer");
  await expect(page.locator("#modal-body"), "…and that it is recorded").toContainText(/recorded/i);
  // CONTROL for the seat arm in impersonation-event-admin-view.spec.js: outside
  // an organiser's panel the reveal DOES grant the edit, and says so.
  await expect(page.locator("#modal-body"), "outside a seat the confirm promises the edit").toContainText("be able to edit it");
  await expect(page.locator("#modal-confirm-btn"), "the primary button names the act").toHaveText("Reveal and record");
  await page.evaluate(() => {
    window.__revealToasts = [];
    const st = document.getElementById("toast-stack") || (() => { const d = document.createElement("div"); d.id = "toast-stack"; document.body.appendChild(d); return d; })();
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) window.__revealToasts.push(n.textContent || ""); })))
      .observe(st, { childList: true });
  });
  const posted = page.waitForResponse(r => r.url().includes(`/api/admin/tasks/${taskId}/sealed-reveal`) && r.request().method() === "POST", { timeout: 15_000 });
  await page.locator("#modal-confirm-btn").click();
  const res = await posted;
  expect(res.status(), `the reveal POST answered ${res.status()}`).toBe(200);
  await expect.poll(() => page.evaluate(() => (window.__revealToasts || []).join(" | ")),
    { message: "the toast reports the reveal AND that it was recorded", timeout: 10_000 })
    .toContain("Sealed answer and hint revealed — recorded in the challenge's history.");
  return res;
}

/** The description toolbar's switched-off and live controls, and its reason line (null while hidden). */
function descToolbar(page) {
  return page.evaluate(() => {
    const bar = document.querySelector("#tf-desc .rich-toolbar"), btns = [...bar.querySelectorAll("button")];
    const note = bar.querySelector(".rt-ro-note");
    return { off: btns.filter(b => b.disabled).length, on: btns.filter(b => !b.disabled).length, note: note && !note.hidden ? note.textContent : null };
  });
}

/** Wait until the list model carries the server's post-reveal answer for `taskId`. */
async function awaitRevealed(page, taskId) {
  await expect.poll(() => page.evaluate(id => {
    const t = (window.adminTasksData || []).find(x => x.id === id);
    return t ? `${t.answer_revealed === true}/${t.can_edit !== false}/${typeof t.correct_answer}` : "absent";
  }, taskId), { message: "the reloaded row says revealed + editable + key present", timeout: 20_000 })
    .toBe("true/true/string");
}

test.describe("v8.12.2 — the superadmin's recorded reveal in the admin UI", () => {

  test("(a) the built-in superadmin is OFFERED the reveal on a sealed row and not on its unsealed twin; revealing through the confirm shows the key and the hint in the editor", async ({ page }) => {
    const P = await makePair("ui-a");
    await adminLogin(page);
    await openChallengesTab(page);

    // BEFORE: neither the key nor the hint is anywhere in the page — the reveal
    // below has to have DONE something, or the editor assertions afterwards are
    // satisfied by a build that had never withheld them.
    const row = await rowFor(page, P.sealedTitle);
    expect(await page.content(), "the sealed key is not in the page before the reveal").not.toContain(P.key);
    expect(await page.content(), "…nor the sealed hint").not.toContain(P.hint);
    // Nor in the MODEL: the list row is the editor's only source, so a key or a
    // hint that reached the browser under any name would be one render away
    // from the screen. `S` is mirrored onto `window`, which is exactly why the
    // server must not send them (the v8.10.0 argument).
    expect(await modelKeys(page, P.sealedId), "neither key nor hint reached the browser before the reveal")
      .toEqual({ correct_answer: false, hint: false, hint_withheld: true, can_reveal_answer: true, answer_revealed: false });

    await openKebab(page, row);
    await expect(revealItem(page), "the sealed row offers the reveal to a superadmin").toHaveCount(1);
    await expect(revealItem(page)).toHaveText(/Reveal sealed answer/);
    await expect(editItem(page), "…and withholds Edit until then (can_edit is false)").toHaveCount(0);
    await expect(portal(page).locator(".kebab-note"), "the note names the reveal as the remedy, and says it is recorded")
      .toContainText("reveal it below to see the answer and hint and to change this challenge; the reveal is recorded");
    await page.keyboard.press("Escape");
    await expect(portal(page)).toBeHidden();

    // CONTROL: the UNSEALED twin, same session, same actor — no reveal item
    // (nothing to reveal) and Edit offered as on any ordinary challenge.
    const prow = await rowFor(page, P.plainTitle);
    await openKebab(page, prow);
    await expect(revealItem(page), "CONTROL: an unsealed challenge offers no reveal").toHaveCount(0);
    await expect(editItem(page), "CONTROL: …and its Edit is offered as usual").toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(portal(page)).toBeHidden();

    // THE REVEAL, through the row menu and the confirm.
    const row2 = await rowFor(page, P.sealedTitle);
    await openKebab(page, row2);
    await revealItem(page).click();
    await confirmReveal(page, P.sealedId);
    await awaitRevealed(page, P.sealedId);

    // AFTER: the same row now offers Edit and no longer offers the reveal — the
    // server's `answer_revealed` replaces `can_reveal_answer`, and the client
    // never re-derives either.
    const row3 = await rowFor(page, P.sealedTitle);
    await openKebab(page, row3);
    await expect(editItem(page), "Edit is offered once revealed").toHaveCount(1);
    await expect(revealItem(page), "…and the reveal item is gone (revealed is a state, not an offer)").toHaveCount(0);
    await expect(portal(page).locator(".kebab-note"), "no withheld-reason note remains on an editable row").toHaveCount(0);
    await editItem(page).click();
    const form = page.locator("#admin-task-form");
    await expect(form).toBeVisible();
    await expect(page.locator("#edit-task-id")).toHaveValue(P.sealedId);
    await expect(page.locator("#tf-answer"), "the key is filled in — this payload is the editor's only source").toHaveValue(P.key);
    await expect(page.locator("#tf-answer")).toBeEnabled();
    await expect(page.locator("#tf-hint-group"), "the hint group is SHOWN once revealed").toBeVisible();
    await expect(page.locator("#tf-hint .rich-body"), "…holding the sealed hint").toContainText(P.hint);
    await expect(page.locator("#save-task-btn"), "Save is offered").toBeVisible();
    await expect(page.locator("#tf-reveal-row"), "the in-editor reveal button is hidden once revealed").toBeHidden();
    await expect(page.locator("#tf-sealed-note"), "the note says the key is theirs by the recorded reveal, not by authorship")
      .toContainText("because you revealed it as a superadmin");
    await expect(page.locator("#tf-unseal-row"), "a revealing superadmin may also UNSEAL, like the author").toBeVisible();
  });

  test("(b) the editor path: a fresh superadmin session opens the sealed editor read-only with the hint group hidden and the reveal button offered; its button reveals and the form becomes editable with the key and hint filled", async ({ page }) => {
    const P = await makePair("ui-b");
    // A FRESH session by construction: each test gets its own browser context
    // and `adminLogin` signs in anew, so whatever (a) revealed died with (a)'s
    // session — the row must be sealed out again here or this arm is vacuous,
    // which the read-only assertions below establish first.
    await adminLogin(page);
    await openChallengesTab(page);
    await rowFor(page, P.sealedTitle);
    // The kebab withholds Edit for an unrevealed superadmin (locked in (a)), so
    // the editor is reached through `window.editTask`, as the sibling seal spec
    // does — the reachable way in for anyone who keeps a stale tab or a script.
    await page.evaluate(id => window.editTask(id), P.sealedId);
    await expect(page.locator("#admin-task-form")).toBeVisible();
    await expect(page.locator("#edit-task-id")).toHaveValue(P.sealedId);

    // READ-ONLY, WITH THE REASON AND THE REMEDY.
    await expect(page.locator("#tf-answer"), "the answer box is empty — nothing was sent").toHaveValue("");
    await expect(page.locator("#tf-answer"), "…and disabled, not merely blank").toBeDisabled();
    await expect(page.locator("#tf-title"), "and so is everything else").toBeDisabled();
    await expect(page.locator("#save-task-btn"), "with no Save offered").toBeHidden();
    await expect(page.locator("#tf-hint-group"), "the hint group is HIDDEN — the hint is sealed with the answer (v8.12.2)").toBeHidden();
    await expect(page.locator("#tf-reveal-row"), "the reveal control is offered in the editor").toBeVisible();
    await expect(page.locator("#tf-reveal-row button[data-action='task-reveal-sealed']")).toHaveText("Reveal sealed answer and hint");
    await expect(page.locator("#tf-reveal-row"), "…beside the note that it is recorded").toContainText("recorded in this challenge's history and the event log, naming you");
    await expect(page.locator("#tf-sealed-note"), "and the sealed note names the superadmin's door")
      .toContainText("As a superadmin you can reveal them and then edit this challenge; the reveal is recorded in the challenge's history, naming you.");
    expect(await page.content(), "the sealed hint is nowhere in the page before the reveal").not.toContain(P.hint);
    expect(await page.content()).not.toContain(P.key);
    // The description's toolbar is switched off, its line naming the same door.
    expect(await descToolbar(page), "every formatting control is off, under the reveal's reason")
      .toEqual({ off: 16, on: 0, note: "Read-only: its answer is sealed. Reveal it (recorded) to see and edit it." });

    // THE REVEAL, from the editor's own button.
    await page.locator("#tf-reveal-row button[data-action='task-reveal-sealed']").click();
    await confirmReveal(page, P.sealedId);
    await awaitRevealed(page, P.sealedId);

    // The open editor is RE-ENTERED on the reloaded row: editable, filled.
    await expect(page.locator("#tf-answer"), "the key is filled in").toHaveValue(P.key, { timeout: 15_000 });
    await expect(page.locator("#tf-answer")).toBeEnabled();
    await expect(page.locator("#tf-title")).toBeEnabled();
    await expect(page.locator("#tf-hint-group"), "the hint group is shown").toBeVisible();
    await expect(page.locator("#tf-hint .rich-body"), "…holding the hint").toContainText(P.hint);
    await expect(page.locator("#tf-hint .rich-body")).toHaveAttribute("contenteditable", "true");
    expect(await descToolbar(page), "…and the toolbar is back on, with no reason line").toEqual({ off: 0, on: 16, note: null });
    await expect(page.locator("#save-task-btn"), "Save is offered").toBeVisible();
    await expect(page.locator("#tf-reveal-row"), "the reveal button is gone").toBeHidden();
    await expect(page.locator("#tf-sealed-note")).toContainText("because you revealed it as a superadmin");

    // CONTROL: the UNSEALED twin's editor never shows the reveal row, and its
    // hint group was never hidden — so the visibility above is the seal's
    // doing, not a form that hides the hint group for everybody.
    await page.evaluate(id => window.editTask(id), P.plainId);
    await expect(page.locator("#edit-task-id")).toHaveValue(P.plainId);
    await expect(page.locator("#tf-reveal-row"), "CONTROL: no reveal control on an unsealed challenge").toBeHidden();
    await expect(page.locator("#tf-hint-group"), "CONTROL: the twin's hint group is visible").toBeVisible();
    await expect(page.locator("#tf-hint .rich-body")).toContainText(P.plainHint);
    await expect(page.locator("#tf-answer")).toHaveValue(P.plainKey);
  });

  test("(c) the History dialog renders the reveal as a RECORD: badge sealed_reveal, By superadmin, 'revealed to a superadmin', Action 'Record' — while an ordinary version still offers Restore and carries 'current'", async ({ page }) => {
    const P = await makePair("ui-c");
    // A SECOND ordinary version, so the dialog has both a "current" row and a
    // restorable one to serve as the control: with only the create row, the
    // absence of a Restore button on the reveal row would be indistinguishable
    // from a dialog that offers Restore to nobody.
    {
      const { api: ctx, csrf: c1 } = await freshCtx();
      try {
        await codeLogin(ctx, author.email, H(c1));
        const csrf = (await (await ctx.get("/api/csrf-token")).json()).csrfToken;
        const put = await ctx.put(`/api/admin/tasks/${P.sealedId}`, { headers: H(csrf), data: { title: `${P.sealedTitle} v2` } });
        expect(put.ok(), `author edit: ${put.status()} ${await put.text()}`).toBeTruthy();
      } finally { await ctx.dispose(); }
    }
    const title2 = `${P.sealedTitle} v2`;

    await adminLogin(page);
    // The reveal itself, on the page's own session, through the API — (a) and
    // (b) already lock the two client paths, and this arm is about what the
    // record LOOKS like afterwards. `page.request` shares the browser's cookie
    // jar, and `/api/csrf-token` hands back the session's existing token.
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const rv = await page.request.post(`/api/admin/tasks/${P.sealedId}/sealed-reveal`, { headers: H(csrf) });
    expect(rv.status(), `reveal: ${rv.status()} ${await rv.text()}`).toBe(200);
    expect((await rv.json()).revealed, "the reveal really happened (not the author's no-op)").toBe(true);

    await openChallengesTab(page);
    const row = await rowFor(page, title2);
    await openKebab(page, row);
    await portal(page).locator("button[data-action='task-history']").click();
    const dlg = page.locator("#hist-overlay");
    await expect(dlg).toBeVisible({ timeout: 10_000 });
    await expect(dlg.locator("#hist-title")).toContainText(title2);

    const rows = dlg.locator("#hist-body tr");
    await expect(rows.first()).toBeVisible();
    const revealRow = rows.filter({ has: page.locator(".history-type-badge", { hasText: /^sealed_reveal$/ }) });
    await expect(revealRow, "exactly one reveal record — this session's").toHaveCount(1);
    await expect(revealRow.locator("td").nth(0)).toContainText("sealed_reveal");
    await expect(revealRow.locator("td").nth(2), "By = the built-in superadmin, as getAdminIdentity names it").toHaveText(/^\s*superadmin\s*$/);
    await expect(revealRow.locator("td").nth(3), "the change cell is a SENTENCE, not a diff").toContainText("revealed to a superadmin");
    await expect(revealRow.locator("td").nth(3)).toContainText(/Sealed answer, explanation, hint/);
    await expect(revealRow.locator("td").nth(4), "the Action cell says Record").toHaveText(/^\s*Record\s*$/);
    await expect(revealRow.locator(".history-restore-btn"), "…and offers no Restore").toHaveCount(0);
    await expect(revealRow.locator(".history-current-badge"), "…and never takes the current badge").toHaveCount(0);
    expect(await revealRow.innerHTML(), "the record carries field NAMES, never the key").not.toContain(P.key);
    expect(await revealRow.innerHTML()).not.toContain(P.hint);
    // …while the ordinary rows' diffs DO show the key to the revealing
    // superadmin — the history is read as the author reads it once revealed,
    // which is what says the row above withholds the key by DESIGN rather than
    // because this reader was sealed out of the dialog.
    expect(await dlg.innerHTML(), "the create diff shows the key to the revealing superadmin").toContain(P.key);

    // CONTROLS, in the same dialog: the ordinary versions are versions.
    const current = rows.filter({ has: page.locator(".history-current-badge") });
    await expect(current, "exactly one row is current").toHaveCount(1);
    await expect(current.locator(".history-type-badge"), "…and it is the latest ORDINARY version, not the reveal").toHaveText("update");
    const restorable = rows.filter({ has: page.locator(".history-restore-btn") });
    await expect(restorable, "an older ordinary version offers Restore to the revealing superadmin").toHaveCount(1);
    await expect(restorable.locator(".history-type-badge")).toHaveText("create");
    await expect(restorable.locator("td").nth(4)).not.toContainText("Record");
    await dlg.locator("[data-action='history-close']").click();
    await expect(dlg).toBeHidden();
  });

  test("(d) a REGULAR admin is offered no reveal and no Edit, is told why, and previews the sealed hint as WITHHELD for the seal — while the unsealed twin's preview shows its hint (CONTROL)", async ({ page }) => {
    const P = await makePair("ui-d");
    await loginViaApi(page, other.email, PARTICIPANT_PASS);
    await page.goto("/");
    // `#admin-page` is the readiness signal — `.admin-nav-item` is static markup
    // and is attached before boot has resolved the role (v8.3.33).
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
    await openChallengesTab(page);

    const row = await rowFor(page, P.sealedTitle);
    await openKebab(page, row);
    await expect(revealItem(page), "a regular admin is NOT offered the reveal").toHaveCount(0);
    await expect(editItem(page), "…nor Edit").toHaveCount(0);
    await expect(portal(page).locator(".kebab-note"), "and the note names the superadmin's door as the only other way in")
      .toContainText("Its answer is sealed — only the person who created it, or a superadmin who reveals it on the record, can change this challenge");
    // The preview: the hint is WITHHELD, with the SEAL as the reason.
    await portal(page).locator("button[data-action='task-view']").click();
    const overlay = page.locator("#task-preview-overlay");
    await expect(overlay).toBeVisible();
    const hintBody = overlay.locator(".task-preview-hint-body");
    await expect(hintBody, "the preview says the hint is withheld").toContainText(/^\s*Withheld/);
    await expect(hintBody, "…because of the SEAL").toContainText("sealed with it");
    await expect(hintBody, "…and NOT the competitor sentence, which would be a false claim about this admin").not.toContainText("competing");
    await expect(overlay, "the solution box says why there is none").toContainText("answer is sealed");
    expect(await page.content(), "the sealed hint is nowhere in the page — not in a title, a data attribute or an off-screen node").not.toContain(P.hint);
    expect(await page.content(), "…nor the key").not.toContain(P.key);
    expect(await page.content(), "…nor the explanation").not.toContain(P.why);
    expect(await modelKeys(page, P.sealedId), "and none of it reached the browser's model either")
      .toEqual({ correct_answer: false, hint: false, hint_withheld: true, can_reveal_answer: false, answer_revealed: false });
    await overlay.locator("[data-action='task-preview-close']").first().click();
    await expect(overlay).toBeHidden();

    // CONTROL: the UNSEALED twin, same admin, same session — Edit offered, no
    // reveal (nothing to reveal), and the preview shows the hint TEXT.
    const prow = await rowFor(page, P.plainTitle);
    await openKebab(page, prow);
    await expect(editItem(page), "CONTROL: a global admin edits an ordinary challenge somebody else created").toHaveCount(1);
    await expect(revealItem(page), "CONTROL: no reveal on an unsealed challenge").toHaveCount(0);
    await portal(page).locator("button[data-action='task-view']").click();
    await expect(overlay).toBeVisible();
    await expect(overlay.locator(".task-preview-hint-body"), "CONTROL: the twin's hint is shown in full").toContainText(P.plainHint);
    await expect(overlay.locator(".task-preview-hint-body")).not.toContainText("Withheld");
    await expect(overlay.locator(".task-preview-answer"), "CONTROL: …and so is its answer").toContainText(P.plainKey);
    expect(await modelKeys(page, P.plainId), "CONTROL: the twin's key and hint DID reach the browser")
      .toEqual({ correct_answer: true, hint: true, hint_withheld: false, can_reveal_answer: false, answer_revealed: false });
  });
});

test.describe("v8.12.2 pre-release review — what a human meets after the fixes", () => {

  test("(e) a REGULAR admin impersonating a participant who PAID for a sealed hint sees 'Hint withheld' with its reason and no priced Show Hint button — while the same participant's paid PLAIN hint is shown (CONTROL)", async ({ page }) => {
    const P = await makePair("ui-e");
    const { api: sa2, csrf: sa2c } = await apiLogin("superadmin");
    let payer;
    try {
      const comp = await makeCompetition(sa2, sa2c, "uiehint", { duration_minutes: 120 });
      await assignTask(sa2, sa2c, P.sealedId, [comp.id]);
      await assignTask(sa2, sa2c, P.plainId, [comp.id]);
      payer = await makeParticipant(sa2, sa2c, "uiepayer");
      const stander = await makeParticipant(sa2, sa2c, "uiestander");
      await enrol(sa2, sa2c, comp.id, [payer.id, stander.id]);
      const { api: pctx, csrf: pc0 } = await freshCtx();
      try {
        const li = await codeLogin(pctx, payer.email, H(pc0));
        expect(li.ok(), await li.text()).toBeTruthy();
        const pc = (await (await pctx.get("/api/csrf-token")).json()).csrfToken;
        const sel = await pctx.post("/api/select-competition", { headers: H(pc), data: { competitionId: comp.id } });
        expect(sel.ok(), await sel.text()).toBeTruthy();
        for (const id of [P.sealedId, P.plainId]) {
          const b = await pctx.post(`/api/tasks/${id}/hint`, { headers: H(pc) });
          expect(b.ok(), `the participant pays for the hint: ${await b.text()}`).toBeTruthy();
        }
      } finally { await pctx.dispose(); }
      payer.compId = comp.id;
    } finally { await sa2.dispose(); }

    await loginViaApi(page, other.email, PARTICIPANT_PASS);
    const c1 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const imp = await page.request.post(`/api/admin/participants/${payer.id}/impersonate`, { headers: H(c1) });
    expect(imp.ok(), `impersonate: ${imp.status()} ${await imp.text()}`).toBeTruthy();
    const c2 = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    const sel = await page.request.post("/api/select-competition", { headers: H(c2), data: { competitionId: payer.compId } });
    expect(sel.ok(), await sel.text()).toBeTruthy();
    await page.goto("/");
    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20_000 });
    const open = async (id) => {
      const card = page.locator(`#task-grid [data-task-id="${id}"]`);
      await card.waitFor({ state: "visible", timeout: 20_000 });
      await card.click();
      await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 15_000 });
    };
    await open(P.sealedId);
    const area = page.locator("#hint-area");
    await expect(area, "the hint section says it is WITHHELD").toContainText("Hint withheld");
    await expect(area, "…and why").toContainText("sealed its hint");
    await expect(area).toHaveAttribute("data-hint-withheld", "1");
    // v8.12.2 second review — the reason is THIS reader's: an admin looking
    // through someone else's account, not "shown to participants competing in
    // this event" (true of the participant whose account it is, and false as an
    // explanation to the admin reading it).
    await expect(area).toHaveAttribute("data-hint-withheld-reason", "impersonating");
    await expect(area, "the sentence names the real reason").toContainText("not shown to an admin looking through someone else's account");
    await expect(area, "…and not the one-size sentence it replaced").not.toContainText("shown to participants competing in this event");
    await expect(page.locator("[data-action='task-reveal-hint']"), "NO priced Show Hint over a hint the reader can never be given").toHaveCount(0);
    expect(await page.content(), "the paid sealed hint is nowhere in the admin's page").not.toContain(P.hint);
    // CONTROL — the plain twin the same participant paid for IS shown, so the
    // withheld panel above is the seal's doing, not a build that hides hints.
    await page.locator("#task-detail-page [data-action='back-to-tasks'], #task-detail-page .back-btn").first().click();
    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 15_000 });
    await open(P.plainId);
    await expect(page.locator("#hint-area"), "CONTROL: the paid plain hint is rendered").toContainText(P.plainHint);
    await expect(page.locator("#hint-area")).not.toHaveAttribute("data-hint-withheld", "1");
  });

  test("(f) a view round trip (Admin → Participant → Admin) drops the reveal, and the Challenges list re-reads rather than offering Edit on a row the server now refuses", async ({ page }) => {
    const P = await makePair("ui-f");
    await loginViaApi(page, boss.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
    await openChallengesTab(page);
    const row = await rowFor(page, P.sealedTitle);
    await openKebab(page, row);
    await revealItem(page).click();
    await confirmReveal(page, P.sealedId);
    await awaitRevealed(page, P.sealedId);
    // Down to participant view and back up. Each leg REGENERATES the session,
    // which drops the reveal marker (by design): the list must follow.
    await require("./chrome-helpers").pressAccountMenuItem(page, "toggle-admin-view", "false");
    await page.locator("#nav-competitions").waitFor({ state: "visible", timeout: 15_000 }); // the participant shell took over
    await require("./chrome-helpers").pressAccountMenuItem(page, "toggle-admin-view", "true");
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
    await expect.poll(() => modelKeys(page, P.sealedId), { message: "the list re-read the sealed row after the regenerate", timeout: 20_000 })
      .toEqual({ correct_answer: false, hint: false, hint_withheld: true, can_reveal_answer: true, answer_revealed: false });
    const row2 = await rowFor(page, P.sealedTitle);
    await openKebab(page, row2);
    await expect(editItem(page), "no Edit on a row the server would now refuse").toHaveCount(0);
    await expect(revealItem(page), "…and the Reveal item is back to recover with").toHaveCount(1);
  });



  test("(g) a non-author superadmin previewing a sealed MULTIPLE-CHOICE challenge is not told the correct set is 'visible only to the author' — the reveal is named — while the unsealed twin's preview asks the question (CONTROL)", async ({ page }) => {
    const tag = uniq("uig").replace(/[^a-zA-Z0-9]/g, "");
    const titles = { sealed: `UISealedMC ${tag}`, plain: `UIPlainMC ${tag}` };
    const { api: ctx, csrf: c1 } = await freshCtx();
    try {
      const li = await codeLogin(ctx, author.email, H(c1));
      expect(li.ok(), await li.text()).toBeTruthy();
      const csrf = (await (await ctx.get("/api/csrf-token")).json()).csrfToken;
      for (const [k, sealed] of [["sealed", true], ["plain", false]]) {
        const r = await ctx.post("/api/admin/tasks", {
          headers: H(csrf),
          data: { title: titles[k], description: "<p>q</p>", difficulty: "easy", answer_type: "choice", status: "published",
            choices: [{ text: `RIGHT_${tag}`, correct: true }, { text: `WRONG_${tag}`, correct: false }],
            ...(sealed ? { answer_sealed: true } : {}) },
        });
        expect(r.ok(), `create ${k}: ${await r.text()}`).toBeTruthy();
      }
    } finally { await ctx.dispose(); }
    await adminLogin(page);
    await openChallengesTab(page);
    const overlay = page.locator("#task-preview-overlay");
    const row = await rowFor(page, titles.sealed);
    await openKebab(page, row);
    await portal(page).locator("button[data-action='task-view']").click();
    await expect(overlay).toBeVisible();
    const label = overlay.locator(".choice-review-label");
    await expect(label, "the sealed label names the reveal").toContainText("a superadmin who reveals it on the record");
    await expect(overlay, "…and never the pre-v8.12.2 claim").not.toContainText("visible only to the author");
    await expect(overlay.locator(".choice-review-row.is-correct"), "nothing is marked correct for a sealed-out reader").toHaveCount(0);
    await overlay.locator("[data-action='task-preview-close']").first().click();
    await expect(overlay).toBeHidden();
    const prow = await rowFor(page, titles.plain);
    await openKebab(page, prow);
    await portal(page).locator("button[data-action='task-view']").click();
    await expect(overlay).toBeVisible();
    await expect(overlay.locator(".choice-review-label"), "CONTROL: the unsealed twin asks the question").toContainText("Select one answer:");
    await expect(overlay.locator(".choice-review-row.is-correct"), "CONTROL: …and marks its answer").toHaveCount(1);
  });
});

test.describe("v8.12.2 second review — the client follows the fixes", () => {

  test("(h) Show Hint re-checks the server first: when the fresh read says the hint is now WITHHELD, the priced 'Reveal Hint' confirm is never shown and the card re-renders with the reason — while an ordinary click still asks (CONTROL)", async ({ page }) => {
    const P = await makePair("ui-h");
    const { api: sa2, csrf: sa2c } = await apiLogin("superadmin");
    let part;
    try {
      const comp = await makeCompetition(sa2, sa2c, "uihhint", { duration_minutes: 120 });
      await assignTask(sa2, sa2c, P.sealedId, [comp.id]);
      part = await makeParticipant(sa2, sa2c, "uihpart");
      const stander = await makeParticipant(sa2, sa2c, "uihstander");
      await enrol(sa2, sa2c, comp.id, [part.id, stander.id]);
      part.compId = comp.id;
    } finally { await sa2.dispose(); }
    await loginViaApi(page, part.email, PARTICIPANT_PASS);
    const c = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    expect((await page.request.post("/api/select-competition", { headers: H(c), data: { competitionId: part.compId } })).ok()).toBeTruthy();
    await page.goto("/");
    await page.locator("#tasks-page.active").waitFor({ state: "visible", timeout: 20_000 });
    await page.locator(`#task-grid [data-task-id="${P.sealedId}"]`).click();
    await page.locator("#task-detail-page.active").waitFor({ state: "visible", timeout: 15_000 });
    const btn = page.locator("[data-action='task-reveal-hint']");
    await expect(btn, "PRECONDITION: a scoring participant is offered the priced hint").toHaveCount(1);
    // CONTROL — an ordinary click asks before charging.
    await btn.click();
    await expect(page.locator("#modal-title"), "CONTROL: the priced confirm appears when nothing changed").toHaveText("Reveal Hint");
    await page.locator("#modal-cancel-btn").click();
    await expect(page.locator("#modal-overlay.open")).toHaveCount(0);
    // Now the fresh read says the reader can never be given it (they stopped
    // scoring here since the card rendered — simulated at the wire, which is
    // the client branch under test).
    let hintPosts = 0;
    page.on("request", r => { if (r.method() === "POST" && r.url().includes(`/api/tasks/${P.sealedId}/hint`)) hintPosts++; });
    await page.route(`**/api/tasks/${P.sealedId}`, async route => {
      if (route.request().method() !== "GET") return route.continue();
      const res = await route.fetch();
      const j = await res.json();
      delete j.hint;
      Object.assign(j, { hint_available: false, hint_withheld: true, hint_withheld_reason: "not_competing" });
      await route.fulfill({ response: res, json: j });
    });
    await btn.click();
    await expect(page.locator("#hint-area"), "the card re-rendered from the server: withheld, with the reason").toHaveAttribute("data-hint-withheld", "1", { timeout: 10_000 });
    await expect(page.locator("#hint-area")).toContainText("You are here as staff and are not competing");
    await expect(page.locator("#modal-overlay.open"), "no priced confirm for a hint that can never be given").toHaveCount(0);
    expect(hintPosts, "and nothing was POSTed").toBe(0);
  });

  test("(i) a view round trip leaves an editor open on an UNSEALED challenge exactly as it was — unsaved edit and all — and re-renders one open on a REVEALED row sealed again, saying why", async ({ page }) => {
    const P = await makePair("ui-i");
    await loginViaApi(page, boss.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
    await openChallengesTab(page);
    const roundTrip = async () => {
      await require("./chrome-helpers").pressAccountMenuItem(page, "toggle-admin-view", "false");
      await page.locator("#nav-competitions").waitFor({ state: "visible", timeout: 15_000 }); // the participant shell took over
      await require("./chrome-helpers").pressAccountMenuItem(page, "toggle-admin-view", "true");
      await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
      await expect.poll(() => modelKeys(page, P.sealedId), { message: "the list re-read the sealed row", timeout: 20_000 })
        .toMatchObject({ correct_answer: false, answer_revealed: false });
    };
    // 1. Reveal the sealed row, then edit the UNSEALED twin and type without saving.
    await openKebab(page, await rowFor(page, P.sealedTitle));
    await revealItem(page).click();
    await confirmReveal(page, P.sealedId);
    await awaitRevealed(page, P.sealedId);
    await openKebab(page, await rowFor(page, P.plainTitle));
    await editItem(page).click();
    await expect(page.locator("#admin-task-form")).toBeVisible();
    const typed = `UNSAVED EDIT ${P.tag}`;
    await page.locator("#tf-title").fill(typed);
    await roundTrip();
    await expect(page.locator("#admin-task-form"), "the unsealed editor is still open").toBeVisible();
    await expect(page.locator("#tf-title"), "…with the unsaved edit untouched").toHaveValue(typed);
    // 2. CONTROL-in-reverse — an editor open on the REVEALED row is re-rendered
    //    sealed, and the operator is told why.
    await page.evaluate(() => window.closeTaskForm());
    await openChallengesTab(page);
    await openKebab(page, await rowFor(page, P.sealedTitle));
    await revealItem(page).click();
    await confirmReveal(page, P.sealedId);
    await awaitRevealed(page, P.sealedId);
    await openKebab(page, await rowFor(page, P.sealedTitle));
    await editItem(page).click();
    await expect(page.locator("#tf-answer"), "PRECONDITION: the revealed editor holds the key").toHaveValue(P.key);
    await page.evaluate(() => {
      window.__rtToasts = [];
      const st = document.getElementById("toast-stack");
      new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) window.__rtToasts.push(n.textContent || ""); })))
        .observe(st, { childList: true });
    });
    await roundTrip();
    await expect(page.locator("#tf-answer"), "the key is gone from the form").not.toHaveValue(P.key, { timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => (window.__rtToasts || []).join(" | ")), { message: "the operator is told the reveal ended", timeout: 10_000 })
      .toContain("Your reveal of this sealed answer ended when your session changed");
  });

  test("(j) the History sentence for each seat answer: named, withheld (with no view named even if one arrived), deleted — and an ordinary reveal names no seat at all (CONTROL)", async ({ page }) => {
    await adminLogin(page);
    await page.waitForFunction(() => typeof window._fmtRevealRow === "function", null, { timeout: 20_000 });
    const text = d => page.evaluate(det => { const el = document.createElement("div"); el.innerHTML = window._fmtRevealRow({ details: det }); return el.textContent; }, d);
    const base = { fields: ["correct_answer", "hint"], impersonated_by: "sup@acme.com" };
    const named = await text({ ...base, via: "impersonated_admin_view", acting_as: "org@acme.com" });
    expect(named).toContain("in an impersonated organiser's panel");
    expect(named).toContain("while impersonating org@acme.com");
    const withheld = await text({ ...base, via: "impersonated_admin_view", acting_as_withheld: true });
    expect(withheld).toContain("while impersonating an account outside your events");
    expect(withheld, "a withheld seat names no view, even if one arrived").not.toContain("organiser");
    const deleted = await text({ ...base, acting_as_deleted: true });
    expect(deleted).toContain("an account that has since been deleted");
    const plain = await text({ fields: ["correct_answer", "hint"], via: "admin_panel" });
    expect(plain, "CONTROL: an ordinary reveal names nobody").not.toContain("impersonating");
    expect(plain).toContain("revealed to a superadmin");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v8.12.2 FINAL REVIEW — three client guards the second-review arms could not
// kill. A failed list load IS schedulable (page.route → 500), so each is pinned
// by a test that fails without it. Only a SUPERSEDED load stays reason-traced.
// ─────────────────────────────────────────────────────────────────────────────
test.describe("v8.12.2 final review — the editor after a failed load, and staged uploads", () => {

  /** Fail every GET of the challenge LIST (the loader sends no query string). */
  // ONE predicate object, so `page.unroute` can find the handler it installed.
  const isTheList = u => new URL(u).pathname === "/api/admin/tasks";
  const failTheList = page => page.route(isTheList,
    route => route.request().method() === "GET"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "planted by test" }) })
      : route.continue());
  const recordToasts = page => page.evaluate(() => {
    window.__fToasts = [];
    const st = document.getElementById("toast-stack") || (() => { const d = document.createElement("div"); d.id = "toast-stack"; document.body.appendChild(d); return d; })();
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) window.__fToasts.push(n.textContent || ""); })))
      .observe(st, { childList: true });
  });
  const toasts = page => page.evaluate(() => (window.__fToasts || []).join(" | "));
  const roundTrip = async page => {
    await require("./chrome-helpers").pressAccountMenuItem(page, "toggle-admin-view", "false");
    await page.locator("#nav-competitions").waitFor({ state: "visible", timeout: 15_000 }); // the participant shell took over
    await require("./chrome-helpers").pressAccountMenuItem(page, "toggle-admin-view", "true");
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
  };

  test("(k) a reveal whose list reload FAILS leaves the editor open in its pre-reveal state and says nothing false — no 'no longer available' — and a successful reload afterwards re-enters it revealed (CONTROL)", async ({ page }) => {
    const P = await makePair("ui-k");
    await adminLogin(page);
    await openChallengesTab(page);
    await rowFor(page, P.sealedTitle);
    await page.evaluate(id => window.editTask(id), P.sealedId);
    await expect(page.locator("#tf-reveal-row"), "PRECONDITION: the editor offers the reveal").toBeVisible();
    await failTheList(page);
    await recordToasts(page);
    await page.locator("#tf-reveal-row button[data-action='task-reveal-sealed']").click();
    await confirmReveal(page, P.sealedId);
    await expect.poll(() => toasts(page), { message: "the loader reported the failed load", timeout: 10_000 })
      .toContain("Could not load the challenge list");
    await expect(page.locator("#admin-task-form"), "the editor is still open").toBeVisible();
    await expect(page.locator("#edit-task-id")).toHaveValue(P.sealedId);
    await expect(page.locator("#tf-answer"), "…in the state it already had: sealed, read-only").toBeDisabled();
    expect(await toasts(page), "no false 'no longer available' after a load that merely failed").not.toContain("no longer available");
    // CONTROL: the reveal really happened server-side, and a reload that lands
    // re-enters the editor revealed.
    await page.unroute(isTheList);
    await page.evaluate(() => window.loadAdminTasks());
    await awaitRevealed(page, P.sealedId);
    await page.evaluate(id => window.editTask(id), P.sealedId);
    await expect(page.locator("#tf-answer"), "CONTROL: revealed once the list lands").toHaveValue(P.key, { timeout: 15_000 });
  });

  test("(l) after a session change, an editor open on a REVEALED row whose list reload FAILS is CLOSED with the true reason — never left holding a key the session no longer allows", async ({ page }) => {
    const P = await makePair("ui-l");
    await loginViaApi(page, boss.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
    await openChallengesTab(page);
    await openKebab(page, await rowFor(page, P.sealedTitle));
    await revealItem(page).click();
    await confirmReveal(page, P.sealedId);
    await awaitRevealed(page, P.sealedId);
    await openKebab(page, await rowFor(page, P.sealedTitle));
    await editItem(page).click();
    await expect(page.locator("#tf-answer"), "PRECONDITION: the revealed editor holds the key").toHaveValue(P.key);
    await failTheList(page);
    await recordToasts(page);
    await roundTrip(page);
    await expect(page.locator("#admin-task-form"), "the editor is closed").toBeHidden({ timeout: 15_000 });
    await expect.poll(() => toasts(page), { message: "…and the operator is told why", timeout: 10_000 })
      .toContain("so the editor was closed");
    expect(await page.content(), "the key is nowhere on the page").not.toContain(P.key);
  });

  test("(m) after a session change, an editor open on a REVEALED row DISCARDS the uploads staged in it — the staging row is deleted on the server, not orphaned — and the re-rendered form does not list it", async ({ page }) => {
    const P = await makePair("ui-m");
    await loginViaApi(page, boss.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
    await openChallengesTab(page);
    await openKebab(page, await rowFor(page, P.sealedTitle));
    await revealItem(page).click();
    await confirmReveal(page, P.sealedId);
    await awaitRevealed(page, P.sealedId);
    await openKebab(page, await rowFor(page, P.sealedTitle));
    await editItem(page).click();
    await expect(page.locator("#tf-answer"), "PRECONDITION: the revealed editor is editable").toBeEnabled();
    // Stage an upload through the editor's own controls.
    const dname = `staged ${P.tag}`;
    await page.locator("#tf-attach-add-btn").click();
    await page.locator("#tf-attach-file").setInputFiles({ name: "staged.zip", mimeType: "application/zip", buffer: zipOf("README.txt", `staged ${P.tag}`) });
    await page.locator("#tf-attach-dname").fill(dname);
    const staged = page.waitForResponse(r => r.url().endsWith("/api/admin/attachment-staging") && r.request().method() === "POST", { timeout: 15_000 });
    await page.locator("button[data-action='confirm-attach-upload']").click();
    const sr = await staged;
    expect(sr.status(), `the upload was staged: ${await sr.text()}`).toBeLessThan(300);
    const stagingId = (await sr.json()).staging_id;
    expect(stagingId, "PRECONDITION: a staging id").toBeTruthy();
    await expect(page.locator("#tf-attachments-list"), "PRECONDITION: the staged chip is listed").toContainText(dname);
    const deleted = page.waitForResponse(r => r.url().endsWith(`/api/admin/attachment-staging/${stagingId}`) && r.request().method() === "DELETE", { timeout: 20_000 });
    await roundTrip(page);
    const dr = await deleted;
    expect(dr.status(), "the staging row was deleted on the server").toBeLessThan(300);
    await expect(page.locator("#tf-answer"), "the editor was re-rendered sealed").not.toHaveValue(P.key, { timeout: 15_000 });
    await expect(page.locator("#tf-attachments-list"), "…and no longer lists the discarded upload").not.toContainText(dname);
  });
});

test.describe("v8.12.2 final review — a reveal record is not a diff baseline", () => {

  test("(n) the version AFTER a reveal record diffs against the previous real VERSION, so an attachment added before the reveal still shows in that version's change — the reveal's own snapshot, which already carries it, is never the baseline", async ({ page }) => {
    // history.js skips reveal rows when choosing a diff baseline. Every other UI
    // fixture had the reveal as the NEWEST row, so the skip never ran. Here the
    // order is: v1 (create) → an attachment added directly (no version) → the
    // reveal (its snapshot carries the attachment) → v2 (a title edit). Diffed
    // against v1, v2 shows the attachment AND the title; diffed against the
    // reveal's snapshot it would show the title alone and hide the attachment.
    const P = await makePair("ui-n");
    const dname = `diffatt ${P.tag}`;
    const title2 = `${P.sealedTitle} v2`;
    const signInAs = async email => {
      const { api: ctx, csrf: c1 } = await freshCtx();
      const li = await codeLogin(ctx, email, H(c1));
      expect(li.ok(), `login ${email}: ${li.status()} ${await li.text()}`).toBeTruthy();
      return { ctx, csrf: (await (await ctx.get("/api/csrf-token")).json()).csrfToken };
    };
    const versionsOf = async ctx => { const b = await (await ctx.get(`/api/admin/tasks/${P.sealedId}/versions`)).json(); return Array.isArray(b) ? b : (b.versions || []); };
    {
      const { ctx, csrf } = await signInAs(author.email);
      try {
        const up = await ctx.post(`/api/admin/tasks/${P.sealedId}/attachments`, {
          headers: { "x-csrf-token": csrf },
          multipart: { file: { name: "diffatt.zip", mimeType: "application/zip", buffer: zipOf("README.txt", `diff ${P.tag}`) }, display_name: dname },
        });
        expect(up.ok(), `attach: ${up.status()} ${await up.text()}`).toBeTruthy();
        expect((await versionsOf(ctx)).length, "PRECONDITION: the direct attachment wrote no version").toBe(1);
      } finally { await ctx.dispose(); }
    }
    {
      const { ctx, csrf } = await signInAs(boss.email);
      try {
        const rv = await ctx.post(`/api/admin/tasks/${P.sealedId}/sealed-reveal`, { headers: H(csrf) });
        expect(rv.status(), `reveal: ${await rv.text()}`).toBe(200);
        expect((await rv.json()).revealed).toBe(true);
      } finally { await ctx.dispose(); }
    }
    {
      const { ctx, csrf } = await signInAs(author.email);
      try {
        const put = await ctx.put(`/api/admin/tasks/${P.sealedId}`, { headers: H(csrf), data: { title: title2 } });
        expect(put.ok(), `author edit: ${put.status()} ${await put.text()}`).toBeTruthy();
        const vs = await versionsOf(ctx);
        expect(vs.map(v => v.change_type), "PRECONDITION: update, reveal, create — newest first").toEqual(["update", "sealed_reveal", "create"]);
        const revealSnap = JSON.parse(vs[1].snapshot);
        expect((revealSnap.attachments || []).map(a => a.display_name), "PRECONDITION: the reveal's snapshot already carries the attachment").toContain(dname);
      } finally { await ctx.dispose(); }
    }
    await loginViaApi(page, author.email, PARTICIPANT_PASS);
    await page.goto("/");
    await page.waitForSelector("#admin-page", { state: "visible", timeout: 20_000 });
    await openChallengesTab(page);
    await openKebab(page, await rowFor(page, title2));
    await portal(page).locator("button[data-action='task-history']").click();
    const dlg = page.locator("#hist-overlay");
    await expect(dlg).toBeVisible({ timeout: 10_000 });
    const rows = dlg.locator("#hist-body tr");
    const upd = rows.filter({ has: page.locator(".history-type-badge", { hasText: /^update$/ }) });
    await expect(upd).toHaveCount(1);
    await expect(rows.filter({ has: page.locator(".history-type-badge", { hasText: /^sealed_reveal$/ }) }), "the reveal record sits between them").toHaveCount(1);
    await expect(upd.locator("td").nth(3), "the title change is shown").toContainText(title2);
    await expect(upd.locator("td").nth(3), "…and so is the attachment added before the reveal — the baseline is v1, not the reveal").toContainText(dname);
  });
});

test.describe("v8.12.2 final review — the end-of-event card explains a sealed hint it does not show", () => {

  test("(o) at an event that reveals answers, a participant who never bought the sealed hint is told the hint is sealed too; one who paid for it sees it and no such sentence (CONTROL); and a card whose answer is withheld because the reader competes says THAT, not 'only a superadmin can reveal it'", async ({ page, browser }) => {
    const P = await makePair("ui-o");
    const iso = ms => new Date(Date.now() + ms).toISOString();
    const signInAs = async email => {
      const { api: ctx, csrf: c1 } = await freshCtx();
      const li = await codeLogin(ctx, email, H(c1));
      expect(li.ok(), `login ${email}: ${li.status()} ${await li.text()}`).toBeTruthy();
      return { ctx, csrf: (await (await ctx.get("/api/csrf-token")).json()).csrfToken };
    };
    // The participants are made through the USER-BACKED superadmin: the built-in
    // account's API session (`sa`) is purged by the first test that signs the
    // browser in as it, so a test that may run after one cannot use `sa`.
    let payer, nonpayer;
    {
      const { ctx, csrf } = await signInAs(boss.email);
      try {
        payer = await makeParticipant(ctx, csrf, "uirvpayer");
        nonpayer = await makeParticipant(ctx, csrf, "uirvnonpayer");
      } finally { await ctx.dispose(); }
    }
    let compId;
    {
      const { ctx, csrf } = await signInAs(author.email);
      try {
        const comp = await ctx.post("/api/admin/competitions", { headers: H(csrf),
          data: { name: uniq("UI Seal Hint Reveal"), start_time: iso(-60_000), duration_minutes: 60, event_kind: "tournament", reveal_answers_on_end: true } });
        expect(comp.ok(), `competition: ${await comp.text()}`).toBeTruthy();
        compId = (await comp.json()).competition.id;
        for (const id of [P.sealedId, P.plainId]) {
          const a = await ctx.post(`/api/admin/tasks/${id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
          expect(a.ok(), `assign: ${await a.text()}`).toBeTruthy();
        }
      } finally { await ctx.dispose(); }
    }
    // Two enrollees who never solve, so the all-solved auto-end cannot fire.
    {
      const { ctx, csrf } = await signInAs(boss.email);
      try {
        const asg = await ctx.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [payer.id, nonpayer.id], competitionIds: [compId] } });
        expect(asg.ok(), `assign: ${await asg.text()}`).toBeTruthy();
        expect((await asg.json()).assigned, "PRECONDITION: both enrolled").toBe(2);
      } finally { await ctx.dispose(); }
    }
    // The payer buys the sealed hint while the event is live — a scoring
    // participant is entitled to (v8.12.2's paid-hint exemption).
    {
      const { ctx, csrf } = await signInAs(payer.email);
      try {
        const sel = await ctx.post("/api/select-competition", { headers: H(csrf), data: { competitionId: compId } });
        expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
        const h = await ctx.post(`/api/tasks/${P.sealedId}/hint`, { headers: H(csrf) });
        expect(h.ok(), `the payer buys the sealed hint: ${h.status()} ${await h.text()}`).toBeTruthy();
      } finally { await ctx.dispose(); }
    }
    {
      const { ctx, csrf } = await signInAs(author.email);
      try {
        const end = await ctx.post(`/api/admin/competitions/${compId}/end-now`, { headers: H(csrf) });
        expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();
      } finally { await ctx.dispose(); }
    }
    const enter = async (pg, email) => {
      await loginViaApi(pg, email, PARTICIPANT_PASS);
      const pc = (await (await pg.request.get("/api/csrf-token")).json()).csrfToken;
      const sel = await pg.request.post("/api/select-competition", { headers: H(pc), data: { competitionId: compId } });
      expect(sel.ok(), `select: ${await sel.text()}`).toBeTruthy();
      expect((await pg.request.post("/api/dismiss-ended", { headers: H(pc) })).ok()).toBeTruthy();
      await pg.goto("/");
      await pg.waitForSelector("#nav-challenges:not([aria-disabled=true])", { state: "visible", timeout: 20_000 });
      await pg.locator("#nav-challenges:not([aria-disabled=true])").click();
    };
    const open = async (pg, id) => {
      await pg.evaluate(i => window.openTask(i), id);
      await pg.waitForSelector("#task-detail-page.active", { timeout: 15_000 });
    };

    // THE NON-PAYER: the sealed hint is not on the card, and the card says why.
    await enter(page, nonpayer.email);
    await open(page, P.plainId);
    await expect(page.locator("#task-detail-card"), "PRECONDITION: the reveal fired (the plain key is published)").toContainText(P.plainKey);
    await open(page, P.sealedId);
    const card = page.locator("#task-detail-card");
    await expect(card).toContainText("Answer not shown");
    await expect(card, "the hint's absence is explained").toContainText("Its hint is sealed with it, so it is not shown either.");
    await expect(card, "…with the ordinary reason").toContainText("only a superadmin can reveal it");
    expect(await page.content(), "the sealed hint is nowhere").not.toContain(P.hint);

    // THE COMPETING READER: the same card rendered from a payload whose answer
    // is withheld because the reader competes names THAT reason, not the one a
    // competing superadmin cannot act on.
    await page.route(u => new URL(u).pathname === `/api/tasks/${P.sealedId}`, async route => {
      const r = await route.fetch();
      const body = await r.json();
      await route.fulfill({ response: r, json: { ...body, answer_withheld_reason: "competing_elsewhere" } });
    });
    await open(page, P.sealedId);
    await expect(card, "the competing reason").toContainText("you are competing in an event that also holds this challenge");
    await expect(card, "…and not the superadmin remedy").not.toContainText("only a superadmin can reveal it");

    // CONTROL — THE PAYER: their hint is on the card and no sentence claims it is hidden.
    const ctx2 = await browser.newContext({ baseURL: BASE });
    try {
      const p2 = await ctx2.newPage();
      await enter(p2, payer.email);
      await open(p2, P.sealedId);
      const c2 = p2.locator("#task-detail-card");
      await expect(c2, "the paid hint is shown").toContainText(P.hint);
      await expect(c2).toContainText("Answer not shown");
      await expect(c2, "…and nothing claims it is hidden").not.toContainText("Its hint is sealed with it");
    } finally { await ctx2.close(); }
  });
});

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (const b of buf) {
    c = (crc ^ b) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
/** A one-entry stored ZIP — the shape `staff-compete-admin-ui-fixture.js` builds. */
function zipOf(name, body) {
  const nameBuf = Buffer.from(name), data = Buffer.from(body), crc = crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(10, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
  lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(10, 6); cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(0, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14); cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(0, 42);
  const local = Buffer.concat([lh, nameBuf, data]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + nameBuf.length, 12); eocd.writeUInt32LE(local.length, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([local, cd, nameBuf, eocd]);
}
