// @ts-check
//
// A GOLD, SILVER OR BRONZE CERTIFICATE NEEDS POINTS ABOVE ZERO (operator ruling,
// 14 Nov 2026). A top-three attempter on zero or less is issued participation;
// the podium cards still show whoever holds places 1-3, and the top-three
// download follows the certificates.
//
// One board per test, built through the real submit door:
//   1st  +50  one correct answer
//   2nd    0  ten wrong answers (-5 each), then one correct (+50): the boundary
//   3rd   -5  one wrong answer
// The rule is lib/badge.js `earnsPlacement`, read by the mint's verdict
// (routes/badge.js `_mintEligibility`) and so by the participant's own mint,
// the automatic issue and the download's podium.
const { test, expect } = require("./isolated-test");
const { apiLogin, freshCtx, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol } = require("./event-admin-helpers");
const LE = require("./late-entry-fixture");

/** Sign in as `who`, enter `comp`, and submit each answer to `task` in turn. */
async function answer(who, comp, task, answers) {
  const p = await apiLogin(who.email, PARTICIPANT_PASS);
  try {
    expect((await p.api.post("/api/select-competition", { headers: H(p.csrf), data: { competitionId: comp.id } })).ok()).toBeTruthy();
    const view = await (await p.api.get(`/api/tasks/${task.id}`, { headers: { "x-competition-id": comp.id } })).json();
    for (const a of answers) {
      const s = await p.api.post(`/api/tasks/${task.id}/submit`, {
        headers: { ...H(p.csrf), "x-competition-id": comp.id }, data: { answer: a, gradingHash: view.grading_hash },
      });
      expect(s.ok(), `submit "${a}": ${await s.text()}`).toBeTruthy();
      const d = await s.json();
      expect(d.refused, `"${a}" was graded, not refused`).toBeUndefined();
    }
  } finally { await p.api.dispose(); }
}

const WRONG_TEN = Array.from({ length: 10 }, (_, i) => `wrong-${i}`);

/** The board above, on a fresh ended tournament. */
async function podiumOnZero(sa, saCsrf, label) {
  const comp = await makeCompetition(sa, saCsrf, label);
  // Two challenges, and nobody solves both: the all-solved auto-end cannot fire.
  const a = await makeTask(sa, saCsrf, `${label}-a`, { correct_answer: "yes" });
  const b = await makeTask(sa, saCsrf, `${label}-b`, { correct_answer: "yes" });
  await assignTask(sa, saCsrf, a.id, [comp.id]);
  await assignTask(sa, saCsrf, b.id, [comp.id]);
  const top = await makeParticipant(sa, saCsrf, `${label}-top`);
  const zero = await makeParticipant(sa, saCsrf, `${label}-zero`);
  const neg = await makeParticipant(sa, saCsrf, `${label}-neg`);
  await enrol(sa, saCsrf, comp.id, [top.id, zero.id, neg.id]);
  await answer(top, comp, a, ["yes"]);
  await answer(zero, comp, b, [...WRONG_TEN, "yes"]);
  await answer(neg, comp, a, ["nope"]);
  const end = await sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(saCsrf), data: {} });
  expect(end.ok(), await end.text()).toBeTruthy();
  // PRECONDITION: the three hold places 1-3 on the final board, at +50, 0 and -5.
  const board = await (await sa.get(`/api/admin/leaderboard?competitionId=${comp.id}`)).json();
  const at = (u) => board.find(r => r.userId === u.id) || {};
  expect([at(top), at(zero), at(neg)].map(r => [r.rank, r.score]), JSON.stringify(board))
    .toEqual([[1, 50], [2, 0], [3, -5]]);
  return { comp, top, zero, neg };
}

async function mint(who, comp) {
  const p = await apiLogin(who.email, PARTICIPANT_PASS);
  try {
    const r = await p.api.post(`/api/competitions/${comp.id}/badge`, { headers: H(p.csrf), data: {} });
    return { status: r.status(), body: await r.json() };
  } finally { await p.api.dispose(); }
}

