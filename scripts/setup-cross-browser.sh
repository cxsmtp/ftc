#!/usr/bin/env bash
# setup-cross-browser.sh — make Firefox + WebKit runnable for `npm run test:cross`
# on a host WITHOUT root / `playwright install-deps` (e.g. Linux Mint, or any box
# where you can't apt-install system deps).
#
# WHY THIS EXISTS: `npx playwright install firefox webkit` downloads the browser
# binaries, but they need a few system shared libraries that aren't present on
# non-Ubuntu hosts (libavif/libgav1/libyuv for WebKit's image codecs; a newer
# libnss3 for Firefox than this OS ships). The official fix is
# `sudo npx playwright install-deps`, which needs root and only targets
# Ubuntu/Debian. This script side-loads exactly those libs into /tmp/pw-libs
# (the path playwright.config.js's LD_LIBRARY_PATH shim already points at) by
# `apt-get download`-ing the .debs (no install, no root) and extracting them.
#
# After running this, use `npm run test:cross` (which sets the env vars).
# NOTE: /tmp is volatile — re-run this after a reboot, or move SHIM to a
# persistent dir and update playwright.config.js's LIB_PATH to match.
#
# RE-RUN IT AFTER EVERY PLAYWRIGHT VERSION CHANGE, too. A Playwright bump brings
# new Firefox and WebKit revisions, and each can need something this shim does
# not yet hold: Firefox 157 (Playwright 1.64, firefox-1555) requires NSS_3.126,
# which the previously pinned 3.114 does not export (measured with ldd); and a
# new WebKit revision's minibrowser-wpe/sys/lib starts WITHOUT the codec libs.
# The run below refreshes the NSS deb when the pin moves, rebuilds the shim
# from scratch, copies the codecs into EVERY installed WebKit revision, and
# ends by asking ldd whether each Firefox's libxul.so now resolves its NSS.
set -euo pipefail

SHIM="/tmp/pw-libs"
LIBDIR="$SHIM/usr/lib/x86_64-linux-gnu"
# Where Playwright keeps its browsers, resolved EXACTLY as Playwright 1.64 does
# (playwright-core's registryDirectory), and BEFORE the `cd` below:
#   - the value is read like Playwright's getFromENV: PLAYWRIGHT_BROWSERS_PATH,
#     else npm_config_playwright_browsers_path, else
#     npm_package_config_playwright_browsers_path — the first one that is SET,
#     even to "" (which then means "not given", as in Playwright);
#   - `0` is Playwright's own "inside node_modules"; empty means the default,
#     ${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright;
#   - a RELATIVE result is resolved against INIT_CWD (the directory `npm run`
#     was started from) or else the current directory — never /tmp/pw-libs/debs.
# (v8.13.4 reviews: the first version ignored the npm_config_ spelling,
# XDG_CACHE_HOME and INIT_CWD, so it could check a different tree from the one
# Playwright launches, and report "WebKit not installed yet" over a real one.)
REPO_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
_pw_env() {
  local name="$1" lower alt
  lower="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
  for alt in "$name" "npm_config_$lower" "npm_package_config_$lower"; do
    if [ -n "${!alt+set}" ]; then printf '%s' "${!alt}"; return; fi
  done
}
PW_BROWSERS_PATH="$(_pw_env PLAYWRIGHT_BROWSERS_PATH)"
if [ "$PW_BROWSERS_PATH" = 0 ]; then
  BROWSERS="$REPO_DIR/node_modules/playwright-core/.local-browsers"
elif [ -n "$PW_BROWSERS_PATH" ]; then
  BROWSERS="$PW_BROWSERS_PATH"
else
  BROWSERS="${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright"
