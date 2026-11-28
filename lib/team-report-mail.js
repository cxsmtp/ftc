"use strict";

// THE EVENT TEAM'S EMAILS — what each persona is told, and how it is drawn.
// (The data: lib/event-team.js. The queue and the sends: lib/team-reports.js.)
//
// One report per persona: `{subject, intro, cta, blocks, foot, csv}`. `cta` is the
// ONE link of the email, and says what to do next; `why` beside it says why. A
// recipient whose address cannot open the event is sent no link at all, and is
// told the step in words they can act on (`renderMail`, operator ruling 79):
// `cta.textNoLink` wherever the button's words need the event's page. Every
// block renders to BOTH parts of the mail, so the plain text cannot drift from the
// HTML, and every dynamic value passes `E` here and nowhere else. The look: table
// layout with inline styles for mail clients, colours stated on every cell, a
// `prefers-color-scheme: dark` sheet for the clients that honour it, no external
// image or font.

const { escapeHtml } = require("./sanitise");
const { BASE_URL } = require("./config");
const T = require("./event-team");
const { suggestedOpener } = require("./qualifying");

const E = (s) => escapeHtml(String(s == null ? "" : s));

// ─────────────────────────────────────────────────────────────────────────────
// The palette (the mock-up's) and the dark sheet
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  bg: "#f5f4fb", card: "#ffffff", panel: "#efedf8", line: "#dedbec", fg: "#1c1a2b", muted: "#5c5874",
  accent: "#5a3df0", accentInk: "#4a2fd6", onAccent: "#ffffff", soft: "#ebe6ff",
};
const TONES = {
  hot: ["#fde8e6", "#b42318"], warm: ["#fff1d6", "#9a5b00"], cold: ["#e3eefa", "#35618f"],
  new: ["#dff3e6", "#17663a"], ret: ["#ebe6ff", "#4a2fd6"], dup: ["#fff1d6", "#9a5b00"],
  ok: ["#dff3e6", "#17663a"], pending: ["#e3eefa", "#35618f"],
};
// Single quotes only: these land inside style="…" attributes.
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;

