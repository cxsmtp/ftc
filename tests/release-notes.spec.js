// @ts-check
//
// v8.5.0 — RELEASE NOTES: the document, the door and the button.
//
// The feature is one markdown document plus one header button, and all three of
// its failure modes are silent:
//
//   1. THE DOCUMENT GOES STALE. A release ships, the notes do not mention it, and
//      nothing anywhere goes red. This is the whole of "kept in lock step", so it
//      is the first block below, and the arm that carries it is that every
//      released version from 8.0.0 to `version.json`'s CURRENT one is DECIDED
//      about: it has a heading in the document, or it is declared in
//      INTERNAL_ONLY below. You cannot bump without doing one or the other.
//
//      v8.6.7 — WHY THE DECISION LIVES HERE AND NOT IN THE DOCUMENT. v8.5.0 gave
//      a release with nothing visible a heading plus one italic line, on the
//      argument that omission is indistinguishable from an oversight. The
//      operator overruled it: a version that changed nothing an organiser or a
//      participant would see is OMITTED from the notes entirely, heading
//      included, and the reader is told so in the intro. The decision per
//      version still has to exist somewhere a scanner can read, or "kept in lock
//      step" stops being mechanical — so it is a declared set in this file, the
//      shape every drift guard in this suite already uses (a DECISION per item,
//      never blanket coverage). A version in neither place is the gap; a version
//      in BOTH is a stale declaration and fails too.
//
//   2. THE DOCUMENT DRIFTS DOWN INTO IMPLEMENTATION DETAIL, OR BACK UP INTO
//      PROSE. The brief was explicitly high-level — what an organiser can now
//      do, and the visible breakage that was fixed — so a bullet naming a
//      route, a file or a SQL statement is a defect in the document, not a
//      stylistic preference. The scan for that is deliberately NARROW (see its
//      own comment): a scanner that is wrong about a correct sentence is one
//      the next person deletes. v8.6.7 added the other direction: the operator
//      asked for the notes to be COMPACT — a bold headline and at most one
//      sentence per bullet — and a document that only ever grows drifts back
//      to paragraphs one release at a time unless a cap holds it. The cap is a
//      character count, because that is the one measure of "compact" a scanner
//      can apply without judging prose.
//
//   3. THE BUTTON IS OFFERED TO SOMEBODY THE SERVER WILL REFUSE, or withheld from
//      somebody it would have served. The SPA hides it unless
//      `S.isAdmin || S.isSuperAdmin`; the server refuses `/docs/release-notes.md`
//      to anyone who is not a live admin. Those are ONE decision, and each half
//      is asserted against the other here.
//
// EVERY POSITIVE ARM CARRIES ITS CONTROL, because each has a build that satisfies
// it for the wrong reason:
//   * "a participant has no release-notes button" is equally satisfied by a build
//     whose header renders nothing at all — so the help button must still be
//     there, on the same screen, in the same assertion.
//   * "a participant is refused the document" is equally satisfied by a build in
//     which the document does not exist — so a superadmin must be served it.
//   * "toggling to participant view hides the button" is equally satisfied by a
//     build that renders it once and never again — so toggling back must bring it
//     back. Both directions, which is the v8.4.1 lesson in a smaller place.
const { test, expect } = require("./isolated-test");
const { registerPost } = require("./helpers");
const { freshCtx, apiLogin, PARTICIPANT_PASS, BASE, waitForAdminPage } = require("./helpers");
const { adminLogin, loginViaApi } = require("./ui-admin-helpers");
const fs = require("fs");
const pathMod = require("path");

// Each UI spec pins its own baseURL: the config deliberately sets none, because a
// hardcoded one pins every worker's page at worker 0's server (v7.15.26).
test.use({ baseURL: BASE });

const ROOT = pathMod.resolve(__dirname, "..");
const NOTES_PATH = pathMod.join(ROOT, "docs", "release-notes.md");
const NOTES_URL = "/docs/release-notes.md";

