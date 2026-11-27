// @ts-check
//
// THE CERTIFICATE PRINTS NAMES IN THE SCRIPTS INTER LACKS (operator ruling,
// 14 Nov 2026: ship a font covering the common scripts).
//
// Through the real doors: a participant named in Chinese, Arabic or Thai solves a
// Program, its end issues nothing by itself, they mint their own certificate, and
// a stranger verifies it at /credential. Before the Noto faces shipped such a
// name printed the generated nickname and froze it as the surname to type.
//
// A name the renderer cannot draw whole still prints the nickname: Latin mixed
// into Arabic ("Anna علي": resvg prints .notdef boxes for it), and Devanagari
// (resvg cannot shape it, so no face for it ships; operator ruling, 14 Nov 2026:
// revisit at the next dependency update). A SALUTATION that alone stands in the
// way is left off instead (operator ruling, 14 Nov 2026): "Dr. محمد علي" prints
// محمد علي, and the mint answer says so (`salutation_dropped`). A name in Han,
// kana or Hangul prints family name first with no space (张伟), and verifies by
// its family name or the whole name as printed, never by its given name alone.
// See lib/badge.js `certificatePrintedName`, the one rule, and `_drawPlan`.
//
// And the certificates minted BEFORE this release with the nickname: they froze
// it as the verification surname (the mint's fallback branch, `{given: "",
// family: <nickname>}`). They keep printing it (operator ruling, 14 Nov 2026),
// or a copy downloaded today would name somebody its own lookup refuses.
//
// Font coverage itself is locked by rendering in tests/badge-fonts.spec.js.
const { test, expect } = require("./isolated-test");
const { registerPost, freshCtx, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, codeLogin } = require("./helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `cs${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

// `printed` is what the certificate prints for the name.
const CHINESE = { firstName: "伟", lastName: "张", printed: "张伟" };
const JAPANESE = { firstName: "太郎", lastName: "田中", printed: "田中太郎" };
const KOREAN = { firstName: "민준", lastName: "김", printed: "김민준" };
const ARABIC = { firstName: "محمد", lastName: "علي", printed: "محمد علي" };
const THAI = { firstName: "กำพล", lastName: "จำเนียร", printed: "กำพล จำเนียร" };
const CYRILLIC = { firstName: "Иван", lastName: "Петров", printed: "Иван Петров" };
// No shipped face draws Georgian: such a certificate prints the nickname
// (asserted as a precondition where it is used).
const GEORGIAN = { firstName: "გიორგი", lastName: "ბერიძე" };

async function sa() {
  const { api, csrf: c0 } = await freshCtx();
  const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
  expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
  return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
}

/** Own participant, own nickname — never a shared seeded fixture. */
async function makeParticipant(api, csrf, label, name) {
  const email = `${label}@company.example`;
  const reg = await registerPost(api, "/api/register", {
    headers: H(csrf),
    data: {
      firstName: name.firstName, lastName: name.lastName,
      ...(name.personalTitle ? { personalTitle: name.personalTitle } : {}),
      nickname: label, email, company: "Acme", title: "Engineer", country: "US",
      timezone: "America/New_York", password: PARTICIPANT_PASS,
      jobFunction: "Software Developer / Engineer", city: "Testville",
    },
  });
  expect(reg.status(), `register ${label}: ${await reg.text()}`).toBe(200);
  const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
  const u = (list.participants || []).find(p => p.email === email);
  expect(u, `${label} findable`).toBeTruthy();
  expect((await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) })).ok()).toBeTruthy();
  expect((await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) })).ok()).toBeTruthy();
  return { id: u.id, email, nickname: label };
}

/**
 * A Program with one published challenge. A PROGRAM because its all-solved
 * auto-end is off by default, so participants solving the one challenge leave
 * the end to the test, and a completion certificate is minted while it runs.
 */
