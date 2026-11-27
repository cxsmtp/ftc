// v8.13.4 — the CI configuration says what is true, and its copies of one fact agree.
//
// Three source locks over the CI files, each closing a class that went stale
// with nothing able to go red.
//
//   (a) THE SCAN NAMES NO REPOSITORY. The Checkmarx scan passed SCS Scorecard
//       a LITERAL repository URL (`--scs-repo-url https://github.com/<old owner>/
//       hackarena`) plus a repo token. The repository had been transferred, so
//       the URL kept working only through GitHub's transfer redirect — which
//       disappears the moment anybody creates a repository at the old path, and
//       Scorecard would then have run, with OUR token, against theirs. Scorecard
//       never produced a result anyway: it reads the repository from Checkmarx
//       One's side and this org is IP-allowlisted. The operator ruled it out
//       (v8.13.4), so the workflow carries no repo URL, no repo token and no
//       hard-coded repository URL at all; the scan still runs `scs`, which keeps
//       secret detection.
//
//   (b) THE PLAYWRIGHT IMAGE MOVES WITH THE PACKAGE. ci/Dockerfile.cross-browser
//       builds FROM mcr.microsoft.com/playwright:v<X>-noble, the lockfile pins
//       @playwright/test, and the workflow's `image:` lines name the tag in a
//       trailing comment. Nothing tied them together: v8.8.13 recorded that a
//       rebuild on the OLD base passes every guard there is (the baked lockfile
//       hash, the Node major), and in v8.13.4 the Dockerfile already said 1.64.0
//       while the workflow and ci/README.md still said 1.63.0. This arm cannot
//       prove that a pinned DIGEST was built on that base — the Dockerfile's last
//       RUN, which launches the browsers at build time, is what proves that.
//
//   (c) THIS REPOSITORY HAS ONE ADDRESS. perf/README.md told readers to clone a
//       third, pre-transfer address of this repository. Any text file in the
//       tree that names this project's repository by URL — comments included,
//       because a quoted URL is how the next reader copies it — must use the
//       current one. The operator's file (AGENT_AUDIT_MEMORY.md) is exempt, by
//       name and with the reason, and so is any directory below the root that
//       holds its own `.git` (a nested checkout or worktree is another tree) — a
//       fourth test plants one beside an ordinary directory to prove the skip is
//       that narrow.
//
// All three are TEXT locks, so the doctrine applies: comments are stripped
// before a CODE claim is checked (the comment explaining the SCS decision
// names the very flags arm (a) forbids), every arm carries an anti-vacuity
// floor, and every refusal says what to do instead. Stated limit of (a)'s
// stripper: a ` #` inside a block-scalar line (a `run: |` script) is read as a
// comment, so text after it is not checked — YAML says it is content there.
const { test, expect } = require("./isolated-test");
const fs = require("fs");
const pathMod = require("path");

const ROOT = pathMod.join(__dirname, "..");
const read = (rel) => fs.readFileSync(pathMod.join(ROOT, rel), "utf8");
const WF_DIR = ".github/workflows";
const SCAN_WF = `${WF_DIR}/checkmarx.yml`;

// YAML comments out, line numbers kept. A full-line `#` comment becomes an empty
// line; a trailing comment — a `#` preceded by whitespace, outside a quoted
// scalar — is cut. Quote state is tracked per line (a block scalar's shell line
// with an apostrophe inside double quotes stays one string). A `#` with no
// whitespace before it (a URL fragment) is content, as YAML says it is.
function yamlCode(text) {
  return text.split("\n").map((line) => {
    if (/^\s*#/.test(line)) return "";
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q === '"') { if (c === "\\") i++; else if (c === '"') q = null; continue; }
      if (q === "'") { if (c === "'") q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).replace(/\s+$/, "");
    }
    return line;
  }).join("\n");
}

function workflowFiles() {
  return fs.readdirSync(pathMod.join(ROOT, WF_DIR)).filter((f) => /\.ya?ml$/.test(f)).map((f) => `${WF_DIR}/${f}`);
}

// A top-level job's block (2-space key under `jobs:`), up to the next one.
function jobBlock(code, jobId) {
  const lines = code.split("\n");
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt < 0) return null;
  const start = lines.findIndex((l, i) => i > jobsAt && l === `  ${jobId}:`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i]) || /^\S/.test(lines[i])) { end = i; break; }
  }
  return { start, lines: lines.slice(start, end) };
}

