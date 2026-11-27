// v8.8.20 — THE VERIFICATION CODE IS ON THE CERTIFICATE.
//
// `/credential` asks a verifier for a code plus the holder's surname. The code
// has existed since v8.1.0 (PR 27) and was rendered on NO artefact: it lived in
// `achievement_badges.public_code`, in the holder's own dialog and in the
// superadmin resolver, and nowhere on the document a verifier is handed. So the
// workflow the whole feature was built for — read the code off the certificate,
// type it into the page — could not happen. Found while rewriting
// EXECUTIVE_SUMMARY.md, by nobody's test.
//
// TWO LAYERS, because either alone passes against half a fix:
//   * the UNIT arms drive `buildCertificateSvg` directly — they kill a renderer
//     that stops drawing the line, and they are the only place the pathological
//     inputs (a 250-character hostname, a legacy NULL code) are reachable; and
//   * the ROUTE arm proves `_badgeArt` actually PASSES the code, which a unit
//     test structurally cannot see. It works by DIFFERENCE — the certificate PDF
//     must change when the badge's `public_code` is cleared — because the PDF
//     embeds a bitmap, so the code is not text anyone can grep for.
//
// The controls carry as much weight as the positives. "The code is on the
// certificate" is equally satisfied by a build that puts it on every canvas,
// which is a decision this release deliberately did not take; and "the two PDFs
// differ" is equally satisfied by a non-deterministic PDF writer.

const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, getSuperadminPass, PARTICIPANT_PASS, TEST_DB_PATH, codeLogin } = require("./helpers");
const { buildCertificateSvg, buildBadgeSvg, formatCredentialCode } = require("../lib/badge.js");

const H = (c) => ({ "x-csrf-token": c, "content-type": "application/json" });
const TAG = `cca${Date.now().toString(36)}`;
let seq = 0;
const uniq = () => `${TAG}${(seq++).toString(36)}`;

const CODE = "4K7MP2QX9RTV";

/** The art object both canvases read, with only what this file is about varying. */
const art = (over = {}) => ({
  platformName: "Checkmarx Enablement Platform",
  rank: 1,
  competitionName: "Secure Coding Championship",
  displayName: "María José García-Hernández",
  dateLabel: "14 August 2026",
  scoreLabel: "1,450 pts",
  basis: null,
  lateEntrant: false,
  publicCode: CODE,
  verifyUrl: "hack.checkmarx.com/credential",
  ...over,
});

test.describe("v8.8.20 — the certificate carries its verification code", () => {
  test("the code and where to take it are ON the certificate, in the printed grouping", async () => {
    const svg = buildCertificateSvg(art());
    expect(svg, "the certificate says where to verify").toContain("VERIFY AT hack.checkmarx.com/credential");
    expect(svg, "…and carries the code in the 4-4-4 form the page accepts")
      .toContain(`>${formatCredentialCode(CODE)}<`);
    // The grouping is not decoration: `/credential` normalises what is typed, so
    // an unhyphenated run would still verify — but nobody copies twelve
    // characters correctly, which is why `formatCredentialCode` exists.
    expect(formatCredentialCode(CODE)).toBe("4K7M-P2QX-9RTV");
    expect(svg, "the raw run is not printed beside the grouped one").not.toContain(`>${CODE}<`);
  });

  test("CONTROL — the SHARE canvas does NOT carry it, and that is a decision", async () => {
    // Without this, "the code is on the certificate" is satisfied by a build that
    // puts it on every canvas. `buildBadgeSvg` is the 1200x627 OpenGraph card
    // LinkedIn renders in a scrolling feed: twelve characters are unreadable
    // there and its reader is holding no document. This deliberately departs from
    // v8.6.0's LATE_ENTRY_STAT rule that both canvases carry a marker from ONE
    // declaration — that rule is about a CLAIM the artefact makes about the
    // holder, where asymmetry means the two contradict each other. Reversing this
    // is allowed; doing it silently is not, which is what this test costs.
    const svg = buildBadgeSvg(art());
    expect(svg, "no code on the share card").not.toContain(formatCredentialCode(CODE));
    expect(svg, "…and no instruction to verify one").not.toContain("VERIFY AT");
  });

  test("a LEGACY badge with no code renders NOTHING — not a label over a blank", async () => {
    // v8.1.0 (PR 27) minted codes for NEW badges only and deliberately did not
    // backfill: a pre-existing certificate cannot be verified this way, and must
    // not imply that it can.
    const svg = buildCertificateSvg(art({ publicCode: null }));
    expect(svg, "no verification instruction").not.toContain("VERIFY AT");
    expect(svg, "no orphaned label").not.toContain("VERIFY THIS CERTIFICATE");
    expect(svg, "no orphaned ID heading").not.toContain("CERTIFICATE ID");
    expect(svg, "…and no QR code, even when a link is supplied")
      .not.toContain("cert-qr");
    expect(buildCertificateSvg(art({ publicCode: null, verifyLink: "https://x.example/credential?code=Z" })),
      "a link without a code draws no QR").not.toContain("cert-qr");
    // …and the rest of the certificate is unchanged, or "nothing rendered" would
    // be satisfied by a renderer that fell over on a null code.
    expect(svg, "the certificate still names its holder").toContain("García-Hernández");
    expect(svg, "…and still carries its stat row").toContain("ACHIEVEMENT UNLOCKED");
  });

  test("the code is never TRUNCATED, however long the address in front of it", async () => {
    // `fitToWidth` ellipsises once its floor is reached, which is right for a
    // competition name and catastrophic for a verification code — a cut code
    // reads as a forgery to whoever types it. The line shrinks and never cuts,
    // the rule `fitNameLines` exists for on the name above it.
    const long = `${"verylonghostname".repeat(12)}.example.com/credential`;
    const svg = buildCertificateSvg(art({ verifyUrl: long }));
    expect(svg, "the code survives in full").toContain(`>${formatCredentialCode(CODE)}<`);
    expect(svg, "nothing was ellipsised").not.toContain("…");
  });

  test("no verifyUrl degrades the LABEL, never the code", async () => {
    // BASE_URL is required at boot, so the route always supplies one — this is
    // the shape a future caller building the art object by hand would hit, and
    // "VERIFY AT /credential" would be a wrong answer where a bare instruction is
    // merely a smaller one.
    const svg = buildCertificateSvg(art({ verifyUrl: "" }));
    expect(svg).toContain("VERIFY THIS CERTIFICATE");
    expect(svg).toContain(`>${formatCredentialCode(CODE)}<`);
  });
});