async function program(api, csrf) {
  const cr = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} program`, event_kind: "program", start_time: new Date(Date.now() - 3600e3).toISOString(), timezone: "UTC",
      deadline_at: new Date(Date.now() + 90 * 86400e3).toISOString(),
    },
  });
  expect(cr.ok(), `create program: ${await cr.text()}`).toBeTruthy();
  const comp = (await cr.json()).competition;
  const tr = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: { title: `${uniq()} T`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "right0", status: "published" },
  });
  expect(tr.ok(), await tr.text()).toBeTruthy();
  const taskId = (await tr.json()).id;
  expect((await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } })).ok()).toBeTruthy();
  return { comp, taskId };
}

/**
 * A participant of `prog`, named `name`, who solves its challenge and mints their
 * own certificate (`mint: false`: solves only, leaving the issue to the dispatcher).
 */
async function holderIn(api, csrf, prog, name, { end = false, mint: collect = true } = {}) {
  const { comp, taskId } = prog;
  const user = await makeParticipant(api, csrf, uniq(), name);
  const asg = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [user.id], competitionIds: [comp.id] } });
  expect((await asg.json()).assigned, "the participant was really enrolled").toBe(1);

  const { api: p, csrf: c0 } = await freshCtx();
  try {
    const li = await codeLogin(p, user.email, H(c0));
    expect(li.ok(), `login ${user.email}: ${await li.text()}`).toBeTruthy();
    const pc = (await (await p.get("/api/csrf-token")).json()).csrfToken;
    expect((await p.post("/api/select-competition", { headers: H(pc), data: { competitionId: comp.id } })).ok()).toBeTruthy();
    const view = await (await p.get(`/api/tasks/${taskId}`)).json();
    const sub = await p.post(`/api/tasks/${taskId}/submit`, { headers: { "x-csrf-token": pc }, multipart: { answer: "right0", gradingHash: view.grading_hash || "" } });
    expect((await sub.json()).correct, "the challenge was solved").toBe(true);
    if (end) expect((await api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf), data: {} })).ok()).toBeTruthy();
    if (!collect) return { comp, user };
    const mint = await p.post(`/api/competitions/${comp.id}/badge`, { headers: { "x-csrf-token": pc } });
    expect(mint.ok(), `mint: ${await mint.text()}`).toBeTruthy();
    const b = await mint.json();
    expect(b.publicCode, "a new mint carries a printed verification code").toBeTruthy();
    return { comp, user, mint: b, token: b.token, code: b.publicCode };
  } finally { await p.dispose(); }
}

/** A completed Program certificate, minted by its holder after the end. */
async function issued(api, csrf, name) {
  return holderIn(api, csrf, await program(api, csrf), name, { end: true });
}

/** sha256 of a public artefact (the certificate PDF the email attaches, the share card). */
const artefact = async (path) => {
  const { api: anon } = await freshCtx();
  try {
    const r = await anon.get(path);
    expect(r.status(), `${path} is served`).toBe(200);
    return require("crypto").createHash("sha256").update(await r.body()).digest("hex");
  } finally { await anon.dispose(); }
};
const pdfOf = (g) => artefact(`/badge/${g.token}/certificate.pdf`);
const cardOf = (g) => artefact(`/badge/${g.token}/badge.png`);

/** A superadmin profile edit of the holder (read live by every render). */
async function editProfile(api, csrf, userId, data) {
  const r = await api.put(`/api/admin/participants/${userId}`, { headers: H(csrf), data });
  expect(r.ok(), `edit ${JSON.stringify(data)}: ${await r.text()}`).toBeTruthy();
}

/**
 * Signed in as the holder: their sign-in answer, GET /api/me and their own
 * certificate for `compId` from GET /api/me/certificates.
 */
async function asHolder(user, compId) {
  const { api: p, csrf: c0 } = await freshCtx();
  try {
    const li = await codeLogin(p, user.email, H(c0));
    expect(li.ok(), `login ${user.email}: ${await li.text()}`).toBeTruthy();
    const me = await (await p.get("/api/me")).json();
    const list = await (await p.get("/api/me/certificates")).json();
    const held = (list.certificates || []).find(c => c.competitionId === compId);
    expect(held, `the holder's list holds the certificate: ${JSON.stringify(list)}`).toBeTruthy();
    return { signIn: await li.json(), me, held };
  } finally { await p.dispose(); }
}

/**
 * The holder opens their certificate again: the share dialog re-POSTs the mint,
 * which answers with the certificate they hold. The answer, as JSON.
 */
async function reopen(user, compId) {
  const { api: p, csrf: c0 } = await freshCtx();
  try {
    const li = await codeLogin(p, user.email, H(c0));
    expect(li.ok(), `login ${user.email}: ${await li.text()}`).toBeTruthy();
    const pc = (await (await p.get("/api/csrf-token")).json()).csrfToken;
    const r = await p.post(`/api/competitions/${compId}/badge`, { headers: { "x-csrf-token": pc } });
    expect(r.ok(), `the mint answers: ${await r.text()}`).toBeTruthy();
    return await r.json();
  } finally { await p.dispose(); }
}

/** The notes about the printed name a mint answer carries, exactly as sent. */
const notesOf = (b) => Object.fromEntries(["name_fallback", "salutation_dropped"].filter(k => k in b).map(k => [k, b[k]]));

/** The holder's row on the organisers' list (GET /api/admin/competitions/:id/certificates). */
async function listed(api, compId, userId) {
  const r = await api.get(`/api/admin/competitions/${compId}/certificates`);
  expect(r.ok(), `the organisers' list: ${r.status()}`).toBeTruthy();
  const row = ((await r.json()).certificates || []).find(c => c.userId === userId);
  expect(row, "the organisers' list holds the holder's certificate").toBeTruthy();
  return row;
}

const lookup = async (code, surname) => {
  const { api: anon } = await freshCtx();
  try {
    const r = await anon.post("/credential", { headers: { "content-type": "application/json", accept: "application/json" }, data: { code, surname } });
    return await r.json();
  } finally { await anon.dispose(); }
};

