// @ts-check
//
// A HELD CERTIFICATE, for specs about what its holder meets: an ended event
// where `holder` solved the only challenge (1st place) and `other` did not, and
// `holder` collected the certificate through the real mint. Plus a one-time
// LinkedIn share link for it, minted (and, when asked, spent) by
// lib/certificate-share.js itself against the test server's database: only the
// congratulations email mints one in the app, and that needs a mail relay.
//
// Takes `expect` from @playwright/test, never ./isolated-test (whose import
// registers the per-file hooks).
const { expect } = require("@playwright/test");
const Database = require("better-sqlite3");
const { apiLogin, TEST_DB_PATH, gradingHashFor } = require("./helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");

async function heldCertificate(label) {
  const { api: sa, csrf } = await apiLogin("superadmin");
  let comp, task, holder, other;
  try {
    comp = await makeCompetition(sa, csrf, label);
    task = await makeTask(sa, csrf, label);
    await assignTask(sa, csrf, task.id, [comp.id]);
    holder = await makeParticipant(sa, csrf, `${label}h`);
    other = await makeParticipant(sa, csrf, `${label}o`);
    await enrol(sa, csrf, comp.id, [holder.id, other.id]);
  } catch (e) { await sa.dispose(); throw e; }
  const { api: pa, csrf: pc } = await apiLogin(holder.email);
  let mint;
  try {
    expect((await pa.post("/api/select-competition", { headers: H(pc), data: { competitionId: comp.id } })).ok()).toBeTruthy();
    const sub = await pa.post(`/api/tasks/${task.id}/submit`, { headers: { ...H(pc), "x-competition-id": comp.id }, data: { answer: "a", gradingHash: await gradingHashFor(pa, task.id) } });
    expect((await sub.json()).correct, "PRECONDITION: the holder solved it").toBe(true);
    const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(csrf) });
    expect(end.ok(), `end-now: ${await end.text()}`).toBeTruthy();
    const m = await pa.post(`/api/competitions/${comp.id}/badge`, { headers: H(pc) });
    expect(m.ok(), `mint: ${m.status()} ${await m.text()}`).toBeTruthy();
    mint = await m.json();
    // The ended popup would cover the page for a browser arm.
    await pa.post("/api/dismiss-ended", { headers: H(pc) });
  } finally { await pa.dispose(); await sa.dispose(); }
  return { comp, task, holder, other, mint };
}

/** A share link for `badgeToken`; `used` spends it. Returns the link token. */
function shareLink(badgeToken, { used = false } = {}) {
  // Required here, not at load: lib/certificate-share is pure (it takes `db`),
  // and is handed the SERVER's database, never the worker's own.
  const { mintShareLink, consumeShareLink } = require("../lib/certificate-share");
  const db = new Database(TEST_DB_PATH);
  try {
    const link = mintShareLink(db, badgeToken);
    if (used) expect(consumeShareLink(db, link), "PRECONDITION: the link was spent").toBe(true);
    return link;
  } finally { db.close(); }
}

module.exports = { heldCertificate, shareLink };
