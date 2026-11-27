// v8.15.0 — THE CERTIFICATE DESIGN IS CONFIGURABLE, AND ONLY THE DESIGN.
//
// Four layers of lock, because each catches what the others cannot:
//   * PURE arms over lib/certificate-config.js — every refusal a save can meet,
//     named by code and field, each beside a positive control that the same
//     section accepts a valid value (a validator refusing everything passes the
//     refusal arms); the read path's tolerance; the merge precedence.
//   * RENDER arms over buildCertificateSvg — determinism per tier (twice
//     byte-identical, SVG and PNG), tiers pairwise distinct, every switch
//     removes what it names, the late-entrant marker survives every switch.
//   * The QR encoder's own algebra (lib/qr.js): deterministic, sized by its
//     payload, finders and timing where the standard puts them, the format word a
//     valid BCH codeword, and every Reed-Solomon block of real symbols (read back
//     out of the matrix by the suite's independent reader, tests/qr-decode.js)
//     leaving a zero remainder. The symbols themselves are DECODED by that reader
//     in tests/qr-decode.spec.js, the certificate's drawn mark included.
//   * API arms — the tier and scope of every route, strict refusals over HTTP,
//     the merge as the routes report it, the preview writing nothing, the ended
//     lock, and that the MINTED certificate follows the event's design live.

const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const crypto = require("crypto");
const CC = require("../lib/certificate-config");
const badge = require("../lib/badge");
const qr = require("../lib/qr");

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

