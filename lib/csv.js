"use strict";

// v7.23.0 — server-side CSV serialisation.
//
// WHY THIS EXISTS
// ───────────────
// The platform had no server-rendered CSV at all until the competition-activity
// export. The only CSV in the repo was `exportParticipantsCSV()`
// (public/js/features/export-import.js), which builds its file in the BROWSER
// from a payload the SPA already holds. That works there and cannot work here:
// the activity export is a participants x challenges cross product assembled
// from five aggregate queries, and no admin payload carries either list.
//
// SO THIS IS THE SECOND CSV WRITER IN THE REPO, AND THAT IS DELIBERATE.
// `public/js` is a browser-only ESM graph — it cannot `require("../lib/csv")` —
// which makes this the same irreducible situation as DIFF_PTS and DRY_RUN_TAG:
// two runtimes, one rule. The quoting conventions are therefore kept IDENTICAL
// to the client's on purpose (always quote, double the inner quote, LF line
// terminator, UTF-8 BOM) so no two CSVs the admin panel offers disagree about
// what a CSV is.
//
// v7.24.0 — THAT MIRROR IS NOW ENFORCED. The client half became a real module
// (`public/js/ui/csv.js`) when the analytics export was added, and both halves
// now neutralise formulas: `FORMULA_TRIGGERS` and `neutraliseFormula` are kept
// byte-identical between the two files by
// `functional-core-b.api.spec.js > Docs hygiene > "v7.24.0: the CSV
// formula-neutralisation rule is mirrored, not re-invented"`. (An earlier note
// here said the client "does not" neutralise; that was true when the only
// client CSV was the participants download. Since v8.3.17 F2 that download
// neutralises every column too, except `Phone`, which it exempts by header
// label at its own call site so a number beginning `+` stays byte-identical.)

// Excel and LibreOffice strip leading whitespace before deciding whether a cell
// is a formula, so TAB and CR belong in the trigger set alongside the three
// obvious operators. `-` is included even though `-5` reads as an ordinary
// negative number: `-2+3` is evaluated just as readily as `=2+3`, and a trigger
// set of only `=` and `+` is the common half-fix.
const FORMULA_TRIGGERS = ["=", "+", "-", "@", "\t", "\r"];

// A UTF-8 BOM. Excel on Windows ignores the HTTP charset when a .csv is opened
// by double-click and falls back to the system ANSI code page, so without these
// three bytes an accented surname or company name arrives as mojibake. Every
// field in the activity export except the nickname is full Unicode by design,
// so this is a live case rather than a theoretical one.
const CSV_BOM = "﻿";

/**
 * Neutralise a spreadsheet formula in a cell value.
 *
 * QUOTING DOES NOT DO THIS. The quotes are the field delimiter — the
 * spreadsheet strips them and then type-infers what is left, so `"=1+1"` opens
 * as a formula cell showing 2. The neutralisation is a leading apostrophe,
 * applied BEFORE the quoting, not instead of it. The apostrophe is consumed by
 * the spreadsheet as the "treat this as text" marker and is not displayed.
 *
 * This matters here because participants author their own first name, last name
 * and company, and this file is opened by an admin.
 */
function neutraliseFormula(s) {
  const lead = s.replace(/^[\s\u00a0]+/, "");
  return lead.length && FORMULA_TRIGGERS.includes(lead[0]) ? "'" + s : s;
}

/**
 * Encode ONE cell: null/undefined become empty (never the string "null"),
 * everything else is stringified, formula-neutralised, then quoted
 * unconditionally with inner quotes doubled per RFC 4180.
 *
 * Quoting every field rather than only the ones that need it is the existing
 * house convention and is what makes embedded commas, quotes and newlines safe
 * without a per-value decision.
 */
function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return '"' + neutraliseFormula(s).replace(/"/g, '""') + '"';
}

/**
 * Serialise a header row plus data rows into a CSV string.
 *
 * `headers` is an array of column labels; `rows` an array of arrays. The line
 * terminator is LF, matching the client's writer — RFC 4180 specifies CRLF, but
 * every mainstream reader accepts LF and the two writers agreeing with each
 * other is worth more here than agreeing with the RFC.
 */
function toCsv(headers, rows) {
  const out = [headers.map(csvCell).join(",")];
  for (const r of rows) out.push(r.map(csvCell).join(","));
  return out.join("\n");
}

/**
 * The bytes to put on the wire: BOM + CSV, as UTF-8. Returned as a Buffer so
 * the BOM ships as the three raw bytes EF BB BF and a caller cannot
 * accidentally re-encode it.
 */
function csvBuffer(headers, rows) {
  return Buffer.from(CSV_BOM + toCsv(headers, rows), "utf8");
}

module.exports = { csvCell, toCsv, csvBuffer, neutraliseFormula, FORMULA_TRIGGERS, CSV_BOM };
