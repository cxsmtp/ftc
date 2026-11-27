"use strict";
//
// v7.21.26 — ONE profile form, rendered by both dialogs.
//
// The participant's own editor (`#profile-overlay`, features/auth.js) and the
// admin's (`#admin-profile-overlay`, features/participants-admin.js) show the
// same fields in the same four groups, and had two hand-maintained copies of the
// markup. They had already drifted in ways nobody intended — the admin copy was
// missing the `maxlength` caps on city and phone, the required markers, and the
// field hints — and the avatar control added in v7.21.25 reached only one of
// them, which is what prompted this.
//
// What is deliberately NOT shared: the per-field LOCK decision. That is the one
// thing the two dialogs genuinely differ on, and it is a policy, so each caller
// passes a `locked(field)` predicate:
//
//   self  — nothing is locked: every field, including the avatar, is the
//           user's own to change (a legacy LinkedIn-registered account too).
//   admin — a privileged target is wholly read-only to a non-superadmin; on an
//           ordinary target a regular admin may FILL a blank field but never
//           overwrite a populated one; a superadmin may change anything.
//
// This module is a UI leaf: it imports only from ui/ and core/, never from
// features/, so there is no cycle with the two dialogs that use it.
import { setSafeHtml } from "../core/trusted-types.js";
import { avatarHtml, esc } from "./format.js";
import { AVATARS } from "./icons.js";

// MOVED VERBATIM from features/auth.js — not retyped. The first draft of this
// file re-wrote them from memory and silently changed the preset LIST, the
// placeholder and two option labels, which is precisely the drift this extraction
// exists to remove. When hoisting shared code, move the bytes.
export const JOB_FUNCTION_PRESETS=[
  'Software Developer / Engineer',
  'Solutions / Cloud Architect',
  'DevOps / DevSecOps Engineer',
  'Application Security Engineer',
  'Security Leader (Manager, Director, CISO)',
];

// audit v7.23.7 — `ac` is an OPTIONAL 4th argument that defaults to emitting
// NOTHING, so the consumer outside profileFieldsHtml (the profile completion
// gate) keeps byte-identical output. Only the shared profile form passes it.
export function jobFunctionSelectHtml(id,current,disabled,ac='',ariaRequired=false){
  const dis=disabled?'disabled':'';
  const a=ac?`autocomplete="${ac}"`:'';
  // Same defaulting rule as `ac`: emit nothing unless asked, so the three
  // consumers outside profileFieldsHtml keep byte-identical output.
  const ar=ariaRequired?'aria-required="true"':'';
  const isOther=current&&!JOB_FUNCTION_PRESETS.includes(current);
  const opts=JOB_FUNCTION_PRESETS.map(v=>`<option value="${esc(v)}"${current===v?' selected':''}>${esc(v)}</option>`).join('');
  return`<select id="${id}" ${a} ${ar} ${dis}>
    <option value="">Select your role...</option>
    ${opts}
    <option value="other"${isOther?' selected':''}>Other...</option>
  </select>
  <input id="${id}-other" type="text" maxlength="120" placeholder="Describe your role" value="${isOther?esc(current):''}" style="display:${isOther?'block':'none'};margin-top:6px" ${a} ${dis}/>`;
}

// Optional honorific/personal-title preset list (default empty). Cap 20 chars (USER_FIELD_CAPS.personal_title).
export const PERSONAL_TITLE_PRESETS=['Mr.','Mrs.','Ms.','Miss','Dr.','Prof.','Mx.'];

// v8.4.0 — `required` changes the EMPTY option's label and marks the control.
//
// A Booth Event may make Salutation mandatory, and the blank option reads
// "Prefer not to say" — so a required select would offer a choice and then refuse
// it, which is the control-that-appears-to-work failure with the copy pointing
// straight at it. The placeholder becomes an instruction instead, matching every
// other required select on the platform ("Select country...").
export function personalTitleSelectHtml(id,current,disabled,ac='',required=false){
  const dis=disabled?'disabled':'';
  const a=ac?`autocomplete="${ac}"`:'';
  const cur=current||'';
  const opts=PERSONAL_TITLE_PRESETS.map(v=>`<option value="${esc(v)}"${cur===v?' selected':''}>${esc(v)}</option>`).join('');
  // Preserve a non-preset stored value (e.g. an imported "Sr." or a legacy
  // honorific) so opening + saving the dialog doesn't silently blank it. esc()
  // keeps it XSS-safe; the value is only ever used as an option, never raw HTML.
  const extra=(cur&&!PERSONAL_TITLE_PRESETS.includes(cur))?`<option value="${esc(cur)}" selected>${esc(cur)}</option>`:'';
  return`<select id="${id}" ${a} ${dis}${required?' aria-required="true"':''}>
    <option value=""${cur===''?' selected':''}>${required?'Select a salutation...':'Prefer not to say'}</option>
    ${extra}${opts}
  </select>`;
}

