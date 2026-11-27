"use strict";

import { downloadBlob } from './download.js';

// v7.24.0 — the CLIENT-side CSV writer.
//
// WHY IT EXISTS, AND WHY IT IS NOT lib/csv.js
// ───────────────────────────────────────────
// `lib/csv.js` is the SERVER's writer, used by the competition-activity export,
// which genuinely cannot be built in the browser (its cross product needs a
// participant list and a challenge list no admin payload carries). This module
// is the other half: every download the SPA assembles in the browser — the
// participants CSV, the analytics per-challenge CSV and the rankings boards. (A
// download can still fetch a column it lacks: the focused participants export
// asks the server for free-text responses first.) `public/js` is a browser-only
// ESM graph and cannot `require("../lib/csv")`, so this is the same irreducible
// split as DIFF_PTS and DRY_RUN_TAG: two runtimes, one rule.
//
// The quoting conventions are kept IDENTICAL to the server's on purpose —
// always quote, double the inner quote, LF terminator, UTF-8 BOM — so every CSV
// the admin panel offers agrees about what a CSV is. (No count here on purpose:
// this sentence said "three" while the panel offered five.)
//
// This module exists at all because the participants export had its quoting
// written inline as a single `.map(...).join(',')` expression, and adding a
// second such expression for analytics would have made THREE independent
// definitions of "how to quote a cell" in one codebase. Hoisting the working
// one is what stops the next download inventing a fourth.

// Mirrors FORMULA_TRIGGERS in lib/csv.js. Excel and LibreOffice strip leading
// whitespace before deciding whether a cell is a formula, so TAB and CR belong
// in the set alongside the three obvious operators. `-` is included even though
// `-5` reads as an ordinary negative number: `-2+3` is evaluated just as
// readily as `=2+3`.
const FORMULA_TRIGGERS = ["=", "+", "-", "@", "\t", "\r"];

// A UTF-8 BOM. Excel on Windows ignores the declared charset when a .csv is
// opened by double-click and falls back to the system ANSI code page, so
// without these three bytes an accented surname or company name arrives as
// mojibake.
// What an exempt column may hold and still be written raw (see toCsv).
const PLAIN_NUMBER_SHAPE = /^[\s\u00a0]*[+-]?[\d\s\u00a0().\/-]*$/;

const CSV_BOM = '﻿';

/**
 * Neutralise a spreadsheet formula in a cell value.
 *
 * QUOTING DOES NOT DO THIS. The quotes are the field delimiter — the
 * spreadsheet strips them and then type-infers what is left, so `"=1+1"` opens
 * as a formula cell showing 2. The neutralisation is a leading apostrophe,
 * applied BEFORE the quoting, and is consumed by the spreadsheet as the "treat
 * this as text" marker rather than displayed.
 */
export function neutraliseFormula(s) {
  const lead = s.replace(/^[\s\u00a0]+/, "");
  return lead.length && FORMULA_TRIGGERS.includes(lead[0]) ? "'" + s : s;
}

/**
 * Encode ONE cell. null/undefined become empty (never the string "null"),
 * everything else is stringified, formula-neutralised, then quoted
 * unconditionally with inner quotes doubled per RFC 4180.
 *
 * `neutralise` DEFAULTS TO TRUE, i.e. the SAFE behaviour is what a caller gets
 * for free. The first draft defaulted it to false so the participants download
 * would keep its bytes without saying anything — which makes the next export
 * somebody adds ship unguarded by omission, in a helper that exists precisely
 * to stop each new download re-deciding this. A download that must leave a
 * column raw names it by HEADER LABEL through `toCsv`'s `exemptColumns` and
 * states why at its own call site (today only the participants export, for
 * `Phone`, v8.3.17 F2), so the exception is visible where the decision was
 * taken rather than encoded as a default nobody reads. `{neutralise:false}` for
 * a whole table is still mechanically possible here; nothing passes it today.
 */
export function csvCell(v, { neutralise = true } = {}) {
  const s = v === null || v === undefined ? '' : String(v);
  return '"' + (neutralise ? neutraliseFormula(s) : s).replace(/"/g, '""') + '"';
}

/**
 * Serialise a header row plus data rows into a CSV string. `headers` is an
 * array of column labels, `rows` an array of arrays.
 *
 * The line terminator is LF, matching lib/csv.js — RFC 4180 specifies CRLF, but
 * every mainstream reader accepts LF and the two writers agreeing with each
 * other is worth more here than agreeing with the RFC.
 */
export function toCsv(headers, rows, opts = {}) {
  // v8.3.17 — PER-COLUMN EXEMPTION, so a download no longer has to choose between
  // "every cell neutralised" and "no cell neutralised".
  //
  // `exemptColumns` names the HEADER LABELS to leave raw, not indices: the label
  // is what the call site can state a reason about, and it does not silently
  // re-point at a different field when a column is inserted. An unknown label is
  // simply not found — the safe direction, since the effect is to neutralise a
  // column the caller meant to exempt rather than the reverse.
  const exemptNames = new Set(opts.exemptColumns || []);
  const exemptIdx = new Set(
    headers.map((h, i) => (exemptNames.has(h) ? i : -1)).filter((i) => i >= 0),
  );
  const rawOpts = { ...opts, neutralise: false };
  // An exempt column is left raw ONLY for a value that is a plain number shape
  // (`PLAIN_NUMBER_SHAPE`): digits, spaces and `+ - ( ) . /`. Such a value can
  // at worst be read as arithmetic — it names no function, cell or external
  // source — so `+972-50-1234567` keeps its bytes. Anything else in an exempt
  // column (a participant typing `=HYPERLINK(...)` as a phone number) is
  // neutralised like every other cell: the exemption is for numbers, not a
  // hole a free-text field can use.
  const cellOpts = (v, i) => (exemptIdx.has(i) && PLAIN_NUMBER_SHAPE.test(v == null ? '' : String(v)) ? rawOpts : opts);
  const line = (r) => r.map((v, i) => csvCell(v, cellOpts(v, i))).join(',');
  return [line(headers), ...rows.map(line)].join('\n');
}

/**
 * Serialise and save. The BOM is prepended here rather than by the caller so a
 * download cannot ship without it.
 *
 * v8.8.15 — the click-and-revoke half moved to `ui/download.js`, which owns the
 * one revoke strategy the SPA now uses. The BOM stays here, because it is a CSV
 * decision and not a download one: Excel on Windows ignores the HTTP charset on
 * a double-clicked .csv and falls back to the system ANSI code page.
 */
export function downloadCsv(filename, headers, rows, opts = {}) {
  downloadBlob(new Blob([CSV_BOM + toCsv(headers, rows, opts)], { type: 'text/csv;charset=utf-8' }), filename);
}