const badgeRow = (token) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare("SELECT * FROM achievement_badges WHERE token=?").get(token); } finally { db.close(); }
};

test.describe("certificates print names in Chinese, Arabic and the other added scripts", () => {
  // Cyrillic is Inter's own (the control: it printed before the Noto faces too).
  for (const [script, name, art, byInter] of [["Chinese", CHINESE, "a", false], ["Japanese", JAPANESE, "a", false], ["Korean", KOREAN, "a", false],
    ["Arabic", ARABIC, "an", false], ["Thai", THAI, "a", false], ["Cyrillic", CYRILLIC, "a", true]]) {
    test(`${art} ${script} name is printed and verifies by its own family name, not the nickname`, async () => {
      const { canRenderText, certificateName } = require("../lib/badge.js");
      expect(canRenderText(certificateName(name), { fallbackFaces: false }),
        `PRECONDITION: Inter ${byInter ? "draws" : "alone cannot draw"} the ${script} name`).toBe(byInter);
      const { api, csrf } = await sa();
      try {
        const g = await issued(api, csrf, name);
        expect(g.mint.name_fallback, "the mint does not report a nickname substitution").toBeUndefined();
        const row = badgeRow(g.token);
        // A Chinese, Japanese or Korean name is printed family name first, with
        // no space (operator ruling, 14 Nov 2026); every other one given name first.
        expect(row.name_snapshot, "the certificate printed the name").toBe(name.printed);
        expect(JSON.parse(row.name_match_snapshot), "and froze the name's own parts for the lookup")
          .toEqual({ given: name.firstName, family: name.lastName });
        const ok = await lookup(g.code, name.lastName);
        expect(ok.found, "a verifier typing the printed family name finds it").toBe(true);
        expect(ok.name, "the page names the holder as the paper does").toBe(name.printed);
        expect(ok.nameChanged, "and claims no change").toBeFalsy();
        // CONTROL: the nickname is not a key for a name the certificate prints.
        expect((await lookup(g.code, g.user.nickname)).found, "the nickname does not verify it").toBe(false);
        // The holder's own surfaces name them as the certificate does: the
        // sign-in answer and GET /api/me (what a certificate would print), and
        // the held certificate in their list.
        const h = await asHolder(g.user, g.comp.id);
        expect(h.signIn.certificate_printed_name, "the sign-in answer").toBe(name.printed);
        expect(h.me.certificate_printed_name, "GET /api/me").toBe(name.printed);
        expect(h.held.name, "the held certificate").toBe(name.printed);
        // And the organisers' list names the holder as the certificate does,
        // beside the profile's own parts (which, composed, would not).
        const l = await listed(api, g.comp.id, g.user.id);
        expect(l.name, "the organisers' list").toBe(name.printed);
        expect([l.firstName, l.lastName], "the profile's parts are still listed as they are").toEqual([name.firstName, name.lastName]);
      } finally { await api.dispose(); }
    });
  }

  // A name the renderer cannot draw whole: the certificate names nobody, or
  // misspells them, so the nickname prints and is what verifies (v8.1.1's
  // freeze). Only a salutation is ever left off to make a name drawable (below),
  // never another part: Latin in the name itself keeps the nickname. Devanagari
  // keeps it too (operator ruling, 14 Nov 2026: until a renderer that shapes it).
  for (const [what, name] of [["Latin in an Arabic name", { firstName: "Anna", lastName: "علي" }],
    ["a Devanagari name", { personalTitle: "Dr.", firstName: "राहुल", lastName: "शर्मा" }]]) {
    test(`${what} keeps the nickname, which is what verifies it`, async () => {
      const { canRenderText, certificateName } = require("../lib/badge.js");
      expect(canRenderText(certificateName(name)), `PRECONDITION: the renderer cannot draw "${certificateName(name)}" whole`).toBe(false);
      expect(canRenderText(certificateName({ ...name, personalTitle: "" })), "PRECONDITION: nor without a salutation").toBe(false);
      const { api, csrf } = await sa();
      try {
        const g = await issued(api, csrf, name);
        expect(g.mint.name_fallback, "the mint says the nickname is printed").toBe(true);
        const row = badgeRow(g.token);
        expect(row.name_snapshot, "the certificate printed the nickname").toBe(g.user.nickname);
        expect(JSON.parse(row.name_match_snapshot), "and froze it as the surname to type")
          .toEqual({ given: "", family: g.user.nickname });
        const ok = await lookup(g.code, g.user.nickname);
        expect(ok.found, "the printed nickname verifies it").toBe(true);
        expect(ok.name, "and is the name the page shows").toBe(g.user.nickname);
        expect((await lookup(g.code, name.lastName)).found, "a family name it never printed is not a key").toBe(false);
        expect((await listed(api, g.comp.id, g.user.id)).name, "the organisers' list names the holder by the nickname printed")
          .toBe(g.user.nickname);
      } finally { await api.dispose(); }
    });
  }

  // OPERATOR RULING, 14 Nov 2026: a salutation that alone stops the name being
  // drawn is left off. Locked by rendering, every artefact: the share card of
  // "Dr. محمد علي" is byte for byte the share card of a holder named محمد علي, in
  // the same Program on the same date, and unlike the nickname's; neither it nor
  // the PDF (what the email attaches) moves when the salutation is cleared, as a
  // Latin holder's card does.
  test("a salutation that alone stops an Arabic name being drawn is left off: every artefact prints the name", async () => {
    test.setTimeout(120_000);
    const { canRenderText, certificateName } = require("../lib/badge.js");
    const DR_ARABIC = { personalTitle: "Dr.", ...ARABIC };
    expect(canRenderText(certificateName(DR_ARABIC)), "PRECONDITION: the renderer cannot draw it with its salutation").toBe(false);
    const { api, csrf } = await sa();
    try {
      const prog = await program(api, csrf);
      const a = await holderIn(api, csrf, prog, DR_ARABIC);                                  // Dr. محمد علي
      const b = await holderIn(api, csrf, prog, ARABIC);                                     // محمد علي
      const c = await holderIn(api, csrf, prog, { firstName: "Anna", lastName: "علي" });     // the nickname
      const d = await holderIn(api, csrf, prog, { personalTitle: "Dr.", firstName: "Jane", lastName: `Doe${uniq()}` });

      expect(a.mint.name_fallback, "no nickname substitution").toBeUndefined();
      const row = badgeRow(a.token);
      expect(row.name_snapshot, "the certificate printed the name, without the salutation").toBe("محمد علي");
      expect(JSON.parse(row.name_match_snapshot), "the lookup's parts are the name's own: a salutation never was one")
        .toEqual({ given: "محمد", family: "علي" });
      const ok = await lookup(a.code, "علي");
      expect(ok.found, "the printed family name verifies it").toBe(true);
      expect(ok.name, "the page names the holder as the paper does").toBe("محمد علي");
      expect(ok.nameChanged, "and claims no change").toBeFalsy();
      expect((await lookup(a.code, a.user.nickname)).found, "the nickname is not a key").toBe(false);
      const h = await asHolder(a.user, prog.comp.id);
      expect(h.signIn.certificate_printed_name, "the sign-in answer").toBe("محمد علي");
      expect(h.me.certificate_printed_name, "GET /api/me").toBe("محمد علي");
      expect(h.held.name, "the held certificate").toBe("محمد علي");
      // PRECONDITIONS of the comparisons: the nickname holder printed the
      // nickname, the Latin holder their salutation.
      expect(c.mint.name_fallback).toBe(true);
      expect(badgeRow(c.token).name_snapshot).toBe(c.user.nickname);
      expect(badgeRow(d.token).name_snapshot).toMatch(/^Dr\. Jane Doe/);

      // The three share cards may differ only by the name: one date for all
      // (each froze its own completion day, which a UTC midnight could split).
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH);
      try {
        const r = db.prepare("UPDATE achievement_badges SET date_snapshot=? WHERE token IN (?,?,?)")
          .run("2026-11-14T12:00:00.000Z", a.token, b.token, c.token);
        expect(r.changes, "one date for the three").toBe(3);
      } finally { db.close(); }
      const cardA = await cardOf(a);
      expect(await cardOf(a), "the share card renders byte-identically twice").toBe(cardA);
      expect(cardA, "it is the share card of محمد علي").toBe(await cardOf(b));
      expect(cardA, "and not the nickname's").not.toBe(await cardOf(c));

      const pdfA = await pdfOf(a);
      expect(await pdfOf(a), "the certificate PDF renders byte-identically twice").toBe(pdfA);
      await editProfile(api, csrf, a.user.id, { personalTitle: "" });
      expect(await pdfOf(a), "clearing the salutation moves nothing: it was not printed").toBe(pdfA);
      expect(await cardOf(a), "on the share card either").toBe(cardA);
      // CONTROL: a salutation the fonts draw is printed, so clearing it does move
      // the artwork (the share card: the PDF's title names the holder too, so it
      // would move whatever the artwork did).
      const cardD = await cardOf(d);
      await editProfile(api, csrf, d.user.id, { personalTitle: "" });
      expect(await cardOf(d), "the Latin holder's salutation was printed").not.toBe(cardD);
    } finally { await api.dispose(); }
  });

  // OPERATOR RULING, 14 Nov 2026: when the certificate leaves the salutation off,
  // the mint answer says so (`salutation_dropped: true`, absent otherwise) and
  // the share dialog shows one line; never beside `name_fallback`, as a nickname
  // has no salutation to leave off. The flags are what the artwork prints
  // (routes/badge.js `_badgePayload`, by `_heldName`) for a certificate already
  // held too: the dialog re-POSTs the mint to open one, and the dispatcher issues
  // most of them, so the holder's FIRST answer is often a held certificate.
  test("the mint answer says when the salutation is left off, for a new certificate and a held one alike", async () => {
    test.setTimeout(150_000);
    const { canRenderText, certificateName } = require("../lib/badge.js");
    const DR_ARABIC = { personalTitle: "Dr.", ...ARABIC };
    const DR_GEORGIAN = { personalTitle: "Dr.", ...GEORGIAN };
    expect(canRenderText(certificateName(DR_ARABIC)), "PRECONDITION: the salutation stops the Arabic name being drawn").toBe(false);
    expect(canRenderText(certificateName(ARABIC)), "PRECONDITION: the name alone is drawn").toBe(true);
    expect(canRenderText(certificateName({ ...GEORGIAN })), "PRECONDITION: no face draws the Georgian name").toBe(false);
    const { api, csrf } = await sa();
    try {
      const prog = await program(api, csrf);
      for (const [what, name, printed, want] of [
        ["Dr. and an Arabic name", DR_ARABIC, ARABIC.printed, { salutation_dropped: true }],
        // CONTROLS: a salutation the fonts draw is printed; an Arabic name with
        // none has nothing to leave off; a nickname certificate says only that.
        ["Dr. Jane Doe", { personalTitle: "Dr.", firstName: "Jane", lastName: "Doe" }, "Dr. Jane Doe", {}],
        ["an Arabic name with no salutation", ARABIC, ARABIC.printed, {}],
        ["Dr. and a Georgian name", DR_GEORGIAN, null, { name_fallback: true }],
      ]) {
        const g = await holderIn(api, csrf, prog, name);
        expect(badgeRow(g.token).name_snapshot, `PRECONDITION: ${what}: what the certificate prints`).toBe(printed || g.user.nickname);
        expect(notesOf(g.mint), `${what}: the new certificate's answer`).toEqual(want);
        const again = await reopen(g.user, prog.comp.id);
        expect(again.token, `${what}: the held certificate comes back`).toBe(g.token);
        expect(notesOf(again), `${what}: the held certificate's answer says the same`).toEqual(want);
      }

      // Issued by the dispatcher: the holder's first answer is a held certificate.
      // In an event of its own, ticked alone (`competitionId`): the shared relay
      // fails every send, so an unscoped forced pass would also render and re-send
      // every certificate this file's other events queued, past the request's 20 s
      // on a loaded runner. A DECOY's failed send, still due a retry, shows the
      // narrowing holds for retries as well as jobs.
      const Database = require("better-sqlite3");
      const readDb = (fn) => { const db = new Database(TEST_DB_PATH, { readonly: true }); try { return fn(db); } finally { db.close(); } };
      const tickOnly = async (p) => {
        const r = await api.post("/api/test/certificate-dispatch-tick", { headers: H(csrf), data: { force: true, competitionId: p.comp.id } });
        expect(r.ok(), `tick: ${await r.text()}`).toBeTruthy();
        return r.json();
      };
      const decoy = await program(api, csrf);
      await holderIn(api, csrf, decoy, ARABIC, { mint: false });
      expect((await tickOnly(decoy)).failed, "PRECONDITION: the decoy's send failed, so a forced pass would retry it").toBeGreaterThan(0);
      const solo = await program(api, csrf);
      const auto = await holderIn(api, csrf, solo, DR_ARABIC, { mint: false });
      const queuedElsewhere = () => readDb(db => db.prepare("SELECT COUNT(*) AS n FROM certificate_dispatch_jobs WHERE competition_id <> ?").get(solo.comp.id).n);
      const before = queuedElsewhere();
      expect(before, "the decoy's own pass left the other events' jobs queued").toBeGreaterThan(0);
      const tick = await tickOnly(solo);
      expect({ jobs: tick.jobs, retried: tick.retried }, "the pass ran this event's one job and retried only its own send").toEqual({ jobs: 1, retried: 1 });
      expect(queuedElsewhere(), "and left every other event's job queued").toBe(before);
      const issuedRow = readDb(db => db.prepare("SELECT token, name_snapshot FROM achievement_badges WHERE user_id=? AND competition_id=?").get(auto.user.id, solo.comp.id));
      expect(issuedRow && issuedRow.name_snapshot, "PRECONDITION: the dispatcher issued it, without the salutation").toBe(ARABIC.printed);
      const first = await reopen(auto.user, solo.comp.id);
      expect(first.token, "the holder's first answer is the certificate they already hold").toBe(issuedRow.token);
      expect(notesOf(first), "and it says the salutation is left off").toEqual({ salutation_dropped: true });
    } finally { await api.dispose(); }
  });

  // The account's own printed name (the sign-in answer and GET /api/me: what the
  // Leaderboard card shows before a certificate is held) takes every input the
  // certificate's rule takes: a salutation the fonts draw is printed, and a
  // certificate-name override wins over the profile name, family name first for
  // a Japanese one. The held certificate and the organisers' list say the same.
  test("the account's printed name keeps a salutation the fonts draw and follows the certificate-name override", async () => {
    test.setTimeout(120_000);
    const { api, csrf } = await sa();
    try {
      const prog = await program(api, csrf);
      const doe = `Doe${uniq()}`, roe = `Roe${uniq()}`;
      const dr = await holderIn(api, csrf, prog, { personalTitle: "Dr.", firstName: "Jane", lastName: doe });
      const ov = await holderIn(api, csrf, prog, { firstName: "Jane", lastName: roe });
      expect(badgeRow(dr.token).name_snapshot, "PRECONDITION: the certificate printed the salutation").toBe(`Dr. Jane ${doe}`);
      expect(badgeRow(ov.token).name_snapshot, "PRECONDITION: and this one the profile name").toBe(`Jane ${roe}`);
      await editProfile(api, csrf, ov.user.id, { certificateGivenName: JAPANESE.firstName, certificateFamilyName: JAPANESE.lastName });
      for (const [g, want] of [[dr, `Dr. Jane ${doe}`], [ov, JAPANESE.printed]]) {
        const h = await asHolder(g.user, prog.comp.id);
        expect(h.signIn.certificate_printed_name, `${want}: the sign-in answer`).toBe(want);
        expect(h.me.certificate_printed_name, `${want}: GET /api/me`).toBe(want);
        expect(h.held.name, `${want}: the held certificate`).toBe(want);
        expect((await listed(api, prog.comp.id, g.user.id)).name, `${want}: the organisers' list`).toBe(want);
      }
    } finally { await api.dispose(); }
  });

  // OPERATOR RULING, 14 Nov 2026: a name printed as one word (both parts in Han,
  // kana or Hangul, family name first with no space: 张伟) does not show where
  // its surname ends, so /credential accepts the WHOLE name as printed as well
  // as the family part, the part printed first (张). The given name alone (伟)
  // never verifies, and nothing else widens: a Latin name still needs its family
  // name, and a mixed pair (printed with a space) gains nothing. A refusal is
  // byte-identical to an unknown code. The page's hint says what to type.
  test("a name printed as one word verifies whole or by its surname, never by its given name; nothing else widens", async () => {
    test.setTimeout(150_000);
    const { api, csrf } = await sa();
    try {
      const { api: anon } = await freshCtx();
      try {
        const html = await (await anon.get("/credential")).text();
        expect(html, "the surname field's hint").toContain("A Chinese, Japanese or Korean name printed as one word begins with the surname: type the whole name as printed, without a title such as Dr., or only the surname, for example 张伟 or 张.");
      } finally { await anon.dispose(); }
      const prog = await program(api, csrf);
      let zh = null;
      for (const name of [CHINESE, JAPANESE, KOREAN]) {
        const g = await holderIn(api, csrf, prog, name);
        if (name === CHINESE) zh = g;
        expect(badgeRow(g.token).name_snapshot, `PRECONDITION: ${name.printed} is printed as one word`).toBe(name.printed);
        expect((await lookup(g.code, name.printed)).found, `${name.printed}: the whole name as printed verifies it`).toBe(true);
        expect((await lookup(g.code, name.lastName)).found, `${name.lastName}: so does the surname, printed first`).toBe(true);
        expect((await lookup(g.code, name.firstName)).found, `${name.firstName}: the given name alone never does`).toBe(false);
      }
      expect((await lookup(zh.code, `${CHINESE.firstName}${CHINESE.lastName}`)).found, "nor the two parts the other way round").toBe(false);
      // A salutation prints before the name ("Dr. 张伟": the CJK face draws it
      // all) but is no part of what the lookup matches, which is made from the
      // frozen parts: the whole name verifies without it, as the hint says.
      const dr = await holderIn(api, csrf, prog, { personalTitle: "Dr.", firstName: CHINESE.firstName, lastName: CHINESE.lastName });
      expect(badgeRow(dr.token).name_snapshot, "PRECONDITION: the salutation is printed before the name").toBe(`Dr. ${CHINESE.printed}`);
      expect((await lookup(dr.code, CHINESE.printed)).found, "the whole name without its salutation verifies it").toBe(true);
      expect((await lookup(dr.code, CHINESE.lastName)).found, "so does the surname").toBe(true);
      expect((await lookup(dr.code, `Dr. ${CHINESE.printed}`)).found, "with the salutation it does not: the hint says to leave it out").toBe(false);

      // CONTROLS: nothing else widens. A Latin holder still needs the family name.
      const jane = await holderIn(api, csrf, prog, { firstName: "Jane", lastName: "Doe" });
      expect(badgeRow(jane.token).name_snapshot, "PRECONDITION: printed given name first").toBe("Jane Doe");
      expect((await lookup(jane.code, "Doe")).found, "the Latin family name verifies it").toBe(true);
      expect((await lookup(jane.code, "Jane Doe")).found, "the whole Latin name does not").toBe(false);
      // A Latin given name with a Han family name is printed with a space, given
      // name first: its whole name is no key either.
      const mixed = await holderIn(api, csrf, prog, { firstName: "Wei", lastName: "张" });
      expect(badgeRow(mixed.token).name_snapshot, "PRECONDITION: a mixed pair keeps given name first").toBe("Wei 张");
      expect((await lookup(mixed.code, "张")).found, "its family name verifies it").toBe(true);
      expect((await lookup(mixed.code, "Wei 张")).found, "its whole name does not").toBe(false);

      // A refusal says nothing a stranger could use: the given name alone and a
      // wrong name answer exactly as an unknown code does.
      const raw = async (code, surname) => {
        const { api: a } = await freshCtx();
        try {
          const r = await a.post("/credential", { headers: { "content-type": "application/json", accept: "application/json" }, data: { code, surname } });
          return { status: r.status(), text: await r.text() };
        } finally { await a.dispose(); }
      };
      const unknown = await raw("ZZZZZZZZZZZZ", CHINESE.firstName);
      expect(JSON.parse(unknown.text), "PRECONDITION: an unknown code is refused").toEqual({ found: false });
      for (const s of [CHINESE.firstName, "王"]) {
        const r = await raw(zh.code, s);
        expect(r.status, `${s}: the same status as an unknown code`).toBe(unknown.status);
        expect(r.text, `${s}: the same body, byte for byte`).toBe(unknown.text);
      }
    } finally { await api.dispose(); }
  });

  // The legacy guard (routes/badge.js `_mintedWithNickname`) holds Inter-only
  // coverage for certificates frozen with the nickname, and for no other: a
  // certificate minted printing a Chinese name follows its holder's name.
  test("a certificate minted printing a Chinese name follows a rename to another Chinese name, and says so", async () => {
    const { api, csrf } = await sa();
    try {
      const g = await issued(api, csrf, CHINESE);
      expect(JSON.parse(badgeRow(g.token).name_match_snapshot), "PRECONDITION: minted printing the name, not the nickname")
        .toEqual({ given: CHINESE.firstName, family: CHINESE.lastName });
      const put = await api.put(`/api/admin/participants/${g.user.id}`, { headers: H(csrf), data: { firstName: "芳", lastName: "王" } });
      expect(put.ok(), `rename: ${await put.text()}`).toBeTruthy();
      const ok = await lookup(g.code, CHINESE.lastName);
      expect(ok.found, "the family name it was issued under still verifies it").toBe(true);
      expect(ok.name, "the certificate prints the holder's name today, family name first").toBe("王芳");
      expect(ok.nameChanged, "and the page says the name has changed").toBe(true);
      // The whole-name key is made from the FROZEN parts, as the family name is:
      // the name it was issued under verifies it whole, today's name does not.
      expect((await lookup(g.code, CHINESE.printed)).found, "the whole name it was issued under verifies it").toBe(true);
      expect((await lookup(g.code, "王芳")).found, "the name printed today is not a key for it").toBe(false);
    } finally { await api.dispose(); }
  });

  // OPERATOR RULING, 14 Nov 2026: a certificate issued before this release keeps
  // what it printed. One that printed the nickname — a Chinese name before the
  // faces shipped, or a name whose salutation the fonts could not draw —
  // keeps printing it, because the nickname is what its lookup matches. Its
  // share dialog's nickname note gives the fonts as the reason, so re-opening it
  // carries `name_fallback` only where today's fonts cannot draw the name either.
  test("a certificate minted with the nickname before this release keeps printing it and still verifies; its dialog blames the fonts only where they are why", async () => {
    test.setTimeout(180_000);
    const { api, csrf } = await sa();
    try {
      // [the name, what a certificate minted now prints (null: given and family name)]
      for (const [name, nowPrints] of [[CHINESE, CHINESE.printed],
        // "د." is a salutation in Arabic: Inter could not draw it, so the whole
        // name fell back, and the rule now leaves it off a new certificate.
        [{ personalTitle: "د.", firstName: "John", lastName: `Smith${uniq()}` }, null],
        [{ personalTitle: "Dr.", ...ARABIC }, ARABIC.printed]]) {
        const want = nowPrints || `${name.firstName} ${name.lastName}`;
        const old = await issued(api, csrf, name);
        const fresh = await issued(api, csrf, name);
        expect(badgeRow(old.token).name_snapshot, "PRECONDITION: a certificate minted now prints the name").toBe(want);
        // `old` back into the state a mint before this release left it in: the
        // nickname printed and frozen as the surname to type (the mint's fallback
        // branch writes exactly these two columns).
        const Database = require("better-sqlite3");
        const db = new Database(TEST_DB_PATH);
        try {
          const r = db.prepare("UPDATE achievement_badges SET name_snapshot=?, name_match_snapshot=? WHERE token=?")
            .run(old.user.nickname, JSON.stringify({ given: "", family: old.user.nickname }), old.token);
          expect(r.changes, "the historical state was written").toBe(1);
        } finally { db.close(); }

        const kept = await lookup(old.code, old.user.nickname);
        expect(kept.found, `${want}: the nickname printed at mint still verifies it`).toBe(true);
        expect(kept.name, `${want}: and it still prints the nickname, which is what its lookup matches`).toBe(old.user.nickname);
        expect(kept.nameChanged, "no false claim that the holder was renamed").toBeFalsy();
        expect((await lookup(old.code, name.lastName)).found,
          "the family name it never printed is not a key for it").toBe(false);
        const h = await asHolder(old.user, old.comp.id);
        expect(h.held.name, "the holder's list shows what that certificate prints").toBe(old.user.nickname);
        expect(h.me.certificate_printed_name, "CONTROL: a certificate issued now would print the name").toBe(want);
        expect((await listed(api, old.comp.id, old.user.id)).name, "the organisers' list names it as it prints").toBe(old.user.nickname);
        expect((await listed(api, fresh.comp.id, fresh.user.id)).name, "CONTROL: and the one minted now by the name").toBe(want);
        // Today's fonts draw this name, so the nickname note's reason ("the
        // certificate typeface cannot draw your name") would be false: the
        // holder re-opening it is told nothing of the kind.
        expect(notesOf(await reopen(old.user, old.comp.id)), `${want}: re-opened, no note blames the fonts`).toEqual({});

        // CONTROL: the same person's certificate minted now prints the name.
        const now = await lookup(fresh.code, name.lastName);
        expect(now.found).toBe(true);
        expect(now.name, "a certificate minted now names the person").toBe(want);
      }

      // CONTROL: a certificate frozen with the nickname whose holder's name no
      // face draws today either. The fonts ARE the reason, and the note says so.
      const { canRenderText, certificateName } = require("../lib/badge.js");
      expect(canRenderText(certificateName(GEORGIAN)), "PRECONDITION: no face draws the Georgian name").toBe(false);
      const ka = await issued(api, csrf, GEORGIAN);
      expect(JSON.parse(badgeRow(ka.token).name_match_snapshot), "PRECONDITION: frozen with the nickname")
        .toEqual({ given: "", family: ka.user.nickname });
      expect(notesOf(await reopen(ka.user, ka.comp.id)), "re-opened, the nickname note: the fonts are why").toEqual({ name_fallback: true });
    } finally { await api.dispose(); }
  });
});