// ── avatar upload ───────────────────────────────────────────────────────────

export function toBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// v7.21.24 — decode WITHOUT an <img> wherever possible. The CSP is
// `img-src 'self' data:` with no `blob:`, so the obvious
// `URL.createObjectURL(file)` + `new Image()` is blocked outright — and it fails
// as a silent onerror, which reads exactly like "that file is not an image".
// createImageBitmap is not an img-src sink at all; the data: fallback is for
// engines that lack it and is allowed by the policy.
function _decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file).then(bmp => ({ src: bmp, w: bmp.width, h: bmp.height }));
  }
  return toBase64(file).then(uri => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ src: img, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error('not_an_image'));
    img.src = uri;
  }));
}

export const AVATAR_UPLOAD_MAX_PX = 256;

// An avatar is DOWNSCALED before it is encoded. There was never a reason to ship
// a five-megabyte photo to draw a 52 px circle, and before v7.21.24 doing so
// overran the registration body cap and made signing up fail outright.
export async function downscaleImageFile(file, maxPx = AVATAR_UPLOAD_MAX_PX) {
  const { src, w: nw, h: nh } = await _decodeImage(file);
  if (!nw || !nh) throw new Error('not_an_image');
  const scale = Math.min(1, maxPx / Math.max(nw, nh));
  const w = Math.max(1, Math.round(nw * scale));
  const h = Math.max(1, Math.round(nh * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  // White first, or a transparent PNG composites onto black and a logo-style
  // avatar becomes a dark box.
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  if (src.close) src.close();
  // Step quality down only if needed. At this size the first attempt is already
  // a few kilobytes; the loop exists so a pathological image cannot come out over
  // budget, not as routine behaviour.
  let out = '';
  for (const q of [0.85, 0.7, 0.55, 0.4]) {
    out = c.toDataURL('image/jpeg', q);
    if (out.length <= 180 * 1024) break;
  }
  return out;
}

// ── the avatar picker ───────────────────────────────────────────────────────

/**
 * `includeDefault` adds `default1` (the plain 👤) as a leading option. The
 * registration form does NOT need it — it STARTS on default1, so "pick nothing"
 * already expresses it — but an EDITOR does: without it, uploading a photo is a
 * one-way door with no way back to no-picture.
 */
export function avatarGridItemsHtml(current, includeDefault) {
  const items = includeDefault ? ['default1', ...AVATARS] : AVATARS;
  return items.map(a => {
    const sel = a === current;
    const label = a === 'default1' ? 'No picture' : `Avatar ${a}`;
    const face = a === 'default1' ? '👤' : a;
    return `<div class="avatar-option ${sel ? 'selected' : ''}" data-action="avatar-select" data-avatar="${esc(a)}" role="radio" aria-checked="${sel ? 'true' : 'false'}" aria-label="${esc(label)}" title="${esc(label)}" tabindex="${sel ? '0' : '-1'}">${face}</div>`;
  }).join('');
}

/**
 * The avatar group, identical in both editors.
 *
 * It renders LAST in both dialogs. It used to sit first in the participant's,
 * where a 25-cell grid pushed every text field below the fold — the picture is
 * the least-edited thing on the form and the most vertical space, so it belongs
 * at the end. The preview and grid share the top row and the upload control is a
 * full-width `.form-group` beneath BOTH, so it lines up with every other label
 * in the dialog instead of being indented under the grid.
 */
export function avatarPickerHtml({ prefix, current, disabled, note }) {
  const dis = disabled ? 'disabled' : '';
  return `<div class="profile-group profile-avatar-group" role="group" aria-label="Avatar">
    <p class="profile-group-label">Avatar</p>
    <div class="profile-avatar-row">
      <div class="profile-avatar-preview" id="${prefix}-avatar-preview" aria-hidden="true">${avatarHtml(current || 'default1', 72)}</div>
      <div class="avatar-grid" id="${prefix}-avatar-grid" role="radiogroup" aria-label="Choose an avatar"${disabled ? ' aria-disabled="true"' : ''}>${avatarGridItemsHtml(current || 'default1', true)}</div>
    </div>
    <div class="form-group profile-avatar-upload">
      <label for="${prefix}-avatar-upload">Or upload your own <span class="profile-label-hint">(scaled down automatically)</span></label>
      <input type="file" id="${prefix}-avatar-upload" accept="image/*" aria-label="Upload avatar image" ${dis}/>
    </div>
    ${note ? `<p class="profile-label-hint profile-avatar-note">${esc(note)}</p>` : ''}
  </div>`;
}

/**
 * Wire the picker. Returns `{ get() }` — the caller reads the pending value at
 * save time and includes it in the dirty snapshot.
 *
 * The value lives on the returned handle rather than in module state because it
 * is per-dialog: opening an editor twice must not inherit the first attempt's
 * unsaved pick, and the two editors can never share one.
 */
export function wireAvatarPicker({ prefix, current, disabled, errorEl, onChange }) {
  const preview = document.getElementById(`${prefix}-avatar-preview`);
  const upload = document.getElementById(`${prefix}-avatar-upload`);
  const grid = document.getElementById(`${prefix}-avatar-grid`);
  let value = current || 'default1';
  const set = v => {
    value = v;
    // avatarHtml already renders all three forms — a preset emoji, a stored
    // /api/images/<id> ref, and a data: URI — so a freshly picked photo previews
    // before it is saved, with no second rendering path to keep in step.
    if (preview) setSafeHtml(preview, avatarHtml(v, 72));
    if (typeof onChange === 'function') onChange(v);
  };
  if (grid) {
    if (disabled) {
      grid.querySelectorAll('.avatar-option').forEach(el => {
        el.removeAttribute('data-action');
        el.setAttribute('aria-disabled', 'true');
        el.setAttribute('tabindex', '-1');
      });
    } else {
      grid._onSelect = v => { set(v); if (upload) upload.value = ''; };
      wireAvatarGridKeyboard(grid);
    }
  }
  if (upload && !disabled) {
    upload.addEventListener('change', async e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        set(await downscaleImageFile(f));
        // A picture wins over whatever preset was ticked — leaving one
        // highlighted would say the opposite of what will be saved.
        grid?.querySelectorAll('.avatar-option').forEach(el => {
          el.classList.remove('selected');
          el.setAttribute('aria-checked', 'false');
          el.setAttribute('tabindex', '-1');
        });
        if (errorEl) errorEl.style.display = 'none';
      } catch (_) {
        if (errorEl) {
          errorEl.textContent = 'That image could not be read. Please choose a different picture, or pick one of the avatars above.';
          errorEl.style.display = 'block';
        }
        e.target.value = '';
      }
    });
  }
  return { get: () => value };
}

