"use strict";

// ONE "Add Tag" save path for the three tag dialogs (challenge, event,
// participant). Each dialog builds its own body (the challenge one carries the
// reserved-tag chip), then hands its controls here: the typed tag or a clicked
// chip is POSTed to `url`, a success hands the server's tag list to `onSaved`
// and closes, and a REFUSAL keeps the dialog open with the server's reason
// toasted and focus back in the input — the reason often names a chip that is
// in this very dialog (the public-domain near miss), so closing would send the
// operator away from the one control they were told to use.

import { csrfHeaders } from "../core/api.js";
import { showToast } from "./toast.js";

export function wireTagDialog({ overlay, inputId, saveBtnId, url, onSaved, close }) {
  async function saveTag(tag) {
    if (!tag) return;
    let r = null;
    try { r = await fetch(url, { method: 'POST', headers: csrfHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ tag }) }); } catch (_) { r = null; }
    if (!r || !r.ok) {
      const d = r ? await r.json().catch(() => ({})) : {};
      showToast(d.error || 'Failed to add tag.', 'error');
      document.getElementById(inputId)?.focus();
      return;
    }
    const d = await r.json().catch(() => ({}));
    onSaved(d.tags);
    close();
  }
  document.getElementById(saveBtnId).onclick = () => saveTag(document.getElementById(inputId).value.trim());
  overlay.querySelectorAll('[data-tag]').forEach(el => {
    el.onclick = () => saveTag(el.dataset.tag);
    el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); saveTag(el.dataset.tag); } };
  });
  document.getElementById(inputId).focus();
}
