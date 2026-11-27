# ── Build stage ───────────────────────────────────────────────────────────
# Installs the production dependencies with npm and the native-addon toolchain,
# strips the addons' build residue and normalises the app tree's file modes
# (both below), so the runtime image needs neither npm, nor a compiler, nor
# anything a compiler reads or writes, nor anything from the build host's umask.
#
# v8.13.3 — THE NATIVE DEPENDENCIES DO NOT COMPILE HERE, and this comment used to
# say they always did. Both ship musl prebuilds, and those are what the runtime
# loads: better-sqlite3 v13 under prebuilds/linuxmusl-*, bcrypt 6 as
# prebuilds/linux-*/bcrypt.musl.node (measured in the built image: no .node file
# under better-sqlite3/build at all, only gyp stamp files). The toolchain stays
# because npm still runs better-sqlite3's implicit `install: node-gyp rebuild` —
# it ships a binding.gyp — and node-gyp needs python3 + make even though
# binding.gyp builds nothing when a matching prebuild exists; g++ is there only
# for the from-source fallback on a platform with no prebuild.
#
# v8.13.4 (operator decision) — THE TOOLCHAIN STAYS IN THIS STAGE, AND NOTHING IT
# READS OR WRITES REACHES THE RUNTIME IMAGE. scripts/prune-runtime-deps.cjs (run
# below) deletes the SQLite amalgamation and the addons' C++ sources, their gyp
# and Makefile files, node-addon-api's headers, gyp's output directory and every
# other platform's prebuilt binary, keeping exactly what a probe of the
# installed tree LOADS and uses. Two consequences:
#   - this stage must be the SAME image as the runtime stage, and never a
#     `FROM --platform=$BUILDPLATFORM` cross-build: the prune keeps what loads
#     HERE (a Docs-hygiene lock holds the two FROM lines equal);
#   - the build FAILS CLOSED when a dependency bump brings a native binary or a
#     build input the script's decision table does not cover, naming the
#     package and the remedy — an image that refuses to build, instead of one
#     that boots with a binary missing. Build and boot the image before a deploy
#     whenever package-lock.json, this file or the script changes: CI has no
#     docker (README, Docker). README's redeploy builds before it replaces the
#     running container, so a refused build leaves the old version serving.
FROM node:26-alpine AS build
WORKDIR /app
# python3 + make for node-gyp's configure step, g++ for the no-prebuild fallback.
# Pinned to the base's Alpine branch (3.24: python3 3.14, make 4.4, g++ 15.2) by
# apk's fuzzy `~=` form, so a later -rN security rebuild still installs while a
# silent jump to another toolchain does not (KICS "Unpinned Package Version in
# Apk Add"). A node:<major>-alpine that moves to a new Alpine branch fails this
# line by name: run `apk update` then `apk policy python3 make g++` in the new
# base and re-pin, never unpin (README, Docker: "When the build stops at apk add").
RUN apk add --no-cache python3~=3.14 make~=4.4 g++~=15.2
COPY package*.json ./
# allowScripts (package.json) is honoured by npm 11. Three packages carry an
# entry: better-sqlite3 (the node-gyp rebuild above — it compiles nothing when a
# prebuild matches, but writes gyp's Makefiles, config.gypi and stamp files into
# build/, which the prune below removes), bcrypt (node-gyp-build, which picks its
# musl prebuild) and esbuild (a postinstall that installs its platform binary).
RUN npm ci --omit=dev
# v8.13.4 — STRIP THE BUILD RESIDUE, HERE. Copied to /tmp, not under /app or /src,
# so the script itself never reaches the runtime image; after `npm ci`, so a
# change to it never invalidates the dependency layer; run with plain `node`,
# never `npm run` (npm exports npm_config_* variables that node-gyp-build reads).
# `--apply` is the only way it deletes anything. It exits non-zero, failing the
# build, if a binary stops loading after the prune or it meets something its
# decision table does not cover (tests/prune-runtime-deps.spec.js).
COPY scripts/prune-runtime-deps.cjs /tmp/prune-runtime-deps.cjs
RUN node /tmp/prune-runtime-deps.cjs /app/node_modules --apply
# v8.13.3 — THE APP TREE'S FILE MODES ARE DECIDED HERE, NOT BY THE BUILD HOST.
# The runtime stage copies this tree WITHOUT --chown, so it stays root's and the
# `node` user can only read it (see below). A COPY without --chown keeps the
# build context's modes, so a checkout made under a restrictive umask (027 on a
# CIS-hardened host: 0640 files, 0750 dirs) would land as root:root files `node`
# cannot even READ, and the container would crash-loop on EACCES opening
# server.js — measured. The old --chown=node:node masked that by making `node`
# the owner.
# Normalising here instead (owner rw, everyone else read; directories and
# already-executable files traversable) works on any builder: `COPY --chmod`
# with a symbolic mode needs a modern Dockerfile frontend and the legacy builder
# rejects --chmod outright, and a `chmod -R` in the RUNTIME stage would copy every
# file into a second layer. Placed after `npm ci` so a code change never
# invalidates the dependency layer.
COPY . /src
RUN chmod -R u=rwX,go=rX /src
# v8.13.4 — .dockerignore admits ONE file under scripts/, the prune script, for
# the COPY above; the context mirror therefore carries it too. It is a
# build-stage tool, not part of the app, so it goes before the runtime stage
# copies /src (and /app/scripts never exists — the self-check below refuses it).
RUN rm -rf /src/scripts