/** Roving-tabindex radiogroup keyboard nav (arrows + Home/End + Enter/Space). */
export function wireAvatarGridKeyboard(grid) {
  if (!grid || grid.dataset.kbWired) return;
  grid.dataset.kbWired = '1';
  grid.addEventListener('keydown', e => {
    const opts = [...grid.querySelectorAll('.avatar-option')];
    if (!opts.length) return;
    const cur = document.activeElement.closest?.('.avatar-option');
    let idx = opts.indexOf(cur); if (idx < 0) idx = 0;
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = opts[(idx + 1) % opts.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = opts[(idx - 1 + opts.length) % opts.length];
    else if (e.key === 'Home') next = opts[0];
    else if (e.key === 'End') next = opts[opts.length - 1];
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cur?.click(); return; }
    else return;
    e.preventDefault();
    if (next) { next.focus(); selectAvatarIn(next.dataset.avatar, next); }
  });
}

/**
 * `avatar-select` is ONE delegated action serving both editors, so the deselect
 * sweep is scoped to the grid that was clicked; each editor's grid carries its
 * own `_onSelect`.
 */
export function selectAvatarIn(a, el) {
  const grid = el?.closest?.('.avatar-grid');
  (grid || document).querySelectorAll('.avatar-option').forEach(e => {
    e.classList.remove('selected'); e.setAttribute('aria-checked', 'false'); e.setAttribute('tabindex', '-1');
  });
  el.classList.add('selected'); el.setAttribute('aria-checked', 'true'); el.setAttribute('tabindex', '0');
  if (grid && typeof grid._onSelect === 'function') grid._onSelect(a);
}

