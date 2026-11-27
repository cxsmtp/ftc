"use strict";

// Trusted-Types policies + the safe-HTML sinks (v7.0.0 ESM split). Imported
// early by core/main.js; the policy install is the ONE deliberate module-load
// side-effect (it must exist before any setSafeHtml call). ESM module caching
// guarantees it runs exactly once per page.

import { esc } from "../ui/format.js";

// Policy handles — module-private. _ttVendorScriptPolicy is exported (live
// binding) for the lazy vendor-script loaders (echarts / QR).
let _ttAppPolicy = null;
let _ttVendorScriptPolicy = null;
const _VENDOR_SCRIPT_ALLOW = ['/vendor/echarts.min.js', '/vendor/qrcode.min.js'];

// Default policy — required because the self-hosted ECharts build writes to
// innerHTML internally. Its createHTML passes EVERY string through, so it admits
// any direct innerHTML write in the page, app code included; createScript /
// createScriptURL THROW so app code that mistakenly sets a <script> src or
// eval()s fails closed.
if (window.trustedTypes && typeof window.trustedTypes.createPolicy === 'function') {
  try {
    window.trustedTypes.createPolicy('default', {
      createHTML:      (s) => String(s == null ? '' : s),
      createScript:    () => { throw new TypeError("Default TT policy rejects createScript — use a dedicated named policy if vendor code legitimately needs it."); },
      createScriptURL: () => { throw new TypeError("Default TT policy rejects createScriptURL — script URLs must be static /vendor/ paths loaded via <script src> in index.html."); },
    });
  } catch (e) { console.warn('Trusted Types: default policy not created', e); }
}
// Named 'app-html' policy — every setSafeHtml() innerHTML write goes through it.
// Also a pass-through: neither policy sanitises, so escaping is the caller's job
// (esc(), the html`` tag below), held by tests/html-sink-escape.spec.js.
if (window.trustedTypes && typeof window.trustedTypes.createPolicy === 'function') {
  try { _ttAppPolicy = window.trustedTypes.createPolicy('app-html', { createHTML: (s) => String(s == null ? '' : s) }); } catch (e) { console.warn('Trusted Types: app-html policy not created', e); }
}
// Named 'vendor-script-src' policy — strict allowlist for the two runtime-loaded
// vendor bundles (echarts for Analytics, the QR generator for self-enrollment).
if (window.trustedTypes && typeof window.trustedTypes.createPolicy === 'function') {
  try {
    _ttVendorScriptPolicy = window.trustedTypes.createPolicy('vendor-script-src', {
      createScriptURL: (url) => {
        if (_VENDOR_SCRIPT_ALLOW.some(p => url === p || url.startsWith(p + '?'))) return url;
        throw new TypeError(`vendor-script-src rejects ${url}`);
      },
    });
  } catch (e) { console.warn('Trusted Types: vendor-script-src policy not created', e); }
}

// raw(s): mark a string as pre-trusted HTML for the html`` tagged template.
export function raw(s) { return { __rawHtml: true, v: s == null ? '' : String(s) }; }

// html``: tagged template that HTML-escapes interpolations (except raw()-wrapped).
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v && typeof v === 'object' && v.__rawHtml) out += v.v;
    else out += esc(v == null ? '' : String(v));
    out += strings[i + 1];
  }
  return out;
}

// setSafeHtml(el, htmlStr): the sole sanctioned innerHTML sink, routed through
// the app-html TT policy. It sanitises nothing: `htmlStr` must already be safe.
export function setSafeHtml(el, htmlStr) {
  const s = htmlStr == null ? '' : htmlStr;
  el.innerHTML = _ttAppPolicy ? _ttAppPolicy.createHTML(String(s)) : s;
}

// setSafeSrcdoc(iframe, htmlStr): a whole document for a frame the caller has
// already marked `sandbox` (no scripts, its own opaque origin), through the same
// policy. Refuses a frame without the attribute rather than loading it unsandboxed.
export function setSafeSrcdoc(iframe, htmlStr) {
  if (!iframe || !iframe.hasAttribute('sandbox')) throw new TypeError('setSafeSrcdoc needs a sandboxed iframe');
  const s = htmlStr == null ? '' : String(htmlStr);
  iframe.srcdoc = _ttAppPolicy ? _ttAppPolicy.createHTML(s) : s;
}

export { _ttVendorScriptPolicy };