# ── Runtime stage ─────────────────────────────────────────────────────────
FROM node:26-alpine
# v8.13.2 (external audit) — THE RUNTIME IMAGE CARRIES NO NPM. The
# base ships npm (and npx) with ~18 MB of npm's OWN bundled dependencies, and a
# container scanner reports their advisories against this image — twelve matches,
# four rated high, on the audit's run. None of it is reachable: the app starts
# with `node server.js`, the healthcheck is `node -e`, and every dependency was
# installed in the build stage above and copied in. So the scanner noise and the
# attack surface go together, here, as root, before the switch to `node`.
#
# docker-entrypoint.sh stays: it is the image's ENTRYPOINT and needs only node.
# Corepack and Yarn are listed too because older Node majors bundled them — a
# Node major bump must not quietly bring a JavaScript package manager back. (apk,
# Alpine's own, stays: it is the OS, and the step below uses it.)
#
# v8.13.4 — and the base's compile inputs. /usr/local/include/node holds Node's,
# V8's, libuv's and OpenSSL's C headers plus common.gypi and config.gypi (6.6 MiB,
# measured): what node-gyp reads to compile an addon, and nothing else. Nothing at
# runtime compiles, and npm — whose bundled node-gyp was its one reader here —
# goes on the same line.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
           /usr/local/include/node
