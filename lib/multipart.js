"use strict";
// THE ONLY PLACE APP CODE BUILDS A MULTER INSTANCE (lock: a scanner in
// tests/multer-limits.api.spec.js fails any other require of the module).
//
// Why a wrapper and not a sentence: multer's limits are written per call site,
// and every key left out falls back to a default that bounds nothing. busboy
// bounds one field's VALUE (1 MiB) and nothing else — field, file and part
// counts default to Infinity, and multer checks a field NAME only when
// `fieldNameSize` is set — so an authenticated request could hold any number of
// 1 MiB values in req.body beside a tiny file. boundedMulter refuses, at
// construction (so boot fails loudly), any limits object that does not bound
// the in-memory text of a request:
//   - every key in _REQUIRED present, a finite non-negative integer;
//   - no other key: a misspelt one (`fieldsize`) is silently ignored by multer,
//     and the two remaining multer keys are refused with their reason (_REFUSED);
//   - fieldNestingDepth 0: names are flat, because a bracketed index
//     (`x[99999999]`) builds a sparse array whose toString() stalls the event
//     loop for seconds;
//   - files <= 1, and parts <= fields + files: `parts` is the only limit on the
//     parts busboy SKIPS (no Content-Disposition), which no other count sees;
//   - fields * (fieldSize + fieldNameSize) <= MULTIPART_TEXT_MAX_BYTES, the
//     aggregate a request can keep in req.body.
// fieldSize is the largest value admitted: multer (2.5.0 on) hands busboy
// fieldSize + 1, because busboy refuses a value of EXACTLY its limit
// (LIMIT_FIELD_VALUE). Under 2.4.0 a cap meant to admit N bytes was N + 1.
// A part busboy classifies as a file (a filename parameter, or Content-Type
// application/octet-stream) counts toward `files` even when multer drains it for
// an empty filename — which is how `files: 1` refuses a second file part before
// it is stored.

const multer = require("multer");
const { refuseBeforeBody } = require("./http");

const MULTIPART_TEXT_MAX_BYTES = 1024 * 1024;

const _REQUIRED = Object.freeze(["fileSize", "files", "fields", "fieldSize", "fieldNameSize", "parts", "fieldNestingDepth"]);
// multer's other limit keys. Neither may be set: a limit nothing enforces is
// worse than none. If a future busboy starts honouring headerPairs, lift its
// refusal in the same bump.
const _REFUSED = Object.freeze({
  headerPairs: "is ignored by busboy's multipart parser (2000 pairs and 16 KiB per part header are hard-coded); do not set a limit nothing enforces",
  fieldArrayIndexLimit: "can never fire: fieldNestingDepth must be 0, which refuses every bracketed name first",
});

function _fail(key, why) {
  throw new TypeError(`boundedMulter: limits.${key} ${why}`);
}

function _checkLimits(limits) {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new TypeError("boundedMulter: limits must be a plain object (a per-request limits function cannot be checked at construction)");
  }
  for (const k of Object.keys(limits)) {
    if (Object.prototype.hasOwnProperty.call(_REFUSED, k)) _fail(k, _REFUSED[k]);
    if (!_REQUIRED.includes(k)) _fail(k, "is not a limit this wrapper knows (multer silently ignores an unknown key)");
  }
  for (const k of _REQUIRED) {
    if (!Number.isSafeInteger(limits[k]) || limits[k] < 0) _fail(k, "must be a finite non-negative integer");
  }
  if (limits.fieldNestingDepth !== 0) _fail("fieldNestingDepth", "must be 0: a bracketed field name builds an array, and a large index a sparse one whose toString() stalls the event loop");
  if (limits.files > 1) _fail("files", "must be at most 1");
  if (limits.parts > limits.fields + limits.files) _fail("parts", "must not exceed fields + files: it is the only limit on the parts busboy skips");
  const text = limits.fields * (limits.fieldSize + limits.fieldNameSize);
  if (text > MULTIPART_TEXT_MAX_BYTES) {
    _fail("fields", `* (fieldSize + fieldNameSize) is ${text} bytes, over the ${MULTIPART_TEXT_MAX_BYTES}-byte text budget`);
  }
}

function boundedMulter(options) {
  _checkLimits(options && options.limits);
  // Frozen so nothing can widen a limit after it was checked: multer reads this
  // same object on every request.
  Object.freeze(options.limits);
  return multer(options);
}

// The largest body a request these limits ACCEPT can declare: every file at its
// cap, every field at its cap with its longest name, and each part's framing — a
// boundary line, plus a part header busboy refuses past 16 KiB.
const _PART_FRAMING_MAX_BYTES = 16 * 1024 + 256;
function multipartBodyCeiling(limits) {
  _checkLimits(limits);
  return limits.files * limits.fileSize
    + limits.fields * (limits.fieldSize + limits.fieldNameSize)
    + (limits.parts + 1) * _PART_FRAMING_MAX_BYTES;
}

// Refuses, before a byte of the body is parsed, a request whose DECLARED
// Content-Length exceeds what these limits could accept. A chunked body declares
// nothing and is left to multer's own limits.
function declaredLengthGate(limits, message) {
  const ceiling = multipartBodyCeiling(limits);
  return function multipartDeclaredLengthGate(req, res, next) {
    const declared = parseInt(req.headers["content-length"], 10);
    if (!(Number.isFinite(declared) && declared > ceiling)) return next();
    refuseBeforeBody(req, res, 413, { error: message });
  };
}

module.exports = { boundedMulter, declaredLengthGate, MULTIPART_TEXT_MAX_BYTES };
