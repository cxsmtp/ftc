"use strict";

import { html, setSafeHtml } from "../core/trusted-types.js";
import { esc } from "./format.js";
import { CODE_LANGUAGES, EDITOR_FONTS, EDITOR_SIZES, ICO } from "./icons.js";
import { applyDialogAria, overlayDismiss } from "./modal.js";

// v7.18.0 — the tag allowlist, in ONE place on the client.
//
// There are four allowlists in this system and they must agree: this one
// (render), the paste normaliser below, the per-tag STYLE rules a paste keeps
// (RICH_STYLE_RULES, below), and `_RICH_TEXT_OPTS` in lib/sanitise.js (the
// server, which is the enforcement point). A tag the server stores but the
// renderer drops renders as flattened text; a tag, property or value the paste
// normaliser keeps but the server strips vanishes on save. Both failures look
// like "tables don't work" (or "my formatting changed when I saved") and neither
// raises an error, so the client lists are shared here and CI locks pin them
// against the server's.
export const RICH_BASE_TAGS = ['a','b','i','u','s','strong','em','span','del','strike','br','div','p','ol','ul','li','img','code','pre','font'];
export const RICH_TABLE_TAGS = ['table','thead','tbody','tfoot','tr','th','td','caption'];
const _RICH_SECTION_TAGS = new Set(['thead','tbody','tfoot']);

// THE COLOURS ARE NAMES. A pick from the Text colour or Highlight menu stores a
// colour NAME as the custom property that draws it, `color:var(--rt-red)` or
// `background-color:var(--rt-hl-yellow)`, never a hex: a literal colour reads in one
// mode at most (white vanishes by day, black at night), while each look x mode gives
// every name its own measured ink and tint (generated from scripts/theme/looks.js).
// An inline var(), not a class or data attribute: the browser's own editing (joining
// two lines, a paste at a line's end) re-serialises what it moves with its computed
// colour inlined and its attributes dropped, which would turn a name drawn by a
// stylesheet rule into the look's literal ink; an inline var() it keeps as written.
// Mirrored by RICH_COLOURS in lib/sanitise.js, which admits no other var(); a CI lock
// pins the two and the palette data. Colours stored as literals before stay as stored.
export const RICH_COLOURS = ['grey','red','orange','yellow','green','cyan','blue','violet','pink'];
const _RICH_COLOUR_SET = new Set(RICH_COLOURS);
// THE HUE EACH NAME STANDS FOR (OKLCH degrees), which a pasted literal colour is
// matched against (`_rtNearestName`). ONE fixed table, never read from the look's
// own inks: the inks differ by mode (the night orange is 53°, the day one 48°), so
// a table read from them stored one pasted colour (#ffa500, the keyword `orange`)
// as yellow by day and orange at night. The anchors put each boundary (the midpoint
// of two neighbours) between the hues it must part: every look x mode's ink and tint
// of a name (scripts/theme/looks.js rtInk, rtHighlight) and a plain CSS keyword of
// it (red, orange, yellow, green, cyan, blue, blueviolet, purple, hotpink) fall nearest
// their own anchor (lock for the inks and keywords: tests/richtext-colours.spec.js).
// Grey has no hue: it is the neutrals' name, never a hue's. A new name or a moved
// ink re-checks this table.
export const RICH_COLOUR_HUES = Object.freeze({ red: 26, orange: 58, yellow: 100, green: 150, cyan: 210, blue: 260, violet: 318, pink: 352 });

