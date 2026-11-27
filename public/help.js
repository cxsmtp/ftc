// Full-page renderer for /help.html?doc=/docs/user-guide/<role>.md. Mirrors
// the in-app Help drawer's markdown pipeline (features/help-drawer.js _helpRenderMarkdown)
// so the ↗ "open in new tab" link shows a properly rendered page with
// {{platformName}} substituted — instead of the raw markdown the browser
// would show when served straight from /docs/*.md (express.static).
//
// Intentionally standalone (no SPA import) — this page must load instantly
// from a bookmark or a middle-click, without pulling the SPA's module
// graph. Shares only /styles.css and /vendor/marked.min.js with the SPA.
(function () {
  'use strict';

  // --- Trusted Types policies (scoped to this page; mirror public/js/core/trusted-types.js) ---
  // CSP enforces require-trusted-types-for 'script' with `app-html default`
  // allowed. The default policy throws on script sinks (XSS fail-closed);
  // app-html is the named pass-through used by our innerHTML setter.
  let _ttAppPolicy = null;
  if (window.trustedTypes && typeof window.trustedTypes.createPolicy === 'function') {
    try {
      window.trustedTypes.createPolicy('default', {
        createHTML:      (s) => String(s == null ? '' : s),
        createScript:    () => { throw new TypeError('help.js default TT: no createScript'); },
        createScriptURL: () => { throw new TypeError('help.js default TT: no createScriptURL'); },
      });
    } catch (e) { console.warn('Trusted Types: default policy not created', e); }
    try {
      _ttAppPolicy = window.trustedTypes.createPolicy('app-html', {
        createHTML: (s) => String(s == null ? '' : s),
      });
    } catch (e) { console.warn('Trusted Types: app-html policy not created', e); }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function setSafe(el, str) {
    const s = str == null ? '' : String(str);
    el.innerHTML = _ttAppPolicy ? _ttAppPolicy.createHTML(s) : s;
  }

  // Markdown rendering is delegated to the shared renderer (public/
  // help-renderer.js, loaded earlier in help.html via <script>). linkMode
  // 'page' makes internal /docs/*.md links rewrite to /help.html?doc=<path>
  // real anchors so navigation bookmarks and survives middle-click. The
  // local fallback only fires if the shared script failed to load (CSP
  // block / network failure) — it preserves content visibility.
  function renderMarkdown(md, basePath) {
    if (window.HelpRenderer) return window.HelpRenderer.render(md, basePath, { linkMode: 'page' });
    return `<pre style="white-space:pre-wrap">${esc(md)}</pre>`;
  }

  async function loadPlatformName() {
    try {
      const r = await fetch('/api/config');
      const d = await r.json();
      return d.platform_name || 'Tournament';
    } catch (_) { return 'Tournament'; }
  }

  // Validate the ?doc= path against a strict whitelist — only /docs/...md
  // paths with safe characters. Rejects ../ traversal, absolute URLs, etc.
  // v6.8.9: the top-level /docs/README.md role-picker page was removed
  // in this round — fallback is now the participant guide, which is the
  // safest entry point (readable without auth). Admins hitting the page
  // without a ?doc= query still land somewhere valid; the nav strip
  // remains available for them to jump to the admin / superadmin guides.
  function docPathFromQuery() {
    const qs = new URLSearchParams(location.search);
    const d = qs.get('doc') || '';
    if (/^\/docs\/[A-Za-z0-9_./-]+\.md$/.test(d) && !d.includes('..')) return d;
    return '/docs/user-guide/participant.md';
  }

  // Hide nav links that don't apply to the current role (v6.8.9). Rules:
  //   • admin + superadmin session → Admin + Superadmin links visible;
  //     Participant link removed (redundant — admins don't need it).
  //   • anonymous / participant → entire nav removed; participants see
  //     only their own guide (no cross-links to admin/superadmin, which
  //     would 401 anyway).
  async function _filterNavByRole() {
    let isAdminSession = false;
    try { isAdminSession = (await fetch('/api/admin/me')).ok; } catch (e) { console.warn('Help: session check failed; showing the participant guides', e); }
    const nav = document.querySelector('.help-page-nav');
    if (!nav) return;
    if (!isAdminSession) {
      nav.remove();
      return;
    }
    for (const a of nav.querySelectorAll('a')) {
      const href = a.getAttribute('href') || '';
      if (/participant\.md/i.test(href)) a.remove();
    }
  }

  async function main() {
    const body = document.getElementById('help-page-body');
    const titleEl = document.getElementById('help-page-title');
    const path = docPathFromQuery();
    setSafe(body, '<p style="color:var(--muted);padding:40px 0">Loading…</p>');

    // Filter the nav strip by role (v6.8.9). Fire-and-forget — we don't
    // block the main render on the /api/admin/me probe.
    _filterNavByRole();

    const [platformName, fetchResult] = await Promise.all([
      loadPlatformName(),
      fetch(path).then((r) => r.text().then((text) => ({ ok: r.ok, status: r.status, text })))
        .catch((e) => ({ ok: false, status: 0, text: `# Error\n\n${e.message}` })),
    ]);

    // Auth-gated guide fetched without admin session (v6.3.2) — render a
    // signed-out message instead of the raw JSON 401 body. `/api/admin/me`
    // is checked above to hide nav links but a direct URL could still land
    // here.
    let md;
    if (!fetchResult.ok && fetchResult.status === 401) {
      md = `# Sign in required\n\nThis guide is only available to admins.\n\n[Back to app](/) — sign in first, then re-open the Help drawer.`;
    } else if (!fetchResult.ok) {
      md = `# Not found\n\n\`${path}\` returned ${fetchResult.status}.`;
    } else {
      md = fetchResult.text;
    }

    // v6.3.4: HTML-escape platformName before markdown substitution. The
    // value is admin-set via PATCH /api/admin/settings and stored raw —
    // that surface is narrow (only admin/superadmin can write it) but the
    // string flows into a markdown source string that marked.js parses
    // with inline HTML PRESERVED by default. Without escaping, a
    // platform_name like `<img src=x onerror=alert(1)>` would reach
    // innerHTML as live markup. CSP's no-unsafe-inline + img-src 'self'
    // + Trusted Types block the XSS from actually firing, but a platform
    // name is a string identity, not markup — escaping closes the
    // defence-in-depth gap and keeps the SAST clean.
    const filled = md.replace(/\{\{platformName\}\}/g, esc(platformName));
    const html = renderMarkdown(filled, path);
    setSafe(body, html);

    // Take the first H1 as the page title (body) and the window title.
    const h1 = body.querySelector('h1');
    const docTitle = (h1 && h1.textContent.trim()) || 'Help';
    titleEl.textContent = docTitle;
    document.title = `${docTitle} — ${platformName}`;

    // v7.16.2 — honour the #fragment. The document is fetched and rendered
    // AFTER load, so the browser's own hash-scroll has already run against a
    // page that had no headings in it yet; nothing scrolls unless we do it
    // here. Without this, a cross-guide deep link lands at the top of a very
    // long guide, which is what a reader reports as "the link is broken".
    const frag = (location.hash || '').replace(/^#/, '');
    if (frag) {
      let target = null;
      try { target = body.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(decodeURIComponent(frag)) : frag)); }
      catch (_) { target = null; }
      if (target) target.scrollIntoView({ block: 'start' });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