const DARK_SHEET = `@media (prefers-color-scheme: dark){
.m-bg{background:#12111a!important}
.m-card{background:#1f1e2b!important;border-color:#353247!important}
.m-fg{color:#ecebf5!important}
.m-muted{color:#a9a5c0!important}
.m-panel{background:#23212f!important;border-color:#353247!important}
.m-line{border-color:#353247!important}
.m-soft{background:#2a2448!important;border-color:#353247!important}
.m-btn{background:#8b74ff!important}
.m-btn-a{color:#14102e!important}
.m-fill{background:#8b74ff!important}
.m-p-hot{background:#3d1c1a!important;color:#ff8a80!important}
.m-p-warm,.m-p-dup{background:#3a2c12!important;color:#f2c062!important}
.m-p-cold,.m-p-pending{background:#17283b!important;color:#8fc0f2!important}
.m-p-new,.m-p-ok{background:#173023!important;color:#7fd8a1!important}
.m-p-ret{background:#2a2448!important;color:#b3a4ff!important}
}
@media (max-width:600px){
.m-pad{padding-left:14px!important;padding-right:14px!important}
.m-tbl th,.m-tbl td{padding:6px!important;font-size:12px!important;letter-spacing:0!important}
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Blocks: each is {html, text}
// ─────────────────────────────────────────────────────────────────────────────

const _p = `margin:0;font-family:${FONT};font-size:15px;line-height:22px;color:${C.fg}`;

/** Inline text: a list of strings and {b: string} (bold). */
function _inline(parts) {
  const list = Array.isArray(parts) ? parts : [parts];
  return {
    html: list.map(x => (x && typeof x === "object" ? `<strong>${E(x.b)}</strong>` : E(x))).join(""),
    text: list.map(x => (x && typeof x === "object" ? String(x.b) : String(x))).join(""),
  };
}

function para(parts) {
  const i = _inline(parts);
  return { html: `<p class="m-fg" style="${_p}">${i.html}</p>`, text: i.text };
}

// Tiles flow rather than sit in table cells: four to a row on a wide screen, two
// on a phone, with no media query (a mail client may strip the sheet).
function kpis(items) {
  const tile = (k) => `<div class="m-panel" style="display:inline-block;vertical-align:top;width:108px;min-height:58px;margin:3px;background:${C.panel};border:1px solid ${C.line};border-radius:8px;padding:10px 12px">
    <div class="m-fg" style="font-family:${MONO};font-size:22px;line-height:26px;font-weight:700;color:${C.fg};white-space:nowrap">${E(k.n)}</div>
    <div class="m-muted" style="font-family:${FONT};font-size:12px;line-height:16px;color:${C.muted}">${E(k.l)}</div>
    ${k.d ? `<div class="m-p-ok" style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:600;color:${TONES.ok[1]}">${E(k.d)}</div>` : ""}
  </div>`;
  return {
    html: `<div>${items.map(tile).join("")}</div>`,
    text: items.map(k => `${k.n} ${k.l}${k.d ? ` (${k.d})` : ""}`).join(" · "),
  };
}

function heading(title) {
  return {
    html: `<p class="m-muted" style="margin:0;font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${C.muted}">${E(title)}</p>`,
    text: String(title).toUpperCase(),
  };
}

function pillHtml(tone, text) {
  const [bg, fg] = TONES[tone] || TONES.cold;
  return `<span class="m-p-${E(tone)}" style="display:inline-block;background:${bg};color:${fg};font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap">${E(text)}</span>`;
}

/** One question's answers, drawn to scale of those who answered it. */
function bars(title, rows, unanswered) {
  const total = rows.reduce((a, r) => a + r.n, 0);
  const row = (r) => {
    const pct = total ? Math.round((r.n / total) * 100) : 0;
    const fill = pct > 0
      ? `<td class="m-fill" width="${pct}%" height="12" bgcolor="${C.accent}" style="width:${pct}%;height:12px;background:${C.accent};border-radius:6px;font-size:0;line-height:0">&nbsp;</td>${pct < 100 ? `<td style="font-size:0;line-height:0">&nbsp;</td>` : ""}`
      : `<td style="font-size:0;line-height:0">&nbsp;</td>`;
    return `<tr>
      <td class="m-fg" width="130" style="width:130px;padding:3px 10px 3px 0;font-family:${FONT};font-size:13px;line-height:18px;color:${C.fg}">${E(r.label)}</td>
      <td style="padding:3px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="m-panel" bgcolor="${C.panel}" style="width:100%;height:12px;background:${C.panel};border-radius:6px"><tr>${fill}</tr></table></td>
      <td class="m-fg" width="44" align="right" style="width:44px;padding:3px 0 3px 10px;font-family:${MONO};font-size:13px;line-height:18px;color:${C.fg}">${E(r.n)}</td>
    </tr>`;
  };
  return {
    html: `${heading(title).html}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-top:6px">${rows.map(row).join("")}</table>${
      unanswered ? `<p class="m-muted" style="margin:4px 0 0;font-family:${FONT};font-size:12px;line-height:16px;color:${C.muted}">Not answered: ${E(unanswered)}</p>` : ""}`,
    text: `${title}\n${rows.map(r => `  ${r.label}: ${r.n}`).join("\n")}${unanswered ? `\n  Not answered: ${unanswered}` : ""}`,
  };
}

/** Something that needs attention: a left bar in the tone's colour. */
function flag(tone, head, body) {
  const edge = (TONES[tone] || TONES.warm)[1];
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="m-card" bgcolor="${C.card}" style="width:100%;background:${C.card};border:1px solid ${C.line};border-left:4px solid ${edge};border-radius:8px"><tr><td style="padding:10px 14px">
      <p class="m-fg" style="margin:0;font-family:${FONT};font-size:14px;line-height:20px;font-weight:700;color:${C.fg}">${E(head)}</p>
      <p class="m-fg" style="margin:2px 0 0;font-family:${FONT};font-size:14px;line-height:20px;color:${C.fg}">${E(body)}</p>
    </td></tr></table>`,
    text: `${head}. ${body}`,
  };
}

function _cellHtml(c) {
  if (c && typeof c === "object" && c.pill) return (c.before != null ? `${E(c.before)} ` : "") + pillHtml(c.pill, c.text) + (c.note ? ` <span class="m-muted" style="color:${C.muted}">${E(c.note)}</span>` : "");
  if (c && typeof c === "object" && c.lines) return c.lines.filter(Boolean).map((l, i) => (i === 0 ? `<strong>${E(l)}</strong>` : `<br/><span class="m-muted" style="color:${C.muted}">${E(l)}</span>`)).join("");
  if (c && typeof c === "object" && c.plain) return c.plain.filter(Boolean).map(E).join("<br/>");
  return E(c);
}
function _cellText(c) {
  if (c && typeof c === "object" && c.pill) return `${c.before != null ? `${c.before} ` : ""}${c.text}${c.note ? ` ${c.note}` : ""}`;
  if (c && typeof c === "object" && c.lines) return c.lines.filter(Boolean).join(", ");
  if (c && typeof c === "object" && c.plain) return c.plain.filter(Boolean).join(", ");
  return String(c == null ? "" : c);
}

