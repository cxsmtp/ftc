"use strict";

// THE EVENT JOIN QR (lib/qr.js level H + reserved centre) AND THE TOP-THREE
// CERTIFICATES ZIP (GET /api/admin/competitions/:id/certificates/top3.zip).
//
// The encoder half: level H's format word, the reservation changing only modules
// inside the box (each cleared to light), and a refusal for a box the symbol
// cannot afford. Each reserved symbol is also DECODED here by the suite's
// independent reader, tests/qr-decode.js (the standard's tables, its own
// Reed-Solomon correction, every function pattern checked with no exemption):
// it reads back to its URL, and every block's damage is measured against the
// standard's capacity, never against the encoder's own budget. The route's SVG,
// rasterised at 120-1600 px with its label plate and code drawn, is read back to
// the join link in tests/qr-decode.spec.js.

const { test, expect } = require("./isolated-test");
const qr = require("../lib/qr");
const { decodeQr } = require("./qr-decode");
const { apiLogin, PARTICIPANT_PASS, TEST_DB_PATH } = require("./helpers");
const { H, makeParticipant, makeCompetition, makeTask, assignTask, enrol, buildWorld } = require("./event-admin-helpers");

const CENTRE = { w: 0.44, h: 0.19 };
const URLS = [
  "https://hackarena.example.com/join/" + "a".repeat(43),
  "http://127.0.0.1:1111/join/" + "Zk3_".repeat(11),
  "https://x.io/join/abc",
];

function formatWord(m) {
  const pos = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  let bits = 0;
  pos.forEach(([x, y], i) => { if (m[y][x]) bits |= 1 << i; });
  return bits ^ 0x5412;
}

test.describe("join QR encoder (lib/qr.js, level H)", () => {
  test("level M stays the default: an explicit M is the same symbol", () => {
    for (const t of ["A", "https://hack.example.com/credential?code=4K7MP2QX9RTV", "z".repeat(150)]) {
      expect(JSON.stringify(qr.encodeQr(t, { level: "M" }).modules)).toBe(JSON.stringify(qr.encodeQr(t).modules));
    }
    expect(() => qr.encodeQr("A", { level: "X" }), "an unknown level is refused").toThrow(RangeError);
  });

  test("level H writes the H format word and holds less than M", () => {
    for (const t of URLS) {
      const q = qr.encodeQr(t, { level: "H" });
      const raw = formatWord(q.modules);
      expect(raw >>> 13, "error-correction level H").toBe(2);
      expect((raw >>> 10) & 7).toBe(q.mask);
      expect(q.version, "H needs at least the version M needs").toBeGreaterThanOrEqual(qr.encodeQr(t).version);
    }
    expect(qr.byteCapacity(10, "H")).toBeLessThan(qr.byteCapacity(10, "M"));
  });

  test("the centre is RESERVED: only data modules inside the box change, and every block stays inside its budget", () => {
    for (const t of URLS) {
      const q = qr.encodeQr(t, { level: "H", centre: CENTRE });
      const clean = qr.encodeQr(t, { level: "H", version: q.version });
      expect(clean.version).toBe(q.version);
      expect(clean.mask, "the reservation happens after the mask is chosen").toBe(q.mask);
      const b = q.centre;
      expect(b.w).toBeGreaterThan(q.size * 0.3);
      let changed = 0;
      for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) {
        if (q.modules[y][x] === clean.modules[y][x]) continue;
        changed++;
        const inside = x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
        expect(inside, `module ${x},${y} changed outside the box`).toBe(true);
        expect(q.modules[y][x], "a reserved module is light").toBe(false);
      }
      expect(changed, "CONTROL: the box really cleared modules").toBeGreaterThan(0);
      expect(q.damage).toBeGreaterThan(0);
      expect(q.budget).toBeGreaterThan(0);
      // The budget is checked against an INDEPENDENT reading (tests/qr-decode.js:
      // the standard's block table, its own Reed-Solomon correction), never
      // against the encoder's own count: the symbol as drawn decodes, and no
      // block needed more than its capacity less the one spare codeword. Read
      // with no label box, so every function pattern under the box is checked.
      const read = decodeQr(q.modules);
      expect(read.text, `${t.length} bytes: the reserved symbol reads back`).toBe(t);
      expect(read.functionPatterns.exempt, `${t.length} bytes: no function-pattern module exempt`).toBe(0);
      expect(read.functionPatterns.checked, "anti-vacuity: the function patterns were compared").toBeGreaterThan(200);
      for (const [i, blk] of read.blocks.entries()) {
        expect(blk.errors, `${t.length} bytes, block ${i}: errors within capacity ${blk.capacity} less one`).toBeLessThanOrEqual(blk.capacity - 1);
        expect(q.budget, `${t.length} bytes: the encoder's budget is the standard's capacity less one`).toBe(blk.capacity - 1);
      }
      expect(Math.max(...read.blocks.map(blk => blk.errors)), "the encoder's damage count bounds what a reader corrects").toBeLessThanOrEqual(q.damage);
      // The finders survive whole.
      for (const [cx, cy] of [[3, 3], [q.size - 4, 3], [3, q.size - 4]]) {
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          expect(q.modules[cy + dy][cx + dx]).toBe(Math.max(Math.abs(dx), Math.abs(dy)) !== 2);
        }
      }
    }
  });

  test("a box the symbol cannot afford is refused, never drawn", () => {
    expect(() => qr.encodeQr(URLS[0], { level: "H", centre: { w: 0.9, h: 0.9 } })).toThrow(RangeError);
  });

  test("the SVG carries the plate and the label, escaped", () => {
    const q = qr.encodeQr(URLS[0], { level: "H", centre: CENTRE });
    const svg = qr.qrSvg(q, { label: "HWN-F7N", title: "a<b" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain(">HWN-F7N</text>");
    expect(svg).toContain("<title>a&lt;b</title>");
    expect((svg.match(/<rect/g) || []).length, "background, plate, frame").toBe(3);
    const plain = qr.qrSvg(qr.encodeQr(URLS[0], { level: "H" }), {});
    expect(plain).not.toContain("<text");
  });
});

