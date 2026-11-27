// v8.1.1 — a salutation is not a name change.
//
// THE DEFECT. `/credential` computed its `nameChanged` verdict by folding the
// FROZEN name parts against the PRINTED name:
//
//     credentialNameKey(`${parts.given} ${parts.family}`) !== credentialNameKey(art.displayName)
//
// `name_match_snapshot` is `certificateNameParts` — given + family ONLY — while
// `art.displayName` is `certificateName`, which PREPENDS `personal_title`.
// `credentialNameKey` strips punctuation but keeps letters, so "Dr." survives as
// "dr" and the two keys are `janedoe` vs `drjanedoe`: they differ
// DETERMINISTICALLY for every holder who has ever picked a salutation. The
// public verification page and the JSON verdict therefore both announced "The
// holder's name has changed since this certificate was issued" on a trust
// document whose name is byte-identical to what was minted. `personal_title` is
// an ordinary optional profile field with seven presets, so this was the common
// case rather than an edge one.
//
// THE FIX compares like with like — the frozen parts against the parts TODAY's
// render would freeze — so the salutation takes part on neither side. What the
// page DISPLAYS is deliberately unchanged: it shows the current name and
// discloses a genuine change, which is the settled v8.1.0 decision (the page is
// an authoritative re-render; a stale name is a worse answer).
//
// THE DISCRIMINATING MUTATIONS for this file:
//   • restore `credentialNameKey(art.displayName)` as the right-hand side  → the
//     salutation test fails, the no-salutation control stays green;
//   • hard-code `nameChanged: false`                                      → the
//     rename POSITIVE CONTROL fails;
//   • derive the live parts straight from the profile columns, ignoring the
//     font-fallback branch (`_badgeMatchParts`'s `fallback ?`)            → the
//     fallback test fails, everything else stays green.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, codeLogin } = require("./helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `nc${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

// The exact sentence the page prints for a changed name. Matched as a substring
// of the rendered HTML rather than by a class name: the CLAIM is what was wrong,
// so the claim is what this file asserts on.
const CHANGED_SENTENCE = "name has changed since this certificate was issued";

// A Georgian name no shipped face draws — so every surface prints the NICKNAME
// and the frozen parts follow what was SHOWN (v8.1.1's font-fallback freeze).
// Asserted as a precondition below rather than assumed, exactly as
// credential-name-fallback.spec.js does: the covered scripts have grown twice
// (the Noto faces of 14 Nov 2026 drew the CJK example this used), and a future
// face covering Georgian would make that test vacuous rather than red.
const UNDRAWABLE = { firstName: "გიორგი", lastName: "ბერიძე" };

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
      // Optional and free text; omitted entirely for the no-salutation control,
      // because storing "" and storing nothing must behave the same here.
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
 * A completed Program certificate for a participant with the given name.
 *
 * A PROGRAM deliberately, not a Competition: `auto_end_on_all_solved` defaults
 * OFF for the kind (PR 16), so the lone participant solving the only challenge
 * does NOT auto-end the event and the end-now below is still accepted — the
 * fixture-checklist trap that would otherwise need a second, non-solving
 * enrollee.
 */
