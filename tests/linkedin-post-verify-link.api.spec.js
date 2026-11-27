// @ts-check
//
// THE LINKEDIN POST'S VERIFICATION LINK FOLLOWS THE DESIGN (operator ruling,
// 24 Nov 2026). The post ends with BASE_URL/credential?code=<code> only where
// the event's certificate design prints the code OR the QR: a design hiding both
// keeps the code off the certificate, so a public post must not publish it.
// Both doors that hand the post out are checked, as they share one builder
// (lib/certificate-share.js linkedinPostFor): the signed-in certificate card's
// GET /api/me/certificates/:token/linkedin-post and the mailed share page,
// GET /badge/:link/post.
const { test, expect } = require("./isolated-test");
const { apiLogin } = require("./helpers");
const { heldCertificate, shareLink } = require("./certificate-fixture");
const { H } = require("./event-admin-helpers");

/** Both doors' post text for one certificate, read fresh. */
async function postsFor(mint, holderEmail) {
  const { api: pa } = await apiLogin(holderEmail);
  let card;
  try {
    const r = await pa.get(`/api/me/certificates/${mint.token}/linkedin-post`);
    expect(r.status(), await r.text()).toBe(200);
    card = (await r.json()).text;
    // The page's textarea holds the same post, HTML-escaped; read it raw.
    const page = await pa.get(`/badge/${shareLink(mint.token)}/post`);
    expect(page.status()).toBe(200);
    const m = (await page.text()).match(/<textarea id="share-post-text"[^>]*>([\s\S]*?)<\/textarea>/);
    expect(m, "PRECONDITION: the share page shows the post").toBeTruthy();
    return { card, page: /** @type {RegExpMatchArray} */ (m)[1] };
  } finally { await pa.dispose(); }
}

async function setDesign(compId, show) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  try {
    const r = show === null
      ? await sa.delete(`/api/admin/competitions/${compId}/certificate-config`, { headers: H(csrf) })
      : await sa.put(`/api/admin/competitions/${compId}/certificate-config`, { headers: H(csrf), data: { config: { show } } });
    expect(r.ok(), `design ${JSON.stringify(show)}: ${r.status()} ${await r.text()}`).toBeTruthy();
  } finally { await sa.dispose(); }
}

test("the post carries the verification link only while the certificate prints its code (the QR is drawn only beside it)", async () => {
  const { comp, holder, mint } = await heldCertificate("lipost");
  expect(mint.publicCode, "PRECONDITION: the certificate has a code").toBeTruthy();
  const link = `/credential?code=${encodeURIComponent(mint.publicCode)}`;

  // Default design (both shown): the link is on both doors.
  let p = await postsFor(mint, holder.email);
  for (const [door, text] of Object.entries(p)) expect(text, `default design, ${door}`).toContain(link);

  // Code and QR both hidden: no link on either door, nor the code anywhere in
  // the post; the hashtags line stays.
  await setDesign(comp.id, { code: false, qr: false });
  p = await postsFor(mint, holder.email);
  for (const [door, text] of Object.entries(p)) {
    expect(text, `code and QR off, ${door}: no link`).not.toContain("/credential");
    expect(text, `code and QR off, ${door}: no code`).not.toContain(mint.publicCode);
    expect(text, `code and QR off, ${door}: the hashtags remain`).toContain("#Checkmarx");
  }

  // The QR is drawn only inside the code's block (lib/badge.js), so a design
  // with the code off and the QR on prints neither: no link either.
  await setDesign(comp.id, { code: false, qr: true });
  p = await postsFor(mint, holder.email);
  for (const [door, text] of Object.entries(p)) {
    expect(text, `code off, QR on, ${door}: the certificate prints neither, so no link`).not.toContain("/credential");
    expect(text, `code off, QR on, ${door}: no code`).not.toContain(mint.publicCode);
  }
  // The code printed is enough, with or without its QR.
  await setDesign(comp.id, { code: true, qr: false });
  p = await postsFor(mint, holder.email);
  for (const [door, text] of Object.entries(p)) expect(text, `code on, QR off, ${door}`).toContain(link);

  // Back to inheriting the default: the link returns (the design is live).
  await setDesign(comp.id, null);
  p = await postsFor(mint, holder.email);
  for (const [door, text] of Object.entries(p)) expect(text, `design cleared, ${door}`).toContain(link);
});