test.describe("certificate config — validation (pure)", () => {
  const refuse = (input, code, field) => {
    const r = CC.validateCertificateConfig(input);
    expect(r.ok, `refused: ${JSON.stringify(input)}`).toBe(false);
    expect(r.code, `code for ${JSON.stringify(input)}`).toBe(code);
    if (field !== undefined) expect(r.field).toBe(field);
    expect(String(r.error).length, "the refusal says why").toBeGreaterThan(10);
  };

  test("POSITIVE CONTROL: a layer touching every section is accepted and canonicalised", () => {
    const r = CC.validateCertificateConfig({
      text: { title: "  CERTIFICATE OF EXCELLENCE  ", hub_line: "{platform} academy", recognition: "" },
      labels: { gold: { headline: "Champion" }, completion: { sub: "" } },
      colors: { gold: "#e0b04a", frame: "#C0C0C0" },
      show: { qr: false, pattern: true },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.value).toEqual({
      text: { title: "CERTIFICATE OF EXCELLENCE", hub_line: "{platform} academy", recognition: "" },
      labels: { gold: { headline: "Champion" }, completion: { sub: "" } },
      colors: { gold: "#E0B04A", frame: "#C0C0C0" },
      show: { qr: false, pattern: true },
    });
    expect(CC.validateCertificateConfig({}).value, "the empty layer is valid and empty").toEqual({});
  });

  test("every refusal is named, and nothing unknown is accepted and ignored", () => {
    refuse(null, "certificate_config_not_object", "");
    refuse([], "certificate_config_not_object", "");
    refuse("x", "certificate_config_not_object", "");
    refuse({ theme: {} }, "certificate_config_unknown_key", "config.theme");
    refuse({ text: { subtitle: "x" } }, "certificate_config_unknown_key", "text.subtitle");
    refuse({ labels: { platinum: { headline: "x" } } }, "certificate_config_unknown_key", "labels.platinum");
    refuse({ labels: { gold: { footnote: "x" } } }, "certificate_config_unknown_key", "labels.gold.footnote");
    refuse({ colors: { highlight: "#FFFFFF" } }, "certificate_config_unknown_key", "colors.highlight");
    refuse({ show: { confetti: true } }, "certificate_config_unknown_key", "show.confetti");
    refuse({ text: "x" }, "certificate_config_bad_type", "text");
    refuse({ text: { title: 7 } }, "certificate_config_bad_type", "text.title");
    refuse({ text: { title: ["a"] } }, "certificate_config_bad_type", "text.title");
    refuse({ text: { title: "   " } }, "certificate_config_required", "text.title");
    refuse({ labels: { gold: { headline: "" } } }, "certificate_config_required", "labels.gold.headline");
    refuse({ text: { title: "X".repeat(49) } }, "certificate_config_too_long", "text.title");
    refuse({ text: { recognition: "a".repeat(221) } }, "certificate_config_too_long", "text.recognition");
    refuse({ text: { title: "LINE\nBREAK" } }, "certificate_config_control_chars", "text.title");
    refuse({ text: { title: "A\u0085B" } }, "certificate_config_control_chars", "text.title");
    refuse({ text: { hub_line: "{event} hub" } }, "certificate_config_unknown_token", "text.hub_line");
    refuse({ text: { hub_line: "a { b" } }, "certificate_config_unknown_token", "text.hub_line");
    for (const bad of ["#FFF", "red", "#GGGGGG", "FFFFFF", "#FFFFFF80", "rgb(1,2,3)", 0xffffff]) {
      refuse({ colors: { accent: bad } }, "certificate_config_bad_colour", "colors.accent");
    }
    refuse({ show: { qr: "false" } }, "certificate_config_bad_type", "show.qr");
    refuse({ show: { qr: 0 } }, "certificate_config_bad_type", "show.qr");
  });

  test("there is NO switch for the late-entrant marker", () => {
    // A certificate earned as a late entrant must say so; a design key that could
    // hide it would let a skin change what the document claims.
    expect(CC.SHOW_FIELDS.some(k => /late/i.test(k)), "no late-entry show switch").toBe(false);
    expect(CC.validateCertificateConfig({ show: { late_entrant: false } }).code).toBe("certificate_config_unknown_key");
  });

  test("the READ path keeps every valid field and drops the rest", () => {
    const stored = JSON.stringify({
      text: { title: "KEPT", subtitle: "dropped", lead_in: 5 },
      labels: { gold: { headline: "Kept", nope: "x" }, mystery: { headline: "x" } },
      colors: { gold: "#ABCDEF", accent: "violet" },
      show: { qr: false, sparkle: true },
      theme: { x: 1 },
    });
    expect(CC.sanitiseStoredConfig(stored)).toEqual({
      text: { title: "KEPT" }, labels: { gold: { headline: "Kept" } }, colors: { gold: "#ABCDEF" }, show: { qr: false },
    });
    // Sweep #56 — tolerant on READ: wording the fonts cannot draw stays (its layer
    // is refused at its next save, which names the field), while a headline's
    // placeholder, which the renderer never filled, is dropped (the small line's
    // is the control).
    expect(CC.sanitiseStoredConfig(JSON.stringify({ text: { title: "სერტიფიკატი" }, labels: { gold: { headline: "{platform}", sub: "{platform}" } } })))
      .toEqual({ text: { title: "სერტიფიკატი" }, labels: { gold: { sub: "{platform}" } } });
    expect(CC.sanitiseStoredConfig("{not json"), "unparseable reads as no layer").toEqual({});
    expect(CC.sanitiseStoredConfig(null)).toEqual({});
    expect(CC.sanitiseStoredConfig("[1,2]")).toEqual({});
  });

  test("sweep #56: a tier headline takes no placeholder; the small line under it still does", () => {
    refuse({ labels: { gold: { headline: "{platform} Champion" } } }, "certificate_config_unknown_token", "labels.gold.headline");
    refuse({ labels: { completion: { headline: "{platform}" } } }, "certificate_config_unknown_token", "labels.completion.headline");
    expect(CC.validateCertificateConfig({ labels: { gold: { headline: "{platform}" } } }).error, "says the line prints as typed").toMatch(/prints exactly as typed/);
    const ok = CC.validateCertificateConfig({ labels: { gold: { sub: "{platform} finisher" } }, text: { hub_line: "{platform}" } });
    expect(ok.ok, `CONTROL: the sub line and the text keep the placeholder: ${JSON.stringify(ok)}`).toBe(true);
  });

  test("sweep #56: certificate wording the fonts cannot draw is refused at save, judged with the platform name filled in; the email's wording is not asked", () => {
    expect(badge.canRenderText("ქართული"), "PRECONDITION: the font metrics load (Georgian is undrawable)").toBe(false);
    expect(badge.canRenderText("Zertifikat"), "PRECONDITION: and Latin is drawable").toBe(true);
    for (const [path, value] of [
      ["text.title", "სერტიფიკატი"],                 // Georgian: no face
      ["text.recognition", "Well done 🏆"],         // an emoji
      ["text.lead_in", "प्रमाणपत्र"],                    // Devanagari: no face ships
      ["labels.gold.headline", "Gold ذهبي"],         // Latin on one line with Arabic
      ["labels.silver.sub", "ქ"],
    ]) {
      const [sec, a, b] = path.split(".");
      const input = sec === "text" ? { text: { [a]: value } } : { labels: { [a]: { [b]: value } } };
      refuse(input, "certificate_config_undrawable", path);
    }
    for (const title of ["شهادة تقدير", "ใบประกาศ", "证书 Certificate", "Сертификат", "Zertifikat für Ärzte"]) {
      const r = CC.validateCertificateConfig({ text: { title } });
      expect(r.ok, `CONTROL: one face draws "${title}": ${JSON.stringify(r)}`).toBe(true);
    }
    const mail = CC.validateCertificateConfig({ email: { intro: "Well done 🏆", subject: "🏆 {event}" } });
    expect(mail.ok, `the email is drawn by mail clients, not asked: ${JSON.stringify(mail)}`).toBe(true);
    // With the platform name filled in: a Latin name beside Arabic cannot share one line.
    const mixed = CC.validateCertificateConfig({ text: { hub_line: "{platform} شهادة" } }, { platformName: "Hack Arena" });
    expect([mixed.ok, mixed.code, mixed.field]).toEqual([false, "certificate_config_undrawable", "text.hub_line"]);
    expect(CC.validateCertificateConfig({ text: { hub_line: "{platform} شهادة" } }, { platformName: "هاك أرينا" }).ok, "CONTROL: an Arabic name with Arabic wording").toBe(true);
    expect(CC.validateCertificateConfig({ text: { hub_line: "شهادة" } }, { platformName: "Hack Arena" }).ok, "CONTROL: no placeholder, no platform name on the line").toBe(true);
  });

  test("merge precedence is defaults <- global <- event, field by field", () => {
    const D = CC.certificateDefaults();
    expect(D.text.title, "the defaults reproduce the reference").toBe("CERTIFICATE OF ACHIEVEMENT");
    expect(D.labels.gold).toEqual({ headline: "1st Place", sub: "TOP-3 FINISHER" });
    const global = { text: { title: "GLOBAL TITLE", lead_in: "GLOBAL LEAD" }, labels: { gold: { sub: "G-SUB" } }, colors: { gold: "#111111" } };
    const event = { text: { title: "EVENT TITLE" }, labels: { gold: { headline: "E-HEAD" } } };
    const m = CC.mergeCertificateConfig(global, event);
    expect(m.text.title, "event beats global").toBe("EVENT TITLE");
    expect(m.text.lead_in, "global beats defaults where the event is silent").toBe("GLOBAL LEAD");
    expect(m.text.footer_tagline, "defaults fill everything else").toBe(D.text.footer_tagline);
    expect(m.labels.gold, "labels merge per field, not per tier").toEqual({ headline: "E-HEAD", sub: "G-SUB" });
    expect(m.labels.silver).toEqual(D.labels.silver);
    expect(m.colors.gold).toBe("#111111");
    expect(m.colors.frame, "frame has no default: unset follows the tier metal").toBeUndefined();
    expect(CC.mergeCertificateConfig().text, "no layers is the defaults").toEqual(D.text);
    // The defaults object is never mutated by a merge.
    expect(CC.certificateDefaults().text.title).toBe("CERTIFICATE OF ACHIEVEMENT");
  });

  test("the tier comes from the frozen basis first, the rank second", () => {
    expect(CC.certificateTier({ basis: "placement", rank: 1 })).toBe("gold");
    expect(CC.certificateTier({ basis: "placement", rank: 2 })).toBe("silver");
    expect(CC.certificateTier({ basis: "placement", rank: 3 })).toBe("bronze");
    expect(CC.certificateTier({ basis: "participation", rank: 1 }), "a late entrant's rank 1 is not a placing").toBe("participation");
    expect(CC.certificateTier({ basis: "completion", rank: 1 })).toBe("completion");
    expect(CC.certificateTier({ basis: null, rank: 2 }), "legacy rows derive from rank").toBe("silver");
    expect(CC.certificateTier({ basis: null, rank: 9 })).toBe("participation");
    expect(badge.badgeBasisLabel("participation", 1), "and the label agrees").toBe("Participant");
  });
});

const ART = (over = {}) => ({
  platformName: "Checkmarx Enablement Hub",
  competitionName: "India AI-Day 2026 Mumbai",
  displayName: "Jane Doe",
  dateLabel: "6 Aug 2026",
  scoreLabel: "400 pts",
  publicCode: "4K7MP2QX9RTV",
  verifyUrl: "hack.example.com/credential",
  verifyLink: "https://hack.example.com/credential?code=4K7MP2QX9RTV",
  ...over,
});
const TIER_ART = {
  gold: { rank: 1, basis: "placement" },
  silver: { rank: 2, basis: "placement" },
  bronze: { rank: 3, basis: "placement" },
  participation: { rank: 5, basis: "participation", scoreLabel: null },
  completion: { rank: 1, basis: "completion", scoreLabel: null },
};

test.describe("certificate artwork — determinism and switches", () => {
  test("each tier renders byte-identically twice, and the five tiers all differ", async () => {
    test.setTimeout(120_000);
    const svgs = {}, pngs = {};
    for (const [tier, a] of Object.entries(TIER_ART)) {
      const s1 = badge.buildCertificateSvg(ART(a));
      const s2 = badge.buildCertificateSvg(ART(a));
      expect(s2, `${tier}: the SVG is deterministic`).toBe(s1);
      const p1 = await badge.renderBadgePng(s1);
      const p2 = await badge.renderBadgePng(s2);
      expect(p1.slice(0, 8).toString("hex"), `${tier}: a real PNG`).toBe("89504e470d0a1a0a");
      expect(sha(p2), `${tier}: the PNG is deterministic`).toBe(sha(p1));
      svgs[tier] = sha(s1); pngs[tier] = sha(p1);
    }
    expect(new Set(Object.values(svgs)).size, "five distinct SVGs").toBe(5);
    expect(new Set(Object.values(pngs)).size, "five distinct PNGs").toBe(5);
  });

  test("podium tiers strike a medal; participation and completion get a seal and no score", () => {
    for (const t of ["gold", "silver", "bronze"]) {
      const s = badge.buildCertificateSvg(ART(TIER_ART[t]));
      expect(s, `${t}: struck medal with a faceted star`).toContain('fill="url(#rim)"');
      expect(s, `${t}: carries its score`).toContain(">400 pts<");
      expect(s, `${t}: its own headline`).toContain(`>${CC.LABEL_DEFAULTS[t].headline}<`);
    }
    for (const t of ["participation", "completion"]) {
      // Pass a score anyway: the renderer must not print one for these tiers.
      const s = badge.buildCertificateSvg(ART({ ...TIER_ART[t], scoreLabel: "400 pts" }));
      expect(s, `${t}: no score column`).not.toContain(">400 pts<");
      expect(s, `${t}: its own headline`).toContain(`>${CC.LABEL_DEFAULTS[t].headline}<`);
    }
    // A participation basis with a podium rank (a late entrant) is a seal, not "1st Place".
    const late = badge.buildCertificateSvg(ART({ rank: 1, basis: "participation" }));
    expect(late).not.toContain(">1st Place<");
    expect(late).toContain(">Participant<");
  });

  test("the configured words reach the artwork; the defaults reproduce the reference", () => {
    const def = badge.buildCertificateSvg(ART(TIER_ART.gold));
    for (const w of ["CERTIFICATE OF ACHIEVEMENT", "PRESENTED TO", "FOR SUCCESSFULLY COMPLETING THE",
                     "APPLICATION SECURITY FOR THE AI ERA", "ACHIEVEMENT UNLOCKED", "TOP-3 FINISHER", "CHECKMARX ENABLEMENT HUB"]) {
      expect(def, `default copy: ${w}`).toContain(`>${w}<`);
    }
    const design = CC.mergeCertificateConfig({
      text: { title: "Certificate of Excellence", hub_line: "{platform} Academy", footer_tagline: "" },
      labels: { gold: { headline: "Champion", sub: "" } },
      colors: { accent: "#22AA88" },
    });
    const s = badge.buildCertificateSvg(ART({ ...TIER_ART.gold, design }));
    expect(s, "small-caps lines are set in capitals").toContain(">CERTIFICATE OF EXCELLENCE<");
    expect(s, "{platform} is filled").toContain(">CHECKMARX ENABLEMENT HUB ACADEMY<");
    expect(s, "an empty tagline is hidden").not.toContain("APPLICATION SECURITY");
    expect(s, "the tier headline is configurable").toContain(">Champion<");
    expect(s, "…and an empty sub hides").not.toContain("TOP-3 FINISHER");
    expect(s, "the accent colour is used").toContain("#22AA88");
    // A user-controlled string is escaped wherever it lands.
    // Sweep #56 — a headline placeholder stored before the refusal is dropped on
    // read: the tier prints its default headline, never literal braces, while the
    // sub line fills it.
    const legacy = badge.buildCertificateSvg(ART({ ...TIER_ART.gold, design: CC.mergeCertificateConfig(CC.sanitiseStoredConfig(JSON.stringify({ labels: { gold: { headline: "{platform}", sub: "{platform}" } } }))) }));
    expect(legacy, "no literal placeholder").not.toContain("{platform}");
    expect(legacy, "the default headline").toContain(">1st Place<");
    expect(legacy, "the sub line, filled").toContain(">CHECKMARX ENABLEMENT HUB<");
    const x = badge.buildCertificateSvg(ART({ ...TIER_ART.gold, design: CC.mergeCertificateConfig({ text: { title: "<script>&" } }) }));
    expect(x).toContain("&lt;SCRIPT&gt;&amp;");
    expect(x).not.toContain("<script>");
  });

  test("every switch removes what it names — and the late-entrant marker survives all of them", () => {
    const on = badge.buildCertificateSvg(ART({ ...TIER_ART.gold, lateEntrant: true }));
    const off = (k) => badge.buildCertificateSvg(ART({ ...TIER_ART.gold, lateEntrant: true, design: CC.mergeCertificateConfig({ show: { [k]: false } }) }));
    expect(on).toContain(">SCORE<"); expect(off("score")).not.toContain(">SCORE<");
    expect(on).toContain(">DATE<"); expect(off("date")).not.toContain(">DATE<");
    expect(on).toContain("cert-qr"); expect(off("qr")).not.toContain("cert-qr");
    expect(off("qr"), "the code stays when only the QR is off").toContain(">4K7M-P2QX-9RTV<");
    expect(off("code")).not.toContain("4K7M-P2QX-9RTV");
    expect(off("code"), "…and the QR goes with the code").not.toContain("cert-qr");
    expect(on).toContain('fill="url(#rim)"'); expect(off("medal")).not.toContain('fill="url(#rim)"');
    expect(on).toContain('mask="url(#hexMask)"'); expect(off("pattern")).not.toContain('mask="url(#hexMask)"');
    expect(on).toContain('fill="url(#shieldFill)"'); expect(off("shield")).not.toContain('fill="url(#shieldFill)"');
    const all = CC.mergeCertificateConfig({ show: Object.fromEntries(CC.SHOW_FIELDS.map(k => [k, false])) });
    const bare = badge.buildCertificateSvg(ART({ ...TIER_ART.gold, lateEntrant: true, design: all }));
    expect(bare, "the late-entrant claim cannot be switched off").toContain(">LATE ENTRANT<");
    expect(bare, "…nor the holder's name").toContain(">Jane Doe<");
    expect(badge.buildCertificateSvg(ART(TIER_ART.gold)), "CONTROL: absent when not late").not.toContain("LATE ENTRANT");
  });

  test("a name is never cut and the event line never collides, at any length", () => {
    const long = "Dr. Maria Jose Guadalupe Garcia-Hernandez de la Vega";
    const s = badge.buildCertificateSvg(ART({ ...TIER_ART.gold, displayName: long,
      competitionName: "Spring Security Capture The Flag Championship 2026 Edition" }));
    const lines = [...s.matchAll(/<text class="cert-name"[^>]*font-size="([\d.]+)"[^>]*>([^<]*)<\/text>/g)];
    expect(lines.map(m => m[2]).join(" ")).toBe(long);
    expect(Number(lines[0][1]), "still legible").toBeGreaterThanOrEqual(32);
  });
});

test.describe("QR encoder (lib/qr.js)", () => {
  test("deterministic, sized by payload, and refuses rather than truncates", () => {
    const a = qr.encodeQr("https://hack.example.com/credential?code=4K7MP2QX9RTV");
    const b = qr.encodeQr("https://hack.example.com/credential?code=4K7MP2QX9RTV");
    expect(JSON.stringify(b.modules)).toBe(JSON.stringify(a.modules));
    expect(a.size).toBe(a.version * 4 + 17);
    expect(qr.encodeQr("A").version).toBe(1);
    expect(qr.encodeQr("x".repeat(qr.byteCapacity(1) + 1)).version).toBe(2);
    expect(() => qr.encodeQr("x".repeat(qr.byteCapacity(qr.MAX_VERSION) + 1))).toThrow(RangeError);
    expect(qr.encodeQr("x".repeat(qr.byteCapacity(qr.MAX_VERSION))).version).toBe(qr.MAX_VERSION);
  });

  test("the three finder patterns and the timing rows are where the standard puts them", () => {
    for (const text of ["HELLO", "y".repeat(120)]) {
      const q = qr.encodeQr(text);
      const n = q.size, m = q.modules;
      for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          expect(m[cy + dy][cx + dx], `finder at ${cx},${cy} ring ${d}`).toBe(d !== 2);
        }
      }
      for (let i = 8; i < n - 8; i++) { expect(m[6][i]).toBe(i % 2 === 0); expect(m[i][6]).toBe(i % 2 === 0); }
      expect(m[n - 8][8], "the always-dark module").toBe(true);
    }
  });

  test("the format word is a valid BCH codeword for level M and the chosen mask", () => {
    for (const text of ["A", "HELLO", "z".repeat(150)]) {
      const q = qr.encodeQr(text);
      let bits = 0;
      const m = q.modules;
      // First copy, bits 0..14 in the standard's reading order.
      const pos = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
      pos.forEach(([x, y], i) => { if (m[y][x]) bits |= 1 << i; });
      const raw = bits ^ 0x5412;
      let rem = raw;
      for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0x537 << (i - 10);
      expect(rem, `${text.slice(0, 8)}: BCH remainder`).toBe(0);
      expect(raw >>> 13, "error-correction level M").toBe(0);
      expect((raw >>> 10) & 7, "the mask it reports").toBe(q.mask);
    }
  });

  test("Reed-Solomon: every block of a real symbol, read back out of the matrix, leaves no remainder", () => {
    const { readBlocks, dataModuleOrder } = require("./qr-decode");
    const div = qr._rsDivisor(16);
    const data = Array.from({ length: 28 }, (_, i) => (i * 37 + 11) & 0xff);
    const ecc = qr._rsRemainder(data, div);
    expect(qr._rsRemainder(data.concat(ecc), div).every(v => v === 0)).toBe(true);
    const bad = data.concat(ecc); bad[3] ^= 1;
    expect(qr._rsRemainder(bad, div).some(v => v !== 0), "CONTROL: a flipped bit is detected").toBe(true);
    expect(qr._gfMul(0x80, 0x02), "GF(256) reduces by 0x11D").toBe(0x1d);
    // The blocks AS PLACED: unmasked, walked out of the data region and
    // de-interleaved by the independent reader (tests/qr-decode.js), not handed
    // over by the encoder, so a placement or interleaving fault shows here too.
    let blocks = 0;
    for (const text of ["A", "HELLO", "https://hack.example.com/credential?code=4K7MP2QX9RTV", "z".repeat(150), "x".repeat(qr.byteCapacity(qr.MAX_VERSION))]) {
      const q = qr.encodeQr(text);
      const read = readBlocks(q.modules);
      expect(read.version, text.slice(0, 8)).toBe(q.version);
      for (const [i, b] of read.blocks.entries()) {
        expect(qr._rsRemainder(b.word, qr._rsDivisor(b.ecc)).every(v => v === 0), `${text.slice(0, 8)} (version ${q.version}) block ${i}: zero remainder`).toBe(true);
        blocks++;
      }
      // CONTROL: one data module flipped leaves a non-zero remainder somewhere.
      const m = q.modules.map(r => r.slice());
      const [x, y] = dataModuleOrder(q.version)[5];
      m[y][x] = !m[y][x];
      expect(readBlocks(m).blocks.some(b => qr._rsRemainder(b.word, qr._rsDivisor(b.ecc)).some(v => v !== 0)), "CONTROL: a flipped module is seen").toBe(true);
    }
    expect(blocks, "anti-vacuity: single- and multi-block versions").toBeGreaterThanOrEqual(12);
  });
});

