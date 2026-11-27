"use strict";
// THE PLATFORM LOOK CARD (Settings, superadmin) and THE EVENT LOOK CARD (an
// event workspace's Settings section). Both save through their own route
// (PUT /api/admin/platform-look, PUT /api/admin/competitions/:id/look); the
// rules live in lib/platform-look.js and the precedence in ui/theme.js.
//
// Platform look: the look, mode and light colour every browser starts from,
// signed-out pages included (it rides the SPA shell). "Apply to everyone now"
// also stamps the time, so browsers whose own choice is older adopt it on their
// next load; "Lock look for participants" keeps participants and signed-out
// visitors on it (staff keep their own).
//
// Event look: painted on the event's join landing and for its participants
// while inside it; "Lock" also overrides their own choice there.

import { S } from "../core/state.js";
import { csrfHeaders } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { esc, fmtDt } from "../ui/format.js";
import { showModal } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";
import { LOOKS, AMBIENTS, applyPlatformLook } from "../ui/theme.js";
import { settingsCardOffered } from "../ui/nav.js"; // each Settings card follows its routes' permissions (read inside functions only)

const MODE_OPTS = [["", "Leave to each browser (follows the device by default)"],["system", "Auto (follow the device)"], ["light", "Light"], ["dark", "Dark"]];