function table(headers, rows) {
  const th = `padding:8px;border-bottom:1px solid ${C.line};background:${C.panel};font-family:${FONT};font-size:11px;line-height:14px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${C.muted};text-align:left`;
  const td = `padding:8px;border-bottom:1px solid ${C.line};font-family:${FONT};font-size:13px;line-height:18px;color:${C.fg};vertical-align:top;word-break:break-word`;
  return {
    html: `<table width="100%" cellpadding="0" cellspacing="0" border="0" class="m-card m-tbl" bgcolor="${C.card}" style="width:100%;border-collapse:separate;border-spacing:0;background:${C.card};border:1px solid ${C.line};border-radius:8px;overflow:hidden">
      <thead><tr>${headers.map(h => `<th class="m-panel m-muted" bgcolor="${C.panel}" style="${th}">${E(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map(c => `<td class="m-fg m-line" style="${td}">${_cellHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>`,
    text: rows.map(r => r.map((c, i) => (headers[i] ? `${headers[i]}: ${_cellText(c)}` : _cellText(c))).filter(s => !/: $/.test(s)).join(" | ")).join("\n"),
  };
}

/** Stack blocks under a section heading (one block in the mail's flow). */
function section(title, blocks) {
  const inner = blocks.map(b => `<div style="margin-top:8px">${b.html}</div>`).join("");
  return { html: `${heading(title).html}${inner}`, text: `${String(title).toUpperCase()}\n${blocks.map(b => b.text).join("\n")}` };
}

// A lead's place, on the board the event ranks them on (lib/event-team.js
// `buildReportData`): "ranked 2", "ranked 1 in Evening" where sessions are ranked
// apart, "ranked 1 among late entrants" on the late entrants' board.
function rankPhrase(l) {
  if (!l.rank) return "";
  return `ranked ${l.rank}${l.rank_session ? ` in ${l.rank_session}` : (l.rank_late ? " among late entrants" : "")}`;
}

// A podium group's heading: one per board the event ranks on (`podium` groups).
function podiumHeading(g) {
  return g.session ? `Podium, ${g.session}` : (g.late ? "Podium, late entrants" : "Podium");
}

function leadCard(l, qs, eventName) {
  const SIGNAL = { hot: "Hot", warm: "Warm", cold: "Cold" };
  const answered = qs.filter(q => l.answers[q.key]);
  const chips = answered.map(q => `<span class="m-panel m-fg" style="display:inline-block;margin:2px 4px 2px 0;padding:3px 9px;background:${C.panel};border:1px solid ${C.line};border-radius:8px;font-family:${FONT};font-size:12px;line-height:16px;color:${C.fg}">${E(q.title)} <strong>${E(l.answers[q.key])}</strong></span>`).join("");
  const did = [rankPhrase(l), l.solved ? `solved ${l.solved}` : (l.played ? "answered the questions" : "did not answer anything"),
    l.struggles.length ? `struggled with ${l.struggles.slice(0, 3).join(", ")}` : ""].filter(Boolean).join(", ");
  const free = l.free_text.map(f => `${f.title}: "${f.answer}"`).join("; ");
  const opener = suggestedOpener(l, eventName);
  const who = `${_name(l)}${l.title ? ` — ${l.title}` : ""}${l.company ? `, ${l.company}` : ""}`;
  const small = `margin:6px 0 0;font-family:${FONT};font-size:13px;line-height:19px;color:${C.fg}`;
  // Operator ruling 79 (14 Nov 2026) — the lead's address, so an SDR can reach
  // them from the email itself: plain text (the call to action stays the mail's
  // only link), broken anywhere so a long one fits a phone.
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="m-card" bgcolor="${C.card}" style="width:100%;background:${C.card};border:1px solid ${C.line};border-radius:8px"><tr><td style="padding:12px 14px">
      <p class="m-fg" style="margin:0;font-family:${FONT};font-size:14px;line-height:20px;color:${C.fg}"><strong>${E(who)}</strong> ${pillHtml(l.signal, SIGNAL[l.signal])}${l.opted_out ? ` ${pillHtml("dup", "Do not email")}` : ""}</p>
      <p class="m-fg" style="${small};word-break:break-all">Email: ${E(l.email)}</p>
      ${chips ? `<p style="margin:6px 0 0">${chips}</p>` : ""}
      <p class="m-fg" style="${small}">What they did: ${E(did)}. Source: ${E(l.source)}.</p>
      ${free ? `<p class="m-fg" style="${small}">In their own words: ${E(free)}</p>` : ""}
      <p class="m-fg" style="${small}"><strong>Suggested opener:</strong> ${E(opener)}</p>
    </td></tr></table>`,
    text: [`${who} · ${SIGNAL[l.signal]}${l.opted_out ? " · do not email" : ""}`,
      `Email: ${l.email}`,
      ...answered.map(q => `${q.title} ${l.answers[q.key]}`),
      `What they did: ${did}. Source: ${l.source}.`,
      ...(free ? [`In their own words: ${free}`] : []),
      `Suggested opener: ${opener}`].join("\n"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The document
// ─────────────────────────────────────────────────────────────────────────────

/** Every team report's footer says how a recipient stops it: no link, words. */
const STOP_LINE = "To stop receiving these, ask the event's organiser to remove you.";

/**
 * The sentence a recipient with no way into the event's page reads where the
 * button would be (operator ruling 79, 14 Nov 2026): no dead button, words.
 */
function noLinkSentence(platformName, withFile) {
  return `This email has no link: your address is not an account that can open this event on ${platformName}. Everything here is yours to act on${withFile ? ", with the file attached" : ""}; for anything that needs the event's page, ask the event's organiser.`;
}

/**
 * A report plus who gets it → {html, text}. The CTA is the only link — and only
 * for a recipient whose address opens the event (`opts.link`, lib/event-team.js
 * `memberOpensEvent`; operator ruling 79, 14 Nov 2026). Anyone else is told the
 * next step in words they can act on without the page (`cta.textNoLink` where
 * the button's words need it), with no button and no address to follow.
 */
function renderMail(platformName, eventName, member, r, roleLabel, opts = {}) {
  const link = opts.link !== false;
  const pad = (html, bottom = 18) => `<tr><td class="m-pad" style="padding:0 24px ${bottom}px">${html}</td></tr>`;
  const why = _inline(r.cta.why || []);
  const url = E(r.cta.url);
  const noLink = noLinkSentence(platformName, !!r.csv);
  // The step without a link: the button's own words where they need no page
  // ("Contact Ann Lee first"), else `textNoLink` ("Load the attached file … into
  // the CRM" for "Download the CRM file …"): never a step that needs the page.
  const step = r.cta.textNoLink || r.cta.text;
  const ctaHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="m-soft" bgcolor="${C.soft}" style="width:100%;background:${C.soft};border:1px solid ${C.line};border-radius:8px"><tr><td style="padding:16px">
      ${why.html ? `<p class="m-fg" style="margin:0 0 12px;font-family:${FONT};font-size:15px;line-height:22px;color:${C.fg}">${why.html}</p>` : ""}
      ${link ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="m-btn" bgcolor="${C.accent}" style="background:${C.accent};border-radius:8px">
        <a class="m-btn-a" href="${url}" style="display:inline-block;padding:13px 22px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:700;color:${C.onAccent};text-decoration:none;border-radius:8px">${E(r.cta.text)}</a>
      </td></tr></table>
      <p class="m-muted" style="margin:10px 0 0;font-family:${FONT};font-size:12px;line-height:16px;color:${C.muted};word-break:break-all">Address (sign-in needed): ${url}</p>`
      : `<p class="m-fg m-next" style="margin:0;font-family:${FONT};font-size:16px;line-height:22px;font-weight:700;color:${C.fg}">Next: ${E(step)}.</p>
      <p class="m-muted" style="margin:10px 0 0;font-family:${FONT};font-size:12px;line-height:16px;color:${C.muted}">${E(noLink)}</p>`}
    </td></tr></table>`;
  // Internal staff mail, so transactional: no unsubscribe link (operator ruling,
  // 24 Nov 2026); the footer says, in words, how a recipient stops it.
  const note = `You receive this as ${roleLabel} on the event team of ${eventName}, set in the event's Team & reports section. ${STOP_LINE}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light dark"/><meta name="supported-color-schemes" content="light dark"/>
<title>${E(r.subject)}</title><style>${DARK_SHEET}</style></head>
<body class="m-bg" style="margin:0;padding:0;background:${C.bg}">
<table role="presentation" class="m-bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="width:100%;background:${C.bg}"><tr><td align="center" style="padding:24px 10px">
<table role="presentation" class="m-card" width="640" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="width:100%;max-width:640px;background:${C.card};border:1px solid ${C.line};border-radius:12px">
<tr><td class="m-panel" bgcolor="${C.panel}" style="padding:14px 24px;background:${C.panel};border-bottom:1px solid ${C.line};border-radius:12px 12px 0 0">
  <p class="m-muted" style="margin:0;font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${C.muted}">${E(platformName)}</p>
  <p class="m-fg" style="margin:2px 0 0;font-family:${FONT};font-size:17px;line-height:24px;font-weight:700;color:${C.fg}">${E(eventName)}</p>
</td></tr>
<tr><td style="padding:20px 24px 12px"><p class="m-fg" style="${_p}">Hi ${E(member.name)},</p>${r.intro ? `<p class="m-fg" style="${_p};margin-top:4px">${E(r.intro)}</p>` : ""}</td></tr>
${pad(ctaHtml)}
${r.blocks.map(b => pad(b.html)).join("\n")}
<tr><td class="m-line" style="padding:12px 24px 18px;border-top:1px solid ${C.line}">
  <p class="m-muted" style="margin:0;font-family:${FONT};font-size:12px;line-height:17px;color:${C.muted}">${r.foot ? `${E(r.foot)} ` : ""}${E(note)}</p>
  <p class="m-muted" style="margin:6px 0 0;font-family:${FONT};font-size:12px;line-height:17px;color:${C.muted}">&#8212; The ${E(platformName)} Team</p>
</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    platformName, eventName, "", `Hi ${member.name},`, ...(r.intro ? [r.intro] : []), "",
    ...(why.text ? [why.text] : []),
    ...(link ? [r.cta.text, `Address (sign-in needed): ${r.cta.url}`] : [`Next: ${step}.`, noLink]), "",
    ...r.blocks.flatMap(b => [b.text, ""]),
    ...(r.foot ? [r.foot] : []), note, "", `-- The ${platformName} Team`,
  ].join("\n");
  return { html, text };
}

/**
 * What the in-app preview draws: the same mail, minus the dark sheet (the app's
 * CSP refuses a <style> element in the frame, so leaving it in would report a
 * violation per preview; every colour above is inline). The link opens a new tab
 * target rather than navigating the frame.
 */
function previewHtml(html) {
  return String(html).replace(/<style>[\s\S]*?<\/style>/, "").replace("<head>", `<head><base target="_blank"/>`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The personas
// ─────────────────────────────────────────────────────────────────────────────

const SIGNAL = { hot: "Hot", warm: "Warm", cold: "Cold" };
const STATUS = { new: "New", returning: "Returning", possible_duplicate: "Possible duplicate" };
const STATUS_TONE = { new: "new", returning: "ret", possible_duplicate: "dup" };

// Two answers in one cell: three columns fit a phone with or without the sheet.
function _toldUs(answers) {
  const a = answers || {};
  return { plain: [`Developers: ${a.developers || "—"}`, `Evaluating: ${a.evaluating || "—"}`] };
}

function wsLink(compId, section) {
  return `${BASE_URL}/?event=${encodeURIComponent(compId)}&section=${encodeURIComponent(section)}`;
}
function _pct(x) { return x == null ? "—" : `${Math.round(x * 100)}%`; }
function _name(l) { return `${l.first_name || ""} ${l.last_name || ""}`.trim() || l.email; }
// A count's noun, singular for exactly one ("1 lead", "1 company", "0 people"):
// every count label goes through it, a KPI tile's label (the number drawn above
// it) included.
function _noun(n, one, many) { return n === 1 ? one : (many || `${one}s`); }
function _plural(n, one, many) { return `${n} ${_noun(n, one, many)}`; }

/** Why this challenge needs fixing: the rate, then the repeated wrong answer. */
function _worstWhy(w) {
  const rate = `${w.solve_rate < 0.5 ? "Only " : ""}${_pct(w.solve_rate)} solved it (${w.solvers} of ${w.attempters})`;
  if (!w.top_wrong) return `${rate}, with ${_plural(w.wrong, "wrong answer")}.`;
  if (w.top_wrong.text == null) return `${rate}, and ${w.top_wrong.count} of the wrong answers were the same (a sealed question, so not quoted). The question may read two ways.`;
  return `${rate}, and ${w.top_wrong.count} of the wrong answers were the same: "${w.top_wrong.text}". The question may read two ways.`;
}

function seReport(data) {
  const c = data.comp, s = T.summarise(data);
  const bounced = data.certificates.bounced;
  const flagged = data.challenges.filter(x => x.flag);
  const low = data.challenges.filter(x => x.low_ratings > 0);
  const ended = c.status === "ended";
  const easy = !data.worst ? flagged[0] : null;
  let cta;
  if (data.worst) {
    cta = { url: wsLink(c.id, "challenges"), text: `Edit "${data.worst.title}"`, textNoLink: `Ask the event's organiser to edit "${data.worst.title}"`, why: [{ b: `Fix "${data.worst.title}". ` }, _worstWhy(data.worst)] };
  } else if (easy) {
    cta = { url: wsLink(c.id, "challenges"), text: `Edit "${easy.title}"`, textNoLink: `Ask the event's organiser to edit "${easy.title}"`,
      why: [{ b: `Look at "${easy.title}". ` }, `${_pct(easy.solve_rate)} of ${easy.attempters} solved it, so it separates nobody. Raise the difficulty or swap it before you reuse this event.`] };
  } else if (bounced) {
    cta = { url: wsLink(c.id, "certificates"), text: `Resend ${_plural(bounced, "certificate email")}`,
      textNoLink: `Ask the event's organiser to resend ${bounced === 1 ? "the certificate email" : `the ${bounced} certificate emails`}`,
      why: [{ b: `${_plural(bounced, "certificate email")} did not arrive. ` }, "The certificates are issued; only the email is missing."] };
  } else {
    cta = { url: wsLink(c.id, "overview"), text: ended ? "Clone for the next event" : "Review the event",
      textNoLink: ended ? "Ask the event's organiser to clone it for the next event" : "Read the figures below",
      why: [{ b: "Nothing needs fixing. " }, "No question was flagged and no certificate email bounced."] };
  }
  const blocks = [];
  const tiles = [{ n: s.joined, l: "joined" }, { n: s.played, l: `played${s.joined ? ` (${_pct(s.played / s.joined)})` : ""}` }];
  if (s.avg_solve_rate != null) tiles.push({ n: _pct(s.avg_solve_rate), l: "average solve rate" });
  if (s.avg_rating != null) tiles.push({ n: `${s.avg_rating.toFixed(1)} of 5`, l: "question rating" });
  blocks.push(kpis(tiles));
  const attention = [];
  if (bounced && cta.url !== wsLink(c.id, "certificates")) attention.push(flag("hot", `${_plural(bounced, "certificate email")} did not arrive`, "The certificates are issued; resend the email from the event's Certificates section."));
  for (const x of flagged) {
    if (data.worst && x.id === data.worst.id) continue;
    if (easy && x.id === easy.id) continue;
    attention.push(flag("warm", `"${x.title}": ${_pct(x.solve_rate)} of ${x.attempters} solved it`, x.flag === "too_easy" ? "Too easy to separate anyone." : "Too hard: check the question reads one way."));
  }
  for (const x of low) attention.push(flag("warm", `"${x.title}": ${x.low_ratings} low of ${_plural(x.ratings, "rating")}`, `Average ${x.avg_rating.toFixed(1)} of 5. Ratings carry no comment.`));
  if (attention.length) blocks.push(section("Needs your attention", attention));
  if (data.challenges.length) {
    blocks.push(section("Every question", [table(["Question", "Solved", "Wrong", "Rating"],
      data.challenges.map(x => [x.title, `${x.solvers} of ${x.attempters} (${_pct(x.solve_rate)})`, x.wrong, x.ratings ? x.avg_rating.toFixed(1) : "—"]))]));
  }
  for (const g of data.podium) blocks.push(para(`${podiumHeading(g)}: ${g.places.map(p => `${p.rank}. ${p.name}${p.company ? ` (${p.company})` : ""}, ${_plural(p.score, "point")}`).join("; ")}.`));
  blocks.push(para(`Certificates: ${data.certificates.issued} issued, ${data.certificates.delivered} delivered by email.`));
  const toFix = new Set([...(data.worst ? [data.worst.id] : []), ...flagged.map(x => x.id)]).size;
  const look = toFix ? _plural(toFix, "question") + " to look at" : "no question to fix";
  return {
    subject: `${c.name} ${ended ? "is over" : "so far"}: ${s.played} played, ${look}`,
    intro: `Here is how your event ran${ended ? " and what to change before you run it again" : " so far"}.`,
    cta, blocks,
  };
}

function marketingReport(data, leads, { delta = false } = {}) {
  const c = data.comp, tgt = data.targets;
  // An update is about its new leads alone, so the people who declined are not its figures.
  const s = T.summarise({ ...data, leads, declined: delta ? [] : (data.declined || []) });
  const n = leads.length;
  const hot = leads.filter(l => l.signal === "hot" && !l.opted_out);
  const optedOut = s.opted_out ? ` ${s.opted_out === 1 ? "1 person has" : `${s.opted_out} people have`} opted out of our email; their ${s.opted_out === 1 ? "row is" : "rows are"} marked "do not email".` : "";
  const cta = n
    ? { url: wsLink(c.id, "team"),
        text: delta ? `Download the ${_plural(n, "new lead")}` : `Download the CRM file (${_plural(n, "lead")})`,
        textNoLink: `Load the attached file (${_plural(n, delta ? "new lead" : "lead")}) into the CRM`,
        why: delta
          ? [{ b: `Add the ${_plural(n, "new lead")} to the CRM. ` }, `The attached file holds just ${n === 1 ? "this one" : `these ${n}`}, so nothing is imported twice.${optedOut}`]
          : [{ b: `Load ${_plural(n, "lead")} into the CRM today. ` }, `The file is attached, one row per person.${optedOut}${s.declined ? ` ${s.declined === 1 ? "1 person" : `${s.declined} people`} answered No to a follow-up and ${s.declined === 1 ? "is" : "are"} left out.` : ""}`] }
    // Operator ruling, 14 Nov 2026 — said once: the intro (below) already says
    // nobody has taken part, so the reason does not repeat it, and it still
    // reads on its own in the in-app Marketing view, which shows no intro.
    : { url: wsLink(c.id, "team"), text: "Open the lead list", textNoLink: "Nothing to load yet", why: [{ b: "No leads yet. " }, "The list fills as people take part."] };
  const blocks = [];
  const tiles = [
    { n: s.leads, l: _noun(s.leads, delta ? "new lead" : "lead"), d: !delta && tgt.lead_target ? `${Math.round((s.leads / tgt.lead_target) * 100)}% of target ${tgt.lead_target}` : null },
    { n: s.new, l: "brand new" }, { n: s.returning, l: "returning" },
    { n: s.hot, l: "hot", d: !delta && tgt.hot_lead_target != null ? `target ${tgt.hot_lead_target}` : null },
    { n: s.warm, l: "warm" }, { n: s.cold, l: "cold" },
  ];
  if (s.possible_duplicate) tiles.push({ n: s.possible_duplicate, l: _noun(s.possible_duplicate, "possible duplicate") });
  blocks.push(kpis(tiles));
  if (s.possible_duplicate) blocks.push(para(`${_plural(s.possible_duplicate, "person", "people")} ${s.possible_duplicate === 1 ? "shares" : "share"} a name and company with someone else under another address. Check before importing; nothing was merged.`));
  for (const b of s.breakdown) blocks.push(bars(b.title, b.counts.map(x => ({ label: x.text, n: x.n })), b.unanswered));
  if (hot.length) {
    blocks.push(section("Top hot leads", [table(["Lead", "Told us", "Status"],
      hot.slice(0, 10).map(l => [{ lines: [_name(l), [l.title, l.company].filter(Boolean).join(", "), `Source: ${l.source}${l.other_events.length ? `. Also: ${l.other_events.slice(0, 3).join(", ")}` : ""}`] }, _toldUs(l.answers),
        { pill: STATUS_TONE[l.status], text: STATUS[l.status] }]))]));
  }
  const subject = delta
    ? `${c.name}: ${_plural(s.leads, "new lead")} since the last report (${s.new} new to us, ${s.hot} hot)`
    : `${_plural(s.leads, "lead")} from ${c.name}: ${s.new} new, ${s.hot} hot${tgt.hot_lead_target != null ? ` (target was ${tgt.hot_lead_target})` : ""}`;
  // Operator ruling, 14 Nov 2026 — with no leads there is no file: nothing is
  // attached, the intro says nobody has taken part, and every sentence about
  // the file goes with it (the CSV foot here; `renderMail`'s no-link sentence
  // asks `csv`). With leads, the file, the intro and the foot stand.
  return {
    subject, cta, blocks, csv: n > 0,
    intro: delta ? "Only what changed since the last report is below."
      : n ? "The leads are ready for your CRM." : "Nobody has taken part yet, so there are no leads to load.",
    ...(n ? { foot: "The CSV has one row per person: name, title, company, country, email, every qualifying answer, hot/warm/cold, new or returning, first-seen event and source, opted-out flag and score." } : {}),
  };
}

function salesReport(data, leads, { delta = false } = {}) {
  const c = data.comp;
  const accts = T.accountsOf(leads).filter(a => a.signal !== "cold" || a.people > 1);
  const top = accts[0];
  const ready = accts.filter(a => a.signal === "hot").length;
  let cta = { url: wsLink(c.id, "team"), text: "Open the accounts", textNoLink: "Nothing to plan yet", why: [{ b: "No account showed buying signals yet." }] };
  if (top) {
    const bits = [`${_plural(top.people, "person", "people")} joined${top.top_title ? `, including their ${top.top_title}` : ""}`];
    const pos = top.positions || {}, ans = top.answers || {};
    if (ans.developers) bits.push(`${ans.developers} developers`);
    if (Number.isInteger(pos.evaluating) && pos.evaluating >= 1 && ans.evaluating) bits.push(`evaluating an AppSec solution (${String(ans.evaluating).replace(/^\s*yes\s*,?\s*/i, "")})`);
    if (pos.follow_up === 0) bits.push("asked for a follow-up");
    cta = { url: wsLink(c.id, "team"), text: top.signal === "hot" ? `Plan the ${top.company} meeting` : `Review ${top.company}`,
      why: [{ b: `${top.company} is the strongest account. ` }, `${bits.join("; ")}.`] };
  }
  const blocks = [kpis([{ n: accts.length, l: _noun(accts.length, "company", "companies") }, { n: ready, l: "ready for a meeting" },
    { n: leads.length, l: delta ? _noun(leads.length, "new person", "new people") : _noun(leads.length, "person", "people") }])];
  if (accts.length) {
    blocks.push(section(delta ? "Accounts with new people" : "Accounts, most ready first", [table(["Company", "Told us", "Signal"],
      accts.slice(0, 15).map(a => [{ lines: [a.company, _plural(a.people, "person", "people"), a.top_title ? `Most senior: ${a.top_title}` : ""] }, _toldUs(a.answers), { pill: a.signal, text: SIGNAL[a.signal] }]))]));
  }
  return {
    subject: `${_plural(accts.length, "account")} engaged at ${c.name}: ${ready} ready for a meeting`,
    intro: "These are the companies that showed up, ranked by how ready they look.", cta, blocks,
  };
}

function sdrReport(data, myLeads, { delta = false, nudge = false, file = false } = {}) {
  const c = data.comp;
  const rank = { hot: 3, warm: 2, cold: 1 };
  const ls = myLeads.slice().sort((a, b) => rank[b.signal] - rank[a.signal] || b.seniority - a.seniority);
  const hotN = ls.filter(l => l.signal === "hot").length;
  // Waiting means somebody may still reach them (lib/event-team.js
  // `isContactable`: not contacted, not opted out), as the 48 h reminder counts.
  const waiting = ls.filter(l => l.signal === "hot" && T.isContactable(l)).length;
  const first = ls.find(l => l.signal === "hot" && T.isContactable(l)) || ls.find(T.isContactable);
  const cta = first
    ? { url: wsLink(c.id, "team"), text: `Contact ${_name(first)} first`,
        why: waiting
          ? [{ b: `Contact the ${_plural(waiting, "hot lead")} within 48 hours. ` }, "Leads go cold fast. Ask an organiser to mark each one contacted once you have reached out, and the reminder stops."]
          : [{ b: `Start with ${_name(first)}. ` }, `${hotN ? "Every hot lead of yours is marked contacted or has opted out, so this is the place to start"
            : first.signal === "warm" ? "A warm lead, and the strongest you have" : "None of yours is hot, so this is the place to start"}.`] }
    : { url: wsLink(c.id, "team"), text: "Open your leads", textNoLink: "Nothing to follow up for now", why: [{ b: "Nothing is waiting. " }, "Everyone here is marked contacted or has opted out."] };
  const blocks = [];
  blocks.push(para(nudge
    ? [{ b: `${_plural(waiting, "hot lead")} from ${c.name} ${waiting === 1 ? "is" : "are"} waiting to be contacted.` }]
    : [{ b: `${delta ? "New leads for you" : "Your leads"}: ` }, `${ls.length} (${hotN} hot).`]));
  for (const l of ls.filter(x => !x.contacted_at)) blocks.push(leadCard(l, data.qualifying, c.name));
  const subject = nudge ? `Reminder: ${_plural(waiting, "hot lead")} waiting from ${c.name}`
    : delta ? `New leads for you from ${c.name}`
    : `Your ${_plural(ls.length, "follow-up")} from ${c.name}${waiting ? `: call the ${waiting} hot first` : ""}`;
  // Operator ruling 79 (14 Nov 2026) — an SDR's report attaches a file of
  // THEIR OWN leads (`file`; lib/team-reports.js `composeRun` fills it with this
  // share, never the event's). Marketing standing in for an event with no SDR
  // gets none here: its own report already attaches every lead (the CRM file).
  // The 48 h reminder carries none: its cards hold each address, and the file
  // came with the report it follows up.
  const withFile = file && !nudge;
  return {
    subject, cta, blocks, csv: withFile,
    intro: "Each card says what they told us and what they did, so the first call does not start cold.",
    ...(withFile ? { foot: `The attached file holds ${ls.length === 1 ? "this lead" : `these ${ls.length} leads`}, one row per person, with the same columns as the CRM file.` } : {}),
  };
}

function managerReport(data, owners, peer) {
  const c = data.comp, tgt = data.targets;
  const s = T.summarise(data);
  const ownerIds = new Set(owners.map(o => o.id));
  // Waiting means somebody may still reach them (lib/event-team.js
  // `isContactable`: not contacted, not opted out), as the SDR's report and the
  // 48 h reminder count (operator ruling, 14 Nov 2026): a hot lead who opted out
  // is not waiting, so it is neither "still to contact" nor one to assign.
  const toContact = data.leads.filter(l => l.signal === "hot" && T.isContactable(l));
  const unowned = toContact.filter(l => !l.owner_member_id || !ownerIds.has(l.owner_member_id));
  const cta = unowned.length
    ? { url: wsLink(c.id, "team"), text: `Assign the ${_plural(unowned.length, "hot lead")}`,
        textNoLink: "Ask the event's organiser to add an SDR or a Marketing owner",
        why: [{ b: `${_plural(unowned.length, "hot lead")} still to contact ${unowned.length === 1 ? "has" : "have"} no owner yet. ` }, "Add an SDR or a Marketing owner to the event team so they are contacted."] }
    : { url: wsLink(c.id, "team"), text: "Open the event report", textNoLink: "Read the scorecard below",
        why: toContact.length
          ? [{ b: `Every hot lead still to contact has an owner. ` }, `${_plural(toContact.length, "is", "are")} still waiting to be contacted.`]
          : [{ b: "Nothing is stuck. " }, "No hot lead is waiting to be contacted."] };
  const met = (v, target) => (target == null ? v : { before: v, pill: v >= target ? "ok" : "warm", text: v >= target ? "Met" : "Below" });
  const avg = (x) => (peer && x != null ? x.toFixed(1) : "—");
  const body = table(["Measure", "Target", "Result", `Last ${peer ? peer.events : 3} avg`], [
    ["Leads", tgt.lead_target ?? "—", met(s.leads, tgt.lead_target), avg(peer && peer.leads)],
    ["Hot leads", tgt.hot_lead_target ?? "—", met(s.hot, tgt.hot_lead_target), avg(peer && peer.hot)],
    ["Hot still to contact", "—", { before: toContact.length, ...(toContact.length ? { pill: "pending", text: "Pending" } : { pill: "ok", text: "Done" }) }, "—"],
    ["New people", "—", s.new, avg(peer && peer.new)],
    ["Played after joining", "—", s.played, avg(peer && peer.played)],
    ["Certificates issued", "—", data.certificates.issued, "—"],
  ]);
  const blocks = [body];
  if (!owners.length) blocks.push(para([{ b: "This event has no SDR or Marketing owner for its leads." }]));
  const ofTarget = tgt.lead_target ? ` (${Math.round((s.leads / tgt.lead_target) * 100)}% of target)` : "";
  return {
    subject: `Scorecard for ${c.name}: ${_plural(s.leads, "lead")}${ofTarget}, ${s.hot} hot`,
    intro: `A one-screen summary of ${c.name}.`,
    cta, blocks, foot: "Managers get this summary only. The detail stays in each role's own email and in the event's Team & reports section.",
  };
}

function marketingNudge(data, waiting) {
  return {
    subject: `Reminder: ${_plural(waiting, "hot lead")} waiting from ${data.comp.name}`,
    cta: { url: wsLink(data.comp.id, "team"), text: "Open the lead list",
      textNoLink: `Make sure the ${_plural(waiting, "hot lead")} ${waiting === 1 ? "is" : "are"} contacted`,
      why: [{ b: `${_plural(waiting, "hot lead")} ${waiting === 1 ? "is" : "are"} waiting to be contacted. ` }, "The SDRs have been reminded of theirs."] },
    blocks: [],
  };
}

module.exports = {
  renderMail, previewHtml, wsLink, noLinkSentence, STOP_LINE, roleLabel: (r) => T.ROLE_LABELS[r],
  seReport, marketingReport, salesReport, sdrReport, managerReport, marketingNudge,
};