test.describe("v8.8.20 — the route passes the code to the renderer", () => {
  async function sa() {
    const { api, csrf: c0 } = await freshCtx();
    const r = await api.post("/api/login", { headers: H(c0), data: { email: "superadmin", password: getSuperadminPass() } });
    expect(r.ok(), `superadmin login: ${r.status()}`).toBeTruthy();
    return { api, csrf: (await (await api.get("/api/csrf-token")).json()).csrfToken };
  }

  /** A minted, code-bearing certificate for a participant this test owns. */
  async function issued(api, csrf) {
    const label = uniq();
    const email = `${label}@company.example`;
    const reg = await registerPost(api, "/api/register", {
      headers: H(csrf),
      data: { firstName: "Cert", lastName: "Holder", nickname: label, email, company: "Acme",
              title: "Engineer", country: "US", timezone: "America/New_York", password: PARTICIPANT_PASS,
              jobFunction: "Software Developer / Engineer", city: "Testville" },
    });
    expect(reg.status(), `register: ${await reg.text()}`).toBe(200);
    const list = await (await api.get(`/api/admin/participants?limit=500&search=${encodeURIComponent(email)}`)).json();
    const u = (list.participants || []).find(p => p.email === email);
    expect(u, "participant findable").toBeTruthy();
    await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
    await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });

    const cr = await api.post("/api/admin/competitions", {
      headers: H(csrf),
      data: { name: `${uniq()} cert`, event_kind: "program", timezone: "UTC",
              start_time: new Date(Date.now() - 3600e3).toISOString(),
              deadline_at: new Date(Date.now() + 90 * 86400e3).toISOString() },
    });
    expect(cr.ok(), await cr.text()).toBeTruthy();
    const comp = (await cr.json()).competition;

    const tr = await api.post("/api/admin/tasks", {
      headers: H(csrf),
      data: { title: `${uniq()} T`, description: "d", difficulty: "easy",
              answer_type: "text", correct_answer: "right", status: "published" },
    });
    expect(tr.ok(), await tr.text()).toBeTruthy();
    const taskId = (await tr.json()).id;
    expect((await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } })).ok()).toBeTruthy();
    const asg = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [u.id], competitionIds: [comp.id] } });
    expect(asg.ok(), await asg.text()).toBeTruthy();
    expect((await asg.json()).assigned, "the assign SKIPS an ineligible user, so assert it landed").toBe(1);

    const { api: pa, csrf: c1 } = await freshCtx();
    try {
      expect((await codeLogin(pa, email, H(c1))).ok()).toBeTruthy();
      const pc = (await (await pa.get("/api/csrf-token")).json()).csrfToken;
      expect((await pa.post("/api/select-competition", { headers: H(pc), data: { competitionId: comp.id } })).ok()).toBeTruthy();
      const view = await (await pa.get(`/api/tasks/${taskId}`)).json();
      const sub = await pa.post(`/api/tasks/${taskId}/submit`, {
        headers: { "x-csrf-token": pc }, multipart: { answer: "right", gradingHash: view.grading_hash || "" },
      });
      expect((await sub.json()).correct, "the solve landed").toBe(true);
      const mint = await pa.post(`/api/competitions/${comp.id}/badge`, { headers: { "x-csrf-token": pc } });
      expect(mint.ok(), `mint: ${await mint.text()}`).toBeTruthy();
      const b = await mint.json();
      expect(b.publicCode, "a v8.1.0+ mint carries a printed code").toBeTruthy();
      return { token: b.token, code: b.publicCode };
    } finally { await pa.dispose(); }
  }

  const pdfOf = async (token) => {
    const { api } = await freshCtx();
    try {
      const r = await api.get(`/badge/${token}/certificate.pdf`);
      expect(r.ok(), `certificate.pdf: ${r.status()}`).toBeTruthy();
      return await r.body();
    } finally { await api.dispose(); }
  };

  test("clearing the badge's code CHANGES the certificate PDF", async () => {
    test.setTimeout(180_000);
    const crypto = require("crypto");
    const Database = require("better-sqlite3");
    const { api, csrf } = await sa();
    let g;
    try { g = await issued(api, csrf); } finally { await api.dispose(); }

    const h = (b) => crypto.createHash("sha256").update(b).digest("hex");
    const before = h(await pdfOf(g.token));

    // CONTROL FIRST: the same badge, rendered twice, must be byte-identical.
    // Without it "the bytes changed" is equally satisfied by a PDF writer that
    // is simply not deterministic, and this test would prove nothing at all.
    expect(h(await pdfOf(g.token)), "the certificate render is deterministic").toBe(before);

    const db = new Database(TEST_DB_PATH);
    try { db.prepare("UPDATE achievement_badges SET public_code=NULL WHERE token=?").run(g.token); }
    finally { db.close(); }

    const after = h(await pdfOf(g.token));
    expect(after, "the route reads public_code and the renderer draws it")
      .not.toBe(before);
  });
});