test.describe("POST /api/admin/join-qr", () => {
  let W;
  test.beforeAll(async () => { W = await buildWorld(); });

  test("admin tiers get the SVG; anonymous and participants do not; bad input is refused by name", async () => {
    const ok = await W.sa.post("/api/admin/join-qr", { headers: H(W.saCsrf), data: { text: URLS[0], label: "HWN-F7N" } });
    expect(ok.status()).toBe(200);
    expect(ok.headers()["content-type"]).toContain("image/svg+xml");
    expect(ok.headers()["cache-control"]).toContain("no-store");
    expect(await ok.text()).toContain(">HWN-F7N</text>");

    const ea = await W.eaApi.post("/api/admin/join-qr", { headers: H(W.eaCsrf), data: { text: URLS[0], label: "AB-12" } });
    expect(ea.status(), "an event admin renders the link they already hold").toBe(200);

    const p = await apiLogin(W.inMine.email, PARTICIPANT_PASS);
    try {
      expect([401, 403]).toContain((await p.api.post("/api/admin/join-qr", { headers: H(p.csrf), data: { text: "x" } })).status());
    } finally { await p.api.dispose(); }

    for (const [data, code] of [
      [{ text: "" }, "qr_text_invalid"],
      [{ text: ["x"] }, "qr_text_invalid"],
      [{ text: "x".repeat(257) }, "qr_text_invalid"],
      [{ text: "x", label: "lower" }, "qr_label_invalid"],
      [{ text: "x", label: { toString: 1 } }, "qr_label_invalid"],
    ]) {
      const r = await W.sa.post("/api/admin/join-qr", { headers: H(W.saCsrf), data });
      expect(r.status(), JSON.stringify(data).slice(0, 40)).toBe(400);
      expect((await r.json()).code).toBe(code);
    }
  });
});