async function issued(api, csrf, name) {
  const start = new Date(Date.now() - 3600e3).toISOString();
  const cr = await api.post("/api/admin/competitions", {
    headers: H(csrf),
    data: {
      name: `${uniq()} program`, event_kind: "program", start_time: start, timezone: "UTC",
      deadline_at: new Date(Date.now() + 90 * 86400e3).toISOString(),
    },
  });
  expect(cr.ok(), `create program: ${await cr.text()}`).toBeTruthy();
  const comp = (await cr.json()).competition;

  const tr = await api.post("/api/admin/tasks", {
    headers: H(csrf),
    data: { title: `${uniq()} T`, description: "d", difficulty: "easy",
            answer_type: "text", correct_answer: "right0", status: "published" },
  });
  expect(tr.ok(), await tr.text()).toBeTruthy();
  const taskId = (await tr.json()).id;
  expect((await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } })).ok()).toBeTruthy();

  const user = await makeParticipant(api, csrf, uniq(), name);
  const asg = await api.post("/api/admin/competitions/assign", {
    headers: H(csrf), data: { userIds: [user.id], competitionIds: [comp.id] },
  });
  expect(asg.ok(), await asg.text()).toBeTruthy();
  // Precondition, not decoration: the assign endpoint SILENTLY SKIPS an
  // ineligible user, and a skipped enrolment surfaces much later as a 403 on the
  // mint that says nothing about the cause.
  expect((await asg.json()).assigned, "the participant was really enrolled").toBe(1);

  const { api: p, csrf: c0 } = await freshCtx();
  try {
    const li = await codeLogin(p, user.email, H(c0));
    expect(li.ok(), `login ${user.email}: ${await li.text()}`).toBeTruthy();
    const pc = (await (await p.get("/api/csrf-token")).json()).csrfToken;
    expect((await p.post("/api/select-competition", { headers: H(pc), data: { competitionId: comp.id } })).ok()).toBeTruthy();

    // The grading token from GET /api/tasks/:id is REQUIRED on submit (v7.20.9).
    const view = await (await p.get(`/api/tasks/${taskId}`)).json();
    const sub = await p.post(`/api/tasks/${taskId}/submit`, {
      headers: { "x-csrf-token": pc },
      multipart: { answer: "right0", gradingHash: view.grading_hash || "" },
    });
    expect((await sub.json()).correct, "the challenge was solved").toBe(true);

    expect((await api.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf), data: {} })).ok()).toBeTruthy();
    const mint = await p.post(`/api/competitions/${comp.id}/badge`, { headers: { "x-csrf-token": pc } });
    expect(mint.ok(), `mint: ${await mint.text()}`).toBeTruthy();
    const b = await mint.json();
    expect(b.publicCode, "a new mint carries a printed verification code").toBeTruthy();
    return { comp, user, token: b.token, code: b.publicCode };
  } finally { await p.dispose(); }
}

const lookup = (anon, code, surname) => anon.post("/credential", {
  headers: { "content-type": "application/json", accept: "application/json" },
  data: { code, surname },
});

/** The same lookup a stranger on a phone makes: no Accept header, so HTML. */
const lookupPage = (anon, code, surname) => anon.post("/credential", {
  form: { code, surname },
});

const badgeRow = (token) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare("SELECT * FROM achievement_badges WHERE token=?").get(token); }
  finally { db.close(); }
};

