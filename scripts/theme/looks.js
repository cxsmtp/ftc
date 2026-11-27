// Single source of truth for every look x mode. scripts/build-theme-tokens.js turns
// this into the generated token block at the top of public/styles.css and fails
// (exit 1) when any text pair drops below WCAG AA. Two flat looks, which differ
// only by colour and corner radii (operator ruling, 13 Nov 2026).
//
// Colour keys (all opaque hex unless noted):
//   bg, bg2            page canvas, sunken canvas
//   surface, surface2, surface3   raised layers (cards, inner wells, hover)
//   border, borderStrong          decorative dividers (not held to 3:1)
//   control            input / control boundary (held to 3:1 vs surface, WCAG 1.4.11)
//   text, text2, muted body copy, secondary copy, captions (all held to 4.5:1)
//   accentInk          accent used AS TEXT on surface/bg (4.5:1)
//   accent             accent as a graphic (rings, glow, focus) (3:1 vs bg)
//   accentStrong/onAccent  primary button fill / its label (4.5:1)
//   accentSoft         tinted chip / selected-row background (text on it checked)
//   gold/goldStrong/onGold certificate gold: ink, CTA fill, CTA label
//   silver, bronze     podium metal inks (4.5:1 on surface)
//   silverStrong/onSilver, bronzeStrong/onBronze  flat medal fills and their labels
//   ok/warn/danger(+Soft) status inks (4.5:1 on surface and on their soft)
//   warnStrong/onWarn  the bright warning fill (the Pending chip) and its label
//                      (4.5:1): the one status fill not labelled --on-status
//   brandInk/brandSoft the brand violet pair: the state chips that must keep their
//                      own hue whatever the accent is (late entry, the shared pool,
//                      "you compete here"). Fixed per look and mode; an ambient
//                      colour never replaces it, so an Amber or Emerald accent
//                      cannot make late entry read as Upcoming or Live (4.5:1)
//   rtInk/rtHighlight  the rich-text colours: the challenge editor's Text colour and
//                      Highlight menus store a NAME (ui/richtext.js RICH_COLOURS,
//                      mirrored by lib/sanitise.js), never a hex, and these give each
//                      name its ink and its highlight tint in this look and mode
//                      (--rt-<name>, --rt-hl-<name>). Every ink 4.5:1 on canvas,
//                      card, well and hover well; body, muted, link (every ambient
//                      colour's) and every ink 4.5:1 on every highlight. Not the
//                      accent: a name keeps its hue whatever the ambient colour is
const looks = {
  signature: {
    label: 'Signature', blurb: 'Checkmarx violet, ivory and certificate gold.',
    shape: { rs: '8px', rm: '12px', rl: '18px', rxl: '26px', control: '44px' },
    light: {
      bg: '#f6f3ee', bg2: '#eee9e1', surface: '#fffdf9', surface2: '#f8f4ee', surface3: '#efe9df',
      border: '#e6dfd3', borderStrong: '#d3c8b6', control: '#8c8172',
      text: '#1c1430', text2: '#3a3150', muted: '#5f5770',
      accent: '#6236e0', accentInk: '#5427c9', accentStrong: '#5a2fd4', accentHover: '#4a22b8', onAccent: '#ffffff', accentSoft: '#eee8fc',
      brandInk: '#5427c9', brandSoft: '#eee8fc',
      gold: '#8a5e0c', goldDeco: '#c9a24a', goldStrong: '#dcb456', onGold: '#241804',
      silver: '#5a636e', bronze: '#8a4a1e', silverStrong: '#c4cad3', onSilver: '#1d232a', bronzeStrong: '#d29a6a', onBronze: '#2a1205',
      ok: '#1d7346', okSoft: '#e2f1e7', warn: '#8a5600', warnSoft: '#f9eed6', danger: '#b02a1c', dangerSoft: '#fbe6e2',
      warnStrong: '#facc15', onWarn: '#1c1404',
      focus: '#5a2fd4',
      rtInk: { grey: '#625d6d', red: '#ba151a', orange: '#9d470d', yellow: '#785d06', green: '#106e38', cyan: '#0a697d', blue: '#1a5ab8', violet: '#6b27e0', pink: '#af196e' },
      rtHighlight: { grey: '#e6e3e9', red: '#fcddde', orange: '#fcdecb', yellow: '#fbe59e', green: '#c5eed7', cyan: '#c6ebf3', blue: '#d6e5fc', violet: '#eae0fc', pink: '#fcdbee' },
      shadowRgb: '44 26 92', scheme: 'light',
    },
    dark: {
      bg: '#0d0b1c', bg2: '#08061a', surface: '#15122a', surface2: '#1b1735', surface3: '#251f45',
      border: '#2a2450', borderStrong: '#3b3368', control: '#7168a6',
      text: '#efeaf9', text2: '#cfc8e4', muted: '#a49dc2',
      accent: '#8f6dff', accentInk: '#ad96ff', accentStrong: '#6b40ec', accentHover: '#7a52f2', onAccent: '#ffffff', accentSoft: '#241c4c',
      brandInk: '#ad96ff', brandSoft: '#241c4c',
      gold: '#e3bf66', goldDeco: '#c9a24a', goldStrong: '#dcb456', onGold: '#1c1404',
      silver: '#cdd4de', bronze: '#e39d63', silverStrong: '#c4cad3', onSilver: '#1d232a', bronzeStrong: '#d29a6a', onBronze: '#2a1205',
      ok: '#5fd394', okSoft: '#12291f', warn: '#f3bb4f', warnSoft: '#2c2210', danger: '#ff8173', dangerSoft: '#2e1418',
      warnStrong: '#f3bb4f', onWarn: '#1c1404',
      focus: '#ad96ff',
      rtInk: { grey: '#b5aec0', red: '#f69195', orange: '#f3a26d', yellow: '#eec028', green: '#39cd79', cyan: '#45c4de', blue: '#81aff5', violet: '#bb99f7', pink: '#f28dc6' },
      rtHighlight: { grey: '#34313b', red: '#532021', orange: '#482b18', yellow: '#3b3114', green: '#153925', cyan: '#14373d', blue: '#1c3354', violet: '#3a2460', pink: '#501f3b' },
      shadowRgb: '0 0 0', scheme: 'dark',
    },
  },
  ambient: {
    label: 'Ambient', blurb: 'Graphite and soft panels, with one accent colour you choose.',
    ambient: true,
    shape: { rs: '10px', rm: '14px', rl: '20px', rxl: '28px', control: '46px' },
    light: {
      bg: '#eceef2', bg2: '#e3e6eb', surface: '#fbfbfc', surface2: '#f3f4f7', surface3: '#e9ecf0',
      border: '#dce0e6', borderStrong: '#c3c9d2', control: '#78818f',
      text: '#101217', text2: '#2a2e37', muted: '#535a66',
      gold: '#835a0a', goldDeco: '#bf963f', goldStrong: '#dcb456', onGold: '#1c1404',
      silver: '#56606c', bronze: '#89481b', silverStrong: '#c4cad3', onSilver: '#1d232a', bronzeStrong: '#d29a6a', onBronze: '#2a1205',
      ok: '#17703f', okSoft: '#ddefe4', warn: '#835200', warnSoft: '#f5ead3', danger: '#b0271b', dangerSoft: '#f8e1de',
      warnStrong: '#facc15', onWarn: '#1c1404',
      brandInk: '#5631d1', brandSoft: '#ece7fd',
      rtInk: { grey: '#5a606a', red: '#ba151a', orange: '#9d470d', yellow: '#785d06', green: '#106e38', cyan: '#0a697d', blue: '#1a5ab8', violet: '#6b27e0', pink: '#af196e' },
      rtHighlight: { grey: '#e2e5e9', red: '#fcddde', orange: '#fcdecb', yellow: '#fbe59e', green: '#c5eed7', cyan: '#c6ebf3', blue: '#d6e5fc', violet: '#eae0fc', pink: '#fcdbee' },
      shadowRgb: '20 24 32', scheme: 'light',
    },
    dark: {
      bg: '#0d0e11', bg2: '#09090b', surface: '#15171c', surface2: '#1b1e24', surface3: '#23272f',
      border: '#292d35', borderStrong: '#393e49', control: '#6b7280',
      text: '#eef0f4', text2: '#c9cdd5', muted: '#9ba2ae',
      gold: '#e6c26f', goldDeco: '#bf963f', goldStrong: '#dcb456', onGold: '#1c1404',
      silver: '#d0d5dd', bronze: '#e6a06b', silverStrong: '#c4cad3', onSilver: '#1d232a', bronzeStrong: '#d29a6a', onBronze: '#2a1205',
      ok: '#62d99a', okSoft: '#11261c', warn: '#f4c25a', warnSoft: '#2a2210', danger: '#ff8378', dangerSoft: '#2d1619',
      warnStrong: '#f4c25a', onWarn: '#1c1404',
      brandInk: '#b8a4ff', brandSoft: '#1e1840',
      rtInk: { grey: '#acb2bd', red: '#f69195', orange: '#f3a26d', yellow: '#eec028', green: '#39cd79', cyan: '#45c4de', blue: '#81aff5', violet: '#bb99f7', pink: '#f28dc6' },
      rtHighlight: { grey: '#2f3239', red: '#532021', orange: '#482b18', yellow: '#3b3114', green: '#153925', cyan: '#14373d', blue: '#1c3354', violet: '#3a2460', pink: '#501f3b' },
      shadowRgb: '0 0 0', scheme: 'dark',
    },
  },
};