// ── the four field groups ───────────────────────────────────────────────────

/**
 * Every text/select field both editors show, in one place.
 *
 * @param prefix        'prof' | 'adp' — element ids stay per-dialog, so the
 *                      existing regression tests locate the same controls they
 *                      always have. That is what proves this extraction changed
 *                      no behaviour.
 * @param user          the row to render
 * @param locked        (field) => bool — the ONLY policy input; see the header
 * @param tzChangeAction the delegated change-action that repopulates timezones
 * @param emailsExtraHtml markup appended inside the Emails group
 */
// audit v7.23.7 (WCAG 1.3.5 Identify Input Purpose, AA) — autocomplete tokens.
//
// THE TWO CALLERS MUST DIFFER, and this is the whole design decision. 1.3.5
// covers fields collecting information about THE USER. The participant's own
// editor does; the admin's Edit Profile dialog collects a THIRD PARTY's data, so
// there is no obligation there — and tokenising it is actively harmful:
//   * identity autofill CASCADES, so accepting one suggestion can rewrite most
//     of the dialog with the ADMIN's own name, email, phone and employer;
//   * `PUT /api/admin/participants/:id` keeps the stored value only when the
//     incoming one is BLANK (fillRequired, v7.15.8) — an autofilled value is not
//     blank, so it would be persisted onto the participant;
//   * worst, snapshotAdminProfile() takes the dirty-check baseline right after
//     render, so an autofill landing before it BECOMES the baseline: _isDirty()
//     reads false and Cancel closes with no "Discard changes?" at all.
// So the admin dialog gets an explicit `off` — deliberate, not absent.
//
// The tokens are the ones the REGISTRATION form already uses for the same
// fields (public/index.html), rather than a second vocabulary invented here —
// note `username` for the nickname and `country` (not country-name) for the
// select, matching reg-nick and reg-country.
const AUTOCOMPLETE = {
  email: 'email',
  // `section-*` scopes the secondary address to its own autofill group. Without
  // it both email fields advertise `email`, so one autofill fills BOTH with the
  // same address — which `POST /api/register` and `PUT /api/me` then refuse,
  // because primary and secondary must resolve to different mailboxes.
  secondaryEmail: 'section-secondary email',
  personalTitle: 'honorific-prefix',
  firstName: 'given-name',
  lastName: 'family-name',
  nickname: 'username',
  country: 'country',
  city: 'address-level2',
  phone: 'tel',
  company: 'organization',
  title: 'organization-title',
  linkedinUrl: 'url',
  // jobFunction and timezone have no standard autofill purpose; emitting a
  // made-up token would fail axe-core's `autocomplete-valid` rule, which is a
  // real violation in place of a missing nicety.
};

// audit v7.23.7 — mark a field as failing. ONE helper, because the visual state
// and the programmatic one must move together.
//
// `.field-error` paints a red border and a red label (styles.css) and was the
// ONLY signal that a field had failed: colour alone, with nothing on the control
// itself, so a screen-reader user got the summary sentence and no idea which
// field it referred to. WCAG 3.3.1.
//
// The class goes on the .form-group WRAPPER (that is what the CSS targets) while
// aria-invalid must go on the CONTROL — two different elements, which is exactly
// how they would drift if every call site did it by hand.
//
// `el` is the CONTROL. A missing element is a no-op rather than a throw: several
// call sites optimistically address fields that a given dialog may not render.
export function markFieldError(el, bad){
  if(!el) return;
  el.closest('.form-group')?.classList.toggle('field-error', !!bad);
  if(bad) el.setAttribute('aria-invalid','true');
  else el.removeAttribute('aria-invalid');
}