# v8.13.2 — and Alpine's own security updates, applied at build time. Pulling the
# current node:<major>-alpine (docker-compose.yml `build.pull`) only gets what the
# official image was last REBUILT with; Alpine publishes package fixes between those
# rebuilds (measured on release day: the current base shipped zlib 1.3.2-r0 while
# Alpine's security database already listed 1.3.2-r1 as fixing a CVE). Upgrading
# within the base's own Alpine release changes no ABI the build stage compiled
# against.
#
# v8.13.3 — BUT THIS IS AN ORDINARY CACHED BUILD LAYER, so it carries the fixes
# Alpine had published when it first RAN, not when the image is built. Its cache
# key is the base digest plus this line, and nothing above it moves when the app
# does, so on an unchanged node:<major>-alpine digest every later build reuses the
# first build's upgrade. `docker image prune -a` removes images, not build cache,
# and `build.pull` only re-checks the base; neither re-runs it. A moved base
# digest does, and so does a build without the cache (`docker compose build
# --no-cache`, or `docker builder prune -f` once NO image still uses the layer — a
# plain prune skips a layer an existing image uses, which is why README's
# redeploy builds with `docker compose build --pull --no-cache`). A Docs-hygiene lock pins this line to exactly
# `RUN apk upgrade --no-cache`: `--simulate`, a package argument or
# `--self-upgrade-only` would keep the step and upgrade nothing.
RUN apk upgrade --no-cache
# v8.8.26 — DATA_DIR is REQUIRED by the app and has no default, so the image
# states its own. `/app/data` is exactly what the fallback used to resolve to
# (WORKDIR is /app), and exactly what docker-compose mounts the host volume onto,
# so this changes nothing about where a container writes — it only makes the path
# declared rather than inferred from where the code happens to sit.
#
# An `env_file` or an explicit `environment:` entry still overrides this, which is
# the point: an operator pointing the container at a different volume says so in
# one place. UPLOADS_DIR is set alongside it for the same reason, and is just as
# REQUIRED: since v8.8.27 lib/config exits FATAL without it (requireUploadsDir in
# lib/data-dir.js), so this line is load-bearing, not belt-and-braces.
ENV DATA_DIR=/app/data
ENV UPLOADS_DIR=/app/uploads
# v8.13.3 — THE CODE TREE IS ROOT'S; THE RUNTIME USER OWNS ONLY ITS TWO VOLUMES.
# Until now every COPY below carried --chown=node:node and `USER node` came first,
# so /app, server.js, lib/, routes/, public/ and node_modules/ were all node's: a
# compromised `node` process could rewrite a route or a served script and have
# the change survive a restart. The app writes only under DATA_DIR (the database
# and its WAL, attachments, logs, the HMAC secrets, the superadmin password) and
# UPLOADS_DIR (multer's temp files) — every fs write in server.js, db.js, lib/ and
# routes/ targets one of the two — so those two directories, and nothing else,
# are handed to `node`. WORKDIR runs before `USER node` so /app itself is root's;
# both COPYs come from the build stage — /src with its modes normalised above,
# node_modules as npm installed it inside that container (umask 022, never the
# build host's) and then pruned — so `node` reads the code and writes none of
# it. A fresh named volume mounted on either path inherits node:node from the
# directory created here; a bind mount keeps the host's ownership, as before.
# Consequence for an operator: LOG_DIR, DATA_DIR and UPLOADS_DIR must point under
# those volumes (or another mount the `node` user can write) — elsewhere under
# /app nothing is writable, so a DATA_DIR there stops the boot on EACCES (README
# says what the other two do).
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /src/ ./
RUN mkdir -p "$DATA_DIR" "$UPLOADS_DIR" && chown node:node "$DATA_DIR" "$UPLOADS_DIR"
# v8.13.4 — THE IMAGE CHECKS ITSELF. This is the one assertion that runs against
# the filesystem that actually ships, on every build: CI has no docker, the
# Docs-hygiene locks read this file's text, and tests/prune-runtime-deps.spec.js
# prunes a COPY of the dependency tree — none of them sees the image. No
# compiler, make, python, node-gyp, npm or npx on PATH (exact names, so the
# runtime loader node-gyp-build is not mistaken for node-gyp); no build input
# under /app/node_modules — the same list as BUILD_INPUT in
# scripts/prune-runtime-deps.cjs (C/C++/assembly sources and headers, gyp, cmake
# and make files, gyp's Python, object files and static archives); no
# /app/scripts; no /usr/local/include/node. Any one of them fails the build, by name.
RUN set -eu; \
    for t in gcc g++ cc c++ make python3 python node-gyp npm npx; do \
      if command -v "$t" >/dev/null 2>&1; then echo "image self-check: build tool on PATH: $t" >&2; exit 1; fi; \
    done; \
    left="$(find /app/node_modules \( -name '*.c' -o -name '*.cc' -o -name '*.cpp' -o -name '*.CPP' \
      -o -name '*.cxx' -o -name '*.c++' -o -name '*.cp' -o -name '*.C' -o -name '*.h' -o -name '*.H' \
      -o -name '*.hh' -o -name '*.hp' -o -name '*.hpp' -o -name '*.HPP' -o -name '*.hxx' -o -name '*.h++' \
      -o -name '*.ipp' -o -name '*.inl' -o -name '*.tcc' -o -name '*.S' -o -name '*.s' -o -name '*.sx' \
      -o -name '*.asm' -o -name '*.gyp' -o -name '*.gypi' -o -name '*.mk' -o -name '*.cmake' -o -name '*.py' \
      -o -name '*.o' -o -name '*.obj' -o -name '*.a' -o -name '*.lib' -o -name Makefile -o -name GNUmakefile \
      -o -name makefile -o -name Makefile.in -o -name CMakeLists.txt \) -print)"; \
    if [ -n "$left" ]; then echo "image self-check: build inputs under /app/node_modules: $left" >&2; exit 1; fi; \
    for p in /app/scripts /usr/local/include/node; do \
      if [ -e "$p" ]; then echo "image self-check: the runtime image carries $p" >&2; exit 1; fi; \
    done
USER node
EXPOSE 3000
ENV NODE_ENV=production
# WHAT THIS IMAGE WAS BUILT FROM, shown under Settings → About & health
# (lib/build-info.js): the release workflow passes the commit, the build time
# and the release channel its tags put the image on. A build that passes none
# (a local `docker build`) reports each as unknown. Declared last, so a new
# commit rebuilds only these layers.
ARG BUILD_COMMIT=unknown
ARG BUILD_TIME=unknown
ARG RELEASE_CHANNEL=unknown
ENV BUILD_COMMIT=$BUILD_COMMIT BUILD_TIME=$BUILD_TIME RELEASE_CHANNEL=$RELEASE_CHANNEL
LABEL org.opencontainers.image.revision=$BUILD_COMMIT org.opencontainers.image.created=$BUILD_TIME
# ext-audit v7.15.12: probe /readyz, matching docker-compose.yml. v7.15.11 added
# the DB-aware readiness endpoint and wired compose to it but left THIS baked-in
# healthcheck on /healthz, so anyone running the image directly (or any
# orchestrator reading the image's own healthcheck) still treated a
# known-corrupt database as healthy. /readyz also covers the original reason this
# is not /api/config: it 503s during maintenance by design, which is the correct
# signal for a load balancer, while /healthz stays 200 for liveness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/readyz').then(r=>{if(!r.ok)throw r.status;process.exit(0)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
