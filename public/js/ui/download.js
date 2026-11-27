/**
 * ui/download.js — ONE way to hand the browser a generated file.
 *
 * v8.8.15. Four call sites had grown FOUR implementations with THREE different
 * ideas about when to release the object URL:
 *
 *   * `ui/csv.js`             — `setTimeout(..., 0)`
 *   * `features/export-import.js` (activity CSV) — `pagehide`, `{once:true}`
 *   * `features/self-enroll.js`   (QR PNG)       — `pagehide`, `{once:true}`
 *   * `features/export-import.js` `downloadJson` — revoked SYNCHRONOUSLY
 *
 * v8.3.17 (F10) filed the inconsistency, and this codebase pushed back on the
 * remedy rather than the observation, for three reasons that still stand: the
 * finding's load-bearing "measured Safari/iOS failure" is unsupported (its only
 * artefacts are a v7.12.3 audit line and the comment that line planted, and
 * README records no real-Safari coverage at all); the finding was internally
 * inconsistent, since under its own stated mechanism `setTimeout(0)` is equally
 * broken while its headline named one button; and `pagehide` on a multi-megabyte
 * JSON export, in an SPA that never navigates, retains those bytes for the life
 * of the tab.
 *
 * SO THIS IS NOT THAT REMEDY. The strategy here is chosen for BOUNDED RETENTION
 * WITH HEADROOM, and it strictly dominates all three: revoke on a generous
 * timer, OR on `pagehide`, whichever comes first, each `{once:true}` and each
 * cancelling the other.
 *
 *   * versus the synchronous revoke — the click is dispatched synchronously but
 *     the browser reads the blob afterwards, so releasing it in the same tick is
 *     a documented way to produce an empty file;
 *   * versus `setTimeout(0)` — one tick is the same race with a longer fuse;
 *   * versus `pagehide` alone — that never fires in an SPA that does not
 *     navigate, so a session of exports retains every blob until the tab closes.
 *
 * The window is 60 SECONDS, and it is a duration rather than an event because
 * what has to be outlasted is a HUMAN reading a download prompt, not a page
 * lifecycle transition. A minute is far past any plausible confirmation and far
 * short of "for the life of the tab".
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not build the Blob. Each caller
 * knows its own MIME type and its own BOM rule (`ui/csv.js` prepends the UTF-8
 * BOM because Excel on Windows ignores the HTTP charset on a double-clicked
 * .csv), and folding that in here would make one helper responsible for a
 * decision that is genuinely per-format.
 */

/** How long a blob URL stays resolvable after the click. See the note above. */
export const DOWNLOAD_URL_TTL_MS = 60_000;

/**
 * Hand `blob` to the browser as a download named `filename`.
 *
 * The anchor is appended to the document before clicking and removed after:
 * a detached `<a download>` click is honoured by Chromium and is NOT reliably
 * honoured elsewhere, and two of the four sites this replaces already did it.
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    // Both listeners are `{once:true}`, so whichever fires second is already
    // gone; the timer is the only one that needs cancelling explicitly.
    clearTimeout(timer);
    window.removeEventListener('pagehide', release);
    try { URL.revokeObjectURL(url); } catch (e) { console.warn('Could not revoke a download URL', e); }
  };
  const timer = setTimeout(release, DOWNLOAD_URL_TTL_MS);
  window.addEventListener('pagehide', release, { once: true });
  return url;
}

/**
 * The part of a generated file's name that names a person, in any script
 * (operator ruling, 14 Nov 2026): lower-cased; letters, marks and digits of
 * every script stay (张伟, josé-garcía); every other run becomes one hyphen, and
 * none is left at either end; cut at `max` characters, never inside one;
 * `fallback` when nothing is left. For an ASCII name it is the plain ASCII
 * slug (runs of a-z and 0-9 joined by hyphens). The one rule a certificate file
 * names its holder by: the issued PDF and PNG (features/certificate-wizard.js)
 * and the Rankings top three's preview PNG (features/rankings-admin.js).
 */
export function fileNameSlug(text, { max = 40, fallback = 'file' } = {}) {
  const s = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return [...s].slice(0, max).join('') || fallback;
}