// Companion for the bulk clears, which sweep .form-group WRAPPERS rather than
// individual controls (the task form does this). Clearing the class without
// clearing aria-invalid would leave a field announced as invalid after its error
// had visibly gone — the drift this pair exists to prevent, in the direction
// that is hardest to notice.
export function clearFieldErrors(root){
  (root || document).querySelectorAll('.form-group.field-error').forEach(g => {
    g.classList.remove('field-error');
    g.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
  });
}

// audit v7.23.7 — the fields that are REQUIRED, in one place. The red star in
// the label, the aria-required on the control and the self-edit save's
// "Required:" refusal (features/auth.js saveProfile) are all derived from this, so
// they cannot disagree: a field made required in the markup but not announced to
// assistive tech is the defect this closes, and a hand-maintained pair is how it
// comes back. It is the base set PUT /api/me refuses to empty, plus the names and
// nickname. City and Job function are not in it: the server stores either one
// blank, and an event that requires one asks for it through the completion gate.
export const REQUIRED_FIELDS = new Set([
  'email', 'firstName', 'lastName', 'nickname',
  'country', 'timezone', 'company', 'title',
]);

export function profileFieldsHtml({ prefix, user, locked, tzChangeAction, emailsExtraHtml = '', selfEditing = false }) {
  const u = user || {};
  const id = f => `${prefix}-${f}`;
  const d = f => locked(f) ? 'disabled' : '';
  // Always emits an attribute: `off` on the admin dialog and on any field with
  // no standard purpose, so the absence of a token is never accidental.
  const ac = f => `autocomplete="${(selfEditing && AUTOCOMPLETE[f]) || 'off'}"`;
  // Both derived from REQUIRED_FIELDS — see the note above.
  const req = f => REQUIRED_FIELDS.has(f) ? '<span class="req">*</span>' : '';
  const ar = f => REQUIRED_FIELDS.has(f) ? 'aria-required="true"' : '';
  const hint = t => `<span class="profile-label-hint">${t}</span>`;
  return `
    <div class="profile-group" role="group" aria-label="Emails">
      <p class="profile-group-label">Emails <span data-help="profile.emails" data-help-label="Emails"></span></p>
      <div class="form-row">
        <div class="form-group"><label for="${id('email')}">Primary Email ${req('email')}</label><input ${ar('email')} id="${id('email')}" type="text" value="${esc(u.email || '')}" ${ac('email')} ${d('email')}/></div>
        <div class="form-group"><label for="${id('email2')}">Secondary Email ${hint('(optional)')}</label><input id="${id('email2')}" type="email" value="${esc(u.secondary_email || '')}" placeholder="Additional email for notifications" ${ac('secondaryEmail')} ${d('secondaryEmail')}/></div>
      </div>
      ${emailsExtraHtml}
    </div>
    <div class="profile-group" role="group" aria-label="Identity">
      <p class="profile-group-label">Identity <span data-help="profile.identity" data-help-label="Identity"></span></p>
      <div class="form-row">
        <div class="form-group"><label for="${id('personal-title')}">Salutation ${hint('(optional)')}</label>${personalTitleSelectHtml(id('personal-title'), u.personal_title || '', locked('personalTitle'), (selfEditing && AUTOCOMPLETE.personalTitle) || 'off')}</div>
        <div class="form-group"><label for="${id('first')}">First Name ${req('firstName')}</label><input ${ar('firstName')} id="${id('first')}" value="${esc(u.first_name || '')}" ${ac('firstName')} ${d('firstName')}/></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label for="${id('last')}">Last Name ${req('lastName')}</label><input ${ar('lastName')} id="${id('last')}" value="${esc(u.last_name || '')}" ${ac('lastName')} ${d('lastName')}/></div>
        <div class="form-group"><label for="${id('nick')}">Nickname ${req('nickname')} ${hint('(min. 3 chars, ASCII)')}</label><input ${ar('nickname')} id="${id('nick')}" value="${esc(u.nickname || '')}" minlength="3" ${ac('nickname')} ${d('nickname')}/></div>
      </div>
    </div>
    <!-- v8.1.0 (PR 24) — the name as it should appear on a CERTIFICATE, held
         apart from the profile name because they are answering different
         questions: the profile name is how the platform addresses you, the
         certificate name is what a third party will read off the paper and type
         to verify it.

         TWO fields, not one, and BOTH are needed for the override: a half-filled
         pair would silently mix a certificate given name with a profile surname,
         which is the one combination nobody typed. Optional throughout — leaving
         them blank uses the profile name, so nobody has to fill them in. -->
    <div class="profile-group" role="group" aria-label="Certificate name">
      <p class="profile-group-label">Certificate name</p>
      <div class="form-row">
        <div class="form-group"><label for="${id('cert-given')}">Given Name ${hint('(optional)')}</label><input id="${id('cert-given')}" value="${esc(u.certificate_given_name || '')}" maxlength="100" placeholder="${esc(u.first_name || '')}" autocomplete="off" ${d('certificateGivenName')}/></div>
        <div class="form-group"><label for="${id('cert-family')}">Family Name ${hint('(optional)')}</label><input id="${id('cert-family')}" value="${esc(u.certificate_family_name || '')}" maxlength="100" placeholder="${esc(u.last_name || '')}" autocomplete="off" ${d('certificateFamilyName')}/></div>
      </div>
      <p class="profile-group-note">Leave blank to use your profile name. Fill in BOTH to use a different name on certificates &mdash; this is the name a third party will type to verify one.</p>
    </div>
    <div class="profile-group" role="group" aria-label="Location and contact">
      <p class="profile-group-label">Location &amp; contact <span data-help="profile.location" data-help-label="Location and contact"></span></p>
      <div class="form-row">
        <div class="form-group"><label for="${id('country')}">Country ${req('country')}</label><select ${ar('country')} id="${id('country')}" data-change-action="${esc(tzChangeAction)}" ${ac('country')} ${d('country')}><option value="">Select country...</option></select></div>
        <div class="form-group"><label for="${id('tz')}">Timezone ${req('timezone')}</label><select ${ar('timezone')} id="${id('tz')}" ${ac('timezone')} ${d('timezone')}><option value="">Select timezone...</option></select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label for="${id('city')}">City ${req('city')}</label><input ${ar('city')} id="${id('city')}" type="text" maxlength="120" value="${esc(u.city || '')}" placeholder="Your city" ${ac('city')} ${d('city')}/></div>
        <div class="form-group"><label for="${id('phone')}">Phone ${hint('(optional)')}</label><input id="${id('phone')}" type="tel" maxlength="32" value="${esc(u.phone || '')}" placeholder="+1 555 0100" ${ac('phone')} ${d('phone')}/></div>
      </div>
    </div>
    <div class="profile-group" role="group" aria-label="Professional">
      <p class="profile-group-label">Professional</p>
      <div class="form-row">
        <div class="form-group"><label for="${id('company')}">Company ${req('company')}</label><input ${ar('company')} id="${id('company')}" value="${esc(u.company || '')}" ${ac('company')} ${d('company')}/></div>
        <div class="form-group"><label for="${id('title')}">Work Title ${req('title')}</label><input ${ar('title')} id="${id('title')}" value="${esc(u.title || '')}" ${ac('title')} ${d('title')}/></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label for="${id('linkedin')}">LinkedIn URL ${hint('(optional)')}</label><input id="${id('linkedin')}" type="url" value="${esc(u.linkedin_url || '')}" ${ac('linkedinUrl')} ${d('linkedinUrl')}/></div>
        <div class="form-group"><label for="${id('job-function')}">Job function ${req('jobFunction')}</label>${jobFunctionSelectHtml(id('job-function'), u.job_function || '', locked('jobFunction'), 'off', REQUIRED_FIELDS.has('jobFunction'))}</div>
      </div>
    </div>`;
}

