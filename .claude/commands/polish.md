---
name: polish
description: Run the UI polish pipeline on one or more screens. Dispatches ui-polisher subagents in parallel (batch size 5), then the ui-visual-verifier sequentially to capture before/after screenshots and flag regressions.
---

# `/polish <target>`

`<target>` is either:

- A screen name from `.claude/screens.json` (e.g. `login`, `admin-participants`)
- A comma-separated list of screen names (e.g. `login,register,signin-code-step`)
- The literal `all` — expands to every screen in the manifest
- A file glob — only polishes screens whose manifest entry references that file (e.g. `public/index.html`)

## Workflow

1. **Parse `<target>` → list of screen slugs.** If `all`, read `.claude/screens.json` and collect every `screens[].screen`. If a file glob, read the manifest and include any screen whose `files.markup.path` / `files.behaviour.path` / `files.styles.path` (or a `behaviour.also` path) matches. If a comma-separated list, split it. Validate every slug exists in the manifest before proceeding. Screens marked `"status_note": "uncapturable"` are polished but never captured; say so in the report.

2. **Choose the capture matrix** (`POLISH_MATRIX`, read by `tests/_ui-polish.spec.js`):
   - `modes` (the default): the house look by day and by night, at 1280 and 390 px.
   - `full`: both looks by day and by night at 1280 and 390 px. **Use it whenever a polisher may touch a per-look rule (`[data-look=…]`), a token, `scripts/theme/looks.js` or the generated block.**
   - `looks` (both looks, both modes, 1280) and `house` (one shot) exist for quick checks.

3. **Phase BEFORE — capture baseline screenshots.** Dispatch the `ui-visual-verifier` subagent with:
   - `POLISH_PHASE=before`
   - `POLISH_SCREENS=<csv-of-slugs>`
   - `POLISH_MATRIX=<matrix>`
   The verifier runs `npm run polish:shots`, writing `.claude/visual-diffs/<screen>@<look>-<mode>-<width>-before.png` per screen and combination. Wait for completion. If the exit code is non-zero, stop and report — do not start polishing against a failing baseline.

4. **Phase POLISH — dispatch `ui-polisher` subagents in PARALLEL.** Batch size **5** (no more; every screen shares `public/styles.css`, and Edit contention would race if higher). Each subagent gets exactly one screen slug + a pointer to `.claude/DESIGN_SYSTEM.md` + a pointer to `.claude/screens.json`. Fire batches sequentially — batch 1 of 5 must complete before batch 2 starts, because subagents within a batch edit the same files and must not stomp each other's edits.

   **Prefer batching screens that share a behaviour module.** Two screens owned by different `features/*.js` modules contend only on `public/styles.css`. Batching by module keeps each subagent's edits local and makes a bad batch easy to revert.

   **Parallel dispatch is REQUIRED inside a batch.** Send all 5 Agent invocations in a single tool-call block. Do not serialise them.

   Between batches, run `git diff --stat public/` and briefly summarise. Then verify the SPA still builds:

   ```bash
   npx esbuild public/js/core/main.js --bundle --format=esm --outfile=/dev/null
   ```

   **Use the bundler, not `node --check`.** `node --check` parses a single file and passes on errors that are fatal in a browser — a backtick inside an HTML comment inside a template literal terminated the literal in v7.21.0, `node --check` was happy, and the whole SPA failed to parse. esbuild resolves the import graph and names the file, line and column. If the bundle fails, stop and ask the operator how to proceed.

5. **Phase AFTER — capture post-polish screenshots.** Dispatch `ui-visual-verifier` again with:
   - `POLISH_PHASE=after`
   - `POLISH_SCREENS=<same-csv>`
   - `POLISH_MATRIX=<same matrix>`
   The verifier captures the `-after.png` variants and diffs them against the `before` pairs, flagging any regressions.