test.describe("v8.1.1 — /credential only claims a name changed when it did", () => {
  test("a holder with a SALUTATION is not reported as renamed", async () => {
    // Mutation this catches: restoring `credentialNameKey(art.displayName)` as
    // the right-hand side of the comparison, which folds "Dr." into one side
    // only and makes the claim false for every holder who set a salutation.
    const { api, csrf } = await sa();
    try {
      const g = await issued(api, csrf, { personalTitle: "Dr.", firstName: "Jane", lastName: `Doe${uniq()}` });

      // PRECONDITION. Without this the test degenerates into the no-salutation
      // control and passes whatever the comparison does — the salutation has to
      // really be on the printed name for the fold to have anything to trip on.
      const row = badgeRow(g.token);
      expect(row, "the badge row exists").toBeTruthy();
      expect(row.name_snapshot, "the artwork really printed the salutation").toContain("Dr.");
      const parts = JSON.parse(row.name_match_snapshot);
      expect(parts.given, "…and the frozen match parts really carry no salutation").toBe("Jane");

      const { api: anon } = await freshCtx();
      try {
        const ok = await (await lookup(anon, g.code, parts.family)).json();
        expect(ok.found, "the certificate verifies").toBe(true);
        expect(ok.nameChanged, "nothing about this holder's name has moved").toBe(false);
        // SCOPE BOUNDARY: what the page DISPLAYS is untouched — it is an
        // authoritative re-render and still shows the salutation.
        expect(ok.name, "the page still re-renders the full printed name").toBe(row.name_snapshot);

        const html = await (await lookupPage(anon, g.code, parts.family)).text();
        expect(html, "and the page prints no such claim").not.toContain(CHANGED_SENTENCE);
      } finally { await anon.dispose(); }
    } finally { await api.dispose(); }
  });

  test("POSITIVE CONTROL: a holder who really is renamed IS reported as renamed", async () => {
    // Without this, "nameChanged is false" is equally satisfied by a build that
    // hard-codes false or drops the field — i.e. by deleting the disclosure the
    // v8.1.0 design deliberately keeps. Driven with a salutation present, so it
    // also proves the fix did not simply stop looking at the name at all.
    const { api, csrf } = await sa();
    try {
      const originalSurname = `Doe${uniq()}`;
      const g = await issued(api, csrf, { personalTitle: "Dr.", firstName: "Jane", lastName: originalSurname });

      const renamed = `Marlowe${uniq()}`;
      const put = await api.put(`/api/admin/participants/${g.user.id}`, {
        headers: H(csrf), data: { lastName: renamed },
      });
      expect(put.ok(), `rename: ${await put.text()}`).toBeTruthy();

      const { api: anon } = await freshCtx();
      try {
        // The FROZEN surname is still what verifies — that is the whole point of
        // freezing it, and it is what the verifier has on paper.
        const ok = await (await lookup(anon, g.code, originalSurname)).json();
        expect(ok.found, "the certificate still verifies on the name it was issued under").toBe(true);
        expect(ok.nameChanged, "and the page says so").toBe(true);
        expect(ok.name, "the current name is what is shown").toContain(renamed);

        const html = await (await lookupPage(anon, g.code, originalSurname)).text();
        expect(html, "the disclosure really reaches the page").toContain(CHANGED_SENTENCE);
      } finally { await anon.dispose(); }
    } finally { await api.dispose(); }
  });

  test("a holder with NO salutation is unaffected", async () => {
    // Pins today's already-correct behaviour on the path the defect never
    // reached, so a future "simplification" of the comparison cannot break the
    // ordinary case while the salutation test stays green.
    const { api, csrf } = await sa();
    try {
      const surname = `Poe${uniq()}`;
      const g = await issued(api, csrf, { firstName: "Ann", lastName: surname });

      const row = badgeRow(g.token);
      expect(row.name_snapshot, "no salutation was printed").toBe(`Ann ${surname}`);

      const { api: anon } = await freshCtx();
      try {
        const ok = await (await lookup(anon, g.code, surname)).json();
        expect(ok.found).toBe(true);
        expect(ok.nameChanged).toBe(false);
        expect(await (await lookupPage(anon, g.code, surname)).text()).not.toContain(CHANGED_SENTENCE);
      } finally { await anon.dispose(); }
    } finally { await api.dispose(); }
  });

  test("a font-fallback certificate reports no spurious change either", async () => {
    // Mutation this catches: deriving the live parts straight from the profile
    // columns without honouring the fallback branch. The frozen parts hold the
    // PRINTED nickname (v8.1.1) while the profile still holds the undrawable
    // name, so such a build reports every fallback certificate as renamed the
    // moment it is issued — the same false claim, through a different door.
    const { canRenderText, certificateName } = require("../lib/badge.js");
    expect(canRenderText(certificateName(UNDRAWABLE)),
      "PRECONDITION: the fixture name must really be undrawable, or this is vacuous").toBe(false);

    const { api, csrf } = await sa();
    try {
      const g = await issued(api, csrf, UNDRAWABLE);

      const row = badgeRow(g.token);
      expect(row.name_snapshot, "the artwork printed the nickname").toBe(g.user.nickname);
      expect(JSON.parse(row.name_match_snapshot).family, "…and the frozen parts followed it").toBe(g.user.nickname);

      const { api: anon } = await freshCtx();
      try {
        const ok = await (await lookup(anon, g.code, g.user.nickname)).json();
        expect(ok.found, "the printed name still verifies").toBe(true);
        expect(ok.nameChanged, "the name a verifier can read has not moved").toBe(false);
        expect(await (await lookupPage(anon, g.code, g.user.nickname)).text()).not.toContain(CHANGED_SENTENCE);
      } finally { await anon.dispose(); }
    } finally { await api.dispose(); }
  });
});
