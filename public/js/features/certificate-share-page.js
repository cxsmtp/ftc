"use strict";

// The LinkedIn share page (GET /badge/:link/post) — a standalone page outside the
// SPA, loaded as its own module entry. It copies the holder's post through
// `ui/clipboard.js` `copyText` (which falls back to execCommand on a plain-http
// venue LAN) and opens LinkedIn's feed composer. "Copy post & open LinkedIn"
// also POSTs the one-time link, which uses it up and publishes the certificate
// page (the holder's publish-on-share). "Copy post" only copies.
//
// The copy STARTS first, while the page still has focus, and the composer opens
// in the same task as the click, before anything is awaited: a pop-up blocker
// allows a window only during the click's own task, and the clipboard answers
// in a later one. If a blocker refuses the window anyway, the page offers a
// plain link instead.
//
// The POST carries a token fetched just before it, never the one the page was
// served with: if this browser signed in (in another tab) since the page loaded,
// the served token belongs to a session that no longer exists, and a refused
// token ends the session it is sent with (server.js, EBADCSRFTOKEN).

import { copyText } from "../ui/clipboard.js";

const COMPOSER = "https://www.linkedin.com/feed/?shareActive=true&text=";

/** This browser's session token now, or null when it cannot be had. */
async function freshToken() {
  try {
    const r = await fetch("/api/csrf-token", { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    return d && typeof d.csrfToken === "string" && d.csrfToken ? d.csrfToken : null;
  } catch (_) { return null; }
}

function init() {
  const card = document.getElementById("share-post");
  if (!card) return;
  // The module is running: the "reload this page" notice for a page whose
  // script never arrived is not needed.
  document.getElementById("share-post-fallback")?.remove();
  const ta = document.getElementById("share-post-text");
  const go = document.getElementById("share-post-go");
  const copyBtn = document.getElementById("share-post-copy");
  const status = document.getElementById("share-post-status");
  const say = (msg) => { if (status) status.textContent = msg; };

  copyBtn?.addEventListener("click", async () => {
    const ok = await copyText(ta.value);
    say(ok ? "Post copied. Paste it into LinkedIn." : "Could not copy automatically — select the text above and copy it.");
  });

  go?.addEventListener("click", async () => {
    const text = ta.value;
    const copying = copyText(text);
    const url = COMPOSER + encodeURIComponent(text);
    const w = window.open(url, "_blank");
    if (w) { try { w.opener = null; } catch (_) { /* cross-origin already */ } }
    go.disabled = true;
    const ok = await copying;
    let d = null;
    const token = await freshToken();
    if (token) {
      try {
        const r = await fetch(`/badge/${encodeURIComponent(card.dataset.link)}/post`, {
          method: "POST",
          headers: { "x-csrf-token": token, "Content-Type": "application/json" },
          body: "{}",
          credentials: "same-origin",
        });
        d = await r.json().catch(() => null);
      } catch (_) { d = null; }
    }
    const copied = ok ? "Post copied — paste it into LinkedIn." : "Could not copy automatically — select the text above and copy it.";
    if (!d) {
      // Nothing came back (no token, or the request was lost): the link may not
      // be used yet and the certificate page is not published. Say so, and let
      // the press be repeated.
      go.disabled = false;
      say(`${copied} Your certificate page was not published — check your connection and press the button again.`);
      return;
    }
    if (!w) {
      const a = document.createElement("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener"; a.className = "btn";
      a.textContent = "Open LinkedIn";
      go.replaceWith(a);
    }
    if (d.ok) say(`${copied} Your certificate page is now published.`);
    else if (d.error) say(`${copied} ${d.error}`);
    else say(copied);
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
