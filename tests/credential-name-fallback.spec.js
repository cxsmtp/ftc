// v8.1.0 — a certificate that prints the NICKNAME must be verifiable with the
// nickname.
//
// THE DEFECT. `_badgeDisplayName` falls back to the nickname when the badge font
// cannot draw the name (a script no shipped face covers), so every surface — PNG,
// certificate PDF, public page — shows the handle. The mint nevertheless froze
// `name_match_snapshot` from the RAW first/last name, so the only surname
// /credential would accept was one that appears NOWHERE on the certificate: the
// holder's employer types what is printed, it folds to a non-matching key, and a
// GENUINE certificate answers "no matching certificate" — reading as forged. Ten
// such attempts also exhaust the per-code failure budget, locking out even a
// verifier who somehow knows the real surname. The snapshot is frozen and the
// mint is idempotent, so setting a latin certificate name afterwards cannot
// repair it.
//
// THE FIX changes only what the lookup MATCHES, never what is PRINTED — the
// nickname fallback on the artwork is the deliberate v7.21.28 behaviour and is
// correct (a certificate naming nobody is worse than one carrying the handle).
//
// THE DISCRIMINATING MUTATION for this whole file is restoring the raw-parts
// freeze at the mint, i.e. dropping the `nameFellBack ?` branch in
// routes/badge.js so `name_match_snapshot` always comes from first/last. That
// leaves the latin control green and fails the fallback tests.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, codeLogin } = require("./helpers");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `nf${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

// A Georgian name no shipped face draws (Inter covers Latin, Greek and Cyrillic;
// the Noto fallback faces Arabic, Hebrew, Thai and CJK). Asserted as
// a PRECONDITION below rather than assumed: the covered scripts have grown twice
// (PR 24 brought Cyrillic and Greek, and the Noto faces of 14 Nov 2026 the CJK
// this example used to be), so a future face covering Georgian would make every
// test here vacuous rather than red.
const UNDRAWABLE = { firstName: "გიორგი", lastName: "ბერიძე" };
const DRAWABLE = { firstName: "María", lastName: "García Hernández" };

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
 * enrollee. A completion certificate also attests one thing rather than a
 * placing, which keeps the fixture to one challenge.
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

const badgeRow = (token) => {
  const Database = require("better-sqlite3");
  const db = new Database(TEST_DB_PATH, { readonly: true });
  try { return db.prepare("SELECT * FROM achievement_badges WHERE token=?").get(token); }
  finally { db.close(); }
};

