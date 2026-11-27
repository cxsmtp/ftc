# Contributing to Hack Arena

Thanks for helping out. Hack Arena is a small-scale hackathon tournament platform written as a deliberate single-process Node + SQLite monolith — see the root `README.md` for the ops-first picture and `CLAUDE.md` for the code-first picture.

This document is the short, human-oriented onboarding. For the detailed local-development workflow (server, tests, screenshots, versioning), see [DEVELOPMENT.md](./DEVELOPMENT.md).

## Where to start

1. Read the `README.md` and run the "Quick Start" to get a local server up. Two minutes.
2. Read `DEVELOPMENT.md` — the bits about test parallelism (`WORKERS=24` by default), version-bump procedure, screenshot regeneration, and the deliberate monolith design will save you head-scratching later.
3. Pick an issue from GitHub Discussions or propose a change.

## Before you open a PR

- [ ] `npm test` passes locally on Chromium — a few thousand tests, a few minutes at the default `WORKERS=24` (count them with `npx playwright test --list` rather than trusting a number here).
- [ ] If you touched anything under `public/js/**`, also run `npm run smoke` — it boots a real server in **both** serving modes (dev raw modules, prod esbuild bundle) and drives the SPA. `node --check` parses a file that the browser will refuse to run.
- [ ] If your change touches UI styling / copy, regenerate screenshots with `npm run docs:shots` and commit the delta.
- [ ] If your change bumps behaviour, update `CLAUDE.md` — it's the source of truth for the Claude Code agent and is skimmed by humans too.
- [ ] Version bump: `npm run bump patch` (or `minor` / `major`). Never hand-edit `version.json` / `package.json` / `docker-compose.yml` / `swagger.yaml` — the script keeps all **four** in sync and `npm run check-version` fails if they drift. `package-lock.json` carries a fifth copy of the version and is DELIBERATELY excluded: the CI image bakes a sha256 of the whole file, so syncing it would force an image rebuild every release for a field nothing reads. The reason lives in full at the top of `scripts/check-version.js`.
- [ ] No new files under `docs/screenshots/` should be added outside of `npm run docs:shots`.
- [ ] A new spec file requires `./isolated-test`, not `@playwright/test` (see Testing below).
- [ ] If you changed the `Dockerfile`, `package-lock.json` or `scripts/prune-runtime-deps.cjs`, build the image and boot it (`docker build -t hackarena:check .`, then a container with scratch `DATA_DIR`/`UPLOADS_DIR` volumes and `BASE_URL` and `SMTP_HOST` set — the server refuses to start without them — answering `/readyz`). No CI job builds the image, and the build fails closed — on a native binary or build input the prune script's decision table does not cover, or on the image's own self-check — so a dependency bump can produce an image that will not build.
- [ ] An operator script under `scripts/` that reads or writes the data volume takes it from `DATA_DIR` and **refuses** when it is unset or empty — before it creates, reads or deletes anything — rather than guessing a default such as `<repo>/data`. The server (`lib/data-dir.js`), `scripts/backup.sh`, `scripts/purge.sh`, `scripts/restore-mail.sh` and `scripts/migrate.sh` (`pack` and `unpack`) all work this way, a test in `tests/data-dir-required.spec.js` fails on a shell script that gives `DATA_DIR` a non-empty default (`tests/migrate-script.spec.js` holds migrate.sh's refusal), and every example invocation you document sets the variable after `sudo` (`sudo DATA_DIR=/opt/hackarena/data scripts/…`), because `sudo` resets the environment.

## What "in scope" looks like

Hack Arena is opinionated about what it is — and isn't:

- **Single-process, single-volume.** Do not add features that require a second process, Redis, or clustered SQLite. The README has a "Run as a single process" section explaining exactly which in-memory caches would break under horizontal scaling. If a feature really needs it, that's a big architectural conversation, not a patch.
- **Pragmatically modular.** The backend is `server.js` (bootstrap + the deliberately-inline routes) with the rest carved into `routes/<entity>.js` (one module per domain) and `lib/*.js` (shared modules — `ls lib/` for the current set); the SPA is ES modules under `public/js/**` (the old ~9k-LOC `public/app.js` was split up in v7.0.0 and no longer exists). Splitting into modules for its own sake is not welcome; splitting because a cohesive new feature needs its own file is fine.
- **Small dependency surface.** Every new runtime dep gets reviewed for the tournament-scale blast radius. Prefer vanilla browser APIs, prefer stdlib, prefer what's already in `package.json`.
- **Backwards-compatible by default.** The platform ships as a single Docker image with persistent data volumes. A schema change that can't roll forward on an existing DB needs a migration path; a config change that breaks existing operators needs an upgrade note in `README.md § Upgrading`.

## Code style

There's no linter / formatter enforced today — no ESLint or Prettier config ships with the repo, deliberately, so a formatting sweep never obscures a behaviour change in review. Please:

- Match the style of the file you're editing. `server.js` + `routes/` + `lib/` use 2-space indent + function declarations + trailing-comma-optional; the `public/js/**` SPA modules use terser formatting for density.
- Don't reformat large regions just to change style.
- Prefer comments that explain **why**, not **what**.

## Testing

- Playwright API + UI tests are the primary bar. A helper that is hard to reach over HTTP can be tested directly: a spec may `require` the `lib/` module and call it (`tests/certificate-config.spec.js` does, beside its API arms). A module that reaches `db.js` is required inside the test, never at the top of the spec (see CLAUDE.md, *Per-file isolation*). Before adding one, weigh whether the complexity is needed.
- **Every spec file must `require("./isolated-test")` instead of `@playwright/test`.** That harness replaces the worker's server — wiped data directory, fresh process, fresh seed — once per file, which is what makes the suite give the same result at `WORKERS=24`, `4` and `2`. A spec that imports the runner directly silently opts out of isolation and, worse, still passes while taking down some unrelated later file. A Docs-hygiene lock fails the build if one does.
- If you're fixing a bug, add a test that would have caught it. **Then break the fix and confirm the test fails** — a lock that cannot fail is the recurring defect in this suite, not a hypothetical. If you can't write one, say so in the PR.
- The suite is deterministic at any worker count. If your test is flaky, root-cause it rather than adding retries; `npm run test:changed` re-runs just the specs your branch touched, twice, with retries on.
- Accessibility scans run inline in the suite (axe-core with a moderate+ gate). They will fail your PR if you introduce a contrast regression or a missing label.

## Reporting security issues

**Do not open a public issue.** Email the maintainers. See `SECURITY.md` (if absent, contact the repo admins via GitHub).

## License

By contributing, you agree your work is distributed under the repository's license (see `LICENSE`).