// Selectable ambient light colours (the Ambient look).
const ambients = {
  violet:  { label: 'Violet',  dark: { accent: '#8f72ff', accentInk: '#b8a4ff', accentStrong: '#a28aff', accentHover: '#b4a0ff', onAccent: '#0c0820', accentSoft: '#1e1840', glow: '143 114 255' },
             light: { accent: '#6a42e8', accentInk: '#5631d1', accentStrong: '#5a34d8', accentHover: '#4826b8', onAccent: '#ffffff', accentSoft: '#ece7fd', glow: '106 66 232' } },
  cyan:    { label: 'Glacier', dark: { accent: '#2fc6e6', accentInk: '#62d8f0', accentStrong: '#45cdea', accentHover: '#6fdaf0', onAccent: '#021216', accentSoft: '#0c2a31', glow: '47 198 230' },
             light: { accent: '#0089a6', accentInk: '#006b82', accentStrong: '#00718a', accentHover: '#005c70', onAccent: '#ffffff', accentSoft: '#dcf2f6', glow: '0 137 166' } },
  amber:   { label: 'Amber',   dark: { accent: '#ffab33', accentInk: '#ffc061', accentStrong: '#ffb240', accentHover: '#ffc261', onAccent: '#170c00', accentSoft: '#2e2110', glow: '255 171 51' },
             light: { accent: '#c46f00', accentInk: '#8a5000', accentStrong: '#8f5300', accentHover: '#744300', onAccent: '#ffffff', accentSoft: '#f7e8d0', glow: '196 111 0' } },
  rose:    { label: 'Rose',    dark: { accent: '#ff6f9a', accentInk: '#ff93b4', accentStrong: '#ff7ea4', accentHover: '#ff9ab8', onAccent: '#1a0710', accentSoft: '#33121f', glow: '255 111 154' },
             light: { accent: '#d33a68', accentInk: '#ac2550', accentStrong: '#ac2550', accentHover: '#8f1d42', onAccent: '#ffffff', accentSoft: '#fbe1ea', glow: '211 58 104' } },
  emerald: { label: 'Emerald', dark: { accent: '#34d08a', accentInk: '#62e0a6', accentStrong: '#45d595', accentHover: '#6de2ad', onAccent: '#021a0e', accentSoft: '#0e2b1f', glow: '52 208 138' },
             light: { accent: '#0f8a55', accentInk: '#0b6c43', accentStrong: '#0b6c43', accentHover: '#085535', onAccent: '#ffffff', accentSoft: '#dcf2e7', glow: '15 138 85' } },
  ice:     { label: 'Ice',     dark: { accent: '#6cc0ff', accentInk: '#93d2ff', accentStrong: '#7cc7ff', accentHover: '#9ad5ff', onAccent: '#03111d', accentSoft: '#11243a', glow: '108 192 255' },
             light: { accent: '#1676c2', accentInk: '#0d5f9e', accentStrong: '#0d62a3', accentHover: '#0a4f85', onAccent: '#ffffff', accentSoft: '#dfeefa', glow: '22 118 194' } },
};

module.exports = { looks, ambients };
