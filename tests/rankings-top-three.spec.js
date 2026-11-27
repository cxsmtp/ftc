// @ts-check
//
// THE TOP THREE AND THE PARTICIPANT PODIUM.
//
// Admin (public/js/features/rankings-admin.js): an event's Rankings section shows
// its 1st, 2nd and 3rd place with a certificate preview and a download. A row that
// holds an ISSUED certificate downloads that PDF (its credential code); any other
// row downloads a design preview PNG, named after the printed name in any script
// as the issued downloads are. Once the event has ended, a failed read of
// the issued certificates refuses rather than hand out a preview in place of a
// certificate that may exist.
//
// Participant (public/js/features/leaderboard.js): the podium's certificate chips
// (final board only, a positive score only), the empty podium, the viewer's own
// podium card, the one-poll rank-up cue, and the board's time words.
//
// The boards and the certificate reads are intercepted: what is under test is
// what the client does with each answer, including the failed one.

const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, registerPost, codeLogin, BASE, PARTICIPANT_PASS } = require("./helpers");
const { adminLogin, clickTab } = require("./ui-admin-helpers");
const crypto = require("crypto");

test.use({ baseURL: BASE, viewport: { width: 1280, height: 900 } });

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const uniq = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
// A 1x1 PNG: the preview route's answer, decoded as an image by the panel.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);

const row = (o) => ({
  userId: o.id, nickname: o.nick, avatar: "default1", score: o.score, finishTime: null, solveTimeMs: o.ms ?? 1000,
  allSolved: false, rank: o.rank ?? null, firstName: o.first || "", lastName: o.last || "", company: "Co", email: `${o.nick}@x.test`,
  // The name the row's certificate prints, as the server's rule gives it (lib/badge.js certificatePrintedName).
  certificatePrintedName: o.printed || "",
  incorrectCount: 0, pointsLostIncorrect: 0, hintCount: 0, pointsLostHints: 0, pointsLostTotal: 0,
  ...(o.benchmark ? { isBenchmark: true } : {}), ...(o.late ? { isLateEntrant: true } : {}),
});
const BOARD = [
  row({ id: "u1", nick: "first-n", first: "Ada", last: "One", printed: "Ada One", rank: 1, score: 300 }),
  row({ id: "u2", nick: "second-n", first: "Bo", last: "Two", printed: "Bo Two", rank: 2, score: 200 }),
  row({ id: "u3", nick: "third-n", first: "Cy", last: "Three", printed: "Cy Three", rank: 3, score: 100 }),
  row({ id: "u4", nick: "fourth-n", first: "Di", last: "Four", printed: "Di Four", rank: 4, score: 50 }),
  row({ id: "bm", nick: "bench-n", first: "Ben", last: "Mark", printed: "Ben Mark", score: 999, benchmark: true }),
  row({ id: "lt", nick: "late-n", first: "Lea", last: "Late", printed: "Lea Late", rank: 1, score: 400, late: true }),
];

async function mkEvent(prefix, { ended }) {
  const { api, csrf } = await apiLogin("superadmin");
  try {
    const name = `${prefix} ${uniq()}`;
    const start = ended ? Date.now() - 3 * 3600_000 : Date.now() - 60_000;
    const r = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
      name, event_kind: "tournament", start_time: new Date(start).toISOString(), duration_minutes: 60 } });
    expect(r.status(), await r.text()).toBe(200);
    return { id: (await r.json()).competition.id, name };
  } finally { await api.dispose(); }
}

/** Open the event's Rankings with the board and the certificate reads intercepted. */
async function openTopThree(page, ev, state) {
  const seen = { previews: [], pdfs: [] };
  await page.route("**/api/admin/leaderboard*", (r) => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify(r.request().url().includes("groups=1") ? [] : (state.board || BOARD)) }));
  await page.route(`**/api/admin/competitions/${ev.id}/certificates`, (r) => (state.certsFail
    ? r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Boom"}' })
    : r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ certificates: state.issued || [] }) })));
  await page.route(`**/api/admin/competitions/${ev.id}/certificates/*/certificate.pdf`, (r) => {
    seen.pdfs.push(new URL(r.request().url()).pathname);
    return r.fulfill({ status: 200, contentType: "application/pdf", body: Buffer.from("%PDF-1.4\n%probe\n") });
  });
  await page.route("**/api/admin/certificate-config/preview", (r) => {
    seen.previews.push(r.request().postDataJSON());
    return r.fulfill({ status: 200, contentType: "image/png", body: PNG });
  });
  await adminLogin(page);
  await clickTab(page, "Events");
  await expect.poll(() => page.evaluate((id) => (window.S.adminCompetitionsData || []).some((c) => c.id === id), ev.id), { timeout: 20000 }).toBe(true);
  await page.evaluate(({ id, name }) => window.setAdminCompetitionScope(id, name), ev);
  await clickTab(page, "Rankings");
  await expect(page.locator("#admin-rankings-certs")).toBeVisible({ timeout: 20000 });
  return seen;
}

