"use strict";

// ── THE CERTIFICATE WIZARD ───────────────────────────────────────────────────
//
// One editor for the certificate design, used twice:
//   • the PLATFORM design — Settings (GET/PUT/DELETE /api/admin/certificate-config);
//   • an EVENT's override — the event workspace's Certificates tab
//     (GET/PUT/DELETE /api/admin/competitions/:id/certificate-config).
// Both are edited by administrators and superadmins only; an event admin sees
// the preview and the download, read-only, with the reason.
//
// The editor holds a WORKING LAYER (the stored layer plus unsaved edits) and
// shows a live preview rendered by the server from that layer
// (POST /api/admin/certificate-config/preview, a PNG; nothing is stored or
// minted). Previews are debounced: the route is rate limited (40 a minute).
// The server validates every save; the limits below only shape the inputs.
//
// The preview is painted from a data: URI — the CSP's img-src has no blob:.

import { S } from "../core/state.js";
import { csrfHeaders, fetchJsonObject } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { esc } from "../ui/format.js";
import { ICO } from "../ui/icons.js";
import { showModal } from "../ui/modal.js";
import { showToast, showPrompt } from "../ui/toast.js";
import { downloadBlob, fileNameSlug } from "../ui/download.js";
import { registerHelpTips } from "../ui/help-tips.js";
import { certificateDesignOffered, adminCan } from "../ui/nav.js"; // adminCan: RBAC, Re-send is a `certificates.send` route

// The designer's "?" tips (ui/help-tips.js), registered when it first renders.
export const CERT_HELP_TIPS = {
  "cert.scope": {
    default: "The platform design applies to every event; an event's own design overrides it field by field. Saved changes reach certificates already issued the next time they are downloaded.",
    event_admin: "Only an administrator can change a design. You can preview each certificate and download the preview.",
  },
  "cert.email": "Sent once per certificate when the event ends (a Program: when someone finishes). People who unsubscribed get no email but keep their certificate.",
  "cert.linkedin": "The post the holder copies from the email's one-time share page. LinkedIn cannot create real @tags from a link, so the page asks them to pick Checkmarx and the organisers from LinkedIn's suggestions.",
};

export const CERT_TIERS = [
  { id: 'gold', label: 'Gold', sub: '1st place' },
  { id: 'silver', label: 'Silver', sub: '2nd place' },
  { id: 'bronze', label: 'Bronze', sub: '3rd place' },
  { id: 'participation', label: 'Participation', sub: 'took part' },
  { id: 'completion', label: 'Completion', sub: 'finished, no grade' },
  // Program grades (27 Nov 2026): a graded Program certificate takes its band's
  // wording (labels.<band>) and the completion tier's colours and seal.
  { id: 'excellent', label: 'Excellent', sub: 'Program, 90% or more', colour: 'completion' },
  { id: 'very_good', label: 'Very good', sub: 'Program, 80% or more', colour: 'completion' },
  { id: 'good', label: 'Good', sub: 'Program, 70% or more', colour: 'completion' },
  { id: 'satisfactory', label: 'Satisfactory', sub: 'Program, 60% or more', colour: 'completion' },
];

// Wording fields, in the order they read on the certificate.
const TEXT_FIELDS = [
  ['wordmark', 'Wordmark', 40], ['hub_line', 'Line under the wordmark', 80], ['title', 'Title', 48],
  ['presented_to', '“Presented to” line', 40], ['lead_in', 'Line before the event name', 80],
  ['recognition', 'Recognition sentence', 220], ['footer_tagline', 'Footer tagline', 80],
  ['achievement_heading', 'Achievement heading', 40], ['score_heading', 'Score heading', 24],
  ['grade_heading', 'Grade heading (Programs)', 24],
  ['date_heading', 'Date heading', 24], ['id_heading', 'Certificate ID heading', 32],
];
const COLOUR_FIELDS = [
  ['background', 'Background'], ['glow', 'Glow'], ['text', 'Text'], ['muted', 'Secondary text'],
  ['accent', 'Accent'], ['frame', 'Frame'], ['gold', 'Gold'], ['silver', 'Silver'], ['bronze', 'Bronze'],
  ['participation', 'Participation seal'], ['completion', 'Completion seal'],
];
const SHOW_FIELDS = [
  ['logo', 'Logo'], ['score', 'Score'], ['date', 'Date'], ['qr', 'Verification QR'], ['code', 'Certificate ID'],
  ['pattern', 'Background pattern'], ['shield', 'Shield'], ['medal', 'Medal'],
];
const HEX = /^#[0-9a-fA-F]{6}$/;
// The certificate draws its QR only beside the certificate ID (lib/badge.js), so
// with the ID off the QR box would do nothing: it is disabled, with this reason
// beside it (operator ruling, 24 Nov 2026). Its stored value is kept for when
// the ID is turned on again.
const QR_NEEDS_CODE_NOTE = 'The QR code prints beside the certificate ID. Turn on Certificate ID to print it.';
// Operator ruling, 29 Oct 2026: only administrators and superadmins edit a
// certificate design; an event admin previews and downloads.
const EA_READONLY_NOTE = 'Only an administrator can change certificate designs. You can preview and download.';
// The email section: one thank-you paragraph per tier.
const EMAIL_MESSAGE_FIELDS = [
  ['message_gold', 'Thank-you — 1st place'], ['message_silver', 'Thank-you — 2nd place'],
  ['message_bronze', 'Thank-you — 3rd place'], ['message_participation', 'Thank-you — participation'],
  ['message_completion', 'Thank-you — completion'],
];
// Previews are debounced and cached per design hash: a design the organiser
// flips back to is drawn from here, not rendered again.
const PREVIEW_DEBOUNCE_MS = 900;
const PREVIEW_CACHE_MAX = 30;
const _previewCache = new Map();
// A light vector outline of a certificate, shown while a preview renders, so the
// pane never reads as a black "Rendering…" box. It holds no text, and its tints
// are literal rgba colours on the preview's fixed night background.
const _SK = (a) => `rgba(207,201,227,${a})`;
const _SKELETON_SVG = `<svg viewBox="0 0 1536 1024" width="100%" height="100%" preserveAspectRatio="xMidYMid meet"><rect x="28" y="28" width="1480" height="968" rx="18" fill="none" stroke="${_SK(0.28)}" stroke-width="6"/><rect x="58" y="58" width="1420" height="908" rx="12" fill="none" stroke="${_SK(0.14)}" stroke-width="2"/><rect x="568" y="150" width="400" height="34" rx="17" fill="${_SK(0.18)}"/><rect x="448" y="236" width="640" height="56" rx="28" fill="${_SK(0.14)}"/><rect x="528" y="420" width="480" height="70" rx="35" fill="${_SK(0.2)}"/><rect x="408" y="540" width="720" height="26" rx="13" fill="${_SK(0.12)}"/><circle cx="1290" cy="300" r="110" fill="none" stroke="${_SK(0.2)}" stroke-width="10"/><rect x="180" y="820" width="260" height="22" rx="11" fill="${_SK(0.12)}"/><rect x="1096" y="820" width="260" height="22" rx="11" fill="${_SK(0.12)}"/></svg>`;

