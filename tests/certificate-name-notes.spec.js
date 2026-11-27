// @ts-check
//
// THE SHARE DIALOG SAYS HOW THE CERTIFICATE PRINTS THE NAME, IN ONE LINE AT MOST
// (public/js/features/badge-share.js; operator ruling, 14 Nov 2026).
//
//   • When the certificate leaves the salutation off (a "Dr." before an Arabic
//     name, which the certificate typeface cannot print with it: lib/badge.js
//     `certificatePrintedName`), the dialog says so, in the place the nickname
//     note takes.
//   • CONTROLS: no line for "Dr. Jane Doe" (the salutation is printed) nor for an
//     Arabic name with no salutation; a certificate that prints the nickname shows
//     the nickname note alone, never both (and the client shows one line even if
//     the wire carried both flags).
//   • On the certificate just collected AND on the one held: the dialog re-POSTs
//     the mint to open a held certificate, and the answer says the same.
//
// The flags by value, the dispatcher's certificates included, are locked in
// tests/certificate-scripts.api.spec.js.
const { test, expect } = require("./isolated-test");
const { apiLogin, BASE, PARTICIPANT_PASS, gradingHashFor } = require("./helpers");
const { loginViaApi } = require("./ui-admin-helpers");
const { H, makeParticipant, makeTask, assignTask, enrol } = require("./event-admin-helpers");

test.use({ baseURL: BASE });

const SALUTATION_NOTE = "Your salutation is left off: the certificate typeface cannot print it with your name.";
const NICKNAME_NOTE = "This certificate shows your nickname, because the certificate typeface cannot draw your name. To use a different spelling, set a Certificate name in your profile.";

/** A Program with one challenge and one enrolled participant, renamed to `name`. */
async function programFor(name) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const cr = await sa.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `Notes ${Date.now().toString(36)} ${Math.random().toString(36).slice(2, 7)}`, event_kind: "program",
      start_time: new Date(Date.now() - 3600e3).toISOString(), timezone: "UTC",
      deadline_at: new Date(Date.now() + 90 * 86400e3).toISOString(),
    } });
    expect(cr.ok(), `create the Program: ${await cr.text()}`).toBeTruthy();
    const comp = (await cr.json()).competition;
    const task = await makeTask(sa, csrf, "notes", { correct_answer: "right" });
    await assignTask(sa, csrf, task.id, [comp.id]);
    const p = await makeParticipant(sa, csrf, "notes");
    const put = await sa.put(`/api/admin/participants/${p.id}`, { headers: H(csrf), data: name });
    expect(put.ok(), `rename: ${await put.text()}`).toBeTruthy();
    await enrol(sa, csrf, comp.id, [p.id]);
    return { comp, task, p };
  } finally { await sa.dispose(); }
}

/** The name notes of the open certificate dialog, read once its body has rendered. */
async function dialogNotes(page) {
  await expect(page.locator("#modal-overlay .badge-share-img")).toBeVisible({ timeout: 15000 });
  // The body is written in one go: once its fixed note is shown, so is any other.
  await expect(page.locator("#modal-overlay .badge-claim-note", { hasText: "Downloading is private" })).toBeVisible();
  const notes = page.locator("#modal-overlay .badge-name-note");
  const texts = (await notes.allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  // Where the nickname note has always been: just above the dialog's actions.
  if (texts.length) {
    expect(await notes.first().evaluate((el) => el.nextElementSibling && el.nextElementSibling.className),
      "the note sits just above the actions").toBe("badge-share-secondary");
  }
  return texts;
}

async function closeDialog(page) {
  await page.locator("#modal-cancel-btn").click();
  await expect(page.locator("#modal-overlay")).toBeHidden();
}

const CASES = [
  { what: "Dr. and an Arabic name", name: { personalTitle: "Dr.", firstName: "محمد", lastName: "علي" }, notes: [SALUTATION_NOTE] },
  { what: "Dr. Jane Doe", name: { personalTitle: "Dr.", firstName: "Jane", lastName: "Doe" }, notes: [] },
  { what: "an Arabic name with no salutation", name: { personalTitle: "", firstName: "محمد", lastName: "علي" }, notes: [] },
  // No shipped face draws Georgian, with or without the salutation: the nickname.
  { what: "Dr. and a Georgian name (the nickname is printed)", name: { personalTitle: "Dr.", firstName: "გიორგი", lastName: "ბერიძე" }, notes: [NICKNAME_NOTE], bothOnTheWire: true },
];

for (const c of CASES) {
  test(`the certificate dialog's name note: ${c.what}`, async ({ page }) => {
    test.setTimeout(90_000);
    const { comp, task, p } = await programFor(c.name);
    await loginViaApi(page, p.email, PARTICIPANT_PASS);
    const csrf = (await (await page.request.get("/api/csrf-token")).json()).csrfToken;
    expect((await page.request.post("/api/select-competition", { headers: H(csrf), data: { competitionId: comp.id } })).ok()).toBeTruthy();
    const sub = await page.request.post(`/api/tasks/${task.id}/submit`, {
      headers: { ...H(csrf), "x-competition-id": comp.id }, data: { answer: "right", gradingHash: await gradingHashFor(page.request, task.id) },
    });
    expect((await sub.json()).correct, "PRECONDITION: the challenge was solved").toBe(true);

    await page.goto("/");
    const cta = page.locator('#cert-cta [data-action="open-badge-share"]');
    await expect(cta, "the completed Program offers its certificate").toHaveText("Get my certificate", { timeout: 20000 });
    await cta.click();
    expect(await dialogNotes(page), `${c.what}: the certificate just collected`).toEqual(c.notes);
    await closeDialog(page);

    // The held certificate: the page offers it again and the dialog re-opens it.
    await page.reload();
    await expect(cta, "the certificate is held now").toHaveText("View certificate", { timeout: 20000 });
    await cta.click();
    expect(await dialogNotes(page), `${c.what}: the certificate held`).toEqual(c.notes);
    await closeDialog(page);

    if (c.bothOnTheWire) {
      // The client's own half of "never both": an answer carrying both flags
      // still gets one line, the nickname note.
      const sent = [];
      await page.route(`**/api/competitions/${comp.id}/badge`, async (route) => {
        const res = await route.fetch();
        const d = await res.json();
        sent.push(d.name_fallback);
        await route.fulfill({ response: res, json: { ...d, salutation_dropped: true } });
      });
      await cta.click();
      expect(await dialogNotes(page), "one line, never two").toEqual([NICKNAME_NOTE]);
      expect(sent, "PRECONDITION: the server's own answer carried the nickname flag").toEqual([true]);
      await closeDialog(page);
      await page.unroute(`**/api/competitions/${comp.id}/badge`);
    }
  });
}
