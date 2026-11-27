# CI: the pre-baked test-runner image

**Three** jobs in `.github/workflows/checkmarx.yml` — `cross-browser-tests`,
`full-suite-tests` and `capture-suite` (v8.8.19) — run inside a **pre-baked
image** instead of installing dependencies at job time. All three pin the *same*
digest, so every rebuild has to re-point **all three** `image:` lines; count the
`image: mpogr/hackarena-ci@sha256:` lines in the workflow rather than trusting
this sentence, because it read "two" for four releases after the third job was
added.

## Why

Those jobs run on a hardened (StepSecurity Harden-Runner) self-hosted runner
whose egress allowlist is essentially `github.com` only. We verified in CI that:

- `registry.npmjs.org` is **unreachable** (DNS dropped) — on the host *and* in a
  container — so `npm ci` cannot fetch packages at job time, and there is no warm
  npm cache to fall back on.
- `cdn.playwright.dev` is unreachable, so `npx playwright install` can't download
  browsers either.
- `apt` mirrors (`archive.ubuntu.com`) are blocked, so a compiler for
  `better-sqlite3`'s native build can't be installed at job time.

Docker Hub (`registry-1.docker.io`) **is** allowlisted. So we install everything
once, at **image build time** (where the registry + a toolchain are available),
bake it into an image, and the job just pulls + runs it.

## The image

`ci/Dockerfile.cross-browser` builds **FROM** the official
`mcr.microsoft.com/playwright:v1.65.1-noble` (browsers + OS deps already inside)
and adds the project's `node_modules` via a full `npm ci`. Built natively in that
image, so `better-sqlite3` matches the image's Node ABI and `@playwright/test`
matches the bundled browsers.

**Node is replaced with production's major, and that is load-bearing.** The
Playwright base image ships whatever Node its release pinned (26 since
`v1.65.0-noble`, 24 up to `v1.64.1-noble`) while production runs
`node:26-alpine` — so whenever the two differ, the only environment exercising
the base's Node would be one nobody deploys, and the baked native addons would be
built for an ABI production never uses. The
Dockerfile therefore installs production's major via `ARG NODE_MAJOR` (currently
**26**, and it must equal the major in the app `Dockerfile`'s `FROM
node:<major>-alpine`). A test — *"v7.15.28: the CI image's Node major is in
lockstep with production's"*, in `tests/functional-core-b.api.spec.js` — fails if
the two drift, and names the remedy.

Consequence worth knowing before you bump production's Node: it is a **two-step**
change. Edit the app `Dockerfile`, then rebuild + push this image with the
matching `NODE_MAJOR` and re-pin its digest (below). The tarball is fetched as
`.tar.gz`, not `.tar.xz` — the base image has no `xz` binary and `tar` fails with
an opaque *"Child returned status 2"*.

`node_modules` is baked at **`/ci-deps`** (not the workspace path) because a
`container:` job mounts the workspace over its working directory, which would
shadow a `node_modules` placed there. The job symlinks `/ci-deps/node_modules`
into the checked-out workspace. A `package-lock.json` SHA-256 is baked to
`/ci-deps/.lock-hash`; the job compares it and **fails loudly** if deps changed
without an image rebuild.

**The build fails if the image does not work (v8.13.4).** The Dockerfile's check
`RUN` uses the image rather than inspecting it: it opens a `better-sqlite3`
database (better-sqlite3 13 loads its native addon lazily, so a bare `require()`
proves nothing), hashes and compares with `bcrypt`, checks that every browser
`playwright-core`'s own `browsers.json` installs by default is present under
`$PLAYWRIGHT_BROWSERS_PATH` at exactly the revision it drives, and launches
chromium (headless shell and full build), firefox and webkit, comparing each
version with `browsers.json`. A rebuild on the wrong base passes every other guard
— the lockfile hash, the Node major, `cli.js --version` — and would otherwise
surface only in CI, as *"Executable doesn't exist"*, after an upload measured in
hours. It is a `RUN` of its own, after the `npm ci` one: it adds one small layer
(about 130 KB compressed) and every layer below it stays cached. A text lock,
`tests/ci-config-lockstep.spec.js`, separately holds the `FROM` tag, the
lockfile's Playwright and the workflow's tag comments together; it cannot prove
that a pinned *digest* was built on that base, which is why the build step exists.

**`sqlite3` and `rsync` are the last layer**, so the full-suite job runs
`scripts/backup.sh` and `scripts/purge.sh` for real instead of skipping their
behavioural tests. Being last, adding or changing it reuses every layer above.
The image still has no `lsof` or `ss`; the tests read `/proc` instead. Note that
the image copies `package.json`, so a rebuild after a version bump re-runs
`npm ci` (a new layer of about 190 MB) even when the lockfile has not changed.

Published tag: `mpogr/hackarena-ci:playwright-v1.65.1-noble-deps`.

The image carries a `HEALTHCHECK` (a file test on `/ci-deps/.lock-hash`; the
runner never waits on a job container's health) and deliberately **no `USER`**:
the three jobs need root for `actions/checkout` on the bind-mounted workspace and
for the `HOME=/root` Firefox pin. Run it unprivileged locally with
`--user pwuser`. Its base's OS-package CVEs are triaged in Checkmarx One as not
exploitable: the image is never deployed, `.dockerignore` keeps `ci/` out of the
app image, and no newer base exists until the next Playwright release.

The workflow pins this image **by digest** (`mpogr/hackarena-ci@sha256:…`), not by
the mutable tag, for a reproducible + tamper-evident pull — the same policy as the
SHA-pinned `uses:` actions. The tag is kept as the trailing `#` comment on each
`image:` line. **The pin must stay a digest**, so every rebuild+push has to also
re-point that digest (below); a bare `:tag` must never be reintroduced.