function _clone(o) { return JSON.parse(JSON.stringify(o || {})); }

/**
 * Render the wizard into `box`.
 *   opts.compId    — an event's override (absent: the platform design)
 *   opts.compName  — the sample event name in the preview
 *   opts.certificate — the event's wire policy `certificate` (`completion`:
 *                    the preview opens on the completion certificate)
 *   opts.readOnly  — look, not change (a competitor; an ended event for
 *                    anyone but a superadmin), with `opts.readOnlyReason`
 */
export async function renderCertificateWizard(box, opts = {}) {
  if (!box) return;
  registerHelpTips(CERT_HELP_TIPS);
  // Event admins look, never change — whatever the caller passed.
  // The predicate the save routes enforce (`certificates.design`).
  if (!certificateDesignOffered()) opts = { ...opts, readOnly: true, readOnlyReason: EA_READONLY_NOTE };
  const seq = (box._cwSeq = (box._cwSeq || 0) + 1);
  setSafeHtml(box, '<p class="ws-empty">Loading the certificate design…</p>');
  const url = opts.compId ? `/api/admin/competitions/${encodeURIComponent(opts.compId)}/certificate-config` : '/api/admin/certificate-config';
  const d = await fetchJsonObject(url);
  if (seq !== box._cwSeq) return;
  if (!d) {
    setSafeHtml(box, `<div class="load-failure" role="alert">Could not load the certificate design. <button type="button" class="btn sm secondary" data-cw-retry>Try again</button></div>`);
    box.querySelector('[data-cw-retry]')?.addEventListener('click', () => renderCertificateWizard(box, opts));
    return;
  }
  const st = {
    box, opts, open: new Set(['labels']),
    effective: d.effective || {},
    base: opts.compId ? (d.inherited || {}) : (d.defaults || {}),
    layer: _clone(opts.compId ? d.override : d.global),
    overridden: opts.compId ? !!d.overridden : !!(d.global && Object.keys(d.global).length),
    tier: opts.certificate === 'completion' ? 'completion' : 'gold',
    // The stored layer's version: a save sends it back, and the server refuses
    // one made over somebody else's newer save (409 certificate_config_changed).
    version: typeof d.version === 'string' ? d.version : undefined,
    dirty: false, previewSeq: 0, timer: null,
  };
  box._cw = st;
  _render(st);
  _preview(st);
}

function _val(st, sec, key, sub) {
  const l = st.layer[sec];
  if (sec === 'labels') {
    const lv = l && l[key] && l[key][sub];
    if (lv !== undefined) return lv;
    const e = (st.effective.labels || {})[key] || {};
    return e[sub] !== undefined ? e[sub] : '';
  }
  if (l && l[key] !== undefined) return l[key];
  const e = st.effective[sec] || {};
  return e[key] !== undefined ? e[key] : '';
}

function _set(st, sec, key, v, sub) {
  st.layer[sec] = st.layer[sec] || {};
  if (sec === 'labels') {
    st.layer.labels[key] = st.layer.labels[key] || {};
    st.layer.labels[key][sub] = v;
  } else st.layer[sec][key] = v;
  st.dirty = true;
  _syncState(st);
  if (sec === 'email') return;   // the email does not change the picture
  clearTimeout(st.timer);
  st.timer = setTimeout(() => _preview(st), PREVIEW_DEBOUNCE_MS);
}

// One collapsible section: a real button (aria-expanded, aria-controls) over a
// region toggled with the `hidden` attribute — never <details>, whose closed
// content a grid rule on the child could force open over its neighbours.
function _panel(st, id, title, sub, inner) {
  const open = st.open.has(id);
  return `<section class="cw-sec${open ? ' open' : ''}" data-panel="${id}">
    <h3 class="cw-sec-h"><button type="button" class="cw-sec-btn" data-cw-panel="${id}" aria-expanded="${open}" aria-controls="cw-panel-${id}"><span class="cw-sec-title">${esc(title)}</span><span class="cw-sec-sub">${esc(sub)}</span><span class="cw-sec-chev" aria-hidden="true">${ICO.chevronDown || ''}</span></button></h3>
    <div class="cw-panel" id="cw-panel-${id}"${open ? '' : ' hidden'}>${inner}</div>
  </section>`;
}