const certs = (page) => page.locator("#admin-rankings-certs .rk-cert");
const dlBtn = (page, rank) => page.locator(`#admin-rankings-certs [data-action="rk-cert-download"][data-rank="${rank}"]`);

test.describe("Rankings — the top three's certificates", () => {
  test("a running event: the three places, preview and a PNG of the design", async ({ page }) => {
    const ev = await mkEvent("Top3Live", { ended: false });
    const seen = await openTopThree(page, ev, { issued: [] });
    await expect(page.locator("#rk-certs-title")).toHaveText("Top three");
    await expect(certs(page)).toHaveCount(3);
    expect(await certs(page).evaluateAll((li) => li.map((x) => `${x.dataset.rank}:${x.querySelector(".rk-cert-txt b").textContent}`)))
      .toEqual(["1:Ada One", "2:Bo Two", "3:Cy Three"]);
    // A benchmark (score 999) and the late board's #1 are never a podium place.
    await expect(page.locator("#admin-rankings-certs")).not.toContainText("Ben Mark");
    await expect(page.locator("#admin-rankings-certs")).not.toContainText("Lea Late");
    await expect(page.locator("#admin-rankings-certs .rk-certs-note")).toContainText("Provisional");
    await expect(dlBtn(page, 1)).toHaveText(/PNG/);

    await page.locator('#admin-rankings-certs [data-action="rk-cert-preview"][data-rank="3"]').click();
    const img = page.locator('[data-rk-cert-img="3"]');
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute("alt", "Certificate preview for Cy Three");
    await expect.poll(() => img.evaluate((i) => i.naturalWidth), { message: "the preview decoded" }).toBeGreaterThan(0);

    const [dl] = await Promise.all([page.waitForEvent("download"), dlBtn(page, 1).click()]);
    expect(dl.suggestedFilename()).toBe(`${slug(ev.name)}-1-ada-one-certificate.png`);
    expect(seen.previews.at(-1), "the design rendered for this row and place")
      .toEqual(expect.objectContaining({ competition_id: ev.id, sample: { tier: "gold", name: "Ada One", event: ev.name, score: "300 pts" } }));
    expect(seen.pdfs, "nobody holds an issued certificate yet").toEqual([]);
  });

  test("a long printed name reaches the preview cut whole, never inside a character (CONTROL: a short name is sent as it is)", async ({ page }) => {
    // 119 letters, then an astral character (two UTF-16 units) across the
    // 120-character cut the preview route allows, which counts code points.
    const LONG = `${"a".repeat(119)}\u{1F600}b`;
    const ev = await mkEvent("Top3Long", { ended: false });
    const board = BOARD.map((r) => (r.userId === "u1" ? { ...r, certificatePrintedName: LONG } : r));
    const seen = await openTopThree(page, ev, { issued: [], board });
    await page.locator('#admin-rankings-certs [data-action="rk-cert-preview"][data-rank="1"]').click();
    await expect.poll(() => seen.previews.length, { message: "the preview was asked for" }).toBeGreaterThan(0);
    const sent = seen.previews.at(-1).sample.name;
    expect(sent.isWellFormed(), "no half character is sent").toBe(true);
    expect(sent, "the first 120 characters, the astral one whole").toBe(`${"a".repeat(119)}\u{1F600}`);
    await page.locator('#admin-rankings-certs [data-action="rk-cert-preview"][data-rank="2"]').click();
    await expect.poll(() => seen.previews.length, { message: "the control's preview was asked for" }).toBeGreaterThan(1);
    expect(seen.previews.at(-1).sample.name, "CONTROL: a short name is sent as it is").toBe("Bo Two");
  });

  test("an ended event: an issued certificate downloads its PDF, a revoked one the preview again; a failed read refuses instead of a preview", async ({ page }) => {
    const ev = await mkEvent("Top3Ended", { ended: true });
    const state = { issued: [{ userId: "u2", revoked: false }] };
    const seen = await openTopThree(page, ev, state);
    await expect(page.locator("#admin-rankings-certs .rk-certs-note")).toContainText("Final placings.");
    await expect(dlBtn(page, 2), "the issued certificate is named as such").toHaveText(/Issued PDF/);
    await expect(certs(page).nth(1)).toHaveClass(/is-issued/);
    await expect(dlBtn(page, 1), "CONTROL: a place with none issued stays a preview").toHaveText(/PNG/);

    const [pdf] = await Promise.all([page.waitForEvent("download"), dlBtn(page, 2).click()]);
    expect(pdf.suggestedFilename()).toBe("bo-two-certificate.pdf");
    expect(seen.pdfs).toEqual([`/api/admin/competitions/${ev.id}/certificates/u2/certificate.pdf`]);

    // 2nd place's certificate is revoked after the card drew. The place still
    // earns its medal by points, so the card is not redrawn: the press's own
    // read must put the button back to the design preview it now downloads.
    state.issued = [{ userId: "u2", revoked: true }];
    const pdfsBefore = seen.pdfs.length;
    const [again] = await Promise.all([page.waitForEvent("download"), dlBtn(page, 2).click()]);
    expect(again.suggestedFilename(), "a revoked certificate is not handed out").toBe(`${slug(ev.name)}-2-bo-two-certificate.png`);
    expect(seen.pdfs.length, "…and no PDF is fetched").toBe(pdfsBefore);
    await expect(dlBtn(page, 2), "the button no longer claims an issued certificate").toHaveText(/PNG/);
    await expect(dlBtn(page, 2)).not.toHaveText(/Issued PDF/);
    await expect(certs(page).nth(1)).not.toHaveClass(/is-issued/);
    await expect(dlBtn(page, 1), "CONTROL: the place that never held one is unchanged").toHaveText(/PNG/);

    // The read fails: whether 1st place holds one is unknown, so no preview goes out.
    // The toast alone does not prove that: a refusal that toasted and carried on
    // would render the preview and hand it out just after. So the button's own
    // handler (main.js "rk-cert-download") is awaited to its end, with no timed
    // wait: a preview it rendered would already be in `seen.previews`.
    state.certsFail = true;
    let downloaded = false;
    const onDl = () => { downloaded = true; };
    page.on("download", onDl);
    const before = { previews: seen.previews.length, pdfs: seen.pdfs.length };
    await page.evaluate(() => window.rkCertDownload("1"));
    await expect(page.locator("#toast-stack .toast").last()).toContainText("Could not check whether Ada One holds an issued certificate");
    expect(seen.previews.length, "no preview was rendered").toBe(before.previews);
    expect(seen.pdfs.length, "no certificate was fetched").toBe(before.pdfs);
    expect(downloaded, "nothing was handed out").toBe(false);
    page.off("download", onDl);

    // CONTROL: the read answers again, with none issued to 1st place: the preview is allowed.
    state.certsFail = false;
    const [png] = await Promise.all([page.waitForEvent("download"), dlBtn(page, 1).click()]);
    expect(png.suggestedFilename()).toBe(`${slug(ev.name)}-1-ada-one-certificate.png`);
  });

  // Each place is named, and previewed, as its certificate prints the name: the
  // server's rule on the row (operator rulings, 14 Nov 2026: a Chinese, Japanese
  // or Korean family name first; a salutation the fonts cannot draw left off),
  // never first + last composed in the browser.
  test("each place is named and previewed as its certificate prints the name", async ({ page }) => {
    const ev = await mkEvent("Top3Names", { ended: false });
    const board = [
      row({ id: "z1", nick: "zh-n", first: "伟", last: "张", printed: "张伟", rank: 1, score: 300 }),
      row({ id: "z2", nick: "ar-n", first: "محمد", last: "علي", printed: "محمد علي", rank: 2, score: 200 }),
      row({ id: "z3", nick: "dr-n", first: "Jane", last: "Doe", printed: "Dr. Jane Doe", rank: 3, score: 100 }),
    ];
    const seen = await openTopThree(page, ev, { issued: [], board });
    await expect(certs(page)).toHaveCount(3);
    expect(await certs(page).evaluateAll((li) => li.map((x) => `${x.dataset.rank}:${x.querySelector(".rk-cert-txt b").textContent}`)))
      .toEqual(["1:张伟", "2:محمد علي", "3:Dr. Jane Doe"]);
    // CONTROL: the profile's own order is nowhere on the panel.
    await expect(page.locator("#admin-rankings-certs")).not.toContainText("伟 张");

    await page.locator('#admin-rankings-certs [data-action="rk-cert-preview"][data-rank="1"]').click();
    await expect(page.locator('[data-rk-cert-img="1"]')).toHaveAttribute("alt", "Certificate preview for 张伟");
    expect(seen.previews.at(-1), "the design rendered with the printed name")
      .toEqual(expect.objectContaining({ competition_id: ev.id, sample: expect.objectContaining({ tier: "gold", name: "张伟" }) }));
    await page.locator('#admin-rankings-certs [data-action="rk-cert-preview"][data-rank="3"]').click();
    await expect(page.locator('[data-rk-cert-img="3"]')).toHaveAttribute("alt", "Certificate preview for Dr. Jane Doe");
    expect(seen.previews.at(-1).sample.name, "a salutation the fonts draw is part of the printed name").toBe("Dr. Jane Doe");
  });

  // A place's preview PNG names its holder as the issued downloads do, by the one
  // rule (ui/download.js fileNameSlug; operator ruling, 14 Nov 2026): letters of
  // any script stay, so 张伟's preview is saved under 张伟 (an ASCII-only slug
  // keeps nothing of it and names the file "finisher"). CONTROLS: an ASCII name
  // is named exactly as the ASCII slug (`slug` above) names it, its 30-character
  // cut included; an accented name keeps its accents; a name with no letter or
  // digit is named by the fallback word "finisher", as the ASCII slug named it.
  // The event part stays the event name's ASCII slug.
  test("each place's preview PNG is named after the printed name, in any script", async ({ page }) => {
    const ev = await mkEvent("Top3Files", { ended: false });
    const LONG = "Dr. Alexandria Konstantinopoulou";
    const board = [
      row({ id: "f1", nick: "zh-f", first: "伟", last: "张", printed: "张伟", rank: 1, score: 300 }),
      row({ id: "f2", nick: "es-f", first: "José", last: "García", printed: "José García", rank: 2, score: 200 }),
      row({ id: "f3", nick: "en-f", first: "Alexandria", last: "Konstantinopoulou", printed: LONG, rank: 3, score: 100 }),
    ];
    const state = { issued: [], board };
    const seen = await openTopThree(page, ev, state);
    await expect(certs(page)).toHaveCount(3);
    const saved = async (rank) => {
      const [dl] = await Promise.all([page.waitForEvent("download"), dlBtn(page, rank).click()]);
      return { file: dl.suggestedFilename(), name: seen.previews.at(-1).sample.name };
    };

    // CONTROL first: the ASCII slug's own file name, cut and all.
    expect(slug(LONG), "PRECONDITION: the name runs past the 30-character cut").toBe("dr-alexandria-konstantinopoulo");
    expect(await saved(3), "an ASCII name's file is named as it always was")
      .toEqual({ file: `${slug(ev.name)}-3-${slug(LONG)}-certificate.png`, name: LONG });
    expect(await saved(1), "a Chinese name is in its preview's file name")
      .toEqual({ file: `${slug(ev.name)}-1-张伟-certificate.png`, name: "张伟" });
    expect(await saved(2), "an accented name keeps its accents")
      .toEqual({ file: `${slug(ev.name)}-2-josé-garcía-certificate.png`, name: "José García" });

    // A certificate prints the nickname when no face draws the profile name
    // (Georgian), and a nickname may be any printable ASCII: "!!!" leaves the
    // slug nothing, so the file takes the fallback word.
    state.board = [board[0], board[1], row({ id: "f4", nick: "!!!", first: "გიორგი", last: "ბერიძე", printed: "!!!", rank: 3, score: 100 })];
    await page.evaluate(() => window.loadAdminLeaderboard());
    await expect(page.locator('#admin-rankings-certs .rk-cert[data-rank="3"] .rk-cert-txt b'), "PRECONDITION: 3rd place prints the nickname")
      .toHaveText("!!!");
    expect(await saved(3), "a name with no letter or digit is named by the fallback word")
      .toEqual({ file: `${slug(ev.name)}-3-finisher-certificate.png`, name: "!!!" });
    expect(seen.pdfs, "every file is a design preview: nobody holds an issued certificate").toEqual([]);
  });

  // A place that holds an ISSUED certificate is named, and previewed, as that
  // certificate prints the name (the organisers' list `name`): one frozen with
  // the nickname keeps printing it (operator ruling, 14 Nov 2026), whatever a
  // certificate issued now would print.
  test("an issued place is named and previewed as its issued certificate prints the name", async ({ page }) => {
    const ev = await mkEvent("Top3Issued", { ended: true });
    const state = { issued: [{ userId: "u2", revoked: false, tier: "silver", basis: "placement", name: "second-n" }] };
    const seen = await openTopThree(page, ev, state);
    const shown = (rank) => page.locator(`#admin-rankings-certs .rk-cert[data-rank="${rank}"] .rk-cert-txt b`);
    await expect(dlBtn(page, 2), "PRECONDITION: the read found the issued certificate").toHaveText(/Issued PDF/);
    await expect(shown(2), "named as its issued certificate prints the name").toHaveText("second-n");
    await expect(shown(1), "CONTROL: a place with none issued is named as one issued now would print it").toHaveText("Ada One");

    await page.locator('#admin-rankings-certs [data-action="rk-cert-preview"][data-rank="2"]').click();
    await expect(page.locator('[data-rk-cert-img="2"]')).toHaveAttribute("alt", "Certificate preview for second-n");
    expect(seen.previews.at(-1).sample.name, "the design is previewed with that name").toBe("second-n");
    const [pdf] = await Promise.all([page.waitForEvent("download"), dlBtn(page, 2).click()]);
    expect(pdf.suggestedFilename(), "and the issued PDF saved under it").toBe("second-n-certificate.pdf");

    // Whatever name the certificate prints, its file keeps the issued downloads'
    // 40-character cut and their fallback word for a name with no letter or
    // digit (a nickname may be any printable ASCII). The click re-reads the
    // issued list, so each answer is the name at that click.
    for (const [name, file] of [["Dr. Alexandria Konstantinopoulou-Papadopoulou", "dr-alexandria-konstantinopoulou-papadopo"], ["!!!", "certificate"]]) {
      state.issued = [{ ...state.issued[0], name }];
      const [got] = await Promise.all([page.waitForEvent("download"), dlBtn(page, 2).click()]);
      expect(got.suggestedFilename(), `a certificate that prints "${name}"`).toBe(`${file}-certificate.pdf`);
      await expect(shown(2), "the click's re-read named the place").toHaveText(name);
    }
  });

  // OPERATOR RULING, 14 Nov 2026: a Gold, Silver or Bronze already issued to a
  // top-three place on zero points or fewer keeps its medal. The card lists such
  // a place with its issued certificate, and its note names only the places that
  // hold no medal (a place on zero issued participation, as the rule now issues).
  test("a place on zero points that holds an issued medal is listed with it; the note names only the rest", async ({ page }) => {
    const ev = await mkEvent("Top3Kept", { ended: true });
    const state = {
      board: [
        row({ id: "k1", nick: "k1-n", first: "Ada", last: "One", printed: "Ada One", rank: 1, score: 300 }),
        row({ id: "k2", nick: "k2-n", first: "Bo", last: "Two", printed: "Bo Two", rank: 2, score: 0 }),
        row({ id: "k3", nick: "k3-n", first: "Cy", last: "Three", printed: "Cy Three", rank: 3, score: 0 }),
      ],
      issued: [
        { userId: "k2", revoked: false, tier: "silver", basis: "placement", name: "Bo Two" },
        { userId: "k3", revoked: false, tier: "participation", basis: "participation", name: "Cy Three" },
      ],
    };
    await openTopThree(page, ev, state);
    const note = page.locator("#admin-rankings-certs .rk-certs-zero");
    await expect(dlBtn(page, 2), "the kept Silver is listed, with its issued certificate").toHaveText(/Issued PDF/);
    expect(await certs(page).evaluateAll((li) => li.map((x) => x.dataset.rank)), "the medal places").toEqual(["1", "2"]);
    await expect(note, "the note names only the place that holds no medal").toHaveText(/^No medal certificate for 3rd place:/);

    // CONTROL: the read answers the Silver no longer issued (revoked meanwhile):
    // that place is back in the note, with no medal to download.
    state.issued = state.issued.map((c) => (c.userId === "k2" ? { ...c, revoked: true } : c));
    await Promise.all([page.waitForEvent("download"), page.evaluate(() => window.rkCertDownload("1"))]);
    await expect(note).toHaveText(/^No medal certificate for 2nd and 3rd place:/);
    await expect(certs(page)).toHaveCount(1);
    await expect(dlBtn(page, 2)).toHaveCount(0);
  });
});

