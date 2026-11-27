// Shared markdown renderer for the in-app Help drawer
// (public/js/features/help-drawer.js `_helpRenderMarkdown`) and the full-page viewer (public/help.js
// `renderMarkdown`). Extracted in v6.2.6 because the two surfaces had
// near-identical custom marked renderers that drifted independently across
// marked v15 token-shape changes — a fix to image handling in one would
// not propagate to the other. Both surfaces now call the same code path.
//
// Loaded with a plain <script src> tag in index.html and help.html BEFORE
// the consumer (the SPA's modules / help.js) so window.HelpRenderer is available at
// consumer parse time. Has no module imports — relies on /vendor/marked.min.js
// being already loaded (also via a <script> tag earlier in the HTML).
//
// Public surface:
//   window.HelpRenderer.render(md, basePath, opts)
//     md       — markdown source string
//     basePath — absolute /docs/... path the markdown lives at, used to
//                resolve relative image / link hrefs.
//     opts.linkMode — 'drawer' (internal .md links use data-help-nav
//                attribute for in-place drawer navigation) or 'page'
//                (internal .md links rewrite to /help.html?doc=<path>
//                so they bookmark and survive middle-click).
//   window.HelpRenderer.esc(s)        — HTML-escape helper.
//   window.HelpRenderer.isDocsMd(p)   — predicate: is this a /docs/*.md path?
//   window.HelpRenderer.resolveRel(b,h) — resolve href h relative to base b.
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function resolveRel(base, href) {
    try {
      const u = new URL(href, new URL(base, location.origin));
      // v7.16.2 — keep the #fragment. `.pathname` alone DROPPED it, so a
      // cross-guide deep link such as `admin.md#alerts` resolved to the plain
      // document and landed the reader at the top of a 900-line guide with no
      // hint of where the thing they clicked actually lives.
      return u.pathname + (u.hash || '');
    } catch (_) { return href; }
  }

  function isDocsMd(p) {
    if (typeof p !== 'string') return false;
    const path = p.split('#')[0];   // a fragment must not defeat the .md test
    return path.startsWith('/docs/') && path.endsWith('.md');
  }

  // v7.16.2 — GitHub-style heading slugs. marked v15 emits no `id` on headings
  // (id generation was removed upstream in v5), so every in-document anchor in
  // these guides pointed at nothing: the link resolved, the browser found no
  // target, and the reader silently got the top of the page. Anchors only work
  // if something generates the targets.
  function slugify(text) {
    return String(text).toLowerCase().trim()
      .replace(/<[^>]*>/g, '')          // strip inline markup from the heading
      .replace(/[^\w\s-]/g, '')         // punctuation, quotes, em-dashes
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  // Escaped inner HTML of a link token (marked v15 shape), or the escaped
  // text when no token is available.
  function linkInner(self, tokOrHref, text) {
    if (tokOrHref && typeof tokOrHref === 'object') {
      try {
        if (self && self.parser && self.parser.parseInline && tokOrHref.tokens) {
          return self.parser.parseInline(tokOrHref.tokens);
        }
      } catch (e) {
        console.warn('Help: link text rendered as plain text', e);
      }
      return esc(tokOrHref.text || '');
    }
    return esc(text || '');
  }

  function render(md, basePath, opts) {
    if (!window.marked) {
      // marked failed to load (CSP blocked the vendor script, network
      // failure, etc.). Surface the raw markdown as preformatted text so
      // the content is still reachable instead of vanishing entirely.
      return '<pre style="white-space:pre-wrap">' + esc(md) + '</pre>';
    }
    const linkMode = (opts && opts.linkMode) || 'page';
    const renderer = new window.marked.Renderer();

    renderer.image = function (hrefOrObj, title, text) {
      // marked v15 passes an object { href, title, text } per token; older
      // releases pass positional args. Normalise either shape.
      let href = (hrefOrObj && typeof hrefOrObj === 'object') ? hrefOrObj.href : hrefOrObj;
      title = (hrefOrObj && typeof hrefOrObj === 'object') ? (hrefOrObj.title || '') : (title || '');
      text  = (hrefOrObj && typeof hrefOrObj === 'object') ? (hrefOrObj.text  || '') : (text  || '');
      try { href = resolveRel(basePath, href); } catch (e) { console.warn('Help: link left unresolved', e); }
      const titleAttr = title ? ' title="' + esc(title) + '"' : '';
      // v6.8.2: the server's markdown rewrite appends `?v=<hash>` to the
      // incoming image URL, but the renderer needs to build a SEPARATE
      // URL for the .dark.png variant — and that variant has a different
      // hash. Strip the query from `href`, derive bare URLs for both
      // variants, then ask the asset-hash helper to attach the right
      // hash to each.
      const bareHref = String(href).split('?')[0].split('#')[0];
      const resolveUrl = (u) => (typeof window !== 'undefined' && typeof window.__assetUrlWithVersion === 'function')
        ? window.__assetUrlWithVersion(u) : u;
      const isLight = /\.png$/i.test(bareHref) && !/\.dark\.png$/i.test(bareHref);
      if (isLight) {
        const lightUrl = resolveUrl(bareHref);
        const darkUrl  = resolveUrl(bareHref.replace(/\.png$/i, '.dark.png'));
        const currentTheme = (typeof document !== 'undefined' && document.documentElement && document.documentElement.getAttribute('data-theme')) || 'dark';
        const initialSrc = currentTheme === 'light' ? lightUrl : darkUrl;
        return '<img src="' + esc(initialSrc) + '" data-light-src="' + esc(lightUrl) + '" data-dark-src="' + esc(darkUrl) + '" alt="' + esc(text) + '"' + titleAttr + ' loading="lazy"/>';
      }
      return '<img src="' + esc(resolveUrl(bareHref)) + '" alt="' + esc(text) + '"' + titleAttr + ' loading="lazy"/>';
    };

    // Give every heading an id so in-document and cross-document anchors have
    // something to land on. Duplicate headings get a -2, -3 suffix, matching
    // GitHub, so the first occurrence keeps the clean slug.
    const _seenSlugs = Object.create(null);
    renderer.heading = function (textOrObj, level) {
      let text = (textOrObj && typeof textOrObj === 'object') ? (textOrObj.text || '') : (textOrObj || '');
      let depth = (textOrObj && typeof textOrObj === 'object') ? textOrObj.depth : level;
      // marked v15 hands the renderer a token; render its inline content so
      // formatting inside a heading survives.
      let inner = esc(text);
      try {
        if (textOrObj && typeof textOrObj === 'object' && this.parser && this.parser.parseInline) {
          inner = this.parser.parseInline(textOrObj.tokens || []);
        }
      } catch (_) { inner = esc(text); }
      let slug = slugify(text);
      if (!slug) slug = 'section';
      if (_seenSlugs[slug]) { _seenSlugs[slug]++; slug = slug + '-' + _seenSlugs[slug]; }
      else { _seenSlugs[slug] = 1; }
      return '<h' + depth + ' id="' + esc(slug) + '">' + inner + '</h' + depth + '>';
    };

    renderer.link = function (hrefOrObj, title, text) {
      let href = (hrefOrObj && typeof hrefOrObj === 'object') ? hrefOrObj.href : hrefOrObj;
      title = (hrefOrObj && typeof hrefOrObj === 'object') ? (hrefOrObj.title || '') : (title || '');
      // The link's visible text is rendered from its inline tokens, which
      // marked escapes token by token (raw HTML tokens go through
      // renderer.html below). The raw `.text` field is the unescaped source,
      // so it is never written into the markup as is.
      text = linkInner(this, hrefOrObj, text);
      const resolved = resolveRel(basePath, href);
      const titleAttr = title ? ' title="' + esc(title) + '"' : '';
      if (isDocsMd(resolved)) {
        if (linkMode === 'drawer') {
          // Drawer mode: intercept via a delegated click handler on the
          // help-drawer-body that reads data-help-nav and re-renders without
          // navigating away from the SPA.
          // Split the fragment out: the drawer needs the document to fetch and
          // the anchor to scroll to as two separate values.
          const dPath = resolved.split('#')[0];
          const dFrag = resolved.indexOf('#') >= 0 ? resolved.slice(resolved.indexOf('#') + 1) : '';
          return '<a href="#" data-help-nav="' + esc(dPath) + '"' +
                 (dFrag ? ' data-help-frag="' + esc(dFrag) + '"' : '') +
                 titleAttr + '>' + text + '</a>';
        }
        // Page mode: real anchor — bookmarkable, back/forward works,
        // middle-click opens in a new tab.
        // The fragment must stay OUTSIDE the query parameter. Encoding the whole
        // string turned `admin.md#alerts` into `?doc=admin.md%23alerts`, which
        // is a document whose name happens to contain a hash — the browser had
        // no anchor to scroll to and the reader landed at the top.
        const pPath = resolved.split('#')[0];
        const pFrag = resolved.indexOf('#') >= 0 ? resolved.slice(resolved.indexOf('#') + 1) : '';
        return '<a href="/help.html?doc=' + encodeURIComponent(pPath) +
               (pFrag ? '#' + encodeURIComponent(pFrag) : '') + '"' + titleAttr + '>' + text + '</a>';
      }
      // External or non-.md link — open in a new tab with rel for safety.
      // v6.20.x — scheme allowlist: only http(s), protocol-relative, root-
      // relative, or in-page anchors may reach the href. Anything else (e.g.
      // a `javascript:` or `data:` URL from a markdown source) collapses to
      // "#". Mirrors the server's _transformAnchor policy. Docs are operator-
      // authored and the CSP blocks javascript: navigation, but this removes
      // the sole reliance on CSP and matches the rest of the codebase.
      const safeHref = /^(https?:\/\/|\/\/|\/|#)/i.test(resolved) ? resolved : '#';
      return '<a href="' + esc(safeHref) + '" target="_blank" rel="noopener noreferrer"' + titleAttr + '>' + text + '</a>';
    };

    // Raw HTML in a guide is shown as text, never parsed as markup: the guides
    // contain no intended HTML, and something like `*<name>*` used to vanish
    // as an unknown element. This makes the renderer's output safe whatever
    // the markdown holds, rather than relying on the docs being first-party.
    renderer.html = function (tokOrText) {
      const t = (tokOrText && typeof tokOrText === 'object') ? (tokOrText.text || tokOrText.raw || '') : (tokOrText || '');
      return esc(t);
    };
    // And plain text is always escaped. After a raw-block tag (<pre>, <code>,
    // <kbd>, <script>) the lexer marks the following text as already escaped,
    // and marked's own text renderer then writes it raw — so a tag after an
    // inline `<code>` would have been live markup despite the rule above. An
    // entity already in the text (`&amp;`) is kept, as marked keeps it.
    renderer.text = function (tok) {
      if (tok && typeof tok === 'object' && tok.tokens && this && this.parser) return this.parser.parseInline(tok.tokens);
      const t = (tok && typeof tok === 'object') ? (tok.text || '') : (tok || '');
      return String(t).replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));
    };

    window.marked.setOptions({ renderer: renderer, gfm: true, breaks: false });
    return window.marked.parse(md);
  }

  window.HelpRenderer = {
    render: render,
    esc: esc,
    isDocsMd: isDocsMd,
    resolveRel: resolveRel,
  };

  // Theme-aware screenshots (v6.8.1). The renderer emits `data-light-src`
  // + `data-dark-src` on every screenshot; this observer watches the
  // html[data-theme] attribute and swaps `src` whenever the theme flips
  // so documentation images track the user's manual light/dark choice
  // (not only the OS preference). Also a one-time pass at DOM-ready
  // catches any images rendered before the observer was attached.
  function _applyThemeToDocImages() {
    if (typeof document === 'undefined') return;
    const theme = document.documentElement.getAttribute('data-theme') || 'dark';
    const attr = theme === 'light' ? 'data-light-src' : 'data-dark-src';
    document.querySelectorAll('img[data-light-src][data-dark-src]').forEach((img) => {
      const next = img.getAttribute(attr);
      if (next && img.getAttribute('src') !== next) img.setAttribute('src', next);
    });
  }
  if (typeof document !== 'undefined') {
    try {
      new MutationObserver(_applyThemeToDocImages).observe(
        document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }
      );
    } catch (_) { /* IE11-era browsers: graceful degradation */ }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _applyThemeToDocImages);
    } else {
      _applyThemeToDocImages();
    }
  }
})();