function _render(st) {
  const ro = !!st.opts.readOnly;
  const dis = ro ? ' disabled' : '';
  const scope = st.opts.compId
    ? (st.overridden ? 'This event has its own certificate design.' : 'This event uses the platform design. Change anything below to give it its own.')
    : 'Every event uses this design unless an administrator changes it for that event.';
  const area = (k, label, rows, max) => `<div class="form-group cw-field"><label for="cw-e-${k}">${label}</label><textarea id="cw-e-${k}" rows="${rows}" maxlength="${max}" data-sec="email" data-key="${k}"${dis}>${esc(String(_val(st, 'email', k)))}</textarea></div>`;
  const tiers = CERT_TIERS.map(t => `<button type="button" class="cw-tier${t.id === st.tier ? ' active' : ''}" data-tier="${t.id}" aria-pressed="${t.id === st.tier}"><span class="cw-tier-dot cw-tier-${t.colour || t.id}" aria-hidden="true"></span><span>${esc(t.label)}</span><small>${esc(t.sub)}</small></button>`).join('');
  const text = TEXT_FIELDS.map(([k, label, max]) => {
    const v = String(_val(st, 'text', k));
    const long = max > 80;
    return `<div class="form-group cw-field"><label for="cw-t-${k}">${esc(label)}</label>${long
      ? `<textarea id="cw-t-${k}" data-sec="text" data-key="${k}" maxlength="${max}" rows="2"${dis}>${esc(v)}</textarea>`
      : `<input id="cw-t-${k}" type="text" data-sec="text" data-key="${k}" maxlength="${max}" value="${esc(v)}"${dis}/>`}</div>`;
  }).join('');
  const lab = `<div class="cw-labels" id="cw-labels">${_labelsHtml(st, dis)}</div>`;
  const cols = COLOUR_FIELDS.map(([k, label]) => {
    const set = String(_val(st, 'colors', k) || '');
    // An unset frame follows the certificate's medal metal: the swatch shows
    // that metal and says so, never a black it would not print.
    if (!set && k === 'frame') {
      const metal = _frameMetal(st);
      return `<label class="cw-colour" data-follows="medal"><input type="color" data-sec="colors" data-key="${k}" value="${esc(metal.toLowerCase())}" aria-label="${esc(label)} colour (follows the medal until you choose one)"${dis}/><span>${esc(label)}</span><code>Follows the medal</code></label>`;
    }
    const v = set || '#000000';
    return `<label class="cw-colour"><input type="color" data-sec="colors" data-key="${k}" value="${esc(HEX.test(v) ? v.toLowerCase() : '#000000')}" aria-label="${esc(label)} colour"${dis}/><span>${esc(label)}</span><code>${esc(v.toUpperCase())}</code></label>`;
  }).join('');
  const qrHeld = _val(st, 'show', 'code') === false;
  const show = SHOW_FIELDS.map(([k, label]) => {
    const held = k === 'qr' && qrHeld;
    return `<label class="checkbox-row cw-toggle"><input type="checkbox" data-sec="show" data-key="${k}"${_val(st, 'show', k) !== false ? ' checked' : ''}${dis || (held ? ' disabled' : '')}${held ? ' aria-describedby="cw-qr-note"' : ''}/><span>${esc(label)}</span></label>`;
  }).join('') + `<p class="settings-hint cw-qr-note" id="cw-qr-note"${qrHeld ? '' : ' hidden'}>${esc(QR_NEEDS_CODE_NOTE)}</p>`;
  setSafeHtml(st.box, `<div class="cw">
    <div class="cw-head">
      <div><p class="eyebrow gold">Certificate design</p><p class="cw-scope"><span id="cw-scope">${esc(scope)}</span> <span data-help="cert.scope" data-help-label="Certificate design"></span></p></div>
      <div class="cw-tiers" role="group" aria-label="Preview the certificate for">${tiers}</div>
    </div>
    <div class="cw-body">
      <div class="cw-preview-wrap">
        <figure class="cw-preview" aria-live="polite"><div class="cw-skeleton" id="cw-skel" aria-hidden="true">${_SKELETON_SVG}</div><img id="cw-img" alt="Certificate preview" hidden/><figcaption id="cw-cap" class="cw-cap">Rendering a preview…</figcaption></figure>
        <div class="cw-actions">${_actionsHtml(st)}</div>
      </div>
      <div class="cw-edit">
        ${_panel(st, 'labels', 'Medal wording', 'Headline and small line per certificate', lab)}
        ${_panel(st, 'text', 'Wording', 'Title, lines around the name, headings', `<div class="cw-text">${text}</div>`)}
        ${_panel(st, 'colors', 'Colours', 'Background, text, accents and metals', `<div class="cw-colours">${cols}</div>`)}
        ${_panel(st, 'show', 'What is shown', 'Logo, score, date, QR, ID and artwork', `<div class="cw-shows">${show}</div>`)}
        ${_panel(st, 'email', 'Congratulations email', 'Thank-you per certificate and the LinkedIn post', `<div class="cw-email">
          <p class="settings-hint">When the event ends, each holder is emailed their certificate as a PDF, with a download link, the verification code and a <strong>Copy my LinkedIn post</strong> button. <code>{event}</code> is the event's name and <code>{platform}</code> the platform's. <span data-help="cert.email" data-help-label="Congratulations email"></span></p>
          <label class="checkbox-row cw-toggle"><input type="checkbox" data-sec="email" data-key="enabled"${_val(st, 'email', 'enabled') !== false ? ' checked' : ''}${dis}/><span>Email certificates to their holders</span></label>
          <div class="form-group cw-field"><label for="cw-e-subject">Subject</label><input id="cw-e-subject" type="text" maxlength="120" data-sec="email" data-key="subject" value="${esc(String(_val(st, 'email', 'subject')))}"${dis}/></div>
          ${EMAIL_MESSAGE_FIELDS.map(([k, label]) => area(k, esc(label), 3, 600)).join('')}
          ${area('intro', 'Extra paragraph <span class="muted">(optional)</span>', 2, 500)}
          <div class="help-label-row cw-sub-row"><h4 class="cw-sub">LinkedIn post</h4><span data-help="cert.linkedin" data-help-label="LinkedIn post"></span></div>
          <p class="settings-hint">Line one of the post: <code>{achievement}</code> is the certificate (for example 1st Place with its medal) and <code>{organisers}</code> the event's organisers, left out when there are none. Line two is the hashtags, then the verification link.</p>
          ${area('linkedin_post', 'Post', 2, 300)}
          <div class="form-group cw-field"><label for="cw-e-linkedin_hashtags">Hashtags</label><input id="cw-e-linkedin_hashtags" type="text" maxlength="200" data-sec="email" data-key="linkedin_hashtags" value="${esc(String(_val(st, 'email', 'linkedin_hashtags')))}"${dis}/></div>
        </div>`)}
      </div>
    </div>
  </div>`);
  _wire(st);
  _syncState(st);
}