// WHAT A PASTE KEEPS ON EACH TAG: exactly the server's own style rule for that tag
// (lib/sanitise.js `_RICH_TEXT_OPTS.allowedStyles`), property by property and value
// pattern by value pattern, so what a paste shows is what Save stores. A tag with no
// entry keeps no style at all (p, div and li: the server gives them none). The image
// rule is left out (the server writes every image's style itself, and a paste keeps
// none), as is the server's empty "*" rule. The patterns are copies, as browser
// modules cannot import lib/, so a CI lock compares the two tables by value
// (tests/richtext-tables.spec.js): change both together.
const _RT_LITERAL_COLOUR=/^(?![\s\S]*var\()[#\w][\w(),.\s%-]*$/i;      // lib/sanitise.js _LITERAL_COLOUR
const _RT_INK=[_RT_LITERAL_COLOUR,new RegExp(`^var\\(--rt-(?:${RICH_COLOURS.join('|')})\\)$`)];
const _RT_TINT=[_RT_LITERAL_COLOUR,new RegExp(`^var\\(--rt-hl-(?:${RICH_COLOURS.join('|')})\\)$`)];
const _RT_ALIGN=[/^(left|right|center|justify)$/i], _RT_VALIGN=[/^(top|middle|bottom|baseline)$/i], _RT_PCT=[/^\d{1,3}%$/];
const _RT_CELL={'text-align':_RT_ALIGN,'vertical-align':_RT_VALIGN,'background-color':_RT_TINT,color:_RT_INK,width:_RT_PCT};
const _RT_SECTION={'background-color':_RT_TINT,'text-align':_RT_ALIGN,'vertical-align':_RT_VALIGN};
export const RICH_STYLE_RULES={
  span:{color:_RT_INK,'background-color':_RT_TINT,'font-family':[/^["']?[a-zA-Z0-9 ,-]+["']?$/],'font-size':[/^\d+(\.\d+)?(px|rem|em|%)$/i]},
  table:{width:_RT_PCT,'background-color':_RT_TINT},
  td:_RT_CELL, th:_RT_CELL, tr:{'background-color':_RT_TINT},
  thead:_RT_SECTION, tbody:_RT_SECTION, tfoot:_RT_SECTION,
  caption:{'text-align':[/^(left|right|center)$/i]},
};
// A table SECTION (thead, tbody, tfoot) keeps only these style properties, its rule
// above. The server stored a section's style unfiltered until it had that rule, so
// the renderer keeps no other property on one either (`_rtSectionStyle`): a stored
// `position:fixed` would lay the section over the page, and a page token
// (`var(--bg)`) would draw in whatever colour the page has.
export const RICH_SECTION_STYLES = Object.keys(_RT_SECTION);
// Each kind's style property, and the prefix of its names' custom properties.
const _RT_PROP = { color: 'color', highlight: 'background-color' };
const _RT_VAR = { color: '--rt-', highlight: '--rt-hl-' };
export function richColourLabel(name){ return name.charAt(0).toUpperCase() + name.slice(1); }

export function highlightCodeElement(el){
  if(!window.hljs||!el)return;
  if(el.hasAttribute('data-highlighted'))return; // idempotency — hljs sets this marker
  const text=el.textContent||'';
  const lang=(el.className.match(/language-(\w+)/)||[])[1];
  let html;
  try{
    if(lang&&hljs.getLanguage&&hljs.getLanguage(lang)){
      html=hljs.highlight(text,{language:lang,ignoreIllegals:true}).value;
    }else if(hljs.highlightAuto){
      html=hljs.highlightAuto(text).value;
    }
  }catch(_){return;}
  if(typeof html!=='string')return;
  setSafeHtml(el,html);
  el.classList.add('hljs');
  el.setAttribute('data-highlighted','yes');
}

export function renderRich(s){
  if(!s)return'';
  if(!/</.test(s))return esc(s);
  const ALLOWED=new Set([...RICH_BASE_TAGS,...RICH_TABLE_TAGS]);
  const ATTR_OK={a:new Set(['href','target','rel']),img:new Set(['src','alt','width','height']),span:new Set(['style']),font:new Set(['color','size']),code:new Set(['class']),
    table:new Set(['style']),thead:new Set(['style']),tbody:new Set(['style']),tfoot:new Set(['style']),tr:new Set(['style']),caption:new Set(['style']),
    td:new Set(['colspan','rowspan','style']),th:new Set(['colspan','rowspan','style','scope'])};
  const SAFE_PROTO=/^(?:https?:|data:image\/|\/api\/images\/)/i;
  // Parsed in an INERT document, as normalisePastedHtml does: a <div> of the live
  // page starts fetching every <img src> it is given before the walk below has
  // removed a single attribute, so a stored description could beacon out.
  const d=document.implementation.createHTMLDocument('rich').createElement('div');setSafeHtml(d, s);
  (function walk(parent){
    for(const n of[...parent.childNodes]){
      if(n.nodeType===3)continue;
      if(n.nodeType!==1){n.remove();continue;}
      const tag=n.tagName.toLowerCase();
      if(!ALLOWED.has(tag)){const t=document.createTextNode(n.textContent);parent.replaceChild(t,n);continue;}
      const ok=ATTR_OK[tag]||new Set();
      for(const a of[...n.attributes])if(!ok.has(a.name.toLowerCase())||/^on/i.test(a.name))n.removeAttribute(a.name);
      if(_RICH_SECTION_TAGS.has(tag)&&n.hasAttribute('style'))_rtSectionStyle(n);
      if(tag==='a'&&n.hasAttribute('href')){if(!SAFE_PROTO.test(n.getAttribute('href')))n.removeAttribute('href');n.setAttribute('target','_blank');n.setAttribute('rel','noopener noreferrer');}
      if(tag==='img'&&n.hasAttribute('src')&&!SAFE_PROTO.test(n.getAttribute('src')))n.removeAttribute('src');
      // v6.8.4: always emit an `alt` attribute on rendered images so axe /
      // screen readers don't flag them as missing a text alternative. When
      // the author didn't provide one, default to alt="" (decorative — the
      // correct WAI-ARIA pattern for images with no descriptive text).
      if(tag==='img'&&!n.hasAttribute('alt'))n.setAttribute('alt','');
      walk(n);
    }
  })(d);
  return d.innerHTML;
}


// ── v7.18.0 — paste normalisation ───────────────────────────────────────────
//
// Pasting from Word (and from Google Docs, Excel, and most CMS pages) puts a
// `text/html` flavour on the clipboard that a contentEditable will happily
// accept verbatim. Word's is the hostile one: `class="MsoNormalTable"`,
// `mso-*` style properties, `<o:p>` and `<w:*>` namespaced elements,
// `<!--[if gte mso 9]>` conditional comments, absolute pixel widths sized for
// A4, and colours expressed as `windowtext`.
//
// Without this, the browser inserts all of it, the editor looks broken, and the
// server sanitiser then strips most of it on save — so the author sees one
// thing while typing and a different thing after saving. Normalising at the
// paste boundary makes the editor show what will actually be stored.
//
// This is a UX normaliser, NOT the security boundary. lib/sanitise.js is the
// security boundary and runs on every save regardless of how the HTML arrived.
const _MSO_STYLE_PROP = /^(mso-|panose|tab-stops|text-underline|font-variant$)/i;

// "r,g,b" of an opaque hex or rgb() colour, else null.
function _rtRgbOf(v){
  let m=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if(m){const h=m[1].length===3?[...m[1]].map(c=>c+c).join(''):m[1];return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16)).join(',');}
  m=/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*1(?:\.0*)?\s*)?\)$/i.exec(v);
  return m?[m[1],m[2],m[3]].map(Number).join(','):null;
}
// The name whose ink (or tint) THIS look and mode draws in exactly the literal colour
// `v`, else null. A copy or a drag inside the editor carries COMPUTED colours (the
// browser serialises what it draws), so this is how a name it moved is recognised.
function _rtNameOfShade(kind,v){
  const rgb=_rtRgbOf(String(v).trim());
  if(!rgb)return null;
  const cs=getComputedStyle(document.documentElement);
  for(const name of RICH_COLOURS)if(_rtRgbOf(cs.getPropertyValue(_RT_VAR[kind]+name).trim())===rgb)return name;
  return null;
}
// A PASTED LITERAL BECOMES THE NEAREST NAME, or no colour. A colour pasted from Word
// or a web page was chosen for one surface (Word's dark red on white, a page's
// white on its own dark banner) and falls below AA on the other mode's, while a
// name is drawn in each look x mode's own measured ink and tint. The metric is
// OKLCH (perceptual lightness L 0-1, chroma C, hue h), of the colour as the browser
// reads it (hex, rgb(), hsl(), a keyword):
//   * C < 0.04 is a neutral: L < 0.3 (black, near-black) and L > 0.9 (white,
//     near-white) are dropped, so the text follows the theme's own ink and a
//     highlight the surface; a neutral in between becomes grey. Below L 0.3 a
//     faint tint (C < 0.08: a night page's own surface, as a copy carries it)
//     counts as near-black too;
//   * any other colour takes the name whose anchor hue (RICH_COLOUR_HUES, one
//     fixed table: the same name by day and at night, in every look) is nearest
//     (circular distance); grey has no hue and is not a choice.
//     OKLCH, not HSL: HSL puts pure blue (#0000ff) as near violet as blue.
// Nearly transparent (alpha < 0.1) is dropped; a value the browser cannot read is
// dropped. lib/sanitise.js stays the boundary: it still admits an older literal.
const _RT_NEUTRAL_C=0.04, _RT_DARK_NEUTRAL_C=0.08, _RT_DARK_L=0.3, _RT_LIGHT_L=0.9;
let _rtCtx=null;
// [r,g,b,a] (0-255, a 0-1) of any CSS colour the browser reads, else null.
function _rtParseColour(v){
  if(!_rtCtx){try{_rtCtx=document.createElement('canvas').getContext('2d');}catch(_){_rtCtx=null;}}
  if(!_rtCtx)return null;
  // Two different sentinels: a value the canvas refuses leaves either unchanged.
  const read=(sentinel)=>{_rtCtx.fillStyle=sentinel;_rtCtx.fillStyle=v;return String(_rtCtx.fillStyle);};
  const a=read('#010203'),b=read('#040506');
  if(a!==b)return null;
  let m=/^#([0-9a-f]{6})$/i.exec(a);
  if(m)return [0,2,4].map(i=>parseInt(m[1].slice(i,i+2),16)).concat(1);
  m=/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(a);
  return m?[+m[1],+m[2],+m[3],m[4]===undefined?1:+m[4]]:null;
}
// [L, C, h] (OKLCH) of an sRGB colour (0-255).
function _rtOklch(r,g,b){
  const lin=(c)=>{c/=255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;};
  const R=lin(r),G=lin(g),B=lin(b);
  const l=Math.cbrt(0.4122214708*R+0.5363325363*G+0.0514459929*B);
  const m=Math.cbrt(0.2119034982*R+0.6806995451*G+0.1073969566*B);
  const s=Math.cbrt(0.0883024619*R+0.2817188376*G+0.6299787005*B);
  const L=0.2104542553*l+0.7936177850*m-0.0040720468*s;
  const A=1.9779984951*l-2.4285922050*m+0.4505937099*s;
  const Bb=0.0259040371*l+0.7827717662*m-0.8086757660*s;
  return [L,Math.hypot(A,Bb),(Math.atan2(Bb,A)*180/Math.PI+360)%360];
}
/** The name a pasted literal colour is nearest to, or '' (drop it). */
function _rtNearestName(v){
  const c=_rtParseColour(v);
  if(!c||c[3]<0.1)return '';
  const [L,C,hue]=_rtOklch(c[0],c[1],c[2]);
  if(L<_RT_DARK_L&&C<_RT_DARK_NEUTRAL_C)return '';
  if(C<_RT_NEUTRAL_C)return L>_RT_LIGHT_L?'':'grey';
  let best='',bestD=Infinity;
  for(const [name,h] of Object.entries(RICH_COLOUR_HUES)){
    const d=Math.min(Math.abs(h-hue),360-Math.abs(h-hue));
    if(d<bestD){bestD=d;best=name;}
  }
  return best;
}
/**
 * A pasted colour as a name, or none: a listed name's own var() is kept; this
 * look's exact ink or tint of a name (what a copy inside the editor carries)
 * becomes that name; any other literal becomes the nearest name or is dropped
 * (`_rtNearestName`); any other var() is dropped (the server refuses it).
 */
function _pastedColour(kind,val){
  const v=val.trim(),want=_RT_VAR[kind];
  if(/var\(/i.test(v)){
    const name=_rtVarName(kind,v);
    return name?`var(${want}${name})`:null;
  }
  const name=_rtNameOfShade(kind,v)||_rtNearestName(v);
  return name?`var(${want}${name})`:null;
}
// The listed name whose own var() for `kind` the value `v` is exactly (spaces aside),
// else '': `var(--rt-red)` is red's ink, never a tint, and nothing else is a name.
function _rtVarName(kind,v){
  const want=_RT_VAR[kind];
  const m=/^var\((--rt-(?:hl-)?[a-z]+)\)$/.exec(String(v).replace(/\s+/g,''));
  const name=m&&m[1].startsWith(want)?m[1].slice(want.length):'';
  return _RICH_COLOUR_SET.has(name)?name:'';
}
// A table section's style as the server keeps one (RICH_SECTION_STYLES): read through
// the CSS parser, so a value cannot smuggle a second declaration past a split; a tint
// is a literal or exactly a listed name's own var(), and no other value may hold one.
function _rtSectionStyle(el){
  const keep=[];
  for(const prop of RICH_SECTION_STYLES){
    let v=el.style.getPropertyValue(prop).trim();
    if(!v)continue;
    if(/var\(/i.test(v)){
      const name=prop==='background-color'?_rtVarName('highlight',v):'';
      if(!name)continue;
      v=`var(${_RT_VAR.highlight}${name})`;
    }
    keep.push(`${prop}:${v}`);
  }
  if(keep.length)el.setAttribute('style',keep.join(';'));
  else el.removeAttribute('style');
}
// After a drop: every inline colour in the editor that is exactly this look's ink
// or tint of a name becomes that name again.
function _rtRestoreNames(root){
  for(const el of root.querySelectorAll('[style]')){
    for(const kind of Object.keys(_RT_PROP)){
      const prop=_RT_PROP[kind],v=el.style.getPropertyValue(prop);
      if(!v||/^var\(/i.test(v))continue;
      const name=_rtNameOfShade(kind,v);
      if(name)el.style.setProperty(prop,`var(${_RT_VAR[kind]}${name})`);
    }
  }
}

/**
 * Keep exactly the declarations the server's rule for this tag (`rules`, from
 * RICH_STYLE_RULES) keeps, so WYSIWYG holds. Read as written, as the server reads
 * them (postcss, through sanitize-html): comments dropped, a `;` inside quotes is no
 * separator, and a property name is matched exactly (the server's match is
 * case-sensitive, so `COLOR:` is dropped on both sides). Never through the CSS
 * parser, which expands shorthands: Word's `background:white` would come out as a
 * background-color the server never sees. Written in the server's own shape,
 * `prop:value;prop:value`.
 */
function _cleanStyle(el,rules){
  const raw=(el.getAttribute('style')||'').replace(/\/\*[\s\S]*?\*\//g,'');
  const keep=[];
  for(const decl of raw.split(/;(?=(?:[^"']|"[^"]*"|'[^']*')*$)/)){
    const i=decl.indexOf(':');
    if(i<0)continue;
    const prop=decl.slice(0,i).trim();
    let val=decl.slice(i+1).trim().replace(/\s*!important$/i,'');
    if(!prop||!val)continue;
    if(_MSO_STYLE_PROP.test(prop)||!Object.hasOwn(rules,prop))continue;
    // Word writes `color:windowtext` and `background:white` — neither means
    // anything outside Word, and windowtext on our dark theme is invisible. With
    // the colour mapping below (_pastedColour), the paste's narrowings beyond the
    // server's rule.
    if(/^(windowtext|auto|inherit|initial|unset|revert|transparent|currentcolor)$/i.test(val))continue;
    if(prop==='color'||prop==='background-color'){val=_pastedColour(prop==='color'?'color':'highlight',val);if(!val)continue;}
    if(!rules[prop].some(re=>re.test(val)))continue;
    keep.push(`${prop}:${val}`);
  }
  if(keep.length)el.setAttribute('style',keep.join(';'));
  else el.removeAttribute('style');
}

// Emphasis a pasted element declares through its style, read through the CSS parser
// (a weight, a style, a decoration line): which of b, i, u and s it means.
function _pastedEmphasis(el){
  const st=el.style,w=st.fontWeight,n=parseInt(w,10);
  const line=st.textDecorationLine||'';
  return {
    bold:w==='bold'||w==='bolder'||(n>=600),
    notBold:w==='normal'||w==='lighter'||(n>0&&n<600),
    italic:st.fontStyle==='italic'||/^oblique/.test(st.fontStyle),
    notItalic:st.fontStyle==='normal',
    underline:/\bunderline\b/.test(line),
    strike:/\bline-through\b/.test(line),
  };
}

/**
 * Turn arbitrary clipboard HTML into the subset this editor stores.
 * Exported for the unit lock — it is pure DOM-in/string-out.
 */
export function normalisePastedHtml(html){
  if(!html)return '';
  // Strip Word's conditional comments and the XML island BEFORE parsing: they
  // are comments to an HTML parser, so they survive a node walk untouched.
  let src=String(html)
    .replace(/<!--[\s\S]*?-->/g,'')
    .replace(/<\?xml[\s\S]*?\?>/gi,'')
    .replace(/<\/?(?:o|w|m|v|st1|x):[^>]*>/gi,'');
  const doc=document.implementation.createHTMLDocument('paste');
  setSafeHtml(doc.body,src);       // inert document: no scripts run, no loads
  const ALLOWED=new Set([...RICH_BASE_TAGS,...RICH_TABLE_TAGS]);
  // `style` is kept exactly on the tags RICH_STYLE_RULES has a rule for, never here.
  const ATTR_OK={
    a:new Set(['href']),img:new Set(['src','alt']),code:new Set(['class']),
    td:new Set(['colspan','rowspan']),th:new Set(['colspan','rowspan','scope']),
  };
  const unwrap=(n,parent)=>{walk(n);while(n.firstChild)parent.insertBefore(n.firstChild,n);n.remove();};
  function walk(parent){
    for(const n of[...parent.childNodes]){
      if(n.nodeType===8){n.remove();continue;}              // comment
      if(n.nodeType===3)continue;                            // text
      if(n.nodeType!==1){n.remove();continue;}
      const tag=n.tagName.toLowerCase();
      if(tag==='script'||tag==='style'||tag==='meta'||tag==='link'||tag==='title'){n.remove();continue;}
      // Unwrap rather than delete: a <section>/<h2>/<font> wrapper carries the
      // author's actual text, and dropping the subtree would silently lose it.
      if(!ALLOWED.has(tag)){unwrap(n,parent);continue;}
      // Emphasis declared as a style, read before the style goes. Google Docs wraps
      // every copied fragment in <b style="font-weight:normal" id="docs-internal-guid-…">:
      // the server keeps the <b> and drops its style, so the whole paste was STORED
      // bold. A b or strong that says it is not bold (an i or em that says it is not
      // italic) is unwrapped. On a span, bold, italics, underline and strikethrough
      // become b, i, u and s, which the server stores (it keeps none of those
      // properties on a span); on a block they are dropped, as the save drops them.
      const em=n.hasAttribute('style')&&n.style?_pastedEmphasis(n):null;
      if(em&&(((tag==='b'||tag==='strong')&&em.notBold)||((tag==='i'||tag==='em')&&em.notItalic))){unwrap(n,parent);continue;}
      const ok=ATTR_OK[tag];
      const styled=Object.hasOwn(RICH_STYLE_RULES,tag);
      for(const a of[...n.attributes]){
        const name=a.name.toLowerCase();
        if(/^on/i.test(name)||!((ok&&ok.has(name))||(name==='style'&&styled)))n.removeAttribute(a.name);
      }
      if(n.hasAttribute('style'))_cleanStyle(n,RICH_STYLE_RULES[tag]);
      if(tag==='a'){
        const href=n.getAttribute('href')||'';
        if(!/^https?:\/\//i.test(href))n.removeAttribute('href');
      }
      if(tag==='img'){
        const src=n.getAttribute('src')||'';
        // Word puts `file:///C:/…` and `cid:` sources on the clipboard; neither
        // resolves for anyone else, so drop the element rather than ship a
        // broken image into the challenge.
        if(!/^(https?:|data:image\/|\/api\/images\/)/i.test(src)){n.remove();continue;}
      }
      walk(n);
      if(tag==='span'&&em){
        // Nested b > i > u > s inside the span, which keeps its colour and size.
        let inner=n;
        for(const [on,t] of [[em.bold,'b'],[em.italic,'i'],[em.underline,'u'],[em.strike,'s']]){
          if(!on)continue;
          const w=doc.createElement(t);
          while(inner.firstChild)w.appendChild(inner.firstChild);
          inner.appendChild(w);inner=w;
        }
      }
    }
  }
  walk(doc.body);
  return doc.body.innerHTML;
}

// Inert document for the same reason as renderRich: only the text is wanted.
export function stripHtml(s){if(!s)return'';const t=document.implementation.createHTMLDocument('strip').createElement('div');setSafeHtml(t, s);return t.textContent||'';}

export function createRichEditor(el,placeholder,minH){
  el.classList.add('rich-editor');
  const bar=document.createElement('div');bar.className='rich-toolbar';
  function tb(html,title,fn){const b=document.createElement('button');b.type='button';setSafeHtml(b, html);b.title=title;
    // v6.20.x — a11y: was onmousedown-only, so the toolbar was entirely
    // keyboard-inoperable (Enter/Space don't fire mousedown). Keep mousedown
    // (its preventDefault preserves the contentEditable selection for the
    // pointer path) AND handle keyboard: Enter/Space re-focus the editor so
    // execCommand applies to its selection, then run the command. aria-label
    // names these icon/glyph-only buttons for screen readers.
    b.setAttribute('aria-label',title);
    // A switched-off button (setReadOnly) runs nothing, however the press reaches it.
    b.onmousedown=e=>{e.preventDefault();if(b.disabled)return;fn();};
    b.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();if(b.disabled)return;el.focus();fn();}};
    return b;}
  function sep(){const s=document.createElement('span');s.className='tb-sep';return s;}
  // THE GLYPHS ARE ICONS, SO THEY ARE NOT DOM TEXT. "B", "ab", "TT", "1." are
  // symbols for a command, not labels for it (WCAG 2.5.3's "symbolic text
  // characters"); the button's one name is its aria-label. Written as text, they
  // were the button's visible text, and axe's label-content-name-mismatch (4.14)
  // then demanded "ab" inside "Highlight". `.rt-glyph` paints `data-glyph` with
  // `::before`, so the look is unchanged and no text node is left to compare.
  // Every glyph on the bar goes through this — a B left as text would pass today
  // only because the checker skips single characters.
  const g=(glyph,{tag='span',style=''}={})=>`<${tag} class="rt-glyph" data-glyph="${glyph}"${style?` style="${style}"`:''}></${tag}>`;
  bar.appendChild(tb(g('B',{tag:'b'}),'Bold',()=>document.execCommand('bold')));
  bar.appendChild(tb(g('I',{tag:'i'}),'Italic',()=>document.execCommand('italic')));
  bar.appendChild(tb(g('U',{tag:'u'}),'Underline',()=>document.execCommand('underline')));
  bar.appendChild(sep());
  // v8.17.0 — the rarely used commands (strikethrough, colours, font, size,
  // clear formatting) live in a "More" group, shown in place in the same bar,
  // so the bar is one short row. Every command is still here; none moved menu.
  const more=document.createElement('div');more.className='rt-more';more.hidden=true;
  more.id=`rt-more-${++_rtMoreSeq}`;
  more.appendChild(tb(g('S',{tag:'s'}),'Strikethrough',()=>document.execCommand('strikethrough')));
  const fgW=document.createElement('div');fgW.style.position='relative';
  fgW.appendChild(tb(g('A',{style:'font-weight:var(--fw-semibold);border-bottom:2px solid var(--red)'}),'Text Color',
    ()=>toggleColorPop(fgW,'color')));
  more.appendChild(fgW);
  const bgW=document.createElement('div');bgW.style.position='relative';
  bgW.appendChild(tb(g('ab',{style:'background:var(--yellow);color:var(--on-status);padding:0 3px;border-radius:var(--radius-sm);font-size:var(--fs-12);font-weight:var(--fw-semibold)'}),'Highlight',
    ()=>toggleColorPop(bgW,'highlight')));
  more.appendChild(bgW);
  // Font family dropdown
  const fontW=document.createElement('div');fontW.style.position='relative';
  fontW.appendChild(tb(g('Aa',{style:'font-size:var(--fs-12);font-weight:var(--fw-semibold)'}),'Font',()=>toggleDropPop(fontW,'font')));
  more.appendChild(fontW);
  // Font size dropdown
  const sizeW=document.createElement('div');sizeW.style.position='relative';
  sizeW.appendChild(tb(`<span style="font-size:var(--fs-12);font-weight:var(--fw-semibold)">${g('T')}${g('T',{tag:'sub',style:'font-size:var(--fs-12)'})}</span>`,'Font Size',()=>toggleDropPop(sizeW,'size')));
  more.appendChild(sizeW);
  more.appendChild(tb(g('&#8856;'),'Clear Formatting',()=>document.execCommand('removeFormat')));
  bar.appendChild(tb(g('1.',{style:'font-size:var(--fs-12);font-weight:var(--fw-semibold)'}),'Numbered List',()=>document.execCommand('insertOrderedList')));
  bar.appendChild(tb(g('&bull;',{style:'font-size:var(--fs-14);line-height:1'}),'Bullet List',()=>document.execCommand('insertUnorderedList')));
  bar.appendChild(sep());
  bar.appendChild(tb(`<span style="color:var(--accent2);display:inline-flex">${ICO.link}</span>`,'Insert Link',()=>insertLink(body)));
  bar.appendChild(sep());
  bar.appendChild(tb(g('&lt;&gt;',{style:'font-size:var(--fs-12);font-family:var(--font-mono);font-variant-ligatures:none;font-weight:var(--fw-semibold)'}),'Inline Code',()=>toggleInlineCode(body)));
  bar.appendChild(tb(g('[/]',{style:'font-size:var(--fs-12);font-family:var(--font-mono);font-variant-ligatures:none;font-weight:var(--fw-semibold)'}),'Code Block',()=>toggleCodeBlock(body)));
  bar.appendChild(sep());
  const tblW=document.createElement('div');tblW.style.position='relative';tblW.className='rt-table-wrap';
  tblW.appendChild(tb(`<span style="display:inline-flex">${ICO.table}</span>`,'Table',()=>toggleTablePop(tblW,body)));
  bar.appendChild(tblW);
  bar.appendChild(sep());
  // The More toggle: a plain disclosure button (no mousedown preventDefault
  // needed, it runs no command on the selection).
  const moreBtn=document.createElement('button');moreBtn.type='button';moreBtn.className='rt-more-btn';
  setSafeHtml(moreBtn, `<span style="display:inline-flex">${ICO.more}</span>`);
  moreBtn.title='More formatting';moreBtn.setAttribute('aria-label','More formatting');
  moreBtn.setAttribute('aria-expanded','false');moreBtn.setAttribute('aria-controls',more.id);
  moreBtn.onmousedown=e=>e.preventDefault();
  moreBtn.onclick=()=>{if(moreBtn.disabled)return;const open=more.hidden;more.hidden=!open;moreBtn.setAttribute('aria-expanded',open?'true':'false');};
  bar.appendChild(moreBtn);
  bar.appendChild(more);
  // Why the toolbar is off, on its own line under the buttons (setReadOnly): each
  // button and the body name it as their description. The words are the caller's.
  const note=document.createElement('p');note.className='rt-ro-note';note.id=`rt-ro-${_rtMoreSeq}`;note.hidden=true;
  const noteIc=document.createElement('span');noteIc.className='rt-ro-ic';noteIc.setAttribute('aria-hidden','true');setSafeHtml(noteIc, ICO.lock);
  const noteTx=document.createElement('span');
  note.append(noteIc,noteTx);bar.appendChild(note);
  const body=document.createElement('div');body.className='rich-body';body.contentEditable='true';body.spellcheck=true;
  body.dataset.placeholder=placeholder||'';if(minH)body.style.minHeight=minH+'px';
  // v7.18.0 — normalise pasted HTML (Word, Google Docs, web pages) to the
  // subset that will actually be stored, so what the author sees while editing
  // is what survives the save. Falls through to the browser's own handling when
  // the clipboard carries no HTML flavour.
  body.addEventListener('paste',e=>{
    const cd=e.clipboardData;if(!cd)return;
    const raw=cd.getData('text/html');
    if(!raw){
      // Plain text: insert it ourselves so a multi-line paste does not arrive
      // wrapped in whatever the browser feels like emitting.
      const txt=cd.getData('text/plain');
      if(!txt)return;
      e.preventDefault();
      document.execCommand('insertText',false,txt);
      return;
    }
    e.preventDefault();
    const clean=normalisePastedHtml(raw);
    if(clean)document.execCommand('insertHTML',false,clean);
    else document.execCommand('insertText',false,cd.getData('text/plain')||'');
  });
  // A drag inside the editor moves text as the browser draws it, so a named colour
  // lands as this look's literal ink (measured in Chromium): put the names back.
  // Safari inserts an IME's committed text after compositionend: colour it then.
  body.addEventListener('input',e=>{
    if(e.inputType==='insertFromDrop')_rtRestoreNames(body);
    else if(e.inputType==='insertFromComposition')_rtComposeFinish(body);
  });
  // The editor's own steps (a colour pick, Inline Code, a table row: _rtStep and
  // _rtEdit) end at any change they did not make: the browser's history and theirs
  // would no longer describe the same text.
  body._rtWatch=new MutationObserver(()=>_rtForget(body));
  body._rtWatch.observe(body,{childList:true,subtree:true,characterData:true,attributes:true});
  // Ctrl+Z (Cmd+Z) takes back the editor's last step before the browser's own; the
  // keys, because with nothing on the browser's history it fires no beforeinput.
  // Taken on the whole editor, not only its text: with the focus on a toolbar button
  // (Tab put it there, or Enter pressed one that selects nothing after, as an unwrap),
  // Ctrl+Z still takes the editor's step first (with none, the browser's own undo runs
  // from there, as it always did). Never from inside an open toolbar menu, which holds
  // the selection it was opened on: an undo under it could take that text out of the
  // editor before the menu's item acts on it. While the editor holds a step, the key
  // does nothing there, or the browser's own undo would reach past that step.
  el.addEventListener('keydown',e=>{
    if(e.isComposing||e.altKey||!(e.ctrlKey||e.metaKey))return;
    const k=String(e.key||'').toLowerCase();
    const redo=(k==='z'&&e.shiftKey)||(k==='y'&&e.ctrlKey&&!e.metaKey&&!e.shiftKey);
    if(!redo&&k!=='z')return;
    if(!_rtHasStep(body,redo))return;
    e.preventDefault();
    if(!(body.contains(e.target)||e.target.closest?.('.rich-toolbar button')))return;
    if(redo)_rtRedo(body);else _rtUndo(body);
  });
  // A colour picked with nothing selected waits for the next text typed at that
  // caret (applyRichColour): the text is inserted here and coloured by the same
  // engine as a selection, with the caret left inside it so typing carries on in
  // that colour. An IME composition there takes it too (_rtComposeBegin). Any other
  // input, or a caret that has moved, drops the wait. The browser's own Undo and
  // Redo (its Edit menu) take the editor's steps first, as the keys do.
  body.addEventListener('beforeinput',e=>{
    const t=e.inputType;
    if(t==='historyUndo'||t==='historyRedo'){
      const redo=t==='historyRedo';
      if(_rtHasStep(body,redo)){e.preventDefault();if(redo)_rtRedo(body);else _rtUndo(body);}
      else body._rtPending=null;
      return;
    }
    if(_RT_COMPOSING.has(t)){_rtComposeBegin(body);return;}
    _rtComposeFinish(body);
    const p=body._rtPending;
    if(p){
      body._rtPending=null;
      if(t==='insertText'&&e.data&&_rtCaretAt(p)){
        e.preventDefault();
        const data=e.data,kinds=p.kinds;
        const out=_rtStep(body,pts=>{
          const tx=document.createTextNode(data);_rtRange(pts).insertNode(tx);
          let r=document.createRange();r.selectNodeContents(tx);
          for(const [kind,name] of Object.entries(kinds))r=setRichColour(body,r,kind,name)||r;
          return _rtCaretAtEnd(r);
        });
        if(out)_rtSelect(out);
        return;
      }
    }
    _rtForget(body);
  });
  body.addEventListener('compositionstart',()=>{_rtComposeFinish(body);_rtComposeBegin(body);});
  body.addEventListener('compositionend',()=>_rtComposeEnd(body));
  body.addEventListener('contextmenu',e=>{
    // Read-only: the browser's own menu (Copy) rather than a language pick that could
    // change nothing.
    if(!body.isContentEditable)return;
    let node=e.target;while(node&&node!==body){
      if(node.nodeName==='CODE'&&node.parentNode&&node.parentNode.nodeName==='PRE'){showCodeLangMenu(e,node);return;}
      if(node.nodeName==='PRE'){const code=node.querySelector('code');if(code){showCodeLangMenu(e,code);return;}}
      node=node.parentNode;
    }
  });
  // Code is literal. Spelling and autocorrect stay off inside it: with them on,
  // WebKit's smart punctuation (Safari, every iPad) rewrites `--` as an em dash
  // and straight quotes as curly ones in editable text — real characters, not a
  // ligature, so they would be stored and shown to participants. Marked on every
  // code element however it arrives (typed, pasted, loaded) and never stored:
  // `getHtml` drops the marks, and the server's sanitiser would anyway.
  // The editor's own steps mark the code they make inside the step (_rtRecorded), so
  // this finds nothing to write after one, and the watch never takes it for a change
  // the step did not make.
  new MutationObserver(()=>_rtMarkCode(body)).observe(body,{childList:true,subtree:true});
  el.appendChild(bar);el.appendChild(body);
  return{
    getHtml:()=>{
      const c=body.cloneNode(true);
      c.querySelectorAll('code,pre').forEach(n=>{for(const [k] of _CODE_LITERAL)n.removeAttribute(k);});
      const h=c.innerHTML;return(h==='<br>'||h==='<div><br></div>')?'':h;
    },
    setHtml:h=>{setSafeHtml(body, h||'');body._rtPending=null;_rtForget(body);},
    // THE ONE WRITER OF THE BODY'S contentEditable after creation (a scanner in
    // functional-core-b Docs hygiene refuses any other in public/js): a non-empty
    // `reason` makes the body read-only and switches every toolbar control off in the
    // same step, with the reason under the bar as each control's and the body's
    // description (plus the ids in `also`); anything else makes it editable again.
    // Open menus close and More collapses, so nothing opened before acts after.
    setReadOnly:(reason,{also}={})=>{
      const on=typeof reason==='string'&&reason.length>0;
      body.contentEditable=on?'false':'true';
      el.classList.toggle('is-readonly',on);
      const ids=on?[note.id,...(also?[also]:[])].join(' '):'';
      for(const b of bar.querySelectorAll('button')){
        b.disabled=on;
        if(on)b.setAttribute('aria-describedby',ids);else b.removeAttribute('aria-describedby');
      }
      if(on)body.setAttribute('aria-describedby',ids);else body.removeAttribute('aria-describedby');
      noteTx.textContent=on?reason:'';note.hidden=!on;
      if(on){
        more.hidden=true;moreBtn.setAttribute('aria-expanded','false');
        bar.querySelectorAll('.color-pop,.drop-pop').forEach(p=>p.remove());
        document.querySelectorAll('.code-lang-menu').forEach(m=>m.remove());
      }
      body._rtPending=null;_rtForget(body);
    }
  };
}
const _CODE_LITERAL=[['spellcheck','false'],['autocorrect','off'],['autocapitalize','off']];
function _rtMarkCode(body){body.querySelectorAll('code,pre').forEach(n=>{for(const [k,v] of _CODE_LITERAL)if(n.getAttribute(k)!==v)n.setAttribute(k,v);});}
let _rtMoreSeq=0;

// a11y: turn a popover <div> + its child rows into a keyboard-operable
// role="menu". Each row becomes role="menuitem" with roving tabindex; arrows /
// Home / End move focus, Enter/Space run its `activate`, Escape closes the pop.
// `activate` is the same callback the pointer path runs on mousedown, so mouse
// and keyboard share one code path (selection-restore included by the caller).
function _wireMenuItem(pop,item,activate,i){
  item.setAttribute('role','menuitem');
  item.tabIndex=i===0?0:-1;
  item.onkeydown=e=>{
    const items=[...pop.querySelectorAll('[role="menuitem"]')];
    const idx=items.indexOf(item);
    if(e.key==='Enter'||e.key===' '){e.preventDefault();activate();return;}
    if(e.key==='Escape'){e.preventDefault();pop.remove();return;}
    let n=null;
    if(e.key==='ArrowDown'||e.key==='ArrowRight')n=items[(idx+1)%items.length];
    else if(e.key==='ArrowUp'||e.key==='ArrowLeft')n=items[(idx-1+items.length)%items.length];
    else if(e.key==='Home')n=items[0];
    else if(e.key==='End')n=items[items.length-1];
    else return;
    e.preventDefault();n?.focus();
  };
}

/**
 * Position a toolbar popover under its button, in viewport coordinates.
 *
 * The popover is `position:fixed` so it escapes `.rich-editor{overflow:hidden}`
 * (see the CSS note). That means it needs real coordinates, and it needs to be
 * measured BEFORE placing: reading offsetWidth/Height while it is still
 * `display:none` returns 0, which is the same trap the row-action kebab hit in
 * v7.7.x. Render it off-screen, measure, then flip above the button when it
 * would fall off the bottom, and clamp to both edges.
 */
function _placePop(pop,anchor){
  pop.style.visibility='hidden';
  pop.style.left='-9999px';
  pop.style.top='0px';
  const r=anchor.getBoundingClientRect();
  const w=pop.offsetWidth||160,h=pop.offsetHeight||200;
  const vw=window.innerWidth,vh=window.innerHeight,gap=4,pad=8;
  let top=r.bottom+gap;
  if(top+h>vh-pad)top=Math.max(pad,r.top-gap-h);          // flip above
  if(top+h>vh-pad)top=Math.max(pad,vh-pad-h);             // still too tall: clamp
  let left=r.left+r.width/2-w/2;
  left=Math.max(pad,Math.min(left,vw-pad-w));
  pop.style.left=left+'px';
  pop.style.top=top+'px';
  pop.style.visibility='';
}

// ── v9.2.13 — colouring the selection with a NAME ─────────────────────────────
//
// Not execCommand: foreColor and hiliteColor write a literal (`<font color>`, an
// inline background-color), which is the defect the names fix. The selection's
// colour CARRIERS of one kind (a span or font holding that kind of colour, named or
// literal) are split at its two ends, so each lies wholly inside or outside it; the
// ones inside lose that colour, and, unless `name` is null ("no colour"), each run of
// selected inline content is wrapped in one span drawing the name. Custom DOM work,
// so the browser's undo stack never sees it: each pick is a step of the editor's own
// (_rtStep, below).
const _RT_INLINE=new Set(['A','SPAN','FONT','B','STRONG','I','EM','U','S','STRIKE','DEL','CODE','SUB','SUP','BR','IMG']);
// Wrapped whole by a colour span. A link is entered instead, so its text takes the
// colour as any other text does: the link's own colour rule beats an outer span's.
const _RT_WRAP=new Set([..._RT_INLINE].filter(t=>t!=='A'));
function _rtCarries(el,kind){
  if(el.nodeType!==1||(el.tagName!=='SPAN'&&el.tagName!=='FONT'))return false;
  if(kind==='color'&&el.tagName==='FONT'&&el.hasAttribute('color'))return true;
  return !!el.style.getPropertyValue(_RT_PROP[kind]);
}
function _rtStrip(el,kind){
  if(kind==='color'){if(el.tagName==='FONT')el.removeAttribute('color');el.style.removeProperty('color');}
  else el.style.removeProperty('background');   // the shorthand clears background-color with it
  if(el.getAttribute('style')==='')el.removeAttribute('style');
  if(!el.attributes.length)el.replaceWith(...el.childNodes);
}
const _rtIdx=n=>Array.prototype.indexOf.call(n.parentNode.childNodes,n);
const _rtBlankText=n=>n.nodeType===3&&!n.data;
function _rtHasBefore(n){for(let p=n.previousSibling;p;p=p.previousSibling)if(!_rtBlankText(p))return true;return false;}
function _rtHasAfter(n){for(let p=n.nextSibling;p;p=p.nextSibling)if(!_rtBlankText(p))return true;return false;}
// Only inline elements between `n` and its ancestor `el`: a block is never split.
function _rtInlineChain(n,el){for(let p=n.parentNode;p&&p!==el;p=p.parentNode)if(!_RT_INLINE.has(p.tagName))return false;return true;}
// Split the inline ancestor `el` of `n` right before `n` (`n` and what follows it
// move into a twin placed after `el`), or right after it. A level with nothing on
// the far side is not split, so no empty shell is left behind.
function _rtMoveFrom(first,twin){for(let s=first;s;){const nx=s.nextSibling;twin.appendChild(s);s=nx;}}
function _rtSplitBefore(el,n){
  let cur=n;
  while(cur.parentNode!==el){
    const parent=cur.parentNode;
    if(_rtHasBefore(cur)){const twin=parent.cloneNode(false);_rtMoveFrom(cur,twin);parent.after(twin);cur=twin;}
    else cur=parent;
  }
  if(_rtHasBefore(cur)){const twin=el.cloneNode(false);_rtMoveFrom(cur,twin);el.after(twin);}
}
function _rtSplitAfter(el,n){
  let cur=n;
  while(cur.parentNode!==el){
    const parent=cur.parentNode;
    if(_rtHasAfter(cur)){const twin=parent.cloneNode(false);_rtMoveFrom(cur.nextSibling,twin);parent.after(twin);}
    cur=parent;
  }
  if(_rtHasAfter(cur)){const twin=el.cloneNode(false);_rtMoveFrom(cur.nextSibling,twin);el.after(twin);}
}
// The nodes wholly inside `r` whose parent is not.
function _rtTops(r){
  const out=[];
  const inside=n=>{const p=n.parentNode,i=_rtIdx(n);return r.isPointInRange(p,i)&&r.isPointInRange(p,i+1);};
  (function walk(node){for(const c of[...node.childNodes]){if(inside(c))out.push(c);else if(r.intersectsNode(c))walk(c);}})(r.commonAncestorContainer);
  return out;
}

/**
 * Give the content of `range` (inside the editor `root`) the colour `name` of
 * `kind` ('color' or 'highlight'), or take that kind of colour off it when `name`
 * is null. Returns a range over the same content, or null when there is none.
 */
export function setRichColour(root,range,kind,name){
  if(!_RT_PROP[kind]||(name!==null&&!_RICH_COLOUR_SET.has(name)))return null;
  if(!range||range.collapsed||!root.contains(range.startContainer)||!root.contains(range.endContainer))return null;
  const doc=root.ownerDocument;
  const mark=()=>{const m=doc.createElement('span');m.setAttribute('data-rt-mark','');return m;};
  const sm=mark(),em=mark();
  const end=range.cloneRange();end.collapse(false);end.insertNode(em);
  const start=range.cloneRange();start.collapse(true);start.insertNode(sm);
  // 1. Every carrier of this kind is cut at the two ends.
  for(let a=sm.parentNode;a&&a!==root;){const up=a.parentNode;if(_rtCarries(a,kind)&&_rtInlineChain(sm,a))_rtSplitBefore(a,sm);a=up;}
  for(let a=em.parentNode;a&&a!==root;){const up=a.parentNode;if(_rtCarries(a,kind)&&_rtInlineChain(em,a))_rtSplitAfter(a,em);a=up;}
  // 2. The marks leave every inline element they open or close, so a carrier the
  //    selection covers now lies wholly between them.
  while(sm.parentNode!==root&&_RT_INLINE.has(sm.parentNode.tagName)&&!_rtHasBefore(sm))sm.parentNode.before(sm);
  while(em.parentNode!==root&&_RT_INLINE.has(em.parentNode.tagName)&&!_rtHasAfter(em))em.parentNode.after(em);
  const r=doc.createRange();r.setStartAfter(sm);r.setEndBefore(em);
  // 3. Those carriers lose this kind of colour.
  const carriers=[];
  for(const t of _rtTops(r)){
    if(t.nodeType!==1)continue;
    for(const el of[t,...t.querySelectorAll('span,font')])if(_rtCarries(el,kind))carriers.push(el);
  }
  for(const el of carriers)_rtStrip(el,kind);
  // 4. Each run of selected inline content takes the name, in one span.
  if(name!==null){
    r.setStartAfter(sm);r.setEndBefore(em);
    const runs=[];
    const collect=nodes=>{
      let run=null;
      for(const n of nodes){
        const inline=n.nodeType===3||(n.nodeType===1&&_RT_WRAP.has(n.tagName));
        if(inline&&run&&run[run.length-1].nextSibling===n)run.push(n);
        else if(inline){run=[n];runs.push(run);}
        else{run=null;if(n.nodeType===1)collect([...n.childNodes]);}
      }
    };
    collect(_rtTops(r));
    for(const run of runs){
      if(!run.some(n=>n.nodeType===3?/\S/.test(n.data):(/\S/.test(n.textContent)||n.nodeName==='IMG'||!!n.querySelector('img'))))continue;
      const w=doc.createElement('span');w.style.setProperty(_RT_PROP[kind],`var(${_RT_VAR[kind]}${name})`);
      run[0].before(w);for(const n of run)w.appendChild(n);
    }
  }
  // 5. The same content stays selected; the marks go and split text is joined.
  const out=doc.createRange();out.setStartAfter(sm);out.setEndBefore(em);
  sm.remove();em.remove();
  root.normalize();
  return out;
}

// A caret at the end of `range`, inside the last text it covers: text typed there
// continues in the colour just given to it.
function _rtCaretAtEnd(range){
  let n=range.endContainer,o=range.endOffset;
  if(n.nodeType===1&&o>0){
    let c=n.childNodes[o-1];
    while(c&&c.nodeType===1&&c.lastChild)c=c.lastChild;
    if(c&&c.nodeType===3){n=c;o=c.length;}
  }
  const r=n.ownerDocument.createRange();r.setStart(n,o);r.collapse(true);return r;
}

// ── The editor's own undo steps ──────────────────────────────────────────────
//
// Some of the editor's work is its own DOM work, which the browser's history never
// sees: a colour pick (_rtStep), and every other custom edit (_rtEdit): Inline Code,
// Code Block, Insert Link with its Update and Remove Link, the Table menu's row,
// column and Delete table items, and a code language picked from a code block's menu.
// Ctrl+Z passed over such a change and undid the typing before it instead, at places
// the change had split and joined since. So each is a STEP the editor keeps itself
// (`body._rtHistory`, one stack for both kinds, the last first). Its mutations are
// recorded while it runs and reversed node for node, never re-parsed from a copy of
// the HTML; reversing them is recorded in turn, and reversing THAT puts the step back.
// Every node is the same node again either way, so the text the browser's own steps
// point at (and a later step's selection) is the same text. Ctrl+Z (Cmd+Z), or the
// browser's own Undo, takes the editor's last step first; Ctrl+Shift+Z or Ctrl+Y puts
// it back. Any change to the editor the steps did not make (typing, a paste, an
// execCommand toolbar command such as Bold or Insert table…, the browser's own undo)
// ends them (`body._rtWatch`): their records would no longer describe the text. Code
// a step makes is marked inside the step (_rtMarkCode), or the marking observer's
// later writes would be such a change. A read-only editor (a locked or sealed
// challenge) takes no step and is not changed.
const _RT_RECORD={childList:true,subtree:true,characterData:true,characterDataOldValue:true,attributes:true,attributeOldValue:true};
const _RT_STEPS_MAX=100;
const _rtPoints=r=>({sc:r.startContainer,so:r.startOffset,ec:r.endContainer,eo:r.endOffset});
function _rtRange(pts){const r=pts.sc.ownerDocument.createRange();r.setStart(pts.sc,pts.so);r.setEnd(pts.ec,pts.eo);return r;}
function _rtSelect(range){const s=window.getSelection();s.removeAllRanges();s.addRange(range);}
function _rtForget(body){body._rtHistory=null;}
function _rtHasStep(body,redo){const h=body._rtHistory;return !!h&&(redo?h.redo:h.undo).length>0;}
// Run `fn` in the editor `body` with its mutations recorded, unseen by the watch.
function _rtRecorded(body,fn,arg){
  const rec=new MutationObserver(()=>{});
  rec.observe(body,_RT_RECORD);
  let out,records=[];
  try{out=fn(arg);_rtMarkCode(body);}
  finally{records=rec.takeRecords();rec.disconnect();body._rtWatch?.takeRecords();}
  return {out,records};
}
// Put back what `records` changed, the last change first: each record is reversed
// in the state it left, so every sibling it names is where it named it.
function _rtRevert(records){
  for(let i=records.length-1;i>=0;i--){
    const m=records[i];
    if(m.type==='characterData')m.target.data=m.oldValue;
    else if(m.type==='attributes'){if(m.oldValue===null)m.target.removeAttribute(m.attributeName);else m.target.setAttribute(m.attributeName,m.oldValue);}
    else{
      for(const n of m.addedNodes)if(n.parentNode===m.target)m.target.removeChild(n);
      for(const n of m.removedNodes)m.target.insertBefore(n,m.nextSibling);
    }
  }
}
// Keep one step (its selection before and after, and its records); a step that changed
// nothing is not kept, and a new step leaves nothing to redo.
function _rtPush(body,before,after,records){
  if(!records.length)return;
  const h=body._rtHistory||(body._rtHistory={undo:[],redo:[]});
  h.undo.push({before,after,records});
  if(h.undo.length>_RT_STEPS_MAX)h.undo.shift();
  h.redo.length=0;
}
/**
 * Run the editor's own DOM work `fn(points)` as one step Ctrl+Z takes back, where
 * `points` is the selection it starts from and `fn` returns the range to select after.
 */
function _rtStep(body,fn){
  if(!body.isContentEditable)return null;
  const s=window.getSelection();
  if(!s||!s.rangeCount)return null;
  const before=_rtPoints(s.getRangeAt(0));
  const {out,records}=_rtRecorded(body,fn,before);
  _rtPush(body,before,out?_rtPoints(out):null,records);
  return out;
}
// The selection's range when both its ends are in `body`, else null.
function _rtRangeIn(body){
  const s=window.getSelection();
  const r=s&&s.rangeCount?s.getRangeAt(0):null;
  return r&&body.contains(r.startContainer)&&body.contains(r.endContainer)?r:null;
}
/**
 * Run any other custom edit `fn()` in the editor `body` as one step Ctrl+Z takes
 * back; returns what `fn` returns. A Range it returns is what a redo selects, else
 * the selection it leaves. Needs no selection (a code language is picked from a menu).
 */
function _rtEdit(body,fn){
  if(!body||!body.isContentEditable)return null;
  const r0=_rtRangeIn(body),before=r0?_rtPoints(r0):null;
  const {out,records}=_rtRecorded(body,fn);
  const r1=out instanceof Range?out:_rtRangeIn(body);
  _rtPush(body,before,r1?_rtPoints(r1):null,records);
  return out;
}
// Take the last step back (or, `redo`, put the last one taken back), keeping the
// records that reverse what was just done, and select what the step selected then.
function _rtTurn(body,redo){
  const h=body._rtHistory,step=h&&(redo?h.redo:h.undo).pop();
  if(!step)return;
  body._rtPending=null;
  step.records=_rtRecorded(body,_rtRevert,step.records).records;
  (redo?h.undo:h.redo).push(step);
  const pts=redo?step.after:step.before;
  // The step's text is back node for node, so its points are good; a selection the
  // browser will not take (a node it no longer holds) leaves the caret where it is.
  try{if(pts)_rtSelect(_rtRange(pts));}catch(e){console.warn('rich editor: selection not restored',e);}
}
const _rtUndo=body=>_rtTurn(body,false);
const _rtRedo=body=>_rtTurn(body,true);

// ── A waiting colour and an IME ───────────────────────────────────────────────
//
// A colour waiting at a caret goes to text an IME composes there too (Android
// keyboards for every script, Chinese, Japanese and Korean input). A composition's
// events cannot be cancelled and the IME owns its text until it commits, so nothing is
// touched meanwhile: its start is kept as a count of characters from the editor's
// start (the browser may merge the composed text into the text before it, or replace
// that node), and the committed text is coloured once the DOM has settled, as one step.
const _RT_COMPOSING=new Set(['insertCompositionText','deleteCompositionText','insertFromComposition']);
function _rtCaretAt(p){
  const s=window.getSelection();if(!s||!s.rangeCount)return false;
  const r=s.getRangeAt(0);
  return r.collapsed&&r.startContainer===p.node&&r.startOffset===p.offset;
}
// Characters of text from the start of `body` to the point (node, offset).
function _rtTextOffset(body,node,offset){const r=body.ownerDocument.createRange();r.setStart(body,0);r.setEnd(node,offset);return r.toString().length;}
// The point `off` characters into `body`: inside the text after it (`atStart`), or
// the text before it.
function _rtTextPoint(body,off,atStart){
  const w=body.ownerDocument.createTreeWalker(body,NodeFilter.SHOW_TEXT);
  let n,seen=0,last=null;
  while((n=w.nextNode())){
    const len=n.data.length;
    if(atStart?off<seen+len:off<=seen+len)return {node:n,offset:off-seen};
    seen+=len;last=n;
  }
  return last&&off===seen?{node:last,offset:last.data.length}:null;
}
function _rtComposeBegin(body){
  const p=body._rtPending;
  if(!p||p.compose)return;
  if(!_rtCaretAt(p)){body._rtPending=null;return;}
  p.compose={start:_rtTextOffset(body,p.node,p.offset),ended:false};
}
function _rtComposeEnd(body){
  const p=body._rtPending;
  if(!p||!p.compose)return;
  p.compose.ended=true;
  // Chromium has inserted the committed text by now; Safari inserts it after this
  // event (insertFromComposition, which finishes at once). A task later, both have.
  setTimeout(()=>_rtComposeFinish(body),0);
}
function _rtComposeFinish(body){
  const p=body._rtPending;
  if(!p||!p.compose||!p.compose.ended)return;
  body._rtPending=null;
  const s=window.getSelection();
  if(!s||!s.rangeCount)return;
  const caret=s.getRangeAt(0);
  if(!body.contains(caret.endContainer))return;
  const start=p.compose.start,end=_rtTextOffset(body,caret.endContainer,caret.endOffset);
  if(end<=start){
    // Nothing was committed (a cancelled composition): the colour waits on.
    if(caret.collapsed)body._rtPending={node:caret.startContainer,offset:caret.startOffset,kinds:p.kinds};
    return;
  }
  const from=_rtTextPoint(body,start,true),to=_rtTextPoint(body,end,false);
  if(!from||!to)return;
  const out=_rtStep(body,()=>{
    let r=body.ownerDocument.createRange();r.setStart(from.node,from.offset);r.setEnd(to.node,to.offset);
    for(const [kind,name] of Object.entries(p.kinds))r=setRichColour(body,r,kind,name)||r;
    return _rtCaretAtEnd(r);
  });
  if(out)_rtSelect(out);
}

/**
 * The Text colour and Highlight menus: colour the selection in the editor `root`, as
 * one step Ctrl+Z takes back. With nothing selected, the colour waits for the next
 * text typed or composed at the caret (createRichEditor's beforeinput handler), as
 * execCommand's typing style did.
 */
export function applyRichColour(root,kind,name){
  if(!root||!_RT_PROP[kind]||(name!==null&&!_RICH_COLOUR_SET.has(name)))return false;
  const sel=window.getSelection();if(!sel||!sel.rangeCount)return false;
  const r=sel.getRangeAt(0);
  if(!root.contains(r.startContainer)||!root.contains(r.endContainer))return false;
  if(r.collapsed){
    const p=root._rtPending;
    const same=p&&p.node===r.startContainer&&p.offset===r.startOffset;
    root._rtPending={node:r.startContainer,offset:r.startOffset,kinds:{...(same?p.kinds:{}),[kind]:name}};
    return true;
  }
  root._rtPending=null;
  const out=_rtStep(root,pts=>setRichColour(root,_rtRange(pts),kind,name));
  if(!out)return false;
  sel.removeAllRanges();sel.addRange(out);
  return true;
}

export function toggleColorPop(wrap,kind){
  let pop=wrap.querySelector('.color-pop');if(pop){pop.remove();return;}
  // Preserve the editor selection so a keyboard-activated swatch (which moves
  // focus out of the contentEditable) still colours the right range. The pointer
  // path passes through the same `run`, so it's a no-op there.
  const editorBody=wrap.closest('.rich-editor')?.querySelector('.rich-body');
  const sel=window.getSelection();
  const savedRange=sel&&sel.rangeCount?sel.getRangeAt(0).cloneRange():null;
  const hl=kind==='highlight';
  const run=name=>{
    if(!editorBody)return;
    editorBody.focus();
    if(savedRange){const s=window.getSelection();s.removeAllRanges();s.addRange(savedRange);}
    applyRichColour(editorBody,kind,name);
  };
  pop=document.createElement('div');pop.className='color-pop';pop.dataset.rtKind=kind;
  pop.setAttribute('role','menu');pop.setAttribute('aria-label',hl?'Highlight colour':'Text colour');
  // Each swatch is painted with the ink or tint of the look on screen, so what the
  // author picks is what every reader sees in this look and mode.
  [null,...RICH_COLOURS].forEach((name,i)=>{
    const sw=document.createElement('div');sw.className='color-sw'+(name===null?' no-color':'');
    const label=name===null?(hl?'No highlight':'Default colour'):richColourLabel(name);
    sw.setAttribute('aria-label',label);sw.title=label;
    if(name){sw.dataset.rtSwatch=name;sw.style.background=`var(--rt-${hl?'hl-':''}${name})`;}
    else sw.textContent='✕';
    const activate=()=>{run(name);pop.remove();};
    sw.onmousedown=e=>{e.preventDefault();activate();};
    _wireMenuItem(pop,sw,activate,i);
    pop.appendChild(sw);
  });
  wrap.appendChild(pop);
  _placePop(pop,wrap.querySelector('button')||wrap);
  const close=e=>{if(!wrap.contains(e.target)){pop.remove();document.removeEventListener('click',close);}};
  setTimeout(()=>document.addEventListener('click',close),0);
  pop.querySelector('[role="menuitem"]')?.focus();
}

export function toggleDropPop(wrap,type){
  let pop=wrap.querySelector('.drop-pop');if(pop){pop.remove();return;}
  const editorBody=wrap.closest('.rich-editor')?.querySelector('.rich-body');
  const sel=window.getSelection();
  const savedRange=sel&&sel.rangeCount?sel.getRangeAt(0).cloneRange():null;
  const restore=()=>{if(editorBody)editorBody.focus();if(savedRange){const s=window.getSelection();s.removeAllRanges();s.addRange(savedRange);}};
  pop=document.createElement('div');pop.className='drop-pop';
  pop.setAttribute('role','menu');pop.setAttribute('aria-label',type==='font'?'Font family':'Font size');
  const items=type==='font'?EDITOR_FONTS:EDITOR_SIZES;
  items.forEach((item,i)=>{
    const d=document.createElement('div');
    let activate;
    if(type==='font'){
      // The menu names each font in the UI's own face: the UI never sets a
      // family outside the type tokens (tests/type-scale-scanner.spec.js).
      d.textContent=item;
      activate=()=>{restore();if(item==='Default')document.execCommand('removeFormat');else document.execCommand('fontName',false,item);pop.remove();};
    }else{
      d.textContent=item.label;
      d.style.fontSize=['var(--fs-13)','var(--fs-14)','var(--fs-18)','var(--fs-22)','var(--fs-28)'][EDITOR_SIZES.indexOf(item)];
      activate=()=>{restore();document.execCommand('fontSize',false,item.val);pop.remove();};
    }
    d.onmousedown=e=>{e.preventDefault();activate();};
    _wireMenuItem(pop,d,activate,i);
    pop.appendChild(d);
  });
  wrap.appendChild(pop);
  _placePop(pop,wrap.querySelector('button')||wrap);
  const close=e=>{if(!wrap.contains(e.target)){pop.remove();document.removeEventListener('click',close);}};
  setTimeout(()=>document.addEventListener('click',close),0);
  pop.querySelector('[role="menuitem"]')?.focus();
}

// Inline Code and Code Block act on a selection in the editor, never one elsewhere on
// the page, each as one step of the editor's own (_rtEdit).
export function toggleInlineCode(editorBody){
  const sel=window.getSelection();
  const range=editorBody&&_rtRangeIn(editorBody);if(!range)return;
  const nr=_rtEdit(editorBody,()=>{
    // Check if selection is inside a <code> that is NOT inside <pre>
    let codeParent=sel.anchorNode;
    while(codeParent&&codeParent!==editorBody){
      if(codeParent.nodeName==='CODE'&&(!codeParent.parentNode||codeParent.parentNode.nodeName!=='PRE')){
        // Unwrap: replace code element with its contents
        const frag=document.createDocumentFragment();
        while(codeParent.firstChild)frag.appendChild(codeParent.firstChild);
        codeParent.parentNode.replaceChild(frag,codeParent);
        return null;
      }
      codeParent=codeParent.parentNode;
    }
    // Wrap selection in <code>
    const content=range.extractContents();
    const code=document.createElement('code');
    code.appendChild(content);
    range.insertNode(code);
    const r=document.createRange();r.selectNodeContents(code);return r;
  });
  if(nr instanceof Range){sel.removeAllRanges();sel.addRange(nr);}
}

export function toggleCodeBlock(editorBody){
  const sel=window.getSelection();
  const range=editorBody&&_rtRangeIn(editorBody);if(!range)return;
  const nr=_rtEdit(editorBody,()=>{
    // Check if inside a <pre>
    let preParent=sel.anchorNode;
    while(preParent&&preParent!==editorBody){
      if(preParent.nodeName==='PRE'){
        // Unwrap: replace pre with its text content as a div
        const div=document.createElement('div');
        div.textContent=preParent.textContent;
        preParent.parentNode.replaceChild(div,preParent);
        return null;
      }
      preParent=preParent.parentNode;
    }
    // Wrap in <pre><code>
    const content=range.extractContents();
    const pre=document.createElement('pre');
    const code=document.createElement('code');
    code.appendChild(content);
    pre.appendChild(code);
    range.insertNode(pre);
    const r=document.createRange();r.selectNodeContents(code);return r;
  });
  if(nr instanceof Range){sel.removeAllRanges();sel.addRange(nr);}
}

export function showLinkDialog({url='https://',text='',editMode=false}){
  return new Promise(resolve=>{
    const overlay=document.createElement('div');
    overlay.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;background:var(--overlay);z-index:9000;display:flex;align-items:center;justify-content:center;padding:24px';
    const box=document.createElement('div');
    box.className='card';
    box.style.cssText='width:100%;max-width:420px;animation:modal-in var(--duration-normal) var(--ease-spring);box-shadow:var(--shadow-3)';
    setSafeHtml(box, `
      <h3 style="margin-bottom:16px;font-size:var(--fs-18)">${editMode?'Edit Link':'Insert Link'}</h3>
      <div class="form-group"><label>URL <span class="req">*</span></label><input aria-required="true" id="link-dlg-url" type="url" placeholder="https://example.com" value="${esc(url)}"/></div>
      ${!editMode?`<div class="form-group"><label>Display Text <span style="color:var(--muted);font-weight:var(--fw-regular)">(optional)</span></label><input id="link-dlg-text" type="text" placeholder="Link text" value="${esc(text)}"/></div>`:''}
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
        ${editMode?'<button class="btn danger" id="link-dlg-remove" style="margin-right:auto">Remove Link</button>':''}
        <button class="btn secondary" id="link-dlg-cancel">Cancel</button>
        <button class="btn" id="link-dlg-ok">${editMode?'Update':'Insert'}</button>
      </div>`);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const urlInput=box.querySelector('#link-dlg-url');
    const textInput=box.querySelector('#link-dlg-text');
    const finish=result=>{overlay.remove();resolve(result);};
    const submit=()=>{const u=urlInput.value.trim();if(!u)return urlInput.focus();finish({url:u,text:textInput?textInput.value.trim():''});};
    // v6.8.10: Escape dismissal is owned by `overlayDismiss` globally —
    // keep the Enter-to-submit binding separate. Backdrop-click-close is
    // intentionally absent (data-entry modal; a misclick would destroy
    // the URL the user just typed). Enter is taken inside the dialog only: the
    // toolbar's Insert Link opens it from its own Enter keydown, and a listener on
    // the document added then would still hear that same Enter on its way up, and
    // insert the prefilled `https://` before the dialog was ever seen. Enter on a
    // BUTTON is that button's own press (Cancel, Remove Link), never a submit.
    const enterHandler=e=>{if(e.key==='Enter'&&!(e.target&&e.target.closest&&e.target.closest('button')))submit();};
    box.addEventListener('keydown',enterHandler);
    box.querySelector('#link-dlg-ok').onclick=submit;
    box.querySelector('#link-dlg-cancel').onclick=()=>finish(null);
    if(editMode)box.querySelector('#link-dlg-remove').onclick=()=>finish({remove:true});
    overlayDismiss(overlay,()=>finish(null));
    // batch 3 (F4): focus AFTER overlayDismiss so it snapshots the opener (the
    // toolbar Link button) and restores focus there when the dialog closes.
    urlInput.focus();urlInput.select();
  });
}

export async function insertLink(editorBody){
  const sel=window.getSelection();
  // A read-only editor (a locked or sealed challenge) asks for no URL it could not use.
  if(!editorBody||!editorBody.isContentEditable)return;
  const r0=_rtRangeIn(editorBody);if(!r0)return;
  // Save selection range before opening dialog (dialog will steal focus)
  const savedRange=r0.cloneRange();
  // Every branch puts the editor's focus and selection back before it edits, so its
  // step starts from the text the dialog was opened on (and Ctrl+Z reselects it).
  const restore=()=>{editorBody.focus();sel.removeAllRanges();sel.addRange(savedRange);};
  // Check if cursor is inside an existing <a> — offer to edit or remove
  let anchor=sel.anchorNode;
  while(anchor&&anchor!==editorBody){
    if(anchor.nodeName==='A'){
      const a=anchor;
      const result=await showLinkDialog({url:a.href||'https://',editMode:true});
      if(!result)return;
      restore();
      if(result.remove){
        _rtEdit(editorBody,()=>{
          const frag=document.createDocumentFragment();
          while(a.firstChild)frag.appendChild(a.firstChild);
          a.parentNode.replaceChild(frag,a);
        });
      }else{
        // An Update that changes nothing makes no step (setting an attribute to the
        // value it holds is still a mutation).
        _rtEdit(editorBody,()=>{if(result.url!==a.getAttribute('href')&&result.url!==a.href)a.href=result.url;});
      }
      return;
    }
    anchor=anchor.parentNode;
  }
  const selectedText=sel.toString();
  const result=await showLinkDialog({url:selectedText.startsWith('http')?selectedText:'https://',text:selectedText});
  if(!result)return;
  restore();
  _rtEdit(editorBody,()=>{
    const a=document.createElement('a');
    a.href=result.url;a.target='_blank';a.rel='noopener noreferrer';
    const range=sel.getRangeAt(0);
    if(selectedText)a.appendChild(range.extractContents());
    else a.textContent=result.text||result.url;
    range.insertNode(a);
  });
  sel.removeAllRanges();
}


// ── v7.18.0 — table authoring ───────────────────────────────────────────────
//
// The affordance is a toolbar button opening a role="menu" popover, NOT the
// Word-style hover grid. A 6x6 grid of ~20px cells would add 36 interactive
// targets far below the 44px house standard and be awkward to operate by
// keyboard, and this file already has an accessible popover-menu primitive
// (_wireMenuItem: roving tabindex, arrows/Home/End, Enter/Space, Escape) that
// the font and size dropdowns use. Reuse beats a new pattern with new
// exceptions.

/** The nearest <table> containing the caret, or null. */
/**
 * The Table menu. Insert is always offered; the editing items appear only when
 * the caret is actually inside a table, because an item that silently does
 * nothing is worse than an absent one.
 */
export function toggleTablePop(wrap,editorBody){
  const ex=wrap.querySelector('.drop-pop');
  if(ex){ex.remove();return;}
  // Reuse .drop-pop rather than minting a new class: it is already positioned,
  // themed for light AND dark, and closed by the same outside-click handler as
  // the font/size menus. A new class would need all three again.
  document.querySelectorAll('.drop-pop').forEach(p=>p.remove());
  const sel=window.getSelection();
  const saved=(sel&&sel.rangeCount&&editorBody.contains(sel.anchorNode))?sel.getRangeAt(0).cloneRange():null;
  const restore=()=>{editorBody.focus();if(saved){const s2=window.getSelection();s2.removeAllRanges();s2.addRange(saved);}};
  const inTable=!!(saved&&(()=>{let n=saved.startContainer;while(n&&n!==editorBody){if(n.nodeType===1&&n.tagName==='TABLE')return true;n=n.parentNode;}return false;})());
  const pop=document.createElement('div');pop.className='drop-pop';pop.setAttribute('aria-label','Table');
  const items=[['Insert table…',async()=>{restore();await insertTable(editorBody);}]];
  if(inTable){
    items.push(
      ['Insert row above',()=>{restore();tableInsertRow(editorBody,'above');}],
      ['Insert row below',()=>{restore();tableInsertRow(editorBody,'below');}],
      ['Insert column left',()=>{restore();tableInsertColumn(editorBody,'left');}],
      ['Insert column right',()=>{restore();tableInsertColumn(editorBody,'right');}],
      ['Delete row',()=>{restore();tableDeleteRow(editorBody);}],
      ['Delete column',()=>{restore();tableDeleteColumn(editorBody);}],
      ['Delete table',()=>{restore();tableDelete(editorBody);}],
    );
  }
  items.forEach(([label,fn],i)=>{
    const row=document.createElement('div');row.textContent=label;
    const activate=()=>{pop.remove();fn();};
    row.onmousedown=e=>{e.preventDefault();activate();};
    _wireMenuItem(pop,row,activate,i);
    pop.appendChild(row);
  });
  pop.setAttribute('role','menu');
  wrap.appendChild(pop);
  _placePop(pop,wrap.querySelector('button')||wrap);
  const close=e=>{if(!wrap.contains(e.target)){pop.remove();document.removeEventListener('click',close);}};
  setTimeout(()=>document.addEventListener('click',close),0);
  pop.querySelector('[role="menuitem"]')?.focus();
}

export function tableAtCaret(editorBody){
  const sel=window.getSelection();
  if(!sel||!sel.rangeCount)return null;
  let n=sel.getRangeAt(0).startContainer;
  while(n&&n!==editorBody){
    if(n.nodeType===1&&n.tagName==='TABLE')return n;
    n=n.parentNode;
  }
  return null;
}
function _cellAtCaret(editorBody){
  const sel=window.getSelection();
  if(!sel||!sel.rangeCount)return null;
  let n=sel.getRangeAt(0).startContainer;
  while(n&&n!==editorBody){
    if(n.nodeType===1&&(n.tagName==='TD'||n.tagName==='TH'))return n;
    n=n.parentNode;
  }
  return null;
}
function _rowCells(tr){return [...tr.children].filter(c=>c.tagName==='TD'||c.tagName==='TH');}
/** Every <tr> of a table, in document order, across thead/tbody/tfoot. */
function _allRows(table){return [...table.querySelectorAll('tr')];}

export function buildTableHtml(rows,cols,headerRow){
  const r=Math.max(1,Math.min(50,rows|0));
  const c=Math.max(1,Math.min(20,cols|0));
  let html='<table>';
  let bodyStart=0;
  if(headerRow){
    html+='<thead><tr>';
    for(let j=0;j<c;j++)html+='<th scope="col"><br></th>';
    html+='</tr></thead>';
    bodyStart=1;
  }
  html+='<tbody>';
  for(let i=bodyStart;i<r;i++){
    html+='<tr>';
    for(let j=0;j<c;j++)html+='<td><br></td>';
    html+='</tr>';
  }
  html+='</tbody></table><p><br></p>';
  return html;
}

export function showTableDialog(){
  return new Promise(resolve=>{
    const ov=document.createElement('div');
    ov.id='table-insert-overlay';
    ov.style.cssText='position:fixed;top:0;right:0;bottom:0;left:0;background:var(--overlay);z-index:9500;display:flex;align-items:center;justify-content:center;padding:24px';
    setSafeHtml(ov,`<div class="card" style="max-width:min(380px,calc(100vw - 32px));width:100%;border-top-color:var(--accent)">
      <h3 id="table-dlg-title" style="margin-bottom:14px">Insert Table</h3>
      <div style="display:flex;gap:12px;margin-bottom:12px">
        <label style="flex:1;font-size:var(--fs-13)">Rows
          <input id="tbl-rows" type="number" min="1" max="50" value="3" style="width:100%;margin-top:4px"/>
        </label>
        <label style="flex:1;font-size:var(--fs-13)">Columns
          <input id="tbl-cols" type="number" min="1" max="20" value="3" style="width:100%;margin-top:4px"/>
        </label>
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:var(--fs-13);margin-bottom:16px">
        <input id="tbl-header" type="checkbox" checked style="width:18px;height:18px;accent-color:var(--accent)"/>
        Use the first row as a header
      </label>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button type="button" class="btn secondary" id="tbl-cancel">Cancel</button>
        <button type="button" class="btn" id="tbl-ok">Insert</button>
      </div>
    </div>`);
    document.body.appendChild(ov);
    // overlayDismiss FIRST so it captures the opener for focus restoration
    // before we move focus into the dialog (the ext-audit batch-3 rule).
    let done=false;
    const finish=v=>{if(done)return;done=true;ov.remove();resolve(v);};
    overlayDismiss(ov,()=>finish(null));
    applyDialogAria(ov);
    const rowsEl=ov.querySelector('#tbl-rows');
    ov.querySelector('#tbl-cancel').onclick=()=>finish(null);
    ov.querySelector('#tbl-ok').onclick=()=>finish({
      rows:parseInt(rowsEl.value,10)||3,
      cols:parseInt(ov.querySelector('#tbl-cols').value,10)||3,
      header:ov.querySelector('#tbl-header').checked,
    });
    ov.querySelector('#tbl-ok').focus();
  });
}

/** Insert a fresh table at the caret. */
export async function insertTable(editorBody){
  const sel=window.getSelection();
  const saved=(sel&&sel.rangeCount)?sel.getRangeAt(0).cloneRange():null;
  const spec=await showTableDialog();
  if(!spec)return;
  editorBody.focus();
  if(saved){const s2=window.getSelection();s2.removeAllRanges();s2.addRange(saved);}
  document.execCommand('insertHTML',false,buildTableHtml(spec.rows,spec.cols,spec.header));
}

// ── row / column operations ────────────────────────────────────────────────
// Each returns true when it changed something, so the caller can report "put
// the cursor in a table first" rather than silently doing nothing. Each change is
// one step of the editor's own (_rtEdit), which Ctrl+Z takes back; Insert table…
// is execCommand('insertHTML'), the browser's own step.
function _newCellLike(cell){
  const el=document.createElement(cell.tagName==='TH'?'th':'td');
  if(cell.tagName==='TH'&&cell.getAttribute('scope'))el.setAttribute('scope',cell.getAttribute('scope'));
  el.appendChild(document.createElement('br'));
  return el;
}
export function tableInsertRow(editorBody,where){
  const cell=_cellAtCaret(editorBody);if(!cell)return false;
  return _rtEdit(editorBody,()=>{
    const tr=cell.parentNode;
    const clone=document.createElement('tr');
    // A new row always takes BODY cells, even when cloned from the header —
    // otherwise "insert row below" on a header row produces a second header.
    for(const c of _rowCells(tr)){
      const td=document.createElement('td');
      const cs=c.getAttribute('colspan');if(cs)td.setAttribute('colspan',cs);
      td.appendChild(document.createElement('br'));
      clone.appendChild(td);
    }
    if(where==='above'){
      tr.parentNode.insertBefore(clone,tr);
    }else if(tr.parentNode.tagName==='THEAD'){
      // Below a header row means the top of the body, not inside <thead>.
      const table=tr.closest('table');
      let tbody=table.querySelector('tbody');
      if(!tbody){tbody=document.createElement('tbody');table.appendChild(tbody);}
      tbody.insertBefore(clone,tbody.firstChild);
    }else{
      tr.parentNode.insertBefore(clone,tr.nextSibling);
    }
    return true;
  })===true;
}
export function tableInsertColumn(editorBody,where){
  const cell=_cellAtCaret(editorBody);if(!cell)return false;
  const table=cell.closest('table');if(!table)return false;
  return _rtEdit(editorBody,()=>{
    const idx=_rowCells(cell.parentNode).indexOf(cell);
    for(const tr of _allRows(table)){
      const cells=_rowCells(tr);
      const ref=cells[Math.min(idx,cells.length-1)];
      if(!ref)continue;
      const fresh=_newCellLike(ref);
      if(where==='left')tr.insertBefore(fresh,ref);
      else tr.insertBefore(fresh,ref.nextSibling);
    }
    return true;
  })===true;
}
export function tableDeleteRow(editorBody){
  const cell=_cellAtCaret(editorBody);if(!cell)return false;
  const tr=cell.parentNode;const table=cell.closest('table');
  if(!table)return false;
  return _rtEdit(editorBody,()=>{
    if(_allRows(table).length<=1){table.remove();return true;}   // last row = delete the table
    const section=tr.parentNode;
    tr.remove();
    if(section&&section.tagName!=='TABLE'&&!section.querySelector('tr'))section.remove();
    return true;
  })===true;
}
export function tableDeleteColumn(editorBody){
  const cell=_cellAtCaret(editorBody);if(!cell)return false;
  const table=cell.closest('table');if(!table)return false;
  return _rtEdit(editorBody,()=>{
    const idx=_rowCells(cell.parentNode).indexOf(cell);
    const width=Math.max(..._allRows(table).map(tr=>_rowCells(tr).length));
    if(width<=1){table.remove();return true;}                    // last column = delete the table
    for(const tr of _allRows(table)){
      const cells=_rowCells(tr);
      if(cells[idx])cells[idx].remove();
    }
    return true;
  })===true;
}
export function tableDelete(editorBody){
  const t=tableAtCaret(editorBody);if(!t)return false;
  return _rtEdit(editorBody,()=>{t.remove();return true;})===true;
}

export function showCodeLangMenu(e,codeEl){
  e.preventDefault();
  // The pick is one step of the editor's own (_rtEdit), and focus and the selection
  // go back to the editor, so Ctrl+Z straight after it takes it back.
  const body=codeEl.closest('.rich-body');
  const saved=body?_rtRangeIn(body)?.cloneRange()||null:null;
  // Remove any existing menu
  document.querySelectorAll('.code-lang-menu').forEach(m=>m.remove());
  const menu=document.createElement('div');
  menu.className='code-lang-menu';
  menu.style.cssText=`position:fixed;top:${e.clientY}px;left:${e.clientX}px;background:var(--surface);border:1px solid var(--border);
    border-radius:var(--r-s);padding:4px 0;z-index:9999;box-shadow:var(--shadow);max-height:320px;overflow-y:auto;min-width:170px`;
  menu.setAttribute('role','menu');menu.setAttribute('aria-label','Code language');
  const current=(codeEl.className.match(/language-(\w+)/)||[])[1]||'';
  const title=document.createElement('div');
  title.style.cssText='padding:6px 14px;font-size:var(--fs-12);color:var(--muted);font-weight:var(--fw-semibold);border-bottom:1px solid var(--border)';
  title.textContent='Code Language';
  menu.appendChild(title);
  let activeIdx=0;
  CODE_LANGUAGES.forEach((lang,i)=>{
    const item=document.createElement('div');
    item.style.cssText='padding:5px 14px;cursor:pointer;font-size:var(--fs-13);color:var(--text);white-space:nowrap';
    const isActive=(!lang.val&&!current)||(lang.val===current);
    if(isActive)activeIdx=i;
    item.setAttribute('aria-label',lang.label);
    if(isActive)item.setAttribute('aria-current','true');
    setSafeHtml(item, `${isActive?`<span style="color:var(--accent-ink);margin-right:6px;display:inline-flex;vertical-align:middle">${ICO.check}</span>`:'<span style="margin-right:18px"></span>'}${esc(lang.label)}`);
    const activate=()=>{
      menu.remove();
      const next=lang.val?`language-${lang.val}`:'';
      if(codeEl.className===next)return;
      if(!body){codeEl.className=next;return;}
      body.focus();
      if(saved){const s=window.getSelection();s.removeAllRanges();s.addRange(saved);}
      _rtEdit(body,()=>{codeEl.className=next;});
    };
    item.onmousedown=ev=>{ev.preventDefault();activate();};
    _wireMenuItem(menu,item,activate,i);
    menu.appendChild(item);
  });
  document.body.appendChild(menu);
  // Adjust position if off-screen
  const rect=menu.getBoundingClientRect();
  if(rect.bottom>window.innerHeight)menu.style.top=Math.max(4,window.innerHeight-rect.height-4)+'px';
  if(rect.right>window.innerWidth)menu.style.left=Math.max(4,window.innerWidth-rect.width-4)+'px';
  const close=ev=>{if(!menu.contains(ev.target)){menu.remove();document.removeEventListener('mousedown',close);}};
  setTimeout(()=>document.addEventListener('mousedown',close),0);
  // Land keyboard focus on the active language so arrow keys work immediately.
  const items=[...menu.querySelectorAll('[role="menuitem"]')];
  items.forEach((it,i)=>it.tabIndex=i===activeIdx?0:-1);
  items[activeIdx]?.focus();
}