function readNotes() {
  return fs.readFileSync(NOTES_PATH, "utf8");
}
function currentVersion() {
  return JSON.parse(fs.readFileSync(pathMod.join(ROOT, "version.json"), "utf8")).version;
}
// `## 8.4.1 — 2 September 2026` → { version, date, line }
function parseHeadings(src) {
  const out = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(\d+\.\d+\.\d+)\s+—\s+(\S.*?)\s*$/.exec(lines[i]);
    if (m) out.push({ version: m[1], date: m[2], line: i + 1, index: i });
  }
  return out;
}
// Creates and returns an account of our own. Every browser arm below owns its
// participant rather than borrowing a seeded one: a shared fixture is blocked,
// re-passworded and tagged by earlier tests in the same file, and the failure
// then reads as a broken feature (v7.21.38).
async function mkAccount(sa, H, { email, nick, role }) {
  const { api: anon, csrf: anonCsrf } = await freshCtx();
  await registerPost(anon, "/api/register", {
    headers: { "x-csrf-token": anonCsrf, "content-type": "application/json" },
    data: {
      firstName: "Rel", lastName: "Notes", nickname: nick, email,
      company: "Acme", title: "Eng", country: "US", timezone: "America/New_York",
      jobFunction: "Software Developer / Engineer", city: "NYC", password: PARTICIPANT_PASS,
    },
  });
  await anon.dispose();
  const parts = (await (await sa.get(`/api/admin/participants?limit=5000&search=${encodeURIComponent(email)}`)).json()).participants;
  const u = parts.find(p => p.email === email);
  expect(u, `account ${email} must exist`).toBeTruthy();
  expect((await sa.post(`/api/admin/participants/${u.id}/verify`, { headers: H })).ok(),
    "verify must succeed").toBeTruthy();
  expect((await sa.post(`/api/admin/participants/${u.id}/approve`, { headers: H })).ok(),
    "approve must succeed").toBeTruthy();
  if (role) {
    expect((await sa.post(`/api/admin/participants/${u.id}/role`, { headers: H, data: { role } })).ok(),
      `promotion to ${role} must succeed`).toBeTruthy();
  }
  return u;
}

function cmpVersion(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] - pb[i]; }
  return 0;
}

