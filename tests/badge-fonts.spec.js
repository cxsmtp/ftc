// v8.1.0 — PR 24: the badge fonts resolve every weight, and cover Cyrillic.
//
// THIS FILE EXISTS BECAUSE OF A DEFECT NOTHING ELSE COULD SEE. From v7.1.0 until
// this release, every badge and every certificate rendered entirely in Inter
// **Regular** — the SVG authors `font-weight` 400/600/700/800 and all four
// produced a byte-identical image.
//
// The mechanism is in the font binaries, not the code. The SVG asks for
// `font-family="Inter"`; the three shipped files declared families `Inter` (400),
// `Inter SemiBold` (600) and `Inter ExtraBold` (800) and carried NO typographic
// family names (name IDs 16/17 absent). So "Inter" matched only the 400 file, and
// the other two — ~300 KB, loaded into resvg on every single render — were
// unreachable. Builds that carry id16="Inter" / id17="ExtraBold" resolve properly.
//
// No behavioural test in the suite could catch that: every badge assertion
// compares a fresh render against another fresh render, so both sides were
// equally wrong. The witness has to be that DIFFERENT WEIGHTS PRODUCE DIFFERENT
// PIXELS, which is asserted below, plus the structural cause in the name table so
// a future font swap that loses id16/17 fails with the reason attached.
const { test, expect } = require("./isolated-test");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const FONT_DIR = path.join(__dirname, "..", "lib", "fonts", "badge");

/** Windows-Unicode `name` records, by nameID. */
function nameTable(file) {
  const b = fs.readFileSync(file);
  const tabs = {};
  const n = b.readUInt16BE(4);
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    tabs[b.toString("ascii", o, o + 4).trim()] = { off: b.readUInt32BE(o + 8) };
  }
  const t = tabs.name.off;
  const count = b.readUInt16BE(t + 2);
  const strOff = t + b.readUInt16BE(t + 4);
  const out = {};
  for (let i = 0; i < count; i++) {
    const r = t + 6 + i * 12;
    if (b.readUInt16BE(r) !== 3 || b.readUInt16BE(r + 2) !== 1) continue;   // Windows / Unicode BMP
    const nid = b.readUInt16BE(r + 6), len = b.readUInt16BE(r + 8), off = b.readUInt16BE(r + 10);
    if (out[nid] === undefined) out[nid] = Buffer.from(b.slice(strOff + off, strOff + off + len)).swap16().toString("utf16le");
  }
  return { names: out, weight: b.readUInt16BE(tabs["OS/2"].off + 4), variable: !!tabs.fvar };
}