test.describe("GET /api/admin/competitions/:id/certificates/top3.zip", () => {
  let W;
  test.beforeAll(async () => { W = await buildWorld(); });

  const zipNames = (buf) => {
    // Central-directory entries: signature 0x02014b50, name length at +28, name at +46.
    const out = [];
    for (let i = 0; i + 46 <= buf.length; i++) {
      if (buf.readUInt32LE(i) !== 0x02014b50) continue;
      const n = buf.readUInt16LE(i + 28);
      out.push(buf.slice(i + 46, i + 46 + n).toString("utf8"));
    }
    return out;
  };

  // The worker server's database, opened per call (never at module scope).
  const sqlWrite = (fn) => {
    const Database = require("better-sqlite3");
    const db = new Database(TEST_DB_PATH);
    try { return fn(db); } finally { db.close(); }
  };

  test("refusals: unknown 404, out of scope 403, live 409 event_not_ended", async () => {
    expect((await W.sa.get("/api/admin/competitions/nope-not-an-id/certificates/top3.zip")).status()).toBe(404);
    const out = await W.eaApi.get(`/api/admin/competitions/${W.theirs.id}/certificates/top3.zip`);
    expect(out.status(), "another organiser's event").toBe(403);
    const live = await W.sa.get(`/api/admin/competitions/${W.mine.id}/certificates/top3.zip`);
    expect(live.status()).toBe(409);
    expect((await live.json()).code).toBe("event_not_ended");
  });

  test("an ended event ships every placement certificate, audited per file with by_owner:false", async () => {
    const comp = await makeCompetition(W.sa, W.saCsrf, "top3");
    const task = await makeTask(W.sa, W.saCsrf, "top3t", { correct_answer: "yes" });
    const spare = await makeTask(W.sa, W.saCsrf, "top3s", { correct_answer: "no" });
    await assignTask(W.sa, W.saCsrf, task.id, [comp.id]);
    await assignTask(W.sa, W.saCsrf, spare.id, [comp.id]);
    const a = await makeParticipant(W.sa, W.saCsrf, "top3a");
    const idle = await makeParticipant(W.sa, W.saCsrf, "top3idle");
    await enrol(W.sa, W.saCsrf, comp.id, [a.id, idle.id]);

    // Ended with nobody placed and nothing pending reads as such.
    const p = await apiLogin(a.email, PARTICIPANT_PASS);
    try {
      const hdr = { ...H(p.csrf), "x-competition-id": comp.id };
      expect((await p.api.post("/api/select-competition", { headers: H(p.csrf), data: { competitionId: comp.id } })).ok()).toBeTruthy();
      const t = await (await p.api.get(`/api/tasks/${task.id}`, { headers: { "x-competition-id": comp.id } })).json();
      const s = await p.api.post(`/api/tasks/${task.id}/submit`, { headers: hdr, data: { answer: "yes", gradingHash: t.grading_hash } });
      expect(s.ok(), await s.text()).toBeTruthy();
      expect((await s.json()).correct).toBe(true);
    } finally { await p.api.dispose(); }

    const end = await W.sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(W.saCsrf), data: {} });
    expect(end.ok(), await end.text()).toBeTruthy();

    const before = await W.sa.get(`/api/admin/competitions/${comp.id}/certificates/top3.zip`);
    expect(before.status()).toBe(409);
    expect((await before.json()).code, "the dispatcher has not run: being issued").toBe("certificates_being_issued");

    const tick = await W.sa.post("/api/test/certificate-dispatch-tick", { headers: H(W.saCsrf), data: { force: true } });
    expect(tick.ok(), await tick.text()).toBeTruthy();

    const r = await W.sa.get(`/api/admin/competitions/${comp.id}/certificates/top3.zip`);
    expect(r.status(), await r.text().catch(() => "")).toBe(200);
    expect(r.headers()["content-type"]).toContain("application/zip");
    const names = zipNames(Buffer.from(await r.body()));
    expect(names.length, `names: ${names.join(", ")}`).toBe(1);
    // Named after its place and its holder as the certificate prints the name
    // (sweep #72), never only the event.
    expect(names[0]).toBe("1-event-top3a-certificate.pdf");   // makeParticipant names them "Event <label>"
    expect(names[0], "CONTROL: not named after the event alone").not.toContain(String(comp.name).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));

    const ev = await (await W.sa.get(`/api/admin/competitions/${comp.id}/events?limit=50`)).json();
    const rows = (ev.events || ev.rows || ev).filter(e => e.event_type === "badge_certificate_downloaded");
    expect(rows.length).toBe(1);
    const d = typeof rows[0].details === "string" ? JSON.parse(rows[0].details) : rows[0].details;
    expect(d.user_id).toBe(a.id);
    expect(d.by_owner).toBe(false);
    expect(d.via).toBe("top3_zip");
    expect(d.user_id, "CONTROL: the idle member holds no certificate in it").not.toBe(idle.id);
  });

  // Solve `n` of `tasks` as `who` in `comp` (fixture: distinct scores rank them).
  async function solveN(who, comp, tasks, n) {
    const p = await apiLogin(who.email, PARTICIPANT_PASS);
    try {
      expect((await p.api.post("/api/select-competition", { headers: H(p.csrf), data: { competitionId: comp.id } })).ok()).toBeTruthy();
      for (const t of tasks.slice(0, n)) {
        const g = await (await p.api.get(`/api/tasks/${t.id}`, { headers: { "x-competition-id": comp.id } })).json();
        const s = await p.api.post(`/api/tasks/${t.id}/submit`, { headers: { ...H(p.csrf), "x-competition-id": comp.id }, data: { answer: "yes", gradingHash: g.grading_hash } });
        expect(s.ok(), await s.text()).toBeTruthy();
        expect((await s.json()).correct).toBe(true);
      }
    } finally { await p.api.dispose(); }
  }

  test("nothing issued says WHY: not issued automatically (ended before the floor, email off) versus nobody placed", async () => {
    test.setTimeout(90_000);
    // Ended long before automatic certificates began (the floor is stamped at
    // this server's first boot), with nothing pending and a winner who has not
    // collected theirs: played live, then moved three days back.
    const old = await makeCompetition(W.sa, W.saCsrf, "top3old");
    const ot = await makeTask(W.sa, W.saCsrf, "top3oldt", { correct_answer: "yes" });
    const os = await makeTask(W.sa, W.saCsrf, "top3olds", { correct_answer: "no" });
    await assignTask(W.sa, W.saCsrf, ot.id, [old.id]);
    await assignTask(W.sa, W.saCsrf, os.id, [old.id]);
    const op = await makeParticipant(W.sa, W.saCsrf, "top3oldp");
    await enrol(W.sa, W.saCsrf, old.id, [op.id]);
    await solveN(op, old, [ot], 1);
    sqlWrite(db => db.prepare("UPDATE competitions SET start_time=?, duration_minutes=60, ended_at=NULL, ended_manually=0 WHERE id=?").run(new Date(Date.now() - 3 * 86400e3).toISOString(), old.id));
    let r, d;
    await expect.poll(async () => {
      r = await W.sa.get(`/api/admin/competitions/${old.id}/certificates/top3.zip`);
      d = await r.json();
      return d.code;
    }, { timeout: 10000, message: "the moved schedule is read (the event cache ages in a second)" }).toBe("certificates_not_issued_automatically");
    expect(r.status()).toBe(409);
    expect(d.reason, "an event the dispatcher never issues for is not 'nobody placed'").toBe("ended_before_floor");
    expect(d.error).toContain("ended before certificates were issued automatically");
    // CONTROL: ended before the floor too, but nobody placed: nothing is missing.
    const empty = await makeCompetition(W.sa, W.saCsrf, "top3oldempty", { start_time: new Date(Date.now() - 3 * 86400e3).toISOString(), duration_minutes: 60 });
    r = await W.sa.get(`/api/admin/competitions/${empty.id}/certificates/top3.zip`);
    expect(r.status()).toBe(409);
    expect((await r.json()).code, "nobody placed: no certificate is missing").toBe("no_placement_certificates");

    // The congratulations email off: the dispatcher drops the job, issuing nothing.
    const off = await makeCompetition(W.sa, W.saCsrf, "top3off");
    const t = await makeTask(W.sa, W.saCsrf, "top3offt", { correct_answer: "yes" });
    const spare = await makeTask(W.sa, W.saCsrf, "top3offs", { correct_answer: "no" });
    await assignTask(W.sa, W.saCsrf, t.id, [off.id]);
    await assignTask(W.sa, W.saCsrf, spare.id, [off.id]);
    const t3 = await makeTask(W.sa, W.saCsrf, "top3offt3", { correct_answer: "yes" });
    await assignTask(W.sa, W.saCsrf, t3.id, [off.id]);
    const p = await makeParticipant(W.sa, W.saCsrf, "top3offp");
    const q = await makeParticipant(W.sa, W.saCsrf, "top3offq");
    await enrol(W.sa, W.saCsrf, off.id, [p.id, q.id]);
    await solveN(p, off, [t, t3], 2);
    await solveN(q, off, [t, t3], 1);
    const cfg = await W.sa.put(`/api/admin/competitions/${off.id}/certificate-config`, { headers: H(W.saCsrf), data: { config: { email: { enabled: false } } } });
    expect(cfg.ok(), await cfg.text()).toBeTruthy();
    expect((await W.sa.post(`/api/admin/competitions/${off.id}/end-now`, { headers: H(W.saCsrf), data: {} })).ok()).toBeTruthy();
    expect((await W.sa.post("/api/test/certificate-dispatch-tick", { headers: H(W.saCsrf), data: { force: true } })).ok()).toBeTruthy();
    r = await W.sa.get(`/api/admin/competitions/${off.id}/certificates/top3.zip`);
    expect(r.status()).toBe(409);
    d = await r.json();
    expect(d.code).toBe("certificates_not_issued_automatically");
    expect(d.reason).toBe("email_disabled");
    expect(d.error).toContain("congratulations email is off");
    // The 2nd collects theirs: one file, and the ZIP says the winner's place is
    // missing and why — never "the top three".
    const w2 = await apiLogin(q.email, PARTICIPANT_PASS);
    try {
      const m = await w2.api.post(`/api/competitions/${off.id}/badge`, { headers: H(w2.csrf), data: {} });
      expect(m.ok(), `the 2nd mints: ${await m.text()}`).toBeTruthy();
    } finally { await w2.api.dispose(); }
    r = await W.sa.get(`/api/admin/competitions/${off.id}/certificates/top3.zip`);
    expect(r.status()).toBe(200);
    expect(r.headers()["x-top3-count"]).toBe("1");
    expect(r.headers()["x-top3-missing"], "the winner's place has no certificate").toBe("1");
    expect(r.headers()["x-top3-missing-reason"], "and will not get one automatically").toBe("email_disabled");

    // CONTROL: issued automatically, and nobody attempted anything: nobody placed.
    const none = await makeCompetition(W.sa, W.saCsrf, "top3none");
    const t2 = await makeTask(W.sa, W.saCsrf, "top3nonet", { correct_answer: "yes" });
    await assignTask(W.sa, W.saCsrf, t2.id, [none.id]);
    const idle = await makeParticipant(W.sa, W.saCsrf, "top3noneidle");
    await enrol(W.sa, W.saCsrf, none.id, [idle.id]);
    expect((await W.sa.post(`/api/admin/competitions/${none.id}/end-now`, { headers: H(W.saCsrf), data: {} })).ok()).toBeTruthy();
    expect((await W.sa.post("/api/test/certificate-dispatch-tick", { headers: H(W.saCsrf), data: { force: true } })).ok()).toBeTruthy();
    r = await W.sa.get(`/api/admin/competitions/${none.id}/certificates/top3.zip`);
    expect(r.status()).toBe(409);
    expect((await r.json()).code).toBe("no_placement_certificates");
  });

  test("a ZIP sent while the rest are still being issued says how many are missing; the full podium does not", async () => {
    test.setTimeout(120_000);
    const comp = await makeCompetition(W.sa, W.saCsrf, "top3part");
    const tasks = [];
    for (let i = 0; i < 3; i++) tasks.push(await makeTask(W.sa, W.saCsrf, `top3p${i}`, { correct_answer: "yes" }));
    const spare = await makeTask(W.sa, W.saCsrf, "top3pspare", { correct_answer: "no" });
    for (const t of [...tasks, spare]) await assignTask(W.sa, W.saCsrf, t.id, [comp.id]);
    const ppl = [];
    for (let i = 0; i < 3; i++) ppl.push(await makeParticipant(W.sa, W.saCsrf, `top3pp${i}`));
    await enrol(W.sa, W.saCsrf, comp.id, ppl.map(x => x.id));
    // Names in other scripts and with accents (read live at every render).
    sqlWrite(db => db.prepare("UPDATE users SET first_name=?, last_name=? WHERE id=?").run("伟", "张", ppl[0].id));
    sqlWrite(db => db.prepare("UPDATE users SET first_name=?, last_name=? WHERE id=?").run("José", "García", ppl[1].id));
    // Distinct scores: 3, 2 and 1 solves.
    for (let i = 0; i < 3; i++) await solveN(ppl[i], comp, tasks, 3 - i);
    expect((await W.sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(W.saCsrf), data: {} })).ok()).toBeTruthy();
    // The winner collects their own certificate inside the dispatcher's settle.
    const w = await apiLogin(ppl[0].email, PARTICIPANT_PASS);
    try {
      const m = await w.api.post(`/api/competitions/${comp.id}/badge`, { headers: H(w.csrf), data: {} });
      expect(m.ok(), `the winner mints: ${await m.text()}`).toBeTruthy();
    } finally { await w.api.dispose(); }
    let r = await W.sa.get(`/api/admin/competitions/${comp.id}/certificates/top3.zip`);
    expect(r.status(), "part of the podium downloads").toBe(200);
    expect(r.headers()["x-top3-count"]).toBe("1");
    expect(r.headers()["x-top3-missing"], "two places are missing").toBe("2");
    expect(r.headers()["x-top3-missing-reason"], "while the rest are being issued").toBe("being_issued");
    expect(zipNames(Buffer.from(await r.body())).length).toBe(1);
    // The dispatcher issues the rest: the full podium, nothing missing.
    expect((await W.sa.post("/api/test/certificate-dispatch-tick", { headers: H(W.saCsrf), data: { force: true } })).ok()).toBeTruthy();
    r = await W.sa.get(`/api/admin/competitions/${comp.id}/certificates/top3.zip`);
    expect(r.status()).toBe(200);
    expect(r.headers()["x-top3-count"]).toBe("3");
    expect(r.headers()["x-top3-missing"], "CONTROL: the whole podium misses nothing").toBeUndefined();
    expect(r.headers()["x-top3-missing-reason"]).toBeUndefined();
    // Each named after its place and its holder, letters of any script kept: the
    // names the certificates print (and the issued list shows), not the nicknames.
    const certs = await (await W.sa.get(`/api/admin/competitions/${comp.id}/certificates`)).json();
    const listed = Object.fromEntries((certs.certificates || certs.rows || certs).map(c => [c.user_id || c.userId, c.name]));
    expect([listed[ppl[0].id], listed[ppl[1].id]], "CONTROL: the issued list prints the same names").toEqual(["张伟", "José García"]);
    expect(zipNames(Buffer.from(await r.body())).sort()).toEqual([
      "1-张伟-certificate.pdf", "2-josé-garcía-certificate.pdf", "3-event-top3pp2-certificate.pdf"]);
  });

  // Enter `comp`, join session `tsId`, and solve `n` of `tasks`.
  async function playInSession(who, comp, tsId, tasks, n) {
    const p = await apiLogin(who.email, PARTICIPANT_PASS);
    try {
      expect((await p.api.post("/api/select-competition", { headers: H(p.csrf), data: { competitionId: comp.id } })).ok()).toBeTruthy();
      const pick = await p.api.post("/api/select-timeslot", { headers: H(p.csrf), data: { timeslotId: tsId, confirmLive: true } });
      expect(pick.ok(), await pick.text()).toBeTruthy();
      expect((await pick.json()).ok, "joined the session").toBe(true);
      for (const t of tasks.slice(0, n)) {
        const g = await (await p.api.get(`/api/tasks/${t.id}`, { headers: { "x-competition-id": comp.id } })).json();
        const s = await p.api.post(`/api/tasks/${t.id}/submit`, { headers: { ...H(p.csrf), "x-competition-id": comp.id }, data: { answer: "yes", gradingHash: g.grading_hash } });
        expect(s.ok(), await s.text()).toBeTruthy();
        expect((await s.json()).correct).toBe(true);
      }
    } finally { await p.api.dispose(); }
  }

  test("a per-session event has a podium per session: each session's in its own folder, the missing ones counted across them", async () => {
    test.setTimeout(150_000);
    const comp = await makeCompetition(W.sa, W.saCsrf, "top3slots");
    const sess = {};
    for (const name of ["Morning", "Evening"]) {
      const r = await W.sa.post(`/api/admin/competitions/${comp.id}/timeslots`, { headers: H(W.saCsrf), data: { name: `${name} ${Date.now().toString(36)}`, start_time: new Date(Date.now() - 60_000).toISOString(), duration_minutes: 600 } });
      expect(r.ok(), `session ${name}: ${await r.text()}`).toBeTruthy();
      sess[name] = (await r.json()).timeslot;
      expect(sess[name].status, "a live session").toBe("live");
    }
    expect(sqlWrite(db => db.prepare("SELECT leaderboard_mode FROM competitions WHERE id=?").get(comp.id)).leaderboard_mode,
      "PRECONDITION: each session is ranked on its own").toBe("per_slot");
    const tasks = [];
    for (let i = 0; i < 2; i++) tasks.push(await makeTask(W.sa, W.saCsrf, `top3sl${i}`, { correct_answer: "yes" }));
    const spare = await makeTask(W.sa, W.saCsrf, "top3slspare", { correct_answer: "no" });
    for (const t of [...tasks, spare]) await assignTask(W.sa, W.saCsrf, t.id, [comp.id]);
    const ppl = {};
    for (const k of ["m1", "m2", "e1", "e2"]) ppl[k] = await makeParticipant(W.sa, W.saCsrf, `top3sl${k}`);
    await enrol(W.sa, W.saCsrf, comp.id, Object.values(ppl).map(x => x.id));
    await playInSession(ppl.m1, comp, sess.Morning.id, tasks, 2);
    await playInSession(ppl.m2, comp, sess.Morning.id, tasks, 1);
    await playInSession(ppl.e1, comp, sess.Evening.id, tasks, 2);
    await playInSession(ppl.e2, comp, sess.Evening.id, tasks, 1);
    expect((await W.sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(W.saCsrf), data: {} })).ok()).toBeTruthy();
    // The Morning winner collects theirs before the dispatcher runs: three of the
    // four podium places (two per session) are missing, across both sessions.
    const w = await apiLogin(ppl.m1.email, PARTICIPANT_PASS);
    try {
      const m = await w.api.post(`/api/competitions/${comp.id}/badge`, { headers: H(w.csrf), data: {} });
      expect(m.ok(), `the Morning winner mints: ${await m.text()}`).toBeTruthy();
    } finally { await w.api.dispose(); }
    let r = await W.sa.get(`/api/admin/competitions/${comp.id}/certificates/top3.zip`);
    expect(r.status()).toBe(200);
    expect(r.headers()["x-top3-count"]).toBe("1");
    expect(r.headers()["x-top3-missing"], "one per session is not 'fewer than three'").toBe("3");
    expect(r.headers()["x-top3-missing-reason"]).toBe("being_issued");
    expect((await W.sa.post("/api/test/certificate-dispatch-tick", { headers: H(W.saCsrf), data: { force: true } })).ok()).toBeTruthy();
    r = await W.sa.get(`/api/admin/competitions/${comp.id}/certificates/top3.zip`);
    expect(r.status()).toBe(200);
    expect(r.headers()["x-top3-count"], "two podiums of two").toBe("4");
    expect(r.headers()["x-top3-missing"], "CONTROL: both podiums whole").toBeUndefined();
    const names = zipNames(Buffer.from(await r.body()));
    const inFolder = (slot) => names.filter(n => n.startsWith(`${slot.name.replace(/\s+/g, "_")}/`)).map(n => n.split("/")[1]).sort();
    expect(inFolder(sess.Morning), `the Morning podium, in its folder, by holder: ${names.join(", ")}`).toEqual(["1-event-top3slm1-certificate.pdf", "2-event-top3slm2-certificate.pdf"]);
    expect(inFolder(sess.Evening), `the Evening podium, in its folder, by holder: ${names.join(", ")}`).toEqual(["1-event-top3sle1-certificate.pdf", "2-event-top3sle2-certificate.pdf"]);
    expect(names.filter(n => !n.includes("/")), "nothing at the top level of a per-session event").toEqual([]);
  });

  test("a late entrant's podium counts once late entries close; their deferred job is not 'still being issued' before then", async () => {
    test.setTimeout(150_000);
    const comp = await makeCompetition(W.sa, W.saCsrf, "top3late", { event_kind: "booth", duration_minutes: 120, add_qualifying: false });
    const t = await makeTask(W.sa, W.saCsrf, "top3latet", { correct_answer: "yes" });
    const spare = await makeTask(W.sa, W.saCsrf, "top3latespare", { correct_answer: "no" });
    await assignTask(W.sa, W.saCsrf, t.id, [comp.id]);
    await assignTask(W.sa, W.saCsrf, spare.id, [comp.id]);
    const p = await makeParticipant(W.sa, W.saCsrf, "top3latep");
    await enrol(W.sa, W.saCsrf, comp.id, [p.id]);
    await solveN(p, comp, [t], 1);
    expect((await W.sa.post(`/api/admin/competitions/${comp.id}/end-now`, { headers: H(W.saCsrf), data: {} })).ok()).toBeTruthy();
    // A late entrant joins and plays inside the late window.
    const late = await makeParticipant(W.sa, W.saCsrf, "top3latel");
    await enrol(W.sa, W.saCsrf, comp.id, [late.id]);
    await solveN(late, comp, [t], 1);
    expect((await W.sa.post("/api/test/certificate-dispatch-tick", { headers: H(W.saCsrf), data: { force: true } })).ok()).toBeTruthy();
    const pend = (await (await W.sa.get(`/api/admin/competitions/${comp.id}/certificates`)).json()).pending;
    expect(pend.map(j => j.reason), "PRECONDITION: the job is held for the late entrant only").toEqual(["late_entry_pending"]);
    let r = await W.sa.get(`/api/admin/competitions/${comp.id}/certificates/top3.zip`);
    expect(r.status()).toBe(200);
    expect(r.headers()["x-top3-count"], "the main board's winner").toBe("1");
    expect(r.headers()["x-top3-missing"], "the late entrant's placing is not final: nothing is missing yet").toBeUndefined();
    // CONTROL: late entries close — the late entrant's 1st place is now due.
    const close = await W.sa.post(`/api/admin/competitions/${comp.id}/late-entry/close`, { headers: H(W.saCsrf), data: {} });
    expect(close.ok(), await close.text()).toBeTruthy();
    await expect.poll(async () => (await W.sa.get(`/api/admin/competitions/${comp.id}/certificates/top3.zip`)).headers()["x-top3-missing"],
      { timeout: 10000, message: "the late podium counts once its window has closed" }).toBe("1");
    r = await W.sa.get(`/api/admin/competitions/${comp.id}/certificates/top3.zip`);
    expect(r.headers()["x-top3-missing-reason"]).toBe("being_issued");
    expect((await W.sa.post("/api/test/certificate-dispatch-tick", { headers: H(W.saCsrf), data: { force: true } })).ok()).toBeTruthy();
    r = await W.sa.get(`/api/admin/competitions/${comp.id}/certificates/top3.zip`);
    expect(r.headers()["x-top3-count"]).toBe("2");
    expect(r.headers()["x-top3-missing"]).toBeUndefined();
    const names = zipNames(Buffer.from(await r.body()));
    expect(names, `the late entrants' 1st in its folder, the main board's at the top, each by holder: ${names.join(", ")}`)
      .toEqual(expect.arrayContaining(["late-entrants/1-event-top3latel-certificate.pdf", "1-event-top3latep-certificate.pdf"]));
    expect(names).toHaveLength(2);
  });
});