// ─── The participant's board ──────────────────────────────────────────────────

async function mkParticipantInLiveEvent() {
  const label = `t3p${uniq()}`.slice(0, 18), email = `${label}@company.example`;
  const { api: reg, csrf: rc } = await freshCtx();
  try {
    const r = await registerPost(reg, "/api/register", { headers: H(rc), data: {
      firstName: "Pod", lastName: "Ium", nickname: label, email, company: "Acme", title: "Eng",
      country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS, jobFunction: "Software Developer / Engineer", city: "X" } });
    expect(r.ok(), `register: ${await r.text()}`).toBeTruthy();
  } finally { await reg.dispose(); }
  const { api, csrf } = await apiLogin("superadmin");
  try {
    const list = await (await api.get("/api/admin/participants?limit=5000")).json();
    const u = (list.participants || list.users || []).find((x) => x.email === email);
    expect(u, "the participant is findable").toBeTruthy();
    for (const ep of ["verify", "approve"]) expect((await api.post(`/api/admin/participants/${u.id}/${ep}`, { headers: H(csrf) })).ok()).toBeTruthy();
    const c = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `Podium ${uniq()}`, event_kind: "tournament", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 600 } });
    expect(c.ok(), await c.text()).toBeTruthy();
    const compId = (await c.json()).competition.id;
    // Two challenges: the board is intercepted, but the event must be enterable
    // and must not auto-end under the test.
    for (const t of ["A", "B"]) {
      const tr = await api.post("/api/admin/tasks", { headers: H(csrf), data: {
        title: `Podium ${t} ${uniq()}`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "x", status: "published" } });
      expect(tr.ok(), await tr.text()).toBeTruthy();
      const ar = await api.post(`/api/admin/tasks/${(await tr.json()).id}/competitions`, { headers: H(csrf), data: { competitionIds: [compId] } });
      expect(ar.ok(), `assign challenge ${t}: ${ar.status()} ${await ar.text()}`).toBeTruthy();
      expect((await ar.json()).assigned, `challenge ${t} is on the event`).toBe(1);
    }
    const as = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [u.id], competitionIds: [compId] } });
    expect((await as.json()).assigned, "the participant is enrolled").toBe(1);
    return { email, compId };
  } finally { await api.dispose(); }
}

