// @ts-check
//
// A CERTIFICATE THE PARTICIPANT ASKED FOR IS NOT ISSUED IF, WHILE IT WAS BEING
// DRAWN, THEY WERE REMOVED FROM THE EVENT, SIGNED IN ELSEWHERE OR BLOCKED.
//
// "Get my certificate" (POST /api/competitions/:id/badge, routes/badge.js) is
// admitted when its HEADERS arrive (requireParticipant, the membership read),
// then awaits the badge render before it writes the certificate, its PNG and its
// live credential code. Its write re-asks, synchronously and in this order
// (sweep #48: the behavioural locks were lost with the password specs):
//   * `participantSessionDenied` — the ACCOUNT (blocked, denied, no longer
//     approved), then the session TOMBSTONE a sign-in elsewhere writes;
//   * the MEMBERSHIP the mint was admitted on.
// Each arm holds the mint in the test-only commit park (`testAdminCommitPark()`,
// right after the render; `parked()` acts only once the server reports the
// request inside it, bounded from the moment it entered), changes one thing
// there, and asserts the WHOLE answer, that no certificate, image or code was
// written, and what still works afterwards. The CONTROL is the same parked mint
// left untouched: it is issued, so each refusal is the change's, not the park's.
//
// The event is a Program: its completion certificate is minted while it runs,
// and a running event is the one an organiser may still remove somebody from
// (an ended one refuses every removal but a late entrant's).
const { test, expect } = require("./isolated-test");
const { apiLogin, gradingHashFor, PARTICIPANT_PASS } = require("./helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const { signIn, parked } = require("./admin-inflight-helpers");
const { SESSION_ENDED, dbGet, dbRun, tombstoned, ownSession, enter } = require("./participant-inflight-fixture");

const NOT_MEMBER = { error: "You are not a participant in this event." };

test.describe("a certificate mint held after its render is issued only to a member whose session and account still stand", () => {
  let sa, saCsrf;
  test.beforeAll(async () => { ({ api: sa, csrf: saCsrf } = await apiLogin("superadmin")); });
  test.afterAll(async () => { await sa?.dispose(); });

  /**
   * A running Program of one challenge, a member who solved it (so their
   * completion certificate is theirs to collect) and a bystander who did not.
   */
  async function completer(label) {
    const comp = await makeCompetition(sa, saCsrf, `${label}c`, {
      event_kind: "program", deadline_at: new Date(Date.now() + 30 * 86400e3).toISOString(), duration_minutes: undefined,
    });
    const task = await makeTask(sa, saCsrf, `${label}t`, { correct_answer: "k" });
    await assignTask(sa, saCsrf, task.id, [comp.id]);
    const by = await makeParticipant(sa, saCsrf, `${label}by`);
    await enrol(sa, saCsrf, comp.id, [by.id]);
    const v = await ownSession(sa, saCsrf, label, comp.id);
    await enter(v, comp.id);
    const sub = await v.api.post(`/api/tasks/${task.id}/submit`, { headers: H(v.csrf), data: { answer: "k", gradingHash: await gradingHashFor(v.api, task.id) } });
    expect(sub.ok(), `submit: ${sub.status()} ${await sub.text()}`).toBeTruthy();
    expect((await sub.json()).correct, "PRECONDITION: the member completed the Program").toBe(true);
    expect(dbGet("SELECT event_kind, ended_at FROM competitions WHERE id=?", comp.id), "PRECONDITION: a Program, still running")
      .toEqual({ event_kind: "program", ended_at: null });
    return { ...v, comp };
  }
  const mint = (v, api = v.api, csrf = v.csrf) => api.post(`/api/competitions/${v.comp.id}/badge`, { headers: H(csrf) });
  /** What the mint wrote for this member: certificates, their images, and the audit of a mint. */
  const written = (v) => ({
    badges: dbGet("SELECT COUNT(*) c FROM achievement_badges WHERE user_id=? AND competition_id=?", v.p.id, v.comp.id).c,
    images: dbGet("SELECT COUNT(*) c FROM images i JOIN achievement_badges b ON b.image_id=i.id WHERE b.user_id=?", v.p.id).c,
    minted: dbGet("SELECT COUNT(*) c FROM competition_events WHERE competition_id=? AND event_type='badge_minted' AND json_extract(details,'$.user_id')=?", v.comp.id, v.p.id).c,
  });
  const NOTHING = { badges: 0, images: 0, minted: 0 };
  async function send(v) {
    const r = await mint(v);
    const json = await r.json().catch(() => ({}));
    return { status: r.status(), json };
  }

  test("CONTROL: the same mint, held and left untouched, issues the certificate and its code", async () => {
    const v = await completer("pimk");
    try {
      const r = await parked(sa, () => send(v), null);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const row = dbGet("SELECT token, public_code, basis, revoked_at FROM achievement_badges WHERE user_id=? AND competition_id=?", v.p.id, v.comp.id);
      expect(row, "one completion certificate").toMatchObject({ basis: "completion", revoked_at: null });
      expect(r.json.token, "the answer carries the certificate it wrote").toBe(row.token);
      expect(r.json.publicCode, "…and its credential code").toBe(row.public_code);
      // A mint stores no image (sweep #43): every view renders the share image.
      expect(written(v)).toEqual({ badges: 1, images: 0, minted: 1 });
    } finally { await v.api.dispose(); }
  });

  test("REMOVED from the event while it was drawn: refused as no longer a member, nothing issued", async () => {
    const v = await completer("pimr");
    try {
      const r = await parked(sa, () => send(v), async () => {
        const d = await sa.delete(`/api/admin/competitions/${v.comp.id}/users/${v.p.id}`, { headers: H(saCsrf) });
        expect(d.ok(), `remove: ${d.status()} ${await d.text()}`).toBeTruthy();
        expect((await d.json()).removed, "the removal TOOK").toBe(true);
      }, 4000);
      expect(dbGet("SELECT 1 AS x FROM competition_users WHERE competition_id=? AND user_id=?", v.comp.id, v.p.id), "PRECONDITION: no longer a member").toBeUndefined();
      expect(tombstoned(v.sid), "PRECONDITION: the session itself still stands").toBe(false);
      expect(r.status, JSON.stringify(r.json)).toBe(403);
      expect(r.json, "refused for the membership, at commit").toEqual(NOT_MEMBER);
      expect(written(v), "no certificate, image or code").toEqual(NOTHING);
    } finally { await v.api.dispose(); }
  });

  test("SIGNED IN ELSEWHERE while it was drawn: refused as an ended session, nothing issued; the new session collects it", async () => {
    const v = await completer("pims");
    let other = null;
    try {
      const r = await parked(sa, () => send(v), async () => { other = await signIn(v.p.email, PARTICIPANT_PASS); });
      expect(tombstoned(v.sid), "PRECONDITION: the other sign-in ended this session").toBe(true);
      expect(dbGet("SELECT blocked, approved FROM users WHERE id=?", v.p.id), "PRECONDITION: the account itself still qualifies").toEqual({ blocked: 0, approved: 1 });
      expect(r.status, JSON.stringify(r.json)).toBe(401);
      expect(r.json).toEqual({ error: SESSION_ENDED, code: "session_ended" });
      expect(written(v), "no certificate, image or code").toEqual(NOTHING);
      // The account was never the problem: the session that replaced it collects.
      const again = await mint(v, other.api, other.csrf);
      expect(again.status(), await again.text()).toBe(200);
      expect(written(v).badges, "issued once, to the live session").toBe(1);
    } finally { await v.api.dispose(); if (other) await other.api.dispose(); }
  });

  test("BLOCKED while it was drawn (out of band, no tombstone): refused for the account, nothing issued; unblocked, the same session collects it", async () => {
    const v = await completer("pimb");
    try {
      const r = await parked(sa, () => send(v), async () => { dbRun("UPDATE users SET blocked=1 WHERE id=?", v.p.id); });
      // A direct block writes no tombstone, so only the account re-check can see it.
      expect(tombstoned(v.sid), "PRECONDITION: the session was not ended").toBe(false);
      expect(r.status, JSON.stringify(r.json)).toBe(403);
      expect(r.json).toEqual({ error: "Account is blocked" });
      expect(written(v), "no certificate, image or code").toEqual(NOTHING);
      dbRun("UPDATE users SET blocked=0 WHERE id=?", v.p.id);
      const again = await mint(v);
      expect(again.status(), `unblocked, the same session mints: ${await again.text()}`).toBe(200);
      expect(written(v).badges).toBe(1);
    } finally { await v.api.dispose(); }
  });
});