// v8.6.7 — THE RELEASES THE NOTES DELIBERATELY DO NOT MENTION.
//
// A version here changed nothing an organiser or a participant would see:
// test-harness, dependency, build-pipeline or engineering-documentation work.
// It has NO heading in docs/release-notes.md — not a heading with an italic
// line, nothing — which is the operator's decision (v8.6.7) over v8.5.0's
// "every version gets a line". Listing it here is what keeps that decision
// mechanical: the contiguity arm below treats a declared version as accounted
// for, so a release that ships with neither an entry nor a declaration is
// caught the moment the release after it lands.
//
// ADD a version here ONLY when it genuinely changed nothing visible. If it did,
// write the entry. A version that appears in BOTH places is a stale declaration
// and fails the same arm, so removing it from here is the fix once notes exist.
const INTERNAL_ONLY = new Set([
  "8.3.3",   // developer notes on sign-in and account creation
  "8.3.18",  // developer reference documents
  "8.3.19",  // developer reference documents
  "8.3.24",  // developer reference documents + the checks that keep them true
  "8.3.28",  // automated test fixture hygiene
  "8.3.29",  // test-suite isolation between files
  "8.3.30",  // test-suite server cleanup in the build pipeline
  "8.3.31",  // test-suite repeated-run reliability sweep
  "8.3.32",  // test-suite tuning
  "8.3.38",  // a timezone-dependent automated check
  "8.3.40",  // dependency updates + the matching build-pipeline rebuild
  "8.5.1",   // engineering notes on a performance check + test-log reading
  "8.6.1",   // superseded engineering design notes removed
  "8.6.6",   // screenshot tooling repaired; guide screenshots refreshed
  "8.6.8",   // wording pass over these notes; no platform behaviour changed
  "8.7.1",   // stronger automated checks on the new organiser role
  "8.7.2",   // dev-tooling: the dev server restarts on every source change
  "8.8.1",   // guide + README wording completed for the late-entry status
  "8.8.13",  // dependency updates + the matching build-pipeline rebuild
  "8.8.16", // developer reference + the operator audit-memory file; comments only in lib/
  "8.8.17", // a regression lock for a documentation boundary; no product change
  "8.8.19", // test-machinery gaps, a CI job for the capture suite, and the executive summary
  "8.8.21", // three developer-reference records corrected against the source; no product change
  "8.8.22", // the previous release's own correction re-corrected against a measurement
  "8.8.24", // test workers no longer write into a deployment's live data directory
  "8.8.26", // server start-up settings for operators (the required data directory); nothing on screen
  "8.8.27", // server start-up settings for operators (the required uploads directory); nothing on screen
  "8.11.2", // a backup check that could not run on the build machine; test-only
  "8.11.3", // the UI-polish manifest and the checks that keep it true; no product change
  "8.11.13", // dependency updates + the matching build-pipeline rebuild
  "8.12.3", // the test suite's default worker count and two test-helper fixes; test-only
  "8.12.5", // CI-only test flakes fixed (a detached-row race, a test that could not fail, unpolled log reads)
  "8.13.5", // the developer reference CLAUDE.md rewritten as current rules only; no product change
  "8.13.6", // this check records where each finished minor line ended; test-only
  "8.14.6", // the server refuses a multiple-choice answer no page can send; nothing on screen changes
  "8.14.7", // dependency updates (multer, nodemailer, body-parser) + the matching build-pipeline rebuild
  "8.14.8", // test-harness only: cross-browser clicks recover from a WebKit rendering stall in CI
  "8.14.9", // test-harness only: the WebKit stall recovery also covers settling and a stall lasting several actions
  "9.1.3", // test-harness only: a click WebKit takes and never confirms is waited for, never sent twice; every cross-spec press uses the helper; a forced certificate pass can run one event alone; upload-refusal tests wait out a runner's disk dip; the minifier's linear-time check uses CPU time
  "9.1.4", // test-harness only: the cross-device challenge journey is two shorter tests, so each fits its time on a slow runner
  "9.1.6", // test-harness only: the profile card's tests wait for the People search to narrow before touching a row, and on a phone open the card from the row's menu
  "9.1.8", // test-harness only: the event-admin challenge-scope test waits for the challenge list to arrive before reading it; a WebKit navigation whose events the test never hears goes on once the page itself has loaded
  "9.1.10", // test-harness only: a WebKit navigation that has not committed in a third of its time is sent once more
  "9.1.11", // test-harness only: test runs write no core dumps, and CI runs log the runner's disk
  "9.1.12", // test-harness only: a cross-browser press waits for its witness to be armed on a busy page before it is sent
  "9.1.20", // tests for two guards (a restore dropping a malformed qualifying tag, a delta queued during a wrap-up) and the audit trail's guide screenshot
  "9.2.1", // dependencies only: better-sqlite3 13.2.0 and nodemailer 10.6.0, with the CI image rebuilt on the new lockfile
  "9.2.4", // test-harness only: a test presses a Groups or Events row only once the table has re-rendered after typing in its search box
  "9.2.6", // tests only: every sign-in door's limiter, what a wrong or refused code tells a caller, and when codes and address proofs expire
]);

// v8.13.6 — WHERE EACH FINISHED MINOR LINE ENDED.
//
// The no-gaps arm runs every minor line's patches from 0 to the line's END. For
// the line this build belongs to, the end is the build version, which the
// lock-step arm requires to be decided about. A FINISHED line has nothing to
// anchor it: to the document, its end is whatever is still written down, so
// deleting its last patch — or any run of patches ending there — left no hole
// and nothing went red. So each finished line's last release is recorded here,
// taken from `git log -p -- version.json` rather than from the document it
// protects. Starting a new minor line fails the arm until the previous line's
// last release is added, and its message says what to add; a record that
// disagrees with the entries and declarations, in either direction, fails too.
const LINE_LAST_RELEASE = new Set([
  "8.0.9", "8.1.9", "8.2.3", "8.3.40", "8.4.1", "8.5.1", "8.6.8",
  "8.7.7", "8.8.27", "8.9.1", "8.10.3", "8.11.13", "8.12.8", "8.13.9", "8.14.9",
  "8.15.1", "8.16.0", "8.17.0", "9.0.2", "9.1.20",
]);

