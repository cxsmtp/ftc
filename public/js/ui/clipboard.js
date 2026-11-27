"use strict";

// v7.22.0 — copy-to-clipboard, with the fallback that makes it work where this
// platform is actually deployed.
//
// `navigator.clipboard` is gated on a SECURE CONTEXT. That is https:// or
// localhost — and this server is routinely run behind plain http:// on a venue
// LAN (the reverse-proxy sanity check at boot exists precisely because an
// operator can set BASE_URL to http://). On such a deployment
// `navigator.clipboard` is `undefined`, so a copy button wired straight to it
// throws on every click and the admin gets nothing, silently. The deprecated
// `execCommand("copy")` still works there, so it is the fallback rather than the
// other way round.
//
// The textarea is positioned off-screen rather than `display:none` — a hidden
// element cannot be selected, so the copy would be a no-op. `readonly` keeps the
// mobile keyboard down; `aria-hidden` keeps it out of the accessibility tree.

function _execCommandCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
  document.body.appendChild(ta);
  // Preserve whatever the user had selected — copying should not steal it.
  const prev = document.activeElement;
  try {
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    return document.execCommand("copy");
  } catch (_) {
    return false;
  } finally {
    ta.remove();
    if (prev && typeof prev.focus === "function") prev.focus();
  }
}

/**
 * Copy `text`. Resolves true on success, false on failure — it never throws, so
 * a caller can report the outcome instead of the click dying in the dispatcher's
 * catch with nothing on screen.
 */
export async function copyText(text) {
  const v = String(text ?? "");
  if (!v) return false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(v);
      return true;
    } catch (_) {
      // Permission denied / not focused — fall through and try the old path.
    }
  }
  return _execCommandCopy(v);
}