6. **Phase VERIFY — run the accessibility and design locks.** Run all three:
   ```bash
   WORKERS=1 RETRIES=0 npx playwright test \
     tests/ui-admin-*.spec.js tests/ui-participant-*.spec.js \
     -g "axe|accessibility|contrast"
   RETRIES=0 npx playwright test \
     tests/layout-integrity.spec.js tests/dark-theme-a11y.spec.js tests/interactive-contrast.spec.js \
     tests/theme-tokens.spec.js tests/type-scale-scanner.spec.js tests/radius-tokens.spec.js tests/label-in-name.spec.js \
     tests/help-tips-coverage.spec.js tests/hover-pulse-no-fade.spec.js tests/code-blocks.spec.js \
     tests/signin-fit.spec.js tests/app-chrome.spec.js
   node scripts/build-theme-tokens.js --check
   ```
   Every scan must stay green. If any fail, surface the violation.

   **The globs are deliberate.** `tests/ui-admin.spec.js` and `tests/ui-participant.spec.js` were split into `ui-admin-{a11y,competitions,tasks,rankings,misc}.spec.js` and `ui-participant-{a,b,c}.spec.js`. Naming them individually is how this step once silently broke: Playwright exits non-zero with "no tests found" and the gate never ran. A glob survives the next split. The second command runs whole files: `layout-integrity.spec.js` holds the geometric assertions axe cannot make, and a `-g` filter would keep only two of them.

   **What VERIFY covers:** axe on the app screens in the house look by day (the `ui-*` specs) and by night (`dark-theme-a11y`), the sign-in screen in every look and mode (`dark-theme-a11y`'s look loop), hover and focus contrast in every look, mode and Ambient colour (`interactive-contrast`, statically), the palette's every text pair (`theme-tokens` and the generator's `--check`), the Flat Design 3.0 scanner, the type-scale scanner and the radius-token scanner. **What it does not cover:** Safari and Firefox (the non-chromium Playwright projects run only `tests/cross-browser.spec.js` and `tests/cross-device.spec.js`), and tablet portrait. A green VERIFY is not evidence about those.

7. **Phase REPORT — summarise to the operator.**
   ```
   POLISH RUN — <timestamp>
   SCREENS: <csv>   MATRIX: <matrix>
   POLISHERS:
     - <screen-1>: <one-line summary from subagent>
     - <screen-2>: <one-line summary>
     ...
   VISUAL DIFFS: .claude/visual-diffs/<screen>@<look>-<mode>-<width>-{before,after}.png pairs
   REGRESSIONS: (none | <list>)
   VERIFY: <pass | fail — which spec and screen>
   FILES CHANGED: git diff --stat output
   NEXT STEPS: operator decides whether to commit / refine / revert.
   ```

## Dispatch rules

- **Parallel when 3+ independent files with no shared state.** This command ALWAYS parallel-dispatches up to 5 ui-polisher subagents inside a batch (they all share `public/styles.css`, so the batch itself is the concurrency unit; different batches run sequentially).
- **Sequential when shared state or ordering matters.** The `ui-visual-verifier` runs sequentially because it drives Playwright, which locks the chromium instances owned by the webServer config.

## What this command must NOT do

- Invoke the Playwright MCP. Only `npm run polish:shots` via the verifier subagent.
- Modify `playwright.config.js`, `tests/helpers.js`, `tests/server-env.js`, `tests/isolated-test.js`, `tests/ui-admin-*.spec.js`, `tests/ui-participant-*.spec.js`, `tests/layout-integrity.spec.js`, or any other existing test file. (`tests/_ui-polish.spec.js` and `tests/polish-fixtures/` are this pipeline's own capture harness and may be maintained deliberately — the harness is excluded from `npm test` by the `_`-prefix `testIgnore` rule — but never edit them *during* a polish run.)
- Commit. The operator reviews and commits manually.
- Run on more than 5 screens per batch — single-file contention would corrupt edits.
- Bypass the scans in phase VERIFY. If one fails, the run is a failure even if the screenshots look fine.

## Example

```
/polish login
/polish login,register,signin-code-step
/polish all
/polish public/index.html
```