// v8.6.7 — THE COMPACTNESS CAP. A bullet is a bold headline plus at most one
// sentence, and the longest such bullet the compacted document needed measured
// under this. A character count is the only measure of "compact" that a scanner
// can apply without judging prose; raise it only for a bullet that genuinely
// cannot be said shorter, never to let a paragraph back in.
const BULLET_MAX_CHARS = 220;

// The heading the CURRENT build's notes should lead with: the current version
// itself, or — when the current release is declared internal-only — the newest
// version that does have an entry.
function expectedTopVersion(heads) {
  const v = currentVersion();
  return INTERNAL_ONLY.has(v) ? heads[0].version : v;
}

test.describe("Release notes — the document stays in lock step (v8.5.0, re-pointed v8.6.7)", () => {
  test("every released version from 8.0.0 has an entry or is declared internal-only, newest first, with no gaps", () => {
    const src = readNotes();
    const heads = parseHeadings(src);

    // ANTI-VACUITY only: it stops the parser going quietly blind if the heading
    // shape is ever reworded. It is deliberately NOT the current count and need
    // not follow it — a deleted entry is caught by the no-gaps arm below, which
    // runs every finished minor line to its recorded end (LINE_LAST_RELEASE).
    // 63 is the count after v8.6.7 removed the fourteen internal-only entries.
    expect(heads.length,
      "docs/release-notes.md has almost no version headings — either the `## <version> — <date>` "
      + "shape has moved and this parser is now looking for nothing, or entries have been deleted")
      .toBeGreaterThanOrEqual(63);

    // Newest first, strictly descending. A reader opens release notes to see what
    // is new; the newest release has to be the first thing on the page.
    for (let i = 1; i < heads.length; i++) {
      expect(cmpVersion(heads[i - 1].version, heads[i].version),
        `line ${heads[i].line}: ${heads[i].version} follows ${heads[i - 1].version} — entries must run `
        + "newest first, strictly descending").toBeGreaterThan(0);
    }

    const versions = heads.map(h => h.version);
    expect(new Set(versions).size, `a version appears twice: ${versions.join(", ")}`).toBe(versions.length);

    // The stated start of the record. Anything older predates the notes and is
    // deliberately not covered; anything newer than 8.0.0 as the OLDEST entry
    // means the tail of the record has been cut.
    expect(versions[versions.length - 1],
      "the oldest entry must be 8.0.0 — the release the notes are written back to")
      .toBe("8.0.0");

    // A DECLARED version has no heading, by definition. One that has both is a
    // stale declaration: somebody wrote notes for it later and left the entry
    // here, and the reader would now be shown a version this file says is
    // invisible. Fail it rather than let the two quietly disagree.
    const declaredAndPresent = versions.filter(v => INTERNAL_ONLY.has(v));
    expect(declaredAndPresent,
      "these versions have an entry in docs/release-notes.md AND are declared INTERNAL_ONLY in this spec — "
      + "remove them from the declaration, the notes now say something about them:\n  "
      + declaredAndPresent.join("\n  ")).toEqual([]);

    // NO GAPS. Every version from 8.0.0 up to the newest KNOWN one — entries and
    // declarations together — must be accounted for: within a minor line the
    // patch numbers run from 0 to the line's end with no holes, and the minor
    // lines themselves are contiguous. So a release that ships with neither an
    // entry nor a declaration is caught the moment the release after it lands.
    // A line's end is the build version for the line still open, and the
    // RECORDED last release for a finished one — never merely the newest
    // version still written down (see LINE_LAST_RELEASE).
    const known = new Set([...versions, ...INTERNAL_ONLY]);
    const byMinor = new Map();
    for (const v of known) {
      const [maj, min, patch] = v.split(".").map(Number);
      const key = `${maj}.${min}`;
      if (!byMinor.has(key)) byMinor.set(key, []);
      byMinor.get(key).push(patch);
    }
    const build = currentVersion();
    const buildLine = build.split(".").slice(0, 2).join(".");
    const lineVsBuild = key => cmpVersion(`${key}.0`, `${buildLine}.0`);
    const recordedEnd = new Map();
    const recordProblems = [];
    for (const r of LINE_LAST_RELEASE) {
      const [maj, min, patch] = r.split(".").map(Number);
      const key = `${maj}.${min}`;
      if (recordedEnd.has(key)) {
        recordProblems.push(`"${r}": the ${key} line already has a recorded last release`);
      } else if (lineVsBuild(key) >= 0) {
        recordProblems.push(`"${r}": the ${key} line has not finished — this build is ${build}; `
          + "record a line's last release only once the next minor line has started");
      }
      recordedEnd.set(key, patch);
    }
    const missing = [];
    for (const key of new Set([...byMinor.keys(), ...recordedEnd.keys()])) {
      const patches = byMinor.get(key) || [];
      let end = Math.max(...patches);
      if (lineVsBuild(key) < 0) {
        if (!recordedEnd.has(key)) {
          recordProblems.push(`the ${key} line has finished (this build is ${build}) but its last release `
            + `is not recorded — add "${key}.${end}" to LINE_LAST_RELEASE, after checking it against `
            + "`git log -p -- version.json`");
        } else {
          end = recordedEnd.get(key);
          const beyond = patches.filter(p => p > end).map(p => `${key}.${p}`);
          if (beyond.length) {
            recordProblems.push(`LINE_LAST_RELEASE says the ${key} line ended at ${key}.${end}, yet `
              + `${beyond.join(", ")} has an entry or a declaration — one of the two is wrong`);
          }
        }
      }
      for (let p = 0; p <= end; p++) {
        if (!patches.includes(p)) missing.push(`${key}.${p}`);
      }
    }
    expect(recordProblems,
      "LINE_LAST_RELEASE in this spec does not match the release history:\n  "
      + recordProblems.join("\n  ")).toEqual([]);
    const minors = [...byMinor.keys()].map(k => Number(k.split(".")[1])).sort((a, b) => a - b);
    for (let m = 0; m <= Math.max(...minors); m++) {
      if (!minors.includes(m)) missing.push(`8.${m}.x (the whole minor line)`);
    }
    expect(missing,
      "these released versions are neither in docs/release-notes.md nor declared INTERNAL_ONLY in this spec. "
      + "Every version gets a DECISION: an entry saying what an organiser or participant can now do, or a "
      + "declaration here that it changed nothing they would see — never a gap nobody noticed:\n  "
      + missing.join("\n  ")).toEqual([]);
  });

  test("the version this build ships as has an entry of its own, or is declared internal-only", () => {
    // THE LOCK-STEP ARM. Everything else in this file describes the shape of the
    // document; this is the one that makes it impossible to release without
    // deciding about it. `npm run bump` moves version.json, and this goes red
    // until the notes carry the new number OR this spec declares the release
    // internal-only. Both are a decision somebody took; neither is silence.
    const v = currentVersion();
    const heads = parseHeadings(readNotes());
    const found = heads.find(h => h.version === v);
    if (INTERNAL_ONLY.has(v)) {
      expect(found,
        `this build (${v}) is declared INTERNAL_ONLY yet docs/release-notes.md has a "## ${v}" heading — `
        + "one of the two is wrong; remove whichever does not describe the release").toBeFalsy();
      expect(cmpVersion(heads[0].version, v),
        `the newest entry is ${heads[0].version}, which is NEWER than this build (${v})`).toBeLessThan(0);
    } else {
      expect(found,
        `version.json says this build is ${v} and docs/release-notes.md has no "## ${v} — <date>" heading. `
        + "Add the entry — what an organiser or participant can now do, what behaves differently, and any "
        + "visible breakage that was fixed — or, if this release changed nothing they would see, declare it "
        + "in INTERNAL_ONLY in tests/release-notes.spec.js.").toBeTruthy();
      expect(heads[0].version,
        `the newest entry is ${heads[0].version} but this build ships as ${v} — the current release must be first`)
        .toBe(v);
    }
    // No version newer than the build, declared or written: a note for a release
    // that has not shipped is a promise the header badge contradicts.
    const future = [...new Set([...heads.map(h => h.version), ...INTERNAL_ONLY])]
      .filter(x => cmpVersion(x, v) > 0);
    expect(future, `versions newer than this build (${v}) are mentioned: ${future.join(", ")}`).toEqual([]);
  });

  test("every entry carries bullets under one of exactly two subheadings, and nothing else", () => {
    const src = readNotes();
    const heads = parseHeadings(src);
    const lines = src.split("\n");
    const bad = [];
    for (let i = 0; i < heads.length; i++) {
      const from = heads[i].index + 1;
      const to = i + 1 < heads.length ? heads[i + 1].index : lines.length;
      const body = lines.slice(from, to);
      const hasBullet = body.some(l => /^\s*-\s+\S/.test(l));
      if (!hasBullet) bad.push(`${heads[i].version} (line ${heads[i].line}) — no bullets`);
      for (const l of body) {
        const sub = /^###\s+(.*\S)\s*$/.exec(l);
        if (sub && !["New and changed", "Fixed"].includes(sub[1])) {
          bad.push(`${heads[i].version} — unexpected subheading "${sub[1]}"`);
        }
        // v8.6.7 — the RETIRED form. v8.5.0 let a release with nothing visible
        // keep a heading over one italic line; the operator's decision is that
        // such a release is not listed at all. An italic line here means the
        // entry should be deleted and the version declared INTERNAL_ONLY.
        if (/^_[^_].*_\s*$/.test(l.trim())) {
          bad.push(`${heads[i].version} — an italic note instead of bullets; omit the version and declare it INTERNAL_ONLY`);
        }
        // Prose outside a bullet is where paragraphs creep back in.
        if (l.trim() && !/^\s*-\s+\S/.test(l) && !/^###\s/.test(l)) {
          bad.push(`${heads[i].version} (line ${from + body.indexOf(l) + 1}) — text outside a bullet: "${l.trim().slice(0, 60)}"`);
        }
      }
    }
    expect(bad,
      "each version entry is bullets under `### New and changed` and/or `### Fixed`, nothing else — a release "
      + "with nothing visible is omitted, not described:\n  " + bad.join("\n  ")).toEqual([]);
  });

  test("every bullet is a bold headline plus at most one sentence, within the cap", () => {
    // v8.6.7 — THE COMPACTNESS ARM. The operator asked for the notes to be
    // compact, and a document that only grows drifts back to paragraphs one
    // release at a time unless something holds it. Two things a scanner can
    // check without judging prose: the bullet OPENS with a bold headline, and the
    // whole line fits the cap. Anything finer (sentence counts, word choice) is
    // review's job, and a scanner that is wrong about a correct sentence is one
    // the next person deletes.
    const src = readNotes();
    const lines = src.split("\n");
    const bullets = [];
    lines.forEach((l, i) => { if (/^\s*-\s+\S/.test(l)) bullets.push({ line: i + 1, text: l }); });
    // Anti-vacuity: a reworded bullet marker would leave this scanning nothing.
    expect(bullets.length, "almost no bullets found — has the list marker moved?").toBeGreaterThanOrEqual(80);
    const bad = [];
    for (const b of bullets) {
      if (!/^- \*\*[^*]+\*\*/.test(b.text)) {
        bad.push(`line ${b.line}: does not open with a bold headline: ${b.text.trim().slice(0, 80)}`);
      }
      if (b.text.length > BULLET_MAX_CHARS) {
        bad.push(`line ${b.line}: ${b.text.length} characters, cap is ${BULLET_MAX_CHARS}: ${b.text.trim().slice(0, 80)}…`);
      }
    }
    expect(bad,
      "release-notes bullets are a bold headline and at most one plain sentence. Say less, or split a "
      + "genuinely separate change into its own bullet:\n  " + bad.join("\n  ")).toEqual([]);
  });

  test("the notes stay at the altitude they were asked for", () => {
    // DELIBERATELY NARROW. The brief was high-level change, not detail — but a
    // scanner that flags a correct sentence gets silenced by whoever hits it
    // next, so this looks only for things that can NEVER belong in notes written
    // for an event organiser: an API route, a source filename, a SQL verb, a
    // database column reference. It does not attempt to judge prose.
    const src = readNotes();
    const lines = src.split("\n");
    const hits = [];
    const BANNED = [
      [/\/api\//, "an API route"],
      [/\b[\w./-]+\.(?:js|json|css|yaml|sql)\b/, "a source filename"],
      [/\b(?:SELECT|INSERT INTO|UPDATE .* SET|ALTER TABLE|CREATE INDEX)\b/, "SQL"],
      // Deliberately only the spelled-out form. A bare `500` is a plausible
      // participant count in a real sentence, and a scanner that is wrong about
      // a correct sentence is one the next person deletes.
      [/\bHTTP\s?\d{3}\b/, "an HTTP status code"],
      // v8.6.7 — a bullet that narrates which release did what is history, not a
      // note; the heading already says which version this is.
      [/\b\d+\.\d+\.\d+\b/, "a version number"],
    ];
    lines.forEach((l, i) => {
      // Only prose is scanned. The intro paragraph and headings are ours.
      if (!/^\s*-\s+\S/.test(l)) return;
      for (const [re, what] of BANNED) {
        if (re.test(l)) hits.push(`line ${i + 1} names ${what}: ${l.trim().slice(0, 120)}`);
      }
    });
    expect(hits,
      "release notes are written for an event organiser who will never read the source. State the change, "
      + "not the mechanism:\n  " + hits.join("\n  ")).toEqual([]);
  });

  test("the platform name is a placeholder here too", () => {
    // The whole docs/ tree is already scanned for a hardcoded product name; this
    // says the same thing at the point of authorship, because the release notes
    // are the one document in that tree written fresh every release.
    const src = readNotes();
    expect(src, "docs/release-notes.md must not hardcode a product name").not.toMatch(/\bHack\s+Arena\b/i);
    expect(src, "the marker is {{platformName}}").not.toMatch(/\{\{\s*platform_name\s*\}\}/);
  });
});

test.describe("Release notes — the document is served to admins only (v8.5.0)", () => {
  test("an admin is served it, an anonymous caller and a participant are not", async () => {
    // The CONTROL comes first deliberately: without a request that succeeds, every
    // refusal below is equally satisfied by a build in which the file is missing.
    const { api: sa } = await apiLogin("superadmin");
    const ok = await sa.get(NOTES_URL);
    expect(ok.status(), "a superadmin must be served the release notes").toBe(200);
    const body = await ok.text();
    expect(body, "the served document is the release notes").toContain("# Release notes");
    expect(body).toContain(`## ${expectedTopVersion(parseHeadings(body))} `);
    expect(ok.headers()["cache-control"] || "",
      "a gated document must not be storable by a shared cache").toContain("no-store");

    const { api: anon } = await freshCtx();
    expect((await anon.get(NOTES_URL)).status(),
      "an anonymous caller must not be served the release notes").toBe(401);
    await anon.dispose();

    const email = `rn-part-${Date.now()}@example-corp.test`;
    const { api: sa2, csrf: saCsrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": saCsrf, "content-type": "application/json" };
    await mkAccount(sa2, H, { email, nick: `relnotes${Date.now() % 100000}` });

    const { api: pApi } = await apiLogin(email, PARTICIPANT_PASS);
    const refused = await pApi.get(NOTES_URL);
    expect(refused.status(),
      "a signed-in participant must not be served the release notes — the button is withheld from them "
      + "for the same reason").toBe(401);
    // The participant guide is the control on the GATE itself: this session is
    // live and can read an ungated document, so the 401 above is about the
    // release notes rather than about the session.
    expect((await pApi.get("/docs/user-guide/participant.md")).status(),
      "the same participant session must still read its own guide").toBe(200);
  });
});

test.describe("Release notes — the button (v8.5.0)", () => {
  test("a superadmin gets the button, and it opens the notes in the drawer", async ({ page }) => {
    await adminLogin(page);
    // The sparkle left the header: "What's new" is an item of the account menu.
    const btn = (await require("./chrome-helpers").openAccountMenu(page)).locator('[data-action="release-notes-open"]');
    await btn.waitFor({ state: "visible", timeout: 15000 });
    await expect(btn).toHaveText("What's new");

    await btn.click();
    const overlay = page.locator("#help-drawer-overlay");
    await overlay.waitFor({ state: "visible", timeout: 10000 });
    await expect(page.locator(".help-drawer-title")).toHaveText("Release notes");
    // Wait for the RENDERED document, not the drawer shell — the body paints
    // "Loading…" first, so asserting on the shell would pass before the markdown
    // ever arrived. The heading looked for is the current version's, or the
    // newest written one when the current release is declared internal-only.
    const topVersion = expectedTopVersion(parseHeadings(readNotes()));
    const h2 = page.locator(`#help-drawer-body h2:has-text("${topVersion}")`).first();
    await h2.waitFor({ state: "visible", timeout: 15000 });
    await expect(page.locator("#help-drawer-body h1").first()).toHaveText(/Release notes/i);
    // The hand-off to the full-page viewer, which is free only because the drawer
    // is reused rather than reimplemented.
    await expect(page.locator("#help-open-ext"))
      .toHaveAttribute("href", `/help.html?doc=${encodeURIComponent(NOTES_URL)}`);

    // …and the Help button still resolves to the ADMIN GUIDE afterwards. The
    // drawer remembers the last document it showed; the release notes must never
    // become that memory, or the `?` button silently stops opening help.
    await page.locator("[data-action=help-close]").click();
    await overlay.waitFor({ state: "hidden", timeout: 5000 });
    // Signed in, Help is an item of the account menu (the header holds Search).
    await require("./chrome-helpers").pressAccountMenuItem(page, "help-open");
    await overlay.waitFor({ state: "visible", timeout: 10000 });
    await expect(page.locator(".help-drawer-title")).toHaveText("Help");
    await expect(page.locator("#help-open-ext"))
      .toHaveAttribute("href", `/help.html?doc=${encodeURIComponent("/docs/user-guide/admin.md")}`);
  });

  test("a participant does not get the button — but still gets the help one", async ({ page }) => {
    const email = `rn-ui-${Date.now()}@example-corp.test`;
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    await mkAccount(sa, H, { email, nick: `relview${Date.now() % 100000}` });

    await loginViaApi(page, email, PARTICIPANT_PASS);
    await page.goto("/");
    // THE CONTROL. "No release-notes button" is equally true of a header that
    // rendered nothing, so the help button — the one every role gets — is asserted
    // present on the same screen before the absence means anything.
    await page.locator("#app-search-btn").waitFor({ state: "visible", timeout: 15000 });
    const menu = await require("./chrome-helpers").openAccountMenu(page);
    await expect(menu.locator('[data-action="do-logout"]'), "CONTROL: the menu rendered").toBeVisible();
    await expect(menu.locator('[data-action="help-open"]'), "CONTROL: the help one").toBeVisible();
    await expect(menu.locator('[data-action="release-notes-open"]')).toHaveCount(0);
  });

  test("the button follows the view an admin is in, in both directions", async ({ page }) => {
    // An admin in participant view is deliberately seeing what a participant sees,
    // and the server's own docs gate answers them the same way, so the button must
    // go. It must also come BACK — a one-way hide is the shape that has bitten
    // this header before, and "it disappeared" is equally satisfied by a build
    // that renders it once and never again.
    // A USER-BACKED admin, not the built-in superadmin: `buildAdminNav` renders the
    // Participant View button only for an account with a profile behind it, so the
    // built-in one has no way into participant view at all. Driving a REGULAR admin
    // also covers the tier the button is offered to most often.
    const email = `rn-admin-${Date.now()}@example-corp.test`;
    const { api: sa, csrf } = await apiLogin("superadmin");
    const H = { "x-csrf-token": csrf, "content-type": "application/json" };
    await mkAccount(sa, H, { email, nick: `reladm${Date.now() % 100000}`, role: "admin" });

    await loginViaApi(page, email, PARTICIPANT_PASS);
    await page.goto("/");
    await waitForAdminPage(page, 20000);
    const item = (m) => m.locator('[data-action="release-notes-open"]');
    await item(await require("./chrome-helpers").openAccountMenu(page)).waitFor({ state: "visible", timeout: 15000 });

    await require("./chrome-helpers").pressAccountMenuItem(page, "toggle-admin-view", "false");
    await page.locator("#nav-competitions").waitFor({ state: "visible", timeout: 15000 });
    await expect(item(await require("./chrome-helpers").openAccountMenu(page)),
      "an admin in participant view must not carry an admin-only menu item").toHaveCount(0);

    await require("./chrome-helpers").pressAccountMenuItem(page, "toggle-admin-view", "true");
    await waitForAdminPage(page, 15000);
    await item(await require("./chrome-helpers").openAccountMenu(page)).waitFor({ state: "visible", timeout: 15000 });
  });
});