// The design's own buttons. Redrawn after a save, which can give the event its
// own design and so the way back ("Use the platform design").
function _actionsHtml(st) {
  const ro = !!st.opts.readOnly;
  return `${ro ? `<p class="ws-note cw-ro-note">${ICO.lock} ${esc(st.opts.readOnlyReason || 'You are competing in this event — you can look at its certificate, not change it.')}</p>` : `
          <button type="button" class="btn gold" data-cw="save">${ICO.save} Save design</button>
          ${st.overridden ? `<button type="button" class="btn secondary" data-cw="reset">${st.opts.compId ? 'Use the platform design' : 'Reset to defaults'}</button>` : ''}`}
          <button type="button" class="btn secondary" data-cw="download">${ICO.download} Download preview</button>
          <span class="cw-state" id="cw-state" role="status"></span>`;
}

function _wireActions(st) {
  const box = st.box;
  box.querySelector('[data-cw="save"]')?.addEventListener('click', () => _save(st));
  box.querySelector('[data-cw="reset"]')?.addEventListener('click', () => _reset(st));
  box.querySelector('[data-cw="download"]')?.addEventListener('click', () => _download(st));
}

// The metal an unset frame takes on: the previewed tier's.
function _frameMetal(st) {
  const t = CERT_TIERS.find(x => x.id === st.tier);
  const v = String(_val(st, 'colors', (t && t.colour) || st.tier) || '');
  return HEX.test(v) ? v : '#000000';
}

function _labelsHtml(st, dis) {
  const t = CERT_TIERS.find(x => x.id === st.tier) || CERT_TIERS[0];
  return `<p class="settings-hint">For the <strong>${esc(t.label)}</strong> certificate (${esc(t.sub)}). Pick another above to edit its wording.</p>
    <div class="form-group cw-field"><label for="cw-l-headline">Headline</label><input id="cw-l-headline" type="text" maxlength="30" data-sec="labels" data-key="${t.id}" data-sub="headline" value="${esc(String(_val(st, 'labels', t.id, 'headline')))}"${dis}/></div>
    <div class="form-group cw-field"><label for="cw-l-sub">Small line</label><input id="cw-l-sub" type="text" maxlength="40" data-sec="labels" data-key="${t.id}" data-sub="sub" value="${esc(String(_val(st, 'labels', t.id, 'sub')))}"${dis}/></div>`;
}

function _wire(st) {
  const box = st.box;
  box.querySelectorAll('.cw-tier').forEach(b => b.addEventListener('click', () => _pickTier(st, b.dataset.tier)));
  box.querySelectorAll('[data-cw-panel]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.cwPanel;
    const panel = box.querySelector(`#cw-panel-${id}`);
    if (!panel) return;
    const opening = panel.hidden;
    panel.hidden = !opening;
    b.setAttribute('aria-expanded', opening ? 'true' : 'false');
    b.closest('.cw-sec')?.classList.toggle('open', opening);
    if (opening) st.open.add(id); else st.open.delete(id);
  }));
  _wireInputs(st, box.querySelector('.cw-edit'));
  _wireActions(st);
}

// Preview (and edit the wording of) one tier's certificate.
function _pickTier(st, tier) {
  const box = st.box;
  st.tier = tier;
  box.querySelectorAll('.cw-tier').forEach(x => { const on = x.dataset.tier === tier; x.classList.toggle('active', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  const lab = box.querySelector('#cw-labels');
  if (lab) { setSafeHtml(lab, _labelsHtml(st, st.opts.readOnly ? ' disabled' : '')); _wireInputs(st, lab); }
  // An unset frame follows the metal of the certificate on show.
  const fr = box.querySelector('.cw-colour[data-follows="medal"] input');
  if (fr) fr.value = _frameMetal(st).toLowerCase();
  _preview(st);
}

function _wireInputs(st, root) {
  if (!root) return;
  root.querySelectorAll('[data-sec]').forEach(el => {
    const ev = el.type === 'checkbox' || el.type === 'color' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      const sec = el.dataset.sec, key = el.dataset.key, sub = el.dataset.sub;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'color') { v = String(v).toUpperCase(); const code = el.parentElement.querySelector('code'); if (code) code.textContent = v; el.parentElement.removeAttribute('data-follows'); }
      _set(st, sec, key, v, sub);
      if (sec === 'show' && key === 'code') _syncQrBox(st);
    });
  });
}