test.describe("v8.1.0 — badge font resolution", () => {
  test("each shipped weight is a distinct STATIC font at the weight its filename claims", () => {
    for (const [file, want] of [["inter-regular.ttf", 400], ["inter-semibold.ttf", 600], ["inter-extrabold.ttf", 800]]) {
      const { names, weight, variable } = nameTable(path.join(FONT_DIR, file));
      expect(weight, `${file} declares usWeightClass ${want}`).toBe(want);
      // resvg ignores the variable axis, so a variable font would silently render
      // one instance for every weight — the same failure with a different cause.
      expect(variable, `${file} is a STATIC instance, not a variable font`).toBe(false);
      if (want !== 400) {
        // THE STRUCTURAL CAUSE OF THE ORIGINAL DEFECT. Without id16/id17 the
        // family is "Inter SemiBold"/"Inter ExtraBold", which the SVG's
        // font-family="Inter" can never match.
        expect(names[16], `${file} carries the typographic family name, or font-family="Inter" cannot reach it`).toBe("Inter");
        expect(names[17], `${file} carries its typographic subfamily`).toBeTruthy();
      }
    }
  });

  test("the pipeline really renders four weights as three different images", async () => {
    // The behavioural witness. Pre-fix this produced ONE hash four times.
    const badge = require("../lib/badge.js");
    const svg = (w) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="90"><rect width="600" height="90" fill="#fff"/>` +
      `<text x="20" y="60" font-family="Inter" font-size="42" font-weight="${w}" fill="#000">Handgloves</text></svg>`;
    const hash = {};
    for (const w of [400, 600, 700, 800]) {
      const png = await badge.renderBadgePng(svg(w));
      hash[w] = crypto.createHash("sha256").update(png).digest("hex");
    }
    expect(hash[400], "Regular and SemiBold must not render identically").not.toBe(hash[600]);
    expect(hash[600], "SemiBold and ExtraBold must not render identically").not.toBe(hash[800]);
    // 700 has no file of its own and resolves to the nearest, which is 800. Pinned
    // as the KNOWN state rather than left ambiguous: the design uses 700 in places,
    // and if a Bold file is ever added this assertion is what says so out loud.
    expect(hash[700], "700 has no shipped file and resolves to ExtraBold").toBe(hash[800]);
  });

  test("every shipped script renders; a script no face draws still falls back, so the prompt has a job", () => {
    const { canRenderText } = require("../lib/badge.js");
    // The reason PR 24 touched the fonts at all: a Cyrillic name used to rasterise
    // as blank boxes, so `canRenderText` refused it and the certificate carried the
    // participant's nickname instead of their name.
    expect(canRenderText("Мария Иванова"), "Cyrillic").toBe(true);
    expect(canRenderText("Γεώργιος Παπαδόπουλος"), "Greek").toBe(true);
    expect(canRenderText("Łukasz Żółć"), "latin-ext, unchanged").toBe(true);
    expect(canRenderText("Jane Doe"), "latin, unchanged").toBe(true);
    // The fallback faces (operator ruling, 14 Nov 2026).
    for (const [script, name] of [["Chinese", "张伟"], ["Japanese", "田中太郎"], ["Japanese kana", "さくら"],
      ["Korean", "김민준"], ["Hebrew", "דוד כהן"], ["Arabic", "محمد علي"], ["Persian, with a ZWNJ", "محمد\u200Cرضا"],
      ["Thai", "สมชาย ใจดี"], ["Thai, with SARA AM", "กำพล จำเนียร"], ["Chinese, with Latin the CJK face draws", "Dr. 张伟"]]) {
      expect(canRenderText(name), `${script} is covered`).toBe(true);
      // CONTROL: Inter alone (the coverage a certificate frozen with the nickname
      // keeps) still cannot draw it, so it is the faces that answer.
      expect(canRenderText(name, { fallbackFaces: false }), `${script} is not Inter's`).toBe(false);
    }
    expect(canRenderText("Мария Иванова", { fallbackFaces: false }), "CONTROL: Inter alone draws Cyrillic").toBe(true);
    // Still uncovered — which is exactly why the non-Latin prompt exists. If a
    // future face covers these, this test should be updated deliberately rather
    // than the prompt quietly becoming unreachable.
    expect(canRenderText("გიორგი ბერიძე"), "Georgian is NOT covered").toBe(false);
    expect(canRenderText("முருகன்"), "Tamil is NOT covered").toBe(false);
    expect(canRenderText("Jane 😀"), "an emoji is NOT covered").toBe(false);
    // resvg cannot shape Devanagari (it advances a cluster by its widest glyph:
    // राहुल printed as रहुल), so no face for it ships and such a name falls back.
    expect(canRenderText("राहुल शर्मा"), "Devanagari is NOT covered").toBe(false);
    // A spacing mark (Mc) shares its base's cluster, so resvg overlaps it with the
    // next letter: the CJK face's Hangul tone mark is the one any face carries.
    expect(canRenderText("김\u302E민준"), "a spacing mark is NOT drawable").toBe(false);
    expect(canRenderText("김민준"), "CONTROL: the same name without it is").toBe(true);
  });

  test("a Cyrillic name reaches the certificate instead of falling back to the nickname", async () => {
    const badge = require("../lib/badge.js");
    const png = await badge.renderBadgePng(badge.buildCertificateSvg({
      rank: 1, displayName: "Мария Иванова", competitionName: "Dev & Sec Day",
      dateLabel: "14 Aug 2026", scoreLabel: "300 pts", platformName: "Checkmarx Enablement Platform",
    }));
    expect(png.slice(0, 8).toString("hex"), "a real PNG").toBe("89504e470d0a1a0a");
    // A blank-box render is still a valid PNG, so size alone proves nothing — the
    // discriminating assertion is that the Cyrillic render DIFFERS from the same
    // certificate with the name removed. Equal would mean nothing was drawn.
    const blank = await badge.renderBadgePng(badge.buildCertificateSvg({
      rank: 1, displayName: "", competitionName: "Dev & Sec Day",
      dateLabel: "14 Aug 2026", scoreLabel: "300 pts", platformName: "Checkmarx Enablement Platform",
    }));
    expect(crypto.createHash("sha256").update(png).digest("hex"),
      "the Cyrillic name is actually drawn, not silently dropped")
      .not.toBe(crypto.createHash("sha256").update(blank).digest("hex"));
  });

  test("the CERTIFICATE name overrides the profile name, and only when BOTH parts are set", () => {
    const { certificateName, certificateNameParts } = require("../lib/badge.js");
    const profile = { personalTitle: "Dr.", firstName: "Jane", lastName: "Doe" };

    expect(certificateName(profile), "no certificate name → the profile name").toBe("Dr. Jane Doe");
    expect(certificateName({ ...profile, certificateGivenName: "Jane Elizabeth", certificateFamilyName: "Doe-Smith" }),
      "both parts set → the certificate name wins, salutation kept").toBe("Dr. Jane Elizabeth Doe-Smith");

    // HALF-FILLED FALLS BACK ENTIRELY. Mixing a certificate given name with a
    // profile surname is the one combination nobody typed and nobody could
    // predict, so it must never be assembled.
    expect(certificateName({ ...profile, certificateGivenName: "Only Given" }),
      "given only → profile name, NOT a mixture").toBe("Dr. Jane Doe");
    expect(certificateName({ ...profile, certificateFamilyName: "Only Family" }),
      "family only → profile name, NOT a mixture").toBe("Dr. Jane Doe");
    // Whitespace is not a value.
    expect(certificateName({ ...profile, certificateGivenName: "   ", certificateFamilyName: "Doe-Smith" }),
      "blank given → profile name").toBe("Dr. Jane Doe");

    // A salutation alone names nobody — unchanged from v7.21.27.
    expect(certificateName({ personalTitle: "Prof." })).toBe("");

    // The PARTS the credential lookup will match against come from the same
    // resolver, so the printed name and the matched surname cannot diverge —
    // which is the whole failure `name_match_snapshot` exists to prevent.
    expect(certificateNameParts(profile)).toEqual({ given: "Jane", family: "Doe" });
    expect(certificateNameParts({ ...profile, certificateGivenName: "Jane Elizabeth", certificateFamilyName: "Doe-Smith" }))
      .toEqual({ given: "Jane Elizabeth", family: "Doe-Smith" });
    expect(certificateNameParts({ personalTitle: "Prof." }),
      "no usable name is NULL, so a caller must decide rather than storing an empty match key").toBeNull();
    // The salutation is NOT a match part — with two inputs it never becomes a
    // guessable token, which is the entire reason Q4 chose two fields over one.
    //
    // Asserted by SUBSTRING, not membership: the first version used
    // `expect(Object.values(parts)).not.toContain("Dr.")`, and `toContain` on an
    // array is exact-element membership — so a salutation PREFIXED onto the given
    // name (`"Dr. Jane"`) sailed straight past it. Mutation-verified only after
    // this was fixed.
    for (const [k, v] of Object.entries(certificateNameParts(profile))) {
      expect(v, `the salutation must not appear in the ${k} match part`).not.toMatch(/Dr\.?/i);
      expect(v, `the ${k} match part is a single name part, not an assembled phrase`).not.toContain(" ");
    }
  });
});

// The Noto fallback faces (operator ruling, 14 Nov 2026), byte for byte the files
// SOURCES-noto.txt records. A swapped or re-downloaded binary fails here by name.
const NOTO = {
  "noto-sans-arabic-bold.ttf": { sha: "f4cb79f842a07d1bcf597879574358fb7010f73761396d1d0f2445dfedb4d2ca", copyright: "The Noto Project Authors (https://github.com/notofonts/arabic)" },
  "noto-sans-hebrew-bold.ttf": { sha: "dfdb3056de1f4542b888c77a1a8a750548a802e271479f56e52152423b64dde8", copyright: "The Noto Project Authors (https://github.com/notofonts/hebrew)" },
  "noto-sans-thai-bold.ttf": { sha: "5227602d7f9108252cfb7d75d6f7b2a26bdb2fc2fa89a702f9063758fb2f86c7", copyright: "The Noto Project Authors (https://github.com/notofonts/thai)" },
  "noto-sans-cjk-sc-bold.otf": { sha: "b5f0d1a190a7f9b43c310a8850630af12553df32c4c050543f9059732d9b4c0a", copyright: "Adobe (http://www.adobe.com/)" },
};