**The tag is mutable, and the workflow pin is the authority.** A build pushed to a
tag and never pinned moves the tag without moving CI: v8.13.2 pushed such a build
to the previous base's tag, so on 10 October 2026 that tag resolved to
`sha256:2e735d77…` while the workflow pinned `sha256:f1e2f2c5…`. To know which
image CI runs, read the digest off the workflow's `image:` lines, never off the
tag.

## When + how to rebuild

Rebuild and push when **any** of these changes:
- `package-lock.json` (any dependency add/remove/bump), or
- the Playwright version (`@playwright/test` in the lockfile) — then also bump
  the base image tag in `ci/Dockerfile.cross-browser` **and** the `image:` tag (in
  the trailing comment) in the workflow, keeping all three in lockstep (the text
  lock above fails until they agree, and the build fails on a mismatched base), or
- **production's Node major** (the app `Dockerfile`'s `FROM node:<major>-alpine`)
  — then also bump `ARG NODE_MAJOR` here, or the drift test fails the run.

Either way you **must re-pin the digest** in `.github/workflows/checkmarx.yml`
after pushing:

```sh
# from the repo root, on a machine with registry access + docker login to mpogr
docker build -f ci/Dockerfile.cross-browser --provenance=false --sbom=false \
  -t mpogr/hackarena-ci:playwright-v1.65.1-noble-deps .
docker push mpogr/hackarena-ci:playwright-v1.65.1-noble-deps

# The push prints the new digest ("... digest: sha256:XXXX size: NNNN"); or read it
# back explicitly:
docker buildx imagetools inspect \
  mpogr/hackarena-ci:playwright-v1.65.1-noble-deps --format '{{.Manifest.Digest}}'

# Then update ALL THREE container `image:` lines in .github/workflows/checkmarx.yml
# (cross-browser-tests, full-suite-tests AND capture-suite) to:
#   image: mpogr/hackarena-ci@sha256:<new-digest> # playwright-v1.65.1-noble-deps
#
# Re-pointing only some of them is a real failure mode, not a hypothetical: each job
# independently verifies the baked lockfile hash against the checkout, so the
# stale job dies on its own drift guard with a message about rebuilding an
# image that was, in fact, already rebuilt.
```

A rebuild changes the layers **above** whatever changed and reuses the rest from
the build cache: a `package-lock.json` change re-runs `npm ci` (one ~63 MB layer)
and the small check layer, while a **Playwright bump changes the base itself**, and
a new base shares at most its bottom Ubuntu layer with the old one. Measured: the
amd64 base was 955,790,767 bytes on 1.63.0, 985,650,491 bytes in 7 layers on
1.64.0 (none shared) and 1,002,814,156 bytes in 7 layers on 1.65.0 (only the
28 MB Ubuntu layer shared with 1.64.1), so a Playwright bump uploads nearly the
whole base again.

