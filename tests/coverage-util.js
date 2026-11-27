// v8.12.4 — shared by the harness (tests/isolated-test.js, HACKARENA_COVERAGE
// mode) and the report (scripts/coverage-report.cjs). Deliberately requires
// nothing from the app and nothing from the harness.
//
// V8 block coverage reports, per function, a list of ranges; a nested range is
// reported only where its count DIFFERS from the range enclosing it, and the
// innermost reported range is the one that applies to a byte. So "was this byte
// executed in this run" is: paint every range outer-first, inner-last, and read
// whether the last paint was a non-zero count. Two runs merge by OR — which is
// the only merge that is correct: an unreported block in one run executed as
// often as its parent there, and V8 simply did not say so separately.
"use strict";

/** Paint one script's functions into a byte map: 1 = executed in this run. */
function paintScript(functions, length) {
  const ranges = [];
  for (const fn of functions || []) for (const r of fn.ranges || []) ranges.push(r);
  // Outer first: by start ascending, then by LONGER first at the same start.
  ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const out = new Uint8Array(length);
  for (const r of ranges) {
    const s = Math.max(0, r.startOffset), e = Math.min(length, r.endOffset);
    if (e > s) out.fill(r.count > 0 ? 1 : 0, s, e);
  }
  return out;
}

/** OR `add` into `acc` (both byte maps), growing acc when the file grew. */
function orInto(acc, add) {
  if (!acc || acc.length !== add.length) return Uint8Array.from(add);
  for (let i = 0; i < add.length; i++) if (add[i]) acc[i] = 1;
  return acc;
}

module.exports = { paintScript, orInto };