// The QR box follows the ID box as it is pressed (the render does the same).
function _syncQrBox(st) {
  const qr = st.box.querySelector('[data-sec="show"][data-key="qr"]');
  const note = st.box.querySelector('#cw-qr-note');
  if (!qr || !note) return;
  const held = _val(st, 'show', 'code') === false;
  qr.disabled = !!st.opts.readOnly || held;
  if (held) qr.setAttribute('aria-describedby', 'cw-qr-note'); else qr.removeAttribute('aria-describedby');
  note.hidden = !held;
}

function _syncState(st) {
  // Save is never drawn disabled (it read as a broken control); a press with
  // nothing changed says so instead.
  const save = st.box.querySelector('[data-cw="save"]');
  if (save) save.classList.toggle('is-clean', !st.dirty);
  const s = st.box.querySelector('#cw-state');
  if (s) s.textContent = st.dirty ? 'Unsaved changes' : '';
}

/** Text cut to `max` characters as the preview route counts them (code points),
 *  so a cut never splits a character in two (String#slice counts UTF-16 units). */
export function cutCodePoints(text, max) {
  return [...String(text ?? '')].slice(0, max).join('');
}

function _sample(st) {
  const sample = { tier: st.tier, name: 'Jane Doe' };
  if (st.opts.compName) sample.event = cutCodePoints(st.opts.compName, 120);
  return sample;
}

async function _render_png(body) {
  const r = await fetch('/api/admin/certificate-config/preview', { method: 'POST', headers: { ...csrfHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    let msg = r.status === 429 ? 'Too many previews in a minute — pausing briefly.' : 'Could not render a preview.';
    // An unreadable error body keeps the fixed message above.
    const j = await r.json().catch(() => null);
    if (j && j.error && r.status !== 429) msg = j.error;
    return { error: msg };
  }
  return { blob: await r.blob() };
}

/** Render a certificate PNG from the design (exported for the Rankings top three). */
export async function renderCertificatePreview({ compId, config, sample }) {
  const body = { sample };
  if (compId) body.competition_id = compId;
  if (config && Object.keys(config).length) body.config = config;
  try { return await _render_png(body); } catch (_) { return { error: 'Could not render a preview.' }; }
}

export function blobToDataUri(blob) {
  return new Promise((resolve) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result || '')); fr.onerror = () => resolve(''); fr.readAsDataURL(blob); });
}

// Everything that decides the picture: the layer being edited AND the design it
// sits on (the platform design an event inherits, or the defaults), which
// another admin can change between two opens. The email section never changes it.
function _previewKey(st) {
  const pic = { ...(st.layer || {}) };
  delete pic.email;
  const base = { ...(st.base || {}) };
  delete base.email;
  return JSON.stringify([st.opts.compId || '', base, pic, _sample(st)]);
}

async function _preview(st) {
  const seq = ++st.previewSeq;
  const cap = st.box.querySelector('#cw-cap');
  const skel = st.box.querySelector('#cw-skel');
  const key = _previewKey(st);
  let hit = _previewCache.get(key);
  if (!hit) {
    if (cap) cap.textContent = 'Rendering a preview…';
    if (skel) skel.hidden = false;
    const out = await renderCertificatePreview({ compId: st.opts.compId, config: st.layer, sample: _sample(st) });
    if (seq !== st.previewSeq || !st.box.isConnected) return;
    if (out.error) { if (cap) cap.textContent = out.error; return; }
    hit = { blob: out.blob, uri: await blobToDataUri(out.blob) };
    if (_previewCache.size >= PREVIEW_CACHE_MAX) _previewCache.delete(_previewCache.keys().next().value);
    _previewCache.set(key, hit);
  }
  const img = st.box.querySelector('#cw-img');
  if (seq !== st.previewSeq || !img) return;
  st.lastBlob = hit.blob;
  img.src = hit.uri; img.hidden = false;
  if (skel) skel.hidden = true;
  const t = CERT_TIERS.find(x => x.id === st.tier);
  if (cap) cap.textContent = `Preview — ${t ? t.label : st.tier} certificate with sample details${st.dirty ? ' (unsaved)' : ''}.`;
}