test.describe("v8.13.4 — CI configuration lockstep", () => {
  test("(a) the CI scan names no repository: no SCS repo URL or token, no REPO_TOKEN, no literal repository URL", () => {
    const files = workflowFiles();
    expect(files, "anti-vacuity: the workflows directory was read").toContain(SCAN_WF);

    // A third-party URL a step genuinely needs would be a DECISION, entered here
    // with its reason — never a silent exception. None exists today.
    const ALLOWED_URLS = new Map([]);
    const FORBIDDEN = [
      [/--scs-repo-(?:url|token)\b/, "an SCS Scorecard repository flag"],
      [/\bSCS_REPO_(?:URL|TOKEN)\b/, "the ast-cli environment fallback for the same flags"],
      [/\bsecrets\.REPO_TOKEN\b/, "the repository token Scorecard was given"],
    ];
    const URL_RE = /\bgithub\.com[/:][A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/gi;
    const bad = [];
    for (const rel of files) {
      const code = yamlCode(read(rel)).split("\n");
      code.forEach((line, i) => {
        for (const [re, what] of FORBIDDEN) {
          if (re.test(line)) bad.push(`${rel}:${i + 1}: ${what} — ${line.trim()}`);
        }
        for (const m of line.matchAll(URL_RE)) {
          if (!ALLOWED_URLS.has(m[0].toLowerCase())) bad.push(`${rel}:${i + 1}: a literal repository URL (${m[0]}) — ${line.trim()}`);
        }
      });
    }
    expect(bad,
      "SCS Scorecard is OFF by operator decision (v8.13.4): Checkmarx One cannot reach this IP-allowlisted " +
      "org, and the old flag named a pre-transfer repository by a literal URL that only GitHub's transfer " +
      "redirect kept alive, so Checkmarx One would have used our token against a repository re-created at that path. If the " +
      "decision is ever reversed, re-enable Scorecard only once Checkmarx One can reach the org, derive the URL " +
      "from github.server_url and github.repository (never write it out), and change this lock in the same " +
      "commit. A third-party URL a step really needs goes in ALLOWED_URLS with its reason.\n  " + bad.join("\n  ")
    ).toEqual([]);

    // POSITIVE WITNESS + FLOOR. The scan step's parameters are found exactly once;
    // without this, renaming the key would leave every assertion above passing on
    // nothing. The action evaluates additional_params only when scan_params is
    // empty, so BOTH present would be a parameter set that is silently ignored.
    const scan = jobBlock(yamlCode(read(SCAN_WF)), "checkmarx-scan");
    expect(scan, "anti-vacuity: the checkmarx-scan job was found in " + SCAN_WF).toBeTruthy();
    expect(scan.lines.join("\n"), "the checkmarx-scan job still runs the Checkmarx action")
      .toMatch(/^\s+uses:\s*checkmarx\/ast-github-action@[0-9a-f]{40}\b/m);
    const params = scan.lines
      .map((l, i) => ({ m: /^\s+(additional_params|scan_params):\s*(.*)$/.exec(l), at: scan.start + i + 1 }))
      .filter((x) => x.m);
    expect(params.map((p) => `${SCAN_WF}:${p.at}: ${p.m[1]}`),
      "the scan step names its parameters exactly once — additional_params OR scan_params, never both " +
      "(the action ignores additional_params whenever scan_params is set), never neither"
    ).toHaveLength(1);
    const value = params[0].m[2];
    const types = (/--scan-types\s+(\S+)/.exec(value) || [])[1];
    expect(types, `the scan still passes --scan-types (${SCAN_WF}:${params[0].at})`).toBeTruthy();
    expect(types.split(","),
      "the scan still runs `scs`: the operator removed Scorecard's repository URL, not secret detection"
    ).toContain("scs");
  });

  test("(b) the CI image's Playwright base, the lockfile and every tag that names it agree", () => {
    // X — the base the image is built FROM. Comment lines dropped; the Dockerfile's
    // heredoc body (a node script) has no line starting with `#`.
    const df = read("ci/Dockerfile.cross-browser").split("\n").filter((l) => !/^\s*#/.test(l));
    const froms = df.filter((l) => /^FROM\s/i.test(l));
    expect(froms, "ci/Dockerfile.cross-browser has exactly one FROM").toHaveLength(1);
    const fromM = /^FROM\s+mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble\s*$/.exec(froms[0]);
    expect(fromM, `the CI image builds FROM mcr.microsoft.com/playwright:v<X.Y.Z>-noble (found: ${froms[0]})`).toBeTruthy();
    const X = fromM[1];
    const remedy = `The CI image is built FROM mcr.microsoft.com/playwright:v${X}-noble. The lockfile's Playwright, ` +
      `the base and every tag that names it move together: bump them in one commit, rebuild + push the image, ` +
      `and re-pin all of the workflow's image: lines (ci/README.md "When + how to rebuild").`;

    // The lockfile: @playwright/test drives the browsers through playwright and
    // playwright-core. Every copy anywhere in the tree, not only the top-level
    // one — a nested playwright-core is the one the runner would actually load.
    const lock = JSON.parse(read("package-lock.json"));
    const pwKeys = Object.keys(lock.packages || {}).filter((k) => /(?:^|\/)node_modules\/(?:@playwright\/test|playwright|playwright-core)$/.test(k));
    for (const must of ["node_modules/@playwright/test", "node_modules/playwright", "node_modules/playwright-core"]) {
      expect(pwKeys, `anti-vacuity: package-lock.json resolves ${must}`).toContain(must);
    }
    const lockBad = pwKeys.filter((k) => lock.packages[k].version !== X).map((k) => `package-lock.json ${k}@${lock.packages[k].version}`);
    expect(lockBad, `the lockfile's Playwright is not the base's ${X}. ${remedy}\n  ${lockBad.join("\n  ")}`).toEqual([]);

    // The workflow: every image: line is a digest pin carrying the tag comment.
    const wf = read(SCAN_WF).split("\n");
    const imageLines = wf.map((l, i) => ({ l, at: i + 1 })).filter((x) => /^\s*image:\s*mpogr\/hackarena-ci\b/.test(x.l));
    expect(imageLines.length,
      "anti-vacuity: the CI image is pinned on several jobs' image: lines (count them; there were three at v8.13.4)"
    ).toBeGreaterThanOrEqual(3);
    const wfBad = [];
    for (const { l, at } of imageLines) {
      const m = /^\s*image:\s*mpogr\/hackarena-ci@sha256:[0-9a-f]{64}\s+#\s*playwright-v(\d+\.\d+\.\d+)-noble-deps\s*$/.exec(l);
      if (!m) wfBad.push(`${SCAN_WF}:${at}: not a digest pin with a "# playwright-v<X.Y.Z>-noble-deps" comment — ${l.trim()}`);
      else if (m[1] !== X) wfBad.push(`${SCAN_WF}:${at}: tag comment says ${m[1]}, the base is ${X}`);
    }
    // Prose in the workflow that names the base (comments included) must agree too.
    wf.forEach((l, i) => {
      for (const m of l.matchAll(/mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble(?![\w-])/g)) {
        if (m[1] !== X) wfBad.push(`${SCAN_WF}:${i + 1}: names the base as v${m[1]}-noble, the Dockerfile builds v${X}-noble`);
      }
    });
    expect(wfBad, `the workflow disagrees with the base. ${remedy}\n  ${wfBad.join("\n  ")}`).toEqual([]);

    // ci/README.md: the Published tag, every tag the recipes use, and the base.
    const readme = read("ci/README.md");
    const published = [...readme.matchAll(/^Published tag: `mpogr\/hackarena-ci:playwright-v(\d+\.\d+\.\d+)-noble-deps`/gm)];
    expect(published.length, "ci/README.md states the Published tag exactly once").toBe(1);
    const docBad = [];
    if (published[0][1] !== X) docBad.push(`Published tag says ${published[0][1]}`);
    const tags = [...readme.matchAll(/playwright-v(\d+\.\d+\.\d+)-noble-deps/g)];
    expect(tags.length, "anti-vacuity: ci/README.md's recipes name the tag (build, push, inspect, pin, read-back)").toBeGreaterThanOrEqual(4);
    for (const m of tags) if (m[1] !== X) docBad.push(`a recipe names playwright-v${m[1]}-noble-deps`);
    const bases = [...readme.matchAll(/mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble(?![\w-])/g)];
    expect(bases.length, "anti-vacuity: ci/README.md names the base it builds FROM").toBeGreaterThanOrEqual(1);
    for (const m of bases) if (m[1] !== X) docBad.push(`names the base as v${m[1]}-noble`);
    expect(docBad, `ci/README.md disagrees with the base ${X}. ${remedy}\n  ${docBad.join("\n  ")}`).toEqual([]);
  });

  // A NESTED CHECKOUT is a different tree, not part of this one. Agent
  // worktrees live under .claude/worktrees/<name> as full checkouts, and one
  // branched before v8.13.4 still carries the retired addresses — scanning it
  // fails `npm test` on the main checkout for files this commit never had, and
  // the remedy that looks obvious under pressure (delete the worktree) loses
  // that agent's uncommitted work. A directory below the root holding its own
  // `.git` (file or dir) is skipped, which covers every worktree and submodule.
  const CANONICAL = "cx-bizops/se-hackarena";
  const SKIP_DIRS = new Set(["node_modules", ".git", "test-results", "playwright-report", ".coverage", ".local"]);
  // Local data and test artefacts, at the repo ROOT only — public/js/data is source.
  const SKIP_ROOT = /^(?:data|uploads|backups)(?:$|-)|^smoke-data-/;
  const TEXT = /\.(?:md|ya?ml|js|cjs|mjs|json|sh|html|txt|example)$|(?:^|\/)Dockerfile[\w.-]*$/;
  const REPO_URL = /github\.com[/:]([A-Za-z0-9_.-]+\/(?:se-)?hackarena)(?:\.git)?(?![\w-])/gi;
  function scanTree(root, exempt) {
    const bad = [];
    let scanned = 0, seenCanonical = 0;
    const walk = (dirRel) => {
      for (const e of fs.readdirSync(pathMod.join(root, dirRel), { withFileTypes: true })) {
        const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
        // Never follow a symlink: ./data and ./uploads point at a live deployment.
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || (dirRel === "" && SKIP_ROOT.test(e.name))) continue;
          if (fs.existsSync(pathMod.join(root, rel, ".git"))) continue;   // a nested checkout
          walk(rel);
          continue;
        }
        if (!e.isFile() || !TEXT.test(rel) || exempt.has(rel)) continue;
        scanned++;
        const lines = fs.readFileSync(pathMod.join(root, rel), "utf8").split("\n");
        lines.forEach((l, i) => {
          for (const m of l.matchAll(REPO_URL)) {
            if (m[1].toLowerCase() === CANONICAL) { seenCanonical++; continue; }
            bad.push(`${rel}:${i + 1}: ${m[0]}`);
          }
        });
      }
    };
    walk("");
    return { bad, scanned, seenCanonical };
  }

  test("(c) every text file in the tree names this repository by its current address", () => {
    // Narrow by construction, so it cannot be wrong about a third-party URL: it
    // looks only at github.com URLs whose repository is this project's name.
    const EXEMPT = new Map([
      ["AGENT_AUDIT_MEMORY.md", "the operator's own file, which agents do not edit"],
    ]);
    const { bad, scanned, seenCanonical } = scanTree(ROOT, EXEMPT);
    expect(scanned, "anti-vacuity: the walk read the tree's text files").toBeGreaterThan(300);
    expect(bad,
      `this repository lives at github.com/${CANONICAL}; an older address resolves only through GitHub's ` +
      `transfer redirect, which ends the day somebody creates a repository at the old path:\n  ` + bad.join("\n  ")
    ).toEqual([]);
    // Asked AFTER the offenders, so a reverted address is reported by name rather
    // than as a missing canonical one.
    expect(seenCanonical, "anti-vacuity: at least one document names the repository by its current address (perf/README.md's clone)").toBeGreaterThanOrEqual(1);
  });

  test("(c) skips a nested checkout and still flags an ordinary directory (planted tree)", () => {
    const T = fs.mkdtempSync(pathMod.join(require("os").tmpdir(), "lockstep-c-"));
    try {
      const put = (rel, body) => { fs.mkdirSync(pathMod.dirname(pathMod.join(T, rel)), { recursive: true }); fs.writeFileSync(pathMod.join(T, rel), body); };
      // Assembled from parts, or this file's own fixture is a stale address the
      // real-tree arm above reports (it did, on the first run).
      const OLD = ["Checkmarx", "hackarena"].join("/");
      const STALE = `git clone https://github.com/${OLD}.git\n`;
      // A worktree (its .git is a FILE) and a submodule-style checkout (a .git DIR).
      put(".claude/worktrees/agent-x/.git", "gitdir: /elsewhere/.git/worktrees/agent-x\n");
      put(".claude/worktrees/agent-x/perf/README.md", STALE);
      put("vendor/sub/.git/HEAD", "ref: refs/heads/main\n");
      put("vendor/sub/README.md", STALE);
      // CONTROL: the same text in an ordinary directory must still be reported,
      // or "skipped" is satisfied by a walker that reads nothing.
      put("docs/stale.md", STALE);
      put("docs/ok.md", "git clone https://github.com/cx-bizops/se-hackarena.git\n");
      const r = scanTree(T, new Map());
      expect(r.bad, "only the ordinary directory's stale address is reported").toEqual([`docs/stale.md:1: github.com/${OLD}.git`]);
      expect(r.seenCanonical).toBe(1);
    } finally { fs.rmSync(T, { recursive: true, force: true }); }
  });
});