// ── API ──────────────────────────────────────────────────────────────────────
test.describe("certificate config — routes", () => {
  const { apiLogin, freshCtx, PARTICIPANT_PASS, TEST_DB_PATH, codeLogin } = require("./helpers");
  const { buildWorld, makeParticipant, makeCompetition, H } = require("./event-admin-helpers");
  let W;
  const DEFAULT_GLOBAL = {};

  test.beforeAll(async () => { W = await buildWorld(); });
  test.afterAll(async () => {
    // Restore the hard-coded default (no global layer), whatever a test left.
    if (W) await W.sa.delete("/api/admin/certificate-config", { headers: H(W.saCsrf) }).catch(() => {});
  });

  test("tiers: anonymous 401, participant refused, admin and superadmin edit both layers", async () => {
    const { api: anon, csrf } = await freshCtx();
    try {
      expect((await anon.get("/api/admin/certificate-config")).status()).toBe(401);
      expect((await anon.post("/api/admin/certificate-config/preview", { headers: H(csrf), data: {} })).status()).toBe(401);
      expect((await anon.get(`/api/admin/competitions/${W.mine.id}/certificate-config`)).status()).toBe(401);
    } finally { await anon.dispose(); }

    const p = await apiLogin(W.inMine.email, PARTICIPANT_PASS);
    try {
      expect([401, 403]).toContain((await p.api.get("/api/admin/certificate-config")).status());
      expect([401, 403]).toContain((await p.api.post("/api/admin/certificate-config/preview", { headers: H(p.csrf), data: {} })).status());
    } finally { await p.api.dispose(); }

    const adm = await makeParticipant(W.sa, W.saCsrf, "ccadmin");
    expect((await W.sa.post(`/api/admin/participants/${adm.id}/role`, { headers: H(W.saCsrf), data: { role: "admin" } })).ok()).toBeTruthy();
    const a = await apiLogin(adm.email, PARTICIPANT_PASS);
    try {
      // Operator ruling, 29 Oct 2026: the GLOBAL design is administrator-level.
      expect((await a.api.get("/api/admin/certificate-config")).status(), "a regular admin reads the global design").toBe(200);
      const gp = await a.api.put("/api/admin/certificate-config", { headers: H(a.csrf), data: { config: { text: { title: "ADMIN GLOBAL" } } } });
      expect(gp.status(), await gp.text()).toBe(200);
      expect((await gp.json()).effective.text.title).toBe("ADMIN GLOBAL");
      expect((await a.api.delete("/api/admin/certificate-config", { headers: H(a.csrf) })).status()).toBe(200);
      // …and sets an event's.
      const r = await a.api.put(`/api/admin/competitions/${W.theirs.id}/certificate-config`, { headers: H(a.csrf), data: { config: { text: { title: "ADMIN SET" } } } });
      expect(r.status(), await r.text()).toBe(200);
      expect((await r.json()).effective.text.title).toBe("ADMIN SET");
      expect((await a.api.delete(`/api/admin/competitions/${W.theirs.id}/certificate-config`, { headers: H(a.csrf) })).ok()).toBeTruthy();
    } finally { await a.api.dispose(); }

    const g = await W.sa.get("/api/admin/certificate-config");
    expect(g.status()).toBe(200);
    const body = await g.json();
    expect(body.defaults.text.title).toBe("CERTIFICATE OF ACHIEVEMENT");
    expect(body.global).toEqual(DEFAULT_GLOBAL);
  });

  test("event admin: reads and previews their own event's design, edits nothing (operator ruling)", async () => {
    const own = await W.eaApi.get(`/api/admin/competitions/${W.mine.id}/certificate-config`);
    expect(own.status(), await own.text()).toBe(200);
    // Event admins preview and download only: both writes on their OWN event are
    // refused by the guard (event_admin_forbidden), with the reason.
    for (const [m, data] of [["put", { config: { labels: { gold: { headline: "Organiser Gold" } } } }], ["delete"]]) {
      const r = await W.eaApi[m](`/api/admin/competitions/${W.mine.id}/certificate-config`, { headers: H(W.eaCsrf), ...(data ? { data } : {}) });
      expect(r.status(), `${m} own event`).toBe(403);
      const b = await r.json();
      expect(b.code).toBe("event_admin_forbidden");
      expect(b.error).toMatch(/Only an administrator/);
    }
    const pv = await W.eaApi.post("/api/admin/certificate-config/preview", { headers: H(W.eaCsrf), data: { competition_id: W.mine.id } });
    expect(pv.status(), "CONTROL: the preview stays open to them").toBe(200);

    for (const [m, u, data] of [
      ["get", `/api/admin/competitions/${W.theirs.id}/certificate-config`],
      ["put", `/api/admin/competitions/${W.theirs.id}/certificate-config`, { config: {} }],
      ["delete", `/api/admin/competitions/${W.theirs.id}/certificate-config`],
      ["post", "/api/admin/certificate-config/preview", { competition_id: W.theirs.id }],
    ]) {
      const r = await W.eaApi[m](u, { headers: H(W.eaCsrf), ...(data ? { data } : {}) });
      expect(r.status(), `${m} ${u} out of scope`).toBe(403);
    }
    expect((await W.eaApi.get("/api/admin/certificate-config")).status(), "global is administrator-only").toBe(403);
    expect((await W.eaApi.put("/api/admin/certificate-config", { headers: H(W.eaCsrf), data: { config: {} } })).status()).toBe(403);
    // CONTROL: the out-of-scope event's design was not touched by any of that.
    const theirs = await (await W.sa.get(`/api/admin/competitions/${W.theirs.id}/certificate-config`)).json();
    expect(theirs.overridden).toBe(false);
    const mine = await (await W.sa.get(`/api/admin/competitions/${W.mine.id}/certificate-config`)).json();
    expect(mine.overridden, "nor was their own").toBe(false);
  });

  test("strict over HTTP: a refused save is a named 400 and stores nothing", async () => {
    const before = await (await W.sa.get("/api/admin/certificate-config")).json();
    for (const [data, code] of [
      [{ config: { colors: { gold: "gold" } } }, "certificate_config_bad_colour"],
      [{ config: { text: { slogan: "x" } } }, "certificate_config_unknown_key"],
      [{ config: { text: { title: "x" } }, extra: 1 }, "certificate_config_unknown_key"],
      [{ config: [] }, "certificate_config_not_object"],
      [{}, "certificate_config_not_object"],
      // Sweep #56: wording the fonts cannot draw, and a headline placeholder.
      [{ config: { text: { title: "სერტიფიკატი" } } }, "certificate_config_undrawable"],
      [{ config: { text: { hub_line: "{platform} شهادة" } } }, "certificate_config_undrawable"],
      [{ config: { labels: { gold: { headline: "{platform}" } } } }, "certificate_config_unknown_token"],
    ]) {
      const r = await W.sa.put("/api/admin/certificate-config", { headers: H(W.saCsrf), data });
      expect(r.status(), JSON.stringify(data)).toBe(400);
      expect((await r.json()).code).toBe(code);
      const ev = await W.sa.put(`/api/admin/competitions/${W.mine.id}/certificate-config`, { headers: H(W.saCsrf), data });
      expect(ev.status(), `event ${JSON.stringify(data)}`).toBe(400);
    }
    expect(await (await W.sa.get("/api/admin/certificate-config")).json(), "nothing was stored").toEqual(before);
    // The preview is a write door's twin: the same named refusal.
    const pv = await W.sa.post("/api/admin/certificate-config/preview", { headers: H(W.saCsrf), data: { config: { text: { title: "სერტიფიკატი" } } } });
    expect(pv.status()).toBe(400);
    expect((await pv.json()).code).toBe("certificate_config_undrawable");
  });

  test("merge precedence as the routes report it, and the History entry", async () => {
    try {
      const g = await W.sa.put("/api/admin/certificate-config", { headers: H(W.saCsrf), data: { config: { text: { title: "GLOBAL TITLE", lead_in: "GLOBAL LEAD" } } } });
      expect(g.status(), await g.text()).toBe(200);
      const e = await W.sa.put(`/api/admin/competitions/${W.mine.id}/certificate-config`, { headers: H(W.saCsrf), data: { config: { text: { title: "EVENT TITLE" } } } });
      const eb = await e.json();
      expect(eb.override).toEqual({ text: { title: "EVENT TITLE" } });
      expect(eb.inherited.text.title).toBe("GLOBAL TITLE");
      expect(eb.effective.text.title, "event beats global").toBe("EVENT TITLE");
      expect(eb.effective.text.lead_in, "global beats default").toBe("GLOBAL LEAD");
      const other = await (await W.sa.get(`/api/admin/competitions/${W.theirs.id}/certificate-config`)).json();
      expect(other.effective.text.title, "an event without an override inherits the global").toBe("GLOBAL TITLE");
      const list = await (await W.sa.get("/api/admin/competitions")).json();
      const rows = Array.isArray(list) ? list : (list.competitions || []);
      const mineRow = rows.find(c => c.id === W.mine.id);
      expect(mineRow.certificate_config_overridden).toBe(true);
      expect(mineRow.certificate_config, "the raw layer is not on the list").toBeUndefined();
      expect(rows.find(c => c.id === W.theirs.id).certificate_config_overridden).toBe(false);

      const del = await (await W.sa.delete(`/api/admin/competitions/${W.mine.id}/certificate-config`, { headers: H(W.saCsrf) })).json();
      expect(del.overridden).toBe(false);
      expect(del.effective.text.title, "cleared: back to the global").toBe("GLOBAL TITLE");
      const ev = await (await W.sa.get(`/api/admin/competitions/${W.mine.id}/events?limit=50`)).json();
      const types = (ev.events || ev || []).map(x => x.event_type);
      expect(types.filter(t => t === "certificate_config_changed").length, "both writes are on the event's History").toBeGreaterThanOrEqual(2);
    } finally {
      await W.sa.delete("/api/admin/certificate-config", { headers: H(W.saCsrf) });
      await W.sa.delete(`/api/admin/competitions/${W.mine.id}/certificate-config`, { headers: H(W.saCsrf) });
    }
    expect((await (await W.sa.get("/api/admin/certificate-config")).json()).global).toEqual(DEFAULT_GLOBAL);
  });

  test("preview: a PNG of the design, writing nothing", async () => {
    const Database = require("better-sqlite3");
    const counts = () => {
      const d = new Database(TEST_DB_PATH, { readonly: true });
      try { return ["achievement_badges", "images", "settings", "competition_events"].map(t => d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c); }
      finally { d.close(); }
    };
    const before = counts();
    const r1 = await W.sa.post("/api/admin/certificate-config/preview", { headers: H(W.saCsrf), data: { sample: { tier: "silver", name: "Preview Person" } } });
    expect(r1.status(), await r1.text()).toBe(200);
    expect(r1.headers()["content-type"]).toContain("image/png");
    expect(r1.headers()["cache-control"]).toContain("no-store");
    const b1 = await r1.body();
    expect(b1.slice(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const r2 = await W.sa.post("/api/admin/certificate-config/preview", { headers: H(W.saCsrf), data: { sample: { tier: "silver", name: "Preview Person" }, config: { colors: { silver: "#9999FF" } } } });
    expect(r2.status()).toBe(200);
    expect(sha(await r2.body()), "the unsaved layer changes the render").not.toBe(sha(b1));
    const r3 = await W.eaApi.post("/api/admin/certificate-config/preview", { headers: H(W.eaCsrf), data: { competition_id: W.mine.id, sample: { tier: "completion" } } });
    expect(r3.status(), "an event admin previews their own event").toBe(200);
    expect(counts(), "no badge, image, setting or event row was written").toEqual(before);

    for (const [data, code] of [
      [{ config: { show: { qr: "no" } } }, "certificate_config_bad_type"],
      [{ sample: { tier: "platinum" } }, "certificate_config_bad_type"],
      [{ sample: { name: 5 } }, "certificate_config_bad_type"],
      [{ sample: { colour: "x" } }, "certificate_config_unknown_key"],
      [{ theme: 1 }, "certificate_config_unknown_key"],
    ]) {
      const r = await W.sa.post("/api/admin/certificate-config/preview", { headers: H(W.saCsrf), data });
      expect(r.status(), JSON.stringify(data)).toBe(400);
      expect((await r.json()).code).toBe(code);
    }
    expect((await W.sa.post("/api/admin/certificate-config/preview", { headers: H(W.saCsrf), data: { competition_id: "nope" } })).status()).toBe(404);
  });

  test("a save over somebody else's newer save is refused (expectedVersion), never a silent wipe", async () => {
    for (const [label, url] of [["global", "/api/admin/certificate-config"], ["event", `/api/admin/competitions/${W.mine.id}/certificate-config`]]) {
      // Two designers open the same layer.
      const opened = await (await W.sa.get(url)).json();
      expect(typeof opened.version, `${label}: the read carries a version`).toBe("string");
      // B saves first.
      const b = await W.sa.put(url, { headers: H(W.saCsrf), data: { config: { labels: { gold: { sub: `B-${label}` } } }, expectedVersion: opened.version } });
      expect(b.status(), `${label}: B's save with the version it read: ${await b.text()}`).toBe(200);
      const afterB = await b.json();
      expect(afterB.version, `${label}: a save moves the version`).not.toBe(opened.version);
      // A saves from the copy it opened: refused, and B's field survives BY VALUE.
      const a = await W.sa.put(url, { headers: H(W.saCsrf), data: { config: { text: { title: `A-${label}` } }, expectedVersion: opened.version } });
      expect(a.status(), `${label}: a stale save is refused`).toBe(409);
      const ab = await a.json();
      expect(ab.code).toBe("certificate_config_changed");
      expect(ab.version, `${label}: the refusal hands back the current version`).toBe(afterB.version);
      const now = await (await W.sa.get(url)).json();
      expect(now.effective.labels.gold.sub, `${label}: B's change is still stored`).toBe(`B-${label}`);
      expect(now.effective.text.title, `${label}: A's change was not stored`).not.toBe(`A-${label}`);
      // CONTROL: with the current version A's save is accepted.
      const a2 = await W.sa.put(url, { headers: H(W.saCsrf), data: { config: { ...((label === "global" ? now.global : now.override) || {}), text: { title: `A-${label}` } }, expectedVersion: now.version } });
      expect(a2.status(), `${label}: the current version saves: ${await a2.text()}`).toBe(200);
      // A wrong-typed version is a named 400, not a skipped check.
      const bad = await W.sa.put(url, { headers: H(W.saCsrf), data: { config: {}, expectedVersion: 7 } });
      expect(bad.status()).toBe(400);
      expect((await bad.json()).field).toBe("expectedVersion");
      expect((await W.sa.delete(url, { headers: H(W.saCsrf) })).ok(), `${label}: reset`).toBeTruthy();
    }
  });

  test("an ended event's design is superadmin-only", async () => {
    const ended = await makeCompetition(W.sa, W.saCsrf, "ccended", {
      start_time: new Date(Date.now() - 3 * 86400e3).toISOString(), duration_minutes: 60,
    });
    const adm = await makeParticipant(W.sa, W.saCsrf, "ccadm2");
    expect((await W.sa.post(`/api/admin/participants/${adm.id}/role`, { headers: H(W.saCsrf), data: { role: "admin" } })).ok()).toBeTruthy();
    const a = await apiLogin(adm.email, PARTICIPANT_PASS);
    try {
      const r = await a.api.put(`/api/admin/competitions/${ended.id}/certificate-config`, { headers: H(a.csrf), data: { config: { text: { title: "LATE EDIT" } } } });
      expect(r.status()).toBe(403);
      expect((await r.json()).code).toBe("certificate_config_ended_locked");
      // CONTROL: the same admin on a live event is allowed.
      expect((await a.api.put(`/api/admin/competitions/${W.mine.id}/certificate-config`, { headers: H(a.csrf), data: { config: {} } })).status()).toBe(200);
    } finally { await a.api.dispose(); }
    const s = await W.sa.put(`/api/admin/competitions/${ended.id}/certificate-config`, { headers: H(W.saCsrf), data: { config: { text: { title: "SA EDIT" } } } });
    expect(s.status(), "a superadmin may").toBe(200);
  });

  test("the MINTED certificate follows the event's design live; its facts do not move", async () => {
    test.setTimeout(180_000);
    const { api, csrf } = await apiLogin("superadmin");
    const label = `ccm${Date.now().toString(36)}`;
    const email = `${label}@company.example`;
    try {
      const reg = await registerPost(api, "/api/register", { headers: H(csrf), data: { firstName: "Cert", lastName: "Holder", nickname: label, email, company: "Acme",
        title: "Engineer", country: "US", timezone: "America/New_York", jobFunction: "Software Developer / Engineer", city: "Testville" } });
      expect(reg.status(), await reg.text()).toBe(200);
      const u = ((await (await api.get("/api/admin/participants?limit=5000")).json()).participants || []).find(p => p.email === email);
      expect(u).toBeTruthy();
      await api.post(`/api/admin/participants/${u.id}/verify`, { headers: H(csrf) });
      await api.post(`/api/admin/participants/${u.id}/approve`, { headers: H(csrf) });
      const cr = await api.post("/api/admin/competitions", { headers: H(csrf), data: { name: `${label} cert`, event_kind: "program", timezone: "UTC",
        start_time: new Date(Date.now() - 3600e3).toISOString(), deadline_at: new Date(Date.now() + 90 * 86400e3).toISOString() } });
      expect(cr.ok(), await cr.text()).toBeTruthy();
      const comp = (await cr.json()).competition;
      const tr = await api.post("/api/admin/tasks", { headers: H(csrf), data: { title: `${label} T`, description: "d", difficulty: "easy", answer_type: "text", correct_answer: "right", status: "published" } });
      const taskId = (await tr.json()).id;
      expect((await api.post(`/api/admin/tasks/${taskId}/competitions`, { headers: H(csrf), data: { competitionIds: [comp.id] } })).ok()).toBeTruthy();
      const asg = await api.post("/api/admin/competitions/assign", { headers: H(csrf), data: { userIds: [u.id], competitionIds: [comp.id] } });
      expect((await asg.json()).assigned).toBe(1);

      const { api: pa, csrf: c1 } = await freshCtx();
      let token;
      try {
        expect((await codeLogin(pa, email, H(c1))).ok()).toBeTruthy();
        const pc = (await (await pa.get("/api/csrf-token")).json()).csrfToken;
        expect((await pa.post("/api/select-competition", { headers: H(pc), data: { competitionId: comp.id } })).ok()).toBeTruthy();
        const view = await (await pa.get(`/api/tasks/${taskId}`)).json();
        const sub = await pa.post(`/api/tasks/${taskId}/submit`, { headers: { "x-csrf-token": pc }, multipart: { answer: "right", gradingHash: view.grading_hash || "" } });
        expect((await sub.json()).correct).toBe(true);
        const mint = await pa.post(`/api/competitions/${comp.id}/badge`, { headers: { "x-csrf-token": pc } });
        expect(mint.ok(), await mint.text()).toBeTruthy();
        token = (await mint.json()).token;
      } finally { await pa.dispose(); }

      const pdf = async () => { const r = await api.get(`/badge/${token}/certificate.pdf`); expect(r.ok()).toBeTruthy(); return sha(await r.body()); };
      const base = await pdf();
      expect(await pdf(), "CONTROL: the certificate renders deterministically").toBe(base);
      const put = await api.put(`/api/admin/competitions/${comp.id}/certificate-config`, { headers: H(csrf), data: { config: { text: { title: "CERTIFICATE OF COMPLETION" } } } });
      expect(put.status(), await put.text()).toBe(200);
      const skinned = await pdf();
      expect(skinned, "the issued certificate follows the event's design").not.toBe(base);
      expect((await api.delete(`/api/admin/competitions/${comp.id}/certificate-config`, { headers: H(csrf) })).ok()).toBeTruthy();
      expect(await pdf(), "…and returns to the inherited design when the override is cleared").toBe(base);
    } finally { await api.dispose(); }
  });
});
