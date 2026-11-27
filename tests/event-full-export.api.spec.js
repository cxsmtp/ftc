// @ts-check
//
// v8.15.0 — THE FULL EVENT EXPORT AND THE PERSON EXPORT.
//
// Why the fixture can fail:
//
//   * DECOY. The same participant (`inMine`) also plays the out-of-scope event
//     `theirs`, with a distinctive answer, and a second participant plays only
//     there. Every section binds the event id; with one event, dropping those
//     predicates would produce identical files. The decoy strings are asserted
//     ABSENT from the whole archive by value — and PRESENT in the superadmin's
//     person export (the control), so an export that showed nobody anything
//     would not pass.
//   * SEAL. The event admin AUTHORS a sealed challenge and the participant
//     submits its key. The superadmin's export must not carry the key anywhere
//     (they are not the author); the author's must (the control).
//   * FORMULA. A wrong answer is a spreadsheet formula; the CSV must carry it
//     apostrophised, beside an ordinary answer that is not.
//   * AUTO-END. Two participants in `mine`, one of whom does nothing, so the
//     all-solved auto-end cannot fire (fixture checklist item 1).
const { test, expect } = require("./isolated-test");
const { apiLogin, PARTICIPANT_PASS, TEST_DATA_DIR, gradingHashFor, findLogLine } = require("./helpers");
const { H, uniq, makeParticipant, makeTask, assignTask, enrol, buildWorld, makeCompetition, grantEventAdmin } = require("./event-admin-helpers");
const yauzl = require("yauzl");
const path = require("path");

/** Every entry of a ZIP buffer as { name: text }. */
function unzip(buf) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = {};
      zip.on("entry", (e) => {
        zip.openReadStream(e, (e2, s) => {
          if (e2) return reject(e2);
          const parts = [];
          s.on("data", (d) => parts.push(d));
          s.on("end", () => { out[e.fileName] = Buffer.concat(parts).toString("utf8"); zip.readEntry(); });
        });
      });
      zip.on("end", () => resolve(out));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/**
 * Every entry's CRC-32, checked against its decompressed bytes. yauzl compares
 * no data CRC itself, so this reads both copies the writer stores (the central
 * directory's, which yauzl reports, and the local header's at +14) against
 * zlib's own crc32, independent of lib/zip-writer.js's table. Rejects on the
 * first mismatch, naming the entry.
 */