// Operator ruling, 29 Oct 2026 — ONE FAMILY on the certificate: Inter (the open
// fallback for the platform's Aptos), SIL OFL 1.1 with the licence beside the
// files. The serif is gone, and nothing may still ask for it. Operator ruling,
// 14 Nov 2026: Noto faces draw the scripts Inter lacks.
test.describe("the certificate is set in Inter, with Noto for the scripts Inter lacks", () => {
  test("the three Inter faces and the four Noto faces ship, recorded, with their OFL licences", () => {
    const badge = require("../lib/badge.js");
    const files = fs.readdirSync(FONT_DIR).filter(f => /\.(ttf|otf)$/.test(f)).sort();
    expect(files).toEqual(["inter-extrabold.ttf", "inter-regular.ttf", "inter-semibold.ttf", ...Object.keys(NOTO)].sort());
    // Every face on disk is one the renderer loads, in the order it falls back.
    expect(badge.FALLBACK_FACES.map(f => f.file), "the renderer's fallback list is exactly these faces")
      .toEqual(["noto-sans-arabic-bold.ttf", "noto-sans-hebrew-bold.ttf", "noto-sans-thai-bold.ttf", "noto-sans-cjk-sc-bold.otf"]);
    const lic = fs.readFileSync(path.join(FONT_DIR, "LICENSE-inter.txt"), "utf8");
    expect(lic, "the licence travels with the files").toContain("SIL Open Font License");
    expect(lic).toContain("The Inter Project Authors");
    const noto = fs.readFileSync(path.join(FONT_DIR, "LICENSE-noto.txt"), "utf8");
    const sources = fs.readFileSync(path.join(FONT_DIR, "SOURCES-noto.txt"), "utf8");
    expect(noto, "the Noto licence travels with the files").toContain("SIL OPEN FONT LICENSE Version 1.1");
    for (const [file, { sha, copyright }] of Object.entries(NOTO)) {
      const got = crypto.createHash("sha256").update(fs.readFileSync(path.join(FONT_DIR, file))).digest("hex");
      expect(got, `${file} is the recorded download`).toBe(sha);
      expect(sources, `SOURCES-noto.txt records ${file}'s checksum`).toContain(`sha256 ${sha}`);
      expect(sources, `SOURCES-noto.txt records ${file}`).toMatch(new RegExp(`^${file.replace(/\./g, "\\.")} \\(`, "m"));
      expect(noto, `LICENSE-noto.txt carries ${file}'s copyright`).toMatch(new RegExp(`${file.replace(/\./g, "\\.")}\\s+Copyright [^\\n]*${copyright.replace(/[.()/]/g, "\\$&")}`));
      // resvg reads the default instance of a variable font whatever the SVG
      // asks; each of these is a static Bold.
      const { weight, variable } = nameTable(path.join(FONT_DIR, file));
      expect(variable, `${file} is static`).toBe(false);
      expect(weight, `${file} is the Bold`).toBe(700);
    }
    // Neither record names a face that no longer ships.
    for (const [doc, text] of [["SOURCES-noto.txt", sources], ["LICENSE-noto.txt", noto]]) {
      const named = [...text.matchAll(/\b(noto-sans-[\w-]+\.(?:ttf|otf))\b/g)].map(m => m[1]);
      expect(named.length, `anti-vacuity: ${doc} names files`).toBeGreaterThan(0);
      expect(named.filter(f => !NOTO[f]), `${doc} names only shipped faces`).toEqual([]);
    }
  });

  // The faces are read by the server alone, so they live outside public/, which
  // anyone may download: serving the 17 MB CJK face would cost a compression per
  // request, for nothing a browser uses.
  test("the badge faces live outside the web root, and the old path serves nothing", async ({ request }) => {
    const ROOT = path.join(__dirname, "..");
    const walk = (dir, out = []) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else out.push(path.relative(ROOT, p));
      }
      return out;
    };
    const publicFiles = walk(path.join(ROOT, "public"));
    expect(publicFiles.length, "anti-vacuity: the walk read public/").toBeGreaterThan(50);
    const shipped = new Set([...fs.readdirSync(FONT_DIR)]);
    expect(publicFiles.filter(f => shipped.has(path.basename(f))), "no badge face or record under public/").toEqual([]);
    expect(publicFiles.filter(f => /\.(ttf|otf)$/i.test(f)), "no TrueType or OpenType file under public/ at all").toEqual([]);
    const { BASE } = require("./helpers");
    for (const file of ["noto-sans-cjk-sc-bold.otf", "inter-extrabold.ttf", "LICENSE-noto.txt"]) {
      const r = await request.get(`${BASE}/vendor/fonts/badge/${file}`);
      expect(r.status(), `/vendor/fonts/badge/${file} is not served`).toBe(404);
    }
    // CONTROL: the browser's own fonts beside it are still served.
    const ok = await request.get(`${BASE}/vendor/fonts/inter-latin.woff2`);
    expect(ok.status(), "the web font is served").toBe(200);
  });

  test("the certificate SVG names no other family, and the name is ExtraBold", () => {
    const badge = require("../lib/badge.js");
    const svg = badge.buildCertificateSvg({
      rank: 1, displayName: "Jane Example", competitionName: "Spring Hack",
      dateLabel: "29 Oct 2026", scoreLabel: "150 pts", platformName: "Hack Arena",
    });
    const families = [...new Set([...svg.matchAll(/font-family="([^"]+)"/g)].map(m => m[1]))];
    expect(families.length, "the walk found text").toBeGreaterThan(0);
    expect(families, "Inter only").toEqual(["Inter"]);
    expect(svg).not.toMatch(/Liberation|font-style="italic"/);
    expect(svg, "the holder's name in ExtraBold").toMatch(/class="cert-name"[^>]*font-weight="800"/);
  });

  // Operator target, 29 Oct 2026: the emailed PDF stays under 400 KB (it was
  // ~690 KB). Colour is rounded to 6 bits per channel in the PDF raster.
  test("a full certificate PDF is under 400 KB, and its raster is 6-bit colour", async () => {
    const badge = require("../lib/badge.js");
    const svg = badge.buildCertificateSvg({
      rank: 1, displayName: "Alexandra Montgomery-Whitfield", competitionName: "Spring Security Capture The Flag 2026",
      dateLabel: "29 Oct 2026", scoreLabel: "450 pts", platformName: "Checkmarx Enablement Platform",
      publicCode: "ABCD2345EFGH", verifyLink: "https://example.test/credential?code=ABCD2345EFGH",
    });
    const pdf = await badge.renderBadgePdf(svg, "Certificate");
    const buf = Buffer.isBuffer(pdf) ? pdf : pdf.pdf;
    expect(buf.slice(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buf.length, `PDF is ${Math.round(buf.length / 1024)} KB`).toBeLessThan(400 * 1024);
    // The quantiser itself: every byte of a tiny raster lands on a 6-bit level.
    const rgba = Buffer.from([1, 2, 3, 255, 250, 254, 255, 255, 128, 129, 130, 255, 0, 64, 191, 255]);
    const tiny = await badge.buildPdfFromRgba(rgba, 2, 2, "t");
    const tb = Buffer.isBuffer(tiny) ? tiny : tiny.pdf;
    const s = tb.toString("latin1");
    const m = /\/ColorSpace \/DeviceRGB[^]*?stream\n/.exec(s);
    expect(m, "the image stream is found").toBeTruthy();
    const start = m.index + m[0].length;
    const raw = require("zlib").inflateSync(tb.subarray(start, s.indexOf("\nendstream", start)));
    expect([...raw]).toEqual([0, 4, 4, 252, 252, 252, 128, 128, 132, 0, 64, 192]);
  });
});


// ── The fallback faces draw the names (operator ruling, 14 Nov 2026) ───────────
//
// Locked by RENDERING. resvg does not fall back glyph by glyph: at the first
// character Inter lacks it reshapes the WHOLE line with the first face that has
// it, keeps that if every glyph matched, else keeps the new glyphs only where
// the glyph count happens to be unchanged, else prints Inter's .notdef boxes.
// So `canRenderText` (lib/badge.js `_drawPlan`) admits a name only when Inter,
// or ONE face, draws all of it; and resvg advances a cluster by its widest
// glyph, so a name must also come out as wide as a real shaper draws it.
test.describe("the Noto faces draw the names Inter cannot", () => {
  const SCRIPTS = [
    ["Chinese", "张伟", "noto-sans-cjk-sc-bold.otf"],
    ["Korean", "김민준", "noto-sans-cjk-sc-bold.otf"],
    ["Arabic", "محمد علي", "noto-sans-arabic-bold.ttf"],
    ["Hebrew", "דוד כהן", "noto-sans-hebrew-bold.ttf"],
    ["Thai", "สมชาย ใจดี", "noto-sans-thai-bold.ttf"],
    ["Thai, with SARA AM", "กำพล จำเนียร", "noto-sans-thai-bold.ttf"],
  ];
  const cert = (displayName) => ({
    rank: 1, displayName, competitionName: "Spring Hack", dateLabel: "14 Nov 2026", scoreLabel: "300 pts",
    platformName: "Hack Arena", publicCode: "ABCD2345EFGH", verifyLink: "https://example.test/credential?code=ABCD2345EFGH",
  });
  const sha = (b) => crypto.createHash("sha256").update(Buffer.isBuffer(b) ? b : b.pdf).digest("hex");
  const interOnly = async (svg) => {
    const { renderAsync } = require("@resvg/resvg-js");
    const badge = require("../lib/badge.js");
    const img = await renderAsync(svg, { font: { fontFiles: badge.FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Inter" }, fitTo: { mode: "width", value: 1536 } });
    return img.asPng();
  };

  test("a name in each added script prints: twice the same, unlike the nickname, drawn by its Noto face", async () => {
    const badge = require("../lib/badge.js");
    const nick = await badge.renderBadgePng(badge.buildCertificateSvg(cert("player4821")));
    for (const [script, name, face] of SCRIPTS) {
      const svg = badge.buildCertificateSvg(cert(name));
      // As the renderer is handed it: Thai SARA AM arrives decomposed (`_resvgText`).
      expect(svg, `${script}: the SVG carries the name itself`).toContain(`>${badge._resvgText(name)}</text>`);
      expect(badge._fontFilesFor(svg).map(f => path.basename(f)), `${script}: the render is handed its face`).toContain(face);
      const a = await badge.renderBadgePng(svg), b = await badge.renderBadgePng(svg);
      expect(sha(a), `${script}: one certificate renders byte-identically twice`).toBe(sha(b));
      expect(sha(a), `${script}: the name is printed, not the nickname`).not.toBe(sha(nick));
      expect(sha(a), `${script}: the Noto face draws it (Inter alone would draw blank boxes)`).not.toBe(sha(await interOnly(svg)));
    }
    // The PDF the email attaches: deterministic too, and naming the person.
    const zh = badge.buildCertificateSvg(cert("张伟"));
    const p1 = await badge.renderBadgePdf(zh, "Certificate"), p2 = await badge.renderBadgePdf(zh, "Certificate");
    expect(sha(p1), "the PDF renders byte-identically twice").toBe(sha(p2));
    expect(sha(p1), "and differs from the nickname's").not.toBe(sha(await badge.renderBadgePdf(badge.buildCertificateSvg(cert("player4821")), "Certificate")));
  });

  // The names a face cannot draw WHOLE. The Arabic face has no Latin letters, and
  // a lam ligature changes the glyph count, so resvg keeps nothing it drew: the
  // certificate would name nobody. No certificate prints such a line: it leaves
  // off a salutation that is all that stands in the way, and prints the nickname
  // for any other mix (lib/badge.js `certificatePrintedName`; locked below).
  test("a name no single face draws whole falls back: resvg would print boxes for it", async () => {
    const badge = require("../lib/badge.js");
    for (const name of ["Dr. محمد علي", "Anna علي", "Ms. فاطمة الزهراء"]) {
      expect(badge.canRenderText(name), `${name} falls back to the nickname`).toBe(false);
      // THE WITNESS: rendered with every face its SVG needs, the certificate is
      // pixel for pixel what Inter alone draws, so the Arabic face drew nothing.
      const svg = badge.buildCertificateSvg(cert(name));
      expect(badge._fontFilesFor(svg).map(f => path.basename(f)), `${name}: the Arabic face was handed`).toContain("noto-sans-arabic-bold.ttf");
      expect(sha(await badge.renderBadgePng(svg)), `${name}: resvg left Inter's boxes`).toBe(sha(await interOnly(svg)));
    }
    // Where a mix happens to keep its glyph count resvg copies glyphs in by
    // position; nothing without a shaper can know that, so these fall back too.
    for (const name of ["Dr. דוד כהן", "ג'ורג' לוי", "Dr. عمر", "ส. สมชาย", "张伟 דוד"]) {
      expect(badge.canRenderText(name), `${name} falls back to the nickname`).toBe(false);
    }
    // CONTROLS: each script alone prints, and so does Latin with CJK, which the
    // CJK face draws whole ("Dr." in its own Latin).
    for (const [name, face] of [["محمد علي", "noto-sans-arabic-bold.ttf"], ["דוד כהן", "noto-sans-hebrew-bold.ttf"],
      ["สมชาย ใจดี", "noto-sans-thai-bold.ttf"], ["Dr. 张伟", "noto-sans-cjk-sc-bold.otf"]]) {
      expect(badge.canRenderText(name), `${name} prints`).toBe(true);
      expect(badge._drawPlan(name).face.file, `${name} is drawn by ${face}`).toBe(face);
    }
    expect(badge._drawPlan("Jane Doe"), "CONTROL: Inter draws a Latin name").toEqual({ face: null });
  });

  // LEGIBILITY, against the reference: Chromium shapes with HarfBuzz. Each sample
  // is the name line exactly as the certificate emits it, drawn by the real
  // pipeline; it must be its face's alone (no Inter glyph, no .notdef box) and as
  // wide as Chromium draws the same name in the same face, within 3%. A cluster
  // resvg advances by its widest glyph comes out narrower (Devanagari measured
  // 78-93%, Thai SARA AM 70-85% before `_resvgText`).
  test("each added script prints as wide as Chromium's shaper draws it, by its face alone", async ({ page }) => {
    test.setTimeout(120_000);
    const { renderAsync } = require("@resvg/resvg-js");
    const badge = require("../lib/badge.js");
    const ORIGIN = "https://badge-fonts.test";
    await page.route(`${ORIGIN}/**`, (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>faces</title>" });
      const face = badge.FALLBACK_FACES.find(f => `/${f.file}` === u.pathname);
      return face ? route.fulfill({ status: 200, contentType: "font/otf", body: fs.readFileSync(face.path) }) : route.fulfill({ status: 404, body: "" });
    });
    await page.goto(`${ORIGIN}/`);
    const S = 140, W = 2400, H = 320;
    const chromium = (file, text) => page.evaluate(async ({ file, text, S, W, H }) => {
      const fam = "F_" + file.replace(/\W/g, "_");
      if (![...document.fonts].some(f => f.family === fam)) {
        const ff = new FontFace(fam, `url(/${file})`, { weight: "700" });
        await ff.load();
        document.fonts.add(ff);
      }
      const c = document.createElement("canvas"); c.width = W; c.height = H;
      const x = c.getContext("2d");
      x.fillStyle = "#fff"; x.fillRect(0, 0, W, H); x.fillStyle = "#000";
      x.font = `700 ${S}px "${fam}"`; x.fillText(text, 40, 220);
      const d = x.getImageData(0, 0, W, H).data;
      let l = W, r = -1;
      for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) if (d[(y * W + X) * 4] < 128) { if (X < l) l = X; if (X > r) r = X; }
      return r - l;
    }, { file, text, S, W, H });
    const line = (content) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>` +
      `<text x="40" y="220" font-family="Inter" font-size="${S}" font-weight="800" fill="#000">${content}</text></svg>`;
    const resvg = async (svg, fontFiles, defaultFontFamily = "Inter") => {
      const img = await renderAsync(svg, { font: { fontFiles, loadSystemFonts: false, defaultFontFamily } });
      // `pixels` is a getter that copies the raster: read it once.
      const px = img.pixels, w = img.width;
      let l = w, r = -1;
      for (let y = 0; y < img.height; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4] < 128) { if (x < l) l = x; if (x > r) r = x; }
      return { width: r - l, sha: sha(img.asPng()) };
    };
    const family = (face) => { const { names } = nameTable(face.path); return names[16] || names[1]; };
    const SAMPLES = [
      ["noto-sans-arabic-bold.ttf", "محمد علي"], ["noto-sans-arabic-bold.ttf", "عبد الله"],
      ["noto-sans-arabic-bold.ttf", "فاطمة الزهراء"], ["noto-sans-arabic-bold.ttf", "محمد\u200Cرضا"],
      ["noto-sans-hebrew-bold.ttf", "דוד כהן"], ["noto-sans-hebrew-bold.ttf", "שָׁלוֹם לֵוִי"],
      ["noto-sans-thai-bold.ttf", "สมชาย ใจดี"], ["noto-sans-thai-bold.ttf", "กำพล จำเนียร"],
      ["noto-sans-thai-bold.ttf", "น้ำ ทำดี"], ["noto-sans-thai-bold.ttf", "อำนาจ ธำรง"],
      ["noto-sans-cjk-sc-bold.otf", "张伟"], ["noto-sans-cjk-sc-bold.otf", "田中 さくら"],
      ["noto-sans-cjk-sc-bold.otf", "김민준"], ["noto-sans-cjk-sc-bold.otf", "Dr. Åsa 张伟"],
    ];
    const seen = new Set();
    for (const [file, name] of SAMPLES) {
      const face = badge.FALLBACK_FACES.find(f => f.file === file);
      seen.add(file);
      expect(badge.canRenderText(name), `PRECONDITION: ${name} is printed`).toBe(true);
      // The name line exactly as the certificate writes it.
      const lines = [...badge.buildCertificateSvg(cert(name)).matchAll(/<text class="cert-name"[^>]*>([^<]*)<\/text>/g)];
      expect(lines.length, `${name} fits one line`).toBe(1);
      const svg = line(lines[0][1]);
      const drawn = await resvg(svg, badge._fontFilesFor(svg));
      expect(drawn.sha, `${name}: the whole line is ${file}'s, with no Inter glyph and no .notdef box`)
        .toBe((await resvg(svg, [face.path], family(face))).sha);
      const ref = await chromium(file, name);
      expect(ref, `${name}: Chromium drew it`).toBeGreaterThan(100);
      expect(drawn.width / ref, `${name}: ${drawn.width}px drawn, Chromium ${ref}px`).toBeGreaterThanOrEqual(0.97);
      expect(drawn.width / ref, `${name}: ${drawn.width}px drawn, Chromium ${ref}px`).toBeLessThanOrEqual(1.03);
    }
    expect([...seen].sort(), "every fallback face is sampled").toEqual(badge.FALLBACK_FACES.map(f => f.file).sort());
    // NEGATIVE CONTROLS: the measure sees an overlapped cluster. SARA AM sent to
    // the renderer as typed, and the Hangul tone mark (Mc, refused above).
    const th = badge.FALLBACK_FACES.find(f => f.file === "noto-sans-thai-bold.ttf");
    const raw = await resvg(line("กำพล จำเนียร"), [...badge.FONT_FILES, th.path]);
    expect(raw.width / await chromium(th.file, "กำพล จำเนียร"), "SARA AM as typed overlaps").toBeLessThan(0.95);
    const cjk = badge.FALLBACK_FACES.find(f => f.file === "noto-sans-cjk-sc-bold.otf");
    const mc = await resvg(line("김\u302E민준"), [...badge.FONT_FILES, cjk.path]);
    expect(mc.width / await chromium(cjk.file, "김\u302E민준"), "a spacing mark overlaps").toBeLessThan(0.97);
  });

  test("a Latin, Greek or Cyrillic certificate is handed Inter alone, exactly as before", () => {
    const badge = require("../lib/badge.js");
    for (const name of ["Jane Doe", "Łukasz Żółć", "Мария Иванова", "Γεώργιος Παπαδόπουλος", "Jane\u200DDoe"]) {
      expect(badge._fontFilesFor(badge.buildCertificateSvg(cert(name))), JSON.stringify(name)).toEqual(badge.FONT_FILES);
      expect(badge._nameExtentEm(name), `${name}: the name slot is Inter's`).toEqual({ above: 0, below: 0 });
    }
    // A space Inter lacks never needs a face: resvg draws it with Inter's own
    // space (the name fitter folds spaces, so this SVG carries one itself).
    const ws = `<svg xmlns="http://www.w3.org/2000/svg"><text font-family="Inter">Jane\u3000Doe\u00A0X</text></svg>`;
    expect(ws, "the SVG really carries the ideographic space").toContain("\u3000");
    expect(badge._fontFilesFor(ws), "an ideographic space is Inter's").toEqual(badge.FONT_FILES);
    // CONTROL: the selection really reads the SVG.
    expect(badge._fontFilesFor(badge.buildCertificateSvg(cert("张伟"))).length).toBe(badge.FONT_FILES.length + 1);
  });

  // Each face's `asc`/`desc` (lib/badge.js FALLBACK_FACES) is what the name slot
  // makes room for, so it must hold the ink the shipped binary really draws for
  // the script's tallest and deepest letters and marks, and for the Latin the CJK
  // face draws in a line it draws whole.
  test("each face's declared reach holds the ink it draws", async () => {
    const { renderAsync } = require("@resvg/resvg-js");
    const badge = require("../lib/badge.js");
    const SAMPLES = {
      "noto-sans-arabic-bold.ttf": { plain: ["محمد علي", "إبراهيم", "يوسف جيهان", "ڪ ڳ ڱ ۓ", "گلشن", "پرویز"], marked: ["مُحَمَّدٌ", "عَلِيّ بْنُ أَبِي طَالِب"] },
      "noto-sans-hebrew-bold.ttf": { plain: ["דוד כהן", "ץףןךק", "שָׁלוֹם", "יִצְחָק", "לֵוִי"] },
      "noto-sans-thai-bold.ttf": { plain: ["สมชาย ใจดี", "น้ำ", "ปิ่น", "ตู้", "ฎฏฐ", "กั๊ก", "ปู่", "กำพล"] },
      "noto-sans-cjk-sc-bold.otf": { plain: ["张伟", "龍驤", "鬱", "김민준", "さくら", "髙橋", "Dr. Åsa Gyp 张伟", "ÉÅÇ ỗ 张", "gjpqy 张", "【张伟】（Wei）"] },
    };
    const S = 200, BASELINE = 400, H = 700, W = 3600;
    for (const face of badge.FALLBACK_FACES) {
      const s = SAMPLES[face.file];
      expect(s, `${face.file} has samples`).toBeTruthy();
      for (const [kind, list] of [["plain", s.plain], ["marked", s.marked || []]]) {
        for (const text of list) {
          // The sample must be one the face draws whole, as a name would be.
          expect(badge._drawPlan(text) && badge._drawPlan(text).face, `${face.file} "${text}" is drawn by it`).toBe(face);
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>` +
            `<text x="${W / 2}" y="${BASELINE}" text-anchor="middle" font-family="Inter" font-size="${S}" font-weight="800" fill="#000">${badge._resvgText(text)}</text></svg>`;
          const img = await renderAsync(svg, { font: { fontFiles: [...badge.FONT_FILES, face.path], loadSystemFonts: false, defaultFontFamily: "Inter" } });
          // `pixels` is a getter that copies the raster: read it once.
          const px = img.pixels, w = img.width;
          let top = H, bot = 0;
          for (let y = 0; y < img.height; y++) for (let x = 0; x < w; x++) {
            if (px[(y * w + x) * 4] < 128) { if (y < top) top = y; if (y > bot) bot = y; }
          }
          expect(bot, `${text} drew something`).toBeGreaterThan(top);
          const asc = kind === "marked" ? face.markAsc : face.asc;
          expect((BASELINE - top) / S, `${face.file} "${text}" reaches no higher than ${asc} em`).toBeLessThanOrEqual(asc + 0.01);
          expect((bot - BASELINE) / S, `${face.file} "${text}" reaches no lower than ${face.desc} em`).toBeLessThanOrEqual(face.desc + 0.01);
        }
      }
    }
  });

  // The fitters size a name from `measureText`, so a name in an added script must
  // be measured by the face that draws it: an under-estimate lets a long name
  // overflow its column. Measured against the ink resvg really draws.
  test("a name in an added script is measured at least as wide as it is drawn", async () => {
    const { renderAsync } = require("@resvg/resvg-js");
    const badge = require("../lib/badge.js");
    const S = 100;
    for (const [script, name] of [...SCRIPTS, ["Japanese", "田中太郎"], ["long Chinese", "欧阳娜娜张伟王芳李娜刘洋"], ["Chinese with Latin", "Dr. Åsa Gyp 张伟"]]) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="300"><rect width="3000" height="300" fill="#fff"/>` +
        `<text x="100" y="200" font-family="Inter" font-size="${S}" font-weight="800" letter-spacing="-1" fill="#000">${badge._resvgText(name)}</text></svg>`;
      const img = await renderAsync(svg, { font: { fontFiles: badge._fontFilesFor(svg), loadSystemFonts: false, defaultFontFamily: "Inter" } });
      const px = img.pixels, w = img.width;
      let l = w, r = 0;
      for (let y = 0; y < img.height; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4] < 128) { if (x < l) l = x; if (x > r) r = x; }
      expect(r, `${script}: something was drawn`).toBeGreaterThan(l);
      expect(badge._measureText(name, S, 800, -1), `${script} "${name}": the estimate covers the ${r - l}px drawn`).toBeGreaterThanOrEqual(r - l);
    }
  });

  // The geometry the reach is for, measured in pixels on both canvases: the name's
  // ink (isolated by re-colouring the name and diffing the renders) ends above the
  // lead-in's, and starts below "PRESENTED TO".
  test("a deep script's name clears the lines above and below it, on the certificate and the share card", async () => {
    const { renderAsync } = require("@resvg/resvg-js");
    const badge = require("../lib/badge.js");
    // `pixels` is a getter that copies the raster: read it once per render.
    const raster = async (svg) => {
      const img = await renderAsync(svg, { font: { fontFiles: badge._fontFilesFor(svg), loadSystemFonts: false, defaultFontFamily: "Inter" } });
      return { px: img.pixels, width: img.width };
    };
    // Rows where two renders differ: the ink of the one element re-coloured.
    const inkRows = (a, b) => {
      let top = Infinity, bot = -Infinity;
      const A = a.px, B = b.px;
      for (let i = 0; i < A.length; i += 4) {
        if (A[i] !== B[i] || A[i + 1] !== B[i + 1] || A[i + 2] !== B[i + 2]) {
          const y = Math.floor(i / 4 / a.width);
          if (y < top) top = y; if (y > bot) bot = y;
        }
      }
      return { top, bot };
    };
    const recolour = (svg, re) => {
      const out = svg.replace(re, (m) => m.replace(/fill="[^"]*"/, 'fill="#00FF00"'));
      expect(out, `the element ${re} was found to re-colour`).not.toBe(svg);
      return out;
    };
    const CANVASES = [
      ["certificate", (n) => badge.buildCertificateSvg(cert(n)), /<text class="cert-name"[^>]*>/g, /<text[^>]*>FOR SUCCESSFULLY COMPLETING THE<\/text>/, /<text[^>]*>PRESENTED TO<\/text>/],
      ["share card", (n) => badge.buildBadgeSvg(cert(n)), /<text x="430"[^>]*fill="#FFFFFF">/g, /<text[^>]*>FOR SUCCESSFULLY COMPLETING THE<\/text>/, /<text[^>]*>PRESENTED TO<\/text>/],
    ];
    for (const [canvas, build, nameRe, leadRe, aboveRe] of CANVASES) {
      for (const name of ["محمد علي", "عَلِيّ بْنُ أَبِي طَالِب", "ปิ่น ฤๅษี ตู้", "กำพล น้ำ", "Dr. Åsa Gyp 张伟"]) {
        const svg = build(name);
        const base = await raster(svg);
        const nameInk = inkRows(base, await raster(recolour(svg, nameRe)));
        const leadInk = inkRows(base, await raster(recolour(svg, leadRe)));
        const aboveInk = inkRows(base, await raster(recolour(svg, aboveRe)));
        expect(nameInk.bot, `${canvas} "${name}": the name's ink ends above the lead-in's (${JSON.stringify({ nameInk, leadInk })})`).toBeLessThan(leadInk.top);
        expect(nameInk.top, `${canvas} "${name}": and starts below "PRESENTED TO" (${JSON.stringify({ nameInk, aboveInk })})`).toBeGreaterThan(aboveInk.bot);
      }
    }
  });
});


// ── The printed name (operator rulings, 14 Nov 2026) ──────────────────────────
//
// Two rules decided where the name is composed (lib/badge.js `certificateName`,
// and `certificatePrintedName`, the one rule every artefact reads):
//   * a name in Han, kana or Hangul prints FAMILY NAME FIRST, with no space;
//   * a salutation that alone stops the fonts drawing the name is left off.
// Locked by value and by RENDERING: the artwork must change, not just a string.
test.describe("the printed name: family name first in Chinese, Japanese and Korean; an undrawable salutation left off", () => {
  const cert = (displayName) => ({
    rank: 1, displayName, competitionName: "Spring Hack", dateLabel: "14 Nov 2026", scoreLabel: "300 pts",
    platformName: "Hack Arena", publicCode: "ABCD2345EFGH", verifyLink: "https://example.test/credential?code=ABCD2345EFGH",
  });
  const sha = (b) => crypto.createHash("sha256").update(Buffer.isBuffer(b) ? b : b.pdf).digest("hex");
  const NICK = "player4821";
  // A users row, as the mint and every render read it.
  const row = (o) => ({ personal_title: o.title || null, first_name: o.first || "", last_name: o.last || "",
    certificate_given_name: o.certGiven || null, certificate_family_name: o.certFamily || null });

  test("a Chinese, Japanese or Korean name prints family name first with no space; every other pair is unchanged", () => {
    const { certificateName, certificateNameParts, certificatePrintedName } = require("../lib/badge.js");
    for (const [given, family, want] of [["伟", "张", "张伟"], ["太郎", "田中", "田中太郎"], ["민준", "김", "김민준"],
      ["さくら", "田中", "田中さくら"], ["娜娜", "欧阳", "欧阳娜娜"], ["サトー", "佐藤", "佐藤サトー"]]) {
      expect(certificateName({ firstName: given, lastName: family }), `${given} / ${family}`).toBe(want);
      expect(certificatePrintedName(row({ first: given, last: family }), NICK), `${given} / ${family} is printed`)
        .toEqual({ displayName: want, fallback: false });
      // The lookup is untouched: the same two parts (the family name is what
      // verifies; through /credential in tests/certificate-scripts.api.spec.js).
      expect(certificateNameParts({ firstName: given, lastName: family })).toEqual({ given, family });
    }
    // The certificate-name override follows the same rule, and a salutation still leads.
    expect(certificateName({ firstName: "Jane", lastName: "Doe", certificateGivenName: "太郎", certificateFamilyName: "田中" })).toBe("田中太郎");
    expect(certificateName({ personalTitle: "Dr.", firstName: "伟", lastName: "张" })).toBe("Dr. 张伟");
    // CONTROLS: a mixed pair keeps given name first with a space, either way round,
    // through the override too; Latin and Cyrillic names are exactly as before.
    expect(certificateName({ firstName: "Wei", lastName: "张" })).toBe("Wei 张");
    expect(certificateName({ firstName: "伟", lastName: "Zhang" })).toBe("伟 Zhang");
    expect(certificateName({ firstName: "x", lastName: "y", certificateGivenName: "Taro", certificateFamilyName: "田中" })).toBe("Taro 田中");
    expect(certificateName({ firstName: "伟" }), "one part has no order").toBe("伟");
    expect(certificateName({ firstName: "Jane", lastName: "Doe" })).toBe("Jane Doe");
    expect(certificateName({ personalTitle: "Dr.", firstName: "Jane", lastName: "Doe" })).toBe("Dr. Jane Doe");
    expect(certificateName({ firstName: "Иван", lastName: "Петров" })).toBe("Иван Петров");
  });

  test("the order reaches the artwork: twice the same, unlike given-name-first, unlike the nickname", async () => {
    const badge = require("../lib/badge.js");
    const nick = sha(await badge.renderBadgePng(badge.buildCertificateSvg(cert(NICK))));
    for (const [given, family] of [["伟", "张"], ["太郎", "田中"], ["민준", "김"]]) {
      const printed = badge.certificatePrintedName(row({ first: given, last: family }), NICK).displayName;
      for (const [canvas, build] of [["certificate", badge.buildCertificateSvg], ["share card", badge.buildBadgeSvg]]) {
        const svg = build(cert(printed));
        const a = sha(await badge.renderBadgePng(svg)), b = sha(await badge.renderBadgePng(svg));
        expect(a, `${canvas} ${printed}: renders byte-identically twice`).toBe(b);
        expect(a, `${canvas} ${printed}: not the given-name-first rendering`).not.toBe(sha(await badge.renderBadgePng(build(cert(`${given} ${family}`)))));
        expect(a, `${canvas} ${printed}: not the nickname`).not.toBe(canvas === "certificate" ? nick : sha(await badge.renderBadgePng(build(cert(NICK)))));
      }
    }
    // CONTROL: a Latin name renders exactly as the name typed, given name first.
    const jane = badge.certificatePrintedName(row({ first: "Jane", last: "Doe" }), NICK).displayName;
    expect(sha(await badge.renderBadgePng(badge.buildCertificateSvg(cert(jane)))))
      .toBe(sha(await badge.renderBadgePng(badge.buildCertificateSvg(cert("Jane Doe")))));
  });

  test("a salutation the fonts cannot draw with the name is left off, and only the salutation", async () => {
    const badge = require("../lib/badge.js");
    const P = (o, opts) => badge.certificatePrintedName(row(o), NICK, opts);
    // Each of these fell back to the nickname whole: resvg draws the Latin "Dr."
    // in an Arabic, Hebrew or Thai line as boxes.
    for (const [o, want] of [[{ title: "Dr.", first: "محمد", last: "علي" }, "محمد علي"],
      [{ title: "Dr.", first: "דוד", last: "כהן" }, "דוד כהן"], [{ title: "Mr.", first: "สมชาย", last: "ใจดี" }, "สมชาย ใจดี"],
      [{ title: "Dr.", first: "Jane", last: "Doe", certGiven: "محمد", certFamily: "علي" }, "محمد علي"],
      // A salutation in another script before a Latin name is left off too.
      [{ title: "د.", first: "John", last: "Smith" }, "John Smith"]]) {
      expect(badge.canRenderText(badge.certificateName({ personalTitle: o.title, firstName: o.first, lastName: o.last,
        certificateGivenName: o.certGiven, certificateFamilyName: o.certFamily })), `PRECONDITION: ${want} with its salutation is undrawable`).toBe(false);
      // …and says it left the salutation off (the share dialog's note); every
      // control below says nothing of the kind (`toEqual` refuses an extra key).
      expect(P(o), `${o.title} ${want}`).toEqual({ displayName: want, fallback: false, salutationDropped: true });
    }
    // By rendering: the certificate for "Dr. محمد علي" is the certificate for "محمد علي".
    const printed = P({ title: "Dr.", first: "محمد", last: "علي" }).displayName;
    const svg = badge.buildCertificateSvg(cert(printed));
    const a = sha(await badge.renderBadgePng(svg)), b = sha(await badge.renderBadgePng(svg));
    expect(a, "renders byte-identically twice").toBe(b);
    expect(a, "unlike the nickname").not.toBe(sha(await badge.renderBadgePng(badge.buildCertificateSvg(cert(NICK)))));
    expect(a, "unlike the line with the salutation, which resvg draws as boxes")
      .not.toBe(sha(await badge.renderBadgePng(badge.buildCertificateSvg(cert("Dr. محمد علي")))));
    const pdf1 = await badge.renderBadgePdf(svg, "Certificate"), pdf2 = await badge.renderBadgePdf(svg, "Certificate");
    expect(sha(pdf1), "the PDF too").toBe(sha(pdf2));

    // CONTROLS. Any other mix prints the nickname: no other part or character is
    // dropped, with or without a salutation.
    expect(P({ first: "Anna", last: "علي" })).toEqual({ displayName: NICK, fallback: true });
    expect(P({ title: "Dr.", first: "Anna", last: "علي" })).toEqual({ displayName: NICK, fallback: true });
    expect(P({ first: "ג'ורג'", last: "לוי" })).toEqual({ displayName: NICK, fallback: true });
    expect(P({ title: "Dr.", first: "राहुल", last: "शर्मा" }), "Devanagari keeps the nickname").toEqual({ displayName: NICK, fallback: true });
    // A salutation the fonts draw with the name stays on it, whatever the script.
    expect(P({ title: "Dr.", first: "Jane", last: "Doe" })).toEqual({ displayName: "Dr. Jane Doe", fallback: false });
    expect(P({ title: "Dr.", first: "伟", last: "张" }), "the CJK face draws the Latin").toEqual({ displayName: "Dr. 张伟", fallback: false });
    expect(P({ title: "د.", first: "محمد", last: "علي" }), "an Arabic salutation the Arabic face draws").toEqual({ displayName: "د. محمد علي", fallback: false });
    expect(sha(await badge.renderBadgePng(badge.buildCertificateSvg(cert("Dr. Jane Doe")))), "the Latin salutation is printed")
      .not.toBe(sha(await badge.renderBadgePng(badge.buildCertificateSvg(cert("Jane Doe")))));
    // An Arabic name with no salutation is unchanged.
    expect(P({ first: "محمد", last: "علي" })).toEqual({ displayName: "محمد علي", fallback: false });
    // A certificate minted with the nickname keeps the rule of its day (Inter
    // alone, a whole name or the nickname): nothing is left off for it.
    expect(P({ title: "Dr.", first: "محمد", last: "علي" }, { fallbackFaces: false })).toEqual({ displayName: NICK, fallback: true });
    expect(P({ title: "د.", first: "John", last: "Smith" }, { fallbackFaces: false })).toEqual({ displayName: NICK, fallback: true });
    expect(P({ title: "Dr.", first: "Jane", last: "Doe" }, { fallbackFaces: false }), "CONTROL: Inter draws it whole").toEqual({ displayName: "Dr. Jane Doe", fallback: false });
  });
});
