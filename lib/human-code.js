"use strict";
//
// v8.1.0 (PR 32) — CODES A HUMAN TYPES OFF ONE SCREEN INTO ANOTHER.
//
// Two features now mint short codes people read aloud, copy off paper or type
// from a sign: the credential code printed on a certificate (PR 27) and the join
// code on a Booth Event's stand signage. They must share one alphabet and one
// normaliser, or the two would disagree about what a human typed — and the
// obvious failure is silent: a visitor types `O` for `0`, one surface folds it
// and the other does not, and the code "does not work" with nothing to see.
//
// THE ALPHABET IS A ONE-WAY DOOR. These characters are printed onto certificates
// that have left the building and onto signage standing in a hall, so neither
// the set nor the folding rules can change without invalidating codes already in
// the world. It is settled here, once, deliberately:
//
//   * **Crockford base32** — the digits plus the letters, MINUS I, L, O and U.
//     I/L/1 and O/0 are the pairs people misread and mistype; U is excluded so a
//     generated code cannot accidentally spell something obscene.
//   * **Folding is one-directional and lossy on purpose**: `i`/`l` -> `1`,
//     `o` -> `0`. Someone copying a code will type the letter they think they
//     see, so the normaliser has to accept it — and because the excluded letters
//     can never appear in a generated code, folding them can never collide with
//     a real one.
//   * **Case, spaces and punctuation are discarded**, because a human copying a
//     grouped code types the grouping too.
//
// The LENGTH is per-feature and deliberately not fixed here: a certificate code
// is a claim about one person and needs real entropy (12), while a join code is
// meant to be shouted across a stand and is bounded by rate limiting and by the
// event's own lifetime (6). Both draw from this alphabet.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Normalise a typed code: case, separators, and the Crockford substitutions for
 * the letters the alphabet excludes precisely because they are misread.
 *
 * Returns "" when nothing usable is left. **An empty code must never match
 * anything** — every caller relies on that, and it is why this returns the empty
 * string rather than null: a caller comparing against a stored value gets a
 * guaranteed miss instead of an accidental "no filter" query.
 */
function normaliseHumanCode(value) {
  // Text only: a code typed or printed is a string, and String() throws on an
  // object whose toString is not callable (a crafted request body; sweep #193).
  const up = (typeof value === "string" ? value : "").toUpperCase()
    .replace(/[^0-9A-Z]+/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  return [...up].every(c => ALPHABET.includes(c)) ? up : "";
}

/**
 * A fresh code of `len` characters.
 *
 * Uniqueness is the CALLER's job: the join-code caller checks for a free value
 * and writes it synchronously, with the table's unique index as the backstop
 * (a clash fails closed); a certificate code relies on its own unique index.
 *
 * `randomBytes` is injected so this module stays dependency-free and a test can
 * make it deterministic.
 */
function generateHumanCode(randomBytes, len) {
  const bytes = randomBytes(len);
  let out = "";
  // Modulo bias: 256 % 32 === 0, so with a 32-character alphabet every byte maps
  // uniformly and there is none. Stated because it is only true while the
  // alphabet length divides 256 — change the alphabet size and this needs
  // rejection sampling.
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Group a code for printing, so a human reading it aloud does not lose their place. */
function formatHumanCode(code, group = 4) {
  const s = String(code || "");
  if (!s) return "";
  return s.match(new RegExp(`.{1,${group}}`, "g")).join("-");
}

module.exports = { HUMAN_CODE_ALPHABET: ALPHABET, normaliseHumanCode, generateHumanCode, formatHumanCode };