// The Rankings top three previews each certificate with the name it prints: the
// admin board row carries it (`certificatePrintedName`), by the certificate's own
// rule, so the browser never composes it.
test("the admin board names each row as its certificate would print it", async () => {
  test.setTimeout(120_000);
  const { api, csrf } = await sa();
  try {
    const cr = await api.post("/api/admin/competitions", { headers: H(csrf), data: {
      name: `${uniq()} board`, event_kind: "tournament", start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 60 } });
    expect(cr.ok(), `create: ${await cr.text()}`).toBeTruthy();
    const comp = (await cr.json()).competition;
    const people = [
      [CHINESE, CHINESE.printed],
      [{ personalTitle: "Dr.", ...ARABIC }, ARABIC.printed],
      [{ personalTitle: "Dr.", firstName: "Jane", lastName: `Doe${uniq()}` }, null],   // the salutation stays
      [{ firstName: "राहुल", lastName: "शर्मा" }, "NICKNAME"],
      // The certificate-name override follows the same rule as the profile name.
      [{ firstName: "Jane", lastName: "Roe", certGiven: "太郎", certFamily: "田中" }, "田中太郎"],
    ];
    const rows = [];
    for (const [name, printed] of people) {
      const user = await makeParticipant(api, csrf, uniq(), name);
      if (name.certGiven) await editProfile(api, csrf, user.id, { certificateGivenName: name.certGiven, certificateFamilyName: name.certFamily });
      rows.push({ user, want: printed === "NICKNAME" ? user.nickname : (printed || `Dr. ${name.firstName} ${name.lastName}`), name });
    }
    const asg = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: rows.map(r => r.user.id), competitionIds: [comp.id] } });
    expect((await asg.json()).assigned, "all were enrolled").toBe(rows.length);
    // Entering the live event puts each on the board.
    for (const r of rows) {
      const { api: p, csrf: c0 } = await freshCtx();
      try {
        expect((await codeLogin(p, r.user.email, H(c0))).ok()).toBeTruthy();
        const pc = (await (await p.get("/api/csrf-token")).json()).csrfToken;
        expect((await p.post("/api/select-competition", { headers: H(pc), data: { competitionId: comp.id } })).ok()).toBeTruthy();
      } finally { await p.dispose(); }
    }
    const board = await (await api.get(`/api/admin/leaderboard?competitionId=${encodeURIComponent(comp.id)}`)).json();
    for (const r of rows) {
      const e = board.find(x => x.userId === r.user.id);
      expect(e, `${r.want} is on the board`).toBeTruthy();
      expect(e.certificatePrintedName, `${r.name.firstName} ${r.name.lastName}`).toBe(r.want);
    }
    // CONTROL: the board's own identity columns are the profile's, unchanged, so
    // composing them would give the wrong order.
    const zh = board.find(x => x.userId === rows[0].user.id);
    expect(`${zh.firstName} ${zh.lastName}`).toBe("伟 张");
  } finally { await api.dispose(); }
});