test.describe("a medal certificate needs points above zero", () => {
  test("the participant's own mint: the top three on zero or less are issued participation, the scorer the medal", async () => {
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const f = await podiumOnZero(sa, csrf, "pp-mint");
      // The offer agrees with the mint before anyone clicks.
      const z = await apiLogin(f.zero.email, PARTICIPANT_PASS);
      try {
        const sel = await z.api.post("/api/select-competition", { headers: H(z.csrf), data: { competitionId: f.comp.id } });
        expect(sel.ok(), `select the ended event: ${await sel.text()}`).toBeTruthy();
        const lb = await (await z.api.get("/api/leaderboard", { headers: { "x-competition-id": f.comp.id } })).json();
        expect(lb.me && lb.me.rank, "the zero-point attempter really is 2nd on the participant board").toBe(2);
        expect(lb.canShareBadge, "they attempted, so a certificate is offered").toBe(true);
        expect(lb.top3.map(r => r.userId), "the podium cards still show whoever holds places 1-3")
          .toEqual([f.top.id, f.zero.id, f.neg.id]);
      } finally { await z.api.dispose(); }

      const top = await mint(f.top, f.comp);
      expect(top.status, JSON.stringify(top.body)).toBe(200);
      expect(top.body.placement, "CONTROL: points above zero earn the medal").toBe(true);
      expect(top.body.basis).toBe("placement");
      expect(top.body.rankLabel).toBe("1st Place");
      for (const [who, why] of [[f.zero, "exactly zero"], [f.neg, "below zero"]]) {
        const m = await mint(who, f.comp);
        expect(m.status, `${why}: ${JSON.stringify(m.body)}`).toBe(200);
        expect(m.body.placement, `${why}: no placing`).toBe(false);
        expect(m.body.basis, `${why}: participation`).toBe("participation");
        expect(m.body.rankLabel, `${why}: labelled as taking part`).toBe("Participant");
      }
    } finally { await sa.dispose(); }
  });

  test("the automatic issue and the top-three download follow: one Gold, two participation, one file", async () => {
    test.setTimeout(90_000);
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const f = await podiumOnZero(sa, csrf, "pp-auto");
      const tick = await sa.post("/api/test/certificate-dispatch-tick", { headers: H(csrf), data: { force: true } });
      expect(tick.ok(), await tick.text()).toBeTruthy();
      const list = await (await sa.get(`/api/admin/competitions/${f.comp.id}/certificates`)).json();
      const tier = (u) => (list.certificates.find(c => c.userId === u.id) || {}).tier;
      expect(list.certificates.length, JSON.stringify(list.certificates)).toBe(3);
      expect(tier(f.top), "the scorer: Gold").toBe("gold");
      expect(tier(f.zero), "2nd on zero: participation").toBe("participation");
      expect(tier(f.neg), "3rd on -5: participation").toBe("participation");

      const r = await sa.get(`/api/admin/competitions/${f.comp.id}/certificates/top3.zip`);
      expect(r.status(), await r.text().catch(() => "")).toBe(200);
      expect(r.headers()["x-top3-count"], "only the one medal certificate").toBe("1");
      expect(r.headers()["x-top3-missing"], "no place is missing: 2nd and 3rd earn no medal").toBeUndefined();
    } finally { await sa.dispose(); }
  });

  // OPERATOR RULING, 14 Nov 2026: a Gold, Silver or Bronze certificate already
  // issued to a top-three place on zero points or fewer keeps its medal; only new
  // ones follow the points-above-zero rule (a superadmin can revoke any). What a
  // certificate attests is its FROZEN basis, never the score beside it, on every
  // surface: the holder's list, the organisers' list, /credential, the artwork
  // and the top-three download.
  test("a medal certificate already issued on zero points keeps its medal", async () => {
    test.setTimeout(90_000);
    const { api: sa, csrf } = await apiLogin("superadmin");
    try {
      const f = await podiumOnZero(sa, csrf, "pp-keep");
      const top = await mint(f.top, f.comp);
      const zero = await mint(f.zero, f.comp);
      expect(zero.body.basis, "PRECONDITION: a certificate minted now on zero points is participation").toBe("participation");
      // The artwork, by the share card: it is drawn from the same resolver as the
      // certificate and, unlike the PDF, carries no title naming the tier, so a
      // change in it is a change in what is drawn.
      const card = async () => {
        const { api: anon } = await freshCtx();
        try {
          const r = await anon.get(`/badge/${zero.body.token}/badge.png`);
          expect(r.status()).toBe(200);
          return require("crypto").createHash("sha256").update(await r.body()).digest("hex");
        } finally { await anon.dispose(); }
      };
      const participationCard = await card();
      expect(await card(), "PRECONDITION: the card renders byte-identically twice").toBe(participationCard);
      // The certificate a mint before the rule issued for this place: a placing,
      // with the zero score frozen beside it.
      const Database = require("better-sqlite3");
      const db = new Database(TEST_DB_PATH);
      try {
        const r = db.prepare("UPDATE achievement_badges SET basis='placement', score_snapshot=0 WHERE token=?").run(zero.body.token);
        expect(r.changes, "the earlier issue was written").toBe(1);
      } finally { db.close(); }

      const z = await apiLogin(f.zero.email, PARTICIPANT_PASS);
      try {
        const held = ((await (await z.api.get("/api/me/certificates")).json()).certificates || []).find(c => c.competitionId === f.comp.id);
        expect(held && [held.tier, held.label, held.score], JSON.stringify(held)).toEqual(["silver", "2nd Place", 0]);
      } finally { await z.api.dispose(); }
      const list = await (await sa.get(`/api/admin/competitions/${f.comp.id}/certificates`)).json();
      expect((list.certificates.find(c => c.userId === f.zero.id) || {}).tier, "the organisers' list").toBe("silver");
      const { api: anon } = await freshCtx();
      try {
        const v = await (await anon.post("/credential", { headers: { "content-type": "application/json", accept: "application/json" },
          data: { code: zero.body.publicCode, surname: "pp-keep-zero" } })).json();
        expect(v.found, JSON.stringify(v)).toBe(true);
        expect([v.basis, v.label], "/credential confirms the medal").toEqual(["placement", "2nd Place"]);
      } finally { await anon.dispose(); }
      expect(await card(), "the artwork is the medal certificate, not the participation one").not.toBe(participationCard);
      const r = await sa.get(`/api/admin/competitions/${f.comp.id}/certificates/top3.zip`);
      expect(r.status(), await r.text().catch(() => "")).toBe(200);
      expect(r.headers()["x-top3-count"], "the download holds both medal certificates").toBe("2");
      // CONTROL: the scorer's medal was issued under the rule itself.
      expect(top.body.basis).toBe("placement");
    } finally { await sa.dispose(); }
  });

  // The OFFER: while a late entrant's window is open the claimable list says
  // whether a placing is pending once it closes. A place on the late board with a
  // wrong answer (-5) has none pending; the scorer ahead of them does.
  test("the late entrants' offer: a placing is pending only for a top-three place with points above zero", async () => {
    const { api, csrf } = await LE.sa();
    const people = [];
    try {
      const { comp, taskIds } = await LE.liveBooth(api, csrf, { tasks: 2 });
      const scorer = await LE.makeParticipant(api, csrf, LE.uniq());
      const wrong = await LE.makeParticipant(api, csrf, LE.uniq());
      for (const u of [scorer, wrong]) await LE.enrol(api, csrf, comp.id, u.id);
      const end = await LE.expireEvent(comp.id);
      for (const u of [scorer, wrong]) LE.rawSetAssignedAt(comp.id, u.id, new Date(end.getTime() + 5 * 60_000).toISOString());
      const sc = await LE.participantCtx(scorer.email, comp.id); people.push(sc);
      const wr = await LE.participantCtx(wrong.email, comp.id); people.push(wr);
      expect((await (await LE.submit(sc.api, sc.csrf, taskIds[0])).json()).correct, "the scorer solves one").toBe(true);
      expect((await (await LE.submit(wr.api, wr.csrf, taskIds[0], "nope")).json()).correct, "the other answers wrong").toBe(false);
      const offerOf = async (ctx) => {
        const certs = await (await ctx.api.get("/api/me/certificates")).json();
        return (certs.claimable || []).find(c => c.competitionId === comp.id);
      };
      const o1 = await offerOf(sc), o2 = await offerOf(wr);
      expect(o1 && o1.lateEntrant, "PRECONDITION: the scorer is offered a late entrant's certificate").toBe(true);
      expect(o2 && o2.lateEntrant, "PRECONDITION: so is the one on -5").toBe(true);
      expect(o1.latePlacementPending, "CONTROL: 1st with points: a placing waits for the window to close").toBe(true);
      expect(o2.latePlacementPending, "2nd on -5: no placing will come").toBe(false);
    } finally { for (const x of people) await x.api.dispose(); await api.dispose(); }
  });
});