**`docker push` dying on a long upload** (`use of closed network connection`, on a
slow or throttled uplink) does not mean rebuilding: push each missing blob and the
manifest through the registry v2 API instead. Build with
`--provenance=false --sbom=false` so the tag is a single OCI manifest, `docker save`
the image (an OCI layout whose `blobs/sha256/*` are the exact compressed layers),
`HEAD` each blob on the registry, and upload only the missing ones — in small
chunked `PATCH`es (`Content-Range`, a fresh token per chunk), finalised with
`PUT …?digest=sha256:<blob>` — then `PUT` the manifest blob to `/manifests/<tag>`
with its own media type. The pinned digest is that manifest's sha256 (v8.13.1 and
v8.13.4 did exactly this). Two things decide how long it takes:

- **Docker Hub throttles each connection, not the uplink.** Measured from the
  build box on 10 October 2026: about 10 KB/s per upload connection, the same
  with six running at once. So upload the missing blobs **in parallel**, each on
  its own connection (one blob is still sequential — a chunked upload is
  ordered), and try a cross-repository mount (`POST …/blobs/uploads/?mount=<digest>&from=library/ubuntu`)
  first: a base's bottom layer is often the stock Ubuntu layer, which then costs
  nothing. Even so, a whole base takes hours from a box like that, so start the
  base upload early. The throttle is not constant: on 11 November 2026 the same
  box measured about 430 KB/s on one connection, and a plain `docker push` of
  the 1.65.0 image (about 1 GB of new layers) finished in 12 minutes. Measure
  first (one 1 MB `PATCH` to a fresh upload session) before choosing the route.
- **Use the direct route, never a shared SSH/SOCKS tunnel**: one large channel
  starves every other connection through it, `gh` included.

**Reading a digest without Docker.** This asks the registry what the tag points
at NOW — which is the pin only if nothing has been pushed to the tag since (see
"the tag is mutable" above). Use it to read back a push you have just made, and
check it against the digest your own push printed:

```sh
IMG=mpogr/hackarena-ci; TAG=playwright-v1.65.1-noble-deps
TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$IMG:pull" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  -H "Accept: application/vnd.oci.image.manifest.v1+json" \
  -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
  "https://registry-1.docker.io/v2/$IMG/manifests/$TAG" | grep -i docker-content-digest
```

If you forget to rebuild **or** to re-pin the digest, the job's "Link pre-baked
dependencies" step fails loudly: the pinned (old) image's baked lockfile hash no
longer matches the checked-out `package-lock.json`.

> Tip: when bumping the Playwright version, change the tag suffix too
> (`playwright-v<X.Y.Z>-noble-deps`) and update the trailing tag comment on every
> `image:` line to match. The digest is what actually pins the pull (an immutable
> digest can never resolve to a stale cached image), but keeping the tag comment
> accurate avoids confusion about which base image is baked in.

> **Check the base exists for amd64 before bumping `@playwright/test`.** The npm
> release and the MCR image do not land together: on 8 October 2026 npm carried
> `@playwright/test` 1.64.0 while MCR had published only the **arm64** variants
> (`v1.64.0-noble-arm64` and friends) — no amd64 `v1.64.0-noble`, which is what
> the CI runners pull. Bumping the package without its matching browser builds
> breaks every Playwright job ("Executable doesn't exist"), so the package and the
> `FROM` move together or not at all:
>
> ```sh
> docker buildx imagetools inspect mcr.microsoft.com/playwright:v<X.Y.Z>-noble   # must list linux/amd64
> ```
>
> The amd64 `v1.64.0-noble` was published by 10 October 2026 (image index
> `sha256:06a9939e…`, amd64 manifest `sha256:bc72a8df…`), and v8.13.4 took the
> bump.

> **Check every bumped package is at least two days old before rebuilding.** The
> org's StepSecurity "NPM Package Cooldown Check" force-cancels every CI job on a
> PR that adds an npm version published less than two days earlier — the jobs show
> as `cancelled` and the failing "StepSecurity Required Checks" names the package.
> v8.13.2 met it after a 1 h 47 min image upload and had to defer the bump. Before
> building, check each moved package:
>
> ```sh
> npm view <package>@<version> time --json | grep '"<version>"'   # must be ≥ 2 days ago
> ```