function _opts(list, cur) {
  return list.map(([v, t]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(t)}</option>`).join("");
}
function _lookOpts(cur, none) {
  return _opts([["", none], ...LOOKS.map((l) => [l.id, l.label])], cur || "");
}

// ── Platform look (Settings) ─────────────────────────────────────────────────
/** Fill #platform-look-card from the GET /api/admin/settings answer. */
export function renderPlatformLookCard(p) {
  const card = document.getElementById("platform-look-card");
  if (!card) return;
  const offered = settingsCardOffered("platform-look-card");
  card.style.display = offered ? "" : "none";
  if (!offered) return;
  const v = p && typeof p === "object" ? p : {};
  const stamp = Number(v.stamp) > 0 ? `Last applied to everyone ${esc(fmtDt(new Date(Number(v.stamp)), "long"))}.` : "Not yet applied to everyone: browsers that picked their own look keep it.";
  setSafeHtml(card, `<h3 class="settings-heading">Platform look</h3>
    <p class="settings-help">The look every browser starts from, the sign-in page included. People can still pick their own in Appearance, unless you lock it for participants. <strong>Apply to everyone now</strong> also replaces choices made before it, on each browser's next load.</p>
    <div class="pl-grid">
      <div class="form-group"><label for="pl-look">Look</label><select id="pl-look">${_lookOpts(v.look, "Default (Ambient, following the device)")}</select></div>
      <div class="form-group"><label for="pl-mode">Mode</label><select id="pl-mode">${_opts(MODE_OPTS, v.mode || "")}</select></div>
      <div class="form-group"><label for="pl-ambient">Light colour <span class="settings-help-inline">(Ambient)</span></label><select id="pl-ambient">${_opts([["", "The look's own"], ...AMBIENTS.map((a) => [a.id, a.label])], v.ambient || "")}</select></div>
    </div>
    <div class="form-group"><label class="checkbox-row"><input type="checkbox" id="pl-lock"${v.lock ? " checked" : ""}/> <span>Lock look for participants</span></label>
      <p class="settings-help">Participants and signed-out visitors always get this look; admins and organisers keep their own.</p></div>
    <p class="settings-help" id="pl-stamp" role="status">${stamp}</p>
    <div class="settings-actions">
      <button type="button" class="btn secondary" data-action="platform-look-save">Save</button>
      <button type="button" class="btn" data-action="platform-look-apply">Apply to everyone now</button>
    </div>`);
}

function _platformBody(applyNow) {
  const val = (id) => document.getElementById(id)?.value || "";
  return { look: val("pl-look"), mode: val("pl-mode"), ambient: val("pl-ambient"), lock: !!document.getElementById("pl-lock")?.checked, apply_now: applyNow };
}

export async function savePlatformLook(applyNow) {
  if (!document.getElementById("pl-look")) return;
  const body = _platformBody(!!applyNow);
  if (applyNow) {
    const ok = await showModal({
      title: "Apply to everyone now?",
      message: "Every browser that picked its own look, mode or light colour before now gets the platform look on its next load. People can choose again afterwards unless the look is locked.",
      confirmText: "Apply to everyone", confirmClass: "",
    });
    if (!ok) return;
  }
  let r = null, d = {};
  try {
    r = await fetch("/api/admin/platform-look", { method: "PUT", headers: csrfHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body) });
    d = await r.json().catch(() => ({}));
  } catch (_) { r = null; }
  if (!r || !r.ok || !d.ok) { showToast((d && d.error) || "Could not save the platform look.", "error"); return; }
  applyPlatformLook(d.platform_look);
  renderPlatformLookCard(d.platform_look);
  showToast(applyNow ? "Platform look applied to everyone." : "Platform look saved.", "success");
}

// ── Event look (an event workspace's Settings) ──────────────────────────────
//
// The form keeps a choice not yet saved through every repaint of the workspace
// (a poll never overwrites a user's choice): each control carries `data-saved`,
// the stored value the form stands for. A control that differs from it holds
// the person's choice; the workspace's repaint (event-workspace.js
// `_paintLookCard`) leaves that alone and otherwise follows the store.
//
// Saves are counted per event. While one is on its way the form is left as the
// person has it, whatever a read of the model says meanwhile: the answers
// decide. An answer is applied unless a newer save's answer already was (the
// server may have stored either; the next poll settles), so a newer save that
// fails never hides an older one the server stored.
const _lookSaves = new Map();   // event id -> { latest, applied, inFlight }

/** What the form shows for an event's stored look: a look this browser does
 *  not list (left by a rollback) shows as the platform look with no lock, as
 *  Save would then store it. */
export function eventLookShown(c) {
  const look = LOOKS.some((l) => l.id === c.event_look) ? c.event_look : "";
  return { look, locked: !!(look && c.event_look_locked) };
}

/** The card body for one event; read-only when the viewer cannot change it. */
export function eventLookCardHtml(c, canEdit) {
  const cur = c.event_look || "";
  if (!canEdit) {
    const label = cur ? (LOOKS.find((l) => l.id === cur)?.label || cur) : "The platform look";
    return `<dl class="ws-kvs"><div class="ws-kv"><dt>Look</dt><dd>${esc(label)}</dd></div><div class="ws-kv"><dt>Locked for participants</dt><dd>${c.event_look && c.event_look_locked ? "On" : "Off"}</dd></div></dl>`;
  }
  const shown = eventLookShown(c);
  return `<p class="ws-note-plain">Shown on this event's join page and to its participants while they are in it.</p>
    <div class="form-group"><label for="ev-look">Look</label><select id="ev-look" data-comp-id="${esc(c.id)}" data-saved="${esc(shown.look)}">${_lookOpts(shown.look, "The platform look")}</select></div>
    <div class="form-group"><label class="checkbox-row"><input type="checkbox" id="ev-look-lock" data-saved="${shown.locked ? "1" : ""}"${shown.locked ? " checked" : ""}/> <span>Lock it, so participants cannot pick their own here</span></label></div>
    <div class="settings-actions"><button type="button" class="btn secondary" data-action="event-look-save" data-comp-id="${esc(c.id)}">Save look</button></div>`;
}

/** The event look form inside `root` as the person has it now: the values on
 *  screen, whether they are a choice not yet saved (they differ from what the
 *  form stands for, its `data-saved`), and whether a save of the event's look
 *  is on its way. null without a form. */
export function eventLookFormState(root) {
  const sel = root && root.querySelector("#ev-look");
  if (!sel) return null;
  const lk = root.querySelector("#ev-look-lock");
  const look = sel.value || "";
  const locked = !!(lk && lk.checked);
  const saving = (_lookSaves.get(sel.dataset.compId)?.inFlight || 0) > 0;
  return { look, locked, saving, unsaved: look !== (sel.dataset.saved || "") || locked !== (!!lk && lk.dataset.saved === "1") };
}

/** Make the form inside `root` stand for `stored` (from `eventLookShown`): its
 *  `data-saved` moves there and, with `show`, the values on screen too, in the
 *  same controls (an open list stays open, focus stays). Writes only what
 *  differs: the workspace asks every second. */
export function setEventLookForm(root, stored, show) {
  const sel = root && root.querySelector("#ev-look");
  if (!sel) return;
  const lk = root.querySelector("#ev-look-lock");
  const lockSaved = stored.locked ? "1" : "";
  if (show && (sel.value || "") !== stored.look) sel.value = stored.look;
  if (show && lk && lk.checked !== stored.locked) lk.checked = stored.locked;
  if ((sel.dataset.saved || "") !== stored.look) sel.dataset.saved = stored.look;
  if (lk && (lk.dataset.saved || "") !== lockSaved) lk.dataset.saved = lockSaved;
}

export async function saveEventLook(compId) {
  const sel = document.getElementById("ev-look");
  if (!sel || !compId) return;
  const look = sel.value || "";
  const checked = !!document.getElementById("ev-look-lock")?.checked;
  const locked = !!look && checked;
  const saves = _lookSaves.get(compId) || { latest: 0, applied: 0, inFlight: 0 };
  _lookSaves.set(compId, saves);
  const mine = ++saves.latest;
  saves.inFlight++;
  let r = null, d = {};
  try {
    r = await fetch(`/api/admin/competitions/${encodeURIComponent(compId)}/look`, { method: "PUT", headers: csrfHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ look, locked }) });
    d = await r.json().catch(() => ({}));
  } catch (_) { r = null; }
  finally { saves.inFlight--; }
  if (!r || !r.ok || !d.ok) { showToast((d && d.error) || "Could not save the event look.", "error"); return; }
  if (mine > saves.applied) {
    saves.applied = mine;
    // The open workspace reads its event from the admin model: keep it current.
    // A read of the model already on its way left before this save landed, and
    // its answer would put the old look back: claim the model's sequence, so
    // `loadAdminCompetitions` drops that answer (the next poll reads afresh).
    const row = (S.adminCompetitionsData || []).find((x) => x && x.id === compId);
    if (row) { row.event_look = d.event_look; row.event_look_locked = d.event_look_locked ? 1 : 0; }
    S._compFetchSeq++;
    _settleEventLookForm(compId, sel, eventLookShown({ event_look: d.event_look, event_look_locked: d.event_look_locked }), { look, checked });
  }
  showToast(d.event_look ? "Event look saved." : "Event look removed: the platform look applies.", "success");
}

// After a save the form on screen for that event stands for what is stored.
// Unless the person changed it while the save was on its way (that change stays
// on screen, a choice not yet saved), it shows the stored values too: a lock
// asked for with no look is not stored, so its box clears. "Changed" is
// measured against what was sent, or, for a form drawn afresh meanwhile (the
// person went to another event and came back), against what it was drawn with.
// Another event's form is never touched.
function _settleEventLookForm(compId, sentFrom, stored, sent) {
  const sel = document.getElementById("ev-look");
  if (!sel || sel.dataset.compId !== compId) return;
  const lk = document.getElementById("ev-look-lock");
  const was = sel === sentFrom ? sent : { look: sel.dataset.saved || "", checked: !!lk && lk.dataset.saved === "1" };
  setEventLookForm(document, stored, (sel.value || "") === was.look && (!lk || lk.checked === was.checked));
}