const lbRow = (o) => ({ userId: o.id, nickname: o.nick, avatar: "default1", score: o.score, solveTimeMs: o.ms, allSolved: false, rank: o.rank });

test.describe("the participant's podium and board", () => {
  test("certificate chips only on a final board, the empty podium, the own card, the one-poll rank-up and the time words", async ({ page }) => {
    const f = await mkParticipantInLiveEvent();
    const rows = (order, ms = {}) => order.map((id, i) => lbRow({ id, nick: `nick-${id}`, rank: i + 1, score: 700 - i * 100, ms: ms[id] }));
    const TIMES = { A: 500, B: 3000, C: 250_000, D: 3_753_000, E: null, F: 61_000, G: 120_000 };
    const pay = (board, extra = {}) => ({ top3: board.slice(0, 3), board, me: board.find((r) => r.userId === "A") || null,
      groupBoard: null, board_limit: 20, ended: false, canShareBadge: false, lateBoard: null,
      placementCertificates: true, ...extra });   // as the route sends for an event that is not a dry run
    let current = pay(rows(["A", "B", "C", "D", "E", "F", "G"], TIMES));
    await page.route("**/api/leaderboard*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(current) }));

    const { csrfToken } = await (await page.request.get("/api/csrf-token")).json();
    expect((await codeLogin(page.request, f.email, H(csrfToken), { password: PARTICIPANT_PASS })).ok()).toBeTruthy();
    await page.goto("/");
    const inside = page.locator("#nav-leaderboard:not([aria-disabled=true])");
    const card = page.locator(`#comp-grid [data-comp-id="${f.compId}"] .card-open`).first();
    await expect.poll(async () => (await inside.isVisible().catch(() => false)) || (await card.isVisible().catch(() => false)), { timeout: 30000 }).toBe(true);
    if (!(await inside.isVisible().catch(() => false))) {
      await card.click();
      const ok = page.locator("#modal-confirm-btn");
      if (await ok.isVisible().catch(() => false)) await ok.click();
    }
    await inside.click({ timeout: 20000 });
    const slot = (n) => page.locator(`#podium-row .podium-slot.ps${n}`);
    await expect(slot(1)).toBeVisible({ timeout: 20000 });
    const render = async (p) => { current = p; await page.evaluate(() => window.loadLeaderboard({ silent: true })); };

    // A RUNNING board: no certificate chip, the viewer's own card marked, times in words.
    await expect(page.locator("#podium-row .podium-cert"), "no certificate is named before the end").toHaveCount(0);
    await expect(slot(1)).toHaveClass(/is-me/);
    await expect(slot(2), "CONTROL: another place is not marked as the viewer's").not.toHaveClass(/is-me/);
    await expect(page.locator("#podium-row")).not.toHaveClass(/podium-empty/);
    const timeOf = (id) => page.locator(`#lb-body tr[data-uid="${id}"] .lb-time-cell`).textContent();
    expect(await timeOf("A")).toBe("under 1 s");
    expect(await timeOf("B")).toBe("0 m 03 s");
    expect(await timeOf("C")).toBe("4 m 10 s");
    expect(await timeOf("D")).toBe("1 h 02 m 33 s");
    expect(await timeOf("E"), "no clock yet is a dash, not 0").toBe("—");
    await expect(page.locator("#lb-body .lb-delta"), "a first render has nothing to compare with").toHaveCount(0);
    // The table under the podium starts at rank 4: the three on the podium are not repeated.
    expect(await page.locator("#lb-body tr:not([hidden])").evaluateAll((trs) => trs.map((t) => t.dataset.uid)),
      "the table below the podium starts at rank 4").toEqual(["D", "E", "F", "G"]);

    // G climbs from 7th to 4th between two polls: its row says by how much.
    await render(pay(rows(["A", "B", "C", "G", "D", "E", "F"], TIMES)));
    const delta = page.locator('#lb-body tr[data-uid="G"] .lb-delta');
    await expect(delta).toHaveText("3 places up");
    await expect(page.locator('#lb-body tr[data-uid="D"] .lb-delta'), "CONTROL: a row that fell says nothing").toHaveCount(0);
    await expect(page.locator("#lb-body .lb-delta"), "only the climber").toHaveCount(1);
    // The next poll, with nothing moved, forgets it.
    await render(pay(rows(["A", "B", "C", "G", "D", "E", "F"], TIMES)));
    await expect(page.locator("#lb-body .lb-delta")).toHaveCount(0);

    // A FINAL board names each place's certificate tier — for a positive score only.
    const final = rows(["A", "B", "C", "G", "D", "E", "F"], TIMES);
    await render(pay(final, { ended: true }));
    await expect(slot(1).locator(".podium-cert")).toHaveText("Gold certificate");
    await expect(slot(2).locator(".podium-cert")).toHaveText("Silver certificate");
    await expect(slot(3).locator(".podium-cert")).toHaveText("Bronze certificate");
    const zero = final.map((r) => (r.userId === "C" ? { ...r, score: 0 } : r));
    await render(pay(zero, { ended: true }));
    await expect(slot(3).locator(".podium-cert"), "no certificate for a podium place that scored nothing").toHaveCount(0);
    await expect(slot(1).locator(".podium-cert"), "CONTROL: the others keep theirs").toHaveText("Gold certificate");

    // An empty board: the podium says it is empty, rather than three blank cards.
    await render(pay([], { ended: true }));
    await expect(page.locator("#podium-row")).toHaveClass(/podium-empty/);
    await expect(page.locator("#podium-row .podium-slot")).toHaveCount(0);
  });
});