// THE JOIN LINK DIALOG (self-enroll.js). Operator rule: the event join QR
// ALWAYS carries the event code in its centre, so the dialog's preview and its
// PNG download come from the same encoder as the workspace pill (POST
// /api/admin/join-qr, lib/qr.js level H). Last in the file: the browser sign-in
// below ends the API superadmin sessions the describes above hold.
test.describe("the Join Link dialog's QR carries the event code", () => {
  const { adminLogin } = require("./ui-admin-helpers");
  test.use({ baseURL: require("./helpers").BASE });
  let ev;
  test.beforeAll(async () => {
    const sa = await apiLogin("superadmin");
    try {
      const r = await sa.api.post("/api/admin/competitions", { headers: H(sa.csrf), data: {
        name: `Join QR dialog ${Date.now().toString(36)}`, start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 120 } });
      expect(r.status(), await r.text()).toBe(200);
      ev = (await r.json()).competition;
      const rv = await (await sa.api.get(`/api/admin/competitions/${ev.id}/self-enroll`)).json();
      ev.url = rv.url; ev.display = rv.join_code_display;
      expect(ev.display, "a reveal returns the short join code").toMatch(/^[A-Z0-9][A-Z0-9-]+$/);
    } finally { await sa.api.dispose(); }
  });

  const svgOf = (src) => Buffer.from(String(src).replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString("utf8");

  async function openDialog(page) {
    await page.evaluate(([id, name]) => { window.openSelfEnrollOverlay(id, name); }, [ev.id, ev.name]);
    await expect(page.locator("#self-enroll-overlay")).toBeVisible();
  }

  test("the preview is the centred-code QR, and the PNG download is drawn from it", async ({ page }) => {
    const asked = [];
    page.on("request", (rq) => { if (new URL(rq.url()).pathname === "/api/admin/join-qr") asked.push(rq.postDataJSON()); });
    await adminLogin(page);
    await openDialog(page);
    const img = page.locator("#self-enroll-overlay #self-enroll-qr img.se-qr-img");
    await expect(img).toHaveCount(1, { timeout: 15000 });
    await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth), { message: "the QR image decoded" }).toBeGreaterThan(0);
    const svg = svgOf(await img.getAttribute("src"));
    expect(svg, "the event code is printed in the centre").toContain(`>${ev.display}</text>`);
    expect(await img.getAttribute("alt")).toContain(ev.display);
    expect(asked[0], "the dialog asked the one encoder, with the link and the code").toEqual({ text: ev.url, label: ev.display });
    const box = await img.boundingBox();
    expect(box && box.width, "rendered at the dialog's size").toBeGreaterThan(150);

    const [dl] = await Promise.all([
      page.waitForEvent("download"),
      page.locator('#self-enroll-overlay [data-action="self-enroll-download-qr"]').click(),
    ]);
    const buf = require("fs").readFileSync(await dl.path());
    expect(buf.slice(1, 4).toString("latin1"), "a PNG").toBe("PNG");
    expect(buf.readUInt32BE(16), "print width").toBe(1200);
    expect(buf.readUInt32BE(20)).toBe(1200);
    expect(asked.length, "the download was drawn from the centred-code SVG, asked for again").toBeGreaterThanOrEqual(2);
    expect(asked[asked.length - 1]).toEqual({ text: ev.url, label: ev.display });
  });

  test("CONTROL — with the encoder unreachable the preview falls back to a plain QR and the download refuses", async ({ page }) => {
    await adminLogin(page);
    await page.route((u) => u.pathname === "/api/admin/join-qr", (route) => route.abort());
    await openDialog(page);
    await expect(page.locator("#self-enroll-overlay #self-enroll-qr svg"), "the plain fallback").toHaveCount(1, { timeout: 15000 });
    await expect(page.locator("#self-enroll-overlay #self-enroll-qr img")).toHaveCount(0);
    let downloads = 0;
    page.on("download", () => { downloads++; });
    await page.locator('#self-enroll-overlay [data-action="self-enroll-download-qr"]').click();
    await expect(page.locator("#toast-stack .toast", { hasText: "Could not generate the QR image." })).toBeVisible();
    expect(downloads, "a printed sign must carry the code: no plain PNG").toBe(0);
  });

  // The workspace header's join pill follows the status (title, chips, status,
  // then the pill, Invite and More), and its popover opens WHOLE. Found by the
  // 8.17.0 page re-check: `all:unset` written after `order:5` reset the order,
  // so the pill sat before the title, and the header's `overflow:hidden` cut the
  // popover off and was scrolled sideways by the popover's focus, pushing the
  // whole header out of view. Geometry, at desktop and phone width.
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    test(`the join pill sits after the status and its QR popover opens whole (${w}px)`, async ({ page }) => {
      const sa = await apiLogin("superadmin");
      let booth;
      try {
        const r = await sa.api.post("/api/admin/competitions", { headers: H(sa.csrf), data: {
          name: `Join pill ${w} ${Date.now().toString(36)}`, event_kind: "booth", self_enroll_enabled: true,
          start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 60 } });
        expect(r.status(), await r.text()).toBe(200);
        booth = (await r.json()).competition;
        expect(!!booth.self_enroll_enabled, "PRECONDITION: the join link is on").toBe(true);
      } finally { await sa.api.dispose(); }
      await page.setViewportSize({ width: w, height: h });
      await adminLogin(page);
      await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), booth.id), { timeout: 15000 }).toBe(true);
      await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n), { id: booth.id, n: booth.name });
      const pill = page.locator('#ws-join [data-action="ws-join-reveal"]');
      await expect(pill).toBeVisible({ timeout: 10000 });
      const title = page.locator("#ws-record .ws-title");
      // The header repaints on its 1 s status tick, so a box read right after
      // `toBeVisible` can hit the detached node (null): poll until both lay out.
      let pb = null, tb = null;
      await expect.poll(async () => { pb = await pill.boundingBox(); tb = await title.boundingBox(); return !!(pb && tb); },
        { message: "the pill and the title are laid out", timeout: 10000 }).toBe(true);
      expect(pb.y >= tb.y + tb.height - 1 || pb.x >= tb.x + tb.width, `the pill comes after the title (pill ${JSON.stringify(pb)}, title ${JSON.stringify(tb)})`).toBe(true);
      await pill.click();
      const pop = page.locator("#ws-join-pop");
      await expect(pop).toBeVisible();
      const img = pop.locator("#ws-qr img");
      await expect(img).toBeVisible({ timeout: 10000 });
      await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
      const geo = await page.evaluate(() => {
        const p = document.getElementById("ws-join-pop").getBoundingClientRect();
        const rec = document.getElementById("ws-record");
        const pts = [[p.left + 24, p.top + 24], [p.right - 24, p.top + 24], [p.left + 24, p.bottom - 24], [p.right - 24, p.bottom - 24], [p.left + p.width / 2, p.top + p.height / 2]];
        const inside = pts.map(([x, y]) => { const e = document.elementFromPoint(x, y); return !!(e && e.closest("#ws-join-pop")); });
        return { p: { l: p.left, r: p.right, t: p.top, b: p.bottom }, vw: innerWidth, vh: innerHeight, inside,
          recScroll: [rec.scrollLeft, rec.scrollTop], titleLeft: rec.querySelector(".ws-title").getBoundingClientRect().left, recLeft: rec.getBoundingClientRect().left };
      });
      expect(geo.p.l, JSON.stringify(geo)).toBeGreaterThanOrEqual(0);
      expect(geo.p.r, JSON.stringify(geo)).toBeLessThanOrEqual(geo.vw);
      expect(geo.inside, `every corner of the popover is painted, not clipped or covered: ${JSON.stringify(geo)}`).toEqual([true, true, true, true, true]);
      expect(geo.recScroll, "opening the popover never scrolls the header").toEqual([0, 0]);
      expect(geo.titleLeft, "the title stays inside the header").toBeGreaterThanOrEqual(geo.recLeft);
    });
  }

  // Same re-check: on a section other than Overview the header collapses to one
  // strip, which never wrapped, so a long status ("Ended · late entry open until
  // …") pushed More past the header's right edge at 1280 px.
  test("the collapsed header strip keeps Invite and More inside it with a long late-entry status (1280px)", async ({ page }) => {
    const sa = await apiLogin("superadmin");
    let booth;
    try {
      const r = await sa.api.post("/api/admin/competitions", { headers: H(sa.csrf), data: {
        name: `Late strip ${Date.now().toString(36)} — Security Stand, Hall 3`, event_kind: "booth", late_entry_enabled: true,
        start_time: new Date(Date.now() - 3_600_000).toISOString(), duration_minutes: 240 } });
      expect(r.status(), await r.text()).toBe(200);
      booth = (await r.json()).competition;
      const e = await sa.api.post(`/api/admin/competitions/${booth.id}/end-now`, { headers: H(sa.csrf), data: {} });
      expect(e.ok(), await e.text()).toBeTruthy();
    } finally { await sa.api.dispose(); }
    await page.setViewportSize({ width: 1280, height: 900 });
    await adminLogin(page);
    await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), booth.id), { timeout: 15000 }).toBe(true);
    await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n), { id: booth.id, n: booth.name });
    await expect(page.locator("#ws-record")).toBeVisible({ timeout: 10000 });
    await page.evaluate(() => window.wsTab("admin-participants-tab"));
    await expect(page.locator(".ws[data-section='admin-participants-tab']")).toHaveCount(1, { timeout: 10000 });
    const status = page.locator("#ws-record .scope-status").first();
    await expect(status, "PRECONDITION: the long late-entry status is shown").toContainText(/late entr/i, { timeout: 10000 });
    const g = await page.evaluate(() => {
      const rec = document.getElementById("ws-record").getBoundingClientRect();
      const more = document.querySelector("#ws-record .ws-more-btn").getBoundingClientRect();
      return { recRight: rec.right, moreRight: more.right, moreLeft: more.left, docW: document.documentElement.scrollWidth, iw: innerWidth };
    });
    expect(g.moreRight, JSON.stringify(g)).toBeLessThanOrEqual(g.recRight + 0.5);
    expect(g.docW, `no horizontal page scroll: ${JSON.stringify(g)}`).toBeLessThanOrEqual(g.iw);
  });

  // Same re-check: the admin content area was an `overflow-y:auto` box, so it,
  // not the window, was the sticky strip's scrollport. The strip never stuck,
  // and at rest `top:var(--header-bottom)` pushed it down over what follows it
  // (on a phone, the Section button sat under it). At rest nothing overlaps
  // the strip; scrolled, the strip sits right under the header.
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    test(`the collapsed header strip overlaps nothing at rest and sticks under the header when scrolled (${w}px)`, async ({ page }) => {
      const sa = await apiLogin("superadmin");
      let ev;
      try {
        const r = await sa.api.post("/api/admin/competitions", { headers: H(sa.csrf), data: {
          name: `Strip ${w} ${Date.now().toString(36)}`, event_kind: "tournament",
          start_time: new Date(Date.now() - 600_000).toISOString(), duration_minutes: 240 } });
        expect(r.status(), await r.text()).toBe(200);
        ev = (await r.json()).competition;
      } finally { await sa.api.dispose(); }
      await page.setViewportSize({ width: w, height: h });
      await adminLogin(page);
      await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), ev.id), { timeout: 15000 }).toBe(true);
      await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n), { id: ev.id, n: ev.name });
      await expect(page.locator("#ws-record")).toBeVisible({ timeout: 10000 });
      await page.evaluate(() => window.wsTab("admin-tasks-tab"));
      await expect(page.locator(".ws[data-section='admin-tasks-tab']")).toHaveCount(1, { timeout: 10000 });
      await expect(page.locator("#admin-task-body tr").first()).toBeAttached({ timeout: 15000 });
      const rest = await page.evaluate(() => {
        const rec = document.getElementById("ws-record").getBoundingClientRect();
        const ws = document.querySelector(".ws");
        const next = [...ws.parentElement.querySelectorAll("#ws-section-pick, #admin-tasks-tab")].find(e => e.getBoundingClientRect().height > 0);
        return { recBottom: rec.bottom, nextTop: next.getBoundingClientRect().top, next: next.id, docH: document.documentElement.scrollHeight, ih: innerHeight };
      });
      expect(rest.nextTop, `the element after the strip starts below it: ${JSON.stringify(rest)}`).toBeGreaterThanOrEqual(rest.recBottom - 0.5);
      // Make room to scroll if the page is short, then scroll the WINDOW.
      await page.evaluate(() => { const s = document.createElement("div"); s.id = "strip-spacer"; s.style.height = "2000px"; document.getElementById("admin-tasks-tab").appendChild(s); window.scrollTo(0, 600); });
      await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300);
      const stuck = await page.evaluate(() => ({ top: document.getElementById("ws-record").getBoundingClientRect().top,
        hb: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-bottom")) }));
      expect(Math.abs(stuck.top - stuck.hb), `the strip sticks under the header: ${JSON.stringify(stuck)}`).toBeLessThanOrEqual(2);
    });
  }

  // THE FULL-SCREEN QR (event-workspace.js wsJoinFull), on the stand's screen.
  // The QR fills its white card and the whole block fits the screen: a later
  // rule sized the image on its own (min(70vh,80vw)), so at 1280x900 it spilled
  // past the 420 px card and pushed "Scan to join" and the event name above the
  // top edge, and at 390 px it hung past the card. And it sits on the ordinary
  // dialog rung (3000), so the session warning (9200) and the impersonation
  // Exit bar (9100) stay above a QR left up on the stand: on 9500 it covered
  // both. On a screen too short for the whole block, it opens at its top and
  // scrolls to Close: Close takes focus on open, and moving to it scrolled the
  // view past "Scan to join" and the event's name.
  for (const [w, h, fits] of [[1280, 900, true], [390, 844, true], [1280, 400, false]]) {
    test(`the full-screen QR fits its card and the screen, and stays under the session warning and the Exit bar (${w}x${h})`, async ({ page }) => {
      const sa = await apiLogin("superadmin");
      let booth;
      try {
        const r = await sa.api.post("/api/admin/competitions", { headers: H(sa.csrf), data: {
          name: `Full QR ${w} ${Date.now().toString(36)}`, event_kind: "booth", self_enroll_enabled: true,
          start_time: new Date(Date.now() + 86_400_000).toISOString(), duration_minutes: 60 } });
        expect(r.status(), await r.text()).toBe(200);
        booth = (await r.json()).competition;
        expect(!!booth.self_enroll_enabled, "PRECONDITION: the join link is on").toBe(true);
      } finally { await sa.api.dispose(); }
      await page.setViewportSize({ width: w, height: h });
      await adminLogin(page);
      await expect.poll(() => page.evaluate((id) => (window.adminCompetitionsData || []).some(c => c.id === id), booth.id), { timeout: 15000 }).toBe(true);
      await page.evaluate(({ id, n }) => window.openEventWorkspace(id, n), { id: booth.id, n: booth.name });
      await page.locator('#ws-join [data-action="ws-join-reveal"]').click();
      await expect(page.locator("#ws-join-pop")).toBeVisible({ timeout: 10000 });
      await page.locator('#ws-join-pop [data-action="ws-join-full"]').click();
      const full = page.locator("#ws-qr-full");
      await expect(full).toBeVisible();
      const img = full.locator("#ws-qr-full-qr img");
      await expect(img, "the centre-coded QR image").toBeVisible({ timeout: 10000 });
      await expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
      const g = await page.evaluate(() => {
        const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width }; };
        const ov = document.getElementById("ws-qr-full");
        return { card: r("#ws-qr-full-qr"), img: r("#ws-qr-full-qr img"), eyebrow: r("#ws-qr-full .eyebrow"), title: r("#ws-qr-full-title"),
          close: r('#ws-qr-full [data-action="ws-join-full-close"]'), vw: innerWidth, vh: innerHeight, scrolls: ov.scrollHeight - ov.clientHeight };
      });
      const why = JSON.stringify(g);
      expect(g.img.w, `PRECONDITION: the QR is drawn at a real size: ${why}`).toBeGreaterThan(150);
      expect(g.img.l, `the QR stays inside its card (left): ${why}`).toBeGreaterThanOrEqual(g.card.l - 0.5);
      expect(g.img.r, `the QR stays inside its card (right): ${why}`).toBeLessThanOrEqual(g.card.r + 0.5);
      expect(g.img.t, `the QR stays inside its card (top): ${why}`).toBeGreaterThanOrEqual(g.card.t - 0.5);
      expect(g.img.b, `the QR stays inside its card (bottom): ${why}`).toBeLessThanOrEqual(g.card.b + 0.5);
      expect(g.eyebrow.t, `"Scan to join" is on the screen: ${why}`).toBeGreaterThanOrEqual(0);
      expect(g.title.t, `the event name is on the screen: ${why}`).toBeGreaterThanOrEqual(0);
      expect(g.card.r, `the card fits the width: ${why}`).toBeLessThanOrEqual(g.vw);
      if (fits) {
        expect(g.close.b, `Close is on the screen: ${why}`).toBeLessThanOrEqual(g.vh);
        expect(g.scrolls, `the whole block fits the screen without scrolling: ${why}`).toBeLessThanOrEqual(0);
      } else {
        expect(g.scrolls, `PRECONDITION: this screen is too short for the whole block: ${why}`).toBeGreaterThan(0);
        // Scrolled to its end, Close comes into view.
        const end = await page.evaluate(() => {
          const ov = document.getElementById("ws-qr-full");
          ov.scrollTop = ov.scrollHeight;
          return document.querySelector('#ws-qr-full [data-action="ws-join-full-close"]').getBoundingClientRect().bottom;
        });
        expect(end, `scrolled to its end, Close is on the screen: ${why}`).toBeLessThanOrEqual(g.vh);
        await page.evaluate(() => { document.getElementById("ws-qr-full").scrollTop = 0; });
      }

      // The session warning arrives while the QR is up: it is on top.
      await page.evaluate(() => window._showSessionWarning());
      const stay = page.locator('#session-warn-overlay [data-action="session-warn-stay"]');
      await expect(stay).toBeVisible();
      const hit = await stay.evaluate((b) => {
        const r = b.getBoundingClientRect();
        const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { onWarning: !!(e && e.closest("#session-warn-overlay")), onQr: !!(e && e.closest("#ws-qr-full")) };
      });
      expect(hit, "the session warning's button is the topmost thing where it is drawn, not the QR").toEqual({ onWarning: true, onQr: false });
      await expect(full, "CONTROL: the QR is still up under it").toBeVisible();
      await page.evaluate(() => window._closeSessionWarning());

      // The impersonation Exit bar, drawn by its own renderer while the QR is
      // up (the bar's rung, 9100, is what is measured), stays on top of it.
      await page.evaluate(() => { window.S.impersonation = { superadmin: true, target_role: "participant", view: "participant" }; window.renderImpersonationBanner(); });
      const exit = page.locator('#impersonation-banner [data-action="impersonation-exit"]');
      await expect(exit).toBeVisible();
      const onTop = await exit.evaluate((b) => {
        const r = b.getBoundingClientRect();
        const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { onBar: !!(e && e.closest("#impersonation-banner")), onQr: !!(e && e.closest("#ws-qr-full")) };
      });
      expect(onTop, "the Exit bar's button is the topmost thing where it is drawn, not the QR").toEqual({ onBar: true, onQr: false });
      await expect(full, "CONTROL: the QR is still up under it").toBeVisible();
      await page.evaluate(() => { window.S.impersonation = null; window.refreshImpersonationBanner(); });
    });
  }
});