/** The field ids both editors snapshot for their dirty check, in render order. */
export function profileFieldIds(prefix) {
  return ['first', 'last', 'nick', 'email', 'email2', 'company', 'title', 'personal-title',
    'phone', 'linkedin', 'country', 'tz', 'job-function', 'job-function-other', 'city',
    // v8.1.0 (PR 24) — the certificate name is part of the DIRTY SNAPSHOT. Miss
    // it and a certificate-name-only edit reads as a CLEAN form, so the v6.9.2
    // short-circuit closes Save silently and Cancel skips the discard prompt —
    // the change vanishes through a dialog behaving as if nothing was touched.
    // Exactly the v7.21.25 avatar defect, in the same two dialogs.
    'cert-given', 'cert-family']
    .map(f => `${prefix}-${f}`);
}

/**
 * v8.3.37 — WHICH BODY KEYS DID THE USER ACTUALLY CHANGE?
 *
 * Both editors used to submit the WHOLE form on every save, reading each input
 * as it stood when the dialog OPENED. Neither route has optimistic concurrency
 * (`users` has no `updated_at` at all), so that made every save a last-writer-
 * wins over sixteen fields: a stale dialog re-wrote a removed secondary email,
 * an avatar the other writer had already reclaimed, and everything else besides.
 * The concurrent writer is not exotic — an organiser correcting a record through
 * `PUT /api/admin/participants/:id` while the participant has their own editor
 * open is a routine live-event occurrence.
 *
 * THE DISCRIMINATOR IS DIRTINESS, NEVER TRUTHINESS. A cleared field IS dirty and
 * IS sent, as `""`. `certificateGivenName` / `certificateFamilyName` /
 * `secondaryEmail` carry comments at both call sites saying they must be sent
 * even when empty, because clearing them has to mean "clear"; a naive "drop
 * empty strings" would make them unclearable, which is the one-way door PR 24
 * explicitly refused.
 *
 * BASELINE AGAINST THE SERVER ROW, NOT THE DIALOG-OPEN DOM. That is the whole
 * design, and three traps make it so:
 *   * `autoDetectCountryTz` runs BEFORE the dialog's own snapshot, so an
 *     auto-filled country/timezone is already in a DOM baseline and would
 *     compare EQUAL and be dropped — silently un-persisting exactly the accounts
 *     the completion gate exists for. Against the row (null) it differs, and is
 *     sent, as today.
 *   * `_preserveUnlistedOption` (v7.21.11) re-offers a stored out-of-vocabulary
 *     country. Against the row it compares equal and is omitted — strictly safer
 *     than today, which re-sends and re-stores it.
 *   * The body TRIMS most fields while a DOM snapshot stores the raw value, so a
 *     whitespace-only edit would mark the form dirty and send a key that changes
 *     nothing. Comparing the value that will actually be STORED cannot.
 *
 * Per BODY KEY, never per element id: `jobFunction` is derived from TWO inputs
 * (the select plus its "Other…" box), so an element-wise diff would report a
 * free-text role as permanently dirty and miss a real change — the "the change
 * vanishes through a dialog that behaved as though nothing was touched" class
 * this file has already paid for twice.
 */