test.describe("v8.1.0 — a name the fonts cannot draw is still verifiable", () => {
  test("the printed name is the matched name when the font fallback fires", async () => {
    // Mutation this catches: dropping the `nameFellBack ?` branch at the mint, so
    // `name_match_snapshot` is frozen from first/last again. The verifier then
    // types the only surname on the paper and a genuine certificate is refused.
    const { canRenderText, certificateName } = require("../lib/badge.js");
    expect(canRenderText(certificateName(UNDRAWABLE)),
      "PRECONDITION: the fixture name must really be undrawable, or every assertion below is vacuous").toBe(false);

    const { api, csrf } = await sa();
    try {
      const g = await issued(api, csrf, UNDRAWABLE);

      // The mechanism: the frozen parts hold what was SHOWN, not the raw name.
      const row = badgeRow(g.token);
      expect(row, "the badge row exists").toBeTruthy();
      expect(row.name_snapshot, "the artwork printed the nickname").toBe(g.user.nickname);
      const parts = JSON.parse(row.name_match_snapshot);
      expect(parts.family, "…and the lookup matches that same string").toBe(g.user.nickname);
      expect(parts.family, "never the surname nobody can see on the certificate").not.toBe(UNDRAWABLE.lastName);

      const { api: anon } = await freshCtx();
      try {
        // The behaviour: an employer types the surname AS PRINTED and it verifies.
        const ok = await (await lookup(anon, g.code, g.user.nickname)).json();
        expect(ok.found, "the certificate a verifier is holding verifies").toBe(true);
        expect(ok.revoked).toBe(false);
        expect(ok.competitionName).toBe(g.comp.name);
        // What the page re-renders is what they were told to type — the two must
        // agree, or "type the surname as printed" is not an instruction anyone can
        // follow.
        expect(ok.name, "the page names the holder the way the paper does").toBe(g.user.nickname);
        expect(ok.name).not.toContain(UNDRAWABLE.lastName);
        // The fold still applies on this branch: nicknames are ASCII, but case is
        // exactly what a verifier copying off paper gets wrong.
        expect((await (await lookup(anon, g.code, g.user.nickname.toUpperCase())).json()).found,
          "case does not matter").toBe(true);
      } finally { await anon.dispose(); }
    } finally { await api.dispose(); }
  });

  test("POSITIVE CONTROL: an ordinary latin name is unaffected — real surname yes, nickname no", async () => {
    // Without this, "the printed name verifies" is equally satisfied by a build
    // that freezes the nickname for EVERYONE, or by one that accepts anything.
    // Both halves are load-bearing: the first says the ordinary path still works,
    // the second says the fix is scoped to the fallback and did not quietly make
    // every certificate matchable by a handle that is public on the leaderboard.
    const { api, csrf } = await sa();
    try {
      const g = await issued(api, csrf, DRAWABLE);

      const row = badgeRow(g.token);
      expect(row.name_snapshot, "the artwork printed the real name").toContain(DRAWABLE.lastName);
      const parts = JSON.parse(row.name_match_snapshot);
      expect(parts.given, "the raw parts are still frozen on this path").toBe(DRAWABLE.firstName);
      expect(parts.family).toBe(DRAWABLE.lastName);

      const { api: anon } = await freshCtx();
      try {
        expect((await (await lookup(anon, g.code, DRAWABLE.lastName)).json()).found,
          "the real surname still verifies").toBe(true);
        expect((await (await lookup(anon, g.code, "garcia")).json()).found,
          "…and one part of a compound surname, folded").toBe(true);
        expect((await (await lookup(anon, g.code, g.user.nickname)).json()).found,
          "the nickname is NOT a key when the name was drawable").toBe(false);
      } finally { await anon.dispose(); }
    } finally { await api.dispose(); }
  });

  test("a wrong surname is still the byte-identical uniform refusal, on both paths", async () => {
    // The anti-enumeration property must not regress: if a wrong surname were
    // distinguishable from an unknown code, the code alone would become a lookup
    // that reveals who holds it. Asserted for the fallback certificate as well as
    // the ordinary one, because the fallback path now builds its parts elsewhere.
    const { api, csrf } = await sa();
    try {
      const fallbackCert = await issued(api, csrf, UNDRAWABLE);
      const latinCert = await issued(api, csrf, DRAWABLE);
      const { api: anon } = await freshCtx();
      try {
        const unknown = await lookup(anon, "ZZZZZZZZZZZZ", "Nobody");
        const unknownBody = await unknown.text();

        for (const [g, why] of [[fallbackCert, "font fallback"], [latinCert, "ordinary name"]]) {
          const wrong = await lookup(anon, g.code, "Nobody");
          expect(wrong.status(), `${why}: same status as an unknown code`).toBe(unknown.status());
          expect(await wrong.text(), `${why}: byte-identical body`).toBe(unknownBody);
          expect((await wrong.json()).found).toBe(false);
          expect(await wrong.text(), `${why}: no holder leaks by any other channel`).not.toContain(g.comp.name);
        }
        // …and the real surname of the fallback certificate — the one that USED to
        // be the only accepted answer — is now just another wrong guess, because
        // it is not what the certificate shows.
        const stale = await lookup(anon, fallbackCert.code, UNDRAWABLE.lastName);
        expect(await stale.text(), "a surname that appears nowhere on the paper is refused").toBe(unknownBody);
      } finally { await anon.dispose(); }
    } finally { await api.dispose(); }
  });
});