async function _save(st) {
  if (!st.dirty) { showToast('Nothing has changed since the last save.', 'info'); return; }
  const url = st.opts.compId ? `/api/admin/competitions/${encodeURIComponent(st.opts.compId)}/certificate-config` : '/api/admin/certificate-config';
  let r = null, d = {};
  const body = { config: st.layer };
  if (st.version !== undefined) body.expectedVersion = st.version;
  try { r = await fetch(url, { method: 'PUT', headers: { ...csrfHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); d = await r.json().catch(() => ({})); } catch (_) { r = null; }
  if (r && r.status === 409 && d && d.code === 'certificate_config_changed') {
    // Somebody saved this design after it was opened here: saving now would put
    // back every field they changed. Their version is loaded on request; until
    // then these edits stay on screen, unsaved.
    const load = await showModal({
      title: 'This design was changed',
      message: esc(d.error || 'Another administrator changed this certificate design after you opened it.'),
      confirmText: 'Load their version', cancelText: 'Keep my edits on screen',
    });
    if (load) renderCertificateWizard(st.box, st.opts);
    return;
  }
  if (!r || !r.ok) {
    showToast((d && d.error) || 'Could not save the certificate design.', 'error');
    if (d && d.field) _focusField(st, String(d.field));
    return;
  }
  st.dirty = false;
  st.effective = d.effective || st.effective;
  st.layer = _clone(st.opts.compId ? d.override : d.global);
  st.overridden = st.opts.compId ? !!d.overridden : !!(d.global && Object.keys(d.global).length);
  if (typeof d.version === 'string') st.version = d.version;
  const sc = st.box.querySelector('#cw-scope');
  if (sc && st.opts.compId) sc.textContent = st.overridden ? 'This event has its own certificate design.' : 'This event uses the platform design.';
  // The buttons follow: a first save gives the design its way back.
  const acts = st.box.querySelector('.cw-actions');
  if (acts) {
    const hadFocus = acts.contains(document.activeElement) ? document.activeElement.getAttribute('data-cw') : null;
    setSafeHtml(acts, _actionsHtml(st));
    _wireActions(st);
    if (hadFocus) acts.querySelector(`[data-cw="${CSS.escape(hadFocus)}"]`)?.focus();
  }
  _syncState(st);
  showToast('Certificate design saved. Certificates downloaded from now on use it.', 'success');
  _preview(st);
}

// A refused field: open its section (a medal-wording field on its own tier) and
// put focus on it. `field` is the server's path: `text.title`, `colors.frame`,
// `labels.gold.headline`, `email.subject`.
function _focusField(st, field) {
  const parts = field.split('.');
  let el = null;
  if (parts[0] === 'labels' && parts.length === 3) {
    if (st.tier !== parts[1] && CERT_TIERS.some(t => t.id === parts[1])) _pickTier(st, parts[1]);
    el = st.box.querySelector(`[data-sec="labels"][data-key="${CSS.escape(parts[1])}"][data-sub="${CSS.escape(parts[2])}"]`);
  } else if (parts.length >= 2) {
    el = st.box.querySelector(`[data-sec="${CSS.escape(parts[0])}"][data-key="${CSS.escape(parts[1])}"]`);
  }
  const panel = el && el.closest('.cw-panel');
  if (panel && panel.hidden) st.box.querySelector(`[data-cw-panel="${panel.id.replace('cw-panel-', '')}"]`)?.click();
  el?.focus();
}

async function _reset(st) {
  const ok = await showModal({
    title: st.opts.compId ? 'Use the platform design?' : 'Reset the certificate design?',
    message: st.opts.compId
      ? 'This event’s own wording, colours and choices are removed, and its certificates use the platform design again.'
      : 'The platform design goes back to the built-in wording and colours. Events with their own design keep it.',
    confirmText: st.opts.compId ? 'Use platform design' : 'Reset', confirmClass: 'danger', cancelText: 'Cancel',
  });
  if (!ok) return;
  const url = st.opts.compId ? `/api/admin/competitions/${encodeURIComponent(st.opts.compId)}/certificate-config` : '/api/admin/certificate-config';
  let r = null, d = {};
  try { r = await fetch(url, { method: 'DELETE', headers: csrfHeaders() }); d = await r.json().catch(() => ({})); } catch (_) { r = null; }
  if (!r || !r.ok) { showToast((d && d.error) || 'Could not reset the certificate design.', 'error'); return; }
  showToast(st.opts.compId ? 'This event now uses the platform certificate design.' : 'The certificate design is back to its defaults.', 'success');
  renderCertificateWizard(st.box, st.opts);
}

function _download(st) {
  if (!st.lastBlob) { showToast('The preview is still rendering.', 'error'); return; }
  const slug = String(st.opts.compName || 'certificate').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'certificate';
  downloadBlob(st.lastBlob, `${slug}-${st.tier}-preview.png`);
}

/** Settings → Certificate design (any role holding certificates.design). */
export function loadPlatformCertificateCard() {
  const card = document.getElementById('cert-config-card');
  if (!card) return;
  // Administrators and superadmins edit the platform design (operator ruling,
  // 29 Oct 2026); an event admin never reaches it. The offer is the route's own
  // predicate, read from the session's permissions (ui/nav.js).
  const canEdit = certificateDesignOffered();
  card.style.display = canEdit ? '' : 'none';
  if (!canEdit) return;
  // Opened on demand: the designer renders a full-size preview on the server,
  // which Settings has no reason to pay for on every visit.
  const body = document.getElementById('cert-config-body');
  if (!body || body._cw) return;
  setSafeHtml(body, `<button type="button" class="btn secondary" data-cw-open>${ICO.award} Open the certificate designer</button>`);
  body.querySelector('[data-cw-open]').addEventListener('click', () => renderCertificateWizard(body, {}));
}

// ── Issued certificates (event workspace → Certificates) ────────────────────
//
// GET /api/admin/competitions/:id/certificates lists every certificate the event
// has issued: holder, tier, credential code, whether it was revoked, and the
// state of its congratulations email. Organisers download the issued PDF / PNG
// (recorded on the event's History) and re-send the email
// (POST …/certificates/resend {userId}; 409 while a send is already running).

const _TIER_LABEL = { gold: '1st place', silver: '2nd place', bronze: '3rd place', participation: 'Participation', completion: 'Completion' };
const _MAIL_LABEL = { sent: 'Emailed', pending: 'Email queued', sending: 'Sending', failed: 'Email failed', suppressed: 'Unsubscribed', skipped: 'Not emailed', unknown: 'Delivery unknown — re-send to be sure' };

export async function fetchIssuedCertificates(compId) {
  return fetchJsonObject(`/api/admin/competitions/${encodeURIComponent(compId)}/certificates`);
}

export async function downloadIssuedCertificate(compId, userId, kind, name) {
  const url = `/api/admin/competitions/${encodeURIComponent(compId)}/certificates/${encodeURIComponent(userId)}/${kind === 'png' ? 'badge.png' : 'certificate.pdf'}`;
  let r = null;
  try { r = await fetch(url); } catch (_) { r = null; }
  if (!r || !r.ok) {
    let m = 'Could not download the certificate.';
    if (r) {
      // An unreadable error body keeps the fixed message above.
      const j = await r.json().catch(() => null);
      if (j && j.error) m = j.error;
    }
    showToast(m, 'error');
    return;
  }
  // Named after the holder as the certificate prints the name (`name`, the
  // server's: the Issued list's Holder, the Rankings top three's place), in any
  // script: 张伟-certificate.pdf, by the one rule the Rankings preview PNG names
  // its holder by too (ui/download.js fileNameSlug); cut at 40 characters.
  downloadBlob(await r.blob(), `${fileNameSlug(name, { max: 40, fallback: 'certificate' })}-certificate.${kind === 'png' ? 'png' : 'pdf'}`);
}

export async function resendCertificateEmail(compId, userId) {
  let r = null, d = {};
  try { r = await fetch(`/api/admin/competitions/${encodeURIComponent(compId)}/certificates/resend`, { method: 'POST', headers: { ...csrfHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) }); d = await r.json().catch(() => ({})); } catch (_) { r = null; }
  if (!r) { showToast('Could not reach the server.', 'error'); return false; }
  if (!r.ok) { showToast(d.error || 'Could not re-send the email.', 'error'); return false; }
  if (d.ok === false) { showToast(d.error || 'The email was not sent.', 'error'); return true; }
  showToast(d.status === 'sent' ? 'Certificate email sent.' : 'Certificate email is on its way.', 'success');
  return true;
}

// REVOKE and ISSUE AGAIN (operator ruling, 17 Nov 2026): issued certificates never
// change by themselves, so a placing a revive moved is corrected by revoking the
// certificate and issuing a new one from the event's current results. Both are the
// routes' own offers: Revoke where the row carries its token (sent only to whoever
// holds `certificates.revoke`), Issue again where the row says `canIssueAgain`.
export async function revokeIssuedCertificate(c) {
  const reason = await showPrompt({ title: `Revoke ${_holder(c)}'s certificate?`, label: 'Reason (recorded on their History)', confirmText: 'Revoke' });
  if (reason === null) return false;
  let r = null, d = {};
  try { r = await fetch(`/api/admin/badges/${encodeURIComponent(c.token)}/revoke`, { method: 'POST', headers: { ...csrfHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }); d = await r.json().catch(() => ({})); } catch (_) { r = null; }
  if (!r) { showToast('Could not reach the server.', 'error'); return false; }
  if (!r.ok) { showToast(d.error || 'Could not revoke the certificate.', 'error'); return r.status === 409; }
  showToast('Certificate revoked. Its code now says so wherever it is checked.', 'success');
  return true;
}

export async function reissueCertificate(compId, c, { emailEnabled = false } = {}) {
  const ok = await showModal({
    title: `Issue ${_holder(c)} a new certificate?`,
    message: `A new certificate is drawn from the event's current results, with a new code. The revoked one stays revoked.${emailEnabled ? ' They are emailed the new one.' : ''}`,
    confirmText: 'Issue again', confirmClass: '',
  });
  if (!ok) return false;
  let r = null, d = {};
  try { r = await fetch(`/api/admin/competitions/${encodeURIComponent(compId)}/certificates/reissue`, { method: 'POST', headers: { ...csrfHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: c.userId }) }); d = await r.json().catch(() => ({})); } catch (_) { r = null; }
  if (!r) { showToast('Could not reach the server.', 'error'); return false; }
  if (!r.ok) { showToast(d.error || 'Could not issue the certificate.', 'error'); return r.status === 409; }
  const what = d.certificate ? (_TIER_LABEL[d.certificate.tier] || d.certificate.label || 'certificate') : 'certificate';
  showToast(`New certificate issued: ${what}.${d.emailQueued ? ' It is being emailed.' : ''}`, 'success');
  return true;
}

// The name the holder's certificate prints, by the server's rule (the row's
// `name`, routes/badge.js `_heldName`): never composed here, since the
// certificate puts a Chinese, Japanese or Korean family name first and prints
// the nickname where its fonts cannot draw the name.
function _holder(c) { return c.name || c.nickname || 'Participant'; }

export async function renderIssuedCertificates(box, { compId, readOnly = false } = {}) {
  if (!box) return;
  const seq = (box._icSeq = (box._icSeq || 0) + 1);
  setSafeHtml(box, '<p class="ws-empty">Loading issued certificates…</p>');
  const d = await fetchIssuedCertificates(compId);
  if (seq !== box._icSeq) return;
  if (!d || !Array.isArray(d.certificates)) {
    setSafeHtml(box, '<div class="load-failure" role="alert">Could not load the issued certificates. <button type="button" class="btn sm secondary" data-ic-retry>Try again</button></div>');
    box.querySelector('[data-ic-retry]')?.addEventListener('click', () => renderIssuedCertificates(box, { compId, readOnly }));
    return;
  }
  const list = d.certificates;
  const pend = (d.pending || []).length;
  // Re-send is the route's own offer: `certificates.send`, never for a
  // competitor, and it works with the event's email switch off (one email to
  // one holder, on request).
  const canResend = !readOnly && adminCan('certificates.send');
  const canRevoke = !readOnly && adminCan('certificates.revoke');
  // A holder's credential code is shown only to someone who may look a
  // certificate up by its code (the server sends it to nobody else): the list
  // would otherwise be the code-to-holder table that lookup keeps audited.
  const showCode = adminCan('certificates.lookup');
  const head = `<div class="ic-head"><div><p class="eyebrow gold">Issued</p><h3 class="ic-title">${list.length} certificate${list.length === 1 ? '' : 's'}</h3></div>
    <p class="ic-note">${d.emailEnabled ? 'Holders are emailed their certificate.' : 'Certificate emails are off for this event.'}${pend ? ` ${pend} send${pend === 1 ? ' is' : 's are'} queued.` : ''}</p></div>`;
  if (!list.length) { setSafeHtml(box, `${head}<p class="ws-empty">None yet. Certificates are issued when the event ends (for a Program, when someone finishes every question with 60% or more).</p>`); return; }
  // Buttons name their row by its place in the list (`data-i`): a holder can
  // have a revoked row beside a live one, so the user id alone is ambiguous.
  const rows = list.map((c, i) => {
    const mail = c.emailStatus ? (_MAIL_LABEL[c.emailStatus.status] || c.emailStatus.status) : (d.emailEnabled ? 'Not emailed' : '—');
    const again = readOnly ? ''
      : c.canIssueAgain ? `<button type="button" class="btn sm secondary" data-ic="reissue" data-i="${i}" data-user="${esc(c.userId)}" aria-label="Issue again — a new certificate for ${esc(_holder(c))} from the current results">Issue again</button>`
      : c.issueAgainRefused ? `<small class="ic-why">${esc(c.issueAgainRefused)}</small>` : '';
    const acts = c.revoked ? `<span class="ic-revoked">Revoked</span>${again}`
      : `<button type="button" class="btn sm secondary" data-ic="pdf" data-i="${i}" data-user="${esc(c.userId)}" aria-label="PDF certificate of ${esc(_holder(c))}">${ICO.download} PDF</button><button type="button" class="btn sm secondary" data-ic="png" data-i="${i}" data-user="${esc(c.userId)}" aria-label="PNG image of ${esc(_holder(c))}'s certificate">PNG</button>${canResend ? `<button type="button" class="btn sm secondary" data-ic="resend" data-i="${i}" data-user="${esc(c.userId)}" aria-label="Re-send the certificate email to ${esc(_holder(c))}">Re-send</button>` : ''}${canRevoke && c.token ? `<button type="button" class="btn sm secondary" data-ic="revoke" data-i="${i}" data-user="${esc(c.userId)}" aria-label="Revoke ${esc(_holder(c))}'s certificate">Revoke</button>` : ''}`;
    return `<tr${c.revoked ? ' class="ic-row-revoked"' : ''}>
      <td data-label="Holder" class="ic-lead"><b>${esc(_holder(c))}</b><small>${esc(c.email || c.nickname || '')}</small></td>
      <td data-label="Certificate"><span class="ic-tier ic-tier-${esc(c.tier || '')}">${esc(_TIER_LABEL[c.tier] || c.label || c.tier || '')}</span>${c.lateEntrant ? ' <small>late entry</small>' : ''}${c.grade ? ` <small class="ic-grade">${esc(c.grade.label)}</small>` : ''}</td>
      <td data-label="Score">${c.scoreLabel ? esc(c.scoreLabel) : c.score != null ? esc(String(c.score)) : (c.grade ? esc(c.grade.percent) : '—')}</td>
      ${showCode ? `<td data-label="Code"><code class="ic-code">${esc(c.code || '—')}</code></td>` : ''}
      <td data-label="Email" title="${esc((c.emailStatus && c.emailStatus.lastError) || '')}">${esc(mail)}</td>
      <td class="ic-acts">${acts}</td></tr>`;
  }).join('');
  setSafeHtml(box, `${head}<div class="table-card ic-table"><table class="dense" data-tcols="certificates" data-tcols-scope="${esc(compId || '')}"><thead><tr><th scope="col">Holder</th><th scope="col">Certificate</th><th scope="col">Score</th>${showCode ? '<th scope="col">Code</th>' : ''}<th scope="col">Email</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`);
  box.querySelectorAll('[data-ic]').forEach(b => b.addEventListener('click', async () => {
    const c = list[Number(b.dataset.i)];
    if (!c) return;
    if (b.dataset.ic === 'resend') { b.disabled = true; const done = await resendCertificateEmail(compId, c.userId); b.disabled = false; if (done) renderIssuedCertificates(box, { compId, readOnly }); return; }
    if (b.dataset.ic === 'revoke' || b.dataset.ic === 'reissue') {
      b.disabled = true;
      const done = b.dataset.ic === 'revoke' ? await revokeIssuedCertificate(c) : await reissueCertificate(compId, c, { emailEnabled: !!d.emailEnabled });
      b.disabled = false;
      if (done) renderIssuedCertificates(box, { compId, readOnly });
      return;
    }
    downloadIssuedCertificate(compId, c.userId, b.dataset.ic, _holder(c));
  }));
}