export const PROFILE_BODY_TO_ROW = {
  firstName: 'first_name', lastName: 'last_name', nickname: 'nickname', email: 'email',
  secondaryEmail: 'secondary_email', company: 'company', title: 'title',
  personalTitle: 'personal_title', phone: 'phone', linkedinUrl: 'linkedin_url',
  country: 'country', timezone: 'timezone', jobFunction: 'job_function', city: 'city',
  certificateGivenName: 'certificate_given_name', certificateFamilyName: 'certificate_family_name',
  avatar: 'avatar',
};

/**
 * @param fields the FULL body the dialog would have sent (still built from the
 *   DOM, because the required-field validation reads it and must keep doing so)
 * @param row    the server row the dialog was rendered from
 * @returns a body carrying only the keys whose stored value would change
 */
export function profileChangedFields(fields, row) {
  const out = {};
  const norm = (v) => (v === undefined || v === null ? '' : String(v).trim());
  for (const [key, col] of Object.entries(PROFILE_BODY_TO_ROW)) {
    const next = fields[key];
    // `undefined` means the dialog never offered the field (the avatar picker
    // with nothing selected), which is not an edit.
    if (next === undefined) continue;
    // The avatar picker seeds `current || 'default1'`, so a participant with no
    // stored avatar holds the string while the row holds null. Normalising both
    // stops every such save re-sending a value nobody chose.
    const before = key === 'avatar' ? norm((row && row[col]) || 'default1') : norm(row && row[col]);
    if (norm(next) !== before) out[key] = next;
  }
  return out;
}