fi
case "$BROWSERS" in
  /*) ;;
  *)  PW_BASE="$(_pw_env INIT_CWD)"; BROWSERS="${PW_BASE:-$PWD}/$BROWSERS" ;;
esac
mkdir -p "$SHIM/debs"
cd "$SHIM/debs"

echo "==> Downloading codec + NSS libs (no install, no root)…"
# WebKit image-codec deps (+ their transitive deps).
for pkg in libavif16 libaom3 libdav1d7 libyuv0 libsharpyuv0 libgav1-1; do
  apt-get download "$pkg" 2>/dev/null && echo "  got $pkg" || echo "  WARN: $pkg unavailable from configured repos"
done
# Firefox needs newer NSS than this OS ships (Firefox 157 wants NSS_3.126+;
# noble has 3.98). Pull a self-contained newer build straight from the Ubuntu
# archive by URL. 3.127-1 exports NSS_3.126 and depends only on libc6 >= 2.34,
# libnspr4 >= 2:4.34 and libsqlite3-0, which a noble-based host already has.
#
# The guard is keyed on the PINNED file, not on "some libnss3 deb is here":
# the old `ls libnss3_*.deb` test skipped the download whenever ANY earlier
# pin was cached, so moving the pin changed nothing on a machine that had run
# this before. The new deb is fetched to a TEMPORARY name and moved into place
# only once it has arrived, and only THEN is a superseded deb deleted — the
# extraction below would otherwise unpack both, and whichever came last
# alphabetically would win. An unreachable archive leaves everything as it was.
NSS_DEB="libnss3_3.127-1_amd64.deb"
NSS_URL="http://archive.ubuntu.com/ubuntu/pool/main/n/nss/$NSS_DEB"
if [ ! -s "$NSS_DEB" ]; then
  # Bounded: wget's default read timeout is 15 minutes, and the archive has
  # been seen to stall a connection here — a setup that hangs reads as broken.
  if wget -q --timeout=60 --tries=3 "$NSS_URL" -O "$NSS_DEB.part" && [ -s "$NSS_DEB.part" ]; then
    mv -f "$NSS_DEB.part" "$NSS_DEB"
    echo "  got $NSS_DEB (newer NSS for Firefox)"
    for old in libnss3_*.deb; do
      [ -e "$old" ] && [ "$old" != "$NSS_DEB" ] && { rm -f "$old"; echo "  removed superseded $old"; }
    done
  else
    rm -f "$NSS_DEB.part"
    echo "  WARN: could not fetch $NSS_URL — kept what was cached; Firefox needs this release to launch"
  fi
fi

# Rebuilt from scratch every run, so a library that only an earlier pin shipped
# cannot survive into the shim and be picked up ahead of the current one — but
# only when there is something to rebuild FROM: with no deb at all (offline, no
# apt repos) the existing shim is kept rather than wiped.
#
# And the rebuild is STAGED: everything is extracted into $SHIM/.staging and the
# finished tree is swapped in only once every deb has unpacked and every library
# has been copied. A corrupt or truncated deb therefore leaves the working shim
# exactly as it was (v8.13.4 review: the old order deleted $SHIM/usr first, so a
# failed `dpkg-deb -x` under `set -e` left an EMPTY shim and every cross-browser
# run after it failing to launch Firefox, far from the cause).
rebuild_failed=0
debs=()
for deb in *.deb; do [ -e "$deb" ] && debs+=("$deb"); done
if [ "${#debs[@]}" -eq 0 ]; then
  echo "  WARN: no .deb could be downloaded — the existing shim in $SHIM is left as it was"
else
  echo "==> Extracting .so files into $LIBDIR …"
  STAGE="$SHIM/.staging"
  STAGE_LIBDIR="$STAGE/usr/lib/x86_64-linux-gnu"
  rm -rf "$STAGE"
  mkdir -p "$STAGE/extracted" "$STAGE_LIBDIR"
  for deb in "${debs[@]}"; do
    if ! dpkg-deb -x "$deb" "$STAGE/extracted"; then
      echo "  WARN: could not unpack $deb"
      rebuild_failed=1
      break
    fi
  done
  # `-exec … +` (not `\;`) so a failed copy is reflected in find's own status.
  if [ "$rebuild_failed" = 0 ] && ! find "$STAGE/extracted" -name "*.so*" -exec cp -af -t "$STAGE_LIBDIR/" {} +; then
    echo "  WARN: could not copy the extracted libraries"
    rebuild_failed=1
  fi
  if [ "$rebuild_failed" = 0 ]; then
    rm -rf "$SHIM/extracted" "$SHIM/usr.old"
    if [ -d "$SHIM/usr" ]; then mv "$SHIM/usr" "$SHIM/usr.old"; fi
    mv "$STAGE/usr" "$SHIM/usr"
    rm -rf "$SHIM/usr.old" "$STAGE"
  else
    rm -rf "$STAGE"
    echo "  WARN: the shim was NOT rebuilt — the existing one in $SHIM is left as it was"
  fi
fi

# WebKit's headless build (minibrowser-wpe) launches via a wrapper that searches
# its own sys/lib but NOT our shim — so the codec libs must also be copied there.
# EVERY installed revision, not the first `ls` returns: that was the OLDEST one
# whenever an update left two side by side, so the new revision kept failing
# with "libavif.so.16 not found". `-n` never overwrites a library WebKit ships.
found_webkit=0
for WPE_SYSLIB in "$BROWSERS"/webkit-*/minibrowser-wpe/sys/lib; do
  [ -d "$WPE_SYSLIB" ] || continue
  found_webkit=1
  echo "==> Copying codec libs into WebKit WPE sys/lib ($WPE_SYSLIB)…"
  cp -an "$LIBDIR"/lib{avif,aom,gav1,yuv,dav1d,sharpyuv}.so* "$WPE_SYSLIB/" 2>/dev/null || true
done
if [ "$found_webkit" = 0 ]; then
  echo "  NOTE: no WebKit found under $BROWSERS — run 'npx playwright install firefox webkit' first, then re-run this script."
fi

# Self-check: name a missing NSS symbol version here, at setup time, rather
# than as a Firefox that silently fails to launch half way through the matrix.
# (ldd's output is captured first: under pipefail, `ldd | grep -q` can read as
# "no match" when grep's early exit SIGPIPEs ldd.)
found_firefox=0
for XUL in "$BROWSERS"/firefox-*/firefox/libxul.so; do
  [ -f "$XUL" ] || continue
  found_firefox=1
  missing=$(LD_LIBRARY_PATH="$LIBDIR" ldd "$XUL" 2>&1 | grep "version .* not found" || true)
  if [ -n "$missing" ]; then
    echo "  WARN: $XUL still has unresolved symbol versions against the shim:"
    printf '%s\n' "$missing" | sed 's/^/    /'
    echo "    Bump NSS_DEB in this script to a release that exports them."
  else
    echo "==> $(basename "$(dirname "$(dirname "$XUL")")"): NSS resolves against the shim."
  fi
done
if [ "$found_firefox" = 0 ]; then
  echo "  NOTE: no Firefox found under $BROWSERS — the NSS check did not run."
fi

if [ "$rebuild_failed" = 1 ]; then
  echo "==> FAILED: a downloaded .deb could not be unpacked (see the WARN above). Delete it from $SHIM/debs and re-run."
  exit 1
fi
echo "==> Done. Run the cross-browser matrix with:  npm run test:cross"