function crcCheck(buf) {
  const { crc32 } = require("zlib");
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      let n = 0;
      zip.on("entry", (e) => {
        zip.openReadStream(e, (e2, s) => {
          if (e2) return reject(e2);
          const parts = [];
          s.on("data", (d) => parts.push(d));
          s.on("error", reject);
          s.on("end", () => {
            const got = crc32(Buffer.concat(parts)) >>> 0;
            const local = buf.readUInt32LE(e.relativeOffsetOfLocalHeader + 14);
            if (got !== e.crc32) return reject(new Error(`crc mismatch in the central directory for ${e.fileName}: ${e.crc32} != ${got}`));
            if (local !== got) return reject(new Error(`crc mismatch in the local header for ${e.fileName}: ${local} != ${got}`));
            n++;
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(n));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/** A fully quoted CSV (lib/csv.js always quotes) → rows of cells. */
function parseCsv(text) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { if (c === '"') { if (body[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const objects = (text) => { const r = parseCsv(text); return r.slice(1).map(x => Object.fromEntries(r[0].map((h, i) => [h, x[i]]))); };

let W, F;
test.beforeAll(async () => {
  W = await buildWorld();
  const { sa, saCsrf, eaApi, eaCsrf, mine, theirs, inMine, inTheirs } = W;
  const tag = uniq("x").replace(/[^a-zA-Z0-9]/g, "");
  const plain = await makeTask(sa, saCsrf, "fx-plain", { correct_answer: "rightanswer", hint: "a hint" });
  await assignTask(sa, saCsrf, plain.id, [mine.id, theirs.id]);
  const sealedKey = `SEALKEY${tag}`;
  const sealed = await makeTask(eaApi, eaCsrf, "fx-sealed", { correct_answer: sealedKey, answer_sealed: true });
  await assignTask(eaApi, eaCsrf, sealed.id, [mine.id]);
  const idle = await makeParticipant(sa, saCsrf, "fx-idle");
  await enrol(sa, saCsrf, mine.id, [idle.id]);
  await enrol(sa, saCsrf, theirs.id, [inMine.id]);

  const play = async (who, compId, fn) => {
    const l = await apiLogin(who.email, PARTICIPANT_PASS);
    try {
      const sel = await l.api.post("/api/select-competition", { headers: H(l.csrf), data: { competitionId: compId } });
      expect(sel.status(), await sel.text()).toBe(200);
      const hh = { ...H(l.csrf), "x-competition-id": compId };
      const submit = async (taskId, answer, correct) => {
        const r = await l.api.post(`/api/tasks/${taskId}/submit`, { headers: hh, data: { answer, gradingHash: await gradingHashFor(l.api, taskId) } });
        expect(r.status(), await r.text()).toBe(200);
        expect((await r.json()).correct, `${answer}`).toBe(correct);
      };
      await fn({ submit, api: l.api, hh });
    } finally { await l.api.dispose(); }
  };
  const formula = `=HYPERLINK("http://evil.example","x${tag}")`;
  await play(inMine, mine.id, async ({ submit, api, hh }) => {
    await submit(plain.id, formula, false);
    const h = await api.post(`/api/tasks/${plain.id}/hint`, { headers: hh });
    expect(h.status(), await h.text()).toBe(200);
    await submit(plain.id, "rightanswer", true);
    await submit(sealed.id, sealedKey, true);
    const fb = await api.put(`/api/tasks/${plain.id}/feedback`, { headers: hh, data: { rating: 4 } });
    expect(fb.status(), await fb.text()).toBe(200);
  });
  const decoy = `DECOYMINE${tag}`, decoyOther = `DECOYTHEIRS${tag}`;
  await play(inMine, theirs.id, async ({ submit }) => { await submit(plain.id, decoy, false); });
  await play(inTheirs, theirs.id, async ({ submit }) => { await submit(plain.id, decoyOther, false); });
  F = { plain, sealed, sealedKey, idle, formula, decoy, decoyOther };
});
test.afterAll(async () => {
  for (const a of [W && W.sa, W && W.eaApi, W && W.zeroApi]) { try { await a.dispose(); } catch (_) {} }
});

const EVENT_URL = (id, q = "") => `/api/admin/competitions/${id}/export/full${q}`;
const PERSON_URL = (id, q = "") => `/api/admin/participants/${id}/export/full${q}`;

test.describe("v8.15.0 — full event export", () => {
  test("every section is present, scoped to the event, with sealed answers withheld and formulas neutralised", async () => {
    const { sa, mine, theirs, inMine, inTheirs } = W;
    const r = await sa.get(EVENT_URL(mine.id));
    expect(r.status(), await r.text()).toBe(200);
    expect(r.headers()["content-type"]).toContain("application/zip");
    expect(r.headers()["content-disposition"]).toMatch(/attachment; filename=".*-full-export-\d{4}-\d{2}-\d{2}\.zip"/);
    const files = await unzip(await r.body());
    expect(Object.keys(files).sort()).toEqual([
      "README.txt", "certificates.csv", "challenges.csv", "event.csv", "feedback.csv", "hints.csv", "navigation.csv",
      "participants.csv", "rankings-groups.csv", "rankings-late.csv", "rankings-main.csv", "submissions.csv", "time.csv",
    ]);
    const all = Object.values(files).join("\n");

    const people = objects(files["participants.csv"]);
    expect(people.map(p => p.Email).sort()).toEqual([inMine.email, F.idle.email].sort());
    // Headers are the UI's own labels (the dialogs' Salutation and Work Title),
    // never a schema name; the email column above is the control that the
    // header row was read at all.
    const heads = Object.keys(people[0]);
    expect(heads).toEqual(expect.arrayContaining(["Salutation", "Work Title", "Job Function"]));
    expect(heads, "no schema-era header").not.toContain("Personal Title");
    expect(heads, "no bare 'Title'").not.toContain("Title");
    expect(all, "the decoy participant is absent").not.toContain(inTheirs.email);

    const subs = objects(files["submissions.csv"]).filter(s => s["User ID"] === inMine.id);
    expect(subs.length, "every submission row in THIS event").toBe(3);
    const plainSubs = subs.filter(s => s["Challenge Ref"] === F.plain.id);
    expect(plainSubs.map(s => [s["Attempt Number"], s.Correct])).toEqual([["1", "No"], ["2", "Yes"]]);
    expect(plainSubs[0].Answer, "a formula answer is apostrophised").toBe("'" + F.formula);
    expect(plainSubs[1].Answer, "an ordinary answer is verbatim (the control)").toBe("rightanswer");
    // lib/csv.js neutralises EVERY cell that opens with a trigger, numbers included.
    expect(plainSubs[0]["Points Delta"]).toBe("'-5");
    const sealedRow = subs.find(s => s["Challenge Ref"] === F.sealed.id);
    expect(sealedRow.Answer).toMatch(/^\(sealed/);
    expect(all, "the sealed key is nowhere in a non-author's export").not.toContain(F.sealedKey);
    for (const d of [F.decoy, F.decoyOther, theirs.name]) expect(all, `decoy ${d}`).not.toContain(d);

    const hints = objects(files["hints.csv"]);
    expect(hints.map(h => [h["User ID"], h["Challenge Ref"]])).toEqual([[inMine.id, F.plain.id]]);
    expect(objects(files["feedback.csv"]).map(f => [f["User ID"], f.Rating])).toEqual([[inMine.id, "4"]]);
    const main = objects(files["rankings-main.csv"]);
    const mrow = main.find(x => x["User ID"] === inMine.id);
    expect(mrow, "the participant is on the main board").toBeTruthy();
    expect(mrow.Rank).toBe("1");
    expect(Number(mrow.Score)).toBeGreaterThan(0);
    expect(mrow["Incorrect Submissions"]).toBe("1");
    expect(mrow["Hints Taken"]).toBe("1");
    expect(objects(files["time.csv"]).find(x => x["User ID"] === inMine.id)["Solve Clock Start"], "the solve clock started").not.toBe("");
    expect(objects(files["challenges.csv"]).map(c => c["Challenge Ref"]).sort()).toEqual([F.plain.id, F.sealed.id].sort());
    expect(all, "no answer KEY of the plain challenge either").not.toMatch(/Correct Answer/);

    // Audited, by the request's own id.
    const reqId = r.headers()["x-request-id"];
    const line = await findLogLine(path.join(TEST_DATA_DIR, "logs"),
      (j) => j.source === "audit" && j.scope === "export" && j.scope_id === "competition-full" && j.event_type === "data_exported" && j.details && j.details.req_id === reqId,
      { what: `the competition-full data_exported line for ${reqId}` });
    expect(line.details.competition_id).toBe(mine.id);
    expect(line.details.ip).toBeTruthy();
    expect(line.details.sealed_answers_withheld).toBe(1);
  });

  test("the author of a sealed challenge sees its answers in their export", async () => {
    const r = await W.eaApi.get(EVENT_URL(W.mine.id));
    expect(r.status(), await r.text()).toBe(200);
    const files = await unzip(await r.body());
    const row = objects(files["submissions.csv"]).find(s => s["Challenge Ref"] === F.sealed.id);
    expect(row.Answer).toBe(F.sealedKey);
  });

  test("a superadmin who revealed the sealed challenge reads its answers in both exports; before the reveal, withheld (CONTROL); once they compete in an event holding it, withheld again", async () => {
    // A user-backed superadmin on its own session: the reveal lasts the session,
    // and a second built-in sign-in would end the world's own.
    const { sa, saCsrf, mine, inMine } = W;
    const boss = await makeParticipant(sa, saCsrf, "fxboss");
    const pr = await sa.post(`/api/admin/participants/${boss.id}/role`, { headers: H(saCsrf), data: { role: "superadmin" } });
    expect(pr.ok(), `promote: ${await pr.text()}`).toBeTruthy();
    const b = await apiLogin(boss.email, PARTICIPANT_PASS);
    try {
      const sealedAnswer = async () => {
        const r = await b.api.get(EVENT_URL(mine.id));
        expect(r.status(), (await r.text()).slice(0, 300)).toBe(200);
        return objects((await unzip(await r.body()))["submissions.csv"]).find(s => s["Challenge Ref"] === F.sealed.id).Answer;
      };
      const personText = async () => {
        const r = await b.api.get(PERSON_URL(inMine.id));
        expect(r.status(), (await r.text()).slice(0, 300)).toBe(200);
        return JSON.stringify(await r.json());
      };
      expect(await sealedAnswer(), "CONTROL: before the reveal the key is withheld").toMatch(/^\(sealed/);
      expect(await personText(), "CONTROL: …from the person export too").not.toContain(F.sealedKey);
      const rv = await b.api.post(`/api/admin/tasks/${F.sealed.id}/sealed-reveal`, { headers: H(b.csrf) });
      expect(rv.status(), await rv.text()).toBe(200);
      expect(await sealedAnswer(), "the revealed superadmin reads the submitted key").toBe(F.sealedKey);
      expect(await personText(), "…and in the person export").toContain(F.sealedKey);
      // A reveal never widens a competitor: once boss competes in an event that
      // holds the challenge, the same session (which just read the key: the
      // control) is withheld it again in both exports.
      const X = await makeCompetition(sa, saCsrf, "fxcompete", { duration_minutes: 120, staff_compete: true });
      await grantEventAdmin(sa, saCsrf, X.id, W.ea.id);
      await assignTask(W.eaApi, W.eaCsrf, F.sealed.id, [X.id]);
      await enrol(sa, saCsrf, X.id, [boss.id]);
      expect(await sealedAnswer(), "a reveal never widens a competitor: withheld again in the event export").toMatch(/^\(sealed/);
      expect(await personText(), "…and in the person export").not.toContain(F.sealedKey);
    } finally { await b.api.dispose(); }
  });

  test("scope and format refusals", async () => {
    const { eaApi, zeroApi, sa, mine, theirs } = W;
    const a = await eaApi.get(EVENT_URL(theirs.id));
    expect(a.status()).toBe(403);
    expect((await a.json()).code).toBe("event_admin_out_of_scope");
    const z = await zeroApi.get(EVENT_URL(mine.id));
    expect(z.status()).toBe(403);
    const x = await sa.get(EVENT_URL(mine.id, "?format=xlsx"));
    expect(x.status()).toBe(400);
    expect((await x.json()).code).toBe("export_format_unsupported");
    expect((await sa.get(EVENT_URL("00000000-0000-4000-8000-000000000000"))).status()).toBe(404);
  });

  test("an admin competing in the event is refused its full export but keeps Export Activity; an admin who does not compete downloads it (CONTROL)", async () => {
    // The file holds every rival's answers and standing (routes/export-import.js).
    // The world's own superadmin session: a second built-in sign-in would end it.
    const { sa, saCsrf } = W;
    {
      const comp = await makeCompetition(sa, saCsrf, "fx-compete", { staff_compete: true });
      const competitor = await makeParticipant(sa, saCsrf, "fxcomp");
      const bystander = await makeParticipant(sa, saCsrf, "fxby");
      await enrol(sa, saCsrf, comp.id, [competitor.id]);
      for (const u of [competitor, bystander]) {
        const r = await sa.post(`/api/admin/participants/${u.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
        expect(r.ok(), `make admin: ${await r.text()}`).toBeTruthy();
      }
      const c = await apiLogin(competitor.email, PARTICIPANT_PASS);
      const b = await apiLogin(bystander.email, PARTICIPANT_PASS);
      try {
        const refused = await c.api.get(EVENT_URL(comp.id));
        expect(refused.status(), (await refused.text()).slice(0, 300)).toBe(403);
        expect((await refused.json()).code).toBe("competitor_cannot_edit");
        // …while Export Activity stays theirs, as the event-admin guide says: it is
        // one of the reads the competitor lock leaves (ROLES_AND_PERMISSIONS.md §6).
        const activity = await c.api.get(`/api/admin/export/competition-activity?competitionId=${encodeURIComponent(comp.id)}`);
        expect(activity.status(), (await activity.text()).slice(0, 300)).toBe(200);
        expect(activity.headers()["content-type"]).toMatch(/text\/csv/);
        const ok = await b.api.get(EVENT_URL(comp.id));
        expect(ok.status(), (await ok.text()).slice(0, 300)).toBe(200);
        expect(ok.headers()["content-type"]).toMatch(/application\/zip/);
      } finally { await c.api.dispose(); await b.api.dispose(); }
    }
  });

  test("both exports price a qualifying question at the 0 points it scores; a scoring challenge keeps its worth (CONTROL)", async () => {
    const { sa, saCsrf } = W;
    const comp = await makeCompetition(sa, saCsrf, "fx-qual", { add_qualifying: true });
    const scored = await makeTask(sa, saCsrf, "fxqualscored");
    await assignTask(sa, saCsrf, scored.id, [comp.id]);
    const p = await makeParticipant(sa, saCsrf, "fxqual");
    await enrol(sa, saCsrf, comp.id, [p.id]);
    const r = await sa.get(EVENT_URL(comp.id));
    expect(r.status(), (await r.text()).slice(0, 300)).toBe(200);
    const ch = objects((await unzip(await r.body()))["challenges.csv"]);
    const qIds = (() => {
      const db = new (require("better-sqlite3"))(require("./helpers").TEST_DB_PATH, { readonly: true });
      try {
        return new Set(db.prepare("SELECT ct.task_id FROM competition_tasks ct JOIN task_tags tg ON tg.task_id=ct.task_id AND tg.tag LIKE 'qualifying:%' WHERE ct.competition_id=?").all(comp.id).map(x => x.task_id));
      } finally { db.close(); }
    })();
    // "Challenge Ref" is the challenge's id; "Challenge ID" is its number in the event.
    const qual = ch.filter(x => qIds.has(x["Challenge Ref"]));
    expect(qual.length, `PRECONDITION: the four qualifying questions: ${ch.map(x => x.Challenge).join(" | ")}`).toBe(4);
    for (const x of qual) expect(x.Points, `challenges.csv: ${x.Challenge}`).toBe("0");
    expect(ch.find(x => x["Challenge Ref"] === scored.id).Points, "CONTROL: an easy challenge is worth 50").toBe("50");
    const act = await sa.get(`/api/admin/export/competition-activity?competitionId=${encodeURIComponent(comp.id)}`);
    expect(act.status(), (await act.text()).slice(0, 300)).toBe(200);
    const rows = objects((await act.text()).replace(/^\uFEFF/, ""));
    const byChallenge = new Map(rows.map(x => [x.Challenge, x.Points]));   // by title: this file carries no id
    expect(byChallenge.size, "one row per challenge for the one participant").toBe(ch.length);
    for (const x of qual) expect(byChallenge.get(x.Challenge), `activity CSV: ${x.Challenge}`).toBe("0");
    expect(byChallenge.get(scored.title), "CONTROL").toBe("50");
  });
});

test.describe("v8.15.0 — person export", () => {
  test("a global admin gets the whole history (the control for the scoped arm)", async () => {
    const { sa, inMine, theirs, mine } = W;
    const r = await sa.get(PERSON_URL(inMine.id));
    expect(r.status(), await r.text()).toBe(200);
    expect(r.headers()["content-disposition"]).toMatch(/attachment; filename=".*-person-export-.*\.json"/);
    const d = await r.json();
    expect(d.profile.email).toBe(inMine.email);
    expect(d.scoped_to_your_events).toBe(false);
    expect(d.memberships.map(m => m.competition_id).sort()).toEqual([mine.id, theirs.id].sort());
    const text = JSON.stringify(d);
    expect(text, "the out-of-scope event's answer is in the unscoped export").toContain(F.decoy);
    expect(text, "…and its name").toContain(theirs.name);
    expect(text, "not the author: the sealed key is withheld").not.toContain(F.sealedKey);
    expect(d.submissions.length).toBe(4);
    expect(d.hints.length).toBe(1);
    expect(d.feedback.map(f => f.rating)).toEqual([4]);
    expect(d.events.length, "the audit history about them").toBeGreaterThan(0);
    expect(d.emails, "an emails section exists").toBeDefined();
    for (const k of ["password_hash", "verify_code", "reset_code", "login_code_hash", "linkedin_sub", "pending_email_code"]) {
      expect(Object.keys(d.profile), `no ${k}`).not.toContain(k);
    }
  });

  test("an event admin's person export is narrowed to their events, by value", async () => {
    const { eaApi, inMine, theirs, mine } = W;
    const r = await eaApi.get(PERSON_URL(inMine.id));
    expect(r.status(), await r.text()).toBe(200);
    const d = await r.json();
    expect(d.scoped_to_your_events).toBe(true);
    expect(d.memberships.map(m => m.competition_id)).toEqual([mine.id]);
    const text = JSON.stringify(d);
    for (const v of [F.decoy, theirs.id, theirs.name]) expect(text, `out-of-scope ${v} is absent`).not.toContain(v);
    expect(d.submissions.length).toBe(3);
    expect(text, "the author reads their own sealed key").toContain(F.sealedKey);
    // The zip variant carries the same narrowing and neutralises formulas.
    const z = await eaApi.get(PERSON_URL(inMine.id, "?format=zip-csv"));
    expect(z.status()).toBe(200);
    const files = await unzip(await z.body());
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["profile.csv", "memberships.csv", "absences.csv", "submissions.csv", "hints.csv", "history.csv", "certificates.csv", "feedback.csv", "invitations.csv", "groups.csv"]));
    const zall = Object.values(files).join("\n");
    expect(zall).not.toContain(F.decoy);
    expect(objects(files["submissions.csv"]).map(s => s.Answer)).toContain("'" + F.formula);
    // profile.csv names each field as the UI does, never by its column.
    const prof = objects(files["profile.csv"]);
    const fields = prof.map(r => r.Field);
    expect(fields).toEqual(expect.arrayContaining(["Salutation", "Work Title", "Job Function", "Tags", "User ID"]));
    expect(fields.filter(f => /_|^[a-z]/.test(f)), "no schema name leaks into the Field column").toEqual([]);
    expect(Object.keys(d.profile).length, "PRECONDITION: one row per profile key").toBe(fields.length);
    expect(prof.find(r => r.Field === "Email").Value, "CONTROL: the labelled row carries its value").toBe(inMine.email);
  });

  test("an event admin is refused someone outside their events; the export is audited", async () => {
    const { eaApi, sa, inTheirs, inMine } = W;
    const r = await eaApi.get(PERSON_URL(inTheirs.id));
    expect(r.status()).toBe(403);
    expect((await r.json()).code).toBe("event_admin_out_of_scope");
    expect((await sa.get(PERSON_URL("00000000-0000-4000-8000-000000000000"))).status()).toBe(404);
    expect((await sa.get(PERSON_URL(inMine.id, "?format=pdf"))).status()).toBe(400);
    const ok = await sa.get(PERSON_URL(inMine.id));
    const reqId = ok.headers()["x-request-id"];
    const line = await findLogLine(path.join(TEST_DATA_DIR, "logs"),
      (j) => j.source === "audit" && j.scope === "export" && j.scope_id === "person-full" && j.details && j.details.req_id === reqId,
      { what: `the person-full data_exported line for ${reqId}` });
    expect(line.details.user_id).toBe(inMine.id);
  });

  // SWEEP #233 (operator ruling, 24 Nov 2026): an admin competing in an event MAY
  // export a rival's person export. It is a read, like Export Activity, which
  // already gives every rival's activity, and an event where staff compete holds
  // sealed challenges only, so the rival's answers there stay withheld from all
  // but their author. Beside it, the same admin's full export of that event stays
  // refused (it holds every rival's answers and standing).
  test("sweep #233: an admin competing in an event, global or its organiser, exports a rival's person export, with the rival's attempts, times and hints and every answer to the event's sealed challenge withheld; the event's full export stays refused to them; the author reads the answers (CONTROL)", async () => {
    const { sa, saCsrf, ea, eaApi, eaCsrf } = W;
    const tag = uniq("r").replace(/[^a-zA-Z0-9]/g, "");
    const comp = await makeCompetition(sa, saCsrf, "fx-rival", { staff_compete: true });
    // The challenge's author organises the event and does not compete in it.
    await grantEventAdmin(sa, saCsrf, comp.id, ea.id);
    const key = `RIVALKEY${tag}`, wrong = `RIVALWRONG${tag}`;
    const sealedH = await makeTask(eaApi, eaCsrf, "fx-rival-sealed", { correct_answer: key, answer_sealed: true, hint: "<p>a hint</p>" });
    await assignTask(eaApi, eaCsrf, sealedH.id, [comp.id]);
    const rival = await makeParticipant(sa, saCsrf, "fxrival");
    const ga = await makeParticipant(sa, saCsrf, "fxrivalga");      // a global admin who competes
    const org = await makeParticipant(sa, saCsrf, "fxrivalorg");    // an organiser of the event who competes in it
    await grantEventAdmin(sa, saCsrf, comp.id, org.id);
    // Staff compete here, so the assign door gives both admins a row.
    await enrol(sa, saCsrf, comp.id, [rival.id, ga.id, org.id]);
    const pr = await sa.post(`/api/admin/participants/${ga.id}/role`, { headers: H(saCsrf), data: { role: "admin" } });
    expect(pr.ok(), `make admin: ${await pr.text()}`).toBeTruthy();
    // The rival plays: a wrong answer, a hint, then the key.
    {
      const l = await apiLogin(rival.email, PARTICIPANT_PASS);
      try {
        const sel = await l.api.post("/api/select-competition", { headers: H(l.csrf), data: { competitionId: comp.id } });
        expect(sel.status(), await sel.text()).toBe(200);
        const hh = { ...H(l.csrf), "x-competition-id": comp.id };
        const submit = async (answer, correct) => {
          const r = await l.api.post(`/api/tasks/${sealedH.id}/submit`, { headers: hh, data: { answer, gradingHash: await gradingHashFor(l.api, sealedH.id) } });
          expect(r.status(), await r.text()).toBe(200);
          expect((await r.json()).correct, answer).toBe(correct);
        };
        await submit(wrong, false);
        const h = await l.api.post(`/api/tasks/${sealedH.id}/hint`, { headers: hh });
        expect(h.status(), await h.text()).toBe(200);
        await submit(key, true);
      } finally { await l.api.dispose(); }
    }
    const db = new (require("better-sqlite3"))(require("./helpers").TEST_DB_PATH, { readonly: true });
    try {
      const role = (id) => db.prepare("SELECT role FROM users WHERE id=?").get(id).role;
      expect([role(ga.id), role(org.id), role(rival.id)], "PRECONDITION: the tiers").toEqual(["admin", "event_admin", "participant"]);
      const rows = db.prepare("SELECT user_id FROM competition_users WHERE competition_id=?").all(comp.id).map(r => r.user_id).sort();
      expect(rows, "PRECONDITION: both admins hold a row where staff compete: they compete with the rival").toEqual([rival.id, ga.id, org.id].sort());
    } finally { db.close(); }
    for (const [who, p] of [["the global admin", ga], ["the organiser", org]]) {
      const l = await apiLogin(p.email, PARTICIPANT_PASS);
      try {
        // Refused the event's full export, in the one competitor refusal…
        const full = await l.api.get(EVENT_URL(comp.id));
        expect(full.status(), `${who}: ${(await full.text()).slice(0, 300)}`).toBe(403);
        expect((await full.json()).code, who).toBe("competitor_cannot_edit");
        // …and answered the rival's person export, as JSON…
        const r = await l.api.get(PERSON_URL(rival.id));
        expect(r.status(), `${who}: ${(await r.text()).slice(0, 300)}`).toBe(200);
        const d = await r.json();
        expect(d.profile.id, who).toBe(rival.id);
        const subs = d.submissions.filter(s => s.competition_id === comp.id);
        expect(subs.map(s => [s.attempt_number, s.correct, s.answer_sealed, s.answer_visible, s.answer]),
          `${who}: the rival's attempts, every answer withheld`).toEqual([[1, false, true, false, null], [2, true, true, false, null]]);
        expect(subs.every(s => typeof s.submitted_at === "string" && s.submitted_at), `${who}: with their times`).toBe(true);
        expect(d.hints.filter(h => h.competition_id === comp.id).map(h => h.task_id), `${who}: and the hint`).toEqual([sealedH.id]);
        expect(d.memberships.find(m => m.competition_id === comp.id).login_time, `${who}: and when their clock started`).toBeTruthy();
        const text = JSON.stringify(d);
        for (const v of [key, wrong]) expect(text, `${who}: no answer to the sealed challenge, right or wrong`).not.toContain(v);
        // …and as a ZIP (the route's other path, with its own checks after the deflate).
        const z = await l.api.get(PERSON_URL(rival.id, "?format=zip-csv"));
        expect(z.status(), `${who}: ${(await z.text()).slice(0, 300)}`).toBe(200);
        const files = await unzip(await z.body());
        expect(objects(files["submissions.csv"]).filter(s => s["Event ID"] === comp.id).map(s => s.Answer), `${who}: the ZIP withholds them too`)
          .toEqual([expect.stringMatching(/^\(sealed/), expect.stringMatching(/^\(sealed/)]);
        for (const v of [key, wrong]) expect(Object.values(files).join("\n"), who).not.toContain(v);
      } finally { await l.api.dispose(); }
    }
    // CONTROL: the author, who does not compete, reads both answers in the same export.
    const a = await eaApi.get(PERSON_URL(rival.id));
    expect(a.status(), (await a.text()).slice(0, 300)).toBe(200);
    const atext = JSON.stringify(await a.json());
    for (const v of [key, wrong]) expect(atext, "the author reads the rival's answers").toContain(v);
  });
});

// The ZIP once left the absences out (the JSON carried them): each time the
// person was taken out of an event, and whether they came back, with the solve
// clock and join time a re-add restores, and the session they were in. A DECOY
// absence in an event the event admin does not organise, and an in-scope event
// whose name is a formula and which has a session the person entered.
test.describe("person export — the absences file", () => {
  test("the ZIP holds every absence, by value and oldest first, with its session, narrowed for an event admin like every section, formula-safe", async () => {
    const { sa, saCsrf, eaApi, ea } = W;
    const tag = uniq("abs").replace(/[^a-zA-Z0-9]/g, "");
    const p = await makeParticipant(sa, saCsrf, "absent");
    const inScope = await makeCompetition(sa, saCsrf, "abs-in", { name: `+Absent ${tag}` });
    const decoy = await makeCompetition(sa, saCsrf, "abs-decoy");
    // A live session in the in-scope event: the absence records it.
    const sessionName = `Morning ${tag}`;
    const ts = await sa.post(`/api/admin/competitions/${inScope.id}/timeslots`, { headers: H(saCsrf),
      data: { name: sessionName, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 300 } });
    expect(ts.ok(), `add a session: ${ts.status()} ${await ts.text()}`).toBeTruthy();
    const tsId = (await ts.json()).timeslot.id;
    await grantEventAdmin(sa, saCsrf, inScope.id, ea.id);
    await enrol(sa, saCsrf, inScope.id, [p.id]);
    await enrol(sa, saCsrf, decoy.id, [p.id]);
    // Entering each live event (the in-scope one through its session) starts
    // the solve clock, so a removal records an absence.
    const l = await apiLogin(p.email, PARTICIPANT_PASS);
    try {
      const sel = await l.api.post("/api/select-competition", { headers: H(l.csrf), data: { competitionId: inScope.id } });
      expect(sel.status(), await sel.text()).toBe(200);
      const slot = await l.api.post("/api/select-timeslot", { headers: H(l.csrf), data: { timeslotId: tsId, confirmLive: true } });
      expect(slot.status(), await slot.text()).toBe(200);
      expect((await slot.json()).ok, "PRECONDITION: the session is entered").toBe(true);
      const sel2 = await l.api.post("/api/select-competition", { headers: H(l.csrf), data: { competitionId: decoy.id } });
      expect(sel2.status(), await sel2.text()).toBe(200);
    } finally { await l.api.dispose(); }
    // Removed in an order that is not the events' id order, so "oldest first"
    // is told apart from the order the table's key would give (and from newest
    // first).
    const [first, second] = [inScope, decoy].sort((x, y) => y.id.localeCompare(x.id));
    for (const c of [first, second]) {
      const rm = await sa.delete(`/api/admin/competitions/${c.id}/users/${p.id}`, { headers: H(saCsrf) });
      expect(rm.status(), await rm.text()).toBe(200);
      expect((await rm.json()).removed, "really removed").toBe(true);
    }
    await enrol(sa, saCsrf, inScope.id, [p.id]);   // back in: that absence closes

    // CONTROL: the JSON (which always carried them) has both, so the CSV has a source.
    const j = await (await sa.get(PERSON_URL(p.id))).json();
    const byEvent = Object.fromEntries(j.absences.map(a => [a.competition_id, a]));
    expect(Object.keys(byEvent).sort(), "PRECONDITION: an absence in each event").toEqual([inScope.id, decoy.id].sort());
    expect(byEvent[inScope.id].returned_at, "PRECONDITION: the re-add closed the in-scope one").toBeTruthy();
    expect(byEvent[decoy.id].returned_at, "PRECONDITION: the decoy one is still open").toBeNull();
    expect(byEvent[inScope.id].login_time, "PRECONDITION: the solve clock had started").toBeTruthy();
    expect(byEvent[inScope.id].timeslot_id, "PRECONDITION: the absence records the session").toBe(tsId);
    // The JSON names the session, and lists the absences oldest first.
    expect(byEvent[inScope.id].session, "the JSON names the absence's session").toBe(sessionName);
    expect(byEvent[decoy.id].session, "an absence with no session names none").toBeNull();
    expect(j.absences.map(a => a.competition_id), "the JSON lists the absences oldest first").toEqual([first.id, second.id]);

    const z = await sa.get(PERSON_URL(p.id, "?format=zip-csv"));
    expect(z.status()).toBe(200);
    const files = await unzip(await z.body());
    expect(files["absences.csv"], "the ZIP has an absences file").toBeDefined();
    const rows = objects(files["absences.csv"]);
    const row = (id) => rows.find(r => r["Event ID"] === id);
    expect(rows.map(r => r["Event ID"]), "one row per absence, oldest first").toEqual([first.id, second.id]);
    expect(row(inScope.id)["Returned At"]).toBe(byEvent[inScope.id].returned_at);
    expect(row(inScope.id)["Removed At"]).toBe(byEvent[inScope.id].removed_at);
    expect(row(inScope.id)["Solve Clock Start"], "the anchor a re-add restores").toBe(byEvent[inScope.id].login_time);
    expect(row(inScope.id)["Assigned At"]).toBe(byEvent[inScope.id].assigned_at);
    expect(row(inScope.id).Session, "the session they were in").toBe(sessionName);
    expect(row(decoy.id).Session, "no session, an empty cell").toBe("");
    expect(row(decoy.id)["Returned At"], "an open absence has no return").toBe("");
    expect(row(decoy.id).Event).toBe(decoy.name);
    // Formula-safe through lib/csv.js: the event's name begins with "+".
    expect(row(inScope.id).Event, "a formula trigger is apostrophised").toBe(`'+Absent ${tag}`);

    // The event admin organises the in-scope event only: the decoy's row is gone, by value.
    const ez = await eaApi.get(PERSON_URL(p.id, "?format=zip-csv"));
    expect(ez.status(), await ez.text()).toBe(200);
    const efiles = await unzip(await ez.body());
    expect(objects(efiles["absences.csv"]).map(r => r["Event ID"]), "only the event they organise").toEqual([inScope.id]);
    expect(objects(efiles["absences.csv"])[0].Session, "with its session").toBe(sessionName);
    expect(Object.values(efiles).join("\n"), "the decoy's id is nowhere in the scoped ZIP").not.toContain(decoy.id);
    // By name too, in this file (a mail subject elsewhere can name an event
    // without its id: a recorded gap, CLAUDE.md Known open gaps).
    expect(efiles["absences.csv"]).not.toContain(decoy.name);
  });
});

test.describe("v8.15.0 — the ZIP writer", () => {
  test("round-trips through yauzl, CRC-checked, and refuses traversal names", async () => {
    const { buildZip } = require("../lib/zip-writer");
    const big = "row,".repeat(20000);
    const buf = await buildZip([{ name: "a.csv", data: "x,y\n1,2\n" }, { name: "dir/b.txt", data: big }, { name: "ü.txt", data: Buffer.from([0, 1, 2]) }]);
    const files = await unzip(buf);
    expect(files["a.csv"]).toBe("x,y\n1,2\n");
    expect(files["dir/b.txt"]).toBe(big);
    expect(Object.keys(files)).toContain("ü.txt");
    expect(await crcCheck(buf), "every entry's CRC matches its data, in both headers").toBe(3);
    // CONTROL: the checker can fail. Flip one byte of the first entry's
    // central-directory CRC.
    const bad = Buffer.from(buf);
    const cd = bad.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(cd, "PRECONDITION: a central directory").toBeGreaterThan(0);
    bad[cd + 16] ^= 0xff;
    await expect(crcCheck(bad)).rejects.toThrow(/crc/i);
    for (const bad of ["../x", "/abs", "a\\b", "a/../b"]) {
      await expect(buildZip([{ name: bad, data: "x" }]), bad).rejects.toThrow(/refusing entry name/);
    }
  });

  // Sweep #235: the top-three ZIP deflates first, re-checks, then assembles only
  // what may still go out, so the two halves must make the same archive as one.
  test("its two halves make the same archive, and a subset of the deflated entries is a valid archive of that subset", async () => {
    const { buildZip, deflateZipEntries, assembleZip } = require("../lib/zip-writer");
    const entries = [{ name: "a.csv", data: "x,y\n1,2\n" }, { name: "dir/b.txt", data: "row,".repeat(5000) }, { name: "c.txt", data: "c" }];
    const date = new Date("2026-11-23T10:00:00Z");
    const whole = await buildZip(entries, { date });
    const prepared = await deflateZipEntries(entries);
    expect(assembleZip(prepared, { date }).equals(whole), "the same bytes").toBe(true);
    expect(await crcCheck(whole)).toBe(3);
    const subset = assembleZip([prepared[0], prepared[2]], { date });
    expect(await crcCheck(subset), "the assembled subset's CRCs are right too").toBe(2);
    const files = await unzip(subset);
    expect(Object.keys(files).sort()).toEqual(["a.csv", "c.txt"]);
    expect(files["a.csv"]).toBe("x,y\n1,2\n");
    await expect(deflateZipEntries([{ name: "../x", data: "x" }])).rejects.toThrow(/refusing entry name/);
    expect(() => assembleZip([prepared[0], prepared[0]])).toThrow(/refusing entry name/);
  });
});

// A certificate's token is its capability (the public page, the PDF and image
// downloads), so no export carries one. A revocation recorded the token in its
// History details, which the person export writes to history.csv; it no longer
// records it, and a row written before that is stripped by the one details
// projection (lib/event-admin.js userEventDetailsSql), for every reader.
test.describe("person export — a revoked certificate's token", () => {
  test("history carries the revocation but never the certificate's token, new or old row, scoped or not", async () => {
    const { sa, saCsrf, eaApi, ea } = W;
    const ev = await makeCompetition(sa, saCsrf, "revoked-cert");
    await grantEventAdmin(sa, saCsrf, ev.id, ea.id);
    const p = await makeParticipant(sa, saCsrf, "revoked");
    await enrol(sa, saCsrf, ev.id, [p.id]);
    const tag = uniq("t").replace(/[^a-zA-Z0-9]/g, "");
    const token = `TOKNEW${tag}`, oldToken = `TOKOLD${tag}`;
    const Database = require("better-sqlite3");
    const { TEST_DB_PATH } = require("./helpers");
    const db = new Database(TEST_DB_PATH);
    try {
      const at = new Date().toISOString();
      db.prepare(`INSERT INTO achievement_badges (token, user_id, competition_id, timeslot_id, rank, image_id, nickname_snapshot,
                  created_at, basis) VALUES (?, ?, ?, NULL, 5, 'none', 'nick', ?, 'participation')`).run(token, p.id, ev.id, at);
      // A revocation as it was recorded before it stopped naming the token.
      db.prepare("INSERT INTO user_events (id, user_id, event_type, changed_by, changed_at, details) VALUES (?, ?, 'badge_revoked', 'superadmin', ?, ?)")
        .run(`old-${tag}`, p.id, at, JSON.stringify({ token: oldToken, competition_id: ev.id, basis: "participation", reason: `OLDREASON${tag}` }));
    } finally { db.close(); }
    const rv = await sa.post(`/api/admin/badges/${token}/revoke`, { headers: H(saCsrf), data: { reason: `NEWREASON${tag}` } });
    expect(rv.status(), await rv.text()).toBe(200);
    // The revocation itself no longer records the token (the stored row, read
    // past every projection).
    const rdb = new Database(TEST_DB_PATH, { readonly: true });
    try {
      const stored = rdb.prepare("SELECT details FROM user_events WHERE user_id=? AND event_type='badge_revoked' AND details LIKE ?").all(p.id, `%NEWREASON${tag}%`);
      expect(stored.length, "PRECONDITION: the revocation was recorded").toBe(1);
      expect(stored[0].details, "the recorded revocation names no token").not.toContain(token);
      expect(JSON.parse(stored[0].details).competition_id, "…and still names the event").toBe(ev.id);
    } finally { rdb.close(); }

    for (const [who, api] of [["a global admin", sa], ["the event's organiser", eaApi]]) {
      const z = await api.get(PERSON_URL(p.id, "?format=zip-csv"));
      expect(z.status(), `${who}: ${z.status()}`).toBe(200);
      const files = await unzip(await z.body());
      const history = files["history.csv"];
      expect(history, `${who}: CONTROL, the new revocation is in the history`).toContain(`NEWREASON${tag}`);
      expect(history, `${who}: CONTROL, the older revocation is in the history`).toContain(`OLDREASON${tag}`);
      const all = Object.values(files).join("\n");
      expect(all, `${who}: no file carries the revoked certificate's token`).not.toContain(token);
      expect(all, `${who}: …nor an older revocation's recorded token`).not.toContain(oldToken);
      const j = await (await api.get(PERSON_URL(p.id))).json();
      const text = JSON.stringify(j);
      expect(text, `${who}: CONTROL, the JSON export has the revocation`).toContain(`NEWREASON${tag}`);
      expect(text, `${who}: the JSON export carries neither token`).not.toMatch(new RegExp(`TOK(NEW|OLD)${tag}`));
    }
  });
});
