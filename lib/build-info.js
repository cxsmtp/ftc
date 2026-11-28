"use strict";

// WHAT IS RUNNING, AS THE IMAGE WAS BUILT (Settings → About & health).
//
// The release workflow (.github/workflows/release-image.yml) bakes three build
// arguments into the image (Dockerfile: ARG, then ENV and an OCI label): the git
// commit it was built from, the build time, and the release channel its tags put
// it on (`stable` for main and v* tags, else `dev`). Read once at boot. A value
// missing or not in its shape (a local build, `npm start`, a hand-built image)
// is null, which the page shows as "unknown": never guessed from the checkout.

const _COMMIT_RE = /^[0-9a-f]{7,40}$/i;
const _CHANNEL_RE = /^[a-z0-9][a-z0-9.-]{0,31}$/i;

function _time(v) {
  const s = String(v || "").trim();
  if (!s || s.length > 40) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** `{commit, built_at, channel}`, each null when the build did not say. */
function readBuildInfo(env) {
  const commit = String(env.BUILD_COMMIT || "").trim();
  const channel = String(env.RELEASE_CHANNEL || "").trim();
  return Object.freeze({
    commit: _COMMIT_RE.test(commit) ? commit.toLowerCase() : null,
    built_at: _time(env.BUILD_TIME),
    channel: _CHANNEL_RE.test(channel) && channel.toLowerCase() !== "unknown" ? channel.toLowerCase() : null,
  });
}

const BUILD_INFO = readBuildInfo({
  BUILD_COMMIT: process.env.BUILD_COMMIT, BUILD_TIME: process.env.BUILD_TIME, RELEASE_CHANNEL: process.env.RELEASE_CHANNEL,
});

module.exports = { BUILD_INFO, readBuildInfo };
